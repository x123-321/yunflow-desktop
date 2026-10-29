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

/** Cooperative cancellation, mirroring `CancellationException` in the reference design. */
export class AbortError extends Error {
  constructor(message = 'operation aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof AbortError) return true;
  const name = (error as { name?: string }).name;
  if (name === 'AbortError') return true;
  const code = (error as { code?: string }).code;
  return code === 'ABORT_ERR' || code === 'ERR_STREAM_PREMATURE_CLOSE';
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Counting semaphore. A single process-wide instance bounds how many ranged
 * requests may be in flight at once, no matter how many tasks are running or
 * how high the per-task thread count is set. This is the direct counterpart of
 * the `inflightLimiter` in the reference design and is what keeps memory flat.
 */
export class Semaphore {
  private limit: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity: number) {
    this.limit = Math.max(1, capacity);
  }

  get capacity(): number {
    return this.limit;
  }

  get inUse(): number {
    return this.active;
  }

  /** Adjust the cap at runtime (settings change) without dropping in-flight work. */
  setCapacity(capacity: number): void {
    this.limit = Math.max(1, capacity);
    while (this.active < this.limit && this.waiters.length > 0) {
      const next = this.waiters.shift();
      next?.();
    }
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    if (this.active < this.limit) {
      this.active += 1;
      return this.releaseOnce();
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new AbortError());
      };
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        this.active += 1;
        resolve();
      };
      this.waiters.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    return this.releaseOnce();
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}

/**
 * Token bucket used by the optional global speed limit. One bucket per task so
 * a single task cannot starve the others; the limiter is applied at the read
 * boundary, exactly where bytes leave the socket.
 */
export class TokenBucket {
  private rate: number;
  private tokens: number;
  private lastRefill = Date.now();
  private timer: NodeJS.Timeout | null = null;
  private readonly waiters: Array<() => void> = [];

  constructor(bytesPerSecond: number) {
    this.rate = Math.max(0, bytesPerSecond);
    this.tokens = this.rate > 0 ? Math.min(this.rate, 256 * 1024) : 0;
  }

  get enabled(): boolean {
    return this.rate > 0;
  }

  setRate(bytesPerSecond: number): void {
    this.rate = Math.max(0, bytesPerSecond);
    this.tokens = Math.min(this.tokens, Math.max(this.rate, 0));
  }

  async consume(bytes: number, signal?: AbortSignal): Promise<void> {
    if (this.rate <= 0) return;
    let remaining = bytes;
    while (remaining > 0) {
      throwIfAborted(signal);
      this.refill();
      if (this.tokens > 0) {
        const take = Math.min(this.tokens, remaining);
        this.tokens -= take;
        remaining -= take;
        continue;
      }
      await this.waitForTokens(signal);
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.waiters.splice(0).forEach((w) => w());
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.lastRefill = now;
    const burst = Math.max(this.rate, 64 * 1024);
    this.tokens = Math.min(burst, this.tokens + elapsed * this.rate);
  }

  private waitForTokens(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const i = this.waiters.indexOf(wake);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new AbortError());
      };
      const wake = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiters.push(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (!this.timer) {
        this.timer = setInterval(() => {
          this.refill();
          if (this.tokens <= 0) return;
          clearInterval(this.timer as NodeJS.Timeout);
          this.timer = null;
          this.waiters.splice(0).forEach((w) => w());
        }, 40);
      }
    });
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exp;
  return `${value >= 100 || exp === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exp]}`;
}

export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  return cleaned.slice(0, 180) || 'download.bin';
}
