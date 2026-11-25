'use client';

/**
 * When did the viewer last touch this page (pointer, key, wheel, touch)? One passive listener set for the whole app,
 * registered on first use, never preventing anything. Used to slow polling of a page left open untouched (performance
 * release 2026-11-16, PERF-22): someone who is looking keeps the live cadence.
 */
let lastActivity = 0;
let installed = false;

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  lastActivity = Date.now();
  const mark = () => { lastActivity = Date.now(); };
  const opts: AddEventListenerOptions = { passive: true, capture: true };
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus'] as const) {
    window.addEventListener(type, mark, opts);
  }
}

/** True while the viewer interacted within the last `withinMs` (true on the server and before the first check). */
export function viewerRecentlyActive(withinMs: number): boolean {
  if (typeof window === 'undefined') return true;
  install();
  return Date.now() - lastActivity < withinMs;
}
