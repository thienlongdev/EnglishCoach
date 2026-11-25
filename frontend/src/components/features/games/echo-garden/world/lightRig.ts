/**
 * Echo Garden — the ONE authoritative environment light rig (pure math, no rendering).
 *
 * The pre-rendered world (Blender) is lit by a warm key light from the screen-left quadrant. Runtime
 * lighting therefore never moves the key light to the other side: the sun travels down the LEFT side
 * of the sky toward sunset (lower, warmer, longer and softer shadows), then sets below the cloud sea
 * while the moon rises on the same side for night (cool, dim, faint shadows). Every quantity below is
 * a smooth function of the time-of-day weights, so a transition is one continuous change of the whole
 * world (sky, sun / moon, grading, shadows, local lights, magic), never a crossfade of three pictures.
 */
export type TimeOfDay = "day" | "sunset" | "night";
export type Weights = Record<TimeOfDay, number>;
type RGB = [number, number, number];

export interface Look {
  /** scene grade: exposure, saturation, split tone (shadows / highlights) */
  exposure: number;
  saturation: number;
  shadowTint: RGB;
  highTint: RGB;
  /** atmospheric scattering veil around the sun / moon (screen space) */
  haze: number;
  hazeColor: RGB;
  /** haze radius as a fraction of max(viewport w, h) */
  hazeRadius: number;
  /** local lights (lanterns, windows, heartwood) strength */
  lights: number;
  /** cast shadows: opacity and length (1 = high sun) */
  shadowAlpha: number;
  shadowStretch: number;
  /** sky: glow around the sun, warm horizon band, stars, moonlit vignette */
  sunGlow: number;
  horizon: number;
  stars: number;
  vignette: number;
  /** emissive art (windows, lamp, heartwood) */
  glow: number;
}

export const LOOKS: Record<TimeOfDay, Look> = {
  day: {
    exposure: 1.0, saturation: 1.02, shadowTint: [0.965, 0.985, 1.035], highTint: [1.03, 1.01, 0.975],
    haze: 0.13, hazeColor: [1.0, 0.95, 0.84], hazeRadius: 0.6, lights: 0, shadowAlpha: 1.0, shadowStretch: 1.0,
    sunGlow: 0.55, horizon: 0.18, stars: 0, vignette: 0, glow: 0,
  },
  sunset: {
    // a lower sun: less light on the ground overall, gold on the lit faces, violet in the shade
    exposure: 0.92, saturation: 1.06, shadowTint: [0.74, 0.67, 0.92], highTint: [1.19, 0.99, 0.77],
    haze: 0.4, hazeColor: [1.0, 0.63, 0.35], hazeRadius: 0.72, lights: 0.45, shadowAlpha: 0.86, shadowStretch: 1.65,
    sunGlow: 1.0, horizon: 0.7, stars: 0.12, vignette: 0.12, glow: 0.6,
  },
  night: {
    exposure: 0.6, saturation: 0.62, shadowTint: [0.5, 0.62, 1.02], highTint: [0.8, 0.9, 1.15],
    haze: 0.1, hazeColor: [0.58, 0.68, 1.0], hazeRadius: 0.45, lights: 1.0, shadowAlpha: 0.42, shadowStretch: 1.0,
    sunGlow: 0, horizon: 0.22, stars: 1, vignette: 0.26, glow: 1,
  },
};

const MODES: TimeOfDay[] = ["day", "sunset", "night"];

/** Blend the looks by weight (weights sum to 1). */
export function blendLook(w: Weights): Look {
  const sum = MODES.reduce((s, m) => s + w[m], 0) || 1;
  const out = {} as Record<string, number | RGB>;
  (Object.keys(LOOKS.day) as Array<keyof Look>).forEach((key) => {
    const v0 = LOOKS.day[key];
    if (Array.isArray(v0)) {
      const acc: RGB = [0, 0, 0];
      MODES.forEach((m) => {
        const v = LOOKS[m][key] as RGB;
        for (let i = 0; i < 3; i++) acc[i] += (v[i] * w[m]) / sum;
      });
      out[key] = acc;
    } else {
      out[key] = MODES.reduce((s, m) => s + ((LOOKS[m][key] as number) * w[m]) / sum, 0);
    }
  });
  return out as unknown as Look;
}

/**
 * Sun / moon placement (fractions of the viewport) from the weights. The sun descends the left side
 * as the sunset weight grows and continues below the horizon toward night; the moon rises on the
 * same side. Continuous in the weights, so a transition is a real movement across the sky.
 */
export function celestial(w: Weights) {
  const sum = MODES.reduce((s, m) => s + w[m], 0) || 1;
  const ws = w.sunset / sum;
  const wn = w.night / sum;
  const p = ws + 1.45 * wn; // 0 high (day) .. 1 low (sunset) .. 1.45 below the cloud sea
  const sun = { x: 0.17 - 0.1 * Math.min(p, 1.45), y: 0.15 + 0.5 * Math.pow(Math.min(p, 1.45), 1.15), alpha: 1 - wn };
  const m = wn;
  const moon = { x: 0.33 - 0.12 * m, y: 0.72 - 0.56 * Math.pow(m, 0.75), alpha: m };
  return { sun, moon, warm: ws };
}

/**
 * How the three sky domes (painted day, then sunset, then night on top of each other) must be faded so that what is
 * seen is exactly the weighted blend `day·wd + sunset·ws + night·wn`:
 *   night over the rest with αn = wn;   sunset over day with αs = ws / (wd + ws).
 * The former pair (αs = ws + wn, αn = wn / (ws + wn)) is only right while the day weight is zero: on a direct
 * day <-> night change (ws = 0) it made the night dome fully opaque from the first frame to the last, so the sky
 * snapped while the sun, the moon and the grade kept easing.
 */
export function skyDomeAlphas(w: Weights): { sunset: number; night: number } {
  const sum = MODES.reduce((s, m) => s + w[m], 0) || 1;
  const wd = w.day / sum;
  const ws = w.sunset / sum;
  const wn = w.night / sum;
  return { sunset: wd + ws > 1e-6 ? ws / (wd + ws) : 0, night: wn };
}

/** The colour the three domes show for these alphas, per channel weight (the inverse of {@link skyDomeAlphas}). */
export function skyDomeBlend(a: { sunset: number; night: number }): Weights {
  return { day: (1 - a.night) * (1 - a.sunset), sunset: (1 - a.night) * a.sunset, night: a.night };
}

/**
 * Where the scattering veil of the grade is centred: on the sun by day, on the moon at night, and travelling from one
 * to the other in between (it used to jump from the sun to the moon at the moment their alphas crossed).
 */
export function hazeCentre(w: Weights): { x: number; y: number } {
  const c = celestial(w);
  const k = c.moon.alpha * c.moon.alpha * (3 - 2 * c.moon.alpha);
  return { x: c.sun.x + (c.moon.x - c.sun.x) * k, y: c.sun.y + (c.moon.y - c.sun.y) * k };
}

/** Weighted mix of the three time-of-day colours (0xRRGGBB): continuous in the weights, exact at each mode. */
export function mixByTime(day: number, sunset: number, night: number, w: Weights): number {
  const sum = MODES.reduce((s, m) => s + w[m], 0) || 1;
  const ch = (shift: number) => Math.round(
    (((day >> shift) & 0xff) * w.day + ((sunset >> shift) & 0xff) * w.sunset + ((night >> shift) & 0xff) * w.night) / sum);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/**
 * How far a direct day <-> night change leans into dusk / dawn at its middle (0 = a straight blend of noon and
 * midnight, which passes through a flat grey-blue; 1 = a full sunset in between).
 */
export const DUSK_ARC = 0.55;

/** smootherstep easing: zero velocity AND acceleration at both ends (no visible start / stop). */
export function ease(p: number): number {
  const x = Math.min(1, Math.max(0, p));
  return x * x * x * (x * (6 * x - 15) + 10);
}

/**
 * Time-of-day transition: from the CURRENT weights to the requested mode over `duration` seconds of
 * wall time with smootherstep easing. A new request mid-transition starts from where the world is
 * now (no jump). Decorative animation positions are untouched by this (separate clock).
 *
 * A change between day and night travels through dusk / dawn: the light that changes sides lends a share
 * ({@link DUSK_ARC}) to the sunset look in the middle of the way and gives it back before the end, so the sky warms,
 * the shadows lengthen and the lanterns come on before the dark (and the other way round at dawn). The share is zero
 * with zero slope at both ends, so the endpoints, a reversal and a new request stay continuous.
 */
export class TimeOfDayBlend {
  w: Weights = { day: 0, sunset: 0, night: 0 };
  private from: Weights = { day: 0, sunset: 0, night: 0 };
  private to: TimeOfDay;
  private start = -1;
  /** the day <-> night light this transition moves (0 for a change to or from sunset only) */
  private arc = 0;
  duration = 2.6;

  constructor(initial: TimeOfDay) {
    this.w[initial] = 1;
    this.to = initial;
  }

  get target(): TimeOfDay {
    return this.to;
  }

  request(mode: TimeOfDay, now: number) {
    if (mode === this.to) return;
    this.from = { ...this.w };
    this.to = mode;
    this.start = now;
    this.arc = mode === "night" ? this.from.day : mode === "day" ? this.from.night : 0;
  }

  /** returns true while the weights are changing */
  update(now: number, snap: boolean): boolean {
    if (this.start < 0) return false;
    const p = snap ? 1 : (now - this.start) / this.duration;
    const e = ease(p);
    const lean = p >= 1 ? 0 : this.arc * DUSK_ARC * Math.sin(Math.PI * e) ** 2;
    MODES.forEach((m) => {
      const goal = m === this.to ? 1 : 0;
      const straight = this.from[m] + (goal - this.from[m]) * e;
      this.w[m] = straight * (1 - lean) + (m === "sunset" ? lean : 0);
    });
    if (p >= 1) this.start = -1;
    return true;
  }

  get transitioning(): boolean {
    return this.start >= 0;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Phase 2: seasons and weather adjust the SAME rig by small deltas (the seasonal look itself comes from the
 * Blender-authored seasonal terrain + vegetation; the grade only harmonises light with it — never a flat filter).
 * ---------------------------------------------------------------------------------------------- */

export type SeasonName = "spring" | "summer" | "autumn" | "winter";

interface LookDelta {
  exposure?: number;
  saturation?: number;
  shadowTint?: RGB;
  highTint?: RGB;
  haze?: number;
  shadowAlpha?: number;
  sunGlow?: number;
}

/** Per-season deltas (summer = the approved look, no change). */
export const SEASON_DELTA: Record<SeasonName, LookDelta> = {
  spring: { saturation: 0.03, highTint: [1.01, 0.995, 1.0] },
  summer: {},
  autumn: { saturation: 0.02, highTint: [1.05, 1.0, 0.93], shadowTint: [1.02, 0.99, 0.97] },
  winter: { exposure: 0.04, saturation: -0.08, highTint: [0.99, 1.0, 1.03], shadowTint: [0.95, 0.99, 1.07] },
};

/** Overcast rain / snow: softer, cooler, flatter light (shadows fade under cloud); rainbow: a clear bright sky. */
export const WEATHER_DELTA: Record<"rain" | "rainbow", LookDelta> = {
  rain: { exposure: -0.08, saturation: -0.12, shadowTint: [0.97, 0.99, 1.04], haze: 0.06, shadowAlpha: -0.45, sunGlow: -0.4 },
  rainbow: { exposure: 0.03, saturation: 0.04, haze: 0.04 },
};

/**
 * Apply season weights (sum 1, crossfading between two seasons during a change) and weather weights (0..1 each) to a
 * time-of-day look. Pure and continuous in every weight, so season / weather changes are smooth transitions.
 */
export function applyAtmosphere(look: Look, season: Partial<Record<SeasonName, number>>, weather: { rain: number; rainbow: number }): Look {
  const out: Look = { ...look, shadowTint: [...look.shadowTint] as RGB, highTint: [...look.highTint] as RGB };
  const add = (d: LookDelta, w: number) => {
    if (w <= 0) return;
    if (d.exposure) out.exposure += d.exposure * w;
    if (d.saturation) out.saturation += d.saturation * w;
    if (d.haze) out.haze += d.haze * w;
    if (d.shadowAlpha) out.shadowAlpha = Math.max(0, out.shadowAlpha + d.shadowAlpha * w);
    if (d.sunGlow) out.sunGlow = Math.max(0, out.sunGlow + d.sunGlow * w);
    for (const k of ["shadowTint", "highTint"] as const) {
      const t = d[k];
      if (!t) continue;
      for (let i = 0; i < 3; i++) out[k][i] *= 1 + (t[i] - 1) * w;
    }
  };
  (Object.keys(season) as SeasonName[]).forEach((s) => add(SEASON_DELTA[s], season[s] ?? 0));
  add(WEATHER_DELTA.rain, weather.rain);
  add(WEATHER_DELTA.rainbow, weather.rainbow);
  return out;
}

/** A value that eases toward its target over `duration` seconds (smootherstep); `snap` jumps (reduced motion). */
export class Fade {
  value: number;
  private from: number;
  private to: number;
  private start = -1;
  readonly duration: number;

  constructor(initial: number, duration = 2.4) {
    this.duration = duration;
    this.value = initial;
    this.from = initial;
    this.to = initial;
  }

  set(target: number, now: number) {
    if (target === this.to) return;
    this.from = this.value;
    this.to = target;
    this.start = now;
  }

  update(now: number, snap: boolean): number {
    if (this.start < 0) return this.value;
    const p = snap ? 1 : (now - this.start) / this.duration;
    this.value = this.from + (this.to - this.from) * ease(p);
    if (p >= 1) this.start = -1;
    return this.value;
  }
}

export function lerpRGB(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function rgbToHex(c: RGB): number {
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (f(c[0]) << 16) | (f(c[1]) << 8) | f(c[2]);
}
