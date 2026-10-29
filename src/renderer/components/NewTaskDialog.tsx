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

import { useEffect, useMemo, useState } from 'react';
import type { HeaderMap, TaskView } from '../../shared/types';
import { platformForUrl } from '../../shared/platforms';
import { CloseIcon, FolderIcon, LinkIcon, PlusIcon } from './Icons';

interface Props {
  /** Pre-filled by the clipboard watcher when the user accepts its prompt. */
  initialUrl?: string;
  defaultDirectory: string;
  defaultThreads: number;
  /** Runtime ceiling: 512 desktop / 32 mobile. */
  maxThreads: number;
  runtime: 'desktop' | 'mobile';
  onClose: () => void;
  onCreated: (task: TaskView) => void;
}

export function NewTaskDialog({ initialUrl, defaultDirectory, defaultThreads, maxThreads, runtime, onClose, onCreated }: Props) {
  const [url, setUrl] = useState(initialUrl ?? '');
  const [fileName, setFileName] = useState('');
  const [directory, setDirectory] = useState(defaultDirectory);
  const [threads, setThreads] = useState(defaultThreads);
  const [threadsTouched, setThreadsTouched] = useState(false);
  const [referer, setReferer] = useState('');
  const [cookie, setCookie] = useState('');
  const [userAgent, setUserAgent] = useState('');
  const [refererTouched, setRefererTouched] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const detected = useMemo(() => (url.trim() ? platformForUrl(url.trim()) : null), [url]);
  // Two ceilings apply: the runtime ceiling and, for CDNs that degrade above a
  // threshold (Xunlei), a lower per-platform one.
  const cap = Math.max(1, Math.min(maxThreads, detected?.maxRangeWorkers ?? maxThreads));
  const platformLimited = cap < maxThreads;

  useEffect(() => {
    if (!detected) return;
    if (!threadsTouched) setThreads(Math.min(detected.defaultThreads, cap));
    else setThreads((value) => Math.min(value, cap));
    if (!refererTouched && detected.suggestedHeaders.Referer) setReferer(detected.suggestedHeaders.Referer);
  }, [detected, cap, threadsTouched, refererTouched]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const paste = async () => {
    const text = await window.yunflow.readClipboard();
    if (text) setUrl(text.trim());
  };

  const choose = async () => {
    const picked = await window.yunflow.chooseDirectory();
    if (picked) setDirectory(picked);
  };

  const submit = async () => {
    if (!url.trim()) {
      setError('请先粘贴下载地址');
      return;
    }
    setBusy(true);
    setError('');
    const headers: HeaderMap = {};
    if (referer.trim()) headers.Referer = referer.trim();
    if (cookie.trim()) headers.Cookie = cookie.trim();
    if (userAgent.trim()) headers['User-Agent'] = userAgent.trim();
    try {
      const result = await window.yunflow.addTask({
        url: url.trim(),
        fileName: fileName.trim() || undefined,
        directory: directory.trim() || undefined,
        threads,
        headers
      });
      if (!result.ok || !result.task) {
        setError(result.error ?? '添加失败');
        return;
      }
      onCreated(result.task);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="backdrop" onClick={onClose} />
      <div className="modal-panel" style={{ position: 'relative', zIndex: 51 }}>
        <div className="modal-head">
          <h2>新建下载</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <CloseIcon size={17} />
          </button>
        </div>

        <div className="modal-body">
          <div className="field">
            <label htmlFor="url">
              下载地址
              {detected ? (
                <span className="chip" style={{ marginLeft: 4 }}>
                  <i style={{ width: 6, height: 6, borderRadius: 99, background: detected.accent }} />
                  {detected.name}
                </span>
              ) : null}
            </label>
            <textarea
              id="url"
              className="textarea"
              placeholder={'粘贴直链，例如：\nhttps://.../file.zip\n\nGitHub 文件页（/blob/）会自动转换为 raw 直链。'}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              spellCheck={false}
              autoFocus
            />
            <div className="hint">
              YunFlow 只处理直链（或可直连的 GitHub 文件页）。网盘分享页需要在网页端换取下载地址后粘贴，
              并视需要补充 Cookie / Referer。
            </div>
            <div className="inline" style={{ marginTop: 2 }}>
              <button type="button" className="btn btn-sm btn-ghost" onClick={paste}>
                <LinkIcon size={14} /> 从剪贴板粘贴
              </button>
              {detected?.note ? <span className="hint">{detected.note}</span> : null}
            </div>
          </div>

          <div className="row-2">
            <div className="field">
              <label htmlFor="name">文件名（可选）</label>
              <input
                id="name"
                className="input"
                placeholder="留空则读取响应头 / 链接"
                value={fileName}
                onChange={(event) => setFileName(event.target.value)}
              />
            </div>
            <div className="field">
              <label>保存目录</label>
              <div className="inline">
                <input className="input" value={directory} onChange={(event) => setDirectory(event.target.value)} />
                <button type="button" className="icon-btn" onClick={choose} title="选择目录">
                  <FolderIcon size={17} />
                </button>
              </div>
            </div>
          </div>

          <div className="field">
            <label htmlFor="threads">并发连接数</label>
            <div className="range-row">
              <input
                id="threads"
                type="range"
                min={1}
                max={cap}
                step={1}
                value={Math.min(threads, cap)}
                onChange={(event) => {
                  setThreads(Number(event.target.value));
                  setThreadsTouched(true);
                }}
              />
              <span className="range-value">{threads}</span>
            </div>
            <div className="hint">
              加速来自连接级并发：网盘 CDN 按单条连接限速，多开连接才能叠加带宽。
              建议 8–16；并发过高容易触发风控，也可能被 CDN 降级。
              {platformLimited
                ? `当前平台有 ${cap} 路上限（CDN 阈值），已按此限制。`
                : `当前${runtime === 'mobile' ? '移动端' : '桌面端'}上限 ${maxThreads} 路。`}
            </div>
          </div>

          <button
            type="button"
            className="btn btn-sm btn-ghost"
            style={{ alignSelf: 'flex-start', paddingLeft: 0 }}
            onClick={() => setAdvanced((value) => !value)}
          >
            {advanced ? '收起高级选项' : '展开高级选项（Cookie / Referer / UA）'}
          </button>

          {advanced ? (
            <div className="row-2">
              <div className="field">
                <label htmlFor="referer">Referer</label>
                <input
                  id="referer"
                  className="input"
                  placeholder="https://pan.quark.cn/"
                  value={referer}
                  onChange={(event) => {
                    setReferer(event.target.value);
                    setRefererTouched(true);
                  }}
                />
              </div>
              <div className="field">
                <label htmlFor="ua">User-Agent</label>
                <input
                  id="ua"
                  className="input"
                  placeholder="默认使用 Chrome UA"
                  value={userAgent}
                  onChange={(event) => setUserAgent(event.target.value)}
                />
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="cookie">Cookie</label>
                <textarea
                  id="cookie"
                  className="textarea"
                  style={{ minHeight: 64 }}
                  placeholder="从浏览器开发者工具复制该请求的 Cookie 请求头"
                  value={cookie}
                  onChange={(event) => setCookie(event.target.value)}
                  spellCheck={false}
                />
                <div className="hint">Cookie 只保存在本机，用于随每个分片请求一并发送。</div>
              </div>
            </div>
          ) : null}

          {error ? <div className="form-error">{error}</div> : null}
        </div>

        <div className="modal-foot">
          <span className="hint">仅下载你本人拥有或已获授权的内容，并遵守各网盘服务条款。</span>
          <div className="inline">
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
              <PlusIcon size={15} /> {busy ? '添加中…' : '开始下载'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
