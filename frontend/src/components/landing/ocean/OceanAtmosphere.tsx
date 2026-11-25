'use client';

import React, { useEffect, useRef } from 'react';
import styles from '../landing.module.css';

/**
 * The water itself, in CSS: surface glow and light shafts at the top, slow colour drift, and a descent that darkens
 * toward the abyss before a violet "dawn" rises behind the final call to action. Scroll only moves one custom
 * property (`--ocean-depth`, 0 → 1); every layer reacts with opacity, so no layout or paint work follows a scroll.
 */
export function OceanAtmosphere() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      element.style.setProperty('--ocean-depth', Math.min(1, Math.max(0, window.scrollY / max)).toFixed(3));
    };
    const request = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', request, { passive: true });
    window.addEventListener('resize', request, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', request);
      window.removeEventListener('resize', request);
    };
  }, []);

  return (
    <div ref={ref} aria-hidden="true" className={styles.atmosphere} data-purpose="landing-ocean-atmosphere">
      <div className={styles.deep} />
      <div className={styles.surface} />
      <div className={styles.glowIndigo} />
      <div className={styles.glowCyan} />
      <div className={styles.glowViolet} />
      <div className={styles.rays}>
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className={styles.abyss} />
      <div className={styles.dawn} />
    </div>
  );
}
