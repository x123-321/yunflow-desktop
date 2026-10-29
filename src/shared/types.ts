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

export type TaskStatus =
  | 'queued'
  | 'probing'
  | 'downloading'
  | 'merging'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled';

export type ChunkState = 'pending' | 'active' | 'done' | 'failed' | 'preempted';

export type ChunkKind = 'main' | 'elastic' | 'retry' | 'stream';

export interface HeaderMap {
  [name: string]: string;
}

export interface AddTaskInput {
  url: string;
  fileName?: string;
  headers?: HeaderMap;
  directory?: string;
  threads?: number;
  /** Platform profile id; inferred from the URL when omitted. */
  platformId?: string;
  /**
   * Drive file identity. When present, a failed/expired link can be minted
   * again by the drive adapter instead of leaving the task dead.
   */
  driveRef?: DriveFileRef;
}

/** Enough identity to re-mint a download link for a cloud-drive file. */
export interface DriveFileRef {
  platformId: string;
  fileId: string;
}

export interface ChunkView {
  index: number;
  start: number;
  end: number;
  received: number;
  state: ChunkState;
  bps: number;
  preemptCount: number;
  kind: ChunkKind;
  worker: number;
}

export interface TaskView {
  id: string;
  url: string;
  fileName: string;
  directory: string;
  platformId: string;
  driveRef?: DriveFileRef;
  status: TaskStatus;
  totalBytes: number;
  downloadedBytes: number;
  speedBps: number;
  etaSeconds: number;
  threads: number;
  activeConnections: number;
  chunkCount: number;
  preemptCount: number;
  retryCount: number;
  supportsRange: boolean;
  singleStream: boolean;
  error?: string;
  createdAt: number;
  finishedAt?: number;
  chunks: ChunkView[];
}

export interface AppSettings {
  downloadDirectory: string;
  defaultThreads: number;
  maxConcurrentTasks: number;
  /** 0 = unlimited. Applied per task, in bytes per second. */
  speedLimitBps: number;
  /** Watchdog that reconnects stalled / abnormally slow chunks. */
  slowConnectionPreempt: boolean;
  /** Global cap on simultaneously open range connections (8–512). */
  maxInflightChunks: number;
  theme: 'light' | 'dark' | 'system';
  autoResumeOnLaunch: boolean;
  /** Watch the clipboard for direct links and offer to add them. */
  clipboardWatch: boolean;
}

export interface ResolvedLink {
  url: string;
  fileName?: string;
  headers?: HeaderMap;
  platformId: string;
  /** Human readable note shown in the UI (e.g. thread cap reason). */
  note?: string;
}

export interface PlatformProfile {
  id: string;
  name: string;
  hosts: string[];
  defaultThreads: number;
  /** Some CDNs downgrade extra range requests to a plain 200; keep below it. */
  maxRangeWorkers: number;
  /** Headers a direct link usually needs (browser copy/paste flow). */
  suggestedHeaders: HeaderMap;
  accent: string;
  /** Web login page opened by the embedded login window. */
  loginUrl?: string;
  note?: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  downloadDirectory: '',
  defaultThreads: 8,
  maxConcurrentTasks: 2,
  speedLimitBps: 0,
  slowConnectionPreempt: true,
  maxInflightChunks: 512,
  theme: 'system',
  autoResumeOnLaunch: false,
  clipboardWatch: true
};

export const LICENSE_NAME = 'AGPL-3.0-or-later';
