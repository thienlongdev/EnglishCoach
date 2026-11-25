'use client';
/* The Adaptive Cinematic HUD of the immersive worlds (Echo Odyssey, Vũ trụ tri thức): one controller for when a world's
   controls are on screen and when the world has the screen to itself.

   discovery — on entry the controls are shown, so a newcomer sees what exists (≈ 4.5 s);
   immersive — then the secondary controls fade and the world fills the view (a small location puck always stays);
   revealed  — the pointer comes near a control or an edge, the keyboard enters the controls, a touch asks for them,
               or something must stay visible (a menu, a dialog, typing, a pending choice): ALL of them return together.

   Elements take part by carrying the `hud.chrome` class (cinematicHud.module.css). Hidden controls keep their place and
   their keyboard order (a Tab into them reveals them) but take no pointer, so the world under them stays interactive.
   No timer runs while nothing changes; pointer tracking is one passive window listener with cached rectangles. */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export type HudState = 'discovery' | 'immersive' | 'revealed';

export interface HudOptions {
  /** Something that must stay visible now (an open menu or dialog, a focused field, a pending confirmation). */
  hold: boolean;
  /** Off: the controls simply stay (e.g. a fallback view without a scene). */
  enabled?: boolean;
  /** How long the controls show on entry. */
  discoveryMs?: number;
  /** Pause before the controls fade once the pointer left them (never at once: no flicker). */
  hideMs?: number;
}

/** Pixels around a control that still count as "near it" (wider while shown, so moving between controls never hides them). */
const NEAR_SHOWN = 44, NEAR_HIDDEN = 26;
/** The top and bottom edges of the world that call the controls back. */
const EDGE = 64;

export function useCinematicHud(root: RefObject<HTMLElement | null>, { hold, enabled = true, discoveryMs = 4500, hideMs = 900 }: HudOptions) {
  const [state, setState] = useState<HudState>('discovery');
  const near = useRef(false), focused = useRef(false), touchUntil = useRef(0), discoveryUntil = useRef(0);
  const holdRef = useRef(hold); holdRef.current = hold;
  const enabledRef = useRef(enabled); enabledRef.current = enabled;
  const timer = useRef<number | null>(null);
  const rects = useRef<{ at: number; list: DOMRect[]; box: DOMRect | null }>({ at: 0, list: [], box: null });
  const stateRef = useRef(state); stateRef.current = state;

  // The one decision: shown while anything asks for it, otherwise hidden after a pause.
  const decide = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const now = performance.now();
    if (!enabledRef.current) { setState('revealed'); return; }
    const wanted = holdRef.current || near.current || focused.current || now < touchUntil.current;
    if (now < discoveryUntil.current && !wanted) {
      setState('discovery');
      timer.current = window.setTimeout(decide, discoveryUntil.current - now + 20);
      return;
    }
    if (wanted) {
      setState('revealed');
      if (now < touchUntil.current && !holdRef.current && !focused.current) timer.current = window.setTimeout(decide, touchUntil.current - now + 20);
      return;
    }
    if (stateRef.current === 'immersive') return;
    timer.current = window.setTimeout(() => { timer.current = null; if (!holdRef.current && !near.current && !focused.current && performance.now() >= touchUntil.current) setState('immersive'); }, hideMs);
  }, [hideMs]);

  useEffect(() => { discoveryUntil.current = performance.now() + discoveryMs; decide(); return () => { if (timer.current) clearTimeout(timer.current); }; }, [discoveryMs, decide]);
  useEffect(() => { decide(); }, [hold, enabled, decide]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = (force = false) => {
      const now = performance.now();
      if (!force && now - rects.current.at < 400) return rects.current;
      const list = Array.from(el.querySelectorAll<HTMLElement>('[data-hud-chrome]')).filter(c => c.offsetParent !== null || c.getClientRects().length > 0).map(c => c.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
      rects.current = { at: now, list, box: el.getBoundingClientRect() };
      return rects.current;
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return; // a finger has no hover: touches reveal through their own path
      const { list, box } = measure();
      if (!box) return;
      const x = e.clientX, y = e.clientY;
      const inside = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
      const pad = stateRef.current === 'immersive' ? NEAR_HIDDEN : NEAR_SHOWN;
      // Buttons held: a drag of the world never reveals the controls (only a pointer at rest near them, or on them).
      const dragging = e.buttons !== 0 && !list.some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
      const isNear = inside && !dragging && (y - box.top < EDGE || box.bottom - y < EDGE
        || list.some(r => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad));
      if (isNear !== near.current) { near.current = isNear; decide(); }
    };
    const onLeave = () => { if (near.current) { near.current = false; decide(); } };
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      const inChrome = !!t?.closest?.('[data-hud-chrome]');
      if (inChrome !== focused.current) { focused.current = inChrome; decide(); }
    };
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as HTMLElement | null;
      const stays = !!next?.closest?.('[data-hud-chrome]');
      if (!stays && focused.current) { focused.current = false; decide(); }
    };
    // A touch on a control keeps the controls up a little longer (no hover to keep them).
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      if ((e.target as HTMLElement | null)?.closest?.('[data-hud-chrome]')) { touchUntil.current = performance.now() + 5000; decide(); }
    };
    const onResize = () => measure(true);
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    window.addEventListener('blur', onLeave);
    window.addEventListener('resize', onResize, { passive: true });
    el.addEventListener('focusin', onFocusIn);
    el.addEventListener('focusout', onFocusOut);
    el.addEventListener('pointerdown', onDown, { capture: true, passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('blur', onLeave);
      window.removeEventListener('resize', onResize);
      el.removeEventListener('focusin', onFocusIn);
      el.removeEventListener('focusout', onFocusOut);
      el.removeEventListener('pointerdown', onDown, { capture: true });
    };
    // `enabled` re-attaches once the world's element exists (a page renders its loading screen first).
  }, [root, decide, enabled]);

  /** Show the controls now (the puck's "more" button, a touch, a hint): for `ms`, then the usual rule. */
  const reveal = useCallback((ms = 5000) => { touchUntil.current = performance.now() + ms; rects.current.at = 0; decide(); }, [decide]);
  /** Hide them now (the learner said so). */
  const conceal = useCallback(() => { touchUntil.current = 0; discoveryUntil.current = 0; near.current = false; if (!holdRef.current && !focused.current) { if (timer.current) clearTimeout(timer.current); setState('immersive'); } }, []);
  return { state, shown: state !== 'immersive', reveal, conceal };
}

/* A short, one-time hint per world and browser (how to explore), and a contextual one when the learner seems stuck
   (presses on empty space). Never a tour, never repeated once dismissed for good. */
const HINT_KEY = 'ec_world_hint:v1';
export function useWorldHint(world: 'cosmos' | 'odyssey', enabled: boolean) {
  const [hint, setHint] = useState<null | 'first' | 'stuck'>(null);
  const misses = useRef<number[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let seen = false;
    try { seen = JSON.parse(localStorage.getItem(HINT_KEY) || '{}')[world] === 1; } catch { /* storage unavailable: show once this visit */ }
    if (seen) return;
    const t = window.setTimeout(() => setHint('first'), 900);
    return () => clearTimeout(t);
  }, [world, enabled]);
  useEffect(() => {
    if (!hint) return;
    const t = window.setTimeout(() => setHint(null), hint === 'first' ? 9000 : 7000);
    return () => clearTimeout(t);
  }, [hint]);
  const dismiss = useCallback(() => {
    setHint(null);
    try { const v = JSON.parse(localStorage.getItem(HINT_KEY) || '{}'); v[world] = 1; localStorage.setItem(HINT_KEY, JSON.stringify(v)); } catch { /* optional */ }
  }, [world]);
  /** A press that found nothing: three of them within six seconds bring the contextual hint back once. */
  const missed = useCallback(() => {
    const now = Date.now();
    misses.current = [...misses.current.filter(t => now - t < 6000), now];
    if (misses.current.length >= 3) { misses.current = []; setHint('stuck'); }
  }, []);
  const interacted = useCallback(() => { if (hint === 'first') dismiss(); }, [hint, dismiss]);
  return { hint, dismiss, missed, interacted };
}
