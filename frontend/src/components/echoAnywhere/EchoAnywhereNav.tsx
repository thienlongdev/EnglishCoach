'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { echoSrc } from '@/lib/brand/echoCharacters';
import { internalReturnDelta } from '@/lib/echoAnywhere/client';
import styles from './echoAnywherePage.module.css';

/** Native history retains the previous page's query, fragment and browser scroll restoration. */
export function EchoAnywhereNav() {
  const { status } = useSession();
  const router = useRouter();
  const home = status === 'unauthenticated' ? '/' : '/dashboard';
  const back = () => {
    const navigation = (window as unknown as { navigation?: {
      currentEntry?: { index: number };
      entries: () => { index: number; url?: string }[];
    } }).navigation;
    if (navigation?.currentEntry) {
      const delta = internalReturnDelta(navigation.entries(), navigation.currentEntry.index, location.origin);
      if (delta !== null) { window.history.go(delta); return; }
    } else if (document.referrer && window.history.length > 1) {
      // Older browsers: accept only a proven same-origin document predecessor.
      try {
        const previous = new URL(document.referrer);
        if (previous.origin === location.origin && previous.pathname !== '/echo-anywhere') {
          window.history.back(); return;
        }
      } catch { /* no trustworthy predecessor */ }
    }
    router.replace(home);
  };
  return (
    <nav className={styles.nav} aria-label="Điều hướng">
      <Link href={home} className={styles.navBrand}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={echoSrc('official', 64)} alt="" width={30} height={30} /> English Coach
      </Link>
      <div className={styles.navLinks}>
        <button type="button" onClick={back} disabled={status === 'loading'}>Quay lại</button>
        <a href="#cai-dat">Cài đặt</a>
        <a href="#quyen-rieng-tu">Quyền riêng tư</a>
        <Link href="/dashboard">Vào học</Link>
      </div>
    </nav>
  );
}
