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

import type { AddTaskInput, AppSettings, DriveFileRef, HeaderMap, TaskView } from './types';
import type { RuntimePlatform } from './thread-policy';

export interface ThreadPolicyInfo {
  runtime: RuntimePlatform;
  min: number;
  /** Runtime ceiling: 512 on desktop, 32 on mobile. */
  max: number;
  default: number;
}

export interface AppInfo {
  version: string;
  platform: string;
  license: string;
  dataDir: string;
  defaultDirectory: string;
  threads: ThreadPolicyInfo;
}

export interface AddTaskResult {
  ok: boolean;
  task?: TaskView;
  error?: string;
}

export interface AccountView {
  platformId: string;
  platformName: string;
  accent: string;
  loggedIn: boolean;
  cookieCount: number;
  updatedAt?: number;
}

export interface AccountsState {
  /** false when the OS keyring is unavailable and cookies are stored in plaintext. */
  encrypted: boolean;
  accounts: AccountView[];
}

export interface DriveProfileView {
  nickname?: string;
  used?: number;
  total?: number;
  warning?: string;
}

export interface DriveEntryView {
  id: string;
  name: string;
  size: number;
  isDir: boolean;
  parentId: string;
  extra?: Record<string, string>;
}

export interface DriveResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface LogEntry {
  taskId: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

/** Contract exposed on `window.yunflow` by the preload script. */
export interface YunFlowApi {
  info(): Promise<AppInfo>;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  listTasks(): Promise<TaskView[]>;
  addTask(input: AddTaskInput): Promise<AddTaskResult>;
  pauseTask(id: string): Promise<void>;
  resumeTask(id: string): Promise<void>;
  retryTask(id: string): Promise<void>;
  removeTask(id: string): Promise<void>;
  /** Show a task's finished file (or its folder) in the OS file manager. */
  reveal(taskId: string): Promise<void>;
  chooseDirectory(): Promise<string | null>;
  readClipboard(): Promise<string>;
  listAccounts(): Promise<AccountsState>;
  loginAccount(platformId: string): Promise<AccountsState>;
  logoutAccount(platformId: string): Promise<AccountsState>;
  driveProfile(platformId: string): Promise<DriveResult<DriveProfileView>>;
  driveList(
    platformId: string,
    folderId: string,
    cursor?: string
  ): Promise<DriveResult<{ entries: DriveEntryView[]; next?: string }>>;
  driveLink(
    platformId: string,
    entry: DriveEntryView
  ): Promise<DriveResult<{ url: string; fileName: string; headers?: HeaderMap }>>;
  openExternal(url: string): Promise<void>;
  onTasks(callback: (tasks: TaskView[]) => void): () => void;
  onSettings(callback: (settings: AppSettings) => void): () => void;
  onLog(callback: (entry: LogEntry) => void): () => void;
}
