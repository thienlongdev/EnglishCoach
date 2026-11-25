'use client';

import { useLayoutEffect, useRef, useState, type RefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { boxOf, SurfaceMotion, surfaceOwns, type SurfaceBox } from '@/lib/morph/surface';
import { morphReduced } from '@/lib/morph/tokens';
import '@/lib/morph/morph.css';

/** Keep the SAME React tree through close/reopen. Semantic open state still controls focus, requests and scroll locks. */
export function useMorphPresence(open: boolean, ref: RefObject<HTMLDivElement | null>, options: { trigger?: RefObject<HTMLElement | null>; onDismiss?: () => void } = {}) {
  const [retained, setRetained] = useState(open);
  const present = open || retained;
  const motion = useRef<SurfaceMotion | null>(null);
  const source = useRef<HTMLElement | null>(null);
  const isOpen = useRef(open); isOpen.current = open;
  const dismiss = useRef(options.onDismiss); dismiss.current = options.onDismiss;
  const drag = useRef<{ id: number; y: number; lastY: number; at: number; velocity: number } | null>(null);
  const swiped = useRef(false);
  const cancelClick = useRef(0);

  const target = (): SurfaceBox | null => {
    const el = options.trigger?.current ?? source.current;
    if (!el?.isConnected || el === document.body || el.tagName === 'CANVAS' || el.closest('[data-morph-presence]')) return null;
    const b = boxOf(el);
    return b.w > 0 && b.h > 0 && b.y >= 0 && b.y + b.h <= window.innerHeight && b.x >= 0 && b.x + b.w <= window.innerWidth ? b : null;
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !present) return;
    if (open) {
      setRetained(true);
      if (!surfaceOwns(el)) {
        source.current = options.trigger?.current ?? (document.activeElement as HTMLElement | null);
        if (morphReduced()) return;
        const r = boxOf(el), src = target();
        // A real trigger gives exact shared geometry; keyboard-only openings settle locally.
        const start = src ?? { x: r.x, y: r.y + 16, w: r.w * .96, h: r.h * .96 };
        motion.current = new SurfaceMotion(el, start);
      }
      motion.current?.enter();
    } else {
      const done = () => { if (!isOpen.current) setRetained(false); };
      if (morphReduced() || document.hidden) { motion.current?.dispose(); done(); return; }
      if (!surfaceOwns(el)) motion.current = new SurfaceMotion(el, null);
      if (swiped.current) { swiped.current = false; motion.current?.dismissSheet(done); }
      else {
        const r = boxOf(el), src = target();
        const end = src ?? { x: r.x, y: r.y + 16, w: r.w * .96, h: r.h * .96 };
        motion.current?.leave(end, done);
      }
    }
  }, [open, present, ref]);

  useLayoutEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const finish = () => {
      if (!document.hidden && !reduce.matches) return;
      motion.current?.dispose(); drag.current = null;
      if (!isOpen.current) setRetained(false);
    };
    reduce.addEventListener('change', finish);
    document.addEventListener('visibilitychange', finish);
    return () => { motion.current?.dispose(); reduce.removeEventListener('change', finish); document.removeEventListener('visibilitychange', finish); };
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!open || !dismiss.current || e.pointerType === 'mouse' || e.button !== 0 || window.innerWidth > 767 || morphReduced() || !ref.current) return;
    drag.current = { id: e.pointerId, y: e.clientY, lastY: e.clientY, at: e.timeStamp, velocity: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!surfaceOwns(ref.current)) motion.current = new SurfaceMotion(ref.current, null, 'sheet');
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dt = Math.max(1, e.timeStamp - d.at);
    d.velocity = (e.clientY - d.lastY) / dt * 1000; d.lastY = e.clientY; d.at = e.timeStamp;
    const offset = e.clientY - d.y;
    if (Math.abs(offset) > 5) cancelClick.current = performance.now() + 500;
    motion.current?.drag(offset < 0 ? offset * .18 : offset, d.velocity);
  };
  const release = (e: ReactPointerEvent<HTMLElement>, cancel: boolean) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const distance = e.clientY - d.y;
    const velocity = e.timeStamp - d.at > 100 ? 0 : d.velocity;
    if (!cancel && (distance > Math.min(140, (ref.current?.offsetHeight || 500) * .22) || (distance > 24 && velocity > 650))) {
      swiped.current = true; dismiss.current?.();
    } else motion.current?.enter();
  };

  return {
    present,
    panelProps: { 'data-morph-presence': '', 'data-morph-state': open ? 'open' : 'closing', inert: !open, 'aria-hidden': !open || undefined },
    handleProps: { onPointerDown, onPointerMove, onPointerUp: (e: ReactPointerEvent<HTMLElement>) => release(e, false), onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => release(e, true), onClick: () => { if (performance.now() > cancelClick.current) dismiss.current?.(); }, style: { touchAction: 'none' as const } },
  };
}
