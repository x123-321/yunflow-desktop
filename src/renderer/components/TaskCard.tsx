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

import type { MouseEvent } from 'react';
import type { TaskView } from '../../shared/types';
import { fileBadge, formatBytes, formatEta, formatSpeed, percent, platformInfo, statusText } from '../format';
import { FolderIcon, PauseIcon, PlayIcon, TrashIcon } from './Icons';

interface Props {
  task: TaskView;
  onSelect: (task: TaskView) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRemove: (id: string) => void;
  onReveal: (task: TaskView) => void;
}

export function TaskCard({ task, onSelect, onPause, onResume, onRemove, onReveal }: Props) {
  const platform = platformInfo(task.platformId);
  const progress = task.status === 'completed' ? 100 : percent(task.downloadedBytes, task.totalBytes);
  const busy = task.status === 'downloading' || task.status === 'merging' || task.status === 'probing';
  const canResume = task.status === 'paused' || task.status === 'failed' || task.status === 'canceled';
  const progressClass = task.status === 'completed' ? 'progress done' : task.status === 'failed' ? 'progress failed' : 'progress';

  const stop = (event: MouseEvent) => event.stopPropagation();

  return (
    <article className="task" onClick={() => onSelect(task)}>
      <div className="task-top">
        <div
          className="file-badge"
          style={{
            background: `color-mix(in srgb, ${platform.accent} 14%, transparent)`,
            color: platform.accent
          }}
        >
          {fileBadge(task.fileName)}
        </div>
        <div className="task-title">
          <div className="name" title={task.fileName}>
            {task.fileName}
          </div>
          <div className="meta">
            <span>{platform.name}</span>
            <span className="dot-sep" />
            <span>{task.threads} 连接</span>
            {task.chunkCount > 0 ? (
              <>
                <span className="dot-sep" />
                <span>{task.chunkCount} 分片</span>
              </>
            ) : null}
            {task.singleStream ? (
              <>
                <span className="dot-sep" />
                <span>单流回退</span>
              </>
            ) : null}
          </div>
        </div>
        <span className={`pill pill-${task.status}`}>
          {busy ? <i className="spinner" /> : null}
          {statusText(task.status)}
        </span>
      </div>

      <div className={progressClass}>
        <i style={{ width: `${progress}%` }} />
      </div>

      <div className="task-foot">
        <div className="numbers">
          <span>
            {formatBytes(task.downloadedBytes)} / {task.totalBytes > 0 ? formatBytes(task.totalBytes) : '未知大小'}
          </span>
          {task.status === 'downloading' ? (
            <>
              <span className="dot-sep" />
              <span className="speed">{formatSpeed(task.speedBps)}</span>
              <span className="dot-sep" />
              <span>剩余 {formatEta(task.etaSeconds)}</span>
              <span className="dot-sep" />
              <span>{task.activeConnections} 路在跑</span>
            </>
          ) : null}
          {task.status === 'completed' ? (
            <>
              <span className="dot-sep" />
              <span>{task.preemptCount > 0 ? `换连接 ${task.preemptCount} 次` : '一次跑完'}</span>
            </>
          ) : null}
        </div>

        <div className="task-actions" onClick={stop}>
          {busy ? (
            <button type="button" className="icon-btn" title="暂停" onClick={() => onPause(task.id)}>
              <PauseIcon size={16} />
            </button>
          ) : null}
          {canResume ? (
            <button type="button" className="icon-btn" title="继续 / 重试" onClick={() => onResume(task.id)}>
              <PlayIcon size={16} />
            </button>
          ) : null}
          <button type="button" className="icon-btn" title="打开所在文件夹" onClick={() => onReveal(task)}>
            <FolderIcon size={16} />
          </button>
          <button type="button" className="icon-btn danger" title="删除任务" onClick={() => onRemove(task.id)}>
            <TrashIcon size={16} />
          </button>
        </div>
      </div>

      {task.error ? <div className="task-error">{task.error}</div> : null}
    </article>
  );
}
