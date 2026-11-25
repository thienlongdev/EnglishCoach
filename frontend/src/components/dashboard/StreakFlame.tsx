"use client";

import { useId } from "react";
import styles from "./dashboard.module.css";

/**
 * The streak tile's flame (decorative, `aria-hidden`): three tongues of fire (outer red-orange, amber body, white-gold
 * core) over a blue root, a shade that gives the body volume and a few embers rising from it. Every layer flickers from
 * its own base on its own rhythm, so the fire never visibly loops. `lit` is the learner's real streak (> 0 days); without
 * one it is a still, cooled ember. Transform / opacity only, all of it still under reduced motion.
 */
export function StreakFlame({ lit }: { lit: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const g = (name: string) => `sf-${name}-${id}`;
  return (
    <span className={styles.flame} data-lit={lit ? "true" : "false"} aria-hidden="true">
      <i className={styles.flameGlow} />
      <svg viewBox="0 0 32 40" className={styles.flameSvg}>
        <defs>
          <linearGradient id={g("outer")} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#e11d48" />
            <stop offset="0.45" stopColor="#f97316" />
            <stop offset="1" stopColor="#fb923c" />
          </linearGradient>
          <linearGradient id={g("mid")} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fb923c" />
            <stop offset="0.6" stopColor="#fbbf24" />
            <stop offset="1" stopColor="#fcd34d" />
          </linearGradient>
          <linearGradient id={g("core")} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fef3c7" />
            <stop offset="1" stopColor="#fffbeb" />
          </linearGradient>
          <radialGradient id={g("shade")} cx="0.36" cy="0.62" r="0.7">
            <stop offset="0.45" stopColor="#7c2d12" stopOpacity="0" />
            <stop offset="1" stopColor="#7c2d12" stopOpacity="0.38" />
          </radialGradient>
          <radialGradient id={g("root")} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#93c5fd" stopOpacity="0.95" />
            <stop offset="1" stopColor="#3b82f6" stopOpacity="0" />
          </radialGradient>
        </defs>
        <g className={styles.flameOuter}>
          <path fill={`url(#${g("outer")})`} d="M16 1.5C17.6 7.2 23.8 10.6 25.9 17.6C28.3 25.6 24.6 35.4 16 38.5C7.4 35.4 3.7 26.4 6.2 19.2C7.4 15.8 9.6 13.6 10.4 9.8C12.6 12.4 13.2 15.2 13.8 17C14.6 11.8 14.3 6.6 16 1.5Z" />
          <path fill={`url(#${g("shade")})`} d="M16 1.5C17.6 7.2 23.8 10.6 25.9 17.6C28.3 25.6 24.6 35.4 16 38.5C7.4 35.4 3.7 26.4 6.2 19.2C7.4 15.8 9.6 13.6 10.4 9.8C12.6 12.4 13.2 15.2 13.8 17C14.6 11.8 14.3 6.6 16 1.5Z" />
          <path className={styles.flameSheen} d="M9.2 21.5C8.4 25.6 9.6 30.4 12.6 33.4" />
        </g>
        <path className={styles.flameMid} fill={`url(#${g("mid")})`} d="M16 10C17.4 14.6 21.8 17.4 22.6 22.8C23.6 29.4 20.6 34.8 16 36.4C11.4 34.8 8.6 30 9.6 24.6C10.2 21.6 12 20 12.6 17.4C14 19.2 14.2 21 14.6 22.2C15.2 18.2 15 13.8 16 10Z" />
        <path className={styles.flameCore} fill={`url(#${g("core")})`} d="M16 19.5C17.2 22.6 20 24.4 20 28.4C20 32.6 18.2 35 16 35.6C13.8 35 12 32.6 12 28.8C12 26.2 13.8 24.6 14.4 22.6C15 23.6 15.2 24.4 15.4 25.2C15.8 23 15.6 21.2 16 19.5Z" />
        <ellipse className={styles.flameRoot} cx="16" cy="34.4" rx="3.2" ry="1.7" fill={`url(#${g("root")})`} />
        <g className={styles.embers}>
          <circle cx="12" cy="14" r="0.9" />
          <circle cx="19.5" cy="11" r="0.75" />
          <circle cx="15.5" cy="8" r="0.6" />
        </g>
      </svg>
    </span>
  );
}
