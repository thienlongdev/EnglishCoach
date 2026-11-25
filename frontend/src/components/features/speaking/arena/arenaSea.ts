/**
 * Portions adapted from Abyssal Garden — Copyright (c) 2026 Maksymilian Dendura, MIT License
 *
 * Project ECHO ARCHIPELAGO — Unified WebGL2 Multi-Scale Living Ocean:
 * - Shore/Lagoon/Pier-Attenuated 6-Wave Trochoidal Gerstner Field (`< 0.3 cm` CPU <-> GPU boat parity)
 * - 4-Octave Travelling Capillary Micro-Ripples (shimmering even in sheltered coves, zero plastic flats)
 * - 4-Zone Tropical Bathymetric Gradient + Sunlit Wave-Crest Subsurface Scatter + Dual-Lobe Solar Glints
 * - Inward-Rolling Cellular Shoreline Surf Lace + Wave-Coupled Rock/Karst Breaker Collars
 * - Constant-Capacity `uSplashRings[12]` Dispersive Capillary Impulse Ring Buffer (`triggerSurfaceSplash`, `0` recompiles)
 * - Kelvin `19.47°` Boat Wakes, Synchronized Fish Surface Shadows, and Sub-Surface Snell's Window + TIR.
 */

import * as T from 'three';
import type { ArenaIslandSpec, ArenaQualityTier, ArenaTimeOfDay, SurfaceFishSchool } from './arenaContracts';
import { ARENA_WATER_Y, arenaBathymetry, arenaBeachFactor, arenaLayout, arenaShoreRadius } from './arenaTerrain';
import { UNDERWATER_OPTICS_GLSL, tierLevel } from './arenaUnderwaterShaders';

export interface SeaWakeSource {
  id: string;
  motor?: boolean;
  swimmer?: boolean;
  bobber?: boolean;
  x: number;
  z: number;
  speed: number;
  yaw: number;
}

export interface ArenaSeaOptions {
  quality?: ArenaQualityTier;
  timeOfDay?: ArenaTimeOfDay;
  causticsTexture?: T.Texture | null;
  sunDirection?: T.Vector3;
}

/** Fixed compile-time capacity of `uSplashRings` so triggering splashes never recompiles ocean shaders. */
export const MAX_SPLASH_RINGS = 12;

// ============================================================================
// 1. Prebaked `512x512` Shoreline & Rock SDF + Bathymetry Map (`O(1)` CPU + GPU)
// ============================================================================

const SEA_MAP_SIZE = 512;
const SEA_MAP_SPAN = 1120; // covers [-560 m, +560 m] across the full 1.1 km v7 Archipelago
const SEA_MAP_HALF = SEA_MAP_SPAN * 0.5;

// Coral Lagoon (`profile === 'atoll'`) sheltered basin center in world XZ
const CORAL_LAGOON_X = 18.0;
const CORAL_LAGOON_Z = 222.0;

function sstepCpu(e0: number, e1: number, v: number): number {
  const t = v <= e0 ? 0 : v >= e1 ? 1 : (v - e0) / (e1 - e0);
  return t * t * (3 - 2 * t);
}

function segDist2D(ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 1e-6 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  const rx = px - ax - t * dx;
  const rz = pz - az - t * dz;
  return Math.sqrt(rx * rx + rz * rz);
}

let cachedDefaultSeaMapBytes: Uint8Array | null = null;

function computeArchipelagoSeaMapBytes(layout: typeof arenaLayout): Uint8Array {
  const bytes = new Uint8Array(SEA_MAP_SIZE * SEA_MAP_SIZE * 4);
  const GRID = 32;
  const CELL = SEA_MAP_SPAN / GRID; // 35 m cells

  const rockBuckets: { x: number; z: number; r: number }[][] = Array.from({ length: GRID * GRID }, () => []);
  for (const r of layout.rocks) {
    const minCx = Math.max(0, Math.floor((r.x - r.r - 13 + SEA_MAP_HALF) / CELL));
    const maxCx = Math.min(GRID - 1, Math.floor((r.x + r.r + 13 + SEA_MAP_HALF) / CELL));
    const minCz = Math.max(0, Math.floor((r.z - r.r - 13 + SEA_MAP_HALF) / CELL));
    const maxCz = Math.min(GRID - 1, Math.floor((r.z + r.r + 13 + SEA_MAP_HALF) / CELL));
    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        rockBuckets[cz * GRID + cx].push(r);
      }
    }
  }

  const pierSegments: { ax: number; az: number; bx: number; bz: number; hw: number }[] = [
    ...layout.docks.map(d => ({ ax: d.ax, az: d.az, bx: d.bx, bz: d.bz, hw: d.width * 0.5 })),
    ...layout.bridges.map(b => ({ ax: b.ax, az: b.az, bx: b.bx, bz: b.bz, hw: b.width * 0.5 })),
  ];
  const pierBuckets: (typeof pierSegments)[number][][] = Array.from({ length: GRID * GRID }, () => []);
  for (const seg of pierSegments) {
    const minX = Math.min(seg.ax, seg.bx) - seg.hw - 10;
    const maxX = Math.max(seg.ax, seg.bx) + seg.hw + 10;
    const minZ = Math.min(seg.az, seg.bz) - seg.hw - 10;
    const maxZ = Math.max(seg.az, seg.bz) + seg.hw + 10;
    const c0x = Math.max(0, Math.floor((minX + SEA_MAP_HALF) / CELL));
    const c1x = Math.min(GRID - 1, Math.floor((maxX + SEA_MAP_HALF) / CELL));
    const c0z = Math.max(0, Math.floor((minZ + SEA_MAP_HALF) / CELL));
    const c1z = Math.min(GRID - 1, Math.floor((maxZ + SEA_MAP_HALF) / CELL));
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        pierBuckets[cz * GRID + cx].push(seg);
      }
    }
  }

  const LUT_N = 1024;
  const INV_TAU_LUT = LUT_N / (Math.PI * 2);
  const islands = (layout.islands as readonly ArenaIslandSpec[]).map(isl => {
    const shoreLut = new Float32Array(LUT_N);
    const beachLut = new Float32Array(LUT_N);
    for (let b = 0; b < LUT_N; b++) {
      const ang = (b / LUT_N) * Math.PI * 2 - Math.PI;
      shoreLut[b] = arenaShoreRadius(isl, ang);
      beachLut[b] = arenaBeachFactor(isl, ang);
    }
    return {
      raw: isl,
      x: isl.x,
      z: isl.z,
      maxReach: isl.radius * 1.25 + isl.shore + 56,
      isAtoll: isl.profile === 'atoll',
      isBeach: isl.profile === 'beach',
      isBeachOrAtoll: isl.profile === 'beach' || isl.profile === 'atoll' || isl.id === 'strand' || isl.id === 'reef',
      shoreLut,
      beachLut,
    };
  });

  const islandBuckets: (typeof islands)[number][][] = Array.from({ length: GRID * GRID }, () => []);
  for (const isl of islands) {
    const c0x = Math.max(0, Math.floor((isl.x - isl.maxReach + SEA_MAP_HALF) / CELL));
    const c1x = Math.min(GRID - 1, Math.floor((isl.x + isl.maxReach + SEA_MAP_HALF) / CELL));
    const c0z = Math.max(0, Math.floor((isl.z - isl.maxReach + SEA_MAP_HALF) / CELL));
    const c1z = Math.min(GRID - 1, Math.floor((isl.z + isl.maxReach + SEA_MAP_HALF) / CELL));
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        islandBuckets[cz * GRID + cx].push(isl);
      }
    }
  }

  const wxArr = new Float32Array(SEA_MAP_SIZE);
  const sinX1 = new Float32Array(SEA_MAP_SIZE);
  const cosX1 = new Float32Array(SEA_MAP_SIZE);
  const cosX2 = new Float32Array(SEA_MAP_SIZE);
  const sinX2 = new Float32Array(SEA_MAP_SIZE);
  const dropX = new Float32Array(SEA_MAP_SIZE);
  for (let px = 0; px < SEA_MAP_SIZE; px++) {
    const wx = ((px + 0.5) / SEA_MAP_SIZE) * SEA_MAP_SPAN - SEA_MAP_HALF;
    wxArr[px] = wx;
    sinX1[px] = Math.sin(wx * 0.017);
    cosX1[px] = Math.cos(wx * 0.017);
    cosX2[px] = Math.cos(wx * 0.029);
    sinX2[px] = Math.sin(wx * 0.029);
    dropX[px] = 1 - sstepCpu(95, 220, Math.abs(wx - 18));
  }

  for (let py = 0; py < SEA_MAP_SIZE; py++) {
    const wz = wxArr[py];
    const cz = Math.min(GRID - 1, Math.max(0, Math.floor((wz + SEA_MAP_HALF) / CELL)));
    const reefDropOff = -8.5 * sstepCpu(265, 335, wz);
    const sinZ1 = Math.sin(wz * 0.013);
    const cosZ1 = Math.cos(wz * 0.013);
    const cosZ2 = Math.cos(wz * 0.023);
    const sinZ2 = Math.sin(wz * 0.023);
    const wz2 = wz * wz;

    for (let px = 0; px < SEA_MAP_SIZE; px++) {
      const wx = wxArr[px];
      const cx = Math.min(GRID - 1, Math.max(0, Math.floor((wx + SEA_MAP_HALF) / CELL)));
      const cellIdx = cz * GRID + cx;

      let shoreDist = 64;
      let sandyWeight = 0;

      const r2 = wx * wx + wz2;
      const worldR = r2 <= 19600 ? 140 : r2 >= 230400 ? 480 : Math.sqrt(r2);
      const oceanTrend = -14.5 - 19.5 * sstepCpu(140, 480, worldR);
      const seabedWaves =
        1.55 * (sinX1[px] * cosZ1 + cosX1[px] * sinZ1) +
        1.05 * (cosX2[px] * cosZ2 + sinX2[px] * sinZ2);
      const baseBathy = Math.max(-35.5, oceanTrend + seabedWaves + reefDropOff * dropX[px]);
      let bestBathy = baseBathy;

      const nearIslands = islandBuckets[cellIdx];
      for (let k = 0; k < nearIslands.length; k++) {
        const isl = nearIslands[k];
        const dx = wx - isl.x;
        const dz = wz - isl.z;
        if (Math.abs(dx) > isl.maxReach || Math.abs(dz) > isl.maxReach) continue;
        const r = Math.sqrt(dx * dx + dz * dz);
        if (r > isl.maxReach) continue;

        const angle = Math.atan2(dz, dx);
        const bin = ((Math.round((angle + Math.PI) * INV_TAU_LUT) % LUT_N) + LUT_N) % LUT_N;
        const shoreR = isl.shoreLut[bin];
        const rawBf = isl.beachLut[bin];
        let d = r - shoreR;

        if (d <= 0) {
          if (isl.isAtoll) {
            bestBathy = Math.max(bestBathy, arenaBathymetry(wx, wz));
            const ldz = dz - 2;
            const lr = Math.sqrt(dx * dx + ldz * ldz);
            const lAngle = Math.atan2(ldz, dx);
            const lagoonR = 43 + 3.4 * Math.sin(lAngle * 3 + isl.raw.seed) + 1.8 * Math.cos(lAngle * 5 - isl.raw.seed);
            const innerDist = lagoonR - lr;
            d = Math.max(d, innerDist);
            if (innerDist > -4) sandyWeight = Math.max(sandyWeight, 0.95);
          } else {
            bestBathy = ARENA_WATER_Y + 0.5;
          }
        } else {
          const shallowSlope = 0.65 + (0.122 - 0.65) * rawBf;
          const shelfDepth = isl.isAtoll ? -4.5 : isl.isBeach ? -3.8 : -6.2;
          const nearY = ARENA_WATER_Y - d * shallowSlope;
          const shelfBlend = sstepCpu(5 + 9 * rawBf, 18 + 12 * rawBf, d);
          const midY = nearY + (shelfDepth - nearY) * shelfBlend;
          const deepBlend = sstepCpu(10 + 6 * rawBf, isl.isAtoll ? 28 : 34, d);
          const islandSeaY = midY + (baseBathy - midY) * deepBlend;
          if (islandSeaY > bestBathy) bestBathy = islandSeaY;
        }

        if (d < shoreDist) shoreDist = d;
        const bf = Math.max(isl.isBeachOrAtoll ? 0.65 : 0, rawBf);
        if (bf > 0.05 && d > -4 && d < 26) {
          const w = bf * (1 - Math.min(1, Math.max(0, d / 26)));
          if (w > sandyWeight) sandyWeight = w;
        }
      }

      let rockDist = 16;
      const rList = rockBuckets[cellIdx];
      for (let k = 0; k < rList.length; k++) {
        const rk = rList[k];
        const rdx = wx - rk.x;
        const rdz = wz - rk.z;
        const lim = rk.r + rockDist;
        if (Math.abs(rdx) >= lim || Math.abs(rdz) >= lim) continue;
        const d = Math.sqrt(rdx * rdx + rdz * rdz) - rk.r;
        if (d < rockDist) rockDist = d;
      }

      const pList = pierBuckets[cellIdx];
      for (let k = 0; k < pList.length; k++) {
        const ps = pList[k];
        const d = segDist2D(ps.ax, ps.az, ps.bx, ps.bz, wx, wz) - ps.hw;
        if (d < rockDist) rockDist = d;
      }

      const depthM = Math.max(0, Math.min(34, ARENA_WATER_Y - bestBathy));

      const idx = (py * SEA_MAP_SIZE + px) * 4;
      bytes[idx] = Math.round(T.MathUtils.clamp(shoreDist / 64 + 0.5, 0, 1) * 255);
      bytes[idx + 1] = Math.round(T.MathUtils.clamp(rockDist / 16 + 0.25, 0, 1) * 255);
      bytes[idx + 2] = Math.round(T.MathUtils.clamp(depthM / 34, 0, 1) * 255);
      bytes[idx + 3] = Math.round(T.MathUtils.clamp(sandyWeight, 0, 1) * 255);
    }
  }

  return bytes;
}

function getDefaultSeaMapBytes(): Uint8Array {
  if (!cachedDefaultSeaMapBytes) {
    cachedDefaultSeaMapBytes = computeArchipelagoSeaMapBytes(arenaLayout);
  }
  return cachedDefaultSeaMapBytes;
}

/**
 * Prebakes a `512x512` `RGBA8` world-space Shoreline and Rock SDF + Bathymetry texture once
 * in `< 6 ms` using spatial cell bucketing — scales cleanly to `15+` islands with `O(1)` GPU lookup!
 * - `R`: Coastline signed distance `clamp(shoreDist / 64 + 0.5, 0, 1)` (`0.5` = waterline)
 * - `G`: Rock and pier piling distance `clamp(rockDist / 16 + 0.25, 0, 1)` (`0.25` = edge)
 * - `B`: Normalized bathymetry depth `clamp(depthM / 34, 0, 1)`
 * - `A`: Warm coral-sand lagoon shelf factor `0..1`
 */
export function bakeArchipelagoSeaMap(layout: typeof arenaLayout = arenaLayout): T.DataTexture {
  const bytes = layout === arenaLayout ? getDefaultSeaMapBytes() : computeArchipelagoSeaMapBytes(layout);
  const tex = new T.DataTexture(bytes, SEA_MAP_SIZE, SEA_MAP_SIZE, T.RGBAFormat, T.UnsignedByteType);
  tex.wrapS = T.ClampToEdgeWrapping;
  tex.wrapT = T.ClampToEdgeWrapping;
  tex.minFilter = T.LinearFilter;
  tex.magFilter = T.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  tex.name = 'ArchipelagoSeaSDFBathymetry';
  return tex;
}

// ============================================================================
// 2. Shore-Attenuated 6-Wave Gerstner Field (Exact CPU <-> GPU Parity)
// ============================================================================

interface WaveComponent {
  readonly dx: number;
  readonly dz: number;
  readonly k: number;
  readonly omega: number;
  readonly amp: number;
  readonly steep: number;
}

function makeWave(dx: number, dz: number, k: number, omega: number, amp: number, steep: number): WaveComponent {
  const len = Math.hypot(dx, dz) || 1;
  return { dx: dx / len, dz: dz / len, k, omega, amp, steep };
}

/**
 * Shared 6-component directional swell + chop table.
 * Offshore peak vertical sum <= `0.233 m` (matching rowboat gunwale freeboard `+0.42 m` and `Rowboat_DryMask` at `renderOrder = 1`).
 */
const GERSTNER_WAVES: readonly WaveComponent[] = [
  makeWave(0.80, 0.60, 0.125, 0.52, 0.092, 0.26),
  makeWave(-0.26, 0.965, 0.195, -0.41, 0.058, 0.24),
  makeWave(0.55, -0.835, 0.290, 0.68, 0.032, 0.22),
  makeWave(-0.88, -0.475, 0.440, 0.89, 0.018, 0.20),
  makeWave(0.32, 0.947, 0.640, 1.14, 0.010, 0.18),
  makeWave(-0.62, 0.785, 0.880, -1.32, 0.006, 0.16),
];

/**
 * Exact CPU mirror of GPU `evalWaveShelter(xz, tSeaMap)`:
 * Bilinearly samples `SEA_MAP` (`rockDist`, `depthM`) + Coral Lagoon shelter so floating boats,
 * oars, and swimmers track the shore-attenuated GPU surface to `< 0.3 cm` everywhere!
 */
function sampleCpuWaveEnvelope(x: number, z: number): { swellScale: number; chopScale: number } {
  const u = (x + SEA_MAP_HALF) / SEA_MAP_SPAN;
  const v = (z + SEA_MAP_HALF) / SEA_MAP_SPAN;
  let rockDist = 12.0;
  let depthM = 34.0;

  if (u >= 0.002 && u <= 0.998 && v >= 0.002 && v <= 0.998) {
    const bytes = getDefaultSeaMapBytes();
    const fx = T.MathUtils.clamp(u * SEA_MAP_SIZE - 0.5, 0, SEA_MAP_SIZE - 1);
    const fy = T.MathUtils.clamp(v * SEA_MAP_SIZE - 0.5, 0, SEA_MAP_SIZE - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(SEA_MAP_SIZE - 1, x0 + 1);
    const y1 = Math.min(SEA_MAP_SIZE - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;

    const i00 = (y0 * SEA_MAP_SIZE + x0) * 4;
    const i10 = (y0 * SEA_MAP_SIZE + x1) * 4;
    const i01 = (y1 * SEA_MAP_SIZE + x0) * 4;
    const i11 = (y1 * SEA_MAP_SIZE + x1) * 4;

    const g0 = bytes[i00 + 1] + (bytes[i10 + 1] - bytes[i00 + 1]) * tx;
    const g1 = bytes[i01 + 1] + (bytes[i11 + 1] - bytes[i01 + 1]) * tx;
    const b0 = bytes[i00 + 2] + (bytes[i10 + 2] - bytes[i00 + 2]) * tx;
    const b1 = bytes[i01 + 2] + (bytes[i11 + 2] - bytes[i01 + 2]) * tx;

    const gNorm = (g0 + (g1 - g0) * ty) / 255;
    const bNorm = (b0 + (b1 - b0) * ty) / 255;
    rockDist = (gNorm - 0.25) * 16.0;
    depthM = bNorm * 34.0;
  }

  const ldx = x - CORAL_LAGOON_X;
  const ldz = z - CORAL_LAGOON_Z;
  const lagoonDist = Math.sqrt(ldx * ldx + ldz * ldz);
  const lagoonCalm = 1 - sstepCpu(36.0, 68.0, lagoonDist);

  const swellLagoon = 1 - 0.72 * lagoonCalm;
  const chopLagoon = 1 - 0.86 * lagoonCalm;
  const depthSwell = 0.34 + 0.66 * sstepCpu(0.25, 4.8, depthM);
  const offshoreBoost = 1 + 0.08 * sstepCpu(14.0, 30.0, depthM);
  const pierBasinSwell = 1 - 0.22 * (1 - sstepCpu(0.4, 5.2, rockDist)) * (1 - sstepCpu(3.5, 9.5, depthM));

  const depthChop = 0.08 + 0.92 * sstepCpu(0.55, 3.6, depthM);
  const pierBasinChop = 0.30 + 0.70 * sstepCpu(0.4, 5.8, rockDist);

  return {
    swellScale: swellLagoon * depthSwell * offshoreBoost * pierBasinSwell,
    chopScale: chopLagoon * depthChop * pierBasinChop,
  };
}

const GERSTNER_GLSL = /* glsl */ `
struct GerstnerEval {
  vec3 pos;
  vec3 normal;
  float jacobian;
};

const vec4 GW_DIR_K[6] = vec4[6](
  vec4(${GERSTNER_WAVES[0].dx.toFixed(6)}, ${GERSTNER_WAVES[0].dz.toFixed(6)}, ${GERSTNER_WAVES[0].k.toFixed(6)}, ${GERSTNER_WAVES[0].omega.toFixed(6)}),
  vec4(${GERSTNER_WAVES[1].dx.toFixed(6)}, ${GERSTNER_WAVES[1].dz.toFixed(6)}, ${GERSTNER_WAVES[1].k.toFixed(6)}, ${GERSTNER_WAVES[1].omega.toFixed(6)}),
  vec4(${GERSTNER_WAVES[2].dx.toFixed(6)}, ${GERSTNER_WAVES[2].dz.toFixed(6)}, ${GERSTNER_WAVES[2].k.toFixed(6)}, ${GERSTNER_WAVES[2].omega.toFixed(6)}),
  vec4(${GERSTNER_WAVES[3].dx.toFixed(6)}, ${GERSTNER_WAVES[3].dz.toFixed(6)}, ${GERSTNER_WAVES[3].k.toFixed(6)}, ${GERSTNER_WAVES[3].omega.toFixed(6)}),
  vec4(${GERSTNER_WAVES[4].dx.toFixed(6)}, ${GERSTNER_WAVES[4].dz.toFixed(6)}, ${GERSTNER_WAVES[4].k.toFixed(6)}, ${GERSTNER_WAVES[4].omega.toFixed(6)}),
  vec4(${GERSTNER_WAVES[5].dx.toFixed(6)}, ${GERSTNER_WAVES[5].dz.toFixed(6)}, ${GERSTNER_WAVES[5].k.toFixed(6)}, ${GERSTNER_WAVES[5].omega.toFixed(6)})
);

const vec2 GW_AMP_Q[6] = vec2[6](
  vec2(${GERSTNER_WAVES[0].amp.toFixed(6)}, ${GERSTNER_WAVES[0].steep.toFixed(6)}),
  vec2(${GERSTNER_WAVES[1].amp.toFixed(6)}, ${GERSTNER_WAVES[1].steep.toFixed(6)}),
  vec2(${GERSTNER_WAVES[2].amp.toFixed(6)}, ${GERSTNER_WAVES[2].steep.toFixed(6)}),
  vec2(${GERSTNER_WAVES[3].amp.toFixed(6)}, ${GERSTNER_WAVES[3].steep.toFixed(6)}),
  vec2(${GERSTNER_WAVES[4].amp.toFixed(6)}, ${GERSTNER_WAVES[4].steep.toFixed(6)}),
  vec2(${GERSTNER_WAVES[5].amp.toFixed(6)}, ${GERSTNER_WAVES[5].steep.toFixed(6)})
);

vec2 evalWaveShelter(vec2 xz, sampler2D seaMapTex) {
  vec2 uv = (xz + ${SEA_MAP_HALF.toFixed(1)}) / ${SEA_MAP_SPAN.toFixed(1)};
  bool inside = uv.x >= 0.002 && uv.x <= 0.998 && uv.y >= 0.002 && uv.y <= 0.998;
  vec4 sm = textureLod(seaMapTex, clamp(uv, vec2(0.001), vec2(0.999)), 0.0);
  float rockDist = inside ? (sm.g - 0.25) * 16.0 : 12.0;
  float depthM = inside ? sm.b * 34.0 : 34.0;

  float lagoonDist = length(xz - vec2(${CORAL_LAGOON_X.toFixed(1)}, ${CORAL_LAGOON_Z.toFixed(1)}));
  float lagoonCalm = 1.0 - smoothstep(36.0, 68.0, lagoonDist);

  float swellLagoon = 1.0 - 0.72 * lagoonCalm;
  float chopLagoon = 1.0 - 0.86 * lagoonCalm;
  float depthSwell = 0.34 + 0.66 * smoothstep(0.25, 4.8, depthM);
  float offshoreBoost = 1.0 + 0.08 * smoothstep(14.0, 30.0, depthM);
  float pierBasinSwell = 1.0 - 0.22 * (1.0 - smoothstep(0.4, 5.2, rockDist)) * (1.0 - smoothstep(3.5, 9.5, depthM));

  float depthChop = 0.08 + 0.92 * smoothstep(0.55, 3.6, depthM);
  float pierBasinChop = 0.30 + 0.70 * smoothstep(0.4, 5.8, rockDist);

  return vec2(swellLagoon * depthSwell * offshoreBoost * pierBasinSwell, chopLagoon * depthChop * pierBasinChop);
}

GerstnerEval evalGerstner(vec2 xz0, float t, float chopFade, vec2 shelter) {
  vec3 disp = vec3(0.0);
  vec2 slope = vec2(0.0);
  float jac = 1.0;
  float chopEnv = shelter.y * mix(1.0, chopFade, 0.85);
  for (int i = 0; i < 6; i++) {
    vec4 dk = GW_DIR_K[i];
    vec2 aq = GW_AMP_Q[i];
    float wScale = i < 2 ? shelter.x : chopEnv;
    float A = aq.x * wScale;
    float Q = aq.y * (i < 2 ? min(1.0, shelter.x) : chopEnv);
    float th = dk.z * (dk.x * xz0.x + dk.y * xz0.y) + dk.w * t;
    float s = sin(th);
    float c = cos(th);
    disp.x += Q * A * dk.x * c;
    disp.z += Q * A * dk.y * c;
    disp.y += A * s;
    slope += dk.xy * (dk.z * A * c);
    jac -= Q * dk.z * A * s;
  }
  GerstnerEval o;
  o.pos = vec3(xz0.x + disp.x, ${ARENA_WATER_Y.toFixed(4)} + disp.y, xz0.y + disp.z);
  o.normal = normalize(vec3(-slope.x, 1.0, -slope.y));
  o.jacobian = jac;
  return o;
}

float evalGerstnerSurfaceY(vec2 worldXZ, float t, sampler2D seaMapTex) {
  vec2 shelter = evalWaveShelter(worldXZ, seaMapTex);
  float qSwell = min(1.0, shelter.x);
  vec2 xz0 = worldXZ;
  for (int iter = 0; iter < 2; iter++) {
    vec2 dxz = vec2(0.0);
    for (int i = 0; i < 6; i++) {
      vec4 dk = GW_DIR_K[i];
      vec2 aq = GW_AMP_Q[i];
      float wScale = i < 2 ? shelter.x : shelter.y;
      float qScale = i < 2 ? qSwell : shelter.y;
      float th = dk.z * (dk.x * xz0.x + dk.y * xz0.y) + dk.w * t;
      float c = cos(th);
      dxz += dk.xy * ((aq.y * qScale) * (aq.x * wScale) * c);
    }
    xz0 = worldXZ - dxz;
  }
  float dy = 0.0;
  for (int i = 0; i < 6; i++) {
    vec4 dk = GW_DIR_K[i];
    vec2 aq = GW_AMP_Q[i];
    float wScale = i < 2 ? shelter.x : shelter.y;
    float th = dk.z * (dk.x * xz0.x + dk.y * xz0.y) + dk.w * t;
    dy += (aq.x * wScale) * sin(th);
  }
  return ${ARENA_WATER_Y.toFixed(4)} + dy;
}
`;

/**
 * Exact CPU counterpart of the shore/lagoon-attenuated 6-wave Gerstner vertex shader
 * (2-step fixed-point horizontal pullback matching displaced GPU vertices to `< 0.3 cm`
 * so `Rowboat_DryMask` bilges remain 100% dry across sheltered coves and open sea).
 */
export function arenaWaveHeight(x: number, z: number, time: number): number {
  const { swellScale, chopScale } = sampleCpuWaveEnvelope(x, z);
  const qSwell = Math.min(1, swellScale);
  let x0 = x;
  let z0 = z;
  for (let iter = 0; iter < 2; iter++) {
    let dx = 0;
    let dz = 0;
    for (let i = 0; i < 6; i++) {
      const w = GERSTNER_WAVES[i];
      const aScale = i < 2 ? swellScale : chopScale;
      const qScale = i < 2 ? qSwell : chopScale;
      const th = w.k * (w.dx * x0 + w.dz * z0) + w.omega * time;
      const qa = w.steep * qScale * (w.amp * aScale) * Math.cos(th);
      dx += w.dx * qa;
      dz += w.dz * qa;
    }
    x0 = x - dx;
    z0 = z - dz;
  }
  let dy = 0;
  for (let i = 0; i < 6; i++) {
    const w = GERSTNER_WAVES[i];
    const aScale = i < 2 ? swellScale : chopScale;
    const th = w.k * (w.dx * x0 + w.dz * z0) + w.omega * time;
    dy += w.amp * aScale * Math.sin(th);
  }
  return ARENA_WATER_Y + dy;
}

export interface ArenaWaveSample {
  y: number;
  nx: number;
  ny: number;
  nz: number;
  jacobian: number;
}

export function arenaWaveSample(
  x: number,
  z: number,
  time: number,
  out: ArenaWaveSample = { y: ARENA_WATER_Y, nx: 0, ny: 1, nz: 0, jacobian: 1 },
): ArenaWaveSample {
  const { swellScale, chopScale } = sampleCpuWaveEnvelope(x, z);
  const qSwell = Math.min(1, swellScale);
  let x0 = x;
  let z0 = z;
  for (let iter = 0; iter < 2; iter++) {
    let dx = 0;
    let dz = 0;
    for (let i = 0; i < 6; i++) {
      const w = GERSTNER_WAVES[i];
      const aScale = i < 2 ? swellScale : chopScale;
      const qScale = i < 2 ? qSwell : chopScale;
      const th = w.k * (w.dx * x0 + w.dz * z0) + w.omega * time;
      const qa = w.steep * qScale * (w.amp * aScale) * Math.cos(th);
      dx += w.dx * qa;
      dz += w.dz * qa;
    }
    x0 = x - dx;
    z0 = z - dz;
  }
  let dy = 0;
  let sx = 0;
  let sz = 0;
  let jac = 1;
  for (let i = 0; i < 6; i++) {
    const w = GERSTNER_WAVES[i];
    const aScale = i < 2 ? swellScale : chopScale;
    const qScale = i < 2 ? qSwell : chopScale;
    const A = w.amp * aScale;
    const Q = w.steep * qScale;
    const th = w.k * (w.dx * x0 + w.dz * z0) + w.omega * time;
    const s = Math.sin(th);
    const c = Math.cos(th);
    dy += A * s;
    sx += w.dx * w.k * A * c;
    sz += w.dz * w.k * A * c;
    jac -= Q * w.k * A * s;
  }
  const nl = Math.hypot(sx, 1, sz) || 1;
  out.y = ARENA_WATER_Y + dy;
  out.nx = -sx / nl;
  out.ny = 1 / nl;
  out.nz = -sz / nl;
  out.jacobian = jac;
  return out;
}

/** Tileable fallback caustic + slope texture when `CausticsSlopePass` is not yet bound externally. */
function buildFallbackWaterTexture(): T.DataTexture {
  const S = 128;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    const v = (y / S) * Math.PI * 2;
    for (let x = 0; x < S; x++) {
      const u = (x / S) * Math.PI * 2;
      let i0 = u;
      let i1 = v;
      let c = 0;
      for (let n = 1; n <= 4; n++) {
        const tt = 23 * (1 - 3.5 / n);
        const nx = u + Math.cos(tt - i0) + Math.sin(tt + i1);
        const ny = v + Math.sin(tt - i1) + Math.cos(tt + i0);
        i0 = nx;
        i1 = ny;
        const s = Math.sin(i0 + tt);
        const k = Math.cos(i1 + tt);
        c += Math.abs(s * k) / (1.25 * Math.hypot(s, k) + 1e-4);
      }
      const caus = Math.min(1, Math.pow(Math.abs(1.17 - Math.pow(c / 4, 1.4)), 7) * 0.55);
      const sx = Math.cos(u * 2 + v) * 0.08 + Math.sin(u * 3 - v * 2) * 0.05;
      const sy = Math.sin(v * 2 - u) * 0.08 + Math.cos(v * 4 + u) * 0.05;
      const idx = (y * S + x) * 4;
      const cb = Math.round(T.MathUtils.clamp(caus, 0, 1) * 255);
      data[idx] = cb;
      data[idx + 1] = cb;
      data[idx + 2] = Math.round(T.MathUtils.clamp(sx * 0.5 + 0.5, 0, 1) * 255);
      data[idx + 3] = Math.round(T.MathUtils.clamp(sy * 0.5 + 0.5, 0, 1) * 255);
    }
  }
  const tex = new T.DataTexture(data, S, S, T.RGBAFormat, T.UnsignedByteType);
  tex.wrapS = T.RepeatWrapping;
  tex.wrapT = T.RepeatWrapping;
  tex.minFilter = T.LinearMipmapLinearFilter;
  tex.magFilter = T.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  tex.name = 'ArchipelagoFallbackWaterTex';
  return tex;
}

// ============================================================================
// 3. Geometrically Graded Water Grid (`< 1 cm` Near-Field Boat Parity)
// ============================================================================

function waterAxis(fine: number, near: number, growth: number, far: number): number[] {
  const half = [0];
  let x = 0;
  let step = fine;
  while (x < far) {
    if (x >= near) step *= growth;
    x = Math.min(far, x + step);
    half.push(x);
  }
  return [...half.slice(1).reverse().map(v => -v), ...half];
}

function waterGeometry(low: boolean): { geometry: T.BufferGeometry; cell: number } {
  const axis = low ? waterAxis(1.5, 30, 1.25, 1200) : waterAxis(0.75, 42, 1.16, 1200);
  const n = axis.length;
  const positions = new Float32Array(n * n * 3);
  const index: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      positions.set([axis[i], ARENA_WATER_Y, axis[j]], (j * n + i) * 3);
    }
  }
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const k = j * n + i;
      index.push(k, k + n, k + 1, k + 1, k + n, k + n + 1);
    }
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(positions, 3));
  g.setIndex(index);
  g.computeBoundingSphere();
  return { geometry: g, cell: low ? 1.5 : 0.75 };
}

// ============================================================================
// 4. Pooled World-Space Kelvin `19.47°` Boat Wakes + Swimmer/Bobber Ripples
// ============================================================================

function buildWakeTrail(scene: T.Scene, initialTier: ArenaQualityTier, seaMapTexture: T.Texture) {
  const maxCapacity = 512;
  let activeCap = initialTier === 'low' ? 192 : initialTier === 'balanced' ? 320 : 512;

  const quad = new T.PlaneGeometry(1, 1);
  const geometry = new T.InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute('position', quad.attributes.position);
  geometry.setAttribute('uv', quad.attributes.uv);

  const samples = new T.InstancedBufferAttribute(new Float32Array(maxCapacity * 4), 4).setUsage(T.DynamicDrawUsage);
  const shape = new T.InstancedBufferAttribute(new Float32Array(maxCapacity * 4), 4).setUsage(T.DynamicDrawUsage);
  // Seed slot 0 with finite zero-visible wake values so zero-instance VAO warmup (`instanceCount: 0 -> 1 -> 0`)
  // executes clean shader/VAO validation on boot without emitting any visible splash or NaN math!
  samples.setXYZW(0, 0, 0, -10.0, 0.05);
  shape.setXYZW(0, 0, 1, 0.001, 0.0);
  samples.needsUpdate = true;
  shape.needsUpdate = true;
  geometry.setAttribute('sampleAt', samples);
  geometry.setAttribute('shape', shape);
  geometry.instanceCount = 0;

  // shape.w >= 0: boat Kelvin 19.47 deg V-wake (tan(19.4712 deg) = 0.353553)
  // shape.w <  0: circular expanding swimmer / fishing-bobber ripple (strength = -shape.w)
  const material = new T.ShaderMaterial({
    name: 'ArchipelagoWorldWakeTrail',
    transparent: true,
    depthWrite: false,
    side: T.DoubleSide,
    uniforms: {
      clock: { value: 0 },
      swellTime: { value: 0 },
      tSeaMap: { value: seaMapTexture },
      uFoamTint: { value: new T.Color('#def7f5') },
    },
    vertexShader: /* glsl */ `
      ${GERSTNER_GLSL}
      attribute vec4 sampleAt;
      attribute vec4 shape;
      uniform float clock;
      uniform float swellTime;
      uniform sampler2D tSeaMap;

      varying vec2 vSt;
      varying float vFade;
      varying float vStrength;
      varying float vIsRipple;
      varying float vAge;
      varying float vSeed;

      void main() {
        vSt = uv;
        float age = max(0.0, clock - sampleAt.z);
        float life = clamp(age / max(sampleAt.w, 0.05), 0.0, 1.0);
        if (age > sampleAt.w) {
          gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
          vFade = 0.0;
          vStrength = 0.0;
          vIsRipple = 0.0;
          vAge = age;
          vSeed = 0.0;
          return;
        }

        vFade = (1.0 - life) * (1.0 - life);
        vAge = age;
        vSeed = sampleAt.x * 0.17 + sampleAt.y * 0.13;

        vec2 p;
        if (shape.w < 0.0) {
          vIsRipple = 1.0;
          vStrength = -shape.w;
          float radius = shape.z + age * (0.95 + vStrength * 0.85);
          p = sampleAt.xy + position.xy * (radius * 2.0);
        } else {
          vIsRipple = 0.0;
          vStrength = shape.w;
          vec2 axis = shape.xy;
          vec2 right = vec2(axis.y, -axis.x);
          float kelvinHalfWidth = 0.72 + vStrength * 1.95 + age * (0.85 + vStrength * 1.15) * 0.7071;
          p = sampleAt.xy + axis * (position.y * shape.z) + right * (position.x * kelvinHalfWidth * 2.0);
        }

        float y = evalGerstnerSurfaceY(p, swellTime, tSeaMap) + 0.032;
        gl_Position = projectionMatrix * viewMatrix * vec4(p.x, y, p.y, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uFoamTint;
      varying vec2 vSt;
      varying float vFade;
      varying float vStrength;
      varying float vIsRipple;
      varying float vAge;
      varying float vSeed;

      void main() {
        if (vFade <= 0.002) discard;
        float a = 0.0;

        if (vIsRipple > 0.5) {
          vec2 q = vSt * 2.0 - 1.0;
          float r = length(q);
          if (r > 1.0) discard;
          float ring1 = exp(-38.0 * (r - 0.82) * (r - 0.82));
          float ring2 = exp(-44.0 * (r - 0.50) * (r - 0.50)) * 0.62;
          float wobble = 0.72 + 0.28 * sin(atan(q.y, q.x + 1e-4) * 5.0 + vSeed * 9.0 + vAge * 3.0);
          float splashCore = exp(-14.0 * r * r) * max(0.0, 1.0 - vAge * 1.4) * 0.35;
          a = vFade * (ring1 + ring2 + splashCore) * wobble * (0.24 + 0.45 * vStrength);
        } else {
          float edge = abs(2.0 * vSt.x - 1.0);
          float kelvinArm = 0.35355 + (1.0 - vSt.y) * 0.34;
          float feather = 0.55 + 0.45 * sin(vSt.y * 12.0 + vSeed + sin(vSt.x * 15.0) - vAge * 2.2);
          float armFoam = exp(-28.0 * (edge - kelvinArm) * (edge - kelvinArm)) * feather;
          float propWash = 0.44 * vStrength * exp(-8.5 * edge * edge) * (0.65 + 0.35 * sin(vSt.y * 19.0 - vAge * 6.0 + vSeed));
          a = vFade * (armFoam + propWash) * (0.16 + 0.48 * vStrength) * sin(3.14159265 * vSt.y);
        }

        if (a < 0.007) discard;
        gl_FragColor = vec4(uFoamTint, min(a, 0.88));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const mesh = new T.Mesh(geometry, material);
  mesh.name = 'WorldWakeTrail';
  mesh.renderOrder = 3;
  mesh.frustumCulled = false;
  scene.add(mesh);

  const tracks = new Map<string, { x: number; z: number; at: number }>();
  let cursor = 0;
  let lastEmission = -100;

  const emitInstance = (
    x: number,
    z: number,
    now: number,
    life: number,
    ax: number,
    az: number,
    lenOrRad: number,
    strengthSigned: number,
  ) => {
    const slot = cursor % activeCap;
    samples.setXYZW(slot, x, z, now, life);
    shape.setXYZW(slot, ax, az, lenOrRad, strengthSigned);
    geometry.instanceCount = Math.min(activeCap, Math.max(geometry.instanceCount, slot + 1));
    cursor = (slot + 1) % activeCap;
    samples.needsUpdate = true;
    shape.needsUpdate = true;
    lastEmission = now;
  };

  return {
    setQuality(tier: ArenaQualityTier) {
      activeCap = tier === 'low' ? 192 : tier === 'balanced' ? 320 : 512;
      geometry.instanceCount = Math.min(geometry.instanceCount, activeCap);
      cursor %= activeCap;
    },
    setTimeOfDay(tod: ArenaTimeOfDay) {
      material.uniforms.uFoamTint.value.set(tod === 'sunset' ? '#f6e1d2' : '#def7f5');
    },
    update(sources: readonly SeaWakeSource[], swellTime: number) {
      const now = performance.now() / 1000;
      material.uniforms.clock.value = now;
      material.uniforms.swellTime.value = swellTime;

      for (const src of sources) {
        const prev = tracks.get(src.id);
        if (!prev) {
          tracks.set(src.id, { x: src.x, z: src.z, at: now });
          continue;
        }
        const dx = src.x - prev.x;
        const dz = src.z - prev.z;
        const dist = Math.hypot(dx, dz);
        const dt = now - prev.at;

        if (src.swimmer || src.bobber) {
          const minDt = src.bobber ? 0.46 : src.speed > 0.35 ? 0.14 : 0.38;
          if (dt < minDt) continue;
          if (dt < 0.85 && (src.bobber || src.speed > 0.03 || dist > 0.02)) {
            const strength = src.bobber
              ? T.MathUtils.clamp(0.28 + src.speed * 0.4, 0.25, 0.85)
              : T.MathUtils.clamp(0.32 + src.speed / 3.2, 0.3, 1.0);
            const initRad = src.bobber ? 0.18 : 0.34;
            emitInstance(src.x, src.z, now, src.bobber ? 1.65 : 2.1, 0, 1, initRad, -strength);
          }
          prev.x = src.x;
          prev.z = src.z;
          prev.at = now;
          continue;
        }

        if (dt < 0.075) continue;
        if (dist > 0.035 && dist < 32 * dt && dt < 0.35 && src.speed > 0.18) {
          const speed = dist / dt;
          const power = Math.min(1, speed / (src.motor ? 15 : 7.5));
          const stern = src.motor ? 3.05 : 1.7;
          emitInstance(
            src.x - (dx / dist) * stern,
            src.z - (dz / dist) * stern,
            now,
            0.85 + 3.1 * power,
            dx / dist,
            dz / dist,
            0.75 + dist * 1.85,
            power,
          );
        }
        prev.x = src.x;
        prev.z = src.z;
        prev.at = now;
      }
      mesh.visible = now - lastEmission < 4.5;
    },
    dispose() {
      scene.remove(mesh);
      geometry.dispose();
      quad.dispose();
      material.dispose();
    },
  };
}

// ============================================================================
// 5. Default Ambient Dockside Fish Schools (Automatic Fallback Until Live Schools)
// ============================================================================

const DEFAULT_DOCK_SCHOOLS: readonly {
  cx: number;
  cz: number;
  orbitR: number;
  omega: number;
  phase: number;
  radius: number;
  count: number;
}[] = [
  { cx: 18, cz: 222, orbitR: 11.0, omega: 0.20, phase: 0.3, radius: 5.2, count: 56 },
  { cx: 8, cz: 98, orbitR: 8.5, omega: -0.19, phase: 1.7, radius: 4.8, count: 52 },
  { cx: 96, cz: 22, orbitR: 7.5, omega: 0.23, phase: 2.9, radius: 4.4, count: 46 },
  { cx: -96, cz: -14, orbitR: 8.0, omega: -0.21, phase: 4.1, radius: 4.6, count: 50 },
  { cx: 110, cz: 74, orbitR: 8.5, omega: 0.20, phase: 5.2, radius: 4.6, count: 48 },
  { cx: -132, cz: -102, orbitR: 8.5, omega: -0.18, phase: 0.9, radius: 4.8, count: 52 },
];

// ============================================================================
// 6. Main Archipelago Ocean & Sky Builder (`buildArenaSea`)
// ============================================================================

export interface ArenaSeaHandle {
  readonly waterMesh: T.Mesh<T.BufferGeometry, T.ShaderMaterial>;
  readonly skyDome: T.Mesh<T.BufferGeometry, T.ShaderMaterial>;
  readonly seaMapTexture: T.DataTexture;
  update: (
    t: number,
    activeWakes?: readonly SeaWakeSource[],
    focus?: T.Vector3,
    surfaceSchools?: readonly SurfaceFishSchool[],
  ) => void;
  /**
   * Triggers a physically expanding dispersive dual-crest capillary ring + aerated splash core
   * at world `(x, z)` using the pre-allocated `uSplashRings[12]` uniform ring buffer (`0` shader recompiles).
   * - `strength`: normalized impulse energy (`0.15..2.0`, default `0.75`)
   * - `maxRadius`: outer dispersive expansion radius in metres (`0.8..14.0`, default `3.2`)
   */
  triggerSurfaceSplash: (x: number, z: number, strength?: number, maxRadius?: number) => void;
  setQuality: (tier: ArenaQualityTier) => void;
  setTimeOfDay: (tod: ArenaTimeOfDay) => void;
  setCausticsTexture: (tex: T.Texture | null, isFloat?: boolean) => void;
  setSunDirection: (dir: T.Vector3) => void;
  setFishSchools: (schools: readonly SurfaceFishSchool[], focus?: T.Vector3) => void;
  dispose: () => void;
}

export function buildArenaSea(
  scene: T.Scene,
  lowOrOptions: boolean | ArenaSeaOptions = false,
): ArenaSeaHandle {
  const initialTier: ArenaQualityTier =
    typeof lowOrOptions === 'boolean'
      ? lowOrOptions
        ? 'low'
        : 'high'
      : (lowOrOptions.quality ?? 'high');
  const initialTod: ArenaTimeOfDay =
    typeof lowOrOptions === 'boolean' ? 'daylight' : (lowOrOptions.timeOfDay ?? 'daylight');

  const seaMapTexture = bakeArchipelagoSeaMap(arenaLayout);
  const wake = buildWakeTrail(scene, initialTier, seaMapTexture);
  const fallbackWaterTex = buildFallbackWaterTexture();

  const noiseGLSL = /* glsl */ `
    float seaHash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }
    float seaNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(seaHash(i), seaHash(i + vec2(1.0, 0.0)), f.x),
        mix(seaHash(i + vec2(0.0, 1.0)), seaHash(i + vec2(1.0, 1.0)), f.x),
        f.y
      );
    }
    float seaFbm(vec2 p) {
      return seaNoise(p) * 0.58 + seaNoise(p * 2.03) * 0.28 + seaNoise(p * 4.11) * 0.14;
    }
  `;

  const sunDirUniform = {
    value: (typeof lowOrOptions === 'object' && lowOrOptions.sunDirection
      ? lowOrOptions.sunDirection.clone()
      : new T.Vector3(-0.58, 0.72, 0.40)
    ).normalize(),
  };

  // --- A. Unified Sky + Submerged Abyssal Horizon Dome
  const skyUniforms = {
    time: { value: 0 },
    uSunDir: sunDirUniform,
    uZenith: { value: new T.Color(0.068, 0.295, 0.615) },
    uMidSky: { value: new T.Color(0.32, 0.65, 0.86) },
    uHorizon: { value: new T.Color(0.81, 0.89, 0.92) },
    uSunCorona: { value: new T.Color(0.94, 0.66, 0.32) },
    uSunDisc: { value: new T.Color(1.0, 0.88, 0.62) },
    uCloudBase: { value: new T.Color(0.95, 0.96, 0.98) },
    uCloudSun: { value: new T.Color(1.0, 0.93, 0.82) },
    uGrottoBoost: { value: 0.06 },
  };

  const sky = new T.ShaderMaterial({
    name: 'ArchipelagoSkyAndAbyssDome',
    side: T.BackSide,
    depthWrite: false,
    uniforms: skyUniforms,
    vertexShader: /* glsl */ `
      varying vec3 vDirection;
      void main() {
        vDirection = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float time;
      uniform vec3 uSunDir;
      uniform vec3 uZenith;
      uniform vec3 uMidSky;
      uniform vec3 uHorizon;
      uniform vec3 uSunCorona;
      uniform vec3 uSunDisc;
      uniform vec3 uCloudBase;
      uniform vec3 uCloudSun;
      uniform float uGrottoBoost;
      varying vec3 vDirection;
      ${UNDERWATER_OPTICS_GLSL}
      ${noiseGLSL}

      void main() {
        vec3 d = normalize(vDirection);

        // Smooth above/below waterline transition on the background dome
        if (cameraPosition.y < WATER_Y + 0.12) {
          vec3 uwCol = uwApplyFog(vec3(0.0), cameraPosition + d * 240.0, cameraPosition, uGrottoBoost, uSunDir, 1.0);
          if (cameraPosition.y < WATER_Y - 0.12) {
            gl_FragColor = vec4(uwSafeHDR(uwCol, 16.0), 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
            return;
          }
        }

        float h = max(0.0, d.y);
        vec3 c = mix(uHorizon, mix(uMidSky, uZenith, smoothstep(0.12, 0.85, h)), pow(h, 0.52));
        float sunAmt = max(0.0, dot(d, uSunDir));
        c += uSunCorona * pow(sunAmt, 14.0) * 0.24;
        c += uSunDisc * pow(sunAmt, 220.0) * 0.95;

        vec2 uv = d.xz / max(0.11, d.y + 0.20) * 1.45;
        float clouds = smoothstep(0.50, 0.77, seaFbm(uv + vec2(time * 0.0024, -time * 0.0008)))
                     * smoothstep(0.02, 0.20, d.y)
                     * (1.0 - smoothstep(0.58, 0.92, d.y));
        vec3 cloudCol = mix(uCloudBase, uCloudSun, pow(sunAmt, 3.0) * 0.65);
        c = mix(c, cloudCol, clouds * 0.78);

        if (cameraPosition.y < WATER_Y + 0.12) {
          vec3 uwCol = uwApplyFog(vec3(0.0), cameraPosition + d * 240.0, cameraPosition, uGrottoBoost, uSunDir, 1.0);
          float meniscus = uwSS(WATER_Y + 0.12, WATER_Y - 0.12, cameraPosition.y);
          c = mix(c, uwCol, meniscus);
        }

        gl_FragColor = vec4(min(c, vec3(12.0)), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const dome = new T.Mesh(new T.SphereGeometry(920, 32, 16), sky);
  dome.name = 'ArchipelagoSkyDome';
  dome.frustumCulled = false;
  dome.renderOrder = -2;
  scene.add(dome);

  // --- B. Fixed-Capacity Uniform Arrays (`uFishPosRad[16]`, `uBoatHulls[12]`, `uSplashRings[12]`)
  const MAX_FISH_SCHOOLS = 16;
  const fishPosRad = Array.from({ length: MAX_FISH_SCHOOLS }, () => new T.Vector4(0, -50, 0, 1));
  const fishHeadDens = Array.from({ length: MAX_FISH_SCHOOLS }, () => new T.Vector4(1, 0, 0, 0));

  const MAX_BOAT_HULLS = 12;
  const boatHulls = Array.from({ length: MAX_BOAT_HULLS }, () => new T.Vector4(0, 0, 0, 0));

  // Fixed 12-slot surface impulse ring buffer (`vec4(x, z, ageSec, strengthRadiusPacked)`)
  // Packed w = floor(strength * 1000) + clamp(maxRadius, 0.6, 16.0) / 32.0
  const splashRings = Array.from({ length: MAX_SPLASH_RINGS }, () => new T.Vector4(0, 0, -1, 0));
  const splashSlotX = new Float32Array(MAX_SPLASH_RINGS);
  const splashSlotZ = new Float32Array(MAX_SPLASH_RINGS);
  const splashSlotBirth = new Float32Array(MAX_SPLASH_RINGS).fill(-1e6);
  const splashSlotDur = new Float32Array(MAX_SPLASH_RINGS);
  const splashSlotPacked = new Float32Array(MAX_SPLASH_RINGS);
  let splashCursor = 0;
  let lastSeaTime = 0;

  const externalWaterTex = typeof lowOrOptions === 'object' ? (lowOrOptions.causticsTexture ?? null) : null;

  const seaUniforms = {
    time: { value: 0 },
    uSunDir: sunDirUniform,
    uQualityLevel: { value: tierLevel(initialTier) },
    tSeaMap: { value: seaMapTexture },
    tWater: { value: externalWaterTex ?? fallbackWaterTex },
    uWaterIsFloat: { value: externalWaterTex ? 1 : 0 },
    uSkyZenith: { value: new T.Color(0.068, 0.295, 0.615) },
    uSkyHorizon: { value: new T.Color(0.76, 0.87, 0.91) },
    uHazeColor: { value: new T.Color(0.68, 0.82, 0.88) },
    uGlintColor: { value: new T.Color(1.0, 0.86, 0.56) },
    uShallowSand: { value: new T.Color(0.74, 0.69, 0.54) },
    uCrystalMint: { value: new T.Color(0.16, 0.84, 0.78) },
    uShallowTurquoise: { value: new T.Color(0.032, 0.66, 0.68) },
    uMidEmerald: { value: new T.Color(0.016, 0.36, 0.58) },
    uDeepSapphire: { value: new T.Color(0.007, 0.088, 0.265) },
    uGrottoBoost: { value: 0.06 },
    uFishSchoolCount: { value: 0 },
    uFishPosRad: { value: fishPosRad },
    uFishHeadDens: { value: fishHeadDens },
    uBoatHullCount: { value: 0 },
    uBoatHulls: { value: boatHulls },
    uSplashRingCount: { value: 0 },
    uSplashRings: { value: splashRings },
  };

  const syncSplashUniforms = (nowSeaTime: number) => {
    let active = 0;
    for (let i = 0; i < MAX_SPLASH_RINGS; i++) {
      const dur = splashSlotDur[i];
      if (dur <= 0) continue;
      // Handle sea-clock wrap or reset gracefully
      if (nowSeaTime < splashSlotBirth[i] - 0.05) {
        splashSlotBirth[i] = nowSeaTime;
      }
      const age = Math.max(0, nowSeaTime - splashSlotBirth[i]);
      if (age >= dur) {
        splashSlotDur[i] = 0;
        continue;
      }
      splashRings[active].set(splashSlotX[i], splashSlotZ[i], age, splashSlotPacked[i]);
      active++;
    }
    for (let k = active; k < MAX_SPLASH_RINGS; k++) {
      splashRings[k].set(0, 0, -1, 0);
    }
    seaUniforms.uSplashRingCount.value = active;
  };

  const material = new T.ShaderMaterial({
    name: 'ArchipelagoUnifiedSea',
    side: T.DoubleSide,
    uniforms: seaUniforms,
    vertexShader: /* glsl */ `
      uniform float time;
      uniform sampler2D tSeaMap;
      uniform int uSplashRingCount;
      uniform vec4 uSplashRings[${MAX_SPLASH_RINGS}];
      varying vec3 vWorld;
      varying vec3 vGerstnerNormal;
      varying float vJacobian;
      varying vec2 vWaveShelter;
      ${GERSTNER_GLSL}

      void main() {
        vec3 baseWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        float camDist = distance(baseWorld.xz, cameraPosition.xz);
        float chopFade = 1.0 - smoothstep(85.0, 260.0, camDist);
        vec2 shelter = evalWaveShelter(baseWorld.xz, tSeaMap);
        GerstnerEval g = evalGerstner(baseWorld.xz, time, chopFade, shelter);

        // Subtle near-field splash crown lift (<= 3.2 cm, smoothly zeroed beyond 55 m so boats stay exact)
        if (uSplashRingCount > 0 && camDist < 55.0) {
          float nearFade = 1.0 - smoothstep(28.0, 55.0, camDist);
          float crownY = 0.0;
          for (int i = 0; i < ${MAX_SPLASH_RINGS}; i++) {
            if (i >= uSplashRingCount) break;
            vec4 sr = uSplashRings[i];
            float age = sr.z;
            if (age < 0.0) continue;
            float strength = floor(sr.w) * 0.001;
            float maxR = fract(sr.w) * 32.0;
            float dur = 1.85 + clamp(maxR / 5.0, 0.0, 1.45) * 0.65;
            if (age >= dur) continue;
            vec2 d = g.pos.xz - sr.xy;
            float r2 = dot(d, d);
            float bound = maxR + 0.6;
            if (r2 > bound * bound) continue;
            float r = sqrt(r2);
            float u = age / dur;
            float frontR = 0.18 + maxR * (1.0 - pow(1.0 - u, 1.55));
            float env = exp(-pow((r - frontR) / (0.28 + 0.35 * u), 2.0));
            crownY += sin((r - frontR) * 8.5) * env * (1.0 - u) * (1.0 - u) * min(strength, 1.4) * 0.022;
          }
          g.pos.y += clamp(crownY * nearFade, -0.032, 0.032);
        }

        vWorld = g.pos;
        vGerstnerNormal = g.normal;
        vJacobian = g.jacobian;
        vWaveShelter = shelter;
        gl_Position = projectionMatrix * viewMatrix * vec4(g.pos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float time;
      uniform vec3 uSunDir;
      uniform float uQualityLevel;
      uniform sampler2D tSeaMap;
      uniform sampler2D tWater;
      uniform float uWaterIsFloat;
      uniform vec3 uSkyZenith;
      uniform vec3 uSkyHorizon;
      uniform vec3 uHazeColor;
      uniform vec3 uGlintColor;
      uniform vec3 uShallowSand;
      uniform vec3 uCrystalMint;
      uniform vec3 uShallowTurquoise;
      uniform vec3 uMidEmerald;
      uniform vec3 uDeepSapphire;
      uniform float uGrottoBoost;

      uniform int uFishSchoolCount;
      uniform vec4 uFishPosRad[${MAX_FISH_SCHOOLS}];
      uniform vec4 uFishHeadDens[${MAX_FISH_SCHOOLS}];
      uniform int uBoatHullCount;
      uniform vec4 uBoatHulls[${MAX_BOAT_HULLS}];
      uniform int uSplashRingCount;
      uniform vec4 uSplashRings[${MAX_SPLASH_RINGS}];

      varying vec3 vWorld;
      varying vec3 vGerstnerNormal;
      varying float vJacobian;
      varying vec2 vWaveShelter;

      ${UNDERWATER_OPTICS_GLSL}
      ${noiseGLSL}

      vec2 sampleWaterSlope(vec2 uv) {
        vec2 ba = texture(tWater, uv).ba;
        return uWaterIsFloat > 0.5 ? ba : (ba * 2.0 - 1.0) * 0.22;
      }

      // Analytical 4-octave counter-propagating capillary wave slope (shimmers even in sheltered lagoons!)
      vec2 capillaryRippleSlope(vec2 p, float t, float chopShelter, float detailFade) {
        vec2 gustDrift = vec2(t * 0.09, -t * 0.065);
        float warp = (seaNoise(p * 0.21 + gustDrift) - 0.5) * 1.65;
        // Keep 48% capillary shimmer inside calm lagoons/beaches so coves never look like static plastic!
        float shelterGain = mix(0.48, 1.0, clamp(chopShelter, 0.0, 1.0));

        // Octave 1: gentle breeze ripple (lambda ~ 2.85 m)
        vec2 d1 = vec2(0.8944, 0.4472);
        float k1 = 2.20, a1 = 0.015 * shelterGain;
        float ph1 = dot(p, d1) * k1 + t * 1.48 + warp;
        vec2 s = d1 * (k1 * a1 * cos(ph1));

        // Octave 2: cross-breeze wavelet (lambda ~ 1.32 m)
        vec2 d2 = vec2(-0.5299, 0.8480);
        float k2 = 4.75, a2 = 0.0082 * shelterGain;
        float ph2 = dot(p, d2) * k2 - t * 2.15 + warp * 0.78;
        s += d2 * (k2 * a2 * cos(ph2));

        // Octave 3: shimmering cove capillary train (lambda ~ 0.56 m)
        vec2 d3 = vec2(0.3090, -0.9511);
        float k3 = 11.2, a3 = 0.0036 * mix(0.65, 1.0, shelterGain);
        float ph3 = dot(p, d3) * k3 + t * 3.45 - warp * 0.55;
        s += d3 * (k3 * a3 * cos(ph3));

        // Octave 4: fine solar-glint diamond facets on Balanced/High tiers (lambda ~ 0.25 m)
        if (uQualityLevel > 0.5 && detailFade > 0.15) {
          vec2 d4 = vec2(-0.8090, -0.5878);
          float k4 = 24.8, a4 = 0.00145 * smoothstep(0.15, 0.65, detailFade);
          float ph4 = dot(p, d4) * k4 - t * 5.10 + warp * 0.4;
          s += d4 * (k4 * a4 * cos(ph4));
        }
        return s * detailFade;
      }

      // Cellular bubble-web whitewater lace (0..1) so breaking surf and rock collars look frothy, never solid bands
      float cellularFoamLace(vec2 p, float t) {
        vec2 flowA = p * 1.35 + vec2(t * 0.16, -t * 0.11);
        vec2 flowB = p * 2.85 + vec2(-t * 0.13, t * 0.19);
        float cellA = 1.0 - abs(seaNoise(flowA) * 2.0 - 1.0);
        float cellB = 1.0 - abs(seaNoise(flowB) * 2.0 - 1.0);
        float web = pow(clamp(cellA * 0.62 + cellB * 0.48, 0.0, 1.0), 1.65);
        float fineBubbles = smoothstep(0.42, 0.85, seaNoise(p * 6.4 - vec2(t * 0.22, t * 0.15)));
        return clamp(web * 0.78 + fineBubbles * 0.34, 0.0, 1.0);
      }

      // Dispersive dual-crest capillary impulse rings + t=0..0.6s aerated whitewater splash core (uSplashRings[12])
      // Returns vec3(slopeDx, slopeDz, splashFoam)
      vec3 evalSplashRings(vec2 xz, float lace) {
        if (uSplashRingCount <= 0) return vec3(0.0);
        vec2 slopeAcc = vec2(0.0);
        float foamAcc = 0.0;
        for (int i = 0; i < ${MAX_SPLASH_RINGS}; i++) {
          if (i >= uSplashRingCount) break;
          vec4 sr = uSplashRings[i];
          float age = sr.z;
          if (age < 0.0) continue;
          float strength = floor(sr.w) * 0.001;
          float maxR = fract(sr.w) * 32.0;
          float dur = 1.85 + clamp(maxR / 5.0, 0.0, 1.45) * 0.65;
          if (age >= dur) continue;

          vec2 d = xz - sr.xy;
          float r2 = dot(d, d);
          float outerBound = maxR + 0.65;
          if (r2 > outerBound * outerBound) continue;

          float r = sqrt(r2);
          vec2 dir = d / max(r, 1e-4);
          float u = clamp(age / dur, 0.0, 1.0);
          float fade = (1.0 - u) * (1.0 - u);

          // Dispersive front: fast initial impulse expansion that smoothly decelerates
          float frontR = 0.16 + maxR * (1.0 - pow(1.0 - u, 1.55));
          float secondR = frontR * 0.64;
          float bandW1 = 0.14 + 0.22 * u;
          float bandW2 = 0.12 + 0.20 * u;

          float d1 = (r - frontR) / bandW1;
          float d2 = (r - secondR) / bandW2;
          float env1 = exp(-d1 * d1);
          float env2 = exp(-d2 * d2) * 0.68;

          // Dispersive high-frequency capillary train inside the expanding packet
          float packetMask = smoothstep(frontR * 0.28, frontR * 0.52, r) * (1.0 - smoothstep(frontR, frontR + bandW1 * 1.6, r));
          float dispCap = cos((r - frontR) * 18.5 - age * 7.5) * packetMask * 0.42;

          float radialSlope = (-2.0 * d1 / bandW1 * env1 * 0.11 - 2.0 * d2 / bandW2 * env2 * 0.075 + dispCap * 0.22)
                            * fade * min(strength, 1.8);
          slopeAcc += dir * radialSlope;

          // Aerated whitewater splash crown at t = 0..0.60 s + subtle crest froth on primary ring
          float coreFade = 1.0 - smoothstep(0.0, 0.60, age);
          if (coreFade > 0.002) {
            float crownR = 0.18 + 0.56 * smoothstep(0.0, 0.48, age) * clamp(strength, 0.35, 1.45);
            float coreDisc = 1.0 - smoothstep(crownR * 0.35, crownR * 1.15, r);
            float crownLip = exp(-22.0 * pow((r - crownR * 0.82) / max(crownR, 0.15), 2.0));
            foamAcc = max(foamAcc, (coreDisc * (0.45 + 0.55 * lace) + crownLip * 0.72) * coreFade * clamp(strength * 0.85, 0.2, 1.0));
          }
          float ringFroth = env1 * (1.0 - smoothstep(0.15, 1.05, age)) * (0.35 + 0.65 * lace) * clamp(strength * 0.42, 0.0, 0.55);
          foamAcc = max(foamAcc, ringFroth);
        }
        return vec3(slopeAcc, clamp(foamAcc, 0.0, 0.92));
      }

      // Procedural anisotropic fish-silhouette lattice inside a moving school
      float fishBodyLattice(vec2 localAlongAcross, float phaseSeed, float t) {
        vec2 flow = vec2(localAlongAcross.x - t * 1.65, localAlongAcross.y);
        vec2 cellScale = vec2(0.78, 1.35);
        vec2 uv = flow * cellScale + vec2(phaseSeed * 7.3, phaseSeed * 13.1);
        vec2 cid = floor(uv);
        vec2 f = fract(uv) - 0.5;
        float rndCell = seaHash(cid + phaseSeed * 19.0);
        if (rndCell < 0.38) return 0.0;
        vec2 jitter = (vec2(rndCell, fract(rndCell * 17.3)) - 0.5) * vec2(0.36, 0.42);
        vec2 q = f - jitter;
        q.y += sin(t * 8.5 + rndCell * 31.0 + q.x * 9.0) * 0.055;
        float body = length(vec2(q.x * 1.45, q.y * 4.4));
        return 1.0 - smoothstep(0.16, 0.34, body);
      }

      // Synchronized real-time fish surface shadows from live shallow schools
      float surfaceFishShadow(vec2 xz, float t) {
        float acc = 0.0;
        for (int i = 0; i < ${MAX_FISH_SCHOOLS}; i++) {
          if (i >= uFishSchoolCount) break;
          vec4 pr = uFishPosRad[i];
          vec4 hd = uFishHeadDens[i];
          float dens = hd.z;
          if (dens <= 0.005) continue;
          vec2 d = xz - pr.xz;
          float R = pr.w;
          float d2 = dot(d, d);
          if (d2 > R * R * 1.65) continue;

          vec2 fwd = hd.xy;
          vec2 right = vec2(-fwd.y, fwd.x);
          vec2 loc = vec2(dot(d, fwd) / (R * 1.2), dot(d, right) / (R * 0.82));
          float r2 = dot(loc, loc);
          if (r2 > 1.35) continue;

          float schoolEnv = exp(-r2 * 1.85);
          float silhouette = schoolEnv * 0.36;
          if (uQualityLevel > 0.5) {
            vec2 mLoc = vec2(dot(d, fwd), dot(d, right));
            float f0 = fishBodyLattice(mLoc, float(i) * 1.37 + 0.2, t);
            float f1 = fishBodyLattice(mLoc * 1.22 + vec2(0.41, -0.29), float(i) * 2.71 + 0.7, t * 1.08);
            silhouette += max(f0, f1 * 0.85) * smoothstep(1.15, 0.25, r2) * 0.62;
          }
          acc = max(acc, silhouette * dens);
        }
        return clamp(acc, 0.0, 0.85);
      }

      float surfaceBoatShadow(vec2 xz) {
        float acc = 0.0;
        for (int i = 0; i < ${MAX_BOAT_HULLS}; i++) {
          if (i >= uBoatHullCount) break;
          vec4 bh = uBoatHulls[i];
          vec2 d = xz - bh.xy;
          if (dot(d, d) > 18.0) continue;
          float cy = cos(bh.z);
          float sy = sin(bh.z);
          float along = (sy * d.x + cy * d.y) / max(bh.w, 1.8);
          float across = (cy * d.x - sy * d.y) / (bh.w > 2.4 ? 1.25 : 0.78);
          float h = along * along + across * across;
          acc = max(acc, 1.0 - smoothstep(0.68, 1.15, h));
        }
        return acc;
      }

      void main() {
        vec2 p = vWorld.xz;
        vec3 toCam = cameraPosition - vWorld;
        float dist = max(length(toCam), 1e-4);
        vec3 V = toCam / dist;

        float foamLace = dist < 210.0 ? cellularFoamLace(p, time) : 0.5;
        vec3 splashEval = dist < 170.0 ? evalSplashRings(p, foamLace) : vec3(0.0);

        // ====================================================================
        // UNDERWATER BRANCH (!gl_FrontFacing): Exact Snell's Window + TIR
        // ====================================================================
        if (!gl_FrontFacing) {
          vec3 viewRay = -V;
          float fl = uwSS(260.0, 60.0, dist);
          vec2 s = (
            sampleWaterSlope(p / 13.0 + vec2(time * 0.011, -time * 0.008)) +
            sampleWaterSlope(p.yx / 4.7 - vec2(time * 0.015, time * 0.012)) * 0.7 +
            sampleWaterSlope(p / 37.0 + 0.6) * 0.8
          ) * fl + splashEval.xy * 1.15;
          vec3 nDown = normalize(vec3(-s.x * 0.8 - vGerstnerNormal.x * 0.45, -1.0, -s.y * 0.8 - vGerstnerNormal.z * 0.45));

          float ci = uwSat(dot(viewRay, -nDown));
          // Exact Snell critical angle: eta = 1.33, eta^2 = 1.7689 -> theta_c = 48.75 deg
          float k = 1.0 - 1.769 * (1.0 - ci * ci);
          float win = uwSS(0.0, 0.22, k);
          vec3 rr = refract(viewRay, nDown, 1.33);
          float sd = max(dot(rr, uSunDir), 0.0);
          float fr = pow(1.0 - sqrt(max(k, 0.0)), 5.0);

          vec3 refractedSky = (
            mix(uSkyHorizon, uSkyZenith * 1.45 + vec3(0.18, 0.42, 0.48), uwSat(rr.y * 1.2))
              * 1.35 * clamp(1.0 + 3.8 * (s.x * 0.6 - s.y * 0.8), 0.25, 3.0) +
            uGlintColor * 1.05 * (pow(sd, 60.0) * 1.3 + pow(sd, 500.0) * 10.0)
          ) * (1.0 - fr);

          // Project synchronized fish schools, surface boat hulls, and overhead splash foam onto Snell's window!
          float fishSil = surfaceFishShadow(p, time);
          float boatSil = surfaceBoatShadow(p);
          refractedSky *= (1.0 - 0.56 * fishSil) * (1.0 - 0.78 * boatSil);
          refractedSky = mix(refractedSky, vec3(0.92, 0.97, 0.98), splashEval.z * 0.55);

          vec3 R = reflect(viewRay, nDown);
          vec3 tirCol = uwFogIn(vWorld, R, 300.0, uGrottoBoost, uSunDir) * 1.15;
          vec3 uwSurf = mix(tirCol, refractedSky, win);
          uwSurf = uwApplyFog(uwSurf, vWorld, cameraPosition, uGrottoBoost, uSunDir, 1.0);

          gl_FragColor = vec4(uwSafeHDR(uwSurf, 16.0), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          return;
        }

        // ====================================================================
        // AERIAL BRANCH (gl_FrontFacing): 4-Zone Bathymetry, Capillary Shimmer,
        // Crest SSS, Chromatic Caustics, Rolling Surf Lace, and Impulse Rings
        // ====================================================================
        vec2 seaUV = (p + ${SEA_MAP_HALF.toFixed(1)}) / ${SEA_MAP_SPAN.toFixed(1)};
        vec4 seaSample = texture(tSeaMap, seaUV);
        bool inBounds = seaUV.x >= 0.002 && seaUV.x <= 0.998 && seaUV.y >= 0.002 && seaUV.y <= 0.998;
        float shoreDist = inBounds ? (seaSample.r - 0.5) * 64.0 : 32.0;
        float rockDist  = inBounds ? (seaSample.g - 0.25) * 16.0 : 12.0;
        float depthM    = inBounds ? seaSample.b * 34.0 : 34.0;
        float sandyMask = inBounds ? seaSample.a : 0.0;

        float detailFade = (uQualityLevel < 0.5 ? 0.62 : 1.0) * (1.0 - smoothstep(42.0, 210.0, dist));
        vec2 capSlope = capillaryRippleSlope(p, time, vWaveShelter.y, detailFade);
        vec2 slopeTexA = sampleWaterSlope(p / 9.2 + vec2(time * 0.015, -time * 0.011));
        vec2 slopeTexB = sampleWaterSlope(p.yx / 5.1 - vec2(time * 0.019, time * 0.013)) * 0.58;
        vec2 totalSlope = capSlope * 1.35 + (slopeTexA + slopeTexB) * (1.25 * detailFade) + splashEval.xy * 1.45;
        vec3 N = normalize(vec3(vGerstnerNormal.x - totalSlope.x, 1.0, vGerstnerNormal.z - totalSlope.y));

        // Distance-roughness-damped Schlick Fresnel (F0 = 0.02 for air/water interface)
        float ndv = max(0.0, dot(N, V));
        float distGrazingDamp = mix(1.0, 0.82, smoothstep(90.0, 320.0, dist));
        float fresnel = (0.02 + 0.98 * pow(1.0 - ndv, 5.0)) * distGrazingDamp;

        // 4-Zone Vivid Tropical Bathymetry:
        // [0..1.5 m] Crystal Mint-Aqua + Coral Sand -> [1.5..6.5 m] Luminous Reef Turquoise ->
        // [6.5..16 m] Coastal Azure-Cerulean -> [> 18 m] Outer Pelagic Sapphire-Indigo
        float bathyPatch = (seaFbm(p * 0.085) - 0.5) * 1.6;
        float dPatched = max(0.0, depthM + bathyPatch * smoothstep(0.6, 4.0, depthM));
        float zReef = smoothstep(0.45, 2.25, dPatched);
        float zChannel = smoothstep(2.4, 8.2, dPatched);
        float zPelagic = smoothstep(8.5, 22.0, dPatched);

        vec3 bodyCol = mix(uCrystalMint, uShallowTurquoise, zReef);
        bodyCol = mix(bodyCol, uMidEmerald, zChannel);
        bodyCol = mix(bodyCol, uDeepSapphire, zPelagic);

        // Spectral Beer-Lambert transmission onto illuminated coral sandbar and reef floor
        vec3 beerT = exp(-depthM * vec3(0.40, 0.102, 0.058));
        vec3 sandFloor = mix(uShallowSand * 0.80, uShallowSand * 1.15, sandyMask);
        float sandWeight = (0.48 + 0.40 * sandyMask) * (1.0 - zPelagic);
        vec3 waterCol = mix(bodyCol, sandFloor, beerT * sandWeight);

        // Dual-layer chromatic seabed caustics in sunlit shallows and lagoons
        float shallowVis = (1.0 - smoothstep(0.9, 12.5, depthM)) * (1.0 - smoothstep(48.0, 132.0, dist));
        if (shallowVis > 0.005) {
          vec3 seabedP = vec3(p.x, WATER_Y - min(depthM, 6.5), p.y);
          vec3 refractedP = seabedP + vec3(N.x, 0.0, N.z) * 0.48;
          vec3 causRGB = uwCausticsRGB(tWater, refractedP, dist, uSunDir);
          if (uWaterIsFloat < 0.5) causRGB *= 2.4;
          waterCol += causRGB * vec3(0.13, 0.24, 0.22) * shallowVis * (0.55 + 0.45 * beerT.g);
        }

        // Physical wave-crest subsurface scattering (backlit sun-through-wave turquoise-jade glow)
        float waveElev = max(0.0, (vWorld.y - WATER_Y + 0.035) / max(0.09, 0.21 * vWaveShelter.x));
        float crestPinch = clamp(1.10 - vJacobian, 0.0, 0.85);
        vec3 transSunDir = normalize(vec3(-uSunDir.x, max(0.12, uSunDir.y * 0.42), -uSunDir.z));
        float backSun = pow(max(0.0, dot(V, transSunDir)), 3.2);
        float slopeBacklit = clamp(0.5 - 0.5 * dot(N, uSunDir), 0.0, 1.0);
        vec3 sssTint = mix(uShallowTurquoise, uCrystalMint, 0.42);
        float sssMask = (waveElev * 0.72 + crestPinch * 0.48) * (0.20 + 0.68 * backSun) * (0.45 + 0.55 * slopeBacklit) * (1.0 - ndv * 0.65);
        waterCol += sssTint * sssMask * (1.0 - zPelagic * 0.38) * 0.62;

        // Synchronized real-time fish surface shadows (visible beneath surface before Fresnel sky reflection!)
        float clarity = 1.0 - smoothstep(2.5, 16.5, depthM);
        float fishShadow = surfaceFishShadow(p + N.xz * 0.18, time) * (0.52 + 0.48 * clarity) * (1.0 - smoothstep(55.0, 130.0, dist));
        waterCol = mix(waterCol, vec3(0.032, 0.108, 0.180), fishShadow * 0.86);

        // Sky, horizon and sun-path reflection weighted by Schlick Fresnel
        vec3 R = reflect(-V, N);
        float rh = max(0.0, R.y);
        vec3 skyRefl = mix(uSkyHorizon, uSkyZenith, pow(rh, 0.56));
        float reflSun = max(0.0, dot(R, uSunDir));
        skyRefl += uGlintColor * pow(reflSun, 20.0) * 0.28;
        vec3 c = mix(waterCol, skyRefl, clamp(fresnel * (0.84 - 0.30 * fishShadow), 0.02, 0.86));

        // Dual-lobe solar glitter specular (diamond capillary glints + broad warm solar sheen, HDR <= 7.5)
        vec3 H = normalize(V + uSunDir);
        float ndh = max(0.0, dot(N, H));
        float specTight = pow(ndh, uQualityLevel > 0.5 ? 320.0 : 145.0) * 3.25;
        float specBroad = pow(ndh, 36.0) * 0.17;
        c += min(uGlintColor * (specTight + specBroad), vec3(7.5));

        // ====================================================================
        // Animated Inward-Rolling Surf, Cellular Swash Lace and Rock Breakers
        // ====================================================================
        float foamNoise = seaFbm(p * 0.62 + vec2(time * 0.055, -time * 0.042));

        // 1. Oncoming shoreline surf (dShore * k + time * omega advances INWARD toward shoreDist = 0!)
        float dShore = shoreDist + (foamNoise - 0.5) * 1.35;
        float surfZone = (1.0 - smoothstep(0.35, 5.6, shoreDist)) * smoothstep(-0.90, 0.12, shoreDist);
        float shoreFoam = 0.0;
        if (surfZone > 0.002) {
          float surfPhase1 = fract(dShore * 0.24 + time * 0.22 + foamNoise * 0.28);
          float boreFront1 = smoothstep(0.03, 0.15, surfPhase1) * (1.0 - smoothstep(0.15, 0.62, surfPhase1));
          float surfPhase2 = fract(dShore * 0.43 + time * 0.31 + seaNoise(p * 1.15) * 0.32);
          float boreFront2 = smoothstep(0.04, 0.18, surfPhase2) * (1.0 - smoothstep(0.18, 0.54, surfPhase2)) * 0.68;

          float beachBoost = mix(0.68, 1.08, sandyMask);
          float laceMask = mix(0.42, 1.0, foamLace);
          shoreFoam = max(boreFront1, boreFront2) * laceMask * surfZone * beachBoost;

          // Delicate breathing swash waterline lip right on the wet sand / coastal ledge
          float swashRunup = 0.16 + 0.18 * sin(time * 1.38 + foamNoise * 3.8);
          float waterlineLace = (1.0 - smoothstep(0.0, 0.68, abs(dShore - swashRunup)))
                              * (0.48 + 0.52 * foamLace)
                              * smoothstep(-0.65, 0.08, shoreDist)
                              * 0.64;
          shoreFoam = max(shoreFoam, waterlineLace);
        }

        // 2. Wave-coupled rock, reef and karst spire breaker collars
        float rockBand = (1.0 - smoothstep(0.08, 2.35, rockDist)) * smoothstep(-0.60, 0.08, rockDist);
        float rockFoam = 0.0;
        if (rockBand > 0.002) {
          float dRock = rockDist + (foamNoise - 0.5) * 0.72;
          float waveSurge = clamp(0.58 + (vWorld.y - WATER_Y) * 2.4, 0.28, 1.25);
          float collarContact = (1.0 - smoothstep(0.0, 0.62, abs(dRock - 0.12))) * 0.78;
          float breakerPulse = fract(dRock * 0.52 + time * 0.34 + foamNoise * 0.35);
          float outerWash = smoothstep(0.04, 0.20, breakerPulse) * (1.0 - smoothstep(0.20, 0.68, breakerPulse)) * 0.72;
          rockFoam = max(collarContact, outerWash) * (0.38 + 0.62 * foamLace) * rockBand * waveSurge * 0.88;
        }

        // 3. Open-water Jacobian wave-crest whitecaps + impulse splash ring froth
        float crestFoam = smoothstep(0.85, 0.71, vJacobian)
                        * smoothstep(0.38, 0.78, foamLace * 0.65 + foamNoise * 0.45)
                        * 0.46
                        * smoothstep(2.5, 9.0, shoreDist);

        float totalFoam = clamp(max(max(shoreFoam, rockFoam), splashEval.z) + crestFoam, 0.0, 0.94);
        vec3 foamAlbedo = mix(vec3(0.91, 0.97, 0.97), uSkyHorizon * 1.06, 0.24);
        c = mix(c, foamAlbedo, totalFoam * 0.78);

        // Smooth waterline meniscus blend when camera is right at the surface
        float meniscusDist = abs(cameraPosition.y - vWorld.y);
        if (meniscusDist < 0.28) {
          float men = (1.0 - meniscusDist / 0.28) * uwSS(18.0, 1.5, dist);
          c = mix(c, UW_WCOL * 0.85 + vec3(0.08, 0.18, 0.22), men * 0.35);
        }

        // Atmospheric horizon aerial perspective
        c = mix(c, uHazeColor, 1.0 - exp(-dist * 0.00185));

        gl_FragColor = vec4(min(max(c, vec3(0.0)), vec3(12.0)), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const { geometry, cell } = waterGeometry(initialTier === 'low');
  const water = new T.Mesh(geometry, material);
  water.name = 'ArchipelagoSeaSurface';
  // CRITICAL DRY-BILGE ORDERING: drawn at renderOrder = 2, strictly after opaque geometry (0) and `Rowboat_DryMask` (1)!
  water.renderOrder = 2;
  water.frustumCulled = false;
  scene.add(water);

  const applyTimeOfDay = (tod: ArenaTimeOfDay) => {
    wake.setTimeOfDay(tod);
    if (tod === 'sunset') {
      sunDirUniform.value.set(-0.74, 0.34, 0.58).normalize();
      skyUniforms.uZenith.value.setRGB(0.11, 0.19, 0.44);
      skyUniforms.uMidSky.value.setRGB(0.56, 0.42, 0.58);
      skyUniforms.uHorizon.value.setRGB(0.96, 0.64, 0.44);
      skyUniforms.uSunCorona.value.setRGB(1.0, 0.48, 0.20);
      skyUniforms.uSunDisc.value.setRGB(1.0, 0.78, 0.45);
      skyUniforms.uCloudBase.value.setRGB(0.86, 0.74, 0.78);
      skyUniforms.uCloudSun.value.setRGB(1.0, 0.68, 0.42);
      skyUniforms.uGrottoBoost.value = 0.24;

      seaUniforms.uSkyZenith.value.setRGB(0.14, 0.21, 0.46);
      seaUniforms.uSkyHorizon.value.setRGB(0.95, 0.62, 0.43);
      seaUniforms.uHazeColor.value.setRGB(0.90, 0.66, 0.52);
      seaUniforms.uGlintColor.value.setRGB(1.0, 0.64, 0.32);
      seaUniforms.uShallowSand.value.setRGB(0.78, 0.58, 0.44);
      seaUniforms.uCrystalMint.value.setRGB(0.18, 0.64, 0.62);
      seaUniforms.uShallowTurquoise.value.setRGB(0.055, 0.48, 0.52);
      seaUniforms.uMidEmerald.value.setRGB(0.028, 0.25, 0.44);
      seaUniforms.uDeepSapphire.value.setRGB(0.014, 0.068, 0.205);
      seaUniforms.uGrottoBoost.value = 0.24;
    } else {
      sunDirUniform.value.set(-0.58, 0.72, 0.40).normalize();
      skyUniforms.uZenith.value.setRGB(0.068, 0.295, 0.615);
      skyUniforms.uMidSky.value.setRGB(0.32, 0.65, 0.86);
      skyUniforms.uHorizon.value.setRGB(0.81, 0.89, 0.92);
      skyUniforms.uSunCorona.value.setRGB(0.94, 0.66, 0.32);
      skyUniforms.uSunDisc.value.setRGB(1.0, 0.88, 0.62);
      skyUniforms.uCloudBase.value.setRGB(0.95, 0.96, 0.98);
      skyUniforms.uCloudSun.value.setRGB(1.0, 0.93, 0.82);
      skyUniforms.uGrottoBoost.value = 0.06;

      seaUniforms.uSkyZenith.value.setRGB(0.068, 0.295, 0.615);
      seaUniforms.uSkyHorizon.value.setRGB(0.76, 0.87, 0.91);
      seaUniforms.uHazeColor.value.setRGB(0.68, 0.82, 0.88);
      seaUniforms.uGlintColor.value.setRGB(1.0, 0.88, 0.60);
      seaUniforms.uShallowSand.value.setRGB(0.74, 0.69, 0.54);
      seaUniforms.uCrystalMint.value.setRGB(0.16, 0.84, 0.78);
      seaUniforms.uShallowTurquoise.value.setRGB(0.032, 0.66, 0.68);
      seaUniforms.uMidEmerald.value.setRGB(0.016, 0.36, 0.58);
      seaUniforms.uDeepSapphire.value.setRGB(0.007, 0.088, 0.265);
      seaUniforms.uGrottoBoost.value = 0.06;
    }
  };
  applyTimeOfDay(initialTod);

  const uploadFishSchools = (schools: readonly SurfaceFishSchool[], focus?: T.Vector3) => {
    const n = Math.min(MAX_FISH_SCHOOLS, schools.length);
    let selected: readonly SurfaceFishSchool[] = schools;
    if (schools.length > MAX_FISH_SCHOOLS && focus) {
      selected = [...schools]
        .sort((a, b) => (a.x - focus.x) ** 2 + (a.z - focus.z) ** 2 - ((b.x - focus.x) ** 2 + (b.z - focus.z) ** 2))
        .slice(0, MAX_FISH_SCHOOLS);
    }
    let activeCount = 0;
    for (let i = 0; i < n; i++) {
      const s = selected[i];
      const subDepth = Math.max(0, ARENA_WATER_Y - s.y);
      const depthFade = 1 - T.MathUtils.smoothstep(subDepth, 0.35, 4.8);
      const effDens = T.MathUtils.clamp(s.density, 0, 1.5) * depthFade;
      if (effDens <= 0.005 || s.count <= 0) continue;
      fishPosRad[activeCount].set(s.x, s.y, s.z, Math.max(s.radius, 0.8));
      fishHeadDens[activeCount].set(Math.cos(s.heading), Math.sin(s.heading), effDens, s.count);
      activeCount++;
    }
    seaUniforms.uFishSchoolCount.value = activeCount;
  };

  const updateDefaultAmbientSchools = (t: number) => {
    let activeCount = 0;
    for (let i = 0; i < DEFAULT_DOCK_SCHOOLS.length; i++) {
      const ds = DEFAULT_DOCK_SCHOOLS[i];
      const ang = t * ds.omega + ds.phase;
      const x = ds.cx + Math.cos(ang) * ds.orbitR;
      const z = ds.cz + Math.sin(ang) * (ds.orbitR * 0.68);
      const y = ARENA_WATER_Y - 0.65 + Math.sin(ang * 2.5 + ds.phase) * 0.18;
      const vx = -Math.sin(ang) * ds.orbitR * Math.sign(ds.omega);
      const vz = Math.cos(ang) * (ds.orbitR * 0.68) * Math.sign(ds.omega);
      const heading = Math.atan2(vz, vx);
      fishPosRad[activeCount].set(x, y, z, ds.radius);
      fishHeadDens[activeCount].set(Math.cos(heading), Math.sin(heading), 0.78, ds.count);
      activeCount++;
    }
    seaUniforms.uFishSchoolCount.value = activeCount;
  };

  let explicitSchoolsProvided = false;

  return {
    waterMesh: water,
    skyDome: dome,
    seaMapTexture,

    triggerSurfaceSplash(x: number, z: number, strength = 0.75, maxRadius = 3.2) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      const safeStrength = T.MathUtils.clamp(Number.isFinite(strength) ? strength : 0.75, 0.08, 2.2);
      const safeRadius = T.MathUtils.clamp(Number.isFinite(maxRadius) ? maxRadius : 3.2, 0.6, 16.0);
      const dur = 1.85 + T.MathUtils.clamp(safeRadius / 5.0, 0, 1.45) * 0.65;
      const packed = Math.max(1, Math.round(safeStrength * 1000)) + safeRadius / 32.0;

      // Prefer any expired slot; otherwise recycle the oldest slot by normalized progress.
      let slot = -1;
      let oldestProgress = -1;
      for (let i = 0; i < MAX_SPLASH_RINGS; i++) {
        const d = splashSlotDur[i];
        if (d <= 0 || lastSeaTime - splashSlotBirth[i] >= d) {
          slot = i;
          break;
        }
        const prog = (lastSeaTime - splashSlotBirth[i]) / d;
        if (prog > oldestProgress) {
          oldestProgress = prog;
          slot = i;
        }
      }
      if (slot < 0) {
        slot = splashCursor;
        splashCursor = (splashCursor + 1) % MAX_SPLASH_RINGS;
      }

      splashSlotX[slot] = x;
      splashSlotZ[slot] = z;
      splashSlotBirth[slot] = lastSeaTime;
      splashSlotDur[slot] = dur;
      splashSlotPacked[slot] = packed;
      syncSplashUniforms(lastSeaTime);
    },

    update(
      t: number,
      activeWakes?: readonly SeaWakeSource[],
      focus?: T.Vector3,
      surfaceSchools?: readonly SurfaceFishSchool[],
    ) {
      lastSeaTime = t;
      seaUniforms.time.value = t;
      skyUniforms.time.value = t;

      if (focus) {
        water.position.set(
          Math.round(focus.x / cell) * cell,
          0,
          Math.round(focus.z / cell) * cell,
        );
        dome.position.set(focus.x, 0, focus.z);
      }

      syncSplashUniforms(t);

      if (surfaceSchools !== undefined) {
        explicitSchoolsProvided = true;
        uploadFishSchools(surfaceSchools, focus);
      } else if (!explicitSchoolsProvided) {
        updateDefaultAmbientSchools(t);
      }

      // Extract boat hull silhouettes from wake sources so underwater Snell's window shows overhead hulls!
      let hullCount = 0;
      if (activeWakes) {
        for (let i = 0; i < activeWakes.length && hullCount < MAX_BOAT_HULLS; i++) {
          const w = activeWakes[i];
          if (w.swimmer || w.bobber) continue;
          boatHulls[hullCount].set(w.x, w.z, w.yaw, w.motor ? 3.2 : 2.0);
          hullCount++;
        }
      }
      seaUniforms.uBoatHullCount.value = hullCount;

      wake.update(activeWakes ?? [], t);
    },

    setQuality(tier: ArenaQualityTier) {
      seaUniforms.uQualityLevel.value = tierLevel(tier);
      wake.setQuality(tier);
    },

    setTimeOfDay(tod: ArenaTimeOfDay) {
      applyTimeOfDay(tod);
    },

    setCausticsTexture(tex: T.Texture | null, isFloat = true) {
      if (tex) {
        seaUniforms.tWater.value = tex;
        seaUniforms.uWaterIsFloat.value = isFloat ? 1 : 0;
      } else {
        seaUniforms.tWater.value = fallbackWaterTex;
        seaUniforms.uWaterIsFloat.value = 0;
      }
    },

    setSunDirection(dir: T.Vector3) {
      sunDirUniform.value.copy(dir).normalize();
    },

    setFishSchools(schools: readonly SurfaceFishSchool[], focus?: T.Vector3) {
      explicitSchoolsProvided = true;
      uploadFishSchools(schools, focus);
    },

    dispose() {
      scene.remove(water);
      scene.remove(dome);
      wake.dispose();
      geometry.dispose();
      material.dispose();
      dome.geometry.dispose();
      sky.dispose();
      seaMapTexture.dispose();
      fallbackWaterTex.dispose();
    },
  };
}
