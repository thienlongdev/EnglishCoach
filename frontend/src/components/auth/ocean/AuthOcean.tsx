'use client';

import React, { useEffect, useRef } from 'react';
import type { AuthMood, AuthOceanEngine, AuthSky } from './authOceanEngine';
import { registerJourneyStage } from '@/lib/journey/journey';
import s from '../authGlass.module.css';

/**
 * Host of the living sign-in ocean (`authOceanEngine`). The engine's chunk (three.js) loads only after the page is
 * interactive, so the form never waits for it; until its first frame — and wherever WebGL 2 is missing, Save-Data is on
 * or the context is lost — the CSS world of `AuthScene` stays. The shell carries the lifecycle as `data-ocean`
 * (`css` → `live` | `off-<reason>`), `data-ocean-state` (engine) and `data-ocean-echo` (`loading` → `swimming` |
 * `missing`) for QA.
 *
 * Decoration only: aria-hidden, no pointer capture. A tap on open water (never on the card, a link or a control) asks the
 * engine for a ripple.
 */
export function AuthOcean({ sky, mood }: { sky: AuthSky; mood: AuthMood }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<AuthOceanEngine | null>(null);
  const skyRef = useRef(sky);
  skyRef.current = sky;

  useEffect(() => {
    const canvas = canvasRef.current;
    const shell = canvas?.closest<HTMLElement>('[data-purpose="auth-standalone-shell"]');
    if (!canvas || !shell) return;
    const mark = (value: string) => {
      shell.dataset.ocean = value;
    };
    const isDark = () => document.documentElement.classList.contains('dark');

    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
    let webgl2 = false;
    try {
      webgl2 = !!document.createElement('canvas').getContext('webgl2');
    } catch {
      webgl2 = false;
    }
    if (saveData || !webgl2) {
      mark(saveData ? 'off-save-data' : 'off-webgl');
      return;
    }
    mark('css');

    let cancelled = false;
    let unregister: (() => void) | null = null;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    import('./authOceanEngine')
      .then(({ createAuthOceanEngine }) => {
        if (cancelled) return;
        engineRef.current = createAuthOceanEngine({
          canvas,
          sky: skyRef.current,
          night: isDark(),
          reducedMotion: reduced,
          onLive: () => mark('live'),
          onFail: (reason) => mark(`off-${reason}`),
          onState: (key, state) => {
            if (key === 'echo') shell.dataset.oceanEcho = state;
            else if (key === 'motion') shell.dataset.oceanMotion = state;
            else shell.dataset.oceanState = state;
          },
        });
        unregister = registerJourneyStage('auth', engineRef.current.stage);
      })
      .catch(() => mark('off-chunk'));

    // the theme toggle elsewhere writes the `dark` class: follow it
    const themeWatch = new MutationObserver(() => engineRef.current?.setSky(skyRef.current, isDark()));
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // no camera drift while the learner types
    const isField = (t: EventTarget | null) => t instanceof HTMLElement && t.matches('input, textarea, select');
    const onFocusIn = (e: FocusEvent) => isField(e.target) && engineRef.current?.setCalm(true);
    const onFocusOut = (e: FocusEvent) => isField(e.target) && engineRef.current?.setCalm(false);
    shell.addEventListener('focusin', onFocusIn);
    shell.addEventListener('focusout', onFocusOut);

    // a tap on open water
    const onPointerDown = (e: PointerEvent) => {
      if (!e.isPrimary || e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('a, button, input, label, select, textarea, iframe, [data-purpose="auth-card"], [role="dialog"], h1, p, li, header')) return;
      engineRef.current?.tap(e.clientX, e.clientY);
    };
    shell.addEventListener('pointerdown', onPointerDown);

    return () => {
      cancelled = true;
      unregister?.();
      themeWatch.disconnect();
      shell.removeEventListener('focusin', onFocusIn);
      shell.removeEventListener('focusout', onFocusOut);
      shell.removeEventListener('pointerdown', onPointerDown);
      engineRef.current?.dispose();
      engineRef.current = null;
      delete shell.dataset.ocean;
      delete shell.dataset.oceanState;
      delete shell.dataset.oceanEcho;
      delete shell.dataset.oceanMotion;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setSky(sky, document.documentElement.classList.contains('dark'));
  }, [sky]);

  useEffect(() => {
    engineRef.current?.setMood(mood);
  }, [mood]);

  return (
    <div className={s.oceanLayer} aria-hidden="true">
      <canvas ref={canvasRef} className={s.oceanCanvas} />
    </div>
  );
}

export default AuthOcean;
