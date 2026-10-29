/*
 * YunFlow (云流) — download-directory tests.
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
import { assertUsableDirectory, ensureDir, resolvePartsRoot } from '../src/main/engine/workdir';

async function tempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'yf-dir-'));
}

test('ensureDir treats an existing directory as success', async () => {
  const dir = await tempDir();
  try {
    // Twice: the second call must not try to create it again.
    await ensureDir(dir);
    await ensureDir(dir);
    assert.ok((await fsp.stat(dir)).isDirectory());
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('ensureDir accepts a drive root', async (t) => {
  // Regression: `mkdir('F:\\', { recursive: true })` answers EPERM on Windows
  // because the root already exists. Downloading to a drive root is a normal
  // choice, and the failure aborted task creation before anything was written.
  const root = path.parse(os.tmpdir()).root;
  try {
    await ensureDir(root);
    assert.ok((await fsp.stat(root)).isDirectory());
  } catch (error) {
    t.diagnostic(`ensureDir(${root}) threw ${(error as Error).message}`);
    throw error;
  }
});

test('ensureDir creates a missing nested directory', async () => {
  const base = await tempDir();
  const nested = path.join(base, 'a', 'b', 'c');
  try {
    await ensureDir(nested);
    assert.ok((await fsp.stat(nested)).isDirectory());
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('ensureDir refuses a path that is a file', async () => {
  const base = await tempDir();
  const file = path.join(base, 'not-a-dir');
  try {
    await fsp.writeFile(file, 'x');
    await assert.rejects(() => ensureDir(file), /不是文件夹/);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('assertUsableDirectory reports unusable paths with the path in the message', async () => {
  const base = await tempDir();
  const file = path.join(base, 'file.txt');
  try {
    await fsp.writeFile(file, 'x');
    await assertUsableDirectory(base);
    await assert.rejects(
      () => assertUsableDirectory(file),
      (error: Error) => {
        assert.match(error.message, /下载目录不可用/);
        assert.ok(error.message.includes(file), 'message should name the offending path');
        return true;
      }
    );
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('resolvePartsRoot falls back when the destination refuses directories', async () => {
  const base = await tempDir();
  const blocker = path.join(base, 'blocker');
  const fallback = path.join(base, 'appdata');
  try {
    // A file where a directory is needed makes `blocker/.yunflow/<id>`
    // impossible to create — the same class of failure as EPERM on a drive root.
    await fsp.writeFile(blocker, 'x');
    const resolved = await resolvePartsRoot(blocker, 'task-1', fallback);
    assert.ok(resolved.dir.startsWith(fallback), `expected fallback, got ${resolved.dir}`);
    assert.ok((await fsp.stat(resolved.dir)).isDirectory());
    assert.match(resolved.note ?? '', /临时文件改放到/);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('resolvePartsRoot reports the error when no fallback is configured', async () => {
  const base = await tempDir();
  const blocker = path.join(base, 'blocker');
  try {
    await fsp.writeFile(blocker, 'x');
    await assert.rejects(() => resolvePartsRoot(blocker, 'task-2'));
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('resolvePartsRoot prefers the download directory when it works', async () => {
  const base = await tempDir();
  try {
    const resolved = await resolvePartsRoot(base, 'task-3', path.join(base, 'appdata'));
    assert.equal(resolved.dir, path.join(base, '.yunflow', 'task-3'));
    assert.equal(resolved.note, undefined);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});
