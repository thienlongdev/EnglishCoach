'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  Check,
  Eye,
  EyeOff,
  Pause,
  Play,
  RotateCcw,
  X,
} from 'lucide-react';
import type { Mood } from '@/lib/embodiment/cast';
import type {
  ArenaPhotoExpression,
  ArenaPhotoFilterId,
  ArenaPhotoPose,
  ArenaPhotoState,
} from './arenaContracts';
import s from './ArenaPhotoStudio.module.css';

export interface ArenaPhotoFilterDef {
  id: ArenaPhotoFilterId;
  labelEn: string;
  labelVi: string;
  css: string;
}

export interface ArenaPhotoPoseDef {
  id: ArenaPhotoPose;
  labelEn: string;
  labelVi: string;
}

export interface ArenaPhotoExpressionDef {
  id: ArenaPhotoExpression;
  labelEn: string;
  labelVi: string;
  mood: Mood;
}

export interface ArenaPhotoCapturePayload {
  fov: number;
  filterId: ArenaPhotoFilterId;
  filterLabel: string;
  cssFilter: string;
  pose: ArenaPhotoPose;
  expression: ArenaPhotoExpression;
  timeFrozen: boolean;
}

export const ARENA_PHOTO_FILTERS: readonly ArenaPhotoFilterDef[] = [
  { id: 'natural', labelEn: 'Natural', labelVi: 'Tự nhiên', css: 'none' },
  {
    id: 'golden_film',
    labelEn: 'Golden Film',
    labelVi: 'Phim nắng vàng',
    css: 'sepia(0.24) saturate(1.22) contrast(1.06) brightness(1.03)',
  },
  {
    id: 'cool_editorial',
    labelEn: 'Cool Editorial',
    labelVi: 'Biển ngọc mát',
    css: 'saturate(0.92) contrast(1.1) hue-rotate(-8deg) brightness(1.02)',
  },
  {
    id: 'noir',
    labelEn: 'Noir',
    labelVi: 'Đen trắng cổ điển',
    css: 'grayscale(1) contrast(1.28) brightness(0.96)',
  },
  {
    id: 'soft_pastel',
    labelEn: 'Soft Pastel',
    labelVi: 'Dịu sáng',
    css: 'saturate(0.88) brightness(1.08) contrast(0.92)',
  },
  {
    id: 'cinema',
    labelEn: 'Cinema',
    labelVi: 'Điện ảnh',
    css: 'contrast(1.16) saturate(1.12) brightness(0.96)',
  },
];

export const ARENA_PHOTO_POSES: readonly ArenaPhotoPoseDef[] = [
  { id: 'stand', labelEn: 'Stand', labelVi: 'Đứng dáng' },
  { id: 'wave', labelEn: 'Wave', labelVi: 'Vẫy chào' },
  { id: 'cheer', labelEn: 'Cheer', labelVi: 'Reo vui' },
  { id: 'think', labelEn: 'Think', labelVi: 'Suy ngẫm' },
  { id: 'peace', labelEn: 'Peace', labelVi: 'Chữ V' },
];

export const ARENA_PHOTO_EXPRESSIONS: readonly ArenaPhotoExpressionDef[] = [
  { id: 'neutral', labelEn: 'Neutral', labelVi: 'Điềm tĩnh', mood: 'neutral' },
  { id: 'smile', labelEn: 'Smile', labelVi: 'Mỉm cười', mood: 'smile' },
  { id: 'joy', labelEn: 'Joy', labelVi: 'Rạng rỡ', mood: 'joy' },
  { id: 'focused', labelEn: 'Focused', labelVi: 'Tập trung', mood: 'focused' },
  { id: 'surprised', labelEn: 'Surprised', labelVi: 'Ngạc nhiên', mood: 'surprised' },
];

export const DEFAULT_ARENA_PHOTO_STATE: ArenaPhotoState = {
  open: false,
  pose: 'stand',
  expression: 'smile',
  filterId: 'natural',
  cssFilter: 'none',
  fov: 48,
  timeFrozen: true,
  controlsHidden: false,
};

const ALLOWED_FILTER_CSS = new Set<string>(ARENA_PHOTO_FILTERS.map(f => f.css));

export function resolveArenaPhotoFilterCss(filterId: ArenaPhotoFilterId): string {
  const found = ARENA_PHOTO_FILTERS.find(f => f.id === filterId);
  return found ? found.css : 'none';
}

export function sanitizeArenaPhotoCssFilter(raw: string | null | undefined): string {
  if (!raw || raw === 'none') return 'none';
  return ALLOWED_FILTER_CSS.has(raw) ? raw : 'none';
}

export function mapPhotoExpressionToMood(expression: ArenaPhotoExpression): Mood {
  const found = ARENA_PHOTO_EXPRESSIONS.find(e => e.id === expression);
  return found ? found.mood : 'happy';
}

/**
 * Composite the live WebGL canvas onto an offscreen 2D canvas with the active film filter baked in,
 * trigger a browser PNG download, and return the captured PNG data URL + dimensions.
 */
export async function captureArenaCanvasToPng(
  sourceCanvas: HTMLCanvasElement,
  cssFilter: string,
  filenamePrefix = 'echo-archipelago-photo',
): Promise<{ dataUrl: string; downloaded: boolean; width: number; height: number } | null> {
  if (typeof document === 'undefined') return null;
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  if (width <= 0 || height <= 0) return null;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = width;
  outCanvas.height = height;
  const ctx = outCanvas.getContext('2d');
  if (!ctx) return null;

  const safeFilter = sanitizeArenaPhotoCssFilter(cssFilter);
  if (safeFilter !== 'none') {
    ctx.filter = safeFilter;
  }
  ctx.drawImage(sourceCanvas, 0, 0, width, height);
  ctx.filter = 'none';

  const dataUrl = outCanvas.toDataURL('image/png');
  let downloaded = false;
  try {
    const blob = await new Promise<Blob | null>(resolve => outCanvas.toBlob(resolve, 'image/png'));
    if (blob) {
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${filenamePrefix}-${stamp}.png`;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      downloaded = true;
    }
  } catch {
    downloaded = false;
  }

  return { dataUrl, downloaded, width, height };
}

export interface ArenaPhotoStudioProps {
  open?: boolean;
  state?: ArenaPhotoState;
  onStateChange?: (next: ArenaPhotoState) => void;
  vi?: boolean;
  islandLabel?: string;
  initialFov?: number;
  pose?: ArenaPhotoPose;
  expression?: ArenaPhotoExpression;
  filterId?: ArenaPhotoFilterId;
  fov?: number;
  timeFrozen?: boolean;
  controlsHidden?: boolean;
  onPoseChange?: (pose: ArenaPhotoPose) => void;
  onExpressionChange?: (expression: ArenaPhotoExpression) => void;
  onFilterChange?: (filterId: ArenaPhotoFilterId, cssFilter: string) => void;
  onFovChange?: (fovDeg: number) => void;
  onTimeFrozenChange?: (frozen: boolean) => void;
  onControlsHiddenChange?: (hidden: boolean) => void;
  onResetCamera?: () => void;
  onCapture: (payload: ArenaPhotoCapturePayload) => Promise<boolean | unknown> | boolean | unknown;
  onClose: () => void;
}

export default function ArenaPhotoStudio({
  open: openProp,
  state,
  onStateChange,
  vi = false,
  islandLabel,
  initialFov = 48,
  pose: poseProp,
  expression: expressionProp,
  filterId: filterIdProp,
  fov: fovProp,
  timeFrozen: timeFrozenProp,
  controlsHidden: controlsHiddenProp,
  onPoseChange,
  onExpressionChange,
  onFilterChange,
  onFovChange,
  onTimeFrozenChange,
  onControlsHiddenChange,
  onResetCamera,
  onCapture,
  onClose,
}: ArenaPhotoStudioProps) {
  const isOpen = state ? state.open : Boolean(openProp);

  const [localState, setLocalState] = useState<ArenaPhotoState>(() => ({
    ...DEFAULT_ARENA_PHOTO_STATE,
    fov: Math.max(25, Math.min(75, Math.round(initialFov))),
  }));
  const [capturing, setCapturing] = useState(false);
  const [flashKey, setFlashKey] = useState(0);
  const [showToast, setShowToast] = useState(false);

  const wasOpenRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  const activePose = state?.pose ?? poseProp ?? localState.pose;
  const activeExpression = state?.expression ?? expressionProp ?? localState.expression;
  const activeFilterId = state?.filterId ?? filterIdProp ?? localState.filterId;
  const activeCssFilter = state?.cssFilter ?? resolveArenaPhotoFilterCss(activeFilterId);
  const activeFov = state?.fov ?? fovProp ?? localState.fov;
  const activeFrozen = state?.timeFrozen ?? timeFrozenProp ?? localState.timeFrozen;
  const activeHidden = state?.controlsHidden ?? controlsHiddenProp ?? localState.controlsHidden;

  const commitPatch = useCallback(
    (patch: Partial<ArenaPhotoState>) => {
      const base: ArenaPhotoState = {
        open: isOpen,
        pose: activePose,
        expression: activeExpression,
        filterId: activeFilterId,
        cssFilter: activeCssFilter,
        fov: activeFov,
        timeFrozen: activeFrozen,
        controlsHidden: activeHidden,
      };
      const next: ArenaPhotoState = { ...base, ...patch };
      setLocalState(next);
      onStateChange?.(next);
    },
    [
      activeCssFilter,
      activeExpression,
      activeFilterId,
      activeFov,
      activeFrozen,
      activeHidden,
      activePose,
      isOpen,
      onStateChange,
    ],
  );

  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    setShowToast(false);
    if (!state) {
      const clampedFov = Math.max(25, Math.min(75, Math.round(initialFov)));
      setLocalState({
        ...DEFAULT_ARENA_PHOTO_STATE,
        open: true,
        fov: clampedFov,
      });
    }
  }, [initialFov, isOpen, state]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    };
  }, []);

  const handlePoseSelect = useCallback(
    (nextPose: ArenaPhotoPose) => {
      commitPatch({ pose: nextPose });
      onPoseChange?.(nextPose);
    },
    [commitPatch, onPoseChange],
  );

  const handleExpressionSelect = useCallback(
    (nextExpr: ArenaPhotoExpression) => {
      commitPatch({ expression: nextExpr });
      onExpressionChange?.(nextExpr);
    },
    [commitPatch, onExpressionChange],
  );

  const handleFilterSelect = useCallback(
    (nextFilterId: ArenaPhotoFilterId) => {
      const css = resolveArenaPhotoFilterCss(nextFilterId);
      commitPatch({ filterId: nextFilterId, cssFilter: css });
      onFilterChange?.(nextFilterId, css);
    },
    [commitPatch, onFilterChange],
  );

  const handleFovSlide = useCallback(
    (nextFovRaw: number) => {
      const clamped = Math.max(25, Math.min(75, Math.round(nextFovRaw)));
      commitPatch({ fov: clamped });
      onFovChange?.(clamped);
    },
    [commitPatch, onFovChange],
  );

  const handleToggleFrozen = useCallback(() => {
    const next = !activeFrozen;
    commitPatch({ timeFrozen: next });
    onTimeFrozenChange?.(next);
  }, [activeFrozen, commitPatch, onTimeFrozenChange]);

  const handleSetControlsHidden = useCallback(
    (hidden: boolean) => {
      commitPatch({ controlsHidden: hidden });
      onControlsHiddenChange?.(hidden);
    },
    [commitPatch, onControlsHiddenChange],
  );

  const handleCapture = useCallback(async () => {
    if (capturing) return;
    const def = ARENA_PHOTO_FILTERS.find(f => f.id === activeFilterId) ?? ARENA_PHOTO_FILTERS[0];
    setCapturing(true);
    setFlashKey(k => k + 1);
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashKey(0), 340);

    try {
      const result = await onCapture({
        fov: activeFov,
        filterId: def.id,
        filterLabel: vi ? def.labelVi : def.labelEn,
        cssFilter: def.css,
        pose: activePose,
        expression: activeExpression,
        timeFrozen: activeFrozen,
      });
      if (result !== false && result !== null) {
        setShowToast(true);
        if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = window.setTimeout(() => setShowToast(false), 2600);
      }
    } finally {
      setCapturing(false);
    }
  }, [activeExpression, activeFilterId, activeFov, activeFrozen, activePose, capturing, onCapture, vi]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditable =
        target &&
        (target.tagName === 'TEXTAREA' ||
          (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'range') ||
          target.isContentEditable);
      if (inEditable) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if ((e.code === 'KeyH' || e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        handleSetControlsHidden(!activeHidden);
      } else if ((e.code === 'KeyF' || e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        handleToggleFrozen();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [activeHidden, handleSetControlsHidden, handleToggleFrozen, isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className={s.photoRoot}
      role="dialog"
      aria-label={vi ? 'Phòng chụp ảnh quần đảo' : 'Archipelago Photo Studio'}
      data-testid="arena-photo-studio"
    >
      {!activeHidden ? (
        <>
          <header className={s.topStrip} data-testid="arena-photo-toolbar">
            {/* Row 1: Studio badge, Time Frozen, FOV, Camera Hints, Hide Controls, Capture, Exit */}
            <div className={s.barRow}>
              <div className={s.group}>
                <span className={s.titleBadge}>
                  <Camera size={13} />
                  <span>{vi ? 'Photo Studio' : 'Photo Studio'}</span>
                </span>

                <button
                  type="button"
                  className={s.pill}
                  aria-pressed={activeFrozen}
                  onClick={handleToggleFrozen}
                  title={vi ? 'Đóng băng chuyển động thế giới (F)' : 'Toggle Time Frozen (F)'}
                  data-testid="arena-photo-freeze"
                >
                  {activeFrozen ? <Pause size={13} /> : <Play size={13} />}
                  <span>
                    {activeFrozen
                      ? vi
                        ? 'Đóng băng thời gian'
                        : 'Time Frozen'
                      : vi
                        ? 'Thế giới sống động'
                        : 'Live World'}
                  </span>
                </button>

                <label className={s.fovControl}>
                  <span className={s.label}>FOV</span>
                  <input
                    type="range"
                    min={25}
                    max={75}
                    step={1}
                    value={activeFov}
                    onChange={e => handleFovSlide(Number(e.target.value))}
                    aria-label={vi ? 'Góc ống kính máy ảnh' : 'Camera field of view'}
                    data-testid="arena-photo-fov"
                  />
                  <span className={s.fovValue}>{activeFov}°</span>
                </label>

                {onResetCamera ? (
                  <button
                    type="button"
                    className={s.pill}
                    onClick={onResetCamera}
                    title={vi ? 'Đặt lại góc máy chân dung' : 'Reset portrait camera'}
                    data-testid="arena-photo-reset-cam"
                  >
                    <RotateCcw size={13} />
                    <span>{vi ? 'Đặt lại góc' : 'Reset Orbit'}</span>
                  </button>
                ) : null}

                {islandLabel ? <span className={s.pill}>{islandLabel}</span> : null}
              </div>

              <div className={s.group}>
                <span className={s.hintChip}>
                  {vi
                    ? 'Kéo chuột xoay · Chuột phải dịch · Lăn chuột thu phóng'
                    : 'Drag to orbit · Right-drag to pan · Scroll to zoom'}
                </span>

                <button
                  type="button"
                  className={s.pill}
                  onClick={() => handleSetControlsHidden(true)}
                  title={vi ? 'Ẩn thanh công cụ (H)' : 'Hide Controls (H)'}
                  data-testid="arena-photo-hide"
                >
                  <EyeOff size={13} />
                  <span>{vi ? 'Ẩn khung (H)' : 'Hide Controls (H)'}</span>
                </button>

                <button
                  type="button"
                  className={s.captureBtn}
                  disabled={capturing}
                  onClick={handleCapture}
                  data-testid="arena-photo-capture"
                >
                  <Camera size={15} />
                  <span>
                    {capturing
                      ? vi
                        ? 'Đang lưu...'
                        : 'Saving...'
                      : vi
                        ? 'Chụp ảnh'
                        : 'Capture Photo'}
                  </span>
                </button>

                <button
                  type="button"
                  className={s.pill}
                  onClick={onClose}
                  aria-label={vi ? 'Thoát chế độ chụp ảnh' : 'Exit Photo Studio'}
                  data-testid="arena-photo-close"
                >
                  <X size={14} />
                  <span>Esc</span>
                </button>
              </div>
            </div>

            {/* Row 2: 6 Film Filters */}
            <div className={s.barRow}>
              <div className={s.group} role="group" aria-label={vi ? 'Bộ lọc màu phim' : 'Film filters'}>
                <span className={s.label}>{vi ? 'Màu phim' : 'Filter'}</span>
                {ARENA_PHOTO_FILTERS.map(f => (
                  <button
                    key={f.id}
                    type="button"
                    className={s.pill}
                    aria-pressed={activeFilterId === f.id}
                    onClick={() => handleFilterSelect(f.id)}
                    data-testid={`arena-photo-filter-${f.id}`}
                  >
                    {vi ? f.labelVi : f.labelEn}
                  </button>
                ))}
              </div>
            </div>

            {/* Row 3: 5 Poses and 5 Synchronized Facial Expressions */}
            <div className={s.barRow}>
              <div className={s.group} role="group" aria-label={vi ? 'Tư thế nhân vật' : 'Character poses'}>
                <span className={s.label}>{vi ? 'Tư thế' : 'Pose'}</span>
                {ARENA_PHOTO_POSES.map(p => (
                  <button
                    key={p.id}
                    type="button"
                    className={s.pill}
                    aria-pressed={activePose === p.id}
                    onClick={() => handlePoseSelect(p.id)}
                    data-testid={`arena-photo-pose-${p.id}`}
                  >
                    {vi ? p.labelVi : p.labelEn}
                  </button>
                ))}
              </div>

              <div className={s.group} role="group" aria-label={vi ? 'Biểu cảm khuôn mặt' : 'Facial expressions'}>
                <span className={s.label}>{vi ? 'Biểu cảm' : 'Expression'}</span>
                {ARENA_PHOTO_EXPRESSIONS.map(ex => (
                  <button
                    key={ex.id}
                    type="button"
                    className={s.pill}
                    aria-pressed={activeExpression === ex.id}
                    onClick={() => handleExpressionSelect(ex.id)}
                    data-testid={`arena-photo-expr-${ex.id}`}
                  >
                    {vi ? ex.labelVi : ex.labelEn}
                  </button>
                ))}
              </div>
            </div>
          </header>

          <div className={s.viewfinder} aria-hidden="true">
            <span className={s.cornerTL} />
            <span className={s.cornerTR} />
            <span className={s.cornerBL} />
            <span className={s.cornerBR} />
          </div>
        </>
      ) : (
        <div className={s.hiddenDock}>
          <button
            type="button"
            className={s.pill}
            onClick={() => handleSetControlsHidden(false)}
            data-testid="arena-photo-show"
          >
            <Eye size={13} />
            <span>{vi ? 'Hiện công cụ (H)' : 'Show Controls (H)'}</span>
          </button>
          <button
            type="button"
            className={s.captureBtn}
            disabled={capturing}
            onClick={handleCapture}
            data-testid="arena-photo-capture"
          >
            <Camera size={14} />
            <span>{vi ? 'Chụp' : 'Capture'}</span>
          </button>
        </div>
      )}

      {flashKey > 0 ? <div key={flashKey} className={s.shutterFlash} data-testid="arena-photo-shutter" /> : null}

      {showToast ? (
        <div className={s.savedToast} role="status" data-testid="arena-photo-toast">
          <Check size={15} />
          <span>{vi ? 'Đã chụp và tải ảnh PNG về máy' : 'Photo captured and saved as PNG'}</span>
        </div>
      ) : null}
    </div>
  );
}
