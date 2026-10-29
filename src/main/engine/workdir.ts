/*
 * YunFlow (云流) — a desktop download accelerator built on multi-connection
 * ranged HTTP transfers.
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
 *
 * The design of this engine is based on a study of YunX (云析)
 * <https://github.com/CYQawa/YunX>, Copyright (C) 2026 CYQawa,
 * licensed under the GNU Affero General Public License v3.0.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, type Hash } from 'node:crypto';

/**
 * Create `dir` if it is missing.
 *
 * `mkdir(dir, { recursive: true })` is *not* a no-op for an existing directory
 * on Windows: asking it to create a drive root (`F:\`) returns EPERM, because
 * the root already exists and cannot be created again. Downloading to `D:\` is
 * a perfectly normal choice, and the failure used to abort task creation before
 * anything was written — leaving no task, no part file and no error to look at.
 */
export async function ensureDir(dir: string): Promise<void> {
  try {
    const stat = await fsp.stat(dir);
    if (stat.isDirectory()) return;
    throw new Error(`目标路径不是文件夹：${dir}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Only a genuinely missing path should fall through to mkdir.
    if (code !== 'ENOENT') throw error;
  }
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * Throw a readable error unless `dir` can actually receive a download.
 *
 * `access(W_OK)` is not enough on Windows — it reflects the read-only attribute,
 * not the ACL, so a drive that refuses file creation still reports writable.
 * Probe with a real file instead, so an unusable destination is rejected when
 * the user picks it rather than after an 800 MB download.
 */
export async function assertUsableDirectory(dir: string): Promise<void> {
  const probe = path.join(dir, `.yunflow-write-${process.pid}-${Date.now()}`);
  try {
    await ensureDir(dir);
    await fsp.writeFile(probe, '');
  } catch (error) {
    throw new Error(`下载目录不可用：${dir}（${(error as Error).message}）`);
  }
  await fsp.rm(probe, { force: true }).catch(() => undefined);
}

export async function fileSize(file: string): Promise<number> {
  try {
    const stat = await fsp.stat(file);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

export function partsDir(directory: string, taskId: string): string {
  return path.join(directory, '.yunflow', taskId);
}

export function partPath(directory: string, taskId: string, name: string): string {
  return path.join(partsDir(directory, taskId), `${name}.part`);
}

/**
 * Pick a directory for the piece files.
 *
 * Preferred location is next to the final file, so a finished download never
 * crosses volumes. Some destinations refuse directory creation even though
 * they accept files (a locked-down drive root answers EPERM), so fall back to
 * the app's own data directory instead of failing the whole download.
 */
export async function resolvePartsRoot(
  directory: string,
  taskId: string,
  fallbackRoot?: string
): Promise<{ dir: string; note?: string }> {
  const preferred = partsDir(directory, taskId);
  try {
    await ensureDir(preferred);
    return { dir: preferred };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const retryable = !code || ['EPERM', 'EACCES', 'EROFS', 'EINVAL', 'ENOTDIR'].includes(code);
    if (!fallbackRoot || !retryable) throw error;
    const alternative = path.join(fallbackRoot, taskId);
    await ensureDir(alternative);
    return { dir: alternative, note: `${(error as Error).message}；临时文件改放到 ${alternative}` };
  }
}

const PLAN_FILE = 'plan.json';

export async function readPlan(dir: string): Promise<string | null> {
  try {
    const raw = await fsp.readFile(path.join(dir, PLAN_FILE), 'utf8');
    const parsed = JSON.parse(raw) as { signature?: string };
    return parsed.signature ?? null;
  } catch {
    return null;
  }
}

export async function writePlan(dir: string, signature: string): Promise<void> {
  await ensureDir(dir);
  await fsp.writeFile(path.join(dir, PLAN_FILE), JSON.stringify({ signature, createdAt: Date.now() }, null, 2));
}

export async function clearDir(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true });
  await ensureDir(dir);
}

/**
 * Feed an existing partial file into a fresh digest so that a resumed part ends
 * up with a hash over the *whole* part, not only the bytes fetched this run.
 */
export async function hashFilePrefix(file: string, length: number, hasher?: Hash): Promise<Hash> {
  const digest = hasher ?? createHash('sha256');
  if (length <= 0) return digest;
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < length) {
      const want = Math.min(buffer.length, length - position);
      const { bytesRead } = await handle.read(buffer, 0, want, position);
      if (bytesRead <= 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return digest;
}

/** Pick a file name that does not collide with an unrelated existing file. */
export async function uniqueTargetPath(directory: string, fileName: string): Promise<string> {
  const parsed = path.parse(fileName);
  let candidate = path.join(directory, fileName);
  let index = 1;
  while (await exists(candidate)) {
    candidate = path.join(directory, `${parsed.name} (${index})${parsed.ext}`);
    index += 1;
    if (index > 999) break;
  }
  return candidate;
}
