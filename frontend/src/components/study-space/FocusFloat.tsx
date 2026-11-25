'use client';

import React, { useRef, useState } from 'react';
import { Maximize2, Minus, PanelTopOpen, Timer, X } from 'lucide-react';
import { useMorphPresence } from '@/components/morph/useMorphPresence';
import { clockText, elapsedMs, phaseLabel, remainingMs } from '@/lib/study-space/focus';
import { FocusFace } from './FocusControls';
import { useFocus } from './data';
import { openPortableTimer } from './portable';
import { useNow } from './useNow';
import s from './studySpace.module.css';

const PLACE_KEY = 'ec_focus_float:v1';
const readPlace = (): { x: number; y: number } | null => {
  try {
    const raw = JSON.parse(localStorage.getItem(PLACE_KEY) || 'null');
    return Number.isFinite(raw?.x) && Number.isFinite(raw?.y) ? raw : null;
  } catch { return null; }
};

/**
 * The focus timer floating over the room: it never owns the camera, the body or the page. Closing it hides only the
 * view (the timer is the account's FocusEngine and goes on), so it opens again exactly where the session is.
 * Its motion is the shared Echo Morph surface spring on this one element; the room underneath is not touched.
 */
export default function FocusFloat({ open, onClose, onExpand }: { open: boolean; onClose: () => void; onExpand: () => void }) {
  const { state, engine } = useFocus();
  const [folded, setFolded] = useState(false);
  const [place, setPlace] = useState(readPlace);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const presence = useMorphPresence(open, ref, { onDismiss: onClose });
  if (!presence.present) return null;
  const clamp = (x: number, y: number) => {
    const r = ref.current?.getBoundingClientRect();
    return { x: Math.max(8, Math.min(window.innerWidth - (r?.width ?? 280) - 8, x)), y: Math.max(8, Math.min(window.innerHeight - (r?.height ?? 80) - 8, y)) };
  };
  const down = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button') || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d?.id === e.pointerId) setPlace(clamp(d.left + e.clientX - d.x, d.top + e.clientY - d.y));
  };
  const up = (e: React.PointerEvent) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    if (place) try { localStorage.setItem(PLACE_KEY, JSON.stringify(place)); } catch { /* A remembered place is a convenience. */ }
  };
  // On a phone the movement pad owns the lower corner.
  const style: React.CSSProperties = place ? { left: place.x, top: place.y } : window.innerWidth < 760 ? { right: 12, top: 72 } : { right: 20, bottom: 96 };
  return (
    <div ref={ref} className={`${s.focusFloat} ${s.glass}`} style={style} role="region" aria-label="Đồng hồ tập trung" data-testid="focus-float" data-folded={folded} {...presence.panelProps}>
      <div className={s.focusFloatHead} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <Timer size={15} aria-hidden="true" />
        {folded ? <FoldedTime /> : <span className={s.focusFloatTitle}>Đồng hồ tập trung</span>}
        <span style={{ flex: 1 }} />
        <button type="button" className={s.focusFloatBtn} onClick={() => void openPortableTimer()} aria-label="Mở thành cửa sổ nổi riêng" title="Cửa sổ nổi riêng"><PanelTopOpen size={14} /></button>
        <button type="button" className={s.focusFloatBtn} onClick={onExpand} aria-label="Mở đầy đủ cài đặt" title="Cài đặt đầy đủ" data-testid="focus-float-expand"><Maximize2 size={14} /></button>
        <button type="button" className={s.focusFloatBtn} onClick={() => setFolded(!folded)} aria-label={folded ? 'Mở rộng' : 'Thu nhỏ'} aria-expanded={!folded} title={folded ? 'Mở rộng' : 'Thu nhỏ'} data-testid="focus-float-fold"><Minus size={14} /></button>
        <button type="button" className={s.focusFloatBtn} onClick={onClose} aria-label="Đóng đồng hồ (phiên vẫn chạy)" title="Đóng (phiên vẫn chạy)" data-testid="focus-float-close"><X size={14} /></button>
      </div>
      {!folded && <div className={s.focusFloatBody}><FocusFace state={state} engine={engine} size={176} compact /></div>}
    </div>
  );
}

function FoldedTime() {
  const { state } = useFocus();
  const now = useNow(state.status === 'running' ? 500 : 2000);
  const shown = state.mode === 'STOPWATCH' ? elapsedMs(state, now) : state.status === 'idle' ? state.durationMs : remainingMs(state, now);
  return <span className={s.focusFloatTime}>{clockText(shown)}<small>{phaseLabel(state)}</small></span>;
}
