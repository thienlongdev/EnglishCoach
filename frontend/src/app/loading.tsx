'use client';

import { usePathname } from 'next/navigation';
import { sceneOf } from '@/lib/journey/journey';
import styles from '@/components/journey/journey.module.css';

export default function Loading() {
  // The sign-in pages paint a whole world, never a skeleton on a dark box.
  const pathname = usePathname() || '';
  if (sceneOf(pathname, null) === 'auth') {
    return (
      <div role="status" aria-live="polite" data-navigation-loading="route" className={styles.routeWater}>
        <span className="sr-only">Đang mở trang… / Loading page…</span>
      </div>
    );
  }
  return (
    <div
      role="status"
      aria-live="polite"
      data-navigation-loading="route"
      className="mx-auto min-h-[calc(100vh-4rem)] w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8"
    >
      <span className="sr-only">Đang mở trang… / Loading page…</span>
      <div className="motion-safe:animate-pulse space-y-5" aria-hidden="true">
        <div className="h-8 w-56 rounded-xl bg-surface-container-high" />
        <div className="h-4 w-full max-w-2xl rounded-lg bg-surface-container" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="h-40 rounded-2xl border border-outline-variant/30 bg-surface-container-low" />
          ))}
        </div>
      </div>
    </div>
  )
}
