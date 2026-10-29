/*
 * YunFlow (云流) — engine tests.
 * Copyright (C) 2026 YunFlow Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chunkCountFor, planChunks } from '../src/main/engine/chunk-plan';
import { contentRangeMatches, parseContentRange } from '../src/main/engine/http';
import { DEFAULT_PREEMPT_TUNING, shouldPreempt } from '../src/main/engine/speed-watchdog';
import { Semaphore } from '../src/main/engine/util';
import {
  THREAD_LIMITS,
  detectRuntimePlatform,
  resolveThreads
} from '../src/shared/thread-policy';
import { DownloadTask, type TaskOptions } from '../src/main/engine/task';
import { startServer } from './server';

const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

async function tempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'yunflow-test-'));
}

async function makeTask(url: string, directory: string, overrides: Partial<TaskOptions> = {}): Promise<DownloadTask> {
  return new DownloadTask({
    id: `t-${Math.random().toString(36).slice(2, 9)}`,
    url,
    fileName: 'payload.bin',
    directory,
    platformId: 'direct',
    headers: {},
    threads: 8,
    semaphore: new Semaphore(32),
    sampleIntervalMs: 100,
    preemptTickMs: 200,
    ...overrides
  });
}

test('chunk planning keeps a surplus of pieces and a valid split', () => {
  const plan = planChunks(64 * 1024 * 1024, 8);
  assert.equal(plan.threads, 8);
  assert.equal(plan.chunkSize, Math.ceil(plan.total / plan.chunkCount));
  assert.ok(plan.mainCount >= 1 && plan.mainCount <= plan.chunkCount);
  assert.ok(plan.elasticStart <= plan.total);
  assert.ok(plan.chunkCount >= 8 * 8, 'each worker should have surplus pieces to steal');
  assert.ok(plan.chunkCount <= 512);
});

test('chunk planning degrades gracefully for small and unknown files', () => {
  assert.equal(chunkCountFor(0, 8), 1);
  assert.equal(chunkCountFor(1024, 8), 1);
  const tiny = planChunks(1024, 8);
  assert.equal(tiny.chunkCount, 1);
  assert.equal(tiny.chunkSize, 1024);
  const odd = planChunks(1_234_567, 16);
  assert.ok(odd.mainCount * odd.chunkSize <= odd.total + odd.chunkSize);
});

test('thread policy honours the 512 desktop / 32 mobile ceilings', () => {
  assert.equal(THREAD_LIMITS.desktop.max, 512);
  assert.equal(THREAD_LIMITS.mobile.max, 32);
  assert.equal(detectRuntimePlatform('win32'), 'desktop');
  assert.equal(detectRuntimePlatform('darwin'), 'desktop');
  assert.equal(detectRuntimePlatform('android'), 'mobile');
  assert.equal(detectRuntimePlatform('ios'), 'mobile');

  // Above the runtime ceiling: truncated, never rejected outright.
  const desktopMax = resolveThreads({ requested: 9999, runtime: 'desktop' });
  assert.equal(desktopMax.effective, 512);
  assert.equal(desktopMax.clamped, true);
  assert.equal(desktopMax.reason, 'above-global');

  const mobileMax = resolveThreads({ requested: 9999, runtime: 'mobile' });
  assert.equal(mobileMax.effective, 32);
  assert.equal(mobileMax.reason, 'above-global');

  // Platform (CDN) ceiling wins over the runtime ceiling.
  const xunlei = resolveThreads({ requested: 128, runtime: 'desktop', platformCap: 8 });
  assert.equal(xunlei.effective, 8);
  assert.equal(xunlei.reason, 'above-platform');

  // Below the floor / non-numeric / fractional.
  assert.equal(resolveThreads({ requested: -5 }).effective, 1);
  assert.equal(resolveThreads({ requested: 0 }).effective, 1);
  assert.equal(resolveThreads({ requested: 12.9 }).effective, 12);
  assert.equal(resolveThreads({ requested: 'abc', fallback: 8 }).effective, 8);
  assert.equal(resolveThreads({ requested: 'abc' }).reason, 'invalid');

  // Missing value uses the fallback, itself clamped to the runtime ceiling.
  assert.equal(resolveThreads({}).effective, 8);
  assert.equal(resolveThreads({ fallback: 1000, runtime: 'mobile' }).effective, 32);

  // In-range values pass through untouched.
  const ok = resolveThreads({ requested: 4, platformCap: 8 });
  assert.equal(ok.effective, 4);
  assert.equal(ok.clamped, false);
  assert.equal(ok.reason, 'ok');
});

test('512 threads still produces a valid, capped chunk plan', () => {
  const plan = planChunks(4 * 1024 * 1024 * 1024, 512);
  assert.equal(plan.threads, 512);
  assert.equal(plan.chunkCount, 512);
  assert.equal(plan.chunkSize, Math.ceil(plan.total / plan.chunkCount));
  assert.ok(plan.mainCount <= plan.chunkCount);
  assert.ok(plan.elasticStart <= plan.total);
});

test('content-range parsing rejects malformed or mismatched headers', () => {
  assert.deepEqual(parseContentRange('bytes 0-0/1000'), { start: 0, end: 0, total: 1000 });
  assert.deepEqual(parseContentRange('bytes 10-19/*'), { start: 10, end: 19, total: null });
  assert.equal(parseContentRange('bytes 10-5/100'), null);
  assert.equal(parseContentRange('bytes 10-20/10'), null);
  assert.equal(parseContentRange('items 0-1/2'), null);
  assert.equal(contentRangeMatches('bytes 4096-8191/10000', 4096, 8191), true);
  assert.equal(contentRangeMatches('bytes 0-4095/10000', 4096, 8191), false);
});

test('preemption policy only replaces connections that are genuinely slow', () => {
  const base = {
    bps: 8 * 1024,
    ageMs: 20_000,
    idleMs: 500,
    remaining: 2 * 1024 * 1024,
    preemptCount: 0,
    msSincePreempt: 60_000,
    inflight: 8,
    taskAvgPerConnectionBps: 200 * 1024
  };
  assert.equal(shouldPreempt(base), true);
  assert.equal(shouldPreempt({ ...base, ageMs: 1_000 }), false, 'grace period protects ramp-up');
  assert.equal(shouldPreempt({ ...base, remaining: 64 * 1024 }), false, 'not worth a handshake');
  assert.equal(shouldPreempt({ ...base, preemptCount: 3 }), false, 'bounded reconnects');
  assert.equal(shouldPreempt({ ...base, msSincePreempt: 1_000 }), false, 'cooldown');
  assert.equal(shouldPreempt({ ...base, bps: 400 * 1024 }), false, 'fast connection stays');
  assert.equal(shouldPreempt({ ...base, idleMs: 30_000, bps: 400 * 1024 }), true, 'silent socket is hung');
  assert.equal(shouldPreempt({ ...base, inflight: 2, ageMs: 4_000 }), true, 'endgame relaxes the grace period');
  assert.equal(DEFAULT_PREEMPT_TUNING.maxPreempts, 3);
});

test('ranged download reconstructs the file byte for byte', async () => {
  const content = randomBytes(6 * 1024 * 1024 + 12345);
  const server = await startServer(content, { ratePerConnection: 0 });
  const directory = await tempDir();
  try {
    const task = await makeTask(server.url, directory, { threads: 8 });
    await task.start();
    assert.equal(task.status, 'completed', task.error);
    assert.equal(task.singleStream, false);
    assert.ok(server.stats.rangeRequests > 1, 'should use multiple range requests');
    const file = await fsp.readFile(path.join(directory, task.fileName));
    assert.equal(file.length, content.length);
    assert.equal(sha256(file), sha256(content));
    assert.equal(task.downloadedBytes, content.length);
    assert.ok(task.toView().chunks.every((chunk) => chunk.state === 'done'));
  } finally {
    await server.close();
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test('pause and resume continues from the bytes already on disk', async () => {
  const content = randomBytes(5 * 1024 * 1024);
  const server = await startServer(content, { ratePerConnection: 192 * 1024 });
  const directory = await tempDir();
  try {
    const task = await makeTask(server.url, directory, { threads: 8 });
    const running = task.start();
    await new Promise((resolve) => setTimeout(resolve, 700));
    task.pause();
    await running;

    assert.equal(task.status, 'paused');
    assert.ok(task.downloadedBytes > 0, 'some bytes should be on disk');
    assert.ok(task.downloadedBytes < content.length, 'pause must happen before completion');
    const servedBeforeResume = server.stats.bytesServed;

    await task.start();
    assert.equal(task.status, 'completed', task.error);
    const file = await fsp.readFile(path.join(directory, task.fileName));
    assert.equal(sha256(file), sha256(content));
    assert.ok(
      server.stats.bytesServed < content.length * 2,
      `resume should not re-download everything (served ${server.stats.bytesServed} / ${content.length}, before resume ${servedBeforeResume})`
    );
  } finally {
    await server.close();
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test('a server that ignores Range falls back to a single stream', async () => {
  const content = randomBytes(2 * 1024 * 1024 + 4567);
  const server = await startServer(content, { ignoreRange: true });
  const directory = await tempDir();
  try {
    const task = await makeTask(server.url, directory, { threads: 8 });
    await task.start();
    assert.equal(task.status, 'completed', task.error);
    assert.equal(task.singleStream, true);
    const file = await fsp.readFile(path.join(directory, task.fileName));
    assert.equal(sha256(file), sha256(content));
    assert.equal(server.stats.rangeRequests, 0);
  } finally {
    await server.close();
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test('the watchdog replaces a crawling connection and keeps its bytes', async () => {
  const content = randomBytes(8 * 1024 * 1024);
  const server = await startServer(content, { slowAtOffset: 0, slowRate: 20 * 1024 });
  const directory = await tempDir();
  try {
    const task = await makeTask(server.url, directory, {
      threads: 4,
      preemptTuning: {
        minBps: 64 * 1024,
        minAgeMs: 250,
        endgameMinAgeMs: 250,
        cooldownMs: 50,
        minRemain: 0,
        maxPreempts: 2,
        perTick: 2,
        endgameInflight: 99,
        idleMs: 60_000
      },
      sampleIntervalMs: 100,
      preemptTickMs: 200
    });
    await task.start();
    assert.equal(task.status, 'completed', task.error);
    assert.ok(task.preemptCount > 0, 'the slow connection should have been replaced');
    const file = await fsp.readFile(path.join(directory, task.fileName));
    assert.equal(sha256(file), sha256(content));
  } finally {
    await server.close();
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test('resuming a task whose allocator was never created does not crash', async () => {
  // Regression: ensurePlan used to cache the plan before building its on-disk
  // scaffolding. If that setup threw, `plan` stayed set with `allocator` null,
  // and every retry died on `allocator.take()` with
  // "Cannot read properties of null" — masking the real failure.
  const content = randomBytes(2 * 1024 * 1024);
  const server = await startServer(content, { ratePerConnection: 128 * 1024 });
  const directory = await tempDir();
  try {
    const task = await makeTask(server.url, directory, { threads: 4 });
    const running = task.start();
    await new Promise((resolve) => setTimeout(resolve, 500));
    task.pause();
    await running;
    assert.equal(task.status, 'paused');

    // Simulate the broken state: plan still cached, allocator gone.
    (task as unknown as { allocator: null }).allocator = null;

    await task.start();
    assert.equal(task.status, 'completed', task.error);
    const file = await fsp.readFile(path.join(directory, task.fileName));
    assert.equal(sha256(file), sha256(content));
  } finally {
    await server.close();
    await fsp.rm(directory, { recursive: true, force: true });
  }
});
