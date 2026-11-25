'use client';

import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock3, Inbox, Loader2, MailSearch, RotateCw, UserCheck } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { TurnstileChallenge, TurnstileChallengeRef } from './TurnstileChallenge';
import s from './authGlass.module.css';

/** What the server said about the mail it just handed to the provider (`delivery` of POST /auth/register). */
export type MailDelivery = 'SENT' | 'FAILED' | 'SIMULATED' | null;

interface VerificationMailPanelProps {
  /** The address the mail goes to (shown and used for a resend); empty ⇒ the learner types it. */
  email: string;
  /** The answer of the request that just mailed this address, if any. */
  delivery?: MailDelivery;
  /** Let the learner type / correct the address used for the resend. */
  editable?: boolean;
  title?: string;
}

const COOLDOWN_SECONDS = 60;

async function getCsrfHeader(): Promise<{ [key: string]: string }> {
  if (typeof document === 'undefined') return {};
  let match = document.cookie.match(/ec\.csrf=([^;]+)/);
  if (!match || !match[1]) {
    try {
      const res = await fetch('/api/auth/csrf-context');
      if (res.ok) {
        const data = await res.json();
        if (data.csrfToken) return { 'X-CSRF-Token': data.csrfToken };
      }
    } catch {}
    match = document.cookie.match(/ec\.csrf=([^;]+)/);
  }
  return match && match[1] ? { 'X-CSRF-Token': match[1] } : {};
}

type Status = { tone: 'ok' | 'bad' | 'wait'; text: string } | null;

/**
 * Verification mail help: the honest state of the last mail (accepted by the mail provider ≠ in the inbox), what to check
 * when it is not there, and a real resend (POST /auth/resend-verification) with a cooldown. The resend answer is the
 * same whether or not the address has an account (no enumeration); a 503 means the provider is failing right now.
 */
export function VerificationMailPanel({ email, delivery = null, editable = false, title }: VerificationMailPanelProps) {
  const { locale } = useLanguage();
  const t = (vi: string, en: string) => (locale === 'vi' ? vi : en);
  const [address, setAddress] = useState(email);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(delivery === 'SENT' ? COOLDOWN_SECONDS : 0);
  const [, setTurnstileToken] = useState('');
  const turnstileRef = useRef<TurnstileChallengeRef>(null);
  const submitting = useRef(false);
  const [status, setStatus] = useState<Status>(() => {
    if (delivery === 'SENT') return { tone: 'ok', text: t('Máy chủ thư đã nhận email gửi tới địa chỉ trên. Thư thường đến trong vài phút.', 'The mail service accepted the email to the address above. It usually arrives within a few minutes.') };
    if (delivery === 'FAILED') return { tone: 'bad', text: t('Chưa gửi được email tới địa chỉ trên (dịch vụ thư đang gặp lỗi). Hãy bấm “Gửi lại email” sau ít phút.', 'The email could not be sent to the address above (the mail service is failing). Press “Resend email” in a few minutes.') };
    return null;
  });

  useEffect(() => setAddress(email), [email]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const resend = async () => {
    const target = address.trim().toLowerCase();
    if (!target || !target.includes('@') || busy || cooldown > 0 || submitting.current) {
      if (!target.includes('@')) setStatus({ tone: 'bad', text: t('Vui lòng nhập địa chỉ email hợp lệ.', 'Please enter a valid email address.') });
      return;
    }
    submitting.current = true;
    setBusy(true);
    setStatus(null);
    try {
      const csrfHeaders = await getCsrfHeader();
      const send = async () => {
        const token = await turnstileRef.current?.freshToken();
        if (token === null) return null;
        return fetch('/api/v1/auth/resend-verification', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...csrfHeaders },
          body: JSON.stringify({ email: target, turnstileToken: token || undefined }),
        });
      };

      let res = await send();
      if (res?.status === 400) {
        const first = await res.clone().json().catch(() => ({}));
        if (first.code === 'CAPTCHA_FAILED' && !String(first.message).includes('temporarily unavailable')) {
          turnstileRef.current?.reset();
          res = await send();
        }
      }

      if (res === null) {
        setStatus({ tone: 'bad', text: t('Vui lòng hoàn thành ô xác minh chống bot rồi bấm Gửi lại email.', 'Please complete the anti-bot challenge, then press Resend email again.') });
        return;
      }

      if (res.status === 202 || res.ok) {
        setCooldown(COOLDOWN_SECONDS);
        setStatus({ tone: 'ok', text: t('Đã gửi yêu cầu. Nếu địa chỉ này có tài khoản English Coach, một email mới sẽ đến trong vài phút — các liên kết đã gửi trước vẫn dùng được.', 'Request sent. If this address has an English Coach account, a new email arrives within a few minutes — earlier links keep working.') });
      } else if (res.status === 400) {
        const data = await res.json().catch(() => ({}));
        if (data.code === 'CAPTCHA_FAILED') {
          setStatus({ tone: 'bad', text: data.message || t('Xác thực chống bot không thành công hoặc đã hết hạn. Vui lòng thử lại.', 'Anti-bot verification failed or expired. Please try again.') });
        } else {
          setStatus({ tone: 'bad', text: data.message || t('Không thể gửi lại email lúc này. Vui lòng thử lại.', 'Could not resend the email right now. Please try again.') });
        }
      } else if (res.status === 503) {
        setCooldown(20);
        setStatus({ tone: 'bad', text: t('Chưa gửi được email lúc này (dịch vụ thư đang gặp lỗi). Vui lòng thử lại sau vài phút.', 'The email could not be sent right now (the mail service is failing). Please try again in a few minutes.') });
      } else if (res.status === 429) {
        setCooldown(COOLDOWN_SECONDS);
        setStatus({ tone: 'wait', text: t('Bạn đã yêu cầu nhiều lần. Vui lòng đợi một lúc rồi thử lại.', 'Too many requests. Please wait a while and try again.') });
      } else {
        setStatus({ tone: 'bad', text: t('Không thể gửi lại email lúc này. Vui lòng thử lại.', 'Could not resend the email right now. Please try again.') });
      }
      turnstileRef.current?.reset();
      setTurnstileToken('');
    } catch {
      setStatus({ tone: 'bad', text: t('Lỗi kết nối. Vui lòng thử lại sau.', 'Connection error. Please try again later.') });
      turnstileRef.current?.reset();
      setTurnstileToken('');
    } finally {
      setBusy(false);
      submitting.current = false;
    }
  };

  return (
    <div className={s.mailPanel} data-purpose="verification-mail-panel">
      <div className={s.mailTitle}>{title ?? t('Không thấy email?', "Can't find the email?")}</div>
      <ul className={s.mailTips}>
        <li><Inbox size={14} aria-hidden="true" /><span>{t('Xem cả thư mục Spam / Thư rác và tab Quảng cáo (Promotions), hoặc tìm “English Coach”.', 'Check Spam / Junk and the Promotions tab, or search for “English Coach”.')}</span></li>
        <li><MailSearch size={14} aria-hidden="true" /><span>{t('Kiểm tra địa chỉ có đúng không. Nếu gõ nhầm, hãy đăng ký lại với địa chỉ đúng.', 'Make sure the address is right. If it has a typo, register again with the correct one.')}</span></li>
        <li><UserCheck size={14} aria-hidden="true" /><span>{t('Nếu địa chỉ này đã có tài khoản, email sẽ hướng dẫn đăng nhập hoặc đặt lại mật khẩu thay vì xác minh.', 'If this address already has an account, the email explains how to sign in or reset the password instead.')}</span></li>
      </ul>

      {editable && (
        <input
          type="email"
          autoComplete="email"
          aria-label={t('Email tài khoản', 'Account email')}
          placeholder={t('Nhập email tài khoản', 'Enter your account email')}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className={s.inputSolo}
        />
      )}

      {status && (
        <div className={s.mailStatus} data-tone={status.tone} role="status" aria-live="polite">
          {status.tone === 'ok' ? <CheckCircle2 size={16} aria-hidden="true" /> : status.tone === 'wait' ? <Clock3 size={16} aria-hidden="true" /> : <AlertCircle size={16} aria-hidden="true" />}
          <span>{status.text}</span>
        </div>
      )}

      <TurnstileChallenge
        ref={turnstileRef}
        action="resend-verification"
        onVerify={(token) => setTurnstileToken(token)}
        onError={() => setTurnstileToken('')}
      />

      <button type="button" onClick={resend} disabled={busy || cooldown > 0} className={s.mailButton} data-purpose="resend-verification">
        {busy ? <Loader2 size={16} className={s.spin} aria-hidden="true" /> : <RotateCw size={16} aria-hidden="true" />}
        <span>
          {busy
            ? t('Đang gửi...', 'Sending...')
            : cooldown > 0
            ? t(`Gửi lại sau ${cooldown} giây`, `Resend in ${cooldown}s`)
            : t('Gửi lại email', 'Resend email')}
        </span>
      </button>
    </div>
  );
}

export default VerificationMailPanel;
