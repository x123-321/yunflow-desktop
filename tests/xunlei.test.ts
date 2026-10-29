/*
 * YunFlow (云流) — Xunlei login-state and quota-shape tests.
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

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  XUNLEI_CAPTCHA_KEY,
  XUNLEI_CREDENTIALS_KEY,
  parsePan123Storage,
  parseXunleiStorage,
  readXunleiCaptcha
} from '../src/main/accounts/credential-parse';
import { xunleiAdapter } from '../src/main/drives/adapters/xunlei';
import type { DriveContext } from '../src/main/drives/types';

const ACCESS = 'a'.repeat(64);
const REFRESH = 'b'.repeat(64);

function ctx(credentials: Record<string, string> = {}): DriveContext {
  return { cookie: 'deviceid=dev-123; other=1', credentials: { accessToken: ACCESS, ...credentials } };
}

/** Replace global fetch for one test. */
function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const payload = handler(url, init);
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

test('xunlei storage parses every shape the login page writes', () => {
  const plain = parseXunleiStorage({
    [XUNLEI_CREDENTIALS_KEY]: JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH, device_id: 'dev-1' })
  });
  assert.equal(plain?.accessToken, ACCESS);
  assert.equal(plain?.refreshToken, REFRESH);
  assert.equal(plain?.deviceId, 'dev-1');

  // Double encoded: the value is a JSON string containing the real object.
  const doubleEncoded = parseXunleiStorage({
    [XUNLEI_CREDENTIALS_KEY]: JSON.stringify(JSON.stringify({ access_token: ACCESS }))
  });
  assert.equal(doubleEncoded?.accessToken, ACCESS);

  // Nested wrapper.
  const nested = parseXunleiStorage({
    [XUNLEI_CREDENTIALS_KEY]: JSON.stringify({ token: { accessToken: ACCESS, refreshToken: REFRESH } })
  });
  assert.equal(nested?.accessToken, ACCESS);
  assert.equal(nested?.refreshToken, REFRESH);

  // Sub-account keys sort after the primary one, so the primary wins.
  const multi = parseXunleiStorage({
    [`${XUNLEI_CREDENTIALS_KEY}@sub`]: JSON.stringify({ access_token: 'z'.repeat(64) }),
    [XUNLEI_CREDENTIALS_KEY]: JSON.stringify({ access_token: ACCESS })
  });
  assert.equal(multi?.accessToken, ACCESS);
});

test('xunlei storage rejects half-written login state', () => {
  // The page stores intermediate values while the login flow is running.
  assert.equal(parseXunleiStorage({ [XUNLEI_CREDENTIALS_KEY]: '{"access_token":""}' }), null);
  assert.equal(parseXunleiStorage({ [XUNLEI_CREDENTIALS_KEY]: 'short' }), null);
  assert.equal(parseXunleiStorage({ [XUNLEI_CREDENTIALS_KEY]: '{"access_token":"has space inside"}' }), null);
  assert.equal(parseXunleiStorage({}), null);
  // A bare token pasted into storage still works (manual fallback).
  assert.equal(parseXunleiStorage({ [XUNLEI_CREDENTIALS_KEY]: ACCESS })?.accessToken, ACCESS);
});

test('xunlei captcha token is read from its own key', () => {
  const token = 'c'.repeat(48);
  assert.equal(readXunleiCaptcha({ [XUNLEI_CAPTCHA_KEY]: JSON.stringify({ captcha_token: token }) }), token);
  assert.equal(readXunleiCaptcha({ [XUNLEI_CAPTCHA_KEY]: token }), token);
  // Missing or malformed captcha is not an error — the header is optional.
  assert.equal(readXunleiCaptcha({}), '');

  const parsed = parseXunleiStorage({
    [XUNLEI_CREDENTIALS_KEY]: JSON.stringify({ access_token: ACCESS }),
    [XUNLEI_CAPTCHA_KEY]: JSON.stringify({ captcha_token: token })
  });
  assert.equal(parsed?.captchaToken, token);
});

test('123pan storage requires a valid authorToken', () => {
  assert.equal(parsePan123Storage({ authorToken: ACCESS })?.authorToken, ACCESS);
  assert.equal(parsePan123Storage({ authorToken: ' Bearer ' + ACCESS })?.authorToken, ACCESS);
  assert.equal(parsePan123Storage({ authorToken: 'nope' }), null);
  assert.equal(parsePan123Storage({}), null);
});

test('xunlei profile reads the web-token response shape (top-level quota)', async () => {
  // The web channel answers `{kind, quota}` with no `data` wrapper. This is the
  // exact shape that used to be parsed as "no quota" → "登录后读不到空间".
  const stub = stubFetch(() => ({ kind: 'drive#about', quota: { limit: 2_199_023_255_552, usage: 1_099_511_627_776 } }));
  try {
    const profile = await xunleiAdapter.profile(ctx());
    assert.equal(profile.total, 2_199_023_255_552);
    assert.equal(profile.used, 1_099_511_627_776);
  } finally {
    stub.restore();
  }
});

test('xunlei profile still reads the mobile response shape (data.quota)', async () => {
  const stub = stubFetch(() => ({ data: { quota: { limit: 1000, usage: 250 } } }));
  try {
    const profile = await xunleiAdapter.profile(ctx());
    assert.equal(profile.total, 1000);
    assert.equal(profile.used, 250);
  } finally {
    stub.restore();
  }
});

test('xunlei surfaces the server error instead of a generic message', async () => {
  const stub = stubFetch(() => ({ error: 'unauthenticated', error_description: 'token expired' }));
  try {
    await assert.rejects(
      () => xunleiAdapter.profile(ctx({ refreshToken: '' })),
      (error: Error) => {
        assert.match(error.message, /unauthenticated/);
        assert.match(error.message, /token expired/);
        return true;
      }
    );
  } finally {
    stub.restore();
  }
});

test('xunlei refreshes an expired token once and persists it', async () => {
  let aboutCalls = 0;
  const stub = stubFetch((url) => {
    if (url.includes('/v1/auth/token')) {
      return { access_token: 'n'.repeat(64), refresh_token: 'm'.repeat(64) };
    }
    aboutCalls += 1;
    // First attempt fails with an expired token, the retry succeeds.
    return aboutCalls === 1
      ? { error: 'unauthenticated', error_description: 'token expired' }
      : { kind: 'drive#about', quota: { limit: 500, usage: 100 } };
  });
  const persisted: Record<string, string>[] = [];
  try {
    const profile = await xunleiAdapter.profile({
      ...ctx({ refreshToken: REFRESH }),
      onCredentials: (patch) => persisted.push(patch)
    });
    assert.equal(profile.total, 500);
    assert.equal(aboutCalls, 2);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].accessToken, 'n'.repeat(64));
    assert.equal(persisted[0].refreshToken, 'm'.repeat(64));
  } finally {
    stub.restore();
  }
});

test('xunlei list reads the flat web-token response (no data wrapper)', async () => {
  // The web channel returns `{kind, files, next_page_token}` at the top level.
  // Reading `data.files` only made a full drive look empty.
  const stub = stubFetch(() => ({
    kind: 'drive#fileList',
    files: [
      { id: 'f1', name: '电影', kind: 'drive#folder', size: '0' },
      { id: 'f2', name: '备份.zip', kind: 'drive#file', size: '1073741824' }
    ],
    next_page_token: 'page-2'
  }));
  try {
    const result = await xunleiAdapter.list(ctx(), '');
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0].name, '电影');
    assert.equal(result.entries[0].isDir, true);
    assert.equal(result.entries[1].size, 1073741824);
    assert.equal(result.next, 'page-2');
  } finally {
    stub.restore();
  }
});

test('xunlei list still reads the wrapped mobile response', async () => {
  const stub = stubFetch(() => ({ data: { files: [{ id: 'f1', name: 'a.txt', kind: 'drive#file', size: 12 }] } }));
  try {
    const result = await xunleiAdapter.list(ctx(), 'folder-1');
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].parentId, 'folder-1');
    assert.equal(result.next, undefined);
  } finally {
    stub.restore();
  }
});

test('xunlei list treats a real empty folder as empty, not as an error', async () => {
  const stub = stubFetch(() => ({ kind: 'drive#fileList', files: [] }));
  try {
    const result = await xunleiAdapter.list(ctx(), '');
    assert.deepEqual(result.entries, []);
  } finally {
    stub.restore();
  }
});

test('xunlei list reports an unreadable shape instead of showing it as empty', async () => {
  const stub = stubFetch(() => ({ kind: 'drive#somethingElse', items: [] }));
  try {
    await assert.rejects(() => xunleiAdapter.list(ctx(), ''), /未知结构/);
  } finally {
    stub.restore();
  }
});

test('xunlei link reads a flat download payload', async () => {
  const stub = stubFetch(() => ({
    kind: 'drive#file',
    links: { 'application/octet-stream': { url: 'https://cdn.example/demo.bin' } }
  }));
  try {
    const link = await xunleiAdapter.link(ctx(), {
      id: 'f2',
      name: '备份.zip',
      size: 1024,
      isDir: false,
      parentId: ''
    });
    assert.equal(link.url, 'https://cdn.example/demo.bin');
    assert.equal(link.fileName, '备份.zip');
  } finally {
    stub.restore();
  }
});
