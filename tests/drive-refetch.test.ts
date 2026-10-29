/*
 * YunFlow (云流) — expired-link re-mint tests.
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
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { DownloadManager } from '../src/main/engine/manager';
import type { DriveAdapter } from '../src/main/drives/types';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function startRangedServer(content: Buffer): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    // Pretend the first URL is a dead/expired drive link.
    if (req.url?.startsWith('/expired')) {
      res.writeHead(403);
      res.end();
      return;
    }
    const range = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range ?? ''));
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), content.length - 1) : content.length - 1;
      res.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${content.length}`,
        'accept-ranges': 'bytes',
        'content-length': String(end - start + 1)
      });
      res.end(content.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { 'content-length': String(content.length) });
    res.end(content);
  });
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => server);
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

test('a dead drive link is re-minted automatically and the download completes', async () => {
  const content = randomBytes(2 * 1024 * 1024);
  const server = await startRangedServer(content);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'yf-refetch-'));

  // The adapter always hands out the *fresh* URL; the task starts with the
  // expired one and must recover on its own.
  const adapter: DriveAdapter = {
    id: 'direct',
    profile: async () => ({}),
    list: async () => ({ entries: [] }),
    link: async () => ({ url: `${base}/real`, fileName: 'x.bin' })
  };

  const manager = new DownloadManager({
    dataDir: dir,
    defaultDirectory: dir,
    driveContext: () => ({ cookie: '', credentials: {} }),
    adapterFor: () => adapter,
    autoRefreshDelayMs: 50
  });
  await manager.init();
  try {
    const added = await manager.add({
      url: `${base}/expired`,
      fileName: 'x.bin',
      driveRef: { platformId: 'direct', fileId: 'file-1' },
      threads: 4
    });

    let last = added;
    for (let i = 0; i < 100; i += 1) {
      await sleep(200);
      last = manager.list().find((x) => x.id === added.id) ?? added;
      if (last.status === 'completed' || last.status === 'failed') break;
    }

    assert.equal(last.status, 'completed', `expected completion, got ${last.status}: ${last.error ?? ''}`);
    const file = await fsp.readFile(path.join(dir, added.fileName));
    assert.equal(sha256(file), sha256(content));
  } finally {
    manager.shutdown();
    await fsp.rm(dir, { recursive: true, force: true });
    server.close();
  }
});

test('without a driveRef the same failure stays failed (no blind retries)', async () => {
  const content = randomBytes(64 * 1024);
  const server = await startRangedServer(content);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'yf-noref-'));

  const manager = new DownloadManager({ dataDir: dir, defaultDirectory: dir });
  await manager.init();
  try {
    const added = await manager.add({ url: `${base}/expired`, fileName: 'y.bin', threads: 2 });
    await sleep(1200);
    const t = manager.list().find((x) => x.id === added.id);
    assert.equal(t.status, 'failed', 'without a driveRef there is nothing to re-mint');
  } finally {
    manager.shutdown();
    await fsp.rm(dir, { recursive: true, force: true });
    server.close();
  }
});
