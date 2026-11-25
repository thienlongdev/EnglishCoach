import { CATALOG, getActiveVehiclePhysics } from '../v3/game-core/index.mjs';
import type { LifeWalk } from '../walk';
import {
  RoadVehicle,
  type CarClearance,
  type CarPose,
  type VehicleDriveOptions,
} from './automobile';
import models from './two-wheeler-models.json';
import type { Wallet } from './session';
import {
  GRAVITY,
  MAX_VEHICLE_SUBSTEPS,
  WORLD_BOUNDARY_PADDING_TWO_WHEELER,
  computeBoundsPenetration,
  computeFilteredRoadSlopeRad,
  computeTireSurfaceGrip,
  createTwoWheelerState,
  getTwoWheelerHandlingProfile,
  resetTwoWheelerState,
  resolveCurbDeflection,
  slidePoseAlongBounds,
  stepLongitudinalSpeed,
  stepTwoWheelerDynamics,
  stepVehicleLights,
  type EnvironmentLightConditions,
  type TwoWheelerDynamicsState,
  type TwoWheelerHandlingProfile,
} from './vehicleDynamics';

export const rideModels = models;
export type RideModelId = keyof typeof models;
type Model = RideModelId;

const BICYCLE_OUTDOOR_REGIONS = new Set([
  'road',
  'crossing',
  'sidewalk',
  'park',
  'garden',
  'plaza',
  'garage',
  'door:garage_out',
]);

const _twNextPt = { x: 0, z: 0 };
const _twCurPt = { x: 0, z: 0 };
const _twDriveNextPose: CarPose = { x: 0, z: 0, yaw: 0 };
const _twPivotPose: CarPose = { x: 0, z: 0, yaw: 0 };

/** Spatial data belongs to the story save. Only the account's workshop can grant a ride. */
export class TwoWheeler extends RoadVehicle {
  powered = false;
  readonly dynamics: TwoWheelerDynamicsState = createTwoWheelerState();

  constructor(walk: LifeWalk, saved: unknown, legacyPark?: { x: number; z: number }) {
    super(walk, undefined, Math.PI / 2, -3, 'bike');
    this.restoreParking(saved, 'obj_starter_bike');
    if (!this.parking.obj_starter_bike && legacyPark && this.onRoad(legacyPark)) {
      this.parking.obj_starter_bike = { ...legacyPark, yaw: Math.PI / 2 };
    }
  }

  get handlingProfile(): TwoWheelerHandlingProfile {
    const base = getTwoWheelerHandlingProfile(this.spec?.model);
    if (!this.spec) return base;
    const dims = models[this.spec.model as Model];
    return {
      ...base,
      powered: this.powered,
      hornKind: this.powered ? 'motorbike' : 'bike',
      wheelbase: dims?.wheelbase ?? base.wheelbase,
      width: dims?.width ?? base.width,
      length: dims?.length ?? base.length,
      wheelRadius: this.spec.wheelRadius || dims?.wheelRadius || base.wheelRadius,
      maxSpeed: this.spec.maxSpeed,
      reverseSpeed: this.spec.reverseSpeed,
      acceleration: this.spec.acceleration,
      braking: this.spec.braking,
      maxSteerRad: this.spec.maxSteerRad,
    };
  }

  get lean(): number {
    return this.dynamics.lean;
  }

  get forkDive(): number {
    return this.dynamics.forkDive;
  }

  get pedalCadence(): number {
    return this.dynamics.pedalCadence;
  }

  get coasting(): boolean {
    return this.dynamics.coasting;
  }

  protected override get boundaryPadding(): number {
    return WORLD_BOUNDARY_PADDING_TWO_WHEELER;
  }

  protected override onRoad(p: { x: number; z: number }) {
    const region = this.walk.surface(p)?.region;
    return super.onRoad(p) || (!this.powered && Boolean(region && BICYCLE_OUTDOOR_REGIONS.has(region)));
  }

  protected override fitsFootprint(cand: CarPose, clear: CarClearance): boolean {
    if (!super.fitsFootprint(cand, clear)) return false;
    // Gate non-powered bicycles by static world/prop clearance on sidewalks, yards, parks, gardens, and plazas
    // while permitting outward depenetration if parked close to a porch, curb, or world boundary.
    if (!this.powered && typeof this.walk.playerClearanceAt === 'function') {
      const [, track, length] = this.axles;
      const hw = track * 0.5 + 0.12;
      const hl = length * 0.5;
      const bounds = this.getWorldBounds();
      let escapingBoundary = false;
      if (bounds) {
        const pad = this.effectiveBoundaryPadding(hw, hl);
        const curPen = computeBoundsPenetration(this.pose.x, this.pose.z, bounds, pad);
        const candPen = computeBoundsPenetration(cand.x, cand.z, bounds, pad);
        if (curPen > 1e-5 && candPen <= curPen + 1e-5) {
          escapingBoundary = true;
          if (!this.onRoad(this.pose)) {
            return true;
          }
        }
      }

      const probeZ = length * 0.34;
      const curS = Math.sin(this.pose.yaw);
      const curC = Math.cos(this.pose.yaw);
      const candS = Math.sin(cand.yaw);
      const candC = Math.cos(cand.yaw);
      for (let iz = -1; iz <= 1; iz++) {
        const zOff = iz * probeZ;
        _twNextPt.x = cand.x + zOff * candS;
        _twNextPt.z = cand.z + zOff * candC;
        if (escapingBoundary && bounds) {
          _twNextPt.x = Math.max(bounds.x0 + 0.55, Math.min(bounds.x1 - 0.55, _twNextPt.x));
          _twNextPt.z = Math.max(bounds.z0 + 0.55, Math.min(bounds.z1 - 0.55, _twNextPt.z));
        }
        const nextClear = this.walk.playerClearanceAt(_twNextPt, 0.55);
        if (nextClear >= -0.02) continue;
        _twCurPt.x = this.pose.x + zOff * curS;
        _twCurPt.z = this.pose.z + zOff * curC;
        if (escapingBoundary && bounds) {
          _twCurPt.x = Math.max(bounds.x0 + 0.55, Math.min(bounds.x1 - 0.55, _twCurPt.x));
          _twCurPt.z = Math.max(bounds.z0 + 0.55, Math.min(bounds.z1 - 0.55, _twCurPt.z));
        }
        const curClear = this.walk.playerClearanceAt(_twCurPt, 0.55);
        if (nextClear < curClear - 1e-4) return false;
      }
    }
    return true;
  }

  /** Synchronizes pose without changing mount state (for shared/starter bicycle controller handoff). */
  syncPose(pose: { x: number; z: number; yaw: number }): void {
    this.pose.x = pose.x;
    this.pose.z = pose.z;
    this.pose.yaw = pose.yaw;
  }

  override toggle(player: { x: number; z: number }, clear: (p: { x: number; z: number }) => boolean) {
    const wasDriving = this.driving;
    const res = super.toggle(player, clear);
    if (res && this.driving !== wasDriving) {
      this.doorTime = 0;
      this.door = 0;
      this.lastDoorOpen = false;
    }
    return res;
  }

  /** Immediately mounts the controller at `pose` with clean longitudinal latch state. */
  mountAt(pose: { x: number; z: number; yaw: number }, initialSpeed = 0): void {
    this.pose.x = pose.x;
    this.pose.z = pose.z;
    this.pose.yaw = pose.yaw;
    this.speed = initialSpeed;
    this.steer = 0;
    this.stopping = false;
    this.pendingDismount = false;
    this.brakeToZeroHold = 0;
    this.reverseLatchPrimed = false;
    this.driving = true;
  }

  /** Immediately clears active driving state (e.g. on shared/starter bicycle dismount or indoor transition). */
  dismountImmediate(): void {
    this.driving = false;
    this.stopping = false;
    this.pendingDismount = false;
    this.brakeToZeroHold = 0;
    this.reverseLatchPrimed = false;
    this.speed = 0;
    this.lastThrottle = 0;
  }

  /** Settles lean, front-fork dive, and pedal cadence smoothly upright while parked (`driving === false`). */
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
    if (!this.spec || dt <= 0 || this.driving) return;
    if (!alreadyHadEnvLights) {
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
    stepTwoWheelerDynamics({
      state: this.dynamics,
      profile: this.handlingProfile,
      driving: false,
      speed: 0,
      steer: 0,
      throttle: 0,
      brake: false,
      forwardAccel: 0,
      wetRoad: this.wetRoad,
      snowyRoad: this.snowyRoad,
      dt,
    });
    this.idleSteppedThisFrame = true;
  }

  override updateDoor(dt: number) {
    const alreadySteppedIdle = this.idleSteppedThisFrame;
    super.updateDoor(dt);
    if (!alreadySteppedIdle && !this.driving && this.spec && this.dynamics.initialized) {
      stepTwoWheelerDynamics({
        state: this.dynamics,
        profile: this.handlingProfile,
        driving: false,
        speed: 0,
        steer: 0,
        throttle: 0,
        brake: false,
        forwardAccel: 0,
        wetRoad: this.wetRoad,
        snowyRoad: this.snowyRoad,
        dt,
      });
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
    if (!opts?.fromHostLoop) {
      this.externalDrivenSinceHostStep = true;
    }

    const intent = this.resolveLongitudinalIntent(dt, throttle, brake);
    const effThrottle = intent.throttle;
    const effBrake = intent.brake;

    const profile = this.handlingProfile;
    const prevSpeed = this.speed;
    const [wheelbase, track, length] = this.axles;
    const hw = track * 0.5 + 0.12;
    const hl = length * 0.5;
    const bounds = this.getWorldBounds();
    const boundPad = this.effectiveBoundaryPadding(hw, hl);
    const sin0 = Math.sin(this.pose.yaw);
    const cos0 = Math.cos(this.pose.yaw);
    const halfBase = wheelbase * 0.5;
    const surfaceRegion = this.walk.surface(this.pose)?.region;
    const surfaceGrip = computeTireSurfaceGrip(this.wetRoad, this.snowyRoad, surfaceRegion);
    const gCenter = this.walk.groundAt(this.pose.x, this.pose.z) ?? 0;
    const gFront = this.walk.groundAt(this.pose.x + halfBase * sin0, this.pose.z + halfBase * cos0) ?? gCenter;
    const gRear = this.walk.groundAt(this.pose.x - halfBase * sin0, this.pose.z - halfBase * cos0) ?? gCenter;
    const slopeRad = computeFilteredRoadSlopeRad(gFront, gRear, Math.max(0.5, wheelbase), gCenter);

    const longRes = stepLongitudinalSpeed({
      speed: prevSpeed,
      dt,
      throttle: effThrottle,
      sideInput: side,
      brake: effBrake || this.stopping,
      handbrake: Boolean(opts?.handbrake),
      stopping: this.stopping,
      wetRoad: this.wetRoad,
      snowyRoad: this.snowyRoad,
      surfaceGrip,
      slopeRad,
      profile: {
        maxSpeed: spec.maxSpeed,
        reverseSpeed: spec.reverseSpeed,
        acceleration: spec.acceleration,
        braking: spec.braking,
        dragCoeff: profile.dragCoeff,
        rollingResistance: profile.rollingResistance,
        peakTorqueFactor: 1.05,
        torqueTaper: 0.22,
        wetGripFactor: profile.wetGripFactor,
      },
    });

    this.speed = longRes.speed;
    if (Math.abs(this.speed) < 1e-4) this.stopping = false;

    // Speed-sensitive & grip-limited handlebar steering
    const absV = Math.abs(this.speed);
    const grip = profile.baseGripG * surfaceGrip * GRAVITY;
    const gripSteer = Math.atan((wheelbase * grip) / Math.max(1, absV * absV));
    const speedSteer = spec.maxSteerRad / (1 + profile.steerSpeedFactor * absV);
    const maxSteerNow = Math.min(speedSteer, gripSteer);
    const clampedSide = Math.max(-1, Math.min(1, side));
    const targetSteer = -clampedSide * maxSteerNow;
    this.steer += (targetSteer - this.steer) * (1 - Math.exp(-8 * dt));

    const travel = this.speed * dt;
    const steps = Math.min(MAX_VEHICLE_SUBSTEPS, Math.max(1, Math.ceil(Math.abs(travel) / 0.16)));
    const fitsPose = (cand: CarPose) => this.fitsFootprint(cand, clear);
    let maxCollisionImpulse = 0;
    let maxBumpImpulse = 0;
    let blocked = false;
    for (let i = 0; i < steps; i++) {
      const d = travel / steps;
      const yaw = this.pose.yaw + (d * Math.tan(this.steer)) / wheelbase;
      const mid = (this.pose.yaw + yaw) * 0.5;
      _twDriveNextPose.x = this.pose.x + d * Math.sin(mid);
      _twDriveNextPose.z = this.pose.z + d * Math.cos(mid);
      _twDriveNextPose.yaw = yaw;

      // Smooth tangential perimeter slide (`v_outward -> 0`) before hitting raw `city.bounds`
      if (bounds) {
        const penCurr = computeBoundsPenetration(this.pose.x, this.pose.z, bounds, boundPad);
        const penNext = computeBoundsPenetration(_twDriveNextPose.x, _twDriveNextPose.z, bounds, boundPad);
        if (penNext > penCurr + 1e-6) {
          const bSlide = slidePoseAlongBounds(this.pose, _twDriveNextPose, bounds, boundPad);
          if (bSlide.clamped && Math.abs(bSlide.movedDistance) > 1e-5) {
            const subDt = dt / steps;
            if (Math.abs(clampedSide) < 0.08 && bSlide.alignRatio > 0.18) {
              let dy = (bSlide.tangentYaw - bSlide.pose.yaw) % (Math.PI * 2);
              if (dy > Math.PI) dy -= Math.PI * 2;
              if (dy < -Math.PI) dy += Math.PI * 2;
              bSlide.pose.yaw += dy * (1 - Math.exp(-3.5 * subDt));
            }
            if (fitsPose(bSlide.pose)) {
              this.pose.x = bSlide.pose.x;
              this.pose.z = bSlide.pose.z;
              this.pose.yaw = bSlide.pose.yaw;
              this.spin += bSlide.movedDistance / spec.wheelRadius;
              this.speed *= 1 - (1 - bSlide.alignRatio) * Math.min(0.25, 1.8 * subDt);
              continue;
            }
          }
        }
      }

      const col = resolveCurbDeflection(this.pose, _twDriveNextPose, d, fitsPose);
      if (col.blocked) {
        maxCollisionImpulse = Math.max(maxCollisionImpulse, col.collisionImpulse);
        maxBumpImpulse = Math.max(maxBumpImpulse, col.bumpImpulse);
        if (Math.abs(this.speed) > 0.2 && col.collisionImpulse > 0.05) {
          const dir = this.speed >= 0 ? 1 : -1;
          this.dynamics.forkVel = Math.max(
            -4,
            Math.min(4, this.dynamics.forkVel + dir * 0.85 * col.collisionImpulse),
          );
        }
        this.speed = 0;
        this.stopping = false;
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

    // Handlebar walk-turn pivot when stationary or blocked (`|speed| < 0.35 m/s` and rider holds `A` / `D`),
    // guaranteeing a bicycle stopped nose-in against a wall or map boundary can always turn freely away!
    if (Math.abs(this.speed) < 0.35 && Math.abs(clampedSide) > 0.05 && (blocked || Math.abs(this.speed) < 0.2)) {
      const turnDir = effThrottle < -0.05 ? 1 : -1;
      _twPivotPose.x = this.pose.x;
      _twPivotPose.z = this.pose.z;
      _twPivotPose.yaw = this.pose.yaw + turnDir * clampedSide * 1.85 * dt;
      if (fitsPose(_twPivotPose)) {
        this.pose.yaw = _twPivotPose.yaw;
      }
    }

    this.lastThrottle = effThrottle;
    this.lastCollisionImpulse = maxCollisionImpulse;
    this.lastBumpImpulse = maxBumpImpulse;

    const forwardAccel = (this.speed - prevSpeed) / dt;
    stepTwoWheelerDynamics({
      state: this.dynamics,
      profile,
      driving: true,
      speed: this.speed,
      steer: this.steer,
      throttle: effThrottle,
      brake: effBrake || this.stopping || Boolean(opts?.handbrake),
      forwardAccel,
      wetRoad: this.wetRoad,
      snowyRoad: this.snowyRoad,
      surfaceGrip,
      dt,
    });

    stepVehicleLights({
      lights: this.lights,
      dt,
      nowSeconds: this.clock,
      driving: true,
      speed: this.speed,
      throttle: effThrottle,
      sideInput: clampedSide,
      steer: this.steer,
      brake: effBrake || this.stopping,
      handbrake: opts?.handbrake,
      hornHeld: opts?.hornHeld,
      env: this.lastEnv,
    });
  }

  authorize(wallet: Wallet) {
    const work = wallet.workshop;
    const obj = work?.ownedObjects.find((o) => o.instanceId === work.activeVehicleId);
    const receipt = wallet.owned.find((o) => o.instanceId === obj?.instanceId);
    const sku = receipt && CATALOG.shops[receipt.storeId]?.items.find((i) => i.sku === receipt.sku);
    this.powered = ['motorbike', 'scooter'].includes(String(obj?.interactionState.vehicleClass));
    const eligible =
      obj?.category === 'vehicle_rideable' &&
      obj.interactionState.drivable &&
      (obj.instanceId === 'obj_starter_bike' || sku?.itemType === 'vehicle');
    const physics = work && eligible ? getActiveVehiclePhysics({ progression: work }) : null;
    // Older starter saves use the catalog variant "bicycle". Reuse the articulated campus bicycle.
    const asset =
      physics?.model === 'bicycle' && obj?.instanceId === 'obj_starter_bike'
        ? 'veh_bike_basket'
        : physics?.model;
    const model = asset && Object.hasOwn(models, asset) ? (asset as Model) : null;
    const id = model ? obj?.instanceId : undefined;
    if (id !== this.spec?.instanceId) {
      resetTwoWheelerState(this.dynamics);
    }
    this.switchInstance(id);
    this.lights.hornKind = this.powered ? 'motorbike' : 'bike';
    for (const key of Object.keys(this.parking)) {
      if (key !== 'obj_starter_bike' && !wallet.owned.some((o) => o.instanceId === key))
        delete this.parking[key];
    }
    this.spec =
      model && physics && id
        ? {
            ...physics,
            instanceId: id,
            name: sku?.name ?? 'Personal bicycle',
            model,
            reverseSpeed: -1.4,
            maxSteerRad: Math.min(0.72, physics.handling / 3),
            wheelRadius: models[model].wheelRadius,
            collisionRadius: models[model].width / 2,
          }
        : null;
  }

  get axles(): [number, number, number] {
    const { wheelbase, width, length } = models[this.spec!.model as Model];
    return [wheelbase, width, length];
  }
}

/**
 * Creates a standalone `TwoWheeler` campus-bicycle physics controller (`powered = false`)
 * so `gameHost.ts` can drive `game.riding` and `game.ridingShared` with 100% real two-wheeler
 * steering, inward lean, freewheel cadence, curb-filtered braking, and obstacle collision —
 * eliminating pedestrian capsule locomotion and the `-0.238 m/frame` saddle feedback loop.
 */
export function createSharedOrStarterBicycleController(
  walk: LifeWalk,
  modelInput: string = 'veh_bike_basket',
  instanceId = 'shared_or_starter_bike',
): TwoWheeler {
  const resolvedModel: Model =
    modelInput && Object.hasOwn(models, modelInput) ? (modelInput as Model) : 'veh_bike_basket';
  const dims = models[resolvedModel];
  const ctrl = new TwoWheeler(walk, undefined);
  ctrl.powered = false;
  ctrl.lights.hornKind = 'bike';
  ctrl.spec = {
    instanceId,
    name: 'Campus Bicycle',
    model: resolvedModel,
    paintHex: null,
    maxSpeed: 7.6,
    reverseSpeed: -1.4,
    acceleration: 5.4,
    braking: 11.5,
    handling: 1.95,
    maxSteerRad: 0.65,
    wheelRadius: dims.wheelRadius,
    collisionRadius: dims.width / 2,
  };
  return ctrl;
}
