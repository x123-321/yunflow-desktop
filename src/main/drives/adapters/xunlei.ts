/*
 * YunFlow (云流) — Xunlei Drive adapter.
 * Copyright (C) 2026 YunFlow Contributors
 *
 * AGPL-3.0-or-later. Endpoint knowledge ported from YunX, Copyright (C) 2026 CYQawa.
 */

import type {
  DriveAdapter,
  DriveContext,
  DriveEntry,
  DriveLink,
  DriveListResult,
  DriveProfile
} from '../types';
import { DriveError } from '../types';
import { asArray, asRecord, num, requestJson, str } from '../client';
import { XUNLEI_WEB_CLIENT_ID } from '../../accounts/credential-parse';
import { getXunleiCaptcha, invalidateXunleiCaptcha } from '../xunlei-session';

const PAN_BASE = 'https://api-pan.xunlei.com';
const REFRESH_URL = 'https://xluser-ssl.xunlei.com/v1/auth/token';
/** Same value YunX sends; the pan CDN fingerprints it. */
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const CLIENT_VERSION = '8.31.0.9726';

function cookieValue(cookie: string, name: string): string {
  return (
    cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? ''
  );
}

function credentials(ctx: DriveContext): { token: string; deviceId: string } {
  const credentials = ctx.credentials;
  const token = credentials.accessToken || credentials.access_token || '';
  const deviceId =
    credentials.deviceId ||
    credentials.device_id ||
    cookieValue(ctx.cookie, 'deviceid') ||
    cookieValue(ctx.cookie, 'device_id');
  return { token, deviceId };
}

function buildHeaders(ctx: DriveContext, captcha: string): Record<string, string> {
  const { token, deviceId } = credentials(ctx);
  return {
    'User-Agent': WEB_UA,
    'X-Device-Id': deviceId,
    'X-Client-Version': CLIENT_VERSION,
    'Content-Type': 'application/json',
    Origin: 'https://pan.xunlei.com',
    Referer: 'https://pan.xunlei.com/',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(captcha ? { 'X-Captcha-Token': captcha } : {})
  };
}

/**
 * Xunlei answers 200 with an `error` field as often as it answers 401, so every
 * response goes through here. `tokenexpired` / `unauthenticated` are surfaced
 * as `auth` errors so the caller can attempt a refresh instead of showing the
 * user a raw English string.
 */
function apiError(json: Record<string, unknown>, status?: number): DriveError | null {
  const raw = json.error;
  if (!raw) return null;
  const code = typeof raw === 'string' ? raw : str(asRecord(raw).code);
  const description =
    str(json.error_description) || str(json.message) || str(asRecord(raw).message) || '';
  return new DriveError(description ? `${code}：${description}` : code, status, code);
}

function isAuthError(error: unknown): boolean {
  if (!(error instanceof DriveError)) return false;
  const code = `${error.code ?? ''} ${error.message}`.toLowerCase();
  return (
    error.status === 401 ||
    code.includes('unauthenticated') ||
    code.includes('tokenexpired') ||
    code.includes('invalid_token') ||
    code.includes('401')
  );
}

/** Refresh a web-channel token. The web client id needs no client secret. */
async function refreshAccessToken(ctx: DriveContext): Promise<string | null> {
  const { refreshToken } = ctx.credentials;
  if (!refreshToken) return null;
  try {
    const json = await requestJson<Record<string, unknown>>({
      url: REFRESH_URL,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': WEB_UA,
        'X-Device-Id': credentials(ctx).deviceId,
        'X-Client-Id': XUNLEI_WEB_CLIENT_ID,
        Origin: 'https://pan.xunlei.com',
        Referer: 'https://pan.xunlei.com/'
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: XUNLEI_WEB_CLIENT_ID,
        refresh_token: refreshToken
      })
    });
    const accessToken = str(json.access_token) || str(json.accessToken);
    if (!accessToken) return null;
    const nextRefresh = str(json.refresh_token) || str(json.refreshToken);
    ctx.credentials.accessToken = accessToken;
    if (nextRefresh) ctx.credentials.refreshToken = nextRefresh;
    ctx.onCredentials?.({
      accessToken,
      ...(nextRefresh ? { refreshToken: nextRefresh } : {})
    });
    return accessToken;
  } catch {
    return null;
  }
}

interface RetryState {
  captcha: boolean;
  token: boolean;
}

/**
 * The captcha must come from the logged-in page: tokens live 300s and Xunlei
 * signs them with salts that rotate, so neither the login-time token nor a
 * locally computed one stays valid.
 */
async function captchaFor(ctx: DriveContext): Promise<string> {
  if (ctx.partition) {
    const minted = await getXunleiCaptcha(ctx.partition).catch(() => '');
    if (minted) return minted;
  }
  return ctx.credentials.captchaToken || '';
}

/**
 * Authenticated GET with a freshly minted captcha, plus two independent retries:
 * one for an expired access token, one for a stale captcha. Both are cheap and
 * both used to surface as "download failed" minutes after a successful login.
 */
async function panGet<T = Record<string, unknown>>(
  ctx: DriveContext,
  path: string,
  state: RetryState = { captcha: false, token: false }
): Promise<T> {
  const { token } = credentials(ctx);
  if (!token) throw new DriveError('未找到迅雷登录令牌，请重新登录', 401, 'unauthenticated');

  const captcha = await captchaFor(ctx);

  const forgetCaptcha = () => {
    if (ctx.partition) invalidateXunleiCaptcha(ctx.partition);
  };

  let json: Record<string, unknown>;
  try {
    json = await requestJson<Record<string, unknown>>({
      url: `${PAN_BASE}${path}`,
      headers: buildHeaders(ctx, captcha)
    });
  } catch (error) {
    if (!state.token && isAuthError(error) && (await refreshAccessToken(ctx))) {
      forgetCaptcha();
      return panGet<T>(ctx, path, { ...state, token: true });
    }
    throw error;
  }

  const failure = apiError(json);
  if (failure) {
    const code = `${failure.code ?? ''}`.toLowerCase();
    if (!state.captcha && (code === 'captcha_invalid' || code.includes('captcha'))) {
      forgetCaptcha();
      return panGet<T>(ctx, path, { ...state, captcha: true });
    }
    if (!state.token && isAuthError(failure) && (await refreshAccessToken(ctx))) {
      forgetCaptcha();
      return panGet<T>(ctx, path, { ...state, token: true });
    }
    throw failure;
  }
  return json as T;
}

/**
 * Xunlei wraps payloads in `data` on the mobile channel and returns them flat on
 * the web-token channel. Every reader goes through here so both work — reading
 * `data.files` unconditionally is what made a full drive look empty.
 */
function payload(json: Record<string, unknown>): Record<string, unknown> {
  const data = asRecord(json.data);
  return Object.keys(data).length > 0 ? data : json;
}

/**
 * `/drive/v1/about` answers in two shapes: the mobile channel wraps everything
 * in `data`, the web-token channel (`authType: webToken`, i.e. what our login
 * window produces) returns `kind/quota` at the **top level**. Reading only
 * `data.quota` makes a perfectly valid session look expired — that was the
 * "登录后读不到空间" bug.
 */
function pickQuota(json: Record<string, unknown>): Record<string, unknown> {
  const candidates = [asRecord(json.data).quota, json.quota, asRecord(asRecord(json.data).space), json.space];
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (num(record.limit) || num(record.usage) || num(record.total) || num(record.used)) {
      return record;
    }
  }
  return {};
}

export const xunleiAdapter: DriveAdapter = {
  id: 'xunlei',

  async profile(ctx): Promise<DriveProfile> {
    const json = await panGet(ctx, '/drive/v1/about');
    const quota = pickQuota(json);
    const total = num(quota.limit) || num(quota.total);
    const used = num(quota.usage) || num(quota.used);
    const data = payload(json);
    const nickname =
      str(data.nickname) ||
      str(data.nick_name) ||
      str(asRecord(json.user).nickname) ||
      str(ctx.credentials.nickname);
    if (!total && !used) {
      // Everything else worked, so report what actually came back instead of
      // guessing: this string is what the user sees on the account card.
      const shape = Object.keys(json).slice(0, 8).join(',') || '(空响应)';
      throw new DriveError(`迅雷未返回空间字段（响应字段：${shape}）`, undefined, 'no_quota');
    }
    return { used, total, nickname: nickname || undefined };
  },

  async list(ctx, folderId, cursor): Promise<DriveListResult> {
    const filters = encodeURIComponent(JSON.stringify({ trashed: { eq: false } }));
    const url =
      `/drive/v1/files?parent_id=${encodeURIComponent(folderId || '')}` +
      `&page_token=${encodeURIComponent(cursor || '')}&limit=100&with_audit=true&filters=${filters}`;
    const json = await panGet(ctx, url);
    const data = payload(json);
    if (!Array.isArray(data.files) && !('next_page_token' in data)) {
      // An empty folder is legitimate, but so is a shape we failed to read.
      // Telling them apart beats showing an empty list for a full drive.
      throw new DriveError(
        `迅雷文件列表返回了未知结构（字段：${Object.keys(data).slice(0, 8).join(',') || '空'}）`
      );
    }
    const entries: DriveEntry[] = asArray(data.files).map((raw) => {
      const item = asRecord(raw);
      return {
        id: str(item.id),
        name: str(item.name),
        size: num(item.size),
        isDir: str(item.kind).includes('folder'),
        parentId: str(item.parent_id) || folderId
      };
    });
    const next = str(data.next_page_token);
    return { entries, next: next || undefined };
  },

  async link(ctx, entry): Promise<DriveLink> {
    const json = await panGet(
      ctx,
      `/drive/v1/files/${encodeURIComponent(entry.id)}?_magic=2021&usage=PLAY` +
        '&thumbnail_size=SIZE_LARGE&with=hdr10&with=subtitle_files&with=task&with=public_share_tag'
    );
    const data = payload(json);
    const links = asRecord(data.links);
    const downloadUrl =
      str(asRecord(links['application/octet-stream']).url) || str(data.web_content_link);
    if (!downloadUrl) throw new DriveError('接口未返回下载地址（该文件可能需要会员或已被审核）');
    return {
      url: downloadUrl,
      fileName: entry.name,
      headers: { 'User-Agent': WEB_UA, Referer: 'https://pan.xunlei.com/' }
    };
  }
};
