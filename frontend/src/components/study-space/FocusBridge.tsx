'use client';

import React, { useEffect, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import { createPortal } from 'react-dom';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { mutate } from 'swr';
import { chime, getFocusEngine } from '@/lib/study-space/focus';
import { studySpaceApi } from '@/lib/study-space/api';
import { pipWindow, subscribePip } from './portable';
import { echoSrc } from '@/lib/brand/echoCharacters';

/**
 * Mounted once by the application frame on every signed-in screen: it connects the account's focus timer to the
 * server record (idempotent reports, capped by the server clock), plays the chime / shows the browser notification
 * when a phase ends (only in the tab that ended it), and shows the floating timer on other pages while a session
 * runs. The dock's UI is a separate chunk loaded only while a session is active.
 */

const FocusDock = dynamic(() => import('./FocusDock'), { ssr: false });
const PipTimer = dynamic(() => import('./PipTimer'), { ssr: false });

export default function FocusBridge() {
  const { data: session } = useSession();
  const account = session?.user ? String((session.user as { id?: string | number }).id ?? '') : '';
  const pathname = usePathname() || '';
  const engine = account ? getFocusEngine(account) : null;
  const state = useSyncExternalStore(engine?.subscribe ?? noopSub, engine?.snapshot ?? nullSnap, nullSnap);
  const pip = useSyncExternalStore(subscribePip, pipWindow, () => null);

  useEffect(() => {
    if (!engine) return;
    engine.setReporter((s, status, focusedMs) => {
      if (!s.sessionId) return;
      void studySpaceApi.reportFocus(s.sessionId, {
        mode: s.mode, status, plannedSeconds: Math.round(s.durationMs / 1000), focusedSeconds: Math.round(focusedMs / 1000),
        taskId: s.taskId, label: s.label, subject: s.subject,
      }).then(async () => {
        if(s.blockId&&s.sessionId) await studySpaceApi.linkBlockSession(s.blockId,s.sessionId);
        if (status !== 'RUNNING') void mutate((key) => Array.isArray(key) && (key[0] === 'study-space/focus-stats' || key[0] === 'study-space/tasks'));
      }).catch(() => { /* offline: the next report of the same id carries the time */ });
    });
    const off = engine.onEvent((e, s) => {
      if (s.settings.sound) chime(e.kind);
      if (s.settings.notify && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const title = e.kind === 'focus-done' ? 'Xong một phiên tập trung' : e.kind === 'break-done' ? 'Hết giờ nghỉ' : 'Phiên tập trung đã tạm dừng';
        const body = e.kind === 'focus-done' ? 'Nghỉ một chút nhé.' : e.kind === 'break-done' ? 'Sẵn sàng cho phiên tiếp theo.' : 'Máy đã ngủ hoặc trình duyệt bị đóng một lúc lâu.';
        try { new Notification(title, { body, icon: echoSrc('official', 64), tag: 'ec-focus' }); } catch { /* notification unavailable */ }
      }
    });
    return () => { off(); engine.setReporter(null); };
  }, [engine]);

  if (!engine || !state) return null;
  const active = state.status !== 'idle' || (state.mode === 'POMODORO' && state.phase !== 'focus');
  const inSpace = pathname.startsWith('/study-space');
  return (
    <>
      {active && !inSpace && !pip && <FocusDock />}
      {pip && createPortal(<PipTimer />, pip.document.getElementById('ec-focus-pip') ?? pip.document.body)}
    </>
  );
}

const noopSub = () => () => {};
const nullSnap = () => null;
