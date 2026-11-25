'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/** One delegated pointer light for the Academy. Route/reveal motion stays with Echo Morph. */
export function GrammarAtmosphere({ children, className }: { children: ReactNode; className: string }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const enabled = matchMedia('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)');
    let surface: HTMLElement | null = null;
    let frame = 0;
    let x = 50, y = 50, targetX = 50, targetY = 50;
    const reset = () => {
      cancelAnimationFrame(frame); frame = 0;
      if (surface) {
        delete surface.dataset.pointer;
        for (const name of ['--gx', '--gy', '--rx', '--ry']) surface.style.removeProperty(name);
      }
      surface = null;
    };
    const paint = () => {
      frame = 0;
      if (!surface?.isConnected) { reset(); return; }
      x += (targetX - x) * 0.2; y += (targetY - y) * 0.2;
      surface.style.setProperty('--gx', `${x.toFixed(2)}%`);
      surface.style.setProperty('--gy', `${y.toFixed(2)}%`);
      surface.style.setProperty('--rx', `${((50 - y) * 0.025).toFixed(2)}deg`);
      surface.style.setProperty('--ry', `${((x - 50) * 0.025).toFixed(2)}deg`);
      if (Math.abs(targetX - x) + Math.abs(targetY - y) > 0.1) frame = requestAnimationFrame(paint);
    };
    const move = (event: PointerEvent) => {
      if (!enabled.matches || event.pointerType !== 'mouse' || document.documentElement.hasAttribute('data-guide-active') || document.documentElement.hasAttribute('data-morph-busy')) { reset(); return; }
      const next = (event.target as Element).closest<HTMLElement>('[data-grammar-card]');
      if (!next || !host.contains(next)) { reset(); return; }
      if (surface !== next) { reset(); surface = next; x = 50; y = 50; surface.dataset.pointer = 'true'; }
      const rect = next.getBoundingClientRect();
      targetX = Math.max(0, Math.min(100, (event.clientX - rect.left) / Math.max(1, rect.width) * 100));
      targetY = Math.max(0, Math.min(100, (event.clientY - rect.top) / Math.max(1, rect.height) * 100));
      if (!frame) frame = requestAnimationFrame(paint);
    };
    host.addEventListener('pointermove', move, { passive: true });
    host.addEventListener('pointerleave', reset);
    document.addEventListener('scroll', reset, true);
    document.addEventListener('visibilitychange', reset);
    enabled.addEventListener('change', reset);
    return () => {
      reset(); host.removeEventListener('pointermove', move); host.removeEventListener('pointerleave', reset);
      document.removeEventListener('scroll', reset, true); document.removeEventListener('visibilitychange', reset); enabled.removeEventListener('change', reset);
    };
  }, []);
  return <div ref={root} className={className}>{children}</div>;
}
