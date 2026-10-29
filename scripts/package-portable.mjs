/*
 * YunFlow (云流) — portable Windows package builder.
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
 * Assembles a self-contained, offline Windows build:
 *
 *   release/YunFlow-win32-x64/
 *     YunFlow.exe            ← double-click, no install, no network
 *     *.dll, *.pak, locales/ ← Chromium + Node runtime
 *     resources/app/         ← our code (dist + package.json)
 *     data/                  ← created on first run (profile, tasks, logs)
 *
 * Everything the app needs at runtime is inside the folder. No npm, no Node
 * installation, no download on startup.
 *
 * Why not electron-builder for this step: builder wants to fetch NSIS /
 * winCodeSign helper binaries from the network even for a `--dir` build. This
 * script only copies files that already exist in node_modules, so packaging
 * works fully offline and is byte-for-byte reproducible.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const outDir = path.join(root, 'release', 'YunFlow-win32-x64');

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(electronDist))) {
    throw new Error('未找到 node_modules/electron/dist，请先执行 npm install');
  }
  if (!(await exists(path.join(root, 'dist', 'main', 'index.js')))) {
    throw new Error('未找到编译产物 dist/，请先执行 npm run build');
  }

  // `data/` holds logins, the task list and partial downloads, and lives inside
  // the package. Updating the payload therefore must never move or delete it:
  // the Electron runtime is only re-copied when its version changed, and the
  // application payload is refreshed in place. A running instance keeps its
  // locks, so a full rebuild asks the user to close the app instead of
  // silently losing data.
  const dataDir = path.join(outDir, 'data');
  const runtimeMarker = path.join(outDir, '.runtime-version');
  const runtimeVersion = (await fs.readFile(path.join(electronDist, 'version'), 'utf8')).trim();
  const markerVersion = (await exists(runtimeMarker))
    ? (await fs.readFile(runtimeMarker, 'utf8')).trim()
    : null;
  const fullInstall =
    !(await exists(path.join(outDir, 'YunFlow.exe'))) || markerVersion !== runtimeVersion;

  const backupDir = path.join(root, 'release', '.data-backup');
  let preserved = false;

  if (fullInstall) {
    if (await exists(dataDir)) {
      let copied = false;
      for (let attempt = 0; attempt < 4 && !copied; attempt += 1) {
        try {
          await fs.rm(backupDir, { recursive: true, force: true });
          await fs.cp(dataDir, backupDir, { recursive: true });
          copied = true;
        } catch (error) {
          if (attempt === 3) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(
              `无法备份 data\\（${reason}）。请先退出正在运行的 YunFlow，再执行打包。`
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      }
      preserved = true;
      console.log('  保留   data\\（登录态 / 任务 / 未完成分片）');
    }

    await fs.rm(outDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(outDir), { recursive: true });

    // 1. Runtime: the whole Electron distribution (Chromium + Node + ICU).
    await fs.cp(electronDist, outDir, { recursive: true });

    const exeSrc = path.join(outDir, 'electron.exe');
    if (await exists(exeSrc)) await fs.rename(exeSrc, path.join(outDir, 'YunFlow.exe'));

    // The default app shipped inside Electron is never used and only adds weight.
    await fs.rm(path.join(outDir, 'resources', 'default_app.asar'), { force: true });
    await fs.writeFile(runtimeMarker, runtimeVersion);
  } else {
    console.log('  增量更新 payload（不移动 data\\，不重新复制运行时）');
  }

  // 2. Application payload — refreshed on every run.
  const appDir = path.join(outDir, 'resources', 'app');
  await fs.mkdir(appDir, { recursive: true });
  await fs.rm(path.join(appDir, 'dist'), { recursive: true, force: true });
  await fs.cp(path.join(root, 'dist'), path.join(appDir, 'dist'), { recursive: true });

  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const appPkg = {
    name: pkg.name,
    productName: 'YunFlow',
    version: pkg.version,
    description: pkg.description,
    main: 'dist/main/index.js',
    author: pkg.author,
    license: pkg.license
  };
  await fs.writeFile(path.join(appDir, 'package.json'), `${JSON.stringify(appPkg, null, 2)}\n`);

  // 3. Licence material must travel with the binaries (AGPL-3.0 §4/§6).
  for (const file of ['LICENSE', 'NOTICE', 'README.md']) {
    if (await exists(path.join(root, file))) {
      await fs.copyFile(path.join(root, file), path.join(outDir, file));
    }
  }

  // A double-click cannot pass Chromium switches, and `--no-sandbox` must be on
  // the command line before the browser process starts. The shortcut is the
  // primary entry point; the .cmd is a console-flashing fallback.
  const exePath = path.join(outDir, 'YunFlow.exe');
  await fs.writeFile(
    path.join(outDir, 'YunFlow.cmd'),
    ['@echo off', 'cd /d "%~dp0"', 'start "" "%~dp0YunFlow.exe" --no-sandbox', ''].join('\r\n')
  );

  const lnk = path.join(outDir, 'YunFlow 云流.lnk');
  const script = [
    "$ErrorActionPreference='Stop'",
    `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}')`,
    `$s.TargetPath='${exePath}'`,
    "$s.Arguments='--no-sandbox'",
    `$s.WorkingDirectory='${outDir}'`,
    `$s.IconLocation='${exePath},0'`,
    "$s.Description='YunFlow 云流 — 多连接分片下载加速器'",
    '$s.Save()'
  ].join(';');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'pipe' });
  } catch {
    console.warn('  提示：快捷方式创建失败，请改用 YunFlow.cmd 启动。');
  }

  // Mark the shortcut "Run as administrator" (SLDF_RUNAS_USER, bit 0x2000 of
  // LinkFlags at offset 0x14). The shell API cannot set this bit, but it is one
  // flag in the file. Elevated runs sidestep destinations that only accept
  // writes from administrators — the failure seen on the F: drive root.
  try {
    // `fs` here is node:fs/promises — the sync methods do not exist on it.
    const link = await fs.readFile(lnk);
    const flags = link.readUInt32LE(20);
    if (!(flags & 0x2000)) {
      link.writeUInt32LE(flags | 0x2000, 20);
      await fs.writeFile(lnk, link);
    }
  } catch {
    console.warn('  提示：未能为快捷方式设置管理员权限，请右键 → 属性 → 兼容性 手动勾选。');
  }

  await fs.writeFile(
    path.join(outDir, '使用说明.txt'),
    [
      'YunFlow 云流 — 免安装版',
      '',
      '1. 双击「YunFlow 云流」快捷方式即可运行（它携带一个必需的启动参数）。',
      '   快捷方式已设置为「以管理员身份运行」：每次启动都会弹一个 UAC 确认框，点"是"即可。',
      '   这样做是为了让程序能写入 U 盘等受限制的目录；不想要提权时可右键快捷方式 →',
      '   属性 → 兼容性，取消"以管理员身份运行此程序"。',
      '   快捷方式失效时双击 YunFlow.cmd（此方式不带提权，可用右键 → 以管理员身份运行）。',
      '2. 首次运行会在本目录下创建 data\\ 文件夹，用于保存设置、任务记录和分片临时文件。',
      '   「网盘账号」里可以打开各网盘官网登录，Cookie 加密保存在 data\\accounts.json。',
      '3. 卸载：直接删除整个文件夹即可，不写注册表、不写系统目录。',
      '4. 换机器：把整个文件夹复制过去即可，data\\ 里的任务与断点会一起带走。',
      '   若复制后快捷方式失效，双击 YunFlow.cmd 即可。',
      '5. 如果双击后没有窗口，请查看 data\\startup.log，并把该文件附到 issue 里。',
      '',
      '许可证：AGPL-3.0-or-later，完整文本见 LICENSE，归属声明见 NOTICE。',
      '仅下载你本人拥有或已获授权的内容，并遵守各网盘服务条款。'
    ].join('\r\n')
  );

  // 4. Put the user's data back, then report.
  if (fullInstall && preserved) {
    await fs.cp(backupDir, dataDir, { recursive: true });
    await fs.rm(backupDir, { recursive: true, force: true });
  }

  const entries = await fs.readdir(outDir, { withFileTypes: true });
  let bytes = 0;
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else bytes += (await fs.stat(full)).size;
    }
  };
  await walk(outDir);

  console.log('');
  console.log('  便携版已生成');
  console.log('  --------------------------------------------------');
  console.log(`  目录   ${outDir}`);
  console.log(`  体积   ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  入口   YunFlow 云流.lnk（快捷方式） / YunFlow.cmd`);
  console.log(`  文件   ${entries.length} 项（顶层）`);
  console.log('  --------------------------------------------------');
  console.log('  运行时不联网、不安装依赖；双击「YunFlow 云流」快捷方式即可。');
  console.log('');
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
