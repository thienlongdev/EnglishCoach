'use client';

import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Info } from 'lucide-react';
import { Vi } from '../Inline';
import styles from '../grammar.module.css';

/** `prefers-reduced-motion: reduce`, live. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const query = window.matchMedia('(prefers-reduced-motion: reduce)');
      query.addEventListener('change', notify);
      return () => query.removeEventListener('change', notify);
    },
    () => (typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
    () => false,
  );
}

/**
 * True while the element is on screen (or, with `once`, from the first time it was). Endless motion and one-time drawing both
 * hang on this, so nothing animates off screen. Without IntersectionObserver the element counts as visible.
 */
export function useInView<T extends Element = HTMLDivElement>(options: { once?: boolean; rootMargin?: string; threshold?: number } = {}) {
  const { once = false, rootMargin = '0px 0px -8% 0px', threshold = 0.12 } = options;
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') { setInView(true); return; }
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) { setInView(true); if (once) io.disconnect(); }
        else if (!once) setInView(false);
      }
    }, { rootMargin, threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [once, rootMargin, threshold]);
  return [ref, inView] as const;
}

/** Track an element's width (ResizeObserver), 0 until measured. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/**
 * The frame every diagram sits in: a figure with its caption, and the author's `alt` as a visually hidden description.
 * Diagrams are interactive and animate their own parts, so they are marked as owners of their motion (Echo Spatial and Echo
 * Morph leave them alone).
 */
export function Figure({ kind, caption, alt, children, className }: {
  kind: string; caption?: string; alt?: string; children: React.ReactNode; className?: string;
}) {
  const id = useId();
  return (
    <figure
      className={className ? `${styles.figure} ${className}` : styles.figure}
      data-kind={kind}
      data-guide="grammar-diagram"
      data-spatial-owner=""
      data-morph="off"
      aria-labelledby={caption ? `${id}-c` : undefined}
      aria-describedby={alt ? `${id}-a` : undefined}
    >
      <div className={styles.figBody}>{children}</div>
      {caption ? (
        <figcaption id={`${id}-c`} className={styles.figCap}>
          <Info aria-hidden="true" className={styles.figCapIcon} />
          <Vi text={caption} />
        </figcaption>
      ) : null}
      {alt ? <p id={`${id}-a`} className={styles.srOnly}>{alt}</p> : null}
    </figure>
  );
}

/** Words → small colour index, so a slot or a clause keeps its colour from one render to the next. */
export const hueOf = (i: number): number => i % 6;
