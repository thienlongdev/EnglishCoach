import type { WorldFactory } from '../types';
import { asciiWorld, clamp, hash, hash2, mix, noise2, sstep, TILE, WaveField } from './engine';

/**
 * Koi Pond. Each koi is a chain of joints that follows its own head (so the body really bends through a turn) and is
 * rasterized cell by cell: the letters stick to the fish, its colour patches stick to the letters. The water is a real
 * wave equation, stirred by fins and by the pointer, and it bends what is below it. Koi come closer when the pointer
 * rests near them, and dart away when it moves fast.
 */

const CHARS = ' .,:;-~=+*xoXO0#%@8$SKoi°^<>';

const STYLES: { base: [number, number, number]; patch: [number, number, number]; ink?: [number, number, number]; cut: number }[] = [
  { base: [246, 240, 228], patch: [238, 86, 40], cut: 0.5 }, // white with red-orange
  { base: [250, 170, 60], patch: [255, 214, 120], cut: 0.55 }, // gold
  { base: [244, 238, 226], patch: [36, 34, 44], ink: [226, 72, 40], cut: 0.46 }, // tricolour
  { base: [240, 96, 50], patch: [250, 226, 196], cut: 0.58 }, // red
  { base: [226, 232, 240], patch: [88, 118, 150], cut: 0.5 }, // silver blue
  { base: [252, 224, 170], patch: [230, 120, 50], cut: 0.52 }, // cream
  { base: [246, 240, 228], patch: [238, 86, 40], ink: [40, 40, 52], cut: 0.44 },
];

const JOINTS = 13;

interface Koi {
  x: number; y: number; heading: number; speed: number; target: number;
  wander: number; seed: number; style: number; length: number;
  jx: Float32Array; jy: Float32Array; phase: number; fright: number;
}

const body = (u: number) => {
  // half-width along the body: a rounded head, a full shoulder, a long taper into the tail's peduncle
  if (u < 0.08) return 0.42 + (u / 0.08) * 0.42;
  if (u < 0.3) return 0.84 + ((u - 0.08) / 0.22) * 0.16;
  if (u < 0.9) return 0.2 + 0.8 * Math.pow(1 - (u - 0.3) / 0.6, 1.2);
  return 0.2;
};

const factory: WorldFactory = (env) =>
  asciiWorld(
    env,
    {
      cell: [8, 12],
      chars: CHARS,
      glow: 0.06,
      tile: 0.96,
      tileInk: 0.62,
      weight: 600,
      background: /* glsl */ `
        vec2 p = uv - vec2(0.5, 0.48);
        p.x *= uRes.x / uRes.y;
        float v = dot(p, p);
        vec3 deep = mix(vec3(0.035, 0.24, 0.27), vec3(0.01, 0.075, 0.115), smoothstep(0.02, 1.15, v));
        float n = fbm3(uv * vec2(3.2, 2.2) + vec2(uTime * 0.018, -uTime * 0.012));
        float m = fbm3(uv * vec2(9.0, 6.0) - vec2(uTime * 0.03, uTime * 0.021) + n * 2.4);
        deep += vec3(0.012, 0.075, 0.07) * smoothstep(0.42, 0.72, m);
        deep += vec3(0.02, 0.05, 0.04) * n;
        return deep;`,
    },
    (c) => {
      const glyphs = c.ramp('xoOSKe%#');
      const fin = c.ramp(':;-~=');
      const water = c.ramp('.,-~=');
      const pad = c.ramp('%#xX8');
      const petal = c.index('*');
      const dot = c.index('.');
      let wave = new WaveField(c.cols, c.rows, 0.982);
      const a = c.aspect;
      const count = c.cols * c.rows < 5000 ? 5 : 7;
      const fish: Koi[] = [];
      const reset = () => {
        fish.length = 0;
        for (let i = 0; i < count; i++) {
          const length = (c.rows < 40 ? 15 : 22) + hash(i + 3) * 10;
          const x = c.cols * (0.15 + 0.7 * hash(i * 2.3 + 1));
          const y = c.rows * (0.15 + 0.7 * hash(i * 3.7 + 2));
          const heading = hash(i * 9.1) * Math.PI * 2;
          const koi: Koi = { x, y, heading, speed: 4, target: heading, wander: hash(i) * 6, seed: i * 17.3 + 5, style: i % STYLES.length, length, jx: new Float32Array(JOINTS), jy: new Float32Array(JOINTS), phase: hash(i * 5.5) * 6, fright: 0 };
          for (let j = 0; j < JOINTS; j++) {
            koi.jx[j] = x - (Math.cos(heading) * j * length) / (JOINTS - 1) / a;
            koi.jy[j] = y - (Math.sin(heading) * j * length) / (JOINTS - 1);
          }
          fish.push(koi);
        }
      };
      reset();

      type Pad = { x: number; y: number; r: number; notch: number };
      let pads: Pad[] = [];
      const placePads = () => {
        pads = [];
        const spots = [[0.2, 0.16, 5], [0.27, 0.8, 7], [0.86, 0.14, 6], [0.93, 0.62, 5], [0.7, 0.9, 5], [0.48, 0.06, 4], [0.97, 0.3, 3.5], [0.12, 0.55, 3.5]];
        spots.forEach(([u, v, r], i) => pads.push({ x: u * c.cols, y: v * c.rows, r, notch: hash(i * 7.7) * Math.PI * 2 }));
      };
      placePads();
      const petals = Array.from({ length: 22 }, (_, i) => ({ x: hash(i * 3.3) * c.cols, y: hash(i * 8.1) * c.rows, v: 0.2 + hash(i) * 0.5, s: i }));

      let shoal = 0;
      const liveX = new Float32Array(JOINTS);
      const liveY = new Float32Array(JOINTS);
      return {
        resize() {
          wave = new WaveField(c.cols, c.rows, 0.982);
          reset();
          placePads();
        },
        pulse(x, y) {
          wave.splash(x, y, 5, 26, a);
          for (const koi of fish) {
            const dx = (koi.x - x) * a;
            const dy = koi.y - y;
            const d = Math.hypot(dx, dy);
            if (d < 26) {
              koi.fright = Math.max(koi.fright, 1 - d / 26);
              koi.target = Math.atan2(dy, dx / a);
            }
          }
        },
        step(dt) {
          shoal += dt;
          const p = c.pointer();
          if (p.energy > 0.03) wave.splash(p.px, p.py, 2.4, p.energy * 2.3, a);
          for (const koi of fish) {
            koi.wander += dt * (0.35 + hash(koi.seed) * 0.3);
            const margin = 7;
            // Turn away from the banks, drift by a slow personal noise, keep away from neighbours.
            let tx = Math.cos(koi.target);
            let ty = Math.sin(koi.target);
            const n = noise2(koi.wander, koi.seed) - 0.5;
            const turn = n * 2.4;
            const ct = Math.cos(turn * dt);
            const st = Math.sin(turn * dt);
            const rx = tx * ct - ty * st;
            ty = tx * st + ty * ct;
            tx = rx;
            if (koi.x < margin / a) tx += ((margin / a - koi.x) * a) / margin;
            if (koi.x > c.cols - margin / a) tx -= ((koi.x - (c.cols - margin / a)) * a) / margin;
            if (koi.y < margin) ty += (margin - koi.y) / margin;
            if (koi.y > c.rows - margin) ty -= (koi.y - (c.rows - margin)) / margin;
            for (const other of fish) {
              if (other === koi) continue;
              const dx = (koi.x - other.x) * a;
              const dy = koi.y - other.y;
              const d2 = dx * dx + dy * dy;
              if (d2 < 110 && d2 > 0.01) {
                const k = 1 / d2;
                tx += dx * k * 0.9;
                ty += dy * k * 0.9;
              }
            }
            // The pointer: curiosity when it rests near, a quick turn when it moves fast.
            if (p.strength > 0.01) {
              const dx = (p.x - koi.x) * a;
              const dy = p.y - koi.y;
              const d = Math.hypot(dx, dy) + 0.001;
              if (d < 30) {
                if (p.energy > 0.22) {
                  koi.fright = Math.max(koi.fright, (p.energy - 0.1) * (1 - d / 30) * 1.6);
                  tx -= (dx / d) * 1.6 * p.strength;
                  ty -= (dy / d) * 1.6 * p.strength;
                } else if (d > 7) {
                  tx += (dx / d) * 0.38 * p.strength;
                  ty += (dy / d) * 0.38 * p.strength;
                }
              }
            }
            koi.target = Math.atan2(ty, tx);
            let delta = koi.target - koi.heading;
            while (delta > Math.PI) delta -= Math.PI * 2;
            while (delta < -Math.PI) delta += Math.PI * 2;
            koi.heading += clamp(delta, -1.2, 1.2) * dt * (0.34 + koi.fright * 2.2);
            koi.fright = Math.max(0, koi.fright - dt * 0.55);
            const cruise = 3.2 + 2.2 * noise2(koi.wander * 0.6, koi.seed + 40);
            koi.speed = mix(koi.speed, cruise + koi.fright * 15, Math.min(1, dt * 2.4));
            koi.phase += dt * (2.6 + koi.speed * 0.72);
            koi.x += (Math.cos(koi.heading) * koi.speed * dt) / a;
            koi.y += Math.sin(koi.heading) * koi.speed * dt;
            // The body follows the head, each joint at its fixed distance: real bends through a turn.
            koi.jx[0] = koi.x;
            koi.jy[0] = koi.y;
            const seg = koi.length / (JOINTS - 1);
            for (let j = 1; j < JOINTS; j++) {
              const px = (koi.jx[j - 1] - koi.jx[j]) * a;
              const py = koi.jy[j - 1] - koi.jy[j];
              const d = Math.hypot(px, py) + 1e-4;
              koi.jx[j] = koi.jx[j - 1] - ((px / d) * seg) / a;
              koi.jy[j] = koi.jy[j - 1] - (py / d) * seg;
            }
            if (Math.random() < 0.3) {
              const tail = JOINTS - 1;
              wave.splash(koi.jx[tail], koi.jy[tail], 1.8, 0.8 + koi.speed * 0.2, a);
            }
          }
          for (const q of petals) {
            q.x += dt * q.v * 0.9 + (wave.at(q.x + 1, q.y) - wave.at(q.x - 1, q.y)) * dt * 3;
            q.y += dt * Math.sin(shoal * 0.3 + q.s) * 0.2 + (wave.at(q.x, q.y + 1) - wave.at(q.x, q.y - 1)) * dt * 3;
            if (q.x > c.cols) q.x -= c.cols;
            if (q.y > c.rows) q.y -= c.rows;
            if (q.y < 0) q.y += c.rows;
          }
          wave.step();
        },
        draw(t) {
          const { cols, rows } = c;
          // Water: only the crests are written, so the pond stays quiet where nothing happens.
          for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
              const h = wave.at(x, y);
              const lap = noise2(x * 0.09 + t * 0.14, y * 0.22 - t * 0.09);
              const crest = Math.abs(h) * 0.13 + sstep(0.76, 0.9, lap) * 0.2;
              if (crest > 0.085) {
                const g = water[Math.min(water.length - 1, (crest * 4.2) | 0)];
                const lift = clamp(crest * 1.3);
                c.put(x, y, g, 38 + lift * 150, 112 + lift * 110, 116 + lift * 100);
              }
            }
          }
          // Shadows, then bodies (the wave bends them).
          for (const koi of fish) drawKoi(koi, true, t);
          for (const koi of fish) drawKoi(koi, false, t);
          for (const q of petals) {
            const ok = q.s % 3 === 0 ? petal : dot;
            c.put(q.x, q.y, ok, 250, 190, 200);
          }
          // Lily pads float above the fish and ride the swell.
          for (const lily of pads) {
            const ox = (wave.at(lily.x + 2, lily.y) - wave.at(lily.x - 2, lily.y)) * 0.05 * lily.r;
            const oy = (wave.at(lily.x, lily.y + 2) - wave.at(lily.x, lily.y - 2)) * 0.05 * lily.r;
            const cx = lily.x + ox + Math.sin(t * 0.4 + lily.notch) * 0.4;
            const cy = lily.y + oy + Math.cos(t * 0.34 + lily.notch) * 0.25;
            const rx = Math.ceil(lily.r / a);
            for (let y = -lily.r; y <= lily.r; y++) {
              for (let x = -rx; x <= rx; x++) {
                const dx = x * a;
                const d = Math.hypot(dx, y);
                if (d > lily.r) continue;
                const ang = Math.atan2(y, dx);
                let off = ang - lily.notch;
                while (off > Math.PI) off -= Math.PI * 2;
                while (off < -Math.PI) off += Math.PI * 2;
                if (Math.abs(off) < 0.3 && d > lily.r * 0.1) continue;
                const veins = Math.abs(Math.sin(ang * 5 + lily.notch));
                const shade = 0.55 + 0.45 * (1 - d / lily.r) + (veins < 0.14 ? 0.3 : 0);
                const g = pad[Math.min(pad.length - 1, (shade * pad.length) | 0)];
                c.put(cx + x, cy + y, g | TILE, 30 + 52 * shade, 96 + 70 * shade, 62 + 36 * shade);
              }
            }
          }
        },
      };

      function drawKoi(koi: Koi, shadow: boolean, t: number) {
        const style = STYLES[koi.style];
        // The swimming wave: a lateral travelling sine over the settled centre line, growing toward the tail.
        for (let j = 0; j < JOINTS; j++) {
          const u = j / (JOINTS - 1);
          const prev = Math.max(0, j - 1);
          const next = Math.min(JOINTS - 1, j + 1);
          const tx = (koi.jx[next] - koi.jx[prev]) * a;
          const ty = koi.jy[next] - koi.jy[prev];
          const len = Math.hypot(tx, ty) + 1e-4;
          const amp = (0.12 + u * u * 1.5) * Math.sin(koi.phase - u * 4.6) * (koi.length / 26);
          liveX[j] = koi.jx[j] + ((-ty / len) * amp) / a;
          liveY[j] = koi.jy[j] + (tx / len) * amp;
        }
        const jx = liveX;
        const jy = liveY;
        const maxW = koi.length * 0.108;
        let minX = 1e9;
        let maxX = -1e9;
        let minY = 1e9;
        let maxY = -1e9;
        for (let j = 0; j < JOINTS; j++) {
          if (jx[j] < minX) minX = jx[j];
          if (jx[j] > maxX) maxX = jx[j];
          if (jy[j] < minY) minY = jy[j];
          if (jy[j] > maxY) maxY = jy[j];
        }
        const padX = (maxW * 2.6) / a;
        const padY = maxW * 2.6;
        const sx = shadow ? 2 : 0;
        const sy = shadow ? 1 : 0;
        for (let y = Math.floor(minY - padY); y <= Math.ceil(maxY + padY); y++) {
          for (let x = Math.floor(minX - padX); x <= Math.ceil(maxX + padX); x++) {
            // Refraction: look up the fish where the water bends this cell's line of sight.
            const bend = shadow ? 0 : 0.045;
            const qx = x - sx + (wave.at(x + 1, y) - wave.at(x - 1, y)) * bend;
            const qy = y - sy + (wave.at(x, y + 1) - wave.at(x, y - 1)) * bend;
            let best = 1e9;
            let bestU = 0;
            let bestSide = 0;
            for (let j = 0; j < JOINTS - 1; j++) {
              const ax = jx[j];
              const ay = jy[j];
              const bx = jx[j + 1];
              const by = jy[j + 1];
              const vx = (bx - ax) * a;
              const vy = by - ay;
              const wx = (qx - ax) * a;
              const wy = qy - ay;
              const s = clamp((wx * vx + wy * vy) / (vx * vx + vy * vy + 1e-5));
              const ex = wx - vx * s;
              const ey = wy - vy * s;
              const d = ex * ex + ey * ey;
              if (d < best) {
                best = d;
                bestU = (j + s) / (JOINTS - 1);
                bestSide = vx * ey - vy * ex;
              }
            }
            const d = Math.sqrt(best);
            const half = body(bestU) * maxW;
            const side = bestSide > 0 ? 1 : -1;
            // Fins: two pectorals behind the head, and the fanned tail.
            let finValue = 0;
            if (bestU > 0.13 && bestU < 0.3 && d >= half) {
              const flap = 0.7 + 0.3 * Math.sin(koi.phase * 0.55 + (side > 0 ? 0 : 2));
              const reach = half + maxW * 1.0 * flap * (1 - Math.abs(bestU - 0.2) / 0.1);
              if (d < reach) finValue = 1 - (d - half) / (reach - half);
            }
            // The tail is a forked fan laid along the last segment, not a round cap.
            const tb = JOINTS - 3;
            const tvx = (jx[JOINTS - 1] - jx[tb]) * a;
            const tvy = jy[JOINTS - 1] - jy[tb];
            const tlen = Math.hypot(tvx, tvy) + 1e-4;
            const qvx = (qx - jx[tb]) * a;
            const qvy = qy - jy[tb];
            const along = (qvx * tvx + qvy * tvy) / tlen;
            const lateral = Math.abs(qvx * tvy - qvy * tvx) / tlen;
            const reachTail = koi.length * 0.22;
            let isTail = false;
            if (along > 0 && along < reachTail) {
              const open = along * 0.5 + maxW * 0.14;
              const notch = reachTail * (0.62 + 0.38 * Math.min(1, lateral / (open + 1e-3)));
              if (lateral < open && along < notch) {
                isTail = true;
                finValue = Math.max(finValue, 0.7);
              }
            }
            if (d >= half && finValue <= 0) continue;
            if (isTail && d >= half) {
              if (shadow) continue;
              const g = fin[(hash2(x * 3, y) * fin.length) | 0];
              c.put(x, y, g | TILE, style.patch[0] * 0.86, style.patch[1] * 0.86, style.patch[2] * 0.86);
              continue;
            }
            if (shadow) {
              c.put(x, y, hash2(x, y) > 0.5 ? water[0] : water[1], 8, 44, 52);
              continue;
            }
            if (d >= half) {
              const g = fin[(hash2(x * 3, y) * fin.length) | 0];
              const glow = 0.55 + finValue * 0.45;
              const tint = bestU > 0.8 ? style.patch : style.base;
              c.put(x, y, g | TILE, tint[0] * glow, tint[1] * glow, tint[2] * glow);
              continue;
            }
            // Colour patches stick to the body: noise in body coordinates.
            const across = (side * d) / maxW;
            const patchNoise = noise2(bestU * 5.2 + koi.seed, across * 1.6 + koi.seed * 0.3);
            let col = patchNoise > style.cut ? style.patch : style.base;
            if (style.ink && noise2(bestU * 7.3 + koi.seed + 9, across * 2.1) > 0.68) col = style.ink;
            const shade = 0.62 + 0.38 * (1 - (d / half) * (d / half)) + (Math.abs(across) < 0.1 && bestU > 0.1 && bestU < 0.72 ? -0.14 : 0);
            // The letter is chosen in body coordinates too, so it travels with the fish like a scale.
            const scaleU = Math.round(bestU * 26);
            const scaleV = Math.round(across * 3);
            const g = glyphs[(hash2(scaleU + koi.seed, scaleV) * glyphs.length) | 0];
            const headEye = bestU > 0.04 && bestU < 0.085 && Math.abs(Math.abs(across) - 0.42) < 0.16;
            if (headEye) {
              c.put(x, y, g | TILE, 26, 22, 28);
              continue;
            }
            const sheen = 1 + 0.08 * Math.sin(t * 1.3 + scaleU);
            c.put(x, y, g | TILE, Math.min(255, col[0] * shade * sheen), Math.min(255, col[1] * shade * sheen), Math.min(255, col[2] * shade * sheen));
          }
        }
      }
    },
  );

export default factory;
