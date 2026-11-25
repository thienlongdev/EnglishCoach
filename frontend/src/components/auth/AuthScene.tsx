'use client';

import React from 'react';
import type { MascotState } from './AuthEchoMascot';
import s from './authGlass.module.css';

/** Echo's still renders (the real 3D model, `scripts/render-echo-still.cjs`; content-hashed names, never replaced in place). */
const ECHO_ART = {
  day: '/assets/echo-auth-leap-e4a5910c.webp',
  dawn: '/assets/echo-auth-glide-959cd8cb.webp',
} as const;

/**
 * The sign-in world's first paint: a real frame of the living 3D sea (`docs/journey/cinematic-2026-10-31/capture`), matched to the engine's lens and horizon, so when the
 * engine's canvas fades in over it nothing changes place and no other picture of the sea was ever shown. It stays as the world where WebGL cannot run; only there does the
 * still Echo appear (CSS, `data-ocean^='off-'`). Decoration only: aria-hidden, no pointer, no request but the picture.
 */
export function AuthScene({ scene, mood = 'idle' }: { scene: 'day' | 'dawn'; mood?: MascotState }) {
  return (
    <div className={s.scene} aria-hidden="true">
      <div className={s.still} />
      <div className={s.echo} data-mood={mood}>
        <div className={s.echoBody}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a fixed decorative still; next/image would add a request route */}
          <img src={ECHO_ART[scene]} alt="" width={960} height={720} decoding="async" loading="lazy" draggable={false} />
        </div>
      </div>
    </div>
  );
}

export default AuthScene;
