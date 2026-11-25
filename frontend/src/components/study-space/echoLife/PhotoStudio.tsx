'use client';
/**
 * Echo Life Wave 11 — Photo Studio Minimalist Photography HUD.
 * Keeps center viewport completely clear while exposing Time Frozen toggle,
 * FOV slider (25 to 75 deg), 6 film filters, 5 poses, 5 facial expressions,
 * Hide Controls (H), shutter flash animation, and "Saved to Echo Phone Gallery" toast.
 * 100% clean English copy, pure multi-stop Pearl Opal glass over WebGL, zero V3 edits.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  Check,
  Eye,
  EyeOff,
  Pause,
  Play,
  X,
} from 'lucide-react';
import s from './photoStudio.module.css';

export type PhotoFilterId =
  | 'natural'
  | 'golden_film'
  | 'cool_editorial'
  | 'noir'
  | 'soft_pastel'
  | 'cinema';

export type PhotoPoseId = 'stand' | 'wave' | 'cheer' | 'think' | 'peace';
export type PhotoExpressionId = 'neutral' | 'smile' | 'joy' | 'focused' | 'surprised';

export interface PhotoCapturePayload {
  fov: number;
  filter: PhotoFilterId;
  filterLabel: string;
  cssFilter: string;
  pose: PhotoPoseId;
  expression: PhotoExpressionId;
  timeFrozen: boolean;
}

export interface PhotoStudioProps {
  open: boolean;
  zoneLabel?: string;
  seasonLabel?: string;
  initialFov?: number;
  timeFrozen?: boolean;
  onTimeFrozenChange?: (frozen: boolean) => void;
  onFovChange?: (fovDeg: number) => void;
  onFilterChange?: (filter: PhotoFilterId, cssFilter: string) => void;
  onPoseChange?: (pose: PhotoPoseId) => void;
  onExpressionChange?: (expression: PhotoExpressionId) => void;
  onCapture: (payload: PhotoCapturePayload) => Promise<boolean | void> | boolean | void;
  onClose: () => void;
}

export const PHOTO_FILTERS: readonly { id: PhotoFilterId; label: string; css: string }[] = [
  { id: 'natural', label: 'Natural', css: 'none' },
  { id: 'golden_film', label: 'Golden Film', css: 'sepia(0.24) saturate(1.22) contrast(1.06) brightness(1.03)' },
  { id: 'cool_editorial', label: 'Cool Editorial', css: 'saturate(0.92) contrast(1.1) hue-rotate(-8deg) brightness(1.02)' },
  { id: 'noir', label: 'Noir', css: 'grayscale(1) contrast(1.28) brightness(0.96)' },
  { id: 'soft_pastel', label: 'Soft Pastel', css: 'saturate(0.88) brightness(1.08) contrast(0.92)' },
  { id: 'cinema', label: 'Cinema', css: 'contrast(1.16) saturate(1.12) brightness(0.96)' },
];

export const PHOTO_POSES: readonly { id: PhotoPoseId; label: string }[] = [
  { id: 'stand', label: 'Stand' },
  { id: 'wave', label: 'Wave' },
  { id: 'cheer', label: 'Cheer' },
  { id: 'think', label: 'Think' },
  { id: 'peace', label: 'Peace' },
];

export const PHOTO_EXPRESSIONS: readonly { id: PhotoExpressionId; label: string }[] = [
  { id: 'neutral', label: 'Neutral' },
  { id: 'smile', label: 'Smile' },
  { id: 'joy', label: 'Joy' },
  { id: 'focused', label: 'Focused' },
  { id: 'surprised', label: 'Surprised' },
];

export function PhotoStudio({
  open,
  zoneLabel,
  seasonLabel,
  initialFov = 48,
  timeFrozen: controlledFrozen,
  onTimeFrozenChange,
  onFovChange,
  onFilterChange,
  onPoseChange,
  onExpressionChange,
  onCapture,
  onClose,
}: PhotoStudioProps) {
  const [localFrozen, setLocalFrozen] = useState(controlledFrozen ?? true);
  const [fov, setFov] = useState(Math.max(25, Math.min(75, Math.round(initialFov))));
  const [filter, setFilter] = useState<PhotoFilterId>('natural');
  const [pose, setPose] = useState<PhotoPoseId>('stand');
  const [expression, setExpression] = useState<PhotoExpressionId>('smile');
  const [controlsHidden, setControlsHidden] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [flashKey, setFlashKey] = useState(0);
  const [showToast, setShowToast] = useState(false);

  const wasOpenRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const onFilterChangeRef = useRef(onFilterChange);
  onFilterChangeRef.current = onFilterChange;

  const isFrozen = controlledFrozen ?? localFrozen;

  useEffect(() => {
    if (!open) {
      if (wasOpenRef.current) {
        onFilterChangeRef.current?.('natural', 'none');
      }
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    setControlsHidden(false);
    setShowToast(false);
    setLocalFrozen(controlledFrozen ?? true);
    setFov(Math.max(25, Math.min(75, Math.round(initialFov))));
    setFilter('natural');
    setPose('stand');
    setExpression('smile');
    onFilterChangeRef.current?.('natural', 'none');
  }, [open, initialFov, controlledFrozen]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    };
  }, []);

  const toggleFrozen = useCallback(() => {
    const next = !isFrozen;
    setLocalFrozen(next);
    onTimeFrozenChange?.(next);
  }, [isFrozen, onTimeFrozenChange]);

  const handleSelectFilter = useCallback(
    (id: PhotoFilterId) => {
      const def = PHOTO_FILTERS.find(f => f.id === id) ?? PHOTO_FILTERS[0];
      setFilter(def.id);
      onFilterChange?.(def.id, def.css);
    },
    [onFilterChange],
  );

  const handleCapture = useCallback(async () => {
    if (capturing) return;
    const def = PHOTO_FILTERS.find(f => f.id === filter) ?? PHOTO_FILTERS[0];
    setCapturing(true);
    setFlashKey(k => k + 1);
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashKey(0), 340);

    try {
      const res = await onCapture({
        fov,
        filter: def.id,
        filterLabel: def.label,
        cssFilter: def.css,
        pose,
        expression,
        timeFrozen: isFrozen,
      });
      if (res !== false) {
        setShowToast(true);
        if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = window.setTimeout(() => setShowToast(false), 2600);
      }
    } finally {
      setCapturing(false);
    }
  }, [capturing, filter, fov, pose, expression, isFrozen, onCapture]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        setControlsHidden(v => !v);
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFrozen();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose, toggleFrozen]);

  if (!open) return null;

  return (
    <div
      className={s.photoRoot}
      role="dialog"
      aria-label="Photo Studio"
      data-testid="photo-studio"
    >
      {!controlsHidden ? (
        <>
          <header className={s.topStrip} data-testid="photo-studio-toolbar">
            {/* Row 1: Time Frozen, FOV, Location meta, Hide Controls, Capture, Close */}
            <div className={s.barRow}>
              <div className={s.group}>
                <button
                  type="button"
                  className={s.pill}
                  aria-pressed={isFrozen}
                  data-testid="photo-freeze-toggle"
                  onClick={toggleFrozen}
                >
                  {isFrozen ? <Pause size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
                  <span>{isFrozen ? 'Time Frozen' : 'Time Live'}</span>
                </button>

                <label className={s.fovControl}>
                  <span className={s.label}>FOV</span>
                  <input
                    type="range"
                    min={25}
                    max={75}
                    step={1}
                    value={fov}
                    aria-label="Camera field of view"
                    data-testid="photo-fov-slider"
                    onChange={e => {
                      const next = Number(e.target.value);
                      setFov(next);
                      onFovChange?.(next);
                    }}
                  />
                  <span className={s.fovValue}>{fov} deg</span>
                </label>

                {(zoneLabel || seasonLabel) && (
                  <span className={s.label}>
                    {[zoneLabel, seasonLabel].filter(Boolean).join(' · ')}
                  </span>
                )}
              </div>

              <div className={s.group}>
                <button
                  type="button"
                  className={s.pill}
                  aria-pressed={controlsHidden}
                  data-testid="photo-hide-toggle"
                  onClick={() => setControlsHidden(true)}
                >
                  <EyeOff size={13} aria-hidden="true" />
                  <span>Hide Controls (H)</span>
                </button>

                <button
                  type="button"
                  className={s.captureBtn}
                  disabled={capturing}
                  data-testid="photo-capture-btn"
                  onClick={() => void handleCapture()}
                >
                  <Camera size={15} aria-hidden="true" />
                  <span>Capture Photo</span>
                </button>

                <button
                  type="button"
                  className={s.pill}
                  aria-label="Exit Photo Studio"
                  data-testid="photo-close-btn"
                  onClick={onClose}
                >
                  <X size={14} aria-hidden="true" />
                  <span>Exit</span>
                </button>
              </div>
            </div>

            {/* Row 2: Filters, Poses, Expressions */}
            <div className={s.barRow}>
              <div className={s.group} role="group" aria-label="Color filters">
                <span className={s.label}>Filter</span>
                {PHOTO_FILTERS.map(f => (
                  <button
                    key={f.id}
                    type="button"
                    className={s.pill}
                    aria-pressed={filter === f.id}
                    data-testid={`photo-filter-${f.id}`}
                    onClick={() => handleSelectFilter(f.id)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              <div className={s.group} role="group" aria-label="Character poses">
                <span className={s.label}>Pose</span>
                {PHOTO_POSES.map(p => (
                  <button
                    key={p.id}
                    type="button"
                    className={s.pill}
                    aria-pressed={pose === p.id}
                    data-testid={`photo-pose-${p.id}`}
                    onClick={() => {
                      setPose(p.id);
                      onPoseChange?.(p.id);
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              <div className={s.group} role="group" aria-label="Facial expressions">
                <span className={s.label}>Expression</span>
                {PHOTO_EXPRESSIONS.map(ex => (
                  <button
                    key={ex.id}
                    type="button"
                    className={s.pill}
                    aria-pressed={expression === ex.id}
                    data-testid={`photo-expr-${ex.id}`}
                    onClick={() => {
                      setExpression(ex.id);
                      onExpressionChange?.(ex.id);
                    }}
                  >
                    {ex.label}
                  </button>
                ))}
              </div>
            </div>
          </header>

          {/* Unobstructed Viewfinder Corner Framing */}
          <div className={s.viewfinder} aria-hidden="true">
            <span className={s.cornerTL} />
            <span className={s.cornerTR} />
            <span className={s.cornerBL} />
            <span className={s.cornerBR} />
          </div>
        </>
      ) : (
        <div className={s.hiddenDock} data-testid="photo-hidden-dock">
          <button
            type="button"
            className={s.pill}
            data-testid="photo-show-toggle"
            onClick={() => setControlsHidden(false)}
          >
            <Eye size={13} aria-hidden="true" />
            <span>Show Controls (H)</span>
          </button>
          <button
            type="button"
            className={s.captureBtn}
            disabled={capturing}
            data-testid="photo-capture-btn"
            onClick={() => void handleCapture()}
          >
            <Camera size={14} aria-hidden="true" />
            <span>Capture</span>
          </button>
          <button
            type="button"
            className={s.pill}
            aria-label="Exit Photo Studio"
            onClick={onClose}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Crisp Shutter Flash */}
      {flashKey > 0 && <div key={flashKey} className={s.shutterFlash} data-testid="photo-shutter-flash" aria-hidden="true" />}

      {/* Saved Confirmation Toast */}
      {showToast && (
        <div className={s.savedToast} role="status" data-testid="photo-saved-toast">
          <Check size={15} aria-hidden="true" />
          <span>Saved to Echo Phone Gallery</span>
        </div>
      )}
    </div>
  );
}
