'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { Copy, Fingerprint, LifeBuoy, Loader2, ShieldAlert, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import { useCurrentRole } from '@/hooks/useCurrentRole';
import { mfaApi, mfaErrorCode, type EnrollResult } from '@/services/mfaApi';
import { createPasskey, webAuthnSupported } from '@/lib/webauthn';
import { useMfaStatus } from './AdminSecurityGate';
import { SecondFactorPrompt, useSecondFactorMessages } from './SecondFactorPrompt';
import { UserSessionsAdmin } from './UserSessionsAdmin';

function formatWhen(iso: string | null | undefined, locale: string): string {
  if (!iso) return '–';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '–';
  return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

const card = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900';
const primaryButton = 'inline-flex items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-white transition hover:bg-amber-600 disabled:opacity-50';
const quietButton = 'inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800';

/**
 * "Bảo mật quản trị": the administrator's second factors. Passkeys / security keys (resistant to phishing), an
 * authenticator app as the fallback, one-time recovery codes. Every change of factors needs a fresh proof of an
 * existing factor (the very first one: a sign-in within the last 30 minutes) and signs every other session out.
 */
export function SecuritySettings() {
  const { status: sessionStatus } = useSession();
  const { isAdmin, isLoading: roleLoading } = useCurrentRole();
  const { data: status, isLoading, mutate } = useMfaStatus();
  const { t, refusal } = useSecondFactorMessages();
  const locale = t('vi', 'en');

  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [needsProof, setNeedsProof] = useState(false);
  const [passkeyLabel, setPasskeyLabel] = useState('');
  const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  if (sessionStatus === 'loading' || roleLoading || (isAdmin && (isLoading || !status))) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center">
        <Loader2 className="mb-3 h-8 w-8 animate-spin text-amber-500" aria-hidden />
        <p className="text-sm text-slate-500">{t('Đang tải...', 'Loading...')}</p>
      </div>
    );
  }
  if (!isAdmin || !status) {
    return (
      <div className="mx-auto my-16 max-w-md rounded-2xl border border-red-200 bg-white p-6 text-center shadow-xl dark:border-red-900/40 dark:bg-slate-900">
        <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-red-500" aria-hidden />
        <h2 className="mb-2 text-lg font-bold text-slate-900 dark:text-white">{t('Truy cập bị từ chối (403)', 'Access denied (403)')}</h2>
        <p className="mb-6 text-xs text-slate-500 dark:text-slate-400">{t('Khu vực này chỉ dành cho quản trị viên.', 'This area is for the administrator only.')}</p>
        <Link href="/" className="inline-flex rounded-xl bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">{t('Về trang chủ', 'Home')}</Link>
      </div>
    );
  }

  /** Runs one change; a refusal that asks for a fresh proof opens the proof panel instead of an error. */
  const act = async (name: string, work: () => Promise<void>) => {
    setBusy(name);
    setMessage(null);
    try {
      await work();
      await mutate();
    } catch (e) {
      const errorName = (e as { name?: string })?.name;
      const code = mfaErrorCode(e);
      if (code === 'STEP_UP_REQUIRED') setNeedsProof(true);
      else if (errorName !== 'NotAllowedError' && errorName !== 'AbortError') setMessage({ kind: 'error', text: refusal(code) });
    } finally {
      setBusy(null);
    }
  };

  const enrolled = (result: EnrollResult, text: string) => {
    if (result.recoveryCodes?.length) setRecoveryCodes(result.recoveryCodes);
    setMessage({ kind: 'ok', text });
  };

  const addPasskey = () => act('passkey', async () => {
    const options = await mfaApi.registerOptions();
    const credential = await createPasskey(options.publicKey);
    enrolled(await mfaApi.registerVerify(options.challengeId, passkeyLabel.trim() || t('Passkey của tôi', 'My passkey'), credential),
      t('Đã thêm passkey. Các phiên đăng nhập khác đã bị đăng xuất.', 'Passkey added. Every other session was signed out.'));
    setPasskeyLabel('');
  });

  const startTotp = () => act('totp-start', async () => { setTotpSetup(await mfaApi.startTotp()); setTotpCode(''); });

  const confirmTotp = (e: React.FormEvent) => {
    e.preventDefault();
    void act('totp-confirm', async () => {
      enrolled(await mfaApi.confirmTotp(totpCode.trim()),
        t('Đã bật ứng dụng xác thực. Các phiên đăng nhập khác đã bị đăng xuất.', 'Authenticator app enabled. Every other session was signed out.'));
      setTotpSetup(null);
      setTotpCode('');
    });
  };

  const copy = (text: string) => { void navigator.clipboard?.writeText(text).catch(() => {}); };
  const canChange = status.enrolled ? true : status.canEnrollFirstFactor;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 px-3 py-6 sm:px-6 sm:py-8" data-testid="admin-security-page">
      <header className="flex items-center gap-3">
        <ShieldCheck className="h-7 w-7 text-amber-500" aria-hidden />
        <div>
          <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">{t('Bảo mật quản trị', 'Administrator security')}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('Xác thực hai lớp cho tài khoản quản trị. Đăng nhập thôi là chưa đủ để dùng công cụ quản trị.',
              'Two-step verification for the administrator account. Signing in alone does not open the administrator tools.')}
          </p>
        </div>
      </header>

      <section className={card} data-testid="admin-security-state">
        <p className="text-sm font-semibold text-slate-900 dark:text-white">
          {status.enrolled
            ? t('Đang bật: mỗi phiên đăng nhập phải qua lớp bảo mật thứ hai.', 'On: every sign-in must pass the second factor.')
            : status.required
              ? t('Bắt buộc nhưng chưa thiết lập: hãy thêm một lớp bảo mật bên dưới.', 'Required but not set up yet: add a factor below.')
              : t('Chưa bật: hãy thêm passkey (khuyên dùng) hoặc ứng dụng xác thực.', 'Off: add a passkey (recommended) or an authenticator app.')}
        </p>
        {!status.enrolled && !status.canEnrollFirstFactor && (
          <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-100" data-testid="admin-security-reauth">
            {t('Để thiết lập lớp bảo mật đầu tiên, hãy đăng xuất rồi đăng nhập lại, sau đó thiết lập trong vòng 30 phút.',
              'To set up the first factor, sign out and sign in again, then set it up within 30 minutes.')}
          </p>
        )}
      </section>

      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'}
          className={message.kind === 'ok'
            ? 'rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-100'
            : 'rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200'}>
          {message.text}
        </p>
      )}

      {recoveryCodes && (
        <section className={`${card} border-amber-300 dark:border-amber-800`} data-testid="admin-security-recovery-codes">
          <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white"><LifeBuoy className="h-4 w-4 text-amber-500" aria-hidden />{t('Mã khôi phục: chỉ hiện một lần', 'Recovery codes: shown once')}</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {t('Lưu ở nơi an toàn, ngoài máy tính này (in ra hoặc trình quản lý mật khẩu). Mỗi mã dùng được một lần khi bạn mất passkey và điện thoại.',
              'Keep them somewhere safe, away from this computer (print them, or a password manager). Each works once, when you have lost your passkey and your phone.')}
          </p>
          <ul className="mt-3 grid grid-cols-1 gap-1.5 font-mono text-sm text-slate-900 sm:grid-cols-2 dark:text-white">
            {recoveryCodes.map((code) => <li key={code} className="rounded-lg bg-slate-100 px-3 py-1.5 tracking-wider dark:bg-slate-800">{code}</li>)}
          </ul>
          <div className="mt-3 flex gap-2">
            <button type="button" className={quietButton} onClick={() => copy(recoveryCodes.join('\n'))}><Copy className="h-3.5 w-3.5" aria-hidden />{t('Sao chép', 'Copy')}</button>
            <button type="button" className={quietButton} onClick={() => setRecoveryCodes(null)}>{t('Tôi đã lưu', 'I have saved them')}</button>
          </div>
        </section>
      )}

      {needsProof && (
        <section className={`${card} border-amber-300 dark:border-amber-800`} data-testid="admin-security-proof">
          <SecondFactorPrompt status={status}
            heading={t('Xác nhận trước khi thay đổi', 'Confirm before changing')}
            hint={t('Thay đổi lớp bảo mật cần xác nhận một lớp hiện có. Sau đó hãy bấm lại thao tác.', 'Changing a factor needs proof of an existing one. Then repeat the action.')}
            onVerified={() => { setNeedsProof(false); void mutate(); }} />
        </section>
      )}

      <section className={card} data-testid="admin-security-passkeys">
        <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white"><Fingerprint className="h-4 w-4 text-amber-500" aria-hidden />{t('Passkey và khóa bảo mật', 'Passkeys and security keys')}</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          {t('Vân tay, khuôn mặt, mã PIN của thiết bị hoặc khóa USB. Chỉ hoạt động trên đúng trang englishcoach.io.vn nên trang giả mạo không lấy được.',
            'Fingerprint, face, device PIN or a USB key. It only works on the real englishcoach.io.vn, so a look-alike site gets nothing.')}
        </p>
        <ul className="mt-3 space-y-2">
          {status.webauthn.map((passkey) => (
            <li key={passkey.id} className="flex items-center gap-3 rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-800">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">{passkey.label}</p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {t('Thêm', 'Added')} {formatWhen(passkey.createdAt, locale)} · {t('Dùng gần nhất', 'Last used')} {formatWhen(passkey.lastUsedAt, locale)}
                  {passkey.syncedPasskey ? ` · ${t('đồng bộ qua tài khoản thiết bị', 'synced by the device account')}` : ''}
                </p>
              </div>
              <button type="button" className={quietButton} disabled={busy !== null} aria-label={`${t('Xóa', 'Remove')} ${passkey.label}`}
                onClick={() => { if (window.confirm(t('Xóa passkey này?', 'Remove this passkey?'))) void act('remove-passkey', async () => { await mfaApi.removePasskey(passkey.id); setMessage({ kind: 'ok', text: t('Đã xóa passkey.', 'Passkey removed.') }); }); }}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden />{t('Xóa', 'Remove')}
              </button>
            </li>
          ))}
          {status.webauthn.length === 0 && <li className="text-xs text-slate-400">{t('Chưa có passkey nào.', 'No passkey yet.')}</li>}
        </ul>
        {webAuthnSupported() ? (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input value={passkeyLabel} onChange={(e) => setPasskeyLabel(e.target.value)} maxLength={80} disabled={busy !== null || !canChange}
              placeholder={t('Tên gợi nhớ (ví dụ: Laptop ở nhà)', 'A name to recognise it (e.g. Home laptop)')} aria-label={t('Tên passkey', 'Passkey name')}
              className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-hidden focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/25 dark:border-slate-700 dark:bg-slate-950 dark:text-white" />
            <button type="button" className={primaryButton} onClick={addPasskey} disabled={busy !== null || !canChange} data-testid="admin-security-add-passkey">
              {busy === 'passkey' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Fingerprint className="h-4 w-4" aria-hidden />}{t('Thêm passkey', 'Add a passkey')}
            </button>
          </div>
        ) : (
          <p className="mt-3 text-xs text-slate-400">{t('Trình duyệt này không hỗ trợ passkey.', 'This browser does not support passkeys.')}</p>
        )}
      </section>

      <section className={card} data-testid="admin-security-totp">
        <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white"><Smartphone className="h-4 w-4 text-amber-500" aria-hidden />{t('Ứng dụng xác thực (dự phòng)', 'Authenticator app (fallback)')}</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          {t('Mã 6 số đổi mỗi 30 giây (Google Authenticator, Microsoft Authenticator, 1Password...). Hữu ích khi không có passkey, nhưng không chống được trang giả mạo như passkey.',
            'A six-digit code that changes every 30 seconds (Google Authenticator, Microsoft Authenticator, 1Password...). Useful without a passkey, but unlike a passkey it does not stop a look-alike site.')}
        </p>
        {status.totpEnrolled ? (
          <div className="mt-3 flex items-center gap-3">
            <span className="flex-1 text-sm font-semibold text-emerald-700 dark:text-emerald-300">{t('Đang bật', 'Enabled')}</span>
            <button type="button" className={quietButton} disabled={busy !== null}
              onClick={() => { if (window.confirm(t('Tắt ứng dụng xác thực?', 'Turn the authenticator app off?'))) void act('remove-totp', async () => { await mfaApi.removeTotp(); setMessage({ kind: 'ok', text: t('Đã tắt ứng dụng xác thực.', 'Authenticator app removed.') }); }); }}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden />{t('Tắt', 'Remove')}
            </button>
          </div>
        ) : totpSetup ? (
          <form onSubmit={confirmTotp} className="mt-3 space-y-3">
            <ol className="list-decimal space-y-1 pl-5 text-xs text-slate-600 dark:text-slate-300">
              <li>{t('Mở ứng dụng xác thực, chọn "Nhập khóa thiết lập".', 'Open the authenticator app and choose "Enter a setup key".')}</li>
              <li>{t('Tên tài khoản: English Coach. Khóa:', 'Account name: English Coach. Key:')}</li>
            </ol>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-xl bg-slate-100 px-3 py-2 font-mono text-sm tracking-wider text-slate-900 dark:bg-slate-800 dark:text-white" data-testid="admin-security-totp-secret">
                {totpSetup.secret.replace(/(.{4})/g, '$1 ').trim()}
              </code>
              <button type="button" className={quietButton} onClick={() => copy(totpSetup.secret)}><Copy className="h-3.5 w-3.5" aria-hidden />{t('Sao chép', 'Copy')}</button>
            </div>
            <a href={totpSetup.otpauthUri} className="inline-block text-xs font-semibold text-amber-600 underline underline-offset-2">{t('Hoặc mở trực tiếp trong ứng dụng trên thiết bị này', 'Or open it in the app on this device')}</a>
            <label htmlFor="totp-confirm" className="block text-xs font-semibold text-slate-600 dark:text-slate-300">{t('Nhập mã 6 số ứng dụng đang hiện để xác nhận', 'Type the six-digit code the app shows to confirm')}</label>
            <div className="flex gap-2">
              <input id="totp-confirm" value={totpCode} onChange={(e) => setTotpCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123 456"
                className="w-36 rounded-xl border border-slate-300 bg-white px-3 py-2 text-center font-mono text-base tracking-widest text-slate-900 outline-hidden focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/25 dark:border-slate-700 dark:bg-slate-950 dark:text-white" />
              <button type="submit" className={primaryButton} disabled={busy !== null || !totpCode.trim()} data-testid="admin-security-totp-confirm">
                {busy === 'totp-confirm' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t('Bật', 'Enable')}
              </button>
              <button type="button" className={quietButton} onClick={() => { setTotpSetup(null); setTotpCode(''); }}>{t('Hủy', 'Cancel')}</button>
            </div>
          </form>
        ) : (
          <button type="button" className={`${primaryButton} mt-3`} onClick={startTotp} disabled={busy !== null || !canChange} data-testid="admin-security-totp-start">
            {busy === 'totp-start' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Smartphone className="h-4 w-4" aria-hidden />}{t('Thiết lập ứng dụng xác thực', 'Set up an authenticator app')}
          </button>
        )}
      </section>

      {status.enrolled && (
        <section className={card} data-testid="admin-security-recovery">
          <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white"><LifeBuoy className="h-4 w-4 text-amber-500" aria-hidden />{t('Mã khôi phục', 'Recovery codes')}</h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {t(`Còn ${status.recoveryCodesRemaining} mã chưa dùng. Tạo bộ mới sẽ hủy toàn bộ mã cũ.`, `${status.recoveryCodesRemaining} unused. Creating a new set voids every old code.`)}
          </p>
          <button type="button" className={`${quietButton} mt-3`} disabled={busy !== null}
            onClick={() => { if (window.confirm(t('Tạo bộ mã khôi phục mới và hủy mã cũ?', 'Create new recovery codes and void the old ones?'))) void act('regenerate', async () => { setRecoveryCodes((await mfaApi.regenerateRecoveryCodes()).recoveryCodes); }); }}>
            {busy === 'regenerate' && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}{t('Tạo bộ mã mới', 'Create a new set')}
          </button>
        </section>
      )}

      {status.adminAccess === 'GRANTED' && <UserSessionsAdmin t={t} locale={locale} />}
    </div>
  );
}
