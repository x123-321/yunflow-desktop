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

import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { HeaderMap } from '../../shared/types';
import { AbortError, throwIfAborted } from './util';

/**
 * Keep-alive agents are essential: with 32 range connections the TLS handshake
 * cost would otherwise dominate every chunk retry. `maxSockets` is left open
 * because the process-wide semaphore already bounds concurrency.
 */
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: Infinity, maxFreeSockets: 32 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: Infinity, maxFreeSockets: 32 });

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export class HttpStatusError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

/** Raised when a share / direct link has expired or needs a Referer + Cookie. */
export class LinkExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkExpiredError';
  }
}

export interface RequestOptions {
  method?: string;
  headers?: HeaderMap;
  signal?: AbortSignal;
  /** Socket idle timeout while streaming a body. */
  timeoutMs?: number;
  maxRedirects?: number;
}

export interface StreamResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  stream: IncomingMessage;
  /** URL after redirects; range requests must keep using this one. */
  url: string;
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function normalizeHeaders(headers?: HeaderMap): Record<string, string> {
  const out: Record<string, string> = { 'Accept-Encoding': 'identity' };
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined || value === null || value === '') continue;
      out[key] = value;
    }
  }
  return out;
}

function openOnce(url: string, options: RequestOptions & { headers: Record<string, string> }): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`无效的链接：${url}`));
      return;
    }
    const isHttps = parsed.protocol === 'https:';
    if (!isHttps && parsed.protocol !== 'http:') {
      reject(new Error(`不支持的协议：${parsed.protocol}`));
      return;
    }
    const request = (isHttps ? https : http).request(
      parsed,
      {
        method: options.method ?? 'GET',
        headers: options.headers,
        agent: isHttps ? httpsAgent : httpAgent
      },
      (response) => resolve(response)
    );

    request.on('error', reject);
    // Time to first byte: a hung CDN edge shows up here before any bytes flow.
    request.setTimeout(options.timeoutMs ?? 30_000, () => {
      request.destroy(new Error('连接超时'));
    });

    if (options.signal) {
      if (options.signal.aborted) {
        request.destroy(new AbortError());
      } else {
        options.signal.addEventListener('abort', () => request.destroy(new AbortError()), { once: true });
      }
    }
    request.end();
  });
}

/**
 * Open a GET request, following redirects and returning an unconsumed stream.
 * The caller owns the stream and must either read it to the end or destroy it.
 */
export async function requestStream(rawUrl: string, options: RequestOptions = {}): Promise<StreamResponse> {
  const headers = normalizeHeaders(options.headers);
  const maxRedirects = options.maxRedirects ?? 6;
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    throwIfAborted(options.signal);
    const response = await openOnce(current, { ...options, headers });
    const status = response.statusCode ?? 0;

    if (REDIRECT_CODES.has(status) && response.headers.location) {
      response.resume();
      response.destroy();
      current = new URL(response.headers.location, current).toString();
      continue;
    }

    const onAbort = () => response.destroy(new AbortError());
    if (options.signal) {
      if (options.signal.aborted) response.destroy(new AbortError());
      else options.signal.addEventListener('abort', onAbort, { once: true });
      response.once('close', () => options.signal?.removeEventListener('abort', onAbort));
    }
    response.setTimeout(options.timeoutMs ?? 45_000, () => {
      response.destroy(new Error('读取超时（长时间收不到数据）'));
    });

    return { statusCode: status, headers: response.headers, stream: response, url: current };
  }

  throw new Error('重定向次数过多');
}

export interface ContentRange {
  start: number;
  end: number;
  /** null when the server reports `*`. */
  total: number | null;
}

const CONTENT_RANGE_RE = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i;

export function parseContentRange(value: string | undefined): ContentRange | null {
  if (!value) return null;
  const match = CONTENT_RANGE_RE.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === '*' ? null : Number(match[3]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start) return null;
  if (total !== null && (!Number.isFinite(total) || end >= total)) return null;
  return { start, end, total };
}

/** `false` means the server answered a different range than we asked for. */
export function contentRangeMatches(
  header: string | undefined,
  expectedStart: number,
  expectedEnd: number
): boolean {
  const range = parseContentRange(header);
  if (!range) return false;
  return range.start === expectedStart && range.end === expectedEnd;
}

export function fileNameFromDisposition(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(header);
  if (plain) return (plain[2] ?? plain[3] ?? '').trim();
  return undefined;
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function looksLikeHtml(response: StreamResponse): boolean {
  return isHtmlResponse(response.headers);
}

/**
 * Anti-leech pages, expired-link notices and captive portals are all HTML.
 * A real HTML download carries a filename; a rejection page almost never does.
 */
export function isHtmlResponse(headers: IncomingHttpHeaders): boolean {
  const type = headerString(headers['content-type']) ?? '';
  if (!type.toLowerCase().includes('text/html')) return false;
  return !headers['content-disposition'];
}

export interface ProbeResult {
  /** -1 when the size cannot be determined up front. */
  total: number;
  supportsRange: boolean;
  fileName?: string;
  contentType?: string;
  finalUrl: string;
}

/**
 * Determine the size and range support of a resource.
 *
 * The reference implementation probes with `Range: bytes=0-0` and only trusts a
 * 206 + matching `Content-Range`; a plain 200 means the CDN ignored the range
 * header and the task must fall back to a single stream. We do the same, then
 * fall back to `Content-Length` from an un-ranged request.
 */
export async function probeResource(
  url: string,
  options: { headers?: HeaderMap; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<ProbeResult> {
  const baseHeaders: HeaderMap = {
    'User-Agent': DEFAULT_USER_AGENT,
    ...options.headers,
    Range: 'bytes=0-0'
  };

  let response: StreamResponse | null = null;
  try {
    response = await requestStream(url, { ...options, headers: baseHeaders });
    const status = response.statusCode;
    const contentType = headerString(response.headers['content-type']);
    const fileName = fileNameFromDisposition(headerString(response.headers['content-disposition']));

    if (looksLikeHtml(response)) {
      throw new LinkExpiredError('链接返回了 HTML 页面，可能已过期，或需要 Referer / Cookie 才能访问');
    }

    if (status === 206) {
      const range = parseContentRange(headerString(response.headers['content-range']));
      if (range && range.start === 0 && range.end === 0) {
        return { total: range.total ?? -1, supportsRange: true, fileName, contentType, finalUrl: response.url };
      }
      // Ranges work, but this edge answered a different slice; size is still unknown.
      return { total: -1, supportsRange: true, fileName, contentType, finalUrl: response.url };
    }

    if (status === 416) {
      // Empty file, or the server refuses ranges on a zero length body.
      const range = parseContentRange(headerString(response.headers['content-range']));
      if (range?.total === 0) {
        return { total: 0, supportsRange: true, fileName, contentType, finalUrl: response.url };
      }
    }

    if (status !== 200 && status !== 206) {
      throw new HttpStatusError(status, `服务器返回 HTTP ${status}`);
    }

    const length = Number(headerString(response.headers['content-length']) ?? '');
    return {
      total: Number.isFinite(length) && length > 0 ? length : -1,
      supportsRange: false,
      fileName,
      contentType,
      finalUrl: response.url
    };
  } finally {
    if (response) {
      response.stream.resume();
      response.stream.destroy();
    }
  }
}
