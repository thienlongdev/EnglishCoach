/**
 * Echo Life — one answer to "may the body stand here, how high is the floor, and which of the 31 zones am I in":
 * the study room's own navigation inside the room (furniture included), the 10-zone house beyond its walls,
 * all 13 enterable city buildings (including multi-floor stairs and upper galleries), and the entire connected
 * 31-zone city outside. The legs move in 3.5 cm steps (`walkSlide`), so walls and closed doors can never be crossed.
 */
import {
  BODY_RADIUS,
  GROUND_Y,
  PLAYER_HEIGHT_BAND_SPLIT,
  PLAYER_R_HIGH,
  PLAYER_R_LOW,
  WALL,
  doorAt,
  doorCenterCorridor,
  houseZoneAt,
  inRect,
  zoneY,
  type Block,
  type Door,
  type Furnishing,
  type HousePlan,
  type Rect,
  type Stair,
} from './plan';
import { type CityPlan, type GroundRect, type Prop } from './city';
import { buildingDoorAt, buildingZoneAt } from './buildings';
import type { V3ZoneId } from './zones';

export interface Place { y: number; region: string; zone: V3ZoneId }
export interface FootSupportSample {
  y: number;
  nx: number;
  ny: number;
  nz: number;
  onStair: boolean;
}
type P = { x: number; z: number };

const RING = Array.from({ length: 8 }, (_, i) => [Math.cos(i * Math.PI / 4), Math.sin(i * Math.PI / 4)] as const);

const TALL_ASSET_RE =
  /bookcase|bookshelf|bookstack|wardrobe|closet|armoire|fridge|refrigerator|vending|locker|arcade|easel|display-cabinet|garment-rack|shelter|gazebo|colonnade|campus-gate|fountain-tiered|ferris|carousel|stage|minka|lamp|tree/i;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep01(t: number): number {
  const u = clamp01(t);
  return u * u * (3 - 2 * u);
}

function sdRect2D(px: number, pz: number, r: Rect): number {
  const cx = (r.x0 + r.x1) * 0.5;
  const cz = (r.z0 + r.z1) * 0.5;
  const hx = (r.x1 - r.x0) * 0.5;
  const hz = (r.z1 - r.z0) * 0.5;
  const dx = Math.abs(px - cx) - hx;
  const dz = Math.abs(pz - cz) - hz;
  const ox = dx > 0 ? dx : 0;
  const oz = dz > 0 ? dz : 0;
  return Math.hypot(ox, oz) + Math.min(Math.max(dx, dz), 0);
}

function sdOrientedBox2D(
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
  const ox = lx > 0 ? lx : 0;
  const oz = lz > 0 ? lz : 0;
  return Math.hypot(ox, oz) + Math.min(Math.max(lx, lz), 0);
}

function sdShelterPerimeter2D(px: number, pz: number, sx: number, sz: number, yaw: number): number {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const rear = sdOrientedBox2D(px, pz, sx - 0.82 * s, sz - 0.82 * c, 1.84, 0.05, yaw);
  const left = sdOrientedBox2D(px, pz, sx - 1.80 * c - 0.02 * s, sz + 1.80 * s - 0.02 * c, 0.05, 0.81, yaw);
  const right = sdOrientedBox2D(px, pz, sx + 1.80 * c - 0.02 * s, sz - 1.80 * s - 0.02 * c, 0.05, 0.81, yaw);
  return Math.min(rear, left, right);
}

function distToDoorSegment2D(p: P, d: Door): number {
  const hw = d.width * 0.5;
  const ax = d.wallAlong === 'x' ? d.x - hw : d.x;
  const az = d.wallAlong === 'z' ? d.z - hw : d.z;
  const bx = d.wallAlong === 'x' ? d.x + hw : d.x;
  const bz = d.wallAlong === 'z' ? d.z + hw : d.z;
  const vx = bx - ax;
  const vz = bz - az;
  const lenSq = vx * vx + vz * vz;
  if (lenSq <= 1e-10) return Math.hypot(p.x - ax, p.z - az);
  const t = Math.max(0, Math.min(1, ((p.x - ax) * vx + (p.z - az) * vz) / lenSq));
  return Math.hypot(p.x - (ax + vx * t), p.z - (az + vz * t));
}

function inDoorEscapeBox(p: P, d: Door, margin = 0.10): boolean {
  const halfAlong = d.width * 0.5 + margin;
  const halfAcross = WALL * 0.5 + 0.34 + margin;
  return d.wallAlong === 'z'
    ? Math.abs(p.x - d.x) <= halfAcross && Math.abs(p.z - d.z) <= halfAlong
    : Math.abs(p.x - d.x) <= halfAlong && Math.abs(p.z - d.z) <= halfAcross;
}

function buildRadiusScale(buildScale = 1.0): number {
  const b = Number.isFinite(buildScale) ? buildScale : 1.0;
  return Math.max(0.9, Math.min(1.1, 0.65 + 0.35 * b));
}

function furnishingTopRel(f: Furnishing): number {
  if (f.asset === 'tv-console') return 0.55;
  if (TALL_ASSET_RE.test(f.asset)) return Math.max(1.35, f.size * 1.1);
  return 0.84;
}

// Sample only the features overlapping this eight-metre square. Arrays preserve plan order
// so a crossing or a pavement on top of a road wins exactly as in outdoorAt().
class WalkGrid<T> {
  private cells = new Map<number, T[]>();
  private empty: readonly T[] = [];
  constructor(items: readonly T[], bounds: (item: T) => Rect) {
    for (const item of items) {
      const r = bounds(item);
      for (let x = Math.floor(r.x0 / 8); x <= Math.floor(r.x1 / 8); x++)
        for (let z = Math.floor(r.z0 / 8); z <= Math.floor(r.z1 / 8); z++) {
          const key = x * 65536 + z;
          const bucket = this.cells.get(key);
          if (bucket) bucket.push(item); else this.cells.set(key, [item]);
        }
    }
  }
  at(p: P): readonly T[] { return this.cells.get(Math.floor(p.x / 8) * 65536 + Math.floor(p.z / 8)) ?? this.empty; }
}
/** The largest height step the legs take without a stair (a curb is 12 cm). */
export const STEP_UP = .3;
/** Smooth walkable soft-perimeter inset inside `city.bounds` (`> PLAYER_R_HIGH`, preserves `parkNorth + 1.0` riverfront walk). */
export const WORLD_BOUNDARY_PADDING_WALK = 0.48;

function houseV3Zone(id: string): V3ZoneId {
  if (id === 'stair' || id === 'lobby' || id === 'lobbyFoot') return 'hall';
  return id as V3ZoneId;
}

export class LifeWalk {
  readonly half: number;
  private buildings: CityPlan['buildings'];
  private nearbyBuildings: WalkGrid<CityPlan['buildings'][number]>;
  private exteriorBlocks: WalkGrid<Block>;
  private readonly ground: WalkGrid<GroundRect>;
  private readonly props: WalkGrid<Prop>;
  private readonly probeScratch: P = { x: 0, z: 0 };
  private readonly surfScratchA: Place = { y: 0, region: 'study', zone: 'study' };
  private readonly surfScratchB: Place = { y: 0, region: 'study', zone: 'study' };
  private readonly housePaddedRect: { x0: number; x1: number; z0: number; z1: number };
  private doorSurfaceActiveQuery?: (doorId: string) => boolean;

  constructor(
    readonly house: HousePlan,
    readonly city: CityPlan,
    private room: { free(p: P): boolean; half: number } | null = null,
    private openDoors: () => ReadonlySet<string> = () => new Set<string>(),
    private obstacles: () => readonly { x: number; z: number; r: number }[] = () => [],
  ) {
    this.buildings = city.buildings;
    this.half = room?.half ?? house.h - BODY_RADIUS;
    this.housePaddedRect = {
      x0: house.footprint.x0 - 1.6,
      x1: house.footprint.x1 + 1.6,
      z0: house.footprint.z0 - 1.6,
      z1: house.footprint.z1 + 1.6,
    };
    this.props = new WalkGrid(city.props, p => {
      const reach =
        p.kind === 'shelter'
          ? 2.15 + PLAYER_R_HIGH
          : p.kind === 'bench'
            ? 1.05 + PLAYER_R_HIGH
            : p.radius + PLAYER_R_HIGH;
      return {
        x0: p.x - reach,
        x1: p.x + reach,
        z0: p.z - reach,
        z1: p.z + reach,
      };
    });
    this.ground = new WalkGrid(city.ground, g => g.rect);
    this.nearbyBuildings = this.indexBuildings();
    this.exteriorBlocks = this.indexExteriorBlocks();
  }

  /** Optional live door-phase predicate (`phase !== 'closed'` / `|angle| > 0.04`) keeping threshold floor valid while swinging. */
  setDoorSurfaceActiveQuery(fn: ((doorId: string) => boolean) | undefined): void {
    this.doorSurfaceActiveQuery = fn;
  }

  private indexBuildings() {
    return new WalkGrid(this.buildings, b => ({
      x0: Math.min(b.rect.x0, b.door.corridor.x0),
      x1: Math.max(b.rect.x1, b.door.corridor.x1),
      z0: Math.min(b.rect.z0, b.door.corridor.z0),
      z1: Math.max(b.rect.z1, b.door.corridor.z1),
    }));
  }

  private indexExteriorBlocks() {
    const ext: Block[] = [];
    for (const b of this.buildings) {
      for (const bl of b.blocks) if (bl.exterior) ext.push(bl);
    }
    return new WalkGrid(ext, bl => ({
      x0: bl.rect.x0 - PLAYER_R_HIGH,
      x1: bl.rect.x1 + PLAYER_R_HIGH,
      z0: bl.rect.z0 - PLAYER_R_HIGH,
      z1: bl.rect.z1 + PLAYER_R_HIGH,
    }));
  }

  setOwnedHomes(owned: readonly string[]) {
    this.buildings = [...this.city.buildings, ...this.city.residences.filter(home => owned.includes(home.property!.id))];
    this.nearbyBuildings = this.indexBuildings();
    this.exteriorBlocks = this.indexExteriorBlocks();
  }

  /** Signed inward distance to the `pad`-inset `city.bounds` perimeter (`>= 0` inside safe interior, `< 0` within margin or outside). */
  worldBoundaryClearance(p: P, pad = WORLD_BOUNDARY_PADDING_WALK): number {
    const b = this.city.bounds;
    return Math.min(p.x - b.x0, b.x1 - p.x, p.z - b.z0, b.z1 - p.z) - pad;
  }

  /** Euclidean excursion outside the `pad`-inset `city.bounds` interior (`0` inside, strictly `> 0` outside). */
  distToWorldInterior(p: P, pad = WORLD_BOUNDARY_PADDING_WALK): number {
    const b = this.city.bounds;
    const dx = Math.max(b.x0 + pad - p.x, 0, p.x - (b.x1 - pad));
    const dz = Math.max(b.z0 + pad - p.z, 0, p.z - (b.z1 - pad));
    return Math.hypot(dx, dz);
  }

  /** Projects `to` smoothly along the `pad`-inset `city.bounds` perimeter while preserving inward escape steps. */
  slideAlongWorldBounds(from: P, to: P, pad = WORLD_BOUNDARY_PADDING_WALK, out?: P): P {
    const b = this.city.bounds;
    const xMin = Math.min(from.x, b.x0 + pad);
    const xMax = Math.max(from.x, b.x1 - pad);
    const zMin = Math.min(from.z, b.z0 + pad);
    const zMax = Math.max(from.z, b.z1 - pad);
    const cx = to.x < xMin ? xMin : to.x > xMax ? xMax : to.x;
    const cz = to.z < zMin ? zMin : to.z > zMax ? zMax : to.z;
    if (out) {
      out.x = cx;
      out.z = cz;
      return out;
    }
    return { x: cx, z: cz };
  }

  private thresholdDoorAt(doors: readonly Door[], p: P, escapeOrigin?: P, allowPhaseActive = false): Door | null {
    const open = this.openDoors();
    for (let i = 0; i < doors.length; i++) {
      const d = doors[i];
      if (open.has(d.id) && inRect(p, d.corridor)) return d;
      if (allowPhaseActive && this.doorSurfaceActiveQuery?.(d.id) && inRect(p, d.corridor)) return d;
      if (escapeOrigin && inDoorEscapeBox(escapeOrigin, d, 0.10) && inDoorEscapeBox(p, d, 0.10)) return d;
    }
    return null;
  }

  private surfaceInto(
    p: P,
    out: Place,
    escapeOrigin?: P,
    allowPhaseActive = false,
  ): Place | null {
    const h = this.house.h;
    if (Math.abs(p.x) <= h && Math.abs(p.z) <= h) {
      const d = escapeOrigin || allowPhaseActive
        ? this.thresholdDoorAt(this.house.doors, p, escapeOrigin, allowPhaseActive)
        : doorAt(this.house, p, this.openDoors);
      out.y = d ? d.y : 0;
      out.region = d ? `door:${d.id}` : 'study';
      out.zone = 'study';
      return out;
    }
    if (inRect(p, this.housePaddedRect)) {
      const zone = houseZoneAt(this.house, p, 0);
      if (zone) {
        out.y = zoneY(zone, p.z, p.x);
        out.region = zone.id;
        out.zone = houseV3Zone(zone.id);
        return out;
      }
      const door = escapeOrigin || allowPhaseActive
        ? this.thresholdDoorAt(this.house.doors, p, escapeOrigin, allowPhaseActive)
        : doorAt(this.house, p, this.openDoors);
      if (door) {
        out.y = door.y;
        out.region = `door:${door.id}`;
        out.zone = door.id === 'entrance' || door.id === 'garage_out' ? 'street' : 'hall';
        return out;
      }
      for (const pass of this.house.passages) {
        if (inRect(p, pass.rect)) {
          out.y = pass.y;
          out.region = 'arch';
          out.zone = 'living';
          return out;
        }
      }
    }

    // Enterable city buildings (13 real interiors, including 2-storey stairs and mezzanine galleries).
    const buildings = this.nearbyBuildings.at(p);
    if (buildings.length > 0) {
      const bHit = buildingZoneAt(buildings, p, 0);
      if (bHit) {
        out.y = zoneY(bHit.zone, p.z, p.x);
        out.region = bHit.building.property?.id ?? bHit.building.id;
        out.zone = bHit.building.id;
        return out;
      }
      const bDoor = buildingDoorAt(buildings, p, this.openDoors);
      if (bDoor) {
        out.y = bDoor.door.y;
        out.region = `door:${bDoor.door.id}`;
        out.zone = bDoor.building.id;
        return out;
      }
      if (escapeOrigin || allowPhaseActive) {
        for (let i = 0; i < buildings.length; i++) {
          const bd = buildings[i];
          if (
            (allowPhaseActive && this.doorSurfaceActiveQuery?.(bd.door.id) && inRect(p, bd.door.corridor)) ||
            (escapeOrigin && inDoorEscapeBox(escapeOrigin, bd.door, 0.10) && inDoorEscapeBox(p, bd.door, 0.10))
          ) {
            out.y = bd.door.y;
            out.region = `door:${bd.door.id}`;
            out.zone = bd.id;
            return out;
          }
        }
      }
      for (let i = 0; i < buildings.length; i++) {
        const b = buildings[i];
        if (!inRect(p, b.rect)) continue;
        for (const pass of b.passages) {
          if (inRect(p, pass.rect)) {
            out.y = pass.y;
            out.region = b.property?.id ?? b.id;
            out.zone = b.id;
            return out;
          }
        }
      }
    }

    if (!inRect(p, this.city.bounds)) return null;
    const ground = this.ground.at(p);
    for (let i = ground.length - 1; i >= 0; i--) {
      const g = ground[i];
      if (inRect(p, g.rect)) {
        out.y = g.y;
        out.region = g.surface;
        out.zone = g.zone ?? 'street';
        return out;
      }
    }
    return null;
  }

  /** The floor under a point, ignoring furniture: study square, house zones, enterable buildings, open doors, or outdoors. */
  surface(p: P, escapeOrigin?: P, allowPhaseActive = false): Place | null {
    const hit = this.surfaceInto(p, this.surfScratchA, escapeOrigin, allowPhaseActive);
    return hit ? { y: hit.y, region: hit.region, zone: hit.zone } : null;
  }

  furniture: readonly { x: number; y: number; z: number; hx: number; hy: number; hz: number }[] = [];

  /** Can an NPC or `R_low = 0.20 m` body centre stand here? Inside the room the room's own rule (furniture) decides. */
  free(p: P): boolean {
    const h = this.house.h;
    const inside = Math.abs(p.x) <= h && Math.abs(p.z) <= h;
    if (this.furniture.some(b => Math.abs(p.x - b.x) < b.hx + BODY_RADIUS && Math.abs(p.z - b.z) < b.hz + BODY_RADIUS &&
      Math.abs((this.groundAt(p.x, p.z) ?? 0) - (b.y - b.hy)) < .5)) return false;
    if (inside && this.room?.free(p)) return true;
    if (inside && !doorAt(this.house, p, this.openDoors)) return false;
    const here = this.surfaceInto(p, this.surfScratchA);
    if (!here) return false;
    const hereY = here.y;
    const hereRegion = here.region;
    for (const [dx, dz] of RING) {
      this.probeScratch.x = p.x + dx * BODY_RADIUS;
      this.probeScratch.z = p.z + dz * BODY_RADIUS;
      const s = this.surfaceInto(this.probeScratch, this.surfScratchB);
      if (!s || Math.abs(s.y - hereY) > STEP_UP) return false;
    }
    const nearHouse = inRect(p, this.housePaddedRect);
    if (nearHouse) {
      for (const b of this.house.blocks) {
        if (b.y !== undefined && Math.abs(b.y - hereY) >= 1.2) continue;
        if (inRect(p, { x0: b.rect.x0 - BODY_RADIUS, x1: b.rect.x1 + BODY_RADIUS, z0: b.rect.z0 - BODY_RADIUS, z1: b.rect.z1 + BODY_RADIUS })) return false;
      }
      for (const f of this.house.furniture) {
        if (f.footprint && Math.abs(f.y - hereY) < 1.2 && inRect(p, { x0: f.footprint.x0 - BODY_RADIUS, x1: f.footprint.x1 + BODY_RADIUS, z0: f.footprint.z0 - BODY_RADIUS, z1: f.footprint.z1 + BODY_RADIUS })) return false;
      }
    }
    // Interior furniture and height-filtered blocks inside enterable city buildings.
    const bHit = buildingZoneAt(this.nearbyBuildings.at(p), p, 0);
    if (bHit) {
      for (const bl of bHit.building.blocks) {
        if (bl.exterior) continue;
        if (bl.y !== undefined && Math.abs(bl.y - hereY) >= 1.2) continue;
        if (inRect(p, { x0: bl.rect.x0 - BODY_RADIUS, x1: bl.rect.x1 + BODY_RADIUS, z0: bl.rect.z0 - BODY_RADIUS, z1: bl.rect.z1 + BODY_RADIUS })) return false;
      }
      for (const f of bHit.building.furniture) {
        if (f.footprint && Math.abs(f.y - hereY) < 1.2 && inRect(p, { x0: f.footprint.x0 - BODY_RADIUS, x1: f.footprint.x1 + BODY_RADIUS, z0: f.footprint.z0 - BODY_RADIUS, z1: f.footprint.z1 + BODY_RADIUS })) return false;
      }
    }
    for (const o of this.obstacles()) if (Math.hypot(p.x - o.x, p.z - o.z) < o.r + BODY_RADIUS) return false;
    if (hereRegion !== 'study' && !bHit) {
      for (const bl of this.exteriorBlocks.at(p)) {
        if (Math.abs((bl.y ?? GROUND_Y) - hereY) >= 1.2) continue;
        if (inRect(p, { x0: bl.rect.x0 - BODY_RADIUS, x1: bl.rect.x1 + BODY_RADIUS, z0: bl.rect.z0 - BODY_RADIUS, z1: bl.rect.z1 + BODY_RADIUS })) return false;
      }
      for (const o of this.props.at(p)) {
        if (o.kind === 'bench') {
          if (sdOrientedBox2D(p.x, p.z, o.x, o.z, 0.96, 0.29, o.rotY ?? 0) < BODY_RADIUS) return false;
          continue;
        }
        if (o.kind === 'shelter') {
          if (sdShelterPerimeter2D(p.x, p.z, o.x, o.z, o.rotY ?? 0) < BODY_RADIUS) return false;
          continue;
        }
        const reach = o.radius + BODY_RADIUS, dx = p.x - o.x, dz = p.z - o.z;
        if (dx * dx + dz * dz < reach * reach) return false;
      }
    }
    return true;
  }

  /**
   * Continuous height-banded signed clearance for the player (`>= 0` clear, `< 0` penetration depth):
   * - `PLAYER_R_LOW = 0.20 m` against obstacles with `topRel < 0.95 m` (chairs, desks, beds, sofas, benches).
   * - `PLAYER_R_HIGH = 0.26 m` against walls, doorway jambs (`DOOR_W / 2 - rHigh`), bookstacks, shelves, trees, and tall props.
   */
  playerClearanceAt(p: P, buildScale = 1.0, escapeOrigin?: P): number {
    const scale = buildRadiusScale(buildScale);
    const rLow = PLAYER_R_LOW * scale;
    const rHigh = PLAYER_R_HIGH * scale;
    const h = this.house.h;
    const inside = Math.abs(p.x) <= h && Math.abs(p.z) <= h;

    const here = this.surfaceInto(p, this.surfScratchA, escapeOrigin, true);
    if (!here) {
      if (!inRect(p, this.city.bounds)) {
        return -(this.distToWorldInterior(p, Math.max(WORLD_BOUNDARY_PADDING_WALK, rHigh + 0.12)) + rHigh);
      }
      return -rHigh;
    }
    const hereY = here.y;
    const hereRegion = here.region;

    let minC = 10.0;
    const nearHouse = inside || inRect(p, this.housePaddedRect);

    // 1. Study room interior: keep `RoomNavigation` (`rLow = 0.20 m`) for user furniture, `rHigh` on perimeter walls/jambs.
    if (inside) {
      const openDoor = doorAt(this.house, p, this.openDoors);
      if (!openDoor && this.room && !this.room.free(p)) {
        minC = Math.min(minC, -0.02);
      }
      const wallXPos = openDoor && openDoor.wallAlong === 'z' && openDoor.x > 0
        ? Math.min(
            Math.hypot(p.x - h, p.z - (openDoor.z - openDoor.width * 0.5)) - rHigh,
            Math.hypot(p.x - h, p.z - (openDoor.z + openDoor.width * 0.5)) - rHigh,
          )
        : h - p.x - rHigh;
      minC = Math.min(minC, wallXPos, h + p.x - rHigh, h - p.z - rHigh, h + p.z - rHigh);
    }

    // 2. Enforce `DOOR_W / 2 - rHigh` shoulder clearance whenever passing through a doorway wall plane.
    const checkDoorJambs = (d: Door) => {
      if (!inRect(p, d.corridor) && !(escapeOrigin && inDoorEscapeBox(p, d, 0.10))) return;
      const inWallPlane = d.wallAlong === 'z'
        ? Math.abs(p.x - d.x) <= WALL * 0.5 + rHigh
        : Math.abs(p.z - d.z) <= WALL * 0.5 + rHigh;
      if (!inWallPlane) return;
      if (!this.openDoors().has(d.id)) {
        minC = Math.min(minC, distToDoorSegment2D(p, d) - (WALL * 0.5 + rHigh));
        return;
      }
      const padded = doorCenterCorridor(d, rHigh);
      const axisClear = d.wallAlong === 'z'
        ? Math.min(p.z - padded.z0, padded.z1 - p.z)
        : Math.min(p.x - padded.x0, padded.x1 - p.x);
      minC = Math.min(minC, axisClear);
    };
    if (nearHouse) {
      for (const d of this.house.doors) checkDoorJambs(d);
    }
    const nearbyBlds = this.nearbyBuildings.at(p);
    for (const b of nearbyBlds) checkDoorJambs(b.door);

    const bHit = buildingZoneAt(nearbyBlds, p, 0);
    if (!inside && !bHit && !inRect(p, this.house.footprint)) {
      const boundPad = Math.max(WORLD_BOUNDARY_PADDING_WALK, rHigh + 0.12);
      minC = Math.min(minC, this.worldBoundaryClearance(p, boundPad));
    }

    // 3. Perimeter wall / ledge probe at `rHigh` (analytical `worldBoundaryClearance` handles `city.bounds` in O(1)).
    for (const [dx, dz] of RING) {
      this.probeScratch.x = p.x + dx * rHigh;
      this.probeScratch.z = p.z + dz * rHigh;
      if (!inRect(this.probeScratch, this.city.bounds) && !inside && !bHit) {
        continue;
      }
      const s = this.surfaceInto(this.probeScratch, this.surfScratchB, escapeOrigin, true);
      if (!s || Math.abs(s.y - hereY) > STEP_UP) {
        let lo = 0, hi = rHigh;
        for (let k = 0; k < 5; k++) {
          const mid = (lo + hi) * 0.5;
          this.probeScratch.x = p.x + dx * mid;
          this.probeScratch.z = p.z + dz * mid;
          const sm = this.surfaceInto(this.probeScratch, this.surfScratchB, escapeOrigin, true);
          if (sm && Math.abs(sm.y - hereY) <= STEP_UP) lo = mid; else hi = mid;
        }
        minC = Math.min(minC, lo - rHigh);
      }
    }

    // 4. Dynamic BuildStudio / Workshop furniture boxes (`topRel = 2 * hy`).
    for (const b of this.furniture) {
      if (Math.abs(hereY - (b.y - b.hy)) >= 0.5) continue;
      const reqR = b.hy * 2 >= PLAYER_HEIGHT_BAND_SPLIT ? rHigh : rLow;
      const dx = Math.abs(p.x - b.x) - b.hx;
      const dz = Math.abs(p.z - b.z) - b.hz;
      const sd = Math.hypot(dx > 0 ? dx : 0, dz > 0 ? dz : 0) + Math.min(Math.max(dx, dz), 0);
      minC = Math.min(minC, sd - reqR);
    }

    // 5. House blocks and furniture (`R_low` vs `R_high`).
    if (nearHouse) {
      for (const b of this.house.blocks) {
        if (b.y !== undefined && Math.abs(b.y - hereY) >= 1.2) continue;
        const reqR = (b.topRel ?? 0.90) >= PLAYER_HEIGHT_BAND_SPLIT ? rHigh : rLow;
        minC = Math.min(minC, sdRect2D(p.x, p.z, b.rect) - reqR);
      }
      for (const f of this.house.furniture) {
        if (!f.footprint || Math.abs(f.y - hereY) >= 1.2) continue;
        const reqR = furnishingTopRel(f) >= PLAYER_HEIGHT_BAND_SPLIT ? rHigh : rLow;
        minC = Math.min(minC, sdRect2D(p.x, p.z, f.footprint) - reqR);
      }
    }

    // 6. Enterable building interior blocks and furniture (`R_low` vs `R_high`).
    if (bHit) {
      for (const bl of bHit.building.blocks) {
        if (bl.exterior) continue;
        if (bl.y !== undefined && Math.abs(bl.y - hereY) >= 1.2) continue;
        const reqR = (bl.topRel ?? 0.90) >= PLAYER_HEIGHT_BAND_SPLIT ? rHigh : rLow;
        minC = Math.min(minC, sdRect2D(p.x, p.z, bl.rect) - reqR);
      }
      for (const f of bHit.building.furniture) {
        if (!f.footprint || Math.abs(f.y - hereY) >= 1.2) continue;
        const reqR = furnishingTopRel(f) >= PLAYER_HEIGHT_BAND_SPLIT ? rHigh : rLow;
        minC = Math.min(minC, sdRect2D(p.x, p.z, f.footprint) - reqR);
      }
    }

    for (const o of this.obstacles()) {
      minC = Math.min(minC, Math.hypot(p.x - o.x, p.z - o.z) - (o.r + rLow));
    }

    // 7. Sidewalk exterior blocks and street props (oriented OBB for benches, 3 perimeter panels for shelters).
    if (hereRegion !== 'study' && !bHit) {
      for (const bl of this.exteriorBlocks.at(p)) {
        if (Math.abs((bl.y ?? GROUND_Y) - hereY) >= 1.2) continue;
        const reqR = (bl.topRel ?? 0.90) >= PLAYER_HEIGHT_BAND_SPLIT ? rHigh : rLow;
        minC = Math.min(minC, sdRect2D(p.x, p.z, bl.rect) - reqR);
      }
      for (const o of this.props.at(p)) {
        if (o.kind === 'bench') {
          minC = Math.min(minC, sdOrientedBox2D(p.x, p.z, o.x, o.z, 0.96, 0.29, o.rotY ?? 0) - rLow);
          continue;
        }
        if (o.kind === 'shelter') {
          minC = Math.min(minC, sdShelterPerimeter2D(p.x, p.z, o.x, o.z, o.rotY ?? 0) - rHigh);
          continue;
        }
        const tag = o.asset ?? o.kind;
        const isTall = o.kind === 'tree' || o.kind === 'lamp' || TALL_ASSET_RE.test(tag);
        const reqR = isTall ? rHigh : rLow;
        minC = Math.min(minC, Math.hypot(p.x - o.x, p.z - o.z) - (o.radius + reqR));
      }
    }

    return minC;
  }

  freeForPlayer(p: P, buildScale = 1.0): boolean {
    return this.playerClearanceAt(p, buildScale) >= -1e-4;
  }

  private readonly motionPrevScratch: P = { x: 0, z: 0 };
  private readonly motionNextScratch: P = { x: 0, z: 0 };

  /**
   * Depenetration-permissive straight-line fraction for player movement:
   * admits sub-steps whenever `clearance(next) >= 0` OR `clearance(next) >= clearance(prev) - 1e-4`,
   * guaranteeing the player can never push deeper into geometry yet can ALWAYS walk out of a tight start.
   */
  playerMotionFraction(a: P, b: P, buildScale = 1.0): number {
    const steps = Math.min(16, Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.035)));
    const prev = this.motionPrevScratch;
    const next = this.motionNextScratch;
    prev.x = a.x;
    prev.z = a.z;
    let prevClear = this.playerClearanceAt(prev, buildScale, prev);
    for (let i = 1; i <= steps; i++) {
      next.x = a.x + ((b.x - a.x) * i) / steps;
      next.z = a.z + ((b.z - a.z) * i) / steps;
      if (!this.surface(next, prev, true)) return (i - 1) / steps;
      const nextClear = this.playerClearanceAt(next, buildScale, prev);
      if (nextClear < -1e-4 && nextClear < prevClear - 1e-4) {
        return (i - 1) / steps;
      }
      prev.x = next.x;
      prev.z = next.z;
      prevClear = nextClear;
    }
    return 1;
  }

  /**
   * Zero-raycast, zero-allocation analytical foot support height and surface normal:
   * blends smoothly between the continuous stair ramp (`stairTreadBlend = 0` while moving) and
   * `(i + 0.5)` centered horizontal stair treads with a `2.4 cm` step-nose Hermite bevel (`stairTreadBlend = 1` when stopped).
   * When `referenceY` is provided, rejects cross-storey surface hits (`|y - referenceY| > 0.55 m`) so a horizontal
   * `(x, z)` probe near an upper-floor slab or stair edge never snaps a foot onto another storey.
   */
  sampleFootSupport(
    x: number,
    z: number,
    stairTreadBlend = 0,
    out?: FootSupportSample,
    referenceY?: number,
  ): FootSupportSample | null {
    const MAX_FOOT_STEP_DELTA = 0.55;
    const hasRefY = referenceY !== undefined && Number.isFinite(referenceY);
    const target: FootSupportSample = out ?? { y: 0, nx: 0, ny: 1, nz: 0, onStair: false };
    this.probeScratch.x = x;
    this.probeScratch.z = z;

    let activeStair: Stair | undefined;
    if (inRect(this.probeScratch, this.house.stair.rect)) {
      activeStair = this.house.stair;
    } else {
      const blds = this.nearbyBuildings.at(this.probeScratch);
      for (let i = 0; i < blds.length; i++) {
        const st = blds[i].stair;
        if (st && inRect(this.probeScratch, st.rect)) {
          activeStair = st;
          break;
        }
      }
    }

    if (activeStair) {
      const along = activeStair.along ?? 'z';
      const span = along === 'x'
        ? Math.max(1e-4, activeStair.rect.x1 - activeStair.rect.x0)
        : Math.max(1e-4, activeStair.rect.z1 - activeStair.rect.z0);
      const u = along === 'x'
        ? clamp01((x - activeStair.rect.x0) / span)
        : clamp01((z - activeStair.rect.z0) / span);

      const dy = activeStair.y1 - activeStair.y0;
      const yRamp = activeStair.y0 + dy * u;

      const steps = Math.max(1, activeStair.steps);
      const s = u * steps;
      const idx = Math.min(steps - 1, Math.max(0, Math.floor(s)));
      const frac = s - idx;
      const treadY = (k: number) => activeStair.y0 + ((k + 0.5) / steps) * dy;
      let yTread = treadY(idx);
      if (frac > 0.92 && idx < steps - 1) {
        const bev = smoothstep01((frac - 0.92) / 0.08);
        yTread += bev * (treadY(idx + 1) - yTread);
      }

      const blend = clamp01(stairTreadBlend);
      const computedY = yRamp + (yTread - yRamp) * blend;
      if (hasRefY && Math.abs(computedY - (referenceY as number)) > MAX_FOOT_STEP_DELTA) {
        return null;
      }

      const softAngle = 0.42 * Math.atan(dy / span);
      const sinA = Math.sin(softAngle);
      const cosA = Math.cos(softAngle);
      const rnx = along === 'x' ? -sinA : 0;
      const rny = cosA;
      const rnz = along === 'z' ? -sinA : 0;

      const nx = rnx * (1 - blend);
      const ny = rny * (1 - blend) + blend;
      const nz = rnz * (1 - blend);
      const invLen = 1 / Math.max(1e-6, Math.hypot(nx, ny, nz));

      target.y = computedY;
      target.nx = nx * invLen;
      target.ny = ny * invLen;
      target.nz = nz * invLen;
      target.onStair = true;
      return target;
    }

    const surf = this.surface(this.probeScratch);
    if (!surf) return null;
    if (hasRefY && Math.abs(surf.y - (referenceY as number)) > MAX_FOOT_STEP_DELTA) {
      return null;
    }
    target.y = surf.y;
    target.nx = 0;
    target.ny = 1;
    target.nz = 0;
    target.onStair = false;
    return target;
  }

  /** Height of the floor the body stands on; null off any floor. */
  groundAt(x: number, z: number): number | null { return this.surface({ x, z })?.y ?? null; }

  /** Backward-compatible surface/room region string (`study`, `living`, `sidewalk`, `park`, `library`, …). */
  region(p: P): string | null { return this.surface(p)?.region ?? null; }

  /** Canonical 31-zone V3 identifier for any walkable position in the world. */
  zone(p: P): V3ZoneId | null { return this.surface(p)?.zone ?? null; }

  /** Straight-line fraction for a move. */
  motionFraction(a: P, b: P): number {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / .035));
    for (let i = 1; i <= steps; i++) if (!this.free({ x: a.x + (b.x - a.x) * i / steps, z: a.z + (b.z - a.z) * i / steps })) return (i - 1) / steps;
    return 1;
  }

  /** True if every 3.5 cm step on the straight line from `a` to `b` is walkable. */
  clearLine(a: P, b: P): boolean { return this.motionFraction(a, b) >= 1 - 1e-6; }

  /** Short-range A* path across any walkable house/building/city floor (matches `RoomNavigation.path` for `walkToward`). */
  path(from: P, to: P): P[] | null {
    if (!this.free(to)) return null;
    if (this.clearLine(from, to)) return [to];
    const dist = Math.hypot(to.x - from.x, to.z - from.z);
    if (dist > 14) return null;
    const step = .14, pad = 2.4;
    const x0 = Math.min(from.x, to.x) - pad, z0 = Math.min(from.z, to.z) - pad;
    const nx = Math.ceil((Math.max(from.x, to.x) + pad - x0) / step) + 1;
    const nz = Math.ceil((Math.max(from.z, to.z) + pad - z0) / step) + 1;
    const id = (i: number, j: number) => j * nx + i;
    const cell = (p: P): [number, number] => [Math.round((p.x - x0) / step), Math.round((p.z - z0) / step)];
    const at = (i: number, j: number): P => ({ x: x0 + i * step, z: z0 + j * step });
    const [si, sj] = cell(from), [gi, gj] = cell(to);
    const cache = new Map<number, boolean>();
    const ok = (i: number, j: number) => {
      if (i < 0 || j < 0 || i >= nx || j >= nz) return false;
      const k = id(i, j);
      let v = cache.get(k);
      if (v === undefined) { v = this.free(at(i, j)); cache.set(k, v); }
      return v;
    };
    const came = new Map<number, number>([[id(si, sj), -1]]);
    const cost = new Map<number, number>([[id(si, sj), 0]]);
    const open: [number, number, number][] = [[Math.hypot(gi - si, gj - sj), si, sj]];
    let expanded = 0;
    while (open.length && expanded++ < 2000) {
      let bestIdx = 0;
      for (let m = 1; m < open.length; m++) if (open[m][0] < open[bestIdx][0]) bestIdx = m;
      const [, i, j] = open.splice(bestIdx, 1)[0];
      if (i === gi && j === gj) break;
      const base = cost.get(id(i, j))!;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const a = i + di, b = j + dj;
        if (!ok(a, b) || (di && dj && (!ok(i + di, j) || !ok(i, j + dj)))) continue;
        const c = base + Math.hypot(di, dj), k = id(a, b);
        if (c >= (cost.get(k) ?? Infinity)) continue;
        cost.set(k, c); came.set(k, id(i, j));
        open.push([c + Math.hypot(gi - a, gj - b), a, b]);
      }
    }
    if (!came.has(id(gi, gj))) return null;
    const raw: P[] = [];
    for (let k = id(gi, gj); k !== -1; k = came.get(k)!) raw.unshift(at(k % nx, Math.floor(k / nx)));
    raw[raw.length - 1] = to;
    return raw.length > 1 ? raw.slice(1) : [to];
  }

  /**
   * The camera's eye kept where a head could be: inside the study room the old square clamp, in a house or city
   * building interior within its walls and under its ceiling, outdoors above the ground inside city bounds.
   */
  clampCamera(local: { x: number; y: number; z: number }, body: { x: number; y: number; z: number }, passing: boolean) {
    const h = this.house.h;
    const at = this.surface(body);
    if (!at || at.region === 'study' || (passing && Math.abs(body.x) <= h && Math.abs(body.z) <= h)) {
      const half = passing ? this.half + 1.4 : this.half;
      local.x = Math.min(half, Math.max(-half, local.x)); local.z = Math.min(half, Math.max(-half, local.z));
      local.y = Math.min(2.8, Math.max(.3, local.y));
      return local;
    }
    const zone = houseZoneAt(this.house, body, 0);
    if (zone) {
      const pad = .12;
      local.x = Math.min(zone.rect.x1 - pad, Math.max(zone.rect.x0 + pad, local.x));
      local.z = Math.min(zone.rect.z1 - pad, Math.max(zone.rect.z0 + pad, local.z));
      const floor = zoneY(zone, local.z, local.x);
      if (zone.ceiling === null && zone.y1 === undefined) {
        // Open-sky balcony: clamped horizontally to the balcony balustrade, free sky above.
        local.y = Math.max(floor + .3, local.y);
      } else {
        const top = zone.ceiling === null ? 2.85 : zone.ceiling - .18;
        local.y = Math.min(Math.max(floor, body.y) + (zone.y1 !== undefined ? 3.4 : top), Math.max(floor + .3, local.y));
      }
      return local;
    }
    const bHit = buildingZoneAt(this.buildings, body, 0);
    if (bHit) {
      const br = bHit.building.rect;
      local.x = Math.min(br.x1 - .28, Math.max(br.x0 + .28, local.x));
      local.z = Math.min(br.z1 - .28, Math.max(br.z0 + .28, local.z));
      const floor = zoneY(bHit.zone, local.z, local.x);
      const top = bHit.zone.ceiling === null ? 3.4 : bHit.zone.ceiling - .18;
      local.y = Math.min(floor + top, Math.max(floor + .3, local.y));
      return local;
    }
    // Door strip or outdoors: above the ground, inside city bounds.
    const b = this.city.bounds;
    local.x = Math.min(b.x1, Math.max(b.x0, local.x)); local.z = Math.min(b.z1, Math.max(b.z0, local.z));
    const ground = this.surface(local)?.y ?? Math.min(body.y, GROUND_Y);
    local.y = Math.max(ground + .3, local.y);
    return local;
  }
}
