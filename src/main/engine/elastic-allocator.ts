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

export const MIN_ELASTIC_BLOCK = 256 * 1024;
export const MAX_ELASTIC_BLOCK = 4 * 1024 * 1024;
export const MIN_TAIL_BLOCK = 64 * 1024;
/** A block should represent roughly this many seconds of one worker's throughput. */
export const TARGET_SECONDS = 5;

export interface ElasticBlock {
  start: number;
  end: number;
}

/**
 * Dynamic block allocator for the trailing region of a file (IDM style).
 *
 * Two problems are solved at once:
 *  - Fixed blocks leave a big final block to a single connection, so the last
 *    few megabytes crawl while every other worker sits idle ("tail collapse").
 *  - Tiny blocks multiply Range round-trips and slow fast connections down.
 *
 * Blocks are handed out in byte order (adjacent ranges keep connection reuse
 * friendly) with a size that follows measured throughput and shrinks near the
 * end so all connections finish together.
 */
export class ElasticAllocator {
  private nextStart: number;
  private speedBps = 0;

  constructor(
    private readonly total: number,
    elasticStart: number,
    private readonly workers: number,
    private readonly baseChunkSize: number
  ) {
    this.nextStart = Math.min(elasticStart, total);
  }

  /** Called with the task's latest measured throughput. */
  reportSpeed(bytesPerSecond: number): void {
    if (Number.isFinite(bytesPerSecond) && bytesPerSecond > 0) this.speedBps = bytesPerSecond;
  }

  /** Skip the already-finished prefix when resuming. */
  skipTo(offset: number): void {
    if (offset > this.nextStart) this.nextStart = Math.min(offset, this.total);
  }

  get cursor(): number {
    return this.nextStart;
  }

  take(): ElasticBlock | null {
    if (this.nextStart >= this.total) return null;
    const remaining = this.total - this.nextStart;
    const workers = Math.max(1, this.workers);
    const base = this.baseBlockSize();
    const block = remaining <= workers * base
      ? Math.min(Math.max(Math.floor(remaining / workers), MIN_TAIL_BLOCK), base)
      : base;
    const start = this.nextStart;
    const end = Math.min(start + block, this.total) - 1;
    this.nextStart = end + 1;
    return { start, end };
  }

  private baseBlockSize(): number {
    const perWorker = this.speedBps > 0 ? this.speedBps / Math.max(1, this.workers) : 0;
    if (perWorker <= 0) {
      return Math.min(Math.max(this.baseChunkSize, MIN_ELASTIC_BLOCK), MAX_ELASTIC_BLOCK);
    }
    return Math.min(Math.max(Math.floor(perWorker * TARGET_SECONDS), MIN_ELASTIC_BLOCK), MAX_ELASTIC_BLOCK);
  }
}
