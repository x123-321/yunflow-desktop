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

import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from 'electron';
import type { OpenDialogOptions } from 'electron';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AddTaskInput, AppSettings } from '../shared/types';
import { LICENSE_NAME } from '../shared/types';
import type { AccountsState } from '../shared/api';
import { serializeCookies, type AccountStore } from './accounts/store';
import { adapterFor } from './drives';
import { disposeXunleiCaptcha } from './drives/xunlei-session';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid-url)';
  }
}
import type { DriveEntry } from './drives/types';
import { captureLoginCookies, clearLoginSession, loginPartition } from './accounts/login';
import type { DownloadManager } from './engine/manager';
import { PLATFORMS, platformById } from './platforms';

type WindowGetter = () => BrowserWindow | null;

function accountsState(store: AccountStore): AccountsState {
  return {
    encrypted: store.encrypted,
    accounts: PLATFORMS.filter((platform) => platform.loginUrl).map((platform) => {
      const stored = store.get(platform.id);
      return {
        platformId: platform.id,
        platformName: platform.name,
        accent: platform.accent,
        loggedIn: Boolean(stored && stored.cookies.length > 0),
        cookieCount: stored?.cookies.length ?? 0,
        updatedAt: stored?.updatedAt
      };
    })
  };
}

export function registerIpc(manager: DownloadManager, store: AccountStore, getWindow: WindowGetter): void {
  const send = (channel: string, payload: unknown) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  /**
   * Task-level failures have no other durable trace: the toast disappears and a
   * task that never gets created leaves nothing in tasks.json. Everything that
   * is not routine goes to `<userData>/tasks.log`.
   */
  const logTask = async (message: string): Promise<void> => {
    try {
      const line = `${new Date().toISOString()} ${message}\n`;
      await fsp.appendFile(path.join(app.getPath('userData'), 'tasks.log'), line, 'utf8');
    } catch {
      /* logging must never break a download */
    }
  };

  manager.on('update', (views) => send('tasks:update', views));
  manager.on('settings', (settings) => send('settings:changed', settings));
  manager.on('log', (entry) => {
    send('tasks:log', entry);
    if (entry.level === 'error') void logTask(`[${entry.taskId ?? '-'}] ERROR ${entry.message}`);
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    license: LICENSE_NAME,
    dataDir: app.getPath('userData'),
    defaultDirectory: path.join(app.getPath('downloads'), 'YunFlow'),
    threads: manager.getThreadPolicy()
  }));

  ipcMain.handle('settings:get', () => manager.getSettings());
  ipcMain.handle('settings:update', (_event, patch: Partial<AppSettings>) => manager.updateSettings(patch));

  ipcMain.handle('tasks:list', () => manager.list());
  ipcMain.handle('tasks:add', async (_event, input: AddTaskInput) => {
    try {
      const task = await manager.add(input);
      // Log the directory the task actually uses: the manager may have fallen
      // back when the configured one was not writable.
      void logTask(
        `[${task.id}] added ${task.fileName} dir=${task.directory} ` +
          `threads=${task.threads} host=${hostOf(task.url)}`
      );
      return { ok: true as const, task };
    } catch (error) {
      const message = (error as Error).message || '未知错误';
      void logTask(
        `add failed host=${hostOf(input?.url ?? '')} dir=${manager.getSettings().downloadDirectory} error=${message}`
      );
      return { ok: false as const, error: message };
    }
  });
  ipcMain.handle('tasks:pause', (_event, id: string) => manager.pause(id));
  ipcMain.handle('tasks:resume', (_event, id: string) => manager.resume(id));
  ipcMain.handle('tasks:retry', (_event, id: string) => manager.retry(id));
  ipcMain.handle('tasks:remove', (_event, id: string) => manager.remove(id));

  /**
   * Reveal a task's output. Takes the task id, not a path: the renderer used to
   * concatenate `${directory}/${fileName}`, which produced `F:///name` for a
   * drive root and made the shell silently do nothing.
   */
  ipcMain.handle('tasks:reveal', async (_event, taskId: string) => {
    const task = manager.list().find((item) => item.id === taskId);
    if (!task) throw new Error('任务不存在或已被删除');
    if (!task.directory) throw new Error('该任务没有记录保存目录');

    if (task.status === 'completed') {
      const file = path.join(task.directory, task.fileName);
      try {
        await fsp.stat(file);
        shell.showItemInFolder(file);
        return;
      } catch {
        // File moved or renamed outside the app — fall back to the folder.
      }
    }

    // `openPath` reports failure through its return value instead of throwing.
    const failure = await shell.openPath(task.directory);
    if (failure) throw new Error(`无法打开目录 ${task.directory}：${failure}`);
  });

  ipcMain.handle('dialog:directory', async () => {
    const win = getWindow();
    const options: OpenDialogOptions = {
      title: '选择下载目录',
      properties: ['openDirectory', 'createDirectory']
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('clipboard:read', () => clipboard.readText());

  ipcMain.handle('accounts:list', () => accountsState(store));

  /** Platforms whose API session lives in localStorage rather than cookies. */
  const STORAGE_TOKEN_PLATFORMS = new Set(['xunlei', 'pan123']);

  ipcMain.handle('accounts:login', async (_event, platformId: string) => {
    const platform = platformById(platformId);
    if (!platform?.loginUrl) throw new Error('该平台未配置网页登录地址');
    const capture = await captureLoginCookies(getWindow(), platform);
    if (capture.cookies.length === 0 && Object.keys(capture.credentials).length === 0) {
      throw new Error('未捕获到登录态：请在弹出的窗口里完成登录，等网盘文件页面出现后再关闭窗口');
    }
    if (
      STORAGE_TOKEN_PLATFORMS.has(platform.id) &&
      !capture.credentials.accessToken &&
      !capture.credentials.authorToken
    ) {
      // Cookies alone are not enough for these two: their drive APIs only
      // accept a token. Failing here keeps the account card honest instead of
      // showing "已登录" and then "读不到空间".
      throw new Error(
        `${platform.name} 的登录令牌未写入本地存储，请重新登录并停留在网盘文件页面，确认能看见文件后再关闭窗口`
      );
    }
    await store.save(platform.id, capture.cookies, capture.credentials);
    return accountsState(store);
  });

  const contextFor = (platformId: string) => {
    const account = store.get(platformId);
    if (!account) throw new Error('该网盘尚未登录');
    return {
      cookie: serializeCookies(account.cookies) ?? '',
      credentials: { ...(account.credentials ?? {}) },
      // Adapters that need the live web session (Xunlei's captcha) reuse the
      // same persistent partition the login window wrote to.
      partition: loginPartition(platformId),
      onCredentials: (patch: Record<string, string>) => {
        // Persist refreshes asynchronously; a failure here must not fail the
        // request that just succeeded.
        void store.updateCredentials(platformId, patch).catch(() => undefined);
      }
    };
  };

  /**
   * Failures are appended to `<userData>/drives.log`. Drive APIs change without
   * notice and the only way to fix a broken adapter is to see what the server
   * actually answered — asking the user for one file beats asking them to
   * paste screenshots.
   */
  const logDriveFailure = async (label: string, message: string): Promise<void> => {
    try {
      const line = `${new Date().toISOString()} [${label}] ${message}\n`;
      await fsp.appendFile(path.join(app.getPath('userData'), 'drives.log'), line, 'utf8');
    } catch {
      /* logging must never break a request */
    }
  };

  const guarded = async <T>(label: string, action: () => Promise<T>) => {
    try {
      return { ok: true as const, data: await action() };
    } catch (error) {
      const message = (error as Error).message || '请求失败';
      void logDriveFailure(label, message);
      return { ok: false as const, error: message };
    }
  };

  ipcMain.handle('drives:profile', (_event, platformId: string) =>
    guarded(`profile:${platformId}`, async () => {
      const adapter = adapterFor(platformId);
      if (!adapter) throw new Error('该平台暂不支持浏览');
      return adapter.profile(contextFor(platformId));
    })
  );

  ipcMain.handle('drives:list', (_event, platformId: string, folderId: string, cursor?: string) =>
    guarded(`list:${platformId}`, async () => {
      const adapter = adapterFor(platformId);
      if (!adapter) throw new Error('该平台暂不支持浏览');
      return adapter.list(contextFor(platformId), folderId || '', cursor);
    })
  );

  ipcMain.handle('drives:link', (_event, platformId: string, entry: DriveEntry) =>
    guarded(`link:${platformId}`, async () => {
      const adapter = adapterFor(platformId);
      if (!adapter) throw new Error('该平台暂不支持浏览');
      return adapter.link(contextFor(platformId), entry);
    })
  );

  ipcMain.handle('accounts:logout', async (_event, platformId: string) => {
    await store.remove(platformId);
    disposeXunleiCaptcha(loginPartition(platformId));
    await clearLoginSession(platformId);
    return accountsState(store);
  });
  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    if (!/^https?:\/\//i.test(url)) return;
    await shell.openExternal(url);
  });
}
