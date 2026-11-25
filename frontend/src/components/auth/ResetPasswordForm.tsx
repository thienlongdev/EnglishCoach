'use client';

import React, { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, Eye, EyeOff, Loader2, AlertCircle, CheckCircle2, Check, X } from 'lucide-react';
import s from './authGlass.module.css';
import { MascotState } from './AuthEchoMascot';
import { useLanguage } from '@/context/LanguageContext';

interface ResetPasswordFormProps {
  token: string;
  onMascotStateChange: (state: MascotState) => void;
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

export function ResetPasswordForm({ token, onMascotStateChange }: ResetPasswordFormProps) {
  const router = useRouter();
  const { locale } = useLanguage();
  const t = (vi: string, en: string) => (locale === 'vi' ? vi : en);

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Policy validation matching PasswordPolicyService
  const policyStatus = useMemo(() => {
    const codePoints = Array.from(newPassword).length;
    const utf8Bytes = new TextEncoder().encode(newPassword).length;
    const isMinLength = codePoints >= 15;
    const isUnderMaxBytes = utf8Bytes <= 72;
    const passwordsMatch = confirmPassword.length > 0 && newPassword === confirmPassword;

    return {
      isMinLength,
      isUnderMaxBytes,
      passwordsMatch,
      isValid: isMinLength && isUnderMaxBytes && (confirmPassword ? passwordsMatch : false),
    };
  }, [newPassword, confirmPassword]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!token) {
      setErrorMessage(t('Liên kết đặt lại mật khẩu không hợp lệ hoặc thiếu mã xác thực.', 'Password reset link is invalid or missing token.'));
      onMascotStateChange('error');
      return;
    }
    if (!policyStatus.isMinLength) {
      setErrorMessage(t('Mật khẩu mới phải có ít nhất 15 ký tự.', 'New password must have at least 15 characters.'));
      onMascotStateChange('error');
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMessage(t('Mật khẩu xác nhận không trùng khớp.', 'Confirmation password does not match.'));
      onMascotStateChange('error');
      return;
    }

    setIsLoading(true);
    onMascotStateChange('submitting');

    try {
      const csrfHeaders = await getCsrfHeader();
      const res = await fetch('/api/v1/auth/reset-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...csrfHeaders,
        },
        body: JSON.stringify({
          token,
          newPassword,
        }),
      });

      if (res.status === 204 || res.ok) {
        onMascotStateChange('success');
        setIsSuccess(true);
      } else if (res.status === 400) {
        const data = await res.json().catch(() => ({}));
        onMascotStateChange('error');
        setErrorMessage(data.message || t('Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.', 'Password reset link is invalid or has expired.'));
      } else if (res.status === 429) {
        onMascotStateChange('error');
        setErrorMessage(t('Quá nhiều yêu cầu. Vui lòng thử lại sau ít phút.', 'Too many requests. Please try again in a few minutes.'));
      } else {
        onMascotStateChange('error');
        setErrorMessage(t('Không thể đặt lại mật khẩu lúc này. Vui lòng thử lại.', 'Unable to reset password right now. Please try again.'));
      }
    } catch {
      onMascotStateChange('error');
      setErrorMessage(t('Lỗi kết nối đến máy chủ. Vui lòng thử lại.', 'Could not connect to server. Please try again.'));
    } finally {
      setIsLoading(false);
    }
  };

  if (isSuccess) {
    return (
      <div className={`${s.stack} ${s.center}`} data-purpose="reset-password-success">
        <div className={s.badgeTile} data-tone="ok" aria-hidden="true">
          <CheckCircle2 className="w-7 h-7" />
        </div>

        <div className={s.head}>
          <h2 className={s.title}>
            {t('Cập nhật thành công! 🎉', 'Password Updated! 🎉')}
          </h2>
          <p className={s.lede}>
            {t('Mật khẩu mới của bạn đã được lưu an toàn. Tất cả phiên đăng nhập trước đó đã được hủy để bảo vệ tài khoản.', 'Your new password has been saved securely. All previous sessions have been revoked.')}
          </p>
        </div>

        <div className="pt-2">
          <button
            type="button"
            onClick={() => router.push('/login')}
            className={s.cta}
          >
            {t('Đăng nhập ngay', 'Sign in now')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={s.stack} data-purpose="reset-password-form">
      {/* Header */}
      <div className={s.head}>
        <h2 className={s.title}>
          {t('Đặt lại mật khẩu mới 🛡️', 'Set New Password 🛡️')}
        </h2>
        <p className={s.lede}>
          {t('Tạo mật khẩu mới cho tài khoản English Coach của bạn.', 'Create a new password for your English Coach account.')}
        </p>
      </div>

      {/* Error Alert */}
      {errorMessage && (
        <div
          role="alert"
          className={s.alert}
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="space-y-1.5 flex-1">
            <span>{errorMessage}</span>
            {errorMessage.includes('hết hạn') && (
              <div>
                <button
                  type="button"
                  onClick={() => router.push('/forgot-password')}
                  className={`${s.link} ${s.small} block mt-1`}
                >
                  {t('Yêu cầu liên kết mới →', 'Request new link →')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Form */}
      <form onSubmit={handleSubmit} className={s.form} noValidate>
        {/* New Password */}
        <div className="space-y-1.5">
          <label htmlFor="reset-new-password" className={s.label}>
            {t('Mật khẩu mới', 'New password')}
          </label>
          <div className={s.field}>
            <div className={s.fieldIcon} aria-hidden="true">
              <Lock className="w-4 h-4" />
            </div>
            <input
              id="reset-new-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              onFocus={() => onMascotStateChange('password-focus')}
              onBlur={() => onMascotStateChange('idle')}
              placeholder={t('Tối thiểu 15 ký tự...', 'At least 15 characters...')}
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

        {/* Confirm Password */}
        <div className="space-y-1.5">
          <label htmlFor="reset-confirm-password" className={s.label}>
            {t('Xác nhận mật khẩu mới', 'Confirm new password')}
          </label>
          <div className={s.field}>
            <div className={s.fieldIcon} aria-hidden="true">
              <CheckCircle2 className="w-4 h-4" />
            </div>
            <input
              id="reset-confirm-password"
              type={showConfirmPassword ? 'text' : 'password'}
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              onFocus={() => onMascotStateChange('password-focus')}
              onBlur={() => onMascotStateChange('idle')}
              placeholder={t('Nhập lại mật khẩu...', 'Re-enter password...')}
              disabled={isLoading}
              className={s.input}
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              className={s.eye}
              aria-label={showConfirmPassword ? t('Ẩn mật khẩu', 'Hide password') : t('Hiện mật khẩu', 'Show password')}
            >
              {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Policy Checklist */}
        {newPassword.length > 0 && (
          <div className={s.policy}>
            <span className={s.policyTitle}>{t('Yêu cầu bảo mật:', 'Security requirements:')}</span>
            <div className={s.policyGrid}>
              <div className={s.policyItem} data-state={policyStatus.isMinLength ? 'ok' : 'idle'}>
                {policyStatus.isMinLength ? <Check className="w-3.5 h-3.5 shrink-0" /> : <X className="w-3.5 h-3.5 shrink-0" />}
                <span>{t('Ít nhất 15 ký tự', 'At least 15 characters')} ({Array.from(newPassword).length}/15)</span>
              </div>
              <div className={s.policyItem} data-state={policyStatus.isUnderMaxBytes ? 'ok' : 'bad'}>
                {policyStatus.isUnderMaxBytes ? <Check className="w-3.5 h-3.5 shrink-0" /> : <X className="w-3.5 h-3.5 shrink-0" />}
                <span>{t('Tối đa 72 bytes UTF-8', 'Max 72 UTF-8 bytes')}</span>
              </div>
              <div className={s.policyItem} data-state={policyStatus.passwordsMatch ? 'ok' : 'idle'}>
                {policyStatus.passwordsMatch ? <Check className="w-3.5 h-3.5 shrink-0" /> : <X className="w-3.5 h-3.5 shrink-0" />}
                <span>{t('Khớp mật khẩu xác nhận', 'Passwords match')}</span>
              </div>
            </div>
          </div>
        )}

        {/* Action Button */}
        <button
          type="submit"
          disabled={isLoading}
          className={s.cta}
        >
          {isLoading ? (
            <>
              <Loader2 className={`${s.spin} w-4 h-4`} />
              <span>{t('Đang cập nhật mật khẩu...', 'Updating password...')}</span>
            </>
          ) : (
            <span>{t('Cập nhật mật khẩu mới', 'Update New Password')}</span>
          )}
        </button>
      </form>
    </div>
  );
}

export default ResetPasswordForm;
