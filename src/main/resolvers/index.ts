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

import { platformForUrl } from '../platforms';
import { githubResolver } from './github';
import { directResolver } from './direct';
import type { LinkResolver } from './types';
import type { HeaderMap, ResolvedLink } from '../../shared/types';

const RESOLVERS: LinkResolver[] = [githubResolver, directResolver];

/**
 * Share pages are HTML wrappers: the bytes behind them are only reachable after
 * the drive's private "get download url" call. We say so explicitly instead of
 * letting the user watch a 12 KB HTML file "download" at 3 MB/s.
 */
const SHARE_PATHS: Record<string, RegExp> = {
  quark: /^\/s\//,
  uc: /^\/s\//,
  baidu: /^\/s\//,
  '123pan': /^\/s\//,
  '139': /\/shareweb\/|^\/w\//,
  xunlei: /^\/s\//
};

export class ShareLinkError extends Error {
  constructor(readonly platformName: string) {
    super(
      `${platformName}的分享页链接需要先用专用接口换取直链，YunFlow 不内置这类私有接口。` +
        '请在网盘网页端打开该文件并复制下载地址（浏览器开发者工具 → Network 里复制该文件的请求 URL），' +
        '再连同 Cookie / Referer 一并粘贴到「高级选项」。'
    );
    this.name = 'ShareLinkError';
  }
}

export function extractUrl(input: string): string {
  const match = /https?:\/\/[^\s"'<>]+/i.exec(input.trim());
  if (!match) {
    const bare = input.trim();
    if (/^[\w.-]+\.[a-z]{2,}\//i.test(bare)) return `https://${bare}`;
    throw new Error('没有识别到链接，请粘贴以 http:// 或 https:// 开头的地址');
  }
  // Pasted share texts often append punctuation to the URL.
  return match[0].replace(/[，。、；）)\]】”"']+$/, '');
}

export async function resolveLink(input: string, headers?: HeaderMap): Promise<ResolvedLink> {
  const url = extractUrl(input);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('链接格式不正确');
  }

  const profile = platformForUrl(url);
  const sharePattern = SHARE_PATHS[profile.id];
  if (sharePattern && sharePattern.test(parsed.pathname)) {
    throw new ShareLinkError(profile.name);
  }

  for (const resolver of RESOLVERS) {
    if (!resolver.supports(parsed)) continue;
    const resolved = await resolver.resolve(url, { headers });
    return {
      ...resolved,
      platformId: resolved.platformId || profile.id,
      headers: { ...profile.suggestedHeaders, ...resolved.headers, ...headers }
    };
  }

  return {
    url,
    platformId: profile.id,
    headers: { ...profile.suggestedHeaders, ...headers }
  };
}
