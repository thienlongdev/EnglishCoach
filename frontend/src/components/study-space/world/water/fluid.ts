/// <reference types="@webgpu/types" />
/**
 * Water as particles: double-density relaxation (Clavet, Beaudoin, Poulin 2005).
 * Runs synchronously on a pre-allocated pooled main-thread solver (`CpuFluid`, zero WebGPU
 * mid-session adapter/device spin-up, zero PCIe readback stalls, active-index compacted so
 * empty pool capacity costs zero iterations), while retaining `GpuFluid` for explicit GPU benchmarks.
 *
 * Metres, stage coordinates. Solids (desks, shelves, body) are passed as `FluidShape` primitives;
 * surface wetting and vessel capture live in `water.ts`.
 */
export const INTERACTION = .036;
/** How far apart particles sit at rest, and how much water that makes each of them: spawned closer than this they would fly apart. */
export const SPACING = .016;
export const PARTICLE_LITRES = SPACING * SPACING * SPACING * 1000;
export const CPU_CAPACITY = 900;
export const POOL_CAPACITY = 1024;
export const GPU_CAPACITY = 8192;
const REST = 4.2, STIFF = 1200, NEAR = 400, VISCOSITY = .35, GRAVITY = 9.81;
/** The relaxation is only stable at a fixed step: frames are divided into it, however long they took, up to a limit. */
const FIXED = 1 / 120, MOST_STEPS = 4;
const MOST_SPEED = 7;

export interface FluidShape {
  /** 0 box, 1 upright cylinder (hx is its radius). A solid: water runs off it. */
  kind: 0 | 1;
  x: number; y: number; z: number;
  hx: number; hy: number; hz: number;
  yaw: number;
}

export interface FluidSim {
  readonly capacity: number;
  readonly gpu: boolean;
  /** xyz per particle slot. */
  readonly positions: Float32Array;
  readonly velocities: Float32Array;
  readonly alive: Uint8Array;
  /** Dense swap-removed indices `0 .. count - 1` of currently living particles. */
  readonly activeIds: Uint16Array;
  readonly count: number;
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number): number;
  kill(index: number): void;
  setShapes(shapes: FluidShape[]): void;
  setRoom(half: number): void;
  setBounds(centerX: number, floorY: number, centerZ: number, half: number): void;
  step(dt: number): void;
  dispose(): void;
}

export class CpuFluid implements FluidSim {
  readonly gpu = false;
  readonly capacity: number;
  readonly positions: Float32Array;
  readonly velocities: Float32Array;
  readonly alive: Uint8Array;
  readonly activeIds: Uint16Array;
  count = 0;

  private readonly activeSlot: Int32Array;
  private readonly free: Int32Array;
  private freeTop: number;
  private readonly pred: Float32Array;
  private readonly out: Float32Array;
  private readonly rho: Float32Array;
  private readonly near: Float32Array;
  private readonly head = new Int32Array(4096);
  private readonly next: Int32Array;
  private readonly cellIdx: Int32Array;
  private readonly gridCx: Int32Array;
  private readonly gridCy: Int32Array;
  private readonly gridCz: Int32Array;
  private shapes: FluidShape[] = [];
  private centerX = 0;
  private floorY = 0;
  private centerZ = 0;
  private half = 3;
  private owing = 0;

  constructor(capacity = CPU_CAPACITY) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.alive = new Uint8Array(capacity);
    this.activeIds = new Uint16Array(capacity);
    this.activeSlot = new Int32Array(capacity).fill(-1);
    this.free = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) this.free[i] = capacity - 1 - i;
    this.freeTop = capacity;

    this.pred = new Float32Array(capacity * 3);
    this.out = new Float32Array(capacity * 3);
    this.rho = new Float32Array(capacity);
    this.near = new Float32Array(capacity);
    this.head.fill(-1);
    this.next = new Int32Array(capacity);
    this.cellIdx = new Int32Array(capacity);
    this.gridCx = new Int32Array(capacity);
    this.gridCy = new Int32Array(capacity);
    this.gridCz = new Int32Array(capacity);
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    if (this.freeTop <= 0) return -1;
    const i = this.free[--this.freeTop];
    const p = this.positions, v = this.velocities;
    const i3 = i * 3;
    p[i3] = x; p[i3 + 1] = y; p[i3 + 2] = z;
    v[i3] = vx; v[i3 + 1] = vy; v[i3 + 2] = vz;
    this.alive[i] = 1;
    const slot = this.count++;
    this.activeIds[slot] = i;
    this.activeSlot[i] = slot;
    return i;
  }

  kill(i: number) {
    if (i < 0 || i >= this.capacity || !this.alive[i]) return;
    this.alive[i] = 0;
    const slot = this.activeSlot[i];
    const lastSlot = --this.count;
    if (slot !== lastSlot && slot >= 0) {
      const moved = this.activeIds[lastSlot];
      this.activeIds[slot] = moved;
      this.activeSlot[moved] = slot;
    }
    this.activeSlot[i] = -1;
    this.free[this.freeTop++] = i;
  }

  setShapes(shapes: FluidShape[]) { this.shapes = shapes; }

  setRoom(half: number) {
    this.centerX = 0;
    this.floorY = 0;
    this.centerZ = 0;
    this.half = half;
  }

  setBounds(centerX: number, floorY: number, centerZ: number, half: number) {
    this.centerX = centerX;
    this.floorY = floorY;
    this.centerZ = centerZ;
    this.half = half;
  }

  step(dt: number) {
    if (!this.count) { this.owing = 0; return; }
    this.owing = Math.min(MOST_STEPS * FIXED, this.owing + dt);
    while (this.owing >= FIXED) {
      this.substep(FIXED);
      this.owing -= FIXED;
    }
  }

  private substep(dt: number) {
    const activeCount = this.count;
    if (!activeCount) return;

    const {
      positions: P,
      velocities: V,
      activeIds,
      pred: Q,
      out,
      rho,
      near,
      head,
      next,
      cellIdx,
      gridCx,
      gridCy,
      gridCz,
    } = this;
    const h = INTERACTION;
    const invH = 1 / h;
    const h2 = h * h;

    // 1. Predict positions and populate spatial hash ONLY for active particles.
    for (let s = 0; s < activeCount; s++) {
      const i = activeIds[s];
      const i3 = i * 3;
      const vy = V[i3 + 1] - GRAVITY * dt;
      V[i3 + 1] = vy;
      const qx = P[i3] + V[i3] * dt;
      const qy = P[i3 + 1] + vy * dt;
      const qz = P[i3 + 2] + V[i3 + 2] * dt;
      Q[i3] = qx; Q[i3 + 1] = qy; Q[i3 + 2] = qz;

      const cx = Math.floor(qx * invH);
      const cy = Math.floor(qy * invH);
      const cz = Math.floor(qz * invH);
      gridCx[s] = cx; gridCy[s] = cy; gridCz[s] = cz;

      const c = (((cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791)) >>> 0) & 4095;
      cellIdx[s] = c;
      next[i] = head[c];
      head[c] = i;
    }

    // 2. Compute density and near-density over 3x3x3 neighborhood.
    for (let s = 0; s < activeCount; s++) {
      const i = activeIds[s];
      const i3 = i * 3;
      const x = Q[i3], y = Q[i3 + 1], z = Q[i3 + 2];
      const cx = gridCx[s], cy = gridCy[s], cz = gridCz[s];
      let d = 0, e = 0;
      for (let a = -1; a <= 1; a++) {
        const hx = (cx + a) * 73856093;
        for (let b = -1; b <= 1; b++) {
          const hxy = hx ^ ((cy + b) * 19349663);
          for (let g = -1; g <= 1; g++) {
            const key = ((hxy ^ ((cz + g) * 83492791)) >>> 0) & 4095;
            for (let j = head[key]; j >= 0; j = next[j]) {
              if (j === i) continue;
              const j3 = j * 3;
              const dx = Q[j3] - x, dy = Q[j3 + 1] - y, dz = Q[j3 + 2] - z;
              const r2 = dx * dx + dy * dy + dz * dz;
              if (r2 < h2 && r2 > 1e-12) {
                const q = 1 - Math.sqrt(r2) * invH;
                const q2 = q * q;
                d += q2;
                e += q2 * q;
              }
            }
          }
        }
      }
      rho[i] = d;
      near[i] = e;
    }

    // 3. Double-density relaxation and pairwise viscosity.
    const dt2Half = dt * dt * .5;
    const viscScale = VISCOSITY * dt * 60 * .05;
    const lim = h * .1;
    for (let s = 0; s < activeCount; s++) {
      const i = activeIds[s];
      const i3 = i * 3;
      const x = Q[i3], y = Q[i3 + 1], z = Q[i3 + 2];
      const vix = V[i3], viy = V[i3 + 1], viz = V[i3 + 2];
      const cx = gridCx[s], cy = gridCy[s], cz = gridCz[s];
      const press = STIFF * (rho[i] - REST), pn = NEAR * near[i];
      let mx = 0, my = 0, mz = 0, ux = 0, uy = 0, uz = 0;

      for (let a = -1; a <= 1; a++) {
        const hx = (cx + a) * 73856093;
        for (let b = -1; b <= 1; b++) {
          const hxy = hx ^ ((cy + b) * 19349663);
          for (let g = -1; g <= 1; g++) {
            const key = ((hxy ^ ((cz + g) * 83492791)) >>> 0) & 4095;
            for (let j = head[key]; j >= 0; j = next[j]) {
              if (j === i) continue;
              const j3 = j * 3;
              const dx = Q[j3] - x, dy = Q[j3 + 1] - y, dz = Q[j3 + 2] - z;
              const r2 = dx * dx + dy * dy + dz * dz;
              if (r2 < h2 && r2 > 1e-12) {
                const r = Math.sqrt(r2);
                const q = 1 - r * invH;
                const D = dt2Half * (press * q + pn * q * q) / r;
                mx -= D * dx; my -= D * dy; mz -= D * dz;
                const k = viscScale * q;
                ux += (V[j3] - vix) * k;
                uy += (V[j3 + 1] - viy) * k;
                uz += (V[j3 + 2] - viz) * k;
              }
            }
          }
        }
      }

      const m = Math.hypot(mx, my, mz);
      if (m > lim) { const scale = lim / m; mx *= scale; my *= scale; mz *= scale; }
      out[i3] = x + mx; out[i3 + 1] = y + my; out[i3 + 2] = z + mz;
      V[i3] = vix + ux; V[i3 + 1] = viy + uy; V[i3 + 2] = viz + uz;
    }

    // Clear ONLY touched hash buckets (O(activeCount) instead of O(4096)).
    for (let s = 0; s < activeCount; s++) {
      head[cellIdx[s]] = -1;
    }

    // 4. Integrate velocities, collide against solids and dynamic local bounds.
    const invDt = 1 / dt;
    const shapes = this.shapes;
    const shapeLen = shapes.length;
    const minFloorY = this.floorY + .006;
    const half = Math.max(.25, this.half - .01);
    const minX = this.centerX - half, maxX = this.centerX + half;
    const minZ = this.centerZ - half, maxZ = this.centerZ + half;

    for (let s = 0; s < activeCount; s++) {
      const i = activeIds[s];
      const i3 = i * 3;
      let vx = (out[i3] - P[i3]) * invDt;
      let vy = (out[i3 + 1] - P[i3 + 1]) * invDt;
      let vz = (out[i3 + 2] - P[i3 + 2]) * invDt;
      vx = vx * .98 + V[i3] * .02;
      vy = vy * .98 + V[i3 + 1] * .02;
      vz = vz * .98 + V[i3 + 2] * .02;
      const spd = Math.hypot(vx, vy, vz);
      if (spd > MOST_SPEED) { const k = MOST_SPEED / spd; vx *= k; vy *= k; vz *= k; }

      let x = out[i3], y = out[i3 + 1], z = out[i3 + 2];
      for (let siIdx = 0; siIdx < shapeLen; siIdx++) {
        const c = shapes[siIdx];
        if (c.kind === 0) {
          const dx = x - c.x, dz = z - c.z, co = Math.cos(c.yaw), si = Math.sin(c.yaw);
          const lx = co * dx - si * dz, lz = si * dx + co * dz, ly = y - c.y;
          const ox = c.hx - Math.abs(lx), oy = c.hy - Math.abs(ly), oz = c.hz - Math.abs(lz);
          if (ox > 0 && oy > 0 && oz > 0) {
            if (oy <= ox && oy <= oz) { y = c.y + Math.sign(ly) * c.hy; vy *= -.05; vx *= .92; vz *= .92; }
            else if (ox <= oz) { const nl = Math.sign(lx) * c.hx, wx = co * nl + si * lz, wz = -si * nl + co * lz; x = c.x + wx; z = c.z + wz; vx *= .5; vz *= .5; }
            else { const nl = Math.sign(lz) * c.hz, wx = co * lx + si * nl, wz = -si * lx + co * nl; x = c.x + wx; z = c.z + wz; vx *= .5; vz *= .5; }
          }
        } else {
          const dx = x - c.x, dz = z - c.z, r = Math.hypot(dx, dz);
          if (r < c.hx && Math.abs(y - c.y) < c.hy) {
            const fromTop = c.y + c.hy - y;
            if (fromTop < c.hx - r) { y = c.y + c.hy; vy *= -.05; }
            else {
              const invR = 1 / Math.max(r, 1e-4);
              const nx = dx * invR, nz = dz * invR;
              x = c.x + nx * c.hx; z = c.z + nz * c.hx;
              const vn = vx * nx + vz * nz;
              if (vn < 0) { vx -= vn * nx * 1.05; vz -= vn * nz * 1.05; }
            }
          }
        }
      }

      if (y < minFloorY) { y = minFloorY; vy *= -.04; vx *= .93; vz *= .93; }
      if (x > maxX) { x = maxX; vx *= -.1; } else if (x < minX) { x = minX; vx *= -.1; }
      if (z > maxZ) { z = maxZ; vz *= -.1; } else if (z < minZ) { z = minZ; vz *= -.1; }

      P[i3] = x; P[i3 + 1] = y; P[i3 + 2] = z;
      V[i3] = vx; V[i3 + 1] = vy; V[i3 + 2] = vz;
    }
  }

  dispose() {
    this.count = 0;
    this.alive.fill(0);
    this.activeSlot.fill(-1);
    for (let i = 0; i < this.capacity; i++) this.free[i] = this.capacity - 1 - i;
    this.freeTop = this.capacity;
    this.owing = 0;
  }
}

// ── Optional WebGPU compute solver (kept for explicit GPU tests, batched uploads + generation-guarded readback) ──

const WGSL = /* wgsl */`
struct Params { dt: f32, h: f32, rest: f32, stiff: f32, near: f32, visc: f32, gravity: f32, half: f32, shapes: u32, cap: u32, cells: u32, bucket: u32, cx: f32, fy: f32, cz: f32, pad: f32 };
struct Shape { a: vec4<f32>, b: vec4<f32> };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> pos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> vel: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> pred: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> disp: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> items: array<u32>;
@group(0) @binding(7) var<storage, read> shapes: array<Shape>;

fn hash3(c: vec3<i32>) -> u32 {
  let x = u32(c.x) * 73856093u; let y = u32(c.y) * 19349663u; let z = u32(c.z) * 83492791u;
  return (x ^ y ^ z) % P.cells;
}
fn cellOf(p: vec3<f32>) -> vec3<i32> { return vec3<i32>(floor(p / P.h)); }

@compute @workgroup_size(256)
fn clearCells(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < P.cells) { atomicStore(&counts[id.x], 0u); }
}
@compute @workgroup_size(64)
fn predict(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= P.cap || pos[i].w <= 0.0) { return; }
  var v = vel[i];
  v.y -= P.gravity * P.dt;
  vel[i] = v;
  let q = pos[i].xyz + v.xyz * P.dt;
  pred[i] = vec4<f32>(q, pos[i].w);
  let c = hash3(cellOf(q));
  let n = atomicAdd(&counts[c], 1u);
  if (n < P.bucket) { items[c * P.bucket + n] = i; }
}
@compute @workgroup_size(64)
fn density(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= P.cap || pos[i].w <= 0.0) { return; }
  let x = pred[i].xyz; let base = cellOf(x);
  var rho = 0.0; var nr = 0.0;
  for (var a = -1; a <= 1; a++) { for (var b = -1; b <= 1; b++) { for (var d = -1; d <= 1; d++) {
    let c = hash3(base + vec3<i32>(a, b, d));
    let n = min(atomicLoad(&counts[c]), P.bucket);
    for (var k = 0u; k < n; k++) {
      let j = items[c * P.bucket + k];
      if (j == i) { continue; }
      let r = length(pred[j].xyz - x);
      if (r < P.h && r > 1e-6) { let q = 1.0 - r / P.h; rho += q * q; nr += q * q * q; }
    }
  }}}
  disp[i] = vec4<f32>(0.0, 0.0, rho, nr);
}
@compute @workgroup_size(64)
fn relax(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= P.cap || pos[i].w <= 0.0) { return; }
  let x = pred[i].xyz; let base = cellOf(x);
  let press = P.stiff * (disp[i].z - P.rest); let pn = P.near * disp[i].w;
  var m = vec3<f32>(0.0); var u = vec3<f32>(0.0);
  for (var a = -1; a <= 1; a++) { for (var b = -1; b <= 1; b++) { for (var d = -1; d <= 1; d++) {
    let c = hash3(base + vec3<i32>(a, b, d));
    let n = min(atomicLoad(&counts[c]), P.bucket);
    for (var k = 0u; k < n; k++) {
      let j = items[c * P.bucket + k];
      if (j == i) { continue; }
      let dv = pred[j].xyz - x; let r = length(dv);
      if (r < P.h && r > 1e-6) {
        let q = 1.0 - r / P.h;
        m -= dv * (P.dt * P.dt * (press * q + pn * q * q) * 0.5 / r);
        u += (vel[j].xyz - vel[i].xyz) * (P.visc * q * P.dt * 3.0);
      }
    }
  }}}
  let l = length(m); let most = P.h * 0.1;
  if (l > most) { m *= most / l; }
  pred[i] = vec4<f32>(x + m, pos[i].w);
  vel[i] = vec4<f32>(vel[i].xyz + u, 0.0);
}
@compute @workgroup_size(64)
fn integrate(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  let wTag = pos[i].w;
  if (i >= P.cap || wTag <= 0.0) { return; }
  var q = pred[i].xyz;
  var v = (q - pos[i].xyz) / P.dt * 0.98 + vel[i].xyz * 0.02;
  let s = length(v);
  if (s > 7.0) { v *= 7.0 / s; }
  for (var n = 0u; n < P.shapes; n++) {
    let c = shapes[n];
    if (c.a.w < 0.5) {
      let dw = q - c.a.xyz; let co = cos(c.b.w); let si = sin(c.b.w);
      let lx = co * dw.x - si * dw.z; let lz = si * dw.x + co * dw.z; let ly = dw.y;
      let ox = c.b.x - abs(lx); let oy = c.b.y - abs(ly); let oz = c.b.z - abs(lz);
      if (ox > 0.0 && oy > 0.0 && oz > 0.0) {
        if (oy <= ox && oy <= oz) { q.y = c.a.y + sign(ly) * c.b.y; v.y *= -0.05; v.x *= 0.92; v.z *= 0.92; }
        else if (ox <= oz) { let nl = sign(lx) * c.b.x; q.x = c.a.x + co * nl + si * lz; q.z = c.a.z - si * nl + co * lz; v.x *= 0.5; v.z *= 0.5; }
        else { let nl = sign(lz) * c.b.z; q.x = c.a.x + co * lx + si * nl; q.z = c.a.z - si * lx + co * nl; v.x *= 0.5; v.z *= 0.5; }
      }
    } else {
      let dw = q.xz - c.a.xz; let r = length(dw);
      if (r < c.b.x && abs(q.y - c.a.y) < c.b.y) {
        let top = c.a.y + c.b.y - q.y;
        if (top < c.b.x - r) { q.y = c.a.y + c.b.y; v.y *= -0.05; }
        else { let e = dw / max(r, 1e-4); q.x = c.a.x + e.x * c.b.x; q.z = c.a.z + e.y * c.b.x; let vn = v.x * e.x + v.z * e.y; if (vn < 0.0) { v.x -= vn * e.x * 1.05; v.z -= vn * e.y * 1.05; } }
      }
    }
  }
  let minFloor = P.fy + 0.006;
  if (q.y < minFloor) { q.y = minFloor; v.y *= -0.04; v.x *= 0.93; v.z *= 0.93; }
  let half = max(0.25, P.half - 0.01);
  let minX = P.cx - half; let maxX = P.cx + half;
  let minZ = P.cz - half; let maxZ = P.cz + half;
  if (q.x > maxX) { q.x = maxX; v.x *= -0.1; } else if (q.x < minX) { q.x = minX; v.x *= -0.1; }
  if (q.z > maxZ) { q.z = maxZ; v.z *= -0.1; } else if (q.z < minZ) { q.z = minZ; v.z *= -0.1; }
  pos[i] = vec4<f32>(q, wTag);
  vel[i] = vec4<f32>(v, 0.0);
}
`;

const CELLS = 32768, BUCKET = 14, MAX_SHAPES = 28;

type Gpu = {
  device: GPUDevice; params: GPUBuffer; pos: GPUBuffer; vel: GPUBuffer; pred: GPUBuffer; disp: GPUBuffer; counts: GPUBuffer; items: GPUBuffer; shapes: GPUBuffer;
  bind: GPUBindGroup; pipes: { clear: GPUComputePipeline; predict: GPUComputePipeline; density: GPUComputePipeline; relax: GPUComputePipeline; integrate: GPUComputePipeline };
  stage: { pos: GPUBuffer; vel: GPUBuffer; busy: boolean }[];
};

export class GpuFluid implements FluidSim {
  readonly gpu = true;
  readonly capacity = GPU_CAPACITY;
  readonly positions = new Float32Array(GPU_CAPACITY * 3);
  readonly velocities = new Float32Array(GPU_CAPACITY * 3);
  readonly alive = new Uint8Array(GPU_CAPACITY);
  readonly activeIds = new Uint16Array(GPU_CAPACITY);
  count = 0;

  private readonly activeSlot = new Int32Array(GPU_CAPACITY).fill(-1);
  private readonly gen = new Uint32Array(GPU_CAPACITY);
  private readonly gpuPosMirror = new Float32Array(GPU_CAPACITY * 4);
  private readonly gpuVelMirror = new Float32Array(GPU_CAPACITY * 4);
  private readonly shapeScratch = new Float32Array(MAX_SHAPES * 8);
  private readonly paramBuf = new ArrayBuffer(64);
  private readonly paramF32 = new Float32Array(this.paramBuf);
  private readonly paramU32 = new Uint32Array(this.paramBuf);
  private freeHead = 0;
  private freeTail = 0;
  private freeCount = GPU_CAPACITY;
  private readonly freeRing = new Uint16Array(GPU_CAPACITY);
  private dirtyMin = GPU_CAPACITY;
  private dirtyMax = -1;
  private centerX = 0;
  private floorY = 0;
  private centerZ = 0;
  private half = 3;
  private shapeCount = 0;
  private lost = false;
  private disposed = false;
  private owing = 0;

  private constructor(private g: Gpu) {
    for (let i = 0; i < GPU_CAPACITY; i++) this.freeRing[i] = i;
    g.device.lost.then(() => { this.lost = true; }).catch(() => undefined);
  }

  get failed() { return this.lost; }

  static async create(): Promise<GpuFluid | null> {
    const nav = navigator as Navigator & { gpu?: GPU };
    if (!nav.gpu) return null;
    const adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
    if (!adapter) return null;
    const device = await adapter.requestDevice().catch(() => null);
    if (!device) return null;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const buf = (size: number, u = usage) => device.createBuffer({ size, usage: u });
    const module = device.createShaderModule({ code: WGSL });
    const info = await module.getCompilationInfo().catch(() => null);
    if (info?.messages.some(m => m.type === 'error')) { device.destroy(); return null; }
    const params = buf(64, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const pos = buf(GPU_CAPACITY * 16), vel = buf(GPU_CAPACITY * 16), pred = buf(GPU_CAPACITY * 16), disp = buf(GPU_CAPACITY * 16);
    const counts = buf(CELLS * 4), items = buf(CELLS * BUCKET * 4), shapes = buf(MAX_SHAPES * 32);
    const layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ...[1, 2, 3, 4, 5, 6].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' as const } })),
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    ] });
    const bind = device.createBindGroup({ layout, entries: [params, pos, vel, pred, disp, counts, items, shapes].map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipe = (entryPoint: string) => device.createComputePipelineAsync({ layout: pl, compute: { module, entryPoint } });
    const [clear, predict, density, relax, integrate] = await Promise.all(['clearCells', 'predict', 'density', 'relax', 'integrate'].map(pipe)).catch(() => [null, null, null, null, null]);
    if (!clear || !predict || !density || !relax || !integrate) { device.destroy(); return null; }
    const stage = [0, 1, 2].map(() => ({ pos: device.createBuffer({ size: GPU_CAPACITY * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), vel: device.createBuffer({ size: GPU_CAPACITY * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), busy: false }));
    return new GpuFluid({ device, params, pos, vel, pred, disp, counts, items, shapes, bind, pipes: { clear, predict, density, relax, integrate }, stage });
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    if (this.freeCount <= 0) return -1;
    const i = this.freeRing[this.freeHead];
    this.freeHead = (this.freeHead + 1) % GPU_CAPACITY;
    this.freeCount--;
    const nextGen = ((this.gen[i] + 1) % 65000) || 1;
    this.gen[i] = nextGen;

    const i4 = i * 4;
    this.gpuPosMirror[i4] = x; this.gpuPosMirror[i4 + 1] = y; this.gpuPosMirror[i4 + 2] = z; this.gpuPosMirror[i4 + 3] = nextGen;
    this.gpuVelMirror[i4] = vx; this.gpuVelMirror[i4 + 1] = vy; this.gpuVelMirror[i4 + 2] = vz; this.gpuVelMirror[i4 + 3] = 0;
    if (i < this.dirtyMin) this.dirtyMin = i;
    if (i > this.dirtyMax) this.dirtyMax = i;

    const i3 = i * 3;
    this.positions[i3] = x; this.positions[i3 + 1] = y; this.positions[i3 + 2] = z;
    this.velocities[i3] = vx; this.velocities[i3 + 1] = vy; this.velocities[i3 + 2] = vz;
    this.alive[i] = 1;
    const slot = this.count++;
    this.activeIds[slot] = i;
    this.activeSlot[i] = slot;
    return i;
  }

  kill(i: number) {
    if (i < 0 || i >= GPU_CAPACITY || !this.alive[i]) return;
    this.alive[i] = 0;
    this.gen[i] = ((this.gen[i] + 1) % 65000) || 1;
    const slot = this.activeSlot[i];
    const lastSlot = --this.count;
    if (slot !== lastSlot && slot >= 0) {
      const moved = this.activeIds[lastSlot];
      this.activeIds[slot] = moved;
      this.activeSlot[moved] = slot;
    }
    this.activeSlot[i] = -1;
    this.freeRing[this.freeTail] = i;
    this.freeTail = (this.freeTail + 1) % GPU_CAPACITY;
    this.freeCount++;

    const i4 = i * 4;
    this.gpuPosMirror[i4] = 0; this.gpuPosMirror[i4 + 1] = -50; this.gpuPosMirror[i4 + 2] = 0; this.gpuPosMirror[i4 + 3] = 0;
    this.gpuVelMirror[i4] = 0; this.gpuVelMirror[i4 + 1] = 0; this.gpuVelMirror[i4 + 2] = 0; this.gpuVelMirror[i4 + 3] = 0;
    if (i < this.dirtyMin) this.dirtyMin = i;
    if (i > this.dirtyMax) this.dirtyMax = i;
  }

  setRoom(half: number) {
    this.centerX = 0; this.floorY = 0; this.centerZ = 0; this.half = half;
  }

  setBounds(centerX: number, floorY: number, centerZ: number, half: number) {
    this.centerX = centerX; this.floorY = floorY; this.centerZ = centerZ; this.half = half;
  }

  setShapes(list: FluidShape[]) {
    const n = Math.min(MAX_SHAPES, list.length), data = this.shapeScratch;
    for (let i = 0; i < n; i++) {
      const s = list[i], o = i * 8;
      data[o] = s.x; data[o + 1] = s.y; data[o + 2] = s.z; data[o + 3] = s.kind;
      data[o + 4] = s.hx; data[o + 5] = s.hy; data[o + 6] = s.hz; data[o + 7] = s.yaw;
    }
    this.shapeCount = n;
    if (n) this.g.device.queue.writeBuffer(this.g.shapes, 0, data.buffer, 0, n * 32);
  }

  step(dt: number) {
    if (this.lost || this.disposed) return;
    const { device, pipes, bind } = this.g;
    if (this.dirtyMax >= this.dirtyMin) {
      const byteOffset = this.dirtyMin * 16;
      const byteLength = (this.dirtyMax - this.dirtyMin + 1) * 16;
      device.queue.writeBuffer(this.g.pos, byteOffset, this.gpuPosMirror.buffer, byteOffset, byteLength);
      device.queue.writeBuffer(this.g.vel, byteOffset, this.gpuVelMirror.buffer, byteOffset, byteLength);
      this.dirtyMin = GPU_CAPACITY;
      this.dirtyMax = -1;
    }
    if (!this.count) { this.owing = 0; return; }
    this.owing = Math.min(MOST_STEPS * FIXED, this.owing + dt);
    const steps = Math.floor(this.owing / FIXED);
    if (!steps) return;
    this.owing -= steps * FIXED;
    const f = this.paramF32, u = this.paramU32;
    f[0] = FIXED; f[1] = INTERACTION; f[2] = REST; f[3] = STIFF;
    f[4] = NEAR; f[5] = VISCOSITY; f[6] = GRAVITY; f[7] = this.half;
    u[8] = this.shapeCount; u[9] = GPU_CAPACITY; u[10] = CELLS; u[11] = BUCKET;
    f[12] = this.centerX; f[13] = this.floorY; f[14] = this.centerZ; f[15] = 0;
    device.queue.writeBuffer(this.g.params, 0, this.paramBuf);
    const enc = device.createCommandEncoder();
    const groups = Math.ceil(GPU_CAPACITY / 64);
    for (let n = 0; n < steps; n++) {
      const pass = enc.beginComputePass();
      pass.setBindGroup(0, bind);
      pass.setPipeline(pipes.clear); pass.dispatchWorkgroups(Math.ceil(CELLS / 256));
      pass.setPipeline(pipes.predict); pass.dispatchWorkgroups(groups);
      pass.setPipeline(pipes.density); pass.dispatchWorkgroups(groups);
      pass.setPipeline(pipes.relax); pass.dispatchWorkgroups(groups);
      pass.setPipeline(pipes.integrate); pass.dispatchWorkgroups(groups);
      pass.end();
    }
    const stage = this.g.stage.find(s => !s.busy);
    if (stage) {
      enc.copyBufferToBuffer(this.g.pos, 0, stage.pos, 0, GPU_CAPACITY * 16);
      enc.copyBufferToBuffer(this.g.vel, 0, stage.vel, 0, GPU_CAPACITY * 16);
    }
    device.queue.submit([enc.finish()]);
    if (stage) {
      stage.busy = true;
      void Promise.all([stage.pos.mapAsync(GPUMapMode.READ), stage.vel.mapAsync(GPUMapMode.READ)]).then(() => {
        if (this.disposed) return;
        const P = new Float32Array(stage.pos.getMappedRange()), V = new Float32Array(stage.vel.getMappedRange());
        const activeCount = this.count, activeIds = this.activeIds, gen = this.gen;
        for (let s = 0; s < activeCount; s++) {
          const i = activeIds[s];
          const i4 = i * 4;
          if (!this.alive[i] || Math.round(P[i4 + 3]) !== gen[i]) continue;
          const i3 = i * 3;
          this.positions[i3] = P[i4]; this.positions[i3 + 1] = P[i4 + 1]; this.positions[i3 + 2] = P[i4 + 2];
          this.velocities[i3] = V[i4]; this.velocities[i3 + 1] = V[i4 + 1]; this.velocities[i3 + 2] = V[i4 + 2];
          this.gpuPosMirror[i4] = P[i4]; this.gpuPosMirror[i4 + 1] = P[i4 + 1]; this.gpuPosMirror[i4 + 2] = P[i4 + 2];
          this.gpuVelMirror[i4] = V[i4]; this.gpuVelMirror[i4 + 1] = V[i4 + 1]; this.gpuVelMirror[i4 + 2] = V[i4 + 2];
        }
        stage.pos.unmap(); stage.vel.unmap(); stage.busy = false;
      }).catch(() => { stage.busy = false; });
    }
  }

  dispose() {
    this.disposed = true;
    this.count = 0;
    try { this.g.device.destroy(); } catch { /* already destroyed */ }
  }
}

/** Synchronous pooled CpuFluid by default; optional WebGPU only when explicitly requested. */
export async function createFluid(allowGpu = false): Promise<FluidSim> {
  if (allowGpu) {
    try { const g = await GpuFluid.create(); if (g) return g; } catch { /* fall back to CpuFluid */ }
  }
  return new CpuFluid(POOL_CAPACITY);
}
