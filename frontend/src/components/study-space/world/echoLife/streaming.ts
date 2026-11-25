import * as T from 'three';
import { mat } from '../materials';
import { GROUND_Y, type HousePlan, type Rect } from '@/lib/echo-life/plan';
import { hash01, type CityChunk, type CityPlan, type Lot, type Prop } from '@/lib/echo-life/city';
import type { EnterableBuilding } from '@/lib/echo-life/buildings';
import {
  LIFE_ASSETS,
  acquireLifeAsset,
  buildConsolidatedBatches,
  lifeAssetStats,
  placeOn,
  prefetchLifeAsset,
  pruneLifeAssets,
  releaseLifeAsset,
  setGltfTextureTier,
  stripTransmissionFromHierarchy,
  type ConsolidatedBatchItem,
  type LifeAsset,
  type Prepared,
} from './assets';
import { patchHeightFog } from './atmosphere';
import { getInFlightCompileCount, patchMaterialWithEchoCsm } from './echoCsm';
import { Batch, type LifeDoor, type SolidBox } from './house';
import { buildEnterableBuilding, textBoard, type BuildingBuild } from './buildingsView';
import {
  EchoLifeTimeSlicer,
  LoadPriority,
  getEchoLifeLoadScheduler,
  getEchoLifeTextureUploadQueue,
} from './loadScheduler';
import { getInteriorPrefetchSpec } from './preloadManifest';
import { getRenderConfig, type QualityTier } from './renderConfig';
import { getEchoLifeResidencyManager } from './residencyManager';
import {
  AAA_V2_LEGACY_PROP_MAP,
  STREET_PROPS,
  acquireStreetProp,
  loadStreetProp,
  placeStreetPropOn,
  pruneStreetProps,
  releaseStreetProp,
  type PreparedStreetProp,
  type StreetPropKey,
} from './streetPropsManifest';
import { freezeStaticHierarchy, M4_A, Q_A, V3_A, V3_B, V3_C } from './scratch';
import type { WorldSurfaceLibrary } from './worldSurfaces';
import type { SharedWeatherUniforms } from './weatherSystem';

export type ChunkState = 'cold' | 'warm' | 'hot';

export interface StreamingStats {
  hot: string[];
  warm: string[];
  cold: string[];
  activeDoors: number;
  activeSolids: number;
  transitions: number;
  assetsCached: number;
  assetsReferenced: number;
  evictions: number;
}

export interface StreamingUpdateOptions {
  /** Optional explicit horizontal velocity (m/s) in stage space; derived smoothly from `body` delta when omitted. */
  readonly velocity?: { readonly x: number; readonly z: number } | null;
  /** Optional explicit horizontal camera forward vector in stage space; derived from active camera when omitted. */
  readonly cameraForward?: { readonly x: number; readonly z: number } | null;
  /** Optional active Three.js camera for exact horizontal lookahead extraction. */
  readonly camera?: T.Camera | null;
}

/**
 * Clamps an `(x, z)` spatial query or velocity/camera lookahead coordinate strictly inside valid
 * resident city bounds (with optional inward safety inset) using zero heap allocations.
 */
export function clampToBounds<TOut extends { x: number; z: number }>(
  x: number,
  z: number,
  bounds: Rect,
  out: TOut,
  insetM = 0,
): TOut {
  const minX = Math.min(bounds.x0 + insetM, (bounds.x0 + bounds.x1) * 0.5);
  const maxX = Math.max(bounds.x1 - insetM, (bounds.x0 + bounds.x1) * 0.5);
  const minZ = Math.min(bounds.z0 + insetM, (bounds.z0 + bounds.z1) * 0.5);
  const maxZ = Math.max(bounds.z1 - insetM, (bounds.z0 + bounds.z1) * 0.5);
  const sx = Number.isFinite(x) ? x : (minX + maxX) * 0.5;
  const sz = Number.isFinite(z) ? z : (minZ + maxZ) * 0.5;
  out.x = sx < minX ? minX : sx > maxX ? maxX : sx;
  out.z = sz < minZ ? minZ : sz > maxZ ? maxZ : sz;
  return out;
}

export type StreamPrewarmPriority = 'imminent' | 'background';

export interface CityStreamerOptions {
  surfaces?: WorldSurfaceLibrary;
  weather?: SharedWeatherUniforms;
  /** Fired whenever a chunk or individual building solid bucket updates (`bld:<chunk>:<bld>` or `chunk:<chunk>`). */
  onChunkSolidsChanged?: (bucketKey: string, solids: readonly SolidBox[]) => void;
  /** Optional non-blocking off-stage shader prewarm hook (`renderer.compileAsync`) run before revealing new mounts. */
  prewarmObject?: (obj: T.Object3D, priority?: StreamPrewarmPriority) => Promise<void> | void;
}

const LOT_ASSETS: Record<Lot['use'], LifeAsset[]> = {
  neighbour: ['bld-tube'],
  shophouse: ['bld-shophouse', 'bld-tube'],
  // Retired Playmobil `bld-sub-*` / `bld-tower-*` blocks in favor of architectural coastal/urban facades.
  home: ['bld-courtyard', 'bld-minka', 'bld-tube'],
  cafe: ['bld-shophouse'],
  market: ['bld-dorm'],
  gaming: ['bld-shophouse'],
  tower: ['bld-urban-facade', 'bld-dorm'],
  minka: ['bld-minka'],
  teacourt: ['bld-teacourt'],
  courtyard: ['bld-courtyard'],
};

const LOD_PAIR: Partial<Record<LifeAsset, LifeAsset>> = {
  'bld-shophouse': 'bld-shophouse-lod',
  'bld-tube': 'bld-tube-lod',
  'bld-dorm': 'bld-dorm-lod',
  'bld-minka': 'bld-minka-lod',
  'bld-teacourt': 'bld-teacourt-lod',
  'bld-courtyard': 'bld-courtyard-lod',
  'bld-lanternhouse': 'bld-lanternhouse-lod',
  'bld-urban-facade': 'bld-urban-facade-lod',
};

const FACING: Record<Lot['facing'], number> = { south: 0, north: Math.PI, east: Math.PI / 2, west: -Math.PI / 2 };

/** Maps outdoor props that are replaced by A08's Poly Haven CC0 GLBs (`streetPropsManifest.ts`). */
function streetPropReplacement(pr: Prop): { key: StreetPropKey; scale: number; isLamp: boolean; lampHeight: number } | null {
  if (pr.kind === 'lamp') {
    const targetH = 3.55;
    return { key: 'streetlamp', scale: targetH / STREET_PROPS.streetlamp.naturalHeight, isLamp: true, lampHeight: targetH };
  }
  if (pr.kind === 'asset' && pr.asset === 'street-lantern') {
    const targetH = pr.scaleVal ?? 3.1;
    return { key: 'streetlamp', scale: targetH / STREET_PROPS.streetlamp.naturalHeight, isLamp: true, lampHeight: targetH };
  }
  if (pr.kind === 'bin') {
    return { key: 'trashbin', scale: 1.0, isLamp: false, lampHeight: 0 };
  }
  if (pr.kind === 'hydrant') {
    return { key: 'hydrant', scale: 1.0, isLamp: false, lampHeight: 0 };
  }
  if (pr.kind === 'bench') {
    // Inherit calibrated `yawOffset: 0` + `scaleVec: [1.32, 0.75, 0.95]` from `STREET_PROPS.bench` via `placeStreetPropOn(..., key)`.
    return { key: 'bench', scale: 1.0, isLamp: false, lampHeight: 0 };
  }
  if (pr.kind === 'asset' && pr.asset === 'plant') {
    const targetH = pr.scaleVal ?? STREET_PROPS.pottedPlant.naturalHeight;
    return { key: 'pottedPlant', scale: targetH / STREET_PROPS.pottedPlant.naturalHeight, isLamp: false, lampHeight: 0 };
  }
  // Route legacy empty planters, bare gazebos, cyan bus shelters, and patio sets to AAA-v2 Cycles-baked GLBs.
  const legacyKey = pr.kind === 'asset' ? pr.asset : pr.kind;
  const aaaKey = legacyKey ? AAA_V2_LEGACY_PROP_MAP[legacyKey] : undefined;
  if (aaaKey) {
    const spec = STREET_PROPS[aaaKey];
    let scale = 1.0;
    if (pr.kind === 'asset' && pr.scaleVal && pr.scaleVal > 0) {
      // Use max horizontal footprint span when scaling by `'w'` so non-square sets (e.g. `cafeBistroSet` [0.74, 0.855, 1.716]) never oversize!
      const denom = pr.scaleBy === 'w' ? Math.max(spec.dimensions[0], spec.dimensions[2]) : spec.naturalHeight;
      if (denom > 0.05) scale = Math.max(0.55, Math.min(1.6, pr.scaleVal / denom));
    }
    return { key: aaaKey, scale, isLamp: false, lampHeight: 0 };
  }
  return null;
}

/** Legacy asset fallback for non-tree, non-Poly-Haven outdoor props (shelters, signs, bollards). */
function legacyPropAssets(kind: Prop['kind']): LifeAsset[] {
  switch (kind) {
    case 'shelter': return ['prop-bus-shelter-aaa'];
    case 'sign': return ['namepost'];
    case 'bollard': return ['bollard'];
    // `tree` is owned exclusively by A03's 22-species `VegetationSystem`; `lamp`/`bin`/`hydrant`/`bench` use A08 Poly Haven CC0 props.
    default: return [];
  }
}

const LEGACY_PROP_SCALE: Partial<Record<Exclude<Prop['kind'], 'asset'>, { by: 'h' | 'w'; v: number }>> = {
  shelter: { by: 'w', v: 3.6 },
  sign: { by: 'h', v: 2.6 },
  bollard: { by: 'h', v: 0.9 },
};

/** Keeps swinging door hierarchies and distant door leaves auto-updating while freezing static building shells. */
function isDynamicBuildingNode(obj: T.Object3D): boolean {
  if (obj.userData?.dynamic === true || obj.userData?.door === true || obj.userData?.lifeDoor != null) return true;
  if (obj.type === 'Group' && !obj.name && obj.children.length === 1 && (obj.children[0] as T.Mesh).isMesh) return true;
  return false;
}

const LOW_TIER_SKIP_STREET_PROPS = new Set<StreetPropKey>(['airconUnit', 'chalkboard', 'planterLush']);
const LOOKAHEAD_VEL_SEC = 1.35;
const LOOKAHEAD_VEL_MAX_M = 16.0;
const LOOKAHEAD_CAM_FWD_M = 6.0;
const MIN_CHUNK_DEMOTE_HOLD_MS = 2_500;
const STREAM_CELL_SIZE_M = 2.0;
const MAX_LAMP_NEAR_POOL = 16;

function nowPerfMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Shortest Euclidean distance in metres from point (x, z) to an axis-aligned chunk rectangle (0 when inside). */
export function distToRect(p: { x: number; z: number }, r: Rect): number {
  const dx = Math.max(r.x0 - p.x, 0, p.x - r.x1);
  const dz = Math.max(r.z0 - p.z, 0, p.z - r.z1);
  return Math.hypot(dx, dz);
}

function buildingKey(b: EnterableBuilding): string {
  return b.property?.id ?? b.id;
}

interface ChunkSlot {
  readonly def: CityChunk;
  /** Effective hysteresis bounds (resolves `campus-east` overlap with `library.rect`). */
  readonly effectiveRect: Rect;
  readonly buildings: EnterableBuilding[];
  readonly lots: Lot[];
  readonly props: Prop[];
  /** Validated, deduplicated WARM prefetch asset list (built once -> 0 fruitless lookups or per-transition Sets). */
  readonly prefetchLifeAssets: LifeAsset[];
  readonly prefetchStreetProps: StreetPropKey[];
  state: ChunkState;
  stateEnteredAtMs: number;
  warmPrefetched: boolean;
  imminentPrefetched: boolean;
  gen: number;
  warmRoots: T.Object3D[];
  warmOwned: { dispose(): void }[];
  pendingBuildings: EnterableBuilding[];
  prewarmingCount: number;
  hotBatchesBuilding: boolean;
  batchesPrewarmingCount: number;
  hotBuildings: BuildingBuild[];
  mountedSolidKeys: Set<string>;
  hotRoots: T.Object3D[];
  hotOwned: { dispose(): void }[];
  hotAssets: LifeAsset[];
  hotStreetProps: StreetPropKey[];
  lampPositions: T.Vector3[];
  lampGlowMesh: T.InstancedMesh | null;
}

/**
 * Distance-based spatial streaming manager for the 31-zone Echo Life city.
 *
 * Manages all 9 city chunks across `COLD` / `WARM` / `HOT` with 4-tier `renderConfig.ts` hysteresis:
 * - `HOT`: time-sliced enterable buildings (`<= 1` building/frame while keeping `WARM` shell visible until ready),
 *   instanced decorative lots, Poly Haven CC0 streetscape props (`streetPropsManifest.ts`), and district landmarks.
 * - `WARM`: merged 2-draw-call massing LOD shells + gentle background asset prefetch.
 * - `COLD`: unmounted, GPU resources disposed, asset ref-counts released, and LRU-trimmed.
 *
 * All trees, shrubs, flowers, ferns, and rocks are rendered by `VegetationSystem` + `GrassField` in `world.ts`,
 * so `CityStreamer` never duplicates legacy toy trees.
 */
export class CityStreamer {
  readonly group = new T.Group();
  readonly sectors = { north: new T.Group(), south: new T.Group(), sides: new T.Group() };

  private readonly slots: ChunkSlot[];
  private readonly residentBounds: Rect;
  private readonly surfaces?: WorldSurfaceLibrary;
  private readonly weather?: SharedWeatherUniforms;
  private onChunkSolidsChanged?: (bucketKey: string, solids: readonly SolidBox[]) => void;
  private prewarmObject?: (obj: T.Object3D, priority?: StreamPrewarmPriority) => Promise<void> | void;

  private quality: QualityTier;
  private hotEnter = 40;
  private hotExit = 52;
  private warmEnter = 105;
  private warmExit = 128;
  private maxCachedAssets = 56;
  private pruneTarget = 40;
  private hotBuildBudgetMs = 4;
  private useFullLotGlbs: 'none' | 'core-only' | 'all' = 'none';
  private filterHalfLots = false;
  private prefetchPerChunk = 8;

  private solidsRev = 0;
  private statsRev = 0;
  private visRev = 0;
  private mountedBuildRev = 0;
  private transitions = 0;
  private evictions = 0;
  private disposed = false;
  private starting = false;
  private hotBatchSerialChain: Promise<void> = Promise.resolve();
  private activeHotBatchJobs = 0;
  private readonly bootstrapPrewarms: Promise<void>[] = [];

  // Zero-alloc spatial state, velocity + camera lookahead, and memoized perimeter/empty cell caches.
  private readonly fallbackBodyPos = { x: 0, z: 0 };
  private readonly clampedBodyPos = { x: 0, z: 0 };
  private readonly lookaheadPos = { x: 0, z: 0 };
  private readonly lastBodyPos = { x: 0, z: 0 };
  private hasPrevBody = false;
  private prevBodyX = 0;
  private prevBodyZ = 0;
  private smoothVelX = 0;
  private smoothVelZ = 0;
  private camFwdX = 0;
  private camFwdZ = -1;
  private hasCamFwd = false;
  private explicitCamFwd = false;
  private camTurnRateRad = 0;
  private hasCamPos = false;
  private camLocalX = 0;
  private camLocalZ = 0;
  private cachedRootScene: T.Scene | null = null;
  private cachedSceneCamera: T.Camera | null = null;

  private lastEvalCellKey = Number.NaN;
  private lastLookCellKey = Number.NaN;
  private lastInteriorPrefetchCellKey = Number.NaN;
  private residencyDistTimer = 0;
  private readonly memoizedEmptyCells = new Set<number>();
  private readonly prefetchedInteriors = new Set<string>();
  private readonly lastInteriorStates = new Map<string, string>();

  // Zero-GC cached query slices (doors, fixtures, roots, blockers, lampsNear) read every frame by `world.ts`.
  private readonly cachedDoors: LifeDoor[] = [];
  private cachedDoorsRev = -1;
  private readonly cachedFixtures: { at: T.Vector3; room: string; warm: boolean }[] = [];
  private cachedFixturesBuildRev = -1;
  private cachedFixturesVisRev = -1;
  private readonly cachedRoots: T.Object3D[] = [];
  private cachedRootsBuildRev = -1;
  private cachedRootsVisRev = -1;
  private readonly cachedBlockers: T.Object3D[] = [];
  private cachedBlockersBuildRev = -1;
  private cachedBlockersVisRev = -1;

  private readonly lampNearOut: T.Vector3[] = [];
  private readonly lampNearD2 = new Float64Array(MAX_LAMP_NEAR_POOL);
  private lastLampX = Number.NaN;
  private lastLampZ = Number.NaN;
  private lastLampMax = -1;
  private lastLampBuildRev = -1;

  private lastNight = -1;
  private readonly lampGlowGeo: T.SphereGeometry;
  private readonly lampGlowMat: T.MeshStandardMaterial;

  // Window-preserving indoor enclosure occlusion state: hides unseen distant interior rooms while keeping
  // the sunlit campus/street/trees/facade shell outside windows visible (fixes G-04 Library window void).
  private enclosureBuildingKey: string | null = null;
  private enclosureChunkId: string | null = null;
  private enclosureCenter: { x: number; z: number } | null = null;
  private sectorMask = { north: true, south: true, sides: true };

  constructor(
    private readonly city: CityPlan,
    private readonly house: HousePlan,
    quality: QualityTier,
    opts: CityStreamerOptions = {},
  ) {
    this.quality = quality;
    this.surfaces = opts.surfaces;
    this.weather = opts.weather;
    this.onChunkSolidsChanged = opts.onChunkSolidsChanged;
    this.prewarmObject = opts.prewarmObject;

    this.group.name = 'echo-life-stream';
    this.sectors.north.name = 'stream-north';
    this.sectors.south.name = 'stream-south';
    this.sectors.sides.name = 'stream-sides';
    this.group.add(this.sectors.north, this.sectors.south, this.sectors.sides);
    // Static identity sector groups never translate/rotate; freeze their local matrices.
    this.sectors.north.matrixAutoUpdate = false;
    this.sectors.south.matrixAutoUpdate = false;
    this.sectors.sides.matrixAutoUpdate = false;
    this.sectors.north.updateMatrix();
    this.sectors.south.updateMatrix();
    this.sectors.sides.updateMatrix();

    // Shared 1-draw-call/chunk night lantern bulb geometry & emissive material (hidden completely during daylight).
    this.lampGlowGeo = new T.SphereGeometry(0.11, 8, 6);
    this.lampGlowMat = new T.MeshStandardMaterial({
      color: '#fff4d6',
      emissive: '#ffcb74',
      emissiveIntensity: 0,
      roughness: 0.25,
      metalness: 0,
    });
    patchMaterialWithEchoCsm(this.lampGlowMat);
    patchHeightFog(this.lampGlowMat);

    this.applyQualityConfig(quality);

    // Fix `campus-east` rect overlap with `library.rect` without mutating pure `cityPlan` geometry data.
    const libraryBld = city.buildings.find((b) => b.id === 'library');
    const byId = new Map<string, ChunkSlot>();
    let rx0 = Infinity;
    let rx1 = -Infinity;
    let rz0 = Infinity;
    let rz1 = -Infinity;
    this.slots = city.chunks.map((def) => {
      let effectiveRect = def.rect;
      if (def.id === 'campus-east' && libraryBld && def.rect.x0 < libraryBld.rect.x1 + 2) {
        effectiveRect = { ...def.rect, x0: Math.max(def.rect.x0, libraryBld.rect.x1 + 2) };
      }
      if (effectiveRect.x0 < rx0) rx0 = effectiveRect.x0;
      if (effectiveRect.x1 > rx1) rx1 = effectiveRect.x1;
      if (effectiveRect.z0 < rz0) rz0 = effectiveRect.z0;
      if (effectiveRect.z1 > rz1) rz1 = effectiveRect.z1;
      const slot: ChunkSlot = {
        def,
        effectiveRect,
        buildings: [],
        lots: [],
        props: [],
        prefetchLifeAssets: [],
        prefetchStreetProps: [],
        state: 'cold',
        stateEnteredAtMs: -Infinity,
        warmPrefetched: false,
        imminentPrefetched: false,
        gen: 0,
        warmRoots: [],
        warmOwned: [],
        pendingBuildings: [],
        prewarmingCount: 0,
        hotBatchesBuilding: false,
        batchesPrewarmingCount: 0,
        hotBuildings: [],
        mountedSolidKeys: new Set(),
        hotRoots: [],
        hotOwned: [],
        hotAssets: [],
        hotStreetProps: [],
        lampPositions: [],
        lampGlowMesh: null,
      };
      byId.set(def.id, slot);
      return slot;
    });

    // Strict intersection of `city.bounds` and valid resident chunk union: prevents out-of-bounds queries forever.
    this.residentBounds =
      this.slots.length > 0
        ? {
            x0: Math.max(city.bounds.x0, rx0),
            x1: Math.min(city.bounds.x1, rx1),
            z0: Math.max(city.bounds.z0, rz0),
            z1: Math.min(city.bounds.z1, rz1),
          }
        : { ...city.bounds };

    const fallback = byId.get('home-core') ?? this.slots[0];
    for (const b of city.buildings) (byId.get(b.chunkId) ?? fallback).buildings.push(b);
    for (const l of city.lots) (byId.get(l.chunkId) ?? fallback).lots.push(l);
    for (const p of city.props) (byId.get(p.chunkId) ?? fallback).props.push(p);

    // Precompute validated, deduplicated WARM prefetch manifests once at startup (zero fruitless/unknown lookups).
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const lifeSet = new Set<LifeAsset>();
      const streetSet = new Set<StreetPropKey>();
      for (let li = 0; li < slot.lots.length; li++) {
        const optsList = LOT_ASSETS[slot.lots[li].use];
        const base = optsList?.[0];
        if (base) {
          const id = LOD_PAIR[base] ?? base;
          if (id in LIFE_ASSETS) lifeSet.add(id);
        }
      }
      for (let pi = 0; pi < slot.props.length; pi++) {
        const pr = slot.props[pi];
        if (pr.kind === 'tree' || (pr.kind === 'asset' && pr.asset?.startsWith('tree-'))) continue;
        const rep = streetPropReplacement(pr);
        if (rep) {
          if (rep.key in STREET_PROPS) streetSet.add(rep.key);
          continue;
        }
        if (pr.kind === 'asset' && pr.asset && pr.asset in LIFE_ASSETS) {
          lifeSet.add(pr.asset as LifeAsset);
        }
      }
      slot.prefetchLifeAssets.push(...lifeSet);
      slot.prefetchStreetProps.push(...streetSet);
    }
  }

  private applyQualityConfig(tier: QualityTier) {
    const cfg = getRenderConfig(tier).streaming;
    this.quality = tier;
    setGltfTextureTier(tier);
    // Keep behind-house cross-district chunks in clean 2-DC WARM shells when standing in Riverside Park on High/Ultra
    // and tighten Balanced to 36/48 m so 4x CPU Lantern St & Driving EV sustain >= 30 FPS!
    this.hotEnter =
      tier === 'ultra' ? Math.min(cfg.hotEnter, 54)
        : tier === 'high' ? Math.min(cfg.hotEnter, 48)
        : tier === 'balanced' ? Math.min(cfg.hotEnter, 36)
        : cfg.hotEnter;
    this.hotExit =
      tier === 'ultra' ? Math.min(cfg.hotExit, 68)
        : tier === 'high' ? Math.min(cfg.hotExit, 62)
        : tier === 'balanced' ? Math.min(cfg.hotExit, 48)
        : cfg.hotExit;
    this.warmEnter = cfg.warmEnter;
    this.warmExit = cfg.warmExit;
    this.maxCachedAssets = cfg.maxResidentAssets;
    this.pruneTarget = cfg.pruneTarget;
    this.hotBuildBudgetMs = Math.min(cfg.hotBuildBudgetMs, 3.8);
    this.useFullLotGlbs = cfg.useFullLotGlbs;
    this.filterHalfLots = cfg.filterHalfLots;
    this.prefetchPerChunk = cfg.prefetchPerChunk;
    this.lastEvalCellKey = Number.NaN;
    this.lastLookCellKey = Number.NaN;
    this.memoizedEmptyCells.clear();
  }

  /** Validated resident city bounds used to clamp all streaming and lookahead queries. */
  get bounds(): Readonly<Rect> {
    return this.residentBounds;
  }

  /** Latest clamped velocity + camera-forward predictive focus in stage metres. */
  get predictiveFocus(): { readonly x: number; readonly z: number } {
    return this.lookaheadPos;
  }

  /** Explicitly supplies horizontal camera forward vector (stage XZ) for headless tests or external controllers. */
  setCameraForward(fx: number, fz: number): void {
    const len = Math.hypot(fx, fz);
    if (len > 1e-4) {
      this.camFwdX = fx / len;
      this.camFwdZ = fz / len;
      this.hasCamFwd = true;
      this.explicitCamFwd = true;
    }
  }

  get solidsVersion() { return this.solidsRev; }
  get statsVersion() { return this.statsRev; }
  get visibilityVersion() { return this.visRev; }

  setChunkSolidsListener(fn: ((bucketKey: string, solids: readonly SolidBox[]) => void) | undefined) {
    this.onChunkSolidsChanged = fn;
  }

  setPrewarmObject(fn: ((obj: T.Object3D, priority?: StreamPrewarmPriority) => Promise<void> | void) | undefined) {
    this.prewarmObject = fn;
  }

  setQuality(tier: QualityTier) {
    if (this.disposed || tier === this.quality) return;
    this.applyQualityConfig(tier);
    const shadowCfg = getRenderConfig(tier).shadow;
    const propShadows = tier === 'high' || tier === 'ultra';
    for (const slot of this.slots) {
      if (slot.state !== 'hot') continue;
      for (const b of slot.hotBuildings) b.setQuality?.(tier);
      for (const root of slot.hotRoots) {
        if (root === slot.lampGlowMesh) continue;
        const isLot = root.name.startsWith('life:bld-');
        const cast = isLot ? (shadowCfg.castAllLots || (tier === 'high' && !!slot.def.core)) : propShadows;
        root.traverse((o) => {
          const m = o as T.Mesh;
          if (m.isMesh) {
            m.castShadow = cast;
            m.receiveShadow = propShadows || isLot;
          }
        });
      }
    }
    this.applyVisibilityState();
    this.prune();
    this.statsRev++;
  }

  setSectors(north: boolean, south: boolean, sides: boolean) {
    if (
      this.sectorMask.north === north &&
      this.sectorMask.south === south &&
      this.sectorMask.sides === sides
    ) {
      return;
    }
    this.sectorMask.north = north;
    this.sectorMask.south = south;
    this.sectorMask.sides = sides;
    this.applyVisibilityState();
  }

  /**
   * Window-preserving indoor enclosure culling (fixes G-04 Library window void):
   * When inside enterable building `buildingKeyVal`, keeps the active chunk's exterior streetscape
   * (`hotRoots`), neighboring exterior building facades (whose interiors auto-cull via `setCameraPos`),
   * and adjacent chunks' massing shells visible outside windows while hiding unseen distant chunks/interiors.
   */
  setEnclosure(
    buildingKeyVal: string | null,
    chunkId: string | null = null,
    center: { x: number; z: number } | null = null,
  ) {
    if (this.enclosureBuildingKey === buildingKeyVal && this.enclosureChunkId === chunkId) return;
    this.enclosureBuildingKey = buildingKeyVal;
    this.enclosureChunkId = chunkId;
    this.enclosureCenter = center;
    this.applyVisibilityState();
  }

  private applyVisibilityState() {
    let nVis = this.sectorMask.north;
    let sVis = this.sectorMask.south;
    let sideVis = this.sectorMask.sides;

    const enclosed = this.enclosureBuildingKey !== null;
    const ensureParentSectorVisible = (node: T.Object3D) => {
      const parent = node.parent;
      if (parent === this.sectors.north) nVis = true;
      else if (parent === this.sectors.south) sVis = true;
      else if (parent === this.sectors.sides) sideVis = true;
    };

    for (const slot of this.slots) {
      if (!enclosed) {
        for (const r of slot.warmRoots) r.visible = true;
        for (const r of slot.hotRoots) {
          if (r.userData.prewarming) { r.visible = false; continue; }
          r.visible = r === slot.lampGlowMesh ? this.lastNight > 0.04 : true;
        }
        for (const b of slot.hotBuildings) b.group.visible = !b.group.userData.prewarming;
        continue;
      }

      const isActiveChunk = slot.def.id === this.enclosureChunkId;
      const lowTier = this.quality === 'low';
      const nearWindow =
        !lowTier &&
        (isActiveChunk ||
          (this.enclosureCenter !== null && distToRect(this.enclosureCenter, slot.effectiveRect) <= 58));

      // Keep WARM massing shells visible for distant neighborhoods seen down the street through windows
      // on Balanced/High/Ultra; on Low (iGPU floor), keep only pending active-chunk placeholder shells (P1-PERF-4).
      for (const r of slot.warmRoots) {
        r.visible = lowTier
          ? isActiveChunk && (slot.pendingBuildings.length > 0 || slot.prewarmingCount > 0)
          : !isActiveChunk || slot.pendingBuildings.length > 0 || slot.prewarmingCount > 0;
        if (r.visible) ensureParentSectorVisible(r);
      }

      // Keep the current & immediate adjacent chunk's exterior street props/lots visible through windows on Balanced+;
      // on Low (iGPU floor), hide exterior street/lot BatchedMeshes while inside a city building.
      for (const r of slot.hotRoots) {
        if (r.userData.prewarming) { r.visible = false; continue; }
        const vis = nearWindow && (r === slot.lampGlowMesh ? this.lastNight > 0.04 : true);
        r.visible = vis;
        if (vis) ensureParentSectorVisible(r);
      }

      for (const b of slot.hotBuildings) {
        if (b.group.userData.prewarming) { b.group.visible = false; continue; }
        const isCurrent = isActiveChunk && buildingKey(b.building) === this.enclosureBuildingKey;
        // Keep current building AND (on Balanced/High/Ultra) neighboring buildings in the same chunk
        // (their own interiors auto-cull beyond ~5 m via `buildingsView.setCameraPos`, leaving only exterior facades).
        const keep = isCurrent || (!lowTier && isActiveChunk);
        b.group.visible = keep;
        if (keep) ensureParentSectorVisible(b.group);
      }
    }

    this.sectors.north.visible = nVis;
    this.sectors.south.visible = sVis;
    this.sectors.sides.visible = sideVis;
    this.visRev++;
  }

  setResidences(owned: readonly string[]) {
    const changed = new Set<ChunkSlot>();
    for (const home of this.city.residences) {
      const slot = this.slots.find((s) => s.def.id === home.chunkId)!;
      const index = slot.buildings.indexOf(home);
      const allowed = owned.includes(home.property!.id);
      if (allowed === (index >= 0)) continue;
      if (allowed) slot.buildings.push(home);
      else slot.buildings.splice(index, 1);
      changed.add(slot);
    }
    for (const slot of changed) {
      if (slot.state === 'hot') void this.enterHot(slot, true);
    }
  }

  /** Apply live night illumination across HOT buildings and Poly Haven streetlamp lantern globes. */
  setAtmosphere(_season: number, night: number) {
    const n = Math.round(Math.max(0, Math.min(1, night)) * 20) / 20;
    if (n === this.lastNight) return;
    this.lastNight = n;

    const showGlow = n > 0.04;
    this.lampGlowMat.emissiveIntensity = showGlow ? 0.55 + n * 2.25 : 0;

    for (const slot of this.slots) {
      if (slot.state !== 'hot') continue;
      for (const b of slot.hotBuildings) b.setNight(n);
      if (slot.lampGlowMesh && !slot.lampGlowMesh.userData.prewarming) {
        const nearWin =
          this.enclosureBuildingKey === null ||
          slot.def.id === this.enclosureChunkId ||
          (this.enclosureCenter !== null && distToRect(this.enclosureCenter, slot.effectiveRect) <= 58);
        slot.lampGlowMesh.visible = showGlow && nearWin;
      }
    }
  }

  private resolveSceneCamera(worldPos: T.Vector3): T.Camera | null {
    const checkCam = (cam: T.Camera | null): boolean => {
      if (!cam) return false;
      const e = cam.matrixWorld.elements;
      const dx = e[12] - worldPos.x;
      const dy = e[13] - worldPos.y;
      const dz = e[14] - worldPos.z;
      return dx * dx + dy * dy + dz * dz <= 1e-3;
    };
    if (checkCam(this.cachedSceneCamera)) return this.cachedSceneCamera;

    if (!this.cachedRootScene) {
      let p: T.Object3D | null = this.group.parent;
      while (p && !(p instanceof T.Scene)) p = p.parent;
      if (p instanceof T.Scene) this.cachedRootScene = p;
    }
    const scene = this.cachedRootScene;
    if (!scene) return null;
    const children = scene.children;
    for (let i = 0; i < children.length; i++) {
      const ch = children[i] as T.Camera;
      if (ch && ch.isCamera && checkCam(ch)) {
        this.cachedSceneCamera = ch;
        return ch;
      }
    }
    return null;
  }

  setCameraPos(pos: T.Vector3) {
    // Convert camera world position into stage-local XZ without allocating matrices.
    const parent = this.group.parent;
    if (parent) {
      const pe = parent.matrixWorld.elements;
      const sx = Math.hypot(pe[0], pe[1], pe[2]) || 1;
      this.camLocalX = (pos.x - pe[12]) / sx;
      this.camLocalZ = (pos.z - pe[14]) / sx;
    } else {
      this.camLocalX = pos.x;
      this.camLocalZ = pos.z;
    }
    this.hasCamPos = true;

    // Extract exact horizontal camera forward from the matching active Scene camera (zero allocations).
    if (!this.explicitCamFwd) {
      const matchedCam = this.resolveSceneCamera(pos);
      if (matchedCam) {
        const ce = matchedCam.matrixWorld.elements;
        // Three.js camera looks along local -Z -> (-ce[8], -ce[10]) in world/stage XZ.
        const fx = -ce[8];
        const fz = -ce[10];
        const fLen = Math.hypot(fx, fz);
        if (fLen > 1e-4) {
          const nfx = fx / fLen;
          const nfz = fz / fLen;
          if (this.hasCamFwd) {
            const dot = Math.max(-1, Math.min(1, this.camFwdX * nfx + this.camFwdZ * nfz));
            this.camTurnRateRad = Math.acos(dot) * 60;
          }
          this.camFwdX = nfx;
          this.camFwdZ = nfz;
          this.hasCamFwd = true;
        }
      }
    }

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot.state !== 'hot') continue;
      for (let j = 0; j < slot.hotBuildings.length; j++) {
        slot.hotBuildings[j].setCameraPos?.(pos);
      }
    }
  }

  /** Nearest streetlamp globe world positions around `body` for the pooled night streetlamp lights (zero-GC!). */
  lampsNear(body: { x: number; z: number }, max = 4): T.Vector3[] {
    const cap = Math.max(0, Math.min(MAX_LAMP_NEAR_POOL, max | 0));
    if (cap === 0) {
      this.lampNearOut.length = 0;
      return this.lampNearOut;
    }

    clampToBounds(body.x, body.z, this.residentBounds, this.clampedBodyPos);
    const bx = this.clampedBodyPos.x;
    const bz = this.clampedBodyPos.z;
    const moveDx = bx - this.lastLampX;
    const moveDz = bz - this.lastLampZ;
    if (
      this.lastLampBuildRev === this.mountedBuildRev &&
      this.lastLampMax === cap &&
      moveDx * moveDx + moveDz * moveDz < 0.25
    ) {
      return this.lampNearOut;
    }
    this.lastLampX = bx;
    this.lastLampZ = bz;
    this.lastLampMax = cap;
    this.lastLampBuildRev = this.mountedBuildRev;

    const out = this.lampNearOut;
    const d2Arr = this.lampNearD2;
    let count = 0;
    const maxRadiusSq = 32 * 32;

    for (let s = 0; s < this.slots.length; s++) {
      const slot = this.slots[s];
      if (slot.state !== 'hot') continue;
      const lamps = slot.lampPositions;
      for (let i = 0; i < lamps.length; i++) {
        const p = lamps[i];
        const dx = p.x - bx;
        const dz = p.z - bz;
        const d2 = dx * dx + dz * dz;
        if (d2 > maxRadiusSq) continue;
        if (count === cap && d2 >= d2Arr[count - 1]) continue;

        let pos = count < cap ? count : cap - 1;
        if (count < cap) count++;
        while (pos > 0 && d2 < d2Arr[pos - 1]) {
          d2Arr[pos] = d2Arr[pos - 1];
          out[pos] = out[pos - 1];
          pos--;
        }
        d2Arr[pos] = d2;
        out[pos] = p;
      }
    }
    out.length = count;
    return out;
  }

  /** Residency-governed LRU trim when GPU texture count exceeds tier budget (never disposes mid-compile!). */
  pruneBudget(limit: number) {
    if (getInFlightCompileCount() > 0) return;
    const { referenced } = lifeAssetStats();
    const residencyEvicted = getEchoLifeResidencyManager().evictIfNeeded();
    const aggressive = limit <= 8;
    const evicted = pruneLifeAssets({
      maxTotal: Math.max(16, Math.min(limit, referenced + 8)),
      aggressive,
      maxIdleMs: 30_000,
    });
    const evictedProps = pruneStreetProps(Math.max(16, aggressive ? 16 : 24), 45_000);
    const total = residencyEvicted + evicted + evictedProps;
    if (total > 0) {
      this.evictions += total;
      this.statsRev++;
    }
  }

  private sectorOfChunk(slot: ChunkSlot, z: number, x: number): T.Group {
    if (!slot.def.core) {
      const cx = (slot.effectiveRect.x0 + slot.effectiveRect.x1) / 2;
      const cz = (slot.effectiveRect.z0 + slot.effectiveRect.z1) / 2;
      return this.sectorOf(cz, cx);
    }
    // Keep `home-core` north yard/park separate for Study Room window visibility, but merge south & side
    // props into `south` so `home-core` avoids triple-splitting identical instanced prop/lot batches.
    return z < this.house.footprint.z0 ? this.sectors.north : this.sectors.south;
  }

  private sectorOf(z: number, x: number): T.Group {
    if (z < this.house.footprint.z0) return this.sectors.north;
    if (
      z > this.house.front - 1 &&
      ((x > this.city.bounds.x0 + 30 && x < this.city.bounds.x1 - 30) || z < this.house.front + 14)
    ) {
      return this.sectors.south;
    }
    return this.sectors.sides;
  }

  /** Mounts initial chunks around `body` yielding across animation frames so cold startup stays responsive. */
  async bootstrap(body: { x: number; z: number }): Promise<void> {
    if (this.disposed) return;
    clampToBounds(body.x, body.z, this.residentBounds, this.clampedBodyPos);
    this.lastBodyPos.x = this.clampedBodyPos.x;
    this.lastBodyPos.z = this.clampedBodyPos.z;
    this.lookaheadPos.x = this.clampedBodyPos.x;
    this.lookaheadPos.z = this.clampedBodyPos.z;
    this.prevBodyX = this.clampedBodyPos.x;
    this.prevBodyZ = this.clampedBodyPos.z;
    this.hasPrevBody = true;
    this.starting = true;
    getEchoLifeLoadScheduler().setMode('boot');
    getEchoLifeTextureUploadQueue().setLivePacing(false);
    this.bootstrapPrewarms.length = 0;
    const bootAnchor = { x: this.clampedBodyPos.x, z: this.clampedBodyPos.z };
    const ordered = [...this.slots].sort(
      (a, b) => distToRect(bootAnchor, a.effectiveRect) - distToRect(bootAnchor, b.effectiveRect),
    );
    const jobs: Promise<void>[] = [];
    try {
      const bootSlicer = new EchoLifeTimeSlicer(this.hotBuildBudgetMs);
      const bootNow = nowPerfMs();
      for (const slot of ordered) {
        if (this.disposed) break;
        const target = this.desiredState(slot, bootAnchor, bootAnchor, bootNow);
        if (target === 'cold') continue;
        if (target === 'hot') jobs.push(this.enterHot(slot, true));
        else this.enterWarm(slot);
        await bootSlicer.yieldFrame();
      }
      // Drain all initial HOT building queues cleanly before resolving bootstrap so initial doors/solids exist.
      while (!this.disposed && this.hasPendingHotBuildings()) {
        this.drainPendingBuildings(true);
        if (this.hasPendingHotBuildings()) {
          await bootSlicer.yieldFrame();
        }
      }
      await Promise.all(jobs);
      // Await asynchronous shader prewarms (`compileAsync`) queued during bootstrap behind the loading overlay
      // so initial Lantern St / Park chunks never stall on a cold 439 ms shader compile!
      if (!this.disposed && this.bootstrapPrewarms.length > 0) {
        await Promise.allSettled(this.bootstrapPrewarms);
      }
    } finally {
      this.bootstrapPrewarms.length = 0;
      this.starting = false;
      getEchoLifeLoadScheduler().setMode('live');
      getEchoLifeTextureUploadQueue().setLivePacing(true);
      this.applyVisibilityState();
      this.statsRev++;
    }
  }

  private desiredState(
    slot: ChunkSlot,
    body: { x: number; z: number },
    lookahead: { x: number; z: number },
    nowMs: number,
  ): ChunkState {
    const dBody = distToRect(body, slot.effectiveRect);
    const dLook = distToRect(lookahead, slot.effectiveRect);
    const dWarm = dLook < dBody ? dLook : dBody;
    const holdDemotion = nowMs - slot.stateEnteredAtMs < MIN_CHUNK_DEMOTE_HOLD_MS;

    // Allow `home-core` outdoor lots/props to demote cleanly to WARM/COLD with tier + cooldown hysteresis
    // when the player visits distant districts (while instant cross-map jumps > +8 m demote immediately).
    if (slot.state === 'hot') {
      if (dBody <= this.hotExit || (holdDemotion && dBody <= this.hotExit + 8)) return 'hot';
      return dWarm <= this.warmExit ? 'warm' : 'cold';
    }
    if (slot.state === 'warm') {
      if (dBody <= this.hotEnter) return 'hot';
      if (dWarm <= this.warmExit || (holdDemotion && dWarm <= this.warmExit + 10)) return 'warm';
      return 'cold';
    }
    if (dBody <= this.hotEnter) return 'hot';
    if (dWarm <= this.warmEnter) return 'warm';
    return 'cold';
  }

  private maybeReleaseWarmShell(slot: ChunkSlot): void {
    if (
      slot.state === 'hot' &&
      slot.warmRoots.length > 0 &&
      slot.pendingBuildings.length === 0 &&
      slot.prewarmingCount === 0 &&
      !slot.hotBatchesBuilding &&
      slot.batchesPrewarmingCount === 0
    ) {
      this.leaveWarm(slot);
      this.statsRev++;
    }
  }

  private hasPendingHotBuildings(): boolean {
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i].state === 'hot' && this.slots[i].pendingBuildings.length > 0) return true;
    }
    return false;
  }

  /**
   * Time-sliced building mount queue: builds `<= 1` enterable building per frame within `hotBuildBudgetMs`,
   * attaches ONLY that building's Rapier solids (`O(1)` per building, fixing the `O(B^2)` rebuild spike!),
   * and runs non-blocking off-stage `renderer.compileAsync()` prewarm BEFORE revealing the mounted building
   * while keeping the `WARM` massing shell visible until ready.
   */
  private drainPendingBuildings(allowMultipleWithinBudget = false): number {
    const startMs = nowPerfMs();
    let mountedCount = 0;

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot.state !== 'hot' || slot.pendingBuildings.length === 0) continue;

      while (slot.pendingBuildings.length > 0) {
        if (mountedCount >= 1 && (!allowMultipleWithinBudget || nowPerfMs() - startMs >= this.hotBuildBudgetMs)) {
          return mountedCount;
        }
        // Always mount the nearest pending building to the player first so imminent doorways settle first!
        let bestIdx = 0;
        let bestDist = distToRect(this.lastBodyPos, slot.pendingBuildings[0].rect);
        for (let k = 1; k < slot.pendingBuildings.length; k++) {
          const dk = distToRect(this.lastBodyPos, slot.pendingBuildings[k].rect);
          if (dk < bestDist) {
            bestDist = dk;
            bestIdx = k;
          }
        }
        const b = slot.pendingBuildings.splice(bestIdx, 1)[0]!;
        const gen = slot.gen;
        const build = buildEnterableBuilding(b, {
          surfaces: this.surfaces,
          tier: this.quality,
          weather: this.weather,
        });
        stripTransmissionFromHierarchy(build.group);
        if (this.lastNight >= 0) build.setNight(this.lastNight);
        const cx = (b.rect.x0 + b.rect.x1) / 2;
        const cz = (b.rect.z0 + b.rect.z1) / 2;
        this.sectorOf(cz, cx).add(build.group);
        freezeStaticHierarchy(build.group, { isDynamic: isDynamicBuildingNode });
        slot.hotBuildings.push(build);
        this.mountedBuildRev++;
        mountedCount++;

        // Incremental O(1) per-building Rapier collider attach (never rebuilds earlier buildings in the chunk!).
        this.emitBuildingSolids(slot, build);
        this.solidsRev++;

        const priority: StreamPrewarmPriority = bestDist <= 28 ? 'imminent' : 'background';
        const prewarmRes = this.prewarmObject ? this.prewarmObject(build.group, priority) : undefined;
        if (prewarmRes && typeof (prewarmRes as Promise<void>).then === 'function') {
          build.group.userData.prewarming = true;
          build.group.visible = false;
          slot.prewarmingCount++;
          const prewarmJob = Promise.resolve(prewarmRes)
            .catch(() => undefined)
            .finally(() => {
              if (this.disposed || slot.gen !== gen) return;
              delete build.group.userData.prewarming;
              slot.prewarmingCount = Math.max(0, slot.prewarmingCount - 1);
              this.maybeReleaseWarmShell(slot);
              this.applyVisibilityState();
            });
          if (this.starting) this.bootstrapPrewarms.push(prewarmJob);
        } else {
          this.maybeReleaseWarmShell(slot);
          this.applyVisibilityState();
        }

        if (!allowMultipleWithinBudget || nowPerfMs() - startMs >= this.hotBuildBudgetMs) {
          return mountedCount;
        }
      }
    }
    return mountedCount;
  }

  private buildingBucketKey(slot: ChunkSlot, b: EnterableBuilding): string {
    return `bld:${slot.def.id}:${buildingKey(b)}`;
  }

  private emitBuildingSolids(slot: ChunkSlot, build: BuildingBuild) {
    if (!this.onChunkSolidsChanged) return;
    const key = this.buildingBucketKey(slot, build.building);
    slot.mountedSolidKeys.add(key);
    this.onChunkSolidsChanged(key, build.solids);
  }

  private spatialCellKey(x: number, z: number): number {
    const b = this.residentBounds;
    const cols = Math.max(1, Math.ceil((b.x1 - b.x0) / STREAM_CELL_SIZE_M) + 2);
    const ix = Math.max(0, Math.floor((x - b.x0) / STREAM_CELL_SIZE_M));
    const iz = Math.max(0, Math.floor((z - b.z0) / STREAM_CELL_SIZE_M));
    return iz * cols + ix;
  }

  private isEmptyPerimeterCell(cellKey: number, pt: { x: number; z: number }): boolean {
    if (this.memoizedEmptyCells.has(cellKey)) return true;
    // A cell in an unchunked perimeter corner far outside every chunk's WARM enter band can never trigger HOT/WARM loads.
    for (let i = 0; i < this.slots.length; i++) {
      if (distToRect(pt, this.slots[i].effectiveRect) <= this.warmEnter + 2) {
        return false;
      }
    }
    if (this.memoizedEmptyCells.size >= 512) this.memoizedEmptyCells.clear();
    this.memoizedEmptyCells.add(cellKey);
    return true;
  }

  private prefetchSlotAssets(slot: ChunkSlot, imminent: boolean): void {
    if (this.prefetchPerChunk <= 0) return;
    if (imminent) {
      if (slot.imminentPrefetched) return;
      slot.imminentPrefetched = true;
      slot.warmPrefetched = true;
    } else {
      if (slot.warmPrefetched) return;
      slot.warmPrefetched = true;
    }

    const scheduler = getEchoLifeLoadScheduler();
    const prio = imminent ? LoadPriority.P1_PREFETCH : LoadPriority.P2_NEAR_CHUNK;
    const cap = imminent ? Math.max(this.prefetchPerChunk, 12) : this.prefetchPerChunk;

    let count = 0;
    for (let i = 0; i < slot.prefetchLifeAssets.length && count < cap; i++) {
      const id = slot.prefetchLifeAssets[i];
      scheduler.hintPriority(`life-asset:${id}`, prio);
      prefetchLifeAsset(id);
      count++;
    }
    if (imminent) {
      let propCount = 0;
      const propCap = this.quality === 'low' ? 3 : 6;
      for (let i = 0; i < slot.prefetchStreetProps.length && propCount < propCap; i++) {
        const key = slot.prefetchStreetProps[i];
        if (this.quality === 'low' && LOW_TIER_SKIP_STREET_PROPS.has(key)) continue;
        scheduler.hintPriority(`street-prop:${key}`, LoadPriority.P1_PREFETCH);
        void loadStreetProp(key);
        propCount++;
      }
    }
  }

  private runPredictiveInteriorPrefetch(body: { x: number; z: number }, lookahead: { x: number; z: number }): void {
    if (this.prefetchPerChunk <= 0) return;
    const scheduler = getEchoLifeLoadScheduler();
    for (let s = 0; s < this.slots.length; s++) {
      const slot = this.slots[s];
      if (slot.state === 'cold') continue;
      for (let bi = 0; bi < slot.buildings.length; bi++) {
        const b = slot.buildings[bi];
        const bKey = buildingKey(b);
        if (this.prefetchedInteriors.has(bKey)) continue;
        const spec = getInteriorPrefetchSpec(b.id);
        if (!spec) continue;

        const dBody = distToRect(body, b.rect);
        const dLook = distToRect(lookahead, b.rect);
        if (dBody > spec.prefetchRadiusM && dLook > spec.lookaheadRadiusM) continue;

        this.prefetchedInteriors.add(bKey);
        for (let i = 0; i < spec.streetProps.length; i++) {
          const spKey = spec.streetProps[i];
          if (spKey in STREET_PROPS) {
            scheduler.hintPriority(`street-prop:${spKey}`, LoadPriority.P1_PREFETCH);
            void loadStreetProp(spKey);
          }
        }
        if (spec.lifeAssets) {
          for (let i = 0; i < spec.lifeAssets.length; i++) {
            const la = spec.lifeAssets[i];
            if (la in LIFE_ASSETS) {
              scheduler.hintPriority(`life-asset:${la}`, LoadPriority.P1_PREFETCH);
              prefetchLifeAsset(la);
            }
          }
        }
      }
    }
  }

  private syncResidencyDistances(body: { x: number; z: number }): void {
    const residency = getEchoLifeResidencyManager();
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const d = distToRect(body, slot.effectiveRect);
      for (let a = 0; a < slot.prefetchLifeAssets.length; a++) {
        residency.updateDistance(`life-asset:${slot.prefetchLifeAssets[a]}`, d);
      }
      for (let p = 0; p < slot.prefetchStreetProps.length; p++) {
        residency.updateDistance(`street-prop:${slot.prefetchStreetProps[p]}`, d);
      }
    }
  }

  update(
    dt: number,
    body: { x: number; z: number } | null,
    reduced: boolean,
    opts?: StreamingUpdateOptions,
  ) {
    if (this.disposed) return;
    const frameStartMs = nowPerfMs();
    const safeDt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 1 / 60;
    const rawBody = body ?? this.fallbackBodyPos;

    // 1. Clamp spatial query strictly to resident city bounds (prevents loading non-existent perimeter regions).
    clampToBounds(rawBody.x, rawBody.z, this.residentBounds, this.clampedBodyPos);
    const bx = this.clampedBodyPos.x;
    const bz = this.clampedBodyPos.z;
    this.lastBodyPos.x = bx;
    this.lastBodyPos.z = bz;

    // 2. Smooth velocity + camera-direction lookahead (`pos + clamp(vel * 1.35, max 16 m) + camFwd * 6 m`).
    if (opts?.velocity) {
      const vx = Number.isFinite(opts.velocity.x) ? opts.velocity.x : 0;
      const vz = Number.isFinite(opts.velocity.z) ? opts.velocity.z : 0;
      const alpha = reduced ? 1 : 1 - Math.exp(-12 * safeDt);
      this.smoothVelX += (vx - this.smoothVelX) * alpha;
      this.smoothVelZ += (vz - this.smoothVelZ) * alpha;
      this.prevBodyX = bx;
      this.prevBodyZ = bz;
      this.hasPrevBody = true;
    } else if (this.hasPrevBody && safeDt > 1e-4) {
      const stepDx = bx - this.prevBodyX;
      const stepDz = bz - this.prevBodyZ;
      const stepDistSq = stepDx * stepDx + stepDz * stepDz;
      this.prevBodyX = bx;
      this.prevBodyZ = bz;
      if (stepDistSq > 18 * 18) {
        // Teleport / spawn reset: clear residual velocity so lookahead snaps cleanly to arrival destination.
        this.smoothVelX = 0;
        this.smoothVelZ = 0;
        this.lastEvalCellKey = Number.NaN;
      } else {
        const instVx = stepDx / safeDt;
        const instVz = stepDz / safeDt;
        const alpha = reduced ? 1 : 1 - Math.exp(-10 * safeDt);
        this.smoothVelX += (instVx - this.smoothVelX) * alpha;
        this.smoothVelZ += (instVz - this.smoothVelZ) * alpha;
      }
    } else {
      this.prevBodyX = bx;
      this.prevBodyZ = bz;
      this.hasPrevBody = true;
    }

    const speedMps = Math.hypot(this.smoothVelX, this.smoothVelZ);
    if (speedMps < 0.02) {
      this.smoothVelX = 0;
      this.smoothVelZ = 0;
    }

    if (opts?.cameraForward) {
      const len = Math.hypot(opts.cameraForward.x, opts.cameraForward.z);
      if (len > 1e-4) {
        this.camFwdX = opts.cameraForward.x / len;
        this.camFwdZ = opts.cameraForward.z / len;
        this.hasCamFwd = true;
        this.explicitCamFwd = true;
      }
    } else if (opts?.camera) {
      const ce = opts.camera.matrixWorld.elements;
      const fx = -ce[8];
      const fz = -ce[10];
      const len = Math.hypot(fx, fz);
      if (len > 1e-4) {
        this.camFwdX = fx / len;
        this.camFwdZ = fz / len;
        this.hasCamFwd = true;
      }
    } else if (!this.hasCamFwd && this.hasCamPos) {
      const cdx = bx - this.camLocalX;
      const cdz = bz - this.camLocalZ;
      const cLen = Math.hypot(cdx, cdz);
      if (cLen >= 0.32) {
        this.camFwdX = cdx / cLen;
        this.camFwdZ = cdz / cLen;
        this.hasCamFwd = true;
      } else if (speedMps > 0.25) {
        this.camFwdX = this.smoothVelX / speedMps;
        this.camFwdZ = this.smoothVelZ / speedMps;
        this.hasCamFwd = true;
      }
    }

    // Feed live motion & camera-pan telemetry to `TextureUploadQueue` so GPU `initTexture` throttles to <= 1-2/frame!
    if (!this.starting) {
      const uploadQueue = getEchoLifeTextureUploadQueue();
      if (!uploadQueue.isLivePacing) uploadQueue.setLivePacing(true);
      uploadQueue.setMotionState(speedMps, this.camTurnRateRad);
      this.camTurnRateRad *= Math.max(0, 1 - safeDt * 12);
    }

    let leadX = this.smoothVelX * LOOKAHEAD_VEL_SEC;
    let leadZ = this.smoothVelZ * LOOKAHEAD_VEL_SEC;
    const leadMag = Math.hypot(leadX, leadZ);
    if (leadMag > LOOKAHEAD_VEL_MAX_M) {
      const scale = LOOKAHEAD_VEL_MAX_M / leadMag;
      leadX *= scale;
      leadZ *= scale;
    }
    const camLeadX = this.hasCamFwd ? this.camFwdX * LOOKAHEAD_CAM_FWD_M : 0;
    const camLeadZ = this.hasCamFwd ? this.camFwdZ * LOOKAHEAD_CAM_FWD_M : 0;
    clampToBounds(bx + leadX + camLeadX, bz + leadZ + camLeadZ, this.residentBounds, this.lookaheadPos);

    // 3. Time-slice pending HOT building builds (<= 1 building per animation frame -> eliminates 60-150 ms Long Tasks!).
    let mountedBuildingThisFrame = false;
    if (!this.starting && this.hasPendingHotBuildings()) {
      mountedBuildingThisFrame = this.drainPendingBuildings(false) > 0;
    }

    // 4. Evaluate chunk transitions (memoized across 2 m cells & clamped perimeter cells; at most 1 HOT promotion/frame).
    const bodyCellKey = this.spatialCellKey(bx, bz);
    const lookCellKey = this.spatialCellKey(this.lookaheadPos.x, this.lookaheadPos.z);
    const needChunkEval =
      !this.starting &&
      (bodyCellKey !== this.lastEvalCellKey ||
        lookCellKey !== this.lastLookCellKey ||
        mountedBuildingThisFrame ||
        this.activeHotBatchJobs > 0);

    if (needChunkEval) {
      const skipEmptyPerimeter =
        this.isEmptyPerimeterCell(bodyCellKey, this.clampedBodyPos) &&
        this.isEmptyPerimeterCell(lookCellKey, this.lookaheadPos) &&
        this.slots.every((s) => s.state === 'cold');

      if (!skipEmptyPerimeter) {
        let bestHotCandidate: ChunkSlot | null = null;
        let bestHotDist = Infinity;
        let deferredAnyHot = false;
        let needsPrune = false;

        for (let i = 0; i < this.slots.length; i++) {
          const slot = this.slots[i];
          const next = this.desiredState(slot, this.clampedBodyPos, this.lookaheadPos, frameStartMs);

          // Predictive P1_PREFETCH warmup while player/bicycle approaches a WARM chunk!
          if (slot.state === 'warm' && !slot.imminentPrefetched) {
            const dLook = distToRect(this.lookaheadPos, slot.effectiveRect);
            if (dLook <= this.hotEnter + 18) {
              this.prefetchSlotAssets(slot, true);
            }
          }

          if (next === slot.state) continue;

          if (next === 'hot') {
            const d = distToRect(this.clampedBodyPos, slot.effectiveRect);
            if (d < bestHotDist) {
              if (bestHotCandidate) {
                // Ensure runner-up chunk has its 2-DC WARM shell visible while awaiting next frame's HOT promotion.
                if (bestHotCandidate.state === 'cold') {
                  this.transitions++;
                  this.statsRev++;
                  this.enterWarm(bestHotCandidate, true);
                }
                deferredAnyHot = true;
              }
              bestHotDist = d;
              bestHotCandidate = slot;
            } else {
              if (slot.state === 'cold') {
                this.transitions++;
                this.statsRev++;
                this.enterWarm(slot, true);
              }
              deferredAnyHot = true;
            }
          } else if (next === 'warm') {
            this.transitions++;
            this.statsRev++;
            this.leaveHot(slot);
            this.enterWarm(slot, false);
            needsPrune = true;
          } else {
            this.transitions++;
            this.statsRev++;
            this.leaveHot(slot);
            this.leaveWarm(slot);
            slot.state = 'cold';
            slot.stateEnteredAtMs = frameStartMs;
            needsPrune = true;
          }
        }

        if (bestHotCandidate) {
          const budgetExhausted =
            mountedBuildingThisFrame ||
            this.activeHotBatchJobs > 0 ||
            nowPerfMs() - frameStartMs >= this.hotBuildBudgetMs;
          if (!budgetExhausted) {
            this.transitions++;
            this.statsRev++;
            void this.enterHot(bestHotCandidate, false);
          } else {
            // Frame budget already spent: mount lightweight WARM massing shell (0 pop) & promote on next frame!
            if (bestHotCandidate.state === 'cold') {
              this.transitions++;
              this.statsRev++;
              this.enterWarm(bestHotCandidate, true);
            }
            deferredAnyHot = true;
          }
        }

        if (needsPrune) this.prune();

        if (!deferredAnyHot && !bestHotCandidate) {
          this.lastEvalCellKey = bodyCellKey;
          this.lastLookCellKey = lookCellKey;
        } else {
          // Re-check deferred HOT promotions on the very next frame.
          this.lastEvalCellKey = Number.NaN;
        }
      } else {
        this.lastEvalCellKey = bodyCellKey;
        this.lastLookCellKey = lookCellKey;
      }
    }

    // 5. Predictive interior doorway asset prefetching when lookahead cell advances.
    if (!this.starting && lookCellKey !== this.lastInteriorPrefetchCellKey) {
      this.lastInteriorPrefetchCellKey = lookCellKey;
      this.runPredictiveInteriorPrefetch(this.clampedBodyPos, this.lookaheadPos);
    }

    // 6. Step visible HOT building doors & interior culling (zero allocations).
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot.state !== 'hot') continue;
      for (let j = 0; j < slot.hotBuildings.length; j++) {
        const b = slot.hotBuildings[j];
        if (b.group.visible) {
          b.update(dt, reduced, this.clampedBodyPos);
          const st = b.getInteriorState?.() ?? '';
          const k = buildingKey(b.building);
          if (this.lastInteriorStates.get(k) !== st) {
            this.lastInteriorStates.set(k, st);
            this.visRev++;
          }
        }
      }
    }

    // 7. Throttled 1 Hz residency distance sync & LRU housekeeping (strictly skipped while shader compilation is active!).
    if (!this.starting && getInFlightCompileCount() === 0) {
      this.residencyDistTimer += safeDt;
      if (this.residencyDistTimer >= 1.0) {
        this.residencyDistTimer = 0;
        this.syncResidencyDistances(this.clampedBodyPos);
      }
      const evicted = getEchoLifeResidencyManager().tick();
      if (evicted > 0) {
        this.evictions += evicted;
        this.statsRev++;
      }
    }
  }

  private enterWarm(slot: ChunkSlot, imminent = false) {
    if ((slot.state === 'warm' && slot.warmRoots.length > 0) || this.disposed) {
      if (imminent) this.prefetchSlotAssets(slot, true);
      return;
    }
    this.leaveWarm(slot);
    slot.state = 'warm';
    slot.stateEnteredAtMs = nowPerfMs();

    // Merge all WARM massing shells for this chunk into 1 sector (<= 2 draw calls per WARM chunk!).
    const batch = new Batch();
    const wallM = mat('paint', '#d8cfc0');
    const roofM = mat('paint', '#6e737b');
    patchMaterialWithEchoCsm(wallM);
    patchHeightFog(wallM);
    patchMaterialWithEchoCsm(roofM);
    patchHeightFog(roofM);
    const sector = this.sectorOfChunk(
      slot,
      (slot.effectiveRect.z0 + slot.effectiveRect.z1) / 2,
      (slot.effectiveRect.x0 + slot.effectiveRect.x1) / 2,
    );

    for (let i = 0; i < slot.buildings.length; i++) {
      const b = slot.buildings[i];
      const w = b.rect.x1 - b.rect.x0;
      const d = b.rect.z1 - b.rect.z0;
      const cx = (b.rect.x0 + b.rect.x1) / 2;
      const cz = (b.rect.z0 + b.rect.z1) / 2;
      const h = b.storeys === 2 ? 5.6 : 3.4;
      batch.add(wallM, w, h, d, cx, GROUND_Y + h / 2, cz);
      batch.add(roofM, w + 0.18, 0.22, d + 0.18, cx, GROUND_Y + h + 0.11, cz);
    }
    for (let i = 0; i < slot.lots.length; i++) {
      const l = slot.lots[i];
      const w = l.rect.x1 - l.rect.x0;
      const d = l.rect.z1 - l.rect.z0;
      const cx = (l.rect.x0 + l.rect.x1) / 2;
      const cz = (l.rect.z0 + l.rect.z1) / 2;
      const h = Math.max(3.6, l.storeys * 3.1);
      batch.add(wallM, w * 0.92, h, d * 0.92, cx, GROUND_Y + h / 2, cz);
      batch.add(roofM, w * 0.96, 0.2, d * 0.96, cx, GROUND_Y + h + 0.1, cz);
    }

    const meshes = batch.build(sector, false, `chunk-lod:${slot.def.id}`);
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      freezeStaticHierarchy(m);
      if (this.enclosureBuildingKey !== null) m.visible = false;
      slot.warmRoots.push(m);
      slot.warmOwned.push(m.geometry);
    }

    // Predictive WARM prefetch using pre-validated chunk asset manifest (0 Set allocs, 0 non-existent assets).
    const dLook = distToRect(this.lookaheadPos, slot.effectiveRect);
    this.prefetchSlotAssets(slot, imminent || dLook <= this.hotEnter + 18);
  }

  private leaveWarm(slot: ChunkSlot) {
    for (let i = 0; i < slot.warmRoots.length; i++) slot.warmRoots[i].removeFromParent();
    for (let i = 0; i < slot.warmOwned.length; i++) slot.warmOwned[i].dispose();
    slot.warmRoots.length = 0;
    slot.warmOwned.length = 0;
  }

  private async enterHot(slot: ChunkSlot, immediateWarmDrop: boolean): Promise<void> {
    if (this.disposed) return;
    // Keep existing WARM massing shell visible until HOT buildings AND consolidated batches finish prewarming (0 pop-in!).
    const keepWarmUntilReady =
      !immediateWarmDrop &&
      (slot.buildings.length > 0 || slot.lots.length > 0) &&
      slot.warmRoots.length > 0;
    if (!keepWarmUntilReady) this.leaveWarm(slot);
    this.leaveHot(slot);

    const gen = ++slot.gen;
    slot.state = 'hot';
    slot.stateEnteredAtMs = nowPerfMs();
    slot.hotBatchesBuilding = true;
    slot.batchesPrewarmingCount = 0;

    // 1. Queue enterable buildings for time-sliced mounting (<= 1 building per frame in `update()`).
    slot.pendingBuildings = [...slot.buildings];
    if (immediateWarmDrop && slot.pendingBuildings.length > 0) {
      // During initial bootstrap or owned-residence refresh, mount the first building immediately.
      this.drainPendingBuildings(false);
    }

    // 2. Decorative lot signboards (time-sliced on live frames if many named lots exist in one chunk).
    const signSlicer = new EchoLifeTimeSlicer(this.hotBuildBudgetMs);
    let signSliceStart = nowPerfMs();
    let builtSigns = 0;
    for (let li = 0; li < slot.lots.length; li++) {
      const l = slot.lots[li];
      if (!l.name) continue;
      if (builtSigns > 0 && !immediateWarmDrop && nowPerfMs() - signSliceStart >= this.hotBuildBudgetMs) {
        await signSlicer.yieldFrame();
        if (this.disposed || slot.gen !== gen) return;
        signSliceStart = nowPerfMs();
      }
      const cx = (l.rect.x0 + l.rect.x1) / 2;
      const edge = l.facing === 'north' ? l.rect.z0 - 0.05 : l.rect.z1 + 0.05;
      const w = Math.min(5, l.rect.x1 - l.rect.x0 - 1);
      const h = 0.7;
      const bg = l.use === 'gaming' ? '#3b2156' : l.use === 'market' ? '#1f5135' : '#24405a';
      const tex = textBoard([l.name.en], w, h, bg);
      const m = new T.MeshStandardMaterial({
        map: tex,
        roughness: 0.55,
        emissive: '#ffffff',
        emissiveMap: tex,
        emissiveIntensity: 0.14,
      });
      const g = new T.PlaneGeometry(w, h);
      const mesh = new T.Mesh(g, m);
      mesh.position.set(cx, GROUND_Y + 3.3, edge);
      mesh.rotation.y = l.facing === 'north' ? Math.PI : 0;
      this.sectorOf(edge, cx).add(mesh);
      freezeStaticHierarchy(mesh);
      if (this.enclosureBuildingKey !== null) mesh.visible = false;
      slot.hotRoots.push(mesh);
      slot.hotOwned.push(tex, m, g);
      builtSigns++;
    }

    // 3. Collect required legacy lots/landmarks AND A08 Poly Haven CC0 streetscape props (excluding all trees!).
    type SectorMatrices = { north: T.Matrix4[]; south: T.Matrix4[]; sides: T.Matrix4[] };
    const wantLegacy = new Map<LifeAsset, SectorMatrices>();
    const pushSectorMat = <TKey>(map: Map<TKey, SectorMatrices>, key: TKey, sector: T.Group, m: T.Matrix4) => {
      let bucket = map.get(key);
      if (!bucket) {
        bucket = { north: [], south: [], sides: [] };
        map.set(key, bucket);
      }
      if (sector === this.sectors.north) bucket.north.push(m);
      else if (sector === this.sectors.south) bucket.south.push(m);
      else bucket.sides.push(m);
    };

    const legacyIds = new Set<LifeAsset>();
    const streetKeys = new Set<StreetPropKey>();
    const streetPlacements: { pr: Prop; key: StreetPropKey; scale: number; isLamp: boolean; lampHeight: number }[] = [];

    const residences = new Map<string, EnterableBuilding>();
    for (let i = 0; i < slot.buildings.length; i++) {
      const b = slot.buildings[i];
      if (b.property) residences.set(b.property.lot, b);
    }
    const lots = this.filterHalfLots
      ? slot.lots.filter((l, i) => residences.has(l.id) || l.id.startsWith('home') || l.name || i % 2 === 0)
      : slot.lots;

    const lotPick = new Map<string, LifeAsset>();
    for (let i = 0; i < lots.length; i++) {
      const l = lots[i];
      const optsList = LOT_ASSETS[l.use];
      const residenceModel = residences.get(l.id)?.property?.model as LifeAsset | undefined;
      const base =
        residenceModel ??
        optsList[Math.floor(hash01((i + l.rect.x0) | 0, 71) * optsList.length)];
      const allowFull =
        Boolean(residenceModel) ||
        (!l.id.startsWith('south-fringe-') && this.useFullLotGlbs === 'all' && !LOD_PAIR[base]);
      const id = !allowFull && LOD_PAIR[base] ? LOD_PAIR[base]! : base;
      if (!(id in LIFE_ASSETS)) continue;
      lotPick.set(l.id, id);
      legacyIds.add(id);
    }

    const legacyPropPick: { pr: Prop; id: LifeAsset }[] = [];
    for (let i = 0; i < slot.props.length; i++) {
      const pr = slot.props[i];
      // Skip ALL legacy toy trees — `VegetationSystem` in `world.ts` renders our 22-species botanical library!
      if (pr.kind === 'tree' || (pr.kind === 'asset' && pr.asset?.startsWith('tree-'))) continue;

      const streetRep = streetPropReplacement(pr);
      if (streetRep) {
        if (!(streetRep.key in STREET_PROPS)) continue;
        if (this.quality === 'low' && LOW_TIER_SKIP_STREET_PROPS.has(streetRep.key)) continue;
        streetKeys.add(streetRep.key);
        streetPlacements.push({ pr, ...streetRep });
        continue;
      }

      if (pr.kind === 'asset' && pr.asset) {
        if (!(pr.asset in LIFE_ASSETS)) continue;
        const id = pr.asset as LifeAsset;
        legacyPropPick.push({ pr, id });
        legacyIds.add(id);
      } else {
        const optsList = legacyPropAssets(pr.kind);
        if (!optsList.length) continue;
        const id = optsList[Math.floor(hash01(Math.round(pr.x * 10), Math.round(pr.z * 10)) * optsList.length)];
        if (!(id in LIFE_ASSETS)) continue;
        legacyPropPick.push({ pr, id });
        legacyIds.add(id);
      }
    }

    const scheduler = getEchoLifeLoadScheduler();
    const acquiredList = [...legacyIds];
    for (let i = 0; i < acquiredList.length; i++) {
      const id = acquiredList[i];
      slot.hotAssets.push(id);
      scheduler.hintPriority(`life-asset:${id}`, LoadPriority.P0_IMMINENT);
    }
    const acquiredStreetKeys = [...streetKeys];
    for (let i = 0; i < acquiredStreetKeys.length; i++) {
      const key = acquiredStreetKeys[i];
      slot.hotStreetProps.push(key);
      scheduler.hintPriority(`street-prop:${key}`, LoadPriority.P0_IMMINENT);
    }

    const loadedLegacy = new Map<LifeAsset, Prepared | null>();
    const loadedStreet = new Map<StreetPropKey, PreparedStreetProp | null>();

    await Promise.all([
      ...acquiredList.map(async (id) => { loadedLegacy.set(id, await acquireLifeAsset(id)); }),
      ...acquiredStreetKeys.map(async (key) => { loadedStreet.set(key, await acquireStreetProp(key)); }),
    ]);

    if (this.disposed || slot.gen !== gen) return;

    // Serialize post-fetch batch assembly across concurrent chunk promotions so two chunks NEVER run
    // `buildConsolidatedBatches` synchronously on the exact same animation frame!
    const runBatchAssembly = async (): Promise<void> => {
      if (this.disposed || slot.gen !== gen) return;
      this.activeHotBatchJobs++;
      try {
        // 4. Compute placement matrices for decorative lots & residences (single-pass sector bucketing).
        for (let i = 0; i < lots.length; i++) {
          const l = lots[i];
          const id = lotPick.get(l.id);
          if (!id) continue;
          const p = loadedLegacy.get(id);
          if (!p) continue;
          const size = p.box.getSize(V3_A);
          const home = residences.get(l.id);
          if (home) {
            const width = l.rect.x1 + 4 - home.rect.x1;
            const depth = l.rect.z1 - l.rect.z0;
            const scale = Math.min(width / size.x, depth / size.z);
            pushSectorMat(
              wantLegacy,
              id,
              this.sectorOf(l.rect.z0, home.entryPoint.x),
              placeOn(p, home.rect.x1 + (size.x * scale) / 2, GROUND_Y, l.rect.z0 + (size.z * scale) / 2, Math.PI, scale),
            );
            continue;
          }
          const across = l.facing === 'north' || l.facing === 'south';
          const W = across ? l.rect.x1 - l.rect.x0 : l.rect.z1 - l.rect.z0;
          const D = across ? l.rect.z1 - l.rect.z0 : l.rect.x1 - l.rect.x0;
          const s = Math.min(1.35, Math.max(0.55, Math.min((W * 0.98) / Math.max(size.x, 1e-3), (D * 0.98) / Math.max(size.z, 1e-3))));
          const depth = size.z * s;
          const cx = (l.rect.x0 + l.rect.x1) / 2;
          const cz = (l.rect.z0 + l.rect.z1) / 2;
          const x = across ? cx : l.facing === 'east' ? l.rect.x1 - depth / 2 : l.rect.x0 + depth / 2;
          const z = !across ? cz : l.facing === 'south' ? l.rect.z1 - depth / 2 : l.rect.z0 + depth / 2;
          pushSectorMat(wantLegacy, id, this.sectorOfChunk(slot, z, x), placeOn(p, x, GROUND_Y, z, FACING[l.facing], s));
        }

        // 5. Compute placement matrices for non-replaced legacy district props/landmarks.
        for (let i = 0; i < legacyPropPick.length; i++) {
          const { pr, id } = legacyPropPick[i];
          const p = loadedLegacy.get(id);
          if (!p) continue;
          const size = p.box.getSize(V3_A);
          let s = 1;
          if (pr.kind === 'asset') {
            const by = pr.scaleBy ?? 'h';
            const val = pr.scaleVal ?? 2;
            s = by === 'h' ? val / Math.max(size.y, 1e-3) : val / Math.max(size.x, size.z, 1e-3);
          } else {
            const target = LEGACY_PROP_SCALE[pr.kind];
            if (target) {
              s = target.by === 'h' ? target.v / Math.max(size.y, 1e-3) : target.v / Math.max(size.x, size.z, 1e-3);
            }
          }
          pushSectorMat(wantLegacy, id, this.sectorOfChunk(slot, pr.z, pr.x), placeOn(p, pr.x, GROUND_Y, pr.z, pr.rotY, s));
        }

        // 6. Consolidate legacy lots/landmarks AND Poly Haven CC0 streetscape props into `THREE.BatchedMesh` pools.
        const shadowCfg = getRenderConfig(this.quality).shadow;
        const heroShadows = this.quality === 'high' || this.quality === 'ultra';
        const sectorBatches = new Map<T.Group, ConsolidatedBatchItem[]>();
        const pushBatchItem = (sector: T.Group, item: ConsolidatedBatchItem) => {
          let arr = sectorBatches.get(sector);
          if (!arr) { arr = []; sectorBatches.set(sector, arr); }
          arr.push(item);
        };
        const sectorEntries: readonly [T.Group, keyof SectorMatrices][] = [
          [this.sectors.north, 'north'],
          [this.sectors.south, 'south'],
          [this.sectors.sides, 'sides'],
        ];

        for (const [id, buckets] of wantLegacy) {
          const p = loadedLegacy.get(id);
          if (!p) continue;
          const isBld = id.startsWith('bld-') || id.startsWith('res_');
          const isBackdropTower = id.startsWith('bld-urban-facade');
          const cast = isBld
            ? !isBackdropTower && (shadowCfg.castAllLots || (this.quality === 'high' && !!slot.def.core))
            : heroShadows && (id === 'park-gazebo' || id === 'hoop-post' || id === 'campus-gate' || id === 'fountain-tiered');
          const recv = isBld || cast;
          for (let si = 0; si < sectorEntries.length; si++) {
            const [sector, keyName] = sectorEntries[si];
            const mats = buckets[keyName];
            if (!mats.length) continue;
            for (let pi = 0; pi < p.parts.length; pi++) {
              const part = p.parts[pi];
              pushBatchItem(sector, {
                assetId: id,
                geometry: part.geometry,
                material: part.material,
                matrices: mats,
                castShadow: cast && part.role !== 'glass',
                receiveShadow: recv,
                role: part.role,
              });
            }
          }
        }

        // 7. Pack Poly Haven CC0 streetscape props + night lantern glow!
        const wantStreet = new Map<StreetPropKey, SectorMatrices>();
        const lampGlobeMats: { sector: T.Group; x: number; y: number; z: number }[] = [];

        for (let i = 0; i < streetPlacements.length; i++) {
          const sp = streetPlacements[i];
          const prepared = loadedStreet.get(sp.key);
          if (!prepared) continue;
          const sector = this.sectorOfChunk(slot, sp.pr.z, sp.pr.x);
          pushSectorMat(
            wantStreet,
            sp.key,
            sector,
            placeStreetPropOn(sp.pr.x, GROUND_Y, sp.pr.z, sp.pr.rotY, sp.scale, new T.Matrix4(), sp.key),
          );

          if (sp.isLamp) {
            const globeY = GROUND_Y + sp.lampHeight * 0.89;
            slot.lampPositions.push(new T.Vector3(sp.pr.x, globeY, sp.pr.z));
            lampGlobeMats.push({ sector, x: sp.pr.x, y: globeY, z: sp.pr.z });
          }
        }

        for (const [key, buckets] of wantStreet) {
          const prepared = loadedStreet.get(key);
          if (!prepared) continue;
          const cast = heroShadows && (key === 'streetlamp' || key === 'bench' || key === 'pergolaVine' || key === 'busShelter' || key === 'cafePatio');
          for (let si = 0; si < sectorEntries.length; si++) {
            const [sector, keyName] = sectorEntries[si];
            const mats = buckets[keyName];
            if (!mats.length) continue;
            for (let pi = 0; pi < prepared.parts.length; pi++) {
              const part = prepared.parts[pi];
              pushBatchItem(sector, {
                assetId: `street:${key}`,
                geometry: part.geometry,
                material: part.material,
                matrices: mats,
                castShadow: cast,
                receiveShadow: true,
              });
            }
          }
        }

        // Time-slice mounting of consolidated BatchedMesh groups + off-stage `compileAsync` prewarm before reveal!
        const mountSlicer = new EchoLifeTimeSlicer(this.hotBuildBudgetMs);
        let mountStart = nowPerfMs();
        const shouldPrewarm = Boolean(this.prewarmObject);
        let mountedBatches = 0;
        for (const [sector, batchItems] of sectorBatches) {
          if (this.disposed || slot.gen !== gen) return;
          if (mountedBatches > 0 && !immediateWarmDrop && nowPerfMs() - mountStart >= this.hotBuildBudgetMs) {
            await mountSlicer.yieldFrame();
            if (this.disposed || slot.gen !== gen) return;
            mountStart = nowPerfMs();
          }
          const batchGroup = buildConsolidatedBatches(batchItems, `chunk-batch:${slot.def.id}:${sector.name}`);
          sector.add(batchGroup);
          freezeStaticHierarchy(batchGroup);
          slot.hotRoots.push(batchGroup);
          mountedBatches++;

          if (shouldPrewarm) {
            const prewarmRes = this.prewarmObject!(batchGroup, 'background');
            if (prewarmRes && typeof (prewarmRes as Promise<void>).then === 'function') {
              batchGroup.userData.prewarming = true;
              batchGroup.visible = false;
              slot.batchesPrewarmingCount++;
              const prewarmJob = Promise.resolve(prewarmRes)
                .catch(() => undefined)
                .finally(() => {
                  if (this.disposed || slot.gen !== gen) return;
                  delete batchGroup.userData.prewarming;
                  slot.batchesPrewarmingCount = Math.max(0, slot.batchesPrewarmingCount - 1);
                  this.maybeReleaseWarmShell(slot);
                  this.applyVisibilityState();
                });
              if (this.starting) this.bootstrapPrewarms.push(prewarmJob);
            }
          }
        }

        // 1-draw-call instanced night lantern globe glow across all streetlamps in this chunk (0 DCs in daylight).
        if (lampGlobeMats.length > 0) {
          const glowMesh = new T.InstancedMesh(this.lampGlowGeo, this.lampGlowMat, lampGlobeMats.length);
          glowMesh.name = `streetlamp-glow:${slot.def.id}`;
          glowMesh.castShadow = false;
          glowMesh.receiveShadow = false;
          Q_A.identity();
          V3_B.set(1, 1, 1);
          for (let i = 0; i < lampGlobeMats.length; i++) {
            const lg = lampGlobeMats[i];
            M4_A.compose(V3_A.set(lg.x, lg.y, lg.z), Q_A, V3_B);
            glowMesh.setMatrixAt(i, M4_A);
          }
          glowMesh.instanceMatrix.needsUpdate = true;
          glowMesh.computeBoundingSphere();
          const targetSector = this.sectorOfChunk(
            slot,
            (slot.effectiveRect.z0 + slot.effectiveRect.z1) / 2,
            (slot.effectiveRect.x0 + slot.effectiveRect.x1) / 2,
          );
          targetSector.add(glowMesh);
          freezeStaticHierarchy(glowMesh);
          slot.lampGlowMesh = glowMesh;
          slot.hotRoots.push(glowMesh);
        }

        slot.hotBatchesBuilding = false;
        this.mountedBuildRev++;
        this.maybeReleaseWarmShell(slot);
        this.applyVisibilityState();
        this.statsRev++;

        if (!immediateWarmDrop) {
          await mountSlicer.yieldFrame();
        }
      } finally {
        this.activeHotBatchJobs = Math.max(0, this.activeHotBatchJobs - 1);
      }
    };

    if (immediateWarmDrop) {
      await runBatchAssembly();
    } else {
      const nextSerial = this.hotBatchSerialChain.then(runBatchAssembly, runBatchAssembly);
      this.hotBatchSerialChain = nextSerial.catch(() => undefined);
      await nextSerial;
    }
  }

  private leaveHot(slot: ChunkSlot) {
    const hadSolids = slot.mountedSolidKeys.size > 0 || slot.hotBuildings.length > 0 || slot.pendingBuildings.length > 0;
    const hadMountedBuildings = slot.hotBuildings.length > 0 || slot.lampPositions.length > 0;
    slot.gen++;
    slot.pendingBuildings.length = 0;
    slot.prewarmingCount = 0;
    slot.hotBatchesBuilding = false;
    slot.batchesPrewarmingCount = 0;
    slot.lampPositions.length = 0;
    slot.lampGlowMesh = null;

    for (let i = 0; i < slot.hotBuildings.length; i++) slot.hotBuildings[i].dispose();
    slot.hotBuildings.length = 0;
    if (hadMountedBuildings) this.mountedBuildRev++;

    for (let i = 0; i < slot.hotRoots.length; i++) {
      const r = slot.hotRoots[i];
      r.traverse((o) => {
        if (o instanceof T.InstancedMesh || (typeof T.BatchedMesh === 'function' && o instanceof T.BatchedMesh)) {
          o.dispose();
        }
      });
      r.removeFromParent();
    }
    slot.hotRoots.length = 0;

    for (let i = 0; i < slot.hotOwned.length; i++) slot.hotOwned[i].dispose();
    slot.hotOwned.length = 0;

    const dNow = distToRect(this.clampedBodyPos, slot.effectiveRect);
    const residency = getEchoLifeResidencyManager();
    for (let i = 0; i < slot.hotAssets.length; i++) {
      const id = slot.hotAssets[i];
      residency.updateDistance(`life-asset:${id}`, dNow);
      releaseLifeAsset(id);
    }
    slot.hotAssets.length = 0;

    for (let i = 0; i < slot.hotStreetProps.length; i++) {
      const key = slot.hotStreetProps[i];
      residency.updateDistance(`street-prop:${key}`, dNow);
      releaseStreetProp(key);
    }
    slot.hotStreetProps.length = 0;

    if (hadSolids) {
      this.solidsRev++;
      if (this.onChunkSolidsChanged) {
        for (const key of slot.mountedSolidKeys) this.onChunkSolidsChanged(key, []);
        this.onChunkSolidsChanged(`chunk:${slot.def.id}`, []);
      }
      slot.mountedSolidKeys.clear();
    }

    if (!this.disposed && !this.starting && getInFlightCompileCount() === 0) {
      const evicted = residency.evictIfNeeded();
      if (evicted > 0) this.evictions += evicted;
    }
  }

  private prune() {
    if (this.disposed || this.starting || getInFlightCompileCount() > 0) return;
    // Delegate GPU LRU eviction cleanly to `EchoLifeResidencyManager` (preserves 35 s / 45 s warm retention
    // windows so chunk boundary crossings & doorway exits NEVER thrash textures or compile mid-flight!).
    const evicted = getEchoLifeResidencyManager().evictIfNeeded();
    if (evicted > 0) {
      this.evictions += evicted;
      this.statsRev++;
    }
  }

  doors(): LifeDoor[] {
    if (this.cachedDoorsRev === this.mountedBuildRev) return this.cachedDoors;
    this.cachedDoorsRev = this.mountedBuildRev;
    const out = this.cachedDoors;
    out.length = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.state !== 'hot') continue;
      for (let j = 0; j < s.hotBuildings.length; j++) out.push(s.hotBuildings[j].door);
    }
    return out;
  }

  door(id: string): LifeDoor | null {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.state !== 'hot') continue;
      for (let j = 0; j < s.hotBuildings.length; j++) {
        const b = s.hotBuildings[j];
        if (b.door.id === id) return b.door;
      }
    }
    return null;
  }

  solids(): SolidBox[] {
    const out: SolidBox[] = [];
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.state !== 'hot') continue;
      for (let j = 0; j < s.hotBuildings.length; j++) out.push(...s.hotBuildings[j].solids);
    }
    return out;
  }

  /** Per-building physics solid buckets (`bld:<chunk>:<bld>`) for O(1) incremental `physics.setWorldSolidBucket()`. */
  solidBuckets(): Map<string, SolidBox[]> {
    const map = new Map<string, SolidBox[]>();
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.state !== 'hot' || s.hotBuildings.length === 0) continue;
      for (let j = 0; j < s.hotBuildings.length; j++) {
        const b = s.hotBuildings[j];
        map.set(this.buildingBucketKey(s, b.building), b.solids);
      }
    }
    return map;
  }

  fixtures(): { at: T.Vector3; room: string; warm: boolean }[] {
    if (this.cachedFixturesBuildRev === this.mountedBuildRev && this.cachedFixturesVisRev === this.visRev) {
      return this.cachedFixtures;
    }
    this.cachedFixturesBuildRev = this.mountedBuildRev;
    this.cachedFixturesVisRev = this.visRev;
    const out = this.cachedFixtures;
    out.length = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.state !== 'hot') continue;
      for (let j = 0; j < s.hotBuildings.length; j++) {
        const b = s.hotBuildings[j];
        if (b.group.visible) {
          for (let k = 0; k < b.fixtures.length; k++) out.push(b.fixtures[k]);
        }
      }
    }
    return out;
  }

  roots(): T.Object3D[] {
    if (this.cachedRootsBuildRev === this.mountedBuildRev && this.cachedRootsVisRev === this.visRev) {
      return this.cachedRoots;
    }
    this.cachedRootsBuildRev = this.mountedBuildRev;
    this.cachedRootsVisRev = this.visRev;
    const out = this.cachedRoots;
    out.length = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.state !== 'hot') continue;
      for (let j = 0; j < s.hotBuildings.length; j++) {
        const b = s.hotBuildings[j];
        if (b.group.visible) out.push(b.group);
      }
    }
    return out;
  }

  blockers(): T.Object3D[] {
    if (this.cachedBlockersBuildRev === this.mountedBuildRev && this.cachedBlockersVisRev === this.visRev) {
      return this.cachedBlockers;
    }
    this.cachedBlockersBuildRev = this.mountedBuildRev;
    this.cachedBlockersVisRev = this.visRev;
    const out = this.cachedBlockers;
    out.length = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.state !== 'hot') continue;
      for (let j = 0; j < s.hotBuildings.length; j++) {
        const b = s.hotBuildings[j];
        if (b.group.visible) {
          for (let k = 0; k < b.blockers.length; k++) out.push(b.blockers[k]);
        }
      }
    }
    return out;
  }

  stats(): StreamingStats {
    const hot: string[] = [];
    const warm: string[] = [];
    const cold: string[] = [];
    let activeDoors = 0;
    let activeSolids = 0;
    for (const s of this.slots) {
      if (s.state === 'hot') {
        hot.push(s.def.id);
        activeDoors += s.hotBuildings.length;
        for (const b of s.hotBuildings) activeSolids += b.solids.length;
      } else if (s.state === 'warm') warm.push(s.def.id);
      else cold.push(s.def.id);
    }
    const assets = lifeAssetStats();
    return {
      hot,
      warm,
      cold,
      activeDoors,
      activeSolids,
      transitions: this.transitions,
      assetsCached: assets.cached,
      assetsReferenced: assets.referenced,
      evictions: this.evictions,
    };
  }

  dispose() {
    this.disposed = true;
    getEchoLifeTextureUploadQueue().setLivePacing(false);
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      this.leaveHot(slot);
      this.leaveWarm(slot);
      slot.state = 'cold';
    }
    this.cachedDoors.length = 0;
    this.cachedFixtures.length = 0;
    this.cachedRoots.length = 0;
    this.cachedBlockers.length = 0;
    this.lampNearOut.length = 0;
    this.memoizedEmptyCells.clear();
    this.prefetchedInteriors.clear();
    this.cachedRootScene = null;
    this.cachedSceneCamera = null;
    this.lampGlowGeo.dispose();
    this.lampGlowMat.dispose();
    this.group.removeFromParent();
  }
}

// Keep unused scratch import cleanly referenced for future chunk-level matrix transforms.
void V3_C;
