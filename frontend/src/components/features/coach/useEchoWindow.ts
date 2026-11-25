'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { clampGeometry, restoreWindow, ECHO_WINDOW_KEY, type EchoGeometry, type EchoMode } from './echo-window';

export function useEchoWindow() {
  const [mode, setMode] = useState<EchoMode>('collapsed');
  const [geometry, setGeometry] = useState<EchoGeometry>({ x: 12, y: 12, width: 660, height: 680 });
  const [mobile, setMobile] = useState(false);
  const [visibleHeight, setVisibleHeight] = useState<number | null>(null);
  const [interacting, setInteracting] = useState(false);
  const ready = useRef(false);
  const viewport = () => ({ width: window.visualViewport?.width ?? window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight });
  useEffect(() => {
    const size = viewport();
    let raw: string | null = null;
    try { raw = localStorage.getItem(ECHO_WINDOW_KEY); } catch {}
    const restored = restoreWindow(raw, size);
    setMode(restored.mode); setGeometry(restored.geometry); setMobile(size.width < 640); setVisibleHeight(size.height); ready.current = true;
    const recover = () => { const size = viewport(); setMobile(size.width < 640); setVisibleHeight(size.height); setGeometry(g => clampGeometry(g, size)); };
    window.addEventListener('resize', recover); window.visualViewport?.addEventListener('resize', recover);
    return () => { window.removeEventListener('resize', recover); window.visualViewport?.removeEventListener('resize', recover); };
  }, []);
  useEffect(() => {
    if (!ready.current || interacting) return;
    try { localStorage.setItem(ECHO_WINDOW_KEY, JSON.stringify({ mode, geometry })); } catch {}
  }, [mode, geometry, interacting]);
  const gesture = useRef<{ kind: 'drag' | 'resize'; x: number; y: number; initial: EchoGeometry } | null>(null);
  const frame = useRef<number | null>(null);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  const start = (event: ReactPointerEvent<HTMLElement>, kind: 'drag' | 'resize') => {
    if (mobile || mode !== 'expanded' || event.button !== 0 || (kind === 'drag' && (event.target as HTMLElement).closest('button'))) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { kind, x: event.clientX, y: event.clientY, initial: geometry }; setInteracting(true);
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current; if (!g) return;
    const dx = event.clientX - g.x, dy = event.clientY - g.y;
    const next = { ...g.initial, ...(g.kind === 'drag' ? { x: g.initial.x + dx, y: g.initial.y + dy } : { width: g.initial.width + dx, height: g.initial.height + dy }) };
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => { setGeometry(clampGeometry(next, viewport())); frame.current = null; });
  };
  const stop = () => { gesture.current = null; setInteracting(false); };
  const reset = useCallback(() => setGeometry(clampGeometry({}, viewport())), []);
  const pointer = { onPointerMove: move, onPointerUp: stop, onPointerCancel: stop, onLostPointerCapture: stop };
  return { mode, setMode, geometry, mobile, visibleHeight, interacting, reset, drag: { ...pointer, onPointerDown: (e: ReactPointerEvent<HTMLElement>) => start(e, 'drag') },
    resize: { ...pointer, onPointerDown: (e: ReactPointerEvent<HTMLElement>) => start(e, 'resize') },
    keyboardResize: (dx: number, dy: number) => setGeometry(g => clampGeometry({ ...g, width: g.width + dx, height: g.height + dy }, viewport())) };
}
