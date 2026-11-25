/**
 * Parametric Right-Hand Traffic (RHT) Road Spline Network for Echo Life.
 *
 * Pure TypeScript, zero DOM/Three/WASM dependencies, zero per-frame heap allocations.
 * Dynamically extracts the real Echo Life street grid from `city.ground` (`surface === 'road'`)
 * across all 4 house sizes (`4, 6, 7.5, 9 m`):
 * - 3 Major East-West Avenues: Riverside Road, Lantern Street / Campus Ave, Market Boulevard
 * - 5 Minor North-South Cross Streets: xW2, xW1, xE1, xE2, xE3 (xE3 terminates at Lantern St)
 * - 14 closed-loop core intersections (every node degree >= 2 -> zero dead-ends for cars/scooters)
 * - 1 scenic Riverside Greenway East bicycle spur with an analytic R = 2.55 m turnaround bulb
 * - 8 mapped zebra crosswalk stop-lines projected directly from `surface === 'crossing'`
 * - Analytic C1 straight + quarter-circle turn connectors with mathematically proven curb clearance
 * - Deadlock-free intersection box priority reservation + curb-parked car bay index (MOBIL-lite)
 *
 * Coordinate convention (right-handed Y-up, Echo Life XZ ground plane):
 * - `+X` = East (dir 0), `+Z` = South (dir 1), `-X` = West (dir 2), `-Z` = North (dir 3).
 * - Heading `yaw = atan2(tx, tz)`, forward = `(sin(yaw), cos(yaw))`.
 * - Right-hand curb unit normal = `(-tz, tx)` (East -> +Z south curb, West -> -Z north curb).
 */

import type { CityPlan } from '../city';
import type { Rect } from '../plan';

export type CardinalDir = 0 | 1 | 2 | 3; // 0:E (+X), 1:S (+Z), 2:W (-X), 3:N (-Z)
export type LaneProfileId = 'car' | 'scooter' | 'bicycle';
export type TurnKind = 'straight' | 'right' | 'left' | 'uturn';

export interface LaneProfileMetrics {
  readonly id: LaneProfileId;
  /** Right-hand lane centerline offset from road median (m). */
  readonly laneOffset: number;
  /** Approximate half-width of vehicle body (m). */
  readonly halfWidth: number;
  /** Quarter-circle right-turn radius (m), proven clear of sidewalk corners. */
  readonly rightTurnRadius: number;
  /** Quarter-circle left-turn radius (m). */
  readonly leftTurnRadius: number;
  /** Lateral acceleration comfort cap for corner speed limiting (m/s^2). */
  readonly maxLatAccel: number;
}

export const LANE_PROFILES: Readonly<Record<LaneProfileId, LaneProfileMetrics>> = {
  car: {
    id: 'car',
    laneOffset: 1.55,
    halfWidth: 0.88,
    rightTurnRadius: 3.8,
    leftTurnRadius: 5.4,
    maxLatAccel: 2.4,
  },
  scooter: {
    id: 'scooter',
    laneOffset: 1.75,
    halfWidth: 0.34,
    rightTurnRadius: 3.2,
    leftTurnRadius: 5.45,
    maxLatAccel: 2.2,
  },
  bicycle: {
    id: 'bicycle',
    laneOffset: 2.55,
    halfWidth: 0.27,
    rightTurnRadius: 2.1,
    leftTurnRadius: 5.6,
    maxLatAccel: 2.2,
  },
};

export const DIR_TX: readonly [number, number, number, number] = [1, 0, -1, 0];
export const DIR_TZ: readonly [number, number, number, number] = [0, 1, 0, -1];
/** Right-hand curb unit vector `(-tz, tx)` for each cardinal direction. */
export const DIR_RX: readonly [number, number, number, number] = [0, -1, 0, 1];
export const DIR_RZ: readonly [number, number, number, number] = [1, 0, -1, 0];
export const DIR_YAW: readonly [number, number, number, number] = [
  Math.PI * 0.5,
  0,
  -Math.PI * 0.5,
  Math.PI,
];

/** Uniform distance trimmed from intersection center along each straight road edge. */
export const INTERSECTION_TRIM = 5.5;
/** Carriageway half-width of all city roads in `city.ts` (7.0 m road). */
export const ROAD_HALF_WIDTH = 3.5;

export interface EdgeCrosswalk {
  readonly sEntry: number;
  readonly sExit: number;
  readonly sStop: number;
  readonly rect: Rect;
}

export interface EdgeCurbBay {
  readonly sStart: number;
  readonly sEnd: number;
  /** Signed lateral coordinate relative to road median along the lane's right-hand axis (positive = right side). */
  readonly innerEdgeLat: number;
  readonly outerEdgeLat: number;
  readonly cx: number;
  readonly cz: number;
  readonly halfWidth: number;
  readonly halfLength: number;
  readonly yaw: number;
}

export interface RoadIntersection {
  readonly id: number;
  readonly name: string;
  readonly x: number;
  readonly z: number;
  readonly isSpurEnd: boolean;
  /** Outgoing directed edge IDs indexed by CardinalDir (`-1` if absent). */
  readonly outEdges: [number, number, number, number];
  /** Incoming directed edge IDs indexed by CardinalDir (`-1` if absent). */
  readonly inEdges: [number, number, number, number];
  /** Deadlock-free runtime box reservation owner (`-1` when free). */
  boxOwnerId: number;
  boxClaimedAt: number;
}

export interface RoadEdge {
  readonly id: number;
  readonly fromNode: number;
  readonly toNode: number;
  readonly dir: CardinalDir;
  readonly isMajor: boolean;
  readonly bikeOnly: boolean;
  readonly oppositeEdgeId: number;
  /** Start and end coordinates along the road median (already trimmed by `INTERSECTION_TRIM`). */
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
  readonly tx: number;
  readonly tz: number;
  readonly rx: number;
  readonly rz: number;
  readonly yaw: number;
  readonly length: number;
  readonly roadRect: Rect;
  readonly crosswalks: EdgeCrosswalk[];
  readonly curbBays: EdgeCurbBay[];
}

export interface TurnConnector {
  readonly intersectionId: number;
  readonly inEdgeId: number;
  readonly outEdgeId: number;
  readonly profile: LaneProfileId;
  readonly kind: TurnKind;
  /** Segment 1: straight lead-in along incoming lane from trim point to arc tangent. */
  readonly leadInLen: number;
  readonly startX: number;
  readonly startZ: number;
  readonly inTx: number;
  readonly inTz: number;
  readonly inRx: number;
  readonly inRz: number;
  /** Segment 2: analytic circular arc (`arcLen === 0` for straight connectors). */
  readonly arcLen: number;
  readonly arcRadius: number;
  readonly arcCenterX: number;
  readonly arcCenterZ: number;
  /** Unit radial vector from arc center to arc start point. */
  readonly arcU0x: number;
  readonly arcU0z: number;
  /** Unit radial vector from arc center to arc end (or 90-deg midpoint for 180-deg U-turn). */
  readonly arcV0x: number;
  readonly arcV0z: number;
  /** Signed sweep angle (positive for arc parameterization `theta = s / R`, curvature sign stored explicitly). */
  readonly arcSweepRad: number;
  /** Signed Ackermann steering curvature `kappa = +1/R` (left turn) or `-1/R` (right turn). */
  readonly curvature: number;
  /** Segment 3: straight lead-out along outgoing lane from arc tangent to trim point. */
  readonly leadOutLen: number;
  readonly arcEndX: number;
  readonly arcEndZ: number;
  readonly outTx: number;
  readonly outTz: number;
  readonly outRx: number;
  readonly outRz: number;
  readonly totalLength: number;
}

export interface SplineSample {
  x: number;
  z: number;
  tx: number;
  tz: number;
  rx: number;
  rz: number;
  yaw: number;
  curvature: number;
}

export interface CurbBoxInput {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
  readonly x?: number;
  readonly z?: number;
  readonly hx?: number;
  readonly hz?: number;
  readonly yaw?: number;
}

export function createSplineSample(): SplineSample {
  return { x: 0, z: 0, tx: 1, tz: 0, rx: 0, rz: 1, yaw: Math.PI * 0.5, curvature: 0 };
}

export function classifyTurn(inDir: CardinalDir, outDir: CardinalDir): TurnKind {
  if (outDir === inDir) return 'straight';
  if (outDir === ((inDir + 1) & 3)) return 'right';
  if (outDir === ((inDir + 3) & 3)) return 'left';
  return 'uturn';
}

/**
 * Evaluates a point `(x, z)`, unit tangent, right-hand normal, heading yaw, and curvature
 * along a straight `RoadEdge` at arc distance `s` with lateral offset `latFromMedian`
 * (positive = right-hand side toward curb). Zero allocations.
 */
export function sampleRoadEdge(
  edge: RoadEdge,
  s: number,
  latFromMedian: number,
  out: SplineSample,
): SplineSample {
  const cs = s < 0 ? 0 : s > edge.length ? edge.length : s;
  out.x = edge.x0 + edge.tx * cs + edge.rx * latFromMedian;
  out.z = edge.z0 + edge.tz * cs + edge.rz * latFromMedian;
  out.tx = edge.tx;
  out.tz = edge.tz;
  out.rx = edge.rx;
  out.rz = edge.rz;
  out.yaw = edge.yaw;
  out.curvature = 0;
  return out;
}

/**
 * Evaluates an analytic `TurnConnector` (`leadInLine -> circularArc -> leadOutLine`)
 * at arc distance `s` with optional extra lateral delta `extraLat` (positive = right).
 * Zero allocations.
 */
export function sampleTurnConnector(
  conn: TurnConnector,
  s: number,
  extraLat: number,
  out: SplineSample,
): SplineSample {
  const cs = s < 0 ? 0 : s > conn.totalLength ? conn.totalLength : s;

  if (cs <= conn.leadInLen || conn.arcLen <= 1e-4) {
    out.x = conn.startX + conn.inTx * cs + conn.inRx * extraLat;
    out.z = conn.startZ + conn.inTz * cs + conn.inRz * extraLat;
    out.tx = conn.inTx;
    out.tz = conn.inTz;
    out.rx = conn.inRx;
    out.rz = conn.inRz;
    out.yaw = Math.atan2(conn.inTx, conn.inTz);
    out.curvature = 0;
    return out;
  }

  const sAfterLead = cs - conn.leadInLen;
  if (sAfterLead <= conn.arcLen) {
    const theta = (sAfterLead / conn.arcLen) * conn.arcSweepRad;
    const c = Math.cos(theta);
    const sn = Math.sin(theta);
    // Position on circle: O + R * (cos(theta)*u0 + sin(theta)*v0)
    const radX = c * conn.arcU0x + sn * conn.arcV0x;
    const radZ = c * conn.arcU0z + sn * conn.arcV0z;
    // Unit tangent: d/dtheta = -sin(theta)*u0 + cos(theta)*v0
    const tx = -sn * conn.arcU0x + c * conn.arcV0x;
    const tz = -sn * conn.arcU0z + c * conn.arcV0z;
    const rx = -tz;
    const rz = tx;
    out.x = conn.arcCenterX + conn.arcRadius * radX + rx * extraLat;
    out.z = conn.arcCenterZ + conn.arcRadius * radZ + rz * extraLat;
    out.tx = tx;
    out.tz = tz;
    out.rx = rx;
    out.rz = rz;
    out.yaw = Math.atan2(tx, tz);
    out.curvature = conn.curvature;
    return out;
  }

  const sOut = sAfterLead - conn.arcLen;
  out.x = conn.arcEndX + conn.outTx * sOut + conn.outRx * extraLat;
  out.z = conn.arcEndZ + conn.outTz * sOut + conn.outRz * extraLat;
  out.tx = conn.outTx;
  out.tz = conn.outTz;
  out.rx = conn.outRx;
  out.rz = conn.outRz;
  out.yaw = Math.atan2(conn.outTx, conn.outTz);
  out.curvature = 0;
  return out;
}

function buildConnector(
  inter: RoadIntersection,
  inEdge: RoadEdge,
  outEdge: RoadEdge,
  profile: LaneProfileId,
): TurnConnector {
  const metrics = LANE_PROFILES[profile];
  const d = metrics.laneOffset;
  const kind = classifyTurn(inEdge.dir, outEdge.dir);
  const inTx = inEdge.tx;
  const inTz = inEdge.tz;
  const inRx = inEdge.rx;
  const inRz = inEdge.rz;
  const outTx = outEdge.tx;
  const outTz = outEdge.tz;
  const outRx = outEdge.rx;
  const outRz = outEdge.rz;

  const startX = inEdge.x1 + inRx * d;
  const startZ = inEdge.z1 + inRz * d;
  const endX = outEdge.x0 + outRx * d;
  const endZ = outEdge.z0 + outRz * d;

  if (kind === 'straight') {
    const totalLength = Math.hypot(endX - startX, endZ - startZ);
    return {
      intersectionId: inter.id,
      inEdgeId: inEdge.id,
      outEdgeId: outEdge.id,
      profile,
      kind,
      leadInLen: totalLength,
      startX,
      startZ,
      inTx,
      inTz,
      inRx,
      inRz,
      arcLen: 0,
      arcRadius: Infinity,
      arcCenterX: inter.x,
      arcCenterZ: inter.z,
      arcU0x: 0,
      arcU0z: 0,
      arcV0x: inTx,
      arcV0z: inTz,
      arcSweepRad: 0,
      curvature: 0,
      leadOutLen: 0,
      arcEndX: endX,
      arcEndZ: endZ,
      outTx,
      outTz,
      outRx,
      outRz,
      totalLength,
    };
  }

  if (kind === 'uturn') {
    // Analytic 180-deg semicircle turnaround at dead-end Greenway bicycle bulb (R = laneOffset = 2.55 m)
    // Incoming lane is at `I + d * inRx` (right side); center is `I` along the transverse axis.
    const R = d;
    const trimIn = Math.hypot(inter.x - inEdge.x1, inter.z - inEdge.z1);
    const leadInLen = Math.max(0, trimIn);
    const leadOutLen = Math.max(0, Math.hypot(outEdge.x0 - inter.x, outEdge.z0 - inter.z));
    // Arc starts at `I + d * inR` (u0 = inR), initially heading `inT` (v0 = inT), sweeping PI to `-inR`!
    const arcLen = Math.PI * R;
    const arcEndX = inter.x - inRx * d;
    const arcEndZ = inter.z - inRz * d;
    return {
      intersectionId: inter.id,
      inEdgeId: inEdge.id,
      outEdgeId: outEdge.id,
      profile,
      kind,
      leadInLen,
      startX,
      startZ,
      inTx,
      inTz,
      inRx,
      inRz,
      arcLen,
      arcRadius: R,
      arcCenterX: inter.x,
      arcCenterZ: inter.z,
      arcU0x: inRx,
      arcU0z: inRz,
      arcV0x: inTx,
      arcV0z: inTz,
      arcSweepRad: Math.PI,
      // Turning left across median (+yaw in right-handed XZ -> positive steer curvature +1/R)
      curvature: 1 / R,
      leadOutLen,
      arcEndX,
      arcEndZ,
      outTx,
      outTz,
      outRx,
      outRz,
      totalLength: leadInLen + arcLen + leadOutLen,
    };
  }

  if (kind === 'right') {
    const R = metrics.rightTurnRadius;
    const pullback = R + d;
    const trimIn = Math.hypot(inter.x - inEdge.x1, inter.z - inEdge.z1);
    const trimOut = Math.hypot(outEdge.x0 - inter.x, outEdge.z0 - inter.z);
    const leadInLen = Math.max(0, trimIn - pullback);
    const leadOutLen = Math.max(0, trimOut - pullback);
    const arcStartX = inter.x - inTx * pullback + inRx * d;
    const arcStartZ = inter.z - inTz * pullback + inRz * d;
    const arcCenterX = arcStartX + inRx * R;
    const arcCenterZ = arcStartZ + inRz * R;
    // u0 = (arcStart - center)/R = -inR; v0 = inT (initial unit tangent!)
    const arcEndX = arcCenterX + inTx * R;
    const arcEndZ = arcCenterZ + inTz * R;
    const arcLen = Math.PI * 0.5 * R;
    return {
      intersectionId: inter.id,
      inEdgeId: inEdge.id,
      outEdgeId: outEdge.id,
      profile,
      kind,
      leadInLen,
      startX,
      startZ,
      inTx,
      inTz,
      inRx,
      inRz,
      arcLen,
      arcRadius: R,
      arcCenterX,
      arcCenterZ,
      arcU0x: -inRx,
      arcU0z: -inRz,
      arcV0x: inTx,
      arcV0z: inTz,
      arcSweepRad: Math.PI * 0.5,
      // Right turn decreases yaw -> negative Ackermann steer angle `steer < 0` -> curvature `-1/R`
      curvature: -1 / R,
      leadOutLen,
      arcEndX,
      arcEndZ,
      outTx,
      outTz,
      outRx,
      outRz,
      totalLength: leadInLen + arcLen + leadOutLen,
    };
  }

  // Left turn: outTx === -inRx, outRz === inTx
  const R = metrics.leftTurnRadius;
  const pullback = R - d;
  const trimIn = Math.hypot(inter.x - inEdge.x1, inter.z - inEdge.z1);
  const trimOut = Math.hypot(outEdge.x0 - inter.x, outEdge.z0 - inter.z);
  const leadInLen = Math.max(0, trimIn - pullback);
  const leadOutLen = Math.max(0, trimOut - pullback);
  const arcStartX = inter.x - inTx * pullback + inRx * d;
  const arcStartZ = inter.z - inTz * pullback + inRz * d;
  const arcCenterX = arcStartX - inRx * R;
  const arcCenterZ = arcStartZ - inRz * R;
  // u0 = (arcStart - center)/R = +inR; v0 = inT (initial unit tangent!)
  const arcEndX = arcCenterX + inTx * R;
  const arcEndZ = arcCenterZ + inTz * R;
  const arcLen = Math.PI * 0.5 * R;
  return {
    intersectionId: inter.id,
    inEdgeId: inEdge.id,
    outEdgeId: outEdge.id,
    profile,
    kind,
    leadInLen,
    startX,
    startZ,
    inTx,
    inTz,
    inRx,
    inRz,
    arcLen,
    arcRadius: R,
    arcCenterX,
    arcCenterZ,
    arcU0x: inRx,
    arcU0z: inRz,
    arcV0x: inTx,
    arcV0z: inTz,
    arcSweepRad: Math.PI * 0.5,
    // Left turn increases yaw -> positive Ackermann steer angle `steer > 0` -> curvature `+1/R`
    curvature: 1 / R,
    leadOutLen,
    arcEndX,
    arcEndZ,
    outTx,
    outTz,
    outRx,
    outRz,
    totalLength: leadInLen + arcLen + leadOutLen,
  };
}

export class RoadGraph {
  readonly intersections: RoadIntersection[];
  readonly edges: RoadEdge[];
  readonly crosswalks: Rect[];
  private readonly connectors = new Map<number, TurnConnector>();
  private curbRegistered = false;

  constructor(intersections: RoadIntersection[], edges: RoadEdge[], crosswalks: Rect[]) {
    this.intersections = intersections;
    this.edges = edges;
    this.crosswalks = crosswalks;

    // Precompute every valid turn connector for all 3 vehicle profiles (zero runtime allocations!)
    const profiles: readonly LaneProfileId[] = ['car', 'scooter', 'bicycle'];
    for (let i = 0; i < intersections.length; i++) {
      const inter = intersections[i];
      for (let inD = 0; inD < 4; inD++) {
        const inId = inter.inEdges[inD];
        if (inId < 0) continue;
        const inEdge = edges[inId];
        for (let outD = 0; outD < 4; outD++) {
          const outId = inter.outEdges[outD];
          if (outId < 0) continue;
          const outEdge = edges[outId];
          const kind = classifyTurn(inEdge.dir, outEdge.dir);
          // U-turns are ONLY built at dead-end spur turnaround bulbs (Greenway East)
          if (kind === 'uturn' && !inter.isSpurEnd) continue;
          for (let p = 0; p < profiles.length; p++) {
            const prof = profiles[p];
            if (prof !== 'bicycle' && (inEdge.bikeOnly || outEdge.bikeOnly || kind === 'uturn')) continue;
            const key = this.connectorKey(inId, outId, p);
            this.connectors.set(key, buildConnector(inter, inEdge, outEdge, prof));
          }
        }
      }
    }
  }

  private connectorKey(inEdgeId: number, outEdgeId: number, profileIdx: number): number {
    return ((inEdgeId * 128 + outEdgeId) << 2) | profileIdx;
  }

  private profileIndex(profile: LaneProfileId): number {
    return profile === 'car' ? 0 : profile === 'scooter' ? 1 : 2;
  }

  getConnector(inEdgeId: number, outEdgeId: number, profile: LaneProfileId): TurnConnector | null {
    return this.connectors.get(this.connectorKey(inEdgeId, outEdgeId, this.profileIndex(profile))) ?? null;
  }

  /**
   * Lists valid outgoing edge IDs from `inEdgeId` into reusable buffer `outBuf` (zero allocations).
   * Returns count written to `outBuf`.
   */
  collectOutgoingEdges(inEdgeId: number, profile: LaneProfileId, outBuf: number[]): number {
    outBuf.length = 0;
    const inEdge = this.edges[inEdgeId];
    if (!inEdge) return 0;
    const inter = this.intersections[inEdge.toNode];
    if (!inter) return 0;
    const pIdx = this.profileIndex(profile);
    for (let d = 0; d < 4; d++) {
      const outId = inter.outEdges[d];
      if (outId < 0) continue;
      if (this.connectors.has(this.connectorKey(inEdgeId, outId, pIdx))) {
        outBuf.push(outId);
      }
    }
    return outBuf.length;
  }

  /**
   * Projects stationary curb-parked car footprints onto overlapping `RoadEdge`s ONCE so
   * MOBIL-lite lateral bypass checks run in `O(1)` per vehicle per frame.
   */
  registerCurbBoxes(boxes: readonly CurbBoxInput[]): void {
    for (let e = 0; e < this.edges.length; e++) {
      this.edges[e].curbBays.length = 0;
    }
    for (let b = 0; b < boxes.length; b++) {
      const box = boxes[b];
      const cx = box.x ?? (box.x0 + box.x1) * 0.5;
      const cz = box.z ?? (box.z0 + box.z1) * 0.5;
      const halfAlongX = Math.abs(box.x1 - box.x0) * 0.5;
      const halfAlongZ = Math.abs(box.z1 - box.z0) * 0.5;
      const yaw = box.yaw ?? 0;

      for (let e = 0; e < this.edges.length; e++) {
        const edge = this.edges[e];
        const dx = cx - edge.x0;
        const dz = cz - edge.z0;
        const sCenter = dx * edge.tx + dz * edge.tz;
        const latCenter = dx * edge.rx + dz * edge.rz;
        const halfLong = Math.abs(edge.tx) * halfAlongX + Math.abs(edge.tz) * halfAlongZ;
        const halfLat = Math.abs(edge.rx) * halfAlongX + Math.abs(edge.rz) * halfAlongZ;

        if (sCenter + halfLong < -1.0 || sCenter - halfLong > edge.length + 1.0) continue;
        // Must overlap this directional right-hand half-carriageway (`lat in [0, 3.6]`)
        if (latCenter + halfLat <= 0.1 || latCenter - halfLat >= ROAD_HALF_WIDTH + 0.3) continue;

        edge.curbBays.push({
          sStart: Math.max(0, sCenter - halfLong),
          sEnd: Math.min(edge.length, sCenter + halfLong),
          innerEdgeLat: Math.max(0, latCenter - halfLat),
          outerEdgeLat: latCenter + halfLat,
          cx,
          cz,
          halfWidth: box.hx ?? halfLat,
          halfLength: box.hz ?? halfLong,
          yaw,
        });
      }
    }
    this.curbRegistered = true;
  }

  get hasCurbBoxes(): boolean {
    return this.curbRegistered;
  }

  /**
   * Deadlock-free intersection box claim. Releases stale locks automatically after `maxHoldSec`.
   */
  tryClaimIntersection(
    intersectionId: number,
    agentId: number,
    nowSec: number,
    maxHoldSec = 6.0,
  ): boolean {
    const inter = this.intersections[intersectionId];
    if (!inter) return true;
    if (
      inter.boxOwnerId === -1 ||
      inter.boxOwnerId === agentId ||
      nowSec - inter.boxClaimedAt > maxHoldSec
    ) {
      inter.boxOwnerId = agentId;
      inter.boxClaimedAt = nowSec;
      return true;
    }
    return false;
  }

  releaseIntersection(intersectionId: number, agentId: number): void {
    const inter = this.intersections[intersectionId];
    if (inter && inter.boxOwnerId === agentId) {
      inter.boxOwnerId = -1;
    }
  }

  /** Finds the closest directed edge matching an arbitrary road rect and E/W direction (for legacy `Commuter` spawn). */
  findClosestEdge(
    x: number,
    z: number,
    preferredDir: CardinalDir,
    profile: LaneProfileId,
  ): RoadEdge | null {
    let best: RoadEdge | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      if (profile !== 'bicycle' && e.bikeOnly) continue;
      const mx = (e.x0 + e.x1) * 0.5;
      const mz = (e.z0 + e.z1) * 0.5;
      const dirPenalty = e.dir === preferredDir ? 0 : 120;
      const d = Math.hypot(mx - x, mz - z) + dirPenalty;
      if (d < bestScore) {
        bestScore = d;
        best = e;
      }
    }
    return best;
  }
}

function dedupeSorted(vals: number[], eps = 1.2): number[] {
  vals.sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i < vals.length; i++) {
    if (!out.length || Math.abs(vals[i] - out[out.length - 1]) > eps) {
      out.push(vals[i]);
    }
  }
  return out;
}

/**
 * Builds the parametric Right-Hand Traffic `RoadGraph` directly from `city.ground`.
 * Adapts automatically across all house room sizes (`4, 6, 7.5, 9 m`).
 */
export function buildRoadGraph(city: CityPlan): RoadGraph {
  const ewRoads: Rect[] = [];
  const nsRoads: Rect[] = [];
  const crossings: Rect[] = [];

  for (let i = 0; i < city.ground.length; i++) {
    const g = city.ground[i];
    if (g.surface === 'crossing') {
      crossings.push(g.rect);
      continue;
    }
    if (g.surface !== 'road') continue;
    const w = g.rect.x1 - g.rect.x0;
    const d = g.rect.z1 - g.rect.z0;
    if (w > 40 && d <= 9.5) ewRoads.push(g.rect);
    else if (d > 10 && w <= 9.5) nsRoads.push(g.rect);
  }

  // Sort E-W avenues north -> south: [Riverside Rd, Lantern St, Market Blvd]
  ewRoads.sort((a, b) => (a.z0 + a.z1) * 0.5 - (b.z0 + b.z1) * 0.5);
  const xsList = dedupeSorted(nsRoads.map((r) => (r.x0 + r.x1) * 0.5));

  const intersections: RoadIntersection[] = [];
  const nodeGrid: number[][] = []; // [ewIdx][nsIdx] -> intersectionId or -1

  for (let rIdx = 0; rIdx < ewRoads.length; rIdx++) {
    const ew = ewRoads[rIdx];
    const cz = (ew.z0 + ew.z1) * 0.5;
    const row: number[] = [];
    for (let cIdx = 0; cIdx < xsList.length; cIdx++) {
      const cx = xsList[cIdx];
      // Verify intersection sits within the E-W road's X span and touches at least one N-S road
      // (`city.ts:153` trims N-S road rects at sidewalk edge 6.5 m from E-W centerline -> 7.5 m check)
      const inEwSpan = cx >= ew.x0 - 0.5 && cx <= ew.x1 + 0.5;
      const touchesNs = nsRoads.some(
        (ns) =>
          Math.abs((ns.x0 + ns.x1) * 0.5 - cx) < 1.2 &&
          cz >= ns.z0 - 7.5 &&
          cz <= ns.z1 + 7.5,
      );
      if (inEwSpan && touchesNs) {
        const id = intersections.length;
        intersections.push({
          id,
          name: `I_${rIdx}_${cIdx}`,
          x: cx,
          z: cz,
          isSpurEnd: false,
          outEdges: [-1, -1, -1, -1],
          inEdges: [-1, -1, -1, -1],
          boxOwnerId: -1,
          boxClaimedAt: -999,
        });
        row.push(id);
      } else {
        row.push(-1);
      }
    }
    nodeGrid.push(row);
  }

  const edges: RoadEdge[] = [];
  const attachCrosswalks = (edge: RoadEdge) => {
    for (let c = 0; c < crossings.length; c++) {
      const cr = crossings[c];
      const cx = (cr.x0 + cr.x1) * 0.5;
      const cz = (cr.z0 + cr.z1) * 0.5;
      const dx = cx - edge.x0;
      const dz = cz - edge.z0;
      const sMid = dx * edge.tx + dz * edge.tz;
      const latMid = Math.abs(dx * edge.rx + dz * edge.rz);
      const halfSpanAlong =
        Math.abs(edge.tx) * ((cr.x1 - cr.x0) * 0.5) +
        Math.abs(edge.tz) * ((cr.z1 - cr.z0) * 0.5);
      const halfSpanLat =
        Math.abs(edge.rx) * ((cr.x1 - cr.x0) * 0.5) +
        Math.abs(edge.rz) * ((cr.z1 - cr.z0) * 0.5);
      if (latMid > halfSpanLat + ROAD_HALF_WIDTH) continue;
      if (sMid + halfSpanAlong < 0 || sMid - halfSpanAlong > edge.length) continue;
      const sEntry = Math.max(0, sMid - halfSpanAlong);
      const sExit = Math.min(edge.length, sMid + halfSpanAlong);
      edge.crosswalks.push({
        sEntry,
        sExit,
        sStop: Math.max(0, sEntry - 1.6),
        rect: cr,
      });
    }
    edge.crosswalks.sort((a, b) => a.sEntry - b.sEntry);
  };

  const addBidirectional = (
    nodeAId: number,
    nodeBId: number,
    dirAB: CardinalDir,
    isMajor: boolean,
    bikeOnly: boolean,
    roadRect: Rect,
    trimA = INTERSECTION_TRIM,
    trimB = INTERSECTION_TRIM,
  ) => {
    const a = intersections[nodeAId];
    const b = intersections[nodeBId];
    const tx = DIR_TX[dirAB];
    const tz = DIR_TZ[dirAB];
    const rx = DIR_RX[dirAB];
    const rz = DIR_RZ[dirAB];
    const totalDist = Math.hypot(b.x - a.x, b.z - a.z);
    if (totalDist <= trimA + trimB + 1.0) return;

    const dirBA = ((dirAB + 2) & 3) as CardinalDir;
    const idAB = edges.length;
    const idBA = idAB + 1;

    const eAB: RoadEdge = {
      id: idAB,
      fromNode: nodeAId,
      toNode: nodeBId,
      dir: dirAB,
      isMajor,
      bikeOnly,
      oppositeEdgeId: idBA,
      x0: a.x + tx * trimA,
      z0: a.z + tz * trimA,
      x1: b.x - tx * trimB,
      z1: b.z - tz * trimB,
      tx,
      tz,
      rx,
      rz,
      yaw: DIR_YAW[dirAB],
      length: totalDist - trimA - trimB,
      roadRect,
      crosswalks: [],
      curbBays: [],
    };
    const eBA: RoadEdge = {
      id: idBA,
      fromNode: nodeBId,
      toNode: nodeAId,
      dir: dirBA,
      isMajor,
      bikeOnly,
      oppositeEdgeId: idAB,
      x0: b.x - tx * trimB,
      z0: b.z - tz * trimB,
      x1: a.x + tx * trimA,
      z1: a.z + tz * trimA,
      tx: -tx,
      tz: -tz,
      rx: -rx,
      rz: -rz,
      yaw: DIR_YAW[dirBA],
      length: totalDist - trimA - trimB,
      roadRect,
      crosswalks: [],
      curbBays: [],
    };

    attachCrosswalks(eAB);
    attachCrosswalks(eBA);
    edges.push(eAB, eBA);

    a.outEdges[dirAB] = idAB;
    b.inEdges[dirAB] = idAB;
    b.outEdges[dirBA] = idBA;
    a.inEdges[dirBA] = idBA;
  };

  // 1. East-West avenue segments between adjacent cross-street intersections
  for (let rIdx = 0; rIdx < ewRoads.length; rIdx++) {
    const ew = ewRoads[rIdx];
    const row = nodeGrid[rIdx];
    for (let cIdx = 0; cIdx < row.length - 1; cIdx++) {
      const aId = row[cIdx];
      const bId = row[cIdx + 1];
      if (aId >= 0 && bId >= 0) {
        addBidirectional(aId, bId, 0, true, false, ew);
      }
    }
  }

  // 2. North-South cross-street segments between adjacent avenues
  for (let cIdx = 0; cIdx < xsList.length; cIdx++) {
    const cx = xsList[cIdx];
    for (let rIdx = 0; rIdx < ewRoads.length - 1; rIdx++) {
      const aId = nodeGrid[rIdx][cIdx];
      const bId = nodeGrid[rIdx + 1][cIdx];
      if (aId < 0 || bId < 0) continue;
      const zMid = (intersections[aId].z + intersections[bId].z) * 0.5;
      const segRect = nsRoads.find(
        (ns) =>
          Math.abs((ns.x0 + ns.x1) * 0.5 - cx) < 1.2 &&
          zMid >= ns.z0 - 0.5 &&
          zMid <= ns.z1 + 0.5,
      );
      if (segRect) {
        addBidirectional(aId, bId, 1, false, false, segRect);
      }
    }
  }

  // 3. Riverside East Greenway bicycle spur (extends east from last Riverside intersection to x1 - 8)
  if (ewRoads.length > 0 && nodeGrid[0].length > 0) {
    const riverRect = ewRoads[0];
    let eastMostId = -1;
    for (let cIdx = nodeGrid[0].length - 1; cIdx >= 0; cIdx--) {
      if (nodeGrid[0][cIdx] >= 0) {
        eastMostId = nodeGrid[0][cIdx];
        break;
      }
    }
    const spurX = riverRect.x1 - 8.0;
    if (eastMostId >= 0 && spurX - intersections[eastMostId].x > 18) {
      const spurId = intersections.length;
      intersections.push({
        id: spurId,
        name: 'GW_EAST_BULB',
        x: spurX,
        z: intersections[eastMostId].z,
        isSpurEnd: true,
        outEdges: [-1, -1, -1, -1],
        inEdges: [-1, -1, -1, -1],
        boxOwnerId: -1,
        boxClaimedAt: -999,
      });
      // Trim 0 at spur end so the R = 2.55 m semicircular turnaround bulb starts right at spurX
      addBidirectional(eastMostId, spurId, 0, true, true, riverRect, INTERSECTION_TRIM, 0);
    }
  }

  return new RoadGraph(intersections, edges, crossings);
}

const GRAPH_CACHE = new WeakMap<CityPlan, RoadGraph>();

/** Cached per-`CityPlan` RoadGraph accessor (zero rebuilds across frames or commuters). */
export function getOrBuildRoadGraph(city: CityPlan): RoadGraph {
  let g = GRAPH_CACHE.get(city);
  if (!g) {
    g = buildRoadGraph(city);
    GRAPH_CACHE.set(city, g);
  }
  return g;
}
