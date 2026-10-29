/*
 * YunFlow (云流) — settings persistence tests.
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
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DownloadManager } from '../src/main/engine/manager';

async function tempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'yf-set-'));
}

test('an unusable download directory does not discard the rest of the patch', async () => {
  const dir = await tempDir();
  const manager = new DownloadManager({ dataDir: dir, defaultDirectory: dir });
  await manager.init();
  try {
    const blocker = path.join(dir, 'blocker');
    await fsp.writeFile(blocker, 'x');
    const before = manager.getSettings().downloadDirectory;

    // Regression: this used to throw before assigning anything, so every other
    // preference the user had just changed was silently dropped.
    const next = await manager.updateSettings({
      downloadDirectory: blocker,
      defaultThreads: 12,
      maxConcurrentTasks: 3,
      theme: 'dark'
    });

    assert.equal(next.defaultThreads, 12);
    assert.equal(next.maxConcurrentTasks, 3);
    assert.equal(next.theme, 'dark');
    assert.equal(next.downloadDirectory, before, 'the unusable path must not replace the current one');

    const onDisk = JSON.parse(await fsp.readFile(path.join(dir, 'settings.json'), 'utf8')) as {
      defaultThreads: number;
      theme: string;
    };
    assert.equal(onDisk.defaultThreads, 12, 'changes must be written to settings.json');
    assert.equal(onDisk.theme, 'dark');
  } finally {
    manager.shutdown();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a usable download directory is applied', async () => {
  const dir = await tempDir();
  const manager = new DownloadManager({ dataDir: dir, defaultDirectory: dir });
  await manager.init();
  try {
    const target = path.join(dir, 'downloads');
    const next = await manager.updateSettings({ downloadDirectory: target });
    assert.equal(next.downloadDirectory, target);
  } finally {
    manager.shutdown();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('settings are restored from disk by a fresh instance', async () => {
  const dir = await tempDir();
  try {
    const first = new DownloadManager({ dataDir: dir, defaultDirectory: dir });
    await first.init();
    await first.updateSettings({
      defaultThreads: 16,
      maxConcurrentTasks: 3,
      theme: 'light',
      speedLimitBps: 2 * 1024 * 1024,
      autoResumeOnLaunch: false
    });
    first.shutdown();

    // A new instance is what "switch away and come back" (or restarting the
    // app) actually looks like.
    const second = new DownloadManager({ dataDir: dir, defaultDirectory: dir });
    await second.init();
    const restored = second.getSettings();
    assert.equal(restored.defaultThreads, 16);
    assert.equal(restored.maxConcurrentTasks, 3);
    assert.equal(restored.theme, 'light');
    assert.equal(restored.speedLimitBps, 2 * 1024 * 1024);
    assert.equal(restored.autoResumeOnLaunch, false);
    assert.equal(restored.downloadDirectory, dir);
    second.shutdown();
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
