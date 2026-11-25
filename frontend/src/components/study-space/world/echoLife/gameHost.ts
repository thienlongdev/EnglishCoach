import * as T from 'three';
import {
  TireParticlePool,
  WorkshopView,
  disposeVehicleVisualRig,
  setVehiclePrewarmHook,
  updateVehicleVisualRig,
  upgradeAndOptimizeVehicleRig,
  type VehiclePrewarmHook,
  type VehicleVisualRig,
} from './workshopView';

export { setVehiclePrewarmHook, type VehiclePrewarmHook };
import {
  aimPlacement,
  buildPresetWorkshopActions,
  getRoomStylePreset,
  ROOM_STYLE_PRESETS,
  validateBuildPlacement,
  type RoomStylePreset,
  type StarterFurnitureOverride,
} from '@/lib/echo-life/game/build';
import {
  EchoLifeGame,
  RIDE_FACTOR,
  WORLD_DAY_MINUTES,
  UnreadableGameSave,
  type ActiveShiftTarget,
  type Feed,
  type NeedsSummary,
  type Target,
  type TimeScale,
} from '@/lib/echo-life/game/session';
import type { GameSaver } from '@/lib/echo-life/game/saver';
import type { DailyEnvContext, DailyScheduleSnapshot } from '@/lib/echo-life/game/dailyEvents';
import type { EnvSnapshot, ResidentId } from '@/lib/echo-life/game/npcMind';
import type { OverheardBanter } from '@/lib/echo-life/game/socialSim';
import type {
  EmotionState,
  KarmaState,
  Needs8,
  SubSkillsState,
  UrgeItem,
} from '@/lib/echo-life/game/playerMind';
import type {
  BusStopId,
  BusTripPlan,
  EchoPhoneState,
  FeedMilestoneTag,
  HangoutVenue,
  ManageCityConfig,
  PhonePhotoMeta,
} from '@/lib/echo-life/game/phoneSim';
import type {
  DilemmaResolutionResult,
  FullTimeCareerId,
  FullTimeCareerState,
} from '@/lib/echo-life/game/careerSim';
import { BISTRO_MENU } from '@/lib/echo-life/game/cookingSim';
import { crowdAt, crowdDensity, type CrowdContext, type ParkedVehicleHazard, type VehicleHazard } from '@/lib/echo-life/game/crowd';
import type { ParkedVehicleObstacle } from '@/lib/echo-life/game/people';
import type { BlinkerDirection, EnvironmentLightConditions, HeadlightMode } from '@/lib/echo-life/game/vehicleDynamics';
import type { RoadVehicle } from '@/lib/echo-life/game/automobile';
import {
  TwoWheeler,
  createSharedOrStarterBicycleController,
} from '@/lib/echo-life/game/twoWheeler';
import type { Furnishing } from '@/lib/echo-life/plan';
import { CHARACTERS, TUTORIAL_STEPS, WEATHER_STATES, getCalendar, type V3Result } from '@/lib/echo-life/v3/game-core/index.mjs';
import type { EchoLifeWorld } from './world';
import { stripTransmissionFromHierarchy } from './assets';
import { GameView, type GameViewQuality, type Label } from './gameView';
import type { BasketballPoseState } from './basketball';
import type { CourtAction, CourtControls, SharedCourt } from './sharedCourt';
import type { OrientedSolidBox } from '../physics';
import { getWorldAudio } from '../../echoLife/hudStore';
import {
  resolveAcousticPreset,
  type EchoLifeWorldAudio,
  type VehicleCarClass,
} from './worldAudio';
import {
  CityEmbodiedActions,
  classifyEmbodiedAction,
  type EmbodiedActionSnapshot,
  type EmbodiedActionTarget,
  type EmbodiedSeatTarget,
} from './cityEmbodiedActions';
import { getEchoLifePlanarMirrors } from './planarMirror';
import { ShowerWaterVfxSystem } from './showerVfx';
import type { HumanRig } from '@/lib/embodiment/human';
import {
  RiderIkController,
  computeHumanRigRiderFrame,
  createHumanRigRiderBinding,
  releaseHumanRigRiderContacts,
  type HumanRigRiderBinding,
  type RiderKinematicState,
} from '@/lib/embodiment/riderIk';
import {
  applyVehicleRigKinematics,
  extractVehicleRig,
  type VehicleRigSockets,
} from './vehicleRigExtractor';

/** What the page draws over the world (approx 5 a second): clock, weather, wallet, focus, tutorial, feed, name tags. */
export type WeatherOverride = 'auto' | 'sunny' | 'cloudy' | 'overcast' | 'light_rain' | 'heavy_rain' | 'snowy';
export const SEASON_NAMES = ['Spring', 'Summer', 'Autumn', 'Winter'] as const;

export const MULTIPLAYER_EMOTES = [
  'wave',
  'clap',
  'cheer',
  'laugh',
  'dance',
  'point',
  'toast',
] as const;
export type MultiplayerEmoteId = (typeof MULTIPLAYER_EMOTES)[number];

export const MULTIPLAYER_QUICK_CHATS = [
  'qc_hi',
  'qc_good_morning',
  'qc_nice_look',
  'qc_study_together',
  'qc_bistro_coffee',
  'qc_library_quiet',
  'qc_great_job',
  'qc_practice_english',
  'qc_follow_me',
  'qc_wait_a_sec',
  'qc_badminton',
  'qc_basketball',
  'qc_listen_music',
  'qc_take_photo',
  'qc_thank_you',
  'qc_bye',
] as const;
export type MultiplayerQuickChatId = (typeof MULTIPLAYER_QUICK_CHATS)[number];

const MULTIPLAYER_EMOTE_SET = new Set<string>(MULTIPLAYER_EMOTES);
const MULTIPLAYER_QUICK_CHAT_SET = new Set<string>(MULTIPLAYER_QUICK_CHATS);
const BISTRO_SKU_SET = new Set<string>(BISTRO_MENU.map((m) => m.id));

export const MULTIPLAYER_QUICK_CHAT_LABELS: Readonly<Record<MultiplayerQuickChatId, string>> = {
  qc_hi: 'Hi there!',
  qc_good_morning: 'Good morning!',
  qc_nice_look: 'Nice outfit!',
  qc_study_together: 'Want to study together?',
  qc_bistro_coffee: 'Coffee at Willow Bistro?',
  qc_library_quiet: 'Heading to the library.',
  qc_great_job: 'Great job!',
  qc_practice_english: 'Let us practice English!',
  qc_follow_me: 'Follow me!',
  qc_wait_a_sec: 'Wait a second!',
  qc_badminton: 'Up for badminton?',
  qc_basketball: 'Shoot some hoops?',
  qc_listen_music: 'Let us listen to music.',
  qc_take_photo: 'Let us take a photo!',
  qc_thank_you: 'Thank you!',
  qc_bye: 'See you soon!',
};

export interface RadialActionItem {
  id: string;
  label: string;
  category: 'interact' | 'home' | 'city' | 'social' | 'phone' | 'photo' | 'transit' | 'work';
  enabled: boolean;
  hint?: string;
  target?: Target;
  actionKey?: string;
  panel?: 'phone' | 'photo' | 'build' | 'character' | 'city' | 'career';
  recipeId?: string;
  bistroSku?: string;
  stopId?: BusStopId;
  emoteId?: MultiplayerEmoteId;
}

type SharedCityExt = import('./sharedCity').SharedCityPresence & {
  sendQuickChat?: (id: string) => void;
  sendEmote?: (id: string) => void;
};

const SEASON_DECLINATION = [0.02, 0.36, -0.06, -0.34] as const;
const OUTDOOR_REGIONS = new Set(['sidewalk', 'road', 'crossing', 'park', 'garden', 'plaza', 'balcony']);
const SHIFT_XP_SKILL: Record<string, string> = {
  market: 'business',
  barista: 'cooking',
  delivery: 'mobility',
  library: 'social',
  cafe: 'technology',
  gardener: 'diy_design',
  busker: 'social',
};

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function resolveVehicleCarClass(model: string | undefined): VehicleCarClass {
  if (!model) return 'micro';
  if (model.includes('halo') || model.includes('hyper')) return 'hyper';
  if (model.includes('spider') || model.includes('lotus')) return 'spider';
  if (model.includes('sedan') || model.includes('river')) return 'sedan';
  return 'micro';
}

const _audioFwd = new T.Vector3();
const _audioUp = new T.Vector3();
const _audioPortal = { x: 0, y: 0, z: 0 };
const _audioFountain = { x: 0, y: 0, z: 0 };
const _audioCommuter = { x: 0, y: 0, z: 0 };

function isBedAsset(asset: string): boolean {
  return asset === 'bed-single' || asset === 'canopy-bed' || asset.startsWith('bed_');
}

export interface DialogueCameraTarget {
  x: number;
  y: number;
  z: number;
  yaw: number;
  eyeY: number;
}

export interface GameHud {
  host: EchoLifeGameHost;
  ready: boolean;
  navReady: boolean;
  time: string; weekday: string; phase: string; weather: string; rain: boolean;
  season: string; seasonIndex: number;
  credits: number; level: number;
  zone: string;
  court: CourtControls | null;
  vehicle: {
    name: string;
    kmh: number;
    gear: 'D' | 'R' | 'P';
    kind: 'car' | 'bike' | 'motorbike';
    headlightsOn?: boolean;
    headlightMode?: HeadlightMode;
    blinker?: BlinkerDirection;
    hornActive?: boolean;
    braking?: boolean;
    pedalCadence?: number;
  } | null;
  basketball: {
    score: number;
    streak: number;
    holding: boolean;
    needsRetrieval: boolean;
    bestStreak?: number;
    isThreePointRange?: boolean;
    lastShotPoints?: number;
    lastShotResult?: BasketballPoseState['lastShotResult'];
  } | null;
  focus: { kind: 'npc' | 'spot'; label: string; name?: string; role?: string } | null;
  tutorial: { id: string; title: string; goal: string; hint: string; index: number; total: number } | null;
  feed: Feed[];
  labels: Label[];
  challenge: { type: string; index: number; length: number; sequence: number[] } | null;
  ending: string | null;
  needs?: NeedsSummary;
  dailyEvents?: DailyScheduleSnapshot;
  activeShift?: ActiveShiftTarget | null;
  overheardBanter?: OverheardBanter | null;
  timeScale?: TimeScale;
  needs8?: Needs8;
  emotion?: EmotionState;
  urges?: UrgeItem[];
  karma?: KarmaState;
  subSkills?: SubSkillsState;
  phone?: EchoPhoneState;
  fullTimeCareer?: FullTimeCareerState;
  embodied?: EmbodiedActionSnapshot | null;
  stats: { skinned: number; impostors: number; crowd: number; spots: number; walking: number; routes: number; doors: number; scenes: string[]; tiers: number[]; saves: number; claims: number; granted: number; refused: number };
}

/**
 * Echo Life Phase 3 + 4 + Total Rebirth in the Study Space engine: one game session over the engine's own world
 * (no second renderer, scene, body, physics or loop). Owned by `StudyWorld`; the page talks to it through `StudyWorld.game`.
 *
 * Bridges autonomous 22-resident AI & living crowd (A06), Vehicles 2.0 PBR clearcoat rigs & continuous basketball (A07),
 * lifestyle vitals / residences / 9-shop stock / daily events (A09), physical solar ephemeris (A04), dialogue camera framing (A05),
 * browser-native spatial Web Audio soundscape (A11), and Wave 11 embodied city interactions + life simulation.
 */
export class EchoLifeGameHost {
  game: EchoLifeGame | null = null;
  focus: Target | null = null;
  readonly embodied: CityEmbodiedActions;
  private view: GameView | null = null;
  private workshop: WorkshopView | null = null;
  private tirePool: TireParticlePool | null = null;
  private carVisualRig: VehicleVisualRig | null = null;
  private carRigSource: T.Object3D | null = null;
  private twoWheelerVisualRig: VehicleVisualRig | null = null;
  private twoWheelerRigSource: T.Object3D | null = null;
  private lastHud: GameHud | null = null;
  private prevChallengeType: string | null = null;
  private prevBasketballSig = '';
  private prevEmbodiedSig = '';
  private prevFocusSig = '';
  private prevPlayerSeat: string | null = null;
  private lastDailyEnv: DailyEnvContext | undefined = undefined;
  readonly audio: EchoLifeWorldAudio = getWorldAudio();
  private keysBound = false;
  private activeNow = false;
  private lastBodyPos: { x: number; z: number } | null = null;
  private smoothedBodySpeed = 0;
  private lastBasketScore = 0;
  private lastCarDoorToggleId = 0;
  private showerVfx: ShowerWaterVfxSystem | null = null;
  private showerEmitterRegisteredWorld: EchoLifeWorld | null = null;
  private sharedOrStarterBikeCtrl: TwoWheeler | null = null;
  private wasGameRiding = false;
  private wasGameRidingShared = false;
  private readonly parkedBoxesCache: OrientedSolidBox[] = [];
  private readonly parkedPeopleCache: ParkedVehicleObstacle[] = [];
  private readonly parkedCrowdCache: ParkedVehicleHazard[] = [];
  private readonly parkedCurbCrowdPool: ParkedVehicleHazard[] = [];
  private readonly crowdHazard: VehicleHazard = { x: 0, z: 0, vx: 0, vz: 0, speed: 0, radius: 1.2, hornActive: false };
  private readonly crowdCtx: CrowdContext = {};
  private readonly viewEnv = { snow: 0, season: 0, windX: 0.45, windZ: 0.15 };
  private readonly playerRiderBinding: HumanRigRiderBinding = createHumanRigRiderBinding();
  private sharedBikeGroup: T.Object3D | null = null;
  private sharedBikePayload: T.Object3D | null = null;
  private sharedBikeSockets: VehicleRigSockets | null = null;
  private readonly sharedBikeCtrl = new RiderIkController();
  private sharedBikeLastState: RiderKinematicState | null = null;
  private readonly starterBikeCtrl = new RiderIkController();
  private starterBikeLastState: RiderKinematicState | null = null;
  private prevSharedBikeYaw = 0;
  private sharedBikeYawSeeded = false;
  private readonly sharedBikeStepScratch: {
    speed: number;
    maxSpeed: number;
    throttle: number;
    steer: number;
    brake: boolean;
    isCoasting?: boolean;
    externalCrankAngle?: number;
    externalCrankOmega?: number;
    externalLean?: number;
    externalForkDive?: number;
    groundY: number;
  } = {
    speed: 0,
    maxSpeed: 7.6,
    throttle: 0,
    steer: 0,
    brake: false,
    isCoasting: false,
    groundY: 0,
  };
  private readonly starterBikeStepScratch: {
    speed: number;
    maxSpeed: number;
    throttle: number;
    steer: number;
    brake: boolean;
    isCoasting?: boolean;
    externalCrankAngle?: number;
    externalCrankOmega?: number;
    externalLean?: number;
    externalForkDive?: number;
    groundY: number;
  } = {
    speed: 0,
    maxSpeed: 7.6,
    throttle: 0,
    steer: 0,
    brake: false,
    isCoasting: false,
    groundY: 0,
  };
  private readonly activeRiderWorldStateScratch: {
    speed: number;
    maxSpeed: number;
    steer: number;
    lean: number;
    forkDive: number;
    crankAngle: number;
    crankOmega: number;
    standDownBlend: number;
    mountBlend: number;
    armIkWeight: number;
    kickstandRetract: number;
    doorOpenBlend: number;
    groundY: number;
    standSideSign: 1 | -1;
    freeLookYawOffset?: number;
    freeLookPitchOffset?: number;
  } = {
    speed: 0,
    maxSpeed: 7.6,
    steer: 0,
    lean: 0,
    forkDive: 0,
    crankAngle: 0,
    crankOmega: 0,
    standDownBlend: 0,
    mountBlend: 1,
    armIkWeight: 1,
    kickstandRetract: 1,
    doorOpenBlend: 0,
    groundY: 0,
    standSideSign: 1,
  };
  private readonly riderWorldGroundVec = new T.Vector3();
  private obstacleFrameId = 0;
  private obstacleCacheFrameId = -1;
  private obstacleCacheX = 0;
  private obstacleCacheZ = 0;
  private readonly obstacleCacheList: { x: number; z: number; r: number }[] = [];
  private readonly obstacleCachePool: { x: number; z: number; r: number }[] = [];
  private readonly starterBikeRiderStateScratch: {
    speed: number;
    maxSpeed: number;
    steer: number;
    lean: number;
    forkDive: number;
    crankAngle: number;
    crankOmega: number;
    standDownBlend: number;
    mountBlend: number;
    armIkWeight: number;
    kickstandRetract: number;
    doorOpenBlend: number;
    groundY: number;
    standSideSign: 1 | -1;
  } = {
    speed: 0,
    maxSpeed: 7.6,
    steer: 0,
    lean: 0,
    forkDive: 0,
    crankAngle: 0,
    crankOmega: 0,
    standDownBlend: 0,
    mountBlend: 1,
    armIkWeight: 1,
    kickstandRetract: 1,
    doorOpenBlend: 0,
    groundY: 0,
    standSideSign: 1,
  };
  private readonly sharedBikeStageStateScratch = {
    speed: 0,
    maxSpeed: 7.5,
    steer: 0,
    lean: 0,
    forkDive: 0,
    crankAngle: 0,
    crankOmega: 0,
    standDownBlend: 1,
    mountBlend: 0,
    armIkWeight: 0,
    kickstandRetract: 0,
    doorOpenBlend: 0,
    groundY: 0,
    standSideSign: 1 as 1 | -1,
  };
  private readonly sharedBikePoseScratch = { x: 0, z: 0, yaw: 0 };
  private readonly sharedBikeWorldVec = new T.Vector3();
  private readonly hiddenDoorPrevAngle = new Map<string, number>();
  private lastFrameDt = 1 / 60;
  private cachedDoorsWorld: EchoLifeWorld | null = null;
  private cachedDoorsVersion = -1;
  private cachedDoorsList: ReturnType<EchoLifeWorld['doors']> = [];
  private cachedZonesWorld: EchoLifeWorld | null = null;
  private cachedFountainCenter: { x: number; y: number; z: number } | null = null;
  private cachedGreenwayRect: { x0: number; x1: number; z0: number; z1: number } | null = null;

  building: string | null = null;
  buildYaw = 0;
  buildMessage = '';
  private buildBusy = false;
  private paying = false;

  /** Player/QA environment controls: automatic progression by default, previewable live in Settings. */
  envControl: { season: number | null; weather: WeatherOverride; clockSpeed: number } = { season: null, weather: 'auto', clockSpeed: 1 };

  setEnvironment(patch: Partial<{ season: number | null; weather: WeatherOverride; clockSpeed: number }>) {
    Object.assign(this.envControl, patch);
    if (
      this.game &&
      (patch.clockSpeed === 0 || patch.clockSpeed === 1 || patch.clockSpeed === 2 || patch.clockSpeed === 3)
    ) {
      this.game.setTimeScale(patch.clockSpeed);
    }
    this.publishHud(true);
  }

  setTimeOfDay(hour: number) {
    if (!this.game) return;
    const h = ((hour % 24) + 24) % 24;
    const dayStart = Math.floor(this.game.s.clock / 1440) * 1440;
    this.game.s.clock = dayStart + h * 60;
    this.game.dirty = true;
    this.publishHud(true);
  }

  /** Synchronously readable latest HUD snapshot (consumed by QA gates and HUD tooling). */
  get hud(): GameHud | null {
    return this.lastHud;
  }

  /** Shared browser-native spatial environmental & foley audio controller. */
  get worldAudio(): EchoLifeWorldAudio {
    return this.audio;
  }

  /** Cached scene root for `echo-life-people` (zero per-frame `getObjectByName` traversal in `engine.ts`). */
  get peopleGroup(): T.Object3D | null {
    return this.view?.group ?? null;
  }

  /** Exported basketball pose state for `engine.ts` -> `character.setSportPose(...)`. */
  basketballPose(): BasketballPoseState | null {
    return this.view?.basketball.poseState ?? null;
  }

  /** Updates live basketball shot-charge power (0..1) for gather animation. */
  setBasketballAimPower(power: number) {
    this.view?.basketball.setAimPower(power);
  }

  /** Cleanly exits continuous basketball shootaround. */
  leaveBasketballCourt() {
    this.view?.basketball.leaveCourt(this.game ?? undefined);
    this.game?.leaveBasketballCourt();
    this.publishHud(true);
  }

  /** Active dialogue speaker's world coordinates & eye height for upper-viewport camera framing. */
  dialogueCameraTarget(): DialogueCameraTarget | null {
    const game = this.game;
    const id = game?.people.talking;
    if (!game || !id) return null;
    const w = game.people.walkers.get(id);
    if (!w) return null;
    const x = w.seat ? w.seat.sit.x : w.x;
    const z = w.seat ? w.seat.sit.z : w.z;
    const y = w.seat ? w.seat.sit.y : (game.nav.walk.groundAt(w.x, w.z) ?? w.groundY ?? 0);
    const yaw = w.seat ? w.seat.yaw : w.yaw;
    const eyeY = y + (w.seat ? 1.18 : 1.54);
    return { x, y, z, yaw, eyeY };
  }

  /** Optional direct setter for active dialogue speaker (used when host UI controls conversation state). */
  setDialogueTarget(npcId: string | null) {
    if (this.game) this.game.people.talking = npcId;
  }

  private ensureShowerVfx(): ShowerWaterVfxSystem {
    if (!this.showerVfx) {
      this.showerVfx = new ShowerWaterVfxSystem();
      this.stage.add(this.showerVfx.group);
    } else if (this.showerVfx.group.parent !== this.stage) {
      this.stage.add(this.showerVfx.group);
    }
    return this.showerVfx;
  }

  private ensureBathShowerEmitter(world: EchoLifeWorld, game: EchoLifeGame): void {
    const vfx = this.ensureShowerVfx();
    if (this.showerEmitterRegisteredWorld === world && vfx.hasEmitter('bath')) return;
    const enc = game.getShowerEnclosure('bath/shower');
    const bathZone = world.plan.zones.find((z) => z.id === 'bath');
    const fromWorld = world.showerEmitterSpec;
    const floorY = fromWorld?.floorY ?? bathZone?.y ?? enc.stand.y;
    const nozzleX = fromWorld?.x ?? enc.nozzle.x;
    const nozzleY = fromWorld?.y ?? enc.nozzle.y;
    const nozzleZ = fromWorld?.z ?? enc.nozzle.z;
    const sprayRadius = fromWorld?.radius ?? 0.34;
    const x1 = bathZone?.rect.x1 ?? nozzleX + 0.42;
    const z1 = bathZone?.rect.z1 ?? nozzleZ + 0.44;
    vfx.registerEmitter({
      id: 'bath',
      nozzleStagePos: { x: nozzleX, y: nozzleY, z: nozzleZ },
      floorY,
      sprayRadius,
      enclosureBounds: {
        minX: x1 - 1.12,
        maxX: x1 - 0.08,
        minY: floorY,
        maxY: floorY + 2.35,
        minZ: z1 - 1.14,
        maxZ: z1 - 0.08,
      },
    });
    this.showerEmitterRegisteredWorld = world;
  }

  private groundYAt(x: number, z: number, fallbackY = 0): number {
    return (
      this.world?.walk.groundAt(x, z) ??
      this.game?.nav.walk.groundAt(x, z) ??
      fallbackY
    );
  }

  private wasTwoWheelerDriving = false;
  private wasCarDriving = false;

  /** Stage-6 `1x1` scissored shader prewarm for pooled walk-in shower streams, splashes, and steam (`programDelta === 0`). */
  warmupVfx(renderer: T.WebGLRenderer, scene: T.Scene, camera: T.Camera): void {
    this.ensureShowerVfx().warmup(renderer, scene, camera);
  }

  /**
   * Preloads player vehicles (`starterBike`, active `twoWheeler`, `car`) and upgrades their PBR rigs upfront
   * behind Stage-6 warmup so first mount incurs `0 ms` GLB load/merge spikes and `programDelta === 0`.
   */
  async prewarmForGameplay(world: EchoLifeWorld | null, camera: T.Camera): Promise<void> {
    if (world?.ready && this.saver?.loaded && (!this.game || this.world !== world)) {
      const doc = this.game ? this.serializeWithNpcSim() : this.saver.doc;
      this.drop();
      this.world = world;
      this.size = world.size;
      this.create(world, doc);
    }
    if (!this.game || !this.view) return;
    this.ensureShowerVfx();
    await this.view.prewarmPlayerVehicles(this.game, this.game.nav.walk);
    this.syncVehicleVisualRigs(
      this.game,
      this.view,
      0,
      { dayWeight: 1, rainWeight: 0, snowWeight: 0 },
      camera,
      false,
    );
  }

  /** Returns all `GameView` + `ShowerVfx` scene roots so Stage-6 `runPreEntryWarmup` compiles every shader variant upfront. */
  getWarmupRoots(): T.Object3D[] {
    const out: T.Object3D[] = [];
    if (this.view?.group) out.push(this.view.group);
    if (this.showerVfx?.group) out.push(this.showerVfx.group);
    return out;
  }

  /** True when the player is actively inside a running walk-in shower session. */
  get isShoweringActive(): boolean {
    return Boolean(this.game?.showeringActive);
  }

  /** Standing anchor and outward-facing yaw inside the walk-in shower bay while `isShoweringActive` is true. */
  get showerStandTarget(): { anchor: { x: number; y: number; z: number }; yaw: number } | null {
    if (!this.game?.showeringActive) return null;
    const enc = this.game.getShowerEnclosure();
    return { anchor: enc.stand, yaw: enc.facingYaw };
  }

  /** Immediately exits an active walk-in shower session (e.g. on `WASD` / `Space` / `Escape`) preserving earned hygiene. */
  cancelShower(): void {
    if (this.game?.cancelShower(true)) {
      this.showerVfx?.setActive('bath', false, 0);
      this.publishHud(true);
    }
  }

  /** Registers an optional async shader prewarm hook for newly loaded player/workshop/curb vehicles. */
  setVehiclePrewarmHook(hook: VehiclePrewarmHook | undefined): void {
    setVehiclePrewarmHook(hook);
  }

  /**
   * Unified active player vehicle controller across `Automobile`, Workshop `TwoWheeler`,
   * Personal Starter Bicycle (`game.riding && !game.ridingShared`), and Shared Multiplayer Bicycle (`game.ridingShared`).
   */
  get activeDrivenVehicle(): RoadVehicle | null {
    const game = this.game;
    if (!game) return null;
    if (game.drivenVehicle) {
      if (this.sharedOrStarterBikeCtrl?.driving) {
        this.sharedOrStarterBikeCtrl.dismountImmediate();
      }
      return game.drivenVehicle;
    }
    if (game.riding && this.sharedOrStarterBikeCtrl) {
      if (!this.sharedOrStarterBikeCtrl.driving && !this.wasGameRiding) {
        const body = this.bodyNow();
        const startPose =
          game.ridingShared && this.sharedBikeGroup
            ? {
                x: this.sharedBikeGroup.position.x,
                z: this.sharedBikeGroup.position.z,
                yaw: this.sharedBikeGroup.rotation.y,
              }
            : game.ridingShared && body
              ? { x: body.x, z: body.z, yaw: this.yaw }
              : { x: game.bike.x, z: game.bike.z, yaw: game.bike.yaw };
        this.sharedOrStarterBikeCtrl.mountAt(startPose, 0);
        this.wasGameRiding = true;
        this.wasGameRidingShared = Boolean(game.ridingShared);
      }
      return this.sharedOrStarterBikeCtrl.driving ? this.sharedOrStarterBikeCtrl : null;
    }
    if (this.sharedOrStarterBikeCtrl?.driving) {
      this.sharedOrStarterBikeCtrl.dismountImmediate();
    }
    return null;
  }

  /**
   * Dismounts whichever vehicle or bicycle (`car`, `twoWheeler`, starter `bike`, or `ridingShared`) is currently active.
   * Supports deferred `pendingDismount` braking above `0.6 m/s` and clean completion via `consumeAutoDismount`.
   */
  dismountActiveVehicle(body: { x: number; z: number }, yaw: number, why?: string): boolean {
    const game = this.game;
    if (!game) return false;
    if (game.car.driving) {
      return this.cb.onDrive?.('car') ?? false;
    }
    if (game.twoWheeler.driving) {
      return this.cb.onDrive?.('twoWheeler') ?? false;
    }
    if (game.riding) {
      const ctrl = this.sharedOrStarterBikeCtrl;
      if (ctrl && ctrl.driving && Math.abs(ctrl.speed) > 0.6 && !why) {
        ctrl.brakeToStop();
        ctrl.pendingDismount = true;
        return false;
      }
      const parkPos = ctrl ? { x: ctrl.pose.x, z: ctrl.pose.z } : body;
      const dismountYaw = ctrl ? ctrl.pose.yaw : yaw;
      let exitPos = body;
      if (ctrl && ctrl.driving) {
        const sideExit =
          ctrl.toggle(
            parkPos,
            (pt) => game.nav.walk.free(pt) && game.nav.walk.distToWorldInterior(pt, 0.52) <= 1e-4,
          ) ?? ctrl.toggle(parkPos, (pt) => game.nav.walk.free(pt));
        if (sideExit) exitPos = sideExit;
      }
      if (game.nav.walk.distToWorldInterior(exitPos, 0.52) > 1e-4) {
        const b = game.nav.walk.city.bounds;
        const clamped = {
          x: Math.max(b.x0 + 0.55, Math.min(b.x1 - 0.55, exitPos.x)),
          z: Math.max(b.z0 + 0.55, Math.min(b.z1 - 0.55, exitPos.z)),
        };
        if (game.nav.walk.free(clamped)) {
          exitPos = clamped;
        }
      }
      const wasShared = game.ridingShared;
      if (wasShared && this.cityPresence) {
        this.cityPresence.interactBike();
      }
      if (game.riding) {
        game.dismount(parkPos, dismountYaw, why);
      }
      if (!wasShared) {
        game.bike.x = parkPos.x;
        game.bike.z = parkPos.z;
        game.bike.yaw = dismountYaw;
      }
      ctrl?.dismountImmediate();
      this.starterBikeCtrl.dismountImmediate();
      this.starterBikeLastState = null;
      this.sharedBikeCtrl.dismountImmediate();
      this.sharedBikeLastState = null;
      if (this.sharedBikeGroup) {
        delete this.sharedBikeGroup.userData.__ecExternalRigSynced;
      }
      this.wasGameRiding = false;
      this.wasGameRidingShared = false;
      if (!why || why === 'stopped') {
        const exitY = this.groundYAt(exitPos.x, exitPos.z);
        this.cb.teleport?.({ x: exitPos.x, y: exitY, z: exitPos.z }, dismountYaw);
      }
      this.publishHud(true);
      return true;
    }
    return false;
  }

  /** Toggle headlights (`auto` -> `on` -> `off`) on the currently driven vehicle. */
  toggleHeadlights(): HeadlightMode | null {
    const v = this.activeDrivenVehicle;
    if (!v) return null;
    const mode = v.toggleHeadlights();
    this.audio.triggerUiClick('tap');
    return mode;
  }

  /** Set manual turn blinker (-1 left, 0 off, 1 right) on the currently driven vehicle. */
  setBlinker(direction: BlinkerDirection): BlinkerDirection | null {
    const v = this.activeDrivenVehicle;
    if (!v) return null;
    const next = v.setBlinker(direction);
    this.audio.triggerUiClick('tap');
    return next;
  }

  /** Sound the vehicle horn (or bicycle bell) and broadcast to nearby NPCs & ambient crowd. */
  soundVehicleHorn(): boolean {
    const game = this.game;
    if (!game) return false;
    const v = this.activeDrivenVehicle;
    if (v) {
      v.soundHorn();
      const kind = game.car.driving ? 'car' : v === game.twoWheeler && game.twoWheeler.powered ? 'motorbike' : 'bike';
      this.audio.triggerHorn(kind);
      game.people.notifyHorn(v.pose.x, v.pose.z, v.pose.yaw, v.spec?.name ?? kind);
      return true;
    }
    return false;
  }

  private findBedAt(at: { x: number; z: number }): Furnishing | null {
    const world = this.world;
    if (!world) return null;
    let best: Furnishing | null = null;
    let bestD = 0.85;
    const scan = (list: readonly Furnishing[]) => {
      for (const f of list) {
        if (!isBedAsset(f.asset)) continue;
        const d = Math.hypot(f.x - at.x, f.z - at.z);
        if (d < bestD) { bestD = d; best = f; }
      }
    };
    scan(world.plan.furniture);
    for (const home of world.city.residences) scan(home.furniture);
    return best;
  }

  /** Live 7-phase embodied city/home interaction snapshot (or `null` when idle). */
  get embodiedAction(): EmbodiedActionSnapshot | null {
    return this.embodied.snapshot();
  }

  /**
   * Structured physical alignment & HumanRig IK target (`{ x, y, z, yaw, handTarget?, seat?, durationSec }`)
   * for the active embodied city/home interaction (`null` when idle; zero allocations per frame).
   */
  getEmbodiedActionTarget(): EmbodiedActionTarget | null {
    return this.embodied.getActionTarget();
  }

  /** Keeps `CityEmbodiedActions` approach origin synchronized during automated walk-to-stand alignment. */
  syncEmbodiedAutoApproach(pos: { x: number; z: number }): void {
    this.embodied.syncAutoApproachPos(pos);
  }

  /** Notifies `CityEmbodiedActions` of explicit manual player movement input (WASD/Arrows/Jump) to cancel cleanly. */
  notifyEmbodiedManualInput(): void {
    this.embodied.notifyManualMoveInput();
    if (this.game?.showeringActive) {
      this.cancelShower();
    }
  }

  /**
   * Computes current-frame `HumanRigRiderBinding` (`leftContact`/`rightContact` via `handleGrip`,
   * `bodyFrameLegTargets` for `BodyFrame.legTargets`, per-rider virtual seat-post adjustment,
   * saddle-locked `rootPosition`/`rootQuaternion`, `seated: true`, `lean`, `twist`) BEFORE
   * `HumanRig.update()` runs — zero raw post-`update` bone writes!
   * Returns `null` (and releases any active handlebar/steering contacts) when unmounted.
   */
  getActivePlayerRiderBinding(rig: HumanRig, baseHipRestHeight = 0.93): HumanRigRiderBinding | null {
    const game = this.game;
    const view = this.view;
    if (!game || !view) {
      this.clearPlayerRiderBinding(rig);
      return null;
    }

    let vehRoot: T.Object3D | null = null;
    let sockets: VehicleRigSockets | null = null;
    let riderState: RiderKinematicState | null = null;
    let groundIsAlreadyWorld = false;

    if (game.twoWheeler.driving && this.twoWheelerVisualRig?.sockets) {
      // Snap visual rig to current-frame `game.twoWheeler.pose` BEFORE IK solves (`0.00 mm` 1-frame vehicle lag!).
      updateVehicleVisualRig(
        this.twoWheelerVisualRig,
        game.twoWheeler,
        game.nav.walk,
        0,
        { dayWeight: 1, rainWeight: 0, snowWeight: 0 },
        undefined,
        false,
      );
      vehRoot = this.twoWheelerVisualRig.root;
      sockets = this.twoWheelerVisualRig.sockets;
      riderState = this.twoWheelerVisualRig.lastRiderState;
    } else if (game.car.driving && this.carVisualRig?.sockets) {
      updateVehicleVisualRig(
        this.carVisualRig,
        game.car,
        game.nav.walk,
        0,
        { dayWeight: 1, rainWeight: 0, snowWeight: 0 },
        undefined,
        false,
      );
      vehRoot = this.carVisualRig.root;
      sockets = this.carVisualRig.sockets;
      riderState = this.carVisualRig.lastRiderState;
    } else if (game.riding) {
      const ctrl = this.sharedOrStarterBikeCtrl;
      // E5-03.3 [P0]: Support BOTH personal starter bicycle AND shared multiplayer room bicycle (`game.ridingShared`)!
      if (game.ridingShared && this.sharedBikeGroup?.visible && this.sharedBikeSockets && this.sharedBikeLastState) {
        vehRoot = this.sharedBikeGroup;
        sockets = this.sharedBikeSockets;
        riderState = this.sharedBikeLastState;
        groundIsAlreadyWorld = true;
      } else if (view.starterBikeGroup?.visible && view.starterBikeSockets && (this.starterBikeLastState || view.starterBikeState || ctrl?.driving)) {
        vehRoot = view.starterBikeGroup;
        sockets = view.starterBikeSockets;
        if (ctrl && ctrl.driving) {
          const groundStageY = this.world?.walk.groundAt(ctrl.pose.x, ctrl.pose.z) ?? 0;
          const st = this.starterBikeRiderStateScratch;
          st.speed = ctrl.speed;
          st.maxSpeed = ctrl.spec?.maxSpeed ?? 7.6;
          st.steer = ctrl.steer;
          st.lean = ctrl.lean;
          st.forkDive = ctrl.forkDive;
          st.crankAngle = ctrl.dynamics.crankAngle;
          st.crankOmega = ctrl.coasting ? 0 : ctrl.pedalCadence;
          st.standDownBlend = Math.abs(ctrl.speed) > 0.25 || Math.abs(ctrl.lastThrottle) > 0.02 ? 0 : 1;
          st.mountBlend = 1;
          st.armIkWeight = 1;
          st.kickstandRetract = 1;
          st.doorOpenBlend = 0;
          st.groundY = groundStageY;
          st.standSideSign = 1;
          applyVehicleRigKinematics(
            view.starterBikeGroup,
            view.starterBikeSockets,
            st,
            ctrl.pose,
            ctrl.spin,
          );
          riderState = st;
          groundIsAlreadyWorld = false;
        } else if (this.starterBikeLastState) {
          riderState = this.starterBikeLastState;
          groundIsAlreadyWorld = true;
        } else {
          riderState = view.starterBikeState!;
        }
      }
    }

    if (!vehRoot || !sockets || !riderState) {
      this.clearPlayerRiderBinding(rig);
      return null;
    }

    let worldRiderState: RiderKinematicState = riderState;
    if (!groundIsAlreadyWorld && vehRoot.parent) {
      vehRoot.parent.updateWorldMatrix(true, false);
      this.riderWorldGroundVec.set(vehRoot.position.x, riderState.groundY, vehRoot.position.z);
      vehRoot.parent.localToWorld(this.riderWorldGroundVec);
      const ws = this.activeRiderWorldStateScratch;
      ws.speed = riderState.speed;
      ws.maxSpeed = riderState.maxSpeed;
      ws.steer = riderState.steer;
      ws.lean = riderState.lean;
      ws.forkDive = riderState.forkDive;
      ws.crankAngle = riderState.crankAngle;
      ws.crankOmega = riderState.crankOmega;
      ws.standDownBlend = riderState.standDownBlend;
      ws.mountBlend = riderState.mountBlend;
      ws.armIkWeight = riderState.armIkWeight;
      ws.kickstandRetract = riderState.kickstandRetract;
      ws.doorOpenBlend = riderState.doorOpenBlend;
      ws.groundY = this.riderWorldGroundVec.y;
      ws.standSideSign = riderState.standSideSign;
      ws.freeLookYawOffset = riderState.freeLookYawOffset;
      ws.freeLookPitchOffset = riderState.freeLookPitchOffset;
      worldRiderState = ws;
    }

    computeHumanRigRiderFrame(
      rig,
      vehRoot,
      sockets,
      worldRiderState,
      this.playerRiderBinding,
      baseHipRestHeight,
    );
    return this.playerRiderBinding;
  }

  private clearPlayerRiderBinding(rig?: HumanRig | null): void {
    releaseHumanRigRiderContacts(rig, this.playerRiderBinding, 0);
  }

  /**
   * Clean `Reset Room` transient-interaction recovery helper: cancels any stuck embodied action,
   * seated lock, running shower/steam, active NPC dialogue lock, build placement ghost, or residual
   * arm/rider IK contacts while preserving 100% of progression, wallet, skills, quests, and learning data.
   */
  resetRoomInteractionState(opts?: { rig?: HumanRig | null; dismountVehicles?: boolean }): void {
    this.embodied.cancel('Room reset.');
    this.releasePlayerSeat(false);
    if (this.game?.showeringActive) {
      this.game.cancelShower(true);
    }
    this.showerVfx?.setActive('bath', false, 0);
    getEchoLifePlanarMirrors().setZoneSteamLevel('bath', 0);
    if (this.game) {
      this.game.people.talking = null;
    }
    this.focus = null;
    this.cancelBuild();
    this.workshop?.setPlacementGhost?.(null);
    if (this.view?.basketball.active || this.view?.basketball.continuousSession) {
      this.leaveBasketballCourt();
    }
    if (opts?.dismountVehicles && this.game) {
      const b = this.bodyNow() ?? { x: 0, z: 0 };
      if (this.game.riding || this.game.drivenVehicle) {
        this.dismountActiveVehicle(b, this.yaw, 'reset');
      }
    }
    if (!this.activeDrivenVehicle) {
      this.clearPlayerRiderBinding(opts?.rig ?? null);
      opts?.rig?.clearAllContactsImmediate();
    }
    this.obstacleCacheFrameId = -1;
    this.publishHud(true);
  }

  /** Cleanly interrupts any active embodied city/home interaction and restores normal locomotion. */
  cancelEmbodiedAction(reason?: string): void {
    this.embodied.cancel(reason);
    if (this.game?.showeringActive) {
      this.game.cancelShower(true);
      this.showerVfx?.setActive('bath', false, 0);
    }
    this.publishHud(true);
  }

  /** Releases `game.people.playerSeat` cleanly and refreshes HUD prompt immediately. */
  releasePlayerSeat(playFoley = false): void {
    const game = this.game;
    if (!game || !game.people.playerSeat) return;
    const seatId = game.people.playerSeat;
    const seat = game.people.seats.find(s => s.id === seatId);
    game.people.playerSeat = null;
    if (playFoley && seat) {
      this.audio.triggerSeat(false, 'wood', { x: seat.sit.x, y: seat.sit.y, z: seat.sit.z });
    }
    this.publishHud(true);
  }

  private tryClaimNearbySeat(near: { x: number; z: number }, zoneHint?: string): EmbodiedSeatTarget | null {
    const game = this.game;
    if (!game || !this.cb.sit || game.people.playerSeat) return null;
    const zone = zoneHint ?? game.s.player.zone;
    const refPos = this.bodyNow() ?? near;
    const isOccupied = (seatCand: import('@/lib/echo-life/game/people').Seat) =>
      [...game.people.walkers.values()].some((w) => w.seat === seatCand || w.targetSeat === seatCand);
    const candidates = game.people.seats
      .filter((s) => (!zone || s.zone === zone) && Math.hypot(s.sit.x - near.x, s.sit.z - near.z) < 2.4 && !isOccupied(s))
      .sort((a, b) => Math.hypot(a.sit.x - refPos.x, a.sit.z - refPos.z) - Math.hypot(b.sit.x - refPos.x, b.sit.z - refPos.z));
    for (const candidate of candidates) {
      if (!this.cb.sit(candidate)) continue;
      game.people.playerSeat = candidate.id;
      this.audio.triggerSeat(true, 'wood', { x: candidate.sit.x, y: candidate.sit.y, z: candidate.sit.z });
      return {
        id: candidate.id,
        x: candidate.sit.x,
        y: candidate.sit.y,
        z: candidate.sit.z,
        yaw: candidate.yaw,
        top: candidate.top,
      };
    }
    return null;
  }

  async act(
    target: Target,
    key: string,
    opts?: { immediate?: boolean; quality?: 'ok' | 'great' | 'perfect' },
  ): Promise<V3Result> {
    const game = this.game;
    const normKey = key === 'toggle_shower_water' ? 'toggle_shower' : key;
    const body = this.bodyNow();
    const groundY = body ? this.groundYAt(body.x, body.z, (body as { y?: number }).y ?? 0) : 0;
    const bodyPos3 = body ? { x: body.x, y: groundY, z: body.z } : null;
    const bypassEmbodied =
      normKey === 'step_out_shower' ||
      normKey === 'sit' ||
      target.kind === 'seat' ||
      (target.kind === 'spot' && ['sit', 'rest', 'sleep'].includes(target.hotspot.action) && normKey !== 'watch_tv' && normKey !== 'tv_off');
    const spec = !opts?.immediate && !bypassEmbodied && this.activeNow && game
      ? classifyEmbodiedAction(target, normKey, bodyPos3)
      : null;

    let res: V3Result;
    if (spec && game) {
      const zoneHint = target.kind === 'spot' ? target.hotspot.zone : game.s.player.zone;
      res = await this.embodied.start(
        spec,
        () => this.performAct(target, normKey, opts),
        {
          bodyPos: bodyPos3,
          bodyYaw: this.yaw,
          immediate: false,
          onSeatRequest: spec.preferSeat ? (near) => this.tryClaimNearbySeat(near, zoneHint) : undefined,
        },
      );
    } else {
      res = await this.performAct(target, normKey, opts);
    }
    if (game && game === this.game) {
      if (game.people.playerSeat && res.ok && !res.openPanel && !res.settled) {
        res = { ...res, settled: true };
      }
      this.publishHud(true);
    }
    return res;
  }

  private async performAct(
    target: Target,
    key: string,
    opts?: { immediate?: boolean; quality?: 'ok' | 'great' | 'perfect' },
  ): Promise<V3Result> {
    const game = this.game, saver = this.saver;
    if (!game || !saver || this.paying) return { ok: false, msg: 'Please wait for the register.' };
    const normKey = key === 'toggle_shower_water' ? 'toggle_shower' : key;
    if (normKey === 'step_out_shower') {
      this.embodied.cancel('Stepped out of shower.');
      const enc = game.getShowerEnclosure();
      const res = game.stepOutOfShower();
      this.showerVfx?.setActive('bath', false, 0);
      this.audio.triggerUiClick('tap');
      const curBody = this.bodyNow();
      if (!curBody || Math.hypot(curBody.x - enc.stand.x, curBody.z - enc.stand.z) < 1.15) {
        if (this.cb.walkTo) {
          this.cb.walkTo(enc.stepOut, enc.facingYaw);
        } else {
          this.cb.teleport?.(enc.stepOut, enc.facingYaw);
        }
      }
      this.publishHud(true);
      return res;
    }
    if (target.kind === 'spot' && normKey === 'open_market_shop') {
      this.audio.triggerUiClick('open');
      return game.act(target, normKey);
    }
    if (normKey.startsWith('cook:')) {
      const res = game.cookHomeRecipe(normKey.slice(5));
      if (res.ok) this.audio.triggerUiClick('confirm');
      return res;
    }
    if (target.kind === 'spot' && normKey.startsWith('bistro_order:')) {
      const sku = normKey.slice('bistro_order:'.length);
      this.paying = true;
      try {
        const res = await game.orderBistroMenu(sku, saver);
        if (res.ok && game === this.game) {
          const fy = this.groundYAt(target.at.x, target.at.z);
          this.audio.triggerShopRegister(true, { x: target.at.x, y: fy, z: target.at.z });
        }
        return res;
      } catch (e) {
        return { ok: false, msg: e instanceof Error ? e.message : 'Payment could not be confirmed.' };
      } finally {
        this.paying = false;
      }
    }
    if (target.kind === 'spot' && normKey.startsWith('job:')) {
      const p = this.bodyNow(), spot = target.hotspot;
      if (!p || game.nav.walk.zone(p) !== spot.zone || Math.hypot(p.x - spot.stand.x, p.z - spot.stand.z) > 2.5 ||
          !game.options(target).some(o => o.key === normKey)) return { ok: false, msg: 'Approach the correct work station.' };
      const jobId = normKey.slice(4);
      const res = await game.runShift(jobId, spot.zone, spot.id, opts?.quality, saver);
      if (res.ok && game === this.game) {
        this.audio.triggerUiClick(res.shiftCompleted ? 'confirm' : 'tap');
        if (res.shiftCompleted) {
          const fy = this.groundYAt(spot.stand.x, spot.stand.z);
          this.audio.triggerActivityFoley('shift_complete', { x: spot.stand.x, y: fy, z: spot.stand.z });
          const skill = SHIFT_XP_SKILL[jobId];
          if (skill) {
            game.claims.push({ source: 'shift:' + jobId, uniques: [], credits: 0, xp: { [skill]: 24 }, spent: [] });
          }
        }
      }
      return res;
    }
    if (target.kind === 'spot' && target.hotspot.action === 'sport' && this.view?.basketball.needsRetrieval) {
      return { ok: false, msg: 'Walk to the ball and press E to collect it.' };
    }
    if (target.kind === 'spot' && target.hotspot.action === 'sleep') {
      const bed = this.findBedAt(target.at);
      if (bed) {
        if (!this.cb.sleep?.(bed, target.hotspot.stand)) return { ok: false, msg: 'Walk to the open side of the bed.' };
        return { ...game.act(target, normKey), settled: true };
      }
      if (target.hotspot.anchored === 'bed-single') {
        return { ok: false, msg: 'Walk to the open side of the bed.' };
      }
    }
    if (
      target.kind === 'seat' ||
      (target.kind === 'spot' && (normKey === 'sit' || ['sit', 'rest'].includes(target.hotspot.action)))
    ) {
      const refPos = this.bodyNow() ?? target.at;
      const isOccupied = (seatCand: import('@/lib/echo-life/game/people').Seat) =>
        [...game.people.walkers.values()].some((w) => w.seat === seatCand || w.targetSeat === seatCand);
      const candidates =
        target.kind === 'seat'
          ? game.people.seats.filter((s) => s.id === target.id && !isOccupied(s))
          : game.people.seats
              .filter(
                (s) =>
                  s.zone === target.hotspot.zone &&
                  Math.hypot(s.sit.x - target.at.x, s.sit.z - target.at.z) < 2.4 &&
                  !isOccupied(s),
              )
              .sort(
                (a, b) =>
                  Math.hypot(a.sit.x - refPos.x, a.sit.z - refPos.z) -
                  Math.hypot(b.sit.x - refPos.x, b.sit.z - refPos.z),
              );
      let seat: import('@/lib/echo-life/game/people').Seat | null = null;
      for (const cand of candidates) {
        if (this.cb.sit?.(cand)) {
          seat = cand;
          break;
        }
      }
      if (!seat) return { ok: false, msg: 'This seat is occupied or its approach is blocked.' };
      game.people.playerSeat = seat.id;
      this.audio.triggerSeat(true, 'wood', { x: seat.sit.x, y: seat.sit.y, z: seat.sit.z });
      const result =
        target.kind === 'spot' && (normKey !== 'sit' || ['sit', 'rest'].includes(target.hotspot.action))
          ? game.act(target, normKey)
          : { ok: true, msg: 'Seated.' };
      return { ...result, settled: true };
    }
    if (target.kind === 'npc') {
      const res = game.act(target, normKey);
      if (res.ok) {
        const kind = normKey.startsWith('gift:') ? 'gift' : (normKey.startsWith('invite') || normKey.startsWith('activity')) ? 'activity' : 'talk';
        game.people.notifyPlayerInteraction(game.s, target.id, kind, normKey);
      }
      return res;
    }
    if (target.kind !== 'spot' || !['checkout', 'bistro_order', 'bistro_snack'].includes(target.hotspot.action)) {
      const res = game.act(target, normKey);
      if (res.ok && target.kind === 'spot') {
        const act = target.hotspot.action;
        const fy = this.groundYAt(target.at.x, target.at.z);
        const atPos = { x: target.at.x, y: fy, z: target.at.z };
        if (normKey === 'take_shower' || normKey === 'toggle_shower' || act === 'shower') {
          this.audio.triggerActivityFoley('garden_water', atPos);
          this.showerVfx?.setActive('bath', Boolean(game.showerWaterOn), game.showeringActive ? 1.0 : 0.85);
        } else if (normKey === 'watch_tv' || normKey === 'tv_off' || act === 'tv') {
          this.audio.triggerUiClick('tap');
          this.world?.setTvActive(game.isTvOn);
        } else if (act === 'coffee' || act === 'espresso' || act === 'use_appliance') this.audio.triggerActivityFoley('espresso', atPos);
        else if (act === 'tea' || act === 'tea_ceremony' || normKey === 'brew_home_tea') this.audio.triggerActivityFoley('tea_pour', atPos);
        else if (act === 'study' || act === 'read' || act === 'library_study' || act === 'residence_study') this.audio.triggerActivityFoley('book_page', atPos);
        else if (act === 'garden' || act === 'water' || act === 'garden_tend' || act === 'garden_harvest') this.audio.triggerActivityFoley('garden_water', atPos);
        else if (act === 'music' || act === 'busk' || act === 'guitar' || act === 'music_jam') {
          this.audio.triggerActivityFoley('guitar_chord', atPos);
          game.people.notifyBuskerPerformance(game.s, target.at.x, target.at.z, target.hotspot.zone);
        }
      }
      return res;
    }
    this.paying = true;
    try {
      await saver.report(game.claims.splice(0));
      if (game !== this.game) return { ok: false, msg: 'Reopen the register in your current game.' };
      game.setNpcSimSnapshot(game.people.exportNpcSimSnapshot());
      const purchase = game.marketCheckout(target, normKey);
      if (!purchase) return { ok: false, msg: 'Return to the counter.' };
      if (!purchase.result.ok) return purchase.result;
      const wallet = await saver.checkout(purchase.doc, purchase.batch);
      if (game === this.game) {
        Object.assign(game.s, purchase.draft);
        game.applyWallet(wallet);
        const fy = this.groundYAt(target.at.x, target.at.z);
        this.audio.triggerShopRegister(true, { x: target.at.x, y: fy, z: target.at.z });
      }
      return purchase.result;
    } catch (e) {
      return { ok: false, msg: e instanceof Error ? e.message : 'Payment could not be confirmed.' };
    } finally {
      this.paying = false;
    }
  }

  // ── Wave 11 Stage 2 Host Action API (HUD, Echo Phone, Cooking, Careers, Manage City, Photo, Multiplayer) ──

  /** Sets live simulation time scale (`0` Pause, `1` Normal, `2` Fast, `3` Ultra). */
  setTimeScale(scale: TimeScale): TimeScale {
    const clamped = (scale === 0 || scale === 1 || scale === 2 || scale === 3 ? scale : 1) as TimeScale;
    this.envControl.clockSpeed = clamped;
    const next = this.game ? this.game.setTimeScale(clamped) : clamped;
    this.audio.triggerUiClick('tap');
    this.publishHud(true);
    return next;
  }

  /** Runs a 7-phase embodied cooking sequence at the kitchen stove before committing the recipe. */
  async cookRecipe(recipeId: string, opts?: { immediate?: boolean }): Promise<V3Result> {
    const game = this.game;
    if (!game) return { ok: false, msg: 'World session is not ready.' };
    const body = this.bodyNow();
    const stove = game.hotspots.find((h) => h.action === 'cook') ?? null;
    const at = stove?.at ?? body ?? { x: 0, z: 0 };
    const stand = stove?.stand ?? at;
    const target: Target = stove
      ? {
          kind: 'spot',
          hotspot: stove,
          entity: { id: stove.id, action: 'cook', x: stove.local.x, z: stove.local.z, model: stove.model },
          label: 'Cook home meal',
          at,
          dist: body ? Math.hypot(at.x - body.x, at.z - body.z) : 0,
        }
      : {
          kind: 'spot',
          hotspot: {
            key: 'home:stove',
            zone: 'kitchen',
            id: 'stove',
            action: 'cook',
            model: 'stove',
            kind: 'prop',
            at,
            stand,
            local: { x: 0, z: 0 },
            anchored: 'stove',
          },
          entity: { id: 'stove', action: 'cook', x: 0, z: 0, model: 'stove' },
          label: 'Cook home meal',
          at,
          dist: 0,
        };
    return this.act(target, 'cook:' + recipeId, opts);
  }

  /** Runs a 7-phase embodied Willow Bistro order sequence and commits server-authoritative checkout. */
  async orderBistroItem(sku: string, opts?: { immediate?: boolean }): Promise<V3Result> {
    const game = this.game;
    if (!game) return { ok: false, msg: 'World session is not ready.' };
    if (!BISTRO_SKU_SET.has(sku)) return { ok: false, msg: 'Menu item is not available at Willow Corner Bistro.' };
    const body = this.bodyNow();
    const counter = game.hotspots.find((h) => h.action === 'bistro_order' || h.action === 'bistro_snack') ?? null;
    const at = counter?.at ?? body ?? { x: 0, z: 0 };
    const stand = counter?.stand ?? at;
    const target: Target = counter
      ? {
          kind: 'spot',
          hotspot: counter,
          entity: { id: counter.id, action: counter.action, x: counter.local.x, z: counter.local.z, model: counter.model },
          label: 'Order at Willow Corner Bistro',
          at,
          dist: body ? Math.hypot(at.x - body.x, at.z - body.z) : 0,
        }
      : {
          kind: 'spot',
          hotspot: {
            key: 'bistro:counter',
            zone: 'bistro',
            id: 'bistro_counter',
            action: 'bistro_order',
            model: 'bistro_counter',
            kind: 'prop',
            at,
            stand,
            local: { x: 0, z: 0 },
            anchored: 'bistro_counter',
          },
          entity: { id: 'bistro_counter', action: 'bistro_order', x: 0, z: 0, model: 'bistro_counter' },
          label: 'Order at Willow Corner Bistro',
          at,
          dist: 0,
        };
    return this.act(target, 'bistro_order:' + sku, opts);
  }

  sendPhoneMessage(npcId: ResidentId, text: string) {
    if (!this.game) return { ok: false, reply: null, msg: 'World session is not ready.' };
    const res = this.game.sendPhoneMessage(npcId, text);
    if (res.ok) this.audio.triggerUiClick('tap');
    this.publishHud(true);
    return res;
  }

  inviteNpcHangout(npcId: ResidentId, venue: HangoutVenue) {
    if (!this.game) return { ok: false, accepted: false, meetupPlan: null, msg: 'World session is not ready.' };
    const res = this.game.inviteNpcHangout(npcId, venue);
    this.audio.triggerUiClick(res.accepted ? 'confirm' : 'tap');
    this.publishHud(true);
    return res;
  }

  likeFeedPost(id: string) {
    if (!this.game) return null;
    const res = this.game.likeFeedPost(id);
    this.audio.triggerUiClick('tap');
    this.publishHud(true);
    return res;
  }

  replyFeedPost(id: string, text: string) {
    if (!this.game) return null;
    const res = this.game.replyFeedPost(id, text);
    if (res.ok) this.audio.triggerUiClick('tap');
    this.publishHud(true);
    return res;
  }

  createFeedPost(caption: string, tag: FeedMilestoneTag = 'daily_note') {
    if (!this.game) return { ok: false, post: null };
    const res = this.game.createFeedPost(caption, tag);
    if (res.ok) this.audio.triggerUiClick('confirm');
    this.publishHud(true);
    return res;
  }

  enrollFullTimeCareer(id: FullTimeCareerId): V3Result {
    if (!this.game) return { ok: false, msg: 'World session is not ready.' };
    const res = this.game.enrollFullTimeCareer(id);
    if (res.ok) this.audio.triggerUiClick('confirm');
    this.publishHud(true);
    return res;
  }

  resolveDilemma(choiceIdx: number, dilemmaId?: string): DilemmaResolutionResult | null {
    if (!this.game) return null;
    const res = this.game.resolveWorkplaceDilemmaByIndex(choiceIdx, dilemmaId);
    if (res.ok) this.audio.triggerUiClick('confirm');
    this.publishHud(true);
    return res;
  }

  completeFullTimeWorkday() {
    if (!this.game) return null;
    const res = this.game.completeFullTimeWorkday();
    if (res.ok) this.audio.triggerUiClick('confirm');
    this.publishHud(true);
    return res;
  }

  /** Runs embodied timetable gesture (unless `immediate`), charges fare, advances clock, and smoothly transitions player to arrival stop. */
  async rideBusShuttle(stopId: BusStopId, opts?: { immediate?: boolean }): Promise<BusTripPlan | null> {
    const game = this.game;
    if (!game) return null;
    const body = this.bodyNow();
    let planResult: BusTripPlan | null = null;
    const commitTrip = async (): Promise<V3Result> => {
      const plan = game.rideBusShuttle(stopId);
      planResult = plan;
      if (plan.ok && plan.to) {
        const y = game.nav.walk.groundAt(plan.to.arrival.x, plan.to.arrival.z) ?? 0;
        this.cb.teleport?.({ x: plan.to.arrival.x, y, z: plan.to.arrival.z }, plan.to.yaw);
        if (typeof window !== 'undefined') {
          try {
            window.dispatchEvent(new CustomEvent('echo-life:bus-arrive', { detail: plan }));
          } catch {
            /* headless fallback */
          }
        }
        this.audio.triggerUiClick('confirm');
      }
      return { ok: plan.ok, msg: plan.reason };
    };

    const groundY = body ? this.groundYAt(body.x, body.z, (body as { y?: number }).y ?? 0) : 0;
    const bodyPos3 = body ? { x: body.x, y: groundY, z: body.z } : null;
    const spec = !opts?.immediate && this.activeNow
      ? classifyEmbodiedAction(null, 'bus_stop:' + stopId, bodyPos3)
      : null;

    if (spec) {
      await this.embodied.start(spec, commitTrip, {
        bodyPos: bodyPos3,
        bodyYaw: this.yaw,
      });
    } else {
      await commitTrip();
    }
    this.publishHud(true);
    return planResult;
  }

  /** Updates Manage City controls (pedestrian density, traffic density, billboard headline/theme, cleanliness, city karma) live. */
  updateManageCity(patch: Partial<ManageCityConfig>): ManageCityConfig | null {
    if (!this.game) return null;
    const next = this.game.updateManageCity(patch);
    this.workshop?.setBillboardConfig?.(next.billboardHeadline, next.billboardTheme);
    if (next.trafficDensity !== undefined) {
      this.workshop?.setTrafficDensity(next.trafficDensity);
      this.game.setTrafficDensity(next.trafficDensity);
    }
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('echo-life:city-config', { detail: next }));
      } catch {
        /* headless fallback */
      }
    }
    this.audio.triggerUiClick('tap');
    this.publishHud(true);
    return next;
  }

  /** Captures and persists a Photo Studio album entry with spatial shutter foley and Photography sub-skill XP. */
  addPhotoAlbumEntry(entry: Omit<PhonePhotoMeta, 'id' | 'thumbKey'> & { dataUrlThumb?: string }) {
    if (!this.game) return null;
    const body = this.bodyNow();
    const eyeY = body ? this.groundYAt(body.x, body.z) + 1.4 : 1.4;
    this.audio.triggerActivityFoley('shutter', body ? { x: body.x, y: eyeY, z: body.z } : undefined);
    const res = this.game.addPhotoAlbumEntry(entry);
    this.publishHud(true);
    return res;
  }

  /** Broadcasts a server-allowlisted multiplayer quick chat (`StudyWorldPresence.QUICK_CHATS`) over STOMP presence. */
  sendMultiplayerQuickChat(id: string): boolean {
    if (!MULTIPLAYER_QUICK_CHAT_SET.has(id)) return false;
    const qcId = id as MultiplayerQuickChatId;
    const city = this.cityPresence as SharedCityExt | null;
    city?.sendQuickChat?.(qcId);
    if (this.game) {
      this.game.say(`Quick chat: "${MULTIPLAYER_QUICK_CHAT_LABELS[qcId]}"`, 'info');
    }
    this.audio.triggerUiClick('tap');
    this.publishHud(true);
    return true;
  }

  /** Broadcasts a server-allowlisted multiplayer emote (`StudyWorldPresence.EMOTES`) over STOMP presence. */
  sendMultiplayerEmote(id: string): boolean {
    if (!MULTIPLAYER_EMOTE_SET.has(id)) return false;
    const emoteId = id as MultiplayerEmoteId;
    const city = this.cityPresence as SharedCityExt | null;
    if (city?.sendEmote) city.sendEmote(emoteId);
    else city?.express(emoteId);
    this.audio.triggerUiClick('tap');
    this.publishHud(true);
    return true;
  }

  /** Applies one of the 4 curated 1-click Room Style and Layout Presets from `build.ts` via server workshop configure. */
  async applyRoomPreset(presetId: string): Promise<{ ok: boolean; msg: string; preset: RoomStylePreset | null }> {
    const preset = getRoomStylePreset(presetId);
    if (!preset) return { ok: false, msg: 'Room preset not found.', preset: null };
    const game = this.game, saver = this.saver;
    if (!game || !saver) return { ok: false, msg: 'World session is not ready.', preset };
    const actions = buildPresetWorkshopActions(game, preset.id);
    let lastMsg = `Applied ${preset.name} room style.`;
    let allOk = true;
    for (const action of actions) {
      const r = await saver.configure(action);
      if (!r.ok) {
        allOk = false;
        lastMsg = r.msg;
      }
    }
    if (allOk && game === this.game) {
      game.workshopEvent('style_room');
      this.audio.triggerUiClick('confirm');
      game.say(`Applied ${preset.name} (${preset.tagline}).`, 'good');
      this.publishHud(true);
    }
    return { ok: allOk, msg: lastMsg, preset };
  }

  /** Lists the 4 curated 1-click Room Style presets. */
  roomStylePresets(): readonly RoomStylePreset[] {
    return ROOM_STYLE_PRESETS;
  }

  /** Validates and stores a starter furniture relocation override inside `lifeMeta.starterFurniture`. */
  relocateStarterFurniture(
    id: string,
    pos: { x: number; y: number; z: number },
    rotY: number,
  ): { ok: boolean; reason: string; override: StarterFurnitureOverride | null } {
    const game = this.game, world = this.world;
    if (!game || !world) return { ok: false, reason: 'World session is not ready.', override: null };
    const zoneId = world.walk.zone(pos) ?? game.s.player.zone ?? 'living';
    const check = validateBuildPlacement(zoneId, pos.x, pos.z, rotY, { width: 1.0, depth: 0.8 }, { walk: world.walk });
    if (!check.ok) return { ok: false, reason: check.reason, override: null };
    const override: StarterFurnitureOverride = {
      id,
      zone: zoneId,
      x: check.x,
      y: pos.y,
      z: check.z,
      rotY,
    };
    game.setStarterFurnitureOverride(id, override);
    this.audio.triggerUiClick('confirm');
    this.publishHud(true);
    return { ok: true, reason: 'Starter furniture position updated.', override };
  }

  /** Builds 4 to 8 contextual 100% English radial wheel actions for `ActionWheel.tsx` based on live focus, zone, and needs. */
  getContextualRadialActions(): RadialActionItem[] {
    const game = this.game;
    if (!game) return [];
    const items: RadialActionItem[] = [];
    const f = this.focus;
    const zone = game.s.player.zone;
    const homeZones = new Set(['living', 'kitchen', 'bedroom', 'bathroom', 'study', 'yard']);

    if (f) {
      const opts = game.options(f);
      const primary = opts[0];
      if (primary) {
        items.push({
          id: `focus:${primary.key}`,
          label: primary.label,
          category: f.kind === 'npc' ? 'social' : primary.kind === 'work' ? 'work' : 'interact',
          enabled: true,
          target: f,
          actionKey: primary.key,
          hint: f.kind === 'npc' ? f.name : undefined,
        });
      }
    }

    if (zone === 'kitchen') {
      const cookable = game.cookableRecipes().find((r) => r.eligibility.ok);
      items.push({
        id: 'home:cook',
        label: cookable ? `Cook ${cookable.recipe.name}` : 'Cook Home Meal',
        category: 'home',
        enabled: !!cookable,
        recipeId: cookable?.recipe.id,
        hint: cookable ? `${cookable.recipe.prepSeconds}s` : 'Need groceries',
      });
    } else if (zone === 'bistro') {
      const special = BISTRO_MENU[0];
      items.push({
        id: `bistro:${special.id}`,
        label: `Order ${special.name} (${special.price} CC)`,
        category: 'city',
        enabled: game.s.progression.economy.credits >= special.price,
        bistroSku: special.id,
      });
    } else if (homeZones.has(zone)) {
      items.push({
        id: 'panel:build',
        label: 'Build and Decorate',
        category: 'home',
        enabled: true,
        panel: 'build',
      });
    }

    const activeShift = game.activeShiftTarget();
    if (activeShift) {
      items.push({
        id: `work:${activeShift.job}`,
        label: `Shift: ${activeShift.title}`,
        category: 'work',
        enabled: true,
        hint: `Step ${activeShift.step}/${activeShift.total}`,
        panel: 'career',
      });
    }

    items.push({
      id: 'panel:phone',
      label: 'Open Echo Phone',
      category: 'phone',
      enabled: true,
      panel: 'phone',
    });

    items.push({
      id: 'panel:photo',
      label: 'Photo Studio',
      category: 'photo',
      enabled: true,
      panel: 'photo',
    });

    if (!homeZones.has(zone)) {
      const stops = game.busStops();
      const nextStop = stops.find((st) => st.zone !== zone) ?? stops[0];
      if (nextStop) {
        items.push({
          id: `transit:${nextStop.id}`,
          label: `Shuttle to ${nextStop.name}`,
          category: 'transit',
          enabled: true,
          stopId: nextStop.id,
          hint: game.phoneStateSnapshot().hasStudentPass ? 'Free pass' : '5 CC',
        });
      }
    }

    items.push({
      id: 'emote:wave',
      label: 'Wave Greeting',
      category: 'social',
      enabled: true,
      emoteId: 'wave',
    });

    items.push({
      id: 'panel:city',
      label: 'Manage City',
      category: 'city',
      enabled: true,
      panel: 'city',
    });

    return items.slice(0, 8);
  }

  private buildAim: ReturnType<typeof aimPlacement> | null = null;

  beginBuild(id: string) {
    this.building = id;
    this.buildYaw = this.game?.s.progression.ownedObjects.find(o => o.instanceId === id)?.placement.yaw ?? 0;
    this.buildAim = null; this.buildMessage = '';
  }

  cancelBuild() { if (!this.buildBusy) { this.building = null; this.buildAim = null; this.buildMessage = ''; } }

  async placeBuild() {
    if (!this.game || !this.saver || !this.building || !this.world || !this.eye?.body || this.buildBusy) return;
    const g = this.game, aim = aimPlacement(g, this.world.walk, this.building, this.eye.body, this.yaw, this.buildYaw);
    if (!aim.action) { this.buildMessage = aim.reason; return; }
    this.buildBusy = true;
    try {
      const r = await this.saver.configure(aim.action);
      if (g !== this.game) return;
      this.buildMessage = r.msg;
      if (r.ok) { this.building = null; g.workshopEvent('place_object'); this.audio.triggerUiClick('confirm'); }
    } finally { this.buildBusy = false; }
  }

  private saver: GameSaver | null = null;
  private world: EchoLifeWorld | null = null;
  private worker: Worker | null = null;
  private navReady = false;
  private navRevision = 0;
  private navData: { size: number; nodes: number; keys: Float64Array; ok: Uint8Array } | null = null;
  private hudClock = 0;
  private saveClock = 0;
  private size = 0;
  private lastEnding: string | null = null;
  private eye: { camera: T.Camera; width: number; height: number; body: { x: number; z: number } | null } | null = null;
  get saverNow() { return this.saver; }
  private yaw = 0;

  /** Riding speed multiplier on starter bike, or subtle low-energy fatigue feel (`0.84x` only when energy < 15). */
  get speedFactor() {
    if (!this.game) return 1;
    if (this.game.riding) return RIDE_FACTOR;
    return this.game.needsSummary().speedFactor;
  }

  /** The learner's body on the ground plane (last frame). */
  bodyNow() { return this.eye?.body ?? null; }

  /** Nearby standing residents, traffic and parked vehicles (including 6 curb cars) as obstacles for `LifeWalk` (cached per frame, zero steady-state allocations). */
  playerObstacles(body: { x: number; z: number } | null): readonly { x: number; z: number; r: number }[] {
    if (!this.game || !body) return [];
    if (
      this.obstacleCacheFrameId === this.obstacleFrameId &&
      Math.hypot(body.x - this.obstacleCacheX, body.z - this.obstacleCacheZ) <= 0.75
    ) {
      return this.obstacleCacheList;
    }

    const out = this.obstacleCacheList;
    out.length = 0;
    let poolIdx = 0;
    const pushObs = (x: number, z: number, r: number) => {
      let item = this.obstacleCachePool[poolIdx];
      if (!item) {
        item = { x: 0, z: 0, r: 0 };
        this.obstacleCachePool.push(item);
      }
      item.x = x;
      item.z = z;
      item.r = r;
      out.push(item);
      poolIdx++;
    };

    const peopleObs = this.game.people.playerObstacles(body);
    for (let i = 0; i < peopleObs.length; i++) {
      pushObs(peopleObs[i].x, peopleObs[i].z, peopleObs[i].r);
    }
    for (const bike of this.game.traffic) {
      if (Math.hypot(bike.pose.x - body.x, bike.pose.z - body.z) < 3.75) {
        pushObs(bike.pose.x, bike.pose.z, 0.5);
      }
    }
    // Parked player car & two-wheeler solid footprints so player on foot walks around parked vehicles cleanly
    // while never self-trapping a rider who just dismounted or stands inside the outer ring (`dist < r + 0.24`).
    const car = this.game.car;
    if (!car.driving && car.spec) {
      const r = Math.min(1.15, Math.max(0.75, (car.spec.collisionRadius ?? 1.05) * 0.85));
      const dCar = Math.hypot(car.pose.x - body.x, car.pose.z - body.z);
      if (dCar >= r + 0.24 && dCar < 5.25) {
        pushObs(car.pose.x, car.pose.z, r);
      }
    }
    const tw = this.game.twoWheeler;
    if (!tw.driving && tw.spec) {
      const dTw = Math.hypot(tw.pose.x - body.x, tw.pose.z - body.z);
      if (dTw >= 0.79 && dTw < 3.75) {
        pushObs(tw.pose.x, tw.pose.z, 0.55);
      }
    }
    const curbBoxes = this.workshop?.parkedCurbBoxes?.();
    if (curbBoxes) {
      for (let i = 0; i < curbBoxes.length; i++) {
        const b = curbBoxes[i];
        const cx = (b.x0 + b.x1) * 0.5;
        const cz = (b.z0 + b.z1) * 0.5;
        const hx = Math.abs(b.x1 - b.x0) * 0.5;
        const hz = Math.abs(b.z1 - b.z0) * 0.5;
        if (Math.hypot(cx - body.x, cz - body.z) < 5.75) {
          pushObs(cx, cz, Math.max(0.85, Math.min(1.4, Math.max(hx, hz) * 0.6)));
        }
      }
    }

    this.obstacleCacheFrameId = this.obstacleFrameId;
    this.obstacleCacheX = body.x;
    this.obstacleCacheZ = body.z;
    return out;
  }

  /** Yaw-oriented Rapier solid footprints for parked player vehicles and 6 parked curb cars (zero-alloc steady-state reuse). */
  parkedVehicleBoxes(world: EchoLifeWorld): readonly OrientedSolidBox[] {
    const out = this.parkedBoxesCache;
    out.length = 0;
    const game = this.game;
    if (!game) return out;
    const carFp = game.car.getFootprint();
    if (carFp && !carFp.driving) {
      const floor = world.walk.groundAt(carFp.x, carFp.z) ?? 0;
      out.push({ x: carFp.x, y: floor + 0.72, z: carFp.z, hx: carFp.halfWidth, hy: 0.72, hz: carFp.halfLength, yaw: carFp.yaw });
    }
    const twFp = game.twoWheeler.getFootprint();
    if (twFp && !twFp.driving) {
      const floor = world.walk.groundAt(twFp.x, twFp.z) ?? 0;
      out.push({ x: twFp.x, y: floor + 0.55, z: twFp.z, hx: twFp.halfWidth, hy: 0.55, hz: twFp.halfLength, yaw: twFp.yaw });
    }
    const curbBoxes = this.workshop?.parkedCurbBoxes?.();
    if (curbBoxes) {
      for (let i = 0; i < curbBoxes.length; i++) {
        const b = curbBoxes[i];
        const floor = world.walk.groundAt(b.x, b.z) ?? 0;
        out.push({ x: b.x, y: floor + b.hy, z: b.z, hx: b.hx, hy: b.hy, hz: b.hz, yaw: b.yaw });
      }
    }
    return out;
  }

  constructor(private readonly stage: T.Object3D, private quality: GameViewQuality,
    private readonly cb: {
      sleep?: (bed: Furnishing, approach: { x: number; z: number }) => boolean;
      sit?: (seat: import('@/lib/echo-life/game/people').Seat) => boolean;
      walkTo?: (pos: { x: number; y?: number; z: number }, yaw?: number) => void;
      teleport?: (pos: { x: number; y: number; z: number }, yaw: number) => void;
      onHud?: (hud: GameHud | null) => void;
      onInteract?: (t: Target) => void;
      onDrive?: (kind: 'car' | 'twoWheeler') => boolean;
      handsBusy?: () => boolean;
      peerLabels?: (camera: T.Camera, width: number, height: number) => Label[] | undefined;
      onSaveError?: () => void;
      sharedBikePrompt?: () => string | null;
      court?: () => SharedCourt | undefined;
      sharedCity?: () => import('./sharedCity').SharedCityPresence | null;
      windowOpen?: () => boolean;
      driveCamera?: () => 'chase' | 'hood' | 'cockpit';
      cameraPitch?: () => number;
      homeCleanliness?: () => number;
    }) {
    this.embodied = new CityEmbodiedActions(this.stage, this.audio);
    this.ensureShowerVfx();
    this.bindVehicleKeys();
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || !this.activeNow || !this.game || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (this.game.people.talking || this.building || this.game.s.challenge) return;
    const el = document.activeElement as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
    if (typeof document !== 'undefined' && document.querySelector('[data-testid="echo-life-dialog"], [data-testid^="echo-life-panel-"]')) return;

    const driven = this.activeDrivenVehicle;
    // When driving with canvas/pointerLock focused, `Exploration` is the single canonical owner of
    // driving hotkeys (`L`, `H`, `[`, `]`, `Q`, `Z`), eliminating double-step headlights & self-cancelling blinkers!
    const canvasOwnsDriving =
      Boolean(driven) &&
      typeof document !== 'undefined' &&
      (document.pointerLockElement != null || el?.tagName === 'CANVAS');
    if (canvasOwnsDriving) return;

    if (e.code === 'KeyH') {
      if (driven || this.game.riding) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.soundVehicleHorn();
      }
      return;
    }
    if (!driven) return;
    if (e.code === 'KeyL') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.toggleHeadlights();
    } else if (e.code === 'KeyQ' || e.code === 'BracketLeft') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.setBlinker(-1);
    } else if (e.code === 'BracketRight' || e.code === 'KeyZ') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.setBlinker(1);
    }
  };

  private bindVehicleKeys() {
    if (this.keysBound || typeof window === 'undefined') return;
    this.keysBound = true;
    window.addEventListener('keydown', this.onKeyDown);
  }

  private unbindVehicleKeys() {
    if (!this.keysBound || typeof window === 'undefined') return;
    this.keysBound = false;
    window.removeEventListener('keydown', this.onKeyDown);
  }

  get cityPresence() { return this.cb.sharedCity?.() ?? null; }

  /** Live 4-tier quality control (`low` | `balanced` | `high` | `ultra`). */
  setQuality(tier: GameViewQuality) {
    this.quality = tier;
    this.view?.setQuality(tier);
  }

  get worldRegion() { return this.world?.stats.region; }

  private serializeWithNpcSim() {
    const game = this.game;
    if (!game) return null;
    game.setNpcSimSnapshot(game.people.exportNpcSimSnapshot());
    return game.serialize();
  }

  async inviteToEvent(id: string) {
    const city = this.cityPresence, game = this.game, saver = this.saver;
    if (!city?.connected || !game || !saver) throw new Error('offline');
    saver.schedule(() => this.serializeWithNpcSim(), 0);
    await saver.flush();
    if (city !== this.cityPresence || game !== this.game) throw new Error('session changed');
    await city.inviteToEvent(id);
  }

  courtAction(action: CourtAction) {
    if (action !== 'leave' && (this.cb.handsBusy?.() || this.building || this.game?.drivenVehicle || this.game?.riding)) return false;
    return this.cb.court?.()?.act(action) ?? false;
  }

  setSaver(saver: GameSaver | null) {
    if (saver === this.saver) return;
    this.flush();
    this.detachSaver();
    this.saver = saver;
    this.drop();
    if (saver) {
      saver.onWallet = w => {
        this.game?.applyWallet(w);
        if (this.game && !this.game.riding && this.sharedOrStarterBikeCtrl?.driving) {
          this.sharedOrStarterBikeCtrl.dismountImmediate();
          if (this.sharedBikeGroup) {
            delete this.sharedBikeGroup.userData.__ecExternalRigSynced;
          }
          this.wasGameRiding = false;
          this.wasGameRidingShared = false;
        }
      };
      saver.onNewer = doc => {
        // Another tab played on: take its newer story (never overwrite it with this tab's older one).
        if (!this.world) return;
        this.drop();
        this.create(this.world, doc);
      };
      saver.onRefused = (key, why) => { if (why !== 'ALREADY_CLAIMED') console.info('[echo-life] reward not granted', key, why); };
    }
  }

  private detachSaver() {
    if (!this.saver) return;
    this.saver.onWallet = null;
    this.saver.onNewer = null;
    this.saver.onRefused = null;
    this.saver = null;
  }

  private releaseVehicleRigs() {
    if (this.carVisualRig) {
      disposeVehicleVisualRig(this.carVisualRig);
      this.carVisualRig = null;
    }
    this.carRigSource = null;
    if (this.twoWheelerVisualRig) {
      disposeVehicleVisualRig(this.twoWheelerVisualRig);
      this.twoWheelerVisualRig = null;
    }
    this.twoWheelerRigSource = null;
  }

  private getDoorsCached(world: EchoLifeWorld): ReturnType<EchoLifeWorld['doors']> {
    const ver = world.doorsPassableVersion;
    if (this.cachedDoorsWorld !== world || this.cachedDoorsVersion !== ver) {
      this.cachedDoorsWorld = world;
      this.cachedDoorsVersion = ver;
      this.cachedDoorsList = world.doors();
    }
    return this.cachedDoorsList;
  }

  private ensureCachedZones(world: EchoLifeWorld): void {
    if (this.cachedZonesWorld === world) return;
    this.cachedZonesWorld = world;
    const fz = world.city.zones.find(z => z.id === 'fountain_plaza');
    if (fz) {
      const fx = (fz.rect.x0 + fz.rect.x1) * 0.5;
      const fzMid = (fz.rect.z0 + fz.rect.z1) * 0.5;
      this.cachedFountainCenter = {
        x: fx,
        y: (world.walk.groundAt(fx, fzMid) ?? 0) + 1.0,
        z: fzMid,
      };
    } else {
      this.cachedFountainCenter = null;
    }
    const gw = world.city.zones.find(z => z.id === 'greenway');
    this.cachedGreenwayRect = gw ? { ...gw.rect } : null;
  }

  private drop() {
    this.embodied.cancel('Session ended.');
    this.clearPlayerRiderBinding();
    if (this.sharedBikeGroup) {
      delete this.sharedBikeGroup.userData.__ecExternalRigSynced;
    }
    this.sharedBikeGroup = null;
    this.sharedBikePayload = null;
    this.sharedBikeSockets = null;
    this.sharedBikeLastState = null;
    this.sharedBikeYawSeeded = false;
    this.sharedBikeCtrl.dismountImmediate();
    this.starterBikeCtrl.dismountImmediate();
    this.starterBikeLastState = null;
    this.sharedOrStarterBikeCtrl?.dismountImmediate();
    this.sharedOrStarterBikeCtrl = null;
    this.obstacleCacheFrameId = -1;
    this.wasGameRiding = false;
    this.wasGameRidingShared = false;
    this.showerVfx?.clearEmitters();
    if (this.showerVfx) this.showerVfx.group.visible = false;
    this.showerEmitterRegisteredWorld = null;
    getEchoLifePlanarMirrors().setZoneSteamLevel('bath', 0);
    this.hiddenDoorPrevAngle.clear();
    this.parkedCurbCrowdPool.length = 0;
    this.releaseVehicleRigs();
    this.tirePool?.dispose(); this.tirePool = null;
    this.workshop?.dispose(); this.workshop = null; this.building = null; this.buildAim = null;
    this.view?.dispose(); this.view = null;
    this.game = null; this.focus = null; this.eye = null;
    this.lastHud = null;
    this.prevChallengeType = null;
    this.prevBasketballSig = '';
    this.prevEmbodiedSig = '';
    this.prevFocusSig = '';
    this.prevPlayerSeat = null;
    this.lastDailyEnv = undefined;
    this.lastBodyPos = null;
    this.smoothedBodySpeed = 0;
    this.lastBasketScore = 0;
    this.cachedDoorsWorld = null;
    this.cachedDoorsVersion = -1;
    this.cachedDoorsList = [];
    this.cachedZonesWorld = null;
    this.cachedFountainCenter = null;
    this.cachedGreenwayRect = null;
    this.cb.onHud?.(null);
  }

  private create(world: EchoLifeWorld, doc = this.saver?.doc ?? null) {
    const saver = this.saver;
    if (!saver) return;
    const port = { door: (id: string) => world.door(id) };
    let game: EchoLifeGame;
    try { game = new EchoLifeGame(world.plan, world.city, saver.owner, port, doc, world.walk); }
    catch (error) {
      if (!(error instanceof UnreadableGameSave)) throw error;
      saver.preserveUnreadableSave();
      this.cb.onSaveError?.();
      return;
    }
    this.game = game;
    if (saver.wallet) game.applyWallet(saver.wallet);
    this.sharedOrStarterBikeCtrl = createSharedOrStarterBicycleController(
      game.nav.walk,
      'veh_bike_basket',
      'shared_or_starter_bike',
    );
    if (game.riding && !game.twoWheeler.driving) {
      this.sharedOrStarterBikeCtrl.mountAt(
        { x: game.bike.x, z: game.bike.z, yaw: game.bike.yaw },
        0,
      );
      this.wasGameRiding = true;
      this.wasGameRidingShared = Boolean(game.ridingShared);
    } else {
      this.wasGameRiding = false;
      this.wasGameRidingShared = false;
    }
    this.ensureBathShowerEmitter(world, game);
    world.setTvActive(game.isTvOn);
    // Explicitly hydrate autonomous NPC minds + pairwise affinity deltas from saved worldV3.npcSim.
    game.people.hydrateNpcSimSnapshot(game.s);

    // Feed live weather, occupied seats, Manage City pedestrian density, resident kinematics & active traffic into zero-allocation crowd simulation.
    game.crowd = (avoid) => {
      const sky = this.sky();
      const cal = sky ? getCalendar(sky.minute) : game.calendar;
      const rain = sky ? sky.rain > 0.1 : game.weather.rain;
      const snow = sky ? sky.snow > 0.1 : false;
      this.crowdCtx.occupiedSeats = game.people.occupiedSeatIds();
      this.crowdCtx.rainIntensity = sky ? sky.rain : (game.weather.rain ? 0.75 : 0);
      this.crowdCtx.snowIntensity = sky ? sky.snow : 0;
      this.crowdCtx.phase = cal.phase;
      this.crowdCtx.dt = this.lastFrameDt;
      this.crowdCtx.timeScale = game.timeScale;
      this.crowdCtx.residents = game.people.getResidentKinematics();
      this.crowdCtx.vehicles = game.trafficSim.activeHazards;
      this.crowdCtx.densityApplied = true;
      const densityScale = Math.max(0.3, Math.min(1.5, game.phoneStateSnapshot().cityConfig.pedestrianDensity ?? 1));
      const count = Math.max(4, Math.round(crowdDensity(cal.phase, rain, snow) * densityScale));
      return crowdAt(
        game.lanes,
        sky ? sky.minute : game.s.clock,
        count,
        avoid,
        p => game.nav.walk.free(p),
        this.crowdCtx,
      );
    };

    this.view = new GameView(this.quality);
    this.stage.add(this.view.group);
    this.tirePool = new TireParticlePool(this.view.group);
    this.workshop = new WorkshopView(world, this.view.group);
    const cityCfg = game.phoneStateSnapshot().cityConfig;
    this.workshop.setBillboardConfig?.(cityCfg.billboardHeadline, cityCfg.billboardTheme);
    const initTrafficDensity = cityCfg.trafficDensity ?? 0.9;
    this.workshop.setTrafficDensity(initTrafficDensity);
    game.setTrafficDensity(initTrafficDensity);

    // Register all 6 static roadside curb-parked cars ONCE into `TrafficSim` & `PeopleSim` so `game.tick()` never clobbers them!
    const curbBoxes = this.workshop.parkedCurbBoxes();
    this.parkedCurbCrowdPool.length = 0;
    if (curbBoxes.length > 0) {
      game.registerCurbBoxes(curbBoxes);
      for (let i = 0; i < curbBoxes.length; i++) {
        const b = curbBoxes[i];
        this.parkedCurbCrowdPool.push({
          x: b.x,
          z: b.z,
          yaw: b.yaw,
          halfWidth: b.hx,
          halfLength: b.hz,
          radius: Math.hypot(b.hx, b.hz),
        });
      }
    }

    this.navReady = false;
    this.navRevision = game.nav.furnitureRevision;
    this.lastBasketScore = this.view.basketball.score;
    if (this.navData && this.navData.size === world.size && game.nav.importEdges(this.navData)) this.navReady = true;
    else this.proveNav(world.size);
  }

  private proveNav(size: number) {
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    const nav = this.game?.nav;
    if (typeof Worker === 'undefined' || !nav) return;
    const revision = nav.furnitureRevision;
    try {
      const w = new Worker(new URL('../../../../lib/echo-life/game/nav.worker.ts', import.meta.url), { type: 'module', name: 'echo-life-nav' });
      this.worker = w;
      w.onmessage = (e: MessageEvent<{ size: number; nodes: number; keys: Float64Array; ok: Uint8Array }>) => {
        if (revision === 0) this.navData = e.data;
        if (this.worker === w && this.game?.nav === nav && e.data.size === this.size)
          this.navReady = nav.importEdges(e.data, revision);
        w.terminate(); if (this.worker === w) this.worker = null;
      };
      w.onerror = () => { w.terminate(); if (this.worker === w) this.worker = null; };
      w.postMessage({ size, furniture: nav.walk.furniture });
    } catch { this.worker = null; }
  }

  private syncVehicleVisualRigs(
    game: EchoLifeGame,
    view: GameView,
    dt: number,
    envLights: EnvironmentLightConditions,
    camera: T.Camera,
    reduced: boolean,
  ) {
    // 1. Player Automobile: upgrade GLB to Vehicles 2.0 clearcoat PBR + `extractVehicleRig` sockets + instanced wheels
    const rawCar = view.carRig?.gltf.scene ?? null;
    if (rawCar !== this.carRigSource) {
      if (this.carVisualRig) {
        disposeVehicleVisualRig(this.carVisualRig);
        this.carVisualRig = null;
      }
      this.carRigSource = rawCar;
      if (rawCar && game.car.spec) {
        stripTransmissionFromHierarchy(rawCar);
        const [, track, length] = game.car.axles;
        this.carVisualRig = upgradeAndOptimizeVehicleRig(rawCar, {
          twoWheels: false,
          track,
          length,
          modelId: game.car.spec.model,
        });
        if (view.carRig) {
          view.carRig.paint.length = 0;
          if (this.carVisualRig.sockets) {
            view.carRig.sockets = this.carVisualRig.sockets;
            view.carRig.wheels = [...this.carVisualRig.sockets.wheelPivots];
            view.carRig.steer = [...this.carVisualRig.sockets.steerPivots];
          }
        }
      }
    }
    if (this.carVisualRig && game.car.spec) {
      updateVehicleVisualRig(this.carVisualRig, game.car, game.nav.walk, dt, envLights, this.tirePool, reduced);
    }

    // 2. Player Two-Wheeler: upgrade active scooter/motorbike/bicycle rig directly from `view.twoWheelerRig` (0 distance miss!)
    const rawTwoWheeler = game.twoWheeler.spec ? (view.twoWheelerRig?.gltf.scene ?? null) : null;
    if (rawTwoWheeler !== this.twoWheelerRigSource) {
      if (this.twoWheelerVisualRig) {
        disposeVehicleVisualRig(this.twoWheelerVisualRig);
        this.twoWheelerVisualRig = null;
      }
      this.twoWheelerRigSource = rawTwoWheeler;
      if (rawTwoWheeler && game.twoWheeler.spec) {
        stripTransmissionFromHierarchy(rawTwoWheeler);
        const [, track, length] = game.twoWheeler.axles;
        this.twoWheelerVisualRig = upgradeAndOptimizeVehicleRig(rawTwoWheeler, {
          twoWheels: true,
          track,
          length,
          modelId: game.twoWheeler.spec.model,
        });
        if (view.twoWheelerRig) {
          view.twoWheelerRig.paint.length = 0;
          if (this.twoWheelerVisualRig.sockets) {
            view.twoWheelerRig.sockets = this.twoWheelerVisualRig.sockets;
            view.twoWheelerRig.wheels = [...this.twoWheelerVisualRig.sockets.wheelPivots];
            view.twoWheelerRig.steer = [...this.twoWheelerVisualRig.sockets.steerPivots];
          }
        }
      }
    }
    if (this.twoWheelerVisualRig && game.twoWheeler.spec) {
      updateVehicleVisualRig(this.twoWheelerVisualRig, game.twoWheeler, game.nav.walk, dt, envLights, this.tirePool, reduced);
    }

    this.tirePool?.update(dt, camera, reduced);
  }

  /**
   * Advances spring animations on any `LifeDoor` whose building interior/enclosure group is currently hidden
   * (e.g. player outdoors while an NPC opens/closes a building door), preventing `d.passable === false` deadlocks!
   * Zero allocations in steady state (`d.hinge()` is only queried on hidden doors actively mid-swing).
   */
  private stepHiddenDoorSprings(world: EchoLifeWorld, dt: number, reduced: boolean): void {
    const doors = this.getDoorsCached(world);
    for (let i = 0; i < doors.length; i++) {
      const d = doors[i];
      const curAngle = d.angle;
      const wantOpen = d.isOpen;
      const settled = wantOpen ? Math.abs(curAngle) >= 1.31 : Math.abs(curAngle) <= 0.005;
      if (settled) {
        this.hiddenDoorPrevAngle.set(d.id, curAngle);
        continue;
      }
      const prevAngle = this.hiddenDoorPrevAngle.get(d.id);
      if (prevAngle !== undefined && Math.abs(curAngle - prevAngle) < 1e-6) {
        const targetAngle = wantOpen ? d.hinge().open : 0;
        const rate = wantOpen ? 8.5 : 7.0;
        const nextAngle = reduced ? targetAngle : curAngle + (targetAngle - curAngle) * (1 - Math.exp(-rate * dt));
        const snapped = Math.abs(targetAngle - nextAngle) < 0.008 ? targetAngle : nextAngle;
        d.setAngle(snapped);
        d.setOpen(wantOpen);
      }
      this.hiddenDoorPrevAngle.set(d.id, d.angle);
    }
  }

  /**
   * Keeps `this.sharedOrStarterBikeCtrl` synchronized across `game.mount`, `game.dismount`,
   * `applyWallet` (`riding -> twoWheeler.driving`), `consumeAutoDismount`, and shared-bike lease changes.
   */
  private syncRidingBicycleController(
    game: EchoLifeGame,
    p: { x: number; z: number } | null,
    fallbackYaw: number,
  ): void {
    if (!this.sharedOrStarterBikeCtrl) {
      this.sharedOrStarterBikeCtrl = createSharedOrStarterBicycleController(
        game.nav.walk,
        'veh_bike_basket',
        'shared_or_starter_bike',
      );
    }
    const ctrl = this.sharedOrStarterBikeCtrl;
    if (game.twoWheeler.driving && !game.riding) {
      if (ctrl.driving) ctrl.dismountImmediate();
      if (this.sharedBikeGroup) {
        delete this.sharedBikeGroup.userData.__ecExternalRigSynced;
      }
      this.wasGameRiding = false;
      this.wasGameRidingShared = false;
      return;
    }
    if (game.riding) {
      if (this.wasGameRiding && !ctrl.driving) {
        this.dismountActiveVehicle(p ?? { x: ctrl.pose.x, z: ctrl.pose.z }, ctrl.pose.yaw);
        return;
      }
      if (!this.wasGameRiding || this.wasGameRidingShared !== Boolean(game.ridingShared) || !ctrl.driving) {
        const startPose =
          game.ridingShared && this.sharedBikeGroup
            ? {
                x: this.sharedBikeGroup.position.x,
                z: this.sharedBikeGroup.position.z,
                yaw: this.sharedBikeGroup.rotation.y,
              }
            : game.ridingShared && p
              ? { x: p.x, z: p.z, yaw: fallbackYaw }
              : { x: game.bike.x, z: game.bike.z, yaw: game.bike.yaw };
        ctrl.mountAt(startPose, 0);
        this.wasGameRiding = true;
        this.wasGameRidingShared = Boolean(game.ridingShared);
      }
      if (!game.ridingShared) {
        game.bike.x = ctrl.pose.x;
        game.bike.z = ctrl.pose.z;
        game.bike.yaw = ctrl.pose.yaw;
      }
    } else if (this.wasGameRiding) {
      if (!this.wasGameRidingShared && ctrl.driving) {
        game.bike.x = ctrl.pose.x;
        game.bike.z = ctrl.pose.z;
        game.bike.yaw = ctrl.pose.yaw;
      }
      ctrl.dismountImmediate();
      if (this.sharedBikeGroup) {
        delete this.sharedBikeGroup.userData.__ecExternalRigSynced;
      }
      this.wasGameRiding = false;
      this.wasGameRidingShared = false;
    }
  }

  /**
   * Synchronizes the shared multiplayer room bicycle (`echo-life-room-bicycle` in `SharedCityPresence.group`)
   * with `extractVehicleRig` + `RiderIkController` + `applyVehicleRigKinematics` so `game.ridingShared`
   * enjoys identical closed-loop handlebar/pedal/saddle `RiderIk` (`E5-03.3`).
   */
  private syncSharedRoomBicycle(
    dt: number,
    game: EchoLifeGame,
    world: EchoLifeWorld,
    player: { x: number; z: number } | null,
    riderYaw: number,
  ): boolean {
    const cityGroup = this.cityPresence?.group ?? null;
    if (!cityGroup) {
      if (this.sharedBikeGroup) {
        delete this.sharedBikeGroup.userData.__ecExternalRigSynced;
      }
      this.sharedBikeGroup = null;
      this.sharedBikePayload = null;
      this.sharedBikeSockets = null;
      this.sharedBikeLastState = null;
      return false;
    }
    if (!this.sharedBikeGroup || this.sharedBikeGroup.parent !== cityGroup) {
      this.sharedBikeGroup = cityGroup.getObjectByName('echo-life-room-bicycle') ?? null;
    }
    const activeSharedRide = Boolean(game.riding && game.ridingShared);
    if (this.sharedBikeGroup) {
      if (activeSharedRide) {
        this.sharedBikeGroup.userData.__ecExternalRigSynced = true;
      } else {
        delete this.sharedBikeGroup.userData.__ecExternalRigSynced;
      }
    }
    const payload = this.sharedBikeGroup?.children[0] ?? null;
    if (payload !== this.sharedBikePayload) {
      this.sharedBikePayload = payload;
      this.sharedBikeSockets =
        this.sharedBikeGroup && payload ? extractVehicleRig(this.sharedBikeGroup, 'veh_bike_basket') : null;
    }
    if (!this.sharedBikeGroup || !this.sharedBikeSockets || !this.sharedBikeGroup.visible) {
      return false;
    }

    const ctrl = activeSharedRide && this.sharedOrStarterBikeCtrl?.driving ? this.sharedOrStarterBikeCtrl : null;
    const bx = ctrl ? ctrl.pose.x : activeSharedRide && player ? player.x : this.sharedBikeGroup.position.x;
    const bz = ctrl ? ctrl.pose.z : activeSharedRide && player ? player.z : this.sharedBikeGroup.position.z;
    const yaw = ctrl ? ctrl.pose.yaw : activeSharedRide ? riderYaw : this.sharedBikeGroup.rotation.y;
    const groundStageY = world.walk.groundAt(bx, bz) ?? 0;

    let yawRate = 0;
    if (this.sharedBikeYawSeeded && dt > 1e-4) {
      let dy = yaw - this.prevSharedBikeYaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      yawRate = dy / dt;
    }
    this.prevSharedBikeYaw = yaw;
    this.sharedBikeYawSeeded = true;

    const effSpeed = ctrl ? ctrl.speed : activeSharedRide ? this.smoothedBodySpeed : 0;
    if (activeSharedRide && this.sharedBikeCtrl.phase === 'unmounted') {
      this.sharedBikeCtrl.mountImmediate(effSpeed, 1);
    } else if (!activeSharedRide && (this.sharedBikeCtrl.phase === 'riding' || this.sharedBikeCtrl.phase === 'mounting')) {
      this.sharedBikeCtrl.dismountImmediate();
    }

    const steer = ctrl
      ? ctrl.steer
      : activeSharedRide && effSpeed > 0.15
        ? T.MathUtils.clamp(Math.atan((this.sharedBikeSockets.wheelbase * yawRate) / Math.max(0.8, effSpeed)), -0.58, 0.58)
        : 0;
    this.sharedBikeWorldVec.set(bx, groundStageY, bz);
    cityGroup.localToWorld(this.sharedBikeWorldVec);

    this.sharedBikeStepScratch.speed = effSpeed;
    this.sharedBikeStepScratch.maxSpeed = ctrl?.spec?.maxSpeed ?? 7.6;
    this.sharedBikeStepScratch.throttle = ctrl ? ctrl.lastThrottle : (activeSharedRide && effSpeed > 0.12 ? 0.7 : 0);
    this.sharedBikeStepScratch.steer = steer;
    this.sharedBikeStepScratch.brake = ctrl ? ctrl.lights.braking : false;
    this.sharedBikeStepScratch.isCoasting = ctrl ? ctrl.coasting : !activeSharedRide || effSpeed <= 0.12;
    this.sharedBikeStepScratch.externalCrankAngle = ctrl ? ctrl.dynamics.crankAngle : undefined;
    this.sharedBikeStepScratch.externalCrankOmega = ctrl ? (ctrl.coasting ? 0 : ctrl.pedalCadence) : undefined;
    this.sharedBikeStepScratch.externalLean = ctrl ? ctrl.lean : undefined;
    this.sharedBikeStepScratch.externalForkDive = ctrl ? ctrl.forkDive : undefined;
    this.sharedBikeStepScratch.groundY = this.sharedBikeWorldVec.y;

    const state = this.sharedBikeCtrl.step(Math.max(0, dt), this.sharedBikeSockets, this.sharedBikeStepScratch);
    this.sharedBikeLastState = state;

    const stStage = this.sharedBikeStageStateScratch;
    stStage.speed = state.speed;
    stStage.maxSpeed = state.maxSpeed;
    stStage.steer = state.steer;
    stStage.lean = state.lean;
    stStage.forkDive = state.forkDive;
    stStage.crankAngle = state.crankAngle;
    stStage.crankOmega = state.crankOmega;
    stStage.standDownBlend = state.standDownBlend;
    stStage.mountBlend = state.mountBlend;
    stStage.armIkWeight = state.armIkWeight;
    stStage.kickstandRetract = state.kickstandRetract;
    stStage.doorOpenBlend = state.doorOpenBlend;
    stStage.groundY = groundStageY;
    stStage.standSideSign = state.standSideSign;

    this.sharedBikePoseScratch.x = bx;
    this.sharedBikePoseScratch.z = bz;
    this.sharedBikePoseScratch.yaw = yaw;
    applyVehicleRigKinematics(
      this.sharedBikeGroup,
      this.sharedBikeSockets,
      stStage,
      this.sharedBikePoseScratch,
      ctrl ? ctrl.spin : this.sharedBikeCtrl.wheelSpin,
    );
    return true;
  }

  /** One frame of the game while the learner explores the built world. */
  update(dt: number, world: EchoLifeWorld | null, active: boolean, body: T.Vector3 | null, yaw: number, camera: T.Camera,
    width: number, height: number, reduced: boolean, bodyYaw: number, handRight?: T.Vector3 | null) {
    this.activeNow = active && !!world?.ready;
    if (this.paying) return;
    if (!world || !world.ready || !active || !this.saver?.loaded) {
      if (this.view) this.view.group.visible = false;
      if (this.showerVfx) this.showerVfx.group.visible = false;
      this.focus = null;
      this.embodied.cancel('World paused.');
      this.audio.update({
        dt,
        active: false,
        pos: null,
        cameraYaw: yaw,
        region: null,
        zone: null,
        indoor: true,
        hour: 12,
        rain: 0,
        riverRect: null,
        vehicle: null,
      });
      return;
    }
    if (world !== this.world || !this.game) {
      const doc = this.game ? this.serializeWithNpcSim() : this.saver.doc;
      this.drop();
      this.world = world; this.size = world.size;
      this.create(world, doc);
    }
    if (!this.game || !this.view) return;
    const game = this.game!, view = this.view!;
    this.obstacleFrameId = (this.obstacleFrameId + 1) & 0x7fffffff;
    view.group.visible = true;
    if (this.showerVfx) this.showerVfx.group.visible = true;
    this.lastFrameDt = dt;
    const p = body ? { x: body.x, z: body.z } : null;
    const p3 = body ? { x: body.x, y: this.groundYAt(body.x, body.z, body.y), z: body.z } : null;

    // Advance hidden building door springs so NPC door unlatches never stall at `passable === false` (#71).
    this.stepHiddenDoorSprings(world, dt, reduced);

    // Advance active 7-phase embodied city/home interaction sequence (cancels cleanly on WASD movement).
    this.embodied.update(dt, p3);

    // Track real body movement velocity for ride speedometer & exertion detection
    if (p && this.lastBodyPos && dt > 1e-4) {
      const instSpeed = Math.hypot(p.x - this.lastBodyPos.x, p.z - this.lastBodyPos.z) / dt;
      if (instSpeed < 24) {
        this.smoothedBodySpeed += (instSpeed - this.smoothedBodySpeed) * (1 - Math.exp(-8 * dt));
      }
    } else if (!p) {
      this.smoothedBodySpeed = 0;
    }
    this.lastBodyPos = p ? { x: p.x, z: p.z } : null;

    if (game.nav.furnitureRevision !== this.navRevision) {
      this.navRevision = game.nav.furnitureRevision;
      this.navReady = false;
      this.proveNav(world.size);
    }
    // Without a worker the graph is proved on the page, a few milliseconds a frame.
    if (!this.navReady && !this.worker) this.navReady = game.nav.warm(3);

    const curSky = this.sky()!;
    // Keep NPC schedules, shop open hours, and V3 events synced to shared-world clock when connected.
    if (this.cityPresence?.connected && Math.abs(game.s.clock - curSky.minute) > 0.5) {
      game.s.clock = curSky.minute;
    }
    const cal = getCalendar(curSky.minute);
    const envLights: EnvironmentLightConditions = { dayWeight: curSky.day, rainWeight: curSky.rain, snowWeight: curSky.snow };

    // 1. Feed live weather/season/time into autonomous 22-resident AI (`people.setEnv`)
    const weatherId: EnvSnapshot['weatherId'] =
      curSky.snow > 0.1 ? 'snowy'
      : curSky.rain > 0.8 ? 'heavy_rain'
      : curSky.rain > 0.1 ? 'light_rain'
      : curSky.cloud > 0.78 ? 'overcast'
      : curSky.cloud > 0.45 ? 'cloudy'
      : (cal.phase === 'evening' || curSky.goldenHour > 0.25) ? 'golden_breeze'
      : 'sunny';
    game.people.setEnv({
      weatherId,
      rainIntensity: curSky.rain,
      snowIntensity: curSky.snow,
      season: curSky.season as 0 | 1 | 2 | 3,
      hour: curSky.hour,
      phase: cal.phase as EnvSnapshot['phase'],
      isWeekend: cal.isWeekend,
    });

    // 2. Synchronize player bicycle controller & feed live player vehicle state into `people` + ambient `crowd`
    if (this.wasTwoWheelerDriving && !game.twoWheeler.driving && game.twoWheeler.lastDismountPos) {
      const exit = game.twoWheeler.lastDismountPos;
      if (!p || Math.hypot(p.x - game.twoWheeler.pose.x, p.z - game.twoWheeler.pose.z) < 0.88) {
        this.cb.teleport?.({ x: exit.x, y: this.groundYAt(exit.x, exit.z), z: exit.z }, game.twoWheeler.pose.yaw);
      }
    }
    if (this.wasCarDriving && !game.car.driving && game.car.lastDismountPos) {
      const exit = game.car.lastDismountPos;
      if (!p || Math.hypot(p.x - game.car.pose.x, p.z - game.car.pose.z) < 1.35) {
        this.cb.teleport?.({ x: exit.x, y: this.groundYAt(exit.x, exit.z), z: exit.z }, game.car.pose.yaw);
      }
    }
    this.wasTwoWheelerDriving = game.twoWheeler.driving;
    this.wasCarDriving = game.car.driving;
    this.syncRidingBicycleController(game, p, bodyYaw);
    const driven = this.activeDrivenVehicle;
    if (driven) {
      const vx = Math.sin(driven.pose.yaw) * driven.speed;
      const vz = Math.cos(driven.pose.yaw) * driven.speed;
      const kind = game.car.driving ? 'car' : driven instanceof TwoWheeler && driven.powered ? 'motorbike' : 'bike';
      game.people.setPlayerVehicle({
        kind,
        name: driven.spec?.name ?? (kind === 'bike' ? 'Campus Bicycle' : 'Vehicle'),
        speed: driven.speed,
        x: driven.pose.x,
        z: driven.pose.z,
        vx,
        vz,
      });
      this.crowdHazard.x = driven.pose.x;
      this.crowdHazard.z = driven.pose.z;
      this.crowdHazard.vx = vx;
      this.crowdHazard.vz = vz;
      this.crowdHazard.speed = Math.abs(driven.speed);
      this.crowdHazard.radius = driven.spec?.collisionRadius ?? (game.car.driving ? 1.2 : 0.65);
      this.crowdHazard.hornActive = driven.lights.hornActive;
      this.crowdCtx.vehicle = this.crowdHazard;
    } else if (game.riding && p) {
      const vx = Math.sin(bodyYaw) * this.smoothedBodySpeed;
      const vz = Math.cos(bodyYaw) * this.smoothedBodySpeed;
      game.people.setPlayerVehicle({
        kind: 'bike',
        name: 'Campus Bicycle',
        speed: this.smoothedBodySpeed,
        x: p.x,
        z: p.z,
        vx,
        vz,
      });
      this.crowdHazard.x = p.x;
      this.crowdHazard.z = p.z;
      this.crowdHazard.vx = vx;
      this.crowdHazard.vz = vz;
      this.crowdHazard.speed = this.smoothedBodySpeed;
      this.crowdHazard.radius = 0.65;
      this.crowdHazard.hornActive = false;
      this.crowdCtx.vehicle = this.crowdHazard;
    } else {
      game.people.setPlayerVehicle(null);
      this.crowdCtx.vehicle = null;
    }

    // Feed parked vehicle footprints into ambient crowd & residents (`staticCurbVehicles` are preserved via `registerCurbBoxes`!).
    this.parkedPeopleCache.length = 0;
    this.parkedCrowdCache.length = 0;
    const carFp = game.car.getFootprint();
    if (carFp && !carFp.driving) {
      this.parkedPeopleCache.push(carFp);
      this.parkedCrowdCache.push(carFp);
    }
    const twFp = game.twoWheeler.getFootprint();
    if (twFp && !twFp.driving) {
      this.parkedPeopleCache.push(twFp);
      this.parkedCrowdCache.push(twFp);
    }
    for (let i = 0; i < this.parkedCurbCrowdPool.length; i++) {
      this.parkedCrowdCache.push(this.parkedCurbCrowdPool[i]);
    }
    const stoppedTraffic = game.trafficSim.stoppedFootprints;
    for (let i = 0; i < stoppedTraffic.length; i++) {
      this.parkedCrowdCache.push(stoppedTraffic[i]);
    }
    game.people.setParkedVehicles(this.parkedPeopleCache);
    this.crowdCtx.parkedVehicles = this.parkedCrowdCache;

    // 3. Keep parked vehicle suspension & environment lighting smoothly synchronized
    game.car.updateEnvironmentLights(envLights, dt);
    game.twoWheeler.updateEnvironmentLights(envLights, dt);
    this.sharedOrStarterBikeCtrl?.updateEnvironmentLights(envLights, dt);
    if (!game.car.driving && game.car.spec) game.car.stepIdle(dt, envLights);
    if (!game.twoWheeler.driving && game.twoWheeler.spec) game.twoWheeler.stepIdle(dt, envLights);

    // 4. Advance simulation tick (exertion, seated recovery, daily events, autonomous residents & TrafficSim)
    const dailyEnv: DailyEnvContext = {
      seasonIndex: curSky.season,
      rain: curSky.rain > 0.1,
      snow: curSky.snow > 0.1,
      weatherLabel: curSky.weather.label,
      minuteOverride: curSky.minute,
      bestBasketStreak: Math.max(game.bestBasketStreak, view.basketball.bestStreak),
    };
    const isSeated = !!game.people.playerSeat;
    const isRunning = !isSeated && !game.riding && !driven && this.smoothedBodySpeed > 2.2;
    const clockMult = this.envControl.clockSpeed === 1 ? 1 : this.envControl.clockSpeed / Math.max(1, game.timeScale || 1);
    const bikeCtrl = game.riding && this.sharedOrStarterBikeCtrl?.driving ? this.sharedOrStarterBikeCtrl : null;
    const tickBody = bikeCtrl ? { x: bikeCtrl.pose.x, z: bikeCtrl.pose.z } : p;
    game.tick(dt * clockMult, tickBody, {
      routeBudget: this.navReady ? 2 : 0,
      running: isRunning,
      seated: isSeated,
      env: dailyEnv,
      sharedMinute: this.cityPresence?.connected ? curSky.minute : undefined,
      cleanliness: this.cb.homeCleanliness?.(),
    });
    if (clockMult === 0 && dt > 0) {
      game.tickShower(dt, p);
    }
    if (game.riding && !game.ridingShared && this.sharedOrStarterBikeCtrl?.driving) {
      game.bike.x = this.sharedOrStarterBikeCtrl.pose.x;
      game.bike.z = this.sharedOrStarterBikeCtrl.pose.z;
      game.bike.yaw = this.sharedOrStarterBikeCtrl.pose.yaw;
    } else if (this.wasGameRiding && !game.riding) {
      this.syncRidingBicycleController(game, p, bodyYaw);
    }

    // Drive walk-in shower water VFX, bathroom mirror condensation, and Living Room TV screen state
    this.ensureBathShowerEmitter(world, game);
    this.showerVfx?.setActive('bath', Boolean(game.showerWaterOn), game.showeringActive ? 1.0 : 0.85);
    this.showerVfx?.update(dt, reduced);
    getEchoLifePlanarMirrors().setZoneSteamLevel('bath', this.showerVfx?.getSteamLevel('bath') ?? 0);
    world.setTvActive(game.isTvOn);

    const rawFocus = p && !game.people.talking ? game.focus(p, yaw) : null;
    this.focus =
      game.people.playerSeat &&
      rawFocus &&
      (rawFocus.kind === 'seat' || (rawFocus.kind === 'spot' && ['sit', 'rest', 'sleep'].includes(rawFocus.hotspot.action)))
        ? null
        : rawFocus;
    if (game.people.playerSeat && game.nearbyTargets.length > 0) {
      game.nearbyTargets = game.nearbyTargets.filter(
        t => t.kind !== 'seat' && !(t.kind === 'spot' && ['sit', 'rest', 'sleep'].includes(t.hotspot.action)),
      );
    }
    this.eye = { camera, width, height, body: p };
    this.yaw = yaw;

    // 5. Sync player vehicle rigs FIRST (`0` 1-frame rider IK lag!), then render residents, crowd & street traffic!
    const weatherWind = world.weatherUniforms?.uWindVec.value;
    this.viewEnv.snow = curSky.snow;
    this.viewEnv.season = curSky.season;
    this.viewEnv.windX = weatherWind ? weatherWind.x : 0.45;
    this.viewEnv.windZ = weatherWind ? weatherWind.y : 0.15;
    const sharedVisualOwned = this.syncSharedRoomBicycle(dt, game, world, p, bodyYaw);
    const starterCtrl =
      game.riding && !game.ridingShared && this.sharedOrStarterBikeCtrl?.driving
        ? this.sharedOrStarterBikeCtrl
        : null;
    const starterSyncPos = starterCtrl ? { x: starterCtrl.pose.x, z: starterCtrl.pose.z } : p;
    const starterSyncYaw = starterCtrl ? starterCtrl.pose.yaw : bodyYaw;
    const starterSyncSpeed = starterCtrl ? starterCtrl.speed : this.smoothedBodySpeed;
    view.syncPlayerVehicles(dt, game, game.nav.walk, starterSyncPos, starterSyncYaw, starterSyncSpeed, sharedVisualOwned);
    if (starterCtrl && view.starterBikeGroup?.visible && view.starterBikeSockets) {
      if (this.starterBikeCtrl.phase === 'unmounted') {
        this.starterBikeCtrl.mountImmediate(starterCtrl.speed, 1);
      }
      const groundStageY = world.walk.groundAt(starterCtrl.pose.x, starterCtrl.pose.z) ?? 0;
      this.riderWorldGroundVec.set(starterCtrl.pose.x, groundStageY, starterCtrl.pose.z);
      if (view.starterBikeGroup.parent) {
        view.starterBikeGroup.parent.updateWorldMatrix(true, false);
        view.starterBikeGroup.parent.localToWorld(this.riderWorldGroundVec);
      }
      const stepIn = this.starterBikeStepScratch;
      stepIn.speed = starterCtrl.speed;
      stepIn.maxSpeed = starterCtrl.spec?.maxSpeed ?? 7.6;
      stepIn.throttle = starterCtrl.lastThrottle;
      stepIn.steer = starterCtrl.steer;
      stepIn.brake = starterCtrl.lights.braking;
      stepIn.isCoasting = starterCtrl.coasting;
      stepIn.externalCrankAngle = starterCtrl.dynamics.crankAngle;
      stepIn.externalCrankOmega = starterCtrl.coasting ? 0 : starterCtrl.pedalCadence;
      stepIn.externalLean = starterCtrl.lean;
      stepIn.externalForkDive = starterCtrl.forkDive;
      stepIn.groundY = this.riderWorldGroundVec.y;
      const worldState = this.starterBikeCtrl.step(Math.max(0, dt), view.starterBikeSockets, stepIn);
      this.starterBikeLastState = worldState;

      const st = this.starterBikeRiderStateScratch;
      st.speed = worldState.speed;
      st.maxSpeed = worldState.maxSpeed;
      st.steer = worldState.steer;
      st.lean = worldState.lean;
      st.forkDive = worldState.forkDive;
      st.crankAngle = worldState.crankAngle;
      st.crankOmega = worldState.crankOmega;
      st.standDownBlend = worldState.standDownBlend;
      st.mountBlend = worldState.mountBlend;
      st.armIkWeight = worldState.armIkWeight;
      st.kickstandRetract = worldState.kickstandRetract;
      st.doorOpenBlend = worldState.doorOpenBlend;
      st.groundY = groundStageY;
      st.standSideSign = worldState.standSideSign;
      applyVehicleRigKinematics(
        view.starterBikeGroup,
        view.starterBikeSockets,
        st,
        starterCtrl.pose,
        starterCtrl.spin,
      );
    } else if (this.starterBikeCtrl.phase !== 'unmounted' || this.starterBikeLastState !== null) {
      this.starterBikeCtrl.dismountImmediate();
      this.starterBikeLastState = null;
    }
    this.syncVehicleVisualRigs(game, view, dt, envLights, camera, reduced);
    view.update(dt, game, game.nav.walk, p, this.focus, reduced, bodyYaw, curSky.rain > 0.1, camera, this.viewEnv, handRight ?? null);

    // Broadcast basketball scores to nearby spectators + play crisp net swish foley
    if (view.basketball.score > this.lastBasketScore) {
      this.lastBasketScore = view.basketball.score;
      const bp = p ?? view.basketball.poseState.ballWorld;
      game.people.notifyBasketballShot(bp.x, bp.z, true, view.basketball.streak);
      const isHighlight = view.basketball.lastShotResult === 'score_3' || view.basketball.lastShotResult === 'streak_bonus';
      this.audio.triggerBasketball('swish', isHighlight ? 1.0 : 0.8);
    }

    if (this.building && p && (this.hudClock + dt >= .2 || !this.buildAim)) {
      this.buildAim = aimPlacement(game, world.walk, this.building, p, yaw, this.buildYaw);
    }
    if (p) {
      this.workshop?.update(game, p, this.building, this.buildAim?.at);
      if (this.building && this.buildAim?.at) {
        this.workshop?.setPlacementGhost?.(
          this.building,
          this.buildAim.at,
          this.buildAim.at.yaw,
          !!this.buildAim.action,
        );
      } else {
        this.workshop?.setPlacementGhost?.(null);
      }
    }

    // 6. Update browser-native 3D HRTF + Convolver spatial environmental & Vehicles 2.0 audio soundscape
    const region = world.stats.region;
    const zoneNow = game.s.player.zone ?? null;
    const indoor = !region || !OUTDOOR_REGIONS.has(region);
    const windowOpen = Boolean(this.cb.windowOpen?.());

    // Nearest open exterior door coupling & portal world coordinate for directional outdoor bleed (cached, zero per-frame alloc)
    let doorOpen = false;
    let openDoorCoupling = 0;
    let openPortalPos: { x: number; y: number; z: number } | null = null;
    if (indoor && p) {
      let bestDist = 7.5;
      const doors = this.getDoorsCached(world);
      for (let i = 0; i < doors.length; i++) {
        const d = doors[i];
        if (!d.isOpen && Math.abs(d.angle) < 0.15) continue;
        const dist = Math.hypot(d.plan.x - p.x, d.plan.z - p.z);
        if (dist < bestDist) {
          bestDist = dist;
          doorOpen = true;
          openDoorCoupling = Math.max(0, Math.min(1, 1 - dist / 7.5));
          _audioPortal.x = d.plan.x;
          _audioPortal.y = d.plan.y + 1.1;
          _audioPortal.z = d.plan.z;
          openPortalPos = _audioPortal;
        }
      }
    }

    // Active resident count in current zone (scales cafe/bistro murmur naturally)
    const residentsInZone = zoneNow ? game.people.residentsInZone(zoneNow) : 0;

    // Nearest commuter bike for subtle Doppler pass-by
    let commuterPos: { x: number; y: number; z: number } | null = null;
    if (!indoor && p && game.traffic.length) {
      let bestD2 = 22 * 22;
      for (let i = 0; i < game.traffic.length; i++) {
        const tp = game.traffic[i].pose;
        const dx = tp.x - p.x;
        const dz = tp.z - p.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) {
          bestD2 = d2;
          _audioCommuter.x = tp.x;
          _audioCommuter.y = world.walk.groundAt(tp.x, tp.z) ?? 0;
          _audioCommuter.z = tp.z;
          commuterPos = _audioCommuter;
        }
      }
    }

    // Fountain plaza position for 3D cascading trickle (cached once per world, zero per-frame .find)
    this.ensureCachedZones(world);
    let fountainPos: { x: number; y: number; z: number } | null = null;
    const fc = this.cachedFountainCenter;
    if (fc && p && Math.hypot(fc.x - p.x, fc.z - p.z) < 34) {
      _audioFountain.x = fc.x;
      _audioFountain.y = fc.y;
      _audioFountain.z = fc.z;
      fountainPos = _audioFountain;
    }

    // 3D AudioListener forward/up orientation from live active camera
    camera.getWorldDirection(_audioFwd);
    _audioUp.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();

    // Vehicle collision bump & door latch/slam foley hooks
    if (game.car.doorToggleId !== this.lastCarDoorToggleId) {
      this.lastCarDoorToggleId = game.car.doorToggleId;
      this.audio.triggerVehicleDoor(game.car.lastDoorOpen, p ? { x: p.x, y: body?.y ?? 0, z: p.z } : undefined);
    }
    const impactImpulse = driven ? Math.max(driven.lastCollisionImpulse, driven.lastBumpImpulse) : 0;
    if (driven && impactImpulse > 0.14) {
      this.audio.triggerVehicleBump(impactImpulse, p ? { x: p.x, y: body?.y ?? 0, z: p.z } : undefined);
    }

    const carChassis = game.car.driving ? game.car.chassis : null;
    const throttleVal = driven ? driven.lastThrottle : 0;
    const audioVehicle = driven ? {
      kind: (game.car.driving ? 'car' : driven instanceof TwoWheeler && driven.powered ? 'motorbike' : 'bike') as 'car' | 'bike' | 'motorbike',
      carClass: game.car.driving ? (game.car.carClass ?? resolveVehicleCarClass(game.car.spec?.model)) : undefined,
      speed: driven.speed,
      throttle: throttleVal,
      braking: driven.lights.braking,
      driftIntensity: carChassis?.driftIntensity ?? 0,
      heaveVel: carChassis?.heaveVel ?? 0,
      coasting:
        driven instanceof TwoWheeler
          ? driven.coasting
          : Math.abs(driven.speed) > 0.5 && Math.abs(throttleVal) < 0.05 && !driven.lights.braking,
      blinkerLit: driven.lights.blinkerLit,
      cameraMode: this.cb.driveCamera?.() ?? 'chase',
      doorOpen: game.car.lastDoorOpen,
    } : game.riding ? {
      kind: 'bike' as const,
      speed: this.smoothedBodySpeed,
      throttle: this.smoothedBodySpeed > 0.4 ? 0.4 : 0,
      braking: false,
      coasting: this.smoothedBodySpeed > 0.6 && this.smoothedBodySpeed < 2.2,
    } : null;

    const roomAcousticType = resolveAcousticPreset(indoor, zoneNow, region);
    this.audio.update({
      dt,
      active: true,
      pos: p ? { x: p.x, y: body?.y ?? 0, z: p.z } : null,
      cameraYaw: yaw,
      cameraPitch: this.cb.cameraPitch?.() ?? 0,
      listenerForward: { x: _audioFwd.x, y: _audioFwd.y, z: _audioFwd.z },
      listenerUp: { x: _audioUp.x, y: _audioUp.y, z: _audioUp.z },
      region: region ?? null,
      zone: zoneNow,
      indoor,
      windowOpen,
      doorOpen,
      openDoorCoupling,
      openPortalPos,
      roomAcousticType,
      hour: curSky.hour,
      season: curSky.season,
      rain: curSky.rain,
      snow: curSky.snow,
      cloud: curSky.cloud,
      residentsInZone,
      riverRect: world.city.river,
      fountainPos,
      commuterPos,
      qualityTier: this.quality,
      vehicle: audioVehicle,
    });

    // 7. Server economy claims & debounced narrative + npcSim persistence
    if (game.claims.length) void this.saver.report(game.claims.splice(0));
    this.saveClock += dt;
    if (game.car.driving && Math.abs(game.car.speed) > 1.5 && this.saveClock > 3) {
      game.signal('rodeVehicle');
      // Riverside Road borders the Greenway. Its roadway is mapped as street while the waterfront path is greenway.
      const greenway = this.cachedGreenwayRect;
      if (greenway && p && p.x >= greenway.x0 && p.x <= greenway.x1) game.roadPractice();
    }
    if (game.dirty && this.saveClock > 8) {
      this.saveClock = 0;
      game.dirty = false;
      this.saver.schedule(() => this.serializeWithNpcSim(), 2000);
    }

    this.lastDailyEnv = dailyEnv;
    this.hudClock += dt;
    const curChallengeType = game.s.challenge?.type ?? null;
    const curBasketballSig = this.basketballSignature();
    const curEmbodiedSig = this.embodiedSignature();
    const curFocusSig = this.focusSignature();
    const curPlayerSeat = game.people.playerSeat;
    if (
      curChallengeType !== this.prevChallengeType ||
      curBasketballSig !== this.prevBasketballSig ||
      curEmbodiedSig !== this.prevEmbodiedSig ||
      curFocusSig !== this.prevFocusSig ||
      curPlayerSeat !== this.prevPlayerSeat ||
      this.hudClock >= .2 ||
      !this.lastHud
    ) {
      this.publishHud(true, dailyEnv, p);
    }
  }

  private embodiedSignature(): string {
    const e = this.embodied.snapshot();
    const g = this.game;
    const stateFlags = g ? `${g.showeringActive ? 1 : 0}|${g.showerWaterOn ? 1 : 0}|${g.isTvOn ? 1 : 0}` : '';
    return e ? `${e.actionId}|${e.phase}|${Math.round(e.progress * 20)}|${stateFlags}` : stateFlags;
  }

  private focusSignature(): string {
    const f = this.focus;
    const focusKey = f
      ? 'id' in f
        ? f.id
        : f.kind === 'spot'
          ? f.hotspot.key
          : `${f.at.x.toFixed(2)},${f.at.z.toFixed(2)}`
      : '';
    const focusPart = f
      ? `${f.kind}:${focusKey}:${f.kind === 'npc' ? f.name : f.label}`
      : '';
    const sharedBike = this.cb.sharedBikePrompt?.() ?? '';
    const g = this.game;
    const driveFlags = g ? `${g.drivenVehicle ? 1 : 0}:${g.riding ? 1 : 0}` : '';
    return `${focusPart}|${sharedBike}|${driveFlags}`;
  }

  private basketballSignature(): string {
    const ch = this.game?.s.challenge;
    const bb = this.view?.basketball;
    if (!bb) return ch?.type ?? '';
    return `${ch?.type ?? ''}|${bb.active ? 1 : 0}|${bb.continuousSession ? 1 : 0}|${bb.needsRetrieval ? 1 : 0}|${bb.score}|${bb.streak}`;
  }

  private buildBasketballHud(): GameHud['basketball'] {
    const game = this.game, view = this.view;
    if (!game || !view) return null;
    const ch = game.s.challenge;
    const bb = view.basketball;
    if (ch?.type !== 'sport' && !bb.active && !bb.continuousSession) return null;
    return {
      score: bb.score,
      streak: bb.streak,
      holding: (ch?.type === 'sport' || bb.continuousSession) && !bb.active,
      needsRetrieval: bb.needsRetrieval,
      bestStreak: Math.max(bb.bestStreak, game.bestBasketStreak),
      isThreePointRange: bb.isThreePointRange,
      lastShotPoints: bb.lastShotPoints,
      lastShotResult: bb.lastShotResult,
    };
  }

  private publishHud(force = false, dailyEnv?: DailyEnvContext, posOverride?: { x: number; z: number } | null) {
    if (!this.game || !this.view || !this.saver || !this.sky()) return;
    const curChallengeType = this.game.s.challenge?.type ?? null;
    const curBasketballSig = this.basketballSignature();
    const curEmbodiedSig = this.embodiedSignature();
    const curFocusSig = this.focusSignature();
    const curPlayerSeat = this.game.people.playerSeat;
    if (
      !force &&
      curChallengeType === this.prevChallengeType &&
      curBasketballSig === this.prevBasketballSig &&
      curEmbodiedSig === this.prevEmbodiedSig &&
      curFocusSig === this.prevFocusSig &&
      curPlayerSeat === this.prevPlayerSeat &&
      this.hudClock < .2 &&
      this.lastHud
    ) {
      return;
    }
    this.hudClock = 0;
    this.prevChallengeType = curChallengeType;
    this.prevBasketballSig = curBasketballSig;
    this.prevEmbodiedSig = curEmbodiedSig;
    this.prevFocusSig = curFocusSig;
    this.prevPlayerSeat = curPlayerSeat;
    const nextHud = this.buildHud(posOverride !== undefined ? posOverride : this.bodyNow(), dailyEnv ?? this.lastDailyEnv);
    this.lastHud = nextHud;
    this.cb.onHud?.(nextHud);
  }

  private buildHud(
    p: { x: number; z: number } | null,
    dailyEnv?: DailyEnvContext,
  ): GameHud {
    const game = this.game!, s = game.s, sky = this.sky()!, cal = getCalendar(sky.minute), step = game.tutorialStep, view = this.view!;
    const f = this.focus;
    const ending = s.worldV3.endingId;
    if (ending && ending !== this.lastEnding) this.lastEnding = ending;
    const ch = s.challenge;
    const st = game.people.stats, sv = this.saver!.stats;
    const sharedBike = this.cb.sharedBikePrompt?.();
    const rebound = p && view.basketball.near(p);
    const driven = this.activeDrivenVehicle;
    const veh: GameHud['vehicle'] = driven ? {
      name: driven.spec?.name ?? (game.riding ? 'Campus Bicycle' : 'Vehicle'),
      kmh: Math.round(Math.abs(driven.speed) * 3.6),
      gear: (driven.speed < -0.15 ? 'R' : Math.abs(driven.speed) < 0.15 ? 'P' : 'D') as 'D' | 'R' | 'P',
      kind: (game.car.driving ? 'car' : driven instanceof TwoWheeler && driven.powered ? 'motorbike' : 'bike') as 'car' | 'bike' | 'motorbike',
      headlightsOn: driven.lights.headlightsOn,
      headlightMode: driven.lights.headlightsMode,
      blinker: driven.lights.blinker,
      hornActive: driven.lights.hornActive,
      braking: driven.lights.braking,
      pedalCadence: driven instanceof TwoWheeler ? Math.round(driven.pedalCadence * 10) / 10 : undefined,
    } : game.riding ? {
      name: 'Campus Bicycle',
      kmh: Math.round(this.smoothedBodySpeed * 3.6),
      gear: (this.smoothedBodySpeed < 0.15 ? 'P' : 'D') as 'D' | 'R' | 'P',
      kind: 'bike' as const,
      pedalCadence: this.smoothedBodySpeed > 0.35 ? Math.round((this.smoothedBodySpeed / 2.2) * 10) / 10 : 0,
    } : null;
    const proj = game.hudSnapshot(dailyEnv);
    return {
      host: this, ready: true, navReady: this.navReady,
      time: `${String(cal.hour).padStart(2, '0')}:${String(cal.minute).padStart(2, '0')}`, weekday: cal.weekday, phase: cal.phase,
      weather: sky.weather.label, rain: sky.rain > .1,
      season: sky.seasonName, seasonIndex: sky.season,
      credits: s.progression.economy.credits, level: s.progression.playerLevel,
      zone: this.worldRegion?.startsWith('prop_') ? this.world!.regionName()!.en : game.zoneName(s.player.zone),
      court: this.cb.court?.()?.controls ?? null,
      vehicle: veh,
      basketball: this.buildBasketballHud(),
      focus: rebound
        ? { kind: 'spot', label: 'Collect the basketball' }
        : sharedBike
          ? { kind: 'spot', label: sharedBike }
          : game.drivenVehicle
            ? { kind: 'spot', label: 'W/S drive · A/D steer · Space brake · L lights · H horn · C cam · E park' }
            : game.riding
              ? { kind: 'spot', label: 'W/S ride · A/D steer · Space brake · H bell · C cam · E park' }
              : game.people.playerSeat
                ? (f && f.kind === 'npc'
                  ? { kind: 'npc', label: `Talk to ${f.name}`, name: f.name, role: CHARACTERS[f.id]?.role }
                  : { kind: 'spot', label: 'Stand up (Space / WASD)' })
                : f
                  ? (f.kind === 'npc'
                    ? { kind: 'npc', label: `Talk to ${f.name}`, name: f.name, role: CHARACTERS[f.id]?.role }
                    : { kind: 'spot', label: f.label })
                  : null,
      tutorial: step ? { id: step.id, title: step.title, goal: step.goalLabel, hint: step.desktopHint, index: step.index, total: TUTORIAL_STEPS.length } : null,
      feed: game.feed,
      labels: [],
      challenge: ch ? { type: ch.type, index: ch.index, length: ch.sequence.length, sequence: ch.sequence } : null,
      ending,
      needs: proj.needs,
      dailyEvents: proj.dailyEvents,
      activeShift: proj.activeShift,
      overheardBanter: game.people.overheardBanter,
      timeScale: proj.timeScale,
      needs8: proj.needs8,
      emotion: proj.emotion,
      urges: proj.urges,
      karma: proj.karma,
      subSkills: proj.subSkills,
      phone: proj.phone,
      fullTimeCareer: proj.fullTimeCareer,
      embodied: this.embodied.snapshot(),
      stats: { ...view.stats, walking: st.walking, routes: st.routes, doors: st.doorsOpened, scenes: st.scenes, tiers: st.tiers, saves: sv.saves, claims: sv.claims, granted: sv.granted, refused: sv.refused },
    };
  }

  /** Name tags of the residents near the eye, in canvas pixels (the page draws them every frame without React). */
  get lookDirection() { return this.yaw; }

  labelsNow(): Label[] {
    const e = this.eye, g = this.game, v = this.view;
    if (!e || !g || !v || !v.group.visible) return [];
    const labels = v.labels(g, g.nav.walk, e.camera, e.width, e.height, e.body, this.focus);
    // Surface unobtrusive overheard banter on the speaking resident's nameplate (never overlapping feed)
    const banter = g.people.overheardBanter;
    if (banter) {
      const target = labels.find(l => l.id === banter.speakerId);
      if (target && !target.scene) target.scene = `"${banter.text}"`;
    }
    const peers = this.cb.peerLabels?.(e.camera, e.width, e.height);
    return peers?.length ? [...peers, ...labels] : labels;
  }

  interactNearby(t: Target) {
    const g = this.game;
    if (!g || !g.nearbyTargets.some(n => {
      if (n.kind !== t.kind) return false;
      if (n.kind === 'spot' && t.kind === 'spot') return n.hotspot.key === t.hotspot.key;
      if ('id' in n && 'id' in t) return n.id === t.id;
      return true;
    })) return;
    if (this.cb.handsBusy?.() || this.building) return;
    this.focus = t; this.interact();
  }

  collectBasketball() {
    const p = this.bodyNow();
    const ok = !!p && !!this.view?.basketball.collect(p);
    if (ok) {
      this.audio.triggerBasketball('catch', 0.65);
      this.publishHud(true);
    }
    return ok;
  }

  summonBasketball() {
    const p = this.bodyNow();
    if (p && this.view) {
      this.view.basketball.summon(p);
      this.audio.triggerBasketball('catch', 0.55);
      this.publishHud(true);
    }
  }

  shootBasketball(power: number) {
    const p = this.bodyNow();
    if (p && this.game && this.view) {
      this.view.basketball.shoot(this.game, p, power);
      this.audio.triggerBasketball('shoot', Math.max(0.4, power));
      this.game.people.notifyBasketballShot(p.x, p.z, false, this.view.basketball.streak);
      this.publishHud(true);
    }
  }

  /** E: get off the bicycle, get on it, talk to the resident or use the thing in focus. False: nothing of the game in focus. */
  interact(): boolean {
    const g = this.game, b = this.eye?.body;
    const kind = g?.twoWheeler.driving ? 'twoWheeler' : g?.car.driving ? 'car' : this.focus?.kind;
    if (kind === 'car' || kind === 'twoWheeler') {
      if (!g || (!g[kind].driving && !this.view?.vehicleReady(kind, g[kind].spec?.model))) return false;
      return this.cb.onDrive?.(kind) ?? false;
    }
    if (g?.riding && b) {
      this.dismountActiveVehicle(b, this.yaw);
      return true;
    }
    if (g && b && this.focus?.kind === 'bike') {
      const res = g.mount(b);
      if (res.ok) {
        this.sharedOrStarterBikeCtrl?.mountAt({ x: g.bike.x, z: g.bike.z, yaw: g.bike.yaw }, 0);
        this.wasGameRiding = true;
        this.wasGameRidingShared = false;
        this.publishHud(true);
      }
      return true;
    }
    if (!this.focus) return false;
    if (b && Math.hypot(this.focus.at.x - b.x, this.focus.at.z - b.z) > 6.5) {
      this.focus = null;
      this.publishHud(true);
      return false;
    }
    if (
      g &&
      (this.focus.kind === 'seat' ||
        (this.focus.kind === 'spot' &&
          ['sit', 'rest'].includes(this.focus.hotspot.action) &&
          g.options(this.focus).length <= 1))
    ) {
      if (g.people.playerSeat) return false;
      const targetNow = this.focus;
      const refPos = b ?? targetNow.at;
      const isOccupied = (seatCand: import('@/lib/echo-life/game/people').Seat) =>
        [...g.people.walkers.values()].some(w => w.seat === seatCand || w.targetSeat === seatCand);
      const candidates =
        targetNow.kind === 'seat'
          ? g.people.seats.filter(s => s.id === targetNow.id && !isOccupied(s))
          : g.people.seats
              .filter(
                s =>
                  s.zone === targetNow.hotspot.zone &&
                  Math.hypot(s.sit.x - targetNow.at.x, s.sit.z - targetNow.at.z) < 2.4 &&
                  !isOccupied(s),
              )
              .sort(
                (sA, sB) =>
                  Math.hypot(sA.sit.x - refPos.x, sA.sit.z - refPos.z) -
                  Math.hypot(sB.sit.x - refPos.x, sB.sit.z - refPos.z),
              );
      if (candidates.length === 0) {
        g.say('This seat is currently occupied.', 'info');
        this.publishHud(true);
        return true;
      }
      let seat: import('@/lib/echo-life/game/people').Seat | null = null;
      for (const cand of candidates) {
        if (this.cb.sit?.(cand)) {
          seat = cand;
          break;
        }
      }
      if (!seat) {
        g.say('Walk to the open front of the seat to sit down.', 'info');
        this.publishHud(true);
        return true;
      }
      g.people.playerSeat = seat.id;
      this.focus = null;
      this.audio.triggerSeat(true, 'wood', { x: seat.sit.x, y: seat.sit.y, z: seat.sit.z });
      if (targetNow.kind === 'spot') {
        const optKey = g.options(targetNow)[0]?.key ?? targetNow.hotspot.action;
        g.act(targetNow, optKey);
      }
      this.publishHud(true);
      return true;
    }
    this.cb.onInteract?.(this.focus);
    return true;
  }

  /**
   * Physical seasonal solar ephemeris, daylight curve, season, fog, rain and snow of the game's clock & weather.
   * Uses continuous seasonal solar altitude (`smoothstep(-0.08, 0.42, sinAlt)`), preserving warm golden morning
   * (06:00-08:30) and golden sunset (16:45-19:00) instead of snapping to midday washout at 07:05 AM.
   */
  sky() {
    const g = this.game;
    if (!g) return null;
    const room = this.cityPresence;
    const shared = room?.connected;
    const minute = shared ? (Date.now() + room.clockOffset) * 1440 / (WORLD_DAY_MINUTES * 60000) : g.s.clock;
    const dayIndex = Math.floor(minute / 1440), hour = (minute % 1440) / 60;
    const season = this.envControl.season !== null ? this.envControl.season : Math.floor(dayIndex / 7) % 4;
    const seasonName = SEASON_NAMES[season] ?? 'Spring';
    const decl = SEASON_DECLINATION[season] ?? 0.02;
    const hourAngle = ((hour - 12) / 12) * Math.PI;
    const lat = 0.50;
    const sinAlt = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
    const angle = (hour - 6) * Math.PI / 12;
    const day = smoothstep(-0.08, 0.42, sinAlt);
    const pattern = ['sunny', 'cloudy', 'light_rain', 'golden_breeze', 'sunny', 'cloudy', 'sunny'];
    const baseWeather = shared ? WEATHER_STATES[pattern[(Math.floor(minute / 360) + season) % pattern.length]] : g.weather;
    const ov = this.envControl.weather;
    const isWinter = season === 3;
    let label = baseWeather.label, rain = baseWeather.rain ? .75 : 0, snow = 0, cloud = baseWeather.rain ? .92 : baseWeather.id === 'cloudy' ? .64 : baseWeather.id === 'golden_breeze' ? .24 : .12;
    if (ov === 'auto' && isWinter && baseWeather.rain) { label = 'Snowy'; rain = 0; snow = .85; cloud = .88; }
    else if (ov === 'sunny') { label = 'Sunny'; rain = 0; snow = 0; cloud = .12; }
    else if (ov === 'cloudy') { label = 'Partly Cloudy'; rain = 0; snow = 0; cloud = .52; }
    else if (ov === 'overcast') { label = 'Overcast'; rain = 0; snow = 0; cloud = .86; }
    else if (ov === 'light_rain') { label = 'Light Rain'; rain = .65; snow = 0; cloud = .90; }
    else if (ov === 'heavy_rain') { label = 'Heavy Rain'; rain = 1.0; snow = 0; cloud = .98; }
    else if (ov === 'snowy') { label = 'Snowy'; rain = 0; snow = .9; cloud = .88; }
    const overcast = Math.max(rain, snow * 0.82);
    const goldenHour = smoothstep(-0.04, 0.14, sinAlt) * smoothstep(0.46, 0.16, sinAlt) * (1 - overcast * 0.45);
    const fogDensity = rain > .8 ? .0034 : rain > .1 ? .0027 : snow > .1 ? .0028 : cloud > .75 ? .0022 : cloud > .4 ? .0017 : .0013;
    return {
      day,
      sinAlt,
      goldenHour,
      rain,
      snow,
      angle,
      season,
      seasonName,
      hour,
      minute,
      cloud,
      fogDensity,
      weather: { ...baseWeather, label, rain: rain > .1 },
    };
  }

  /** Save now (page hidden, leaving, room size change). */
  flush() {
    if (this.game && this.saver) { this.saver.schedule(() => this.serializeWithNpcSim(), 0); void this.saver.flush(); }
  }

  dispose() {
    this.activeNow = false;
    this.unbindVehicleKeys();
    this.audio.update({
      dt: 0.016,
      active: false,
      pos: null,
      cameraYaw: 0,
      region: null,
      zone: null,
      indoor: true,
      hour: 12,
      rain: 0,
      riverRect: null,
      vehicle: null,
    });
    this.flush();
    this.worker?.terminate(); this.worker = null;
    this.detachSaver();
    this.drop();
    this.showerVfx?.dispose();
    this.showerVfx = null;
    this.showerEmitterRegisteredWorld = null;
    this.embodied.dispose();
  }
}
