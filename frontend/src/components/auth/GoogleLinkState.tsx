'use client';

import React, { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Lock, Eye, EyeOff, Loader2, AlertCircle, Link2, ArrowLeft } from 'lucide-react';
import s from './authGlass.module.css';
import { MascotState } from './AuthEchoMascot';
import { useLanguage } from '@/context/LanguageContext';
import { beginAuthenticatedSession } from '@/lib/auth-lifecycle';
import { journeyActive, journeyGo } from '@/lib/journey/journey';
import { sanitizeLocalPath } from '@/lib/sanitize-local-path';

interface GoogleLinkStateProps {
  email: string;
  ticket: string;
  callbackUrl?: string;
  onCancel: () => void;
  onMascotStateChange: (state: MascotState) => void;
}

export function GoogleLinkState({
  email,
  ticket,
  callbackUrl = '/dashboard',
  onCancel,
  onMascotStateChange,
}: GoogleLinkStateProps) {
  const router = useRouter();
  const { locale } = useLanguage();
  const t = (vi: string, en: string) => (locale === 'vi' ? vi : en);

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const safeCallbackUrl = sanitizeLocalPath(callbackUrl, '/dashboard');

  const handleCancel = () => {
    if (typeof window !== 'undefined') {
      window.history.replaceState({}, '', `/login?callbackUrl=${encodeURIComponent(safeCallbackUrl)}`);
    }
    onCancel();
  };

  const handleLinkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      setErrorMessage(t('Vui lòng nhập mật khẩu tài khoản hiện tại.', 'Please enter current account password.'));
      onMascotStateChange('error');
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);
    onMascotStateChange('submitting');

    try {
      // The link is made by the server (NextAuth credentials provider): the page sends the ticket and the
      // password and receives a signed-in session, never a session grant.
      const loginRes = await signIn('credentials', {
        redirect: false,
        linkTicket: ticket,
        password,
        callbackUrl: safeCallbackUrl,
      });

      if (loginRes?.ok && !loginRes.error) {
        onMascotStateChange('success');
        // Clean query state from URL to prevent stale link prompt
        if (typeof window !== 'undefined') {
          window.history.replaceState({}, '', `/login?callbackUrl=${encodeURIComponent(safeCallbackUrl)}`);
        }
        beginAuthenticatedSession();
        if (!journeyActive() && !journeyGo(safeCallbackUrl)) router.push(safeCallbackUrl);
      } else if (loginRes?.error?.includes('RATE_LIMIT')) {
        onMascotStateChange('error');
        setErrorMessage(t('Quá nhiều lần thử. Vui lòng thử lại sau ít phút.', 'Too many attempts. Please try again shortly.'));
      } else {
        onMascotStateChange('error');
        setErrorMessage(t('Mật khẩu không chính xác hoặc mã liên kết đã hết hạn.', 'Incorrect password or link ticket has expired.'));
      }
    } catch {
      onMascotStateChange('error');
      setErrorMessage(t('Lỗi kết nối đến máy chủ. Vui lòng thử lại.', 'Could not connect to server. Please try again.'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className={s.stack} data-purpose="google-link-state">
      {/* Header */}
      <div className={s.head}>
        <div className={`${s.badgeTile} mb-3`} aria-hidden="true">
          <Link2 className="w-6 h-6" />
        </div>
        <h2 className={s.title}>
          {t('Xác nhận liên kết Google 🔗', 'Confirm Google Link 🔗')}
        </h2>
        <p className={s.lede}>
          {t('Email', 'Email')}{' '}
          <span className={s.strong}>{email}</span>{' '}
          {t(
            'đã có tài khoản English Coach. Vui lòng xác nhận mật khẩu hiện tại để liên kết tài khoản Google.',
            'already has an English Coach account. Please confirm your current password to link your Google account.'
          )}
        </p>
      </div>

      {/* Error Alert */}
      {errorMessage && (
        <div
          role="alert"
          className={s.alert}
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Form */}
      <form onSubmit={handleLinkSubmit} className={s.form} noValidate>
        <div className="space-y-1.5">
          <label htmlFor="link-password" className={s.label}>
            {t('Mật khẩu hiện tại của tài khoản', 'Current account password')}
          </label>
          <div className={s.field}>
            <div className={s.fieldIcon} aria-hidden="true">
              <Lock className="w-4 h-4" />
            </div>
            <input
              id="link-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onFocus={() => onMascotStateChange('password-focus')}
              onBlur={() => onMascotStateChange('idle')}
              placeholder="••••••••••••"
              disabled={isLoading}
              className={s.input}
            />
            <button
              type="button"
              onClick={() => {
                const next = !showPassword;
                setShowPassword(next);
                onMascotStateChange(next ? 'password-visible' : 'password-focus');
              }}
              className={s.eye}
              aria-label={showPassword ? t('Ẩn mật khẩu', 'Hide password') : t('Hiện mật khẩu', 'Show password')}
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Submit */}
        <button
          type="submit"
          disabled={isLoading}
          className={s.cta}
        >
          {isLoading ? (
            <>
              <Loader2 className={`${s.spin} w-4 h-4`} />
              <span>{t('Đang liên kết tài khoản...', 'Linking account...')}</span>
            </>
          ) : (
            <span>{t('Xác nhận liên kết Google', 'Confirm Google Link')}</span>
          )}
        </button>
      </form>

      {/* Cancel action */}
      <div className={s.switch}>
        <button
          type="button"
          onClick={handleCancel}
          className={`${s.ghost} inline-flex items-center gap-1.5`}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>{t('Hủy và quay lại đăng nhập', 'Cancel and return to sign in')}</span>
        </button>
      </div>
    </div>
  );
}

export default GoogleLinkState;
