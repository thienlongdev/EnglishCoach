import type { WorldFactory } from '../types';
import { asciiWorld, clamp, hash, hash2, noise2, sstep, TILE, WaveField } from './engine';

/**
 * Lagoon Letters. A lagoon seen from above: sand banks, drifting light on the water, a boids school of letter fish and
 * manta rays whose wings beat as a travelling wave. The pointer is a current: the school parts around it, rays bank
 * away, and the water ripples.
 */

const CHARS = ' .,:;-~=+*oxXO0%#@<>vwmMWVecsaz^';

interface Manta { x: number; y: number; heading: number; target: number; size: number; phase: number; seed: number; speed: number; drift: number; tone: number }

const TONES: [number, number, number][] = [
  [28, 62, 82], [36, 54, 96], [24, 74, 86],
];

const factory: WorldFactory = (env) =>
  asciiWorld(
    env,
    {
      cell: [8, 12],
      chars: CHARS,
      glow: 0.03,
      tile: 0.97,
      tileInk: 0.62,
      weight: 600,
      background: /* glsl */ `
        float aspect = uRes.x / uRes.y;
        vec2 p = vec2(uv.x * aspect, uv.y);
        float banks = fbm3(p * 1.3 + vec2(3.1, 1.7));
        banks = smoothstep(0.34, 0.68, banks + (uv.y - 0.5) * 0.28);
        vec3 deep = mix(vec3(0.02, 0.50, 0.62), vec3(0.01, 0.17, 0.30), uDark);
        vec3 shallow = mix(vec3(0.34, 0.86, 0.80), vec3(0.03, 0.40, 0.46), uDark);
        vec3 col = mix(shallow, deep, banks);
        // moving light on the sea floor: two sheets of bright filaments
        vec2 q = p * 5.0;
        float w1 = abs(fbm2(q + vec2(uTime * 0.11, -uTime * 0.07)) - 0.38);
        float w2 = abs(fbm2(q * 1.6 - vec2(uTime * 0.09, uTime * 0.05) + 7.0) - 0.38);
        float caustic = smoothstep(0.06, 0.0, w1) * 0.55 + smoothstep(0.05, 0.0, w2) * 0.4;
        col += mix(vec3(0.34, 0.42, 0.36), vec3(0.03, 0.14, 0.15), uDark) * caustic * (1.0 - banks * 0.55);
        return col;`,
    },
    (c) => {
      const a = c.aspect;
      const ray = c.ramp('xXOW%#M');
      const swim = c.ramp('<>');
      const water = c.ramp('.-~');
      const coralRamp = c.ramp('*+o%#');
      const weed = c.ramp('~^:;');
      let wave = new WaveField(c.cols, c.rows, 0.975);
      const count = Math.round(Math.min(260, (c.cols * c.rows) / 66));
      let fx = new Float32Array(count);
      let fy = new Float32Array(count);
      let fvx = new Float32Array(count);
      let fvy = new Float32Array(count);
      const seedFish = () => {
        for (let i = 0; i < count; i++) {
          const cluster = i % 3;
          const cx = c.cols * [0.3, 0.68, 0.5][cluster];
          const cy = c.rows * [0.3, 0.62, 0.86][cluster];
          fx[i] = cx + (hash(i * 1.7) - 0.5) * 34;
          fy[i] = cy + (hash(i * 2.3) - 0.5) * 16;
          fvx[i] = 6 * (hash(i * 3.3) - 0.5);
          fvy[i] = 3 * (hash(i * 5.3) - 0.5);
        }
      };
      seedFish();
      const mantas: Manta[] = [];
      const seedMantas = () => {
        mantas.length = 0;
        const narrow = c.cols < 110;
        const n = narrow ? 2 : 3;
        for (let i = 0; i < n; i++) {
          mantas.push({ x: c.cols * (0.2 + 0.6 * hash(i * 2.2)), y: c.rows * (0.2 + 0.6 * hash(i * 3.2)), heading: hash(i * 5) * 6, target: 0, size: (narrow ? 9 : 14) + hash(i) * 6, phase: hash(i * 9) * 6, seed: i * 11.1 + 4, speed: 3.6, drift: i * 3, tone: i % TONES.length });
        }
      };
      seedMantas();
      const corals = Array.from({ length: 22 }, (_, i) => { const side = i % 4; const along = hash(i * 4.4); return { x: side === 0 ? along * 0.5 : side === 1 ? 0.6 + along * 0.4 : side === 2 ? 0.02 + along * 0.08 : 0.9 + along * 0.09, y: side === 0 ? 0.93 + hash(i) * 0.07 : side === 1 ? hash(i) * 0.07 : 0.2 + hash(i * 1.1) * 0.6, r: 1.5 + hash(i * 6.1) * 3.4, seed: i }; });
      return {
        resize() {
          wave = new WaveField(c.cols, c.rows, 0.975);
          fx = new Float32Array(count);
          fy = new Float32Array(count);
          fvx = new Float32Array(count);
          fvy = new Float32Array(count);
          seedFish();
          seedMantas();
        },
        pulse(x, y) {
          wave.splash(x, y, 5, 26, a);
          for (let i = 0; i < count; i++) {
            const dx = (fx[i] - x) * a;
            const dy = fy[i] - y;
            const d = Math.hypot(dx, dy) + 0.1;
            if (d < 24) {
              fvx[i] += ((dx / d) * 40 * (1 - d / 24)) / a;
              fvy[i] += (dy / d) * 40 * (1 - d / 24);
            }
          }
        },
        step(dt, t) {
          const p = c.pointer();
          if (p.energy > 0.03) wave.splash(p.px, p.py, 2.2, p.energy * 2, a);
          // A boids school on a coarse bucket grid: neighbours only, so it stays cheap at any size.
          const bucket = 8;
          const bw = Math.ceil(c.cols / bucket) + 1;
          const bh = Math.ceil(c.rows / bucket) + 1;
          const sumX = new Float32Array(bw * bh);
          const sumY = new Float32Array(bw * bh);
          const sumVx = new Float32Array(bw * bh);
          const sumVy = new Float32Array(bw * bh);
          const num = new Uint16Array(bw * bh);
          for (let i = 0; i < count; i++) {
            const b = clamp((fx[i] / bucket) | 0, 0, bw - 1) + clamp((fy[i] / bucket) | 0, 0, bh - 1) * bw;
            sumX[b] += fx[i];
            sumY[b] += fy[i];
            sumVx[b] += fvx[i];
            sumVy[b] += fvy[i];
            num[b] += 1;
          }
          const sway = t * 0.11;
          for (let i = 0; i < count; i++) {
            const b = clamp((fx[i] / bucket) | 0, 0, bw - 1) + clamp((fy[i] / bucket) | 0, 0, bh - 1) * bw;
            const n = num[b];
            // Each school follows its own leader point on a slow loop, so it stays one school.
            const group = i % 3;
            const lx = c.cols * (0.5 + 0.38 * Math.sin(sway * (0.8 + group * 0.3) + group * 2.1));
            const ly = c.rows * (0.5 + 0.36 * Math.cos(sway * (0.62 + group * 0.27) + group * 4.4));
            let ax = (noise2(i * 0.07, sway) - 0.5) * 4 + (lx - fx[i]) * 0.09;
            let ay = (noise2(i * 0.07 + 40, sway) - 0.5) * 2.4 + (ly - fy[i]) * 0.14;
            if (n > 1) {
              const mx = sumX[b] / n;
              const my = sumY[b] / n;
              ax += (mx - fx[i]) * 0.45 + (sumVx[b] / n - fvx[i]) * 1.1;
              ay += (my - fy[i]) * 0.45 + (sumVy[b] / n - fvy[i]) * 1.1;
              if (n > 12) {
                ax -= (mx - fx[i]) * 1.1;
                ay -= (my - fy[i]) * 1.1;
              }
            }
            if (p.strength > 0.01) {
              const dx = (fx[i] - p.x) * a;
              const dy = fy[i] - p.y;
              const d = Math.hypot(dx, dy) + 0.1;
              if (d < 20) {
                const k = (1 - d / 20) * (24 + p.energy * 70) * p.strength;
                ax += ((dx / d) * k) / a;
                ay += (dy / d) * k;
                ax += p.vx * 0.5 * p.energy;
                ay += p.vy * 0.5 * p.energy;
              }
            }
            if (fx[i] < 3) ax += 8;
            if (fx[i] > c.cols - 3) ax -= 8;
            if (fy[i] < 3) ay += 8;
            if (fy[i] > c.rows - 3) ay -= 8;
            fvx[i] += ax * dt;
            fvy[i] += ay * dt;
            const sp = Math.hypot(fvx[i] * a, fvy[i]) + 1e-3;
            const lim = 8 + 12 * sstep(5, 20, sp);
            const min = 3.2;
            const k = sp > lim ? lim / sp : sp < min ? min / sp : 1;
            fvx[i] *= k;
            fvy[i] *= k;
            fx[i] += fvx[i] * dt;
            fy[i] += fvy[i] * dt;
          }
          for (const m of mantas) {
            m.drift += dt * 0.13;
            let tx = Math.cos(m.heading) + (noise2(m.drift, m.seed) - 0.5) * 1.6;
            let ty = Math.sin(m.heading) + (noise2(m.drift, m.seed + 19) - 0.5) * 1.6;
            const margin = m.size + 2;
            if (m.x < margin / a) tx += 1.4;
            if (m.x > c.cols - margin / a) tx -= 1.4;
            if (m.y < margin) ty += 1.4;
            if (m.y > c.rows - margin) ty -= 1.4;
            if (p.strength > 0.01) {
              const dx = (m.x - p.x) * a;
              const dy = m.y - p.y;
              const d = Math.hypot(dx, dy) + 0.1;
              if (d < 26) {
                tx += (dx / d) * (0.5 + p.energy * 2) * p.strength;
                ty += (dy / d) * (0.5 + p.energy * 2) * p.strength;
              }
            }
            m.target = Math.atan2(ty, tx);
            let delta = m.target - m.heading;
            while (delta > Math.PI) delta -= Math.PI * 2;
            while (delta < -Math.PI) delta += Math.PI * 2;
            m.heading += clamp(delta, -1, 1) * dt * 0.48;
            m.phase += dt * 2.1;
            m.x += (Math.cos(m.heading) * m.speed * dt) / a;
            m.y += Math.sin(m.heading) * m.speed * dt;
          }
          wave.step();
        },
        draw(t) {
          const { cols, rows } = c;
          for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
              const h = wave.at(x, y);
              const lap = noise2(x * 0.11 + t * 0.2, y * 0.4 - t * 0.1);
              const crest = Math.abs(h) * 0.18 + sstep(0.72, 0.9, lap) * 0.22;
              if (crest > 0.09) c.put(x, y, water[Math.min(2, (crest * 5) | 0)], 214, 246, 240);
            }
          }
          for (const coral of corals) {
            const cx = coral.x * cols;
            const cy = coral.y * rows;
            const ry = Math.ceil(coral.r);
            for (let y = -ry; y <= ry; y++) {
              for (let x = -Math.ceil(coral.r / a); x <= coral.r / a; x++) {
                const d = Math.hypot(x * a, y);
                const n = noise2((cx + x) * 0.5, (cy + y) * 0.7 + coral.seed);
                if (d > coral.r * (0.65 + n * 0.5)) continue;
                const hot = coral.seed % 3;
                const shade = 0.72 + n * 0.5;
                const g = coralRamp[(hash2(cx + x, cy + y) * coralRamp.length) | 0];
                const tint = hot === 0 ? [255, 122, 112] : hot === 1 ? [255, 176, 96] : [232, 112, 180];
                c.put(cx + x, cy + y, g | TILE, Math.min(255, tint[0] * shade), Math.min(255, tint[1] * shade), Math.min(255, tint[2] * shade));
              }
            }
            const blade = weed[coral.seed % weed.length];
            for (let k = 0; k < 4; k++) c.put(cx + Math.sin(t + k + coral.seed) * 1.4 + (coral.seed % 5) - 2, cy - coral.r - k, blade, 90, 220, 170);
          }
          // Ray shadows on the sand, then the school, then the rays.
          for (const m of mantas) drawManta(m, t, true);
          for (let i = 0; i < count; i++) {
            const dir = fvx[i] >= 0 ? swim[1] : swim[0];
            const flash = 0.82 + 0.18 * Math.sin(i * 0.7 + t * 2);
            c.put(fx[i], fy[i], dir, 255 * flash, 226 * flash, 130 + (i % 5) * 22);
          }
          for (const m of mantas) drawManta(m, t, false);
        },
      };

      function drawManta(m: Manta, t: number, shadow: boolean) {
        const cs = Math.cos(m.heading);
        const sn = Math.sin(m.heading);
        const reach = m.size * 1.15;
        const offX = shadow ? 3 : 0;
        const offY = shadow ? 2 : 0;
        const tone = TONES[m.tone];
        for (let y = Math.floor(m.y - reach); y <= Math.ceil(m.y + reach); y++) {
          for (let x = Math.floor(m.x - reach / a); x <= Math.ceil(m.x + reach / a); x++) {
            const wx = (x - offX - m.x) * a;
            const wy = y - offY - m.y;
            // body coordinates: u along the heading, v across
            const u = (wx * cs + wy * sn) / m.size;
            const v = (-wx * sn + wy * cs) / m.size;
            const av = Math.abs(v);
            if (u < -0.95 || u > 0.68 || av > 1.02) continue;
            // the diamond of a ray, its wing tips swept back; the wave runs out along each wing
            const beat = Math.sin(m.phase - av * 3.1) * 0.15 * av;
            const front = 0.5 - av * 0.42 + beat;
            const back = -0.42 + av * 0.32 + beat * 0.6;
            const inWing = u < front && u > back && av < 0.98 - Math.abs(beat);
            const inTail = u <= -0.4 && u > -0.95 && av < 0.03 + (u + 0.95) * 0.02;
            const horn = u > front && u < front + 0.16 && av > 0.13 && av < 0.21;
            if (!inWing && !inTail && !horn) continue;
            if (shadow) {
              c.put(x, y, water[1], 8, 76, 92);
              continue;
            }
            const spots = noise2(u * 5 + m.seed, v * 5);
            const centre = 1 - av * 0.5;
            const light = 0.75 + centre * 0.45 + Math.sin(m.phase - av * 3.1) * 0.13;
            const g = ray[(hash2(((u * 12) | 0) + m.seed, (v * 8) | 0) * ray.length) | 0];
            const white = spots > 0.8 && av < 0.7 && u > back + 0.14;
            const r = white ? 206 : tone[0] * light;
            const gg = white ? 236 : tone[1] * light + 8;
            const b = white ? 236 : tone[2] * light + 18;
            c.put(x, y, g | TILE, r, gg, b);
          }
        }
      }
    },
  );

export default factory;
