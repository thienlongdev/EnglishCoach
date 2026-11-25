'use client';

import { useSyncExternalStore } from 'react';
import type { RushView } from './sky/skyWorld';

/**
 * Behind the runner or through their eyes: the player's own choice, kept for this browser, shared by the scene, the HUD button and the camera key. It only
 * moves the camera: speed, jumps, collisions, scoring and what other racers see are the same in both.
 */
/** Every key the race itself uses: the shared camera and mouse-look keys never take one of them. */
export const RUSH_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'KeyF', 'KeyE', 'KeyZ', 'KeyX', 'KeyC', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Escape'];
const STORAGE = 'echo-quiz-rush:view-v1';
let view: RushView = 'third', loaded = false;
const listeners = new Set<() => void>();
const load = () => { if (loaded || typeof window === 'undefined') return; loaded = true; try { if (localStorage.getItem(STORAGE) === 'first') view = 'first'; } catch { /* behind the runner */ } };

export const rushView = {
  get(): RushView { load(); return view; },
  set(next: RushView) {
    load();
    if (next === view) return;
    view = next;
    try { localStorage.setItem(STORAGE, next); } catch { /* this visit only */ }
    listeners.forEach(f => f());
  },
  toggle() { rushView.set(rushView.get() === 'first' ? 'third' : 'first'); },
  subscribe(f: () => void) { listeners.add(f); return () => { listeners.delete(f); }; },
};

export function useRushView(): RushView {
  return useSyncExternalStore(rushView.subscribe, rushView.get, () => 'third');
}
