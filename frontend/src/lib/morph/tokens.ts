/**
 * Echo Morph motion tokens: the one vocabulary of timing and easing (10 §BN). No imports: safe in any module.
 * A motion uses Web Animations with no fill and the individual `translate` / `scale` properties, so it leaves nothing behind and never touches a component's own `transform`.
 */
/** Every animation of this system carries it: anything can tell them from a component's own. */
export const MORPH_ID = 'ec-morph';

/** Shared physics, in px/s. Critical/near-critical damping keeps large reading surfaces calm. */
export const MORPH_SPRING = {
  surface: { stiffness: 330, damping: 36, mass: 1, precision: 0.001 },
  control: { stiffness: 520, damping: 43, mass: 1, precision: 0.001 },
  sheet: { stiffness: 380, damping: 39, mass: 1, precision: 0.001 },
} as const;

export const MORPH_MS = { press: 120, quick: 170, base: 260, surface: 340, flight: 520, stagger: 34 } as const;

/** A settling water current: fast to leave, slow to arrive, no bounce. */
export const MORPH_EASE = {
  current: 'cubic-bezier(.22,1,.36,1)',
  flow: 'cubic-bezier(.32,.72,.16,1)',
  exit: 'cubic-bezier(.4,0,.8,.4)',
} as const;

export function morphReduced(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** The entry of something a learner just asked to see. Opacity only under reduced motion. Never hides the element if it cannot run. */
export function morphIn(el: Element, index = 0): Animation | null {
  if (typeof (el as HTMLElement).animate !== 'function') return null;
  const reduced = morphReduced();
  const frames: Keyframe[] = reduced
    ? [{ opacity: 0.6 }, { opacity: 1 }]
    : [{ opacity: 0, translate: '0 12px' }, { opacity: 1, translate: '0 0' }];
  return (el as HTMLElement).animate(frames, {
    duration: reduced ? MORPH_MS.quick : MORPH_MS.surface,
    delay: reduced ? 0 : Math.min(index, 8) * MORPH_MS.stagger,
    easing: MORPH_EASE.current,
    fill: 'none',
    id: MORPH_ID,
  });
}
