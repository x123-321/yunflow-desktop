/*
 * YunFlow (云流) — Quark adapter.
 * Copyright (C) 2026 YunFlow Contributors
 *
 * AGPL-3.0-or-later. Endpoint knowledge ported from YunX, Copyright (C) 2026 CYQawa.
 */

import { createCloudAdapter } from './cloud';

export const quarkAdapter = createCloudAdapter({
  id: 'quark',
  apiBase: 'https://drive-pc.quark.cn',
  pr: 'ucpro',
  referer: 'https://pan.quark.cn/',
  origin: 'https://pan.quark.cn',
  accountUrl: 'https://pan.quark.cn/account/info',
  apiUa:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.12-a038f7b798 Safari/537.36 Channel/pckk_other_ch'
});
