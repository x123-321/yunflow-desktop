/*
 * YunFlow (云流) — Xunlei captcha provider.
 * Copyright (C) 2026 YunFlow Contributors
 *
 * AGPL-3.0-or-later. Approach mirroring YunX, Copyright (C) 2026 CYQawa.
 * See NOTICE.
 */

import { BrowserWindow } from 'electron';
import { XUNLEI_CAPTCHA_KEY } from '../accounts/credential-parse';

/**
 * Xunlei's pan API requires `X-Captcha-Token` on every call and the token lives
 * for 300 seconds, so the one captured at login is stale within minutes — that
 * is why browsing worked right after login and failed a few minutes later with
 * `captcha_invalid`.
 *
 * Tokens are minted by the drive's own web client with a salted signature. Those
 * salts rotate with the web bundle, so re-implementing the signature is a losing
 * game (the current set is already rejected). Instead we keep the logged-in
 * session in a hidden window and let the real page mint tokens for us: it writes
 * the current one to `localStorage[captcha_<clientId>]` and refreshes it on its
 * own schedule.
 *
 * A page-minted token is accepted for every action (`about`, `files`, file
 * detail), so one provider serves all of them.
 */

interface Provider {
  win: BrowserWindow | null;
  token: string;
  expiresAt: number;
  pending: Promise<string> | null;
  idleTimer: NodeJS.Timeout | null;
}

/** Server says 300s; refresh early so a request cannot straddle the boundary. */
const TTL_MS = 210_000;
/** Keep the window warm for a while, then release its ~100 MB. */
const IDLE_DISPOSE_MS = 10 * 60_000;
const LOAD_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 400;

const providers = new Map<string, Provider>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function providerFor(partition: string): Provider {
  let provider = providers.get(partition);
  if (!provider) {
    provider = { win: null, token: '', expiresAt: 0, pending: null, idleTimer: null };
    providers.set(partition, provider);
  }
  return provider;
}

function clearIdle(provider: Provider): void {
  if (provider.idleTimer) {
    clearTimeout(provider.idleTimer);
    provider.idleTimer = null;
  }
}

function scheduleIdleDispose(provider: Provider, partition: string): void {
  clearIdle(provider);
  provider.idleTimer = setTimeout(() => disposeXunleiCaptcha(partition), IDLE_DISPOSE_MS);
  provider.idleTimer.unref?.();
}

function ensureWindow(provider: Provider, partition: string): BrowserWindow {
  if (provider.win && !provider.win.isDestroyed()) return provider.win;
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 720,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The page refreshes its own captcha on a timer; throttling a hidden
      // window would stop that timer and leave us with a stale token.
      backgroundThrottling: false
    }
  });
  win.on('closed', () => {
    if (provider.win === win) provider.win = null;
  });
  provider.win = win;
  return win;
}

/** Read the current token out of the page, or '' if it is not there yet. */
async function readToken(win: BrowserWindow): Promise<string> {
  if (win.isDestroyed()) return '';
  try {
    const raw = (await win.webContents.executeJavaScript(
      `(() => {
         try {
           const value = localStorage.getItem(${JSON.stringify(XUNLEI_CAPTCHA_KEY)});
           if (!value) return '';
           try {
             const parsed = JSON.parse(value);
             if (typeof parsed === 'string') return parsed;
             return parsed.token || parsed.captcha_token || '';
           } catch {
             return value;
           }
         } catch (e) { return ''; }
       })()`
    )) as string;
    return typeof raw === 'string' ? raw.trim() : '';
  } catch {
    return '';
  }
}

async function mint(provider: Provider, partition: string): Promise<string> {
  const win = ensureWindow(provider, partition);
  // Reloading guarantees a *new* token instead of the expired one still sitting
  // in storage; it is the only reliable way to force the page to re-mint.
  try {
    await win.loadURL('https://pan.xunlei.com/', { userAgent: undefined });
  } catch {
    // Offline or the page failed to load; fall through and read what exists.
  }

  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  let token = '';
  while (Date.now() < deadline) {
    token = await readToken(win);
    // Accept a token as soon as the page has written a fresh one.
    if (token && token !== provider.token) break;
    await sleep(POLL_INTERVAL_MS);
  }
  if (!token) token = provider.token;
  if (token) {
    provider.token = token;
    provider.expiresAt = Date.now() + TTL_MS;
  }
  return token;
}

/**
 * Returns a captcha token valid for the given login partition, minting one if
 * the cached value has aged out. Concurrent callers share a single page load.
 */
export async function getXunleiCaptcha(partition: string): Promise<string> {
  const provider = providerFor(partition);
  clearIdle(provider);
  if (provider.token && provider.expiresAt > Date.now()) {
    scheduleIdleDispose(provider, partition);
    return provider.token;
  }
  if (provider.pending) return provider.pending;

  provider.pending = mint(provider, partition)
    .catch(() => provider.token)
    .finally(() => {
      provider.pending = null;
      scheduleIdleDispose(provider, partition);
    });
  return provider.pending;
}

/** Force the next call to mint a new token (used after `captcha_invalid`). */
export function invalidateXunleiCaptcha(partition: string): void {
  const provider = providers.get(partition);
  if (!provider) return;
  provider.expiresAt = 0;
}

export function disposeXunleiCaptcha(partition?: string): void {
  const targets = partition ? [partition] : [...providers.keys()];
  for (const key of targets) {
    const provider = providers.get(key);
    if (!provider) continue;
    clearIdle(provider);
    if (provider.win && !provider.win.isDestroyed()) provider.win.destroy();
    providers.delete(key);
  }
}
