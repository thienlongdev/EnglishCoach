'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { echoSrc } from '@/lib/brand/echoCharacters';
import { ECHO_ANYWHERE_RELEASE as release, publishedReleaseAvailable } from '@/lib/echoAnywhere/release';
import { HINT_KEY, claimReleaseNotice, dismissReleaseNotice } from '@/lib/echoAnywhere/client';
import styles from './releaseAnnouncement.module.css';

/** In-flow Dashboard notice: never mounted over learning, exams, games or immersive worlds. */
export function ReleaseAnnouncement({ vi }: { vi: boolean }) {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const checked = useRef(false);
  useEffect(() => {
    if (pathname !== '/dashboard') return;
    const show = () => {
      if (checked.current || document.hidden || document.fullscreenElement ||
        document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      checked.current = true;
      if (publishedReleaseAvailable(release) && claimReleaseNotice(release.version)) setVisible(true);
    };
    const sync = (event: StorageEvent) => { if (event.key === HINT_KEY) setVisible(false); };
    show();
    document.addEventListener('visibilitychange', show);
    document.addEventListener('fullscreenchange', show);
    window.addEventListener('storage', sync);
    return () => {
      document.removeEventListener('visibilitychange', show);
      document.removeEventListener('fullscreenchange', show);
      window.removeEventListener('storage', sync);
    };
  }, [pathname]);
  if (!visible || pathname !== '/dashboard') return null;
  const dismiss = () => { dismissReleaseNotice(release.version); setVisible(false); };
  return <aside className={styles.notice} aria-label={vi ? 'Có gì mới ở Echo Anywhere' : 'What’s new in Echo Anywhere'} data-testid="echo-release-notice">
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={echoSrc('official', 96)} width={44} height={44} alt="" />
    <div className={styles.copy}>
      <h2>{vi ? release.title : release.titleEn}</h2>
      <p>{vi ? release.summary : release.summaryEn}</p>
      <details><summary>{vi ? 'Điểm mới nổi bật' : 'Release highlights'}</summary>
        <ul>{(vi ? release.highlights : release.highlightsEn).map((text) => <li key={text}>{text}</li>)}</ul>
      </details>
    </div>
    <div className={styles.actions}>
      <Link href="/echo-anywhere" onClick={dismiss}>{vi ? 'Khám phá tính năng mới' : 'Explore what’s new'} <span aria-hidden="true">→</span></Link>
      <button type="button" onClick={dismiss}>{vi ? 'Đã hiểu' : 'Got it'}</button>
    </div>
  </aside>;
}
