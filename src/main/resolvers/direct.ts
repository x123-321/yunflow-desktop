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
import type { LinkResolver } from './types';
import type { ResolvedLink } from '../../shared/types';

/** Accepts any http(s) URL that is already a direct download address. */
export const directResolver: LinkResolver = {
  id: 'direct',
  name: '通用直链',
  supports: (url) => url.protocol === 'http:' || url.protocol === 'https:',
  resolve: async (url): Promise<ResolvedLink> => {
    const profile = platformForUrl(url);
    return {
      url,
      platformId: profile.id,
      note: '按直链方式下载'
    };
  }
};
