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

import { LogoMark, DownloadIcon, InfoIcon, LayersIcon, SettingsIcon, UserIcon } from './Icons';
import type { TaskView } from '../../shared/types';

export type ViewId = 'downloads' | 'accounts' | 'settings' | 'about';

interface Props {
  view: ViewId;
  onNavigate: (view: ViewId) => void;
  tasks: TaskView[];
  version: string;
}

const NAV: Array<{ id: ViewId; label: string; icon: typeof DownloadIcon }> = [
  { id: 'downloads', label: '下载任务', icon: DownloadIcon },
  { id: 'accounts', label: '网盘账号', icon: UserIcon },
  { id: 'settings', label: '偏好设置', icon: SettingsIcon },
  { id: 'about', label: '关于与许可', icon: InfoIcon }
];

export function Sidebar({ view, onNavigate, tasks, version }: Props) {
  const active = tasks.filter((t) => t.status === 'downloading' || t.status === 'merging' || t.status === 'probing').length;

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <LogoMark size={22} />
        </div>
        <div className="brand-text">
          <strong>云流 YunFlow</strong>
          <span>multi-connection</span>
        </div>
      </div>

      <div className="nav-label">工作区</div>
      {NAV.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            className={`nav-item${view === item.id ? ' active' : ''}`}
            onClick={() => onNavigate(item.id)}
          >
            <Icon size={17} />
            <span>{item.label}</span>
            {item.id === 'downloads' && active > 0 ? <span className="count">{active}</span> : null}
          </button>
        );
      })}

      <div className="nav-label">引擎</div>
      <div className="nav-item" style={{ cursor: 'default' }}>
        <LayersIcon size={17} />
        <span>分片并发 · 断点续传</span>
      </div>

      <div className="sidebar-foot">
        <div className="license-card">
          <strong>AGPL-3.0 开源</strong>
          <div className="row">v{version || '0.1.0'} · 源代码可审计</div>
          <div className="row" style={{ marginTop: 4 }}>基于 YunX 实现原理重构</div>
        </div>
      </div>
    </aside>
  );
}
