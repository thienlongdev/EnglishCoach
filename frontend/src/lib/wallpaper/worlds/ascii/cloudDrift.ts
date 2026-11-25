import type { WorldFactory } from '../types';
import { asciiWorld, clamp, fbm, hash, hash2, mix, noise2, Sheet, sstep, TILE } from './engine';

/**
 * Cloud Drift. Clouds are metaball puffs eroded by noise and written as small letter tiles; a sun of characters sits in
 * the corner, a paper plane crosses now and then. The pointer pushes an elastic sheet: clouds lean away, tear a little
 * and pull themselves together again. Day sky in light appearance, moonlit in dark.
 */

const CHARS = ' .,:;-~=+*oxXO0%#@tseuloa°^/\\<>_';

interface Puff { dx: number; dy: number; r: number }
interface Cloud { x: number; y: number; speed: number; scale: number; seed: number; puffs: Puff[]; depth: number }

const factory: WorldFactory = (env) =>
  asciiWorld(
    env,
    {
      cell: [8, 12],
      chars: CHARS,
      glow: 0.05,
      tile: 0.97,
      tileInk: 0.88,
      weight: 600,
      background: /* glsl */ `
        vec3 dayTop = vec3(0.27, 0.56, 0.94);
        vec3 dayLow = vec3(0.75, 0.90, 0.99);
        vec3 nightTop = vec3(0.02, 0.05, 0.16);
        vec3 nightLow = vec3(0.08, 0.15, 0.30);
        vec3 top = mix(dayTop, nightTop, uDark);
        vec3 low = mix(dayLow, nightLow, uDark);
        vec3 col = mix(low, top, smoothstep(0.0, 1.0, uv.y));
        float aspect = uRes.x / uRes.y;
        vec2 p = vec2(uv.x * aspect, uv.y);
        vec2 sun = vec2(aspect * 0.86, 0.84);
        float d = length(p - sun);
        col += mix(vec3(1.0, 0.92, 0.72) * 0.42, vec3(0.52, 0.6, 0.86) * 0.26, uDark) * exp(-d * 3.2);
        float streak = fbm2(vec2(p.x * 1.2 + uTime * 0.01, p.y * 7.0));
        col += mix(vec3(0.05), vec3(0.015, 0.02, 0.035), uDark) * smoothstep(0.42, 0.7, streak);
        return col;`,
    },
    (c) => {
      const a = c.aspect;
      const ramp = c.ramp('tseuloa');
      const edge = c.ramp('.:~-');
      const sunRamp = c.ramp('*+o0');
      const planeBody = c.index('/');
      const planeBack = c.index('\\');
      const planeLine = c.index('_');
      const trail = c.index('.');
      const star = c.ramp('.,+°');
      let sheet = new Sheet(c.cols, c.rows, 5, 3.4, 1.7);
      let clouds: Cloud[] = [];
      const out = { x: 0, y: 0 };
      const makeCloud = (i: number, x: number): Cloud => {
        const depth = hash(i * 5.1);
        const scale = (c.rows < 44 ? 0.62 : 0.86) * (0.5 + depth * 0.72);
        const n = 7 + ((hash(i * 2.2) * 6) | 0);
        const puffs: Puff[] = [];
        for (let k = 0; k < n; k++) {
          const f = k / Math.max(1, n - 1);
          const crown = Math.pow(1 - Math.abs(f - 0.5) * 2, 0.7);
          const dx = (f - 0.5) * 42 * scale + (hash(i + k * 1.9) - 0.5) * 3 * scale;
          const r = (2.6 + crown * 6.4 + hash(i * 7 + k) * 2.4) * scale;
          puffs.push({ dx, dy: -r * 0.55 - crown * 2 * scale, r });
        }
        return { x, y: 5 + hash(i * 3.7) * (c.rows * 0.82), speed: 0.45 + depth * 1.05, scale, seed: i * 9.7, puffs, depth };
      };
      const build = () => {
        const count = Math.max(6, Math.round(c.cols / 20));
        clouds = Array.from({ length: count }, (_, i) => makeCloud(i, hash(i * 11.3) * (c.cols + 60) - 30));
        clouds.sort((p, q) => p.depth - q.depth);
      };
      build();
      let planeX = -40;
      let planeY = 10;
      let planeWait = 6;
      let spawn = 0;
      return {
        resize() {
          sheet = new Sheet(c.cols, c.rows, 5, 3.4, 1.7);
          build();
        },
        pulse(x, y) {
          sheet.burst(x, y, 150, 22, a);
        },
        step(dt) {
          const p = c.pointer();
          if (p.energy > 0.02) sheet.push(p.px, p.py, p.vx * 0.42 * p.strength, p.vy * 0.42 * p.strength, 17, a);
          sheet.step(dt);
          for (const cloud of clouds) {
            cloud.x += cloud.speed * dt;
            const extent = 34 * cloud.scale / a;
            if (cloud.x - extent > c.cols + 8) {
              cloud.x = -extent - 8;
              spawn += 1;
              const fresh = makeCloud(spawn * 3 + 101, cloud.x);
              cloud.puffs = fresh.puffs;
              cloud.y = fresh.y;
              cloud.seed = fresh.seed;
            }
          }
          if (planeWait > 0) {
            planeWait -= dt;
            if (planeWait <= 0) {
              planeX = -14;
              planeY = 6 + hash(spawn + 3.1) * c.rows * 0.5;
            }
          } else {
            planeX += dt * 13;
            planeY += Math.sin(planeX * 0.05) * dt * 0.9;
            if (planeX > c.cols + 30) planeWait = 20;
          }
        },
        draw(t) {
          const { cols, rows } = c;
          const night = c.dark();
          // Sun or moon, in the sky's corner.
          const sunX = cols * 0.86;
          const sunY = rows * 0.16;
          const sunR = Math.min(9, rows * 0.13);
          for (let y = (sunY - sunR - 5) | 0; y <= sunY + sunR + 5; y++) {
            for (let x = (sunX - (sunR + 5) / a) | 0; x <= sunX + (sunR + 5) / a; x++) {
              const dx = (x - sunX) * a;
              const dy = y - sunY;
              const d = Math.hypot(dx, dy);
              if (d < sunR) {
                const crater = night ? noise2(x * 0.3, y * 0.42) : 0;
                const shade = 0.82 + 0.18 * (1 - d / sunR) - crater * 0.28;
                c.put(x, y, sunRamp[(hash2(x, y) * sunRamp.length) | 0] | TILE, night ? 216 * shade : 255, night ? 224 * shade : 224 * shade + 18, night ? 240 * shade : 150 * shade);
              } else if (!night && d < sunR + 5) {
                const ang = Math.atan2(dy, dx);
                const ray = Math.sin(ang * 12 + t * 0.35);
                if (ray > 0.55 && hash2(x, y) > 0.45) c.put(x, y, edge[1], 255, 228, 150);
              }
            }
          }
          if (night) {
            for (let i = 0; i < 90; i++) {
              const x = hash(i * 1.9) * cols;
              const y = hash(i * 4.3) * rows * 0.86;
              const tw = 0.4 + 0.6 * Math.abs(Math.sin(t * 0.5 + i));
              c.put(x, y, star[i % star.length], 150 * tw + 70, 170 * tw + 60, 220 * tw + 30);
            }
          }
          // Clouds, far ones first.
          for (const cloud of clouds) drawCloud(cloud, t, night);
          // A paper plane: small, rare, and it never hurries.
          if (planeWait <= 0) {
            const px = planeX | 0;
            const py = planeY | 0;
            const ink = night ? [220, 226, 240] : [255, 255, 255];
            c.put(px, py, planeBody | TILE, ink[0], ink[1], ink[2]);
            c.put(px - 1, py, planeBody | TILE, ink[0] * 0.9, ink[1] * 0.9, ink[2] * 0.92);
            c.put(px - 2, py + 1, planeBack | TILE, ink[0] * 0.84, ink[1] * 0.84, ink[2] * 0.9);
            c.put(px - 1, py + 1, planeLine | TILE, ink[0] * 0.75, ink[1] * 0.75, ink[2] * 0.84);
            for (let i = 3; i < 14; i += 2) c.put(px - i, py + 1 + Math.sin(i * 0.3 + t) * 0.5, trail, 255, 255, 255);
          }
        },
      };

      function drawCloud(cloud: Cloud, t: number, night: boolean) {
        const span = (28 * cloud.scale) / a;
        const height = 16 * cloud.scale;
        for (let y = Math.floor(cloud.y - height); y <= Math.ceil(cloud.y + 2); y++) {
          for (let x = Math.floor(cloud.x - span - 6); x <= Math.ceil(cloud.x + span + 6); x++) {
            if (x < 0 || y < 0 || x >= c.cols || y >= c.rows) continue;
            sheet.sample(x, y, out);
            const qx = (x - out.x - cloud.x) * a;
            const qy = y - out.y - cloud.y;
            // A union of round puffs gives real cumulus scallops; a little drifting noise keeps the outline alive.
            let best = -1;
            for (const puff of cloud.puffs) {
              const d = Math.hypot(qx - puff.dx, qy - puff.dy);
              const v = 1 - d / puff.r;
              if (v > best) best = v;
            }
            const erosion = fbm(x * 0.09 + cloud.seed + t * 0.05, y * 0.2 - t * 0.03, 2);
            const value = best - (erosion - 0.5) * 0.34;
            if (value <= 0 || qy > 0.6) continue;
            const inner = clamp(value / 0.5);
            const stable = hash2((x + cloud.seed) | 0, y);
            if (value < 0.07) {
              if (stable < 0.6) {
                const g = edge[(stable * 7.3) & 3];
                if (night) c.put(x, y, g, 150, 168, 206);
                else c.put(x, y, g, 255, 255, 255);
              }
              continue;
            }
            // Lit from above: tops are pure, undersides pick up the sky.
            const under = sstep(-height * 0.34, 0.5, qy);
            const shade = (1 - under * 0.2) * (0.92 + inner * 0.08) * mix(0.9, 1, cloud.depth);
            const g = ramp[(hash2((qx * 0.5) | 0, (qy * 1.1) | 0) * ramp.length) | 0];
            if (night) c.put(x, y, g | TILE, 122 * shade + 18, 136 * shade + 20, 176 * shade + 22);
            else c.put(x, y, g | TILE, 255 * shade, 255 * mix(shade, 1, 0.3), 255 * mix(shade, 1, 0.75));
          }
        }
      }
    },
  );

export default factory;
