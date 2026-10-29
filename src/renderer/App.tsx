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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, TaskStatus, TaskView } from '../shared/types';
import type { AccountsState, AppInfo, DriveEntryView } from '../shared/api';
import { Sidebar, type ViewId } from './components/Sidebar';
import { TaskCard } from './components/TaskCard';
import { TaskDetail } from './components/TaskDetail';
import { NewTaskDialog } from './components/NewTaskDialog';
import { SettingsView } from './components/SettingsView';
import { AboutView } from './components/AboutView';
import { AccountsView, type ProfileState } from './components/AccountsView';
import { FileBrowser } from './components/FileBrowser';
import { BoltIcon, DownloadIcon, GaugeIcon, PlusIcon, LayersIcon } from './components/Icons';
import { formatBytes, formatSpeed } from './format';

const STATUS_ORDER: Record<TaskStatus, number> = {
  downloading: 0,
  merging: 1,
  probing: 2,
  queued: 3,
  paused: 4,
  failed: 5,
  completed: 6,
  canceled: 7
};

const TITLES: Record<ViewId, { title: string; subtitle: string }> = {
  downloads: { title: '下载任务', subtitle: '分片并发 · 断点续传 · 慢连接自动换连接' },
  accounts: { title: '网盘账号', subtitle: '登录一次，该平台的下载任务自动带上 Cookie' },
  settings: { title: '偏好设置', subtitle: '调度参数与界面选项' },
  about: { title: '关于与许可', subtitle: '开源协议、归属声明与技术说明' }
};

export default function App() {
  const [view, setView] = useState<ViewId>('downloads');
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<AccountsState | null>(null);
  const [accountBusy, setAccountBusy] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Record<string, ProfileState>>({});
  const [browse, setBrowse] = useState<{ id: string; name: string } | null>(null);
  const [clipboardUrl, setClipboardUrl] = useState<string | null>(null);
  const seenClipboard = useRef<string | null>(null);
  const [toast, setToast] = useState('');

  useEffect(() => {
    void (async () => {
      const [nextInfo, nextSettings, nextTasks] = await Promise.all([
        window.yunflow.info(),
        window.yunflow.getSettings(),
        window.yunflow.listTasks()
      ]);
      setInfo(nextInfo);
      setSettings(nextSettings);
      setTasks(nextTasks);
      setAccounts(await window.yunflow.listAccounts());
    })();
  }, []);

  useEffect(() => {
    const offTasks = window.yunflow.onTasks(setTasks);
    const offSettings = window.yunflow.onSettings(setSettings);
    const offLog = window.yunflow.onLog((entry) => {
      if (entry.level === 'error') setToast(entry.message);
    });
    return () => {
      offTasks();
      offSettings();
      offLog();
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 2800);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!settings) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = settings.theme === 'dark' || (settings.theme === 'system' && media.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [settings]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        setDialogOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const refreshProfile = useCallback(async (platformId: string) => {
    setProfiles((prev) => ({ ...prev, [platformId]: { loading: true } }));
    const result = await window.yunflow.driveProfile(platformId);
    setProfiles((prev) => ({
      ...prev,
      [platformId]: result.ok && result.data
        ? { profile: result.data }
        : { error: result.error ?? '读取失败' }
    }));
  }, []);

  const loadProfiles = useCallback(
    async (state: AccountsState | null) => {
      if (!state) return;
      await Promise.all(
        state.accounts
          .filter((account) => account.loggedIn)
          .map((account) => refreshProfile(account.platformId))
      );
    },
    [refreshProfile]
  );

  useEffect(() => {
    if (accounts) void loadProfiles(accounts);
  }, [accounts, loadProfiles]);

  // Clipboard watch: a direct link copied anywhere, then focus this window and
  // it offers to queue the download. Only runs while the window is focused and
  // nothing else (dialog / drawer) is asking for attention.
  useEffect(() => {
    if (!settings?.clipboardWatch) {
      seenClipboard.current = null;
      return;
    }
    const timer = setInterval(() => {
      if (!document.hasFocus() || dialogOpen || browse || detailId || clipboardUrl) return;
      void (async () => {
        try {
          const text = (await window.yunflow.readClipboard() ?? '').trim();
          if (!/^https?:\/\/\S+$/i.test(text)) return;
          if (text === seenClipboard.current) return;
          seenClipboard.current = text;
          setClipboardUrl(text);
        } catch {
          /* clipboard may be locked by another process */
        }
      })();
    }, 2_000);
    return () => clearInterval(timer);
  }, [settings?.clipboardWatch, dialogOpen, browse, detailId, clipboardUrl]);

  const sorted = useMemo(
    () => [...tasks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.createdAt - a.createdAt),
    [tasks]
  );

  const stats = useMemo(() => {
    const active = tasks.filter((t) => t.status === 'downloading');
    return {
      connections: tasks.reduce((sum, t) => sum + t.activeConnections, 0),
      speed: tasks.reduce((sum, t) => sum + t.speedBps, 0),
      completed: tasks.filter((t) => t.status === 'completed').length,
      downloading: active.length
    };
  }, [tasks]);

  const detailTask = useMemo(() => tasks.find((t) => t.id === detailId) ?? null, [tasks, detailId]);

  const withError = useCallback(async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      setToast((error as Error).message || '操作失败');
    }
  }, []);

  const pause = useCallback((id: string) => void withError(() => window.yunflow.pauseTask(id)), [withError]);
  const resume = useCallback(
    (id: string) => {
      const task = tasks.find((t) => t.id === id);
      void withError(() => (task?.status === 'failed' ? window.yunflow.retryTask(id) : window.yunflow.resumeTask(id)));
    },
    [tasks, withError]
  );
  const remove = useCallback(
    (id: string) => void withError(() => window.yunflow.removeTask(id)),
    [withError]
  );
  const reveal = useCallback(
    (task: TaskView) => void withError(() => window.yunflow.reveal(task.id)),
    [withError]
  );
  /** One drive file → one task. Returns the task so callers can report where it went. */
  const addDriveFile = useCallback(
    async (platformId: string, entry: DriveEntryView, silent = false): Promise<TaskView | null> => {
      try {
        const link = await window.yunflow.driveLink(platformId, entry);
        if (!link.ok || !link.data) {
          if (!silent) setToast(link.error ?? '获取下载地址失败');
          return null;
        }
        const added = await window.yunflow.addTask({
          url: link.data.url,
          fileName: link.data.fileName || entry.name,
          headers: link.data.headers,
          platformId,
          threads: settings?.defaultThreads ?? 8,
          // Lets the manager mint a fresh URL when this one expires.
          driveRef: { platformId, fileId: entry.id }
        });
        if (!added.ok || !added.task) {
          if (!silent) setToast(added.error ?? '添加任务失败');
          return null;
        }
        return added.task;
      } catch (error) {
        if (!silent) setToast((error as Error).message || '下载失败');
        return null;
      }
    },
    [settings?.defaultThreads]
  );
  const addDriveFiles = useCallback(
    (platformId: string, entry: DriveEntryView) => addDriveFile(platformId, entry, true).then(Boolean),
    [addDriveFile]
  );

  const saveSettings = useCallback(
    async (patch: Partial<AppSettings>): Promise<string | undefined> => {
      try {
        const next = await window.yunflow.updateSettings(patch);
        setSettings(next);
        const requested = patch.downloadDirectory?.trim();
        // The main process keeps the previous directory when the new one cannot
        // receive files; report that instead of claiming a clean save.
        if (requested && next.downloadDirectory !== requested) {
          return `其余设置已保存，下载目录未更改（${requested} 不可写，仍使用 ${next.downloadDirectory}）`;
        }
        return undefined;
      } catch (error) {
        setToast((error as Error).message || '设置保存失败');
        throw error;
      }
    },
    []
  );

  return (
    <div className="app">
      <Sidebar view={view} onNavigate={setView} tasks={tasks} version={info?.version ?? '0.1.0'} />

      <main className="main">
        <header className="page-head">
          <div>
            <h1>{TITLES[view].title}</h1>
            <p>{view === 'downloads' ? `${tasks.length} 个任务 · ${stats.downloading} 个进行中 · ${TITLES[view].subtitle}` : TITLES[view].subtitle}</p>
          </div>
          {view === 'downloads' ? (
            <div className="head-actions">
              <button type="button" className="btn btn-primary" onClick={() => setDialogOpen(true)}>
                <PlusIcon size={16} /> 新建下载
              </button>
            </div>
          ) : null}
        </header>

        {view === 'downloads' ? (
          <>
            <section className="stats">
              <div className="stat">
                <div className="label"><BoltIcon size={13} /> 实时总速度</div>
                <div className="value">
                  {formatSpeed(stats.speed)}
                  <small>{stats.speed > 0 ? '聚合' : '空闲'}</small>
                </div>
              </div>
              <div className="stat">
                <div className="label"><GaugeIcon size={13} /> 活跃连接</div>
                <div className="value">
                  {stats.connections}
                  <small>条 Range 连接</small>
                </div>
              </div>
              <div className="stat">
                <div className="label"><LayersIcon size={13} /> 已完成</div>
                <div className="value">
                  {stats.completed}
                  <small>个文件</small>
                </div>
              </div>
            </section>

            {sorted.length === 0 ? (
              <section className="empty">
                <div style={{ color: 'var(--brand)', opacity: 0.9 }}>
                  <DownloadIcon size={38} />
                </div>
                <h3>还没有下载任务</h3>
                <p>
                  粘贴一个直链开始。YunFlow 会先探测文件大小与 Range 支持情况，再切成大量分片并发拉取，
                  一条连接慢就换一条，收尾时所有连接一起冲线。
                </p>
                <button type="button" className="btn btn-primary" onClick={() => setDialogOpen(true)}>
                  <PlusIcon size={16} /> 新建下载
                </button>
              </section>
            ) : (
              <section className="task-list">
                {sorted.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onSelect={(next) => setDetailId(next.id)}
                    onPause={pause}
                    onResume={resume}
                    onRemove={remove}
                    onReveal={reveal}
                  />
                ))}
              </section>
            )}

            {sorted.length > 0 ? (
              <p style={{ marginTop: 18, fontSize: 12, color: 'var(--muted)' }}>
                当前会话累计接收 {formatBytes(tasks.reduce((sum, t) => sum + t.downloadedBytes, 0))} · 点击任务卡片查看分片地图
              </p>
            ) : null}
          </>
        ) : null}

        {view === 'settings' && settings ? (
          <SettingsView
            settings={settings}
            maxThreads={info?.threads.max ?? 512}
            runtime={info?.threads.runtime ?? 'desktop'}
            onSave={saveSettings}
            onToast={setToast}
          />
        ) : null}

        {view === 'accounts' ? (
          <AccountsView
            state={accounts}
            busyId={accountBusy}
            profiles={profiles}
            onRefresh={(platformId) => void refreshProfile(platformId)}
            onBrowse={(platformId) => {
              const account = accounts?.accounts.find((item) => item.platformId === platformId);
              setBrowse({ id: platformId, name: account?.platformName ?? platformId });
            }}
            onLogin={(platformId) => {
              setAccountBusy(platformId);
              void (async () => {
                try {
                  const next = await window.yunflow.loginAccount(platformId);
                  setAccounts(next);
                  void loadProfiles(next);
                  const account = next.accounts.find((item) => item.platformId === platformId);
                  setToast(account?.loggedIn ? '登录成功，已保存该平台的 Cookie' : '未捕获到登录态，可重试');
                } catch (error) {
                  setToast((error as Error).message || '登录失败');
                } finally {
                  setAccountBusy(null);
                }
              })();
            }}
            onLogout={(platformId) => {
              setAccountBusy(platformId);
              void (async () => {
                try {
                  setAccounts(await window.yunflow.logoutAccount(platformId));
                  setToast('已退出该账号并清除本地 Cookie');
                } finally {
                  setAccountBusy(null);
                }
              })();
            }}
          />
        ) : null}

        {view === 'about' ? <AboutView info={info} /> : null}
      </main>

      {browse ? (
        <FileBrowser
          platformId={browse.id}
          platformName={browse.name}
          onClose={() => setBrowse(null)}
          onDownload={async (platformId, entry: DriveEntryView) => {
            const task = await addDriveFile(platformId, entry);
            if (!task) return;
            setBrowse(null);
            setView('downloads');
            // The main process may have redirected the file to a writable
            // folder; say where it actually went instead of pretending.
            const wanted = settings?.downloadDirectory;
            setToast(
              wanted && task.directory !== wanted
                ? `已加入下载：${entry.name}（${wanted} 不可写，改存到 ${task.directory}）`
                : `已加入下载：${entry.name}`
            );
          }}
          onAddFiles={addDriveFiles}
          onToast={setToast}
        />
      ) : null}

      {detailTask ? (
        <TaskDetail
          task={detailTask}
          onClose={() => setDetailId(null)}
          onPause={pause}
          onResume={resume}
          onReveal={reveal}
        />
      ) : null}

      {clipboardUrl ? (
        <div className="clipboard-banner" role="status">
          <span className="cb-label">检测到下载链接</span>
          <code className="cb-url">{clipboardUrl.length > 72 ? `${clipboardUrl.slice(0, 72)}…` : clipboardUrl}</code>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => setDialogOpen(true)}
          >
            添加下载
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setClipboardUrl(null)}>
            忽略
          </button>
        </div>
      ) : null}

      {dialogOpen ? (
        <NewTaskDialog
          initialUrl={clipboardUrl ?? undefined}
          defaultDirectory={settings?.downloadDirectory || info?.defaultDirectory || ''}
          defaultThreads={settings?.defaultThreads ?? 8}
          maxThreads={info?.threads.max ?? 512}
          runtime={info?.threads.runtime ?? 'desktop'}
          onClose={() => {
            setDialogOpen(false);
            setClipboardUrl(null);
          }}
          onCreated={(task) => {
            setDialogOpen(false);
            setClipboardUrl(null);
            setDetailId(task.id);
            setToast(`已加入队列：${task.fileName}`);
          }}
        />
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
