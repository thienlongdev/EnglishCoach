'use client';

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import { useSession } from 'next-auth/react';
import { activeGuide, guidePanelOpen, pendingGuide, setGuideAccount, subscribeGuide } from '@/lib/guide/store';

/**
 * The only part of Echo Guide in the main bundle (10 §BL). Signed-in accounts only. The engine and every guide load in their own chunk when the page is idle, or at once if the learner
 * asks for help. Mounted under the account key, so a change of account starts clean. No request, no AI, no server work of any kind.
 */
const GuideRuntime = dynamic(() => import('./GuideRuntime'), { ssr: false });

export default function GuideHost() {
  const { data: session, status } = useSession();
  const id = status === 'authenticated' ? String((session?.user as { id?: string | number })?.id ?? '') : '';
  const asked = useSyncExternalStore(subscribeGuide, () => guidePanelOpen() || !!activeGuide() || !!pendingGuide(), () => false);
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    setGuideAccount(id);
    if (!id) return;
    const run = () => setIdle(true);
    const later = window as Window & { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (handle: number) => void };
    let idleHandle = 0;
    const timer = window.setTimeout(() => {
      idleHandle = later.requestIdleCallback ? later.requestIdleCallback(run, { timeout: 2000 }) : window.setTimeout(run, 400);
    }, 2200);
    return () => {
      window.clearTimeout(timer);
      if (idleHandle && later.cancelIdleCallback) later.cancelIdleCallback(idleHandle);
    };
  }, [id]);

  if (!id || !(idle || asked)) return null;
  return <GuideRuntime />;
}
