import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * Echo Glass pointer light (Dashboard + Games Hub). A fine pointer over a surface writes four CSS variables on it:
 * `--mx` / `--my` (0…1, where the light sits) and `--tx` / `--ty` (−0.5…0.5, how far a tilt leans). CSS turns them into a
 * specular highlight and a small 3D lean. One write per animation frame, transform / background only, nothing for touch
 * (a finger has no hover) and nothing under reduced motion. Leaving the surface springs it back.
 */
const frames = new WeakMap<HTMLElement, number>();

function reduced() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function followPointer(event: ReactPointerEvent<HTMLElement>) {
  if (event.pointerType === 'touch' || reduced()) return;
  const el = event.currentTarget;
  const { clientX, clientY } = event;
  if (frames.has(el)) return;
  frames.set(el, requestAnimationFrame(() => {
    frames.delete(el);
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const x = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (clientY - box.top) / box.height));
    el.style.setProperty('--mx', x.toFixed(3));
    el.style.setProperty('--my', y.toFixed(3));
    el.style.setProperty('--tx', (x - 0.5).toFixed(3));
    el.style.setProperty('--ty', (y - 0.5).toFixed(3));
    el.dataset.lit = 'true';
  }));
}

export function releasePointer(event: ReactPointerEvent<HTMLElement>) {
  const el = event.currentTarget;
  const frame = frames.get(el);
  if (frame !== undefined) { cancelAnimationFrame(frame); frames.delete(el); }
  el.style.removeProperty('--tx');
  el.style.removeProperty('--ty');
  delete el.dataset.lit;
}

/** Spread onto a surface: `<div {...pointerLight} />`. */
export const pointerLight = { onPointerMove: followPointer, onPointerLeave: releasePointer };
