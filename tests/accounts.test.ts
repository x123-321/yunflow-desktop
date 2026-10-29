/*
 * YunFlow (云流) — account vault tests.
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
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AccountStore,
  cookieMatchesHosts,
  plainBox,
  serializeCookies,
  type SecretBox
} from '../src/main/accounts/store';

const fakeBox: SecretBox = {
  available: () => true,
  encrypt: (value) => `enc:${Buffer.from(value, 'utf8').toString('base64')}`,
  decrypt: (value) => Buffer.from(value.slice(4), 'base64').toString('utf8')
};

test('cookie domains are matched by suffix, not exact host', () => {
  const hosts = ['pan.quark.cn', 'quark.cn', 'pan.baidu.com'];
  assert.equal(cookieMatchesHosts('.quark.cn', hosts), true);
  assert.equal(cookieMatchesHosts('pan.quark.cn', hosts), true);
  assert.equal(cookieMatchesHosts('.baidu.com', hosts), true, 'parent domain cookie belongs to pan.baidu.com');
  assert.equal(cookieMatchesHosts('.taobao.com', hosts), false);
  assert.equal(cookieMatchesHosts('', hosts), false);
});

test('expired or nameless cookies are dropped when serializing', () => {
  const now = 1_700_000_000_000;
  const header = serializeCookies(
    [
      { name: 'a', value: '1', domain: '', path: '/' },
      { name: 'dead', value: 'x', domain: '', path: '/', expirationDate: now / 1000 - 10 },
      { name: '', value: 'y', domain: '', path: '/' },
      { name: 'b', value: '2', domain: '', path: '/' }
    ],
    now
  );
  assert.equal(header, 'a=1; b=2');
  assert.equal(serializeCookies([{ name: 'dead', value: 'x', domain: '', path: '/', expirationDate: 1 }], now), undefined);
});

test('vault encrypts at rest and round-trips through a new instance', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'yunflow-accounts-'));
  const file = path.join(dir, 'accounts.json');
  try {
    const store = new AccountStore(file, fakeBox);
    await store.load();
    await store.save('quark', [
      { name: '__puus', value: 'secret-value', domain: '.quark.cn', path: '/' }
    ]);

    const raw = await fsp.readFile(file, 'utf8');
    assert.equal(raw.includes('secret-value'), false, 'cookie value must not be stored in plaintext');
    assert.equal(raw.includes('__puus'), false);

    const reloaded = new AccountStore(file, fakeBox);
    await reloaded.load();
    assert.equal(reloaded.encrypted, true);
    assert.equal(reloaded.cookieHeader('quark'), '__puus=secret-value');
    assert.equal(reloaded.list().length, 1);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('logout clears the stored cookies', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'yunflow-accounts-'));
  const file = path.join(dir, 'accounts.json');
  try {
    const store = new AccountStore(file, plainBox);
    await store.load();
    await store.save('baidu', [{ name: 'BDUSS', value: 'x', domain: '.baidu.com', path: '/' }]);
    assert.equal(store.encrypted, false);
    await store.remove('baidu');
    assert.equal(store.cookieHeader('baidu'), undefined);
    assert.equal(store.list().length, 0);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt vault does not throw on load', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'yunflow-accounts-'));
  const file = path.join(dir, 'accounts.json');
  try {
    await fsp.writeFile(file, '{not json');
    const store = new AccountStore(file, fakeBox);
    await store.load();
    assert.equal(store.list().length, 0);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
