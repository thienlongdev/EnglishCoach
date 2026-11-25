'use client';

import React, { useState } from 'react';
import { Fingerprint, KeyRound, LifeBuoy, Loader2, Smartphone } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { mfaApi, mfaErrorCode, type MfaStatus } from '@/services/mfaApi';
import { getPasskeyAssertion, webAuthnSupported } from '@/lib/webauthn';

type Mode = 'choose' | 'totp' | 'recovery';

/** What the backend's refusal means, in the administrator's language. */
export function useSecondFactorMessages() {
  const { locale } = useLanguage();
  const t = (vi: string, en: string) => (locale === 'vi' ? vi : en);
  const refusal = (code: string | null) => {
    switch (code) {
      case 'INVALID_CODE': return t('Không xác minh được. Vui lòng thử lại.', 'That did not verify. Try again.');
      case 'MFA_LOCKED': return t('Quá nhiều lần thử sai. Hãy chờ 15 phút rồi thử lại.', 'Too many failed attempts. Wait fifteen minutes and try again.');
      case 'CHALLENGE_EXPIRED': return t('Yêu cầu đã hết hạn. Vui lòng thử lại.', 'The request expired. Try again.');
      case 'STEP_UP_REQUIRED': return t('Hãy xác nhận lớp bảo mật thứ hai trước.', 'Confirm your second factor first.');
      case 'REAUTH_REQUIRED': return t('Hãy đăng xuất, đăng nhập lại rồi thiết lập trong vòng 30 phút.', 'Sign out, sign in again, then set this up within 30 minutes.');
      case 'LAST_FACTOR': return t('Cần ít nhất một lớp bảo mật: hãy thêm lớp khác trước khi xóa.', 'A second factor is required: add another before removing this one.');
      case 'TOTP_ALREADY_ENROLLED': return t('Đã có ứng dụng xác thực. Hãy xóa trước khi thêm ứng dụng khác.', 'An authenticator app is already enrolled. Remove it first.');
      case 'CREDENTIAL_EXISTS': return t('Passkey này đã được đăng ký.', 'This passkey is already registered.');
      case 'WEBAUTHN_REJECTED': return t('Không xác minh được passkey. Vui lòng thử lại.', 'The passkey could not be verified. Try again.');
      case 'SESSION_ENDED': case 'UNAUTHORIZED': return t('Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại.', 'The session has ended. Sign in again.');
      default: return t('Không thể thực hiện. Vui lòng thử lại.', 'Could not complete that. Try again.');
    }
  };
  return { t, refusal };
}

/**
 * Asks for one of the enrolled second factors and proves it to the backend for the current session. Used both to
 * unlock the administrator area after sign-in and to step up before a sensitive action; `onVerified` runs once the
 * backend has accepted the proof.
 */
export function SecondFactorPrompt({ status, onVerified, heading, hint }: {
  status: Pick<MfaStatus, 'webauthn' | 'totpEnrolled' | 'recoveryCodesRemaining'>;
  onVerified: () => void;
  heading: string;
  hint: string;
}) {
  const { t, refusal } = useSecondFactorMessages();
  const hasPasskey = status.webauthn.length > 0 && webAuthnSupported();
  const [mode, setMode] = useState<Mode>(hasPasskey ? 'choose' : status.totpEnrolled ? 'totp' : 'recovery');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setCode('');
      onVerified();
    } catch (e) {
      const name = (e as { name?: string })?.name;
      // The administrator dismissed the browser's passkey sheet: not an error worth a message.
      if (name !== 'NotAllowedError' && name !== 'AbortError') setError(refusal(mfaErrorCode(e)));
    } finally {
      setBusy(false);
    }
  };

  const usePasskey = () => run(async () => {
    const options = await mfaApi.assertOptions();
    const assertion = await getPasskeyAssertion(options.publicKey);
    await mfaApi.verifyPasskey(options.challengeId, assertion);
  });

  const submitCode = (e: React.FormEvent) => {
    e.preventDefault();
    const value = code.trim();
    if (!value) return;
    void run(() => mfaApi.verifyCode(mode === 'recovery' ? 'RECOVERY_CODE' : 'TOTP', value));
  };

  return (
    <div className="space-y-4" data-testid="second-factor-prompt">
      <div className="text-center">
        <KeyRound className="mx-auto mb-3 h-9 w-9 text-amber-500" aria-hidden />
        <h2 className="text-lg font-bold text-slate-900 dark:text-white">{heading}</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{hint}</p>
      </div>

      {error && (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </p>
      )}

      {hasPasskey && (
        <button type="button" onClick={usePasskey} disabled={busy} data-testid="second-factor-passkey"
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-amber-600 disabled:opacity-60">
          {busy && mode === 'choose' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Fingerprint className="h-4 w-4" aria-hidden />}
          {t('Dùng passkey hoặc khóa bảo mật', 'Use a passkey or security key')}
        </button>
      )}

      {(mode === 'totp' || mode === 'recovery') && (
        <form onSubmit={submitCode} className="space-y-2">
          <label htmlFor="second-factor-code" className="block text-xs font-semibold text-slate-600 dark:text-slate-300">
            {mode === 'totp'
              ? t('Mã 6 số từ ứng dụng xác thực', 'Six-digit code from your authenticator app')
              : t('Mã khôi phục (dùng một lần)', 'Recovery code (works once)')}
          </label>
          <input id="second-factor-code" value={code} onChange={(e) => setCode(e.target.value)} disabled={busy}
            inputMode={mode === 'totp' ? 'numeric' : 'text'} autoComplete="one-time-code" autoCapitalize="characters"
            spellCheck={false} maxLength={mode === 'totp' ? 7 : 40} placeholder={mode === 'totp' ? '123 456' : 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX'}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-center font-mono text-base tracking-widest text-slate-900 outline-hidden focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white" />
          <button type="submit" disabled={busy || !code.trim()} data-testid="second-factor-submit"
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-slate-700 disabled:opacity-50 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200">
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {t('Xác nhận', 'Confirm')}
          </button>
        </form>
      )}

      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs">
        {status.totpEnrolled && mode !== 'totp' && (
          <button type="button" onClick={() => { setMode('totp'); setError(null); setCode(''); }}
            className="inline-flex items-center gap-1 font-semibold text-slate-600 underline-offset-2 hover:underline dark:text-slate-300">
            <Smartphone className="h-3.5 w-3.5" aria-hidden />{t('Dùng ứng dụng xác thực', 'Use the authenticator app')}
          </button>
        )}
        {status.recoveryCodesRemaining > 0 && mode !== 'recovery' && (
          <button type="button" onClick={() => { setMode('recovery'); setError(null); setCode(''); }}
            className="inline-flex items-center gap-1 font-semibold text-slate-600 underline-offset-2 hover:underline dark:text-slate-300">
            <LifeBuoy className="h-3.5 w-3.5" aria-hidden />{t('Dùng mã khôi phục', 'Use a recovery code')}
          </button>
        )}
      </div>
    </div>
  );
}
