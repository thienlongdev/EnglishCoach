'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { EchoSwimmer } from '@/components/brand/EchoSwimmer';
import {
  EchoSpringBank,
  resolveEchoEntityState,
  type EchoEntitySlot,
  type EchoEntityState,
  type EchoEntityStateInput,
} from './echoSprings';
import { sampleEchoAcousticFrame } from './echoAcousticBridge';
import { renderEchoPearlescentCanvas2d } from './echoCanvas2dFallback';
import styles from './echoEntity.module.css';

type EchoGpuStageModule = typeof import('./echoGpuStage');

let cachedStageModule: EchoGpuStageModule | null = null;
let pendingStageImport: Promise<EchoGpuStageModule | null> | null = null;
let nextEntityInstanceSeq = 1;

function loadEchoGpuStageModule(): Promise<EchoGpuStageModule | null> {
  if (cachedStageModule) return Promise.resolve(cachedStageModule);
  if (pendingStageImport) return pendingStageImport;
  pendingStageImport = import('./echoGpuStage')
    .then((mod) => {
      cachedStageModule = mod;
      return mod;
    })
    .catch(() => null)
    .finally(() => {
      pendingStageImport = null;
    });
  return pendingStageImport;
}

/**
 * Cleanly pauses any active Echo WebGL2 loop and detaches the shared canvas
 * without forcing context creation if not yet loaded.
 */
export function deactivateEchoEntityStage(): void {
  cachedStageModule?.pauseEchoEntityGpuStage();
}

function isRouteEvictedFast(pathname: string, search: string): boolean {
  if (!pathname) return false;
  if (
    pathname === '/speaking/arena' ||
    pathname.startsWith('/speaking/arena/') ||
    pathname === '/study-space' ||
    pathname.startsWith('/study-space/') ||
    pathname.startsWith('/games/echo-') ||
    (pathname.startsWith('/exams/') && pathname.includes('/attempts/')) ||
    pathname.startsWith('/ielts-cbt-preview') ||
    pathname.startsWith('/toeic-iig-preview')
  ) {
    return true;
  }
  if (pathname === '/learning-path') {
    const query = search.startsWith('?') ? search.slice(1) : search;
    return !query.split('&').includes('view=list');
  }
  return false;
}

function isCosmosRouteFast(pathname: string): boolean {
  return pathname === '/knowledge-universe' || pathname.startsWith('/knowledge-universe/');
}

function isCanvas2dAllowedRoute(pathname: string): boolean {
  if (!pathname) return true;
  if (
    pathname === '/speaking/arena' ||
    pathname.startsWith('/speaking/arena/') ||
    pathname.startsWith('/games/echo-') ||
    (pathname.startsWith('/exams/') && pathname.includes('/attempts/')) ||
    pathname.startsWith('/ielts-cbt-preview') ||
    pathname.startsWith('/toeic-iig-preview')
  ) {
    return false;
  }
  return true;
}

function resolveSizePreset(size: number | 'sm' | 'md' | 'lg' | undefined, slot: EchoEntitySlot): {
  sizeAttr: 'sm' | 'md' | 'lg';
  sizePx: number;
  explicitPx: number | null;
} {
  if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
    const clamped = Math.max(32, Math.min(512, Math.round(size)));
    const sizeAttr = clamped <= 88 ? 'sm' : clamped >= 176 ? 'lg' : 'md';
    return { sizeAttr, sizePx: clamped, explicitPx: clamped };
  }
  if (size === 'sm') return { sizeAttr: 'sm', sizePx: 64, explicitPx: null };
  if (size === 'lg') return { sizeAttr: 'lg', sizePx: slot === 'immersive' ? 248 : slot === 'voice' ? 214 : 196, explicitPx: null };
  if (slot === 'launcher') return { sizeAttr: 'sm', sizePx: 64, explicitPx: null };
  if (slot === 'compact') return { sizeAttr: 'sm', sizePx: 84, explicitPx: null };
  if (slot === 'ambient') return { sizeAttr: 'sm', sizePx: 88, explicitPx: null };
  if (slot === 'rail') return { sizeAttr: 'md', sizePx: 142, explicitPx: null };
  if (slot === 'voice') return { sizeAttr: 'lg', sizePx: 214, explicitPx: null };
  if (slot === 'immersive') return { sizeAttr: 'lg', sizePx: 248, explicitPx: null };
  return { sizeAttr: 'md', sizePx: 150, explicitPx: null };
}

function detectImplicitSlot(el: HTMLElement | null): EchoEntitySlot {
  if (!el || typeof el.closest !== 'function') return 'welcome';
  if (el.closest('.echo-imm-stage') || el.closest('.echo-immersive-stage')) return 'immersive';
  if (el.closest('.echo-voice-stage')) return 'voice';
  if (el.closest('.echo-rail-stage')) return 'rail';
  if (el.closest('.echo-ambient-shell')) return 'ambient';
  if (el.closest('.echo-launcher')) return 'launcher';
  return 'welcome';
}

function mapLegacyCssState(state: EchoEntityState, rawState: EchoEntityStateInput | undefined): string {
  if (state === 'listening' || state === 'awakening') return 'listening';
  if (state === 'thinking' || state === 'understanding' || state === 'executing' || state === 'reconnecting') {
    return 'thinking';
  }
  if (state === 'speaking') return rawState === 'streaming' ? 'streaming' : 'speaking';
  if (state === 'error' || state === 'interrupted') return 'error';
  return 'idle';
}

export type EchoEntityVisualMode = 'webgl2' | 'canvas2d' | 'essence' | 'disabled';

export interface EchoLivingEntityProps {
  state?: EchoEntityStateInput;
  slot?: EchoEntitySlot;
  size?: number | 'sm' | 'md' | 'lg';
  attentionAngle?: number;
  softDucked?: boolean;
  swim?: boolean;
  /** Explicit activation gate; when false, cleanly detaches GPU/Canvas2D and reports onVisualReady(false). */
  active?: boolean;
  /** Deterministic readiness callback for atomic visual ownership transfer with the Echo Whale mascot. */
  onVisualReady?: (ready: boolean) => void;
  className?: string;
}

export function EchoLivingEntity({
  state = 'idle',
  slot,
  size,
  attentionAngle,
  softDucked = false,
  swim = true,
  active = true,
  onVisualReady,
  className,
}: EchoLivingEntityProps) {
  const pathname = typeof usePathname === 'function' ? (usePathname() || '') : '';
  const searchParams = typeof useSearchParams === 'function' ? useSearchParams() : null;
  const search = searchParams ? searchParams.toString() : '';

  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const canvas2dRef = useRef<HTMLCanvasElement | null>(null);
  const onVisualReadyRef = useRef<((ready: boolean) => void) | undefined>(onVisualReady);
  onVisualReadyRef.current = onVisualReady;
  const lastReportedReadyRef = useRef<boolean | null>(null);

  const instanceIdRef = useRef<string>('');
  if (!instanceIdRef.current) {
    instanceIdRef.current = `echo-entity-${nextEntityInstanceSeq++}`;
  }

  const [inferredSlot, setInferredSlot] = useState<EchoEntitySlot>(slot ?? 'welcome');
  const [entityLive, setEntityLive] = useState(false);
  const [canvas2dLive, setCanvas2dLive] = useState(false);
  const [essenceMounted, setEssenceMounted] = useState(false);

  const effectiveSlot: EchoEntitySlot = slot ?? inferredSlot;
  const effectiveRawState: EchoEntityStateInput = active === false ? 'disabled' : state;
  const resolved = resolveEchoEntityState(effectiveRawState, effectiveSlot);
  const canonicalState: EchoEntityState = active === false ? 'disabled' : resolved.state;
  const { sizeAttr, sizePx, explicitPx } = resolveSizePreset(size, effectiveSlot);

  const routeHardEvicted = isRouteEvictedFast(pathname, search) && !isCanvas2dAllowedRoute(pathname);
  const visualMode: EchoEntityVisualMode =
    canonicalState === 'disabled' || routeHardEvicted
      ? 'disabled'
      : entityLive
        ? 'webgl2'
        : canvas2dLive
          ? 'canvas2d'
          : 'essence';
  const visualReady = visualMode !== 'disabled' && (entityLive || canvas2dLive || essenceMounted);

  const handleLiveChange = useCallback((live: boolean) => {
    setEntityLive(live);
  }, []);

  useEffect(() => {
    setEssenceMounted(true);
    return () => {
      if (lastReportedReadyRef.current === true) {
        lastReportedReadyRef.current = false;
        onVisualReadyRef.current?.(false);
      }
    };
  }, []);

  useEffect(() => {
    if (lastReportedReadyRef.current === visualReady) return;
    lastReportedReadyRef.current = visualReady;
    onVisualReadyRef.current?.(visualReady);
  }, [visualReady]);

  useEffect(() => {
    if (slot) {
      setInferredSlot(slot);
      return;
    }
    const detected = detectImplicitSlot(rootRef.current);
    setInferredSlot(detected);
  }, [slot]);

  // Primary WebGL2 Singleton Stage Registration
  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (canonicalState === 'disabled') {
      setEntityLive(false);
      cachedStageModule?.getEchoGpuStage().unregisterSlot(instanceIdRef.current);
      return;
    }

    if (isRouteEvictedFast(pathname, search)) {
      setEntityLive(false);
      cachedStageModule?.releaseEchoEntityGpuContext();
      return;
    }

    if (isCosmosRouteFast(pathname) && canonicalState === 'dormant') {
      setEntityLive(false);
      cachedStageModule?.releaseEchoEntityGpuContext();
      return;
    }

    if (!('WebGL2RenderingContext' in window)) {
      setEntityLive(false);
      return;
    }

    const hostEl = canvasMountRef.current;
    if (!hostEl) return;

    let cancelled = false;
    let unregister: (() => void) | null = null;
    let idleId = 0;
    let usedIdleCallback = false;

    const attachToStage = (mod: EchoGpuStageModule | null) => {
      if (cancelled || !mod || !canvasMountRef.current) return;
      unregister = mod.getEchoGpuStage().registerSlot({
        id: instanceIdRef.current,
        slot: effectiveSlot,
        hostEl: canvasMountRef.current,
        rawState: effectiveRawState,
        sizePx,
        attentionAngle,
        softDucked,
        pathname,
        search,
        visible: true,
        onLiveChange: handleLiveChange,
      });
    };

    if (cachedStageModule) {
      attachToStage(cachedStageModule);
    } else if (canonicalState === 'dormant') {
      // Strictly 0 new WebGL contexts while dormant: only warm module reference on idle if already cached elsewhere
      return;
    } else {
      void loadEchoGpuStageModule().then(attachToStage);
    }

    return () => {
      cancelled = true;
      if (idleId !== 0) {
        if (usedIdleCallback) {
          const cic = (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
          cic?.(idleId);
        } else {
          window.clearTimeout(idleId);
        }
      }
      unregister?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, search, effectiveSlot, canonicalState === 'dormant', canonicalState === 'disabled', handleLiveChange]);

  useEffect(() => {
    if (!cachedStageModule || canonicalState === 'disabled') return;
    cachedStageModule.getEchoGpuStage().updateSlot(instanceIdRef.current, {
      slot: effectiveSlot,
      rawState: effectiveRawState,
      sizePx,
      attentionAngle,
      softDucked,
      pathname,
      search,
    });
  }, [effectiveSlot, effectiveRawState, canonicalState, sizePx, attentionAngle, softDucked, pathname, search]);

  // Zero-WebGL Pearlescent Abyss Canvas2D fallback when active on evicted 3D worlds (Odyssey / StudySpace / low-tier Cosmos)
  // or when WebGL2 is unavailable / failed compile (strictly raf === 0 when dormant/disabled/reduced-motion!).
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const isActiveState = canonicalState !== 'dormant' && canonicalState !== 'disabled';
    const shouldUse2d =
      !entityLive &&
      isActiveState &&
      isCanvas2dAllowedRoute(pathname) &&
      (isRouteEvictedFast(pathname, search) ||
        isCosmosRouteFast(pathname) ||
        !('WebGL2RenderingContext' in window) ||
        Boolean(cachedStageModule?.getEchoEntityStageDiagnostics().compileFailed));

    const canvas = canvas2dRef.current;
    if (!shouldUse2d) {
      if (canvas) {
        const c2d = canvas.getContext?.('2d');
        c2d?.clearRect(0, 0, canvas.width, canvas.height);
      }
      setCanvas2dLive(false);
      return;
    }

    const ctx = canvas?.getContext?.('2d');
    if (!canvas || !ctx) {
      setCanvas2dLive(false);
      return;
    }

    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = reduced ? 1 : Math.min(window.devicePixelRatio || 1, 1.5);
    const dim = Math.max(64, Math.round(sizePx * 1.48 * dpr));
    canvas.width = dim;
    canvas.height = dim;

    const bank = new EchoSpringBank();
    const isDark = Boolean(document.documentElement?.classList?.contains('dark'));
    bank.setTheme(isDark, undefined, true);
    bank.setSoftDuck(softDucked);
    bank.setState(canonicalState, resolved.calmIdle);

    if (reduced) {
      const snap = bank.snapToTarget(0);
      const acoustic = sampleEchoAcousticFrame('dormant', 0);
      renderEchoPearlescentCanvas2d({ ctx, width: dim, height: dim, timeSec: 0, snap, acoustic });
      setCanvas2dLive(true);
      return () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        setCanvas2dLive(false);
      };
    }

    // Paint Frame 0 synchronously before revealing `.canvas2dLayer` -> 0 blank frames!
    const acoustic0 = sampleEchoAcousticFrame(canonicalState, 1 / 60);
    const snap0 = bank.step(1 / 60, acoustic0.voiceRms, acoustic0.speechIntensityTier);
    renderEchoPearlescentCanvas2d({ ctx, width: dim, height: dim, timeSec: 0, snap: snap0, acoustic: acoustic0 });
    setCanvas2dLive(true);

    let rafId = 0;
    let lastMs = 0;
    let simSec = 0;
    const tick = (nowMs: number) => {
      rafId = 0;
      if (document.hidden) return;
      if (lastMs > 0 && nowMs - lastMs < 31) {
        rafId = window.requestAnimationFrame(tick);
        return;
      }
      const dt = lastMs > 0 ? Math.min(0.08, (nowMs - lastMs) / 1000) : 1 / 30;
      lastMs = nowMs;
      simSec += dt;
      bank.setTheme(Boolean(document.documentElement?.classList?.contains('dark')), undefined, false);
      const acoustic = sampleEchoAcousticFrame(canonicalState, dt);
      const snap = bank.step(dt, acoustic.voiceRms, acoustic.speechIntensityTier);
      renderEchoPearlescentCanvas2d({ ctx, width: dim, height: dim, timeSec: simSec, snap, acoustic });
      if (bank.shouldAnimate()) {
        rafId = window.requestAnimationFrame(tick);
      }
    };
    if (bank.shouldAnimate()) {
      rafId = window.requestAnimationFrame(tick);
    }
    return () => {
      if (rafId !== 0) window.cancelAnimationFrame(rafId);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      setCanvas2dLive(false);
    };
  }, [entityLive, canonicalState, resolved.calmIdle, pathname, search, sizePx, softDucked]);

  const hostClass = [
    'echo-pearl',
    styles?.entityHost ?? '',
    className ?? '',
  ].filter(Boolean).join(' ');

  const inlineStyle: React.CSSProperties | undefined = explicitPx !== null
    ? { ['--orb' as string]: `${explicitPx}px`, width: `${explicitPx}px`, height: `${explicitPx}px` }
    : undefined;

  const showSwimmer =
    swim &&
    canonicalState !== 'disabled' &&
    effectiveSlot !== 'launcher' &&
    effectiveSlot !== 'compact' &&
    effectiveSlot !== 'ambient' &&
    effectiveSlot !== 'immersive' &&
    sizePx >= 96;
  const legacyState = mapLegacyCssState(canonicalState, effectiveRawState);

  return (
    <div
      ref={rootRef}
      className={hostClass}
      style={inlineStyle}
      data-size={sizeAttr}
      data-slot={effectiveSlot}
      data-state={legacyState}
      data-entity-state={canonicalState}
      data-visual-mode={visualMode}
      data-visual-ready={visualReady ? 'true' : undefined}
      data-entity-live={entityLive ? '' : undefined}
      data-entity-2d={canvas2dLive ? '' : undefined}
      aria-hidden="true"
    >
      <div ref={canvasMountRef} className={styles?.canvasMount ?? 'echo-entity-canvas-mount'} />
      <canvas ref={canvas2dRef} className={styles?.canvas2dLayer ?? 'echo-entity-canvas-2d'} aria-hidden="true" />
      <div className={styles?.restingEssence ?? 'echo-entity-resting'}>
        <span className={styles?.obsidianCorona ?? 'echo-pearl-halo'} />
        <span className={styles?.obsidianSphere ?? 'echo-pearl-sphere'}>
          <span className={styles?.obsidianPetalA} />
          <span className={styles?.obsidianPetalB} />
          <span className={styles?.obsidianSpec} />
        </span>
        <svg
          className={styles?.vernierSvg ?? undefined}
          viewBox="0 0 120 120"
          focusable="false"
          aria-hidden="true"
        >
          <defs>
            <radialGradient id="echo-entity-pearlescent-glint" cx="38%" cy="32%" r="68%">
              <stop offset="0%" stopColor="#f8fbff" stopOpacity="0.92" />
              <stop offset="44%" stopColor="#67e8f9" stopOpacity="0.46" />
              <stop offset="78%" stopColor="#c084fc" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#f472b6" stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle className={styles?.nacreCore ?? undefined} cx="60" cy="60" r="35" />
          <circle className={styles?.vernierOuter ?? undefined} cx="60" cy="60" r="53" />
          <circle className={styles?.vernierInner ?? undefined} cx="60" cy="60" r="46" />
        </svg>
        {showSwimmer && <EchoSwimmer className="echo-pearl-whale" facing="left" drift={false} />}
      </div>
    </div>
  );
}
