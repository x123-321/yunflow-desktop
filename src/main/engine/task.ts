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
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ChunkKind, ChunkState, ChunkView, DriveFileRef, HeaderMap, TaskStatus, TaskView } from '../../shared/types';
import { MAX_THREADS, planChunks, planSignature, type ChunkPlan } from './chunk-plan';
import { downloadChunk } from './chunk-downloader';
import { ElasticAllocator } from './elastic-allocator';
import { LinkExpiredError, isHtmlResponse, probeResource, requestStream } from './http';
import {
  DEFAULT_PREEMPT_TUNING,
  PREEMPT_TICK_MS,
  shouldPreempt,
  type PreemptTuning
} from './speed-watchdog';
import { AbortError, Semaphore, TokenBucket, isAbortError, sleep, throwIfAborted } from './util';
import {
  clearDir,
  ensureDir,
  fileSize,
  partsDir,
  readPlan,
  resolvePartsRoot,
  uniqueTargetPath,
  writePlan
} from './workdir';

const MAX_CHUNK_ATTEMPTS = 3;
const MAX_REATTACH = 8;
const RANGE_IGNORED_TOLERANCE = 3;

export interface TaskOptions {
  id: string;
  url: string;
  fileName: string;
  directory: string;
  platformId: string;
  headers: HeaderMap;
  threads: number;
  maxRangeWorkers?: number;
  speedLimitBps?: number;
  slowConnectionPreempt?: boolean;
  semaphore: Semaphore;
  preemptTuning?: Partial<PreemptTuning>;
  bufferSize?: number;
  /** Resolved piece directory (see workdir.resolvePartsRoot). */
  partsRoot?: string;
  /** Where to put pieces if the download directory refuses them. */
  partsFallback?: string;
  /** Drive file identity, enabling automatic link re-minting on expiry. */
  driveRef?: DriveFileRef;
  /** Progress sampling cadence; tests use a shorter interval. */
  sampleIntervalMs?: number;
  /** How often the preemption policy runs. */
  preemptTickMs?: number;
}

interface ChunkRuntime {
  key: string;
  index: number;
  start: number;
  end: number;
  partFile: string;
  kind: ChunkKind;
  received: number;
  state: ChunkState;
  bps: number;
  preemptCount: number;
  attempts: number;
  reattach: number;
  lastBytes: number;
  lastSampleAt: number;
  lastProgressAt: number;
  lastPreemptAt: number;
  startedAt: number;
  worker: number;
  digest?: string;
  controller: AbortController | null;
}

export class DownloadTask extends EventEmitter {
  readonly id: string;
  /** Mutable: drive adapters mint fresh URLs when the previous one expires. */
  url: string;
  readonly platformId: string;
  readonly driveRef?: DriveFileRef;
  headers: HeaderMap;
  readonly createdAt = Date.now();

  fileName: string;
  directory: string;
  threads: number;
  status: TaskStatus = 'queued';
  totalBytes = 0;
  downloadedBytes = 0;
  speedBps = 0;
  activeConnections = 0;
  preemptCount = 0;
  retryCount = 0;
  chunkCount = 0;
  supportsRange = false;
  singleStream = false;
  error?: string;
  finishedAt?: number;

  private finalUrl: string;
  private plan: ChunkPlan | null = null;
  private chunks = new Map<string, ChunkRuntime>();
  private allocator: ElasticAllocator | null = null;
  private partsRoot: string;
  private partsFallback?: string;
  private failed: ChunkRuntime[] = [];
  private mainCursor = 0;
  private controller: AbortController | null = null;
  private running = false;
  private stopping = false;
  private canceled = false;
  private fallback = false;
  private rangeIgnored = 0;
  private sampler: NodeJS.Timeout | null = null;
  private lastTotalBytes = 0;
  private lastTotalAt = Date.now();
  private bucket: TokenBucket | null = null;
  private tuning: PreemptTuning;
  private readonly sem: Semaphore;
  private readonly maxWorkers: number;
  private readonly bufferSize: number;
  private readonly preemptEnabled: boolean;
  private readonly sampleIntervalMs: number;
  private readonly preemptTickMs: number;
  private lastWatchdogAt = 0;

  constructor(options: TaskOptions) {
    super();
    this.id = options.id;
    this.url = options.url;
    this.finalUrl = options.url;
    this.fileName = options.fileName;
    this.directory = options.directory;
    this.platformId = options.platformId;
    this.driveRef = options.driveRef;
    this.headers = options.headers;
    this.threads = options.threads;
    this.sem = options.semaphore;
    this.bufferSize = options.bufferSize ?? 64 * 1024;
    this.preemptEnabled = options.slowConnectionPreempt ?? true;
    this.tuning = { ...DEFAULT_PREEMPT_TUNING, ...options.preemptTuning };
    this.sampleIntervalMs = Math.max(50, options.sampleIntervalMs ?? 1_000);
    this.preemptTickMs = Math.max(this.sampleIntervalMs, options.preemptTickMs ?? PREEMPT_TICK_MS);
    this.maxWorkers = Math.max(1, Math.min(options.maxRangeWorkers ?? MAX_THREADS, MAX_THREADS));
    this.partsRoot = options.partsRoot ?? '';
    this.partsFallback = options.partsFallback;
    if (options.speedLimitBps && options.speedLimitBps > 0) {
      this.bucket = new TokenBucket(options.speedLimitBps);
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isFinished(): boolean {
    return this.status === 'completed' || this.status === 'failed' || this.status === 'canceled';
  }

  setSpeedLimit(bytesPerSecond: number): void {
    if (bytesPerSecond > 0) {
      if (this.bucket) this.bucket.setRate(bytesPerSecond);
      else this.bucket = new TokenBucket(bytesPerSecond);
    } else {
      this.bucket?.dispose();
      this.bucket = null;
    }
  }

  async start(): Promise<void> {
    if (this.running || this.status === 'completed') return;
    this.running = true;
    this.stopping = false;
    this.canceled = false;
    this.error = undefined;
    this.controller = new AbortController();
    this.lastTotalAt = Date.now();
    this.lastTotalBytes = this.downloadedBytes;

    try {
      this.setStatus('probing');
      await this.probe();
      throwIfAborted(this.controller.signal);
      if (!this.supportsRange || this.totalBytes <= 0) {
        await this.downloadSingleStream();
      } else {
        await this.downloadRanged();
      }
    } catch (error) {
      if (this.canceled) {
        this.setStatus('canceled');
        this.finishedAt = Date.now();
      } else if (isAbortError(error) || this.controller.signal.aborted) {
        this.setStatus('paused');
      } else {
        this.error = (error as Error).message || '下载失败';
        this.setStatus('failed');
        this.finishedAt = Date.now();
      }
    } finally {
      this.stopSampler();
      this.running = false;
      this.activeConnections = 0;
      this.speedBps = 0;
      this.controller = null;
      this.emit('settled');
      this.emit('change');
    }
  }

  pause(): void {
    this.stopping = true;
    this.controller?.abort();
    if (this.status === 'queued') this.setStatus('paused');
  }

  async cancel(): Promise<void> {
    this.canceled = true;
    this.stopping = true;
    this.controller?.abort();
    this.stopSampler();
    if (this.running) {
      // Wait for the workers to drop their file handles before deleting the
      // part files: on Windows an open handle makes the directory undeletable
      // and would leave orphaned pieces behind.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        this.once('settled', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    // Delete, do not recreate: `clearDir` re-creates the folder, which left an
    // empty task directory behind on every cancellation.
    await fsp.rm(this.partsRoot || partsDir(this.directory, this.id), { recursive: true, force: true }).catch(() => undefined);
    if (!this.running) this.setStatus('canceled');
    this.finishedAt = Date.now();
  }

  toView(): TaskView {
    const chunks: ChunkView[] = [];
    const ordered = [...this.chunks.values()].sort((a, b) => a.start - b.start);
    const limit = 512;
    const step = Math.max(1, Math.ceil(ordered.length / limit));
    for (let i = 0; i < ordered.length; i += step) {
      const chunk = ordered[i];
      chunks.push({
        index: chunk.index,
        start: chunk.start,
        end: chunk.end,
        received: chunk.received,
        state: chunk.state,
        bps: Math.round(chunk.bps),
        preemptCount: chunk.preemptCount,
        kind: chunk.kind,
        worker: chunk.worker
      });
    }
    return {
      id: this.id,
      url: this.url,
      fileName: this.fileName,
      directory: this.directory,
      platformId: this.platformId,
      driveRef: this.driveRef,
      status: this.status,
      totalBytes: this.totalBytes,
      downloadedBytes: Math.min(this.downloadedBytes, this.totalBytes || Number.MAX_SAFE_INTEGER),
      speedBps: Math.round(this.speedBps),
      etaSeconds: this.speedBps > 1 && this.totalBytes > 0
        ? Math.max(0, Math.round((this.totalBytes - this.downloadedBytes) / this.speedBps))
        : -1,
      threads: this.threads,
      activeConnections: this.activeConnections,
      chunkCount: this.plan?.chunkCount ?? 0,
      preemptCount: this.preemptCount,
      retryCount: this.retryCount,
      supportsRange: this.supportsRange,
      singleStream: this.singleStream,
      error: this.error,
      createdAt: this.createdAt,
      finishedAt: this.finishedAt,
      chunks
    };
  }

  // ------------------------------------------------------------------ probe

  private async probe(): Promise<void> {
    const probe = await probeResource(this.url, {
      headers: this.headers,
      signal: this.controller?.signal
    });
    this.finalUrl = probe.finalUrl;
    this.supportsRange = probe.supportsRange;
    this.totalBytes = probe.total;
    this.singleStream = !probe.supportsRange || probe.total <= 0;
    if (!this.fileName) {
      this.fileName = probe.fileName || fileNameFromUrl(probe.finalUrl);
    }
    this.emit('change');
  }

  // ------------------------------------------------------------- ranged mode

  private async downloadRanged(): Promise<void> {
    const plan = await this.ensurePlan();
    this.setStatus('downloading');
    this.startSampler();

    const workers = Math.max(1, Math.min(this.threads, this.maxWorkers));
    // A new run starts a new claim sequence; otherwise a resumed task would
    // skip every fixed piece that a previous run had already claimed.
    this.mainCursor = 0;
    await this.prepareElasticResume(workers);
    await Promise.all(Array.from({ length: workers }, (_, index) => this.workerLoop(index)));

    // Late failures / preemptions can be appended after the last worker has
    // drained the retry queue; finish them here so the task cannot stall.
    while (this.failed.length > 0 && !this.stopping && !this.fallback) {
      const chunk = this.failed.shift()!;
      if (chunk.attempts >= MAX_CHUNK_ATTEMPTS) continue;
      await this.executeChunk(chunk, -1);
    }

    throwIfAborted(this.controller!.signal);
    if (this.fallback) {
      await this.downloadSingleStream();
      return;
    }
    if (this.stopping) {
      this.setStatus('paused');
      return;
    }

    const unfinished = [...this.chunks.values()].filter((c) => c.state !== 'done');
    if (unfinished.length > 0) {
      const missing = unfinished.reduce((sum, c) => sum + (c.end - c.start + 1 - c.received), 0);
      throw new Error(`有 ${unfinished.length} 个分片未能完成（剩余 ${missing} 字节），可稍后继续`);
    }
    await this.mergeRanged(plan);
  }

  /**
   * Piece files normally live next to the download. When the destination
   * refuses directory creation (EPERM on a locked-down drive root — the reason
   * downloads failed with a null-allocator crash) fall back to the app's data
   * directory rather than failing the task.
   */
  /**
   * Swap in a freshly minted URL from a drive adapter. Finished pieces stay
   * valid because the underlying file is the same; the plan signature depends
   * only on the size, which does not change.
   */
  applyLink(next: { url: string; headers?: HeaderMap }): void {
    if (!next.url) return;
    this.url = next.url;
    this.finalUrl = next.url;
    if (next.headers && Object.keys(next.headers).length > 0) this.headers = next.headers;
    this.error = undefined;
    this.emit('change');
  }

  private async ensurePartsRoot(): Promise<string> {
    if (this.partsRoot) return this.partsRoot;
    const resolved = await resolvePartsRoot(this.directory, this.id, this.partsFallback);
    this.partsRoot = resolved.dir;
    if (resolved.note) {
      this.emit('log', { taskId: this.id, level: 'warn', message: resolved.note });
    }
    return resolved.dir;
  }

  private async ensurePlan(): Promise<ChunkPlan> {
    if (this.plan) {
      // A previous attempt can have cached the plan and then failed while the
      // on-disk scaffolding was still being created, leaving no allocator. A
      // retry used to hit `this.allocator!.take()` and die with a null deref,
      // hiding the real error. Rebuild whatever is missing.
      if (!this.allocator) {
        this.allocator = new ElasticAllocator(
          this.plan.total,
          this.plan.elasticStart,
          Math.min(this.threads, this.maxWorkers),
          this.plan.chunkSize
        );
      }
      return this.plan;
    }
    const plan = planChunks(this.totalBytes, this.threads);

    const dir = await this.ensurePartsRoot();
    const signature = planSignature(plan);
    const previous = await readPlan(dir);
    if (previous && previous !== signature) {
      // Different byte ranges behind the same file names: nothing on disk is trustworthy.
      await clearDir(dir);
    }
    await writePlan(dir, signature);

    // Elastic pieces are allocated dynamically, so their boundaries cannot be
    // reconstructed after a restart. Drop them; they are at most one block each
    // and the main pool (70% of the file) is preserved.
    if (!this.allocator) {
      for (const name of await fsp.readdir(dir)) {
        if (name.startsWith('e') && name.endsWith('.part')) {
          await fsp.rm(path.join(dir, name), { force: true });
        }
      }
    }

    let completed = 0;
    for (let i = 0; i < plan.mainCount; i += 1) {
      const start = i * plan.chunkSize;
      const end = Math.min(start + plan.chunkSize - 1, plan.total - 1);
      const expected = end - start + 1;
      const file = path.join(dir, `m${i}.part`);
      const onDisk = Math.min(await fileSize(file), expected);
      const chunk = this.createChunk(`m${i}`, i, start, end, file, 'main', onDisk);
      this.chunks.set(chunk.key, chunk);
      completed += onDisk;
    }
    this.downloadedBytes = completed;
    this.lastTotalBytes = completed;
    if (!this.allocator) {
      this.allocator = new ElasticAllocator(plan.total, plan.elasticStart, Math.min(this.threads, this.maxWorkers), plan.chunkSize);
    }
    // Publish the plan only once the scaffolding exists. Assigning it earlier
    // meant a failure here left `plan` set but `allocator` null, so every retry
    // crashed on the null allocator instead of retrying the real work.
    this.plan = plan;
    this.chunkCount = plan.chunkCount;
    this.emit('change');
    return plan;
  }

  /**
   * Elastic pieces have no persistent index: their boundaries only exist in
   * memory, so after a pause the allocator cannot be trusted. Completed pieces
   * form a contiguous prefix from `elasticStart`; everything from the first
   * unfinished piece onward is dropped and re-allocated, which keeps the
   * finished prefix instead of re-downloading it.
   */
  private async prepareElasticResume(workers: number): Promise<void> {
    const plan = this.plan;
    if (!plan) return;
    const elastic = [...this.chunks.values()].filter((c) => c.kind === 'elastic');
    const unfinished = elastic.filter((c) => c.state !== 'done');
    if (unfinished.length === 0) return;

    const resetAt = Math.min(...unfinished.map((c) => c.start));
    for (const chunk of elastic) {
      if (chunk.start < resetAt) continue;
      this.chunks.delete(chunk.key);
      this.downloadedBytes = Math.max(0, this.downloadedBytes - chunk.received);
      // Awaited: the replacement piece reuses the same file name.
      await fsp.rm(chunk.partFile, { force: true });
    }
    this.allocator = new ElasticAllocator(plan.total, resetAt, workers, plan.chunkSize);
  }

  private createChunk(
    key: string,
    index: number,
    start: number,
    end: number,
    partFile: string,
    kind: ChunkKind,
    received: number
  ): ChunkRuntime {
    const size = end - start + 1;
    return {
      key,
      index,
      start,
      end,
      partFile,
      kind,
      received,
      state: received >= size ? 'done' : 'pending',
      bps: 0,
      preemptCount: 0,
      attempts: 0,
      reattach: 0,
      lastBytes: received,
      lastSampleAt: Date.now(),
      lastProgressAt: Date.now(),
      lastPreemptAt: 0,
      startedAt: Date.now(),
      worker: -1,
      controller: null
    };
  }

  private async workerLoop(worker: number): Promise<void> {
    const plan = this.plan!;
    const mainChunks = [...this.chunks.values()].filter((c) => c.kind === 'main').sort((a, b) => a.index - b.index);

    // Phase 1: the fixed prefix, claimed by index. Delaying the first request
    // of each piece by a few ms avoids a burst of simultaneous TLS handshakes.
    for (;;) {
      if (this.stopping || this.fallback) return;
      const order = this.mainCursor;
      this.mainCursor += 1;
      if (order >= mainChunks.length) break;
      const chunk = mainChunks[order];
      if (chunk.state === 'done') continue;
      if (order > 0) await sleep(Math.min(order, 8) * 25, this.controller!.signal);
      await this.executeChunk(chunk, worker);
    }

    // Phase 2: the elastic tail, handed out in byte order.
    for (;;) {
      if (this.stopping || this.fallback) return;
      if (!this.allocator) break;
      const block = this.allocator.take();
      if (!block) break;
      const key = `e${block.start}`;
      const chunk = this.createChunk(
        key,
        plan.mainCount + this.chunks.size,
        block.start,
        block.end,
        path.join(this.partsRoot, `${key}.part`),
        'elastic',
        0
      );
      this.chunks.set(key, chunk);
      await this.executeChunk(chunk, worker);
    }

    // Phase 3: retries, shared by all workers so one bad edge cannot serialize them.
    for (;;) {
      if (this.stopping || this.fallback) return;
      const chunk = this.failed.shift();
      if (!chunk) return;
      if (chunk.attempts >= MAX_CHUNK_ATTEMPTS) continue;
      await sleep(Math.min(400 * chunk.attempts, 2_000), this.controller!.signal);
      await this.executeChunk(chunk, worker);
    }
  }

  private async executeChunk(chunk: ChunkRuntime, worker: number): Promise<void> {
    if (this.stopping) return;
    chunk.state = 'active';
    chunk.worker = worker;
    // Reset per attempt: the preemption grace period must be measured from the
    // moment this connection opened, not from when the piece was planned.
    chunk.startedAt = Date.now();
    chunk.lastBytes = chunk.received;
    chunk.lastSampleAt = Date.now();
    chunk.lastProgressAt = Date.now();
    chunk.controller = new AbortController();

    const release = await this.sem.acquire(this.controller?.signal).catch(() => null);
    if (!release) {
      chunk.state = 'pending';
      chunk.controller = null;
      return;
    }

    try {
      const result = await downloadChunk({
        url: this.finalUrl,
        headers: this.headers,
        partFile: chunk.partFile,
        start: chunk.start,
        end: chunk.end,
        signal: this.controller!.signal,
        preemptSignal: chunk.controller.signal,
        bufferSize: this.bufferSize,
        onBytes: async (bytes) => {
          chunk.received += bytes;
          chunk.lastProgressAt = Date.now();
          this.downloadedBytes += bytes;
          if (this.bucket) await this.bucket.consume(bytes, this.controller!.signal);
        },
        onRetry: (attempt) => {
          this.retryCount += 1;
          this.emit('log', { taskId: this.id, level: 'warn', message: `分片 ${chunk.key} 第 ${attempt} 次重试` });
        }
      });

      if (result.outcome === 'ok') {
        chunk.state = 'done';
        if (result.digest) chunk.digest = result.digest;
      } else if (result.outcome === 'range-ignored') {
        chunk.state = 'pending';
        this.rangeIgnored += 1;
        if (this.rangeIgnored >= RANGE_IGNORED_TOLERANCE) this.fallback = true;
      } else if (result.outcome === 'preempted') {
        chunk.state = 'preempted';
        chunk.reattach += 1;
        if (chunk.reattach <= MAX_REATTACH && !this.stopping) this.failed.push(chunk);
      } else {
        chunk.state = 'failed';
        this.enqueueFailure(chunk);
      }
    } catch (error) {
      if (isAbortError(error)) {
        chunk.state = this.stopping ? 'pending' : 'failed';
        throw error;
      }
      chunk.state = 'failed';
      this.enqueueFailure(chunk);
    } finally {
      chunk.controller = null;
      release();
      this.emit('change');
    }
  }

  private enqueueFailure(chunk: ChunkRuntime): void {
    if (chunk.attempts >= MAX_CHUNK_ATTEMPTS) return;
    chunk.attempts += 1;
    if (!this.failed.includes(chunk)) this.failed.push(chunk);
  }

  // ------------------------------------------------------------ single stream

  private async downloadSingleStream(): Promise<void> {
    this.singleStream = true;
    this.setStatus('downloading');
    this.startSampler();

    const dir = await this.ensurePartsRoot();
    const tempFile = path.join(dir, 'stream.part');
    // A full GET always starts at byte 0: never append to a stale prefix.
    await fsp.rm(tempFile, { force: true });

    const response = await requestStream(this.url, {
      headers: this.headers,
      signal: this.controller!.signal,
      timeoutMs: 60_000
    });
    if (isHtmlResponse(response.headers)) {
      response.stream.destroy();
      throw new LinkExpiredError('链接返回了 HTML 页面，可能已过期，或需要 Referer / Cookie');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.stream.destroy();
      throw new Error(`服务器返回 HTTP ${response.statusCode}`);
    }
    const lengthHeader = response.headers['content-length'];
    const declared = Number(Array.isArray(lengthHeader) ? lengthHeader[0] : lengthHeader);
    if (this.totalBytes <= 0 && Number.isFinite(declared) && declared > 0) {
      this.totalBytes = declared;
    }

    const handle = await fsp.open(tempFile, 'w');
    let written = 0;
    try {
      for await (const raw of response.stream) {
        const buffer = raw as Buffer;
        await handle.write(buffer, 0, buffer.length, written);
        written += buffer.length;
        this.downloadedBytes = written;
        if (this.bucket) await this.bucket.consume(buffer.length, this.controller!.signal);
        if (this.stopping) throw new AbortError();
      }
    } finally {
      await handle.close();
      response.stream.destroy();
    }

    if (this.totalBytes > 0 && written < this.totalBytes) {
      throw new Error(`下载不完整：已收到 ${written} / ${this.totalBytes} 字节`);
    }
    if (this.totalBytes <= 0) this.totalBytes = written;

    const target = await uniqueTargetPath(this.directory, this.fileName);
    await fsp.rename(tempFile, target);
    await fsp.rm(dir, { recursive: true, force: true });
    this.fileName = path.basename(target);
    this.downloadedBytes = written;
    this.setStatus('completed');
    this.finishedAt = Date.now();
  }

  // ------------------------------------------------------------------- merge

  private async mergeRanged(plan: ChunkPlan): Promise<void> {
    this.setStatus('merging');
    const ordered = [...this.chunks.values()].sort((a, b) => a.start - b.start);
    // Reconcile the counter with what is actually on disk: retries and resumed
    // pieces are counted incrementally, and an interrupted attempt must never
    // leave the UI above 100%.
    this.downloadedBytes = Math.min(plan.total, ordered.reduce((sum, c) => sum + c.received, 0));
    let expectedStart = 0;
    for (const chunk of ordered) {
      if (chunk.start !== expectedStart) {
        throw new Error(`分片区间不连续（${chunk.key} 起始 ${chunk.start}，期望 ${expectedStart}）`);
      }
      expectedStart = chunk.end + 1;
    }
    if (expectedStart !== plan.total) {
      throw new Error(`分片总长度 ${expectedStart} 与文件大小 ${plan.total} 不一致`);
    }

    const target = await uniqueTargetPath(this.directory, this.fileName);
    const out = await fsp.open(target, 'w');
    let copied = 0;
    try {
      for (const chunk of ordered) {
        throwIfAborted(this.controller!.signal);
        const expected = chunk.end - chunk.start + 1;
        const hasher = createHash('sha256');
        const input = await fsp.open(chunk.partFile, 'r');
        let read = 0;
        try {
          const buffer = Buffer.allocUnsafe(1024 * 1024);
          for (;;) {
            const { bytesRead } = await input.read(buffer, 0, buffer.length, read);
            if (bytesRead <= 0) break;
            const slice = buffer.subarray(0, bytesRead);
            hasher.update(slice);
            await out.write(slice, 0, bytesRead, copied);
            copied += bytesRead;
            read += bytesRead;
          }
        } finally {
          await input.close();
        }
        if (read !== expected) {
          throw new Error(`分片 ${chunk.key} 长度异常：${read} / ${expected}`);
        }
        if (chunk.digest && hasher.digest('hex') !== chunk.digest) {
          throw new Error(`分片 ${chunk.key} 校验失败，文件可能已损坏`);
        }
        // Free the disk space as soon as the bytes are safely in the target.
        await fsp.rm(chunk.partFile, { force: true });
      }
    } catch (error) {
      await out.close();
      await fsp.rm(target, { force: true });
      throw error;
    }
    await out.close();
    if (this.partsRoot) await fsp.rm(this.partsRoot, { recursive: true, force: true });

    this.fileName = path.basename(target);
    this.downloadedBytes = plan.total;
    this.setStatus('completed');
    this.finishedAt = Date.now();
  }

  // ---------------------------------------------------------------- sampling

  private startSampler(): void {
    if (this.sampler) return;
    this.lastTotalAt = Date.now();
    this.lastTotalBytes = this.downloadedBytes;
    this.sampler = setInterval(() => this.sample(), this.sampleIntervalMs);
  }

  private stopSampler(): void {
    if (this.sampler) clearInterval(this.sampler);
    this.sampler = null;
  }

  private sample(): void {
    const now = Date.now();
    const elapsed = Math.max(0.2, (now - this.lastTotalAt) / 1000);
    const delta = this.downloadedBytes - this.lastTotalBytes;
    const instant = Math.max(0, delta / elapsed);
    this.speedBps = this.speedBps > 0 ? this.speedBps * 0.55 + instant * 0.45 : instant;
    this.lastTotalAt = now;
    this.lastTotalBytes = this.downloadedBytes;

    let active = 0;
    let sum = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.state !== 'active') {
        chunk.bps = 0;
        continue;
      }
      active += 1;
      const chunkElapsed = Math.max(0.2, (now - chunk.lastSampleAt) / 1000);
      chunk.bps = Math.max(0, (chunk.received - chunk.lastBytes) / chunkElapsed);
      chunk.lastBytes = chunk.received;
      chunk.lastSampleAt = now;
      sum += chunk.bps;
    }
    this.activeConnections = active;
    this.allocator?.reportSpeed(this.speedBps);

    if (this.preemptEnabled && now - this.lastWatchdogAt >= this.preemptTickMs) {
      this.lastWatchdogAt = now;
      this.preemptSlowChunks(now, active > 0 ? sum / active : 0);
    }
    this.emit('change');
  }

  private preemptSlowChunks(now: number, averageBps: number): void {
    const candidates = [...this.chunks.values()].filter((c) => c.state === 'active' && c.controller);
    if (candidates.length === 0) return;
    candidates.sort((a, b) => a.bps - b.bps);
    let budget = this.tuning.perTick;
    for (const chunk of candidates) {
      if (budget <= 0) break;
      const remaining = chunk.end - chunk.start + 1 - chunk.received;
      const decide = shouldPreempt(
        {
          bps: chunk.bps,
          ageMs: now - chunk.startedAt,
          idleMs: now - chunk.lastProgressAt,
          remaining,
          preemptCount: chunk.preemptCount,
          msSincePreempt: now - chunk.lastPreemptAt,
          inflight: candidates.length,
          taskAvgPerConnectionBps: averageBps
        },
        this.tuning
      );
      if (!decide) continue;
      chunk.preemptCount += 1;
      chunk.lastPreemptAt = now;
      this.preemptCount += 1;
      budget -= 1;
      // Aborting is what actually works: a flag checked inside the read loop is
      // never reached while the socket is hung on a stalled edge.
      chunk.controller?.abort();
      this.emit('log', {
        taskId: this.id,
        level: 'info',
        message: `分片 ${chunk.key} 连接过慢（${Math.round(chunk.bps / 1024)} KB/s），已换连接续传`
      });
    }
  }

  private setStatus(status: TaskStatus): void {
    this.status = status;
    this.emit('change');
  }
}

export function fileNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const base = decodeURIComponent(path.basename(parsed.pathname));
    if (base && base !== '/' && base.includes('.')) return base;
  } catch {
    /* ignore */
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `download-${stamp}.bin`;
}
