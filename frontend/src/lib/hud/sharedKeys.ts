'use client';

import { useEffect, useRef, useState } from 'react';
import { defaultKeymap, keyLabel, loadKeymap } from '@/lib/study-space/keymap';

/**
 * The keys every 3D place shares, read from the study room's one keymap (the player's own choices included): switch the camera, bring the bars back, open
 * settings, show the controls, take or release mouse-look. A place passes the keys its own game already uses; a shared key that the player moved onto one of
 * them falls back to its default there, so a race key or an answer key is never taken. Nothing fires while a field, a select or a modal dialog has the keyboard.
 */
export type SharedAction = 'camera' | 'hud' | 'settings' | 'help' | 'mouse' | 'actions';
export const SHARED_ACTIONS: SharedAction[] = ['camera', 'hud', 'settings', 'help', 'mouse', 'actions'];

export function sharedKeymap(taken: ReadonlySet<string>): Record<SharedAction, string> {
  const mine = loadKeymap(), base = defaultKeymap();
  const out = {} as Record<SharedAction, string>;
  for (const id of SHARED_ACTIONS) out[id] = taken.has(mine[id]) ? base[id] : mine[id];
  return out;
}

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

export function useSharedKeys(handlers: Partial<Record<SharedAction, () => void>>, options: { taken: readonly string[]; enabled?: boolean }) {
  const enabled = options.enabled !== false;
  const latest = useRef(handlers); latest.current = handlers;
  const takenKey = options.taken.join(',');
  const [labels, setLabels] = useState<Record<SharedAction, string>>(() => Object.fromEntries(SHARED_ACTIONS.map(a => [a, keyLabel(defaultKeymap()[a])])) as Record<SharedAction, string>);
  useEffect(() => {
    if (!enabled) return;
    const taken = new Set(takenKey.split(',').filter(Boolean));
    let map = sharedKeymap(taken);
    const publish = () => setLabels(Object.fromEntries(SHARED_ACTIONS.map(a => [a, keyLabel(map[a])])) as Record<SharedAction, string>);
    publish();
    const reload = () => { map = sharedKeymap(taken); publish(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.defaultPrevented || typing(e.target)) return;
      if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
      const action = SHARED_ACTIONS.find(a => map[a] === e.code);
      const run = action ? latest.current[action] : undefined;
      if (!run) return;
      e.preventDefault();
      run();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('study:keys-changed', reload);
    window.addEventListener('storage', reload);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('study:keys-changed', reload); window.removeEventListener('storage', reload); };
  }, [enabled, takenKey]);
  return labels;
}
