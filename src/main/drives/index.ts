/*
 * YunFlow (云流) — drive adapter registry.
 * Copyright (C) 2026 YunFlow Contributors
 *
 * AGPL-3.0-or-later. Endpoint knowledge ported from YunX, Copyright (C) 2026 CYQawa.
 */

import { baiduAdapter } from './adapters/baidu';
import { c139Adapter } from './adapters/c139';
import { pan123Adapter } from './adapters/pan123';
import { quarkAdapter } from './adapters/quark';
import { ucAdapter } from './adapters/uc';
import { xunleiAdapter } from './adapters/xunlei';
import type { DriveAdapter } from './types';

const ADAPTERS: DriveAdapter[] = [
  quarkAdapter,
  ucAdapter,
  xunleiAdapter,
  baiduAdapter,
  pan123Adapter,
  c139Adapter
];

export function adapterFor(platformId: string): DriveAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.id === platformId);
}

export function adapterIds(): string[] {
  return ADAPTERS.map((adapter) => adapter.id);
}
