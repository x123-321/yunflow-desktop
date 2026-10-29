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

export const MIN_CHUNK_BYTES = 256 * 1024;
/** Hard ceiling for concurrent Range connections, mirroring YunX. */
export const MAX_THREADS = 512;
export const MAX_CHUNK_COUNT = 512;

export interface ChunkPlan {
  total: number;
  threads: number;
  chunkCount: number;
  chunkSize: number;
  /** Fixed-size prefix of the file, split evenly and claimed by index. */
  mainCount: number;
  /** Byte offset where the dynamic (IDM style) region starts. */
  elasticStart: number;
}

/**
 * How many pieces a file should be cut into.
 *
 * The piece count is deliberately several times larger than the number of
 * workers ("surplus pieces"): when one connection crawls, its worker can pick
 * up an untouched piece instead of idling behind it. This is what removes the
 * long tail where only the last few connections are still busy.
 */
export function chunkCountFor(total: number, threads: number): number {
  if (total <= 0) return 1;
  // Baseline by size; `want` below can still raise it so that small files get
  // several pieces per worker (the `total / MIN_CHUNK_BYTES` clamp keeps the
  // pieces from getting too small).
  const bySize = total < 5 * 1024 * 1024 ? 1 : total < 50 * 1024 * 1024 ? 8 : total < 500 * 1024 * 1024 ? 32 : 64;
  const want = Math.max(bySize, threads * 8);
  const byMinimum = Math.floor(total / MIN_CHUNK_BYTES);
  return Math.min(want, Math.max(1, byMinimum), MAX_CHUNK_COUNT);
}

/**
 * Fixed plan for a task: 70% of the pieces are equal-sized and claimed by
 * index, the trailing 30% is handed out by the elastic allocator so that fast
 * workers can absorb the tail.
 */
export function planChunks(total: number, threads: number): ChunkPlan {
  // Matches the reference project's 512-connection ceiling. The manager has
  // already validated the value; this is the last line of defence.
  const threadCount = Math.max(1, Math.min(MAX_THREADS, Math.floor(threads) || 1));
  const chunkCount = chunkCountFor(total, threadCount);
  const chunkSize = Math.ceil(total / chunkCount);
  const mainCount = Math.max(1, Math.min(chunkCount, Math.round(chunkCount * 0.7)));
  return {
    total,
    threads: threadCount,
    chunkCount,
    chunkSize,
    mainCount,
    elasticStart: mainCount * chunkSize
  };
}

/**
 * Resume safety: part files are named by index and their byte ranges are
 * derived from the plan. If the plan changes (different thread count, different
 * file size) the old parts describe different ranges and must be discarded,
 * otherwise the merged file would be silently corrupt.
 */
export function planSignature(plan: ChunkPlan): string {
  return `v1;chunks=${plan.chunkCount};total=${plan.total};main=${plan.mainCount};size=${plan.chunkSize}`;
}
