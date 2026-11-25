'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  BACKGROUND_BLEND_MODES,
  BG_BOUNDS,
  COLOR_FORMAT_MODES,
  GRADIENT_TYPES,
  MAX_STOPS,
  MIN_STOPS,
  type BackgroundBlendMode,
  type BackgroundColorConfig,
  type ColorFormatMode,
  type ColorStop,
  type GradientType,
  type OklchColor,
} from '@/lib/background-studio/types';
import {
  formatCssColor,
  formatHex,
  formatHsl,
  formatOklch,
  formatRgb,
  hexToOklch,
  hexToRgb,
  hslToRgb,
  interpolateOklchHex,
  oklchToHex,
  parseColorInput,
  rgbToHex,
  rgbToHsl,
} from '@/lib/background-studio/colorScience';
import styles from './BackgroundStudio.module.css';

export interface ColorStudioPanelProps {
  /** Current color, geometry, blend, and optical settings in the draft. */
  color: BackgroundColorConfig;
  /** Current anti-banding grain strength (0..100). */
  grainOpacity: number;
  /** Baseline color settings used for double-click slider resets. */
  defaultColor: BackgroundColorConfig;
  /** Baseline grain opacity used for double-click slider reset. */
  defaultGrainOpacity: number;
  /** Emits immediate color configuration updates (0 ms live response). */
  onChangeColor: (next: BackgroundColorConfig) => void;
  /** Emits immediate grain opacity updates. */
  onChangeGrainOpacity: (next: number) => void;
  /** Vietnamese UI copy when true; English UI copy when false. */
  vi: boolean;
}

const GRADIENT_LABELS: Record<GradientType, { vi: string; en: string }> = {
  linear: { vi: 'Linear', en: 'Linear' },
  radial: { vi: 'Radial', en: 'Radial' },
  conic: { vi: 'Conic', en: 'Conic' },
  mesh: { vi: 'Mesh', en: 'Mesh' },
};

const BLEND_MODE_LABELS: Record<BackgroundBlendMode, string> = {
  normal: 'Normal',
  screen: 'Screen',
  overlay: 'Overlay',
  'soft-light': 'Soft Light',
  'color-dodge': 'Color Dodge',
  lighten: 'Lighten',
  multiply: 'Multiply',
};

const FORMAT_LABELS: Record<ColorFormatMode, string> = {
  hex: 'HEX',
  rgb: 'RGB',
  hsl: 'HSL',
  oklch: 'OKLCH',
};

const GOLDEN_ANGLE_RAD = 2.399963229728653;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function sliderFillPercent(value: number, min: number, max: number): string {
  if (max <= min) return '0%';
  const ratio = clamp((value - min) / (max - min), 0, 1);
  return `${(ratio * 100).toFixed(1)}%`;
}

function nextStopId(stops: readonly ColorStop[]): string {
  const used = new Set(stops.map((s) => s.id));
  let idx = stops.length + 1;
  while (used.has(`stop-${idx}`)) {
    idx += 1;
  }
  return `stop-${idx}`;
}

function resolveMeshDisplayCoord(
  stop: ColorStop,
  index: number,
  total: number,
): { x: number; y: number } {
  if (typeof stop.x === 'number' && Number.isFinite(stop.x) && typeof stop.y === 'number' && Number.isFinite(stop.y)) {
    return { x: clamp(stop.x, 0, 100), y: clamp(stop.y, 0, 100) };
  }
  const theta = index * GOLDEN_ANGLE_RAD + 0.55;
  const radius = total <= 2 ? 28 : 22 + (index / Math.max(1, total - 1)) * 22;
  return {
    x: Math.round(clamp(stop.x ?? 50 + Math.cos(theta) * radius, 8, 92)),
    y: Math.round(clamp(stop.y ?? 50 + Math.sin(theta) * radius, 8, 92)),
  };
}

function buildStopBarLinearCss(stops: readonly ColorStop[]): string {
  if (stops.length === 0) return 'linear-gradient(90deg, #071028 0%, #2795b5 100%)';
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const curr = sorted[i];
    parts.push(`${formatCssColor(curr.color, curr.opacity)} ${curr.position.toFixed(1)}%`);
    if (i < sorted.length - 1) {
      const next = sorted[i + 1];
      const span = next.position - curr.position;
      if (span > 2) {
        const midHex = interpolateOklchHex(curr.color, next.color, 0.5);
        const midAlpha = (curr.opacity + next.opacity) * 0.5;
        const midPos = curr.position + span * 0.5;
        parts.push(`${formatCssColor(midHex, midAlpha)} ${midPos.toFixed(1)}%`);
      }
    }
  }
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

function sampleInterpolatedStopAt(
  stops: readonly ColorStop[],
  position: number,
): { color: string; opacity: number; x: number; y: number } {
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  if (sorted.length === 0) {
    return { color: '#38bdf8', opacity: 0.9, x: 50, y: 50 };
  }
  if (position <= sorted[0].position) {
    const first = sorted[0];
    return {
      color: first.color,
      opacity: first.opacity,
      x: first.x ?? 24,
      y: first.y ?? 24,
    };
  }
  const last = sorted[sorted.length - 1];
  if (position >= last.position) {
    return {
      color: last.color,
      opacity: last.opacity,
      x: last.x ?? 76,
      y: last.y ?? 76,
    };
  }
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const left = sorted[i];
    const right = sorted[i + 1];
    if (position >= left.position && position <= right.position) {
      const span = Math.max(0.001, right.position - left.position);
      const t = clamp((position - left.position) / span, 0, 1);
      const leftCoord = resolveMeshDisplayCoord(left, i, sorted.length);
      const rightCoord = resolveMeshDisplayCoord(right, i + 1, sorted.length);
      return {
        color: interpolateOklchHex(left.color, right.color, t),
        opacity: Math.round((left.opacity + (right.opacity - left.opacity) * t) * 100) / 100,
        x: Math.round(leftCoord.x + (rightCoord.x - leftCoord.x) * t),
        y: Math.round(leftCoord.y + (rightCoord.y - leftCoord.y) * t),
      };
    }
  }
  return { color: last.color, opacity: last.opacity, x: 50, y: 50 };
}

interface StudioSliderProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  valueText: string;
  minLabel?: string;
  maxLabel?: string;
  onChange: (next: number) => void;
  testId: string;
  resetHint: string;
}

function StudioSlider({
  id,
  label,
  value,
  min,
  max,
  step,
  defaultValue,
  valueText,
  minLabel,
  maxLabel,
  onChange,
  testId,
  resetHint,
}: StudioSliderProps) {
  return (
    <div className={styles.sliderRow}>
      <div className={styles.sliderHeader}>
        <label htmlFor={id} className={styles.sliderLabel}>
          {label}
        </label>
        <span
          className={styles.sliderValuePill}
          title={resetHint}
          onDoubleClick={() => onChange(defaultValue)}
        >
          {valueText}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        onDoubleClick={() => onChange(defaultValue)}
        className={styles.rangeInput}
        style={{ '--fill': sliderFillPercent(value, min, max) } as React.CSSProperties}
        aria-valuetext={valueText}
        title={resetHint}
        data-testid={testId}
      />
      {(minLabel || maxLabel) && (
        <div className={styles.sliderEnds} aria-hidden="true">
          <span>{minLabel ?? ''}</span>
          <span>{maxLabel ?? ''}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Tab 2 — Multi-Stop OKLCH Color Studio, Geometry, 2D Focal Pad, Blend Mode,
 * Layer Opacities, and All 10 Optical and Gradient Sliders.
 */
export default function ColorStudioPanel({
  color,
  grainOpacity,
  defaultColor,
  defaultGrainOpacity,
  onChangeColor,
  onChangeGrainOpacity,
  vi,
}: ColorStudioPanelProps) {
  const [selectedStopId, setSelectedStopId] = useState<string>(
    () => color.stops[0]?.id ?? 'stop-1',
  );
  const [draggingStopId, setDraggingStopId] = useState<string | null>(null);
  const [colorFormat, setColorFormat] = useState<ColorFormatMode>('hex');
  const [hexDraft, setHexDraft] = useState<string>('');
  const [cssInput, setCssInput] = useState<string>('');
  const [cssError, setCssError] = useState<string | null>(null);
  const [oklchState, setOklchState] = useState<{ key: string; value: OklchColor } | null>(null);

  const trackRef = useRef<HTMLDivElement>(null);
  const focalPadRef = useRef<HTMLDivElement>(null);
  const draggingFocalModeRef = useRef<'center' | { stopId: string } | null>(null);
  const pinRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const formatTabRefs = useRef<Partial<Record<ColorFormatMode, HTMLButtonElement | null>>>({});
  const gradientTypeRefs = useRef<Partial<Record<GradientType, HTMLButtonElement | null>>>({});
  const blendModeRefs = useRef<Partial<Record<BackgroundBlendMode, HTMLButtonElement | null>>>({});

  const activeIndex = useMemo(() => {
    const idx = color.stops.findIndex((s) => s.id === selectedStopId);
    return idx >= 0 ? idx : 0;
  }, [color.stops, selectedStopId]);

  const activeStop = color.stops[activeIndex] ?? color.stops[0];
  const activeStopKey = activeStop ? `${activeStop.id}:${activeStop.color}` : '';

  useEffect(() => {
    if (activeStop && activeStop.id !== selectedStopId) {
      setSelectedStopId(activeStop.id);
    }
  }, [activeStop, selectedStopId]);

  useEffect(() => {
    if (!activeStop) return;
    setHexDraft(activeStop.color.toUpperCase());
    setCssError(null);
  }, [activeStop?.id, activeStop?.color]);

  const derivedRgb = useMemo(
    () => hexToRgb(activeStop?.color ?? '#071028'),
    [activeStop?.color],
  );
  const derivedHsl = useMemo(() => rgbToHsl(derivedRgb), [derivedRgb]);
  const derivedOklch = useMemo(
    () =>
      oklchState && oklchState.key === activeStopKey
        ? oklchState.value
        : hexToOklch(activeStop?.color ?? '#071028'),
    [activeStop?.color, activeStopKey, oklchState],
  );

  const stopBarGradientCss = useMemo(
    () => buildStopBarLinearCss(color.stops),
    [color.stops],
  );

  const updateColorField = useCallback(
    <K extends keyof BackgroundColorConfig>(key: K, value: BackgroundColorConfig[K]) => {
      onChangeColor({
        ...color,
        [key]: value,
      });
    },
    [color, onChangeColor],
  );

  const updateStopById = useCallback(
    (stopId: string, updater: (stop: ColorStop) => ColorStop) => {
      const nextStops = color.stops.map((stop) => (stop.id === stopId ? updater(stop) : stop));
      onChangeColor({
        ...color,
        stops: nextStops,
      });
    },
    [color, onChangeColor],
  );

  const updateActiveStopColor = useCallback(
    (nextHex: string, nextOpacity?: number, customOklch?: OklchColor) => {
      if (!activeStop) return;
      const canonical = formatHex(nextHex);
      if (customOklch) {
        setOklchState({ key: `${activeStop.id}:${canonical}`, value: customOklch });
      } else {
        setOklchState(null);
      }
      updateStopById(activeStop.id, (stop) => ({
        ...stop,
        color: canonical,
        opacity: nextOpacity !== undefined ? clamp(Math.round(nextOpacity * 100) / 100, 0, 1) : stop.opacity,
      }));
    },
    [activeStop, updateStopById],
  );

  // Add stop at an explicit percentage position (e.g. clicking the gradient bar)
  const addStopAtPosition = useCallback(
    (position: number) => {
      if (color.stops.length >= MAX_STOPS) return;
      const safePos = Math.round(clamp(position, 0, 100));
      const sampled = sampleInterpolatedStopAt(color.stops, safePos);
      const id = nextStopId(color.stops);
      const newStop: ColorStop = {
        id,
        color: sampled.color,
        position: safePos,
        opacity: sampled.opacity,
        x: sampled.x,
        y: sampled.y,
      };
      onChangeColor({
        ...color,
        stops: [...color.stops, newStop],
      });
      setSelectedStopId(id);
    },
    [color, onChangeColor],
  );

  // Add stop button: picks midpoint of largest sorted gap
  const handleAddStopButton = () => {
    if (color.stops.length >= MAX_STOPS) return;
    const sorted = [...color.stops].sort((a, b) => a.position - b.position);
    let bestPos = 50;
    let maxGap = -1;
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const gap = sorted[i + 1].position - sorted[i].position;
      if (gap > maxGap) {
        maxGap = gap;
        bestPos = Math.round((sorted[i].position + sorted[i + 1].position) * 0.5);
      }
    }
    if (maxGap <= 1) {
      bestPos = clamp(Math.round((activeStop?.position ?? 50) + 10), 0, 100);
    }
    addStopAtPosition(bestPos);
  };

  const handleDuplicateStop = () => {
    if (!activeStop || color.stops.length >= MAX_STOPS) return;
    const id = nextStopId(color.stops);
    const nextPos =
      activeStop.position >= 92
        ? Math.max(0, Math.round(activeStop.position - 6))
        : Math.min(100, Math.round(activeStop.position + 6));
    const coord = resolveMeshDisplayCoord(activeStop, activeIndex, color.stops.length);
    const clone: ColorStop = {
      id,
      color: activeStop.color,
      position: nextPos,
      opacity: activeStop.opacity,
      x: Math.round(clamp(coord.x + (coord.x > 80 ? -10 : 10), 6, 94)),
      y: Math.round(clamp(coord.y + (coord.y > 80 ? -8 : 8), 6, 94)),
    };
    const nextStops = [...color.stops];
    nextStops.splice(activeIndex + 1, 0, clone);
    onChangeColor({ ...color, stops: nextStops });
    setSelectedStopId(id);
  };

  const handleRemoveStop = () => {
    if (!activeStop || color.stops.length <= MIN_STOPS) return;
    const nextStops = color.stops.filter((s) => s.id !== activeStop.id);
    const fallbackIndex = Math.min(activeIndex, nextStops.length - 1);
    onChangeColor({ ...color, stops: nextStops });
    setSelectedStopId(nextStops[fallbackIndex]?.id ?? '');
  };

  const handleReorderStop = (direction: -1 | 1) => {
    const targetIndex = activeIndex + direction;
    if (targetIndex < 0 || targetIndex >= color.stops.length) return;
    const nextStops = [...color.stops];
    const current = nextStops[activeIndex];
    const neighbor = nextStops[targetIndex];
    // Swap both list order and gradient axis positions so reordering has immediate visual effect
    nextStops[activeIndex] = { ...neighbor, position: current.position };
    nextStops[targetIndex] = { ...current, position: neighbor.position };
    onChangeColor({ ...color, stops: nextStops });
  };

  // Gradient stop bar pointer interactions
  const computeTrackPercent = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 50;
    return Math.round(clamp(((clientX - rect.left) / rect.width) * 100, 0, 100));
  };

  const handleTrackClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target !== trackRef.current) return;
    if (color.stops.length >= MAX_STOPS) return;
    addStopAtPosition(computeTrackPercent(event.clientX));
  };

  const handlePinPointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
    stopId: string,
  ) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedStopId(stopId);
    setDraggingStopId(stopId);
  };

  const handlePinPointerMove = (
    event: React.PointerEvent<HTMLButtonElement>,
    stopId: string,
  ) => {
    if (draggingStopId !== stopId) return;
    const pos = computeTrackPercent(event.clientX);
    updateStopById(stopId, (stop) => ({ ...stop, position: pos }));
  };

  const handlePinPointerUp = (
    event: React.PointerEvent<HTMLButtonElement>,
    stopId: string,
  ) => {
    if (draggingStopId !== stopId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDraggingStopId(null);
  };

  const handlePinKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    stop: ColorStop,
    idx: number,
  ) => {
    const delta = event.shiftKey ? 5 : 1;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedStopId(stop.id);
      updateStopById(stop.id, (s) => ({ ...s, position: clamp(Math.round(s.position - delta), 0, 100) }));
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedStopId(stop.id);
      updateStopById(stop.id, (s) => ({ ...s, position: clamp(Math.round(s.position + delta), 0, 100) }));
    } else if (event.key === 'PageDown') {
      event.preventDefault();
      setSelectedStopId(stop.id);
      updateStopById(stop.id, (s) => ({ ...s, position: clamp(Math.round(s.position - 10), 0, 100) }));
    } else if (event.key === 'PageUp') {
      event.preventDefault();
      setSelectedStopId(stop.id);
      updateStopById(stop.id, (s) => ({ ...s, position: clamp(Math.round(s.position + 10), 0, 100) }));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setSelectedStopId(stop.id);
      updateStopById(stop.id, (s) => ({ ...s, position: 0 }));
    } else if (event.key === 'End') {
      event.preventDefault();
      setSelectedStopId(stop.id);
      updateStopById(stop.id, (s) => ({ ...s, position: 100 }));
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && color.stops.length > MIN_STOPS) {
      event.preventDefault();
      const nextStops = color.stops.filter((s) => s.id !== stop.id);
      const fallbackIndex = Math.min(idx, nextStops.length - 1);
      const fallbackId = nextStops[fallbackIndex]?.id ?? '';
      onChangeColor({ ...color, stops: nextStops });
      setSelectedStopId(fallbackId);
      if (fallbackId) {
        window.setTimeout(() => {
          pinRefs.current.get(fallbackId)?.focus();
        }, 0);
      }
    }
  };

  const handleFormatTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    idx: number,
  ) => {
    let nextIdx: number | null = null;
    if (event.key === 'ArrowRight') {
      nextIdx = (idx + 1) % COLOR_FORMAT_MODES.length;
    } else if (event.key === 'ArrowLeft') {
      nextIdx = (idx - 1 + COLOR_FORMAT_MODES.length) % COLOR_FORMAT_MODES.length;
    } else if (event.key === 'Home') {
      nextIdx = 0;
    } else if (event.key === 'End') {
      nextIdx = COLOR_FORMAT_MODES.length - 1;
    }
    if (nextIdx === null) return;
    event.preventDefault();
    const nextMode = COLOR_FORMAT_MODES[nextIdx];
    setColorFormat(nextMode);
    formatTabRefs.current[nextMode]?.focus();
  };

  const handleGradientTypeKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    idx: number,
  ) => {
    let nextIdx: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIdx = (idx + 1) % GRADIENT_TYPES.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIdx = (idx - 1 + GRADIENT_TYPES.length) % GRADIENT_TYPES.length;
    } else if (event.key === 'Home') {
      nextIdx = 0;
    } else if (event.key === 'End') {
      nextIdx = GRADIENT_TYPES.length - 1;
    }
    if (nextIdx === null) return;
    event.preventDefault();
    const nextType = GRADIENT_TYPES[nextIdx];
    updateColorField('gradientType', nextType);
    gradientTypeRefs.current[nextType]?.focus();
  };

  const handleBlendModeKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    idx: number,
  ) => {
    let nextIdx: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIdx = (idx + 1) % BACKGROUND_BLEND_MODES.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIdx = (idx - 1 + BACKGROUND_BLEND_MODES.length) % BACKGROUND_BLEND_MODES.length;
    } else if (event.key === 'Home') {
      nextIdx = 0;
    } else if (event.key === 'End') {
      nextIdx = BACKGROUND_BLEND_MODES.length - 1;
    }
    if (nextIdx === null) return;
    event.preventDefault();
    const nextMode = BACKGROUND_BLEND_MODES[nextIdx];
    updateColorField('blendMode', nextMode);
    blendModeRefs.current[nextMode]?.focus();
  };

  // Freeform CSS paste / input parser
  const applyFreeformColor = (rawValue: string, showErrorOnFail: boolean) => {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      setCssError(null);
      return;
    }
    const parsed = parseColorInput(trimmed);
    if (!parsed) {
      if (showErrorOnFail) {
        setCssError(
          vi
            ? 'Mã màu chưa hợp lệ. Hỗ trợ HEX (#rrggbb), rgb(...), hsl(...) và oklch(...).'
            : 'Invalid color syntax. Supports HEX (#rrggbb), rgb(...), hsl(...) and oklch(...).',
        );
      }
      return;
    }
    setCssError(null);
    setCssInput('');
    updateActiveStopColor(parsed.hex, parsed.alpha, parsed.oklch);
  };

  // 2D Focal Pad interactions
  const computeFocalCoords = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = focalPadRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return { x: 50, y: 50 };
    return {
      x: Math.round(clamp(((clientX - rect.left) / rect.width) * 100, 0, 100)),
      y: Math.round(clamp(((clientY - rect.top) / rect.height) * 100, 0, 100)),
    };
  };

  const handleFocalPadPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.closest('button')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingFocalModeRef.current = 'center';
    const { x, y } = computeFocalCoords(event.clientX, event.clientY);
    onChangeColor({ ...color, centerX: x, centerY: y });
  };

  const handleFocalPadPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const mode = draggingFocalModeRef.current;
    if (!mode) return;
    const { x, y } = computeFocalCoords(event.clientX, event.clientY);
    if (mode === 'center') {
      onChangeColor({ ...color, centerX: x, centerY: y });
    } else {
      updateStopById(mode.stopId, (stop) => ({ ...stop, x, y }));
    }
  };

  const handleFocalPadPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingFocalModeRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    draggingFocalModeRef.current = null;
  };

  const handleMeshDotPointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
    stopId: string,
  ) => {
    event.stopPropagation();
    setSelectedStopId(stopId);
    draggingFocalModeRef.current = { stopId };
    focalPadRef.current?.setPointerCapture(event.pointerId);
  };

  const handleFocalPadKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 2;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      updateColorField('centerX', clamp(Math.round(color.centerX - step), 0, 100));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      updateColorField('centerX', clamp(Math.round(color.centerX + step), 0, 100));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      updateColorField('centerY', clamp(Math.round(color.centerY - step), 0, 100));
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      updateColorField('centerY', clamp(Math.round(color.centerY + step), 0, 100));
    } else if (event.key === 'Home') {
      event.preventDefault();
      onChangeColor({ ...color, centerX: 50, centerY: 50 });
    }
  };

  const handleMeshDotKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    stop: ColorStop,
    coord: { x: number; y: number },
  ) => {
    const step = event.shiftKey ? 10 : 2;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      setSelectedStopId(stop.id);
      updateStopById(stop.id, (s) => ({ ...s, x: clamp(Math.round(coord.x - step), 0, 100), y: coord.y }));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      setSelectedStopId(stop.id);
      updateStopById(stop.id, (s) => ({ ...s, x: clamp(Math.round(coord.x + step), 0, 100), y: coord.y }));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      setSelectedStopId(stop.id);
      updateStopById(stop.id, (s) => ({ ...s, x: coord.x, y: clamp(Math.round(coord.y - step), 0, 100) }));
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      setSelectedStopId(stop.id);
      updateStopById(stop.id, (s) => ({ ...s, x: coord.x, y: clamp(Math.round(coord.y + step), 0, 100) }));
    } else if (event.key === 'Home') {
      event.preventDefault();
      event.stopPropagation();
      setSelectedStopId(stop.id);
      updateStopById(stop.id, (s) => ({ ...s, x: 50, y: 50 }));
    }
  };

  const resetHint = vi ? 'Nhấn đúp để đặt lại mặc định' : 'Double-click to reset to default';
  const activeMeshCoord = activeStop
    ? resolveMeshDisplayCoord(activeStop, activeIndex, color.stops.length)
    : { x: 50, y: 50 };

  const currentFormatReadout = useMemo(() => {
    if (!activeStop) return '';
    if (colorFormat === 'hex') return formatHex(activeStop.color).toUpperCase();
    if (colorFormat === 'rgb') return formatRgb(derivedRgb, activeStop.opacity);
    if (colorFormat === 'hsl') return formatHsl(derivedHsl, activeStop.opacity);
    return formatOklch(derivedOklch, activeStop.opacity);
  }, [activeStop, colorFormat, derivedHsl, derivedOklch, derivedRgb]);

  return (
    <>
      {/* 1. Multi-Stop Gradient Bar & Active Stop Multi-Format Editor */}
      <section
        className={styles.sectionCard}
        aria-label={vi ? 'Dải điểm màu đa sắc' : 'Multi-stop color gradient editor'}
      >
        <div className={styles.sectionHead}>
          <div>
            <h3 className={styles.sectionTitle}>
              {vi ? 'Điểm màu Gradient (2 đến 8 điểm)' : 'Gradient Color Stops (2 to 8)'}
            </h3>
            <p className={styles.sectionHint}>
              {vi
                ? 'Nhấn lên thanh màu để thêm điểm OKLCH mới, kéo chấm tròn để đổi vị trí tức thì.'
                : 'Click the bar to insert an OKLCH-interpolated stop, or drag pins horizontally.'}
            </p>
          </div>
          <span className={styles.themeCountPill}>
            {color.stops.length} / {MAX_STOPS}
          </span>
        </div>

        <div className={styles.stopEditor}>
          <div className={styles.stopBarWrap}>
            <div
              ref={trackRef}
              className={styles.stopBarTrack}
              onClick={handleTrackClick}
              title={
                color.stops.length < MAX_STOPS
                  ? vi
                    ? 'Nhấn để thêm điểm màu tại vị trí này'
                    : 'Click to add a color stop here'
                  : vi
                    ? 'Đã đạt tối đa 8 điểm màu'
                    : 'Maximum 8 stops reached'
              }
              data-testid="gradient-stop-bar"
            >
              <div
                className={styles.stopBarGradient}
                style={{ backgroundImage: stopBarGradientCss }}
                aria-hidden="true"
              />
              {color.stops.map((stop, idx) => {
                const isSelected = stop.id === activeStop?.id;
                const isDragging = draggingStopId === stop.id;
                const roundedPos = Math.round(stop.position);
                return (
                  <button
                    key={stop.id}
                    ref={(node) => {
                      if (node) {
                        pinRefs.current.set(stop.id, node);
                      } else {
                        pinRefs.current.delete(stop.id);
                      }
                    }}
                    type="button"
                    tabIndex={0}
                    role="slider"
                    aria-orientation="horizontal"
                    aria-label={
                      vi
                        ? `Điểm màu ${idx + 1} (${stop.color})`
                        : `Color stop ${idx + 1} (${stop.color})`
                    }
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={roundedPos}
                    aria-valuetext={`${roundedPos}%`}
                    className={`${styles.stopPin} ${isSelected ? styles.stopPinActive : ''} ${
                      isDragging ? styles.stopPinDragging : ''
                    }`}
                    style={
                      {
                        '--stop-pos': `${clamp(stop.position, 0, 100)}%`,
                        '--stop-color': stop.color,
                      } as React.CSSProperties
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedStopId(stop.id);
                    }}
                    onFocus={() => setSelectedStopId(stop.id)}
                    onPointerDown={(event) => handlePinPointerDown(event, stop.id)}
                    onPointerMove={(event) => handlePinPointerMove(event, stop.id)}
                    onPointerUp={(event) => handlePinPointerUp(event, stop.id)}
                    onPointerCancel={(event) => handlePinPointerUp(event, stop.id)}
                    onKeyDown={(event) => handlePinKeyDown(event, stop, idx)}
                    data-testid={`stop-pin-${idx}`}
                  />
                );
              })}
            </div>
          </div>

          {/* Clickable stop chip list */}
          <div className={styles.stopList} role="group" aria-label={vi ? 'Danh sách điểm màu' : 'Color stops list'}>
            {color.stops.map((stop, idx) => {
              const isSelected = stop.id === activeStop?.id;
              return (
                <button
                  key={stop.id}
                  type="button"
                  className={`${styles.stopChip} ${isSelected ? styles.stopChipActive : ''}`}
                  aria-pressed={isSelected}
                  onClick={() => setSelectedStopId(stop.id)}
                  data-testid={`stop-chip-${idx}`}
                >
                  <span
                    className={styles.stopChipSwatch}
                    style={{ backgroundColor: stop.color, opacity: Math.max(0.25, stop.opacity) }}
                    aria-hidden="true"
                  />
                  <span>#{idx + 1}</span>
                  <span>{Math.round(stop.position)}%</span>
                </button>
              );
            })}
          </div>

          {/* Stop list action buttons */}
          <div className={styles.stopActions}>
            <div className={styles.inlineRow}>
              <button
                type="button"
                className={styles.btnIcon}
                onClick={() => handleReorderStop(-1)}
                disabled={activeIndex <= 0}
                title={vi ? 'Đưa điểm màu lên trước' : 'Move stop earlier'}
                aria-label={vi ? 'Đưa điểm màu lên trước' : 'Move stop up'}
                data-testid="stop-move-up"
              >
                <ArrowUp size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={styles.btnIcon}
                onClick={() => handleReorderStop(1)}
                disabled={activeIndex >= color.stops.length - 1}
                title={vi ? 'Đưa điểm màu xuống sau' : 'Move stop later'}
                aria-label={vi ? 'Đưa điểm màu xuống sau' : 'Move stop down'}
                data-testid="stop-move-down"
              >
                <ArrowDown size={14} aria-hidden="true" />
              </button>
            </div>

            <div className={styles.inlineRow}>
              <button
                type="button"
                className={`${styles.btnSecondary} ${styles.btnSmall}`}
                onClick={handleAddStopButton}
                disabled={color.stops.length >= MAX_STOPS}
                data-testid="stop-add-btn"
              >
                <Plus size={13} aria-hidden="true" />
                <span>{vi ? 'Thêm điểm' : 'Add Stop'}</span>
              </button>
              <button
                type="button"
                className={`${styles.btnSecondary} ${styles.btnSmall}`}
                onClick={handleDuplicateStop}
                disabled={color.stops.length >= MAX_STOPS}
                data-testid="stop-duplicate-btn"
              >
                <Copy size={13} aria-hidden="true" />
                <span>{vi ? 'Nhân bản' : 'Duplicate'}</span>
              </button>
              <button
                type="button"
                className={`${styles.btnIcon} ${styles.btnIconDanger}`}
                onClick={handleRemoveStop}
                disabled={color.stops.length <= MIN_STOPS}
                title={
                  color.stops.length <= MIN_STOPS
                    ? vi
                      ? 'Cần ít nhất 2 điểm màu'
                      : 'At least 2 stops are required'
                    : vi
                      ? 'Xóa điểm màu đang chọn'
                      : 'Remove selected stop'
                }
                aria-label={vi ? 'Xóa điểm màu đang chọn' : 'Remove selected stop'}
                data-testid="stop-remove-btn"
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Active stop color inspector */}
          {activeStop && (
            <div className={styles.colorInspector} data-testid="active-stop-inspector">
              <div className={styles.colorSwatchRow}>
                <div className={styles.colorWell}>
                  <input
                    type="color"
                    className={styles.colorNativeInput}
                    value={activeStop.color}
                    onChange={(event) => updateActiveStopColor(event.target.value)}
                    aria-label={vi ? 'Chọn màu bằng bảng màu hệ thống' : 'Pick color natively'}
                    data-testid="stop-native-color-input"
                  />
                </div>

                <div className={styles.colorFormatCol}>
                  <div
                    className={styles.segmented}
                    role="tablist"
                    aria-label={vi ? 'Hệ màu chỉnh sửa' : 'Color space format'}
                  >
                    {COLOR_FORMAT_MODES.map((mode, idx) => (
                      <button
                        key={mode}
                        ref={(node) => {
                          formatTabRefs.current[mode] = node;
                        }}
                        id={`bg-color-format-tab-${mode}`}
                        type="button"
                        role="tab"
                        tabIndex={colorFormat === mode ? 0 : -1}
                        aria-selected={colorFormat === mode}
                        aria-controls="bg-color-format-panel"
                        className={`${styles.segmentBtn} ${
                          colorFormat === mode ? styles.segmentBtnActive : ''
                        }`}
                        onClick={() => setColorFormat(mode)}
                        onKeyDown={(event) => handleFormatTabKeyDown(event, idx)}
                        data-testid={`color-format-${mode}`}
                      >
                        {FORMAT_LABELS[mode]}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Format-specific editors */}
              <div
                role="tabpanel"
                id="bg-color-format-panel"
                aria-labelledby={`bg-color-format-tab-${colorFormat}`}
              >
              {colorFormat === 'hex' && (
                <div className={styles.channelField}>
                  <label htmlFor="bg-color-hex-input" className={styles.channelLabel}>
                    HEX (#RRGGBB)
                  </label>
                  <input
                    id="bg-color-hex-input"
                    type="text"
                    className={styles.channelInput}
                    value={hexDraft}
                    onChange={(event) => {
                      const val = event.target.value;
                      setHexDraft(val);
                      const parsed = parseColorInput(val);
                      if (parsed) {
                        updateActiveStopColor(parsed.hex, parsed.alpha, parsed.oklch);
                      }
                    }}
                    onBlur={() => setHexDraft(activeStop.color.toUpperCase())}
                    spellCheck={false}
                    data-testid="color-hex-input"
                  />
                </div>
              )}

              {colorFormat === 'rgb' && (
                <div className={styles.colorInputsGrid}>
                  {(
                    [
                      ['r', 'R', derivedRgb.r],
                      ['g', 'G', derivedRgb.g],
                      ['b', 'B', derivedRgb.b],
                    ] as const
                  ).map(([channel, label, value]) => (
                    <div key={channel} className={styles.channelField}>
                      <label htmlFor={`bg-rgb-${channel}`} className={styles.channelLabel}>
                        {label} (0-255)
                      </label>
                      <input
                        id={`bg-rgb-${channel}`}
                        type="number"
                        min={0}
                        max={255}
                        step={1}
                        className={styles.channelInput}
                        value={value}
                        onChange={(event) => {
                          const num = clamp(Number(event.target.value), 0, 255);
                          const nextRgb = { ...derivedRgb, [channel]: num };
                          updateActiveStopColor(rgbToHex(nextRgb));
                        }}
                        data-testid={`color-rgb-${channel}`}
                      />
                    </div>
                  ))}
                </div>
              )}

              {colorFormat === 'hsl' && (
                <div className={styles.colorInputsGrid}>
                  <div className={styles.channelField}>
                    <label htmlFor="bg-hsl-h" className={styles.channelLabel}>
                      H (0-360°)
                    </label>
                    <input
                      id="bg-hsl-h"
                      type="number"
                      min={0}
                      max={360}
                      step={1}
                      className={styles.channelInput}
                      value={Math.round(derivedHsl.h)}
                      onChange={(event) => {
                        const h = clamp(Number(event.target.value), 0, 360);
                        updateActiveStopColor(rgbToHex(hslToRgb({ ...derivedHsl, h })));
                      }}
                      data-testid="color-hsl-h"
                    />
                  </div>
                  <div className={styles.channelField}>
                    <label htmlFor="bg-hsl-s" className={styles.channelLabel}>
                      S (0-100%)
                    </label>
                    <input
                      id="bg-hsl-s"
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      className={styles.channelInput}
                      value={Math.round(derivedHsl.s)}
                      onChange={(event) => {
                        const s = clamp(Number(event.target.value), 0, 100);
                        updateActiveStopColor(rgbToHex(hslToRgb({ ...derivedHsl, s })));
                      }}
                      data-testid="color-hsl-s"
                    />
                  </div>
                  <div className={styles.channelField}>
                    <label htmlFor="bg-hsl-l" className={styles.channelLabel}>
                      L (0-100%)
                    </label>
                    <input
                      id="bg-hsl-l"
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      className={styles.channelInput}
                      value={Math.round(derivedHsl.l)}
                      onChange={(event) => {
                        const l = clamp(Number(event.target.value), 0, 100);
                        updateActiveStopColor(rgbToHex(hslToRgb({ ...derivedHsl, l })));
                      }}
                      data-testid="color-hsl-l"
                    />
                  </div>
                </div>
              )}

              {colorFormat === 'oklch' && (
                <div className={styles.colorInputsGrid}>
                  <div className={styles.channelField}>
                    <label htmlFor="bg-oklch-l" className={styles.channelLabel}>
                      L (0-1)
                    </label>
                    <input
                      id="bg-oklch-l"
                      type="number"
                      min={BG_BOUNDS.oklchL.min}
                      max={BG_BOUNDS.oklchL.max}
                      step={0.01}
                      className={styles.channelInput}
                      value={Number(derivedOklch.l.toFixed(3))}
                      onChange={(event) => {
                        const l = clamp(Number(event.target.value), 0, 1);
                        const nextOklch: OklchColor = { ...derivedOklch, l };
                        updateActiveStopColor(oklchToHex(nextOklch), undefined, nextOklch);
                      }}
                      data-testid="color-oklch-l"
                    />
                  </div>
                  <div className={styles.channelField}>
                    <label htmlFor="bg-oklch-c" className={styles.channelLabel}>
                      C (0-0.37)
                    </label>
                    <input
                      id="bg-oklch-c"
                      type="number"
                      min={BG_BOUNDS.oklchC.min}
                      max={BG_BOUNDS.oklchC.max}
                      step={0.005}
                      className={styles.channelInput}
                      value={Number(derivedOklch.c.toFixed(3))}
                      onChange={(event) => {
                        const c = clamp(Number(event.target.value), 0, 0.37);
                        const nextOklch: OklchColor = { ...derivedOklch, c };
                        updateActiveStopColor(oklchToHex(nextOklch), undefined, nextOklch);
                      }}
                      data-testid="color-oklch-c"
                    />
                  </div>
                  <div className={styles.channelField}>
                    <label htmlFor="bg-oklch-h" className={styles.channelLabel}>
                      H (0-360°)
                    </label>
                    <input
                      id="bg-oklch-h"
                      type="number"
                      min={BG_BOUNDS.oklchH.min}
                      max={BG_BOUNDS.oklchH.max}
                      step={1}
                      className={styles.channelInput}
                      value={Math.round(derivedOklch.h)}
                      onChange={(event) => {
                        const h = clamp(Number(event.target.value), 0, 360);
                        const nextOklch: OklchColor = { ...derivedOklch, h };
                        updateActiveStopColor(oklchToHex(nextOklch), undefined, nextOklch);
                      }}
                      data-testid="color-oklch-h"
                    />
                  </div>
                </div>
              )}
              </div>

              {/* Freeform CSS color paste/input */}
              <div className={styles.channelField}>
                <div className={styles.sliderHeader}>
                  <label htmlFor="bg-color-css-paste" className={styles.channelLabel}>
                    {vi ? 'Dán mã CSS bất kỳ (HEX, RGB, HSL, OKLCH)' : 'Paste any CSS color (HEX, RGB, HSL, OKLCH)'}
                  </label>
                  <span className={styles.sliderValuePill}>{currentFormatReadout}</span>
                </div>
                <div className={styles.saveForm}>
                  <input
                    id="bg-color-css-paste"
                    type="text"
                    className={styles.inputText}
                    value={cssInput}
                    onChange={(event) => {
                      const val = event.target.value;
                      setCssInput(val);
                      setCssError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        applyFreeformColor(cssInput, true);
                      } else if (event.key === 'Escape' && cssInput.length > 0) {
                        event.preventDefault();
                        event.stopPropagation();
                        setCssInput('');
                        setCssError(null);
                      }
                    }}
                    placeholder="oklch(0.62 0.14 218) · #2795b5"
                    spellCheck={false}
                    data-testid="color-css-paste-input"
                  />
                  <button
                    type="button"
                    className={`${styles.btnSecondary} ${styles.btnSmall}`}
                    onClick={() => applyFreeformColor(cssInput, true)}
                    disabled={!cssInput.trim()}
                    data-testid="color-css-paste-apply"
                  >
                    <Check size={13} aria-hidden="true" />
                    <span>{vi ? 'Áp dụng' : 'Apply'}</span>
                  </button>
                </div>
                {cssError && (
                  <p className={styles.inputError} role="alert" data-testid="color-css-error">
                    {cssError}
                  </p>
                )}
              </div>

              {/* Per-stop Position & Opacity sliders */}
              <div className={styles.sliderGridTwo}>
                <StudioSlider
                  id="bg-stop-position"
                  label={vi ? 'Vị trí điểm màu' : 'Stop Position'}
                  value={Math.round(activeStop.position)}
                  min={BG_BOUNDS.stopPosition.min}
                  max={BG_BOUNDS.stopPosition.max}
                  step={BG_BOUNDS.stopPosition.step}
                  defaultValue={defaultColor.stops[activeIndex]?.position ?? 50}
                  valueText={`${Math.round(activeStop.position)}%`}
                  onChange={(val) =>
                    updateStopById(activeStop.id, (stop) => ({ ...stop, position: val }))
                  }
                  testId="slider-stop-position"
                  resetHint={resetHint}
                />

                <StudioSlider
                  id="bg-stop-opacity"
                  label={vi ? 'Độ mờ điểm màu' : 'Stop Opacity'}
                  value={Math.round(activeStop.opacity * 100)}
                  min={0}
                  max={100}
                  step={1}
                  defaultValue={Math.round((defaultColor.stops[activeIndex]?.opacity ?? 1) * 100)}
                  valueText={`${Math.round(activeStop.opacity * 100)}%`}
                  onChange={(val) =>
                    updateStopById(activeStop.id, (stop) => ({
                      ...stop,
                      opacity: Math.round(val) / 100,
                    }))
                  }
                  testId="slider-stop-opacity"
                  resetHint={resetHint}
                />
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 2. Gradient Geometry, 2D Focal Pad, Blend Mode, and Layer Opacities */}
      <section
        className={styles.sectionCard}
        aria-label={vi ? 'Cấu trúc Gradient và hòa trộn lớp' : 'Gradient geometry and layer blending'}
      >
        <div className={styles.sectionHead}>
          <div>
            <h3 className={styles.sectionTitle}>
              {vi ? 'Kiểu Gradient và tâm điểm 2D' : 'Gradient Geometry and 2D Focal Pad'}
            </h3>
            <p className={styles.sectionHint}>
              {color.gradientType === 'mesh'
                ? vi
                  ? 'Kéo trực tiếp từng chấm màu để bố cục lưới lỏng, hoặc kéo nền để dời tâm.'
                  : 'Drag individual color nodes directly in Mesh mode, or drag the canvas for center.'
                : vi
                  ? 'Kéo trên bảng tọa độ để điều chỉnh tâm tỏa sáng X và Y.'
                  : 'Drag on the focal pad to steer the X and Y focal center.'}
            </p>
          </div>
        </div>

        <div
          className={styles.segmented}
          role="radiogroup"
          aria-label={vi ? 'Kiểu Gradient' : 'Gradient Type'}
        >
          {GRADIENT_TYPES.map((type, idx) => {
            const active = color.gradientType === type;
            return (
              <button
                key={type}
                ref={(node) => {
                  gradientTypeRefs.current[type] = node;
                }}
                type="button"
                role="radio"
                tabIndex={active ? 0 : -1}
                aria-checked={active}
                className={`${styles.segmentBtn} ${active ? styles.segmentBtnActive : ''}`}
                onClick={() => updateColorField('gradientType', type)}
                onKeyDown={(event) => handleGradientTypeKeyDown(event, idx)}
                data-testid={`gradient-type-${type}`}
              >
                {GRADIENT_LABELS[type][vi ? 'vi' : 'en']}
              </button>
            );
          })}
        </div>

        <div className={styles.focalPadRow}>
          <div
            ref={focalPadRef}
            className={styles.focalPad}
            style={
              {
                '--fx': `${clamp(color.centerX, 0, 100)}%`,
                '--fy': `${clamp(color.centerY, 0, 100)}%`,
              } as React.CSSProperties
            }
            onPointerDown={handleFocalPadPointerDown}
            onPointerMove={handleFocalPadPointerMove}
            onPointerUp={handleFocalPadPointerUp}
            onPointerCancel={handleFocalPadPointerUp}
          >
            <div
              tabIndex={0}
              role="slider"
              aria-roledescription={vi ? 'Bảng tọa độ 2D' : '2D focal pad'}
              aria-label={
                vi
                  ? 'Tâm Gradient 2D (dùng phím mũi tên để chỉnh X và Y)'
                  : '2D Gradient focal center (use arrow keys to adjust X and Y)'
              }
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(color.centerX)}
              aria-valuetext={`X ${Math.round(color.centerX)}%, Y ${Math.round(color.centerY)}%`}
              className={styles.focalPadTarget}
              onKeyDown={handleFocalPadKeyDown}
              data-testid="gradient-focal-pad"
            />
            <span className={styles.focalHandle} aria-hidden="true" />
            {color.gradientType === 'mesh' &&
              color.stops.map((stop, idx) => {
                const coord = resolveMeshDisplayCoord(stop, idx, color.stops.length);
                const isSelected = stop.id === activeStop?.id;
                return (
                  <button
                    key={stop.id}
                    type="button"
                    role="slider"
                    aria-roledescription={vi ? 'Điểm lưới 2D' : '2D mesh node'}
                    aria-label={
                      vi
                        ? `Tọa độ điểm màu ${idx + 1} (${stop.color})`
                        : `Mesh stop ${idx + 1} node (${stop.color})`
                    }
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={coord.x}
                    aria-valuetext={`X ${coord.x}%, Y ${coord.y}%`}
                    className={`${styles.focalStopDot} ${
                      isSelected ? styles.focalStopDotActive : ''
                    }`}
                    style={
                      {
                        '--fx': `${coord.x}%`,
                        '--fy': `${coord.y}%`,
                        '--stop-color': stop.color,
                      } as React.CSSProperties
                    }
                    onPointerDown={(event) => handleMeshDotPointerDown(event, stop.id)}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedStopId(stop.id);
                    }}
                    onFocus={() => setSelectedStopId(stop.id)}
                    onKeyDown={(event) => handleMeshDotKeyDown(event, stop, coord)}
                    data-testid={`mesh-node-${idx}`}
                  />
                );
              })}
            <span className={styles.focalCoords} aria-hidden="true">
              X {Math.round(color.centerX)} · Y {Math.round(color.centerY)}
            </span>
          </div>

          <div className={styles.sliderGrid}>
            <StudioSlider
              id="bg-center-x"
              label={vi ? 'Tâm ngang (Center X)' : 'Center X'}
              value={Math.round(color.centerX)}
              min={BG_BOUNDS.centerX.min}
              max={BG_BOUNDS.centerX.max}
              step={BG_BOUNDS.centerX.step}
              defaultValue={defaultColor.centerX}
              valueText={`${Math.round(color.centerX)}%`}
              onChange={(val) => updateColorField('centerX', val)}
              testId="slider-center-x"
              resetHint={resetHint}
            />
            <StudioSlider
              id="bg-center-y"
              label={vi ? 'Tâm dọc (Center Y)' : 'Center Y'}
              value={Math.round(color.centerY)}
              min={BG_BOUNDS.centerY.min}
              max={BG_BOUNDS.centerY.max}
              step={BG_BOUNDS.centerY.step}
              defaultValue={defaultColor.centerY}
              valueText={`${Math.round(color.centerY)}%`}
              onChange={(val) => updateColorField('centerY', val)}
              testId="slider-center-y"
              resetHint={resetHint}
            />
          </div>
        </div>

        {/* Active mesh node X/Y fine-tuning sliders when in mesh mode */}
        {color.gradientType === 'mesh' && activeStop && (
          <div className={styles.sliderGridTwo}>
            <StudioSlider
              id="bg-mesh-stop-x"
              label={vi ? `Điểm #${activeIndex + 1} — Vị trí X` : `Stop #${activeIndex + 1} Node X`}
              value={Math.round(activeMeshCoord.x)}
              min={BG_BOUNDS.stopX.min}
              max={BG_BOUNDS.stopX.max}
              step={BG_BOUNDS.stopX.step}
              defaultValue={defaultColor.stops[activeIndex]?.x ?? 50}
              valueText={`${Math.round(activeMeshCoord.x)}%`}
              onChange={(val) => updateStopById(activeStop.id, (stop) => ({ ...stop, x: val }))}
              testId="slider-mesh-stop-x"
              resetHint={resetHint}
            />
            <StudioSlider
              id="bg-mesh-stop-y"
              label={vi ? `Điểm #${activeIndex + 1} — Vị trí Y` : `Stop #${activeIndex + 1} Node Y`}
              value={Math.round(activeMeshCoord.y)}
              min={BG_BOUNDS.stopY.min}
              max={BG_BOUNDS.stopY.max}
              step={BG_BOUNDS.stopY.step}
              defaultValue={defaultColor.stops[activeIndex]?.y ?? 50}
              valueText={`${Math.round(activeMeshCoord.y)}%`}
              onChange={(val) => updateStopById(activeStop.id, (stop) => ({ ...stop, y: val }))}
              testId="slider-mesh-stop-y"
              resetHint={resetHint}
            />
          </div>
        )}

        <hr className={styles.sectionDivider} />

        {/* Blend Mode selector */}
        <div className={styles.channelField}>
          <span className={styles.sliderLabel}>
            {vi ? 'Chế độ hòa trộn lớp chiều sâu (Blend Mode)' : 'Depth Layer Blend Mode'}
          </span>
          <div
            className={styles.pillGrid}
            role="radiogroup"
            aria-label={vi ? 'Chế độ hòa trộn' : 'Blend mode'}
          >
            {BACKGROUND_BLEND_MODES.map((mode, idx) => {
              const active = color.blendMode === mode;
              return (
                <button
                  key={mode}
                  ref={(node) => {
                    blendModeRefs.current[mode] = node;
                  }}
                  type="button"
                  role="radio"
                  tabIndex={active ? 0 : -1}
                  aria-checked={active}
                  className={`${styles.pillOption} ${active ? styles.pillOptionActive : ''}`}
                  onClick={() => updateColorField('blendMode', mode)}
                  onKeyDown={(event) => handleBlendModeKeyDown(event, idx)}
                  data-testid={`blend-mode-${mode}`}
                >
                  {BLEND_MODE_LABELS[mode]}
                </button>
              );
            })}
          </div>
        </div>

        {/* Per-layer opacity sliders */}
        <div className={styles.sliderGridTwo}>
          <StudioSlider
            id="bg-base-layer-opacity"
            label={vi ? 'Độ mờ lớp nền (Base Layer)' : 'Base Layer Opacity'}
            value={Math.round(color.baseLayerOpacity)}
            min={BG_BOUNDS.baseLayerOpacity.min}
            max={BG_BOUNDS.baseLayerOpacity.max}
            step={BG_BOUNDS.baseLayerOpacity.step}
            defaultValue={defaultColor.baseLayerOpacity}
            valueText={`${Math.round(color.baseLayerOpacity)}%`}
            onChange={(val) => updateColorField('baseLayerOpacity', val)}
            testId="slider-base-layer-opacity"
            resetHint={resetHint}
          />
          <StudioSlider
            id="bg-depth-layer-opacity"
            label={vi ? 'Độ mờ lớp chiều sâu (Depth Layer)' : 'Depth Layer Opacity'}
            value={Math.round(color.depthLayerOpacity)}
            min={BG_BOUNDS.depthLayerOpacity.min}
            max={BG_BOUNDS.depthLayerOpacity.max}
            step={BG_BOUNDS.depthLayerOpacity.step}
            defaultValue={defaultColor.depthLayerOpacity}
            valueText={`${Math.round(color.depthLayerOpacity)}%`}
            onChange={(val) => updateColorField('depthLayerOpacity', val)}
            testId="slider-depth-layer-opacity"
            resetHint={resetHint}
          />
        </div>
      </section>

      {/* 3. All 10 Requested Optical and Gradient Sliders */}
      <section
        className={styles.sectionCard}
        aria-label={vi ? 'Quang học và sắc độ Gradient' : 'Optical grading and gradient tuning'}
      >
        <div className={styles.sectionHead}>
          <div>
            <h3 className={styles.sectionTitle}>
              {vi ? 'Quang học và Tinh chỉnh Gradient' : 'Optical and Gradient Tuning'}
            </h3>
            <p className={styles.sectionHint}>
              {vi
                ? 'Nhấn đúp bất kỳ thanh trượt nào để khôi phục nhanh về thông số gốc.'
                : 'Double-click any slider or value pill to snap back to its default value.'}
            </p>
          </div>
        </div>

        <div className={styles.sliderGridTwo}>
          {/* 1. Brightness */}
          <StudioSlider
            id="bg-opt-brightness"
            label={vi ? 'Độ sáng (Brightness)' : 'Brightness'}
            value={Math.round(color.brightness)}
            min={BG_BOUNDS.brightness.min}
            max={BG_BOUNDS.brightness.max}
            step={BG_BOUNDS.brightness.step}
            defaultValue={defaultColor.brightness}
            valueText={`${Math.round(color.brightness)}%`}
            minLabel="50%"
            maxLabel="150%"
            onChange={(val) => updateColorField('brightness', val)}
            testId="slider-brightness"
            resetHint={resetHint}
          />

          {/* 2. Saturation */}
          <StudioSlider
            id="bg-opt-saturation"
            label={vi ? 'Độ bão hòa (Saturation)' : 'Saturation'}
            value={Math.round(color.saturation)}
            min={BG_BOUNDS.saturation.min}
            max={BG_BOUNDS.saturation.max}
            step={BG_BOUNDS.saturation.step}
            defaultValue={defaultColor.saturation}
            valueText={`${Math.round(color.saturation)}%`}
            minLabel="0%"
            maxLabel="200%"
            onChange={(val) => updateColorField('saturation', val)}
            testId="slider-saturation"
            resetHint={resetHint}
          />

          {/* 3. Contrast */}
          <StudioSlider
            id="bg-opt-contrast"
            label={vi ? 'Độ tương phản (Contrast)' : 'Contrast'}
            value={Math.round(color.contrast)}
            min={BG_BOUNDS.contrast.min}
            max={BG_BOUNDS.contrast.max}
            step={BG_BOUNDS.contrast.step}
            defaultValue={defaultColor.contrast}
            valueText={`${Math.round(color.contrast)}%`}
            minLabel="60%"
            maxLabel="150%"
            onChange={(val) => updateColorField('contrast', val)}
            testId="slider-contrast"
            resetHint={resetHint}
          />

          {/* 4. Opacity */}
          <StudioSlider
            id="bg-opt-opacity"
            label={vi ? 'Độ trong suốt (Opacity)' : 'Opacity'}
            value={Math.round(color.opacity)}
            min={BG_BOUNDS.opacity.min}
            max={BG_BOUNDS.opacity.max}
            step={BG_BOUNDS.opacity.step}
            defaultValue={defaultColor.opacity}
            valueText={`${Math.round(color.opacity)}%`}
            minLabel="15%"
            maxLabel="100%"
            onChange={(val) => updateColorField('opacity', val)}
            testId="slider-opacity"
            resetHint={resetHint}
          />

          {/* 5. Blur */}
          <StudioSlider
            id="bg-opt-blur"
            label={vi ? 'Làm mờ mềm (Blur)' : 'Blur'}
            value={Math.round(color.blur)}
            min={BG_BOUNDS.blur.min}
            max={BG_BOUNDS.blur.max}
            step={BG_BOUNDS.blur.step}
            defaultValue={defaultColor.blur}
            valueText={`${Math.round(color.blur)} px`}
            minLabel="0 px"
            maxLabel="40 px"
            onChange={(val) => updateColorField('blur', val)}
            testId="slider-blur"
            resetHint={resetHint}
          />

          {/* 6. Glow */}
          <StudioSlider
            id="bg-opt-glow"
            label={vi ? 'Phát sáng (Glow)' : 'Glow'}
            value={Math.round(color.glow)}
            min={BG_BOUNDS.glow.min}
            max={BG_BOUNDS.glow.max}
            step={BG_BOUNDS.glow.step}
            defaultValue={defaultColor.glow}
            valueText={`${Math.round(color.glow)}%`}
            minLabel="0%"
            maxLabel="100%"
            onChange={(val) => updateColorField('glow', val)}
            testId="slider-glow"
            resetHint={resetHint}
          />

          {/* 7. Color Intensity */}
          <StudioSlider
            id="bg-opt-color-intensity"
            label={vi ? 'Cường độ màu (Color Intensity)' : 'Color Intensity'}
            value={Math.round(color.colorIntensity)}
            min={BG_BOUNDS.colorIntensity.min}
            max={BG_BOUNDS.colorIntensity.max}
            step={BG_BOUNDS.colorIntensity.step}
            defaultValue={defaultColor.colorIntensity}
            valueText={`${Math.round(color.colorIntensity)}%`}
            minLabel="0%"
            maxLabel="100%"
            onChange={(val) => updateColorField('colorIntensity', val)}
            testId="slider-color-intensity"
            resetHint={resetHint}
          />

          {/* 8. Gradient Spread */}
          <StudioSlider
            id="bg-opt-gradient-spread"
            label={vi ? 'Độ lan màu (Gradient Spread)' : 'Gradient Spread'}
            value={Math.round(color.gradientSpread)}
            min={BG_BOUNDS.gradientSpread.min}
            max={BG_BOUNDS.gradientSpread.max}
            step={BG_BOUNDS.gradientSpread.step}
            defaultValue={defaultColor.gradientSpread}
            valueText={`${Math.round(color.gradientSpread)}%`}
            minLabel="10%"
            maxLabel="100%"
            onChange={(val) => updateColorField('gradientSpread', val)}
            testId="slider-gradient-spread"
            resetHint={resetHint}
          />

          {/* 9. Gradient Angle */}
          <StudioSlider
            id="bg-opt-gradient-angle"
            label={vi ? 'Góc chuyển màu (Gradient Angle)' : 'Gradient Angle'}
            value={Math.round(color.gradientAngle)}
            min={BG_BOUNDS.gradientAngle.min}
            max={BG_BOUNDS.gradientAngle.max}
            step={BG_BOUNDS.gradientAngle.step}
            defaultValue={defaultColor.gradientAngle}
            valueText={`${Math.round(color.gradientAngle)}°`}
            minLabel="0°"
            maxLabel="360°"
            onChange={(val) => updateColorField('gradientAngle', val)}
            testId="slider-gradient-angle"
            resetHint={resetHint}
          />

          {/* 10. Blend Intensity */}
          <StudioSlider
            id="bg-opt-blend-intensity"
            label={vi ? 'Cường độ hòa trộn (Blend Intensity)' : 'Blend Intensity'}
            value={Math.round(color.blendIntensity)}
            min={BG_BOUNDS.blendIntensity.min}
            max={BG_BOUNDS.blendIntensity.max}
            step={BG_BOUNDS.blendIntensity.step}
            defaultValue={defaultColor.blendIntensity}
            valueText={`${Math.round(color.blendIntensity)}%`}
            minLabel="0%"
            maxLabel="100%"
            onChange={(val) => updateColorField('blendIntensity', val)}
            testId="slider-blend-intensity"
            resetHint={resetHint}
          />
        </div>

        <hr className={styles.sectionDivider} />

        <StudioSlider
          id="bg-opt-grain"
          label={vi ? 'Hạt mịn chống dải màu (Film Grain)' : 'Anti-Banding Film Grain'}
          value={Math.round(grainOpacity)}
          min={BG_BOUNDS.grainOpacity.min}
          max={BG_BOUNDS.grainOpacity.max}
          step={BG_BOUNDS.grainOpacity.step}
          defaultValue={defaultGrainOpacity}
          valueText={`${Math.round(grainOpacity)}%`}
          minLabel="0%"
          maxLabel="100%"
          onChange={onChangeGrainOpacity}
          testId="slider-grain-opacity"
          resetHint={resetHint}
        />
      </section>
    </>
  );
}
