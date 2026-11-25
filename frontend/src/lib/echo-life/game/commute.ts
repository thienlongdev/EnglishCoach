/**
 * Echo Life — Living Right-Hand Road Spline Traffic System (`TrafficAgent`, `Commuter`, `TrafficSim`).
 *
 * Pure TypeScript, zero DOM/Three/WASM dependencies, zero per-frame heap allocations:
 * - Drives mixed urban fleets (NPC cyclists, scooters, and ambient street cars) along the parametric
 *   14-intersection / 40-edge Right-Hand Traffic `RoadGraph` with smooth analytic quarter-circle turns.
 * - Longitudinal dynamics via the Intelligent Driver Model (IDM) with virtual stop-lines for
 *   intersection priority, zebra crosswalks, crossing pedestrians, and player yield.
 * - MOBIL-lite oncoming-aware lateral bypass around the 6 curb-parked cars and stopped vehicles.
 * - Pure-Pursuit + Ackermann curvature feedforward steering, `TwoWheelerDynamicsState` lean/fork-dive,
 *   freewheel crank phase integration (`omega = 0` at `v = 0`), stopped foot-down balance (`standDownBlend`),
 *   car suspension pitch/roll, and automatic headlights/brake-lights/blinkers/courtesy bell.
 * - Backward-compatible `Commuter` constructor and `step(dt, rain, clear)` signature for `session.ts`
 *   and `gameView.ts` while exposing full `TrafficSim` fleet management for Wave 2 integration.
 */

import type { LifeWalk } from '../walk';
import { RoadVehicle, type CarClearance, type CarPose, type VehicleFootprint } from './automobile';
import type { ParkedVehicleHazard, ResidentKinematicsView, VehicleHazard } from './crowd';
import { wrapAnglePi } from './orca2d';
import {
  LANE_PROFILES,
  createSplineSample,
  getOrBuildRoadGraph,
  sampleRoadEdge,
  sampleTurnConnector,
  type CardinalDir,
  type CurbBoxInput,
  type LaneProfileId,
  type RoadEdge,
  type RoadGraph,
  type SplineSample,
  type TurnConnector,
} from './roadGraph';
import models from './two-wheeler-models.json';
import {
  computeTireSurfaceGrip,
  createTwoWheelerState,
  getTwoWheelerHandlingProfile,
  stepTwoWheelerDynamics,
  stepVehicleLights,
  triggerVehicleHorn,
  type EnvironmentLightConditions,
  type TwoWheelerDynamicsState,
} from './vehicleDynamics';

export type TrafficVehicleKind = LaneProfileId; // 'car' | 'scooter' | 'bicycle'
export const MAX_TRAFFIC_AGENTS = 10;

let trafficDensityMultiplier = 0.9;

/** Manage City traffic density multiplier (clamped safely to `0.3..1.5`). */
export function setTrafficDensityMultiplier(mult: number): number {
  trafficDensityMultiplier = Number.isFinite(mult) ? Math.max(0.3, Math.min(1.5, mult)) : 0.9;
  return trafficDensityMultiplier;
}

export function getTrafficDensityMultiplier(): number {
  return trafficDensityMultiplier;
}

export interface TrafficPedestrianPoint {
  readonly x: number;
  readonly z: number;
}

export interface TrafficStepContext {
  readonly env?: EnvironmentLightConditions;
  readonly phase?: string;
  readonly playerPos?: TrafficPedestrianPoint | null;
  readonly playerVehicle?: VehicleHazard | null;
  readonly residents?: ResidentKinematicsView | null;
  readonly crowd?: readonly TrafficPedestrianPoint[];
  readonly parkedVehicles?: readonly ParkedVehicleHazard[];
  readonly peers?: readonly TrafficAgent[];
  readonly densityMultiplier?: number;
}

export interface TrafficAgentInitOptions {
  readonly kind?: TrafficVehicleKind;
  readonly model?: string;
  readonly paintHex?: string | null;
  readonly startEdgeId?: number;
  readonly startS?: number;
  readonly seed?: number;
}

interface IdmParams {
  readonly v0: number;
  readonly s0: number;
  readonly headwayT: number;
  readonly maxAccel: number;
  readonly comfortBrake: number;
  readonly emergBrake: number;
}

interface ModelMetrics {
  readonly wheelbase: number;
  readonly width: number;
  readonly length: number;
  readonly wheelRadius: number;
  readonly maxSteerRad: number;
  readonly gearRatio: number;
}

const CAR_MODEL_METRICS: Readonly<Record<string, ModelMetrics>> = {
  car_mango_micro: {
    wheelbase: 1.744,
    width: 1.264,
    length: 2.95,
    wheelRadius: 0.263,
    maxSteerRad: 0.48,
    gearRatio: 0,
  },
  car_river_sedan: {
    wheelbase: 2.73,
    width: 1.534,
    length: 4.6,
    wheelRadius: 0.32,
    maxSteerRad: 0.56,
    gearRatio: 0,
  },
};

const IDM_BY_KIND: Readonly<Record<TrafficVehicleKind, IdmParams>> = {
  car: {
    v0: 7.4,
    s0: 2.4,
    headwayT: 1.4,
    maxAccel: 2.2,
    comfortBrake: 2.8,
    emergBrake: 7.5,
  },
  scooter: {
    v0: 6.6,
    s0: 1.9,
    headwayT: 1.2,
    maxAccel: 2.6,
    comfortBrake: 3.2,
    emergBrake: 7.2,
  },
  bicycle: {
    v0: 4.4,
    s0: 1.5,
    headwayT: 1.0,
    maxAccel: 1.8,
    comfortBrake: 3.0,
    emergBrake: 6.5,
  },
};

const BICYCLE_MODELS = ['veh_bike_road', 'veh_bike_basket', 'veh_bike_touring', 'veh_ebike_commuter'] as const;
const SCOOTER_MODELS = ['veh_scooter_electric', 'veh_moto_vesper'] as const;
const CAR_FLEET_SPECS = [
  { model: 'car_mango_micro', paintHex: '#4f7a74' },
  { model: 'car_river_sedan', paintHex: '#2f455c' },
  { model: 'car_mango_micro', paintHex: '#d8cfc0' },
  { model: 'car_river_sedan', paintHex: '#8d4c3d' },
] as const;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep01(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

function hashSeed(a: number, b: number): number {
  let t = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be59b, 0xc2b2ae35)) >>> 0;
  t ^= t >>> 15;
  t = Math.imul(t, 0x2c1b3c6d) >>> 0;
  t ^= t >>> 12;
  return t >>> 0;
}

function resolveModelMetrics(kind: TrafficVehicleKind, model: string): ModelMetrics {
  if (kind === 'car') {
    return CAR_MODEL_METRICS[model] ?? CAR_MODEL_METRICS.car_mango_micro;
  }
  const rec = (models as Record<string, { wheelbase: number; width: number; length: number; wheelRadius: number }>)[
    model
  ];
  if (rec) {
    return {
      wheelbase: rec.wheelbase,
      width: rec.width,
      length: rec.length,
      wheelRadius: rec.wheelRadius,
      maxSteerRad: kind === 'bicycle' ? 0.62 : 0.56,
      gearRatio: kind === 'bicycle' ? 2.45 : 0,
    };
  }
  return {
    wheelbase: 1.05,
    width: 0.54,
    length: 1.72,
    wheelRadius: 0.34,
    maxSteerRad: 0.62,
    gearRatio: kind === 'bicycle' ? 2.45 : 0,
  };
}

// Module-level zero-alloc scratch structures shared during single-threaded step()
const _sampleNow: SplineSample = createSplineSample();
const _sampleLook: SplineSample = createSplineSample();
const _probePose: CarPose = { x: 0, z: 0, yaw: 0 };
const _outEdgeScratch: number[] = [];

/**
 * Autonomous Right-Hand Road Spline Traffic Agent (bicycle, scooter, or car).
 * Extends `RoadVehicle` for seamless compatibility with `RoadVehicleView`, `workshopView`, and `session`.
 */
export class TrafficAgent extends RoadVehicle {
  readonly agentId: number;
  readonly kind: TrafficVehicleKind;
  readonly modelId: string;
  readonly hasPedals: boolean;
  readonly gearRatio: number;
  readonly hazardRadius: number;
  readonly rider = { x: 0, z: 0, yaw: 0 };
  readonly dynamics: TwoWheelerDynamicsState = createTwoWheelerState();

  /** Active flag managed by `TrafficSim` according to `trafficDensity` and time-of-day. */
  active = true;
  /** Unified Rider IK telemetry matching `RiderKinematicInput` (`recon_bike_vehicles.md`). */
  standDownBlend = 0;
  mountBlend = 1;
  armIkWeight = 1;
  /** Subtle chassis pitch (+ nose-dive on braking) and roll (outward body roll on turns) for cars. */
  pitch = 0;
  roll = 0;

  readonly graph: RoadGraph;
  edgeId = 0;
  nextEdgeId = -1;
  connector: TurnConnector | null = null;
  s = 0;
  latShift = 0;

  private readonly metrics: ModelMetrics;
  private readonly idm: IdmParams;
  private readonly cruiseJitter: number;
  private routeCounter = 0;
  private intersectionWaitSec = 0;
  private playerBlockSec = 0;
  private nextHornAllowedAt = 0;
  private lastAccel = 0;
  private crankVel = 0;
  private claimedIntersectionId = -1;
  private pendingRetire = false;

  constructor(
    walk: LifeWalk,
    road: { x0: number; x1: number; z0: number; z1: number } | null,
    fromWest: boolean,
    index: number,
    opts?: TrafficAgentInitOptions,
  ) {
    const kind: TrafficVehicleKind = opts?.kind ?? 'bicycle';
    super(walk, undefined, fromWest ? Math.PI * 0.5 : -Math.PI * 0.5, 0, kind === 'car' ? 'car' : kind === 'scooter' ? 'motorbike' : 'bike');

    this.agentId = index;
    this.kind = kind;
    this.modelId =
      opts?.model ??
      (kind === 'bicycle'
        ? BICYCLE_MODELS[index % BICYCLE_MODELS.length]
        : kind === 'scooter'
          ? SCOOTER_MODELS[index % SCOOTER_MODELS.length]
          : CAR_FLEET_SPECS[index % CAR_FLEET_SPECS.length].model);

    this.metrics = resolveModelMetrics(kind, this.modelId);
    this.hasPedals = kind === 'bicycle';
    this.gearRatio = this.metrics.gearRatio;
    this.hazardRadius = kind === 'car' ? 1.25 : 0.72;
    this.idm = IDM_BY_KIND[kind];
    this.cruiseJitter = 0.92 + ((hashSeed(index, opts?.seed ?? 17) % 17) / 100); // 0.92..1.08

    const paintHex =
      opts?.paintHex !== undefined
        ? opts.paintHex
        : kind === 'car'
          ? CAR_FLEET_SPECS[index % CAR_FLEET_SPECS.length].paintHex
          : null;

    this.spec = {
      model: this.modelId,
      name: kind === 'car' ? 'City commuter car' : kind === 'scooter' ? 'Urban scooter' : 'Campus commuter',
      instanceId: `traffic_${kind}_${index}`,
      maxSpeed: this.idm.v0 * this.cruiseJitter,
      reverseSpeed: 0,
      acceleration: this.idm.maxAccel,
      braking: this.idm.emergBrake,
      handling: 1.8,
      maxSteerRad: this.metrics.maxSteerRad,
      wheelRadius: this.metrics.wheelRadius,
      collisionRadius: Math.max(this.metrics.width * 0.5, this.hazardRadius * 0.6),
      paintHex,
    };

    this.graph = getOrBuildRoadGraph(walk.city);
    this.driving = true;
    this.speed = this.idm.v0 * this.cruiseJitter * 0.65;

    // Pick initial directed right-hand edge
    let startEdge: RoadEdge | null = null;
    if (opts?.startEdgeId !== undefined && this.graph.edges[opts.startEdgeId]) {
      startEdge = this.graph.edges[opts.startEdgeId];
    } else if (road) {
      const mx = (road.x0 + road.x1) * 0.5;
      const mz = (road.z0 + road.z1) * 0.5;
      const prefDir: CardinalDir = fromWest ? 0 : 2;
      startEdge = this.graph.findClosestEdge(mx, mz, prefDir, kind);
    }
    if (!startEdge) {
      startEdge = this.graph.edges.find((e) => kind === 'bicycle' || !e.bikeOnly) ?? this.graph.edges[0] ?? null;
    }

    if (startEdge) {
      this.edgeId = startEdge.id;
      const frac = 0.15 + ((hashSeed(index, 97) % 70) / 100);
      this.s = opts?.startS !== undefined ? clamp(opts.startS, 0, startEdge.length) : startEdge.length * frac;
      this.nextEdgeId = this.pickNextEdge(startEdge.id);
      const laneOff = LANE_PROFILES[this.kind].laneOffset;
      sampleRoadEdge(startEdge, this.s, laneOff, _sampleNow);
      this.pose.x = _sampleNow.x;
      this.pose.z = _sampleNow.z;
      this.pose.yaw = _sampleNow.yaw;
      this.rider.x = this.pose.x;
      this.rider.z = this.pose.z;
      this.rider.yaw = this.pose.yaw;
    }
  }

  get axles(): [number, number, number] {
    return [this.metrics.wheelbase, this.metrics.width, this.metrics.length];
  }

  /** Real speed used for pedestrian/resident hazard checks (`0` whenever parked or stopped!). */
  get effectiveHazardSpeed(): number {
    return this.active && this.driving && Math.abs(this.speed) >= 0.25 ? Math.abs(this.speed) : 0;
  }

  get lean(): number {
    return this.kind === 'car' ? this.roll : this.dynamics.lean;
  }

  get forkDive(): number {
    return this.kind === 'car' ? this.pitch : this.dynamics.forkDive;
  }

  get crankAngle(): number {
    return this.dynamics.crankAngle;
  }

  get activity(): string {
    if (!this.active) return 'idle';
    if (this.kind === 'car') return 'sit';
    if (this.kind === 'scooter') return 'cycle_coast';
    return !this.dynamics.coasting && this.speed > 0.35 ? 'cycle' : 'cycle_coast';
  }

  /** Requests smooth off-screen retirement when `trafficDensity` drops. */
  setPendingRetire(retire: boolean): void {
    this.pendingRetire = retire;
  }

  get isPendingRetire(): boolean {
    return this.pendingRetire;
  }

  private pickNextEdge(fromEdgeId: number): number {
    const count = this.graph.collectOutgoingEdges(fromEdgeId, this.kind, _outEdgeScratch);
    if (count <= 0) return fromEdgeId;
    if (count === 1) return _outEdgeScratch[0];

    const curEdge = this.graph.edges[fromEdgeId];
    // Weight straight continuation higher (55%) than left/right turns (22.5% each) for organic urban flow
    let totalW = 0;
    let pickId = _outEdgeScratch[0];
    const h = hashSeed(this.agentId * 31 + this.routeCounter++, fromEdgeId);
    let r = (h % 1000) / 1000;

    for (let i = 0; i < count; i++) {
      const cand = this.graph.edges[_outEdgeScratch[i]];
      totalW += cand.dir === curEdge.dir ? 2.4 : cand.isMajor ? 1.2 : 0.9;
    }
    r *= totalW;
    for (let i = 0; i < count; i++) {
      const cand = this.graph.edges[_outEdgeScratch[i]];
      const w = cand.dir === curEdge.dir ? 2.4 : cand.isMajor ? 1.2 : 0.9;
      r -= w;
      if (r <= 0) {
        pickId = cand.id;
        break;
      }
    }
    return pickId;
  }

  /**
   * Samples a point `aheadDist` meters ahead along the agent's continuous spline path
   * (`edge -> turnConnector -> nextEdge`) with lateral shift `latDelta`. Zero allocations.
   */
  private sampleAlongPath(aheadDist: number, latDelta: number, out: SplineSample): void {
    const laneOff = LANE_PROFILES[this.kind].laneOffset;
    if (this.connector) {
      const rem = this.connector.totalLength - this.s;
      if (aheadDist <= rem) {
        sampleTurnConnector(this.connector, this.s + aheadDist, latDelta, out);
        return;
      }
      const nextEdge = this.graph.edges[this.connector.outEdgeId];
      if (nextEdge) {
        sampleRoadEdge(nextEdge, aheadDist - rem, laneOff + latDelta, out);
        return;
      }
      sampleTurnConnector(this.connector, this.connector.totalLength, latDelta, out);
      return;
    }

    const edge = this.graph.edges[this.edgeId];
    if (!edge) return;
    const rem = edge.length - this.s;
    if (aheadDist <= rem) {
      sampleRoadEdge(edge, this.s + aheadDist, laneOff + latDelta, out);
      return;
    }
    const conn = this.graph.getConnector(this.edgeId, this.nextEdgeId, this.kind);
    if (conn) {
      const intoConn = aheadDist - rem;
      if (intoConn <= conn.totalLength) {
        sampleTurnConnector(conn, intoConn, latDelta, out);
        return;
      }
      const nextEdge = this.graph.edges[conn.outEdgeId];
      if (nextEdge) {
        sampleRoadEdge(nextEdge, intoConn - conn.totalLength, laneOff + latDelta, out);
        return;
      }
    }
    sampleRoadEdge(edge, edge.length, laneOff + latDelta, out);
  }

  /** Checks whether any peer or player vehicle is oncoming on `oppositeEdgeId` within `rangeM`. */
  private isOncomingLaneBusy(
    oppositeEdgeId: number,
    refX: number,
    refZ: number,
    rangeM: number,
    ctx?: TrafficStepContext,
  ): boolean {
    const opp = this.graph.edges[oppositeEdgeId];
    if (!opp) return false;
    const peers = ctx?.peers;
    if (peers) {
      for (let i = 0; i < peers.length; i++) {
        const other = peers[i];
        if (other === this || !other.active) continue;
        if (other.edgeId !== oppositeEdgeId) continue;
        const dx = refX - other.pose.x;
        const dz = refZ - other.pose.z;
        const alongOpp = dx * opp.tx + dz * opp.tz;
        if (alongOpp > -4.0 && alongOpp < rangeM) return true;
      }
    }
    const pv = ctx?.playerVehicle;
    if (pv) {
      const dx = refX - pv.x;
      const dz = refZ - pv.z;
      const alongOpp = dx * opp.tx + dz * opp.tz;
      const latOpp = Math.abs((pv.x - opp.x0) * opp.rx + (pv.z - opp.z0) * opp.rz);
      if (alongOpp > -4.0 && alongOpp < rangeM && latOpp < 3.6) return true;
    }
    return false;
  }

  /** Checks if any priority peer or player vehicle conflicts at upcoming intersection `interId`. */
  private hasPriorityConflict(
    interId: number,
    curEdge: RoadEdge,
    nextConn: TurnConnector,
    ctx?: TrafficStepContext,
  ): boolean {
    const inter = this.graph.intersections[interId];
    if (!inter) return false;

    const mustYieldToMajor = !curEdge.isMajor;
    const isLeftTurn = nextConn.kind === 'left';
    if (!mustYieldToMajor && !isLeftTurn) return false;

    const checkIncoming = (x: number, z: number, vx: number, vz: number, otherIsMajor: boolean, otherDir: number) => {
      const dx = inter.x - x;
      const dz = inter.z - z;
      const dist = Math.hypot(dx, dz);
      if (dist > 17.5 || dist < 0.5) return false;
      const approachSpeed = (vx * dx + vz * dz) / dist;
      if (approachSpeed < 0.6) return false;
      const tta = dist / approachSpeed;
      if (tta > 3.2 && dist > 9.0) return false;
      if (mustYieldToMajor && otherIsMajor) return true;
      if (isLeftTurn && otherDir === ((curEdge.dir + 2) & 3)) return true;
      return false;
    };

    const peers = ctx?.peers;
    if (peers) {
      for (let i = 0; i < peers.length; i++) {
        const o = peers[i];
        if (o === this || !o.active) continue;
        const oEdge = this.graph.edges[o.edgeId];
        if (!oEdge) continue;
        // Conflicting vehicle already inside this intersection box
        if (o.connector && o.connector.intersectionId === interId) return true;
        if (oEdge.toNode === interId) {
          const ovx = Math.sin(o.pose.yaw) * o.speed;
          const ovz = Math.cos(o.pose.yaw) * o.speed;
          if (checkIncoming(o.pose.x, o.pose.z, ovx, ovz, oEdge.isMajor, oEdge.dir)) return true;
        }
      }
    }

    const pv = ctx?.playerVehicle;
    if (pv) {
      const pSpd = pv.speed ?? Math.hypot(pv.vx, pv.vz);
      if (pSpd > 0.8) {
        const dx = inter.x - pv.x;
        const dz = inter.z - pv.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 18 && dist > 0.5) {
          const approach = (pv.vx * dx + pv.vz * dz) / dist;
          if (approach > 0.8 && dist / approach < 3.4) return true;
        }
      }
    }

    return false;
  }

  /**
   * Advances this traffic agent by `dt` seconds along the Right-Hand Traffic `RoadGraph`.
   * Backward-compatible with `Commuter.step(dt, rain, clear)` while supporting rich `TrafficStepContext`.
   */
  step(dt: number, rain: boolean, clear: CarClearance, ctx?: TrafficStepContext): void {
    const safeDt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    if (!this.active || safeDt <= 0 || !this.spec || !this.graph.edges.length) return;

    this.clock += safeDt;
    const env: EnvironmentLightConditions = ctx?.env ?? {
      dayWeight: 1,
      rainWeight: rain ? 0.75 : 0,
      snowWeight: 0,
    };
    this.lastEnv = env;
    this.wetRoad = rain || env.rainWeight > 0.1;
    this.snowyRoad = (env.snowWeight ?? 0) > 0.1;

    const metrics = LANE_PROFILES[this.kind];
    const halfW = this.metrics.width * 0.5;
    const halfL = this.metrics.length * 0.5;
    const surfaceGrip = computeTireSurfaceGrip(this.wetRoad, this.snowyRoad, 'road');
    const weatherSpeedMult = this.snowyRoad ? 0.7 : this.wetRoad ? 0.84 : 1.0;

    // 1. Ensure upcoming edge & connector are pre-selected
    const curEdge = this.graph.edges[this.edgeId];
    if (!curEdge) return;
    if (this.nextEdgeId < 0 || !this.graph.edges[this.nextEdgeId]) {
      this.nextEdgeId = this.pickNextEdge(this.edgeId);
    }
    const nextConn = this.connector ?? this.graph.getConnector(this.edgeId, this.nextEdgeId, this.kind);

    // 2. Desired speed `v0Eff` capped by upcoming corner curvature (`sqrt(a_lat * mu * R)`)
    let v0Eff = this.idm.v0 * this.cruiseJitter * weatherSpeedMult;
    if (this.connector && Number.isFinite(this.connector.arcRadius)) {
      const vCurve = Math.sqrt(metrics.maxLatAccel * surfaceGrip * this.connector.arcRadius);
      if (vCurve < v0Eff) v0Eff = vCurve;
    } else if (nextConn && Number.isFinite(nextConn.arcRadius) && curEdge.length - this.s < 14) {
      const vCurve = Math.sqrt(metrics.maxLatAccel * surfaceGrip * nextConn.arcRadius);
      if (vCurve < v0Eff) v0Eff = vCurve;
    }

    // 3. Evaluate IDM virtual & physical lead hazards + MOBIL-lite curb-parking bypass
    let minGap = Infinity;
    let leadSpeed = v0Eff;
    let emergencyStop = false;
    let blockedByPlayer = false;
    let waitingAtIntersection = false;
    let targetLatShift = 0;

    const considerObstacle = (gap: number, vLead: number, emerg = false) => {
      if (gap < minGap) {
        minGap = gap;
        leadSpeed = vLead;
      }
      if (emerg) emergencyStop = true;
    };

    const fwdX = Math.sin(this.pose.yaw);
    const fwdZ = Math.cos(this.pose.yaw);
    const rightX = -fwdZ;
    const rightZ = fwdX;

    // 3a. Curb-parked cars & stationary parked vehicles (MOBIL-lite oncoming-aware bypass!)
    if (!this.connector) {
      // Static curb bays indexed on this edge
      for (let b = 0; b < curEdge.curbBays.length; b++) {
        const bay = curEdge.curbBays[b];
        const distToStart = bay.sStart - this.s - halfL;
        const distPastEnd = this.s - halfL - bay.sEnd;
        if (distToStart > 14 || distPastEnd > 3.5) continue;

        const neededLat = bay.innerEdgeLat - (halfW + 0.35);
        if (neededLat < metrics.laneOffset) {
          const shiftNeeded = neededLat - metrics.laneOffset; // negative -> inward toward median
          const crossesCenterline = neededLat - halfW < 0.05;
          const oncomingBusy =
            crossesCenterline &&
            this.isOncomingLaneBusy(curEdge.oppositeEdgeId, bay.cx, bay.cz, 19.0, ctx);

          if (oncomingBusy && distToStart > -0.5) {
            considerObstacle(Math.max(0.1, distToStart - 2.6), 0, distToStart < 2.0);
          } else {
            const approachRamp = smoothstep01((10.5 - distToStart) / 7.5);
            const exitRamp = smoothstep01((3.5 - distPastEnd) / 3.5);
            const shift = shiftNeeded * approachRamp * exitRamp;
            if (shift < targetLatShift) targetLatShift = shift;
          }
        }
      }

      // Dynamic stationary parked vehicles (player car / two-wheeler / stopped traffic)
      const parked = ctx?.parkedVehicles;
      if (parked) {
        for (let k = 0; k < parked.length; k++) {
          const pv = parked[k];
          const dx = pv.x - curEdge.x0;
          const dz = pv.z - curEdge.z0;
          const sObs = dx * curEdge.tx + dz * curEdge.tz;
          const latObs = dx * curEdge.rx + dz * curEdge.rz;
          const obsHalfL = pv.halfLength ?? pv.radius;
          const obsHalfW = pv.halfWidth ?? pv.radius * 0.72;
          if (latObs + obsHalfW < 0.05 || latObs - obsHalfW > 3.7) continue;

          const distToStart = sObs - obsHalfL - this.s - halfL;
          const distPastEnd = this.s - halfL - (sObs + obsHalfL);
          if (distToStart > 14 || distPastEnd > 3.5) continue;

          const innerLat = latObs - obsHalfW;
          const outerLat = latObs + obsHalfW;
          if (metrics.laneOffset + halfW + 0.25 > innerLat && metrics.laneOffset - halfW - 0.25 < outerLat) {
            const safeLat = innerLat - (halfW + 0.36);
            if (safeLat - halfW > -1.4) {
              const oncomingBusy =
                safeLat - halfW < 0.05 &&
                this.isOncomingLaneBusy(curEdge.oppositeEdgeId, pv.x, pv.z, 19.0, ctx);
              if (oncomingBusy && distToStart > -0.5) {
                considerObstacle(Math.max(0.1, distToStart - 2.6), 0, distToStart < 2.0);
              } else {
                const approachRamp = smoothstep01((10.5 - distToStart) / 7.5);
                const exitRamp = smoothstep01((3.5 - distPastEnd) / 3.5);
                const shift = (safeLat - metrics.laneOffset) * approachRamp * exitRamp;
                if (shift < targetLatShift) targetLatShift = shift;
              }
            } else if (distToStart > -0.5) {
              // Lane fully blocked (e.g. parked dead center): wait smoothly
              considerObstacle(Math.max(0.1, distToStart - 2.2), 0, distToStart < 1.8);
            }
          }
        }
      }
    }

    // 3b. Peer traffic vehicle car-following (IDM)
    const peers = ctx?.peers;
    if (peers) {
      for (let i = 0; i < peers.length; i++) {
        const o = peers[i];
        if (o === this || !o.active) continue;
        const dx = o.pose.x - this.pose.x;
        const dz = o.pose.z - this.pose.z;
        const distSq = dx * dx + dz * dz;
        if (distSq > 676) continue; // > 26 m

        const fwd = dx * fwdX + dz * fwdZ;
        const lat = Math.abs(dx * rightX + dz * rightZ);
        const oHalfW = o.metrics.width * 0.5;
        const oHalfL = o.metrics.length * 0.5;
        const headingDot = Math.sin(o.pose.yaw) * fwdX + Math.cos(o.pose.yaw) * fwdZ;

        // Same-direction or crossing-ahead vehicle inside our corridor
        if (fwd > 0 && lat < halfW + oHalfW + 0.55) {
          if (headingDot > -0.35 || lat < halfW + oHalfW + 0.25) {
            const bumperGap = fwd - halfL - oHalfL;
            const projLeadSpd = Math.max(0, o.speed * headingDot);
            considerObstacle(bumperGap, projLeadSpd, bumperGap < 1.8);
          }
        }
      }
    }

    // 3c. Driven player vehicle ahead in corridor
    const pv = ctx?.playerVehicle;
    if (pv) {
      const dx = pv.x - this.pose.x;
      const dz = pv.z - this.pose.z;
      const fwd = dx * fwdX + dz * fwdZ;
      const lat = Math.abs(dx * rightX + dz * rightZ);
      const pvRad = pv.radius ?? 1.25;
      if (fwd > 0 && fwd < 24 && lat < halfW + pvRad + 0.55) {
        const bumperGap = fwd - halfL - pvRad;
        const projSpd = Math.max(0, pv.vx * fwdX + pv.vz * fwdZ);
        considerObstacle(bumperGap, projSpd, bumperGap < 2.2);
      }
    }

    // 3d. Intersection priority & box reservation stop-line
    if (!this.connector && nextConn) {
      const distToEnd = curEdge.length - this.s;
      if (distToEnd < 16.0) {
        const interId = curEdge.toNode;
        const priorityBusy =
          this.intersectionWaitSec < 4.2 && this.hasPriorityConflict(interId, curEdge, nextConn, ctx);
        let boxBlocked = false;
        if (distToEnd < 5.0 && !priorityBusy) {
          const claimed = this.graph.tryClaimIntersection(interId, this.agentId, this.clock, 6.0);
          if (claimed) {
            this.claimedIntersectionId = interId;
          } else if (this.intersectionWaitSec < 4.8) {
            boxBlocked = true;
          }
        }
        if (priorityBusy || boxBlocked) {
          waitingAtIntersection = true;
          considerObstacle(Math.max(0.1, distToEnd - halfL - 0.6), 0, distToEnd < halfL + 1.2);
        }
      }
    }

    // 3e. Zebra crosswalk & pedestrian yield (Player on foot + 22 Named Residents + Ambient Crowd)
    const checkPedestrian = (px: number, pz: number, isPlayer: boolean) => {
      const dx = px - this.pose.x;
      const dz = pz - this.pose.z;
      const fwd = dx * fwdX + dz * fwdZ;
      if (fwd <= -0.5 || fwd > 15.0) return;
      const lat = Math.abs(dx * rightX + dz * rightZ);
      if (lat < halfW + 1.15) {
        const bumperGap = fwd - halfL - 0.85;
        considerObstacle(bumperGap, 0, bumperGap < 2.6);
        if (isPlayer && fwd < 5.2) blockedByPlayer = true;
      }
    };

    const playerPos = ctx?.playerPos;
    if (playerPos) checkPedestrian(playerPos.x, playerPos.z, true);

    const res = ctx?.residents;
    if (res && res.count > 0) {
      for (let r = 0; r < res.count; r++) {
        checkPedestrian(res.posX[r], res.posZ[r], false);
      }
    }

    const crowd = ctx?.crowd;
    if (crowd) {
      for (let c = 0; c < crowd.length; c++) {
        checkPedestrian(crowd[c].x, crowd[c].z, false);
      }
    }

    // Check mapped crosswalks ahead on current edge for any pedestrian occupying the zebra stripes
    if (!this.connector && curEdge.crosswalks.length > 0 && (playerPos || res || crowd)) {
      for (let w = 0; w < curEdge.crosswalks.length; w++) {
        const cw = curEdge.crosswalks[w];
        const distToStop = cw.sStop - this.s - halfL;
        if (distToStop < -1.0 || distToStop > 15.0) continue;
        const r = cw.rect;
        let occupied = false;
        if (
          playerPos &&
          playerPos.x >= r.x0 - 0.9 &&
          playerPos.x <= r.x1 + 0.9 &&
          playerPos.z >= r.z0 - 0.9 &&
          playerPos.z <= r.z1 + 0.9
        ) {
          occupied = true;
          if (distToStop < 3.5) blockedByPlayer = true;
        }
        if (!occupied && res) {
          for (let i = 0; i < res.count; i++) {
            const rx = res.posX[i];
            const rz = res.posZ[i];
            if (rx >= r.x0 - 0.8 && rx <= r.x1 + 0.8 && rz >= r.z0 - 0.8 && rz <= r.z1 + 0.8) {
              occupied = true;
              break;
            }
          }
        }
        if (!occupied && crowd) {
          for (let i = 0; i < crowd.length; i++) {
            const crp = crowd[i];
            if (crp.x >= r.x0 - 0.7 && crp.x <= r.x1 + 0.7 && crp.z >= r.z0 - 0.7 && crp.z <= r.z1 + 0.7) {
              occupied = true;
              break;
            }
          }
        }
        if (occupied) {
          considerObstacle(Math.max(0.1, distToStop), 0, distToStop < 2.2);
        }
      }
    }

    // 3f. Backward-compatible `clear()` callback probe when `ctx` is omitted (Wave 1 `gameView.ts`)
    if (!ctx) {
      const lookNear = halfL + 1.8;
      const lookFar = halfL + 4.8;
      this.sampleAlongPath(lookNear, this.latShift, _sampleLook);
      _probePose.x = _sampleLook.x;
      _probePose.z = _sampleLook.z;
      _probePose.yaw = _sampleLook.yaw;
      if (!clear(_probePose, halfW + 0.12, halfL)) {
        considerObstacle(0.4, 0, true);
      } else {
        this.sampleAlongPath(lookFar, this.latShift, _sampleLook);
        _probePose.x = _sampleLook.x;
        _probePose.z = _sampleLook.z;
        _probePose.yaw = _sampleLook.yaw;
        if (!clear(_probePose, halfW + 0.12, halfL)) {
          considerObstacle(3.0, 0, false);
        }
      }
    }

    // Track intersection anti-deadlock wait timer & polite player courtesy bell/horn
    if (waitingAtIntersection && this.speed < 0.35) {
      this.intersectionWaitSec += safeDt;
    } else if (!waitingAtIntersection) {
      this.intersectionWaitSec = 0;
    }

    if (blockedByPlayer && this.speed < 0.35) {
      this.playerBlockSec += safeDt;
      if (this.playerBlockSec > 3.5 && this.clock >= this.nextHornAllowedAt) {
        triggerVehicleHorn(this.lights, this.clock, 0.28);
        this.nextHornAllowedAt = this.clock + 14.0;
        this.playerBlockSec = 0;
      }
    } else {
      this.playerBlockSec = Math.max(0, this.playerBlockSec - safeDt * 2);
    }

    // 4. Intelligent Driver Model (IDM) longitudinal acceleration & speed integration
    const vRatio = this.speed / Math.max(0.5, v0Eff);
    const v4 = vRatio * vRatio * vRatio * vRatio;
    let interaction = 0;
    if (Number.isFinite(minGap)) {
      const dv = this.speed - leadSpeed;
      const twoSqrtAB = 2 * Math.sqrt(this.idm.maxAccel * this.idm.comfortBrake);
      const sStar = this.idm.s0 + Math.max(0, this.speed * this.idm.headwayT + (this.speed * dv) / twoSqrtAB);
      const safeGap = Math.max(0.22, minGap);
      const ratio = sStar / safeGap;
      interaction = ratio * ratio;
    }
    let accel = this.idm.maxAccel * (1 - v4 - interaction);
    if (emergencyStop) accel = Math.min(accel, -this.idm.emergBrake);
    accel = clamp(accel, -this.idm.emergBrake, this.idm.maxAccel);

    const prevSpeed = this.speed;
    this.speed = clamp(this.speed + accel * safeDt, 0, v0Eff * 1.04);
    if (this.speed < 0.03 && accel <= 0) this.speed = 0;
    this.lastAccel = (this.speed - prevSpeed) / Math.max(safeDt, 1e-4);

    // Smooth lateral bypass offset
    this.latShift += (targetLatShift - this.latShift) * (1 - Math.exp(-5.5 * safeDt));

    // 5. Advance longitudinal coordinate `s` seamlessly across Edge -> TurnConnector -> NextEdge
    let travel = this.speed * safeDt;
    let safetyHops = 0;
    while (travel > 1e-6 && safetyHops++ < 4) {
      if (this.connector) {
        const rem = this.connector.totalLength - this.s;
        if (travel < rem) {
          this.s += travel;
          travel = 0;
        } else {
          travel -= rem;
          const finishedInter = this.connector.intersectionId;
          const outId = this.connector.outEdgeId;
          this.connector = null;
          this.edgeId = outId;
          this.s = 0;
          this.nextEdgeId = this.pickNextEdge(outId);
          this.intersectionWaitSec = 0;
          if (this.claimedIntersectionId === finishedInter) {
            this.graph.releaseIntersection(finishedInter, this.agentId);
            this.claimedIntersectionId = -1;
          }
        }
      } else {
        const edge = this.graph.edges[this.edgeId];
        if (!edge) break;
        const rem = edge.length - this.s;
        if (travel < rem) {
          this.s += travel;
          travel = 0;
        } else {
          travel -= rem;
          const conn = this.graph.getConnector(this.edgeId, this.nextEdgeId, this.kind);
          if (conn) {
            this.connector = conn;
            this.s = 0;
            this.latShift = 0;
          } else {
            this.s = 0;
            break;
          }
        }
      }
    }

    // 6. Sample authoritative world pose + Pure-Pursuit & Curvature Feedforward Ackermann steer
    this.sampleAlongPath(0, this.latShift, _sampleNow);
    const lookDist = clamp(1.4 + 0.45 * this.speed, 1.4, 5.2);
    this.sampleAlongPath(lookDist, this.latShift, _sampleLook);

    this.pose.x = _sampleNow.x;
    this.pose.z = _sampleNow.z;
    this.pose.yaw = _sampleNow.yaw;

    const toLookX = _sampleLook.x - _sampleNow.x;
    const toLookZ = _sampleLook.z - _sampleNow.z;
    const alpha = wrapAnglePi(Math.atan2(toLookX, toLookZ) - _sampleNow.yaw);
    const ffSteer = Math.atan(this.metrics.wheelbase * _sampleNow.curvature);
    const ppSteer = Math.atan((2 * this.metrics.wheelbase * Math.sin(alpha)) / Math.max(0.8, lookDist));
    const targetSteer = clamp(ffSteer + 0.55 * ppSteer, -this.metrics.maxSteerRad, this.metrics.maxSteerRad);
    this.steer += (targetSteer - this.steer) * (1 - Math.exp(-9.0 * safeDt));

    // Wheel spin (zero slip)
    this.spin += (this.speed * safeDt) / Math.max(0.15, this.metrics.wheelRadius);

    // 7. Chassis / Two-Wheeler dynamics + Freewheel Crank & Stand-Down Balance
    const isBraking = this.lastAccel < -0.55 || (this.speed < 0.15 && Number.isFinite(minGap));
    const throttleNorm = this.lastAccel > 0.15 && !isBraking ? clamp(this.lastAccel / this.idm.maxAccel, 0.1, 1) : this.speed > 0.4 && !isBraking ? 0.45 : 0;

    if (this.kind === 'car') {
      const targetPitch = clamp(-this.lastAccel * 0.0085, -0.032, 0.042);
      const latAccel = this.speed * this.speed * _sampleNow.curvature;
      const targetRoll = clamp(latAccel * 0.011, -0.048, 0.048);
      const damp = 1 - Math.exp(-8.0 * safeDt);
      this.pitch += (targetPitch - this.pitch) * damp;
      this.roll += (targetRoll - this.roll) * damp;
      this.standDownBlend = 0;
    } else {
      const profile = getTwoWheelerHandlingProfile(this.modelId);
      stepTwoWheelerDynamics({
        state: this.dynamics,
        profile,
        driving: true,
        speed: this.speed,
        steer: this.steer,
        throttle: throttleNorm,
        brake: isBraking,
        forwardAccel: this.lastAccel,
        wetRoad: this.wetRoad,
        snowyRoad: this.snowyRoad,
        surfaceGrip,
        dt: safeDt,
      });

      // Exact freewheel crank phase integration (`recon_bike_vehicles.md §4.3`: omega = 0 at v = 0!)
      if (this.hasPedals) {
        const propelling = this.speed > 0.08 && throttleNorm > 0.05 && !isBraking;
        if (propelling) {
          const targetOmega = this.speed / Math.max(0.2, this.metrics.wheelRadius * this.gearRatio);
          this.crankVel += (targetOmega - this.crankVel) * (1 - Math.exp(-16 * safeDt));
          this.dynamics.crankAngle = (this.dynamics.crankAngle + this.crankVel * safeDt) % (Math.PI * 2);
          this.dynamics.pedalCadence = this.crankVel;
          this.dynamics.coasting = false;
        } else if (this.speed <= 0.04) {
          this.crankVel = 0;
          this.dynamics.pedalCadence = 0;
          this.dynamics.coasting = true;
        } else {
          this.crankVel *= Math.exp(-9 * safeDt);
          if (this.crankVel < 0.02) this.crankVel = 0;
          this.dynamics.crankAngle = (this.dynamics.crankAngle + this.crankVel * safeDt) % (Math.PI * 2);
          this.dynamics.pedalCadence = this.crankVel;
          this.dynamics.coasting = true;
        }
      } else {
        this.crankVel = 0;
        this.dynamics.pedalCadence = 0;
        this.dynamics.coasting = true;
      }

      // Smooth stopped foot-down balance (`standDownBlend`: 0 -> 1 when stopped at crosswalks!)
      const wantFootDown =
        this.speed < 0.22 && throttleNorm <= 0.05
          ? 1
          : this.speed > 0.55 || (throttleNorm > 0.05 && this.speed > 0.12)
            ? 0
            : this.standDownBlend;
      this.standDownBlend += (wantFootDown - this.standDownBlend) * (1 - Math.exp(-7.5 * safeDt));
      if (this.standDownBlend > 0.01) {
        // Gentle left lean (-0.075 rad) while left foot supports stopped bike/scooter
        this.dynamics.lean = this.dynamics.lean * (1 - this.standDownBlend) + -0.075 * this.standDownBlend;
      }
    }

    // 8. Automatic turn blinkers (10 m before turn), headlights (dusk/night/rain), and brake lights
    let blinkerSide = 0;
    const upcomingTurn = this.connector ?? (curEdge.length - this.s < 11.0 ? nextConn : null);
    if (upcomingTurn) {
      if (upcomingTurn.kind === 'left') blinkerSide = -1;
      else if (upcomingTurn.kind === 'right') blinkerSide = 1;
    }

    stepVehicleLights({
      lights: this.lights,
      dt: safeDt,
      nowSeconds: this.clock,
      driving: true,
      speed: this.speed,
      throttle: throttleNorm,
      sideInput: blinkerSide,
      steer: this.steer,
      brake: isBraking,
      env,
    });

    // Keep rider pose synchronized directly to vehicle pose (0 trailing lag!)
    this.rider.x = this.pose.x;
    this.rider.z = this.pose.z;
    this.rider.yaw = this.pose.yaw;
  }
}

/**
 * Backward-compatible `Commuter` alias used by `session.ts` & `gameView.ts`.
 * Inherits full Right-Hand Traffic road-spline navigation, smooth corner arcs, IDM following,
 * MOBIL-lite curb-car bypass, and real `speed === 0` stop behavior out of the box!
 */
export class Commuter extends TrafficAgent {
  constructor(
    walk: LifeWalk,
    road: { x0: number; x1: number; z0: number; z1: number },
    fromWest: boolean,
    i: number,
    opts?: TrafficAgentInitOptions,
  ) {
    super(walk, road, fromWest, i, { kind: 'bicycle', ...opts });
  }
}

/**
 * Zero-allocation multi-vehicle urban traffic fleet manager (`4` cyclists + `2` scooters + `4` cars = `10` max).
 * Scales smoothly from `3..10` active vehicles via `Manage City` `trafficDensity` (`0.3..1.5`),
 * time-of-day (`night: 0.5x`), and weather (`rain: 0.8x`), retiring/activating only off-screen (`> 55 m`).
 */
export class TrafficSim {
  readonly graph: RoadGraph;
  readonly agents: TrafficAgent[];

  /** Pre-allocated moving vehicle hazard pool (`speed >= 0.25 m/s` ONLY — never parked missiles!). */
  private readonly hazardPool: VehicleHazard[] = [];
  readonly activeHazards: VehicleHazard[] = [];
  /** Pre-allocated footprints of currently stopped traffic vehicles (`speed < 0.25 m/s`). */
  private readonly footprintPool: VehicleFootprint[] = [];
  readonly stoppedFootprints: VehicleFootprint[] = [];

  private readonly dummyClear: CarClearance = () => true;
  private readonly stepCtxScratch: {
    env?: EnvironmentLightConditions;
    phase?: string;
    playerPos?: TrafficPedestrianPoint | null;
    playerVehicle?: VehicleHazard | null;
    residents?: ResidentKinematicsView | null;
    crowd?: readonly TrafficPedestrianPoint[];
    parkedVehicles?: readonly ParkedVehicleHazard[];
    peers?: readonly TrafficAgent[];
    densityMultiplier?: number;
  } = {};

  constructor(walk: LifeWalk) {
    this.graph = getOrBuildRoadGraph(walk.city);
    this.agents = [];

    // Canonical 10-slot mixed fleet order (first 3 always active even at 0.3x quiet density):
    // Slots 0,1: Cyclists | Slot 2: Compact EV Car | Slot 3: Cyclist | Slot 4: Scooter
    // Slot 5: Sedan Car | Slot 6: Cyclist | Slot 7: Scooter | Slot 8: Compact EV | Slot 9: Sedan
    const roster: readonly { kind: TrafficVehicleKind; model: string; paintHex: string | null }[] = [
      { kind: 'bicycle', model: BICYCLE_MODELS[0], paintHex: null },
      { kind: 'bicycle', model: BICYCLE_MODELS[1], paintHex: null },
      { kind: 'car', model: CAR_FLEET_SPECS[0].model, paintHex: CAR_FLEET_SPECS[0].paintHex },
      { kind: 'bicycle', model: BICYCLE_MODELS[2], paintHex: null },
      { kind: 'scooter', model: SCOOTER_MODELS[0], paintHex: null },
      { kind: 'car', model: CAR_FLEET_SPECS[1].model, paintHex: CAR_FLEET_SPECS[1].paintHex },
      { kind: 'bicycle', model: BICYCLE_MODELS[3], paintHex: null },
      { kind: 'scooter', model: SCOOTER_MODELS[1], paintHex: null },
      { kind: 'car', model: CAR_FLEET_SPECS[2].model, paintHex: CAR_FLEET_SPECS[2].paintHex },
      { kind: 'car', model: CAR_FLEET_SPECS[3].model, paintHex: CAR_FLEET_SPECS[3].paintHex },
    ];

    const coreEdges = this.graph.edges.filter((e) => !e.bikeOnly);
    const stride = Math.max(1, Math.floor(coreEdges.length / roster.length));

    for (let i = 0; i < roster.length; i++) {
      const def = roster[i];
      const startEdge = coreEdges[(i * stride + (i % 2)) % Math.max(1, coreEdges.length)];
      const startS = startEdge ? startEdge.length * (0.25 + ((i * 23) % 50) / 100) : 0;
      const agent = new TrafficAgent(walk, null, i % 2 === 0, i, {
        kind: def.kind,
        model: def.model,
        paintHex: def.paintHex,
        startEdgeId: startEdge?.id,
        startS,
        seed: 101 + i * 37,
      });
      this.agents.push(agent);
      this.hazardPool.push({ x: 0, z: 0, vx: 0, vz: 0, speed: 0, radius: agent.hazardRadius, hornActive: false });
      const [, track, length] = agent.axles;
      const hw = track * 0.5 + 0.12;
      const hl = length * 0.5;
      this.footprintPool.push({
        x: 0,
        z: 0,
        yaw: 0,
        halfWidth: hw,
        halfLength: hl,
        radius: Math.hypot(hw, hl),
        driving: false,
      });
    }
  }

  /** Registers static curb-parked car footprints ONCE for MOBIL-lite lateral bypassing. */
  registerCurbBoxes(boxes: readonly CurbBoxInput[]): void {
    this.graph.registerCurbBoxes(boxes);
  }

  /** Computes desired active vehicle count (`3..10`) from Manage City density, phase, and rain. */
  computeTargetCount(densityMult = trafficDensityMultiplier, phase = 'day', rain = false): number {
    const safeMult = clamp(Number.isFinite(densityMult) ? densityMult : 0.9, 0.3, 1.5);
    const timeMult = phase === 'night' ? 0.5 : 1.0;
    const weatherMult = rain ? 0.8 : 1.0;
    // At 1.0x day dry -> 9 vehicles; at 0.3x -> 3 vehicles; at 1.5x -> 10 vehicles
    return clamp(Math.round(9 * safeMult * timeMult * weatherMult), 3, MAX_TRAFFIC_AGENTS);
  }

  /** Steps all active traffic vehicles cleanly with zero per-frame allocations. */
  step(dt: number, rain: boolean, ctx?: TrafficStepContext, clear?: CarClearance): void {
    const target = this.computeTargetCount(ctx?.densityMultiplier ?? trafficDensityMultiplier, ctx?.phase, rain);
    const playerPos = ctx?.playerPos;

    // Smooth off-screen density scaling (> 55 m from player -> zero visible pop-in/out!)
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      const wantActive = i < target;
      if (wantActive && !a.active) {
        const dPlayer = playerPos ? Math.hypot(a.pose.x - playerPos.x, a.pose.z - playerPos.z) : 100;
        if (dPlayer > 55) {
          a.active = true;
          a.setPendingRetire(false);
        }
      } else if (!wantActive && a.active) {
        a.setPendingRetire(true);
        const dPlayer = playerPos ? Math.hypot(a.pose.x - playerPos.x, a.pose.z - playerPos.z) : 100;
        if (dPlayer > 55) {
          a.active = false;
          a.speed = 0;
        }
      } else if (wantActive) {
        a.setPendingRetire(false);
      }
    }

    const stepCtx = this.stepCtxScratch;
    stepCtx.env = ctx?.env;
    stepCtx.phase = ctx?.phase;
    stepCtx.playerPos = ctx?.playerPos;
    stepCtx.playerVehicle = ctx?.playerVehicle;
    stepCtx.residents = ctx?.residents;
    stepCtx.crowd = ctx?.crowd;
    stepCtx.parkedVehicles = ctx?.parkedVehicles;
    stepCtx.peers = ctx?.peers ?? this.agents;
    stepCtx.densityMultiplier = ctx?.densityMultiplier;
    const clearFn = clear ?? this.dummyClear;

    this.activeHazards.length = 0;
    this.stoppedFootprints.length = 0;

    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.active) continue;
      a.step(dt, rain, clearFn, stepCtx);

      const spd = a.effectiveHazardSpeed;
      if (spd >= 0.25) {
        const slot = this.hazardPool[i];
        slot.x = a.pose.x;
        slot.z = a.pose.z;
        slot.vx = Math.sin(a.pose.yaw) * a.speed;
        slot.vz = Math.cos(a.pose.yaw) * a.speed;
        slot.speed = spd;
        slot.radius = a.hazardRadius;
        slot.hornActive = a.lights.hornActive;
        this.activeHazards.push(slot);
      } else {
        const fp = this.footprintPool[i];
        fp.x = a.pose.x;
        fp.z = a.pose.z;
        fp.yaw = a.pose.yaw;
        fp.driving = false;
        this.stoppedFootprints.push(fp);
      }
    }
  }
}
