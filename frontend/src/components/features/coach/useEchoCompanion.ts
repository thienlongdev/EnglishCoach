'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';
import { ECHO_COMPANION_SPRITE } from '@/lib/brand/echoArt';
import { resolvePageTitle, type TabLiving } from '@/lib/brand/pageTitle';
import {
  DEFAULT_PLACE, DRAG_START_PX, ECHO_PLACE_KEY, ECHO_PREFS_KEY, NUDGE_DISMISS_MS, NUDGE_DWELL_MS, NUDGE_EVERY_MS, NUDGE_FIRST_MS, NUDGE_MAX_PER_VISIT,
  clampPoint, computeSafeBounds, nudgeLine, placeOf, pointOf, restorePlace, restorePrefs,
  type EchoBounds, type EchoPlace, type EchoPoint, type EchoPrefs, type EchoRect, type EchoSide,
} from './echo-companion';

const POSE = Object.fromEntries(ECHO_COMPANION_SPRITE.poses.map((name, i) => [name, i])) as Record<string, number>;
const tail = Array.from({ length: 16 }, (_, i) => POSE[`tail${i}`]);
const spray = Array.from({ length: 10 }, (_, i) => POSE[`spray${i}`]);
const CLIP = {
  blink: { frames: [POSE.half, POSE.closed, POSE.half], ms: 62 },
  tail: { frames: tail, ms: 74 },
  spray: { frames: spray, ms: 96 },
};

function viewportOf() {
  return { width: window.visualViewport?.width ?? window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight };
}

function toRect(r: DOMRect | undefined): EchoRect | null {
  if (!r || (!r.width && !r.height)) return null;
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
}

/**
 * On the workspace Echo swims over the content column, never on the sidebar, top bar, or revealed Dock.
 * Any control a page keeps at the bottom of the screen (marked `data-echo-clear`, FocusDock, feedback drawers,
 * message boxes, or toasts) is never covered: Echo rests cleanly above it.
 */
function boundsOf(side: EchoSide = 'right'): EchoBounds {
  const viewport = viewportOf();
  if (typeof document === 'undefined') {
    return computeSafeBounds(viewport, orbSize(), side);
  }
  const main = toRect(document.querySelector('[data-app-scroll]')?.getBoundingClientRect());
  const topBar = toRect(document.querySelector('[data-nav-surface="topbar"]')?.getBoundingClientRect());
  const dockEl = document.querySelector('[data-purpose="main-navigation-dock"]');
  let dock: EchoRect | null = null;
  if (dockEl && dockEl.getAttribute('aria-hidden') !== 'true') {
    const cls = typeof dockEl.className === 'string' ? dockEl.className : '';
    if (!cls.includes('Hidden')) {
      dock = toRect(dockEl.getBoundingClientRect());
    }
  }
  const clearRects: EchoRect[] = [];
  for (const el of document.querySelectorAll('[data-echo-clear]')) {
    const r = toRect(el.getBoundingClientRect());
    if (r) clearRects.push(r);
  }
  const guideOffer = document.querySelector<HTMLElement>('[data-testid="guide-offer"]');
  if (guideOffer && guideOffer.style.visibility !== 'hidden') {
    const gr = toRect(guideOffer.getBoundingClientRect());
    const anchorEl = document.querySelector<HTMLElement>('[data-echo-anchor]');
    const launcherEl = document.querySelector<HTMLElement>('.echo-launcher');
    const isAmbientAnchor =
      anchorEl?.getAttribute('data-anchor-mode') === 'ambient' ||
      !launcherEl ||
      launcherEl.getBoundingClientRect().width === 0;
    // In Ambient mode, GuideOffer docks at { right: 16, bottom: 16 } (because .echo-launcher is 0x0),
    // so lift the Ambient Entity + its upward radial orbit cleanly above GuideOffer (0 px^2 overlap).
    // In Whale mode, Whale keeps its resting bottom spot and GuideOffer places itself 12px above Whale.
    if (gr && isAmbientAnchor && gr.top > viewport.height * 0.35) {
      clearRects.push(gr);
    }
  }
  return computeSafeBounds(viewport, orbSize(), side, {
    main,
    topBarBottom: topBar ? topBar.bottom : 0,
    dock,
    clearRects,
  });
}

function orbSize() { return viewportOf().width < 640 ? 58 : 64; }

function isField(el: Element | null) {
  const node = el as HTMLElement | null;
  if (!node?.tagName) return false;
  return node.isContentEditable || node.tagName === 'TEXTAREA' || node.tagName === 'INPUT' || node.tagName === 'SELECT';
}

/**
 * The floating Echo: a real drag with the pointer, a spring to the nearest edge, a place that is remembered, and a small life of its own on a calm
 * timetable. One transform owner per layer: this hook writes the anchor's position and its lag; CSS writes only the float inside it. Nothing here runs at
 * rest: a spring frame exists only while the anchor is moving, and a single timer waits for the next small thing to do. No request, no AI, no canvas.
 */
export function useEchoCompanion(
  pathname: string,
  tab: string | null,
  vi: boolean,
  blocked: boolean,
  suspended = false,
) {
  const [ready, setReady] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [settled, setSettled] = useState<{ point: EchoPoint; size: number; side: EchoPlace['side'] } | null>(null);
  const [prefs, setPrefs] = useState<EchoPrefs>({ messages: true, quietUntil: 0, turn: 0 });
  const [nudge, setNudge] = useState<string | null>(null);
  const [spriteOn, setSpriteOn] = useState(false);
  const [beat, setBeat] = useState<string | undefined>(undefined);
  const living: TabLiving = resolvePageTitle(pathname, tab, 'vi').living;

  const root = useRef<HTMLButtonElement | null>(null);
  const anchor = useRef<HTMLDivElement | null>(null);
  const lag = useRef<HTMLSpanElement | null>(null);
  const sprite = useRef<HTMLImageElement | null>(null);
  const place = useRef<EchoPlace>(DEFAULT_PLACE);
  const placeRestored = useRef(false);
  const lastSettled = useRef<{ x: number; y: number; size: number; side: EchoPlace['side'] } | null>(null);
  const currentPose = useRef<number>(POSE.neutral);
  const spriteLoaded = useRef(false);
  const motion = useRef({ x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, lx: 0, ly: 0, spring: false });
  const frame = useRef<number | null>(null);
  const last = useRef(0);
  const gesture = useRef<{ id: number; startX: number; startY: number; dx: number; dy: number; moved: boolean; px: number; py: number; pt: number } | null>(null);
  const justDragged = useRef(false);
  const hovering = useRef(false);
  const prefsRef = useRef(prefs); prefsRef.current = prefs;
  const shown = useRef(0);
  const blockedRef = useRef(blocked); blockedRef.current = blocked;
  const draggingRef = useRef(false);

  const showPose = useCallback((index: number) => {
    currentPose.current = index;
    const el = sprite.current; if (!el) return;
    const { cols, rows } = ECHO_COMPANION_SPRITE;
    el.style.transform = `translate3d(${-(index % cols) * (100 / cols)}%, ${-Math.floor(index / cols) * (100 / rows)}%, 0)`;
  }, []);

  const paint = useCallback(() => {
    const m = motion.current;
    const hostEl = anchor.current ?? root.current;
    if (hostEl) hostEl.style.transform = `translate3d(${m.x.toFixed(2)}px, ${m.y.toFixed(2)}px, 0)`;
    if (lag.current) {
      const tilt = Math.max(-11, Math.min(11, m.lx * 0.5));
      lag.current.style.transform = `translate3d(${m.lx.toFixed(2)}px, ${m.ly.toFixed(2)}px, 0) rotate(${tilt.toFixed(2)}deg)`;
    }
  }, []);

  const savePlace = useCallback((next: EchoPlace) => {
    place.current = next;
    try { localStorage.setItem(ECHO_PLACE_KEY, JSON.stringify(next)); } catch { /* Storage denied: the place lasts for this visit. */ }
  }, []);

  const settle = useCallback(() => {
    const m = motion.current, size = orbSize(), side = place.current.side;
    const prev = lastSettled.current;
    if (
      prev &&
      Math.abs(prev.x - m.tx) < 0.5 &&
      Math.abs(prev.y - m.ty) < 0.5 &&
      prev.size === size &&
      prev.side === side
    ) {
      return;
    }
    lastSettled.current = { x: m.tx, y: m.ty, size, side };
    setSettled({ point: { x: m.tx, y: m.ty }, size, side });
  }, []);

  const step = useCallback((time: number) => {
    const m = motion.current;
    const dt = Math.min(1 / 30, (time - last.current) / 1000 || 1 / 60);
    last.current = time;
    let moving = false;
    if (m.spring) {
      // slightly under-damped: a soft arrival with one small overshoot
      const k = 210, c = 22;
      m.vx += (-k * (m.x - m.tx) - c * m.vx) * dt; m.vy += (-k * (m.y - m.ty) - c * m.vy) * dt;
      m.x += m.vx * dt; m.y += m.vy * dt;
      moving = Math.abs(m.x - m.tx) + Math.abs(m.y - m.ty) > 0.25 || Math.abs(m.vx) + Math.abs(m.vy) > 3;
      if (!moving) { m.x = m.tx; m.y = m.ty; m.vx = 0; m.vy = 0; m.spring = false; settle(); }
    }
    // the whale trails the glass a little and catches up
    const wantX = Math.max(-9, Math.min(9, -m.vx * 0.012)), wantY = Math.max(-7, Math.min(7, -m.vy * 0.010));
    const ease = 1 - Math.exp(-dt * 11);
    m.lx += (wantX - m.lx) * ease; m.ly += (wantY - m.ly) * ease;
    if (draggingRef.current) { m.vx *= 0.82; m.vy *= 0.82; }
    const lagging = Math.abs(m.lx) + Math.abs(m.ly) > 0.04;
    paint();
    if (moving || lagging || draggingRef.current) frame.current = requestAnimationFrame(step);
    else { m.lx = 0; m.ly = 0; paint(); frame.current = null; }
  }, [paint, settle]);

  const wake = useCallback(() => {
    if (frame.current === null) { last.current = performance.now(); frame.current = requestAnimationFrame(step); }
  }, [step]);

  const goTo = useCallback((next: EchoPlace, animate: boolean) => {
    const m = motion.current, target = pointOf(next, orbSize(), boundsOf(next.side));
    m.tx = target.x; m.ty = target.y;
    const still = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (animate && !still) { m.spring = true; wake(); }
    else { m.x = target.x; m.y = target.y; m.vx = 0; m.vy = 0; m.spring = false; paint(); settle(); }
  }, [paint, settle, wake]);

  const ensureInitialPlace = useCallback(() => {
    if (placeRestored.current) return;
    let saved: string | null = null;
    try { saved = localStorage.getItem(ECHO_PLACE_KEY); } catch { /* defaults */ }
    place.current = restorePlace(saved);
    placeRestored.current = true;
  }, []);

  /**
   * Synchronous callback refs guarantee that whenever the anchor or whale DOM attaches
   * (initial mount, returning from StudySpace/Arena/Odyssey/Sentinel, or mode handoff),
   * its exact transform and verified sprite frame are written BEFORE browser paint —
   * NEVER requiring a drag event to recover position or visibility.
   */
  const attachAnchor = useCallback((node: HTMLDivElement | null) => {
    anchor.current = node;
    if (!node || typeof window === 'undefined') return;
    ensureInitialPlace();
    const m = motion.current;
    if (!draggingRef.current && !m.spring) {
      const target = pointOf(place.current, orbSize(), boundsOf(place.current.side));
      m.x = target.x; m.y = target.y; m.tx = target.x; m.ty = target.y;
    }
    paint();
  }, [ensureInitialPlace, paint]);

  const attachRoot = useCallback((node: HTMLButtonElement | null) => {
    root.current = node;
    if (node) paint();
  }, [paint]);

  const attachLag = useCallback((node: HTMLSpanElement | null) => {
    lag.current = node;
    if (node) paint();
  }, [paint]);

  const attachSprite = useCallback((node: HTMLImageElement | null) => {
    sprite.current = node;
    if (!node) return;
    const expectedSrc = node.dataset.src ?? '';
    if (spriteLoaded.current && expectedSrc && !node.getAttribute('src')) {
      node.loading = 'eager';
      node.setAttribute('src', expectedSrc);
    }
    if (node.complete && node.naturalWidth > 0) {
      spriteLoaded.current = true;
      showPose(currentPose.current);
    } else if (spriteLoaded.current) {
      // Freshly created DOM image is still decoding its cached bytes: show crisp still whale until onload fires!
      setSpriteOn(false);
      node.onload = () => {
        spriteLoaded.current = true;
        showPose(currentPose.current);
        setSpriteOn(true);
      };
      node.onerror = () => {
        spriteLoaded.current = false;
        setSpriteOn(false);
      };
    }
  }, [showPose]);

  const syncPosition = useCallback(() => {
    if (typeof window === 'undefined') return;
    ensureInitialPlace();
    if (!draggingRef.current) {
      const target = pointOf(place.current, orbSize(), boundsOf(place.current.side));
      const m = motion.current;
      if (!m.spring) {
        m.x = target.x; m.y = target.y; m.tx = target.x; m.ty = target.y;
        settle();
      }
    }
    paint();
  }, [ensureInitialPlace, paint, settle]);

  /**
   * Immediate atomic mascot restoration invoked when JARVIS hands visual ownership back
   * to the original Echo Whale: recomputes live bounds, applies exact transform, resets lag/pose,
   * and verifies sprite readiness without simulating any drag or pointer event.
   */
  const restoreMascot = useCallback(() => {
    if (typeof window === 'undefined') return;
    ensureInitialPlace();
    gesture.current = null;
    justDragged.current = false;
    if (draggingRef.current) {
      draggingRef.current = false;
      setDragging(false);
    }
    const m = motion.current;
    m.vx = 0; m.vy = 0; m.lx = 0; m.ly = 0; m.spring = false;
    const target = pointOf(place.current, orbSize(), boundsOf(place.current.side));
    m.x = target.x; m.y = target.y; m.tx = target.x; m.ty = target.y;
    paint();
    settle();
    setReady(true);

    const img = sprite.current;
    currentPose.current = POSE.neutral;
    if (img && img.complete && img.naturalWidth > 0 && Boolean(img.getAttribute('src'))) {
      spriteLoaded.current = true;
      showPose(POSE.neutral);
      setSpriteOn(true);
    } else {
      setSpriteOn(false);
      if (img && spriteLoaded.current && img.dataset.src) {
        img.loading = 'eager';
        img.onload = () => {
          spriteLoaded.current = true;
          showPose(POSE.neutral);
          setSpriteOn(true);
        };
        img.onerror = () => {
          spriteLoaded.current = false;
          setSpriteOn(false);
        };
        img.setAttribute('src', img.dataset.src);
      }
    }
  }, [ensureInitialPlace, paint, settle, showPose]);

  const onSpriteLoad = useCallback(() => {
    const img = sprite.current;
    if (img && img.naturalWidth > 0) {
      spriteLoaded.current = true;
      showPose(currentPose.current);
      setSpriteOn(true);
    }
  }, [showPose]);

  const onSpriteError = useCallback(() => {
    spriteLoaded.current = false;
    setSpriteOn(false);
  }, []);

  // ---- first placement, and the screen changing under it
  useEffect(() => {
    let saved: string | null = null, savedPrefs: string | null = null;
    try { saved = localStorage.getItem(ECHO_PLACE_KEY); savedPrefs = localStorage.getItem(ECHO_PREFS_KEY); } catch { /* defaults */ }
    place.current = restorePlace(saved);
    placeRestored.current = true;
    setPrefs(restorePrefs(savedPrefs));
    goTo(place.current, false);
    setReady(true);
    const refit = () => { if (!draggingRef.current) goTo(place.current, false); };
    window.addEventListener('resize', refit);
    // A page's bottom controls came or went (a conversation or drawer opened): Echo moves out of their way, smoothly.
    const clear = () => { if (!draggingRef.current) goTo(place.current, true); };
    window.addEventListener('echo:clear-changed', clear);
    window.visualViewport?.addEventListener('resize', refit);
    // Watch for first-visit guide-offer mounting/unmounting AND its async style placement ({ right: 16, bottom: 16 })
    // so Echo floats cleanly above it with 0 px^2 overlap even when GuideOffer settles 1-2 frames after mount.
    let guideOfferEl: HTMLElement | null = document.querySelector<HTMLElement>('[data-testid="guide-offer"]');
    let guideOfferStyleObs: MutationObserver | null = null;
    let guideRaf1 = 0;
    let guideRaf2 = 0;
    const scheduleGuideRefit = () => {
      if (guideRaf1) cancelAnimationFrame(guideRaf1);
      if (guideRaf2) cancelAnimationFrame(guideRaf2);
      guideRaf1 = requestAnimationFrame(() => {
        guideRaf1 = 0;
        if (!draggingRef.current) goTo(place.current, false);
        guideRaf2 = requestAnimationFrame(() => {
          guideRaf2 = 0;
          if (!draggingRef.current) goTo(place.current, false);
        });
      });
    };
    const watchGuideOfferStyle = (el: HTMLElement | null) => {
      guideOfferStyleObs?.disconnect();
      guideOfferStyleObs = null;
      if (!el || typeof MutationObserver === 'undefined') return;
      guideOfferStyleObs = new MutationObserver(() => {
        scheduleGuideRefit();
      });
      guideOfferStyleObs.observe(el, { attributes: true, attributeFilter: ['style'] });
    };
    if (guideOfferEl) {
      watchGuideOfferStyle(guideOfferEl);
      scheduleGuideRefit();
    }
    let guideObserver: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined' && document.body) {
      guideObserver = new MutationObserver(() => {
        const nextEl = document.querySelector<HTMLElement>('[data-testid="guide-offer"]');
        if (nextEl !== guideOfferEl) {
          guideOfferEl = nextEl;
          watchGuideOfferStyle(nextEl);
          scheduleGuideRefit();
        }
      });
      guideObserver.observe(document.body, { childList: true, subtree: true });
    }
    return () => {
      window.removeEventListener('resize', refit);
      window.removeEventListener('echo:clear-changed', clear);
      window.visualViewport?.removeEventListener('resize', refit);
      guideObserver?.disconnect();
      guideOfferStyleObs?.disconnect();
      if (guideRaf1) cancelAnimationFrame(guideRaf1);
      if (guideRaf2) cancelAnimationFrame(guideRaf2);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [goTo]);
  // the content column moves when a route/tab brings or removes the shell, when suspended routes exit, and when the sidebar folds
  useEffect(() => {
    if (suspended) return;
    const main = document.querySelector?.('[data-app-scroll]');
    if (!draggingRef.current) goTo(place.current, false);
    if (!main || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (!draggingRef.current) goTo(place.current, false); });
    observer.observe(main);
    return () => observer.disconnect();
  }, [pathname, tab, suspended, goTo]);

  // ---- the drag (works identically on Whale button and Ambient Living Entity)
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    justDragged.current = false;
    const m = motion.current;
    gesture.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, dx: event.clientX - m.x, dy: event.clientY - m.y, moved: false, px: event.clientX, py: event.clientY, pt: event.timeStamp };
    m.spring = false;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Capture is a convenience. */ }
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    if (!g.moved) {
      if (Math.hypot(event.clientX - g.startX, event.clientY - g.startY) < DRAG_START_PX) return;
      g.moved = true; draggingRef.current = true; setDragging(true); setNudge(null);
      if (spriteOn) showPose(POSE.happy);
    }
    const m = motion.current, size = orbSize();
    const dt = Math.max(1, event.timeStamp - g.pt) / 1000;
    m.vx = m.vx * 0.5 + ((event.clientX - g.px) / dt) * 0.5; m.vy = m.vy * 0.5 + ((event.clientY - g.py) / dt) * 0.5;
    g.px = event.clientX; g.py = event.clientY; g.pt = event.timeStamp;
    const next = clampPoint({ x: event.clientX - g.dx, y: event.clientY - g.dy }, size, viewportOf());
    m.x = next.x; m.y = next.y;
    wake();
  };
  const finish = (event: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    gesture.current = null;
    if (!g.moved) return;
    justDragged.current = true;
    draggingRef.current = false;
    setDragging(false);
    const m = motion.current;
    m.vx = Math.max(-1800, Math.min(1800, m.vx)); m.vy = Math.max(-1800, Math.min(1800, m.vy));
    const next = placeOf({ x: m.x, y: m.y }, m.vx, orbSize(), boundsOf(place.current.side));
    savePlace(next);
    goTo(next, true);
    if (spriteOn) showPose(POSE.neutral);
  };
  /** A click after a drag is the drag's end, not a request to open. A keyboard click (detail 0) always counts. */
  const consumeDragClick = (event?: ReactMouseEvent) => {
    if (justDragged.current && event?.detail !== 0) { justDragged.current = false; return true; }
    justDragged.current = false;
    return false;
  };

  const onPointerEnter = (event: ReactPointerEvent) => { if (event.pointerType === 'mouse') { hovering.current = true; if (spriteOn && !draggingRef.current && living !== 'still') showPose(POSE.happy); } };
  const onPointerLeave = (event: ReactPointerEvent) => { if (event.pointerType === 'mouse') { hovering.current = false; if (spriteOn && !draggingRef.current) showPose(POSE.neutral); } };

  // ---- a small life on a calm timetable. One timer; nothing at all on a still screen, in a hidden tab, while typing or with reduced motion.
  useEffect(() => {
    if (!ready || suspended || living === 'still' || blocked) return;
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (media?.matches) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    const focusing = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--wp-quiet')) >= 0.85;
    const asleep = () => document.hidden || draggingRef.current || blockedRef.current || hovering.current || isField(document.activeElement) || focusing();
    const play = (frames: readonly number[], ms: number, done: () => void, at = 0) => {
      if (!alive) return;
      if (at >= frames.length) { showPose(POSE.neutral); done(); return; }
      showPose(frames[at]);
      timer = setTimeout(() => play(frames, ms, done, at + 1), ms);
    };
    const rich = living === 'rich';
    const nextAct = () => {
      if (!alive) return;
      const roll = Math.random();
      // mostly blinks; the tail and the spout are occasions
      const wait = 2600 + Math.random() * (rich ? 5200 : 8200);
      timer = setTimeout(() => {
        if (asleep()) { nextAct(); return; }
        if (rich && roll < 0.05) { setBeat('bubbles'); setTimeout(() => { if (alive) setBeat(undefined); }, 2600); play(CLIP.spray.frames, CLIP.spray.ms, nextAct); }
        else if (roll < (rich ? 0.2 : 0.08)) play(CLIP.tail.frames, CLIP.tail.ms, nextAct);
        else if (rich && roll < 0.27) { setBeat('bubbles'); setTimeout(() => { if (alive) setBeat(undefined); }, 2600); nextAct(); }
        else play(CLIP.blink.frames, CLIP.blink.ms, nextAct);
      }, wait);
    };
    // the sheet of poses loads once, in idle time, only where Echo moves at all
    const begin = () => {
      if (!alive) return;
      spriteLoaded.current = true;
      showPose(currentPose.current);
      setSpriteOn(true);
      nextAct();
    };
    const load = () => {
      if (!alive) return;
      const image = sprite.current;
      if (!image) return;
      if (image.complete && image.naturalWidth > 0 && Boolean(image.getAttribute('src'))) { begin(); return; }
      image.onload = begin;
      image.onerror = () => { spriteLoaded.current = false; if (alive) setSpriteOn(false); };
      image.loading = 'eager';
      image.setAttribute('src', image.dataset.src ?? '');
    };
    if (spriteLoaded.current && sprite.current?.complete && (sprite.current?.naturalWidth ?? 0) > 0) {
      begin();
    } else {
      timer = setTimeout(load, 2200);
    }
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [ready, suspended, living, blocked, showPose]);

  // ---- rare words, on hubs only
  useEffect(() => {
    if (!ready || suspended || living !== 'rich' || blocked || !prefs.messages) return;
    let timer: ReturnType<typeof setTimeout> | null = null, hide: ReturnType<typeof setTimeout> | null = null;
    const attempt = () => {
      const quiet = document.hidden || draggingRef.current || blockedRef.current || isField(document.activeElement);
      const current = prefsRef.current;
      if (!quiet && current.messages && Date.now() >= current.quietUntil && shown.current < NUDGE_MAX_PER_VISIT) {
        shown.current += 1;
        const turn = current.turn + 1;
        setPrefs(saved => {
          const next = { ...saved, turn };
          try { localStorage.setItem(ECHO_PREFS_KEY, JSON.stringify(next)); } catch { /* This visit only. */ }
          return next;
        });
        setNudge(nudgeLine(pathname, vi, turn));
        hide = setTimeout(() => setNudge(null), NUDGE_DWELL_MS);
      }
      timer = setTimeout(attempt, NUDGE_EVERY_MS * (0.8 + Math.random() * 0.5));
    };
    timer = setTimeout(attempt, NUDGE_FIRST_MS * (0.8 + Math.random() * 0.5));
    return () => { if (timer) clearTimeout(timer); if (hide) clearTimeout(hide); };
  }, [ready, suspended, living, blocked, prefs.messages, pathname, vi]);

  const writePrefs = useCallback((patch: Partial<EchoPrefs>) => {
    setPrefs(saved => {
      const next = { ...saved, ...patch };
      try { localStorage.setItem(ECHO_PREFS_KEY, JSON.stringify(next)); } catch { /* This visit only. */ }
      return next;
    });
  }, []);

  return {
    ready, dragging, settled, nudge, living, beat, spriteOn, prefs,
    refs: { root, anchor, lag, sprite },
    attach: { anchor: attachAnchor, root: attachRoot, lag: attachLag, sprite: attachSprite },
    pointer: { onPointerDown, onPointerMove, onPointerUp: finish, onPointerCancel: finish, onPointerEnter, onPointerLeave },
    syncPosition,
    restoreMascot,
    onSpriteLoad,
    onSpriteError,
    consumeDragClick,
    dismissNudge: () => { setNudge(null); writePrefs({ quietUntil: Date.now() + NUDGE_DISMISS_MS }); },
    setMessages: (messages: boolean) => { setNudge(null); writePrefs({ messages }); },
    resetPlace: () => { savePlace(DEFAULT_PLACE); goTo(DEFAULT_PLACE, true); },
    switchSide: () => { const next: EchoPlace = { ...place.current, side: place.current.side === 'left' ? 'right' : 'left' }; savePlace(next); goTo(next, true); },
  };
}
