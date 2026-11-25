/**
 * Echo Life Wave 11 — Player Mind, 8 Core Needs, 12-Emotion State Machine,
 * Dynamic Daily Urges, Personal and City Karma, 8 Expanded Sub-Skills,
 * and Smart Zoi Diegetic Thought Bubbles / Resident Diary.
 *
 * Pure deterministic simulation (zero network/LLM calls, zero DOM dependencies,
 * zero V3 package edits, 100% clean English copy).
 */
import type {
  ActiveGoal,
  EnvSnapshot,
  EpisodicMemory,
  ResidentId,
  ResidentMood,
  UtilityGoalKind,
} from './npcMind';

// ── 1. 8 Core Needs and Bidirectional V3 6-Vital Bridge ──────────────────────────────────────────────────

export type Need8Key =
  | 'hunger'
  | 'hygiene'
  | 'bathroom'
  | 'fun'
  | 'social'
  | 'energy'
  | 'sleep'
  | 'recognition';

export const NEED8_KEYS: readonly Need8Key[] = [
  'hunger',
  'hygiene',
  'bathroom',
  'fun',
  'social',
  'energy',
  'sleep',
  'recognition',
] as const;

export type Needs8 = Record<Need8Key, number>;

export interface V3Vitals6 {
  energy: number;
  hunger: number;
  hygiene: number;
  mood: number;
  focus: number;
  fitness: number;
}

export interface NeedsDecayContext {
  sprinting?: boolean;
  sleeping?: boolean;
  seated?: boolean;
  socializing?: boolean;
  studying?: boolean;
  working?: boolean;
  inRainOutdoors?: boolean;
  wellRested?: boolean;
}

/** Realistic base decay per in-game minute across a 24-hour life-sim cycle. */
export const NEED_DECAY_PER_GAME_MINUTE: Readonly<Record<Need8Key, number>> = {
  hunger: 0.072,
  hygiene: 0.042,
  bathroom: 0.095,
  fun: 0.052,
  social: 0.044,
  energy: 0.056,
  sleep: 0.062,
  recognition: 0.008,
};

export type PlayerActivityKind =
  | 'eat_home_meal'
  | 'eat_bistro_treat'
  | 'drink_coffee'
  | 'drink_tea'
  | 'use_bathroom'
  | 'take_shower'
  | 'soak_tub'
  | 'sleep_bed'
  | 'power_nap'
  | 'chat_resident'
  | 'host_hangout'
  | 'play_basketball'
  | 'play_music'
  | 'take_photo'
  | 'study_focus'
  | 'complete_shift'
  | 'tidy_home'
  | 'tend_garden';

export const ACTIVITY_NEED_DELTAS: Readonly<Record<PlayerActivityKind, Partial<Needs8>>> = {
  eat_home_meal: { hunger: 36, energy: 14, fun: 8, bathroom: -10 },
  eat_bistro_treat: { hunger: 30, energy: 16, fun: 14, social: 8, bathroom: -8 },
  drink_coffee: { energy: 22, sleep: 10, fun: 6, bathroom: -14 },
  drink_tea: { energy: 12, fun: 10, social: 6, bathroom: -10 },
  use_bathroom: { bathroom: 95, hygiene: 6, energy: 2 },
  take_shower: { hygiene: 85, energy: 10, fun: 6 },
  soak_tub: { hygiene: 95, energy: 18, fun: 18, sleep: 8 },
  sleep_bed: { sleep: 92, energy: 85, hygiene: -8, hunger: -14, bathroom: -16 },
  power_nap: { sleep: 34, energy: 30 },
  chat_resident: { social: 24, fun: 10, recognition: 4 },
  host_hangout: { social: 38, fun: 22, recognition: 10, energy: -8 },
  play_basketball: { fun: 26, social: 14, recognition: 8, energy: -14, hygiene: -12 },
  play_music: { fun: 28, recognition: 10, energy: -6 },
  take_photo: { fun: 18, recognition: 6, energy: -4 },
  study_focus: { recognition: 8, energy: -10, fun: -4 },
  complete_shift: { recognition: 14, social: 8, energy: -16, hunger: -10, hygiene: -8, bathroom: -12 },
  tidy_home: { hygiene: 6, recognition: 4, energy: -6 },
  tend_garden: { fun: 14, energy: -6, hygiene: -6, recognition: 5 },
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export function createInitialNeeds8(): Needs8 {
  return {
    hunger: 76,
    hygiene: 84,
    bathroom: 86,
    fun: 74,
    social: 70,
    energy: 84,
    sleep: 86,
    recognition: 48,
  };
}

export function sanitizeNeeds8(raw: unknown): Needs8 {
  const def = createInitialNeeds8();
  if (!raw || typeof raw !== 'object') return def;
  const obj = raw as Record<string, unknown>;
  const out = { ...def };
  for (const k of NEED8_KEYS) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = round1(clamp(v, 0, 100));
    }
  }
  return out;
}

/** Advances all 8 core needs smoothly over `gameMinutes` in-game minutes. */
export function advanceNeeds8(
  needs: Needs8,
  gameMinutes: number,
  ctx: NeedsDecayContext = {},
): Needs8 {
  const mins = Number.isFinite(gameMinutes) ? clamp(gameMinutes, 0, 1440) : 0;
  if (mins <= 0) return { ...needs };

  const energyMult =
    ctx.sleeping ? -1.9
    : ctx.seated ? -0.55
    : ctx.sprinting ? 2.1
    : ctx.working ? 1.45
    : ctx.wellRested ? 0.8
    : 1.0;

  const sleepMult = ctx.sleeping ? -2.2 : ctx.seated ? 0.55 : 1.0;
  const hygieneMult =
    ctx.sprinting ? 1.75
    : ctx.inRainOutdoors ? 1.35
    : ctx.sleeping ? 0.45
    : 1.0;
  const bathroomMult = ctx.sleeping ? 0.45 : 1.0;
  const hungerMult = ctx.sleeping ? 0.45 : ctx.sprinting ? 1.35 : 1.0;
  const funMult = ctx.socializing ? -0.9 : ctx.studying ? 1.2 : ctx.sleeping ? 0.25 : 1.0;
  const socialMult = ctx.socializing ? -1.4 : ctx.sleeping ? 0.2 : 1.0;
  const recDecay = needs.recognition > 35 ? NEED_DECAY_PER_GAME_MINUTE.recognition * mins : 0;

  return {
    hunger: round1(clamp(needs.hunger - NEED_DECAY_PER_GAME_MINUTE.hunger * hungerMult * mins, 0, 100)),
    hygiene: round1(clamp(needs.hygiene - NEED_DECAY_PER_GAME_MINUTE.hygiene * hygieneMult * mins, 0, 100)),
    bathroom: round1(clamp(needs.bathroom - NEED_DECAY_PER_GAME_MINUTE.bathroom * bathroomMult * mins, 0, 100)),
    fun: round1(clamp(needs.fun - NEED_DECAY_PER_GAME_MINUTE.fun * funMult * mins, 0, 100)),
    social: round1(clamp(needs.social - NEED_DECAY_PER_GAME_MINUTE.social * socialMult * mins, 0, 100)),
    energy: round1(clamp(needs.energy - NEED_DECAY_PER_GAME_MINUTE.energy * energyMult * mins, 0, 100)),
    sleep: round1(clamp(needs.sleep - NEED_DECAY_PER_GAME_MINUTE.sleep * sleepMult * mins, 0, 100)),
    recognition: round1(clamp(needs.recognition - recDecay, 0, 100)),
  };
}

export function applyNeedDeltas(needs: Needs8, deltas: Partial<Needs8>): Needs8 {
  const next = { ...needs };
  for (const k of NEED8_KEYS) {
    const d = deltas[k];
    if (typeof d === 'number' && Number.isFinite(d)) {
      next[k] = round1(clamp(next[k] + d, 0, 100));
    }
  }
  return next;
}

export function applyActivityToNeeds(needs: Needs8, activity: PlayerActivityKind): Needs8 {
  return applyNeedDeltas(needs, ACTIVITY_NEED_DELTAS[activity]);
}

/** Pulls V3's 6 vitals into Needs8 while preserving bathroom, sleep, social, and recognition. */
export function syncFromV3Vitals(needs8: Needs8, v3: Partial<V3Vitals6>): Needs8 {
  const next = { ...needs8 };
  if (typeof v3.energy === 'number' && Number.isFinite(v3.energy)) next.energy = round1(clamp(v3.energy, 0, 100));
  if (typeof v3.hunger === 'number' && Number.isFinite(v3.hunger)) next.hunger = round1(clamp(v3.hunger, 0, 100));
  if (typeof v3.hygiene === 'number' && Number.isFinite(v3.hygiene)) next.hygiene = round1(clamp(v3.hygiene, 0, 100));
  if (typeof v3.mood === 'number' && Number.isFinite(v3.mood)) {
    // Gently blend V3 mood shifts into fun without overwriting player social/recognition progress
    next.fun = round1(clamp(next.fun * 0.7 + clamp(v3.mood, 0, 100) * 0.3, 0, 100));
  }
  return next;
}

/** Projects Needs8 back onto V3's 6 vitals without ever mutating frozen V3 code. */
export function projectToV3Vitals(needs8: Needs8, currentV3?: Partial<V3Vitals6>): V3Vitals6 {
  const derivedMood = clamp(
    needs8.fun * 0.30 +
    needs8.social * 0.22 +
    needs8.recognition * 0.16 +
    needs8.hunger * 0.12 +
    needs8.hygiene * 0.10 +
    needs8.bathroom * 0.10,
    0,
    100,
  );
  const derivedFocus = clamp(
    needs8.sleep * 0.35 +
    needs8.energy * 0.30 +
    needs8.hunger * 0.15 +
    needs8.bathroom * 0.10 +
    (currentV3?.focus ?? 65) * 0.10,
    0,
    100,
  );
  return {
    energy: round1(clamp(needs8.energy, 0, 100)),
    hunger: round1(clamp(needs8.hunger, 0, 100)),
    hygiene: round1(clamp(needs8.hygiene, 0, 100)),
    mood: round1(derivedMood),
    focus: round1(derivedFocus),
    fitness: round1(clamp(currentV3?.fitness ?? 30, 0, 100)),
  };
}

// ── 2. 12-Emotion State Machine ──────────────────────────────────────────────────────────────────────────

export type EmotionId =
  | 'joyful'
  | 'inspired'
  | 'focused'
  | 'cozy'
  | 'confident'
  | 'playful'
  | 'calm'
  | 'bored'
  | 'tired'
  | 'hungry'
  | 'anxious'
  | 'embarrassed';

export const EMOTION_IDS: readonly EmotionId[] = [
  'joyful',
  'inspired',
  'focused',
  'cozy',
  'confident',
  'playful',
  'calm',
  'bored',
  'tired',
  'hungry',
  'anxious',
  'embarrassed',
] as const;

export type EmotionFaceMood =
  | 'happy'
  | 'focused'
  | 'warm'
  | 'confident'
  | 'playful'
  | 'calm'
  | 'neutral'
  | 'tired'
  | 'hungry'
  | 'worried'
  | 'shy';

export interface EmotionMeta {
  readonly id: EmotionId;
  readonly label: string;
  readonly color: string;
  readonly faceMood: EmotionFaceMood;
  readonly dialogueBonus: string;
  readonly copingHint: string;
}

export const EMOTION_CATALOG: Readonly<Record<EmotionId, EmotionMeta>> = {
  joyful: {
    id: 'joyful',
    label: 'Joyful',
    color: '#f5b841',
    faceMood: 'happy',
    dialogueBonus: '+15% Friendship gain during resident chats',
    copingHint: 'Share the good energy with friends at Willow Bistro or Riverside Park.',
  },
  inspired: {
    id: 'inspired',
    label: 'Inspired',
    color: '#8b6cf0',
    faceMood: 'warm',
    dialogueBonus: '+20% Art, Photography, and Cooking sub-skill XP',
    copingHint: 'Channel this spark into a photo shot, canvas sketch, or fresh home recipe.',
  },
  focused: {
    id: 'focused',
    label: 'Focused',
    color: '#3b82f6',
    faceMood: 'focused',
    dialogueBonus: '+20% Rhetoric and study efficiency',
    copingHint: 'Great moment for library research, coding projects, or shift precision.',
  },
  cozy: {
    id: 'cozy',
    label: 'Cozy',
    color: '#e07a5f',
    faceMood: 'warm',
    dialogueBonus: '+15% Rest recovery and tea ritual calm',
    copingHint: 'Sip warm tea indoors or unwind on your sofa while weather passes.',
  },
  confident: {
    id: 'confident',
    label: 'Confident',
    color: '#2aa876',
    faceMood: 'confident',
    dialogueBonus: '+20% Recognition gain in workplace dilemmas and seminars',
    copingHint: 'Step up for a shift promotion, acoustic busking set, or campus debate.',
  },
  playful: {
    id: 'playful',
    label: 'Playful',
    color: '#ec4899',
    faceMood: 'playful',
    dialogueBonus: '+18% Fitness and Arcade fun recovery',
    copingHint: 'Head to Riverside Park court or Boardwalk Fair for a friendly streak.',
  },
  calm: {
    id: 'calm',
    label: 'Calm',
    color: '#14b8a6',
    faceMood: 'calm',
    dialogueBonus: '20% slower need decay across steady routines',
    copingHint: 'Balanced rhythm — ideal for gardening, errands, or mindful walks.',
  },
  bored: {
    id: 'bored',
    label: 'Bored',
    color: '#94a3b8',
    faceMood: 'neutral',
    dialogueBonus: 'Seeking novelty (-10% Focus until fun rises)',
    copingHint: 'Try basketball, music jamming, photography, or visit Boardwalk Fair.',
  },
  tired: {
    id: 'tired',
    label: 'Tired',
    color: '#64748b',
    faceMood: 'tired',
    dialogueBonus: 'Slower sprint stamina until rested',
    copingHint: 'Rest on a sofa, take a power nap, or head home to bed for full recovery.',
  },
  hungry: {
    id: 'hungry',
    label: 'Hungry',
    color: '#ea580c',
    faceMood: 'hungry',
    dialogueBonus: 'Distracted by appetite (-15% shift stamina)',
    copingHint: 'Cook a quick recipe at home or stop by Willow Corner Bistro.',
  },
  anxious: {
    id: 'anxious',
    label: 'Anxious',
    color: '#d97706',
    faceMood: 'worried',
    dialogueBonus: 'Prefers calm one-on-one chats over large crowds',
    copingHint: 'Brew jasmine tea, visit the Botanical Garden, or chat with a close friend.',
  },
  embarrassed: {
    id: 'embarrassed',
    label: 'Embarrassed',
    color: '#e11d48',
    faceMood: 'shy',
    dialogueBonus: 'Social confidence dipped temporarily',
    copingHint: 'Freshen up in the bathroom or shower at home to reset with poise.',
  },
};

export interface PlayerMindEvent {
  kind:
    | 'promotion'
    | 'basketball_streak'
    | 'rivalry_tension'
    | 'awkward_slip'
    | 'creative_milestone'
    | 'deep_study'
    | 'warm_meal'
    | 'rain_shelter'
    | 'karma_good'
    | 'karma_bad';
  intensity?: number;
}

export interface EmotionEvalInput {
  needs: Needs8;
  moodlets?: readonly string[];
  traitIds?: readonly string[];
  weather?: {
    rain?: boolean;
    snow?: boolean;
    sunny?: boolean;
    indoor?: boolean;
  };
  recentEvents?: readonly PlayerMindEvent[];
  karmaScore?: number;
}

export interface EmotionState {
  readonly primary: EmotionId;
  readonly secondary: EmotionId | null;
  readonly intensity: number;
  readonly label: string;
  readonly color: string;
  readonly faceMood: EmotionFaceMood;
  readonly dialogueBonus: string;
  readonly copingHint: string;
}

export function computePlayerEmotion(input: EmotionEvalInput): EmotionState {
  const n = input.needs;
  const moodlets = new Set(input.moodlets ?? []);
  const traits = new Set(input.traitIds ?? []);
  const events = input.recentEvents ?? [];
  const w = input.weather ?? {};

  const scores: Record<EmotionId, number> = {
    joyful: 18,
    inspired: 14,
    focused: 16,
    cozy: 12,
    confident: 14,
    playful: 14,
    calm: 24,
    bored: 0,
    tired: 0,
    hungry: 0,
    anxious: 0,
    embarrassed: 0,
  };

  // Urgent physiological and discomfort drivers
  if (n.hunger < 30) scores.hungry += (30 - n.hunger) * 3.4 + 35;
  if (n.energy < 28 || n.sleep < 26) {
    const worst = Math.min(n.energy, n.sleep);
    scores.tired += (28 - worst) * 3.2 + 34;
  }
  if (n.bathroom < 22 || n.hygiene < 22) {
    const worst = Math.min(n.bathroom, n.hygiene);
    scores.embarrassed += (22 - worst) * 3.5 + 38;
  }
  if (n.fun < 34) {
    scores.bored += (34 - n.fun) * 2.5 + 24;
  }
  if (n.social < 26) {
    scores.anxious += (26 - n.social) * 2.3 + 22;
  }

  // Positive wellbeing baseline
  const avgCore = (n.hunger + n.hygiene + n.bathroom + n.fun + n.social + n.energy + n.sleep) / 7;
  if (avgCore >= 72) scores.joyful += (avgCore - 60) * 1.45;
  if (n.recognition >= 72 && n.hygiene >= 60) scores.confident += (n.recognition - 55) * 1.35 + 14;
  if (n.fun >= 78 && n.energy >= 65) scores.playful += (n.fun - 60) * 1.25 + 12;
  if (n.energy >= 65 && n.sleep >= 68 && n.hunger >= 55) scores.focused += 18;
  if (n.hunger >= 60 && n.energy >= 60 && n.fun >= 55 && n.social >= 55) scores.calm += 14;

  // Moodlet amplifiers
  if (moodlets.has('inspired_space') || moodlets.has('inspired_palate')) scores.inspired += 36;
  if (moodlets.has('rain_cozy') || moodlets.has('warm_hearth') || moodlets.has('home_comfort')) scores.cozy += 38;
  if (moodlets.has('caffeinated')) scores.focused += 32;
  if (moodlets.has('tea_calm')) scores.calm += 30;
  if (moodlets.has('hot_streak')) scores.playful += 34;
  if (moodlets.has('well_rested')) scores.joyful += 16;
  if (moodlets.has('chef_pride') || moodlets.has('gourmet_warmth')) scores.confident += 20;

  // Weather + indoor context
  if ((w.rain || w.snow) && w.indoor) {
    scores.cozy += 26;
  } else if (w.rain && !w.indoor && n.hygiene < 55) {
    scores.anxious += 14;
  } else if (w.sunny && !w.indoor && n.energy >= 60) {
    scores.playful += 10;
    scores.joyful += 8;
  }

  // Personality trait nudges (subtle, never overrides urgent needs)
  if (traits.has('dreamer') || traits.has('individualist')) scores.inspired += 10;
  if (traits.has('scholar') || traits.has('perfectionist') || traits.has('strategist')) scores.focused += 10;
  if (traits.has('charmer') || traits.has('leader')) scores.confident += 10;
  if (traits.has('entertainer') || traits.has('athlete') || traits.has('explorer')) scores.playful += 10;
  if (traits.has('artisan') || traits.has('night_owl')) scores.cozy += 8;
  if (traits.has('minimalist') || traits.has('mediator') || traits.has('sentinel')) scores.calm += 10;
  if (traits.has('volunteer') || traits.has('bon_vivant') || traits.has('collaborator')) scores.joyful += 8;

  // Recent event spikes
  for (const ev of events) {
    const wgt = clamp(ev.intensity ?? 1, 0.3, 2);
    switch (ev.kind) {
      case 'promotion':
        scores.confident += 42 * wgt;
        scores.joyful += 22 * wgt;
        break;
      case 'basketball_streak':
        scores.playful += 40 * wgt;
        scores.confident += 16 * wgt;
        break;
      case 'creative_milestone':
        scores.inspired += 44 * wgt;
        break;
      case 'deep_study':
        scores.focused += 38 * wgt;
        break;
      case 'warm_meal':
        scores.cozy += 28 * wgt;
        scores.joyful += 14 * wgt;
        break;
      case 'rain_shelter':
        scores.cozy += 32 * wgt;
        break;
      case 'rivalry_tension':
        scores.anxious += 46 * wgt;
        break;
      case 'awkward_slip':
        scores.embarrassed += 50 * wgt;
        break;
      case 'karma_good':
        scores.joyful += 16 * wgt;
        scores.calm += 10 * wgt;
        break;
      case 'karma_bad':
        scores.anxious += 22 * wgt;
        break;
    }
  }

  if (typeof input.karmaScore === 'number' && input.karmaScore <= -40) {
    scores.anxious += 12;
  } else if (typeof input.karmaScore === 'number' && input.karmaScore >= 60) {
    scores.joyful += 10;
  }

  const ranked = [...EMOTION_IDS].sort((a, b) => scores[b] - scores[a]);
  const primary = ranked[0];
  const second = ranked[1];
  const meta = EMOTION_CATALOG[primary];
  const intensity = Math.round(clamp(scores[primary], 15, 100));

  return {
    primary,
    secondary: scores[second] >= 25 ? second : null,
    intensity,
    label: meta.label,
    color: meta.color,
    faceMood: meta.faceMood,
    dialogueBonus: meta.dialogueBonus,
    copingHint: meta.copingHint,
  };
}

// ── 3. Dynamic Daily Urges (3 Active Slots) ──────────────────────────────────────────────────────────────

export type UrgeActionKind =
  | 'order_bistro'
  | 'basketball_score'
  | 'talk_resident'
  | 'cook_meal'
  | 'complete_shift'
  | 'take_photo'
  | 'study_session'
  | 'garden_tend'
  | 'bus_ride'
  | 'home_care'
  | 'music_jam'
  | 'social_post';

export interface UrgeItem {
  id: string;
  tag: string;
  actionKind: UrgeActionKind;
  targetId?: string;
  title: string;
  detail: string;
  goalCount: number;
  progress: number;
  completed: boolean;
  rewards: {
    moodDelta: number;
    recognitionDelta: number;
    karmaDelta: number;
    aspirationPoints: number;
  };
}

export interface UrgeEvent {
  kind: UrgeActionKind;
  targetId?: string;
  amount?: number;
}

interface UrgeTemplate {
  id: string;
  tag: string;
  actionKind: UrgeActionKind;
  targetId?: string;
  title: string;
  detail: string;
  goalCount: number;
  timeWindow?: [number, number];
  needTrigger?: { key: Need8Key; below: number };
  rewards: UrgeItem['rewards'];
}

const URGE_POOL: readonly UrgeTemplate[] = [
  {
    id: 'urge_bistro_matcha',
    tag: 'bistro',
    actionKind: 'order_bistro',
    targetId: 'iced_matcha',
    title: 'Order an iced matcha at Willow Bistro',
    detail: 'Treat yourself to a fresh drink at Willow Corner Bistro.',
    goalCount: 1,
    timeWindow: [7, 21],
    rewards: { moodDelta: 10, recognitionDelta: 4, karmaDelta: 2, aspirationPoints: 15 },
  },
  {
    id: 'urge_court_baskets',
    tag: 'sport',
    actionKind: 'basketball_score',
    title: 'Shoot 3 baskets at Riverside Court',
    detail: 'Sink 3 shots on the park court to shake off stress.',
    goalCount: 3,
    timeWindow: [6, 20],
    rewards: { moodDelta: 14, recognitionDelta: 8, karmaDelta: 2, aspirationPoints: 20 },
  },
  {
    id: 'urge_chat_linh',
    tag: 'social',
    actionKind: 'talk_resident',
    targetId: 'linh',
    title: 'Have a deep chat with Linh',
    detail: 'Catch up with Linh on campus, at Willow Bistro, or in the Atelier.',
    goalCount: 1,
    needTrigger: { key: 'social', below: 68 },
    rewards: { moodDelta: 12, recognitionDelta: 6, karmaDelta: 4, aspirationPoints: 18 },
  },
  {
    id: 'urge_cook_home',
    tag: 'cook',
    actionKind: 'cook_meal',
    title: 'Cook a hot meal at home',
    detail: 'Prepare any fresh recipe in your kitchen.',
    goalCount: 1,
    needTrigger: { key: 'hunger', below: 65 },
    rewards: { moodDelta: 12, recognitionDelta: 5, karmaDelta: 3, aspirationPoints: 18 },
  },
  {
    id: 'urge_complete_shift',
    tag: 'shift',
    actionKind: 'complete_shift',
    title: 'Complete a job shift',
    detail: 'Finish a part-time or full-time shift around Riverside.',
    goalCount: 1,
    timeWindow: [8, 22],
    rewards: { moodDelta: 10, recognitionDelta: 12, karmaDelta: 5, aspirationPoints: 25 },
  },
  {
    id: 'urge_capture_photo',
    tag: 'photo',
    actionKind: 'take_photo',
    title: 'Snap a Riverside Photo Studio shot',
    detail: 'Frame a landmark, sunset, or friend for your album.',
    goalCount: 1,
    rewards: { moodDelta: 10, recognitionDelta: 6, karmaDelta: 2, aspirationPoints: 16 },
  },
  {
    id: 'urge_library_study',
    tag: 'study',
    actionKind: 'study_session',
    title: 'Finish a quiet study block',
    detail: 'Focus at your desk or University Library reading tables.',
    goalCount: 1,
    rewards: { moodDelta: 8, recognitionDelta: 9, karmaDelta: 3, aspirationPoints: 18 },
  },
  {
    id: 'urge_botanical_garden',
    tag: 'garden',
    actionKind: 'garden_tend',
    title: 'Tend the Botanical Garden herbs',
    detail: 'Water the herb beds and help keep Riverside green.',
    goalCount: 1,
    rewards: { moodDelta: 12, recognitionDelta: 6, karmaDelta: 6, aspirationPoints: 18 },
  },
  {
    id: 'urge_shuttle_bus',
    tag: 'bus',
    actionKind: 'bus_ride',
    title: 'Ride the Riverside Shuttle Bus',
    detail: 'Board a shuttle between two campus or riverfront stops.',
    goalCount: 1,
    rewards: { moodDelta: 8, recognitionDelta: 4, karmaDelta: 3, aspirationPoints: 14 },
  },
  {
    id: 'urge_tidy_home',
    tag: 'home',
    actionKind: 'home_care',
    title: 'Freshen up and tidy your home',
    detail: 'Keep your space inviting for higher comfort and calm.',
    goalCount: 1,
    needTrigger: { key: 'hygiene', below: 70 },
    rewards: { moodDelta: 9, recognitionDelta: 5, karmaDelta: 4, aspirationPoints: 15 },
  },
  {
    id: 'urge_fountain_music',
    tag: 'music',
    actionKind: 'music_jam',
    title: 'Play a twilight melody at Fountain Court',
    detail: 'Strum acoustic chords at the Atelier or Old Fountain Court.',
    goalCount: 1,
    timeWindow: [15, 23],
    rewards: { moodDelta: 14, recognitionDelta: 10, karmaDelta: 3, aspirationPoints: 20 },
  },
  {
    id: 'urge_social_feed',
    tag: 'social',
    actionKind: 'social_post',
    title: 'Share a moment on Campus Feed',
    detail: 'Post an update or reply warmly to a neighbor on Echo Phone.',
    goalCount: 1,
    rewards: { moodDelta: 8, recognitionDelta: 7, karmaDelta: 3, aspirationPoints: 14 },
  },
];

function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

export interface UrgeGenContext {
  traitIds?: readonly string[];
  desiredLifeId?: string;
  needs?: Needs8;
  hour?: number;
}

const TRAIT_TAG_MAP: Readonly<Record<string, readonly string[]>> = {
  charmer: ['social', 'bistro'],
  dreamer: ['photo', 'music'],
  leader: ['shift', 'social'],
  mediator: ['social', 'garden'],
  entertainer: ['music', 'social'],
  volunteer: ['garden', 'home'],
  scholar: ['study', 'bistro'],
  perfectionist: ['cook', 'shift'],
  sentinel: ['shift', 'home'],
  individualist: ['photo', 'music'],
  collaborator: ['social', 'shift'],
  explorer: ['bus', 'photo'],
  artisan: ['cook', 'bistro'],
  athlete: ['sport', 'bus'],
  minimalist: ['home', 'garden'],
  bon_vivant: ['bistro', 'cook'],
  strategist: ['shift', 'study'],
  night_owl: ['music', 'study'],
};

const DESIRED_TAG_MAP: Readonly<Record<string, readonly string[]>> = {
  creative_icon: ['photo', 'music'],
  campus_leader: ['social', 'study'],
  culinary_host: ['cook', 'bistro'],
  tech_architect: ['study', 'shift'],
  botanical_keeper: ['garden', 'bistro'],
  social_butterfly: ['social', 'bistro'],
  wealth_builder: ['shift', 'home'],
  athletic_star: ['sport', 'bus'],
  quiet_scholar: ['study', 'bistro'],
  street_photographer: ['photo', 'bus'],
  acoustic_busker: ['music', 'social'],
  style_curator: ['home', 'social'],
  helpful_neighbor: ['home', 'garden'],
  peaceful_minimalist: ['home', 'cook'],
  urban_explorer: ['bus', 'photo'],
  master_barista: ['bistro', 'shift'],
};

export function generateDailyUrges(
  day: number,
  seed: number,
  ctx: UrgeGenContext = {},
): UrgeItem[] {
  const hour = ctx.hour ?? 10;
  const preferredTags = new Set<string>();
  for (const tid of ctx.traitIds ?? []) {
    for (const tag of TRAIT_TAG_MAP[tid] ?? []) preferredTags.add(tag);
  }
  if (ctx.desiredLifeId) {
    for (const tag of DESIRED_TAG_MAP[ctx.desiredLifeId] ?? []) preferredTags.add(tag);
  }

  const scored = URGE_POOL.map(t => {
    let score = 10 + (hashSeed(`${seed}:${day}:${t.id}`) % 17);
    if (preferredTags.has(t.tag)) score += 18;
    if (t.timeWindow && hour >= t.timeWindow[0] && hour <= t.timeWindow[1]) score += 8;
    if (t.needTrigger && ctx.needs && ctx.needs[t.needTrigger.key] < t.needTrigger.below) {
      score += 22;
    }
    return { t, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const chosen: UrgeItem[] = [];
  const usedKinds = new Set<UrgeActionKind>();
  for (const entry of scored) {
    if (usedKinds.has(entry.t.actionKind)) continue;
    usedKinds.add(entry.t.actionKind);
    chosen.push({
      id: `${entry.t.id}:d${day}`,
      tag: entry.t.tag,
      actionKind: entry.t.actionKind,
      targetId: entry.t.targetId,
      title: entry.t.title,
      detail: entry.t.detail,
      goalCount: entry.t.goalCount,
      progress: 0,
      completed: false,
      rewards: { ...entry.t.rewards },
    });
    if (chosen.length >= 3) break;
  }
  return chosen;
}

// ── 4. Personal Karma and City Karma Engine ──────────────────────────────────────────────────────────────

export type KarmaTier =
  | 'Rebellious'
  | 'Mischievous'
  | 'Steady Neighbor'
  | 'Kind Heart'
  | 'Radiant Citizen';

export type CityKarmaBand =
  | 'Restless'
  | 'Finding Balance'
  | 'Neighborly'
  | 'Thriving'
  | 'Radiant Riverside';

export type KarmaActionKind =
  | 'tidy_litter'
  | 'help_resident'
  | 'shift_excellence'
  | 'community_event'
  | 'kind_dilemma'
  | 'garden_care'
  | 'gift_resident'
  | 'rude_remark'
  | 'skip_responsibility'
  | 'litter_neglect'
  | 'selfish_dilemma';

export const KARMA_ACTION_DELTAS: Readonly<Record<KarmaActionKind, { personal: number; city: number; label: string }>> = {
  tidy_litter: { personal: 5, city: 4, label: 'Tidied street litter' },
  help_resident: { personal: 7, city: 3, label: 'Helped a neighbor' },
  shift_excellence: { personal: 6, city: 3, label: 'Delivered shift excellence' },
  community_event: { personal: 8, city: 5, label: 'Supported a community event' },
  kind_dilemma: { personal: 9, city: 4, label: 'Chose the principled path at work' },
  garden_care: { personal: 5, city: 4, label: 'Tended community greenery' },
  gift_resident: { personal: 6, city: 2, label: 'Shared a thoughtful gift' },
  rude_remark: { personal: -8, city: -3, label: 'Spoke harshly to a neighbor' },
  skip_responsibility: { personal: -10, city: -4, label: 'Walked out on a commitment' },
  litter_neglect: { personal: -7, city: -5, label: 'Left clutter behind outdoors' },
  selfish_dilemma: { personal: -12, city: -4, label: 'Cut corners at others expense' },
};

export interface KarmaLogEntry {
  action: KarmaActionKind | string;
  label: string;
  delta: number;
  day: number;
  clock: number;
}

export interface KarmaState {
  personal: number;
  tier: KarmaTier;
  city: number;
  cityBand: CityKarmaBand;
  recentLog: KarmaLogEntry[];
}

export function resolveKarmaTier(personal: number): KarmaTier {
  const s = clamp(Math.round(personal), -100, 100);
  if (s >= 65) return 'Radiant Citizen';
  if (s >= 25) return 'Kind Heart';
  if (s >= -9) return 'Steady Neighbor';
  if (s >= -44) return 'Mischievous';
  return 'Rebellious';
}

export function resolveCityKarmaBand(city: number): CityKarmaBand {
  const s = clamp(Math.round(city), 0, 100);
  if (s >= 85) return 'Radiant Riverside';
  if (s >= 65) return 'Thriving';
  if (s >= 45) return 'Neighborly';
  if (s >= 25) return 'Finding Balance';
  return 'Restless';
}

export function createInitialKarmaState(): KarmaState {
  return {
    personal: 12,
    tier: resolveKarmaTier(12),
    city: 68,
    cityBand: resolveCityKarmaBand(68),
    recentLog: [],
  };
}

export function applyKarmaDelta(
  karma: KarmaState,
  personalDelta: number,
  cityDelta: number,
  label: string,
  day = 0,
  clock = 480,
  actionKey = 'custom',
): KarmaState {
  const personal = Math.round(clamp(karma.personal + (Number.isFinite(personalDelta) ? personalDelta : 0), -100, 100));
  const city = Math.round(clamp(karma.city + (Number.isFinite(cityDelta) ? cityDelta : 0), 0, 100));
  const entry: KarmaLogEntry = {
    action: actionKey,
    label: label.slice(0, 64),
    delta: Math.round(personalDelta),
    day: Math.max(0, Math.floor(day)),
    clock: Math.max(0, Math.floor(clock)),
  };
  return {
    personal,
    tier: resolveKarmaTier(personal),
    city,
    cityBand: resolveCityKarmaBand(city),
    recentLog: [...karma.recentLog.slice(-11), entry],
  };
}

export function applyKarmaAction(
  karma: KarmaState,
  action: KarmaActionKind,
  day = 0,
  clock = 480,
): KarmaState {
  const def = KARMA_ACTION_DELTAS[action];
  return applyKarmaDelta(karma, def.personal, def.city, def.label, day, clock, action);
}

// ── 5. 8 Expanded Sub-Skills (Level 1..10 + Perks) ───────────────────────────────────────────────────────

export type SubSkillId =
  | 'cooking'
  | 'fitness'
  | 'rhetoric'
  | 'art'
  | 'music'
  | 'gardening'
  | 'coffeeCraft'
  | 'photography';

export const SUB_SKILL_IDS: readonly SubSkillId[] = [
  'cooking',
  'fitness',
  'rhetoric',
  'art',
  'music',
  'gardening',
  'coffeeCraft',
  'photography',
] as const;

export const SUB_SKILL_THRESHOLDS: readonly number[] = [
  0, 50, 120, 220, 360, 540, 780, 1080, 1460, 1950,
] as const;

export interface SubSkillDef {
  readonly id: SubSkillId;
  readonly label: string;
  readonly summary: string;
  readonly perks: readonly { readonly level: number; readonly title: string; readonly effect: string }[];
}

export const SUB_SKILL_CATALOG: Readonly<Record<SubSkillId, SubSkillDef>> = {
  cooking: {
    id: 'cooking',
    label: 'Cooking',
    summary: 'Home culinary craft, recipe variety, and meal moodlet potency.',
    perks: [
      { level: 2, title: 'Steady Skillet', effect: 'Unlocks Tomato Egg Bowl and Matcha Pancakes.' },
      { level: 5, title: 'Chef Grade Plating', effect: 'Unlocks Comfort Ramen and +20% meal mood boost.' },
      { level: 8, title: 'Neighborhood Host', effect: 'Home meals restore +15% extra hunger and fun.' },
      { level: 10, title: 'Culinary Luminary', effect: 'Every cooked dish grants Chef Grade quality.' },
    ],
  },
  fitness: {
    id: 'fitness',
    label: 'Fitness',
    summary: 'Court accuracy, jogging endurance, and athletic vitality.',
    perks: [
      { level: 2, title: 'Light Stride', effect: '10% slower sprint energy drain outdoors.' },
      { level: 5, title: 'Clutch Shooter', effect: 'Longer Hot Streak duration after court games.' },
      { level: 8, title: 'Iron Stamina', effect: 'Faster energy recovery during short breaks.' },
      { level: 10, title: 'Riverside Captain', effect: '+15% Recognition after outdoor sports.' },
    ],
  },
  rhetoric: {
    id: 'rhetoric',
    label: 'Rhetoric',
    summary: 'Persuasive speaking, workplace leadership, and deep conversations.',
    perks: [
      { level: 2, title: 'Active Listener', effect: '+10% Friendship from resident talks.' },
      { level: 5, title: 'Sharp Negotiator', effect: '+15% Promotion progress on workplace dilemmas.' },
      { level: 8, title: 'Campus Orator', effect: 'Double Recognition during seminars and meetings.' },
      { level: 10, title: 'Voice of Riverside', effect: 'Instant warm rapport with newly met residents.' },
    ],
  },
  art: {
    id: 'art',
    label: 'Art',
    summary: 'Color composition, Atelier sketching, and expressive room styling.',
    perks: [
      { level: 2, title: 'Color Eye', effect: 'Higher Inspired emotion chance indoors.' },
      { level: 5, title: 'Atelier Regular', effect: '+15% Fun from painting and styling.' },
      { level: 8, title: 'Curator Taste', effect: 'Extra Home Comfort recognition from visitors.' },
      { level: 10, title: 'Gallery Laureate', effect: 'Atelier sketches earn maximum Inspiration.' },
    ],
  },
  music: {
    id: 'music',
    label: 'Music',
    summary: 'Acoustic chords, stage rhythm, and Fountain Court busking craft.',
    perks: [
      { level: 2, title: 'Warm Strumming', effect: 'Smoother rhythm focus at Fountain Court.' },
      { level: 5, title: 'Crowd Magnet', effect: 'Nearby residents cheer and gather faster.' },
      { level: 8, title: 'Twilight Virtuoso', effect: '+20% Recognition on busker sets.' },
      { level: 10, title: 'Riverside Headliner', effect: 'Every performance uplifts City Karma.' },
    ],
  },
  gardening: {
    id: 'gardening',
    label: 'Gardening',
    summary: 'Herb cultivation, botanical stewardship, and serene tea harvests.',
    perks: [
      { level: 2, title: 'Green Sprouts', effect: 'Calm recovery bonus while tending garden beds.' },
      { level: 5, title: 'Moon-Jasmine Touch', effect: 'Extended Tea Calm moodlet duration.' },
      { level: 8, title: 'Living Sanctuary', effect: '+2 extra City Karma when tending park beds.' },
      { level: 10, title: 'Master Botanist', effect: 'Unlocks peak Botanical Curator prestige.' },
    ],
  },
  coffeeCraft: {
    id: 'coffeeCraft',
    label: 'Coffee Craft',
    summary: 'Espresso extraction, matcha whisking, and Willow Bistro mastery.',
    perks: [
      { level: 2, title: 'Silky Microfoam', effect: 'Caffeinated focus floor lasts 25% longer.' },
      { level: 5, title: 'Precision Pull', effect: 'Extra Mood and Focus from home Espresso Tonic.' },
      { level: 8, title: 'Roaster Signature', effect: '+15% Barista shift Recognition.' },
      { level: 10, title: 'Bistro Artisan', effect: 'Every brewed drink grants peak energy lift.' },
    ],
  },
  photography: {
    id: 'photography',
    label: 'Photography',
    summary: 'Framing light, seasonal storytelling, and Photo Studio craftsmanship.',
    perks: [
      { level: 2, title: 'Golden Framing', effect: 'Extra Fun when snapping sunset or rain shots.' },
      { level: 5, title: 'Storyteller Lens', effect: 'Campus Feed photo posts gain extra likes.' },
      { level: 8, title: 'Editorial Eye', effect: '+20% Campus Journalist dilemma recognition.' },
      { level: 10, title: 'Master Lens', effect: 'Unlocks signature gallery prestige in Album.' },
    ],
  },
};

export interface SubSkillProgress {
  xp: number;
  level: number;
  nextLevelXp: number | null;
}

export type SubSkillsState = Record<SubSkillId, SubSkillProgress>;

export function subSkillLevelFromXp(xp: number): number {
  const clean = Math.max(0, Math.floor(Number.isFinite(xp) ? xp : 0));
  let lv = 1;
  for (let i = 1; i < SUB_SKILL_THRESHOLDS.length; i++) {
    if (clean >= SUB_SKILL_THRESHOLDS[i]) lv = i + 1;
  }
  return lv;
}

export function nextSubSkillThreshold(level: number): number | null {
  if (level >= 10) return null;
  return SUB_SKILL_THRESHOLDS[clamp(Math.floor(level), 1, 9)];
}

export function createInitialSubSkills(): SubSkillsState {
  const out = {} as SubSkillsState;
  for (const id of SUB_SKILL_IDS) {
    out[id] = { xp: 0, level: 1, nextLevelXp: SUB_SKILL_THRESHOLDS[1] };
  }
  return out;
}

export function awardSubSkillXp(
  skills: SubSkillsState,
  id: SubSkillId,
  amount: number,
): { skills: SubSkillsState; leveledUp: boolean; previousLevel: number; newLevel: number; unlockedPerks: string[] } {
  const delta = Math.max(0, Math.round(Number.isFinite(amount) ? amount : 0));
  const cur = skills[id] ?? { xp: 0, level: 1, nextLevelXp: SUB_SKILL_THRESHOLDS[1] };
  const nextXp = cur.xp + delta;
  const newLevel = subSkillLevelFromXp(nextXp);
  const leveledUp = newLevel > cur.level;
  const unlockedPerks = leveledUp
    ? SUB_SKILL_CATALOG[id].perks.filter(p => p.level > cur.level && p.level <= newLevel).map(p => p.title)
    : [];
  return {
    skills: {
      ...skills,
      [id]: {
        xp: nextXp,
        level: newLevel,
        nextLevelXp: nextSubSkillThreshold(newLevel),
      },
    },
    leveledUp,
    previousLevel: cur.level,
    newLevel,
    unlockedPerks,
  };
}

export function getUnlockedSubSkillPerks(skills: SubSkillsState, id: SubSkillId): SubSkillDef['perks'][number][] {
  const level = skills[id]?.level ?? 1;
  return SUB_SKILL_CATALOG[id].perks.filter(p => p.level <= level);
}

// ── 6. Unified PlayerMindState + Urge Recorder ───────────────────────────────────────────────────────────

export interface PlayerMindState {
  needs: Needs8;
  urgesDay: number;
  urges: UrgeItem[];
  aspirationPoints: number;
  karma: KarmaState;
  subSkills: SubSkillsState;
}

export function createInitialPlayerMindState(
  day = 0,
  seed = 517,
  ctx: UrgeGenContext = {},
): PlayerMindState {
  const needs = createInitialNeeds8();
  return {
    needs,
    urgesDay: day,
    urges: generateDailyUrges(day, seed, { ...ctx, needs }),
    aspirationPoints: 0,
    karma: createInitialKarmaState(),
    subSkills: createInitialSubSkills(),
  };
}

export function ensureDailyUrgesForDay(
  state: PlayerMindState,
  day: number,
  seed: number,
  ctx: UrgeGenContext = {},
): PlayerMindState {
  if (state.urgesDay === day && state.urges.length === 3) return state;
  return {
    ...state,
    urgesDay: day,
    urges: generateDailyUrges(day, seed, { ...ctx, needs: state.needs }),
  };
}

export function recordActionForUrges(
  state: PlayerMindState,
  event: UrgeEvent,
  day = state.urgesDay,
  clock = 600,
): {
  state: PlayerMindState;
  completedUrges: UrgeItem[];
  rewards: {
    moodDelta: number;
    recognitionDelta: number;
    karmaDelta: number;
    aspirationPoints: number;
  };
} {
  const step = Math.max(1, Math.round(event.amount ?? 1));
  const completedUrges: UrgeItem[] = [];
  let moodDelta = 0;
  let recognitionDelta = 0;
  let karmaDelta = 0;
  let aspirationPoints = 0;

  const nextUrges = state.urges.map(u => {
    if (u.completed || u.actionKind !== event.kind) return u;
    if (u.targetId && event.targetId && u.targetId !== event.targetId) return u;
    const progress = Math.min(u.goalCount, u.progress + step);
    const completed = progress >= u.goalCount;
    const updated: UrgeItem = { ...u, progress, completed };
    if (completed) {
      completedUrges.push(updated);
      moodDelta += u.rewards.moodDelta;
      recognitionDelta += u.rewards.recognitionDelta;
      karmaDelta += u.rewards.karmaDelta;
      aspirationPoints += u.rewards.aspirationPoints;
    }
    return updated;
  });

  if (completedUrges.length === 0) {
    return {
      state: { ...state, urges: nextUrges },
      completedUrges,
      rewards: { moodDelta: 0, recognitionDelta: 0, karmaDelta: 0, aspirationPoints: 0 },
    };
  }

  const nextNeeds = applyNeedDeltas(state.needs, {
    fun: moodDelta * 0.7,
    recognition: recognitionDelta,
  });
  const nextKarma = applyKarmaDelta(
    state.karma,
    karmaDelta,
    Math.max(1, Math.round(karmaDelta * 0.5)),
    `Fulfilled urge: ${completedUrges[0].title}`,
    day,
    clock,
    'urge_fulfilled',
  );

  return {
    state: {
      ...state,
      needs: nextNeeds,
      urges: nextUrges,
      aspirationPoints: state.aspirationPoints + aspirationPoints,
      karma: nextKarma,
    },
    completedUrges,
    rewards: { moodDelta, recognitionDelta, karmaDelta, aspirationPoints },
  };
}

// ── 7. Smart Zoi Diegetic Thought Bubbles and 3-Entry Resident Diary (0 LLM Calls) ───────────────────────

export type ThoughtBubbleIcon =
  | 'tea'
  | 'umbrella'
  | 'snow'
  | 'heart'
  | 'book'
  | 'coffee'
  | 'music'
  | 'ball'
  | 'sun'
  | 'chat'
  | 'rest'
  | 'idea';

export interface DiegeticThoughtBubble {
  readonly icon: ThoughtBubbleIcon;
  readonly text: string;
  readonly tone: 'warm' | 'cool' | 'amber' | 'calm' | 'alert';
}

export interface NpcThoughtInput {
  residentId: ResidentId | string;
  residentName?: string;
  goalKind: UtilityGoalKind | string;
  goalZone?: string;
  mood: ResidentMood | string;
  weather?: Partial<EnvSnapshot>;
  latestMemory?: EpisodicMemory | null;
}

export function buildNpcThoughtBubble(input: NpcThoughtInput): DiegeticThoughtBubble {
  const rain = (input.weather?.rainIntensity ?? 0) > 0.15 || input.weather?.weatherId === 'light_rain' || input.weather?.weatherId === 'heavy_rain';
  const snow = (input.weather?.snowIntensity ?? 0) > 0.15 || input.weather?.weatherId === 'snowy';

  if (input.goalKind === 'SEEK_SHELTER' || (rain && input.mood === 'sheltering')) {
    return { icon: 'umbrella', text: 'Need shelter from rain', tone: 'cool' };
  }
  if (snow && input.goalKind !== 'V3_HARD_LOCK') {
    return { icon: 'snow', text: 'Craving something warm in the snow', tone: 'cool' };
  }

  if (input.latestMemory && input.latestMemory.salience >= 0.65) {
    if (input.latestMemory.kind === 'player_gift') {
      return { icon: 'heart', text: 'Still grateful for that gift', tone: 'warm' };
    }
    if (input.latestMemory.kind === 'player_talk' || input.latestMemory.kind === 'player_shared_activity') {
      return { icon: 'chat', text: 'Remembering our conversation', tone: 'warm' };
    }
    if (input.latestMemory.kind === 'player_basketball') {
      return { icon: 'ball', text: 'Thinking about that park shot', tone: 'amber' };
    }
  }

  switch (input.goalKind) {
    case 'SATISFY_HUNGER':
      return input.residentId === 'ngocbich' || input.residentId === 'lan' || input.residentId === 'anchi'
        ? { icon: 'tea', text: 'Craving jasmine tea', tone: 'warm' }
        : { icon: 'coffee', text: 'Ready for a Willow Bistro bite', tone: 'amber' };
    case 'RECOVER_ENERGY':
      return { icon: 'rest', text: 'Looking for a quiet bench', tone: 'calm' };
    case 'PURSUE_FOCUS':
      return { icon: 'book', text: 'Deep into notes and reading', tone: 'calm' };
    case 'SOCIALIZE_GROUP':
      return { icon: 'chat', text: 'Hoping to catch up with friends', tone: 'warm' };
    case 'SEEK_FUN':
      return input.residentId === 'minh' || input.residentId === 'tuankiet'
        ? { icon: 'ball', text: 'Ready for a quick park game', tone: 'amber' }
        : input.residentId === 'haidang'
          ? { icon: 'music', text: 'Humming a new twilight chord', tone: 'warm' }
          : { icon: 'idea', text: 'Looking for a fun break', tone: 'amber' };
    case 'ENJOY_WEATHER':
      return { icon: 'sun', text: 'Soaking in the riverside breeze', tone: 'calm' };
    default:
      if (input.mood === 'tired') return { icon: 'rest', text: 'Could use a quick coffee break', tone: 'calm' };
      if (input.mood === 'excited') return { icon: 'idea', text: 'Looking forward to today', tone: 'amber' };
      if (input.mood === 'focused') return { icon: 'book', text: 'Keeping a steady work rhythm', tone: 'calm' };
      return { icon: 'tea', text: 'Craving jasmine tea', tone: 'warm' };
  }
}

export interface ResidentDiaryEntry {
  readonly period: 'Morning' | 'Afternoon' | 'Evening';
  readonly headline: string;
  readonly body: string;
  readonly moodTag: string;
}

export interface ResidentDiaryInput {
  residentId: ResidentId | string;
  residentName: string;
  role?: string;
  day: number;
  goal?: Partial<ActiveGoal> | null;
  mood: ResidentMood | string;
  weather?: Partial<EnvSnapshot>;
  memories?: readonly EpisodicMemory[];
}

export function buildResidentDailyDiary(input: ResidentDiaryInput): readonly [
  ResidentDiaryEntry,
  ResidentDiaryEntry,
  ResidentDiaryEntry,
] {
  const name = input.residentName || input.residentId;
  const rain = (input.weather?.rainIntensity ?? 0) > 0.15;
  const snow = (input.weather?.snowIntensity ?? 0) > 0.15;
  const weatherPhrase = snow
    ? 'snow drifting over Lantern Street'
    : rain
      ? 'soft rain tapping against the awnings'
      : 'clear sunlight along Riverside Lane';

  const latestMem = input.memories && input.memories.length > 0
    ? input.memories[input.memories.length - 1]
    : null;

  const morning: ResidentDiaryEntry = {
    period: 'Morning',
    headline: `Started Day ${input.day + 1} with ${weatherPhrase}`,
    body: `${name} checked the morning routine with a ${input.mood} outlook${input.role ? ` as ${input.role}` : ''}.`,
    moodTag: String(input.mood),
  };

  const afternoon: ResidentDiaryEntry = latestMem
    ? {
        period: 'Afternoon',
        headline: 'A memorable neighbor moment',
        body: `${name} kept thinking about ${latestMem.subject || 'a friendly exchange'} near ${latestMem.zone || 'town'} and felt ${latestMem.valence >= 0 ? 'uplifted' : 'reflective'}.`,
        moodTag: latestMem.valence >= 0 ? 'warm' : 'thoughtful',
      }
    : {
        period: 'Afternoon',
        headline: 'Steady rhythm across Riverside',
        body: `${name} spent midday focused on ${input.goal?.reason || 'neighborhood errands and studio notes'}.`,
        moodTag: 'focused',
      };

  const evening: ResidentDiaryEntry = {
    period: 'Evening',
    headline: 'Lantern light reflection',
    body: snow
      ? `${name} warmed up indoors with hot tea and planned cozy goals for tomorrow.`
      : rain
        ? `${name} listened to the evening rain and wrote down one small kindness to pass forward.`
        : `${name} strolled past the glowing lanterns feeling grateful for the Riverside community.`,
    moodTag: 'calm',
  };

  return [morning, afternoon, evening];
}
