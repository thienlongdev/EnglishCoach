'use client';
/* How an immersive world (Echo Odyssey, Vũ trụ tri thức) is presented inside the application:
   'immersive' — the world fills the application viewport, the sidebar and top bar are not rendered (the default);
   'embedded'  — the world sits in the ordinary workspace content area, beside the sidebar and under the top bar.
   This is the application's own layout, never the browser Fullscreen API. A per-browser preference, one value per
   world; the page is never reloaded and the world's canvas is never remounted by a switch (ApplicationFrame keeps the
   same element tree in both modes). */
import { useSyncExternalStore } from 'react';

export type WorldKey = 'odyssey' | 'cosmos';
export type WorldDisplay = 'immersive' | 'embedded';
const KEY = 'ec_world_display:v1';
const listeners = new Set<() => void>();
let cache: Partial<Record<WorldKey, WorldDisplay>> | null = null;

function read(): Partial<Record<WorldKey, WorldDisplay>> {
  if (cache) return cache;
  cache = {};
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    for (const k of ['odyssey', 'cosmos'] as const) if (raw && raw[k] === 'embedded') cache[k] = 'embedded';
  } catch { /* storage unavailable: the default applies */ }
  return cache;
}
export function getWorldDisplay(key: WorldKey): WorldDisplay { return read()[key] === 'embedded' ? 'embedded' : 'immersive'; }
export function setWorldDisplay(key: WorldKey, mode: WorldDisplay) {
  cache = { ...read(), [key]: mode };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* kept for this visit only */ }
  listeners.forEach(l => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) { cache = null; l(); } };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(l); window.removeEventListener('storage', onStorage); };
};
const serverMode = (): WorldDisplay => 'immersive';
/** The current mode and a toggle. The server and the first client render say 'immersive' (the default). */
export function useWorldDisplay(key: WorldKey): [WorldDisplay, (mode?: WorldDisplay) => void] {
  const mode = useSyncExternalStore(subscribe, () => getWorldDisplay(key), serverMode);
  return [mode, next => setWorldDisplay(key, next ?? (mode === 'immersive' ? 'embedded' : 'immersive'))];
}
