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

import type { TaskView } from '../../shared/types';
import { fileBadge, formatBytes, formatEta, formatSpeed, percent, platformInfo, statusText } from '../format';
import { CloseIcon, FolderIcon, PauseIcon, PlayIcon } from './Icons';

interface Props {
  task: TaskView;
  onClose: () => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onReveal: (task: TaskView) => void;
}

export function TaskDetail({ task, onClose, onPause, onResume, onReveal }: Props) {
  const platform = platformInfo(task.platformId);
  const busy = task.status === 'downloading' || task.status === 'merging' || task.status === 'probing';
  const active = task.chunks.filter((c) => c.state === 'active').sort((a, b) => b.bps - a.bps);
  const peak = Math.max(1, ...active.map((c) => c.bps));

  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="任务详情">
        <div className="drawer-head">
          <div
            className="file-badge"
            style={{ background: `color-mix(in srgb, ${platform.accent} 14%, transparent)`, color: platform.accent }}
          >
            {fileBadge(task.fileName)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 620, overflowWrap: 'anywhere' }}>{task.fileName}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
              {platform.name} · {statusText(task.status)}
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <CloseIcon size={17} />
          </button>
        </div>

        <div className="drawer-body">
          <div>
            <div className="section-title">
              <span>概览</span>
              <span>{percent(task.downloadedBytes, task.totalBytes).toFixed(1)}%</span>
            </div>
            <dl className="kv">
              <dt>已下载</dt>
              <dd>
                {formatBytes(task.downloadedBytes)} / {task.totalBytes > 0 ? formatBytes(task.totalBytes) : '未知'}
              </dd>
              <dt>当前速度</dt>
              <dd style={{ color: busy ? 'var(--brand)' : undefined, fontWeight: busy ? 600 : 400 }}>
                {formatSpeed(task.speedBps)}
              </dd>
              <dt>剩余时间</dt>
              <dd>{formatEta(task.etaSeconds)}</dd>
              <dt>分片 / 连接</dt>
              <dd>
                共 {task.chunkCount} 片，{task.threads} 路并发，{task.activeConnections} 路在跑
              </dd>
              <dt>换连接</dt>
              <dd>{task.preemptCount} 次（慢连接被自动替换，已收字节保留）</dd>
              <dt>重试</dt>
              <dd>{task.retryCount} 次</dd>
              <dt>保存到</dt>
              <dd>{task.directory}</dd>
            </dl>
          </div>

          <div>
            <div className="section-title">
              <span>分片地图</span>
              <span>{task.chunks.length} 片</span>
            </div>
            <div className="chunk-map">
              {task.chunks.map((chunk, index) => (
                <div
                  key={`${chunk.start}-${index}`}
                  className={`chunk ${chunk.state}`}
                  title={`#${chunk.index} · 起点 ${formatBytes(chunk.start)} · 已收 ${formatBytes(chunk.received)} · ${Math.round(chunk.bps / 1024)} KB/s`}
                />
              ))}
            </div>
            <div className="legend">
              <span><i style={{ background: 'var(--surface-3)' }} />待下载</span>
              <span><i style={{ background: 'var(--brand-2)' }} />进行中</span>
              <span><i style={{ background: '#3f55ec' }} />已完成</span>
              <span><i style={{ background: 'var(--warn)' }} />已换连接</span>
              <span><i style={{ background: 'var(--danger)' }} />失败</span>
            </div>
          </div>

          <div>
            <div className="section-title">
              <span>实时连接</span>
              <span>{active.length} 路</span>
            </div>
            {active.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                当前没有正在传输的连接。暂停或已完成时这里是空的。
              </div>
            ) : (
              <div className="conn-list">
                {active.slice(0, 8).map((chunk) => (
                  <div className="conn" key={`conn-${chunk.start}`}>
                    <span>#{chunk.index}</span>
                    <span className="bar">
                      <i style={{ width: `${Math.max(2, (chunk.bps / peak) * 100)}%` }} />
                    </span>
                    <span style={{ textAlign: 'right' }}>{formatSpeed(chunk.bps)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="inline">
            {busy ? (
              <button type="button" className="btn" onClick={() => onPause(task.id)}>
                <PauseIcon size={15} /> 暂停
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onResume(task.id)}
                disabled={task.status === 'completed'}
              >
                <PlayIcon size={15} /> {task.status === 'failed' ? '重试' : '继续'}
              </button>
            )}
            <button type="button" className="btn" onClick={() => onReveal(task)}>
              <FolderIcon size={15} /> 打开目录
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
