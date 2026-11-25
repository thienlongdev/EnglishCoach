import type { WorldFactory } from '../types';
import { asciiWorld, clamp, hash, hash2, noise2, sstep, TILE } from './engine';

/**
 * Echo Code Garden. Plants grow from a recursive program: every branch is drawn with the slash that matches its
 * direction, stems carry real words of code and vocabulary, leaves are clusters of symbols, and each branch tip opens
 * into a small flower of letters. A plant sprouts, grows, blooms and sheds seeds; then a new one takes its place.
 * Plants lean toward the pointer, and nearby letters rearrange themselves into other tokens.
 */

const CHARS = " .,:;'`|/\\_-~=+*#%@oO0()[]{}<>!?^abcdefghijklmnopqrstuvwxyz";
const STEM_WORDS = ['listen', 'speak', 'read', 'write', 'echo', 'learn()', 'grow()', 'word', 'phrase', 'mean', 'sound', 'say', 'if', 'for', 'try', 'return', 'true', 'idea'];

interface Branch { x0: number; y0: number; x1: number; y1: number; start: number; end: number; depth: number; word: string | null; leaf: boolean; flower: boolean; seed: number }
interface Plant { root: number; height: number; branches: Branch[]; birth: number; life: number; lean: number; leanV: number; seed: number; hue: number; bloom: [number, number, number] }

const BLOOMS: [number, number, number][] = [[255, 140, 180], [255, 190, 110], [190, 150, 255], [120, 210, 255], [255, 110, 120], [255, 230, 130]];
const GROW_SECONDS = 26;

const factory: WorldFactory = (env) =>
  asciiWorld(
    env,
    {
      cell: [8, 12],
      chars: CHARS,
      glow: 0.2,
      tile: 0.96,
      tileInk: 0.5,
      weight: 600,
      background: /* glsl */ `
        vec3 col = mix(vec3(0.03, 0.11, 0.11), vec3(0.012, 0.035, 0.07), smoothstep(0.0, 1.0, uv.y));
        float aspect = uRes.x / uRes.y;
        vec2 p = vec2(uv.x * aspect, uv.y);
        // morning mist between the plants
        float m = fbm3(p * 1.5 + vec2(uTime * 0.016, 0.0));
        col += vec3(0.02, 0.09, 0.075) * smoothstep(0.4, 0.75, m) * smoothstep(0.75, 0.05, uv.y);
        // a faint grid, as if the garden grew on a screen
        vec2 g = abs(fract(p * vec2(9.0, 9.0)) - 0.5);
        float line = smoothstep(0.492, 0.5, max(g.x, g.y));
        col += vec3(0.01, 0.045, 0.04) * line * smoothstep(0.9, 0.2, uv.y);
        vec2 q = vec2(uMouse.x * aspect, uMouse.y);
        col += vec3(0.02, 0.09, 0.07) * uStrength * exp(-dot(p - q, p - q) * 7.0);
        return col;`,
    },
    (c) => {
      const a = c.aspect;
      const leafRamp = c.ramp('*+o%#@');
      const flowerRamp = c.ramp('*o@O0');
      const ground = c.ramp('_.,:~-');
      const seedGlyph = c.ramp('.,*');
      const tokens = c.ramp('{}[]()<>=+;:!?^');
      const slash = { v: c.index('|'), f: c.index('/'), b: c.index('\\'), h: c.index('_') };
      let plants: Plant[] = [];
      let seeds: { x: number; y: number; vx: number; vy: number; life: number; color: [number, number, number] }[] = [];

      const grow = (p: Plant, x: number, y: number, ang: number, len: number, depth: number, start: number, rnd: number) => {
        const x1 = x + (Math.cos(ang) * len) / a;
        const y1 = y + Math.sin(ang) * len;
        const end = start + 0.2 + (len / Math.max(1, p.height)) * 0.2;
        const word = depth < 3 && hash(rnd * 3.3) > 0.34 ? STEM_WORDS[(hash(rnd * 5.1) * STEM_WORDS.length) | 0] : null;
        const tip = depth >= 4 || len < 3.2;
        p.branches.push({ x0: x, y0: y, x1, y1, start, end, depth, word, leaf: tip || (depth >= 2 && hash(rnd * 7.7) > 0.45), flower: tip && hash(rnd * 9.1) > 0.34, seed: rnd });
        if (tip) return;
        const kids = depth < 2 ? 2 + ((hash(rnd * 2.1) * 2) | 0) : 2;
        for (let k = 0; k < kids; k++) {
          const f = kids === 1 ? 0 : k / (kids - 1) - 0.5;
          const spread = 1.05 + hash(rnd * 11.3 + k) * 0.7;
          const nextAng = ang + f * spread + (hash(rnd * 13.1 + k) - 0.5) * 0.34;
          // keep branches rising: a garden, not a root system
          const lifted = nextAng + (-Math.PI / 2 - nextAng) * 0.12;
          grow(p, x1, y1, lifted, len * (0.62 + hash(rnd * 17 + k) * 0.2), depth + 1, end - 0.02, rnd * 1.37 + k * 7.1 + 1);
        }
      };
      const makePlant = (root: number, height: number, birth: number, seed: number): Plant => {
        const p: Plant = { root, height, branches: [], birth, life: GROW_SECONDS * (1.9 + hash(seed) * 0.8), lean: 0, leanV: 0, seed, hue: hash(seed * 3.3), bloom: BLOOMS[(hash(seed * 7.1) * BLOOMS.length) | 0] };
        grow(p, root, c.rows - 2, -Math.PI / 2 + (hash(seed * 2.2) - 0.5) * 0.7, height, 0, 0, seed + 1.3);
        return p;
      };
      const seedPlants = (time: number) => {
        const n = Math.max(3, Math.round(c.cols / 26));
        plants = Array.from({ length: n }, (_, i) => {
          const u = (i + 0.5) / n + (hash(i * 3.1) - 0.5) * 0.08;
          const big = hash(i * 1.9);
          // Taller at the edges: the middle of the screen, where the lessons are, stays lighter.
          const edge = Math.abs(u - 0.5) * 2;
          const height = c.rows * (0.13 + 0.09 * big + edge * edge * 0.1);
          const p = makePlant(u * c.cols, height, time - GROW_SECONDS * (0.45 + hash(i * 4.4) * 0.9), i * 19.7 + 3);
          return p;
        });
      };
      seedPlants(0);
      let clock = 0;
      return {
        resize() {
          seedPlants(clock);
        },
        pulse(x, y) {
          for (const p of plants) {
            const d = (p.root - x) * a;
            if (Math.abs(d) < 34) p.leanV += Math.sign(d || 1) * 16 * (1 - Math.abs(d) / 34);
          }
          for (let i = 0; i < 26 && seeds.length < 140; i++) {
            const ang = hash(i * 3.3 + clock) * Math.PI * 2;
            const speed = 4 + hash(i * 9.9 + clock) * 14;
            seeds.push({ x, y, vx: (Math.cos(ang) * speed) / a, vy: Math.sin(ang) * speed, life: 2.2, color: BLOOMS[i % BLOOMS.length] });
          }
        },
        step(dt) {
          clock += dt;
          const p = c.pointer();
          plants.forEach((plant, i) => {
            // Wind plus a lean toward the pointer; a spring brings every plant back.
            const toward = p.strength > 0.01 ? clamp(((p.x - plant.root) * a) / 60, -1, 1) * (1 - Math.min(1, Math.abs((p.x - plant.root) * a) / 80)) * 3.2 * p.strength : 0;
            const wind = (noise2(clock * 0.14, plant.seed) - 0.5) * 1.1;
            plant.leanV += (toward + wind - plant.lean) * 3 * dt;
            plant.leanV *= Math.exp(-dt * 1.8);
            plant.lean += plant.leanV * dt;
            const age = clock - plant.birth;
            if (age > plant.life) {
              for (const b of plant.branches) {
                if (b.flower && seeds.length < 140) seeds.push({ x: b.x1, y: b.y1, vx: (hash(b.seed) - 0.5) * 3, vy: -1 - hash(b.seed * 2) * 2, life: 4 + hash(b.seed * 3) * 4, color: plant.bloom });
              }
              plants[i] = makePlant(plant.root + (hash(clock + i) - 0.5) * 14, plant.height * (0.9 + hash(clock * 2 + i) * 0.2), clock, plant.seed + 13.1);
            }
          });
          seeds = seeds.filter((s) => s.life > 0 && s.y < c.rows);
          for (const s of seeds) {
            s.vy += 2.2 * dt;
            s.vx += (noise2(s.x * 0.05, clock * 0.4) - 0.5) * 8 * dt;
            s.vx *= Math.exp(-dt * 0.8);
            s.vy *= Math.exp(-dt * 0.8);
            s.x += s.vx * dt;
            s.y += s.vy * dt;
            s.life -= dt;
          }
        },
        draw(t) {
          const { cols, rows } = c;
          const pointer = c.pointer();
          // Soil: a low band of quiet symbols.
          for (let x = 0; x < cols; x++) {
            const top = rows - 2 - Math.round(noise2(x * 0.05, 3) * 2.5);
            for (let y = top; y < rows; y++) {
              const g = ground[(hash2(x, y) * ground.length) | 0];
              const k = 0.5 + 0.5 * (y - top) / 3;
              c.put(x, y, g, 24 + 30 * k, 72 + 52 * k, 62 + 28 * k);
            }
          }
          for (const plant of plants) drawPlant(plant, t, pointer);
          for (const s of seeds) {
            const k = clamp(s.life);
            c.put(s.x, s.y, seedGlyph[(s.life * 3) & 1], s.color[0] * k, s.color[1] * k, s.color[2] * k);
          }
        },
      };

      function drawPlant(plant: Plant, t: number, pointer: { x: number; y: number; strength: number }) {
        const age = clock - plant.birth;
        // grows for GROW_SECONDS, stays in bloom, then wilts in its last seconds
        const progress = age / GROW_SECONDS;
        const wilt = sstep(plant.life - 4, plant.life, age);
        const ownBreath = Math.sin(t * 0.7 + plant.seed) * 0.32;
        const offset = (y: number) => {
          const lift = clamp((c.rows - y) / Math.max(4, plant.height * 2));
          return (plant.lean + ownBreath) * lift * lift * 4.5;
        };
        for (const b of plant.branches) {
          if (progress < b.start) continue;
          const open = clamp((progress - b.start) / Math.max(0.001, b.end - b.start));
          const dx = (b.x1 - b.x0) * a;
          const dy = b.y1 - b.y0;
          const len = Math.hypot(dx, dy);
          const steps = Math.ceil(len);
          const angle = Math.atan2(dy, dx);
          const absSlope = Math.abs(Math.sin(angle));
          const stem = absSlope > 0.85 ? slash.v : absSlope < 0.34 ? slash.h : dy * dx < 0 ? slash.f : slash.b;
          for (let i = 0; i <= steps * open; i++) {
            const f = i / Math.max(1, steps);
            const y = b.y0 + (b.y1 - b.y0) * f;
            const x = b.x0 + (b.x1 - b.x0) * f + offset(y);
            const trunk = 1 - b.depth * 0.14;
            let glyph = stem;
            // The stem is written with a word where it can hold one.
            if (b.word && i < b.word.length && absSlope > 0.2) {
              const w = c.index(b.word[i]);
              if (w) glyph = w;
            }
            // Near the pointer, letters rearrange themselves into other tokens.
            const near = pointer.strength > 0.01 ? Math.hypot((x - pointer.x) * a, y - pointer.y) : 99;
            if (near < 9) glyph = tokens[(hash2(x | 0, (y + t * 3) | 0) * tokens.length) | 0];
            const w = 1 - wilt * 0.65;
            c.put(x, y, glyph, (40 + 62 * trunk + (near < 9 ? 150 : 0)) * w, (172 + 60 * trunk) * w, (110 + 30 * trunk) * w);
          }
          if (open < 1) continue;
          const tipY = b.y1;
          const tipX = b.x1 + offset(tipY);
          if (b.leaf) {
            const r = 1.4 + hash(b.seed * 1.7) * 1.8;
            for (let y = -r; y <= r; y++) {
              for (let x = -r / a; x <= r / a; x++) {
                if (Math.hypot(x * a, y) > r) continue;
                const n = hash2((b.seed * 99 + x) | 0, (y * 3) | 0);
                if (n > 0.8) continue;
                const shade = 0.72 + n * 0.5;
                const g = leafRamp[(n * leafRamp.length) | 0];
                const fade = 1 - wilt * 0.65;
                c.put(tipX + x, tipY + y, g, (52 + 92 * plant.hue) * shade * fade, (190 + 30 * plant.hue) * shade * fade, (96 + 26 * plant.hue) * shade * fade);
              }
            }
          }
          if (b.flower) {
            const pulse = sstep(b.end, b.end + 0.3, progress) * (1 - wilt);
            if (pulse > 0.05) {
              const r = (1.7 + hash(b.seed * 2.9) * 2.1) * pulse;
              const ring = Math.ceil(r + 1);
              for (let y = -ring; y <= ring; y++) {
                for (let x = -ring / a; x <= ring / a; x++) {
                  const dx2 = x * a;
                  const d = Math.hypot(dx2, y);
                  const petal = r * (0.8 + 0.3 * Math.cos(Math.atan2(y, dx2) * 5 + b.seed));
                  if (d > petal) continue;
                  const g = flowerRamp[(hash2((b.seed * 41 + x) | 0, y | 0) * flowerRamp.length) | 0];
                  if (d < r * 0.24) c.put(tipX + x, tipY + y, g | TILE, 255, 226, 130);
                  else c.put(tipX + x, tipY + y, g | TILE, plant.bloom[0], plant.bloom[1], plant.bloom[2]);
                }
              }
            }
          }
        }
      }
    },
  );

export default factory;
