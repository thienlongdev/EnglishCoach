/**
 * Shared environment time + atmospheric wind for Echo Garden.
 *
 * Every decorative motion (clouds, satellite islands, vegetation, magic) reads ONE clock and ONE wind
 * field, so the world moves coherently. Motion is a pure function of the elapsed time `t` (closed-form
 * integrals, no per-frame accumulation): frame-rate independent, free of drift, reproducible in tests
 * and unaffected by time-of-day changes. Reduced motion freezes the clock; a hidden tab pauses it.
 */
export class EnvironmentClock {
  /** elapsed environment seconds */
  t = 0;
  /** paused (e.g. the page is hidden) */
  paused = false;
  /** prefers-reduced-motion: decorative time stands still */
  reduced = false;
  private fixed: number | null = null;

  /** Advance by a frame delta (seconds). Large deltas (tab switch, stalls) are clamped. */
  advance(dtSec: number): number {
    if (this.fixed !== null) {
      this.t = this.fixed;
      return 0;
    }
    if (this.paused || this.reduced) return 0;
    const dt = Math.min(0.05, Math.max(0, dtSec));
    this.t += dt;
    return dt;
  }

  /** QA: pin the environment to an exact time (null releases it and continues from there). */
  setFixed(t: number | null) {
    this.fixed = t;
    if (t !== null) this.t = t;
  }
}

// wind speed = 1 + Σ a·sin(ω t + φ): slow gusts, never a random direction change per frame
const GUSTS: Array<[number, number, number]> = [
  [0.22, 0.061, 0.4],
  [0.12, 0.137, 2.1],
  [0.05, 0.29, 0.9],
];
const D0 = GUSTS.reduce((s, [a, w, p]) => s + (a / w) * Math.cos(p), 0);

export const Wind = {
  /** relative wind speed (≈ 0.6 .. 1.4) */
  speed(t: number): number {
    return GUSTS.reduce((s, [a, w, p]) => s + a * Math.sin(w * t + p), 1);
  },
  /** ∫ speed dt from 0: the distance a unit-speed body has drifted (exact, deterministic) */
  distance(t: number): number {
    return GUSTS.reduce((s, [a, w, p]) => s - (a / w) * Math.cos(w * t + p), t) + D0;
  },
  /** slow vertical lift of the air mass (unitless, -1 .. 1) */
  lift(t: number): number {
    return 0.7 * Math.sin(0.043 * t + 1.1) + 0.3 * Math.sin(0.11 * t + 0.2);
  },
  /**
   * Vegetation response at world x (px): gusts travel across the island (a wave, not a synchronized
   * sway). Returns a signed sway factor ≈ -1.3 .. 1.3 for a plant with its own phase `seed`.
   */
  sway(t: number, x: number, seed: number): number {
    const tt = t - x / 700;
    const gust = 0.75 + 0.55 * Math.pow(0.5 + 0.5 * Math.sin(0.37 * tt + 0.3 * Math.sin(0.11 * tt)), 3);
    return gust * (0.62 * Math.sin(1.05 * tt + seed) + 0.38 * Math.sin(2.27 * tt + seed * 1.7));
  },
};

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Deterministic hash → [0, 1) for stable per-object variation (no Math.random in motion paths). */
export function hash01(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Satellite floating motion parameters (layout `satellites[]`). */
export interface SatelliteMotionConfig {
  base: [number, number];
  drift: { x: number; y: number; periodX: number; periodY: number };
  bob: { amp: number; period: number };
  tilt: { deg: number; period: number };
  phase: number;
}

/**
 * Bounded floating path of a satellite island at time t: a slow Lissajous drift with incommensurate
 * periods + a vertical bob + a tiny tilt. Pure and continuous (smooth acceleration, no reversal jerk,
 * never leaves base ± (drift + bob)).
 */
export function satelliteOffset(cfg: SatelliteMotionConfig, t: number) {
  const tau = Math.PI * 2;
  const dx = Math.sin((t / cfg.drift.periodX) * tau + cfg.phase) * cfg.drift.x;
  const dy = Math.sin((t / cfg.drift.periodY) * tau + cfg.phase * 1.37) * cfg.drift.y;
  const bob = Math.sin((t / cfg.bob.period) * tau + cfg.phase * 0.71) * cfg.bob.amp;
  const rot = (Math.sin((t / cfg.tilt.period) * tau + cfg.phase * 1.9) * cfg.tilt.deg * Math.PI) / 180;
  return { x: cfg.base[0] + dx, y: cfg.base[1] + dy + bob, rot };
}

/** Wrap an offset into the window [-span/2, span/2) (cloud recycling far outside the view). */
export function wrapWindow(dx: number, span: number): number {
  let d = dx % span;
  if (d < -span / 2) d += span;
  else if (d >= span / 2) d -= span;
  return d;
}

/** Opacity of a cloud at window offset dx: fully visible in the middle, fading to 0 at the seam. */
export function windowFade(dx: number, span: number): number {
  return 1 - smoothstep(0.36 * span, 0.5 * span, Math.abs(dx));
}
