'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { X } from 'lucide-react';
import { echoSrc } from '@/lib/brand/echoCharacters';
import {
  browserKind, installDestination, detectEchoAnywhere, hintSeen, markHintSeen, type InstallState,
} from '@/lib/echoAnywhere/client';
import styles from './echoAnywhere.module.css';
import { releaseVersionState } from '@/lib/echoAnywhere/release';

/** Screens where a tip must never appear (focused work, timed attempts, full-screen games). */
const QUIET = [/^\/exams/, /^\/games/, /^\/speaking/, /^\/listening\/[^/]+\/practice/, /^\/study-space/, /^\/knowledge-universe/, /^\/learning-path/, /^\/dashboard$/];

/**
 * Echo Anywhere in the top bar: one small icon between Hướng dẫn and Tin nhắn, a popover with the real install state,
 * and a one-time tip anchored to the icon (desktop only, never on focused screens, remembered once dismissed).
 */
export function EchoAnywhereEntry({ trayButtonClass, vi }: { trayButtonClass: string; vi: boolean }) {
  const pathname = usePathname() || '';
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [hint, setHint] = useState(false);
  const [install, setInstall] = useState<InstallState>({ kind: 'checking' });
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  const measure = useCallback(() => {
    const r = buttonRef.current?.getBoundingClientRect();
    if (r) setPos({ top: Math.round(r.bottom + 10), right: Math.max(8, Math.round(window.innerWidth - r.right - 6)) });
  }, []);

  // The one-time tip: desktop with a fine pointer, not on a focused screen, after the page settled.
  useEffect(() => {
    if (hintSeen() || QUIET.some((re) => re.test(pathname))) return;
    if (!window.matchMedia('(min-width: 1024px) and (pointer: fine)').matches) return;
    const kind = browserKind();
    if (kind !== 'chrome' && kind !== 'edge') return;
    const t = window.setTimeout(() => {
      if (hintSeen() || document.hidden || document.fullscreenElement) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return; // never over an open dialog
      measure();
      setHint(true);
    }, 4000);
    return () => window.clearTimeout(t);
  }, [pathname, measure]);

  useEffect(() => { if (hint && QUIET.some((re) => re.test(pathname))) setHint(false); }, [pathname, hint]);

  useEffect(() => {
    if (!open && !hint) return;
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open, hint, measure]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setInstall({ kind: 'checking' });
    detectEchoAnywhere().then((s) => { if (alive) setInstall(s); });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); buttonRef.current?.focus(); } };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!buttonRef.current?.contains(t) && !document.getElementById('echo-anywhere-popover')?.contains(t)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { alive = false; document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [open]);

  const dismissHint = () => { markHintSeen(); setHint(false); };
  const label = vi ? 'Echo Anywhere — Học tiếng Anh trên mọi website' : 'Echo Anywhere — learn English on any website';
  const kind = typeof navigator === 'undefined' ? 'other' : browserKind();
  const store = installDestination(kind);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`${trayButtonClass} ${styles.trigger}`}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="topbar-echo-anywhere"
        onClick={() => { measure(); setOpen((v) => !v); if (hint) dismissHint(); }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a 20 px brand mark from the one picture registry */}
        <img src={echoSrc('official', 40)} alt="" width={20} height={20} className={styles.mark} draggable={false} />
      </button>

      {hint && !open && pos && createPortal(
        <div className={styles.hint} style={{ top: pos.top, right: pos.right }} role="note" aria-label="Echo Anywhere" data-testid="echo-anywhere-hint">
          <span className={styles.arrow} aria-hidden="true" />
          <button type="button" className={styles.close} aria-label={vi ? 'Đóng gợi ý' : 'Dismiss tip'} onClick={dismissHint}><X size={15} aria-hidden="true" /></button>
          <p className={styles.hintTitle}>Echo Anywhere</p>
          <p className={styles.hintText}>{vi ? 'Học tiếng Anh ngay trên GitHub, Reddit, TikTok Web và nhiều website khác.' : 'Learn English right on GitHub, Reddit, TikTok Web and many other sites.'}</p>
          <Link href="/echo-anywhere" className={styles.hintCta} onClick={dismissHint}>{vi ? 'Khám phá Echo Anywhere' : 'Discover Echo Anywhere'}</Link>
        </div>,
        document.body,
      )}

      {open && pos && createPortal(
        <div id="echo-anywhere-popover" className={styles.pop} style={{ top: pos.top, right: pos.right }} role="dialog" aria-label="Echo Anywhere">
          <span className={styles.arrow} aria-hidden="true" />
          <div className={styles.popHead}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={echoSrc('official', 96)} alt="" width={44} height={44} />
            <div>
              <p className={styles.popTitle}>Echo Anywhere</p>
              <p className={styles.popSub}>{vi ? 'Tiện ích cho Chrome và Edge trên máy tính' : 'Extension for desktop Chrome and Edge'}</p>
            </div>
          </div>
          <p className={styles.popText}>{vi
            ? 'Tra và lưu từ trên trang được hỗ trợ; học với bản chép lời video truy cập được, phụ đề và lời nhạc bạn có quyền sử dụng.'
            : 'Look up and save words on supported pages; learn with accessible video transcripts, subtitles and authorized lyric excerpts.'}</p>
          <div className={styles.status} aria-live="polite">
            {install.kind === 'checking' && <span>{vi ? 'Đang kiểm tra trình duyệt…' : 'Checking this browser…'}</span>}
            {install.kind === 'installed' && <span className={styles.ok}>{vi ? `Đã cài trên trình duyệt này${install.connected ? ' · tiện ích báo đã kết nối tài khoản' : ' · chưa kết nối tài khoản'}` : `Installed here${install.connected ? ' · extension reports an account connection' : ' · not connected yet'}`}</span>}
            {install.kind === 'not-detected' && <span>{vi ? 'Chưa thấy Echo Anywhere trên trình duyệt này.' : 'Echo Anywhere is not detected in this browser.'}</span>}
            {install.kind === 'unsupported' && <span>{vi ? 'Echo Anywhere dành cho Chrome và Edge trên máy tính.' : 'Echo Anywhere is for desktop Chrome and Edge.'}</span>}
          </div>
          <div className={styles.popActions}>
            {install.kind !== 'installed' && (store
              ? <a className={styles.primary} href={store.url} target="_blank" rel="noopener noreferrer">{vi ? 'Cài Echo Anywhere' : 'Install Echo Anywhere'}</a>
              : <span className={styles.pending}>{vi ? 'Mở bằng Chrome, Brave, Cốc Cốc hoặc Edge tương thích trên máy tính.' : 'Use compatible desktop Chrome, Brave, Cốc Cốc or Edge.'}</span>)}
            <Link className={styles.secondary} href="/echo-anywhere" onClick={() => setOpen(false)}>{vi ? 'Tìm hiểu thêm' : 'Learn more'}</Link>
          </div>
          {install.kind === 'installed' && <p className={styles.tiers}>{releaseVersionState(install.version) === 'current'
            ? (vi ? `Phiên bản ${install.version} · khớp bản mới nhất.` : `Version ${install.version} · matches the latest release.`)
            : releaseVersionState(install.version) === 'older'
              ? (vi ? `Bản ${install.version} · trình duyệt có thể đang chờ tự cập nhật. Không cần cài lại.` : `Version ${install.version} · browser update may be pending. No reinstall needed.`)
              : (vi ? 'Phiên bản chưa khớp thông tin phát hành đã xác minh.' : 'Version not matched to verified release information.')}</p>}
          {kind === 'edge' && store?.store === 'chrome' && <p className={styles.popText}>{vi ? 'Trong Edge, cho phép tiện ích từ cửa hàng khác nếu được hỏi, rồi xác nhận thêm tiện ích.' : 'In Edge, allow extensions from other stores if prompted, then confirm installation.'}</p>}
          <p className={styles.tiers}>{vi ? 'Miễn phí: tra nghĩa, phát âm, lưu thẻ, đọc tập trung. Premium: Echo AI giải thích, tóm tắt, quiz.' : 'Free: lookup, pronunciation, saving, focus reading. Premium: Echo AI explanations, summaries, quizzes.'}</p>
        </div>,
        document.body,
      )}
    </>
  );
}
