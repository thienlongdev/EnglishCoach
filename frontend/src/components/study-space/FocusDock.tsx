'use client';

import React, { useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronUp, House, PanelTopOpen, X } from 'lucide-react';
import { clockText, remainingMs, elapsedMs, phaseLabel } from '@/lib/study-space/focus';
import { FocusFace } from './FocusControls';
import { useFocus } from './data';
import { openPortableTimer } from './portable';
import { useNow } from './useNow';
import { pointerLight } from '@/lib/ui/pointerLight';
import s from './studySpace.module.css';

/** The floating focus timer on every other page while a session runs: draggable, foldable, same session. */
export default function FocusDock() {
  const { state, engine } = useFocus();
  const now = useNow(500);
  const [open, setOpen] = useState(false);
  // Hidden for this phase of this session only: the timer goes on, and the next phase comes back to say so.
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);
  const phaseKey = `${state.sessionId}|${state.phase}|${state.cycle}`;
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ sx: number; sy: number; x: number; y: number } | null>(null);
  const shown = state.mode === 'STOPWATCH' ? elapsedMs(state, now) : state.status === 'idle' ? state.durationMs : remainingMs(state, now);
  const style: React.CSSProperties = {
    right: pos ? undefined : 20,
    bottom: pos ? undefined : 96,
    left: pos?.x,
    top: pos?.y,
    padding: open ? 14 : '8px 10px',
  };
  if (hiddenFor === phaseKey) return null;
  return (
    // Not the page's business: a press here must not make Echo Morph snapshot, glide or settle anything around it.
    <div
      className={s.focusDock}
      style={style}
      role="region"
      aria-label="Đồng hồ tập trung"
      data-testid="focus-dock"
      data-morph="off"
      data-spatial-exclude=""
      data-echo-clear=""
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('button,a')) return;
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        drag.current = { sx: e.clientX, sy: e.clientY, x: r.left, y: r.top };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        pointerLight.onPointerMove(e);
        const d = drag.current;
        if (!d) return;
        setPos({
          x: Math.max(4, Math.min(window.innerWidth - 120, d.x + e.clientX - d.sx)),
          y: Math.max(4, Math.min(window.innerHeight - 60, d.y + e.clientY - d.sy)),
        });
      }}
      onPointerUp={() => { drag.current = null; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'grab' }}>
        {!open && <span style={{ fontWeight: 800, fontSize: 18, fontVariantNumeric: 'tabular-nums' }}>{clockText(shown)}</span>}
        {!open && <span className={s.focusDockSub}>{phaseLabel(state)}{state.status === 'paused' ? ' · tạm dừng' : ''}</span>}
        <span style={{ flex: 1 }} />
        <button type="button" className={s.focusDockBtn} onClick={() => void openPortableTimer()} aria-label="Mở cửa sổ nổi" title="Cửa sổ nổi"><PanelTopOpen size={14} /></button>
        <Link href="/study-space" className={s.focusDockBtn} aria-label="Về Không gian học tập" title="Về Không gian học tập"><House size={14} /></Link>
        <button type="button" className={s.focusDockBtn} onClick={() => setOpen(!open)} aria-label={open ? 'Thu gọn' : 'Mở rộng'} aria-expanded={open}>{open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</button>
        <button type="button" className={s.focusDockBtn} onClick={() => setHiddenFor(phaseKey)} aria-label="Ẩn đồng hồ (phiên vẫn chạy)" title="Ẩn đồng hồ (phiên vẫn chạy)" data-testid="focus-dock-close"><X size={14} /></button>
      </div>
      {open && <div style={{ marginTop: 8 }}><FocusFace state={state} engine={engine} size={150} compact /></div>}
    </div>
  );
}
