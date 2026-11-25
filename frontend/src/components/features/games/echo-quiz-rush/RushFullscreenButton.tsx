'use client';

import { useEffect, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';

/**
 * One fullscreen toggle for every Rush screen (hall, setup, rooms, race HUD, results). Its state is the browser's real
 * one (`fullscreenchange`), read again on every mount, so leaving fullscreen with Escape, a remount or a route change
 * never leaves a stale icon or hides the control. Fullscreen is entered only from this click (a user gesture). Where the
 * browser does not allow it, the button stays visible, disabled, with the reason.
 */
export function RushFullscreenButton({ vi, className = '' }: { vi: boolean; className?: string }) {
  const [on, setOn] = useState(false), [supported, setSupported] = useState(true);
  useEffect(() => {
    const sync = () => setOn(!!document.fullscreenElement);
    setSupported(!!document.fullscreenEnabled && !!document.documentElement.requestFullscreen);
    sync(); document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    else void document.documentElement.requestFullscreen?.().catch(() => setOn(false));
  };
  const label = !supported ? (vi ? 'Trình duyệt này không cho phép toàn màn hình' : 'This browser does not allow fullscreen')
    : on ? (vi ? 'Thoát toàn màn hình' : 'Exit fullscreen') : (vi ? 'Toàn màn hình' : 'Fullscreen');
  return <button type="button" className={className} data-testid="rush-fullscreen" aria-label={label} title={label} aria-pressed={on} disabled={!supported} onClick={toggle}>
    {on ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
  </button>;
}
