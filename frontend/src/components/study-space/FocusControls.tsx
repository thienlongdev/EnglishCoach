'use client';

import React from 'react';
import { Pause, Play, RotateCcw, SkipForward, Square } from 'lucide-react';
import { clockText, elapsedMs, phaseLabel, remainingMs, type FocusEngine, type FocusState } from '@/lib/study-space/focus';
import { useNow } from './useNow';

/**
 * The focus timer face and its controls — the same component in the room widget, the full panel, the floating dock
 * on other pages and the Picture-in-Picture window, so every view shows the same session from the same clock.
 * `inlineStyles` renders without CSS-module classes (the Picture-in-Picture window has no stylesheet of ours).
 */
export function FocusFace({ state, engine, size = 190, compact = false }: { state: FocusState; engine: FocusEngine; size?: number; compact?: boolean }) {
  const now = useNow(state.status === 'running' ? 250 : 1000);
  const done = elapsedMs(state, now);
  const left = remainingMs(state, now);
  const total = state.mode === 'STOPWATCH' ? 0 : state.durationMs;
  const progress = total ? Math.min(1, done / total) : (done / 60_000) % 1;
  const shown = state.mode === 'STOPWATCH' ? done : state.status === 'idle' ? state.durationMs : left;
  const r = size / 2 - 10;
  const c = 2 * Math.PI * r;
  const breakPhase = state.mode === 'POMODORO' && state.phase !== 'focus';
  const color = breakPhase ? '#2fae84' : '#7c6cf0';
  const btn: React.CSSProperties = {
    display: 'inline-grid', placeItems: 'center', width: 44, height: 44, borderRadius: 999,
    border: '1px solid rgba(124,108,240,.25)', background: 'rgba(124,108,240,.08)', color: '#5b5f86', cursor: 'pointer',
  };
  const main: React.CSSProperties = { ...btn, width: compact ? 46 : 58, height: compact ? 46 : 58, color: '#fff', border: 0, background: 'linear-gradient(135deg,#8b7cf0,#6a8cf5)', boxShadow: '0 10px 24px -10px rgba(110,100,240,.8)' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: compact ? 6 : 10 }}>
      <div style={{ position: 'relative', width: size, height: size }} role="timer" aria-live="off" aria-label={`${phaseLabel(state)} ${clockText(shown)}`}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }} aria-hidden="true">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(124,108,240,.14)" strokeWidth={compact ? 7 : 9} />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={compact ? 7 : 9} strokeLinecap="round"
            strokeDasharray={c} strokeDashoffset={c * (1 - progress)} style={{ transition: 'stroke-dashoffset .25s linear' }} />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
          <div>
            <div style={{ fontSize: size * 0.21, fontWeight: 800, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em', color: 'var(--ink, #23264a)', lineHeight: 1 }}>{clockText(shown)}</div>
            <div style={{ fontSize: Math.max(10, size * 0.065), fontWeight: 700, color: 'var(--ink-soft, #5b5f86)', marginTop: 6 }}>
              {phaseLabel(state)}{state.mode === 'POMODORO' ? ` · ${(state.cycle % state.settings.cyclesBeforeLong) + (state.phase === 'focus' ? 1 : 0) || state.settings.cyclesBeforeLong}/${state.settings.cyclesBeforeLong}` : ''}
            </div>
            {state.status === 'paused' && <div style={{ fontSize: 11, fontWeight: 700, color: '#d8962f', marginTop: 4 }}>Đang tạm dừng</div>}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button type="button" style={btn} onClick={() => engine.reset()} aria-label="Đặt lại" title="Đặt lại"><RotateCcw size={16} /></button>
        {state.status === 'running'
          ? <button type="button" style={main} onClick={() => engine.pause()} aria-label="Tạm dừng" title="Tạm dừng"><Pause size={22} /></button>
          : <button type="button" style={main} onClick={() => engine.begin()} aria-label={state.status === 'paused' ? 'Tiếp tục' : 'Bắt đầu'} title={state.status === 'paused' ? 'Tiếp tục' : 'Bắt đầu'}><Play size={22} /></button>}
        {state.mode === 'POMODORO'
          ? <button type="button" style={btn} onClick={() => engine.skip()} aria-label="Chuyển phiên" title="Chuyển sang phiên tiếp theo"><SkipForward size={16} /></button>
          : <button type="button" style={btn} onClick={() => engine.stop()} aria-label="Kết thúc" title="Kết thúc"><Square size={14} /></button>}
      </div>
    </div>
  );
}
