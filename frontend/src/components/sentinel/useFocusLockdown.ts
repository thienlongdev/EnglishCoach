'use client';
import { useEffect, useRef } from 'react';
import { heartbeat, reportLeaving, TERMINAL } from '@/lib/sentinel/client';
import type { LeaveKind, SentinelAttempt } from '@/lib/sentinel/client';

/**
 * Echo Sentinel Focus Lockdown for one strict-focus attempt (10 §BX).
 *
 * - `attempt` alive: reports every `heartbeatMs` (the server ends an attempt whose reports stop for longer than the
 *   disclosed grace: "continuity unverifiable", never an accusation).
 * - `active` (the scored contest is running): the tab becoming hidden, the window losing focus for longer than
 *   `blurGraceMs` (Alt+Tab, another app; a focus moved to an iframe of this page does not count), the page closing or
 *   reloading, or this view going away all end the attempt. A web page cannot prevent switching; it can only notice it.
 * - Reload / close: the browser's own "leave site?" prompt is requested; the secret is gone after a reload anyway.
 *
 * The page never decides the outcome: it reports, the server decides and the game state shows the decision.
 */
export function useFocusLockdown({ attempt, active, onStatus }: {
  attempt: SentinelAttempt | null; active: boolean; onStatus?: (state: string) => void;
}) {
  const reported = useRef<string | null>(null);
  const status = useRef(onStatus); status.current = onStatus;
  const live = useRef(active); live.current = active;

  // Reports: while the attempt is open (lobby included), stop once the server answered a terminal state.
  useEffect(() => {
    if (!attempt) return;
    let stopped = false;
    const beat = async () => {
      const s = await heartbeat(attempt, live.current ? document.visibilityState === 'visible' : true);
      if (stopped || !s) return;
      if (TERMINAL.has(s.state)) { stopped = true; clearInterval(timer); status.current?.(s.state); }
    };
    const timer = setInterval(beat, attempt.heartbeatMs);
    void beat();
    return () => { stopped = true; clearInterval(timer); };
  }, [attempt]);

  useEffect(() => {
    if (!attempt || !active) return;
    reported.current = null;
    let blurTimer: ReturnType<typeof setTimeout> | null = null;
    const leave = (kind: LeaveKind) => {
      if (reported.current) return;
      reported.current = kind;
      void reportLeaving(attempt, kind).then(s => { if (s) status.current?.(s.state); });
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') leave('HIDDEN'); };
    const onBlur = () => {
      if (blurTimer) clearTimeout(blurTimer);
      blurTimer = setTimeout(() => {
        blurTimer = null;
        // Focus inside an embedded frame of this page is still this page.
        if (!document.hasFocus() && document.activeElement?.tagName !== 'IFRAME') leave('BLUR');
      }, attempt.blurGraceMs);
    };
    const onFocus = () => { if (blurTimer) { clearTimeout(blurTimer); blurTimer = null; } };
    const onPageHide = () => leave('PAGEHIDE');
    const onBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    // Already hidden or unfocused when the contest starts (e.g. the match began while the learner was elsewhere).
    if (document.visibilityState === 'hidden') leave('HIDDEN'); else if (!document.hasFocus()) onBlur();
    return () => {
      if (blurTimer) clearTimeout(blurTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [attempt, active]);

  /** The view is going away while the contest runs (in-app navigation, Back): report it once. */
  useEffect(() => {
    if (!attempt) return;
    const id = attempt.id;
    pendingUnmount.delete(id);
    return () => {
      if (!live.current || reported.current) return;
      // React may unmount and mount again at once in development; report only if this attempt's view did not come back.
      const t = setTimeout(() => { if (pendingUnmount.get(id) === t) { pendingUnmount.delete(id); void reportLeaving(attempt, 'NAVIGATION'); } }, 0);
      pendingUnmount.set(id, t);
    };
  }, [attempt]);

  return { report: (kind: LeaveKind) => { if (attempt && !reported.current) { reported.current = kind; return reportLeaving(attempt, kind); } return Promise.resolve(null); } };
}
const pendingUnmount = new Map<string, ReturnType<typeof setTimeout>>();
