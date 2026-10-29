/*
 * YunFlow (云流) — embedded login window.
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

import { BrowserWindow, session } from 'electron';
import type { PlatformProfile } from '../../shared/types';
import {
  parsePan123Storage,
  parseXunleiStorage,
  toCredentialMap
} from './credential-parse';
import { cookieMatchesHosts, type StoredCookie } from './store';

/**
 * Snapshot the page's localStorage.
 *
 * Reads *every* key instead of filtering by name: the drives rename their keys
 * between releases, and a missed key costs the user another login. Values are
 * size-capped so a page that stuffs a blob in storage cannot stall the capture.
 */
async function readStorage(win: BrowserWindow): Promise<Record<string, string>> {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return {};
  try {
    const raw = (await win.webContents.executeJavaScript(
      `(() => {
         const out = {};
         try {
           const total = Math.min(localStorage.length, 500);
           for (let i = 0; i < total; i += 1) {
             const key = localStorage.key(i);
             if (!key) continue;
             const value = localStorage.getItem(key);
             if (typeof value !== 'string' || value.length > 32768) continue;
             out[key] = value;
           }
         } catch (e) {}
         return JSON.stringify(out);
       })()`
    )) as string;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    // Navigation in flight, destroyed renderer, or a page without storage.
    return {};
  }
}

/** Turn a raw storage snapshot into the flat credential map adapters expect. */
function credentialsFromStorage(storage: Record<string, string>): Record<string, string> {
  const out = toCredentialMap(parseXunleiStorage(storage));
  const pan123 = parsePan123Storage(storage);
  if (pan123) out.authorToken = pan123.authorToken;
  return out;
}

/**
 * One persistent Chromium partition per platform.
 *
 * Persisting the partition matters: the drive's login page often sets a device
 * fingerprint (localStorage / IndexedDB) that its API checks later. Wiping it on
 * every launch would force a fresh login each time.
 */
export function loginPartition(platformId: string): string {
  return `persist:yunflow-${platformId}`;
}

/**
 * Opens the drive's *own* login page and returns the cookies that were set for
 * it once the window closes.
 *
 * Deliberately not implementing username/password forms: the real login page
 * already handles captcha, SMS, QR codes and risk control, and replicating that
 * would mean storing passwords. We only take the resulting session cookies.
 */
export interface LoginCapture {
  cookies: StoredCookie[];
  credentials: Record<string, string>;
}

export async function captureLoginCookies(
  parent: BrowserWindow | null,
  platform: PlatformProfile
): Promise<LoginCapture> {
  if (!platform.loginUrl) throw new Error(`${platform.name} 未配置登录地址`);

  const win = new BrowserWindow({
    width: 1080,
    height: 800,
    parent: parent ?? undefined,
    modal: false,
    show: false,
    title: `登录 ${platform.name} — 登录完成后关闭此窗口`,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: loginPartition(platform.id),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.once('ready-to-show', () => win.show());

  // 123 and Xunlei keep their session token in localStorage rather than cookies.
  // The login window is the only chance to read it, so we snapshot continuously
  // *and* once more on close — a user who finishes logging in and immediately
  // closes the window would otherwise lose the write that happened between two
  // polls.
  let storage: Record<string, string> = {};
  let credentials: Record<string, string> = {};

  const refreshCredentials = async (): Promise<void> => {
    const snapshot = await readStorage(win);
    if (Object.keys(snapshot).length === 0) return;
    storage = { ...storage, ...snapshot };
    const parsed = credentialsFromStorage(storage);
    if (Object.keys(parsed).length > 0) credentials = parsed;
  };

  const poll = setInterval(() => {
    if (!win.isDestroyed()) void refreshCredentials();
  }, 1_500);

  // Login pages often replace the token on each client-side route change; every
  // navigation is a fresh chance to read a completed login.
  win.webContents.on('did-finish-load', () => void refreshCredentials());
  win.webContents.on('did-navigate-in-page', () => void refreshCredentials());

  try {
    await win.loadURL(platform.loginUrl);
  } catch {
    // A failed navigation still leaves the window open for the user to retry;
    // we simply continue and read whatever exists on close.
  }

  let closing = false;
  await new Promise<void>((resolve) => {
    if (win.isDestroyed()) {
      resolve();
      return;
    }
    win.on('close', (event) => {
      if (closing) return;
      event.preventDefault();
      closing = true;
      // Last read before the renderer goes away, then close for real. The read
      // is raced against a short timeout: a page stuck on a modal would
      // otherwise leave the window impossible to close.
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1_500));
      void Promise.race([refreshCredentials(), timeout]).finally(() => {
        if (!win.isDestroyed()) win.destroy();
      });
    });
    win.once('closed', () => resolve());
  });

  clearInterval(poll);
  const platformSession = session.fromPartition(loginPartition(platform.id));
  const cookies = await platformSession.cookies.get({});
  const mapped = cookies
    .filter((cookie) => cookieMatchesHosts(cookie.domain ?? '', platform.hosts))
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain ?? '',
      path: cookie.path ?? '/',
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      expirationDate: cookie.expirationDate
    }));

  return { cookies: mapped, credentials };
}

export async function clearLoginSession(platformId: string): Promise<void> {
  const platformSession = session.fromPartition(loginPartition(platformId));
  await platformSession.clearStorageData();
}
