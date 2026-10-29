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

import { BrowserWindow, Menu, Notification, Tray, app, dialog, nativeTheme, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { AccountStore } from './accounts/store';
import { disposeXunleiCaptcha } from './drives/xunlei-session';
import { DownloadManager } from './engine/manager';
import { registerIpc } from './ipc';
import { assertUsableDirectory } from './engine/workdir';
import { loginPartition } from './accounts/login';
import { serializeCookies } from './accounts/store';
import type { DriveContext } from './drives/types';
import type { TaskView } from '../shared/types';

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let manager: DownloadManager | null = null;
let tray: Tray | null = null;
let quitting = false;

/**
 * Chromium compatibility switches.
 *
 * On several locked-down Windows installs the GPU process and the Chromium
 * sandbox fail to initialise; the process then dies with a native exception
 * (0x80000003 / crashpad "not connected") before any window exists, which looks
 * exactly like "double-click does nothing".
 *
 * The renderer only ever loads bundled local files, runs with
 * `contextIsolation: true` / `nodeIntegration: false`, and is pinned by a CSP
 * that forbids remote scripts, so relaxing the OS sandbox here does not expose
 * remote content. Set YUNFLOW_SAFE_MODE=1 to keep it enabled on machines where
 * Chromium's sandbox works.
 *
 * NOTE: this switch only takes effect when it is present on the command line
 * at process start; by the time this file runs, the browser process has already
 * initialised and crashed on affected machines. The portable package therefore
 * ships a shortcut that passes `--no-sandbox` explicitly.
 */
if (process.env.YUNFLOW_SAFE_MODE !== '1') {
  app.commandLine.appendSwitch('no-sandbox');
}

/**
 * Portable profile.
 *
 * A packaged YunFlow writes its Chromium profile, task database and logs next
 * to the executable instead of `%APPDATA%`. Two reasons:
 *
 *  - truly portable: copy the folder to a USB stick and every setting, task and
 *    partially downloaded file comes along;
 *  - robustness: on locked-down Windows installs, creating a profile under
 *    `%APPDATA%` can fail (redirected folders, security software, roaming
 *    profiles), and Chromium aborts during startup with an unhelpful native
 *    crash before any window appears. Keeping the profile beside the exe avoids
 *    that whole class of failure.
 *
 * Must run before `app.whenReady()`; changing userData later has no effect.
 */
function configurePortableProfile(): string | null {
  // `npm run dev` opts in through YUNFLOW_DEV_PORTABLE so development on a
  // machine with a broken %APPDATA% profile uses the same workaround.
  const devPortable = !app.isPackaged && process.env.YUNFLOW_DEV_PORTABLE === '1';
  if (!app.isPackaged && !devPortable) return null;
  try {
    const base = devPortable
      ? path.join(app.getAppPath(), 'dev-data')
      : path.join(path.dirname(app.getPath('exe')), 'data');
    fs.mkdirSync(base, { recursive: true });
    app.setPath('userData', base);
    app.setPath('sessionData', base);
    app.setPath('crashDumps', path.join(base, 'crashes'));
    return base;
  } catch (error) {
    console.error('[YunFlow] 无法建立便携数据目录，回退到系统用户目录', error);
    return null;
  }
}

const portableDir = configurePortableProfile();

// A packaged GUI app has no console, so leave a breadcrumb that survives a
// crash before the window is created.
function startupLog(line: string): void {
  try {
    const file = path.join(portableDir ?? app.getPath('userData'), 'startup.log');
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* logging must never break startup */
  }
}

startupLog(`launch v${app.getVersion()} packaged=${app.isPackaged} exe=${process.execPath}`);

// Electron prints these to the console, which a GUI launch does not have.
// Keeping them on stderr means run.log captures them.
process.on('uncaughtException', (error) => {
  console.error('[YunFlow] uncaught exception', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[YunFlow] unhandled rejection', reason);
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#12141a' : '#f4f5f9',
    title: 'YunFlow 云流',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    startupLog('ready-to-show');
    mainWindow?.show();
  });
  // Closing the window hides it to the tray; quitting happens from the tray
  // menu (or app.quit() with `quitting` already set).
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // The Xunlei captcha provider keeps a hidden window alive; without this the
    // app would stay running with no visible window until that window idles out.
    disposeXunleiCaptcha();
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const load = devUrl
    ? mainWindow.loadURL(devUrl)
    : mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  load.catch((error: Error) => {
    // Without this the window would stay blank and the failure would only be
    // visible in a console the user never opens.
    console.error('[YunFlow] 界面加载失败', error);
    startupLog(`renderer load failed: ${error.message}`);
    dialog.showErrorBox('YunFlow 界面加载失败', `${error.message}\n\n请确认 dist/renderer 已构建（npm run build）。`);
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    try {
      Menu.setApplicationMenu(null);

      const dataDir = app.getPath('userData');
      const accounts = new AccountStore(path.join(dataDir, 'accounts.json'), {
        available: () => safeStorage.isEncryptionAvailable(),
        encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
        decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64'))
      });
      await accounts.load();
      startupLog(`accounts loaded encrypted=${accounts.encrypted}`);

      manager = new DownloadManager({
        dataDir,
        defaultDirectory: path.join(app.getPath('downloads'), 'YunFlow'),
        cookieProvider: (platformId) => accounts.cookieHeader(platformId),
        // Lets the manager re-mint expired drive links on its own.
        driveContext: (platformId): DriveContext | null => {
          const account = accounts.get(platformId);
          if (!account) return null;
          return {
            cookie: serializeCookies(account.cookies) ?? '',
            credentials: { ...(account.credentials ?? {}) },
            partition: loginPartition(platformId),
            onCredentials: (patch) => {
              void accounts.updateCredentials(platformId, patch).catch(() => undefined);
            }
          };
        }
      });
      await manager.init();

      registerIpc(manager, accounts, () => mainWindow);
      startupLog('manager ready');
      createWindow();

      const showMainWindow = (): void => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          createWindow();
          return;
        }
        mainWindow.show();
        mainWindow.focus();
      };

      // Tray: the app keeps downloading while its window is closed.
      void app
        .getFileIcon(process.execPath, { size: 'normal' })
        .then((icon) => {
          tray = new Tray(icon);
          tray.setToolTip('YunFlow 云流');
          tray.setContextMenu(
            Menu.buildFromTemplate([
              { label: '显示主窗口', click: showMainWindow },
              { type: 'separator' },
              { label: '退出', click: () => app.quit() }
            ])
          );
          tray.on('click', showMainWindow);
          startupLog('tray ready');
        })
        .catch((trayError: unknown) => {
          startupLog(
            `tray failed: ${trayError instanceof Error ? trayError.message : String(trayError)}`
          );
        });

      // One system notification per finished download; clicking it opens the app.
      const notified = new Set<string>();
      manager.on('update', (views: TaskView[]) => {
        for (const view of views) {
          if (view.status !== 'completed' || notified.has(view.id)) continue;
          notified.add(view.id);
          try {
            const notification = new Notification({
              title: '下载完成',
              body: `${view.fileName}（${view.directory}）`
            });
            notification.on('click', showMainWindow);
            notification.show();
          } catch {
            /* notifications are unavailable on some systems */
          }
        }
      });

      // Record up front whether the configured destination is writable: this is
      // the first thing to check when a download "does nothing", and after an
      // elevated launch it is the proof that elevation changed anything.
      const configuredDirectory = manager.getSettings().downloadDirectory;
      void assertUsableDirectory(configuredDirectory).then(
        () => startupLog(`dir probe ${configuredDirectory}: writable`),
        (probeError: unknown) =>
          startupLog(
            `dir probe ${configuredDirectory}: NOT writable (${
              probeError instanceof Error ? probeError.message : probeError
            })`
          )
      );

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    } catch (error) {
      // A silent failure here looks exactly like "the app does not start".
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      console.error('[YunFlow] 启动失败', message);
      startupLog(`startup failed: ${message}`);
      dialog.showErrorBox('YunFlow 启动失败', message);
      app.quit();
    }
  });

  app.on('before-quit', () => {
    quitting = true;
    manager?.shutdown();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
