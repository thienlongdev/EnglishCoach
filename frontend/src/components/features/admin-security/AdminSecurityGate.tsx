'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import useSWR from 'swr';
import { useSession } from 'next-auth/react';
import { Loader2, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { useCurrentRole } from '@/hooks/useCurrentRole';
import { mfaApi, type MfaStatus } from '@/services/mfaApi';
import { registerStepUpPrompt } from '@/lib/step-up';
import { SecondFactorPrompt, useSecondFactorMessages } from './SecondFactorPrompt';

export const MFA_STATUS_KEY = '/mfa/status';

/** The administrator's second-factor status (user-scoped cache key; asked only for the administrator account). */
export function useMfaStatus() {
  const { data: session, status } = useSession();
  const { isAdmin } = useCurrentRole();
  const email = session?.user?.email;
  const key = status === 'authenticated' && email && isAdmin ? [MFA_STATUS_KEY, email] : null;
  return useSWR<MfaStatus>(key, () => mfaApi.status(), {
    revalidateOnFocus: true, dedupingInterval: 2000, keepPreviousData: false, shouldRetryOnError: false,
  });
}

/**
 * Wraps every /admin page. The backend already refuses administrator actions from a session that has not passed
 * the second factor; this is the screen that lets the administrator pass it (or enrol one) instead of meeting
 * a wall of 403s, and the host of the step-up dialog that sensitive actions open.
 */
export function AdminSecurityGate({ children }: { children: React.ReactNode }) {
  const { isAdmin, isLoading: roleLoading, mutate: reloadRole } = useCurrentRole();
  const { data: status, isLoading, mutate } = useMfaStatus();
  const pathname = usePathname();
  const { t } = useSecondFactorMessages();
  const onSecurityPage = pathname?.startsWith('/admin/security');

  // Not the administrator (or still finding out): each page shows its own "no access" / loading state.
  if (!isAdmin || roleLoading) return <>{children}</>;

  if (isLoading || !status) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center">
        <Loader2 className="mb-3 h-8 w-8 animate-spin text-amber-500" aria-hidden />
        <p className="text-sm text-slate-500">{t('Đang kiểm tra bảo mật tài khoản quản trị...', 'Checking administrator security...')}</p>
      </div>
    );
  }

  if (status.adminAccess === 'MFA_REQUIRED') {
    return (
      <div className="mx-auto my-12 w-full max-w-sm rounded-2xl border border-amber-200 bg-white p-6 shadow-xl dark:border-amber-900/40 dark:bg-slate-900" data-testid="admin-mfa-challenge">
        <SecondFactorPrompt status={status}
          heading={t('Xác thực hai lớp', 'Two-step verification')}
          hint={t('Khu vực quản trị cần lớp bảo mật thứ hai cho phiên đăng nhập này.', 'The administrator area needs your second factor for this sign-in.')}
          onVerified={() => { void mutate(); void reloadRole(); }} />
      </div>
    );
  }

  if (status.adminAccess === 'ENROLLMENT_REQUIRED' && !onSecurityPage) {
    return (
      <div className="mx-auto my-16 max-w-md rounded-2xl border border-amber-200 bg-white p-6 text-center shadow-xl dark:border-amber-900/40 dark:bg-slate-900" data-testid="admin-mfa-enrollment-required">
        <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-amber-500" aria-hidden />
        <h2 className="mb-2 text-lg font-bold text-slate-900 dark:text-white">{t('Cần bật xác thực hai lớp', 'Two-step verification is required')}</h2>
        <p className="mb-6 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          {t('Tài khoản quản trị phải có lớp bảo mật thứ hai trước khi dùng các công cụ quản trị.', 'The administrator account needs a second factor before any administrator tool can be used.')}
        </p>
        <Link href="/admin/security" className="inline-flex rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-white hover:bg-amber-600">
          {t('Thiết lập ngay', 'Set it up now')}
        </Link>
      </div>
    );
  }

  return (
    <>
      {!status.enrolled && !onSecurityPage && (
        <div className="mx-auto mt-4 flex w-full max-w-4xl items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100" data-testid="admin-mfa-nudge">
          <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
          <span className="flex-1">{t('Tài khoản quản trị chưa bật xác thực hai lớp.', 'The administrator account has no second factor yet.')}</span>
          <Link href="/admin/security" className="font-bold underline underline-offset-2">{t('Thiết lập', 'Set up')}</Link>
        </div>
      )}
      {children}
      <StepUpHost status={status} onChanged={() => { void mutate(); }} />
    </>
  );
}

/** The dialog a sensitive administrator action opens when the backend asks for a fresh second-factor proof. */
function StepUpHost({ status, onChanged }: { status: MfaStatus; onChanged: () => void }) {
  const { t } = useSecondFactorMessages();
  const [open, setOpen] = useState(false);
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  const finish = useCallback((confirmed: boolean) => {
    setOpen(false);
    resolver.current?.(confirmed);
    resolver.current = null;
    if (confirmed) onChanged();
  }, [onChanged]);

  useEffect(() => {
    registerStepUpPrompt(() => new Promise<boolean>((resolve) => {
      resolver.current?.(false);
      resolver.current = resolve;
      setOpen(true);
    }));
    return () => { registerStepUpPrompt(null); resolver.current?.(false); resolver.current = null; };
  }, []);

  useEffect(() => {
    if (!open) return;
    dialog.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, finish]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-950/70 p-4" data-testid="admin-step-up">
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={t('Xác nhận lại lớp bảo mật thứ hai', 'Confirm your second factor again')} tabIndex={-1}
        className="relative w-full max-w-sm rounded-2xl border border-amber-200 bg-white p-6 shadow-2xl outline-hidden dark:border-amber-900/40 dark:bg-slate-900">
        <button type="button" onClick={() => finish(false)} aria-label={t('Đóng', 'Close')}
          className="absolute right-3 top-3 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200">
          <X className="h-4 w-4" aria-hidden />
        </button>
        <SecondFactorPrompt status={status}
          heading={t('Xác nhận thao tác nhạy cảm', 'Confirm this sensitive action')}
          hint={t(`Thao tác này cần xác nhận lớp bảo mật thứ hai trong vòng ${status.stepUpMinutes} phút gần nhất.`,
            `This action needs your second factor confirmed within the last ${status.stepUpMinutes} minutes.`)}
          onVerified={() => finish(true)} />
        <p className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-slate-400">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />{t('Thao tác sẽ tự tiếp tục sau khi xác nhận.', 'The action continues by itself once confirmed.')}
        </p>
      </div>
    </div>
  );
}
