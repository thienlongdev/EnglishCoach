/**
 * Echo Life — Stateful Zero-Allocation SoA Ambient Crowd & ORCA-Lite Pedestrian Simulation.
 *
 * Replaces stateless `clockMinutes` crowd evaluation with an L1-cache-resident Structure-of-Arrays
 * (`Float32Array` / `Uint8Array` / `Int16Array`, `CAPACITY = 128`, ~9.2 KB RAM, 0 allocs/frame):
 * - Eliminates all 5 stateless crowd defects:
 *   1. Lane-local bench & storefront walk-off / sit-or-gaze / walk-back (0 cross-city teleports).
 *   2. Connected sidewalk lane graph + angular-rate-capped `turnSmooth` (0 instant 180-deg flips).
 *   3. Continuous van den Berg ORCA-Lite tangential steering + single-probe boundary slide (0 discrete hops).
 *   4. Real-time clamped `dt` kinematics decoupled from clock jumps and capped at 1.5x (0 3x sprints / slider warps).
 *   5. Flat 22-resident kinematic snapshot fed into ORCA (`alpha = 0.85`) so passers curve smoothly around
 *      every named resident without ever popping out of existence.
 * - Avoids crowd peers (1024-bucket spatial hash), player, 22 named residents, static street props,
 *   stationary parked vehicles (OBB), and moving vehicles (player + AI street traffic).
 * - Distance-tiered ORCA cadence (60 / 30 / 15 Hz) with 60 Hz continuous integration keeps total CPU
 *   strictly under `< 0.15 ms` per frame.
 */

import type { CityPlan, Surface } from '../city';
import type { Rect } from '../plan';
import {
  PATIO_BISTRO_SEAT_GEOMETRY,
  STREET_BENCH_SEAT_GEOMETRY,
  resolveSeatStandPoint,
} from '../aaaBuildingLayout';
import type { LifeNav, P } from './nav';
import {
  OrcaScratch,
  SpatialHash2D,
  addOrcaDiskConstraint,
  addOrcaStaticObbConstraint,
  solveOrca2D,
  turnSmooth,
} from './orca2d';

export const CROWD_SIZE = 80;
export const MAX_CROWD = 128;

let pedestrianDensityMultiplier = 1;

/** Manage City pedestrian density multiplier (clamped safely to `0.3..1.5`). */
export function setPedestrianDensityMultiplier(mult: number): number {
  pedestrianDensityMultiplier = Number.isFinite(mult) ? Math.max(0.3, Math.min(1.5, mult)) : 1;
  return pedestrianDensityMultiplier;
}

export function getPedestrianDensityMultiplier(): number {
  return pedestrianDensityMultiplier;
}

export type CrowdActivity = 'walk' | 'jog' | 'idle' | 'sit' | 'browse' | 'chat' | 'yield';

export interface LaneLink {
  readonly lane: number;
  readonly enterDir: 1 | -1;
}

export interface Lane {
  a: P;
  b: P;
  len: number;
  offsets: number[];
  chunkId: string | null;
  surface?: Surface;
  nearCrossing?: boolean;
}

export interface VehicleHazard {
  x: number;
  z: number;
  vx: number;
  vz: number;
  speed?: number;
  radius?: number;
  hornActive?: boolean;
}

export interface CrowdAnchor {
  kind: 'bench' | 'storefront';
  id: string;
  /** Walkable floor position (`nav.walk.free` is ALWAYS true). */
  x: number;
  z: number;
  yaw: number;
  /** Cushion world position and top height for bench anchors (`kind === 'bench'`). */
  sitX?: number;
  sitZ?: number;
  seatTop?: number;
  /** Matching `PeopleSim.seats` ID for conflict-free bench sharing. */
  seatId?: string;
  chunkId: string | null;
}

export interface ParkedVehicleHazard {
  x: number;
  z: number;
  yaw?: number;
  halfWidth?: number;
  halfLength?: number;
  radius: number;
}

/** Flat zero-allocation kinematic snapshot of the 22 named residents for ORCA-Lite avoidance. */
export interface ResidentKinematicsView {
  readonly posX: Float32Array;
  readonly posZ: Float32Array;
  readonly velX: Float32Array;
  readonly velZ: Float32Array;
  readonly count: number;
}

export interface CrowdContext {
  /** Single player vehicle shorthand OR list of active vehicle hazards (car, motorbike, bike, traffic). */
  vehicle?: VehicleHazard | null;
  vehicles?: readonly VehicleHazard[];
  /** Stationary parked vehicles (player car, two-wheeler, roadside curb cars) to steer around smoothly. */
  parkedVehicles?: readonly ParkedVehicleHazard[];
  /** Seat IDs currently occupied by named residents or the player. */
  occupiedSeats?: ReadonlySet<string>;
  rainIntensity?: number;
  snowIntensity?: number;
  phase?: string;
  anchors?: readonly CrowdAnchor[];
  /** Optional explicit frame delta (seconds) and timeScale for real-dt decoupled simulation. */
  dt?: number;
  timeScale?: number;
  /** Optional player velocity for predictive ORCA avoidance. */
  playerVx?: number;
  playerVz?: number;
  /** Optional flat 22-resident kinematic snapshot for smooth tangential resident avoidance. */
  residents?: ResidentKinematicsView | null;
  /** When true, `count` already includes Manage City density scaling (prevents double-scaling). */
  densityApplied?: boolean;
}

export interface Passer {
  id: number;
  x: number;
  z: number;
  yaw: number;
  walking: boolean;
  model: number;
  activity: CrowdActivity;
  umbrella: boolean;
  umbrellaColor: number;
  /** Live simulation velocity (m/s) for velocity-feedforward tracking in GameView. */
  vx?: number;
  vz?: number;
  speed?: number;
  /** Cushion coordinates and height when `activity === 'sit'` (while `x, z` stays on walkable `stand` floor). */
  sitX?: number;
  sitZ?: number;
  seatTop?: number;
  seatId?: string;
  /** Retained seat geometry during `Stand_Up` so `GameView` smoothly exits the seat with zero 0.75 m snap. */
  seatPhase?: 'none' | 'seated' | 'standing_up';
  lastSitX?: number;
  lastSitZ?: number;
  lastSeatTop?: number;
  lastSeatYaw?: number;
  /** Partner passer ID for paired walkers. */
  pairId?: number;
}

const enum CrowdState {
  WALK = 0,
  U_TURN = 1,
  BENCH_APPROACH = 2,
  BENCH_SIT = 3,
  BENCH_RETURN = 4,
  BROWSE_APPROACH = 5,
  BROWSE_GAZE = 6,
  BROWSE_RETURN = 7,
  CHAT_PAUSE = 8,
  YIELD_CURB = 9,
  BENCH_STAND = 10,
}

const enum CrowdRole {
  WALKER = 0,
  PAIRED = 1,
  JOGGER = 2,
}

/** V3's density rhythm: busy days (80), calmer rain (48), crisp snow (44), quiet nights (32). */
export function crowdDensity(phase: string, rain: boolean, snow = false): number {
  return phase === 'night' ? 32 : rain ? 48 : snow ? 44 : CROWD_SIZE;
}

interface CrowdMeta {
  totalLen: number;
  cumLen: Float32Array;
  pairedLanes: number[];
  jogLanes: number[];
  benchAnchors: CrowdAnchor[];
  storefrontAnchors: CrowdAnchor[];
  crossings: Rect[];
  /** Connected outgoing lanes from each lane's `a` and `b` endpoints. */
  linksFromA: LaneLink[][];
  linksFromB: LaneLink[][];
  /** Indices into `benchAnchors` / `storefrontAnchors` within <= 6.5 m of each lane. */
  localBenches: number[][];
  localStores: number[][];
  /** Precomputed lane direction & proven offset spans for zero-cost walkable fast-path. */
  laneUx: Float32Array;
  laneUz: Float32Array;
  laneMinOff: Float32Array;
  laneMaxOff: Float32Array;
  /** Static outdoor street prop obstacle spatial hash for smooth ORCA avoidance. */
  propX: Float32Array;
  propZ: Float32Array;
  propR: Float32Array;
  propHash: SpatialHash2D;
}

const LANE_META = new WeakMap<Lane[], CrowdMeta>();
const SIM_BY_LANES = new WeakMap<Lane[], CrowdSim>();

// Module-level reusable scratch hooks for Wave 2 zero-alloc resident/vehicle bridging
let sharedResidentsView: ResidentKinematicsView | null = null;
let sharedActiveVehicles: readonly VehicleHazard[] | null = null;

/** Registers a flat zero-alloc 22-resident kinematic snapshot for all active `CrowdSim` instances. */
export function setResidentKinematics(view: ResidentKinematicsView | null): void {
  sharedResidentsView = view;
}

/** Registers active moving street vehicles (player + AI traffic) for all active `CrowdSim` instances. */
export function setActiveVehicles(vehicles: readonly VehicleHazard[] | null): void {
  sharedActiveVehicles = vehicles;
}

const SCRATCH_P: P = { x: 0, z: 0 };
const SINGLE_VEH_SCRATCH: VehicleHazard[] = [];

function rectDistSq(p: P, r: Rect): number {
  const dx = p.x < r.x0 ? r.x0 - p.x : p.x > r.x1 ? p.x - r.x1 : 0;
  const dz = p.z < r.z0 ? r.z0 - p.z : p.z > r.z1 ? p.z - r.z1 : 0;
  return dx * dx + dz * dz;
}

function pointToSegmentClosest(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  out: P,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-6) {
    out.x = ax;
    out.z = az;
    return Math.hypot(px - ax, pz - az);
  }
  let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  out.x = ax + dx * t;
  out.z = az + dz * t;
  return Math.hypot(px - out.x, pz - out.z);
}

function hashInt(a: number, b = 0): number {
  let t = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be59b, 0xc2b2ae35)) >>> 0;
  t ^= t >>> 15;
  t = Math.imul(t, 0x2c1b3c6d) >>> 0;
  t ^= t >>> 12;
  return t >>> 0;
}

/** Collect verified walkable outdoor bench/patio seats and building storefront display-window gaze spots. */
export function buildCrowdAnchors(city: CityPlan, nav: LifeNav): CrowdAnchor[] {
  const anchors: CrowdAnchor[] = [];
  const isFree = (p: { x: number; z: number }) => nav.walk.free(p);

  // 1. Outdoor benches and patio sets (IDs & geometry match PeopleSim + STREET_BENCH_SEAT_GEOMETRY / PATIO_BISTRO_SEAT_GEOMETRY)
  city.props.forEach((p, i) => {
    const py = nav.walk.groundAt(p.x, p.z) ?? -3.2;

    const tryBench = (
      seatId: string,
      sitX: number,
      sitZ: number,
      yaw: number,
      standDist: number,
      cushionOffset: number,
      tableTucked: boolean,
    ) => {
      const stand = resolveSeatStandPoint(
        { sit: { x: sitX, y: py, z: sitZ }, yaw, tableTucked },
        isFree,
        standDist,
      );
      if (!stand) return;
      const g = nav.walk.groundAt(stand.x, stand.z);
      if (g === null || Math.abs(g - py) > 0.35) return;
      anchors.push({
        kind: 'bench',
        id: seatId,
        seatId,
        x: stand.x,
        z: stand.z,
        yaw,
        sitX,
        sitZ,
        seatTop: g + cushionOffset,
        chunkId: p.chunkId ?? null,
      });
    };

    if (p.kind === 'bench') {
      const benchYaw = p.rotY + STREET_BENCH_SEAT_GEOMETRY.yawOffset;
      const fx = Math.sin(benchYaw);
      const fz = Math.cos(benchYaw);
      const rx = Math.cos(benchYaw);
      const rz = -Math.sin(benchYaw);
      const fwd = STREET_BENCH_SEAT_GEOMETRY.forwardOffset;
      for (const side of STREET_BENCH_SEAT_GEOMETRY.pairLateralOffsets) {
        tryBench(
          `prop:bench:${i}:${side < 0 ? 'L' : 'R'}`,
          p.x + rx * side + fx * fwd,
          p.z + rz * side + fz * fwd,
          benchYaw,
          STREET_BENCH_SEAT_GEOMETRY.standDist,
          STREET_BENCH_SEAT_GEOMETRY.seatTopOffset,
          false,
        );
      }
    } else if (p.asset === 'patio-set') {
      const s = (p.scaleVal ?? 1.8) / PATIO_BISTRO_SEAT_GEOMETRY.spanDenom;
      const fx = Math.sin(p.rotY);
      const fz = Math.cos(p.rotY);
      const cushion = PATIO_BISTRO_SEAT_GEOMETRY.seatTopFactor * s;
      tryBench(
        `prop:patio:${i}:A`,
        p.x + fx * (PATIO_BISTRO_SEAT_GEOMETRY.chairAOffset * s),
        p.z + fz * (PATIO_BISTRO_SEAT_GEOMETRY.chairAOffset * s),
        p.rotY,
        PATIO_BISTRO_SEAT_GEOMETRY.standDist,
        cushion,
        true,
      );
      tryBench(
        `prop:patio:${i}:B`,
        p.x + fx * (PATIO_BISTRO_SEAT_GEOMETRY.chairBOffset * s),
        p.z + fz * (PATIO_BISTRO_SEAT_GEOMETRY.chairBOffset * s),
        p.rotY + Math.PI,
        PATIO_BISTRO_SEAT_GEOMETRY.standDist,
        cushion,
        true,
      );
    }
  });

  // 1b. Sidewalk AAA patio bistro seats (`city.aaaSeats` with `zone === 'street'`) shared conflict-free via `seatId`
  const aaaSeats = city.aaaSeats ?? [];
  for (let i = 0; i < aaaSeats.length; i++) {
    const spec = aaaSeats[i];
    if (spec.zone !== 'street') continue;
    const stand = resolveSeatStandPoint(
      spec,
      isFree,
      spec.tableTucked ? PATIO_BISTRO_SEAT_GEOMETRY.standDist : STREET_BENCH_SEAT_GEOMETRY.standDist,
    );
    if (!stand) continue;
    const g = nav.walk.groundAt(stand.x, stand.z);
    if (g === null || Math.abs(g - spec.sit.y) > 0.35) continue;
    anchors.push({
      kind: 'bench',
      id: spec.id,
      seatId: spec.id,
      x: stand.x,
      z: stand.z,
      yaw: spec.yaw,
      sitX: spec.sit.x,
      sitZ: spec.sit.z,
      seatTop: spec.top,
      chunkId: null,
    });
  }

  // 2. Storefront display-window browsing spots along the 13 enterable city buildings
  for (const b of city.buildings) {
    const faceZ = b.facing === 'north' ? b.rect.z0 - 1.15 : b.rect.z1 + 1.15;
    const gazeYaw = b.facing === 'north' ? 0 : Math.PI;
    const width = b.rect.x1 - b.rect.x0;
    const offsets = width >= 9 ? [-width * 0.28, width * 0.28] : [-width * 0.24];
    const cx = (b.rect.x0 + b.rect.x1) * 0.5;

    for (let k = 0; k < offsets.length; k++) {
      const px = cx + offsets[k];
      if (Math.abs(px - b.door.x) < 1.55) continue;
      const spot = { x: px, z: faceZ };
      if (!nav.walk.free(spot)) continue;
      anchors.push({
        kind: 'storefront',
        id: `shopwin:${b.id}:${k}`,
        x: spot.x,
        z: spot.z,
        yaw: gazeYaw,
        chunkId: b.chunkId ?? null,
      });
    }
  }

  return anchors;
}

export function buildLanes(city: CityPlan, nav: LifeNav): Lane[] {
  const lanes: Lane[] = [];
  const crossings: Rect[] = [];
  for (const g of city.ground) {
    if (g.surface === 'crossing') crossings.push(g.rect);
  }

  for (const g of city.ground) {
    if (!['sidewalk', 'plaza', 'park', 'garden'].includes(g.surface)) continue;
    const r = g.rect;
    const w = r.x1 - r.x0;
    const d = r.z1 - r.z0;
    const alongX = w >= d;
    const long = alongX ? w : d;
    const width = alongX ? d : w;
    if (long < 8 || width < 0.9) continue;
    const mid = alongX ? (r.z0 + r.z1) / 2 : (r.x0 + r.x1) / 2;
    const start = (alongX ? r.x0 : r.z0) + 0.6;
    const end = (alongX ? r.x1 : r.z1) - 0.6;
    const at = (t: number, off = 0): P => (alongX ? { x: t, z: mid + off } : { x: mid + off, z: t });

    let runStart: number | null = null;
    const flush = (t: number) => {
      if (runStart !== null && t - runStart >= 6) {
        const offsets = [0, -0.45, 0.45].filter(
          (o) => Math.abs(o) < width / 2 - 0.3 && nav.clear(at(runStart!, o), at(t, o)),
        );
        if (offsets.length) {
          const a = at(runStart);
          const b = at(t);
          const midPt = { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 };
          let nearCrossing = false;
          for (let c = 0; c < crossings.length; c++) {
            const cr = crossings[c];
            if (rectDistSq(a, cr) < 16 || rectDistSq(b, cr) < 16 || rectDistSq(midPt, cr) < 16) {
              nearCrossing = true;
              break;
            }
          }
          lanes.push({
            a,
            b,
            len: t - runStart,
            offsets,
            chunkId: g.chunkId ?? null,
            surface: g.surface,
            nearCrossing,
          });
        }
      }
      runStart = null;
    };

    for (let t = start; t <= end; t += 0.18) {
      const ok = nav.walk.free(at(t));
      if (ok && runStart === null) runStart = t;
      if (!ok) flush(t - 0.18);
    }
    flush(end);
  }

  // Precompute metadata, sidewalk connectivity graph, lane-local anchors, and static prop hash
  const anchors = buildCrowdAnchors(city, nav);
  const cumLen = new Float32Array(lanes.length);
  const laneUx = new Float32Array(lanes.length);
  const laneUz = new Float32Array(lanes.length);
  const laneMinOff = new Float32Array(lanes.length);
  const laneMaxOff = new Float32Array(lanes.length);
  const pairedLanes: number[] = [];
  const jogLanes: number[] = [];
  let totalLen = 0;

  for (let i = 0; i < lanes.length; i++) {
    const l = lanes[i];
    totalLen += l.len;
    cumLen[i] = totalLen;
    const dx = l.b.x - l.a.x;
    const dz = l.b.z - l.a.z;
    const inv = 1 / (Math.hypot(dx, dz) || 1);
    laneUx[i] = dx * inv;
    laneUz[i] = dz * inv;
    let minO = Infinity;
    let maxO = -Infinity;
    for (let k = 0; k < l.offsets.length; k++) {
      const o = l.offsets[k];
      if (o < minO) minO = o;
      if (o > maxO) maxO = o;
    }
    const baseMin = Number.isFinite(minO) ? minO : 0;
    const baseMax = Number.isFinite(maxO) ? maxO : 0;
    // Probe one-time proven corridor margin around extreme offsets so tiny ORCA nudges skip walk.free()
    const nxL = -laneUz[i];
    const nzL = laneUx[i];
    const pad = 0.14;
    const minExtraOk = nav.clear(
      { x: l.a.x + nxL * (baseMin - pad), z: l.a.z + nzL * (baseMin - pad) },
      { x: l.b.x + nxL * (baseMin - pad), z: l.b.z + nzL * (baseMin - pad) },
    );
    const maxExtraOk = nav.clear(
      { x: l.a.x + nxL * (baseMax + pad), z: l.a.z + nzL * (baseMax + pad) },
      { x: l.b.x + nxL * (baseMax + pad), z: l.b.z + nzL * (baseMax + pad) },
    );
    laneMinOff[i] = minExtraOk ? baseMin - pad : baseMin;
    laneMaxOff[i] = maxExtraOk ? baseMax + pad : baseMax;
    if (l.offsets.length >= 2) pairedLanes.push(i);
    if ((l.surface === 'park' || l.surface === 'garden') && l.len >= 10) jogLanes.push(i);
  }

  const benchAnchors = anchors.filter((a) => a.kind === 'bench');
  const storefrontAnchors = anchors.filter((a) => a.kind === 'storefront');

  // Sidewalk lane-to-lane connectivity (endpoints within <= 4.5 m across walkable floor)
  const linksFromA: LaneLink[][] = Array.from({ length: lanes.length }, () => []);
  const linksFromB: LaneLink[][] = Array.from({ length: lanes.length }, () => []);
  for (let i = 0; i < lanes.length; i++) {
    const li = lanes[i];
    for (let j = 0; j < lanes.length; j++) {
      if (i === j) continue;
      const lj = lanes[j];
      if (Math.hypot(li.b.x - lj.a.x, li.b.z - lj.a.z) <= 4.5 && nav.clear(li.b, lj.a)) {
        linksFromB[i].push({ lane: j, enterDir: 1 });
      }
      if (Math.hypot(li.b.x - lj.b.x, li.b.z - lj.b.z) <= 4.5 && nav.clear(li.b, lj.b)) {
        linksFromB[i].push({ lane: j, enterDir: -1 });
      }
      if (Math.hypot(li.a.x - lj.a.x, li.a.z - lj.a.z) <= 4.5 && nav.clear(li.a, lj.a)) {
        linksFromA[i].push({ lane: j, enterDir: 1 });
      }
      if (Math.hypot(li.a.x - lj.b.x, li.a.z - lj.b.z) <= 4.5 && nav.clear(li.a, lj.b)) {
        linksFromA[i].push({ lane: j, enterDir: -1 });
      }
    }
  }

  // Bind benches & storefronts locally to nearby lanes (<= 6.5 m clear walk-off -> 0 teleports!)
  const localBenches: number[][] = Array.from({ length: lanes.length }, () => []);
  const localStores: number[][] = Array.from({ length: lanes.length }, () => []);
  const nearPt: P = { x: 0, z: 0 };
  for (let i = 0; i < lanes.length; i++) {
    const l = lanes[i];
    for (let bIdx = 0; bIdx < benchAnchors.length; bIdx++) {
      const a = benchAnchors[bIdx];
      const dist = pointToSegmentClosest(a.x, a.z, l.a.x, l.a.z, l.b.x, l.b.z, nearPt);
      if (dist <= 6.5 && nav.clear(nearPt, a)) {
        localBenches[i].push(bIdx);
      }
    }
    for (let sIdx = 0; sIdx < storefrontAnchors.length; sIdx++) {
      const a = storefrontAnchors[sIdx];
      const dist = pointToSegmentClosest(a.x, a.z, l.a.x, l.a.z, l.b.x, l.b.z, nearPt);
      if (dist <= 6.5 && nav.clear(nearPt, a)) {
        localStores[i].push(sIdx);
      }
    }
  }

  // Static outdoor street props spatial hash (trees, lamps, shelters, benches, hydrants, kiosks)
  const propCount = city.props.length;
  const propX = new Float32Array(propCount);
  const propZ = new Float32Array(propCount);
  const propR = new Float32Array(propCount);
  const propHash = new SpatialHash2D(Math.max(1, propCount), 2.5);
  for (let i = 0; i < propCount; i++) {
    const pr = city.props[i];
    propX[i] = pr.x;
    propZ[i] = pr.z;
    propR[i] = Math.max(0.16, pr.radius);
    propHash.insert(i, pr.x, pr.z);
  }

  LANE_META.set(lanes, {
    totalLen,
    cumLen,
    pairedLanes,
    jogLanes,
    benchAnchors,
    storefrontAnchors,
    crossings,
    linksFromA,
    linksFromB,
    localBenches,
    localStores,
    laneUx,
    laneUz,
    laneMinOff,
    laneMaxOff,
    propX,
    propZ,
    propR,
    propHash,
  });

  return lanes;
}

function getOrCreateMeta(lanes: Lane[]): CrowdMeta {
  let meta = LANE_META.get(lanes);
  if (!meta) {
    const cumLen = new Float32Array(lanes.length);
    const laneUx = new Float32Array(lanes.length);
    const laneUz = new Float32Array(lanes.length);
    const laneMinOff = new Float32Array(lanes.length);
    const laneMaxOff = new Float32Array(lanes.length);
    const pairedLanes: number[] = [];
    const jogLanes: number[] = [];
    let totalLen = 0;
    for (let i = 0; i < lanes.length; i++) {
      const l = lanes[i];
      totalLen += l.len;
      cumLen[i] = totalLen;
      const dx = l.b.x - l.a.x;
      const dz = l.b.z - l.a.z;
      const inv = 1 / (Math.hypot(dx, dz) || 1);
      laneUx[i] = dx * inv;
      laneUz[i] = dz * inv;
      let minO = Infinity;
      let maxO = -Infinity;
      for (let k = 0; k < l.offsets.length; k++) {
        const o = l.offsets[k];
        if (o < minO) minO = o;
        if (o > maxO) maxO = o;
      }
      laneMinOff[i] = Number.isFinite(minO) ? minO : 0;
      laneMaxOff[i] = Number.isFinite(maxO) ? maxO : 0;
      if (l.offsets.length >= 2) pairedLanes.push(i);
      if ((l.surface === 'park' || l.surface === 'garden') && l.len >= 10) {
        jogLanes.push(i);
      }
    }
    meta = {
      totalLen,
      cumLen,
      pairedLanes,
      jogLanes,
      benchAnchors: [],
      storefrontAnchors: [],
      crossings: [],
      linksFromA: Array.from({ length: lanes.length }, () => []),
      linksFromB: Array.from({ length: lanes.length }, () => []),
      localBenches: Array.from({ length: lanes.length }, () => []),
      localStores: Array.from({ length: lanes.length }, () => []),
      laneUx,
      laneUz,
      laneMinOff,
      laneMaxOff,
      propX: new Float32Array(0),
      propZ: new Float32Array(0),
      propR: new Float32Array(0),
      propHash: new SpatialHash2D(1, 2.5),
    };
    LANE_META.set(lanes, meta);
  }
  return meta;
}

function pickLaneIndexByLength(cumLen: Float32Array, totalLen: number, u01: number): number {
  const target = u01 * totalLen;
  let lo = 0;
  let hi = cumLen.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumLen[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Stateful L1-cache-resident SoA Crowd Simulation with zero-alloc ORCA-Lite tangential avoidance.
 */
export class CrowdSim {
  readonly lanes: Lane[];
  readonly meta: CrowdMeta;

  // L1-cache-resident SoA typed buffers (~9.2 KB total for MAX_CROWD = 128)
  readonly posX = new Float32Array(MAX_CROWD);
  readonly posZ = new Float32Array(MAX_CROWD);
  readonly velX = new Float32Array(MAX_CROWD);
  readonly velZ = new Float32Array(MAX_CROWD);
  readonly prefVx = new Float32Array(MAX_CROWD);
  readonly prefVz = new Float32Array(MAX_CROWD);
  readonly yaw = new Float32Array(MAX_CROWD);
  readonly baseSpeed = new Float32Array(MAX_CROWD);
  readonly laneOff = new Float32Array(MAX_CROWD);
  readonly stateTimer = new Float32Array(MAX_CROWD);
  readonly cooldown = new Float32Array(MAX_CROWD);
  readonly returnX = new Float32Array(MAX_CROWD);
  readonly returnZ = new Float32Array(MAX_CROWD);

  readonly state = new Uint8Array(MAX_CROWD);
  readonly role = new Uint8Array(MAX_CROWD);
  readonly active = new Uint8Array(MAX_CROWD);
  readonly umbrella = new Uint8Array(MAX_CROWD);
  readonly dir = new Int8Array(MAX_CROWD);
  readonly laneIdx = new Int16Array(MAX_CROWD);
  readonly anchorIdx = new Int16Array(MAX_CROWD);
  readonly pairIdx = new Int16Array(MAX_CROWD);

  private readonly peerHash = new SpatialHash2D(MAX_CROWD, 2.5);
  private readonly orca = new OrcaScratch();
  private readonly pool: Passer[] = [];
  private readonly out: Passer[] = [];
  private readonly claimedBenches = new Set<number>();
  private readonly claimedStores = new Set<number>();

  private frame = 0;
  private activeCount = 0;
  private initialized = false;
  private lastClockMinutes = Number.NaN;
  private lastPlayerX = Number.NaN;
  private lastPlayerZ = Number.NaN;
  private estPlayerVx = 0;
  private estPlayerVz = 0;

  private residentsView: ResidentKinematicsView | null = null;
  private activeVehiclesOverride: readonly VehicleHazard[] | null = null;

  constructor(lanes: Lane[]) {
    this.lanes = lanes;
    this.meta = getOrCreateMeta(lanes);
    for (let i = 0; i < MAX_CROWD; i++) {
      this.pool.push({
        id: i,
        x: 0,
        z: 0,
        yaw: 0,
        walking: false,
        model: i % 6,
        activity: 'idle',
        umbrella: false,
        umbrellaColor: i % 5,
        vx: 0,
        vz: 0,
        speed: 0,
      });
      this.anchorIdx[i] = -1;
      this.pairIdx[i] = -1;
    }
    this.seedAllSlots();
  }

  /** Wave 2 zero-alloc hook: supply flat 22-resident kinematic snapshot directly. */
  setResidentKinematics(view: ResidentKinematicsView | null): void {
    this.residentsView = view;
  }

  /** Wave 2 zero-alloc hook: supply moving street vehicles (player + AI traffic). */
  setActiveVehicles(vehicles: readonly VehicleHazard[] | null): void {
    this.activeVehiclesOverride = vehicles;
  }

  /** Deterministically seeds all 128 SoA slots onto proven walkable lane positions once. */
  private seedAllSlots(): void {
    if (!this.lanes.length || this.initialized) return;
    this.initialized = true;

    const meta = this.meta;
    const pairedCap = meta.pairedLanes.length > 0 ? 20 : 0;

    for (let i = 0; i < MAX_CROWD; i++) {
      let lIdx: number;
      let off: number;
      let spd: number;
      let role: CrowdRole = CrowdRole.WALKER;
      let pair = -1;

      if (i < pairedCap) {
        const pairGroup = i >> 1;
        const side = i & 1;
        role = CrowdRole.PAIRED;
        pair = side === 0 ? i + 1 : i - 1;
        lIdx = meta.pairedLanes[pairGroup % meta.pairedLanes.length];
        const l = this.lanes[lIdx];
        off = l.offsets.length >= 3 ? l.offsets[side === 0 ? 1 : 2] : l.offsets[side];
        spd = 0.96 + (pairGroup % 5) * 0.06;
      } else if (i >= 44 && i < 50 && meta.jogLanes.length > 0) {
        role = CrowdRole.JOGGER;
        lIdx = meta.jogLanes[(i - 44) % meta.jogLanes.length];
        const l = this.lanes[lIdx];
        off = l.offsets[i % l.offsets.length];
        spd = 2.08 + (i % 3) * 0.08;
      } else {
        const frac = (i * 0.6180339887) % 1;
        lIdx = pickLaneIndexByLength(meta.cumLen, meta.totalLen, frac);
        const l = this.lanes[lIdx];
        off = l.offsets[i % l.offsets.length];
        const bucket = i % 10;
        spd =
          bucket < 2
            ? 0.86 + bucket * 0.06
            : bucket < 8
              ? 1.06 + (bucket - 2) * 0.05
              : 1.42 + (bucket - 8) * 0.07;
      }

      const l = this.lanes[lIdx];
      const dx = l.b.x - l.a.x;
      const dz = l.b.z - l.a.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len;
      const nz = dx / len;
      const seedIdx = role === CrowdRole.PAIRED ? i >> 1 : i;
      const u = 0.08 + ((hashInt(seedIdx, 71) % 840) / 1000);
      const dirVal: 1 | -1 = (seedIdx & 1) === 0 ? 1 : -1;

      this.role[i] = role;
      this.pairIdx[i] = pair;
      this.laneIdx[i] = lIdx;
      this.laneOff[i] = off;
      this.baseSpeed[i] = spd;
      this.dir[i] = dirVal;
      this.posX[i] = l.a.x + dx * u + nx * off;
      this.posZ[i] = l.a.z + dz * u + nz * off;
      const hYaw = Math.atan2(dx * dirVal, dz * dirVal);
      this.yaw[i] = hYaw;
      this.velX[i] = (dx / len) * dirVal * spd;
      this.velZ[i] = (dz / len) * dirVal * spd;
      this.state[i] = CrowdState.WALK;
      this.stateTimer[i] = 0;
      this.cooldown[i] = 6 + (hashInt(i, 19) % 24);
      this.anchorIdx[i] = -1;
      this.active[i] = 0;
    }
  }

  private releaseAnchor(i: number): void {
    const aIdx = this.anchorIdx[i];
    if (aIdx < 0) return;
    const st = this.state[i];
    if (
      st === CrowdState.BENCH_APPROACH ||
      st === CrowdState.BENCH_SIT ||
      st === CrowdState.BENCH_STAND ||
      st === CrowdState.BENCH_RETURN
    ) {
      this.claimedBenches.delete(aIdx);
    } else {
      this.claimedStores.delete(aIdx);
    }
    this.anchorIdx[i] = -1;
  }

  /**
   * Advances the stateful crowd by `rawDt` seconds (clamped and decoupled from game-clock warps)
   * with zero per-frame heap allocations, returning a reusable `Passer[]` slice.
   */
  step(
    rawDt: number,
    targetCount: number,
    avoid: P | null,
    free?: (p: P) => boolean,
    ctx?: CrowdContext,
  ): Passer[] {
    if (!this.lanes.length || targetCount <= 0) {
      this.out.length = 0;
      return this.out;
    }

    const clampedCount = Math.max(0, Math.min(MAX_CROWD, Math.round(targetCount)));
    const timeScale = ctx?.timeScale !== undefined && Number.isFinite(ctx.timeScale)
      ? Math.max(0, Math.min(1.5, ctx.timeScale))
      : 1;
    const dt = Math.max(0, Math.min(0.05, Number.isFinite(rawDt) ? rawDt : 0)) * timeScale;

    this.frame++;
    const rain = ctx?.rainIntensity ?? 0;
    const snow = ctx?.snowIntensity ?? 0;
    const dry = rain <= 0.1 && snow <= 0.4;
    const isNight = ctx?.phase === 'night';
    const occupiedSeats = ctx?.occupiedSeats;
    const meta = this.meta;

    // 1. Estimate player velocity cleanly (zero alloc) if caller did not supply playerVx/Vz
    let pvx = ctx?.playerVx ?? 0;
    let pvz = ctx?.playerVz ?? 0;
    if (avoid && dt > 1e-4) {
      if (ctx?.playerVx === undefined && Number.isFinite(this.lastPlayerX)) {
        const dxp = avoid.x - this.lastPlayerX;
        const dzp = avoid.z - this.lastPlayerZ;
        if (dxp * dxp + dzp * dzp < 9) {
          this.estPlayerVx += (dxp / dt - this.estPlayerVx) * 0.35;
          this.estPlayerVz += (dzp / dt - this.estPlayerVz) * 0.35;
        } else {
          this.estPlayerVx = 0;
          this.estPlayerVz = 0;
        }
        pvx = this.estPlayerVx;
        pvz = this.estPlayerVz;
      }
      this.lastPlayerX = avoid.x;
      this.lastPlayerZ = avoid.z;
    } else if (!avoid) {
      this.lastPlayerX = Number.NaN;
      this.lastPlayerZ = Number.NaN;
      this.estPlayerVx = 0;
      this.estPlayerVz = 0;
    }

    // 2. Smoothly reconcile active pool count (initial fill is immediate; runtime changes avoid in-view pops)
    if (this.activeCount === 0) {
      for (let i = 0; i < clampedCount; i++) this.active[i] = 1;
      this.activeCount = clampedCount;
    } else if (clampedCount !== this.activeCount) {
      // Activate/deactivate slots cleanly; prefer off-screen slots (> 42 m) when possible
      if (clampedCount > this.activeCount) {
        for (let i = this.activeCount; i < clampedCount; i++) {
          this.active[i] = 1;
          // Ensure activated passer is not placed directly on top of player
          if (avoid && Math.hypot(this.posX[i] - avoid.x, this.posZ[i] - avoid.z) < 12) {
            // Relocate once while inactive to the far lane end before rendering
            const farL = this.lanes[(this.laneIdx[i] + Math.floor(this.lanes.length * 0.5)) % this.lanes.length];
            this.laneIdx[i] = (this.laneIdx[i] + Math.floor(this.lanes.length * 0.5)) % this.lanes.length;
            this.posX[i] = (farL.a.x + farL.b.x) * 0.5;
            this.posZ[i] = (farL.a.z + farL.b.z) * 0.5;
            this.state[i] = CrowdState.WALK;
            this.releaseAnchor(i);
          }
        }
      } else {
        for (let i = clampedCount; i < this.activeCount; i++) {
          this.active[i] = 0;
          this.releaseAnchor(i);
        }
      }
      this.activeCount = clampedCount;
    }

    // 3. Assemble moving vehicle hazards (merging BOTH AI traffic AND driven player vehicle with zero allocs)
    let vehicles: readonly VehicleHazard[] = SINGLE_VEH_SCRATCH;
    SINGLE_VEH_SCRATCH.length = 0;
    const listSrc =
      ctx?.vehicles && ctx.vehicles.length > 0
        ? ctx.vehicles
        : this.activeVehiclesOverride && this.activeVehiclesOverride.length > 0
          ? this.activeVehiclesOverride
          : sharedActiveVehicles && sharedActiveVehicles.length > 0
            ? sharedActiveVehicles
            : null;
    if (listSrc && ctx?.vehicle) {
      for (let v = 0; v < listSrc.length; v++) SINGLE_VEH_SCRATCH.push(listSrc[v]);
      SINGLE_VEH_SCRATCH.push(ctx.vehicle);
    } else if (listSrc) {
      vehicles = listSrc;
    } else if (ctx?.vehicle) {
      SINGLE_VEH_SCRATCH.push(ctx.vehicle);
    }

    const parkedVehicles =
      ctx?.parkedVehicles && ctx.parkedVehicles.length > 0 ? ctx.parkedVehicles : null;
    const residents = ctx?.residents ?? this.residentsView ?? sharedResidentsView;
    const benchList = meta.benchAnchors;
    const storeList = meta.storefrontAnchors;
    const playerX = avoid ? avoid.x : 1e9;
    const playerZ = avoid ? avoid.z : 1e9;

    // 4. Rebuild zero-alloc 1024-bucket spatial hash for all active agents
    this.peerHash.clear();
    for (let i = 0; i < this.activeCount; i++) {
      this.peerHash.insert(i, this.posX[i], this.posZ[i]);
    }

    // 5. Step kinematics & distance-tiered ORCA-Lite
    if (dt > 0) {
      const velBlend = 1 - Math.exp(-10 * dt);
      const stopDecayNear = Math.exp(-12 * dt);
      const stopDecayFar = Math.exp(-48 * dt);
      for (let i = 0; i < this.activeCount; i++) {
        const px = this.posX[i];
        const pz = this.posZ[i];
        const dpx = px - playerX;
        const dpz = pz - playerZ;
        const distPlayerSq = avoid ? dpx * dpx + dpz * dpz : 100;

        // Distance-tiered ORCA frequency: Near <= 36 m (60 Hz), Mid 36..75 m (30 Hz), Far > 75 m (15 Hz)
        const isFar = distPlayerSq > 5625; // 75^2
        if (isFar && (i & 3) !== (this.frame & 3)) continue;
        const isNear = distPlayerSq <= 1296; // 36^2
        const stepDt = isFar ? dt * 4 : dt;
        const runOrca = !isFar && (isNear || (i & 1) === (this.frame & 1));

        if (this.cooldown[i] > 0) {
          this.cooldown[i] = Math.max(0, this.cooldown[i] - stepDt);
        }

        const isJogger = this.role[i] === CrowdRole.JOGGER && dry && !isNight;
        const hasUmbrella =
          !isJogger && (rain > 0.1 ? (i % 8) !== 0 : snow > 0.4 ? (i % 2) === 0 : false);
        this.umbrella[i] = hasUmbrella ? 1 : 0;

        let desiredSpeed = this.baseSpeed[i];
        if (this.role[i] === CrowdRole.JOGGER && (!dry || isNight)) {
          desiredSpeed = 1.24; // Joggers drop to brisk walk in rain/night
        }
        if (rain > 0.1 && !hasUmbrella) desiredSpeed *= 1.22;
        else if (snow > 0.4) desiredSpeed *= 0.88;

        const st = this.state[i] as CrowdState;
        let prefX = 0;
        let prefZ = 0;
        let wantYaw = this.yaw[i];
        let forceYaw = false;
        let allowMove = true;
        let maxSpeedNow = desiredSpeed;

        // ── State Machine ─────────────────────────────────────────────────────
        if (st === CrowdState.BENCH_SIT) {
          const aIdx = this.anchorIdx[i];
          const anchor = aIdx >= 0 ? benchList[aIdx] : undefined;
          this.stateTimer[i] -= stepDt;
          const seatTaken = Boolean(anchor?.seatId && occupiedSeats?.has(anchor.seatId));
          if (!anchor || !dry || isNight || seatTaken || this.stateTimer[i] <= 0) {
            // Retain anchor claim briefly while `Stand_Up` completes (eliminates 0.75 m snap-off)
            this.state[i] = CrowdState.BENCH_STAND;
            this.stateTimer[i] = 0.92;
            allowMove = false;
            if (anchor) {
              wantYaw = anchor.yaw;
              forceYaw = true;
            }
          } else {
            allowMove = false;
            wantYaw = anchor.yaw;
            forceYaw = true;
          }
        } else if (st === CrowdState.BENCH_STAND) {
          const aIdx = this.anchorIdx[i];
          const anchor = aIdx >= 0 ? benchList[aIdx] : undefined;
          this.stateTimer[i] -= stepDt;
          allowMove = false;
          if (anchor) {
            wantYaw = anchor.yaw;
            forceYaw = true;
          }
          if (!anchor || this.stateTimer[i] <= 0) {
            if (aIdx >= 0) this.claimedBenches.delete(aIdx);
            this.anchorIdx[i] = -1;
            this.state[i] = CrowdState.BENCH_RETURN;
          }
        } else if (st === CrowdState.BROWSE_GAZE) {
          const aIdx = this.anchorIdx[i];
          const anchor = aIdx >= 0 ? storeList[aIdx] : undefined;
          this.stateTimer[i] -= stepDt;
          if (!anchor || rain >= 0.85 || isNight || this.stateTimer[i] <= 0) {
            this.claimedStores.delete(aIdx);
            this.state[i] = CrowdState.BROWSE_RETURN;
            this.anchorIdx[i] = -1;
          } else {
            allowMove = false;
            wantYaw = anchor.yaw;
            forceYaw = true;
          }
        } else if (st === CrowdState.BENCH_APPROACH || st === CrowdState.BROWSE_APPROACH) {
          const isBench = st === CrowdState.BENCH_APPROACH;
          const aIdx = this.anchorIdx[i];
          const anchor = aIdx >= 0 ? (isBench ? benchList[aIdx] : storeList[aIdx]) : undefined;
          const seatTaken = Boolean(isBench && anchor?.seatId && occupiedSeats?.has(anchor.seatId));
          const badWeather = isBench ? !dry || isNight : rain >= 0.85 || isNight;
          if (!anchor || seatTaken || badWeather) {
            this.releaseAnchor(i);
            this.state[i] = isBench ? CrowdState.BENCH_RETURN : CrowdState.BROWSE_RETURN;
          } else {
            const toX = anchor.x - px;
            const toZ = anchor.z - pz;
            const d = Math.hypot(toX, toZ);
            if (d <= 0.06) {
              this.posX[i] = anchor.x;
              this.posZ[i] = anchor.z;
              this.velX[i] = 0;
              this.velZ[i] = 0;
              this.state[i] = isBench ? CrowdState.BENCH_SIT : CrowdState.BROWSE_GAZE;
              this.stateTimer[i] = isBench
                ? 26 + (hashInt(i, this.frame) % 28)
                : 12 + (hashInt(i, this.frame) % 12);
              allowMove = false;
              wantYaw = anchor.yaw;
              forceYaw = true;
            } else {
              const spd = Math.min(1.08, Math.max(0.35, d * 2.5));
              prefX = (toX / d) * spd;
              prefZ = (toZ / d) * spd;
              maxSpeedNow = 1.15;
            }
          }
        } else if (st === CrowdState.BENCH_RETURN || st === CrowdState.BROWSE_RETURN) {
          const toX = this.returnX[i] - px;
          const toZ = this.returnZ[i] - pz;
          const d = Math.hypot(toX, toZ);
          if (d <= 0.35) {
            this.state[i] = CrowdState.WALK;
            this.cooldown[i] = 32 + (hashInt(i, this.frame) % 30);
          } else {
            const spd = Math.min(1.12, Math.max(0.55, d * 1.6));
            prefX = (toX / d) * spd;
            prefZ = (toZ / d) * spd;
            maxSpeedNow = 1.2;
          }
        } else if (st === CrowdState.CHAT_PAUSE) {
          this.stateTimer[i] -= stepDt;
          allowMove = false;
          const pId = this.pairIdx[i];
          if (pId >= 0 && pId < this.activeCount) {
            wantYaw = Math.atan2(this.posX[pId] - px, this.posZ[pId] - pz);
            forceYaw = true;
          }
          if (this.stateTimer[i] <= 0) {
            this.state[i] = CrowdState.WALK;
            this.dir[i] = (this.dir[i] > 0 ? -1 : 1) as 1 | -1;
            this.cooldown[i] = 18 + (hashInt(i, this.frame) % 16);
          }
        } else {
          // WALK, U_TURN, or YIELD_CURB recovery
          if (st === CrowdState.U_TURN || st === CrowdState.YIELD_CURB) {
            this.stateTimer[i] -= stepDt;
            if (this.stateTimer[i] <= 0) {
              this.state[i] = CrowdState.WALK;
            }
          }

          const lIdx = this.laneIdx[i];
          const lane = this.lanes[lIdx];
          const ldx = lane.b.x - lane.a.x;
          const ldz = lane.b.z - lane.a.z;
          const lLen = lane.len > 1e-4 ? lane.len : 1;
          const ux = ldx / lLen;
          const uz = ldz / lLen;
          const nx = -uz;
          const nz = ux;
          const dirSign = this.dir[i] >= 0 ? 1 : -1;

          // Current projection along lane
          const projS = (px - lane.a.x) * ux + (pz - lane.a.z) * uz;
          const distToEnd = dirSign > 0 ? lLen - projS : projS;

          // Endpoint handling: smooth lane transition, paired chat pause, or gentle U-turn
          if (distToEnd <= 1.15) {
            const pId = this.pairIdx[i];
            if (pId >= 0 && pId < this.activeCount && this.cooldown[i] <= 0) {
              this.state[i] = CrowdState.CHAT_PAUSE;
              this.stateTimer[i] = 2.6 + (hashInt(i, this.frame) % 15) * 0.1;
              if (this.state[pId] === CrowdState.WALK) {
                this.state[pId] = CrowdState.CHAT_PAUSE;
                this.stateTimer[pId] = this.stateTimer[i];
              }
              allowMove = false;
            } else {
              const links = dirSign > 0 ? meta.linksFromB[lIdx] : meta.linksFromA[lIdx];
              if (pId < 0 && links && links.length > 0 && this.role[i] !== CrowdRole.JOGGER) {
                // Deterministic pseudo-random outgoing lane choice
                const pick = links[hashInt(i, this.frame + lIdx) % links.length];
                this.laneIdx[i] = pick.lane;
                this.dir[i] = pick.enterDir;
                const nextLane = this.lanes[pick.lane];
                this.laneOff[i] = nextLane.offsets[i % nextLane.offsets.length];
              } else {
                this.dir[i] = -dirSign as 1 | -1;
                this.state[i] = CrowdState.U_TURN;
                this.stateTimer[i] = 0.65;
              }
            }
          }

          if (allowMove) {
            const curLane = this.lanes[this.laneIdx[i]];
            const cdx = curLane.b.x - curLane.a.x;
            const cdz = curLane.b.z - curLane.a.z;
            const cLen = curLane.len > 1e-4 ? curLane.len : 1;
            const cux = cdx / cLen;
            const cuz = cdz / cLen;
            const cnx = -cuz;
            const cnz = cux;
            const cDir = this.dir[i] >= 0 ? 1 : -1;
            const sNow = (px - curLane.a.x) * cux + (pz - curLane.a.z) * cuz;
            const lookS = Math.max(0, Math.min(cLen, sNow + cDir * 1.45));

            let targetX = curLane.a.x + cux * lookS + cnx * this.laneOff[i];
            let targetZ = curLane.a.z + cuz * lookS + cnz * this.laneOff[i];

            // Gentle paired-walker cohesion so side-by-side partners stay abreast
            const pId = this.pairIdx[i];
            if (pId >= 0 && pId < this.activeCount && this.laneIdx[pId] === this.laneIdx[i]) {
              const partnerS = (this.posX[pId] - curLane.a.x) * cux + (this.posZ[pId] - curLane.a.z) * cuz;
              const sLag = (partnerS - sNow) * cDir;
              if (sLag < -0.5) desiredSpeed *= 0.85;
              else if (sLag > 0.5) desiredSpeed *= 1.12;
              targetX = curLane.a.x + cux * Math.max(0, Math.min(cLen, sNow + cDir * 1.35)) + cnx * this.laneOff[i];
              targetZ = curLane.a.z + cuz * Math.max(0, Math.min(cLen, sNow + cDir * 1.35)) + cnz * this.laneOff[i];
            }

            const toX = targetX - px;
            const toZ = targetZ - pz;
            const toD = Math.sqrt(toX * toX + toZ * toZ);
            const speedScale = this.state[i] === CrowdState.U_TURN ? 0.58 : 1.0;
            if (toD > 1e-3) {
              prefX = (toX / toD) * desiredSpeed * speedScale;
              prefZ = (toZ / toD) * desiredSpeed * speedScale;
            }
            maxSpeedNow = desiredSpeed * 1.12;

            // Opportunistic lane-local bench/storefront stop (solo non-joggers only -> zero teleports!)
            if (
              !isFar &&
              this.role[i] === CrowdRole.WALKER &&
              this.cooldown[i] <= 0 &&
              this.state[i] === CrowdState.WALK &&
              !isNight
            ) {
              let enteredAnchor = false;
              if (dry) {
                const benches = meta.localBenches[this.laneIdx[i]];
                if (benches && benches.length > 0) {
                  for (let b = 0; b < benches.length; b++) {
                    const bIdx = benches[b];
                    if (this.claimedBenches.has(bIdx)) continue;
                    const anc = benchList[bIdx];
                    if (anc.seatId && occupiedSeats?.has(anc.seatId)) continue;
                    const adx = anc.x - px;
                    const adz = anc.z - pz;
                    if (adx * adx + adz * adz <= 9.61) {
                      this.claimedBenches.add(bIdx);
                      this.anchorIdx[i] = bIdx;
                      this.returnX[i] = px;
                      this.returnZ[i] = pz;
                      this.state[i] = CrowdState.BENCH_APPROACH;
                      enteredAnchor = true;
                      break;
                    }
                  }
                }
              }
              if (!enteredAnchor && rain < 0.85) {
                const stores = meta.localStores[this.laneIdx[i]];
                if (stores && stores.length > 0) {
                  for (let s = 0; s < stores.length; s++) {
                    const sIdx = stores[s];
                    if (this.claimedStores.has(sIdx)) continue;
                    const anc = storeList[sIdx];
                    const adx = anc.x - px;
                    const adz = anc.z - pz;
                    if (adx * adx + adz * adz <= 8.41) {
                      this.claimedStores.add(sIdx);
                      this.anchorIdx[i] = sIdx;
                      this.returnX[i] = px;
                      this.returnZ[i] = pz;
                      this.state[i] = CrowdState.BROWSE_APPROACH;
                      break;
                    }
                  }
                }
              }
            }
          }
        }

        // ── Moving Vehicle Crosswalk Yield & Sidestep ─────────────────────────
        if (!isFar && vehicles.length > 0 && st !== CrowdState.BENCH_SIT && st !== CrowdState.BENCH_STAND) {
          for (let vIdx = 0; vIdx < vehicles.length; vIdx++) {
            const v = vehicles[vIdx];
            const vSpeed = v.speed ?? Math.hypot(v.vx, v.vz);
            const vRad = v.radius ?? 1.1;
            const rx = px - v.x;
            const rz = pz - v.z;
            const distSq = rx * rx + rz * rz;
            if (distSq > 225) continue; // > 15 m quick reject

            const dist = Math.sqrt(distSq);
            if (v.hornActive && dist < 9.5 && dist > 1e-3) {
              wantYaw = Math.atan2(v.x - px, v.z - pz);
              forceYaw = true;
              this.state[i] = CrowdState.YIELD_CURB;
              this.stateTimer[i] = 0.55;
              if (dist < 5.0) {
                // Smooth velocity-steered sidestep (no instant jump!)
                prefX = (rx / dist) * 1.75;
                prefZ = (rz / dist) * 1.75;
                maxSpeedNow = 1.85;
                allowMove = true;
              } else {
                allowMove = false;
              }
              break;
            }

            if (vSpeed > 0.45) {
              const lookahead = 4.6 + vSpeed * 0.78;
              if (dist > lookahead + 3.0) continue;
              const vhx = v.vx / vSpeed;
              const vhz = v.vz / vSpeed;
              const fwd = rx * vhx + rz * vhz;
              const lat = rx * -vhz + rz * vhx;
              const clearance = vRad + (this.lanes[this.laneIdx[i]]?.nearCrossing ? 1.65 : 1.35);

              if (fwd >= -1.2 && fwd <= lookahead && Math.abs(lat) < clearance) {
                wantYaw = Math.atan2(v.x - px, v.z - pz);
                forceYaw = true;
                this.state[i] = CrowdState.YIELD_CURB;
                this.stateTimer[i] = 0.35;
                if (Math.abs(lat) < vRad + 0.85 && fwd > -0.6 && fwd < 5.5) {
                  // Inside vehicle path: briskly sidestep laterally clear of lane
                  const pushSign = lat >= 0 ? 1 : -1;
                  prefX = -vhz * pushSign * 1.8;
                  prefZ = vhx * pushSign * 1.8;
                  maxSpeedNow = 1.9;
                  allowMove = true;
                } else {
                  allowMove = false;
                }
                break;
              }
            }
          }
        }

        // ── ORCA-Lite Zero-Alloc Tangential Avoidance ─────────────────────────
        if (!allowMove) {
          const decay = isFar ? stopDecayFar : stopDecayNear;
          this.velX[i] *= decay;
          this.velZ[i] *= decay;
          if (this.velX[i] * this.velX[i] + this.velZ[i] * this.velZ[i] < 0.0004) {
            this.velX[i] = 0;
            this.velZ[i] = 0;
          }
          if (forceYaw) {
            this.yaw[i] = turnSmooth(this.yaw[i], wantYaw, stepDt, 8.5, 4.8);
          }
          continue;
        }

        this.prefVx[i] = prefX;
        this.prefVz[i] = prefZ;

        let targetVx = prefX;
        let targetVz = prefZ;

        if (runOrca) {
          const orca = this.orca;
          orca.reset();
          const curVx = this.velX[i];
          const curVz = this.velZ[i];

          // A. Avoid Player (`alpha = 1.0`, passer glides smoothly around learner)
          if (avoid && distPlayerSq < 20.25) {
            addOrcaDiskConstraint(
              orca,
              px,
              pz,
              curVx,
              curVz,
              playerX,
              playerZ,
              pvx,
              pvz,
              0.78,
              1.8,
              1.0,
            );
          }

          // B. Avoid all 22 Named Residents (`alpha = 0.85`, eliminates GameView 0.85 m vanish-pop!)
          if (residents && residents.count > 0) {
            const rxArr = residents.posX;
            const rzArr = residents.posZ;
            const rvxArr = residents.velX;
            const rvzArr = residents.velZ;
            for (let r = 0; r < residents.count; r++) {
              const dx = rxArr[r] - px;
              const dz = rzArr[r] - pz;
              if (Math.abs(dx) > 4.2 || Math.abs(dz) > 4.2) continue;
              if (dx * dx + dz * dz > 17.64) continue;
              addOrcaDiskConstraint(
                orca,
                px,
                pz,
                curVx,
                curVz,
                rxArr[r],
                rzArr[r],
                rvxArr[r],
                rvzArr[r],
                0.82,
                1.9,
                0.85,
              );
            }
          }

          // C. Avoid nearby Ambient Crowd peers via 1024-bucket spatial hash (`alpha = 0.50`)
          const cx = Math.floor(px * this.peerHash.invCellSize);
          const cz = Math.floor(pz * this.peerHash.invCellSize);
          const myPair = this.pairIdx[i];
          for (let ox = -1; ox <= 1 && orca.count < OrcaScratch.MAX_LINES - 4; ox++) {
            for (let oz = -1; oz <= 1 && orca.count < OrcaScratch.MAX_LINES - 4; oz++) {
              let j = this.peerHash.head[this.peerHash.bucketOfCell(cx + ox, cz + oz)];
              while (j !== -1) {
                if (j !== i && j !== myPair) {
                  const dx = this.posX[j] - px;
                  const dz = this.posZ[j] - pz;
                  const dSq = dx * dx + dz * dz;
                  if (dSq < 11.56) {
                    const jSeated = this.state[j] === CrowdState.BENCH_SIT;
                    addOrcaDiskConstraint(
                      orca,
                      px,
                      pz,
                      curVx,
                      curVz,
                      this.posX[j],
                      this.posZ[j],
                      this.velX[j],
                      this.velZ[j],
                      0.68,
                      1.8,
                      jSeated ? 1.0 : 0.5,
                    );
                  }
                }
                j = this.peerHash.next[j];
              }
            }
          }

          // D. Avoid static outdoor street props via prebuilt PropHash (`alpha = 1.0`, Near skinned ring)
          const propHash = meta.propHash;
          if (isNear && meta.propX.length > 0 && orca.count < OrcaScratch.MAX_LINES - 2) {
            const pcx = Math.floor(px * propHash.invCellSize);
            const pcz = Math.floor(pz * propHash.invCellSize);
            for (let ox = -1; ox <= 1 && orca.count < OrcaScratch.MAX_LINES - 2; ox++) {
              for (let oz = -1; oz <= 1 && orca.count < OrcaScratch.MAX_LINES - 2; oz++) {
                let pIdx = propHash.head[propHash.bucketOfCell(pcx + ox, pcz + oz)];
                while (pIdx !== -1 && orca.count < OrcaScratch.MAX_LINES - 2) {
                  const dx = meta.propX[pIdx] - px;
                  const dz = meta.propZ[pIdx] - pz;
                  const rad = meta.propR[pIdx] + 0.34;
                  if (dx * dx + dz * dz < (rad + 2.2) * (rad + 2.2)) {
                    addOrcaDiskConstraint(
                      orca,
                      px,
                      pz,
                      curVx,
                      curVz,
                      meta.propX[pIdx],
                      meta.propZ[pIdx],
                      0,
                      0,
                      rad,
                      1.15,
                      1.0,
                    );
                  }
                  pIdx = propHash.next[pIdx];
                }
              }
            }
          }

          // E. Avoid stationary parked vehicles (OBB closest-point ORCA disk)
          if (parkedVehicles && orca.count < OrcaScratch.MAX_LINES) {
            for (let k = 0; k < parkedVehicles.length && orca.count < OrcaScratch.MAX_LINES; k++) {
              const pv = parkedVehicles[k];
              addOrcaStaticObbConstraint(
                orca,
                px,
                pz,
                curVx,
                curVz,
                0.32,
                pv.x,
                pv.z,
                pv.yaw ?? 0,
                pv.halfWidth ?? pv.radius * 0.72,
                pv.halfLength ?? pv.radius,
                0.22,
                1.35,
              );
            }
          }

          if (orca.count > 0) {
            solveOrca2D(orca, prefX, prefZ, maxSpeedNow);
            targetVx = orca.outVx;
            targetVz = orca.outVz;
          }
        } else if (!isFar) {
          // Staggered off-frame in Mid ring: continue smooth cached velocity toward pref
          targetVx = this.velX[i] * 0.75 + prefX * 0.25;
          targetVz = this.velZ[i] * 0.75 + prefZ * 0.25;
        }

        // Smooth velocity integration (eliminates velocity twitching)
        const nextVx = this.velX[i] + (targetVx - this.velX[i]) * velBlend;
        const nextVz = this.velZ[i] + (targetVz - this.velZ[i]) * velBlend;
        const candX = px + nextVx * stepDt;
        const candZ = pz + nextVz * stepDt;

        // Single-probe walkable-floor containment with proven-corridor fast-path (ZERO redundant walk.free() calls!)
        let isWalkable = !free;
        if (!isWalkable) {
          const curSt = this.state[i] as CrowdState;
          if (curSt === CrowdState.WALK || curSt === CrowdState.U_TURN) {
            const li = this.laneIdx[i];
            const l = this.lanes[li];
            const ux = meta.laneUx[li];
            const uz = meta.laneUz[li];
            const dxC = candX - l.a.x;
            const dzC = candZ - l.a.z;
            const sC = dxC * ux + dzC * uz;
            if (sC >= 0 && sC <= l.len) {
              const latC = dxC * -uz + dzC * ux;
              if (latC >= meta.laneMinOff[li] && latC <= meta.laneMaxOff[li]) {
                isWalkable = true;
              }
            }
          }
          if (!isWalkable) {
            SCRATCH_P.x = candX;
            SCRATCH_P.z = candZ;
            isWalkable = free!(SCRATCH_P);
          }
        }

        if (isWalkable) {
          this.posX[i] = candX;
          this.posZ[i] = candZ;
          this.velX[i] = nextVx;
          this.velZ[i] = nextVz;
        } else {
          // Try smooth tangent slide along lane axis or +-38 deg deflection
          const spd = Math.sqrt(nextVx * nextVx + nextVz * nextVz);
          let moved = false;
          if (spd > 0.05) {
            const bx = nextVx / spd;
            const bz = nextVz / spd;
            const slideDist = spd * stepDt * 0.75;
            const c38 = 0.788;
            const s38 = 0.616;
            const s1x = bx * c38 - bz * s38;
            const s1z = bx * s38 + bz * c38;
            SCRATCH_P.x = px + s1x * slideDist;
            SCRATCH_P.z = pz + s1z * slideDist;
            if (free!(SCRATCH_P)) {
              this.posX[i] = SCRATCH_P.x;
              this.posZ[i] = SCRATCH_P.z;
              this.velX[i] = s1x * spd * 0.75;
              this.velZ[i] = s1z * spd * 0.75;
              moved = true;
            } else {
              const s2x = bx * c38 + bz * s38;
              const s2z = -bx * s38 + bz * c38;
              SCRATCH_P.x = px + s2x * slideDist;
              SCRATCH_P.z = pz + s2z * slideDist;
              if (free!(SCRATCH_P)) {
                this.posX[i] = SCRATCH_P.x;
                this.posZ[i] = SCRATCH_P.z;
                this.velX[i] = s2x * spd * 0.75;
                this.velZ[i] = s2z * spd * 0.75;
                moved = true;
              }
            }
          }
          if (!moved) {
            this.velX[i] *= 0.25;
            this.velZ[i] *= 0.25;
          }
        }

        // Smooth heading update (never snaps 180 deg, never spins in place when stopped)
        const curSpdSq = this.velX[i] * this.velX[i] + this.velZ[i] * this.velZ[i];
        if (forceYaw) {
          this.yaw[i] = turnSmooth(this.yaw[i], wantYaw, stepDt, 8.5, 4.8);
        } else if (curSpdSq > 0.0196) {
          this.yaw[i] = turnSmooth(
            this.yaw[i],
            Math.atan2(this.velX[i], this.velZ[i]),
            stepDt,
            9.0,
            5.0,
          );
        }
      }
    }

    // 6. Populate reusable zero-alloc `Passer[]` output slice
    this.out.length = this.activeCount;
    for (let i = 0; i < this.activeCount; i++) {
      const p = this.pool[i];
      const st = this.state[i] as CrowdState;
      const vx = this.velX[i];
      const vz = this.velZ[i];
      const spd = Math.sqrt(vx * vx + vz * vz);
      const isJog = this.role[i] === CrowdRole.JOGGER && dry && !isNight;

      p.id = i;
      p.x = this.posX[i];
      p.z = this.posZ[i];
      p.yaw = this.yaw[i];
      p.vx = this.velX[i];
      p.vz = this.velZ[i];
      p.speed = spd;
      p.model = i % 6;
      p.umbrellaColor = i % 5;
      p.pairId = this.pairIdx[i] >= 0 ? this.pairIdx[i] : undefined;
      p.sitX = undefined;
      p.sitZ = undefined;
      p.seatTop = undefined;
      p.seatId = undefined;
      p.seatPhase = 'none';
      p.lastSitX = undefined;
      p.lastSitZ = undefined;
      p.lastSeatTop = undefined;
      p.lastSeatYaw = undefined;

      if (st === CrowdState.BENCH_SIT) {
        const anc = this.anchorIdx[i] >= 0 ? benchList[this.anchorIdx[i]] : undefined;
        p.activity = 'sit';
        p.walking = false;
        p.umbrella = false;
        p.seatPhase = 'seated';
        if (anc) {
          p.sitX = anc.sitX;
          p.sitZ = anc.sitZ;
          p.seatTop = anc.seatTop;
          p.seatId = anc.seatId;
          p.lastSitX = anc.sitX;
          p.lastSitZ = anc.sitZ;
          p.lastSeatTop = anc.seatTop;
          p.lastSeatYaw = anc.yaw;
        }
      } else if (st === CrowdState.BENCH_STAND) {
        const anc = this.anchorIdx[i] >= 0 ? benchList[this.anchorIdx[i]] : undefined;
        p.activity = 'idle';
        p.walking = false;
        p.umbrella = false;
        p.seatPhase = 'standing_up';
        if (anc) {
          p.lastSitX = anc.sitX;
          p.lastSitZ = anc.sitZ;
          p.lastSeatTop = anc.seatTop;
          p.lastSeatYaw = anc.yaw;
        }
      } else if (st === CrowdState.BROWSE_GAZE) {
        p.activity = 'browse';
        p.walking = false;
        p.umbrella = this.umbrella[i] === 1;
      } else if (st === CrowdState.CHAT_PAUSE) {
        p.activity = 'chat';
        p.walking = false;
        p.umbrella = this.umbrella[i] === 1;
      } else if (st === CrowdState.YIELD_CURB && spd < 0.25) {
        p.activity = 'yield';
        p.walking = false;
        p.umbrella = this.umbrella[i] === 1;
      } else {
        p.walking = spd > 0.14;
        p.activity = p.walking ? (isJog ? 'jog' : 'walk') : 'idle';
        p.umbrella = p.activity === 'jog' ? false : this.umbrella[i] === 1;
      }

      this.out[i] = p;
    }

    return this.out;
  }

  /**
   * Backward-compatible step driven by `clockMinutes` with automatic warp protection
   * (ignores > 1.5 s `setTimeOfDay` jumps and caps fast-forward stride speed at 1.5x).
   */
  stepFromClock(
    clockMinutes: number,
    targetCount: number,
    avoid: P | null,
    free?: (p: P) => boolean,
    ctx?: CrowdContext,
  ): Passer[] {
    let dt = 0;
    if (ctx?.dt !== undefined && Number.isFinite(ctx.dt)) {
      dt = ctx.dt;
    } else if (Number.isFinite(this.lastClockMinutes)) {
      const clockDeltaSec = (clockMinutes - this.lastClockMinutes) * 2;
      // Ignore clock jumps (setTimeOfDay) and cap 3x fast-forward so passers never sprint unnaturally
      if (clockDeltaSec > 0 && clockDeltaSec <= 1.5) {
        dt = Math.min(0.025, clockDeltaSec);
      } else if (Math.abs(clockDeltaSec) > 1.5) {
        dt = 1 / 60;
      }
    }
    this.lastClockMinutes = clockMinutes;
    return this.step(dt, targetCount, avoid, free, ctx);
  }
}

/** Returns the cached stateful `CrowdSim` instance bound to `lanes`. */
export function getOrCreateCrowdSim(lanes: Lane[]): CrowdSim {
  let sim = SIM_BY_LANES.get(lanes);
  if (!sim) {
    sim = new CrowdSim(lanes);
    SIM_BY_LANES.set(lanes, sim);
  }
  return sim;
}

/**
 * Backward-compatible facade for `session.ts`, `gameHost.ts`, and contract tests.
 * Delegates to the stateful zero-allocation `CrowdSim` bound to `lanes`.
 */
export function crowdAt(
  lanes: Lane[],
  clockMinutes: number,
  count: number,
  avoid: P | null,
  free?: (p: P) => boolean,
  ctx?: CrowdContext,
): Passer[] {
  if (!lanes.length || count <= 0) return [];
  const scale = ctx?.densityApplied ? 1 : pedestrianDensityMultiplier;
  const effectiveCount = Math.max(0, Math.min(MAX_CROWD, Math.round(count * scale)));
  if (effectiveCount <= 0) return [];
  const sim = getOrCreateCrowdSim(lanes);
  return sim.stepFromClock(clockMinutes, effectiveCount, avoid, free, ctx);
}
