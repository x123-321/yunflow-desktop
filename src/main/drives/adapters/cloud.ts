/*
 * YunFlow (云流) — Quark / UC adapter (shared API shape).
 * Copyright (C) 2026 YunFlow Contributors
 *
 * AGPL-3.0-or-later. Endpoint knowledge ported from YunX, Copyright (C) 2026 CYQawa.
 */

import type { DriveAdapter, DriveContext, DriveEntry, DriveLink, DriveListResult, DriveProfile } from '../types';
import { DriveError } from '../types';
import { asArray, asRecord, bool, num, requestJson, str } from '../client';

interface CloudConfig {
  id: string;
  apiBase: string;
  pr: string;
  referer: string;
  origin: string;
  apiUa: string;
  accountUrl: string;
}

function qs(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&');
}

export function createCloudAdapter(config: CloudConfig): DriveAdapter {
  const headers = (ctx: DriveContext) => ({
    Cookie: ctx.cookie,
    'User-Agent': config.apiUa,
    Origin: config.origin,
    Referer: config.referer
  });

  return {
    id: config.id,

    async profile(ctx): Promise<DriveProfile> {
      const url = `${config.apiBase}/1/clouddrive/member?${qs({
        pr: config.pr,
        fr: 'pc',
        fetch_subscribe: 'true',
        _ch: 'home'
      })}`;
      const json = await requestJson<Record<string, unknown>>({ url, headers: headers(ctx) });
      const data = asRecord(json.data);
      if (!Object.keys(data).length) {
        throw new DriveError(`读取空间失败：${str(json.message) || '响应缺少 data'}`);
      }
      const total = num(data.total_capacity);
      const used = num(data.use_capacity);
      let nickname: string | undefined;
      try {
        const info = await requestJson<Record<string, unknown>>({
          url: config.accountUrl,
          headers: headers(ctx)
        });
        const infoData = asRecord(info.data);
        nickname = str(infoData.nickname) || str(infoData.nick_name) || undefined;
      } catch {
        // Nickname is cosmetic; quota is the important part.
      }
      return { nickname, used, total };
    },

    async list(ctx, folderId): Promise<DriveListResult> {
      const url = `${config.apiBase}/1/clouddrive/file/sort?${qs({
        pr: config.pr,
        fr: 'pc',
        pdir_fid: folderId || '0',
        _page: 1,
        _size: 100,
        _fetch_total: 1,
        _fetch_sub_dirs: 0,
        _sort: 'file_type:asc,updated_at:desc',
        fetch_all_file: 1
      })}`;
      const json = await requestJson<Record<string, unknown>>({ url, headers: headers(ctx) });
      if (num(json.status) !== 200 && num(json.code) !== 0) {
        throw new DriveError(str(json.message) || '读取文件列表失败', undefined, num(json.code));
      }
      const data = asRecord(json.data);
      const entries: DriveEntry[] = asArray(data.list).map((raw) => {
        const item = asRecord(raw);
        return {
          id: str(item.fid),
          name: str(item.file_name) || str(item.fname),
          size: num(item.size),
          isDir: bool(item.dir) || bool(item.isdir),
          parentId: str(item.pdir_fid) || folderId
        };
      }).filter((entry) => entry.id);
      return { entries, next: str(data.next_page_token) || undefined };
    },

    async link(ctx, entry): Promise<DriveLink> {
      const url = `${config.apiBase}/1/clouddrive/file/download?${qs({
        pr: config.pr,
        fr: 'pc',
        sys: 'win32',
        ve: '3.23.2'
      })}`;
      const json = await requestJson<Record<string, unknown>>({
        url,
        method: 'POST',
        headers: { ...headers(ctx), 'Content-Type': 'application/json' },
        body: JSON.stringify({ fids: [entry.id] })
      });
      if (num(json.status) !== 200 && num(json.code) !== 0) {
        throw new DriveError(str(json.message) || '获取下载地址失败', undefined, num(json.code));
      }
      const item = asRecord(asArray(json.data)[0]);
      const downloadUrl = str(item.download_url);
      if (!downloadUrl) throw new DriveError('接口未返回下载地址');
      return {
        url: downloadUrl,
        fileName: str(item.file_name) || str(item.filename) || entry.name,
        headers: {
          Referer: config.referer,
          'User-Agent': config.apiUa,
          ...(ctx.cookie ? { Cookie: ctx.cookie } : {})
        }
      };
    }
  };
}
