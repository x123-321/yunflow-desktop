/*
 * YunFlow (云流) — 123 Cloud Drive adapter.
 * Copyright (C) 2026 YunFlow Contributors
 *
 * AGPL-3.0-or-later. Endpoint knowledge ported from YunX, Copyright (C) 2026 CYQawa.
 */

import { crc32 } from 'node:zlib';
import type { DriveAdapter, DriveContext, DriveEntry, DriveLink, DriveListResult, DriveProfile } from '../types';
import { DriveError } from '../types';
import { asArray, asRecord, num, requestJson, str } from '../client';

const API_BASE = 'https://yun.123pan.cn';
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SIGN_TABLE = 'adefghlmyijnopkqrstubcvwsz';
const SIGN_OFFSET_SECONDS = 57_600;
const LOGIN_UUID = crypto.randomUUID();

function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

/** Signed headers required by yun.123pan.cn (ported crc32 scheme). */
function signedHeaders(path: string, token: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  const shifted = new Date((ts + SIGN_OFFSET_SECONDS) * 1000);
  const minute =
    `${shifted.getUTCFullYear()}` +
    `${String(shifted.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(shifted.getUTCDate()).padStart(2, '0')}` +
    `${String(shifted.getUTCHours()).padStart(2, '0')}` +
    `${String(shifted.getUTCMinutes()).padStart(2, '0')}`;
  const substituted = [...minute].map((digit) => SIGN_TABLE[Number(digit)] ?? digit).join('');
  const authKey = hex8(crc32(substituted));
  const random = Math.floor(Math.random() * 10_000_000);
  const authValue = `${ts}-${random}-${hex8(crc32(`${ts}|${random}|${path}|web|3|${authKey}`))}`;
  return {
    platform: 'web',
    'app-version': '3',
    authorization: `Bearer ${token}`,
    loginuuid: LOGIN_UUID,
    'auth-key': authKey,
    'auth-value': authValue,
    'User-Agent': WEB_UA,
    Accept: 'application/json, text/plain, */*'
  };
}

function tokenOf(ctx: DriveContext): string {
  const token = ctx.credentials.authorToken || ctx.credentials.token;
  if (!token) throw new DriveError('未找到 123 云盘登录令牌，请重新登录');
  return token;
}

export const pan123Adapter: DriveAdapter = {
  id: '123pan',

  async profile(ctx): Promise<DriveProfile> {
    const token = tokenOf(ctx);
    const json = await requestJson<Record<string, unknown>>({
      url: `${API_BASE}/b/api/user/info`,
      headers: signedHeaders('/b/api/user/info', token)
    });
    if (num(json.code) !== 0) throw new DriveError(str(json.message) || '读取账号信息失败', undefined, num(json.code));
    const data = asRecord(json.data);
    const total = num(data.SpacePermanent) + num(data.SpaceTemp);
    return {
      nickname: str(data.Nickname) || str(data.Passport) || undefined,
      used: num(data.SpaceUsed),
      total
    };
  },

  async list(ctx, folderId, cursor): Promise<DriveListResult> {
    const token = tokenOf(ctx);
    const next = cursor || '0';
    const url =
      `${API_BASE}/b/api/file/list/new?driveId=0&limit=100&next=${encodeURIComponent(next)}` +
      `&orderBy=update_time&orderDirection=desc&parentFileId=${encodeURIComponent(folderId || '0')}` +
      '&trashed=false&SearchData=&Page=1&OnlyLookAbnormalFile=0&event=homeListFile&operateType=1&inDirectSpace=false';
    const json = await requestJson<Record<string, unknown>>({
      url,
      headers: signedHeaders('/b/api/file/list/new', token)
    });
    if (num(json.code) !== 0) throw new DriveError(str(json.message) || '读取文件列表失败', undefined, num(json.code));
    const data = asRecord(json.data);
    const entries: DriveEntry[] = asArray(data.InfoList).map((raw) => {
      const item = asRecord(raw);
      return {
        id: str(item.FileId),
        name: str(item.FileName),
        size: num(item.Size),
        // 123 uses Type=1 for folders.
        isDir: num(item.Type) === 1,
        parentId: str(item.ParentFileId) || folderId,
        extra: {
          s3keyFlag: str(item.S3KeyFlag),
          etag: str(item.Etag),
          storageNode: str(item.StorageNode)
        }
      };
    });
    const nextCursor = str(data.Next);
    return { entries, next: nextCursor && nextCursor !== '-1' ? nextCursor : undefined };
  },

  async link(ctx, entry): Promise<DriveLink> {
    const token = tokenOf(ctx);
    const body = JSON.stringify({
      driveId: 0,
      etag: entry.extra?.etag ?? '',
      fileId: Number(entry.id) || 0,
      s3keyFlag: entry.extra?.s3keyFlag ?? '',
      type: 0,
      fileName: entry.name,
      size: entry.size
    });
    const json = await requestJson<Record<string, unknown>>({
      url: `${API_BASE}/api/file/download_info`,
      method: 'POST',
      headers: { ...signedHeaders('/api/file/download_info', token), 'Content-Type': 'application/json;charset=UTF-8' },
      body
    });
    if (num(json.code) !== 0) throw new DriveError(str(json.message) || '获取下载地址失败', undefined, num(json.code));
    const data = asRecord(json.data);
    let url = str(data.DownloadUrl) || str(data.DownloadURL);
    if (!url) throw new DriveError('接口未返回下载地址');
    // download-v2?...?params=<base64> is a wrapper page, not the file.
    try {
      const parsed = new URL(url);
      const params = parsed.searchParams.get('params');
      if (params) {
        const decoded = JSON.parse(Buffer.from(params, 'base64').toString('utf8')) as { url?: string };
        if (decoded.url) url = decoded.url;
      }
    } catch {
      /* keep the original URL */
    }
    return { url, fileName: entry.name, headers: { 'User-Agent': WEB_UA } };
  }
};
