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

import type { LinkResolver } from './types';
import type { ResolvedLink } from '../../shared/types';

/**
 * Turns GitHub web URLs into URLs that serve raw bytes.
 *
 * `github.com/o/r/blob/ref/path` is an HTML page and would be "downloaded" as a
 * few kilobytes of markup. `raw.githubusercontent.com` serves the file itself
 * and supports ranges, and release assets redirect to a ranged-capable CDN.
 */
export const githubResolver: LinkResolver = {
  id: 'github',
  name: 'GitHub',
  supports: (url) => url.hostname === 'github.com' || url.hostname.endsWith('.github.com'),
  resolve: async (url): Promise<ResolvedLink> => {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);

    // /owner/repo/blob/ref/path... | /owner/repo/raw/ref/path...
    if (parts.length >= 5 && (parts[2] === 'blob' || parts[2] === 'raw')) {
      const [owner, repo, , ref, ...rest] = parts;
      return {
        url: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join('/')}`,
        fileName: rest[rest.length - 1],
        platformId: 'github',
        headers: {},
        note: '已将 GitHub 文件页转换为 raw 直链'
      };
    }

    // Release asset pages already point at a ranged-capable CDN after redirect.
    if (parts.length >= 5 && parts[2] === 'releases' && parts[3] === 'download') {
      return { url, platformId: 'github', headers: {}, note: 'GitHub Release 资源' };
    }

    throw new Error(
      '这个 GitHub 地址不是文件或 Release 资源。请粘贴文件页（/blob/）或 Release 资源链接，或直接使用 raw 地址。'
    );
  }
};
