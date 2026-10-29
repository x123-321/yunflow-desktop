/*
 * YunFlow (云流) — development launcher.
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

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const require_ = require;

// Vite's package exports do not expose bin/vite.js, so resolve by path.
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const electronBinary = require_('electron');

const vite = spawn(process.execPath, [viteBin], { cwd: root, stdio: 'inherit' });
let electron = null;
let shuttingDown = false;

const stop = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  electron?.kill();
  vite.kill();
  process.exit(0);
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

async function waitForServer(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Vite dev server did not start at ${url}`);
}

async function main() {
  await waitForServer('http://localhost:5273/');

  const tsc = spawn(process.execPath, [tscBin, '-p', 'tsconfig.main.json'], { cwd: root, stdio: 'inherit' });
  const code = await new Promise((resolve) => tsc.on('exit', resolve));
  if (code !== 0) {
    console.error('main process build failed');
    stop();
    return;
  }

  // Same trap as scripts/start.mjs: an inherited ELECTRON_RUN_AS_NODE (even an
  // empty one) makes Electron boot as plain Node instead of a GUI app.
  const childEnv = {
    ...process.env,
    VITE_DEV_SERVER_URL: 'http://localhost:5273/',
    YUNFLOW_DEV_PORTABLE: '1'
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  // --no-sandbox keeps Chromium alive on machines where its sandbox cannot
  // initialise; the renderer only loads local files.
  electron = spawn(electronBinary, ['.', '--no-sandbox'], {
    cwd: root,
    stdio: 'inherit',
    env: childEnv
  });
  electron.on('exit', stop);
}

main().catch((error) => {
  console.error(error);
  stop();
});
