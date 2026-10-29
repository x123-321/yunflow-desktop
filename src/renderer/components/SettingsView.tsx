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

import { useEffect, useState } from 'react';
import type { AppSettings } from '../../shared/types';
import { FolderIcon } from './Icons';

interface Props {
  settings: AppSettings;
  /** Runtime ceiling: 512 desktop / 32 mobile. */
  maxThreads: number;
  runtime: 'desktop' | 'mobile';
  /** Resolves to a note to show when the save succeeded with caveats. */
  onSave: (patch: Partial<AppSettings>) => Promise<string | undefined>;
  onToast: (message: string) => void;
}

export function SettingsView({ settings, maxThreads, runtime, onSave, onToast }: Props) {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const patch = (next: Partial<AppSettings>) => setDraft((prev) => ({ ...prev, ...next }));

  const choose = async () => {
    const picked = await window.yunflow.chooseDirectory();
    if (picked) patch({ downloadDirectory: picked });
  };

  const save = async () => {
    setSaving(true);
    try {
      const note = await onSave({
        downloadDirectory: draft.downloadDirectory,
        defaultThreads: draft.defaultThreads,
        maxConcurrentTasks: draft.maxConcurrentTasks,
        speedLimitBps: draft.speedLimitBps,
        slowConnectionPreempt: draft.slowConnectionPreempt,
        maxInflightChunks: draft.maxInflightChunks,
        theme: draft.theme,
        autoResumeOnLaunch: draft.autoResumeOnLaunch,
        clipboardWatch: draft.clipboardWatch,
        proxyUrl: draft.proxyUrl.trim()
      });
      // Only claim success once the write really happened, and surface the
      // caveat (e.g. a rejected directory) instead of a plain "已保存".
      onToast(note ?? '设置已保存');
    } catch {
      /* App already surfaced the failure */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="panel">
        <h3>下载</h3>
        <p className="panel-desc">这些参数直接影响吞吐与账号风控风险，默认值适合大多数场景。</p>

        <div className="setting-row no-border">
          <div>
            <div className="title">下载目录</div>
            <div className="desc">分片临时文件放在该目录下的 .yunflow 中，合并后自动清理。</div>
          </div>
          <div className="control">
            <input
              className="input"
              value={draft.downloadDirectory}
              onChange={(event) => patch({ downloadDirectory: event.target.value })}
            />
            <button type="button" className="icon-btn" onClick={choose} title="选择目录">
              <FolderIcon size={17} />
            </button>
          </div>
        </div>

        <div className="setting-row">
          <div>
            <div className="title">默认并发连接数</div>
            <div className="desc">
              每个任务的默认分片连接数，范围 1–{maxThreads}（{runtime === 'mobile' ? '移动端' : '桌面端'}上限）。
              加速来自连接级并发，但过高会触发 CDN 限流。
            </div>
          </div>
          <div className="control">
            <input
              type="range"
              min={1}
              max={maxThreads}
              value={Math.min(draft.defaultThreads, maxThreads)}
              onChange={(event) => patch({ defaultThreads: Number(event.target.value) })}
            />
            <span className="range-value">{draft.defaultThreads}</span>
          </div>
        </div>

        <div className="setting-row">
          <div>
            <div className="title">同时下载任务数</div>
            <div className="desc">任务之间会互相抢带宽，2–3 个通常比全部并发更快。</div>
          </div>
          <div className="control">
            <input
              type="range"
              min={1}
              max={8}
              value={draft.maxConcurrentTasks}
              onChange={(event) => patch({ maxConcurrentTasks: Number(event.target.value) })}
            />
            <span className="range-value">{draft.maxConcurrentTasks}</span>
          </div>
        </div>

        <div className="setting-row">
          <div>
            <div className="title">全局限速</div>
            <div className="desc">0 表示不限速。单位 MB/s，按任务计算。</div>
          </div>
          <div className="control">
            <input
              className="input"
              style={{ maxWidth: 120, textAlign: 'right' }}
              type="number"
              min={0}
              step={0.5}
              value={draft.speedLimitBps > 0 ? draft.speedLimitBps / 1024 / 1024 : 0}
              onChange={(event) => patch({ speedLimitBps: Math.max(0, Number(event.target.value)) * 1024 * 1024 })}
            />
            <span className="hint">MB/s</span>
          </div>
        </div>
      </div>

        <div className="panel">
          <h3>网络</h3>
          <p className="panel-desc">
            在 GitHub 等资源无法直连的网络下，配置 HTTP 代理后，下载会通过它转发（支持 Clash /
            V2Ray 等本地代理的混合端口）。
          </p>
          <div className="setting-row no-border">
            <div>
              <div className="title">下载代理</div>
              <div className="desc">格式 http://127.0.0.1:7890。留空表示直连。保存后立即生效。</div>
            </div>
            <div className="control">
              <input
                className="input"
                style={{ maxWidth: 260 }}
                type="text"
                placeholder="http://127.0.0.1:7890"
                value={draft.proxyUrl}
                onChange={(event) => patch({ proxyUrl: event.target.value })}
              />
            </div>
          </div>
        </div>

        <div className="panel">
          <h3>引擎</h3>
        <p className="panel-desc">分片调度与连接治理策略，对应 YunX 的看门狗与在飞配额实现。</p>

        <div className="setting-row no-border">
          <div>
            <div className="title">慢连接自动换连接</div>
            <div className="desc">
              某条连接明显慢于同任务其他连接时，主动断开并从已收字节处换新连接续传。
              网盘 CDN 按连接限速且节点质量不一，这是消除尾部塌缩的关键。
            </div>
          </div>
          <div className="control" style={{ justifyContent: 'flex-end' }}>
            <button
              type="button"
              className={`switch${draft.slowConnectionPreempt ? ' on' : ''}`}
              onClick={() => patch({ slowConnectionPreempt: !draft.slowConnectionPreempt })}
              aria-pressed={draft.slowConnectionPreempt}
            />
          </div>
        </div>

        <div className="setting-row">
          <div>
            <div className="title">全局在途分片上限</div>
            <div className="desc">
              进程级信号量，限制所有任务同时在飞的 Range 请求总数（8–{maxThreads}），防止内存与文件句柄失控。
              要把单任务跑到 {maxThreads} 路，这里也要设到 {maxThreads}。
            </div>
          </div>
          <div className="control">
            <input
              type="range"
              min={8}
              max={Math.max(8, maxThreads)}
              step={8}
              value={draft.maxInflightChunks}
              onChange={(event) => patch({ maxInflightChunks: Number(event.target.value) })}
            />
            <span className="range-value">{draft.maxInflightChunks}</span>
          </div>
        </div>

        <div className="setting-row">
          <div>
            <div className="title">剪贴板自动识别</div>
            <div className="desc">
              复制直链后切回本窗口时，提示是否添加为下载任务。仅在本窗口获得焦点时检测。
            </div>
          </div>
          <div className="control" style={{ justifyContent: 'flex-end' }}>
            <button
              type="button"
              className={`switch${draft.clipboardWatch ? ' on' : ''}`}
              onClick={() => patch({ clipboardWatch: !draft.clipboardWatch })}
              aria-pressed={draft.clipboardWatch}
            />
          </div>
        </div>

        <div className="setting-row">
          <div>
            <div className="title">启动时自动续传</div>
            <div className="desc">打开应用后自动继续上次未完成的任务。</div>
          </div>
          <div className="control" style={{ justifyContent: 'flex-end' }}>
            <button
              type="button"
              className={`switch${draft.autoResumeOnLaunch ? ' on' : ''}`}
              onClick={() => patch({ autoResumeOnLaunch: !draft.autoResumeOnLaunch })}
              aria-pressed={draft.autoResumeOnLaunch}
            />
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>外观</h3>
        <p className="panel-desc">深色模式跟随系统或手动指定。</p>
        <div className="setting-row no-border">
          <div>
            <div className="title">主题</div>
            <div className="desc">界面配色方案</div>
          </div>
          <div className="control" style={{ justifyContent: 'flex-end' }}>
            {(['system', 'light', 'dark'] as const).map((theme) => (
              <button
                key={theme}
                type="button"
                className={`btn btn-sm${draft.theme === theme ? ' btn-primary' : ''}`}
                onClick={() => patch({ theme })}
              >
                {theme === 'system' ? '跟随系统' : theme === 'light' ? '浅色' : '深色'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="inline" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? '保存中…' : '保存设置'}
        </button>
      </div>
    </div>
  );
}
