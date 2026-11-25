import type { WorldFactory } from '../types';
import { asciiWorld, clamp, hash, hash2, noise2, sstep } from './engine';

/**
 * Terminal Rain. Columns of characters fall through a dark hall onto a black mirror floor. A stream has a bright head
 * and a long decaying tail; streams slowly spell English words and now and then the whole curtain writes one big
 * word in its gaps. The pointer bends the columns aside and warms them; drops ring on the floor as real waves.
 */

const STREAM = 'abcdefghijklmnopqrstuvwxyzăâêôơưđ0123456789<>/{}[]()=+-*;:.';
const CHARS = ` ${STREAM}ABCDEFGHIJKLMNOPQRSTUVWXYZ~`;

const WORDS = ['listen', 'read', 'speak', 'write', 'echo', 'practice', 'remember', 'vocabulary', 'grammar', 'fluent', 'focus', 'learn'];
const BIG_WORDS = ['LISTEN', 'SPEAK', 'READ', 'WRITE', 'ECHO'];

interface Stream {
  col: number; head: number; speed: number; length: number; seed: number; word: string | null; wordAt: number; pause: number;
}

const factory: WorldFactory = (env) =>
  asciiWorld(
    env,
    {
      cell: [8, 13],
      chars: CHARS,
      glow: 0.4,
      weight: 500,
      background: /* glsl */ `
        vec3 col = mix(vec3(0.0, 0.03, 0.03), vec3(0.0, 0.012, 0.018), smoothstep(0.18, 1.0, uv.y));
        float aspect = uRes.x / uRes.y;
        vec2 p = vec2(uv.x * aspect, uv.y);
        // a tall light behind the rain, wider toward the floor
        float beam = exp(-pow(abs(uv.x - 0.56) * (3.2 - uv.y * 1.2), 2.0));
        col += vec3(0.0, 0.09, 0.075) * beam * smoothstep(0.18, 0.55, uv.y);
        // floor
        float horizon = 0.2;
        float floorMask = smoothstep(horizon + 0.002, horizon - 0.002, uv.y);
        vec3 floorCol = vec3(0.0, 0.016, 0.018) + vec3(0.0, 0.1, 0.085) * exp(-pow(abs(uv.x - 0.56) * 2.6, 2.0)) * (uv.y / horizon);
        col = mix(col, floorCol, floorMask);
        col += vec3(0.1, 0.9, 0.7) * 0.22 * exp(-abs(uv.y - horizon) * 150.0) * exp(-pow(abs(uv.x - 0.56) * 1.6, 2.0));
        vec2 q = vec2(uMouse.x * aspect, uMouse.y);
        col += vec3(0.0, 0.1, 0.08) * uStrength * exp(-dot(p - q, p - q) * 8.0);
        return col;`,
    },
    (c) => {
      const a = c.aspect;
      const glyphs = c.ramp(STREAM);
      const ripple = c.ramp('.-~=');
      const floorRow = () => Math.round(c.rows * 0.8);
      let streams: Stream[] = [];
      let wave = new Float32Array(0);
      let wavePrev = new Float32Array(0);
      let bend = new Float32Array(0);
      let bendV = new Float32Array(0);
      let bright = new Float32Array(0);
      const seed = () => {
        streams = [];
        const floor = floorRow();
        for (let x = 0; x < c.cols; x++) {
          // Denser in the beam, thinner at the sides.
          const beam = Math.exp(-Math.pow(Math.abs(x / c.cols - 0.56) * 2.4, 2));
          const n = hash(x * 3.7) < 0.32 + beam * 0.58 ? (hash(x * 1.3) < 0.28 + beam * 0.35 ? 2 : 1) : 0;
          for (let k = 0; k < n; k++) {
            streams.push({ col: x, head: hash(x * 2.1 + k) * floor * 1.6 - 4, speed: 6 + hash(x * 4.9 + k * 3) * 13, length: 7 + hash(x * 8.3 + k) * 24, seed: x * 17 + k * 71, word: null, wordAt: 0, pause: 0 });
          }
        }
        const w = c.cols;
        const h = c.rows - floor;
        wave = new Float32Array(w * h);
        wavePrev = new Float32Array(w * h);
        bend = new Float32Array(c.cols);
        bendV = new Float32Array(c.cols);
        bright = new Float32Array(c.cols);
      };
      seed();
      let bigIndex = 0;
      let bigTime = 0;
      let bigMask: Uint8Array | null = null;
      const buildMask = () => {
        const w = c.cols;
        const h = floorRow();
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `800 ${Math.round(h * 0.44)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.save();
        ctx.translate(w * 0.56, h * 0.42);
        ctx.scale(1 / a, 1);
        ctx.fillText(BIG_WORDS[bigIndex % BIG_WORDS.length], 0, 0, w * a * 0.56);
        ctx.restore();
        const px = ctx.getImageData(0, 0, w, h).data;
        const mask = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) mask[i] = px[i * 4] > 128 ? 1 : 0;
        canvas.width = 1;
        canvas.height = 1;
        bigMask = mask;
      };
      return {
        resize() {
          seed();
          bigMask = null;
        },
        pulse(x, y) {
          const floor = floorRow();
          if (y > floor) {
            splash(x, y - floor, 40);
          }
          for (let col = Math.max(0, (x - 26) | 0); col < Math.min(c.cols, x + 26); col++) {
            const d = (col - x) * a;
            bendV[col] += Math.sign(d || 1) * 60 * (1 - Math.abs(d) / 15);
            bright[col] = 1;
          }
        },
        step(dt, t) {
          const floor = floorRow();
          const p = c.pointer();
          // Columns lean away from the pointer and spring back.
          for (let x = 0; x < c.cols; x++) {
            const d = (x - p.x) * a;
            const reach = 16;
            let force = 0;
            if (p.strength > 0.01 && Math.abs(d) < reach) {
              const f = 1 - Math.abs(d) / reach;
              force = Math.sign(d || 1) * f * f * (10 + p.energy * 42) * p.strength;
              bright[x] = Math.max(bright[x], f * (0.3 + p.energy) * p.strength);
            }
            bendV[x] += (force - bend[x] * 4.2 - bendV[x] * 2.6) * dt;
            bend[x] += bendV[x] * dt;
            bright[x] = Math.max(0, bright[x] - dt * 0.9);
          }
          for (const s of streams) {
            if (s.pause > 0) {
              s.pause -= dt;
              continue;
            }
            s.head += s.speed * dt;
            if (s.head - s.length > floor) {
              s.head = -hash(s.seed + t) * 26;
              s.speed = 6 + hash(s.seed * 1.1 + t) * 13;
              s.length = 7 + hash(s.seed * 2.7 + t) * 24;
              // Some streams carry a real word on their way down.
              s.word = hash(s.seed * 3.3 + t) > 0.86 ? WORDS[(hash(s.seed + t * 2) * WORDS.length) | 0] : null;
              s.wordAt = 3 + ((hash(s.seed * 5.5 + t) * 8) | 0);
              s.pause = hash(s.seed * 7.7 + t) * 1.4;
            }
            if (s.head >= floor && s.head - s.speed * dt < floor) splash(s.col, 1 + hash(s.seed + t) * (c.rows - floor - 2), 3.5);
          }
          // the floor's wave equation
          const w = c.cols;
          const h = c.rows - floor;
          for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
              const i = x + y * w;
              wavePrev[i] = ((wave[i - 1] + wave[i + 1] + wave[i - w] + wave[i + w]) * 0.5 - wavePrev[i]) * 0.972;
            }
          }
          const swap = wave;
          wave = wavePrev;
          wavePrev = swap;
          // The curtain writes a big word now and then.
          bigTime += dt;
          if (bigTime > 26 && !bigMask) {
            buildMask();
          }
          if (bigTime > 38) {
            bigTime = 0;
            bigIndex += 1;
            bigMask = null;
          }
        },
        draw(t) {
          const floor = floorRow();
          const { cols } = c;
          const reveal = sstep(26, 29, bigTime) * (1 - sstep(35, 38, bigTime));
          const tick = (t * 8) | 0;
          for (const s of streams) {
            const col = s.col;
            const off = bend[col] ?? 0;
            const warm = bright[col] ?? 0;
            const head = Math.floor(s.head);
            for (let n = 0; n < s.length; n++) {
              const y = head - n;
              if (y < 0 || y >= floor) continue;
              const f = 1 - n / s.length;
              const wob = off * (0.55 + 0.45 * Math.sin(y * 0.1));
              const x = col + wob;
              let letter = glyphs[(hash2(col * 13 + y, (tick + n * 3 + s.seed) >> 2) * glyphs.length) | 0];
              let boost = 0;
              if (s.word && n >= s.wordAt && n < s.wordAt + s.word.length) {
                const ch = s.word[s.word.length - 1 - (n - s.wordAt)];
                letter = c.index(ch) || letter;
                boost = 0.55;
              }
              if (bigMask && reveal > 0 && bigMask[(x | 0) + y * cols]) boost = Math.max(boost, reveal * 1.1);
              const k = Math.pow(f, 1.6);
              if (n === 0) {
                c.put(x, y, letter, 216, 255, 236);
              } else {
                const v = Math.min(1.1, k + boost + warm * 0.45);
                c.put(x, y, letter, 10 + 60 * v * v + warm * 140, 60 + 190 * v, 66 + 118 * v);
              }
            }
          }
          // Word flashes in the gaps while the curtain writes.
          if (bigMask && reveal > 0.05) {
            for (let y = 0; y < floor; y++) {
              for (let x = 0; x < cols; x++) {
                if (!bigMask[x + y * cols] || c.glyphAt(x, y)) continue;
                if (hash2(x, y + tick) > reveal * 0.32) continue;
                c.put(x, y, glyphs[(hash2(y, x) * glyphs.length) | 0], 30, 180 * reveal, 150 * reveal);
              }
            }
          }
          // The mirror floor: the rain reflected and shaken by the waves.
          const rows = c.rows;
          const w = cols;
          for (let y = floor; y < rows; y++) {
            const wy = y - floor;
            const depth = wy / Math.max(1, rows - floor);
            for (let x = 0; x < cols; x++) {
              const h = wave[x + wy * w] ?? 0;
              const shift = (wave[x + 1 + wy * w] ?? 0) - (wave[x - 1 + wy * w] ?? 0);
              const mirrored = floor - 1 - Math.round(wy * (1.2 + depth));
              const source = c.glyphAt(x + shift * 0.9, mirrored);
              const crest = Math.abs(h) * 0.17;
              if (crest > 0.12) {
                const k = clamp(crest);
                c.put(x, y, ripple[Math.min(3, (k * 4) | 0)], 40 + 100 * k, 150 + 100 * k, 130 + 90 * k);
                continue;
              }
              if (source && hash2(x, y) < 0.5 - depth * 0.34) {
                const fade = (1 - depth) * 0.3 * (0.7 + 0.3 * noise2(x * 0.2, y + t));
                c.put(x, y, source, 8, 140 * fade, 112 * fade);
              }
            }
          }
        },
      };

      function splash(x: number, y: number, amount: number) {
        const w = c.cols;
        const h = c.rows - floorRow();
        const ix = x | 0;
        const iy = y | 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const px = ix + dx;
            const py = iy + dy;
            if (px > 0 && py > 0 && px < w - 1 && py < h - 1) wave[px + py * w] += amount * (1 - Math.abs(dx) * 0.3);
          }
        }
      }
    },
  );

export default factory;
