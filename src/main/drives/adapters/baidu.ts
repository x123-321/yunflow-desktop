/*
 * YunFlow (云流) — Baidu Netdisk adapter.
 * Copyright (C) 2026 YunFlow Contributors
 *
 * AGPL-3.0-or-later. Endpoint knowledge ported from YunX, Copyright (C) 2026 CYQawa.
 */

import type { DriveAdapter, DriveContext, DriveEntry, DriveLink, DriveListResult, DriveProfile } from '../types';
import { DriveError } from '../types';
import { asArray, asRecord, num, requestJson, str } from '../client';

const APP_ID = '250528';
const UA_NETDISK = 'netdisk;12.24.6;piano;android-android;16;JSbridge4.4.0;jointBridge;1.1.0';
const UA_WEB =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const headers = (ctx: DriveContext) => ({
  Cookie: ctx.cookie,
  'User-Agent': UA_NETDISK,
  'X-Requested-With': 'XMLHttpRequest',
  Referer: 'https://yun.baidu.com/disk/main'
});

export const baiduAdapter: DriveAdapter = {
  id: 'baidu',

  async profile(ctx): Promise<DriveProfile> {
    const [quota, nickname] = await Promise.all([
      requestJson<Record<string, unknown>>({
        url: `https://yun.baidu.com/api/quota?clienttype=0&app_id=${APP_ID}&web=1&channel=chunlei&version=${Date.now()}`,
        headers: headers(ctx)
      }).catch(() => null),
      requestJson<Record<string, unknown>>({
        url: `https://pan.baidu.com/api/gettemplatevariable?clienttype=0&app_id=${APP_ID}&web=1&fields=${encodeURIComponent('["username"]')}`,
        headers: { ...headers(ctx), 'User-Agent': UA_WEB }
      }).catch(() => null)
    ]);
    const quotaData = asRecord(quota);
    if (num(quotaData.errno) !== 0 && !quotaData.total) {
      throw new DriveError(`读取空间失败：${str(quotaData.show_msg) || str(quotaData.errno) || '未知错误'}`);
    }
    const name = str(asRecord(asRecord(nickname).result).username);
    return {
      nickname: name || undefined,
      used: num(quotaData.used),
      total: num(quotaData.total),
      warning: name ? undefined : '未能读取昵称'
    };
  },

  async list(ctx, folderId): Promise<DriveListResult> {
    const dir = folderId || '/';
    const entries: DriveEntry[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const url =
        `https://yun.baidu.com/api/list?clienttype=0&app_id=${APP_ID}&web=1&order=time&desc=1` +
        `&dir=${encodeURIComponent(dir)}&num=100&page=${page}`;
      const json = await requestJson<Record<string, unknown>>({ url, headers: headers(ctx) });
      if (num(json.errno) !== 0) {
        throw new DriveError(str(json.show_msg) || `读取目录失败（errno=${num(json.errno)}）`, undefined, num(json.errno));
      }
      const list = asArray(json.list).map((raw) => {
        const item = asRecord(raw);
        const path = str(item.path);
        return {
          id: str(item.fs_id) || path,
          name: str(item.server_filename),
          size: num(item.size),
          isDir: num(item.isdir) === 1,
          parentId: dir,
          extra: { path }
        } satisfies DriveEntry;
      });
      entries.push(...list);
      if (list.length < 100) break;
    }
    return { entries };
  },

  async link(ctx, entry): Promise<DriveLink> {
    const path = entry.extra?.path;
    if (!path) throw new DriveError('缺少文件路径，无法取链');
    const time = Math.floor(Date.now() / 1000);
    const url =
      'https://d.pcs.baidu.com/rest/2.0/pcs/file?method=locatedownload' +
      `&app_id=${APP_ID}&clienttype=17&ver=4.0&ant=1&check_blue=1&es=1&esl=1&apn_id=1_-1` +
      '&freeisp=0&queryfree=0&use=1&dtype=1&eck=1&ehps=1&err_ver=1.0&network_type=WIFI&channel=0' +
      `&path=${encodeURIComponent(path)}&time=${time}` +
      '&rand=5ed606e9da222cde0474cdf70eda884b&devuid=0F1E9FC2E084472DA5A61C4CF4C759AF' +
      '&cuid=0F1E9FC2E084472DA5A61C4CF4C759AF&deviceid=348642637967375013' +
      '&psign=860a071f77c860e8cea06e4e54c518f3&version=2.2.111.34&version_app=12.24.6&vip=0';
    const json = await requestJson<Record<string, unknown>>({
      url,
      method: 'POST',
      headers: { ...headers(ctx), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '0'
    });
    if (num(json.errno) !== 0) throw new DriveError(str(json.show_msg) || '获取下载地址失败', undefined, num(json.errno));
    const candidates = asArray(json.urls)
      .map((raw) => asRecord(raw))
      .filter((item) => str(item.url));
    const chosen =
      candidates.find((item) => num(item.encrypt) === 0 && str(item.url).startsWith('https')) ??
      candidates.find((item) => str(item.url).startsWith('https')) ??
      candidates[0];
    const downloadUrl = str(chosen?.url);
    if (!downloadUrl) throw new DriveError('接口未返回下载地址');
    return {
      url: downloadUrl,
      fileName: entry.name,
      headers: { 'User-Agent': UA_NETDISK, Referer: 'https://pan.baidu.com/' }
    };
  }
};
