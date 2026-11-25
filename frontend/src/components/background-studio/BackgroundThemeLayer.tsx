'use client';

import React, { memo, useMemo, useSyncExternalStore } from 'react';
import type { BackgroundEffectId, BackgroundThemeConfig } from '@/lib/background-studio/types';
import { buildBackgroundStyleVars } from '@/lib/background-studio/cssRenderer';
import './background-studio-properties.css';
import styles from './BackgroundThemeLayer.module.css';

interface NetworkConnectionLike {
  saveData?: boolean;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

function readSaveData(): boolean {
  if (typeof navigator === 'undefined') return false;
  const connection = (navigator as Navigator & { connection?: NetworkConnectionLike }).connection;
  return Boolean(connection?.saveData);
}

function subscribeSaveData(onChange: () => void): () => void {
  if (typeof navigator === 'undefined') return () => {};
  const connection = (navigator as Navigator & { connection?: NetworkConnectionLike }).connection;
  if (!connection?.addEventListener || !connection?.removeEventListener) return () => {};
  connection.addEventListener('change', onChange);
  return () => connection.removeEventListener?.('change', onChange);
}

function useSaveData(): boolean {
  return useSyncExternalStore(subscribeSaveData, readSaveData, () => false);
}

function readDocumentVisible(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState !== 'hidden';
}

function subscribeDocumentVisible(onChange: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeDocumentVisible, readDocumentVisible, () => true);
}

export interface BackgroundThemeLayerProps {
  /** Full Echo Background Studio theme configuration (color, depth, motion, light, grain). */
  config: BackgroundThemeConfig;
  /** When false (hidden tab, studio open, resting route), pauses all GPU animations cleanly. Defaults to true. */
  playing?: boolean;
  /** Honors reduced-motion preference by unmounting motion layers and pausing animation playback. Defaults to false. */
  reducedMotion?: boolean;
  /** Forces eco/low-power compositor budget (max 1 lightweight animated plane, no blur, no grain). */
  lowPower?: boolean;
  /** Container-scoped preview mode (for example inside BackgroundLivePreview). */
  previewMode?: boolean;
  /** Compact thumbnail/card mode (disables grain, releases will-change, caps active layers). */
  compact?: boolean;
  /** Optional fixed full-viewport positioning when mounted outside a fixed stage wrapper. */
  fixed?: boolean;
  /** Optional calm/quiet damping factor (`0..1`) to soften motion and light on focused study screens. */
  calm?: number;
  /** Optional extra CSS class appended to the root stage container. */
  className?: string;
  /** Optional test identifier (defaults to `'background-theme-layer'`). */
  'data-testid'?: string;
}

const SCALED_CALM_VARS = ['--ec-bg-motion', '--ec-bg-light', '--ec-bg-shimmer'] as const;

function applyCalmDamping(
  vars: Record<string, string>,
  calm: number | undefined,
): Record<string, string> {
  if (!calm || !Number.isFinite(calm) || calm <= 0) {
    return vars;
  }
  const clamped = Math.min(1, Math.max(0, calm));
  const factor = 1 - clamped * 0.48;
  const next: Record<string, string> = { ...vars };
  for (const key of SCALED_CALM_VARS) {
    const raw = vars[key];
    if (raw === undefined) continue;
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) {
      next[key] = (parsed * factor).toFixed(3);
    }
  }
  return next;
}

/**
 * Shared pure DOM/CSS GPU-composited background renderer for Echo Background Studio.
 *
 * Used identically inside `WallpaperStage` (full workspace stage) and `BackgroundLivePreview`
 * (container-scoped live editor preview). Runs entirely on CSS compositor animations
 * (`transform` and `opacity` only) with zero script-driven frame loops or 3D graphics contexts.
 */
function BackgroundThemeLayerBase({
  config,
  playing = true,
  reducedMotion = false,
  lowPower = false,
  previewMode = false,
  compact = false,
  fixed = false,
  calm,
  className,
  'data-testid': testId = 'background-theme-layer',
}: BackgroundThemeLayerProps) {
  const saveData = useSaveData();
  const pageVisible = useDocumentVisible();
  const effectiveLowPower = lowPower || saveData;

  const plan = useMemo(
    () =>
      buildBackgroundStyleVars(config, {
        reducedMotion,
        lowPower: effectiveLowPower,
        compact,
        activeOnly: true,
      }),
    [config, reducedMotion, effectiveLowPower, compact],
  );

  const rootStyle = useMemo(
    () => applyCalmDamping(plan.styleVars, calm) as React.CSSProperties,
    [plan.styleVars, calm],
  );

  const isEco = plan.isEco;
  const isStatic = plan.isStatic || reducedMotion || (compact && !playing);
  const isPaused = !playing || !pageVisible || reducedMotion || isStatic;
  const singlePlaneBudget = isEco || compact;

  const activeEffects: readonly BackgroundEffectId[] = useMemo(() => {
    if (isStatic) return [];
    if (singlePlaneBudget) return plan.activeEffects.slice(0, 1);
    return plan.activeEffects;
  }, [isStatic, singlePlaneBudget, plan.activeEffects]);

  const activeSet = useMemo(() => new Set<BackgroundEffectId>(activeEffects), [activeEffects]);

  const hasEffect = (id: BackgroundEffectId): boolean => activeSet.has(id);
  const showDepth =
    plan.styleVars['--ec-bg-depth'] !== 'none' &&
    Number.parseFloat(plan.styleVars['--ec-bg-depth-opacity'] ?? '1') > 0;
  const showAnimatedAmbientGlow = hasEffect('ambient-glow');
  const showStaticAmbientGlow =
    !showAnimatedAmbientGlow &&
    (plan.hasStaticGlow ||
      config.color.glow > 0 ||
      (isStatic && config.motion.effects.includes('ambient-glow') && config.motion.lightIntensity > 0));
  const showGrain = plan.hasGrain && !isEco && !compact && plan.styleVars['--ec-bg-grain'] !== 'none';

  const rootClasses = [
    styles.ecBgRoot,
    fixed ? styles.ecBgFixed : '',
    previewMode ? styles.ecBgPreview : '',
    compact ? styles.ecBgCompact : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={rootClasses}
      style={rootStyle}
      aria-hidden="true"
      data-testid={testId}
      data-paused={isPaused ? 'true' : 'false'}
      data-eco={isEco ? 'true' : undefined}
      data-compact={compact ? 'true' : undefined}
      data-preview={previewMode ? 'true' : undefined}
      data-static={isStatic ? 'true' : undefined}
      data-effects={isStatic ? 'static' : activeEffects.join(',')}
    >
      <div className={styles.ecBgBase} data-ec-layer="base" />

      {hasEffect('gradient-morph') && (
        <div className={`${styles.ecBgMotionLayer} ${styles.ecBgMorph}`} data-ec-layer="morph" />
      )}

      {showDepth && <div className={styles.ecBgDepth} data-ec-layer="depth" />}

      {hasEffect('color-flow') && (
        <div className={`${styles.ecBgMotionLayer} ${styles.ecBgFlow}`} data-ec-layer="color-flow" />
      )}

      {hasEffect('aurora') && (
        <>
          <div className={`${styles.ecBgMotionLayer} ${styles.ecBgAuroraA}`} data-ec-layer="aurora-a" />
          {!singlePlaneBudget && (
            <div className={`${styles.ecBgMotionLayer} ${styles.ecBgAuroraB}`} data-ec-layer="aurora-b" />
          )}
        </>
      )}

      {hasEffect('liquid-flow') && (
        <>
          <div className={`${styles.ecBgMotionLayer} ${styles.ecBgOrbA}`} data-ec-layer="liquid-orb-a" />
          {!singlePlaneBudget && (
            <>
              <div className={`${styles.ecBgMotionLayer} ${styles.ecBgOrbB}`} data-ec-layer="liquid-orb-b" />
              <div className={`${styles.ecBgMotionLayer} ${styles.ecBgOrbC}`} data-ec-layer="liquid-orb-c" />
            </>
          )}
        </>
      )}

      {showAnimatedAmbientGlow && (
        <div className={`${styles.ecBgMotionLayer} ${styles.ecBgAmbientGlow}`} data-ec-layer="ambient-glow" />
      )}

      {showStaticAmbientGlow && (
        <div className={styles.ecBgAmbientGlowStatic} data-ec-layer="ambient-glow-static" />
      )}

      {hasEffect('light-drift') && (
        <>
          <div className={`${styles.ecBgMotionLayer} ${styles.ecBgDriftA}`} data-ec-layer="light-drift-a" />
          {!singlePlaneBudget && (
            <div className={`${styles.ecBgMotionLayer} ${styles.ecBgDriftB}`} data-ec-layer="light-drift-b" />
          )}
        </>
      )}

      {hasEffect('pearl-shimmer') && (
        <div className={`${styles.ecBgMotionLayer} ${styles.ecBgPearl}`} data-ec-layer="pearl-shimmer" />
      )}

      {hasEffect('color-breathing') && (
        <div className={`${styles.ecBgMotionLayer} ${styles.ecBgBreathe}`} data-ec-layer="color-breathing" />
      )}

      {showGrain && <div className={styles.ecBgGrain} data-ec-layer="grain" />}
    </div>
  );
}

const BackgroundThemeLayer = memo(BackgroundThemeLayerBase);
BackgroundThemeLayer.displayName = 'BackgroundThemeLayer';

export default BackgroundThemeLayer;
export { BackgroundThemeLayer };
