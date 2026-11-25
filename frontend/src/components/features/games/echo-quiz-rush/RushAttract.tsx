'use client';

import { useEffect, useRef } from 'react';
import { SkyWorld, detectQuality } from './sky/skyWorld';
import type { RushHero } from './sky/skyCharacter';

/**
 * The lobby's living backdrop: the chosen hero jogging the causeway with Echo circling, filmed by a slow orbit.
 * Pure presentation — no question, no request, no answer. Sleeps in hidden tabs; still frame under reduced motion.
 */
export default function RushAttract({ reduced, onFailed, hero = 'LYRA', avatar }: { reduced: boolean; onFailed?: () => void; hero?: RushHero; avatar?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null), reducedRef = useRef(reduced), heroRef = useRef(hero), avatarRef = useRef(avatar);
  reducedRef.current = reduced; heroRef.current = hero; avatarRef.current = avatar;
  useEffect(() => {
    const canvas = canvasRef.current!;
    let world: SkyWorld;
    const tier = detectQuality();
    try { world = new SkyWorld(canvas, tier === 'high' ? 'medium' : tier, () => onFailed?.()); }
    catch { onFailed?.(); return; }
    let raf = 0, last = 0, y = 600, disposed = false;
    const walls = Array.from({ length: 400 }, (_, i) => 2400 * (i + 1));
    const course = { total: walls.length, walls, finish: walls[walls.length - 1] + 700, spacing: 2400 };
    const resize = () => { const r = canvas.getBoundingClientRect(); world.resize(r.width, r.height); };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    const frame = (now: number) => {
      if (disposed) return;
      const dt = last ? Math.min(.05, (now - last) / 1000) : 0; last = now;
      const still = reducedRef.current;
      if (!document.hidden) {
        if (!still) y += 150 * dt;
        world.frame({ mode: 'attract', now, dt, reduced: still, course,
          local: { id: 'p1', name: '', x: 500, y, vx: 0, speed: still ? 0 : 150, phase: still ? 'COUNTDOWN' : 'RUNNING', phaseTime: 1, connected: true, checkpoint: Math.floor(y / 2400), effect: '', streak: 0, look: 0, hero: heroRef.current, avatar: avatarRef.current, gates: 0, openGate: -1, rejected: -1, dashing: false, rushing: false },
          question: null, tried: [], aim: -1, passed: [], remotes: [] });
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { disposed = true; cancelAnimationFrame(raf); observer.disconnect(); world.dispose(); };
    // One world per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <canvas ref={canvasRef} className="rush-attract" aria-hidden="true" />;
}
