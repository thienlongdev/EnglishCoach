/**
 * ECHO ARCHIPELAGO — Functional Amphibious Wading, Surface Swimming and Underwater Diving Controller.
 *
 * Designed for joyful, comfortable, survival-free exploration in an English speaking world:
 * - Zero stamina punishment, zero oxygen timer, zero drowning or health loss.
 * - Calibrated feet-origin waterline offsets (`SURFACE_TREAD_OFFSET = 1.26 m` upright treading,
 *   `SURFACE_PRONE_OFFSET = 1.12 m` prone swimming, smooth speed-driven blend) matching `cast-*.glb`
 *   at `SCALE = 1.06` (`hips = +0.949 m`, `chest = +1.246 m`, `head = +1.521 m`).
 * - Fixed-step (`dt <= 1/60`) Archimedes surface spring-damper (omega_n = 3.2 rad/s, zeta = 0.78),
 *   gentle underwater neutral buoyancy (+0.035 m/s^2 soft hover), quadratic anisotropic hydrodynamic drag
 *   (c_parallel = 0.85, c_perp = 2.65, c_lin = 1.35), and stroke-phase propulsion pulse T(phi).
 * - Hysteresis-guarded transitions (`land` <-> `wading` <-> `surface_swim` <-> `underwater_dive`),
 *   safe seabed clearance (`groundY + 0.65 m`), smooth beach walk-out, and pier/dock climb-out.
 * - Zero per-frame heap allocations (`0` GC pressure in 60 Hz / render loops).
 */

import * as T from 'three';
import type { ArenaQualityTier, ArenaSwimFrame, ArenaWaterMode } from './arenaContracts';
import { arenaWaveHeight, type SeaWakeSource } from './arenaSea';
import {
  ARENA_PLAYER_LIMIT,
  ARENA_WATER_Y,
  arenaBathymetry,
  arenaClimbOutPoint,
  arenaDryWalkable,
  arenaFloor,
  arenaLayout,
  arenaSupportY,
  arenaWalkable,
} from './arenaTerrain';
import type { ArenaAmbience } from './arenaAmbience';

export const WADE_MIN_DEPTH = 0.25;
export const WADE_EXIT_DEPTH = 0.17;
export const SWIM_MIN_DEPTH = 0.85;
export const SWIM_EXIT_DEPTH = 0.68;
export const DIVE_MIN_WATER_DEPTH = 2.2;
export const DIVE_EXIT_WATER_DEPTH = 1.65;
export const SEABED_MIN_CLEARANCE = 0.65;

/**
 * Feet-origin waterline offsets relative to `liveWaveY` (`cast-*.glb` at `SCALE = 1.06`):
 * - Upright treading (`1.26 m`): waterline at upper chest / collarbone (`+1.25 m`), head and chin cleanly above waves.
 * - Prone swimming (`1.12 m`): pelvis (`+0.95 m`) and flutter-kick ankles stay submerged below the waterline,
 *   eliminating boots kicking high into dry air while keeping head and shoulders breaking the surface naturally.
 */
export const SURFACE_TREAD_OFFSET = 1.26;
export const SURFACE_PRONE_OFFSET = 1.12;
/** Backward-compatible alias equal to `SURFACE_PRONE_OFFSET`. */
export const SURFACE_BODY_OFFSET = SURFACE_PRONE_OFFSET;

/** Realistic athletic human swimming speeds (safely below land Run `3.35 m/s` and server `3.6 m/s` travelCredit). */
export const SURFACE_CRUISE_SPEED = 1.55;
export const SURFACE_SPRINT_SPEED = 2.35;
export const UNDERWATER_CRUISE_SPEED = 1.65;
export const UNDERWATER_SURGE_SPEED = 2.55;

// Hydrodynamic and Archimedes buoyancy constants
const FIXED_SUBSTEP_MAX_DT = 1 / 60;
const ARCHIMEDES_OMEGA = 3.2; // rad/s
const ARCHIMEDES_ZETA = 0.78;
const ARCHIMEDES_K = ARCHIMEDES_OMEGA * ARCHIMEDES_OMEGA; // 10.24 s^-2
const ARCHIMEDES_C = 2 * ARCHIMEDES_ZETA * ARCHIMEDES_OMEGA; // 4.992 s^-1

const DRAG_QUAD_PARALLEL = 0.85; // m^-1 longitudinal form drag
const DRAG_QUAD_PERP = 2.65; // m^-1 transverse drag (eliminates sideways no-clip strafing)
const DRAG_LIN_HORIZ = 1.35; // s^-1 linear viscous drag
const DRAG_QUAD_VERT = 1.85; // m^-1 vertical form drag underwater
const DRAG_LIN_VERT = 1.95; // s^-1 vertical linear damping underwater
const UNDERWATER_NEUTRAL_BUOYANCY = 0.035; // m/s^2 gentle positive float when hovering

export type SwimEventKind =
  | 'water_entry'
  | 'wade_step'
  | 'swim_stroke'
  | 'dive_submerge'
  | 'resurface'
  | 'dock_climb';

export interface SwimRippleEvent {
  kind: SwimEventKind;
  x: number;
  y: number;
  z: number;
  strength: number;
  underwater: boolean;
}

export interface DockClimbTarget {
  dockId: string;
  islandId: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  distance: number;
  labelEn: string;
  labelVi: string;
}

export interface SwimStepInput {
  dt: number;
  time: number;
  /** Forward/backward input (-1 .. +1, +1 = forward) */
  forward: number;
  /** Right/left strafe input (-1 .. +1, +1 = right) */
  right: number;
  /** Camera yaw in radians */
  cameraYaw: number;
  /** Camera pitch in radians (negative = looking down) */
  cameraPitch: number;
  /** Sprint / fast freestyle crawl modifier (Shift) */
  sprint: boolean;
  /** Ascend / jump / climb-out input (Space) */
  ascend: boolean;
  /** Hold-to-dive input (KeyC or ControlLeft held) */
  diveHeld: boolean;
  /** One-shot toggle-dive edge press (KeyC tap) */
  diveTogglePressed?: boolean;
}

export interface ArenaSwimmingOptions {
  worldLimit?: number;
  groundHeightAt?: (x: number, z: number, currentY: number) => number;
  waveHeightAt?: (x: number, z: number, time: number) => number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function segmentProjection(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  px: number,
  pz: number,
  out: { t: number; dist: number; cx: number; cz: number },
): void {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  const t = lenSq > 1e-6 ? clamp(((px - ax) * dx + (pz - az) * dz) / lenSq, 0, 1) : 0;
  const cx = ax + dx * t;
  const cz = az + dz * t;
  out.t = t;
  out.cx = cx;
  out.cz = cz;
  out.dist = Math.hypot(px - cx, pz - cz);
}

function dockHeightAt(ah: number, bh: number, t: number): number {
  const ramp = t <= 0.12 ? 0 : t >= 0.76 ? 1 : (t - 0.12) / 0.64;
  const s = ramp * ramp * (3 - 2 * ramp);
  return ah + (bh - ah) * s;
}

/**
 * Stroke-phase propulsion modulation T(phi) with exact unit cycle mean (`mean(M) === 1.0`):
 * - Breaststroke / cruise: single strong power-pull surge + smooth glide deceleration per cycle.
 * - Freestyle / surge: dual alternating left/right arm-pull cadence per cycle.
 */
function strokeThrustMultiplier(phaseFrac: number, alternating: boolean): number {
  const theta = phaseFrac * Math.PI * 2;
  const s = Math.sin(theta);
  if (alternating) {
    // sin^2(2*pi*phi) has cycle mean 0.5 -> oscillates in [0.89, 1.11] with mean 1.0
    return 1 + 0.22 * (s * s - 0.5);
  }
  // max(0, sin(2*pi*phi))^2 has cycle mean 0.25 -> oscillates in [0.87, 1.39] with mean 1.0
  const pos = s > 0 ? s : 0;
  return 1 + 0.52 * (pos * pos - 0.25);
}

const _segScratch = { t: 0, dist: 0, cx: 0, cz: 0 };
const SWIM_SLIDE_ANGLES = [0.279253, 0.558505, 0.837758, 1.11701, 1.39626] as const;
const SWIM_SLIDE_COS = SWIM_SLIDE_ANGLES.map(a => Math.cos(a));
const SWIM_SLIDE_SIN = SWIM_SLIDE_ANGLES.map(a => Math.sin(a));
const MAX_GROUND_SLEW_PER_SUBSTEP = 0.032;

/**
 * Continuous archipelago ground and seabed elevation query (zero allocations).
 * Uses `arenaBathymetry` from `arenaTerrain.ts` (+16.5 m peaks -> -1.2 m beaches -> -4.5 m coral lagoons
 * -> -16 m channels -> -34 m deep ocean), while allowing swimmers and divers to pass naturally
 * in the water alongside or beneath elevated bridge and pier decks.
 */
export function arenaSwimGroundY(
  x: number,
  z: number,
  currentFeetY = 0,
  customGroundFn?: (x: number, z: number, currentY: number) => number,
): number {
  if (customGroundFn) return customGroundFn(x, z, currentFeetY);

  // 1. Elevated bridges (only support feet when above deck height, never snap an underwater diver up!)
  for (let i = 0; i < arenaLayout.bridges.length; i++) {
    const b = arenaLayout.bridges[i];
    segmentProjection(b.ax, b.az, b.bx, b.bz, x, z, _segScratch);
    if (_segScratch.dist <= b.width * 0.5) {
      const deckY = b.ah + (b.bh - b.ah) * _segScratch.t + Math.sin(_segScratch.t * Math.PI) * 0.25;
      if (currentFeetY >= deckY - 0.42) return deckY;
    }
  }

  // 2. Coastal timber docks
  for (let i = 0; i < arenaLayout.docks.length; i++) {
    const d = arenaLayout.docks[i];
    segmentProjection(d.ax, d.az, d.bx, d.bz, x, z, _segScratch);
    if (_segScratch.dist <= d.width * 0.5) {
      const deckY = dockHeightAt(d.ah, d.bh, _segScratch.t);
      if (currentFeetY >= deckY - 0.42) return deckY;
    }
  }

  // 3. Authoritative continuous archipelago terrain and bathymetry
  const bathy = arenaBathymetry(x, z);
  return bathy >= ARENA_WATER_Y ? arenaFloor(x, z) : bathy;
}

/** Check whether a horizontal swimmer circle (r = 0.34 m) is clear of rocks, solid obstacles, and steep cliffs. */
function isSwimPositionClear(
  x: number,
  z: number,
  currentY: number,
  prevGroundY: number,
  worldLimit: number,
  customGroundFn?: (x: number, z: number, currentY: number) => number,
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  if (Math.hypot(x, z) > worldLimit - 0.5) return false;

  // Solid shore rocks protrude near the waterline
  for (let i = 0; i < arenaLayout.rocks.length; i++) {
    const rk = arenaLayout.rocks[i];
    const reach = rk.r + 0.32;
    const dx = x - rk.x;
    const dz = z - rk.z;
    if (Math.abs(dx) < reach && Math.abs(dz) < reach && dx * dx + dz * dz < reach * reach) {
      const rockTopY = ARENA_WATER_Y + rk.h;
      if (currentY < rockTopY + 0.25) return false;
    }
  }

  // Land obstacles (planters, monuments, towers, trunks)
  for (let i = 0; i < arenaLayout.obstacles.length; i++) {
    const o = arenaLayout.obstacles[i];
    const reach = o.radius + 0.3;
    const dx = x - o.x;
    const dz = z - o.z;
    if (Math.abs(dx) < reach && Math.abs(dz) < reach && dx * dx + dz * dz < reach * reach) {
      return false;
    }
  }

  // Prevent swimming through steep rocky cliff faces or newly added island tree trunk colliders while allowing smooth sandy beach walk-out.
  const groundY = arenaSwimGroundY(x, z, currentY, customGroundFn);
  const supportRef = Math.max(currentY, prevGroundY);
  if (groundY > ARENA_WATER_Y + 0.12 && groundY - supportRef > 0.48) {
    return false;
  }
  if (!customGroundFn && groundY >= ARENA_WATER_Y - 0.15) {
    if (!arenaWalkable(x, z, Math.max(supportRef, arenaSupportY(x, z)))) {
      return false;
    }
  }

  return true;
}

export class ArenaSwimmingController {
  x: number;
  y: number;
  z: number;
  vx = 0;
  vy = 0;
  vz = 0;
  yaw = 0;
  pitch = 0;

  private diveLatched = false;
  private submergeAssistTimer = 0;
  private proneBlend = 0;
  private rollEnvelope = 0;
  private bodyRoll = 0;
  private strokePhase = 0;
  private prevStrokeCycle = 0;
  private wadeDistanceAcc = 0;
  private lastTime = 0;
  private slideSign: -1 | 0 | 1 = 0;
  private readonly worldLimit: number;
  private readonly groundFn?: (x: number, z: number, currentY: number) => number;
  private readonly waveFn: (x: number, z: number, time: number) => number;

  // Preallocated zero-GC output structures
  readonly frame: ArenaSwimFrame = {
    mode: 'land',
    waterDepth: 0,
    submersion: 0,
    diveDepth: 0,
    strokeSpeed: 0,
    pitch: 0,
    verticalSpeed: 0,
    isTreading: false,
    strokePhase: 0,
    bodyRoll: 0,
  };

  private readonly eventPool: SwimRippleEvent[] = Array.from({ length: 8 }, () => ({
    kind: 'swim_stroke',
    x: 0,
    y: ARENA_WATER_Y,
    z: 0,
    strength: 0.5,
    underwater: false,
  }));
  private eventCount = 0;
  private readonly activeEventsView: SwimRippleEvent[] = [];

  readonly wakeSource: SeaWakeSource = {
    id: 'swimmer-self',
    motor: false,
    x: 0,
    z: 0,
    speed: 0,
    yaw: 0,
  };

  private readonly climbResult: DockClimbTarget = {
    dockId: '',
    islandId: '',
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    distance: 0,
    labelEn: 'Climb onto pier',
    labelVi: 'Leo lên cầu tàu',
  };

  constructor(initialX = 0, initialZ = 2, initialY?: number, options?: ArenaSwimmingOptions) {
    this.worldLimit = options?.worldLimit ?? ARENA_PLAYER_LIMIT;
    this.groundFn = options?.groundHeightAt;
    this.waveFn = options?.waveHeightAt ?? arenaWaveHeight;
    this.x = initialX;
    this.z = initialZ;
    this.y = initialY ?? arenaSwimGroundY(initialX, initialZ, 0, this.groundFn);
  }

  /** Synchronize controller pose externally (e.g., on room spawn, teleport, boat disembark, or land motor handoff). */
  syncPose(x: number, y: number, z: number, yaw = this.yaw): void {
    const stepJump = Math.hypot(x - this.x, z - this.z);
    this.x = x;
    this.y = y;
    this.z = z;
    this.yaw = yaw;
    if (stepJump > 0.35) {
      this.vx = 0;
      this.vz = 0;
      this.slideSign = 0;
    }
    this.vy = 0;
    this.pitch = 0;
    this.proneBlend = 0;
    this.rollEnvelope = 0;
    this.bodyRoll = 0;
    this.submergeAssistTimer = 0;

    const waterY = this.waveFn(x, z, this.lastTime);
    const meanWaterY = this.waveFn === arenaWaveHeight ? ARENA_WATER_Y : waterY;
    const groundY = arenaSwimGroundY(x, z, y, this.groundFn);
    const waterDepth = Math.max(0, waterY - groundY);
    const modeDepth = Math.max(0, meanWaterY - groundY);

    if (modeDepth < WADE_MIN_DEPTH || y > Math.max(waterY, meanWaterY) + 0.08) {
      this.diveLatched = false;
      this.frame.mode = 'land';
      this.frame.waterDepth = waterDepth;
      this.frame.submersion = 0;
      this.frame.diveDepth = 0;
      this.frame.strokeSpeed = 0;
      this.frame.pitch = 0;
      this.frame.verticalSpeed = 0;
      this.frame.isTreading = false;
      this.frame.strokePhase = 0;
      this.frame.bodyRoll = 0;
    } else if (modeDepth < SWIM_MIN_DEPTH) {
      this.diveLatched = false;
      this.frame.mode = 'wading';
      this.frame.waterDepth = waterDepth;
      this.frame.submersion = clamp((waterDepth - WADE_MIN_DEPTH) / 1.15, 0.08, 0.55);
      this.frame.diveDepth = 0;
      this.frame.strokeSpeed = 0;
      this.frame.pitch = 0;
      this.frame.verticalSpeed = 0;
      this.frame.isTreading = false;
      this.frame.strokePhase = 0;
      this.frame.bodyRoll = 0;
    } else {
      this.diveLatched = false;
      this.frame.mode = 'surface_swim';
      this.frame.waterDepth = waterDepth;
      this.frame.submersion = 0.64;
      this.frame.diveDepth = 0;
      this.frame.strokeSpeed = Math.hypot(this.vx, this.vz);
      this.frame.pitch = 0;
      this.frame.verticalSpeed = 0;
      this.frame.isTreading = true;
      this.frame.strokePhase = 0;
      this.frame.bodyRoll = 0;
    }
  }

  /** Explicit toggle for underwater free-diving (e.g., bound to KeyC). */
  toggleDive(): boolean {
    if (this.frame.waterDepth <= DIVE_MIN_WATER_DEPTH) {
      this.diveLatched = false;
      this.submergeAssistTimer = 0;
      return false;
    }
    this.diveLatched = !this.diveLatched;
    if (this.diveLatched) {
      this.submergeAssistTimer = 0.72;
    } else {
      this.submergeAssistTimer = 0;
    }
    return this.diveLatched;
  }

  private pushEvent(
    kind: SwimEventKind,
    x: number,
    y: number,
    z: number,
    strength: number,
    underwater: boolean,
  ): void {
    if (this.eventCount >= this.eventPool.length) return;
    const ev = this.eventPool[this.eventCount++];
    ev.kind = kind;
    ev.x = x;
    ev.y = y;
    ev.z = z;
    ev.strength = strength;
    ev.underwater = underwater;
  }

  /** Zero-GC slice of swim/splash ripple events emitted during the most recent `step()`. */
  getEvents(): readonly SwimRippleEvent[] {
    this.activeEventsView.length = this.eventCount;
    for (let i = 0; i < this.eventCount; i++) {
      this.activeEventsView[i] = this.eventPool[i];
    }
    return this.activeEventsView;
  }

  /** Play emitted water splashes and swim strokes directly onto `ArenaAmbience` (optional convenience helper). */
  flushAudioEvents(ambience: ArenaAmbience, listenerX: number, listenerZ: number, listenerYaw: number): void {
    for (let i = 0; i < this.eventCount; i++) {
      const ev = this.eventPool[i];
      if (ev.kind === 'water_entry' || ev.kind === 'dive_submerge' || ev.kind === 'resurface') {
        ambience.waterSplash(
          ev.x,
          ev.z,
          listenerX,
          listenerZ,
          listenerYaw,
          ev.strength,
          ev.kind === 'dive_submerge',
        );
      } else if (ev.kind === 'wade_step' || ev.kind === 'swim_stroke') {
        ambience.swimStroke(ev.x, ev.z, listenerX, listenerZ, listenerYaw, ev.underwater, ev.strength);
      } else if (ev.kind === 'dock_climb') {
        ambience.interactCue(true);
      }
    }
  }

  /**
   * Detect whether the swimmer/wader is adjacent to a timber pier or dock ladder and can climb out onto dry planks.
   * Returns a preallocated `DockClimbTarget` with safe walkable coordinates `(x, y, z, yaw)`, or `null`.
   */
  canClimbDock(
    queryX = this.x,
    queryZ = this.z,
    queryY = this.y,
    lookYaw = this.yaw,
  ): DockClimbTarget | null {
    if (this.frame.mode !== 'surface_swim' && this.frame.mode !== 'wading') return null;

    const fwdX = Math.sin(lookYaw);
    const fwdZ = Math.cos(lookYaw);
    let bestScore = -Infinity;
    let found = false;

    for (let i = 0; i < arenaLayout.docks.length; i++) {
      const d = arenaLayout.docks[i];
      segmentProjection(d.ax, d.az, d.bx, d.bz, queryX, queryZ, _segScratch);
      const halfW = d.width * 0.5;
      const edgeGap = _segScratch.dist - halfW;
      if (edgeGap > 2.2 || edgeGap < -0.45) continue;

      const deckY = dockHeightAt(d.ah, d.bh, _segScratch.t);
      const climbHeight = deckY - Math.max(queryY, ARENA_WATER_Y);
      if (climbHeight > 1.55) continue;

      // Safe landing spot near the centerline of the pier (verified against arenaDryWalkable and arenaClimbOutPoint)
      const exactPoint = arenaClimbOutPoint(queryX, queryZ);
      const safeT = clamp(Math.max(0.56, _segScratch.t), 0.56, 0.94);
      const lx = exactPoint ? exactPoint.x : d.ax + (d.bx - d.ax) * safeT;
      const lz = exactPoint ? exactPoint.z : d.az + (d.bz - d.az) * safeT;
      const ly = exactPoint ? exactPoint.y : arenaFloor(lx, lz);
      if (!arenaDryWalkable(lx, lz)) continue;

      const toX = lx - queryX;
      const toZ = lz - queryZ;
      const dist = Math.max(0.01, Math.hypot(toX, toZ));
      const facing = (toX / dist) * fwdX + (toZ / dist) * fwdZ;
      if (facing < -0.55 && edgeGap > 0.85) continue;

      const score = (2.2 - edgeGap) * 1.4 + facing * 0.65 - Math.max(0, climbHeight) * 0.35;
      if (score > bestScore) {
        bestScore = score;
        found = true;
        this.climbResult.dockId = d.id;
        this.climbResult.islandId = d.island;
        this.climbResult.x = lx;
        this.climbResult.y = ly;
        this.climbResult.z = lz;
        this.climbResult.yaw = Math.atan2(toX, toZ);
        this.climbResult.distance = Math.max(0, edgeGap);
      }
    }

    return found ? this.climbResult : null;
  }

  /** Execute a smooth pier/dock climb-out using the target returned by `canClimbDock()`. */
  climbOutToDock(target?: DockClimbTarget | null): DockClimbTarget | null {
    const dest = target ?? this.canClimbDock();
    if (!dest) return null;
    this.x = dest.x;
    this.y = dest.y;
    this.z = dest.z;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.yaw = dest.yaw;
    this.pitch = 0;
    this.proneBlend = 0;
    this.rollEnvelope = 0;
    this.bodyRoll = 0;
    this.diveLatched = false;
    this.submergeAssistTimer = 0;
    this.frame.mode = 'land';
    this.frame.waterDepth = 0;
    this.frame.submersion = 0;
    this.frame.diveDepth = 0;
    this.frame.strokeSpeed = 0;
    this.frame.pitch = 0;
    this.frame.verticalSpeed = 0;
    this.frame.isTreading = false;
    this.frame.strokePhase = 0;
    this.frame.bodyRoll = 0;
    this.eventCount = 0;
    this.pushEvent('dock_climb', dest.x, dest.y, dest.z, 0.75, false);
    return dest;
  }

  /** Swept zero-GC horizontal motion step with smooth tangential sliding along coastal rocks, pilings, and trunks. */
  private moveSweptHorizontal(dx: number, dz: number): void {
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-6) {
      this.slideSign = 0;
      return;
    }
    const steps = Math.max(1, Math.ceil(dist / 0.16));
    const sx = dx / steps;
    const sz = dz / steps;

    for (let i = 0; i < steps; i++) {
      const prevGround = arenaSwimGroundY(this.x, this.z, this.y, this.groundFn);
      if (isSwimPositionClear(this.x + sx, this.z + sz, this.y, prevGround, this.worldLimit, this.groundFn)) {
        this.x += sx;
        this.z += sz;
        this.slideSign = 0;
        continue;
      }

      // Tangential deflection fan around cylindrical rocks / shoreline trunks / dock pilings
      let slid = false;
      for (let aIdx = 0; aIdx < SWIM_SLIDE_ANGLES.length && !slid; aIdx++) {
        const c = SWIM_SLIDE_COS[aIdx];
        const s = SWIM_SLIDE_SIN[aIdx];
        const scale = Math.max(0.34, c);
        for (let dirIdx = 0; dirIdx < 2; dirIdx++) {
          const sign: -1 | 1 = dirIdx === 0 ? (this.slideSign === -1 ? -1 : 1) : (this.slideSign === -1 ? 1 : -1);
          const rs = s * sign;
          const tx = (sx * c - sz * rs) * scale;
          const tz = (sx * rs + sz * c) * scale;
          if (isSwimPositionClear(this.x + tx, this.z + tz, this.y, prevGround, this.worldLimit, this.groundFn)) {
            this.x += tx;
            this.z += tz;
            this.slideSign = sign;
            const vLen = Math.hypot(this.vx, this.vz);
            const tLen = Math.hypot(tx, tz);
            if (vLen > 1e-4 && tLen > 1e-5) {
              const ux = tx / tLen;
              const uz = tz / tLen;
              const projV = Math.max(0, this.vx * ux + this.vz * uz);
              this.vx = ux * projV;
              this.vz = uz * projV;
            }
            slid = true;
            break;
          }
        }
      }
      if (slid) continue;

      if (isSwimPositionClear(this.x + sx, this.z, this.y, prevGround, this.worldLimit, this.groundFn)) {
        this.x += sx;
        this.vz *= 0.4;
      } else if (isSwimPositionClear(this.x, this.z + sz, this.y, prevGround, this.worldLimit, this.groundFn)) {
        this.z += sz;
        this.vx *= 0.4;
      } else {
        this.vx *= 0.25;
        this.vz *= 0.25;
        break;
      }
    }

    // Soft coastal current pushback near outer archipelago limit (zero invisible brick wall feel)
    const radial = Math.hypot(this.x, this.z);
    if (radial > this.worldLimit - 4.0 && radial > 1e-3) {
      const push = smoothstep(this.worldLimit - 4.0, this.worldLimit, radial) * 0.22;
      this.x -= (this.x / radial) * push;
      this.z -= (this.z / radial) * push;
    }
  }

  /** Smoothly track walkable beach/seabed ground without frame-to-frame snaps > 3.2 cm or slope lag. */
  private followGroundSmoothly(targetGroundY: number): void {
    const delta = targetGroundY - this.y;
    if (Math.abs(delta) <= MAX_GROUND_SLEW_PER_SUBSTEP) {
      this.y = targetGroundY;
    } else {
      this.y += Math.sign(delta) * MAX_GROUND_SLEW_PER_SUBSTEP;
    }
  }

  /**
   * Apply quadratic anisotropic hydrodynamic drag in the swimmer's body frame
   * (longitudinal c_parallel = 0.85, transverse c_perp = 2.65, linear viscous c_lin = 1.35)
   * plus stroke-modulated forward propulsion thrust.
   */
  private integrateWaterHorizontal(
    wishX: number,
    wishZ: number,
    targetSpeed: number,
    strokeMult: number,
    subDt: number,
  ): void {
    const fwdX = Math.sin(this.yaw);
    const fwdZ = Math.cos(this.yaw);
    const rightX = fwdZ;
    const rightZ = -fwdX;

    // Decompose current velocity into body-longitudinal and body-transverse components
    const vPar = this.vx * fwdX + this.vz * fwdZ;
    const vPerp = this.vx * rightX + this.vz * rightZ;

    // Unconditionally stable semi-implicit quadratic + linear drag damping
    const parDamp = clamp((DRAG_QUAD_PARALLEL * Math.abs(vPar) + DRAG_LIN_HORIZ) * subDt, 0, 0.92);
    const perpDamp = clamp((DRAG_QUAD_PERP * Math.abs(vPerp) + DRAG_LIN_HORIZ) * subDt, 0, 0.95);
    const nextPar = vPar * (1 - parDamp);
    const nextPerp = vPerp * (1 - perpDamp);

    // Steady-state thrust calibrated so average forward cruise matches `targetSpeed` under c_parallel * v^2 + c_lin * v
    const baseThrust = (DRAG_QUAD_PARALLEL * targetSpeed * targetSpeed + DRAG_LIN_HORIZ * targetSpeed) * strokeMult;
    this.vx = fwdX * nextPar + rightX * nextPerp + wishX * baseThrust * subDt;
    this.vz = fwdZ * nextPar + rightZ * nextPerp + wishZ * baseThrust * subDt;

    // Gentle speed ceiling safeguard (allows stroke pulse peaks without exceeding server travelCredit)
    const maxAllowed = Math.max(targetSpeed * 1.18, UNDERWATER_SURGE_SPEED * 1.12);
    const curSpd = Math.hypot(this.vx, this.vz);
    if (curSpd > maxAllowed && curSpd > 1e-4) {
      const s = maxAllowed / curSpd;
      this.vx *= s;
      this.vz *= s;
    }
  }

  /**
   * Advance amphibious locomotion by `dt` seconds and return the updated `ArenaSwimFrame` (zero allocations).
   */
  step(input: SwimStepInput): Readonly<ArenaSwimFrame> {
    const totalDt = clamp(input.dt, 0.0005, 0.05);
    this.lastTime = input.time;
    this.eventCount = 0;

    if (input.diveTogglePressed) {
      this.toggleDive();
    }
    if (input.ascend) {
      this.diveLatched = false;
      this.submergeAssistTimer = 0;
    }

    const prevMode = this.frame.mode;
    const waterSurfaceY = this.waveFn(this.x, this.z, input.time);
    const meanSurfaceY = this.waveFn === arenaWaveHeight ? ARENA_WATER_Y : waterSurfaceY;
    const groundY = arenaSwimGroundY(this.x, this.z, this.y, this.groundFn);
    const waterDepth = Math.max(0, waterSurfaceY - groundY);
    const modeWaterDepth = Math.max(0, meanSurfaceY - groundY);

    // Determine desired horizontal direction in world space
    const rawWishLen = Math.hypot(input.forward, input.right);
    const wishMag = Math.min(1, rawWishLen);
    const invLen = rawWishLen > 1e-4 ? wishMag / rawWishLen : 0;
    const normFwd = input.forward * invLen;
    const normRight = input.right * invLen;
    const sinYaw = Math.sin(input.cameraYaw);
    const cosYaw = Math.cos(input.cameraYaw);
    const dirX = sinYaw * normFwd - cosYaw * normRight;
    const dirZ = cosYaw * normFwd + sinYaw * normRight;

    // Resolve next ArenaWaterMode using still-water bathymetric depth + hysteresis bands so wave crests/troughs
    // never chatter modes and stay 1:1 aligned with `arenaWaterDepth >= 0.85 m` shoreline handoffs.
    let nextMode: ArenaWaterMode = prevMode;
    const wadeThreshold = prevMode === 'land' ? WADE_MIN_DEPTH : WADE_EXIT_DEPTH;
    const swimThreshold =
      prevMode === 'surface_swim' || prevMode === 'underwater_dive' ? SWIM_EXIT_DEPTH : SWIM_MIN_DEPTH;
    const minDiveColumn = Math.max(DIVE_EXIT_WATER_DEPTH, SEABED_MIN_CLEARANCE + SURFACE_PRONE_OFFSET + 0.02);

    const steepLookDive =
      modeWaterDepth >= DIVE_MIN_WATER_DEPTH &&
      input.cameraPitch < -0.44 &&
      normFwd > 0.35 &&
      !input.ascend;
    const wantsDive =
      modeWaterDepth >= DIVE_MIN_WATER_DEPTH &&
      (input.diveHeld || this.diveLatched || steepLookDive);

    if (modeWaterDepth < wadeThreshold) {
      nextMode = 'land';
      this.diveLatched = false;
      this.submergeAssistTimer = 0;
    } else if (modeWaterDepth < swimThreshold) {
      nextMode = 'wading';
      this.diveLatched = false;
      this.submergeAssistTimer = 0;
    } else if (prevMode === 'underwater_dive') {
      const currentDiveDepth = waterSurfaceY - SURFACE_PRONE_OFFSET - this.y;
      if (modeWaterDepth < minDiveColumn || (currentDiveDepth <= 0.14 && !wantsDive && this.vy >= -0.05)) {
        nextMode = 'surface_swim';
        this.diveLatched = false;
        this.submergeAssistTimer = 0;
      } else {
        nextMode = 'underwater_dive';
      }
    } else if (wantsDive) {
      nextMode = 'underwater_dive';
      if (input.diveHeld || this.diveLatched) {
        this.submergeAssistTimer = Math.max(this.submergeAssistTimer, 0.58);
      }
    } else {
      nextMode = 'surface_swim';
    }

    // Mode transition splash/submerge events and meniscus velocity conditioning
    if (prevMode === 'land' && (nextMode === 'wading' || nextMode === 'surface_swim')) {
      this.pushEvent('water_entry', this.x, waterSurfaceY, this.z, nextMode === 'surface_swim' ? 0.85 : 0.45, false);
      if (nextMode === 'surface_swim') {
        this.vy = clamp(this.vy, -1.65, 0.25);
      }
    } else if (prevMode === 'wading' && nextMode === 'surface_swim') {
      this.vy = 0;
    } else if (prevMode !== 'underwater_dive' && nextMode === 'underwater_dive') {
      this.pushEvent('dive_submerge', this.x, waterSurfaceY, this.z, 0.78, true);
      if (!input.ascend) {
        this.vy = Math.min(this.vy, -0.72);
      }
    } else if (prevMode === 'underwater_dive' && nextMode === 'surface_swim') {
      this.pushEvent('resurface', this.x, waterSurfaceY, this.z, 0.72, false);
      this.vy = clamp(this.vy * 0.18, -0.16, 0.16);
      this.proneBlend = Math.max(this.proneBlend, 0.88);
    }

    // Fixed-step sub-stepping (`subDt <= 1/60`) for frame-rate-independent water physics
    const subSteps = Math.max(1, Math.ceil(totalDt / FIXED_SUBSTEP_MAX_DT));
    const subDt = totalDt / subSteps;

    for (let s = 0; s < subSteps; s++) {
      const subTime = input.time - totalDt + (s + 1) * subDt;

      if (nextMode === 'land') {
        const maxSpeed = input.sprint ? 3.35 : 1.65;
        const accel = 1 - Math.exp(-11 * subDt);
        this.vx += (dirX * maxSpeed - this.vx) * accel;
        this.vz += (dirZ * maxSpeed - this.vz) * accel;
        this.moveSweptHorizontal(this.vx * subDt, this.vz * subDt);
        const newGround = arenaSwimGroundY(this.x, this.z, this.y, this.groundFn);
        this.followGroundSmoothly(newGround);
        this.vy = 0;
        this.pitch += (0 - this.pitch) * (1 - Math.exp(-10 * subDt));
        this.proneBlend += (0 - this.proneBlend) * (1 - Math.exp(-8 * subDt));
        this.rollEnvelope += (0 - this.rollEnvelope) * (1 - Math.exp(-10 * subDt));
        this.bodyRoll += (0 - this.bodyRoll) * (1 - Math.exp(-10 * subDt));
      } else if (nextMode === 'wading') {
        // Knee-to-waist hydrodynamic drag (comfortable 1.0x -> 0.68x ramp)
        const wadeFrac = clamp((modeWaterDepth - WADE_MIN_DEPTH) / (SWIM_MIN_DEPTH - WADE_MIN_DEPTH), 0, 1);
        const dragScale = 1 - 0.32 * wadeFrac;
        const maxSpeed = (input.sprint ? 3.15 : 1.6) * dragScale;
        const accel = 1 - Math.exp(-8.5 * subDt);
        this.vx += (dirX * maxSpeed - this.vx) * accel;
        this.vz += (dirZ * maxSpeed - this.vz) * accel;
        const prevX = this.x;
        const prevZ = this.z;
        this.moveSweptHorizontal(this.vx * subDt, this.vz * subDt);
        const newGround = arenaSwimGroundY(this.x, this.z, this.y, this.groundFn);
        this.followGroundSmoothly(newGround);
        this.vy = 0;
        this.pitch += (0 - this.pitch) * (1 - Math.exp(-10 * subDt));
        this.proneBlend += (0 - this.proneBlend) * (1 - Math.exp(-8 * subDt));
        this.rollEnvelope += (0 - this.rollEnvelope) * (1 - Math.exp(-10 * subDt));
        this.bodyRoll += (0 - this.bodyRoll) * (1 - Math.exp(-10 * subDt));

        this.wadeDistanceAcc += Math.hypot(this.x - prevX, this.z - prevZ);
        if (this.wadeDistanceAcc >= 1.05) {
          this.wadeDistanceAcc = 0;
          this.pushEvent('wade_step', this.x, waterSurfaceY, this.z, 0.35 + 0.3 * wadeFrac, false);
        }
      } else if (nextMode === 'surface_swim') {
        // Calibrated surface swimming: quadratic anisotropic drag + stroke-pulse thrust + Archimedes spring
        const curHoriz = Math.hypot(this.vx, this.vz);
        const isFreestyle = (input.sprint && wishMag > 0.15) || curHoriz > 1.85;
        const targetSpeed = input.sprint ? SURFACE_SPRINT_SPEED : SURFACE_CRUISE_SPEED;

        // Advance stroke phase and compute propulsion pulse T(phi)
        const cadence =
          curHoriz < 0.28 && wishMag < 0.1
            ? 0.55
            : isFreestyle
              ? 1.05 + curHoriz * 0.34
              : 0.78 + curHoriz * 0.26;
        this.strokePhase += cadence * subDt;
        const phaseFrac = this.strokePhase - Math.floor(this.strokePhase);
        const strokeMult = wishMag > 0.08 ? strokeThrustMultiplier(phaseFrac, isFreestyle) : 1.0;

        this.integrateWaterHorizontal(dirX, dirZ, targetSpeed, strokeMult, subDt);
        this.moveSweptHorizontal(this.vx * subDt, this.vz * subDt);

        const horizSpeed = Math.hypot(this.vx, this.vz);
        const liveWaveY = this.waveFn(this.x, this.z, subTime);
        const liveMeanWaveY = this.waveFn === arenaWaveHeight ? ARENA_WATER_Y : liveWaveY;
        const liveGroundY = arenaSwimGroundY(this.x, this.z, this.y, this.groundFn);
        const liveStillDepth = Math.max(0, liveMeanWaveY - liveGroundY);

        // Smooth C^1 littoral grounding blend across [0.72 m .. 1.40 m] depth so feet stay grounded at 0.68..0.85 m
        // (`0.0 mm` vertical step discontinuity across `wading <-> surface_swim`) and lift smoothly into open water.
        const littoralBlend = smoothstep(SWIM_EXIT_DEPTH + 0.04, SURFACE_TREAD_OFFSET + 0.14, liveStillDepth);
        const targetProne = smoothstep(0.22, 0.78, horizSpeed) * littoralBlend;
        this.proneBlend += (targetProne - this.proneBlend) * (1 - Math.exp(-4.8 * subDt));

        // Calibrated waterline offset blending smoothly from upright tread (1.26 m) to prone swim (1.12 m)
        const surfaceOffset =
          SURFACE_TREAD_OFFSET + (SURFACE_PRONE_OFFSET - SURFACE_TREAD_OFFSET) * this.proneBlend;
        const gentleBob =
          Math.sin(subTime * 2.05 + this.x * 0.18) * (0.028 * (1 - 0.35 * this.proneBlend)) * littoralBlend;
        const effectiveWaveY = liveMeanWaveY + (liveWaveY - liveMeanWaveY) * littoralBlend;
        const shallowFloatY = Math.max(liveGroundY, effectiveWaveY - surfaceOffset + gentleBob);
        const targetSurfaceY = liveGroundY + (shallowFloatY - liveGroundY) * littoralBlend;

        if (littoralBlend <= 0.05) {
          this.vy = 0;
          this.followGroundSmoothly(liveGroundY);
        } else {
          // Archimedes buoyant spring-damper (omega_n = 3.2 rad/s, zeta = 0.78) with shallow littoral grounding convergence
          const surfaceDelta = clamp(targetSurfaceY - this.y, -0.85, 0.85);
          const ay = surfaceDelta * ARCHIMEDES_K - this.vy * ARCHIMEDES_C;
          this.vy += ay * subDt;
          if (littoralBlend < 0.9) {
            this.vy *= 1 - (1 - littoralBlend) * (1 - Math.exp(-16 * subDt));
          }
          this.y += this.vy * subDt;
          if (littoralBlend < 0.9) {
            const shorePull = (1 - littoralBlend) * (1 - Math.exp(-24 * subDt));
            this.y += clamp((targetSurfaceY - this.y) * shorePull, -MAX_GROUND_SLEW_PER_SUBSTEP, MAX_GROUND_SLEW_PER_SUBSTEP);
          }
          if (this.y < liveGroundY) {
            this.followGroundSmoothly(liveGroundY);
            if (this.vy < 0) this.vy = 0;
          }
        }

        const targetPitch =
          horizSpeed > 0.28 ? -0.11 * clamp(horizSpeed / SURFACE_SPRINT_SPEED, 0, 1) * littoralBlend : 0;
        this.pitch += (targetPitch - this.pitch) * (1 - Math.exp(-6.5 * subDt));

        const targetRollEnv = smoothstep(1.65, 2.05, horizSpeed) * 0.24 * littoralBlend;
        this.rollEnvelope += (targetRollEnv - this.rollEnvelope) * (1 - Math.exp(-6.0 * subDt));
        this.bodyRoll = Math.sin(phaseFrac * Math.PI * 2) * this.rollEnvelope;

        const cycle = Math.floor(this.strokePhase);
        if (cycle !== this.prevStrokeCycle) {
          this.prevStrokeCycle = cycle;
          if (horizSpeed > 0.24) {
            this.pushEvent(
              'swim_stroke',
              this.x,
              liveWaveY,
              this.z,
              clamp(0.32 + horizSpeed * 0.18, 0.32, 0.85),
              false,
            );
          }
        }
      } else {
        // `underwater_dive`: Full 3D camera-relative propulsion, quadratic anisotropic drag,
        // neutral-buoyancy soft hover (+0.035 m/s^2), and smooth Space ascent.
        const curSpeed3D = Math.hypot(this.vx, this.vy, this.vz);
        const targetSpeed = input.sprint ? UNDERWATER_SURGE_SPEED : UNDERWATER_CRUISE_SPEED;
        const isSurge = input.sprint && wishMag > 0.15;

        const cosPitch = Math.cos(input.cameraPitch);
        const sinPitch = Math.sin(input.cameraPitch);
        let wishX = sinYaw * normFwd * cosPitch - cosYaw * normRight;
        let wishZ = cosYaw * normFwd * cosPitch + sinYaw * normRight;
        let wishY = normFwd * sinPitch;

        const liveWaveY = this.waveFn(this.x, this.z, subTime);
        const currentDiveDepth = liveWaveY - SURFACE_PRONE_OFFSET - this.y;

        if (this.submergeAssistTimer > 0) {
          this.submergeAssistTimer = Math.max(0, this.submergeAssistTimer - subDt);
          if (currentDiveDepth >= 0.85) {
            this.submergeAssistTimer = 0;
          }
        }

        let explicitVertControl = false;
        if (input.ascend) {
          wishY = 1.0;
          explicitVertControl = true;
        } else if (input.diveHeld) {
          wishY = Math.min(wishY, -0.82);
          explicitVertControl = true;
        } else if (this.submergeAssistTimer > 0 && currentDiveDepth < 0.85) {
          // Smooth initial submergence after tapping KeyC from the surface
          wishY = Math.min(wishY, -0.78);
          explicitVertControl = true;
        } else if (Math.abs(wishY) > 0.08) {
          explicitVertControl = true;
        }

        const wish3DLen = Math.hypot(wishX, wishY, wishZ);
        if (wish3DLen > 1) {
          wishX /= wish3DLen;
          wishY /= wish3DLen;
          wishZ /= wish3DLen;
        }

        const isHoveringNow = curSpeed3D < 0.32 && wish3DLen < 0.1;
        const cadence = isHoveringNow ? 0.48 : 0.85 + curSpeed3D * 0.3;
        this.strokePhase += cadence * subDt;
        const phaseFrac = this.strokePhase - Math.floor(this.strokePhase);
        const strokeMult = wish3DLen > 0.08 ? strokeThrustMultiplier(phaseFrac, isSurge) : 1.0;

        this.integrateWaterHorizontal(wishX, wishZ, targetSpeed, strokeMult, subDt);

        // Vertical propulsion + neutral-buoyancy soft hover (+0.035 m/s^2) + vertical quadratic/linear drag
        const vertMaxSpeed = input.ascend
          ? input.sprint
            ? 2.15
            : 1.75
          : input.sprint
            ? 2.05
            : 1.5;
        if (explicitVertControl) {
          // Smooth meniscus brake in top 0.65 m during ascent so Space resurfacing never overshoots into dry air
          const ascentTaper =
            wishY > 0 ? 0.16 + 0.84 * smoothstep(0.0, 0.65, Math.max(0, currentDiveDepth)) : 1.0;
          const vertThrust =
            (DRAG_QUAD_VERT * vertMaxSpeed * vertMaxSpeed + DRAG_LIN_VERT * vertMaxSpeed) *
            strokeMult *
            ascentTaper;
          this.vy += wishY * vertThrust * subDt;
        } else {
          // Gentle positive neutral buoyancy + calm organic hover wave (zero uncontrolled sinking)
          const hoverWave = Math.sin(subTime * 1.35) * 0.045;
          this.vy += (UNDERWATER_NEUTRAL_BUOYANCY + hoverWave) * subDt;
        }

        const meniscusDampBoost =
          this.vy > 0 && currentDiveDepth < 0.55 ? (1 - clamp(currentDiveDepth / 0.55, 0, 1)) * 4.2 : 0;
        const vertDamp = clamp(
          (DRAG_QUAD_VERT * Math.abs(this.vy) + DRAG_LIN_VERT + meniscusDampBoost) * subDt,
          0,
          0.95,
        );
        this.vy *= 1 - vertDamp;

        this.moveSweptHorizontal(this.vx * subDt, this.vz * subDt);
        this.y += this.vy * subDt;

        const postWaveY = this.waveFn(this.x, this.z, subTime);
        const liveGroundY = arenaSwimGroundY(this.x, this.z, this.y, this.groundFn);
        const minSafeY = liveGroundY + SEABED_MIN_CLEARANCE;
        const maxSafeY = postWaveY - SURFACE_PRONE_OFFSET;

        if (minSafeY >= maxSafeY - 0.02) {
          // Water column has shoaled below `0.65 m + 1.12 m`: keep strict seabed clearance and hand off to surface_swim
          if (this.y < minSafeY) this.y = minSafeY;
          this.vy = clamp(this.vy, -0.18, 0.18);
          this.proneBlend = Math.max(this.proneBlend, 0.88);
          nextMode = 'surface_swim';
          this.diveLatched = false;
          this.submergeAssistTimer = 0;
          this.pushEvent('resurface', this.x, postWaveY, this.z, 0.65, false);
        } else {
          if (this.y >= maxSafeY) {
            this.y = maxSafeY;
            if (input.ascend || !wantsDive) {
              this.vy = clamp(this.vy * 0.18, -0.16, 0.16);
              this.proneBlend = Math.max(this.proneBlend, 0.88);
              nextMode = 'surface_swim';
              this.diveLatched = false;
              this.submergeAssistTimer = 0;
              this.pushEvent('resurface', this.x, postWaveY, this.z, 0.68, false);
            } else if (this.vy > 0) {
              this.vy = 0;
            }
          }
          // Enforce strict seabed clearance (`SEABED_MIN_CLEARANCE = 0.65 m`) unconditionally after surface clamp
          if (this.y < minSafeY) {
            this.y = minSafeY;
            if (this.vy < 0) this.vy = 0;
          }
        }

        const horizSubmerged = Math.hypot(this.vx, this.vz);
        const speed3D = Math.hypot(horizSubmerged, this.vy);
        const underwaterTread = speed3D < 0.32 && Math.abs(this.vy) < 0.25;
        const targetPitch = underwaterTread
          ? 0
          : clamp(Math.atan2(this.vy, horizSubmerged + 0.38), -0.86, 0.86);
        this.pitch += (targetPitch - this.pitch) * (1 - Math.exp(-6.5 * subDt));
        this.proneBlend += ((underwaterTread ? 0.25 : 1) - this.proneBlend) * (1 - Math.exp(-5.0 * subDt));

        const targetRollEnv = isSurge && !underwaterTread ? 0.14 : 0;
        this.rollEnvelope += (targetRollEnv - this.rollEnvelope) * (1 - Math.exp(-6.0 * subDt));
        this.bodyRoll = Math.sin(phaseFrac * Math.PI * 2) * this.rollEnvelope;

        const cycle = Math.floor(this.strokePhase);
        if (cycle !== this.prevStrokeCycle) {
          this.prevStrokeCycle = cycle;
          if (speed3D > 0.28) {
            this.pushEvent(
              'swim_stroke',
              this.x,
              this.y + 1.05,
              this.z,
              clamp(0.28 + speed3D * 0.16, 0.28, 0.72),
              true,
            );
          }
        }
      }

      // Smooth aquatic heading turn (realistic turn inertia in water, responsive on land)
      const stepHoriz = Math.hypot(this.vx, this.vz);
      if (stepHoriz > 0.08) {
        const desiredYaw = Math.atan2(this.vx, this.vz);
        const deltaYaw = Math.atan2(Math.sin(desiredYaw - this.yaw), Math.cos(desiredYaw - this.yaw));
        const turnRate =
          nextMode === 'underwater_dive' ? 4.8 : nextMode === 'surface_swim' ? 5.4 : 10.0;
        this.yaw += deltaYaw * (1 - Math.exp(-turnRate * subDt));
      }
    }

    // Recompute final post-step frame metrics with zero allocations
    const horizSpeed = Math.hypot(this.vx, this.vz);
    const speed3D = Math.hypot(this.vx, this.vy, this.vz);
    const finalWaveY = this.waveFn(this.x, this.z, input.time);
    const finalGroundY = arenaSwimGroundY(this.x, this.z, this.y, this.groundFn);
    const finalWaterDepth = Math.max(0, finalWaveY - finalGroundY);
    const diveDepth =
      nextMode === 'underwater_dive'
        ? Math.max(0, finalWaveY - SURFACE_PRONE_OFFSET - this.y)
        : 0;
    const isTreading =
      nextMode === 'surface_swim'
        ? horizSpeed < 0.28
        : nextMode === 'underwater_dive'
          ? horizSpeed < 0.32 && Math.abs(this.vy) < 0.25
          : false;
    const submersion =
      nextMode === 'land'
        ? 0
        : nextMode === 'wading'
          ? clamp((finalWaterDepth - WADE_MIN_DEPTH) / 1.15, 0.08, 0.55)
          : nextMode === 'surface_swim'
            ? isTreading
              ? 0.66
              : 0.62
            : clamp(0.72 + diveDepth / 1.1, 0.72, 1.0);
    const normStrokePhase = this.strokePhase - Math.floor(this.strokePhase);

    this.frame.mode = nextMode;
    this.frame.waterDepth = finalWaterDepth;
    this.frame.submersion = submersion;
    this.frame.diveDepth = diveDepth;
    this.frame.strokeSpeed = nextMode === 'underwater_dive' ? speed3D : horizSpeed;
    this.frame.pitch = this.pitch;
    this.frame.verticalSpeed = this.vy;
    this.frame.isTreading = isTreading;
    this.frame.strokePhase = normStrokePhase < 0 ? normStrokePhase + 1 : normStrokePhase;
    this.frame.bodyRoll = this.bodyRoll;

    // Keep wake source updated for `arenaSea.ts` surface ripples
    this.wakeSource.x = this.x;
    this.wakeSource.z = this.z;
    this.wakeSource.yaw = this.yaw;
    this.wakeSource.speed =
      nextMode === 'surface_swim' || nextMode === 'wading' ? Math.max(0.18, horizSpeed) : 0;

    return this.frame;
  }
}

/**
 * Evaluate a remote multiplayer peer's `ArenaSwimFrame` deterministically from their replicated `(x, y, z)` pose
 * and real horizontal speed so peers tread calmly when stationary, swim naturally at waterline, and dive smoothly
 * without adding extra STOMP packet fields.
 */
export function evaluatePeerSwimFrame(
  x: number,
  y: number,
  z: number,
  speed: number,
  time: number,
  out: ArenaSwimFrame,
  waveFn: (x: number, z: number, t: number) => number = arenaWaveHeight,
  groundFn?: (x: number, z: number, currentY: number) => number,
): ArenaSwimFrame {
  const horizSpeed = Number.isFinite(speed) && speed > 0 ? speed : 0;
  const waveY = waveFn(x, z, time);
  const groundY = arenaSwimGroundY(x, z, y, groundFn);
  const waterDepth = Math.max(0, waveY - groundY);
  const belowSurface = waveY - SURFACE_PRONE_OFFSET - y;

  if (waterDepth < WADE_MIN_DEPTH || y > waveY + 0.18) {
    out.mode = 'land';
    out.waterDepth = waterDepth;
    out.submersion = 0;
    out.diveDepth = 0;
    out.strokeSpeed = horizSpeed;
    out.pitch = 0;
    out.verticalSpeed = 0;
    out.isTreading = false;
    out.strokePhase = 0;
    out.bodyRoll = 0;
    return out;
  }
  if (waterDepth < SWIM_MIN_DEPTH) {
    out.mode = 'wading';
    out.waterDepth = waterDepth;
    out.submersion = clamp((waterDepth - WADE_MIN_DEPTH) / 1.15, 0.08, 0.55);
    out.diveDepth = 0;
    out.strokeSpeed = horizSpeed;
    out.pitch = 0;
    out.verticalSpeed = 0;
    out.isTreading = false;
    out.strokePhase = 0;
    out.bodyRoll = 0;
    return out;
  }
  // Matches both local (`waveY - 1.12 - diveDepth`) and replicated (`ARENA_SWIM_SUPPORT_Y - diveDepth`) diving depths
  if (belowSurface > 0.32 && waterDepth >= DIVE_MIN_WATER_DEPTH) {
    const isTreading = horizSpeed < 0.32;
    const cadence = isTreading ? 0.48 : 0.85 + horizSpeed * 0.3;
    const rawPhase = (time * cadence) % 1;
    const phase = rawPhase < 0 ? rawPhase + 1 : rawPhase;
    out.mode = 'underwater_dive';
    out.waterDepth = waterDepth;
    out.diveDepth = Math.max(0, belowSurface);
    out.submersion = clamp(0.72 + out.diveDepth / 1.1, 0.72, 1.0);
    out.strokeSpeed = horizSpeed;
    out.pitch = isTreading ? 0 : clamp(-0.16 * clamp(horizSpeed / UNDERWATER_SURGE_SPEED, 0, 1), -0.65, 0.65);
    out.verticalSpeed = 0;
    out.isTreading = isTreading;
    out.strokePhase = phase;
    out.bodyRoll = 0;
    return out;
  }

  const isTreading = horizSpeed < 0.28;
  const isFreestyle = horizSpeed > 1.85;
  const cadence = isTreading
    ? 0.55
    : isFreestyle
      ? 1.05 + horizSpeed * 0.34
      : 0.78 + horizSpeed * 0.26;
  const rawPhase = (time * cadence) % 1;
  const phase = rawPhase < 0 ? rawPhase + 1 : rawPhase;

  out.mode = 'surface_swim';
  out.waterDepth = waterDepth;
  out.submersion = isTreading ? 0.66 : 0.62;
  out.diveDepth = 0;
  out.strokeSpeed = horizSpeed;
  out.pitch = isTreading ? 0 : -0.11 * clamp(horizSpeed / SURFACE_SPRINT_SPEED, 0, 1);
  out.verticalSpeed = 0;
  out.isTreading = isTreading;
  out.strokePhase = phase;
  out.bodyRoll = isFreestyle ? Math.sin(phase * Math.PI * 2) * 0.24 : 0;
  return out;
}

/**
 * Lightweight GPU-instanced Swimmer Ripple Rings and Underwater Rising Dive Bubbles (`2` draw calls max, zero GC).
 */
export class SwimVisualEffects {
  private readonly scene: T.Scene;
  private readonly ringGeo: T.RingGeometry;
  private readonly ringMat: T.MeshBasicMaterial;
  private readonly ringMesh: T.InstancedMesh;
  private readonly ringCap: number;
  private readonly ringData: Float32Array; // stride 5: x, y, z, age, life
  private ringCursor = 0;

  private readonly bubbleGeo: T.IcosahedronGeometry;
  private readonly bubbleMat: T.MeshBasicMaterial;
  private readonly bubbleMesh: T.InstancedMesh;
  private readonly bubbleCap: number;
  private readonly bubbleData: Float32Array; // stride 6: x, y, z, radius, age, life
  private bubbleCursor = 0;
  private bubbleTimer = 0;

  private readonly dummyMat = new T.Matrix4();
  private readonly dummyPos = new T.Vector3();
  private readonly dummyQuat = new T.Quaternion();
  private readonly dummyScale = new T.Vector3();

  constructor(scene: T.Scene, tier: ArenaQualityTier = 'high') {
    this.scene = scene;
    const low = tier === 'low';
    this.ringCap = low ? 24 : 48;
    this.bubbleCap = low ? 36 : 96;

    // Seed slot 0 with a valid finite degenerate matrix so warmup draws (`count = 1`) never read uninitialized data
    this.dummyPos.set(0, -999, 0);
    this.dummyQuat.identity();
    this.dummyScale.set(0, 0, 0);
    this.dummyMat.compose(this.dummyPos, this.dummyQuat, this.dummyScale);

    this.ringGeo = new T.RingGeometry(0.18, 0.34, low ? 16 : 24);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.ringMat = new T.MeshBasicMaterial({
      color: '#eaf9f8',
      transparent: true,
      opacity: 0.48,
      depthWrite: false,
      side: T.DoubleSide,
    });
    this.ringMesh = new T.InstancedMesh(this.ringGeo, this.ringMat, this.ringCap);
    this.ringMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    this.ringMesh.setMatrixAt(0, this.dummyMat);
    this.ringMesh.instanceMatrix.needsUpdate = true;
    this.ringMesh.frustumCulled = false;
    this.ringMesh.renderOrder = 3;
    this.ringMesh.count = 0;
    this.ringData = new Float32Array(this.ringCap * 5);
    for (let i = 0; i < this.ringCap; i++) this.ringData[i * 5 + 3] = 99;
    scene.add(this.ringMesh);

    this.bubbleGeo = new T.IcosahedronGeometry(1, low ? 0 : 1);
    this.bubbleMat = new T.MeshBasicMaterial({
      color: '#c9f3ff',
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
    });
    this.bubbleMesh = new T.InstancedMesh(this.bubbleGeo, this.bubbleMat, this.bubbleCap);
    this.bubbleMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    this.bubbleMesh.setMatrixAt(0, this.dummyMat);
    this.bubbleMesh.instanceMatrix.needsUpdate = true;
    this.bubbleMesh.frustumCulled = false;
    this.bubbleMesh.renderOrder = 3;
    this.bubbleMesh.count = 0;
    this.bubbleData = new Float32Array(this.bubbleCap * 6);
    for (let i = 0; i < this.bubbleCap; i++) this.bubbleData[i * 6 + 4] = 99;
    scene.add(this.bubbleMesh);
  }

  spawnSurfaceRipple(x: number, waterY: number, z: number, strength = 0.6): void {
    const base = this.ringCursor * 5;
    this.ringCursor = (this.ringCursor + 1) % this.ringCap;
    this.ringData[base] = x;
    this.ringData[base + 1] = waterY + 0.035;
    this.ringData[base + 2] = z;
    this.ringData[base + 3] = 0;
    this.ringData[base + 4] = 0.75 + strength * 0.55;
  }

  spawnDiveBubble(x: number, y: number, z: number, radius = 0.035): void {
    if (y >= ARENA_WATER_Y - 0.08) return;
    const base = this.bubbleCursor * 6;
    this.bubbleCursor = (this.bubbleCursor + 1) % this.bubbleCap;
    this.bubbleData[base] = x + (Math.random() - 0.5) * 0.24;
    this.bubbleData[base + 1] = y;
    this.bubbleData[base + 2] = z + (Math.random() - 0.5) * 0.24;
    this.bubbleData[base + 3] = radius * (0.75 + Math.random() * 0.55);
    this.bubbleData[base + 4] = 0;
    this.bubbleData[base + 5] = 1.6 + Math.random() * 1.4;
  }

  ingestEvents(events: readonly SwimRippleEvent[]): void {
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.underwater) {
        const bubbleY = Math.min(ev.y + 0.15, ARENA_WATER_Y - 0.12);
        for (let k = 0; k < 3; k++) {
          this.spawnDiveBubble(ev.x, bubbleY, ev.z, 0.032);
        }
      } else if (ev.kind !== 'dock_climb') {
        this.spawnSurfaceRipple(ev.x, ev.y, ev.z, ev.strength);
      }
    }
  }

  update(dt: number, time: number, swimmerFrame?: Readonly<ArenaSwimFrame>, sx = 0, sy = 0, sz = 0): void {
    if (swimmerFrame?.mode === 'underwater_dive') {
      this.bubbleTimer += dt;
      if (this.bubbleTimer >= 0.28) {
        this.bubbleTimer = 0;
        // Spawn bubbles near the diver's upper chest/head relative to feet-origin `sy`
        const headBubbleY = Math.min(sy + 1.15, ARENA_WATER_Y - 0.12);
        this.spawnDiveBubble(sx, headBubbleY, sz, 0.028);
      }
    }

    // Update surface ripple rings
    let activeRings = 0;
    this.dummyQuat.identity();
    for (let i = 0; i < this.ringCap; i++) {
      const b = i * 5;
      const age = this.ringData[b + 3] + dt;
      const life = this.ringData[b + 4];
      if (age >= life) {
        this.ringData[b + 3] = 99;
        continue;
      }
      this.ringData[b + 3] = age;
      const u = age / Math.max(0.01, life);
      const scale = (0.45 + u * 2.65) * (1 - u * 0.15);
      this.dummyPos.set(this.ringData[b], this.ringData[b + 1], this.ringData[b + 2]);
      this.dummyScale.set(scale, 1, scale);
      this.dummyMat.compose(this.dummyPos, this.dummyQuat, this.dummyScale);
      this.ringMesh.setMatrixAt(activeRings++, this.dummyMat);
    }
    this.ringMesh.count = activeRings;
    if (activeRings > 0) this.ringMesh.instanceMatrix.needsUpdate = true;

    // Update rising helical underwater bubbles
    let activeBubbles = 0;
    for (let i = 0; i < this.bubbleCap; i++) {
      const b = i * 6;
      const age = this.bubbleData[b + 4] + dt;
      const life = this.bubbleData[b + 5];
      const nextY = this.bubbleData[b + 1] + dt * 0.92;
      if (age >= life || nextY >= ARENA_WATER_Y - 0.05) {
        this.bubbleData[b + 4] = 99;
        continue;
      }
      this.bubbleData[b + 4] = age;
      this.bubbleData[b + 1] = nextY;
      const wobbleX = Math.sin(time * 4.2 + i * 1.7) * 0.04;
      const wobbleZ = Math.cos(time * 3.7 + i * 2.3) * 0.04;
      const u = age / Math.max(0.01, life);
      const rad = this.bubbleData[b + 3] * (1 - u * 0.35);
      this.dummyPos.set(this.bubbleData[b] + wobbleX, nextY, this.bubbleData[b + 2] + wobbleZ);
      this.dummyScale.setScalar(Math.max(0.004, rad));
      this.dummyMat.compose(this.dummyPos, this.dummyQuat, this.dummyScale);
      this.bubbleMesh.setMatrixAt(activeBubbles++, this.dummyMat);
    }
    this.bubbleMesh.count = activeBubbles;
    if (activeBubbles > 0) this.bubbleMesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.ringMesh);
    this.scene.remove(this.bubbleMesh);
    this.ringGeo.dispose();
    this.ringMat.dispose();
    this.bubbleGeo.dispose();
    this.bubbleMat.dispose();
  }
}
