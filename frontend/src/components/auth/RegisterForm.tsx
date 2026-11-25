'use client';

import React, { useState, useRef, useMemo } from 'react';
import { signIn } from 'next-auth/react';
import { cancelJourney, journeyLeaveForExternal } from '@/lib/journey/journey';
import { sanitizeLocalPath } from '@/lib/sanitize-local-path';
import { User, Mail, Lock, CheckCircle2, Eye, EyeOff, Loader2, AlertCircle, Check, X, MailCheck, ArrowRight } from 'lucide-react';
import { GoogleAuthButton } from './GoogleAuthButton';
import { TurnstileChallenge, TurnstileChallengeRef } from './TurnstileChallenge';
import { MascotState } from './AuthEchoMascot';
import { VerificationMailPanel, type MailDelivery } from './VerificationMailPanel';
import { useLanguage } from '@/context/LanguageContext';
import s from './authGlass.module.css';

interface RegisterFormProps {
  callbackUrl?: string;
  onSwitchToLogin: () => void;
  onMascotStateChange: (state: MascotState) => void;
}

// Ensure CSRF token is available for state-changing BFF requests
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

export function RegisterForm({
  callbackUrl = '/dashboard',
  onSwitchToLogin,
  onMascotStateChange,
}: RegisterFormProps) {
  const { locale } = useLanguage();
  const t = (vi: string, en: string) => (locale === 'vi' ? vi : en);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [, setTurnstileToken] = useState('');
  const submitting = useRef(false);

  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);

  const [delivery, setDelivery] = useState<MailDelivery>(null);

  const turnstileRef = useRef<TurnstileChallengeRef>(null);

  const safeCallbackUrl = sanitizeLocalPath(callbackUrl, '/dashboard');

  // Live password policy evaluation strictly matching backend PasswordPolicyService
  const policyStatus = useMemo(() => {
    const trimmedPass = password;
    const codePoints = Array.from(trimmedPass).length;
    const utf8Bytes = new TextEncoder().encode(trimmedPass).length;
    const emailPrefix = email.includes('@') ? email.split('@')[0].toLowerCase() : '';

    const isMinLength = codePoints >= 15;
    const isUnderMaxBytes = utf8Bytes <= 72;
    const noEmailUsername =
      emailPrefix.length >= 4 ? !trimmedPass.toLowerCase().includes(emailPrefix) : true;
    const passwordsMatch = confirmPassword.length > 0 && password === confirmPassword;

    return {
      isMinLength,
      isUnderMaxBytes,
      noEmailUsername,
      passwordsMatch,
      isValid: isMinLength && isUnderMaxBytes && noEmailUsername && (confirmPassword ? passwordsMatch : false),
    };
  }, [password, confirmPassword, email]);

  const handleGoogleRegister = async () => {
    setIsGoogleLoading(true);
    setErrorMessage(null);
    onMascotStateChange('submitting');
    try {
      journeyLeaveForExternal(safeCallbackUrl);
      await signIn('google', { callbackUrl: safeCallbackUrl });
    } catch (err) {
      cancelJourney();
      setIsGoogleLoading(false);
      onMascotStateChange('error');
      setErrorMessage(t('Không thể kết nối với tài khoản Google. Vui lòng thử lại.', 'Could not connect to Google account. Please try again.'));
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    // Client-side validation
    if (!name.trim() || name.trim().length < 2) {
      setErrorMessage(t('Họ và tên cần có ít nhất 2 ký tự.', 'Full name must have at least 2 characters.'));
      onMascotStateChange('error');
      return;
    }
    if (!email.trim() || !email.includes('@')) {
      setErrorMessage(t('Vui lòng nhập địa chỉ email hợp lệ.', 'Please enter a valid email address.'));
      onMascotStateChange('error');
      return;
    }
    if (!policyStatus.isMinLength) {
      setErrorMessage(t('Mật khẩu cần có độ dài tối thiểu 15 ký tự theo chính sách bảo mật.', 'Password must be at least 15 characters according to security policy.'));
      onMascotStateChange('error');
      return;
    }
    if (!policyStatus.isUnderMaxBytes) {
      setErrorMessage(t('Mật khẩu không được vượt quá 72 bytes.', 'Password cannot exceed 72 bytes.'));
      onMascotStateChange('error');
      return;
    }
    if (!policyStatus.noEmailUsername) {
      setErrorMessage(t('Mật khẩu không được chứa phần tên của địa chỉ email.', 'Password cannot contain the email username.'));
      onMascotStateChange('error');
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage(t('Mật khẩu xác nhận không trùng khớp.', 'Confirmation password does not match.'));
      onMascotStateChange('error');
      return;
    }

    if (submitting.current) return;
    submitting.current = true;
    setIsLoading(true);
    onMascotStateChange('submitting');

    try {
      const csrfHeaders = await getCsrfHeader();
      const send = async () => {
        const token = await turnstileRef.current?.freshToken();
        if (token === null) return null;
        return fetch('/api/v1/auth/register', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...csrfHeaders,
          },
          body: JSON.stringify({
            name: name.trim(),
            email: email.trim().toLowerCase(),
            password,
            turnstileToken: token || undefined,
          }),
        });
      };
      let res = await send();
      // A token that ran out while the form was being filled in: one new real challenge, verified by the server as always.
      if (res?.status === 400) {
        const first = await res.clone().json().catch(() => ({}));
        if (first.code === 'CAPTCHA_FAILED' && !String(first.message).includes('temporarily unavailable')) {
          turnstileRef.current?.reset();
          res = await send();
        }
      }
      if (res === null) {
        setIsLoading(false);
        onMascotStateChange('error');
        setErrorMessage(t('Vui lòng hoàn thành ô xác minh chống bot rồi bấm đăng ký lại.', 'Please complete the anti-bot challenge, then submit again.'));
        return;
      }

      if (res.status === 202) {
        // Accepted: the server already handed the mail to the provider and says what the provider answered
        // (a new address and an existing one both get a mail, so this reveals nothing about the account).
        const data = await res.json().catch(() => ({}));
        const answer = data?.delivery;
        setDelivery(answer === 'SENT' || answer === 'FAILED' || answer === 'SIMULATED' ? answer : null);
        onMascotStateChange(answer === 'FAILED' ? 'error' : 'success');
        setRegisteredEmail(email.trim().toLowerCase());
        setIsLoading(false);
      } else if (res.status === 422 || res.status === 400) {
        const data = await res.json().catch(() => ({}));
        setIsLoading(false);
        onMascotStateChange('error');
        if (data.code === 'CAPTCHA_FAILED') {
          setErrorMessage(data.message || t('Xác thực chống bot không thành công hoặc đã hết hạn. Vui lòng thử lại.', 'Anti-bot verification failed or expired. Please try again.'));
        } else {
          setErrorMessage(data.message || t('Thông tin đăng ký không hợp lệ.', 'Invalid registration information.'));
        }
        turnstileRef.current?.reset();
        setTurnstileToken('');
      } else if (res.status === 429) {
        setIsLoading(false);
        onMascotStateChange('error');
        setErrorMessage(t('Quá nhiều lượt đăng ký từ mạng này. Vui lòng thử lại sau.', 'Too many registrations from this network. Please try again later.'));
        turnstileRef.current?.reset();
        setTurnstileToken('');
      } else {
        setIsLoading(false);
        onMascotStateChange('error');
        setErrorMessage(t('Không thể hoàn tất đăng ký vào lúc này. Vui lòng thử lại.', 'Unable to complete registration at this time. Please try again.'));
        turnstileRef.current?.reset();
        setTurnstileToken('');
      }
    } catch (err) {
      setIsLoading(false);
      onMascotStateChange('error');
      setErrorMessage(t('Lỗi kết nối đến máy chủ. Vui lòng thử lại.', 'Could not connect to server. Please try again.'));
      turnstileRef.current?.reset();
      setTurnstileToken('');
    } finally {
      submitting.current = false;
    }
  };

  // State: Successful Registration -> Verification notice
  if (registeredEmail) {
    const failed = delivery === 'FAILED';
    return (
      <div className={`${s.stack} ${s.center}`} data-purpose="registration-success-notice" data-delivery={delivery ?? 'unknown'}>
        <div className={s.badgeTile} data-tone={failed ? 'bad' : undefined} aria-hidden="true">
          {failed ? <AlertCircle className="w-8 h-8" /> : <MailCheck className="w-8 h-8" />}
        </div>

        <div className={s.head}>
          <h2 className={s.title}>{failed ? t('Chưa gửi được email', 'The email was not sent yet') : t('Kiểm tra hộp thư của bạn', 'Check your inbox')}</h2>
          <p className={s.lede}>
            {failed
              ? t('Yêu cầu đăng ký đã được ghi nhận, nhưng dịch vụ thư chưa nhận email gửi tới:', 'Your registration was recorded, but the mail service did not accept the email to:')
              : t('Chúng tôi vừa gửi email tới địa chỉ dưới đây. Mở thư và bấm liên kết để kích hoạt tài khoản trước khi đăng nhập.', 'We just sent an email to the address below. Open it and follow the link to activate your account before signing in.')}
          </p>
          <p className="mt-3"><span className={s.emailChip}>{registeredEmail}</span></p>
        </div>

        <VerificationMailPanel email={registeredEmail} delivery={delivery} />

        <button type="button" onClick={onSwitchToLogin} className={s.cta}>
          <span>{t('Đến trang đăng nhập', 'Go to sign in')}</span>
          <ArrowRight className={`${s.ctaArrow} w-[18px] h-[18px]`} aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={() => {
            setRegisteredEmail(null);
            setDelivery(null);
            setTurnstileToken('');
            onMascotStateChange('idle');
          }}
          className={s.ghost}
          data-purpose="registration-change-address"
        >
          {t('Sai địa chỉ email? Đăng ký lại', 'Wrong address? Register again')}
        </button>
      </div>
    );
  }

  const busy = isLoading || isGoogleLoading;
  const policyState = (ok: boolean, idleWhenFalse: boolean) => (ok ? 'ok' : idleWhenFalse ? 'idle' : 'bad');
  const mark = (ok: boolean) => (ok ? <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> : <X className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />);

  return (
    <div className={s.stack} data-purpose="register-form">
      {/* Form Header */}
      <div className={s.head}>
        <h2 className={s.title}>{t('Tạo tài khoản mới', 'Create a new account')}</h2>
        <p className={s.lede}>
          {t('Đăng ký miễn phí và bắt đầu hành trình cùng Echo.', 'Sign up for free and start your journey with Echo.')}
        </p>
      </div>

      {/* Google Authentication Button */}
      <GoogleAuthButton
        onClick={handleGoogleRegister}
        isLoading={isGoogleLoading}
        disabled={isLoading}
        label={t('Đăng ký bằng Google', 'Sign up with Google')}
      />

      <div className={s.divider}>{t('hoặc đăng ký với email', 'or register with email')}</div>

      {/* Error Announcement */}
      {errorMessage && (
        <div role="alert" className={s.alert}>
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Registration Fields */}
      <form onSubmit={handleRegisterSubmit} className={s.form} noValidate>
        {/* Full Name */}
        <div className={s.field} data-disabled={busy}>
          <span className={s.fieldIcon} aria-hidden="true"><User className="w-[18px] h-[18px]" /></span>
          <span className={s.fieldBody}>
            <label htmlFor="register-name" className={s.label}>{t('Họ và tên', 'Full name')}</label>
            <input
              id="register-name"
              type="text"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              onFocus={() => onMascotStateChange('email-focus')}
              onBlur={() => onMascotStateChange('idle')}
              placeholder={t('Nguyễn Văn A', 'John Doe')}
              disabled={busy}
              className={s.input}
            />
          </span>
        </div>

        {/* Email */}
        <div className={s.field} data-disabled={busy}>
          <span className={s.fieldIcon} aria-hidden="true"><Mail className="w-[18px] h-[18px]" /></span>
          <span className={s.fieldBody}>
            <label htmlFor="register-email" className={s.label}>{t('Email', 'Email')}</label>
            <input
              id="register-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onFocus={() => onMascotStateChange('email-focus')}
              onBlur={() => onMascotStateChange('idle')}
              placeholder="learner@englishcoach.app"
              disabled={busy}
              className={s.input}
            />
          </span>
        </div>

        {/* Password */}
        <div className={s.field} data-disabled={busy}>
          <span className={s.fieldIcon} aria-hidden="true"><Lock className="w-[18px] h-[18px]" /></span>
          <span className={s.fieldBody}>
            <label htmlFor="register-password" className={s.label}>{t('Mật khẩu', 'Password')}</label>
            <input
              id="register-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onFocus={() => onMascotStateChange('password-focus')}
              onBlur={() => onMascotStateChange('idle')}
              placeholder={t('Tối thiểu 15 ký tự...', 'At least 15 characters...')}
              disabled={busy}
              className={s.input}
            />
          </span>
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
            {showPassword ? <EyeOff className="w-[18px] h-[18px]" /> : <Eye className="w-[18px] h-[18px]" />}
          </button>
        </div>

        {/* Confirm Password */}
        <div className={s.field} data-disabled={busy}>
          <span className={s.fieldIcon} aria-hidden="true"><CheckCircle2 className="w-[18px] h-[18px]" /></span>
          <span className={s.fieldBody}>
            <label htmlFor="register-confirm-password" className={s.label}>{t('Xác nhận mật khẩu', 'Confirm password')}</label>
            <input
              id="register-confirm-password"
              type={showConfirmPassword ? 'text' : 'password'}
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              onFocus={() => onMascotStateChange('password-focus')}
              onBlur={() => onMascotStateChange('idle')}
              placeholder={t('Nhập lại mật khẩu...', 'Re-enter password...')}
              disabled={busy}
              className={s.input}
            />
          </span>
          <button
            type="button"
            onClick={() => setShowConfirmPassword(!showConfirmPassword)}
            className={s.eye}
            aria-label={showConfirmPassword ? t('Ẩn mật khẩu', 'Hide password') : t('Hiện mật khẩu', 'Show password')}
          >
            {showConfirmPassword ? <EyeOff className="w-[18px] h-[18px]" /> : <Eye className="w-[18px] h-[18px]" />}
          </button>
        </div>

        {/* Password Requirements Guide strictly reflecting PasswordPolicyService */}
        {password.length > 0 && (
          <div className={s.policy}>
            <span className={s.policyTitle}>{t('Yêu cầu bảo mật mật khẩu:', 'Password security requirements:')}</span>
            <div className={s.policyGrid}>
              <div className={s.policyItem} data-state={policyState(policyStatus.isMinLength, true)}>
                {mark(policyStatus.isMinLength)}
                <span>{t('Ít nhất 15 ký tự', 'At least 15 characters')} ({Array.from(password).length}/15)</span>
              </div>
              <div className={s.policyItem} data-state={policyState(policyStatus.isUnderMaxBytes, false)}>
                {mark(policyStatus.isUnderMaxBytes)}
                <span>{t('Tối đa 72 bytes UTF-8', 'Max 72 UTF-8 bytes')}</span>
              </div>
              <div className={s.policyItem} data-state={policyState(policyStatus.noEmailUsername, false)}>
                {mark(policyStatus.noEmailUsername)}
                <span>{t('Không chứa tên tài khoản email', 'Cannot contain email username')}</span>
              </div>
              <div className={s.policyItem} data-state={policyState(policyStatus.passwordsMatch, true)}>
                {mark(policyStatus.passwordsMatch)}
                <span>{t('Khớp mật khẩu xác nhận', 'Passwords match')}</span>
              </div>
            </div>
          </div>
        )}

        {/* Turnstile Anti-bot Challenge */}
        <TurnstileChallenge
          ref={turnstileRef}
          action="register"
          onVerify={(token) => setTurnstileToken(token)}
          onError={() => setTurnstileToken('')}
        />

        {/* Primary Action Button */}
        <button type="submit" disabled={busy} className={s.cta}>
          {isLoading ? (
            <>
              <Loader2 className={`${s.spin} w-[18px] h-[18px]`} aria-hidden="true" />
              <span>{t('Đang tạo tài khoản...', 'Creating account...')}</span>
            </>
          ) : (
            <>
              <span>{t('Tạo tài khoản', 'Create Account')}</span>
              <ArrowRight className={`${s.ctaArrow} w-[18px] h-[18px]`} aria-hidden="true" />
            </>
          )}
        </button>
      </form>

      {/* Switch to Login footer */}
      <p className={s.switch}>
        {t('Đã có tài khoản?', 'Already have an account?')}{' '}
        <button type="button" onClick={onSwitchToLogin} className={s.link}>
          {t('Đăng nhập ngay', 'Sign in now')}
        </button>
      </p>
    </div>
  );
}

export default RegisterForm;
