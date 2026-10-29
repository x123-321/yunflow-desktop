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

import { contextBridge, ipcRenderer } from 'electron';
import type { AddTaskInput, AppSettings, TaskView } from '../shared/types';
import type {
  AccountsState,
  DriveEntryView,
  DriveProfileView,
  DriveResult,
  LogEntry,
  YunFlowApi
} from '../shared/api';

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener as never);
  return () => ipcRenderer.removeListener(channel, listener as never);
}

const api: YunFlowApi = {
  info: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:update', patch),
  listTasks: () => ipcRenderer.invoke('tasks:list') as Promise<TaskView[]>,
  addTask: (input: AddTaskInput) => ipcRenderer.invoke('tasks:add', input),
  pauseTask: (id: string) => ipcRenderer.invoke('tasks:pause', id),
  resumeTask: (id: string) => ipcRenderer.invoke('tasks:resume', id),
  retryTask: (id: string) => ipcRenderer.invoke('tasks:retry', id),
  removeTask: (id: string) => ipcRenderer.invoke('tasks:remove', id),
  reveal: (taskId: string) => ipcRenderer.invoke('tasks:reveal', taskId),
  chooseDirectory: () => ipcRenderer.invoke('dialog:directory'),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  listAccounts: () => ipcRenderer.invoke('accounts:list') as Promise<AccountsState>,
  loginAccount: (platformId: string) => ipcRenderer.invoke('accounts:login', platformId) as Promise<AccountsState>,
  logoutAccount: (platformId: string) => ipcRenderer.invoke('accounts:logout', platformId) as Promise<AccountsState>,
  driveProfile: (platformId: string) =>
    ipcRenderer.invoke('drives:profile', platformId) as Promise<DriveResult<DriveProfileView>>,
  driveList: (platformId: string, folderId: string, cursor?: string) =>
    ipcRenderer.invoke('drives:list', platformId, folderId, cursor) as Promise<
      DriveResult<{ entries: DriveEntryView[]; next?: string }>
    >,
  driveLink: (platformId: string, entry: DriveEntryView) =>
    ipcRenderer.invoke('drives:link', platformId, entry) as Promise<
      DriveResult<{ url: string; fileName: string; headers?: Record<string, string> }>
    >,
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  onTasks: (callback) => subscribe<TaskView[]>('tasks:update', callback),
  onSettings: (callback) => subscribe<AppSettings>('settings:changed', callback),
  onLog: (callback) => subscribe<LogEntry>('tasks:log', callback)
};

contextBridge.exposeInMainWorld('yunflow', api);
