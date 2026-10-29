/*
 * YunFlow (云流) — a desktop download accelerator built on multi-connection
 * ranged HTTP transfers.
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
 * The design of this engine is based on a study of YunX (云析)
 * <https://github.com/CYQawa/YunX>, Copyright (C) 2026 CYQawa,
 * licensed under the GNU Affero General Public License v3.0.
 */

import type { PlatformProfile } from './types';

/**
 * Per-platform tuning. The numbers are not cosmetic:
 *
 *  - `defaultThreads` is the value pre-filled in the new-download dialog. It is
 *    a recommendation, not a cap — users can raise it up to the runtime ceiling
 *    (512 on desktop, 32 on mobile).
 *  - `maxRangeWorkers` is a *CDN* ceiling that further restricts the runtime
 *    ceiling. Only Xunlei needs one: above roughly 8 concurrent ranges its edge
 *    answers a ranged request with a plain 200 (the whole body), which forces a
 *    single-stream fallback and *lowers* throughput. Every other platform
 *    inherits the full 512, so raising the slider really opens that many
 *    connections.
 *  - `suggestedHeaders` are the headers a browser would send when the download
 *    was started from the drive's own web UI. Direct links are usually bound to
 *    them; without a Referer the CDN returns an HTML rejection page.
 */
export const PLATFORMS: PlatformProfile[] = [
  {
    id: 'quark',
    name: '夸克网盘',
    hosts: ['pan.quark.cn', 'drive.quark.cn', 'quark.cn'],
    defaultThreads: 16,
    maxRangeWorkers: 512,
    suggestedHeaders: { Referer: 'https://pan.quark.cn/' },
    accent: '#4f6bff',
    loginUrl: 'https://pan.quark.cn/'
  },
  {
    id: 'uc',
    name: 'UC 网盘',
    hosts: ['drive.uc.cn', 'fast.uc.cn', 'uc.cn'],
    defaultThreads: 16,
    maxRangeWorkers: 512,
    suggestedHeaders: { Referer: 'https://drive.uc.cn/' },
    accent: '#f59f00',
    loginUrl: 'https://drive.uc.cn/'
  },
  {
    id: 'xunlei',
    name: '迅雷网盘',
    hosts: ['pan.xunlei.com', 'cdn.xunlei.com', 'xunlei.com'],
    defaultThreads: 8,
    maxRangeWorkers: 8,
    suggestedHeaders: { Referer: 'https://pan.xunlei.com/' },
    accent: '#2f7cf6',
    loginUrl: 'https://pan.xunlei.com/',
    note: '该 CDN 对单文件并发 Range 有阈值，超过约 8 路会退化为整文件响应，因此并发被主动限制'
  },
  {
    id: 'baidu',
    name: '百度网盘',
    hosts: ['pan.baidu.com', 'pcs.baidu.com', 'd.pcs.baidu.com'],
    defaultThreads: 8,
    maxRangeWorkers: 512,
    suggestedHeaders: { Referer: 'https://pan.baidu.com/' },
    accent: '#2b6cf6',
    loginUrl: 'https://pan.baidu.com/',
    note: '风控严格，建议使用非主力账号；并发过高容易触发限流'
  },
  {
    id: '123pan',
    name: '123 云盘',
    hosts: ['123pan.com', '123684.com', '123865.com', '123912.com', '123pan.cn'],
    defaultThreads: 16,
    maxRangeWorkers: 512,
    suggestedHeaders: { Referer: 'https://www.123pan.com/' },
    accent: '#00a6a6',
    loginUrl: 'https://www.123pan.com/'
  },
  {
    id: '139',
    name: '139 网盘',
    hosts: ['yun.139.com', 'caiyun.139.com'],
    defaultThreads: 8,
    maxRangeWorkers: 512,
    suggestedHeaders: { Referer: 'https://yun.139.com/' },
    accent: '#1f9d55',
    loginUrl: 'https://yun.139.com/'
  },
  {
    id: 'github',
    name: 'GitHub',
    hosts: ['github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com', 'codeload.github.com'],
    defaultThreads: 16,
    maxRangeWorkers: 512,
    suggestedHeaders: {},
    accent: '#57606a',
    loginUrl: 'https://github.com/login'
  },
  {
    id: 'direct',
    name: '通用直链',
    hosts: [],
    defaultThreads: 8,
    maxRangeWorkers: 512,
    suggestedHeaders: {},
    accent: '#6b7280'
  }
];

const BY_HOST = new Map<string, PlatformProfile>();
for (const profile of PLATFORMS) {
  for (const host of profile.hosts) BY_HOST.set(host, profile);
}

export function platformForUrl(url: string): PlatformProfile {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const exact = BY_HOST.get(host);
    if (exact) return exact;
    for (const [candidate, profile] of BY_HOST) {
      if (host === candidate || host.endsWith(`.${candidate}`)) return profile;
    }
  } catch {
    /* not a URL yet */
  }
  return PLATFORMS[PLATFORMS.length - 1];
}

export function platformById(id: string | undefined): PlatformProfile {
  return PLATFORMS.find((p) => p.id === id) ?? PLATFORMS[PLATFORMS.length - 1];
}
