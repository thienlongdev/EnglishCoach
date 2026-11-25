import type { QualityTier } from './renderConfig';
import type { HdriEnvKey, PbrSurfaceKey } from './pbrAtlas';
import type { StreetPropKey } from './streetPropsManifest';
import type { LifeAsset } from './assets';
import {
  BOOT_STAGE_LABELS_VI,
  BOOT_STAGE_ORDER,
  type BootProgressSnapshot,
  type BootWorkProgress,
  type EchoLifeBootGate,
  type EchoLifeBootStageId,
  type EchoLifeBootStatus,
} from '../../echoLife/echoLifeBootStages';
import {
  EchoLifeTimeSlicer,
  isDocumentHidden,
  waitUntilDocumentVisible,
} from './loadScheduler';
import { getEchoLifeResidencyManager, type EchoLifeResidencyManager } from './residencyManager';

/**
 * Echo Life — Declarative Preload Manifest & Truthful Two-Gate (`G0_room` / `G1_world`) Boot Orchestrator.
 *
 * Hardened against every `@perf-stream-reviewer` deadlock & truthfulness failure mode (P0-1..P0-5):
 * - **Zero blind wall-clock cutoffs:** Uses `noProgressVisibleMs`, which ticks ONLY while
 *   `!document.hidden && !isHeld()` and resets whenever completed work units advance.
 *   - At `20 s` without visible progress: surfaces live `n/m` Vietnamese notice (`"Vẫn đang tải..."`).
 *   - At `60 s` without visible progress: transitions to `status: 'slow'` offering explicit user
 *     choices (`Tiếp tục chờ` / `Vào ngay (có thể giật)` / `Chuyển sang chế độ Đồ họa nhẹ`).
 *   - NEVER force-dismisses to `done: true` automatically; explicit `enterAnyway()` cleanly aborts
 *     and waits for the active stage runner to settle, emitting `done: true, complete: false` so
 *     callers NEVER write `ec_echo_life_warmed_v1` for an incomplete warmup!
 * - **Two-Gate Architecture (`G0_room` & `G1_world`):**
 *   - `G0_room`: Always runs (room + character unless `characterVisible === false` + room shaders).
 *     Unlocks Overview mode cleanly with zero deadlock.
 *   - `G1_world`: Runs at boot when saved view is Explore, OR in `transitionMode: true` on first
 *     Explore click from Overview!
 * - **Hidden-tab GPU pause & context-loss abort:** GPU stages pause on `document.hidden` and resume
 *   on `visibilitychange`; `abortForContextLoss()` immediately breaks every pending await cleanly.
 * - **Boot residency lockdown:** Automatically enables `residencyManager.setBootActive(true)` for the
 *   duration of the gate and releases boot pins only once the gate finishes or aborts.
 */

export {
  BOOT_STAGE_LABELS_VI,
  BOOT_STAGE_ORDER,
  type BootProgressSnapshot,
  type BootWorkProgress,
  type EchoLifeBootGate,
  type EchoLifeBootStageId,
  type EchoLifeBootStatus,
};

export interface BootStageTiming {
  readonly stageId: EchoLifeBootStageId;
  readonly durationMs: number;
  readonly completed: boolean;
}

export interface BootTelemetryReport {
  readonly gate: EchoLifeBootGate;
  readonly transitionMode: boolean;
  readonly tier: QualityTier;
  readonly mode: 'explore' | 'overview';
  readonly totalMs: number;
  readonly stages: readonly BootStageTiming[];
  readonly failedAssets: readonly string[];
  readonly yields: number;
  readonly aborted: boolean;
  /** True ONLY when every required stage completed cleanly (safe to call `markEchoLifeWarmed()`). */
  readonly complete: boolean;
  /** True when user may enter (either `complete === true` or explicit `enterAnyway()`). */
  readonly succeeded: boolean;
  readonly bypassedByUser: boolean;
}

export interface InteriorPrefetchSpec {
  readonly buildingId: string;
  readonly streetProps: readonly StreetPropKey[];
  readonly lifeAssets?: readonly LifeAsset[];
  readonly prefetchRadiusM: number;
  readonly lookaheadRadiusM: number;
  readonly evictRadiusM: number;
  readonly minRetentionSec: number;
}

export interface PreloadManifest {
  readonly tier: QualityTier;
  readonly mode: 'explore' | 'overview';
  readonly corePbrSurfaces: readonly PbrSurfaceKey[];
  readonly coreHdriKeys: readonly HdriEnvKey[];
  readonly houseAndHomeCoreStreetProps: readonly StreetPropKey[];
  readonly houseCoreLifeAssets: readonly LifeAsset[];
  readonly animationPackUrls: readonly string[];
  readonly parkedVehicleUrls: readonly string[];
  readonly preloadNpcCount: number;
  readonly preloadVegetationSpeciesCount: number;
  readonly maxTextureUploadsPerBootFrame: number;
  readonly interiorPrefetchSpecs: readonly InteriorPrefetchSpec[];
}

const CORE_PBR_LOW: readonly PbrSurfaceKey[] = Object.freeze([
  'asphalt',
  'pavers',
  'concrete',
  'grass_ground',
  'stucco_white',
  'wall_beige',
  'oak_wood',
  'parquet',
  'tiles_floor',
]);

const CORE_PBR_BALANCED: readonly PbrSurfaceKey[] = Object.freeze([
  ...CORE_PBR_LOW,
  'red_brick',
  'roof_tiles',
  'terrazzo',
  'cobblestone',
  'stone_wall',
  'linen',
]);

const CORE_PBR_HIGH: readonly PbrSurfaceKey[] = Object.freeze([
  ...CORE_PBR_BALANCED,
  'asphalt_clean',
  'park_dirt',
  'walnut_wood',
  'parquet_rect',
  'cotton',
]);

const HOME_CORE_STREET_PROPS_BASE: readonly StreetPropKey[] = Object.freeze([
  'libRugWoven',
  'streetlamp',
  'bench',
  'trashbin',
  'pottedPlant',
]);

const HOME_CORE_STREET_PROPS_RICH: readonly StreetPropKey[] = Object.freeze([
  ...HOME_CORE_STREET_PROPS_BASE,
  'hydrant',
  'manhole',
  'planterLush',
  'awningStriped',
  'hedgeTrimmed',
]);

const HOUSE_CORE_LIFE_ASSETS: readonly LifeAsset[] = Object.freeze([
  'sofa',
  'table',
  'chair',
  'bed-single',
  'fridge',
  'stove',
  'sink',
  'wardrobe',
]);

const CORE_ANIMATION_URLS: readonly string[] = Object.freeze([
  '/echo-life/animations/all48-47eccef24467.glb',
  '/assets/study-space/study-dances-13e98fbf0efb.glb',
  '/assets/study-space/study-postures-48d6fc4919fb.glb',
]);

const PARKED_VEHICLE_URLS: readonly string[] = Object.freeze([
  '/echo-life/aaa-v2/vehicles/parked_sedan_aaa-406a1236dbd2.glb',
  '/echo-life/aaa-v2/vehicles/parked_hatch_aaa-9c73b7227eba.glb',
]);

const freezeProps = <T extends readonly StreetPropKey[]>(list: T): readonly StreetPropKey[] =>
  Object.freeze(list);

const freezeAssets = <T extends readonly LifeAsset[]>(list: T): readonly LifeAsset[] =>
  Object.freeze(list);

/**
 * Predictive proximity + velocity/door-cone prefetch manifest for all 13 enterable city buildings.
 * Shared hysteresis (`28 m` proximity / `34 m` door-cone -> `48 m` eviction + `45 s` idle retention)
 * prevents doorway freezing AND enter/exit thrashing.
 */
export const INTERIOR_PREFETCH_SPECS: readonly InteriorPrefetchSpec[] = Object.freeze([
  Object.freeze({
    buildingId: 'library',
    streetProps: freezeProps([
      'libBookstackTall',
      'libReadingChair',
      'libArmchair',
      'libRugWoven',
      'libBankerLamp',
      'libCeilingPendant',
      'libPottedPlant',
    ]),
    lifeAssets: freezeAssets(['library-table', 'library-stack', 'library-desk', 'library-trolley']),
    prefetchRadiusM: 28,
    lookaheadRadiusM: 34,
    evictRadiusM: 48,
    minRetentionSec: 45,
  }),
  Object.freeze({
    buildingId: 'cafe',
    streetProps: freezeProps(['cafeCoffeeCart', 'cafeBistroSet', 'libPottedPlant']),
    lifeAssets: freezeAssets(['cafe-booth', 'espresso', 'patisserie-case', 'table', 'chair']),
    prefetchRadiusM: 28,
    lookaheadRadiusM: 34,
    evictRadiusM: 48,
    minRetentionSec: 45,
  }),
  Object.freeze({
    buildingId: 'bistro',
    streetProps: freezeProps(['shopCashRegister', 'libRugWoven', 'cafeBistroSet']),
    lifeAssets: freezeAssets(['cafe-booth', 'table', 'chair', 'tea-service']),
    prefetchRadiusM: 28,
    lookaheadRadiusM: 34,
    evictRadiusM: 48,
    minRetentionSec: 45,
  }),
  Object.freeze({
    buildingId: 'market',
    streetProps: freezeProps(['shopCashRegister', 'libPottedPlant']),
    lifeAssets: freezeAssets(['market-shelf', 'market-checkout', 'fridge']),
    prefetchRadiusM: 28,
    lookaheadRadiusM: 34,
    evictRadiusM: 48,
    minRetentionSec: 45,
  }),
  Object.freeze({
    buildingId: 'furniture_shop',
    streetProps: freezeProps(['libPottedPlant', 'libRugWoven', 'libArmchair']),
    lifeAssets: freezeAssets(['sofa', 'canopy-bed', 'kitchen-island', 'display-cabinet', 'table']),
    prefetchRadiusM: 26,
    lookaheadRadiusM: 32,
    evictRadiusM: 46,
    minRetentionSec: 45,
  }),
  Object.freeze({
    buildingId: 'clothing_shop',
    streetProps: freezeProps(['libPottedPlant', 'libRugWoven']),
    lifeAssets: freezeAssets(['garment-rack', 'mirror', 'display-cabinet', 'bench-cushion']),
    prefetchRadiusM: 26,
    lookaheadRadiusM: 32,
    evictRadiusM: 46,
    minRetentionSec: 45,
  }),
  Object.freeze({
    buildingId: 'electronics_shop',
    streetProps: freezeProps(['shopCashRegister', 'libPottedPlant']),
    lifeAssets: freezeAssets(['gaming-monitor', 'gaming-pc', 'gaming-desk', 'photocopier', 'display-cabinet']),
    prefetchRadiusM: 26,
    lookaheadRadiusM: 32,
    evictRadiusM: 46,
    minRetentionSec: 45,
  }),
  Object.freeze({
    buildingId: 'vehicle_dealer',
    streetProps: freezeProps(['libPottedPlant']),
    lifeAssets: freezeAssets(['car-spider', 'moto-commuter', 'scooter-ev', 'bicycle']),
    prefetchRadiusM: 26,
    lookaheadRadiusM: 32,
    evictRadiusM: 46,
    minRetentionSec: 45,
  }),
  Object.freeze({
    buildingId: 'home_center',
    streetProps: freezeProps(['shopCashRegister', 'libPottedPlant']),
    lifeAssets: freezeAssets(['workbench', 'soaking-tub', 'sink', 'stove', 'market-shelf']),
    prefetchRadiusM: 26,
    lookaheadRadiusM: 32,
    evictRadiusM: 46,
    minRetentionSec: 45,
  }),
  Object.freeze({
    buildingId: 'repair_shop',
    streetProps: freezeProps(['shopCashRegister']),
    lifeAssets: freezeAssets(['workbench', 'bicycle', 'scooter-ev']),
    prefetchRadiusM: 25,
    lookaheadRadiusM: 31,
    evictRadiusM: 45,
    minRetentionSec: 45,
  }),
  Object.freeze({
    buildingId: 'atelier',
    streetProps: freezeProps(['libRugWoven', 'libPottedPlant']),
    lifeAssets: freezeAssets(['art-easel', 'guitar-acoustic', 'guitar-electric', 'workbench']),
    prefetchRadiusM: 25,
    lookaheadRadiusM: 31,
    evictRadiusM: 45,
    minRetentionSec: 45,
  }),
  Object.freeze({
    buildingId: 'linh',
    streetProps: freezeProps(['libRugWoven', 'libPottedPlant']),
    lifeAssets: freezeAssets(['sofa', 'table', 'chair', 'bed-single']),
    prefetchRadiusM: 24,
    lookaheadRadiusM: 30,
    evictRadiusM: 45,
    minRetentionSec: 45,
  }),
  Object.freeze({
    buildingId: 'minh',
    streetProps: freezeProps(['libRugWoven', 'libPottedPlant']),
    lifeAssets: freezeAssets(['sofa', 'gaming-desk', 'gaming-chair', 'bed-single']),
    prefetchRadiusM: 24,
    lookaheadRadiusM: 30,
    evictRadiusM: 45,
    minRetentionSec: 45,
  }),
]);

const INTERIOR_PREFETCH_BY_ID: ReadonlyMap<string, InteriorPrefetchSpec> = new Map(
  INTERIOR_PREFETCH_SPECS.map((spec) => [spec.buildingId, spec]),
);

/** O(1) zero-allocation lookup for an enterable building's predictive prefetch specification. */
export function getInteriorPrefetchSpec(buildingId: string): InteriorPrefetchSpec | undefined {
  return INTERIOR_PREFETCH_BY_ID.get(buildingId);
}

export function buildPreloadManifest(
  tier: QualityTier,
  opts: {
    mode?: 'explore' | 'overview';
    activeOutdoorHdri?: HdriEnvKey;
  } = {},
): PreloadManifest {
  const mode = opts.mode ?? 'explore';
  const activeOutdoor = opts.activeOutdoorHdri ?? 'midday';

  if (mode === 'overview') {
    return {
      tier,
      mode,
      corePbrSurfaces: CORE_PBR_LOW.slice(0, 4),
      coreHdriKeys: ['interior'],
      houseAndHomeCoreStreetProps: ['libRugWoven'],
      houseCoreLifeAssets: [],
      animationPackUrls: CORE_ANIMATION_URLS,
      parkedVehicleUrls: [],
      preloadNpcCount: 0,
      preloadVegetationSpeciesCount: 0,
      maxTextureUploadsPerBootFrame: tier === 'low' ? 3 : 6,
      interiorPrefetchSpecs: INTERIOR_PREFETCH_SPECS,
    };
  }

  const corePbrSurfaces =
    tier === 'low' ? CORE_PBR_LOW : tier === 'balanced' ? CORE_PBR_BALANCED : CORE_PBR_HIGH;

  const coreHdriKeys: HdriEnvKey[] =
    activeOutdoor === 'interior' ? ['interior', 'midday'] : [activeOutdoor, 'interior'];

  const houseAndHomeCoreStreetProps =
    tier === 'low' ? HOME_CORE_STREET_PROPS_BASE : HOME_CORE_STREET_PROPS_RICH;

  const preloadNpcCount = tier === 'low' ? 2 : tier === 'balanced' ? 3 : 4;
  const preloadVegetationSpeciesCount = tier === 'low' ? 4 : tier === 'balanced' ? 6 : 8;
  const maxTextureUploadsPerBootFrame = tier === 'low' ? 3 : tier === 'balanced' ? 4 : 6;

  return {
    tier,
    mode,
    corePbrSurfaces,
    coreHdriKeys,
    houseAndHomeCoreStreetProps,
    houseCoreLifeAssets: HOUSE_CORE_LIFE_ASSETS,
    animationPackUrls: CORE_ANIMATION_URLS,
    parkedVehicleUrls: tier === 'low' ? [] : PARKED_VEHICLE_URLS,
    preloadNpcCount,
    preloadVegetationSpeciesCount,
    maxTextureUploadsPerBootFrame,
    interiorPrefetchSpecs: INTERIOR_PREFETCH_SPECS,
  };
}

// ---------------------------------------------------------------------------
// Truthful Two-Gate (`G0_room` / `G1_world`) Boot Orchestrator
// ---------------------------------------------------------------------------

export interface StageContext {
  readonly gate: EchoLifeBootGate;
  readonly signal: AbortSignal;
  readonly slicer: EchoLifeTimeSlicer;
  /** Report fractional completion `0..1` within the current stage (resets no-progress watchdog when advancing). */
  reportStageFraction(fraction: number, detailKey?: string, detailVi?: string | null): void;
  /** Report concrete work units (`n/m`) such as assets parsed, textures uploaded, or shader batches compiled. */
  reportWorkProgress(completed: number, total: number, unitVi: string, detailKey?: string): void;
  /** Record a non-fatal optional asset failure/timeout without blocking entry. */
  recordDegradedAsset(assetKey: string): void;
  /** Pin a residency key until the boot gate completes. */
  pinBootEntry(key: string): void;
  /** Pauses GPU work while `document.hidden === true` and resumes cleanly on `visibilitychange`. */
  waitUntilVisibleForGpu(): Promise<boolean>;
}

export interface EchoLifeBootHooks {
  readonly tier: QualityTier;
  readonly mode: 'explore' | 'overview';
  /** Explicit gate (`G0_room` for overview room boot; `G1_world` for full Echo Life world or Explore transition). */
  readonly gate?: EchoLifeBootGate;
  /** True when running `G1_world` on the first Explore click from Overview mode. */
  readonly transitionMode?: boolean;
  /** False when `layout.character.visible === false` (body load is not required for G0). */
  readonly characterVisible?: boolean;
  /** Optional software-renderer notice flag (e.g. SwiftShader detected by GPU classifier). */
  readonly isSoftwareRenderer?: boolean;
  /** Optional live check for held background state (`isBackgroundHeld()` in `StudySpace.tsx`). */
  readonly isHeld?: () => boolean;
  /** Optional residency manager instance (defaults to shared `getEchoLifeResidencyManager()`). */
  readonly residency?: EchoLifeResidencyManager;
  /** Stage 1 (`preparing`): GPU probe / manifest prep / scene shell. */
  readonly prepareEnvironment: (ctx: StageContext) => Promise<void>;
  /** Stage 2 (`assets`): Core assets (G0: room + body if visible; G1: house + home-core + PBR + cast + NPCs). */
  readonly loadCoreAssets: (ctx: StageContext) => Promise<void>;
  /** Stage 3 (`graphics`): HDRI PMREM + staggered `initTexture` + RT-matched un-culled `compileAsync` + 1x1 draws. */
  readonly warmupGraphics: (ctx: StageContext) => Promise<void>;
  /** Stage 4 (`sync`, G1 only; optional on G0): Rapier WASM + solid buckets + `nav.worker` + world sync. */
  readonly syncWorldSimulation?: (ctx: StageContext) => Promise<void>;
  /** Stage 5 (`ready`): Final residency unpin + profiler baseline reset. */
  readonly finalizeReady?: (ctx: StageContext) => Promise<void>;
  /** Watchdog thresholds (defaults: 20 s notice, 60 s user-choice `slow` state — counted in visible non-held time!). */
  readonly slowNoticeMs?: number;
  readonly slowChoiceMs?: number;
}

interface StageRange {
  readonly id: EchoLifeBootStageId;
  readonly startPct: number;
  readonly endPct: number;
}

const G1_STAGE_RANGES: readonly StageRange[] = Object.freeze([
  { id: 'preparing', startPct: 0, endPct: 14 },
  { id: 'assets', startPct: 14, endPct: 54 },
  { id: 'graphics', startPct: 54, endPct: 82 },
  { id: 'sync', startPct: 82, endPct: 96 },
  { id: 'ready', startPct: 96, endPct: 100 },
]);

const G0_STAGE_RANGES: readonly StageRange[] = Object.freeze([
  { id: 'preparing', startPct: 0, endPct: 18 },
  { id: 'assets', startPct: 18, endPct: 62 },
  { id: 'graphics', startPct: 62, endPct: 94 },
  { id: 'ready', startPct: 94, endPct: 100 },
]);

const DEFAULT_SLOW_NOTICE_MS = 20_000;
const DEFAULT_SLOW_CHOICE_MS = 60_000;
const WATCHDOG_TICK_MS = 250;
const BYPASS_SETTLE_WAIT_MS = 350;

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export type BootSnapshotListener = (snapshot: BootProgressSnapshot) => void;

export class EchoLifeBootOrchestrator {
  private readonly listeners = new Set<BootSnapshotListener>();
  private readonly slicer: EchoLifeTimeSlicer;
  private epoch = 0;
  private controller: AbortController | null = null;
  private activeStageController: AbortController | null = null;
  private activeStagePromise: Promise<unknown> | null = null;
  private running = false;
  private startedAtMs = 0;
  private highWaterProgress = 0;
  private failedAssets: string[] = [];
  private noProgressVisibleMs = 0;
  private lastWorkCompleted = -1;
  private lastStageFraction = -1;
  private bypassedByUser = false;
  private bypassResolve: (() => void) | null = null;

  private snapshot: BootProgressSnapshot = {
    gate: 'G1_world',
    transitionMode: false,
    stageId: 'preparing',
    stageLabelVi: BOOT_STAGE_LABELS_VI.preparing,
    progress: 0,
    status: 'running',
    done: false,
    complete: false,
    detailVi: null,
    slowNoticeVi: null,
    errorVi: null,
    work: null,
    degradedAssetCount: 0,
    elapsedMs: 0,
    noProgressVisibleMs: 0,
    detailKey: 'init',
  };

  constructor(bootFrameBudgetMs = 9.5) {
    this.slicer = new EchoLifeTimeSlicer(bootFrameBudgetMs);
  }

  getSnapshot(): BootProgressSnapshot {
    return this.snapshot;
  }

  subscribe(listener: BootSnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Cancels the active boot run (e.g. React cleanup, StrictMode remount, quality switch). */
  abort(): void {
    this.epoch++;
    if (this.activeStageController && !this.activeStageController.signal.aborted) {
      this.activeStageController.abort();
    }
    if (this.controller && !this.controller.signal.aborted) {
      this.controller.abort();
    }
    this.running = false;
  }

  /** Immediately aborts every in-flight await on `webglcontextlost` and transitions to recoverable error state. */
  abortForContextLoss(
    reasonVi = 'Ngữ cảnh đồ họa WebGL đã bị ngắt trong quá trình khởi tạo. Vui lòng thử lại hoặc chuyển sang chế độ Đồ họa nhẹ.',
  ): void {
    const curEpoch = this.epoch;
    this.abort();
    this.emit(curEpoch + 1, {
      status: 'error',
      done: false,
      complete: false,
      errorVi: reasonVi,
      slowNoticeVi: null,
      detailKey: 'error:context-lost',
    });
  }

  /** User choice when `status === 'slow'`: keep waiting and reset the visible no-progress watchdog. */
  continueWaiting(): void {
    if (!this.running) return;
    this.noProgressVisibleMs = 0;
    this.emit(this.epoch, {
      status: isDocumentHidden() ? 'paused_hidden' : 'running',
      slowNoticeVi: null,
      detailKey: `${this.snapshot.stageId}:continue-waiting`,
    });
  }

  /**
   * User opt-in bypass when `status === 'slow'` ("Vào ngay (có thể giật)").
   * Cleanly aborts the active stage runner, waits for it to settle, and unlocks with `complete: false`
   * so callers NEVER persist `ec_echo_life_warmed_v1`.
   */
  enterAnyway(): void {
    if (!this.running || this.bypassedByUser) return;
    this.bypassedByUser = true;
    if (this.activeStageController && !this.activeStageController.signal.aborted) {
      this.activeStageController.abort();
    }
    this.bypassResolve?.();
  }

  private emit(forEpoch: number, patch: Partial<BootProgressSnapshot>): void {
    if (forEpoch !== this.epoch) return;

    const nextProgress =
      patch.progress !== undefined
        ? Math.max(this.highWaterProgress, Math.min(100, Math.round(patch.progress)))
        : this.highWaterProgress;
    this.highWaterProgress = nextProgress;

    const stageId = patch.stageId ?? this.snapshot.stageId;
    this.snapshot = {
      gate: patch.gate ?? this.snapshot.gate,
      transitionMode: patch.transitionMode ?? this.snapshot.transitionMode,
      stageId,
      stageLabelVi: BOOT_STAGE_LABELS_VI[stageId],
      progress: nextProgress,
      status: patch.status ?? this.snapshot.status,
      done: patch.done ?? this.snapshot.done,
      complete: patch.complete ?? this.snapshot.complete,
      detailVi: patch.detailVi !== undefined ? patch.detailVi : this.snapshot.detailVi,
      slowNoticeVi: patch.slowNoticeVi !== undefined ? patch.slowNoticeVi : this.snapshot.slowNoticeVi,
      errorVi: patch.errorVi !== undefined ? patch.errorVi : this.snapshot.errorVi,
      work: patch.work !== undefined ? patch.work : this.snapshot.work,
      degradedAssetCount: this.failedAssets.length,
      elapsedMs: this.startedAtMs > 0 ? Math.round(nowMs() - this.startedAtMs) : 0,
      noProgressVisibleMs: Math.round(this.noProgressVisibleMs),
      detailKey: patch.detailKey ?? this.snapshot.detailKey,
    };

    for (const listener of this.listeners) {
      try {
        listener(this.snapshot);
      } catch {
        /* isolate subscriber errors */
      }
    }
  }

  private formatSlowNotice(forChoice: boolean): string {
    const work = this.snapshot.work;
    const progressPart =
      work && work.total > 0 ? ` (${work.completed}/${work.total} ${work.unitVi})` : '';
    if (forChoice) {
      return `Quá trình khởi tạo đang mất nhiều thời gian hơn dự kiến${progressPart}. Bạn có thể tiếp tục chờ, chuyển sang Đồ họa nhẹ hoặc vào ngay.`;
    }
    return `Vẫn đang tải${progressPart}…`;
  }

  /** Alias supporting both G0 (room) and G1 (world) gates seamlessly. */
  runGate(hooks: EchoLifeBootHooks): Promise<BootTelemetryReport> {
    return this.run(hooks);
  }

  async run(hooks: EchoLifeBootHooks): Promise<BootTelemetryReport> {
    if (this.running) this.abort();

    const myEpoch = ++this.epoch;
    const controller = new AbortController();
    this.controller = controller;
    this.running = true;
    this.startedAtMs = nowMs();
    this.highWaterProgress = 0;
    this.failedAssets = [];
    this.noProgressVisibleMs = 0;
    this.bypassedByUser = false;
    this.bypassResolve = null;
    this.slicer.resetFrame();

    const gate: EchoLifeBootGate = hooks.gate ?? (hooks.mode === 'overview' ? 'G0_room' : 'G1_world');
    const transitionMode = hooks.transitionMode === true;
    const ranges = gate === 'G0_room' ? G0_STAGE_RANGES : G1_STAGE_RANGES;
    const slowNoticeMs = Math.max(250, hooks.slowNoticeMs ?? DEFAULT_SLOW_NOTICE_MS);
    const slowChoiceMs = Math.max(slowNoticeMs + 250, hooks.slowChoiceMs ?? DEFAULT_SLOW_CHOICE_MS);
    const residency = hooks.residency ?? getEchoLifeResidencyManager();

    residency.setBootActive(true);

    const initialDetailVi = hooks.isSoftwareRenderer
      ? 'Thiết bị đang dùng đồ họa phần mềm, quá trình tối ưu ban đầu có thể chậm hơn bình thường.'
      : null;

    this.emit(myEpoch, {
      gate,
      transitionMode,
      stageId: 'preparing',
      progress: 0,
      status: 'running',
      done: false,
      complete: false,
      detailVi: initialDetailVi,
      slowNoticeVi: null,
      errorVi: null,
      work: null,
      detailKey: 'boot:start',
    });

    const stageTimings: BootStageTiming[] = [];
    const runners: Record<EchoLifeBootStageId, (ctx: StageContext) => Promise<void>> = {
      preparing: hooks.prepareEnvironment,
      assets: hooks.loadCoreAssets,
      graphics: hooks.warmupGraphics,
      sync: hooks.syncWorldSimulation ?? (async () => undefined),
      ready: hooks.finalizeReady ?? (async () => undefined),
    };

    // Visible, non-held no-progress watchdog (ticks ONLY when tab is visible and not background-held).
    let lastTickMs = nowMs();
    const watchdogId = setInterval(() => {
      if (myEpoch !== this.epoch || !this.running || controller.signal.aborted) return;
      const now = nowMs();
      const dt = Math.max(0, Math.min(1000, now - lastTickMs));
      lastTickMs = now;

      const hiddenOrHeld = isDocumentHidden() || Boolean(hooks.isHeld?.());
      if (hiddenOrHeld) {
        if (this.snapshot.status === 'running') {
          this.emit(myEpoch, {
            status: 'paused_hidden',
            detailVi: 'Tạm dừng tối ưu khi thẻ trình duyệt ở nền…',
          });
        }
        return;
      }

      if (this.snapshot.status === 'paused_hidden') {
        this.emit(myEpoch, {
          status: 'running',
          detailVi: initialDetailVi,
        });
      }

      this.noProgressVisibleMs += dt;

      if (this.noProgressVisibleMs >= slowChoiceMs) {
        if (this.snapshot.status !== 'slow') {
          this.emit(myEpoch, {
            status: 'slow',
            done: false,
            complete: false,
            slowNoticeVi: this.formatSlowNotice(true),
            detailKey: `${this.snapshot.stageId}:slow-choice`,
          });
        }
      } else if (this.noProgressVisibleMs >= slowNoticeMs) {
        this.emit(myEpoch, {
          slowNoticeVi: this.formatSlowNotice(false),
        });
      }
    }, WATCHDOG_TICK_MS);

    try {
      for (const range of ranges) {
        if (controller.signal.aborted || myEpoch !== this.epoch) {
          return this.buildReport(hooks, gate, transitionMode, stageTimings, true, false, false);
        }
        if (this.bypassedByUser) break;

        const stageStart = nowMs();
        this.noProgressVisibleMs = 0;
        this.lastWorkCompleted = -1;
        this.lastStageFraction = -1;

        this.emit(myEpoch, {
          stageId: range.id,
          progress: range.startPct,
          status: isDocumentHidden() ? 'paused_hidden' : 'running',
          done: false,
          complete: false,
          slowNoticeVi: null,
          work: null,
          detailKey: `${range.id}:start`,
        });

        const stageController = new AbortController();
        this.activeStageController = stageController;
        const onParentAbort = () => stageController.abort();
        controller.signal.addEventListener('abort', onParentAbort, { once: true });

        const ctx: StageContext = {
          gate,
          signal: stageController.signal,
          slicer: this.slicer,
          reportStageFraction: (fraction, detailKey, detailVi) => {
            if (myEpoch !== this.epoch || controller.signal.aborted || stageController.signal.aborted) return;
            const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
            if (clamped > this.lastStageFraction + 1e-4) {
              this.lastStageFraction = clamped;
              this.noProgressVisibleMs = 0;
            }
            const pct = range.startPct + (range.endPct - range.startPct) * clamped;
            this.emit(myEpoch, {
              stageId: range.id,
              progress: pct,
              status: this.snapshot.status === 'slow' ? 'running' : this.snapshot.status,
              slowNoticeVi: this.noProgressVisibleMs < slowNoticeMs ? null : this.snapshot.slowNoticeVi,
              detailVi: detailVi !== undefined ? detailVi : this.snapshot.detailVi,
              detailKey: detailKey ?? `${range.id}:progress`,
            });
          },
          reportWorkProgress: (completed, total, unitVi, detailKey) => {
            if (myEpoch !== this.epoch || controller.signal.aborted || stageController.signal.aborted) return;
            const safeTotal = Math.max(1, Math.round(total));
            const safeCompleted = Math.max(0, Math.min(safeTotal, Math.round(completed)));
            if (safeCompleted > this.lastWorkCompleted) {
              this.lastWorkCompleted = safeCompleted;
              this.noProgressVisibleMs = 0;
            }
            const frac = safeCompleted / safeTotal;
            const pct = range.startPct + (range.endPct - range.startPct) * frac;
            this.emit(myEpoch, {
              stageId: range.id,
              progress: pct,
              status: this.snapshot.status === 'slow' ? 'running' : this.snapshot.status,
              slowNoticeVi: this.noProgressVisibleMs < slowNoticeMs ? null : this.snapshot.slowNoticeVi,
              work: { completed: safeCompleted, total: safeTotal, unitVi },
              detailVi: `${safeCompleted}/${safeTotal} ${unitVi}`,
              detailKey: detailKey ?? `${range.id}:work`,
            });
          },
          recordDegradedAsset: (assetKey) => {
            if (!this.failedAssets.includes(assetKey)) {
              this.failedAssets.push(assetKey);
              this.emit(myEpoch, { stageId: range.id });
            }
          },
          pinBootEntry: (key) => {
            residency.pinBootEntry(key);
          },
          waitUntilVisibleForGpu: () =>
            waitUntilDocumentVisible(stageController.signal, (paused) => {
              if (myEpoch !== this.epoch || controller.signal.aborted) return;
              this.emit(myEpoch, {
                status: paused ? 'paused_hidden' : 'running',
                detailVi: paused ? 'Tạm dừng tối ưu đồ họa khi thẻ trình duyệt ở nền…' : initialDetailVi,
              });
            }),
        };

        const bypassPromise = new Promise<'bypass'>((resolve) => {
          this.bypassResolve = () => resolve('bypass');
        });

        const runnerPromise = Promise.resolve().then(() => runners[range.id](ctx));
        this.activeStagePromise = runnerPromise;

        try {
          const outcome = await Promise.race([
            runnerPromise.then(() => 'ok' as const),
            bypassPromise,
          ]);

          if (outcome === 'bypass') {
            stageController.abort();
            // Confirm runner stops cleanly before unlocking (bounded cleanup window).
            await Promise.race([
              runnerPromise.catch(() => undefined),
              new Promise<void>((r) => setTimeout(r, BYPASS_SETTLE_WAIT_MS)),
            ]);
            stageTimings.push({
              stageId: range.id,
              durationMs: Math.round(nowMs() - stageStart),
              completed: false,
            });
            break;
          }
        } finally {
          controller.signal.removeEventListener('abort', onParentAbort);
          this.bypassResolve = null;
          if (this.activeStageController === stageController) this.activeStageController = null;
          if (this.activeStagePromise === runnerPromise) this.activeStagePromise = null;
        }

        stageTimings.push({
          stageId: range.id,
          durationMs: Math.round(nowMs() - stageStart),
          completed: true,
        });

        if (controller.signal.aborted || myEpoch !== this.epoch) {
          return this.buildReport(hooks, gate, transitionMode, stageTimings, true, false, false);
        }

        this.emit(myEpoch, {
          stageId: range.id,
          progress: range.endPct,
          slowNoticeVi: null,
          detailKey: `${range.id}:done`,
        });

        await this.slicer.yieldIfNeeded(controller.signal);
      }

      if (this.bypassedByUser) {
        // Explicit user opt-in ("Vào ngay"): unlock UI with `complete: false` so `markEchoLifeWarmed` is NOT written!
        this.emit(myEpoch, {
          status: 'degraded_ready',
          done: true,
          complete: false,
          slowNoticeVi: null,
          detailKey: 'ready:user-bypass',
        });
        return this.buildReport(hooks, gate, transitionMode, stageTimings, false, false, true);
      }

      this.emit(myEpoch, {
        stageId: 'ready',
        progress: 100,
        status: 'ready',
        done: true,
        complete: true,
        slowNoticeVi: null,
        errorVi: null,
        detailKey: 'ready:complete',
      });
      return this.buildReport(hooks, gate, transitionMode, stageTimings, false, true, false);
    } catch (err) {
      const msg =
        err instanceof Error && err.message.trim().length > 0 && /[ăâđêôơưáàảãạ]/i.test(err.message)
          ? err.message
          : 'Không thể khởi tạo Không gian học tập 3D. Vui lòng thử lại hoặc chuyển sang chế độ Đồ họa nhẹ.';
      this.emit(myEpoch, {
        status: 'error',
        done: false,
        complete: false,
        slowNoticeVi: null,
        errorVi: msg,
        detailKey: 'error:fatal',
      });
      return this.buildReport(hooks, gate, transitionMode, stageTimings, controller.signal.aborted, false, false);
    } finally {
      clearInterval(watchdogId);
      residency.setBootActive(false);
      if (this.controller === controller) {
        this.running = false;
      }
    }
  }

  private buildReport(
    hooks: EchoLifeBootHooks,
    gate: EchoLifeBootGate,
    transitionMode: boolean,
    stages: readonly BootStageTiming[],
    aborted: boolean,
    complete: boolean,
    bypassedByUser: boolean,
  ): BootTelemetryReport {
    return {
      gate,
      transitionMode,
      tier: hooks.tier,
      mode: hooks.mode,
      totalMs: Math.round(nowMs() - this.startedAtMs),
      stages,
      failedAssets: [...this.failedAssets],
      yields: this.slicer.totalYields,
      aborted,
      complete,
      succeeded: complete || bypassedByUser,
      bypassedByUser,
    };
  }
}
