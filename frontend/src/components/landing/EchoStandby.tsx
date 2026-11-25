'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ECHO_STILL } from './ocean/echoAssets';
import { oceanSignals } from './ocean/oceanSignals';
import styles from './landing.module.css';
import { echoSrc } from '@/lib/brand/echoCharacters';

const GREETING = 'Chào bạn! Mình là Echo.';

interface EchoStandbyProps {
  /** `standby`: Echo is late, the still stands in. `handoff`: the 3D Echo is drawn under it; fade out. `still`: final. */
  state: 'standby' | 'handoff' | 'still';
}

/**
 * Echo as a still picture — the real model rendered with the ocean's lights (`ECHO_STILL`), so it is the same whale,
 * not a placeholder. Shown only when the 3D Echo is late or unavailable. While the 3D Echo is pending it carries
 * `data-echo-standby` (model units per image width): the engine reads the still's box and draws Echo exactly under
 * it, and the still then fades out over it — one whale throughout, never two.
 *
 * It is a picture and says so: decorative for assistive technology, click-through (the page's controls stay
 * reachable), and its one reaction is the greeting Echo gives everywhere — a tap on it in the water.
 */
export function EchoStandby({ state }: EchoStandbyProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [rendered, setRendered] = useState(true);
  const [greeting, setGreeting] = useState(false);

  // A tap ripple that lands on the still (WordRipple → `ocean:wake`): Echo says hello, as the 3D Echo does.
  useEffect(() => {
    let lastRipple = oceanSignals.rippleAt;
    let timer = 0;
    const onWake = () => {
      if (oceanSignals.rippleAt === lastRipple) return;
      lastRipple = oceanSignals.rippleAt;
      const box = imageRef.current?.getBoundingClientRect();
      if (!box) return;
      const dx = Math.abs(oceanSignals.rippleX - (box.left + box.width / 2));
      const dy = Math.abs(oceanSignals.rippleY - (box.top + box.height / 2));
      if (dx > box.width * 0.42 || dy > box.height * 0.28) return;
      setGreeting(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setGreeting(false), 2600);
    };
    window.addEventListener('ocean:wake', onWake);
    return () => {
      window.removeEventListener('ocean:wake', onWake);
      window.clearTimeout(timer);
    };
  }, []);

  const anchor = rendered && state !== 'still';
  return (
    <div
      aria-hidden="true"
      data-purpose="echo-still"
      className={`pointer-events-none absolute left-1/2 top-[6%] z-[1] w-[min(50vw,22rem)] -translate-x-1/2 transition-opacity duration-700 ease-out motion-reduce:transition-none sm:top-[5%] ${
        state === 'handoff' ? 'opacity-0' : 'opacity-100'
      }`}
    >
      <div className={styles.standbyIn}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a pre-sized still; the engine reads its exact box */}
        <img
          ref={imageRef}
          src={rendered ? ECHO_STILL.src : echoSrc('official', 256)}
          alt=""
          width={ECHO_STILL.width}
          height={ECHO_STILL.height}
          decoding="async"
          draggable={false}
          data-echo-standby={anchor ? ECHO_STILL.unit : undefined}
          // The still could not be fetched: the brand mark (already on the page) stands in, without a handoff anchor.
          onError={() => setRendered(false)}
          className={`h-auto w-full select-none ${styles.floatSlow}`}
        />
        {greeting && state !== 'handoff' && (
          <div className="absolute bottom-[68%] left-[30%] max-w-[16rem] rounded-2xl border border-white/70 bg-white/95 px-4 py-2.5 shadow-xl shadow-indigo-950/40">
            <p className="text-[13px] font-semibold leading-snug tracking-tight text-slate-800">{GREETING}</p>
            <span className="absolute -bottom-1.5 left-[28%] h-3.5 w-3.5 rotate-45 border-b border-r border-white/70 bg-white/95" />
          </div>
        )}
      </div>
    </div>
  );
}
