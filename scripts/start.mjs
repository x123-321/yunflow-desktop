/*
 * YunFlow (云流) — desktop launcher.
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
 * Launches Electron with two safeguards that matter on locked-down Windows
 * machines:
 *
 *  1. `ELECTRON_RUN_AS_NODE` is removed from the child environment. If that
 *     variable leaks in (some IDE / agent shells set it), Electron starts as a
 *     plain Node process, `require('electron')` returns a path string, and the
 *     app dies immediately with "Cannot read properties of undefined".
 *  2. If Chromium exits within a few seconds with a crash code, retry once with
 *     `--no-sandbox --disable-gpu`. Corporate security software and restricted
 *     accounts regularly block Chromium's sandbox initialisation; the symptom
 *     is exactly "a console window flashes and nothing appears".
 *
 * Every attempt is appended to run.log so a failed launch can be diagnosed
 * without asking the user to copy console output.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const electronBinary = require('electron');
const logFile = path.join(root, 'run.log');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// Keep Chromium's own logs out of the console unless asked for.
if (!env.ELECTRON_ENABLE_LOGGING) delete env.ELECTRON_ENABLE_LOGGING;

fs.writeFileSync(logFile, `YunFlow launch — ${new Date().toISOString()}\n`);

const attempts = [
  { name: '标准启动', flags: [] },
  { name: '兼容启动（关闭沙箱与 GPU）', flags: ['--no-sandbox', '--disable-gpu', '--disable-crash-reporter'] },
  { name: '兼容启动（GPU 进程内运行）', flags: ['--no-sandbox', '--disable-gpu', '--in-process-gpu', '--disable-crash-reporter'] }
];

function runOnce(attempt) {
  return new Promise((resolve) => {
    const started = Date.now();
    console.log(`\n[YunFlow] ${attempt.name}${attempt.flags.length ? ` · ${attempt.flags.join(' ')}` : ''}`);
    const child = spawn(electronBinary, ['.', ...attempt.flags], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    const forward = (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (error) => {
      resolve({ code: -1, output: `${output}\n${error.message}`, elapsed: 0 });
    });
    child.on('exit', (code, signal) => {
      resolve({
        code: code ?? (signal ? -2 : 0),
        signal,
        output,
        elapsed: Date.now() - started
      });
    });
  });
}

let last = null;
for (const attempt of attempts) {
  last = await runOnce(attempt);
  fs.appendFileSync(
    logFile,
    `\n--- ${attempt.name} | flags=${attempt.flags.join(' ') || '(none)'} | code=${last.code} | signal=${last.signal ?? '-'} | ${last.elapsed}ms ---\n${last.output}\n`
  );

  // Clean exit: either the user closed the window, or the app quit normally.
  if (last.code === 0 && last.elapsed > 3_000) break;
  // It stayed alive for a while, so this is a runtime failure, not a launch
  // failure. Retrying with different Chromium flags would not help.
  if (last.elapsed > 8_000) break;
  // Clean but instant exit: most likely the single-instance lock (another
  // window is already open). Do not retry.
  if (last.code === 0) break;
}

if (last && last.code !== 0) {
  console.log('');
  console.log('------------------------------------------------------------');
  console.log(`  启动失败（退出码 ${last.code}）。`);
  console.log(`  日志已写入：${logFile}`);
  console.log('');
  console.log('  常见原因：');
  console.log('   1. 安全软件拦截了 electron.exe —— 请把本目录加入白名单；');
  console.log('   2. 系统缺少 WebView2 / VC++ 运行库；');
  console.log('   3. 显卡驱动异常 —— 上面的兼容模式已自动尝试过。');
  console.log('------------------------------------------------------------');
}

process.exit(last ? (last.code === 0 ? 0 : 1) : 1);
