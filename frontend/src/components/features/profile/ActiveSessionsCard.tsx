'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Laptop, Loader2, LogOut, Monitor, ShieldCheck, Smartphone, Tablet } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { accountSessionsApi, needsReauth, type AccountSession } from '@/services/accountSessionsApi';
import { logout } from '@/services/logout';
import styles from './profileGlass.module.css';

function formatWhen(iso: string | null, locale: string): string {
  if (!iso) return '–';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '–';
  return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB',
    { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** Picture for the server's device label (presentation only; the label itself is shown as the server wrote it). */
function DeviceIcon({ label }: { label: string | null }) {
  const l = (label || '').toLowerCase();
  if (/ipad|tablet/.test(l)) return <Tablet className="h-5 w-5" aria-hidden />;
  if (/iphone|android|mobile|phone/.test(l)) return <Smartphone className="h-5 w-5" aria-hidden />;
  return <Monitor className="h-5 w-5" aria-hidden />;
}

/**
 * "Phiên đăng nhập": every device signed in to this account, with the option to end one or all of the others.
 * Ending other sessions needs a recent sign-in (the server answers REAUTH_REQUIRED otherwise); ending this one is
 * an ordinary sign-out. Opening the card makes one request and no AI call.
 */
export function ActiveSessionsCard() {
  const { locale } = useLanguage();
  const t = (vi: string, en: string) => (locale === 'vi' ? vi : en);
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'reauth'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions(await accountSessionsApi.list());
    } catch {
      setSessions([]);
      setMessage({ kind: 'error', text: t('Không tải được danh sách phiên.', 'Could not load your sessions.') });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  useEffect(() => { void load(); }, [load]);

  const run = async (name: string, work: () => Promise<string>) => {
    setBusy(name);
    setMessage(null);
    try {
      setMessage({ kind: 'ok', text: await work() });
      await load();
    } catch (e) {
      setMessage(needsReauth(e)
        ? { kind: 'reauth', text: t('Để kết thúc phiên trên thiết bị khác, hãy đăng nhập lại (trong 30 phút gần đây) rồi thử lại.', 'To end sessions on other devices, sign in again (within the last 30 minutes) and retry.') }
        : { kind: 'error', text: t('Không thực hiện được. Vui lòng thử lại.', 'That did not work. Please try again.') });
    } finally {
      setBusy(null);
    }
  };

  const endOne = (session: AccountSession) => {
    if (session.current) {
      if (window.confirm(t('Đăng xuất khỏi thiết bị này?', 'Sign out of this device?'))) void logout('/login');
      return;
    }
    void run(session.id, async () => {
      await accountSessionsApi.end(session.id);
      return t('Đã kết thúc phiên trên thiết bị đó.', 'That session has ended.');
    });
  };

  const endOthers = () => {
    if (!window.confirm(t('Đăng xuất khỏi tất cả thiết bị khác?', 'Sign out of every other device?'))) return;
    void run('others', async () => {
      const { revoked } = await accountSessionsApi.endOthers();
      return t(`Đã kết thúc ${revoked} phiên khác.`, `${revoked} other session(s) ended.`);
    });
  };

  const others = (sessions ?? []).filter((s) => !s.current).length;

  return (
    <section className={styles.panel} data-tone="cyan" data-testid="active-sessions-card" aria-labelledby="active-sessions-title">
      <div className={styles.head}>
        <span className={styles.icon} data-tone="cyan" aria-hidden="true"><Laptop className="h-5 w-5" /></span>
        <div className={styles.headText}>
          <h3 id="active-sessions-title" className={styles.title}>{t('Phiên đăng nhập', 'Signed-in devices')}</h3>
          <p className={styles.lead}>
            {t('Các thiết bị đang đăng nhập vào tài khoản của bạn. Nếu có thiết bị lạ, hãy kết thúc phiên đó và đổi mật khẩu.',
              'Devices currently signed in to your account. If you do not recognise one, end it and change your password.')}
          </p>
        </div>
      </div>

      {message && (
        <p role={message.kind === 'ok' ? 'status' : 'alert'} className={`${styles.note} mb-3`} data-kind={message.kind === 'ok' ? 'ok' : 'warn'}>
          <span>
            {message.text}
            {message.kind === 'reauth' && (
              <button type="button" className={`${styles.linkBtn} ml-2`} onClick={() => void logout('/login')}>
                {t('Đăng nhập lại', 'Sign in again')}
              </button>
            )}
          </span>
        </p>
      )}

      {sessions === null ? (
        <div className={styles.loadingRow} role="status"><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />{t('Đang tải...', 'Loading...')}</div>
      ) : (
        <ul className={styles.sessions} data-testid="active-sessions-list">
          {sessions.map((s) => (
            <li key={s.id} className={styles.session} data-current={s.current || undefined}>
              <span className={styles.deviceWell}><DeviceIcon label={s.device} /></span>
              <div className={styles.sessionText}>
                <p className={styles.sessionName}>
                  <span className="min-w-0 truncate">{s.device || t('Thiết bị chưa xác định', 'Unknown device')}</span>
                  {s.current && <span className={`${styles.chip} ${styles.chipOk}`}>{t('Thiết bị này', 'This device')}</span>}
                  {s.secondFactor && <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label={t('Đã xác thực hai lớp', 'Second factor verified')} />}
                </p>
                <p className={styles.sessionMeta}>
                  {s.method === 'GOOGLE' ? 'Google' : t('Mật khẩu', 'Password')} · {t('Đăng nhập', 'Signed in')} {formatWhen(s.signedInAt, locale)} · {t('Hoạt động', 'Active')} {formatWhen(s.lastSeenAt, locale)}
                </p>
              </div>
              <button type="button" className={`${styles.btnGhost} ${styles.btnSm}`} disabled={busy !== null} onClick={() => endOne(s)}
                aria-label={s.current ? t('Đăng xuất thiết bị này', 'Sign out this device') : t('Kết thúc phiên này', 'End this session')}>
                {busy === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <LogOut className="h-3.5 w-3.5" aria-hidden />}
                {s.current ? t('Đăng xuất', 'Sign out') : t('Kết thúc', 'End')}
              </button>
            </li>
          ))}
          {sessions.length === 0 && <li className={styles.empty}>{t('Không có phiên nào.', 'No sessions.')}</li>}
        </ul>
      )}

      {others > 0 && (
        <div className={styles.sessionsFoot}>
          <button type="button" className={`${styles.btnDanger} ${styles.btnSm}`} disabled={busy !== null} onClick={endOthers} data-testid="active-sessions-end-others">
            {busy === 'others' ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <LogOut className="h-3.5 w-3.5" aria-hidden />}
            {t('Đăng xuất khỏi tất cả thiết bị khác', 'Sign out of all other devices')}
          </button>
        </div>
      )}
    </section>
  );
}
