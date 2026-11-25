import type { NavigationLayout } from './preferences';

export interface MorphBox {
  x: number;
  y: number;
  w: number;
  h: number;
  rx?: number;
}

export interface InFlightState {
  surface: MorphBox;
  surfaceVelocity: { x: number; y: number; w: number; h: number; rx: number };
  icons: Map<string, { box: MorphBox; vx: number; vy: number; vw: number; vh: number; opacity: number }>;
}

export interface NavMorphSnapshot {
  seq: number;
  from: NavigationLayout;
  to: NavigationLayout;
  startedAt: number;
  surface: MorphBox | null;
  surfaceVelocity?: { x: number; y: number; w: number; h: number; rx: number };
  icons: Map<string, MorphBox>;
  iconVelocities?: Map<string, { vx: number; vy: number; vw: number; vh: number }>;
  libraryAnchor: MorphBox | null;
  focusedNavId: string | null;
}

type MorphListener = () => void;

let seqCounter = 0;
let activeSnapshot: NavMorphSnapshot | null = null;
let liveFlightReader: (() => InFlightState | null) | null = null;
let holdRevealUntil = 0;
const morphListeners = new Set<MorphListener>();

function emitMorph(): void {
  morphListeners.forEach((fn) => fn());
}

export function subscribeNavMorph(listener: MorphListener): () => void {
  morphListeners.add(listener);
  return () => {
    morphListeners.delete(listener);
  };
}

export function getActiveNavMorph(): NavMorphSnapshot | null {
  return activeSnapshot;
}

export function isNavRevealHeld(): boolean {
  return typeof performance !== 'undefined' && performance.now() < holdRevealUntil;
}

export function registerLiveFlightReader(reader: (() => InFlightState | null) | null): void {
  liveFlightReader = reader;
}

function measureRect(el: Element | null): MorphBox | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 1 || r.height <= 1) return null;
  let rx = 24;
  if (typeof window !== 'undefined') {
    const br = parseFloat(window.getComputedStyle(el).borderTopLeftRadius || '24');
    if (Number.isFinite(br)) rx = br;
  }
  return { x: r.left, y: r.top, w: r.width, h: r.height, rx };
}

export function measureNavigationSurface(kind: NavigationLayout): {
  surface: MorphBox | null;
  icons: Map<string, MorphBox>;
  libraryAnchor: MorphBox | null;
} {
  const icons = new Map<string, MorphBox>();
  if (typeof document === 'undefined') {
    return { surface: null, icons, libraryAnchor: null };
  }
  const host = document.querySelector<HTMLElement>(`[data-nav-surface="${kind}"]`);
  const surface = measureRect(host);
  if (host) {
    const nodes = host.querySelectorAll<HTMLElement>('[data-nav-morph-id]');
    nodes.forEach((node) => {
      const id = node.getAttribute('data-nav-morph-id');
      const box = measureRect(node);
      if (id && box) icons.set(id, box);
    });
  }
  const libraryEl = host?.querySelector<HTMLElement>('[data-nav-library-anchor]') ?? null;
  const libraryAnchor = measureRect(libraryEl);
  return { surface, icons, libraryAnchor };
}

/**
 * Captures the exact FIRST geometry before React commits the layout switch.
 * If a previous morph is still in flight, captures its live interpolated positions and velocities
 * so rapid repeated Sidebar <-> Dock toggles reverse mid-air with zero jump or ghosting.
 */
export function captureNavMorphBeforeSwitch(from: NavigationLayout, to: NavigationLayout): (() => void) | void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    // Reduced motion: skip spatial flight; destination appears cleanly without complex motion.
    activeSnapshot = null;
    holdRevealUntil = performance.now() + 300;
    return () => emitMorph();
  }

  let focusedNavId: string | null = null;
  const activeEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (activeEl) {
    const item = activeEl.closest<HTMLElement>('[data-nav-item-id]');
    if (item) focusedNavId = item.getAttribute('data-nav-item-id');
  }

  const inFlight = liveFlightReader?.() ?? null;
  if (inFlight && activeSnapshot) {
    const icons = new Map<string, MorphBox>();
    const iconVelocities = new Map<string, { vx: number; vy: number; vw: number; vh: number }>();
    inFlight.icons.forEach((entry, id) => {
      icons.set(id, entry.box);
      iconVelocities.set(id, { vx: entry.vx, vy: entry.vy, vw: entry.vw, vh: entry.vh });
    });
    activeSnapshot = {
      seq: ++seqCounter,
      from,
      to,
      startedAt: performance.now(),
      surface: inFlight.surface,
      surfaceVelocity: inFlight.surfaceVelocity,
      icons,
      iconVelocities,
      libraryAnchor: measureNavigationSurface(from).libraryAnchor,
      focusedNavId,
    };
  } else {
    const measured = measureNavigationSurface(from);
    // Fallback synthetic geometry when switching while the source bar was auto-hidden off-screen.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const fallbackSurface: MorphBox =
      from === 'sidebar'
        ? { x: 6, y: 8, w: 252, h: Math.max(320, vh - 16), rx: 25.6 }
        : { x: Math.max(16, (vw - 680) / 2), y: vh - 76, w: Math.min(680, vw - 32), h: 62, rx: 26 };

    activeSnapshot = {
      seq: ++seqCounter,
      from,
      to,
      startedAt: performance.now(),
      surface: measured.surface ?? fallbackSurface,
      icons: measured.icons,
      libraryAnchor: measured.libraryAnchor,
      focusedNavId,
    };
  }

  // Keep auto-hidden destination visible during the morph + brief settle so the user sees where it landed.
  holdRevealUntil = performance.now() + 1350;
  document.documentElement.setAttribute('data-nav-morph-active', to);
  return () => emitMorph();
}

export function completeNavMorph(seq: number): void {
  if (!activeSnapshot || activeSnapshot.seq !== seq) return;
  const focusId = activeSnapshot.focusedNavId;
  const targetSurface = activeSnapshot.to;
  activeSnapshot = null;
  if (typeof document !== 'undefined') {
    document.documentElement.removeAttribute('data-nav-morph-active');
    if (focusId) {
      const targetEl = document.querySelector<HTMLElement>(
        `[data-nav-surface="${targetSurface}"] [data-nav-item-id="${focusId}"]`,
      );
      targetEl?.focus({ preventScroll: true });
    }
  }
  emitMorph();
}
