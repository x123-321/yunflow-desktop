/*
 * YunFlow (云流) — account vault.
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
 * Encrypted cookie vault.
 *
 * YunFlow does not implement account/password login: the embedded window is the
 * drive's own login page, and what we keep is the resulting cookie jar. That is
 * enough to sign the range requests of a task, which is the only thing the
 * download engine needs.
 *
 * Cookies are secrets: they are encrypted with Electron's `safeStorage` (DPAPI
 * on Windows, Keychain on macOS, libsecret on Linux) before touching disk. If
 * the OS keyring is unavailable the vault degrades to plaintext and says so in
 * the UI rather than silently pretending to be encrypted.
 */

import fsp from 'node:fs/promises';

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
  /** Unix seconds. */
  expirationDate?: number;
}

export interface StoredAccount {
  platformId: string;
  cookies: StoredCookie[];
  /** Tokens pulled from the login page's localStorage (123 / Xunlei). */
  credentials?: Record<string, string>;
  updatedAt: number;
}

interface VaultFile {
  version: 1;
  encrypted: boolean;
  payload: string;
}

export interface SecretBox {
  available(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

/** Plain JSON box, used by tests and as a last-resort fallback. */
export const plainBox: SecretBox = {
  available: () => false,
  encrypt: (value) => value,
  decrypt: (value) => value
};

/** Cookie domains are suffix-matched: `.baidu.com` belongs to `pan.baidu.com`. */
export function cookieMatchesHosts(domain: string, hosts: string[]): boolean {
  const normalized = domain.replace(/^\./, '').toLowerCase();
  if (!normalized) return false;
  return hosts.some((host) => {
    const h = host.toLowerCase();
    return normalized === h || h.endsWith(`.${normalized}`) || normalized.endsWith(`.${h}`);
  });
}

export function serializeCookies(cookies: StoredCookie[], now = Date.now()): string | undefined {
  const valid = cookies.filter((cookie) => {
    if (!cookie.name) return false;
    if (cookie.expirationDate && cookie.expirationDate * 1000 <= now) return false;
    return true;
  });
  if (valid.length === 0) return undefined;
  return valid.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

export class AccountStore {
  private accounts = new Map<string, StoredAccount>();

  constructor(
    private readonly file: string,
    private readonly box: SecretBox
  ) {}

  get encrypted(): boolean {
    return this.box.available();
  }

  async load(): Promise<void> {
    this.accounts.clear();
    let raw: string;
    try {
      raw = await fsp.readFile(this.file, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as VaultFile;
      const json = parsed.encrypted ? this.box.decrypt(parsed.payload) : parsed.payload;
      const list = JSON.parse(json) as StoredAccount[];
      for (const account of list) {
        if (!account?.platformId || !Array.isArray(account.cookies)) continue;
        this.accounts.set(account.platformId, account);
      }
    } catch {
      // A corrupt or undecryptable vault must not stop the app from starting.
      this.accounts.clear();
    }
  }

  list(): StoredAccount[] {
    return [...this.accounts.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(platformId: string): StoredAccount | undefined {
    return this.accounts.get(platformId);
  }

  cookieHeader(platformId: string, now = Date.now()): string | undefined {
    const account = this.accounts.get(platformId);
    if (!account) return undefined;
    return serializeCookies(account.cookies, now);
  }

  async save(
    platformId: string,
    cookies: StoredCookie[],
    credentials: Record<string, string> = {}
  ): Promise<StoredAccount> {
    const account: StoredAccount = { platformId, cookies, credentials, updatedAt: Date.now() };
    this.accounts.set(platformId, account);
    await this.persist();
    return account;
  }

  async remove(platformId: string): Promise<void> {
    this.accounts.delete(platformId);
    await this.persist();
  }

  /**
   * Merge tokens an adapter refreshed mid-request. Cookies are untouched —
   * only the OAuth material changed.
   */
  async updateCredentials(platformId: string, patch: Record<string, string>): Promise<void> {
    const account = this.accounts.get(platformId);
    if (!account) return;
    account.credentials = { ...(account.credentials ?? {}), ...patch };
    account.updatedAt = Date.now();
    await this.persist();
  }

  private async persist(): Promise<void> {
    const payload = JSON.stringify(this.list());
    const file: VaultFile = this.box.available()
      ? { version: 1, encrypted: true, payload: this.box.encrypt(payload) }
      : { version: 1, encrypted: false, payload };
    await fsp.writeFile(this.file, JSON.stringify(file, null, 2), { mode: 0o600 });
  }
}
