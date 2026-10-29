/*
 * YunFlow (云流) — drive adapter contract.
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
 * Endpoint knowledge in src/main/drives/adapters is ported from YunX (云析),
 * Copyright (C) 2026 CYQawa, AGPL-3.0 — see NOTICE.
 */

import type { HeaderMap } from '../../shared/types';

export interface DriveContext {
  /** Serialized Cookie header captured from the embedded login window. */
  cookie: string;
  /** Tokens extracted from the login page's localStorage (123 / Xunlei). */
  credentials: Record<string, string>;
  /**
   * Electron session partition of this platform's login window. Adapters that
   * need the live web session (Xunlei mints short-lived captcha tokens in the
   * page) use it to reuse that session instead of asking the user again.
   */
  partition?: string;
  /**
   * Called when an adapter refreshes a token mid-request, so the new value is
   * written back to the vault instead of being lost when the process exits.
   */
  onCredentials?: (patch: Record<string, string>) => void;
}

export interface DriveProfile {
  nickname?: string;
  used?: number;
  total?: number;
  /** Set when the platform answered but some fields were unavailable. */
  warning?: string;
}

export interface DriveEntry {
  id: string;
  name: string;
  size: number;
  isDir: boolean;
  parentId: string;
  /** Platform specific extras needed later to mint a download link (path, etag…). */
  extra?: Record<string, string>;
}

export interface DriveListResult {
  entries: DriveEntry[];
  next?: string;
}

export interface DriveLink {
  url: string;
  fileName: string;
  /** Headers the CDN requires (Referer / UA / Cookie). */
  headers?: HeaderMap;
}

export interface DriveAdapter {
  id: string;
  profile(ctx: DriveContext): Promise<DriveProfile>;
  list(ctx: DriveContext, folderId: string, cursor?: string): Promise<DriveListResult>;
  link(ctx: DriveContext, entry: DriveEntry): Promise<DriveLink>;
}

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string | number
  ) {
    super(message);
    this.name = 'DriveError';
  }
}
