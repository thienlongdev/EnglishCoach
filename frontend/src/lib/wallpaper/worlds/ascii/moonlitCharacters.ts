import type { WorldFactory } from '../types';
import { asciiWorld, clamp, fbm, hash, hash2, noise2, sstep, WaveField } from './engine';

/**
 * Moonlit Characters. A moon built of letters, shaded like a sphere with real maria from noise; thin cloud crosses it.
 * Below, a still lake with a wave equation: the moon's glitter road breaks on every ripple. Stars are sparse. When the
 * pointer passes, nearby stars link up into a small constellation, and the words of the night appear beside them.
 */

const CHARS = ' .,:;-~=+*°\'`oxXO0%#@nighstqu lemaowrd';

const WORDS = ['quiet', 'moon', 'listen', 'night', 'dream', 'still', 'water', 'read', 'slow', 'star', 'glow', 'mind'];

interface Star { x: number; y: number; b: number; seed: number }

const factory: WorldFactory = (env) =>
  asciiWorld(
    env,
    {
      cell: [8, 12],
      chars: CHARS,
      glow: 0.3,
      weight: 500,
      background: /* glsl */ `
        vec3 top = vec3(0.012, 0.018, 0.07);
        vec3 mid = vec3(0.035, 0.06, 0.17);
        vec3 col = mix(mid, top, smoothstep(0.32, 1.0, uv.y));
        float aspect = uRes.x / uRes.y;
        vec2 p = vec2(uv.x * aspect, uv.y);
        vec2 moon = vec2(aspect * 0.72, 0.72);
        float d = length(p - moon);
        col += vec3(0.1, 0.13, 0.24) * exp(-d * 2.9);
        col += vec3(0.05, 0.06, 0.12) * exp(-d * 1.1);
        // the lake: darker, a band of moon haze on its far edge
        float lake = smoothstep(0.302, 0.298, uv.y);
        vec3 water = mix(vec3(0.01, 0.018, 0.06), vec3(0.03, 0.05, 0.13), smoothstep(0.0, 0.3, uv.y));
        water += vec3(0.05, 0.07, 0.14) * exp(-abs(p.x - moon.x) * 3.2) * smoothstep(0.0, 0.3, uv.y);
        col = mix(col, water, lake);
        return col;`,
    },
    (c) => {
      const a = c.aspect;
      const moonRamp = c.ramp('.:-=+oxX0%#@');
      const starRamp = c.ramp(".,'`*+");
      const hill = c.ramp('nighstqu');
      const glitter = c.ramp('.-~=');
      const link = c.index('.');
      const horizon = () => Math.round(c.rows * 0.7);
      let wave = new WaveField(c.cols, Math.max(4, c.rows - horizon()), 0.978);
      let stars: Star[] = [];
      const seedStars = () => {
        stars = [];
        const h = horizon();
        const n = Math.round(c.cols * h * 0.012);
        for (let i = 0; i < n; i++) stars.push({ x: hash(i * 2.1) * c.cols, y: hash(i * 3.9) * (h - 8), b: 0.25 + Math.pow(hash(i * 5.7), 3) * 0.75, seed: i });
      };
      seedStars();
      // Constellations appear near the pointer and fade after it leaves.
      const energy = new Float32Array(1024);
      const tmpNear: number[] = [];
      return {
        resize() {
          wave = new WaveField(c.cols, Math.max(4, c.rows - horizon()), 0.978);
          seedStars();
        },
        pulse(x, y) {
          const h = horizon();
          if (y > h) wave.splash(x, y - h, 4, 34, a);
        },
        step(dt, t) {
          const p = c.pointer();
          const h = horizon();
          if (p.py > h && p.energy > 0.03) wave.splash(p.px, p.py - h, 2.4, p.energy * 3, a);
          // a fish, somewhere, once in a while
          if (Math.random() < dt * 0.28) wave.splash(hash(t * 7.3) * c.cols, hash(t * 3.1) * wave.h, 1.6, 9, a);
          wave.step();
          tmpNear.length = 0;
          for (let i = 0; i < stars.length && i < energy.length; i++) {
            const s = stars[i];
            const d = Math.hypot((s.x - p.x) * a, s.y - p.y);
            const wanted = p.strength > 0.01 && d < 30 && s.b > 0.2 ? Math.min(1, (1 - d / 30) * 1.5) * p.strength : 0;
            energy[i] += (wanted - energy[i]) * Math.min(1, dt * (wanted > energy[i] ? 5 : 0.9));
          }
        },
        draw(t) {
          const { cols, rows } = c;
          const h = horizon();
          // Stars.
          for (let i = 0; i < stars.length; i++) {
            const s = stars[i];
            const tw = 0.6 + 0.4 * Math.sin(t * (0.5 + (s.seed % 7) * 0.13) + s.seed);
            const lit = Math.min(1.2, s.b * tw + (energy[i] ?? 0) * 0.7);
            const g = starRamp[Math.min(starRamp.length - 1, (lit * starRamp.length) | 0)];
            c.put(s.x, s.y, g, 170 * lit + 40, 190 * lit + 40, 255 * lit);
          }
          // Constellation lines between stars the pointer has woken, and a word beside each bright one.
          for (let i = 0; i < stars.length; i++) {
            const e = energy[i] ?? 0;
            if (e < 0.14) continue;
            const s = stars[i];
            let links = 0;
            for (let j = i + 1; j < stars.length && links < 2; j++) {
              const f = energy[j] ?? 0;
              if (f < 0.14) continue;
              const q = stars[j];
              const dx = (q.x - s.x) * a;
              const dy = q.y - s.y;
              const d = Math.hypot(dx, dy);
              if (d > 13 || d < 2) continue;
              links += 1;
              const k = Math.min(e, f);
              const steps = Math.ceil(d);
              for (let n = 1; n < steps; n += 1) {
                const lx = s.x + (q.x - s.x) * (n / steps);
                const ly = s.y + (q.y - s.y) * (n / steps);
                c.put(lx, ly, link, 120 * k + 50, 140 * k + 60, 210 * k + 40);
              }
            }
            if (e > 0.42 && s.b > 0.34) {
              const word = WORDS[s.seed % WORDS.length];
              c.text(s.x + 2, s.y - 1, word, 190 * e + 50, 205 * e + 50, 255 * e);
            }
          }
          // The moon.
          const mx = cols * 0.72;
          const my = rows * 0.28;
          const mr = Math.min(rows * 0.22, 19);
          const span = Math.ceil(mr / a);
          for (let y = (my - mr) | 0; y <= my + mr; y++) {
            for (let x = (mx - span) | 0; x <= mx + span; x++) {
              const dx = ((x - mx) * a) / mr;
              const dy = (y - my) / mr;
              const dd = dx * dx + dy * dy;
              if (dd > 1) continue;
              const z = Math.sqrt(1 - dd);
              // Lambert from the upper left, a sphere-mapped mare pattern, and cloud shadow crossing it.
              const light = clamp(z * 0.72 + (-dx * 0.42 - dy * 0.34) + 0.16);
              const sx = dx / (1 + z);
              const sy = dy / (1 + z);
              const mare = fbm(sx * 3.4 + 2.2, sy * 3.4 + 1.1, 3);
              const crater = sstep(0.56, 0.68, noise2(sx * 11 + 4, sy * 11));
              const cloud = sstep(0.5, 0.74, fbm(x * 0.045 + t * 0.05, y * 0.13, 2));
              const value = clamp(light * (0.98 - sstep(0.46, 0.6, mare) * 0.32 - crater * 0.09)) * (1 - cloud * 0.46);
              const g = moonRamp[Math.min(moonRamp.length - 1, (value * moonRamp.length) | 0)];
              c.put(x, y, g, 170 + value * 85, 182 + value * 70, 208 + value * 47);
            }
          }
          // Thin cloud around it: letters of a wide, slow noise.
          for (let y = 0; y < h - 5; y += 1) {
            for (let x = 0; x < cols; x += 1) {
              const v = fbm(x * 0.022 + t * 0.03, y * 0.12 + 3, 3);
              if (v < 0.62) continue;
              if (hash2(x, y) > (v - 0.62) * 4) continue;
              c.put(x, y, glitter[(hash2(y, x) * 3) | 0], 96, 112, 150);
            }
          }
          // Far hills, written with the night's own letters.
          for (let x = 0; x < cols; x++) {
            const top = h - 1 - Math.floor((fbm(x * 0.024, 7.7, 3) - 0.34) * 22);
            for (let y = Math.max(0, top); y < h; y++) {
              const g = hill[(hash2(x, y) * hill.length) | 0];
              const shade = 0.5 + 0.5 * ((y - top) / Math.max(1, h - top));
              c.put(x, y, g, 22 + 16 * shade, 34 + 18 * shade, 64 + 26 * shade);
            }
          }
          // The lake: the mirror of the moon, broken by real waves.
          for (let y = h; y < rows; y++) {
            const wy = y - h;
            const depth = wy / Math.max(1, rows - h);
            for (let x = 0; x < cols; x++) {
              const ripple = wave.at(x, wy);
              const bend = (wave.at(x + 1, wy) - wave.at(x - 1, wy)) * 0.4;
              const lane = Math.abs((x + bend - mx) * a) / (mr * (0.6 + depth * 1.4));
              const shimmer = noise2(x * 0.14 + t * 0.32, wy * 0.72 - t * 0.5);
              const road = sstep(1.3, 0.1, lane) * sstep(0.34, 0.68, shimmer + Math.abs(ripple) * 0.05);
              const crest = Math.abs(ripple) * 0.11;
              const value = Math.max(road, crest);
              if (value < 0.12) {
                if (hash2(x + (t * 0.5) | 0, y) > 0.992) c.put(x, y, glitter[0], 60, 76, 120);
                continue;
              }
              const g = glitter[Math.min(3, (value * 4) | 0)];
              c.put(x, y, g, 120 + value * 130, 138 + value * 112, 186 + value * 69);
            }
          }
        },
      };
    },
  );

export default factory;
