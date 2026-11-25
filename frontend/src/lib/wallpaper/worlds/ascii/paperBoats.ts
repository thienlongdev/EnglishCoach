import type { WorldFactory } from '../types';
import { asciiWorld, clamp, hash, hash2, noise2, sstep, TILE, WaveField } from './engine';

/**
 * Paper Boats. A calm water in perspective (rows crowd toward the horizon). Boats are real folded polygons: a boat
 * enters as a flat square of paper and folds itself into a hull and sail as it sails on. Each one rides the swell, tilts
 * with it and leaves a V wake in a wave equation. The pointer makes a current that steers boats and stirs the water.
 */

const CHARS = ' .,:;-~=+_^\'`/\\|oxXO#%@aeou';

type V2 = [number, number];
interface Boat {
  x: number; y: number; vx: number; size: number; fold: number; seed: number; rock: number; hue: [number, number, number]; state: number;
}

const HUES: [number, number, number][] = [[255, 255, 250], [255, 232, 214], [224, 240, 255], [255, 240, 196], [255, 216, 222]];

const mixV = (p: V2, q: V2, t: number): V2 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];

// Polygons of the folded boat in its own unit space (x right, y down). Each morphs from a flat paper sheet.
const SHEET = { hull: [[-0.7, -0.1], [0.7, -0.1], [0.7, 0.45], [-0.7, 0.45]] as V2[], sailL: [[-0.7, -0.75], [0, -0.75], [0, -0.1], [-0.7, -0.1]] as V2[], sailR: [[0, -0.75], [0.7, -0.75], [0.7, -0.1], [0, -0.1]] as V2[] };
const BOAT = { hull: [[-1.05, -0.08], [1.05, -0.08], [0.62, 0.42], [-0.62, 0.42]] as V2[], sailL: [[-0.52, -0.08], [0.02, -1.0], [0.02, -0.08], [0.02, -0.08]] as V2[], sailR: [[0.02, -0.08], [0.02, -1.0], [0.52, -0.08], [0.52, -0.08]] as V2[] };

function inPolygon(x: number, y: number, poly: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const factory: WorldFactory = (env) =>
  asciiWorld(
    env,
    {
      cell: [8, 12],
      chars: CHARS,
      glow: 0.05,
      tile: 0.98,
      tileInk: 0.74,
      weight: 600,
      background: /* glsl */ `
        float horizon = 0.72;
        float aspect = uRes.x / uRes.y;
        vec3 dayHi = vec3(0.62, 0.82, 0.96), dayLo = vec3(0.98, 0.90, 0.80);
        vec3 nightHi = vec3(0.03, 0.06, 0.16), nightLo = vec3(0.24, 0.20, 0.34);
        vec3 sky = mix(mix(dayLo, dayHi, smoothstep(horizon, 1.0, uv.y)), mix(nightLo, nightHi, smoothstep(horizon, 1.0, uv.y)), uDark);
        vec2 p = vec2(uv.x * aspect, uv.y);
        vec2 sunAt = vec2(aspect * 0.28, horizon + 0.085);
        float d = length(p - sunAt);
        sky += mix(vec3(1.0, 0.76, 0.5) * 0.5, vec3(0.8, 0.62, 0.74) * 0.24, uDark) * exp(-d * 5.0);
        sky += mix(vec3(1.0, 0.86, 0.66), vec3(0.42, 0.40, 0.5), uDark) * smoothstep(0.052, 0.046, d) * 0.75;
        vec3 waterFar = mix(vec3(0.54, 0.80, 0.82), vec3(0.08, 0.14, 0.24), uDark);
        vec3 waterNear = mix(vec3(0.12, 0.50, 0.58), vec3(0.015, 0.05, 0.11), uDark);
        vec3 water = mix(waterNear, waterFar, pow(clamp(uv.y / horizon, 0.0, 1.0), 2.2));
        // sun road
        float lane = exp(-abs(p.x - sunAt.x) * (5.0 - 3.4 * (1.0 - uv.y / horizon)));
        float band = fbm2(vec2(p.x * 6.0, (horizon - uv.y) * (horizon - uv.y) * 90.0 - uTime * 0.2));
        water += mix(vec3(0.5, 0.36, 0.24), vec3(0.2, 0.15, 0.22), uDark) * lane * smoothstep(0.32, 0.62, band);
        return mix(water, sky, smoothstep(horizon - 0.0015, horizon + 0.0015, uv.y));`,
    },
    (c) => {
      const a = c.aspect;
      const paper = c.ramp('aeouxoXO');
      const crest = c.ramp('.,-~=');
      const fold = c.ramp('/\\|');
      const horizon = () => Math.round(c.rows * 0.28);
      let wave = new WaveField(c.cols, Math.max(4, c.rows - horizon()), 0.984);
      let boats: Boat[] = [];
      const makeBoat = (i: number, x: number): Boat => {
        const depth = hash(i * 3.3);
        const h = horizon();
        const y = h + 3 + Math.pow(depth, 1.5) * (c.rows - h - 7);
        const persp = (y - h) / (c.rows - h);
        return { x, y, vx: 1.2 + persp * 2.7, size: 2.8 + persp * 10.5, fold: x < 0 ? 0 : 1, seed: i * 5.1 + 2, rock: 0, hue: HUES[i % HUES.length], state: 0 };
      };
      const seed = () => {
        const n = c.cols < 110 ? 6 : 10;
        boats = Array.from({ length: n }, (_, i) => makeBoat(i, hash(i * 7.7) * c.cols));
        boats.sort((p, q) => p.y - q.y);
      };
      seed();
      let spawn = 40;
      const swell = (x: number, y: number, t: number) => {
        const h = horizon();
        const persp = clamp((y - h) / (c.rows - h));
        return Math.sin(x * 0.05 / (0.3 + persp) + t * 0.9) * 0.5 * persp + Math.sin(x * 0.11 / (0.3 + persp) - t * 0.6 + y * 0.3) * 0.28 * persp;
      };
      return {
        resize() {
          wave = new WaveField(c.cols, Math.max(4, c.rows - horizon()), 0.984);
          seed();
        },
        pulse(x, y) {
          const h = horizon();
          if (y > h) wave.splash(x, y - h, 4.5, 32, a);
          for (const b of boats) {
            const dx = (b.x - x) * a;
            const dy = b.y - y;
            const d = Math.hypot(dx, dy) + 0.1;
            if (d < 26) {
              b.vx += ((dx / d) * 12 * (1 - d / 26)) / a;
              b.rock += 1.4 * (1 - d / 26) * (dx > 0 ? 1 : -1);
            }
          }
        },
        step(dt, t) {
          const p = c.pointer();
          const h = horizon();
          if (p.py > h && p.energy > 0.03) wave.splash(p.px, p.py - h, 2.6, p.energy * 3.4, a);
          for (const b of boats) {
            const persp = clamp((b.y - h) / (c.rows - h));
            const cruise = 1.2 + persp * 2.7;
            if (p.strength > 0.01) {
              const dx = (b.x - p.x) * a;
              const dy = b.y - p.y;
              const d = Math.hypot(dx, dy) + 0.1;
              if (d < 22) b.vx += (p.vx * 0.12 * p.energy + ((dx / d) * 1.2 * p.energy * 8) / a) * (1 - d / 22) * dt * 6 * p.strength;
            }
            b.vx += (cruise - b.vx) * Math.min(1, dt * 0.7);
            b.x += b.vx * dt;
            // Folding: it comes in flat and folds itself as it reaches the open water.
            if (b.fold < 1 && b.x > 2) b.fold = Math.min(1, b.fold + dt * 0.34);
            b.rock *= Math.exp(-dt * 1.2);
            if (hash(((t * 6) | 0) + b.seed) > 0.5) wave.splash(b.x - b.size * 0.7 / a, b.y - h + b.size * 0.25, 1.3 + persp * 1.6, 1 + persp * 2.2, a);
            const reach = b.size * 1.3 / a;
            if (b.x - reach > c.cols + 2) {
              spawn += 1;
              const fresh = makeBoat(spawn, -reach - 2);
              Object.assign(b, fresh);
              boats.sort((m, n) => m.y - n.y);
            }
          }
          wave.step();
        },
        draw(t) {
          const { cols, rows } = c;
          const h = horizon();
          const night = c.dark();
          for (let y = h; y < rows; y++) {
            const wy = y - h;
            const persp = (y - h) / Math.max(1, rows - h);
            const freq = 0.34 / (0.09 + persp);
            for (let x = 0; x < cols; x++) {
              const bent = x + (wave.at(x + 1, wy) - wave.at(x - 1, wy)) * 0.4;
              const lines = noise2(bent * 0.09 * freq * 0.5 + t * 0.2, (y * freq) * 0.42 - t * 0.14);
              const ripple = Math.abs(wave.at(x, wy)) * 0.12;
              const v = sstep(0.62, 0.86, lines) * (0.45 + persp * 0.55) + ripple;
              if (v < 0.13) continue;
              const k = Math.min(1, v);
              const g = crest[Math.min(4, (k * 5) | 0)];
              if (night) c.put(x, y, g, 96 + 110 * k, 124 + 96 * k, 164 + 76 * k);
              else c.put(x, y, g, 200 + 55 * k, 238 + 17 * k, 240 + 15 * k);
            }
          }
          for (const b of boats) drawBoat(b, t, night);
        },
      };

      function drawBoat(b: Boat, t: number, night: boolean) {
        const f = sstep(0, 1, b.fold);
        const hull = SHEET.hull.map((v, i) => mixV(v, BOAT.hull[i], f));
        const sailL = SHEET.sailL.map((v, i) => mixV(v, BOAT.sailL[i], f));
        const sailR = SHEET.sailR.map((v, i) => mixV(v, BOAT.sailR[i], f));
        const rise = swell(b.x, b.y, t) * b.size * 0.42;
        const tilt = Math.sin(t * 0.9 + b.seed) * 0.05 + (swell(b.x + 6, b.y, t) - swell(b.x - 6, b.y, t)) * 0.5 + b.rock * 0.2;
        const cs = Math.cos(tilt);
        const sn = Math.sin(tilt);
        const size = b.size;
        const cy = b.y + rise;
        const spanX = (size * 1.25) / c.aspect;
        const darken = night ? 0.8 : 1;
        for (let y = Math.floor(cy - size * 1.15); y <= Math.ceil(cy + size * 0.6); y++) {
          for (let x = Math.floor(b.x - spanX); x <= Math.ceil(b.x + spanX); x++) {
            const wx = (x - b.x) * c.aspect;
            const wy = y - cy;
            const u = (wx * cs + wy * sn) / size;
            const v = (-wx * sn + wy * cs) / size;
            let shade = 0;
            let isFold = false;
            if (inPolygon(u, v, hull)) {
              // the hull is folded down its centre: two facets with a crease
              shade = u < 0 ? 0.74 : 0.9;
              if (Math.abs(u) < 0.04) isFold = true;
              shade -= (v + 0.08) * 0.32;
            } else if (inPolygon(u, v, sailL)) {
              shade = 1.02;
            } else if (inPolygon(u, v, sailR)) {
              shade = 0.84;
              if (u < 0.05) isFold = true;
            } else continue;
            const g = isFold ? fold[2] : paper[(hash2(((u * 7) | 0) + b.seed, (v * 5) | 0) * paper.length) | 0];
            const k = clamp(shade) * darken;
            if (night) c.put(x, y, g | TILE, b.hue[0] * k * 0.92, b.hue[1] * k * 0.96, Math.min(255, b.hue[2] * k * 1.08));
            else c.put(x, y, g | TILE, b.hue[0] * k, b.hue[1] * k, b.hue[2] * k);
          }
        }
        // Its mirror on the water, broken into a few dashes.
        const left = Math.floor(b.x - spanX * 0.5);
        const right = Math.ceil(b.x + spanX * 0.5);
        for (let y = Math.ceil(cy + size * 0.44); y < cy + size * 0.95; y++) {
          for (let x = left; x <= right; x++) {
            if (hash2(x + ((t * 3) | 0), y) > 0.5) continue;
            c.put(x, y, crest[3], b.hue[0] * 0.62 * darken, b.hue[1] * 0.68 * darken, b.hue[2] * 0.74 * darken);
          }
        }
      }
    },
  );

export default factory;
