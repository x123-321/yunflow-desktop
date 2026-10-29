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

/**
 * Thread (concurrent Range connection) policy.
 *
 * The reference implementation exposes a 1–512 thread setting and every value
 * is honoured literally: at 512 the app really opens 512 connections, which is
 * what "512 线程" means there. A phone cannot sustain that — 512 sockets plus
 * 512 × 64 KB read buffers on a mobile heap ends in the OOM killer — so the
 * mobile ceiling stays at 32, which is also the reference project's Android
 * default range.
 *
 * Three layers apply, in this order:
 *   1. runtime ceiling      512 desktop / 32 mobile  (hard, never exceeded)
 *   2. platform ceiling     e.g. Xunlei CDN degrades above 8 concurrent ranges
 *   3. user request         clamped into [1, min(runtime ceiling, platform ceiling)]
 *
 * Every value that enters the engine goes through `resolveThreads`, so a
 * hand-edited tasks.json, a stale settings file or a crafted IPC message cannot
 * push the scheduler past the ceiling.
 */

export type RuntimePlatform = 'desktop' | 'mobile';

export interface ThreadLimit {
  /** Hard ceiling; never exceeded by any code path. */
  max: number;
  /** Value used when the user has not chosen anything. */
  default: number;
}

export const MIN_THREADS = 1;

export const THREAD_LIMITS: Record<RuntimePlatform, ThreadLimit> = {
  // Matches YunX's 512-thread ceiling: each worker is a real HTTP/1.1 range
  // connection, 512 × 64 KB read buffers ≈ 32 MB.
  desktop: { max: 512, default: 8 },
  // Mobile keeps the reference project's lower bound: 32 sockets is already
  // aggressive for a phone, and the Android client caps there as well.
  mobile: { max: 32, default: 8 }
};

/** Node reports `android` / `ios` for mobile runtimes; everything else is desktop. */
export function detectRuntimePlatform(nodePlatform: string): RuntimePlatform {
  return nodePlatform === 'android' || nodePlatform === 'ios' ? 'mobile' : 'desktop';
}

export type ClampReason = 'ok' | 'invalid' | 'below-min' | 'above-platform' | 'above-global';

export interface ThreadResolution {
  /** What the caller asked for, after numeric parsing. `null` when absent/invalid. */
  requested: number | null;
  /** The value the scheduler must use. Always within [1, cap]. */
  effective: number;
  /** min(runtime ceiling, platform ceiling). */
  cap: number;
  globalMax: number;
  platformCap: number | null;
  clamped: boolean;
  reason: ClampReason;
}

export interface ThreadRequest {
  requested?: unknown;
  runtime?: RuntimePlatform;
  /** Per-platform ceiling (CDN behaviour), e.g. 8 for Xunlei. */
  platformCap?: number | null;
  /** Used when `requested` is missing or unparsable. */
  fallback?: number;
}

function toInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed);
}

function normalizeCap(value: number | null | undefined, ceiling: number): number | null {
  const parsed = toInteger(value);
  if (parsed === null || parsed < MIN_THREADS) return null;
  return Math.min(parsed, ceiling);
}

/**
 * Single entry point for thread validation. Handles non-numeric, negative,
 * fractional and out-of-range inputs, and reports *why* a value was changed so
 * the UI and the task log can explain the clamp instead of silently ignoring it.
 */
export function resolveThreads(input: ThreadRequest = {}): ThreadResolution {
  const runtime = input.runtime ?? 'desktop';
  const globalMax = THREAD_LIMITS[runtime].max;
  const rawFallback = toInteger(input.fallback) ?? THREAD_LIMITS[runtime].default;
  const fallback = Math.min(Math.max(rawFallback, MIN_THREADS), globalMax);
  const platformCap = normalizeCap(input.platformCap, globalMax);
  const cap = platformCap ?? globalMax;

  const requested = toInteger(input.requested);

  if (requested === null) {
    const effective = Math.min(fallback, cap);
    return {
      requested: null,
      effective,
      cap,
      globalMax,
      platformCap,
      clamped: effective !== fallback,
      reason: effective !== fallback ? 'above-platform' : input.requested === undefined ? 'ok' : 'invalid'
    };
  }

  if (requested < MIN_THREADS) {
    return { requested, effective: MIN_THREADS, cap, globalMax, platformCap, clamped: true, reason: 'below-min' };
  }

  if (requested > cap) {
    const reason: ClampReason = platformCap !== null && cap === platformCap ? 'above-platform' : 'above-global';
    return { requested, effective: cap, cap, globalMax, platformCap, clamped: true, reason };
  }

  return { requested, effective: requested, cap, globalMax, platformCap, clamped: false, reason: 'ok' };
}

/** Human readable explanation for a clamp, used in logs and tooltips. */
export function describeClamp(resolution: ThreadResolution): string | null {
  if (!resolution.clamped) return null;
  switch (resolution.reason) {
    case 'above-platform':
      return `该平台单文件并发 Range 上限为 ${resolution.cap} 路，已从 ${resolution.requested ?? '默认值'} 截断`;
    case 'above-global':
      return `当前运行平台并发上限为 ${resolution.globalMax} 路，已从 ${resolution.requested ?? '默认值'} 截断`;
    case 'below-min':
      return `并发数不能小于 ${MIN_THREADS}，已修正`;
    case 'invalid':
      return '并发数不是有效数字，已回退到默认值';
    default:
      return null;
  }
}
