'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { apiClient } from '@/services/api-client';
import { allowedExtensionIds, handOverPairing } from '@/lib/echoAnywhere/client';
import { echoSrc } from '@/lib/brand/echoCharacters';
import styles from '@/components/echoAnywhere/echoAnywherePage.module.css';

type Step = 'checking' | 'invalid' | 'signin' | 'ask' | 'working' | 'done' | 'error';

/**
 * The one place an Echo Anywhere extension is connected to an account. The extension opened this page with its id,
 * a PKCE challenge and a state; the signed-in learner approves; the backend issues a one-time code bound to them, and
 * this page hands it ONLY to that extension (an id the backend allows). No password, cookie or token goes to the
 * extension (features/echo-anywhere).
 */
function ConnectView() {
  const params = useSearchParams();
  const { data: session, status } = useSession();
  const ext = (params.get('ext') || '').toLowerCase();
  const challenge = params.get('challenge') || '';
  const state = params.get('state') || '';
  const browser = params.get('browser') === 'edge' ? 'edge' : 'chrome';
  const [step, setStep] = useState<Step>('checking');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let alive = true;
    const wellFormed = /^[a-p]{32}$/.test(ext) && /^[A-Za-z0-9_-]{43}$/.test(challenge) && /^[A-Za-z0-9_-]{8,100}$/.test(state);
    if (!wellFormed) { setStep('invalid'); return; }
    if (status === 'loading') return;
    allowedExtensionIds().then((ids) => {
      if (!alive) return;
      if (!ids.includes(ext)) { setStep('invalid'); return; }
      setStep(status === 'authenticated' ? 'ask' : 'signin');
    });
    return () => { alive = false; };
  }, [ext, challenge, state, status]);

  const connect = async () => {
    setStep('working');
    try {
      const { data } = await apiClient.post<{ code: string }>('/extension/pairings', { extensionId: ext, codeChallenge: challenge, browser });
      const reply = await handOverPairing(ext, data.code, state);
      if (reply?.ok) { setStep('done'); return; }
      setMessage(reply?.message || 'Không liên lạc được với tiện ích Echo Anywhere trên trình duyệt này. Hãy kiểm tra tiện ích đã được bật, rồi bấm “Kết nối” trong tiện ích lần nữa.');
      setStep('error');
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number; data?: { message?: string } } })?.response;
      setMessage(status?.data?.message || 'Không tạo được mã kết nối. Hãy thử lại.');
      setStep('error');
    }
  };

  const here = typeof window === 'undefined' ? '/echo-anywhere/connect' : `${window.location.pathname}${window.location.search}`;
  const name = session?.user?.name || session?.user?.email || 'tài khoản của bạn';

  return (
    <div className={styles.connectPage}>
      <div className={styles.connectCard} aria-live="polite">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={echoSrc('official', 128)} alt="" width={72} height={72} className={styles.connectMark} />
        <h1 className={styles.connectTitle}>Kết nối Echo Anywhere</h1>
        {step === 'checking' && <p className={styles.connectText}>Đang kiểm tra yêu cầu…</p>}
        {step === 'invalid' && (
          <>
            <p className={styles.connectText}>Yêu cầu kết nối này không hợp lệ hoặc không đến từ bản Echo Anywhere chính thức.</p>
            <p className={styles.connectMuted}>Hãy mở tiện ích Echo Anywhere và bấm “Kết nối tài khoản” để bắt đầu lại.</p>
            <Link className={styles.ghostBtn} href="/echo-anywhere">Về trang Echo Anywhere</Link>
          </>
        )}
        {step === 'signin' && (
          <>
            <p className={styles.connectText}>Đăng nhập English Coach để kết nối tiện ích với tài khoản của bạn.</p>
            <Link className={styles.primaryBtn} href={`/login?callbackUrl=${encodeURIComponent(here)}`}>Đăng nhập để tiếp tục</Link>
          </>
        )}
        {step === 'ask' && (
          <>
            <p className={styles.connectText}>Cho phép Echo Anywhere trên {browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome'} dùng <b>{name}</b>?</p>
            <ul className={styles.connectList}>
              <li>Lưu từ bạn chọn vào Thẻ từ vựng của tài khoản</li>
              <li>Xem trạng thái Premium và trình độ để giải thích phù hợp</li>
              <li>Dùng Echo AI khi bạn bấm (chỉ tài khoản Premium)</li>
            </ul>
            <p className={styles.connectMuted}>Tiện ích nhận một phiên riêng, có thể ngắt bất cứ lúc nào trong tiện ích hoặc ở Hồ sơ cá nhân → Phiên đăng nhập. Tiện ích không thấy mật khẩu hay cookie của bạn, và chỉ dùng được các chức năng trên.</p>
            <div className={styles.connectActions}>
              <button type="button" className={styles.primaryBtn} onClick={connect} data-testid="echo-anywhere-approve">Kết nối</button>
              <Link className={styles.ghostBtn} href="/dashboard">Hủy</Link>
            </div>
          </>
        )}
        {step === 'working' && <p className={styles.connectText}>Đang kết nối…</p>}
        {step === 'done' && (
          <>
            <p className={styles.connectText} data-testid="echo-anywhere-connected">Đã kết nối. Bạn có thể đóng tab này và quay lại trang đang đọc.</p>
            <p className={styles.connectMuted}>Mẹo: bôi đen chữ tiếng Anh rồi nhấn Alt+Shift+E.</p>
          </>
        )}
        {step === 'error' && (
          <>
            <p className={styles.connectError}>{message}</p>
            <button type="button" className={styles.ghostBtn} onClick={() => setStep('ask')}>Thử lại</button>
          </>
        )}
      </div>
    </div>
  );
}

export default function EchoAnywhereConnectPage() {
  return (
    <Suspense fallback={<div className={styles.connectPage} />}>
      <ConnectView />
    </Suspense>
  );
}
