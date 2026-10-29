/*
 * YunFlow (云流) — drive file browser drawer.
 * Copyright (C) 2026 YunFlow Contributors
 *
 * AGPL-3.0-or-later.
 */

import { useEffect, useState } from 'react';
import type { DriveEntryView } from '../../shared/api';
import { formatBytes } from '../format';
import { CloseIcon, DownloadIcon, FolderIcon, ChevronIcon } from './Icons';

interface Props {
  platformId: string;
  platformName: string;
  onClose: () => void;
  onDownload: (platformId: string, entry: DriveEntryView) => Promise<void>;
  /** Queue one file of a batch download. Resolves to true when it was added. */
  onAddFiles: (platformId: string, entry: DriveEntryView) => Promise<boolean>;
  onToast: (message: string) => void;
}

interface Crumb {
  id: string;
  name: string;
}

export function FileBrowser({ platformId, platformName, onClose, onDownload, onAddFiles, onToast }: Props) {
  const [stack, setStack] = useState<Crumb[]>([{ id: '', name: platformName }]);
  const [entries, setEntries] = useState<DriveEntryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [includeSub, setIncludeSub] = useState(false);
  const [batch, setBatch] = useState<{ phase: 'collect' | 'add'; done: number; total: number } | null>(null);

  const current = stack[stack.length - 1];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void window.yunflow
      .driveList(platformId, current.id)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok || !result.data) {
          setError(result.error ?? '读取失败');
          setEntries([]);
        } else {
          setEntries(result.data.entries);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [platformId, current.id]);

  const open = (entry: DriveEntryView) => {
    if (!entry.isDir) return;
    setStack((prev) => [...prev, { id: entry.id, name: entry.name }]);
  };

  const download = async (entry: DriveEntryView) => {
    setBusyId(entry.id);
    try {
      await onDownload(platformId, entry);
    } finally {
      setBusyId('');
    }
  };

  /** Walk the current folder (optionally its subfolders) and queue every file. */
  const downloadFolder = async () => {
    setBatch({ phase: 'collect', done: 0, total: 0 });
    try {
      const files: DriveEntryView[] = [];
      const visited = new Set<string>();
      const walk = async (folderId: string, depth: number): Promise<void> => {
        if (depth > 3 || files.length >= 200 || visited.has(folderId)) return;
        visited.add(folderId);
        let cursor: string | undefined;
        do {
          const res = await window.yunflow.driveList(platformId, folderId, cursor);
          if (!res.ok || !res.data) throw new Error(res.error ?? '读取失败');
          for (const entry of res.data.entries) {
            if (entry.isDir) {
              if (includeSub) await walk(entry.id, depth + 1);
            } else {
              files.push(entry);
            }
            if (files.length >= 200) return;
          }
          cursor = res.data.next;
        } while (cursor);
      };
      await walk(current.id, 0);

      if (files.length === 0) {
        onToast('该目录没有可下载的文件');
        return;
      }
      setBatch({ phase: 'add', done: 0, total: files.length });
      let okCount = 0;
      let failCount = 0;
      for (const file of files) {
        const ok = await onAddFiles(platformId, file);
        if (ok) okCount += 1;
        else failCount += 1;
        setBatch((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
      }
      onToast(`批量下载：已加入 ${okCount} 个任务${failCount > 0 ? `，失败 ${failCount} 个` : ''}`);
    } catch (batchError) {
      onToast((batchError as Error).message || '批量下载失败');
    } finally {
      setBatch(null);
    }
  };

  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="网盘文件">
        <div className="drawer-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 620 }}>浏览文件</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>{platformName}</div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <CloseIcon size={17} />
          </button>
        </div>

        <div className="drawer-body">
          <div className="batch-row">
            <label className="batch-sub">
              <input
                type="checkbox"
                checked={includeSub}
                disabled={batch !== null}
                onChange={(event) => setIncludeSub(event.target.checked)}
              />
              含子文件夹（最多 3 层 / 200 个文件）
            </label>
            <button
              type="button"
              className="btn btn-sm"
              disabled={batch !== null || loading || error !== ''}
              onClick={() => void downloadFolder()}
            >
              <DownloadIcon size={14} /> 下载此文件夹
            </button>
          </div>
          {batch ? (
            <div className="browser-hint">
              {batch.phase === 'collect' ? '正在收集文件…' : `正在加入任务 ${batch.done}/${batch.total}…`}
            </div>
          ) : null}
          <div className="crumbs">
            {stack.map((crumb, index) => (
              <span key={`${crumb.id}-${index}`} className="crumb">
                {index > 0 ? <ChevronIcon size={12} /> : null}
                <button
                  type="button"
                  onClick={() => setStack((prev) => prev.slice(0, index + 1))}
                  disabled={index === stack.length - 1}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </div>

          {loading ? <div className="browser-hint">读取中…</div> : null}
          {error ? <div className="form-error">{error}</div> : null}

          {!loading && !error && entries.length === 0 ? (
            <div className="browser-hint">这个目录是空的</div>
          ) : null}

          <div className="file-list">
            {entries.map((entry) => (
              <div className="file-row" key={entry.id}>
                <div className={`file-icon${entry.isDir ? ' dir' : ''}`}>
                  {entry.isDir ? <FolderIcon size={16} /> : <DownloadIcon size={15} />}
                </div>
                <button
                  type="button"
                  className="file-name"
                  onClick={() => (entry.isDir ? open(entry) : void download(entry))}
                  title={entry.name}
                >
                  {entry.name}
                </button>
                <span className="file-size">{entry.isDir ? '文件夹' : formatBytes(entry.size)}</span>
                {entry.isDir ? (
                  <button type="button" className="icon-btn" onClick={() => open(entry)} title="打开">
                    <ChevronIcon size={15} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={busyId === entry.id}
                    onClick={() => void download(entry)}
                    title="下载"
                  >
                    <DownloadIcon size={15} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}
