'use client';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import hud from './cinematicHud.module.css';

/** The short "how to explore" note of an immersive world (lib/ui/cinematicHud.ts useWorldHint): a few gestures, a close button. */
export function WorldHint({ items, onClose, label, closeLabel }: { items: { key?: string; text: ReactNode }[]; onClose: () => void; label: string; closeLabel: string }) {
  return <div className={hud.hint} role="note" aria-label={label} data-testid="world-hint">
    <ul>{items.map((it, i) => <li key={i}>{it.key && <kbd>{it.key}</kbd>}<span>{it.text}</span></li>)}</ul>
    <button type="button" onClick={onClose} aria-label={closeLabel}><X size={15} /></button>
  </div>;
}
