/**
 * Echo Life Total Rebirth (A06) — Autonomous 22-Resident Living World Simulation.
 *
 * Layered cleanly over vendored V3 rules (`../v3/**` is NEVER modified):
 * - WHAT V3 requires (missions, story choices, 3 endings, 14 side arcs, tutorial Step 3, hosted guests,
 *   world events, 14 scripted social scenes) is unconditionally protected by Layer 0 Hard V3 Locks.
 * - WHEN free of V3 locks, all 22 named residents think via `NpcMindEngine` (Big-5 traits, 6 needs, 7 moods,
 *   STM/LTM episodic memory, 4-Layer Utility AI + weather/rain/horn/basketball/approach reflexes),
 *   cluster organically via `SocialSimEngine` (22×22 affinity graph, 2–3 NPC semicircular gatherings,
 *   unobtrusive English-only overheard banter, ZERO LLM calls), and travel via 3-Tier Distance LOD
 *   (`Full < 35 m` / `Reduced 35–110 m` / `Abstract > 110 m` on `ZoneTravelGraph` with 0.00 m handover).
 *
 * `PeopleSim` remains the single spatial authority for all 22 residents and mirrors into `s.npcs[id]`
 * with zero per-frame slice allocations and cached floor heights (`groundY`).
 */
import type { V3State, V3Npc } from '../v3/game-core/index.mjs';
import {
  CHARACTERS,
  CHARACTER_IDS,
  detectZoneSocialScenes,
  getActiveEvents,
  isZoneOpen,
  zones as v3Zones,
} from '../v3/game-core/index.mjs';
import { desiredScheduleFor } from '../v3/npc-ai/residents.mjs';
import { checkExpiredInvites } from '../v3/npc-ai/relationships.mjs';
import { BODY_RADIUS, inRect, type Rect } from '../plan';
import type { EnterableBuilding } from '../buildings';
import {
  BUS_SHELTER_SEAT_GEOMETRY,
  OPEN_SEAT_STAND_ANGLES,
  PATIO_BISTRO_SEAT_GEOMETRY,
  PERGOLA_BENCH_SEAT_GEOMETRY,
  STREET_BENCH_SEAT_GEOMETRY,
  TABLE_TUCKED_STAND_ANGLES,
  resolveSeatStandPoint,
} from '../aaaBuildingLayout';
import { V3_ZONE_IDS, type V3ZoneId } from '../zones';
import type { LifeNav, P, Route } from './nav';
import {
  setActiveVehicles as setCrowdActiveVehicles,
  setPedestrianDensityMultiplier as setCrowdDensityMultiplier,
  setResidentKinematics as setCrowdResidentKinematics,
  type ResidentKinematicsView,
  type VehicleHazard,
} from './crowd';
export type { ResidentKinematicsView, VehicleHazard } from './crowd';
import { setTrafficDensityMultiplier as setTrafficSimDensityMultiplier } from './commute';
import {
  OrcaScratch,
  SpatialHash2D,
  addOrcaDiskConstraint,
  addOrcaStaticObbConstraint,
  solveOrca2D,
  turnSmooth,
} from './orca2d';
import {
  NpcMindEngine,
  RESIDENT_PROFILES,
  envSnapshotFromV3,
  isResidentId,
  type DistrictRepTier,
  type EnvSnapshot,
  type ExpressiveActivity,
  type NpcSimSnapshot,
  type ResidentId,
  type ResidentMood,
  type ShelterAnchor,
  type WorldStimulus,
} from './npcMind';
import {
  SocialSimEngine,
  type OverheardBanter,
  type SocialMemberDirective,
  type SocialParticipantView,
} from './socialSim';
import {
  TIER_INTERVAL_SECONDS,
  ZoneTravelGraph,
  resolveSimulationTier,
  type AbstractTrip,
  type TierLevel,
} from './zoneGraph';

export interface DoorPort {
  /** The live door (only doors of the house and of HOT buildings exist); null means nobody can see it. */
  door(id: string): { readonly passable: boolean; readonly isOpen: boolean; prepare(at: P): void; setOpen(open: boolean): void } | null;
}

export interface Seat {
  id: string;
  zone: V3ZoneId;
  /** Walkable approach spot right in front of the seat (`nav.walk.free(stand)` is always true for public seats). */
  stand: P;
  /** Seat cushion position where the rendered character sits. */
  sit: { x: number; y: number; z: number };
  top: number;
  /** Facing yaw when seated (outward from backrest or toward reading table). */
  yaw: number;
  /** Non-null for seats/beds inside the 5 Market Boulevard purchasable residences (A09). */
  propertyId?: string;
  /** True for bed-edge seating inside residences (excluded from casual NPC sitting). */
  isBed?: boolean;
  /** Rolling swivel vs fixed seat base (`chair.office` / `gaming-chair` / `chair_ergo_gaming`). */
  mobility?: 'stationary' | 'rolling';
  /** True for player-placed Build Studio / Workshop furnishings or relocated starter furniture. */
  isDynamicWorkshop?: boolean;
}

export interface WorkshopSeatObjectLike {
  readonly instanceId: string;
  readonly category?: string;
  readonly selectedVariantId: string;
  readonly upgradeLevel?: number;
  readonly location: {
    readonly zoneId?: string | null;
    readonly propertyId?: string | null;
    readonly inStorage?: boolean;
  };
  readonly placement: {
    readonly x: number;
    readonly z: number;
    readonly yaw: number;
  };
}

export interface StarterSeatOverrideLike {
  readonly id: string;
  readonly x: number;
  readonly y?: number;
  readonly z: number;
  readonly rotY: number;
  readonly zone?: string;
}

export type WalkerSeatPhase = 'none' | 'sitting_down' | 'seated' | 'standing_up';

export interface WalkerSeatTransition {
  phase: WalkerSeatPhase;
  /** 0..1 progress within active sitting_down or standing_up transition (1 when seated, 0 when none). */
  progress: number;
  /** 0 = at seat.stand; 1 = aligned at seat.sit. */
  rootAlignW: number;
  /** 0 = clip pelvis owns height; 1 = pelvis settled on cushion. */
  hipContactW: number;
}

export interface Walker {
  id: string;
  x: number; z: number; yaw: number;
  /** Authoritative simulation velocity (m/s) for zero-lag GameView feedforward and ORCA avoidance. */
  vx: number;
  vz: number;
  zone: V3ZoneId;
  destZone: V3ZoneId | null;
  dest: P | null;
  route: Route | null;
  /** Index of the next route point. */
  ri: number;
  activity: string;
  moving: boolean;
  /** A door this walker opened and must close once through it. */
  closeBehind: { door: string; at: P } | null;
  waitDoor: number;
  blocked: number;
  /** Route wanted but not yet computed (budgeted per frame). */
  pending: boolean;
  simulationDebt: number;
  /** Accumulated Tier-1 60 Hz sub-step time already integrated between 5 Hz AI ticks. */
  substepAccum: number;
  failures: number;
  /** Scene partner to face (social scene), if any. */
  facing: string | null;
  /** Active V3 social scene id & authored pose (preserved across frames until the scene ends). */
  sceneId: string | null;
  scenePose: string | null;
  /** Occupied real seat (sofa, chair, bench, booth, reading table) while settled in a sit/study activity. */
  seat: Seat | null;
  /** Retained seat reference during `Stand_Up` so `GameView` never snaps 0.75 m forward while still seated. */
  lastSeat: Seat | null;
  /** Live seat entry/exit blend state synced with `Sit_Down` / `Stand_Up` durations. */
  seatTransition: WalkerSeatTransition;
  /** Internal elapsed timer for active `sitting_down` or `standing_up` phase (seconds). */
  seatTransitionElapsed: number;
  /** Target seat the resident is walking toward so they can sit down cleanly. */
  targetSeat: Seat | null;
  /** Brief friendly wave timer & cooldown when the learner approaches closely. */
  greetUntil: number;
  greetCooldown: number;
  /** The door this resident opened last (they close it behind them). */
  opened?: string | null;

  // ── A06 Autonomous Simulation & Presentation Fields ──
  tier: TierLevel;
  groundY: number;
  outdoor: boolean;
  mood: ResidentMood;
  microAct: ExpressiveActivity | null;
  /** World-space point for procedural Neck/Head look-at in `gameView.ts`. */
  lookTarget: P | null;
  /** Explicit per-resident rain/snow umbrella state. */
  rainUmbrella: boolean;
  /** Deterministic umbrella palette index [0..4]. */
  umbrellaColor: number;
  /** Short active reflex/greeting quip (<= 3.5 s, zero LLM). */
  quip: string | null;
  /** Elapsed time until `quip` clears automatically. */
  quipUntil?: number;
  /** Active emergent multi-NPC social group id (if not in a V3 scripted scene). */
  emergentGroupId: string | null;
  /** Continuous Tier 2 spine traversal state (zero-teleport promotion to `route`). */
  abstractTrip: AbstractTrip | null;
  /** Next elapsed time (seconds) when Utility AI goal evaluation is due (tier/FPS independent ~0.5 Hz). */
  nextAiEvalAt: number;
  /** Internal cooldown/state for polite doorway yielding, crosswalk waiting, and counter queues. */
  doorQuipCooldownUntil?: number;
  asideTarget?: P | null;
  asideUntil?: number;
  curbWaitIsPlayer?: boolean;
  curbWaitAt?: number;
  yieldCrossUntil?: number;
  yieldRepCooldownUntil?: number;
  queueCooldownUntil?: number;
}

export interface ParkedVehicleObstacle {
  x: number;
  z: number;
  yaw: number;
  halfWidth: number;
  halfLength: number;
  radius?: number;
}

interface CounterQueueSlot {
  x: number;
  z: number;
  yaw: number;
}

interface CounterQueueEntry {
  walkerId: string;
  joinedAt: number;
  serviceUntil: number;
  advanceAt: number;
}

interface CounterQueueState {
  zone: V3ZoneId;
  shopkeeperId: string;
  slots: CounterQueueSlot[];
  entries: CounterQueueEntry[];
}

export interface PeopleStats {
  walking: number;
  routes: number;
  doorsOpened: number;
  scenes: string[];
  seated: number;
  /** [Tier0_Full, Tier1_Reduced, Tier2_Abstract, reserved_0] — preserves 4-tuple backward compatibility. */
  tiers: [number, number, number, number];
  emergentGroups: number;
  abstractTrips: number;
}

export interface PlayerVehicleState {
  kind: 'car' | 'motorbike' | 'bike';
  name: string;
  speed: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
}

const WALK = 1.28;
const RUN = 2.4;
const SPOTS = 12;
const NPC_MIN_SEP = 0.82;
const SCENE_MIN_SEP = 1.02;
const DOOR_STOP = 1.15;
const SIT_ACTIVITIES = new Set(['sit', 'study', 'relax', 'read', 'sleep', 'coffee']);
const OUTDOOR_REGIONS = new Set(['sidewalk', 'crossing', 'park', 'garden', 'plaza', 'road']);
const STIMULUS_TTL = 4.0;
const STIMULUS_CAP = 16;

const SHOPKEEPER_COUNTERS: Readonly<Record<string, { zone: V3ZoneId; assets: readonly string[] }>> = {
  mai: { zone: 'market', assets: ['market-checkout'] },
  khanhha: { zone: 'bistro', assets: ['crepe-kiosk', 'espresso'] },
  baolong: { zone: 'electronics_shop', assets: ['gaming-desk'] },
  kimngan: { zone: 'furniture_shop', assets: ['display-cabinet', 'table'] },
  phuonglien: { zone: 'clothing_shop', assets: ['bench-cushion'] },
  tuankiet: { zone: 'vehicle_dealer', assets: ['gaming-desk'] },
  quangvinh: { zone: 'home_center', assets: ['photocopier', 'kitchen-island'] },
  ductri: { zone: 'repair_shop', assets: ['workbench'] },
  anchi: { zone: 'library', assets: ['library-desk'] },
  huy: { zone: 'cafe', assets: ['gaming-desk'] },
};

const QUEUE_VENUES: readonly { zone: V3ZoneId; shopkeeperId: string; assets: readonly string[] }[] = [
  { zone: 'market', shopkeeperId: 'mai', assets: ['market-checkout'] },
  { zone: 'bistro', shopkeeperId: 'khanhha', assets: ['crepe-kiosk', 'espresso'] },
  { zone: 'library', shopkeeperId: 'anchi', assets: ['library-desk'] },
  { zone: 'cafe', shopkeeperId: 'huy', assets: ['gaming-desk'] },
];

const QUEUE_MAX_SLOTS = 5;
const QUEUE_SPACING = 0.85;
const INDOOR_QUIP_OUTDOOR_ZONES = new Set<string>([
  'street', 'park', 'fair', 'greenway', 'campus', 'botanical', 'lantern_garden', 'fountain_plaza', 'yard',
]);
const PROP_UNSAFE_OUTDOOR_ACTS = new Set<string>(['present', 'read', 'study', 'cook', 'wipe']);

function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

function isSofaAsset(asset: string): boolean {
  return asset === 'sofa' || asset.startsWith('sofa_');
}

function isBedAsset(asset: string): boolean {
  return asset === 'bed-single' || asset === 'canopy-bed' || asset.startsWith('bed_');
}

/** Floor check inside a Market Boulevard purchasable residence (independent of current ownership flag). */
function residenceFloorFree(b: EnterableBuilding, p: P, expectedY: number): number | null {
  let hitY: number | null = null;
  for (let i = 0; i < b.zones.length; i++) {
    const z = b.zones[i];
    if (z.y1 !== undefined) continue; // skip stair slope
    if (Math.abs(z.y - expectedY) > 0.35) continue;
    if (
      p.x >= z.rect.x0 + BODY_RADIUS &&
      p.x <= z.rect.x1 - BODY_RADIUS &&
      p.z >= z.rect.z0 + BODY_RADIUS &&
      p.z <= z.rect.z1 - BODY_RADIUS
    ) {
      hitY = z.y;
      break;
    }
  }
  if (hitY === null) return null;
  for (let i = 0; i < b.blocks.length; i++) {
    const r = b.blocks[i].rect;
    if (inRect(p, { x0: r.x0 - BODY_RADIUS, x1: r.x1 + BODY_RADIUS, z0: r.z0 - BODY_RADIUS, z1: r.z1 + BODY_RADIUS })) {
      return null;
    }
  }
  for (let i = 0; i < b.furniture.length; i++) {
    const f = b.furniture[i];
    if (
      f.footprint &&
      Math.abs(f.y - hitY) < 1.2 &&
      inRect(p, {
        x0: f.footprint.x0 - BODY_RADIUS,
        x1: f.footprint.x1 + BODY_RADIUS,
        z0: f.footprint.z0 - BODY_RADIUS,
        z1: f.footprint.z1 + BODY_RADIUS,
      })
    ) {
      return null;
    }
  }
  return hitY;
}

function isChairAsset(asset: string): boolean {
  return (
    asset === 'chair' ||
    asset === 'gaming-chair' ||
    asset === 'club_chair_veranda' ||
    asset === 'chair_ergo_gaming' ||
    asset.startsWith('chair_') ||
    asset.startsWith('club_chair_')
  );
}

function isDaybedAsset(asset: string): boolean {
  return asset === 'garden_daybed_veranda' || asset.startsWith('garden_daybed_');
}

function slotSuffixForOffset(side: number, total: number): string {
  if (total <= 1) return '';
  if (Math.abs(side) < 1e-3) return ':M';
  return side < 0 ? ':L' : ':R';
}

const UPPER_RESIDENCE_SEAT_ZONES = new Set(['bedroom', 'bath', 'balcony']);
const GROUND_RESIDENCE_SEAT_ZONES = new Set(['living', 'kitchen', 'study', 'gaming_room']);

function resolveWorkshopSeatWorldPos(
  nav: LifeNav,
  obj: WorkshopSeatObjectLike,
): { x: number; y: number; z: number; yaw: number; residence?: EnterableBuilding; zoneId: V3ZoneId } | null {
  const zone = obj.location.zoneId;
  if (!zone || obj.location.inStorage || !obj.placement) return null;
  const px = Number.isFinite(obj.placement.x) ? obj.placement.x : 0;
  const pz = Number.isFinite(obj.placement.z) ? obj.placement.z : 0;
  const pyaw = Number.isFinite(obj.placement.yaw) ? obj.placement.yaw : 0;
  const area = (v3Zones as Record<string, { size?: number; depth?: number } | undefined>)[zone];
  if (!area) return null;

  const propId = typeof obj.location.propertyId === 'string' ? obj.location.propertyId : undefined;
  if (propId && propId !== 'prop_student_flat') {
    const home = nav.city.residences.find((b) => b.property?.id === propId);
    if (!home) return null;
    let rect: Rect | null = null;
    let floorY = 0;
    if (UPPER_RESIDENCE_SEAT_ZONES.has(zone)) {
      const upper = home.zones.find((z) => z.id.endsWith(':upper'));
      if (!upper) return null;
      rect = upper.rect;
      floorY = upper.y;
    } else if (GROUND_RESIDENCE_SEAT_ZONES.has(zone)) {
      const main = home.zones.find((z) => z.id.endsWith(':main'));
      if (!main) return null;
      const hall = home.zones.find((z) => z.id.endsWith(':hall'));
      rect = hall
        ? {
            x0: Math.min(main.rect.x0, hall.rect.x0),
            x1: Math.max(main.rect.x1, hall.rect.x1),
            z0: Math.min(main.rect.z0, hall.rect.z0),
            z1: Math.max(main.rect.z1, hall.rect.z1),
          }
        : main.rect;
      floorY = main.y;
    } else {
      return null;
    }
    const sizeX = area.size || 6;
    const sizeZ = area.depth || sizeX;
    const x = (rect.x0 + rect.x1) * 0.5 + (px * (rect.x1 - rect.x0)) / sizeX;
    const z = (rect.z0 + rect.z1) * 0.5 + (pz * (rect.z1 - rect.z0)) / sizeZ;
    return { x, y: floorY, z, yaw: pyaw, residence: home, zoneId: home.id as V3ZoneId };
  }

  let rect: Rect | undefined;
  if (zone === 'study') {
    const h = nav.house.h;
    rect = { x0: -h, x1: h, z0: -h, z1: h };
  } else if (zone === 'yard') {
    rect = nav.city.ground.find((g) => g.zone === 'yard')?.rect;
  } else {
    rect = nav.house.zones.find((r) => r.id === zone)?.rect;
  }
  if (!rect) return null;
  const sizeX = area.size || 6;
  const sizeZ = area.depth || sizeX;
  const x = (rect.x0 + rect.x1) * 0.5 + (px * (rect.x1 - rect.x0)) / sizeX;
  const z = (rect.z0 + rect.z1) * 0.5 + (pz * (rect.z1 - rect.z0)) / sizeZ;
  const y = nav.walk.groundAt(x, z) ?? 0;
  return { x, y, z, yaw: pyaw, zoneId: zone as V3ZoneId };
}

/**
 * Collect every real sit-capable furnishing, outdoor 3-slot bench, bus shelter bench, botanical pergola bench,
 * patio bistro set, balcony/dining chair, and all 35 `city.aaaSeats` across the 31-zone world.
 */
export function collectSeats(nav: LifeNav): Seat[] {
  const out: Seat[] = [];
  const isFree = (p: { x: number; z: number }) => nav.walk.free(p);

  const tryAddPublic = (
    id: string,
    sitX: number,
    sitY: number,
    sitZ: number,
    yaw: number,
    standDist: number,
    cushion: number,
    isBed = false,
    tableTucked = false,
    mobility: 'stationary' | 'rolling' = 'stationary',
    allowStudyZone = false,
    isDynamicWorkshop = false,
  ) => {
    const resolved = resolveSeatStandPoint(
      { sit: { x: sitX, y: sitY, z: sitZ }, yaw, tableTucked },
      isFree,
      standDist,
    );
    if (resolved) {
      const zone = nav.walk.zone(resolved);
      const ground = nav.walk.groundAt(resolved.x, resolved.z);
      if (zone && (allowStudyZone || zone !== 'study') && ground !== null && Math.abs(ground - sitY) <= 0.35) {
        out.push({
          id,
          zone,
          stand: { x: resolved.x, z: resolved.z },
          sit: { x: sitX, y: ground, z: sitZ },
          top: ground + cushion,
          yaw,
          isBed,
          mobility,
          ...(isDynamicWorkshop ? { isDynamicWorkshop: true } : {}),
        });
        return;
      }
    }
    const angles = tableTucked ? TABLE_TUCKED_STAND_ANGLES : OPEN_SEAT_STAND_ANGLES;
    for (const d of [standDist, standDist + 0.16, standDist + 0.34, Math.max(0.42, standDist - 0.14)]) {
      for (const a of angles) {
        const s = Math.sin(yaw + a);
        const c = Math.cos(yaw + a);
        const stand = { x: sitX + s * d, z: sitZ + c * d };
        if (!nav.walk.free(stand)) continue;
        const zone = nav.walk.zone(stand);
        const ground = nav.walk.groundAt(stand.x, stand.z);
        if (!zone || (!allowStudyZone && zone === 'study') || ground === null || Math.abs(ground - sitY) > 0.35) continue;
        out.push({
          id,
          zone,
          stand,
          sit: { x: sitX, y: ground, z: sitZ },
          top: ground + cushion,
          yaw,
          isBed,
          mobility,
          ...(isDynamicWorkshop ? { isDynamicWorkshop: true } : {}),
        });
        return;
      }
    }
  };

  const tryAddResidence = (
    b: EnterableBuilding,
    id: string,
    sitX: number,
    sitY: number,
    sitZ: number,
    yaw: number,
    standDist: number,
    cushion: number,
    isBed = false,
    tableTucked = false,
    mobility: 'stationary' | 'rolling' = 'stationary',
    isDynamicWorkshop = false,
  ) => {
    const propId = b.property?.id;
    const angles = tableTucked ? TABLE_TUCKED_STAND_ANGLES : OPEN_SEAT_STAND_ANGLES;
    for (const d of [standDist, standDist + 0.22, standDist + 0.42, Math.max(0.48, standDist - 0.14)]) {
      for (const a of angles) {
        const s = Math.sin(yaw + a);
        const c = Math.cos(yaw + a);
        const stand = { x: sitX + s * d, z: sitZ + c * d };
        const ground = residenceFloorFree(b, stand, sitY);
        if (ground === null) continue;
        out.push({
          id,
          zone: b.id as V3ZoneId,
          stand,
          sit: { x: sitX, y: ground, z: sitZ },
          top: ground + cushion,
          yaw,
          propertyId: propId,
          isBed,
          mobility,
          ...(isDynamicWorkshop ? { isDynamicWorkshop: true } : {}),
        });
        return;
      }
    }
  };

  const addFurnishing = (
    prefix: string,
    idx: number,
    f: { asset: string; x: number; z: number; y: number; rotY: number; size: number },
    siblings: readonly { asset: string; x: number; z: number; y: number }[],
    residence?: EnterableBuilding,
  ) => {
    const rx = Math.cos(f.rotY);
    const rz = -Math.sin(f.rotY);
    const fx = Math.sin(f.rotY);
    const fz = Math.cos(f.rotY);
    const emit = residence
      ? (
          id: string,
          sx: number,
          sy: number,
          sz: number,
          yaw: number,
          dist: number,
          cush: number,
          isBed = false,
          tableTucked = false,
          mobility: 'stationary' | 'rolling' = 'stationary',
        ) => tryAddResidence(residence, id, sx, sy, sz, yaw, dist, cush, isBed, tableTucked, mobility)
      : (
          id: string,
          sx: number,
          sy: number,
          sz: number,
          yaw: number,
          dist: number,
          cush: number,
          isBed = false,
          tableTucked = false,
          mobility: 'stationary' | 'rolling' = 'stationary',
        ) => tryAddPublic(id, sx, sy, sz, yaw, dist, cush, isBed, tableTucked, mobility);

    if (
      isSofaAsset(f.asset) ||
      isDaybedAsset(f.asset) ||
      f.asset === 'bench' ||
      f.asset === 'bench-cushion' ||
      f.asset === 'cafe-booth'
    ) {
      const cushionHeight =
        f.asset === 'bench-cushion'
          ? 0.48
          : isDaybedAsset(f.asset)
            ? 0.46
            : Math.max(
                0.42,
                Math.min(
                  0.54,
                  f.size * (isSofaAsset(f.asset) ? 0.255 : ({ bench: 0.301, 'cafe-booth': 0.293 }[f.asset] ?? 0.3)),
                ),
              );
      const offsets: readonly number[] =
        isSofaAsset(f.asset) && f.size >= 1.75
          ? [-0.56, 0, 0.56]
          : isSofaAsset(f.asset) && f.size >= 1.35
            ? [-0.44, 0, 0.44]
            : f.size < 1.05
              ? [0]
              : [-0.38, 0.38];
      for (const side of offsets) {
        const suffix = offsets.length === 1 ? ':L' : slotSuffixForOffset(side, offsets.length);
        emit(
          `${prefix}:${idx}${suffix}`,
          f.x + rx * side + fx * 0.08,
          f.y,
          f.z + rz * side + fz * 0.08,
          f.rotY,
          0.76,
          cushionHeight,
          false,
          f.asset === 'cafe-booth',
          'stationary',
        );
      }
    } else if (isChairAsset(f.asset)) {
      const isRolling = f.asset === 'gaming-chair' || f.asset === 'chair_ergo_gaming';
      const rawCushion = f.size * (isRolling ? 0.745 : 0.78);
      const cushionHeight = Math.max(0.42, Math.min(0.56, rawCushion));
      const nearTable = siblings.some(
        (other) =>
          other !== f &&
          Math.abs(other.y - f.y) <= 0.35 &&
          /table|desk|island|workbench/i.test(other.asset) &&
          Math.hypot(other.x - (f.x + fx * 0.65), other.z - (f.z + fz * 0.65)) < 0.95,
      );
      emit(
        `${prefix}:${idx}`,
        f.x,
        f.y,
        f.z,
        f.rotY,
        0.68,
        cushionHeight,
        false,
        nearTable,
        isRolling ? 'rolling' : 'stationary',
      );
    } else if (residence && isBedAsset(f.asset)) {
      // Register sittable bedside edge inside Market Boulevard residences so upper bedrooms are interactive
      emit(
        `${prefix}:bed:${idx}`,
        f.x + fx * 0.15,
        f.y,
        f.z + fz * 0.15,
        f.rotY,
        1.15,
        0.52,
        true,
        false,
        'stationary',
      );
    }
  };

  nav.house.furniture.forEach((f, i, list) => addFurnishing('house', i, f, list));
  // Ensure Terrace Balcony (`balcony/balcony_table` `'rest'`) always has a sittable veranda seat even if `plan.ts` has no explicit chair yet.
  if (!out.some((s) => s.zone === 'balcony')) {
    const balTable = nav.house.furniture.find((f) => f.asset === 'balcony-table');
    if (balTable) {
      tryAddPublic(
        'house:balcony:0',
        balTable.x,
        balTable.y,
        balTable.z + 0.62,
        Math.PI,
        0.56,
        0.45,
        false,
        true,
        'stationary',
      );
    }
  }

  for (const b of nav.city.buildings) {
    b.furniture.forEach((f, i, list) => addFurnishing(`b:${b.id}`, i, f, list));
  }
  for (const res of nav.city.residences) {
    const tag = `res:${res.property?.id ?? res.id}`;
    res.furniture.forEach((f, i, list) => addFurnishing(tag, i, f, list, res));
    // Ensure every Market Blvd residence dining table has 2 approachable dining seats if no explicit chairs exist yet.
    res.furniture.forEach((f, i) => {
      if (f.asset !== 'table') return;
      const hasNearbyChair = out.some(
        (s) => s.propertyId === res.property?.id && !s.isBed && Math.hypot(s.sit.x - f.x, s.sit.z - f.z) < 1.35,
      );
      if (hasNearbyChair) return;
      for (const side of [-1, 1] as const) {
        tryAddResidence(
          res,
          `${tag}:dining:${i}:${side < 0 ? 'L' : 'R'}`,
          f.x,
          f.y,
          f.z + side * 0.62,
          side < 0 ? 0 : Math.PI,
          0.62,
          0.46,
          false,
          true,
          'stationary',
        );
      }
    });
  }

  nav.city.props.forEach((p, i) => {
    const py = nav.walk.groundAt(p.x, p.z) ?? -3.2;
    if (p.kind === 'bench') {
      const benchYaw = p.rotY + STREET_BENCH_SEAT_GEOMETRY.yawOffset;
      const fx = Math.sin(benchYaw);
      const fz = Math.cos(benchYaw);
      const rx = Math.cos(benchYaw);
      const rz = -Math.sin(benchYaw);
      const fwd = STREET_BENCH_SEAT_GEOMETRY.forwardOffset;
      const offsets = STREET_BENCH_SEAT_GEOMETRY.slotLateralOffsets;
      for (const side of offsets) {
        tryAddPublic(
          `prop:bench:${i}${slotSuffixForOffset(side, offsets.length)}`,
          p.x + rx * side + fx * fwd,
          py,
          p.z + rz * side + fz * fwd,
          benchYaw,
          STREET_BENCH_SEAT_GEOMETRY.standDist,
          STREET_BENCH_SEAT_GEOMETRY.seatTopOffset,
          false,
          false,
        );
      }
    } else if (p.kind === 'shelter') {
      const shelterYaw = p.rotY + BUS_SHELTER_SEAT_GEOMETRY.yawOffset;
      const fx = Math.sin(shelterYaw);
      const fz = Math.cos(shelterYaw);
      const rx = Math.cos(shelterYaw);
      const rz = -Math.sin(shelterYaw);
      const fwd = BUS_SHELTER_SEAT_GEOMETRY.forwardOffset;
      const offsets = BUS_SHELTER_SEAT_GEOMETRY.slotLateralOffsets;
      for (const side of offsets) {
        tryAddPublic(
          `prop:shelter:${i}${slotSuffixForOffset(side, offsets.length)}`,
          p.x + rx * side + fx * fwd,
          py,
          p.z + rz * side + fz * fwd,
          shelterYaw,
          BUS_SHELTER_SEAT_GEOMETRY.standDist,
          BUS_SHELTER_SEAT_GEOMETRY.seatTopOffset,
          false,
          false,
        );
      }
    } else if (p.asset === 'park-gazebo') {
      const gazeboYaw = p.rotY + PERGOLA_BENCH_SEAT_GEOMETRY.yawOffset;
      const fx = Math.sin(gazeboYaw);
      const fz = Math.cos(gazeboYaw);
      const rx = Math.cos(gazeboYaw);
      const rz = -Math.sin(gazeboYaw);
      const fwd = PERGOLA_BENCH_SEAT_GEOMETRY.forwardOffset;
      const offsets = PERGOLA_BENCH_SEAT_GEOMETRY.slotLateralOffsets;
      for (const side of offsets) {
        tryAddPublic(
          `prop:gazebo:${i}${slotSuffixForOffset(side, offsets.length)}`,
          p.x + rx * side + fx * fwd,
          py,
          p.z + rz * side + fz * fwd,
          gazeboYaw,
          PERGOLA_BENCH_SEAT_GEOMETRY.standDist,
          PERGOLA_BENCH_SEAT_GEOMETRY.seatTopOffset,
          false,
          false,
        );
      }
    } else if (p.asset === 'patio-set') {
      const s = (p.scaleVal ?? 1.8) / PATIO_BISTRO_SEAT_GEOMETRY.spanDenom;
      const fx = Math.sin(p.rotY);
      const fz = Math.cos(p.rotY);
      const cushion = Math.max(0.42, Math.min(0.52, PATIO_BISTRO_SEAT_GEOMETRY.seatTopFactor * s));
      tryAddPublic(
        `prop:patio:${i}:A`,
        p.x + fx * (PATIO_BISTRO_SEAT_GEOMETRY.chairAOffset * s),
        py,
        p.z + fz * (PATIO_BISTRO_SEAT_GEOMETRY.chairAOffset * s),
        p.rotY,
        PATIO_BISTRO_SEAT_GEOMETRY.standDist,
        cushion,
        false,
        true,
      );
      tryAddPublic(
        `prop:patio:${i}:B`,
        p.x + fx * (PATIO_BISTRO_SEAT_GEOMETRY.chairBOffset * s),
        py,
        p.z + fz * (PATIO_BISTRO_SEAT_GEOMETRY.chairBOffset * s),
        p.rotY + Math.PI,
        PATIO_BISTRO_SEAT_GEOMETRY.standDist,
        cushion,
        false,
        true,
      );
    }
  });

  // Register all 35 verified AAA seats (Library 1F/2F reading chairs and armchairs, Pixel Cafe bistro sets and armchairs, sidewalk patios)
  const aaaSeats = nav.city.aaaSeats ?? [];
  for (let i = 0; i < aaaSeats.length; i++) {
    const spec = aaaSeats[i];
    const preferredDist = spec.tableTucked ? 0.54 : 0.66;
    const stand = resolveSeatStandPoint(spec, isFree, preferredDist);
    if (!stand) continue;
    const ground = nav.walk.groundAt(stand.x, stand.z);
    if (ground === null || Math.abs(ground - spec.sit.y) > 0.35) continue;
    out.push({
      id: spec.id,
      zone: spec.zone as V3ZoneId,
      stand: { x: stand.x, z: stand.z },
      sit: { x: spec.sit.x, y: ground, z: spec.sit.z },
      top: spec.top,
      yaw: spec.yaw,
      isBed: false,
      mobility: 'stationary',
    });
  }

  return out;
}

/**
 * Builds dynamic `Seat` entries for player-placed Build Studio / Workshop furnishings (`sofa_*`,
 * `club_chair_*`, `chair_*`, `garden_daybed_*`, `bed_*`) AND relocated `obj_starter_sofa` / `obj_starter_bed`.
 */
export function buildDynamicWorkshopSeats(
  nav: LifeNav,
  ownedObjects: readonly WorkshopSeatObjectLike[] | null | undefined,
  starterOverrides?: Readonly<Record<string, StarterSeatOverrideLike>> | null,
): { seats: Seat[]; replacedStarterSofa: boolean } {
  const dynamicSeats: Seat[] = [];
  let replacedStarterSofa = false;
  const isFree = (p: { x: number; z: number }) => nav.walk.free(p);

  const emitDynamic = (
    id: string,
    sitX: number,
    sitY: number,
    sitZ: number,
    yaw: number,
    standDist: number,
    cushion: number,
    isBed: boolean,
    mobility: 'stationary' | 'rolling',
    residence?: EnterableBuilding,
  ) => {
    if (residence) {
      const propId = residence.property?.id;
      for (const d of [standDist, standDist + 0.22, standDist + 0.42, Math.max(0.48, standDist - 0.14)]) {
        for (const a of OPEN_SEAT_STAND_ANGLES) {
          const stand = { x: sitX + Math.sin(yaw + a) * d, z: sitZ + Math.cos(yaw + a) * d };
          const ground = residenceFloorFree(residence, stand, sitY);
          if (ground === null) continue;
          dynamicSeats.push({
            id,
            zone: residence.id as V3ZoneId,
            stand,
            sit: { x: sitX, y: ground, z: sitZ },
            top: ground + cushion,
            yaw,
            propertyId: propId,
            isBed,
            mobility,
            isDynamicWorkshop: true,
          });
          return;
        }
      }
      return;
    }

    const resolved = resolveSeatStandPoint({ sit: { x: sitX, y: sitY, z: sitZ }, yaw, tableTucked: false }, isFree, standDist);
    const candidates = resolved ? [resolved] : [];
    for (const d of [standDist, standDist + 0.18, standDist + 0.36, Math.max(0.42, standDist - 0.14)]) {
      for (const a of OPEN_SEAT_STAND_ANGLES) {
        candidates.push({ x: sitX + Math.sin(yaw + a) * d, y: sitY, z: sitZ + Math.cos(yaw + a) * d });
      }
    }
    for (const stand of candidates) {
      if (!nav.walk.free(stand)) continue;
      const zone = nav.walk.zone(stand);
      const ground = nav.walk.groundAt(stand.x, stand.z);
      if (!zone || ground === null || Math.abs(ground - sitY) > 0.35) continue;
      dynamicSeats.push({
        id,
        zone,
        stand: { x: stand.x, z: stand.z },
        sit: { x: sitX, y: ground, z: sitZ },
        top: ground + cushion,
        yaw,
        isBed,
        mobility,
        isDynamicWorkshop: true,
      });
      return;
    }
  };

  // 1. Explicit `starterOverrides` on `obj_starter_sofa` (`lifeMeta.starterFurniture`).
  const sofaOverride = starterOverrides?.obj_starter_sofa;
  if (sofaOverride && Number.isFinite(sofaOverride.x + sofaOverride.z)) {
    replacedStarterSofa = true;
    const yaw = Number.isFinite(sofaOverride.rotY) ? sofaOverride.rotY : 0;
    const y = sofaOverride.y ?? nav.walk.groundAt(sofaOverride.x, sofaOverride.z) ?? 0;
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    for (const side of [-0.56, 0, 0.56] as const) {
      emitDynamic(
        `owned:obj_starter_sofa${slotSuffixForOffset(side, 3)}`,
        sofaOverride.x + rx * side + fx * 0.08,
        y,
        sofaOverride.z + rz * side + fz * 0.08,
        yaw,
        0.76,
        0.48,
        false,
        'stationary',
      );
    }
  }

  // 2. Placed Workshop `ownedObjects` (`sofa_*`, `club_chair_*`, `chair_*`, `garden_daybed_*`, `bed_*`).
  for (const obj of ownedObjects ?? []) {
    if (!obj || obj.location?.inStorage || !obj.location?.zoneId) continue;
    if (obj.instanceId === 'obj_starter_sofa') {
      if (sofaOverride) continue;
      // Unmodified starter sofa at default home position already uses `house:0:*` unless upgraded/relocated into another zone.
      if (!obj.upgradeLevel && obj.location.zoneId === 'living' && (!obj.location.propertyId || obj.location.propertyId === 'prop_student_flat')) {
        continue;
      }
      replacedStarterSofa = true;
    }
    if (
      obj.instanceId === 'obj_starter_bed' ||
      obj.instanceId === 'obj_starter_fridge' ||
      obj.instanceId === 'obj_starter_stove' ||
      obj.instanceId === 'obj_starter_wardrobe'
    ) {
      continue;
    }

    const variant = obj.selectedVariantId || '';
    const isSofa = isSofaAsset(variant);
    const isDaybed = isDaybedAsset(variant);
    const isChair = isChairAsset(variant);
    const isBed = isBedAsset(variant);
    if (!isSofa && !isDaybed && !isChair && !isBed) continue;

    const placed = resolveWorkshopSeatWorldPos(nav, obj);
    if (!placed) continue;
    const rx = Math.cos(placed.yaw);
    const rz = -Math.sin(placed.yaw);
    const fx = Math.sin(placed.yaw);
    const fz = Math.cos(placed.yaw);

    if (isSofa || isDaybed) {
      const offsets: readonly number[] = isSofa ? [-0.56, 0, 0.56] : [-0.42, 0.42];
      const cush = isSofa ? 0.48 : 0.46;
      for (const side of offsets) {
        emitDynamic(
          `owned:${obj.instanceId}${slotSuffixForOffset(side, offsets.length)}`,
          placed.x + rx * side + fx * 0.08,
          placed.y,
          placed.z + rz * side + fz * 0.08,
          placed.yaw,
          0.76,
          cush,
          false,
          'stationary',
          placed.residence,
        );
      }
    } else if (isChair) {
      const rolling = variant.includes('gaming') || variant.includes('ergo');
      emitDynamic(
        `owned:${obj.instanceId}`,
        placed.x,
        placed.y,
        placed.z,
        placed.yaw,
        0.68,
        0.48,
        false,
        rolling ? 'rolling' : 'stationary',
        placed.residence,
      );
    } else if (isBed) {
      emitDynamic(
        `owned:${obj.instanceId}:bed`,
        placed.x + fx * 0.15,
        placed.y,
        placed.z + fz * 0.15,
        placed.yaw,
        1.1,
        0.52,
        true,
        'stationary',
        placed.residence,
      );
    }
  }

  return { seats: dynamicSeats, replacedStarterSofa };
}

/**
 * Pure helper combining static world seats with live Workshop `ownedObjects` & `starterOverrides`.
 */
export function rebuildDynamicWorkshopSeats(
  nav: LifeNav,
  staticSeats: readonly Seat[],
  ownedObjects: readonly WorkshopSeatObjectLike[] | null | undefined,
  starterOverrides?: Readonly<Record<string, StarterSeatOverrideLike>> | null,
): Seat[] {
  const { seats: dynSeats, replacedStarterSofa } = buildDynamicWorkshopSeats(nav, ownedObjects, starterOverrides);
  const starterSofaIdx = nav.house.furniture.findIndex((f) => isSofaAsset(f.asset));
  const starterSofaPrefix = starterSofaIdx >= 0 ? `house:${starterSofaIdx}:` : null;
  const base = replacedStarterSofa
    ? staticSeats.filter((s) => !s.isDynamicWorkshop && (!starterSofaPrefix || !s.id.startsWith(starterSofaPrefix)))
    : staticSeats.filter((s) => !s.isDynamicWorkshop);
  return [...base, ...dynSeats];
}

/** Collect walkable covered outdoor shelter spots (bus shelters, gazebos, colonnades) for passing rain showers. */
function collectShelters(nav: LifeNav): ShelterAnchor[] {
  const out: ShelterAnchor[] = [];
  nav.city.props.forEach((p, i) => {
    if (p.kind !== 'shelter' && p.asset !== 'park-gazebo' && p.asset !== 'campus-colonnade') return;
    const fx = Math.sin(p.rotY);
    const fz = Math.cos(p.rotY);
    const r = p.radius + BODY_RADIUS + 0.38;
    for (const [ox, oz] of [[fx * r, fz * r], [-fx * r, -fz * r], [fz * r, -fx * r], [-fz * r, fx * r]]) {
      const cand = { x: p.x + ox, z: p.z + oz };
      if (!nav.walk.free(cand)) continue;
      const z = nav.walk.zone(cand);
      if (z && z !== 'study') {
        out.push({ id: `shelter:${i}`, zone: z, x: cand.x, z: cand.z });
        return;
      }
    }
  });
  return out;
}

/** Precompute verified walkable behind-counter standing spots & customer-facing yaws for all shopkeepers (A09). */
function collectShopkeeperAnchors(nav: LifeNav): Map<string, { zone: V3ZoneId; pos: P; yaw: number }> {
  const out = new Map<string, { zone: V3ZoneId; pos: P; yaw: number }>();
  const buildingById = new Map(nav.city.buildings.map(b => [b.id, b]));

  for (const [id, spec] of Object.entries(SHOPKEEPER_COUNTERS)) {
    const b = buildingById.get(spec.zone as EnterableBuilding['id']);
    if (!b) continue;
    const counter = b.furniture.find(f => spec.assets.includes(f.asset));
    if (!counter) continue;

    const fx = Math.sin(counter.rotY);
    const fz = Math.cos(counter.rotY);
    const rx = Math.cos(counter.rotY);
    const rz = -Math.sin(counter.rotY);
    const halfW = counter.footprint ? (counter.footprint.x1 - counter.footprint.x0) * 0.5 : 0.7;
    const halfD = counter.footprint ? (counter.footprint.z1 - counter.footprint.z0) * 0.5 : 0.5;
    const clearBack = Math.abs(fx) * halfW + Math.abs(fz) * halfD + BODY_RADIUS + 0.22;
    const clearSide = Math.abs(rx) * halfW + Math.abs(rz) * halfD + BODY_RADIUS + 0.22;

    // Prefer behind counter (-forward), then flanking sides, then just in front facing entrance
    const probes: P[] = [
      { x: counter.x - fx * clearBack, z: counter.z - fz * clearBack },
      { x: counter.x - fx * (clearBack + 0.25), z: counter.z - fz * (clearBack + 0.25) },
      { x: counter.x + rx * clearSide, z: counter.z + rz * clearSide },
      { x: counter.x - rx * clearSide, z: counter.z - rz * clearSide },
      { x: counter.x + fx * clearBack, z: counter.z + fz * clearBack },
    ];
    for (const p of probes) {
      if (!nav.walk.free(p)) continue;
      if (nav.walk.zone(p) !== spec.zone) continue;
      const yaw = Math.atan2(b.entryPoint.x - p.x, b.entryPoint.z - p.z);
      out.set(id, { zone: spec.zone, pos: p, yaw });
      break;
    }
  }
  return out;
}

/**
 * Precompute floor-proven FIFO counter queue chains (<= 5 slots, 0.85 m spacing) at
 * `market`, `bistro`, `library`, and `cafe`. Every slot is strictly walkable (`nav.walk.free`),
 * inside the venue zone, clear of doorways (>= 1.35 m), and step-connected via `nav.clear`.
 */
function collectCounterQueues(
  nav: LifeNav,
  shopAnchors: Map<string, { zone: V3ZoneId; pos: P; yaw: number }>,
): Map<V3ZoneId, CounterQueueState> {
  const out = new Map<V3ZoneId, CounterQueueState>();
  const buildingById = new Map(nav.city.buildings.map(b => [b.id, b]));

  for (const spec of QUEUE_VENUES) {
    const b = buildingById.get(spec.zone as EnterableBuilding['id']);
    if (!b) continue;
    const counter = b.furniture.find(f => spec.assets.includes(f.asset));
    if (!counter) continue;

    const shop = shopAnchors.get(spec.shopkeeperId);
    const fx = Math.sin(counter.rotY);
    const fz = Math.cos(counter.rotY);
    const rx = Math.cos(counter.rotY);
    const rz = -Math.sin(counter.rotY);
    const halfW = counter.footprint ? (counter.footprint.x1 - counter.footprint.x0) * 0.5 : 0.7;
    const halfD = counter.footprint ? (counter.footprint.z1 - counter.footprint.z0) * 0.5 : 0.5;
    const clearFront = Math.abs(fx) * halfW + Math.abs(fz) * halfD + BODY_RADIUS + 0.34;
    const clearSide = Math.abs(rx) * halfW + Math.abs(rz) * halfD + BODY_RADIUS + 0.34;
    const counterY = counter.y;

    const isSlotOk = (p: P): boolean => {
      if (!nav.walk.free(p)) return false;
      if (nav.walk.zone(p) !== spec.zone) return false;
      const gy = nav.walk.groundAt(p.x, p.z);
      if (gy === null || Math.abs(gy - counterY) > 0.25) return false;
      if (Math.hypot(p.x - b.door.x, p.z - b.door.z) < 1.35) return false;
      if (shop && Math.hypot(p.x - shop.pos.x, p.z - shop.pos.z) < 0.75) return false;
      return true;
    };

    // Find slot 0 on the customer-facing side of the counter (closest to entrance, away from shopkeeper)
    const dirToEntryX = b.entryPoint.x - counter.x;
    const dirToEntryZ = b.entryPoint.z - counter.z;
    const entryLen = Math.hypot(dirToEntryX, dirToEntryZ) || 1;
    const ex = dirToEntryX / entryLen;
    const ez = dirToEntryZ / entryLen;
    const clearEntry = Math.abs(ex) * halfW + Math.abs(ez) * halfD + BODY_RADIUS + 0.34;

    const headProbes: P[] = [
      { x: counter.x + fx * clearFront, z: counter.z + fz * clearFront },
      { x: counter.x + ex * clearEntry, z: counter.z + ez * clearEntry },
      { x: counter.x + rx * clearSide, z: counter.z + rz * clearSide },
      { x: counter.x - rx * clearSide, z: counter.z - rz * clearSide },
      { x: counter.x - fx * clearFront, z: counter.z - fz * clearFront },
    ];
    let head: P | null = null;
    for (const cand of headProbes) {
      if (isSlotOk(cand)) {
        head = cand;
        break;
      }
    }
    if (!head) continue;

    const slots: CounterQueueSlot[] = [
      { x: head.x, z: head.z, yaw: Math.atan2(counter.x - head.x, counter.z - head.z) },
    ];

    // Extend tail slots spaced 0.85 m apart along walkable interior directions
    const stepDirs: [number, number][] = [
      [ex, ez],
      [fx, fz],
      [rx, rz],
      [-rx, -rz],
      [-ez, ex],
      [ez, -ex],
    ];
    while (slots.length < QUEUE_MAX_SLOTS) {
      const prev = slots[slots.length - 1];
      let placed: CounterQueueSlot | null = null;
      for (let dIdx = 0; dIdx < stepDirs.length; dIdx++) {
        const [dx, dz] = stepDirs[dIdx];
        const cand = { x: prev.x + dx * QUEUE_SPACING, z: prev.z + dz * QUEUE_SPACING };
        if (!isSlotOk(cand)) continue;
        if (slots.some(s => Math.hypot(s.x - cand.x, s.z - cand.z) < QUEUE_SPACING - 0.05)) continue;
        if (!nav.clear(prev, cand)) continue;
        placed = { x: cand.x, z: cand.z, yaw: Math.atan2(prev.x - cand.x, prev.z - cand.z) };
        break;
      }
      if (!placed) break;
      slots.push(placed);
    }

    if (slots.length >= 2) {
      out.set(spec.zone, { zone: spec.zone, shopkeeperId: spec.shopkeeperId, slots, entries: [] });
    }
  }
  return out;
}

export class PeopleSim {
  readonly walkers = new Map<string, Walker>();
  readonly seats: Seat[];
  readonly mind = new NpcMindEngine();
  readonly social = new SocialSimEngine();
  readonly zoneGraph: ZoneTravelGraph;

  private readonly staticSeats: readonly Seat[];
  private readonly seatsByZone = new Map<V3ZoneId, Seat[]>();
  private readonly spots = new Map<V3ZoneId, P[]>();
  private readonly shelters: ShelterAnchor[];
  private readonly shopAnchors: Map<string, { zone: V3ZoneId; pos: P; yaw: number }>;
  private readonly counterQueues: Map<V3ZoneId, CounterQueueState>;
  private readonly roadAndCrossingRects: Rect[];
  private readonly doorPlans: Map<string, { x: number; z: number }>;
  private readonly mirroredPathMeta = new Map<string, { route: Route | null; ri: number; moving: boolean }>();
  private readonly claimedSeatsScratch = new Set<string>();
  private readonly socialViewsScratch: SocialParticipantView[] = [];
  private readonly activeScenesZonesScratch = new Set<string>();
  private readonly activeSceneActorsScratch = new Set<string>();
  private readonly stimuli: WorldStimulus[] = [];
  private readonly hazardsScratch: (VehicleHazard & { isPlayer?: boolean })[] = [];
  private readonly residentHash = new SpatialHash2D(32, 2.5);
  private readonly orca = new OrcaScratch();
  private readonly resPosX = new Float32Array(32);
  private readonly resPosZ = new Float32Array(32);
  private readonly resVelX = new Float32Array(32);
  private readonly resVelZ = new Float32Array(32);
  private readonly residentKinematics: {
    readonly posX: Float32Array;
    readonly posZ: Float32Array;
    readonly velX: Float32Array;
    readonly velZ: Float32Array;
    count: number;
  };
  private readonly probeScratch: P = { x: 0, z: 0 };
  private walkerList: Walker[] = [];
  private socialDirectives = new Map<ResidentId, SocialMemberDirective>();

  private frame = 0;
  private elapsed = 0;
  private sceneTimer = 0;
  private lastClock = -1;
  private lastEnvPhase: EnvSnapshot['phase'] | null = null;
  private lastEnvHour: number | null = null;
  private lastPrecipMode: PrecipMode | null = null;
  private lastPlayer: P | null = null;
  private playerSpeed = 0;
  private playerVx = 0;
  private playerVz = 0;
  private playerGroundY = 0;
  private lastHornAt = -999;
  private envOverride: Partial<EnvSnapshot> | null = null;
  private playerVehicle: PlayerVehicleState | null = null;
  private trafficVehicles: readonly VehicleHazard[] = [];
  private parkedVehicles: readonly ParkedVehicleObstacle[] = [];
  private staticCurbVehicles: readonly ParkedVehicleObstacle[] = [];
  private _groupBanter: OverheardBanter | null = null;
  private _quipBanter: OverheardBanter | null = null;

  /**
   * Closest unobtrusive English overheard banter line (< 7.5 m, null when quiet).
   * Prefers active emergent multi-NPC group banter; otherwise surfaces a nearby resident's active quip.
   */
  get overheardBanter(): OverheardBanter | null {
    return this._groupBanter ?? this._quipBanter;
  }

  stats: PeopleStats = {
    walking: 0,
    routes: 0,
    doorsOpened: 0,
    scenes: [],
    seated: 0,
    tiers: [0, 0, 0, 0],
    emergentGroups: 0,
    abstractTrips: 0,
  };
  /** The resident the learner is talking to: they stop where they are and face the learner until the talk ends. */
  talking: string | null = null;
  /** Seat ID currently occupied by the player (never claimed by NPCs or ambient crowd). */
  playerSeat: string | null = null;

  constructor(private readonly nav: LifeNav, private readonly doors: DoorPort) {
    this.seats = collectSeats(nav);
    this.staticSeats = [...this.seats];
    for (const s of this.seats) {
      const list = this.seatsByZone.get(s.zone);
      if (list) list.push(s);
      else this.seatsByZone.set(s.zone, [s]);
    }
    this.shelters = collectShelters(nav);
    this.shopAnchors = collectShopkeeperAnchors(nav);
    this.counterQueues = collectCounterQueues(nav, this.shopAnchors);
    this.roadAndCrossingRects = nav.city.ground
      .filter(g => g.surface === 'road' || g.surface === 'crossing')
      .map(g => g.rect);
    this.doorPlans = new Map(nav.doors.map(d => [d.id as string, { x: d.x, z: d.z }]));
    this.zoneGraph = new ZoneTravelGraph(nav);
    this.residentKinematics = {
      posX: this.resPosX,
      posZ: this.resPosZ,
      velX: this.resVelX,
      velZ: this.resVelZ,
      count: 0,
    };
  }

  // ── External Host / Session Hooks ───────────────────────────────────────────────────────────────────────

  /**
   * Reconciles live Workshop `ownedObjects` & `starterOverrides` into `this.seats` and `this.seatsByZone`
   * in-place without losing static world seating.
   */
  rebuildDynamicWorkshopSeats(
    ownedObjects: readonly WorkshopSeatObjectLike[] | null | undefined,
    starterOverrides?: Readonly<Record<string, StarterSeatOverrideLike>> | null,
  ): Seat[] {
    const next = rebuildDynamicWorkshopSeats(this.nav, this.staticSeats, ownedObjects, starterOverrides);
    this.seats.length = 0;
    this.seats.push(...next);
    this.seatsByZone.clear();
    for (const s of this.seats) {
      const list = this.seatsByZone.get(s.zone);
      if (list) list.push(s);
      else this.seatsByZone.set(s.zone, [s]);
    }
    return this.seats;
  }

  /**
   * Immediately expire all cached resident quips, transient mind reactions, and overheard banter.
   * Invoked on time-of-day phase changes, > 2 h clock jumps (`setTimeOfDay`), or dry/precipitation transitions
   * so morning or fair-weather quips never linger into evening/night or rainstorms.
   */
  clearStaleQuips(): void {
    for (let i = 0; i < this.walkerList.length; i++) {
      const w = this.walkerList[i];
      w.quip = null;
      w.quipUntil = 0;
      w.nextAiEvalAt = 0;
    }
    this.mind.clearTransientQuips();
    for (const g of this.social.groups.values()) {
      g.banterText = null;
      g.banterUntilElapsed = 0;
    }
    this._groupBanter = null;
    this._quipBanter = null;
  }

  /** Supply live weather/season overrides from `gameHost.sky()`. */
  setEnv(env: Partial<EnvSnapshot> | null): void {
    const nextPhase = env?.phase ?? null;
    const nextHour = typeof env?.hour === 'number' && Number.isFinite(env.hour) ? env.hour : null;
    const nextPrecip = precipModeOf(env);
    const phaseChanged =
      nextPhase !== null && this.lastEnvPhase !== null && nextPhase !== this.lastEnvPhase;
    const hourJumped =
      nextHour !== null && this.lastEnvHour !== null && circularHourDiff(nextHour, this.lastEnvHour) > 2;
    const precipChanged =
      nextPrecip !== null && this.lastPrecipMode !== null && nextPrecip !== this.lastPrecipMode;
    this.envOverride = env;
    if (nextPhase !== null) this.lastEnvPhase = nextPhase;
    if (nextHour !== null) this.lastEnvHour = nextHour;
    if (nextPrecip !== null) this.lastPrecipMode = nextPrecip;
    if (phaseChanged || hourJumped || precipChanged) {
      this.clearStaleQuips();
    }
  }

  /** Supply live driven vehicle pose & speed so nearby residents comment or yield naturally. */
  setPlayerVehicle(v: PlayerVehicleState | null): void {
    this.playerVehicle = v;
  }

  /** Supply live ambient commuter traffic vehicles for resident crosswalk curb-waiting & avoidance. */
  setTrafficVehicles(hazards: readonly VehicleHazard[]): void {
    this.trafficVehicles = hazards;
  }

  /** Supply dynamic stationary parked vehicles (player car, two-wheeler, stopped traffic) for smooth resident avoidance. */
  setParkedVehicles(obstacles: readonly ParkedVehicleObstacle[]): void {
    this.parkedVehicles = obstacles;
  }

  /**
   * Supply the 6 static curb-parked cars ONCE from `WorkshopView`/`GameHost` so per-frame
   * `setParkedVehicles([car, twoWheeler, ...stoppedTraffic])` calls never clobber them!
   */
  setStaticCurbVehicles(obstacles: readonly ParkedVehicleObstacle[]): void {
    this.staticCurbVehicles = obstacles;
  }

  getStaticCurbVehicles(): readonly ParkedVehicleObstacle[] {
    return this.staticCurbVehicles;
  }

  /** Returns the zero-allocation 22-resident kinematic snapshot for `CrowdSim` and `TrafficSim`. */
  getResidentKinematics(): ResidentKinematicsView {
    return this.residentKinematics;
  }

  /** Adjusts city street traffic density multiplier (clamped `0.3..1.5`, for Manage City). */
  setTrafficDensityMultiplier(mult: number): number {
    return setTrafficSimDensityMultiplier(mult);
  }

  /** Broadcast a player car horn honk to nearby Tier 0 residents (radius 14 m). */
  notifyHorn(x: number, z: number, yaw = 0, vehicleName = 'car'): void {
    this.lastHornAt = this.elapsed;
    this.pushStimulus({ kind: 'horn', x, z, yaw, elapsed: this.elapsed, vehicleName });
  }

  /** Broadcast a player basketball shot or score to nearby park/greenway residents (radius 18 m). */
  notifyBasketballShot(x: number, z: number, scored: boolean, streak = 1): void {
    if (scored) {
      this.pushStimulus({ kind: 'basketball_score', x, z, streak: Math.max(1, streak), elapsed: this.elapsed });
      this.mind.adjustDistrictReputation('park', streak >= 2 ? 2 : 1);
    } else {
      this.pushStimulus({ kind: 'basketball_play', x, z, elapsed: this.elapsed });
    }
  }

  /** Adjusts city pedestrian density multiplier (clamped `0.3..1.5`, for Manage City). */
  setPedestrianDensityMultiplier(mult: number): number {
    return setCrowdDensityMultiplier(mult);
  }

  /** Record a player conversation/gift/shared-activity event directly into the resident's episodic memory. */
  notifyPlayerInteraction(s: V3State, npcId: string, kind: 'talk' | 'gift' | 'activity', subject = ''): void {
    if (!isResidentId(npcId)) return;
    this.mind.syncV3Memories(s, npcId);
    const w = this.walkers.get(npcId);
    const memKind = kind === 'gift' ? 'player_gift' : kind === 'activity' ? 'player_shared_activity' : 'player_talk';
    this.mind.recordMemory(
      npcId,
      {
        kind: memKind,
        day: s.day,
        clock: s.clock,
        subject: subject || kind,
        valence: 0.65,
        salience: kind === 'talk' ? 0.5 : 0.82,
        zone: w?.zone ?? s.player?.zone,
      },
      kind !== 'talk',
    );
    if (w?.zone) {
      this.mind.adjustDistrictReputation(w.zone, kind === 'talk' ? 1 : 3);
    }
  }

  /** Record a completed career shift into local coworkers' episodic memories and boost district reputation. */
  recordShiftMemory(s: V3State, jobId: string, zone: string, quality?: string): void {
    const cleanJob = (jobId || 'shift').slice(0, 24);
    const subject = quality ? `${cleanJob}:${quality.slice(0, 10)}` : cleanJob;
    const witnesses = new Set<ResidentId>();

    // Shopkeeper / district mentor always notices shifts in their venue
    for (const [id, spec] of Object.entries(SHOPKEEPER_COUNTERS)) {
      if (spec.zone === zone && isResidentId(id)) witnesses.add(id);
    }
    if (zone === 'botanical') witnesses.add('ngocbich');
    if (zone === 'fountain_plaza') witnesses.add('haidang');
    if (zone === 'campus') witnesses.add('lan');

    // Residents currently present in that zone also witness the shift
    for (let i = 0; i < this.walkerList.length; i++) {
      const w = this.walkerList[i];
      if (w.zone === zone && isResidentId(w.id)) witnesses.add(w.id);
    }

    for (const id of witnesses) {
      this.mind.recordMemory(
        id,
        {
          kind: 'player_shared_activity',
          day: s.day,
          clock: s.clock,
          subject,
          valence: 0.85,
          salience: 0.84,
          zone,
        },
        true,
      );
      const w = this.walkers.get(id);
      if (w && w.zone === zone) {
        w.quip = 'Smooth shift out there — great pace!';
        w.quipUntil = this.elapsed + 3.0;
      }
    }

    const qLow = (quality ?? '').toLowerCase();
    const repDelta = qLow === 'excellent' || qLow === 'perfect' || qLow === 'rush' ? 8 : qLow === 'basic' ? 4 : 6;
    this.mind.adjustDistrictReputation(zone, repDelta);
  }

  /** Broadcast a player courtyard/plaza busking performance to nearby residents, raising fun, memory, and reputation. */
  notifyBuskerPerformance(s: V3State, x: number, z: number, zone: string): void {
    for (let i = 0; i < this.walkerList.length; i++) {
      const w = this.walkerList[i];
      if (!isResidentId(w.id)) continue;
      const d = Math.hypot(w.x - x, w.z - z);
      if (d > 18 && w.zone !== zone) continue;
      const mindState = this.mind.minds.get(w.id);
      if (mindState) {
        mindState.needs.fun = Math.min(100, mindState.needs.fun + 10);
        mindState.needs.social = Math.min(100, mindState.needs.social + 6);
        mindState.mood = 'excited';
        mindState.moodLockedUntilClock = s.clock + 12;
        mindState.reaction = {
          kind: 'cheer_basket',
          untilElapsed: this.elapsed + 3.2,
          targetPos: { x, z },
          quip: w.id === 'haidang' ? 'Clean progression — encore!' : 'Loved that acoustic set!',
        };
      }
      w.mood = 'excited';
      w.lookTarget = { x, z };
      w.quip = w.id === 'haidang' ? 'Clean progression — encore!' : 'Loved that acoustic set!';
      w.quipUntil = this.elapsed + 3.2;
      this.mind.recordMemory(
        w.id,
        {
          kind: 'player_shared_activity',
          day: s.day,
          clock: s.clock,
          subject: 'busker_set',
          valence: 0.85,
          salience: 0.78,
          zone,
        },
        true,
      );
    }
    this.mind.adjustDistrictReputation(zone, 5);
  }

  /** Query a resident's current mood (`cheerful`, `focused`, `relaxed`, `tired`, `curious`, `sheltering`, `excited`). */
  getResidentMood(id: string): ResidentMood | null {
    if (!isResidentId(id)) return null;
    return this.mind.getResidentMood(id);
  }

  /** Query a resident's latest concrete English memory recollection about the player (or null). */
  latestPlayerMemory(id: string, currentDay?: number): string | null {
    if (!isResidentId(id)) return null;
    return this.mind.latestPlayerMemory(id, currentDay);
  }

  /** Query a resident's currently active short sidewalk/reaction quip (or null). */
  getResidentQuip(id: string): string | null {
    const w = this.walkers.get(id);
    if (!w || !w.quip) return null;
    if (w.quipUntil !== undefined && this.elapsed >= w.quipUntil) return null;
    return w.quip;
  }

  /** Query reputation score, tier, and discount percentage for a zone or district. */
  getDistrictReputation(zoneOrDistrict: string): {
    score: number;
    tier: DistrictRepTier;
    discountPct: number;
  } {
    const info = this.mind.getDistrictReputation(zoneOrDistrict);
    return { score: info.score, tier: info.tier, discountPct: info.discountPct };
  }

  /** Query all 6 district reputation scores (`market`, `bistro`, `cafe`, `library`, `park`, `campus`). */
  getAllDistrictReputation(): Record<string, number> {
    return this.mind.getAllDistrictReputation();
  }

  /** Count named residents currently located inside `zone` (for venue ambience & crowd occupancy). */
  residentsInZone(zone: string): number {
    let count = 0;
    for (let i = 0; i < this.walkerList.length; i++) {
      if (this.walkerList[i].zone === zone) count++;
    }
    return count;
  }

  /** Export compact bounded `NpcSimSnapshot` (<= 6.5 KB) to store inside `s.worldV3.npcSim`. */
  exportNpcSimSnapshot(): NpcSimSnapshot {
    return this.mind.exportSnapshot(this.social.exportAffinityDeltas());
  }

  /** Session-adapter alias used by `EchoLifeGame.serialize()`. */
  serializeSim(): NpcSimSnapshot {
    return this.exportNpcSimSnapshot();
  }

  /** Hydrate minds + pairwise affinity deltas + district reputation from `s.worldV3.npcSim` (safe on legacy V1-V4 saves). */
  hydrateNpcSimSnapshot(s: V3State): void {
    this.mind.init(s, this.shelters);
    const saved = (s.worldV3 as Record<string, unknown> | undefined)?.npcSim as Partial<NpcSimSnapshot> | undefined;
    this.social.init(s, saved?.v === 1 ? saved.aff : undefined);
  }

  /** Current seat IDs occupied or targeted by named residents or the player (used by `crowd.ts` to avoid bench clashes). */
  occupiedSeatIds(): ReadonlySet<string> {
    this.claimedSeatsScratch.clear();
    if (this.playerSeat) this.claimedSeatsScratch.add(this.playerSeat);
    for (let i = 0; i < this.walkerList.length; i++) {
      const w = this.walkerList[i];
      if (w.seat) this.claimedSeatsScratch.add(w.seat.id);
      if (w.lastSeat) this.claimedSeatsScratch.add(w.lastSeat.id);
      if (w.targetSeat) this.claimedSeatsScratch.add(w.targetSeat.id);
    }
    return this.claimedSeatsScratch;
  }

  private pushStimulus(st: WorldStimulus): void {
    this.stimuli.push(st);
    if (this.stimuli.length > STIMULUS_CAP) this.stimuli.shift();
  }

  // ── Spots & Seats ───────────────────────────────────────────────────────────────────────────────────────

  spotsOf(zone: V3ZoneId): P[] {
    let list = this.spots.get(zone);
    if (!list) {
      list = this.nav.spots(zone, SPOTS);
      this.spots.set(zone, list);
    }
    return list;
  }

  /** The place a resident settles in a zone: shopkeeper counter anchor during open shifts, otherwise collision-free deterministic spot. */
  spotFor(id: string, zone: V3ZoneId, s?: V3State): P | null {
    const shop = this.shopAnchors.get(id);
    if (shop && shop.zone === zone && (!s || isZoneOpen(v3Zones[zone], s.clock).open)) {
      let taken = false;
      for (let i = 0; i < this.walkerList.length; i++) {
        const w = this.walkerList[i];
        if (w.id === id) continue;
        if (w.zone === zone && Math.hypot(w.x - shop.pos.x, w.z - shop.pos.z) < 0.72) {
          taken = true;
          break;
        }
      }
      if (!taken) return shop.pos;
    }

    const list = this.spotsOf(zone);
    if (!list.length) return null;
    const base = hashId(id) % list.length;
    for (const minDist of [1.1, 0.78]) {
      for (let k = 0; k < list.length; k++) {
        const p = list[(base + k) % list.length];
        let taken = false;
        for (let i = 0; i < this.walkerList.length; i++) {
          const w = this.walkerList[i];
          if (w.id === id) continue;
          if (w.dest && w.destZone === zone && Math.hypot(w.dest.x - p.x, w.dest.z - p.z) < minDist) { taken = true; break; }
          if (w.zone === zone && Math.hypot(w.x - p.x, w.z - p.z) < minDist) { taken = true; break; }
        }
        if (!taken) return p;
      }
    }
    return list[base];
  }

  /**
   * Best free public seat in a resident's current zone within `maxDist` m (skips Market Blvd private residences & beds).
   * Prefers opposite or adjacent table/booth seats when a friend (`affinity >= 15`) is already seated nearby.
   */
  private freeSeatFor(w: Walker, maxDist = 7.5): Seat | null {
    const list = this.seatsByZone.get(w.zone);
    if (!list?.length) return null;
    this.claimedSeatsScratch.clear();
    if (this.playerSeat) this.claimedSeatsScratch.add(this.playerSeat);
    for (let i = 0; i < this.walkerList.length; i++) {
      const o = this.walkerList[i];
      if (o.id === w.id) continue;
      if (o.seat) this.claimedSeatsScratch.add(o.seat.id);
      if (o.lastSeat) this.claimedSeatsScratch.add(o.lastSeat.id);
      if (o.targetSeat) this.claimedSeatsScratch.add(o.targetSeat.id);
    }

    const wIsRes = isResidentId(w.id);
    let best: Seat | null = null;
    let bestScore = Infinity;

    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.propertyId || s.isBed || this.claimedSeatsScratch.has(s.id)) continue;
      const d = Math.hypot(s.stand.x - w.x, s.stand.z - w.z);
      if (d >= maxDist) continue;

      let score = d;
      if (wIsRes) {
        let bestPairBonus = 0;
        for (let j = 0; j < this.walkerList.length; j++) {
          const o = this.walkerList[j];
          if (o === w || !o.seat || o.zone !== w.zone || !isResidentId(o.id)) continue;
          const aff = this.social.getAffinity(w.id as ResidentId, o.id);
          if (aff < 15) continue;
          const seatDist = Math.hypot(s.sit.x - o.seat.sit.x, s.sit.z - o.seat.sit.z);
          if (seatDist < 0.48 || seatDist > 2.4) continue;
          const facingDot = Math.sin(s.yaw) * Math.sin(o.seat.yaw) + Math.cos(s.yaw) * Math.cos(o.seat.yaw);
          const affScale = 1 + (aff - 15) / 140;
          let bonus = 0;
          if (facingDot < -0.45 && seatDist <= 2.15) {
            // Directly opposite across a café or library study table
            bonus = 4.4 * affScale;
          } else if (seatDist <= 1.35 && facingDot > 0.45) {
            // Adjacent seat on the same booth, bench, or sofa
            bonus = 3.2 * affScale;
          } else {
            // Same table/study cluster
            bonus = 1.9 * affScale;
          }
          if (bonus > bestPairBonus) bestPairBonus = bonus;
        }
        score -= bestPairBonus;
      }

      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  /**
   * Dynamic circular obstacles representing nearby residents for the player's `LifeWalk`, preventing the learner from
   * walking straight through standing residents while keeping all doorways unobstructed and never trapping the player.
   */
  playerObstacles(player: P | null): { x: number; z: number; r: number }[] {
    if (!player) return [];
    const py = this.nav.walk.groundAt(player.x, player.z) ?? 0;
    const out: { x: number; z: number; r: number }[] = [];
    for (let i = 0; i < this.walkerList.length; i++) {
      const w = this.walkerList[i];
      const rx = w.seat ? w.seat.sit.x : w.x;
      const rz = w.seat ? w.seat.sit.z : w.z;
      const d = Math.hypot(rx - player.x, rz - player.z);
      if (d > 4.5 || d < 0.44) continue;
      const wy = w.seat ? w.seat.sit.y : w.groundY;
      if (Math.abs(wy - py) > 0.8) continue;
      let nearDoor = false;
      for (let k = 0; k < this.nav.doors.length; k++) {
        const dr = this.nav.doors[k];
        if (Math.hypot(rx - dr.x, rz - dr.z) < 1.25) {
          nearDoor = true;
          break;
        }
      }
      if (nearDoor) continue;
      out.push({ x: rx, z: rz, r: 0.25 });
    }
    return out;
  }

  /**
   * Put every named resident in the world: where the save left them when that is still walkable,
   * otherwise at their current scheduled place. Also initializes autonomous minds & affinity graph.
   */
  populate(s: V3State, saved: Record<string, { x: number; z: number }> | null): void {
    this.walkers.clear();
    this.walkerList = [];
    this.mirroredPathMeta.clear();
    this.hydrateNpcSimSnapshot(s);
    this.lastClock = s.clock;
    const initEnv = envSnapshotFromV3(s, this.envOverride ?? undefined);
    this.lastEnvPhase = initEnv.phase;
    this.lastEnvHour = initEnv.hour;
    this.lastPrecipMode = precipModeOf(initEnv);
    this._groupBanter = null;
    this._quipBanter = null;

    for (const id of CHARACTER_IDS) {
      const n = s.npcs[id];
      if (!n) continue;
      const prev = saved?.[id];
      let at: P | null = null;
      let zone: V3ZoneId | null = null;
      if (prev && Number.isFinite(prev.x) && Number.isFinite(prev.z) && this.nav.walk.free(prev)) {
        at = prev;
        zone = this.nav.walk.zone(prev);
      }
      if (!at || !zone) {
        const want = this.zoneFor(desiredScheduleFor(s, id).zone);
        at = this.spotFor(id, want, s) ?? null;
        zone = want;
      }
      if (!at) continue;
      const surf = this.nav.walk.surface(at);
      const groundY = surf?.y ?? 0;
      const outdoor = !!surf?.region && OUTDOOR_REGIONS.has(surf.region);
      const profile = isResidentId(id) ? RESIDENT_PROFILES[id] : null;
      const mindState = isResidentId(id) ? this.mind.minds.get(id) : null;
      const shop = this.shopAnchors.get(id);
      const initialYaw = shop && shop.zone === zone ? shop.yaw : (hashId(id) % 628) / 100;

      const walker: Walker = {
        id,
        x: at.x,
        z: at.z,
        yaw: initialYaw,
        vx: 0,
        vz: 0,
        zone,
        destZone: null,
        dest: null,
        route: null,
        ri: 0,
        activity: 'idle',
        moving: false,
        closeBehind: null,
        waitDoor: 0,
        blocked: 0,
        pending: false,
        failures: 0,
        simulationDebt: 0,
        substepAccum: 0,
        facing: null,
        sceneId: null,
        scenePose: null,
        seat: null,
        lastSeat: null,
        seatTransition: { phase: 'none', progress: 0, rootAlignW: 0, hipContactW: 0 },
        seatTransitionElapsed: 0,
        targetSeat: null,
        greetUntil: 0,
        greetCooldown: 0,
        opened: null,
        tier: 1,
        groundY,
        outdoor,
        mood: mindState?.mood ?? 'relaxed',
        microAct: null,
        lookTarget: null,
        rainUmbrella: false,
        umbrellaColor: profile?.umbrellaColor ?? (hashId(id) % 5),
        quip: null,
        emergentGroupId: null,
        abstractTrip: null,
        nextAiEvalAt: 0,
      };
      this.walkers.set(id, walker);
      this.walkerList.push(walker);
      this.mirror(n, walker);
    }
  }

  private zoneFor(z: string): V3ZoneId {
    if (z === 'study') return 'hall';
    return (V3_ZONE_IDS as readonly string[]).includes(z) ? (z as V3ZoneId) : 'street';
  }

  places(): Record<string, { x: number; z: number }> {
    const out: Record<string, { x: number; z: number }> = {};
    for (let i = 0; i < this.walkerList.length; i++) {
      const w = this.walkerList[i];
      out[w.id] = { x: +w.x.toFixed(2), z: +w.z.toFixed(2) };
    }
    return out;
  }

  /** Refresh cached groundY, outdoor flag, and zone with a single `walk.surface()` lookup. */
  private refreshPoseCache(w: Walker): void {
    const surf = this.nav.walk.surface(w);
    if (!surf) return;
    w.groundY = surf.y;
    w.outdoor = OUTDOOR_REGIONS.has(surf.region);
    if (surf.zone && surf.zone !== 'study') w.zone = surf.zone;
  }

  /** Zero-allocation V3 mirror: only updates `n.path` when route/waypoint/moving actually changes. */
  private mirror(n: V3Npc, w: Walker): void {
    n.zone = w.zone;
    n.x = w.x;
    n.z = w.z;
    n.yaw = w.yaw;
    n.activity = w.activity;
    n.target = w.destZone;

    const meta = this.mirroredPathMeta.get(w.id);
    if (!meta || meta.route !== w.route || meta.ri !== w.ri || meta.moving !== w.moving) {
      if (w.route && w.moving) {
        const rem = w.route.points.length - w.ri;
        const pts: [number, number][] = new Array(Math.max(0, rem));
        for (let k = 0; k < rem; k++) {
          const p = w.route.points[w.ri + k];
          pts[k] = [p.x, p.z];
        }
        n.path = pts;
      } else {
        n.path = [];
      }
      if (meta) {
        meta.route = w.route;
        meta.ri = w.ri;
        meta.moving = w.moving;
      } else {
        this.mirroredPathMeta.set(w.id, { route: w.route, ri: w.ri, moving: w.moving });
      }
    }
  }

  /** Close a door this resident opened once they are safely clear and nobody stands in its swing. */
  private tryCloseBehind(w: Walker, player: P | null): void {
    const cb = w.closeBehind;
    if (!cb) return;
    const dist = Math.hypot(w.x - cb.at.x, w.z - cb.at.z);
    // Close once > 1.6 m away, OR once settled (> 1.15 m away and no longer moving)
    const farEnough = dist > 1.6 || (!w.moving && dist > 1.15);
    if (!farEnough) return;
    const door = this.doors.door(cb.door);
    let clear = !player || Math.hypot(player.x - cb.at.x, player.z - cb.at.z) > 1.4;
    if (clear) {
      for (let i = 0; i < this.walkerList.length; i++) {
        const o = this.walkerList[i];
        if (o !== w && Math.hypot(o.x - cb.at.x, o.z - cb.at.z) < 1.4) {
          clear = false;
          break;
        }
      }
    }
    if (door && clear) door.setOpen(false);
    if (!door || clear) {
      w.closeBehind = null;
      if (w.opened === cb.door) w.opened = null;
    }
  }

  /** Initiates a smooth `Stand_Up` transition retaining `lastSeat` so `GameView` never snaps 0.75 m forward. */
  private beginStandUp(w: Walker): void {
    const prev = w.seat;
    if (prev) {
      w.lastSeat = prev;
      w.seat = null;
      if (w.seatTransition.phase !== 'standing_up') {
        w.seatTransition.phase = 'standing_up';
        w.seatTransitionElapsed = 0;
        w.seatTransition.progress = 0;
        w.seatTransition.rootAlignW = 1;
        w.seatTransition.hipContactW = 1;
      }
      w.moving = false;
      w.vx = 0;
      w.vz = 0;
    }
  }

  /**
   * Advances `w.seatTransition` (`sitting_down` 1.15 s / `seated` / `standing_up` 1.05 s).
   * Returns `true` while the resident is rising out of `lastSeat` and must hold route stepping.
   */
  private stepSeatTransition(w: Walker, sdt: number): boolean {
    if (w.seat) {
      w.lastSeat = w.seat;
      const st = w.seatTransition;
      if (st.phase !== 'sitting_down' && st.phase !== 'seated') {
        st.phase = 'sitting_down';
        w.seatTransitionElapsed = 0;
      }
      if (st.phase === 'sitting_down') {
        w.seatTransitionElapsed += sdt;
        const u = Math.min(1, w.seatTransitionElapsed / 1.15);
        st.progress = u;
        st.rootAlignW = smoothstepRange(0.06, 0.76, u);
        st.hipContactW = smoothstepRange(0.62, 0.98, u);
        if (u >= 1) {
          st.phase = 'seated';
          st.progress = 1;
          st.rootAlignW = 1;
          st.hipContactW = 1;
        }
      } else {
        st.progress = 1;
        st.rootAlignW = 1;
        st.hipContactW = 1;
      }
      return false;
    }

    if (w.seatTransition.phase === 'standing_up' && w.lastSeat) {
      const st = w.seatTransition;
      w.seatTransitionElapsed += sdt;
      const u = Math.min(1, w.seatTransitionElapsed / 1.05);
      st.progress = u;
      st.rootAlignW = 1 - smoothstepRange(0.28, 0.94, u);
      st.hipContactW = 1 - smoothstepRange(0.04, 0.40, u);
      w.yaw = turnSmooth(w.yaw, w.lastSeat.yaw, sdt, 8.0, 5.0);
      if (u >= 1) {
        st.phase = 'none';
        st.progress = 0;
        st.rootAlignW = 0;
        st.hipContactW = 0;
        w.lastSeat = null;
        return false;
      }
      return u < 0.92;
    }

    if (w.seatTransition.phase !== 'none' || w.lastSeat !== null) {
      w.seatTransition.phase = 'none';
      w.seatTransition.progress = 0;
      w.seatTransition.rootAlignW = 0;
      w.seatTransition.hipContactW = 0;
      w.lastSeat = null;
    }
    return false;
  }

  /**
   * One simulation frame for all 22 named residents.
   * Backward-compatible with existing 3- and 4-arg callers (`session.ts`, `test-echo-life-game.mjs`).
   */
  step(s: V3State, dt: number, player: P | null, routeBudget = 2, envOverride?: Partial<EnvSnapshot>): void {
    this.frame++;
    this.elapsed += dt;

    // Track player velocity & floor elevation for predictive ORCA avoidance and unobtrusive banter suppression
    if (player) {
      if (this.lastPlayer && dt > 1e-4) {
        const dxp = player.x - this.lastPlayer.x;
        const dzp = player.z - this.lastPlayer.z;
        const distP = Math.hypot(dxp, dzp);
        this.playerSpeed = distP / dt;
        if (distP < 3.0) {
          this.playerVx += (dxp / dt - this.playerVx) * 0.35;
          this.playerVz += (dzp / dt - this.playerVz) * 0.35;
        } else {
          this.playerVx = 0;
          this.playerVz = 0;
        }
      }
      this.lastPlayer = { x: player.x, z: player.z };
      this.playerGroundY = this.nav.walk.groundAt(player.x, player.z) ?? this.playerGroundY;
    } else {
      this.playerSpeed = 0;
      this.playerVx = 0;
      this.playerVz = 0;
    }

    // Prune expired world stimuli
    while (this.stimuli.length && this.elapsed - this.stimuli[0].elapsed > STIMULUS_TTL) {
      this.stimuli.shift();
    }

    // Build zero-allocation combined vehicle hazard list (playerVehicle + commuter traffic)
    this.hazardsScratch.length = 0;
    if (this.playerVehicle) {
      const pv = this.playerVehicle;
      this.hazardsScratch.push({
        x: pv.x,
        z: pv.z,
        vx: pv.vx,
        vz: pv.vz,
        speed: pv.speed,
        radius: pv.kind === 'car' ? 1.25 : 0.78,
        hornActive: this.elapsed - this.lastHornAt < 1.8,
        isPlayer: true,
      });
    }
    for (let i = 0; i < this.trafficVehicles.length; i++) {
      this.hazardsScratch.push(this.trafficVehicles[i]);
    }

    // Rebuild zero-alloc spatial hash of all 22 residents for O(1) ORCA-Lite neighbor queries
    this.residentHash.clear();
    const resCount = Math.min(this.walkerList.length, this.residentHash.capacity);
    for (let i = 0; i < resCount; i++) {
      const w = this.walkerList[i];
      const rx = w.seat ? w.seat.sit.x : w.x;
      const rz = w.seat ? w.seat.sit.z : w.z;
      this.residentHash.insert(i, rx, rz);
    }

    const env = envSnapshotFromV3(s, envOverride ?? this.envOverride ?? undefined);
    const rawClockJump = this.lastClock >= 0 ? Math.abs(s.clock - this.lastClock) : 0;
    const nextPrecip = precipModeOf(env);
    const phaseChanged = this.lastEnvPhase !== null && env.phase !== this.lastEnvPhase;
    const hourJumped = this.lastEnvHour !== null && circularHourDiff(env.hour, this.lastEnvHour) > 2;
    const precipChanged =
      nextPrecip !== null && this.lastPrecipMode !== null && nextPrecip !== this.lastPrecipMode;
    this.lastEnvPhase = env.phase;
    this.lastEnvHour = env.hour;
    if (nextPrecip !== null) this.lastPrecipMode = nextPrecip;
    if (phaseChanged || hourJumped || precipChanged || rawClockJump > 120) {
      this.clearStaleQuips();
    }
    const clockDm = this.lastClock >= 0 ? Math.max(0, s.clock - this.lastClock) : dt * 0.5;
    this.lastClock = s.clock;

    const playerZone = player ? this.nav.walk.zone(player) : null;
    const tiers: PeopleStats['tiers'] = [0, 0, 0, 0];
    let budget = routeBudget;
    let walking = 0;
    let seated = 0;
    let abstractTrips = 0;

    if (this.frame % 75 === 0) checkExpiredInvites(s);

    // Lazily pre-bake 1 ZoneTravelGraph spine per frame once LifeNav is warmed
    if (this.nav.warmed && !this.zoneGraph.warmed && budget > 0) {
      this.zoneGraph.warmStep(1);
    }

    const activeEvents = getActiveEvents(s);

    for (let idx = 0; idx < this.walkerList.length; idx++) {
      const w = this.walkerList[idx];
      const n = s.npcs[w.id];
      if (!n) continue;

      const d = player ? Math.hypot(w.x - player.x, w.z - player.z) : Infinity;
      const prevTier = w.tier;
      const tier = resolveSimulationTier(prevTier, d, playerZone !== null && w.zone === playerZone, this.talking === w.id);
      w.tier = tier;
      tiers[tier]++;

      // Zero-Teleport Promotion Handover (Tier 2 -> Tier 1 / Tier 0)
      if (prevTier === 2 && tier < 2 && w.abstractTrip) {
        w.route = this.zoneGraph.handoffToRoute(w.abstractTrip, w);
        w.ri = 0;
        w.abstractTrip = null;
        w.pending = false;
      }

      // Always keep door-closing responsive even on skipped ticks
      if (w.closeBehind) this.tryCloseBehind(w, player);

      w.simulationDebt += dt;
      const minInterval = TIER_INTERVAL_SECONDS[tier];
      // Stagger Tier 1 / Tier 2 AI ticks while keeping Tier 1 visual translation smooth at 60 Hz (zero 5 Hz staircase!)
      if (minInterval > 0 && w.simulationDebt < minInterval) {
        if (
          tier === 1 &&
          w.moving &&
          !w.seat &&
          w.seatTransition.phase === 'none' &&
          w.route &&
          w.ri < w.route.points.length
        ) {
          const vSq = w.vx * w.vx + w.vz * w.vz;
          if (vSq > 0.0025) {
            const wp = w.route.points[w.ri];
            const distToWp = Math.hypot(wp.x - w.x, wp.z - w.z);
            const stepLen = Math.sqrt(vSq) * dt;
            if (stepLen < distToWp - 0.04) {
              const cand = this.probeScratch;
              cand.x = w.x + w.vx * dt;
              cand.z = w.z + w.vz * dt;
              if (this.nav.walk.free(cand) && !this.inClosedDoorCorridor(cand.x, cand.z)) {
                w.x = cand.x;
                w.z = cand.z;
                w.yaw = turnSmooth(w.yaw, Math.atan2(w.vx, w.vz), dt, 8.5, 5.2);
                w.substepAccum += dt;
                this.refreshPoseCache(w);
              }
            }
          }
        }
        if (w.moving) walking++;
        if (w.seat) seated++;
        if (w.abstractTrip) abstractTrips++;
        this.mirror(n, w);
        continue;
      }

      const sdt = w.simulationDebt;
      const walkDt = Math.max(0, sdt - w.substepAccum);
      w.simulationDebt = 0;
      w.substepAccum = 0;
      const dm = clockDm > 0 ? Math.max(clockDm, sdt * 0.5) : sdt * 0.5;

      // Sync & update autonomous mind (needs, mood, umbrella, staggered Utility AI)
      let wantZone: V3ZoneId;
      let desiredActivity: string;
      let shelterSpot: P | null = null;

      if (isResidentId(w.id)) {
        const rid = w.id;
        const inEvent = activeEvents.some(ev => ev.participants.includes(rid));
        const inSocial = Boolean(w.sceneId || w.emergentGroupId);

        this.mind.advanceNeedsAndMood(rid, dm, {
          env,
          zone: w.zone,
          activity: w.activity,
          outdoor: w.outdoor,
          seated: Boolean(w.seat),
          inSocialGroup: inSocial,
          inWorldEvent: inEvent,
          clock: s.clock,
        });

        // Time-based staggered Utility AI evaluation (~0.5 Hz per resident, FPS & tier independent)
        const evalDue =
          this.talking === rid ||
          w.destZone === null ||
          this.elapsed >= w.nextAiEvalAt ||
          tier === 2;

        if (evalDue) {
          w.nextAiEvalAt = this.elapsed + 1.8 + (idx % 7) * 0.08;
        }

        const goal = evalDue
          ? this.mind.evaluateGoal(s, rid, {
              env,
              pos: w,
              zone: w.zone,
              outdoor: w.outdoor,
              talkingId: this.talking,
              v3SceneLocked: Boolean(w.sceneId),
              hasCompatibleFriendInZone: this.social.hasCompatibleInZone(rid, w.zone, this.socialViewsScratch),
              hasFreeSeatInZone: this.freeSeatFor(w, 7.5) !== null,
            })
          : this.mind.minds.get(rid)!.goal;

        const mindState = this.mind.minds.get(rid)!;
        w.mood = mindState.mood;
        w.rainUmbrella = mindState.umbrella;
        wantZone = goal.zone;
        desiredActivity = goal.activity;
        shelterSpot = goal.shelterSpot ?? null;
        n.scheduleNote = goal.reason;
      } else {
        const plan = desiredScheduleFor(s, w.id);
        n.scheduleNote = plan.note;
        wantZone = this.zoneFor(plan.zone);
        desiredActivity = plan.activity;
      }

      // Talking lock: stop & face player smoothly
      if (this.talking === w.id && player) {
        w.moving = false;
        w.vx = 0;
        w.vz = 0;
        w.abstractTrip = null;
        this.stepSeatTransition(w, sdt);
        if (!w.seat) {
          w.yaw = turnSmooth(w.yaw, Math.atan2(player.x - w.x, player.z - w.z), sdt, 7.5, 4.8);
        }
        w.lookTarget = { x: player.x, z: player.z };
        w.activity = w.seat ? 'sit' : 'talk';
        w.quip = null;
        if (w.seat) seated++;
        this.mirror(n, w);
        continue;
      }

      // Destination changed (zone change OR passing-shower local awning shelter spot)
      const wantTargetPos = shelterSpot ?? null;
      const shelterChanged =
        wantTargetPos !== null &&
        (!w.dest || Math.hypot(w.dest.x - wantTargetPos.x, w.dest.z - wantTargetPos.z) > 0.4);

      if (wantZone !== w.destZone || shelterChanged) {
        w.destZone = wantZone;
        w.dest = wantTargetPos ?? this.spotFor(w.id, wantZone, s);
        w.route = null;
        w.abstractTrip = null;
        w.ri = 0;
        w.pending = !!w.dest;
        w.failures = 0;
        w.facing = null;
        w.sceneId = null;
        w.scenePose = null;
        w.emergentGroupId = null;
        this.beginStandUp(w);
        w.targetSeat = null;
      }

      // Path acquisition: Tier 2 uses O(1) ZoneTravelGraph spines; Tier 0/1 use exact LifeNav routes
      if (w.pending && w.dest) {
        if (tier === 2 && w.zone !== wantZone) {
          const prevBaked = this.zoneGraph.stats.bakedEdges;
          const trip = this.zoneGraph.startTrip(w, w.zone, wantZone, w.dest, budget > 0);
          if (this.zoneGraph.stats.bakedEdges > prevBaked && budget > 0) budget--;
          if (trip) {
            w.abstractTrip = trip;
            w.pending = false;
            this.stats.routes++;
          } else if (budget > 0) {
            budget--;
            this.stats.routes++;
            const r = this.nav.route({ x: w.x, z: w.z }, w.dest);
            w.pending = false;
            if (r) { w.route = r; w.ri = 0; }
            else this.recoverRouteFailure(w, wantZone);
          }
        } else if (budget > 0) {
          budget--;
          this.stats.routes++;
          const r = this.nav.route({ x: w.x, z: w.z }, w.dest);
          w.pending = false;
          if (r) { w.route = r; w.ri = 0; }
          else this.recoverRouteFailure(w, wantZone);
        }
      }

      // Motion advancement (held cleanly while `standing_up` finishes rising out of `lastSeat`)
      if (w.quip && w.quipUntil !== undefined && this.elapsed >= w.quipUntil) {
        w.quip = null;
      }
      w.lookTarget = null;
      const holdingStandUp = this.stepSeatTransition(w, sdt);
      if (holdingStandUp) {
        w.moving = false;
        w.vx = 0;
        w.vz = 0;
      } else if (w.abstractTrip) {
        abstractTrips++;
        this.walkAbstract(w, walkDt, desiredActivity, player, env);
      } else {
        this.walk(s, w, walkDt, desiredActivity, player, tier, env, idx);
      }

      // Settled behaviors (sitting, shopkeeper facing, emergent social choreography, Layer 1 reflexes)

      if (w.moving) {
        if (w.seat) this.beginStandUp(w);
        walking++;
      } else if (!holdingStandUp) {
        w.vx = 0;
        w.vz = 0;
        const emergentDir = isResidentId(w.id) ? this.socialDirectives.get(w.id) ?? null : null;
        const desiredAct = w.scenePose ?? emergentDir?.activity ?? desiredActivity;
        const wantsSeat =
          SIT_ACTIVITIES.has(desiredAct) &&
          (!w.sceneId || desiredAct === 'sit' || desiredAct === 'study') &&
          (!emergentDir || emergentDir.slot.seatId !== null);

        if (wantsSeat) {
          if (w.seat && w.seat.zone !== w.zone) this.beginStandUp(w);
          if (!w.seat && w.seatTransition.phase === 'none') {
            const seat = w.targetSeat && w.targetSeat.zone === w.zone ? w.targetSeat : this.freeSeatFor(w);
            if (seat) {
              const sd = Math.hypot(seat.stand.x - w.x, seat.stand.z - w.z);
              if (sd <= 0.42) {
                w.seat = seat;
                w.lastSeat = seat;
                w.targetSeat = null;
                w.seatTransition.phase = 'sitting_down';
                w.seatTransitionElapsed = 0;
                w.seatTransition.progress = 0;
                w.seatTransition.rootAlignW = 0;
                w.seatTransition.hipContactW = 0;
                w.yaw = turnSmooth(w.yaw, seat.yaw, sdt, 7.5, 5.0);
              } else if (!w.route && !w.pending && !w.abstractTrip) {
                w.targetSeat = seat;
                if (this.nav.clear({ x: w.x, z: w.z }, seat.stand)) {
                  w.route = { points: [seat.stand], doors: [], length: sd };
                  w.ri = 0;
                } else if (budget > 0) {
                  budget--;
                  const r = this.nav.route({ x: w.x, z: w.z }, seat.stand);
                  if (r) { w.route = r; w.ri = 0; }
                  else w.targetSeat = null;
                }
              }
            }
          } else if (w.seat) {
            w.yaw = turnSmooth(w.yaw, w.seat.yaw, sdt, 7.5, 5.0);
          }
        } else {
          if (w.seat) this.beginStandUp(w);
          w.targetSeat = null;
        }

        // Emergent multi-NPC group orientation & look-at
        if (emergentDir && !w.sceneId) {
          w.emergentGroupId = emergentDir.groupId;
          w.lookTarget = emergentDir.lookAt;
          if (!w.seat) w.yaw = turnSmooth(w.yaw, emergentDir.faceYaw, sdt, 6.0, 4.5);
        } else {
          w.emergentGroupId = null;
        }

        // Shopkeeper customer-facing orientation when behind counter during open hours
        if (!w.seat && !w.sceneId && !emergentDir) {
          const shop = this.shopAnchors.get(w.id);
          if (shop && shop.zone === w.zone && Math.hypot(w.x - shop.pos.x, w.z - shop.pos.z) < 0.75) {
            w.yaw = turnSmooth(w.yaw, shop.yaw, sdt, 5.5, 4.2);
          }
        }

        // Tier 0 Layer 1 Local Reflexes & Player Awareness (< 6 m head look-at, greetings, horn, basketball)
        if (tier === 0 && isResidentId(w.id)) {
          const reaction = this.mind.evaluateStimuli(s, w.id, {
            pos: w,
            zone: w.zone,
            seated: Boolean(w.seat),
            outdoor: w.outdoor,
            player,
            playerVehicle: this.playerVehicle,
            env,
            elapsed: this.elapsed,
            stimuli: this.stimuli,
          });
          if (reaction) {
            w.lookTarget = reaction.targetPos;
            if (reaction.quip) {
              w.quip = reaction.quip;
              w.quipUntil = reaction.untilElapsed;
            }
            if (!w.seat && !w.sceneId) {
              w.yaw = turnSmooth(w.yaw, Math.atan2(reaction.targetPos.x - w.x, reaction.targetPos.z - w.z), sdt, 7.0, 4.8);
            }
            if (reaction.kind === 'greet' || reaction.kind === 'horn_wave') {
              w.greetUntil = Math.max(w.greetUntil, reaction.untilElapsed);
            }
          } else if (!w.lookTarget && player && d < 6.0 && (w.outdoor || w.zone === playerZone)) {
            // Natural silent head glance toward approaching learner within 6 m
            w.lookTarget = { x: player.x, z: player.z };
            if (!w.seat && !w.sceneId && !emergentDir && d < 2.25) {
              w.yaw = turnSmooth(w.yaw, Math.atan2(player.x - w.x, player.z - w.z), sdt, 5.5, 4.2);
            }
          }
        }
      }

      if (w.seat) seated++;

      // Final expressive activity resolution (outdoor-safe micro-activities, rain shelter jog posture)
      const emergentAct = isResidentId(w.id) ? this.socialDirectives.get(w.id)?.activity ?? null : null;
      const activeReaction = isResidentId(w.id) ? this.mind.minds.get(w.id)?.reaction ?? null : null;
      let settledAct = w.scenePose ?? emergentAct ?? desiredActivity;
      if (!w.scenePose && activeReaction) {
        if (activeReaction.kind === 'cheer_basket') settledAct = 'celebrate';
        else if ((activeReaction.kind === 'greet' || activeReaction.kind === 'horn_wave') && !w.seat) settledAct = 'wave';
      } else if (!w.scenePose && !emergentAct && isResidentId(w.id)) {
        w.microAct = this.mind.pickMicroActivity(w.id, settledAct, Boolean(w.seat), this.elapsed, w.outdoor);
        settledAct = w.microAct;
      } else {
        w.microAct = null;
      }
      if (!w.scenePose && (w.outdoor || !w.seat) && PROP_UNSAFE_OUTDOOR_ACTS.has(settledAct)) {
        settledAct = w.seat ? 'sit' : 'idle';
      }

      const rainShelterJog = w.outdoor && env.rainIntensity > 0.1 && !w.rainUmbrella;
      w.activity = holdingStandUp
        ? 'idle'
        : w.moving
          ? (desiredActivity === 'run' && w.outdoor) || rainShelterJog
            ? 'run'
            : 'walk'
          : w.seat && settledAct === 'idle'
            ? 'sit'
            : settledAct;

      this.mirror(n, w);
    }

    // Gentle floor-proven separation between Tier 0/1 standing residents (zero clip/stack)
    this.separateWalkers(dt);

    // Publish zero-alloc 22-resident kinematics & active traffic hazards into CrowdSim for smooth tangential avoidance!
    const kCount = Math.min(this.walkerList.length, this.resPosX.length);
    this.residentKinematics.count = kCount;
    for (let i = 0; i < kCount; i++) {
      const w = this.walkerList[i];
      if (w.seat) {
        this.resPosX[i] = w.seat.sit.x;
        this.resPosZ[i] = w.seat.sit.z;
        this.resVelX[i] = 0;
        this.resVelZ[i] = 0;
      } else {
        this.resPosX[i] = w.x;
        this.resPosZ[i] = w.z;
        this.resVelX[i] = w.vx;
        this.resVelZ[i] = w.vz;
      }
    }
    setCrowdResidentKinematics(this.residentKinematics);
    setCrowdActiveVehicles(this.hazardsScratch.length > 0 ? this.hazardsScratch : null);

    // 2 Hz Social Pass: V3's 14 scripted scenes FIRST, then emergent 2–3 resident gatherings + counter queues
    this.sceneTimer -= dt;
    if (this.sceneTimer <= 0) {
      this.sceneTimer = 0.5;
      this.stepSocialPass(s, env, player, playerZone);
      this.stepCounterQueues(s);
    }

    // Keep overheard banter continuously proximity-checked (group banter first, fallback to nearby active quip)
    this._groupBanter = this.social.overheardBanterNear(player, playerZone, this.playerSpeed, this.elapsed);
    this._quipBanter = this._groupBanter ? null : this.findNearbyQuipBanter(player, playerZone);

    this.stats.walking = walking;
    this.stats.seated = seated;
    this.stats.tiers = tiers;
    this.stats.emergentGroups = this.social.groups.size;
    this.stats.abstractTrips = abstractTrips;
  }

  private recoverRouteFailure(w: Walker, want: V3ZoneId): void {
    if (++w.failures < 4) {
      const list = this.spotsOf(want);
      w.dest = list.length ? list[(hashId(w.id) + w.failures * 3) % list.length] : null;
      w.pending = !!w.dest;
    }
  }

  private stepSocialPass(s: V3State, env: EnvSnapshot, player: P | null, playerZone: V3ZoneId | null): void {
    this.activeScenesZonesScratch.clear();
    this.activeSceneActorsScratch.clear();
    for (let i = 0; i < this.walkerList.length; i++) {
      const w = this.walkerList[i];
      if (!w.moving) this.activeScenesZonesScratch.add(w.zone);
    }

    const scenes: string[] = [];
    for (const z of this.activeScenesZonesScratch) {
      for (const sc of detectZoneSocialScenes(s, z)) {
        scenes.push(sc.id);
        const [a, b] = sc.actors;
        const wa = this.walkers.get(a.id);
        const wb = this.walkers.get(b.id);
        if (!wa || !wb) continue;
        this.activeSceneActorsScratch.add(wa.id);
        this.activeSceneActorsScratch.add(wb.id);
        wa.facing = wb.id;
        wb.facing = wa.id;
        wa.sceneId = sc.id;
        wb.sceneId = sc.id;
        wa.scenePose = sc.pose[0] || 'wave';
        wb.scenePose = sc.pose[1] || 'idle';
        if (!SIT_ACTIVITIES.has(wa.scenePose)) { this.beginStandUp(wa); wa.targetSeat = null; }
        if (!SIT_ACTIVITIES.has(wb.scenePose)) { this.beginStandUp(wb); wb.targetSeat = null; }

        const pairDist = Math.hypot(wa.x - wb.x, wa.z - wb.z);
        if (!wb.moving && !wb.seat && (pairDist > 2.4 || pairDist < 0.85)) {
          const baseAng = Math.atan2(wb.x - wa.x, wb.z - wa.z);
          let best: P | null = null;
          for (let k = 0; k < 8; k++) {
            const ang = baseAng + (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 4);
            const cand = { x: wa.x + Math.sin(ang) * 1.25, z: wa.z + Math.cos(ang) * 1.25 };
            if (!this.nav.walk.free(cand)) continue;
            let crowd = false;
            for (let m = 0; m < this.walkerList.length; m++) {
              const o = this.walkerList[m];
              if (o === wa || o === wb) continue;
              if (Math.hypot(o.x - cand.x, o.z - cand.z) < 0.95) { crowd = true; break; }
            }
            if (crowd) continue;
            if (this.nav.clear({ x: wb.x, z: wb.z }, cand)) { best = cand; break; }
          }
          if (best) {
            wb.dest = best;
            wb.route = { points: [best], doors: [], length: Math.hypot(best.x - wb.x, best.z - wb.z) };
            wb.ri = 0;
          }
        }
        if (!wa.moving) wa.activity = wa.scenePose;
        if (!wb.moving) wb.activity = wb.scenePose;
        this.mirror(s.npcs[a.id], wa);
        this.mirror(s.npcs[b.id], wb);
      }
    }

    for (let i = 0; i < this.walkerList.length; i++) {
      const w = this.walkerList[i];
      if (w.sceneId && !this.activeSceneActorsScratch.has(w.id)) {
        w.sceneId = null;
        w.scenePose = null;
        w.facing = null;
      }
    }
    this.stats.scenes = scenes;
    if (s.worldV3) s.worldV3.activeSocialScenes = scenes;

    // Emergent 2–3 resident gatherings (uses reused scratch array)
    this.socialViewsScratch.length = 0;
    for (let i = 0; i < this.walkerList.length; i++) {
      const w = this.walkerList[i];
      if (!isResidentId(w.id)) continue;
      this.socialViewsScratch.push({
        id: w.id,
        x: w.x,
        z: w.z,
        yaw: w.yaw,
        zone: w.zone,
        moving: w.moving,
        seated: Boolean(w.seat),
        seatId: w.seat?.id ?? null,
        v3SceneLocked: Boolean(w.sceneId),
        talking: this.talking === w.id,
      });
    }

    this.socialDirectives = this.social.step(s, this.nav, this.mind, this.socialViewsScratch, env, this.elapsed);

    // Move newly grouped emergent members cleanly onto their verified semicircular formation slot
    for (const [rid, dir] of this.socialDirectives) {
      const w = this.walkers.get(rid);
      if (!w || w.moving || w.seat || w.sceneId || dir.slot.seatId) continue;
      const dist = Math.hypot(dir.slot.x - w.x, dir.slot.z - w.z);
      if (dist > 0.35 && this.nav.clear(w, dir.slot)) {
        w.route = { points: [{ x: dir.slot.x, z: dir.slot.z }], doors: [], length: dist };
        w.ri = 0;
      }
    }

    this._groupBanter = this.social.overheardBanterNear(player, playerZone, this.playerSpeed, this.elapsed);
    this._quipBanter = this._groupBanter ? null : this.findNearbyQuipBanter(player, playerZone);
  }

  /** Surface the closest active resident quip (< 7.5 m) when no emergent group banter is active. */
  private findNearbyQuipBanter(player: P | null, playerZone: V3ZoneId | null): OverheardBanter | null {
    if (!player || this.playerSpeed > 2.0) return null;
    let best: OverheardBanter | null = null;
    let bestDist = 7.5;

    for (let i = 0; i < this.walkerList.length; i++) {
      const w = this.walkerList[i];
      if (!w.quip || !isResidentId(w.id)) continue;
      if (w.quipUntil !== undefined && this.elapsed >= w.quipUntil) continue;
      const indoorZone = !INDOOR_QUIP_OUTDOOR_ZONES.has(w.zone);
      if (indoorZone && playerZone !== w.zone) continue;
      const d = Math.hypot(w.x - player.x, w.z - player.z);
      if (d < bestDist) {
        bestDist = d;
        best = {
          groupId: `quip:${w.id}`,
          speakerId: w.id,
          speakerName: CHARACTERS[w.id]?.name ?? w.id,
          text: w.quip,
          dist: d,
          topic: 'quip',
        };
      }
    }
    return best;
  }

  /** Advance lightweight FIFO counter queues (<= 5 slots, 0.85 m spacing) at market, bistro, library, cafe. */
  private stepCounterQueues(s: V3State): void {
    for (const q of this.counterQueues.values()) {
      if (!isZoneOpen(v3Zones[q.zone], s.clock).open) {
        q.entries.length = 0;
        continue;
      }

      // 1. Prune invalid / departed / busy entries while preserving strict FIFO order
      let compacted = false;
      for (let i = q.entries.length - 1; i >= 0; i--) {
        const entry = q.entries[i];
        const w = this.walkers.get(entry.walkerId);
        if (
          !w ||
          w.zone !== q.zone ||
          w.destZone !== q.zone ||
          this.talking === w.id ||
          w.sceneId ||
          w.emergentGroupId ||
          w.seat ||
          w.targetSeat
        ) {
          q.entries.splice(i, 1);
          compacted = true;
        }
      }

      // 2. Serve slot 0 (4.5-6.5 s transaction), then ripple remaining slots forward 0.4 s staggered
      if (q.entries.length > 0) {
        const head = q.entries[0];
        const hw = this.walkers.get(head.walkerId);
        const slot0 = q.slots[0];
        if (hw && slot0) {
          const d0 = Math.hypot(hw.x - slot0.x, hw.z - slot0.z);
          if (d0 <= 0.48) {
            hw.yaw = turnSmooth(hw.yaw, slot0.yaw, 0.5, 6.0, 4.5);
            if (head.serviceUntil === 0) {
              const serviceSec = 4.5 + (hashId(hw.id) % 5) * 0.5;
              head.serviceUntil = this.elapsed + serviceSec;
            } else if (this.elapsed >= head.serviceUntil) {
              q.entries.shift();
              hw.queueCooldownUntil = this.elapsed + 95;
              if (isResidentId(hw.id)) {
                const mindState = this.mind.minds.get(hw.id);
                if (mindState) {
                  mindState.needs.hunger = Math.min(100, mindState.needs.hunger + 18);
                  mindState.needs.fun = Math.min(100, mindState.needs.fun + 4);
                }
              }
              if (hw.tier === 0) {
                hw.quip = q.zone === 'library' ? 'Thanks for checking that in!' : 'Thanks so much — smells great!';
                hw.quipUntil = this.elapsed + 2.4;
              }
              compacted = true;
            }
          }
        }
      }

      if (compacted) {
        for (let k = 0; k < q.entries.length; k++) {
          q.entries[k].advanceAt = this.elapsed + k * 0.4;
          if (k > 0) q.entries[k].serviceUntil = 0;
        }
      }

      // 3. Admit new settled customer residents into the tail free slot
      if (q.entries.length < q.slots.length) {
        for (let i = 0; i < this.walkerList.length && q.entries.length < q.slots.length; i++) {
          const w = this.walkerList[i];
          if (w.zone !== q.zone || w.destZone !== q.zone || w.id === q.shopkeeperId) continue;
          if (w.moving || w.seat || w.targetSeat || w.sceneId || w.emergentGroupId || this.talking === w.id) continue;
          if ((w.queueCooldownUntil ?? 0) > this.elapsed) continue;
          if (q.entries.some(e => e.walkerId === w.id)) continue;
          if (isResidentId(w.id)) {
            const gKind = this.mind.minds.get(w.id)?.goal.kind;
            if (gKind === 'V3_HARD_LOCK') continue;
            const wantsCounter = gKind === 'SATISFY_HUNGER' || gKind === 'SEEK_SHELTER' || q.zone === 'market' || q.zone === 'library';
            if (!wantsCounter) continue;
          }
          q.entries.push({
            walkerId: w.id,
            joinedAt: this.elapsed,
            serviceUntil: 0,
            advanceAt: this.elapsed,
          });
        }
      }

      // 4. Steer each queued member cleanly to their FIFO slot on walkable floor
      for (let k = 0; k < q.entries.length; k++) {
        const entry = q.entries[k];
        const slot = q.slots[k];
        const w = this.walkers.get(entry.walkerId);
        if (!w || !slot || this.elapsed < entry.advanceAt) continue;
        const dist = Math.hypot(slot.x - w.x, slot.z - w.z);
        if (dist > 0.32 && !w.route && !w.abstractTrip) {
          if (this.nav.clear(w, slot)) {
            w.route = { points: [{ x: slot.x, z: slot.z }], doors: [], length: dist };
            w.ri = 0;
          }
        } else if (dist <= 0.32 && !w.moving) {
          w.yaw = turnSmooth(w.yaw, slot.yaw, 0.5, 5.5, 4.2);
        }
      }
    }
  }

  private isRoadOrCrossing(p: P): boolean {
    for (let i = 0; i < this.roadAndCrossingRects.length; i++) {
      if (inRect(p, this.roadAndCrossingRects[i])) return true;
    }
    return false;
  }

  private inAnyDoorCorridor(x: number, z: number): boolean {
    for (let i = 0; i < this.nav.doors.length; i++) {
      const c = this.nav.doors[i].corridor;
      if (x >= c.x0 && x <= c.x1 && z >= c.z0 && z <= c.z1) return true;
    }
    return false;
  }

  private hitsParkedVehicle(p: P, pad = BODY_RADIUS + 0.2): ParkedVehicleObstacle | null {
    const checkList = (list: readonly ParkedVehicleObstacle[]): ParkedVehicleObstacle | null => {
      for (let i = 0; i < list.length; i++) {
        const pv = list[i];
        const rx = p.x - pv.x;
        const rz = p.z - pv.z;
        const maxReach = Math.max(pv.radius ?? 0, pv.halfWidth, pv.halfLength) + pad + 0.4;
        if (Math.abs(rx) > maxReach || Math.abs(rz) > maxReach) continue;
        const fx = Math.sin(pv.yaw);
        const fz = Math.cos(pv.yaw);
        const localFwd = rx * fx + rz * fz;
        const localLat = rx * fz - rz * fx;
        const hw = (pv.halfWidth > 0 ? pv.halfWidth : (pv.radius ?? 0.9) * 0.75) + pad;
        const hl = (pv.halfLength > 0 ? pv.halfLength : (pv.radius ?? 1.2)) + pad;
        if (Math.abs(localFwd) < hl && Math.abs(localLat) < hw) return pv;
      }
      return null;
    };
    return checkList(this.staticCurbVehicles) ?? checkList(this.parkedVehicles);
  }

  /** Tier 2 continuous 0.5 Hz abstract spine traversal with live closed-door safety and zero teleport. */
  private walkAbstract(w: Walker, dt: number, activity: string, player: P | null, env: EnvSnapshot): void {
    this.tryCloseBehind(w, player);
    const trip = w.abstractTrip;
    if (!trip || trip.furnitureRevision !== this.nav.furnitureRevision) {
      w.abstractTrip = null;
      w.moving = false;
      w.pending = !!w.dest;
      return;
    }

    const baseSpeed = isResidentId(w.id)
      ? this.mind.shelterWalkSpeed(w.id, env, w.outdoor, w.rainUmbrella)
      : WALK;
    const speed = Math.min(RUN, activity === 'run' && w.outdoor ? RUN : baseSpeed);
    const prevOpened = w.opened ?? null;
    const res = this.zoneGraph.advanceTrip(trip, dt * speed, this.doors, prevOpened);

    if (res.openedDoor && res.openedDoor !== prevOpened) {
      this.stats.doorsOpened++;
      w.opened = res.openedDoor;
      const plan = this.doorPlans.get(res.openedDoor);
      if (plan) w.closeBehind = { door: res.openedDoor, at: plan };
    }
    if (res.closeBehindDoor) {
      w.closeBehind = res.closeBehindDoor;
      this.tryCloseBehind(w, player);
    }

    // Defensive closed-door corridor guard before committing Tier 2 position
    if (this.inClosedDoorCorridor(res.x, res.z)) {
      w.moving = false;
      w.vx = 0;
      w.vz = 0;
      return;
    }

    if (this.nav.walk.free({ x: res.x, z: res.z })) {
      const prevX = w.x;
      const prevZ = w.z;
      w.x = res.x;
      w.z = res.z;
      w.yaw = turnSmooth(w.yaw, res.yaw, Math.min(dt, 0.35), 9.0, 6.2);
      if (dt > 1e-4) {
        w.vx = (w.x - prevX) / dt;
        w.vz = (w.z - prevZ) / dt;
      }
      this.refreshPoseCache(w);
    } else {
      // Furniture changed or edge grazed: re-plan cleanly on next budget
      w.abstractTrip = null;
      w.pending = !!w.dest;
      w.moving = false;
      w.vx = 0;
      w.vz = 0;
      return;
    }

    if (res.arrived) {
      w.abstractTrip = null;
      w.moving = false;
      w.vx = 0;
      w.vz = 0;
      this.tryCloseBehind(w, player);
    } else {
      w.moving = !res.waitingDoor;
      if (!w.moving) {
        w.vx = 0;
        w.vz = 0;
      }
    }
  }

  private inClosedDoorCorridor(x: number, z: number): boolean {
    for (let i = 0; i < this.nav.doors.length; i++) {
      const d = this.nav.doors[i];
      const c = d.corridor;
      if (x >= c.x0 && x <= c.x1 && z >= c.z0 && z <= c.z1) {
        const live = this.doors.door(d.id);
        if (live && !live.passable) {
          if (!live.isOpen) {
            live.prepare({ x, z });
            live.setOpen(true);
            this.stats.doorsOpened++;
          }
          return true;
        }
      }
    }
    return false;
  }

  /** Gentle floor-proven separation between standing residents (uses cached `groundY` & `walkerList`). */
  private separateWalkers(dt: number): void {
    const list = this.walkerList;
    const maxPush = Math.min(0.18, dt * 1.15);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.seat || a.lastSeat || a.tier === 2) continue;
      let px = 0;
      let pz = 0;
      const ay = a.groundY;
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        const b = list[j];
        const ox = b.seat ? b.seat.sit.x : b.x;
        const oz = b.seat ? b.seat.sit.z : b.z;
        const dx = a.x - ox;
        const dz = a.z - oz;
        const minSep = a.facing === b.id ? SCENE_MIN_SEP : NPC_MIN_SEP;
        if (Math.abs(dx) >= minSep || Math.abs(dz) >= minSep) continue;
        const dist = Math.hypot(dx, dz);
        if (dist >= minSep) continue;
        const by = b.seat ? b.seat.sit.y : b.groundY;
        if (Math.abs(by - ay) > 0.45) continue;
        const overlap = minSep - dist;
        const ang = dist > 1e-4 ? Math.atan2(dx, dz) : ((hashId(a.id) % 360) * Math.PI) / 180;
        const weight = b.seat || b.id === this.talking ? 1.0 : 0.55;
        px += Math.sin(ang) * overlap * weight;
        pz += Math.cos(ang) * overlap * weight;
      }
      const len = Math.hypot(px, pz);
      if (len < 1e-4) continue;
      const step = Math.min(len, maxPush);
      const cand = this.probeScratch;
      cand.x = a.x + (px / len) * step;
      cand.z = a.z + (pz / len) * step;
      if (this.nav.walk.free(cand) && !this.inClosedDoorCorridor(cand.x, cand.z)) {
        const surf = this.nav.walk.surface(cand);
        const maxDy = surf?.region === 'stair' ? 0.28 : 0.15;
        if (surf && Math.abs(surf.y - ay) < maxDy) {
          a.x = cand.x;
          a.z = cand.z;
          a.groundY = surf.y;
          a.outdoor = OUTDOOR_REGIONS.has(surf.region);
          if (surf.zone && surf.zone !== 'study') a.zone = surf.zone;
        }
      }
    }
  }

  /** The live door (if anyone can see it) on the leg ending at route point `i`. */
  private gate(r: Route, i: number) {
    const d = r.doors.find(x => x.index === i);
    if (!d) return null;
    const live = this.doors.door(d.door);
    const plan = this.doorPlans.get(d.door);
    return live && plan ? { id: d.door, live, at: plan } : null;
  }

  private walk(
    s: V3State,
    w: Walker,
    dt: number,
    activity: string,
    player: P | null,
    tier: TierLevel,
    env: EnvSnapshot,
    selfIdx: number,
  ): void {
    this.tryCloseBehind(w, player);
    if (dt <= 1e-6) return;

    // Smooth velocity-steered polite doorway step-aside (eliminates 0.42 m single-frame teleport!)
    if (w.asideTarget) {
      if (this.elapsed >= (w.asideUntil ?? 0)) {
        w.asideTarget = null;
      } else {
        const adx = w.asideTarget.x - w.x;
        const adz = w.asideTarget.z - w.z;
        const ad = Math.hypot(adx, adz);
        if (ad <= 0.06) {
          w.asideTarget = null;
          w.moving = false;
          w.vx = 0;
          w.vz = 0;
        } else {
          const asideSpd = Math.min(1.25, ad / Math.max(dt, 1 / 60));
          const ux = adx / ad;
          const uz = adz / ad;
          const cand = this.probeScratch;
          cand.x = w.x + ux * asideSpd * dt;
          cand.z = w.z + uz * asideSpd * dt;
          if (this.nav.walk.free(cand) && !this.inClosedDoorCorridor(cand.x, cand.z)) {
            w.x = cand.x;
            w.z = cand.z;
            w.vx = ux * asideSpd;
            w.vz = uz * asideSpd;
            w.moving = true;
            w.yaw = turnSmooth(w.yaw, Math.atan2(ux, uz), dt, 8.5, 5.2);
            this.refreshPoseCache(w);
            return;
          }
          w.asideTarget = null;
        }
      }
    }

    const r = w.route;
    if (!r || w.ri >= r.points.length) {
      w.moving = false;
      w.vx = 0;
      w.vz = 0;
      if (r && w.ri >= r.points.length) w.route = null;
      const partner = w.facing ? this.walkers.get(w.facing) : null;
      if (partner) w.yaw = turnSmooth(w.yaw, Math.atan2(partner.x - w.x, partner.z - w.z), dt, 5.5, 4.0);
      return;
    }

    const next = r.points[w.ri];
    const gate = this.gate(r, w.ri);
    if (gate) {
      const dd = Math.hypot(gate.at.x - w.x, gate.at.z - w.z);
      if (!gate.live.passable && dd < DOOR_STOP + 0.25) {
        if (!gate.live.isOpen) {
          gate.live.prepare({ x: w.x, z: w.z });
          gate.live.setOpen(true);
          this.stats.doorsOpened++;
          w.closeBehind = null;
          w.opened = gate.id;
        }
        w.waitDoor += dt;
        if (w.waitDoor >= 2.5) {
          gate.live.prepare(w);
          gate.live.setOpen(true);
          w.waitDoor = 0;
          w.route = null;
        }
        w.moving = false;
        w.vx = 0;
        w.vz = 0;
        w.yaw = turnSmooth(w.yaw, Math.atan2(gate.at.x - w.x, gate.at.z - w.z), dt, 7.5, 5.0);
        return;
      }
      // Agreeableness-aware doorway yielding + velocity-steered polite step-aside & "After you!" quip
      if (dd < DOOR_STOP + 0.35 && dd > 0.45 && w.waitDoor < 2.2) {
        const wAgree = isResidentId(w.id) ? RESIDENT_PROFILES[w.id].traits.agreeableness : 0.7;
        let yieldTarget: P | null = null;
        let politeYield = false;

        if (player) {
          const pd = Math.hypot(gate.at.x - player.x, gate.at.z - player.z);
          if (pd < 1.35 && (pd < dd + 0.1 || wAgree >= 0.72)) {
            yieldTarget = player;
            politeYield = true;
          }
        }
        if (!yieldTarget) {
          for (let i = 0; i < this.walkerList.length; i++) {
            const o = this.walkerList[i];
            if (o === w) continue;
            const od = Math.hypot(gate.at.x - o.x, gate.at.z - o.z);
            if (od < 0.95 && od < dd - 0.12) {
              yieldTarget = o;
              politeYield = wAgree >= 0.75;
              break;
            }
            if (od < 1.25 && dd < 1.35) {
              // Opposing sides of doorway: higher Agreeableness yields cleanly
              const oAgree = isResidentId(o.id) ? RESIDENT_PROFILES[o.id].traits.agreeableness : 0.65;
              const sideDot = (w.x - gate.at.x) * (o.x - gate.at.x) + (w.z - gate.at.z) * (o.z - gate.at.z);
              if (sideDot < -0.1 && (wAgree > oAgree + 0.04 || (Math.abs(wAgree - oAgree) <= 0.04 && hashId(w.id) > hashId(o.id)))) {
                yieldTarget = o;
                politeYield = true;
                break;
              }
            }
          }
        }

        if (yieldTarget) {
          w.waitDoor += dt;
          w.moving = false;
          w.vx = 0;
          w.vz = 0;
          w.lookTarget = { x: yieldTarget.x, z: yieldTarget.z };
          w.yaw = turnSmooth(w.yaw, Math.atan2(yieldTarget.x - w.x, yieldTarget.z - w.z), dt, 7.0, 4.8);
          if (politeYield && this.elapsed >= (w.doorQuipCooldownUntil ?? 0)) {
            w.doorQuipCooldownUntil = this.elapsed + 18;
            w.quip = 'After you!';
            w.quipUntil = this.elapsed + 2.4;
            // Queue floor-verified smooth step-aside clear of any door corridor (zero instant teleport!)
            const toDoorLen = Math.max(0.01, dd);
            const perpX = -(gate.at.z - w.z) / toDoorLen;
            const perpZ = (gate.at.x - w.x) / toDoorLen;
            const sign = (hashId(w.id) & 1) === 0 ? 1 : -1;
            for (const sgn of [sign, -sign]) {
              const aside = { x: w.x + perpX * sgn * 0.42, z: w.z + perpZ * sgn * 0.42 };
              if (
                this.nav.walk.free(aside) &&
                !this.inAnyDoorCorridor(aside.x, aside.z) &&
                Math.abs((this.nav.walk.groundAt(aside.x, aside.z) ?? w.groundY) - w.groundY) < 0.15
              ) {
                w.asideTarget = aside;
                w.asideUntil = this.elapsed + 0.55;
                break;
              }
            }
          }
          return;
        }
      }
      if (gate.live.passable && w.opened === gate.id && !w.closeBehind) {
        w.closeBehind = { door: gate.id, at: gate.at };
      }
    }

    // Crosswalk curb-waiting, yield-wave recognition & smooth velocity-steered emergency dodge for ALL 22 residents
    const ahead = Math.atan2(next.x - w.x, next.z - w.z);
    if (w.outdoor && this.hazardsScratch.length > 0) {
      const stepProbe = this.probeScratch;
      stepProbe.x = w.x + Math.sin(ahead) * 0.85;
      stepProbe.z = w.z + Math.cos(ahead) * 0.85;
      const onRoad = this.isRoadOrCrossing(w);
      const enteringRoad = !onRoad && this.isRoadOrCrossing(stepProbe);

      for (let hIdx = 0; hIdx < this.hazardsScratch.length; hIdx++) {
        const v = this.hazardsScratch[hIdx];
        const vSpeed = v.speed ?? Math.hypot(v.vx, v.vz);
        const rx = w.x - v.x;
        const rz = w.z - v.z;
        const dist = Math.hypot(rx, rz);
        if (dist > 17.5) continue;

        const vRad = v.radius ?? 1.2;
        const hasVel = vSpeed > 0.35;
        const vhx = hasVel ? v.vx / vSpeed : 0;
        const vhz = hasVel ? v.vz / vSpeed : 1;

        // 1. Curb lookahead BEFORE stepping into crosswalk / carriageway (TTA < 2.6 s within 16 m at > 1.5 m/s)
        if (enteringRoad && dist <= 16 && vSpeed > 1.5) {
          const px = stepProbe.x - v.x;
          const pz = stepProbe.z - v.z;
          const fwd = px * vhx + pz * vhz;
          const lat = Math.abs(px * -vhz + pz * vhx);
          const tta = fwd / vSpeed;
          if (fwd > -1.0 && tta >= 0 && tta < 2.6 && lat < vRad + 2.4) {
            w.moving = false;
            w.vx = 0;
            w.vz = 0;
            w.lookTarget = { x: v.x, z: v.z };
            w.yaw = turnSmooth(w.yaw, Math.atan2(v.x - w.x, v.z - w.z), dt, 7.5, 5.0);
            w.curbWaitIsPlayer = Boolean(v.isPlayer);
            w.curbWaitAt = this.elapsed;
            return;
          }
        }

        // 2. Smooth velocity-steered perpendicular sidewalk dodge (< 3.8 m oncoming vehicle OR active horn within 5.0 m)
        const fwdHere = hasVel ? rx * vhx + rz * vhz : 0;
        const latSigned = hasVel ? rx * -vhz + rz * vhx : 0;
        const dangerClose = vSpeed > 1.5 && dist < 3.8 && fwdHere > -0.6 && Math.abs(latSigned) < vRad + 1.35;
        const hornClose = Boolean(v.hornActive) && dist < 5.0;
        if (dangerClose || hornClose) {
          const dodgeSpd = 2.05;
          const dodgeStep = Math.min(0.42, dt * dodgeSpd);
          const sideSign = latSigned >= 0 ? 1 : -1;
          const p1x = hasVel ? -vhz * sideSign : dist > 1e-3 ? rx / dist : 1;
          const p1z = hasVel ? vhx * sideSign : dist > 1e-3 ? rz / dist : 0;
          const invD = dist > 1e-3 ? 1 / dist : 0;
          let chosenX = 0;
          let chosenZ = 0;
          let chosenDirX = 0;
          let chosenDirZ = 0;
          let hasChosen = false;

          for (let cIdx = 0; cIdx < 3; cIdx++) {
            const cx = cIdx === 0 ? p1x : cIdx === 1 ? -p1x : rx * invD;
            const cz = cIdx === 0 ? p1z : cIdx === 1 ? -p1z : rz * invD;
            if (cx * cx + cz * cz < 0.01) continue;
            stepProbe.x = w.x + cx * dodgeStep;
            stepProbe.z = w.z + cz * dodgeStep;
            if (!this.nav.walk.free(stepProbe) || this.inAnyDoorCorridor(stepProbe.x, stepProbe.z)) continue;
            const gy = this.nav.walk.groundAt(stepProbe.x, stepProbe.z);
            if (gy === null || Math.abs(gy - w.groundY) > 0.25) continue;
            if (!this.isRoadOrCrossing(stepProbe)) {
              chosenX = stepProbe.x;
              chosenZ = stepProbe.z;
              chosenDirX = cx;
              chosenDirZ = cz;
              hasChosen = true;
              break;
            }
            if (!hasChosen) {
              chosenX = stepProbe.x;
              chosenZ = stepProbe.z;
              chosenDirX = cx;
              chosenDirZ = cz;
              hasChosen = true;
            }
          }
          if (hasChosen) {
            w.x = chosenX;
            w.z = chosenZ;
            w.vx = chosenDirX * dodgeSpd;
            w.vz = chosenDirZ * dodgeSpd;
            w.moving = true;
            w.yaw = turnSmooth(w.yaw, Math.atan2(chosenDirX, chosenDirZ), dt, 10.0, 6.4);
            this.refreshPoseCache(w);
          } else {
            w.moving = false;
            w.vx = 0;
            w.vz = 0;
            w.yaw = turnSmooth(w.yaw, Math.atan2(v.x - w.x, v.z - w.z), dt, 8.5, 5.5);
          }
          w.lookTarget = { x: v.x, z: v.z };
          if (!w.quip) {
            w.quip = 'Whoa — watch the crosswalk!';
            w.quipUntil = this.elapsed + 2.4;
          }
          if (v.isPlayer && vSpeed > 3.5 && dangerClose && isResidentId(w.id)) {
            this.mind.recordMemory(w.id, {
              kind: 'player_horn',
              day: s.day,
              clock: s.clock,
              subject: this.playerVehicle?.name ?? 'car',
              valence: -0.45,
              salience: 0.62,
              zone: w.zone,
            });
          }
          return;
        }
      }

      // 3. Yield-acknowledge wave (+2 district reputation when player slows < 1.0 m/s for waiting resident)
      if (w.curbWaitIsPlayer && this.elapsed - (w.curbWaitAt ?? -99) < 4.0 && this.playerVehicle) {
        const pd = Math.hypot(this.playerVehicle.x - w.x, this.playerVehicle.z - w.z);
        if (pd <= 14 && this.playerVehicle.speed < 1.0) {
          w.curbWaitIsPlayer = false;
          w.yieldCrossUntil = this.elapsed + 3.2;
          w.greetUntil = Math.max(w.greetUntil, this.elapsed + 1.8);
          if (this.elapsed >= (w.yieldRepCooldownUntil ?? 0)) {
            w.yieldRepCooldownUntil = this.elapsed + 30;
            this.mind.adjustDistrictReputation(w.zone, 2);
            w.quip = 'Thanks for stopping!';
            w.quipUntil = this.elapsed + 2.4;
          }
        }
      }
    }

    const weatherSpeed = isResidentId(w.id)
      ? this.mind.shelterWalkSpeed(w.id, env, w.outdoor, w.rainUmbrella)
      : WALK;
    let moveSpeed = activity === 'run' && w.outdoor ? RUN : weatherSpeed;
    if (w.yieldCrossUntil && this.elapsed < w.yieldCrossUntil && w.outdoor) {
      moveSpeed = Math.max(moveSpeed, 1.48);
    }
    const maxSpeed = Math.min(RUN, moveSpeed);

    // Zero-alloc ORCA-Lite avoidance (`orca2d.ts`: player, peer residents via SpatialHash2D, static curb cars & parked vehicles)
    const gateClearForOrca = !gate || Math.hypot(gate.at.x - w.x, gate.at.z - w.z) > DOOR_STOP + 0.45;
    if (tier <= 1 && gateClearForOrca && dt <= 0.25) {
      // Pure-pursuit lookahead target along upcoming unobstructed route polyline
      let lookX = next.x;
      let lookZ = next.z;
      let dToNext = Math.hypot(lookX - w.x, lookZ - w.z);
      if (dToNext < 0.62 && w.ri + 1 < r.points.length && !this.gate(r, w.ri + 1)) {
        const after = r.points[w.ri + 1];
        if (this.nav.clear(w, after)) {
          lookX = after.x;
          lookZ = after.z;
          dToNext = Math.hypot(lookX - w.x, lookZ - w.z);
        }
      }
      const prefVx = dToNext > 1e-4 ? ((lookX - w.x) / dToNext) * maxSpeed : 0;
      const prefVz = dToNext > 1e-4 ? ((lookZ - w.z) / dToNext) * maxSpeed : 0;

      const orca = this.orca;
      orca.reset();
      const curVx = w.vx;
      const curVz = w.vz;

      // A. Avoid Player (`alpha = 1.0`, smooth tangential pass instead of hard freeze!)
      if (player && Math.abs(this.playerGroundY - w.groundY) < 0.55) {
        const pdx = player.x - w.x;
        const pdz = player.z - w.z;
        if (pdx * pdx + pdz * pdz < 20.25) {
          addOrcaDiskConstraint(
            orca,
            w.x,
            w.z,
            curVx,
            curVz,
            player.x,
            player.z,
            this.playerVx,
            this.playerVz,
            0.80,
            1.75,
            1.0,
          );
        }
      }

      // B. Avoid nearby peer residents via O(1) 1024-bucket SpatialHash2D
      const cx = Math.floor(w.x * this.residentHash.invCellSize);
      const cz = Math.floor(w.z * this.residentHash.invCellSize);
      for (let ox = -1; ox <= 1 && orca.count < OrcaScratch.MAX_LINES - 4; ox++) {
        for (let oz = -1; oz <= 1 && orca.count < OrcaScratch.MAX_LINES - 4; oz++) {
          let j = this.residentHash.head[this.residentHash.bucketOfCell(cx + ox, cz + oz)];
          while (j !== -1 && orca.count < OrcaScratch.MAX_LINES - 4) {
            if (j !== selfIdx) {
              const o = this.walkerList[j];
              const oy = o.seat ? o.seat.sit.y : o.groundY;
              if (Math.abs(oy - w.groundY) < 0.45) {
                const bx = o.seat ? o.seat.sit.x : o.x;
                const bz = o.seat ? o.seat.sit.z : o.z;
                const dx = bx - w.x;
                const dz = bz - w.z;
                if (dx * dx + dz * dz < 12.96) {
                  addOrcaDiskConstraint(
                    orca,
                    w.x,
                    w.z,
                    curVx,
                    curVz,
                    bx,
                    bz,
                    o.seat ? 0 : o.vx,
                    o.seat ? 0 : o.vz,
                    0.78,
                    1.8,
                    o.seat || !o.moving ? 1.0 : 0.5,
                  );
                }
              }
            }
            j = this.residentHash.next[j];
          }
        }
      }

      // C. Avoid stationary parked vehicles AND all 6 static curb-parked cars via OBB ORCA!
      if (w.outdoor) {
        for (let k = 0; k < this.staticCurbVehicles.length && orca.count < OrcaScratch.MAX_LINES; k++) {
          const pv = this.staticCurbVehicles[k];
          addOrcaStaticObbConstraint(
            orca,
            w.x,
            w.z,
            curVx,
            curVz,
            0.30,
            pv.x,
            pv.z,
            pv.yaw,
            pv.halfWidth > 0 ? pv.halfWidth : (pv.radius ?? 0.9) * 0.75,
            pv.halfLength > 0 ? pv.halfLength : (pv.radius ?? 1.2),
            0.22,
            1.4,
          );
        }
        for (let k = 0; k < this.parkedVehicles.length && orca.count < OrcaScratch.MAX_LINES; k++) {
          const pv = this.parkedVehicles[k];
          addOrcaStaticObbConstraint(
            orca,
            w.x,
            w.z,
            curVx,
            curVz,
            0.30,
            pv.x,
            pv.z,
            pv.yaw,
            pv.halfWidth > 0 ? pv.halfWidth : (pv.radius ?? 0.9) * 0.75,
            pv.halfLength > 0 ? pv.halfLength : (pv.radius ?? 1.2),
            0.22,
            1.4,
          );
        }
      }

      if (orca.count > 0) {
        solveOrca2D(orca, prefVx, prefVz, maxSpeed);
        const dvx = orca.outVx - prefVx;
        const dvz = orca.outVz - prefVz;
        // Engage ORCA step whenever constraints actually deflect or slow preferred velocity
        if (dvx * dvx + dvz * dvz > 0.0025) {
          const velBlend = 1 - Math.exp(-12 * dt);
          const nextVx = w.vx + (orca.outVx - w.vx) * velBlend;
          const nextVz = w.vz + (orca.outVz - w.vz) * velBlend;
          const nextSpd = Math.hypot(nextVx, nextVz);
          const clampedScale = nextSpd > maxSpeed ? maxSpeed / nextSpd : 1;
          const svx = nextVx * clampedScale;
          const svz = nextVz * clampedScale;

          const tryOrcaStep = (vxTry: number, vzTry: number): boolean => {
            const cand = this.probeScratch;
            cand.x = w.x + vxTry * dt;
            cand.z = w.z + vzTry * dt;
            if (!this.nav.walk.free(cand) || this.inClosedDoorCorridor(cand.x, cand.z)) return false;
            if (w.outdoor && this.hitsParkedVehicle(cand, BODY_RADIUS + 0.06)) return false;
            const surf = this.nav.walk.surface(cand);
            if (!surf || Math.abs(surf.y - w.groundY) > 0.3) return false;
            w.x = cand.x;
            w.z = cand.z;
            w.vx = vxTry;
            w.vz = vzTry;
            w.groundY = surf.y;
            w.outdoor = OUTDOOR_REGIONS.has(surf.region);
            if (surf.zone && surf.zone !== 'study') w.zone = surf.zone;
            return true;
          };

          let stepped = false;
          if (nextSpd <= 0.06) {
            // Clean polite yield pause when completely boxed in by player/crowd
            w.vx = 0;
            w.vz = 0;
            w.moving = false;
            w.blocked += dt;
            if (w.blocked > 1.8) w.blocked = 0;
            return;
          }
          stepped = tryOrcaStep(svx, svz);
          if (!stepped && nextSpd > 0.08) {
            // Smooth +-38 deg tangent slide along wall/curb
            const c38 = 0.788;
            const s38 = 0.616;
            stepped =
              tryOrcaStep((svx * c38 - svz * s38) * 0.8, (svx * s38 + svz * c38) * 0.8) ||
              tryOrcaStep((svx * c38 + svz * s38) * 0.8, (-svx * s38 + svz * c38) * 0.8);
          }

          if (stepped) {
            w.blocked = 0;
            // Advance waypoint if reached or smoothly passed around obstacle
            const remNext = Math.hypot(next.x - w.x, next.z - w.z);
            if (remNext <= 0.28) {
              w.ri++;
              w.waitDoor = 0;
            } else if (
              w.ri + 1 < r.points.length &&
              !this.gate(r, w.ri) &&
              !this.gate(r, w.ri + 1) &&
              remNext < 1.1 &&
              Math.hypot(r.points[w.ri + 1].x - w.x, r.points[w.ri + 1].z - w.z) <
                Math.hypot(r.points[w.ri + 1].x - next.x, r.points[w.ri + 1].z - next.z) + 0.15 &&
              this.nav.clear(w, r.points[w.ri + 1])
            ) {
              w.ri++;
              w.waitDoor = 0;
            }
            const vSpdSq = w.vx * w.vx + w.vz * w.vz;
            if (vSpdSq > 0.01) {
              w.yaw = turnSmooth(w.yaw, Math.atan2(w.vx, w.vz), dt, 9.0, 5.6);
            }
            w.moving = w.ri < r.points.length;
            if (!w.moving) {
              w.vx = 0;
              w.vz = 0;
            }
            return;
          }
        }
      }
    }

    // Fallback parked-vehicle route detour when outdoor path intersects a curb car
    if (w.outdoor && (this.staticCurbVehicles.length > 0 || this.parkedVehicles.length > 0)) {
      const lookPt = this.probeScratch;
      lookPt.x = w.x + Math.sin(ahead) * 0.9;
      lookPt.z = w.z + Math.cos(ahead) * 0.9;
      if (this.hitsParkedVehicle(lookPt)) {
        const sideBias = (hashId(w.id) & 1) === 0 ? 1 : -1;
        const angles = [0.65 * sideBias, -0.65 * sideBias, 1.15 * sideBias, -1.15 * sideBias];
        for (let i = 0; i < angles.length; i++) {
          const ang = ahead + angles[i];
          const probe = { x: w.x + Math.sin(ang) * 1.05, z: w.z + Math.cos(ang) * 1.05 };
          if (
            !this.hitsParkedVehicle(probe) &&
            !this.inAnyDoorCorridor(probe.x, probe.z) &&
            this.nav.walk.free(probe) &&
            this.nav.clear(w, probe)
          ) {
            r.points.splice(w.ri, 0, probe);
            for (let k = 0; k < r.doors.length; k++) if (r.doors[k].index >= w.ri) r.doors[k].index++;
            break;
          }
        }
      }
    }

    w.blocked = 0;
    const startX = w.x;
    const startZ = w.z;
    let budget = dt * maxSpeed;
    let moved = false;
    while (budget > 0 && w.ri < r.points.length) {
      const g = this.gate(r, w.ri);
      if (g && !g.live.passable) {
        budget = Math.min(budget, Math.max(0, Math.hypot(g.at.x - w.x, g.at.z - w.z) - DOOR_STOP));
      }
      if (budget <= 1e-6) break;
      const p = r.points[w.ri];
      const dx = p.x - w.x;
      const dz = p.z - w.z;
      const len = Math.hypot(dx, dz);
      const end = len <= budget ? p : { x: w.x + (dx * budget) / len, z: w.z + (dz * budget) / len };
      if (!this.nav.walk.free(end)) {
        const side =
          len > 0.001 &&
          [0.12, -0.12, 0.24, -0.24]
            .map(offset => ({ x: end.x - (dz / len) * offset, z: end.z + (dx / len) * offset }))
            .find(q => this.nav.walk.free(q) && this.nav.clear(w, q) && this.nav.clear(q, p));
        if (side) {
          r.points.splice(w.ri, 0, side);
          for (let k = 0; k < r.doors.length; k++) if (r.doors[k].index >= w.ri) r.doors[k].index++;
        } else {
          w.route = null;
          w.pending = true;
        }
        w.moving = false;
        w.vx = 0;
        w.vz = 0;
        if (moved) this.refreshPoseCache(w);
        return;
      }
      w.x = end.x;
      w.z = end.z;
      moved = true;
      if (len <= budget) {
        budget -= len;
        w.ri++;
        w.waitDoor = 0;
      } else {
        budget = 0;
      }
    }
    if (moved) {
      const mx = w.x - startX;
      const mz = w.z - startZ;
      w.vx = mx / dt;
      w.vz = mz / dt;
      // Smooth pure-pursuit yaw update ONCE per tick outside the waypoint loop (zero multi-turn snapping!)
      let aimX = mx;
      let aimZ = mz;
      if (w.ri < r.points.length) {
        const rem = r.points[w.ri];
        const rdx = rem.x - w.x;
        const rdz = rem.z - w.z;
        if (rdx * rdx + rdz * rdz > 0.04) {
          aimX = rdx;
          aimZ = rdz;
        }
      }
      if (aimX * aimX + aimZ * aimZ > 1e-6) {
        w.yaw = turnSmooth(w.yaw, Math.atan2(aimX, aimZ), dt, 9.0, 5.6);
      }
      this.refreshPoseCache(w);
    } else {
      w.vx = 0;
      w.vz = 0;
    }
    w.moving = w.ri < r.points.length;
    if (!w.moving) {
      w.vx = 0;
      w.vz = 0;
    }
  }
}

type PrecipMode = 'dry' | 'rain' | 'snow';

function smoothstepRange(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-5, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function circularHourDiff(a: number, b: number): number {
  const d = Math.abs((((a % 24) + 24) % 24) - (((b % 24) + 24) % 24));
  return Math.min(d, 24 - d);
}

function precipModeOf(env: Partial<EnvSnapshot> | null | undefined): PrecipMode | null {
  if (!env) return null;
  if (env.weatherId === 'snowy' || (typeof env.snowIntensity === 'number' && env.snowIntensity > 0.25)) return 'snow';
  if (
    env.weatherId === 'light_rain' ||
    env.weatherId === 'heavy_rain' ||
    (typeof env.rainIntensity === 'number' && env.rainIntensity > 0.15)
  ) {
    return 'rain';
  }
  if (env.weatherId !== undefined || env.rainIntensity !== undefined || env.snowIntensity !== undefined) {
    return 'dry';
  }
  return null;
}
