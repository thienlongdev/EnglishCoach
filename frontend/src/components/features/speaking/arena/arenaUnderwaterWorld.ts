/**
 * Portions adapted from Abyssal Garden — Copyright (c) 2026 Maksymilian Dendura, MIT License
 *
 * Procedural Abyssal Reefs, Kelp Cathedral, Sculpted Surface-Nets Arches & Swim-Through Caves,
 * Submerged Echo Whale Stone Fluke Sanctuary, Sunken Timber Shipwreck, Corals, Sponges,
 * GPU Fish & Manta Rays, Wobble-Bubbles, and 9,000 Camera-Wrapped Marine Snow Motes
 * for Project ECHO ARCHIPELAGO (Single Unified Three.js WebGL2 Renderer).
 */

import * as T from 'three';
import type { ArenaIslandSpec, ArenaQualityTier, ArenaTimeOfDay, SurfaceFishSchool } from './arenaContracts';
import { ARENA_WATER_Y, arenaBathymetry, arenaLayout, arenaShoreRadius } from './arenaTerrain';
import {
  CausticsSlopePass,
  RockDetailBaker,
  UnderwaterGodRaysPass,
  applyTimeOfDayToUnderwaterUniforms,
  createFallbackShadowTarget,
  createUnderwaterBackdropMaterial,
  createUnderwaterBubbleMaterial,
  createUnderwaterGlintMaterial,
  createUnderwaterLeafDepthMaterial,
  createUnderwaterLeafMaterial,
  createUnderwaterSnowMaterial,
  createUnderwaterSolidDepthMaterial,
  createUnderwaterSolidMaterial,
  tierLevel,
  type SharedUnderwaterUniforms,
} from './arenaUnderwaterShaders';

export type { SharedUnderwaterUniforms };

const { sin, cos, sqrt, min, max, abs, floor, PI, pow, hypot, exp, round, atan2 } = Math;
const TAU = PI * 2;

// ============================================================================
// 1. Deterministic Mulberry32 PRNG, 3D Noise, Quaternions & Surface Nets
// ============================================================================

let _seed = 20261110;

export function rseed(s: number): void {
  _seed = (20261110 + Math.imul(s, 7919)) | 0;
}

export function rnd(): number {
  _seed = (_seed + 0x6d2b79f5) | 0;
  let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const rr = (a: number, b: number): number => a + (b - a) * rnd();
const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const fract = (x: number): number => x - floor(x);
const sstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function ihash(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x: number, y: number, z: number): number {
  const ix = floor(x);
  const iy = floor(y);
  const iz = floor(z);
  let fx = x - ix;
  let fy = y - iy;
  let fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  fz = fz * fz * (3 - 2 * fz);
  const a = mix(
    mix(ihash(ix, iy, iz), ihash(ix + 1, iy, iz), fx),
    mix(ihash(ix, iy + 1, iz), ihash(ix + 1, iy + 1, iz), fx),
    fy,
  );
  const b = mix(
    mix(ihash(ix, iy, iz + 1), ihash(ix + 1, iy, iz + 1), fx),
    mix(ihash(ix, iy + 1, iz + 1), ihash(ix + 1, iy + 1, iz + 1), fx),
    fy,
  );
  return mix(a, b, fz);
}

function fbm3(x: number, y: number, z: number, octaves = 4): number {
  let a = 0.5;
  let s = 0;
  for (let i = 0; i < octaves; i++) {
    s += a * vnoise(x, y, z);
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 31.7;
    z = z * 2.03 + 5.3;
    a *= 0.5;
  }
  return s / (1 - 2 * a);
}

type Quat4 = [number, number, number, number];
type Vec3Tuple = [number, number, number];

const qAxis = (x: number, y: number, z: number, a: number): Quat4 => {
  const l = hypot(x, y, z) || 1;
  const s = sin(a / 2) / l;
  return [x * s, y * s, z * s, cos(a / 2)];
};

const qMul = (a: Quat4, b: Quat4): Quat4 => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

const qRand = (): Quat4 => {
  const q: Quat4 = [rr(-1, 1), rr(-1, 1), rr(-1, 1), rr(-1, 1)];
  const l = hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};

const qFromY = (nx: number, ny: number, nz: number): Quat4 => {
  if (ny < -0.9999) return [1, 0, 0, 0];
  const q: Quat4 = [nz, 0, -nx, 1 + ny];
  const l = hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};

/**
 * Exact 12-edge sign-change centroid Naive Surface Nets (`D > 0` inside solid).
 */
export function surfaceNets(
  D: Float32Array,
  nx: number,
  ny: number,
  nz: number,
): { pos: Float32Array; idx: Uint32Array; nv: number; ni: number } {
  let pos = new Float32Array(8192 * 3);
  let nv = 0;
  let idx = new Uint32Array(16384 * 3);
  let ni = 0;
  const sl = nx * ny;
  let cur = new Int32Array(sl);
  let prev = new Int32Array(sl);

  for (let z = 0; z < nz - 1; z++) {
    for (let y = 0; y < ny - 1; y++) {
      let i0 = nx * (y + ny * z);
      for (let x = 0; x < nx - 1; x++, i0++) {
        const d0 = D[i0];
        const d1 = D[i0 + 1];
        const d2 = D[i0 + nx];
        const d3 = D[i0 + nx + 1];
        const d4 = D[i0 + sl];
        const d5 = D[i0 + sl + 1];
        const d6 = D[i0 + sl + nx];
        const d7 = D[i0 + sl + nx + 1];
        const m =
          (d0 > 0 ? 1 : 0) |
          ((d1 > 0 ? 1 : 0) << 1) |
          ((d2 > 0 ? 1 : 0) << 2) |
          ((d3 > 0 ? 1 : 0) << 3) |
          ((d4 > 0 ? 1 : 0) << 4) |
          ((d5 > 0 ? 1 : 0) << 5) |
          ((d6 > 0 ? 1 : 0) << 6) |
          ((d7 > 0 ? 1 : 0) << 7);
        if (m === 0 || m === 255) continue;

        let sx = 0;
        let sy = 0;
        let sz = 0;
        let n = 0;
        let t: number;
        if (d0 > 0 !== d1 > 0) { t = d0 / (d0 - d1); sx += t; n++; }
        if (d2 > 0 !== d3 > 0) { t = d2 / (d2 - d3); sx += t; sy += 1; n++; }
        if (d4 > 0 !== d5 > 0) { t = d4 / (d4 - d5); sx += t; sz += 1; n++; }
        if (d6 > 0 !== d7 > 0) { t = d6 / (d6 - d7); sx += t; sy += 1; sz += 1; n++; }
        if (d0 > 0 !== d2 > 0) { t = d0 / (d0 - d2); sy += t; n++; }
        if (d1 > 0 !== d3 > 0) { t = d1 / (d1 - d3); sy += t; sx += 1; n++; }
        if (d4 > 0 !== d6 > 0) { t = d4 / (d4 - d6); sy += t; sz += 1; n++; }
        if (d5 > 0 !== d7 > 0) { t = d5 / (d5 - d7); sy += t; sx += 1; sz += 1; n++; }
        if (d0 > 0 !== d4 > 0) { t = d0 / (d0 - d4); sz += t; n++; }
        if (d1 > 0 !== d5 > 0) { t = d1 / (d1 - d5); sz += t; sx += 1; n++; }
        if (d2 > 0 !== d6 > 0) { t = d2 / (d2 - d6); sz += t; sy += 1; n++; }
        if (d3 > 0 !== d7 > 0) { t = d3 / (d3 - d7); sz += t; sx += 1; sy += 1; n++; }

        if (nv * 3 + 3 > pos.length) {
          const p2 = new Float32Array(pos.length * 2);
          p2.set(pos);
          pos = p2;
        }
        const vi = nv++;
        pos[vi * 3] = x + sx / n;
        pos[vi * 3 + 1] = y + sy / n;
        pos[vi * 3 + 2] = z + sz / n;
        const ci = x + nx * y;
        cur[ci] = vi;

        if (ni + 18 > idx.length) {
          const i2 = new Uint32Array(idx.length * 2);
          i2.set(idx);
          idx = i2;
        }
        const s0 = d0 > 0;
        if (d1 > 0 !== s0 && y > 0 && z > 0) {
          const a = vi, b = cur[ci - nx], c = prev[ci - nx], d = prev[ci];
          if (s0) { idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; idx[ni++] = a; idx[ni++] = c; idx[ni++] = d; }
          else { idx[ni++] = a; idx[ni++] = c; idx[ni++] = b; idx[ni++] = a; idx[ni++] = d; idx[ni++] = c; }
        }
        if (d2 > 0 !== s0 && x > 0 && z > 0) {
          const a = vi, b = prev[ci], c = prev[ci - 1], d = cur[ci - 1];
          if (s0) { idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; idx[ni++] = a; idx[ni++] = c; idx[ni++] = d; }
          else { idx[ni++] = a; idx[ni++] = c; idx[ni++] = b; idx[ni++] = a; idx[ni++] = d; idx[ni++] = c; }
        }
        if (d4 > 0 !== s0 && x > 0 && y > 0) {
          const a = vi, b = cur[ci - 1], c = cur[ci - 1 - nx], d = cur[ci - nx];
          if (s0) { idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; idx[ni++] = a; idx[ni++] = c; idx[ni++] = d; }
          else { idx[ni++] = a; idx[ni++] = c; idx[ni++] = b; idx[ni++] = a; idx[ni++] = d; idx[ni++] = c; }
        }
      }
    }
    const tmp = cur;
    cur = prev;
    prev = tmp;
  }
  return { pos: pos.subarray(0, nv * 3), idx: idx.subarray(0, ni), nv, ni };
}

function sampler3(D: Float32Array, nx: number, ny: number, nz: number): (x: number, y: number, z: number) => number {
  const sl = nx * ny;
  return (x: number, y: number, z: number): number => {
    x = clamp(x, 0, nx - 1.001);
    y = clamp(y, 0, ny - 1.001);
    z = clamp(z, 0, nz - 1.001);
    const ix = x | 0;
    const iy = y | 0;
    const iz = z | 0;
    const fx = x - ix;
    const fy = y - iy;
    const fz = z - iz;
    const i = ix + nx * (iy + ny * iz);
    const a = mix(mix(D[i], D[i + 1], fx), mix(D[i + nx], D[i + nx + 1], fx), fy);
    const b = mix(mix(D[i + sl], D[i + sl + 1], fx), mix(D[i + sl + nx], D[i + sl + nx + 1], fx), fy);
    return mix(a, b, fz);
  };
}

function surfaceNetsToGeometry(
  D: Float32Array,
  nx: number,
  ny: number,
  nz: number,
  ox: number,
  oy: number,
  oz: number,
  vs: number,
): T.BufferGeometry | null {
  const sn = surfaceNets(D, nx, ny, nz);
  if (sn.nv === 0 || sn.ni === 0) return null;
  const smp = sampler3(D, nx, ny, nz);
  const pos = new Float32Array(sn.nv * 3);
  const nrm = new Float32Array(sn.nv * 3);
  const aux = new Float32Array(sn.nv);
  const e = 0.75;

  for (let k = 0; k < sn.nv; k++) {
    const gx = sn.pos[k * 3];
    const gy = sn.pos[k * 3 + 1];
    const gz = sn.pos[k * 3 + 2];
    const dx = smp(gx - e, gy, gz) - smp(gx + e, gy, gz);
    const dy = smp(gx, gy - e, gz) - smp(gx, gy + e, gz);
    const dz = smp(gx, gy, gz - e) - smp(gx, gy, gz + e);
    const l = hypot(dx, dy, dz) || 1;
    pos[k * 3] = ox + gx * vs;
    pos[k * 3 + 1] = oy + gy * vs;
    pos[k * 3 + 2] = oz + gz * vs;
    nrm[k * 3] = dx / l;
    nrm[k * 3 + 1] = dy / l;
    nrm[k * 3 + 2] = dz / l;
    aux[k] = 1;
  }

  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(pos, 3));
  g.setAttribute('normal', new T.BufferAttribute(nrm, 3));
  g.setAttribute('aAux', new T.BufferAttribute(aux, 1));
  g.setIndex(new T.BufferAttribute(new Uint32Array(sn.idx), 1));
  g.computeBoundingSphere();
  return g;
}

// ============================================================================
// 2. Procedural Mesh Builder (`Mesh.sweep`, `Mesh.tube`, `icosphere`)
// ============================================================================

export class UnderwaterMesh {
  readonly p: number[] = [];
  readonly i: number[] = [];
  readonly aux: number[] = [];

  v(x: number, y: number, z: number, aux = 1): number {
    this.p.push(x, y, z);
    this.aux.push(aux);
    return this.p.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.i.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.i.push(a, b, c, a, c, d);
  }

  /** Hard-edged rectangular beam/plank sweep along a polyline (`Mesh.sweep`). */
  sweep(
    pts: Vec3Tuple[],
    w: number | ((k: number) => number),
    h: number | ((k: number) => number),
    upFn?: (p: Vec3Tuple, k: number) => Vec3Tuple,
    caps = true,
  ): void {
    const rings: number[][] = [];
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      const a = pts[max(k - 1, 0)];
      const b = pts[min(k + 1, pts.length - 1)];
      let tx = b[0] - a[0];
      let ty = b[1] - a[1];
      let tz = b[2] - a[2];
      const tl = hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      const u0 = upFn ? upFn(p, k) : ([0, 1, 0] as Vec3Tuple);
      let sx = u0[1] * tz - u0[2] * ty;
      let sy = u0[2] * tx - u0[0] * tz;
      let sz = u0[0] * ty - u0[1] * tx;
      const sl = hypot(sx, sy, sz) || 1;
      sx /= sl;
      sy /= sl;
      sz /= sl;
      const ux = ty * sz - tz * sy;
      const uy = tz * sx - tx * sz;
      const uz = tx * sy - ty * sx;
      const ww = typeof w === 'function' ? w(k) : w;
      const hh = typeof h === 'function' ? h(k) : h;
      const corners: Vec3Tuple[] = (
        [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ] as const
      ).map(([e, f]) => [
        p[0] + (sx * e * ww) / 2 + (ux * f * hh) / 2,
        p[1] + (sy * e * ww) / 2 + (uy * f * hh) / 2,
        p[2] + (sz * e * ww) / 2 + (uz * f * hh) / 2,
      ]);
      const r: number[] = [];
      for (let s = 0; s < 4; s++) {
        const c0 = corners[s];
        const c1 = corners[(s + 1) % 4];
        r.push(this.v(c0[0], c0[1], c0[2]), this.v(c1[0], c1[1], c1[2]));
      }
      rings.push(r);
      if (caps && (k === 0 || k === pts.length - 1)) {
        const q = corners.map(cc => this.v(cc[0], cc[1], cc[2]));
        if (k === 0) this.quad(q[0], q[1], q[2], q[3]);
        else this.quad(q[3], q[2], q[1], q[0]);
      }
    }
    for (let k = 0; k < rings.length - 1; k++) {
      for (let s = 0; s < 4; s++) {
        const a = rings[k][s * 2];
        const b = rings[k][s * 2 + 1];
        const c = rings[k + 1][s * 2 + 1];
        const d = rings[k + 1][s * 2];
        this.quad(a, d, c, b);
      }
    }
  }

  /** Smooth radial tube along polyline with variable radius & AO (`Mesh.tube`). */
  tube(
    pts: Vec3Tuple[],
    rad: number | ((k: number) => number),
    sides = 6,
    capEnd = true,
    auxFn?: (k: number) => number,
  ): void {
    const rings: number[][] = [];
    let ux = 0.31;
    let uy = 0.9;
    let uz = 0.3;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      const a = pts[max(k - 1, 0)];
      const b = pts[min(k + 1, pts.length - 1)];
      let tx = b[0] - a[0];
      let ty = b[1] - a[1];
      let tz = b[2] - a[2];
      const tl = hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      let sx = uy * tz - uz * ty;
      let sy = uz * tx - ux * tz;
      let sz = ux * ty - uy * tx;
      const sl = hypot(sx, sy, sz) || 1;
      sx /= sl;
      sy /= sl;
      sz /= sl;
      ux = ty * sz - tz * sy;
      uy = tz * sx - tx * sz;
      uz = tx * sy - ty * sx;
      const r = typeof rad === 'function' ? rad(k) : rad;
      const ring: number[] = [];
      const aoVal = auxFn ? auxFn(k) : min(1, 0.35 + (0.65 * k) / max(pts.length - 1, 1));
      for (let s = 0; s < sides; s++) {
        const an = (s / sides) * TAU;
        const ca = cos(an);
        const sa = sin(an);
        ring.push(
          this.v(
            p[0] + (sx * ca + ux * sa) * r,
            p[1] + (sy * ca + uy * sa) * r,
            p[2] + (sz * ca + uz * sa) * r,
            aoVal,
          ),
        );
      }
      rings.push(ring);
    }
    for (let k = 0; k < rings.length - 1; k++) {
      for (let s = 0; s < sides; s++) {
        const s2 = (s + 1) % sides;
        this.quad(rings[k][s], rings[k][s2], rings[k + 1][s2], rings[k + 1][s]);
      }
    }
    if (capEnd && pts.length > 0) {
      const e = pts[pts.length - 1];
      const c = this.v(e[0], e[1], e[2], auxFn ? auxFn(pts.length - 1) : 1);
      const r = rings[rings.length - 1];
      for (let s = 0; s < sides; s++) {
        this.tri(r[s], r[(s + 1) % sides], c);
      }
    }
  }

  toBufferGeometry(): T.BufferGeometry {
    const n = this.p.length / 3;
    const P = new Float32Array(this.p);
    const I = new Uint32Array(this.i);
    const N = new Float32Array(n * 3);
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3;
      const b = I[t + 1] * 3;
      const c = I[t + 2] * 3;
      const ux = P[b] - P[a];
      const uy = P[b + 1] - P[a + 1];
      const uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a];
      const vy = P[c + 1] - P[a + 1];
      const vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      N[a] += nx; N[a + 1] += ny; N[a + 2] += nz;
      N[b] += nx; N[b + 1] += ny; N[b + 2] += nz;
      N[c] += nx; N[c + 1] += ny; N[c + 2] += nz;
    }
    for (let k = 0; k < n; k++) {
      const l = hypot(N[k * 3], N[k * 3 + 1], N[k * 3 + 2]) || 1;
      N[k * 3] /= l;
      N[k * 3 + 1] /= l;
      N[k * 3 + 2] /= l;
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(P, 3));
    g.setAttribute('normal', new T.BufferAttribute(N, 3));
    g.setAttribute('aAux', new T.BufferAttribute(new Float32Array(this.aux), 1));
    g.setIndex(new T.BufferAttribute(I, 1));
    g.computeBoundingSphere();
    return g;
  }
}

function icosphere(sub: number, fn?: (x: number, y: number, z: number) => Vec3Tuple): UnderwaterMesh {
  const m = new UnderwaterMesh();
  const t = (1 + sqrt(5)) / 2;
  const V: Vec3Tuple[] = (
    [
      [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
      [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
      [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
    ] as Vec3Tuple[]
  ).map(v => {
    const l = hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  });
  let F: Vec3Tuple[] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let s = 0; s < sub; s++) {
    const cache = new Map<number, number>();
    const F2: Vec3Tuple[] = [];
    const mid = (a: number, b: number): number => {
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      let r = cache.get(key);
      if (r === undefined) {
        const px = V[a][0] + V[b][0];
        const py = V[a][1] + V[b][1];
        const pz = V[a][2] + V[b][2];
        const l = hypot(px, py, pz) || 1;
        V.push([px / l, py / l, pz / l]);
        r = V.length - 1;
        cache.set(key, r);
      }
      return r;
    };
    for (const [a, b, c] of F) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      F2.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    F = F2;
  }
  for (const v of V) {
    const p = fn ? fn(v[0], v[1], v[2]) : v;
    m.v(p[0], p[1], p[2], 1);
  }
  for (const f of F) m.tri(f[0], f[1], f[2]);
  return m;
}

// ============================================================================
// 3. Procedural Set-Piece & Reef Prop Mesh Generators (`world.js` Port)
// ============================================================================

/** FBM-displaced, planar-bevel-sliced boulder / pebble (`meshChunk`). */
export function meshChunk(sd: number, sub = 2): T.BufferGeometry {
  rseed(100 + sd);
  const planes: [number, number, number, number][] = [];
  for (let i = 0; i < 4; i++) {
    const q = qRand();
    const l = hypot(q[0], q[1], q[2]) || 1;
    planes.push([q[0] / l, q[1] / l, q[2] / l, rr(0.8, 0.98)]);
  }
  return icosphere(sub, (x, y, z) => {
    const det = sub > 2 ? (fbm3(x * 4 + sd, y * 4, z * 4, 2) - 0.5) * 0.25 : 0;
    const r = 1 + (fbm3(x * 1.6 + sd, y * 1.6, z * 1.6, 2) - 0.5) * 0.9 + det;
    let px = x * r;
    let py = y * r * 0.8;
    let pz = z * r;
    for (const p of planes) {
      const d = px * p[0] + py * p[1] + pz * p[2] - p[3];
      if (d > 0) {
        px -= p[0] * d;
        py -= p[1] * d;
        pz -= p[2] * d;
      }
    }
    return [px, py, pz];
  }).toBufferGeometry();
}

/** Ribbed barrel, vase, or bowl sponge (`meshLathe`). */
export function meshLathe(
  prof: readonly (readonly [number, number, number])[],
  seg: number,
  lump: number,
  ribs = 0,
): T.BufferGeometry {
  const m = new UnderwaterMesh();
  const rings: number[][] = [];
  for (const [r, h, ao] of prof) {
    const ring: number[] = [];
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * TAU;
      const rl = r * (1 + lump * (fbm3(cos(a) * 1.5 + h * 2, h * 3, sin(a) * 1.5, 2) - 0.5) + 0.07 * cos(ribs * a + h * 1.5));
      ring.push(m.v(cos(a) * rl, h, sin(a) * rl, ao));
    }
    rings.push(ring);
  }
  for (let k = 0; k < rings.length - 1; k++) {
    for (let s = 0; s < seg; s++) {
      const s2 = (s + 1) % seg;
      m.quad(rings[k][s], rings[k + 1][s], rings[k + 1][s2], rings[k][s2]);
    }
  }
  return m.toBufferGeometry();
}

/** Sea fan (`fan = 0`) and staghorn branching coral (`fan = 1`) (`meshCoral`). */
export function meshCoral(variant: 0 | 1): T.BufferGeometry {
  const isFan = variant === 0;
  rseed(200 + variant);
  const m = new UnderwaterMesh();
  const nrm = (v: Vec3Tuple): Vec3Tuple => {
    const l = hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const branch = (p: Vec3Tuple, d: Vec3Tuple, r: number, len: number, depth: number): void => {
    const pts: Vec3Tuple[] = [p];
    let q: Vec3Tuple = [p[0], p[1], p[2]];
    for (let i = 0; i < 3; i++) {
      d = nrm([
        d[0] + rr(-0.3, 0.3),
        d[1] + rr(-0.1, 0.3),
        d[2] + (isFan ? rr(-0.05, 0.05) : rr(-0.3, 0.3)),
      ]);
      q = [q[0] + (d[0] * len) / 3, q[1] + (d[1] * len) / 3, q[2] + (d[2] * len) / 3];
      pts.push(q);
    }
    if (!depth) {
      pts.push([q[0] + d[0] * r * 1.6, q[1] + d[1] * r * 1.6, q[2] + d[2] * r * 1.6]);
    }
    m.tube(
      pts,
      k => (k > 3 ? r * 0.36 : r * (1 - (0.22 * k) / 3)),
      isFan ? 5 : 6,
      true,
      k => clamp(1 - (depth + 1 - k / 3) / 5, 0, 1),
    );
    if (depth > 0) {
      const count = 2 + (rnd() < 0.5 ? 1 : 0);
      for (let i = 0; i < count; i++) {
        branch(
          q,
          nrm([
            d[0] + rr(-0.8, 0.8),
            d[1] + rr(-0.1, 0.5),
            d[2] + (isFan ? rr(-0.08, 0.08) : rr(-0.8, 0.8)),
          ]),
          r * 0.78,
          len * 0.8,
          depth - 1,
        );
      }
    }
  };
  const roots = isFan ? 1 : 2 + ((rnd() * 2) | 0);
  for (let i = 0; i < roots; i++) {
    branch(
      [rr(-0.08, 0.08), 0, rr(-0.08, 0.08)],
      nrm([rr(-0.5, 0.5), 1, isFan ? 0 : rr(-0.5, 0.5)]),
      isFan ? 0.06 : 0.08,
      isFan ? 0.52 : 0.45,
      3,
    );
  }
  return m.toBufferGeometry();
}

/** 9-pipe cluster tube sponge (`meshTubes`). */
export function meshTubes(): T.BufferGeometry {
  rseed(210);
  const m = new UnderwaterMesh();
  for (let i = 0; i < 9; i++) {
    const a = rnd() * TAU;
    const r0 = rr(0, 0.28);
    const h = rr(0.45, 1.1);
    const rad = rr(0.07, 0.12);
    const lean = rr(0.05, 0.3);
    const pts: Vec3Tuple[] = [];
    for (let k = 0; k <= 4; k++) {
      pts.push([
        cos(a) * (r0 + (lean * k) / 4 * h),
        (h * k) / 4,
        sin(a) * (r0 + (lean * k) / 4 * h),
      ]);
    }
    m.tube(pts, k => rad * (0.8 + (0.25 * k) / 4), 10, false, k => 0.35 + (0.65 * k) / 4);
    const e = pts[4];
    const n = m.p.length / 3;
    const c = m.v(e[0], e[1] - rad * 1.2, e[2], 0.05);
    for (let s2 = 0; s2 < 10; s2++) {
      m.tri(n - 10 + s2, n - 10 + ((s2 + 1) % 10), c);
    }
  }
  return m.toBufferGeometry();
}

/**
 * Submerged Echo Whale Stone Fluke Sanctuary (`meshFluke`):
 * 3-chain smooth-min (`k = 0.45`) tapered capsule SDF meshed via `surfaceNets` (`< 2.5 ms`).
 */
export function meshFluke(): T.BufferGeometry {
  const C: {
    ax: number; ay: number; az: number; ar: number;
    bax: number; bay: number; baz: number; br: number;
    invLen2: number; zs: number;
    minX: number; maxX: number; minY: number; maxY: number;
  }[] = [];
  const chain = (pts: number[][], zs: number) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const az = a[2] / zs;
      const bz = b[2] / zs;
      const bax = b[0] - a[0];
      const bay = b[1] - a[1];
      const baz = bz - az;
      const pad = max(a[3], b[3]) + 0.85;
      C.push({
        ax: a[0], ay: a[1], az, ar: a[3],
        bax, bay, baz, br: b[3],
        invLen2: 1 / max(bax * bax + bay * bay + baz * baz, 1e-6),
        zs,
        minX: min(a[0], b[0]) - pad,
        maxX: max(a[0], b[0]) + pad,
        minY: min(a[1], b[1]) - pad,
        maxY: max(a[1], b[1]) + pad,
      });
    }
  };
  chain([[0, -1.6, 3.7, 1.2], [0, 1.8, 2.35, 0.98], [0, 4.6, 1.0, 0.76], [0, 6.9, 0.1, 0.6]], 0.8);
  chain([[0, 6.6, 0.1, 0.72], [1.9, 7.9, 0, 0.98], [3.9, 8.8, -0.1, 0.9], [5.7, 9.8, -0.25, 0.64], [7.0, 11.2, -0.4, 0.38], [7.7, 12.8, -0.55, 0.2], [7.9, 14.1, -0.65, 0.1]], 0.18);
  chain([[0, 6.6, 0.1, 0.72], [-1.7, 8.3, 0.05, 0.96], [-3.3, 9.7, -0.05, 0.88], [-4.7, 11.2, -0.2, 0.64], [-5.6, 12.9, -0.4, 0.38], [-6.0, 14.6, -0.5, 0.2], [-5.9, 15.9, -0.6, 0.1]], 0.18);

  const vs = 0.34;
  const ox = -7.6;
  const oy = -2.6;
  const oz = -2.2;
  const nx = 49;
  const ny = 58;
  const nz = 20;
  const D = new Float32Array(nx * ny * nz);

  for (let z = 0; z < nz; z++) {
    const wz = oz + z * vs;
    for (let y = 0; y < ny; y++) {
      const wy = oy + y * vs;
      const row = nx * (y + ny * z);
      for (let x = 0; x < nx; x++) {
        if (x === 0 || z === 0 || x === nx - 1 || z === nz - 1 || y === ny - 1) {
          D[row + x] = -1;
          continue;
        }
        const wx = ox + x * vs;
        let d = 2.0;
        for (let ci = 0; ci < C.length; ci++) {
          const c = C[ci];
          if (wx < c.minX || wx > c.maxX || wy < c.minY || wy > c.maxY) continue;
          const pz = wz / c.zs;
          const pax = wx - c.ax;
          const pay = wy - c.ay;
          const paz = pz - c.az;
          const h = clamp((pax * c.bax + pay * c.bay + paz * c.baz) * c.invLen2, 0, 1);
          const dx = pax - c.bax * h;
          const dy = pay - c.bay * h;
          const dz = paz - c.baz * h;
          const e = (sqrt(dx * dx + dy * dy + dz * dz) - (c.ar + (c.br - c.ar) * h)) * c.zs;
          const hh = max(0.45 - abs(d - e), 0) * (1 / 0.45);
          d = min(d, e) - hh * hh * (0.45 * 0.25);
        }
        D[row + x] = -d;
      }
    }
  }
  return surfaceNetsToGeometry(D, nx, ny, nz, ox, oy, oz, vs) ?? meshChunk(1, 2);
}

/**
 * Sunken Timber Shipwreck (`meshShip`):
 * Keel, curved ribs, storm-breached hull planking, stern castle, transom, foremast with yards, broken main mast, bowsprit.
 */
export function meshShip(): T.BufferGeometry {
  rseed(220);
  const m = new UnderwaterMesh();
  const Lh = 17;
  const B = 5.6;
  const Dp = 7.6;
  const hb = (x: number) => B * pow(max(1 - pow(abs(x / Lh), x < 0 ? 3.6 : 2.6), 0), 0.5);
  const dp = (x: number) => Dp * (1 - 0.36 * pow(abs(x / Lh), 2.5));
  const sheer = (x: number) => 0.5 + (x > 0 ? 3.0 : 3.8) * pow(abs(x / Lh), 2.2);
  const pt = (x: number, ph: number, off = 0): Vec3Tuple => {
    const b = hb(x) + off;
    const d = dp(x) + off;
    const s = sheer(x);
    return [x, s - (d + s) * pow(max(cos(ph), 0), 0.66), b * Math.sign(ph) * pow(abs(sin(ph)), 0.8)];
  };
  const out = (p: Vec3Tuple): Vec3Tuple => {
    const l = hypot(p[1] + 0.5, p[2] * 1.3) || 1;
    return [0, (p[1] + 0.5) / l, (p[2] * 1.3) / l];
  };
  const up = (): Vec3Tuple => [0, 1, 0];

  const keel: Vec3Tuple[] = [];
  for (let i = 0; i <= 44; i++) {
    const x = mix(-Lh - 1.0, Lh + 2.4, i / 44);
    const e = max(abs(x) / Lh - 0.78, 0) * 4.2;
    keel.push([x, -dp(clamp(x, -Lh, Lh)) - 0.3 + e * e * e * 4.2, 0]);
  }
  m.sweep(keel, 0.55, 0.95, up);

  for (let x = -Lh + 0.7; x < Lh - 0.3; x += 0.8) {
    const a0 = rnd() < 0.1 ? rr(-0.9, -0.2) : -PI / 2;
    const a1 = rnd() < 0.1 ? rr(0.2, 0.9) : PI / 2;
    const pts: Vec3Tuple[] = [];
    for (let i = 0; i <= 14; i++) pts.push(pt(x, mix(a0, a1, i / 14)));
    m.sweep(pts, 0.24, 0.3, out);
  }

  const holeX = rr(-6, 2);
  const holeS = rnd() < 0.5 ? 1 : -1;
  const BR = [
    [holeX, holeS * 0.8, 3.2, 0.42],
    [7, -holeS * 0.95, 2.4, 0.34],
    [12, holeS * 0.5, 1.7, 0.28],
    [-11, -holeS * 0.55, 2.1, 0.3],
  ];
  const holed = (x: number, ph: number) => {
    for (const h of BR) {
      const a = (x - h[0]) / h[2];
      const b = (ph - h[1]) / h[3];
      if (a * a + b * b < 1 + 0.45 * sin(x * 3.1 + ph * 9)) return true;
    }
    return false;
  };

  const NS = 14;
  const xs: number[] = [];
  for (let x = -Lh + 0.35; x <= Lh - 0.3; x += 0.85) xs.push(x);
  for (let j = 0; j < NS; j++) {
    const p0 = mix(-1.5, 1.5, j / NS);
    const p1 = mix(-1.5, 1.5, (j + 1) / NS);
    const sg = p0 + p1 < 0 ? -1 : 1;
    const lo = sg < 0 ? p1 : p0;
    const hi = sg < 0 ? p0 : p1;
    let pv: number[] | null = null;
    for (const x of xs) {
      const c0 = pt(x, lo, 0.27);
      const c1 = pt(x, hi, 0.14);
      const c2 = pt(x, lo, 0.1);
      const c3 = pt(x, hi, 0.1);
      const cu = [m.v(c0[0], c0[1], c0[2]), m.v(c1[0], c1[1], c1[2]), m.v(c2[0], c2[1], c2[2]), m.v(c3[0], c3[1], c3[2])];
      if (pv && !holed(x - 0.42, (p0 + p1) / 2)) {
        if (sg > 0) {
          m.quad(pv[0], pv[1], cu[1], cu[0]);
          m.quad(pv[2], cu[2], cu[3], pv[3]);
        } else {
          m.quad(pv[0], cu[0], cu[1], pv[1]);
          m.quad(pv[2], pv[3], cu[3], cu[2]);
        }
      }
      pv = cu;
    }
  }

  for (const sgn of [-1, 1] as const) {
    let pts: Vec3Tuple[] = [];
    for (let x = -Lh + 0.6; x <= Lh - 0.6; x += 1) pts.push(pt(x, (sgn * PI) / 2, 0.2));
    m.sweep(pts, 0.3, 0.28, up);
    for (let j = 0; j < 3; j++) {
      pts = [];
      for (let x = -Lh + 0.4; x <= -Lh + 8.5 - j; x += 0.9) {
        pts.push([x, sheer(x) + 0.55 + j * 0.86, sgn * (max(hb(x), 2.6) + 0.15)]);
      }
      m.sweep(pts, 0.82, 0.09, () => [0, 0, sgn]);
    }
  }

  for (let y = -3; y < sheer(-Lh) + 3; y += 0.86) {
    const w = max(1.2, 2.9 * sstep(-4.5, 1.5, y));
    if (rnd() < 0.9) m.sweep([[-Lh + 0.35, y, -w], [-Lh + 0.35, y, w]], 0.82, 0.1, () => [1, 0, 0]);
  }
  for (let x = -Lh + 2; x < Lh - 2; x += rr(1.8, 3.2)) {
    m.sweep([[x, sheer(x) - 0.25, -hb(x)], [x, sheer(x) - 0.2, 0], [x, sheer(x) - 0.25, hb(x)]], 0.26, 0.26, up);
  }
  for (let z = -3.9; z <= 3.9; z += 0.62) {
    let x = -Lh + rr(1, 5);
    while (x < Lh - 4) {
      const x1 = min(x + rr(3, 9), Lh - 3.5);
      if (rnd() < 0.6) {
        const pts: Vec3Tuple[] = [];
        for (let xx = x; xx <= x1; xx += 1) {
          if (hb(xx) > abs(z) + 0.3) pts.push([xx, sheer(xx) - 0.05, z]);
        }
        if (pts.length > 1) m.sweep(pts, 0.56, 0.07, up);
      }
      x = x1 + rr(0.5, 3);
    }
  }

  // Foremast with yards, broken main mast, and bowsprit
  m.sweep([[7, -Dp + 0.6, 0], [7.1, 1, 0], [7.4, 8, 0.3], [7.8, 13.5, 0.8]], k => 0.62 - k * 0.1, k => 0.62 - k * 0.1, () => [1, 0, 0]);
  m.sweep([[7.5, 9.2, -5.2], [7.5, 9.3, 0.3], [7.5, 8.9, 5.6]], 0.26, 0.26, up);
  m.sweep([[7.7, 12.2, -3.2], [7.7, 12.3, 3.6]], 0.2, 0.2, up);
  m.sweep([[-3, -Dp + 0.6, 0], [-3.2, 1, 0.2], [-3.9, 6, 1.0], [-5.2, 9.2, 2.6]], k => 0.74 - k * 0.1, k => 0.74 - k * 0.1, () => [1, 0, 0]);
  m.sweep([[Lh + 1.4, 2.6, 0], [Lh + 8, 5.0, 0.2]], 0.34, 0.34, up);

  return m.toBufferGeometry();
}

/** Spotted Manta Ray with span `u` in `aAux`, paired cephalic horns, and tapered whip tail (`meshManta`). */
export function meshManta(): T.BufferGeometry {
  const m = new UnderwaterMesh();
  const NU = 48;
  const M = 18;
  const rings: number[][] = [];
  for (let j = 0; j <= NU; j++) {
    const u = (j / NU) * 2 - 1;
    const au = abs(u);
    let zl =
      0.52 -
      0.74 * pow(au, 1.35) +
      0.07 * exp(-pow((au - 0.13) / 0.05, 2)) -
      0.05 * exp(-pow(au / 0.05, 2)) -
      0.08 * pow(au, 5);
    const zt = -0.5 + 0.3 * pow(au, 0.8) + 0.02 - 0.08 * pow(au, 5);
    if (zl < zt + 0.004) zl = zt + 0.004;
    const th = 0.08 * pow(1 - au, 1.15) + 0.004 + 0.12 * exp(-pow(u / 0.2, 2));
    const ring: number[] = [];
    for (let k = 0; k < M; k++) {
      const a = (k / M) * TAU;
      ring.push(m.v(u, th * sin(a) * (0.62 + 0.38 * cos(a)), mix(zt, zl, 0.5 + 0.5 * cos(a)), u));
    }
    rings.push(ring);
  }
  for (let j = 0; j < NU; j++) {
    for (let k = 0; k < M; k++) {
      const k2 = (k + 1) % M;
      m.quad(rings[j][k], rings[j + 1][k], rings[j + 1][k2], rings[j][k2]);
    }
  }
  const tail: Vec3Tuple[] = [];
  for (let i = 0; i <= 8; i++) tail.push([0, 0, -0.42 - i * 0.19]);
  const n0 = m.p.length / 3;
  m.tube(tail, k => 0.016 * (1 - k / 9), 4, true);
  for (let k = n0; k < m.aux.length; k++) m.aux[k] = 0;
  for (const sx of [-1, 1] as const) {
    const n1 = m.p.length / 3;
    m.tube(
      [
        [sx * 0.12, -0.02, 0.48],
        [sx * 0.135, -0.05, 0.6],
        [sx * 0.115, -0.09, 0.69],
        [sx * 0.085, -0.125, 0.74],
      ],
      k => 0.045 * (1 - k / 4.4),
      6,
      true,
    );
    for (let k = n1; k < m.aux.length; k++) m.aux[k] = sx * 0.1;
  }
  return m.toBufferGeometry();
}

/** Streamlined 34-vertex schooling fish (`meshFish`). */
export function meshFish(): T.BufferGeometry {
  const m = new UnderwaterMesh();
  const X = [0.5, 0.3, 0.05, -0.22, -0.34];
  const H = [0.01, 0.13, 0.17, 0.09, 0.035];
  const Wd = [0.01, 0.05, 0.065, 0.03, 0.012];
  const rings: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const r: number[] = [];
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU;
      r.push(m.v(X[i], sin(a) * H[i], cos(a) * Wd[i], 1));
    }
    rings.push(r);
  }
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < 6; k++) {
      const k2 = (k + 1) % 6;
      m.quad(rings[i][k], rings[i + 1][k], rings[i + 1][k2], rings[i][k2]);
    }
  }
  const a = m.v(-0.33, 0, 0);
  const b = m.v(-0.56, 0.2, 0);
  const c = m.v(-0.47, 0, 0);
  const d = m.v(-0.56, -0.2, 0);
  m.tri(a, b, c);
  m.tri(a, c, d);
  return m.toBufferGeometry();
}

// ============================================================================
// 4. Archipelago Bathymetry, Regional Surface-Nets Arches/Caves & Biomes
// ============================================================================

export interface UnderwaterBiomeAnchor {
  id: 'coral_lagoon' | 'harbor_dropoff' | 'karst_grotto' | 'outer_reef';
  name: string;
  x: number;
  z: number;
  radius: number;
  purpleWeight: number;
}

export const UNDERWATER_BIOMES: readonly UnderwaterBiomeAnchor[] = [
  { id: 'coral_lagoon', name: 'Coral Lagoon Kelp Cathedral', x: 18, z: 332, radius: 44, purpleWeight: 0.08 },
  { id: 'harbor_dropoff', name: 'Harbor Drop-off Shipwreck Canyon', x: 108, z: -84, radius: 38, purpleWeight: 0.05 },
  { id: 'karst_grotto', name: 'Karst Submerged Bioluminescent Grotto', x: -142, z: -76, radius: 40, purpleWeight: 0.95 },
  { id: 'outer_reef', name: 'Outer Reef Pelagic Archway', x: 156, z: -108, radius: 42, purpleWeight: 0.22 },
];

/**
 * Continuous Archipelago underwater seabed elevation anchored directly to `arenaBathymetry(x, z)`,
 * deepening the 4 signature Abyssal Garden reef biomes while staying safely tucked beneath islands.
 */
export function reefFloorY(x: number, z: number): number {
  const bathy = arenaBathymetry(x, z);
  if (bathy >= ARENA_WATER_Y - 1.2) {
    return ARENA_WATER_Y - 3.2;
  }
  const undul = 1.65 * sin(x * 0.023 + z * 0.019) + 0.95 * cos(x * 0.051 - z * 0.043);
  let y = bathy + undul * sstep(ARENA_WATER_Y - 2.0, ARENA_WATER_Y - 10.0, bathy);

  for (let i = 0; i < UNDERWATER_BIOMES.length; i++) {
    const b = UNDERWATER_BIOMES[i];
    const dx = x - b.x;
    const dz = z - b.z;
    const lim = b.radius * 1.25;
    if (abs(dx) < lim && abs(dz) < lim) {
      const bd = hypot(dx, dz);
      if (bd < lim) y -= sstep(lim, b.radius * 0.45, bd) * 5.2;
    }
  }
  return min(y, ARENA_WATER_Y - 2.2);
}

function buildArchipelagoSeabedMesh(): {
  geometry: T.BufferGeometry;
  floorYAt: (x: number, z: number) => number;
} {
  const N = 72;
  const HALF = 440;
  const vertCount = (N + 1) * (N + 1);
  const pos = new Float32Array(vertCount * 3);
  const nrm = new Float32Array(vertCount * 3);
  const aux = new Float32Array(vertCount).fill(1);
  const idx = new Uint32Array(N * N * 6);

  for (let j = 0; j <= N; j++) {
    const z = ((j / N) * 2 - 1) * HALF;
    for (let i = 0; i <= N; i++) {
      const x = ((i / N) * 2 - 1) * HALF;
      const k = (j * (N + 1) + i) * 3;
      pos[k] = x;
      pos[k + 1] = reefFloorY(x, z);
      pos[k + 2] = z;
    }
  }

  const step = (HALF * 2) / N;
  const invStep = 1 / step;
  const floorYAt = (x: number, z: number): number => {
    const gx = clamp((x + HALF) * invStep, 0, N - 0.001);
    const gz = clamp((z + HALF) * invStep, 0, N - 0.001);
    const ix = gx | 0;
    const iz = gz | 0;
    const fx = gx - ix;
    const fz = gz - iz;
    const r0 = iz * (N + 1) + ix;
    const r1 = r0 + N + 1;
    const y00 = pos[r0 * 3 + 1];
    const y10 = pos[(r0 + 1) * 3 + 1];
    const y01 = pos[r1 * 3 + 1];
    const y11 = pos[(r1 + 1) * 3 + 1];
    return mix(mix(y00, y10, fx), mix(y01, y11, fx), fz);
  };

  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const idx0 = j * (N + 1) + i;
      const xl = pos[(j * (N + 1) + max(0, i - 1)) * 3 + 1];
      const xr = pos[(j * (N + 1) + min(N, i + 1)) * 3 + 1];
      const zd = pos[(max(0, j - 1) * (N + 1) + i) * 3 + 1];
      const zu = pos[(min(N, j + 1) * (N + 1) + i) * 3 + 1];
      const nx = xl - xr;
      const ny = 2 * step;
      const nz = zd - zu;
      const l = sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nrm[idx0 * 3] = nx / l;
      nrm[idx0 * 3 + 1] = ny / l;
      nrm[idx0 * 3 + 2] = nz / l;
    }
  }

  let ptr = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * (N + 1) + i;
      idx[ptr++] = k;
      idx[ptr++] = k + N + 1;
      idx[ptr++] = k + 1;
      idx[ptr++] = k + 1;
      idx[ptr++] = k + N + 1;
      idx[ptr++] = k + N + 2;
    }
  }

  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(pos, 3));
  g.setAttribute('normal', new T.BufferAttribute(nrm, 3));
  g.setAttribute('aAux', new T.BufferAttribute(aux, 1));
  g.setIndex(new T.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return { geometry: g, floorYAt };
}

interface RegionalArchCaveSpec {
  cx: number;
  cz: number;
  archYaw: number;
  archMajor: number;
  archMinor: number;
  mesaDx: number;
  mesaDz: number;
  overhang: number;
  tunnelYaw: number;
  tunnelRadius: number;
}

function smax(a: number, b: number, k: number): number {
  const h = max(k - abs(a - b), 0) / k;
  return max(a, b) + h * h * k * 0.25;
}
const smin = (a: number, b: number, k: number): number => -smax(-a, -b, k);

function seg2Dist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const pax = px - ax;
  const paz = pz - az;
  const bax = bx - ax;
  const baz = bz - az;
  const h = clamp((pax * bax + paz * baz) / max(bax * bax + baz * baz, 1e-4), 0, 1);
  const dx = pax - bax * h;
  const dz = paz - baz * h;
  return sqrt(dx * dx + dz * dz);
}

function seg3Dist(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): number {
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const h = clamp((pax * bax + pay * bay + paz * baz) / max(bax * bax + bay * bay + baz * baz, 1e-4), 0, 1);
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Builds compact regional Surface-Nets Toroidal Rock Arches, Overhanging Reef Canyons,
 * and Swim-Through Caves across all 4 underwater biomes in `< 10 ms` total CPU time.
 */
function buildSculptedReefFormations(): {
  seabedGeometry: T.BufferGeometry;
  archCaveGeometries: T.BufferGeometry[];
  surfaceSpots: number[];
  floorYAt: (x: number, z: number) => number;
} {
  const specs: RegionalArchCaveSpec[] = [
    // Coral Lagoon Cathedral Arch
    { cx: UNDERWATER_BIOMES[0].x, cz: UNDERWATER_BIOMES[0].z, archYaw: 0.55, archMajor: 9.6, archMinor: 2.4, mesaDx: 11, mesaDz: -8, overhang: 3.8, tunnelYaw: -0.6, tunnelRadius: 2.9 },
    // Harbor Drop-off Canyon Wall + Arch
    { cx: UNDERWATER_BIOMES[1].x - 6, cz: UNDERWATER_BIOMES[1].z - 4, archYaw: 1.25, archMajor: 8.6, archMinor: 2.2, mesaDx: -10, mesaDz: 9, overhang: 4.2, tunnelYaw: 0.35, tunnelRadius: 2.7 },
    // Karst Submerged Grotto Overhang + Swim-Through Cave
    { cx: UNDERWATER_BIOMES[2].x, cz: UNDERWATER_BIOMES[2].z, archYaw: -0.45, archMajor: 10.4, archMinor: 2.6, mesaDx: 9, mesaDz: 11, overhang: 5.4, tunnelYaw: 1.1, tunnelRadius: 3.3 },
    // Outer Reef Pelagic Archway
    { cx: UNDERWATER_BIOMES[3].x, cz: UNDERWATER_BIOMES[3].z, archYaw: 0.92, archMajor: 11.2, archMinor: 2.5, mesaDx: -12, mesaDz: -9, overhang: 4.5, tunnelYaw: -0.8, tunnelRadius: 3.2 },
  ];

  const seabed = buildArchipelagoSeabedMesh();
  const archCaveGeometries: T.BufferGeometry[] = [];
  const surfaceSpots: number[] = [];

  const nx = 26;
  const ny = 17;
  const nz = 26;
  const vs = 1.52;
  const D = new Float32Array(nx * ny * nz);
  const safeCeilY = ARENA_WATER_Y - 2.8;

  for (const sp of specs) {
    const baseFloor = seabed.floorYAt(sp.cx, sp.cz);
    const ox = sp.cx - (nx * vs) * 0.5;
    const oy = baseFloor - 3.5;
    const oz = sp.cz - (nz * vs) * 0.5;

    const cs = cos(sp.archYaw);
    const sn = sin(sp.archYaw);
    const tcs = cos(sp.tunnelYaw);
    const tsn = sin(sp.tunnelYaw);
    const archCy = baseFloor + 3.2;
    const mesaAx = sp.cx + sp.mesaDx - 7;
    const mesaAz = sp.cz + sp.mesaDz - 5;
    const mesaBx = sp.cx + sp.mesaDx + 7;
    const mesaBz = sp.cz + sp.mesaDz + 5;
    const mesaTop = min(safeCeilY - 1.4, baseFloor + 13.5);

    const tunY = baseFloor + 3.6;
    const tunAx = sp.cx + sp.mesaDx - tcs * 12;
    const tunAz = sp.cz + sp.mesaDz - tsn * 12;
    const tunBx = sp.cx + sp.mesaDx + tcs * 12;
    const tunBz = sp.cz + sp.mesaDz + tsn * 12;

    for (let z = 0; z < nz; z++) {
      const wz = oz + z * vs;
      for (let y = 0; y < ny; y++) {
        const wy = oy + y * vs;
        const row = nx * (y + ny * z);
        for (let x = 0; x < nx; x++) {
          if (x === 0 || z === 0 || x === nx - 1 || z === nz - 1 || y === 0 || y === ny - 1) {
            D[row + x] = -1;
            continue;
          }
          const wx = ox + x * vs;
          const wxWarp = (vnoise(wx * 0.08 + 11, wy * 0.08, wz * 0.08) - 0.5) * 3.2;
          const wzWarp = (vnoise(wx * 0.08 + 47, wy * 0.08, wz * 0.08) - 0.5) * 3.2;

          // 1. Toroidal rock arch
          const rx0 = wx + wxWarp - sp.cx;
          const ry0 = (wy - archCy) / 1.18;
          const rz0 = wz + wzWarp - sp.cz;
          const rx = cs * rx0 + sn * rz0;
          const rz = -sn * rx0 + cs * rz0;
          const radXY = sqrt(rx * rx + ry0 * ry0) - sp.archMajor;
          const dArch = sp.archMinor - sqrt(radXY * radXY + rz * rz);

          // 2. Overhanging reef canyon mesa
          const yr = clamp((wy - baseFloor) / max(mesaTop - baseFloor, 2), 0, 1.25);
          let eMesa = seg2Dist(wx + wxWarp, wz + wzWarp, mesaAx, mesaAz, mesaBx, mesaBz) - 5.2;
          eMesa -= sp.overhang * sstep(0.3, 0.92, yr) + 2.2 * (1 - yr) * (1 - yr) - 1.6 * sstep(0, 0.5, yr) * (1 - sstep(0.5, 1, yr));
          const dMesa = smin(-eMesa, mesaTop - wy, 2.2);

          let d = smax(dArch, dMesa, 1.5);
          // Sedimentary strata + rock crags
          const strata = 1.35 * (abs(fract(wy * 0.22 + wxWarp * 0.12) - 0.5) - 0.25);
          const crag = (vnoise(wx * 0.26, wy * 0.26, wz * 0.26) - 0.5) * 2.1;
          d += strata + crag;

          // 3. Swim-through cave tunnel carved cleanly through the mesa
          const dTun = seg3Dist(wx + wxWarp * 0.5, wy, wz + wzWarp * 0.5, tunAx, tunY, tunAz, tunBx, tunY + 0.8, tunBz) - sp.tunnelRadius;
          d = smin(d, dTun, 1.6);

          // Strictly stay below boat hulls and below seabedskirt bottom
          d = min(d, safeCeilY - wy);
          D[row + x] = d;
        }
      }
    }

    const g = surfaceNetsToGeometry(D, nx, ny, nz, ox, oy, oz, vs);
    if (g) {
      const pAttr = g.getAttribute('position') as T.BufferAttribute;
      const nAttr = g.getAttribute('normal') as T.BufferAttribute;
      for (let i = 0; i < pAttr.count; i += 3) {
        const nyVal = nAttr.getY(i);
        const pyVal = pAttr.getY(i);
        if (pyVal < safeCeilY - 0.6 && nyVal > -0.45) {
          surfaceSpots.push(
            pAttr.getX(i), pyVal, pAttr.getZ(i),
            nAttr.getX(i), nyVal, nAttr.getZ(i),
          );
        }
      }
      g.computeBoundingSphere();
      archCaveGeometries.push(g);
    }
  }

  return {
    seabedGeometry: seabed.geometry,
    archCaveGeometries,
    surfaceSpots,
    floorYAt: seabed.floorYAt,
  };
}

function buildZoneDataTexture(): T.DataTexture {
  const S = 128;
  const data = new Uint8Array(S * S * 4);
  const grotto = UNDERWATER_BIOMES[2]; // karst_grotto
  const lagoon = UNDERWATER_BIOMES[0]; // coral_lagoon

  for (let j = 0; j < S; j++) {
    const z = ((j + 0.5) / S - 0.5) * 960;
    for (let i = 0; i < S; i++) {
      const x = ((i + 0.5) / S - 0.5) * 960;
      const o = (j * S + i) * 4;

      const dGrotto = hypot(x - grotto.x, z - grotto.z);
      const purple = sstep(grotto.radius * 1.45, grotto.radius * 0.55, dGrotto);

      const nMag = 0.5 + 0.32 * sin(x * 0.041 + z * 0.029) + 0.18 * cos(x * 0.083 - z * 0.067);
      const mag = clamp(max(sstep(0.54, 0.78, nMag) * 0.75, sstep(grotto.radius * 1.1, grotto.radius * 0.4, dGrotto)), 0, 1);

      const dLagoon = hypot(x - lagoon.x, z - lagoon.z);
      const nCanopy = 0.5 + 0.35 * sin(x * 0.027 - z * 0.031) + 0.15 * cos(x * 0.061 + z * 0.053);
      const kelpCanopy = clamp(
        sstep(lagoon.radius * 1.15, lagoon.radius * 0.35, dLagoon) * 0.75 +
          sstep(0.55, 0.76, nCanopy) * 0.35,
        0,
        1,
      );

      const nSand = 0.5 + 0.34 * cos(x * 0.046 + z * 0.039) + 0.16 * sin(x * 0.091 - z * 0.077);
      const sand = sstep(0.38, 0.64, nSand);
      data[o] = round(mag * 255);
      data[o + 1] = round(kelpCanopy * 255);
      data[o + 2] = round(purple * 255);
      data[o + 3] = round(sand * 255);
    }
  }

  const tex = new T.DataTexture(data, S, S, T.RGBAFormat, T.UnsignedByteType);
  tex.wrapS = T.ClampToEdgeWrapping;
  tex.wrapT = T.ClampToEdgeWrapping;
  tex.minFilter = T.LinearFilter;
  tex.magFilter = T.LinearFilter;
  tex.needsUpdate = true;
  tex.name = 'AbyssalZoneMap';
  return tex;
}

// ============================================================================
// 5. Leaf Strip & Billboard Quad Base Geometries
// ============================================================================

function createLeafStripGeometry(rows: number): T.BufferGeometry {
  const positions = new Float32Array(rows * 2 * 3);
  const normals = new Float32Array(rows * 2 * 3);
  const indices: number[] = [];
  for (let r = 0; r < rows; r++) {
    const v = sin((r / (rows - 1)) * (PI * 0.5));
    const lin = r / (rows - 1);
    const b = r * 6;
    positions[b] = -1;
    positions[b + 1] = v;
    positions[b + 2] = lin;
    positions[b + 3] = 1;
    positions[b + 4] = v;
    positions[b + 5] = lin;
    normals[b + 1] = 1;
    normals[b + 4] = 1;
    if (r < rows - 1) {
      const k = r * 2;
      indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(positions, 3));
  g.setAttribute('normal', new T.BufferAttribute(normals, 3));
  g.setIndex(indices);
  return g;
}

function createBillboardQuadGeometry(): T.BufferGeometry {
  const g = new T.BufferGeometry();
  const pos = new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]);
  const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  g.setAttribute('position', new T.BufferAttribute(pos, 3));
  g.setAttribute('normal', new T.BufferAttribute(nrm, 3));
  g.setIndex([0, 1, 2, 1, 3, 2]);
  return g;
}

interface ScalableBatch {
  mesh: T.Mesh<T.InstancedBufferGeometry, T.ShaderMaterial>;
  maxCount: number;
  tierRatios: Record<ArenaQualityTier, number>;
   underwaterOnly?: boolean;
  shadowEligible?: boolean;
}

export interface ArenaUnderwaterWorldOptions {
  quality?: ArenaQualityTier;
  timeOfDay?: ArenaTimeOfDay;
}

export interface ArenaUnderwaterWorldUpdateOptions {
  sunLight?: T.DirectionalLight | null;
  sunDir?: T.Vector3;
  repelPos?: T.Vector3;
  repelRadius?: number;
}

const EMPTY_SURFACE_SCHOOLS: readonly SurfaceFishSchool[] = Object.freeze([]);

function computeInstanceBoundingSphere(
  posStride4: ArrayLike<number>,
  padRadius: number,
  verticalColumnFromAttr?: { arr: ArrayLike<number>; indexInVec4: number },
): T.Sphere {
  const n = Math.floor(posStride4.length / 4);
  if (n <= 0) return new T.Sphere(new T.Vector3(0, ARENA_WATER_Y - 8, 0), 1);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const x = posStride4[o];
    const y = posStride4[o + 1];
    const z = posStride4[o + 2];
    const colH = verticalColumnFromAttr ? Math.max(0, verticalColumnFromAttr.arr[o + verticalColumnFromAttr.indexInVec4] || 0) : 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y + colH > maxY) maxY = y + colH;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  let maxR2 = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const dx = posStride4[o] - cx;
    const dy0 = posStride4[o + 1] - cy;
    const dz = posStride4[o + 2] - cz;
    const r2a = dx * dx + dy0 * dy0 + dz * dz;
    if (r2a > maxR2) maxR2 = r2a;
    if (verticalColumnFromAttr) {
      const colH = Math.max(0, verticalColumnFromAttr.arr[o + verticalColumnFromAttr.indexInVec4] || 0);
      const dy1 = posStride4[o + 1] + colH - cy;
      const r2b = dx * dx + dy1 * dy1 + dz * dz;
      if (r2b > maxR2) maxR2 = r2b;
    }
  }
  return new T.Sphere(new T.Vector3(cx, cy, cz), Math.sqrt(maxR2) + padRadius);
}

function nearestBiomeIndex(x: number, z: number): number {
  let bestIdx = 0;
  let bestD2 = Infinity;
  for (let i = 0; i < UNDERWATER_BIOMES.length; i++) {
    const b = UNDERWATER_BIOMES[i];
    const dx = x - b.x;
    const dz = z - b.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export interface ArenaUnderwaterWorldHandle {
  readonly group: T.Group;
  readonly causticsPass: CausticsSlopePass;
  readonly detailBaker: RockDetailBaker;
  readonly godRays: UnderwaterGodRaysPass;
  readonly causticsTexture: T.Texture;
  readonly detailTexture: T.Texture;
  readonly sharedUniforms: SharedUnderwaterUniforms;
  getSharedOpticsUniforms(): SharedUnderwaterUniforms;
  reefFloorY(x: number, z: number): number;
  getSurfaceFishSchools(time: number): readonly SurfaceFishSchool[];
  attachRenderer(renderer: T.WebGLRenderer): void;
  syncShadowLight(sunLight?: T.DirectionalLight | null, camera?: T.Camera | null): void;
  setWarmupForceShadows(force: boolean): void;
  update(
    time: number,
    renderer: T.WebGLRenderer,
    camera: T.PerspectiveCamera,
    options?: ArenaUnderwaterWorldUpdateOptions,
  ): void;
  renderGodRaysOverlay(
    renderer: T.WebGLRenderer,
    camera: T.PerspectiveCamera,
    depthTexture: T.Texture,
  ): void;
  setQuality(tier: ArenaQualityTier): void;
  setTimeOfDay(tod: ArenaTimeOfDay): void;
  dispose(): void;
}

// ============================================================================
// 6. Main Procedural Underwater World Factory (`buildArenaUnderwaterWorld`)
// ============================================================================

export function buildArenaUnderwaterWorld(
  scene: T.Scene,
  lowOrOptions: boolean | ArenaUnderwaterWorldOptions = false,
): ArenaUnderwaterWorldHandle {
  const initialTier: ArenaQualityTier =
    typeof lowOrOptions === 'boolean'
      ? lowOrOptions
        ? 'low'
        : 'high'
      : (lowOrOptions.quality ?? 'high');
  const initialTod: ArenaTimeOfDay =
    typeof lowOrOptions === 'boolean' ? 'daylight' : (lowOrOptions.timeOfDay ?? 'daylight');

  const group = new T.Group();
  group.name = 'AbyssalGardenUnderwaterWorld';
  scene.add(group);

  const disposablesGeo: T.BufferGeometry[] = [];
  const disposablesMat: T.Material[] = [];
  const batches: ScalableBatch[] = [];

  const causticsPass = new CausticsSlopePass(initialTier);
  const detailBaker = new RockDetailBaker(initialTier);
  const zoneMapTex = buildZoneDataTexture();
  const fallbackShadow = createFallbackShadowTarget();

  const shared: SharedUnderwaterUniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new T.Vector3(-0.58, 0.75, 0.40).normalize() },
    uSunTint: { value: new T.Vector3(1, 1, 1) },
    uGrottoBoost: { value: 0.06 },
    uQualityLevel: { value: tierLevel(initialTier) },
    uWidthScale: { value: 1 },
    uFarScale: { value: 1 },
    uCamRight: { value: new T.Vector3(1, 0, 0) },
    uCamUp: { value: new T.Vector3(0, 1, 0) },
    uCamFwd: { value: new T.Vector3(0, 0, -1) },
    uRepelPos: { value: new T.Vector4(0, 100, 0, 4.5) },
    tWater: { value: causticsPass.texture },
    tDetail: { value: detailBaker.texture },
    tZoneMap: { value: zoneMapTex },
    tShadow: { value: fallbackShadow.depthTexture },
    uShadowMatrix: { value: new T.Matrix4() },
    uShadowTexel: { value: 1 / 2048 },
    uShadowEnabled: { value: 0 },
  };
  applyTimeOfDayToUnderwaterUniforms(shared, initialTod);

  const godRays = new UnderwaterGodRaysPass(
    initialTier,
    causticsPass.texture,
    zoneMapTex,
    fallbackShadow.depthTexture,
  );
  const sceneUserData = scene.userData as Record<string, unknown>;
  sceneUserData.__ecArenaGodRaysPass = godRays;
  sceneUserData.__ecArenaUnderwaterOptics = shared;
  const shadowState = {
    depthTex: fallbackShadow.depthTexture as T.Texture | null,
    matrix: shared.uShadowMatrix.value,
    enabled: false,
  };
  sceneUserData.__ecArenaShadowState = shadowState;

  // --- A. Sculpted Seabed (non-shadow-casting floor) + 4 Regional Frustum-Culled Arch/Cave Meshes (`mat = 0`)
  const { seabedGeometry, archCaveGeometries, surfaceSpots, floorYAt } = buildSculptedReefFormations();
  disposablesGeo.push(seabedGeometry, ...archCaveGeometries);
  const reefTerrainMat = createUnderwaterSolidMaterial(shared, { instanced: false, matId: 0, seed: 0.17 });
  disposablesMat.push(reefTerrainMat);

  const seabedMesh = new T.Mesh(seabedGeometry, reefTerrainMat);
  seabedMesh.name = 'AbyssalReefSeabed';
  seabedMesh.frustumCulled = true;
  seabedMesh.receiveShadow = true;
  seabedMesh.castShadow = false;
  group.add(seabedMesh);

  const archCaveMeshes: T.Mesh[] = [];
  for (let bi = 0; bi < archCaveGeometries.length; bi++) {
    const archMesh = new T.Mesh(archCaveGeometries[bi], reefTerrainMat);
    archMesh.name = `AbyssalReefArchCave_${bi}`;
    archMesh.frustumCulled = true;
    archMesh.receiveShadow = true;
    archMesh.castShadow = initialTier === 'ultra' || initialTier === 'high';
    group.add(archMesh);
    archCaveMeshes.push(archMesh);
  }

  // --- B. Submerged Echo Whale Stone Fluke Sanctuary (`meshFluke`, `mat = 2`) in Coral Lagoon
  const flukeGeo = meshFluke();
  flukeGeo.computeBoundingSphere();
  disposablesGeo.push(flukeGeo);
  const lagoon = UNDERWATER_BIOMES[0];
  const flukeQuat = new T.Quaternion().setFromEuler(new T.Euler(-0.26, 0.95, 0.14));
  const flukeMat = createUnderwaterSolidMaterial(shared, {
    instanced: false,
    matId: 2,
    seed: 0.3,
    texScale: 1,
    quat: flukeQuat,
  });
  disposablesMat.push(flukeMat);
  const flukeMesh = new T.Mesh(flukeGeo, flukeMat);
  flukeMesh.name = 'AbyssalEchoWhaleFlukeSanctuary';
  flukeMesh.position.set(lagoon.x - 4, reefFloorY(lagoon.x - 4, lagoon.z - 3) + 0.6, lagoon.z - 3);
  flukeMesh.quaternion.copy(flukeQuat);
  flukeMesh.scale.setScalar(0.82);
  flukeMesh.frustumCulled = true;
  flukeMesh.castShadow = initialTier !== 'low';
  flukeMesh.receiveShadow = true;
  group.add(flukeMesh);

  // --- C. Sunken Timber Shipwreck (`meshShip`, `mat = 3`) in Harbor Drop-off Canyon
  const shipGeo = meshShip();
  shipGeo.computeBoundingSphere();
  disposablesGeo.push(shipGeo);
  const dropoff = UNDERWATER_BIOMES[1];
  const shipQuat = new T.Quaternion().setFromEuler(new T.Euler(0.26, -1.18, -0.11));
  const shipMat = createUnderwaterSolidMaterial(shared, {
    instanced: false,
    matId: 3,
    seed: 0.5,
    texScale: 1,
    quat: shipQuat,
  });
  disposablesMat.push(shipMat);
  const shipMesh = new T.Mesh(shipGeo, shipMat);
  shipMesh.name = 'AbyssalSunkenShipwreck';
  shipMesh.position.set(dropoff.x + 6, min(reefFloorY(dropoff.x + 6, dropoff.z + 4) + 3.8, ARENA_WATER_Y - 16.5), dropoff.z + 4);
  shipMesh.quaternion.copy(shipQuat);
  shipMesh.scale.setScalar(0.76);
  shipMesh.frustumCulled = true;
  shipMesh.castShadow = initialTier !== 'low';
  shipMesh.receiveShadow = true;
  group.add(shipMesh);

  // Helper to wrap a base BufferGeometry + per-instance vec4 streams into an InstancedBufferGeometry Mesh
  const makeInstancedBatch = (
    name: string,
    baseGeo: T.BufferGeometry,
    mat: T.ShaderMaterial,
    attrs: { name: string; data: Float32Array; itemSize: number }[],
    tierRatios: Record<ArenaQualityTier, number>,
    opts: {
      depthMat?: T.ShaderMaterial;
      underwaterOnly?: boolean;
      renderOrder?: number;
      boundingSphere?: T.Sphere | null;
      cameraWrapped?: boolean;
    } = {},
  ): ScalableBatch => {
    const ig = new T.InstancedBufferGeometry();
    ig.index = baseGeo.index;
    for (const attrName of Object.keys(baseGeo.attributes)) {
      ig.setAttribute(attrName, baseGeo.attributes[attrName]);
    }
    let maxCount = 0;
    for (const a of attrs) {
      ig.setAttribute(a.name, new T.InstancedBufferAttribute(a.data, a.itemSize));
      maxCount = Math.floor(a.data.length / a.itemSize);
    }
    ig.instanceCount = Math.floor(maxCount * tierRatios[initialTier]);
    if (opts.boundingSphere) {
      ig.boundingSphere = opts.boundingSphere;
    }
    disposablesGeo.push(ig);

    const mesh = new T.Mesh(ig, mat);
    mesh.name = name;
    mesh.frustumCulled = !opts.cameraWrapped && Boolean(opts.boundingSphere);
    if (opts.renderOrder !== undefined) mesh.renderOrder = opts.renderOrder;
    if (opts.depthMat) {
      mesh.customDepthMaterial = opts.depthMat;
      mesh.castShadow = initialTier === 'ultra' || initialTier === 'high';
    }
    group.add(mesh);
    const batch: ScalableBatch = {
      mesh,
      maxCount,
      tierRatios,
      underwaterOnly: opts.underwaterOnly,
      shadowEligible: !!opts.depthMat,
    };
    batches.push(batch);
    return batch;
  };

  const solidInstMat = createUnderwaterSolidMaterial(shared, { instanced: true });
  const solidDepthMat = createUnderwaterSolidDepthMaterial(shared);
  disposablesMat.push(solidInstMat, solidDepthMat);

  // --- D. Corals, Sponges, Regional Biome Boulders & Pebbles (`meshCoral`, `meshLathe`, `meshTubes`, `meshChunk`)
  const seaFanBase = meshCoral(0);
  const staghornBase = meshCoral(1);
  const barrelSpongeBase = meshLathe([[0.26, 0, 0.3], [0.42, 0.32, 0.65], [0.46, 0.72, 0.9], [0.36, 1.05, 1.0], [0.22, 0.98, 0.25], [0.16, 0.45, 0.08]], 14, 0.22, 9);
  const vaseSpongeBase = meshLathe([[0.16, 0, 0.3], [0.22, 0.45, 0.7], [0.34, 1.05, 0.95], [0.38, 1.32, 1.0], [0.28, 1.24, 0.2], [0.14, 0.55, 0.06]], 12, 0.18, 6);
  const pipeSpongeBase = meshTubes();
  const boulderBaseA = meshChunk(1, 2);
  const boulderBaseB = meshChunk(2, 2);
  const pebbleBase = meshChunk(5, 1);
  disposablesGeo.push(
    seaFanBase, staghornBase, barrelSpongeBase, vaseSpongeBase,
    pipeSpongeBase, boulderBaseA, boulderBaseB, pebbleBase,
  );

  type SolidBucket = { a: number[]; b: number[]; c: number[] };
  const makeSolidBucket = (): SolidBucket => ({ a: [], b: [], c: [] });

  const pushSolidInstance = (
    bucket: SolidBucket,
    x: number, y: number, z: number, sc: number,
    q: Quat4, matId: number, seed: number, fadeDist = 0, bobAmp = 0,
  ) => {
    bucket.a.push(x, y, z, sc);
    bucket.b.push(q[0], q[1], q[2], q[3]);
    bucket.c.push(matId, seed, fadeDist, bobAmp);
  };

  const fanInst = makeSolidBucket();
  const stagInst = makeSolidBucket();
  const barrelByBiome = UNDERWATER_BIOMES.map(() => makeSolidBucket());
  const vaseByBiome = UNDERWATER_BIOMES.map(() => makeSolidBucket());
  const pipeByBiome = UNDERWATER_BIOMES.map(() => makeSolidBucket());
  const boulderAByBiome = UNDERWATER_BIOMES.map(() => makeSolidBucket());
  const boulderBByBiome = UNDERWATER_BIOMES.map(() => makeSolidBucket());
  const pebbleInst = makeSolidBucket();
  const bubbleVents: Vec3Tuple[] = [];

  rseed(6);
  const spotCount = Math.floor(surfaceSpots.length / 6);
  for (let n = 0; n < 420 && spotCount > 0; n++) {
    const idx = ((rnd() * spotCount) | 0) * 6;
    const sx = surfaceSpots[idx];
    const sy = surfaceSpots[idx + 1];
    const sz = surfaceSpots[idx + 2];
    const nx = surfaceSpots[idx + 3];
    const ny = surfaceSpots[idx + 4];
    const nz = surfaceSpots[idx + 5];
    if (sy > ARENA_WATER_Y - 3.2) continue;
    const isCoral = ny > 0.72 || rnd() < 0.48;
    const ux = nx;
    const uy = ny + (isCoral ? 0.85 : 1.05);
    const uz = nz;
    const ul = hypot(ux, uy, uz) || 1;
    const q = qMul(qFromY(ux / ul, uy / ul, uz / ul), qAxis(0, 1, 0, rnd() * TAU));
    const sc = isCoral ? rr(0.65, 1.65) : rr(0.45, 1.15);
    const sd = rnd();
    if (isCoral) {
      pushSolidInstance(rnd() < 0.45 ? fanInst : stagInst, sx, sy - 0.08 * sc, sz, sc, q, 5, sd, 125, 0);
    } else {
      const bi = nearestBiomeIndex(sx, sz);
      const pick = rnd();
      const target = pick < 0.4 ? barrelByBiome[bi] : pick < 0.72 ? vaseByBiome[bi] : pipeByBiome[bi];
      pushSolidInstance(target, sx, sy - 0.08 * sc, sz, sc, q, 4, sd, 125, 0);
      if (rnd() < 0.08 && bubbleVents.length < 28) bubbleVents.push([sx, sy + 0.35, sz]);
    }
  }

  // Scatter coral & sponge gardens across the 4 biome basins and shallow island reefs
  rseed(7);
  for (let bi = 0; bi < UNDERWATER_BIOMES.length; bi++) {
    const biome = UNDERWATER_BIOMES[bi];
    for (let i = 0; i < 150; i++) {
      const a = rnd() * TAU;
      const r = sqrt(rnd()) * biome.radius * 1.1;
      const x = biome.x + cos(a) * r;
      const z = biome.z + sin(a) * r;
      const y = floorYAt(x, z);
      if (y > ARENA_WATER_Y - 3.0) continue;
      const q = qAxis(0, 1, 0, rnd() * TAU);
      const isCoral = rnd() < 0.56;
      const sc = isCoral ? rr(0.7, 1.75) : rr(0.5, 1.35);
      if (isCoral) {
        pushSolidInstance(rnd() < 0.42 ? fanInst : stagInst, x, y - 0.08, z, sc, q, 5, rnd(), 130, 0);
      } else {
        const pick = rnd();
        const target = pick < 0.4 ? barrelByBiome[bi] : pick < 0.72 ? vaseByBiome[bi] : pipeByBiome[bi];
        pushSolidInstance(target, x, y - 0.08, z, sc, q, 4, rnd(), 130, 0);
      }
    }
  }

  // Shallow turquoise coral rings around islands so boaters/swimmers see vibrant reefs from above!
  for (const isl of arenaLayout.islands as readonly ArenaIslandSpec[]) {
    const ringCount = isl.id === 'commons' ? 68 : 30;
    for (let i = 0; i < ringCount; i++) {
      const a = (i / ringCount) * TAU + rr(-0.08, 0.08);
      const off = rr(2.8, 10.5);
      const rad = arenaShoreRadius(isl, a) + off;
      const x = isl.x + cos(a) * rad;
      const z = isl.z + sin(a) * rad;
      const y = floorYAt(x, z);
      if (y > ARENA_WATER_Y - 2.35) continue;
      const q = qAxis(0, 1, 0, rnd() * TAU);
      const sc = rr(0.65, 1.45);
      pushSolidInstance(i % 3 === 0 ? fanInst : stagInst, x, y - 0.08, z, sc, q, 5, rnd(), 135, 0);
    }
  }

  // Ground & gently bobbing abyssal boulders partitioned per biome + seafloor pebbles (`rseed(8..11)`)
  rseed(8);
  for (let bi = 0; bi < UNDERWATER_BIOMES.length; bi++) {
    const biome = UNDERWATER_BIOMES[bi];
    for (let i = 0; i < 65; i++) {
      const a = rnd() * TAU;
      const r = sqrt(rnd()) * biome.radius * 1.25;
      const x = biome.x + cos(a) * r;
      const z = biome.z + sin(a) * r;
      const floorY = floorYAt(x, z);
      const floating = rnd() < 0.22;
      const sc = floating ? rr(0.6, 1.8) : rr(0.45, 2.2);
      const y = floating ? min(ARENA_WATER_Y - 5.5 - sc, floorY + rr(4.5, 10.5)) : floorY - sc * 0.22;
      const bob = floating ? rr(0.12, 0.34) : 0;
      pushSolidInstance(i % 2 === 0 ? boulderAByBiome[bi] : boulderBByBiome[bi], x, y, z, sc, qRand(), 1, rnd(), 145, bob);
    }
  }

  rseed(11);
  for (let i = 0; i < 1600; i++) {
    const a = rnd() * TAU;
    const r = 35 + sqrt(rnd()) * 165;
    const x = cos(a) * r;
    const z = sin(a) * r;
    const y = floorYAt(x, z);
    if (y > ARENA_WATER_Y - 2.5) continue;
    const sc = 0.08 + 0.32 * pow(rnd(), 2);
    pushSolidInstance(pebbleInst, x, y - sc * 0.2, z, sc, qRand(), 1, rnd(), 56, 0);
  }

  const propTiers: Record<ArenaQualityTier, number> = { ultra: 1, high: 0.82, balanced: 0.56, low: 0.32 };
  const makeSolidBatch = (
    name: string,
    geo: T.BufferGeometry,
    inst: SolidBucket,
    castShad: boolean,
    padRadius = 4.0,
    ratios = propTiers,
  ) => {
    if (inst.a.length === 0) return;
    const aArr = new Float32Array(inst.a);
    makeInstancedBatch(
      name,
      geo,
      solidInstMat,
      [
        { name: 'aInstA', data: aArr, itemSize: 4 },
        { name: 'aInstB', data: new Float32Array(inst.b), itemSize: 4 },
        { name: 'aInstC', data: new Float32Array(inst.c), itemSize: 4 },
      ],
      ratios,
      {
        depthMat: castShad ? solidDepthMat : undefined,
        boundingSphere: computeInstanceBoundingSphere(aArr, padRadius),
      },
    );
  };

  makeSolidBatch('AbyssalSeaFans', seaFanBase, fanInst, false, 3.8);
  makeSolidBatch('AbyssalStaghornCorals', staghornBase, stagInst, false, 3.8);
  for (let bi = 0; bi < UNDERWATER_BIOMES.length; bi++) {
    makeSolidBatch(`AbyssalBarrelSponges_${bi}`, barrelSpongeBase, barrelByBiome[bi], true, 3.2);
    makeSolidBatch(`AbyssalVaseSponges_${bi}`, vaseSpongeBase, vaseByBiome[bi], false, 3.2);
    makeSolidBatch(`AbyssalPipeSponges_${bi}`, pipeSpongeBase, pipeByBiome[bi], false, 3.2);
    makeSolidBatch(`AbyssalBouldersA_${bi}`, boulderBaseA, boulderAByBiome[bi], true, 5.2);
    makeSolidBatch(`AbyssalBouldersB_${bi}`, boulderBaseB, boulderBByBiome[bi], true, 5.2);
  }
  makeSolidBatch('AbyssalSeafloorPebbles', pebbleBase, pebbleInst, false, 2.0, {
    ultra: 1, high: 0.75, balanced: 0.45, low: 0.2,
  });

  // --- E. Regional Frustum-Culled Giant Kelp Forests (`9/5/3`-row LOD strips), Seagrass & Magenta Carpets
  const leafStrip9 = createLeafStripGeometry(9);
  const leafStrip5 = createLeafStripGeometry(5);
  const leafStrip3 = createLeafStripGeometry(3);
  disposablesGeo.push(leafStrip9, leafStrip5, leafStrip3);

  const leafMatHero = createUnderwaterLeafMaterial(shared, 155);
  const leafMatMid = createUnderwaterLeafMaterial(shared, 135);
  const leafMatCarpet = createUnderwaterLeafMaterial(shared, 95);
  const leafDepthMat = createUnderwaterLeafDepthMaterial(shared, 155);
  disposablesMat.push(leafMatHero, leafMatMid, leafMatCarpet, leafDepthMat);

  type LeafBucket = { a: number[]; b: number[]; c: number[] };
  type GlintBucket = { a: number[]; b: number[] };
  const kelpHeroByBiome: LeafBucket[] = UNDERWATER_BIOMES.map(() => ({ a: [], b: [], c: [] }));
  const kelpMidByBiome: LeafBucket[] = UNDERWATER_BIOMES.map(() => ({ a: [], b: [], c: [] }));
  const carpetByBiome: LeafBucket[] = UNDERWATER_BIOMES.map(() => ({ a: [], b: [], c: [] }));
  const glintByBiome: GlintBucket[] = UNDERWATER_BIOMES.map(() => ({ a: [], b: [] }));

  const pushLeaf = (
    dst: LeafBucket,
    x: number, y: number, z: number, len: number,
    yaw: number, tilt: number, wid: number, hA: number,
    typeId: number, s1: number, s2: number, bend: number,
  ) => {
    dst.a.push(x, y, z, len);
    dst.b.push(yaw, tilt, wid, hA);
    dst.c.push(typeId, s1, s2, bend);
  };

  const spawnKelpColumn = (
    biomeIdx: number,
    x: number,
    y: number,
    z: number,
    H: number,
    kind: 0 | 1 | 2,
    hero9Row: boolean,
  ) => {
    const target = hero9Row ? kelpHeroByBiome[biomeIdx] : kelpMidByBiome[biomeIdx];
    const glintDst = glintByBiome[biomeIdx];
    const strands = 2 + (rnd() < 0.55 ? 1 : 0);
    const ph = rnd() * TAU;
    const tw = rr(0.1, 0.28);
    const sr = rr(0.2, 0.5);
    const sc = rr(0.8, 1.2);
    const la = rnd() * TAU;
    const lm = rr(0, 0.1);
    const stemAt = (s: number, h: number): Vec3Tuple => {
      const a = ph + (s * TAU) / strands + h * tw;
      const r = sr * (1 - (0.6 * h) / H);
      const ln = (lm * h * h) / H;
      return [x + cos(a) * r + cos(la) * ln, z + sin(a) * r + sin(la) * ln, a];
    };
    for (let s = 0; s < strands; s++) {
      for (let h = 0; h < H - 1; h += 1.8) {
        const p = stemAt(s, h);
        pushLeaf(target, p[0], y + h, p[1], 2.1, p[2] + PI / 2, 0.1, 0.17, h, 1, rnd(), rnd(), 0.3);
      }
    }
    const frondCount = Math.floor(H * 14);
    for (let i = 0; i < frondCount; i++) {
      const t = pow(rnd(), 0.9);
      const h = t * H;
      const p = stemAt((rnd() * strands) | 0, h);
      const L = ((0.55 + 0.75 * rnd() * rnd()) * (1 - 0.5 * t * t) * sc + 0.25) * (kind === 1 ? 1.22 : 1.14);
      const tilt = mix(rr(0.4, 1.0), rr(0.15, 0.45), t);
      const type = kind === 1 ? (rnd() < 0.8 ? 3 : 4) : kind === 2 ? (rnd() < 0.5 ? 4 : 0) : 0;
      const wid = L * (kind === 1 ? rr(0.1, 0.14) : rr(0.16, 0.22)) + 0.03;
      pushLeaf(target, p[0], y + h, p[1], L, rnd() * TAU, tilt, wid, h, type, rnd(), rnd(), rr(0.38, 0.95));
    }
    const glintsN = Math.floor(H * 7);
    for (let i = 0; i < glintsN; i++) {
      const h = rnd() * H;
      const a = rnd() * TAU;
      const r = rr(0.15, 0.8) * (1 - (0.5 * h) / H);
      const ln = (lm * h * h) / H;
      glintDst.a.push(x + cos(a) * r + cos(la) * ln, y + h, z + sin(a) * r + sin(la) * ln, h);
      glintDst.b.push(rnd(), kind === 1 ? rnd() : rnd() * 0.6, rr(0.02, 0.05), 0);
    }
  };

  // Kelp Cathedral in Coral Lagoon + groves across all 4 underwater biomes (`rseed(1..2)`)
  rseed(1);
  const kelpCenters: [number, number, number, number, 0 | 1 | 2, number][] = [
    [0, lagoon.x, lagoon.z, 34, 0, 44],
    [1, dropoff.x - 8, dropoff.z + 10, 26, 2, 22],
    [2, UNDERWATER_BIOMES[2].x + 8, UNDERWATER_BIOMES[2].z - 6, 28, 1, 24],
    [3, UNDERWATER_BIOMES[3].x + 10, UNDERWATER_BIOMES[3].z + 8, 30, 0, 24],
  ];
  const occKelp = new Set<number>();
  for (const [biomeIdx, cx, cz, rad, kind, count] of kelpCenters) {
    let spawned = 0;
    for (let tries = 0; tries < count * 8 && spawned < count; tries++) {
      const a = rnd() * TAU;
      const r = (0.18 + 0.82 * sqrt(rnd())) * rad;
      const x = cx + cos(a) * r;
      const z = cz + sin(a) * r;
      if (hypot(x - flukeMesh.position.x, z - flukeMesh.position.z) < 6.5) continue;
      if (hypot(x - shipMesh.position.x, z - shipMesh.position.z) < 11.5) continue;
      const cellKey = floor(x / 2.6) * 4096 + floor(z / 2.6);
      if (occKelp.has(cellKey)) continue;
      const y = floorYAt(x, z);
      const waterCol = ARENA_WATER_Y - y;
      if (waterCol < 8.5) continue;
      occKelp.add(cellKey);
      const H = min(waterCol - rr(1.2, 3.8), rr(12, 26));
      spawnKelpColumn(biomeIdx, x, y - 0.25, z, H, kind, spawned < count * 0.45);
      spawned++;
    }
  }

  // Sea-emerald ribbon seagrass (`type = 2`) & hanging crimson cavern fronds (`type = 6`) (`rseed(3)`)
  rseed(3);
  for (let i = 0; i < 380; i++) {
    const bi = i % UNDERWATER_BIOMES.length;
    const biome = UNDERWATER_BIOMES[bi];
    const a = rnd() * TAU;
    const r = sqrt(rnd()) * biome.radius * 1.15;
    const x = biome.x + cos(a) * r;
    const z = biome.z + sin(a) * r;
    const y = floorYAt(x, z);
    if (y > ARENA_WATER_Y - 2.6) continue;
    const blades = 7 + ((rnd() * 8) | 0);
    const spType = biome.id === 'karst_grotto' && rnd() < 0.55 ? 3 : 2;
    for (let j = 0; j < blades; j++) {
      const ba = rnd() * TAU;
      const br = rnd() * 0.55;
      pushLeaf(
        kelpMidByBiome[bi],
        x + cos(ba) * br,
        y - 0.12,
        z + sin(ba) * br,
        rr(1.1, 2.8),
        ba,
        rr(0.08, 0.62),
        rr(0.14, 0.26),
        2.0,
        spType,
        rnd(),
        rnd(),
        rr(0.3, 0.8),
      );
    }
  }

  // Hanging crimson fronds (`type = 6`) under overhanging arches & caves
  for (let i = 0; i < spotCount; i += 2) {
    const ny = surfaceSpots[i * 6 + 4];
    if (ny > -0.32) continue;
    const sx = surfaceSpots[i * 6];
    const sy = surfaceSpots[i * 6 + 1];
    const sz = surfaceSpots[i * 6 + 2];
    const bi = nearestBiomeIndex(sx, sz);
    const n = 5 + ((rnd() * 7) | 0);
    for (let j = 0; j < n; j++) {
      pushLeaf(
        kelpMidByBiome[bi],
        sx + rr(-0.5, 0.5),
        sy + 0.15,
        sz + rr(-0.5, 0.5),
        rr(0.9, 2.6),
        rnd() * TAU,
        PI - rr(0.04, 0.38),
        rr(0.09, 0.17),
        0,
        6,
        rnd(),
        rnd(),
        rr(0.3, 0.6),
      );
    }
  }

  // Glowing purple grotto magenta carpets (`type = 5`) & cyan reef turf (`type = 7`) (`rseed(4)`)
  rseed(4);
  for (let i = 0; i < 4200; i++) {
    const inGrotto = i < 2600;
    const bi = inGrotto ? 2 : i % UNDERWATER_BIOMES.length;
    const anchor = UNDERWATER_BIOMES[bi];
    const a = rnd() * TAU;
    const r = sqrt(rnd()) * anchor.radius * (inGrotto ? 1.05 : 0.9);
    const x = anchor.x + cos(a) * r;
    const z = anchor.z + sin(a) * r;
    const y = floorYAt(x, z);
    if (y > ARENA_WATER_Y - 3.0) continue;
    const type = inGrotto && rnd() < 0.78 ? 5 : 7;
    const tufts = 2 + ((rnd() * 2) | 0);
    const baseYaw = rnd() * TAU;
    for (let j = 0; j < tufts; j++) {
      pushLeaf(
        carpetByBiome[bi],
        x + rr(-0.15, 0.15),
        y - 0.04,
        z + rr(-0.15, 0.15),
        type === 5 ? rr(0.14, 0.36) : rr(0.24, 0.62),
        baseYaw + (j * TAU) / tufts + rr(-0.3, 0.3),
        rr(0.12, 0.8),
        rr(0.045, 0.09),
        0,
        type,
        rnd(),
        rnd(),
        rr(0.3, 0.75),
      );
    }
    if (inGrotto && rnd() < 0.14) {
      glintByBiome[bi].a.push(x, y + rr(0.08, 0.25), z, 0);
      glintByBiome[bi].b.push(rnd(), 0.82 + rnd() * 0.18, rr(0.012, 0.024), 0);
    }
  }

  const leafTiers: Record<ArenaQualityTier, number> = { ultra: 1, high: 0.76, balanced: 0.48, low: 0.24 };
  for (let bi = 0; bi < UNDERWATER_BIOMES.length; bi++) {
    if (kelpHeroByBiome[bi].a.length > 0) {
      const aArr = new Float32Array(kelpHeroByBiome[bi].a);
      makeInstancedBatch(
        `AbyssalKelpHero9Row_${bi}`,
        leafStrip9,
        leafMatHero,
        [
          { name: 'aInstA', data: aArr, itemSize: 4 },
          { name: 'aInstB', data: new Float32Array(kelpHeroByBiome[bi].b), itemSize: 4 },
          { name: 'aInstC', data: new Float32Array(kelpHeroByBiome[bi].c), itemSize: 4 },
        ],
        leafTiers,
        {
          depthMat: leafDepthMat,
          boundingSphere: computeInstanceBoundingSphere(aArr, 6.0),
        },
      );
    }

    if (kelpMidByBiome[bi].a.length > 0) {
      const aArr = new Float32Array(kelpMidByBiome[bi].a);
      makeInstancedBatch(
        `AbyssalKelpAndRibbon5Row_${bi}`,
        leafStrip5,
        leafMatMid,
        [
          { name: 'aInstA', data: aArr, itemSize: 4 },
          { name: 'aInstB', data: new Float32Array(kelpMidByBiome[bi].b), itemSize: 4 },
          { name: 'aInstC', data: new Float32Array(kelpMidByBiome[bi].c), itemSize: 4 },
        ],
        leafTiers,
        { boundingSphere: computeInstanceBoundingSphere(aArr, 5.5) },
      );
    }

    if (carpetByBiome[bi].a.length > 0) {
      const aArr = new Float32Array(carpetByBiome[bi].a);
      makeInstancedBatch(
        `AbyssalMagentaCarpet3Row_${bi}`,
        leafStrip3,
        leafMatCarpet,
        [
          { name: 'aInstA', data: aArr, itemSize: 4 },
          { name: 'aInstB', data: new Float32Array(carpetByBiome[bi].b), itemSize: 4 },
          { name: 'aInstC', data: new Float32Array(carpetByBiome[bi].c), itemSize: 4 },
        ],
        { ultra: 1, high: 0.75, balanced: 0.45, low: 0.2 },
        {
          underwaterOnly: true,
          boundingSphere: computeInstanceBoundingSphere(aArr, 2.5),
        },
      );
    }
  }

  // --- F. Billboard Quad Batches: Regional Twinkling Glints, Wobble-Bubbles & 9,000 Marine Snow Motes
  const quadBase = createBillboardQuadGeometry();
  disposablesGeo.push(quadBase);

  const glintMat = createUnderwaterGlintMaterial(shared);
  const bubbleMat = createUnderwaterBubbleMaterial(shared);
  const snowMat = createUnderwaterSnowMaterial(shared);
  disposablesMat.push(glintMat, bubbleMat, snowMat);

  for (let bi = 0; bi < UNDERWATER_BIOMES.length; bi++) {
    if (glintByBiome[bi].a.length > 0) {
      const aArr = new Float32Array(glintByBiome[bi].a);
      makeInstancedBatch(
        `AbyssalKelpGlints_${bi}`,
        quadBase,
        glintMat,
        [
          { name: 'aGlintA', data: aArr, itemSize: 4 },
          { name: 'aGlintB', data: new Float32Array(glintByBiome[bi].b), itemSize: 4 },
        ],
        { ultra: 1, high: 0.75, balanced: 0.42, low: 0.2 },
        {
          underwaterOnly: true,
          renderOrder: 4,
          boundingSphere: computeInstanceBoundingSphere(aArr, 4.0),
        },
      );
    }
  }

  // Hydrothermal / reef bubble vents (`rseed(13)`)
  rseed(13);
  for (const b of UNDERWATER_BIOMES) {
    bubbleVents.push(
      [b.x + 3, floorYAt(b.x + 3, b.z - 2), b.z - 2],
      [b.x - 5, floorYAt(b.x - 5, b.z + 4), b.z + 4],
    );
  }
  bubbleVents.push(
    [flukeMesh.position.x + 2.2, flukeMesh.position.y + 0.4, flukeMesh.position.z - 1.5],
    [shipMesh.position.x - 3.5, shipMesh.position.y - 1.2, shipMesh.position.z + 1.0],
  );
  const bubA: number[] = [];
  const bubB: number[] = [];
  for (const v of bubbleVents) {
    const count = 65 + ((rnd() * 45) | 0);
    const colH = max(2.5, ARENA_WATER_Y - v[1] - 0.15);
    for (let i = 0; i < count; i++) {
      const sz = rnd() < 0.24 ? rr(0.09, 0.26) : rr(0.025, 0.075);
      bubA.push(v[0] + rr(-0.32, 0.32), v[1], v[2] + rr(-0.32, 0.32), sz);
      bubB.push(rnd(), rr(1.1, 2.3) * (0.6 + sz * 3), colH, rr(0.05, 0.16));
    }
  }
  const bubAArr = new Float32Array(bubA);
  const bubBArr = new Float32Array(bubB);
  makeInstancedBatch(
    'AbyssalWobbleBubbles',
    quadBase,
    bubbleMat,
    [
      { name: 'aBubA', data: bubAArr, itemSize: 4 },
      { name: 'aBubB', data: bubBArr, itemSize: 4 },
    ],
    { ultra: 1, high: 0.78, balanced: 0.48, low: 0.24 },
    {
      underwaterOnly: true,
      renderOrder: 4,
      boundingSphere: computeInstanceBoundingSphere(bubAArr, 4.0, { arr: bubBArr, indexInVec4: 2 }),
    },
  );

  // Exact 9,000 (`2,000` Low) camera-wrapped zero-CPU marine snow motes (`44 m` cube)
  const MAX_SNOW = 9000;
  const snowSeeds = new Float32Array(MAX_SNOW * 4);
  for (let i = 0; i < snowSeeds.length; i++) snowSeeds[i] = rnd();
  makeInstancedBatch(
    'AbyssalMarineSnow9000',
    quadBase,
    snowMat,
    [{ name: 'aSnowSeed', data: snowSeeds, itemSize: 4 }],
    { ultra: 1, high: 1, balanced: 0.5, low: 2000 / 9000 },
    { underwaterOnly: true, renderOrder: 5, cameraWrapped: true },
  );

  // NOTE: Duplicate `AbyssalFishSchools` (1,990 procedural hex-cones) & `AbyssalMantaRays` (6 duplicates)
  // removed in Wave 9 — `ArenaMarineEcosystem` is the single authoritative articulated marine ecosystem,
  // sampling `getSharedOpticsUniforms()` directly for Beer-Lambert extinction, caustics, and reef shadows!

  // --- H. Submerged Far Horizon Backdrop Dome (`240 m` underwater scatter)
  const backdropGeo = new T.SphereGeometry(320, 24, 14);
  disposablesGeo.push(backdropGeo);
  const backdropMat = createUnderwaterBackdropMaterial(shared);
  disposablesMat.push(backdropMat);
  const backdropDome = new T.Mesh(backdropGeo, backdropMat);
  backdropDome.name = 'AbyssalSubmergedBackdropDome';
  backdropDome.frustumCulled = false;
  backdropDome.renderOrder = -1;
  backdropDome.visible = false;
  group.add(backdropDome);

  let currentTier = initialTier;
  let warmupForceShadows = false;
  let lastCamY = ARENA_WATER_Y + 10;
  let attachedCanvas: HTMLCanvasElement | null = null;
  const onContextRestored = () => {
    detailBaker.invalidate();
    causticsPass.markNeedsRender();
  };

  const applyShadowCastFlags = (cameraY: number) => {
    const allowUwShadows = warmupForceShadows || cameraY <= ARENA_WATER_Y + 2.5;
    const highShadow = allowUwShadows && (currentTier === 'ultra' || currentTier === 'high');
    const heroShadow = allowUwShadows && currentTier !== 'low';
    for (let i = 0; i < archCaveMeshes.length; i++) {
      archCaveMeshes[i].castShadow = highShadow;
    }
    flukeMesh.castShadow = heroShadow;
    shipMesh.castShadow = heroShadow;
    for (let i = 0; i < batches.length; i++) {
      const b = batches[i];
      if (b.shadowEligible) b.mesh.castShadow = highShadow;
    }
  };

  const setWarmupForceShadows = (force: boolean) => {
    warmupForceShadows = force;
    applyShadowCastFlags(lastCamY);
  };
  sceneUserData.__ecArenaSetWarmupShadows = setWarmupForceShadows;

  const applyWidthAndFarForTier = (tier: ArenaQualityTier) => {
    shared.uQualityLevel.value = tierLevel(tier);
    shared.uWidthScale.value = tier === 'ultra' ? 1.0 : tier === 'high' ? 1.14 : tier === 'balanced' ? 1.42 : 1.85;
    shared.uFarScale.value = tier === 'ultra' ? 1.0 : tier === 'high' ? 0.92 : tier === 'balanced' ? 0.78 : 0.62;
  };
  applyWidthAndFarForTier(initialTier);

  const camRight = new T.Vector3();
  const camUp = new T.Vector3();
  const camFwd = new T.Vector3();

  const syncShadowLight = (sunLight?: T.DirectionalLight | null, camera?: T.Camera | null) => {
    const shadowDepth = sunLight?.shadow?.map?.depthTexture;
    if (sunLight && sunLight.castShadow && shadowDepth) {
      shared.tShadow.value = shadowDepth;
      shared.uShadowMatrix.value.copy(sunLight.shadow.matrix);
      shared.uShadowTexel.value = 1 / max(sunLight.shadow.mapSize.x, 1);
      shared.uShadowEnabled.value = 1;
      shadowState.depthTex = shadowDepth;
      shadowState.matrix = shared.uShadowMatrix.value;
      shadowState.enabled = true;
    } else {
      shared.tShadow.value = fallbackShadow.depthTexture;
      shared.uShadowEnabled.value = 0;
      shadowState.depthTex = fallbackShadow.depthTexture;
      shadowState.matrix = shared.uShadowMatrix.value;
      shadowState.enabled = false;
    }
    if (camera) {
      camera.matrixWorld.extractBasis(camRight, camUp, camFwd);
      camFwd.negate().normalize();
      shared.uCamRight.value.copy(camRight.normalize());
      shared.uCamUp.value.copy(camUp.normalize());
      shared.uCamFwd.value.copy(camFwd);
    }
  };

  return {
    group,
    causticsPass,
    detailBaker,
    godRays,
    sharedUniforms: shared,
    getSharedOpticsUniforms() {
      return shared;
    },
    get causticsTexture() {
      return causticsPass.texture;
    },
    get detailTexture() {
      return detailBaker.texture;
    },
    reefFloorY,

    getSurfaceFishSchools(_time: number): readonly SurfaceFishSchool[] {
      return EMPTY_SURFACE_SCHOOLS;
    },

    attachRenderer(renderer: T.WebGLRenderer) {
      sceneUserData.__ecArenaGodRaysPass = godRays;
      sceneUserData.__ecArenaUnderwaterOptics = shared;
      sceneUserData.__ecArenaShadowState = shadowState;
      sceneUserData.__ecArenaSetWarmupShadows = setWarmupForceShadows;
      if (attachedCanvas === renderer.domElement) return;
      if (attachedCanvas) {
        attachedCanvas.removeEventListener('webglcontextrestored', onContextRestored);
      }
      attachedCanvas = renderer.domElement;
      attachedCanvas.addEventListener('webglcontextrestored', onContextRestored);
      fallbackShadow.init(renderer);
      detailBaker.ensureBaked(renderer);
    },

    syncShadowLight,
    setWarmupForceShadows,

    update(
      time: number,
      renderer: T.WebGLRenderer,
      camera: T.PerspectiveCamera,
      options?: ArenaUnderwaterWorldUpdateOptions,
    ) {
      this.attachRenderer(renderer);
      detailBaker.ensureBaked(renderer);
      causticsPass.update(renderer, time, camera.position.y, newTex => {
        shared.tWater.value = newTex;
        godRays.setWaterTexture(newTex);
      });

      shared.uTime.value = time;
      if (options?.sunDir) {
        shared.uSunDir.value.copy(options.sunDir).normalize();
      }
      if (options?.repelPos) {
        shared.uRepelPos.value.set(
          options.repelPos.x,
          options.repelPos.y,
          options.repelPos.z,
          options.repelRadius ?? 4.5,
        );
      }

      syncShadowLight(options?.sunLight, camera);

      lastCamY = camera.position.y;
      applyShadowCastFlags(lastCamY);

      const nearOrSubmerged = lastCamY <= ARENA_WATER_Y + 2.55;
      const submerged = lastCamY <= ARENA_WATER_Y + 0.08;
      backdropDome.visible = submerged;

      for (const b of batches) {
        if (b.underwaterOnly) {
          b.mesh.visible = nearOrSubmerged && b.mesh.geometry.instanceCount > 0;
        } else {
          b.mesh.visible = b.mesh.geometry.instanceCount > 0;
        }
      }
    },

    renderGodRaysOverlay(
      renderer: T.WebGLRenderer,
      camera: T.PerspectiveCamera,
      depthTexture: T.Texture,
    ) {
      godRays.renderOverlay(
        renderer,
        camera,
        depthTexture,
        shared.uSunDir.value,
        shared.tShadow.value,
        shared.uShadowMatrix.value,
        shared.uShadowEnabled.value > 0.5,
        shared.uGrottoBoost.value,
      );
    },

    setQuality(tier: ArenaQualityTier) {
      if (currentTier === tier) return;
      currentTier = tier;
      applyWidthAndFarForTier(tier);
      detailBaker.setQuality(tier);
      causticsPass.setQuality(tier, newTex => {
        shared.tWater.value = newTex;
        godRays.setWaterTexture(newTex);
      });
      godRays.setQuality(tier);

      // In-place instance count scaling — zero geometry recreation, zero WebGL context churn!
      for (const b of batches) {
        b.mesh.geometry.instanceCount = Math.floor(b.maxCount * b.tierRatios[tier]);
      }
      applyShadowCastFlags(lastCamY);
    },

    setTimeOfDay(tod: ArenaTimeOfDay) {
      applyTimeOfDayToUnderwaterUniforms(shared, tod);
    },

    dispose() {
      if (sceneUserData.__ecArenaGodRaysPass === godRays) {
        delete sceneUserData.__ecArenaGodRaysPass;
      }
      if (sceneUserData.__ecArenaUnderwaterOptics === shared) {
        delete sceneUserData.__ecArenaUnderwaterOptics;
      }
      if (sceneUserData.__ecArenaShadowState === shadowState) {
        delete sceneUserData.__ecArenaShadowState;
      }
      if (sceneUserData.__ecArenaSetWarmupShadows === setWarmupForceShadows) {
        delete sceneUserData.__ecArenaSetWarmupShadows;
      }
      if (attachedCanvas) {
        attachedCanvas.removeEventListener('webglcontextrestored', onContextRestored);
        attachedCanvas = null;
      }
      scene.remove(group);
      causticsPass.dispose();
      detailBaker.dispose();
      godRays.dispose();
      fallbackShadow.dispose();
      zoneMapTex.dispose();
      for (const g of disposablesGeo) g.dispose();
      for (const m of disposablesMat) m.dispose();
      disposablesGeo.length = 0;
      disposablesMat.length = 0;
      batches.length = 0;
    },
  };
}
