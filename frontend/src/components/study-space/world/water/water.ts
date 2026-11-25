import * as T from 'three';
import { splash } from '@/lib/embodiment/contactAudio';
import type { LifeWorld } from '../lifeWorld';
import { CpuFluid, PARTICLE_LITRES, POOL_CAPACITY, SPACING, type FluidShape, type FluidSim } from './fluid';
import { WaterView } from './waterView';

/**
 * Water in the room and house: where it comes from, where it goes and what it does when it gets there.
 * Synchronous pooled `CpuFluid(1024)` + `WaterView(1024)` are pre-allocated at construction so clicking
 * `Run the water`, `Fill it`, `Rinse it`, or pouring a vessel starts on the exact frame with zero async
 * loading gap, zero WebGPU adapter/device spin-up, and zero floor-flooding sink bypass.
 */
export interface Tint { r: number; g: number; b: number }
export const CLEAN: Tint = { r: .022, g: .009, b: .006 };
export const MURKY: Tint = { r: .1, g: .13, b: .19 };
export const TEA: Tint = { r: .1, g: .24, b: .5 };

/** Something open to the air that water falling in stays in. */
export interface Receiver {
  id: string;
  x: number; z: number;
  r: number;
  /** Its rim and how low water can go in it. */
  top: number; bottom: number;
  /** Takes it in, this hot (0..1). True: taken. Water falling into a full one runs over: it is left to fall. */
  take: (litres: number, tint: Tint, heat: number) => boolean;
}
export interface Stream {
  /** World of the stage: where it leaves from and the way it goes. */
  at: T.Vector3; dir: T.Vector3;
  speed: number;
  /** Litres per second: how much is really leaving. */
  flow: number;
  /** How wide the opening is, metres, and whether it is a spray. */
  width: number; spray?: number;
  tint: Tint;
  heat?: number;
}
export interface WaterHost {
  stage: T.Group;
  reduced(): boolean;
  life(): LifeWorld;
  /** What is open to water right now. */
  receivers(): Receiver[];
  /** What water runs off: desks, shelves, the body. */
  shapes(): FluidShape[];
  half(): number;
  /** Optional stage floor height lookup for vessels poured outside the upstairs study room. */
  floorAt?(x: number, z: number): number;
  /** Whether the renderer may spend on it. */
  quality(): 'high' | 'balanced' | 'low';
}
const PER_FRAME = 36;

export class WaterWorld {
  private sim: FluidSim;
  readonly view: WaterView;
  private readonly litres: Float32Array;
  private readonly tint: Float32Array;
  private readonly rest: Float32Array;
  private readonly age: Float32Array;
  private readonly heat: Float32Array;
  private readonly owed = new Map<Stream, number>();
  private readonly owedLitres = new Map<Stream, number>();
  private readonly jitter = new T.Vector3();
  private readonly scratchTint: Tint = { r: 0, g: 0, b: 0 };
  private splashWait = 0;
  private splashed = 0;
  private shown = 0;
  private boundsCenterX = 0;
  private boundsFloorY = 0;
  private boundsCenterZ = 0;
  private boundsHalf = 3;
  private disposed = false;

  /** QA: what has happened to the water so far, litres. */
  readonly book = { emitted: 0, floor: 0, top: 0, taken: 0 };

  constructor(private host: WaterHost) {
    const n = POOL_CAPACITY;
    this.sim = new CpuFluid(n);
    this.view = new WaterView(n);
    this.litres = new Float32Array(n);
    this.tint = new Float32Array(n * 3);
    this.rest = new Float32Array(n);
    this.age = new Float32Array(n);
    this.heat = new Float32Array(n);
    const roomHalf = this.host.half();
    this.boundsHalf = roomHalf;
    this.sim.setBounds(0, 0, 0, roomHalf);
  }

  get running() { return this.sim.count > 0; }
  get gpu() { return this.sim.gpu; }
  get alive() { return this.sim.count; }
  get capacity() { return this.sim.capacity; }
  get shownCount() { return this.shown; }

  /** Pre-allocates half-res fluid render targets and warms shaders behind the Stage-6 boot curtain. */
  warmup(renderer: T.WebGLRenderer, camera: T.Camera, width?: number, height?: number) {
    if (this.disposed) return;
    this.view.warmup(renderer, camera, this.host.stage, width, height);
  }

  /** Kept as a fast synchronous hook for callers invoking `water().prepare()` before a stream starts. */
  prepare() {
    if (this.disposed) return;
    if (!this.sim.count) {
      const roomHalf = this.host.half();
      this.boundsCenterX = 0;
      this.boundsFloorY = 0;
      this.boundsCenterZ = 0;
      this.boundsHalf = roomHalf;
      this.sim.setBounds(0, 0, 0, roomHalf);
    }
  }

  private syncEmitterBounds(x: number, y: number, z: number) {
    const roomHalf = this.host.half();
    const insideStudyRoom = Math.abs(x) <= roomHalf && Math.abs(z) <= roomHalf && y >= -0.25;
    if (insideStudyRoom) {
      if (this.sim.count === 0) {
        this.boundsCenterX = 0;
        this.boundsFloorY = 0;
        this.boundsCenterZ = 0;
        this.boundsHalf = roomHalf;
      }
      return;
    }
    const inferredFloor = this.host.floorAt
      ? this.host.floorAt(x, z)
      : (y < -0.25 ? -3.12 : 0);
    if (this.sim.count === 0) {
      this.boundsCenterX = x;
      this.boundsFloorY = inferredFloor;
      this.boundsCenterZ = z;
      this.boundsHalf = Math.max(roomHalf, 6);
    } else {
      const reach = Math.max(Math.abs(x - this.boundsCenterX), Math.abs(z - this.boundsCenterZ)) + 1.5;
      if (reach > this.boundsHalf) this.boundsHalf = Math.min(24, reach);
      if (inferredFloor < this.boundsFloorY) this.boundsFloorY = inferredFloor;
    }
  }

  /** One bit of water. In the stage's metres. */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, litres: number, tint: Tint = CLEAN, heat = 0) {
    if (this.disposed) return;
    this.book.emitted += litres;
    this.syncEmitterBounds(x, y, z);

    // Reduced motion: skip airborne simulation and route directly to the target receiver or surface below.
    if (this.host.reduced()) {
      this.land(x, y, z, litres, tint, heat, true);
      return;
    }

    const i = this.sim.spawn(x, y, z, vx, vy, vz);
    if (i < 0) {
      this.land(x + vx * .12, y, z + vz * .12, litres, tint, heat, true);
      return;
    }
    this.litres[i] = litres;
    const i3 = i * 3;
    this.tint[i3] = tint.r;
    this.tint[i3 + 1] = tint.g;
    this.tint[i3 + 2] = tint.b;
    this.rest[i] = 0;
    this.age[i] = 0;
    this.heat[i] = heat;
  }

  /** A burst: all of it at once from where the rim is, thrown the way it was going. */
  burst(at: T.Vector3, velocity: T.Vector3, litres: number, tint: Tint = CLEAN) {
    if (this.disposed) return;
    const sim = this.sim;
    const most = Math.min(sim.capacity - sim.count, 360);
    const n = this.host.reduced() ? 0 : Math.min(most, Math.ceil(litres / PARTICLE_LITRES));
    if (n <= 0) { this.emit(at.x, at.y, at.z, 0, 0, 0, litres, tint); return; }
    const each = litres / n, side = Math.max(1, Math.ceil(Math.cbrt(n)));
    let made = 0;
    for (let k = 0; k < side && made < n; k++) {
      for (let j = 0; j < side && made < n; j++) {
        for (let i = 0; i < side && made < n; i++, made++) {
          const x = (i - (side - 1) / 2) * SPACING;
          const y = k * SPACING;
          const z = (j - (side - 1) / 2) * SPACING;
          this.emit(
            at.x + x,
            at.y + y,
            at.z + z,
            velocity.x + (x + (Math.random() - .5) * .01) * 2,
            velocity.y,
            velocity.z + (z + (Math.random() - .5) * .01) * 2,
            each,
            tint,
          );
        }
      }
    }
  }

  /** Water leaving something for this frame. The caller takes `flow * dt` off what it holds. */
  stream(s: Stream, dt: number) {
    if (this.disposed) return;
    const qualityThin = this.host.quality() === 'low' ? .52 : .72;
    const rate = Math.max(
      Math.PI / 4 * s.width * s.width * s.speed / (PARTICLE_LITRES / 1000),
      s.speed / .009,
    ) * qualityThin * (s.spray ? 2.4 : 1);
    const want = Math.max(rate, 30) * dt + (this.owed.get(s) ?? 0);
    const count = Math.min(PER_FRAME, Math.floor(want));
    this.owed.set(s, Math.min(4, want - count));
    const litres = (this.owedLitres.get(s) ?? 0) + s.flow * dt;
    if (count <= 0) { this.owedLitres.set(s, litres); return; }
    this.owedLitres.delete(s);
    const vol = litres / count, j = this.jitter, heat = s.heat ?? 0;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * s.width * .5;
      const spray = s.spray ?? 0;
      j.set((Math.random() - .5) * spray, (Math.random() - .5) * spray, (Math.random() - .5) * spray);
      const t = Math.random() * dt, along = s.speed * t;
      this.emit(
        s.at.x + s.dir.x * along + Math.cos(a) * r,
        s.at.y + s.dir.y * along + Math.sin(a) * r * .5,
        s.at.z + s.dir.z * along + Math.sin(a) * r,
        (s.dir.x + j.x) * s.speed,
        (s.dir.y + j.y) * s.speed - 9.81 * t,
        (s.dir.z + j.z) * s.speed,
        vol,
        s.tint,
        heat,
      );
    }
  }

  stopStream(s: Stream) {
    const left = this.owedLitres.get(s);
    if (left) {
      this.owedLitres.delete(s);
      this.emit(s.at.x, s.at.y, s.at.z, s.dir.x * s.speed, s.dir.y * s.speed, s.dir.z * s.speed, left, s.tint, s.heat ?? 0);
    }
    this.owed.delete(s);
  }

  /**
   * Routes water that has finished falling:
   * 1. Open receivers (`sink.utility` basin, open mugs/kettles/buckets) FIRST so sink streams never flood the floor.
   * 2. Furniture top films (`desk`, `shelf`).
   * 3. Study-room floor (`wetFloor`) when inside study-room bounds.
   */
  private land(x: number, y: number, z: number, litres: number, tint: Tint, heat = 0, fromEmitter = false) {
    const recv = this.host.receivers();
    for (let ri = 0; ri < recv.length; ri++) {
      const r = recv[ri];
      const dx = x - r.x, dz = z - r.z;
      if (dx * dx + dz * dz > r.r * r.r) continue;
      if (fromEmitter ? y < r.bottom - .08 : (y > r.top + .06 || y < r.bottom - .06)) continue;
      if (r.take(litres, tint, heat)) {
        this.book.taken += litres;
        return;
      }
      break;
    }

    const life = this.host.life();
    const dirt = Math.max(0, tint.b - CLEAN.b) * .9;
    for (const f of life.films.values()) {
      const s = f.surface;
      if (fromEmitter ? y < s.y - .05 : Math.abs(y - s.y) > .05) continue;
      const dx = x - s.x, dz = z - s.z, c = Math.cos(s.rotY), n = Math.sin(s.rotY);
      const lx = c * dx - n * dz, lz = n * dx + c * dz;
      if (Math.abs(lx) > f.field.w / 2 || Math.abs(lz) > f.field.d / 2) continue;
      life.wetFilm(f, lx, lz, litres, dirt);
      this.book.top += litres;
      return;
    }

    const roomHalf = this.host.half();
    if (Math.abs(x) <= roomHalf + .1 && Math.abs(z) <= roomHalf + .1 && (fromEmitter ? y >= -.25 : Math.abs(y) < .28)) {
      life.wetFloor(x, z, litres, dirt);
      this.book.floor += litres;
    }
  }

  /** One frame: settle arrived droplets, step active particles, and pack active draw buffers. */
  update(dt: number) {
    if (this.disposed) return;
    const sim = this.sim;
    if (!sim.count) {
      if (this.shown !== 0) {
        this.shown = 0;
        this.view.setCount(0);
      }
      return;
    }

    sim.setBounds(this.boundsCenterX, this.boundsFloorY, this.boundsCenterZ, this.boundsHalf);
    sim.setShapes(this.host.shapes());
    const recv = this.host.receivers();
    const recvLen = recv.length;
    const P = sim.positions, V = sim.velocities, activeIds = sim.activeIds;
    const scratchTint = this.scratchTint;
    const lowFloorY = this.boundsFloorY + .05;
    let landed = 0;

    // Iterate backwards over swap-removed `activeIds` so `sim.kill(i)` never skips an element.
    for (let s = sim.count - 1; s >= 0; s--) {
      const i = activeIds[s];
      const i3 = i * 3;
      const x = P[i3], y = P[i3 + 1], z = P[i3 + 2];
      this.age[i] += dt;

      let gone = false;
      if (V[i3 + 1] <= .2) {
        for (let ri = 0; ri < recvLen; ri++) {
          const r = recv[ri];
          if (y > r.top || y < r.bottom) continue;
          const dx = x - r.x, dz = z - r.z;
          if (dx * dx + dz * dz > r.r * r.r) continue;
          scratchTint.r = this.tint[i3];
          scratchTint.g = this.tint[i3 + 1];
          scratchTint.b = this.tint[i3 + 2];
          if (r.take(this.litres[i], scratchTint, this.heat[i])) {
            sim.kill(i);
            gone = true;
            this.book.taken += this.litres[i];
            landed++;
          }
          break;
        }
      }
      if (gone) continue;

      const speed = Math.hypot(V[i3], V[i3 + 1], V[i3 + 2]);
      const low = y < lowFloorY;
      this.rest[i] = speed < .32 ? this.rest[i] + dt : Math.max(0, this.rest[i] - dt * .5);
      if ((low && (this.rest[i] > .28 || this.age[i] > 2.2)) || this.rest[i] > .7 || this.age[i] > 5) {
        scratchTint.r = this.tint[i3];
        scratchTint.g = this.tint[i3 + 1];
        scratchTint.b = this.tint[i3 + 2];
        this.land(x, y, z, this.litres[i], scratchTint, this.heat[i], false);
        sim.kill(i);
        landed++;
      }
    }

    this.splashed += landed;
    this.splashWait -= dt;
    if (this.splashWait <= 0 && this.splashed) {
      splash(Math.min(.7, .08 + this.splashed * .012));
      this.splashed = 0;
      this.splashWait = .14;
    }

    sim.step(dt);

    const m = sim.count;
    this.shown = m;
    this.view.set(m, (pos, tint) => {
      for (let s = 0; s < m; s++) {
        const i3 = activeIds[s] * 3;
        const m3 = s * 3;
        pos[m3] = P[i3]; pos[m3 + 1] = P[i3 + 1]; pos[m3 + 2] = P[i3 + 2];
        tint[m3] = this.tint[i3]; tint[m3 + 1] = this.tint[i3 + 1]; tint[m3 + 2] = this.tint[i3 + 2];
      }
    });
  }

  /**
   * Direct overlay fallback for non-PostFX tiers (`low` / `balanced` / Overview alpha).
   * Automatically becomes a zero-cost no-op whenever `PostFXController`'s `WaterCompositePass`
   * already composited the frame in linear HDR.
   */
  render(renderer: T.WebGLRenderer, camera: T.Camera) {
    if (this.disposed || !this.shown) return;
    this.view.setCount(this.shown);
    this.view.render(renderer, camera, this.host.stage, this.shown);
  }

  /** The room changed: settle any airborne droplets immediately onto receivers or surfaces below. */
  settle() {
    if (this.disposed) return;
    const sim = this.sim;
    const activeIds = sim.activeIds;
    const scratchTint = this.scratchTint;
    for (let s = sim.count - 1; s >= 0; s--) {
      const i = activeIds[s];
      const i3 = i * 3;
      scratchTint.r = this.tint[i3];
      scratchTint.g = this.tint[i3 + 1];
      scratchTint.b = this.tint[i3 + 2];
      this.land(sim.positions[i3], sim.positions[i3 + 1], sim.positions[i3 + 2], this.litres[i], scratchTint, this.heat[i], true);
      sim.kill(i);
    }
    this.shown = 0;
    this.view.setCount(0);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.shown = 0;
    this.sim.dispose();
    this.view.dispose();
  }
}
