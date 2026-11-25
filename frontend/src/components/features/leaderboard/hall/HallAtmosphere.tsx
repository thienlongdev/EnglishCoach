'use client';

import React, { useId } from 'react';
import styles from './hall.module.css';

/** Deterministic mote field (same on server and client): position, size, speed, drift, tone. */
const MOTES = (() => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const tones = ['gold', 'gold', 'cyan', 'violet'] as const;
  return Array.from({ length: 22 }, (_, i) => ({
    left: `${(4 + rnd() * 92).toFixed(1)}%`,
    size: `${(2 + rnd() * 4).toFixed(1)}px`,
    duration: `${(14 + rnd() * 14).toFixed(1)}s`,
    delay: `${(-rnd() * 26).toFixed(1)}s`,
    drift: `${Math.round(-30 + rnd() * 60)}px`,
    tone: tones[i % tones.length],
  }));
})();

function Banner({ side }: { side: 'l1' | 'l2' | 'r1' | 'r2' }) {
  const id = useId().replace(/:/g, '');
  const violet = side === 'l2' || side === 'r2';
  return (
    <span className={styles.banner} data-side={side}>
      <svg viewBox="0 0 60 172" role="presentation" focusable="false">
        <defs>
          <linearGradient id={`${id}c`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={violet ? '#6d4dff' : '#2f6bff'} />
            <stop offset="0.55" stopColor={violet ? '#3a1f9e' : '#1638b8'} />
            <stop offset="1" stopColor={violet ? '#1e0f5a' : '#0b1d6e'} />
          </linearGradient>
          <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff2c2" />
            <stop offset="0.5" stopColor="#f5bf4f" />
            <stop offset="1" stopColor="#c98612" />
          </linearGradient>
          <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.5" stopColor="#fff" stopOpacity="0.28" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <clipPath id={`${id}k`}>
            <path d="M8 8 H52 V140 L30 166 L8 140 Z" />
          </clipPath>
        </defs>
        <path d="M8 8 H52 V140 L30 166 L8 140 Z" fill={`url(#${id}c)`} />
        <g clipPath={`url(#${id}k)`}>
          <rect className={styles.bannerSheen} x="0" y="0" width="60" height="70" fill={`url(#${id}s)`} />
        </g>
        <path d="M8 8 H52 V140 L30 166 L8 140 Z" fill="none" stroke={`url(#${id}g)`} strokeWidth="2.6" />
        <path d="M13 14 H47 V136 L30 157 L13 136 Z" fill="none" stroke={`url(#${id}g)`} strokeWidth="0.9" opacity="0.7" />
        <circle cx="30" cy="62" r="13" fill="none" stroke={`url(#${id}g)`} strokeWidth="2" />
        <path d="M30 49 L34.5 62 L30 75 L25.5 62 Z" fill={`url(#${id}g)`} />
        <path d="M17 62 L30 59 L43 62 L30 65 Z" fill={`url(#${id}g)`} opacity="0.8" />
        <rect x="2" y="2" width="56" height="7" rx="3.5" fill={`url(#${id}g)`} />
        <circle cx="3" cy="5.5" r="3.5" fill="#ffe7a8" />
        <circle cx="57" cy="5.5" r="3.5" fill="#ffe7a8" />
      </svg>
    </span>
  );
}

/** Light shafts from the great window, swaying banners and rising motes. Pure decoration: aria-hidden, no pointer. */
export function HallAtmosphere() {
  return (
    <div className={styles.atmos} aria-hidden="true">
      <span className={styles.shaft} />
      <span className={styles.shaft} />
      <span className={styles.shaft} />
      <Banner side="l1" />
      <Banner side="l2" />
      <Banner side="r2" />
      <Banner side="r1" />
      {MOTES.map((m, i) => (
        <span
          key={i}
          className={styles.mote}
          data-tone={m.tone}
          style={{ left: m.left, '--s': m.size, '--d': m.duration, '--delay': m.delay, '--drift': m.drift } as React.CSSProperties}
        />
      ))}
    </div>
  );
}
