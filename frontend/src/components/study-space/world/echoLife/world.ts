import * as T from 'three';
import { GROUND_Y, housePlan, inRect, type DoorId, type HousePlan, type Rect } from '@/lib/echo-life/plan';
import { cityPlan, ROAD_DROP, type CityPlan } from '@/lib/echo-life/city';
import type { EnterableBuilding } from '@/lib/echo-life/buildings';
import { LifeWalk } from '@/lib/echo-life/walk';
import {
  PlayerCollisionWorld,
  createVegetationObstacles,
  type RoomNavigationLike,
} from '@/lib/echo-life/playerCollision';
import { V3_ZONE_IDS, V3_ZONE_META, type V3ZoneId } from '@/lib/echo-life/zones';
import { loadGatewayAssets } from '../gatewayAssets';
import {
  buildHouse,
  type DoorOccupant,
  type DoorRuntimeSnapshot,
  type HouseBuild,
  type HouseMirrorPlacement,
  type LifeDoor,
  type ShowerEmitterSpec,
  type SolidBox,
} from './house';
import { buildCity, type CityView } from './cityView';
import { CityStreamer, type StreamPrewarmPriority, type StreamingStats } from './streaming';
import { setBuildingInteriorPrewarmHook } from './buildingsView';
import { disposeLifeAssets, isGltf4GbGpuMode, stripTransmissionFromHierarchy } from './assets';
import { disposeStreetProps } from './streetPropsManifest';
import { createGrassField, type GrassField, type GrassFieldStats } from './grassField';
import { buildVegetationLayout, VegetationSystem, type VegetationStats } from './vegetationSystem';
import { VEGETATION_BY_ID } from './vegetationManifest';
import { getRenderConfig, type QualityTier } from './renderConfig';
import { freezeStaticHierarchy, V3_A, V3_B } from './scratch';
import { getInFlightCompileCount } from './echoCsm';
import { getEchoLifeResidencyManager } from './residencyManager';
import {
  EchoLifeOcclusionPortalCuller,
  type DoorStateQuery,
} from './occlusionPortalCuller';

const OUTDOOR_REGIONS = new Set(['study', 'balcony', 'sidewalk', 'road', 'crossing', 'park', 'garden', 'plaza']);
const UPPER_CLOSED_REGIONS = new Set([
  'study', 'door:hall', 'hall', 'living', 'kitchen', 'bath', 'bedroom', 'gaming_room',
  'arch', 'door:bath', 'door:bedroom', 'door:gaming',
]);
const LOWER_CLOSED_REGIONS = new Set(['stair', 'lobby', 'lobbyFoot', 'garage', 'door:garage']);

const WARM_FIXTURE_COLOR = new T.Color('#ffe2bc');
const CRISP_FIXTURE_COLOR = new T.Color('#f2f6ff');
type FixtureEntry = { at: T.Vector3; room: string; warm: boolean };
const TOP_FIXTURES: (FixtureEntry | null)[] = [null, null, null];

/** Preserves swinging doors & `distantLeaf` animated groups while freezing static home walls/floors/furniture. */
function isDynamicHouseNode(obj: T.Object3D): boolean {
  if (obj.userData?.dynamic === true || obj.userData?.door === true || obj.userData?.lifeDoor != null) return true;
  if (obj.type === 'Group' && !obj.name && obj.children.length === 1 && (obj.children[0] as T.Mesh).isMesh) return true;
  return false;
}

/** Preserves animated sky dome, weather particles, and river water while freezing static city ground/skyline/signs. */
function isDynamicCityNode(cityView: CityView) {
  return (obj: T.Object3D): boolean => {
    if (obj.userData?.dynamic === true) return true;
    if (obj === cityView.atmosphere.skyMesh || obj === cityView.water.group) return true;
    const n = obj.name.toLowerCase();
    if (n.includes('weather') || n.includes('particle') || n.includes('sky') || n.includes('water') || n.includes('reed')) {
      return true;
    }
    return false;
  };
}

/**
 * Echo Life — the 10-zone house and 31-zone connected city around the study room, in the room's own stage, scene,
 * renderer and Rapier physics world. Drawn only while the learner explores (first / third person); the editor overview
 * keeps the diorama.
 *
 * Coordinates `CityView` (Poly Haven PBR surfaces, physical atmosphere, river water, weather particles),
 * `CityStreamer` (4-tier spatial streaming + Poly Haven CC0 streetscape props + time-sliced enterable buildings),
 * `GrassField` (GPU-instanced 6-blade wind/foot-bend ecological grass & wildflowers), `VegetationSystem`
 * (22-species botanical trees/shrubs/ferns/flowers/rocks with distance LOD), strict indoor enclosure occlusion
 * culling, and a constant 3-light interior pool with zero runtime shader recompiles.
 */
export class EchoLifeWorld {
  readonly plan: HousePlan;
  readonly city: CityPlan;
  readonly walk: LifeWalk;
  readonly collisionWorld: PlayerCollisionWorld;
  readonly group = new T.Group();
  /**
   * Permanently visible light container (`lightGroup.visible = true` ALWAYS, mounted directly on `stage`
   * alongside `this.group`). Holds the 3 interior `PointLight`s + `interiorBounceHemi` so toggling
   * `this.group.visible` NEVER changes `NUM_POINT_LIGHTS` or `NUM_HEMI_LIGHTS` (0 shader recompiles!).
   */
  readonly lightGroup = new T.Group();

  private house: HouseBuild | null = null;
  private cityView: CityView | null = null;
  private streamer: CityStreamer | null = null;
  private grassField: GrassField | null = null;
  private vegetation: VegetationSystem | null = null;
  private occlusionCuller: EchoLifeOcclusionPortalCuller | null = null;
  private building: Promise<void> | null = null;
  private lights: T.PointLight[] = [];
  private readonly interiorBounceHemi = new T.HemisphereLight('#f6ebd6', '#847462', 0);
  private readonly zeroFog = new T.FogExp2('#c5ddf2', 0);
  private cachedRootScene: T.Scene | null = null;
  private cachedPrimaryHemi: T.HemisphereLight | null = null;
  private readonly doorStateQuery: DoorStateQuery;

  private region: string | null = null;
  private zone: V3ZoneId | null = null;
  private activeInsideBuildingId: string | null = null;
  private activeInsideBuildingRect: Rect | null = null;
  private windowOccluded = false;
  private vehiclePos: { x: number; y: number; z: number; radius?: number } | null = null;
  private chunkSolidsListener?: (bucketKey: string, solids: readonly SolidBox[]) => void;
  private prewarmObject?: (obj: T.Object3D, priority?: StreamPrewarmPriority) => Promise<void> | void;

  private solidsRev = 0;
  private doorsPassableRev = 1;
  private enclosureVisRev = 1;
  private cityIndoorBlend = 0;
  private homeIndoorBlend = 0;
  private tvActiveDesired = false;
  private lastHouseInteriorVis = false;
  private lastInsideBuildingKey: string | null = null;
  private lastCityVis = true;
  private lastNorthVis = true;
  private lastSouthVis = true;
  private lastSidesVis = true;
  private lastStreamerVisRev = -1;
  private lastDoorPassableMap = new Map<string, boolean>();
  private readonly doorOccupantsScratch: DoorOccupant[] = [];
  private readonly activeDoorIdsScratch = new Set<string>();
  private doorOccupantsProvider: () => readonly DoorOccupant[] = () => [];
  private lastStreamerStatsRev = -1;
  private lastStageScale = Number.NaN;
  private lastStageX = Number.NaN;
  private lastStageZ = Number.NaN;
  private timeSec = 0;
  private disposed = false;
  private readyNow = false;

  /** Draw calls, zone telemetry and streaming stats read by QA hooks; nothing reads them for behaviour. */
  stats: {
    built: number;
    populated: number;
    region: string | null;
    zone: V3ZoneId | null;
    district: string | null;
    zonesTotal: number;
    streaming: StreamingStats | null;
    grass: GrassFieldStats | null;
    vegetation: VegetationStats | null;
  } = {
    built: 0,
    populated: 0,
    region: '',
    zone: null,
    district: null,
    zonesTotal: V3_ZONE_IDS.length,
    streaming: null,
    grass: null,
    vegetation: null,
  };

  /** Development QA only (the `?studyQA` hook): draw the room without the world, to measure what the world costs. */
  qaHidden = false;
  private dynamicObstacles: () => readonly { x: number; z: number; r: number }[] = () => [];

  constructor(
    readonly size: number,
    readonly theme: string,
    private quality: QualityTier,
    room: RoomNavigationLike,
    private maxAnisotropy?: number,
  ) {
    this.plan = housePlan(size);
    this.city = cityPlan(this.plan);
    this.walk = new LifeWalk(this.plan, this.city, room, () => this.openDoors(), () => this.dynamicObstacles());
    this.walk.setDoorSurfaceActiveQuery((doorId: string) => {
      const d = this.door(doorId);
      return !!d && (d.phase !== 'closed' || Math.abs(d.angle) > 0.04);
    });
    this.collisionWorld = new PlayerCollisionWorld({
      house: this.plan,
      city: this.city,
      room,
      openDoors: () => this.openDoors(),
      ownedHomes: () => new Set(this.ownedHomes),
    });
    this.doorStateQuery = {
      isDoorOpen: (doorId: string): boolean => {
        const d = this.door(doorId);
        return !!d && (d.isOpen || Math.abs(d.angle) > 0.03);
      },
    };
    this.group.name = 'echo-life';
    this.group.visible = false;
    this.lightGroup.name = 'echo-life-lights';
    this.lightGroup.visible = true;

    // Constant 3-light warm 3200K interior pool in `lightGroup`: ALWAYS `visible = true`
    // (intensity = 0 when unused or world hidden) so `NUM_POINT_LIGHTS` stays invariant!
    for (let i = 0; i < 3; i++) {
      const l = new T.PointLight('#ffe2bc', 0, 12.5, 1.4);
      l.visible = true;
      l.castShadow = false;
      this.lights.push(l);
      this.lightGroup.add(l);
    }
    // Always-visible interior ceiling bounce HemisphereLight in `lightGroup` (intensity = 0 outdoors so
    // outdoor 3.6–4.0:1 sun:fill stays untouched and NUM_HEMI_LIGHTS never mutates!).
    this.interiorBounceHemi.visible = true;
    this.interiorBounceHemi.name = 'echo-life-interior-bounce-hemi';
    this.lightGroup.add(this.interiorBounceHemi);
  }

  get ready() { return this.readyNow; }
  get insideBuildingId(): string | null { return this.activeInsideBuildingId; }
  get insideBuildingRect(): Rect | null { return this.activeInsideBuildingRect; }
  get doorsPassableVersion(): number { return this.doorsPassableRev; }
  /** Increments immediately whenever any house/building interior or exterior sector visibility changes (`0 ms` camera blocker cache refresh). */
  get enclosureVisRevision(): number { return this.enclosureVisRev; }
  /** Smooth `[0..1]` crossfade factor across `door:city:*` thresholds (`0` outdoors, `1` inside enterable city building). */
  get indoorBlend(): number { return this.cityIndoorBlend; }
  /** Smooth `[0..1]` crossfade factor across home exterior/study doorways (`0` outdoors/study, `1` inside enclosed house rooms). */
  get houseIndoorBlend(): number { return this.homeIndoorBlend; }
  get mirrorPlacements(): readonly HouseMirrorPlacement[] { return this.house?.mirrorPlacements ?? []; }
  get houseInteriorGroup(): T.Group | null { return this.house?.interiorGroup ?? null; }
  get showerEmitterSpec(): ShowerEmitterSpec | null { return this.house?.showerEmitterSpec ?? null; }
  get isTvActive(): boolean { return this.house?.isTvActive ?? this.tvActiveDesired; }
  get weatherUniforms() { return this.cityView?.weatherUniforms ?? null; }
  get atmosphere() { return this.cityView?.atmosphere ?? null; }
  get surfaces() { return this.cityView?.surfaces ?? null; }
  get water() { return this.cityView?.water ?? null; }
  get grass() { return this.grassField; }
  get flora() { return this.vegetation; }
  get occlusion() { return this.occlusionCuller; }

  setTvActive(on: boolean) {
    this.tvActiveDesired = on;
    this.house?.setTvActive(on);
  }

  /** Supplies optional additional door-occupant capsules (e.g. full A12 NPC walker set or remote players). */
  setDoorOccupants(fn: () => readonly DoorOccupant[]) {
    this.doorOccupantsProvider = fn;
  }

  /** QA / A12 snapshot of all mounted home & HOT building door state machines. */
  doorStates(): Record<string, DoorRuntimeSnapshot> {
    const out: Record<string, DoorRuntimeSnapshot> = {};
    if (this.house) {
      for (const [id, d] of this.house.doors) out[id] = d.snapshot();
    }
    if (this.streamer) {
      for (const d of this.streamer.doors()) out[d.id] = d.snapshot();
    }
    return out;
  }

  private placedFurniture: SolidBox[] = [];
  setRoomFinishes(finishes: Record<string, { wallColor: string; floorColor: string }>) {
    this.house?.setFinishes(finishes);
  }

  private ownedHomes: readonly string[] = [];
  setOwnedHomes(ownedHomes: readonly string[]) {
    if (ownedHomes.length === this.ownedHomes.length && ownedHomes.every((id) => this.ownedHomes.includes(id))) return;
    this.ownedHomes = [...ownedHomes];
    this.walk.setOwnedHomes(ownedHomes);
    this.collisionWorld.setOwnedHomes(ownedHomes);
    this.streamer?.setResidences(ownedHomes);
  }

  setWorkshop(solids: SolidBox[], ownedHomes: readonly string[]) {
    this.placedFurniture = solids;
    this.walk.furniture = solids;
    this.collisionWorld.setWorkshopFurniture(solids);
    this.setOwnedHomes(ownedHomes);
    this.solidsRev++;
  }

  get solidsVersion() { return this.solidsRev + (this.streamer?.solidsVersion ?? 0); }
  setObstacles(fn: () => readonly { x: number; z: number; r: number }[]) { this.dynamicObstacles = fn; }

  /** Tells the occlusion culler whether the Study Room window is opaque (themed diorama or drawn curtains). */
  setWindowOccluded(occluded: boolean) {
    this.windowOccluded = occluded;
  }

  /** Supplies active drivable vehicle position so nearby park/garden grass bends away from wheels. */
  setVehiclePos(pos: { x: number; y: number; z: number; radius?: number } | null) {
    this.vehiclePos = pos;
  }

  /** Registers an incremental per-building/chunk solid bucket callback for `physics.setWorldSolidBucket(key, boxes)`. */
  setChunkSolidsListener(fn: ((bucketKey: string, solids: readonly SolidBox[]) => void) | undefined) {
    this.chunkSolidsListener = fn;
    this.streamer?.setChunkSolidsListener(fn);
  }

  /** Registers non-blocking off-stage shader prewarm (`safeCompileAsync`) for streamed chunks & lazy interiors. */
  setPrewarmObject(fn: ((obj: T.Object3D, priority?: StreamPrewarmPriority) => Promise<void> | void) | undefined) {
    this.prewarmObject = fn;
    this.streamer?.setPrewarmObject(fn);
    setBuildingInteriorPrewarmHook(fn ? (obj) => fn(obj, 'imminent') : undefined);
  }

  private is4GbGpu = false;

  /** Live 4-tier quality switching forwarded across CityView, Water, House, Streamer, GrassField & VegetationSystem. */
  setQuality(tier: QualityTier, maxAnisotropy?: number, is4GbGpu?: boolean) {
    this.quality = tier;
    if (maxAnisotropy !== undefined) this.maxAnisotropy = maxAnisotropy;
    const resMgr = getEchoLifeResidencyManager();
    if (typeof is4GbGpu === 'boolean') {
      this.is4GbGpu = is4GbGpu;
    } else if (resMgr.tierProfile === 'high_4g' || isGltf4GbGpuMode()) {
      this.is4GbGpu = true;
    }
    resMgr.setQualityTier(tier, this.is4GbGpu);
    this.occlusionCuller?.rebuild(this.plan, this.city, { filterHalfLots: tier === 'low' });
    this.cityView?.setQuality(tier);
    this.cityView?.water.setQuality(tier);
    this.house?.setQuality?.(tier);
    this.streamer?.setQuality(tier);
    this.grassField?.setQuality(tier);
    this.grassField?.group.updateMatrixWorld(true);
    this.vegetation?.setQuality(tier, this.maxAnisotropy);
    this.stats.grass = this.grassField?.stats ?? null;
    this.stats.vegetation = this.vegetation?.stats() ?? null;
  }

  /** Builds the base city, house, grass field, vegetation & streamer at once, then streams chunks asynchronously. */
  build(initialBody?: { x: number; z: number } | null): Promise<void> {
    if (this.building) return this.building;
    this.building = (async () => {
      const t0 = performance.now();
      await loadGatewayAssets();
      if (this.disposed) return;

      // 0. Unified analytical outdoor Hi-Z occluders + indoor window/door portal frustum culler (all tiers).
      this.occlusionCuller = new EchoLifeOcclusionPortalCuller(this.plan, this.city, {
        filterHalfLots: this.quality === 'low',
      });

      // 1. Base city first so `WorldSurfaceLibrary` & `SharedWeatherUniforms` are shared across the whole world.
      this.cityView = buildCity(this.city, this.plan, this.quality);
      this.group.add(this.cityView.group);
      freezeStaticHierarchy(this.cityView.group, { isDynamic: isDynamicCityNode(this.cityView) });

      // 2. Starter 10-zone house sharing PBR surface & weather uniform instances.
      this.house = buildHouse(this.plan, this.theme, {
        surfaces: this.cityView.surfaces,
        tier: this.quality,
        weather: this.cityView.weatherUniforms,
      });
      if (this.tvActiveDesired) this.house.setTvActive(true);
      this.group.add(this.house.group);
      freezeStaticHierarchy(this.house.group, { isDynamic: isDynamicHouseNode });

      // 3. Spatial streamer (enterable buildings, BatchedMesh lots & streetscape props, off-stage shader prewarm).
      this.streamer = new CityStreamer(this.city, this.plan, this.quality, {
        surfaces: this.cityView.surfaces,
        weather: this.cityView.weatherUniforms,
        onChunkSolidsChanged: this.chunkSolidsListener,
        prewarmObject: this.prewarmObject,
      });
      this.streamer.setResidences(this.ownedHomes);
      this.group.add(this.streamer.group);

      // 4. AAA GPU-Instanced Ecological Grass & Clover/Wildflower Ground-Cover Engine.
      this.grassField = createGrassField(this.city, this.plan, this.quality);
      this.group.add(this.grassField.group);
      this.grassField.group.updateMatrixWorld(true);
      this.stats.grass = this.grassField.stats;

      // 5. AAA 22-Species Botanical Vegetation System (LOD0/LOD1/Impostor trees, shrubs, flowers, ferns, rocks).
      this.vegetation = new VegetationSystem({
        city: this.city,
        house: this.plan,
        quality: this.quality,
        weatherUniforms: this.cityView.weatherUniforms,
        maxAnisotropy: this.maxAnisotropy,
      });
      this.group.add(this.vegetation.group);
      this.stats.vegetation = this.vegetation.stats();

      // Sync deterministic tree trunk & boulder colliders into the height-banded `PlayerCollisionWorld`.
      const vegLayout = buildVegetationLayout(this.city, this.plan);
      const vegObstacles = createVegetationObstacles(vegLayout.placements, VEGETATION_BY_ID);
      this.collisionWorld.setExtraObstacles([], vegObstacles);

      this.solidsRev++;
      this.readyNow = true;
      this.stats.built = Math.round(performance.now() - t0);

      const t1 = performance.now();
      const [houseAdded] = await Promise.all([
        this.house.furnish(),
        this.streamer.bootstrap(initialBody ?? { x: 0, z: 0 }),
      ]);
      if (!this.disposed) {
        if (houseAdded) {
          stripTransmissionFromHierarchy(this.house.group);
          freezeStaticHierarchy(this.house.group, { isDynamic: isDynamicHouseNode });
          this.solidsRev++;
        }
        this.syncDoorsPassableVersion();
        this.stats.populated = Math.round(performance.now() - t1);
        this.stats.streaming = this.streamer.stats();
        this.lastStreamerStatsRev = this.streamer.statsVersion;
        this.stats.vegetation = this.vegetation.stats();
      }
    })();
    return this.building;
  }

  door(id: string): LifeDoor | null {
    return this.house?.doors.get(id as DoorId) ?? this.streamer?.door(id) ?? null;
  }

  doors(): LifeDoor[] {
    const out: LifeDoor[] = [];
    if (this.house) for (const d of this.house.doors.values()) out.push(d);
    if (this.streamer) out.push(...this.streamer.doors());
    return out;
  }

  openDoors(): ReadonlySet<DoorId> {
    const open = new Set<DoorId>();
    if (this.house) for (const [id, d] of this.house.doors) if (d.passable) open.add(id);
    if (this.streamer) for (const d of this.streamer.doors()) if (d.passable) open.add(d.id);
    return open;
  }

  private syncDoorsPassableVersion() {
    let changed = false;
    let count = 0;

    if (this.house) {
      for (const [id, d] of this.house.doors) {
        count++;
        const p = d.passable;
        if (this.lastDoorPassableMap.get(id) !== p) {
          this.lastDoorPassableMap.set(id, p);
          changed = true;
        }
      }
    }
    if (this.streamer) {
      const sDoors = this.streamer.doors();
      for (let i = 0; i < sDoors.length; i++) {
        const d = sDoors[i];
        count++;
        const p = d.passable;
        if (this.lastDoorPassableMap.get(d.id) !== p) {
          this.lastDoorPassableMap.set(d.id, p);
          changed = true;
        }
      }
    }
    if (count !== this.lastDoorPassableMap.size) {
      this.lastDoorPassableMap.clear();
      if (this.house) for (const [id, d] of this.house.doors) this.lastDoorPassableMap.set(id, d.passable);
      if (this.streamer) for (const d of this.streamer.doors()) this.lastDoorPassableMap.set(d.id, d.passable);
      changed = true;
    }
    if (changed) this.doorsPassableRev++;
  }

  private baseGroundSolids(): SolidBox[] {
    const b = this.city.bounds;
    const outdoor: SolidBox = {
      hx: (b.x1 - b.x0) / 2,
      hy: 0.2,
      hz: (b.z1 - b.z0) / 2,
      x: (b.x0 + b.x1) / 2,
      y: GROUND_Y - ROAD_DROP - 0.2,
      z: (b.z0 + b.z1) / 2,
    };
    const raised = this.city.ground
      .filter((g) => g.y > GROUND_Y - ROAD_DROP)
      .map(({ rect, y }) => ({
        x: (rect.x0 + rect.x1) / 2,
        z: (rect.z0 + rect.z1) / 2,
        y: y - ROAD_DROP / 2,
        hx: (rect.x1 - rect.x0) / 2,
        hz: (rect.z1 - rect.z0) / 2,
        hy: ROAD_DROP / 2,
      }));
    return [outdoor, ...raised];
  }

  solids(): SolidBox[] {
    if (!this.house) return [];
    return [
      ...this.house.solids,
      ...this.baseGroundSolids(),
      ...this.placedFurniture,
      ...(this.streamer?.solids() ?? []),
    ];
  }

  /** Named solid buckets (`house`, `ground`, `furniture`, `chunk:<id>`) for incremental `physics.setWorldSolidBucket()`. */
  solidBuckets(): Map<string, SolidBox[]> {
    const out = new Map<string, SolidBox[]>();
    if (!this.house) return out;
    out.set('house', this.house.solids);
    out.set('ground', this.baseGroundSolids());
    out.set('furniture', this.placedFurniture);
    if (this.streamer) {
      for (const [key, boxes] of this.streamer.solidBuckets()) out.set(key, boxes);
    }
    return out;
  }

  /** The house, currently visible HOT enterable buildings, and visible ground surfaces (raycast targets & placement). */
  houseRoots(): T.Object3D[] {
    const roots: T.Object3D[] = [];
    if (this.house && this.house.group.visible) roots.push(this.house.group);
    if (this.streamer && this.streamer.group.visible) roots.push(...this.streamer.roots());
    if (this.cityView && this.cityView.group.visible) {
      for (const c of this.cityView.group.children) {
        if (c.visible && c.name === 'city-ground') roots.push(c);
      }
      for (const s of [this.cityView.sectors.north, this.cityView.sectors.south, this.cityView.sectors.sides]) {
        if (!s.visible) continue;
        for (const c of s.children) if (c.name === 'city-ground') roots.push(c);
      }
    }
    return roots;
  }

  blockers(): T.Object3D[] {
    return [...(this.house?.blockers ?? []), ...(this.streamer?.blockers() ?? [])];
  }

  /** The body is inside the study square (its room, its furniture, its own rules). */
  inStudy(p: { x: number; z: number }) {
    return Math.abs(p.x) <= this.plan.h && Math.abs(p.z) <= this.plan.h;
  }

  lampsNear(body: { x: number; z: number }, max = 4): T.Vector3[] {
    return this.streamer?.lampsNear(body, max) ?? [];
  }

  pruneBudget(limit: number) {
    if (getInFlightCompileCount() > 0) return;
    getEchoLifeResidencyManager().evictIfNeeded();
    this.streamer?.pruneBudget(limit);
  }

  private findInsideBuilding(body: T.Vector3 | null, region: string | null): EnterableBuilding | null {
    if (!body || !region || OUTDOOR_REGIONS.has(region) || UPPER_CLOSED_REGIONS.has(region) || LOWER_CLOSED_REGIONS.has(region)) {
      return null;
    }
    if (region.startsWith('door:')) return null;
    const p = { x: body.x, z: body.z };
    for (let i = 0; i < this.city.buildings.length; i++) {
      const b = this.city.buildings[i];
      if ((b.property?.id ?? b.id) === region && inRect(p, b.rect, -0.05)) return b;
    }
    for (let i = 0; i < this.city.residences.length; i++) {
      const b = this.city.residences[i];
      if ((b.property?.id ?? b.id) === region && inRect(p, b.rect, -0.05)) return b;
    }
    return null;
  }

  private pushDoorOccupants(body: T.Vector3 | null) {
    const occs = this.doorOccupantsScratch;
    occs.length = 0;
    if (body) {
      occs.push({
        x: body.x,
        y: body.y,
        z: body.z,
        radius: this.collisionWorld.getRadii().high,
        id: 'player',
      });
    }
    const dyn = this.dynamicObstacles();
    for (let i = 0; i < dyn.length; i++) {
      const o = dyn[i] as { x: number; y?: number; z: number; r: number; id?: string };
      occs.push({
        x: o.x,
        y: o.y !== undefined && Number.isFinite(o.y) ? o.y : (this.walk.groundAt(o.x, o.z) ?? (body?.y ?? 0)),
        z: o.z,
        radius: Math.max(0.20, o.r),
        id: o.id ?? 'npc',
      });
    }
    const extra = this.doorOccupantsProvider();
    for (let i = 0; i < extra.length; i++) {
      occs.push(extra[i]);
    }
    if (this.house) {
      for (const d of this.house.doors.values()) d.updateOccupancy(occs);
    }
    if (this.streamer) {
      const sDoors = this.streamer.doors();
      for (let i = 0; i < sDoors.length; i++) sDoors[i].updateOccupancy(occs);
    }
  }

  private syncDoorLeafColliders() {
    const keep = this.activeDoorIdsScratch;
    keep.clear();
    const pushDoor = (d: LifeDoor) => {
      keep.add(d.id);
      const hg = d.hinge();
      const baseYaw = Math.atan2(hg.leaf.z, hg.leaf.x);
      this.collisionWorld.setDoorLeafState({
        id: d.id,
        hingeX: hg.at.x,
        hingeZ: hg.at.z,
        width: d.plan.width,
        worldLeafYaw: baseYaw - d.angle,
        swingAngle: d.angle,
        isOpen: d.isOpen,
        phase: d.phase,
        floorY: d.plan.y,
      });
    };
    if (this.house) {
      for (const d of this.house.doors.values()) pushDoor(d);
    }
    if (this.streamer) {
      const sDoors = this.streamer.doors();
      for (let i = 0; i < sDoors.length; i++) pushDoor(sDoors[i]);
    }
    this.collisionWorld.pruneDoorLeafStates(keep);
  }

  private findBuildingByDoorId(doorId: string): EnterableBuilding | null {
    for (let i = 0; i < this.city.buildings.length; i++) {
      if (this.city.buildings[i].door.id === doorId) return this.city.buildings[i];
    }
    for (let i = 0; i < this.city.residences.length; i++) {
      if (this.city.residences[i].door.id === doorId) return this.city.residences[i];
    }
    return null;
  }

  private resolveRootScene(): T.Scene | null {
    if (this.cachedRootScene) return this.cachedRootScene;
    let node: T.Object3D | null = this.group.parent;
    while (node && !(node instanceof T.Scene)) node = node.parent;
    if (node instanceof T.Scene) {
      this.cachedRootScene = node;
      for (let i = 0; i < node.children.length; i++) {
        const ch = node.children[i];
        if (ch instanceof T.HemisphereLight && ch !== this.interiorBounceHemi) {
          this.cachedPrimaryHemi = ch;
          break;
        }
      }
    }
    return this.cachedRootScene;
  }

  update(
    dt: number,
    active: boolean,
    body: T.Vector3 | null,
    camera: T.Camera,
    reduced: boolean,
    day: number,
    rain: number,
    angle?: number,
    season = 0,
    cloud = rain,
    snow = 0,
  ) {
    this.group.visible = active && this.readyNow && !this.qaHidden;
    // Keep `lightGroup` ALWAYS `visible = true` so `NUM_POINT_LIGHTS` / `NUM_HEMI_LIGHTS` never mutate!
    this.lightGroup.visible = true;
    if (!this.group.visible) {
      for (let i = 0; i < this.lights.length; i++) {
        this.lights[i].visible = true;
        this.lights[i].intensity = 0;
      }
      this.interiorBounceHemi.visible = true;
      this.interiorBounceHemi.intensity = 0;
      return;
    }

    const safeDt = Math.max(0, Math.min(dt, 0.1));
    if (!reduced) this.timeSec = (this.timeSec + safeDt) % 86400;

    // Keep frozen static subtrees & grass tiles 100% synced whenever `stage.scale` or `stage.position` changes.
    const parent = this.group.parent;
    let isStageIdentity = true;
    if (parent) {
      const sx = parent.scale.x;
      const px = parent.position.x;
      const pz = parent.position.z;
      if (sx !== this.lastStageScale || px !== this.lastStageX || pz !== this.lastStageZ) {
        this.lastStageScale = sx;
        this.lastStageX = px;
        this.lastStageZ = pz;
        parent.updateMatrixWorld(true);
      }
      isStageIdentity = Math.abs(sx - 1) < 1e-4 && Math.abs(px) < 1e-4 && Math.abs(pz) < 1e-4;
    }

    const night = Math.max(0, Math.min(1, 1 - day * 1.4));
    camera.getWorldPosition(V3_A);

    this.pushDoorOccupants(body);

    if (body) this.house?.update(dt, reduced, body);
    this.house?.setNight(night);
    this.house?.setCameraPos?.(V3_A);

    this.streamer?.update(dt, body, reduced);
    this.streamer?.setAtmosphere(season, night);
    this.streamer?.setCameraPos(V3_A);

    this.syncDoorLeafColliders();
    const prevDoorsRev = this.doorsPassableRev;
    this.syncDoorsPassableVersion();

    const place = body ? this.walk.surface(body) : null;
    const region = place?.region ?? null;
    const zone = place?.zone ?? null;
    this.region = region;
    this.zone = zone;
    this.stats.region = region;
    this.stats.zone = zone;
    this.stats.district = zone ? V3_ZONE_META[zone].district : null;

    if (this.streamer && this.streamer.statsVersion !== this.lastStreamerStatsRev) {
      this.stats.streaming = this.streamer.stats();
      this.lastStreamerStatsRev = this.streamer.statsVersion;
    }

    // ── Indoor Enclosure & Portal Frustum Occlusion Culling (All Tiers) ─────────────────────────────
    const insideBuilding = this.findInsideBuilding(body, region);
    this.activeInsideBuildingId = insideBuilding ? (insideBuilding.property?.id ?? insideBuilding.id) : null;
    this.activeInsideBuildingRect = insideBuilding ? insideBuilding.rect : null;

    const hallDoor = this.house?.doors.get('hall');
    const hallOpen = !!hallDoor && (hallDoor.isOpen || Math.abs(hallDoor.angle) > 0.03);
    const opaqueStudyLock = region === 'study' && this.windowOccluded && !hallOpen;

    // Resolve active enclosure id for `EchoLifeOcclusionPortalCuller` (city building, residence, or Starter House room).
    const houseEnclosureId =
      !insideBuilding &&
      region &&
      !region.startsWith('door:') &&
      region !== 'arch' &&
      (UPPER_CLOSED_REGIONS.has(region) || LOWER_CLOSED_REGIONS.has(region))
        ? `house:${region}`
        : null;
    const activeEnclosureId = insideBuilding ? this.activeInsideBuildingId : houseEnclosureId;

    let portalModeActive = false;
    let portalHideAllExterior = false;
    let portalKeepSky = true;
    if (this.occlusionCuller && isStageIdentity) {
      if (angle !== undefined) {
        V3_B.set(Math.cos(angle), Math.max(0.06, Math.sin(angle)), -0.35).normalize();
      } else {
        V3_B.set(0.35, 0.72, -0.60).normalize();
      }
      const cullMode = this.occlusionCuller.beginFrame({
        camera,
        enclosureId: activeEnclosureId,
        sunDirTowardSun: V3_B,
        doors: this.doorStateQuery,
        studyWindowOccluded: this.windowOccluded,
        shadowsEnabled: getRenderConfig(this.quality).shadow.enabled,
      });
      portalModeActive = cullMode === 'indoor';
      portalHideAllExterior = this.occlusionCuller.hideAllExterior;
      portalKeepSky = this.occlusionCuller.keepSkyAndHorizon;
    }

    const bnds = this.city.bounds;
    const fp = this.plan.footprint;
    const yMin = GROUND_Y - 2;
    const yMax = GROUND_Y + 28;
    const testPortalSectors = (): { north: boolean; south: boolean; sides: boolean; house: boolean } => {
      const culler = this.occlusionCuller;
      if (!culler || !portalModeActive) {
        return { north: true, south: true, sides: true, house: true };
      }
      if (portalHideAllExterior) {
        return { north: false, south: false, sides: false, house: false };
      }
      const north = culler.indoor.isAabbVisible(bnds.x0 - 20, yMin, bnds.z0 - 40, bnds.x1 + 20, yMax, fp.z0 + 4);
      const south = culler.indoor.isAabbVisible(bnds.x0 - 20, yMin, this.plan.front - 2, bnds.x1 + 20, yMax, bnds.z1 + 20);
      const westSide = culler.indoor.isAabbVisible(bnds.x0 - 20, yMin, fp.z0 - 2, fp.x0 + 4, yMax, bnds.z1 + 20);
      const eastSide = culler.indoor.isAabbVisible(fp.x1 - 4, yMin, fp.z0 - 2, bnds.x1 + 20, yMax, bnds.z1 + 20);
      const houseVis = culler.indoor.isAabbVisible(fp.x0 - 2, GROUND_Y - 1, fp.z0 - 2, fp.x1 + 2, 4.5, this.plan.front + 2);
      return { north, south, sides: westSide || eastSide, house: houseVis };
    };

    let cityVisible = true;
    let northVis = true;
    let southVis = true;
    let sidesVis = true;
    let grassVisible = true;

    if (opaqueStudyLock || (portalModeActive && portalHideAllExterior && !insideBuilding)) {
      // Closed Study Room (opaque window/curtains) or facing a solid Starter House interior wall with 0 visible portals:
      // 0 exterior draw calls across ALL tiers while keeping Starter House shell visible!
      cityVisible = false;
      northVis = false;
      southVis = false;
      sidesVis = false;
      grassVisible = false;
      if (this.cityView) this.cityView.group.visible = false;
      if (this.streamer) {
        this.streamer.setEnclosure(null, null);
        this.streamer.group.visible = false;
      }
      if (this.house) this.house.group.visible = true;
      if (this.vegetation) this.vegetation.group.visible = false;
      this.grassField?.setVisible(false);
    } else if (insideBuilding) {
      const lowTier = this.quality === 'low';
      const bCenter = {
        x: (insideBuilding.rect.x0 + insideBuilding.rect.x1) * 0.5,
        z: (insideBuilding.rect.z0 + insideBuilding.rect.z1) * 0.5,
      };
      const portalVis = testPortalSectors();

      if (portalModeActive && portalHideAllExterior && !portalKeepSky) {
        // Facing solid interior wall inside a city building (0 visible windows/doors):
        // hide 100% of exterior cityView/vegetation/grass/house while keeping ONLY the active building shell visible!
        cityVisible = false;
        northVis = false;
        southVis = false;
        sidesVis = false;
        grassVisible = false;
        if (this.cityView) this.cityView.group.visible = false;
        if (this.streamer) {
          this.streamer.group.visible = true;
          this.streamer.setSectors(false, false, false);
          this.streamer.setEnclosure(this.activeInsideBuildingId, insideBuilding.chunkId, bCenter);
        }
        if (this.house) this.house.group.visible = false;
        if (this.vegetation) this.vegetation.group.visible = false;
        this.grassField?.setVisible(false);
      } else {
        // Portal-visible indoor view: preserve `cityView.group` (skyMesh + horizon skirt => 0 G-04 sky-void!)
        // and cull exterior sectors, vegetation & grass strictly to window-visible sub-frusta across ALL tiers!
        const facesNorth = insideBuilding.facing === 'north';
        const hasSideWindows =
          insideBuilding.id === 'library' ||
          insideBuilding.id === 'cafe' ||
          insideBuilding.id === 'bistro' ||
          insideBuilding.id === 'atelier' ||
          insideBuilding.storeys >= 2;
        northVis = portalVis.north;
        southVis = !lowTier && portalVis.south;
        sidesVis = (!lowTier || insideBuilding.id === 'library') && portalVis.sides;
        const anySectorVis = northVis || southVis || sidesVis;
        grassVisible =
          !lowTier &&
          anySectorVis &&
          (northVis || sidesVis) &&
          (facesNorth || hasSideWindows || insideBuilding.rect.z0 < this.plan.footprint.z0 + 22);

        if (this.cityView) {
          this.cityView.group.visible = portalKeepSky || anySectorVis;
          this.cityView.sectors.north.visible = northVis;
          this.cityView.sectors.south.visible = southVis;
          this.cityView.sectors.sides.visible = sidesVis;
        }
        if (this.streamer) {
          this.streamer.group.visible = true;
          this.streamer.setSectors(northVis, southVis, sidesVis);
          this.streamer.setEnclosure(this.activeInsideBuildingId, insideBuilding.chunkId, bCenter);
        }
        if (this.house) {
          this.house.group.visible = !lowTier && portalVis.house && (!body || Math.hypot(body.x, body.z) <= 34);
        }
        if (this.vegetation) {
          this.vegetation.group.visible = !lowTier && anySectorVis;
          if (!lowTier && anySectorVis) this.vegetation.setSectorVisibility(northVis, southVis, sidesVis);
        }
        this.grassField?.setVisible(grassVisible);
      }
    } else {
      // Outdoors or inside the starter home with >= 1 visible window/door portal.
      const study = region === 'study' || region === 'door:hall';
      const upper = !!region && UPPER_CLOSED_REGIONS.has(region);
      const lower = !!region && LOWER_CLOSED_REGIONS.has(region);
      const portalVis = testPortalSectors();
      northVis = !lower && portalVis.north;
      southVis = !upper && portalVis.south;
      sidesVis = !study && portalVis.sides;
      const anySectorVis = northVis || southVis || sidesVis;
      grassVisible = northVis || sidesVis;

      if (this.cityView) {
        this.cityView.group.visible = portalKeepSky || anySectorVis;
        this.cityView.sectors.north.visible = northVis;
        this.cityView.sectors.south.visible = southVis;
        this.cityView.sectors.sides.visible = sidesVis;
      }
      if (this.streamer) {
        this.streamer.group.visible = anySectorVis || !portalModeActive;
        this.streamer.setEnclosure(null, null);
        this.streamer.setSectors(northVis, southVis, sidesVis);
      }
      if (this.house) this.house.group.visible = true;
      if (this.vegetation) {
        this.vegetation.group.visible = anySectorVis;
        if (anySectorVis) this.vegetation.setSectorVisibility(northVis, southVis, sidesVis);
      }
      this.grassField?.setVisible(grassVisible);
    }

    // Track immediate enclosure/visibility transitions (`0 ms` camera blocker refresh in `exploration.ts`).
    const houseInteriorVis = Boolean(this.house?.isInteriorVisible());
    const streamerVisRev = this.streamer?.visibilityVersion ?? -1;
    if (
      houseInteriorVis !== this.lastHouseInteriorVis ||
      this.activeInsideBuildingId !== this.lastInsideBuildingKey ||
      cityVisible !== this.lastCityVis ||
      northVis !== this.lastNorthVis ||
      southVis !== this.lastSouthVis ||
      sidesVis !== this.lastSidesVis ||
      streamerVisRev !== this.lastStreamerVisRev ||
      this.doorsPassableRev !== prevDoorsRev
    ) {
      this.lastHouseInteriorVis = houseInteriorVis;
      this.lastInsideBuildingKey = this.activeInsideBuildingId;
      this.lastCityVis = cityVisible;
      this.lastNorthVis = northVis;
      this.lastSouthVis = southVis;
      this.lastSidesVis = sidesVis;
      this.lastStreamerVisRev = streamerVisRev;
      this.enclosureVisRev++;
    }

    // Continuous C0 doorway corridor indoorBlend (`0` outdoors -> `1` indoors across `[-0.45 m, +0.45 m]`).
    let cityIndoorTarget = insideBuilding ? 1 : 0;
    const cityThresholdBld =
      insideBuilding ??
      (region && region.startsWith('door:') ? this.findBuildingByDoorId(region.slice(5)) : null);
    if (body && cityThresholdBld && Math.abs(body.y - cityThresholdBld.door.y) < 1.35) {
      const cd = cityThresholdBld.door;
      const lat = cd.wallAlong === 'x' ? Math.abs(body.x - cd.x) : Math.abs(body.z - cd.z);
      if (lat <= cd.width * 0.68) {
        const indoorPlus =
          cd.wallAlong === 'x'
            ? Math.abs(cd.z - cityThresholdBld.rect.z0) <= Math.abs(cd.z - cityThresholdBld.rect.z1)
            : Math.abs(cd.x - cityThresholdBld.rect.x0) <= Math.abs(cd.x - cityThresholdBld.rect.x1);
        const raw = cd.wallAlong === 'x' ? body.z - cd.z : body.x - cd.x;
        const signedIn = indoorPlus ? raw : -raw;
        if (signedIn < 0.45) {
          cityIndoorTarget = Math.max(0, Math.min(1, (signedIn + 0.45) / 0.90));
        }
      }
    }

    const inEnclosedHomeRoom =
      !!region &&
      region !== 'study' &&
      region !== 'door:hall' &&
      (UPPER_CLOSED_REGIONS.has(region) || LOWER_CLOSED_REGIONS.has(region));
    let homeIndoorTarget = inEnclosedHomeRoom ? 1 : 0;
    if (body) {
      const homeBoundaryDoors: readonly [DoorId, boolean][] = [
        ['hall', true],
        ['balcony', false],
        ['entrance', false],
        ['garage_out', false],
      ];
      for (let i = 0; i < homeBoundaryDoors.length; i++) {
        const [hdId, indoorPlus] = homeBoundaryDoors[i];
        const hd = this.plan.doors.find((d) => d.id === hdId);
        if (!hd || Math.abs(body.y - hd.y) >= 1.35) continue;
        const lat = hd.wallAlong === 'x' ? Math.abs(body.x - hd.x) : Math.abs(body.z - hd.z);
        if (lat > hd.width * 0.68) continue;
        const raw = hd.wallAlong === 'x' ? body.z - hd.z : body.x - hd.x;
        const signedIn = indoorPlus ? raw : -raw;
        if (Math.abs(signedIn) < 0.45) {
          const ramp = Math.max(0, Math.min(1, (signedIn + 0.45) / 0.90));
          homeIndoorTarget = inEnclosedHomeRoom ? Math.min(homeIndoorTarget, ramp) : Math.max(homeIndoorTarget, ramp);
        }
      }
    }

    const indoorAlpha = reduced ? 1 : 1 - Math.exp(-12 * safeDt);
    this.cityIndoorBlend += (cityIndoorTarget - this.cityIndoorBlend) * indoorAlpha;
    if (cityIndoorTarget === 0 && this.cityIndoorBlend < 0.001) this.cityIndoorBlend = 0;
    else if (cityIndoorTarget === 1 && this.cityIndoorBlend > 0.999) this.cityIndoorBlend = 1;

    this.homeIndoorBlend += (homeIndoorTarget - this.homeIndoorBlend) * indoorAlpha;
    if (homeIndoorTarget === 0 && this.homeIndoorBlend < 0.001) this.homeIndoorBlend = 0;
    else if (homeIndoorTarget === 1 && this.homeIndoorBlend > 0.999) this.homeIndoorBlend = 1;

    // ── City Atmosphere, Water, Weather, GrassField & VegetationSystem Updates ────────────────────────
    if (this.cityView && cityVisible) {
      if (body && night > 0.12) {
        const lampPool = getRenderConfig(this.quality).atmosphere.streetlampPool;
        this.cityView.setLampPositions(this.lampsNear(body, lampPool));
      } else {
        this.cityView.setLampPositions([]);
      }
      const isOutdoors = !!region && region !== 'study' && OUTDOOR_REGIONS.has(region);
      this.cityView.water.setInsideBuilding(Boolean(insideBuilding || opaqueStudyLock || !isOutdoors));
      this.cityView.setDay(day, rain, angle, season, cloud, isOutdoors, snow);
      this.cityView.update(dt, reduced, camera);
    }

    const wu = this.cityView?.weatherUniforms;
    const windVec = wu ? wu.uWindVec.value : null;
    const windStrength = windVec ? Math.hypot(windVec.x, windVec.y) : 0.45 + Math.max(rain, snow * 0.75) * 1.1;
    const wetness = wu ? wu.uWetness.value : undefined;
    const snowCover = wu ? wu.uSnowCover.value : snow;

    if (this.grassField && grassVisible) {
      if (angle !== undefined) {
        V3_B.set(Math.cos(angle), Math.max(0.06, Math.sin(angle)), -0.35).normalize();
      } else {
        V3_B.set(0.35, 0.72, -0.60).normalize();
      }
      this.grassField.update({
        dt,
        reduced,
        actorPos: body,
        cameraPos: V3_A,
        vehiclePos: this.vehiclePos,
        sunDir: V3_B,
        day,
        season,
        rain,
        snow,
        wetness,
        snowCover,
        windVec,
      });
    }

    if (this.vegetation && this.vegetation.group.visible) {
      this.vegetation.update(
        dt,
        body?.x ?? 0,
        body?.z ?? 0,
        Math.max(0, Math.min(3, season | 0)),
        snowCover,
        windStrength,
        this.timeSec,
      );
    }

    // ── Constant 3-Light Interior Pool (Zero-Allocation Top-3 Fixture Selection) ────────────────────
    const inside = !!region && !OUTDOOR_REGIONS.has(region);
    TOP_FIXTURES[0] = null;
    TOP_FIXTURES[1] = null;
    TOP_FIXTURES[2] = null;
    let d0 = Infinity;
    let d1 = Infinity;
    let d2 = Infinity;

    if (inside && body) {
      const consider = (list: readonly FixtureEntry[] | undefined) => {
        if (!list) return;
        for (let i = 0; i < list.length; i++) {
          const f = list[i];
          const d = f.at.distanceToSquared(body);
          if (d < d0) {
            d2 = d1; TOP_FIXTURES[2] = TOP_FIXTURES[1];
            d1 = d0; TOP_FIXTURES[1] = TOP_FIXTURES[0];
            d0 = d; TOP_FIXTURES[0] = f;
          } else if (d < d1) {
            d2 = d1; TOP_FIXTURES[2] = TOP_FIXTURES[1];
            d1 = d; TOP_FIXTURES[1] = f;
          } else if (d < d2) {
            d2 = d; TOP_FIXTURES[2] = f;
          }
        }
      };
      if (this.house?.group.visible) consider(this.house.fixtures);
      consider(this.streamer?.fixtures());
    }

    const blend = reduced ? 1 : 1 - Math.exp(-6 * dt);
    const inCityInterior = this.activeInsideBuildingId !== null;
    const isLibrary = this.activeInsideBuildingId === 'library';
    const lowIndoors = this.quality === 'low' && (inCityInterior || inside);

    // Keep `scene.fog` continuously a `FogExp2` (`density = 0` indoors instead of `scene.fog = null`)
    // so `USE_FOG` shader permutations stay constant across outdoor/indoor transitions.
    const rootScene = this.resolveRootScene();
    if (rootScene && rootScene.fog === null) {
      this.zeroFog.density = 0;
      rootScene.fog = this.zeroFog;
    }

    // Warm ceiling bounce HemisphereLight:
    // - University Library (`06`): lifts total warm ceiling bounce to `0.95` (`#f6ebd6`) so the double-height
    //   reading hall & walnut ceiling trusses read brightly and welcomingly.
    // - Low tier indoors: uses 1 central PointLight + boosted HemisphereLight (`0.88`) for high iGPU FPS.
    // - Outdoors: `intensity = 0` (zero washout of outdoor 3.6:1–4.0:1 directional key contrast!).
    const baseHemiInt = this.cachedPrimaryHemi ? this.cachedPrimaryHemi.intensity : 0.56;
    const targetHemiTotal = isLibrary ? 0.95 : lowIndoors && inCityInterior ? 0.88 : 0;
    const targetBounce = targetHemiTotal > 0 ? Math.max(0, targetHemiTotal - baseHemiInt) : 0;
    this.interiorBounceHemi.visible = true;
    this.interiorBounceHemi.color.set('#f6ebd6');
    this.interiorBounceHemi.groundColor.set(isLibrary ? '#847462' : '#7a6c5d');
    this.interiorBounceHemi.intensity += (targetBounce - this.interiorBounceHemi.intensity) * blend;
    if (targetBounce === 0 && this.interiorBounceHemi.intensity < 0.002) {
      this.interiorBounceHemi.intensity = 0;
    }

    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      // Always keep all 3 PointLight slots `visible = true` (intensity = 0 when unused -> 0 NUM_POINT_LIGHTS recompiles!).
      l.visible = true;
      const allowSlot = !lowIndoors || i === 0;
      const f = allowSlot ? TOP_FIXTURES[i] : null;
      const desiredDist = isLibrary ? 16 : 12.5;
      const desiredDecay = isLibrary ? 1.25 : 1.4;
      if (l.distance !== desiredDist) l.distance = desiredDist;
      if (l.decay !== desiredDecay) l.decay = desiredDecay;

      // University Library (`06`): raised range (16 m) & warm intensity (2.2) across the 5.6 m double-height hall;
      // other interiors stay capped <= 1.8 (warm 3200K, elevated mount) to avoid hair bloom orbs (G-08).
      const cap = isLibrary ? 2.2 : lowIndoors ? 1.9 : 1.8;
      const baseIntensity = isLibrary
        ? (i === 0 ? 2.2 : 1.75)
        : inCityInterior
          ? (i === 0 ? (lowIndoors ? 1.9 : 1.65) : 1.25)
          : (i === 0 ? 1.8 : 1.35);
      const dayAtten = isLibrary ? 1 - day * 0.08 : 1 - day * 0.22;
      const target = f ? Math.min(cap, baseIntensity * dayAtten) : 0;
      l.intensity += (target - l.intensity) * blend;
      if (!f && l.intensity < 0.002) l.intensity = 0;
      if (f) {
        const mountY = inCityInterior && f.at.y < GROUND_Y + 2.75 ? GROUND_Y + 2.78 : f.at.y;
        l.position.set(f.at.x, mountY, f.at.z);
        l.color.copy(f.warm ? WARM_FIXTURE_COLOR : CRISP_FIXTURE_COLOR);
      }
    }
    TOP_FIXTURES[0] = null;
    TOP_FIXTURES[1] = null;
    TOP_FIXTURES[2] = null;
  }

  /** Where the body is, in words (for the caption and QA across all 31 V3 zones). */
  regionName(): { vi: string; en: string } | null {
    const r = this.region;
    const residence = this.city.residences.find((home) => home.property?.id === r);
    if (residence) return residence.name;
    if (r === 'stair' || r === 'lobby' || r === 'lobbyFoot') {
      const hz = this.plan.zones.find((z) => z.id === r);
      if (hz) return hz.name;
    }
    if (this.zone) return V3_ZONE_META[this.zone].name;
    if (!r) return null;
    const hz = this.plan.zones.find((z) => z.id === r);
    return hz ? hz.name : null;
  }

  dispose() {
    this.disposed = true;
    setBuildingInteriorPrewarmHook(undefined);
    this.occlusionCuller = null;
    this.grassField?.dispose();
    this.grassField = null;
    this.vegetation?.dispose();
    this.vegetation = null;
    this.streamer?.dispose();
    this.streamer = null;
    this.house?.dispose();
    this.house = null;
    this.cityView?.dispose();
    this.cityView = null;
    this.lastDoorPassableMap.clear();
    this.cachedRootScene = null;
    this.cachedPrimaryHemi = null;
    this.lightGroup.removeFromParent();
    this.group.removeFromParent();
    disposeLifeAssets();
    disposeStreetProps();
  }
}
