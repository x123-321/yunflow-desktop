/*
 * YunFlow (云流) — release archive builder.
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

/**
 * Builds the public release archives for all targets:
 *
 *   node scripts/make-release.mjs v1.0.1
 *
 *   release/YunFlow-win32-x64-v1.0.1.zip
 *   release/YunFlow-win32-ia32-v1.0.1.zip
 *   release/YunFlow-linux-x64-v1.0.1.tar.gz
 *
 * HARD RULE: `data/` inside any package directory NEVER enters an archive.
 * It holds the user's drive logins (encrypted cookies/credentials) and task
 * history. A v1.0.0 accident shipped 640 data entries (including Chromium
 * partition files) to a public release; this script exists so that class of
 * mistake cannot happen again — the exclusion is centralized here and the
 * result is verified before the archive is accepted.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TAR = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
const root = path.resolve(import.meta.dirname, '..');
const releaseDir = path.join(root, 'release');

const version = process.argv[2] ?? '';
if (!/^v?\d+\.\d+\.\d+$/.test(version)) {
  console.error('用法: node scripts/make-release.mjs <version>   例: v1.0.1');
  process.exit(1);
}
const tag = version.startsWith('v') ? version : `v${version}`;

const targets = [
  { dir: 'YunFlow-win32-x64', ext: 'zip' },
  { dir: 'YunFlow-win32-ia32', ext: 'zip' },
  { dir: 'YunFlow-linux-x64', ext: 'tar.gz' }
];

function tarArgs(dirName, ext, outName) {
  const excludes = [`--exclude=${dirName}/data`, `--exclude=${dirName}/data/*`];
  const flags = ext === 'zip' ? ['-a', '-c', '-f'] : ['-czf'];
  return [...flags, outName, ...excludes, dirName];
}

/** List every entry inside the archive; aborts if any data/ path appears. */
function verifyNoData(archivePath, dirName) {
  const listing = execFileSync(TAR, ['-tf', archivePath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const leaked = listing.split('\n').filter((line) => line.startsWith(`${dirName}/data/`));
  if (leaked.length > 0) {
    throw new Error(
      `拒绝接受 ${path.basename(archivePath)}：仍包含 ${leaked.length} 个 data/ 条目（首个: ${leaked[0]}）`
    );
  }
}

async function main() {
  for (const { dir, ext } of targets) {
    const srcDir = path.join(releaseDir, dir);
    try {
      await fs.access(srcDir);
    } catch {
      throw new Error(`缺少 ${srcDir}，请先执行: node scripts/package-portable.mjs --target=${dir.replace('YunFlow-', '')}`);
    }
    const outName = `${dir}-${tag}.${ext}`;
    const outPath = path.join(releaseDir, outName);
    await fs.rm(outPath, { force: true });
    console.log(`  打包 ${outName} …`);
    execFileSync(TAR, tarArgs(dir, ext, outName), { cwd: releaseDir, stdio: 'pipe' });
    verifyNoData(outPath, dir);
    const stat = await fs.stat(outPath);
    console.log(`  ✓ ${outName}  ${(stat.size / 1024 / 1024).toFixed(1)} MB（已验证不含 data/）`);
  }
  console.log('\n  全部发布包就绪，data/ 已排除并验证。');
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
