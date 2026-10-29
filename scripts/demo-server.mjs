/*
 * YunFlow (云流) — local demo server.
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

/**
 * Serves a generated file over HTTP with a **per-connection** rate limit.
 *
 * Why: cloud-drive CDNs throttle each TCP connection, not the account. This
 * server reproduces that behaviour locally, so the difference between one
 * connection and sixteen is measurable without touching any real drive.
 *
 *   npm run demo
 *
 * Expected: one connection tops out at ~1.5 MB/s; with 16 connections the app
 * should show roughly 20+ MB/s, and the final SHA-256 must match the printed
 * value.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 5410);
const SIZE = Math.round(Number(process.env.DEMO_SIZE_MB ?? 192) * 1024 * 1024);
const PER_CONNECTION_BPS = Number(process.env.DEMO_RATE_MBPS ?? 1.5) * 1024 * 1024;
const CHUNK = 64 * 1024;

const filePath = path.join(os.tmpdir(), `yunflow-demo-${SIZE}.bin`);
const shaPath = `${filePath}.sha256`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensurePayload() {
  try {
    const sha = (await fsp.readFile(shaPath, 'utf8')).trim();
    const stat = await fsp.stat(filePath);
    if (stat.size === SIZE && sha) return sha;
  } catch {
    /* regenerate */
  }

  process.stdout.write(`Generating a ${(SIZE / 1024 / 1024).toFixed(0)} MB demo payload (one time)...`);
  const digest = createHash('sha256');
  const handle = await fsp.open(filePath, 'w');
  try {
    for (let written = 0; written < SIZE; written += 4 * 1024 * 1024) {
      const block = randomBytes(Math.min(4 * 1024 * 1024, SIZE - written));
      digest.update(block);
      await handle.write(block);
    }
  } finally {
    await handle.close();
  }
  const sha = digest.digest('hex');
  await fsp.writeFile(shaPath, `${sha}\n`);
  process.stdout.write(' done.\n');
  return sha;
}

const sha256 = await ensurePayload();
const stats = { requests: 0, bytes: 0 };

async function send(req, res, start, end, status) {
  const length = end - start + 1;
  res.writeHead(status, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="yunflow-demo.bin"',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(length),
    ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${SIZE}` } : {})
  });

  const stream = fs.createReadStream(filePath, { start, end, highWaterMark: CHUNK });
  try {
    for await (const buffer of stream) {
      if (res.destroyed) return;
      const ok = res.write(buffer);
      stats.bytes += buffer.length;
      if (!ok && res.writableNeedDrain) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
      // The whole point: pace every connection independently.
      await sleep((buffer.length / PER_CONNECTION_BPS) * 1000);
    }
    res.end();
  } catch {
    /* client aborted */
  } finally {
    stream.destroy();
  }
}

const server = http.createServer((req, res) => {
  stats.requests += 1;
  const header = req.headers.range;
  if (!header) {
    void send(req, res, 0, SIZE - 1, 200);
    return;
  }
  const match = /^bytes=(\d+)-(\d*)$/i.exec(header.trim());
  if (!match) {
    res.writeHead(416, { 'Content-Range': `bytes */${SIZE}` });
    res.end();
    return;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), SIZE - 1) : SIZE - 1;
  if (start > end || start >= SIZE) {
    res.writeHead(416, { 'Content-Range': `bytes */${SIZE}` });
    res.end();
    return;
  }
  void send(req, res, start, end, 206);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  YunFlow demo server');
  console.log('  ------------------------------------------------------------');
  console.log(`  URL       http://127.0.0.1:${PORT}/demo.bin`);
  console.log(`  Size      ${(SIZE / 1024 / 1024).toFixed(0)} MB`);
  console.log(`  Limit     ${(PER_CONNECTION_BPS / 1024 / 1024).toFixed(1)} MB/s per connection`);
  console.log(`  SHA-256   ${sha256}`);
  console.log('  ------------------------------------------------------------');
  console.log('  Paste the URL into YunFlow, set connections to 16, and compare');
  console.log('  with a single connection. Ctrl+C to stop.');
  console.log('');
});

setInterval(() => {
  if (stats.bytes === 0) return;
  const mb = (stats.bytes / 1024 / 1024).toFixed(1);
  process.stdout.write(`\r  served ${mb} MB in ${stats.requests} requests   `);
  stats.bytes = 0;
  stats.requests = 0;
}, 2000).unref();
