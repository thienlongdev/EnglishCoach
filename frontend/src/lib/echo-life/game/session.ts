/**
 * Echo Life Phase 3 + 4 — one game session inside the Study Space world.
 *
 * The rules are V3's, vendored verbatim (`../v3`, see `PROVENANCE.tsv`): story (`semester.mjs`, `story-v3.mjs`), 14 side arcs,
 * 32 free-roam activities, dialogue and relationships, tutorial, exploration, weather and events, V2 progression. This class
 * only connects them to the real world:
 *  - the learner's real body (one HumanRig, one LifeWalk) is mirrored into `s.player.zone`; V3 never moves the body;
 *  - V3 props live at real places (`hotspots.ts`), the 22 residents walk real routes (`people.ts`, `nav.ts`);
 *  - when the learner acts on something, V3's own `interact(s, id, choice)` runs with V3's virtual player standing exactly
 *    at that entity, so every V3 rule (prerequisites, story events, side-arc stages, rewards, tutorial signals) is the
 *    original;
 *  - what changed in V3's economy is reported as a claim batch for the server, whose answer is authoritative (`wallet`).
 * No AI, no network inside the rules; the clock runs only while the learner is in the world (V3: no offline decay).
 */
import jobs from './jobs.json';
import { worldPlacement, type StarterFurnitureOverride } from './build';
import {
  TrafficSim,
  getTrafficDensityMultiplier,
  setTrafficDensityMultiplier,
  type TrafficAgent,
  type TrafficStepContext,
} from './commute';
import type { CurbBoxInput } from './roadGraph';
import { TwoWheeler } from './twoWheeler';
import { Automobile } from './automobile';
import * as V3 from '../v3/game-core/index.mjs';
import type { V3Entity, V3Option, V3Result, V3State } from '../v3/game-core/index.mjs';
import { buildNpcInteractionOptions, getNpcHeaderBadge } from '../v3/dialogue/npc-interactions.mjs';
import { resetDailyEconomyIfNeeded } from '../v3/progression/state.mjs';
import { playerLevelFromXp, skillLevelFromXp } from '../v3/progression/skills.mjs';
import { getActiveCarSpec } from '../v3/vehicles/car.mjs';

const ALL_DRIVABLE_CAR_MODELS: Readonly<Record<string, string>> = {
  car_mango_micro: 'Mango Micro City EV',
  car_river_sedan: 'River Contemporary Sedan',
  car_lotus_spider: 'Lotus Spider Roadster',
  car_halo_vector: 'Halo Vector Hypercar',
};
import type { HousePlan } from '../plan';
import type { CityPlan } from '../city';
import { V3_ZONE_META, type V3ZoneId } from '../zones';
import { LifeNav, type P } from './nav';
import { buildHotspots, buildResidenceHotspots, standNear, type Hotspot, type ResidenceHotspot } from './hotspots';
import { doorEnds } from './nav';
import { awardCredits } from '../v3/progression/engine.mjs';
import { PeopleSim, type DoorPort, type ParkedVehicleObstacle } from './people';
import { isResidentId, type ResidentId } from './npcMind';
import {
  buildLanes,
  crowdAt,
  crowdDensity,
  setActiveVehicles as setCrowdActiveVehicles,
  setPedestrianDensityMultiplier,
  type CrowdContext,
  type Lane,
  type Passer,
  type VehicleHazard,
} from './crowd';
import {
  collectDailyAnnouncements,
  isMarketFlashSaleLive,
  resolveDailyActivities,
  type DailyEnvContext,
  type DailyScheduleSnapshot,
} from './dailyEvents';
import {
  SUB_SKILL_IDS,
  advanceNeeds8,
  applyActivityToNeeds,
  applyKarmaAction,
  applyKarmaDelta,
  applyNeedDeltas,
  awardSubSkillXp,
  buildNpcThoughtBubble,
  buildResidentDailyDiary,
  computePlayerEmotion,
  createInitialPlayerMindState,
  ensureDailyUrgesForDay,
  nextSubSkillThreshold,
  projectToV3Vitals,
  recordActionForUrges,
  resolveCityKarmaBand,
  resolveKarmaTier,
  sanitizeNeeds8,
  subSkillLevelFromXp,
  syncFromV3Vitals,
  type DiegeticThoughtBubble,
  type EmotionState,
  type KarmaActionKind,
  type KarmaState,
  type Needs8,
  type PlayerActivityKind,
  type PlayerMindEvent,
  type PlayerMindState,
  type ResidentDiaryEntry,
  type SubSkillId,
  type SubSkillsState,
  type UrgeActionKind,
  type UrgeItem,
} from './playerMind';
import {
  BISTRO_MENU,
  RECIPE_BOOK,
  cookRecipe,
  getBistroItem,
  getRecipeById,
  listCookableRecipes,
  mergeCookingInventory,
  orderBistroItem,
  type BistroItemId,
  type BistroOrderResult,
  type CookRecipeResult,
  type IngredientId,
  type RecipeId,
} from './cookingSim';
import {
  PART_TIME_JOB_IDS,
  completeFullTimeWorkday,
  createInitialCareerState,
  enrollFullTimeCareer as enrollFullTimeCareerState,
  getAllPartTimeStatuses,
  getFullTimeCareer,
  getPartTimeCareerStatus,
  pickWorkplaceDilemma,
  resolveWorkplaceDilemma as resolveWorkplaceDilemmaState,
  type DilemmaResolutionResult,
  type FullTimeCareerId,
  type FullTimeCareerState,
  type PartTimeCareerStatus,
  type PartTimeJobId,
  type WorkplaceDilemma,
} from './careerSim';
import {
  addFeedPosts,
  addPhotoToAlbum,
  createInitialPhoneState,
  createPlayerFeedPost,
  defaultManageCityConfig,
  deserializePhoneState,
  generateCampusFeedPosts,
  getBankSummary,
  getDailySchedule,
  likeFeedPost as likePhoneFeedPost,
  planBusTrip,
  recordBankTransaction,
  replyToFeedPost as replyPhoneFeedPost,
  resolveBusStops,
  sanitizeManageCityConfig,
  sendHangoutInvite,
  sendResidentMessage,
  serializePhoneState,
  updateManageCityConfig,
  type BankSummary,
  type BusStop,
  type BusStopId,
  type BusTripPlan,
  type EchoPhoneState,
  type FeedMilestoneTag,
  type HangoutVenue,
  type ManageCityConfig,
  type PhonePhotoMeta,
  type ScheduleEntry,
} from './phoneSim';
import {
  equipClothingSkuOnProfile,
  listBoutiqueCatalogWithOwnership,
  resolveUnlockedWardrobe,
  type EquipClothingResult,
  type UnlockedWardrobeSet,
} from './wardrobeBridge';
import type { CharacterCreatorProfile, CharacterIdentityTraits } from '../../avatar/characterCreator';
import type { GameSaver, WorkshopAction } from './saver';

export const GAME_SAVE_VERSION = 1;
export class UnreadableGameSave extends Error {}

/** What the server keeps for the narrative (V3 save v4, decode-compatible) plus this world's places. */
export interface GameDoc { v: number; save: string; places: Record<string, { x: number; z: number }> }

/** The server's authoritative economy: everything V3 shows about money and XP is overwritten by it. */
export interface Wallet { workshop?: V3State['progression'] | null; workshopRevision?: number; credits: number; skills: Record<string, number>; claimed: string[]; owned: { instanceId: string; storeId: string; sku: string }[]; dailyEarned: number }

/** One economy report: unique rewards V3 granted, bounded earnings and what was spent, with the action that caused it. */
export interface ClaimBatch {
  requestId?: string;
  source: string;
  uniques: string[];
  credits: number;
  xp: Record<string, number>;
  spent: { kind: 'market' | 'bistro'; items: string[]; sale: boolean }[];
}

/** `ang`: cosine between the learner's facing and the target (1 = straight ahead). */
export type Target =
  | { kind: 'npc'; id: string; name: string; at: P; dist: number; ang?: number }
  | { kind: 'seat'; id: string; label: string; at: P; dist: number; ang?: number }
  | { kind: 'workstation'; id: string; label: string; at: P; dist: number; ang?: number }
  | { kind: 'car'; label: string; at: P; dist: number; ang?: number }
  | { kind: 'twoWheeler'; label: string; at: P; dist: number; ang?: number }
  | { kind: 'bike'; label: string; at: P; dist: number; ang?: number }
  | { kind: 'spot'; hotspot: Hotspot; entity: V3Entity; label: string; at: P; dist: number; ang?: number };

export interface Feed { id: number; text: string; tone: 'info' | 'good' | 'bad' | 'story' }

export type HomeComfortTier = 'Cozy Starter' | 'Inviting Home' | 'Designer Sanctuary' | 'Riverside Showcase';

export interface HomeComfortSummary {
  score: number;
  tier: HomeComfortTier;
  restMultiplier: number;
  focusBonus: number;
  breakdown: {
    base: number;
    furnishings: number;
    styles: number;
    property: number;
    cleanliness: number;
  };
}

export type LifestyleMoodletId =
  | 'well_rested'
  | 'inspired_space'
  | 'caffeinated'
  | 'tea_calm'
  | 'rain_cozy'
  | 'hot_streak';

export interface ActiveMoodlet {
  id: LifestyleMoodletId;
  label: string;
  effect: string;
  tone: 'amber' | 'sky' | 'teal' | 'violet' | 'emerald';
  minutesRemaining: number;
}

export interface ResidentPerk {
  npcId: string;
  npcName: string;
  title: string;
  effect: string;
  unlocked: boolean;
}

export type ShiftQuality = 'standard' | 'great' | 'perfect';

export interface CareerTierInfo {
  jobId: string;
  title: string;
  shifts: number;
  tier: 1 | 2 | 3;
  leadNpc: string;
  skill: string;
  microKind: string;
  microPrompt: string;
}

export interface NeedsSummary {
  energy: number;
  hunger: number;
  hygiene: number;
  mood: number;
  focus: number;
  fitness: number;
  state: 'energized' | 'steady' | 'tired' | 'hungry';
  speedFactor: number;
  comfort?: HomeComfortSummary;
  moodlets?: ActiveMoodlet[];
}

export interface ActiveShiftTarget {
  job: string;
  title?: string;
  zone: V3ZoneId;
  station: string;
  at: P;
  label: string;
  step: number;
  total: number;
  leadNpc?: string;
  microKind?: string;
  microPrompt?: string;
}

export type TimeScale = 0 | 1 | 2 | 3;

export const DRIVABLE_CAR_MODELS = [
  'car_mango_micro',
  'car_river_sedan',
  'car_lotus_spider',
  'car_halo_vector',
] as const;

export interface OwnedDrivableCarInfo {
  instanceId: string;
  model: string;
  name: string;
  drivable: true;
  active: boolean;
}

export interface GameHudProjection {
  needs: NeedsSummary;
  dailyEvents: DailyScheduleSnapshot;
  activeShift: ActiveShiftTarget | null;
  comfort: HomeComfortSummary;
  moodlets: ActiveMoodlet[];
  perks: ResidentPerk[];
  needs8: Needs8;
  emotion: EmotionState;
  urges: UrgeItem[];
  karma: KarmaState;
  subSkills: SubSkillsState;
  phone: EchoPhoneState;
  fullTimeCareer: FullTimeCareerState;
  timeScale: TimeScale;
}

export interface ShowerEnclosurePoints {
  /** Walkable interior spray center `(bathR.x1 - 0.56, bathR.z1 - 0.58)`. */
  stand: { x: number; y: number; z: number };
  /** Overhead rain showerhead nozzle for `showerVfx.ts`. */
  nozzle: { x: number; y: number; z: number };
  /** Wall mixer valve inside the SE bay. */
  mixer: { x: number; y: number; z: number };
  /** Clean dry bathroom floor step-out point `(bathR.x1 - 1.48, bathR.z1 - 0.72)`. */
  stepOut: { x: number; y: number; z: number };
  /** Outward-facing character root yaw (rad) looking comfortably into the bathroom. */
  facingYaw: number;
}

const SITTABLE_ANCHOR_RE = /^(bench|bench-cushion|sofa|chair|club_chair|gaming-chair|patio-set|shelter|park-gazebo)/;

/** Replaces raw V3 ampersands with natural English "and" across rendered HUD/dialogue copy. */
export function cleanDisplayCopy(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/\s*&\s*/g, ' and ').replace(/\s{2,}/g, ' ').trim();
}

interface SerializedSubSkill {
  pts: number;
  lv: number;
}

interface LifeMetaPayload {
  v: 1 | 2;
  buffs: [LifestyleMoodletId, number][];
  moodlets?: [string, number][];
  tiers: Record<string, number>;
  lastComfort: number;
  needs?: Needs8;
  emotions?: { primary: string; secondary: string | null; intensity: number };
  urges?: { day: number; pts: number; items: UrgeItem[] };
  karma?: KarmaState;
  subSkills?: Record<string, SerializedSubSkill>;
  phoneMessages?: Omit<EchoPhoneState, 'cityConfig'>;
  cityConfig?: ManageCityConfig;
  schedule?: { career: FullTimeCareerState };
  starterFurniture?: Record<string, StarterFurnitureOverride>;
  traits?: string[];
  desiredLife?: string;
  values?: string[];
  favorites?: { displayName?: string; likes: string[]; dislikes: string[] };
  districtRep?: Record<string, number>;
  updatedAt?: number;
}

const MAX_LIFE_META_BYTES = 28000;
const MAX_LIFE_META_NODES = 1350;
const VALID_DISTRICTS = new Set(['market', 'bistro', 'cafe', 'library', 'park', 'campus']);
const HOME_ZONES = new Set<string>(['study', 'hall', 'living', 'kitchen', 'bedroom', 'bath', 'gaming_room', 'balcony', 'garage']);
const COZY_INDOOR_ZONES = new Set<string>(['study', 'hall', 'living', 'kitchen', 'bedroom', 'gaming_room', 'library', 'bistro', 'cafe', 'atelier', 'linh', 'minh']);
const BISTRO_SKU_SET = new Set<string>(BISTRO_MENU.map(b => b.id));
const SHIFT_SUB_SKILL: Record<string, SubSkillId> = {
  market: 'rhetoric',
  barista: 'coffeeCraft',
  delivery: 'fitness',
  library: 'rhetoric',
  cafe: 'art',
  gardener: 'gardening',
  busker: 'music',
};
const EXT_MOODLET_META: Record<string, { label: string; effect: string; tone: ActiveMoodlet['tone'] }> = {
  fresh_bite: { label: 'Fresh Greens Glow', effect: '+8% steady energy conservation', tone: 'emerald' },
  morning_glow: { label: 'Bright Morning Fuel', effect: '+10% study focus stability', tone: 'amber' },
  home_comfort: { label: 'Home Kitchen Comfort', effect: 'Warm Cozy emotion boost indoors', tone: 'amber' },
  sweet_lift: { label: 'Sweet Matcha Lift', effect: '+12% Fun and Joyful mood boost', tone: 'teal' },
  warm_hearth: { label: 'Warm Hearth Broth', effect: 'Shields mood from rain or winter chill', tone: 'amber' },
  inspired_palate: { label: 'Inspired Palate', effect: '+15% Creative and Photography sub-skill XP', tone: 'violet' },
  chef_pride: { label: 'Home Chef Pride', effect: 'Boosts Confident emotion and Recognition', tone: 'emerald' },
  gourmet_warmth: { label: 'Gourmet Lantern Warmth', effect: 'Peak hunger satisfaction and Joyful lift', tone: 'amber' },
};

const MOODLET_CATALOG: Record<LifestyleMoodletId, { label: string; effect: string; tone: ActiveMoodlet['tone'] }> = {
  well_rested: { label: 'Well-Rested', effect: '20% slower Energy drain', tone: 'emerald' },
  inspired_space: { label: 'Inspired Space', effect: '+15% Focus retention and +4 Mood/hr', tone: 'violet' },
  caffeinated: { label: 'Caffeinated', effect: '+8% walk energy efficiency and +12 Focus floor', tone: 'amber' },
  tea_calm: { label: 'Tea Calm', effect: '50% slower Mood decay and steady calm', tone: 'teal' },
  rain_cozy: { label: 'Rain-Cozy', effect: '+6 Mood/hr and +6 Focus/hr indoors during rain', tone: 'sky' },
  hot_streak: { label: 'Hot Streak', effect: '+10% Fitness gain and upbeat Mood floor', tone: 'amber' },
};

const RESIDENT_PERK_DEFS: readonly { npcId: string; title: string; effect: string }[] = [
  { npcId: 'khanhha', title: 'Barista Treat', effect: '+10 extra Mood and +8 Focus on Willow Bistro orders' },
  { npcId: 'anchi', title: 'Archivist Calm', effect: '+20% Focus recovery during study sessions' },
  { npcId: 'minh', title: 'Court Rhythm', effect: '15% slower sprint fatigue outdoors and steadier court focus' },
  { npcId: 'ngocbich', title: 'Botanist Blend', effect: 'Tea Calm lasts twice as long (8 game hours)' },
  { npcId: 'ductri', title: 'Precision Tune', effect: 'Smooth urban driving composure and crisp vehicle care' },
  { npcId: 'linh', title: 'Community Spirit', effect: '+25% Mood boost when joining town social scenes' },
];

const JOB_RECORD = jobs as Record<string, {
  title?: string;
  leadNpc?: string;
  skill?: string;
  microKind?: string;
  microPrompt?: string;
  pay: number;
  steps: (readonly (string | readonly string[])[])[];
}>;

interface Snap { done: Set<string>; side: Set<string>; choices: Set<string>; landmarks: Set<string>; relics: Set<string>; credits: number; xp: Record<string, number> }

const NPC_REACH = 2.5, SPOT_REACH = 1.9, MAX_NPC_SIM_BYTES = 6500;
/** Where a rider may ride: outdoors and the garage (V3: "Park your vehicle outside first" before any indoor door). */
export const WORLD_DAY_MINUTES = 48;
const RIDEABLE = new Set(['sidewalk', 'road', 'crossing', 'park', 'garden', 'plaza', 'garage', 'door:garage_out']);
/** Riding speed over walking (the HumanRig's own run is 2.9 m/s; a student bicycle cruises at ≈ 5–6 m/s). */
export const RIDE_FACTOR = 2.1;

function matchesJobStep(station: readonly unknown[] | undefined, zone: string, stationId: string, jobId?: string): boolean {
  if (!station) return false;
  if (station[0] === zone) {
    if (station[1] === stationId) return true;
    return Array.isArray(station[3]) && station[3].includes(stationId);
  }
  // Rain fallback for Fountain Plaza Busker inside Riverside Atelier
  if (jobId === 'busker' && zone === 'atelier' && Array.isArray(station[3]) && station[3].includes(stationId)) {
    return true;
  }
  return false;
}

function hashOwnerSeed(owner: string): number {
  let h = 2166136261;
  for (let i = 0; i < owner.length; i++) h = Math.imul(h ^ owner.charCodeAt(i), 16777619);
  return (h >>> 0) || 517;
}

function countJsonNodes(val: unknown): number {
  if (val === null || typeof val !== 'object') return 1;
  let total = 1;
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) total += countJsonNodes(val[i]);
  } else {
    for (const v of Object.values(val as Record<string, unknown>)) total += countJsonNodes(v);
  }
  return total;
}

function sanitizeSafeString(raw: unknown, maxLen: number): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<script/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/data:/gi, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .slice(0, maxLen);
}

function sanitizeStarterOverrides(raw: unknown): Record<string, StarterFurnitureOverride> {
  const out: Record<string, StarterFurnitureOverride> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^obj_starter_[a-z0-9_]{1,24}$/.test(k) || !v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    if (typeof o.x !== 'number' || !Number.isFinite(o.x) || typeof o.z !== 'number' || !Number.isFinite(o.z)) continue;
    const rotY = typeof o.rotY === 'number' && Number.isFinite(o.rotY) ? Math.round(o.rotY * 1000) / 1000 : 0;
    const entry: StarterFurnitureOverride = {
      id: k,
      x: Math.round(clamp(o.x, -500, 500) * 1000) / 1000,
      z: Math.round(clamp(o.z, -500, 500) * 1000) / 1000,
      rotY,
    };
    if (typeof o.y === 'number' && Number.isFinite(o.y)) entry.y = Math.round(clamp(o.y, -20, 40) * 1000) / 1000;
    if (typeof o.zone === 'string' && /^[a-z0-9_]{1,24}$/.test(o.zone)) entry.zone = o.zone;
    out[k] = entry;
  }
  return out;
}

function sanitizeFullTimeCareer(raw: unknown): FullTimeCareerState {
  const def = createInitialCareerState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return def;
  const o = raw as Record<string, unknown>;
  const activeId = typeof o.activeCareerId === 'string' && getFullTimeCareer(o.activeCareerId as FullTimeCareerId)
    ? (o.activeCareerId as FullTimeCareerId)
    : null;
  const rank = typeof o.rank === 'number' && Number.isFinite(o.rank)
    ? (Math.max(1, Math.min(5, Math.floor(o.rank))) as 1 | 2 | 3 | 4 | 5)
    : 1;
  return {
    activeCareerId: activeId,
    rank,
    promotionProgress: typeof o.promotionProgress === 'number' && Number.isFinite(o.promotionProgress)
      ? Math.round(clamp(o.promotionProgress, 0, 100))
      : 0,
    workdaysCompleted: typeof o.workdaysCompleted === 'number' && Number.isFinite(o.workdaysCompleted)
      ? Math.max(0, Math.floor(o.workdaysCompleted))
      : 0,
    lastWorkedDay: typeof o.lastWorkedDay === 'number' && Number.isFinite(o.lastWorkedDay)
      ? Math.floor(o.lastWorkedDay)
      : -1,
    lastDilemmaDay: typeof o.lastDilemmaDay === 'number' && Number.isFinite(o.lastDilemmaDay)
      ? Math.floor(o.lastDilemmaDay)
      : -1,
    resolvedDilemmaIds: Array.isArray(o.resolvedDilemmaIds)
      ? o.resolvedDilemmaIds.filter((x): x is string => typeof x === 'string' && x.length <= 40).slice(-12)
      : [],
  };
}

function sanitizeLifeMeta(raw: unknown): LifeMetaPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  try {
    const obj = raw as Record<string, unknown>;
    const buffs: [LifestyleMoodletId, number][] = [];
    if (Array.isArray(obj.buffs)) {
      for (const entry of obj.buffs) {
        if (
          Array.isArray(entry) &&
          typeof entry[0] === 'string' &&
          Object.hasOwn(MOODLET_CATALOG, entry[0]) &&
          typeof entry[1] === 'number' &&
          Number.isFinite(entry[1])
        ) {
          buffs.push([entry[0] as LifestyleMoodletId, Math.round(entry[1])]);
        }
        if (buffs.length >= 6) break;
      }
    }
    const moodlets: [string, number][] = [];
    if (Array.isArray(obj.moodlets)) {
      for (const entry of obj.moodlets) {
        if (
          Array.isArray(entry) &&
          typeof entry[0] === 'string' &&
          Object.hasOwn(EXT_MOODLET_META, entry[0]) &&
          typeof entry[1] === 'number' &&
          Number.isFinite(entry[1])
        ) {
          moodlets.push([entry[0], Math.round(entry[1])]);
        }
        if (moodlets.length >= 8) break;
      }
    }
    const tiers: Record<string, number> = {};
    if (obj.tiers && typeof obj.tiers === 'object' && !Array.isArray(obj.tiers)) {
      for (const [k, v] of Object.entries(obj.tiers as Record<string, unknown>)) {
        if (Object.hasOwn(JOB_RECORD, k) && typeof v === 'number' && Number.isFinite(v) && v >= 0) {
          tiers[k] = Math.min(999, Math.floor(v));
        }
      }
    }
    const lastComfort = typeof obj.lastComfort === 'number' && Number.isFinite(obj.lastComfort)
      ? Math.round(clamp(obj.lastComfort, 0, 100))
      : 38;

    const out: LifeMetaPayload = { v: obj.v === 2 ? 2 : 1, buffs, tiers, lastComfort };
    if (moodlets.length > 0) out.moodlets = moodlets;
    if (obj.needs && typeof obj.needs === 'object' && !Array.isArray(obj.needs)) {
      out.needs = sanitizeNeeds8(obj.needs);
    }
    if (obj.emotions && typeof obj.emotions === 'object' && !Array.isArray(obj.emotions)) {
      const em = obj.emotions as Record<string, unknown>;
      if (typeof em.primary === 'string') {
        out.emotions = {
          primary: sanitizeSafeString(em.primary, 24),
          secondary: typeof em.secondary === 'string' ? sanitizeSafeString(em.secondary, 24) : null,
          intensity: typeof em.intensity === 'number' && Number.isFinite(em.intensity) ? Math.round(clamp(em.intensity, 0, 100)) : 50,
        };
      }
    }
    if (obj.urges && typeof obj.urges === 'object' && !Array.isArray(obj.urges)) {
      const u = obj.urges as Record<string, unknown>;
      if (Array.isArray(u.items)) {
        const cleanItems = u.items
          .filter((x): x is UrgeItem => Boolean(x && typeof x === 'object' && typeof (x as UrgeItem).id === 'string' && typeof (x as UrgeItem).actionKind === 'string'))
          .slice(0, 3);
        out.urges = {
          day: typeof u.day === 'number' && Number.isFinite(u.day) ? Math.max(0, Math.floor(u.day)) : 0,
          pts: typeof u.pts === 'number' && Number.isFinite(u.pts) ? Math.max(0, Math.floor(u.pts)) : 0,
          items: cleanItems,
        };
      }
    }
    if (obj.karma && typeof obj.karma === 'object' && !Array.isArray(obj.karma)) {
      const km = obj.karma as Record<string, unknown>;
      const personal = typeof km.personal === 'number' && Number.isFinite(km.personal) ? Math.round(clamp(km.personal, -100, 100)) : 12;
      const city = typeof km.city === 'number' && Number.isFinite(km.city) ? Math.round(clamp(km.city, 0, 100)) : 68;
      const recentLog = Array.isArray(km.recentLog)
        ? km.recentLog
          .filter((e): e is KarmaState['recentLog'][number] => Boolean(e && typeof e === 'object' && typeof (e as { label?: unknown }).label === 'string'))
          .slice(-8)
          .map(e => ({
            action: sanitizeSafeString(e.action, 32),
            label: sanitizeSafeString(e.label, 64),
            delta: typeof e.delta === 'number' && Number.isFinite(e.delta) ? Math.round(e.delta) : 0,
            day: typeof e.day === 'number' && Number.isFinite(e.day) ? Math.max(0, Math.floor(e.day)) : 0,
            clock: typeof e.clock === 'number' && Number.isFinite(e.clock) ? Math.max(0, Math.floor(e.clock)) : 0,
          }))
        : [];
      out.karma = {
        personal,
        tier: resolveKarmaTier(personal),
        city,
        cityBand: resolveCityKarmaBand(city),
        recentLog,
      };
    }
    if (obj.subSkills && typeof obj.subSkills === 'object' && !Array.isArray(obj.subSkills)) {
      const skOut: Record<string, SerializedSubSkill> = {};
      for (const id of SUB_SKILL_IDS) {
        const entry = (obj.subSkills as Record<string, unknown>)[id];
        if (!entry || typeof entry !== 'object') continue;
        const eo = entry as Record<string, unknown>;
        const rawPts = typeof eo.pts === 'number' && Number.isFinite(eo.pts)
          ? eo.pts
          : typeof eo.xp === 'number' && Number.isFinite(eo.xp)
            ? eo.xp
            : 0;
        const pts = Math.max(0, Math.floor(rawPts));
        skOut[id] = { pts, lv: subSkillLevelFromXp(pts) };
      }
      if (Object.keys(skOut).length > 0) out.subSkills = skOut;
    }
    if (obj.phoneMessages && typeof obj.phoneMessages === 'object' && !Array.isArray(obj.phoneMessages)) {
      const ph = deserializePhoneState(obj.phoneMessages, 0);
      const { cityConfig: _omit, ...rest } = serializePhoneState(ph);
      void _omit;
      out.phoneMessages = rest;
    }
    if (obj.cityConfig && typeof obj.cityConfig === 'object' && !Array.isArray(obj.cityConfig)) {
      out.cityConfig = sanitizeManageCityConfig(obj.cityConfig);
    }
    if (obj.schedule && typeof obj.schedule === 'object' && !Array.isArray(obj.schedule)) {
      const sc = obj.schedule as Record<string, unknown>;
      if (sc.career) out.schedule = { career: sanitizeFullTimeCareer(sc.career) };
    }
    const rawStarter = obj.starterFurniture ?? obj.starterOverrides;
    if (rawStarter && typeof rawStarter === 'object' && !Array.isArray(rawStarter)) {
      const cleanStarter = sanitizeStarterOverrides(rawStarter);
      if (Object.keys(cleanStarter).length > 0) out.starterFurniture = cleanStarter;
    }
    if (Array.isArray(obj.traits)) {
      out.traits = obj.traits.filter((t): t is string => typeof t === 'string' && /^[a-z0-9_]{1,32}$/.test(t)).slice(0, 3);
    }
    if (typeof obj.desiredLife === 'string' && /^[a-z0-9_]{1,32}$/.test(obj.desiredLife)) {
      out.desiredLife = obj.desiredLife;
    }
    if (Array.isArray(obj.values)) {
      out.values = obj.values.filter((v): v is string => typeof v === 'string' && /^[a-z0-9_]{1,32}$/.test(v)).slice(0, 3);
    }
    if (obj.favorites && typeof obj.favorites === 'object' && !Array.isArray(obj.favorites)) {
      const fv = obj.favorites as Record<string, unknown>;
      out.favorites = {
        ...(typeof fv.displayName === 'string' && fv.displayName.trim() ? { displayName: sanitizeSafeString(fv.displayName, 32) } : {}),
        likes: Array.isArray(fv.likes) ? fv.likes.filter((x): x is string => typeof x === 'string' && /^[a-z0-9_]{1,32}$/.test(x)).slice(0, 5) : [],
        dislikes: Array.isArray(fv.dislikes) ? fv.dislikes.filter((x): x is string => typeof x === 'string' && /^[a-z0-9_]{1,32}$/.test(x)).slice(0, 5) : [],
      };
    }
    if (obj.districtRep && typeof obj.districtRep === 'object' && !Array.isArray(obj.districtRep)) {
      const rep: Record<string, number> = {};
      for (const [k, v] of Object.entries(obj.districtRep as Record<string, unknown>)) {
        if (VALID_DISTRICTS.has(k) && typeof v === 'number' && Number.isFinite(v)) {
          rep[k] = Math.round(clamp(v, 0, 100));
        }
      }
      if (Object.keys(rep).length > 0) out.districtRep = rep;
    }
    if (typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) && obj.updatedAt >= 0) {
      out.updatedAt = Math.floor(obj.updatedAt);
    }

    // Enforce both byte budget (<= 28 KB) and backend node cap (<= 1350 nodes) via progressive trim
    const fits = () =>
      new TextEncoder().encode(JSON.stringify(out)).length <= MAX_LIFE_META_BYTES &&
      countJsonNodes(out) <= MAX_LIFE_META_NODES;

    if (!fits() && out.phoneMessages) {
      out.phoneMessages.feed = out.phoneMessages.feed.slice(0, 6).map(p => ({ ...p, comments: p.comments.slice(-2) }));
      for (const k of Object.keys(out.phoneMessages.threads) as ResidentId[]) {
        const list = out.phoneMessages.threads[k];
        if (list) out.phoneMessages.threads[k] = list.slice(-3);
      }
    }
    if (!fits() && out.phoneMessages) {
      const tKeys = Object.keys(out.phoneMessages.threads) as ResidentId[];
      for (const k of tKeys.slice(5)) delete out.phoneMessages.threads[k];
      out.phoneMessages.ledger = out.phoneMessages.ledger.slice(-10);
      out.phoneMessages.photos = out.phoneMessages.photos.slice(0, 10);
    }
    if (!fits() && out.phoneMessages) {
      out.phoneMessages.feed = out.phoneMessages.feed.slice(0, 3).map(p => ({ ...p, comments: [] }));
      out.phoneMessages.threads = {};
      out.phoneMessages.ledger = out.phoneMessages.ledger.slice(-6);
    }
    if (!fits()) {
      delete out.phoneMessages;
      if (out.karma) out.karma.recentLog = out.karma.recentLog.slice(-3);
    }
    if (!fits()) return null;
    return out;
  } catch {
    return null;
  }
}

function sanitizeNpcSim(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  try {
    const encoded = JSON.stringify(raw);
    if (!encoded || new TextEncoder().encode(encoded).length > MAX_NPC_SIM_BYTES) return null;
    return JSON.parse(encoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class EchoLifeGame {
  readonly s: V3State;
  readonly nav: LifeNav;
  readonly people: PeopleSim;
  readonly hotspots: Hotspot[];
  readonly residenceHotspots: ResidenceHotspot[];
  readonly lanes: Lane[];
  readonly trafficSim: TrafficSim;
  readonly traffic: TrafficAgent[];
  /** Indicates `TrafficSim` is stepped authoritatively inside `EchoLifeGame.tick()` so views never double-step. */
  readonly trafficSteppedInSession = true;
  private lastZone: V3ZoneId | null = null;
  private lastBody: P | null = null;
  private entityCache = new Map<string, { at: number; list: V3Entity[] }>();
  private feedId = 0;
  feed: Feed[] = [];
  /** Economy reports waiting for the server. */
  readonly claims: ClaimBatch[] = [];
  /** Narrative changed since the last save. */
  dirty = false;
  private walletApplied = false;
  workshopRevision = -1;
  /** The learner's own bicycle (V3 starter `obj_starter_bike`): where it is parked, or ridden. */
  bike: { x: number; z: number; yaw: number };
  readonly car: Automobile;
  readonly twoWheeler: TwoWheeler;
  get drivenVehicle() { return this.twoWheeler.driving ? this.twoWheeler : this.car.driving ? this.car : null; }
  get riderPose() {
    if (this.car.driving) return 'car';
    if (this.twoWheeler.driving) return this.twoWheeler.powered ? 'motorbike' : 'bike';
    return this.riding ? 'bike' : 'none';
  }
  riding = false;
  ridingShared = false;
  private rideAccum = 0;
  basketStreak = 0;
  bestBasketStreak = 0;
  threeStreak = 0;
  private wasOnCourt = false;
  private lastHomeTeaAt = -999;
  private lastTiredHint = -999;
  private lastHungryHint = -999;
  private lastEventMinute = -1;
  private announcedEvents = new Set<string>();
  private dailyCache: { key: string; snap: DailyScheduleSnapshot } | null = null;
  private moodletUntil = new Map<LifestyleMoodletId, number>();
  private extMoodletUntil = new Map<string, number>();
  private shiftCounts: Record<string, number> = {};
  private homeCleanliness = 0.8;
  private readonly combinedActiveVehicles: VehicleHazard[] = [];
  private readonly playerVehHazardScratch: VehicleHazard = {
    x: 0,
    z: 0,
    vx: 0,
    vz: 0,
    speed: 0,
    radius: 1.2,
    hornActive: false,
  };
  private readonly parkedVehiclesBuf: (ParkedVehicleObstacle & { radius: number })[] = [];
  private readonly staticCurbBuf: (ParkedVehicleObstacle & { radius: number })[] = [];
  private readonly trafficCtxScratch: {
    env?: { dayWeight: number; rainWeight: number; snowWeight: number };
    phase?: string;
    playerPos?: P | null;
    playerVehicle?: VehicleHazard | null;
    residents?: ReturnType<PeopleSim['getResidentKinematics']>;
    crowd?: readonly Passer[];
    parkedVehicles?: readonly ParkedVehicleObstacle[];
    densityMultiplier?: number;
  } = {};
  private readonly trafficEnvScratch = { dayWeight: 1, rainWeight: 0, snowWeight: 0 };
  private readonly crowdCtxScratch: CrowdContext = {};
  private lastCrowdPassers: readonly Passer[] = [];
  private lastRawDt = 0;

  // ── Wave 11 Full Life-Simulation State (Persisted in `s.worldV3.lifeMeta`, <= 28 KB) ──
  timeScale: TimeScale = 1;
  private readonly ownerSeed: number;
  mindState: PlayerMindState;
  phoneState: EchoPhoneState;
  fullTimeCareer: FullTimeCareerState;
  starterOverrides: Record<string, StarterFurnitureOverride> = {};
  profileIdentity: CharacterIdentityTraits = {
    displayName: 'Riverside Learner',
    traitIds: ['dreamer', 'artisan', 'mediator'],
    desiredLifeId: 'creative_icon',
    valueIds: ['creativity', 'community'],
    likes: ['matcha', 'photography', 'rainy_days'],
    dislikes: ['crowded_fairs'],
  };
  private recentMindEvents: { ev: PlayerMindEvent; untilClock: number }[] = [];
  private lastV3VitalsSnap = { energy: 80, hunger: 80, hygiene: 80, mood: 80 };
  private lastTrackedCredits: number | null = null;
  private needs8AccumMin = 0;
  private recognitionAccumMin = 0;
  private readonly housePlan: HousePlan;

  // ── Walk-In Shower State Machine (A7 / A5 / A1) ──
  showerWaterOn = false;
  showeringActive = false;
  showerElapsedSec = 0;
  showerTargetKey: string | null = null;
  private showerCompletedCycle = false;
  private showerNeedsCarry = { hygiene: 0, energy: 0, fun: 0 };

  constructor(house: HousePlan, city: CityPlan, readonly owner: string, doors: DoorPort, doc: GameDoc | null,
    private readonly playerWalk?: import('../walk').LifeWalk) {
    this.housePlan = house;
    if (doc === null) this.s = V3.createGame(owner);
    else {
      try { this.s = V3.decode(doc.save, owner); }
      catch { throw new UnreadableGameSave('The saved Echo Life story could not be loaded.'); }
    }
    this.ownerSeed = hashOwnerSeed(owner);
    this.mindState = createInitialPlayerMindState(this.s.day, this.ownerSeed, {
      traitIds: this.profileIdentity.traitIds,
      desiredLifeId: this.profileIdentity.desiredLifeId,
      hour: Math.floor(((this.s.clock % 1440) + 1440) % 1440 / 60),
    });
    this.phoneState = createInitialPhoneState(this.s.day);
    this.fullTimeCareer = createInitialCareerState();

    this.nav = new LifeNav(house, city);
    const previousCar = this.s.worldV3.car as { yaw?: number; instanceId?: string } | undefined;
    this.car = new Automobile(this.nav.walk, doc?.places?.car, previousCar?.yaw, previousCar?.instanceId, this.s.worldV3.parkedCars);
    this.twoWheeler = new TwoWheeler(this.nav.walk, this.s.worldV3.parkedRides, doc?.places?.bike);
    this.s.player.driving = false;
    this.people = new PeopleSim(this.nav, doors);
    this.hotspots = buildHotspots(house, city, this.nav, playerWalk);
    this.residenceHotspots = buildResidenceHotspots(city);
    this.lanes = buildLanes(city, this.nav);
    this.trafficSim = new TrafficSim(this.nav.walk);
    this.traffic = this.trafficSim.agents;
    this.people.populate(this.s, doc?.places ?? null);
    const savedNpcSim = sanitizeNpcSim((this.s.worldV3 as Record<string, unknown>).npcSim);
    const hydrate = (this.people as { hydrateSim?: (sim: unknown) => void }).hydrateSim;
    if (savedNpcSim && typeof hydrate === 'function') {
      try { hydrate.call(this.people, savedNpcSim); } catch { /* ignore incompatible sim payload */ }
    }
    const savedLifeMeta = sanitizeLifeMeta((this.s.worldV3 as Record<string, unknown>).lifeMeta);
    if (savedLifeMeta) {
      for (const [id, until] of savedLifeMeta.buffs) {
        if (until > this.s.clock) this.moodletUntil.set(id, until);
      }
      for (const [id, until] of savedLifeMeta.moodlets ?? []) {
        if (until > this.s.clock) this.extMoodletUntil.set(id, until);
      }
      this.shiftCounts = { ...savedLifeMeta.tiers };
      if (savedLifeMeta.needs) {
        this.mindState.needs = sanitizeNeeds8(savedLifeMeta.needs);
      } else {
        this.mindState.needs = syncFromV3Vitals(this.mindState.needs, this.s.needs);
      }
      if (savedLifeMeta.urges) {
        this.mindState.urgesDay = savedLifeMeta.urges.day;
        this.mindState.aspirationPoints = savedLifeMeta.urges.pts;
        if (savedLifeMeta.urges.items.length > 0) this.mindState.urges = savedLifeMeta.urges.items;
      }
      if (savedLifeMeta.karma) {
        this.mindState.karma = savedLifeMeta.karma;
      }
      if (savedLifeMeta.subSkills) {
        for (const id of SUB_SKILL_IDS) {
          const entry = savedLifeMeta.subSkills[id];
          if (!entry) continue;
          const xp = Math.max(0, Math.floor(entry.pts));
          const level = subSkillLevelFromXp(xp);
          this.mindState.subSkills[id] = { xp, level, nextLevelXp: nextSubSkillThreshold(level) };
        }
      }
      if (savedLifeMeta.phoneMessages || savedLifeMeta.cityConfig) {
        this.phoneState = deserializePhoneState(
          {
            ...(savedLifeMeta.phoneMessages ?? {}),
            cityConfig: savedLifeMeta.cityConfig ?? defaultManageCityConfig(),
          },
          this.s.day,
        );
      }
      if (savedLifeMeta.schedule?.career) {
        this.fullTimeCareer = sanitizeFullTimeCareer(savedLifeMeta.schedule.career);
      }
      if (savedLifeMeta.starterFurniture) {
        this.starterOverrides = sanitizeStarterOverrides(savedLifeMeta.starterFurniture);
      }
      if (savedLifeMeta.traits?.length) this.profileIdentity.traitIds = [...savedLifeMeta.traits];
      if (savedLifeMeta.desiredLife) this.profileIdentity.desiredLifeId = savedLifeMeta.desiredLife;
      if (savedLifeMeta.values?.length) this.profileIdentity.valueIds = [...savedLifeMeta.values];
      if (savedLifeMeta.favorites) {
        if (savedLifeMeta.favorites.displayName) this.profileIdentity.displayName = savedLifeMeta.favorites.displayName;
        if (savedLifeMeta.favorites.likes?.length) this.profileIdentity.likes = [...savedLifeMeta.favorites.likes];
        if (savedLifeMeta.favorites.dislikes) this.profileIdentity.dislikes = [...savedLifeMeta.favorites.dislikes];
      }
    } else {
      this.mindState.needs = syncFromV3Vitals(this.mindState.needs, this.s.needs);
    }
    this.mindState = ensureDailyUrgesForDay(this.mindState, this.s.day, this.ownerSeed, {
      traitIds: this.profileIdentity.traitIds,
      desiredLifeId: this.profileIdentity.desiredLifeId,
      hour: Math.floor(((this.s.clock % 1440) + 1440) % 1440 / 60),
    });
    this.phoneState.cityConfig.cityKarma = this.mindState.karma.city;
    setTrafficDensityMultiplier(this.phoneState.cityConfig.trafficDensity ?? 0.9);
    setPedestrianDensityMultiplier(this.phoneState.cityConfig.pedestrianDensity ?? 1.0);
    this.lastV3VitalsSnap = {
      energy: this.s.needs.energy,
      hunger: this.s.needs.hunger,
      hygiene: this.s.needs.hygiene,
      mood: this.s.needs.mood,
    };
    this.lastTrackedCredits = this.s.progression.economy.credits;
    // The bicycle starts parked on the pavement by the front door (V3 parks it in the home garden; this world's garden is behind
    // the house, the front door is where a newcomer goes first). A saved place wins.
    const saved = doc?.places?.bike;
    const entrance = house.doors.find(d => d.id === 'entrance');
    const outside = entrance ? doorEnds(entrance).map(([x, z]) => ({ x, z })).find(p => this.nav.walk.zone(p) === 'street') : null;
    const park = saved && this.nav.walk.free(saved) ? saved : outside ? standNear(this.nav, 'street', { x: outside.x + 1.6, z: outside.z + .9 }) : null;
    this.bike = { x: park?.x ?? 0, z: park?.z ?? 0, yaw: 0 };
    this.s.player.riding = false;
    this.syncDynamicWorkshopSeats();
    if (!doc) this.dirty = true;
  }

  /** Sets safe clamped simulation speed (`0` Pause, `1` Normal, `2` Fast, `3` Ultra Fast). */
  setTimeScale(scale: number): TimeScale {
    const clamped = !Number.isFinite(scale) ? 1 : scale <= 0 ? 0 : scale >= 3 ? 3 : scale >= 2 ? 2 : 1;
    this.timeScale = clamped;
    return clamped;
  }

  /**
   * Registers static roadside curb-parked car footprints ONCE into both `TrafficSim` (MOBIL-lite bypass)
   * and `PeopleSim` (`setStaticCurbVehicles`) so per-frame dynamic vehicle ticks never clobber them.
   */
  registerCurbBoxes(boxes: readonly CurbBoxInput[]): void {
    this.trafficSim.registerCurbBoxes(boxes);
    this.staticCurbBuf.length = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const cx = b.x ?? (b.x0 + b.x1) * 0.5;
      const cz = b.z ?? (b.z0 + b.z1) * 0.5;
      const hx = b.hx ?? Math.abs(b.x1 - b.x0) * 0.5;
      const hz = b.hz ?? Math.abs(b.z1 - b.z0) * 0.5;
      this.staticCurbBuf.push({
        x: cx,
        z: cz,
        yaw: b.yaw ?? 0,
        halfWidth: hx,
        halfLength: hz,
        radius: Math.hypot(hx, hz),
      });
    }
    this.people.setStaticCurbVehicles(this.staticCurbBuf);
  }

  /** Sets Manage City street traffic density (`0.3..1.5` -> `3..10` mixed bikes, scooters, and cars). */
  setTrafficDensity(mult: number): number {
    const next = setTrafficDensityMultiplier(mult);
    this.phoneState.cityConfig.trafficDensity = next;
    return next;
  }

  getTrafficDensity(): number {
    return getTrafficDensityMultiplier();
  }

  get calendar() { return V3.getCalendar(this.s.clock); }
  get weather() { return V3.getWeather(this.s); }
  get tutorialStep() { return V3.getCurrentTutorialStep(this.s); }

  /** Read bounded NPC simulation memory persisted on `s.worldV3.npcSim` (if any). */
  getNpcSimSnapshot(): Record<string, unknown> | null {
    return sanitizeNpcSim((this.s.worldV3 as Record<string, unknown>).npcSim);
  }

  /** Store bounded NPC simulation memory (`<= 6.5 KB`, JSON-safe) for next save cycle. */
  setNpcSimSnapshot(snapshot: unknown): boolean {
    const safe = sanitizeNpcSim(snapshot);
    const w3 = this.s.worldV3 as Record<string, unknown>;
    if (!safe) {
      delete w3.npcSim;
      return false;
    }
    w3.npcSim = safe;
    this.dirty = true;
    return true;
  }

  /** Narrative save: V3's own format (positions normalised so V3's validator accepts them) + this world's places. */
  serialize(state = this.s): GameDoc {
    const copy = JSON.parse(JSON.stringify(state)) as V3State;
    copy.player = { ...copy.player, x: 0, z: 0, y: 0 };
    for (const n of Object.values(copy.npcs)) { n.x = 0; n.z = 0; n.path = []; n.target = null; }
    // V3 keeps a `_npcLodTick` and similar private counters on the state: never persisted.
    for (const k of Object.keys(copy)) if (k.startsWith('_')) delete (copy as Record<string, unknown>)[k];
    const car = copy.worldV3.car as { yaw: number; instanceId?: string };
    if (car) { car.yaw = this.car.pose.yaw; car.instanceId = this.car.spec?.instanceId; }
    copy.worldV3.parkedRides = this.twoWheeler.snapshot();
    copy.worldV3.parkedCars = this.car.snapshot();
    const serializer = (this.people as { serializeSim?: () => unknown }).serializeSim;
    const rawNpcSim = typeof serializer === 'function' ? serializer.call(this.people) : (copy.worldV3 as Record<string, unknown>).npcSim;
    const safeNpcSim = sanitizeNpcSim(rawNpcSim);
    if (safeNpcSim) (copy.worldV3 as Record<string, unknown>).npcSim = safeNpcSim;
    else delete (copy.worldV3 as Record<string, unknown>).npcSim;
    const safeLifeMeta = sanitizeLifeMeta(this.exportLifeMeta());
    if (safeLifeMeta) (copy.worldV3 as Record<string, unknown>).lifeMeta = safeLifeMeta;
    else delete (copy.worldV3 as Record<string, unknown>).lifeMeta;
    copy.player.driving = false;
    if (this.ridingShared) copy.player.riding = false;
    return { v: GAME_SAVE_VERSION, save: JSON.stringify(copy), places: { ...this.people.places(), car: { x: this.car.pose.x, z: this.car.pose.z }, bike: { x: +this.bike.x.toFixed(2), z: +this.bike.z.toFixed(2) } } };
  }

  say(text: string, tone: Feed['tone'] = 'info') {
    this.feed = [...this.feed.slice(-5), { id: ++this.feedId, text: cleanDisplayCopy(text), tone }];
  }

  /** Export bounded Wave 11 lifestyle metadata (`<= 28 KB`, allowlisted keys, zero forbidden keys) for save serialization. */
  private exportLifeMeta(): LifeMetaPayload {
    const now = this.s.clock;
    const buffs: [LifestyleMoodletId, number][] = [];
    for (const [id, until] of this.moodletUntil.entries()) {
      if (until > now) buffs.push([id, Math.round(until)]);
    }
    const moodlets: [string, number][] = [];
    for (const [id, until] of this.extMoodletUntil.entries()) {
      if (until > now) moodlets.push([id, Math.round(until)]);
    }
    const subSkills: Record<string, SerializedSubSkill> = {};
    for (const id of SUB_SKILL_IDS) {
      const sk = this.mindState.subSkills[id];
      subSkills[id] = { pts: Math.max(0, Math.floor(sk.xp)), lv: sk.level };
    }
    const serializedPhone = serializePhoneState(this.phoneState);
    const { cityConfig, ...phoneMessages } = serializedPhone;
    const emotion = this.playerEmotion();
    const districtRep = this.people.getAllDistrictReputation();

    return {
      v: 2,
      buffs: buffs.slice(0, 6),
      ...(moodlets.length > 0 ? { moodlets: moodlets.slice(0, 8) } : {}),
      tiers: { ...this.shiftCounts },
      lastComfort: this.computeHomeComfort().score,
      needs: { ...this.mindState.needs },
      emotions: {
        primary: emotion.primary,
        secondary: emotion.secondary,
        intensity: emotion.intensity,
      },
      urges: {
        day: this.mindState.urgesDay,
        pts: this.mindState.aspirationPoints,
        items: this.mindState.urges.slice(0, 3),
      },
      karma: {
        ...this.mindState.karma,
        recentLog: this.mindState.karma.recentLog.slice(-8),
      },
      subSkills,
      phoneMessages,
      cityConfig,
      schedule: { career: { ...this.fullTimeCareer } },
      ...(Object.keys(this.starterOverrides).length > 0 ? { starterFurniture: { ...this.starterOverrides } } : {}),
      traits: this.profileIdentity.traitIds.slice(0, 3),
      desiredLife: this.profileIdentity.desiredLifeId,
      values: this.profileIdentity.valueIds.slice(0, 3),
      favorites: {
        displayName: this.profileIdentity.displayName,
        likes: this.profileIdentity.likes.slice(0, 5),
        dislikes: this.profileIdentity.dislikes.slice(0, 5),
      },
      districtRep,
      updatedAt: Date.now(),
    };
  }

  /** Updates room cleanliness (0..1) fed from Study Space room care, influencing Home Comfort Score. */
  setHomeCleanliness(cleanliness: number) {
    if (Number.isFinite(cleanliness)) this.homeCleanliness = clamp(cleanliness, 0, 1);
  }

  /** Computes deterministic Home Comfort Score (0–100) from owned furniture, room styles, residence tier, and care. */
  computeHomeComfort(cleanliness = this.homeCleanliness): HomeComfortSummary {
    const p = this.s.progression;
    const base = 28;
    const placedCategories = new Set<string>();
    let upgradePts = 0;
    for (const o of p.ownedObjects) {
      if (o.location.inStorage || !o.location.zoneId || o.category.startsWith('vehicle')) continue;
      const isStarter = o.instanceId.startsWith('obj_starter_');
      if (!isStarter) placedCategories.add(o.category);
      if (o.upgradeLevel > 0) upgradePts += o.upgradeLevel * 3;
      if (
        o.selectedVariantId === 'sofa_veranda' ||
        o.selectedVariantId === 'sofa_palais' ||
        o.selectedVariantId === 'bath_tub_veranda' ||
        o.selectedVariantId === 'bed_canopy_palais'
      ) {
        upgradePts += 3;
      }
    }
    const furnishings = Math.min(28, Math.min(5, placedCategories.size) * 4 + upgradePts);
    const styledCount = Object.values(p.roomStyles ?? {}).filter(
      st => Boolean(st) && st !== 'budget_student' && st !== 'default',
    ).length;
    const styles = Math.min(14, Math.min(3, styledCount) * 5);
    const activeProp = String(p.properties?.activePropertyId ?? 'prop_student_flat');
    const property = /palais|mansion|villa|riviera/i.test(activeProp)
      ? 18
      : activeProp && activeProp !== 'prop_student_flat'
        ? 10
        : 0;
    const cleanPts = Math.round(clamp(cleanliness, 0, 1) * 12);
    const score = Math.round(clamp(base + furnishings + styles + property + cleanPts, 0, 100));
    const tier: HomeComfortTier =
      score >= 90 ? 'Riverside Showcase'
      : score >= 70 ? 'Designer Sanctuary'
      : score >= 45 ? 'Inviting Home'
      : 'Cozy Starter';
    const restMultiplier =
      score >= 90 ? 1.32
      : score >= 70 ? 1.22
      : score >= 45 ? 1.10
      : 1.0;
    const focusBonus =
      score >= 90 ? 0.18
      : score >= 70 ? 0.12
      : score >= 45 ? 0.05
      : 0;
    return {
      score,
      tier,
      restMultiplier,
      focusBonus,
      breakdown: { base, furnishings, styles, property, cleanliness: cleanPts },
    };
  }

  /** Grants or refreshes a Lifestyle Moodlet for `durationMinutes` in-game minutes. */
  grantMoodlet(id: LifestyleMoodletId, durationMinutes: number) {
    const until = this.s.clock + Math.max(15, durationMinutes);
    const prev = this.moodletUntil.get(id) ?? 0;
    if (until > prev) {
      this.moodletUntil.set(id, until);
      this.dirty = true;
    }
  }

  /** Grants or refreshes an extended culinary/lifestyle moodlet (Wave 11) cleanly alongside the 6 core moodlets. */
  grantAnyMoodlet(id: string, durationMinutes: number) {
    if (Object.hasOwn(MOODLET_CATALOG, id)) {
      this.grantMoodlet(id as LifestyleMoodletId, durationMinutes);
      return;
    }
    if (!Object.hasOwn(EXT_MOODLET_META, id)) return;
    const until = this.s.clock + Math.max(15, durationMinutes);
    const prev = this.extMoodletUntil.get(id) ?? 0;
    if (until > prev) {
      this.extMoodletUntil.set(id, until);
      this.dirty = true;
    }
  }

  private allActiveMoodletIds(): string[] {
    const now = this.s.clock;
    const out: string[] = [];
    for (const [id, until] of this.moodletUntil.entries()) {
      if (until > now) out.push(id);
    }
    for (const [id, until] of this.extMoodletUntil.entries()) {
      if (until > now) out.push(id);
      else this.extMoodletUntil.delete(id);
    }
    return out;
  }

  hasMoodlet(id: LifestyleMoodletId): boolean {
    const until = this.moodletUntil.get(id);
    return until !== undefined && until > this.s.clock;
  }

  /** Active Lifestyle Moodlets (sorted by remaining duration, max 6). */
  activeMoodlets(): ActiveMoodlet[] {
    const now = this.s.clock;
    const out: ActiveMoodlet[] = [];
    for (const [id, until] of this.moodletUntil.entries()) {
      if (until <= now) {
        this.moodletUntil.delete(id);
        continue;
      }
      const meta = MOODLET_CATALOG[id];
      out.push({
        id,
        label: meta.label,
        effect: meta.effect,
        tone: meta.tone,
        minutesRemaining: Math.max(1, Math.round(until - now)),
      });
    }
    return out.sort((a, b) => b.minutesRemaining - a.minutesRemaining);
  }

  /** Pure read-only derivation of the 6 Resident Relationship Perks from V3 relationships. */
  residentPerks(): ResidentPerk[] {
    return RESIDENT_PERK_DEFS.map(def => {
      const rel = this.s.npcs[def.npcId]?.rel;
      const unlocked = Boolean(rel && (rel.friendship >= 50 || (rel.memories?.length ?? 0) >= 3));
      return {
        npcId: def.npcId,
        npcName: V3.CHARACTERS[def.npcId]?.name ?? def.npcId,
        title: def.title,
        effect: def.effect,
        unlocked,
      };
    });
  }

  hasPerk(npcId: string): boolean {
    const rel = this.s.npcs[npcId]?.rel;
    return Boolean(rel && (rel.friendship >= 50 || (rel.memories?.length ?? 0) >= 3));
  }

  /** Career mastery tier metadata for a given shift (back-compat `tier 1..3`, lead NPC, signature micro-interaction). */
  shiftMeta(jobId: string): CareerTierInfo | null {
    const job = JOB_RECORD[jobId];
    if (!job) return null;
    const serverTiers = (this.s.progression as unknown as { careerTiers?: Record<string, { shifts?: number }> }).careerTiers;
    const shifts = Math.max(this.shiftCounts[jobId] ?? 0, serverTiers?.[jobId]?.shifts ?? 0);
    const tier: 1 | 2 | 3 = shifts >= 8 ? 3 : shifts >= 3 ? 2 : 1;
    return {
      jobId,
      title: cleanDisplayCopy(job.title ?? jobId),
      shifts,
      tier,
      leadNpc: job.leadNpc ?? 'linh',
      skill: job.skill ?? 'social',
      microKind: job.microKind ?? 'espresso',
      microPrompt: cleanDisplayCopy(job.microPrompt ?? 'Complete the shift station carefully'),
    };
  }

  /**
   * Executes one part-time job shift step against the authoritative server workshop (`EchoLifeWorkshop.java`).
   * Supports optional `quality?: 'ok' | 'great' | 'perfect'`, visibly replenishes Sunrise Market shelf stock
   * on `market` step 2 (`shelf`), and cleanly records shift completion once on finish.
   */
  async runShift(
    jobId: string,
    zoneId: string,
    stationId: string,
    quality?: 'ok' | 'great' | 'perfect',
    saver?: GameSaver | null,
  ): Promise<V3Result & { shiftCompleted?: boolean }> {
    if (!Object.hasOwn(JOB_RECORD, jobId)) {
      return { ok: false, msg: 'Shift is not available.' };
    }
    const wasActive = this.activeShift;
    const creditsBefore = this.s.progression.economy.credits;
    const action: WorkshopAction & { quality?: 'ok' | 'great' | 'perfect' } = {
      type: 'job_step',
      jobId,
      zoneId,
      station: stationId,
      ...(quality ? { quality } : {}),
    };
    if (!saver) {
      return { ok: false, msg: 'Connect to the campus server to run part-time shifts.' };
    }
    const res = await saver.configure(action);
    if (!res.ok) return { ok: false, msg: cleanDisplayCopy(res.msg) };

    // On Sunrise Market step 2 (`shelf`) completion, visibly refill depleted market shelf stock so MarketStock reflects restock!
    if (jobId === 'market' && stationId === 'shelf') {
      for (const k of Object.keys(V3.products)) {
        this.s.stock[k] = Math.max(this.s.stock[k] ?? 0, 8);
      }
      this.entityCache.clear();
      this.say('Restocked the Sunrise Market produce and grocery shelves.', 'good');
      this.dirty = true;
    }

    const shiftCompleted = Boolean(wasActive && !this.activeShift);
    if (shiftCompleted) {
      const mappedQuality: ShiftQuality = quality === 'perfect' ? 'perfect' : quality === 'great' ? 'great' : 'standard';
      const earned = Math.max(0, this.s.progression.economy.credits - creditsBefore);
      if (earned > 0) {
        const title = cleanDisplayCopy(JOB_RECORD[jobId]?.title ?? jobId);
        this.recordCreditChange(`${title} Shift`, earned, this.s.progression.economy.credits);
      }
      this.recordShiftCompletion(jobId, mappedQuality);
    }
    return { ok: true, msg: cleanDisplayCopy(res.msg), shiftCompleted };
  }

  /** Records shift completion quality bonus, 5-tier career progress, urges, karma, sub-skills, and ONE coworker memory. */
  recordShiftCompletion(jobId: string, quality: ShiftQuality | 'ok' = 'standard'): {
    tier: 1 | 2 | 3;
    careerTier5: 1 | 2 | 3 | 4 | 5;
    rankTitle: string;
    promoted: boolean;
    shifts: number;
    quality: ShiftQuality;
    bonusNote: string;
  } {
    const normQuality: ShiftQuality = quality === 'perfect' ? 'perfect' : quality === 'great' ? 'great' : 'standard';
    const meta = this.shiftMeta(jobId);
    const prevShifts = this.shiftCounts[jobId] ?? 0;
    const shifts = prevShifts + 1;
    this.shiftCounts[jobId] = shifts;
    const tier: 1 | 2 | 3 = shifts >= 8 ? 3 : shifts >= 3 ? 2 : 1;

    let careerTier5: 1 | 2 | 3 | 4 | 5 = 1;
    let rankTitle = 'Trainee';
    let promoted = false;
    if (PART_TIME_JOB_IDS.includes(jobId as PartTimeJobId)) {
      const prevStatus = getPartTimeCareerStatus(jobId as PartTimeJobId, prevShifts);
      const nextStatus = getPartTimeCareerStatus(jobId as PartTimeJobId, shifts);
      careerTier5 = nextStatus.tier;
      rankTitle = nextStatus.rankTitle;
      promoted = nextStatus.tier > prevStatus.tier;
    }

    const n = this.s.needs;
    const moodGain = normQuality === 'perfect' ? 12 : normQuality === 'great' ? 6 : 3;
    const focusGain = normQuality === 'perfect' ? 8 : normQuality === 'great' ? 4 : 0;
    n.mood = clamp(n.mood + moodGain, 0, 100);
    n.focus = clamp(n.focus + focusGain, 0, 100);

    // Wave 11 Needs8, Sub-Skills, Urges, Karma, and Promotion Campus Feed integration
    this.applyActivityNeeds('complete_shift');
    const subId = SHIFT_SUB_SKILL[jobId];
    if (subId) {
      this.gainSubSkillXp(subId, normQuality === 'perfect' ? 26 : normQuality === 'great' ? 20 : 14);
    }
    this.triggerUrgeEvent('complete_shift', jobId);
    if (normQuality === 'perfect' || normQuality === 'great') {
      this.applyKarma('shift_excellence');
    } else {
      this.adjustKarma(3, 2, `Finished ${meta?.title ?? jobId} shift`, 'shift_complete');
    }
    if (promoted) {
      this.pushMindEvent('promotion', 1.2);
      this.emitMilestoneFeedPost('shift_promotion');
      this.say(`Promoted to ${rankTitle} in ${meta?.title ?? jobId}!`, 'story');
    }

    if (jobId === 'barista') this.grantMoodlet('caffeinated', 240);
    else if (jobId === 'gardener') this.grantMoodlet('tea_calm', this.hasPerk('ngocbich') ? 480 : 240);
    else if (jobId === 'busker' || jobId === 'delivery') this.grantMoodlet('hot_streak', 180);

    const zone = String(JOB_RECORD[jobId]?.steps[0]?.[0] ?? this.s.player.zone ?? 'street');
    this.people.recordShiftMemory(this.s, jobId, zone, normQuality);
    if (jobId === 'busker' && this.lastBody) {
      this.people.notifyBuskerPerformance(this.s, this.lastBody.x, this.lastBody.z, zone);
    }

    const qLabel = normQuality === 'perfect' ? 'Perfect craft' : normQuality === 'great' ? 'Great pace' : 'Solid shift';
    const bonusNote = `${meta?.title ?? jobId} (${qLabel} · ${rankTitle}): +${moodGain} Mood${focusGain ? `, +${focusGain} Focus` : ''}.`;
    this.say(bonusNote, 'good');
    this.dirty = true;
    return { tier, careerTier5, rankTitle, promoted, shifts, quality: normQuality, bonusNote };
  }

  private onDayRollover(nextDay: number) {
    const s = this.s;
    s.day = nextDay;
    for (const k of Object.keys(V3.products)) s.stock[k] = 8;
    resetDailyEconomyIfNeeded(s);
    this.mindState = ensureDailyUrgesForDay(this.mindState, nextDay, this.ownerSeed, {
      traitIds: this.profileIdentity.traitIds,
      desiredLifeId: this.profileIdentity.desiredLifeId,
      hour: Math.floor(((s.clock % 1440) + 1440) % 1440 / 60),
    });
    const w = this.weather;
    const weatherKind: 'sunny' | 'rain' | 'snow' =
      /snow/i.test(w.label) ? 'snow' : w.rain ? 'rain' : 'sunny';
    const freshPosts = generateCampusFeedPosts(nextDay, {
      weather: weatherKind,
      seasonIndex: (Math.floor(nextDay / 7) % 4) as 0 | 1 | 2 | 3,
      playerName: this.profileIdentity.displayName,
      clock: s.clock % 1440,
    });
    this.phoneState = addFeedPosts(this.phoneState, freshPosts);
    this.dirty = true;
  }

  /** Synchronizes the game's clock/day smoothly with a shared multiplayer world clock without reversing daily progress. */
  syncSharedClock(sharedMinute: number) {
    if (!Number.isFinite(sharedMinute) || sharedMinute < 0) return;
    const s = this.s;
    const nextDay = Math.floor(sharedMinute / 1440);
    s.clock = sharedMinute;
    if (nextDay > s.day) {
      this.onDayRollover(nextDay);
    }
  }

  // ── Time ────────────────────────────────────────────────────────────────────────────────────────────────
  /**
   * V3's `tick` minus what this world does itself (the body moves with the HumanRig, residents walk with `people.ts`):
   * game clock (48 real minutes per game day), day rollover, 8-need decay + V3 vital bridge, the stove and busy timers.
   */
  tick(
    dt: number,
    body: P | null,
    extra: {
      routeBudget?: number;
      running?: boolean;
      seated?: boolean;
      env?: DailyEnvContext;
      sharedMinute?: number | null;
      cleanliness?: number;
    } = {},
  ) {
    const s = this.s;
    const rawDt = Math.min(.1, Math.max(0, dt));
    const simDt = rawDt * this.timeScale;
    if (extra.cleanliness !== undefined && Number.isFinite(extra.cleanliness)) {
      this.homeCleanliness = clamp(extra.cleanliness, 0, 1);
    }

    // Track body zone even while paused (`timeScale === 0`) so focus/navigation stay coherent
    if (simDt <= 0) {
      if (body) {
        const zone = (this.playerWalk ?? this.nav.walk).zone(body) ?? this.lastZone;
        this.lastBody = { x: body.x, z: body.z };
        if (zone && zone !== this.lastZone) this.enterZone(zone, this.lastZone === null);
      }
      return;
    }

    s.elapsed += simDt;
    const prevClock = s.clock;
    if (extra.sharedMinute != null && Number.isFinite(extra.sharedMinute)) {
      this.syncSharedClock(extra.sharedMinute);
    } else {
      s.clock += simDt * (1440 / (WORLD_DAY_MINUTES * 60));
      if (Math.floor(s.clock / 1440) > s.day) {
        this.onDayRollover(Math.floor(s.clock / 1440));
      }
    }
    const gameMinutesDelta = Math.max(0, Math.min(60, s.clock - prevClock));

    // Expire old emotion spike events
    if (this.recentMindEvents.length > 0) {
      this.recentMindEvents = this.recentMindEvents.filter(e => e.untilClock > s.clock);
    }

    const n = s.needs;
    // Pull any external V3 direct vital mutations (e.g. V3 sleep/eat/shower interact) into Needs8 before ticking
    if (
      Math.abs(n.energy - this.lastV3VitalsSnap.energy) > 0.5 ||
      Math.abs(n.hunger - this.lastV3VitalsSnap.hunger) > 0.5 ||
      Math.abs(n.hygiene - this.lastV3VitalsSnap.hygiene) > 0.5 ||
      Math.abs(n.mood - this.lastV3VitalsSnap.mood) > 0.5
    ) {
      this.mindState.needs = syncFromV3Vitals(this.mindState.needs, n);
    }

    const comfort = this.computeHomeComfort();
    const curZone = this.lastZone ?? s.player.zone;
    const atHome = HOME_ZONES.has(curZone);
    if (atHome && comfort.score >= 70) {
      // Sustain Inspired Space while at home and keep 3 game hours after stepping outside
      this.moodletUntil.set('inspired_space', Math.max(this.moodletUntil.get('inspired_space') ?? 0, s.clock + 180));
    }
    const isRain = extra.env?.rain ?? this.weather.rain;
    if (isRain && COZY_INDOOR_ZONES.has(curZone)) {
      this.moodletUntil.set('rain_cozy', Math.max(this.moodletUntil.get('rain_cozy') ?? 0, s.clock + 45));
    }

    const wellRested = this.hasMoodlet('well_rested');
    const inspired = this.hasMoodlet('inspired_space');
    const caffeinated = this.hasMoodlet('caffeinated');
    const teaCalm = this.hasMoodlet('tea_calm');
    const rainCozy = this.hasMoodlet('rain_cozy');
    const hotStreak = this.hasMoodlet('hot_streak');

    const sprintingOnFoot = !!extra.running && !this.riding && !this.drivenVehicle;
    const isSeatedNow = Boolean(extra.seated || this.people.playerSeat);
    const outdoorsNow = Boolean(this.lastZone && V3.zones[this.lastZone]?.outdoors);

    // Advance all 8 core needs smoothly with the game clock (`hygiene`, `bathroom`, `fun`, `social`, `sleep`, `recognition`, `hunger`, `energy`).
    // Accumulate game minutes so `advanceNeeds8`'s 0.1-precision rounding never stalls decay at 60–240 FPS.
    if (gameMinutesDelta > 0) {
      this.needs8AccumMin += gameMinutesDelta;
      this.recognitionAccumMin += gameMinutesDelta;
      if (this.needs8AccumMin >= 2.0) {
        const batchMin = this.needs8AccumMin;
        this.needs8AccumMin = 0;
        this.mindState.needs = advanceNeeds8(this.mindState.needs, batchMin, {
          sprinting: sprintingOnFoot,
          seated: isSeatedNow,
          socializing: Boolean(this.people.talking),
          working: Boolean(this.activeShift),
          inRainOutdoors: Boolean(isRain && outdoorsNow),
          wellRested,
        });
      }
      if (this.recognitionAccumMin >= 12.5) {
        const steps = Math.floor(this.recognitionAccumMin / 12.5);
        this.recognitionAccumMin -= steps * 12.5;
        if (this.mindState.needs.recognition > 35) {
          this.mindState.needs.recognition = Math.max(
            35,
            Math.round((this.mindState.needs.recognition - steps * 0.1) * 10) / 10,
          );
        }
      }
    }

    let energyDrain = sprintingOnFoot ? .024 : .007;
    if (wellRested) energyDrain *= 0.80;
    if (caffeinated && !sprintingOnFoot) energyDrain *= 0.92;
    if (sprintingOnFoot && outdoorsNow && this.hasPerk('minh')) {
      energyDrain *= 0.85;
    }
    // Keep V3's 6 vitals cleanly bridged with Needs8 + moodlet bonuses
    const projected = projectToV3Vitals(this.mindState.needs, n);
    n.hunger = projected.hunger;
    n.hygiene = projected.hygiene;
    n.energy = clamp(Math.min(projected.energy, n.energy - simDt * energyDrain + (isSeatedNow ? 10 : 0)), 0, 100);
    if (sprintingOnFoot && outdoorsNow) {
      const fitRate = hotStreak ? .0044 : .004;
      n.fitness = clamp(n.fitness + simDt * fitRate, 0, 100);
    }
    // Gentle hourly Lifestyle Moodlet benefits (scaled to real seconds at 48 real min = 24 game hrs -> 1 game hr = 120 s)
    const gameHrs = simDt / 120;
    if (inspired) {
      n.mood = clamp(n.mood + gameHrs * 4, 0, 100);
      if (n.focus < 80) n.focus = clamp(n.focus + gameHrs * 2.5, 0, 80);
    }
    if (rainCozy && isRain && COZY_INDOOR_ZONES.has(curZone)) {
      n.mood = clamp(n.mood + gameHrs * 6, 0, 100);
      n.focus = clamp(n.focus + gameHrs * 6, 0, 100);
    }
    if (caffeinated && n.focus < 62) {
      n.focus = clamp(n.focus + simDt * 0.08, 0, 62);
    }
    if (teaCalm && n.mood < 75) {
      n.mood = clamp(n.mood + gameHrs * 3.5, 0, 75);
    }
    if (hotStreak && n.mood < 78) {
      n.mood = clamp(n.mood + gameHrs * 3, 0, 78);
    }
    if (isSeatedNow) {
      const luxurySofa = s.progression.ownedObjects.some(
        o => o.selectedVariantId === 'sofa_veranda' || o.selectedVariantId === 'sofa_palais',
      );
      const mult = Math.max(comfort.restMultiplier, luxurySofa ? 1.3 : 1);
      if (n.energy < 90) n.energy = clamp(n.energy + simDt * 1.8 * mult, 0, 90);
      if (n.mood < 85) n.mood = clamp(n.mood + simDt * 0.9 * mult, 0, 85);
      this.mindState.needs = applyNeedDeltas(this.mindState.needs, {
        energy: simDt * 1.4 * mult,
        fun: simDt * 0.45 * mult,
      });
    } else {
      // Blend derived mood softly so V3 mood reflects hygiene/bathroom/fun/social too
      n.mood = clamp(n.mood + (projected.mood - n.mood) * Math.min(1, simDt * 0.15), 0, 100);
      n.focus = clamp(n.focus + (projected.focus - n.focus) * Math.min(1, simDt * 0.12), 0, 100);
    }
    this.mindState.needs.energy = Math.round(n.energy * 10) / 10;
    this.lastV3VitalsSnap = { energy: n.energy, hunger: n.hunger, hygiene: n.hygiene, mood: n.mood };
    this.tickShower(rawDt, body);

    if (n.energy < 15 && s.elapsed - this.lastTiredHint > 120) {
      this.lastTiredHint = s.elapsed;
      this.say('Feeling low on energy — rest on a sofa, brew tea, or grab a bite at Willow Bistro.', 'info');
    }
    if (n.hunger < 15 && s.elapsed - this.lastHungryHint > 120) {
      this.lastHungryHint = s.elapsed;
      this.say('Getting hungry — cook at home or visit Sunrise Market or Willow Bistro.', 'info');
    }
    if (s.pot && !s.pot.ready && s.elapsed >= s.pot.at) { s.pot.ready = true; this.say('Your meal is ready on the stove.', 'good'); }
    if (s.busy && s.elapsed >= s.busy.until) s.busy = null;
    if (body) {
      const zone = (this.playerWalk ?? this.nav.walk).zone(body) ?? this.lastZone;
      if (this.lastBody) {
        const d = Math.hypot(body.x - this.lastBody.x, body.z - this.lastBody.z);
        if (d > .002 && d < 3) V3.recordTutorialSignal(s, 'move', d);
        if (this.riding || this.twoWheeler.driving) this.rideStep(body, d / Math.max(simDt, 1e-3), simDt);
      }
      this.lastBody = { x: body.x, z: body.z };
      if (zone && zone !== this.lastZone) this.enterZone(zone, this.lastZone === null);
      if (s.challenge?.type === 'sport') {
        let nearestHoop = Infinity;
        for (const h of this.hotspots) {
          if (h.action !== 'sport') continue;
          const d = Math.hypot(h.at.x - body.x, h.at.z - body.z);
          if (d < nearestHoop) nearestHoop = d;
        }
        if (nearestHoop <= 14) this.wasOnCourt = true;
        else if (this.wasOnCourt && nearestHoop > 14) this.leaveBasketballCourt();
      } else {
        this.wasOnCourt = false;
      }
    }
    const curMinute = Math.floor(s.clock);
    if (curMinute !== this.lastEventMinute && s.elapsed > 1.5) {
      this.lastEventMinute = curMinute;
      const notices = collectDailyAnnouncements(this.dailyEvents(extra.env), this.announcedEvents);
      for (const msg of notices) this.say(msg, 'story');
    }

    // Step Right-Hand TrafficSim fleet (3..10 mixed bikes/scooters/cars) with real `effectiveHazardSpeed` (`0` at stops!)
    this.lastRawDt = rawDt;
    this.parkedVehiclesBuf.length = 0;
    for (const veh of [this.car, this.twoWheeler] as const) {
      if (!veh.spec || veh.driving) continue;
      const fp = veh.getFootprint();
      if (fp) {
        this.parkedVehiclesBuf.push(fp);
      }
    }

    let playerVehHazard: VehicleHazard | null = null;
    const driven = this.drivenVehicle;
    if (driven) {
      const spd = Math.abs(driven.speed);
      this.playerVehHazardScratch.x = driven.pose.x;
      this.playerVehHazardScratch.z = driven.pose.z;
      this.playerVehHazardScratch.vx = Math.sin(driven.pose.yaw) * driven.speed;
      this.playerVehHazardScratch.vz = Math.cos(driven.pose.yaw) * driven.speed;
      this.playerVehHazardScratch.speed = spd;
      this.playerVehHazardScratch.radius = driven.spec?.collisionRadius ?? (this.car.driving ? 1.25 : 0.72);
      this.playerVehHazardScratch.hornActive = driven.lights.hornActive;
      playerVehHazard = this.playerVehHazardScratch;
    } else if (this.riding && body) {
      this.playerVehHazardScratch.x = body.x;
      this.playerVehHazardScratch.z = body.z;
      this.playerVehHazardScratch.vx = 0;
      this.playerVehHazardScratch.vz = 0;
      this.playerVehHazardScratch.speed = 0;
      this.playerVehHazardScratch.radius = 0.65;
      this.playerVehHazardScratch.hornActive = false;
      playerVehHazard = this.playerVehHazardScratch;
    }

    const cal = this.calendar;
    const isSnow = extra.env?.snow ?? /snow/i.test(this.weather.label);
    this.trafficEnvScratch.dayWeight = this.daylight();
    this.trafficEnvScratch.rainWeight = isRain ? 0.75 : 0;
    this.trafficEnvScratch.snowWeight = isSnow ? 0.75 : 0;

    const tCtx = this.trafficCtxScratch;
    tCtx.env = this.trafficEnvScratch;
    tCtx.phase = cal.phase;
    tCtx.playerPos = body;
    tCtx.playerVehicle = playerVehHazard;
    tCtx.residents = this.people.getResidentKinematics();
    tCtx.crowd = this.lastCrowdPassers;
    tCtx.parkedVehicles = this.parkedVehiclesBuf;
    tCtx.densityMultiplier = this.phoneState.cityConfig.trafficDensity ?? getTrafficDensityMultiplier();

    const trafficDt = Math.min(0.1, rawDt * Math.min(1.5, this.timeScale));
    this.trafficSim.step(trafficDt, isRain, tCtx as TrafficStepContext);

    // Real moving traffic hazards only (`effectiveHazardSpeed === 0` vehicles are excluded & moved to `stoppedFootprints`)
    this.people.setTrafficVehicles(this.trafficSim.activeHazards);

    // Combine dynamic parked vehicles (`car`, `twoWheeler`, stopped traffic); `staticCurbVehicles` stay preserved!
    const stopped = this.trafficSim.stoppedFootprints;
    for (let i = 0; i < stopped.length; i++) {
      this.parkedVehiclesBuf.push(stopped[i]);
    }
    this.people.setParkedVehicles(this.parkedVehiclesBuf);

    // Publish moving vehicles (player + active AI traffic) into CrowdSim for curb yielding
    this.combinedActiveVehicles.length = 0;
    if (playerVehHazard && (playerVehHazard.speed ?? 0) >= 0.25) {
      this.combinedActiveVehicles.push(playerVehHazard);
    }
    const activeTraffic = this.trafficSim.activeHazards;
    for (let i = 0; i < activeTraffic.length; i++) {
      this.combinedActiveVehicles.push(activeTraffic[i]);
    }
    setCrowdActiveVehicles(this.combinedActiveVehicles.length > 0 ? this.combinedActiveVehicles : null);

    this.people.step(s, Math.min(0.1, simDt), body, extra.routeBudget ?? 2);
  }

  /** Walking into a zone through the real world does what V3's door did: discovery, story events, tutorial signals. */
  private enterZone(zone: V3ZoneId, first: boolean) {
    const s = this.s;
    this.lastZone = zone;
    s.player.zone = zone;
    if (first) return;
    const before = this.snap();
    V3.recordTutorialSignal(s, 'changedZone');
    const lm = V3.discoverZone(s, zone);
    if (lm) {
      V3.record(s, 'discover:' + zone);
      V3.recordTutorialSignal(s, 'exploredFree');
      this.say(`${V3_ZONE_META[zone].name.en} · Discovered landmark: ${lm.name}!`, 'good');
    }
    this.report('enter:' + zone, before);
    this.dirty = true;
  }

  // ── The bicycle (V3 `vehicles/bicycle.mjs` rules in this world) ─────────────────────────────────────────
  private rideStep(body: P, speed: number, dt: number) {
    const s = this.s;
    if (this.riding && !this.ridingShared) { this.bike.x = body.x; this.bike.z = body.z; }
    const region = this.nav.walk.surface(body)?.region ?? '';
    if (!RIDEABLE.has(region)) { this.dismount(body, 0, 'Park your bicycle outside first.'); return; }
    // V3: riding faster than 1.5 m/s teaches the tutorial step and earns Mobility XP every 4 s (Greenway counts as a ride).
    if (speed > 1.5) {
      V3.recordTutorialSignal(s, 'rodeVehicle');
      this.rideAccum += dt;
      if (this.rideAccum >= 4) {
        const before = this.snap();
        this.rideAccum = 0;
        V3.awardSkillXp(s, 'mobility', 8);
        if (s.player.zone === 'greenway') V3.record(s, 'activity:greenway_drive');
        this.report('ride', before);
        this.dirty = true;
      }
    }
  }

  roadPractice() {
    V3.record(this.s, 'activity:greenway_drive');
    this.dirty = true;
  }

  /** Get on (V3: free hands, within 2.4 m) — the body rides from where it stands. */
  mount(body: P, sharedBike?: P): V3Result {
    if (this.riding || this.drivenVehicle) return { ok: false, msg: 'You are already riding.' };
    if (this.s.held) return { ok: false, msg: 'Put down what you are carrying first.' };
    const at = sharedBike ?? this.bike;
    if (Math.hypot(body.x - at.x, body.z - at.z) > 2.4) return { ok: false, msg: 'Come closer to the bicycle.' };
    this.ridingShared = !!sharedBike;
    this.riding = true; this.s.player.riding = true;
    V3.recordTutorialSignal(this.s, 'interactedObject');
    const r = { ok: true, msg: 'Ride with W A S D (Shift for speed). Press E to get off.' };
    this.say(r.msg);
    this.dirty = true;
    return r;
  }

  /** Get off: the bicycle stays where the body stopped. */
  dismount(body: P, yaw: number, why?: string): V3Result {
    if (!this.riding) return { ok: false, msg: 'You are not riding.' };
    this.riding = false; this.s.player.riding = false;
    if (!this.ridingShared) this.bike = { x: body.x, z: body.z, yaw };
    this.ridingShared = false;
    const r = { ok: true, msg: why ?? 'Bicycle parked.' };
    this.say(r.msg, why ? 'bad' : 'info');
    this.dirty = true;
    return r;
  }

  // ── Targets ─────────────────────────────────────────────────────────────────────────────────────────────
  /** V3's entity list for a zone (props as V3 sees them right now), cached a quarter second. */
  private entities(zone: string): V3Entity[] {
    const now = this.s.elapsed, hit = this.entityCache.get(zone);
    if (hit && now - hit.at < .25) return hit.list;
    const keep = this.s.player.zone;
    this.s.player.zone = zone;
    let list: V3Entity[] = [];
    try { list = V3.entities(this.s); } catch { list = []; }
    this.s.player.zone = keep;
    this.entityCache.set(zone, { at: now, list });
    return list;
  }

  // ── Walk-In Shower, Living Room TV, and Dynamic Workshop Seat Sync (A7 / A8 / A2) ──────────────────────

  /** Returns whether the living room television is currently switched on. */
  get isTvOn(): boolean {
    return Boolean(this.s.flags['living:tv'] ?? this.s.flags['living/tv']);
  }

  /** Synchronizes Workshop placed sofas/chairs with `PeopleSim.seats` whenever `ownedObjects` or `starterOverrides` change. */
  syncDynamicWorkshopSeats(): void {
    const hook = (this.people as {
      rebuildDynamicWorkshopSeats?: (
        ownedObjects: V3State['progression']['ownedObjects'],
        starterOverrides: Readonly<Record<string, StarterFurnitureOverride>>,
        walk: import('../walk').LifeWalk,
      ) => void;
    }).rebuildDynamicWorkshopSeats;
    if (typeof hook === 'function') {
      try {
        hook.call(this.people, this.s.progression.ownedObjects, this.starterOverrides, this.playerWalk ?? this.nav.walk);
      } catch {
        // Safe fallback while sibling module signatures settle
      }
    }
  }

  /** Resolves exact SE walk-in shower enclosure coordinates for any room size (`4..9 m`) or Market Boulevard residence. */
  getShowerEnclosure(targetKey = this.showerTargetKey): ShowerEnclosurePoints {
    if (targetKey && targetKey.startsWith('prop_')) {
      const rh = this.residenceHotspots.find(h => h.key === targetKey);
      if (rh) {
        return {
          stand: { x: rh.stand.x, y: rh.y, z: rh.stand.z },
          nozzle: { x: rh.at.x, y: rh.y + 2.18, z: rh.at.z },
          mixer: { x: rh.at.x, y: rh.y + 1.15, z: rh.at.z },
          stepOut: { x: rh.stand.x, y: rh.y, z: rh.stand.z },
          facingYaw: 0,
        };
      }
    }
    const bathZone = this.housePlan.zones.find(z => z.id === 'bath');
    const y = bathZone?.y ?? 0;
    const x1 = bathZone?.rect.x1 ?? 9.92;
    const z1 = bathZone?.rect.z1 ?? 5.40;
    return {
      stand: { x: x1 - 0.56, y, z: z1 - 0.58 },
      nozzle: { x: x1 - 0.56, y: y + 2.18, z: z1 - 0.58 },
      mixer: { x: x1 - 0.14, y: y + 1.15, z: z1 - 0.58 },
      stepOut: { x: x1 - 1.48, y, z: z1 - 0.72 },
      facingYaw: Math.atan2(-0.85, -0.52),
    };
  }

  private clearNegativeHygieneMood(): void {
    if (this.recentMindEvents.length > 0) {
      this.recentMindEvents = this.recentMindEvents.filter(r => r.ev.kind !== 'awkward_slip');
    }
  }

  private completeShowerRewards(): void {
    if (this.showerCompletedCycle) return;
    this.showerCompletedCycle = true;
    this.applyActivityNeeds('take_shower');
    this.clearNegativeHygieneMood();
    this.triggerUrgeEvent('home_care', 'take_shower');
    this.grantMoodlet('inspired_space', 180);
    this.s.needs.mood = clamp(this.s.needs.mood + 8, 0, 100);
    this.lastV3VitalsSnap = {
      energy: this.s.needs.energy,
      hunger: this.s.needs.hunger,
      hygiene: this.s.needs.hygiene,
      mood: this.s.needs.mood,
    };
    this.dirty = true;
  }

  /** Enters and turns on the walk-in shower, initiating continuous progressive `Needs8` replenishment. */
  startShower(targetKey = 'bath/shower'): V3Result {
    this.showerTargetKey = targetKey;
    this.showerWaterOn = true;
    this.showeringActive = true;
    this.showerElapsedSec = 0;
    this.showerCompletedCycle = false;
    this.showerNeedsCarry = { hygiene: 0, energy: 0, fun: 0 };
    this.mindState.needs = applyNeedDeltas(this.mindState.needs, { hygiene: 15, energy: 2, fun: 2 });
    this.s.needs.hygiene = clamp(this.mindState.needs.hygiene, 0, 100);
    this.s.needs.energy = clamp(Math.max(this.s.needs.energy, this.mindState.needs.energy), 0, 100);
    this.lastV3VitalsSnap = {
      energy: this.s.needs.energy,
      hunger: this.s.needs.hunger,
      hygiene: this.s.needs.hygiene,
      mood: this.s.needs.mood,
    };
    this.clearNegativeHygieneMood();
    V3.recordTutorialSignal(this.s, 'interactedObject');
    const msg = 'Warm shower running. Press E, Space, or move to step out.';
    this.say(msg, 'good');
    this.dirty = true;
    return { ok: true, msg };
  }

  /** Toggles overhead walk-in shower water ON or OFF without locking the character. */
  toggleShowerWater(force?: boolean): V3Result {
    const next = force ?? !this.showerWaterOn;
    this.showerWaterOn = next;
    if (!next && this.showeringActive) {
      this.cancelShower(true);
    }
    V3.recordTutorialSignal(this.s, 'interactedObject');
    const msg = next ? 'Turned on the warm walk-in shower.' : 'Turned off the shower.';
    this.say(msg, 'info');
    this.dirty = true;
    return { ok: true, msg };
  }

  /** Steps out of the walk-in shower cleanly to the dry bathroom floor, turning water OFF. */
  stepOutOfShower(): V3Result {
    this.flushShowerNeedsCarry();
    if (this.showeringActive && !this.showerCompletedCycle && this.showerElapsedSec >= 1.8) {
      this.completeShowerRewards();
    }
    this.showeringActive = false;
    this.showerWaterOn = false;
    this.showerElapsedSec = 0;
    this.showerNeedsCarry = { hygiene: 0, energy: 0, fun: 0 };
    const msg = 'Stepped out of the shower feeling clean and refreshed.';
    this.say(msg, 'good');
    this.dirty = true;
    return { ok: true, msg };
  }

  /** Cancels active showering immediately on manual movement/Space/Escape while preserving all earned replenishment. */
  cancelShower(turnOffWater = true): boolean {
    if (!this.showeringActive) return false;
    this.flushShowerNeedsCarry();
    if (this.showerElapsedSec >= 2.2 && !this.showerCompletedCycle) {
      this.completeShowerRewards();
    }
    this.showeringActive = false;
    this.showerElapsedSec = 0;
    this.showerNeedsCarry = { hygiene: 0, energy: 0, fun: 0 };
    if (turnOffWater) this.showerWaterOn = false;
    this.dirty = true;
    return true;
  }

  private flushShowerNeedsCarry(): void {
    const { hygiene, energy, fun } = this.showerNeedsCarry;
    if (hygiene < 0.1 && energy < 0.1 && fun < 0.1) return;
    this.mindState.needs = applyNeedDeltas(this.mindState.needs, { hygiene, energy, fun });
    this.showerNeedsCarry = { hygiene: 0, energy: 0, fun: 0 };
    this.s.needs.hygiene = clamp(this.mindState.needs.hygiene, 0, 100);
    this.s.needs.energy = clamp(Math.max(this.s.needs.energy, this.mindState.needs.energy), 0, 100);
    this.lastV3VitalsSnap = {
      energy: this.s.needs.energy,
      hunger: this.s.needs.hunger,
      hygiene: this.s.needs.hygiene,
      mood: this.s.needs.mood,
    };
  }

  /** Progressively restores `Needs8` (`hygiene`, `energy`, `fun`) during an active walk-in shower. */
  tickShower(dt: number, body?: P | null): void {
    if (!this.showeringActive || dt <= 0) return;
    const step = Math.min(0.1, dt);
    if (body && this.showerElapsedSec > 0.35) {
      const enc = this.getShowerEnclosure();
      if (Math.hypot(body.x - enc.stand.x, body.z - enc.stand.z) > 1.45) {
        this.cancelShower(true);
        return;
      }
    }
    this.showerElapsedSec += step;
    this.showerNeedsCarry.hygiene += step * 24.0;
    this.showerNeedsCarry.energy += step * 3.2;
    this.showerNeedsCarry.fun += step * 2.5;
    if (this.showerNeedsCarry.hygiene >= 0.5) {
      this.flushShowerNeedsCarry();
      this.s.needs.mood = clamp(this.s.needs.mood + step * 3.0, 0, 100);
      this.lastV3VitalsSnap.mood = this.s.needs.mood;
      this.dirty = true;
    }
    if (this.showerElapsedSec >= 3.0 && !this.showerCompletedCycle) {
      this.flushShowerNeedsCarry();
      this.completeShowerRewards();
      this.say('Warm shower complete — Hygiene and Energy restored.', 'good');
    }
  }

  /** The V3 entity a hotspot stands for now (null: not available — collected keepsake, no live event, broom elsewhere). */
  entityFor(h: Hotspot): V3Entity | null {
    if (
      h.action === 'residence_study' ||
      h.action === 'bath_soak' ||
      h.action === 'shower' ||
      h.action === 'mirror' ||
      h.action === 'toilet'
    ) {
      return { id: h.id, action: h.action, x: h.local.x, z: h.local.z, model: h.model };
    }
    const list = this.entities(h.zone);
    if (h.kind === 'event') return list.find(e => e.action === 'event_participate') ?? null;
    if (h.id === 'broom') return list.find(e => e.id === 'broom' || e.id === 'rack') ?? null;
    return list.find(e => e.id === h.id && e.action === h.action) ?? null;
  }

  nearbyTargets: Target[] = [];
  /** What the learner faces within reach: a resident, owned furnishing, residence fixture, or world hotspot. */
  focus(body: P, yaw: number): Target | null {
    let best: Target | null = null, score = Infinity;
    this.nearbyTargets.length = 0;
    const walk = this.playerWalk ?? this.nav.walk;
    const surf = walk.surface(body);
    const zone = surf?.zone ?? null;
    const region = surf?.region ?? null;
    const bodyY = surf?.y ?? 0;
    const inResidence = !!region && region.startsWith('prop_');
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const consider = (t: Target, ang: number, reach: number, onStand = false) => {
      if (t.dist > reach) return;
      const sc = t.dist + (1 - ang) * 1.6 - (t.kind === 'npc' && ang > .93 ? 2 : 0);
      // A11 Prompt Range Hygiene: crisp contextual distance (<= 2.2 m, facing cos >= -0.15 beyond 1.2 m, while preserving NPCs <= 2.2 m).
      if (t.dist <= 2.2 && (t.dist <= 1.2 || ang >= -0.15 || t.kind === 'npc' || onStand)) {
        this.nearbyTargets.push({ ...t, ang });
      }
      if (ang < .2 && t.dist > .9 && !onStand) return;
      if (sc < score) { score = sc; best = { ...t, ang }; }
    };
    for (const w of this.people.walkers.values()) {
      if (w.zone !== zone) continue;
      const at = w.seat?.sit ?? w;
      const dx = at.x - body.x, dz = at.z - body.z, dist = Math.hypot(dx, dz);
      if (dist > NPC_REACH) continue;
      const ang = dist > 1e-3 ? (dx * fx + dz * fz) / dist : 1;
      consider({ kind: 'npc', id: w.id, name: V3.CHARACTERS[w.id]?.name ?? w.id, at: { x: at.x, z: at.z }, dist }, ang, NPC_REACH);
    }
    // Placed owned workstations, kitchen appliances, and veranda spa tubs (starter flat & Market Boulevard residences).
    for (const o of this.s.progression.ownedObjects) {
      if (o.location.inStorage || !o.location.zoneId) continue;
      const matchesSpace = inResidence
        ? o.location.propertyId === region
        : o.location.zoneId === zone && (!o.location.propertyId || o.location.propertyId === 'prop_student_flat');
      if (!matchesSpace) continue;
      const isPc = o.category === 'electronics_pc';
      const isAppliance = o.category === 'kitchen_appliance';
      const isTub = o.selectedVariantId === 'bath_tub_veranda';
      if (!isPc && !isAppliance && !isTub) continue;
      const at = worldPlacement(walk, o);
      if (!at || Math.abs(at.y - bodyY) > 1.2) continue;
      const dx = at.x - body.x, dz = at.z - body.z, dist = Math.hypot(dx, dz);
      const ang = dist > 1e-3 ? (dx * fx + dz * fz) / dist : 1;
      if (isPc) {
        consider({ kind: 'workstation', id: o.instanceId, label: 'Study or configure workstation', at, dist }, ang, 2.2);
      } else {
        const action = isAppliance ? 'use_appliance' : 'bath_soak';
        const hotspot: Hotspot = {
          key: 'owned:' + o.instanceId,
          zone: o.location.zoneId as V3ZoneId,
          id: o.instanceId,
          action,
          model: o.selectedVariantId,
          kind: 'prop',
          at: { x: at.x, z: at.z },
          stand: { x: at.x, z: at.z },
          local: { x: o.placement.x, z: o.placement.z },
          anchored: o.selectedVariantId,
        };
        const entity: V3Entity = { id: o.instanceId, action, x: o.placement.x, z: o.placement.z, model: o.selectedVariantId };
        const label = isAppliance ? 'Brew espresso / use appliance' : 'Take a warm soak';
        consider({ kind: 'spot', hotspot, entity, label, at: { x: at.x, z: at.z }, dist }, ang, 2.2);
      }
    }
    const occupiedSeats = new Set<string>();
    for (const w of this.people.walkers.values()) {
      if (w.seat) occupiedSeats.add(w.seat.id);
      if (w.targetSeat) occupiedSeats.add(w.targetSeat.id);
    }
    // A2 Multi-Slot Bench & Cross-Zone Seam Seat Support (`dist <= 2.35 m` across adjacent outdoor/threshold seams).
    for (const seat of this.people.seats) {
      if (occupiedSeats.has(seat.id)) continue;
      if (inResidence && seat.propertyId && seat.propertyId !== region) continue;
      const sameOrSeam = seat.zone === zone || (!inResidence && !seat.propertyId && Math.abs(seat.sit.y - bodyY) <= 0.45);
      if (!sameOrSeam) continue;
      if (Math.abs(seat.sit.y - bodyY) > 1.2) continue;
      const dx = seat.sit.x - body.x, dz = seat.sit.z - body.z, dist = Math.hypot(dx, dz);
      if (dist <= 2.35) {
        consider(
          { kind: 'seat', id: seat.id, label: 'Take a seat', at: seat.sit, dist },
          dist > 1e-3 ? (dx * fx + dz * fz) / dist : 1,
          2.35,
        );
      }
    }
    for (const kind of ['car', 'twoWheeler'] as const) {
      const vehicle = this[kind];
      if (!vehicle.spec || this.riding) continue;
      const at = vehicle.pose, dx = at.x - body.x, dz = at.z - body.z, dist = Math.hypot(dx, dz);
      consider({ kind, label: 'Drive ' + vehicle.spec.name, at, dist }, dist > .001 ? (dx * fx + dz * fz) / dist : 1, 3.5);
    }
    if (!this.twoWheeler.spec && !this.riding) {
      const dx = this.bike.x - body.x, dz = this.bike.z - body.z, dist = Math.hypot(dx, dz);
      const ang = dist > 1e-3 ? (dx * fx + dz * fz) / dist : 1;
      consider({ kind: 'bike', label: 'Ride your bicycle', at: { ...this.bike }, dist }, ang, 2.2);
    }
    if (inResidence) {
      for (const h of this.residenceHotspots) {
        if (h.propertyId !== region || Math.abs(h.y - bodyY) > 1.2) continue;
        const d1 = Math.hypot(h.stand.x - body.x, h.stand.z - body.z), d2 = Math.hypot(h.at.x - body.x, h.at.z - body.z);
        const dist = Math.min(d1, d2 + .4);
        const isActiveShower = this.showeringActive && h.key === this.showerTargetKey && d1 <= 1.45;
        if (dist > SPOT_REACH + .2 && !isActiveShower) continue;
        const e = this.entityFor(h);
        if (!e) continue;
        const candidate: Target = { kind: 'spot', hotspot: h, entity: e, label: h.label, at: h.at, dist: isActiveShower ? 0.05 : dist };
        const opts = this.options(candidate);
        if (!opts.length) continue;
        candidate.label = opts[0].label;
        const dx = h.at.x - body.x, dz = h.at.z - body.z, dd = Math.hypot(dx, dz);
        const ang = isActiveShower ? 1 : (dd > 1e-3 ? (dx * fx + dz * fz) / dd : 1);
        consider(candidate, ang, SPOT_REACH + .2, d1 <= 0.35 || isActiveShower);
      }
      return best;
    }
    for (const h of this.hotspots) {
      if (h.zone !== zone) continue;
      const d1 = Math.hypot(h.stand.x - body.x, h.stand.z - body.z), d2 = Math.hypot(h.at.x - body.x, h.at.z - body.z);
      const dist = Math.min(d1, d2 + .4);
      const isActiveShower = this.showeringActive && (h.key === (this.showerTargetKey ?? 'bath/shower')) && d1 <= 1.45;
      if (dist > SPOT_REACH && !isActiveShower) continue;
      const e = this.entityFor(h);
      if (!e) continue;
      const candidate: Target = { kind: 'spot', hotspot: h, entity: e, label: '', at: h.at, dist: isActiveShower ? 0.05 : dist };
      const opts = this.options(candidate);
      if (!opts.length) continue;
      candidate.label = opts[0].label;
      const dx = h.at.x - body.x, dz = h.at.z - body.z, dd = Math.hypot(dx, dz);
      const ang = isActiveShower ? 1 : (dd > 1e-3 ? (dx * fx + dz * fz) / dd : 1);
      consider(candidate, ang, SPOT_REACH, d1 <= 0.35 || isActiveShower);
    }
    return best;
  }

  private appendSittableSpotOption(h: Hotspot, opts: V3Option[]): V3Option[] {
    if (h.action === 'sit' || h.action === 'sleep') return opts;
    if (opts.some(o => o.key === 'sit')) return opts;
    const sittable =
      (h.anchored != null && SITTABLE_ANCHOR_RE.test(h.anchored)) ||
      SITTABLE_ANCHOR_RE.test(h.model);
    if (!sittable) return opts;
    return [...opts, { key: 'sit', label: 'Take a seat' }];
  }

  options(t: Target): V3Option[] {
    if (t.kind === 'seat') return [{ key: 'sit', label: 'Take a seat' }];
    if (t.kind === 'workstation') {
      return [
        { key: 'pc_study', label: 'Study at workstation (+Focus and Tech XP)' },
        { key: 'pc_configure', label: 'Open PC Builder and Upgrades' },
      ];
    }
    if (t.kind === 'car' || t.kind === 'twoWheeler') return [];
    if (t.kind === 'bike') return [{ key: 'ride', label: 'Ride your bicycle' }];
    if (t.kind === 'npc') {
      const w = this.people.walkers.get(t.id);
      const keep = this.s.player.zone;
      this.s.player.zone = w?.zone ?? keep;
      try { return buildNpcInteractionOptions(this.s, t.id); } finally { this.s.player.zone = keep; }
    }
    if (t.hotspot.action === 'use_appliance') {
      return [
        { key: 'brew_use', label: 'Brew espresso / use appliance (+12 Energy, +10 Focus)' },
        { key: 'open_build', label: 'Customize in Build Mode' },
      ];
    }
    if (t.hotspot.action === 'bath_soak') {
      return [
        { key: 'bath_soak', label: 'Take a warm soak (+35 Hygiene, +15 Mood)' },
        { key: 'open_build', label: 'Customize in Build Mode' },
      ];
    }
    if (t.hotspot.action === 'residence_study') {
      return [{ key: 'residence_study', label: 'Read and study at your bookcase (+16 Focus and XP)' }];
    }

    const shift = this.activeShift;
    const steps: V3Option[] = Object.entries(JOB_RECORD).flatMap(([id, job]) => {
      if (shift && shift.job !== id) return [];
      const station = job.steps[shift?.step ?? 0];
      return matchesJobStep(station, t.hotspot.zone, t.hotspot.id, id)
        ? [{ key: 'job:' + id, label: String(station[2]), kind: 'work' }]
        : [];
    });

    // Walk-in shower (`bath/shower` & Market Boulevard `residence_shower`): stateful toggleable bathing menu (A7).
    if (t.hotspot.id === 'shower' || t.hotspot.id === 'residence_shower' || t.hotspot.action === 'shower') {
      if (this.showeringActive) {
        return [
          { key: 'step_out_shower', label: 'Step out of shower' },
          { key: 'toggle_shower', label: 'Turn off shower' },
        ];
      }
      return [
        { key: 'take_shower', label: 'Take a shower' },
        { key: 'toggle_shower', label: this.showerWaterOn ? 'Turn off shower' : 'Turn on shower' },
        ...steps,
      ];
    }

    // Bathroom mirror (`bath/mirror` — A6) & toilet (`bath/toilet` — A7) dedicated fixtures.
    if (t.hotspot.id === 'mirror' || t.hotspot.action === 'mirror') {
      return [
        { key: 'mirror', label: 'Pep talk in the mirror' },
        { key: 'wash_hands', label: 'Wash hands and freshen up (+28 Hygiene)' },
      ];
    }
    if (t.hotspot.id === 'toilet' || t.hotspot.action === 'toilet') {
      return [
        { key: 'toilet', label: 'Use the restroom (+95 Bathroom)' },
        { key: 'wash_hands', label: 'Wash hands and freshen up (+28 Hygiene)' },
      ];
    }

    // Living room TV (`living/tv` — A8): stateful Watch TV / Turn off TV options.
    if (t.hotspot.action === 'tv') {
      if (this.isTvOn) {
        return [
          ...steps,
          { key: 'tv_off', label: 'Turn off TV' },
          { key: 'watch_tv', label: 'Watch TV' },
        ];
      }
      return [
        ...steps,
        { key: 'watch_tv', label: 'Watch TV' },
      ];
    }

    const choices = V3.choices(this.s, t.entity);
    const base = choices.filter(() => !['work_market', 'work_bistro', 'work_cafe', 'delivery_start'].includes(t.hotspot.action));

    // Sunrise Market checkout counter: pay basket first when carrying groceries, while always offering Market shift & catalog.
    if (t.hotspot.zone === 'market' && t.hotspot.id === 'till') {
      const catalogOpt: V3Option = { key: 'open_market_shop', label: 'Browse Sunrise Market Catalog' };
      if (shift?.job === 'market' && steps.length) return [...steps, ...base, catalogOpt];
      if (this.s.basket.length > 0) return [...base, ...steps, catalogOpt];
      return [...steps, ...base, catalogOpt];
    }

    // Home / residence kitchen stove: keep cooking/serving first, plus quick kettle/herbal tea brewing and home recipes when stove is free.
    if (t.hotspot.action === 'cook') {
      if (!this.s.pot) {
        const teaLabel = (this.s.bag.herbal_tea ?? 0) > 0
          ? 'Brew Jasmine Herbal Tea (+18 Mood, +16 Focus)'
          : 'Steep Warm Kettle Tea (+10 Energy, +8 Focus)';
        const recipeOpts: V3Option[] = this.cookableRecipes()
          .filter(r => r.eligibility.ok)
          .slice(0, 4)
          .map(r => ({ key: 'cook:' + r.recipe.id, label: `Cook ${r.recipe.name} (+${r.recipe.needsDelta.hunger} Hunger)` }));
        return [...steps, ...base, { key: 'brew_home_tea', label: teaLabel }, ...recipeOpts];
      }
      return [...steps, ...base];
    }

    // Willow Corner Bistro counter: preserve primary V3 order option, plus all 5 server-authoritative Bistro menu items.
    if (t.hotspot.action === 'bistro_order' || t.hotspot.action === 'bistro_snack') {
      const menuOpts: V3Option[] = BISTRO_MENU.map(item => ({
        key: 'bistro_order:' + item.id,
        label: `Order ${item.name} (${item.price} CC)`,
      }));
      return [...steps, ...base, ...menuOpts];
    }

    // Bathroom basin & general `'bath'` gate (A6 + A7): surface Wash hands, Pep talk in the mirror, and Restroom cleanly.
    if (
      t.hotspot.zone === 'bath' &&
      (t.hotspot.action === 'bath' || t.hotspot.action === 'wash' || t.hotspot.action === 'hygiene')
    ) {
      const bathOpts: V3Option[] = [
        { key: 'wash_hands', label: 'Wash hands and freshen up (+28 Hygiene)' },
        { key: 'mirror', label: 'Pep talk in the mirror' },
        { key: 'toilet', label: 'Use the restroom (+95 Bathroom)' },
      ];
      return [...steps, ...bathOpts, ...base];
    }

    // Library catalog, Botanical Gazebo, Fountain Stage/Atelier Acoustic: keep primary prop action first when not mid-shift.
    if (
      !shift && (
        (t.hotspot.zone === 'library' && t.hotspot.id === 'lib_catalog') ||
        (t.hotspot.zone === 'botanical' && t.hotspot.id === 'bot_gazebo') ||
        (t.hotspot.zone === 'fountain_plaza' && (t.hotspot.id === 'plaza_stage' || t.hotspot.id === 'old_fountain')) ||
        (t.hotspot.zone === 'atelier' && (t.hotspot.id === 'atelier_acoustic' || t.hotspot.id === 'atelier_easel_a'))
      )
    ) {
      return this.appendSittableSpotOption(t.hotspot, [...base, ...steps]);
    }

    return this.appendSittableSpotOption(t.hotspot, [...steps, ...base]);
  }

  get activeShift() {
    const shift = this.s.progression.activeShift as { job: keyof typeof jobs; step: number; started: number } | undefined;
    return shift && Object.hasOwn(JOB_RECORD, shift.job) && JOB_RECORD[shift.job].steps[shift.step] &&
      Date.now() - shift.started < 1800000 ? shift : null;
  }

  get shiftObjective() {
    const shift = this.activeShift;
    return shift ? String(JOB_RECORD[shift.job].steps[shift.step][2]) : null;
  }

  /** World target for the active multi-step part-time shift (for 3D rings & Minimap beacons). */
  activeShiftTarget(): ActiveShiftTarget | null {
    const shift = this.activeShift;
    if (!shift) return null;
    const job = JOB_RECORD[shift.job];
    const station = job.steps[shift.step];
    if (!station) return null;
    const useRainFallback = shift.job === 'busker' && this.weather.rain && Array.isArray(station[3]) && station[3].length > 0;
    const zone = (useRainFallback ? 'atelier' : station[0]) as V3ZoneId;
    const stationId = String(useRainFallback ? (station[3] as readonly string[])[0] : station[1]);
    const label = String(station[2]);
    const h = this.hotspots.find(x => x.zone === zone && x.id === stationId);
    const zDef = this.nav.city.zones.find(z => z.id === zone);
    const at = h ? h.at : zDef ? zDef.waypoint : { x: 0, z: 0 };
    return {
      job: shift.job,
      title: job.title,
      zone,
      station: stationId,
      at,
      label,
      step: shift.step + 1,
      total: job.steps.length,
      leadNpc: job.leadNpc,
      microKind: job.microKind,
      microPrompt: job.microPrompt,
    };
  }

  /** Compact lifestyle vitals summary + subtle fatigue speed multiplier (`1` normally, `0.84` only when energy < 15). */
  needsSummary(): NeedsSummary {
    const n = this.s.needs;
    const energy = Math.round(clamp(n.energy, 0, 100));
    const hunger = Math.round(clamp(n.hunger, 0, 100));
    const hygiene = Math.round(clamp(n.hygiene, 0, 100));
    const mood = Math.round(clamp(n.mood, 0, 100));
    const focus = Math.round(clamp(n.focus, 0, 100));
    const fitness = Math.round(clamp(n.fitness, 0, 100));
    const state: NeedsSummary['state'] =
      energy < 20 ? 'tired'
      : hunger < 20 ? 'hungry'
      : energy >= 70 && hunger >= 60 && mood >= 70 ? 'energized'
      : 'steady';
    return {
      energy,
      hunger,
      hygiene,
      mood,
      focus,
      fitness,
      state,
      speedFactor: n.energy < 15 ? 0.84 : 1,
      comfort: this.computeHomeComfort(),
      moodlets: this.activeMoodlets(),
    };
  }

  /** Read-only deterministic projection of today's micro-activities, weather picks, and live event beacons. */
  dailyEvents(env: DailyEnvContext = {}): DailyScheduleSnapshot {
    const minute = Math.floor(env.minuteOverride != null && Number.isFinite(env.minuteOverride) ? env.minuteOverride : this.s.clock);
    const key = [
      minute,
      env.seasonIndex ?? 'a',
      env.rain === undefined ? 'a' : env.rain ? 1 : 0,
      env.snow === undefined ? 'a' : env.snow ? 1 : 0,
      env.weatherLabel ?? '',
      this.bestBasketStreak,
      this.s.worldV3.exploration.discoveredZones.length,
      this.s.worldV3.eventsAttended.length,
      this.s.worldV3.photos.length,
    ].join('|');
    if (this.dailyCache && this.dailyCache.key === key) return this.dailyCache.snap;
    const snap = resolveDailyActivities(this.s, this.nav.city, this.hotspots, {
      ...env,
      bestBasketStreak: Math.max(this.bestBasketStreak, env.bestBasketStreak ?? 0),
    });
    this.dailyCache = { key, snap };
    return snap;
  }

  /** Combined read-only HUD projection for vitals, comfort, moodlets, perks, Wave 11 mind/phone/career, and active shift beacon. */
  hudSnapshot(env?: DailyEnvContext): GameHudProjection {
    const comfort = this.computeHomeComfort();
    const moodlets = this.activeMoodlets();
    const needs = { ...this.needsSummary(), comfort, moodlets };
    return {
      needs,
      dailyEvents: this.dailyEvents(env),
      activeShift: this.activeShiftTarget(),
      comfort,
      moodlets,
      perks: this.residentPerks(),
      needs8: { ...this.mindState.needs },
      emotion: this.playerEmotion(env),
      urges: this.mindState.urges,
      karma: this.mindState.karma,
      subSkills: this.mindState.subSkills,
      phone: this.phoneState,
      fullTimeCareer: this.fullTimeCareer,
      timeScale: this.timeScale,
    };
  }

  // ── Wave 11 Mind, Cooking, Career, Phone, Karma, Urges, Wardrobe, and Smart Zoi Helpers ──────────────────

  private pushMindEvent(kind: PlayerMindEvent['kind'], intensity = 1, durationMinutes = 90) {
    this.recentMindEvents.push({ ev: { kind, intensity }, untilClock: this.s.clock + durationMinutes });
    if (this.recentMindEvents.length > 8) this.recentMindEvents.shift();
  }

  private applyActivityNeeds(activity: PlayerActivityKind) {
    this.mindState.needs = applyActivityToNeeds(this.mindState.needs, activity);
    const proj = projectToV3Vitals(this.mindState.needs, this.s.needs);
    this.s.needs.energy = proj.energy;
    this.s.needs.hunger = proj.hunger;
    this.s.needs.hygiene = proj.hygiene;
    this.s.needs.mood = clamp(Math.max(this.s.needs.mood, proj.mood), 0, 100);
    this.lastV3VitalsSnap = {
      energy: this.s.needs.energy,
      hunger: this.s.needs.hunger,
      hygiene: this.s.needs.hygiene,
      mood: this.s.needs.mood,
    };
  }

  private gainSubSkillXp(id: SubSkillId, amount: number) {
    if (amount <= 0) return;
    const res = awardSubSkillXp(this.mindState.subSkills, id, amount);
    this.mindState.subSkills = res.skills;
    if (res.leveledUp) {
      const perkNote = res.unlockedPerks.length ? ` Unlocked: ${res.unlockedPerks.join(', ')}.` : '';
      this.say(`${id.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())} reached Level ${res.newLevel}!${perkNote}`, 'good');
    }
    this.dirty = true;
  }

  private triggerUrgeEvent(kind: UrgeActionKind, targetId?: string, amount = 1) {
    const res = recordActionForUrges(this.mindState, { kind, targetId, amount }, this.s.day, this.s.clock % 1440);
    this.mindState = res.state;
    if (res.completedUrges.length > 0) {
      this.phoneState.cityConfig.cityKarma = this.mindState.karma.city;
      for (const u of res.completedUrges) {
        this.say(`Urge fulfilled: ${u.title} (+${u.rewards.aspirationPoints} Aspiration, +${u.rewards.recognitionDelta} Recognition)!`, 'good');
      }
      this.dirty = true;
    }
  }

  private applyKarma(action: KarmaActionKind) {
    this.mindState.karma = applyKarmaAction(this.mindState.karma, action, this.s.day, this.s.clock % 1440);
    this.phoneState.cityConfig.cityKarma = this.mindState.karma.city;
    this.pushMindEvent((this.mindState.karma.recentLog.at(-1)?.delta ?? 0) >= 0 ? 'karma_good' : 'karma_bad', 0.8);
    this.dirty = true;
  }

  private adjustKarma(personalDelta: number, cityDelta: number, label: string, actionKey = 'custom') {
    this.mindState.karma = applyKarmaDelta(this.mindState.karma, personalDelta, cityDelta, label, this.s.day, this.s.clock % 1440, actionKey);
    this.phoneState.cityConfig.cityKarma = this.mindState.karma.city;
    this.dirty = true;
  }

  private emitMilestoneFeedPost(tag: FeedMilestoneTag) {
    const w = this.weather;
    const weatherKind: 'sunny' | 'rain' | 'snow' = /snow/i.test(w.label) ? 'snow' : w.rain ? 'rain' : 'sunny';
    const posts = generateCampusFeedPosts(this.s.day, {
      weather: weatherKind,
      seasonIndex: (Math.floor(this.s.day / 7) % 4) as 0 | 1 | 2 | 3,
      recentMilestones: [tag],
      playerName: this.profileIdentity.displayName,
      clock: this.s.clock % 1440,
    }).filter(p => p.tag === tag);
    if (posts.length > 0) {
      this.phoneState = addFeedPosts(this.phoneState, posts);
      this.dirty = true;
    }
  }

  /** Records a credit gain or spend into the Echo Bank financial ledger (strictly bounded at 25 entries). */
  recordCreditChange(source: string, delta: number, balanceAfter = this.s.progression.economy.credits) {
    const rounded = Math.round(delta);
    if (!rounded) return;
    this.phoneState = recordBankTransaction(this.phoneState, {
      source: cleanDisplayCopy(source) || 'Campus Transaction',
      delta: rounded,
      balanceAfter: Math.max(0, Math.round(balanceAfter)),
      day: this.s.day,
      clock: this.s.clock % 1440,
    });
    this.lastTrackedCredits = balanceAfter;
    this.dirty = true;
  }

  /** Computes live 12-emotion state deterministically from 8 needs, moodlets, traits, weather, and recent events. */
  playerEmotion(env?: DailyEnvContext): EmotionState {
    const curZone = this.lastZone ?? this.s.player.zone;
    const indoor = !V3.zones[curZone]?.outdoors;
    const isRain = env?.rain ?? this.weather.rain;
    const isSnow = env?.snow ?? /snow/i.test(this.weather.label);
    return computePlayerEmotion({
      needs: this.mindState.needs,
      moodlets: this.allActiveMoodletIds(),
      traitIds: this.profileIdentity.traitIds,
      weather: { rain: isRain, snow: isSnow, sunny: !isRain && !isSnow, indoor },
      recentEvents: this.recentMindEvents.map(r => r.ev),
      karmaScore: this.mindState.karma.personal,
    });
  }

  needs8(): Needs8 { return { ...this.mindState.needs }; }
  dailyUrges(): UrgeItem[] { return this.mindState.urges; }
  karmaState(): KarmaState { return this.mindState.karma; }
  subSkills(): SubSkillsState { return this.mindState.subSkills; }
  phoneStateSnapshot(): EchoPhoneState { return this.phoneState; }
  fullTimeCareerState(): FullTimeCareerState { return this.fullTimeCareer; }
  partTimeCareers(): PartTimeCareerStatus[] {
    const serverTiers = (this.s.progression as unknown as { careerTiers?: Record<string, { shifts?: number }> }).careerTiers;
    const merged: Partial<Record<PartTimeJobId, number>> = {};
    for (const id of PART_TIME_JOB_IDS) {
      merged[id] = Math.max(this.shiftCounts[id] ?? 0, serverTiers?.[id]?.shifts ?? 0);
    }
    return getAllPartTimeStatuses(merged);
  }

  dailySchedule(): ScheduleEntry[] {
    const cal = this.calendar;
    const weekdayIndex = this.s.day % 7;
    const seasonIndex = (Math.floor(this.s.day / 7) % 4) as 0 | 1 | 2 | 3;
    void cal;
    return getDailySchedule(this.phoneState, this.s.day, {
      seasonIndex,
      weekdayIndex,
      fullTimeCareerId: this.fullTimeCareer.activeCareerId,
    });
  }

  bankSummary(): BankSummary {
    const assetValue = this.s.progression.ownedObjects.reduce((sum, o) => {
      if (o.instanceId.startsWith('obj_starter_')) return sum;
      return sum + 120 + (o.upgradeLevel ?? 0) * 80;
    }, 0);
    return getBankSummary(this.phoneState, this.s.progression.economy.credits, assetValue);
  }

  busStops(): BusStop[] {
    return resolveBusStops(this.nav.city);
  }

  /** Lists all 10 home recipes with live eligibility against merged bag + pantry + materials inventory. */
  cookableRecipes() {
    const inv = mergeCookingInventory(this.s.bag, this.s.pantry, this.s.progression.materials);
    const cookingLv = Math.max(this.s.progression.skills.cooking?.level ?? 1, this.mindState.subSkills.cooking.level);
    return listCookableRecipes(inv, cookingLv);
  }

  /** Cooks one of the 10 home recipes using `cookingSim.ts`, deducts real ingredients, and grants meal moodlet + XP. */
  cookHomeRecipe(recipeId: RecipeId | string): V3Result & { cooked?: CookRecipeResult } {
    const s = this.s;
    const before = this.snap();
    const inv = mergeCookingInventory(s.bag, s.pantry, s.progression.materials);
    const cookingLv = Math.max(s.progression.skills.cooking?.level ?? 1, this.mindState.subSkills.cooking.level);
    const hasInduction = s.progression.ownedObjects.some(o => o.selectedVariantId === 'stove_induction_dual' && !o.location.inStorage);
    const result = cookRecipe(recipeId, inv, cookingLv, hasInduction ? 0.72 : 1.0);
    if (!result.ok || !result.recipe) {
      this.say(result.reason, 'bad');
      return { ok: false, msg: result.reason, cooked: result };
    }

    // Deduct consumed ingredients cleanly across bag -> pantry -> materials
    for (const [ing, reqQty] of Object.entries(result.recipe.ingredients) as [IngredientId, number][]) {
      let rem = reqQty;
      for (const store of [s.bag, s.pantry, s.progression.materials] as Record<string, number>[]) {
        if (rem <= 0) break;
        const have = Math.max(0, Math.floor(store[ing] ?? 0));
        if (have <= 0) continue;
        const take = Math.min(have, rem);
        const left = have - take;
        if (left > 0) store[ing] = left;
        else if (store === s.bag) delete store[ing];
        else store[ing] = 0;
        rem -= take;
      }
    }

    this.mindState.needs = applyNeedDeltas(this.mindState.needs, {
      hunger: result.needsDelta.hunger,
      fun: result.needsDelta.fun,
      energy: result.needsDelta.energy,
      bathroom: -8,
    });
    const proj = projectToV3Vitals(this.mindState.needs, s.needs);
    s.needs.hunger = proj.hunger;
    s.needs.energy = proj.energy;
    s.needs.mood = clamp(s.needs.mood + result.needsDelta.mood, 0, 100);
    this.lastV3VitalsSnap = { energy: s.needs.energy, hunger: s.needs.hunger, hygiene: s.needs.hygiene, mood: s.needs.mood };

    if (result.moodlet) {
      this.grantAnyMoodlet(result.moodlet.id, result.moodlet.durationMinutes);
    }
    V3.awardSkillXp(s, 'cooking', result.cookingXp);
    V3.recordTutorialSignal(s, 'interactedObject');
    this.gainSubSkillXp('cooking', result.cookingXp);
    this.triggerUrgeEvent('cook_meal', result.recipe.id);
    this.pushMindEvent('warm_meal', result.quality === 'chef_grade' ? 1.3 : 1.0);
    if (result.quality === 'chef_grade') {
      this.phoneState = createPlayerFeedPost(
        this.phoneState,
        `Just plated a chef-grade ${result.recipe.name} in my kitchen!`,
        'cooking_feast',
        s.day,
        s.clock % 1440,
        this.profileIdentity.displayName,
        'kitchen',
      ).state;
    }

    this.say(result.reason, 'good');
    this.report('cook:' + result.recipe.id, before);
    this.dirty = true;
    return { ok: true, msg: result.reason, cooked: result };
  }

  /** Lists all 5 Willow Corner Bistro menu items. */
  bistroMenu() {
    return BISTRO_MENU;
  }

  /**
   * Orders any of the 5 server-authoritative Willow Corner Bistro items (`matcha_crepe`, `iced_matcha`,
   * `egg_banh_mi`, `truffle_ramen`, `jasmine_tea_set`). Commits via `saver.checkout(...)` when online.
   */
  async orderBistroMenu(
    sku: BistroItemId | string,
    saver?: GameSaver | null,
  ): Promise<V3Result & { order?: BistroOrderResult }> {
    if (!BISTRO_SKU_SET.has(sku)) {
      return { ok: false, msg: 'Menu item is not available at Willow Corner Bistro.' };
    }
    const s = this.s;
    const creditsBefore = s.progression.economy.credits;
    const rep = this.people.getDistrictReputation('bistro');
    const order = orderBistroItem(sku, creditsBefore, {
      hasBaristaPerk: this.hasPerk('khanhha'),
      discountPct: rep.discountPct,
    });
    if (!order.ok || !order.item) {
      this.say(order.reason, 'bad');
      return { ok: false, msg: order.reason, order };
    }

    if (saver) {
      await saver.report(this.claims.splice(0));
      const draft = structuredClone(this.s);
      const batch: ClaimBatch = {
        source: 'checkout',
        uniques: [],
        credits: 0,
        xp: {},
        spent: [{ kind: 'bistro', items: [sku], sale: false }],
      };
      this.setNpcSimSnapshot(this.people.exportNpcSimSnapshot());
      const doc = this.serialize(draft);
      const wallet = await saver.checkout(doc, batch);
      this.applyWallet(wallet);
    } else {
      s.progression.economy.credits = order.remainingCredits;
      s.cash = order.remainingCredits;
      s.progression.economy.lifetimeSpent += order.cost;
    }

    const actualCost = Math.max(0, creditsBefore - this.s.progression.economy.credits);
    if (actualCost > 0) {
      this.recordCreditChange(`Willow Bistro: ${order.item.name}`, -actualCost, this.s.progression.economy.credits);
    }

    this.mindState.needs = applyNeedDeltas(this.mindState.needs, {
      hunger: order.needsDelta.hunger,
      fun: order.needsDelta.fun,
      energy: order.needsDelta.energy,
      social: 8,
      bathroom: -8,
    });
    const proj = projectToV3Vitals(this.mindState.needs, this.s.needs);
    this.s.needs.hunger = proj.hunger;
    this.s.needs.energy = proj.energy;
    this.s.needs.mood = clamp(this.s.needs.mood + order.needsDelta.mood, 0, 100);
    if (this.hasPerk('khanhha')) {
      this.s.needs.focus = clamp(this.s.needs.focus + 8, 0, 100);
    }
    this.lastV3VitalsSnap = {
      energy: this.s.needs.energy,
      hunger: this.s.needs.hunger,
      hygiene: this.s.needs.hygiene,
      mood: this.s.needs.mood,
    };

    if (order.buff) {
      this.grantAnyMoodlet(order.buff.id, order.buff.durationMinutes);
    }
    this.gainSubSkillXp(sku === 'iced_matcha' || sku === 'jasmine_tea_set' ? 'coffeeCraft' : 'cooking', 10);
    this.triggerUrgeEvent('order_bistro', sku);
    this.pushMindEvent('warm_meal', 0.9);
    V3.recordTutorialSignal(this.s, 'interactedObject');
    this.say(order.reason, 'good');
    this.dirty = true;
    return { ok: true, msg: order.reason, order };
  }

  /** Lists all owned automobiles across all 4 vehicle models as drivable (`drivable: true`). */
  ownedDrivableCars(): OwnedDrivableCarInfo[] {
    const activeId = this.car.spec?.instanceId ?? this.s.progression.activeCarId ?? null;
    const out: OwnedDrivableCarInfo[] = [];
    for (const o of this.s.progression.ownedObjects) {
      if (!Object.hasOwn(ALL_DRIVABLE_CAR_MODELS, o.selectedVariantId)) continue;
      out.push({
        instanceId: o.instanceId,
        model: o.selectedVariantId,
        name: cleanDisplayCopy(ALL_DRIVABLE_CAR_MODELS[o.selectedVariantId]),
        drivable: true,
        active: o.instanceId === activeId,
      });
    }
    return out;
  }

  /** Sends a contextual 0-LLM Echo Phone text message to any of the 22 Riverside residents. */
  sendPhoneMessage(npcId: ResidentId, text: string) {
    if (!isResidentId(npcId)) return { ok: false, reply: null, msg: 'Resident not found.' };
    const npc = this.s.npcs[npcId];
    const w = this.people.walkers.get(npcId);
    const res = sendResidentMessage(this.phoneState, npcId, text, {
      friendship: npc?.rel?.friendship ?? 0,
      npcZone: w?.zone ?? npc?.zone,
      npcMood: this.people.getResidentMood(npcId) ?? w?.mood ?? 'cheerful',
      weatherLabel: this.weather.label,
      rain: this.weather.rain,
      snow: /snow/i.test(this.weather.label),
      day: this.s.day,
      clock: this.s.clock % 1440,
    });
    if (!res.reply) return { ok: false, reply: null, msg: 'Enter a message to send.' };
    this.phoneState = res.state;
    if (npc?.rel) {
      npc.rel.friendship = Math.min(100, npc.rel.friendship + res.friendshipDelta);
    }
    this.mindState.needs = applyNeedDeltas(this.mindState.needs, { social: 10, fun: 4 });
    this.triggerUrgeEvent('talk_resident', npcId);
    this.gainSubSkillXp('rhetoric', 6);
    this.dirty = true;
    return { ok: true, reply: res.reply, msg: `${V3.CHARACTERS[npcId]?.name ?? npcId} replied.` };
  }

  /** Invites a named resident to meet at Willow Bistro, Riverside Park, or your Riverside Home. */
  inviteNpcHangout(npcId: ResidentId, venue: HangoutVenue) {
    if (!isResidentId(npcId)) return { ok: false, accepted: false, meetupPlan: null, msg: 'Resident not found.' };
    const npc = this.s.npcs[npcId];
    const w = this.people.walkers.get(npcId);
    const res = sendHangoutInvite(this.phoneState, npcId, venue, {
      friendship: npc?.rel?.friendship ?? 0,
      npcZone: w?.zone ?? npc?.zone,
      npcMood: this.people.getResidentMood(npcId) ?? w?.mood ?? 'cheerful',
      day: this.s.day,
      clock: this.s.clock % 1440,
    });
    this.phoneState = res.state;
    if (res.accepted) {
      this.applyActivityNeeds('host_hangout');
      this.applyKarma('help_resident');
      this.gainSubSkillXp('rhetoric', 12);
      this.triggerUrgeEvent('talk_resident', npcId);
      this.people.notifyPlayerInteraction(this.s, npcId, 'activity', 'hangout:' + venue);
      this.say(`${V3.CHARACTERS[npcId]?.name ?? npcId} accepted your invite to ${res.meetupPlan?.venueLabel ?? venue}!`, 'good');
    } else {
      this.say(res.replyText, 'info');
    }
    this.dirty = true;
    return { ok: true, accepted: res.accepted, meetupPlan: res.meetupPlan, msg: res.replyText };
  }

  likeFeedPost(postId: string) {
    const res = likePhoneFeedPost(this.phoneState, postId);
    this.phoneState = res.state;
    if (res.authorNpcId && res.friendshipDelta > 0) {
      const rel = this.s.npcs[res.authorNpcId]?.rel;
      if (rel) rel.friendship = Math.min(100, rel.friendship + res.friendshipDelta);
    }
    if (res.recognitionDelta > 0) {
      this.mindState.needs = applyNeedDeltas(this.mindState.needs, { recognition: res.recognitionDelta, social: 4 });
    }
    this.dirty = true;
    return res;
  }

  replyFeedPost(postId: string, text: string) {
    const res = replyPhoneFeedPost(
      this.phoneState,
      postId,
      text,
      this.s.day,
      this.s.clock % 1440,
      this.profileIdentity.displayName,
    );
    if (!res.ok) return res;
    this.phoneState = res.state;
    if (res.authorNpcId && res.friendshipDelta > 0) {
      const rel = this.s.npcs[res.authorNpcId]?.rel;
      if (rel) rel.friendship = Math.min(100, rel.friendship + res.friendshipDelta);
    }
    this.mindState.needs = applyNeedDeltas(this.mindState.needs, { recognition: res.recognitionDelta, social: 8, fun: 4 });
    this.triggerUrgeEvent('social_post');
    this.gainSubSkillXp('rhetoric', 8);
    this.dirty = true;
    return res;
  }

  createFeedPost(caption: string, tag: FeedMilestoneTag = 'daily_note') {
    const res = createPlayerFeedPost(
      this.phoneState,
      caption,
      tag,
      this.s.day,
      this.s.clock % 1440,
      this.profileIdentity.displayName,
      this.lastZone ?? this.s.player.zone,
    );
    if (!res.post) return { ok: false, post: null };
    this.phoneState = res.state;
    this.mindState.needs = applyNeedDeltas(this.mindState.needs, { recognition: res.recognitionDelta, social: 6, fun: 6 });
    this.triggerUrgeEvent('social_post');
    this.dirty = true;
    return { ok: true, post: res.post };
  }

  enrollFullTimeCareer(careerId: FullTimeCareerId): V3Result {
    const track = getFullTimeCareer(careerId);
    if (!track) return { ok: false, msg: 'Career track not found.' };
    this.fullTimeCareer = enrollFullTimeCareerState(this.fullTimeCareer, careerId);
    this.mindState.needs = applyNeedDeltas(this.mindState.needs, { recognition: 6 });
    this.say(`Enrolled in ${track.title} (${track.scheduleLabel}).`, 'good');
    this.dirty = true;
    return { ok: true, msg: `Enrolled in ${track.title}.` };
  }

  activeWorkplaceDilemma(): WorkplaceDilemma | null {
    if (!this.fullTimeCareer.activeCareerId) return null;
    if (this.fullTimeCareer.lastDilemmaDay === this.s.day) return null;
    return pickWorkplaceDilemma(
      this.fullTimeCareer.activeCareerId,
      this.s.day,
      this.ownerSeed,
      this.fullTimeCareer.resolvedDilemmaIds,
    );
  }

  resolveWorkplaceDilemma(dilemmaId: string, choiceId: string): DilemmaResolutionResult {
    const res = resolveWorkplaceDilemmaState(this.fullTimeCareer, dilemmaId, choiceId, this.s.day);
    if (!res.ok || !res.choice) return res;
    this.fullTimeCareer = res.state;
    this.mindState.needs = applyNeedDeltas(this.mindState.needs, {
      energy: res.deltas.energyDelta,
      recognition: res.deltas.recognitionDelta,
    });
    if (res.deltas.karmaDelta !== 0) {
      this.adjustKarma(
        res.deltas.karmaDelta,
        Math.round(res.deltas.karmaDelta * 0.5),
        res.choice.label,
        res.deltas.karmaDelta > 0 ? 'kind_dilemma' : 'selfish_dilemma',
      );
    }
    const track = getFullTimeCareer(this.fullTimeCareer.activeCareerId);
    if (track && SUB_SKILL_IDS.includes(track.primarySubSkill as SubSkillId)) {
      this.gainSubSkillXp(track.primarySubSkill as SubSkillId, 18);
    }
    if (res.promoted && res.newRankTitle) {
      this.pushMindEvent('promotion', 1.4);
      this.emitMilestoneFeedPost('shift_promotion');
      this.say(`Promoted to ${res.newRankTitle}! ${res.choice.outcomeText}`, 'story');
    } else {
      this.say(res.choice.outcomeText, 'good');
    }
    this.dirty = true;
    return res;
  }

  resolveWorkplaceDilemmaByIndex(choiceIdx: number, dilemmaId?: string): DilemmaResolutionResult {
    const dilemma = dilemmaId
      ? (this.activeWorkplaceDilemma()?.id === dilemmaId ? this.activeWorkplaceDilemma() : null)
      : this.activeWorkplaceDilemma();
    const target = dilemma ?? (this.fullTimeCareer.activeCareerId
      ? pickWorkplaceDilemma(this.fullTimeCareer.activeCareerId, this.s.day, this.ownerSeed, this.fullTimeCareer.resolvedDilemmaIds)
      : null);
    const choice = target?.choices[choiceIdx];
    if (!target || !choice) {
      return {
        ok: false,
        state: this.fullTimeCareer,
        dilemma: target,
        choice: null,
        promoted: false,
        newRankTitle: null,
        deltas: { karmaDelta: 0, recognitionDelta: 0, promotionDelta: 0, energyDelta: 0 },
      };
    }
    return this.resolveWorkplaceDilemma(target.id, choice.id);
  }

  completeFullTimeWorkday() {
    const res = completeFullTimeWorkday(this.fullTimeCareer, this.s.day);
    if (!res.ok) {
      this.say(res.reason, 'info');
      return res;
    }
    this.fullTimeCareer = res.state;
    this.mindState.needs = applyNeedDeltas(this.mindState.needs, {
      energy: res.energyDelta,
      recognition: res.recognitionDelta,
    });
    this.triggerUrgeEvent('complete_shift', this.fullTimeCareer.activeCareerId ?? 'career');
    this.applyKarma('shift_excellence');
    if (res.promoted) {
      this.pushMindEvent('promotion', 1.3);
      this.emitMilestoneFeedPost('shift_promotion');
    }
    this.say(res.reason, 'good');
    this.dirty = true;
    return res;
  }

  /** Plans and commits a Riverside Shuttle Bus ride across the 6 connected district stops. */
  rideBusShuttle(toStopId: BusStopId, fromStopId?: BusStopId): BusTripPlan {
    const stops = this.busStops();
    let origin = fromStopId;
    if (!origin) {
      const p = this.lastBody;
      let bestId: BusStopId = 'lantern_street';
      let bestD = Infinity;
      for (const st of stops) {
        const d = p ? Math.hypot(st.arrival.x - p.x, st.arrival.z - p.z) : (st.zone === this.lastZone ? 0 : 999);
        if (d < bestD) { bestD = d; bestId = st.id; }
      }
      origin = bestId;
    }
    const plan = planBusTrip(origin, toStopId, this.s.progression.economy.credits, this.phoneState.hasStudentPass, this.nav.city);
    if (!plan.ok || !plan.to) {
      this.say(plan.reason, 'bad');
      return plan;
    }
    this.s.clock += plan.transitMinutes;
    if (plan.fare > 0) {
      this.s.progression.economy.credits = Math.max(0, this.s.progression.economy.credits - plan.fare);
      this.s.cash = this.s.progression.economy.credits;
      this.recordCreditChange(`Riverside Shuttle to ${plan.to.name}`, -plan.fare, this.s.progression.economy.credits);
    }
    this.triggerUrgeEvent('bus_ride', toStopId);
    this.say(plan.reason, 'good');
    this.dirty = true;
    return plan;
  }

  updateManageCity(patch: Partial<ManageCityConfig>): ManageCityConfig {
    this.phoneState = updateManageCityConfig(this.phoneState, patch);
    if (typeof patch.trafficDensity === 'number' && Number.isFinite(patch.trafficDensity)) {
      setTrafficDensityMultiplier(this.phoneState.cityConfig.trafficDensity);
    }
    if (typeof patch.pedestrianDensity === 'number' && Number.isFinite(patch.pedestrianDensity)) {
      setPedestrianDensityMultiplier(this.phoneState.cityConfig.pedestrianDensity);
    }
    if (typeof patch.cityKarma === 'number' && Number.isFinite(patch.cityKarma)) {
      const clampedCity = Math.round(clamp(patch.cityKarma, 0, 100));
      this.mindState.karma = {
        ...this.mindState.karma,
        city: clampedCity,
        cityBand: resolveCityKarmaBand(clampedCity),
      };
    }
    if (typeof patch.cleanliness === 'number' && Number.isFinite(patch.cleanliness)) {
      this.homeCleanliness = clamp(patch.cleanliness / 100, 0, 1);
    }
    this.dirty = true;
    return this.phoneState.cityConfig;
  }

  addPhotoAlbumEntry(entry: Omit<PhonePhotoMeta, 'id' | 'thumbKey'> & { dataUrlThumb?: string }) {
    const { dataUrlThumb, ...meta } = entry;
    const res = addPhotoToAlbum(this.phoneState, meta, { dataUrlThumb, accountKey: this.owner });
    this.phoneState = res.state;
    this.applyActivityNeeds('take_photo');
    this.gainSubSkillXp('photography', 18);
    this.triggerUrgeEvent('take_photo', meta.zone);
    this.pushMindEvent('creative_milestone', 0.9);
    this.emitMilestoneFeedPost('photo_upload');
    this.say(`Saved "${res.photo.title}" to your Photo Album (+18 Photography XP).`, 'good');
    this.dirty = true;
    return res;
  }

  /** Deterministic Smart Zoi thought bubble for any of the 22 named residents (0 LLM calls). */
  getNpcThoughtBubble(npcId: string): DiegeticThoughtBubble | null {
    if (!isResidentId(npcId)) return null;
    const w = this.people.walkers.get(npcId);
    const mind = this.people.mind.minds.get(npcId);
    const latestMem = mind?.stm.at(-1) ?? mind?.ltm.at(-1) ?? null;
    return buildNpcThoughtBubble({
      residentId: npcId,
      residentName: V3.CHARACTERS[npcId]?.name ?? npcId,
      goalKind: mind?.goal?.kind ?? 'FOLLOW_SCHEDULE',
      goalZone: mind?.goal?.zone ?? w?.zone,
      mood: mind?.mood ?? w?.mood ?? 'cheerful',
      weather: {
        rainIntensity: this.weather.rain ? 0.7 : 0,
        snowIntensity: /snow/i.test(this.weather.label) ? 0.7 : 0,
        weatherId: this.weather.id as 'sunny' | 'light_rain' | 'heavy_rain' | 'snowy',
      },
      latestMemory: latestMem,
    });
  }

  /** Deterministic 3-entry Resident Diary (Morning, Afternoon, Evening) for any named resident (0 LLM calls). */
  getResidentDiary(npcId: string): readonly [ResidentDiaryEntry, ResidentDiaryEntry, ResidentDiaryEntry] | null {
    if (!isResidentId(npcId)) return null;
    const c = V3.CHARACTERS[npcId];
    const mind = this.people.mind.minds.get(npcId);
    const w = this.people.walkers.get(npcId);
    const memories = [...(mind?.ltm ?? []), ...(mind?.stm ?? [])];
    return buildResidentDailyDiary({
      residentId: npcId,
      residentName: c?.name ?? npcId,
      role: cleanDisplayCopy(c?.role),
      day: this.s.day,
      goal: mind?.goal ?? null,
      mood: mind?.mood ?? w?.mood ?? 'cheerful',
      weather: {
        rainIntensity: this.weather.rain ? 0.7 : 0,
        snowIntensity: /snow/i.test(this.weather.label) ? 0.7 : 0,
      },
      memories,
    });
  }

  setProfileIdentity(identity: Partial<CharacterIdentityTraits>) {
    this.profileIdentity = {
      displayName: identity.displayName ? sanitizeSafeString(identity.displayName, 32) || this.profileIdentity.displayName : this.profileIdentity.displayName,
      traitIds: identity.traitIds ? identity.traitIds.slice(0, 3) : this.profileIdentity.traitIds,
      desiredLifeId: identity.desiredLifeId ?? this.profileIdentity.desiredLifeId,
      valueIds: identity.valueIds ? identity.valueIds.slice(0, 3) : this.profileIdentity.valueIds,
      likes: identity.likes ? identity.likes.slice(0, 5) : this.profileIdentity.likes,
      dislikes: identity.dislikes ? identity.dislikes.slice(0, 5) : this.profileIdentity.dislikes,
    };
    this.dirty = true;
  }

  setStarterFurnitureOverride(id: string, override: StarterFurnitureOverride) {
    this.starterOverrides[id] = { ...override, id };
    this.syncDynamicWorkshopSeats();
    this.dirty = true;
  }

  getStarterFurnitureOverrides(): Readonly<Record<string, StarterFurnitureOverride>> {
    return this.starterOverrides;
  }

  clearStarterFurnitureOverride(id: string): boolean {
    if (!this.starterOverrides[id]) return false;
    delete this.starterOverrides[id];
    this.syncDynamicWorkshopSeats();
    this.dirty = true;
    return true;
  }

  unlockedWardrobe(): UnlockedWardrobeSet {
    return resolveUnlockedWardrobe({
      ownedObjects: this.s.progression.ownedObjects,
      unlockedOutfits: (this.s.progression as unknown as { unlockedOutfits?: string[] }).unlockedOutfits ?? null,
      legacyOutfits: (this.s as unknown as { outfits?: string[] }).outfits ?? null,
    });
  }

  boutiqueCatalog() {
    return listBoutiqueCatalogWithOwnership({
      ownedObjects: this.s.progression.ownedObjects,
      unlockedOutfits: (this.s.progression as unknown as { unlockedOutfits?: string[] }).unlockedOutfits ?? null,
      legacyOutfits: (this.s as unknown as { outfits?: string[] }).outfits ?? null,
    });
  }

  equipBoutiqueOutfit(profile: CharacterCreatorProfile, skuOrOutfitId: string): EquipClothingResult {
    return equipClothingSkuOnProfile(profile, skuOrOutfitId);
  }

  npcBadge(id: string) { try { return getNpcHeaderBadge(this.s, id); } catch { return ''; } }

  // ── Acting ──────────────────────────────────────────────────────────────────────────────────────────────
  /** Run V3's own `interact` with its virtual player standing exactly at the entity (zone-local or resident place). */
  act(t: Target, key: string): V3Result {
    if (t.kind === 'seat') return { ok: false, msg: 'Approach the seat first.' };
    if (t.kind === 'car' || t.kind === 'twoWheeler') return { ok: false, msg: 'Approach the vehicle to drive.' };
    if (t.kind === 'bike') return this.lastBody ? this.mount(this.lastBody) : { ok: false, msg: 'Come closer to your bicycle.' };

    if (key === 'take_shower') {
      return this.startShower(t.kind === 'spot' ? t.hotspot.key : 'bath/shower');
    }
    if (key === 'toggle_shower') {
      return this.toggleShowerWater();
    }
    if (key === 'step_out_shower') {
      return this.stepOutOfShower();
    }

    if (key.startsWith('cook:')) {
      return this.cookHomeRecipe(key.slice(5));
    }

    const s = this.s, before = this.snap();
    const keep = { zone: s.player.zone, x: s.player.x, z: s.player.z };

    // A2 Sittable Spot Option (`key === 'sit'` on benches, sofas, chairs, patio sets, shelters, gazebos)
    if (t.kind === 'spot' && key === 'sit' && t.hotspot.action !== 'sit') {
      this.mindState.needs = applyNeedDeltas(this.mindState.needs, { energy: 5, fun: 4 });
      s.needs.energy = clamp(s.needs.energy + 5, 0, 100);
      this.lastV3VitalsSnap = { energy: s.needs.energy, hunger: s.needs.hunger, hygiene: s.needs.hygiene, mood: s.needs.mood };
      V3.recordTutorialSignal(s, 'interactedObject');
      this.dirty = true;
      return { ok: true, msg: 'Take a breath.', settled: true };
    }

    // A8 Living Room Watch TV / Turn Off TV (`living/tv`)
    if (
      t.kind === 'spot' &&
      (key === 'watch_tv' || key === 'tv_off' || (t.hotspot.action === 'tv' && key === 'tv'))
    ) {
      const turnOn = key === 'watch_tv' ? true : key === 'tv_off' ? false : !this.isTvOn;
      s.flags['living:tv'] = turnOn;
      s.flags['living/tv'] = turnOn;
      V3.recordTutorialSignal(s, 'interactedObject');
      if (turnOn) {
        const comfort = this.computeHomeComfort();
        const funGain = Math.round(18 * comfort.restMultiplier);
        this.mindState.needs = applyNeedDeltas(this.mindState.needs, { fun: funGain, energy: 5 });
        s.needs.mood = clamp(s.needs.mood + 10, 0, 100);
        s.needs.energy = clamp(s.needs.energy + 4, 0, 100);
        this.lastV3VitalsSnap = { energy: s.needs.energy, hunger: s.needs.hunger, hygiene: s.needs.hygiene, mood: s.needs.mood };
        this.grantMoodlet('inspired_space', 180);
        this.triggerUrgeEvent('home_care', 'watch_tv');
        const msg = `Relaxed watching a show on the living room TV (+${funGain} Fun, +10 Mood).`;
        this.say(msg, 'good');
        this.dirty = true;
        return { ok: true, msg };
      }
      const msg = 'Turned off the television.';
      this.say(msg, 'info');
      this.dirty = true;
      return { ok: true, msg };
    }

    // Walk-in shower fallback when invoked via legacy `'bath'` key
    if (
      t.kind === 'spot' &&
      (t.hotspot.id === 'shower' || t.hotspot.id === 'residence_shower' || t.hotspot.action === 'shower') &&
      key === 'bath'
    ) {
      this.applyActivityNeeds('take_shower');
      this.clearNegativeHygieneMood();
      this.triggerUrgeEvent('home_care', 'bath');
      return this.startShower(t.hotspot.key);
    }

    if (t.kind === 'workstation') {
      if (key === 'pc_configure') return { ok: true, msg: 'Workstation selected.', openPanel: 'pc', targetInstanceId: t.id };
      const obj = s.progression.ownedObjects.find(o => o.instanceId === t.id);
      if (!obj || obj.location.inStorage || !obj.location.zoneId) return { ok: false, msg: 'Place your workstation first.' };
      s.player.zone = obj.location.zoneId; s.player.x = obj.placement.x; s.player.z = obj.placement.z;
      const res = V3.interact(s, obj.instanceId, 'pc_study');
      s.player.zone = this.lastZone ?? keep.zone; s.player.x = keep.x; s.player.z = keep.z;
      s.posture = '';
      this.entityCache.clear();
      if (res.ok) {
        this.applyActivityNeeds('study_focus');
        this.gainSubSkillXp('rhetoric', 14);
        this.pushMindEvent('deep_study', 0.9);
        this.triggerUrgeEvent('study_session', 'pc');
      }
      if (res.msg) this.say(res.msg, res.ok ? 'good' : 'bad');
      this.report('pc_study', before);
      this.dirty = true;
      return res;
    }

    if (t.kind === 'spot' && key === 'open_market_shop') {
      return { ok: true, msg: 'Opening Sunrise Market catalog…', openPanel: 'shop', storeId: 'market' };
    }

    if (t.kind === 'spot' && key === 'brew_home_tea') {
      const teaMins = this.hasPerk('ngocbich') ? 480 : 240;
      if ((s.bag.herbal_tea ?? 0) > 0) {
        s.bag.herbal_tea--;
        if (!s.bag.herbal_tea) delete s.bag.herbal_tea;
        s.needs.mood = clamp(s.needs.mood + 18, 0, 100);
        s.needs.focus = clamp(s.needs.focus + 16, 0, 100);
        s.needs.energy = clamp(s.needs.energy + 15, 0, 100);
        this.applyActivityNeeds('drink_tea');
        this.grantMoodlet('tea_calm', teaMins);
        this.gainSubSkillXp('coffeeCraft', 12);
        this.triggerUrgeEvent('home_care', 'tea');
        V3.recordTutorialSignal(s, 'interactedObject');
        const msg = 'Brewed fragrant Jasmine Herbal Tea (+18 Mood, +16 Focus, +15 Energy · Tea Calm).';
        this.say(msg, 'good');
        this.dirty = true;
        return { ok: true, msg };
      }
      if (s.elapsed - this.lastHomeTeaAt < 90) {
        return { ok: false, msg: 'The kettle just cooled — wait a moment before brewing another pot.' };
      }
      this.lastHomeTeaAt = s.elapsed;
      s.needs.energy = clamp(s.needs.energy + 10, 0, 100);
      s.needs.focus = clamp(s.needs.focus + 8, 0, 100);
      s.needs.mood = clamp(s.needs.mood + 6, 0, 100);
      this.applyActivityNeeds('drink_tea');
      this.grantMoodlet('tea_calm', teaMins);
      this.gainSubSkillXp('coffeeCraft', 8);
      this.triggerUrgeEvent('home_care', 'tea');
      V3.recordTutorialSignal(s, 'interactedObject');
      const msg = 'Steeped a warm pot of home kettle tea (+10 Energy, +8 Focus, +6 Mood · Tea Calm).';
      this.say(msg, 'good');
      this.dirty = true;
      return { ok: true, msg };
    }

    if (t.kind === 'spot' && (key === 'wash_hands' || key === 'toilet' || key === 'mirror')) {
      if (key === 'wash_hands') {
        this.mindState.needs = applyNeedDeltas(this.mindState.needs, { hygiene: 28, energy: 4 });
        s.needs.hygiene = clamp(this.mindState.needs.hygiene, 0, 100);
        s.needs.energy = clamp(s.needs.energy + 4, 0, 100);
        this.lastV3VitalsSnap = { energy: s.needs.energy, hunger: s.needs.hunger, hygiene: s.needs.hygiene, mood: s.needs.mood };
        if (this.mindState.needs.hygiene >= 35) this.clearNegativeHygieneMood();
        this.triggerUrgeEvent('home_care', 'wash_hands');
        V3.recordTutorialSignal(s, 'interactedObject');
        const msg = 'Washed hands and splashed cool water (+28 Hygiene).';
        this.say(msg, 'good');
        this.dirty = true;
        return { ok: true, msg };
      }
      if (key === 'toilet') {
        this.applyActivityNeeds('use_bathroom');
        this.triggerUrgeEvent('home_care', 'toilet');
        V3.recordTutorialSignal(s, 'interactedObject');
        const msg = 'Freshened up in the bathroom (Bathroom need restored).';
        this.say(msg, 'good');
        this.dirty = true;
        return { ok: true, msg };
      }
      // mirror: confidence + recognition pep talk (A6)
      this.mindState.needs = applyNeedDeltas(this.mindState.needs, { recognition: 12, fun: 8, hygiene: 6 });
      s.needs.mood = clamp(s.needs.mood + 8, 0, 100);
      this.lastV3VitalsSnap = { energy: s.needs.energy, hunger: s.needs.hunger, hygiene: s.needs.hygiene, mood: s.needs.mood };
      this.clearNegativeHygieneMood();
      this.pushMindEvent('creative_milestone', 0.6);
      this.gainSubSkillXp('rhetoric', 8);
      this.triggerUrgeEvent('home_care', 'mirror');
      V3.recordTutorialSignal(s, 'interactedObject');
      const msg = 'Practiced a calm pep talk in the mirror (+12 Recognition, +8 Mood).';
      this.say(msg, 'good');
      this.dirty = true;
      return { ok: true, msg };
    }

    if (t.kind === 'spot' && t.hotspot.action === 'use_appliance') {
      if (key === 'open_build') return { ok: true, msg: 'Opening Build Mode…', openPanel: 'build', targetInstanceId: t.hotspot.id };
      s.player.zone = t.hotspot.zone; s.player.x = t.hotspot.local.x; s.player.z = t.hotspot.local.z;
      const res = V3.interact(s, t.hotspot.id, 'brew_use');
      s.player.zone = this.lastZone ?? keep.zone; s.player.x = keep.x; s.player.z = keep.z;
      s.posture = '';
      this.entityCache.clear();
      if (res.ok) {
        this.applyActivityNeeds('drink_coffee');
        this.grantMoodlet('caffeinated', 240);
        this.gainSubSkillXp('coffeeCraft', 14);
        this.triggerUrgeEvent('home_care', 'appliance');
      }
      if (res.msg) this.say(res.msg, res.ok ? 'good' : 'bad');
      this.report('use_appliance', before);
      this.dirty = true;
      return res;
    }

    if (t.kind === 'spot' && (t.hotspot.action === 'bath_soak' || key === 'bath_soak')) {
      if (key === 'open_build') return { ok: true, msg: 'Opening Build Mode…', openPanel: 'build', targetInstanceId: t.hotspot.id };
      this.applyActivityNeeds('soak_tub');
      s.needs.hygiene = clamp(Math.max(s.needs.hygiene, this.mindState.needs.hygiene), 0, 100);
      s.needs.mood = clamp(s.needs.mood + 15, 0, 100);
      s.needs.energy = clamp(s.needs.energy + 10, 0, 100);
      this.lastV3VitalsSnap = { energy: s.needs.energy, hunger: s.needs.hunger, hygiene: s.needs.hygiene, mood: s.needs.mood };
      this.triggerUrgeEvent('home_care', 'bath_soak');
      V3.recordTutorialSignal(s, 'interactedObject');
      const msg = 'Enjoyed a warm soak in your Veranda tub (Hygiene restored, +15 Mood, +10 Energy).';
      this.say(msg, 'good');
      this.dirty = true;
      return { ok: true, msg };
    }

    if (t.kind === 'spot' && key === 'residence_study') {
      const comfort = this.computeHomeComfort();
      const focusMult = (1 + comfort.focusBonus) * (this.hasPerk('anchi') ? 1.2 : 1);
      const focusGain = Math.round(16 * focusMult);
      s.needs.focus = clamp(s.needs.focus + focusGain, 0, 100);
      s.needs.mood = clamp(s.needs.mood + 4, 0, 100);
      this.applyActivityNeeds('study_focus');
      this.gainSubSkillXp('rhetoric', 14);
      this.pushMindEvent('deep_study', 0.9);
      this.triggerUrgeEvent('study_session', 'residence');
      V3.awardSkillXp(s, 'social', 10);
      V3.awardSkillXp(s, 'technology', 8);
      V3.record(s, 'study');
      V3.recordTutorialSignal(s, 'interactedObject');
      const msg = `Read quietly at your home desk (+${focusGain} Focus, +10 Social XP, +8 Tech XP).`;
      this.say(msg, 'good');
      this.report('residence_study', before);
      this.dirty = true;
      return { ok: true, msg };
    }

    let res: V3Result;
    if (t.kind === 'npc') {
      const n = s.npcs[t.id];
      if (!n) return { ok: false, msg: 'Resident not found.' };
      s.player.zone = n.zone; s.player.x = n.x; s.player.z = n.z;
      res = V3.interact(s, 'npc-' + t.id, key);
    } else {
      const e = this.entityFor(t.hotspot) ?? t.entity;
      s.player.zone = t.hotspot.zone; s.player.x = e.x; s.player.z = e.z;
      res = V3.interact(s, e.id, key);
    }
    // V3's client runs a paid shift the prop asked for (`workActivity`): the same rule, here.
    if (res.ok && typeof res.workActivity === 'string') {
      const shift = V3.performWorkActivity(s, res.workActivity, s.owner);
      res = { ...shift, msg: shift.msg };
      if (shift.ok) V3.recordTutorialSignal(s, 'interactedObject');
    }
    // The body stays where it is: V3 postures (sit / sleep / study) are moments here, not a pose that blocks walking.
    s.player.zone = this.lastZone ?? keep.zone; s.player.x = keep.x; s.player.z = keep.z;
    s.posture = '';
    this.entityCache.clear();
    // Apply lifestyle moodlet triggers, 8-need bridge, sub-skills, urges & relationship perks cleanly without mutating V3 rules
    if (res.ok && t.kind === 'npc') {
      this.applyActivityNeeds('chat_resident');
      this.gainSubSkillXp('rhetoric', 10);
      this.triggerUrgeEvent('talk_resident', t.id);
      if (key.startsWith('gift:') || key.startsWith('encourage') || key.startsWith('apologize')) {
        this.applyKarma(key.startsWith('gift:') ? 'gift_resident' : 'help_resident');
      }
      this.pushMindEvent('karma_good', 0.65);
    } else if (res.ok && t.kind === 'spot') {
      if (t.hotspot.action === 'sleep') {
        const comfort = this.computeHomeComfort();
        this.applyActivityNeeds('sleep_bed');
        this.grantMoodlet('well_rested', Math.round(480 * comfort.restMultiplier));
      } else if (t.hotspot.action === 'bath' || t.hotspot.action === 'shower') {
        this.applyActivityNeeds('take_shower');
        this.triggerUrgeEvent('home_care', 'bath');
      } else if (t.hotspot.action === 'clean' || t.hotspot.action === 'wash') {
        this.applyActivityNeeds('tidy_home');
        this.applyKarma('tidy_litter');
        this.triggerUrgeEvent('home_care', 'tidy');
      } else if (t.hotspot.action === 'eat') {
        this.applyActivityNeeds('eat_home_meal');
        this.pushMindEvent('warm_meal', 0.8);
      } else if (t.hotspot.action === 'cook') {
        this.gainSubSkillXp('cooking', 14);
        this.triggerUrgeEvent('cook_meal', 'v3_stove');
      } else if (t.hotspot.action === 'tea_ceremony') {
        this.applyActivityNeeds('drink_tea');
        this.grantMoodlet('tea_calm', this.hasPerk('ngocbich') ? 480 : 240);
        this.gainSubSkillXp('coffeeCraft', 12);
      } else if (t.hotspot.action === 'bistro_order' || t.hotspot.action === 'bistro_snack') {
        this.applyActivityNeeds('eat_bistro_treat');
        this.grantMoodlet('caffeinated', 240);
        this.triggerUrgeEvent('order_bistro', 'matcha_crepe');
        this.pushMindEvent('warm_meal', 0.85);
        if (this.hasPerk('khanhha')) {
          s.needs.mood = clamp(s.needs.mood + 10, 0, 100);
          s.needs.focus = clamp(s.needs.focus + 8, 0, 100);
        }
      } else if (t.hotspot.action === 'library_study' || t.hotspot.action === 'archive_research' || t.hotspot.action === 'learn' || t.hotspot.action === 'desk') {
        this.applyActivityNeeds('study_focus');
        this.gainSubSkillXp('rhetoric', 12);
        this.pushMindEvent('deep_study', 0.9);
        this.triggerUrgeEvent('study_session', t.hotspot.action);
        if (this.hasPerk('anchi')) s.needs.focus = clamp(s.needs.focus + 5, 0, 100);
      } else if (t.hotspot.action === 'garden_tend' || t.hotspot.action === 'garden_harvest') {
        this.applyActivityNeeds('tend_garden');
        this.gainSubSkillXp('gardening', t.hotspot.action === 'garden_harvest' ? 20 : 14);
        this.triggerUrgeEvent('garden_tend', t.hotspot.action);
        this.applyKarma('garden_care');
      } else if (t.hotspot.action === 'music_jam') {
        this.applyActivityNeeds('play_music');
        this.gainSubSkillXp('music', 18);
        this.triggerUrgeEvent('music_jam', t.hotspot.zone);
        this.pushMindEvent('creative_milestone', 0.8);
        if (this.lastBody) {
          this.people.notifyBuskerPerformance(s, this.lastBody.x, this.lastBody.z, t.hotspot.zone);
        }
      } else if (t.hotspot.action === 'exercise') {
        this.applyActivityNeeds('play_basketball');
        this.gainSubSkillXp('fitness', 14);
        this.grantMoodlet('hot_streak', 180);
      } else if (t.hotspot.action === 'photo_snap') {
        this.applyActivityNeeds('take_photo');
        this.gainSubSkillXp('photography', 14);
        this.triggerUrgeEvent('take_photo', t.hotspot.zone);
      }
    }
    if (res.msg) this.say(res.msg, res.ok ? 'info' : 'bad');
    for (const m of s.worldV3?.recentFeed?.slice(-2) ?? []) if (!this.feed.some(f => f.text === cleanDisplayCopy(m))) this.say(m, 'story');
    this.report(t.kind === 'npc' ? 'talk:' + t.id + ':' + key.split(':')[0] : t.kind === 'spot' ? t.hotspot.action : 'bike', before);
    this.dirty = true;
    return res;
  }

  /** Keep Basketball shootaround armed across consecutive shots while preserving V3 daily credits & server XP caps. */
  finishBasket(scored: boolean, meta?: { threePointer?: boolean; streak?: number }) {
    if (this.s.challenge?.type !== 'sport') return;
    const s = this.s, before = this.snap();
    if (scored) {
      this.basketStreak = meta?.streak ?? (this.basketStreak + 1);
      if (this.basketStreak > this.bestBasketStreak) this.bestBasketStreak = this.basketStreak;
      this.threeStreak = meta?.threePointer ? this.threeStreak + 1 : 0;
      resetDailyEconomyIfNeeded(s);
      const economy = s.progression.economy;
      const creditsBefore = economy.credits;
      if (economy.minigameWinsToday < (V3.CATALOG.economy.antiExploitGuards as { maxPaidMinigamesPerGameDay: number }).maxPaidMinigamesPerGameDay) {
        economy.minigameWinsToday++;
        awardCredits(s, 18, { bounded: true });
      }
      const earned = Math.max(0, economy.credits - creditsBefore);
      if (earned > 0) this.recordCreditChange('Riverside Park Basketball', earned, economy.credits);
      s.needs.mood = clamp(s.needs.mood + 6, 0, 100);
      this.applyActivityNeeds('play_basketball');
      this.gainSubSkillXp('fitness', meta?.threePointer ? 20 : 14);
      this.triggerUrgeEvent('basketball_score', meta?.threePointer ? 'three_pointer' : 'basket');
      V3.awardSkillXp(s, 'mobility', 18);
      V3.record(s, 'win-sport');
      const hotStreak = this.basketStreak > 0 && this.basketStreak % 3 === 0;
      if (hotStreak) {
        V3.awardSkillXp(s, 'mobility', 15);
        s.needs.mood = clamp(s.needs.mood + 10, 0, 100);
        s.needs.fitness = clamp(s.needs.fitness + 5, 0, 100);
        this.grantMoodlet('hot_streak', 180);
        this.pushMindEvent('basketball_streak', 1.2);
        this.emitMilestoneFeedPost('basketball_streak');
      }
      this.report('win-sport', before);
      if (meta?.threePointer && this.threeStreak >= 3 && this.threeStreak % 3 === 0) {
        this.say('3-Point Streak Challenge Complete! 3 triples in a row (+15 bonus Mobility XP, +10 Mood)!', 'good');
      } else if (hotStreak) {
        this.say(`Hot Streak! ${this.basketStreak} baskets in a row (+15 bonus Mobility XP, +10 Mood)!`, 'good');
      } else if (meta?.threePointer) {
        this.say('3-Pointer! Swish from beyond the arc — collect the ball or press R for your next shot.', 'good');
      } else {
        this.say('Basket! Collect the ball or press R for another shot.', 'good');
      }
    } else {
      this.basketStreak = 0;
      this.threeStreak = 0;
      this.say('Missed. Collect your rebound or press R to shoot again.', 'info');
    }
    this.dirty = true;
  }

  /** Cleanly exit continuous basketball shootaround (when leaving court or walking > 14 m from the hoop). */
  leaveBasketballCourt() {
    if (this.s.challenge?.type === 'sport') this.s.challenge = null;
    this.basketStreak = 0;
    this.threeStreak = 0;
    this.wasOnCourt = false;
  }

  /** V3 minigame input (arrow sequence / timing bar). */
  challenge(i: number) {
    const before = this.snap();
    const type = this.s.challenge?.type ?? 'challenge';
    const r = V3.challengeInput(this.s, i);
    if (r === true) {
      if (type === 'music_jam') {
        this.gainSubSkillXp('music', 22);
        this.triggerUrgeEvent('music_jam', 'challenge');
      }
      this.say('Challenge won!', 'good');
    } else if (r === false) {
      this.say('Not this time — try again.', 'bad');
    }
    if (r !== null) { this.report('win-' + type, before); this.dirty = true; }
    return r;
  }

  /** A tutorial / exploration signal from the host UI (opened the map, the bag, the journal, build mode, rode, jumped…). */
  signal(name: string) {
    const r = V3.recordTutorialSignal(this.s, name);
    if (r?.msg) this.say(r.msg, 'good');
    this.dirty = true;
  }

  skipTutorial() { V3.skipTutorial(this.s); this.dirty = true; }

  sceneById(id: string) { return V3.SOCIAL_SCENES.find(sc => sc.id === id) ?? null; }

  /** Live NPC-to-NPC scenes the learner stands near (within 4 m of a participant): they may join (V3 `join_social_scene`). */
  scenesNear(body: P) {
    return this.people.stats.scenes.map(id => this.sceneById(id)).filter((sc): sc is NonNullable<typeof sc> => !!sc && sc.participants.some(pid => {
      const w = this.people.walkers.get(pid);
      return !!w && Math.hypot(w.x - body.x, w.z - body.z) < 4;
    }));
  }

  joinScene(id: string): V3Result {
    if (!this.people.stats.scenes.includes(id)) return { ok: false, msg: 'That conversation has wrapped up.' };
    const before = this.snap();
    const res = V3.performFreeRoamAction(this.s, 'join_social_scene', id);
    if (res.ok) {
      V3.recordTutorialSignal(this.s, 'talkedNpc');
      this.applyActivityNeeds('chat_resident');
      this.gainSubSkillXp('rhetoric', 14);
      this.triggerUrgeEvent('talk_resident', id);
      if (this.hasPerk('linh')) this.s.needs.mood = clamp(this.s.needs.mood + 5, 0, 100);
    }
    this.say(res.msg, res.ok ? 'good' : 'bad');
    this.report('scene:' + id, before);
    this.dirty = true;
    return res;
  }

  workshopEvent(type: string) {
    if (type === 'select_vehicle') { this.dirty = true; return; }
    this.syncDynamicWorkshopSeats();
    const before = this.snap();
    const event = type === 'install_pc_part' ? 'progression:pc_upgraded' : type === 'customize_vehicle' ? 'activity:delivery_or_tune' : 'progression:build_styled';
    V3.advanceSideQuests(this.s, event);
    if (type === 'install_pc_part') this.gainSubSkillXp('rhetoric', 14);
    else if (type !== 'customize_vehicle') this.gainSubSkillXp('art', 18);
    this.signal('usedBuildMode');
    this.report('workshop', before);
  }

  replayTutorial() { V3.replayTutorial(this.s); this.dirty = true; }

  /** Study Space interactions count as V3 interactions; a desk session is V3's `study` event (mission "Time to recharge"). */
  studied(desk: boolean) {
    const before = this.snap();
    V3.recordTutorialSignal(this.s, 'interactedObject');
    if (desk) {
      const bonus = this.hasPerk('anchi') ? 8 : 6;
      this.s.needs.focus = clamp(this.s.needs.focus + bonus, 0, 100);
      this.applyActivityNeeds('study_focus');
      this.gainSubSkillXp('rhetoric', 10);
      this.pushMindEvent('deep_study', 0.85);
      this.triggerUrgeEvent('study_session', 'desk');
      V3.awardSkillXp(this.s, 'technology', 12);
      V3.record(this.s, 'study');
    }
    this.report(desk ? 'desk' : 'object', before);
    this.dirty = true;
  }

  // ── Economy (server-authoritative) ──────────────────────────────────────────────────────────────────────
  private snap(s = this.s): Snap {
    const w = s.worldV3;
    return {
      done: new Set(s.done),
      side: new Set(Object.entries(w?.sideQuests ?? {}).filter(([, v]) => v.done).map(([k]) => k)),
      choices: new Set(Object.entries(w?.storyChoices ?? {}).map(([k, v]) => `${k}:${v}`)),
      landmarks: new Set(w?.exploration.discoveredLandmarks ?? []),
      relics: new Set(w?.exploration.collectibles ?? []),
      credits: s.progression.economy.credits,
      xp: Object.fromEntries(Object.entries(s.progression.skills).map(([k, v]) => [k, v.xp])),
    };
  }

  private rewardBatch(source: string, before: Snap, state = this.s, spent: ClaimBatch['spent'] = [], paid = 0): ClaimBatch {
    const after = this.snap(state);
    const uniques: string[] = [];
    for (const id of after.done) if (!before.done.has(id)) uniques.push('mission:' + id);
    for (const id of after.side) if (!before.side.has(id)) uniques.push('side:' + id);
    for (const id of after.choices) if (!before.choices.has(id)) uniques.push('choice:' + id);
    for (const id of after.landmarks) if (!before.landmarks.has(id)) uniques.push('landmark:' + id);
    for (const id of after.relics) if (!before.relics.has(id)) uniques.push('relic:' + id);
    const xp: Record<string, number> = {};
    for (const [k, v] of Object.entries(after.xp)) if (v > (before.xp[k] ?? 0)) xp[k] = v - (before.xp[k] ?? 0);
    return { source, uniques, credits: Math.max(0, after.credits - before.credits + paid), xp, spent };
  }

  private report(source: string, before: Snap) {
    const batch = this.rewardBatch(source, before);
    if (batch.uniques.length || batch.credits || Object.keys(batch.xp).length) this.claims.push(batch);
  }

  /** Run the normal V3 interaction on a draft. The live inventory changes only after payment commits. */
  marketCheckout(t: Extract<Target, { kind: 'spot' }>, key: string) {
    if (key === 'open_market_shop') {
      return {
        result: { ok: false, msg: 'Opening Sunrise Market catalog…', openPanel: 'shop', storeId: 'market' } as V3Result,
        batch: { source: 'checkout', uniques: [], credits: 0, xp: {}, spent: [] } as ClaimBatch,
        doc: this.serialize(),
        draft: structuredClone(this.s),
      };
    }
    const draft = structuredClone(this.s);
    const entity = this.entityFor(t.hotspot);
    if (!entity || !['checkout', 'bistro_order', 'bistro_snack'].includes(entity.action)) return null;
    const meal = entity.action !== 'checkout';
    const before = this.snap(draft);
    const position = { ...draft.player };
    const sale = !meal && V3.getActiveEvents(draft).some(e => e.id === 'evt_market_produce_sale');
    const oldSpent = draft.progression.economy.lifetimeSpent;

    // Multi-item Willow Bistro menu checkout (`bistro_order:<sku>` for all 5 server-authoritative SKUs)
    if (meal && key.startsWith('bistro_order:')) {
      const sku = key.slice('bistro_order:'.length);
      const menuItem = BISTRO_SKU_SET.has(sku) ? getBistroItem(sku) : null;
      if (!menuItem) {
        return {
          result: { ok: false, msg: 'That item is not on the Willow Corner Bistro menu.' } as V3Result,
          batch: { source: 'checkout', uniques: [], credits: 0, xp: {}, spent: [] } as ClaimBatch,
          doc: this.serialize(draft),
          draft,
        };
      }
      const rep = this.people.getDistrictReputation('bistro');
      const order = orderBistroItem(menuItem.id, draft.progression.economy.credits, {
        hasBaristaPerk: this.hasPerk('khanhha'),
        discountPct: rep.discountPct,
      });
      if (!order.ok || !order.item) {
        return {
          result: { ok: false, msg: order.reason } as V3Result,
          batch: { source: 'checkout', uniques: [], credits: 0, xp: {}, spent: [] } as ClaimBatch,
          doc: this.serialize(draft),
          draft,
        };
      }
      draft.progression.economy.credits = order.remainingCredits;
      draft.progression.economy.lifetimeSpent += order.cost;
      draft.cash = order.remainingCredits;
      draft.needs.hunger = clamp(draft.needs.hunger + order.needsDelta.hunger, 0, 100);
      draft.needs.energy = clamp(draft.needs.energy + order.needsDelta.energy, 0, 100);
      draft.needs.mood = clamp(draft.needs.mood + order.needsDelta.mood, 0, 100);
      if (this.hasPerk('khanhha')) draft.needs.focus = clamp(draft.needs.focus + 8, 0, 100);
      draft.bag[menuItem.bagItemId] = (draft.bag[menuItem.bagItemId] ?? 0) + 1;
      if (draft.worldV3?.activityCounts) {
        draft.worldV3.activityCounts.bistro_order = (draft.worldV3.activityCounts.bistro_order ?? 0) + 1;
      }
      const spent: ClaimBatch['spent'] = [{ kind: 'bistro', items: [menuItem.id], sale: false }];
      const batch = this.rewardBatch('checkout', before, draft, spent, draft.progression.economy.lifetimeSpent - oldSpent);
      return {
        result: { ok: true, msg: order.reason } as V3Result,
        batch,
        doc: this.serialize(draft),
        draft,
        bistroSku: menuItem.id,
        bistroBuff: order.buff,
      };
    }

    const items = meal ? ['matcha_crepe'] : [...draft.basket];
    Object.assign(draft.player, { zone: t.hotspot.zone, x: entity.x, z: entity.z });
    const result = V3.interact(draft, entity.id, key);
    Object.assign(draft.player, position);
    const spent: ClaimBatch['spent'] = [{ kind: meal ? 'bistro' : 'market', items, sale }];
    const batch = this.rewardBatch('checkout', before, draft, spent, draft.progression.economy.lifetimeSpent - oldSpent);
    return { result, batch, doc: this.serialize(draft), draft };
  }

  /**
   * Store counter proximity & open-hours access (includes Sunrise Market's checkout counter and live 20% sale status).
   */
  storeAccess(id: string) {
    const p = this.lastBody;
    const points = this.hotspots.filter(h =>
      h.action === 'shop_' + id || (id === 'market' && h.zone === 'market' && h.action === 'checkout'),
    );
    const zone = points[0]?.zone;
    if (!zone) return { canBuy: false, note: 'Visit the store counter.' };
    const hours = V3.isZoneOpen(V3.zones[zone], this.s.clock);
    const near = !!p && this.lastZone === zone && points.some(h =>
      Math.min(Math.hypot(h.stand.x - p.x, h.stand.z - p.z), Math.hypot(h.at.x - p.x, h.at.z - p.z)) < 2.75,
    );
    const saleTag = id === 'market' && isMarketFlashSaleLive(this.s.clock) ? ' · 20% SALE' : '';
    return {
      canBuy: near && hours.open,
      note: (near ? 'Self checkout' : 'Visit ' + this.zoneName(zone) + ' to buy') + ' · ' + hours.note + saleTag,
    };
  }

  /**
   * A purchase the server accepted (its price, its instance id): V3's own `buyShopItem` applies it to the game (bag, materials,
   * outfits, owned objects with placement), the new owned object takes the server's id, and the server wallet is re-applied.
   */
  applyPurchase(storeId: string, sku: string, instanceId: string, wallet: Wallet): V3Result {
    const s = this.s, p = s.progression;
    const creditsBefore = p.economy.credits;
    const ownedPropList = (p.properties as { ownedIds?: string[] } | undefined)?.ownedIds;
    const propCountBefore = Array.isArray(ownedPropList) ? ownedPropList.length : 0;
    if (wallet.workshop && V3.CATALOG.shops[storeId]?.items.find(i => i.sku === sku)?.itemType !== 'grocery') {
      this.applyWallet(wallet);
      const spent = creditsBefore - p.economy.credits;
      if (spent > 0) this.recordCreditChange(`Shop Purchase (${sku})`, -spent, p.economy.credits);
      const nextPropList = (p.properties as { ownedIds?: string[] } | undefined)?.ownedIds;
      if (Array.isArray(nextPropList) && nextPropList.length > propCountBefore) {
        this.emitMilestoneFeedPost('new_home');
      }
      if (storeId === 'furniture_shop' || storeId === 'home_center') this.triggerUrgeEvent('home_care', sku);
      V3.recordTutorialSignal(s, 'purchasedItem'); V3.record(s, 'purchase'); this.dirty = true;
      return { ok: true, msg: 'Added to your inventory.' };
    }
    const before = new Set(p.ownedObjects.map(o => o.instanceId));
    const item = V3.CATALOG.shops[storeId]?.items.find(i => i.sku === sku);
    const localPrice = item ? Math.max(1, Math.round(item.price * (1 - V3.getStoreDiscountRate(s)))) : 0;
    p.economy.credits += localPrice;
    const res = V3.buyShopItem(s, storeId, sku, s.owner);
    for (const o of p.ownedObjects) {
      if (before.has(o.instanceId)) continue;
      if (p.activeVehicleId === o.instanceId) p.activeVehicleId = instanceId;
      o.instanceId = instanceId;
    }
    this.applyWallet(wallet);
    const spent = creditsBefore - p.economy.credits;
    if (spent > 0) this.recordCreditChange(`Shop: ${item?.name ?? sku}`, -spent, p.economy.credits);
    if (res.ok) {
      if (storeId === 'furniture_shop' || storeId === 'home_center') this.triggerUrgeEvent('home_care', sku);
      const nextPropList = (p.properties as { ownedIds?: string[] } | undefined)?.ownedIds;
      if (Array.isArray(nextPropList) && nextPropList.length > propCountBefore) {
        this.emitMilestoneFeedPost('new_home');
      }
      V3.recordTutorialSignal(s, 'purchasedItem'); V3.record(s, 'purchase');
    }
    this.say(res.msg, res.ok ? 'good' : 'bad');
    this.entityCache.clear();
    this.syncDynamicWorkshopSeats();
    this.dirty = true;
    return res;
  }

  /** A sale the server accepted: V3's own `sellOwnedObject`, then the server's wallet. */
  applySale(instanceId: string, wallet: Wallet): V3Result {
    const creditsBefore = this.s.progression.economy.credits;
    const res = wallet.workshop ? { ok: true, msg: 'Sold.' } : V3.sellOwnedObject(this.s, instanceId, this.s.owner);
    this.applyWallet(wallet);
    this.syncDynamicWorkshopSeats();
    const delta = this.s.progression.economy.credits - creditsBefore;
    if (delta > 0) this.recordCreditChange('Item Resale', delta, this.s.progression.economy.credits);
    this.say(res.msg, res.ok ? 'good' : 'bad');
    this.dirty = true;
    return res;
  }

  /** Ensures all 4 owned automobile models (`car_mango_micro`, `car_river_sedan`, `car_lotus_spider`, `car_halo_vector`) stay drivable. */
  private ensureAllFourCarsDrivable(w: Wallet) {
    const skuToCarModel: Record<string, string> = {
      sku_car_mango: 'car_mango_micro',
      sku_car_mango_micro: 'car_mango_micro',
      sku_car_river: 'car_river_sedan',
      sku_car_river_sedan: 'car_river_sedan',
      sku_car_sedan: 'car_river_sedan',
      sku_car_lotus: 'car_lotus_spider',
      sku_car_lotus_spider: 'car_lotus_spider',
      sku_car_halo: 'car_halo_vector',
      sku_car_halo_vector: 'car_halo_vector',
    };
    const ownedCars: Array<{
      instanceId: string;
      selectedVariantId: string;
      category: string;
      customAppearance?: { primaryColor?: string };
      installedComponents?: Record<string, string>;
    }> = [];
    const seen = new Set<string>();
    const pushIfCar = (
      instanceId: string | undefined,
      model: string | undefined,
      extra?: { customAppearance?: { primaryColor?: string }; installedComponents?: Record<string, string> },
    ) => {
      if (!instanceId || !model || !Object.hasOwn(ALL_DRIVABLE_CAR_MODELS, model) || seen.has(instanceId)) return;
      seen.add(instanceId);
      ownedCars.push({
        instanceId,
        selectedVariantId: model,
        category: 'vehicle_display',
        customAppearance: extra?.customAppearance,
        installedComponents: extra?.installedComponents,
      });
    };
    for (const o of w.workshop?.ownedObjects ?? []) {
      pushIfCar(o.instanceId, o.selectedVariantId, o as { customAppearance?: { primaryColor?: string }; installedComponents?: Record<string, string> });
    }
    for (const o of this.s.progression.ownedObjects) {
      pushIfCar(o.instanceId, o.selectedVariantId, o as { customAppearance?: { primaryColor?: string }; installedComponents?: Record<string, string> });
    }
    for (const o of w.owned ?? []) {
      const model = skuToCarModel[o.sku] ?? (Object.hasOwn(ALL_DRIVABLE_CAR_MODELS, o.sku) ? o.sku : undefined);
      pushIfCar(o.instanceId, model);
    }
    if (!ownedCars.length) return;
    const desiredId = w.workshop?.activeCarId ?? this.s.progression.activeCarId ?? (this.s.worldV3.car as { instanceId?: string })?.instanceId;
    if (this.car.spec && (!desiredId || this.car.spec.instanceId === desiredId)) return;
    const resolved = getActiveCarSpec({
      progression: { ownedObjects: ownedCars },
      worldV3: {
        car: { instanceId: desiredId },
        openRoadPermit: w.claimed.includes('side:sq_open_road') || !!this.s.worldV3.openRoadPermit,
      },
    });
    if (resolved) {
      this.car.spec = resolved;
    }
  }

  /** Apply the server's wallet: credits, skill XP (levels recomputed), the authoritative claimed set. */
  applyWallet(w: Wallet) {
    const p = this.s.progression;
    const prevCredits = p.economy.credits;
    const hadWallet = this.walletApplied;
    const wasRidingPersonalBike = this.riding && !this.ridingShared && !this.twoWheeler.driving;
    const handoffBikePose = {
      x: this.lastBody?.x ?? this.bike.x,
      z: this.lastBody?.z ?? this.bike.z,
      yaw: this.bike.yaw,
    };
    if (w.workshop && (w.workshopRevision ?? 0) > this.workshopRevision) {
      const server = w.workshop;
      for (const key of ['ownedObjects', 'componentInventory', 'materials', 'properties', 'roomStyles', 'unlockedStyles', 'undoStack', 'redoStack'] as const) {
        if (Object.hasOwn(server, key)) Object.assign(p, { [key]: structuredClone(server[key]) });
      }
      p.activeShift = server.activeShift;
      p.activeVehicleId = server.activeVehicleId;
      p.activeCarId = server.activeCarId;
      this.workshopRevision = w.workshopRevision ?? 0;
      this.entityCache.clear();
      this.syncDynamicWorkshopSeats();
    }
    if ((w.workshopRevision ?? 0) >= this.workshopRevision) {
      this.twoWheeler.authorize(w);
      // A10 Mid-Ride Wallet Handoff: if wallet hydration activates `obj_starter_bike` while mounted on `this.bike`,
      // transfer the live bike pose onto `this.twoWheeler` and hand off cleanly so the mounted bike never vanishes.
      if (wasRidingPersonalBike && this.twoWheeler.spec) {
        this.twoWheeler.pose.x = handoffBikePose.x;
        this.twoWheeler.pose.z = handoffBikePose.z;
        this.twoWheeler.pose.yaw = handoffBikePose.yaw;
        this.twoWheeler.snapshot();
        this.twoWheeler.driving = true;
        this.riding = false;
        this.ridingShared = false;
        this.s.player.riding = false;
        this.s.player.driving = true;
      }
      this.car.authorize(w, (this.s.worldV3.car as { instanceId?: string })?.instanceId);
      this.ensureAllFourCarsDrivable(w);
    }
    p.economy.credits = w.credits;
    this.s.cash = w.credits;
    if (hadWallet && w.credits !== this.lastTrackedCredits && w.credits !== prevCredits) {
      const delta = w.credits - prevCredits;
      if (Math.abs(delta) > 0) {
        this.recordCreditChange(delta > 0 ? 'Campus Earnings' : 'Campus Spend', delta, w.credits);
      }
    } else {
      this.lastTrackedCredits = w.credits;
    }
    let total = 0;
    for (const [k, sk] of Object.entries(p.skills)) {
      const xp = Math.max(0, Math.round(w.skills[k] ?? 0));
      sk.xp = xp; sk.level = skillLevelFromXp(xp); total += xp;
    }
    p.totalXp = total;
    p.playerLevel = playerLevelFromXp(total);
    this.walletApplied = true;
  }
  get hasWallet() { return this.walletApplied; }

  // ── Views for the HUD and panels ───────────────────────────────────────────────────────────────────────
  zoneName(z: string | null) { return cleanDisplayCopy(z && z in V3_ZONE_META ? V3_ZONE_META[z as V3ZoneId].name.en : V3.zones[z ?? '']?.label ?? '—'); }

  journal() {
    const s = this.s, w = s.worldV3;
    const active = new Set(V3.active(s).map(q => q.id));
    return {
      chapters: V3.chapters.map((title, i) => ({
        title, index: i,
        missions: V3.quests.filter(q => q.chapter === i).map(q => ({
          id: q.id, title: q.title, zone: this.zoneName(q.zone), hint: q.hint, note: q.storyNote, reward: q.reward,
          state: s.done.includes(q.id) ? 'done' as const : active.has(q.id) ? 'active' as const : 'locked' as const,
          step: s.progress[q.id] ?? 0, steps: q.steps.length,
        })),
      })),
      choices: Object.values(V3.STORY_CHOICES).map(c => ({ id: c.id, title: c.title, chapter: c.chapter, made: w.storyChoices[c.id] ?? null, label: c.options.find(o => o.key === w.storyChoices[c.id])?.label ?? null })),
      ending: w.endingId ? V3.ENDINGS[w.endingId] ?? null : null,
      endings: Object.values(V3.ENDINGS).map(e => ({ id: e.id, title: e.title })),
      side: V3.SIDE_QUESTS.map(q => {
        const st = w.sideQuests[q.id] ?? { started: false, stage: 0, done: false };
        return { id: q.id, title: q.title, lead: V3.CHARACTERS[q.leadNpc]?.name ?? q.leadNpc, category: q.category, summary: q.summary, stage: st.stage, stages: q.stages.map(x => x.label), started: st.started, done: st.done };
      }),
      activities: V3.FREE_ROAM_ACTIVITY_CATALOG.map(a => ({ ...a, zoneName: this.zoneName(a.zone) })),
      daily: this.dailyEvents(),
      codex: {
        landmarks: V3.LANDMARKS.map(l => ({ id: l.id, name: cleanDisplayCopy(l.name), zone: this.zoneName(l.zone), found: w.exploration.discoveredLandmarks.includes(l.id), secret: !!l.secret })),
        relics: V3.COLLECTIBLES.map(c => ({ id: c.id, name: cleanDisplayCopy(c.name), zone: this.zoneName(c.zone), found: w.exploration.collectibles.includes(c.id) })),
        lore: Object.entries(V3.LORE_SPOTS).map(([id, l]) => ({ id, title: cleanDisplayCopy(l.title), read: w.exploration.loreRead.includes(id) })),
        photos: w.photos,
      },
    };
  }

  peopleList() {
    const perks = this.residentPerks();
    return V3.CHARACTER_IDS.map(id => {
      const c = V3.CHARACTERS[id], n = this.s.npcs[id], walker = this.people.walkers.get(id);
      const rel = n?.rel;
      const perk = perks.find(p => p.npcId === id) ?? null;
      const mindMemory = this.people.latestPlayerMemory(id, this.s.day);
      const v3Memory = rel?.memories.at(-1)?.detail ?? null;
      const latestMemory = mindMemory ?? v3Memory;
      return {
        id, name: c.name, role: cleanDisplayCopy(c.role), bio: cleanDisplayCopy(c.bio), goal: cleanDisplayCopy(c.goal), personality: c.personality,
        zone: this.zoneName(walker?.zone ?? n?.zone ?? null), note: cleanDisplayCopy(n?.scheduleNote ?? ''), activity: n?.activity ?? 'idle',
        walking: !!walker?.moving, at: walker ? { x: walker.x, z: walker.z } : null,
        badge: cleanDisplayCopy(this.npcBadge(id)),
        mood: this.people.getResidentMood(id) ?? walker?.mood ?? null,
        quip: this.people.getResidentQuip(id),
        thoughtBubble: this.getNpcThoughtBubble(id),
        latestMemory: latestMemory ? cleanDisplayCopy(latestMemory) : null,
        perk,
        rel: rel ? { friendship: rel.friendship, trust: rel.trust, familiarity: rel.familiarity, respect: rel.respect, rivalry: rel.rivalry, tier: V3.getRelationshipTier(rel), memories: rel.memories.slice(-4) } : null,
      };
    });
  }

  bag() {
    const s = this.s, p = s.progression;
    return {
      credits: p.economy.credits, level: p.playerLevel, totalXp: p.totalXp,
      skills: Object.entries(p.skills).map(([id, v]) => ({ id, name: cleanDisplayCopy(V3.CATALOG.skills.skills[id]?.name ?? id), xp: v.xp, level: v.level })),
      bag: s.bag, pantry: s.pantry, materials: p.materials, needs: s.needs, held: s.held,
      owned: p.ownedObjects.map(o => ({ id: o.instanceId, family: o.assetFamilyId, variant: o.selectedVariantId, category: o.category, level: o.upgradeLevel, zone: o.location.zoneId ?? null, stored: !!o.location.inStorage })),
      reputation: p.reputation, achievements: p.achievements.map(a => cleanDisplayCopy(V3.ACHIEVEMENTS[a]?.name ?? a)),
    };
  }

  /** Map data: the 31 zones, where each resident is, live events, the active mission's zone. */
  map() {
    const s = this.s;
    return {
      events: V3.getActiveEvents(s).map(e => ({ id: e.id, title: e.title, zone: e.zone })),
      objectives: V3.active(s).map(q => ({ id: q.id, title: q.title, zone: q.zone })),
      discovered: new Set(s.worldV3.exploration.discoveredZones),
      daily: this.dailyEvents(),
      activeShift: this.activeShiftTarget(),
    };
  }

  /** Ambient population for the renderer (V3 density rhythm scaled by Manage City pedestrianDensity). */
  crowd(avoid: P | null, ctx?: CrowdContext): Passer[] {
    const cal = this.calendar;
    const w = this.weather;
    const snow = /snow/i.test(w.label);
    const scale = clamp(this.phoneState.cityConfig.pedestrianDensity ?? 1, 0.3, 1.5);
    const count = Math.max(4, Math.round(crowdDensity(cal.phase, w.rain, snow) * scale));
    const c = this.crowdCtxScratch;
    c.vehicle = ctx?.vehicle ?? null;
    c.vehicles = ctx?.vehicles ?? (this.combinedActiveVehicles.length > 0 ? this.combinedActiveVehicles : undefined);
    c.parkedVehicles = ctx?.parkedVehicles ?? (this.parkedVehiclesBuf.length > 0 ? this.parkedVehiclesBuf : undefined);
    c.occupiedSeats = ctx?.occupiedSeats ?? this.people.occupiedSeatIds();
    c.rainIntensity = ctx?.rainIntensity ?? (w.rain ? 0.75 : 0);
    c.snowIntensity = ctx?.snowIntensity ?? (snow ? 0.75 : 0);
    c.phase = ctx?.phase ?? cal.phase;
    c.dt = ctx?.dt ?? (this.lastRawDt > 0 ? this.lastRawDt : undefined);
    c.timeScale = ctx?.timeScale ?? this.timeScale;
    c.playerVx = ctx?.playerVx;
    c.playerVz = ctx?.playerVz;
    c.residents = ctx?.residents ?? this.people.getResidentKinematics();
    c.densityApplied = true;
    const list = crowdAt(this.lanes, this.s.clock, count, avoid, p => this.nav.walk.free(p), c);
    this.lastCrowdPassers = list;
    return list;
  }

  /** Day light from the game clock (0 night … 1 noon), for the world's sky and interior lights. */
  daylight() {
    const m = this.s.clock % 1440, h = m / 60;
    if (h < 5 || h > 20.5) return 0;
    if (h < 7) return (h - 5) / 2;
    if (h > 18.5) return (20.5 - h) / 2;
    return 1;
  }
}

function clamp(v: number, a: number, b: number) { return Math.min(b, Math.max(a, v)); }
