/*
 * YunFlow (云流) — UC Drive adapter.
 * Copyright (C) 2026 YunFlow Contributors
 *
 * AGPL-3.0-or-later. Endpoint knowledge ported from YunX, Copyright (C) 2026 CYQawa.
 */

import { createCloudAdapter } from './cloud';

export const ucAdapter = createCloudAdapter({
  id: 'uc',
  apiBase: 'https://pc-api.uc.cn',
  pr: 'UCBrowser',
  referer: 'https://drive.uc.cn/',
  origin: 'https://drive.uc.cn',
  accountUrl: 'https://drive.uc.cn/account/info',
  apiUa:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
});
