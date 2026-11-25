'use client';

import React, { useState, useRef } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Mail, Lock, Eye, EyeOff, Loader2, AlertCircle, ArrowRight } from 'lucide-react';
import { GoogleAuthButton } from './GoogleAuthButton';
import { TurnstileChallenge, TurnstileChallengeRef } from './TurnstileChallenge';
import { MascotState } from './AuthEchoMascot';
import { VerificationMailPanel } from './VerificationMailPanel';
import { useLanguage } from '@/context/LanguageContext';
import { beginAuthenticatedSession } from '@/lib/auth-lifecycle';
import { cancelJourney, journeyActive, journeyGo, journeyLeaveForExternal } from '@/lib/journey/journey';
import { sanitizeLocalPath } from '@/lib/sanitize-local-path';
import s from './authGlass.module.css';

interface LoginFormProps {
  callbackUrl?: string;
  onForgotPassword: () => void;
  onSwitchToRegister: () => void;
  onMascotStateChange: (state: MascotState) => void;
}

export function LoginForm({
  callbackUrl = '/dashboard',
  onForgotPassword,
  onSwitchToRegister,
  onMascotStateChange,
}: LoginFormProps) {
  const router = useRouter();
  const { locale } = useLanguage();
  const t = (vi: string, en: string) => (locale === 'vi' ? vi : en);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [, setTurnstileToken] = useState('');
  const submitting = useRef(false);

  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [needsVerification, setNeedsVerification] = useState<string | null>(null);

  const turnstileRef = useRef<TurnstileChallengeRef>(null);

  // Strict local open redirect guard
  const safeCallbackUrl = sanitizeLocalPath(callbackUrl, '/dashboard');

  const handleGoogleLogin = async () => {
    setIsGoogleLoading(true);
    setErrorMessage(null);
    onMascotStateChange('submitting');
    // Echo swims out while the browser leaves for Google; a canvas cannot follow to another site, so the arrival is restored when it comes back.
    journeyLeaveForExternal(safeCallbackUrl);
    try {
      await signIn('google', { callbackUrl: safeCallbackUrl });
    } catch (err) {
      cancelJourney();
      setIsGoogleLoading(false);
      onMascotStateChange('error');
      setErrorMessage(t('Không thể kết nối với tài khoản Google. Vui lòng thử lại.', 'Could not connect to Google account. Please try again.'));
    }
  };

  const handleCredentialsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setErrorMessage(t('Vui lòng nhập đầy đủ email và mật khẩu.', 'Please enter both email and password.'));
      onMascotStateChange('error');
      return;
    }
    // A second press or Enter while the first request runs would spend a second token for nothing.
    if (submitting.current) return;
    submitting.current = true;

    setIsLoading(true);
    setErrorMessage(null);
    setNeedsVerification(null);
    onMascotStateChange('submitting');

    const send = async () => {
      const token = await turnstileRef.current?.freshToken();
      if (token === null) return null;
      return signIn('credentials', {
        redirect: false,
        email: email.trim().toLowerCase(),
        password,
        turnstileToken: token || undefined,
        callbackUrl: safeCallbackUrl,
      });
    };

    try {
      let res = await send();
      // A token that ran out while the form was open is not the learner's mistake: one new real challenge, verified by the server as always.
      if (res?.error?.includes('CAPTCHA_FAILED') && !res.error.includes('temporarily unavailable')) {
        turnstileRef.current?.reset();
        res = await send();
      }

      if (res === null) {
        setIsLoading(false);
        onMascotStateChange('error');
        setErrorMessage(t('Vui lòng hoàn thành ô xác minh chống bot rồi bấm Đăng nhập lại.', 'Please complete the anti-bot challenge, then sign in again.'));
        return;
      }

      if (!res) {
        setIsLoading(false);
        onMascotStateChange('error');
        setErrorMessage(t('Không thể kết nối đến máy chủ xác thực.', 'Could not connect to authentication server.'));
        turnstileRef.current?.reset();
        return;
      }

      if (res.error) {
        setIsLoading(false);
        onMascotStateChange('error');
        turnstileRef.current?.reset();
        setTurnstileToken('');

        // Localized friendly error interpretation
        if (res.error.includes('AUTH_UNAVAILABLE') || res.error.includes('temporarily unavailable')) {
          setErrorMessage(t('Máy chủ đăng nhập tạm thời chưa phản hồi. Vui lòng thử lại sau ít phút.', 'The sign-in service is not responding right now. Please try again shortly.'));
        } else if (res.error.includes('CAPTCHA_FAILED')) {
          setErrorMessage(t('Xác thực chống bot không thành công hoặc đã hết hạn. Vui lòng hoàn thành lại xác thực.', 'Anti-bot verification failed or expired. Please complete the challenge again.'));
        } else if (res.error === 'CredentialsSignin') {
          setErrorMessage(t('Email hoặc mật khẩu không chính xác.', 'Incorrect email or password.'));
        } else if (res.error.includes('LOCKED')) {
          setErrorMessage(t('Tài khoản tạm thời bị khóa do nhiều lần đăng nhập không thành công. Vui lòng thử lại sau.', 'Account is temporarily locked due to multiple failed attempts. Please try again later.'));
        } else if (res.error.includes('RATE_LIMIT')) {
          setErrorMessage(t('Quá nhiều yêu cầu đăng nhập. Vui lòng thử lại sau ít phút.', 'Too many login attempts. Please try again shortly.'));
        } else if (res.error.includes('EMAIL_VERIFICATION')) {
          // Only said after the password matched: the account exists and waits for its email link.
          setNeedsVerification(email.trim().toLowerCase());
          setErrorMessage(t('Tài khoản chưa được xác minh email. Mở liên kết trong email xác minh, hoặc gửi lại email bên dưới.', 'This account has not verified its email yet. Open the link in the verification email, or resend it below.'));
        } else if (res.error.includes('RESET_REQUIRED')) {
          setErrorMessage(t('Tài khoản yêu cầu đặt lại mật khẩu trước khi đăng nhập.', 'Account requires password reset before signing in.'));
        } else {
          setErrorMessage(t('Email hoặc mật khẩu không chính xác.', 'Incorrect email or password.'));
        }
      } else if (res.ok) {
        beginAuthenticatedSession();
        onMascotStateChange('success');
        // The session is confirmed: only now does Echo lead the way (10 §BK). A failed sign-in never reaches this line.
        if (journeyActive() || journeyGo(safeCallbackUrl)) return;
        setTimeout(() => {
          router.push(safeCallbackUrl);
        }, 300);
      }
    } catch (err: any) {
      setIsLoading(false);
      onMascotStateChange('error');
      setErrorMessage(t('Đã xảy ra lỗi trong quá trình đăng nhập. Vui lòng thử lại.', 'An error occurred during sign in. Please try again.'));
      turnstileRef.current?.reset();
    } finally {
      submitting.current = false;
    }
  };

  const busy = isLoading || isGoogleLoading;

  return (
    <div className={s.stack} data-purpose="login-form">
      {/* Form Header */}
      <div className={s.head}>
        <h2 className={s.title}>{t('Đăng nhập', 'Sign in')}</h2>
        <p className={s.lede}>
          {t('Chào mừng bạn trở lại English Coach! Tiếp tục hành trình học tiếng Anh cùng Echo.', 'Welcome back to English Coach! Continue your English journey with Echo.')}
        </p>
      </div>

      {/* Google Authentication Button */}
      <GoogleAuthButton
        onClick={handleGoogleLogin}
        isLoading={isGoogleLoading}
        disabled={isLoading}
        label={t('Đăng nhập bằng Google', 'Sign in with Google')}
      />

      <div className={s.divider}>{t('hoặc đăng nhập với email', 'or sign in with email')}</div>

      {/* Error Announcement */}
      {errorMessage && (
        <div role="alert" className={s.alert}>
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{errorMessage}</span>
        </div>
      )}

      {needsVerification && (
        <VerificationMailPanel email={needsVerification} title={t('Gửi lại email xác minh', 'Resend the verification email')} />
      )}

      {/* Form Fields */}
      <form onSubmit={handleCredentialsSubmit} className={s.form} noValidate>
        {/* Email Field */}
        <div className={s.field} data-disabled={busy}>
          <span className={s.fieldIcon} aria-hidden="true"><Mail className="w-[18px] h-[18px]" /></span>
          <span className={s.fieldBody}>
            <label htmlFor="login-email" className={s.label}>{t('Email', 'Email')}</label>
            <input
              id="login-email"
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

        {/* Password Field */}
        <div className={s.field} data-disabled={busy}>
          <span className={s.fieldIcon} aria-hidden="true"><Lock className="w-[18px] h-[18px]" /></span>
          <span className={s.fieldBody}>
            <label htmlFor="login-password" className={s.label}>{t('Mật khẩu', 'Password')}</label>
            <input
              id="login-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onFocus={() => onMascotStateChange('password-focus')}
              onBlur={() => onMascotStateChange('idle')}
              placeholder="••••••••••••"
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

        <div className={s.rowEnd}>
          <button type="button" onClick={onForgotPassword} className={`${s.link} ${s.small}`}>
            {t('Quên mật khẩu?', 'Forgot password?')}
          </button>
        </div>

        {/* Turnstile Anti-bot Challenge */}
        <TurnstileChallenge
          ref={turnstileRef}
          action="login"
          onVerify={(token) => setTurnstileToken(token)}
          onError={() => setTurnstileToken('')}
        />

        {/* Submit Button */}
        <button type="submit" disabled={busy} className={s.cta}>
          {isLoading ? (
            <>
              <Loader2 className={`${s.spin} w-[18px] h-[18px]`} aria-hidden="true" />
              <span>{t('Đang đăng nhập...', 'Signing in...')}</span>
            </>
          ) : (
            <>
              <span>{t('Đăng nhập', 'Sign In')}</span>
              <ArrowRight className={`${s.ctaArrow} w-[18px] h-[18px]`} aria-hidden="true" />
            </>
          )}
        </button>
      </form>

      {/* Switch to Register footer */}
      <p className={s.switch}>
        {t('Chưa có tài khoản?', "Don't have an account?")}{' '}
        <button type="button" onClick={onSwitchToRegister} className={s.link}>
          {t('Đăng ký ngay', 'Sign up now')}
        </button>
      </p>
    </div>
  );
}

export default LoginForm;
