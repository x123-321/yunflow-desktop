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
 */

import type { AppInfo } from '../../shared/api';
import { LogoMark, ExternalIcon } from './Icons';

interface Props {
  info: AppInfo | null;
}

export function AboutView({ info }: Props) {
  const open = (url: string) => {
    void window.yunflow.openExternal(url);
  };

  return (
    <div>
      <div className="about-hero">
        <div className="brand-mark" style={{ width: 52, height: 52, borderRadius: 15 }}>
          <LogoMark size={30} />
        </div>
        <div>
          <h2>云流 YunFlow</h2>
          <p>
            版本 {info?.version ?? '0.1.0'} · {info?.license ?? 'AGPL-3.0-or-later'} · Electron + TypeScript
          </p>
        </div>
      </div>

      <div className="panel" style={{ padding: '6px 22px 20px' }}>
        <div className="about-body">
          <h3>这是什么</h3>
          <p>
            YunFlow 是一个桌面端的下载加速器。它把文件切成大量分片，用多条 HTTP Range 连接同时拉取，
            再按字节顺序合并成完整文件。加速的原理不是破解限速算法，而是利用网盘 CDN
            <strong>按单条连接限速</strong>这一事实：一条连接被限制在 100 KB/s，十六条连接就能叠加到 1.6 MB/s。
          </p>

          <h3>许可与致谢</h3>
          <p>
            本项目以 <code>AGPL-3.0-or-later</code> 发布。下载引擎的架构与调度策略，
            来自对开源项目 <strong>YunX（云析）</strong> 源码的分析与重新实现，原项目
            Copyright (C) 2026 CYQawa，同样以 AGPL-3.0 授权。
          </p>
          <p>
            YunX 仓库：
            <a href="https://github.com/CYQawa/YunX" onClick={(event) => { event.preventDefault(); open('https://github.com/CYQawa/YunX'); }}>
              github.com/CYQawa/YunX <ExternalIcon size={12} />
            </a>
            <br />
            本项目的修改与差异：以 Electron + TypeScript 重写为 Windows / macOS / Linux 桌面应用，
            移除 Android 专属依赖（OkHttp、Room、Compose），改用 Node 原生 HTTP 与文件句柄实现分片调度，
            并新增分片地图可视化与插件式直链解析层。原始实现的版权与许可声明保留在
            <code>NOTICE</code> 与每个源文件头部。
          </p>
          <p>
            依据 AGPL-3.0 第 13 条，通过网络使用本软件的用户有权获得对应源代码。
            完整源码随仓库一同提供：<code>LICENSE</code> 为许可证全文，<code>NOTICE</code> 为归属声明。
          </p>

          <h3>技术要点</h3>
          <p>
            尺寸探测（<code>Range: bytes=0-0</code> 校验 206 与 <code>Content-Range</code>）→ 分片规划
            （线程数 × 8 的盈余分片，70% 定长主池 + 30% 弹性区）→ 信号量限流的 worker 池 →
            逐片摘要校验与流式合并。慢连接由看门狗按 5 秒采样判定，命中后主动断开并换连接续传，
            已写入字节全部保留。
          </p>

          <h3>合规提示</h3>
          <div className="notice">
            本工具只改变传输方式，不改变内容的版权归属。请仅下载你本人拥有、或已获得授权的内容，
            并遵守各网盘的服务条款。使用第三方直链可能触发平台风控，建议不要使用主力账号。
            YunFlow 不内置任何网盘私有解析接口，也不提供绕过会员限速的账号类服务。
          </div>

          <h3>运行信息</h3>
          <p style={{ fontSize: 12, color: 'var(--muted)' }}>
            平台 {info?.platform ?? '—'} · 数据目录 {info?.dataDir ?? '—'}
          </p>
        </div>
      </div>
    </div>
  );
}
