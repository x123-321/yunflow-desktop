/*
 * YunFlow (云流) — China Mobile 139 (和彩云) adapter.
 * Copyright (C) 2026 YunFlow Contributors
 *
 * AGPL-3.0-or-later. Endpoint knowledge ported from YunX, Copyright (C) 2026 CYQawa.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { DriveAdapter, DriveContext, DriveEntry, DriveLink, DriveListResult, DriveProfile } from '../types';
import { DriveError } from '../types';
import { asArray, asRecord, num, requestJson, str } from '../client';

const CLOUD_BASE = 'https://personal-kd-njs.yun.139.com';
const QUOTA_URL = 'https://user-njs.yun.139.com/user/disk/quota/detail';

const md5 = (value: string) => createHash('md5').update(value, 'utf8').digest('hex');

function authorizationOf(ctx: DriveContext): string {
  const match = ctx.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('authorization='));
  const value = match?.slice('authorization='.length);
  if (!value) throw new DriveError('登录态缺少 authorization，请重新登录');
  return value;
}

function accountOf(authorization: string): string {
  try {
    const decoded = Buffer.from(authorization.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
    const account = decoded.split(':')[1];
    if (account) return account;
  } catch {
    /* fall through */
  }
  throw new DriveError('无法从登录态解析账号，请重新登录');
}

/** mcloud-sign: <ts>,<rand>,<md5(md5(b64(sorted(encoded body))) + md5(ts:rand))> */
function signHeader(body: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const rand = randomBytes(8).toString('hex').slice(0, 16);
  const encoded = encodeURIComponent(body);
  const sorted = [...encoded].sort().join('');
  const b64 = Buffer.from(sorted, 'utf8').toString('base64');
  const sign = md5(md5(b64) + md5(`${ts}:${rand}`)).toUpperCase();
  return `${ts},${rand},${sign}`;
}

function headers(ctx: DriveContext, body: string): Record<string, string> {
  return {
    Authorization: authorizationOf(ctx),
    'mcloud-sign': signHeader(body),
    'x-yun-channel-source': '10000034',
    'x-yun-app-channel': '10000034',
    'x-huawei-channelSrc': '10000034',
    'mcloud-version': '7.17.9',
    'mcloud-client': '10701',
    'mcloud-channel': '1000101',
    'mcloud-route': '001',
    'x-yun-module-type': '100',
    'Content-Type': 'application/json',
    ...(ctx.cookie ? { Cookie: ctx.cookie } : {})
  };
}

async function post(ctx: DriveContext, url: string, payload: unknown): Promise<Record<string, unknown>> {
  const body = JSON.stringify(payload);
  return requestJson<Record<string, unknown>>({ url, method: 'POST', headers: headers(ctx, body), body });
}

export const c139Adapter: DriveAdapter = {
  id: '139',

  async profile(ctx): Promise<DriveProfile> {
    const account = accountOf(authorizationOf(ctx));
    const json = await post(ctx, QUOTA_URL, {
      userDomainId: '',
      commonAccountInfo: { account, accountType: 1 }
    });
    if (json.success === false && str(json.code) !== '0') {
      throw new DriveError(str(json.message) || '读取空间失败');
    }
    const data = asRecord(json.data);
    const total = num(data.diskSize) * 1024 * 1024;
    const free = num(data.freeDiskSize) * 1024 * 1024;
    const usedFromList = num(asRecord(asArray(data.quotaList)[0]).usedSize) * 1024 * 1024;
    return {
      nickname: account,
      total,
      used: usedFromList || Math.max(0, total - free)
    };
  },

  async list(ctx, folderId, cursor): Promise<DriveListResult> {
    const json = await post(ctx, `${CLOUD_BASE}/hcy/file/list`, {
      pageInfo: { pageSize: 100, pageCursor: cursor || null },
      orderBy: 'updated_at',
      orderDirection: 'DESC',
      parentFileId: folderId || '',
      imageThumbnailStyleList: ['Small', 'Large']
    });
    if (json.success === false && str(json.code) !== '0') {
      throw new DriveError(str(json.message) || '读取文件列表失败');
    }
    const data = asRecord(json.data);
    const entries: DriveEntry[] = asArray(data.items).map((raw) => {
      const item = asRecord(raw);
      return {
        id: str(item.fileId),
        name: str(item.name),
        size: num(item.size),
        isDir: str(item.type) === 'folder',
        parentId: str(item.parentFileId) || folderId
      };
    });
    const next = data.nextPageCursor;
    return { entries, next: typeof next === 'string' && next && next !== 'null' ? next : undefined };
  },

  async link(ctx, entry): Promise<DriveLink> {
    const json = await post(ctx, `${CLOUD_BASE}/hcy/file/getDownloadUrl`, { fileId: entry.id });
    if (json.success === false && str(json.code) !== '0') {
      throw new DriveError(str(json.message) || '获取下载地址失败');
    }
    const url = str(asRecord(json.data).url);
    if (!url) throw new DriveError('接口未返回下载地址');
    return { url, fileName: entry.name };
  }
};
