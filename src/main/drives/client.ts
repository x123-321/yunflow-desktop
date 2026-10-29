/*
 * YunFlow (云流) — drive HTTP helper.
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
 */

import { DriveError } from './types';

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export interface JsonRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/**
 * JSON request with a readable failure mode.
 *
 * Cloud-drive APIs answer with 200 + a business error code as often as they
 * answer with 4xx. Every adapter checks its own code field, but a non-JSON body
 * (expired cookie → login HTML) is caught here and reported as such instead of
 * leaking a JSON.parse stack trace into the UI.
 */
export async function requestJson<T = unknown>(request: JsonRequest): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 20_000);
  try {
    const response = await fetch(request.url, {
      method: request.method ?? 'GET',
      headers: {
        'Accept-Encoding': 'identity',
        ...request.headers
      },
      body: request.body,
      signal: controller.signal,
      redirect: 'follow'
    });
    const text = await response.text();
    if (!text) {
      if (!response.ok) throw new DriveError(`服务器返回 HTTP ${response.status}`, response.status);
      return {} as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      if (text.trimStart().startsWith('<')) {
        throw new DriveError('登录态已失效（接口返回了网页），请重新登录', response.status);
      }
      throw new DriveError(`响应不是 JSON：${text.slice(0, 120)}`, response.status);
    }
  } catch (error) {
    if (error instanceof DriveError) throw error;
    if ((error as Error).name === 'AbortError') throw new DriveError('请求超时，请检查网络');
    throw new DriveError((error as Error).message || '请求失败');
  } finally {
    clearTimeout(timer);
  }
}

export function cookieHeaders(cookie: string): Record<string, string> {
  return cookie ? { Cookie: cookie } : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

export function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}
