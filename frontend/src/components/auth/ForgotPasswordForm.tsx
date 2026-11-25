'use client';

import React, { useState, useRef } from 'react';
import { Mail, ArrowLeft, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import s from './authGlass.module.css';
import { TurnstileChallenge, TurnstileChallengeRef } from './TurnstileChallenge';
import { MascotState } from './AuthEchoMascot';
import { useLanguage } from '@/context/LanguageContext';

interface ForgotPasswordFormProps {
  onBackToLogin: () => void;
  onMascotStateChange: (state: MascotState) => void;
  initialEmail?: string;
  readOnlyEmail?: boolean;
  backButtonLabel?: string;
}

// Attach CSRF header for state-changing BFF requests
async function getCsrfHeader(): Promise<{ [key: string]: string }> {
  if (typeof document === 'undefined') return {};
  let match = document.cookie.match(/ec\.csrf=([^;]+)/);
  if (!match || !match[1]) {
    try {
      const res = await fetch('/api/auth/csrf-context');
      if (res.ok) {
        const data = await res.json();
        if (data.csrfToken) {
          return { 'X-CSRF-Token': data.csrfToken };
        }
      }
    } catch {}
    match = document.cookie.match(/ec\.csrf=([^;]+)/);
  }
  return match && match[1] ? { 'X-CSRF-Token': match[1] } : {};
}

export function ForgotPasswordForm({
  onBackToLogin,
  onMascotStateChange,
  initialEmail = '',
  readOnlyEmail = false,
  backButtonLabel,
}: ForgotPasswordFormProps) {
  const { locale } = useLanguage();
  const t = (vi: string, en: string) => (locale === 'vi' ? vi : en);

  const [email, setEmail] = useState(initialEmail);
  const [, setTurnstileToken] = useState('');
  const submitting = useRef(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  React.useEffect(() => {
    if (initialEmail) {
      setEmail(initialEmail);
    }
  }, [initialEmail]);

  const turnstileRef = useRef<TurnstileChallengeRef>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !email.includes('@')) {
      setErrorMessage(t('Vui lòng nhập địa chỉ email hợp lệ.', 'Please enter a valid email address.'));
      onMascotStateChange('error');
      return;
    }

    if (submitting.current) return;
    submitting.current = true;
    setIsLoading(true);
    setErrorMessage(null);
    onMascotStateChange('submitting');

    try {
      const csrfHeaders = await getCsrfHeader();
      const token = await turnstileRef.current?.freshToken();
      if (token === null) {
        onMascotStateChange('error');
        setErrorMessage(t('Vui lòng hoàn thành ô xác minh chống bot rồi gửi lại.', 'Please complete the anti-bot challenge, then send again.'));
        return;
      }
      const res = await fetch('/api/v1/auth/forgot-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...csrfHeaders,
        },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          turnstileToken: token || undefined,
        }),
      });

      // Always show generic confirmation response (202 Accepted) to protect against email enumeration
      if (res.status === 202 || res.ok) {
        onMascotStateChange('success');
        setIsSubmitted(true);
        turnstileRef.current?.reset();
        setTurnstileToken('');
      } else if (res.status === 429) {
        onMascotStateChange('error');
        setErrorMessage(t('Quá nhiều yêu cầu khôi phục mật khẩu. Vui lòng thử lại sau.', 'Too many password reset requests. Please try again later.'));
        turnstileRef.current?.reset();
        setTurnstileToken('');
      } else {
        const data = await res.json().catch(() => ({}));
        onMascotStateChange('error');
        if (data.code === 'CAPTCHA_FAILED') {
          setErrorMessage(data.message || t('Xác thực chống bot không thành công hoặc đã hết hạn. Vui lòng thử lại.', 'Anti-bot verification failed or expired. Please try again.'));
        } else {
          setErrorMessage(data.message || t('Không thể xử lý yêu cầu lúc này. Vui lòng thử lại.', 'Unable to process request right now. Please try again.'));
        }
        turnstileRef.current?.reset();
        setTurnstileToken('');
      }
    } catch (err) {
      onMascotStateChange('error');
      setErrorMessage(t('Lỗi kết nối đến máy chủ. Vui lòng thử lại.', 'Could not connect to server. Please try again.'));
      turnstileRef.current?.reset();
      setTurnstileToken('');
    } finally {
      setIsLoading(false);
      submitting.current = false;
    }
  };

  if (isSubmitted) {
    return (
      <div className={`${s.stack} ${s.center}`} data-purpose="forgot-password-success">
        <div className={s.badgeTile} data-tone="ok" aria-hidden="true">
          <CheckCircle2 className="w-7 h-7" />
        </div>

        <div className={s.head}>
          <h2 className={s.title}>
            {t('Yêu cầu đã được tiếp nhận 📨', 'Request Accepted 📨')}
          </h2>
          <p className={s.lede}>
            {t('Nếu email', 'If the email')}{' '}
            <span className={s.strong}>{email}</span>{' '}
            {t(
              'hợp lệ trong hệ thống, hướng dẫn đặt lại mật khẩu sẽ được gửi đến hộp thư của bạn.',
              'is eligible in our system, password reset instructions will be sent to your inbox.'
            )}
          </p>
          <p className={`${s.lede} ${s.small}`}>
            {t('Liên kết có hiệu lực trong vòng 15 phút. Vui lòng kiểm tra cả thư mục Spam.', 'The link is valid for 15 minutes. Please check your Spam folder as well.')}
          </p>
        </div>

        <div className="pt-2">
          <button
            type="button"
            onClick={onBackToLogin}
            className={s.cta}
          >
            {backButtonLabel || t('Quay lại đăng nhập', 'Back to Sign In')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={s.stack} data-purpose="forgot-password-form">
      {/* Header */}
      <div className={s.head}>
        <h2 className={s.title}>
          {t('Khôi phục mật khẩu 🔑', 'Reset Password 🔑')}
        </h2>
        <p className={s.lede}>
          {t('Nhập email của bạn. Chúng tôi sẽ gửi hướng dẫn đặt lại mật khẩu nếu tài khoản hợp lệ.', 'Enter your email. We will send password reset instructions if the account is valid.')}
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
      <form onSubmit={handleSubmit} className={s.form} noValidate>
        <div className="space-y-1.5">
          <label htmlFor="forgot-email" className={s.label}>
            {t('Địa chỉ email tài khoản', 'Account email address')}
          </label>
          <div className={s.field}>
            <div className={s.fieldIcon} aria-hidden="true">
              <Mail className="w-4 h-4" />
            </div>
            <input
              id="forgot-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              readOnly={readOnlyEmail}
              onChange={(e) => !readOnlyEmail && setEmail(e.target.value)}
              onFocus={() => onMascotStateChange('email-focus')}
              onBlur={() => onMascotStateChange('idle')}
              placeholder="learner@englishcoach.app"
              disabled={isLoading}
              className={s.input}
            />
          </div>
          {readOnlyEmail && (
            <p className={s.hint}>
              {t('Hướng dẫn đặt lại sẽ được gửi đến email tài khoản đang đăng nhập này', 'Reset instructions will be sent to this active account email')}
            </p>
          )}
        </div>

        {/* Turnstile Anti-bot Challenge */}
        <TurnstileChallenge
          ref={turnstileRef}
          action="forgot-password"
          onVerify={(token) => setTurnstileToken(token)}
          onError={() => setTurnstileToken('')}
        />

        {/* Action Button */}
        <button
          type="submit"
          disabled={isLoading}
          className={s.cta}
        >
          {isLoading ? (
            <>
              <Loader2 className={`${s.spin} w-4 h-4`} />
              <span>{t('Đang gửi yêu cầu...', 'Sending request...')}</span>
            </>
          ) : (
            <span>{t('Gửi hướng dẫn khôi phục', 'Send Reset Instructions')}</span>
          )}
        </button>
      </form>

      {/* Back to Login */}
      <div className={s.switch}>
        <button
          type="button"
          onClick={onBackToLogin}
          className={`${s.ghost} inline-flex items-center gap-1.5`}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>{backButtonLabel || t('Quay lại đăng nhập', 'Back to Sign In')}</span>
        </button>
      </div>
    </div>
  );
}

export default ForgotPasswordForm;
