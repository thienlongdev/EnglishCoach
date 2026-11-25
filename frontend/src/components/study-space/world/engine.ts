import * as T from 'three';
import { dressBookFace, dressShelf, shelfHoldsBooks, undressShelf } from './shelfBooks';
import type { LibraryBook } from '@/lib/study-space/library';
import type { BookSession } from '@/lib/study-space/bookSession';
import { graphicsTierToVfxTier, VfxQuality, type VfxTier } from '@/lib/vfx/quality';
import { musicBands } from '@/lib/vfx/audio';
import { pulseGlass, updateGlass } from '@/lib/vfx/glass';
import type { EmbodiedAction } from '@/lib/embodiment/actions';
import { CROUCH, reachEyeShift, type BodyFrame } from '@/lib/embodiment/human';
import { graspable, surfaceOf } from '@/lib/embodiment/grasp';
import type { FloorEnvelope } from '@/lib/embodiment/posture';
import { footstep, prepareContactAudio } from '@/lib/embodiment/contactAudio';
import { Manipulator, type InteractionState, type Placed } from './manipulation';
import type { Slider } from './assets';
import { ScenePassage, takeWorldPassage } from '@/lib/morph/scene';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CATALOG_BY_ID, type CatalogItem } from '@/lib/study-space/catalog';
import type { Activity, Layout, Quality, SpaceObject } from '@/lib/study-space/types';
import { WALL_HEIGHT } from '@/lib/study-space/layout';
import { ECHO_MODEL_URL } from '@/components/landing/ocean/echoAssets';
import { loadWhaleRig, type WhaleRig } from '@/components/landing/ocean/whaleRig';
import { build, disposeGeometries, tickDeskScreen, type LightSpec } from './furniture';
import { blobTexture, disposeMaterials, haloTexture, setMaterialsQuality } from './materials';
import { buildRoom, type RoomBuild } from './room';
import { viewLight, windowLatch } from './windows';
import { Character, forgetCasts } from './character';
import { RoomNavigation } from '@/lib/study-space/navigation';
import { disposeStudyAssets } from './assets';
import { WaterWorld } from './water/water';
import { disposeGatewayAssets } from './gatewayAssets';
import { furnitureAnchor } from './furnitureAnchors';
import { Exploration, type CameraView, type ExplorationState } from './exploration';
import type { WorldDestination } from '@/lib/study-space/exploration';
import { affordanceOf, seatMobilityOf } from '@/lib/study-space/affordances';
import { uid } from '@/lib/study-space/layout';
import { LifeWorld } from './lifeWorld';
import { applyToolLook, prewarmToolBendMaterial } from './toolWork';
import { CARE_IDS, careReady, loadCareAssets } from './assets';
import type { RoomLife } from '@/lib/study-space/life';
import type { Line } from '@/lib/study-space/stories';
import { splash } from '@/lib/embodiment/contactAudio';
import { EchoLifeWorld } from './echoLife/world';
import { EchoLifeGameHost, type GameHud } from './echoLife/gameHost';
import {
  createDummyVehicleWarmupGroup,
  disposeDummyVehicleWarmupGroup,
  setEchoLifePlayerHandRight,
  setVehiclePrewarmHook,
} from './echoLife/gameView';
import {
  disposeEchoLifePlanarMirrors,
  getEchoLifePlanarMirrors,
  type MirrorSurfaceHandle,
} from './echoLife/planarMirror';
import {
  setBuildingMirrorHook,
  type BuildingMirrorDescriptor,
} from './echoLife/buildingsView';
import type { StreamPrewarmPriority } from './echoLife/streaming';
import { isSpaceObjectUpright } from '@/lib/study-space/orientation';
import {
  lifeAssetStats,
  lifeAssetTextureMB,
  setGltfTextureTier,
  setLifeAssetsAnisotropy,
} from './echoLife/assets';
import { encodeLookV2, type CharacterCreatorProfile } from '@/lib/avatar/characterCreator';
import type { Mood } from '@/lib/embodiment/cast';
import {
  EchoCsmSystem,
  getInFlightCompileCount,
  safeCompileAsync,
  type EchoCsmZoneMode,
} from './echoLife/echoCsm';
import {
  awaitCorePbrReady,
  getLoadedPbrBaseTextures,
  pbrAtlasStats,
  setPbrAtlasAnisotropy,
  setPbrAtlasQuality,
} from './echoLife/pbrAtlas';
import { preloadCharacterPbrTextures } from './echoLife/characterMaterials';
import { getEchoLifeResidencyManager, type ResidencyStats } from './echoLife/residencyManager';
import {
  EchoLifeTimeSlicer,
  getEchoLifeTextureUploadQueue,
  LoadPriority,
  TextureUploadQueue,
} from './echoLife/loadScheduler';
import {
  getRenderConfig,
  isQualityTier,
  probeGpuCapabilities,
  probeThrowawayWebGlCapabilities,
  probeWebGlCapabilitiesSync,
  stepDownQualityTier,
  type GpuCapabilityReport,
  type QualityTier,
} from './echoLife/renderConfig';
import { PostFXController } from './echoLife/postFx';
import { classifyFootSurface } from './echoLife/worldAudio';
import { ECHO_LIFE_QUALITY_KEY, type PerfTelemetry } from '../echoLife/hudStore';
import type { EchoLifeBootStageId } from '../echoLife/echoLifeBootStages';
import type { GameSaver } from '@/lib/echo-life/game/saver';
import type { Target as GameTarget } from '@/lib/echo-life/game/session';
import { housePlan, DOOR_W, DOOR_H } from '@/lib/echo-life/plan';
import { houseDoorKey, type WorldSaver } from '@/lib/echo-life/save';
import {
  sanitizePlayerPosition,
  type ParkedVehicleCollider,
  type PlayerCollisionWorld,
} from '@/lib/echo-life/playerCollision';

/**
 * The foreground scene of Không gian học tập: the learner's room, objects, character and companion, drawn on a
 * TRANSPARENT canvas over the appearance background (Giao diện keeps its own engine underneath; this canvas never
 * paints a sky of its own). One renderer, one loop that sleeps in a hidden tab; every geometry, material, texture and
 * the context are released by `dispose`. The layout is the source of truth: `sync` turns it into the scene, and the
 * scene reports edits back through callbacks (never writes the layout itself).
 */

export interface CreatorStudioOptions {
  preset?: 'full' | 'upper' | 'face' | 'shoes';
  lightPreset?: 'studio' | 'daylight' | 'golden' | 'night';
  yawOffset?: number;
  snowPreview?: boolean;
  expression?: string;
}

export interface BuildCameraOptions {
  panX?: number;
  panZ?: number;
  zoom?: number;
  yaw?: number;
}

export interface PhotoStudioOptions {
  freezeTime?: boolean;
  fov?: number;
  yawDelta?: number;
  pitchDelta?: number;
  zoomDelta?: number;
  pose?: string;
  expression?: string;
  filterCss?: string;
}

export interface EngineCallbacks {
  lifeEnabled?: boolean;
  /** The learner's language, for words drawn inside the room. */
  language?: () => 'vi' | 'en';
  onSelect: (ids: string[], additive: boolean) => void;
  onMove: (id: string, pos: [number, number, number], rotY: number, merge: string) => void;
  onMoveDone: () => void;
  onPlace: (kind: string, pos: [number, number, number], rotY: number) => void;
  onActivate: (id: string) => void;
  onCamera: (c: Layout['camera']) => void;
  onCharacterMoved: (pos: [number, number, number], rotY: number, floorPose?: Layout['character']['floorPose']) => void;
  onCharacterClick: () => void;
  onCharacterUse: (anchor: string, activity: Activity) => void;
  onFail: (reason: string) => void;
  onQuality: (q: Quality) => void;
  onExplore?: (state: ExplorationState) => void;
  onPortal?: (destination: 'arena' | 'games') => void;
  onWindow?: (open: boolean) => void;
  /** State of a thing that belongs to the room: where it came to rest, how it lies, its drawers. */
  onObjectState?: (id: string, patch: Partial<SpaceObject>, merge: string) => void;
  onSpawn?: (obj: SpaceObject) => void;
  onCurtains?: (k: number) => void;
  /** Worn or taken off by the hand in the room: the same record the wardrobe shows. */
  onAccessory?: (id: string, on: boolean) => void;
  wearing?: (id: string) => boolean;
  say?: (vi: string, en: string) => void;
  onInteraction?: (state: InteractionState) => void;
  /** Keyboard shortcuts the page answers: wardrobe, focus, quick menu, the bar. */
  onShortcut?: (action: string) => void;
  /** What a book in the room really says. */
  bookSession?: (obj: SpaceObject) => Promise<BookSession | null>;
  onLibrary?: (shelf: string) => void;
  onDespawn?: (id: string) => void;
  /** Saves the room's layout now; resolves true once the server has it (a thing coming back in from the house waits for it). */
  persistLayout?: () => Promise<boolean>;
  /** The eyes reached the screen of this computer; `rect` is where that screen is on the page. */
  onDevice?: (id: string, rect: { left: number; top: number; width: number; height: number }) => void;
  /** What time and tools have done to the room: saved with it, never a step of Undo. */
  onLife?: (life: RoomLife) => void;
  /** A line of the story, for the bottom of the screen. */
  onCaption?: (line: Line) => void;
  /** How wet, how full: small changes to a thing's own state. */
  onToolState?: (id: string, state: SpaceObject['state'], immediate?: boolean) => void;
  /** A friend has written or invited: how many, from the Messenger that is already open. */
  social?: () => { unread: number; invited: boolean };
  captionOn?: () => boolean;
  /** Echo Life game (Phase 3 + 4): the HUD snapshot (≈ 5 a second) and E on a resident or a game hotspot. */
  onGameHud?: (hud: GameHud | null) => void;
  onGameInteract?: (target: GameTarget) => void;
}

const MAX_LIGHTS = 6;
const tmpV = new T.Vector3();
const tmpSunDir = new T.Vector3();
const tmpFootProbe = new T.Vector3();
const tmpFootOut = new T.Vector3();
const tmpRootPrev = new T.Vector3();
const tmpReadyFlat = new T.Vector3();
const tmpReadyFwd = new T.Vector3();
const tmpReadyUp = new T.Vector3();
const tmpReadyRight = new T.Vector3();
const tmpMotionFloor = new T.Vector3();
const tmpResolveRoot = new T.Vector3();
const tmpStudioWorldCenter = new T.Vector3();
const tmpStudioDesiredPos = new T.Vector3();
const tmpStudioDesiredTarget = new T.Vector3();
const tmpStandFallback = new T.Vector3();
const STUDIO_FINGER_ON: { readonly clipFingerWeight?: number } = { clipFingerWeight: 1 };
const STUDIO_FINGER_OFF: { readonly clipFingerWeight?: number } = {};
const STAND_CANDIDATE_ANGLES = [
  0,
  Math.PI * 0.25,
  -Math.PI * 0.25,
  Math.PI * 0.5,
  -Math.PI * 0.5,
  Math.PI * 0.75,
  -Math.PI * 0.75,
  Math.PI,
] as const;
const STAND_CANDIDATE_RADII = [0.58, 0.76, 0.94] as const;
const VFX_TIER_ORDER: readonly VfxTier[] = ['low', 'medium', 'high', 'ultra'];

type EchoLifeWorldWave4 = EchoLifeWorld & {
  readonly lightGroup?: T.Group;
  readonly collisionWorld?: PlayerCollisionWorld;
};

export interface EchoLifeProfileHandle {
  readonly baselinePrograms: number;
  readonly currentPrograms: number;
  readonly programDelta: number;
  readonly warmupMs: number;
  readonly tier: QualityTier;
  readonly gpuClass: GpuCapabilityReport['gpuClass'];
  readonly shadowMapsReady: boolean;
  readonly vramBreakdown: {
    readonly renderTargetsMB: number;
    readonly shadowMapsMB: number;
    readonly pmremMB: number;
    readonly geometryMB: number;
    readonly assetsMB: number;
    readonly pbrAtlasMB: number;
    readonly residency: ResidencyStats;
  };
}
const DEFAULT_VRAM_BUDGET_MB: Readonly<Record<QualityTier, number>> = {
  low: 96,
  balanced: 192,
  high: 320,
  ultra: 512,
};
const NORMAL_PASS_SKIP_GROUPS = new Set([
  'echo-life-grass-field',
  'echo-life-weather-particles',
  'echo-life-physical-sky',
  'city-skyline',
  'echo-life-river-water',
]);
const OUTDOOR_LIGHTING_REGIONS = new Set(['road', 'crossing', 'sidewalk', 'park', 'garden', 'plaza', 'balcony']);

function readExplicitSavedQualityTier(): QualityTier | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(ECHO_LIFE_QUALITY_KEY);
    return isQualityTier(raw) ? raw : null;
  } catch {
    return null;
  }
}

export class StudyWorld {
  readonly renderer: T.WebGLRenderer;
  readonly scene = new T.Scene();
  readonly camera: T.OrthographicCamera;
  readonly exploration: Exploration;
  private passage = new ScenePassage(takeWorldPassage('/study-space'));
  readonly manip: Manipulator;
  readonly life: LifeWorld;
  readonly water: WaterWorld;
  private postFx: PostFXController;
  private lastPhysicsLayout = '';
  private explorationBeforeEdit: CameraView = 'overview';
  private hoverBox = new T.Box3Helper(new T.Box3(), new T.Color('#a9e7db'));
  private controls: OrbitControls;
  private stage = new T.Group();
  private room: RoomBuild | null = null;
  private roomKey = '';
  private placed = new Map<string, Placed>();
  private character: Character | null = null;
  private characterKey = '';
  private scopeKey = '';
  private anchorKey = '';
  private ownChairAt: [number, number] | null = null;
  private anchorIdKey: string | null = null;
  private posKey = '';
  private lastTargetPoint: T.Vector3 | null = null;
  private eyeWorld = new T.Vector3();
  private activityKey: Activity | null = null;
  private spaceIdentity = '';
  private usedObject: string | null = null;
  private standingExit = false;
  private activeRollingChairId: string | null = null;
  private rollingChairDirty = false;
  private rollingChairCommitIdleSec = 0;
  private creatorHeroSwapSeq = 0;
  private studioDrag: { pointerId: number; lastX: number; lastY: number } | null = null;
  private held = false;
  private qa = process.env.NODE_ENV !== 'production' && ['127.0.0.1','localhost'].includes(location.hostname) && new URLSearchParams(location.search).has('studyQA');
  private qaFrames = 0;
  private lastQaDomSerializeMs = 0;
  private cachedWindowView: T.Object3D | null = null;
  private cachedPeopleGroup: T.Object3D | null = null;
  private transmissiveStudyMats = new Map<T.MeshPhysicalMaterial, { transmission: number; opacity: number; transparent: boolean; depthWrite: boolean }>();
  private navigation: RoomNavigation | null = null;
  private navigationKey = '';
  private pet: WhaleRig | null = null;
  private petAbort: AbortController | null = null;
  private hemi = new T.HemisphereLight('#eef1ff', '#d9cfe8', 1.1);
  private key = new T.DirectionalLight('#ffffff', 2.2);
  private windowLight = new T.DirectionalLight('#8fb0ff', 1.2);
  private fill = new T.DirectionalLight('#f3e8ff', 0.45);
  private lamps: T.PointLight[] = [];
  private halos: T.Sprite[] = [];
  private selectionBox = new T.Box3Helper(new T.Box3(), new T.Color('#8b7cf0'));
  private ghost: { kind: string; group: T.Group; rotY: number; valid: boolean; pos: T.Vector3 } | null = null;
  private drag: { id: string; offset: T.Vector3; moved: boolean; merge: string } | null = null;
  private raycaster = new T.Raycaster();
  private pointer = new T.Vector2();
  private lastFrameMs = 0;
  private emaFrameMs = 16.67;
  private time = 0;
  private vfxQuality = new VfxQuality();
  private raf = 0;
  private running = false;
  private disposed = false;
  private layout: Layout | null = null;
  private mode: 'use' | 'edit' = 'use';
  private selection: string[] = [];
  private reduced = false;
  private musicOn = false;
  private quality: Quality = 'high';
  private qualityTier: QualityTier = 'high';
  private qualityPreference: Quality | null = null;
  private qualityExplicit = false;
  private didInitialTierSync = false;
  private appliedInitialTier = false;
  private _warmupReady = false;
  private gpuReport: GpuCapabilityReport;
  private maxAnisotropy = 16;
  private currentShadowMapSize = 2048;
  private elapsedRunSec = 0;
  private sustainedSlowSec = 0;
  private shadersPending = true;
  private readonly shaderCamera = new T.PerspectiveCamera(50, 1, .03, 90);
  private readonly studioCamera = new T.PerspectiveCamera(36, 16 / 9, 0.05, 420);
  private readonly handRightScratch = new T.Vector3();
  private pendingCreatorProfile: CharacterCreatorProfile | null = null;
  private studioMode: 'none' | 'creator' | 'build' | 'photo' = 'none';
  private studioCreatorOpts: CreatorStudioOptions = {};
  private studioBuildOpts: BuildCameraOptions = {};
  private studioPhotoOpts: PhotoStudioOptions = {};
  private studioSavedLights: {
    keyPos: T.Vector3;
    keyTarget: T.Vector3;
    keyColor: T.Color;
    keyIntensity: number;
    keyShadowIntensity: number;
    winPos: T.Vector3;
    winTarget: T.Vector3;
    winColor: T.Color;
    winIntensity: number;
    fillPos: T.Vector3;
    fillTarget: T.Vector3;
    fillColor: T.Color;
    fillIntensity: number;
    zoneMode: EchoCsmZoneMode;
  } | null = null;
  private readonly parkedCollidersScratch: ParkedVehicleCollider[] = [];
  private readonly portalOccScratch: [{ x: number; y: number; z: number; radius: number }] = [
    { x: 0, y: 0, z: 0, radius: 0.26 },
  ];
  private readonly threshSkyColor = new T.Color('#f6efe4');
  private readonly threshGroundColor = new T.Color('#75685a');
  private readonly threshKeyColor = new T.Color('#fff1dc');
  private readonly dialogueLookScratch = { yaw: 0, pitch: 0 };
  private lastEmbodiedTargetSig = '';
  private wasShoweringSessionActive = false;
  private lastShowerTargetSig = '';
  private lastSpatialNavSig = '';
  private lastSpatialNavRollingId: string | null = null;
  private lastSpatialNavHadPhysics = false;
  private homeMirrorsWorld: EchoLifeWorld | null = null;
  private readonly homeMirrorHandles: MirrorSurfaceHandle[] = [];
  private wasPlayerRiding = false;
  private hasUnlockedFrame = false;
  private imminentPrewarmChain: Promise<void> = Promise.resolve();
  private prewarmChain: Promise<void> = Promise.resolve();
  private baselinePrograms = 0;
  private lastWarmupMs = 0;
  private lifeBuildFailures = 0;
  private preEntryWarmupPromise: Promise<{ baselinePrograms: number; warmupMs: number }> | null = null;
  private fixedBreakdownCache = { renderTargetsBytes: 0, shadowMapsBytes: 0, pmremBytes: 0, geometryBytes: 0 };
  private studioSavedControlsEnabled = false;
  private studioSavedWeather: { season: number | null; weather: EchoLifeGameHost['envControl']['weather'] } | null = null;
  private studioCamPos = new T.Vector3();
  private studioCamTarget = new T.Vector3();
  private studioCamInitialized = false;
  private lastSeasonalCheckClock = 0;
  private warmedExploration = false;
  private outdoorWarmupEpoch = 0;
  private outdoorWarmupInFlight = false;
  private lastWarmedOutdoorKey = '';
  private lastCamera = '';
  private lastExplCamFov = 0;
  private lastExplCamFar = 0;
  private pmrem: T.PMREMGenerator;
  private envTex: T.Texture | null = null;
  private down: { x: number; y: number; t: number; hit: string | null } | null = null;
  freePlacement = false;
  snap = true;

  /** Echo Life: the house and the city around the study room, drawn while exploring (`./echoLife`). */
  private echoLife: EchoLifeWorld | null = null;
  private echoLifeKey = '';
  private echoCsm: EchoCsmSystem;
  private csmPatchedObjects = new WeakSet<T.Object3D>();
  private readonly csmNpcScratch: (T.Object3D | null)[] = [null, null];
  private lastCsmWorldSig = '';
  private lastCsmPeopleChildren = -1;
  private atmosphereWarmedFor: EchoLifeWorld | null = null;
  private lifeSolidsFor: unknown = null;
  private lifeSolidsVersion = -1;
  private physicsBucketKeys = new Set<string>();
  private lastDoorPlugsFor: unknown = null;
  private lastDoorPlugsVersion = -1;
  private lastSavedDoorsVersion = -1;
  private doorSaveClock = 0;
  /**
   * The account's world save (`lib/echo-life/save.ts`, server V129): the body's place outside the study room, the house doors and
   * the room's things set down outside it. None of it is ever written into the room's layout.
   */
  private lifeSave: WorldSaver | null = null;
  private lifeSaveOff: (() => void) | null = null;
  /** The room's own layout as the page gave it; `this.layout` is it plus the room's things that are out in the world. */
  private roomLayout: Layout | null = null;
  /** This space's things that are out of the room (by object id), as the world save keeps them. */
  private lifeObjects = new Map<string, SpaceObject>();
  /** Door states as last seen at rest and saved (id -> open, angle). */
  private doorSeen = new Map<string, { open: boolean; angle: number }>();
  private doorsRestoredFor: unknown = null;
  private placeRestoredFor = '';
  private awaitingResidence = false;
  private readonly distantStudyProps:T.Object3D[]=[];
  private resumeHeld: string[] = [];
  private carrySaveTimer=0;
  private doorwayFor: unknown = null;
  setLifeSave(saver: WorldSaver | null) {
    if (saver === this.lifeSave) return;
    this.lifeSaveOff?.(); this.lifeSaveOff = null;
    this.lifeSave = saver; this.doorsRestoredFor = null; this.placeRestoredFor = ''; this.resumeHeld=[]; this.doorSeen.clear();
    this.awaitingResidence=false;
    // The server's copy arrived (or brought another tab's change): the scene follows, and an arrival outdoors is put back there.
    if (saver) this.lifeSaveOff = saver.onChange(() => { if (this.roomLayout && !this.disposed) { this.sync(this.roomLayout); this.restoreLifePlace(); } });
    if (this.roomLayout) this.sync(this.roomLayout);
  }
  get lifeWorld() { return this.echoLife; }
  /** Echo Life game (Phase 3 + 4): residents, story, quests, activities, economy — over this world, never a second engine. */
  game!: EchoLifeGameHost;
  sharedCity: import('./echoLife/sharedCity').SharedCityPresence | null = null;
  setGameSave(saver: GameSaver | null) { this.game.setSaver(saver); }
  /** A thing of the room was used while exploring: V3's tutorial signal, and a desk session is V3's `study` event. */
  private gameStudied(id: string) {
    const g = this.game?.game;
    if (!g || !this.exploration.active) return;
    const kind = this.layout?.objects.find(o => o.id === id)?.kind ?? '';
    g.studied(/desk/i.test(kind));
  }
  get lifeSaver() { return this.lifeSave; }
  /** The room's layout with this space's things that are out in the house (the world save's copies win over the room's). */
  private withWorldObjects(layout: Layout): Layout {
    this.lifeObjects.clear();
    const saver = this.lifeSave;
    if (!saver?.loaded || !this.spaceIdentity || !this.lifeWanted(layout)) return layout;
    for (const e of saver.objectsOf(this.spaceIdentity)) this.lifeObjects.set(e.object.id, e.object);
    if (!this.lifeObjects.size) return layout;
    return { ...layout, objects: [...layout.objects.filter(o => !this.lifeObjects.has(o.id)), ...this.lifeObjects.values()] };
  }
  /**
   * A thing set down: inside the study square it is the room's (layout), outside it the world's. Crossing the doorway moves
   * its record: out of the room, the world's copy is written first (at once), then the room lets it go; back in, the room
   * takes it first and the world's copy is removed only once the room's layout is saved, so a closed tab never loses it.
   */
  private routeObjectState(id: string, patch: Partial<SpaceObject>): boolean {
    const saver = this.lifeSave, world = this.echoLife, space = this.spaceIdentity;
    if (!saver?.loaded || !world || !space) return false;
    const out = this.lifeObjects.get(id);
    const pos = patch.pos;
    const outside = pos ? !world.inStudy({ x: pos[0], z: pos[2] }) : !!out;
    if (out) {
      const obj = { ...out, ...patch } as SpaceObject;
      if (!outside) {
        this.lifeObjects.delete(id);
        delete obj.inside;
        if (this.roomLayout?.objects.some(o=>o.id===id)) this.patchRoomCopy(id,obj);
        else this.cb.onSpawn?.(obj);
        const done = () => { saver.setObject(space, id, null); };
        const persisted = this.cb.persistLayout?.();
        if (persisted) void persisted.then(ok => { if (ok) done(); }); else done();
        return true;
      }
      this.lifeObjects.set(id, obj);
      saver.setObject(space, id, { object: obj, region: world.walk.region({ x: obj.pos[0], z: obj.pos[2] }) ?? 'street' });
      if (this.roomLayout) this.sync(this.roomLayout);
      return true;
    }
    if (!outside || !pos) return false;
    const current = this.layout?.objects.find(o => o.id === id);
    if (!current) return false;
    const obj = { ...current, ...patch } as SpaceObject;
    delete obj.inside;
    this.lifeObjects.set(id, obj);
    saver.setObject(space, id, { object: obj, region: world.walk.region({ x: pos[0], z: pos[2] }) ?? 'street' });
    if (this.roomLayout) this.sync(this.roomLayout);
    // Only let the room layout drop the object once the server world save has acknowledged it (prevents loss on failed save;
    // withWorldObjects deduplicates by id in the meantime so the object never duplicates).
    void saver.flush().then(() => {
      if (!saver.failing && this.lifeObjects.has(id) && !this.disposed) this.cb.onDespawn?.(id);
    });
    return true;
  }
  /**
   * An arrival outdoors: the body goes back where this space's world save left it. A reset of the body (a load, a space switch)
   * always asks (`force`); the save arriving after the body was placed asks only once per space, so it never pulls a body that is
   * already walking about.
   */
  private restoreLifePlace(force = false) {
    const saver = this.lifeSave, l = this.layout, ch = this.character;
    if (!saver?.loaded || !this.echoLife || !l || !ch?.ready || (!force && this.placeRestoredFor === this.spaceIdentity)) return;
    if (l.camera.view !== 'first' && l.camera.view !== 'third') return;
    const place = saver.place(this.spaceIdentity);
    if(place && this.echoLife.city.residences.some(b=>place.x>=b.rect.x0 && place.x<=b.rect.x1 && place.z>=b.rect.z0-.4 && place.z<=b.rect.z1)) {
      const gameSave=this.game.saverNow;
      if(!gameSave?.loaded) {this.awaitingResidence=true;return;}
      const owned=gameSave.wallet?.workshop?.properties?.ownedIds;
      this.echoLife.setOwnedHomes(Array.isArray(owned)?owned:[]);
    }
    this.awaitingResidence=false;
    this.placeRestoredFor = this.spaceIdentity;
    if (this.echoLife.ready) this.lifeDoors(this.echoLife);
    if (!place || !this.echoLife.walk.free({ x: place.x, z: place.z })) return;
    const y = place.y ?? this.echoLife.walk.groundAt(place.x, place.z) ?? 0;
    ch.resetPose(new T.Vector3(place.x, y, place.z), place.rotY);
    this.ensureLife();
    ch.setActivity('idle');
    this.resumeHeld=saver.objectsOf(this.spaceIdentity).filter(o=>o.held).map(o=>o.object.id).slice(0,2);
  }
  private bodyOutside(pos: readonly number[]) { return !!this.echoLife && !this.echoLife.inStudy({ x: pos[0], z: pos[2] }); }
  private buildingLife: EchoLifeWorld | null = null;
  private buildingLifePromise: Promise<boolean> | null = null;

  /**
   * Explicitly builds `this.echoLife` without requiring `exploration.active === true` (prevents the
   * Overview -> Explore deadlock while capping failed build retries to 2 attempts).
   */
  async prepareLife(): Promise<boolean> {
    const world = this.echoLife;
    if (!world || this.disposed) return false;
    if (world.ready) return true;
    if (this.buildingLife === world && this.buildingLifePromise) {
      return this.buildingLifePromise;
    }
    if (this.lifeBuildFailures >= 2) return false;

    this.buildingLife = world;
    const pos = this.character?.root.position;
    const seedX = pos ? pos.x : 0;
    const seedZ = pos ? pos.z : 0;

    const promise = world
      .build({ x: seedX, z: seedZ })
      .then(() => {
        if (this.echoLife !== world || this.disposed) return false;
        this.lifeBuildFailures = 0;
        this.elapsedRunSec = 0;
        this.sustainedSlowSec = 0;
        if (!this.preEntryWarmupPromise && world.atmosphere) {
          world.atmosphere.warmupHdris(this.renderer);
          this.atmosphereWarmedFor = world;
        }
        // Patch CSM onto newly built world & lock zone mode before Stage-6 warmup.
        this.csmPatchedObjects.add(world.group);
        this.echoCsm.patchObject(world.group);
        if (this.character?.root && !this.csmPatchedObjects.has(this.character.root)) {
          this.csmPatchedObjects.add(this.character.root);
          this.echoCsm.patchObject(this.character.root);
        }
        const cfg = getRenderConfig(this.qualityTier, this.maxAnisotropy, this.gpuReport.gpuClass);
        const w4 = world as EchoLifeWorldWave4;
        if (w4.collisionWorld) {
          this.exploration.setCollisionWorld(w4.collisionWorld);
        }
        this.syncHomeMirrors(world);
        if (this.exploration.active && !this.insideCityLighting && cfg.shadow.enabled && cfg.shadow.cascades > 0) {
          this.echoCsm.setZoneMode('outdoor');
        }
        // Do NOT race `stageOutdoorWarmup()` against `runPreEntryWarmup()`: `runPreEntryWarmup()` owns Stage-6 warmup!
        if (!this._warmupReady && !this.preEntryWarmupPromise) {
          this.lastWarmedOutdoorKey = '';
          this.shadersPending = true;
        }
        this.wake();
        return true;
      })
      .catch(() => {
        this.lifeBuildFailures++;
        return false;
      })
      .finally(() => {
        if (this.buildingLife === world) {
          this.buildingLife = null;
          this.buildingLifePromise = null;
        }
      });

    this.buildingLifePromise = promise;
    return promise;
  }

  mirrorDiagnostics() {
    return getEchoLifePlanarMirrors().getDiagnostics();
  }

  doorStates() {
    return this.echoLife?.doorStates() ?? {};
  }

  private clearHomeMirrors(): void {
    for (let i = 0; i < this.homeMirrorHandles.length; i++) {
      this.homeMirrorHandles[i].dispose();
    }
    this.homeMirrorHandles.length = 0;
    this.homeMirrorsWorld = null;
  }

  private syncHomeMirrors(world: EchoLifeWorld): void {
    const placements = world.mirrorPlacements;
    if (!world.ready || (this.homeMirrorsWorld === world && this.homeMirrorHandles.length === placements.length)) return;
    this.clearHomeMirrors();
    this.homeMirrorsWorld = world;
    if (placements.length === 0) return;
    const mirrors = getEchoLifePlanarMirrors();
    const parent = world.houseInteriorGroup ?? world.group;
    for (const mp of placements) {
      const handle = mirrors.attachMirrorSurface({
        id: mp.id,
        zoneId: mp.zoneId,
        parent,
        placementMatrix: mp.matrixWorld,
        prepared: { id: 'mirror', parts: [mp.part], box: new T.Box3(), triangles: 0, textureBytes: 0 },
        restoreExteriorPortals: mp.zoneId !== 'bath',
      });
      this.homeMirrorHandles.push(handle);
    }
  }

  private attachBuildingMirror(desc: BuildingMirrorDescriptor): () => void {
    const bldKey = desc.id.split(':')[1] ?? desc.buildingId;
    const bldGroup = this.echoLife?.group.getObjectByName(`life-building:${bldKey}`);
    const parent =
      bldGroup?.getObjectByName('building-interior') ??
      bldGroup ??
      this.echoLife?.group ??
      this.stage;
    const handle = getEchoLifePlanarMirrors().attachMirrorSurface({
      id: desc.id,
      zoneId: desc.buildingId,
      parent,
      placementMatrix: desc.worldMatrix,
      prepared: {
        id: 'mirror',
        parts: [
          {
            geometry: desc.geometry,
            material: null as unknown as T.MeshStandardMaterial,
            role: 'mirror-glass',
          },
        ],
        box: new T.Box3(),
        triangles: 0,
        textureBytes: 0,
      },
      restoreExteriorPortals: true,
    });
    return () => handle.dispose();
  }

  private syncParkedVehiclesNow(): void {
    const world = this.echoLife;
    if (!world?.ready) return;
    const parkedBoxes = this.game.parkedVehicleBoxes(world);
    const w4 = world as EchoLifeWorldWave4;
    if (w4.collisionWorld) {
      const dst = this.parkedCollidersScratch;
      dst.length = parkedBoxes.length;
      for (let i = 0; i < parkedBoxes.length; i++) {
        const b = parkedBoxes[i];
        const prev = dst[i];
        if (prev) {
          (prev as { id: string }).id = `veh:${i}`;
          (prev as { x: number }).x = b.x;
          (prev as { z: number }).z = b.z;
          (prev as { yaw: number }).yaw = b.yaw;
          (prev as { halfWidth: number }).halfWidth = b.hx;
          (prev as { halfLength: number }).halfLength = b.hz;
          (prev as { floorY: number }).floorY = b.y - b.hy;
          (prev as { topRel: number }).topRel = b.hy * 2;
        } else {
          dst[i] = {
            id: `veh:${i}`,
            x: b.x,
            z: b.z,
            yaw: b.yaw,
            halfWidth: b.hx,
            halfLength: b.hz,
            floorY: b.y - b.hy,
            topRel: b.hy * 2,
          };
        }
      }
      w4.collisionWorld.setParkedVehicles(dst);
    }
    this.manip.physics?.setParkedVehicleBoxes(parkedBoxes);
  }

  private ensureLife() {
    const world = this.echoLife;
    if (!world || world.ready || world === this.buildingLife || !this.character?.ready) return;
    void this.prepareLife();
  }

  private patchRoomCopy: (id:string,obj:SpaceObject)=>void = ()=>{};
  constructor(readonly canvas: HTMLCanvasElement, private cb: EngineCallbacks) {
    // Outside the study room the body's place is the world's, never the room layout's: the room keeps its own last place.
    this.patchRoomCopy=(id,obj)=>cb.onObjectState?.(id,obj,"carry-return-"+id);
    const report = cb.onCharacterMoved;
    this.cb = { ...cb, onCharacterMoved: (pos, rotY, floorPose) => {
      const saver = this.lifeSave, space = this.spaceIdentity;
      if (this.bodyOutside(pos)) {
        if (saver && space) {
          const y = this.echoLife?.walk.groundAt(pos[0], pos[2]) ?? pos[1];
          saver.setPlace(space, { x: pos[0], y, z: pos[2], rotY, region: this.echoLife?.walk.region({ x: pos[0], z: pos[2] }) ?? 'street' });
        }
        return;
      }
      if (this.echoLife && saver && space && !this.awaitingResidence) saver.setPlace(space, null);
      report(pos, rotY, floorPose);
    }, onObjectState: (id, patch, merge) => { if (!this.routeObjectState(id, patch)) cb.onObjectState?.(id, patch, merge); } };
    const savedTier = readExplicitSavedQualityTier();
    // Pre-renderer throwaway WebGL probe locks `qualityTier`, `gpuClass` (e.g. `4gb-dgpu` RTX 3050 Laptop -> 'balanced'),
    // and `nativeAntialias` BEFORE `new T.WebGLRenderer(...)` allocates the default framebuffer (saves 47–107 MiB MSAA!).
    const preProbe = savedTier ? null : probeThrowawayWebGlCapabilities();
    const initialTier: QualityTier = savedTier ?? preProbe?.recommendedTier ?? 'balanced';
    const preAniso = Math.max(1, preProbe?.maxAnisotropy ?? 8);
    const preCfg = getRenderConfig(initialTier, preAniso, preProbe?.gpuClass);

    this.renderer = new T.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: preCfg.nativeAntialias,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = T.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFShadowMap;

    // Immediate sync WebGL capability inspection on the live context (always classifies WebGL adapter first).
    const gl = this.renderer.getContext();
    this.gpuReport = probeWebGlCapabilitiesSync(gl);
    this.maxAnisotropy = Math.max(1, this.gpuReport.maxAnisotropy);
    if (savedTier) {
      this.qualityExplicit = true;
      this.qualityTier = savedTier;
    } else {
      this.qualityExplicit = false;
      this.qualityTier = this.gpuReport.recommendedTier;
    }
    this.quality = this.qualityTier === 'ultra' ? 'high' : this.qualityTier;
    const is4GbGpu = this.gpuReport.gpuClass === '4gb-dgpu';
    const initCfg = getRenderConfig(this.qualityTier, this.maxAnisotropy, this.gpuReport.gpuClass);
    setPbrAtlasQuality(this.qualityTier);
    setPbrAtlasAnisotropy(initCfg.anisotropy);
    setGltfTextureTier(this.qualityTier, is4GbGpu);
    setLifeAssetsAnisotropy(initCfg.anisotropy);
    setMaterialsQuality(this.qualityTier, initCfg.anisotropy);
    const residency = getEchoLifeResidencyManager();
    residency.setQualityTier(this.qualityTier, is4GbGpu);
    residency.setBootActive(true);
    // Keep persistent FogExp2 permanently bound from Frame 0 (`density = 0` indoors/overview, NEVER `scene.fog = null`).
    this.outdoorFog.density = 0;
    this.scene.fog = this.outdoorFog;
    this.scene.add(this.studioCamera);

    this.pmrem = new T.PMREMGenerator(this.renderer);
    this.envTex = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTex;
    this.scene.environmentIntensity = 0.28;

    this.camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    this.postFx = new PostFXController(this.renderer, this.scene, this.camera, this.qualityTier);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minPolarAngle = 0.35;
    this.controls.maxPolarAngle = 1.38;
    this.controls.minZoom = 0.35;
    this.controls.maxZoom = 3.5;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = { LEFT: T.MOUSE.ROTATE, MIDDLE: T.MOUSE.DOLLY, RIGHT: T.MOUSE.PAN };
    this.controls.addEventListener('change', () => this.wake());
    this.game = new EchoLifeGameHost(this.stage, this.qualityTier, {
      peerLabels: (camera, width, height) => this.sharedCity?.labels(camera, width, height),
      sharedBikePrompt:()=>this.sharedCity?.bikePrompt() ?? null,
      court:()=>this.sharedCity?.court,
      sharedCity:()=>this.sharedCity,
      windowOpen: () => Boolean(this.layout?.room.windowOpen),
      driveCamera: () => this.exploration.driveCamera,
      cameraPitch: () => this.exploration.lookPitch,
      homeCleanliness: () => this.life?.cleanliness ?? 1,
      onSaveError: () => this.cb.say?.('Echo Life chưa đọc được bản lưu. Tiến trình trên máy chủ đã được giữ lại. Bạn vẫn có thể dùng phòng học.',
        'Echo Life could not read your save. Your server progress is preserved. You can still use the study room.'),
      onHud: hud => this.cb.onGameHud?.(hud),
      onInteract: target => this.cb.onGameInteract?.(target),
      sleep: (bed,approach) => {
        const scale=bed.size/2.05;
        // Measured on bed-single-d83351bc5c2a: exposed pillow at -Z, duvet at 0.456 m.
        const pillow=new T.Vector3(0,.516*scale,-.69*scale)
          .applyAxisAngle(new T.Vector3(0,1,0),bed.rotY).add(new T.Vector3(bed.x,bed.y,bed.z));
        const surface=bed.y+.456*scale;
        return !!this.character?.sitAt(new T.Vector3(bed.x,bed.y,bed.z),bed.rotY,'sleep',surface,true,{
          bed:{pillow,surface,width:1.04*scale,depth:bed.size},approaches:[new T.Vector3(approach.x,bed.y,approach.z)],
        },'city-bed:bedroom');
      },
      sit: seat => {
        const standList = [new T.Vector3(seat.stand.x, seat.sit.y, seat.stand.z)];
        for (let i = 0; i < STAND_CANDIDATE_ANGLES.length; i++) {
          const ang = seat.yaw + STAND_CANDIDATE_ANGLES[i];
          standList.push(new T.Vector3(seat.sit.x + Math.sin(ang) * 0.72, seat.sit.y, seat.sit.z + Math.cos(ang) * 0.72));
        }
        const mobility = /gaming|office/i.test(seat.id) ? 'rolling' : 'stationary';
        return !!this.character?.sitAt(
          new T.Vector3(seat.sit.x, seat.sit.y, seat.sit.z),
          seat.yaw,
          'relax',
          seat.top,
          false,
          { approaches: standList, mobility } as Parameters<Character['sitAt']>[5],
          'city-seat:' + seat.id,
        );
      },
      handsBusy:()=>this.manip.carrying || !!this.character?.motionActive,
      onDrive: kind => {
        const game = this.game.game, ch = this.character, walk = this.echoLife?.walk;
        if (!game || !ch?.ready || !walk || this.manip.carrying || game.riding || game.s.held) return false;
        const vehicle = game[kind];
        if (!vehicle.driving && (ch.body.seat || ch.isApproachingSeat || ch.posture === 'rising')) return false;
        const at = vehicle.toggle(
          ch.root.position,
          p => walk.free(p) && (this.manip.physics ? this.manip.physics.actorFits(p.x, p.z, 0, walk.groundAt(p.x, p.z) ?? 0) : true),
        );
        if (at) {
          if (vehicle.driving) void this.manip.ensurePhysics();
          else {
            const exitY = walk.groundAt(at.x, at.z) ?? 0;
            ch.resetPose(new T.Vector3(at.x, exitY, at.z), vehicle.pose.yaw);
            this.exploration.sanitizeCharacterRoot({ x: at.x, z: at.z });
          }
          this.syncParkedVehiclesNow();
          game.dirty = true;
          this.flushExploration();
        }
        return true;
      },
    });
    this.exploration = new Exploration(canvas, this.stage, {
      character: () => this.character, navigation: () => this.navigation,
      blockers: () => [...Array.from(this.placed.values()).filter(p => !p.obj.hidden).map(p => p.group), ...(this.room ? [this.room.group] : []), ...(this.echoLife?.blockers() ?? [])],
      enclosureVisRevision: () => this.echoLife?.enclosureVisRevision ?? 0,
      activate: id => { this.gameStudied(id); this.cb.onActivate(id); },
      inlineAction: id => { const done = this.manip.interact(id); if (done) this.gameStudied(id); return done; },
      // E: riding → get off; door or carried-object action keeps priority when squarely targeted; resident squarely in front → talk;
      // otherwise what the crosshair holds (a door, a room thing) or what the hands hold keeps E, and the game takes it only when neither does.
      lifeInteract: objectTarget => {
        const g = this.game, f = g.focus;
        const chNow = this.character;
        if (g.isShoweringActive && !objectTarget) {
          g.cancelShower();
          chNow?.setEmbodiedSession(null);
          return true;
        }
        if (this.sharedCity?.court.controls?.joined && this.sharedCity.court.controls.action === 'strike') {
          g.courtAction('strike');
          return true;
        }
        if (!this.manip.carrying && f?.kind === 'npc' && !this.exploration.state().target?.startsWith('life:')) {
          const camera = this.exploration.camera, ray = new T.Raycaster();
          ray.setFromCamera(this.exploration.aim, camera);
          const npc = g.game?.people.walkers.get(f.id), at = npc?.seat?.sit ?? f.at;
          const floor = npc?.seat?.sit.y ?? this.echoLife?.walk.groundAt(at.x, at.z) ?? 0;
          const bottom = this.stage.localToWorld(new T.Vector3(at.x, floor + 0.55, at.z));
          const top = this.stage.localToWorld(new T.Vector3(at.x, floor + (npc?.seat ? 1.1 : 1.7), at.z));
          const hit = new T.Vector3();
          if (
            ray.ray.distanceSqToSegment(bottom, top, hit) < (0.35 * this.stage.scale.x) ** 2 &&
            hit.distanceTo(ray.ray.origin) < this.manip.rayHitDistance + 0.02
          ) {
            return g.interact();
          }
        }
        if (
          (g.game?.people.playerSeat || chNow?.body.seat?.startsWith('city-')) &&
          (chNow?.body.seat || chNow?.isApproachingSeat)
        ) {
          if (!objectTarget) {
            this.standUp();
            return true;
          }
        }
        if (!objectTarget && !this.manip.carrying && g.collectBasketball()) return true;
        if (g.building) { void g.placeBuild(); return true; }
        if (!this.manip.carrying && (g.game?.ridingShared || !objectTarget) && this.sharedCity?.interactBike()) return true;
        if (g.activeDrivenVehicle || g.game?.riding || g.game?.drivenVehicle) return g.interact();
        if (
          !objectTarget &&
          !this.manip.carrying &&
          f &&
          (f.kind === 'seat' || (f.kind === 'spot' && (f.hotspot.action === 'sit' || f.hotspot.action === 'rest'))) &&
          (!chNow || Math.hypot(f.at.x - chNow.root.position.x, f.at.z - chNow.root.position.z) <= 2.35) &&
          !this.exploration.state().target
        ) {
          return g.interact();
        }
        if (!f) return false;
        // The raycast identifies a physical object in three dimensions. A resident's
        // horizontal proximity alone must never take a grasp or a door interaction.
        if (objectTarget || this.manip.carrying) return false;
        return g.interact();
      },
      changed: () => this.reportExploration(),
      save: () => this.flushExploration(), interacted: () => { this.usedObject = null; },
      moved: () => { this.usedObject = null; },
      command: action => { if (action === 'jump') this.game.game?.signal('jumped'); void this.performAction(action); },
      released: () => { this.character?.cancelMotion('input-released'); this.manip.released(); this.reportExploration(); },
      target: camera => this.manip.target(camera),
      stand: () => this.standUp(),
      interrupt: () => {
        if (this.game?.isShoweringActive) {
          this.game.cancelShower();
          this.character?.setEmbodiedSession(null);
        }
        if (this.character?.isApproachingSeat) {
          this.standUp();
          return;
        }
        this.character?.cancelMotion();
        this.manip.interrupt();
      },
      useHeld: () => this.manip.useHeld(),
      occupied: () =>
        this.manip.legsTaken ||
        !!this.character?.motionActive ||
        Boolean(this.character?.isApproachingSeat),
      turnKey: (code, down, repeat) => this.manip.turnKey(code, down, repeat),
      attention: (out) => this.manip.attention(out),
      turning: (dx, dy) => this.manip.turning(dx, dy),
      button: (button, down) => {
        if (
          button === 0 &&
          down &&
          this.echoLife?.ready &&
          this.exploration.active &&
          this.mode !== 'edit' &&
          !this.manip.carrying &&
          !this.manip.toolInHands &&
          !this.character?.motionActive &&
          !this.game?.activeDrivenVehicle
        ) {
          const curTarget = this.manip.target(this.exploration.camera);
          const f = this.game?.focus;
          const chNow = this.character;
          if (
            !curTarget &&
            f &&
            (f.kind === 'seat' || (f.kind === 'spot' && (f.hotspot.action === 'sit' || f.hotspot.action === 'rest'))) &&
            (!chNow || Math.hypot(f.at.x - chNow.root.position.x, f.at.z - chNow.root.position.z) <= 2.35) &&
            this.game.interact()
          ) {
            return;
          }
        }
        this.manip.button(button, down);
      },
      toolInHands: () => this.manip.toolInHands,
      wheel: (dy, shift) => this.manip.wheel(dy, shift),
      walkable: () => (this.echoLife?.ready && this.exploration.active ? this.echoLife.walk : null) ?? this.manip.navigationFor(this.navigation),
      actorFits: (x, z, crouch) =>
        this.manip.physics
          ? this.manip.physics.actorFits(x, z, CROUCH.eye * crouch, this.character?.floorY(x, z) ?? 0)
          : true,
      speedFactor: () => ((this.manip as { isCarryingTool?: boolean }).isCarryingTool ? 1 : this.manip.speedFactor) * (this.game?.speedFactor ?? 1),
      shortcut: action => this.shortcut(action),
      driving: () => Boolean(this.game?.activeDrivenVehicle ?? this.game?.game?.drivenVehicle ?? this.game?.game?.riding),
      driveCar: (dt, throttle, turn, brake, extras) => {
        const game = this.game.game, walk = this.echoLife?.walk, ch = this.character;
        const car = this.game?.activeDrivenVehicle ?? game?.drivenVehicle, physics = this.manip.physics;
        if (!game || !walk || !ch || !car) return;
        if (!physics) void this.manip.ensurePhysics();
        const curSky = this.game.sky();
        game.car.wetRoad = Boolean(curSky && curSky.rain > 0.08);
        if ('snowyRoad' in game.car) {
          (game.car as { snowyRoad?: boolean }).snowyRoad = Boolean(curSky && curSky.snow > 0.1);
        }
        const floor = walk.groundAt(car.pose.x, car.pose.z) ?? 0;
        const nearby = [...game.people.walkers.values(), ...game.crowd(null), ...game.traffic.map(v=>v.pose)].filter(p =>
          Math.hypot(p.x-car.pose.x,p.z-car.pose.z)<6 && Math.abs((walk.groundAt(p.x,p.z) ?? floor)-floor)<1.8);
        const fits = (pose: { x: number; z: number; yaw: number }, hw: number, hl: number) => {
          const y0 = walk.groundAt(pose.x, pose.z) ?? 0;
          const s = Math.sin(pose.yaw), c = Math.cos(pose.yaw);
          if (physics) {
            if (!physics.vehicleFits(pose.x, pose.z, y0, pose.yaw, hw, hl)) return false;
          } else {
            const cw = (this.echoLife as EchoLifeWorldWave4 | null)?.collisionWorld;
            const checkPt = (lx: number, lz: number, rad: number) => {
              const px = pose.x + lx * c + lz * s;
              const pz = pose.z - lx * s + lz * c;
              const py = walk.groundAt(px, pz);
              if (py === null || Math.abs(py - y0) > 0.55) return false;
              return cw
                ? cw.isFree({ x: px, z: pz }, rad / 0.26)
                : walk.freeForPlayer({ x: px, z: pz }, rad);
            };
            const cornerR = Math.min(0.28, Math.max(0.18, hw * 0.65));
            const ox = Math.max(0, hw - cornerR * 0.5);
            const oz = Math.max(0.2, hl - cornerR * 0.5);
            if (
              !checkPt(0, 0, Math.min(0.32, hw)) ||
              !checkPt(-ox, oz, cornerR) ||
              !checkPt(ox, oz, cornerR) ||
              !checkPt(-ox, -oz, cornerR) ||
              !checkPt(ox, -oz, cornerR)
            ) {
              return false;
            }
          }
          return nearby.every(p => Math.abs((p.x-pose.x)*c-(p.z-pose.z)*s)>hw+.22 || Math.abs((p.x-pose.x)*s+(p.z-pose.z)*c)>hl+.22);
        };
        if (!car.consumeExternalDriveIfIdle(throttle, turn, brake)) {
          if (car === game.car && extras) {
            game.car.drive(dt, throttle, turn, brake, fits, {
              handbrake: extras.handbrake ?? brake,
              hornHeld: extras.hornHeld ?? false,
              fromHostLoop: true,
            });
          } else {
            car.drive(dt, throttle, turn, brake, fits, { fromHostLoop: true });
          }
        }
        if (car.pendingDismount && Math.abs(car.speed) <= 0.6) {
          if (this.game.dismountActiveVehicle({ x: car.pose.x, z: car.pose.z }, car.pose.yaw, 'stopped')) {
            this.exploration.sanitizeCharacterRoot({ x: ch.root.position.x, z: ch.root.position.z });
            this.syncParkedVehiclesNow();
            this.flushExploration();
            return;
          }
        }
        const isTwoWheeler = car !== game.car;
        const [seatX,seatZ] = isTwoWheeler ? [0,-.15] : car.spec?.model === 'car_lotus_spider' ? [-.425,-.313] : car.spec?.model === 'car_halo_vector' ? [-.491,.053] : car.spec?.model === 'car_river_sedan' ? [-.425,.385] : [-.35,.383];
        const {x,z,yaw} = car.pose, s=Math.sin(yaw), c=Math.cos(yaw);
        const chassis=car === game.car && game.car.chassis.initialized ? game.car.chassis : null;
        const seatFloor=chassis ? chassis.height+seatX*Math.sin(chassis.roll)-seatZ*Math.sin(chassis.pitch) : walk.groundAt(x,z) ?? 0;
        ch.root.position.set(x+seatX*c+seatZ*s,seatFloor,z-seatX*s+seatZ*c);
        ch.root.rotation.y = yaw;
        if (Math.abs(car.speed)>.05) game.dirty=true;
        return {
          yaw,
          speed: car.speed,
          maxSpeed: car.spec?.maxSpeed,
          steer: car.steer,
          pitch: chassis?.pitch,
          roll: chassis?.roll,
          reversing: car.speed < -0.15,
          isTwoWheeler,
        };
      },
      vehicleAction: (action) => {
        if (action === 'headlights') this.game.toggleHeadlights();
        else if (action === 'horn') this.game.soundVehicleHorn();
        else if (action === 'blinkerLeft') this.game.setBlinker(-1);
        else if (action === 'blinkerRight') this.game.setBlinker(1);
      },
      steer: (x, z, running) => this.manip.steer(x, z, running),
      effort: on => this.manip.effortHold(on),
      cancelHands: () => { this.character?.cancelMotion(); this.manip.cancelManipulation(); this.reportExploration(); },
    });
    this.manip = new Manipulator({
      stage: this.stage,
      placed: this.placed,
      layout: () => this.layout,
      character: () => this.character,
      navigation: () => this.navigation,
      walkable: () => (this.echoLife?.ready && this.exploration.active ? this.echoLife.walk : null) ?? this.navigation,
      exploration: this.exploration,
      room: () => this.room,
      lifeDoor: id => this.echoLife?.door(id) ?? null,
      lifeDoors: () => this.echoLife?.ready && this.exploration.active ? this.echoLife.doors() : [],
      lifeRoots: () => this.echoLife?.ready && this.exploration.active ? this.echoLife.houseRoots() : [],
      reduced: () => this.reduced,
      identity: () => this.spaceIdentity,
      activate: id => this.cb.onActivate(id),
      objectState: (id, patch, merge) => { this.cb.onObjectState?.(id, patch, merge); this.cb.onMoveDone(); },
      spawn: obj => this.cb.onSpawn?.(obj),
      window: open => this.toggleWindow(open),
      curtains: k => this.cb.onCurtains?.(k),
      wearing: id => this.cb.wearing?.(id) ?? false,
      wear: (id, on) => this.cb.onAccessory?.(id, on),
      portal: destination => this.cb.onPortal?.(destination),
      use: (id, activity) => { const ok = this.useObject(id, activity); if (ok && activity) this.cb.onCharacterUse(this.usedObject ?? id, activity); return ok; },
      standUp: () => this.standUp(),
      bodyMoved: () => { const at = this.characterAt(); if (at) this.cb.onCharacterMoved(at.pos, at.rotY); },
      navigationChanged: () => { if (this.layout) this.refreshNavigation(this.layout); },
      bookSession: obj => this.cb.bookSession?.(obj) ?? Promise.resolve(null),
      openLibrary: shelf => this.cb.onLibrary?.(shelf),
      despawn: id => this.cb.onDespawn?.(id),
      library: () => this.library,
      deviceOpen: id => { const r = this.exploration.deviceRect(this.canvas.clientWidth, this.canvas.clientHeight); this.deviceHold = true; if (r) this.cb.onDevice?.(id, r); },
      say: (vi, en) => this.cb.say?.(vi, en),
      vi: () => (this.cb.language?.() ?? 'vi') === 'vi',
      wake: () => this.wake(),
      changed: () => this.reportExploration(),
      uid: () => uid('o'),
      life: () => this.life,
      water: () => this.water,
      toolState: (id, state, immediate) => { const p = this.placed.get(id); if (p) { p.obj.state = state; applyToolLook(p); } this.cb.onToolState?.(id, state, immediate); },
      screenOpen: () => this.deviceHold,
      unreadMessages: () => this.cb.social?.() ?? { unread: 0, invited: false },
    });
    this.water = new WaterWorld({
      stage: this.stage,
      reduced: () => this.reduced,
      life: () => this.life,
      receivers: () => this.manip.waterReceivers(),
      shapes: () => this.manip.waterShapes(),
      half: () => (this.layout?.room.size ?? 6) / 2,
      floorAt: (x, z) => (this.echoLife?.ready ? this.echoLife.walk.groundAt(x, z) ?? 0 : 0),
      quality: () => this.quality,
    });
    this.postFx.setWaterView(this.water.view, this.stage);
    this.life = new LifeWorld({
      stage: this.stage,
      layout: () => this.layout,
      room: () => this.room,
      group: id => this.placed.get(id)?.group ?? null,
      reduced: () => this.reduced,
      commit: life => this.cb.onLife?.(life),
      caption: line => this.cb.onCaption?.(line),
      facts: () => this.manip.factsForLife(),
      timePassed: days => this.manip.timePassed(days),
      spawn: obj => this.cb.onSpawn?.(obj),
      uid: () => uid('o'),
      lightChanged: () => { if (this.layout) { this.applyLighting(); this.placeLamps(); } },
      captionOn: () => this.cb.captionOn?.() ?? false,
      pixels: () => this.renderer.domElement.height / (2 * Math.tan((this.exploration.camera.fov / 2) * Math.PI / 180)) * .01,
      worldAudioActive: () => Boolean(this.echoLife?.ready && this.exploration.active && this.mode !== 'edit'),
    });

    this.exploration.setDeferCameraToPostIk(true);
    this.scene.add(this.exploration.camera);

    // Lock `key.castShadow` per tier for the entire session (never flips indoors or on Low!).
    this.key.castShadow = initCfg.shadow.enabled;
    const initShadowSize = Math.max(1024, initCfg.shadow.mapSize || 1024);
    this.currentShadowMapSize = initShadowSize;
    this.key.shadow.mapSize.set(initShadowSize, initShadowSize);
    this.renderer.shadowMap.enabled = initCfg.shadow.enabled;
    this.renderer.shadowMap.autoUpdate = initCfg.shadow.enabled && initCfg.shadow.cadence === 1;
    this.renderer.shadowMap.needsUpdate = initCfg.shadow.enabled;
    this.key.shadow.camera.left = -6; this.key.shadow.camera.right = 6; this.key.shadow.camera.top = 6; this.key.shadow.camera.bottom = -6;
    this.key.shadow.camera.near = 1; this.key.shadow.camera.far = 40;
    this.key.shadow.bias = -0.0003; this.key.shadow.normalBias = 0.008; this.key.shadow.radius = 3;
    // Strict directional light order for EchoCsmSystem:
    // [0] primary key (Cascade 0) -> [1..2] CSM shadow carriers -> [3] windowLight -> [4] fill.
    this.scene.add(this.hemi, this.key, this.key.target);
    this.echoCsm = new EchoCsmSystem(this.scene, this.key, this.qualityTier, undefined, this.gpuReport.gpuClass);
    this.scene.add(this.windowLight, this.windowLight.target, this.fill, this.fill.target);
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const l = new T.PointLight('#ffd9a0', 0, 2.5, 1.6);
      this.lamps.push(l);
      this.stage.add(l);
      const halo = new T.Sprite(new T.SpriteMaterial({ map: haloTexture(), color: '#ffd9a0', transparent: true, depthWrite: false, blending: T.AdditiveBlending, opacity: 0 }));
      halo.scale.setScalar(0.7);
      halo.visible = false;
      this.halos.push(halo);
      this.stage.add(halo);
    }
    window.requestIdleCallback?.(() => { if (!this.disposed) prepareContactAudio(); }, { timeout: 2000 });
    this.selectionBox.visible = false;
    (this.selectionBox.material as T.LineBasicMaterial).depthTest = false;
    this.selectionBox.renderOrder = 10;
    this.scene.add(this.stage, this.selectionBox);
    this.hoverBox.visible = false;
    this.scene.add(this.hoverBox);

    setBuildingMirrorHook((desc) => this.attachBuildingMirror(desc));
    setVehiclePrewarmHook((obj) => this.prewarmStreamedObject(obj, 'imminent'));

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('wheel', this.onStudioWheel, { passive: false });
    canvas.addEventListener('webglcontextlost', this.onLost);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
    if (typeof window !== 'undefined') {
      (window as unknown as { __studyWorld?: StudyWorld }).__studyWorld = this;
    }

    this.installProfileHandle();
    // Non-blocking WebGPU adapter probe refines masked WebGL strings ONLY BEFORE warmup unlocks
    // (never silently re-tiers mid-session or mid-Overview after unlock, preventing mid-run shader recompiles!).
    void probeGpuCapabilities(gl).then((report) => {
      if (this.disposed) return;
      this.gpuReport = report;
      this.maxAnisotropy = Math.max(1, report.maxAnisotropy);
      if (!this._warmupReady && !this.hasUnlockedFrame && !this.qualityExplicit && report.recommendedTier !== this.qualityTier) {
        this.applyQualityTier(report.recommendedTier);
        try {
          window.dispatchEvent(new CustomEvent('echo-life:quality-tier', { detail: { tier: this.qualityTier } }));
        } catch { /* headless */ }
      } else {
        const cfg = getRenderConfig(this.qualityTier, this.maxAnisotropy, this.gpuReport.gpuClass);
        setPbrAtlasAnisotropy(cfg.anisotropy);
        setLifeAssetsAnisotropy(cfg.anisotropy);
        setMaterialsQuality(this.qualityTier, cfg.anisotropy);
        getEchoLifeResidencyManager().setQualityTier(this.qualityTier, this.gpuReport.gpuClass === '4gb-dgpu');
        this.updateResidencyFixedBreakdown();
      }
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────────────────────────────
  start() {
    if (this.running || this.disposed || this.held || document.hidden) return;
    this.running = true;
    this.lastFrameMs = performance.now();
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.manip.silenceWater();
    this.life.silenceWeather();
    this.game?.worldAudio?.suspend();
  }
  setHeld(held:boolean){this.held=held;if(held)this.stop();else this.start();}
  /** The desktop is on top of the room: the room rests until the player comes back, one frame kept behind the desktop's edges. */
  private deviceHold = false;
  leaveDevice() { this.deviceHold = false; this.manip.leaveDevice(); this.start(); }
  /** Where the screen is on the page now (the window changed size while the desktop was open). */
  deviceRect() { this.resize(); this.exploration.camera.updateProjectionMatrix(); this.exploration.camera.updateMatrixWorld(); return this.exploration.deviceRect(this.canvas.clientWidth, this.canvas.clientHeight); }
  private wake() { if (!this.running && !document.hidden) this.start(); }
  private onVisibility = () => {
    if (document.hidden) {
      this.stop();
    } else {
      this.lastFrameMs = performance.now();
      this.start();
    }
  };
  private onLost = (e: Event) => { e.preventDefault(); this.stop(); this.cb.onFail('context-lost'); };

  private readonly drawBufSizeScratch = new T.Vector2();

  private updateResidencyFixedBreakdown(): void {
    const cfg = getRenderConfig(this.qualityTier, this.maxAnisotropy, this.gpuReport.gpuClass);
    this.renderer.getDrawingBufferSize(this.drawBufSizeScratch);
    const pixels = Math.max(1, this.drawBufSizeScratch.x * this.drawBufSizeScratch.y);
    const msaaBytesPerPx = cfg.nativeAntialias ? 40 : 0;
    const postFxLive = cfg.postfx.enabled && !this.postFx?.diagnostics.fallbackReason;
    const reflBytes = cfg.water.planarReflection ? Math.round(pixels * 0.25 * 8) : 0;
    const renderTargetsBytes = Math.round(pixels * ((postFxLive ? 50 : 16) + msaaBytesPerPx)) + reflBytes;

    let shadowMapsBytes = 0;
    if (cfg.shadow.enabled) {
      const csmSizes = this.echoCsm?.config.mapSizes;
      const csmCount = this.echoCsm?.config.cascades ?? 0;
      if (csmSizes && csmCount > 0) {
        for (let i = 0; i < csmCount; i++) {
          const sz = csmSizes[i] ?? this.currentShadowMapSize;
          shadowMapsBytes += sz * sz * 8;
        }
      } else {
        const sz = Math.max(512, this.currentShadowMapSize);
        shadowMapsBytes = sz * sz * 8;
      }
    }

    const pmremSlots = this.qualityTier === 'low' ? 0 : this.qualityTier === 'balanced' ? 2 : 4;
    const pmremBytes = Math.round((pmremSlots * 6.5 + 12) * 1024 * 1024);
    const geometryBytes = this.renderer.info.memory.geometries * 140 * 1024;

    this.fixedBreakdownCache.renderTargetsBytes = renderTargetsBytes;
    this.fixedBreakdownCache.shadowMapsBytes = shadowMapsBytes;
    this.fixedBreakdownCache.pmremBytes = pmremBytes;
    this.fixedBreakdownCache.geometryBytes = geometryBytes;
    getEchoLifeResidencyManager().setFixedGpuBreakdown(this.fixedBreakdownCache);
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    const cfg = getRenderConfig(this.qualityTier, this.maxAnisotropy, this.gpuReport.gpuClass);
    // Enforce igpuRenderScale (0.75x) STRICTLY on Low + iGPU/software; RTX 5070 dGPU stays 1.0 across all tiers!
    const igpuScale =
      this.qualityTier === 'low' &&
      (this.gpuReport.gpuClass === 'igpu' || this.gpuReport.gpuClass === 'software')
        ? cfg.igpuRenderScale
        : 1.0;
    const dpr = Math.min(window.devicePixelRatio || 1, cfg.dprCap) * igpuScale;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.postFx?.setSize(w, h);
    this.postFx?.setWaterView(this.water?.view ?? null, this.stage);
    const aspect = w / Math.max(1, h);
    const view = Math.max(4.6, 5.4 / Math.max(0.3, aspect));
    this.camera.left = -view * aspect; this.camera.right = view * aspect; this.camera.top = view; this.camera.bottom = -view;
    this.camera.updateProjectionMatrix();
    this.studioCamera.aspect = aspect;
    this.studioCamera.updateProjectionMatrix();
    this.exploration?.resize(w, h);
    this.updateResidencyFixedBreakdown();
  }

  private applyQualityTier(tier: QualityTier) {
    if (this.appliedInitialTier && tier === this.qualityTier) {
      this.resize();
      return;
    }
    this.appliedInitialTier = true;
    const is4GbGpu = this.gpuReport.gpuClass === '4gb-dgpu';
    const cfg = getRenderConfig(tier, this.maxAnisotropy, this.gpuReport.gpuClass);
    this.qualityTier = tier;
    this.quality = tier === 'ultra' ? 'high' : tier;
    this.lastWarmedOutdoorKey = '';
    this.shadersPending = true;
    this.sustainedSlowSec = 0;

    this.key.castShadow = cfg.shadow.enabled;
    this.renderer.shadowMap.enabled = cfg.shadow.enabled;
    this.renderer.shadowMap.autoUpdate = cfg.shadow.enabled && cfg.shadow.cadence === 1;
    this.renderer.shadowMap.needsUpdate = cfg.shadow.enabled;
    if (cfg.shadow.enabled && cfg.shadow.mapSize > 0 && cfg.shadow.mapSize !== this.currentShadowMapSize) {
      this.currentShadowMapSize = cfg.shadow.mapSize;
      this.key.shadow.mapSize.set(cfg.shadow.mapSize, cfg.shadow.mapSize);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null as unknown as T.WebGLRenderTarget;
    }

    this.postFx.setTier(tier);
    this.echoCsm.setTier(tier, this.gpuReport.gpuClass);
    setPbrAtlasQuality(tier);
    setPbrAtlasAnisotropy(cfg.anisotropy);
    setGltfTextureTier(tier, is4GbGpu);
    getEchoLifeResidencyManager().setQualityTier(tier, is4GbGpu);
    setLifeAssetsAnisotropy(cfg.anisotropy);
    setMaterialsQuality(tier, cfg.anisotropy);
    this.echoLife?.setQuality(tier, cfg.anisotropy, is4GbGpu);
    this.game.setQuality(tier);
    this.resize();
  }

  /** Canonical 4-tier graphics selector (`low` | `balanced` | `high` | `ultra`) consumed by StudySpace Settings & QA. */
  setQualityTier(tier: QualityTier) {
    if (!isQualityTier(tier)) return;
    const explicitSaved = readExplicitSavedQualityTier();
    if (!this.didInitialTierSync) {
      this.didInitialTierSync = true;
      if (!explicitSaved) {
        // First mount with no saved user preference: keep hardware-detected tier (e.g. RTX 5070 -> 'ultra', iGPU -> 'low').
        this.applyQualityTier(this.qualityTier);
        if (this.qualityTier !== tier) {
          try {
            window.dispatchEvent(new CustomEvent('echo-life:quality-tier', { detail: { tier: this.qualityTier } }));
          } catch { /* headless */ }
        }
        return;
      }
    }
    this.qualityExplicit = true;
    this.applyQualityTier(tier);
  }

  /** Backward-compatible 3-tier quality setter (`low` | `balanced` | `high`). */
  setQuality(q: Quality) {
    this.didInitialTierSync = true;
    this.qualityExplicit = true;
    this.applyQualityTier(q);
  }

  /** Live telemetry snapshot consumed by StudySpace F3 Performance HUD & QA benchmarks. */
  getPerfStats(): PerfTelemetry {
    const info = this.renderer.info;
    const frameMs = +this.emaFrameMs.toFixed(2);
    const fps = frameMs > 0.1 ? Math.round(1000 / frameMs) : 0;
    const gpuLabel =
      this.gpuReport.webgpuAdapter?.description ||
      this.gpuReport.webglRenderer ||
      undefined;
    return {
      fps,
      frameMs,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
      qualityTier: this.qualityTier,
      gpuLabel,
    };
  }

  setReduced(r: boolean) { this.reduced = r; }
  setMusic(on: boolean) { this.musicOn = on; }
  setMode(mode: 'use' | 'edit', selection: string[]) {
    if (mode !== this.mode) {
      if (mode === 'edit') { this.manip.settle(); this.explorationBeforeEdit = this.exploration.view; this.exploration.setView('overview'); }
      else this.exploration.setView(this.explorationBeforeEdit);
      if (this.layout) this.applyLighting();
    }
    this.mode = mode;
    this.selection = selection;
    this.controls.mouseButtons.LEFT = T.MOUSE.ROTATE;
    this.controls.enabled = !this.exploration.active;
    this.updateSelection();
    this.placed.forEach((p) => p.group.traverse((o) => { o.userData.editable = mode === 'edit'; }));
  }

  dispose() {
    if (typeof window !== 'undefined') {
      const debug = window as Window & { __studyWorld?: StudyWorld; __studyQa?: unknown };
      if (debug.__studyWorld === this) delete debug.__studyWorld;
      if (this.qa) delete debug.__studyQa;
      const win = window as Window & { __EC_ECHO_LIFE_PROFILE__?: EchoLifeProfileHandle };
      if (win.__EC_ECHO_LIFE_PROFILE__) {
        delete win.__EC_ECHO_LIFE_PROFILE__;
      }
    }
    setBuildingMirrorHook(undefined);
    setVehiclePrewarmHook(undefined);
    this.clearHomeMirrors();
    this.game?.dispose();
    this.disposed = true;
    this.outdoorWarmupEpoch++;
    this.outdoorWarmupInFlight = false;
    this.preEntryWarmupPromise = null;
    this.lifeSaveOff?.(); this.lifeSaveOff = null;
    void this.lifeSave?.flush();
    (this.echoLife as EchoLifeWorldWave4 | null)?.lightGroup?.removeFromParent();
    this.exploration.setCollisionWorld(null);
    this.echoLife?.setChunkSolidsListener(undefined);
    this.echoLife?.setPrewarmObject(undefined);
    this.echoLife?.dispose(); this.echoLife = null;
    this.atmosphereWarmedFor = null;
    this.cachedWindowView = null;
    this.cachedPeopleGroup = null;
    this.transmissiveStudyMats.clear();
    this.stop();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onStudioWheel);
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.controls.dispose();
    this.exploration.dispose();
    this.manip.dispose();
    this.life.dispose();
    this.water.dispose();
    this.echoCsm.dispose();
    this.postFx.dispose();
    disposeEchoLifePlanarMirrors();
    this.restoreStudioLights();
    setEchoLifePlayerHandRight(null);
    this.normalPassExcludes.length = 0;
    this.normalExcludeWorld = null;
    this.hoverBox.geometry.dispose(); (this.hoverBox.material as T.Material).dispose();
    this.placed.forEach((p) => this.removePlaced(p));
    this.placed.clear();
    this.room?.dispose();
    this.character?.dispose();
    disposeStudyAssets(); disposeGatewayAssets();
    this.petAbort?.abort();
    this.pet?.dispose();
    this.halos.forEach((h) => h.material.dispose());
    this.envTex?.dispose();
    this.pmrem.dispose();
    this.selectionBox.geometry.dispose();
    (this.selectionBox.material as T.Material).dispose();
    disposeMaterials();
    disposeGeometries();
    forgetCasts();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  // ── Layout → scene ────────────────────────────────────────────────────────────────────────────────────
  sync(layout: Layout, spaceIdentity = this.spaceIdentity) {
    const switched = spaceIdentity !== this.spaceIdentity;
    if (switched) { this.manip.reset(); this.lastPhysicsLayout = ''; this.elapsedRunSec = 0; this.sustainedSlowSec = 0; }
    if (switched) { this.spaceIdentity = spaceIdentity; this.usedObject = null; this.standingExit = false; this.scopeKey = ''; }
    const first = !this.layout;
    this.roomLayout = layout;
    layout = this.withWorldObjects(layout);
    this.layout = layout;
    this.stage.scale.setScalar(layout.stage.scale);
    this.stage.position.set(layout.stage.offsetX, 0, layout.stage.offsetZ);
    if (layout.quality !== this.qualityPreference) {
      const prevPref = this.qualityPreference;
      this.qualityPreference = layout.quality;
      // Only propagate 3-tier layout.quality before warmup/unlock when no explicit 4-tier setting exists;
      // user Settings changes always route directly through `setQualityTier(tier)`, so late API layout loads
      // NEVER silently re-tier a warmed session!
      if (
        prevPref !== null &&
        !this._warmupReady &&
        !this.hasUnlockedFrame &&
        !this.qualityExplicit &&
        layout.quality !== this.quality
      ) {
        this.applyQualityTier(layout.quality);
      }
    }

    // Opening the window animates the room that is there; it is not a new room.
    const roomKey = JSON.stringify({ ...layout.room, windowOpen: undefined });
    if (roomKey !== this.roomKey) {
      this.shadersPending = true;
      this.roomKey = roomKey;
      if (this.room) { this.stage.remove(this.room.group); this.room.dispose(); this.room = null; }
      if (layout.room.visible) {
        this.room = buildRoom(layout.room, this.reduced, this.lifeWanted(layout) ? this.lifeDoorway(layout.room.size) : null);
        this.echoCsm.patchObject(this.room.group);
        this.stage.add(this.room.group);
      }
      this.cachedWindowView = this.room?.group.getObjectByName('window-view') ?? null;
      this.applyLighting();
    }
    const lifeKey = this.lifeWanted(layout) ? JSON.stringify([layout.room.size, layout.room.theme]) : '';
    if (lifeKey !== this.echoLifeKey) {
      this.echoLifeKey = lifeKey;
      this.clearHomeMirrors();
      (this.echoLife as EchoLifeWorldWave4 | null)?.lightGroup?.removeFromParent();
      this.exploration.setCollisionWorld(null);
      this.echoLife?.setChunkSolidsListener(undefined);
      this.echoLife?.setPrewarmObject(undefined);
      this.echoLife?.dispose(); this.echoLife = null; this.atmosphereWarmedFor = null;
      this.lifeBuildFailures = 0;
      this.normalExcludeWorld = null; this.normalPassExcludes.length = 0;
      this.cachedPeopleGroup = null;
      this.lastPruneZone = null; this.lastPruneTransitions = -1; this.zonePrunePending = false;
      this.lifeSolidsFor = null; this.lifeSolidsVersion = -1;
      this.lastDoorPlugsFor = null; this.lastDoorPlugsVersion = -1; this.lastSavedDoorsVersion = -1;
      if (this.manip.physics) {
        for (const k of this.physicsBucketKeys) this.manip.physics.removeWorldSolidBucket(k);
        this.manip.physics.setWorldSolids([]);
        this.manip.physics.setParkedVehicleBoxes([]);
      }
      this.physicsBucketKeys.clear();
      if (lifeKey) {
        const engine = this, size = layout.room.size;
        this.echoLife = new EchoLifeWorld(size, layout.room.theme, this.qualityTier, {
          free: p => engine.navigation?.free(p) ?? false,
          get half() { return engine.navigation?.half ?? size / 2 - .2; },
        }, this.maxAnisotropy);
        this.echoLife.setPrewarmObject((obj, priority) => engine.prewarmStreamedObject(obj, priority));
        this.echoLife.setObstacles(() => engine.exploration.active ? engine.game.playerObstacles(engine.character?.root.position ?? null) : []);
        this.stage.add(this.echoLife.group);
        const w4 = this.echoLife as EchoLifeWorldWave4;
        if (w4.lightGroup) this.stage.add(w4.lightGroup);
        if (w4.collisionWorld) this.exploration.setCollisionWorld(w4.collisionWorld);
      }
    }
    this.room?.setWindowOpen(!!layout.room.windowOpen);

    const seen = new Set<string>();
    for (const obj of layout.objects) {
      seen.add(obj.id);
      const key = `${obj.kind}|${obj.color ?? ''}|${CARE_IDS.has(obj.kind) && careReady() ? 1 : 0}`;
      if (CARE_IDS.has(obj.kind) && !careReady()) this.wantCare();
      let p = this.placed.get(obj.id);
      if (p && p.key !== key) { this.removePlaced(p); p = undefined; }
      if (!p) {
        this.shadersPending = true;
        const group = build(obj.kind, { color: obj.color });
        group.userData.objectId = obj.id;
        group.traverse((o) => {
          o.userData.objectId = obj.id;
          const m = o as T.Mesh;
          if (!m.isMesh || !m.material) return;
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (let mi = 0; mi < mats.length; mi++) {
            const mat = mats[mi];
            // Permanently disable physical transmission (`transmission = 0`) at registration so
            // doorway crossings NEVER trigger `mat.needsUpdate = true` or `renderTransmissionPass()`!
            if (mat instanceof T.MeshPhysicalMaterial && mat.transmission > 0 && !this.transmissiveStudyMats.has(mat)) {
              this.transmissiveStudyMats.set(mat, {
                transmission: mat.transmission,
                opacity: mat.opacity,
                transparent: mat.transparent,
                depthWrite: mat.depthWrite,
              });
              mat.transmission = 0;
              mat.transparent = true;
              mat.opacity = Math.min(0.42, mat.opacity > 0.05 && mat.opacity < 0.99 ? mat.opacity : 0.36);
              mat.depthWrite = false;
              mat.needsUpdate = true;
            }
          }
        });
        this.echoCsm.patchObject(group);
        if (obj.state?.book) dressBookFace(group, obj);
        group.userData.kind = obj.kind;
        const item = CATALOG_BY_ID[obj.kind];
        if (item?.tops) group.userData.footprint = { w: item.size[0], d: item.size[1], tops: item.tops };
        // A soft dark where a thing meets what it stands on: it sits on the desk, it does not float over it.
        const blob = item && item.place !== 'wall' && !item.flat ? this.makeBlob(item) : null;
        if (blob) group.add(blob);
        this.stage.add(group);
        p = { obj, group, blob, key, lights: (group.userData.lights as LightSpec[]) ?? [] };
        this.placed.set(obj.id, p);
        if (this._warmupReady) {
          if (CARE_IDS.has(obj.kind)) {
            prewarmToolBendMaterial(this.renderer, this.activeCamera, group);
          }
          void this.prewarmStreamedObject(group, 'imminent');
        }
      }
      p.obj = obj;
      if (CARE_IDS.has(obj.kind)) applyToolLook(p);
      if ((!this.drag || this.drag.id !== obj.id) && this.activeRollingChairId !== obj.id && !this.manip.physics?.owns(obj.id) && !this.manip.moving(obj.id) && this.character?.furnitureInHand() !== obj.id) {
        p.group.position.set(...obj.pos);
        if (obj.quat) p.group.quaternion.set(...obj.quat);
        else { p.group.rotation.set(0, obj.rotY, obj.state?.tilt ?? 0); }
      }
      // A book of the library that became a thing of the room shows its own face.
      if (p.obj.state?.book && !p.group.getObjectByName('book-face')) dressBookFace(p.group, p.obj);
      // A row of books that has given some away shows the ones it still has.
      const books = p.group.userData.books as T.Object3D[] | undefined;
      if (books) books.forEach((b, i) => { b.visible = !obj.state?.taken?.includes(i); });
      // A drawer left open stays open, unless the hand is on it.
      const sliders = p.group.userData.sliders as Slider[] | undefined;
      if (sliders && !this.manip.drawerOn(p)) sliders.forEach((s, i) => { s.open = obj.drawers?.[i] ?? 0; s.node.position.copy(s.axis).multiplyScalar(s.travel * s.open); });
      p.group.scale.setScalar(obj.scale);
      p.group.visible = !obj.hidden;
      if (p.blob) p.blob.visible = !this.manip.physics?.owns(obj.id) && !obj.quat;
    }
    for (const [id, p] of this.placed) if (!seen.has(id)) { this.removePlaced(p); this.placed.delete(id); }
    // A thing in a drawer rides on the drawer; everything else stands in the room.
    for (const p of this.placed.values()) {
      const slider = p.obj.inside ? (this.placed.get(p.obj.inside.host)?.group.userData.sliders as Slider[] | undefined)?.[p.obj.inside.slot] : null;
      const parent = slider?.node ?? this.stage;
      if (p.group.parent !== parent && !this.manip.physics?.owns(p.obj.id)) parent.add(p.group);
    }
    this.placeLamps();
    this.life.sync(layout, this.spaceIdentity);
    // A book taken down leaves its gap on the shelf; one put back is a spine again (nothing is rebuilt when nothing changed).
    this.dressShelves();
    this.syncCharacter(layout);
    this.syncPet(layout);
    // Exclude transient tool/vessel state (`wet`, `load`, `fill`, `dirt`, `on`, `sips`, `tea`, `soil`, `temp`) across all objects
    // so sweeping, mopping, running water, and vessel dipping never tear down room colliders mid-stroke.
    const physicsLayout = JSON.stringify([
      layout.room.size,
      layout.objects.map(o =>
        o.state
          ? {
              ...o,
              state: {
                ...o.state,
                wet: undefined,
                load: undefined,
                fill: undefined,
                dirt: undefined,
                on: undefined,
                sips: undefined,
                tea: undefined,
                soil: undefined,
                temp: undefined,
              },
            }
          : o,
      ),
    ]);
    if (physicsLayout !== this.lastPhysicsLayout) { this.lastPhysicsLayout = physicsLayout; this.manip.syncRoom(); }
    this.room?.setCurtains(layout.room.curtains ?? 0);
    if (first || switched) this.applyCamera(layout.camera);
    if (!layout.character.visible && this.exploration.active) this.setView('overview');
    this.updateSelection();
    this.scheduleToolWarmup();
    this.wake();
  }

  private warmedTools = new Set<string>();
  private warmupPending = false;
  /** Pre-build grasp BVHs for long tools during browser idle slices so first broom/mop pickup has zero main-thread spike. */
  private scheduleToolWarmup() {
    if (this.warmupPending || this.disposed || typeof window === 'undefined') return;
    const queue: Placed[] = [];
    for (const p of this.placed.values()) {
      if (!p.obj.kind.startsWith('tool.')) continue;
      const key = `${p.obj.kind}|${p.obj.scale}|${p.group.userData.asset ?? 'fallback'}`;
      if (!this.warmedTools.has(key)) queue.push(p);
    }
    if (!queue.length) return;
    this.warmupPending = true;
    const schedule = typeof window.requestIdleCallback === 'function'
      ? (fn: () => void) => window.requestIdleCallback(fn, { timeout: 600 })
      : (fn: () => void) => window.setTimeout(fn, 24);
    const step = () => {
      if (this.disposed) { this.warmupPending = false; return; }
      const p = queue.shift();
      if (!p) { this.warmupPending = false; return; }
      const key = `${p.obj.kind}|${p.obj.scale}|${p.group.userData.asset ?? 'fallback'}`;
      if (!this.warmedTools.has(key) && this.placed.get(p.obj.id) === p) {
        this.warmedTools.add(key);
        surfaceOf(p.group, `${p.obj.kind}|${p.obj.scale}`, o => !graspable(o));
        surfaceOf(p.group, 'shaft|' + p.obj.kind + '|' + (p.group.userData.asset ?? 'fallback'),
          o => !/^(Handle|Pole|Grip)([._]\d+)?$/.test(o.userData.name ?? o.name));
      }
      if (queue.length) schedule(step);
      else this.warmupPending = false;
    };
    schedule(step);
  }

  private careAsked = false;
  /** The kit's file is only asked for by a room that has some of it. When it arrives, what stood in for it is replaced. */
  private wantCare() {
    if (this.careAsked) return;
    this.careAsked = true;
    void loadCareAssets()?.then(() => { if (!this.disposed && this.layout && careReady()) this.sync(this.layout); });
  }
  private dayNow() {
    const l = this.layout!, rain = this.life?.rain ?? 0;
    return l.room.windowView === 'live' ? Math.max(.03, (this.life?.weather.sun ?? .8) * (1 - rain * .55)) : l.room.daylight * (1 - rain * .42);
  }
  private makeBlob(item: CatalogItem) {
    const m = new T.Mesh(new T.PlaneGeometry(item.size[0] * 1.35, item.size[1] * 1.35), new T.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.55 }));
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.004;
    m.renderOrder = 1;
    m.userData.blob = true;
    // It darkens what is under the thing and is not part of the thing: nothing that measures the thing counts it.
    m.geometry.boundingBox = new T.Box3(new T.Vector3(), new T.Vector3());
    return m;
  }

  private removePlaced(p: Placed) {
    this.stage.remove(p.group);
    (p.group.userData.toolBendMaterial as T.Material | undefined)?.dispose();
    if (p.blob) { p.blob.geometry.dispose(); (p.blob.material as T.Material).dispose(); }
    p.group.traverse((o) => {
      const own = o.userData.ownTextures as T.Texture[] | undefined;
      own?.forEach((t) => t.dispose());
      const m = o as T.Mesh;
      if (m.isMesh && m.material) {
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (let i = 0; i < mats.length; i++) {
          if (mats[i] instanceof T.MeshPhysicalMaterial) {
            this.transmissiveStudyMats.delete(mats[i] as T.MeshPhysicalMaterial);
          }
        }
      }
    });
  }

  private outdoorLighting = false;
  private insideCityLighting = false;
  private outdoorShadowExtent = 6;
  private shadowFrame = 0;
  private dialogueZoom = 0;
  private vramClock = 0;
  private lastPruneZone: string | null = null;
  private lastPruneTransitions = -1;
  private zonePrunePending = false;
  private normalPassExcludes: T.Object3D[] = [];
  private normalExcludeWorld: EchoLifeWorld | null = null;
  private normalExcludeVegCount = -1;
  private normalExcludeTransitions = -1;
  private normalExcludeSolidsVer = -1;
  private normalExcludeHasPeople = false;
  private lastLampQueryPos = new T.Vector3(Infinity, 0, Infinity);
  private lastLampSolidsVer = -1;
  private lastLampPoolCount = 0;
  private cachedNearbyLamps: T.Vector3[] = [];
  private outdoorFog = new T.FogExp2('#c5ddf2', .0014);

  /**
   * Refreshes the cached non-SSAO exclusion list for Ultra `ScopedNormalPass` ONLY when chunks,
   * world solids, or staggered vegetation loads change (0.00 ms steady-state per-frame cost).
   * Excludes sky dome, distant skyline, weather particles, grass tufts, river water, lamp halos,
   * distant LOD1 trees, alpha-tested leaf cards, and `depthWrite: false` additive overlays.
   */
  private refreshNormalPassExcludes(world: EchoLifeWorld | null): void {
    const vegLoaded = world?.stats.vegetation?.loadedSpecies ?? -1;
    const transitions = world?.stats.streaming?.transitions ?? -1;
    const solidsVer = world?.solidsVersion ?? -1;
    // Cached reference (zero per-frame full-scene `getObjectByName` traversal!).
    const peopleGroup = this.game.peopleGroup ?? (this.cachedPeopleGroup?.parent === this.stage ? this.cachedPeopleGroup : null);
    if (peopleGroup) this.cachedPeopleGroup = peopleGroup;
    const hasPeople = Boolean(peopleGroup);
    if (
      world === this.normalExcludeWorld &&
      vegLoaded === this.normalExcludeVegCount &&
      transitions === this.normalExcludeTransitions &&
      solidsVer === this.normalExcludeSolidsVer &&
      hasPeople === this.normalExcludeHasPeople
    ) {
      return;
    }
    this.normalExcludeWorld = world;
    this.normalExcludeVegCount = vegLoaded;
    this.normalExcludeTransitions = transitions;
    this.normalExcludeSolidsVer = solidsVer;
    this.normalExcludeHasPeople = hasPeople;

    const out = this.normalPassExcludes;
    out.length = 0;
    for (let i = 0; i < this.halos.length; i++) out.push(this.halos[i]);

    const isDepthlessOrFoliageCard = (mat: T.Material | T.Material[] | undefined, inVegetation: boolean): boolean => {
      if (!mat) return false;
      const list = Array.isArray(mat) ? mat : [mat];
      if (!list.length) return false;
      let allNoDepth = true;
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (m.depthWrite !== false) allNoDepth = false;
        if (inVegetation && (m as T.MeshStandardMaterial).alphaTest > 0) return true;
      }
      return allNoDepth;
    };

    const walk = (node: T.Object3D, inVegetation: boolean) => {
      if (NORMAL_PASS_SKIP_GROUPS.has(node.name)) {
        out.push(node);
        return;
      }
      const veg = inVegetation || node.name === 'echo-life-vegetation-system';
      if (veg && node.name.includes('-lod1-')) {
        out.push(node);
        return;
      }
      const mesh = node as T.Mesh;
      if (mesh.isMesh && isDepthlessOrFoliageCard(mesh.material, veg)) {
        out.push(node);
        return;
      }
      const children = node.children;
      for (let i = 0; i < children.length; i++) walk(children[i], veg);
    };

    if (world?.group) walk(world.group, false);
    if (peopleGroup) out.push(peopleGroup);
    if (this.character?.root) out.push(this.character.root);
  }
  private setShadowExtent(half: number) {
    if (this.outdoorShadowExtent === half) return;
    this.outdoorShadowExtent = half;
    this.key.shadow.camera.left = -half; this.key.shadow.camera.right = half;
    this.key.shadow.camera.top = half; this.key.shadow.camera.bottom = -half;
    this.key.shadow.camera.far = half > 10 ? Math.max(85, half * 2.8) : 40;
    this.key.shadow.camera.updateProjectionMatrix();
  }
  private applyLighting() {
    this.scene.background = null;
    // Keep `scene.fog` continuously bound as `FogExp2` (`density = 0` indoors instead of `null`)
    // so `USE_FOG` shader permutations stay 100% invariant across Study Room <-> Outdoors <-> City Buildings!
    this.outdoorFog.density = 0;
    if (this.scene.fog !== this.outdoorFog) this.scene.fog = this.outdoorFog;
    this.outdoorLighting = false;
    this.insideCityLighting = false;
    this.setShadowExtent(6);
    const l = this.layout!;
    const day = this.dayNow();
    const [vc, vi] = viewLight(l.room.windowView);
    const studioEnv = this.exploration.active
      ? (this.echoLife?.atmosphere?.studioEnvironment ?? this.envTex)
      : this.envTex;
    if (studioEnv && this.scene.environment !== studioEnv) this.scene.environment = studioEnv;
    // Through the player's own eyes the room is lit from somewhere: less flat fill, more of the light that casts shadows.
    this.hemi.intensity = (this.exploration.active ? .4 : .24) + day * (this.exploration.active ? .2 : .3);
    this.scene.environmentIntensity = this.exploration.active ? .42 : .28;
    this.hemi.color.set(l.room.visible ? '#eef1ff' : '#ffffff');
    this.hemi.groundColor.set('#d9cfe8');
    this.key.intensity = (this.exploration.active ? 1.5 : 1.15) + day * 1.2;
    this.key.color.set(l.room.theme==='rain'||l.room.theme==='library'?'#ffe0b8':day > 0.5 ? '#fff3e2' : '#dfe4ff');
    this.windowLight.color.set(vc);
    this.windowLight.intensity = l.room.visible && l.room.wallRight ? vi * (0.5 + day * 0.6) : 0;
    this.renderer.toneMappingExposure = 0.92 + day * 0.14;
    // key light from the front-right, window light from behind the right wall
    // A window that follows the hour lets the sun cross the floor.
    if (this.exploration.active) this.key.position.set(l.room.windowView === 'live' ? -6 + (this.life?.weather.arc ?? .5) * 12 : 1, 4.1, -6);
    else this.key.position.set(6, 11, 7);
    this.key.target.position.set(0, 0, 0);
    this.windowLight.position.set(1, 3.5, -8);
    this.windowLight.target.position.set(0, 0, 1);
    this.fill.intensity = this.exploration.active ? 0.28 : 0.45;
    this.fill.position.set(-8, 6, 4);
  }

  /** Lamps: the nearest few real lights get point lights, every lamp gets a halo. */
  private placeLamps() {
    const specs: { world: T.Vector3; spec: LightSpec }[] = [];
    this.placed.forEach((p) => {
      if (p.obj.hidden || p.obj.lightOn === false || p.obj.state?.burnt) return;
      p.group.updateMatrixWorld(true);
      for (const s of p.lights) specs.push({ world: new T.Vector3(...s.pos).applyMatrix4(p.group.matrix), spec: s });
    });
    const day = this.layout ? this.dayNow() : 0.5;
    const nightBoost = 0.6 + (1 - day) * 1.0;
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const s = specs[i];
      const l = this.lamps[i], h = this.halos[i];
      if (!s) { l.intensity = 0; h.material.opacity = 0; h.visible = false; continue; }
      l.position.copy(s.world);
      l.color.set(s.spec.color);
      l.intensity = s.spec.intensity * nightBoost;
      l.distance = s.spec.distance;
      h.position.copy(s.world);
      h.material.color.set(s.spec.color);
      const op = 0.35 + (1 - day) * 0.35;
      h.material.opacity = op;
      h.visible = op > 0.005;
    }
  }

  /** What the legs walk round: everything standing on the floor, except what is in the air or in the arms right now. */
  /**
   * House doors: put back where the world save left them once the house stands; then each one that comes to rest in a new state
   * (opened or shut by a hand) is saved. A door a hand is still working is not at rest.
   */
  private lifeDoorSaveKey(space: string, id: string) {
    return id.startsWith('city:') ? id : houseDoorKey(space, id);
  }
  private lifeDoors(world: EchoLifeWorld) {
    const saver = this.lifeSave, space = this.spaceIdentity;
    if (!saver?.loaded || !space || !world.ready) return;
    const doors = world.doors();
    if (this.doorsRestoredFor !== world) {
      this.doorsRestoredFor = world; this.doorSeen.clear();
      for (const d of doors) {
        const saved = saver.door(this.lifeDoorSaveKey(space, d.id));
        if (saved) d.restore(saved.angle);
        this.doorSeen.set(d.id, { open: d.isOpen, angle: d.angle });
      }
      return;
    }
    const activeIds = new Set(doors.map(d => d.id));
    for (const id of [...this.doorSeen.keys()]) if (!activeIds.has(id)) this.doorSeen.delete(id);
    for (const d of doors) {
      const seen = this.doorSeen.get(d.id);
      if (!seen) {
        const saved = saver.door(this.lifeDoorSaveKey(space, d.id));
        if (saved) d.restore(saved.angle);
        this.doorSeen.set(d.id, { open: d.isOpen, angle: d.angle });
        continue;
      }
      if (this.manip.doorBusy(`life:${d.id}`)) continue;
      if (seen.open === d.isOpen && Math.abs(seen.angle - d.angle) < .05) continue;
      if (seen.open !== d.isOpen && this.exploration.active) {
        const bp = this.character?.root.position;
        const dist = bp ? Math.hypot(bp.x - d.plan.x, bp.z - d.plan.z) : 1.0;
        if (dist < 14) this.game.worldAudio.triggerDoor(d.isOpen, dist);
      }
      this.doorSeen.set(d.id, { open: d.isOpen, angle: d.angle });
      saver.setDoor(this.lifeDoorSaveKey(space, d.id), { open: d.isOpen, angle: +d.angle.toFixed(4) });
    }
  }
  /** The house exists around a cutaway room with both its walls (the doorway is cut into the solid side wall). */
  private lifeWanted(l: Layout) { return this.cb.lifeEnabled!==false && l.room.visible && l.room.wallLeft && l.room.wallRight; }
  private lifeDoorway(size: number) {
    const d = housePlan(size).doors.find(x => x.id === 'hall')!;
    return { z: d.z, width: DOOR_W, top: DOOR_H + .1 };
  }

  private refreshNavigation(l: Layout) {
    const physics = this.manip?.physics;
    const rollingId = this.activeRollingChairId;
    const obstacles = l.objects
      .filter(
        o =>
          o.id !== rollingId &&
          !o.hidden &&
          o.pos[1] < 0.4 &&
          CATALOG_BY_ID[o.kind]?.place === 'floor' &&
          !CATALOG_BY_ID[o.kind]?.flat &&
          !physics?.owns(o.id),
      )
      .map(o => ({
        x: o.pos[0],
        z: o.pos[2],
        width: CATALOG_BY_ID[o.kind].size[0] * o.scale,
        depth: CATALOG_BY_ID[o.kind].size[1] * o.scale,
        rotation: o.rotY,
      }));
    const navKey = JSON.stringify([l.room.size, rollingId ?? '', obstacles]);
    const changed = navKey !== this.navigationKey;
    if (changed) {
      this.navigation = new RoomNavigation(l.room.size, obstacles);
      this.navigationKey = navKey;
      this.setCharacterNavigation();
    }
    return changed;
  }

  private createCharacterInstance(c: Layout['character']): Character {
    const ch = new Character(c);
    // Post-IK single-pass embodiment flags: XPBD hair/scarf & CastLook gaze run in `updatePostIk()`
    // after `HumanRig.update()`, and root curve/accel lean is delegated directly to `BodyFrame`.
    ch.deferPostIk = true;
    ch.bodyLeanDelegatedToRig = true;
    // The floor beyond the room: the house's floors, its stair, the street. Inside the room it is 0, as always.
    ch.groundAt = (x, z) => (this.echoLife && !this.echoLife.inStudy({ x, z }) ? this.echoLife.walk.groundAt(x, z) : null);
    ch.jumpClear = (p, y) => this.manip.physics?.actorFits(p.x, p.z, 0, y) ?? false;
    ch.motionAllowed = hands =>
      !this.exploration.crouchAmount &&
      !this.manip.busy &&
      !this.manip.legsTaken &&
      !this.manip.work.active &&
      (!this.manip.carrying || hands === 'carry');
    ch.motionClearance = (from, to) =>
      ((this.echoLife?.ready && this.exploration.active ? this.echoLife.walk : null) ?? this.navigation)?.motionFraction(from, to) ?? 0;
    ch.floorSpaceFree = (origin, envelope) => this.floorSpaceFree(origin, envelope);
    ch.onFloorRest = (pos, yaw, pose) => {
      if (this.character === ch && !this.disposed) this.cb.onCharacterMoved(pos, yaw, pose);
    };
    ch.onMotionEnd = () => {
      if (this.character === ch && !this.disposed) this.flushExploration();
    };
    ch.onResetPose = () => {
      if (this.character === ch && !this.disposed) this.manip.cancelActiveInteraction();
    };
    ch.onActorDimensionsChange = (standingHeightM, buildScale) => {
      if (this.character === ch && !this.disposed) {
        this.manip.physics?.setActorHeight(standingHeightM, buildScale);
      }
    };
    ch.motionFraction = (from, to, turn) => {
      if (this.activeRollingChairId && ch.occupies(this.activeRollingChairId)) {
        return 1;
      }
      if ((this.manip as { isCarryingTool?: boolean }).isCarryingTool) {
        return 1;
      }
      const coordinated = this.manip.carryMotionFraction(from, to, turn, 1);
      const free = this.manip.physics?.heldMotionFraction(from, to, turn, coordinated) ?? coordinated;
      ch.rig?.prepareRootMotion(from, to, turn, free);
      return ch.rig?.heldRootMotionFraction(from, to, turn, free) ?? free;
    };
    return ch;
  }

  private syncCharacter(l: Layout) {
    const hasPhysics = Boolean(this.manip?.physics);
    const heldSig = this.manip?.physics ? [...this.manip.physics.heldIds].sort().join(',') : '';
    let spatialSig = `${l.room.size}|${heldSig}`;
    for (let i = 0; i < l.objects.length; i++) {
      const o = l.objects[i];
      spatialSig += `;${o.id}|${o.kind}|${o.pos[0]},${o.pos[1]},${o.pos[2]}|${o.rotY}|${o.quat ? o.quat.join(',') : ''}|${o.scale}|${o.hidden ? 1 : 0}`;
    }
    let changed = false;
    if (
      !this.navigation ||
      spatialSig !== this.lastSpatialNavSig ||
      this.activeRollingChairId !== this.lastSpatialNavRollingId ||
      hasPhysics !== this.lastSpatialNavHadPhysics
    ) {
      this.lastSpatialNavSig = spatialSig;
      this.lastSpatialNavRollingId = this.activeRollingChairId;
      this.lastSpatialNavHadPhysics = hasPhysics;
      changed = this.refreshNavigation(l);
    }
    const c = l.character;
    const effectiveModel = this.pendingCreatorProfile?.hero ?? c.model;
    const key = `${c.visible}|${effectiveModel}`;
    if (key !== this.characterKey) {
      this.characterKey = key;
      this.character?.dispose();
      this.character = null;
      if (c.visible) {
        const ch = this.createCharacterInstance({ ...c, model: effectiveModel });
        this.character = ch;
        this.setCharacterNavigation();
        this.stage.add(ch.root);
        ch.load().then(() => {
          if (this.character !== ch) { ch.dispose(); return; }
          this.csmPatchedObjects.add(ch.root);
          this.echoCsm.patchObject(ch.root);
          if (!this._warmupReady) this.shadersPending = true;
          this.restCharacter(undefined, true);
          if (this.pendingCreatorProfile) {
            const skyNow = this.exploration.active ? this.game.sky() : null;
            void ch.applyCreatorProfile(
              this.pendingCreatorProfile,
              skyNow ? { season: skyNow.season, snow: skyNow.snow ?? 0 } : undefined,
            );
          }
          // What the body now is goes on record: the next change of the layout is not mistaken for another room, and does not put it back.
          if (this.layout) this.syncCharacter(this.layout);
          this.wake();
        }).catch(() => { /* the cast could not load: the room stays usable without it */ });
      }
    } else if (this.character?.ready) {
      this.character.applyColors(c);
    }
    if (this.character?.ready) {
      if (this.pendingCreatorProfile) {
        const skyNow = this.exploration.active ? this.game.sky() : null;
        void this.character.applyCreatorProfile(
          this.pendingCreatorProfile,
          skyNow ? { season: skyNow.season, snow: skyNow.snow ?? 0 } : undefined,
        );
      } else {
        void this.character.dress(c);
      }
    }
    if(changed) this.setCharacterNavigation();
    if (this.usedObject && !this.placed.has(this.usedObject)) this.usedObject = null;
    const anchorId = this.usedObject || c.anchor;
    const anchor = anchorId ? l.objects.find(o => o.id === anchorId) : null;
    const scopeKey = JSON.stringify([this.spaceIdentity, l.room.theme, l.room.size]);
    const anchorKey = anchor ? JSON.stringify([anchor.id, anchor.kind, anchor.pos, anchor.rotY, anchor.scale, anchor.hidden]) : '';
    const posKey = JSON.stringify([c.pos, c.rotY]);
    const ch = this.character;
    if (ch?.ready) {
      // The layout also records what the body already did (it sat, it walked somewhere). Such a write is the world
      // catching up, not a command: only a change from outside (another room, moved furniture, an undo) re-places the body.
      const scopeChanged = scopeKey !== this.scopeKey;
      const idChanged = (anchorId ?? null) !== this.anchorIdKey;
      // The chair the body itself drew up, reported back: the room already shows it there.
      const ownMove = !!this.ownChairAt && !!anchor && Math.hypot(anchor.pos[0] - this.ownChairAt[0], anchor.pos[2] - this.ownChairAt[1]) < .003;
      const movedSeat = !idChanged && anchorKey !== this.anchorKey && !ownMove;
      // The layout catching up with a walk the body has already started is not a command to start over.
      const arrivedSeat = idChanged && !!anchorId && (ch.occupies(anchorId) || (this.usedObject === anchorId && !scopeChanged));
      const atPos = Math.hypot(ch.root.position.x - c.pos[0], ch.root.position.z - c.pos[2]) < .03;
      const replaced = !anchorId && (idChanged || posKey !== this.posKey) && !atPos && !ch.body.seat && ch.posture === 'standing' && ch.diagnostics().moving === false;
      const reset = scopeChanged || movedSeat || (idChanged && !!anchorId && !arrivedSeat) || replaced;
      this.scopeKey = scopeKey; this.anchorKey = anchorKey; this.anchorIdKey = anchorId ?? null; this.posKey = posKey;
      if (reset) {
        this.activityKey = c.activity;
        this.restCharacter(undefined, true);
      } else if (c.activity !== this.activityKey) {
        this.activityKey = c.activity;
        this.characterActivity(c.activity);
      }
    }
  }
  private setCharacterNavigation() {
    this.character?.setNavigator((from,to) => {
      const world = this.echoLife;
      if (world?.ready && this.exploration.active && (!world.inStudy(from) || !world.inStudy(to)))
        return world.walk.path(from,to)?.map(p => new T.Vector3(p.x,world.walk.groundAt(p.x,p.z) ?? from.y,p.z)) ?? null;
      return this.navigation?.path(from,to)?.map(p=>new T.Vector3(p.x,0,p.z)) ?? null;
    });
  }

  /** Sends the character to its anchor with its resting activity (or leaves it standing where it was). */
  restCharacter(activity?: Activity, reset = false) {
    const ch = this.character, l = this.layout;
    if (!ch?.ready || !l) return;
    const id = this.usedObject || l.character.anchor;
    const anchor = id ? this.placed.get(id) : undefined;
    if (reset && this.echoLife && this.lifeSave?.loaded && (l.camera.view === 'first' || l.camera.view === 'third')) {
      this.restoreLifePlace(true);
      if (this.bodyOutside(ch.root.position.toArray())) return;
    }
    if (reset || !anchor || anchor.obj.hidden) {
      const desired = new T.Vector3(...l.character.pos).setY(0);
      if (this.navigation && !this.navigation.free({x:desired.x,z:desired.z})) {
        let best: T.Vector3 | null = null, distance = Infinity;
        for (let x = -this.navigation.half; x <= this.navigation.half; x += .24) for (let z = -this.navigation.half; z <= this.navigation.half; z += .24) {
          if (!this.navigation.free({x,z})) continue;
          const p = new T.Vector3(x,0,z), d = p.distanceToSquared(desired);
          if (d < distance) { distance = d; best = p; }
        }
        if (best) desired.copy(best);
      }
      ch.resetPose(desired, l.character.rotY);
    }
    if (reset && !anchor && l.character.floorPose) {
      if (ch.performMotion(l.character.floorPose,true)) return;
      if (ch.motionState?.reason === 'no-floor-space') this.cb.onCharacterMoved(ch.root.position.toArray(), ch.root.rotation.y);
    }
    const desiredActivity = activity ?? l.character.activity;
    if (!['idle', 'stretch', 'wave'].includes(desiredActivity) && anchor && !anchor.obj.hidden && this.useObject(anchor.obj.id, desiredActivity, reset)) return;
    this.usedObject = null;
    const fallbackAct = activity ?? l.character.activity;
    ch.setActivity(fallbackAct === 'sleep' || fallbackAct === 'stretch' ? 'idle' : fallbackAct);
  }

  /** The character goes to an object and uses it. Returns false when the object has no place to use. */
  useObject(id: string, activity?: Activity, instant = false): boolean {
    const ch = this.character, p = this.placed.get(id);
    if (!ch?.ready || !p || p.obj.hidden) return false;
    const item = CATALOG_BY_ID[p.obj.kind];
    if (!item?.anchor) return false;
    const a = item.anchor;
    p.group.updateMatrixWorld(true);
    if (
      (a.activity === 'relax' || a.activity === 'sleep' || p.obj.kind.startsWith('chair.') || p.obj.kind.startsWith('bed.')) &&
      !isSpaceObjectUpright(p.obj, p.group)
    ) {
      return false;
    }
    let pos = new T.Vector3(a.x, 0, a.z).applyMatrix4(p.group.matrix);
    let rotY = p.obj.rotY + a.rotY;
    const nearDesk = [...this.placed.values()].find((q) => !q.obj.hidden && q.obj.kind.startsWith('desk.') && q.group.position.distanceTo(p.group.position) < 1.3);
    const act: Activity = activity ?? (a.activity === 'sleep' ? 'sleep' : a.activity === 'relax' ? 'relax' : a.activity === 'study' || nearDesk ? 'study' : 'idle');
    if (a.activity === 'study' && p.obj.kind.startsWith('desk.')) {
      // a desk: sit on the chair in front of it if there is one, else stand at it
      const chair = [...this.placed.values()].find((q) => !q.obj.hidden && q.obj.kind.startsWith('chair.') && isSpaceObjectUpright(q.obj, q.group) && q.group.position.distanceTo(pos) < 0.9);
      if (chair) return this.useObject(chair.obj.id, act, instant);
      if (this.usedObject === id) return true;
      const accepted = ch.goTo(pos, () => { ch.root.rotation.y = rotY; ch.setActivity('read'); });
      if (accepted) this.usedObject = id;
      return accepted;
    }
    const lie = a.activity === 'sleep' && act === 'sleep';
    const side = ch.root.position.clone().sub(p.group.position).applyAxisAngle(new T.Vector3(0,1,0), -p.obj.rotY).x >= 0 ? 1 : -1;
    const resolved = furnitureAnchor(p.obj, p.group, lie, side);
    if (!resolved) return false;
    pos = resolved.pos; rotY = resolved.rotY;
    const seatTop = resolved.top;
    const deskHeight=nearDesk?(CATALOG_BY_ID[nearDesk.obj.kind].tops?.[0]??.76)*nearDesk.obj.scale+nearDesk.obj.pos[1]:undefined;
    const work = !lie && nearDesk ? this.deskFromSeat(pos, rotY, nearDesk) : null;
    const mobility = p.group.userData.seatMobility === 'rolling' ? 'rolling' : seatMobilityOf(p.obj.kind);
    const canSlide = !lie && !!work && mobility !== 'rolling' && affordanceOf(p.obj.kind).family === 'chair' && !p.obj.locked && !instant;
    let approaches = resolved.approaches;
    if (!lie && !approaches) {
      const cands: T.Vector3[] = [];
      const curDist = Math.hypot(ch.root.position.x - pos.x, ch.root.position.z - pos.z);
      if (
        curDist <= 0.88 &&
        (!this.navigation || this.navigation.free(ch.root.position)) &&
        (!this.manip.physics || this.manip.physics.actorFits(ch.root.position.x, ch.root.position.z, 0, pos.y))
      ) {
        cands.push(new T.Vector3(ch.root.position.x, pos.y, ch.root.position.z));
      }
      for (let ri = 0; ri < STAND_CANDIDATE_RADII.length; ri++) {
        const rad = STAND_CANDIDATE_RADII[ri];
        for (let ai = 0; ai < STAND_CANDIDATE_ANGLES.length; ai++) {
          const ang = rotY + STAND_CANDIDATE_ANGLES[ai];
          const cx = pos.x + Math.sin(ang) * rad;
          const cz = pos.z + Math.cos(ang) * rad;
          if (this.navigation && !this.navigation.free({ x: cx, z: cz })) continue;
          if (this.manip.physics && !this.manip.physics.actorFits(cx, cz, 0, pos.y)) continue;
          cands.push(new T.Vector3(cx, pos.y, cz));
        }
      }
      if (cands.length > 0) approaches = cands;
    }
    const accepted = ch.sitAt(
      pos,
      rotY,
      act,
      seatTop,
      lie,
      {
        armrest: p.group.userData.armrest === undefined ? undefined : p.group.userData.armrest * p.obj.scale + p.obj.pos[1],
        deskHeight: work ? deskHeight : undefined,
        work: work ?? undefined,
        bed: resolved.bed,
        approaches,
        mobility,
        slide: canSlide
          ? {
              id: p.obj.id,
              distance: Math.max(0, work!.edge - 0.27),
              move: d => this.slideChair(p, rotY, d),
              done: () => {
                this.ownChairAt = [p.group.position.x, p.group.position.z];
                this.cb.onObjectState?.(p.obj.id, { pos: [p.group.position.x, p.group.position.y, p.group.position.z] }, 'chair');
              },
            }
          : undefined,
      } as Parameters<Character['sitAt']>[5],
      id,
      instant,
    );
    if (accepted) this.usedObject = id;
    return accepted;
  }

  /** Where the desk really is from this seat: how far ahead its front edge, and where the keyboard, if there is one. */
  private deskFromSeat(pos: T.Vector3, rotY: number, desk: Placed) {
    const item = CATALOG_BY_ID[desk.obj.kind], s = desk.obj.scale;
    const forward = new T.Vector3(Math.sin(rotY), 0, Math.cos(rotY)), right = new T.Vector3(Math.cos(rotY), 0, -Math.sin(rotY));
    const inv = new T.Matrix4().compose(desk.group.position, desk.group.quaternion, new T.Vector3(1, 1, 1)).invert();
    const o = pos.clone().applyMatrix4(inv), d = forward.clone().transformDirection(inv);
    const hx = item.size[0] * s / 2, hz = item.size[1] * s / 2;
    let near = -Infinity, far = Infinity;
    for (const [oc, dc, h] of [[o.x, d.x, hx], [o.z, d.z, hz]] as [number, number, number][]) {
      if (Math.abs(dc) < 1e-5) { if (Math.abs(oc) > h) return null; continue; }
      const a = (-h - oc) / dc, b = (h - oc) / dc;
      near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
    }
    if (near > far || far < 0 || near > .85) return null;
    const edge = Math.max(0, near);
    let x = 0, z = edge + .09;
    for (const q of this.placed.values()) {
      if (q.obj.hidden || !['laptop', 'book.single', 'notebook'].includes(q.obj.kind)) continue;
      const rel = q.group.position.clone().sub(pos), lateral = rel.dot(right), ahead = rel.dot(forward);
      if (Math.abs(lateral) < .34 && ahead > edge - .02 && ahead < edge + .5 && Math.abs(q.group.position.y - (item.tops?.[0] ?? .76)) < .2) { x = lateral; if (q.obj.kind === 'laptop') z = Math.max(z, ahead - .03 - (edge - Math.min(edge, .27))); break; }
    }
    return { edge, x, z: Math.min(z, edge + .17) };
  }
  private slideChair(p: Placed, rotY: number, d: number) {
    p.group.position.x += Math.sin(rotY) * d;
    p.group.position.z += Math.cos(rotY) * d;
  }

  characterActivity(a: Activity) {
    const ch = this.character;
    if (!ch?.ready) return;
    // A wave at a seated character, or a stretch between focus sessions, is not a request to leave the chair.
    if ((a === 'wave' || a === 'stretch') && ch.body.seat) return;
    if (a === 'idle' || a === 'stretch' || a === 'wave') {
      this.commitActiveRollingChair(true);
      this.usedObject = null;
      this.game?.releasePlayerSeat(true);
      this.game?.cancelEmbodiedAction('stand_up');
      if (this.game?.isShoweringActive) {
        this.game.cancelShower();
        ch.setEmbodiedSession(null);
      }
      if (ch.isApproachingSeat && !ch.body.seat) {
        ch.cancelSeatApproach();
      } else if (ch.body.seat || ch.isDismountingSeat) {
        ch.standUp(this.resolveStandFallback());
      } else {
        ch.standUp();
      }
      ch.setActivity(a);
      return;
    }
    const anchor = this.usedObject || this.layout?.character.anchor;
    if (anchor && (a !== 'sleep' || this.placed.get(anchor)?.obj.kind.startsWith('bed.')) && this.useObject(anchor, a)) return;
    if (a === 'sleep') {
      const beds = [...this.placed.values()].filter(p => !p.obj.hidden && p.obj.kind.startsWith('bed.')).sort((a,b) => a.group.position.distanceTo(ch.root.position)-b.group.position.distanceTo(ch.root.position));
      if (beds.some(p => this.useObject(p.obj.id, 'sleep'))) return;
      this.standUp();
      return;
    }
    ch.setActivity(a);
  }

  get isSeatedOrApproaching(): boolean {
    const ch = this.character;
    if (!ch?.ready) return false;
    return Boolean(ch.body.seat || ch.isApproachingSeat || this.game?.game?.people.playerSeat);
  }

  get bodyReady() { return !!this.character?.ready; }
  // ── The learner's library on the shelves ──
  private library: LibraryBook[] = [];
  private shelfKey = '';
  setLibrary(books: LibraryBook[]) {
    this.library = books;
    this.shelfKey = '';
    this.dressShelves();
    for (const p of this.placed.values()) if (p.obj.state?.book) dressBookFace(p.group, p.obj);
  }
  /** One spine for each book not out in the room. Nothing is rebuilt unless what is on the shelves changed. */
  private dressShelves() {
    if (!this.library.length && !this.shelfKey) return;
    const out = new Set<string>(), shelves: { group: T.Object3D; kind: string; id: string }[] = [];
    for (const p of this.placed.values()) {
      const b = p.obj.state?.book;
      if (b) out.add(`${b.source}:${b.id}`);
      if (shelfHoldsBooks(p.obj.kind) && !p.obj.hidden) shelves.push({ group: p.group, kind: p.obj.kind, id: p.obj.id });
    }
    const key = `${this.library.map(b => b.key).join()}|${[...out].sort().join()}|${shelves.map(x => x.id).join()}`;
    if (key === this.shelfKey) return;
    this.shelfKey = key;
    const free = this.library.filter(b => !out.has(b.key));
    let at = 0;
    for (const shelf of shelves) {
      const room = shelf.kind === 'shelf.tall' ? 26 : 14;
      const chunk = free.slice(at, at + room);
      at += room;
      // What already stands on this shelf (a row of decorative books, a plant) keeps its board.
      const blocked: T.Box3[] = [];
      if (chunk.length) {
        const zone = new T.Box3().setFromObject(shelf.group).expandByScalar(.02);
        for (const p of this.placed.values()) if (p.group !== shelf.group && !p.obj.hidden && !p.obj.state?.book) { const b = new T.Box3().setFromObject(p.group); if (!b.isEmpty() && zone.intersectsBox(b) && b.max.y < zone.max.y + .5 && b.min.y > zone.min.y + .01) blocked.push(b); }
      }
      if (chunk.length) dressShelf(shelf.group, shelf.kind, chunk, blocked); else undressShelf(shelf.group);
    }
  }
  characterAt(): { pos: [number, number, number]; rotY: number } | null {
    const ch = this.character;
    if (!ch?.ready) return null;
    return { pos: [ch.root.position.x, ch.root.position.y, ch.root.position.z], rotY: ch.root.rotation.y };
  }

  private syncPet(l: Layout) {
    if (l.pet.visible && !this.pet && !this.petAbort) {
      this.petAbort = new AbortController();
      loadWhaleRig(ECHO_MODEL_URL, this.petAbort.signal).then((rig) => {
        if (this.disposed || !this.layout?.pet.visible) { rig.dispose(); return; }
        rig.root.scale.setScalar(0.75);
        this.pet = rig;
        this.stage.add(rig.root);
        rig.root.traverse((o) => { (o as T.Mesh).castShadow = true; o.userData.pet = true; });
      }).catch(() => { this.petAbort = null; });
    }
    if (!l.pet.visible && this.pet) {
      this.stage.remove(this.pet.root);
      this.pet.dispose();
      this.pet = null;
      this.petAbort = null;
    }
  }

  // ── Camera ────────────────────────────────────────────────────────────────────────────────────────────
  applyCamera(c: Layout['camera']) {
    const target = new T.Vector3(...c.target);
    const r = 30;
    this.camera.position.set(target.x + r * Math.sin(c.polar) * Math.sin(c.azimuth), target.y + r * Math.cos(c.polar), target.z + r * Math.sin(c.polar) * Math.cos(c.azimuth));
    this.camera.zoom = c.zoom;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(target);
    this.controls.update();
    this.exploration.setView(c.view ?? 'overview', c);
    if (!this.exploration.active || this.exploration.view !== 'first') {
      this.exploration.clearOwnLimbGuard();
    }
    this.controls.enabled = !this.exploration.active;
    this.applyLighting();
    this.wake();
  }

  setView(view: CameraView) {
    this.exploration.setView(view);
    if (!this.exploration.active || this.exploration.view !== 'first') {
      this.exploration.clearOwnLimbGuard();
    }
    this.controls.enabled = !this.exploration.active;
    this.applyLighting(); this.flushExploration(); this.wake();
  }
  private reportExploration() {
    if (!this.exploration) return;
    const state = this.exploration.state();
    this.cb.onExplore?.(state);
    this.cb.onInteraction?.(this.manip.state);
  }
  settlePhysics() { this.manip.settle(); this.reportExploration(); }
  setTravelling(value: boolean) { this.passage.leave(value); this.wake(); }
  availableMotions() { return this.character?.availableMotions() ?? []; }
  private floorBlocker: { vi: string; en: string } | null = null;
  private floorSpaceFree(origin: {x:number;z:number;yaw:number}, bounds: FloorEnvelope) {
    if (!this.layout) return false;
    this.floorBlocker = null;
    const margin = .025, half = this.layout.room.size / 2;
    const frame = new T.Matrix4().makeRotationY(origin.yaw).setPosition(origin.x,0,origin.z);
    const footprint = new T.Box3(new T.Vector3(bounds.minX-margin,.005,bounds.minZ-margin),
      new T.Vector3(bounds.maxX+margin,bounds.top+margin,bounds.maxZ+margin));
    const roomBox = footprint.clone().applyMatrix4(frame);
    if (roomBox.min.x < -half || roomBox.min.z < -half || roomBox.max.x > half || roomBox.max.z > half) {
      this.floorBlocker = { vi: 'tường', en: 'the room boundary' }; return false;
    }
    this.stage.updateWorldMatrix(true,false);
    const inverse = this.stage.matrixWorld.clone().multiply(frame).invert(), matrix = new T.Matrix4(), part = new T.Box3();
    const triangle = new T.Triangle();
    for (const item of this.placed.values()) {
      const entry = CATALOG_BY_ID[item.obj.kind];
      if (item.obj.hidden || item.obj.inside || entry?.flat) continue;
      item.group.updateWorldMatrix(true,true);
      let occupied = false;
      item.group.traverseVisible(node => {
        const mesh = node as T.Mesh;
        if (occupied || !mesh.isMesh || node.userData.blob || node.userData.noCollision) return;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        part.copy(mesh.geometry.boundingBox!).applyMatrix4(matrix.multiplyMatrices(inverse,mesh.matrixWorld));
        if (!footprint.intersectsBox(part)) return;
        for (let parent = node.parent; parent && parent !== item.group; parent = parent.parent)
          if (parent.userData.noCollision || parent.userData.blob) return;
        const positions = mesh.geometry.getAttribute('position'), indices = mesh.geometry.index;
        if (!positions) return;
        const count = indices?.count ?? positions.count;
        for (let i = 0; i + 2 < count && !occupied; i += 3) {
          triangle.a.fromBufferAttribute(positions, indices ? indices.getX(i) : i).applyMatrix4(matrix);
          triangle.b.fromBufferAttribute(positions, indices ? indices.getX(i + 1) : i + 1).applyMatrix4(matrix);
          triangle.c.fromBufferAttribute(positions, indices ? indices.getX(i + 2) : i + 2).applyMatrix4(matrix);
          occupied = footprint.intersectsTriangle(triangle);
        }
      });
      if (occupied) { this.floorBlocker = { vi: entry?.name ?? item.obj.kind, en: entry?.nameEn ?? item.obj.kind }; return false; }
    }
    return true;
  }
  performMotion(name: string) {
    if (!this.exploration.acceptingInput || this.mode === 'edit' || this.disposed) return false;
    const started = this.character?.performMotion(name) ?? false;
    if (started) this.wake();
    else if (this.character?.motionState?.reason === 'no-floor-space') this.cb.say?.(`Không đủ chỗ đổi tư thế gần ${this.floorBlocker?.vi ?? 'vật cản'}.`, `This posture needs more room near ${this.floorBlocker?.en ?? 'the obstacle'}.`);
    else this.cb.say?.('Chưa thể thực hiện động tác ở tư thế này.', 'This movement is not available in the current posture.');
    return started;
  }
  async performAction(action: EmbodiedAction) {
    if (!this.exploration.acceptingInput || this.mode === 'edit' || this.disposed) return;
    if (action === 'jump' && this.exploration.crouchAmount > .02) return;
    if (action === 'grab') {
      if (this.manip.carrying) { if (this.manip.state.placing) this.manip.perform('place'); else this.manip.perform('drop'); return; }
      const acts = this.manip.state.more.filter(a => !a.blocked && (a.verb === 'pick' || a.verb === 'take-one'));
      if (acts[0]) this.manip.perform(acts[0].verb);
      return;
    }
    // With a thing in hand, "look at my hands" looks at the thing instead: it comes up to the eyes, and the mouse turns it.
    if (action === 'inspect' && this.manip.carrying) { this.manip.perform('inspect'); return; }
    // Sitting or lying the hands still answer; the body stays where it is (and a jump is not something a seated body does).
    if (this.manip.carrying && action !== 'jump') return;
    this.character?.express(action); this.sharedCity?.express(action); this.wake();
  }
  private shortcut(action: string) {
    if (action === 'camera') { this.setView(this.exploration.view === 'third' ? 'first' : 'third'); return; }
    if (action === 'cancel') {
      if (this.game?.isShoweringActive) {
        this.game.cancelShower();
        this.character?.setEmbodiedSession(null);
      }
      this.character?.cancelMotion();
      this.manip.interrupt(true);
      this.cb.onShortcut?.('cancel');
      return;
    }
    if (action === 'use-held') { this.manip.useHeld(); return; }
    if (action === 'drop') { this.manip.perform('drop'); return; }
    if (action === 'mouse') { this.exploration.toggleLook(); return; }
    if (action === 'sense') { this.life.showDirt(); const pct = Math.round(this.life.cleanliness * 100); this.cb.onCaption?.({ id: `sense-${Date.now()}`, vi: `Phòng sạch khoảng ${pct}%. Những chỗ sáng lên là chỗ còn bẩn.`, en: `The room is about ${pct}% clean. What lights up is still dirty.`, hold: 3 }); return; }
    this.cb.onShortcut?.(action);
  }
  /** On foot through a real door; `onBlocked` when there is no door or no way to it. */
  journey(destination: WorldDestination, onThrough: () => void, onBlocked: () => void) { this.manip.journey(destination, onThrough, onBlocked); this.wake(); }
  arrive(from: WorldDestination) { this.manip.arrive(from); this.wake(); }
  cancelJourney() { this.manip.interrupt(true); }

  private resolveStandFallback(): T.Vector3 | undefined {
    const ch = this.character;
    if (!ch?.ready) return undefined;
    const cx = ch.root.position.x;
    const cy = ch.root.position.y;
    const cz = ch.root.position.z;
    const baseYaw = ch.root.rotation.y;

    if (this.echoLife?.ready && !this.echoLife.inStudy({ x: cx, z: cz })) {
      const walk = this.echoLife.walk;
      let bestX = cx + Math.sin(baseYaw) * 0.68;
      let bestZ = cz + Math.cos(baseYaw) * 0.68;
      let bestY = walk.groundAt(bestX, bestZ) ?? cy;
      let foundFree = false;
      for (let ri = 0; ri < STAND_CANDIDATE_RADII.length && !foundFree; ri++) {
        const rad = STAND_CANDIDATE_RADII[ri];
        for (let ai = 0; ai < STAND_CANDIDATE_ANGLES.length; ai++) {
          const ang = baseYaw + STAND_CANDIDATE_ANGLES[ai];
          const tx = cx + Math.sin(ang) * rad;
          const tz = cz + Math.cos(ang) * rad;
          if (!walk.free({ x: tx, z: tz })) continue;
          const ty = walk.groundAt(tx, tz) ?? cy;
          if (Math.abs(ty - cy) > 0.65) continue;
          bestX = tx;
          bestZ = tz;
          bestY = ty;
          foundFree = true;
          break;
        }
      }
      const cw = (this.echoLife as EchoLifeWorldWave4).collisionWorld ?? this.exploration.collisionWorld;
      if (cw) {
        const san = sanitizePlayerPosition(
          cw,
          { x: bestX, z: bestZ },
          {
            maxSearchRadius: 1.15,
            referenceY: cy,
            fallback: { x: cx, z: cz },
          },
        );
        return tmpStandFallback.set(san.x, san.y, san.z);
      }
      return tmpStandFallback.set(bestX, bestY, bestZ);
    }

    const nav = this.navigation;
    const half = (this.layout?.room.size ?? 6) / 2 - 0.28;
    for (let ri = 0; ri < STAND_CANDIDATE_RADII.length; ri++) {
      const rad = STAND_CANDIDATE_RADII[ri];
      for (let ai = 0; ai < STAND_CANDIDATE_ANGLES.length; ai++) {
        const ang = baseYaw + STAND_CANDIDATE_ANGLES[ai];
        const tx = T.MathUtils.clamp(cx + Math.sin(ang) * rad, -half, half);
        const tz = T.MathUtils.clamp(cz + Math.cos(ang) * rad, -half, half);
        if (nav && !nav.free({ x: tx, z: tz })) continue;
        return tmpStandFallback.set(tx, 0, tz);
      }
    }
    return tmpStandFallback.set(T.MathUtils.clamp(cx, -half, half), 0, T.MathUtils.clamp(cz, -half, half));
  }

  private commitActiveRollingChair(releaseLock: boolean): void {
    const chairId = this.activeRollingChairId;
    if (!chairId) return;
    const placed = this.placed.get(chairId);
    if (placed && this.rollingChairDirty) {
      const nextPos: [number, number, number] = [
        placed.group.position.x,
        placed.group.position.y,
        placed.group.position.z,
      ];
      const nextRotY = placed.group.rotation.y;
      placed.obj = { ...placed.obj, pos: nextPos, rotY: nextRotY };
      this.ownChairAt = [nextPos[0], nextPos[2]];
      this.cb.onObjectState?.(chairId, { pos: nextPos, rotY: nextRotY }, 'chair-roll-' + chairId);
      this.rollingChairDirty = false;
      this.rollingChairCommitIdleSec = 0;
    }
    if (releaseLock) {
      this.activeRollingChairId = null;
      this.rollingChairDirty = false;
      this.rollingChairCommitIdleSec = 0;
      if (this.layout) this.refreshNavigation(this.layout);
      this.manip.syncRoom();
    }
  }

  private syncRollingChairFrame(dt: number): void {
    const ch = this.character;
    const seatKey = ch?.ready && ch.posture === 'seated' && ch.seatMobility === 'rolling' ? ch.body.seat : null;
    const chairPlaced = seatKey ? this.placed.get(seatKey) ?? null : null;
    if (!seatKey || !chairPlaced) {
      if (this.activeRollingChairId !== null) {
        this.commitActiveRollingChair(true);
      }
      return;
    }

    if (this.activeRollingChairId !== seatKey) {
      if (this.activeRollingChairId !== null) {
        this.commitActiveRollingChair(true);
      }
      this.activeRollingChairId = seatKey;
      if (this.layout) this.refreshNavigation(this.layout);
    }

    const dx = ch!.root.position.x - chairPlaced.group.position.x;
    const dz = ch!.root.position.z - chairPlaced.group.position.z;
    const dyaw = Math.atan2(
      Math.sin(ch!.root.rotation.y - chairPlaced.group.rotation.y),
      Math.cos(ch!.root.rotation.y - chairPlaced.group.rotation.y),
    );
    if (dx * dx + dz * dz > 1e-8 || Math.abs(dyaw) > 1e-4) {
      chairPlaced.group.position.x = ch!.root.position.x;
      chairPlaced.group.position.z = ch!.root.position.z;
      chairPlaced.group.rotation.y = ch!.root.rotation.y;
      chairPlaced.group.updateMatrixWorld(true);
      this.ownChairAt = [chairPlaced.group.position.x, chairPlaced.group.position.z];
      this.rollingChairDirty = true;
      this.rollingChairCommitIdleSec = 0;
    } else if (this.rollingChairDirty) {
      this.rollingChairCommitIdleSec += dt;
      if (this.rollingChairCommitIdleSec >= 0.25) {
        this.commitActiveRollingChair(false);
      }
    }
  }

  standForExploration() {
    this.standingExit = true;
    this.lastEmbodiedTargetSig = '';
    if (this.game?.isShoweringActive) {
      this.game.cancelShower();
      this.character?.setEmbodiedSession(null);
      this.wasShoweringSessionActive = false;
      this.lastShowerTargetSig = '';
    }
    if (this.deviceHold) this.leaveDevice();
    this.characterActivity('idle');
    const ch = this.character;
    if (ch?.ready && ch.standing) {
      this.exploration.locomotionAcc.snap(ch.root.position.x, ch.root.position.y, ch.root.position.z, ch.root.rotation.y);
      this.exploration.elevationSpring.reset(ch.root.position.y);
    }
  }
  /** The explicit way out of a chair or a bed. */
  standUp() { this.standForExploration(); this.reportExploration(); this.wake(); }

  /**
   * Restores Study Room runtime state cleanly during `Reset Room`:
   * clears any held objects, active tool work, placement previews, rolling-chair locks,
   * stuck character/IK contacts, and Study Room props previously carried outside into `WorldSaver`,
   * then syncs `nextLayout` and places the character safely on walkable Study Room floor if indoors.
   */
  resetRoomRuntimeState(nextLayout: Layout): void {
    this.activeRollingChairId = null;
    this.rollingChairDirty = false;
    this.rollingChairCommitIdleSec = 0;
    this.ownChairAt = null;
    this.usedObject = null;
    this.standingExit = false;
    this.cancelPlacement();
    this.drag = null;
    this.down = null;
    this.resumeHeld.length = 0;
    this.carrySaveTimer = 0;

    const ch = this.character;
    const wasOutsideStudy = ch?.ready
      ? this.bodyOutside([ch.root.position.x, ch.root.position.y, ch.root.position.z])
      : false;

    if (this.deviceHold) this.leaveDevice();
    this.game?.resetRoomInteractionState({
      rig: ch?.rig ?? null,
      dismountVehicles: !wasOutsideStudy,
    });
    this.wasShoweringSessionActive = false;
    this.lastShowerTargetSig = '';
    this.lastEmbodiedTargetSig = '';

    // Clear any Study Room objects that were previously carried out into the house/city in WorldSaver
    // so they do not merge back on top of the freshly restored Study Room objects.
    const saver = this.lifeSave;
    const space = this.spaceIdentity;
    if (saver?.loaded && space) {
      const carriedOut = saver.objectsOf(space);
      for (let i = 0; i < carriedOut.length; i++) {
        saver.setObject(space, carriedOut[i].object.id, null);
      }
      if (carriedOut.length > 0) {
        void saver.flush();
      }
    }
    this.lifeObjects.clear();

    // Release any stuck Manipulator / ToolWork / Rapier held state.
    this.manip.work.end();
    this.manip.interrupt(true);
    this.manip.resetInteractionState();
    this.manip.reset();

    if (ch?.ready) {
      ch.setEmbodiedSession(null);
      ch.cancelMotion('reset-room');
      if (ch.isApproachingSeat && !ch.body.seat) {
        ch.cancelSeatApproach();
      } else if (ch.body.seat || ch.isDismountingSeat) {
        ch.standUp();
      }
      ch.resetStuckInteractionState();
      ch.rig?.clearAllContactsImmediate();
      ch.setActivity('idle');
    }

    this.lastPhysicsLayout = '';
    this.lastSpatialNavSig = '';
    this.sync(nextLayout, this.spaceIdentity);
    this.manip.physics?.syncAllToLayout();
    this.manip.syncRoom();

    // If the player is inside the Study Room, guarantee they stand on a clear walkable spot (never inside restored furniture).
    if (ch?.ready && !wasOutsideStudy) {
      const desired = new T.Vector3(1.2, 0, 0.4);
      if (this.navigation && !this.navigation.free({ x: desired.x, z: desired.z })) {
        let best: T.Vector3 | null = null;
        let bestDistSq = Infinity;
        for (let x = -this.navigation.half; x <= this.navigation.half; x += 0.24) {
          for (let z = -this.navigation.half; z <= this.navigation.half; z += 0.24) {
            if (!this.navigation.free({ x, z })) continue;
            const dSq = (x - desired.x) * (x - desired.x) + (z - desired.z) * (z - desired.z);
            if (dSq < bestDistSq) {
              bestDistSq = dSq;
              best = new T.Vector3(x, 0, z);
            }
          }
        }
        if (best) desired.copy(best);
      }
      ch.resetPose(desired, nextLayout.character.rotY);
      ch.setActivity('idle');
      this.exploration.locomotionAcc.snap(desired.x, 0, desired.z, nextLayout.character.rotY);
      this.exploration.elevationSpring.reset(0);
    }

    this.reportExploration();
    this.wake();
  }
  toggleWindow(want?: boolean) {
    if (!this.layout?.room.visible || !this.layout.room.wallRight) return;
    const open = want ?? !this.layout.room.windowOpen;
    windowLatch(open);
    this.cb.onWindow?.(open);
  }
  /** Through the door: the camera crosses the threshold, the door already being open from standing near it. */
  enterDoor(destination: 'arena' | 'games') {
    const half = (this.layout?.room.size ?? 6) / 2;
    const x = (destination === 'arena' ? -1 : 1) * (this.layout?.room.size ?? 6) * .23;
    if (!this.exploration.active) return 0;
    const seconds = this.reduced ? 0 : .6;
    this.exploration.enterDoor(this.stage.localToWorld(new T.Vector3(x, 1.45, half + .34)), seconds || .01);
    this.wake();
    return seconds * 1000;
  }
  cancelDoor() {
    this.exploration.enterDoor(null);
    this.room?.door('arena')?.setOpen(false);
    this.room?.door('games')?.setOpen(false);
  }
  private checkpointCarry() {
    const ch=this.character, saver=this.lifeSave, world=this.echoLife, space=this.spaceIdentity;
    if(!ch || !space || !saver?.loaded || !world?.ready || !this.bodyOutside(ch.root.position.toArray())) return;
    for(const id of this.manip.physics?.heldIds ?? []) {
      const p=this.placed.get(id);
      if(!p)continue;
      const pos=p.group.position,prior=saver.state.objects[space+'/'+id];
      if(prior?.held && Math.hypot(prior.object.pos[0]-pos.x,prior.object.pos[2]-pos.z)<.1)continue;
      const obj:SpaceObject={...p.obj,pos:[pos.x,pos.y,pos.z],quat:p.group.quaternion.toArray(),rotY:p.group.rotation.y};
      delete obj.inside;
      saver.setObject(space,id,{object:obj,region:world.walk.region(ch.root.position)??'street',held:true});
      this.lifeObjects.set(id,obj);
      if (this.roomLayout?.objects.some(o=>o.id===id)) void saver.flush().then(()=>{
        if (!saver.failing && !this.disposed && this.lifeSave===saver && this.spaceIdentity===space && this.lifeObjects.has(id)) this.cb.onDespawn?.(id);
      });
      saver.setPlace(space,{x:ch.root.position.x,y:ch.root.position.y,z:ch.root.position.z,rotY:ch.root.rotation.y,region:world.walk.region(ch.root.position)??'street'});
    }
  }
  flushExploration() {
    this.checkpointCarry();
    this.saveCamera();
    if (this.exploration.active && !this.usedObject && this.character?.ready && this.character.standing && this.character.activity === 'idle') {
      const at = this.characterAt();
      if (at) this.cb.onCharacterMoved(at.pos, at.rotY);
    }
  }
  focusDesk(preferred?: string): boolean {
    const candidates = Array.from(this.placed.values()).filter(p => !p.obj.hidden && p.obj.kind.startsWith('desk.'));
    const source = preferred ? this.placed.get(preferred) : null;
    const desk = source?.obj.kind.startsWith('desk.') ? source : candidates.sort((a,b) => a.group.position.distanceTo(source?.group.position ?? this.character?.root.position ?? tmpV) - b.group.position.distanceTo(source?.group.position ?? this.character?.root.position ?? tmpV))[0];
    if (!desk || !this.useObject(desk.obj.id, 'study')) return false;
    this.cb.onCharacterUse(this.usedObject ?? desk.obj.id, 'study');
    this.setView('desk'); return true;
  }
  private get activeCamera(): T.Camera {
    if (this.studioMode !== 'none') return this.studioCamera;
    return this.exploration.active ? this.exploration.camera : this.camera;
  }

  resetCamera() { this.applyCamera({ azimuth: Math.PI / 4, polar: 1.02, zoom: 1, target: [0, 0.9, 0] }); }

  focusOn(id: string | 'character') {
    const target = new T.Vector3();
    if (id === 'character') { if (!this.character?.ready) return; this.character.focusPoint(target); this.stage.localToWorld(target); }
    else { const p = this.placed.get(id); if (!p) return; new T.Box3().setFromObject(p.group).getCenter(target); }
    const c = this.cameraState();
    this.applyCamera({ ...c, target: [target.x, target.y, target.z], zoom: Math.max(c.zoom, 1.8) });
  }

  private cameraState(): Layout['camera'] {
    const off = this.camera.position.clone().sub(this.controls.target);
    const sph = new T.Spherical().setFromVector3(off);
    return { view: this.mode === 'edit' ? this.explorationBeforeEdit : this.exploration.view, yaw: Math.atan2(Math.sin(this.exploration.yaw), Math.cos(this.exploration.yaw)), pitch: this.exploration.pitch, azimuth: sph.theta, polar: sph.phi, zoom: this.camera.zoom, target: [this.controls.target.x, this.controls.target.y, this.controls.target.z] };
  }

  // ── Placement ────────────────────────────────────────────────────────────────────────────────────────
  private setPointer(e: PointerEvent | { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.activeCamera);
  }

  /** Where an item of `item` would go under the pointer (stage-local), and how it should face. */
  private surfacePoint(item: CatalogItem, ignore: string | null): { pos: T.Vector3; rotY: number | null; valid: boolean } | null {
    const half = (this.layout?.room.size ?? 6) / 2;
    const ray = this.raycaster.ray.clone();
    const inv = new T.Matrix4().copy(this.stage.matrixWorld).invert();
    ray.applyMatrix4(inv);
    if (item.place === 'wall') {
      const hits: { p: T.Vector3; rotY: number }[] = [];
      const px = ray.intersectPlane(new T.Plane(new T.Vector3(1, 0, 0), half), new T.Vector3());
      if (px && px.y > 0.2 && px.y < WALL_HEIGHT - 0.1 && Math.abs(px.z) <= half) hits.push({ p: px.setX(-half + item.size[1] / 2), rotY: Math.PI / 2 });
      const pz = ray.intersectPlane(new T.Plane(new T.Vector3(0, 0, 1), half), new T.Vector3());
      if (pz && pz.y > 0.2 && pz.y < WALL_HEIGHT - 0.1 && Math.abs(pz.x) <= half) hits.push({ p: pz.setZ(-half + item.size[1] / 2), rotY: 0 });
      if (!hits.length) return null;
      const best = hits.sort((a, b) => a.p.distanceTo(ray.origin) - b.p.distanceTo(ray.origin))[0];
      if (this.snap) best.p.y = Math.round(best.p.y * 20) / 20;
      return { pos: best.p, rotY: best.rotY, valid: true };
    }
    if (item.place === 'surface') {
      const candidates: T.Object3D[] = [];
      this.placed.forEach((p) => { if (p.obj.id !== ignore && !p.obj.hidden && CATALOG_BY_ID[p.obj.kind]?.tops) candidates.push(p.group); });
      const hits = this.raycaster.intersectObjects(candidates, true);
      for (const h of hits) {
        const id = h.object.userData.objectId as string;
        const p = this.placed.get(id);
        const it = p && CATALOG_BY_ID[p.obj.kind];
        if (!p || !it?.tops) continue;
        const local = h.point.clone().applyMatrix4(inv);
        const rel = (local.y - p.obj.pos[1]) / p.obj.scale;
        const top = [...it.tops].sort((a, b) => Math.abs(a - rel) - Math.abs(b - rel))[0];
        if (Math.abs(top - rel) > 0.12) continue;
        local.y = p.obj.pos[1] + top * p.obj.scale;
        return { pos: local, rotY: null, valid: true };
      }
    }
    const floorHit = ray.intersectPlane(new T.Plane(new T.Vector3(0, 1, 0), 0), new T.Vector3());
    if (!floorHit) return null;
    if (this.snap) { floorHit.x = Math.round(floorHit.x * 20) / 20; floorHit.z = Math.round(floorHit.z * 20) / 20; }
    const lim = half + (this.layout?.room.visible ? 0 : 3);
    const inside = Math.abs(floorHit.x) <= lim && Math.abs(floorHit.z) <= lim;
    floorHit.x = T.MathUtils.clamp(floorHit.x, -lim, lim);
    floorHit.z = T.MathUtils.clamp(floorHit.z, -lim, lim);
    return { pos: floorHit, rotY: null, valid: inside };
  }

  /** Footprint overlap with other blocking floor items (rugs and the item itself excluded). */
  private overlaps(item: CatalogItem, pos: T.Vector3, rotY: number, scale: number, ignore: string | null) {
    if (item.flat || item.place !== 'floor') return false;
    const fp = (it: CatalogItem, p: T.Vector3 | [number, number, number], ry: number, s: number) => {
      const x = Array.isArray(p) ? p[0] : p.x, z = Array.isArray(p) ? p[2] : p.z;
      const c = Math.abs(Math.cos(ry)), sn = Math.abs(Math.sin(ry));
      const w = (it.size[0] * c + it.size[1] * sn) * s / 2, d = (it.size[0] * sn + it.size[1] * c) * s / 2;
      return { x0: x - w, x1: x + w, z0: z - d, z1: z + d };
    };
    const a = fp(item, pos, rotY, scale);
    for (const p of this.placed.values()) {
      if (p.obj.id === ignore || p.obj.hidden) continue;
      const it = CATALOG_BY_ID[p.obj.kind];
      if (!it || it.flat || it.place !== 'floor') continue;
      const b = fp(it, p.obj.pos, p.obj.rotY, p.obj.scale);
      if (a.x0 < b.x1 - 0.02 && a.x1 > b.x0 + 0.02 && a.z0 < b.z1 - 0.02 && a.z1 > b.z0 + 0.02) return true;
    }
    return false;
  }

  /** Starts a drag from the catalogue: a ghost of the real item follows the pointer. */
  beginPlacement(kind: string) {
    this.cancelPlacement();
    const group = build(kind);
    group.traverse((o) => {
      const m = o as T.Mesh;
      if (!m.isMesh) return;
      const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((x) => { const c = x.clone(); c.transparent = true; c.opacity = 0.75; return c; });
      m.material = mats.length === 1 ? mats[0] : mats;
      m.castShadow = false;
    });
    group.visible = false;
    this.stage.add(group);
    this.ghost = { kind, group, rotY: 0, valid: false, pos: new T.Vector3() };
    this.wake();
  }

  rotateGhost(step: number) { if (this.ghost) { this.ghost.rotY += step; this.ghost.group.rotation.y = this.ghost.rotY; } }

  /** Moves the ghost under a pointer anywhere on screen (the drag starts in the toolbar, outside the canvas). */
  moveGhost(clientX: number, clientY: number) {
    const g = this.ghost;
    if (!g) return;
    this.setPointer({ clientX, clientY });
    const item = CATALOG_BY_ID[g.kind];
    const at = item && this.surfacePoint(item, null);
    if (!at) { g.group.visible = false; g.valid = false; return; }
    if (at.rotY !== null) g.rotY = at.rotY;
    g.group.position.copy(at.pos);
    g.group.rotation.y = g.rotY;
    g.group.visible = true;
    g.pos.copy(at.pos);
    g.valid = at.valid && (this.freePlacement || !this.overlaps(item, at.pos, g.rotY, 1, null));
    this.tintGhost(g.group, g.valid);
    this.wake();
  }

  private tintGhost(group: T.Group, valid: boolean) {
    group.traverse((o) => {
      const m = o as T.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const x of mats) {
        const s = x as T.MeshStandardMaterial;
        if (s.emissive) { s.emissive.set(valid ? '#3b2fb8' : '#c0264b'); s.emissiveIntensity = valid ? 0.18 : 0.6; }
      }
    });
  }

  /** Ends a catalogue drag: places the item if the spot is valid. */
  endPlacement(clientX: number, clientY: number): boolean {
    const g = this.ghost;
    if (!g) return false;
    this.moveGhost(clientX, clientY);
    const ok = g.valid && g.group.visible;
    const kind = g.kind, pos = g.pos.clone(), rotY = g.rotY;
    this.cancelPlacement();
    if (ok) this.cb.onPlace(kind, [pos.x, pos.y, pos.z], rotY);
    return ok;
  }

  cancelPlacement() {
    if (!this.ghost) return;
    this.stage.remove(this.ghost.group);
    this.ghost.group.traverse((o) => {
      const m = o as T.Mesh;
      if (m.isMesh) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
    });
    this.ghost = null;
  }

  /** A free spot near the centre for an item added with a click (no drag). */
  freeSpot(kind: string): { pos: [number, number, number]; rotY: number } {
    const item = CATALOG_BY_ID[kind];
    const half = (this.layout?.room.size ?? 6) / 2;
    if (item?.place === 'wall') return { pos: [-half + item.size[1] / 2, 1.6, 0.4 + Math.random() * 0.6], rotY: Math.PI / 2 };
    if (item?.place === 'surface') {
      for (const p of this.placed.values()) {
        const it = CATALOG_BY_ID[p.obj.kind];
        if (!it?.tops || p.obj.hidden) continue;
        const top = it.tops[0] * p.obj.scale;
        return { pos: [p.obj.pos[0] + (Math.random() - 0.5) * it.size[0] * 0.6, p.obj.pos[1] + top, p.obj.pos[2] + (Math.random() - 0.5) * it.size[1] * 0.4], rotY: p.obj.rotY };
      }
    }
    for (let i = 0; i < 40; i++) {
      const pos = new T.Vector3((Math.random() - 0.3) * half * 1.4, 0, (Math.random() - 0.3) * half * 1.4);
      if (!item || !this.overlaps(item, pos, 0, 1, null)) return { pos: [pos.x, 0, pos.z], rotY: 0 };
    }
    return { pos: [0.5, 0, 0.5], rotY: 0 };
  }

  // ── Pointer ──────────────────────────────────────────────────────────────────────────────────────────
  private pickObject(): string | null {
    const roots: T.Object3D[] = [];
    this.placed.forEach((p) => { if (!p.obj.hidden && (!this.lifeObjects.has(p.obj.id) || this.exploration.active)) roots.push(p.group); });
    const hits = this.raycaster.intersectObjects(roots, true).filter((h) => !h.object.userData.blob);
    return hits.length ? (hits[0].object.userData.objectId as string) : null;
  }

  private pickCharacter(): boolean {
    if (!this.character?.ready) return false;
    return this.raycaster.intersectObject(this.character.root, true).length > 0;
  }

  private onStudioWheel = (e: WheelEvent) => {
    if (this.studioMode === 'photo') {
      e.preventDefault();
      const step = Math.sign(e.deltaY || e.deltaX) * 0.28;
      this.studioPhotoOpts.zoomDelta = T.MathUtils.clamp(
        (this.studioPhotoOpts.zoomDelta ?? 0) + step,
        -1.95,
        6.15,
      );
      this.wake();
    }
  };

  private onPointerDown = (e: PointerEvent) => {
    if (this.studioMode === 'photo' || this.studioMode === 'creator') {
      if (e.button === 0 || e.button === 2) {
        this.studioDrag = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
        try {
          this.canvas.setPointerCapture(e.pointerId);
        } catch {
          // Synthetic pointer event without capture support.
        }
        this.canvas.style.cursor = 'grabbing';
      }
      return;
    }
    if (e.button === 0 && !this.reduced) {
      this.setPointer(e);
      const surfaces: T.Object3D[] = [];
      this.stage.traverseVisible(node => {
        const material = (node as T.Mesh).material;
        if (node.userData.liquidRipple || (material instanceof T.MeshPhysicalMaterial && material.transmission > 0)) surfaces.push(node);
      });
      // Only a ray aimed at an effect needs the exact foreground occlusion
      // test. Ordinary clicks should never skin the whole avatar on the CPU.
      if (this.raycaster.intersectObjects(surfaces, false).length) {
        const hit = this.raycaster.intersectObject(this.stage, true).find(h => h.object.visible);
        if (hit?.uv) hit.object.userData.liquidRipple?.(hit.uv);
        const material = (hit?.object as T.Mesh | undefined)?.material;
        if (material instanceof T.MeshPhysicalMaterial && material.transmission > 0) pulseGlass();
      }
    }
    if (this.exploration.active) return;
    if (e.button !== 0) return;
    this.setPointer(e);
    const hit = this.pickObject();
    this.down = { x: e.clientX, y: e.clientY, t: performance.now(), hit };
    if (this.mode === 'edit' && hit) {
      const p = this.placed.get(hit);
      if (!p) return;
      const groupIds = p.obj.group ? [...this.placed.values()].filter((q) => q.obj.group === p.obj.group).map((q) => q.obj.id) : [hit];
      if (!this.selection.includes(hit) || e.shiftKey) this.cb.onSelect(groupIds, e.shiftKey);
      if (p.obj.locked || e.shiftKey) return;
      this.controls.enabled = false;
      const item = CATALOG_BY_ID[p.obj.kind];
      const at = item && this.surfacePoint(item, hit);
      this.drag = { id: hit, offset: at ? new T.Vector3(...p.obj.pos).sub(at.pos).setY(0) : new T.Vector3(), moved: false, merge: `drag-${hit}-${Date.now()}` };
      this.canvas.setPointerCapture(e.pointerId);
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.studioMode === 'photo' || this.studioMode === 'creator') {
      if (this.studioDrag && this.studioDrag.pointerId === e.pointerId) {
        const dx = e.clientX - this.studioDrag.lastX;
        const dy = e.clientY - this.studioDrag.lastY;
        this.studioDrag.lastX = e.clientX;
        this.studioDrag.lastY = e.clientY;
        if (this.studioMode === 'photo') {
          this.studioPhotoOpts.yawDelta = (this.studioPhotoOpts.yawDelta ?? 0) - dx * 0.0075;
          this.studioPhotoOpts.pitchDelta = T.MathUtils.clamp(
            (this.studioPhotoOpts.pitchDelta ?? 0.08) + dy * 0.0055,
            -0.55,
            0.85,
          );
        } else {
          this.studioCreatorOpts.yawOffset = (this.studioCreatorOpts.yawOffset ?? 0) + dx * 0.0085;
        }
        this.wake();
      } else {
        this.canvas.style.cursor = 'grab';
      }
      return;
    }
    if (this.exploration.active) return;
    this.setPointer(e);
    if (this.drag) {
      const p = this.placed.get(this.drag.id);
      const item = p && CATALOG_BY_ID[p.obj.kind];
      if (!p || !item) return;
      const at = this.surfacePoint(item, this.drag.id);
      if (!at) return;
      const pos = item.place === 'floor' ? at.pos.clone().add(this.drag.offset) : at.pos;
      const rotY = at.rotY ?? p.obj.rotY;
      const valid = at.valid && (this.freePlacement || !this.overlaps(item, pos, rotY, p.obj.scale, this.drag.id));
      p.group.position.copy(pos);
      p.group.rotation.y = rotY;
      this.tintGhost(p.group, valid);
      p.group.userData.valid = valid;
      this.drag.moved = true;
      this.updateSelection();
      this.wake();
      return;
    }
    if (this.mode === 'use') {
      const hit = this.pickObject();
      const it = hit ? CATALOG_BY_ID[this.placed.get(hit)!.obj.kind] : null;
      const usable = !!hit && !!(it?.action || it?.anchor || this.placed.get(hit)?.obj.action);
      this.canvas.style.cursor = usable || this.pickCharacter() ? 'pointer' : '';
    } else {
      this.canvas.style.cursor = this.pickObject() ? 'grab' : '';
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.studioDrag && this.studioDrag.pointerId === e.pointerId) {
      this.studioDrag = null;
      try {
        if (this.canvas.hasPointerCapture(e.pointerId)) {
          this.canvas.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Synthetic pointer event without capture support.
      }
      this.canvas.style.cursor = this.studioMode === 'photo' || this.studioMode === 'creator' ? 'grab' : '';
      return;
    }
    if (this.studioMode !== 'none') return;
    if (this.exploration.active) return;
    const down = this.down;
    this.down = null;
    if (this.drag) {
      const d = this.drag;
      this.drag = null;
      this.controls.enabled = true;
      const p = this.placed.get(d.id);
      if (p) {
        this.tintGhost(p.group, true);
        p.group.traverse((o) => { const s = (o as T.Mesh).material as T.MeshStandardMaterial | undefined; if (s?.emissive && !s.name.startsWith('glow') && !s.name.startsWith('screen')) { s.emissive.set('#000000'); s.emissiveIntensity = 1; } });
        if (d.moved && p.group.userData.valid !== false) {
          this.cb.onMove(d.id, [p.group.position.x, p.group.position.y, p.group.position.z], p.group.rotation.y, d.merge);
          this.game.game?.signal('usedBuildMode');
          this.cb.onMoveDone();
        } else if (d.moved) {
          p.group.position.set(...p.obj.pos);
          p.group.rotation.y = p.obj.rotY;
        }
      }
      this.updateSelection();
      return;
    }
    if (!down || e.target !== this.canvas) return;
    const click = Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6 && performance.now() - down.t < 500;
    if (!click) { this.saveCamera(); return; }
    this.setPointer(e);
    if (this.mode === 'edit') {
      if (!down.hit) this.cb.onSelect(this.pickCharacter() ? ['character'] : [], false);
      return;
    }
    if (this.pickCharacter()) { this.cb.onCharacterClick(); return; }
    if (down.hit) { this.cb.onActivate(down.hit); return; }
    // a click on the floor: the character walks there
    const ray = this.raycaster.ray.clone().applyMatrix4(new T.Matrix4().copy(this.stage.matrixWorld).invert());
    const p = ray.intersectPlane(new T.Plane(new T.Vector3(0, 1, 0), 0), new T.Vector3());
    const half = (this.layout?.room.size ?? 6) / 2 - 0.3;
    if (p && this.character?.ready && Math.abs(p.x) < half && Math.abs(p.z) < half) {
      const walking = this.character.goTo(p, () => {
        const at = this.characterAt();
        if (at) this.cb.onCharacterMoved(at.pos, at.rotY);
      });
      if (walking) this.usedObject = null;
      if(!walking) window.dispatchEvent(new Event('study:navigation-blocked'));
    }
  };

  private saveCamera() {
    const c = this.cameraState();
    const k = JSON.stringify(c);
    if (k !== this.lastCamera) { this.lastCamera = k; this.cb.onCamera(c); }
  }

  private updateSelection() {
    const ids = this.selection.filter((s) => this.placed.has(s));
    if (!ids.length || this.mode !== 'edit') { this.selectionBox.visible = false; return; }
    const box = new T.Box3();
    ids.forEach((id) => box.expandByObject(this.placed.get(id)!.group));
    this.selectionBox.box.copy(box);
    this.selectionBox.visible = true;
  }

  // ── Frame ────────────────────────────────────────────────────────────────────────────────────────────
  private frame() {
    const nowMs = performance.now();
    const rawDt = this.lastFrameMs > 0 ? Math.max(0, (nowMs - this.lastFrameMs) / 1000) : 0.016;
    this.lastFrameMs = nowMs;
    const dt = Math.min(0.1, rawDt);
    if (rawDt > 0 && rawDt < 0.25) {
      this.emaFrameMs += (rawDt * 1000 - this.emaFrameMs) * 0.12;
      this.elapsedRunSec += dt;
    }
    const photoFrozen = this.studioMode === 'photo' && !!this.studioPhotoOpts.freezeTime;
    const simDt = photoFrozen ? 0 : dt;
    if (!this.reduced && !photoFrozen) this.time += dt;
    if (this.controls.enabled && this.studioMode === 'none') this.controls.update();
    this.hideFacingWalls();
    this.room?.update(this.time);
    this.exploration.setDialogueCamera(this.exploration.active && this.studioMode === 'none' ? this.game.dialogueCameraTarget() : null);
    if (this.studioMode === 'none') this.exploration.update(simDt, this.reduced);
    if (this.exploration.active && this.studioMode === 'none') {
      if (this.exploration.isMoving) {
        this.game.notifyEmbodiedManualInput();
      }
      const showerTarget = this.game.isShoweringActive ? this.game.showerStandTarget : null;
      if (showerTarget && this.character?.ready) {
        const showerSig = `${showerTarget.anchor.x.toFixed(2)}|${showerTarget.anchor.y.toFixed(2)}|${showerTarget.anchor.z.toFixed(2)}|${showerTarget.yaw.toFixed(2)}`;
        if (!this.wasShoweringSessionActive || showerSig !== this.lastShowerTargetSig) {
          this.wasShoweringSessionActive = true;
          this.lastShowerTargetSig = showerSig;
          this.character.setEmbodiedSession({
            anchor: showerTarget.anchor,
            yaw: showerTarget.yaw,
            clip: 'shower_rinse',
            active: true,
            onEnd: () => {
              if (this.game?.isShoweringActive) {
                this.game.cancelShower();
              }
            },
          });
        }
        this.game.syncEmbodiedAutoApproach(this.character.root.position);
      } else {
        if (this.wasShoweringSessionActive) {
          this.wasShoweringSessionActive = false;
          this.lastShowerTargetSig = '';
          this.character?.setEmbodiedSession(null);
        }
        const embodiedTarget = this.game.getEmbodiedActionTarget();
        if (embodiedTarget && this.character?.ready) {
          const ch = this.character;
          const skipAlign =
            Boolean(embodiedTarget.seat) ||
            ch.body.occupied ||
            ch.isApproachingSeat ||
            ch.isDismountingSeat;
          if (!skipAlign) {
            const targetClip = (embodiedTarget as { clip?: string | null }).clip ?? undefined;
            const targetSig = `${embodiedTarget.x.toFixed(2)}|${embodiedTarget.y.toFixed(2)}|${embodiedTarget.z.toFixed(2)}|${embodiedTarget.yaw.toFixed(2)}|${embodiedTarget.durationSec.toFixed(2)}|${targetClip ?? ''}`;
            if (targetSig !== this.lastEmbodiedTargetSig) {
              this.lastEmbodiedTargetSig = targetSig;
              ch.alignToEmbodiedAction({
                anchor: { x: embodiedTarget.x, y: embodiedTarget.y, z: embodiedTarget.z },
                yaw: embodiedTarget.yaw,
                clip: targetClip,
              });
            }
          }
          this.game.syncEmbodiedAutoApproach(ch.root.position);
        } else if (this.lastEmbodiedTargetSig) {
          this.lastEmbodiedTargetSig = '';
        }
      }
    } else {
      if (this.wasShoweringSessionActive) {
        this.wasShoweringSessionActive = false;
        this.lastShowerTargetSig = '';
        this.character?.setEmbodiedSession(null);
      }
      if (this.lastEmbodiedTargetSig) {
        this.lastEmbodiedTargetSig = '';
      }
    }
    const game = this.game.game;
    const activeVeh = this.game.activeDrivenVehicle ?? game?.drivenVehicle ?? null;
    this.character?.setVehiclePose(
      game?.riderPose ?? 'none',
      activeVeh?.speed ?? this.exploration.speed,
      activeVeh?.steer ?? game?.twoWheeler.steer ?? 0,
      activeVeh?.spec?.model,
    );
    const sport = this.game.basketballPose();
    if (sport && sport.active && (sport.mode === 'dribble' || sport.mode === 'aim' || sport.mode === 'shoot')) {
      this.character?.setSportPose(sport.mode, sport.dribblePhase, sport.ballWorld);
    } else {
      this.character?.setSportPose('none', 0);
    }
    const windVec = this.outdoorLighting ? this.echoLife?.weatherUniforms?.uWindVec.value : null;
    this.character?.setSecondaryWind(windVec ? windVec.x : 0, windVec ? windVec.y : 0);
    this.character?.update(simDt, this.reduced, dt);
    this.syncRollingChairFrame(simDt);
    if (
      game?.people.playerSeat &&
      !this.character?.occupies('city-seat:' + game.people.playerSeat) &&
      !this.character?.isApproachingSeat
    ) {
      game.people.playerSeat = null;
    }
    this.footsteps();
    const talkTarget = game?.people.talking && !this.exploration.isFirstPersonCameraActive ? 1 : 0;
    this.dialogueZoom += (talkTarget - this.dialogueZoom) * (this.reduced ? 1 : 1 - Math.exp(-7 * dt));
    const fovOffset = -this.passage.update(dt, this.reduced) * 4 - (this.exploration.isFirstPersonCameraActive ? 0 : this.dialogueZoom * 4);
    if (this.standingExit && this.character?.standing) {
      this.standingExit = false;
      const ch = this.character;
      this.exploration.locomotionAcc.snap(ch.root.position.x, ch.root.position.y, ch.root.position.z, ch.root.rotation.y);
      this.exploration.elevationSpring.reset(ch.root.position.y);
      const at = this.characterAt();
      if (at) this.cb.onCharacterMoved(at.pos, at.rotY);
    }
    if (this.room) {
      if (this.exploration.active && this.character?.ready) {
        const p = this.character.root.position;
        this.portalOccScratch[0].x = p.x;
        this.portalOccScratch[0].y = p.y;
        this.portalOccScratch[0].z = p.z;
        this.room.door('arena')?.updateOccupancy(this.portalOccScratch);
        this.room.door('games')?.updateOccupancy(this.portalOccScratch);
      } else {
        this.room.door('arena')?.updateOccupancy([]);
        this.room.door('games')?.updateOccupancy([]);
      }
      this.room.setExploring(this.exploration.active, this.character?.root.position ?? null, dt, this.reduced);
    }
    if (this.studioMode !== 'none') {
      this.updateStudioCamera(dt);
    }

    const cfg = getRenderConfig(this.qualityTier, this.maxAnisotropy, this.gpuReport.gpuClass);
    const audio = musicBands();
    const calm = this.exploration.view === 'desk' ? 0.2 : 1;
    const audioPulse = this.reduced ? 0 : audio.bass * 0.035 * calm;

    if (this.echoLife) {
      if(this.awaitingResidence && this.game.saverNow?.loaded)this.restoreLifePlace(true);
      if (this.exploration.active) this.ensureLife();
      const world = this.echoLife, l = this.layout;
      if (world.ready) {
        this.syncHomeMirrors(world);
      }
      if (world.ready && world.atmosphere && this.atmosphereWarmedFor !== world) {
        world.atmosphere.warmupHdris(this.renderer);
        this.atmosphereWarmedFor = world;
      }
      if (this.sharedCity && l) {
        const visible = this.exploration.active && this.mode !== 'edit' && this.game.saverNow?.loaded &&
          this.game.saverNow.account === String(this.sharedCity.learner);
        this.sharedCity.update(dt, this.stage, world, visible ? this.character?.root.position ?? null : null,
          this.character?.root.rotation.y ?? 0, l.character.model, this.reduced,this.game.game,this.character?.rig??null,this.character?.publicPosture);
      }

      // Whenever Echo Life 3D exploration is active, ALWAYS hide the opaque 2D `window-view` shader plane
      // whether the casement is closed or open so the full 3D city panorama renders through transparent glass!
      const view = this.cachedWindowView;
      if (view && l) {
        view.visible = !(world.ready && this.exploration.active);
      }
      const curtainsClosed = (l?.room.curtains ?? 0) >= 0.92;
      world.setWindowOccluded(Boolean(view?.visible || curtainsClosed));

      // Forward driven vehicle position so nearby park/garden grass blades bend away from wheels.
      const drivenVeh = activeVeh;
      if (drivenVeh) {
        const vy = world.walk.groundAt(drivenVeh.pose.x, drivenVeh.pose.z) ?? 0;
        world.setVehiclePos({
          x: drivenVeh.pose.x,
          y: vy,
          z: drivenVeh.pose.z,
          radius: drivenVeh.spec?.collisionRadius ?? (game?.car.driving ? 1.35 : 0.7),
        });
      } else {
        world.setVehiclePos(null);
      }

      // While the game runs, the city's sky, water, weather, grass & vegetation follow the game's clock & weather.
      const sky = this.exploration.active ? this.game.sky() : null, lifeRain = this.life?.weather?.rain ?? 0;
      world.update(dt, this.exploration.active, this.character?.root.position ?? null, this.activeCamera, this.reduced, sky ? sky.day : this.dayNow(), sky ? sky.rain : lifeRain, sky?.angle, sky?.season, sky?.cloud, sky?.snow ?? 0);

      const body = this.character?.root.position;
      const region = world.stats.region;
      const indoorBlend = T.MathUtils.clamp(world.indoorBlend ?? 0, 0, 1);
      const isOutdoors = Boolean(sky && body && region && OUTDOOR_LIGHTING_REGIONS.has(region));
      const insideCityBld = Boolean(
        this.exploration.active &&
          body &&
          (world.insideBuildingId !== null || Boolean(region?.startsWith('building:'))),
      );

      if (this.studioMode !== 'creator') {
        if (isOutdoors && sky && body) {
          const wasOutdoors = this.outdoorLighting;
          this.outdoorLighting = true;
          this.insideCityLighting = false;
          this.scene.background = null;

          if (world.atmosphere) {
            world.atmosphere.applyToScene(
              this.scene,
              this.renderer,
              { hemi: this.hemi, key: this.key, fill: this.fill, windowLight: this.windowLight, fog: this.outdoorFog },
              audioPulse,
            );
          }

          if (indoorBlend > 0.002) {
            this.hemi.color.lerp(this.threshSkyColor, indoorBlend);
            this.hemi.groundColor.lerp(this.threshGroundColor, indoorBlend);
            this.hemi.intensity = T.MathUtils.lerp(this.hemi.intensity, 0.56, indoorBlend);
            this.key.color.lerp(this.threshKeyColor, indoorBlend);
            this.key.intensity = T.MathUtils.lerp(this.key.intensity, 0.48, indoorBlend);
            this.outdoorFog.density *= 1 - indoorBlend;
            this.renderer.toneMappingExposure = T.MathUtils.lerp(
              this.renderer.toneMappingExposure,
              1.02,
              indoorBlend,
            );
          }

          // G-01 FIX: Smoothly zero out indoor `windowLight` and `fill` outdoors so directional shadows
          // retain true 3.6:1-4.0:1 sunlit key-to-fill contrast instead of getting washed out!
          const suppressRate = this.reduced || !wasOutdoors ? 1 : 1 - Math.exp(-12 * dt);
          if (this.windowLight.intensity > 0) {
            this.windowLight.intensity *= 1 - suppressRate;
            if (this.windowLight.intensity < 0.002) this.windowLight.intensity = 0;
          }
          if (this.fill.intensity > 0) {
            this.fill.intensity *= 1 - suppressRate;
            if (this.fill.intensity < 0.002) this.fill.intensity = 0;
          }

          // Event-gated idempotent CSM patching for world, player avatar, and lazy-streamed NPCs/vehicles (0.00 ms steady-state).
          const worldCsmSig = `${world.solidsVersion}|${world.stats.populated}|${world.stats.vegetation?.loadedSpecies ?? -1}|${world.stats.streaming?.transitions ?? 0}`;
          if (!this.csmPatchedObjects.has(world.group) || worldCsmSig !== this.lastCsmWorldSig) {
            this.csmPatchedObjects.add(world.group);
            this.lastCsmWorldSig = worldCsmSig;
            this.echoCsm.patchObject(world.group);
          }
          if (this.character?.root && !this.csmPatchedObjects.has(this.character.root)) {
            this.csmPatchedObjects.add(this.character.root);
            this.echoCsm.patchObject(this.character.root);
          }
          const peopleRoot = this.game.peopleGroup;
          if (peopleRoot) {
            const childSig = peopleRoot.children.length;
            if (!this.csmPatchedObjects.has(peopleRoot) || childSig !== this.lastCsmPeopleChildren) {
              this.csmPatchedObjects.add(peopleRoot);
              this.lastCsmPeopleChildren = childSig;
              this.echoCsm.patchObject(peopleRoot);
            }
          }

          const snap = world.atmosphere?.snapshot;
          const useCsm = cfg.shadow.enabled && cfg.shadow.cascades > 0;
          // Pure uniform zone switch (`uCsmEnabled`): ZERO `NUM_DIR_LIGHT_SHADOWS` change & ZERO mid-run recompile!
          this.echoCsm.setZoneMode(useCsm ? 'outdoor' : 'study-room');

          if (useCsm) {
            if (snap) {
              tmpSunDir.copy(snap.keyDir);
            } else {
              tmpSunDir.set(Math.cos(sky.angle), Math.max(0.215, Math.abs(Math.sin(sky.angle))), -0.32).normalize();
            }
            this.echoCsm.update(this.activeCamera, tmpSunDir, this.stage.localToWorld(tmpV.copy(body)));
          } else {
            // Single-light fallback shadow frustum (e.g. Low tier or 0-cascade configuration).
            const extent = cfg.shadow.frustumHalfExtent || 20;
            this.setShadowExtent(extent);
            const mapSz = Math.max(512, cfg.shadow.mapSize || 1024);
            const texel = (2 * extent) / mapSz;
            const worldPos = this.stage.localToWorld(tmpV.copy(body));
            this.key.target.position.set(Math.round(worldPos.x / texel) * texel, worldPos.y, Math.round(worldPos.z / texel) * texel);
            if (snap) {
              const dist = Math.max(28, extent * 0.95);
              tmpSunDir.copy(snap.keyDir);
              if (tmpSunDir.y < 0.21) {
                tmpSunDir.y = 0.21;
                tmpSunDir.normalize();
              }
              this.key.position.copy(this.key.target.position).addScaledVector(tmpSunDir, dist);
            } else {
              const sunCos = Math.cos(sky.angle), sunSin = Math.sin(sky.angle);
              this.key.position.set(
                this.key.target.position.x + sunCos * 24,
                this.key.target.position.y + Math.max(6, Math.abs(sunSin) * 24),
                this.key.target.position.z - 7.5,
              );
            }
          }

          // Throttled pooled night streetlamps (only re-sort when moving > 3 m or streaming solids change).
          const nightW = snap ? snap.night : Math.max(0, Math.min(1, 1 - sky.day * 1.35));
          const lampPool = Math.min(this.lamps.length, cfg.atmosphere.streetlampPool);
          if (nightW > 0.14 && lampPool > 0) {
            const dxL = body.x - this.lastLampQueryPos.x;
            const dzL = body.z - this.lastLampQueryPos.z;
            if (
              dxL * dxL + dzL * dzL > 9 ||
              this.lastLampSolidsVer !== world.solidsVersion ||
              this.lastLampPoolCount !== lampPool
            ) {
              this.cachedNearbyLamps = world.lampsNear(body, lampPool);
              this.lastLampQueryPos.set(body.x, body.y, body.z);
              this.lastLampSolidsVer = world.solidsVersion;
              this.lastLampPoolCount = lampPool;
            }
            for (let i = 0; i < this.lamps.length; i++) {
              const p = i < lampPool ? this.cachedNearbyLamps[i] : undefined;
              const lgt = this.lamps[i], halo = this.halos[i];
              if (p) {
                lgt.position.copy(p); lgt.color.set('#ffcf82'); lgt.intensity = 7.5 * nightW; lgt.distance = 14;
                const op = 0.52 * nightW;
                halo.position.copy(p); halo.material.color.set('#ffcf82'); halo.material.opacity = op; halo.visible = op > 0.005;
              } else {
                lgt.intensity = 0; halo.material.opacity = 0; halo.visible = false;
              }
            }
          } else {
            for (let i = 0; i < this.lamps.length; i++) { this.lamps[i].intensity = 0; this.halos[i].material.opacity = 0; this.halos[i].visible = false; }
          }
        } else if (insideCityBld && body) {
          // Inside an enterable city building (Library, Market, Cafe, Shops): keep `key.castShadow` & `scene.fog`
          // 100% invariant (`uCsmEnabled = -1.0`, `key.shadow.intensity = 0.0`, `fog.density = 0.0`) so doorway
          // crossings cause ZERO shader recompiles (`programDelta === 0`) and ZERO stale outdoor shadows!
          const useThresholdBlend = Boolean(sky && world.atmosphere && indoorBlend < 0.998);
          const useCsmAtDoor = useThresholdBlend && indoorBlend < 0.85 && cfg.shadow.enabled && cfg.shadow.cascades > 0;
          this.echoCsm.setZoneMode(useCsmAtDoor ? 'outdoor' : 'city-interior');
          this.outdoorLighting = false;
          this.insideCityLighting = !useCsmAtDoor;
          this.scene.background = null;
          if (useThresholdBlend && world.atmosphere) {
            world.atmosphere.applyToScene(
              this.scene,
              this.renderer,
              { hemi: this.hemi, key: this.key, fill: this.fill, windowLight: this.windowLight, fog: this.outdoorFog },
              audioPulse,
            );
            this.hemi.color.lerp(this.threshSkyColor, indoorBlend);
            this.hemi.groundColor.lerp(this.threshGroundColor, indoorBlend);
            this.hemi.intensity = T.MathUtils.lerp(this.hemi.intensity, 0.56, indoorBlend);
            this.key.color.lerp(this.threshKeyColor, indoorBlend);
            this.key.intensity = T.MathUtils.lerp(this.key.intensity, 0.48, indoorBlend);
            this.outdoorFog.density *= 1 - indoorBlend;
            this.renderer.toneMappingExposure = T.MathUtils.lerp(
              this.renderer.toneMappingExposure,
              1.02,
              indoorBlend,
            );
            this.scene.environmentIntensity = T.MathUtils.lerp(
              this.scene.environmentIntensity,
              0.42 + audioPulse,
              indoorBlend,
            );
          } else {
            this.outdoorFog.density = 0;
            world.atmosphere?.syncEnvironment(this.renderer, this.scene);
            this.hemi.color.set('#f6efe4');
            this.hemi.groundColor.set('#75685a');
            this.hemi.intensity = 0.56;
            this.key.intensity = 0.48;
            this.key.color.set('#fff1dc');
            this.renderer.toneMappingExposure = 1.02;
            this.scene.environmentIntensity = 0.42 + audioPulse;
          }
          if (this.scene.fog !== this.outdoorFog) this.scene.fog = this.outdoorFog;
          this.windowLight.intensity = 0;
          this.fill.intensity = 0;
          const worldPos = this.stage.localToWorld(tmpV.copy(body));
          if (useCsmAtDoor && sky) {
            const snap = world.atmosphere?.snapshot;
            if (snap) {
              tmpSunDir.copy(snap.keyDir);
            } else {
              tmpSunDir.set(Math.cos(sky.angle), Math.max(0.215, Math.abs(Math.sin(sky.angle))), -0.32).normalize();
            }
            this.echoCsm.update(this.activeCamera, tmpSunDir, worldPos);
          } else {
            this.key.target.position.copy(worldPos);
            this.key.position.set(worldPos.x + 6, worldPos.y + 10, worldPos.z - 6);
          }
          for (let i = 0; i < this.lamps.length; i++) { this.lamps[i].intensity = 0; this.halos[i].material.opacity = 0; this.halos[i].visible = false; }
        } else if (this.outdoorLighting || this.insideCityLighting || this.echoCsm.active || this.echoCsm.zoneMode !== 'study-room') {
          this.echoCsm.setZoneMode('study-room');
          this.outdoorShadowExtent = -1;
          this.setShadowExtent(6);
          this.outdoorLighting = false;
          this.insideCityLighting = false;
          this.lastLampQueryPos.set(Infinity, 0, Infinity);
          this.applyLighting();
          this.placeLamps();
        }
      }

      // Unified GPU VRAM residency manager + fallback asset budget guard (defers eviction during in-flight compiles).
      const curZone = world.stats.zone ?? null;
      const curTransitions = world.stats.streaming?.transitions ?? 0;
      if (curZone !== this.lastPruneZone || curTransitions !== this.lastPruneTransitions) {
        const hadPrevZone = this.lastPruneZone !== null;
        this.lastPruneZone = curZone;
        this.lastPruneTransitions = curTransitions;
        if (hadPrevZone) {
          this.zonePrunePending = true;
          this.vramClock = Math.max(this.vramClock, 2.75);
        }
      }
      this.vramClock += dt;
      if (this.vramClock >= 3 || (this.zonePrunePending && this.vramClock >= 0.35)) {
        const wasZonePrune = this.zonePrunePending;
        this.vramClock = 0;
        this.zonePrunePending = false;
        this.updateResidencyFixedBreakdown();
        if (getInFlightCompileCount() === 0) {
          const resMgr = getEchoLifeResidencyManager();
          resMgr.tick();
          const resStats = resMgr.stats();
          const assetStats = lifeAssetStats();
          const assetMB = lifeAssetTextureMB() + pbrAtlasStats().estimatedVramMB;
          const budgetMB = cfg.streaming.vramBudgetMB || DEFAULT_VRAM_BUDGET_MB[this.qualityTier];
          const overAssetCount = assetStats.cached > cfg.streaming.maxResidentAssets;
          const overMB = assetMB > budgetMB;
          const idleCap = Math.min(
            cfg.streaming.pruneTarget,
            assetStats.referenced + (assetMB < budgetMB * 0.85 ? 24 : 8),
          );
          if (
            (resStats.totalEntries === 0 && (overMB || overAssetCount || (wasZonePrune && assetStats.cached > idleCap))) ||
            assetMB > budgetMB * 1.35 ||
            assetStats.cached > cfg.streaming.maxResidentAssets * 1.35
          ) {
            const severe = assetMB > budgetMB * 1.35 || assetStats.cached > cfg.streaming.maxResidentAssets * 1.35;
            const limit = severe ? 0 : wasZonePrune ? idleCap : cfg.streaming.pruneTarget;
            world.pruneBudget(limit);
          }
        }
      }

      // Bug #10: publish live right-hand stage position for closed-loop palm-to-basketball dribbling
      const handRightStage = this.character?.ready ? this.character.handRightStagePosition(this.handRightScratch) : null;
      setEchoLifePlayerHandRight(handRightStage);

      // Auto-seasonal outfit switching (lightweight 2 Hz check)
      this.lastSeasonalCheckClock += dt;
      if (this.lastSeasonalCheckClock >= 0.5 && this.character?.ready) {
        this.lastSeasonalCheckClock = 0;
        const curSky = this.game.sky();
        if (curSky) {
          this.character.updateSeasonalOutfit({ season: curSky.season, snow: curSky.snow ?? 0 });
        }
      }

      this.game.update(simDt, world, this.exploration.active && this.mode !== 'edit', this.character?.root.position ?? null, this.exploration.yaw, this.activeCamera,
        this.canvas.clientWidth, this.canvas.clientHeight, this.reduced, this.character?.root.rotation.y ?? 0);

      // Bucketed Rapier world solids + unified PlayerCollisionWorld parked vehicle footprints!
      const parkedBoxes = world.ready ? this.game.parkedVehicleBoxes(world) : null;
      if (parkedBoxes) {
        const w4 = world as EchoLifeWorldWave4;
        if (w4.collisionWorld) {
          const dst = this.parkedCollidersScratch;
          dst.length = parkedBoxes.length;
          for (let i = 0; i < parkedBoxes.length; i++) {
            const b = parkedBoxes[i];
            const prev = dst[i];
            if (prev) {
              (prev as { id: string; x: number; z: number; yaw: number; halfWidth: number; halfLength: number; floorY: number; topRel: number }).id = `veh:${i}`;
              (prev as { x: number }).x = b.x;
              (prev as { z: number }).z = b.z;
              (prev as { yaw: number }).yaw = b.yaw;
              (prev as { halfWidth: number }).halfWidth = b.hx;
              (prev as { halfLength: number }).halfLength = b.hz;
              (prev as { floorY: number }).floorY = b.y - b.hy;
              (prev as { topRel: number }).topRel = b.hy * 2;
            } else {
              dst[i] = {
                id: `veh:${i}`,
                x: b.x,
                z: b.z,
                yaw: b.yaw,
                halfWidth: b.hx,
                halfLength: b.hz,
                floorY: b.y - b.hy,
                topRel: b.hy * 2,
              };
            }
          }
          w4.collisionWorld.setParkedVehicles(dst);
        }
      }
      const physics = this.manip.physics;
      if (physics && world.ready) {
        if (this.lifeSolidsFor !== physics) {
          this.physicsBucketKeys.clear();
          for (const [bucketKey, boxes] of world.solidBuckets()) {
            physics.setWorldSolidBucket(bucketKey, boxes);
            this.physicsBucketKeys.add(bucketKey);
          }
          world.setChunkSolidsListener((bucketOrChunk, boxes) => {
            if (this.manip.physics === physics && !this.disposed) {
              const key = bucketOrChunk.includes(':') ? bucketOrChunk : `chunk:${bucketOrChunk}`;
              physics.setWorldSolidBucket(key, boxes);
              if (boxes.length) this.physicsBucketKeys.add(key);
              else this.physicsBucketKeys.delete(key);
            }
          });
          this.lifeSolidsFor = physics;
          this.lifeSolidsVersion = world.solidsVersion;
        } else if (this.lifeSolidsVersion !== world.solidsVersion) {
          const buckets = world.solidBuckets();
          for (const [bucketKey, boxes] of buckets) {
            if (!bucketKey.startsWith('chunk:') && !bucketKey.startsWith('bld:')) {
              physics.setWorldSolidBucket(bucketKey, boxes);
              this.physicsBucketKeys.add(bucketKey);
            }
          }
          this.lifeSolidsVersion = world.solidsVersion;
        }
        if (parkedBoxes) physics.setParkedVehicleBoxes(parkedBoxes);
      }

      // The room's own +x wall leaves the hall doorway open in Rapier; a shut leaf plugs it.
      if (physics && l && this.doorwayFor !== physics) {
        physics.setRoomDoorway(this.lifeDoorway(l.room.size));
        this.doorwayFor = physics;
        this.manip.syncRoom();
      }
      // Gate Rapier door plug updates on monotonic `doorsPassableVersion` (zero 60 Hz Set/Array churn!).
      if (physics && world.ready && (this.lastDoorPlugsFor !== physics || this.lastDoorPlugsVersion !== world.doorsPassableVersion)) {
        const hall = world.door('hall');
        if (hall) physics.setDoorwayOpen(hall.passable);
        const plugs: { hx: number; hy: number; hz: number; x: number; y: number; z: number }[] = [];
        for (const d of world.doors()) {
          if (d.id === 'hall' || d.passable) continue;
          plugs.push({
            hx: d.plan.wallAlong === 'z' ? 0.06 : d.plan.width / 2,
            hy: d.plan.height / 2,
            hz: d.plan.wallAlong === 'z' ? d.plan.width / 2 : 0.06,
            x: d.plan.x, y: d.plan.y + d.plan.height / 2, z: d.plan.z,
          });
        }
        physics.setDoorPlugs(plugs);
        this.lastDoorPlugsFor = physics;
        this.lastDoorPlugsVersion = world.doorsPassableVersion;
      }

      this.doorSaveClock += dt;
      if (
        this.doorsRestoredFor !== world ||
        this.lastSavedDoorsVersion !== world.doorsPassableVersion ||
        this.doorSaveClock >= 0.4
      ) {
        this.doorSaveClock = 0;
        this.lastSavedDoorsVersion = world.doorsPassableVersion;
        this.lifeDoors(world);
      }

      // Things out in the house are seen with the house (the editor's overview keeps the room alone).
      const shown = world.ready && this.exploration.active;
      for (const id of this.lifeObjects.keys()) { const p = this.placed.get(id); if (p && !p.obj.hidden) p.group.visible = shown; }
    } else if (this.doorwayFor && this.manip.physics) { this.manip.physics.setRoomDoorway(null); this.doorwayFor = null; this.manip.syncRoom(); }

    if (this.echoLife?.ready && this.character?.ready && this.exploration.active) {
      if (this.resumeHeld.length && this.manip.resumeCarry(this.resumeHeld[0])) this.resumeHeld.shift();
      this.carrySaveTimer+=dt;
      if(this.carrySaveTimer>=1){this.carrySaveTimer=0;this.checkpointCarry();}
    }
    this.manip.update(dt);
    this.updateBody(dt);
    this.life.update(dt);
    this.water.update(dt);
    // The arms are solved: what the hands hold is drawn in the palms that really hold it,
    // then XPBD hair/scarf & CastLook gaze settle post-IK, and finally the camera reads current-frame poses!
    this.manip.afterBody(dt);
    this.character?.updatePostIk(simDt, this.reduced, dt);
    if (this.studioMode === 'none') {
      // Forward optional additive `fovOffset` (`passage` + `dialogueZoom`) to `syncCameraPostIk` and enforce final
      // `far`/`fov` post-IK so `cameraRig.update()` never overwrites passage/dialogue FOV modulation!
      (this.exploration.syncCameraPostIk as (dt: number, reduced?: boolean, fovOffset?: number) => void)(
        simDt,
        this.reduced,
        fovOffset,
      );
      const nextFar = this.echoLife?.ready && this.exploration.active ? 420 : 90;
      const targetFov = T.MathUtils.clamp(this.exploration.fovNow + fovOffset, 24, 110);
      if (
        Math.abs(this.exploration.camera.far - nextFar) > 1e-4 ||
        Math.abs(this.exploration.camera.fov - targetFov) > 1e-4
      ) {
        this.exploration.camera.far = nextFar;
        this.exploration.camera.fov = targetFov;
        this.exploration.camera.updateProjectionMatrix();
        this.lastExplCamFar = nextFar;
        this.lastExplCamFov = targetFov;
      }
    }
    if (this._warmupReady) {
      this.hasUnlockedFrame = true;
    }

    const world = this.echoLife, body = this.character?.root.position;
    const regionNow = world?.stats.region ?? null;
    // Far outside the residence, downstairs/on the street, or inside a city building: swap Study Room to crisp
    // exterior `study-exterior` facade and omit upstairs furnishings, `room-life`, pet, and portals!
    const distantStudy = Boolean(
      this.exploration.active &&
      world &&
      body &&
      (
        Math.max(Math.abs(body.x), Math.abs(body.z)) > world.size / 2 + 16 ||
        world.insideBuildingId !== null ||
        (body.y < -1.15 && !world.inStudy(body)) ||
        (this.outdoorLighting && regionNow !== 'balcony' && Math.max(Math.abs(body.x), Math.abs(body.z)) > world.size / 2 + 2.5)
      ),
    );
    if (!distantStudy) {
      this.animateObjects();
      if (this.pet) {
        const t = this.time * 0.22;
        const half = (this.layout?.room.size ?? 6) / 2;
        const r = half * 0.55;
        const x = Math.cos(t) * r * 1.1, z = Math.sin(t) * r * 0.8 + 0.3, y = 2.0 + Math.sin(t * 2.3) * 0.15;
        const nx = Math.cos(t + 0.05) * r * 1.1, nz = Math.sin(t + 0.05) * r * 0.8 + 0.3;
        this.pet.root.position.set(x, y, z);
        this.pet.root.lookAt(tmpV.set(nx, y, nz).applyMatrix4(this.stage.matrixWorld));
        this.pet.update(dt, this.reduced ? 0 : 0.35, 0.2);
      }
    }

    this.renderer.info.autoReset = false;
    this.renderer.info.reset();
    // Permanently lock physical transmission OFF (`transmission = 0`) across all zones so crossing
    // doorways NEVER sets `mat.needsUpdate = true` or invokes `renderTransmissionPass()`!
    const maxVfxTier = graphicsTierToVfxTier(this.qualityTier);
    const rawVfxTier = this.vfxQuality.update(dt, this.qualityTier !== 'low');
    const tier: VfxTier = VFX_TIER_ORDER[Math.min(VFX_TIER_ORDER.indexOf(rawVfxTier), VFX_TIER_ORDER.indexOf(maxVfxTier))];
    const allowRoomTransmission = false;
    const glassTier: VfxTier = tier === 'low' ? 'low' : 'medium';
    if (!this.outdoorLighting && !this.insideCityLighting && this.studioMode !== 'creator') {
      this.scene.background = null;
      this.scene.environmentIntensity = (this.exploration.active ? 0.42 : 0.28) + audioPulse;
    }

    // Shadow cadence: skip pass indoors inside city buildings (and Creator Studio); when CSM is active outdoors,
    // EchoCsmSystem manages per-cascade update cadence; single-light Balanced uses cadence 2.
    if (this.renderer.shadowMap.enabled) {
      if (this.insideCityLighting || this.studioMode === 'creator') {
        this.renderer.shadowMap.autoUpdate = false;
        this.renderer.shadowMap.needsUpdate = false;
      } else if (!this.echoCsm.active && cfg.shadow.cadence === 2) {
        this.renderer.shadowMap.autoUpdate = false;
        this.renderer.shadowMap.needsUpdate = (this.shadowFrame++ % 2) === 0;
      } else {
        this.renderer.shadowMap.autoUpdate = true;
      }
    }

    updateGlass(dt, glassTier, this.reduced, allowRoomTransmission);
    if (this.warmedExploration !== this.exploration.active || this.shadersPending) {
      this.warmedExploration = this.exploration.active;
      this.shadersPending = false;
      this.prepareRoomShaders();
    }

    const hidden = this.distantStudyProps;
    this.room?.setDistant(distantStudy);
    if (distantStudy && world) {
      if (this.life.group.visible) { hidden.push(this.life.group); this.life.group.visible = false; }
      if (this.pet && this.pet.root.visible) { hidden.push(this.pet.root); this.pet.root.visible = false; }
      const phys = this.manip.physics;
      for (const item of this.placed.values()) {
        if (item.group.visible && world.inStudy(item.group.position) && !phys?.isHeld(item.obj.id)) {
          hidden.push(item.group); item.group.visible = false;
        }
      }
    }
    // All-tier indoor exterior people culling: hide exterior crowd InstancedMeshes and distant NPCs > 18 m
    // outside the current building rect while keeping nearby doorway/window pedestrians visible (restored in `finally`).
    if (this.exploration.active && world?.insideBuildingRect) {
      const peopleRoot = this.game.peopleGroup;
      const r = world.insideBuildingRect;
      if (peopleRoot && peopleRoot.visible) {
        for (let i = 0; i < peopleRoot.children.length; i++) {
          const c = peopleRoot.children[i];
          if (!c.visible) continue;
          if ((c as T.InstancedMesh).isInstancedMesh) {
            hidden.push(c);
            c.visible = false;
            continue;
          }
          const px = c.position.x;
          const pz = c.position.z;
          if ((px !== 0 || pz !== 0) && (px < r.x0 - 18 || px > r.x1 + 18 || pz < r.z0 - 18 || pz > r.z1 + 18)) {
            hidden.push(c);
            c.visible = false;
          }
        }
      }
    }
    try {
      if (!distantStudy) this.room?.prepareVfx(this.renderer, this.scene, this.activeCamera, simDt, glassTier, this.reduced);
      const waterFluidActive = this.water.running;
      const shadowsReady = !this.renderer.shadowMap.enabled || this.echoCsm.hasAllActiveShadowMaps();
      // Only render river planar reflection once ALL active shadow maps are allocated (zero GL_INVALID_OPERATION!).
      if (
        world &&
        this.exploration.active &&
        !this.insideCityLighting &&
        shadowsReady
      ) {
        const restoreFirstPersonHead =
          this.studioMode === 'none' &&
          this.exploration.isFirstPersonCameraActive &&
          Boolean(this.character?.ready);
        if (restoreFirstPersonHead) {
          this.character?.setOwnView(false);
          this.exploration.clearOwnLimbGuard();
        }
        try {
          world.water?.prepareReflection(this.renderer, this.scene, this.activeCamera);
        } finally {
          if (restoreFirstPersonHead) {
            this.exploration.restoreOwnLimbGuard();
            if (this.exploration.cameraRig.ownLimbUniforms.uOwnLimbGuardActive.value > 0.5) {
              this.character?.setOwnView(true);
            }
          }
        }
      }
      // P0-PERF-2: Render due CSM secondary cascades (C1 excludes NPCs, C2 excludes NPCs + veg/grass/parked cars)
      // BEFORE `postFx.render()` so the main pass renders ONLY Cascade 0!
      if (this.echoCsm.active && this.renderer.shadowMap.enabled && !this.insideCityLighting && this.studioMode !== 'creator') {
        this.csmNpcScratch[0] = this.character?.root ?? null;
        this.csmNpcScratch[1] = this.game.peopleGroup;
        this.echoCsm.renderSecondaryCascades(this.renderer, this.scene, this.activeCamera, {
          npcs: this.csmNpcScratch,
        });
      }
      // Render active geometric planar mirror (at most 1 visible front-facing mirror per frame) BEFORE PostFX!
      getEchoLifePlanarMirrors().prepareReflection({
        renderer: this.renderer,
        scene: this.scene,
        camera: this.activeCamera,
        qualityTier: this.qualityTier,
        canRenderReflection: shadowsReady,
        explorationActive: this.exploration.active && this.studioMode !== 'creator',
        driving: Boolean(this.game?.activeDrivenVehicle),
        character: this.character,
        clearOwnLimbGuard: () => this.exploration.clearOwnLimbGuard(),
        restoreOwnLimbGuard: () => this.exploration.restoreOwnLimbGuard(),
      });
      // Only refresh ScopedNormalPass excludes if PostFX fell back to legacy SSAO (retired under depth-only N8AO!).
      const needsNormalPass = this.postFx.diagnostics.ssaoActive && this.exploration.active;
      if (needsNormalPass) {
        this.refreshNormalPassExcludes(world);
      }
      this.postFx.render(dt, {
        isOverviewAlpha: !this.exploration.active && this.studioMode === 'none',
        waterFluidActive,
        scene: this.scene,
        camera: this.activeCamera,
        normalPassExclude: needsNormalPass ? this.normalPassExcludes : undefined,
      });
      if (waterFluidActive) this.water.render(this.renderer, this.activeCamera);
    } finally {
      for (const group of hidden) group.visible = true;
      hidden.length = 0;
    }

    // Nothing moves behind a desktop that covers the room: no frames are spent on it.
    if (this.deviceHold) this.stop();
    if (this.qa && ++this.qaFrames % 5 === 0) {
      const objects = Array.from(this.placed.values()).map(p => {
        const point = p.group.position.clone().add(new T.Vector3(0, 0.5, 0));
        this.stage.localToWorld(point);
        point.project(this.activeCamera);
        return {
          id: p.obj.id,
          kind: p.obj.kind,
          x: (point.x + 1) * this.canvas.clientWidth / 2,
          y: (1 - point.y) * this.canvas.clientHeight / 2,
          asset: p.group.userData.asset ?? 'procedural',
        };
      });
      const perf = this.getPerfStats();
      const qaPayload = {
        game: this.game?.game ? {
          focus: this.game.focus ? (this.game.focus.kind === 'npc' ? 'npc:' + this.game.focus.id : this.game.focus.kind === 'spot' ? 'spot:' + this.game.focus.hotspot.key : 'bike') : null,
          riding: this.game.game.riding,
          bike: this.game.game.bike,
          walkers: [...this.game.game.people.walkers.values()].map(w => ({ id: w.id, x: +w.x.toFixed(2), z: +w.z.toFixed(2), zone: w.zone, moving: w.moving, act: w.activity })),
          people: this.game.game.people.stats,
          nav: this.game.game.nav.stats,
          clock: this.game.game.s.clock,
          done: this.game.game.s.done,
          tutorial: this.game.game.s.worldV3.tutorial.stepIndex,
          credits: this.game.game.s.progression.economy.credits,
        } : null,
        life: this.echoLife ? {
          ready: this.echoLife.ready,
          region: this.echoLife.stats.region,
          zone: this.echoLife.stats.zone,
          district: this.echoLife.stats.district,
          zonesTotal: this.echoLife.stats.zonesTotal,
          insideBuildingId: this.echoLife.insideBuildingId,
          streaming: this.echoLife.stats.streaming,
          built: this.echoLife.stats.built,
          populated: this.echoLife.stats.populated,
          open: [...this.echoLife.openDoors()],
          doors: Object.fromEntries(this.echoLife.doors().map(d => [d.id, +d.angle.toFixed(3)])),
          doorStates: this.echoLife.doorStates(),
          far: this.exploration.camera.far,
          window: this.cachedWindowView?.visible ?? null,
        } : null,
        mirrors: getEchoLifePlanarMirrors().getDiagnostics(),
        doorStates: this.doorStates(),
        hands: this.character?.rig?.state,
        interaction: this.manip.diagnostics,
        actions: this.manip.state,
        wardrobe: this.character?.wardrobe?.state,
        quality: this.quality,
        tier: this.qualityTier,
        gpu: {
          renderer: this.gpuReport.webglRenderer,
          gpuClass: this.gpuReport.gpuClass,
          recommendedTier: this.gpuReport.recommendedTier,
          webgpuAvailable: this.gpuReport.webgpuAvailable,
          maxAnisotropy: this.maxAnisotropy,
        },
        postFx: this.postFx.diagnostics,
        vegetation: this.echoLife?.stats.vegetation ?? null,
        grass: this.echoLife?.stats.grass ?? null,
        vfxTier: tier,
        audio: { ...audio },
        space: this.spaceIdentity,
        character: this.character?.diagnostics(),
        exploration: this.exploration.state(),
        camera: this.activeCamera.position.toArray(),
        yaw: this.exploration.yaw,
        pitch: this.exploration.pitch,
        dt,
        fps: perf.fps,
        frameMs: perf.frameMs,
        objects,
        calls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        geometries: this.renderer.info.memory.geometries,
        textures: this.renderer.info.memory.textures,
      };
      (window as unknown as { __studyQa?: unknown }).__studyQa = qaPayload;
      if (nowMs - this.lastQaDomSerializeMs >= 250) {
        this.lastQaDomSerializeMs = nowMs;
        this.canvas.dataset.studyQa = JSON.stringify(qaPayload);
      }
    }

    // Conservative adaptive quality downstep: never during initial 10 s warmup, explicit user tier, or single chunk spikes;
    // requires >= 6 s sustained severe slowdown (< 24 FPS) and always notifies the player.
    if (this.elapsedRunSec >= 10 && !this.qualityExplicit && !document.hidden && this.qualityTier !== 'low' && rawDt < 0.25) {
      if (dt > 0.042) this.sustainedSlowSec += dt;
      else this.sustainedSlowSec = Math.max(0, this.sustainedSlowSec - dt * 1.5);
      if (this.sustainedSlowSec >= 6.0) {
        const from = this.qualityTier;
        const to = stepDownQualityTier(from);
        this.sustainedSlowSec = 0;
        if (to !== from) {
          this.applyQualityTier(to);
          this.cb.onQuality(this.quality);
          try {
            window.dispatchEvent(new CustomEvent('echo-life:quality-downgrade', { detail: { from, to, tier: to } }));
          } catch { /* headless */ }
        }
      }
    }
  }

  /** One skeleton, whatever the camera: the same layers run for the owner's eyes, for the camera behind them, and for the overview. */
  private updateBody(dt: number) {
    const ch = this.character, rig = ch?.rig;
    if (!ch?.ready || !rig) return;
    const ex = this.exploration;
    const inStudio = this.studioMode !== 'none';
    if (!ex.active || inStudio) {
      ex.clearOwnLimbGuard();
    }
    const own = !inStudio && ex.isFirstPersonCameraActive;
    const crouch = inStudio ? 0 : ex.crouchAmount;
    const freeFeet = inStudio || ch.isStudioPoseActive || ch.isNonSteppingEmoteActive;

    ch.eyePoint(this.eyeWorld, crouch);
    // Bending for a reach the eyes go down with the head: a free hand held ready in front of the eyes stays in front
    // of them, instead of reaching up to where a standing head would have been.
    if (!ch.body.seat && !inStudio) {
      const s = reachEyeShift(rig.bendNow, ch.lean);
      this.eyeWorld.y -= s.down;
      this.eyeWorld.addScaledVector(ch.bodyForward(tmpV), s.forward);
    }
    this.stage.localToWorld(this.eyeWorld);
    let lookYaw = 0, lookPitch = 0;
    if (!inStudio && ex.active) {
      const raw = Math.atan2(Math.sin(ex.lookYaw - ch.root.rotation.y - Math.PI), Math.cos(ex.lookYaw - ch.root.rotation.y - Math.PI));
      lookPitch = ex.lookPitch;
      // Behind the character the head does not try to look back through its own shoulder.
      lookYaw = own || ch.body.seat ? raw : T.MathUtils.clamp(raw, -1.05, 1.05) * (1 - T.MathUtils.smoothstep(Math.abs(raw), 1.6, 2.3));
      if (!own) lookPitch *= .7;
      lookYaw *= 1 - ch.recliningWeight; lookPitch *= 1 - ch.recliningWeight;
    }
    // Single-authority dialogue gaze folded directly into HumanRig (never double-rotated post-update).
    if (!inStudio) {
      const dlg = ch.dialogueLookAngles(this.dialogueLookScratch);
      if (dlg) {
        lookYaw = dlg.yaw;
        lookPitch = dlg.pitch;
      }
    }

    // Single-pass vehicle rider IK: when seated on a car, bike, or motorbike, drive root + spine + hands + feet
    // strictly through `HumanRig.update(BodyFrame)` with zero post-update bone overwrites!
    const rider = this.echoLife?.ready
      ? this.game.getActivePlayerRiderBinding(rig, ch.hipRestHeight)
      : null;
    if (rider) {
      this.wasPlayerRiding = true;
      this.lastLook.yaw = ex.lookYaw;
      this.lastLook.pitch = ex.lookPitch;
      ch.root.position.copy(rider.rootPosition);
      ch.root.quaternion.copy(rider.rootQuaternion);
      ch.root.updateMatrixWorld(true);
      rig.update({
        dt,
        crouch: 0,
        reduced: this.reduced,
        own,
        eye: this.eyeWorld,
        lookYaw: rider.headYawLook + lookYaw * 0.35,
        lookPitch: rider.headPitchComp + lookPitch * 0.5,
        moveYaw: ch.moveYaw,
        lean: rider.lean,
        rest: ch.restHands(),
        seated: rider.seated,
        riderSeated: rider.riderSeated,
        ready: null,
        twist: rider.twist,
        load: null,
        dynamics: null,
        legTargets: rider.bodyFrameLegTargets,
        resolveContacts: () => {},
      });
      return;
    }
    if (this.wasPlayerRiding) {
      // E5-03 belt-and-suspenders: clear any pitch/roll left on `ch.root.quaternion` and reset foot lock seeds on dismount!
      this.wasPlayerRiding = false;
      ch.root.rotation.x = 0;
      ch.root.rotation.z = 0;
      ch.root.updateMatrixWorld(true);
      rig.resetFootDynamics();
    }

    // Through one's own eyes the hands are there, low in the view, on a frame that goes with the eyes as far as arms do.
    let ready: BodyFrame['ready'] = null;
    // Not with a tool in the hand: the free arm hangs and swings, it does not hover at the edge of the work.
    if (own && !freeFeet && ch.standing && !ch.body.seat && !ch.body.occupied && !this.manip.work.active) {
      const p = T.MathUtils.clamp(ex.lookPitch, -0.95, 0.5);
      tmpReadyFlat.set(-Math.sin(ex.lookYaw), 0, -Math.cos(ex.lookYaw));
      tmpReadyFwd.copy(tmpReadyFlat).multiplyScalar(Math.cos(p)).setY(Math.sin(p));
      tmpReadyUp.set(0, Math.cos(p), 0).addScaledVector(tmpReadyFlat, -Math.sin(p));
      tmpReadyRight.set(-tmpReadyFlat.z, 0, tmpReadyFlat.x);
      const turn = Math.atan2(Math.sin(ex.lookYaw - this.lastLook.yaw), Math.cos(ex.lookYaw - this.lastLook.yaw)) / Math.max(dt, 0.001);
      const nod = (ex.lookPitch - this.lastLook.pitch) / Math.max(dt, 0.001);
      ready = { forward: tmpReadyFwd, up: tmpReadyUp, right: tmpReadyRight, speed: ex.speed, stride: ch.stridePhase() ?? 0, turn, nod };
    }
    this.lastLook.yaw = ex.lookYaw;
    this.lastLook.pitch = ex.lookPitch;
    const nav = this.navigation, feel = this.manip;
    const verticalGaitWeight =
      !inStudio && this.echoLife && ex.active && ch.stepping ? T.MathUtils.smoothstep(ex.speed, 1.35, 2.05) : 0;
    const surfaceAt: BodyFrame['surfaceAt'] = (probe, outNormal) => {
      const local = this.stage.worldToLocal(tmpFootProbe.copy(probe));
      const y = ex.sampleFootSupport(local.x, local.z, outNormal, ch.root.position.y);
      return Number.isFinite(y) ? this.stage.localToWorld(tmpFootOut.set(local.x, y, local.z)).y : null;
    };
    const dynamics: BodyFrame['dynamics'] = ch.onFeet && (ex.active || feel.carrying || ch.motionActive) ? {
      stepping: ch.stepping, mass: ch.bodyKg, loads: feel.bodyLoads(), handForce: feel.handForce(), stance: feel.bodyStance(), strain: feel.bodyStrain(),
      motionContacts: ch.motionContacts, motionWeight: ch.motionWeight, floorPosture: ch.floorPostureActive,
      gait: !ch.motionActive,
      verticalGait: verticalGaitWeight > 0.5,
      verticalGaitWeight,
      surfaceAt,
      groundAt: at => {
        const local = this.stage.worldToLocal(tmpFootProbe.copy(at));
        const world = this.echoLife;
        if (world?.ready && !world.inStudy(local)) {
          const y = world.walk.groundAt(local.x, local.z);
          if (y !== null) {
            // Sample from above the tread. The continuous walk surface carries the root between risers.
            local.y = y + .25;
            const support = feel.physics?.surfaceBelow(local, .5);
            return this.stage.localToWorld(support ? tmpFootOut.copy(support) : tmpFootOut.copy(local).setY(y)).y;
          }
        }
        local.y += .1;
        const hit = feel.physics?.surfaceBelow(local, .45);
        return hit ? this.stage.localToWorld(tmpFootOut.copy(hit)).y : null;
      },
      motionFloorY: ch.motionActive ? this.stage.localToWorld(tmpMotionFloor.set(0, 0, 0)).y : undefined,
      roomAt: (x, z) => { const at = this.stage.worldToLocal(tmpV.set(x, 0, z)); return this.echoLife?.ready && !this.echoLife.inStudy(at) ? this.echoLife.walk.free(at) : !nav || nav.free(at); },
      land: (_, hard) => {
        if (!ex.active || inStudio) return;
        if (this.echoLife?.ready) {
          const region = this.echoLife.stats.region;
          const zone = this.echoLife.stats.zone;
          const indoor = !region || !OUTDOOR_LIGHTING_REGIONS.has(region);
          const wet = indoor ? 0 : Math.max(this.echoLife.weatherUniforms?.uWetness.value ?? 0, this.game.sky()?.rain ?? 0);
          const snow = indoor ? 0 : Math.max(this.echoLife.weatherUniforms?.uSnowCover.value ?? 0, this.game.sky()?.snow ?? 0);
          const surface = classifyFootSurface(region, zone, false, this.layout?.room.floorStyle, snow);
          const pos = ch.root.position;
          this.game.worldAudio.triggerFootstep(surface, Math.min(1.2, hard * 0.65), wet, true, snow, { x: pos.x, y: pos.y, z: pos.z });
        } else {
          footstep('wood', hard * .55);
        }
      },
    } : null;
    rig.update({
      ...(inStudio || ch.isStudioPoseActive ? STUDIO_FINGER_ON : STUDIO_FINGER_OFF),
      dt,
      crouch,
      reduced: this.reduced,
      own,
      freeFeet,
      eye: this.eyeWorld,
      lookYaw,
      lookPitch,
      moveYaw: inStudio ? 0 : ch.moveYaw,
      lean: inStudio ? 0 : ch.lean,
      leanRoll: inStudio ? 0 : ex.leanRoll,
      leanPitch: inStudio ? 0 : ex.leanPitch,
      rest: ch.restHands(),
      seated: !!ch.body.seat,
      ready,
      twist: this.manip.toolTwist,
      load: this.manip.bodyLoad,
      dynamics,
      surfaceAt,
      pelvisSpringHz: 20,
      verticalGaitWeight,
      legTargets: ch.seatedLegTargets(),
      resolveRoot: () => {
        // Balance owns this request; Character/navigation still admit the move.
        // Commit before torso planning and arm IK, and mirror root delta into FixedStepLocomotionAccumulator!
        if (rig.taken.lengthSq() <= 1e-10) return;
        const target = this.stage.worldToLocal(ch.root.getWorldPosition(tmpResolveRoot).add(rig.taken));
        target.y = ch.root.position.y;
        tmpRootPrev.copy(ch.root.position);
        if (this.echoLife?.ready && !this.echoLife.inStudy(target) ? this.echoLife.walk.free(target) : !nav || nav.free(target)) {
          ch.moveRoot(target);
          const dx = ch.root.position.x - tmpRootPrev.x;
          const dy = ch.root.position.y - tmpRootPrev.y;
          const dz = ch.root.position.z - tmpRootPrev.z;
          if (dx * dx + dy * dy + dz * dz > 1e-10) {
            ex.locomotionAcc.applyExternalRootDelta(dx, dy, dz);
          }
        }
        rig.taken.set(0, 0, 0);
        ch.eyePoint(this.eyeWorld, crouch);
        this.stage.localToWorld(this.eyeWorld);
      },
      resolveContacts: () => this.manip.resolveContacts(),
    });
  }
  /**
   * Cooperative async prewarm for newly streamed chunks, buildings, and interior GLB props (`P5-Perf #1`):
   * 1. Synchronously patches Echo CSM onto all PBR materials right away (idempotent),
   * 2. Cooperatively uploads textures via `TextureUploadQueue` (`<= 4 ms/frame`, hidden-tab safe),
   * 3. Runs serialized RT-matched `safeCompileAsync(renderer, obj, activeCamera, scene)` against
   *    `postFx.getWarmupRenderTarget()` (when PostFX active) and `null` backbuffer BEFORE the caller
   *    reveals the object, eliminating cold-frame texture/shader stutters on building approach!
   */
  private inBootAssetPreload = false;

  private prewarmStreamedObject(obj: T.Object3D, priority: StreamPrewarmPriority = 'background'): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.echoCsm.patchObject(obj);
    if (this.inBootAssetPreload || this.outdoorWarmupInFlight || this.preEntryWarmupPromise) {
      return Promise.resolve();
    }
    const isImminent = priority === 'imminent';

    const run = async (): Promise<void> => {
      if (this.disposed) return;
      const renderer = this.renderer;
      const gl = renderer.getContext();
      if (!gl || gl.isContextLost()) return;

      // Never deadlock with canonical Stage-6 pre-entry warmup (which already compiles all scene/game roots).
      if (this.inBootAssetPreload || this.outdoorWarmupInFlight || this.preEntryWarmupPromise) {
        return;
      }
      if (!isImminent) {
        await this.imminentPrewarmChain.catch(() => undefined);
        if (this.disposed) return;
      }

      const uploadQueue = getEchoLifeTextureUploadQueue();
      const queued = uploadQueue.enqueueFromObject(
        obj,
        isImminent ? LoadPriority.P0_IMMINENT : LoadPriority.P1_PREFETCH,
      );
      if (queued > 0) {
        await uploadQueue.flushAll(renderer, new EchoLifeTimeSlicer(isImminent ? 6 : 4), {
          maxPerFrame: isImminent ? 8 : 4,
        });
        if (this.disposed) return;
      }
      if (!isImminent) {
        await this.imminentPrewarmChain.catch(() => undefined);
        if (this.disposed) return;
      }

      try {
        const postFxRt = this.postFx.getWarmupRenderTarget();
        if (postFxRt) {
          // `safeCompileAsync()` executes `renderer.compile()` synchronously before its first `await`;
          // restore `renderTarget` & `toneMapping` immediately before awaiting so live rAF frames NEVER
          // observe mutated renderer state while shaders link asynchronously!
          const prevTarget = renderer.getRenderTarget();
          const prevTone = renderer.toneMapping;
          let p: ReturnType<typeof safeCompileAsync>;
          try {
            renderer.setRenderTarget(postFxRt);
            renderer.toneMapping = T.NoToneMapping;
            p = safeCompileAsync(renderer, obj, this.activeCamera, this.scene, {
              aborted: () => this.disposed,
              timeoutMs: 4000,
            });
          } finally {
            renderer.setRenderTarget(prevTarget);
            renderer.toneMapping = prevTone;
          }
          await p;
        }
        if (this.disposed) return;
        const prevTarget = renderer.getRenderTarget();
        const prevTone = renderer.toneMapping;
        let pBack: ReturnType<typeof safeCompileAsync>;
        try {
          renderer.setRenderTarget(null);
          renderer.toneMapping = T.AgXToneMapping;
          pBack = safeCompileAsync(renderer, obj, this.activeCamera, this.scene, {
            aborted: () => this.disposed,
            timeoutMs: 4000,
          });
        } finally {
          renderer.setRenderTarget(prevTarget);
          renderer.toneMapping = prevTone;
        }
        await pBack;
      } catch {
        // Non-fatal: context loss is handled by canvas lifecycle.
      }
    };

    if (isImminent) {
      const next = this.imminentPrewarmChain.then(run, run);
      this.imminentPrewarmChain = next.catch(() => undefined);
      return next;
    }
    const next = this.prewarmChain.then(run, run);
    this.prewarmChain = next.catch(() => undefined);
    return next;
  }

  /**
   * Staged outdoor pipeline warmup: compiles Echo Life subgroups once per quality/CSM configuration
   * via RT-matched `safeCompileAsync()` (never blocking main thread, hidden-tab safe, and skipped
   * whenever canonical `runPreEntryWarmup()` is active).
   */
  private async stageOutdoorWarmup(world: EchoLifeWorld): Promise<void> {
    if (this.disposed || this.echoLife !== world || !world.ready || this.preEntryWarmupPromise) return;
    const renderer = this.renderer;
    const key = `${this.qualityTier}|${this.echoCsm.config.cascades}|${world.ready ? 1 : 0}|${this.character?.ready ? 1 : 0}`;
    if (key === this.lastWarmedOutdoorKey) return;
    const epoch = ++this.outdoorWarmupEpoch;
    this.outdoorWarmupInFlight = true;
    this.lastWarmedOutdoorKey = key;
    this.shadersPending = false;

    const yieldSlicer = new EchoLifeTimeSlicer(8);
    try {
      this.echoCsm.patchObject(world.group);
      if (this.character?.root) this.echoCsm.patchObject(this.character.root);
      if (this.game.peopleGroup) this.echoCsm.patchObject(this.game.peopleGroup);

      const groups: T.Object3D[] = [];
      for (const ch of world.group.children) {
        if (ch && ch.children.length > 0) groups.push(ch);
      }
      if (this.character?.root) groups.push(this.character.root);
      if (this.game.peopleGroup && this.game.peopleGroup.children.length > 0) groups.push(this.game.peopleGroup);

      const postFxRt = this.postFx.getWarmupRenderTarget();
      for (let i = 0; i < groups.length; i++) {
        if (this.disposed || this.outdoorWarmupEpoch !== epoch || this.echoLife !== world || this.preEntryWarmupPromise) return;
        const target = groups[i];
        try {
          if (postFxRt) {
            const prevTarget = renderer.getRenderTarget();
            const prevTone = renderer.toneMapping;
            let p: ReturnType<typeof safeCompileAsync>;
            try {
              renderer.setRenderTarget(postFxRt);
              renderer.toneMapping = T.NoToneMapping;
              p = safeCompileAsync(renderer, target, this.activeCamera, this.scene, {
                aborted: () => this.disposed || this.outdoorWarmupEpoch !== epoch || this.echoLife !== world,
                timeoutMs: 6000,
              });
            } finally {
              renderer.setRenderTarget(prevTarget);
              renderer.toneMapping = prevTone;
            }
            await p;
          }
          if (this.disposed || this.outdoorWarmupEpoch !== epoch || this.echoLife !== world || this.preEntryWarmupPromise) return;
          const prevTarget = renderer.getRenderTarget();
          const prevTone = renderer.toneMapping;
          let pBack: ReturnType<typeof safeCompileAsync>;
          try {
            renderer.setRenderTarget(null);
            renderer.toneMapping = T.AgXToneMapping;
            pBack = safeCompileAsync(renderer, target, this.activeCamera, this.scene, {
              aborted: () => this.disposed || this.outdoorWarmupEpoch !== epoch || this.echoLife !== world,
              timeoutMs: 6000,
            });
          } finally {
            renderer.setRenderTarget(prevTarget);
            renderer.toneMapping = prevTone;
          }
          await pBack;
        } catch {
          return;
        }
        if (i + 1 < groups.length) {
          await yieldSlicer.yieldFrame();
        }
      }
      if (!this.disposed && this.outdoorWarmupEpoch === epoch && this.echoLife === world) {
        this._warmupReady = true;
        if (this.baselinePrograms === 0) {
          this.baselinePrograms = this.renderer.info.programs?.length ?? 0;
        }
        this.installProfileHandle();
      }
    } finally {
      if (this.outdoorWarmupEpoch === epoch) this.outdoorWarmupInFlight = false;
    }
  }

  /** True once `runPreEntryWarmup()` / `warmupOutdoorPipeline()` or staged outdoor shader compilation has completed cleanly. */
  get warmupReady(): boolean {
    return this._warmupReady;
  }

  private installProfileHandle(): void {
    if (typeof window === 'undefined' || this.disposed) return;
    const engine = this;
    const handle: EchoLifeProfileHandle = {
      get baselinePrograms() {
        return engine.baselinePrograms;
      },
      get currentPrograms() {
        return engine.renderer.info.programs?.length ?? 0;
      },
      get programDelta() {
        const cur = engine.renderer.info.programs?.length ?? 0;
        return Math.max(0, cur - engine.baselinePrograms);
      },
      get warmupMs() {
        return engine.lastWarmupMs;
      },
      get tier() {
        return engine.qualityTier;
      },
      get gpuClass() {
        return engine.gpuReport.gpuClass;
      },
      get shadowMapsReady() {
        return !engine.renderer.shadowMap.enabled || engine.echoCsm.hasAllActiveShadowMaps();
      },
      get vramBreakdown() {
        const mb = (b: number) => +(b / (1024 * 1024)).toFixed(2);
        return {
          renderTargetsMB: mb(engine.fixedBreakdownCache.renderTargetsBytes),
          shadowMapsMB: mb(engine.fixedBreakdownCache.shadowMapsBytes),
          pmremMB: mb(engine.fixedBreakdownCache.pmremBytes),
          geometryMB: mb(engine.fixedBreakdownCache.geometryBytes),
          assetsMB: +lifeAssetTextureMB().toFixed(2),
          pbrAtlasMB: +pbrAtlasStats().estimatedVramMB.toFixed(2),
          residency: getEchoLifeResidencyManager().stats(),
        };
      },
    };
    (window as Window & { __EC_ECHO_LIFE_PROFILE__?: EchoLifeProfileHandle }).__EC_ECHO_LIFE_PROFILE__ = handle;
  }

  /**
   * Executes one `1x1`-scissored draw pass (honoring Three.js r186 `rt.scissor` for render targets and
   * `renderer.setScissor` for the default backbuffer) so ANGLE/D3D11 allocates shadow maps or completes
   * synchronous PSO draw-linking with `< 1 ms` pixel fill cost and zero visual bleed.
   */
  private renderScissored1x1(
    targetRt: T.WebGLRenderTarget | null,
    toneMapping: T.ToneMapping,
    runShadows: boolean,
  ): void {
    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevTone = renderer.toneMapping;
    const prevAutoClear = renderer.autoClear;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevShadowNeeds = renderer.shadowMap.needsUpdate;
    const prevScissorTest = renderer.getScissorTest();
    const prevScissor = new T.Vector4();
    const prevViewport = new T.Vector4();
    renderer.getScissor(prevScissor);
    renderer.getViewport(prevViewport);
    const savedRtScissor = targetRt ? targetRt.scissor.clone() : null;
    const savedRtScissorTest = targetRt ? targetRt.scissorTest : false;

    try {
      renderer.toneMapping = toneMapping;
      renderer.autoClear = true;
      renderer.shadowMap.autoUpdate = runShadows;
      renderer.shadowMap.needsUpdate = runShadows;
      if (targetRt) {
        targetRt.scissor.set(0, 0, 1, 1);
        targetRt.scissorTest = true;
        renderer.setRenderTarget(targetRt);
      } else {
        renderer.setRenderTarget(null);
        renderer.setScissor(0, 0, 1, 1);
        renderer.setScissorTest(true);
      }
      renderer.render(this.scene, this.activeCamera);
    } catch {
      // Context loss is handled by canvas lifecycle.
    } finally {
      if (targetRt && savedRtScissor) {
        targetRt.scissor.copy(savedRtScissor);
        targetRt.scissorTest = savedRtScissorTest;
      }
      renderer.setScissorTest(false);
      renderer.setRenderTarget(targetRt);
      renderer.clear(true, true, true);
      if (targetRt) {
        renderer.setRenderTarget(null);
        renderer.clear(true, true, true);
      }
      renderer.setRenderTarget(prevTarget);
      renderer.toneMapping = prevTone;
      renderer.autoClear = prevAutoClear;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      renderer.shadowMap.needsUpdate = prevShadowNeeds;
      renderer.setViewport(prevViewport);
      renderer.setScissor(prevScissor);
      renderer.setScissorTest(prevScissorTest);
    }
  }

  /**
   * Canonical Stage-6 pre-entry warmup barrier guaranteeing `programDelta === 0` across ALL zones
   * (Overview, Study Room, Residence, Outdoors, 13 City Buildings, CAZ/Build/Photo Studios) from Frame 1:
   * 1. Builds Echo Life world if needed (`prepareLife()`),
   * 2. Awaits core PBR + character PBR textures & drains `TextureUploadQueue` time-sliced (`<= 8 ms/frame`),
   * 3. Patches CSM onto all scene roots & forces all active cascade shadow maps to allocate even in Study Room,
   * 4. Temporarily reveals non-Light hidden/culled/zero-count meshes & runs RT-matched `safeCompileAsync()`
   *    against PostFX/linear HDR RT + sRGB backbuffer (with `1x1` draw-link fallback if `needsDrawLink`),
   * 5. Runs `1x1`-scissored `postFx.warmupPasses()`, `water.warmupReflection()`, and `atmosphere.prewarmHdrisNow()`,
   * 6. Locks `baselinePrograms` & exposes live `window.__EC_ECHO_LIFE_PROFILE__`.
   */
  async runPreEntryWarmup(opts?: {
    onStage?: (stageId: EchoLifeBootStageId, pct: number) => void;
    signal?: AbortSignal;
    ensureWorld?: boolean;
  }): Promise<{ baselinePrograms: number; warmupMs: number }> {
    if (this.disposed) {
      return { baselinePrograms: this.baselinePrograms, warmupMs: this.lastWarmupMs };
    }
    const wantWorld = opts?.ensureWorld !== false && Boolean(this.echoLife);
    const needsWorldBuild = wantWorld && !this.echoLife?.ready;
    const keyNow = `${this.qualityTier}|${this.echoCsm.config.cascades}|${this.echoLife?.ready ? 1 : 0}|${this.character?.ready ? 1 : 0}`;
    if (!needsWorldBuild && this._warmupReady && this.lastWarmedOutdoorKey === keyNow && this.baselinePrograms > 0) {
      opts?.onStage?.('ready', 100);
      this.installProfileHandle();
      return { baselinePrograms: this.baselinePrograms, warmupMs: this.lastWarmupMs };
    }
    if (this.preEntryWarmupPromise) {
      return this.preEntryWarmupPromise;
    }

    const emit = (stageId: EchoLifeBootStageId, pct: number) => {
      if (!this.disposed && !opts?.signal?.aborted) {
        opts?.onStage?.(stageId, pct);
      }
    };
    const aborted = () => this.disposed || Boolean(opts?.signal?.aborted);
    const t0 = performance.now();

    const task = (async (): Promise<{ baselinePrograms: number; warmupMs: number }> => {
      const renderer = this.renderer;
      const resMgr = getEchoLifeResidencyManager();
      resMgr.setBootActive(true);
      this.outdoorWarmupEpoch++;
      this.outdoorWarmupInFlight = true;

      try {
        emit('preparing', 10);
        if (opts?.ensureWorld !== false && this.echoLife && !this.echoLife.ready) {
          await this.prepareLife();
        }
        if (aborted()) return { baselinePrograms: this.baselinePrograms, warmupMs: 0 };

        emit('assets', 28);
        const cfg = getRenderConfig(this.qualityTier, this.maxAnisotropy, this.gpuReport.gpuClass);
        this.inBootAssetPreload = true;
        try {
          await Promise.all([
            awaitCorePbrReady({
              colorOnly: this.qualityTier === 'low',
              maxAnisotropy: cfg.anisotropy,
              timeoutMs: 6000,
            }).catch(() => undefined),
            preloadCharacterPbrTextures(renderer).catch(() => undefined),
            this.game.prewarmForGameplay(this.echoLife, this.activeCamera).catch(() => undefined),
          ]);
        } finally {
          this.inBootAssetPreload = false;
        }
        if (aborted()) return { baselinePrograms: this.baselinePrograms, warmupMs: 0 };

        const manipWarmupRoots = this.manip.ensureWarmupRoots();
        const gameWarmupRoots = this.game.getWarmupRoots();
        for (const p of this.placed.values()) {
          prewarmToolBendMaterial(null, null, p.group);
        }

        // Drain GPU texture uploads cooperatively (`<= 8 ms/frame`) behind the pre-entry overlay.
        const uploadQueue = new TextureUploadQueue();
        for (const tex of getLoadedPbrBaseTextures()) {
          uploadQueue.enqueue(tex, LoadPriority.P0_IMMINENT);
        }
        if (this.room?.group) uploadQueue.enqueueFromObject(this.room.group, LoadPriority.P0_IMMINENT);
        if (this.character?.root) uploadQueue.enqueueFromObject(this.character.root, LoadPriority.P0_IMMINENT);
        if (this.echoLife?.group) uploadQueue.enqueueFromObject(this.echoLife.group, LoadPriority.P1_PREFETCH);
        if (this.game.peopleGroup) uploadQueue.enqueueFromObject(this.game.peopleGroup, LoadPriority.P1_PREFETCH);
        for (const gr of gameWarmupRoots) uploadQueue.enqueueFromObject(gr, LoadPriority.P0_IMMINENT);
        await uploadQueue.flushAll(renderer, new EchoLifeTimeSlicer(8), {
          maxPerFrame: 6,
          signal: opts?.signal,
        });
        if (aborted()) return { baselinePrograms: this.baselinePrograms, warmupMs: 0 };

        emit('graphics', 52);
        this.postFx.prewarmComposer();
        const world = this.echoLife;
        // Bake active & tier HDRI PMREMs BEFORE `safeCompileAsync` (hidden-tab safe via `EchoLifeTimeSlicer`)
        // so PMREM shaders compile inside Stage-6 and `scene.environment` matches live exploration IBL!
        if (world?.ready && world.atmosphere && !aborted()) {
          await world.atmosphere.prewarmHdrisNow(renderer);
          this.atmosphereWarmedFor = world;
          world.atmosphere.syncEnvironment(renderer, this.scene);
        }
        if (aborted()) return { baselinePrograms: this.baselinePrograms, warmupMs: 0 };

        if (this.room?.group) this.echoCsm.patchObject(this.room.group);
        for (const p of this.placed.values()) this.echoCsm.patchObject(p.group);
        if (world?.ready) {
          this.syncHomeMirrors(world);
        }
        if (world?.group) {
          this.csmPatchedObjects.add(world.group);
          this.echoCsm.patchObject(world.group);
        }
        if (this.character?.root) {
          this.csmPatchedObjects.add(this.character.root);
          this.echoCsm.patchObject(this.character.root);
        }
        if (this.game.peopleGroup) {
          this.csmPatchedObjects.add(this.game.peopleGroup);
          this.echoCsm.patchObject(this.game.peopleGroup);
        }
        for (const gr of gameWarmupRoots) {
          this.csmPatchedObjects.add(gr);
          this.echoCsm.patchObject(gr);
        }

        // Lock constant FogExp2 before compilation so USE_FOG stays invariant everywhere.
        const savedFogDensity = this.outdoorFog.density;
        const savedZoneMode = this.echoCsm.zoneMode;
        if (this.scene.fog !== this.outdoorFog) this.scene.fog = this.outdoorFog;

        // Temporarily un-hide non-Light renderables, disable frustum culling, and lift zero-count InstancedMeshes
        // so EVERY scene material & vertex layout compiles inside Stage-6 (never hiding/adding Lights!).
        const savedVisibility: { obj: T.Object3D; visible: boolean }[] = [];
        const savedFrustum: { obj: T.Object3D; frustumCulled: boolean }[] = [];
        const savedBatchedFrustum: { mesh: T.BatchedMesh; perObjectFrustumCulled: boolean }[] = [];
        const savedInstanceCounts: { mesh: T.InstancedMesh; count: number }[] = [];
        const tempRevealRoots: T.Object3D[] = [];
        if (this.room?.group) tempRevealRoots.push(this.room.group);
        if (world?.group) tempRevealRoots.push(world.group);
        if (this.character?.root) tempRevealRoots.push(this.character.root);
        if (this.game.peopleGroup) tempRevealRoots.push(this.game.peopleGroup);
        for (const gr of gameWarmupRoots) tempRevealRoots.push(gr);
        for (const mr of manipWarmupRoots) tempRevealRoots.push(mr);
        if (this.life?.group) tempRevealRoots.push(this.life.group);
        if (this.pet?.root) tempRevealRoots.push(this.pet.root);
        if (this.selectionBox) tempRevealRoots.push(this.selectionBox);
        for (const p of this.placed.values()) tempRevealRoots.push(p.group);
        const dummyVeh = createDummyVehicleWarmupGroup();
        this.echoCsm.patchObject(dummyVeh);
        this.scene.add(dummyVeh);
        tempRevealRoots.push(dummyVeh);

        for (let ri = 0; ri < tempRevealRoots.length; ri++) {
          tempRevealRoots[ri].traverse((node) => {
            if ((node as T.Light).isLight) return;
            if (!node.visible) {
              savedVisibility.push({ obj: node, visible: false });
              node.visible = true;
            }
            if ((node as T.Mesh).isMesh || (node as T.Points).isPoints || (node as T.Line).isLine || (node as T.Sprite).isSprite) {
              if (node.frustumCulled) {
                savedFrustum.push({ obj: node, frustumCulled: true });
                node.frustumCulled = false;
              }
              const bm = node as T.BatchedMesh;
              if (bm.isBatchedMesh && bm.perObjectFrustumCulled) {
                savedBatchedFrustum.push({ mesh: bm, perObjectFrustumCulled: true });
                bm.perObjectFrustumCulled = false;
              }
              const im = node as T.InstancedMesh;
              if (im.isInstancedMesh && im.count === 0 && im.instanceMatrix && im.instanceMatrix.count > 0) {
                savedInstanceCounts.push({ mesh: im, count: 0 });
                im.count = 1;
              }
            }
          });
        }

        const prevTarget = renderer.getRenderTarget();
        const prevTone = renderer.toneMapping;
        let dummyLinearRt: T.WebGLRenderTarget | null = null;

        try {
          const postFxRt = this.postFx.getWarmupRenderTarget();
          // Step 1: Allocate ALL active-tier CSM shadow maps & compile MeshDepthMaterial variants EVEN if starting in Study Room!
          if (cfg.shadow.enabled) {
            if (cfg.shadow.cascades > 0) {
              this.echoCsm.setZoneMode('outdoor');
            }
            const focusWorld = this.character?.ready
              ? this.stage.localToWorld(tmpV.copy(this.character.root.position))
              : tmpV.set(0, 0, 0);
            this.echoCsm.forceAllActiveCascadesDirty(focusWorld, world?.atmosphere?.snapshot.keyDir);
            this.renderScissored1x1(
              postFxRt,
              postFxRt ? T.NoToneMapping : T.AgXToneMapping,
              true,
            );
          }

          if (!aborted()) {
            // Step 2: RT-matched `safeCompileAsync` for Linear HDR RT (PostFX inputBuffer on High/Ultra,
            // or a 1x1 dummy HalfFloat LinearSRGB RT on Low/Balanced covering PortalCapture/reflection linear paths).
            let linearRt = postFxRt;
            if (!linearRt) {
              dummyLinearRt = new T.WebGLRenderTarget(1, 1, {
                type: T.HalfFloatType,
                colorSpace: T.LinearSRGBColorSpace,
                depthBuffer: true,
                stencilBuffer: false,
              });
              linearRt = dummyLinearRt;
            }
            renderer.setRenderTarget(linearRt);
            renderer.toneMapping = T.NoToneMapping;
            const linearRes = await safeCompileAsync(renderer, this.scene, this.activeCamera, this.scene, {
              signal: opts?.signal,
              aborted,
              timeoutMs: 8000,
            });
            if (linearRes.needsDrawLink && !aborted()) {
              this.renderScissored1x1(linearRt, T.NoToneMapping, false);
            }
          }

          if (!aborted()) {
            // Step 3: RT-matched `safeCompileAsync` for default backbuffer (`null`, sRGB + AgXToneMapping).
            renderer.setRenderTarget(null);
            renderer.toneMapping = T.AgXToneMapping;
            const backRes = await safeCompileAsync(renderer, this.scene, this.activeCamera, this.scene, {
              signal: opts?.signal,
              aborted,
              timeoutMs: 8000,
            });
            if (backRes.needsDrawLink && !aborted()) {
              this.renderScissored1x1(null, T.AgXToneMapping, false);
            }
          }
        } finally {
          for (let i = savedInstanceCounts.length - 1; i >= 0; i--) {
            savedInstanceCounts[i].mesh.count = savedInstanceCounts[i].count;
          }
          for (let i = savedBatchedFrustum.length - 1; i >= 0; i--) {
            savedBatchedFrustum[i].mesh.perObjectFrustumCulled = savedBatchedFrustum[i].perObjectFrustumCulled;
          }
          for (let i = savedFrustum.length - 1; i >= 0; i--) {
            savedFrustum[i].obj.frustumCulled = savedFrustum[i].frustumCulled;
          }
          for (let i = savedVisibility.length - 1; i >= 0; i--) {
            savedVisibility[i].obj.visible = savedVisibility[i].visible;
          }
          disposeDummyVehicleWarmupGroup(dummyVeh);
          dummyLinearRt?.dispose();
          this.echoCsm.setZoneMode(savedZoneMode);
          this.outdoorFog.density = savedFogDensity;
          if (this.scene.fog !== this.outdoorFog) this.scene.fog = this.outdoorFog;
          renderer.setRenderTarget(prevTarget);
          renderer.toneMapping = prevTone;
        }
        if (aborted()) return { baselinePrograms: this.baselinePrograms, warmupMs: 0 };

        emit('graphics', 80);
        // Step 4: Warm care tool bend, gizmo/preview, CpuFluid water view, grime films, PostFX passes,
        // geometric planar mirrors, walk-in shower VFX, and river planar reflection behind the curtain!
        const warmupCam = this.activeCamera;
        const warmupRt = this.postFx.getWarmupRenderTarget();
        prewarmToolBendMaterial(renderer, warmupCam);
        (this.manip as {
          warmupGizmoAndPreview?: (r: T.WebGLRenderer, s: T.Scene, c: T.Camera) => void;
        }).warmupGizmoAndPreview?.(renderer, this.scene, warmupCam);
        this.water.warmup(renderer, warmupCam);
        this.life.warmup(renderer, warmupCam, warmupRt, this.scene);
        this.postFx.warmupPasses();
        getEchoLifePlanarMirrors().warmup(renderer, this.scene, warmupCam, this.qualityTier);
        this.game?.warmupVfx?.(renderer, this.scene, warmupCam);
        if (world?.ready && !aborted()) {
          world.water?.warmupReflection(renderer, this.scene, warmupCam);
        }
        if (aborted()) return { baselinePrograms: this.baselinePrograms, warmupMs: 0 };

        emit('sync', 92);
        resMgr.setBootActive(false);
        this.updateResidencyFixedBreakdown();
        this.baselinePrograms = renderer.info.programs?.length ?? 0;
        this.lastWarmupMs = +(performance.now() - t0).toFixed(1);
        this.lastWarmedOutdoorKey = `${this.qualityTier}|${this.echoCsm.config.cascades}|${this.echoLife?.ready ? 1 : 0}|${this.character?.ready ? 1 : 0}`;
        this.shadersPending = false;
        this._warmupReady = true;
        this.installProfileHandle();
        emit('ready', 100);
        return { baselinePrograms: this.baselinePrograms, warmupMs: this.lastWarmupMs };
      } finally {
        resMgr.setBootActive(false);
        this.outdoorWarmupInFlight = false;
        this.preEntryWarmupPromise = null;
      }
    })();

    this.preEntryWarmupPromise = task;
    return task;
  }

  /** Backward-compatible outdoor warmup alias delegating to canonical `runPreEntryWarmup()`. */
  async warmupOutdoorPipeline(): Promise<void> {
    await this.runPreEntryWarmup({ ensureWorld: false });
  }

  /** Applies a full Character Creator V2 profile live to the player rig and syncs V2 look wire over Shared City. */
  async applyCreatorProfile(profile: CharacterCreatorProfile): Promise<void> {
    this.pendingCreatorProfile = profile;
    const wire = encodeLookV2(profile);
    this.sharedCity?.setLocalLook(wire);
    const sky = this.exploration.active ? this.game.sky() : null;
    const cur = this.character;
    if (!cur || !this.layout) return;

    if (cur.modelId !== profile.hero && this.layout.character.visible) {
      const swapSeq = ++this.creatorHeroSwapSeq;
      const savedPos = cur.root.position.clone();
      const savedRotY = cur.root.rotation.y;
      const baseCfg: Layout['character'] = { ...this.layout.character, model: profile.hero };
      const nextCh = this.createCharacterInstance(baseCfg);
      try {
        await nextCh.load();
      } catch {
        nextCh.dispose();
        return;
      }
      if (
        this.disposed ||
        swapSeq !== this.creatorHeroSwapSeq ||
        this.pendingCreatorProfile?.hero !== profile.hero
      ) {
        nextCh.dispose();
        return;
      }
      const prevChar = this.character;
      const livePos = prevChar?.ready ? prevChar.root.position.clone() : savedPos;
      const liveRotY = prevChar?.ready ? prevChar.root.rotation.y : savedRotY;
      nextCh.resetPose(livePos, liveRotY);
      const latestProfile = this.pendingCreatorProfile ?? profile;
      const latestSky = this.exploration.active ? this.game.sky() : null;
      await nextCh.applyCreatorProfile(
        latestProfile,
        latestSky ? { season: latestSky.season, snow: latestSky.snow ?? 0 } : undefined,
      );
      if (this.disposed || swapSeq !== this.creatorHeroSwapSeq) {
        nextCh.dispose();
        return;
      }
      this.csmPatchedObjects.add(nextCh.root);
      this.echoCsm.patchObject(nextCh.root);
      if (prevChar) {
        this.stage.remove(prevChar.root);
        prevChar.dispose();
      }
      this.character = nextCh;
      this.characterKey = `${Boolean(this.layout?.character.visible ?? true)}|${profile.hero}`;
      this.setCharacterNavigation();
      this.stage.add(nextCh.root);
      this.exploration.prepareCharacterMaterials(nextCh);

      if (this.studioMode !== 'none') {
        nextCh.setOwnView(false);
        this.exploration.clearOwnLimbGuard();
        if (this.studioMode === 'creator') {
          nextCh.clearTransientMotion({ contrapposto: true });
          const expr = this.studioCreatorOpts.expression;
          if (expr !== undefined) {
            nextCh.setExpressionOverride(expr ? (expr as Mood) : null);
          }
        } else if (this.studioMode === 'photo') {
          if (this.studioPhotoOpts.pose !== undefined) {
            nextCh.setStudioPose(this.studioPhotoOpts.pose || null);
          }
          if (this.studioPhotoOpts.expression !== undefined) {
            nextCh.setExpressionOverride(
              this.studioPhotoOpts.expression ? (this.studioPhotoOpts.expression as Mood) : null,
            );
          }
        }
      } else if (this.exploration.active) {
        nextCh.setOwnView(this.exploration.isFirstPersonCameraActive);
      }
      this.wake();
      return;
    }

    if (cur.ready) {
      await cur.applyCreatorProfile(
        profile,
        sky ? { season: sky.season, snow: sky.snow ?? 0 } : undefined,
      );
      this.wake();
    }
  }

  setSharedCityLook(wire: string | null): void {
    this.sharedCity?.setLocalLook(wire);
  }

  sendSharedQuickChat(code: string): boolean {
    return this.sharedCity?.sendQuickChat(code) ?? false;
  }

  getPeerQuickChats() {
    if (!this.sharedCity) return [];
    return this.sharedCity.peerQuickChats(this.activeCamera, this.canvas.clientWidth, this.canvas.clientHeight);
  }

  /**
   * Zero-extra-light CAZ Studio lighting: repurposes the existing scene DirectionalLights
   * (`this.key` = key, `this.fill` = fill, `this.windowLight` = rim) and switches `echoCsm` to
   * `'city-interior'` (`key.shadow.intensity = 0`, `uCsmEnabled = -1`) so `NUM_DIR_LIGHTS` and
   * `NUM_DIR_LIGHT_SHADOWS` stay 100% constant -> ZERO shader recompiles on CAZ open/close!
   */
  private saveAndRepurposeStudioLights(): void {
    if (!this.studioSavedLights) {
      this.studioSavedLights = {
        keyPos: this.key.position.clone(),
        keyTarget: this.key.target.position.clone(),
        keyColor: this.key.color.clone(),
        keyIntensity: this.key.intensity,
        keyShadowIntensity: this.key.shadow.intensity,
        winPos: this.windowLight.position.clone(),
        winTarget: this.windowLight.target.position.clone(),
        winColor: this.windowLight.color.clone(),
        winIntensity: this.windowLight.intensity,
        fillPos: this.fill.position.clone(),
        fillTarget: this.fill.target.position.clone(),
        fillColor: this.fill.color.clone(),
        fillIntensity: this.fill.intensity,
        zoneMode: this.echoCsm.zoneMode,
      };
    }
    this.echoCsm.setZoneMode('city-interior');
    this.key.shadow.intensity = 0;
  }

  private restoreStudioLights(): void {
    const saved = this.studioSavedLights;
    if (!saved) return;
    this.studioSavedLights = null;
    this.key.position.copy(saved.keyPos);
    this.key.target.position.copy(saved.keyTarget);
    this.key.color.copy(saved.keyColor);
    this.key.intensity = saved.keyIntensity;
    this.key.shadow.intensity = saved.keyShadowIntensity;
    this.key.target.updateMatrixWorld();
    this.key.updateMatrixWorld();

    this.windowLight.position.copy(saved.winPos);
    this.windowLight.target.position.copy(saved.winTarget);
    this.windowLight.color.copy(saved.winColor);
    this.windowLight.intensity = saved.winIntensity;
    this.windowLight.target.updateMatrixWorld();
    this.windowLight.updateMatrixWorld();

    this.fill.position.copy(saved.fillPos);
    this.fill.target.position.copy(saved.fillTarget);
    this.fill.color.copy(saved.fillColor);
    this.fill.intensity = saved.fillIntensity;
    this.fill.target.updateMatrixWorld();
    this.fill.updateMatrixWorld();

    this.echoCsm.setZoneMode(saved.zoneMode);
  }

  private enterStudioBase(nextMode: 'creator' | 'build' | 'photo') {
    if (this.studioMode === 'none') {
      this.studioSavedControlsEnabled = this.controls.enabled;
      this.controls.enabled = false;
      this.exploration.setBlocked(true);
      this.studioCamInitialized = false;
    }
    this.exploration.clearOwnLimbGuard();
    this.studioMode = nextMode;
    this.canvas.style.cursor = nextMode === 'photo' || nextMode === 'creator' ? 'grab' : '';
    this.studioCamera.aspect = (this.canvas.clientWidth || window.innerWidth) / Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.studioCamera.updateProjectionMatrix();
    this.wake();
  }

  private exitStudioBase() {
    if (this.studioMode === 'none') return;
    this.studioMode = 'none';
    this.studioCamInitialized = false;
    this.studioPhotoOpts = {};
    this.studioDrag = null;
    this.canvas.style.cursor = '';
    this.restoreStudioLights();
    if (this.studioSavedWeather) {
      this.game.setEnvironment(this.studioSavedWeather);
      this.studioSavedWeather = null;
    }
    this.character?.setExpressionOverride(null);
    this.character?.setStudioPose(null);
    this.exploration.setBlocked(false);
    this.controls.enabled = this.studioSavedControlsEnabled && !this.exploration.active;
    if (this.exploration.isFirstPersonCameraActive) {
      this.character?.setOwnView(true);
    } else {
      this.character?.setOwnView(false);
      this.exploration.clearOwnLimbGuard();
    }
    this.wake();
  }

  /**
   * Character Creator Studio camera mode on the one shared renderer and scene:
   * portrait 30 deg FOV on face close-up, soft 3-point key/fill/rim lighting via existing scene
   * DirectionalLights (zero extra lights -> zero shader recompiles), turntable yaw orbit, zero WASD bleed.
   */
  setCreatorStudioMode(active: boolean, opts?: CreatorStudioOptions): void {
    if (!active) {
      if (this.studioMode === 'creator') this.exitStudioBase();
      return;
    }
    const entering = this.studioMode !== 'creator';
    this.studioCreatorOpts = { ...this.studioCreatorOpts, ...(opts ?? {}) };
    this.enterStudioBase('creator');
    this.character?.setOwnView(false);
    if (entering) {
      this.character?.clearTransientMotion({ contrapposto: true });
    }
    const expr = this.studioCreatorOpts.expression;
    if (expr !== undefined) {
      this.character?.setExpressionOverride(expr ? (expr as Mood) : null);
    }
    if (this.studioCreatorOpts.snowPreview !== undefined) {
      if (this.studioCreatorOpts.snowPreview) {
        if (!this.studioSavedWeather) {
          this.studioSavedWeather = {
            season: this.game.envControl.season,
            weather: this.game.envControl.weather,
          };
        }
        this.game.setEnvironment({ season: 3, weather: 'snowy' });
      } else if (this.studioSavedWeather) {
        this.game.setEnvironment(this.studioSavedWeather);
        this.studioSavedWeather = null;
      }
    }
    this.saveAndRepurposeStudioLights();
    const preset = this.studioCreatorOpts.lightPreset ?? 'studio';
    if (preset === 'golden') {
      this.key.color.set('#ffd29d'); this.key.intensity = 2.8;
      this.fill.color.set('#b8c9f0'); this.fill.intensity = 0.85;
      this.windowLight.color.set('#ffaa66'); this.windowLight.intensity = 1.9;
    } else if (preset === 'night') {
      this.key.color.set('#9ec5ff'); this.key.intensity = 1.8;
      this.fill.color.set('#4c5c8a'); this.fill.intensity = 0.75;
      this.windowLight.color.set('#ffcf86'); this.windowLight.intensity = 2.0;
    } else if (preset === 'daylight') {
      this.key.color.set('#fff9f0'); this.key.intensity = 2.3;
      this.fill.color.set('#cbe3ff'); this.fill.intensity = 1.1;
      this.windowLight.color.set('#e8f2ff'); this.windowLight.intensity = 1.1;
    } else {
      this.key.color.set('#fff5ea'); this.key.intensity = 2.4;
      this.fill.color.set('#d8e8ff'); this.fill.intensity = 1.2;
      this.windowLight.color.set('#c4d8ff'); this.windowLight.intensity = 1.45;
    }
    this.updateStudioCamera(0);
  }

  /** Elevated isometric / top-down Build Mode camera overview on the one shared renderer and scene. */
  setBuildCameraMode(active: boolean, opts?: BuildCameraOptions): void {
    if (!active) {
      if (this.studioMode === 'build') this.exitStudioBase();
      return;
    }
    this.studioBuildOpts = { ...this.studioBuildOpts, ...(opts ?? {}) };
    if (this.studioSavedLights) this.restoreStudioLights();
    this.enterStudioBase('build');
    this.character?.setOwnView(false);
    this.updateStudioCamera(0);
  }

  /** Photo Studio camera mode with optional time freeze, adjustable lens FOV, orbit/pitch/zoom, poses, and expressions. */
  setPhotoStudioMode(active: boolean, opts?: PhotoStudioOptions): void {
    if (!active) {
      if (this.studioMode === 'photo') this.exitStudioBase();
      return;
    }
    this.studioPhotoOpts = { ...this.studioPhotoOpts, ...(opts ?? {}) };
    if (this.studioSavedLights) this.restoreStudioLights();
    this.enterStudioBase('photo');
    this.character?.setOwnView(false);
    if (this.studioPhotoOpts.pose !== undefined) {
      this.character?.setStudioPose(this.studioPhotoOpts.pose || null);
    }
    if (this.studioPhotoOpts.expression !== undefined) {
      this.character?.setExpressionOverride(
        this.studioPhotoOpts.expression ? (this.studioPhotoOpts.expression as Mood) : null,
      );
    }
    this.updateStudioCamera(0);
  }

  /** Renders an immediate fresh frame and captures a crisp PNG data URL with optional sanitized CSS photo filter. */
  capturePhotoDataUrl(filterCss?: string): string | null {
    if (this.disposed || typeof document === 'undefined') return null;
    try {
      if (this.studioMode !== 'none') {
        this.updateStudioCamera(0);
      }
      const world = this.echoLife;
      const body = this.character?.root.position;
      const regionNow = world?.stats.region ?? null;
      const distantStudy = Boolean(
        this.exploration.active &&
          world &&
          body &&
          (Math.max(Math.abs(body.x), Math.abs(body.z)) > world.size / 2 + 16 ||
            world.insideBuildingId !== null ||
            (body.y < -1.15 && !world.inStudy(body)) ||
            (this.outdoorLighting && regionNow !== 'balcony' && Math.max(Math.abs(body.x), Math.abs(body.z)) > world.size / 2 + 2.5)),
      );
      const maxVfxTier = graphicsTierToVfxTier(this.qualityTier);
      const glassTier: VfxTier = maxVfxTier === 'low' ? 'low' : 'medium';

      const hidden: T.Object3D[] = [];
      this.room?.setDistant(distantStudy);
      if (distantStudy && world) {
        if (this.life.group.visible) {
          hidden.push(this.life.group);
          this.life.group.visible = false;
        }
        if (this.pet && this.pet.root.visible) {
          hidden.push(this.pet.root);
          this.pet.root.visible = false;
        }
        const phys = this.manip.physics;
        for (const item of this.placed.values()) {
          if (item.group.visible && world.inStudy(item.group.position) && !phys?.isHeld(item.obj.id)) {
            hidden.push(item.group);
            item.group.visible = false;
          }
        }
      }
      if (this.exploration.active && world?.insideBuildingRect) {
        const peopleRoot = this.game.peopleGroup;
        const r = world.insideBuildingRect;
        if (peopleRoot && peopleRoot.visible) {
          for (let i = 0; i < peopleRoot.children.length; i++) {
            const c = peopleRoot.children[i];
            if (!c.visible) continue;
            if ((c as T.InstancedMesh).isInstancedMesh) {
              hidden.push(c);
              c.visible = false;
              continue;
            }
            const px = c.position.x;
            const pz = c.position.z;
            if ((px !== 0 || pz !== 0) && (px < r.x0 - 18 || px > r.x1 + 18 || pz < r.z0 - 18 || pz > r.z1 + 18)) {
              hidden.push(c);
              c.visible = false;
            }
          }
        }
      }

      try {
        if (!distantStudy) {
          this.room?.prepareVfx(this.renderer, this.scene, this.activeCamera, 0, glassTier, this.reduced);
        }
        const waterFluidActive = this.water.running;
        const shadowsReady = !this.renderer.shadowMap.enabled || this.echoCsm.hasAllActiveShadowMaps();
        if (
          world &&
          this.exploration.active &&
          !this.insideCityLighting &&
          shadowsReady
        ) {
          const restoreFirstPersonHead =
            this.studioMode === 'none' &&
            this.exploration.isFirstPersonCameraActive &&
            Boolean(this.character?.ready);
          if (restoreFirstPersonHead) {
            this.character?.setOwnView(false);
            this.exploration.clearOwnLimbGuard();
          }
          try {
            world.water?.prepareReflection(this.renderer, this.scene, this.activeCamera);
          } finally {
            if (restoreFirstPersonHead) {
              this.exploration.restoreOwnLimbGuard();
              if (this.exploration.cameraRig.ownLimbUniforms.uOwnLimbGuardActive.value > 0.5) {
                this.character?.setOwnView(true);
              }
            }
          }
        }
        if (this.echoCsm.active && this.renderer.shadowMap.enabled && !this.insideCityLighting && this.studioMode !== 'creator') {
          this.csmNpcScratch[0] = this.character?.root ?? null;
          this.csmNpcScratch[1] = this.game.peopleGroup;
          this.echoCsm.renderSecondaryCascades(this.renderer, this.scene, this.activeCamera, {
            npcs: this.csmNpcScratch,
          });
        }
        getEchoLifePlanarMirrors().prepareReflection({
          renderer: this.renderer,
          scene: this.scene,
          camera: this.activeCamera,
          qualityTier: this.qualityTier,
          canRenderReflection: shadowsReady,
          explorationActive: this.exploration.active && this.studioMode !== 'creator',
          driving: Boolean(this.game?.activeDrivenVehicle),
          character: this.character,
          clearOwnLimbGuard: () => this.exploration.clearOwnLimbGuard(),
          restoreOwnLimbGuard: () => this.exploration.restoreOwnLimbGuard(),
        });
        const needsNormalPass = this.postFx.diagnostics.ssaoActive && this.exploration.active;
        if (needsNormalPass) {
          this.refreshNormalPassExcludes(world);
        }
        this.postFx.render(0, {
          isOverviewAlpha: !this.exploration.active && this.studioMode === 'none',
          waterFluidActive,
          scene: this.scene,
          camera: this.activeCamera,
          normalPassExclude: needsNormalPass ? this.normalPassExcludes : undefined,
        });
        if (waterFluidActive) {
          this.water.render(this.renderer, this.activeCamera);
        }
      } finally {
        for (let i = 0; i < hidden.length; i++) {
          hidden[i].visible = true;
        }
      }

      const src = this.canvas;
      const w = src.width || src.clientWidth || 1280;
      const h = src.height || src.clientHeight || 720;
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const ctx = out.getContext('2d');
      if (!ctx) return src.toDataURL('image/png');
      const effectiveFilter = filterCss ?? this.studioPhotoOpts.filterCss;
      if (effectiveFilter && effectiveFilter !== 'none' && !/backdrop-filter|url\s*\(/i.test(effectiveFilter) && /^[a-z0-9().,%\s-]+$/i.test(effectiveFilter)) {
        ctx.filter = effectiveFilter;
      }
      ctx.drawImage(src, 0, 0, w, h);
      return out.toDataURL('image/png');
    } catch {
      return null;
    }
  }

  private updateStudioCamera(dt: number) {
    const ch = this.character;
    const basePos = ch?.ready ? ch.root.position : tmpV.set(0, 0, 0);
    const worldCenter = tmpStudioWorldCenter.set(basePos.x, basePos.y, basePos.z);
    this.stage.localToWorld(worldCenter);
    const charYaw = ch?.ready ? ch.root.rotation.y : 0;
    const lerpK = !this.studioCamInitialized || dt <= 0 || this.reduced ? 1 : 1 - Math.exp(-10 * dt);

    const desiredPos = tmpStudioDesiredPos.set(0, 0, 0);
    const desiredTarget = tmpStudioDesiredTarget.set(0, 0, 0);
    let desiredFov = 36;

    if (this.studioMode === 'creator') {
      const preset = this.studioCreatorOpts.preset ?? 'full';
      const yaw = charYaw + (this.studioCreatorOpts.yawOffset ?? 0);
      const fwdX = Math.sin(yaw);
      const fwdZ = Math.cos(yaw);
      let dist = 2.65;
      let targetY = 0.96;
      let camY = 1.12;
      if (preset === 'face') {
        desiredFov = 30;
        dist = 0.95;
        targetY = 1.54;
        camY = 1.56;
      } else if (preset === 'upper') {
        desiredFov = 34;
        dist = 1.55;
        targetY = 1.32;
        camY = 1.38;
      } else if (preset === 'shoes') {
        desiredFov = 36;
        dist = 1.65;
        targetY = 0.36;
        camY = 0.56;
      } else {
        desiredFov = 38;
        dist = 2.75;
        targetY = 0.94;
        camY = 1.10;
      }
      desiredTarget.set(worldCenter.x, worldCenter.y + targetY, worldCenter.z);
      desiredPos.set(worldCenter.x + fwdX * dist, worldCenter.y + camY, worldCenter.z + fwdZ * dist);

      if (this.studioSavedLights) {
        const rightX = Math.cos(yaw);
        const rightZ = -Math.sin(yaw);
        this.key.position.set(worldCenter.x + fwdX * 2.4 + rightX * 1.8, worldCenter.y + 2.6, worldCenter.z + fwdZ * 2.4 + rightZ * 1.8);
        this.key.target.position.copy(desiredTarget);
        this.key.target.updateMatrixWorld();
        this.key.updateMatrixWorld();

        this.fill.position.set(worldCenter.x + fwdX * 1.9 - rightX * 2.2, worldCenter.y + 1.8, worldCenter.z + fwdZ * 1.9 - rightZ * 2.2);
        this.fill.target.position.copy(desiredTarget);
        this.fill.target.updateMatrixWorld();
        this.fill.updateMatrixWorld();

        this.windowLight.position.set(worldCenter.x - fwdX * 2.4 - rightX * 0.8, worldCenter.y + 2.4, worldCenter.z - fwdZ * 2.4 - rightZ * 0.8);
        this.windowLight.target.position.copy(desiredTarget);
        this.windowLight.target.updateMatrixWorld();
        this.windowLight.updateMatrixWorld();
      }
    } else if (this.studioMode === 'build') {
      const panX = this.studioBuildOpts.panX ?? 0;
      const panZ = this.studioBuildOpts.panZ ?? 0;
      const zoom = T.MathUtils.clamp(this.studioBuildOpts.zoom ?? 1, 0.45, 2.2);
      const yaw = this.studioBuildOpts.yaw ?? Math.PI * 0.25;
      const dist = 13.5 / zoom;
      const height = 12.0 / zoom;
      desiredFov = 42;
      desiredTarget.set(worldCenter.x + panX, worldCenter.y + 0.35, worldCenter.z + panZ);
      desiredPos.set(
        desiredTarget.x + Math.sin(yaw) * dist,
        desiredTarget.y + height,
        desiredTarget.z + Math.cos(yaw) * dist,
      );
    } else if (this.studioMode === 'photo') {
      desiredFov = T.MathUtils.clamp(this.studioPhotoOpts.fov ?? 44, 24, 85);
      const yaw = charYaw + (this.studioPhotoOpts.yawDelta ?? 0);
      const pitch = T.MathUtils.clamp(this.studioPhotoOpts.pitchDelta ?? 0.08, -0.55, 0.85);
      const dist = T.MathUtils.clamp(2.85 + (this.studioPhotoOpts.zoomDelta ?? 0), 0.9, 9.0);
      const horiz = Math.cos(pitch) * dist;
      const vert = Math.sin(pitch) * dist;
      desiredTarget.set(worldCenter.x, worldCenter.y + 1.18, worldCenter.z);
      desiredPos.set(
        desiredTarget.x + Math.sin(yaw) * horiz,
        Math.max(worldCenter.y + 0.32, desiredTarget.y + vert),
        desiredTarget.z + Math.cos(yaw) * horiz,
      );
    }

    if (!this.studioCamInitialized) {
      this.studioCamPos.copy(desiredPos);
      this.studioCamTarget.copy(desiredTarget);
      this.studioCamInitialized = true;
    } else {
      this.studioCamPos.lerp(desiredPos, lerpK);
      this.studioCamTarget.lerp(desiredTarget, lerpK);
    }
    this.studioCamera.position.copy(this.studioCamPos);
    this.studioCamera.lookAt(this.studioCamTarget);
    if (Math.abs(this.studioCamera.fov - desiredFov) > 0.05) {
      this.studioCamera.fov += (desiredFov - this.studioCamera.fov) * lerpK;
      this.studioCamera.updateProjectionMatrix();
    }
    this.studioCamera.updateMatrixWorld();
  }

  /** Looking past glass exposes off-camera materials in a second, linear-color pass.
   * Queue both program variants as the room is assembled, before the player turns. */
  private prepareRoomShaders() {
    // Once canonical Stage-6 pre-entry warmup has completed, NEVER allocate ad-hoc 16x16 RTs or
    // invoke synchronous blocking `program.getUniforms()` mid-session!
    if (this._warmupReady) return;
    const renderer = this.renderer;
    if (this.exploration.active && this.echoLife?.ready) {
      // Stage outdoor shader compilation cleanly across animation frames so returning/cold outdoor frames never stall.
      void this.stageOutdoorWarmup(this.echoLife);
      return;
    }
    if (!renderer.extensions.has('KHR_parallel_shader_compile')) return;
    {
      const previous = renderer.getRenderTarget(), tone = renderer.toneMapping;
      const linear = new T.WebGLRenderTarget(16, 16, { type: T.HalfFloatType, samples: 4, colorSpace: T.LinearSRGBColorSpace });
      try {
        renderer.setRenderTarget(linear);
        renderer.toneMapping = T.NoToneMapping;
        renderer.compile(this.scene, this.activeCamera);
        // ANGLE also builds its native draw pipeline on the first submission.
        // Prepare the cast in the transmission target before a low reach
        // brings previously off-screen surfaces into that pass.
        if (this.character?.ready) {
          const centre = this.character.root.localToWorld(new T.Vector3(0, .85, 0));
          const eye = this.shaderCamera;
          eye.position.copy(centre).addScaledVector(new T.Vector3(.7, .1, 2.4), this.stage.scale.x);
          eye.lookAt(centre); eye.updateMatrixWorld();
          renderer.render(this.scene, eye);
        }
      } finally {
        renderer.setRenderTarget(previous);
        renderer.toneMapping = tone;
        linear.dispose();
      }
    }
    renderer.compile(this.scene, this.activeCamera);
    // Three defers uniform reflection and link diagnostics until first draw.
    // Complete those for the prepared variants while assembling the room.
    for (const program of renderer.info.programs ?? []) program.getUniforms();
  }
  private lastLook = { yaw: 0, pitch: 0 };
  private lastStride = 0;
  /** The feet are heard when they land, on what they land on: from the legs' own beat, so a step is never out of time with the walk. */
  private footsteps() {
    const ch = this.character, ex = this.exploration;
    if (!ch?.ready || !ex.active || !ch.standing) return;
    const phase = ch.stridePhase();
    if (phase === null || ex.speed < .25) { this.lastStride = 0; return; }
    const c = Math.cos(phase);
    if (this.lastStride && Math.sign(c) !== Math.sign(this.lastStride)) {
      const { x, z } = ch.root.position;
      const rug = this.layout?.objects.some(o => { const it = CATALOG_BY_ID[o.kind]; if (!it?.flat || o.hidden) return false; const dx = x - o.pos[0], dz = z - o.pos[2], s = Math.sin(o.rotY), k = Math.cos(o.rotY); return Math.abs(k * dx - s * dz) < it.size[0] * o.scale / 2 && Math.abs(s * dx + k * dz) < it.size[1] * o.scale / 2; });
      const region = this.echoLife?.stats.region ?? null;
      const zone = this.echoLife?.stats.zone ?? null;
      const intensity = Math.min(1, ex.speed / 2.6);
      if (this.echoLife?.ready) {
        const indoor = !region || !OUTDOOR_LIGHTING_REGIONS.has(region);
        const wet = indoor ? 0 : Math.max(this.echoLife.weatherUniforms?.uWetness.value ?? 0, this.game.sky()?.rain ?? 0);
        const snow = indoor ? 0 : Math.max(this.echoLife.weatherUniforms?.uSnowCover.value ?? 0, this.game.sky()?.snow ?? 0);
        const surface = classifyFootSurface(region, zone, Boolean(rug), this.layout?.room.floorStyle, snow);
        const pos = ch.root.position;
        this.game.worldAudio.triggerFootstep(surface, intensity, wet, false, snow, { x: pos.x, y: pos.y, z: pos.z });
      } else {
        const lawn = region === 'park' || region === 'garden';
        const paved = region === 'road' || region === 'sidewalk' || region === 'crossing' || region === 'plaza';
        footstep(lawn || rug ? 'rug' : paved ? 'stone' : 'wood', intensity);
        if (paved && this.game.sky()?.rain) splash(.045);
      }
      this.life.step(x, z);
      if (!rug && (this.life.floor?.sample('wet', x, z) ?? 0) > .25) splash(.09);
    }
    this.lastStride = c;
  }

  /** A wall between the camera and the room is hidden so it never blocks the view. */
  private hideFacingWalls() {
    if (!this.room) return;
    if (this.exploration.active) { for (const w of this.room.walls) w.mesh.visible = true; return; }
    const off = this.camera.position.clone().sub(this.controls.target);
    for (const w of this.room.walls) w.mesh.visible = w.axis === 'x' ? off.x > -1 : off.z > -1;
  }

  private lastSecond = -1;
  private animateObjects() {
    const now = new Date();
    const sec = now.getSeconds() + now.getMilliseconds() / 1000;
    const min = now.getMinutes() + sec / 60;
    const hour = (now.getHours() % 12) + min / 60;
    const whole = Math.floor(sec);
    this.placed.forEach((p) => {
      const ud = p.group.userData;
      if (ud.clock) {
        const c = ud.clock as { hour: T.Object3D; minute: T.Object3D; second: T.Object3D };
        c.hour.rotation.z = -(hour / 12) * Math.PI * 2;
        c.minute.rotation.z = -(min / 60) * Math.PI * 2;
        c.second.rotation.z = -((this.reduced ? whole : sec) / 60) * Math.PI * 2;
      }
      if (ud.digital && whole !== this.lastSecond) {
        const d = ud.digital as { canvas: HTMLCanvasElement; tex: T.CanvasTexture; last: string };
        const text = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        if (text !== d.last) {
          const g = d.canvas.getContext('2d')!;
          g.fillStyle = '#141833'; g.fillRect(0, 0, d.canvas.width, d.canvas.height);
          g.fillStyle = '#9fe8ff'; g.font = 'bold 64px Quicksand, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(text, d.canvas.width / 2, d.canvas.height / 2 + 4);
          if (d.tex?.image) d.tex.needsUpdate = true;
          d.last = text;
        }
      }
      if (!this.reduced) {
        if (ud.spin) (ud.spin as T.Object3D).rotation.y = this.time * 0.25 + ((ud.spin as T.Object3D).userData.extra ?? 0);
        if (ud.float) (ud.float as T.Object3D).position.y = 0.12 + Math.sin(this.time * 1.4) * 0.012;
        if (ud.pulse) (ud.pulse as T.Object3D).scale.setScalar(this.musicOn ? 1 + Math.abs(Math.sin(this.time * 6)) * 0.18 : 1);
      }
    });
    this.lastSecond = whole;
    tickDeskScreen(now);
  }

  /** Renders one catalogue item to a data URL (the toolbar's thumbnails are pictures of the real models). */
  thumbnail(kind: string, size = 160): string {
    const scene = new T.Scene();
    scene.environment = this.envTex;
    scene.environmentIntensity = 0.5;
    scene.add(new T.HemisphereLight('#ffffff', '#c9c3f0', 1.6));
    const d = new T.DirectionalLight('#ffffff', 2.4);
    d.position.set(3, 5, 4);
    scene.add(d);
    const g = build(kind);
    scene.add(g);
    const box = new T.Box3().setFromObject(g);
    const c = box.getCenter(new T.Vector3());
    const s = box.getSize(new T.Vector3());
    const r = Math.max(s.x, s.y, s.z) * 0.62 || 0.3;
    const cam = new T.OrthographicCamera(-r, r, r, -r, 0.01, 50);
    cam.position.copy(c).add(new T.Vector3(1, 0.8, 1.2).normalize().multiplyScalar(10));
    cam.lookAt(c);
    const rt = new T.WebGLRenderTarget(size, size, { samples: 4, colorSpace: T.SRGBColorSpace });
    const prev = this.renderer.getRenderTarget();
    const shadow = this.renderer.shadowMap.enabled;
    this.renderer.shadowMap.enabled = false;
    this.renderer.setRenderTarget(rt);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.render(scene, cam);
    const px = new Uint8Array(size * size * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, size, size, px);
    this.renderer.setRenderTarget(prev);
    this.renderer.shadowMap.enabled = shadow;
    rt.dispose();
    g.traverse((o) => { (o.userData.ownTextures as T.Texture[] | undefined)?.forEach((t) => t.dispose()); });
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) img.data.set(px.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL('image/png');
  }
}
