import { ECHO_FAVICON_CLIPS, ECHO_FAVICON_SPRITE, ECHO_ICON } from './echoArt';

/**
 * The favicon is a tiny living ocean: the owner's whale bobs on small waves with a bubble rising, now and then blows its spout, and rests between (owner brief
 * 2026-10-31, 10 §BJ). A browser tab's own frame cannot be drawn on; the favicon is the one real picture a page has there.
 *
 * Pictures are pre-rendered (docs/brand/echo-living-identity-2026-10-31/art): one sprite sheet, decoded once, cut once into small data URLs, then only a
 * link's href changes, a few times a second during a clip and not at all in between. No canvas work per frame, no object URL to leak, no request.
 * A hidden tab, reduced motion or a screen where someone concentrates: the static icon, no timer at all.
 */
const SPOUT_MS = 165;
const RIPPLE_MS = 230;
const REST_MIN = 2200;
const REST_SPREAD = 4200;
const FIRST_DELAY = 2600;

let frames: string[] | null = null;
let loading: Promise<string[] | null> | null = null;

function loadFrames(): Promise<string[] | null> {
  if (frames) return Promise.resolve(frames);
  if (loading) return loading;
  loading = new Promise(resolve => {
    const image = new Image();
    image.decoding = 'async';
    image.onerror = () => { loading = null; resolve(null); };
    image.onload = () => {
      const { cols, cell, frames: count } = ECHO_FAVICON_SPRITE;
      const canvas = document.createElement('canvas');
      canvas.width = cell;
      canvas.height = cell;
      const context = canvas.getContext('2d');
      if (!context) { loading = null; resolve(null); return; }
      const cut: string[] = [];
      // The frames are encoded a few at a time in idle moments, never in one long task that could delay a tap or a key
      // during a cold visit (performance release 2026-11-16, PERF-31). Same frames, same order.
      const SLICE = 6;
      const idle = (fn: () => void) => {
        const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
        if (ric) ric(fn, { timeout: 500 }); else setTimeout(fn, 16);
      };
      let i = 0;
      const step = () => {
        for (const end = Math.min(count, i + SLICE); i < end; i++) {
          context.clearRect(0, 0, cell, cell);
          context.drawImage(image, (i % cols) * cell, Math.floor(i / cols) * cell, cell, cell, 0, 0, cell, cell);
          cut.push(canvas.toDataURL('image/png'));
        }
        if (i < count) { idle(step); return; }
        frames = cut;
        resolve(cut);
      };
      step();
    };
    image.src = ECHO_ICON.sprite;
  });
  return loading;
}

function setIcon(href: string) {
  document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]').forEach(link => {
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
  });
}

/** Runs the favicon for as long as the returned stop function is not called. */
export function runLivingFavicon(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let alive = true;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const allowed = () => alive && !document.hidden && !motion.matches;
  const rest = () => setIcon(ECHO_ICON.ico);

  // Mostly the small waves, every third or fourth time the spout: the same rhythm never twice in a row.
  let sinceSpout = 0;
  const play = (from: number, to: number, ms: number) => {
    if (!allowed() || !frames) { rest(); return; }
    if (from >= to) {
      rest();
      timer = setTimeout(next, REST_MIN + Math.random() * REST_SPREAD);
      return;
    }
    setIcon(frames[from]);
    timer = setTimeout(() => play(from + 1, to, ms), ms);
  };
  const next = () => {
    if (!allowed()) { rest(); return; }
    sinceSpout += 1;
    const [spoutFrom, spoutTo] = ECHO_FAVICON_CLIPS.spout;
    const [rippleFrom, rippleTo] = ECHO_FAVICON_CLIPS.ripple;
    if (sinceSpout >= 3 + Math.floor(Math.random() * 2)) { sinceSpout = 0; play(spoutFrom, spoutTo, SPOUT_MS); }
    else play(rippleFrom, rippleTo, RIPPLE_MS);
  };

  const begin = (delay: number) => {
    clear();
    if (!allowed()) { rest(); return; }
    timer = setTimeout(() => {
      void loadFrames().then(list => { if (list && allowed()) next(); });
    }, delay);
  };
  const changed = () => { clear(); if (allowed()) begin(1400); else rest(); };

  document.addEventListener('visibilitychange', changed);
  motion.addEventListener('change', changed);
  begin(FIRST_DELAY);
  return () => {
    alive = false;
    clear();
    document.removeEventListener('visibilitychange', changed);
    motion.removeEventListener('change', changed);
    rest();
  };
}
