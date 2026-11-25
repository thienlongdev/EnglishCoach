import type { WorldFactory } from '../types';
import { asciiWorld, clamp, fbm, hash, hash2, noise2, sstep } from './engine';

/**
 * Fireflies at Dusk. A meadow of swaying letters under a dusk sky, with a far tree line. Each firefly wanders on its own
 * noise path and flashes on its own rhythm; every flash lights the blades of grass below it. The pointer draws them in
 * slowly; a press scatters them and they drift back.
 */

const CHARS = ' .,:;\'`|/\\!-~=+*oO°^vVYTA#%';

interface Fly { x: number; y: number; vx: number; vy: number; seed: number; phase: number; rate: number; lit: number; scatter: number }

const factory: WorldFactory = (env) =>
  asciiWorld(
    env,
    {
      cell: [8, 12],
      chars: CHARS,
      glow: 0.3,
      weight: 600,
      background: /* glsl */ `
        vec3 top = vec3(0.03, 0.035, 0.13);
        vec3 mid = vec3(0.19, 0.11, 0.26);
        vec3 glow = vec3(0.62, 0.30, 0.20);
        vec3 horizon = vec3(0.86, 0.50, 0.26);
        float y = uv.y;
        vec3 col = mix(glow, mid, smoothstep(0.34, 0.56, y));
        col = mix(col, top, smoothstep(0.5, 1.0, y));
        col = mix(horizon, col, smoothstep(0.255, 0.4, y));
        // the meadow below the horizon is dark, almost black green
        col = mix(mix(vec3(0.015, 0.05, 0.05), vec3(0.03, 0.09, 0.07), y / 0.27), col, smoothstep(0.255, 0.268, y));
        float aspect = uRes.x / uRes.y;
        vec2 p = vec2(uv.x * aspect, y);
        float band = fbm3(vec2(p.x * 1.4 + uTime * 0.008, p.y * 8.0));
        col += vec3(0.16, 0.07, 0.07) * smoothstep(0.5, 0.8, band) * smoothstep(0.7, 0.3, y) * smoothstep(0.26, 0.34, y);
        // one low evening star field
        vec2 g = p * 60.0; vec2 id = floor(g); vec2 f = fract(g) - 0.5;
        float s = step(0.984, hash21(id)) * smoothstep(0.2, 0.0, length(f)) * smoothstep(0.55, 0.95, y);
        col += vec3(0.7, 0.75, 1.0) * s * 0.7;
        return col;`,
    },
    (c) => {
      const a = c.aspect;
      const fly = c.ramp('*+°o');
      const halo = c.ramp(".,'`");
      const blades = c.ramp('|/\\!');
      const flowers = c.ramp('Y^*');
      const tree = c.ramp('#%AVT');
      const horizonRow = () => Math.round(c.rows * 0.74);
      let flies: Fly[] = [];
      const seed = () => {
        const n = Math.round(clamp((c.cols * c.rows) / 280, 26, 76));
        flies = Array.from({ length: n }, (_, i) => ({
          x: hash(i * 1.3) * c.cols, y: c.rows * (0.32 + 0.62 * hash(i * 2.7)), vx: 0, vy: 0,
          seed: i * 7.7 + 1, phase: hash(i * 3.3), rate: 0.16 + hash(i * 5.1) * 0.2, lit: 0, scatter: 0,
        }));
      };
      seed();
      return {
        resize: seed,
        pulse(x, y) {
          for (const f of flies) {
            const dx = (f.x - x) * a;
            const dy = f.y - y;
            const d = Math.hypot(dx, dy) + 0.1;
            if (d < 30) {
              const k = (1 - d / 30) * 42;
              f.vx += ((dx / d) * k) / a;
              f.vy += (dy / d) * k;
              f.scatter = 2.5;
              f.phase = 0;
            }
          }
        },
        step(dt, t) {
          const p = c.pointer();
          for (const f of flies) {
            // wander on a private noise path
            const nx = noise2(f.seed, t * 0.14) - 0.5;
            const ny = noise2(f.seed + 31, t * 0.14) - 0.5;
            let ax = nx * 13;
            let ay = ny * 9;
            // the pointer draws them in, softly, and they orbit instead of collapsing onto it
            if (p.strength > 0.01 && f.scatter <= 0) {
              const dx = (p.x - f.x) * a;
              const dy = p.y - f.y;
              const d = Math.hypot(dx, dy) + 0.1;
              if (d < 46) {
                const pull = (1 - d / 46) * 20 * p.strength;
                ax += ((dx / d) * pull * sstep(3, 12, d) + (-dy / d) * pull * 0.42) / a;
                ay += (dy / d) * pull * sstep(3, 12, d) + (dx / d) * pull * 0.42;
              }
            }
            if (f.y > c.rows - 2) ay -= 12;
            if (f.y < c.rows * 0.25) ay += 6;
            if (f.x < 1) ax += 10;
            if (f.x > c.cols - 1) ax -= 10;
            f.vx += ax * dt;
            f.vy += ay * dt;
            f.vx *= Math.exp(-dt * 1.3);
            f.vy *= Math.exp(-dt * 1.3);
            f.x += f.vx * dt;
            f.y += f.vy * dt;
            f.scatter = Math.max(0, f.scatter - dt);
            f.phase += dt * f.rate;
            const cycle = f.phase % 1;
            // A long dark, a fast rise and a soft fall: the rhythm of a real firefly.
            let target = cycle < 0.08 ? cycle / 0.08 : cycle < 0.42 ? 1 - (cycle - 0.08) / 0.34 : 0;
            // Near the pointer they keep their lights on: a small lantern of fireflies follows it.
            if (p.strength > 0.01) {
              const near = Math.hypot((f.x - p.x) * a, f.y - p.y);
              if (near < 16) target = Math.max(target, (0.55 + 0.35 * Math.sin(t * 3 + f.seed)) * (1 - near / 16) * p.strength * 1.6);
            }
            f.lit += (target - f.lit) * Math.min(1, dt * 12);
          }
        },
        draw(t) {
          const { cols, rows } = c;
          const h = horizonRow();
          // Far tree line against the low sky.
          for (let x = 0; x < cols; x++) {
            const shape = fbm(x * 0.03, 2.2, 3) * 0.75 + fbm(x * 0.14, 9.1, 2) * 0.25;
            const top = h - Math.floor(shape * 15);
            for (let y = Math.max(0, top); y < h + 1; y++) {
              const g = tree[(hash2(x, y) * tree.length) | 0];
              const fade = 0.5 + 0.5 * ((y - top) / 15);
              c.put(x, y, g, 18 + 10 * fade, 16 + 22 * fade, 34 + 14 * fade);
            }
          }
          // The meadow: rows of letters, stems lean with a wind that travels across the field.
          const lights = flies.filter((f) => f.lit > 0.12);
          for (let y = h; y < rows; y++) {
            const depth = (y - h) / Math.max(1, rows - h);
            for (let x = 0; x < cols; x++) {
              const stable = hash2(x, y);
              if (stable > 0.42 + depth * 0.5) continue;
              const wind = Math.sin(x * 0.06 - t * 0.9 + y * 0.12) * 0.5 + (noise2(x * 0.03 - t * 0.35, y * 0.05) - 0.5) * 2.2;
              const lean = wind > 0.28 ? 1 : wind < -0.28 ? 2 : stable > 0.2 ? 0 : 3;
              let glyph = blades[lean];
              let warm = 0;
              for (const f of lights) {
                const dx = (f.x - x) * a;
                const dy = f.y - y;
                const d2 = dx * dx + dy * dy * 1.3;
                if (d2 < 46) warm += ((46 - d2) / 46) * f.lit * 0.7;
              }
              warm = Math.min(1, warm);
              const base = 0.3 + depth * 0.5;
              let r = 16 + 30 * base + warm * 190;
              let g = 44 + 66 * base + warm * 150;
              let b = 36 + 40 * base + warm * 20;
              if (stable < 0.012) {
                glyph = flowers[(stable * 250) & 1];
                r = 210 + warm * 45;
                g = 120 + warm * 80;
                b = 150;
              }
              c.put(x, y, glyph, r, g, b);
            }
          }
          // The fireflies: a bright letter with a halo of fainter ones.
          for (const f of flies) {
            const l = f.lit;
            if (l < 0.03) {
              c.put(f.x, f.y, halo[0], 66, 58, 40);
              continue;
            }
            const g = fly[Math.min(3, ((1 - l) * 4) | 0)];
            c.put(f.x, f.y, g, 255, 240, 150 + 80 * l);
            if (l > 0.3) {
              const k = l * 0.8;
              c.put(f.x - 1, f.y, halo[1], 240 * k, 196 * k, 70 * k);
              c.put(f.x + 1, f.y, halo[1], 240 * k, 196 * k, 70 * k);
              c.put(f.x, f.y - 1, halo[2], 240 * k, 196 * k, 70 * k);
              c.put(f.x, f.y + 1, halo[3], 240 * k, 196 * k, 70 * k);
            }
          }
        },
      };
    },
  );

export default factory;
