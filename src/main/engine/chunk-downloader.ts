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

import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { HeaderMap } from '../../shared/types';
import {
  HttpStatusError,
  contentRangeMatches,
  isHtmlResponse,
  requestStream
} from './http';
import { isAbortError, sleep, throwIfAborted } from './util';
import { fileSize, hashFilePrefix } from './workdir';

export type ChunkOutcome = 'ok' | 'range-ignored' | 'failed' | 'preempted';

export interface ChunkResult {
  outcome: ChunkOutcome;
  /** Bytes fetched from the network during this call (excludes the resumed prefix). */
  written: number;
  /** SHA-256 of the whole part file (prefix + new bytes) when the part is complete. */
  digest?: string;
}

export interface ChunkDownloadOptions {
  url: string;
  headers: HeaderMap;
  partFile: string;
  /** Inclusive byte range of this piece. */
  start: number;
  end: number;
  /** Task level cancellation (pause / delete). */
  signal: AbortSignal;
  /** Per-connection cancellation raised by the slow-connection watchdog. */
  preemptSignal: AbortSignal;
  bufferSize?: number;
  maxIoRetries?: number;
  onBytes?: (bytes: number) => void | Promise<void>;
  onRetry?: (attempt: number, error: Error) => void;
}

/**
 * Download a single byte range into its own part file.
 *
 * Guarantees, all of which matter for correctness:
 *  - Resume: the request always starts at `start + current part size`, so a
 *    killed connection never re-downloads what is already on disk.
 *  - No holes: a 206 response must match the requested range exactly and the
 *    write loop must produce exactly `end - start + 1` bytes; anything less is
 *    a failure rather than a silently truncated file.
 *  - Never swallow a full body: a 200 answer to a ranged request means the CDN
 *    ignored `Range`; the connection is dropped immediately and reported as
 *    `range-ignored` so the task can fall back to a single stream.
 */
export async function downloadChunk(options: ChunkDownloadOptions): Promise<ChunkResult> {
  const expected = options.end - options.start + 1;
  const maxRetries = options.maxIoRetries ?? 4;
  let failures = 0;

  for (;;) {
    throwIfAborted(options.signal);
    if (options.preemptSignal.aborted) return { outcome: 'preempted', written: 0 };

    const existing = Math.min(await fileSize(options.partFile), expected);
    if (existing >= expected) {
      // Fully present already (resume of a finished piece).
      return { outcome: 'ok', written: 0 };
    }

    const from = options.start + existing;
    let response: Awaited<ReturnType<typeof requestStream>> | null = null;
    try {
      response = await requestStream(options.url, {
        headers: { ...options.headers, Range: `bytes=${from}-${options.end}` },
        signal: options.signal,
        timeoutMs: 45_000
      });

      if (isHtmlResponse(response.headers)) {
        response.stream.destroy();
        return { outcome: 'failed', written: 0 };
      }

      if (response.statusCode === 200) {
        // Range ignored: do NOT pipe the whole file into one piece.
        response.stream.destroy();
        return { outcome: 'range-ignored', written: 0 };
      }

      if (response.statusCode !== 206) {
        response.stream.destroy();
        throw new HttpStatusError(response.statusCode, `分片请求返回 HTTP ${response.statusCode}`);
      }

      const header = response.headers['content-range'];
      if (!contentRangeMatches(Array.isArray(header) ? header[0] : header, from, options.end)) {
        response.stream.destroy();
        return { outcome: 'failed', written: 0 };
      }

      const { written, digest } = await writeSlice(response, options, existing, expected);
      if (options.preemptSignal.aborted) {
        return { outcome: 'preempted', written };
      }
      if (written < expected - existing) {
        return { outcome: 'failed', written };
      }
      return { outcome: 'ok', written, digest };
    } catch (error) {
      if (isAbortError(error)) {
        if (options.preemptSignal.aborted && !options.signal.aborted) {
          return { outcome: 'preempted', written: 0 };
        }
        throw error;
      }
      failures += 1;
      if (failures > maxRetries) return { outcome: 'failed', written: 0 };
      options.onRetry?.(failures, error as Error);
      await sleep(Math.min(400 * failures, 3_000), options.signal);
    } finally {
      // A half-consumed response would keep a socket pinned; destroy is safe
      // after a full read as well.
      response?.stream.destroy();
    }
  }
}

async function writeSlice(
  response: Awaited<ReturnType<typeof requestStream>>,
  options: ChunkDownloadOptions,
  existing: number,
  expected: number
): Promise<{ written: number; digest: string }> {
  const handle = await fsp.open(options.partFile, existing > 0 ? 'r+' : 'w');
  try {
    // A previous attempt may have left extra bytes; they would shift every
    // following range, so trim to the exact prefix length.
    await handle.truncate(existing);
    const hasher = await hashFilePrefix(options.partFile, existing, createHash('sha256'));
    let written = 0;
    let position = existing;

    for await (const raw of response.stream) {
      const buffer = raw as Buffer;
      const take = Math.min(buffer.length, expected - written);
      if (take <= 0) break;
      await handle.write(buffer, 0, take, position);
      hasher.update(buffer.subarray(0, take));
      position += take;
      written += take;
      // Awaiting here applies backpressure: with a speed limit configured the
      // socket stalls instead of buffering the whole file in memory.
      await options.onBytes?.(take);
      if (options.preemptSignal.aborted || options.signal.aborted) break;
      if (written >= expected) break;
    }

    return { written, digest: hasher.digest('hex') };
  } finally {
    await handle.close();
  }
}
