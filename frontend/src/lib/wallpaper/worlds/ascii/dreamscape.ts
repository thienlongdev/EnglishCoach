import type { WorldFactory } from '../types';
import { asciiWorld, clamp, hash, mix, noise2, sstep } from './engine';

/**
 * ASCII Dreamscape. Thousands of free glyph particles dream shapes: a whale, a jellyfish, a bird, the word ECHO, a
 * moon with a tide. Each particle owns a place in the current shape, flies there on a spring, then wanders off when the
 * dream changes. The shape is sampled from real outlines at start-up. The pointer is a wind: letters blow away and
 * find their way home. Soft character rain falls from a cloud bank above.
 */

const LETTERS = 'abcdefghijklmnopqrstuvwxyzăâêôơưđABCDEHLMNOSTRUW0123456789*+~=:;.,?!';
const CHARS = ` ${LETTERS}`;

type Shape = { x: Float32Array; y: Float32Array; n: number };

/** Rasterizes a shape on a small canvas and reads back points inside it (a one-time cost per grid size). */
function sample(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, count: number, wide: number, tall: number): Shape {
  const w = 240;
  const h = Math.round((240 * tall) / wide);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  draw(ctx, w, h);
  const pixels = ctx.getImageData(0, 0, w, h).data;
  const inside: number[] = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) if (pixels[(x + y * w) * 4] > 128) inside.push(x, y);
  }
  const n = Math.max(1, inside.length / 2);
  const out: Shape = { x: new Float32Array(count), y: new Float32Array(count), n: count };
  for (let i = 0; i < count; i++) {
    const k = Math.floor(hash(i * 1.37 + 0.11) * n);
    out.x[i] = (inside[k * 2] ?? w / 2) / w;
    out.y[i] = (inside[k * 2 + 1] ?? h / 2) / h;
  }
  canvas.width = 1;
  canvas.height = 1;
  return out;
}

const whale = (c: CanvasRenderingContext2D, w: number, h: number) => {
  c.beginPath();
  c.moveTo(w * 0.04, h * 0.5);
  c.bezierCurveTo(w * 0.2, h * 0.2, w * 0.5, h * 0.2, w * 0.68, h * 0.42);
  c.bezierCurveTo(w * 0.76, h * 0.5, w * 0.84, h * 0.46, w * 0.92, h * 0.28);
  c.lineTo(w * 0.99, h * 0.2);
  c.lineTo(w * 0.95, h * 0.4);
  c.lineTo(w * 0.99, h * 0.6);
  c.lineTo(w * 0.9, h * 0.5);
  c.bezierCurveTo(w * 0.8, h * 0.68, w * 0.6, h * 0.76, w * 0.4, h * 0.75);
  c.bezierCurveTo(w * 0.22, h * 0.74, w * 0.08, h * 0.66, w * 0.04, h * 0.5);
  c.fill();
  c.beginPath();
  c.moveTo(w * 0.3, h * 0.7);
  c.lineTo(w * 0.42, h * 0.98);
  c.lineTo(w * 0.47, h * 0.72);
  c.fill();
};
const jelly = (c: CanvasRenderingContext2D, w: number, h: number) => {
  c.beginPath();
  c.ellipse(w * 0.5, h * 0.3, w * 0.27, h * 0.25, 0, Math.PI, 0);
  c.bezierCurveTo(w * 0.72, h * 0.36, w * 0.28, h * 0.36, w * 0.23, h * 0.3);
  c.fill();
  c.lineWidth = w * 0.022;
  for (let i = 0; i < 7; i++) {
    const x = w * (0.28 + i * 0.073);
    c.beginPath();
    c.moveTo(x, h * 0.34);
    c.bezierCurveTo(x - w * 0.06, h * 0.52, x + w * 0.07, h * 0.72, x - w * 0.02 + (i - 3) * w * 0.012, h * 0.98);
    c.stroke();
  }
};
const bird = (c: CanvasRenderingContext2D, w: number, h: number) => {
  c.beginPath();
  c.moveTo(w * 0.02, h * 0.28);
  c.quadraticCurveTo(w * 0.28, h * 0.32, w * 0.46, h * 0.56);
  c.quadraticCurveTo(w * 0.62, h * 0.18, w * 0.98, h * 0.06);
  c.quadraticCurveTo(w * 0.76, h * 0.38, w * 0.6, h * 0.68);
  c.lineTo(w * 0.7, h * 0.92);
  c.lineTo(w * 0.5, h * 0.76);
  c.lineTo(w * 0.32, h * 0.88);
  c.quadraticCurveTo(w * 0.36, h * 0.66, w * 0.4, h * 0.6);
  c.quadraticCurveTo(w * 0.22, h * 0.44, w * 0.02, h * 0.28);
  c.fill();
};
const word = (text: string) => (c: CanvasRenderingContext2D, w: number, h: number) => {
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.font = `700 ${Math.round(h * 0.68)}px ui-sans-serif, system-ui, sans-serif`;
  c.fillText(text, w / 2, h * 0.54, w * 0.94);
};
const moon = (c: CanvasRenderingContext2D, w: number, h: number) => {
  c.beginPath();
  c.arc(w * 0.5, h * 0.42, h * 0.34, 0, Math.PI * 2);
  c.fill();
  c.globalCompositeOperation = 'destination-out';
  c.beginPath();
  c.arc(w * 0.61, h * 0.35, h * 0.3, 0, Math.PI * 2);
  c.fill();
  c.globalCompositeOperation = 'source-over';
  c.fillStyle = '#000';
  c.beginPath();
  c.arc(w * 0.61, h * 0.35, h * 0.3, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = '#fff';
  c.lineWidth = h * 0.028;
  for (let i = 0; i < 3; i++) {
    c.beginPath();
    for (let x = 0; x <= 40; x++) {
      const px = w * (0.12 + (x / 40) * 0.76);
      const py = h * (0.84 + i * 0.06) + Math.sin(x * 0.9 + i) * h * 0.012;
      if (x === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    }
    c.stroke();
  }
};

const DREAMS: { draw: (c: CanvasRenderingContext2D, w: number, h: number) => void; wide: number; tall: number; hue: [number, number, number]; hue2: [number, number, number] }[] = [
  { draw: whale, wide: 2.4, tall: 1, hue: [120, 200, 255], hue2: [190, 150, 255] },
  { draw: jelly, wide: 1, tall: 1.06, hue: [240, 150, 255], hue2: [140, 190, 255] },
  { draw: word('ECHO'), wide: 2.7, tall: 1, hue: [255, 214, 150], hue2: [255, 130, 190] },
  { draw: bird, wide: 1.8, tall: 1, hue: [140, 240, 220], hue2: [120, 170, 255] },
  { draw: moon, wide: 1.5, tall: 1, hue: [244, 232, 200], hue2: [150, 180, 255] },
];
const DREAM_SECONDS = 15;

const factory: WorldFactory = (env) =>
  asciiWorld(
    env,
    {
      cell: [8, 12],
      chars: CHARS,
      glow: 0.3,
      weight: 600,
      background: /* glsl */ `
        vec3 a = vec3(0.09, 0.06, 0.28);
        vec3 b = vec3(0.02, 0.02, 0.10);
        vec3 col = mix(a, b, smoothstep(0.1, 1.05, uv.y));
        col += vec3(0.16, 0.05, 0.2) * smoothstep(0.42, 0.0, uv.y) * 0.55;
        float aspect = uRes.x / uRes.y;
        vec2 p = vec2(uv.x * aspect, uv.y);
        float n = fbm3(p * 1.4 + vec2(uTime * 0.012, 0.0));
        float m = fbm3(p * 2.1 - vec2(0.0, uTime * 0.01) + n * 1.8);
        col += vec3(0.11, 0.07, 0.24) * smoothstep(0.42, 0.74, m);
        col += vec3(0.02, 0.09, 0.15) * smoothstep(0.5, 0.8, n);
        vec2 q = vec2(uMouse.x * aspect, uMouse.y);
        col += vec3(0.08, 0.05, 0.14) * uStrength * exp(-dot(p - q, p - q) * 6.0);
        return col;`,
    },
    (c) => {
      const a = c.aspect;
      const alphabet = c.ramp(LETTERS);
      const faint = c.ramp('.,:;~=+*');
      let count = 0;
      let px = new Float32Array(0);
      let py = new Float32Array(0);
      let vx = new Float32Array(0);
      let vy = new Float32Array(0);
      let glyph = new Uint8Array(0);
      let shapes: Shape[] = [];
      let rainX = new Float32Array(0);
      let rainY = new Float32Array(0);
      let rainS = new Float32Array(0);

      const rebuild = () => {
        const narrow = c.cols < 110;
        count = Math.round(clamp((c.cols * c.rows) / 7, 800, 3200));
        px = new Float32Array(count);
        py = new Float32Array(count);
        vx = new Float32Array(count);
        vy = new Float32Array(count);
        glyph = new Uint8Array(count);
        for (let i = 0; i < count; i++) {
          px[i] = hash(i * 2.11) * c.cols;
          py[i] = hash(i * 3.17) * c.rows;
          glyph[i] = alphabet[(hash(i * 5.51) * alphabet.length) | 0];
        }
        shapes = DREAMS.map((d) => {
          const size = Math.min(c.rows * (narrow ? 0.44 : 0.66), (c.cols * a * 0.62) / d.wide);
          return sample(d.draw, count, d.wide * size, d.tall * size);
        });
        const rainCount = Math.round(c.cols * 0.55);
        rainX = new Float32Array(rainCount);
        rainY = new Float32Array(rainCount);
        rainS = new Float32Array(rainCount);
        for (let i = 0; i < rainCount; i++) {
          rainX[i] = hash(i * 7.3) * c.cols;
          rainY[i] = hash(i * 9.1) * c.rows;
          rainS[i] = 2 + hash(i * 1.7) * 5;
        }
      };
      rebuild();
      let clock = 0;
      const wind = { x: 0, y: 0 };
      return {
        resize: rebuild,
        pulse(x, y) {
          for (let i = 0; i < count; i++) {
            const dx = (px[i] - x) * a;
            const dy = py[i] - y;
            const d = Math.hypot(dx, dy) + 0.2;
            if (d < 30) {
              const k = (1 - d / 30) * 90;
              vx[i] += ((dx / d) * k) / a;
              vy[i] += (dy / d) * k;
            }
          }
        },
        step(dt) {
          clock += dt;
          const idx = Math.floor(clock / DREAM_SECONDS) % DREAMS.length;
          const dream = DREAMS[idx];
          const shape = shapes[idx];
          const phase = (clock % DREAM_SECONDS) / DREAM_SECONDS;
          // The dream gathers, holds, and at the end lets the letters go.
          const hold = sstep(0.0, 0.2, phase) * (1 - sstep(0.86, 1.0, phase));
          const size = Math.min(c.rows * (c.cols < 110 ? 0.44 : 0.66), (c.cols * a * 0.62) / dream.wide);
          const w = (dream.wide * size) / a;
          const h = dream.tall * size;
          const ox = c.cols * 0.56 - w / 2 + Math.sin(clock * 0.21) * 3;
          const oy = c.rows * 0.5 - h / 2 + Math.sin(clock * 0.33) * 1.2;
          const p = c.pointer();
          wind.x += (p.vx * 0.5 * p.strength - wind.x) * Math.min(1, dt * 6);
          wind.y += (p.vy * 0.5 * p.strength - wind.y) * Math.min(1, dt * 6);
          const stiffness = 1.4 + hold * 4.4;
          const damp = Math.exp(-dt * (1.5 + hold * 1.5));
          for (let i = 0; i < count; i++) {
            const tx = ox + shape.x[i] * w;
            const ty = oy + shape.y[i] * h;
            // wandering as free letters between dreams; pulled home while a dream holds
            const free = 1 - hold;
            const nx = (noise2(i * 0.031, clock * 0.11) - 0.5) * 22 * free;
            const ny = (noise2(i * 0.031 + 91, clock * 0.11) - 0.5) * 12 * free;
            let ax = (tx - px[i]) * stiffness * (0.2 + hold) + nx;
            let ay = (ty - py[i]) * stiffness * (0.2 + hold) + ny;
            if (p.strength > 0.01) {
              const dx = (px[i] - p.x) * a;
              const dy = py[i] - p.y;
              const d2 = dx * dx + dy * dy;
              if (d2 < 340) {
                const fall = 1 - d2 / 340;
                ax += wind.x * fall * 7;
                ay += wind.y * fall * 7;
                const d = Math.sqrt(d2) + 0.2;
                const scatter = p.energy * fall * 90;
                ax += ((dx / d) * scatter) / a;
                ay += (dy / d) * scatter;
              }
            }
            vx[i] = (vx[i] + ax * dt) * damp;
            vy[i] = (vy[i] + ay * dt) * damp;
            px[i] += vx[i] * dt;
            py[i] += vy[i] * dt;
          }
          for (let i = 0; i < rainX.length; i++) {
            rainY[i] += rainS[i] * dt;
            rainX[i] += wind.x * dt * 0.08;
            if (rainY[i] > c.rows) {
              rainY[i] -= c.rows;
              rainX[i] = hash(i + clock) * c.cols;
            }
          }
        },
        draw(t) {
          const idx = Math.floor(clock / DREAM_SECONDS) % DREAMS.length;
          const dream = DREAMS[idx];
          const shimmer = t * 0.4;
          // Soft rain of tiny characters.
          for (let i = 0; i < rainX.length; i++) {
            const k = 0.28 + 0.22 * (rainS[i] / 7);
            c.put(rainX[i], rainY[i], faint[i % faint.length], 92 * k + 30, 104 * k + 34, 190 * k + 46);
          }
          // The dreamers. A letter changes itself once in a while, so the shape keeps breathing.
          for (let i = 0; i < count; i++) {
            const speed = Math.hypot(vx[i], vy[i]);
            const wave = 0.5 + 0.5 * Math.sin(px[i] * 0.09 + py[i] * 0.14 + shimmer + i * 0.002);
            const r = mix(dream.hue[0], dream.hue2[0], wave);
            const g = mix(dream.hue[1], dream.hue2[1], wave);
            const b = mix(dream.hue[2], dream.hue2[2], wave);
            const dim = clamp(0.52 + 0.48 * (hash(i * 8.8) * 0.5 + 0.5) - speed * 0.012, 0.28, 1);
            const flicker = Math.floor(t * 1.4 + hash(i) * 60);
            const letter = flicker % 11 === 0 ? alphabet[(hash(i + flicker) * alphabet.length) | 0] : glyph[i];
            c.put(px[i], py[i], letter, Math.min(255, r * dim + speed * 3), Math.min(255, g * dim + speed * 2), Math.min(255, b * dim + speed));
          }
        },
      };
    },
  );

export default factory;
