import {
  DOOR_W,
  GROUND_Y,
  STOREY,
  UPPER_WALL_TOP,
  WALL,
  houseZoneAt,
  inRect,
  rect,
  zoneY,
  type Door,
  type HousePlan,
  type Rect,
  type WallSpan,
} from './plan';
import { buildingZoneAt, type EnterableBuilding } from './buildings';
import { type CityPlan, type GroundRect } from './city';

/**
 * Echo Life — Unified Height-Banded Player Capsule Collision, Depenetration-Permissive
 * Admission, Doorway Jamb Funnel, Spawn Sanitizer, and Fixed-60Hz Locomotion Stepping.
 *
 * Implements the single-source-of-truth radii and anti-trap laws established in Phase 1:
 * 1. `NPC_NAV_RADIUS = 0.20 m`: preserves `RoomNavigation` furniture aisles and 22-resident `LifeNav` A*.
 * 2. Height-banded player body:
 *    - `PLAYER_R_LOW = 0.20 m` (hip/thigh half-width) against obstacles with `topRel < 0.95 m`
 *      (chairs, desks, beds, sofas, benches, low planters, curbs).
 *    - `PLAYER_R_HIGH = 0.26 m` (shoulder/deltoid half-width) against obstacles with `topRel >= 0.95 m`
 *      (walls, door jambs, tall shelves, bookstacks, wardrobes, fridges, tree trunks, bus shelters).
 *    - Both scale smoothly by CAZ `buildScale` via `clamp(0.65 + 0.35 * buildScale, 0.9, 1.1)`
 *      matching `StudyPhysics.setActorHeight`.
 * 3. Depenetration-permissive admission (`clearance(next) >= clearance(curr) - 1e-4`):
 *    a player loaded into a tight saved layout or standing beside newly collided props can
 *    never push deeper into geometry, yet can ALWAYS walk out cleanly without getting trapped.
 * 4. Doorway corridors padded by `R_high` (`DOOR_W / 2 - R_high = 0.25 m` half-width = `0.50 m` clear throat)
 *    with cylindrical jamb-post normals that smoothly funnel off-center approaches into the opening.
 */

export const NPC_NAV_RADIUS = 0.20;
export const PLAYER_R_LOW = 0.20;
export const PLAYER_R_HIGH = 0.26;
export const PLAYER_HEIGHT_BAND_SPLIT = 0.95;
export const PLAYER_CLEARANCE_EPS = 1e-4;
export const PLAYER_STEP_UP = 0.30;
export const WORLD_BOUNDARY_PADDING = 0.48;
export const DOOR_PASSABLE_MIN_RAD = 0.92;
export const FIXED_LOCOMOTION_DT = 1 / 60;
export const MAX_FIXED_STEPS_PER_FRAME = 4;

export interface Point2D {
  readonly x: number;
  readonly z: number;
}

export type ObstacleHeightBand = 'low' | 'high' | 'ignore';

export interface PlayerRadii {
  readonly low: number;
  readonly high: number;
  readonly scale: number;
}

export interface OrientedBoxObstacle {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  /** Local X half-extent in metres. */
  readonly halfW: number;
  /** Local Z half-extent in metres. */
  readonly halfD: number;
  /** World Y-axis rotation in radians (`sin(rotY), cos(rotY)` forward). */
  readonly rotY: number;
  /** Local floor elevation in metres (`0` upstairs, `-3.2` street level, etc.). */
  readonly floorY: number;
  /** Height of obstacle top above `floorY` in metres (`< 0.95` -> `low`, `>= 0.95` -> `high`). */
  readonly topRel: number;
}

export interface CircleObstacle {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly floorY: number;
  readonly topRel: number;
}

export interface WorkshopFurnitureBox {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
}

export type DoorCollisionPhase = 'closed' | 'opening' | 'open' | 'occupied' | 'closing';

export interface DoorLeafState {
  readonly id: string;
  readonly hingeX: number;
  readonly hingeZ: number;
  readonly width: number;
  /** World-space direction angle (`atan2(tipZ - hingeZ, tipX - hingeX)` or `closedYaw + swingAngle`) in radians. */
  readonly worldLeafYaw: number;
  /** Signed swing angle from closed latch plane in radians (`0` = shut). */
  readonly swingAngle: number;
  readonly isOpen: boolean;
  readonly phase?: DoorCollisionPhase;
  readonly floorY: number;
}

export interface ParkedVehicleCollider {
  readonly id?: string;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly halfWidth: number;
  readonly halfLength: number;
  readonly floorY?: number;
  readonly topRel?: number;
}

export interface StreetPropLikeSpec {
  readonly key?: string;
  readonly dimensions: readonly [number, number, number];
  readonly naturalHeight: number;
  readonly targetHeight?: number;
  readonly scale?: number;
  readonly yawOffset?: number;
}

export interface VegetationPlacementLike {
  readonly id: number;
  readonly speciesId: string;
  readonly category: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
}

export interface VegetationSpeciesLike {
  readonly id: string;
  readonly category: string;
  readonly height: number;
  readonly crownRadius: number;
}

export interface SanitizeResult {
  readonly x: number;
  readonly z: number;
  readonly y: number;
  readonly clearance: number;
  readonly sanitized: boolean;
}

export interface SlideStepResult {
  readonly x: number;
  readonly z: number;
  readonly clearance: number;
  readonly blocked: boolean;
  readonly slid: boolean;
}

const HIGH_OBSTACLE_RE =
  /bookcase|bookshelf|bookstack|wardrobe|closet|armoire|fridge|refrigerator|vending|locker|arcade|easel|shelf[-_.]?tall|tall[-_.]?shelf|cabinet[-_.]?tall|partition|screen|coffee[-_.]?cart|bus[-_.]?shelter|pergola|gazebo|colonnade|campus[-_.]?gate|fountain[-_.]?tiered|ferris|carousel|stage|minka|streetlamp|lamp[-_.]?post|traffic|utility[-_.]?box|pillar|column|tree/i;

const IGNORE_OBSTACLE_RE =
  /^(rug|carpet|mat|runner)\b|libRugWoven|awning|aircon|ceiling[-_.]?pendant|pendant|wall[-_.]?(art|clock|shelf|lamp|poster)|banker[-_.]?lamp|cash[-_.]?register|laptop|mug|teacup|saucer|notebook|books[._](stack|row)/i;

/**
 * Computes the bounded CAZ body-build radius multiplier matching `StudyPhysics.setActorHeight`
 * (`physics.ts:330`), keeping Rapier capsule queries and 2D locomotion strictly aligned.
 */
export function playerBuildRadiusScale(buildScale = 1.0): number {
  const b = Number.isFinite(buildScale) ? buildScale : 1.0;
  return Math.max(0.9, Math.min(1.1, 0.65 + 0.35 * b));
}

export function playerRadiiForBuild(buildScale = 1.0): PlayerRadii {
  const scale = playerBuildRadiusScale(buildScale);
  return {
    low: PLAYER_R_LOW * scale,
    high: PLAYER_R_HIGH * scale,
    scale,
  };
}

/**
 * Classifies an asset/kind into `'low'` (`< 0.95 m` -> `R_low = 0.20 m`),
 * `'high'` (`>= 0.95 m` -> `R_high = 0.26 m`), or `'ignore'` (rugs, tabletop items, overhead trim).
 */
export function classifyObstacleBand(
  assetOrKind: string,
  explicitTopRel?: number,
): ObstacleHeightBand {
  if (IGNORE_OBSTACLE_RE.test(assetOrKind)) return 'ignore';
  if (explicitTopRel !== undefined && Number.isFinite(explicitTopRel)) {
    if (explicitTopRel < 0.06) return 'ignore';
    return explicitTopRel >= PLAYER_HEIGHT_BAND_SPLIT ? 'high' : 'low';
  }
  if (HIGH_OBSTACLE_RE.test(assetOrKind)) return 'high';
  return 'low';
}

export const FURNITURE_TOP_Y: Readonly<Record<string, number>> = {
  'tv-console': 0.55,
};

export function estimateFurnishingTopRel(asset: string, size = 1.0): number {
  if (Object.prototype.hasOwnProperty.call(FURNITURE_TOP_Y, asset)) {
    return FURNITURE_TOP_Y[asset];
  }
  if (IGNORE_OBSTACLE_RE.test(asset)) return 0.02;
  if (HIGH_OBSTACLE_RE.test(asset)) return Math.max(1.35, size * 1.1);
  if (/bed/i.test(asset)) return 0.62;
  if (/sofa|couch|booth|armchair/i.test(asset)) return 0.86;
  if (/chair|stool|bench|pouf/i.test(asset)) return 0.84;
  if (/desk|table|counter|island|bar/i.test(asset)) return 0.82;
  return 0.78;
}

/** Half-width of the walkable center corridor inside a doorway after subtracting `rHigh`. */
export function paddedDoorHalfWidth(doorWidth = DOOR_W, rHigh = PLAYER_R_HIGH): number {
  return Math.max(0.14, doorWidth * 0.5 - rHigh);
}

/** Builds the `rHigh`-padded doorway corridor rect (closes the unpadded `0.49 m` jamb clip hole). */
export function paddedDoorCorridor(door: Door, rHigh = PLAYER_R_HIGH): Rect {
  const half = paddedDoorHalfWidth(door.width, rHigh);
  const reach = WALL * 0.5 + 0.34;
  return door.wallAlong === 'z'
    ? rect(door.x - reach, door.x + reach, door.z - half, door.z + half)
    : rect(door.x - half, door.x + half, door.z - reach, door.z + reach);
}

/**
 * Returns `true` when `p` sits inside a doorway's threshold wall-strip escape box (`±(WALL/2 + 0.34 + margin)`
 * across the wall and `±(door.width/2 + margin)` along the opening), ensuring depenetration NEVER hits `null` floor.
 */
export function inDoorThresholdEscapeZone(p: Point2D, door: Door, margin = 0.10): boolean {
  const halfAlong = door.width * 0.5 + margin;
  const halfAcross = WALL * 0.5 + 0.34 + margin;
  return door.wallAlong === 'z'
    ? Math.abs(p.x - door.x) <= halfAcross && Math.abs(p.z - door.z) <= halfAlong
    : Math.abs(p.x - door.x) <= halfAlong && Math.abs(p.z - door.z) <= halfAcross;
}

/**
 * Converts a mounted `STREET_PROPS` instance (`buildingsView.ts` / `streaming.ts`) into an exact
 * height-banded OBB collider. Overhead awnings/pendants, flat rugs, and tabletop clutter return `null`.
 */
export function createStreetPropObstacle(
  id: string,
  spec: StreetPropLikeSpec,
  x: number,
  z: number,
  floorY: number,
  rotY: number,
  callerScale: number | readonly [number, number, number] = 1.0,
  /** Optional elevation of the placement above `floorY` (e.g. lamps/registers placed on `y = 0.78 m` tables). */
  mountOffsetY = 0,
): OrientedBoxObstacle | null {
  const key = spec.key ?? id;
  if (IGNORE_OBSTACLE_RE.test(key)) return null;
  if (mountOffsetY > 1.85) return null;
  if (mountOffsetY > 0.45 && spec.naturalHeight < 0.7) return null;

  const baseS = spec.scale ?? 1.0;
  const sxIn = typeof callerScale === 'number' ? callerScale : callerScale[0];
  const syIn = typeof callerScale === 'number' ? callerScale : callerScale[1];
  const szIn = typeof callerScale === 'number' ? callerScale : callerScale[2];

  let effScaleY = baseS * syIn;
  let clampRatio = 1.0;
  if (spec.targetHeight !== undefined && spec.naturalHeight > 1e-4) {
    const maxScale = spec.targetHeight / spec.naturalHeight;
    if (effScaleY > maxScale) {
      clampRatio = maxScale / effScaleY;
      effScaleY = maxScale;
    }
  }

  const topRel = mountOffsetY + spec.naturalHeight * effScaleY;
  if (topRel < 0.06) return null;

  const footprintFactor = /cafePatio|pottedPlant|libPottedPlant|planter/i.test(key) ? 0.52 : 0.88;
  const halfW = Math.max(0.10, spec.dimensions[0] * 0.5 * baseS * sxIn * clampRatio * footprintFactor);
  const halfD = Math.max(0.10, spec.dimensions[2] * 0.5 * baseS * szIn * clampRatio * footprintFactor);
  const yaw = rotY + (spec.yawOffset ?? 0);

  return {
    id,
    x,
    z,
    halfW,
    halfD,
    rotY: yaw,
    floorY,
    topRel,
  };
}

/**
 * Extracts trunk and boulder circle colliders from `buildVegetationLayout` (`vegetationSystem.ts`).
 * Soft flowers, ferns, grasses, and low border pebbles are intentionally skipped so parks remain walkable.
 */
export function createVegetationObstacles(
  placements: readonly VegetationPlacementLike[],
  speciesById: Readonly<Record<string, VegetationSpeciesLike>>,
): CircleObstacle[] {
  const out: CircleObstacle[] = [];
  for (let i = 0; i < placements.length; i++) {
    const pl = placements[i];
    const sp = speciesById[pl.speciesId];
    if (!sp) continue;
    const sc = pl.scale > 0 ? pl.scale : 1.0;
    const h = sp.height * sc;
    if (pl.category === 'tree' || sp.category === 'tree') {
      const trunkR = Math.max(0.14, Math.min(0.36, sp.crownRadius * 0.062 * sc));
      out.push({
        id: `veg:tree:${pl.id}`,
        x: pl.x,
        z: pl.z,
        radius: trunkR,
        floorY: pl.y,
        topRel: Math.max(2.2, h),
      });
    } else if ((pl.category === 'rock' || sp.category === 'rock') && h >= 0.32) {
      out.push({
        id: `veg:rock:${pl.id}`,
        x: pl.x,
        z: pl.z,
        radius: Math.max(0.18, sp.crownRadius * 0.65 * sc),
        floorY: pl.y,
        topRel: h,
      });
    }
  }
  return out;
}

// ── Signed Distance Primitives (Zero Heap Allocation) ───────────────────────────────────────────────

/** Signed distance from point `(px, pz)` to axis-aligned rectangle `r` (`< 0` inside, `> 0` outside). */
export function sdRect(px: number, pz: number, r: Rect): number {
  const cx = (r.x0 + r.x1) * 0.5;
  const cz = (r.z0 + r.z1) * 0.5;
  const hx = (r.x1 - r.x0) * 0.5;
  const hz = (r.z1 - r.z0) * 0.5;
  const dx = Math.abs(px - cx) - hx;
  const dz = Math.abs(pz - cz) - hz;
  const outX = dx > 0 ? dx : 0;
  const outZ = dz > 0 ? dz : 0;
  return Math.hypot(outX, outZ) + Math.min(Math.max(dx, dz), 0);
}

/** Signed distance from point `(px, pz)` to an oriented box (`< 0` inside, `> 0` outside). */
export function sdOrientedBox(
  px: number,
  pz: number,
  cx: number,
  cz: number,
  halfW: number,
  halfD: number,
  rotY: number,
): number {
  const rx = px - cx;
  const rz = pz - cz;
  const s = Math.sin(rotY);
  const c = Math.cos(rotY);
  const lx = Math.abs(rx * c - rz * s) - halfW;
  const lz = Math.abs(rx * s + rz * c) - halfD;
  const outX = lx > 0 ? lx : 0;
  const outZ = lz > 0 ? lz : 0;
  return Math.hypot(outX, outZ) + Math.min(Math.max(lx, lz), 0);
}

/** Distance from point `(px, pz)` to line segment `(ax, az) -> (bx, bz)`. */
export function distPointToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const vx = bx - ax;
  const vz = bz - az;
  const lenSq = vx * vx + vz * vz;
  if (lenSq <= 1e-10) return Math.hypot(px - ax, pz - az);
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / lenSq));
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}

/** Winding-independent 2D signed distance from `(px, pz)` to triangle `(p0, p1, p2)` (`< 0` inside, `> 0` outside). */
export function sdTriangle2D(
  px: number,
  pz: number,
  p0x: number,
  p0z: number,
  p1x: number,
  p1z: number,
  p2x: number,
  p2z: number,
): number {
  const e0x = p1x - p0x, e0z = p1z - p0z;
  const e1x = p2x - p1x, e1z = p2z - p1z;
  const e2x = p0x - p2x, e2z = p0z - p2z;
  const v0x = px - p0x, v0z = pz - p0z;
  const v1x = px - p1x, v1z = pz - p1z;
  const v2x = px - p2x, v2z = pz - p2z;

  const t0 = Math.max(0, Math.min(1, (v0x * e0x + v0z * e0z) / Math.max(1e-10, e0x * e0x + e0z * e0z)));
  const t1 = Math.max(0, Math.min(1, (v1x * e1x + v1z * e1z) / Math.max(1e-10, e1x * e1x + e1z * e1z)));
  const t2 = Math.max(0, Math.min(1, (v2x * e2x + v2z * e2z) / Math.max(1e-10, e2x * e2x + e2z * e2z)));

  const pq0x = v0x - e0x * t0, pq0z = v0z - e0z * t0;
  const pq1x = v1x - e1x * t1, pq1z = v1z - e1z * t1;
  const pq2x = v2x - e2x * t2, pq2z = v2z - e2z * t2;

  const dSq = Math.min(
    pq0x * pq0x + pq0z * pq0z,
    pq1x * pq1x + pq1z * pq1z,
    pq2x * pq2x + pq2z * pq2z,
  );
  const s = Math.sign(e0x * e2z - e0z * e2x);
  if (s === 0) return Math.sqrt(dSq);
  const c0 = s * (v0x * e0z - v0z * e0x);
  const c1 = s * (v1x * e1z - v1z * e1x);
  const c2 = s * (v2x * e2z - v2z * e2x);
  return -Math.sqrt(dSq) * (Math.min(c0, c1, c2) >= 0 ? 1 : -1);
}

interface SpatialGridBucket {
  readonly obbs: OrientedBoxObstacle[];
  readonly circles: CircleObstacle[];
}

const GRID_CELL = 2.5;
function gridKey(ix: number, iz: number): number {
  return ((ix + 4096) << 14) ^ (iz + 4096);
}

const RING8: readonly [number, number][] = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
  const a = (i * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)] as [number, number];
});

export interface RoomNavigationLike {
  free(p: Point2D): boolean;
  readonly half: number;
  readonly obstacles?: readonly {
    readonly x: number;
    readonly z: number;
    readonly width: number;
    readonly depth: number;
    readonly rotation: number;
  }[];
  path?(start: Point2D, end: Point2D): Point2D[] | null;
}

export interface PlayerCollisionWorldOptions {
  readonly house: HousePlan;
  readonly city: CityPlan;
  readonly room?: RoomNavigationLike | null;
  readonly openDoors: () => ReadonlySet<string>;
  readonly ownedHomes?: () => ReadonlySet<string>;
  readonly buildScale?: number;
}

/**
 * Height-banded, continuous signed-clearance collision world for the Echo Life player.
 * Evaluates signed clearance in O(1) via a 2.5 m spatial hash grid with zero per-call allocations.
 */
export class PlayerCollisionWorld {
  readonly house: HousePlan;
  readonly city: CityPlan;
  private room: RoomNavigationLike | null;
  private readonly openDoors: () => ReadonlySet<string>;
  private ownedHomesSet = new Set<string>();
  private activeBuildings: EnterableBuilding[];
  private radii: PlayerRadii;

  private readonly staticObbs: OrientedBoxObstacle[] = [];
  private readonly staticCircles: CircleObstacle[] = [];
  private readonly extraObbs: OrientedBoxObstacle[] = [];
  private readonly extraCircles: CircleObstacle[] = [];
  private workshopBoxes: readonly WorkshopFurnitureBox[] = [];
  private readonly grid = new Map<number, SpatialGridBucket>();
  private readonly groundGrid = new Map<number, GroundRect[]>();
  private readonly housePaddedRect: Rect;
  private readonly doorMap = new Map<string, Door>();
  private readonly doorList: Door[] = [];
  private readonly liveDoors = new Map<string, DoorLeafState>();
  private parkedVehicles: ParkedVehicleCollider[] = [];

  constructor(opts: PlayerCollisionWorldOptions) {
    this.house = opts.house;
    this.city = opts.city;
    this.room = opts.room ?? null;
    this.openDoors = opts.openDoors;
    this.radii = playerRadiiForBuild(opts.buildScale ?? 1.0);
    this.housePaddedRect = rect(
      this.house.footprint.x0 - 1.5,
      this.house.footprint.x1 + 1.5,
      this.house.footprint.z0 - 1.5,
      this.house.footprint.z1 + 1.5,
    );
    if (opts.ownedHomes) {
      for (const id of opts.ownedHomes()) this.ownedHomesSet.add(id);
    }
    this.activeBuildings = this.computeActiveBuildings();
    this.indexGroundGrid();
    this.indexPlanObstacles();
    this.rebuildSpatialGrid();
  }

  private indexGroundGrid(): void {
    this.groundGrid.clear();
    const cell = 8.0;
    // Insert in reverse `city.ground` order so the first matching rect in a bucket equals `outdoorAt` last-wins priority!
    for (let i = this.city.ground.length - 1; i >= 0; i--) {
      const g = this.city.ground[i];
      const ix0 = Math.floor(g.rect.x0 / cell);
      const ix1 = Math.floor(g.rect.x1 / cell);
      const iz0 = Math.floor(g.rect.z0 / cell);
      const iz1 = Math.floor(g.rect.z1 / cell);
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const k = gridKey(ix, iz);
          let b = this.groundGrid.get(k);
          if (!b) {
            b = [];
            this.groundGrid.set(k, b);
          }
          b.push(g);
        }
      }
    }
  }

  private computeActiveBuildings(): EnterableBuilding[] {
    return [
      ...this.city.buildings,
      ...this.city.residences.filter((r) => r.property && this.ownedHomesSet.has(r.property.id)),
    ];
  }

  setRoomNavigation(room: RoomNavigationLike | null): void {
    this.room = room;
  }

  getRoomNavigation(): RoomNavigationLike | null {
    return this.room;
  }

  setBuildScale(buildScale: number): void {
    this.radii = playerRadiiForBuild(buildScale);
  }

  getRadii(): PlayerRadii {
    return this.radii;
  }

  setOwnedHomes(ids: Iterable<string>): void {
    this.ownedHomesSet = new Set(ids);
    this.activeBuildings = this.computeActiveBuildings();
  }

  /** Syncs dynamic BuildStudio / Workshop placed furniture boxes (`walk.furniture`). */
  setWorkshopFurniture(boxes: readonly WorkshopFurnitureBox[]): void {
    this.workshopBoxes = boxes;
  }

  /** Registers additional OBBs/circles (e.g. `interiorAaaProps`, `exteriorProps`, `VegetationSystem`). */
  setExtraObstacles(
    obbs: readonly OrientedBoxObstacle[],
    circles: readonly CircleObstacle[] = [],
  ): void {
    this.extraObbs.length = 0;
    this.extraCircles.length = 0;
    for (let i = 0; i < obbs.length; i++) this.extraObbs.push(obbs[i]);
    for (let i = 0; i < circles.length; i++) this.extraCircles.push(circles[i]);
    this.rebuildSpatialGrid();
  }

  setParkedVehicles(vehicles: readonly ParkedVehicleCollider[]): void {
    this.parkedVehicles = vehicles.slice();
  }

  setDoorLeafState(state: DoorLeafState): void {
    this.liveDoors.set(state.id, state);
  }

  removeDoorLeafState(id: string): void {
    this.liveDoors.delete(id);
  }

  pruneDoorLeafStates(keepIds: ReadonlySet<string>): void {
    for (const id of this.liveDoors.keys()) {
      if (!keepIds.has(id)) this.liveDoors.delete(id);
    }
  }

  clearDoorLeafStates(): void {
    this.liveDoors.clear();
  }

  private indexPlanObstacles(): void {
    this.staticObbs.length = 0;
    this.staticCircles.length = 0;
    this.doorMap.clear();
    this.doorList.length = 0;

    for (const d of this.house.doors) this.doorMap.set(d.id, d);
    for (const b of this.city.buildings) this.doorMap.set(b.door.id, b.door);
    for (const r of this.city.residences) this.doorMap.set(r.door.id, r.door);
    for (const d of this.doorMap.values()) this.doorList.push(d);

    const addRectBlock = (id: string, r: Rect, floorY: number, topRel: number) => {
      this.staticObbs.push({
        id,
        x: (r.x0 + r.x1) * 0.5,
        z: (r.z0 + r.z1) * 0.5,
        halfW: (r.x1 - r.x0) * 0.5,
        halfD: (r.z1 - r.z0) * 0.5,
        rotY: 0,
        floorY,
        topRel,
      });
    };

    // Index solid architectural wall segments (split cleanly around floor-level door/arch openings)
    // so `rHigh = 0.26..0.286 m` never jumps across `WALL = 0.16 m` partitions into adjacent rooms!
    const addWallSpan = (prefix: string, w: WallSpan, idx: number) => {
      const isAlongX = Math.abs(w.x1 - w.x0) >= Math.abs(w.z1 - w.z0);
      const spanMin = isAlongX ? w.x0 : w.z0;
      const spanMax = isAlongX ? w.x1 : w.z1;
      const fixedMid = isAlongX ? (w.z0 + w.z1) * 0.5 : (w.x0 + w.x1) * 0.5;
      const fixedHalf = Math.max(WALL * 0.5, (isAlongX ? w.z1 - w.z0 : w.x1 - w.x0) * 0.5);
      const wallTopRel = Math.max(2.4, w.y1 - w.y0);
      // Only openings reaching the floor (`bottom === undefined` or `bottom <= w.y0 + 0.35`) let a body pass!
      // Windows (`bottom >= 0.8 m`) remain solid floor-level walls!
      const passOpenings = w.openings
        .filter((op) => op.bottom === undefined || op.bottom <= w.y0 + 0.35)
        .sort((a, b) => a.from - b.from);

      if (passOpenings.length === 0) {
        this.staticObbs.push({
          id: `${prefix}:wall:${idx}`,
          x: (w.x0 + w.x1) * 0.5,
          z: (w.z0 + w.z1) * 0.5,
          halfW: Math.max(WALL * 0.5, (w.x1 - w.x0) * 0.5),
          halfD: Math.max(WALL * 0.5, (w.z1 - w.z0) * 0.5),
          rotY: 0,
          floorY: w.y0,
          topRel: wallTopRel,
        });
        return;
      }

      let cursor = spanMin;
      for (let i = 0; i < passOpenings.length; i++) {
        const op = passOpenings[i];
        if (op.from - cursor > 0.03) {
          const mid = (cursor + op.from) * 0.5;
          const half = (op.from - cursor) * 0.5;
          this.staticObbs.push({
            id: `${prefix}:wall:${idx}:s${i}`,
            x: isAlongX ? mid : fixedMid,
            z: isAlongX ? fixedMid : mid,
            halfW: isAlongX ? half : fixedHalf,
            halfD: isAlongX ? fixedHalf : half,
            rotY: 0,
            floorY: w.y0,
            topRel: wallTopRel,
          });
        }
        cursor = Math.max(cursor, op.to);
      }
      if (spanMax - cursor > 0.03) {
        const mid = (cursor + spanMax) * 0.5;
        const half = (spanMax - cursor) * 0.5;
        this.staticObbs.push({
          id: `${prefix}:wall:${idx}:end`,
          x: isAlongX ? mid : fixedMid,
          z: isAlongX ? fixedMid : mid,
          halfW: isAlongX ? half : fixedHalf,
          halfD: isAlongX ? fixedHalf : half,
          rotY: 0,
          floorY: w.y0,
          topRel: wallTopRel,
        });
      }
    };

    const h = this.house.h;
    // Study Room 3 outer non-shared walls (`+X` shared wall `x ∈ [h, hx0]` is already in `this.house.walls[0]`).
    addWallSpan('study', { x0: -h - WALL, x1: -h, z0: -h, z1: h, y0: 0, y1: UPPER_WALL_TOP, openings: [], face: 'exterior', finish: 'plaster' }, 0);
    addWallSpan('study', { x0: -h, x1: h, z0: -h - WALL, z1: -h, y0: 0, y1: UPPER_WALL_TOP, openings: [], face: 'exterior', finish: 'plaster' }, 1);
    addWallSpan('study', { x0: -h, x1: h, z0: h, z1: h + WALL, y0: 0, y1: UPPER_WALL_TOP, openings: [], face: 'interior', finish: 'plaster' }, 2);
    for (let i = 0; i < this.house.walls.length; i++) addWallSpan('house', this.house.walls[i], i);

    const addPlanFurniture = (
      prefix: string,
      list: readonly { asset: string; x: number; z: number; y: number; rotY: number; size: number; footprint: Rect | null }[],
    ) => {
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        if (!f.footprint) continue;
        const topRel = estimateFurnishingTopRel(f.asset, f.size);
        if (classifyObstacleBand(f.asset, topRel) === 'ignore') continue;
        addRectBlock(`${prefix}:${i}:${f.asset}`, f.footprint, f.y, topRel);
      }
    };

    addPlanFurniture('house:furn', this.house.furniture);
    for (let i = 0; i < this.house.blocks.length; i++) {
      const bl = this.house.blocks[i];
      const cx = (bl.rect.x0 + bl.rect.x1) * 0.5;
      const cz = (bl.rect.z0 + bl.rect.z1) * 0.5;
      const zHit = houseZoneAt(this.house, { x: cx, z: cz }, 0);
      const fy = bl.y ?? (zHit ? zoneY(zHit, cz, cx) : 0);
      addRectBlock(`house:block:${i}`, bl.rect, fy, bl.topRel ?? 0.90);
    }

    const indexBuilding = (prefix: string, b: EnterableBuilding) => {
      for (let i = 0; i < b.walls.length; i++) addWallSpan(`${prefix}:${b.id}`, b.walls[i], i);
      addPlanFurniture(`${prefix}:${b.id}:furn`, b.furniture);
      for (let i = 0; i < b.blocks.length; i++) {
        const bl = b.blocks[i];
        const cx = (bl.rect.x0 + bl.rect.x1) * 0.5;
        const cz = (bl.rect.z0 + bl.rect.z1) * 0.5;
        const zHit = buildingZoneAt([b], { x: cx, z: cz }, 0);
        const fy = bl.y ?? (zHit ? zoneY(zHit.zone, cz, cx) : b.zones[0]?.y ?? GROUND_Y);
        addRectBlock(`${prefix}:${b.id}:block:${i}`, bl.rect, fy, bl.topRel ?? 0.90);
      }
    };

    for (const b of this.city.buildings) indexBuilding('bld', b);
    for (const res of this.city.residences) indexBuilding('res', res);

    // Decorative city lot buildings: solid tall architectural volumes.
    for (const lot of this.city.lots) {
      const lotHeight = Math.max(3.4, lot.storeys * STOREY);
      addRectBlock(`lot:${lot.id}`, lot.rect, GROUND_Y, lotHeight);
    }

    // Outdoor city props (benches, trees, lamps, shelters, gazebos, fountains).
    for (let i = 0; i < this.city.props.length; i++) {
      const pr = this.city.props[i];
      if (pr.kind === 'bench') {
        this.staticObbs.push({
          id: `city:prop:${i}:bench`,
          x: pr.x,
          z: pr.z,
          halfW: 0.96,
          halfD: 0.29,
          rotY: pr.rotY ?? 0,
          floorY: GROUND_Y,
          topRel: 0.78,
        });
        continue;
      }
      if (pr.kind === 'shelter') {
        // 3 thin perimeter OBB panels (rear `localZ = -0.82` + side glass `localX = ±1.80`),
        // leaving the open front & interior cedar bench 100% walkable!
        const yaw = pr.rotY ?? 0;
        const c = Math.cos(yaw);
        const s = Math.sin(yaw);
        const addPanel = (suffix: string, lx: number, lz: number, halfW: number, halfD: number) => {
          this.staticObbs.push({
            id: `city:prop:${i}:shelter:${suffix}`,
            x: pr.x + lx * c + lz * s,
            z: pr.z - lx * s + lz * c,
            halfW,
            halfD,
            rotY: yaw,
            floorY: GROUND_Y,
            topRel: 2.45,
          });
        };
        addPanel('rear', 0, -0.82, 1.84, 0.05);
        addPanel('left', -1.80, -0.02, 0.05, 0.81);
        addPanel('right', 1.80, -0.02, 0.05, 0.81);
        continue;
      }
      if (pr.radius <= 0.01) continue;
      const tag = pr.asset ?? pr.kind;
      const isTall =
        pr.kind === 'tree' ||
        pr.kind === 'lamp' ||
        HIGH_OBSTACLE_RE.test(tag);
      this.staticCircles.push({
        id: `city:prop:${i}:${tag}`,
        x: pr.x,
        z: pr.z,
        radius: pr.radius,
        floorY: GROUND_Y,
        topRel: isTall ? 2.4 : 0.8,
      });
    }
  }

  private rebuildSpatialGrid(): void {
    this.grid.clear();
    const insertObb = (obb: OrientedBoxObstacle) => {
      const reach = Math.hypot(obb.halfW, obb.halfD) + 0.4;
      const ix0 = Math.floor((obb.x - reach) / GRID_CELL);
      const ix1 = Math.floor((obb.x + reach) / GRID_CELL);
      const iz0 = Math.floor((obb.z - reach) / GRID_CELL);
      const iz1 = Math.floor((obb.z + reach) / GRID_CELL);
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const k = gridKey(ix, iz);
          let b = this.grid.get(k);
          if (!b) {
            b = { obbs: [], circles: [] };
            this.grid.set(k, b);
          }
          b.obbs.push(obb);
        }
      }
    };
    const insertCircle = (c: CircleObstacle) => {
      const reach = c.radius + 0.4;
      const ix0 = Math.floor((c.x - reach) / GRID_CELL);
      const ix1 = Math.floor((c.x + reach) / GRID_CELL);
      const iz0 = Math.floor((c.z - reach) / GRID_CELL);
      const iz1 = Math.floor((c.z + reach) / GRID_CELL);
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const k = gridKey(ix, iz);
          let b = this.grid.get(k);
          if (!b) {
            b = { obbs: [], circles: [] };
            this.grid.set(k, b);
          }
          b.circles.push(c);
        }
      }
    };

    for (let i = 0; i < this.staticObbs.length; i++) insertObb(this.staticObbs[i]);
    for (let i = 0; i < this.extraObbs.length; i++) insertObb(this.extraObbs[i]);
    for (let i = 0; i < this.staticCircles.length; i++) insertCircle(this.staticCircles[i]);
    for (let i = 0; i < this.extraCircles.length; i++) insertCircle(this.extraCircles[i]);
  }

  private isDoorPassable(id: string, openSet: ReadonlySet<string>): boolean {
    const live = this.liveDoors.get(id);
    if (live) {
      return (
        live.phase === 'open' ||
        live.phase === 'occupied' ||
        Math.abs(live.swingAngle) >= DOOR_PASSABLE_MIN_RAD ||
        (live.isOpen && Math.abs(live.swingAngle) > 0.55)
      );
    }
    return openSet.has(id);
  }

  private isDoorThresholdSurfaceActive(
    d: Door,
    openSet: ReadonlySet<string>,
    escapeOrigin?: Point2D,
  ): boolean {
    if (this.isDoorPassable(d.id, openSet)) return true;
    const live = this.liveDoors.get(d.id);
    if (live && ((live.phase && live.phase !== 'closed') || Math.abs(live.swingAngle) > 0.04)) {
      return true;
    }
    if (escapeOrigin && inDoorThresholdEscapeZone(escapeOrigin, d, 0.10)) {
      return true;
    }
    return false;
  }

  private openDoorAt(
    doors: readonly Door[],
    p: Point2D,
    rHigh: number,
    openSet: ReadonlySet<string>,
    escapeOrigin?: Point2D,
  ): Door | null {
    for (let i = 0; i < doors.length; i++) {
      const d = doors[i];
      if (!this.isDoorThresholdSurfaceActive(d, openSet, escapeOrigin)) continue;
      if (inRect(p, paddedDoorCorridor(d, rHigh)) || (escapeOrigin && inDoorThresholdEscapeZone(p, d, 0.10))) {
        return d;
      }
    }
    return null;
  }

  private readonly surfOutA = { y: 0, region: '' };
  private readonly surfOutB = { y: 0, region: '' };
  private readonly surfPointScratch = { x: 0, z: 0 };

  private surfaceAtInto(
    px: number,
    pz: number,
    rHigh: number,
    open: ReadonlySet<string>,
    escapeOrigin: Point2D | undefined,
    out: { y: number; region: string },
  ): { y: number; region: string } | null {
    const h = this.house.h;
    const p = this.surfPointScratch;
    p.x = px;
    p.z = pz;

    if (Math.abs(px) <= h && Math.abs(pz) <= h) {
      const d = this.openDoorAt(this.house.doors, p, rHigh, open, escapeOrigin);
      out.y = d ? d.y : 0;
      out.region = d ? `door:${d.id}` : 'study';
      return out;
    }

    if (inRect(p, this.housePaddedRect)) {
      const hz = houseZoneAt(this.house, p, 0);
      if (hz) {
        out.y = zoneY(hz, pz, px);
        out.region = hz.id;
        return out;
      }
      const hd = this.openDoorAt(this.house.doors, p, rHigh, open, escapeOrigin);
      if (hd) {
        out.y = hd.y;
        out.region = `door:${hd.id}`;
        return out;
      }
      for (let i = 0; i < this.house.passages.length; i++) {
        const pass = this.house.passages[i];
        if (inRect(p, pass.rect)) {
          out.y = pass.y;
          out.region = 'arch';
          return out;
        }
      }
    }

    for (let i = 0; i < this.activeBuildings.length; i++) {
      const b = this.activeBuildings[i];
      if (px < b.rect.x0 - 1.2 || px > b.rect.x1 + 1.2 || pz < b.rect.z0 - 1.2 || pz > b.rect.z1 + 1.2) {
        continue;
      }
      if (inRect(p, b.rect)) {
        for (let zIdx = 0; zIdx < b.zones.length; zIdx++) {
          const z = b.zones[zIdx];
          if (inRect(p, z.rect)) {
            out.y = zoneY(z, pz, px);
            out.region = b.property?.id ?? b.id;
            return out;
          }
        }
      }
      if (
        this.isDoorThresholdSurfaceActive(b.door, open, escapeOrigin) &&
        (inRect(p, paddedDoorCorridor(b.door, rHigh)) || (escapeOrigin && inDoorThresholdEscapeZone(p, b.door, 0.10)))
      ) {
        out.y = b.door.y;
        out.region = `door:${b.door.id}`;
        return out;
      }
      if (inRect(p, b.rect)) {
        for (let j = 0; j < b.passages.length; j++) {
          const pass = b.passages[j];
          if (inRect(p, pass.rect)) {
            out.y = pass.y;
            out.region = b.property?.id ?? b.id;
            return out;
          }
        }
      }
    }

    if (!inRect(p, this.city.bounds)) return null;
    if (!inRect(p, this.house.footprint)) {
      const bucket = this.groundGrid.get(gridKey(Math.floor(px / 8.0), Math.floor(pz / 8.0)));
      if (bucket) {
        for (let i = 0; i < bucket.length; i++) {
          const g = bucket[i];
          if (inRect(p, g.rect)) {
            out.y = g.y;
            out.region = g.surface;
            return out;
          }
        }
      }
    }
    return null;
  }

  /**
   * Evaluates the walkable floor elevation at `p` (`null` if `p` is inside a wall, shut door, river, or unowned home).
   * Mirrors `LifeWalk.surface()` (including open room passages/arches), while enforcing `rHigh`-padded doorway corridors
   * and keeping threshold floors active whenever `phase !== 'closed'` (`|angle| > 0.04`) or escaping from inside `curr`.
   */
  surfaceAt(
    p: Point2D,
    rHighOverride?: number,
    escapeOrigin?: Point2D,
  ): { y: number; region: string } | null {
    const rHigh = rHighOverride ?? this.radii.high;
    const hit = this.surfaceAtInto(p.x, p.z, rHigh, this.openDoors(), escapeOrigin, this.surfOutA);
    return hit ? { y: hit.y, region: hit.region } : null;
  }

  groundAt(x: number, z: number): number | null {
    return this.surfaceAtInto(x, z, 0.02, this.openDoors(), undefined, this.surfOutA)?.y ?? null;
  }

  /** Signed inward distance to the `pad`-inset `city.bounds` perimeter (`>= 0` inside safe interior, `< 0` within margin). */
  boundaryClearanceAt(x: number, z: number, pad = WORLD_BOUNDARY_PADDING): number {
    const b = this.city.bounds;
    return Math.min(x - b.x0, b.x1 - x, z - b.z0, b.z1 - z) - pad;
  }

  /** Euclidean excursion outside the `pad`-inset `city.bounds` safe interior (`0` inside, `> 0` outside). */
  boundaryPenetrationAt(x: number, z: number, pad = WORLD_BOUNDARY_PADDING): number {
    const b = this.city.bounds;
    const dx = Math.max(b.x0 + pad - x, 0, x - (b.x1 - pad));
    const dz = Math.max(b.z0 + pad - z, 0, z - (b.z1 - pad));
    return Math.hypot(dx, dz);
  }

  /**
   * Projects `(dx, dz)` tangentially along the `pad`-inset `city.bounds` perimeter (`v_outward -> 0`),
   * preserving tangential speed while always admitting inward escape steps (`distToInterior(next) < distToInterior(from)`).
   */
  slideAlongBounds(
    from: Point2D,
    dx: number,
    dz: number,
    pad = WORLD_BOUNDARY_PADDING,
    out?: { x: number; z: number; clamped: boolean },
  ): { x: number; z: number; clamped: boolean } {
    const b = this.city.bounds;
    const minX = b.x0 + pad;
    const maxX = b.x1 - pad;
    const minZ = b.z0 + pad;
    const maxZ = b.z1 - pad;
    let nx = from.x + dx;
    let nz = from.z + dz;
    let clamped = false;
    if (nx < minX && dx < 0) {
      nx = from.x >= minX ? minX : from.x;
      clamped = true;
    } else if (nx > maxX && dx > 0) {
      nx = from.x <= maxX ? maxX : from.x;
      clamped = true;
    }
    if (nz < minZ && dz < 0) {
      nz = from.z >= minZ ? minZ : from.z;
      clamped = true;
    } else if (nz > maxZ && dz > 0) {
      nz = from.z <= maxZ ? maxZ : from.z;
      clamped = true;
    }
    const target = out ?? this.slideBoundsOutScratch;
    target.x = nx;
    target.z = nz;
    target.clamped = clamped;
    return target;
  }

  private readonly surfProbeScratch = { x: 0, z: 0 };
  private readonly slideOriginScratch = { x: 0, z: 0 };
  private readonly slideCandScratch = { x: 0, z: 0 };
  private readonly slideBoundsOutScratch = { x: 0, z: 0, clamped: false };

  /**
   * Computes continuous signed clearance in metres at `(x, z)`:
   * - `>= 0`: completely clear of all height-banded obstacles, walls, jambs, doors, and floor drops.
   * - `< 0`: penetration depth (`-depth`) into the tightest blocking boundary.
   */
  clearanceAt(
    x: number,
    z: number,
    buildScaleOverride?: number,
    escapeOrigin?: Point2D,
  ): number {
    const radii =
      buildScaleOverride !== undefined ? playerRadiiForBuild(buildScaleOverride) : this.radii;
    const rLow = radii.low;
    const rHigh = radii.high;
    const p = this.surfProbeScratch;
    p.x = x;
    p.z = z;
    const h = this.house.h;
    const open = this.openDoors();
    const boundPad = Math.max(WORLD_BOUNDARY_PADDING, rHigh + 0.12);

    if (!inRect(p, this.city.bounds) && (Math.abs(x) > h || Math.abs(z) > h)) {
      return -(this.boundaryPenetrationAt(x, z, boundPad) + rHigh);
    }

    const centerSurf = this.surfaceAtInto(x, z, 0.02, open, escapeOrigin, this.surfOutA);
    if (!centerSurf) {
      return -this.estimateVoidDepth(x, z, rHigh);
    }
    const hereY = centerSurf.y;
    const hereRegion = centerSurf.region;
    let minClearance = 10.0;

    // 1. Study Room interior: preserve `RoomNavigation` (`R_low = 0.20 m`) for user furniture,
    //    while enforcing `R_high` against the 4 perimeter walls and hall door jambs!
    const inStudy = Math.abs(x) <= h && Math.abs(z) <= h;
    if (inStudy) {
      const hallDoor = this.house.doors.find((d) => d.id === 'hall');
      const hallPassable = hallDoor && this.isDoorPassable(hallDoor.id, open) && inRect(p, paddedDoorCorridor(hallDoor, 0.02));
      const wallClearXPos = hallDoor && hallPassable && hallDoor.wallAlong === 'z' && hallDoor.x > 0
        ? Math.min(
            Math.hypot(x - h, z - (hallDoor.z - hallDoor.width * 0.5)) - rHigh,
            Math.hypot(x - h, z - (hallDoor.z + hallDoor.width * 0.5)) - rHigh,
          )
        : h - x - rHigh;
      const wallClearXNeg = h + x - rHigh;
      const wallClearZPos = h - z - rHigh;
      const wallClearZNeg = h + z - rHigh;
      minClearance = Math.min(minClearance, wallClearXPos, wallClearXNeg, wallClearZPos, wallClearZNeg);

      if (this.room && !hallPassable) {
        const obs = this.room.obstacles;
        if (obs) {
          for (let i = 0; i < obs.length; i++) {
            const o = obs[i];
            const cObj =
              sdOrientedBox(x, z, o.x, o.z, o.width * 0.5, o.depth * 0.5, o.rotation) - NPC_NAV_RADIUS;
            if (cObj < minClearance) minClearance = cObj;
          }
        } else if (!this.room.free(p)) {
          minClearance = Math.min(minClearance, this.estimateRoomFurnitureClearance(x, z));
        }
      }
    } else if (
      hereRegion === 'road' ||
      hereRegion === 'sidewalk' ||
      hereRegion === 'crossing' ||
      hereRegion === 'park' ||
      hereRegion === 'garden' ||
      hereRegion === 'plaza'
    ) {
      minClearance = Math.min(minClearance, this.boundaryClearanceAt(x, z, boundPad));
    }

    // 2. Cylindrical doorway jamb posts (smooth funnel normals!) + closed door planes + swung door leaves + hinge-pocket fillet.
    minClearance = Math.min(minClearance, this.doorwayClearance(x, z, hereY, rHigh, open));

    // 3. Continuous perimeter/ledge ring probe at `0.5 * rHigh` and `rHigh` (catches stair edges, balconies, river banks).
    for (let i = 0; i < RING8.length; i++) {
      const [ux, uz] = RING8[i];
      const ox = x + ux * rHigh;
      const oz = z + uz * rHigh;
      p.x = ox;
      p.z = oz;
      if (!inStudy && !inRect(p, this.city.bounds)) {
        continue;
      }
      const sOuter = this.surfaceAtInto(ox, oz, 0.02, open, escapeOrigin, this.surfOutA);
      const outerY = sOuter ? sOuter.y : NaN;
      const outerOk = sOuter !== null && Math.abs(outerY - hereY) <= PLAYER_STEP_UP;
      const hx = x + ux * rHigh * 0.5;
      const hz = z + uz * rHigh * 0.5;
      const sHalf = this.surfaceAtInto(hx, hz, 0.02, open, escapeOrigin, this.surfOutB);
      const halfOk = sHalf !== null && Math.abs(sHalf.y - hereY) <= PLAYER_STEP_UP;
      if (!halfOk || !outerOk) {
        let lo = 0;
        let hi = !halfOk ? rHigh * 0.5 : rHigh;
        for (let b = 0; b < 5; b++) {
          const mid = (lo + hi) * 0.5;
          const sm = this.surfaceAtInto(x + ux * mid, z + uz * mid, 0.02, open, escapeOrigin, this.surfOutB);
          if (sm && Math.abs(sm.y - hereY) <= PLAYER_STEP_UP) lo = mid;
          else hi = mid;
        }
        minClearance = Math.min(minClearance, lo - rHigh);
      }
    }

    // 4. Dynamic Workshop / BuildStudio furniture boxes (`topRel = 2 * hy`).
    for (let i = 0; i < this.workshopBoxes.length; i++) {
      const wb = this.workshopBoxes[i];
      const floorY = wb.y - wb.hy;
      if (Math.abs(hereY - floorY) >= 0.5) continue;
      const topRel = wb.hy * 2;
      const reqR = topRel >= PLAYER_HEIGHT_BAND_SPLIT ? rHigh : rLow;
      const c = sdOrientedBox(x, z, wb.x, wb.z, wb.hx, wb.hz, 0) - reqR;
      if (c < minClearance) minClearance = c;
    }

    // 5. Spatial-grid OBBs and Circles (height-banded: `topRel >= 0.95 m` -> `rHigh`, `< 0.95 m` -> `rLow`).
    const ix = Math.floor(x / GRID_CELL);
    const iz = Math.floor(z / GRID_CELL);
    const bucket = this.grid.get(gridKey(ix, iz));
    if (bucket) {
      const obbs = bucket.obbs;
      for (let i = 0; i < obbs.length; i++) {
        const obb = obbs[i];
        if (hereY > obb.floorY + obb.topRel + 0.15 || hereY + 1.75 < obb.floorY - 0.15) continue;
        const reqR = obb.topRel >= PLAYER_HEIGHT_BAND_SPLIT ? rHigh : rLow;
        const sd = sdOrientedBox(x, z, obb.x, obb.z, obb.halfW, obb.halfD, obb.rotY);
        const c = sd - reqR;
        if (c < minClearance) minClearance = c;
      }
      const circles = bucket.circles;
      for (let i = 0; i < circles.length; i++) {
        const ci = circles[i];
        if (hereY > ci.floorY + ci.topRel + 0.15 || hereY + 1.75 < ci.floorY - 0.15) continue;
        const reqR = ci.topRel >= PLAYER_HEIGHT_BAND_SPLIT ? rHigh : rLow;
        const c = Math.hypot(x - ci.x, z - ci.z) - (ci.radius + reqR);
        if (c < minClearance) minClearance = c;
      }
    }

    // 6. Live parked vehicles (`R_high` for cars/vans, `R_low` for low scooters/bikes `< 0.95 m`).
    for (let i = 0; i < this.parkedVehicles.length; i++) {
      const pv = this.parkedVehicles[i];
      const pvFloor = pv.floorY ?? GROUND_Y;
      const pvTop = pv.topRel ?? 1.35;
      if (Math.abs(hereY - pvFloor) > 0.85) continue;
      const reqR = pvTop >= PLAYER_HEIGHT_BAND_SPLIT ? rHigh : rLow;
      const c = sdOrientedBox(x, z, pv.x, pv.z, pv.halfWidth, pv.halfLength, pv.yaw) - reqR;
      if (c < minClearance) minClearance = c;
    }

    return minClearance;
  }

  private doorwayClearance(
    x: number,
    z: number,
    hereY: number,
    rHigh: number,
    openSet: ReadonlySet<string>,
  ): number {
    let minC = 10.0;
    for (let dIdx = 0; dIdx < this.doorList.length; dIdx++) {
      const d = this.doorList[dIdx];
      const dx = x - d.x;
      const dz = z - d.z;
      if (Math.abs(dx) > 1.8 || Math.abs(dz) > 1.8) continue;
      if (Math.abs(hereY - d.y) > 0.65) continue;

      const hw = d.width * 0.5;
      const jAx = d.wallAlong === 'x' ? d.x - hw : d.x;
      const jAz = d.wallAlong === 'z' ? d.z - hw : d.z;
      const jBx = d.wallAlong === 'x' ? d.x + hw : d.x;
      const jBz = d.wallAlong === 'z' ? d.z + hw : d.z;

      if (this.isDoorPassable(d.id, openSet)) {
        const cA = Math.hypot(x - jAx, z - jAz) - rHigh;
        const cB = Math.hypot(x - jBx, z - jBz) - rHigh;
        if (cA < minC) minC = cA;
        if (cB < minC) minC = cB;
      } else {
        const segC = distPointToSegment(x, z, jAx, jAz, jBx, jBz) - (WALL * 0.5 + rHigh);
        if (segC < minC) minC = segC;
      }

      const live = this.liveDoors.get(d.id);
      if (live && Math.abs(live.swingAngle) > 0.04) {
        const tipX = live.hingeX + Math.cos(live.worldLeafYaw) * live.width;
        const tipZ = live.hingeZ + Math.sin(live.worldLeafYaw) * live.width;
        const leafPad = 0.025 + rHigh * 0.85;
        let leafC: number;
        if (Math.abs(live.swingAngle) > 0.35) {
          // Hinge-corner V-pocket convex fillet: fills the acute wedge behind the swung leaf against the adjacent wall
          // so `slideStep` glides tangentially around `Tip` and NEVER enters or wedges in the hinge pocket!
          const distA = Math.hypot(live.hingeX - jAx, live.hingeZ - jAz);
          const distB = Math.hypot(live.hingeX - jBx, live.hingeZ - jBz);
          const hJx = distA <= distB ? jAx : jBx;
          const hJz = distA <= distB ? jAz : jBz;
          const oJx = distA <= distB ? jBx : jAx;
          const oJz = distA <= distB ? jBz : jAz;
          const invSpan = 1 / Math.max(0.2, Math.hypot(hJx - oJx, hJz - oJz));
          const wallOutX = (hJx - oJx) * invSpan;
          const wallOutZ = (hJz - oJz) * invSpan;
          const anchorX = live.hingeX + wallOutX * 0.36;
          const anchorZ = live.hingeZ + wallOutZ * 0.36;
          leafC = sdTriangle2D(x, z, live.hingeX, live.hingeZ, tipX, tipZ, anchorX, anchorZ) - leafPad;
        } else {
          leafC = distPointToSegment(x, z, live.hingeX, live.hingeZ, tipX, tipZ) - leafPad;
        }
        if (leafC < minC) minC = leafC;
      }
    }
    return minC;
  }

  private estimateRoomFurnitureClearance(x: number, z: number): number {
    if (!this.room) return 0;
    for (let dist = 0.02; dist <= 0.32; dist += 0.02) {
      for (let i = 0; i < RING8.length; i++) {
        if (this.room.free({ x: x + RING8[i][0] * dist, z: z + RING8[i][1] * dist })) {
          return -dist;
        }
      }
    }
    return -0.35;
  }

  private estimateVoidDepth(x: number, z: number, rHigh: number): number {
    for (let dist = 0.04; dist <= 0.64; dist += 0.06) {
      for (let i = 0; i < RING8.length; i++) {
        if (this.surfaceAt({ x: x + RING8[i][0] * dist, z: z + RING8[i][1] * dist }, 0.02)) {
          return dist + rHigh;
        }
      }
    }
    return 1.0 + rHigh;
  }

  /** Strict boolean check (`clearanceAt >= 0`) used for spawn/seat validation. */
  isFree(p: Point2D, buildScaleOverride?: number): boolean {
    return this.clearanceAt(p.x, p.z, buildScaleOverride) >= 0;
  }

  /**
   * Depenetration-permissive substep predicate (`review_embodiment_arch.md` §2.3.3):
   * Admits `next` when `next` is completely free (`cNext >= 0`) OR when `cNext >= cCurr - 1e-4`
   * on a continuous floor surface (`|yNext - yCurr| <= PLAYER_STEP_UP`).
   */
  canStep(curr: Point2D, next: Point2D, currClearance?: number, buildScaleOverride?: number): boolean {
    const radii =
      buildScaleOverride !== undefined ? playerRadiiForBuild(buildScaleOverride) : this.radii;
    const boundPad = Math.max(WORLD_BOUNDARY_PADDING, radii.high + 0.12);
    const open = this.openDoors();
    const sCurr = this.surfaceAtInto(curr.x, curr.z, 0.02, open, curr, this.surfOutA);
    const currY = sCurr ? sCurr.y : NaN;
    let sNext = this.surfaceAtInto(next.x, next.z, 0.02, open, curr, this.surfOutB);
    if (!sNext) {
      // Escape-Gradient Guarantee: if `curr` started outside `city.bounds`, admit any step moving strictly inward toward valid ground.
      const penCurr = this.boundaryPenetrationAt(curr.x, curr.z, boundPad);
      const penNext = this.boundaryPenetrationAt(next.x, next.z, boundPad);
      if (penCurr > 0 && penNext < penCurr - 1e-5) {
        const b = this.city.bounds;
        const cx = Math.max(b.x0 + 0.05, Math.min(b.x1 - 0.05, next.x));
        const cz = Math.max(b.z0 + 0.05, Math.min(b.z1 - 0.05, next.z));
        sNext = this.surfaceAtInto(cx, cz, 0.02, open, curr, this.surfOutB);
        if (!sNext) return false;
      } else {
        return false;
      }
    }
    if (sCurr !== null && Math.abs(sNext.y - currY) > PLAYER_STEP_UP) return false;

    // Never allow wall-band depenetration to step into Study Room furniture when `curr` was clear of that furniture!
    const h = this.house.h;
    if (
      this.room &&
      Math.abs(next.x) <= h &&
      Math.abs(next.z) <= h &&
      !sNext.region.startsWith('door:') &&
      this.room.free(curr) &&
      !this.room.free(next)
    ) {
      return false;
    }

    const cNext = this.clearanceAt(next.x, next.z, buildScaleOverride, curr);
    if (cNext >= 0) return true;
    const cCurr = currClearance ?? this.clearanceAt(curr.x, curr.z, buildScaleOverride, curr);
    return cNext >= cCurr - PLAYER_CLEARANCE_EPS;
  }

  /**
   * Swept player slide with depenetration-permissive admission and continuous SDF gradient tangent slide.
   * Smoothly funnels into open doorways, glides along world bounds, and escapes tight starts (`<= 8` zero-GC substeps).
   */
  slideStep(from: Point2D, dx: number, dz: number, maxSubstep = 0.035): SlideStepResult {
    const dist = Math.hypot(dx, dz);
    if (dist <= 1e-8) {
      return {
        x: from.x,
        z: from.z,
        clearance: this.clearanceAt(from.x, from.z, undefined, from),
        blocked: false,
        slid: false,
      };
    }

    const boundPad = Math.max(WORLD_BOUNDARY_PADDING, this.radii.high + 0.12);
    const steps = Math.min(8, Math.max(1, Math.ceil(dist / maxSubstep)));
    const sx = dx / steps;
    const sz = dz / steps;
    let px = from.x;
    let pz = from.z;
    const origin = this.slideOriginScratch;
    const cand = this.slideCandScratch;
    origin.x = px;
    origin.z = pz;
    let cCurr = this.clearanceAt(px, pz, undefined, origin);
    let blocked = false;
    let slid = false;

    for (let i = 0; i < steps; i++) {
      origin.x = px;
      origin.z = pz;
      cand.x = px + sx;
      cand.z = pz + sz;
      if (this.canStep(origin, cand, cCurr)) {
        px = cand.x;
        pz = cand.z;
        origin.x = px;
        origin.z = pz;
        cCurr = this.clearanceAt(px, pz, undefined, origin);
        continue;
      }

      blocked = true;
      let moved = false;

      // Fast O(1) tangential slide along `city.bounds` soft perimeter (`v_outward -> 0`).
      const bSlide = this.slideAlongBounds(origin, sx, sz, boundPad);
      if (bSlide.clamped) {
        cand.x = bSlide.x;
        cand.z = bSlide.z;
        if (Math.hypot(cand.x - px, cand.z - pz) > 1e-7 && this.canStep(origin, cand, cCurr)) {
          px = cand.x;
          pz = cand.z;
          origin.x = px;
          origin.z = pz;
          cCurr = this.clearanceAt(px, pz, undefined, origin);
          slid = true;
          moved = true;
        }
      }

      if (!moved) {
        const eps = 0.015;
        const gx =
          this.clearanceAt(px + eps, pz, undefined, origin) -
          this.clearanceAt(px - eps, pz, undefined, origin);
        const gz =
          this.clearanceAt(px, pz + eps, undefined, origin) -
          this.clearanceAt(px, pz - eps, undefined, origin);
        const gLen = Math.hypot(gx, gz);

        if (gLen > 1e-6) {
          const nrmX = gx / gLen;
          const nrmZ = gz / gLen;
          const into = sx * nrmX + sz * nrmZ;
          const pushOut = cCurr < 0 ? Math.min(0.012, -cCurr * 0.5) : 0;
          const tx = (into < 0 ? sx - into * nrmX : sx) + nrmX * pushOut;
          const tz = (into < 0 ? sz - into * nrmZ : sz) + nrmZ * pushOut;
          cand.x = px + tx;
          cand.z = pz + tz;
          if (Math.hypot(tx, tz) > 1e-6 && this.canStep(origin, cand, cCurr)) {
            px = cand.x;
            pz = cand.z;
            origin.x = px;
            origin.z = pz;
            cCurr = this.clearanceAt(px, pz, undefined, origin);
            slid = true;
            moved = true;
          }
        }
      }

      if (!moved) {
        cand.x = px + sx;
        cand.z = pz;
        if (Math.abs(sx) > 1e-7 && this.canStep(origin, cand, cCurr)) {
          px = cand.x;
          origin.x = px;
          origin.z = pz;
          cCurr = this.clearanceAt(px, pz, undefined, origin);
          slid = true;
          moved = true;
        } else {
          cand.x = px;
          cand.z = pz + sz;
          if (Math.abs(sz) > 1e-7 && this.canStep(origin, cand, cCurr)) {
            pz = cand.z;
            origin.x = px;
            origin.z = pz;
            cCurr = this.clearanceAt(px, pz, undefined, origin);
            slid = true;
            moved = true;
          }
        }
      }

      if (!moved) break;
    }

    return { x: px, z: pz, clearance: cCurr, blocked, slid };
  }
}

function canReachExitInRoom(
  world: PlayerCollisionWorld,
  start: Point2D,
  goal: Point2D,
  bounds: Rect,
  buildScale?: number,
): boolean {
  if (Math.hypot(goal.x - start.x, goal.z - start.z) <= 0.34) return true;
  const step = 0.16;
  const x0 = bounds.x0 - 0.5;
  const z0 = bounds.z0 - 0.5;
  const nx = Math.max(4, Math.ceil((bounds.x1 + 0.5 - x0) / step));
  const nz = Math.max(4, Math.ceil((bounds.z1 + 0.5 - z0) / step));
  if (nx * nz > 36000) return true;

  const sx = Math.max(0, Math.min(nx - 1, Math.round((start.x - x0) / step)));
  const sz = Math.max(0, Math.min(nz - 1, Math.round((start.z - z0) / step)));
  const gx = Math.max(0, Math.min(nx - 1, Math.round((goal.x - x0) / step)));
  const gz = Math.max(0, Math.min(nz - 1, Math.round((goal.z - z0) / step)));

  const visited = new Uint8Array(nx * nz);
  const qx = new Int16Array(nx * nz);
  const qz = new Int16Array(nx * nz);
  let head = 0;
  let tail = 0;
  visited[sz * nx + sx] = 1;
  qx[tail] = sx;
  qz[tail] = sz;
  tail++;

  while (head < tail) {
    const ix = qx[head];
    const iz = qz[head];
    head++;
    if (Math.abs(ix - gx) <= 1 && Math.abs(iz - gz) <= 1) return true;
    const pCurr = head === 1 ? start : { x: x0 + ix * step, z: z0 + iz * step };
    const cCurr = world.clearanceAt(pCurr.x, pCurr.z, buildScale);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue;
        const ax = ix + dx;
        const az = iz + dz;
        if (ax < 0 || az < 0 || ax >= nx || az >= nz) continue;
        const idx = az * nx + ax;
        if (visited[idx]) continue;
        const pNext = { x: x0 + ax * step, z: z0 + az * step };
        // Require >= 6 cm steering margin on transit cells so players never have to thread sub-10cm furniture cracks.
        if (world.clearanceAt(pNext.x, pNext.z, buildScale) < 0.06) continue;
        if (!world.canStep(pCurr, pNext, cCurr, buildScale)) continue;
        if (dx !== 0 && dz !== 0) {
          if (
            world.clearanceAt(pNext.x, pCurr.z, buildScale) < 0.05 ||
            world.clearanceAt(pCurr.x, pNext.z, buildScale) < 0.05 ||
            !world.canStep(pCurr, { x: pNext.x, z: pCurr.z }, cCurr, buildScale) ||
            !world.canStep(pCurr, { x: pCurr.x, z: pNext.z }, cCurr, buildScale)
          ) {
            continue;
          }
        }
        visited[idx] = 1;
        qx[tail] = ax;
        qz[tail] = az;
        tail++;
      }
    }
  }
  return false;
}

/**
 * Load-time / stand-up / dismount position sanitizer (`review_embodiment_arch.md` §2.3.4):
 * If `pos` is already completely free (`clearance >= 0`) and exit-connected, returns `pos` untouched.
 * Otherwise searches concentric radial rings up to `maxSearchRadius` (`0.85 m` default) on the same
 * elevation band without crossing solid room walls, falling back to `fallback` or room exit if inside a sealed pocket.
 */
export function sanitizePlayerPosition(
  world: PlayerCollisionWorld,
  pos: Point2D,
  opts?: {
    maxSearchRadius?: number;
    fallback?: Point2D;
    referenceY?: number;
    buildScale?: number;
  },
): SanitizeResult {
  const maxR = opts?.maxSearchRadius ?? 0.85;
  const c0 = world.clearanceAt(pos.x, pos.z, opts?.buildScale);
  const s0 = world.surfaceAt(pos, 0.02);
  const refY = opts?.referenceY ?? s0?.y ?? 0;
  const h = world.house.h;
  const startedInStudy = Math.abs(pos.x) <= h + 0.05 && Math.abs(pos.z) <= h + 0.05;
  const hallDoor = world.house.doors.find((d) => d.id === 'hall');
  const frontDoor = world.house.doors.find((d) => d.id === 'entrance');

  // Identify indoor room exit anchor & bounds across Study, Starter House, and Enterable Buildings
  // so sealed corner/counter/stair pockets are automatically escaped and wall-hopping is prevented.
  let exitGoal: Point2D | null = null;
  let exitBounds: Rect | null = null;
  if (startedInStudy && hallDoor) {
    const hallPassable = world.surfaceAt({ x: hallDoor.x, z: hallDoor.z }, 0.02)?.region.startsWith('door:') ?? false;
    exitGoal = hallPassable ? { x: hallDoor.x + 0.45, z: hallDoor.z } : { x: h - 0.30, z: hallDoor.z };
    exitBounds = rect(-h, hallDoor.x + 0.8, -h, h);
  } else if (inRect(pos, world.house.footprint)) {
    if (refY > -1.5 && hallDoor) {
      exitGoal = { x: hallDoor.x + 0.6, z: hallDoor.z };
      exitBounds = world.house.footprint;
    } else if (frontDoor) {
      exitGoal = { x: frontDoor.x, z: world.house.front + 1.2 };
      exitBounds = rect(
        world.house.footprint.x0,
        world.house.footprint.x1,
        world.house.footprint.z0,
        world.house.front + 2.0,
      );
    }
  } else {
    const allBlds = [...world.city.buildings, ...world.city.residences];
    for (let i = 0; i < allBlds.length; i++) {
      const b = allBlds[i];
      if (inRect(pos, b.rect)) {
        exitGoal = b.outsidePoint;
        exitBounds = rect(
          Math.min(b.rect.x0, b.outsidePoint.x) - 1.0,
          Math.max(b.rect.x1, b.outsidePoint.x) + 1.0,
          Math.min(b.rect.z0, b.outsidePoint.z) - 1.0,
          Math.max(b.rect.z1, b.outsidePoint.z) + 1.0,
        );
        break;
      }
    }
  }

  const isExitReachable = (cand: Point2D): boolean => {
    if (!exitGoal || !exitBounds) return true;
    return canReachExitInRoom(world, cand, exitGoal, exitBounds, opts?.buildScale);
  };

  if (c0 >= 0 && s0 && Math.abs(s0.y - refY) <= 0.4 && isExitReachable(pos)) {
    return { x: pos.x, z: pos.z, y: s0.y, clearance: c0, sanitized: false };
  }

  let bestImproved: SanitizeResult | null = null;

  for (let r = 0.05; r <= maxR + 1e-6; r += 0.05) {
    const samples = r < 0.25 ? 16 : 24;
    for (let i = 0; i < samples; i++) {
      const a = (i * Math.PI * 2) / samples;
      const cx = pos.x + Math.cos(a) * r;
      const cz = pos.z + Math.sin(a) * r;
      if (startedInStudy && (Math.abs(cx) > h || Math.abs(cz) > h)) {
        const sCheck = world.surfaceAt({ x: cx, z: cz }, 0.02);
        if (!sCheck || !sCheck.region.startsWith('door:')) continue;
      }
      const surf = world.surfaceAt({ x: cx, z: cz }, 0.02);
      if (!surf || Math.abs(surf.y - refY) > 0.36) continue;

      const c = world.clearanceAt(cx, cz, opts?.buildScale);
      if (c >= 0 && isExitReachable({ x: cx, z: cz })) {
        return { x: cx, z: cz, y: surf.y, clearance: c, sanitized: true };
      }
      if ((!bestImproved || c > bestImproved.clearance) && isExitReachable({ x: cx, z: cz })) {
        bestImproved = { x: cx, z: cz, y: surf.y, clearance: c, sanitized: true };
      }
    }
  }

  if (opts?.fallback) {
    const sf = world.surfaceAt(opts.fallback, 0.02);
    const cf = world.clearanceAt(opts.fallback.x, opts.fallback.z, opts?.buildScale);
    if (sf && cf >= 0 && isExitReachable(opts.fallback)) {
      return { x: opts.fallback.x, z: opts.fallback.z, y: sf.y, clearance: cf, sanitized: true };
    }
  }

  if (bestImproved && bestImproved.clearance > c0 + 1e-3) {
    return bestImproved;
  }

  const safeDefault: Point2D = startedInStudy
    ? exitGoal ?? { x: 0, z: hallDoor ? hallDoor.z : 0 }
    : exitGoal ?? { x: world.house.doors.find((d) => d.id === 'entrance')?.x ?? 0, z: world.house.front + 1.4 };
  const sDef = world.surfaceAt(safeDefault, 0.02);
  return {
    x: safeDefault.x,
    z: safeDefault.z,
    y: sDef?.y ?? refY,
    clearance: world.clearanceAt(safeDefault.x, safeDefault.z, opts?.buildScale),
    sanitized: true,
  };
}

// ── Fixed-60Hz Simulation Accumulator + Render Interpolation + Vertical Spring ───────────────────────

export function shortestArcAngleDelta(fromRad: number, toRad: number): number {
  let d = (toRad - fromRad) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function lerpAngleShortest(fromRad: number, toRad: number, alpha: number): number {
  return fromRad + shortestArcAngleDelta(fromRad, toRad) * alpha;
}

/**
 * Exact analytical 1D critically damped spring step (`x'' = omega^2*(target - x) - 2*omega*x'`).
 * Unconditionally stable for any `dt > 0` with zero overshoot.
 */
export function stepCriticallyDamped1D(
  curr: number,
  vel: number,
  target: number,
  omega: number,
  dt: number,
  out: { value: number; velocity: number },
): void {
  if (dt <= 0 || omega <= 0) {
    out.value = curr;
    out.velocity = vel;
    return;
  }
  const err = curr - target;
  const exp = Math.exp(-omega * dt);
  const temp = (vel + omega * err) * dt;
  out.value = target + (err + temp) * exp;
  out.velocity = (vel - omega * temp) * exp;
}

/**
 * Smooth vertical floor tracker replacing the discontinuous `Math.abs(dyFloor) > 0.012` switch
 * (`character.ts:1340`) and hard `walkTo` snap (`character.ts:1651`).
 */
export class VerticalElevationSpring {
  y = 0;
  vy = 0;
  slopeLeanPitch = 0;
  private readonly scratch = { value: 0, velocity: 0 };

  reset(y: number): void {
    this.y = y;
    this.vy = 0;
    this.slopeLeanPitch = 0;
  }

  step(floorY: number, dt: number, omega = 24, maxStepHeight = 0.55): number {
    const dy = floorY - this.y;
    if (Math.abs(dy) >= maxStepHeight) {
      this.reset(floorY);
      return this.y;
    }
    if (Math.abs(dy) < 2e-4 && Math.abs(this.vy) < 5e-3) {
      this.y = floorY;
      this.vy = 0;
    } else {
      stepCriticallyDamped1D(this.y, this.vy, floorY, omega, dt, this.scratch);
      this.y = this.scratch.value;
      this.vy = this.scratch.velocity;
    }
    const targetLean = Math.max(-0.045, Math.min(0.08, dy * 0.28));
    this.slopeLeanPitch += (targetLean - this.slopeLeanPitch) * (1 - Math.exp(-10 * Math.max(0, dt)));
    return this.y;
  }
}

export interface InterpolatedPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  alpha: number;
  ticksRun: number;
}

/**
 * Fixed-60Hz locomotion accumulator with render-frame pose interpolation (`alpha = acc / FIXED_DT`).
 * Writes interpolated root pose BEFORE `Character.update` and `HumanRig.update` so `weightOver`
 * sees smooth frame-to-frame velocity at 60/120/144/180 Hz without spike quantization.
 */
export class FixedStepLocomotionAccumulator {
  readonly fixedDt: number;
  readonly maxSubsteps: number;
  private accumulator = 0;

  prevX = 0;
  prevY = 0;
  prevZ = 0;
  prevYaw = 0;

  currX = 0;
  currY = 0;
  currZ = 0;
  currYaw = 0;

  readonly rendered: InterpolatedPose = {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    alpha: 0,
    ticksRun: 0,
  };

  constructor(fixedDt = FIXED_LOCOMOTION_DT, maxSubsteps = MAX_FIXED_STEPS_PER_FRAME) {
    this.fixedDt = fixedDt;
    this.maxSubsteps = maxSubsteps;
  }

  snap(x: number, y: number, z: number, yaw: number): void {
    this.accumulator = 0;
    this.prevX = this.currX = this.rendered.x = x;
    this.prevY = this.currY = this.rendered.y = y;
    this.prevZ = this.currZ = this.rendered.z = z;
    this.prevYaw = this.currYaw = this.rendered.yaw = yaw;
    this.rendered.alpha = 1;
    this.rendered.ticksRun = 0;
  }

  /**
   * Preserves `HumanRig.taken` (`resolveRoot` balance steps) across fixed ticks so physical arm
   * contacts and rendered root never diverge (`review_embodiment_arch.md` C8).
   */
  applyExternalRootDelta(dx: number, dy: number, dz: number): void {
    this.prevX += dx;
    this.prevY += dy;
    this.prevZ += dz;
    this.currX += dx;
    this.currY += dy;
    this.currZ += dz;
    this.rendered.x += dx;
    this.rendered.y += dy;
    this.rendered.z += dz;
  }

  advance(
    rawDt: number,
    stepFn: (dt: number, state: { x: number; y: number; z: number; yaw: number }) => void,
  ): InterpolatedPose {
    const clampedDt = Math.max(0, Math.min(rawDt, this.fixedDt * this.maxSubsteps));
    this.accumulator = Math.min(this.accumulator + clampedDt, this.fixedDt * this.maxSubsteps);

    let ticks = 0;
    const scratch = {
      x: this.currX,
      y: this.currY,
      z: this.currZ,
      yaw: this.currYaw,
    };

    while (this.accumulator >= this.fixedDt && ticks < this.maxSubsteps) {
      this.prevX = this.currX;
      this.prevY = this.currY;
      this.prevZ = this.currZ;
      this.prevYaw = this.currYaw;

      scratch.x = this.currX;
      scratch.y = this.currY;
      scratch.z = this.currZ;
      scratch.yaw = this.currYaw;
      stepFn(this.fixedDt, scratch);

      this.currX = scratch.x;
      this.currY = scratch.y;
      this.currZ = scratch.z;
      this.currYaw = scratch.yaw;

      this.accumulator -= this.fixedDt;
      ticks++;
    }

    const alpha = Math.max(0, Math.min(1, this.accumulator / this.fixedDt));
    this.rendered.x = this.prevX + (this.currX - this.prevX) * alpha;
    this.rendered.y = this.prevY + (this.currY - this.prevY) * alpha;
    this.rendered.z = this.prevZ + (this.currZ - this.prevZ) * alpha;
    this.rendered.yaw = lerpAngleShortest(this.prevYaw, this.currYaw, alpha);
    this.rendered.alpha = alpha;
    this.rendered.ticksRun = ticks;
    return this.rendered;
  }
}
