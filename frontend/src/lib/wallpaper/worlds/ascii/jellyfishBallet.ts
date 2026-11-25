import type { WorldFactory } from '../types';
import { asciiWorld, clamp, hash, hash2, noise2, Sheet, sstep, TILE } from './engine';

/**
 * Jellyfish Ballet. A jellyfish swims by contraction: the bell squeezes, the body surges, then it relaxes and sinks a
 * little. Tentacles are verlet strings, so they really trail behind the surge and really swirl in a current. The
 * pointer stirs the water (an elastic current field) and bioluminescence answers it.
 */

const CHARS = ' .,:;-~=+*oxOX0%#@|!()\'`^';

type Tentacle = { x: Float32Array; y: Float32Array; px: Float32Array; py: Float32Array; anchor: number; kind: number };
interface Jelly {
  x: number; y: number; vx: number; vy: number; r: number; depth: number; phase: number; rate: number;
  hue: [number, number, number]; rim: [number, number, number]; seed: number; squeeze: number; glow: number;
  tentacles: Tentacle[]; drift: number;
}

const PALETTES: [[number, number, number], [number, number, number]][] = [
  [[232, 120, 240], [255, 196, 250]],
  [[120, 150, 255], [190, 226, 255]],
  [[250, 120, 180], [255, 206, 224]],
  [[110, 226, 240], [206, 252, 255]],
  [[190, 130, 255], [232, 208, 255]],
  [[255, 160, 150], [255, 224, 206]],
];

const NODES = 16;

const factory: WorldFactory = (env) =>
  asciiWorld(
    env,
    {
      cell: [8, 12],
      chars: CHARS,
      glow: 0.42,
      tile: 0.9,
      tileInk: 0.5,
      weight: 600,
      background: /* glsl */ `
        vec3 top = vec3(0.02, 0.05, 0.16);
        vec3 bottom = vec3(0.012, 0.012, 0.055);
        vec3 col = mix(bottom, top, smoothstep(0.0, 1.0, uv.y));
        float aspect = uRes.x / uRes.y;
        vec2 p = vec2(uv.x * aspect, uv.y);
        float rays = fbm2(vec2(p.x * 2.2 + p.y * 0.8, uTime * 0.05));
        col += vec3(0.02, 0.05, 0.13) * smoothstep(0.36, 0.72, rays) * smoothstep(0.1, 1.0, uv.y);
        vec2 m = vec2(uMouse.x * aspect, uMouse.y);
        col += vec3(0.05, 0.03, 0.12) * uStrength * exp(-dot(p - m, p - m) * 5.0);
        return col;`,
    },
    (c) => {
      const a = c.aspect;
      const bellRamp = c.ramp("oxOX0%#@");
      const tent = c.ramp(":;!|");
      const frill = c.ramp("~=+*");
      const snow = c.ramp('.,');
      let sheet = new Sheet(c.cols, c.rows, 4, 2.2, 1.2);
      const jellies: Jelly[] = [];
      const out = { x: 0, y: 0 };
      const makeTentacles = (j: Jelly) => {
        j.tentacles = [];
        const n = j.depth > 0.7 ? 10 : j.depth > 0.4 ? 8 : 6;
        for (let k = 0; k < n; k++) {
          const anchor = -1 + (2 * (k + 0.5)) / n;
          const kind = Math.abs(anchor) < 0.42 ? 1 : 0; // inner: frilled oral arms, outer: thin threads
          const t: Tentacle = { x: new Float32Array(NODES), y: new Float32Array(NODES), px: new Float32Array(NODES), py: new Float32Array(NODES), anchor, kind };
          for (let i = 0; i < NODES; i++) {
            t.x[i] = t.px[i] = j.x + (anchor * j.r) / a;
            t.y[i] = t.py[i] = j.y + i * j.r * 0.3;
          }
          j.tentacles.push(t);
        }
      };
      const build = () => {
        jellies.length = 0;
        const narrow = c.cols < 110;
        const layout: [number, number, number][] = narrow
          ? [[0.28, 0.3, 0.9], [0.72, 0.62, 0.7], [0.2, 0.74, 0.34], [0.82, 0.18, 0.3]]
          : [[0.2, 0.34, 1], [0.76, 0.3, 0.86], [0.5, 0.66, 0.62], [0.9, 0.72, 0.42], [0.08, 0.76, 0.36], [0.4, 0.2, 0.26], [0.62, 0.12, 0.2]];
        layout.forEach(([u, v, depth], i) => {
          const [hue, rim] = PALETTES[i % PALETTES.length];
          const j: Jelly = {
            x: u * c.cols, y: v * c.rows, vx: 0, vy: 0,
            r: (narrow ? 8 : 12) * (0.42 + depth * 0.68),
            depth, phase: hash(i * 3.1) * 6, rate: 0.5 + hash(i * 1.7) * 0.25, hue, rim, seed: i * 13.7 + 1, squeeze: 0, glow: 0, tentacles: [], drift: hash(i) * 6,
          };
          makeTentacles(j);
          jellies.push(j);
        });
      };
      build();
      const motes = Array.from({ length: 150 }, (_, i) => ({ x: hash(i * 1.3) * c.cols, y: hash(i * 2.9) * c.rows, s: 0.2 + hash(i * 4.1) * 0.8, seed: i }));
      return {
        resize() {
          sheet = new Sheet(c.cols, c.rows, 4, 2.2, 1.2);
          build();
        },
        pulse(x, y) {
          sheet.burst(x, y, 90, 24, a);
          for (const j of jellies) {
            const d = Math.hypot((j.x - x) * a, j.y - y);
            if (d < 26) j.glow = Math.min(1.4, j.glow + 1.1 * (1 - d / 26));
          }
        },
        step(dt) {
          const p = c.pointer();
          if (p.energy > 0.02) sheet.push(p.px, p.py, p.vx * 0.26 * p.strength, p.vy * 0.26 * p.strength, 15, a);
          sheet.step(dt);
          for (const j of jellies) {
            // The swimming cycle: a quick contraction, a slow relaxation.
            j.phase += dt * j.rate * (1 + j.glow * 0.5);
            const cycle = j.phase % 1;
            const target = cycle < 0.26 ? Math.sin((cycle / 0.26) * Math.PI * 0.5) : 1 - sstep(0.26, 1, cycle);
            j.squeeze += (target - j.squeeze) * Math.min(1, dt * 14);
            const thrust = cycle < 0.26 ? (1 - cycle / 0.26) * 8.2 * (0.45 + j.depth * 0.6) : 0;
            j.drift += dt * 0.11;
            const heading = (noise2(j.drift, j.seed) - 0.5) * 1.7;
            j.vy += (-Math.cos(heading) * thrust + 1.3) * dt; // sinks gently between pulses
            j.vx += (Math.sin(heading) * thrust) * dt / a;
            sheet.sample(j.x, j.y, out);
            j.vx += out.x * dt * 2.6;
            j.vy += out.y * dt * 2.6;
            // Keep the dancers on the stage.
            if (j.y < j.r + 2) j.vy += (j.r + 2 - j.y) * dt * 1.2;
            if (j.y > c.rows - j.r * 2.2) j.vy -= (j.y - (c.rows - j.r * 2.2)) * dt * 1.4;
            if (j.x < j.r / a) j.vx += (j.r / a - j.x) * dt * 0.8;
            if (j.x > c.cols - j.r / a) j.vx -= (j.x - (c.cols - j.r / a)) * dt * 0.8;
            j.vx *= Math.exp(-dt * 1.5);
            j.vy *= Math.exp(-dt * 1.5);
            j.x += j.vx * dt;
            j.y += j.vy * dt;
            j.glow = Math.max(0, j.glow - dt * 0.5);
            const d = Math.hypot((j.x - p.x) * a, j.y - p.y);
            if (p.strength > 0.01 && d < 22) j.glow = Math.max(j.glow, (1 - d / 22) * 0.75 * p.strength);
            // Tentacles: verlet strings anchored on the bell's rim.
            const rimY = j.y + j.r * (0.18 + j.squeeze * 0.14);
            const rx = (j.r * (1 - j.squeeze * 0.32)) / a;
            const seg = (j.r * 0.33 * (j.tentacles[0]?.kind === 1 ? 1 : 1));
            for (const t of j.tentacles) {
              t.x[0] = j.x + t.anchor * rx * 0.86;
              t.y[0] = rimY;
              const len = seg * (t.kind === 1 ? 0.78 : 1.12);
              for (let i = 1; i < NODES; i++) {
                const vx = (t.x[i] - t.px[i]) * 0.965;
                const vy = (t.y[i] - t.py[i]) * 0.965;
                t.px[i] = t.x[i];
                t.py[i] = t.y[i];
                sheet.sample(t.x[i], t.y[i], out);
                const sway = Math.sin(j.drift * 19 + i * 0.62 + t.anchor * 5) * 0.03 * (i / NODES + 0.2);
                t.x[i] += vx + out.x * dt * 0.8 + sway;
                t.y[i] += vy + out.y * dt * 0.8 + 0.012;
              }
              for (let it = 0; it < 2; it++) {
                for (let i = 1; i < NODES; i++) {
                  const dx = (t.x[i] - t.x[i - 1]) * a;
                  const dy = t.y[i] - t.y[i - 1];
                  const dist = Math.hypot(dx, dy) + 1e-4;
                  const k = (dist - len) / dist;
                  const mx = (dx * k) / a;
                  const my = dy * k;
                  if (i === 1) {
                    t.x[i] -= mx;
                    t.y[i] -= my;
                  } else {
                    t.x[i] -= mx * 0.5;
                    t.y[i] -= my * 0.5;
                    t.x[i - 1] += mx * 0.5;
                    t.y[i - 1] += my * 0.5;
                  }
                }
              }
            }
          }
          for (const m of motes) {
            sheet.sample(m.x, m.y, out);
            m.x += (out.x * 0.5 + Math.sin(m.seed + m.y * 0.05) * 0.12) * dt;
            m.y += (-0.3 * m.s + out.y * 0.5) * dt;
            if (m.y < 0) m.y += c.rows;
            if (m.x < 0) m.x += c.cols;
            if (m.x > c.cols) m.x -= c.cols;
          }
        },
        draw(t) {
          for (const m of motes) {
            const tw = 0.5 + 0.5 * Math.sin(t * 0.7 + m.seed);
            c.put(m.x, m.y, snow[m.seed % 2], 60 + 70 * tw * m.s, 90 + 90 * tw * m.s, 150 + 90 * tw * m.s);
          }
          const order = [...jellies].sort((p, q) => p.depth - q.depth);
          for (const j of order) drawJelly(j, t);
        },
      };

      function drawJelly(j: Jelly, t: number) {
        const shade = 0.42 + j.depth * 0.62;
        const light = Math.min(1.35, shade + j.glow * 0.42);
        // Tentacles first: they hang behind the bell.
        for (const s of j.tentacles) {
          const ramp = s.kind === 1 ? frill : tent;
          const span = s.kind === 1 ? NODES - 3 : NODES;
          for (let i = 1; i < span; i++) {
            const steps = Math.max(1, Math.ceil(Math.hypot((s.x[i] - s.x[i - 1]) * a, s.y[i] - s.y[i - 1]) * 1.3));
            for (let n = 0; n < steps; n++) {
              const f = n / steps;
              const x = s.x[i - 1] + (s.x[i] - s.x[i - 1]) * f;
              const y = s.y[i - 1] + (s.y[i] - s.y[i - 1]) * f;
              const u = (i + f) / NODES;
              const fade = (1 - u * 0.78) * light;
              const pick = ramp[((i * 3 + n + (s.anchor * 7 | 0)) & 255) % ramp.length];
              const tint = s.kind === 1 ? j.rim : j.hue;
              c.put(x, y, pick, Math.min(255, tint[0] * fade), Math.min(255, tint[1] * fade), Math.min(255, tint[2] * fade));
              if (s.kind === 1 && i < span - 2) c.put(x + 1, y, pick, Math.min(255, j.hue[0] * fade * 0.7), Math.min(255, j.hue[1] * fade * 0.7), Math.min(255, j.hue[2] * fade * 0.7));
            }
          }
        }
        // The bell: a dome that squeezes and lengthens, with ribs, a pulsing inner organ and a brighter rim.
        const rx = j.r * (1 - j.squeeze * 0.3);
        const ry = j.r * (0.78 + j.squeeze * 0.26);
        const minY = Math.floor(j.y - ry - 1);
        const maxY = Math.ceil(j.y + j.r * 0.36);
        const span = Math.ceil(rx / a) + 1;
        for (let y = minY; y <= maxY; y++) {
          for (let x = Math.floor(j.x - span); x <= Math.ceil(j.x + span); x++) {
            const dx = (x - j.x) * a;
            const dy = y - j.y;
            const nx = dx / rx;
            // the underside ripples like a skirt
            const skirt = 0.24 + 0.1 * Math.sin(nx * 9 + t * 2.4 + j.seed) * (0.6 + Math.abs(nx)) - j.squeeze * 0.05;
            const bottom = skirt * (1 - nx * nx * 0.4) * j.r;
            const ny = dy < 0 ? dy / ry : dy / Math.max(0.5, bottom);
            const e = nx * nx + ny * ny;
            if (e > 1) continue;
            const edge = Math.sqrt(e);
            if (dy > 0 && Math.abs(nx) < 0.62 && ny > 0.2) continue; // the open mouth of the bell
            const rib = Math.abs(Math.sin(Math.atan2(dy + j.r * 0.2, dx) * 8 + j.seed));
            const organ = Math.exp(-((nx * nx) * 7 + ((dy / ry + 0.28) ** 2) * 11)) * (0.75 + 0.25 * Math.sin(t * 3 + j.seed));
            const rim = sstep(0.72, 0.98, edge);
            const shine = 0.34 + rim * 0.46 + organ * 0.62 + (rib < 0.16 ? 0.14 : 0);
            const g = bellRamp[Math.min(bellRamp.length - 1, ((shine + hash2(x, y) * 0.1) * bellRamp.length) | 0)];
            const k = shine * light;
            const r = j.hue[0] + (j.rim[0] - j.hue[0]) * clamp(rim + organ);
            const gg = j.hue[1] + (j.rim[1] - j.hue[1]) * clamp(rim + organ);
            const b = j.hue[2] + (j.rim[2] - j.hue[2]) * clamp(rim + organ);
            const solid = j.depth > 0.5 && (organ > 0.42 || rim > 0.5);
            c.put(x, y, solid ? g | TILE : g, Math.min(255, r * k * 1.15), Math.min(255, gg * k * 1.15), Math.min(255, b * k * 1.15));
          }
        }
      }
    },
  );

export default factory;
