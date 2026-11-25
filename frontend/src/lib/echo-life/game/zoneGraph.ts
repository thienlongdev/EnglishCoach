/**
 * Echo Life Total Rebirth — 30-Zone Walkable Spine Graph & 3-Tier Distance LOD Handover (A06).
 *
 * Powers Tier 2 (`> 110 m`) continuous 0.5 Hz abstract traversal with ZERO per-resident A* budget
 * and mathematical Zero-Teleport consistency (`Δpos === 0.00 m` on Tier 2 → Tier 1/0 promotion).
 *
 * Every spine edge is proved walkable at 3.5 cm by `LifeNav`, so every sampled Tier 2 coordinate
 * satisfies `nav.walk.free(pos) === true` and obeys live closed doors (`DOOR_STOP = 1.15 m`).
 */
import { V3_ZONE_IDS, type V3ZoneId } from '../zones';
import type { LifeNav, P, Route } from './nav';

export type TierLevel = 0 | 1 | 2;

export const TIER_THRESHOLDS = {
  T0_ENTER: 35,
  T0_EXIT: 43,
  T1_ENTER: 110,
  T1_EXIT: 122,
} as const;

export const TIER_INTERVAL_SECONDS: Readonly<Record<TierLevel, number>> = {
  0: 0,      // 60 Hz (every frame)
  1: 0.2,    // 5 Hz
  2: 2.0,    // 0.5 Hz (max stride 2.56 m walk / 4.80 m run -> well under test-echo-life-game.mjs bound)
};

const DOOR_STOP = 1.15;

/** Resolve 3-Tier distance simulation LOD with exit hysteresis to prevent boundary thrashing. */
export function resolveSimulationTier(
  prevTier: TierLevel,
  dist: number,
  sameZone: boolean,
  isTalking: boolean,
): TierLevel {
  if (isTalking || sameZone || dist < TIER_THRESHOLDS.T0_ENTER) return 0;
  if (prevTier === 0 && dist <= TIER_THRESHOLDS.T0_EXIT) return 0;
  if (dist <= TIER_THRESHOLDS.T1_ENTER) return 1;
  if (prevTier <= 1 && dist <= TIER_THRESHOLDS.T1_EXIT) return 1;
  return 2;
}

export interface ZoneDoorPort {
  door(id: string): {
    readonly passable: boolean;
    readonly isOpen: boolean;
    prepare(at: P): void;
    setOpen(open: boolean): void;
  } | null;
}

export interface SpineDoorCrossing {
  readonly door: string;
  readonly at: P;
  /** Arc distance from start of this spine edge to the door center. */
  readonly dist: number;
}

export interface ZoneSpineEdge {
  readonly from: V3ZoneId;
  readonly to: V3ZoneId;
  /** Proven walkable polyline starting at `from` anchor (or attach point) and ending at `to` anchor. */
  readonly points: readonly P[];
  /** Cumulative arc lengths matching `points` (`cumDist[0] = 0`, `cumDist[last] = length`). */
  readonly cumDist: Float32Array;
  readonly length: number;
  readonly doors: readonly SpineDoorCrossing[];
}

export interface AbstractTrip {
  readonly destZone: V3ZoneId;
  readonly destPoint: P;
  readonly edges: readonly ZoneSpineEdge[];
  edgeIndex: number;
  arcCursor: number;
  /** Furniture revision at trip creation; invalidates cleanly if player rearranges furniture. */
  readonly furnitureRevision: number;
}

export interface AbstractStepResult {
  x: number;
  z: number;
  yaw: number;
  zone: V3ZoneId;
  arrived: boolean;
  movedDist: number;
  waitingDoor: string | null;
  openedDoor: string | null;
  closeBehindDoor: { door: string; at: P } | null;
}

/**
 * Physical undirected adjacency across all 30 NPC-accessible zones (excluding player-only `study`).
 * Mirrors both V3 `world.mjs` links and direct continuous Phase 2 city connections (`hall ↔ street`, etc.).
 */
const PHYSICAL_ZONE_LINKS: readonly (readonly [V3ZoneId, V3ZoneId])[] = [
  // Home interior & exits
  ['hall', 'living'],
  ['hall', 'bedroom'],
  ['hall', 'bath'],
  ['hall', 'gaming_room'],
  ['hall', 'garage'],
  ['hall', 'street'],
  ['living', 'kitchen'],
  ['living', 'yard'],
  ['bedroom', 'balcony'],
  ['yard', 'garage'],
  ['yard', 'street'],
  ['garage', 'street'],
  // Neighborhood & Shopping Row buildings on street
  ['street', 'linh'],
  ['street', 'minh'],
  ['street', 'cafe'],
  ['street', 'bistro'],
  ['street', 'market'],
  ['street', 'electronics_shop'],
  ['street', 'furniture_shop'],
  ['street', 'clothing_shop'],
  ['street', 'vehicle_dealer'],
  ['street', 'home_center'],
  ['street', 'repair_shop'],
  ['street', 'atelier'],
  // Outdoor districts, Campus, Parks & Hidden Gems
  ['street', 'campus'],
  ['street', 'park'],
  ['street', 'fair'],
  ['street', 'greenway'],
  ['street', 'botanical'],
  ['street', 'fountain_plaza'],
  ['campus', 'library'],
  ['campus', 'fountain_plaza'],
  ['park', 'botanical'],
  ['park', 'fair'],
  ['park', 'atelier'],
  ['fair', 'greenway'],
  ['greenway', 'lantern_garden'],
  ['fountain_plaza', 'lantern_garden'],
];

const PUBLIC_ZONES: readonly V3ZoneId[] = V3_ZONE_IDS.filter(z => z !== 'study');

function edgeKey(from: V3ZoneId, to: V3ZoneId): string {
  return `${from}>${to}`;
}

export class ZoneTravelGraph {
  private readonly adj = new Map<V3ZoneId, V3ZoneId[]>();
  private readonly anchors = new Map<V3ZoneId, P>();
  private readonly edges = new Map<string, ZoneSpineEdge | null>();
  private readonly doorById = new Map<string, { x: number; z: number }>();
  private bakedRevision = -1;
  private warmIndex = 0;

  stats = { bakedEdges: 0, abstractTrips: 0, handoffs: 0 };

  constructor(private readonly nav: LifeNav) {
    for (const z of PUBLIC_ZONES) this.adj.set(z, []);
    for (const [a, b] of PHYSICAL_ZONE_LINKS) {
      this.adj.get(a)?.push(b);
      this.adj.get(b)?.push(a);
    }
    for (const d of nav.doors) {
      this.doorById.set(d.id, { x: d.x, z: d.z });
    }
    this.syncRevision();
  }

  private syncRevision(): void {
    if (this.bakedRevision === this.nav.furnitureRevision) return;
    this.bakedRevision = this.nav.furnitureRevision;
    this.edges.clear();
    this.anchors.clear();
    this.warmIndex = 0;
    for (const z of PUBLIC_ZONES) {
      const sp = this.nav.spots(z, 1)[0];
      if (sp) this.anchors.set(z, sp);
    }
  }

  anchorOf(zone: V3ZoneId): P | null {
    this.syncRevision();
    return this.anchors.get(zone) ?? null;
  }

  /** Lazily bake up to `maxEdges` undirected zone spines per idle call once `nav.warmed` is ready. */
  warmStep(maxEdges = 2): boolean {
    this.syncRevision();
    let done = 0;
    while (this.warmIndex < PHYSICAL_ZONE_LINKS.length && done < maxEdges) {
      const [a, b] = PHYSICAL_ZONE_LINKS[this.warmIndex++];
      if (!this.edges.has(edgeKey(a, b))) {
        this.ensureEdge(a, b, true);
        done++;
      }
    }
    return this.warmIndex >= PHYSICAL_ZONE_LINKS.length;
  }

  get warmed(): boolean {
    return this.warmIndex >= PHYSICAL_ZONE_LINKS.length;
  }

  /** Get (or lazily bake once) the proven walkable spine polyline from `from` to `to`. */
  ensureEdge(from: V3ZoneId, to: V3ZoneId, allowBake = true): ZoneSpineEdge | null {
    this.syncRevision();
    const k = edgeKey(from, to);
    const cached = this.edges.get(k);
    if (cached !== undefined) return cached;
    if (!allowBake) return null;

    const a = this.anchors.get(from);
    const b = this.anchors.get(to);
    if (!a || !b) {
      this.edges.set(k, null);
      return null;
    }

    const r = this.nav.route(a, b);
    if (!r || !r.points.length) {
      this.edges.set(k, null);
      return null;
    }

    const fwd = this.buildSpineFromRoute(from, to, a, r);
    const rev = this.reverseSpine(fwd);
    this.edges.set(k, fwd);
    this.edges.set(edgeKey(to, from), rev);
    this.stats.bakedEdges += 2;
    return fwd;
  }

  private buildSpineFromRoute(from: V3ZoneId, to: V3ZoneId, start: P, route: Route): ZoneSpineEdge {
    const pts: P[] = [{ x: start.x, z: start.z }];
    for (let i = 0; i < route.points.length; i++) {
      const p = route.points[i];
      const prev = pts[pts.length - 1];
      if (Math.hypot(p.x - prev.x, p.z - prev.z) > 1e-4) {
        pts.push({ x: p.x, z: p.z });
      }
    }
    if (pts.length === 1) pts.push({ x: start.x, z: start.z });

    const cumDist = new Float32Array(pts.length);
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      cumDist[i] = total;
    }

    const doors: SpineDoorCrossing[] = [];
    const seen = new Set<string>();
    for (const d of route.doors) {
      if (seen.has(d.door)) continue;
      seen.add(d.door);
      const plan = this.doorById.get(d.door);
      if (!plan) continue;
      const dist = this.projectDistOnPolyline(pts, cumDist, plan);
      doors.push({ door: d.door, at: { x: plan.x, z: plan.z }, dist });
    }
    doors.sort((a, b) => a.dist - b.dist);

    return { from, to, points: pts, cumDist, length: total, doors };
  }

  private buildSimpleLeg(from: V3ZoneId, to: V3ZoneId, a: P, b: P): ZoneSpineEdge {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const pts: P[] = [{ x: a.x, z: a.z }, { x: b.x, z: b.z }];
    const cumDist = new Float32Array([0, len]);
    const doors: SpineDoorCrossing[] = [];
    // Detect any door corridor crossed on this direct leg
    const samples = Math.max(2, Math.ceil(len / 0.25));
    const seen = new Set<string>();
    for (let k = 0; k <= samples; k++) {
      const t = k / samples;
      const qx = a.x + (b.x - a.x) * t;
      const qz = a.z + (b.z - a.z) * t;
      for (const d of this.nav.doors) {
        if (seen.has(d.id)) continue;
        const c = d.corridor;
        if (qx >= c.x0 && qx <= c.x1 && qz >= c.z0 && qz <= c.z1) {
          seen.add(d.id);
          doors.push({ door: d.id, at: { x: d.x, z: d.z }, dist: len * t });
        }
      }
    }
    doors.sort((u, v) => u.dist - v.dist);
    return { from, to, points: pts, cumDist, length: len, doors };
  }

  private reverseSpine(edge: ZoneSpineEdge): ZoneSpineEdge {
    const n = edge.points.length;
    const pts: P[] = new Array(n);
    const cumDist = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pts[i] = edge.points[n - 1 - i];
      cumDist[i] = Math.max(0, edge.length - edge.cumDist[n - 1 - i]);
    }
    const doors: SpineDoorCrossing[] = edge.doors
      .map(d => ({ door: d.door, at: d.at, dist: Math.max(0, edge.length - d.dist) }))
      .sort((a, b) => a.dist - b.dist);
    return { from: edge.to, to: edge.from, points: pts, cumDist, length: edge.length, doors };
  }

  private projectDistOnPolyline(pts: readonly P[], cumDist: Float32Array, target: P): number {
    let bestDist = 0;
    let bestErr2 = Infinity;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 1e-8 ? Math.max(0, Math.min(1, ((target.x - a.x) * dx + (target.z - a.z) * dz) / l2)) : 0;
      const px = a.x + dx * t;
      const pz = a.z + dz * t;
      const err2 = (px - target.x) * (px - target.x) + (pz - target.z) * (pz - target.z);
      if (err2 < bestErr2) {
        bestErr2 = err2;
        bestDist = cumDist[i - 1] + Math.sqrt(l2) * t;
      }
    }
    return bestDist;
  }

  /** Fast O(V+E) Dijkstra shortest zone hop sequence over the 30-zone physical graph. */
  planZoneHops(from: V3ZoneId, to: V3ZoneId): V3ZoneId[] | null {
    this.syncRevision();
    if (from === to) return [from];
    if (!this.adj.has(from) || !this.adj.has(to)) return null;

    const dist = new Map<V3ZoneId, number>([[from, 0]]);
    const prev = new Map<V3ZoneId, V3ZoneId | null>([[from, null]]);
    const unvisited = new Set<V3ZoneId>(PUBLIC_ZONES);

    while (unvisited.size) {
      let cur: V3ZoneId | null = null;
      let best = Infinity;
      for (const z of unvisited) {
        const d = dist.get(z) ?? Infinity;
        if (d < best) {
          best = d;
          cur = z;
        }
      }
      if (!cur || best === Infinity) break;
      if (cur === to) break;
      unvisited.delete(cur);

      const nbs = this.adj.get(cur) ?? [];
      const curA = this.anchors.get(cur);
      for (let i = 0; i < nbs.length; i++) {
        const nb = nbs[i];
        if (!unvisited.has(nb)) continue;
        const baked = this.edges.get(edgeKey(cur, nb));
        if (baked === null) continue; // known impassable
        let w = baked ? baked.length : 12;
        if (!baked) {
          const nbA = this.anchors.get(nb);
          if (curA && nbA) w = Math.hypot(nbA.x - curA.x, nbA.z - curA.z);
        }
        const cand = best + Math.max(1, w);
        if (cand < (dist.get(nb) ?? Infinity)) {
          dist.set(nb, cand);
          prev.set(nb, cur);
        }
      }
    }

    if (!prev.has(to)) return null;
    const hops: V3ZoneId[] = [];
    for (let k: V3ZoneId | null = to; k !== null; k = prev.get(k) ?? null) {
      hops.unshift(k);
    }
    return hops;
  }

  /**
   * Create a continuous walkable Tier 2 `AbstractTrip` starting at exact `fromPos` (ZERO jump on start).
   * Uses cached zone spine edges (0 A* work once warmed).
   */
  startTrip(
    fromPos: P,
    fromZone: V3ZoneId,
    toZone: V3ZoneId,
    toSpot: P,
    allowBake = true,
  ): AbstractTrip | null {
    this.syncRevision();
    if (!this.nav.walk.free(fromPos) || !this.nav.walk.free(toSpot)) return null;

    if (fromZone === toZone) {
      if (Math.hypot(toSpot.x - fromPos.x, toSpot.z - fromPos.z) < 0.1) return null;
      if (this.nav.clear(fromPos, toSpot)) {
        const leg = this.buildSimpleLeg(fromZone, toZone, fromPos, toSpot);
        this.stats.abstractTrips++;
        return { destZone: toZone, destPoint: toSpot, edges: [leg], edgeIndex: 0, arcCursor: 0, furnitureRevision: this.bakedRevision };
      }
      if (!allowBake) return null;
      const r = this.nav.route(fromPos, toSpot);
      if (!r || !r.points.length) return null;
      const leg = this.buildSpineFromRoute(fromZone, toZone, fromPos, r);
      this.stats.abstractTrips++;
      return { destZone: toZone, destPoint: toSpot, edges: [leg], edgeIndex: 0, arcCursor: 0, furnitureRevision: this.bakedRevision };
    }

    const hops = this.planZoneHops(fromZone, toZone);
    if (!hops || hops.length < 2) return null;

    const spineEdges: ZoneSpineEdge[] = [];
    for (let i = 0; i < hops.length - 1; i++) {
      const e = this.ensureEdge(hops[i], hops[i + 1], allowBake);
      if (!e) return null;
      spineEdges.push(e);
    }

    const edges: ZoneSpineEdge[] = [];

    // Attach exact `fromPos` seamlessly onto `spineEdges[0]` with ZERO position jump!
    const first = spineEdges[0];
    const startPt = first.points[0];
    const startGap = Math.hypot(fromPos.x - startPt.x, fromPos.z - startPt.z);
    if (startGap > 0.06) {
      if (this.nav.clear(fromPos, startPt)) {
        edges.push(this.buildSimpleLeg(fromZone, fromZone, fromPos, startPt));
      } else {
        // Check if `fromPos` has a clear sightline to an intermediate vertex on `first`
        let hitIdx = -1;
        for (let i = 1; i < first.points.length; i++) {
          if (Math.hypot(first.points[i].x - fromPos.x, first.points[i].z - fromPos.z) <= 22 && this.nav.clear(fromPos, first.points[i])) {
            hitIdx = i;
            break;
          }
        }
        if (hitIdx > 0) {
          edges.push(this.buildSimpleLeg(fromZone, fromZone, fromPos, first.points[hitIdx]));
          // Trim `first` to start at `hitIdx`
          const tailPts = first.points.slice(hitIdx);
          const offset = first.cumDist[hitIdx];
          const tailCum = new Float32Array(tailPts.length);
          for (let i = 0; i < tailPts.length; i++) tailCum[i] = first.cumDist[hitIdx + i] - offset;
          const tailDoors = first.doors
            .filter(d => d.dist >= offset)
            .map(d => ({ door: d.door, at: d.at, dist: d.dist - offset }));
          spineEdges[0] = {
            from: first.from,
            to: first.to,
            points: tailPts,
            cumDist: tailCum,
            length: Math.max(0, first.length - offset),
            doors: tailDoors,
          };
        } else if (allowBake) {
          const attachRoute = this.nav.route(fromPos, startPt);
          if (!attachRoute || !attachRoute.points.length) return null;
          edges.push(this.buildSpineFromRoute(fromZone, fromZone, fromPos, attachRoute));
        } else {
          return null;
        }
      }
    }

    for (const e of spineEdges) edges.push(e);

    // Append final-mile leg to exact `toSpot` if distinct from zone anchor
    const last = edges[edges.length - 1];
    const endPt = last.points[last.points.length - 1];
    if (Math.hypot(toSpot.x - endPt.x, toSpot.z - endPt.z) > 0.08 && this.nav.clear(endPt, toSpot)) {
      edges.push(this.buildSimpleLeg(toZone, toZone, endPt, toSpot));
    }

    this.stats.abstractTrips++;
    return {
      destZone: toZone,
      destPoint: toSpot,
      edges,
      edgeIndex: 0,
      arcCursor: 0,
      furnitureRevision: this.bakedRevision,
    };
  }

  /** Sample exact interpolated `(x, z, yaw)` at arc distance `dist` along a proven walkable spine edge. */
  samplePoint(edge: ZoneSpineEdge, dist: number): { x: number; z: number; yaw: number } {
    const pts = edge.points;
    const cum = edge.cumDist;
    const n = pts.length;
    if (n <= 1 || edge.length <= 1e-6) {
      return { x: pts[0].x, z: pts[0].z, yaw: 0 };
    }
    const d = Math.max(0, Math.min(edge.length, dist));
    // Binary search for segment containing `d`
    let lo = 0;
    let hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const a = pts[lo];
    const b = pts[hi];
    const segLen = cum[hi] - cum[lo];
    const t = segLen > 1e-6 ? (d - cum[lo]) / segLen : 0;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const yaw = Math.hypot(dx, dz) > 1e-4 ? Math.atan2(dx, dz) : 0;
    return { x: a.x + dx * t, z: a.z + dz * t, yaw };
  }

  /**
   * Advance a Tier 2 `AbstractTrip` by `distanceBudget` metres along proven walkable spines.
   * Respects live closed doors (never steps into an unpassable doorway!) and updates exact `(x, z, yaw, zone)`.
   */
  advanceTrip(
    trip: AbstractTrip,
    distanceBudget: number,
    doors: ZoneDoorPort | null,
    openedDoorId: string | null,
  ): AbstractStepResult {
    let rem = Math.max(0, distanceBudget);
    let movedDist = 0;
    let waitingDoor: string | null = null;
    let openedDoor: string | null = openedDoorId;
    let closeBehindDoor: { door: string; at: P } | null = null;

    while (rem > 1e-5 && trip.edgeIndex < trip.edges.length) {
      const edge = trip.edges[trip.edgeIndex];
      const prevArc = trip.arcCursor;
      let targetArc = Math.min(edge.length, prevArc + rem);

      // Door check along [prevArc, targetArc]
      if (doors && edge.doors.length) {
        for (let i = 0; i < edge.doors.length; i++) {
          const dc = edge.doors[i];
          const live = doors.door(dc.door);
          if (!live) continue;

          // Check if we already passed a door we opened and can close it behind us
          if (openedDoor === dc.door && prevArc > dc.dist + 1.6) {
            closeBehindDoor = { door: dc.door, at: dc.at };
            openedDoor = null;
          }

          // Approaching a closed door: never cross `dc.dist - DOOR_STOP` until passable!
          const stopArc = Math.max(0, dc.dist - DOOR_STOP);
          if (!live.passable && prevArc < dc.dist + 0.35 && targetArc >= stopArc - 0.1) {
            const clampedArc = Math.max(prevArc, Math.min(targetArc, stopArc));
            const stepUsed = clampedArc - prevArc;
            trip.arcCursor = clampedArc;
            movedDist += stepUsed;
            const atPos = this.samplePoint(edge, clampedArc);
            if (!live.isOpen) {
              live.prepare({ x: atPos.x, z: atPos.z });
              live.setOpen(true);
              openedDoor = dc.door;
            }
            waitingDoor = dc.door;
            rem = 0;
            const zone = this.nav.walk.zone(atPos) ?? edge.from;
            return {
              x: atPos.x,
              z: atPos.z,
              yaw: Math.atan2(dc.at.x - atPos.x, dc.at.z - atPos.z),
              zone,
              arrived: false,
              movedDist,
              waitingDoor,
              openedDoor,
              closeBehindDoor,
            };
          }

          // Track passing through a door we opened so we close it once clear
          if (live.passable && openedDoor === dc.door && targetArc > dc.dist + 1.6) {
            closeBehindDoor = { door: dc.door, at: dc.at };
            openedDoor = null;
          }
        }
      }

      const delta = targetArc - prevArc;
      trip.arcCursor = targetArc;
      movedDist += delta;
      rem -= delta;

      if (trip.arcCursor >= edge.length - 1e-5) {
        if (trip.edgeIndex + 1 < trip.edges.length) {
          trip.edgeIndex++;
          trip.arcCursor = 0;
        } else {
          break;
        }
      }
    }

    const curIdx = Math.min(trip.edgeIndex, trip.edges.length - 1);
    const curEdge = trip.edges[curIdx];
    const sample = this.samplePoint(curEdge, trip.arcCursor);
    const arrived =
      trip.edgeIndex >= trip.edges.length - 1 &&
      trip.arcCursor >= curEdge.length - 1e-4;
    const zone = this.nav.walk.zone(sample) ?? (arrived ? trip.destZone : curEdge.to);

    return {
      x: sample.x,
      z: sample.z,
      yaw: sample.yaw,
      zone,
      arrived,
      movedDist,
      waitingDoor,
      openedDoor,
      closeBehindDoor,
    };
  }

  /**
   * Zero-Teleport Promotion Handover (Tier 2 → Tier 1 / Tier 0).
   * Converts the unwalked remainder of `trip` directly into a standard `LifeNav` `Route` starting from
   * `currentPos` with `Δpos === 0.00 m`, preserving exact door corridor indices.
   */
  handoffToRoute(trip: AbstractTrip, currentPos: P): Route {
    const points: P[] = [];
    const doors: { door: string; index: number }[] = [];
    let length = 0;
    let prev: P = { x: currentPos.x, z: currentPos.z };

    const pushPoint = (p: P) => {
      const seg = Math.hypot(p.x - prev.x, p.z - prev.z);
      if (seg < 1e-4) return;
      const idx = points.length;
      points.push({ x: p.x, z: p.z });
      length += seg;

      // Tag any door corridors crossed on [prev -> p]
      const samples = Math.max(2, Math.ceil(seg / 0.25));
      const seen = new Set<string>();
      for (let k = 0; k <= samples; k++) {
        const t = k / samples;
        const qx = prev.x + (p.x - prev.x) * t;
        const qz = prev.z + (p.z - prev.z) * t;
        for (const d of this.nav.doors) {
          if (seen.has(d.id)) continue;
          const c = d.corridor;
          if (qx >= c.x0 && qx <= c.x1 && qz >= c.z0 && qz <= c.z1) {
            seen.add(d.id);
            doors.push({ door: d.id, index: idx });
          }
        }
      }
      prev = p;
    };

    for (let eIdx = trip.edgeIndex; eIdx < trip.edges.length; eIdx++) {
      const edge = trip.edges[eIdx];
      const startDist = eIdx === trip.edgeIndex ? trip.arcCursor : 0;
      for (let i = 0; i < edge.points.length; i++) {
        if (edge.cumDist[i] > startDist + 0.02) {
          pushPoint(edge.points[i]);
        }
      }
    }

    if (!points.length) {
      pushPoint(trip.destPoint);
    }

    this.stats.handoffs++;
    return { points, doors, length };
  }
}
