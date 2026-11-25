/**
 * Canonical type definitions, numeric bounds, and effect-compatibility rules for
 * Echo Background Studio.
 *
 * Single source of truth shared across color science, presets, CSS renderer,
 * motion layers, React inspector UI, local storage, and backend persistence
 * (`BackgroundPreferenceValidator`).
 */

/** Schema version persisted to PostgreSQL (`public.user_background_preferences`). */
export const BG_STUDIO_SCHEMA_VERSION = 1 as const;

/** Maximum number of user-saved custom themes per account. */
export const MAX_CUSTOM_THEMES = 40 as const;

/** Maximum number of favorited built-in preset IDs per account. */
export const MAX_FAVORITE_PRESETS = 32 as const;

/** Minimum number of gradient color stops allowed in any theme. */
export const MIN_STOPS = 2 as const;

/** Maximum number of gradient color stops allowed in any theme. */
export const MAX_STOPS = 8 as const;

/** Minimum number of selected motion/light effects (`['static']` counts as 1). */
export const MIN_EFFECTS = 1 as const;

/** Maximum number of concurrent motion/light effects allowed by schema. */
export const MAX_EFFECTS = 6 as const;

/** Maximum trimmed character length for custom theme names. */
export const MAX_THEME_NAME_LENGTH = 60 as const;

/** Strict allowlist pattern matching backend `BackgroundPreferenceValidator` IDs. */
export const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Canonical 6-digit hexadecimal color pattern (`#rrggbb`). */
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Supported gradient geometry families. */
export const GRADIENT_TYPES = ['linear', 'radial', 'conic', 'mesh'] as const;
export type GradientType = (typeof GRADIENT_TYPES)[number];

/** Allowlisted CSS mix-blend-mode values for the harmonic depth layer. */
export const BACKGROUND_BLEND_MODES = [
  'normal',
  'screen',
  'overlay',
  'soft-light',
  'color-dodge',
  'lighten',
  'multiply',
] as const;
export type BackgroundBlendMode = (typeof BACKGROUND_BLEND_MODES)[number];

/** Allowlisted GPU-composited motion, light, and iridescence effect identifiers. */
export const BACKGROUND_EFFECT_IDS = [
  'static',
  'color-flow',
  'aurora',
  'liquid-flow',
  'pearl-shimmer',
  'ambient-glow',
  'light-drift',
  'color-breathing',
  'gradient-morph',
] as const;
export type BackgroundEffectId = (typeof BACKGROUND_EFFECT_IDS)[number];

/** Performance tier controlling layer density, blur budget, and motion damping. */
export const PERFORMANCE_MODES = ['auto', 'high', 'eco'] as const;
export type PerformanceMode = (typeof PERFORMANCE_MODES)[number];

/** Curated preset gallery categories. */
export const PRESET_CATEGORIES = ['abyss', 'aurora', 'crystal', 'dream', 'botanical'] as const;
export type BackgroundPresetCategory = (typeof PRESET_CATEGORIES)[number];

/** Active preference source recorded in `BackgroundPreferencesState`. */
export const BACKGROUND_ACTIVE_SOURCES = ['none', 'preset', 'custom'] as const;
export type BackgroundActiveSource = (typeof BACKGROUND_ACTIVE_SOURCES)[number];

/** Supported interactive color editor representations. */
export const COLOR_FORMAT_MODES = ['hex', 'rgb', 'hsl', 'oklch'] as const;
export type ColorFormatMode = (typeof COLOR_FORMAT_MODES)[number];

/** Inclusive numeric slider specification shared by validators and UI controls. */
export interface NumericBound {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;
}

/**
 * Canonical numeric bounds for every Echo Background Studio parameter.
 * Matches backend `BackgroundPreferenceValidator` 1-to-1.
 */
export const BG_BOUNDS = {
  // Gradient color stop bounds
  stopPosition: { min: 0, max: 100, step: 1, default: 50 },
  stopOpacity: { min: 0, max: 1, step: 0.01, default: 1 },
  stopX: { min: 0, max: 100, step: 1, default: 50 },
  stopY: { min: 0, max: 100, step: 1, default: 50 },

  // Color and optical composition bounds
  gradientAngle: { min: 0, max: 360, step: 1, default: 135 },
  centerX: { min: 0, max: 100, step: 1, default: 50 },
  centerY: { min: 0, max: 100, step: 1, default: 50 },
  gradientSpread: { min: 10, max: 100, step: 1, default: 72 },
  blendIntensity: { min: 0, max: 100, step: 1, default: 55 },
  baseLayerOpacity: { min: 0, max: 100, step: 1, default: 100 },
  depthLayerOpacity: { min: 0, max: 100, step: 1, default: 68 },
  brightness: { min: 50, max: 150, step: 1, default: 100 },
  saturation: { min: 0, max: 200, step: 1, default: 108 },
  contrast: { min: 60, max: 150, step: 1, default: 102 },
  opacity: { min: 15, max: 100, step: 1, default: 100 },
  blur: { min: 0, max: 40, step: 1, default: 0 },
  glow: { min: 0, max: 100, step: 1, default: 42 },
  colorIntensity: { min: 0, max: 100, step: 1, default: 80 },

  // Motion and light dynamics bounds
  animationSpeed: { min: 0.1, max: 2.5, step: 0.05, default: 0.85 },
  motionIntensity: { min: 0, max: 100, step: 1, default: 55 },
  lightIntensity: { min: 0, max: 100, step: 1, default: 52 },
  movementDirection: { min: 0, max: 360, step: 1, default: 120 },
  movementScale: { min: 20, max: 200, step: 1, default: 100 },
  glowRadius: { min: 10, max: 100, step: 1, default: 58 },
  shimmerIntensity: { min: 0, max: 100, step: 1, default: 45 },
  animationSmoothness: { min: 0, max: 100, step: 1, default: 82 },

  // Anti-banding film grain overlay
  grainOpacity: { min: 0, max: 100, step: 1, default: 18 },

  // Perceptual OKLCH slider bounds
  oklchL: { min: 0, max: 1, step: 0.005, default: 0.55 },
  oklchC: { min: 0, max: 0.37, step: 0.002, default: 0.14 },
  oklchH: { min: 0, max: 360, step: 1, default: 220 },
} as const satisfies Record<string, NumericBound>;

/** 8-bit sRGB color triple (`0..255` integer channels). */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** Standard cylindrical HSL representation (`h: 0..360`, `s: 0..100`, `l: 0..100`). */
export interface HslColor {
  h: number;
  s: number;
  l: number;
}

/** Björn Ottosson OKLab perceptual coordinates (`L: 0..1`, `a`, `b`). */
export interface OklabColor {
  L: number;
  a: number;
  b: number;
}

/** Björn Ottosson cylindrical OKLCH coordinates (`l: 0..1`, `c: 0..0.37`, `h: 0..360`). */
export interface OklchColor {
  l: number;
  c: number;
  h: number;
}

/** Unified color parsing output across HEX, RGB, HSL, and OKLCH formats. */
export interface ParsedColor {
  /** Canonical lowercase `#rrggbb` hex string. */
  hex: string;
  rgb: RgbColor;
  hsl: HslColor;
  oklch: OklchColor;
  /** Optional parsed alpha channel (`0..1`) if supplied in the input string. */
  alpha?: number;
}

/** WCAG 2.1 luminance and text-readability estimate for a background composition. */
export interface BackgroundLuminanceReport {
  /** Estimated composite WCAG 2.1 relative luminance (`0..1`). */
  luminance: number;
  /** WCAG 2.1 contrast ratio against crisp light foreground text (`#f8fafc`). */
  contrastLightText: number;
  /** WCAG 2.1 contrast ratio against deep dark foreground text (`#0d1830`). */
  contrastDarkText: number;
  /** Overall readability verdict (`excellent` >= 7:1, `good` >= 4.5:1, else `caution`). */
  readability: 'excellent' | 'good' | 'caution';
  /** Recommended UI surface polarity (`dark` = dark glass with light ink; `light` = pearl with dark ink). */
  recommendedSurface: 'dark' | 'light';
}

/** Individual color stop in a gradient or liquid mesh composition. */
export interface ColorStop {
  /** Stable identifier (`^[a-z0-9][a-z0-9_-]{0,63}$`). */
  id: string;
  /** Canonical 6-digit hexadecimal color (`#rrggbb`). */
  color: string;
  /** Linear/radial/conic stop position percentage (`0..100`). */
  position: number;
  /** Stop opacity (`0..1`). */
  opacity: number;
  /** Optional horizontal focal coordinate (`0..100`) used by mesh gradients. */
  x?: number;
  /** Optional vertical focal coordinate (`0..100`) used by mesh gradients. */
  y?: number;
}

/** Color, geometry, layering, and optical post-processing configuration. */
export interface BackgroundColorConfig {
  gradientType: GradientType;
  stops: ColorStop[];
  /** Angle in degrees (`0..360`). */
  gradientAngle: number;
  /** Horizontal focal center percentage (`0..100`). */
  centerX: number;
  /** Vertical focal center percentage (`0..100`). */
  centerY: number;
  /** Gradient spread / lobe radius percentage (`10..100`). */
  gradientSpread: number;
  blendMode: BackgroundBlendMode;
  /** Depth/blend compositing strength (`0..100`). */
  blendIntensity: number;
  /** Base gradient plane opacity percentage (`0..100`). */
  baseLayerOpacity: number;
  /** Secondary harmonic depth plane opacity percentage (`0..100`). */
  depthLayerOpacity: number;
  /** Optical brightness percentage (`50..150`). */
  brightness: number;
  /** Optical saturation percentage (`0..200`). */
  saturation: number;
  /** Optical contrast percentage (`60..150`). */
  contrast: number;
  /** Overall master layer opacity percentage (`15..100`). */
  opacity: number;
  /** Base-layer atmospheric softness in px (`0..40`). */
  blur: number;
  /** Ambient halo intensity (`0..100`). */
  glow: number;
  /** Chromatic intensity scaling (`0..100`). */
  colorIntensity: number;
}

/** GPU-composited motion, atmospheric lighting, and performance configuration. */
export interface BackgroundMotionConfig {
  /** Selected effect identifiers (`1..6` allowlisted values; `static` is exclusive). */
  effects: BackgroundEffectId[];
  /** Global playback speed multiplier (`0.1..2.5`). */
  animationSpeed: number;
  /** Displacement and amplitude strength (`0..100`). */
  motionIntensity: number;
  /** Atmospheric illumination intensity (`0..100`). */
  lightIntensity: number;
  /** Primary motion drift bearing in degrees (`0..360`). */
  movementDirection: number;
  /** Spatial travel scale percentage (`20..200`). */
  movementScale: number;
  /** Soft halo spread percentage (`10..100`). */
  glowRadius: number;
  /** Pearlescent specular sheen intensity (`0..100`). */
  shimmerIntensity: number;
  /** Easing damping and temporal smoothness (`0..100`). */
  animationSmoothness: number;
  performanceMode: PerformanceMode;
}

/** Complete self-contained configuration for an Echo Background Studio theme. */
export interface BackgroundThemeConfig {
  color: BackgroundColorConfig;
  motion: BackgroundMotionConfig;
  /** Optional subtle anti-banding grain overlay strength (`0..100`). */
  grainOpacity?: number;
}

/** Curated built-in gallery preset definition. */
export interface BackgroundPreset {
  id: string;
  name: string;
  nameVi: string;
  taglineEn: string;
  taglineVi: string;
  category: BackgroundPresetCategory;
  /** Space-separated RGB triple (`"r g b"`) for `--eo-ambient` lighting harmony. */
  accentRgb: string;
  /** Canonical `#rrggbb` swatch accent color. */
  accentHex: string;
  config: BackgroundThemeConfig;
}

/** User-saved custom theme stored inside `BackgroundPreferencesState.customThemes`. */
export interface SavedBackgroundTheme {
  id: string;
  name: string;
  favorite: boolean;
  basedOnPresetId?: string | null;
  config: BackgroundThemeConfig;
  createdAt: string;
  updatedAt: string;
}

/** Account-scoped background studio state persisted via `/api/v1/users/me/background-preferences`. */
export interface BackgroundPreferencesState {
  schemaVersion: typeof BG_STUDIO_SCHEMA_VERSION;
  activeSource: BackgroundActiveSource;
  activeThemeId: string | null;
  activeConfig: BackgroundThemeConfig | null;
  favoritePresetIds: string[];
  customThemes: SavedBackgroundTheme[];
}

/** REST envelope returned by `GET` and `PUT /api/v1/users/me/background-preferences`. */
export interface BackgroundPreferencesResponse {
  schemaVersion: number;
  revision: number;
  state: BackgroundPreferencesState;
  updatedAt: string | null;
}

/** Metadata describing compatibility, GPU cost, and synergy for each motion/light effect. */
export interface EffectCompatibilityRule {
  readonly id: BackgroundEffectId;
  readonly category: 'still' | 'motion' | 'light' | 'iridescence';
  /** Relative compositor layer cost (`0` = still, `1` = single layer, `2` = multi-ribbon/orb). */
  readonly gpuCost: 0 | 1 | 2;
  /** True when the effect stays active in `eco` performance mode without layer dropping. */
  readonly ecoSafe: boolean;
  /** Effects that cannot be active at the same time as this effect. */
  readonly exclusiveWith: readonly BackgroundEffectId[];
  /** Recommended companion effects that layer harmoniously with this effect. */
  readonly recommendedWith: readonly BackgroundEffectId[];
}

const ANIMATED_EFFECT_IDS: readonly BackgroundEffectId[] = [
  'color-flow',
  'aurora',
  'liquid-flow',
  'pearl-shimmer',
  'ambient-glow',
  'light-drift',
  'color-breathing',
  'gradient-morph',
] as const;

/**
 * Compatibility and GPU-cost matrix for all Echo Background Studio effects.
 *
 * Key invariant: `'static'` is strictly mutually exclusive with every animated effect.
 * All animated effects may layer together up to `MAX_EFFECTS` (6), with 2-3 recommended
 * for atmospheric clarity and crisp 60 fps GPU compositing.
 */
export const EFFECT_COMPATIBILITY: Readonly<Record<BackgroundEffectId, EffectCompatibilityRule>> = {
  static: {
    id: 'static',
    category: 'still',
    gpuCost: 0,
    ecoSafe: true,
    exclusiveWith: ANIMATED_EFFECT_IDS,
    recommendedWith: [],
  },
  'color-flow': {
    id: 'color-flow',
    category: 'motion',
    gpuCost: 1,
    ecoSafe: true,
    exclusiveWith: ['static'],
    recommendedWith: ['ambient-glow', 'light-drift', 'pearl-shimmer'],
  },
  aurora: {
    id: 'aurora',
    category: 'motion',
    gpuCost: 2,
    ecoSafe: false,
    exclusiveWith: ['static'],
    recommendedWith: ['light-drift', 'color-breathing', 'ambient-glow'],
  },
  'liquid-flow': {
    id: 'liquid-flow',
    category: 'motion',
    gpuCost: 2,
    ecoSafe: false,
    exclusiveWith: ['static'],
    recommendedWith: ['ambient-glow', 'gradient-morph', 'pearl-shimmer'],
  },
  'pearl-shimmer': {
    id: 'pearl-shimmer',
    category: 'iridescence',
    gpuCost: 2,
    ecoSafe: true,
    exclusiveWith: ['static'],
    recommendedWith: ['ambient-glow', 'light-drift', 'color-breathing'],
  },
  'ambient-glow': {
    id: 'ambient-glow',
    category: 'light',
    gpuCost: 1,
    ecoSafe: true,
    exclusiveWith: ['static'],
    recommendedWith: ['pearl-shimmer', 'light-drift', 'liquid-flow'],
  },
  'light-drift': {
    id: 'light-drift',
    category: 'light',
    gpuCost: 1,
    ecoSafe: true,
    exclusiveWith: ['static'],
    recommendedWith: ['aurora', 'pearl-shimmer', 'color-breathing'],
  },
  'color-breathing': {
    id: 'color-breathing',
    category: 'light',
    gpuCost: 1,
    ecoSafe: true,
    exclusiveWith: ['static'],
    recommendedWith: ['aurora', 'ambient-glow', 'pearl-shimmer'],
  },
  'gradient-morph': {
    id: 'gradient-morph',
    category: 'iridescence',
    gpuCost: 1,
    ecoSafe: true,
    exclusiveWith: ['static'],
    recommendedWith: ['liquid-flow', 'color-breathing', 'ambient-glow'],
  },
} as const;

/** Soft UI recommendation for simultaneous animated effects before visual clutter. */
export const RECOMMENDED_MAX_ACTIVE_EFFECTS = 4 as const;

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

const GRADIENT_TYPE_SET: ReadonlySet<string> = new Set(GRADIENT_TYPES);
const BLEND_MODE_SET: ReadonlySet<string> = new Set(BACKGROUND_BLEND_MODES);
const EFFECT_ID_SET: ReadonlySet<string> = new Set(BACKGROUND_EFFECT_IDS);
const PERFORMANCE_MODE_SET: ReadonlySet<string> = new Set(PERFORMANCE_MODES);
const PRESET_CATEGORY_SET: ReadonlySet<string> = new Set(PRESET_CATEGORIES);
const ACTIVE_SOURCE_SET: ReadonlySet<string> = new Set(BACKGROUND_ACTIVE_SOURCES);

export function isGradientType(value: unknown): value is GradientType {
  return typeof value === 'string' && GRADIENT_TYPE_SET.has(value);
}

export function isBackgroundBlendMode(value: unknown): value is BackgroundBlendMode {
  return typeof value === 'string' && BLEND_MODE_SET.has(value);
}

export function isBackgroundEffectId(value: unknown): value is BackgroundEffectId {
  return typeof value === 'string' && EFFECT_ID_SET.has(value);
}

export function isPerformanceMode(value: unknown): value is PerformanceMode {
  return typeof value === 'string' && PERFORMANCE_MODE_SET.has(value);
}

export function isBackgroundPresetCategory(value: unknown): value is BackgroundPresetCategory {
  return typeof value === 'string' && PRESET_CATEGORY_SET.has(value);
}

export function isBackgroundActiveSource(value: unknown): value is BackgroundActiveSource {
  return typeof value === 'string' && ACTIVE_SOURCE_SET.has(value);
}

// ---------------------------------------------------------------------------
// Effect Compatibility & State Helpers
// ---------------------------------------------------------------------------

/** Returns true if two effects may coexist in the same configuration. */
export function areEffectsCompatible(a: BackgroundEffectId, b: BackgroundEffectId): boolean {
  if (a === b) return true;
  return !EFFECT_COMPATIBILITY[a].exclusiveWith.includes(b);
}

/** Returns true when a selection represents a still (zero-motion) composition. */
export function isStaticOnlyEffects(effects: readonly BackgroundEffectId[]): boolean {
  return effects.length === 0 || (effects.length === 1 && effects[0] === 'static');
}

/**
 * Normalizes an arbitrary effect list to guarantee schema invariants:
 * - Only allowlisted IDs are retained.
 * - Duplicates are removed while preserving order.
 * - If any animated effect is present alongside `'static'`, `'static'` is stripped.
 * - Empty selections fall back to `['static']`.
 * - Output length is clamped to `MIN_EFFECTS..MAX_EFFECTS` (`1..6`).
 */
export function normalizeEffectSelection(
  effects: readonly unknown[],
): BackgroundEffectId[] {
  const unique: BackgroundEffectId[] = [];
  for (const item of effects) {
    if (isBackgroundEffectId(item) && !unique.includes(item)) {
      unique.push(item);
    }
  }
  const animated = unique.filter((id) => id !== 'static');
  if (animated.length === 0) {
    return ['static'];
  }
  return animated.slice(0, MAX_EFFECTS);
}

/**
 * Toggles a single effect inside a user's active selection while enforcing
 * `'static'` exclusivity and the `MAX_EFFECTS` ceiling.
 */
export function toggleEffectSelection(
  current: readonly BackgroundEffectId[],
  target: BackgroundEffectId,
): BackgroundEffectId[] {
  if (target === 'static') {
    return ['static'];
  }
  const normalized = normalizeEffectSelection(current).filter((id) => id !== 'static');
  const existingIndex = normalized.indexOf(target);
  if (existingIndex >= 0) {
    normalized.splice(existingIndex, 1);
    return normalized.length > 0 ? normalized : ['static'];
  }
  if (normalized.length >= MAX_EFFECTS) {
    return [...normalized.slice(1), target];
  }
  return [...normalized, target];
}

/**
 * Estimates relative GPU compositor cost for the currently selected effects.
 * Used by both UI hints and `eco` performance mode planning.
 */
export function estimateEffectsGpuBudget(effects: readonly BackgroundEffectId[]): {
  score: number;
  level: 'minimal' | 'balanced' | 'rich';
  activeAnimatedCount: number;
} {
  const normalized = normalizeEffectSelection(effects);
  const animated = normalized.filter((id) => id !== 'static');
  const score = animated.reduce((sum, id) => sum + EFFECT_COMPATIBILITY[id].gpuCost, 0);
  const level: 'minimal' | 'balanced' | 'rich' =
    score <= 2 ? 'minimal' : score <= 5 ? 'balanced' : 'rich';
  return {
    score,
    level,
    activeAnimatedCount: animated.length,
  };
}

/** Creates a fresh canonical empty preferences state matching backend defaults. */
export function createEmptyPreferencesState(): BackgroundPreferencesState {
  return {
    schemaVersion: BG_STUDIO_SCHEMA_VERSION,
    activeSource: 'none',
    activeThemeId: null,
    activeConfig: null,
    favoritePresetIds: [],
    customThemes: [],
  };
}
