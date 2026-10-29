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

import { EventEmitter } from 'node:events';
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AddTaskInput,
  AppSettings,
  DriveFileRef,
  HeaderMap,
  TaskStatus,
  TaskView
} from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/types';
import { configureEngineNetwork } from './net-resilience';
import {
  THREAD_LIMITS,
  describeClamp,
  detectRuntimePlatform,
  resolveThreads,
  type RuntimePlatform,
  type ThreadResolution
} from '../../shared/thread-policy';
import { platformById, platformForUrl } from '../platforms';
import type { DriveContext, DriveAdapter } from '../drives/types';
import { resolveLink } from '../resolvers';
import { DownloadTask, fileNameFromUrl } from './task';
import { Semaphore, sanitizeFileName } from './util';
import { assertUsableDirectory, ensureDir, resolvePartsRoot } from './workdir';

/** Append a line to `<dataDir>/tasks.log` without blocking the caller. */
async function logLine(dataDir: string, message: string): Promise<void> {
  try {
    const line = `${new Date().toISOString()} [manager] ${message}\n`;
    await fsp.appendFile(path.join(dataDir, 'tasks.log'), line, 'utf8');
  } catch {
    /* logging must never break a download */
  }
}

interface PersistedTask {
  id: string;
  url: string;
  fileName: string;
  directory: string;
  platformId: string;
  headers: HeaderMap;
  threads: number;
  status: TaskStatus;
  totalBytes: number;
  downloadedBytes: number;
  createdAt: number;
  error?: string;
  driveRef?: DriveFileRef;
}

export interface ManagerOptions {
  dataDir: string;
  defaultDirectory: string;
  /**
   * Returns a serialized `Cookie` header for a platform the user has logged in
   * to. Injected only when the task does not carry its own Cookie, so a manual
   * value always wins.
   */
  cookieProvider?: (platformId: string) => string | undefined;
  /**
   * Full drive session for a platform. When a task carries a driveRef and its
   * link expires, the manager mints a fresh one through the adapter instead of
   * leaving the task dead.
   */
  driveContext?: (platformId: string) => DriveContext | null;
  /** Adapter resolver; injectable so tests can stub the drive layer. */
  adapterFor?: (platformId: string) => DriveAdapter | undefined;
  /** Delay before an automatic link re-mint + resume. */
  autoRefreshDelayMs?: number;
  /** App-bundled Mozilla CA bundle, wired into every engine TLS socket. */
  caBundlePath?: string;
}

const ACTIVE: TaskStatus[] = ['probing', 'downloading', 'merging'];

export class DownloadManager extends EventEmitter {
  private readonly tasks = new Map<string, DownloadTask>();
  private readonly runtime: RuntimePlatform = detectRuntimePlatform(process.platform);
  private settings: AppSettings;
  private semaphore: Semaphore;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly refreshAttempts = new Map<string, number>();
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly options: ManagerOptions) {
    super();
    this.settings = { ...DEFAULT_SETTINGS, downloadDirectory: options.defaultDirectory };
    this.semaphore = new Semaphore(this.settings.maxInflightChunks);
  }

  async init(): Promise<void> {
    await ensureDir(this.options.dataDir);
    await this.loadSettings();
    await this.loadTasks();
    configureEngineNetwork({
      proxyUrl: this.settings.proxyUrl,
      caBundlePath: this.options.caBundlePath
    });
    if (this.settings.autoResumeOnLaunch) this.pump();
  }

  getSettings(): AppSettings {
    return { ...this.settings };
  }

  /**
   * Thread policy surfaced to the UI so the slider can stop at the real
   * ceiling instead of guessing. `max` is the runtime ceiling; a specific
   * platform can be lower (Xunlei), which the dialog applies per task.
   */
  getThreadPolicy(): { runtime: RuntimePlatform; min: number; max: number; default: number } {
    return {
      runtime: this.runtime,
      min: 1,
      max: THREAD_LIMITS[this.runtime].max,
      default: THREAD_LIMITS[this.runtime].default
    };
  }

  /** Validate a thread count against runtime + platform ceilings. */
  resolveThreads(requested: unknown, platformCap?: number | null): ThreadResolution {
    return resolveThreads({
      requested,
      runtime: this.runtime,
      platformCap,
      fallback: this.settings.defaultThreads
    });
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    // Validate the directory field on its own. Throwing here used to discard the
    // *whole* patch, so one unusable path silently reverted every other
    // preference the user had just changed.
    let applied: Partial<AppSettings> = { ...patch };
    if (typeof patch.downloadDirectory === 'string') {
      const candidate = patch.downloadDirectory.trim();
      let usable = candidate.length > 0;
      if (usable) {
        usable = await assertUsableDirectory(candidate).then(
          () => true,
          () => false
        );
      }
      // Keep the previous directory when the new one cannot receive files; the
      // renderer notices the difference and explains it.
      applied.downloadDirectory = usable ? candidate : this.settings.downloadDirectory;
    }
    this.settings = { ...this.settings, ...applied };
    // The settings file is user-editable JSON: clamp everything on the way in.
    this.settings.defaultThreads = this.resolveThreads(this.settings.defaultThreads).effective;
    this.settings.maxConcurrentTasks = clamp(this.settings.maxConcurrentTasks, 1, 8);
    this.settings.maxInflightChunks = clamp(this.settings.maxInflightChunks, 8, THREAD_LIMITS[this.runtime].max);
    this.settings.speedLimitBps = Math.max(0, this.settings.speedLimitBps || 0);
    this.semaphore.setCapacity(this.settings.maxInflightChunks);
    configureEngineNetwork({
      proxyUrl: this.settings.proxyUrl,
      caBundlePath: this.options.caBundlePath
    });
    for (const task of this.tasks.values()) {
      if (ACTIVE.includes(task.status)) task.setSpeedLimit(this.settings.speedLimitBps);
    }
    await this.saveSettings();
    this.emit('settings', this.getSettings());
    this.emitUpdate();
    return this.getSettings();
  }

  list(): TaskView[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt).map((t) => t.toView());
  }

  get(id: string): DownloadTask | undefined {
    return this.tasks.get(id);
  }

  async add(input: AddTaskInput): Promise<TaskView> {
    if (!input.url || !input.url.trim()) throw new Error('请填写下载地址');
    const resolved = await resolveLink(input.url.trim(), input.headers);
    // Drive adapters know which platform a direct link belongs to (CDN hosts do
    // not always match), so an explicit platformId wins over URL sniffing.
    const profile = input.platformId
      ? platformById(input.platformId)
      : resolved.platformId
        ? platformById(resolved.platformId)
        : platformForUrl(resolved.url);
    let directory = input.directory || this.settings.downloadDirectory || this.options.defaultDirectory;
    // The chosen directory can be un-writable even though it looks normal: a
    // removable drive root, an ACL that allows listing but denies creation, or a
    // sandboxed host process. Losing the whole download over that is pointless,
    // so fall through to somewhere that certainly works and say so loudly.
    let directoryNote = '';
    try {
      await assertUsableDirectory(directory);
    } catch (error) {
      const fallback = path.join(this.options.dataDir, 'downloads');
      await assertUsableDirectory(fallback);
      directoryNote =
        `下载目录 ${directory} 不可写（${(error as Error).message}），本次改存到 ${fallback}。` +
        '请改用其他文件夹，或以管理员身份运行本程序。';
      await logLine(this.options.dataDir, `fallback dir ${directory} -> ${fallback}`);
      directory = fallback;
    }

    const headers: HeaderMap = { ...(resolved.headers ?? {}) };
    let usedAccountCookie = false;
    if (!headers.Cookie && !headers.cookie) {
      const autoCookie = this.options.cookieProvider?.(profile.id);
      if (autoCookie) {
        headers.Cookie = autoCookie;
        usedAccountCookie = true;
      }
    }

    const fileName = sanitizeFileName(input.fileName || resolved.fileName || fileNameFromUrl(resolved.url));
    // One gate for every entry point (dialog, IPC, restored tasks): invalid
    // numbers fall back, oversized ones are truncated, platform ceilings win.
    const decision = this.resolveThreads(
      input.threads ?? profile.defaultThreads,
      profile.maxRangeWorkers
    );
    const threads = decision.effective;

    const taskId = randomUUID();
    // Resolve where the piece files go *before* the task exists: destinations
    // that refuse directory creation (locked-down drive roots) fall back to the
    // app's data directory instead of failing the download later.
    let parts: { dir: string; note?: string };
    try {
      parts = await resolvePartsRoot(directory, taskId, path.join(this.options.dataDir, 'parts'));
    } catch (error) {
      throw new Error(`无法创建临时分片目录：${(error as Error).message}`);
    }

    const task = new DownloadTask({
      id: taskId,
      url: resolved.url,
      fileName,
      directory,
      platformId: profile.id,
      headers,
      threads,
      maxRangeWorkers: profile.maxRangeWorkers,
      speedLimitBps: this.settings.speedLimitBps,
      slowConnectionPreempt: this.settings.slowConnectionPreempt,
      semaphore: this.semaphore,
      partsRoot: parts.dir,
      partsFallback: path.join(this.options.dataDir, 'parts'),
      driveRef: input.driveRef
    });

    this.attach(task);
    this.tasks.set(task.id, task);
    this.emit('log', {
      taskId: task.id,
      level: 'info',
      message: `已添加任务：${fileName}（${profile.name}, ${threads} 连接）`
    });
    if (directoryNote) {
      this.emit('log', { taskId: task.id, level: 'warn', message: directoryNote });
    }
    if (parts.note) {
      this.emit('log', { taskId: task.id, level: 'warn', message: parts.note });
    }
    if (usedAccountCookie) {
      this.emit('log', {
        taskId: task.id,
        level: 'info',
        message: `已附带 ${profile.name} 的登录 Cookie（来自「网盘账号」）`
      });
    }
    const clampNote = describeClamp(decision);
    if (clampNote) {
      this.emit('log', { taskId: task.id, level: 'warn', message: `并发数已调整：${clampNote}` });
    }
    // Creation and removal are rare and must survive an immediate quit: the
    // debounced writer lost them whenever the process ended within a second.
    await this.saveTasks();
    this.emitUpdate();
    this.pump();
    return task.toView();
  }

  pause(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.pause();
    this.emitUpdate();
  }

  resume(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    if (task.status === 'completed') return;
    task.setSpeedLimit(this.settings.speedLimitBps);
    void task.start();
    this.emitUpdate();
  }

  async retry(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) return;
    task.error = undefined;
    // Drive links are short-lived: mint a fresh one instead of resuming into a
    // URL that will fail again.
    if (task.driveRef) {
      try {
        const minted = await this.remintLink(task);
        if (minted) {
          this.emit('log', { taskId: task.id, level: 'info', message: '已重新获取下载地址' });
        }
      } catch (error) {
        this.emit('log', {
          taskId: task.id,
          level: 'error',
          message: `重新获取下载地址失败：${(error as Error).message}`
        });
      }
    }
    this.resume(id);
  }

  async remove(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) return;
    this.tasks.delete(id);
    await task.cancel();
    task.removeAllListeners();
    await this.saveTasks();
    this.emitUpdate();
    this.pump();
  }

  shutdown(): void {
    for (const task of this.tasks.values()) task.pause();
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    // Flush synchronously: shutdown runs from `before-quit`, after which an
    // async write has no guarantee of completing.
    this.saveTasksSync();
  }

  // ---------------------------------------------------------------- internals

  /**
   * Mint a fresh download URL for a drive task. Returns false when the task is
   * not a drive task or the session is gone.
   */
  private async remintLink(task: DownloadTask): Promise<boolean> {
    const ref = task.driveRef;
    if (!ref) return false;
    const context = this.options.driveContext?.(ref.platformId);
    const adapter = this.options.adapterFor?.(ref.platformId);
    if (!context || !adapter) return false;
    const link = await adapter.link(context, {
      id: ref.fileId,
      name: task.fileName,
      size: task.totalBytes,
      isDir: false,
      parentId: ''
    });
    task.applyLink({ url: link.url, headers: link.headers });
    return true;
  }

  /** One automatic re-mint + resume after a failure that looks like a dead link. */
  private scheduleAutoRefresh(task: DownloadTask, reason: string): void {
    const attempts = this.refreshAttempts.get(task.id) ?? 0;
    if (attempts >= 2) return;
    if (this.refreshTimers.has(task.id)) return;
    this.refreshAttempts.set(task.id, attempts + 1);
    const delay = Math.max(0, this.options.autoRefreshDelayMs ?? 3_000);
    const timer = setTimeout(() => {
      this.refreshTimers.delete(task.id);
      void (async () => {
        try {
          const minted = await this.remintLink(task);
          if (!minted) return;
          this.emit('log', {
            taskId: task.id,
            level: 'info',
            message: `链接已失效（${reason}），已重新获取并继续下载`
          });
          task.error = undefined;
          this.resume(task.id);
        } catch (error) {
          this.emit('log', {
            taskId: task.id,
            level: 'error',
            message: `重新获取下载地址失败：${(error as Error).message}`
          });
        }
      })();
    }, delay);
    this.refreshTimers.set(task.id, timer);
  }

  private attach(task: DownloadTask): void {
    let lastReportedError = '';
    task.on('change', () => {
      // Every failure is recorded once, with its original message: a later
      // retry overwrites `task.error`, which used to hide the first cause.
      if (task.status === 'failed' && task.error && task.error !== lastReportedError) {
        lastReportedError = task.error;
        this.emit('log', {
          taskId: task.id,
          level: 'error',
          message: `下载失败：${task.error}（目录 ${task.directory}，${task.threads} 连接）`
        });
        // Drive links expire; a fresh URL usually puts the task back on track.
        if (task.driveRef && /40[134]|410|过期|失效/i.test(task.error)) {
          this.scheduleAutoRefresh(task, task.error);
        }
      }
      this.emitUpdate();
      this.persistSoon();
    });
    task.on('log', (entry) => this.emit('log', entry));
    task.on('settled', () => {
      this.persistSoon();
      this.emitUpdate();
      this.pump();
    });
  }

  private pump(): void {
    const running = [...this.tasks.values()].filter((t) => t.isRunning).length;
    const slots = Math.max(0, this.settings.maxConcurrentTasks - running);
    if (slots <= 0) return;
    const queued = [...this.tasks.values()]
      .filter((t) => t.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, slots);
    for (const task of queued) {
      void task.start();
    }
  }

  private emitUpdate(): void {
    if (this.broadcastTimer) return;
    // Coalesce: a task with 64 live connections emits far more often than a
    // 60 fps UI can use, and every snapshot crosses the IPC boundary.
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.emit('update', this.list());
    }, 250);
  }

  private persistSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveTasks();
    }, 1_000);
  }

  private records(): PersistedTask[] {
    return [...this.tasks.values()].map((task) => ({
      id: task.id,
      url: task.url,
      fileName: task.fileName,
      directory: task.directory,
      platformId: task.platformId,
      headers: task.headers,
      threads: task.threads,
      status: task.status,
      totalBytes: task.totalBytes,
      downloadedBytes: task.downloadedBytes,
      createdAt: task.createdAt,
      error: task.error
    }));
  }

  private async saveTasks(): Promise<void> {
    const file = path.join(this.options.dataDir, 'tasks.json');
    await fsp.writeFile(file, JSON.stringify(this.records(), null, 2)).catch(() => undefined);
  }

  private saveTasksSync(): void {
    try {
      const file = path.join(this.options.dataDir, 'tasks.json');
      fsSync.writeFileSync(file, JSON.stringify(this.records(), null, 2));
    } catch {
      /* losing the index must never block quitting */
    }
  }

  private async loadTasks(): Promise<void> {
    const file = path.join(this.options.dataDir, 'tasks.json');
    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      return;
    }
    let parsed: PersistedTask[];
    try {
      parsed = JSON.parse(raw) as PersistedTask[];
    } catch {
      return;
    }
    for (const record of parsed) {
      const profile = platformById(record.platformId);
      // tasks.json can be edited by hand; never trust its thread count.
      const restoredThreads = this.resolveThreads(record.threads, profile.maxRangeWorkers).effective;
      const task = new DownloadTask({
        id: record.id,
        url: record.url,
        fileName: record.fileName,
        directory: record.directory,
        platformId: record.platformId,
        headers: record.headers ?? {},
        threads: restoredThreads,
        maxRangeWorkers: profile.maxRangeWorkers,
        speedLimitBps: this.settings.speedLimitBps,
        slowConnectionPreempt: this.settings.slowConnectionPreempt,
        semaphore: this.semaphore,
        // Restored tasks resolve lazily, with the same fallback.
        partsFallback: path.join(this.options.dataDir, 'parts'),
        driveRef: record.driveRef
      });
      task.totalBytes = record.totalBytes ?? 0;
      task.downloadedBytes = record.downloadedBytes ?? 0;
      // A task that was mid-flight when the app closed cannot be "downloading"
      // any more; keeping it there would also block the queue forever.
      task.status = record.status === 'completed' || record.status === 'canceled' || record.status === 'failed'
        ? record.status
        : 'paused';
      task.error = record.error;
      this.attach(task);
      this.tasks.set(task.id, task);
    }
  }

  private async loadSettings(): Promise<void> {
    const file = path.join(this.options.dataDir, 'settings.json');
    try {
      const raw = await fsp.readFile(file, 'utf8');
      this.settings = { ...this.settings, ...(JSON.parse(raw) as Partial<AppSettings>) };
    } catch {
      /* first run */
    }
    if (!this.settings.downloadDirectory) this.settings.downloadDirectory = this.options.defaultDirectory;
    this.settings.maxInflightChunks = clamp(this.settings.maxInflightChunks, 8, THREAD_LIMITS[this.runtime].max);
    this.semaphore.setCapacity(this.settings.maxInflightChunks);
  }

  private async saveSettings(): Promise<void> {
    const file = path.join(this.options.dataDir, 'settings.json');
    // No silent catch: a failed write must reach the UI as "保存失败" instead of
    // looking like a successful save that later disappears.
    await fsp.writeFile(file, JSON.stringify(this.settings, null, 2));
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
