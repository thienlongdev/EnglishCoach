import { CATALOG } from '../v3/game-core/index.mjs';
import { getActiveCarSpec, type CarSpec } from '../v3/vehicles/car.mjs';
import type { LifeWalk } from '../walk';
import type { Wallet } from './session';
import {
  MAX_VEHICLE_SUBSTEPS,
  WORLD_BOUNDARY_PADDING_CAR,
  ackermannWheelSteer,
  computeBoundsPenetration,
  computeFilteredRoadSlopeRad,
  computeTireSurfaceGrip,
  createChassisState,
  createVehicleLightState,
  createWheelContacts,
  getCarHandlingProfile,
  injectDriverWeightDip,
  queryHornNpcReaction,
  resetSuspension,
  resolveCurbDeflection,
  setManualBlinker,
  slidePoseAlongBounds,
  stepCarDynamics,
  stepIdleCarSuspension,
  stepCarSuspension,
  stepVehicleLights,
  toggleHeadlightsMode,
  triggerVehicleHorn,
  type BlinkerDirection,
  type CarClass,
  type CarHandlingProfile,
  type ChassisSuspensionState,
  type EnvironmentLightConditions,
  type HeadlightMode,
  type HornKind,
  type HornReactionQueryResult,
  type VehicleLightState,
  type WheelContactState,
  type WorldBoundsRect,
} from './vehicleDynamics';

type Point = { x: number; z: number };
export type CarPose = Point & { yaw: number };
export type CarClearance = (pose: CarPose, halfWidth: number, halfLength: number) => boolean;

export interface VehicleFootprint {
  x: number;
  z: number;
  yaw: number;
  halfWidth: number;
  halfLength: number;
  radius: number;
  driving: boolean;
}

export interface VehicleDriveOptions {
  handbrake?: boolean;
  hornHeld?: boolean;
  env?: EnvironmentLightConditions;
  nowSeconds?: number;
  fromHostLoop?: boolean;
}

// Axle measurements from the four articulated V3 models (metres).
const dimensions: Record<string, [number, number, number]> = {
  car_mango_micro: [1.744, 1.264, 2.95],
  car_river_sedan: [2.73, 1.534, 4.6],
  car_lotus_spider: [2.4, 1.534, 4.15],
  car_halo_vector: [2.932, 1.772, 4.95],
};

const DISMOUNT_DEGREES = [-90, 90, -60, 60, -120, 120, -30, 30, -150, 150, 0, 180] as const;
const DISMOUNT_RINGS = [1.4, 2.0, 2.8, 3.6, 4.4] as const;
const _fpPt: Point = { x: 0, z: 0 };
const _fpInnerPt: Point = { x: 0, z: 0 };
const _driveNextPose: CarPose = { x: 0, z: 0, yaw: 0 };
const _drivePivotPose: CarPose = { x: 0, z: 0, yaw: 0 };

export abstract class RoadVehicle {
  abstract get axles(): [number, number, number];
  protected readonly spawn: CarPose;
  spec: CarSpec | null = null;
  driving = false;
  speed = 0;
  steer = 0;
  spin = 0;
  door = 0;
  wetRoad = false;
  snowyRoad = false;
  lastThrottle = 0;
  lastCollisionImpulse = 0;
  lastBumpImpulse = 0;
  lastDoorOpen = false;
  doorToggleId = 0;
  /** True when the rider pressed dismount (`[E]`) above `0.6 m/s`; brakes smoothly and auto-dismounts via `consumeAutoDismount`. */
  pendingDismount = false;
  /** Most recent verified walkable exit point computed by `toggle()` on dismount. */
  lastDismountPos: Point | null = null;
  /** Guards against idle `rAF` `driveCar(dt, 0, 0, false)` zero-snapping programmatic `drive()` calls in the same frame. */
  externalDrivenSinceHostStep = false;
  readonly lights: VehicleLightState;
  protected doorTime = 0;
  protected stopping = false;
  protected brakeToZeroHold = 0;
  protected reverseLatchPrimed = false;
  protected clock = 0;
  protected lastEnv: EnvironmentLightConditions = { dayWeight: 1, rainWeight: 0, snowWeight: 0 };
  protected readonly parking: Record<string, CarPose> = {};
  protected idleSteppedThisFrame = false;
  protected envLightsSteppedThisFrame = false;

  brakeToStop() {
    this.stopping = this.driving;
  }

  readonly pose: CarPose;

  constructor(
    protected walk: LifeWalk,
    parked?: Point,
    yaw = Math.PI / 2,
    streetOffset = 4,
    hornKind: HornKind = 'car',
  ) {
    this.lights = createVehicleLightState(hornKind);
    const entrance = walk.house.doors.find((d) => d.id === 'entrance')!;
    const street = walk.city.ground
      .filter((g) => g.surface === 'road' && g.rect.x0 <= entrance.x && g.rect.x1 >= entrance.x)
      .sort(
        (a, b) =>
          Math.abs((a.rect.z0 + a.rect.z1) / 2 - entrance.z) -
          Math.abs((b.rect.z0 + b.rect.z1) / 2 - entrance.z),
      )[0];
    this.spawn = {
      x: entrance.x + streetOffset,
      z: street ? (street.rect.z0 + street.rect.z1) / 2 : entrance.z,
      yaw: Math.PI / 2,
    };
    this.pose = { ...this.spawn };
    if (parked && Number.isFinite(yaw) && this.onRoad(parked)) {
      Object.assign(this.pose, parked, { yaw });
    }
  }

  protected get boundaryPadding(): number {
    return WORLD_BOUNDARY_PADDING_CAR;
  }

  protected getWorldBounds(): WorldBoundsRect | null {
    const b = (this.walk as { city?: { bounds?: WorldBoundsRect } }).city?.bounds;
    return b ?? null;
  }

  protected effectiveBoundaryPadding(hw: number, hl: number): number {
    return Math.max(this.boundaryPadding, Math.hypot(hw, hl) + 0.08);
  }

  /** Checks whether `cand` overlaps solid house, enterable building, or decorative lot footprints (zero heap allocs). */
  protected hitsSolidArchitecture(cand: CarPose, hw: number, hl: number): boolean {
    const walkAny = this.walk as {
      house?: { footprint?: WorldBoundsRect };
      city?: {
        buildings?: readonly { rect: WorldBoundsRect }[];
        residences?: readonly { rect: WorldBoundsRect }[];
        lots?: readonly { rect: WorldBoundsRect }[];
      };
    };
    const cs = Math.sin(cand.yaw);
    const cc = Math.cos(cand.yaw);
    const inBox = (px: number, pz: number, r: WorldBoundsRect, pad: number): boolean =>
      px >= r.x0 - pad && px <= r.x1 + pad && pz >= r.z0 - pad && pz <= r.z1 + pad;

    for (let iz = -1; iz <= 1; iz++) {
      const z = iz * hl * 0.85;
      const px = cand.x + z * cs;
      const pz = cand.z + z * cc;
      const hf = walkAny.house?.footprint;
      if (hf && inBox(px, pz, hf, hw * 0.5)) return true;
      const blds = walkAny.city?.buildings;
      if (blds) {
        for (let i = 0; i < blds.length; i++) {
          if (inBox(px, pz, blds[i].rect, hw * 0.5)) return true;
        }
      }
      const res = walkAny.city?.residences;
      if (res) {
        for (let i = 0; i < res.length; i++) {
          if (inBox(px, pz, res[i].rect, hw * 0.5)) return true;
        }
      }
      const lots = walkAny.city?.lots;
      if (lots) {
        for (let i = 0; i < lots.length; i++) {
          if (inBox(px, pz, lots[i].rect, hw * 0.5)) return true;
        }
      }
    }
    return false;
  }

  protected onRoad(p: Point) {
    const region = this.walk.surface(p)?.region;
    return (
      region === 'road' ||
      region === 'crossing' ||
      region === 'garage' ||
      region === 'door:garage_out'
    );
  }

  protected restoreParking(saved: unknown, starter: string) {
    if (!saved || typeof saved !== 'object') return;
    for (const [id, pose] of Object.entries(saved)) {
      if (id !== starter && !/^ec_[a-f0-9]{20}$/.test(id)) continue;
      if (
        pose &&
        Number.isFinite(pose.x) &&
        Number.isFinite(pose.z) &&
        Number.isFinite(pose.yaw) &&
        this.onRoad(pose)
      ) {
        this.parking[id] = { x: pose.x, z: pose.z, yaw: pose.yaw };
      }
    }
  }

  snapshot() {
    if (this.spec) this.parking[this.spec.instanceId] = { ...this.pose };
    return this.parking;
  }

  protected switchInstance(id: string | undefined, initial?: CarPose) {
    if (id === this.spec?.instanceId) return;
    this.snapshot();
    this.driving = this.stopping = this.pendingDismount = false;
    this.brakeToZeroHold = 0;
    this.reverseLatchPrimed = false;
    this.speed = this.steer = this.spin = this.door = this.doorTime = 0;
    this.lastThrottle = 0;
    this.lastCollisionImpulse = 0;
    this.lastBumpImpulse = 0;
    this.lastDoorOpen = false;
    this.idleSteppedThisFrame = false;
    this.envLightsSteppedThisFrame = false;
    this.lights.braking = false;
    this.lights.reversing = false;
    this.lights.blinker = 0;
    this.lights.blinkerManual = false;
    this.lights.blinkerLit = false;
    this.lights.hornTimer = 0;
    this.lights.hornActive = false;
    Object.assign(this.pose, (id && this.parking[id]) || initial || this.spawn);
  }

  /**
   * Returns the exact oriented bounding box & bounding radius around the vehicle pose
   * for solid pedestrian, NPC, and player avoidance (`null` when no vehicle is spawned).
   */
  getFootprint(): VehicleFootprint | null {
    if (!this.spec) return null;
    const [, track, length] = this.axles;
    const halfWidth = track * 0.5 + 0.12;
    const halfLength = length * 0.5;
    return {
      x: this.pose.x,
      z: this.pose.z,
      yaw: this.pose.yaw,
      halfWidth,
      halfLength,
      radius: Math.hypot(halfWidth, halfLength),
      driving: this.driving,
    };
  }

  /**
   * Oriented bounding-box containment test in vehicle local space (`+Z` forward, `+X` left).
   */
  containsPoint(p: Point, pad = 0.28): boolean {
    const fp = this.getFootprint();
    if (!fp) return false;
    const dx = p.x - fp.x;
    const dz = p.z - fp.z;
    const maxR = fp.radius + pad;
    if (dx * dx + dz * dz > maxR * maxR) return false;
    const s = Math.sin(fp.yaw);
    const c = Math.cos(fp.yaw);
    const localX = dx * c - dz * s;
    const localZ = dx * s + dz * c;
    return (
      Math.abs(localX) <= fp.halfWidth + pad &&
      Math.abs(localZ) <= fp.halfLength + pad
    );
  }

  toggleHeadlights(): HeadlightMode {
    const next = toggleHeadlightsMode(this.lights);
    stepVehicleLights({
      lights: this.lights,
      dt: 0,
      nowSeconds: this.clock,
      driving: this.driving,
      speed: this.speed,
      throttle: 0,
      sideInput: 0,
      steer: this.steer,
      brake: false,
      env: this.lastEnv,
    });
    return next;
  }

  setBlinker(direction: BlinkerDirection): BlinkerDirection {
    return setManualBlinker(this.lights, direction);
  }

  soundHorn(nowSeconds = this.clock): number {
    this.clock = Math.max(this.clock, nowSeconds);
    return triggerVehicleHorn(this.lights, this.clock, 0.35);
  }

  queryHornNpcReaction(
    npcPos: Point,
    nowSeconds = this.clock,
    maxAgeSec = 2.2,
    maxRangeM = 10,
  ): HornReactionQueryResult {
    return queryHornNpcReaction(
      this.pose,
      npcPos,
      nowSeconds,
      this.lights.lastHornAt,
      maxAgeSec,
      maxRangeM,
    );
  }

  updateEnvironmentLights(
    env: EnvironmentLightConditions,
    dt = 0,
    nowSeconds?: number,
  ): void {
    this.lastEnv = env;
    this.wetRoad = env.rainWeight > 0.1;
    this.snowyRoad = (env.snowWeight ?? 0) > 0.1;
    if (nowSeconds !== undefined && Number.isFinite(nowSeconds)) {
      this.clock = Math.max(this.clock, nowSeconds);
    } else if (dt > 0) {
      this.clock += dt;
    }
    if (!this.driving) {
      stepVehicleLights({
        lights: this.lights,
        dt,
        nowSeconds: this.clock,
        driving: false,
        speed: this.speed,
        throttle: 0,
        sideInput: 0,
        steer: this.steer,
        brake: false,
        env: this.lastEnv,
      });
      if (dt > 0) this.envLightsSteppedThisFrame = true;
    }
  }

  /**
   * Resolves deferred `[E]` auto-dismount braking (`pendingDismount`) and a `~0.18 s` stationary
   * hold (`brakeToZeroHold`) at `v === 0` after braking from forward speed `v > 0.15 m/s` with `S`
   * (`throttle < 0`) before engaging reverse gear.
   */
  protected resolveLongitudinalIntent(
    dt: number,
    rawThrottle: number,
    rawBrake: boolean,
  ): { throttle: number; brake: boolean } {
    if (this.pendingDismount) {
      if (rawThrottle > 0.1) {
        this.pendingDismount = false;
        this.stopping = false;
      } else {
        this.stopping = true;
        return { throttle: 0, brake: true };
      }
    }

    if (this.speed > 0.15) {
      this.reverseLatchPrimed = true;
      this.brakeToZeroHold = 0.18;
    }

    if (rawThrottle >= -0.02) {
      if (this.speed <= 0.15) {
        this.reverseLatchPrimed = false;
        this.brakeToZeroHold = 0;
      }
      return { throttle: rawThrottle, brake: rawBrake };
    }

    if (this.reverseLatchPrimed) {
      if (this.speed > 0.03) {
        this.brakeToZeroHold = 0.18;
        return { throttle: 0, brake: true };
      }
      this.speed = 0;
      this.brakeToZeroHold = Math.max(0, this.brakeToZeroHold - dt);
      if (this.brakeToZeroHold > 0) {
        return { throttle: 0, brake: true };
      }
      this.reverseLatchPrimed = false;
    }

    return { throttle: rawThrottle, brake: rawBrake };
  }

  /**
   * Completes a deferred dismount (`pendingDismount === true`) once vehicle speed drops to `<= 0.6 m/s`.
   * Returns the safe dismount world point on success, or `null` if still decelerating or blocked.
   */
  consumeAutoDismount(clear: (p: Point) => boolean): Point | null {
    if (!this.driving || !this.pendingDismount || Math.abs(this.speed) > 0.6) return null;
    const out = this.toggle(this.pose, clear);
    if (out) {
      this.pendingDismount = false;
    }
    return out;
  }

  toggle(player: Point, clear: (p: Point) => boolean): Point | null {
    if (!this.spec) return null;
    if (!this.driving) {
      if (Math.hypot(player.x - this.pose.x, player.z - this.pose.z) > 3.5) return null;
      this.stopping = false;
      this.pendingDismount = false;
      this.brakeToZeroHold = 0;
      this.reverseLatchPrimed = false;
      this.driving = true;
      this.doorTime = 0.7;
      this.door = 1;
      this.lastDoorOpen = true;
      this.doorToggleId += 1;
      return this.pose;
    }
    if (Math.abs(this.speed) > 0.6) {
      this.brakeToStop();
      this.pendingDismount = true;
      return null;
    }
    const [, track, length] = this.axles;
    const yaw = this.pose.yaw;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const bounds = this.getWorldBounds();
    const isInteriorSafe = (pt: Point): boolean => {
      if (!bounds) return true;
      const pad = 0.55;
      if (bounds.x1 - bounds.x0 <= pad * 2.5 || bounds.z1 - bounds.z0 <= pad * 2.5) return true;
      return (
        pt.x >= bounds.x0 + pad &&
        pt.x <= bounds.x1 - pad &&
        pt.z >= bounds.z0 + pad &&
        pt.z <= bounds.z1 - pad
      );
    };
    const commitDismount = (pt: Point): Point => {
      this.driving = false;
      this.stopping = false;
      this.pendingDismount = false;
      this.brakeToZeroHold = 0;
      this.reverseLatchPrimed = false;
      this.externalDrivenSinceHostStep = false;
      this.speed = 0;
      this.lastThrottle = 0;
      this.doorTime = 0.65;
      this.door = 1;
      this.lastDoorOpen = true;
      this.doorToggleId += 1;
      this.lastDismountPos = { x: pt.x, z: pt.z };
      return pt;
    };

    for (let pass = 0; pass < 2; pass++) {
      const requireInterior = pass === 0 && bounds !== null;
      for (let i = 0; i < DISMOUNT_DEGREES.length; i++) {
        const degrees = DISMOUNT_DEGREES[i];
        const angle = (degrees * Math.PI) / 180;
        const dx = Math.sin(angle);
        const dz = Math.cos(angle);
        const radius = Math.min(
          (track / 2 + 0.45) / Math.max(0.001, Math.abs(dx)),
          (length / 2 + 0.45) / Math.max(0.001, Math.abs(dz)),
        );
        const p = {
          x: this.pose.x + radius * (dx * c + dz * s),
          z: this.pose.z + radius * (dz * c - dx * s),
        };
        if (requireInterior && !isInteriorSafe(p)) continue;
        if (!clear(p)) continue;
        return commitDismount(p);
      }
      // Guaranteed anti-entrapment fallback: search expanding rings biased toward map interior first.
      const inwardAngle = bounds
        ? Math.atan2(
            (bounds.z0 + bounds.z1) * 0.5 - this.pose.z,
            (bounds.x0 + bounds.x1) * 0.5 - this.pose.x,
          )
        : 0;
      for (let rIdx = 0; rIdx < DISMOUNT_RINGS.length; rIdx++) {
        const r = DISMOUNT_RINGS[rIdx];
        for (let k = 0; k < 16; k++) {
          const offset = k === 0 ? 0 : (Math.ceil(k / 2) * (k % 2 === 1 ? 1 : -1) * Math.PI) / 8;
          const a = inwardAngle + offset;
          const p = { x: this.pose.x + Math.cos(a) * r, z: this.pose.z + Math.sin(a) * r };
          if (requireInterior && !isInteriorSafe(p)) continue;
          if (!clear(p)) continue;
          return commitDismount(p);
        }
      }
      if (!bounds) break;
    }
    return null;
  }

  updateDoor(dt: number) {
    const skipClockAndLights = this.idleSteppedThisFrame || this.envLightsSteppedThisFrame;
    this.idleSteppedThisFrame = false;
    this.envLightsSteppedThisFrame = false;
    if (!skipClockAndLights && dt > 0) this.clock += dt;
    this.doorTime = Math.max(0, this.doorTime - dt);
    this.door += ((this.doorTime > 0.1 ? 1 : 0) - this.door) * (1 - Math.exp(-7 * dt));
    const doorOpen = this.door > 0.15 || this.doorTime > 0.1;
    if (this.lastDoorOpen && !doorOpen) {
      this.doorToggleId += 1;
    }
    this.lastDoorOpen = doorOpen;
    if (!this.driving && !skipClockAndLights) {
      stepVehicleLights({
        lights: this.lights,
        dt,
        nowSeconds: this.clock,
        driving: false,
        speed: 0,
        throttle: 0,
        sideInput: 0,
        steer: this.steer,
        brake: false,
        env: this.lastEnv,
      });
    }
  }

  protected fitsFootprint(cand: CarPose, clear: CarClearance): boolean {
    const [, track, length] = this.axles;
    const hw = track / 2 + 0.12;
    const hl = length / 2;
    const bounds = this.getWorldBounds();
    let escapingBoundary = false;
    let strictlyInwardEscape = false;
    let pivotInPlaceAtBoundary = false;
    if (bounds) {
      const pad = this.effectiveBoundaryPadding(hw, hl);
      const curPen = computeBoundsPenetration(this.pose.x, this.pose.z, bounds, pad);
      const candPen = computeBoundsPenetration(cand.x, cand.z, bounds, pad);
      if (candPen > 0 || curPen > 1e-5) {
        if (curPen <= 1e-5 && candPen > 0) {
          return false;
        }
        if (candPen > curPen + 1e-5) {
          return false;
        }
        escapingBoundary = true;
        strictlyInwardEscape = candPen < curPen - 1e-5;
        pivotInPlaceAtBoundary =
          Math.abs(cand.x - this.pose.x) < 1e-6 && Math.abs(cand.z - this.pose.z) < 1e-6;
      }
    }

    // Escape-Gradient Guarantee: if already inside the perimeter margin (or stranded off-surface at the border),
    // any strictly inward step or in-place turn that avoids solid buildings/lots MUST be admitted so the vehicle never wedges!
    if (escapingBoundary && (strictlyInwardEscape || pivotInPlaceAtBoundary)) {
      if (this.hitsSolidArchitecture(cand, hw, hl)) return false;
      if (!this.onRoad(this.pose)) {
        return clear(cand, hw, hl) || !clear(this.pose, hw, hl);
      }
    }

    const clampProbe = (pt: Point) => {
      if (escapingBoundary && bounds) {
        pt.x = Math.max(bounds.x0 + 0.08, Math.min(bounds.x1 - 0.08, pt.x));
        pt.z = Math.max(bounds.z0 + 0.08, Math.min(bounds.z1 - 0.08, pt.z));
      }
    };

    const cs = Math.sin(cand.yaw);
    const cc = Math.cos(cand.yaw);
    for (let iz = -1; iz <= 1; iz++) {
      const z = iz * hl;
      _fpPt.x = cand.x + z * cs;
      _fpPt.z = cand.z + z * cc;
      clampProbe(_fpPt);
      if (!this.onRoad(_fpPt)) return false;
    }

    for (let ix = -1; ix <= 1; ix += 2) {
      const x = ix * hw;
      for (let iz = -1; iz <= 1; iz++) {
        const z = iz * hl;
        _fpPt.x = cand.x + x * cc + z * cs;
        _fpPt.z = cand.z - x * cs + z * cc;
        clampProbe(_fpPt);
        if (this.onRoad(_fpPt)) continue;
        // Curb-side parking tolerance: allow the outer ~12 cm pad to kiss the curb lip while inner track stays on road
        if (this.walk.surface(_fpPt)?.region === 'sidewalk') {
          const innerX = x * 0.7;
          _fpInnerPt.x = cand.x + innerX * cc + z * cs;
          _fpInnerPt.z = cand.z - innerX * cs + z * cc;
          clampProbe(_fpInnerPt);
          if (this.onRoad(_fpInnerPt)) continue;
        }
        return false;
      }
    }
    if (clear(cand, hw, hl)) return true;
    if (escapingBoundary && (strictlyInwardEscape || pivotInPlaceAtBoundary) && !clear(this.pose, hw, hl)) {
      return !this.hitsSolidArchitecture(cand, hw, hl);
    }
    return false;
  }

  consumeExternalDriveIfIdle(throttle: number, side: number, brake: boolean): boolean {
    if (Math.abs(throttle) > 1e-4 || Math.abs(side) > 1e-4 || brake) {
      this.externalDrivenSinceHostStep = false;
      return false;
    }
    if (this.externalDrivenSinceHostStep) {
      this.externalDrivenSinceHostStep = false;
      return true;
    }
    return false;
  }

  drive(
    dt: number,
    throttle: number,
    side: number,
    brake: boolean,
    clear: CarClearance,
    opts?: VehicleDriveOptions,
  ) {
    const spec = this.spec;
    if (!spec || !this.driving || dt <= 0) return;
    if (!opts?.fromHostLoop) {
      this.externalDrivenSinceHostStep = true;
    }
    if (opts?.env) {
      this.lastEnv = opts.env;
      this.wetRoad = opts.env.rainWeight > 0.1;
      this.snowyRoad = (opts.env.snowWeight ?? 0) > 0.1;
    }
    this.clock =
      opts?.nowSeconds !== undefined && Number.isFinite(opts.nowSeconds)
        ? Math.max(this.clock, opts.nowSeconds)
        : this.clock + dt;
    this.envLightsSteppedThisFrame = true;

    const [wheelbase, track, length] = this.axles;
    const hw = track / 2 + 0.12;
    const hl = length / 2;
    const bounds = this.getWorldBounds();
    const boundPad = this.effectiveBoundaryPadding(hw, hl);
    const surfaceRegion = this.walk.surface(this.pose)?.region;
    const surfaceGrip = computeTireSurfaceGrip(this.wetRoad, this.snowyRoad, surfaceRegion);
    const handbrake = Boolean(opts?.handbrake);
    const intent = this.resolveLongitudinalIntent(dt, throttle, brake);
    const effThrottle = intent.throttle;
    brake = intent.brake || this.stopping;
    const v = this.speed;
    const brakeActive = brake || handbrake || v * effThrottle < 0;
    const decel = brakeActive
      ? spec.braking * (handbrake && !brake ? 1.15 : 1) * surfaceGrip
      : effThrottle
        ? 0.7
        : 3.2;
    const coast = Math.sign(v) * Math.max(0, Math.abs(v) - decel * dt);
    this.speed = Math.max(
      spec.reverseSpeed,
      Math.min(
        spec.maxSpeed,
        coast + (brakeActive ? 0 : effThrottle * spec.acceleration * surfaceGrip * dt),
      ),
    );
    if (this.speed === 0) this.stopping = false;
    this.steer +=
      ((-side * spec.maxSteerRad) / (1 + 0.035 * Math.abs(v)) - this.steer) *
      (1 - Math.exp(-7 * dt));
    const travel = this.speed * dt;
    const steps = Math.min(MAX_VEHICLE_SUBSTEPS, Math.max(1, Math.ceil(Math.abs(travel) / 0.09)));
    const fitsPose = (cand: CarPose) => this.fitsFootprint(cand, clear);
    let maxCollisionImpulse = 0;
    let maxBumpImpulse = 0;
    let blocked = false;
    for (let i = 0; i < steps; i++) {
      const d = travel / steps;
      const yaw = this.pose.yaw + (d * Math.tan(this.steer)) / wheelbase;
      const mid = (this.pose.yaw + yaw) / 2;
      _driveNextPose.x = this.pose.x + d * Math.sin(mid);
      _driveNextPose.z = this.pose.z + d * Math.cos(mid);
      _driveNextPose.yaw = yaw;

      if (bounds) {
        const penCurr = computeBoundsPenetration(this.pose.x, this.pose.z, bounds, boundPad);
        const penNext = computeBoundsPenetration(_driveNextPose.x, _driveNextPose.z, bounds, boundPad);
        if (penNext > penCurr + 1e-6) {
          const bSlide = slidePoseAlongBounds(this.pose, _driveNextPose, bounds, boundPad);
          if (bSlide.clamped && Math.abs(bSlide.movedDistance) > 1e-5) {
            const subDt = dt / steps;
            if (Math.abs(side) < 0.08 && bSlide.alignRatio > 0.18) {
              let dy = (bSlide.tangentYaw - bSlide.pose.yaw) % (Math.PI * 2);
              if (dy > Math.PI) dy -= Math.PI * 2;
              if (dy < -Math.PI) dy += Math.PI * 2;
              bSlide.pose.yaw += dy * (1 - Math.exp(-3.2 * subDt));
            }
            if (fitsPose(bSlide.pose)) {
              this.pose.x = bSlide.pose.x;
              this.pose.z = bSlide.pose.z;
              this.pose.yaw = bSlide.pose.yaw;
              this.spin += bSlide.movedDistance / spec.wheelRadius;
              this.speed *= 1 - (1 - bSlide.alignRatio) * Math.min(0.25, 2.0 * subDt);
              continue;
            }
          }
        }
      }

      const col = resolveCurbDeflection(this.pose, _driveNextPose, d, fitsPose);
      if (col.blocked) {
        maxCollisionImpulse = Math.max(maxCollisionImpulse, col.collisionImpulse);
        maxBumpImpulse = Math.max(maxBumpImpulse, col.bumpImpulse);
        this.speed = 0;
        blocked = true;
        break;
      }
      this.pose.x = col.pose.x;
      this.pose.z = col.pose.z;
      this.pose.yaw = col.pose.yaw;
      this.spin += col.movedDistance / spec.wheelRadius;
      if (col.deflected) {
        this.speed *= col.speedScale;
        maxCollisionImpulse = Math.max(maxCollisionImpulse, col.collisionImpulse);
        maxBumpImpulse = Math.max(maxBumpImpulse, col.bumpImpulse);
      }
    }
    if (Math.abs(this.speed) < 0.25 && Math.abs(side) > 0.05 && (blocked || Math.abs(effThrottle) > 0.05)) {
      const scrubDir = effThrottle < -0.05 ? 1 : -1;
      _drivePivotPose.x = this.pose.x;
      _drivePivotPose.z = this.pose.z;
      _drivePivotPose.yaw = this.pose.yaw + scrubDir * Math.max(-1, Math.min(1, side)) * 0.95 * dt;
      if (fitsPose(_drivePivotPose)) {
        this.pose.yaw = _drivePivotPose.yaw;
      }
    }
    this.lastThrottle = effThrottle;
    this.lastCollisionImpulse = maxCollisionImpulse;
    this.lastBumpImpulse = maxBumpImpulse;
    stepVehicleLights({
      lights: this.lights,
      dt,
      nowSeconds: this.clock,
      driving: true,
      speed: this.speed,
      throttle: effThrottle,
      sideInput: side,
      steer: this.steer,
      brake,
      handbrake,
      hornHeld: opts?.hornHeld,
      env: this.lastEnv,
    });
  }

  wheelSteer(side: number) {
    const [base, track] = this.axles;
    return ackermannWheelSteer(this.steer, base, track, side < 0 ? -1 : 1);
  }
}

export class Automobile extends RoadVehicle {
  private legacyPose?: CarPose;
  readonly wheels: WheelContactState[] = createWheelContacts();
  readonly chassis: ChassisSuspensionState = createChassisState();

  get handlingProfile(): CarHandlingProfile {
    return getCarHandlingProfile(this.spec?.model);
  }

  get carClass(): CarClass {
    return this.handlingProfile.carClass;
  }

  override toggle(player: Point, clear: (p: Point) => boolean): Point | null {
    const wasDriving = this.driving;
    const result = super.toggle(player, clear);
    if (result && this.driving !== wasDriving) {
      if (!this.chassis.initialized) {
        // Initialize ground baseline before applying entry/exit weight dip
        this.stepIdle(1 / 60);
        this.idleSteppedThisFrame = false;
      }
      injectDriverWeightDip(this.wheels, this.driving);
    }
    return result;
  }

  /** Continues settling 4-corner spring-damper suspension smoothly even while parked (`driving === false`). */
  stepIdle(dt: number, env?: EnvironmentLightConditions, nowSeconds?: number) {
    if (env) {
      this.lastEnv = env;
      this.wetRoad = env.rainWeight > 0.1;
      this.snowyRoad = (env.snowWeight ?? 0) > 0.1;
    }
    const alreadyHadEnvLights = this.envLightsSteppedThisFrame;
    this.envLightsSteppedThisFrame = false;
    if (nowSeconds !== undefined && Number.isFinite(nowSeconds)) {
      this.clock = Math.max(this.clock, nowSeconds);
    } else if (!alreadyHadEnvLights && dt > 0) {
      this.clock += dt;
    }
    if (!this.spec || dt <= 0) return;
    if (!this.driving && !alreadyHadEnvLights) {
      stepVehicleLights({
        lights: this.lights,
        dt,
        nowSeconds: this.clock,
        driving: false,
        speed: 0,
        throttle: 0,
        sideInput: 0,
        steer: this.steer,
        brake: false,
        env: this.lastEnv,
      });
    }
    if (!this.chassis.initialized) {
      // Seed initial ground heights once so parked cars sit flush on uneven road elevation
      stepCarSuspension({
        wheels: this.wheels,
        chassis: this.chassis,
        profile: this.handlingProfile,
        pose: this.pose,
        dt: Math.min(dt, 1 / 60),
        forwardAccel: 0,
        lateralAccel: 0,
        groundAt: (x, z) => this.walk.groundAt(x, z),
        distance: 0,
        turn: 0,
        driving: false,
      });
      if (!this.driving) this.idleSteppedThisFrame = true;
      return;
    }
    if (!this.driving) {
      stepIdleCarSuspension(
        this.wheels,
        this.chassis,
        this.handlingProfile,
        this.pose,
        dt,
        (x, z) => this.walk.groundAt(x, z),
      );
      this.idleSteppedThisFrame = true;
    }
  }

  override updateDoor(dt: number) {
    const alreadySteppedIdle = this.idleSteppedThisFrame;
    super.updateDoor(dt);
    if (!alreadySteppedIdle && !this.driving && this.spec && this.chassis.initialized) {
      stepIdleCarSuspension(
        this.wheels,
        this.chassis,
        this.handlingProfile,
        this.pose,
        dt,
        (x, z) => this.walk.groundAt(x, z),
      );
    }
  }

  override drive(
    dt: number,
    throttle: number,
    side: number,
    brake: boolean,
    clear: CarClearance,
    opts?: VehicleDriveOptions,
  ) {
    const spec = this.spec;
    if (!spec || dt <= 0) return;
    if (opts?.env) {
      this.lastEnv = opts.env;
      this.wetRoad = opts.env.rainWeight > 0.1;
      this.snowyRoad = (opts.env.snowWeight ?? 0) > 0.1;
    }
    this.clock =
      opts?.nowSeconds !== undefined && Number.isFinite(opts.nowSeconds)
        ? Math.max(this.clock, opts.nowSeconds)
        : this.clock + dt;

    if (!this.driving) {
      this.lastThrottle = 0;
      this.lastCollisionImpulse = 0;
      this.lastBumpImpulse = 0;
      this.envLightsSteppedThisFrame = true;
      this.stepIdle(dt, opts?.env, this.clock);
      stepVehicleLights({
        lights: this.lights,
        dt,
        nowSeconds: this.clock,
        driving: false,
        speed: 0,
        throttle: 0,
        sideInput: 0,
        steer: this.steer,
        brake: false,
        env: this.lastEnv,
      });
      return;
    }
    this.envLightsSteppedThisFrame = true;

    // Space acts as rear-slip handbrake when turning at speed, and full emergency stop straight/slow.
    const intent = this.resolveLongitudinalIntent(dt, throttle, brake);
    const effThrottle = intent.throttle;
    const effBrake = intent.brake;
    const explicitHandbrake = opts?.handbrake;
    const handbrake =
      explicitHandbrake !== undefined
        ? explicitHandbrake
        : effBrake && Math.abs(side) > 0.2 && Math.abs(this.speed) > 3.5 && !this.stopping;
    const serviceBrake = explicitHandbrake !== undefined ? effBrake : effBrake && !handbrake;
    const surfaceRegion = this.walk.surface(this.pose)?.region;
    const surfaceGrip = computeTireSurfaceGrip(this.wetRoad, this.snowyRoad, surfaceRegion);

    const result = stepCarDynamics({
      pose: this.pose,
      speed: this.speed,
      steer: this.steer,
      spin: this.spin,
      driving: true,
      stopping: this.stopping,
      wetRoad: this.wetRoad,
      snowyRoad: this.snowyRoad,
      surfaceGrip,
      surface: surfaceRegion,
      dt,
      throttle: effThrottle,
      sideInput: side,
      brake: serviceBrake,
      handbrake,
      profile: this.handlingProfile,
      specOverride: {
        maxSpeed: spec.maxSpeed,
        reverseSpeed: spec.reverseSpeed,
        acceleration: spec.acceleration,
        braking: spec.braking,
        maxSteerRad: spec.maxSteerRad,
        wheelRadius: spec.wheelRadius,
      },
      wheels: this.wheels,
      chassis: this.chassis,
      fitsPose: (cand) => this.fitsFootprint(cand, clear),
      groundAt: (x, z) => this.walk.groundAt(x, z),
      worldBounds: this.getWorldBounds() ?? undefined,
      boundaryPadding: this.effectiveBoundaryPadding(
        this.handlingProfile.track * 0.5 + 0.12,
        this.handlingProfile.length * 0.5,
      ),
    });

    this.speed = result.speed;
    this.steer = result.steer;
    this.spin = result.spin;
    this.stopping = result.stopping;
    this.lastThrottle = effThrottle;
    this.lastCollisionImpulse = result.collisionImpulse;
    this.lastBumpImpulse = result.bumpImpulse ?? 0;

    stepVehicleLights({
      lights: this.lights,
      dt,
      nowSeconds: this.clock,
      driving: true,
      speed: this.speed,
      throttle: effThrottle,
      sideInput: side,
      steer: this.steer,
      brake: serviceBrake || this.stopping,
      handbrake,
      hornHeld: opts?.hornHeld,
      env: this.lastEnv,
    });
  }

  constructor(
    walk: LifeWalk,
    parked?: Point,
    yaw?: number,
    previousId?: string,
    saved?: unknown,
  ) {
    super(walk, parked, yaw, 4, 'car');
    this.restoreParking(saved, 'community_mango_ev');
    if (parked && this.onRoad(parked)) {
      if (!previousId) this.legacyPose = { ...this.pose };
      else if (previousId === 'community_mango_ev' || /^ec_[a-f0-9]{20}$/.test(previousId))
        this.parking[previousId] ??= { ...this.pose };
    }
  }

  authorize(wallet: Wallet, selected?: string) {
    const owned = wallet.owned.flatMap((o) => {
      const item = CATALOG.shops[o.storeId]?.items.find((i) => i.sku === o.sku);
      const model = item?.vehicleId;
      return item?.itemType === 'vehicle' &&
        typeof model === 'string' &&
        Object.hasOwn(dimensions, model)
        ? [
            {
              ...wallet.workshop?.ownedObjects.find((obj) => obj.instanceId === o.instanceId),
              instanceId: o.instanceId,
              selectedVariantId: model,
              category: 'vehicle_display',
            },
          ]
        : [];
    });
    const choice = wallet.workshop?.activeCarId ?? selected;
    const next = getActiveCarSpec({
      progression: { ownedObjects: owned },
      worldV3: {
        car: { instanceId: choice },
        openRoadPermit: wallet.claimed.includes('side:sq_open_road'),
      },
    });
    if (next?.instanceId !== this.spec?.instanceId) {
      resetSuspension(this.wheels, this.chassis);
    }
    this.switchInstance(next?.instanceId, this.legacyPose);
    if (next) this.legacyPose = undefined;
    for (const id of Object.keys(this.parking)) {
      if (id !== 'community_mango_ev' && !owned.some((o) => o.instanceId === id))
        delete this.parking[id];
    }
    this.spec = next;
  }

  get axles(): [number, number, number] {
    return dimensions[this.spec?.model ?? 'car_mango_micro'];
  }
}
