'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import s from './edge.module.css';

/**
 * One way for the toolbars of the 3D places (the study room, Speaking Arena, Echo Quiz Rush) to give the screen to the world: a bar sits at the top or the
 * bottom edge, slides away when nobody is using it, and comes back when the pointer reaches that edge, when the keyboard focus enters it, on a tap near the edge,
 * or on the HUD key (which is the only way under mouse-look, where the pointer cannot reach an edge). A bar never leaves while it holds the focus, an open menu
 * or something the place says must stay (`hold`). Nothing is removed from the page: a hidden bar is still in the tab order and in the accessibility tree.
 */
export type HudEdge = 'top' | 'bottom';
export interface EdgeRevealOptions {
  /** False: the bars stay where they are (a phone's touch controls, a form that must be read). */
  enabled?: boolean;
  /** Pixels from the screen edge that bring a bar back. */
  zone?: number;
  /** Persistent panel disclosures can fold away with the bar when pointer and focus leave. */
  hideExpandedPanels?: boolean;
  /** How long the bars stay when the place opens, so the player sees they exist. */
  introMs?: number;
  /** A bar that must stay now (the call to connect voice, a running countdown). */
  hold?: Partial<Record<HudEdge, boolean>>;
  /** Mouse-look is on: the bars step aside unless the player asked for them. */
  locked?: boolean;
}
export interface EdgeBinding {
  ref: (el: HTMLElement | null) => void;
  className: string;
  'data-hud-edge': HudEdge;
  'data-hud-hidden'?: 'true';
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onFocusCapture: () => void;
  onBlurCapture: () => void;
}
export interface EdgeReveal {
  shown: Record<HudEdge, boolean>;
  /** The HUD key: bring everything up and keep it, or put it away. */
  toggle(): void;
  /** Up for a moment (a tap, a notice that points at a control). */
  peek(edge?: HudEdge, ms?: number): void;
  pinned: boolean;
  /** The bars have hidden at least once this visit and the player has not been told how to bring them back yet. */
  hint: boolean;
  /** Props for one bar of an edge; several bars of one edge each pass their own `key`. */
  bind(edge: HudEdge, key?: string): EdgeBinding;
}

const HINT_KEY = 'ec_hud_hint:v1';
const EDGES: HudEdge[] = ['top', 'bottom'];

export function useEdgeReveal(opts: EdgeRevealOptions = {}): EdgeReveal {
  const enabled = opts.enabled !== false, zone = opts.zone ?? 26, intro = opts.introMs ?? 3200;
  const o = useRef(opts); o.current = opts;
  const [shown, setShown] = useState<Record<HudEdge, boolean>>({ top: true, bottom: true });
  const [pinned, setPinned] = useState(false);
  const [hint, setHint] = useState(false);
  const pinnedRef = useRef(false);
  const els = useRef<Record<HudEdge, Set<HTMLElement>>>({ top: new Set(), bottom: new Set() });
  const over = useRef<Record<HudEdge, number>>({ top: 0, bottom: 0 });
  const near = useRef<Record<HudEdge, boolean>>({ top: false, bottom: false });
  const timers = useRef<Record<HudEdge, number | undefined>>({ top: undefined, bottom: undefined });
  const hidOnce = useRef(false);

  const busy = useCallback((edge: HudEdge) => {
    const active = document.activeElement;
    for (const el of els.current[edge]) {
      // Keyboard focus (or a field being typed in) keeps the bar; a button the mouse just clicked does not.
      if (active && active !== document.body && el.contains(active) && active.matches(':focus-visible, input, textarea, select, [contenteditable="true"]')) return true;
      const keep=o.current.hideExpandedPanels?'[data-hud-keep]':'[aria-expanded="true"], details[open], [data-hud-keep]';
      if (el.querySelector(keep)) return true;
    }
    return false;
  }, []);
  const clear = (edge: HudEdge) => { if (timers.current[edge] !== undefined) { window.clearTimeout(timers.current[edge]); timers.current[edge] = undefined; } };
  const reveal = useCallback((edge: HudEdge) => { clear(edge); setShown(v => v[edge] ? v : { ...v, [edge]: true }); }, []);
  const conceal = useCallback((edge: HudEdge, delay = 650) => {
    clear(edge);
    timers.current[edge] = window.setTimeout(() => {
      timers.current[edge] = undefined;
      if (o.current.enabled === false || pinnedRef.current || o.current.hold?.[edge] || over.current[edge] > 0 || near.current[edge]) return;
      // A focused control or an open menu keeps its bar; look again a little later.
      if (busy(edge)) { conceal(edge, 900); return; }
      setShown(v => v[edge] ? { ...v, [edge]: false } : v);
      if (!hidOnce.current) {
        hidOnce.current = true;
        let seen = 0;
        try { seen = Number(localStorage.getItem(HINT_KEY) || 0) || 0; if (seen < 3) localStorage.setItem(HINT_KEY, String(seen + 1)); } catch { /* told this visit only */ }
        if (seen < 3) { setHint(true); window.setTimeout(() => setHint(false), 4200); }
      }
    }, delay);
  }, [busy]);

  // Shown when the place opens, then out of the way.
  useEffect(() => {
    if (!enabled) { setShown({ top: true, bottom: true }); return; }
    setShown({ top: true, bottom: true });
    EDGES.forEach(e => conceal(e, intro));
    return () => EDGES.forEach(clear);
  }, [enabled, intro, conceal]);

  // A bar the place holds is up; when the hold ends it may go.
  const holdTop = !!opts.hold?.top, holdBottom = !!opts.hold?.bottom;
  useEffect(() => { if (!enabled) return; if (holdTop) reveal('top'); else conceal('top', 1200); }, [holdTop, enabled, reveal, conceal]);
  useEffect(() => { if (!enabled) return; if (holdBottom) reveal('bottom'); else conceal('bottom', 1200); }, [holdBottom, enabled, reveal, conceal]);
  // Mouse-look taken: the view belongs to the world unless the player pinned the bars.
  const locked = !!opts.locked;
  useEffect(() => { if (!enabled || !locked || pinnedRef.current) return; EDGES.forEach(e => conceal(e, 250)); }, [locked, enabled, conceal]);

  useEffect(() => {
    if (!enabled) return;
    const move = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || document.pointerLockElement) return;
      const h = window.innerHeight;
      const next = { top: e.clientY <= zone, bottom: e.clientY >= h - zone };
      for (const edge of EDGES) {
        if (next[edge] === near.current[edge]) continue;
        near.current[edge] = next[edge];
        if (next[edge]) reveal(edge); else conceal(edge);
      }
    };
    const tap = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
      const h = window.innerHeight, reach = Math.max(zone, 56);
      if (e.clientY <= reach) { reveal('top'); conceal('top', 4500); }
      if (e.clientY >= h - reach) { reveal('bottom'); conceal('bottom', 4500); }
    };
    const out = (e: MouseEvent) => { if (e.relatedTarget) return; for (const edge of EDGES) { if (near.current[edge]) { near.current[edge] = false; conceal(edge); } } };
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerdown', tap, { passive: true, capture: true });
    document.addEventListener('mouseout', out);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerdown', tap, { capture: true }); document.removeEventListener('mouseout', out); };
  }, [enabled, zone, reveal, conceal]);

  const toggle = useCallback(() => {
    const next = !pinnedRef.current;
    pinnedRef.current = next; setPinned(next);
    if (next) EDGES.forEach(reveal);
    else EDGES.forEach(e => conceal(e, 0));
  }, [reveal, conceal]);
  const peek = useCallback((edge?: HudEdge, ms = 2600) => { for (const e of edge ? [edge] : EDGES) { reveal(e); conceal(e, ms); } }, [reveal, conceal]);

  const bindings = useRef(new Map<string, { ref: (el: HTMLElement | null) => void; enter: () => void; leave: () => void; focus: () => void; blur: () => void }>());
  const binding = useCallback((edge: HudEdge, key: string) => {
    const id = `${edge}:${key}`;
    let b = bindings.current.get(id);
    if (!b) {
      let el: HTMLElement | null = null, inside = false;
      b = {
        ref: (next: HTMLElement | null) => { if (el) els.current[edge].delete(el); el = next; if (next) els.current[edge].add(next); else if (inside) { inside = false; over.current[edge] = Math.max(0, over.current[edge] - 1); } },
        enter: () => { if (!inside) { inside = true; over.current[edge]++; } reveal(edge); },
        leave: () => { if (inside) { inside = false; over.current[edge] = Math.max(0, over.current[edge] - 1); } conceal(edge); },
        focus: () => reveal(edge),
        blur: () => conceal(edge, 400),
      };
      bindings.current.set(id, b);
    }
    return b;
  }, [reveal, conceal]);

  const bind = useCallback((edge: HudEdge, key = 'bar'): EdgeBinding => {
    const b = binding(edge, key), hidden = enabled && !shown[edge];
    return {
      ref: b.ref, className: s.edge, 'data-hud-edge': edge, ...(hidden ? { 'data-hud-hidden': 'true' as const } : {}),
      onPointerEnter: b.enter, onPointerLeave: b.leave, onFocusCapture: b.focus, onBlurCapture: b.blur,
    };
  }, [binding, enabled, shown]);

  return { shown: enabled ? shown : { top: true, bottom: true }, toggle, peek, pinned, hint, bind };
}
