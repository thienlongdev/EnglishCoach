/**
 * Echo Life Total Rebirth — Autonomous Resident Mind, Needs, Personality, Episodic Memory & Utility AI (A06).
 *
 * Pure deterministic client-side simulation layered cleanly over vendored V3 rules (`../v3/**` is NEVER modified).
 * ZERO LLM/network calls on passive ticks (AGENTS §17).
 * Compact bounded snapshot persists strictly under `s.worldV3.npcSim` (<= 6.5 KB) so `EchoLifeGameService`'s
 * 3-key `GameDoc` schema (`v`, `save`, `places`) and V3's `decode()` remain 100% compatible.
 */
import type { V3State } from '../v3/game-core/index.mjs';
import {
  CHARACTERS,
  CHARACTER_IDS,
  SIDE_QUESTS,
  active as activeMissions,
  getActiveEvents,
  getCalendar,
  getWeather,
  isZoneOpen,
  zones as v3Zones,
} from '../v3/game-core/index.mjs';
import { desiredScheduleFor } from '../v3/npc-ai/residents.mjs';
import { getActiveStoryChoiceForNpc } from '../v3/dialogue/npc-interactions.mjs';
import { V3_ZONE_IDS, type V3ZoneId } from '../zones';
import type { P } from './nav';
import {
  composeMemoryGreeting,
  formatMemoryRecollection,
  resolveBanterTone,
  zoneDisplayName,
} from './banterGrammar';

export type ResidentId =
  | 'linh' | 'minh' | 'huy' | 'mai' | 'lan'
  | 'anchi' | 'baolong' | 'khanhha' | 'ductri' | 'diemmy' | 'haidang'
  | 'kimngan' | 'quocbao' | 'thaovy' | 'duykhoa' | 'ngocbich' | 'tuankiet'
  | 'phuonglien' | 'quangvinh' | 'minhthu' | 'hoangphuc' | 'yennhi';

export const RESIDENT_IDS: readonly ResidentId[] = [
  'linh', 'minh', 'huy', 'mai', 'lan',
  'anchi', 'baolong', 'khanhha', 'ductri', 'diemmy', 'haidang',
  'kimngan', 'quocbao', 'thaovy', 'duykhoa', 'ngocbich', 'tuankiet',
  'phuonglien', 'quangvinh', 'minhthu', 'hoangphuc', 'yennhi',
] as const;

const RESIDENT_ID_SET = new Set<string>(RESIDENT_IDS);
const PUBLIC_ZONE_SET = new Set<string>(V3_ZONE_IDS.filter(z => z !== 'study'));

export function isResidentId(id: string): id is ResidentId {
  return RESIDENT_ID_SET.has(id);
}

/** Big-5 normalized personality dimensions in [0.0, 1.0]. */
export interface BigFiveTraits {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  calmness: number;
}

export interface ResidentProfile {
  readonly id: ResidentId;
  readonly traits: BigFiveTraits;
  /** 0 = shelters immediately on light rain; 1 = enjoys light rain with umbrella, only shelters on heavy rain. */
  readonly rainTolerance: number;
  /** Preferred discretionary third-place zones when needs/weather utilities win. */
  readonly thirdPlaces: readonly V3ZoneId[];
  /** Signature settled micro-activities. */
  readonly idleMicroActs: readonly ExpressiveActivity[];
  /** Circadian peak hour [0..23]. */
  readonly peakHour: number;
  /** Deterministic umbrella palette index [0..4]. */
  readonly umbrellaColor: number;
}

export interface ResidentNeeds {
  energy: number;
  hunger: number;
  social: number;
  focus: number;
  fun: number;
  comfort: number;
}

export type ResidentMood =
  | 'cheerful'
  | 'focused'
  | 'relaxed'
  | 'tired'
  | 'curious'
  | 'sheltering'
  | 'excited';

export const MOOD_LIST: readonly ResidentMood[] = [
  'cheerful',
  'focused',
  'relaxed',
  'tired',
  'curious',
  'sheltering',
  'excited',
] as const;

export type ExpressiveActivity =
  | 'idle' | 'walk' | 'run' | 'sit' | 'study' | 'read'
  | 'coffee' | 'chat' | 'stretch' | 'umbrella' | 'wave'
  | 'present' | 'cook' | 'wipe' | 'exercise_squat'
  | 'celebrate' | 'talk' | 'sleep' | 'nod' | 'laugh';

export type MemoryKind =
  | 'player_greet'
  | 'player_talk'
  | 'player_gift'
  | 'player_shared_activity'
  | 'player_vehicle_seen'
  | 'player_horn'
  | 'player_basketball'
  | 'weather_event'
  | 'social_chat'
  | 'rain_shelter';

export const MEMORY_KINDS: readonly MemoryKind[] = [
  'player_greet',
  'player_talk',
  'player_gift',
  'player_shared_activity',
  'player_vehicle_seen',
  'player_horn',
  'player_basketball',
  'weather_event',
  'social_chat',
  'rain_shelter',
] as const;

export interface EpisodicMemory {
  kind: MemoryKind;
  day: number;
  clock: number;
  subject: string;
  /** Emotional valence in [-1.0, +1.0]. */
  valence: number;
  /** Salience weight in [0.1, 1.0]. */
  salience: number;
  /** Optional zone where the event occurred. */
  zone?: string;
  /** Optional witness resident ID if learned second-hand via gossip. */
  src?: string;
}

export type NpcMemoryEntry = EpisodicMemory;

export type DistrictRepId = 'market' | 'bistro' | 'cafe' | 'library' | 'park' | 'campus';

export const DISTRICT_REP_IDS: readonly DistrictRepId[] = [
  'market',
  'bistro',
  'cafe',
  'library',
  'park',
  'campus',
] as const;

export type DistrictRepTier = 'Newcomer' | 'Regular' | 'Trusted Local' | 'Riverside Pillar';

export interface DistrictRepInfo {
  district: DistrictRepId;
  score: number;
  tier: DistrictRepTier;
  discountPct: number;
}

const DISTRICT_REP_SET = new Set<string>(DISTRICT_REP_IDS);

export function resolveDistrictRepId(zoneOrDistrict: string | null | undefined): DistrictRepId {
  if (!zoneOrDistrict) return 'market';
  if (DISTRICT_REP_SET.has(zoneOrDistrict)) return zoneOrDistrict as DistrictRepId;
  switch (zoneOrDistrict) {
    case 'bistro':
      return 'bistro';
    case 'cafe':
    case 'linh':
    case 'minh':
      return 'cafe';
    case 'library':
      return 'library';
    case 'park':
    case 'botanical':
    case 'greenway':
    case 'atelier':
    case 'lantern_garden':
    case 'fair':
      return 'park';
    case 'campus':
    case 'fountain_plaza':
      return 'campus';
    default:
      return 'market';
  }
}

export function districtRepTierFromScore(score: number): { tier: DistrictRepTier; discountPct: number } {
  const s = clamp(Math.round(score), 0, 100);
  if (s >= 85) return { tier: 'Riverside Pillar', discountPct: 12 };
  if (s >= 60) return { tier: 'Trusted Local', discountPct: 8 };
  if (s >= 30) return { tier: 'Regular', discountPct: 5 };
  return { tier: 'Newcomer', discountPct: 0 };
}

export type UtilityGoalKind =
  | 'V3_HARD_LOCK'
  | 'SEEK_SHELTER'
  | 'RECOVER_ENERGY'
  | 'SATISFY_HUNGER'
  | 'SOCIALIZE_GROUP'
  | 'PURSUE_FOCUS'
  | 'SEEK_FUN'
  | 'ENJOY_WEATHER'
  | 'FOLLOW_SCHEDULE';

export interface ActiveGoal {
  kind: UtilityGoalKind;
  zone: V3ZoneId;
  activity: ExpressiveActivity;
  score: number;
  startedClock: number;
  reason: string;
  shelterSpot?: P | null;
}

export type ReactionKind =
  | 'greet'
  | 'horn_startle'
  | 'horn_wave'
  | 'cheer_basket'
  | 'watch_court'
  | 'admire_vehicle';

export interface ResidentReaction {
  kind: ReactionKind;
  untilElapsed: number;
  targetPos: P;
  quip: string | null;
}

export interface ResidentMindState {
  readonly id: ResidentId;
  needs: ResidentNeeds;
  mood: ResidentMood;
  moodLockedUntilClock: number;
  goal: ActiveGoal;
  stm: EpisodicMemory[];
  ltm: EpisodicMemory[];
  reaction: ResidentReaction | null;
  cooldowns: {
    greet: number;
    horn: number;
    basketball: number;
    vehicleComment: number;
    microAct: number;
  };
  microAct: ExpressiveActivity | null;
  umbrella: boolean;
  /** Clock minute when last discretionary off-schedule break began (rate-limits zone drifting). */
  lastBreakClock: number;
  /** Count of V3 `rel.memories` already mirrored into LTM. */
  syncedV3MemCount: number;
}

export interface EnvSnapshot {
  weatherId: 'sunny' | 'cloudy' | 'overcast' | 'golden_breeze' | 'light_rain' | 'heavy_rain' | 'snowy';
  rainIntensity: number;
  snowIntensity: number;
  season: 0 | 1 | 2 | 3;
  hour: number;
  phase: 'morning' | 'afternoon' | 'evening' | 'night';
  isWeekend: boolean;
}

export type WorldStimulus =
  | { kind: 'horn'; x: number; z: number; yaw: number; elapsed: number; vehicleName: string }
  | { kind: 'basketball_play'; x: number; z: number; elapsed: number }
  | { kind: 'basketball_score'; x: number; z: number; streak: number; elapsed: number }
  | {
      kind: 'player_vehicle';
      x: number;
      z: number;
      vx: number;
      vz: number;
      speed: number;
      vehicleKind: 'car' | 'motorbike' | 'bike';
      vehicleName: string;
      elapsed: number;
    };

export interface ShelterAnchor {
  id: string;
  zone: V3ZoneId;
  x: number;
  z: number;
}

export interface MindEvalContext {
  env: EnvSnapshot;
  pos: P;
  zone: V3ZoneId;
  outdoor: boolean;
  talkingId: string | null;
  v3SceneLocked: boolean;
  hasCompatibleFriendInZone: boolean;
  hasFreeSeatInZone: boolean;
}

export type CompactLtmTuple =
  | [number, number, number, string, number, number]
  | [number, number, number, string, number, number, string]
  | [number, number, number, string, number, number, string, string];

export interface NpcSimSnapshot {
  v: 1;
  minds: Record<
    string,
    {
      n: [number, number, number, number, number, number];
      m: number;
      ltm: CompactLtmTuple[];
    }
  >;
  aff: [number, number, number][];
  rep?: Partial<Record<DistrictRepId, number>>;
}

/** Authentic Big-5 profiles for all 22 named V3 residents (grounded in v3/npc-ai/character-catalog.mjs). */
export const RESIDENT_PROFILES: Readonly<Record<ResidentId, ResidentProfile>> = {
  linh: {
    id: 'linh',
    traits: { openness: 0.88, conscientiousness: 0.84, extraversion: 0.72, agreeableness: 0.92, calmness: 0.58 },
    rainTolerance: 0.55,
    thirdPlaces: ['bistro', 'atelier', 'fountain_plaza'],
    idleMicroActs: ['read', 'coffee', 'chat'],
    peakHour: 14,
    umbrellaColor: 1,
  },
  minh: {
    id: 'minh',
    traits: { openness: 0.68, conscientiousness: 0.70, extraversion: 0.90, agreeableness: 0.85, calmness: 0.74 },
    rainTolerance: 0.45,
    thirdPlaces: ['park', 'greenway', 'fair'],
    idleMicroActs: ['stretch', 'exercise_squat', 'chat'],
    peakHour: 10,
    umbrellaColor: 0,
  },
  huy: {
    id: 'huy',
    traits: { openness: 0.82, conscientiousness: 0.74, extraversion: 0.38, agreeableness: 0.66, calmness: 0.78 },
    rainTolerance: 0.35,
    thirdPlaces: ['cafe', 'electronics_shop', 'bistro'],
    idleMicroActs: ['coffee', 'study', 'read'],
    peakHour: 21,
    umbrellaColor: 3,
  },
  mai: {
    id: 'mai',
    traits: { openness: 0.54, conscientiousness: 0.92, extraversion: 0.76, agreeableness: 0.90, calmness: 0.84 },
    rainTolerance: 0.25,
    thirdPlaces: ['market', 'bistro', 'botanical'],
    idleMicroActs: ['chat', 'coffee', 'wipe'],
    peakHour: 9,
    umbrellaColor: 4,
  },
  lan: {
    id: 'lan',
    traits: { openness: 0.80, conscientiousness: 0.90, extraversion: 0.62, agreeableness: 0.86, calmness: 0.94 },
    rainTolerance: 0.40,
    thirdPlaces: ['library', 'lantern_garden', 'bistro'],
    idleMicroActs: ['read', 'coffee', 'present'],
    peakHour: 11,
    umbrellaColor: 2,
  },
  anchi: {
    id: 'anchi',
    traits: { openness: 0.86, conscientiousness: 0.88, extraversion: 0.32, agreeableness: 0.82, calmness: 0.86 },
    rainTolerance: 0.60,
    thirdPlaces: ['library', 'bistro', 'lantern_garden'],
    idleMicroActs: ['read', 'study', 'coffee'],
    peakHour: 15,
    umbrellaColor: 3,
  },
  baolong: {
    id: 'baolong',
    traits: { openness: 0.84, conscientiousness: 0.82, extraversion: 0.70, agreeableness: 0.78, calmness: 0.66 },
    rainTolerance: 0.25,
    thirdPlaces: ['electronics_shop', 'cafe', 'bistro'],
    idleMicroActs: ['present', 'coffee', 'chat'],
    peakHour: 15,
    umbrellaColor: 0,
  },
  khanhha: {
    id: 'khanhha',
    traits: { openness: 0.78, conscientiousness: 0.80, extraversion: 0.86, agreeableness: 0.92, calmness: 0.72 },
    rainTolerance: 0.30,
    thirdPlaces: ['bistro', 'market', 'fair'],
    idleMicroActs: ['cook', 'coffee', 'wave'],
    peakHour: 10,
    umbrellaColor: 4,
  },
  ductri: {
    id: 'ductri',
    traits: { openness: 0.66, conscientiousness: 0.90, extraversion: 0.36, agreeableness: 0.76, calmness: 0.92 },
    rainTolerance: 0.45,
    thirdPlaces: ['repair_shop', 'greenway', 'bistro'],
    idleMicroActs: ['wipe', 'stretch', 'coffee'],
    peakHour: 11,
    umbrellaColor: 0,
  },
  diemmy: {
    id: 'diemmy',
    traits: { openness: 0.96, conscientiousness: 0.72, extraversion: 0.44, agreeableness: 0.78, calmness: 0.62 },
    rainTolerance: 0.82,
    thirdPlaces: ['atelier', 'botanical', 'fountain_plaza'],
    idleMicroActs: ['study', 'read', 'coffee'],
    peakHour: 16,
    umbrellaColor: 1,
  },
  haidang: {
    id: 'haidang',
    traits: { openness: 0.92, conscientiousness: 0.54, extraversion: 0.78, agreeableness: 0.88, calmness: 0.84 },
    rainTolerance: 0.76,
    thirdPlaces: ['fountain_plaza', 'atelier', 'bistro'],
    idleMicroActs: ['wave', 'coffee', 'chat'],
    peakHour: 19,
    umbrellaColor: 2,
  },
  kimngan: {
    id: 'kimngan',
    traits: { openness: 0.88, conscientiousness: 0.86, extraversion: 0.64, agreeableness: 0.84, calmness: 0.86 },
    rainTolerance: 0.20,
    thirdPlaces: ['furniture_shop', 'fountain_plaza', 'bistro'],
    idleMicroActs: ['present', 'coffee', 'read'],
    peakHour: 13,
    umbrellaColor: 4,
  },
  quocbao: {
    id: 'quocbao',
    traits: { openness: 0.52, conscientiousness: 0.94, extraversion: 0.68, agreeableness: 0.84, calmness: 0.90 },
    rainTolerance: 0.55,
    thirdPlaces: ['street', 'campus', 'park'],
    idleMicroActs: ['stretch', 'wave', 'coffee'],
    peakHour: 8,
    umbrellaColor: 0,
  },
  thaovy: {
    id: 'thaovy',
    traits: { openness: 0.90, conscientiousness: 0.78, extraversion: 0.22, agreeableness: 0.88, calmness: 0.48 },
    rainTolerance: 0.78,
    thirdPlaces: ['library', 'botanical', 'lantern_garden'],
    idleMicroActs: ['read', 'study', 'sit'],
    peakHour: 17,
    umbrellaColor: 3,
  },
  duykhoa: {
    id: 'duykhoa',
    traits: { openness: 0.72, conscientiousness: 0.66, extraversion: 0.84, agreeableness: 0.56, calmness: 0.60 },
    rainTolerance: 0.30,
    thirdPlaces: ['cafe', 'electronics_shop', 'park'],
    idleMicroActs: ['stretch', 'wave', 'chat'],
    peakHour: 20,
    umbrellaColor: 1,
  },
  ngocbich: {
    id: 'ngocbich',
    traits: { openness: 0.86, conscientiousness: 0.82, extraversion: 0.48, agreeableness: 0.92, calmness: 0.96 },
    rainTolerance: 0.80,
    thirdPlaces: ['botanical', 'lantern_garden', 'market'],
    idleMicroActs: ['wipe', 'coffee', 'sit'],
    peakHour: 12,
    umbrellaColor: 2,
  },
  tuankiet: {
    id: 'tuankiet',
    traits: { openness: 0.78, conscientiousness: 0.78, extraversion: 0.88, agreeableness: 0.80, calmness: 0.76 },
    rainTolerance: 0.40,
    thirdPlaces: ['vehicle_dealer', 'greenway', 'park'],
    idleMicroActs: ['stretch', 'wave', 'chat'],
    peakHour: 10,
    umbrellaColor: 0,
  },
  phuonglien: {
    id: 'phuonglien',
    traits: { openness: 0.90, conscientiousness: 0.76, extraversion: 0.84, agreeableness: 0.84, calmness: 0.70 },
    rainTolerance: 0.20,
    thirdPlaces: ['clothing_shop', 'fountain_plaza', 'bistro'],
    idleMicroActs: ['chat', 'wave', 'coffee'],
    peakHour: 14,
    umbrellaColor: 1,
  },
  quangvinh: {
    id: 'quangvinh',
    traits: { openness: 0.62, conscientiousness: 0.88, extraversion: 0.76, agreeableness: 0.86, calmness: 0.88 },
    rainTolerance: 0.30,
    thirdPlaces: ['home_center', 'street', 'park'],
    idleMicroActs: ['stretch', 'chat', 'coffee'],
    peakHour: 11,
    umbrellaColor: 4,
  },
  minhthu: {
    id: 'minhthu',
    traits: { openness: 0.94, conscientiousness: 0.74, extraversion: 0.74, agreeableness: 0.76, calmness: 0.68 },
    rainTolerance: 0.84,
    thirdPlaces: ['greenway', 'botanical', 'atelier'],
    idleMicroActs: ['stretch', 'chat', 'wave'],
    peakHour: 9,
    umbrellaColor: 2,
  },
  hoangphuc: {
    id: 'hoangphuc',
    traits: { openness: 0.58, conscientiousness: 0.94, extraversion: 0.34, agreeableness: 0.48, calmness: 0.64 },
    rainTolerance: 0.25,
    thirdPlaces: ['library', 'campus', 'bistro'],
    idleMicroActs: ['study', 'read', 'coffee'],
    peakHour: 13,
    umbrellaColor: 3,
  },
  yennhi: {
    id: 'yennhi',
    traits: { openness: 0.86, conscientiousness: 0.78, extraversion: 0.94, agreeableness: 0.92, calmness: 0.76 },
    rainTolerance: 0.35,
    thirdPlaces: ['fair', 'fountain_plaza', 'bistro'],
    idleMicroActs: ['wave', 'chat', 'stretch'],
    peakHour: 16,
    umbrellaColor: 4,
  },
};

const STM_CAP = 8;
const STM_TTL_MIN = 360;
const LTM_CAP = 16;
const GOAL_MIN_DWELL_MIN = 20;
const GOAL_HYSTERESIS_BONUS = 0.18;
const MOOD_MIN_HOLD_MIN = 12;
const BREAK_COOLDOWN_MIN = 360;

const FUN_ZONES = new Set<V3ZoneId>(['park', 'fair', 'cafe', 'fountain_plaza', 'atelier', 'botanical', 'lantern_garden', 'greenway']);
const FOCUS_ZONES = new Set<V3ZoneId>(['library', 'campus', 'atelier']);
const FOOD_ZONES: readonly V3ZoneId[] = ['bistro', 'cafe', 'market'];
const SCENIC_ZONES: readonly V3ZoneId[] = ['park', 'fountain_plaza', 'lantern_garden', 'botanical', 'greenway'];
const CORE_FESTIVAL_SIX = new Set<string>(['linh', 'minh', 'huy', 'mai', 'lan', 'thaovy']);
const DAY0_ANCHORS = new Set<string>(['linh', 'minh', 'mai', 'huy', 'lan']);
const PROP_REQUIRING_ACTS = new Set<ExpressiveActivity>(['present', 'read', 'study', 'cook', 'wipe']);
const GOSSIP_ELIGIBLE_KINDS = new Set<MemoryKind>([
  'player_gift',
  'player_shared_activity',
  'player_basketball',
  'player_horn',
  'player_vehicle_seen',
  'rain_shelter',
]);
const PLAYER_MEMORY_KINDS = new Set<MemoryKind>([
  'player_gift',
  'player_shared_activity',
  'player_basketball',
  'player_horn',
  'player_vehicle_seen',
  'player_talk',
  'player_greet',
]);

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function normalizeZone(z: string | undefined | null): V3ZoneId {
  if (!z || z === 'study') return 'hall';
  return PUBLIC_ZONE_SET.has(z) ? (z as V3ZoneId) : 'street';
}

function normalizeActivity(act: string | undefined | null): ExpressiveActivity {
  const valid: Record<string, ExpressiveActivity> = {
    idle: 'idle', walk: 'walk', run: 'run', sit: 'sit', study: 'study', read: 'read',
    coffee: 'coffee', chat: 'chat', stretch: 'stretch', umbrella: 'umbrella', wave: 'wave',
    present: 'present', cook: 'cook', wipe: 'wipe', exercise_squat: 'exercise_squat',
    celebrate: 'celebrate', talk: 'talk', sleep: 'sleep', nod: 'nod', laugh: 'laugh',
  };
  return (act && valid[act]) || 'idle';
}

/** Build a live `EnvSnapshot` from V3 state plus optional host sky overrides (`heavy_rain`, `snowy`, `season`). */
export function envSnapshotFromV3(s: V3State, override?: Partial<EnvSnapshot>): EnvSnapshot {
  const cal = getCalendar(s.clock);
  const w = getWeather(s);
  const season = (Math.floor(cal.dayIndex / 7) % 4) as 0 | 1 | 2 | 3;
  let weatherId: EnvSnapshot['weatherId'] =
    w.id === 'light_rain' ? 'light_rain'
      : w.id === 'cloudy' ? 'cloudy'
      : w.id === 'golden_breeze' ? 'golden_breeze'
      : 'sunny';
  let rainIntensity = w.rain ? 0.65 : 0;
  let snowIntensity = 0;
  if (season === 3 && w.rain) {
    weatherId = 'snowy';
    rainIntensity = 0;
    snowIntensity = 0.85;
  }
  const phase = (['morning', 'afternoon', 'evening', 'night'].includes(cal.phase)
    ? cal.phase
    : 'morning') as EnvSnapshot['phase'];
  return {
    weatherId,
    rainIntensity,
    snowIntensity,
    season,
    hour: cal.hour,
    phase,
    isWeekend: cal.isWeekend,
    ...override,
  };
}

/**
 * Layer 0 Hard V3 Lock: returns true whenever a resident MUST follow their exact V3 zone schedule
 * with ZERO discretionary deviation (guarantees 100% compatibility with all 15 main missions,
 * 6 story choices, 3 endings, 14 side arcs, tutorial Step 3, hosted guests, world events, and V3 scenes).
 */
export function hasHardV3Lock(
  s: V3State,
  id: ResidentId,
  talkingId: string | null,
  v3SceneLocked: boolean,
): boolean {
  if (talkingId === id || v3SceneLocked) return true;

  // 1. Active player hangout / hosted guest
  const guest = s.worldV3?.hostedGuest;
  if (guest && guest.npcId === id && s.clock < guest.untilClock) return true;

  // 2. First-time Tutorial Step 3 welcome (Linh in Living Room)
  const tut = s.worldV3?.tutorial;
  if (id === 'linh' && tut && !tut.completed && !tut.skipped && tut.stepIndex === 2) return true;

  // 3. Chapter 5 festival climax gathering
  if (!s.sandbox && s.done.includes('supplies') && CORE_FESTIVAL_SIX.has(id)) return true;

  // 4. Active V3 Dynamic World Events
  const events = getActiveEvents(s);
  for (let i = 0; i < events.length; i++) {
    if (events[i].participants.includes(id)) return true;
  }

  // 5. Day 0 onboarding anchor (morning & midday core 5 stay strictly on V3 schedule)
  const cal = getCalendar(s.clock);
  if (cal.dayIndex === 0 && cal.hour < 14 && DAY0_ANCHORS.has(id)) return true;

  // 6. Active main mission step expecting `talk-<id>` or active branching story choice for this NPC
  const activeQs = activeMissions(s);
  for (let i = 0; i < activeQs.length; i++) {
    const q = activeQs[i];
    const stepIdx = s.progress[q.id] ?? 0;
    const expected = q.steps[stepIdx];
    if (expected === 'talk-' + id) return true;
  }
  if (getActiveStoryChoiceForNpc(s, id) !== null) return true;

  // 7. Player-started, unfinished side quest whose current stage waits directly on this lead NPC
  const sqState = s.worldV3?.sideQuests;
  if (sqState) {
    for (let i = 0; i < SIDE_QUESTS.length; i++) {
      const q = SIDE_QUESTS[i];
      if (q.leadNpc !== id) continue;
      const st = sqState[q.id];
      if (st && st.started && !st.done) {
        const stage = q.stages[st.stage];
        if (stage && stage.event.startsWith('sq:')) return true;
      }
    }
  }

  return false;
}

export class NpcMindEngine {
  readonly minds = new Map<ResidentId, ResidentMindState>();
  private readonly districtRep: Record<DistrictRepId, number> = {
    market: 0,
    bistro: 0,
    cafe: 0,
    library: 0,
    park: 0,
    campus: 0,
  };
  private shelters: ShelterAnchor[] = [];
  private seed = 1;

  /** Deterministically initialize all 22 minds and hydrate optional persisted `s.worldV3.npcSim`. */
  init(s: V3State, shelters: ShelterAnchor[] = []): void {
    this.shelters = shelters;
    this.seed = Number.isFinite(s.seed) ? Math.floor(s.seed) : 1;
    this.minds.clear();
    for (const d of DISTRICT_REP_IDS) this.districtRep[d] = 0;

    const saved = (s.worldV3 as Record<string, unknown> | undefined)?.npcSim as Partial<NpcSimSnapshot> | undefined;
    const savedMinds = saved && saved.v === 1 && saved.minds && typeof saved.minds === 'object' ? saved.minds : null;
    if (saved && saved.v === 1 && saved.rep && typeof saved.rep === 'object') {
      const repObj = saved.rep as Record<string, unknown>;
      for (const d of DISTRICT_REP_IDS) {
        const val = Number(repObj[d]);
        if (Number.isFinite(val)) this.districtRep[d] = clamp(Math.round(val), 0, 100);
      }
    }
    const clock = Number.isFinite(s.clock) ? s.clock : 480;

    for (const id of RESIDENT_IDS) {
      if (!CHARACTER_IDS.includes(id)) continue;
      const profile = RESIDENT_PROFILES[id];
      const h = hashStr(`${id}:${this.seed}`);
      const jitter = (shift: number) => (((h >>> shift) & 15) - 7); // -7..+8 deterministic offset

      let needs: ResidentNeeds = {
        energy: clamp(78 + jitter(0), 55, 96),
        hunger: clamp(74 + jitter(4), 52, 95),
        social: clamp(64 + Math.round((1 - profile.traits.extraversion) * 16) + jitter(8), 45, 92),
        focus: clamp(68 + Math.round(profile.traits.conscientiousness * 14) + jitter(12), 45, 94),
        fun: clamp(70 + jitter(16), 50, 92),
        comfort: clamp(82 + jitter(20), 65, 95),
      };
      let mood: ResidentMood = 'relaxed';
      const ltm: EpisodicMemory[] = [];

      const entry = savedMinds?.[id];
      if (entry && Array.isArray(entry.n) && entry.n.length === 6) {
        needs = {
          energy: clamp(Number(entry.n[0]) || 75, 0, 100),
          hunger: clamp(Number(entry.n[1]) || 75, 0, 100),
          social: clamp(Number(entry.n[2]) || 68, 0, 100),
          focus: clamp(Number(entry.n[3]) || 70, 0, 100),
          fun: clamp(Number(entry.n[4]) || 70, 0, 100),
          comfort: clamp(Number(entry.n[5]) || 82, 0, 100),
        };
        if (Number.isInteger(entry.m) && entry.m >= 0 && entry.m < MOOD_LIST.length) {
          mood = MOOD_LIST[entry.m];
        }
        if (Array.isArray(entry.ltm)) {
          for (const tuple of entry.ltm.slice(-LTM_CAP)) {
            if (!Array.isArray(tuple) || tuple.length < 6) continue;
            const kind = MEMORY_KINDS[tuple[0]];
            if (!kind) continue;
            const mem: EpisodicMemory = {
              kind,
              day: Math.max(0, Math.floor(Number(tuple[1]) || 0)),
              clock: Math.max(0, Math.floor(Number(tuple[2]) || 0)),
              subject: String(tuple[3] ?? '').slice(0, 36),
              valence: clamp((Number(tuple[4]) || 0) / 10, -1, 1),
              salience: clamp((Number(tuple[5]) || 5) / 10, 0.1, 1),
            };
            if (typeof tuple[6] === 'string' && tuple[6]) mem.zone = tuple[6].slice(0, 20);
            if (typeof tuple[7] === 'string' && tuple[7]) mem.src = tuple[7].slice(0, 16);
            ltm.push(mem);
          }
        }
      }

      const plan = desiredScheduleFor(s, id);
      const goal: ActiveGoal = {
        kind: 'FOLLOW_SCHEDULE',
        zone: normalizeZone(plan.zone),
        activity: normalizeActivity(plan.activity),
        score: 0.7,
        startedClock: clock,
        reason: plan.note || 'Going about their day',
      };

      const mind: ResidentMindState = {
        id,
        needs,
        mood,
        moodLockedUntilClock: clock,
        goal,
        stm: [],
        ltm,
        reaction: null,
        cooldowns: { greet: 0, horn: 0, basketball: 0, vehicleComment: 0, microAct: 0 },
        microAct: null,
        umbrella: false,
        lastBreakClock: -BREAK_COOLDOWN_MIN,
        syncedV3MemCount: 0,
      };
      this.minds.set(id, mind);
      this.syncV3Memories(s, id);
    }
  }

  /** Export compact bounded snapshot (<= 6.5 KB) to store inside `s.worldV3.npcSim`. */
  exportSnapshot(affDeltas: [number, number, number][] = []): NpcSimSnapshot {
    const minds: NpcSimSnapshot['minds'] = {};
    for (const id of RESIDENT_IDS) {
      const m = this.minds.get(id);
      if (!m) continue;
      const n = m.needs;
      minds[id] = {
        n: [
          Math.round(clamp(n.energy, 0, 100)),
          Math.round(clamp(n.hunger, 0, 100)),
          Math.round(clamp(n.social, 0, 100)),
          Math.round(clamp(n.focus, 0, 100)),
          Math.round(clamp(n.fun, 0, 100)),
          Math.round(clamp(n.comfort, 0, 100)),
        ],
        m: Math.max(0, MOOD_LIST.indexOf(m.mood)),
        ltm: m.ltm.slice(-LTM_CAP).map((e): CompactLtmTuple => {
          const base: [number, number, number, string, number, number] = [
            Math.max(0, MEMORY_KINDS.indexOf(e.kind)),
            e.day,
            e.clock,
            e.subject.slice(0, 32),
            Math.round(clamp(e.valence, -1, 1) * 10),
            Math.round(clamp(e.salience, 0.1, 1) * 10),
          ];
          if (e.src) return [...base, (e.zone ?? '').slice(0, 18), e.src.slice(0, 14)];
          if (e.zone) return [...base, e.zone.slice(0, 18)];
          return base;
        }),
      };
    }

    const rep: Partial<Record<DistrictRepId, number>> = {};
    let hasRep = false;
    for (const d of DISTRICT_REP_IDS) {
      const v = Math.round(clamp(this.districtRep[d], 0, 100));
      if (v > 0) {
        rep[d] = v;
        hasRep = true;
      }
    }

    const snap: NpcSimSnapshot = hasRep
      ? { v: 1, minds, aff: affDeltas.slice(0, 96), rep }
      : { v: 1, minds, aff: affDeltas.slice(0, 96) };

    // Strict <= 6500 byte save-budget safety net when many residents accumulate LTM over long play
    if (JSON.stringify(snap).length > 6400) {
      for (let cap = LTM_CAP - 1; cap >= 2 && JSON.stringify(snap).length > 6400; cap--) {
        for (const id of RESIDENT_IDS) {
          const entry = snap.minds[id];
          if (entry && entry.ltm.length > cap) entry.ltm = entry.ltm.slice(-cap);
        }
      }
    }

    return snap;
  }

  /** Adjust neighborhood reputation for a zone or district ID (0..100 clamped). */
  adjustDistrictReputation(zoneOrDistrict: string, delta: number): DistrictRepInfo {
    const district = resolveDistrictRepId(zoneOrDistrict);
    const next = clamp(Math.round(this.districtRep[district] + delta), 0, 100);
    this.districtRep[district] = next;
    const { tier, discountPct } = districtRepTierFromScore(next);
    return { district, score: next, tier, discountPct };
  }

  /** Query current district reputation score, tier, and regular discount percentage. */
  getDistrictReputation(zoneOrDistrict: string): DistrictRepInfo {
    const district = resolveDistrictRepId(zoneOrDistrict);
    const score = clamp(Math.round(this.districtRep[district]), 0, 100);
    const { tier, discountPct } = districtRepTierFromScore(score);
    return { district, score, tier, discountPct };
  }

  /** Snapshot of all 6 district reputation scores (`market`, `bistro`, `cafe`, `library`, `park`, `campus`). */
  getAllDistrictReputation(): Record<DistrictRepId, number> {
    return {
      market: this.districtRep.market,
      bistro: this.districtRep.bistro,
      cafe: this.districtRep.cafe,
      library: this.districtRep.library,
      park: this.districtRep.park,
      campus: this.districtRep.campus,
    };
  }

  /**
   * Deterministic NPC-to-NPC gossip propagation (called on Beat 2 completion between friends).
   * Copies Witness A's highest-salience recent first-hand memory into Friend B as attenuated gossip (`src: fromId`).
   */
  propagateGossip(
    fromId: ResidentId,
    toId: ResidentId,
    affinity: number,
    currentDay: number,
    currentClock: number,
  ): EpisodicMemory | null {
    if (fromId === toId || affinity < 10) return null;
    const fromMind = this.minds.get(fromId);
    const toMind = this.minds.get(toId);
    if (!fromMind || !toMind) return null;

    let best: EpisodicMemory | null = null;
    let bestScore = -1;
    const consider = (list: readonly EpisodicMemory[]) => {
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (m.src) continue; // only propagate first-hand witness memories (prevents infinite echo loops)
        if (!GOSSIP_ELIGIBLE_KINDS.has(m.kind)) continue;
        if (currentDay - m.day > 3) continue;
        if (m.salience < 0.55) continue;
        const alreadyKnown =
          toMind.ltm.some(e => e.kind === m.kind && e.day === m.day && e.subject === m.subject) ||
          toMind.stm.some(e => e.kind === m.kind && e.day === m.day && e.subject === m.subject);
        if (alreadyKnown) continue;
        const sc = m.salience * 2 - Math.max(0, currentDay - m.day) * 0.2;
        if (sc > bestScore) {
          bestScore = sc;
          best = m;
        }
      }
    };
    consider(fromMind.ltm);
    consider(fromMind.stm);
    if (!best) return null;

    const picked: EpisodicMemory = best;
    const gossipSalience = clamp(picked.salience - 0.15, 0.25, 0.85);
    const gossipMem: EpisodicMemory = {
      kind: picked.kind,
      day: picked.day,
      clock: Math.floor(currentClock),
      subject: picked.subject,
      valence: clamp(picked.valence * 0.85, -1, 1),
      salience: gossipSalience,
      zone: picked.zone,
      src: fromId,
    };
    this.recordMemory(toId, gossipMem, gossipSalience >= 0.55);
    return gossipMem;
  }

  /** Format the resident's most notable recent player memory (or second-hand gossip) as an English recollection. */
  latestPlayerMemory(id: ResidentId, currentDay?: number): string | null {
    const mind = this.minds.get(id);
    const profile = RESIDENT_PROFILES[id];
    if (!mind || !profile) return null;

    let best: EpisodicMemory | null = null;
    let bestScore = -Infinity;
    let latestDay = currentDay ?? 0;

    const scan = (list: readonly EpisodicMemory[]) => {
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (m.day > latestDay) latestDay = m.day;
        if (!PLAYER_MEMORY_KINDS.has(m.kind)) continue;
        const dayRef = currentDay ?? Math.max(latestDay, m.day);
        const age = Math.max(0, dayRef - m.day);
        const kindWeight = m.kind === 'player_greet' ? 0.35 : m.kind === 'player_talk' ? 0.65 : 1.0;
        const sc = (m.salience * kindWeight) / (1 + age * 0.35) + m.clock * 1e-6;
        if (sc > bestScore) {
          bestScore = sc;
          best = m;
        }
      }
    };
    scan(mind.ltm);
    scan(mind.stm);
    if (!best) return null;

    const picked: EpisodicMemory = best;
    const tone = resolveBanterTone(profile.traits);
    const witnessName = picked.src ? CHARACTERS[picked.src]?.name ?? picked.src : undefined;
    return formatMemoryRecollection(picked, currentDay ?? latestDay, tone, witnessName);
  }

  /** Return the resident's current mood state (or null if unknown). */
  getResidentMood(id: ResidentId): ResidentMood | null {
    return this.minds.get(id)?.mood ?? null;
  }

  /**
   * Weather-responsive resident locomotion speed (m/s):
   * - 1.75-1.95 m/s rain shelter jog without umbrella
   * - 1.38 m/s brisk walk with umbrella in rain
   * - 1.35 m/s brisk winter walk in snow
   * - 1.28 m/s clear / indoor relaxed walk
   */
  shelterWalkSpeed(id: ResidentId, env: EnvSnapshot, outdoor: boolean, holdingUmbrella: boolean): number {
    if (!outdoor) return 1.28;
    if (env.rainIntensity > 0.1) {
      if (holdingUmbrella) return 1.38;
      const mind = this.minds.get(id);
      const seeking = mind?.goal.kind === 'SEEK_SHELTER';
      if (env.rainIntensity >= 0.6 || seeking) return 1.95;
      const t = clamp((env.rainIntensity - 0.1) / 0.5, 0, 1);
      return +(1.75 + t * 0.2).toFixed(2);
    }
    if (env.snowIntensity > 0.4) return 1.35;
    return 1.28;
  }

  /** Record an episodic memory into STM (with dedupe & TTL eviction) and optionally promote into LTM. */
  recordMemory(id: ResidentId, mem: EpisodicMemory, promoteToLtm = false): void {
    const mind = this.minds.get(id);
    if (!mind) return;
    const cleanSubject = mem.subject.slice(0, 36);
    const entry: EpisodicMemory = {
      kind: mem.kind,
      day: mem.day,
      clock: Math.floor(mem.clock),
      subject: cleanSubject,
      valence: clamp(mem.valence, -1, 1),
      salience: clamp(mem.salience, 0.1, 1),
    };
    if (mem.zone) entry.zone = mem.zone.slice(0, 20);
    if (mem.src) entry.src = mem.src.slice(0, 16);

    // Prune expired STM entries first
    for (let i = mind.stm.length - 1; i >= 0; i--) {
      if (entry.clock - mind.stm[i].clock > STM_TTL_MIN) mind.stm.splice(i, 1);
    }
    const existing = mind.stm.find(e => e.kind === entry.kind && e.subject === entry.subject && entry.clock - e.clock <= 30);
    if (existing) {
      existing.clock = entry.clock;
      existing.day = entry.day;
      existing.salience = Math.min(1, Math.max(existing.salience, entry.salience) + 0.08);
      existing.valence = clamp((existing.valence + entry.valence) * 0.5, -1, 1);
      if (entry.zone) existing.zone = entry.zone;
      if (entry.src && !existing.src) existing.src = entry.src;
    } else {
      mind.stm.push(entry);
      if (mind.stm.length > STM_CAP) mind.stm.shift();
    }

    if (promoteToLtm || entry.salience >= 0.75) {
      const dupLtm = mind.ltm.find(e => e.kind === entry.kind && e.subject === entry.subject && entry.day === e.day);
      if (dupLtm) {
        dupLtm.clock = entry.clock;
        dupLtm.salience = Math.max(dupLtm.salience, entry.salience);
        if (entry.zone) dupLtm.zone = entry.zone;
      } else {
        mind.ltm.push({ ...entry });
        if (mind.ltm.length > LTM_CAP) {
          // Evict lowest salience * recency entry
          let dropIdx = 0;
          let worst = Infinity;
          for (let i = 0; i < mind.ltm.length; i++) {
            const ageDays = Math.max(0, entry.day - mind.ltm[i].day);
            const score = mind.ltm[i].salience / (1 + ageDays * 0.25);
            if (score < worst) {
              worst = score;
              dropIdx = i;
            }
          }
          mind.ltm.splice(dropIdx, 1);
        }
      }
    }
  }

  /** Mirror newly appended V3 `rel.memories` (gifts, shared activities, story choices) into LTM cleanly. */
  syncV3Memories(s: V3State, id: ResidentId): void {
    const mind = this.minds.get(id);
    const v3Mems = s.npcs?.[id]?.rel?.memories;
    if (!mind || !Array.isArray(v3Mems) || v3Mems.length <= mind.syncedV3MemCount) return;

    for (let i = mind.syncedV3MemCount; i < v3Mems.length; i++) {
      const m = v3Mems[i];
      if (!m || typeof m.type !== 'string') continue;
      let kind: MemoryKind = 'player_talk';
      let valence = 0.5;
      let salience = 0.78;
      if (m.type === 'loved_gift' || m.type === 'nice_gift') {
        kind = 'player_gift';
        valence = m.type === 'loved_gift' ? 0.95 : 0.6;
        salience = m.type === 'loved_gift' ? 0.95 : 0.75;
      } else if (m.type.startsWith('shared_') || m.type === 'completed_side_arc' || m.type === 'resolved_conflict') {
        kind = 'player_shared_activity';
        valence = 0.85;
        salience = 0.9;
      } else if (m.type === 'missed_invite') {
        kind = 'player_shared_activity';
        valence = -0.35;
        salience = 0.65;
      }
      this.recordMemory(
        id,
        {
          kind,
          day: Number.isFinite(m.day) ? Number(m.day) : s.day,
          clock: Number.isFinite(m.clock) ? Number(m.clock) : Math.floor(s.clock),
          subject: String(m.detail || m.type).slice(0, 36),
          valence,
          salience,
          zone: s.npcs?.[id]?.zone || undefined,
        },
        true,
      );
    }
    mind.syncedV3MemCount = v3Mems.length;
  }

  /** Decide whether this resident carries an umbrella outdoors right now. */
  shouldHoldUmbrella(id: ResidentId, env: EnvSnapshot, outdoor: boolean, seated: boolean): boolean {
    if (!outdoor || seated) return false;
    const profile = RESIDENT_PROFILES[id];
    if (env.rainIntensity > 0.1) {
      // Conscientious residents and high rain-tolerance strollers carry umbrellas;
      // spontaneous low-C types tuck shoulders and jog briskly for cover.
      return profile.traits.conscientiousness >= 0.72 || profile.rainTolerance >= 0.75;
    }
    if (env.snowIntensity > 0.4 && profile.traits.calmness < 0.85) return true;
    return false;
  }

  /** Advance all 6 physiological & psychological needs and resolve mood with hysteresis. */
  advanceNeedsAndMood(
    id: ResidentId,
    dm: number,
    ctx: {
      env: EnvSnapshot;
      zone: V3ZoneId;
      activity: string;
      outdoor: boolean;
      seated: boolean;
      inSocialGroup: boolean;
      inWorldEvent: boolean;
      clock: number;
    },
  ): void {
    const mind = this.minds.get(id);
    if (!mind || dm <= 0) return;
    const profile = RESIDENT_PROFILES[id];
    const def = CHARACTERS[id];
    const t = profile.traits;
    const n = mind.needs;
    const dh = dm / 60; // game hours elapsed

    mind.umbrella = this.shouldHoldUmbrella(id, ctx.env, ctx.outdoor, ctx.seated);

    // 1. Energy (circadian-modulated)
    const circadian = 1 - 0.25 * Math.cos(((ctx.env.hour - profile.peakHour) * Math.PI) / 12);
    const isHome = def && ctx.zone === def.homeZone;
    let energyRate = -5.2 * circadian;
    if (ctx.activity === 'sleep' || (isHome && (ctx.env.hour >= 22 || ctx.env.hour < 7))) {
      energyRate = 14.0;
    } else if (ctx.activity === 'run' || ctx.activity === 'exercise_squat') {
      energyRate = -7.5 * circadian;
    } else if (ctx.seated || ctx.activity === 'sit' || ctx.activity === 'coffee') {
      energyRate = 2.4;
    }
    n.energy = clamp(n.energy + energyRate * dh, 0, 100);

    // 2. Hunger
    const mealHour =
      (ctx.env.hour >= 7 && ctx.env.hour < 9) ||
      (ctx.env.hour >= 12 && ctx.env.hour < 14) ||
      (ctx.env.hour >= 18 && ctx.env.hour < 20);
    let hungerRate = ctx.activity === 'run' || ctx.activity === 'exercise_squat' ? -9.0 : -6.8;
    if (ctx.zone === 'bistro' || ctx.zone === 'cafe' || ctx.zone === 'market' || ctx.activity === 'cook' || ctx.activity === 'coffee') {
      hungerRate = 32.0;
    } else if (isHome && mealHour) {
      hungerRate = 20.0;
    }
    n.hunger = clamp(n.hunger + hungerRate * dh, 0, 100);

    // 3. Social
    let socialRate = -(2.5 + 5.5 * t.extraversion);
    if (ctx.inSocialGroup || ctx.activity === 'chat' || ctx.activity === 'talk' || ctx.inWorldEvent) {
      socialRate = 28.0;
    }
    n.social = clamp(n.social + socialRate * dh, 0, 100);

    // 4. Focus
    const isWork = def && ctx.zone === def.workZone;
    let focusRate = -(2.2 + 3.0 * t.conscientiousness);
    if (
      ctx.activity === 'study' ||
      ctx.activity === 'read' ||
      ctx.activity === 'present' ||
      ctx.activity === 'wipe' ||
      FOCUS_ZONES.has(ctx.zone) ||
      isWork
    ) {
      focusRate = 24.0;
    }
    n.focus = clamp(n.focus + focusRate * dh, 0, 100);

    // 5. Fun
    let funRate = -(2.8 + 3.6 * t.openness);
    if (FUN_ZONES.has(ctx.zone) || ctx.inSocialGroup || ctx.inWorldEvent || ctx.activity === 'celebrate' || ctx.activity === 'laugh') {
      funRate = 26.0;
    }
    n.fun = clamp(n.fun + funRate * dh, 0, 100);

    // 6. Comfort (smooth exponential approach toward environmental equilibrium)
    let targetComfort = 88;
    if (ctx.outdoor) {
      if (ctx.env.rainIntensity >= 0.85) {
        targetComfort = 14 + 28 * profile.rainTolerance + (mind.umbrella ? 14 : 0);
      } else if (ctx.env.rainIntensity > 0.1) {
        targetComfort = 38 + 42 * profile.rainTolerance + (mind.umbrella ? 18 : 0);
      } else if (ctx.env.snowIntensity > 0.4) {
        targetComfort = 26 + 26 * profile.rainTolerance + (mind.umbrella ? 8 : 0);
      } else if (
        (ctx.env.weatherId === 'sunny' || ctx.env.weatherId === 'golden_breeze') &&
        ctx.env.season !== 3 &&
        ctx.env.hour >= 13 &&
        ctx.env.hour < 18
      ) {
        targetComfort = 90;
      } else {
        targetComfort = 82;
      }
    }
    const alpha = 1 - Math.exp(-0.045 * dm);
    n.comfort = clamp(n.comfort + (targetComfort - n.comfort) * alpha, 0, 100);

    // Resolve Mood (with immediate emergency override or 12-game-min hysteresis)
    const urgentMood: ResidentMood | null =
      (ctx.env.rainIntensity > 0.35 || ctx.env.snowIntensity > 0.4) &&
      (n.comfort < 48 || mind.goal.kind === 'SEEK_SHELTER')
        ? 'sheltering'
        : ctx.inWorldEvent || mind.reaction?.kind === 'cheer_basket'
          ? 'excited'
          : null;

    if (urgentMood) {
      mind.mood = urgentMood;
      mind.moodLockedUntilClock = ctx.clock + MOOD_MIN_HOLD_MIN;
      return;
    }
    if (ctx.clock < mind.moodLockedUntilClock) return;

    let nextMood: ResidentMood = 'relaxed';
    if (n.energy < 30) {
      nextMood = 'tired';
    } else if (n.fun > 78 && n.social > 72 && t.extraversion >= 0.65) {
      nextMood = 'excited';
    } else if (
      (ctx.activity === 'study' || ctx.activity === 'read' || ctx.activity === 'present' || ctx.activity === 'cook' || ctx.activity === 'wipe') &&
      n.focus >= 45 &&
      n.energy >= 35
    ) {
      nextMood = 'focused';
    } else if (
      mind.reaction?.kind === 'admire_vehicle' ||
      (t.openness >= 0.80 && ctx.outdoor && n.comfort >= 60 && n.fun < 65)
    ) {
      nextMood = 'curious';
    } else if ((n.social + n.fun + n.comfort) / 3 >= 68 && n.energy >= 45) {
      nextMood = 'cheerful';
    }

    if (nextMood !== mind.mood) {
      mind.mood = nextMood;
      mind.moodLockedUntilClock = ctx.clock + MOOD_MIN_HOLD_MIN;
    }
  }

  /** Find nearest covered outdoor shelter anchor (bus shelter, gazebo, colonnade) within `maxDist` m. */
  private nearestShelter(pos: P, maxDist: number): ShelterAnchor | null {
    let best: ShelterAnchor | null = null;
    let bestD = maxDist;
    for (let i = 0; i < this.shelters.length; i++) {
      const sh = this.shelters[i];
      const d = Math.hypot(sh.x - pos.x, sh.z - pos.z);
      if (d < bestD) {
        bestD = d;
        best = sh;
      }
    }
    return best;
  }

  /** Pick an open commercial/public zone from candidates, falling back to `fallback`. */
  private pickOpenZone(s: V3State, candidates: readonly V3ZoneId[], fallback: V3ZoneId, seedOffset: number): V3ZoneId {
    const start = Math.abs(seedOffset) % candidates.length;
    for (let i = 0; i < candidates.length; i++) {
      const z = candidates[(start + i) % candidates.length];
      if (!PUBLIC_ZONE_SET.has(z)) continue;
      const v3z = v3Zones[z];
      if (!v3z || isZoneOpen(v3z, s.clock).open) return z;
    }
    return fallback;
  }

  /**
   * 4-Layer Utility AI + Behavior Tree Hybrid Goal Evaluator.
   * Respects Layer 0 Hard V3 Lock unconditionally, evaluates Layer 2 weather urgency,
   * and scores Layer 3 needs with hysteresis + minimum dwell to avoid thrashing.
   */
  evaluateGoal(s: V3State, id: ResidentId, ctx: MindEvalContext): ActiveGoal {
    const mind = this.minds.get(id);
    const profile = RESIDENT_PROFILES[id];
    const def = CHARACTERS[id];
    const plan = desiredScheduleFor(s, id);
    const schedZone = normalizeZone(plan.zone);
    const schedAct = normalizeActivity(plan.activity);

    if (!mind || !def) {
      return {
        kind: 'FOLLOW_SCHEDULE',
        zone: schedZone,
        activity: schedAct,
        score: 1,
        startedClock: s.clock,
        reason: plan.note || 'Going about their day',
      };
    }

    // ── LAYER 0: HARD V3 NARRATIVE & INTERACTION LOCK ───────────────────────────────────────────────
    if (hasHardV3Lock(s, id, ctx.talkingId, ctx.v3SceneLocked)) {
      const locked: ActiveGoal = {
        kind: 'V3_HARD_LOCK',
        zone: schedZone,
        activity: schedAct,
        score: 2.0,
        startedClock: mind.goal.kind === 'V3_HARD_LOCK' && mind.goal.zone === schedZone ? mind.goal.startedClock : s.clock,
        reason: plan.note || 'Following V3 schedule',
      };
      mind.goal = locked;
      return locked;
    }

    const t = profile.traits;
    const n = mind.needs;
    const env = ctx.env;
    const clock = s.clock;
    const isWorkSlot = schedZone === def.workZone;
    const schedOutdoors = Boolean(v3Zones[schedZone]?.outdoors);
    const rainFallback = normalizeZone(def.rainFallback || 'bistro');
    const homeZone = normalizeZone(def.homeZone || 'street');
    const canTakeBreak = clock - mind.lastBreakClock >= BREAK_COOLDOWN_MIN || mind.goal.zone !== schedZone;

    // Candidate goals array (small stack-local list, zero long-lived allocs)
    const candidates: ActiveGoal[] = [];

    // 1. FOLLOW_SCHEDULE (V3 anchor — scaled by conscientiousness + work duty)
    const schedScore = 0.54 + 0.22 * t.conscientiousness + (isWorkSlot ? 0.10 : 0);
    candidates.push({
      kind: 'FOLLOW_SCHEDULE',
      zone: schedZone,
      activity: schedAct,
      score: schedScore,
      startedClock: clock,
      reason: plan.note || 'Following daily routine',
    });

    // ── LAYER 2: WEATHER & SEASON URGENCY ──────────────────────────────────────────────────────────
    const badWeather = env.rainIntensity > 0.1 || env.snowIntensity > 0.4;
    if (badWeather && (ctx.outdoor || schedOutdoors)) {
      // Rain-lovers tolerate light rain longer under umbrellas; heavy rain drives everyone indoors
      const rainDrive =
        env.rainIntensity >= 0.85
          ? 1.48 - 0.30 * profile.rainTolerance
          : env.rainIntensity * (1.52 - 1.05 * profile.rainTolerance) + env.snowIntensity * (1.02 - 0.45 * profile.rainTolerance);
      const shelterScore = rainDrive + (1 - n.comfort / 100) * 0.45;

      if (shelterScore > 0.58) {
        // Passing light shower: check for nearby outdoor awning/gazebo/colonnade first
        const localShelter =
          env.rainIntensity > 0.1 && env.rainIntensity < 0.85 && ctx.outdoor
            ? this.nearestShelter(ctx.pos, 22)
            : null;
        if (localShelter) {
          candidates.push({
            kind: 'SEEK_SHELTER',
            zone: localShelter.zone,
            activity: 'idle',
            score: shelterScore,
            startedClock: clock,
            reason: 'Waiting out the rain beneath a covered shelter',
            shelterSpot: { x: localShelter.x, z: localShelter.z },
          });
        } else {
          const indoorZone = isZoneOpen(v3Zones[rainFallback], clock).open ? rainFallback : homeZone;
          candidates.push({
            kind: 'SEEK_SHELTER',
            zone: indoorZone,
            activity: indoorZone === 'bistro' || indoorZone === 'cafe' ? 'coffee' : 'sit',
            score: shelterScore,
            startedClock: clock,
            reason:
              env.snowIntensity > 0.4
                ? `Warming up out of the snow at ${zoneDisplayName(indoorZone)}`
                : `Taking shelter from rain at ${zoneDisplayName(indoorZone)}`,
          });
        }
      }
    }

    // ── LAYER 3: NEEDS SATISFACTION & DISCRETIONARY DRIFT ──────────────────────────────────────────
    // Hunger urgency
    if (n.hunger < 45 && (canTakeBreak || FOOD_ZONES.includes(ctx.zone))) {
      const u = 0.50 + Math.pow((45 - n.hunger) / 45, 1.25) * 0.95;
      const foodZone = FOOD_ZONES.includes(ctx.zone)
        ? ctx.zone
        : this.pickOpenZone(s, FOOD_ZONES, homeZone, hashStr(id) + s.day);
      candidates.push({
        kind: 'SATISFY_HUNGER',
        zone: foodZone,
        activity: foodZone === 'market' ? 'idle' : 'coffee',
        score: u,
        startedClock: clock,
        reason: `Grabbing a snack at ${zoneDisplayName(foodZone)}`,
      });
    }

    // Energy recovery urgency
    if (n.energy < 36) {
      const u = 0.48 + Math.pow((36 - n.energy) / 36, 1.25) * 0.96 + (env.phase === 'night' ? 0.18 : 0);
      const restLocal = n.energy > 18 && ctx.hasFreeSeatInZone && !badWeather;
      const restZone = restLocal ? ctx.zone : homeZone;
      candidates.push({
        kind: 'RECOVER_ENERGY',
        zone: restZone,
        activity: restLocal ? 'sit' : env.phase === 'night' ? 'sleep' : 'sit',
        score: u,
        startedClock: clock,
        reason: restLocal ? 'Taking a breather on a nearby seat' : 'Heading home to recharge',
      });
    }

    // Social urgency
    if (n.social < 52 && t.extraversion > 0.30 && (canTakeBreak || ctx.hasCompatibleFriendInZone)) {
      const base = 0.42 + ((52 - n.social) / 52) * (0.45 + 0.45 * t.extraversion);
      const u = base * (ctx.hasCompatibleFriendInZone ? 1.15 : 0.78);
      const socialZone = ctx.hasCompatibleFriendInZone
        ? ctx.zone
        : this.pickOpenZone(s, ['bistro', 'fountain_plaza', 'park', 'cafe'], schedZone, hashStr(id) + Math.floor(clock / 180));
      candidates.push({
        kind: 'SOCIALIZE_GROUP',
        zone: socialZone,
        activity: 'chat',
        score: u,
        startedClock: clock,
        reason: ctx.hasCompatibleFriendInZone ? 'Catching up with friends nearby' : 'Looking for friends around town',
      });
    }

    // Focus urgency
    if (n.focus < 44 && n.energy > 35 && t.conscientiousness > 0.55 && canTakeBreak) {
      const u = 0.38 + ((44 - n.focus) / 44) * (0.40 + 0.44 * t.conscientiousness);
      const focusZone = FOCUS_ZONES.has(ctx.zone)
        ? ctx.zone
        : this.pickOpenZone(s, ['library', 'atelier', 'campus'], schedZone, hashStr(id));
      candidates.push({
        kind: 'PURSUE_FOCUS',
        zone: focusZone,
        activity: focusZone === 'library' ? 'read' : focusZone === 'campus' ? 'sit' : 'study',
        score: u,
        startedClock: clock,
        reason: `Focusing quietly at ${zoneDisplayName(focusZone)}`,
      });
    }

    // Fun urgency
    if (n.fun < 44 && n.energy > 40 && n.hunger > 35 && canTakeBreak) {
      const u = 0.36 + ((44 - n.fun) / 44) * (0.40 + 0.38 * t.openness + 0.18 * t.extraversion);
      const dryThird = badWeather
        ? profile.thirdPlaces.filter(z => !v3Zones[z]?.outdoors)
        : profile.thirdPlaces;
      const funZone = dryThird.length
        ? this.pickOpenZone(s, dryThird, schedZone, hashStr(id) + s.day)
        : schedZone;
      candidates.push({
        kind: 'SEEK_FUN',
        zone: funZone,
        activity: funZone === 'park' ? 'stretch' : 'idle',
        score: u,
        startedClock: clock,
        reason: `Unwinding at ${zoneDisplayName(funZone)}`,
      });
    }

    // Sunny / Golden Breeze warm afternoon outdoor pull
    if (
      !badWeather &&
      (env.weatherId === 'sunny' || env.weatherId === 'golden_breeze') &&
      env.season !== 3 &&
      env.hour >= 13 &&
      env.hour < 18 &&
      n.comfort > 70 &&
      n.energy > 50 &&
      !isWorkSlot &&
      canTakeBreak
    ) {
      const u = 0.52 + 0.34 * t.openness + (env.isWeekend ? 0.18 : 0);
      const scenicZone = this.pickOpenZone(s, SCENIC_ZONES, 'park', hashStr(id) + s.day);
      candidates.push({
        kind: 'ENJOY_WEATHER',
        zone: scenicZone,
        activity: scenicZone === 'lantern_garden' ? 'sit' : 'idle',
        score: u,
        startedClock: clock,
        reason: `Enjoying the sunny afternoon at ${zoneDisplayName(scenicZone)}`,
      });
    }

    // Apply hysteresis to current goal
    const cur = mind.goal;
    let best = candidates[0];
    let bestAdj = -Infinity;
    let curAdj = -Infinity;
    let curCandidate: ActiveGoal | null = null;

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const sameGoal = c.kind === cur.kind && c.zone === cur.zone;
      const adj = c.score + (sameGoal ? GOAL_HYSTERESIS_BONUS : 0);
      if (sameGoal) {
        curAdj = adj;
        curCandidate = c;
      }
      if (adj > bestAdj) {
        bestAdj = adj;
        best = c;
      }
    }

    // Minimum dwell enforcement (20 game-min) unless a strong emergency beats current by > 0.35
    const dwellElapsed = clock - cur.startedClock;
    if (
      curCandidate &&
      best !== curCandidate &&
      dwellElapsed < GOAL_MIN_DWELL_MIN &&
      best.score - curCandidate.score <= 0.35 &&
      best.kind !== 'SEEK_SHELTER'
    ) {
      best = { ...curCandidate, startedClock: cur.startedClock };
    } else if (best.kind === cur.kind && best.zone === cur.zone) {
      best = { ...best, startedClock: cur.startedClock };
    } else {
      if (best.zone !== schedZone && best.kind !== 'SEEK_SHELTER') {
        mind.lastBreakClock = clock;
      }
      if (best.kind === 'SEEK_SHELTER') {
        this.recordMemory(id, {
          kind: 'rain_shelter',
          day: s.day,
          clock,
          subject: best.zone,
          valence: -0.1,
          salience: 0.45,
          zone: best.zone,
        });
      }
    }

    mind.goal = best;
    return best;
  }

  /**
   * Layer 1 Local Reflexes & Stimuli (Tier 0 residents only, in-place — never overrides route/zone).
   * Handles car horn, nearby basketball plays/scores, vehicle admiration, and friend greetings within 6 m.
   */
  evaluateStimuli(
    s: V3State,
    id: ResidentId,
    ctx: {
      pos: P;
      zone: V3ZoneId;
      seated: boolean;
      outdoor: boolean;
      player: P | null;
      playerVehicle?: { kind: 'car' | 'motorbike' | 'bike'; name: string; speed: number } | null;
      env: EnvSnapshot;
      elapsed: number;
      stimuli: readonly WorldStimulus[];
    },
  ): ResidentReaction | null {
    const mind = this.minds.get(id);
    const profile = RESIDENT_PROFILES[id];
    const def = CHARACTERS[id];
    if (!mind || !def) return null;

    if (mind.reaction && ctx.elapsed >= mind.reaction.untilElapsed) {
      mind.reaction = null;
    }

    const rel = s.npcs?.[id]?.rel;
    const friendship = rel?.friendship ?? 0;
    const isRival = Boolean(rel?.conflictState?.active && (rel?.rivalry ?? 0) >= 30);

    // 1. Check recent world stimuli (horn, basketball)
    for (let i = ctx.stimuli.length - 1; i >= 0; i--) {
      const st = ctx.stimuli[i];
      if (ctx.elapsed - st.elapsed > 3.5) continue;

      if (st.kind === 'horn' && ctx.elapsed >= mind.cooldowns.horn) {
        const d = Math.hypot(st.x - ctx.pos.x, st.z - ctx.pos.z);
        if (d <= 14 && (ctx.outdoor || d <= 6)) {
          mind.cooldowns.horn = ctx.elapsed + 14;
          const friendlyWave = !isRival && friendship >= 25 && profile.traits.calmness >= 0.70;
          const kind: ReactionKind = friendlyWave ? 'horn_wave' : 'horn_startle';
          const quip = friendlyWave
            ? `Hey! Looking sharp in the ${st.vehicleName}!`
            : profile.traits.calmness < 0.55
              ? 'Whoa! Easy on the horn there!'
              : 'Heads up — coming through!';
          mind.reaction = {
            kind,
            untilElapsed: ctx.elapsed + (friendlyWave ? 2.6 : 2.1),
            targetPos: { x: st.x, z: st.z },
            quip,
          };
          this.recordMemory(id, {
            kind: 'player_horn',
            day: s.day,
            clock: s.clock,
            subject: st.vehicleName,
            valence: friendlyWave ? 0.25 : -0.25,
            salience: 0.45,
            zone: ctx.zone,
          });
          return mind.reaction;
        }
      } else if (st.kind === 'basketball_score' && ctx.elapsed >= mind.cooldowns.basketball) {
        const d = Math.hypot(st.x - ctx.pos.x, st.z - ctx.pos.z);
        if (d <= 18 && ctx.outdoor) {
          mind.cooldowns.basketball = ctx.elapsed + 8;
          mind.needs.fun = clamp(mind.needs.fun + 6, 0, 100);
          const athletic = id === 'minh' || id === 'tuankiet' || id === 'duykhoa' || id === 'quocbao';
          const quip =
            st.streak >= 2
              ? athletic
                ? `Nothing but net! ${st.streak} in a row!`
                : `Whoa, ${st.streak} straight baskets!`
              : athletic
                ? 'Clean arc! Take another shot!'
                : 'Nice basket!';
          mind.reaction = {
            kind: 'cheer_basket',
            untilElapsed: ctx.elapsed + 2.5,
            targetPos: { x: st.x, z: st.z },
            quip,
          };
          this.recordMemory(
            id,
            {
              kind: 'player_basketball',
              day: s.day,
              clock: s.clock,
              subject: `streak_${st.streak}`,
              valence: 0.7,
              salience: st.streak >= 2 ? 0.8 : 0.5,
              zone: ctx.zone,
            },
            st.streak >= 2,
          );
          return mind.reaction;
        }
      } else if (st.kind === 'basketball_play' && !mind.reaction && ctx.elapsed >= mind.cooldowns.basketball) {
        const d = Math.hypot(st.x - ctx.pos.x, st.z - ctx.pos.z);
        if (d <= 16 && ctx.outdoor) {
          mind.reaction = {
            kind: 'watch_court',
            untilElapsed: ctx.elapsed + 2.0,
            targetPos: { x: st.x, z: st.z },
            quip: null,
          };
          return mind.reaction;
        }
      }
    }

    // 2. Player approach recognition (< 6 m head look-at, < 4.5 m warm contextual greeting)
    if (ctx.player && !mind.reaction && ctx.elapsed >= mind.cooldowns.greet) {
      const d = Math.hypot(ctx.player.x - ctx.pos.x, ctx.player.z - ctx.pos.z);
      const quietLibrary = ctx.zone === 'library' && friendship < 35;
      if (d <= 4.5 && !quietLibrary) {
        const greetChance = friendship >= 15 || profile.traits.extraversion >= 0.65 || d <= 2.4;
        if (greetChance) {
          mind.cooldowns.greet = ctx.elapsed + 55;
          mind.needs.social = clamp(mind.needs.social + 6, 0, 100);
          const quip = this.composeGreetingQuip(s, id, mind, ctx.zone, ctx.env, ctx.playerVehicle ?? null, friendship, isRival);
          const isVehicleAdmire = Boolean(ctx.playerVehicle && (id === 'tuankiet' || id === 'ductri' || id === 'baolong'));
          mind.reaction = {
            kind: isVehicleAdmire ? 'admire_vehicle' : 'greet',
            untilElapsed: ctx.elapsed + 3.2,
            targetPos: { x: ctx.player.x, z: ctx.player.z },
            quip,
          };
          this.recordMemory(id, {
            kind: ctx.playerVehicle ? 'player_vehicle_seen' : 'player_greet',
            day: s.day,
            clock: s.clock,
            subject: ctx.playerVehicle ? ctx.playerVehicle.name : ctx.zone,
            valence: isRival ? 0.0 : 0.4,
            salience: ctx.playerVehicle ? 0.6 : 0.35,
            zone: ctx.zone,
          });
          return mind.reaction;
        }
      }
    }

    return mind.reaction;
  }

  /**
   * Immediately clear all transient resident reactions/quips and reset greeting cooldowns.
   * Invoked on time-of-day phase changes, > 2 h clock jumps, or dry/precipitation transitions
   * so stale morning or fair-weather quips never linger into evening/night or rainstorms.
   */
  clearTransientQuips(): void {
    for (const mind of this.minds.values()) {
      if (mind.reaction) mind.reaction = null;
      mind.cooldowns.greet = 0;
    }
  }

  /** Deterministic, zero-LLM contextual greeting referencing episodic memory, gossip, reputation, vehicle, or weather. */
  private composeGreetingQuip(
    s: V3State,
    id: ResidentId,
    mind: ResidentMindState,
    zone: V3ZoneId,
    env: EnvSnapshot,
    vehicle: { kind: 'car' | 'motorbike' | 'bike'; name: string; speed: number } | null,
    friendship: number,
    isRival: boolean,
  ): string {
    const profile = RESIDENT_PROFILES[id];
    const tone = resolveBanterTone(profile.traits);

    // Pick most salient recent episodic memory (within 3 game days, salience >= 0.55)
    let recentMem: EpisodicMemory | null = null;
    let bestScore = -1;
    const scanMem = (list: readonly EpisodicMemory[]) => {
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (!PLAYER_MEMORY_KINDS.has(m.kind) || m.kind === 'player_greet') continue;
        if (s.day - m.day > 3 || m.salience < 0.55) continue;
        const sc = m.salience * 2 + m.clock * 1e-6;
        if (sc > bestScore) {
          bestScore = sc;
          recentMem = m;
        }
      }
    };
    scanMem(mind.ltm);
    scanMem(mind.stm);

    const witnessName =
      recentMem && (recentMem as EpisodicMemory).src
        ? CHARACTERS[(recentMem as EpisodicMemory).src!]?.name ?? (recentMem as EpisodicMemory).src
        : undefined;
    const rep = this.getDistrictReputation(zone);

    return composeMemoryGreeting({
      residentId: id,
      residentName: CHARACTERS[id]?.name ?? id,
      tone,
      mood: mind.mood,
      zone,
      weatherId: env.weatherId,
      rainIntensity: env.rainIntensity,
      snowIntensity: env.snowIntensity,
      rainTolerance: profile.rainTolerance,
      phase: env.phase,
      friendship,
      isRival,
      currentDay: s.day,
      seed: this.seed + Math.floor(s.clock / 15),
      memory: recentMem,
      witnessName,
      vehicle,
      districtRep: { score: rep.score, tier: rep.tier },
    });
  }

  /**
   * Rotate expressive settled micro-activities deterministically every 22-35 s (no jitter).
   * Strictly filters out prop-requiring poses (`present`, `read`, `study`, `cook`, `wipe`)
   * whenever the resident is outdoors OR standing unseated so no prop-less splayed gestures occur.
   */
  pickMicroActivity(
    id: ResidentId,
    baseActivity: string,
    seated: boolean,
    elapsed: number,
    outdoor = false,
  ): ExpressiveActivity {
    const mind = this.minds.get(id);
    const profile = RESIDENT_PROFILES[id];
    const base = normalizeActivity(baseActivity);
    const propUnsafe = outdoor || !seated;
    const safeBase: ExpressiveActivity =
      propUnsafe && PROP_REQUIRING_ACTS.has(base)
        ? (seated ? 'sit' : 'idle')
        : base;

    if (!mind || !profile) return safeBase;
    if (safeBase !== 'idle' && safeBase !== 'sit' && safeBase !== 'study') return safeBase;

    if (elapsed >= mind.cooldowns.microAct) {
      const span = 22 + (hashStr(id) % 13);
      mind.cooldowns.microAct = elapsed + span;
      const slot = Math.floor(elapsed / span + hashStr(id)) % (profile.idleMicroActs.length + 1);
      if (slot === profile.idleMicroActs.length) {
        mind.microAct = safeBase;
      } else {
        const pick = profile.idleMicroActs[slot];
        if (propUnsafe && PROP_REQUIRING_ACTS.has(pick)) {
          mind.microAct = seated ? 'sit' : 'idle';
        } else if (seated && (pick === 'stretch' || pick === 'exercise_squat' || pick === 'wipe' || pick === 'cook' || pick === 'present')) {
          mind.microAct = 'sit';
        } else if (!seated && pick === 'sit') {
          mind.microAct = 'idle';
        } else {
          mind.microAct = pick;
        }
      }
    }

    const current = mind.microAct ?? safeBase;
    if (propUnsafe && PROP_REQUIRING_ACTS.has(current)) return seated ? 'sit' : 'idle';
    if (seated && (current === 'stretch' || current === 'exercise_squat' || current === 'wipe' || current === 'cook' || current === 'present')) {
      return 'sit';
    }
    if (!seated && current === 'sit') return 'idle';
    return current;
  }
}
