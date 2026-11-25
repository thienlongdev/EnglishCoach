'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Mail, CheckCircle2, AlertCircle, Loader2, ArrowRight, ArrowLeft } from 'lucide-react';
import s from '@/components/auth/authGlass.module.css';
import { AuthShell } from '@/components/auth/AuthShell';
import { AuthCard } from '@/components/auth/AuthCard';
import { AuthLoading } from '@/app/login/page';
import type { MascotState } from '@/components/auth/AuthEchoMascot';
import { VerificationMailPanel } from '@/components/auth/VerificationMailPanel';

// CSRF helper for BFF mutating requests
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

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token');
  const emailParam = searchParams.get('email') || '';

  const [mascotState, setMascotState] = useState<MascotState>('idle');
  const [isVerifying, setIsVerifying] = useState(!!token);
  const [verificationSuccess, setVerificationSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [alreadyVerified, setAlreadyVerified] = useState(false);

  useEffect(() => {
    if (!token) {
      setIsVerifying(false);
      return;
    }

    let isMounted = true;
    const executeVerification = async () => {
      setMascotState('submitting');
      try {
        const csrfHeaders = await getCsrfHeader();
        const res = await fetch('/api/v1/auth/verify-email', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...csrfHeaders,
          },
          body: JSON.stringify({ token }),
        });

        if (!isMounted) return;

        if (res.ok || res.status === 204) {
          // 200 {status: ALREADY_VERIFIED}: an older link of an account that is verified by now
          const data = res.status === 200 ? await res.json().catch(() => ({})) : {};
          if (!isMounted) return;
          setAlreadyVerified(data?.status === 'ALREADY_VERIFIED');
          setVerificationSuccess(true);
          setMascotState('success');
        } else {
          const data = await res.json().catch(() => ({}));
          setErrorMessage(data.message || 'Liên kết xác thực không hợp lệ hoặc đã hết hạn.');
          setMascotState('error');
        }
      } catch (err) {
        if (!isMounted) return;
        setErrorMessage('Không thể kết nối đến máy chủ. Vui lòng thử lại sau.');
        setMascotState('error');
      } finally {
        if (isMounted) setIsVerifying(false);
      }
    };

    executeVerification();

    return () => {
      isMounted = false;
    };
  }, [token]);

  return (
    <AuthShell mood={mascotState}>
      <AuthCard>
        {isVerifying ? (
          <div className={`${s.stack} ${s.center} py-6`}>
            <Loader2 className={`${s.spin} w-10 h-10 mx-auto text-[color:var(--link)]`} />
            <div className={s.head}>
              <h2 className={s.title}>Đang xác thực tài khoản...</h2>
              <p className={s.lede}>Vui lòng chờ trong giây lát.</p>
            </div>
          </div>
        ) : verificationSuccess ? (
          <div className={`${s.stack} ${s.center}`} data-purpose="verify-email-success">
            <div className={s.badgeTile} data-tone="ok" aria-hidden="true">
              <CheckCircle2 className="w-9 h-9" />
            </div>

            <div className={s.head}>
              <h2 className={s.title}>
                {alreadyVerified ? 'Email đã được xác minh' : 'Xác thực email thành công!'}
              </h2>
              <p className={s.lede}>
                {alreadyVerified
                  ? 'Tài khoản này đã được xác minh trước đó, bạn không cần làm gì thêm. Hãy đăng nhập để tiếp tục học cùng Echo.'
                  : 'Tài khoản English Coach của bạn đã được kích hoạt. Hãy đăng nhập để bắt đầu hành trình học tập cùng Echo.'}
              </p>
            </div>

            <button
              type="button"
              onClick={() => router.push('/login?mode=login')}
              className={s.cta}
            >
              <span>Đăng nhập ngay</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        ) : errorMessage ? (
          <div className={s.stack} data-purpose="verify-email-error">
            <div className={s.head}>
              <div className={`${s.badgeTile} mb-3`} data-tone="bad" aria-hidden="true">
                <AlertCircle className="w-8 h-8" />
              </div>
              <h2 className={s.title}>
                Xác thực không thành công
              </h2>
              <p className={s.lede}>
                {errorMessage}
              </p>
            </div>

            {/* A new link (older unused links stay valid until they expire) */}
            <VerificationMailPanel email={emailParam} editable title="Gửi lại liên kết xác minh mới" />

            <div className={s.switch}>
              <button
                type="button"
                onClick={() => router.push('/login')}
                className={`${s.ghost} inline-flex items-center gap-1.5`}
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Quay lại đăng nhập</span>
              </button>
            </div>
          </div>
        ) : (
          /* No token case: instructions to check mailbox */
          <div className={`${s.stack} ${s.center}`} data-purpose="verify-email-pending">
            <div className={s.badgeTile} aria-hidden="true">
              <Mail className="w-8 h-8" />
            </div>

            <div className={s.head}>
              <h2 className={s.title}>
                Kiểm tra hộp thư của bạn
              </h2>
              <p className={s.lede}>
                Mở email xác minh của English Coach và bấm liên kết trong thư để kích hoạt tài khoản.
              </p>
            </div>

            <VerificationMailPanel email={emailParam} editable />

            <button
              type="button"
              onClick={() => router.push('/login')}
              className={`${s.ghost} inline-flex items-center gap-1.5`}
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Quay lại đăng nhập</span>
            </button>
          </div>
        )}
      </AuthCard>
    </AuthShell>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<AuthLoading variant="login" />}>
      <VerifyEmailContent />
    </Suspense>
  );
}
