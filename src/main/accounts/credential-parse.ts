/*
 * YunFlow (云流) — login-state parsers.
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
 * Parsing rules mirror YunX (云析, Copyright (C) 2026 CYQawa, AGPL-3.0).
 */

/**
 * localStorage snapshots are messy: the same value can be a JSON object, a
 * JSON-encoded *string* of a JSON object (double encoded), or a bare token.
 * These helpers normalise all of them before any field is read.
 */

/** Web OAuth client id used by pan.xunlei.com (differs from the mobile app's). */
export const XUNLEI_WEB_CLIENT_ID = 'Xqp0kJBXWhwaTpB6';
export const XUNLEI_CREDENTIALS_KEY = `credentials_${XUNLEI_WEB_CLIENT_ID}`;
export const XUNLEI_CAPTCHA_KEY = `captcha_${XUNLEI_WEB_CLIENT_ID}`;

export interface XunleiCredentials {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
  captchaToken: string;
  userId: string;
  nickname: string;
}

function parseJsonish(value: string): unknown {
  let text = value.trim();
  if (!text) return undefined;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!/^[[{"-]|^[0-9]|^true$|^false$|^null$/.test(text)) return text;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== 'string') return parsed;
      // A JSON string may itself contain JSON; unwrap once more.
      text = parsed.trim();
      if (!text) return undefined;
    } catch {
      return text;
    }
  }
  return text;
}

/** Wrappers the drive front-ends have used over time: `{token:{…}}`, `{data:{…}}`. */
function unwrapNested(value: Record<string, unknown>): Record<string, unknown> {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    const nested = ['token', 'data', 'credentials', 'webToken', 'auth'].find((key) => {
      const candidate = current[key];
      return candidate && typeof candidate === 'object' && !Array.isArray(candidate);
    });
    if (!nested) return current;
    current = current[nested] as Record<string, unknown>;
  }
  return current;
}

function flatFields(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === 'string') out[key] = field;
    else if (typeof field === 'number') out[key] = String(field);
  }
  return out;
}

function pick(fields: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const value = fields[key];
    if (value && value.trim()) return value.trim();
  }
  return '';
}

/**
 * A token is only accepted when it looks like one. The login page writes
 * intermediate state into localStorage, so "key exists" does not mean
 * "logged in" — accepting it would store a half-finished session.
 */
export function looksLikeToken(value: string): boolean {
  const token = value.replace(/^Bearer\s+/i, '').trim();
  if (token.length < 16 || token.length > 8192) return false;
  return /^[A-Za-z0-9._~+/=:@-]+$/.test(token);
}

function stripBearer(value: string): string {
  return value.replace(/^Bearer\s+/i, '').trim();
}

/**
 * Read the Xunlei session out of a whole localStorage snapshot.
 *
 * YunX reads a single key (`credentials_<clientId>`); we scan every key with
 * that prefix because sub-accounts append `@<sub>` and because the site has
 * renamed the key across releases.
 */
export function parseXunleiStorage(entries: Record<string, string>): XunleiCredentials | null {
  let found: XunleiCredentials | null = null;

  const keys = Object.keys(entries)
    .filter((key) => key.startsWith('credentials_'))
    // Prefer the exact key, then the shortest suffix (primary account first).
    .sort((a, b) => {
      if (a === XUNLEI_CREDENTIALS_KEY) return -1;
      if (b === XUNLEI_CREDENTIALS_KEY) return 1;
      return a.length - b.length;
    });

  for (const key of keys) {
    const parsed = parseJsonish(entries[key] ?? '');
    if (typeof parsed === 'string') {
      // Bare token: the site (or a user who pasted one) stored the JWT alone.
      const token = stripBearer(parsed);
      if (looksLikeToken(token)) {
        found = { accessToken: token, refreshToken: '', deviceId: '', captchaToken: '', userId: '', nickname: '' };
        break;
      }
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const fields = flatFields(unwrapNested(parsed as Record<string, unknown>));
    const accessToken = stripBearer(pick(fields, 'access_token', 'accessToken'));
    const refreshToken = stripBearer(pick(fields, 'refresh_token', 'refreshToken'));
    if (!accessToken && !refreshToken) continue;
    // Reject the half-written states the login page leaves behind.
    if (accessToken && !looksLikeToken(accessToken)) continue;
    if (refreshToken && !looksLikeToken(refreshToken)) continue;
    found = {
      accessToken,
      refreshToken,
      deviceId: pick(fields, 'device_id', 'deviceId'),
      captchaToken: '',
      userId: pick(fields, 'user_id', 'userId', 'sub'),
      nickname: pick(fields, 'nick_name', 'nickname', 'name', 'user_name')
    };
    break;
  }

  if (!found) return null;
  found.captchaToken = readXunleiCaptcha(entries);
  return found;
}

/**
 * `captcha_<clientId>` holds a short-lived token that Xunlei wants on most
 * drive calls. Missing it is not fatal, so failures fall through to ''.
 */
export function readXunleiCaptcha(entries: Record<string, string>): string {
  for (const key of Object.keys(entries)) {
    if (!key.startsWith('captcha_')) continue;
    const parsed = parseJsonish(entries[key] ?? '');
    if (typeof parsed === 'string') {
      const token = stripBearer(parsed);
      if (looksLikeToken(token)) return token;
      continue;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const fields = flatFields(unwrapNested(parsed as Record<string, unknown>));
      const token = stripBearer(pick(fields, 'captcha_token', 'captchaToken', 'token'));
      if (looksLikeToken(token)) return token;
    }
  }
  return '';
}

/** 123pan keeps a plain token under `authorToken`. */
export function parsePan123Storage(entries: Record<string, string>): { authorToken: string } | null {
  const raw = entries.authorToken?.trim();
  if (!raw) return null;
  const parsed = parseJsonish(raw);
  const token = typeof parsed === 'string' ? stripBearer(parsed) : '';
  if (!looksLikeToken(token)) return null;
  return { authorToken: token };
}

/** Flatten captured credentials into the string map the adapters consume. */
export function toCredentialMap(credentials: XunleiCredentials | null): Record<string, string> {
  if (!credentials) return {};
  const out: Record<string, string> = { authType: 'webToken' };
  if (credentials.accessToken) out.accessToken = credentials.accessToken;
  if (credentials.refreshToken) out.refreshToken = credentials.refreshToken;
  if (credentials.deviceId) out.deviceId = credentials.deviceId;
  if (credentials.captchaToken) out.captchaToken = credentials.captchaToken;
  if (credentials.userId) out.userId = credentials.userId;
  if (credentials.nickname) out.nickname = credentials.nickname;
  return out;
}
