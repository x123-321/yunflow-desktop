/*
 * YunFlow (云流) — accounts view.
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

import type { AccountsState, DriveProfileView } from '../../shared/api';
import { formatBytes } from '../format';
import { AlertIcon, CheckIcon, UserIcon } from './Icons';

export interface ProfileState {
  loading?: boolean;
  error?: string;
  profile?: DriveProfileView;
}

interface Props {
  state: AccountsState | null;
  busyId: string | null;
  profiles: Record<string, ProfileState>;
  onLogin: (platformId: string) => void;
  onLogout: (platformId: string) => void;
  onRefresh: (platformId: string) => void;
  onBrowse: (platformId: string) => void;
}

function quotaText(profile?: DriveProfileView): string {
  if (!profile?.total) return '';
  return `${formatBytes(profile.used ?? 0)} / ${formatBytes(profile.total)}`;
}

function formatTime(value?: number): string {
  if (!value) return '—';
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function AccountsView({ state, busyId, profiles, onLogin, onLogout, onRefresh, onBrowse }: Props) {
  const accounts = state?.accounts ?? [];

  return (
    <div>
      <div className="note-box" style={{ marginBottom: 14 }}>
        <strong>登录方式：</strong>点「登录」会打开该网盘的<strong>官方网页</strong>，扫码 / 短信 / 密码都在官方页面完成，
        YunFlow 不接触你的账号密码。登录成功后关闭窗口，程序只保留该站点的 Cookie，
        之后同平台的下载任务会自动带上，不必再手动粘贴。
      </div>

      {state && !state.encrypted ? (
        <div className="note-box" style={{ marginBottom: 14, borderColor: 'var(--warn)', background: 'var(--warn-soft)' }}>
          <AlertIcon size={14} /> 当前系统未提供可用的密钥环，Cookie 将以明文保存在 <code>data/accounts.json</code>。
          请勿在公用电脑上登录。
        </div>
      ) : null}

      <div className="account-grid">
        {accounts.map((account) => (
          <article className="account-card" key={account.platformId}>
            <div className="account-top">
              <div
                className="file-badge"
                style={{
                  background: `color-mix(in srgb, ${account.accent} 14%, transparent)`,
                  color: account.accent
                }}
              >
                <UserIcon size={17} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="name">{account.platformName}</div>
                <div className="sub">
                  {account.loggedIn
                    ? profiles[account.platformId]?.profile?.nickname || `已登录 · ${account.cookieCount} 条 Cookie`
                    : '未登录'}
                </div>
              </div>
              <span
                className="pill"
                style={
                  account.loggedIn
                    ? { color: 'var(--success)', background: 'var(--success-soft)' }
                    : { color: 'var(--muted)', background: 'var(--surface-3)' }
                }
              >
                {account.loggedIn ? <CheckIcon size={11} /> : null}
                {account.loggedIn ? '可用' : '未登录'}
              </span>
            </div>

            {account.loggedIn && profiles[account.platformId] ? (
              <div className="account-quota">
                {profiles[account.platformId]?.loading ? <div className="browser-hint">读取空间…</div> : null}
                {profiles[account.platformId]?.error ? (
                  <div className="quota-error">
                    {profiles[account.platformId]?.error}
                    <button
                      type="button"
                      className="quota-retry"
                      onClick={() => onRefresh(account.platformId)}
                      disabled={busyId === account.platformId}
                    >
                      重试
                    </button>
                  </div>
                ) : null}
                {profiles[account.platformId]?.profile?.total ? (
                  <>
                    <div className="quota-line">
                      <span>已用 {quotaText(profiles[account.platformId].profile)}</span>
                      <span>
                        {Math.round(
                          ((profiles[account.platformId].profile?.used ?? 0) /
                            (profiles[account.platformId].profile?.total ?? 1)) *
                            100
                        )}
                        %
                      </span>
                    </div>
                    <div className="quota-bar">
                      <i
                        style={{
                          width: `${Math.min(
                            100,
                            ((profiles[account.platformId].profile?.used ?? 0) /
                              (profiles[account.platformId].profile?.total ?? 1)) *
                              100
                          )}%`
                        }}
                      />
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}

            <div className="account-meta">
              最近登录：{formatTime(account.updatedAt)}
              <br />
              登录后，该平台的任务会自动附带 Cookie。
            </div>

            <div className="inline">
              <button
                type="button"
                className="btn btn-sm"
                disabled={busyId === account.platformId}
                onClick={() => onLogin(account.platformId)}
              >
                {busyId === account.platformId ? '等待登录…' : account.loggedIn ? '重新登录' : '登录'}
              </button>
              {account.loggedIn ? (
                <button type="button" className="btn btn-sm" onClick={() => onBrowse(account.platformId)}>
                  浏览文件
                </button>
              ) : null}
              {account.loggedIn ? (
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  disabled={busyId === account.platformId}
                  onClick={() => onLogout(account.platformId)}
                >
                  退出登录
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>

      <div className="note-box" style={{ marginTop: 14 }}>
        六家网盘均已接入账号信息与文件浏览。容量与列表来自各平台网页版接口，接口变更时会直接显示错误原因，
        点「重新登录」可刷新凭证。若某个平台读取失败，把错误文本发我即可定位。
      </div>
    </div>
  );
}
