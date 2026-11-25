'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { HALL_ART } from './hallArt';
import type { TrophyHandle } from './trophyScene';
import styles from './hall.module.css';

/**
 * The hall's trophy: the rendered still paints first (and stays without WebGL, on Save-Data or after a lost context); the
 * real-time three.js trophy loads in its own chunk once the browser is idle and fades in over the still after its first frame.
 * It renders only while `live` (hall on screen, tab visible); under reduced motion it draws one settled frame and stops.
 */
export function HallTrophy({ live, handleRef }: { live: boolean; handleRef: React.MutableRefObject<TrophyHandle | null> }) {
  const reduce = useReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  const [gl, setGl] = useState<'off' | 'ready'>('off');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
    if (saveData) return;
    let cancelled = false;
    const start = () => {
      import('./trophyScene')
        .then(({ mountTrophy }) => {
          if (cancelled) return;
          try {
            handleRef.current = mountTrophy(canvas, {
              still: !!reduce,
              onFirstFrame: () => { if (!cancelled) setGl('ready'); },
              onLost: () => { if (!cancelled) setGl('off'); },
            });
            handleRef.current.setActive(liveRef.current);
          } catch {
            handleRef.current = null; // no WebGL: the still stays
          }
        })
        .catch(() => { /* chunk failed: the still stays */ });
    };
    const hasIdle = typeof window.requestIdleCallback === 'function';
    const idle = hasIdle ? window.requestIdleCallback(start, { timeout: 1500 }) : window.setTimeout(start, 300);
    return () => {
      cancelled = true;
      if (hasIdle) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
      handleRef.current?.dispose();
      handleRef.current = null;
      setGl('off');
    };
  }, [reduce, handleRef]);

  useEffect(() => {
    handleRef.current?.setActive(live);
  }, [live, handleRef]);

  return (
    <div className={styles.trophy} data-gl={gl} data-testid="hall-trophy" aria-hidden="true">
      <span className={styles.trophyGlow} />
      {/* eslint-disable-next-line @next/next/no-img-element -- static, content-hashed, transparent still */}
      <img className={styles.trophyStill} src={HALL_ART.trophy} alt="" width={480} height={560} decoding="async" />
      <canvas ref={canvasRef} className={styles.trophyCanvas} />
    </div>
  );
}
