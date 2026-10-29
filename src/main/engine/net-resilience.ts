/*
 * YunFlow (云流) — resilient network layer for the download engine.
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
 * Hardened DNS / TLS / proxy plumbing for the download engine.
 *
 * Three independent failure modes are addressed here, observed in the wild on
 * networks where GitHub-style hosts are involved:
 *
 * 1. **Truncated / stale CA trust.** Node's compiled-in CA list can lag behind
 *    newly issued certificate chains (e.g. GitHub's 2026 move to 90-day
 *    Sectigo E36/E46 certificates cross-signed by USERTrust), producing
 *    `unable to verify the first certificate`. A full Mozilla bundle ships
 *    with the app and is wired into every TLS socket via `ca`.
 *
 * 2. **DNS hijack / pollution.** Local "accelerator" tools and some ISP
 *    resolvers answer public hostnames with `127.0.0.1` or poisoned
 *    addresses. When the system resolver returns an answer that is clearly
 *    bogus for a public hostname (loopback / link-local), the lookup is
 *    retried over DNS-over-HTTPS (AliDNS) and the real address is used.
 *
 * 3. **Unreachable CDN edges.** When a direct connection cannot reach an
 *    asset CDN at all, an HTTP(S) proxy can bridge the gap. The engine
 *    accepts `http://host:port` proxies and tunnels HTTPS through CONNECT.
 */

import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import type { LookupFunction } from 'node:net';

export interface EngineNetworkConfig {
  /** `http://host:port` — routes every engine request through this proxy. */
  proxyUrl?: string;
  /** PEM file with extra trusted roots, shipped next to the app payload. */
  caBundlePath?: string;
  /** Retry public-name lookups over DNS-over-HTTPS when the system answer is clearly bogus. Default true. */
  dohEnabled?: boolean;
}

interface EngineNetworkState {
  proxyUrl?: string;
  ca?: string[];
  dohEnabled: boolean;
}

let state: EngineNetworkState = { dohEnabled: true };

/* The agent/lookup option types vary subtly across @types/node releases; the
 * casts below are contained to these two assignments. */

let httpAgent = new http.Agent({ keepAlive: true, maxSockets: Infinity, maxFreeSockets: 32 });
let httpsAgent = new https.Agent({ keepAlive: true, maxSockets: Infinity, maxFreeSockets: 32 });

let onRebuild: (() => void) | null = null;

export function setNetworkRebuildHook(hook: (() => void) | null): void {
  onRebuild = hook;
}

export function getNetworkState(): EngineNetworkState {
  return state;
}

const LOOPBACK_RE = /^(127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:)/i;

/** System answers like `127.0.0.1` for a public hostname are a hijack signature. */
function looksHijacked(addresses: string[]): boolean {
  return addresses.length > 0 && addresses.every((a) => LOOPBACK_RE.test(a));
}

const DOH_TTL_MS = 10 * 60 * 1000;
const dohCache = new Map<string, { addresses: string[]; expires: number }>();

async function dohResolveIPv4(hostname: string): Promise<string[]> {
  const cached = dohCache.get(hostname);
  if (cached && cached.expires > Date.now()) return cached.addresses;

  const url = `https://dns.alidns.com/resolve?name=${encodeURIComponent(hostname)}&type=A`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);
  const data = (await res.json()) as { Status?: number; Answer?: Array<{ type: number; data: string }> };
  if (data.Status !== 0 || !data.Answer) throw new Error('DoH returned no answer');
  const addresses = data.Answer.filter((a) => a.type === 1).map((a) => a.data);
  if (!addresses.length) throw new Error('DoH returned no A records');
  dohCache.set(hostname, { addresses, expires: Date.now() + DOH_TTL_MS });
  return addresses;
}

function cachedDoh(hostname: string): string[] | null {
  const cached = dohCache.get(hostname);
  return cached && cached.expires > Date.now() ? cached.addresses : null;
}

/**
 * A `lookup` implementation for `http.request`/`net.connect`: verifies the
 * system answer and falls back to DNS-over-HTTPS when it is clearly
 * hijacked or fails. Results are cached to keep per-chunk cost at zero.
 */
const resilientLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    const list = typeof addresses === 'string'
      ? [{ address: addresses, family: 4 }]
      : (addresses ?? []).map((a) => ({ address: a.address, family: a.family ?? 4 }));
    const v4 = list.filter((a) => a.family === 4).map((a) => a.address);
    if (!err && v4.length && !looksHijacked(v4)) {
      callback(null, v4.map((a) => ({ address: a, family: 4 })), 4);
      return;
    }
    if (state.dohEnabled === false) {
      const records = v4.map((a) => ({ address: a, family: 4 }));
      if (err) callback(err, records as never);
      else if (records.length) callback(null, records, 4);
      else callback(new Error(`DNS 解析失败：${hostname}`), records as never);
      return;
    }
    const cached = cachedDoh(hostname);
    const doh = cached ? Promise.resolve(cached) : dohResolveIPv4(hostname);
    doh
      .then((addrs) => {
        if (!addrs.length) throw new Error('empty');
        callback(null, addrs.map((a) => ({ address: a, family: 4 })), 4);
      })
      .catch(() => {
        // DoH is only a fallback; surface the original system error when it
        // cannot help either.
        const records = v4.map((a) => ({ address: a, family: 4 }));
        if (err) callback(err, records as never);
        else if (records.length) callback(null, records, 4);
        else callback(new Error(`DNS 解析失败：${hostname}`), records as never);
      });
  });
};

/** Build an https.Agent that tunnels TLS through an HTTP proxy via CONNECT. */
class ProxyTunnelAgent extends https.Agent {
  constructor(private readonly proxyUrl: string, options: https.AgentOptions = {}) {
    super(options);
  }

  createConnection(
    options: { host?: string; port?: number },
    callback: (err: Error | null, stream: Duplex) => void
  ): Duplex | null | undefined {
    const proxy = new URL(this.proxyUrl);
    const targetHost = options.host ?? '';
    const targetPort = options.port ?? 443;
    const headers: Record<string, string> = { Host: `${targetHost}:${targetPort}` };
    if (proxy.username) {
      const token = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
      headers['Proxy-Authorization'] = `Basic ${token}`;
    }
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers,
      timeout: 15_000
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        callback(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`), socket);
        return;
      }
      const tlsSocket = tls.connect({
        socket,
        servername: targetHost,
        ...(state.ca ? { ca: state.ca } : {})
      });
      tlsSocket.once('secureConnect', () => callback(null, tlsSocket));
      tlsSocket.once('error', (err) => callback(err, tlsSocket));
    });
    req.once('timeout', () => {
      req.destroy(new Error('代理 CONNECT 超时'));
    });
    req.once('error', (err) => callback(err, undefined as unknown as Duplex));
    req.end();
    return undefined;
  }
}

function loadCaBundle(caBundlePath?: string): string[] | undefined {
  if (!caBundlePath) return undefined;
  try {
    const pem = fs.readFileSync(caBundlePath, 'utf8');
    return pem.includes('BEGIN CERTIFICATE') ? pem.split(/(?=-----BEGIN CERTIFICATE-----)/) : undefined;
  } catch {
    return undefined;
  }
}

/** Rebuild the shared keep-alive agents from the current network config. */
function rebuildAgents(): void {
  const ca = state.ca;
  const httpsOptions: https.AgentOptions = { keepAlive: true, maxSockets: Infinity, maxFreeSockets: 32, ...(ca ? { ca } : {}) };

  if (state.proxyUrl) {
    httpsAgent = new ProxyTunnelAgent(state.proxyUrl, httpsOptions) as unknown as https.Agent;
    httpAgent = new http.Agent({ keepAlive: true, maxSockets: Infinity, maxFreeSockets: 32 });
    return;
  }
  httpsAgent = new https.Agent({ ...httpsOptions, lookup: resilientLookup });
  httpAgent = new http.Agent({ keepAlive: true, maxSockets: Infinity, maxFreeSockets: 32, lookup: resilientLookup });
}

/**
 * Apply a new network configuration and rebuild the shared agents.
 * Existing connections keep running; every new request picks the change up.
 */
export function configureEngineNetwork(config: EngineNetworkConfig): void {
  state = {
    proxyUrl: config.proxyUrl?.trim() || undefined,
    ca: loadCaBundle(config.caBundlePath),
    dohEnabled: config.dohEnabled !== false
  };
  rebuildAgents();
  onRebuild?.();
}

export function currentHttpAgent(): http.Agent {
  return httpAgent;
}

export function currentHttpsAgent(): https.Agent {
  return httpsAgent;
}
