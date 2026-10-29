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
 */

import { BrowserWindow, Notification, app, net } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const RELEASE_API =
  'https://api.github.com/repos/x123-321/yunflow-desktop/releases/latest';

/** Release asset naming for the platform this build runs on. */
function platformTarget(): string {
  if (process.platform === 'linux') return 'linux-x64';
  if (process.arch === 'ia32') return 'win32-ia32';
  return 'win32-x64';
}
const ASSET_PATTERN = new RegExp(
  `^YunFlow-${platformTarget()}-v[\\d.]+\\.(zip|tar\\.gz)$`,
  'i'
);
const EXE_NAME = process.platform === 'linux' ? 'YunFlow' : 'YunFlow.exe';
const OLD_EXE_NAME = process.platform === 'linux' ? 'YunFlow.old' : 'YunFlow.old.exe';

export type UpdateCheck =
  | { status: 'latest'; current: string }
  | {
      status: 'available';
      current: string;
      version: string;
      notes: string;
      downloadUrl: string;
      size: number;
    };

function parseVersion(tag: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isNewer(remote: string, local: string): boolean {
  const r = parseVersion(remote);
  const l = parseVersion(local);
  if (!r || !l) return false;
  return (
    r[0] !== l[0] ? r[0] > l[0]
      : r[1] !== l[1] ? r[1] > l[1]
      : r[2] > l[2]
  );
}

function updatesDir(): string {
  return path.join(app.getPath('userData'), 'updates');
}

/** Compare the running version against the latest GitHub release. */
export async function checkForUpdate(): Promise<UpdateCheck> {
  const res = await net.fetch(RELEASE_API, {
    headers: {
      'User-Agent': 'YunFlow-Updater',
      Accept: 'application/vnd.github+json'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`release lookup failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    tag_name?: string;
    body?: string;
    assets?: Array<{ name: string; browser_download_url: string; size: number }>;
  };
  const current = app.getVersion();
  const tag = data.tag_name ?? '';
  if (!isNewer(tag, current)) return { status: 'latest', current };
  const asset = (data.assets ?? []).find((a) => ASSET_PATTERN.test(a.name));
  if (!asset) return { status: 'latest', current };
  return {
    status: 'available',
    current,
    version: tag.replace(/^v/, ''),
    notes: data.body ?? '',
    downloadUrl: asset.browser_download_url,
    size: asset.size
  };
}

/** Stream the release asset to the staging directory, reporting 0..1 progress. */
export async function downloadUpdate(
  info: Extract<UpdateCheck, { status: 'available' }>,
  onProgress: (ratio: number) => void
): Promise<string> {
  const dir = updatesDir();
  await fsp.mkdir(dir, { recursive: true });
  const ext = path.extname(new URL(info.downloadUrl).pathname) || '.zip';
  const dest = path.join(dir, `update${ext}`);
  const res = await net.fetch(info.downloadUrl, {
    headers: { 'User-Agent': 'YunFlow-Updater' }
  });
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status}`);
  }
  const total =
    Number(res.headers.get('content-length')) || info.size || 0;
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let received = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (!out.write(Buffer.from(value))) {
      await new Promise<void>((resolve) => out.once('drain', resolve));
    }
    onProgress(total ? Math.min(1, received / total) : 0);
  }
  await new Promise<void>((resolve, reject) =>
    out.end((err: Error | null | undefined) => (err ? reject(err) : resolve()))
  );
  return dest;
}

async function copyTree(src: string, dest: string): Promise<void> {
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    // Never touch user data or the updater staging area.
    if (entry.name === 'data' || entry.name === 'updates') continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fsp.mkdir(to, { recursive: true });
      await copyTree(from, to);
    } else {
      const isMainExe = entry.name.toLowerCase() === EXE_NAME.toLowerCase();
      if (isMainExe) {
        // Windows refuses to overwrite a running exe but allows renaming it;
        // Linux allows both, the rename keeps the flow identical.
        try {
          await fsp.rename(to, path.join(dest, OLD_EXE_NAME));
        } catch {
          /* may not exist yet */
        }
      }
      try {
        await fsp.copyFile(from, to);
      } catch {
        // Locked resource (e.g. a loaded dll/asar): move the old one aside.
        try {
          await fsp.rename(to, `${to}.old-${Date.now()}`);
          await fsp.copyFile(from, to);
        } catch {
          /* leave the old file in place rather than break the install */
        }
      }
    }
  }
}

/**
 * Extract the staged zip and replace the running installation.
 * The user's data directory (`data/`) is never touched; the app relaunches
 * itself once the new files are in place.
 */
export async function applyUpdate(zipPath: string): Promise<void> {
  const extractDir = path.join(updatesDir(), 'extracted');
  await fsp.rm(extractDir, { recursive: true, force: true });
  await fsp.mkdir(extractDir, { recursive: true });
  // Windows 10+ ships bsdtar which understands zip archives.
  await new Promise<void>((resolve, reject) => {
    // `-x` auto-detects compression: zip on Windows (bsdtar ships with the
    // OS), tar.gz on Linux (GNU tar). Use the absolute System32 path because
    // a GNU tar from Git for Windows misreads "D:\..." as a remote host.
    const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
    const child = spawn(tar, ['-xf', zipPath, '-C', extractDir], {
      windowsHide: true
    });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`))
    );
    child.on('error', reject);
  });
  const entries = await fsp.readdir(extractDir);
  const payloadName = entries.find((e) => e.startsWith('YunFlow-win32-x64'));
  if (!payloadName) throw new Error('payload directory missing from archive');
  const payload = path.join(extractDir, payloadName);
  const appDir = path.dirname(app.getPath('exe'));
  await copyTree(payload, appDir);
  await app.relaunch();
  app.exit(0);
}

/** Remove leftovers from a previous update round; safe to call on startup. */
export async function cleanupAfterUpdate(): Promise<void> {
  const appDir = path.dirname(app.getPath('exe'));
  const leftovers = [
    path.join(appDir, OLD_EXE_NAME),
    path.join(updatesDir(), 'update.zip'),
    path.join(updatesDir(), 'update.tar.gz'),
    path.join(updatesDir(), 'extracted')
  ];
  for (const target of leftovers) {
    try {
      await fsp.rm(target, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  // Drop *.old-* files produced by locked-file fallbacks.
  try {
    for (const name of await fsp.readdir(appDir)) {
      if (/\.old-\d+$/.test(name)) {
        await fsp.rm(path.join(appDir, name), { force: true });
      }
    }
  } catch {
    /* best effort */
  }
}

function notify(title: string, body: string): void {
  try {
    new Notification({ title, body }).show();
  } catch {
    /* notifications unavailable on some systems */
  }
}

function emitProgress(ratio: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('update:progress', Math.round(ratio * 100));
    }
  }
}

/** One-shot flow used by the tray menu and the renderer: check → download → apply. */
export async function runUpdateFlow(silent = false): Promise<UpdateCheck> {
  const check = await checkForUpdate();
  if (check.status === 'latest') {
    if (!silent) {
      notify('检查更新', `已是最新版本（v${check.current}）`);
    }
    return check;
  }
  notify(
    `发现新版本 v${check.version}`,
    `当前 v${check.current}，正在后台下载更新…`
  );
  const zipPath = await downloadUpdate(check, emitProgress);
  notify('更新包下载完成', '正在应用更新，应用将自动重启…');
  await applyUpdate(zipPath);
  return check;
}
