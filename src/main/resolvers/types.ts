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

import type { HeaderMap, ResolvedLink } from '../../shared/types';

export interface ResolveContext {
  headers?: HeaderMap;
}

/**
 * A resolver turns whatever the user pasted into a direct, ranged-capable URL.
 *
 * Share-page parsing is deliberately kept out of the core: every drive changes
 * its private API and signature scheme without notice, and a stale parser is
 * worse than none. The engine only needs a URL plus the right headers, so new
 * platforms can be added here without touching the download path.
 */
export interface LinkResolver {
  id: string;
  name: string;
  supports(url: URL): boolean;
  resolve(url: string, context: ResolveContext): Promise<ResolvedLink>;
}
