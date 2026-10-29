/*
 * YunFlow (云流) — test fixtures.
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

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestServerOptions {
  /** Always answer 200 and ignore the Range header. */
  ignoreRange?: boolean;
  /** Bytes per second for a normal connection; 0 = unthrottled. */
  ratePerConnection?: number;
  /**
   * Requests whose range starts exactly at this offset are served at
   * `slowRate` (simulates one bad CDN edge). Using an offset rather than a
   * socket index keeps the fixture deterministic: the probe and the retry both
   * use different offsets.
   */
  slowAtOffset?: number;
  slowRate?: number;
}

export interface TestServer {
  url: string;
  stats: {
    requests: number;
    rangeRequests: number;
    fullRequests: number;
    bytesServed: number;
  };
  close: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startServer(content: Buffer, options: TestServerOptions = {}): Promise<TestServer> {
  const stats = { requests: 0, rangeRequests: 0, fullRequests: 0, bytesServed: 0 };

  const server = http.createServer((req, res) => {
    stats.requests += 1;

    const send = async (start: number, end: number, status: number, rate: number) => {
      const length = end - start + 1;
      res.writeHead(status, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="payload.bin"',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(length),
        ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${content.length}` } : {})
      });

      let offset = start;
      try {
        while (offset <= end) {
          if (res.destroyed || res.writableEnded) return;
          const size = Math.min(16 * 1024, end - offset + 1);
          const slice = content.subarray(offset, offset + size);
          const ok = res.write(slice);
          offset += size;
          stats.bytesServed += size;
          // Wait for the socket to accept the buffer *before* pacing. Waiting
          // after the sleep would miss the drain event and hang forever.
          if (!ok && res.writableNeedDrain) {
            await new Promise<void>((resolve) => res.once('drain', () => resolve()));
          }
          if (rate > 0) await sleep((size / rate) * 1000);
        }
        res.end();
      } catch {
        /* client aborted */
      }
    };

    const header = req.headers.range;
    if (!header || options.ignoreRange) {
      stats.fullRequests += 1;
      void send(0, content.length - 1, 200, options.ratePerConnection ?? 0);
      return;
    }

    const match = /^bytes=(\d+)-(\d*)$/i.exec(header.trim());
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${content.length}` });
      res.end();
      return;
    }
    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), content.length - 1) : content.length - 1;
    if (start > end || start >= content.length) {
      res.writeHead(416, { 'Content-Range': `bytes */${content.length}` });
      res.end();
      return;
    }
    stats.rangeRequests += 1;
    const rate = options.slowAtOffset === start ? (options.slowRate ?? 16 * 1024) : (options.ratePerConnection ?? 0);
    void send(start, end, 206, rate);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/payload.bin`,
    stats,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}
