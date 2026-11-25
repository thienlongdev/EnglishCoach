/**
 * Pure TypeScript perceptual color science, OKLCH gamut mapping, WCAG 2.1
 * luminance analysis, harmonic morphing, curated random composition generation,
 * and defensive schema sanitization for Echo Background Studio.
 *
 * Zero external dependencies. Implements exact Björn Ottosson (2020) OKLab and
 * OKLCH transforms with chroma-only binary-search sRGB gamut clipping so
 * perceptual lightness (L) and hue (H) remain invariant across edits.
 */

import {
  BG_BOUNDS,
  MAX_STOPS,
  MIN_STOPS,
  THEME_ID_PATTERN,
  isBackgroundBlendMode,
  isGradientType,
  isPerformanceMode,
  normalizeEffectSelection,
  type BackgroundBlendMode,
  type BackgroundColorConfig,
  type BackgroundEffectId,
  type BackgroundLuminanceReport,
  type BackgroundMotionConfig,
  type BackgroundThemeConfig,
  type ColorStop,
  type GradientType,
  type HslColor,
  type NumericBound,
  type OklabColor,
  type OklchColor,
  type ParsedColor,
  type RgbColor,
} from './types';

// ---------------------------------------------------------------------------
// Internal Math & Numeric Helpers
// ---------------------------------------------------------------------------

const EPSILON_ACHROMATIC = 1e-6;
const EPSILON_GAMUT = 1e-6;
const GAMUT_BINARY_SEARCH_STEPS = 24;

/** Echo Ocean abyssal reference base (`#071028`, `7 16 40`) used for translucent alpha compositing. */
const ABYSS_FALLBACK_LUMINANCE = 0.0052;
/** Crisp light ink (`#f8fafc`) WCAG 2.1 relative luminance. */
const LIGHT_TEXT_LUMINANCE = 0.9554;
/** Deep Echo Ink (`#0d1830`, `13 24 48`) WCAG 2.1 relative luminance. */
const DARK_TEXT_LUMINANCE = 0.0098;
/** Default Echo Ocean ambient light triple (`--eo-ambient`). */
const DEFAULT_AMBIENT_RGB = '112 150 240';

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function clampBound(value: unknown, bound: NumericBound, fallback: number): number {
  const safeFallback = clamp(fallback, bound.min, bound.max);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return safeFallback;
  }
  return clamp(value, bound.min, bound.max);
}

function normalizeHue(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped === 360 || Object.is(wrapped, -0) ? 0 : wrapped;
}

function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function formatTrimmedNumber(value: number, decimals: number): string {
  const rounded = roundTo(value, decimals);
  return rounded.toFixed(decimals).replace(/\.?0+$/, '') || '0';
}

function clampRgbChannel(value: number): number {
  return Math.round(clamp(value, 0, 255));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// IEC 61966-2-1 sRGB <-> Linear sRGB Transfer Functions
// ---------------------------------------------------------------------------

/**
 * Converts a normalized sRGB component (`0..1`) to linear light (`0..1`)
 * using the exact IEC 61966-2-1 / CSS Color 4 / WCAG 2.1 transfer curve.
 */
export function srgbChannelToLinear(channel01: number): number {
  if (!Number.isFinite(channel01)) return 0;
  const sign = channel01 < 0 ? -1 : 1;
  const abs = Math.abs(channel01);
  if (abs <= 0.04045) {
    return channel01 / 12.92;
  }
  return sign * ((abs + 0.055) / 1.055) ** 2.4;
}

/**
 * Converts a linear-light sRGB component (`0..1`) to gamma-encoded sRGB (`0..1`)
 * using the exact IEC 61966-2-1 inverse transfer curve.
 */
export function linearToSrgbChannel(linear: number): number {
  if (!Number.isFinite(linear)) return 0;
  const sign = linear < 0 ? -1 : 1;
  const abs = Math.abs(linear);
  if (abs <= 0.0031308) {
    return 12.92 * linear;
  }
  return sign * (1.055 * abs ** (1 / 2.4) - 0.055);
}

// ---------------------------------------------------------------------------
// Exact Björn Ottosson Linear sRGB <-> OKLab <-> OKLCH Transforms
// ---------------------------------------------------------------------------

/** Converts an 8-bit sRGB color to Björn Ottosson OKLab coordinates. */
export function rgbToOklab(rgb: RgbColor): OklabColor {
  const r = srgbChannelToLinear(clamp(rgb.r, 0, 255) / 255);
  const g = srgbChannelToLinear(clamp(rgb.g, 0, 255) / 255);
  const b = srgbChannelToLinear(clamp(rgb.b, 0, 255) / 255);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: clamp(0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_, 0, 1),
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  };
}

/** Converts Björn Ottosson OKLab coordinates to unconstrained linear sRGB. */
export function oklabToLinearSrgb(lab: OklabColor): { r: number; g: number; b: number } {
  const l_ = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const m_ = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const s_ = lab.L - 0.0894841775 * lab.a - 1.2914855480 * lab.b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return {
    r: +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  };
}

/** Converts OKLab Cartesian coordinates to cylindrical OKLCH (`l: 0..1`, `c >= 0`, `h: 0..360`). */
export function oklabToOklch(lab: OklabColor): OklchColor {
  const c = Math.hypot(lab.a, lab.b);
  if (c < EPSILON_ACHROMATIC) {
    return { l: clamp(lab.L, 0, 1), c: 0, h: 0 };
  }
  const h = normalizeHue((Math.atan2(lab.b, lab.a) * 180) / Math.PI);
  return {
    l: clamp(lab.L, 0, 1),
    c,
    h,
  };
}

/** Converts cylindrical OKLCH coordinates to Cartesian OKLab. */
export function oklchToOklab(lch: OklchColor): OklabColor {
  const L = clamp(lch.l, 0, 1);
  const C = Math.max(0, Number.isFinite(lch.c) ? lch.c : 0);
  const rad = (normalizeHue(lch.h) * Math.PI) / 180;
  return {
    L,
    a: C * Math.cos(rad),
    b: C * Math.sin(rad),
  };
}

function isLinearInSrgbGamut(lin: { r: number; g: number; b: number }, eps = EPSILON_GAMUT): boolean {
  return (
    lin.r >= -eps &&
    lin.r <= 1 + eps &&
    lin.g >= -eps &&
    lin.g <= 1 + eps &&
    lin.b >= -eps &&
    lin.b <= 1 + eps
  );
}

/**
 * Computes the maximum in-gamut sRGB OKLCH chroma `C_max(L, H)` for a fixed
 * perceptual lightness `l` (`0..1`) and hue angle `h` (`0..360`) via binary search.
 */
export function maxSrgbChromaForLH(l: number, h: number): number {
  const L = clamp(l, 0, 1);
  if (L <= 0 || L >= 1) return 0;

  const rad = (normalizeHue(h) * Math.PI) / 180;
  const cosH = Math.cos(rad);
  const sinH = Math.sin(rad);

  let lo = 0;
  let hi = 0.4;
  for (let i = 0; i < GAMUT_BINARY_SEARCH_STEPS; i += 1) {
    const mid = (lo + hi) * 0.5;
    const lin = oklabToLinearSrgb({ L, a: mid * cosH, b: mid * sinH });
    if (isLinearInSrgbGamut(lin, 0)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Perceptually clips an OKLCH color into the sRGB gamut by binary-searching
 * chroma `c` downward while preserving exact lightness `l` and hue `h`.
 *
 * Prevents hue-twist mud and harsh RGB channel clipping when users push OKLCH
 * sliders past the sRGB cusp.
 */
export function clipOklchToSrgbGamut(lch: OklchColor): OklchColor {
  const L = clamp(lch.l, 0, 1);
  const H = normalizeHue(lch.h);
  const C = Math.max(0, Number.isFinite(lch.c) ? lch.c : 0);

  if (L <= 0) return { l: 0, c: 0, h: H };
  if (L >= 1) return { l: 1, c: 0, h: H };
  if (C <= EPSILON_ACHROMATIC) return { l: L, c: 0, h: H };

  const rad = (H * Math.PI) / 180;
  const cosH = Math.cos(rad);
  const sinH = Math.sin(rad);

  const direct = oklabToLinearSrgb({ L, a: C * cosH, b: C * sinH });
  if (isLinearInSrgbGamut(direct, EPSILON_GAMUT)) {
    return { l: L, c: C, h: H };
  }

  let lo = 0;
  let hi = C;
  for (let i = 0; i < GAMUT_BINARY_SEARCH_STEPS; i += 1) {
    const mid = (lo + hi) * 0.5;
    const lin = oklabToLinearSrgb({ L, a: mid * cosH, b: mid * sinH });
    if (isLinearInSrgbGamut(lin, 0)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return { l: L, c: lo, h: H };
}

// ---------------------------------------------------------------------------
// Core HEX / RGB / HSL / OKLCH Conversions
// ---------------------------------------------------------------------------

/** Returns true if the value is a valid 3-digit or 6-digit hexadecimal color string. */
export function isValidHexColor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());
}

/** Normalizes `#rgb` or `#rrggbb` to canonical lowercase `#rrggbb`, returning `fallback` on invalid input. */
export function normalizeHexColor(value: string, fallback = '#000000'): string {
  const trimmed = value.trim();
  const shortMatch = /^#?([0-9a-fA-F]{3})$/.exec(trimmed);
  if (shortMatch) {
    const [r, g, b] = shortMatch[1];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const fullMatch = /^#?([0-9a-fA-F]{6})$/.exec(trimmed);
  if (fullMatch) {
    return `#${fullMatch[1]}`.toLowerCase();
  }
  return fallback.toLowerCase();
}

/**
 * Parses a HEX color string (`#rgb`, `#rrggbb`, `#rgba`, or `#rrggbbaa`) into 8-bit RGB.
 * Falls back safely to `{ r: 0, g: 0, b: 0 }` on malformed input.
 */
export function hexToRgb(hex: string): RgbColor {
  const trimmed = typeof hex === 'string' ? hex.trim() : '';
  const body = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;

  if (/^[0-9a-fA-F]{3}$/.test(body) || /^[0-9a-fA-F]{4}$/.test(body)) {
    return {
      r: parseInt(body[0] + body[0], 16),
      g: parseInt(body[1] + body[1], 16),
      b: parseInt(body[2] + body[2], 16),
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(body) || /^[0-9a-fA-F]{8}$/.test(body)) {
    return {
      r: parseInt(body.slice(0, 2), 16),
      g: parseInt(body.slice(2, 4), 16),
      b: parseInt(body.slice(4, 6), 16),
    };
  }
  return { r: 0, g: 0, b: 0 };
}

/** Formats an 8-bit RGB triple into canonical lowercase `#rrggbb`. */
export function rgbToHex(rgb: RgbColor): string {
  const r = clampRgbChannel(rgb.r).toString(16).padStart(2, '0');
  const g = clampRgbChannel(rgb.g).toString(16).padStart(2, '0');
  const b = clampRgbChannel(rgb.b).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

/** Converts 8-bit sRGB (`0..255`) to standard cylindrical HSL (`h: 0..360`, `s: 0..100`, `l: 0..100`). */
export function rgbToHsl(rgb: RgbColor): HslColor {
  const r = clamp(rgb.r, 0, 255) / 255;
  const g = clamp(rgb.g, 0, 255) / 255;
  const b = clamp(rgb.b, 0, 255) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) * 0.5;

  if (delta === 0) {
    return { h: 0, s: 0, l: roundTo(l * 100, 2) };
  }

  const s = delta / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (max === r) {
    h = 60 * (((g - b) / delta) % 6);
  } else if (max === g) {
    h = 60 * ((b - r) / delta + 2);
  } else {
    h = 60 * ((r - g) / delta + 4);
  }

  return {
    h: roundTo(normalizeHue(h), 2),
    s: roundTo(clamp(s * 100, 0, 100), 2),
    l: roundTo(clamp(l * 100, 0, 100), 2),
  };
}

/** Converts cylindrical HSL (`h: 0..360`, `s: 0..100`, `l: 0..100`) to 8-bit sRGB (`0..255`). */
export function hslToRgb(hsl: HslColor): RgbColor {
  const h = normalizeHue(hsl.h);
  const s = clamp(hsl.s, 0, 100) / 100;
  const l = clamp(hsl.l, 0, 100) / 100;

  if (s === 0) {
    const v = clampRgbChannel(l * 255);
    return { r: v, g: v, b: v };
  }

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c * 0.5;

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hp < 1) {
    r1 = c;
    g1 = x;
  } else if (hp < 2) {
    r1 = x;
    g1 = c;
  } else if (hp < 3) {
    g1 = c;
    b1 = x;
  } else if (hp < 4) {
    g1 = x;
    b1 = c;
  } else if (hp < 5) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }

  return {
    r: clampRgbChannel((r1 + m) * 255),
    g: clampRgbChannel((g1 + m) * 255),
    b: clampRgbChannel((b1 + m) * 255),
  };
}

/** Converts 8-bit sRGB (`0..255`) to exact Björn Ottosson OKLCH (`l: 0..1`, `c: 0..0.37`, `h: 0..360`). */
export function rgbToOklch(rgb: RgbColor): OklchColor {
  return oklabToOklch(rgbToOklab(rgb));
}

/**
 * Converts OKLCH (`l: 0..1`, `c: 0..0.37`, `h: 0..360`) to 8-bit sRGB (`0..255`)
 * using exact perceptual chroma binary-search gamut clipping (L and H invariant).
 */
export function oklchToRgb(lch: OklchColor): RgbColor {
  const clipped = clipOklchToSrgbGamut(lch);
  const lin = oklabToLinearSrgb(oklchToOklab(clipped));
  return {
    r: clampRgbChannel(linearToSrgbChannel(clamp(lin.r, 0, 1)) * 255),
    g: clampRgbChannel(linearToSrgbChannel(clamp(lin.g, 0, 1)) * 255),
    b: clampRgbChannel(linearToSrgbChannel(clamp(lin.b, 0, 1)) * 255),
  };
}

/** Converts a HEX color string to exact Björn Ottosson OKLCH coordinates. */
export function hexToOklch(hex: string): OklchColor {
  return rgbToOklch(hexToRgb(hex));
}

/** Converts OKLCH coordinates to canonical lowercase `#rrggbb` with perceptual gamut clipping. */
export function oklchToHex(lch: OklchColor): string {
  return rgbToHex(oklchToRgb(lch));
}

// ---------------------------------------------------------------------------
// Universal Color Input Parser & CSS Formatters
// ---------------------------------------------------------------------------

function parseCssAngle(token: string): number | null {
  const cleaned = token.trim().toLowerCase();
  if (cleaned === 'none') return 0;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|rad|grad|turn)?$/.exec(cleaned);
  if (!match) return null;
  const raw = Number(match[1]);
  if (!Number.isFinite(raw)) return null;
  const unit = match[2] ?? 'deg';
  if (unit === 'rad') return normalizeHue((raw * 180) / Math.PI);
  if (unit === 'grad') return normalizeHue(raw * 0.9);
  if (unit === 'turn') return normalizeHue(raw * 360);
  return normalizeHue(raw);
}

function parseCssAlpha(token: string): number | null {
  const cleaned = token.trim().toLowerCase();
  if (cleaned === 'none') return 0;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(%?)$/.exec(cleaned);
  if (!match) return null;
  const raw = Number(match[1]);
  if (!Number.isFinite(raw)) return null;
  return clamp(match[2] === '%' ? raw / 100 : raw, 0, 1);
}

function parseRgbChannelToken(token: string): number | null {
  const cleaned = token.trim().toLowerCase();
  if (cleaned === 'none') return 0;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(%?)$/.exec(cleaned);
  if (!match) return null;
  const raw = Number(match[1]);
  if (!Number.isFinite(raw)) return null;
  return clampRgbChannel(match[2] === '%' ? (raw / 100) * 255 : raw);
}

function parsePercentToken(token: string, allowUnitlessMax = 100): number | null {
  const cleaned = token.trim().toLowerCase();
  if (cleaned === 'none') return 0;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(%?)$/.exec(cleaned);
  if (!match) return null;
  const raw = Number(match[1]);
  if (!Number.isFinite(raw)) return null;
  return clamp(raw, 0, allowUnitlessMax);
}

function splitCssFunctionalArgs(rawArgs: string): { channels: string[]; alphaToken?: string } | null {
  const trimmed = rawArgs.trim();
  if (!trimmed) return null;

  if (trimmed.includes('/')) {
    const parts = trimmed.split('/');
    if (parts.length !== 2) return null;
    const channels = parts[0].trim().split(/[\s,]+/).filter(Boolean);
    const alphaToken = parts[1].trim();
    if (channels.length !== 3 || !alphaToken) return null;
    return { channels, alphaToken };
  }

  const tokens = trimmed.includes(',')
    ? trimmed.split(',').map((t) => t.trim()).filter(Boolean)
    : trimmed.split(/\s+/).filter(Boolean);

  if (tokens.length === 3) {
    return { channels: tokens };
  }
  if (tokens.length === 4) {
    return { channels: tokens.slice(0, 3), alphaToken: tokens[3] };
  }
  return null;
}

function buildParsedColor(rgb: RgbColor, alpha?: number, explicitOklch?: OklchColor): ParsedColor {
  const safeRgb: RgbColor = {
    r: clampRgbChannel(rgb.r),
    g: clampRgbChannel(rgb.g),
    b: clampRgbChannel(rgb.b),
  };
  const result: ParsedColor = {
    hex: rgbToHex(safeRgb),
    rgb: safeRgb,
    hsl: rgbToHsl(safeRgb),
    oklch: explicitOklch ?? rgbToOklch(safeRgb),
  };
  if (alpha !== undefined) {
    result.alpha = roundTo(clamp(alpha, 0, 1), 4);
  }
  return result;
}

/**
 * Parses any user-entered HEX (`#rgb`, `#rrggbb`, `#rgba`, `#rrggbbaa`),
 * `rgb(...)` / `rgba(...)`, `hsl(...)` / `hsla(...)`, or `oklch(...)` string
 * into synchronized HEX, RGB, HSL, and OKLCH representations.
 *
 * Returns `null` when the input does not match a valid color syntax.
 */
export function parseColorInput(input: string): ParsedColor | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // 1. HEX (#rgb, #rgba, #rrggbb, #rrggbbaa, or bare 6-digit hex)
  const hexMatch = /^(#)?([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(trimmed);
  if (hexMatch) {
    const hasHash = Boolean(hexMatch[1]);
    const digits = hexMatch[2];
    if (hasHash || digits.length === 6) {
      let r = 0;
      let g = 0;
      let b = 0;
      let alpha: number | undefined;
      if (digits.length === 3 || digits.length === 4) {
        r = parseInt(digits[0] + digits[0], 16);
        g = parseInt(digits[1] + digits[1], 16);
        b = parseInt(digits[2] + digits[2], 16);
        if (digits.length === 4) {
          alpha = parseInt(digits[3] + digits[3], 16) / 255;
        }
      } else {
        r = parseInt(digits.slice(0, 2), 16);
        g = parseInt(digits.slice(2, 4), 16);
        b = parseInt(digits.slice(4, 6), 16);
        if (digits.length === 8) {
          alpha = parseInt(digits.slice(6, 8), 16) / 255;
        }
      }
      return buildParsedColor({ r, g, b }, alpha);
    }
  }

  // 2. Functional CSS color forms
  const fnMatch = /^([a-zA-Z]+)\(([^()]+)\)$/.exec(trimmed);
  if (!fnMatch) return null;

  const fnName = fnMatch[1].toLowerCase();
  const parsedArgs = splitCssFunctionalArgs(fnMatch[2]);
  if (!parsedArgs) return null;

  let alpha: number | undefined;
  if (parsedArgs.alphaToken !== undefined) {
    const parsedAlpha = parseCssAlpha(parsedArgs.alphaToken);
    if (parsedAlpha === null) return null;
    alpha = parsedAlpha;
  }

  if (fnName === 'rgb' || fnName === 'rgba') {
    const r = parseRgbChannelToken(parsedArgs.channels[0]);
    const g = parseRgbChannelToken(parsedArgs.channels[1]);
    const b = parseRgbChannelToken(parsedArgs.channels[2]);
    if (r === null || g === null || b === null) return null;
    return buildParsedColor({ r, g, b }, alpha);
  }

  if (fnName === 'hsl' || fnName === 'hsla') {
    const h = parseCssAngle(parsedArgs.channels[0]);
    const s = parsePercentToken(parsedArgs.channels[1], 100);
    const l = parsePercentToken(parsedArgs.channels[2], 100);
    if (h === null || s === null || l === null) return null;
    return buildParsedColor(hslToRgb({ h, s, l }), alpha);
  }

  if (fnName === 'oklch') {
    const lToken = parsedArgs.channels[0].trim().toLowerCase();
    const cToken = parsedArgs.channels[1].trim().toLowerCase();
    const h = parseCssAngle(parsedArgs.channels[2]);

    const lMatch = /^([+-]?(?:\d+\.?\d*|\.\d+))(%?)$/.exec(lToken);
    const cMatch = /^([+-]?(?:\d+\.?\d*|\.\d+))(%?)$/.exec(cToken);
    if ((!lMatch && lToken !== 'none') || (!cMatch && cToken !== 'none') || h === null) {
      return null;
    }

    const rawL = lToken === 'none' ? 0 : Number(lMatch![1]);
    const l = clamp(lMatch?.[2] === '%' ? rawL / 100 : rawL, 0, 1);

    const rawC = cToken === 'none' ? 0 : Number(cMatch![1]);
    const c = clamp(cMatch?.[2] === '%' ? (rawC / 100) * 0.4 : rawC, 0, 0.5);

    const clipped = clipOklchToSrgbGamut({ l, c, h });
    const rgb = oklchToRgb(clipped);
    return buildParsedColor(rgb, alpha, clipped);
  }

  return null;
}

/** Formats a HEX string or RGB object into canonical lowercase `#rrggbb`. */
export function formatHex(color: string | RgbColor): string {
  if (typeof color === 'string') {
    return normalizeHexColor(color, '#000000');
  }
  return rgbToHex(color);
}

/** Formats an RGB color as modern CSS `rgb(r g b)` or `rgb(r g b / alpha)`. */
export function formatRgb(rgb: RgbColor, opacity?: number): string {
  const r = clampRgbChannel(rgb.r);
  const g = clampRgbChannel(rgb.g);
  const b = clampRgbChannel(rgb.b);
  if (opacity !== undefined && Number.isFinite(opacity)) {
    const a = clamp(opacity, 0, 1);
    if (a < 0.999) {
      return `rgb(${r} ${g} ${b} / ${formatTrimmedNumber(a, 3)})`;
    }
  }
  return `rgb(${r} ${g} ${b})`;
}

/** Formats an HSL color as modern CSS `hsl(h s% l%)` or `hsl(h s% l% / alpha)`. */
export function formatHsl(hsl: HslColor, opacity?: number): string {
  const h = formatTrimmedNumber(normalizeHue(hsl.h), 1);
  const s = formatTrimmedNumber(clamp(hsl.s, 0, 100), 1);
  const l = formatTrimmedNumber(clamp(hsl.l, 0, 100), 1);
  if (opacity !== undefined && Number.isFinite(opacity)) {
    const a = clamp(opacity, 0, 1);
    if (a < 0.999) {
      return `hsl(${h} ${s}% ${l}% / ${formatTrimmedNumber(a, 3)})`;
    }
  }
  return `hsl(${h} ${s}% ${l}%)`;
}

/** Formats an OKLCH color as clean CSS Color 4 `oklch(L C H)` or `oklch(L C H / alpha)`. */
export function formatOklch(lch: OklchColor, opacity?: number): string {
  const l = formatTrimmedNumber(clamp(lch.l, 0, 1), 3);
  const c = formatTrimmedNumber(clamp(lch.c, 0, 0.37), 3);
  const h = formatTrimmedNumber(normalizeHue(lch.h), 1);
  if (opacity !== undefined && Number.isFinite(opacity)) {
    const a = clamp(opacity, 0, 1);
    if (a < 0.999) {
      return `oklch(${l} ${c} ${h} / ${formatTrimmedNumber(a, 3)})`;
    }
  }
  return `oklch(${l} ${c} ${h})`;
}

/**
 * Formats a HEX color and opacity (`0..1`) into either clean CSS Color 4
 * `oklch(L C H / alpha)` (when `useOklch` is true) or universally supported
 * `rgb(r g b / alpha)` (default).
 */
export function formatCssColor(hex: string, opacity = 1, useOklch = false): string {
  const alpha = clamp(opacity, 0, 1);
  const rgb = hexToRgb(hex);
  if (useOklch) {
    return formatOklch(rgbToOklch(rgb), alpha);
  }
  return formatRgb(rgb, alpha);
}

// ---------------------------------------------------------------------------
// WCAG 2.1 Relative Luminance, Readability & Ambient Light Extraction
// ---------------------------------------------------------------------------

/** Computes exact WCAG 2.1 relative luminance (`0..1`) for an 8-bit sRGB color. */
export function relativeLuminance(rgb: RgbColor): number {
  const r = srgbChannelToLinear(clamp(rgb.r, 0, 255) / 255);
  const g = srgbChannelToLinear(clamp(rgb.g, 0, 255) / 255);
  const b = srgbChannelToLinear(clamp(rgb.b, 0, 255) / 255);
  return clamp(0.2126 * r + 0.7152 * g + 0.0722 * b, 0, 1);
}

/** Computes exact WCAG 2.1 contrast ratio (`1..21`) between two relative luminances. */
export function wcagContrastRatio(lumA: number, lumB: number): number {
  const hi = Math.max(clamp(lumA, 0, 1), clamp(lumB, 0, 1));
  const lo = Math.min(clamp(lumA, 0, 1), clamp(lumB, 0, 1));
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Selects the most luminous, well-saturated non-black color from a theme
 * composition and returns it as a space-separated `"r g b"` string for
 * `--eo-ambient` foreground lighting harmony.
 */
export function extractAmbientRgb(config: BackgroundThemeConfig): string {
  const stops = config?.color?.stops;
  if (!Array.isArray(stops) || stops.length === 0) {
    return DEFAULT_AMBIENT_RGB;
  }

  const satFactor = clamp((config.color.saturation ?? 100) / 100, 0.35, 1.45);
  const brightFactor = clamp((config.color.brightness ?? 100) / 100, 0.65, 1.35);

  let bestScore = -1;
  let bestOklch: OklchColor | null = null;

  for (const stop of stops) {
    const lch = hexToOklch(stop.color);
    const alpha = clamp(stop.opacity ?? 1, 0, 1);
    const effectiveL = clamp(lch.l * brightFactor, 0, 1);
    const effectiveC = clamp(lch.c * satFactor, 0, 0.37);

    // Gaussian bell peaking at L = 0.66 so pitch-black anchors and blown-out whites
    // yield to luminous cyan, iris, emerald, pearl, or rose-gold accents.
    const lightnessAffinity = Math.exp(-(((effectiveL - 0.66) / 0.25) ** 2));
    const darkPenalty = effectiveL < 0.14 ? 0.12 : 1;
    const chromaWeight = 0.22 + effectiveC * 4.8;
    const alphaWeight = 0.2 + alpha * 0.8;

    const score = lightnessAffinity * chromaWeight * alphaWeight * darkPenalty;
    if (score > bestScore) {
      bestScore = score;
      bestOklch = { l: effectiveL, c: effectiveC, h: lch.h };
    }
  }

  if (!bestOklch) {
    return DEFAULT_AMBIENT_RGB;
  }

  // Lift ultra-dark compositions gently so rim shadows keep luminous elegance
  // while preserving exact hue identity.
  const tunedL = clamp(bestOklch.l < 0.52 ? 0.52 + bestOklch.l * 0.28 : bestOklch.l, 0.52, 0.82);
  const tunedC =
    bestOklch.c < 0.015
      ? bestOklch.c
      : clamp(bestOklch.c, 0.06, Math.min(0.19, maxSrgbChromaForLH(tunedL, bestOklch.h)));

  const rgb = oklchToRgb({ l: tunedL, c: tunedC, h: bestOklch.h });
  return `${rgb.r} ${rgb.g} ${rgb.b}`;
}

/**
 * Estimates composite WCAG 2.1 relative luminance and foreground readability
 * for a full `BackgroundThemeConfig`, accounting for stop distribution,
 * layer opacity, blend mode luminance shift, optical filters, and ambient glow.
 */
export function estimateBackgroundLuminance(
  config: BackgroundThemeConfig,
): BackgroundLuminanceReport {
  const color = config.color;
  const stops = Array.isArray(color.stops) && color.stops.length > 0 ? color.stops : [];

  if (stops.length === 0) {
    const contrastLightText = roundTo(wcagContrastRatio(ABYSS_FALLBACK_LUMINANCE, LIGHT_TEXT_LUMINANCE), 2);
    const contrastDarkText = roundTo(wcagContrastRatio(ABYSS_FALLBACK_LUMINANCE, DARK_TEXT_LUMINANCE), 2);
    return {
      luminance: roundTo(ABYSS_FALLBACK_LUMINANCE, 4),
      contrastLightText,
      contrastDarkText,
      readability: 'excellent',
      recommendedSurface: 'dark',
    };
  }

  const sorted = [...stops].sort((a, b) => a.position - b.position);
  let weightedLum = 0;
  let totalWeight = 0;
  let minStopLum = 1;
  let maxStopLum = 0;

  if (color.gradientType === 'mesh') {
    const spreadWeight = 0.55 + (clamp(color.gradientSpread, 10, 100) / 100) * 0.45;
    for (let i = 0; i < sorted.length; i += 1) {
      const stop = sorted[i];
      const stopLum = relativeLuminance(hexToRgb(stop.color));
      const alpha = clamp(stop.opacity, 0, 1);
      const effectiveLum = stopLum * alpha + ABYSS_FALLBACK_LUMINANCE * (1 - alpha);
      const weight = (i === 0 ? 1.25 : 1) * (0.35 + alpha * 0.65) * spreadWeight;
      weightedLum += effectiveLum * weight;
      totalWeight += weight;
      minStopLum = Math.min(minStopLum, effectiveLum);
      maxStopLum = Math.max(maxStopLum, effectiveLum);
    }
  } else {
    // Trapezoidal span integration along the 0..100 gradient axis
    for (let i = 0; i < sorted.length; i += 1) {
      const prevPos = i === 0 ? 0 : (sorted[i - 1].position + sorted[i].position) * 0.5;
      const nextPos = i === sorted.length - 1 ? 100 : (sorted[i].position + sorted[i + 1].position) * 0.5;
      const span = Math.max(4, nextPos - prevPos);
      const stop = sorted[i];
      const stopLum = relativeLuminance(hexToRgb(stop.color));
      const alpha = clamp(stop.opacity, 0, 1);
      const effectiveLum = stopLum * alpha + ABYSS_FALLBACK_LUMINANCE * (1 - alpha);

      weightedLum += effectiveLum * span;
      totalWeight += span;
      minStopLum = Math.min(minStopLum, effectiveLum);
      maxStopLum = Math.max(maxStopLum, effectiveLum);
    }
  }

  let lum = totalWeight > 0 ? weightedLum / totalWeight : ABYSS_FALLBACK_LUMINANCE;

  // Composite base layer and harmonic depth layer
  const baseAlpha = clamp(color.baseLayerOpacity, 0, 100) / 100;
  const depthAlpha = (clamp(color.depthLayerOpacity, 0, 100) / 100) * (clamp(color.blendIntensity, 0, 100) / 100);
  lum = lum * baseAlpha + ABYSS_FALLBACK_LUMINANCE * (1 - baseAlpha);

  const blendDelta = (() => {
    switch (color.blendMode) {
      case 'screen':
      case 'color-dodge':
      case 'lighten':
        return depthAlpha * 0.08 * (1 - lum);
      case 'multiply':
        return -depthAlpha * 0.14 * lum;
      case 'overlay':
      case 'soft-light':
        return depthAlpha * (lum > 0.45 ? 0.035 : -0.025);
      default:
        return 0;
    }
  })();
  lum = clamp(lum + blendDelta, 0, 1);

  // Master opacity composited over Echo Abyss dark stage
  const masterAlpha = clamp(color.opacity, 15, 100) / 100;
  lum = lum * masterAlpha + ABYSS_FALLBACK_LUMINANCE * (1 - masterAlpha);

  // Optical brightness, contrast, and ambient glow approximation (in perceptual sRGB space)
  const perceptualL = linearToSrgbChannel(lum);
  const brightScale = clamp(color.brightness, 50, 150) / 100;
  const contrastScale = clamp(color.contrast, 60, 150) / 100;
  const glowLift = (clamp(color.glow, 0, 100) / 100) * 0.045;
  const adjustedPerceptual = clamp((perceptualL * brightScale - 0.5) * contrastScale + 0.5 + glowLift, 0, 1);
  const compositeLum = clamp(srgbChannelToLinear(adjustedPerceptual), 0, 1);

  const contrastLightText = wcagContrastRatio(compositeLum, LIGHT_TEXT_LUMINANCE);
  const contrastDarkText = wcagContrastRatio(compositeLum, DARK_TEXT_LUMINANCE);
  const recommendedSurface: 'dark' | 'light' = contrastLightText >= contrastDarkText ? 'dark' : 'light';
  const bestContrast = Math.max(contrastLightText, contrastDarkText);

  // Penalize high-variance mid-tone gradients where bright hotspots clash with dark-surface text
  const luminanceSpan = maxStopLum - minStopLum;
  const effectiveContrast = luminanceSpan > 0.55 ? bestContrast * 0.84 : bestContrast;

  const readability: 'excellent' | 'good' | 'caution' =
    effectiveContrast >= 7 ? 'excellent' : effectiveContrast >= 4.5 ? 'good' : 'caution';

  return {
    luminance: roundTo(compositeLum, 4),
    contrastLightText: roundTo(contrastLightText, 2),
    contrastDarkText: roundTo(contrastDarkText, 2),
    readability,
    recommendedSurface,
  };
}

// ---------------------------------------------------------------------------
// Perceptual OKLCH Interpolation & Harmonic Palette Morphing
// ---------------------------------------------------------------------------

/**
 * Interpolates two OKLCH colors along the shortest hue arc while preserving
 * chromatic hue cleanly across achromatic black/white/gray endpoints.
 */
export function interpolateOklchColor(a: OklchColor, b: OklchColor, t: number): OklchColor {
  const u = clamp(t, 0, 1);
  const aAchromatic = a.c < 0.003;
  const bAchromatic = b.c < 0.003;

  const hA = aAchromatic && !bAchromatic ? b.h : normalizeHue(a.h);
  const hB = bAchromatic && !aAchromatic ? a.h : normalizeHue(b.h);

  const deltaH = ((hB - hA + 540) % 360) - 180;
  const h = normalizeHue(hA + deltaH * u);
  const l = clamp(a.l + (b.l - a.l) * u, 0, 1);
  const c = Math.max(0, a.c + (b.c - a.c) * u);

  return clipOklchToSrgbGamut({ l, c, h });
}

/**
 * Perceptually interpolates between two HEX colors in OKLCH space (shortest hue
 * path, zero grey dead-zones) and returns canonical lowercase `#rrggbb`.
 */
export function interpolateOklchHex(hexA: string, hexB: string, t: number): string {
  const u = clamp(t, 0, 1);
  if (u <= 0) return normalizeHexColor(hexA);
  if (u >= 1) return normalizeHexColor(hexB);
  return oklchToHex(interpolateOklchColor(hexToOklch(hexA), hexToOklch(hexB), u));
}

/** Options for tuning harmonic OKLCH morph stop derivation. */
export interface HarmonicMorphOptions {
  /** Base analogous hue shift in degrees (default `24`). */
  hueShiftDeg?: number;
  /** Peak midtone lightness pulse (default `0.032`). */
  lightnessPulse?: number;
  /** Subtle chroma multiplier (default `1.06`). */
  chromaScale?: number;
}

/**
 * Derives a harmonious secondary OKLCH-shifted stop array for `gradient-morph`
 * and `pearl-shimmer` layers. Keeps deep anchors grounded while letting midtones
 * and highlights drift analogously without turning muddy or oversaturated.
 */
export function deriveHarmonicMorphStops(
  stops: readonly ColorStop[],
  opts: HarmonicMorphOptions = {},
): ColorStop[] {
  const baseHueShift = opts.hueShiftDeg ?? 24;
  const lightnessPulse = opts.lightnessPulse ?? 0.032;
  const chromaScale = opts.chromaScale ?? 1.06;
  const count = Math.max(1, stops.length);

  return stops.map((stop, index) => {
    const progress = count > 1 ? index / (count - 1) : 0.5;
    const lch = hexToOklch(stop.color);

    // Analogous fan shift: anchors shift gently, luminous mid/high stops shimmer further
    const stopHueDelta = baseHueShift * (0.72 + progress * 0.56);
    const nextH = normalizeHue(lch.h + stopHueDelta);

    // Keep deep dark shadows grounded; let midtones breathe gently
    const midBell = Math.sin(progress * Math.PI);
    const lDelta = lch.l < 0.2 ? lightnessPulse * 0.35 : lightnessPulse * (0.45 + 0.55 * midBell);
    const nextL = clamp(lch.l + (index % 2 === 0 ? lDelta : -lDelta * 0.45), 0.06, 0.94);

    const maxC = maxSrgbChromaForLH(nextL, nextH);
    const rawC = lch.c < 0.008 ? lch.c : Math.min(lch.c * chromaScale, maxC * 0.94);

    const morphed: ColorStop = {
      id: stop.id,
      color: oklchToHex({ l: nextL, c: rawC, h: nextH }),
      position: clamp(stop.position, BG_BOUNDS.stopPosition.min, BG_BOUNDS.stopPosition.max),
      opacity: roundTo(clamp(stop.opacity, BG_BOUNDS.stopOpacity.min, BG_BOUNDS.stopOpacity.max), 3),
    };

    if (typeof stop.x === 'number' && Number.isFinite(stop.x)) {
      const angle = (index * 1.618 + 0.6) * Math.PI;
      morphed.x = roundTo(clamp(stop.x + Math.cos(angle) * 9, 6, 94), 1);
    }
    if (typeof stop.y === 'number' && Number.isFinite(stop.y)) {
      const angle = (index * 1.618 + 0.6) * Math.PI;
      morphed.y = roundTo(clamp(stop.y + Math.sin(angle) * 9, 6, 94), 1);
    }

    return morphed;
  });
}

// ---------------------------------------------------------------------------
// Curated OKLCH Museum-Grade Random Theme Generator
// ---------------------------------------------------------------------------

function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSeedFallback(): number {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    return buf[0] || 0x9e3779b9;
  }
  return ((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0) || 0x9e3779b9;
}

/**
 * Applies a perceptual hue-aware chroma cap so yellow-green/olive regions
 * (`75..145 deg`) stay silky and botanical instead of garish neon mud.
 */
function capChromaForElegance(l: number, c: number, h: number): number {
  const hue = normalizeHue(h);
  const srgbCeiling = maxSrgbChromaForLH(l, hue);
  const yellowGreenDamp =
    hue >= 75 && hue <= 145
      ? 0.72 + 0.28 * Math.abs((hue - 110) / 35)
      : 1;
  return clamp(Math.min(c * yellowGreenDamp, srgbCeiling * 0.92), 0, 0.24);
}

/** Generates well-separated organic mesh focal coordinates using a golden-angle layout. */
function generateMeshCoordinates(
  count: number,
  rand: () => number,
): Array<{ x: number; y: number }> {
  const basePhase = rand() * Math.PI * 2;
  const coords: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i += 1) {
    if (i === 0) {
      coords.push({
        x: Math.round(18 + rand() * 18),
        y: Math.round(72 + rand() * 16),
      });
      continue;
    }
    const angle = basePhase + i * 2.3999632297; // golden angle in radians
    const radius = 24 + ((i / Math.max(1, count - 1)) * 18) + (rand() - 0.5) * 8;
    const x = clamp(Math.round(50 + Math.cos(angle) * radius), 10, 90);
    const y = clamp(Math.round(50 + Math.sin(angle) * radius), 10, 90);
    coords.push({ x, y });
  }
  return coords;
}

interface HarmonyBlueprint {
  readonly gradientChoices: readonly GradientType[];
  readonly blendChoices: readonly BackgroundBlendMode[];
  readonly effectCombos: readonly (readonly BackgroundEffectId[])[];
  readonly minStops: number;
  readonly maxStops: number;
  readonly buildStops: (count: number, rand: () => number) => Array<{ l: number; c: number; h: number; opacity: number }>;
  readonly optical: (rand: () => number) => {
    brightness: number;
    saturation: number;
    contrast: number;
    blur: number;
    glow: number;
    colorIntensity: number;
    blendIntensity: number;
    depthLayerOpacity: number;
    grainOpacity: number;
  };
}

const HARMONY_BLUEPRINTS: readonly HarmonyBlueprint[] = [
  // 1. Deep Abyssal Pearl — deep marine obsidian, pelagic cyan, iris mist, silver-pearl sheen
  {
    gradientChoices: ['mesh', 'radial', 'linear'],
    blendChoices: ['screen', 'soft-light', 'overlay'],
    effectCombos: [
      ['pearl-shimmer', 'ambient-glow', 'light-drift'],
      ['pearl-shimmer', 'liquid-flow', 'ambient-glow'],
      ['ambient-glow', 'color-breathing', 'pearl-shimmer'],
    ],
    minStops: 4,
    maxStops: 5,
    buildStops: (count, rand) => {
      const baseH = 248 + (rand() - 0.5) * 30; // deep indigo-sapphire
      const accentH = normalizeHue(baseH - 44 + (rand() - 0.5) * 22); // nacre cyan-lagoon
      const irisH = normalizeHue(baseH + 34 + (rand() - 0.5) * 20); // misty iris
      return Array.from({ length: count }, (_, i) => {
        const t = i / (count - 1);
        const curve = t ** 1.45;
        const l = 0.11 + curve * 0.51 + (rand() - 0.5) * 0.025;
        const h = t < 0.45 ? baseH : t < 0.78 ? accentH : irisH;
        const c = t < 0.25 ? 0.04 + rand() * 0.025 : t > 0.85 ? 0.045 + rand() * 0.035 : 0.105 + rand() * 0.045;
        return { l: clamp(l, 0.1, 0.66), c, h, opacity: i === 0 ? 1 : roundTo(0.86 + rand() * 0.14, 2) };
      });
    },
    optical: (rand) => ({
      brightness: Math.round(96 + rand() * 7),
      saturation: Math.round(102 + rand() * 14),
      contrast: Math.round(100 + rand() * 8),
      blur: Math.round(rand() * 4),
      glow: Math.round(40 + rand() * 24),
      colorIntensity: Math.round(76 + rand() * 14),
      blendIntensity: Math.round(46 + rand() * 22),
      depthLayerOpacity: Math.round(56 + rand() * 22),
      grainOpacity: Math.round(14 + rand() * 10),
    }),
  },

  // 2. Boreal Aurora — arctic midnight sky, emerald-mint ribbons, glacial cyan, high-altitude violet
  {
    gradientChoices: ['linear', 'mesh'],
    blendChoices: ['screen', 'lighten', 'soft-light'],
    effectCombos: [
      ['aurora', 'light-drift', 'color-breathing'],
      ['aurora', 'ambient-glow'],
      ['aurora', 'pearl-shimmer', 'light-drift'],
    ],
    minStops: 4,
    maxStops: 6,
    buildStops: (count, rand) => {
      const skyH = 252 + (rand() - 0.5) * 24;
      const auroraH = 166 + (rand() - 0.5) * 22; // boreal emerald-teal
      const cyanH = 198 + (rand() - 0.5) * 18;
      const violetH = 294 + (rand() - 0.5) * 22;
      const hues = [skyH, normalizeHue(skyH - 16), auroraH, cyanH, violetH, normalizeHue(skyH + 10)];
      return Array.from({ length: count }, (_, i) => {
        const t = i / (count - 1);
        const l =
          i === 0 || i === count - 1
            ? 0.12 + rand() * 0.05
            : 0.2 + Math.sin(t * Math.PI) * 0.34 + (rand() - 0.5) * 0.03;
        const c = i === 0 ? 0.04 + rand() * 0.02 : 0.1 + rand() * 0.05;
        return { l: clamp(l, 0.11, 0.62), c, h: hues[i % hues.length], opacity: i === 0 ? 1 : roundTo(0.84 + rand() * 0.16, 2) };
      });
    },
    optical: (rand) => ({
      brightness: Math.round(96 + rand() * 8),
      saturation: Math.round(104 + rand() * 15),
      contrast: Math.round(101 + rand() * 8),
      blur: Math.round(rand() * 5),
      glow: Math.round(44 + rand() * 22),
      colorIntensity: Math.round(78 + rand() * 14),
      blendIntensity: Math.round(50 + rand() * 22),
      depthLayerOpacity: Math.round(58 + rand() * 20),
      grainOpacity: Math.round(14 + rand() * 10),
    }),
  },

  // 3. Liquid Jewel Mesh — molten cobalt, amethyst orchid, velvet rose, warm champagne mist
  {
    gradientChoices: ['mesh'],
    blendChoices: ['overlay', 'soft-light', 'screen'],
    effectCombos: [
      ['liquid-flow', 'gradient-morph'],
      ['liquid-flow', 'ambient-glow', 'color-flow'],
      ['liquid-flow', 'pearl-shimmer', 'gradient-morph'],
    ],
    minStops: 4,
    maxStops: 6,
    buildStops: (count, rand) => {
      const anchorH = 262 + (rand() - 0.5) * 38;
      const sweep = rand() > 0.5 ? 1 : -1;
      return Array.from({ length: count }, (_, i) => {
        const t = i / (count - 1);
        const curve = t ** 1.4;
        const h = normalizeHue(anchorH + sweep * t * (92 + rand() * 34));
        const l = 0.13 + curve * 0.49 + (rand() - 0.5) * 0.03;
        const c = 0.06 + Math.sin(t * Math.PI * 0.85) * 0.105 + rand() * 0.02;
        return { l: clamp(l, 0.12, 0.66), c, h, opacity: i === 0 ? 1 : roundTo(0.85 + rand() * 0.15, 2) };
      });
    },
    optical: (rand) => ({
      brightness: Math.round(96 + rand() * 7),
      saturation: Math.round(104 + rand() * 14),
      contrast: Math.round(100 + rand() * 8),
      blur: Math.round(2 + rand() * 5),
      glow: Math.round(40 + rand() * 22),
      colorIntensity: Math.round(80 + rand() * 12),
      blendIntensity: Math.round(48 + rand() * 22),
      depthLayerOpacity: Math.round(58 + rand() * 20),
      grainOpacity: Math.round(16 + rand() * 10),
    }),
  },

  // 4. Twilight Iridescence — velvet plum-indigo, ionized periwinkle, dusty rose stardust, lilac core
  {
    gradientChoices: ['conic', 'linear', 'radial'],
    blendChoices: ['screen', 'soft-light', 'overlay'],
    effectCombos: [
      ['color-breathing', 'pearl-shimmer', 'light-drift'],
      ['ambient-glow', 'light-drift', 'color-breathing'],
      ['color-flow', 'pearl-shimmer', 'ambient-glow'],
    ],
    minStops: 3,
    maxStops: 5,
    buildStops: (count, rand) => {
      const plumH = 300 + (rand() - 0.5) * 26;
      const indigoH = 266 + (rand() - 0.5) * 20;
      const roseH = 344 + (rand() - 0.5) * 22;
      const pearlH = 20 + (rand() - 0.5) * 22;
      const palette = [plumH, indigoH, normalizeHue(plumH + 22), roseH, pearlH];
      return Array.from({ length: count }, (_, i) => {
        const t = i / (count - 1);
        const curve = t ** 1.45;
        const l = 0.13 + curve * 0.46 + (rand() - 0.5) * 0.03;
        const c = i === 0 ? 0.05 + rand() * 0.025 : 0.09 + rand() * 0.05;
        return { l: clamp(l, 0.12, 0.64), c, h: palette[i % palette.length], opacity: i === 0 ? 1 : roundTo(0.86 + rand() * 0.14, 2) };
      });
    },
    optical: (rand) => ({
      brightness: Math.round(95 + rand() * 8),
      saturation: Math.round(100 + rand() * 14),
      contrast: Math.round(100 + rand() * 7),
      blur: Math.round(rand() * 4),
      glow: Math.round(38 + rand() * 24),
      colorIntensity: Math.round(74 + rand() * 15),
      blendIntensity: Math.round(44 + rand() * 22),
      depthLayerOpacity: Math.round(54 + rand() * 22),
      grainOpacity: Math.round(15 + rand() * 10),
    }),
  },

  // 5. Soft Crystalline Quartz — luminous pearl-quartz mist OR smoky deep rosewood-glacier crystal
  {
    gradientChoices: ['radial', 'mesh', 'conic'],
    blendChoices: ['soft-light', 'screen', 'overlay'],
    effectCombos: [
      ['pearl-shimmer', 'light-drift', 'color-breathing'],
      ['pearl-shimmer', 'ambient-glow'],
      ['pearl-shimmer', 'color-flow', 'light-drift'],
    ],
    minStops: 3,
    maxStops: 5,
    buildStops: (count, rand) => {
      const coolCrystal = rand() > 0.5;
      const luminousMist = rand() > 0.45;
      const baseH = coolCrystal ? 228 + (rand() - 0.5) * 22 : 348 + (rand() - 0.5) * 26;
      const midH = coolCrystal ? 202 + (rand() - 0.5) * 18 : 14 + (rand() - 0.5) * 22;
      const highlightH = coolCrystal ? 255 + (rand() - 0.5) * 22 : 48 + (rand() - 0.5) * 20;
      return Array.from({ length: count }, (_, i) => {
        const t = i / (count - 1);
        const h = t < 0.35 ? baseH : t < 0.72 ? midH : highlightH;
        if (luminousMist) {
          // Airy pearl-quartz mist optimized for crisp dark ink contrast
          const l = 0.78 + t * 0.16 + (rand() - 0.5) * 0.02;
          const c = 0.025 + Math.sin(t * Math.PI) * 0.04 + rand() * 0.015;
          return { l: clamp(l, 0.76, 0.96), c, h, opacity: i === 0 ? 1 : roundTo(0.86 + rand() * 0.14, 2) };
        }
        // Deep smoky crystal optimized for crisp light ink contrast
        const curve = t ** 1.45;
        const l = 0.14 + curve * 0.44 + (rand() - 0.5) * 0.025;
        const c = 0.055 + Math.sin(t * Math.PI * 0.9) * 0.055 + rand() * 0.015;
        return { l: clamp(l, 0.13, 0.62), c, h, opacity: i === 0 ? 1 : roundTo(0.86 + rand() * 0.14, 2) };
      });
    },
    optical: (rand) => ({
      brightness: Math.round(98 + rand() * 6),
      saturation: Math.round(98 + rand() * 14),
      contrast: Math.round(99 + rand() * 7),
      blur: Math.round(rand() * 5),
      glow: Math.round(42 + rand() * 22),
      colorIntensity: Math.round(72 + rand() * 15),
      blendIntensity: Math.round(42 + rand() * 22),
      depthLayerOpacity: Math.round(52 + rand() * 20),
      grainOpacity: Math.round(14 + rand() * 10),
    }),
  },
];

/**
 * Generates a museum-grade, harmonious random `BackgroundThemeConfig` across
 * five curated OKLCH harmonies (Deep Abyssal Pearl, Boreal Aurora, Liquid Jewel
 * Mesh, Twilight Iridescence, Soft Crystalline Quartz) with 3-6 well-spaced
 * stops, smooth luminance progression, balanced optical controls, and compatible
 * motion and light layers.
 *
 * Pass a numeric `seed` for deterministic generation, or omit for fresh entropy.
 */
export function generateHarmoniousTheme(seed?: number): BackgroundThemeConfig {
  const effectiveSeed =
    typeof seed === 'number' && Number.isFinite(seed) ? Math.floor(seed) : randomSeedFallback();
  const rand = createMulberry32(effectiveSeed);

  const blueprint = HARMONY_BLUEPRINTS[Math.floor(rand() * HARMONY_BLUEPRINTS.length)];
  const gradientType =
    blueprint.gradientChoices[Math.floor(rand() * blueprint.gradientChoices.length)];
  const blendMode = blueprint.blendChoices[Math.floor(rand() * blueprint.blendChoices.length)];
  const effects = [
    ...blueprint.effectCombos[Math.floor(rand() * blueprint.effectCombos.length)],
  ];

  const stopCount = clamp(
    blueprint.minStops + Math.floor(rand() * (blueprint.maxStops - blueprint.minStops + 1)),
    3,
    6,
  );
  const rawStops = blueprint.buildStops(stopCount, rand);
  const meshCoords = generateMeshCoordinates(stopCount, rand);

  const stops: ColorStop[] = rawStops.map((entry, idx) => {
    const basePos = stopCount === 1 ? 50 : (idx / (stopCount - 1)) * 100;
    const jitter = idx === 0 || idx === stopCount - 1 ? 0 : (rand() - 0.5) * 9;
    const position = Math.round(clamp(basePos + jitter, 0, 100));
    const safeC = capChromaForElegance(entry.l, entry.c, entry.h);

    return {
      id: `stop-${idx + 1}`,
      color: oklchToHex({ l: entry.l, c: safeC, h: normalizeHue(entry.h) }),
      position,
      opacity: roundTo(clamp(entry.opacity, 0.65, 1), 2),
      x: meshCoords[idx].x,
      y: meshCoords[idx].y,
    };
  });

  // Ensure monotonic non-decreasing stop positions
  for (let i = 1; i < stops.length; i += 1) {
    if (stops[i].position <= stops[i - 1].position) {
      stops[i].position = clamp(stops[i - 1].position + 6, 0, 100);
    }
  }
  stops[0].position = 0;
  stops[stops.length - 1].position = 100;

  const opt = blueprint.optical(rand);
  const hasShimmer = effects.includes('pearl-shimmer');
  const hasGlow = effects.includes('ambient-glow') || effects.includes('light-drift');

  return {
    color: {
      gradientType,
      stops,
      gradientAngle: Math.round(rand() * 360),
      centerX: Math.round(34 + rand() * 32),
      centerY: Math.round(30 + rand() * 36),
      gradientSpread: Math.round(58 + rand() * 28),
      blendMode,
      blendIntensity: opt.blendIntensity,
      baseLayerOpacity: 100,
      depthLayerOpacity: opt.depthLayerOpacity,
      brightness: opt.brightness,
      saturation: opt.saturation,
      contrast: opt.contrast,
      opacity: 100,
      blur: opt.blur,
      glow: opt.glow,
      colorIntensity: opt.colorIntensity,
    },
    motion: {
      effects: normalizeEffectSelection(effects),
      animationSpeed: roundTo(0.55 + rand() * 0.6, 2),
      motionIntensity: Math.round(42 + rand() * 28),
      lightIntensity: Math.round(hasGlow ? 48 + rand() * 26 : 34 + rand() * 22),
      movementDirection: Math.round(rand() * 360),
      movementScale: Math.round(84 + rand() * 44),
      glowRadius: Math.round(44 + rand() * 32),
      shimmerIntensity: Math.round(hasShimmer ? 42 + rand() * 28 : 20 + rand() * 20),
      animationSmoothness: Math.round(78 + rand() * 16),
      performanceMode: 'auto',
    },
    grainOpacity: opt.grainOpacity,
  };
}

// ---------------------------------------------------------------------------
// Deep Defensive Theme Cloning & Sanitization
// ---------------------------------------------------------------------------

function sanitizeStopId(rawId: unknown, index: number, used: Set<string>): string {
  if (typeof rawId === 'string') {
    const cleaned = rawId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 64);
    if (THEME_ID_PATTERN.test(cleaned) && !used.has(cleaned)) {
      used.add(cleaned);
      return cleaned;
    }
  }
  let candidate = `stop-${index + 1}`;
  let suffix = index + 1;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `stop-${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

function sanitizeColorStop(
  raw: unknown,
  fallback: ColorStop,
  index: number,
  usedIds: Set<string>,
): ColorStop {
  const src = isRecord(raw) ? raw : {};
  const fallbackColor = normalizeHexColor(fallback.color, '#0a1628');
  const rawColor = typeof src.color === 'string' ? src.color.trim() : '';
  const color = isValidHexColor(rawColor) ? normalizeHexColor(rawColor, fallbackColor) : fallbackColor;

  const stop: ColorStop = {
    id: sanitizeStopId(src.id, index, usedIds),
    color,
    position: roundTo(clampBound(src.position, BG_BOUNDS.stopPosition, fallback.position), 2),
    opacity: roundTo(clampBound(src.opacity, BG_BOUNDS.stopOpacity, fallback.opacity), 3),
  };

  if (typeof src.x === 'number' && Number.isFinite(src.x)) {
    stop.x = roundTo(clamp(src.x, BG_BOUNDS.stopX.min, BG_BOUNDS.stopX.max), 2);
  } else if (typeof fallback.x === 'number' && Number.isFinite(fallback.x)) {
    stop.x = roundTo(clamp(fallback.x, BG_BOUNDS.stopX.min, BG_BOUNDS.stopX.max), 2);
  }

  if (typeof src.y === 'number' && Number.isFinite(src.y)) {
    stop.y = roundTo(clamp(src.y, BG_BOUNDS.stopY.min, BG_BOUNDS.stopY.max), 2);
  } else if (typeof fallback.y === 'number' && Number.isFinite(fallback.y)) {
    stop.y = roundTo(clamp(fallback.y, BG_BOUNDS.stopY.min, BG_BOUNDS.stopY.max), 2);
  }

  return stop;
}

/** Creates an isolated deep clone of a `BackgroundThemeConfig`. */
export function cloneThemeConfig(config: BackgroundThemeConfig): BackgroundThemeConfig {
  const cloned: BackgroundThemeConfig = {
    color: {
      ...config.color,
      stops: config.color.stops.map((stop) => {
        const copy: ColorStop = {
          id: stop.id,
          color: stop.color,
          position: stop.position,
          opacity: stop.opacity,
        };
        if (stop.x !== undefined) copy.x = stop.x;
        if (stop.y !== undefined) copy.y = stop.y;
        return copy;
      }),
    },
    motion: {
      ...config.motion,
      effects: [...config.motion.effects],
    },
  };
  if (config.grainOpacity !== undefined) {
    cloned.grainOpacity = config.grainOpacity;
  }
  return cloned;
}

/**
 * Deeply validates, allowlist-filters, and clamps an untrusted `raw` config
 * against `BG_BOUNDS` and schema invariants, falling back per-field to
 * `fallback` so the returned config is always 100% safe for both rendering and
 * backend persistence.
 *
 * Strips all unknown keys and never mutates either `raw` or `fallback`.
 */
export function sanitizeThemeConfig(
  raw: unknown,
  fallback: BackgroundThemeConfig,
): BackgroundThemeConfig {
  const root = isRecord(raw) ? raw : {};
  const rawColor = isRecord(root.color) ? root.color : {};
  const rawMotion = isRecord(root.motion) ? root.motion : {};

  const fbColor = fallback.color;
  const fbMotion = fallback.motion;
  const fbStops: ColorStop[] =
    Array.isArray(fbColor.stops) && fbColor.stops.length >= MIN_STOPS
      ? fbColor.stops
      : [
          { id: 'stop-1', color: '#071028', position: 0, opacity: 1, x: 20, y: 80 },
          { id: 'stop-2', color: '#1b4965', position: 100, opacity: 1, x: 80, y: 20 },
        ];

  const usedIds = new Set<string>();
  const sourceStops =
    Array.isArray(rawColor.stops) && rawColor.stops.length >= MIN_STOPS
      ? rawColor.stops.slice(0, MAX_STOPS)
      : fbStops.slice(0, MAX_STOPS);

  const stops: ColorStop[] = sourceStops.map((entry, idx) => {
    const fbStop = fbStops[Math.min(idx, fbStops.length - 1)];
    return sanitizeColorStop(entry, fbStop, idx, usedIds);
  });

  const color: BackgroundColorConfig = {
    gradientType: isGradientType(rawColor.gradientType)
      ? rawColor.gradientType
      : isGradientType(fbColor.gradientType)
        ? fbColor.gradientType
        : 'mesh',
    stops,
    gradientAngle: roundTo(clampBound(rawColor.gradientAngle, BG_BOUNDS.gradientAngle, fbColor.gradientAngle), 2),
    centerX: roundTo(clampBound(rawColor.centerX, BG_BOUNDS.centerX, fbColor.centerX), 2),
    centerY: roundTo(clampBound(rawColor.centerY, BG_BOUNDS.centerY, fbColor.centerY), 2),
    gradientSpread: roundTo(clampBound(rawColor.gradientSpread, BG_BOUNDS.gradientSpread, fbColor.gradientSpread), 2),
    blendMode: isBackgroundBlendMode(rawColor.blendMode)
      ? rawColor.blendMode
      : isBackgroundBlendMode(fbColor.blendMode)
        ? fbColor.blendMode
        : 'screen',
    blendIntensity: roundTo(clampBound(rawColor.blendIntensity, BG_BOUNDS.blendIntensity, fbColor.blendIntensity), 2),
    baseLayerOpacity: roundTo(
      clampBound(rawColor.baseLayerOpacity, BG_BOUNDS.baseLayerOpacity, fbColor.baseLayerOpacity),
      2,
    ),
    depthLayerOpacity: roundTo(
      clampBound(rawColor.depthLayerOpacity, BG_BOUNDS.depthLayerOpacity, fbColor.depthLayerOpacity),
      2,
    ),
    brightness: roundTo(clampBound(rawColor.brightness, BG_BOUNDS.brightness, fbColor.brightness), 2),
    saturation: roundTo(clampBound(rawColor.saturation, BG_BOUNDS.saturation, fbColor.saturation), 2),
    contrast: roundTo(clampBound(rawColor.contrast, BG_BOUNDS.contrast, fbColor.contrast), 2),
    opacity: roundTo(clampBound(rawColor.opacity, BG_BOUNDS.opacity, fbColor.opacity), 2),
    blur: roundTo(clampBound(rawColor.blur, BG_BOUNDS.blur, fbColor.blur), 2),
    glow: roundTo(clampBound(rawColor.glow, BG_BOUNDS.glow, fbColor.glow), 2),
    colorIntensity: roundTo(clampBound(rawColor.colorIntensity, BG_BOUNDS.colorIntensity, fbColor.colorIntensity), 2),
  };

  const candidateEffects = Array.isArray(rawMotion.effects) && rawMotion.effects.length > 0
    ? rawMotion.effects
    : fbMotion.effects;

  const motion: BackgroundMotionConfig = {
    effects: normalizeEffectSelection(candidateEffects),
    animationSpeed: roundTo(
      clampBound(rawMotion.animationSpeed, BG_BOUNDS.animationSpeed, fbMotion.animationSpeed),
      3,
    ),
    motionIntensity: roundTo(
      clampBound(rawMotion.motionIntensity, BG_BOUNDS.motionIntensity, fbMotion.motionIntensity),
      2,
    ),
    lightIntensity: roundTo(
      clampBound(rawMotion.lightIntensity, BG_BOUNDS.lightIntensity, fbMotion.lightIntensity),
      2,
    ),
    movementDirection: roundTo(
      clampBound(rawMotion.movementDirection, BG_BOUNDS.movementDirection, fbMotion.movementDirection),
      2,
    ),
    movementScale: roundTo(
      clampBound(rawMotion.movementScale, BG_BOUNDS.movementScale, fbMotion.movementScale),
      2,
    ),
    glowRadius: roundTo(clampBound(rawMotion.glowRadius, BG_BOUNDS.glowRadius, fbMotion.glowRadius), 2),
    shimmerIntensity: roundTo(
      clampBound(rawMotion.shimmerIntensity, BG_BOUNDS.shimmerIntensity, fbMotion.shimmerIntensity),
      2,
    ),
    animationSmoothness: roundTo(
      clampBound(rawMotion.animationSmoothness, BG_BOUNDS.animationSmoothness, fbMotion.animationSmoothness),
      2,
    ),
    performanceMode: isPerformanceMode(rawMotion.performanceMode)
      ? rawMotion.performanceMode
      : isPerformanceMode(fbMotion.performanceMode)
        ? fbMotion.performanceMode
        : 'auto',
  };

  const sanitized: BackgroundThemeConfig = { color, motion };

  if (typeof root.grainOpacity === 'number' && Number.isFinite(root.grainOpacity)) {
    sanitized.grainOpacity = roundTo(
      clamp(root.grainOpacity, BG_BOUNDS.grainOpacity.min, BG_BOUNDS.grainOpacity.max),
      2,
    );
  } else if (typeof fallback.grainOpacity === 'number' && Number.isFinite(fallback.grainOpacity)) {
    sanitized.grainOpacity = roundTo(
      clamp(fallback.grainOpacity, BG_BOUNDS.grainOpacity.min, BG_BOUNDS.grainOpacity.max),
      2,
    );
  }

  return sanitized;
}
