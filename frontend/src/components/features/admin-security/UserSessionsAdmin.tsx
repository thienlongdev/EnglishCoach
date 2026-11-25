'use client';

import React, { useState } from 'react';
import { Loader2, LogOut, Search, UserX } from 'lucide-react';
import { accountSessionsApi, type AdminSessionLookup } from '@/services/accountSessionsApi';

const card = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900';
const quietButton = 'inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800';
const dangerButton = 'inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-red-700 disabled:opacity-50';

function formatWhen(iso: string | null, locale: string): string {
  if (!iso) return '–';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '–';
  return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/**
 * "Phiên của người dùng": the administrator looks an account up by e-mail and ends every one of its sessions (for a
 * stolen account, a ban, a support request). Ending them is a sensitive action: the server asks for a fresh second
 * factor (step-up dialog of the admin layout) and records an audit event.
 */
export function UserSessionsAdmin({ t, locale }: { t: (vi: string, en: string) => string; locale: string }) {
  const [email, setEmail] = useState('');
  const [found, setFound] = useState<AdminSessionLookup | null>(null);
  const [busy, setBusy] = useState<'lookup' | 'revoke' | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const lookup = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('lookup');
    setMessage(null);
    setFound(null);
    try {
      setFound(await accountSessionsApi.adminLookup(email.trim()));
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      setMessage({ kind: 'error', text: status === 404 ? t('Không tìm thấy tài khoản.', 'No such account.') : t('Không tra cứu được.', 'Lookup failed.') });
    } finally {
      setBusy(null);
    }
  };

  const revokeAll = async () => {
    if (!found || !window.confirm(t('Kết thúc mọi phiên đăng nhập của tài khoản này?', 'End every session of this account?'))) return;
    setBusy('revoke');
    setMessage(null);
    try {
      const { revoked } = await accountSessionsApi.adminRevokeAll(found.userId);
      setMessage({ kind: 'ok', text: t(`Đã kết thúc ${revoked} phiên.`, `${revoked} session(s) ended.`) });
      setFound(await accountSessionsApi.adminLookup(email.trim()));
    } catch {
      setMessage({ kind: 'error', text: t('Không thực hiện được (cần xác nhận lớp bảo mật thứ hai).', 'Not done (a fresh second factor is needed).') });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={card} data-testid="admin-user-sessions">
      <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white"><UserX className="h-4 w-4 text-amber-500" aria-hidden />{t('Phiên đăng nhập của người dùng', "A user's sign-in sessions")}</h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        {t('Dùng khi một tài khoản bị chiếm hoặc cần đăng xuất khỏi mọi thiết bị. Thao tác được ghi nhật ký và cần xác nhận lớp bảo mật thứ hai.',
          'For a compromised account or one that must be signed out everywhere. The action is audited and needs a fresh second factor.')}
      </p>
      <form onSubmit={lookup} className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={320}
          placeholder={t('E-mail của tài khoản', 'Account e-mail')} aria-label={t('E-mail của tài khoản', 'Account e-mail')}
          className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-hidden focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/25 dark:border-slate-700 dark:bg-slate-950 dark:text-white" />
        <button type="submit" className={quietButton} disabled={busy !== null || !email.trim()}>
          {busy === 'lookup' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Search className="h-3.5 w-3.5" aria-hidden />}{t('Tra cứu', 'Look up')}
        </button>
      </form>
      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={`mt-3 rounded-xl px-3 py-2 text-xs ${message.kind === 'ok' ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-100' : 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-200'}`}>{message.text}</p>
      )}
      {found && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-slate-600 dark:text-slate-300">{found.name || '–'} · {found.email} · {t(`${found.sessions.length} phiên đang hoạt động`, `${found.sessions.length} live session(s)`)}</p>
          <ul className="space-y-1.5">
            {found.sessions.map((s) => (
              <li key={s.id} className="rounded-lg border border-slate-200 px-3 py-1.5 text-[11px] text-slate-600 dark:border-slate-800 dark:text-slate-300">
                {s.device || t('Thiết bị chưa xác định', 'Unknown device')} · {s.method === 'GOOGLE' ? 'Google' : t('Mật khẩu', 'Password')} · {t('hoạt động', 'active')} {formatWhen(s.lastSeenAt, locale)}
              </li>
            ))}
          </ul>
          {found.sessions.length > 0 && (
            <button type="button" className={dangerButton} disabled={busy !== null} onClick={() => void revokeAll()} data-testid="admin-user-sessions-revoke">
              {busy === 'revoke' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <LogOut className="h-4 w-4" aria-hidden />}{t('Kết thúc mọi phiên', 'End every session')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
