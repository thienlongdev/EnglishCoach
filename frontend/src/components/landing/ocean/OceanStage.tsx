'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createOceanEngine, OceanFailure } from './oceanEngine';
import { ECHO_MODEL_URL } from './echoAssets';
import { registerJourneyStage } from '@/lib/journey/journey';

// The canvas' fade-in (`duration-1000` below).
const CANVAS_FADE_MS = 1000;

export type EchoProgress = 'ready' | 'shown' | 'stall';

interface OceanStageProps {
  /** Element whose `[data-whale-lane]` descendants define where Echo may swim. */
  laneRootId: string;
  /** For the page's standby still: model in the scene, first frame with Echo fully visible, model request stalled. */
  onEcho: (event: EchoProgress) => void;
  onFail: (reason: OceanFailure) => void;
}

/**
 * The WebGL layer of the landing ocean: its own chunk (three.js never joins the landing chunk). The server renders
 * only this empty click-through layer, which makes the page HTML preload the chunk so it downloads in parallel with
 * the app instead of after hydration. It is hidden from assistive technology: the page content above it carries all
 * meaning and every control.
 *
 * Nothing stands in for Echo while the model is on time — the water and its motes are already there, and Echo's first
 * appearance is the swim-in itself. Only a late or stalled model makes the page show its standby still (the real
 * model, rendered); Echo then appears exactly under it and takes over.
 */
export default function OceanStage({ laneRootId, onEcho, onFail }: OceanStageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const bubbleTextRef = useRef<HTMLParagraphElement>(null);
  const [visible, setVisible] = useState(false);
  // Bumped when the visitor changes prefers-reduced-motion: the engine restarts in the other mode.
  const [motionKey, setMotionKey] = useState(0);
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;
  const onEchoRef = useRef(onEcho);
  onEchoRef.current = onEcho;

  useEffect(() => {
    const canvas = canvasRef.current;
    const laneRoot = document.getElementById(laneRootId);
    if (!canvas || !laneRoot) return;
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotionChange = () => setMotionKey((key) => key + 1);
    motionQuery.addEventListener('change', onMotionChange);
    let engine: ReturnType<typeof createOceanEngine> | null = null;
    let unregister: (() => void) | null = null;
    let timer = 0;
    // "Shown" waits until the canvas has finished fading in: the page never retires its standby still over a
    // half-transparent whale.
    let liveAt = 0;
    let shownTimer = 0;
    // Start right after the next paint — the server-rendered headline is already on screen, so the water never
    // delays it — and never later than that (no idle wait: on a busy phone it deferred Echo by up to 1.2 s). The
    // engine compiles its shaders without blocking, the water fades in, and Echo enters by swimming in.
    const start = () => {
      engine = createOceanEngine({
        canvas,
        laneRoot,
        modelUrl: ECHO_MODEL_URL,
        reducedMotion: motionQuery.matches,
        bubble: bubbleRef.current,
        bubbleText: bubbleTextRef.current,
        onLive: () => {
          liveAt = performance.now();
          setVisible(true);
        },
        onReady: () => {
          setVisible(true);
          onEchoRef.current('ready');
        },
        onShown: () => {
          const wait = Math.max(0, liveAt + CANVAS_FADE_MS - performance.now());
          shownTimer = window.setTimeout(() => onEchoRef.current('shown'), wait);
        },
        onStall: () => onEchoRef.current('stall'),
        onFail: (reason) => onFailRef.current(reason),
      });
      unregister = registerJourneyStage('landing', engine.stage);
    };
    const raf = requestAnimationFrame(() => {
      timer = window.setTimeout(start, 0);
    });
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      window.clearTimeout(shownTimer);
      motionQuery.removeEventListener('change', onMotionChange);
      unregister?.();
      engine?.dispose();
    };
  }, [laneRootId, motionKey]);

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[1]" data-purpose="landing-ocean-stage">
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 h-full w-full transition-opacity duration-1000 ${visible ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        ref={bubbleRef}
        className="absolute left-0 top-0 max-w-[16rem] sm:max-w-[18rem] will-change-transform"
        style={{ opacity: 0, visibility: 'hidden' }}
        data-purpose="whale-speech-bubble"
      >
        <div className="relative rounded-2xl border border-white/70 bg-white/95 px-4 py-2.5 shadow-xl shadow-indigo-950/40">
          <p ref={bubbleTextRef} className="text-[13px] font-semibold leading-snug tracking-tight text-slate-800" />
          <span className="absolute -bottom-1.5 left-[28%] h-3.5 w-3.5 rotate-45 border-b border-r border-white/70 bg-white/95" />
        </div>
      </div>
    </div>
  );
}
