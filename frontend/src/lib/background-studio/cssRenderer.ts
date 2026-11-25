/**
 * Pure TypeScript CSS graphics and perceptual OKLCH gradient compilation engine
 * for Echo Background Studio.
 *
 * Key visual engineering techniques:
 * 1. **Perceptual OKLCH Pre-Baked Sub-Stop Anti-Banding**:
 *    CSS Color 4 `in oklch` gradient interpolation is dropped outright by older
 *    Safari, Chromium, and Firefox builds, while default sRGB interpolation cuts
 *    through murky grey dead-zones between distant hues and exhibits 8-bit
 *    banding on wide displays. Instead, this compiler evaluates exact Björn
 *    Ottosson OKLCH intermediate stops (shortest hue arc + chroma-only gamut
 *    clipping via `colorScience.ts`) and bakes them into universal space-separated
 *    `rgb(r g b / a)` stops. Quarter-step sub-stops (`t = 0.25, 0.50, 0.75`) reduce
 *    perceptual chord error by 16x across every browser engine identically.
 * 2. **Same-RGB Zero-Alpha Feathering**:
 *    Transparent gradient skirts always emit `rgb(r g b / 0)` matching the stop's
 *    own RGB channels rather than the `transparent` keyword (`rgba(0,0,0,0)`),
 *    preventing dark halo fringes on luminous pearl, blush, and crystal themes.
 * 3. **Cubic Smoothstep Multi-Lobe Liquid Mesh**:
 *    Mesh mode composes a grounded deep canvas beneath N overlapping elliptical
 *    radial pools positioned at stop `(x, y)` coordinates, orbited smoothly by
 *    `gradientAngle`, steered by `(centerX, centerY)`, sized by `gradientSpread`,
 *    and feathered with a 5-point cosine/Hermite alpha bell + neighbor OKLCH blend.
 * 4. **Zero-Seam Conic Wrap and Pinched-Center Diffusion**:
 *    Conic gradients always reserve a smooth OKLCH return arc back to stop 0 at
 *    100% and place a soft central diffusion halo over `(centerX, centerY)` to
 *    melt the geometric pole singularity into a luminous core.
 * 5. **CSP-Safe Anti-Banding Film Grain**:
 *    `ANTI_BANDING_GRAIN_SVG` uses a lightweight 128x128 seamless `feTurbulence`
 *    `data:image/svg+xml` tile verified against `deploy/nginx/default.conf`
 *    (`img-src 'self' data: blob: https:`) and `frontend/src/proxy.ts` with zero
 *    network fetches, zero offscreen drawing surfaces, and zero live backdrop blur.
 */

import {
  BG_BOUNDS,
  EFFECT_COMPATIBILITY,
  isBackgroundBlendMode,
  isGradientType,
  normalizeEffectSelection,
  type BackgroundBlendMode,
  type BackgroundEffectId,
  type BackgroundThemeConfig,
  type ColorStop,
  type GradientType,
  type OklchColor,
  type RgbColor,
} from './types';
import {
  clipOklchToSrgbGamut,
  extractAmbientRgb,
  formatRgb,
  hexToOklch,
  hexToRgb,
  interpolateOklchColor,
  linearToSrgbChannel,
  maxSrgbChromaForLH,
  oklabToLinearSrgb,
  oklchToOklab,
} from './colorScience';

/**
 * Lightweight 128x128 seamless fractal-noise SVG tile used to dither subtle
 * 8-bit gradient banding on large high-contrast displays.
 *
 * CSP-verified against `deploy/nginx/default.conf` (`img-src 'self' data: blob: https:`).
 * Zero network fetches, zero external URLs, zero ampersands.
 */
export const ANTI_BANDING_GRAIN_SVG =
  'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'128\' height=\'128\' viewBox=\'0 0 128 128\'%3E%3Cfilter id=\'g\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.82\' numOctaves=\'3\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'128\' height=\'128\' filter=\'url(%23g)\' opacity=\'0.55\'/%3E%3C/svg%3E")';

/** Optional runtime rendering flags for `buildBackgroundStyleVars`. */
export interface BackgroundRenderOptions {
  /** Disables motion layers and pauses animation when user prefers reduced motion. */
  reducedMotion?: boolean;
  /** Forces eco/low-power compositor budget (max 1 animated effect, no blur, no grain). */
  lowPower?: boolean;
  /** Compact thumbnail/card mode (1 perceptual midpoint per span, no blur, no grain). */
  compact?: boolean;
  /**
   * When true (used by `<BackgroundThemeLayer />`), compiles and emits CSS variables
   * only for layers that will actually mount in the DOM, cutting inline style payload
   * and slider drag CPU cost without altering any visible pixel. Defaults to false.
   */
  activeOnly?: boolean;
}

/**
 * Complete CSS variable map and metadata produced by `buildBackgroundStyleVars`.
 * Maps 1-to-1 to `BackgroundThemeLayer.tsx` and `BackgroundThemeLayer.module.css`.
 */
export interface BackgroundRenderPlan {
  /** Complete `--ec-bg-*` CSS custom property map ready for inline `style`. */
  styleVars: Record<string, string>;
  /** Effective animated effects after applying `static`, `reducedMotion`, and `eco` budgets. */
  activeEffects: BackgroundEffectId[];
  /** True when all motion layers are suppressed (still presentation). */
  isStatic: boolean;
  /** True when eco/low-power compositor safeguards are active. */
  isEco: boolean;
  /** True when the anti-banding grain tile should be mounted. */
  hasGrain: boolean;
  /** True when static optical glow should render if animated `ambient-glow` is not active. */
  hasStaticGlow: boolean;
  /** Sanitized CSS `mix-blend-mode` applied to the harmonic depth plane. */
  blendMode: BackgroundBlendMode;

  // Direct compiled CSS expressions (shared with tests and diagnostics)
  baseColor: string;
  baseGradient: string;
  depthGradient: string;
  colorFlowGradient: string;
  auroraCurtainA: string;
  auroraCurtainB: string;
  liquidOrbA: string;
  liquidOrbB: string;
  liquidOrbC: string;
  pearlSheenGradient: string;
  ambientGlowGradient: string;
  driftLightGradient: string;
  driftLightGradientB: string;
  breathingVeilGradient: string;
  morphGradient: string;
  cssFilterString: string;
  ambientRgb: string;
  previewSwatch: string;
}

interface ResolvedStop {
  id: string;
  rgb: RgbColor;
  lch: OklchColor;
  position: number;
  opacity: number;
  x?: number;
  y?: number;
}

const GOLDEN_ANGLE_RAD = 2.399963229728653;

const FALLBACK_STOPS: readonly ColorStop[] = [
  { id: 'fallback-1', color: '#071028', position: 0, opacity: 1, x: 20, y: 80 },
  { id: 'fallback-2', color: '#1b4965', position: 52, opacity: 0.96, x: 54, y: 42 },
  { id: 'fallback-3', color: '#58b4d1', position: 100, opacity: 0.92, x: 82, y: 20 },
];

// ---------------------------------------------------------------------------
// Numeric, Angle, and Color Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function normalizeAngle(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped === 360 || Object.is(wrapped, -0) ? 0 : wrapped;
}

function fmt(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '0';
  const factor =
    decimals === 1
      ? 10
      : decimals === 2
        ? 100
        : decimals === 3
          ? 1000
          : decimals === 4
            ? 10000
            : 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? '0' : String(rounded);
}

function pct(value: number, decimals = 1): string {
  return `${fmt(value, decimals)}%`;
}

function deg(value: number, decimals = 1): string {
  return `${fmt(normalizeAngle(value), decimals)}deg`;
}

/**
 * Fast O(1) sRGB gamut probe for an OKLCH triple. Used to bypass binary-search
 * `maxSrgbChromaForLH` when a lifted chroma is already strictly inside the sRGB cusp.
 */
function isOklchInSrgbGamut(l: number, c: number, h: number): boolean {
  if (l <= 0 || l >= 1) return c <= 0;
  if (c <= 0) return true;
  const lin = oklabToLinearSrgb(oklchToOklab({ l, c, h }));
  return lin.r >= 0 && lin.r <= 1 && lin.g >= 0 && lin.g <= 1 && lin.b >= 0 && lin.b <= 1;
}

/**
 * Converts an already gamut-clipped OKLCH color to 8-bit sRGB without re-running
 * `clipOklchToSrgbGamut` (eliminating duplicate trig and gamut checks on hot paths).
 */
function oklchToRgbClipped(lch: OklchColor): RgbColor {
  const lin = oklabToLinearSrgb(oklchToOklab(lch));
  return {
    r: Math.round(clamp(linearToSrgbChannel(clamp(lin.r, 0, 1)) * 255, 0, 255)),
    g: Math.round(clamp(linearToSrgbChannel(clamp(lin.g, 0, 1)) * 255, 0, 255)),
    b: Math.round(clamp(linearToSrgbChannel(clamp(lin.b, 0, 1)) * 255, 0, 255)),
  };
}

/**
 * Formats an RGB triple with an explicit alpha channel, always preserving the
 * RGB channels even at `alpha === 0` (`rgb(r g b / 0)`) to avoid grey/dark
 * fringes around transparent gradient edges.
 */
function rgbWithAlpha(rgb: RgbColor, alpha: number): string {
  const r = Math.round(clamp(rgb.r, 0, 255));
  const g = Math.round(clamp(rgb.g, 0, 255));
  const b = Math.round(clamp(rgb.b, 0, 255));
  const a = clamp(alpha, 0, 1);
  if (a >= 0.999) {
    return `rgb(${r} ${g} ${b})`;
  }
  if (a <= 0.0005) {
    return `rgb(${r} ${g} ${b} / 0)`;
  }
  return `rgb(${r} ${g} ${b} / ${fmt(a, 3)})`;
}

function oklchToCssRgb(lch: OklchColor, alpha = 1): string {
  return rgbWithAlpha(oklchToRgbClipped(lch), alpha);
}

/**
 * Maps `colorIntensity` (`0..100`) to an OKLCH chroma multiplier centered at
 * `1.0` for the canonical default (`80`):
 * - `0`   -> `0.15` (serene muted mist)
 * - `80`  -> `1.00` (exact 1:1 fidelity to curated preset stops)
 * - `100` -> `1.22` (vivid jewel lift, safely gamut-clipped in OKLCH)
 */
function colorIntensityChromaScale(intensity: number): number {
  const v = clamp(intensity, BG_BOUNDS.colorIntensity.min, BG_BOUNDS.colorIntensity.max);
  if (v <= 80) {
    return 0.15 + (v / 80) * 0.85;
  }
  return 1 + ((v - 80) / 20) * 0.22;
}

/**
 * Resolves, sorts, and applies perceptual `colorIntensity` chroma scaling to a
 * stop list while preserving lightness and hue invariants via OKLCH clipping.
 */
function resolveStops(
  rawStops: readonly ColorStop[] | undefined,
  colorIntensity: number,
): ResolvedStop[] {
  const source =
    Array.isArray(rawStops) && rawStops.length >= 2 ? rawStops : FALLBACK_STOPS;
  const chromaScale = colorIntensityChromaScale(colorIntensity);
  const adjustChroma = Math.abs(chromaScale - 1) > 0.002;

  const indexed = source.map((stop, idx) => {
    const position = clamp(
      typeof stop.position === 'number' ? stop.position : (idx / Math.max(1, source.length - 1)) * 100,
      0,
      100,
    );
    const opacity = clamp(typeof stop.opacity === 'number' ? stop.opacity : 1, 0, 1);
    const baseLch = hexToOklch(stop.color);
    const tunedLch = adjustChroma
      ? clipOklchToSrgbGamut({
          l: baseLch.l,
          c: baseLch.c * chromaScale,
          h: baseLch.h,
        })
      : baseLch;
    const rgb = adjustChroma ? oklchToRgbClipped(tunedLch) : hexToRgb(stop.color);

    return {
      idx,
      stop: {
        id: stop.id || `stop-${idx + 1}`,
        rgb,
        lch: tunedLch,
        position,
        opacity,
        x: typeof stop.x === 'number' && Number.isFinite(stop.x) ? clamp(stop.x, 0, 100) : undefined,
        y: typeof stop.y === 'number' && Number.isFinite(stop.y) ? clamp(stop.y, 0, 100) : undefined,
      } satisfies ResolvedStop,
    };
  });

  indexed.sort((a, b) => a.stop.position - b.stop.position || a.idx - b.idx);
  return indexed.map((entry) => entry.stop);
}

/**
 * Derives harmonic OKLCH morph stops directly in OKLCH space without any
 * redundant hex encode/decode round-trip (exact parity with `deriveHarmonicMorphStops`).
 */
function deriveMorphedStopsDirect(stops: readonly ResolvedStop[]): ResolvedStop[] {
  const baseHueShift = 26;
  const lightnessPulse = 0.036;
  const chromaScale = 1.07;
  const count = Math.max(1, stops.length);

  return stops.map((stop, index) => {
    const progress = count > 1 ? index / (count - 1) : 0.5;
    const lch = stop.lch;

    const stopHueDelta = baseHueShift * (0.72 + progress * 0.56);
    const nextH = normalizeAngle(lch.h + stopHueDelta);

    const midBell = Math.sin(progress * Math.PI);
    const lDelta = lch.l < 0.2 ? lightnessPulse * 0.35 : lightnessPulse * (0.45 + 0.55 * midBell);
    const nextL = clamp(lch.l + (index % 2 === 0 ? lDelta : -lDelta * 0.45), 0.06, 0.94);

    let nextC: number;
    if (lch.c < 0.008) {
      nextC = isOklchInSrgbGamut(nextL, lch.c, nextH) ? lch.c : maxSrgbChromaForLH(nextL, nextH);
    } else {
      const targetC = lch.c * chromaScale;
      nextC = isOklchInSrgbGamut(nextL, targetC / 0.94, nextH)
        ? targetC
        : Math.min(targetC, maxSrgbChromaForLH(nextL, nextH) * 0.94);
    }

    const morphedLch: OklchColor = { l: nextL, c: nextC, h: nextH };
    const morphed: ResolvedStop = {
      id: stop.id,
      rgb: oklchToRgbClipped(morphedLch),
      lch: morphedLch,
      position: stop.position,
      opacity: stop.opacity,
    };

    if (stop.x !== undefined || stop.y !== undefined) {
      const orbit = (index * 1.618 + 0.6) * Math.PI;
      if (stop.x !== undefined) {
        morphed.x = Math.round(clamp(stop.x + Math.cos(orbit) * 9, 6, 94) * 10) / 10;
      }
      if (stop.y !== undefined) {
        morphed.y = Math.round(clamp(stop.y + Math.sin(orbit) * 9, 6, 94) * 10) / 10;
      }
    }

    return morphed;
  });
}

/**
 * Selects a grounded canvas base color beneath translucent layers and mesh pools.
 * Picks the deepest stop and gently anchors its luminance so edges stay rich.
 */
function deriveBaseCanvasColor(stops: readonly ResolvedStop[]): { rgb: RgbColor; lch: OklchColor; css: string } {
  let deepest = stops[0];
  for (let i = 1; i < stops.length; i += 1) {
    if (stops[i].lch.l < deepest.lch.l) {
      deepest = stops[i];
    }
  }
  // Keep airy light compositions (e.g. Rose Quartz / luminous crystal) airy, while deepening dark bases gently.
  const targetL = deepest.lch.l > 0.62 ? clamp(deepest.lch.l - 0.025, 0.55, 0.96) : clamp(deepest.lch.l * 0.92, 0.04, 0.62);
  const lch = clipOklchToSrgbGamut({
    l: targetL,
    c: deepest.lch.c * 0.92,
    h: deepest.lch.h,
  });
  const rgb = oklchToRgbClipped(lch);
  return { rgb, lch, css: formatRgb(rgb) };
}

/**
 * Picks up to `count` distinct chromatic/luminous hero stops from the palette
 * for atmospheric effects (aurora curtains, liquid orbs, ambient glow, drift lights).
 */
function pickLuminousStops(stops: readonly ResolvedStop[], count = 3): ResolvedStop[] {
  const scored = stops.map((stop, idx) => {
    const l = stop.lch.l;
    const c = stop.lch.c;
    // Favor luminous, chromatic stops without choosing pitch black anchors
    const lightBell = Math.exp(-(((l - 0.64) / 0.3) ** 2));
    const chromaBoost = 0.28 + c * 5.2;
    const score = lightBell * chromaBoost * (0.35 + stop.opacity * 0.65);
    return { stop, idx, score };
  });

  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);

  const chosen: ResolvedStop[] = [];
  for (const candidate of scored) {
    if (chosen.length >= count) break;
    chosen.push(candidate.stop);
  }
  while (chosen.length < count) {
    const fallback = stops[chosen.length % stops.length];
    chosen.push(fallback);
  }
  return chosen;
}

/**
 * Lifts a stop into a clean atmospheric glow color in OKLCH space while keeping
 * its hue authentic and chroma strictly inside the sRGB gamut.
 */
function tuneGlowOklch(
  source: OklchColor,
  opts: { minL: number; maxL: number; lShift?: number; hueShift?: number; chromaBoost?: number },
): OklchColor {
  const h = normalizeAngle(source.h + (opts.hueShift ?? 0));
  const l = clamp(source.l + (opts.lShift ?? 0), opts.minL, opts.maxL);
  if (source.c < 0.008) {
    const targetC = source.c * 0.8;
    return isOklchInSrgbGamut(l, targetC, h)
      ? { l, c: targetC, h }
      : { l, c: Math.min(targetC, maxSrgbChromaForLH(l, h)), h };
  }
  const targetC = source.c * (opts.chromaBoost ?? 1.08);
  if (isOklchInSrgbGamut(l, targetC / 0.94, h)) {
    return { l, c: targetC, h };
  }
  const ceiling = maxSrgbChromaForLH(l, h);
  return { l, c: Math.min(targetC, ceiling * 0.94), h };
}

// ---------------------------------------------------------------------------
// Perceptual OKLCH Sub-Stop Expansion (Zero Grey Dead-Zones, Anti-Banded)
// ---------------------------------------------------------------------------

/**
 * Expands sorted stops into a perceptual OKLCH-interpolated stop list formatted
 * in universal `rgb(r g b / a)`.
 *
 * `subdivisions = 3` bakes quarter-steps (`0.25, 0.50, 0.75`) for full-screen
 * planes (16x chord-error reduction); `subdivisions = 1` bakes midpoints (`0.50`)
 * for compact thumbnail swatches.
 */
function buildPerceptualStopList(
  stops: readonly ResolvedStop[],
  positions: readonly number[],
  subdivisions: 1 | 3,
): string {
  const entries: string[] = [];
  const stepFractions = subdivisions === 3 ? [0.25, 0.5, 0.75] : [0.5];

  for (let i = 0; i < stops.length; i += 1) {
    const curr = stops[i];
    const currPos = positions[i];
    entries.push(`${rgbWithAlpha(curr.rgb, curr.opacity)} ${pct(currPos, 2)}`);

    if (i < stops.length - 1) {
      const next = stops[i + 1];
      const nextPos = positions[i + 1];
      const posSpan = nextPos - currPos;
      if (posSpan <= 0.4) continue;

      for (const t of stepFractions) {
        const interpLch = interpolateOklchColor(curr.lch, next.lch, t);
        // Smoothstep-weighted alpha keeps translucent transitions silky
        const smoothT = t * t * (3 - 2 * t);
        const interpAlpha = curr.opacity + (next.opacity - curr.opacity) * smoothT;
        const interpPos = currPos + posSpan * t;
        entries.push(`${oklchToCssRgb(interpLch, interpAlpha)} ${pct(interpPos, 2)}`);
      }
    }
  }

  return entries.join(', ');
}

/**
 * Remaps user stop positions (`0..100`) using `gradientSpread` (`10..100`) around
 * the focal midpoint so lower spread tightens the color transition band and higher
 * spread opens into an ultra-soft atmospheric wash.
 */
function spreadStopPositions(
  stops: readonly ResolvedStop[],
  gradientSpread: number,
  focalBias = 50,
): number[] {
  const spread = clamp(gradientSpread, BG_BOUNDS.gradientSpread.min, BG_BOUNDS.gradientSpread.max);
  const spreadScale = 0.36 + (spread / 100) * 0.84; // 0.444 at 10 -> 1.00 at 76 -> 1.20 at 100
  const pivot = clamp(focalBias, 20, 80);

  return stops.map((stop) => {
    const mapped = pivot + (stop.position - 50) * spreadScale;
    return clamp(mapped, -8, 108);
  });
}

// ---------------------------------------------------------------------------
// Core 4 Gradient Compilers: Linear, Radial, Conic, Mesh
// ---------------------------------------------------------------------------

function compileLinearGradient(
  stops: readonly ResolvedStop[],
  angleExpr: string,
  gradientSpread: number,
  centerX: number,
  centerY: number,
  subdivisions: 1 | 3,
): string {
  const focalBias = 50 + ((centerX - 50) * 0.22 + (centerY - 50) * 0.22);
  const positions = spreadStopPositions(stops, gradientSpread, focalBias);
  const stopList = buildPerceptualStopList(stops, positions, subdivisions);
  return `linear-gradient(${angleExpr}, ${stopList})`;
}

function compileRadialGradient(
  stops: readonly ResolvedStop[],
  luminous: readonly ResolvedStop[],
  gradientAngle: number,
  centerX: number,
  centerY: number,
  gradientSpread: number,
  subdivisions: 1 | 3,
  compact: boolean,
): string {
  const spread = clamp(gradientSpread, BG_BOUNDS.gradientSpread.min, BG_BOUNDS.gradientSpread.max);
  const rx = 46 + spread * 0.92;
  const ry = 42 + spread * 0.84;

  // Radial stops stay inside 0..100% of the ellipse radius for smooth edge falloff
  const positions = stops.map((stop) => clamp(stop.position * (0.86 + (spread / 100) * 0.14), 0, 100));
  const stopList = buildPerceptualStopList(stops, positions, subdivisions);
  const mainRadial = `radial-gradient(ellipse ${pct(rx, 1)} ${pct(ry, 1)} at ${pct(centerX, 1)} ${pct(centerY, 1)}, ${stopList})`;

  if (compact) {
    return mainRadial;
  }

  // Subtle directional specular halo offset along gradientAngle adds optical depth
  const rad = (normalizeAngle(gradientAngle) * Math.PI) / 180;
  const specX = clamp(centerX + Math.sin(rad) * 10, 6, 94);
  const specY = clamp(centerY - Math.cos(rad) * 10, 6, 94);
  const hero = luminous[0];
  const specLch = tuneGlowOklch(hero.lch, { minL: 0.48, maxL: 0.9, lShift: 0.06, chromaBoost: 1.05 });
  const specRgb = oklchToRgbClipped(specLch);
  const specLayer = `radial-gradient(ellipse ${pct(rx * 0.56, 1)} ${pct(ry * 0.52, 1)} at ${pct(specX, 1)} ${pct(specY, 1)}, ${rgbWithAlpha(specRgb, 0.24 * hero.opacity)} 0%, ${rgbWithAlpha(specRgb, 0.09 * hero.opacity)} 48%, ${rgbWithAlpha(specRgb, 0)} 84%)`;

  return `${specLayer}, ${mainRadial}`;
}

function compileConicGradient(
  stops: readonly ResolvedStop[],
  angleExpr: string,
  centerX: number,
  centerY: number,
  gradientSpread: number,
  subdivisions: 1 | 3,
  compact: boolean,
): string {
  const spread = clamp(gradientSpread, BG_BOUNDS.gradientSpread.min, BG_BOUNDS.gradientSpread.max);
  // Reserve at least 16% of the circle for a silky OKLCH wrap-back to stop 0 (zero 0deg/360deg seam!)
  const wrapCeiling = 74 + (spread / 100) * 12; // 75.2%..86%
  const rawMin = stops[0].position;
  const rawMax = stops[stops.length - 1].position;
  const rawSpan = Math.max(1, rawMax - rawMin);

  const wrappedStops: ResolvedStop[] = [...stops, { ...stops[0], position: 100 }];
  const wrappedPositions: number[] = stops.map(
    (stop) => ((stop.position - rawMin) / rawSpan) * wrapCeiling,
  );
  wrappedPositions.push(100);

  const stopList = buildPerceptualStopList(wrappedStops, wrappedPositions, subdivisions);
  const conic = `conic-gradient(from ${angleExpr} at ${pct(centerX, 1)} ${pct(centerY, 1)}, ${stopList})`;

  // Soft core diffusion melts the mathematical conic center singularity into liquid silk
  const coreLch = interpolateOklchColor(stops[0].lch, stops[Math.floor(stops.length / 2)].lch, 0.5);
  const coreRgb = oklchToRgbClipped(coreLch);
  if (compact) {
    const compactDiffuser = `radial-gradient(circle at ${pct(centerX, 1)} ${pct(centerY, 1)}, ${rgbWithAlpha(coreRgb, 0.86)} 0%, ${rgbWithAlpha(coreRgb, 0.5)} 24%, ${rgbWithAlpha(coreRgb, 0)} 58%)`;
    return `${compactDiffuser}, ${conic}`;
  }

  const coreRadius = 14 + (spread / 100) * 20; // 16%..34%
  const coreDiffuser = `radial-gradient(circle at ${pct(centerX, 1)} ${pct(centerY, 1)}, ${rgbWithAlpha(coreRgb, 0.42)} 0%, ${rgbWithAlpha(coreRgb, 0.18)} ${pct(coreRadius * 0.52, 1)}, ${rgbWithAlpha(coreRgb, 0)} ${pct(coreRadius, 1)})`;

  return `${coreDiffuser}, ${conic}`;
}

/**
 * Resolves a stop's organic 2D mesh coordinate `(x, y)`, orbits it around `(50, 50)`
 * by `(gradientAngle - 135)deg`, and subtly biases it toward `(centerX, centerY)`.
 */
function resolveMeshPoint(
  stop: ResolvedStop,
  index: number,
  total: number,
  cosA: number,
  sinA: number,
  centerOffsetX: number,
  centerOffsetY: number,
): { x: number; y: number } {
  let rawX = stop.x;
  let rawY = stop.y;

  if (rawX === undefined || rawY === undefined) {
    // Deterministic golden-angle phyllotaxis fallback when stops lack explicit (x, y)
    const theta = index * GOLDEN_ANGLE_RAD + 0.55;
    const radius = total <= 2 ? 28 : 22 + (index / Math.max(1, total - 1)) * 22;
    rawX = rawX ?? clamp(50 + Math.cos(theta) * radius, 8, 92);
    rawY = rawY ?? clamp(50 + Math.sin(theta) * radius, 8, 92);
  }

  const dx = rawX - 50;
  const dy = rawY - 50;
  const rotX = 50 + dx * cosA - dy * sinA;
  const rotY = 50 + dx * sinA + dy * cosA;

  // Steer focal weight gracefully toward (centerX, centerY)
  const x = clamp(rotX + centerOffsetX, -6, 106);
  const y = clamp(rotY + centerOffsetY, -6, 106);
  return { x, y };
}

function compileMeshGradient(
  stops: readonly ResolvedStop[],
  luminous: readonly ResolvedStop[],
  gradientAngle: number,
  centerX: number,
  centerY: number,
  gradientSpread: number,
  baseCanvas: { rgb: RgbColor; lch: OklchColor; css: string },
  compact: boolean,
): string {
  const spread = clamp(gradientSpread, BG_BOUNDS.gradientSpread.min, BG_BOUNDS.gradientSpread.max);
  const baseRx = 36 + spread * 0.58; // 41.8%..94%
  const baseRy = 34 + spread * 0.54; // 39.4%..88%

  const layers: string[] = [];

  // Overarching atmospheric silk veil uniting the top two luminous stops
  if (!compact) {
    const heroA = luminous[0];
    const heroB = luminous[1];
    const veilMid = interpolateOklchColor(heroA.lch, heroB.lch, 0.5);
    const veilRgb = oklchToRgbClipped(veilMid);
    layers.push(
      `radial-gradient(ellipse ${pct(baseRx * 1.18, 1)} ${pct(baseRy * 1.05, 1)} at ${pct(centerX, 1)} ${pct(centerY, 1)}, ${rgbWithAlpha(veilRgb, 0.26)} 0%, ${rgbWithAlpha(veilRgb, 0.11)} 48%, ${rgbWithAlpha(veilRgb, 0)} 86%)`,
    );
  }

  // Hoist angle trig and focal bias outside the lobe loop
  const orbitRad = ((gradientAngle - 135) * Math.PI) / 180;
  const cosA = Math.cos(orbitRad);
  const sinA = Math.sin(orbitRad);
  const centerOffsetX = (centerX - 50) * 0.34;
  const centerOffsetY = (centerY - 50) * 0.34;

  // Paint lobes from last (topmost highlight) to first (deepest anchor) so brighter highlights
  // bloom organically over darker pools without flattening depth.
  const count = stops.length;
  for (let i = count - 1; i >= 0; i -= 1) {
    const stop = stops[i];
    const neighbor = stops[(i + 1) % count];
    const point = resolveMeshPoint(stop, i, count, cosA, sinA, centerOffsetX, centerOffsetY);

    // Subtle per-stop organic ellipticity and scale variation
    const aspectJitter = 0.88 + ((i * 37) % 100) / 380; // 0.88..1.14
    const sizeWeight = 0.92 + (i / Math.max(1, count - 1)) * 0.16;
    const rx = baseRx * sizeWeight * aspectJitter;
    const ry = baseRy * sizeWeight * (2 - aspectJitter);

    const alpha = clamp(stop.opacity, 0.05, 1);

    if (compact) {
      const midRgb = oklchToRgbClipped(interpolateOklchColor(stop.lch, neighbor.lch, 0.35));
      layers.push(
        `radial-gradient(ellipse ${pct(rx, 1)} ${pct(ry, 1)} at ${pct(point.x, 1)} ${pct(point.y, 1)}, ${rgbWithAlpha(stop.rgb, alpha * 0.94)} 0%, ${rgbWithAlpha(midRgb, alpha * 0.45)} 54%, ${rgbWithAlpha(midRgb, 0)} 94%)`,
      );
      continue;
    }

    // 5-point cosine/Hermite smoothstep feather with subtle neighbor OKLCH skirt blending
    const innerLch = clipOklchToSrgbGamut({
      l: clamp(stop.lch.l + 0.014, 0, 1),
      c: stop.lch.c * 1.04,
      h: stop.lch.h,
    });
    const midSkirtLch = interpolateOklchColor(stop.lch, neighbor.lch, 0.32);
    const outerSkirtLch = interpolateOklchColor(midSkirtLch, baseCanvas.lch, 0.45);
    const outerSkirtRgb = oklchToRgbClipped(outerSkirtLch);

    layers.push(
      `radial-gradient(ellipse ${pct(rx, 1)} ${pct(ry, 1)} at ${pct(point.x, 1)} ${pct(point.y, 1)}, ` +
        `${rgbWithAlpha(stop.rgb, alpha * 0.96)} 0%, ` +
        `${oklchToCssRgb(innerLch, alpha * 0.78)} 24%, ` +
        `${oklchToCssRgb(midSkirtLch, alpha * 0.4)} 52%, ` +
        `${rgbWithAlpha(outerSkirtRgb, alpha * 0.11)} 78%, ` +
        `${rgbWithAlpha(outerSkirtRgb, 0)} 100%)`,
    );
  }

  // Final solid canvas layer expressed as a pure CSS <image> so the result works
  // cleanly in both `background-image:` (including `--wp-thumb`) and `background:`.
  layers.push(`linear-gradient(180deg, ${baseCanvas.css} 0%, ${baseCanvas.css} 100%)`);
  return layers.join(', ');
}

function compilePrimaryGradient(
  gradientType: GradientType,
  stops: readonly ResolvedStop[],
  luminous: readonly ResolvedStop[],
  angleDeg: number,
  angleExpr: string,
  centerX: number,
  centerY: number,
  gradientSpread: number,
  baseCanvas: { rgb: RgbColor; lch: OklchColor; css: string },
  compact: boolean,
): string {
  const subdivisions: 1 | 3 = compact ? 1 : 3;
  switch (gradientType) {
    case 'linear':
      return compileLinearGradient(stops, angleExpr, gradientSpread, centerX, centerY, subdivisions);
    case 'radial':
      return compileRadialGradient(stops, luminous, angleDeg, centerX, centerY, gradientSpread, subdivisions, compact);
    case 'conic':
      return compileConicGradient(stops, angleExpr, centerX, centerY, gradientSpread, subdivisions, compact);
    case 'mesh':
    default:
      return compileMeshGradient(stops, luminous, angleDeg, centerX, centerY, gradientSpread, baseCanvas, compact);
  }
}

// ---------------------------------------------------------------------------
// Secondary Depth, Aurora, Liquid Orbs, Pearl Sheen, Glow, Drift, Breathe, Morph
// ---------------------------------------------------------------------------

function buildDepthGradient(
  stops: readonly ResolvedStop[],
  morphedLuminous: readonly ResolvedStop[],
  gradientAngle: number,
  centerX: number,
  centerY: number,
): string {
  const counterAngle = normalizeAngle(gradientAngle + 58);
  const heroA = morphedLuminous[0];
  const heroB = morphedLuminous[1];
  const deepStop = stops[0];

  const pocketX = clamp(100 - centerX * 0.72, 16, 84);
  const pocketY = clamp(100 - centerY * 0.68, 16, 84);

  const haloA = oklchToRgbClipped(tuneGlowOklch(heroA.lch, { minL: 0.34, maxL: 0.84, lShift: 0.04, chromaBoost: 1.06 }));
  const haloB = oklchToRgbClipped(tuneGlowOklch(heroB.lch, { minL: 0.28, maxL: 0.8, hueShift: 18, chromaBoost: 1.04 }));
  const sweepMid = interpolateOklchColor(deepStop.lch, heroA.lch, 0.45);
  const sweepEnd = interpolateOklchColor(heroA.lch, heroB.lch, 0.65);

  const pocketLayer = `radial-gradient(ellipse 68% 62% at ${pct(pocketX, 1)} ${pct(pocketY, 1)}, ${rgbWithAlpha(haloA, 0.56)} 0%, ${rgbWithAlpha(haloB, 0.24)} 48%, ${rgbWithAlpha(haloB, 0)} 86%)`;
  const sweepLayer = `linear-gradient(${deg(counterAngle, 1)}, ${oklchToCssRgb(deepStop.lch, 0.42)} 0%, ${oklchToCssRgb(sweepMid, 0.26)} 46%, ${oklchToCssRgb(sweepEnd, 0.48)} 100%)`;

  return `${pocketLayer}, ${sweepLayer}`;
}

function buildColorFlowGradient(
  luminous: readonly ResolvedStop[],
  movementDirection: number,
): string {
  const [heroA, heroB, heroC] = luminous;
  const flowAngle = normalizeAngle(movementDirection + 32);

  const cA = tuneGlowOklch(heroA.lch, { minL: 0.35, maxL: 0.82, chromaBoost: 1.08 });
  const cB = tuneGlowOklch(heroB.lch, { minL: 0.32, maxL: 0.8, hueShift: 14, chromaBoost: 1.06 });
  const cC = tuneGlowOklch(heroC.lch, { minL: 0.38, maxL: 0.86, hueShift: -16, chromaBoost: 1.05 });

  const midAB = interpolateOklchColor(cA, cB, 0.5);
  const midBC = interpolateOklchColor(cB, cC, 0.5);

  const rgbA = oklchToRgbClipped(cA);
  const rgbC = oklchToRgbClipped(cC);

  const ribbon = `linear-gradient(${deg(flowAngle, 1)}, ${rgbWithAlpha(rgbA, 0)} 4%, ${rgbWithAlpha(rgbA, 0.44)} 24%, ${oklchToCssRgb(midAB, 0.56)} 42%, ${oklchToCssRgb(cB, 0.52)} 56%, ${oklchToCssRgb(midBC, 0.44)} 72%, ${rgbWithAlpha(rgbC, 0.36)} 84%, ${rgbWithAlpha(rgbC, 0)} 96%)`;
  const softWash = `radial-gradient(ellipse 64% 56% at 50% 50%, ${oklchToCssRgb(midAB, 0.28)} 0%, ${oklchToCssRgb(cB, 0.12)} 52%, ${oklchToCssRgb(cB, 0)} 84%)`;

  return `${ribbon}, ${softWash}`;
}

function buildAuroraCurtains(
  luminous: readonly ResolvedStop[],
): { auroraCurtainA: string; auroraCurtainB: string } {
  const [heroA, heroB, heroC] = luminous;

  // Sculpted high-altitude luminous ribbons staying faithful to the user's palette
  const ribbonA1 = oklchToRgbClipped(
    tuneGlowOklch(heroA.lch, { minL: 0.56, maxL: 0.84, lShift: 0.1, chromaBoost: 1.18 }),
  );
  const ribbonA2 = oklchToRgbClipped(
    tuneGlowOklch(heroB.lch, { minL: 0.52, maxL: 0.82, lShift: 0.08, hueShift: -14, chromaBoost: 1.14 }),
  );
  const ribbonA3 = oklchToRgbClipped(
    tuneGlowOklch(heroC.lch, { minL: 0.5, maxL: 0.8, lShift: 0.07, hueShift: 22, chromaBoost: 1.12 }),
  );

  // Curtain A: three overlapping vertical-angled luminous boreal drapery bands
  const auroraCurtainA = [
    `radial-gradient(ellipse 34% 64% at 28% 36%, ${rgbWithAlpha(ribbonA1, 0.68)} 0%, ${rgbWithAlpha(ribbonA1, 0.34)} 36%, ${rgbWithAlpha(ribbonA2, 0.1)} 64%, ${rgbWithAlpha(ribbonA2, 0)} 84%)`,
    `radial-gradient(ellipse 40% 58% at 56% 28%, ${rgbWithAlpha(ribbonA2, 0.62)} 0%, ${rgbWithAlpha(ribbonA3, 0.28)} 40%, ${rgbWithAlpha(ribbonA3, 0)} 82%)`,
    `radial-gradient(ellipse 32% 62% at 78% 40%, ${rgbWithAlpha(ribbonA3, 0.52)} 0%, ${rgbWithAlpha(ribbonA1, 0.2)} 42%, ${rgbWithAlpha(ribbonA1, 0)} 80%)`,
    `linear-gradient(104deg, ${rgbWithAlpha(ribbonA1, 0)} 10%, ${rgbWithAlpha(ribbonA1, 0.24)} 34%, ${rgbWithAlpha(ribbonA2, 0.3)} 54%, ${rgbWithAlpha(ribbonA3, 0.22)} 74%, ${rgbWithAlpha(ribbonA3, 0)} 92%)`,
  ].join(', ');

  // Curtain B: counter-harmonic OKLCH-shifted interference drapery
  const ribbonB1 = oklchToRgbClipped(
    tuneGlowOklch(heroB.lch, { minL: 0.54, maxL: 0.84, lShift: 0.09, hueShift: 28, chromaBoost: 1.16 }),
  );
  const ribbonB2 = oklchToRgbClipped(
    tuneGlowOklch(heroC.lch, { minL: 0.52, maxL: 0.82, lShift: 0.08, hueShift: -24, chromaBoost: 1.14 }),
  );
  const ribbonB3 = oklchToRgbClipped(
    tuneGlowOklch(heroA.lch, { minL: 0.56, maxL: 0.86, lShift: 0.11, hueShift: 36, chromaBoost: 1.12 }),
  );

  const auroraCurtainB = [
    `radial-gradient(ellipse 38% 60% at 38% 42%, ${rgbWithAlpha(ribbonB1, 0.64)} 0%, ${rgbWithAlpha(ribbonB2, 0.28)} 42%, ${rgbWithAlpha(ribbonB2, 0)} 82%)`,
    `radial-gradient(ellipse 36% 64% at 68% 32%, ${rgbWithAlpha(ribbonB2, 0.6)} 0%, ${rgbWithAlpha(ribbonB3, 0.26)} 40%, ${rgbWithAlpha(ribbonB3, 0)} 80%)`,
    `linear-gradient(76deg, ${rgbWithAlpha(ribbonB3, 0)} 12%, ${rgbWithAlpha(ribbonB1, 0.26)} 38%, ${rgbWithAlpha(ribbonB2, 0.28)} 62%, ${rgbWithAlpha(ribbonB3, 0)} 90%)`,
  ].join(', ');

  return { auroraCurtainA, auroraCurtainB };
}

/**
 * Builds a soft spherical/elliptical orb gradient centered strictly at `50% 50%`
 * and feathered to `0` alpha by `72%` of its container so moving orb layers never
 * expose rectangular clipping edges during orbital translation.
 */
function buildFeatheredPool(
  coreLch: OklchColor,
  skirtLch: OklchColor,
  rxPct: number,
  ryPct: number,
  peakAlpha: number,
): string {
  const coreRgb = oklchToRgbClipped(coreLch);
  const midRgb = oklchToRgbClipped(interpolateOklchColor(coreLch, skirtLch, 0.45));
  const skirtRgb = oklchToRgbClipped(skirtLch);

  return (
    `radial-gradient(ellipse ${pct(rxPct, 1)} ${pct(ryPct, 1)} at 50% 50%, ` +
    `${rgbWithAlpha(coreRgb, peakAlpha)} 0%, ` +
    `${rgbWithAlpha(midRgb, peakAlpha * 0.66)} 30%, ` +
    `${rgbWithAlpha(skirtRgb, peakAlpha * 0.24)} 56%, ` +
    `${rgbWithAlpha(skirtRgb, peakAlpha * 0.05)} 74%, ` +
    `${rgbWithAlpha(skirtRgb, 0)} 92%)`
  );
}

function buildLiquidOrbs(
  luminous: readonly ResolvedStop[],
): { liquidOrbA: string; liquidOrbB: string; liquidOrbC: string } {
  const [heroA, heroB, heroC] = luminous;

  const orbACore = tuneGlowOklch(heroA.lch, { minL: 0.46, maxL: 0.84, lShift: 0.06, chromaBoost: 1.12 });
  const orbASkirt = tuneGlowOklch(heroB.lch, { minL: 0.38, maxL: 0.78, chromaBoost: 1.04 });

  const orbBCore = tuneGlowOklch(heroB.lch, { minL: 0.44, maxL: 0.82, lShift: 0.05, hueShift: 14, chromaBoost: 1.1 });
  const orbBSkirt = tuneGlowOklch(heroC.lch, { minL: 0.36, maxL: 0.76, chromaBoost: 1.02 });

  const orbCCore = tuneGlowOklch(heroC.lch, { minL: 0.54, maxL: 0.88, lShift: 0.09, hueShift: -18, chromaBoost: 1.1 });
  const orbCSkirt = tuneGlowOklch(heroA.lch, { minL: 0.44, maxL: 0.8, chromaBoost: 1.02 });

  return {
    liquidOrbA: buildFeatheredPool(orbACore, orbASkirt, 48, 44, 0.78),
    liquidOrbB: buildFeatheredPool(orbBCore, orbBSkirt, 46, 50, 0.74),
    liquidOrbC: buildFeatheredPool(orbCCore, orbCSkirt, 44, 42, 0.68),
  };
}

/**
 * Builds an opalescent multi-band mother-of-pearl iridescent prism gradient shifted
 * perceptually in OKLCH lightness and hue around the palette's primary highlight.
 */
function buildPearlSheenGradient(luminous: readonly ResolvedStop[]): string {
  const hero = luminous[0];
  const baseHue = hero.lch.c > 0.01 ? hero.lch.h : 215;

  const bandRoseOpal = oklchToRgbClipped(clipOklchToSrgbGamut({ l: 0.85, c: 0.066, h: normalizeAngle(baseHue - 44) }));
  const bandAquaNacre = oklchToRgbClipped(clipOklchToSrgbGamut({ l: 0.89, c: 0.072, h: normalizeAngle(baseHue - 12) }));
  const bandPearlCore = oklchToRgbClipped(clipOklchToSrgbGamut({ l: 0.965, c: 0.016, h: baseHue }));
  const bandIrisViolet = oklchToRgbClipped(clipOklchToSrgbGamut({ l: 0.88, c: 0.074, h: normalizeAngle(baseHue + 28) }));
  const bandGlacierMist = oklchToRgbClipped(clipOklchToSrgbGamut({ l: 0.86, c: 0.058, h: normalizeAngle(baseHue + 64) }));

  const prismSweep = [
    `linear-gradient(var(--ec-bg-shimmer-angle),`,
    ` ${rgbWithAlpha(bandRoseOpal, 0)} 14%,`,
    ` ${rgbWithAlpha(bandRoseOpal, 0.24)} 26%,`,
    ` ${rgbWithAlpha(bandAquaNacre, 0.42)} 39%,`,
    ` ${rgbWithAlpha(bandPearlCore, 0.62)} 50%,`,
    ` ${rgbWithAlpha(bandIrisViolet, 0.4)} 61%,`,
    ` ${rgbWithAlpha(bandGlacierMist, 0.22)} 74%,`,
    ` ${rgbWithAlpha(bandGlacierMist, 0)} 86%)`,
  ].join('');

  const nacreSpecular = `radial-gradient(ellipse 46% 32% at 48% 42%, ${rgbWithAlpha(bandPearlCore, 0.34)} 0%, ${rgbWithAlpha(bandAquaNacre, 0.16)} 44%, ${rgbWithAlpha(bandIrisViolet, 0)} 82%)`;

  return `${nacreSpecular}, ${prismSweep}`;
}

function buildAmbientGlowGradient(
  luminous: readonly ResolvedStop[],
  centerX: number,
  centerY: number,
  glowRadius: number,
): string {
  const heroA = luminous[0];
  const heroB = luminous[1];
  const coreLch = tuneGlowOklch(heroA.lch, { minL: 0.62, maxL: 0.92, lShift: 0.14, chromaBoost: 1.05 });
  const midLch = tuneGlowOklch(heroA.lch, { minL: 0.48, maxL: 0.84, lShift: 0.06, chromaBoost: 1.12 });
  const outerLch = tuneGlowOklch(heroB.lch, { minL: 0.38, maxL: 0.78, chromaBoost: 1.02 });

  const coreRgb = oklchToRgbClipped(coreLch);
  const midRgb = oklchToRgbClipped(midLch);
  const outerRgb = oklchToRgbClipped(outerLch);

  const radiusNorm = clamp(glowRadius, BG_BOUNDS.glowRadius.min, BG_BOUNDS.glowRadius.max) / 100;
  // Sized inside the -18% oversized container so breathing scale never clips edges
  const rx = 24 + radiusNorm * 30; // 27%..54%
  const ry = 22 + radiusNorm * 28; // 24.8%..50%

  return (
    `radial-gradient(ellipse ${pct(rx, 1)} ${pct(ry, 1)} at ${pct(centerX, 1)} ${pct(centerY, 1)}, ` +
    `${rgbWithAlpha(coreRgb, 0.72)} 0%, ` +
    `${rgbWithAlpha(midRgb, 0.44)} 30%, ` +
    `${rgbWithAlpha(outerRgb, 0.16)} 58%, ` +
    `${rgbWithAlpha(outerRgb, 0.03)} 78%, ` +
    `${rgbWithAlpha(outerRgb, 0)} 94%)`
  );
}

function buildDriftLightGradients(
  luminous: readonly ResolvedStop[],
): { driftLightGradient: string; driftLightGradientB: string } {
  const heroA = luminous[0];
  const heroB = luminous[1];

  const coreA = tuneGlowOklch(heroA.lch, { minL: 0.66, maxL: 0.94, lShift: 0.16, chromaBoost: 0.92 });
  const skirtA = tuneGlowOklch(heroA.lch, { minL: 0.48, maxL: 0.84, lShift: 0.06, chromaBoost: 1.08 });

  const coreB = tuneGlowOklch(heroB.lch, { minL: 0.62, maxL: 0.92, lShift: 0.14, hueShift: 32, chromaBoost: 0.95 });
  const skirtB = tuneGlowOklch(heroB.lch, { minL: 0.44, maxL: 0.82, hueShift: 24, chromaBoost: 1.05 });

  return {
    driftLightGradient: buildFeatheredPool(coreA, skirtA, 46, 40, 0.64),
    driftLightGradientB: buildFeatheredPool(coreB, skirtB, 42, 48, 0.58),
  };
}

function buildBreathingVeilGradient(
  stops: readonly ResolvedStop[],
  luminous: readonly ResolvedStop[],
  gradientAngle: number,
  centerX: number,
  centerY: number,
): string {
  const heroA = luminous[0];
  const heroB = luminous[1];
  const brightLch = tuneGlowOklch(heroA.lch, { minL: 0.68, maxL: 0.94, lShift: 0.16, chromaBoost: 0.86 });
  const warmMidLch = tuneGlowOklch(heroB.lch, { minL: 0.54, maxL: 0.86, lShift: 0.08, hueShift: 12, chromaBoost: 0.95 });
  const deepLch = tuneGlowOklch(stops[0].lch, { minL: 0.14, maxL: 0.62, chromaBoost: 0.85 });

  const brightRgb = oklchToRgbClipped(brightLch);
  const midRgb = oklchToRgbClipped(warmMidLch);
  const deepRgb = oklchToRgbClipped(deepLch);

  const veilAngle = normalizeAngle(gradientAngle + 22);
  return [
    `radial-gradient(ellipse 72% 66% at ${pct(centerX, 1)} ${pct(centerY, 1)}, ${rgbWithAlpha(brightRgb, 0.52)} 0%, ${rgbWithAlpha(midRgb, 0.2)} 50%, ${rgbWithAlpha(midRgb, 0)} 84%)`,
    `linear-gradient(${deg(veilAngle, 1)}, ${rgbWithAlpha(brightRgb, 0.34)} 0%, ${rgbWithAlpha(midRgb, 0.14)} 52%, ${rgbWithAlpha(deepRgb, 0.28)} 100%)`,
  ].join(', ');
}

// ---------------------------------------------------------------------------
// Optical Filter, Smoothness Easing, and Eco Effect Planning
// ---------------------------------------------------------------------------

/**
 * Builds the single-plane optical CSS `filter` string.
 * Blur is strictly limited to the base plane and disabled in `eco` or `compact`
 * modes so multiple layers never stack GPU blur passes.
 */
function buildCssFilterString(
  brightness: number,
  saturation: number,
  contrast: number,
  blur: number,
  disableBlur: boolean,
): { filter: string; blurOverscan: string } {
  const b = clamp(brightness, BG_BOUNDS.brightness.min, BG_BOUNDS.brightness.max);
  const s = clamp(saturation, BG_BOUNDS.saturation.min, BG_BOUNDS.saturation.max);
  const c = clamp(contrast, BG_BOUNDS.contrast.min, BG_BOUNDS.contrast.max);
  const effectiveBlur = disableBlur ? 0 : clamp(blur, BG_BOUNDS.blur.min, BG_BOUNDS.blur.max);

  const parts: string[] = [];
  if (Math.abs(b - 100) >= 0.5) {
    parts.push(`brightness(${fmt(b / 100, 3)})`);
  }
  if (Math.abs(s - 100) >= 0.5) {
    parts.push(`saturate(${fmt(s / 100, 3)})`);
  }
  if (Math.abs(c - 100) >= 0.5) {
    parts.push(`contrast(${fmt(c / 100, 3)})`);
  }
  if (effectiveBlur >= 0.5) {
    parts.push(`blur(${fmt(effectiveBlur, 1)}px)`);
  }

  const filter = parts.length > 0 ? parts.join(' ') : 'none';
  // 2.5x sigma overscan keeps Gaussian edge attenuation below 0.6% (zero dark vignette edges up to blur 40px)
  const blurOverscan = effectiveBlur >= 0.5 ? `${Math.ceil(effectiveBlur * 2.5)}px` : '0px';
  return { filter, blurOverscan };
}

/**
 * Maps `animationSmoothness` (`0..100`) to a valid CSS `cubic-bezier(...)`
 * curve ranging from crisp rhythmic motion (`0`) to silky sinusoidal glide (`100`).
 */
function buildSmoothnessEasing(smoothness: number): string {
  const t = clamp(smoothness, BG_BOUNDS.animationSmoothness.min, BG_BOUNDS.animationSmoothness.max) / 100;
  // Interpolates smoothly from (0.24, 0.16, 0.76, 0.84) to exact easeInOutSine (0.37, 0.0, 0.63, 1.0)
  const x1 = 0.24 + t * 0.13;
  const y1 = 0.16 * (1 - t);
  const x2 = 0.76 - t * 0.13;
  const y2 = 0.84 + t * 0.16;
  return `cubic-bezier(${fmt(x1, 3)}, ${fmt(y1, 3)}, ${fmt(x2, 3)}, ${fmt(y2, 3)})`;
}

/**
 * Resolves the effective animated effect list honoring `'static'`,
 * `reducedMotion`, and the `eco` single-plane compositor budget.
 */
function resolveActiveEffects(
  rawEffects: readonly BackgroundEffectId[] | undefined,
  reducedMotion: boolean,
  isEco: boolean,
): { activeEffects: BackgroundEffectId[]; isStatic: boolean } {
  const normalized = normalizeEffectSelection(rawEffects ?? ['static']);
  const animated = normalized.filter((id) => id !== 'static');

  if (reducedMotion || animated.length === 0) {
    return { activeEffects: [], isStatic: true };
  }

  if (isEco) {
    const ecoPreferred = animated.find((id) => EFFECT_COMPATIBILITY[id].ecoSafe);
    return {
      activeEffects: [ecoPreferred ?? animated[0]],
      isStatic: false,
    };
  }

  return { activeEffects: animated, isStatic: false };
}

// ---------------------------------------------------------------------------
// Bounded Value-Keyed Palette Cache (Zero Leaks, Immune to In-Place Mutation)
// ---------------------------------------------------------------------------

interface PaletteCacheEntry {
  stops: ResolvedStop[];
  baseCanvas: { rgb: RgbColor; lch: OklchColor; css: string };
  luminous: ResolvedStop[];
  morphedStops?: ResolvedStop[];
  morphedCanvas?: { rgb: RgbColor; lch: OklchColor; css: string };
  morphedLuminous?: ResolvedStop[];
  aurora?: { auroraCurtainA: string; auroraCurtainB: string };
  liquid?: { liquidOrbA: string; liquidOrbB: string; liquidOrbC: string };
  pearl?: string;
  drift?: { driftLightGradient: string; driftLightGradientB: string };
  lastBaseKey?: string;
  lastBaseVal?: string;
  lastMorphKey?: string;
  lastMorphVal?: string;
  lastDepthKey?: string;
  lastDepthVal?: string;
  lastFlowKey?: string;
  lastFlowVal?: string;
  lastGlowKey?: string;
  lastGlowVal?: string;
  lastBreatheKey?: string;
  lastBreatheVal?: string;
  lastSwatchKey?: string;
  lastSwatchVal?: string;
  lastAmbientKey?: string;
  lastAmbientVal?: string;
}

const PALETTE_CACHE_MAX = 12;
const paletteCache = new Map<string, PaletteCacheEntry>();

function computeStopsSignature(
  rawStops: readonly ColorStop[] | undefined,
  colorIntensity: number,
): string {
  const source = Array.isArray(rawStops) && rawStops.length >= 2 ? rawStops : FALLBACK_STOPS;
  const ci = clamp(colorIntensity, BG_BOUNDS.colorIntensity.min, BG_BOUNDS.colorIntensity.max);
  let sig = `${ci}`;
  for (let i = 0; i < source.length; i += 1) {
    const s = source[i];
    sig += `|${s.color},${s.position},${s.opacity},${s.x ?? ''},${s.y ?? ''}`;
  }
  return sig;
}

function getPaletteEntry(
  rawStops: readonly ColorStop[] | undefined,
  colorIntensity: number,
): PaletteCacheEntry {
  const key = computeStopsSignature(rawStops, colorIntensity);
  const hit = paletteCache.get(key);
  if (hit) {
    // Refresh LRU order in O(1)
    paletteCache.delete(key);
    paletteCache.set(key, hit);
    return hit;
  }

  const stops = resolveStops(rawStops, colorIntensity);
  const baseCanvas = deriveBaseCanvasColor(stops);
  const luminous = pickLuminousStops(stops, 3);
  const entry: PaletteCacheEntry = { stops, baseCanvas, luminous };

  if (paletteCache.size >= PALETTE_CACHE_MAX) {
    const oldest = paletteCache.keys().next().value;
    if (oldest !== undefined) paletteCache.delete(oldest);
  }
  paletteCache.set(key, entry);
  return entry;
}

function ensureMorphedPalette(entry: PaletteCacheEntry): {
  morphedStops: ResolvedStop[];
  morphedCanvas: { rgb: RgbColor; lch: OklchColor; css: string };
  morphedLuminous: ResolvedStop[];
} {
  if (!entry.morphedStops || !entry.morphedCanvas || !entry.morphedLuminous) {
    const morphedStops = deriveMorphedStopsDirect(entry.stops);
    entry.morphedStops = morphedStops;
    entry.morphedCanvas = deriveBaseCanvasColor(morphedStops);
    entry.morphedLuminous = pickLuminousStops(morphedStops, 3);
  }
  return {
    morphedStops: entry.morphedStops,
    morphedCanvas: entry.morphedCanvas,
    morphedLuminous: entry.morphedLuminous,
  };
}

// ---------------------------------------------------------------------------
// Public API: `previewSwatchCss` & `buildBackgroundStyleVars`
// ---------------------------------------------------------------------------

/**
 * Builds a compact, crisp, pure CSS `<image>` expression representing `config`
 * for the sidebar swatch (`--wp-thumb`), gallery preset cards, and My Themes cards.
 *
 * Uses 1 perceptual OKLCH midpoint per stop span so swatches match the full-screen
 * composition faithfully with zero grey dead-zones, and emits ONLY valid CSS
 * `<image>` values so it works identically inside both `background-image: var(--wp-thumb)`
 * and `background:`.
 */
export function previewSwatchCss(config: BackgroundThemeConfig): string {
  const color = config.color;
  const gradientType: GradientType = isGradientType(color.gradientType) ? color.gradientType : 'mesh';
  const entry = getPaletteEntry(color.stops, color.colorIntensity);
  const angle = normalizeAngle(color.gradientAngle);
  const centerX = clamp(color.centerX, BG_BOUNDS.centerX.min, BG_BOUNDS.centerX.max);
  const centerY = clamp(color.centerY, BG_BOUNDS.centerY.min, BG_BOUNDS.centerY.max);
  const spread = clamp(color.gradientSpread, BG_BOUNDS.gradientSpread.min, BG_BOUNDS.gradientSpread.max);

  const swatchKey = `${gradientType}|${angle}|${centerX}|${centerY}|${spread}`;
  if (entry.lastSwatchKey === swatchKey && entry.lastSwatchVal !== undefined) {
    return entry.lastSwatchVal;
  }

  const swatch = compilePrimaryGradient(
    gradientType,
    entry.stops,
    entry.luminous,
    angle,
    deg(angle, 1),
    centerX,
    centerY,
    spread,
    entry.baseCanvas,
    true,
  );
  entry.lastSwatchKey = swatchKey;
  entry.lastSwatchVal = swatch;
  return swatch;
}

/**
 * Pure compiler that transforms a `BackgroundThemeConfig` into the complete
 * `--ec-bg-*` CSS custom property dictionary and layer activation plan consumed
 * by `<BackgroundThemeLayer />`.
 */
export function buildBackgroundStyleVars(
  config: BackgroundThemeConfig,
  opts: BackgroundRenderOptions = {},
): BackgroundRenderPlan {
  const color = config.color;
  const motion = config.motion;

  const reducedMotion = Boolean(opts.reducedMotion);
  const compact = Boolean(opts.compact);
  const activeOnly = Boolean(opts.activeOnly);
  const isEco = Boolean(opts.lowPower) || motion.performanceMode === 'eco';

  const gradientType: GradientType = isGradientType(color.gradientType) ? color.gradientType : 'mesh';
  const blendMode: BackgroundBlendMode = isBackgroundBlendMode(color.blendMode)
    ? color.blendMode
    : 'soft-light';

  const angle = normalizeAngle(color.gradientAngle);
  const shimmerAngle = normalizeAngle(motion.movementDirection * 0.55 + angle * 0.45 + 18);
  const centerX = clamp(color.centerX, BG_BOUNDS.centerX.min, BG_BOUNDS.centerX.max);
  const centerY = clamp(color.centerY, BG_BOUNDS.centerY.min, BG_BOUNDS.centerY.max);
  const spread = clamp(color.gradientSpread, BG_BOUNDS.gradientSpread.min, BG_BOUNDS.gradientSpread.max);

  const { activeEffects, isStatic } = resolveActiveEffects(motion.effects, reducedMotion, isEco);

  // Optical & layer opacities
  const masterOpacity = clamp(color.opacity, BG_BOUNDS.opacity.min, BG_BOUNDS.opacity.max) / 100;
  const baseLayerOpacity =
    clamp(color.baseLayerOpacity, BG_BOUNDS.baseLayerOpacity.min, BG_BOUNDS.baseLayerOpacity.max) / 100;
  const rawDepthOpacity =
    clamp(color.depthLayerOpacity, BG_BOUNDS.depthLayerOpacity.min, BG_BOUNDS.depthLayerOpacity.max) / 100;
  const blendFactor =
    clamp(color.blendIntensity, BG_BOUNDS.blendIntensity.min, BG_BOUNDS.blendIntensity.max) / 100;
  const effectiveDepthOpacity =
    rawDepthOpacity <= 0 || blendFactor <= 0 ? 0 : rawDepthOpacity * (0.25 + 0.75 * blendFactor);

  const rawGrain =
    typeof config.grainOpacity === 'number' && Number.isFinite(config.grainOpacity)
      ? clamp(config.grainOpacity, BG_BOUNDS.grainOpacity.min, BG_BOUNDS.grainOpacity.max)
      : BG_BOUNDS.grainOpacity.default;
  const hasGrain = !isEco && !compact && rawGrain > 0;
  const effectiveGrainOpacity = hasGrain ? (rawGrain / 100) * 0.09 : 0;

  // Motion & light scalars (CSS bearing convention: 0deg = up (0, -1), 90deg = right (1, 0))
  const speed = clamp(motion.animationSpeed, BG_BOUNDS.animationSpeed.min, BG_BOUNDS.animationSpeed.max);
  const ease = buildSmoothnessEasing(motion.animationSmoothness);
  const rawMotion =
    clamp(motion.motionIntensity, BG_BOUNDS.motionIntensity.min, BG_BOUNDS.motionIntensity.max) / 100;
  const effectiveMotion = isStatic ? 0 : isEco ? rawMotion * 0.55 : rawMotion;

  const dirRad = (normalizeAngle(motion.movementDirection) * Math.PI) / 180;
  const dirX = Math.sin(dirRad);
  const dirY = -Math.cos(dirRad);

  const rawScale =
    clamp(motion.movementScale, BG_BOUNDS.movementScale.min, BG_BOUNDS.movementScale.max) / 100;
  const effectiveScale = isEco ? Math.min(rawScale, 0.85) : rawScale;

  const light = clamp(motion.lightIntensity, BG_BOUNDS.lightIntensity.min, BG_BOUNDS.lightIntensity.max) / 100;
  const glow = clamp(color.glow, BG_BOUNDS.glow.min, BG_BOUNDS.glow.max) / 100;
  const glowRadiusNorm = clamp(motion.glowRadius, BG_BOUNDS.glowRadius.min, BG_BOUNDS.glowRadius.max) / 100;
  const shimmer =
    clamp(motion.shimmerIntensity, BG_BOUNDS.shimmerIntensity.min, BG_BOUNDS.shimmerIntensity.max) / 100;

  const hasFx = (id: BackgroundEffectId): boolean => activeEffects.includes(id);
  const hasStaticGlow = glow > 0 && !hasFx('ambient-glow');
  const needsStaticAmbientGlow =
    hasStaticGlow ||
    (isStatic && Array.isArray(motion.effects) && motion.effects.includes('ambient-glow') && light > 0);
  const singlePlaneBudget = isEco || compact;

  const needMorph = !activeOnly || hasFx('gradient-morph');
  const needDepth = !activeOnly || effectiveDepthOpacity > 0;
  const needFlow = !activeOnly || hasFx('color-flow');
  const needAurora = !activeOnly || hasFx('aurora');
  const needLiquid = !activeOnly || hasFx('liquid-flow');
  const needPearl = !activeOnly || hasFx('pearl-shimmer');
  const needAmbientGlow = !activeOnly || hasFx('ambient-glow') || needsStaticAmbientGlow;
  const needDrift = !activeOnly || hasFx('light-drift');
  const needBreathe = !activeOnly || hasFx('color-breathing');

  const entry = getPaletteEntry(color.stops, color.colorIntensity);
  const { stops, baseCanvas, luminous } = entry;

  // Primary gradient references `--ec-bg-angle` for linear/conic so browsers supporting
  // CSS `@property --ec-bg-angle` interpolate angle updates smoothly (and angle drags hit cache!).
  const baseKey =
    gradientType === 'linear' || gradientType === 'conic'
      ? `${gradientType}|${centerX}|${centerY}|${spread}|${compact ? 1 : 0}`
      : `${gradientType}|${angle}|${centerX}|${centerY}|${spread}|${compact ? 1 : 0}`;
  let baseGradient: string;
  if (entry.lastBaseKey === baseKey && entry.lastBaseVal !== undefined) {
    baseGradient = entry.lastBaseVal;
  } else {
    baseGradient = compilePrimaryGradient(
      gradientType,
      stops,
      luminous,
      angle,
      'var(--ec-bg-angle)',
      centerX,
      centerY,
      spread,
      baseCanvas,
      compact,
    );
    entry.lastBaseKey = baseKey;
    entry.lastBaseVal = baseGradient;
  }

  let morphGradient = '';
  let depthGradient = '';
  if (needMorph || needDepth) {
    const { morphedStops, morphedCanvas, morphedLuminous } = ensureMorphedPalette(entry);

    if (needMorph) {
      const morphAngle = normalizeAngle(angle + 28);
      const morphCenterX = clamp(centerX + (centerX > 50 ? -7 : 7), 12, 88);
      const morphCenterY = clamp(centerY + (centerY > 50 ? -6 : 6), 12, 88);
      const morphSpread = clamp(spread + 6, BG_BOUNDS.gradientSpread.min, BG_BOUNDS.gradientSpread.max);
      const morphKey = `${gradientType}|${morphAngle}|${morphCenterX}|${morphCenterY}|${morphSpread}|${compact ? 1 : 0}`;
      if (entry.lastMorphKey === morphKey && entry.lastMorphVal !== undefined) {
        morphGradient = entry.lastMorphVal;
      } else {
        morphGradient = compilePrimaryGradient(
          gradientType,
          morphedStops,
          morphedLuminous,
          morphAngle,
          deg(morphAngle, 1),
          morphCenterX,
          morphCenterY,
          morphSpread,
          morphedCanvas,
          compact,
        );
        entry.lastMorphKey = morphKey;
        entry.lastMorphVal = morphGradient;
      }
    }

    if (needDepth) {
      const depthKey = `${angle}|${centerX}|${centerY}`;
      if (entry.lastDepthKey === depthKey && entry.lastDepthVal !== undefined) {
        depthGradient = entry.lastDepthVal;
      } else {
        depthGradient = buildDepthGradient(stops, morphedLuminous, angle, centerX, centerY);
        entry.lastDepthKey = depthKey;
        entry.lastDepthVal = depthGradient;
      }
    }
  }

  let colorFlowGradient = '';
  if (needFlow) {
    const flowDir = normalizeAngle(motion.movementDirection);
    const flowKey = `${flowDir}`;
    if (entry.lastFlowKey === flowKey && entry.lastFlowVal !== undefined) {
      colorFlowGradient = entry.lastFlowVal;
    } else {
      colorFlowGradient = buildColorFlowGradient(luminous, flowDir);
      entry.lastFlowKey = flowKey;
      entry.lastFlowVal = colorFlowGradient;
    }
  }

  let auroraCurtainA = '';
  let auroraCurtainB = '';
  if (needAurora) {
    if (!entry.aurora) {
      entry.aurora = buildAuroraCurtains(luminous);
    }
    auroraCurtainA = entry.aurora.auroraCurtainA;
    auroraCurtainB = entry.aurora.auroraCurtainB;
  }

  let liquidOrbA = '';
  let liquidOrbB = '';
  let liquidOrbC = '';
  if (needLiquid) {
    if (!entry.liquid) {
      entry.liquid = buildLiquidOrbs(luminous);
    }
    liquidOrbA = entry.liquid.liquidOrbA;
    liquidOrbB = entry.liquid.liquidOrbB;
    liquidOrbC = entry.liquid.liquidOrbC;
  }

  let pearlSheenGradient = '';
  if (needPearl) {
    if (entry.pearl === undefined) {
      entry.pearl = buildPearlSheenGradient(luminous);
    }
    pearlSheenGradient = entry.pearl;
  }

  let ambientGlowGradient = '';
  if (needAmbientGlow) {
    const glowKey = `${centerX}|${centerY}|${motion.glowRadius}`;
    if (entry.lastGlowKey === glowKey && entry.lastGlowVal !== undefined) {
      ambientGlowGradient = entry.lastGlowVal;
    } else {
      ambientGlowGradient = buildAmbientGlowGradient(luminous, centerX, centerY, motion.glowRadius);
      entry.lastGlowKey = glowKey;
      entry.lastGlowVal = ambientGlowGradient;
    }
  }

  let driftLightGradient = '';
  let driftLightGradientB = '';
  if (needDrift) {
    if (!entry.drift) {
      entry.drift = buildDriftLightGradients(luminous);
    }
    driftLightGradient = entry.drift.driftLightGradient;
    driftLightGradientB = entry.drift.driftLightGradientB;
  }

  let breathingVeilGradient = '';
  if (needBreathe) {
    const breatheKey = `${angle}|${centerX}|${centerY}`;
    if (entry.lastBreatheKey === breatheKey && entry.lastBreatheVal !== undefined) {
      breathingVeilGradient = entry.lastBreatheVal;
    } else {
      breathingVeilGradient = buildBreathingVeilGradient(stops, luminous, angle, centerX, centerY);
      entry.lastBreatheKey = breatheKey;
      entry.lastBreatheVal = breathingVeilGradient;
    }
  }

  const { filter: cssFilterString, blurOverscan } = buildCssFilterString(
    color.brightness,
    color.saturation,
    color.contrast,
    color.blur,
    isEco || compact,
  );

  let ambientRgb = '';
  let previewSwatch = '';
  if (!activeOnly) {
    const ambientKey = `${color.saturation}|${color.brightness}`;
    if (entry.lastAmbientKey === ambientKey && entry.lastAmbientVal !== undefined) {
      ambientRgb = entry.lastAmbientVal;
    } else {
      ambientRgb = extractAmbientRgb(config);
      entry.lastAmbientKey = ambientKey;
      entry.lastAmbientVal = ambientRgb;
    }

    if (compact) {
      previewSwatch =
        gradientType === 'linear' || gradientType === 'conic'
          ? baseGradient.replace('var(--ec-bg-angle)', deg(angle, 1))
          : baseGradient;
    } else {
      const swatchKey = `${gradientType}|${angle}|${centerX}|${centerY}|${spread}`;
      if (entry.lastSwatchKey === swatchKey && entry.lastSwatchVal !== undefined) {
        previewSwatch = entry.lastSwatchVal;
      } else {
        previewSwatch = compilePrimaryGradient(
          gradientType,
          stops,
          luminous,
          angle,
          deg(angle, 1),
          centerX,
          centerY,
          spread,
          baseCanvas,
          true,
        );
        entry.lastSwatchKey = swatchKey;
        entry.lastSwatchVal = previewSwatch;
      }
    }
  }

  const styleVars: Record<string, string> = {
    // Registered @property typed custom properties
    '--ec-bg-angle': deg(angle, 1),
    '--ec-bg-shimmer-angle': deg(shimmerAngle, 1),
    '--ec-bg-breathe': '0',
    '--ec-bg-morph-mix': '0',

    // Compiled perceptual surfaces and active effect gradients
    '--ec-bg-base-color': baseCanvas.css,
    '--ec-bg-base': baseGradient,
    '--ec-bg-depth': effectiveDepthOpacity > 0 ? depthGradient : 'none',
    '--ec-bg-grain': hasGrain ? ANTI_BANDING_GRAIN_SVG : 'none',

    // Optical grading and compositing controls
    '--ec-bg-opacity': fmt(masterOpacity, 3),
    '--ec-bg-base-opacity': fmt(baseLayerOpacity, 3),
    '--ec-bg-depth-opacity': fmt(effectiveDepthOpacity, 3),
    '--ec-bg-blend-mode': blendMode,
    '--ec-bg-filter': cssFilterString,
    '--ec-bg-blur-overscan': blurOverscan,
    '--ec-bg-grain-opacity': fmt(effectiveGrainOpacity, 4),
    '--ec-bg-center-x': pct(centerX, 1),
    '--ec-bg-center-y': pct(centerY, 1),

    // Motion and lighting scalars
    '--ec-bg-speed': fmt(speed, 3),
    '--ec-bg-ease': ease,
    '--ec-bg-motion': fmt(effectiveMotion, 3),
    '--ec-bg-dir-x': fmt(dirX, 4),
    '--ec-bg-dir-y': fmt(dirY, 4),
    '--ec-bg-scale': fmt(effectiveScale, 3),
    '--ec-bg-light': fmt(light, 3),
    '--ec-bg-glow': fmt(glow, 3),
    '--ec-bg-glow-radius': fmt(glowRadiusNorm, 3),
    '--ec-bg-shimmer': fmt(shimmer, 3),
  };

  if (needFlow) styleVars['--ec-bg-flow'] = colorFlowGradient;
  if (needAurora) {
    styleVars['--ec-bg-aurora-a'] = auroraCurtainA;
    if (!activeOnly || !singlePlaneBudget) {
      styleVars['--ec-bg-aurora-b'] = auroraCurtainB;
    }
  }
  if (needLiquid) {
    styleVars['--ec-bg-orb-a'] = liquidOrbA;
    if (!activeOnly || !singlePlaneBudget) {
      styleVars['--ec-bg-orb-b'] = liquidOrbB;
      styleVars['--ec-bg-orb-c'] = liquidOrbC;
    }
  }
  if (needPearl) styleVars['--ec-bg-pearl'] = pearlSheenGradient;
  if (needAmbientGlow) styleVars['--ec-bg-ambient-glow'] = ambientGlowGradient;
  if (needDrift) {
    styleVars['--ec-bg-drift-a'] = driftLightGradient;
    if (!activeOnly || !singlePlaneBudget) {
      styleVars['--ec-bg-drift-b'] = driftLightGradientB;
    }
  }
  if (needBreathe) styleVars['--ec-bg-breathe-veil'] = breathingVeilGradient;
  if (needMorph) styleVars['--ec-bg-morph'] = morphGradient;

  return {
    styleVars,
    activeEffects,
    isStatic,
    isEco,
    hasGrain,
    hasStaticGlow,
    blendMode,
    baseColor: baseCanvas.css,
    baseGradient,
    depthGradient,
    colorFlowGradient,
    auroraCurtainA,
    auroraCurtainB,
    liquidOrbA,
    liquidOrbB,
    liquidOrbC,
    pearlSheenGradient,
    ambientGlowGradient,
    driftLightGradient,
    driftLightGradientB,
    breathingVeilGradient,
    morphGradient,
    cssFilterString,
    ambientRgb,
    previewSwatch,
  };
}
