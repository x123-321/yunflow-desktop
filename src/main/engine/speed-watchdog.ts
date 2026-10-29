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
 * Cloud-drive CDNs throttle per connection, and individual edges can be far
 * slower than their peers. When the last few pieces happen to sit on those
 * edges, total throughput collapses to a few KB/s even though dozens of
 * connections are "busy". Measured on the reference project: out of 64
 * connections, 61 idled for 37 s waiting for a final 500 KB.
 *
 * The fix is to treat a crawling connection as a routing problem rather than a
 * failure: drop it and resume the same byte range on a fresh connection. All
 * bytes already written are kept, so the retry costs one handshake, not the
 * whole piece.
 */
export const PREEMPT_TICK_MS = 5_000;
/** Below this a connection is considered slow (normal edges measured 40–80 KB/s). */
export const PREEMPT_MIN_BPS = 12 * 1024;
/** Grace period covering TCP slow-start; never kill a connection that just opened. */
export const PREEMPT_MIN_AGE_MS = 15_000;
export const PREEMPT_ENDGAME_MIN_AGE_MS = 3_000;
/** Give a replacement connection time to ramp before judging it too. */
export const PREEMPT_COOLDOWN_MS = 10_000;
/** Reconnecting for the last few KB costs more than it saves. */
export const PREEMPT_MIN_REMAIN = 128 * 1024;
/** Hard stop so a globally throttled site cannot trigger a reconnect storm. */
export const PREEMPT_MAX = 3;
/** Rebuild at most this many connections per tick. */
export const PREEMPT_PER_TICK = 2;
/** At or below this many live connections, apply the relaxed grace period. */
export const PREEMPT_ENDGAME_INFLIGHT = 3;
/** No byte at all for this long means the edge is hanging, not merely slow. */
export const PREEMPT_IDLE_MS = 20_000;

export interface PreemptTuning {
  minBps: number;
  minAgeMs: number;
  endgameMinAgeMs: number;
  cooldownMs: number;
  minRemain: number;
  maxPreempts: number;
  perTick: number;
  endgameInflight: number;
  idleMs: number;
}

export const DEFAULT_PREEMPT_TUNING: PreemptTuning = {
  minBps: PREEMPT_MIN_BPS,
  minAgeMs: PREEMPT_MIN_AGE_MS,
  endgameMinAgeMs: PREEMPT_ENDGAME_MIN_AGE_MS,
  cooldownMs: PREEMPT_COOLDOWN_MS,
  minRemain: PREEMPT_MIN_REMAIN,
  maxPreempts: PREEMPT_MAX,
  perTick: PREEMPT_PER_TICK,
  endgameInflight: PREEMPT_ENDGAME_INFLIGHT,
  idleMs: PREEMPT_IDLE_MS
};

export interface PreemptInput {
  bps: number;
  ageMs: number;
  idleMs: number;
  remaining: number;
  preemptCount: number;
  msSincePreempt: number;
  inflight: number;
  /** Average throughput of one connection across the task. */
  taskAvgPerConnectionBps: number;
}

/**
 * Pure decision function (no timers, no I/O) so the policy can be unit tested
 * without waiting 15 seconds for a real connection.
 */
export function shouldPreempt(input: PreemptInput, tuning: PreemptTuning = DEFAULT_PREEMPT_TUNING): boolean {
  if (input.remaining < tuning.minRemain) return false;
  if (input.preemptCount >= tuning.maxPreempts) return false;
  if (input.msSincePreempt < tuning.cooldownMs) return false;

  const endgame = input.inflight <= tuning.endgameInflight;
  const minAge = endgame ? tuning.endgameMinAgeMs : tuning.minAgeMs;
  if (input.ageMs < minAge) return false;

  // A completely silent socket is the strongest signal: the edge is hanging.
  if (input.idleMs >= tuning.idleMs) return true;

  // Otherwise only reconnect when this connection is far below its peers.
  const floor = Math.max(tuning.minBps, input.taskAvgPerConnectionBps / 2);
  return input.bps < floor;
}
