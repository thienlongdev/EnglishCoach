/**
 * Echo Life Wave 11 — 5-Tier Part-Time Career Ladders (7 Shifts) and
 * 4 Full-Time / Hybrid Career Tracks with Interactive Workplace Dilemmas.
 *
 * Pure deterministic simulation (zero V3 edits, zero network/LLM calls,
 * 100% clean English copy).
 */
import type { V3ZoneId } from '../zones';

// ── 1. 5-Tier Part-Time Career Ladder (All 7 Active Shifts) ──────────────────────────────────────────────

export type PartTimeJobId =
  | 'market'
  | 'barista'
  | 'delivery'
  | 'library'
  | 'cafe'
  | 'gardener'
  | 'busker';

export const PART_TIME_JOB_IDS: readonly PartTimeJobId[] = [
  'market',
  'barista',
  'delivery',
  'library',
  'cafe',
  'gardener',
  'busker',
] as const;

export type CareerRankTitle = 'Trainee' | 'Associate' | 'Specialist' | 'Lead' | 'Master';

export interface CareerTierStep {
  readonly tier: 1 | 2 | 3 | 4 | 5;
  readonly rankTitle: CareerRankTitle;
  readonly minShifts: number;
  readonly payMultiplier: number;
  readonly outfitUnlock: string;
  readonly perkDescription: string;
}

export const CAREER_LADDER_THRESHOLDS: readonly {
  readonly tier: 1 | 2 | 3 | 4 | 5;
  readonly rankTitle: CareerRankTitle;
  readonly minShifts: number;
  readonly payMultiplier: number;
}[] = [
  { tier: 1, rankTitle: 'Trainee', minShifts: 0, payMultiplier: 1.00 },
  { tier: 2, rankTitle: 'Associate', minShifts: 2, payMultiplier: 1.05 },
  { tier: 3, rankTitle: 'Specialist', minShifts: 5, payMultiplier: 1.10 },
  { tier: 4, rankTitle: 'Lead', minShifts: 10, payMultiplier: 1.15 },
  { tier: 5, rankTitle: 'Master', minShifts: 18, payMultiplier: 1.20 },
] as const;

export interface PartTimeCareerTrack {
  readonly jobId: PartTimeJobId;
  readonly title: string;
  readonly leadNpc: string;
  readonly zone: V3ZoneId;
  readonly skill: string;
  readonly basePay: number;
  readonly tiers: readonly [
    CareerTierStep,
    CareerTierStep,
    CareerTierStep,
    CareerTierStep,
    CareerTierStep,
  ];
}

function buildLadder(
  perks: readonly [
    [string, string],
    [string, string],
    [string, string],
    [string, string],
    [string, string],
  ],
): readonly [CareerTierStep, CareerTierStep, CareerTierStep, CareerTierStep, CareerTierStep] {
  return [
    { ...CAREER_LADDER_THRESHOLDS[0], outfitUnlock: perks[0][0], perkDescription: perks[0][1] },
    { ...CAREER_LADDER_THRESHOLDS[1], outfitUnlock: perks[1][0], perkDescription: perks[1][1] },
    { ...CAREER_LADDER_THRESHOLDS[2], outfitUnlock: perks[2][0], perkDescription: perks[2][1] },
    { ...CAREER_LADDER_THRESHOLDS[3], outfitUnlock: perks[3][0], perkDescription: perks[3][1] },
    { ...CAREER_LADDER_THRESHOLDS[4], outfitUnlock: perks[4][0], perkDescription: perks[4][1] },
  ];
}

export const PART_TIME_CAREERS: Readonly<Record<PartTimeJobId, PartTimeCareerTrack>> = {
  market: {
    jobId: 'market',
    title: 'Sunrise Market Clerk',
    leadNpc: 'mai',
    zone: 'market',
    skill: 'business',
    basePay: 45,
    tiers: buildLadder([
      ['Canvas Market Apron', 'Standard checkout training with Mai and steady aisle pace.'],
      ['Sunrise Crew Tee', '+5% shift pay and crisp restocking flow (+2 extra Recognition).'],
      ['Produce Curator Vest', '+10% shift pay and sharper grocery bundle recommendations.'],
      ['Market Floor Shirt', '+15% shift pay and faster checkout composure on flash sale days.'],
      ['Sunrise Partner Jacket', '+20% shift pay and lasting Sunrise Market neighborhood respect.'],
    ]),
  },
  barista: {
    jobId: 'barista',
    title: 'Willow Bistro Barista',
    leadNpc: 'khanhha',
    zone: 'bistro',
    skill: 'cooking',
    basePay: 60,
    tiers: buildLadder([
      ['Espresso Tasting Apron', 'Core espresso pull coaching alongside Khanh Ha.'],
      ['Roaster Knit Pullover', '+5% shift pay and longer Caffeinated clarity after shifts.'],
      ['Latte Artisan Shirt', '+10% shift pay and bonus Coffee Craft sub-skill XP.'],
      ['Willow Head Barista Cardigan', '+15% shift pay and extra warmth with bistro regulars.'],
      ['Master Roaster Overcoat', '+20% shift pay and signature Willow Bistro reputation bonus.'],
    ]),
  },
  delivery: {
    jobId: 'delivery',
    title: 'Greenway Express Courier',
    leadNpc: 'quocbao',
    zone: 'street',
    skill: 'mobility',
    basePay: 75,
    tiers: buildLadder([
      ['Courier Canvas Daypack', 'Standard Greenway route briefing with Quoc Bao.'],
      ['Reflective Track Tee', '+5% shift pay and lighter sprint energy cost on deliveries.'],
      ['Express Windbreaker Jacket', '+10% shift pay and smoother bike handling confidence.'],
      ['Riverside Route Lead Parka', '+15% shift pay and bonus Fitness XP on every drop.'],
      ['Grand Express Dispatch Coat', '+20% shift pay and peak Greenway neighborhood renown.'],
    ]),
  },
  library: {
    jobId: 'library',
    title: 'University Library Archivist',
    leadNpc: 'anchi',
    zone: 'library',
    skill: 'social',
    basePay: 55,
    tiers: buildLadder([
      ['Archivist Reading Glasses', 'Guided stack sorting and catalog craft with An Chi.'],
      ['Quiet Stacks Cardigan', '+5% shift pay and calmer Focus retention during study.'],
      ['Folio Scholar Shirt', '+10% shift pay and bonus Rhetoric sub-skill XP.'],
      ['Senior Curator Trench Coat', '+15% shift pay and deeper campus archive insight.'],
      ['Head Archivist Wool Overcoat', '+20% shift pay and respected scholar standing across campus.'],
    ]),
  },
  cafe: {
    jobId: 'cafe',
    title: 'Pixel Cafe Hardware Tech',
    leadNpc: 'huy',
    zone: 'cafe',
    skill: 'technology',
    basePay: 65,
    tiers: buildLadder([
      ['Studio Tech Headphones', 'Terminal calibration fundamentals with Huy.'],
      ['Circuit Fleece Hoodie', '+5% shift pay and brisker hardware diagnostics pace.'],
      ['Systems Field Jacket', '+10% shift pay and bonus Tech craftsmanship prestige.'],
      ['Arcade Lead Bomber', '+15% shift pay and respect from Pixel Cafe regulars.'],
      ['Flagship Rig Architect Coat', '+20% shift pay and top benchmark recognition in town.'],
    ]),
  },
  gardener: {
    jobId: 'gardener',
    title: 'Botanical Gardener',
    leadNpc: 'ngocbich',
    zone: 'botanical',
    skill: 'diy_design',
    basePay: 55,
    tiers: buildLadder([
      ['Botanical Sun Cap', 'Herb care and moon-jasmine watering rhythm with Ngoc Bich.'],
      ['Garden Linen Long-Sleeve', '+5% shift pay and gentle Calm recovery outdoors.'],
      ['Greenhouse Knit Sweater', '+10% shift pay and bonus Gardening sub-skill XP.'],
      ['Conservatory Field Jacket', '+15% shift pay and extra City Karma on every shift.'],
      ['Master Herbalist Trench Coat', '+20% shift pay and extended Tea Calm serenity.'],
    ]),
  },
  busker: {
    jobId: 'busker',
    title: 'Fountain Plaza Busker',
    leadNpc: 'haidang',
    zone: 'fountain_plaza',
    skill: 'social',
    basePay: 60,
    tiers: buildLadder([
      ['Acoustic Stage Scarf', 'Twilight open-mic rhythm guidance with Hai Dang.'],
      ['Indie Denim Jacket', '+5% shift pay and livelier Fountain Court crowd warmth.'],
      ['Courtyard Performers Cardigan', '+10% shift pay and bonus Music sub-skill XP.'],
      ['Twilight Headline Coat', '+15% shift pay and boosted Playful mood after sets.'],
      ['Riverside Virtuoso Ensemble', '+20% shift pay and inspiring City Karma resonance.'],
    ]),
  },
};

export interface PartTimeCareerStatus {
  readonly jobId: PartTimeJobId;
  readonly title: string;
  readonly leadNpc: string;
  readonly zone: V3ZoneId;
  readonly skill: string;
  readonly completedShifts: number;
  readonly tier: 1 | 2 | 3 | 4 | 5;
  readonly rankTitle: CareerRankTitle;
  readonly payMultiplier: number;
  readonly basePay: number;
  readonly effectivePay: number;
  readonly nextTierShifts: number | null;
  readonly shiftsToNextTier: number;
  readonly currentTierDef: CareerTierStep;
  readonly nextTierDef: CareerTierStep | null;
  readonly unlockedOutfits: readonly string[];
  readonly unlockedPerks: readonly string[];
}

export function getPartTimeCareerStatus(
  jobId: PartTimeJobId,
  completedShifts: number,
): PartTimeCareerStatus {
  const track = PART_TIME_CAREERS[jobId];
  const shifts = Math.max(0, Math.floor(Number.isFinite(completedShifts) ? completedShifts : 0));
  let idx = 0;
  for (let i = track.tiers.length - 1; i >= 0; i--) {
    if (shifts >= track.tiers[i].minShifts) {
      idx = i;
      break;
    }
  }
  const current = track.tiers[idx];
  const next = idx < track.tiers.length - 1 ? track.tiers[idx + 1] : null;
  const effectivePay = Math.round(track.basePay * current.payMultiplier);
  return {
    jobId,
    title: track.title,
    leadNpc: track.leadNpc,
    zone: track.zone,
    skill: track.skill,
    completedShifts: shifts,
    tier: current.tier,
    rankTitle: current.rankTitle,
    payMultiplier: current.payMultiplier,
    basePay: track.basePay,
    effectivePay,
    nextTierShifts: next ? next.minShifts : null,
    shiftsToNextTier: next ? Math.max(0, next.minShifts - shifts) : 0,
    currentTierDef: current,
    nextTierDef: next,
    unlockedOutfits: track.tiers.slice(0, idx + 1).map(t => t.outfitUnlock),
    unlockedPerks: track.tiers.slice(0, idx + 1).map(t => t.perkDescription),
  };
}

export function computeShiftPay(jobId: PartTimeJobId, completedShifts: number): number {
  return getPartTimeCareerStatus(jobId, completedShifts).effectivePay;
}

export function getAllPartTimeStatuses(
  shiftCounts: Partial<Record<PartTimeJobId, number>>,
): PartTimeCareerStatus[] {
  return PART_TIME_JOB_IDS.map(id => getPartTimeCareerStatus(id, shiftCounts[id] ?? 0));
}

// ── 2. 4 Full-Time / Hybrid Career Tracks and Interactive Workplace Dilemmas ─────────────────────────────

export type FullTimeCareerId =
  | 'campus_journalist'
  | 'junior_web_developer'
  | 'botanical_curator'
  | 'community_event_producer';

export const FULL_TIME_CAREER_IDS: readonly FullTimeCareerId[] = [
  'campus_journalist',
  'junior_web_developer',
  'botanical_curator',
  'community_event_producer',
] as const;

export interface FullTimeRank {
  readonly rank: 1 | 2 | 3 | 4 | 5;
  readonly title: string;
  readonly dailyStipend: number;
  readonly recognitionBonus: number;
}

export interface FullTimeCareerTrack {
  readonly id: FullTimeCareerId;
  readonly title: string;
  readonly mode: 'remote' | 'hybrid' | 'onsite';
  readonly mentorNpc: string;
  readonly primarySubSkill: string;
  readonly workZones: readonly V3ZoneId[];
  /** Weekday indexes 0=Mon..6=Sun */
  readonly workDays: readonly number[];
  readonly startHour: number;
  readonly endHour: number;
  readonly scheduleLabel: string;
  readonly summary: string;
  readonly ranks: readonly [FullTimeRank, FullTimeRank, FullTimeRank, FullTimeRank, FullTimeRank];
}

export const FULL_TIME_CAREERS: readonly FullTimeCareerTrack[] = [
  {
    id: 'campus_journalist',
    title: 'Campus Journalist',
    mode: 'hybrid',
    mentorNpc: 'minhthu',
    primarySubSkill: 'rhetoric',
    workZones: ['library', 'campus', 'study'],
    workDays: [0, 1, 2, 3, 4],
    startHour: 9,
    endHour: 15,
    scheduleLabel: 'Mon to Fri, 09:00 to 15:00 (Hybrid Campus and Home Desk)',
    summary: 'Cover student stories, interview local artisans, and publish weekly Riverside features.',
    ranks: [
      { rank: 1, title: 'Junior Reporter', dailyStipend: 85, recognitionBonus: 6 },
      { rank: 2, title: 'Feature Writer', dailyStipend: 100, recognitionBonus: 9 },
      { rank: 3, title: 'Photojournalism Lead', dailyStipend: 118, recognitionBonus: 12 },
      { rank: 4, title: 'Managing Columnist', dailyStipend: 138, recognitionBonus: 16 },
      { rank: 5, title: 'Editor in Chief', dailyStipend: 160, recognitionBonus: 20 },
    ],
  },
  {
    id: 'junior_web_developer',
    title: 'Junior Web Developer',
    mode: 'remote',
    mentorNpc: 'huy',
    primarySubSkill: 'rhetoric',
    workZones: ['study', 'gaming_room', 'cafe'],
    workDays: [0, 1, 2, 3, 4],
    startHour: 10,
    endHour: 16,
    scheduleLabel: 'Mon to Fri, 10:00 to 16:00 (Remote Workstation or Pixel Cafe)',
    summary: 'Ship accessible community web apps, debug campus tools, and collaborate on clean code.',
    ranks: [
      { rank: 1, title: 'Frontend Intern', dailyStipend: 95, recognitionBonus: 6 },
      { rank: 2, title: 'Junior Web Developer', dailyStipend: 115, recognitionBonus: 9 },
      { rank: 3, title: 'Full-Stack Builder', dailyStipend: 135, recognitionBonus: 13 },
      { rank: 4, title: 'Senior UI Engineer', dailyStipend: 158, recognitionBonus: 17 },
      { rank: 5, title: 'Lead Systems Architect', dailyStipend: 185, recognitionBonus: 22 },
    ],
  },
  {
    id: 'botanical_curator',
    title: 'Botanical Curator',
    mode: 'onsite',
    mentorNpc: 'ngocbich',
    primarySubSkill: 'gardening',
    workZones: ['botanical', 'lantern_garden', 'park'],
    workDays: [1, 2, 3, 4, 5],
    startHour: 8,
    endHour: 14,
    scheduleLabel: 'Tue to Sat, 08:00 to 14:00 (On-Site Botanical Garden)',
    summary: 'Design seasonal plantings, preserve moon-jasmine varieties, and host neighborhood garden workshops.',
    ranks: [
      { rank: 1, title: 'Greenhouse Apprentice', dailyStipend: 82, recognitionBonus: 6 },
      { rank: 2, title: 'Herb Bed Specialist', dailyStipend: 98, recognitionBonus: 9 },
      { rank: 3, title: 'Botanical Curator', dailyStipend: 116, recognitionBonus: 13 },
      { rank: 4, title: 'Conservatory Director', dailyStipend: 136, recognitionBonus: 16 },
      { rank: 5, title: 'Head Flora Steward', dailyStipend: 158, recognitionBonus: 20 },
    ],
  },
  {
    id: 'community_event_producer',
    title: 'Community Event Producer',
    mode: 'hybrid',
    mentorNpc: 'linh',
    primarySubSkill: 'music',
    workZones: ['fountain_plaza', 'fair', 'campus'],
    workDays: [2, 3, 4, 5, 6],
    startHour: 11,
    endHour: 17,
    scheduleLabel: 'Wed to Sun, 11:00 to 17:00 (Hybrid Fountain Court and Home Studio)',
    summary: 'Coordinate live acoustic sets, seasonal festivals, and welcoming stalls across Riverside.',
    ranks: [
      { rank: 1, title: 'Stage Assistant', dailyStipend: 88, recognitionBonus: 7 },
      { rank: 2, title: 'Booth Coordinator', dailyStipend: 104, recognitionBonus: 10 },
      { rank: 3, title: 'Community Producer', dailyStipend: 124, recognitionBonus: 14 },
      { rank: 4, title: 'Program Director', dailyStipend: 146, recognitionBonus: 18 },
      { rank: 5, title: 'Riverside Festival Director', dailyStipend: 170, recognitionBonus: 24 },
    ],
  },
] as const;

const FULL_TIME_BY_ID = new Map<FullTimeCareerId, FullTimeCareerTrack>(
  FULL_TIME_CAREERS.map(c => [c.id, c]),
);

export interface DilemmaChoice {
  readonly id: string;
  readonly label: string;
  readonly karmaDelta: number;
  readonly recognitionDelta: number;
  readonly promotionDelta: number;
  readonly energyDelta: number;
  readonly outcomeText: string;
}

export interface WorkplaceDilemma {
  readonly id: string;
  readonly careerId: FullTimeCareerId;
  readonly title: string;
  readonly prompt: string;
  readonly choices: readonly DilemmaChoice[];
}

export const WORKPLACE_DILEMMAS: readonly WorkplaceDilemma[] = [
  // Campus Journalist (3)
  {
    id: 'dil_journ_source',
    careerId: 'campus_journalist',
    title: 'Unverified Rumor Before Print',
    prompt: 'A dramatic campus tip lands ten minutes before deadline, yet the resident named has not confirmed it.',
    choices: [
      {
        id: 'verify_first',
        label: 'Hold the rumor and walk over to verify with the resident directly.',
        karmaDelta: 8,
        recognitionDelta: 10,
        promotionDelta: 34,
        energyDelta: -10,
        outcomeText: 'Your verified profile earned deep trust from Ms. Lan and boosted editorial standards.',
      },
      {
        id: 'balanced_note',
        label: 'Run a shorter verified news brief and schedule a follow-up interview.',
        karmaDelta: 4,
        recognitionDelta: 6,
        promotionDelta: 24,
        energyDelta: -5,
        outcomeText: 'The paper published cleanly on time while respecting everyone involved.',
      },
      {
        id: 'rush_headline',
        label: 'Publish the flashy rumor immediately for fast clicks.',
        karmaDelta: -10,
        recognitionDelta: -4,
        promotionDelta: 10,
        energyDelta: -2,
        outcomeText: 'The headline drew quick views, then required an awkward evening correction.',
      },
    ],
  },
  {
    id: 'dil_journ_freshman',
    careerId: 'campus_journalist',
    title: 'Quiet Voice Spotlight',
    prompt: 'You have one feature page open: highlight a well-known club or profile shy newcomer poets like Thao Vy.',
    choices: [
      {
        id: 'spotlight_newcomer',
        label: 'Co-write an inviting spotlight celebrating first-year student writers.',
        karmaDelta: 9,
        recognitionDelta: 12,
        promotionDelta: 36,
        energyDelta: -8,
        outcomeText: 'Readers pinned copies across University Green and newcomers thanked the newsroom.',
      },
      {
        id: 'split_column',
        label: 'Give both groups a thoughtful paired column.',
        karmaDelta: 5,
        recognitionDelta: 8,
        promotionDelta: 28,
        energyDelta: -6,
        outcomeText: 'Everyone appreciated the fair coverage and crisp layout.',
      },
    ],
  },
  {
    id: 'dil_journ_rain_essay',
    careerId: 'campus_journalist',
    title: 'Rainy Afternoon Photo Essay',
    prompt: 'A sudden shower hits Lantern Street right as Minh Thu asks for a partner on a wet-weather feature.',
    choices: [
      {
        id: 'brave_rain',
        label: 'Grab an umbrella and capture glowing lantern reflections together.',
        karmaDelta: 6,
        recognitionDelta: 11,
        promotionDelta: 38,
        energyDelta: -12,
        outcomeText: 'Your rainy lantern spread became the most saved issue of the semester.',
      },
      {
        id: 'indoor_bistro',
        label: 'Interview neighbors sheltering warmly inside Willow Corner Bistro.',
        karmaDelta: 5,
        recognitionDelta: 8,
        promotionDelta: 28,
        energyDelta: -5,
        outcomeText: 'The cozy human-interest quotes charmed the entire campus.',
      },
    ],
  },

  // Junior Web Developer (3)
  {
    id: 'dil_dev_accessibility',
    careerId: 'junior_web_developer',
    title: 'Keyboard Accessibility Audit',
    prompt: 'Before shipping the campus schedule app, you notice keyboard focus rings are missing on mobile drawers.',
    choices: [
      {
        id: 'fix_a11y',
        label: 'Spend an extra hour adding complete keyboard navigation and ARIA labels.',
        karmaDelta: 8,
        recognitionDelta: 11,
        promotionDelta: 36,
        energyDelta: -10,
        outcomeText: 'Your clean accessibility patch became the studio checklist template.',
      },
      {
        id: 'log_ticket',
        label: 'Ship core fixes now and pair with Huy on full accessibility tomorrow.',
        karmaDelta: 3,
        recognitionDelta: 6,
        promotionDelta: 24,
        energyDelta: -5,
        outcomeText: 'The release stayed steady with a clear follow-up plan.',
      },
      {
        id: 'skip_a11y',
        label: 'Ignore the issue to log off early.',
        karmaDelta: -8,
        recognitionDelta: -5,
        promotionDelta: 8,
        energyDelta: 4,
        outcomeText: 'Several library users struggled to navigate the schedule tab.',
      },
    ],
  },
  {
    id: 'dil_dev_outage',
    careerId: 'junior_web_developer',
    title: 'Pixel Cafe Leaderboard Glitch',
    prompt: 'Scores stopped syncing right before the evening tournament at Pixel Cafe.',
    choices: [
      {
        id: 'hotfix_live',
        label: 'Trace the race condition cleanly and deploy a verified fix.',
        karmaDelta: 7,
        recognitionDelta: 12,
        promotionDelta: 38,
        energyDelta: -12,
        outcomeText: 'Duy Khoa and Huy cheered as the 120 BPM bracket resumed without a single lost score.',
      },
      {
        id: 'fallback_cache',
        label: 'Enable offline queue fallback while testing a clean patch.',
        karmaDelta: 5,
        recognitionDelta: 8,
        promotionDelta: 28,
        energyDelta: -7,
        outcomeText: 'Zero data was lost and the calm rollback impressed the team.',
      },
    ],
  },
  {
    id: 'dil_dev_mentor',
    careerId: 'junior_web_developer',
    title: 'Freshman Pull Request Review',
    prompt: 'A nervous first-year contributor submits a messy first pull request right before sprint review.',
    choices: [
      {
        id: 'kind_review',
        label: 'Write encouraging line-by-line notes and pair-refactor together.',
        karmaDelta: 10,
        recognitionDelta: 10,
        promotionDelta: 35,
        energyDelta: -9,
        outcomeText: 'The contributor shipped a spotless patch and gained lasting confidence.',
      },
      {
        id: 'rewrite_solo',
        label: 'Rewrite the branch silently yourself to save time.',
        karmaDelta: -3,
        recognitionDelta: 4,
        promotionDelta: 18,
        energyDelta: -8,
        outcomeText: 'The code shipped fast, though the teammate missed out on learning why.',
      },
    ],
  },

  // Botanical Curator (3)
  {
    id: 'dil_bot_frost',
    careerId: 'botanical_curator',
    title: 'Sudden Riverside Cold Snap',
    prompt: 'Evening temperatures drop sharply and the young moon-jasmine saplings need frost covers.',
    choices: [
      {
        id: 'cover_all',
        label: 'Stay late with Ngoc Bich to wrap every delicate bed carefully.',
        karmaDelta: 9,
        recognitionDelta: 10,
        promotionDelta: 38,
        energyDelta: -12,
        outcomeText: 'Every moon-jasmine bloom survived and fragrant buds opened by morning.',
      },
      {
        id: 'rally_neighbors',
        label: 'Message nearby residents on Echo Phone to turn it into a 20-minute community save.',
        karmaDelta: 8,
        recognitionDelta: 12,
        promotionDelta: 34,
        energyDelta: -6,
        outcomeText: 'Neighbors arrived with warm tea and finished covering the garden together.',
      },
    ],
  },
  {
    id: 'dil_bot_paving',
    careerId: 'botanical_curator',
    title: 'Shortcut Across the Herb Bed',
    prompt: 'Commuters have worn a muddy shortcut straight through the mint border.',
    choices: [
      {
        id: 'stepping_stones',
        label: 'Lay curved timber stepping stones and replant resilient thyme beside them.',
        karmaDelta: 8,
        recognitionDelta: 11,
        promotionDelta: 36,
        energyDelta: -9,
        outcomeText: 'Pedestrians loved the charming path and the herb border flourished.',
      },
      {
        id: 'tall_fence',
        label: 'Put up a strict keep-out rope around the whole corner.',
        karmaDelta: -2,
        recognitionDelta: 3,
        promotionDelta: 16,
        energyDelta: -4,
        outcomeText: 'The mint recovered slowly, though walkers grumbled about the detour.',
      },
    ],
  },
  {
    id: 'dil_bot_workshop',
    careerId: 'botanical_curator',
    title: 'Saturday Herb Tea Workshop',
    prompt: 'Twice as many neighbors arrive for your herbal blending workshop as expected.',
    choices: [
      {
        id: 'expand_tables',
        label: 'Set up extra patio bowls so every visitor leaves with a mini sprout.',
        karmaDelta: 9,
        recognitionDelta: 12,
        promotionDelta: 36,
        energyDelta: -10,
        outcomeText: 'Laughter filled the pergola and City Karma climbed across Riverside.',
      },
      {
        id: 'two_sessions',
        label: 'Split smoothly into an early and late tasting circle.',
        karmaDelta: 6,
        recognitionDelta: 9,
        promotionDelta: 30,
        energyDelta: -7,
        outcomeText: 'Both circles stayed serene, attentive, and deeply relaxing.',
      },
    ],
  },

  // Community Event Producer (3)
  {
    id: 'dil_evt_rain_stage',
    careerId: 'community_event_producer',
    title: 'Rain Forecast on Acoustic Night',
    prompt: 'Clouds gather over Old Campus Fountain Court two hours before Hai Dang takes the stage.',
    choices: [
      {
        id: 'atelier_shift',
        label: 'Move amps smoothly into Riverside Atelier with warm string lanterns.',
        karmaDelta: 8,
        recognitionDelta: 12,
        promotionDelta: 38,
        energyDelta: -10,
        outcomeText: 'The intimate indoor acoustic concert became a cherished town memory.',
      },
      {
        id: 'canopy_tents',
        label: 'Erect waterproof canopies beside the fountain so outdoor strolls continue.',
        karmaDelta: 6,
        recognitionDelta: 10,
        promotionDelta: 32,
        energyDelta: -11,
        outcomeText: 'Audiences swayed under dry canopies while rain shimmered on the stone court.',
      },
    ],
  },
  {
    id: 'dil_evt_budget',
    careerId: 'community_event_producer',
    title: 'Tight Festival Reserve',
    prompt: 'Hoang Phuc flags that booth lighting exceeds the student council budget by 15 percent.',
    choices: [
      {
        id: 'local_sponsors',
        label: 'Partner with Mai, Khanh Ha, and Phuong Lien for shared artisan banners.',
        karmaDelta: 9,
        recognitionDelta: 13,
        promotionDelta: 40,
        energyDelta: -9,
        outcomeText: 'The coalition funded every lantern while protecting student scholarship reserves.',
      },
      {
        id: 'diy_lanterns',
        label: 'Host an evening paper-lantern craft circle with Linh to cut costs cleanly.',
        karmaDelta: 8,
        recognitionDelta: 10,
        promotionDelta: 32,
        energyDelta: -8,
        outcomeText: 'Handmade student lanterns glowed warmer than any commercial rig.',
      },
      {
        id: 'charge_entry',
        label: 'Add a paid entry gate for freshmen to cover the shortfall.',
        karmaDelta: -10,
        recognitionDelta: -6,
        promotionDelta: 10,
        energyDelta: -2,
        outcomeText: 'Attendance dipped sharply and Linh reminded you the festival belongs to everyone.',
      },
    ],
  },
  {
    id: 'dil_evt_cleanup',
    careerId: 'community_event_producer',
    title: 'Midnight Fair Teardown',
    prompt: 'Boardwalk Fair wraps up with glowing smiles, leaving crates and paper cups along the pier.',
    choices: [
      {
        id: 'lead_cleanup',
        label: 'Lead a cheerful 15-minute cleanup sweep with Yen Nhi before heading home.',
        karmaDelta: 10,
        recognitionDelta: 11,
        promotionDelta: 35,
        energyDelta: -10,
        outcomeText: 'By sunrise the boardwalk sparkled and Quoc Bao praised your stewardship.',
      },
      {
        id: 'morning_crew',
        label: 'Stack crates neatly and schedule an early sunrise sweep.',
        karmaDelta: 4,
        recognitionDelta: 6,
        promotionDelta: 24,
        energyDelta: -4,
        outcomeText: 'Everything stayed safe overnight and wrapped smoothly at dawn.',
      },
    ],
  },
] as const;

const DILEMMA_BY_ID = new Map<string, WorkplaceDilemma>(WORKPLACE_DILEMMAS.map(d => [d.id, d]));

export interface FullTimeCareerState {
  activeCareerId: FullTimeCareerId | null;
  rank: 1 | 2 | 3 | 4 | 5;
  promotionProgress: number;
  workdaysCompleted: number;
  lastWorkedDay: number;
  lastDilemmaDay: number;
  resolvedDilemmaIds: string[];
}

export function createInitialCareerState(): FullTimeCareerState {
  return {
    activeCareerId: null,
    rank: 1,
    promotionProgress: 0,
    workdaysCompleted: 0,
    lastWorkedDay: -1,
    lastDilemmaDay: -1,
    resolvedDilemmaIds: [],
  };
}

export function getFullTimeCareer(careerId: FullTimeCareerId | null | undefined): FullTimeCareerTrack | null {
  if (!careerId) return null;
  return FULL_TIME_BY_ID.get(careerId) ?? null;
}

export function enrollFullTimeCareer(
  state: FullTimeCareerState,
  careerId: FullTimeCareerId,
): FullTimeCareerState {
  if (!FULL_TIME_BY_ID.has(careerId)) return state;
  if (state.activeCareerId === careerId) return state;
  return {
    ...state,
    activeCareerId: careerId,
    rank: 1,
    promotionProgress: 0,
  };
}

export function isFullTimeShiftWindowOpen(
  careerId: FullTimeCareerId,
  weekdayIndex: number,
  hour: number,
): boolean {
  const track = FULL_TIME_BY_ID.get(careerId);
  if (!track) return false;
  const wd = ((Math.floor(weekdayIndex) % 7) + 7) % 7;
  return track.workDays.includes(wd) && hour >= track.startHour && hour < track.endHour;
}

export function pickWorkplaceDilemma(
  careerId: FullTimeCareerId,
  day: number,
  seed = 517,
  resolvedIds: readonly string[] = [],
): WorkplaceDilemma | null {
  const pool = WORKPLACE_DILEMMAS.filter(d => d.careerId === careerId);
  if (pool.length === 0) return null;
  const unresolved = pool.filter(d => !resolvedIds.includes(d.id));
  const candidates = unresolved.length > 0 ? unresolved : pool;
  const idx = Math.abs(Math.imul(day + 17, 2654435761) ^ seed) % candidates.length;
  return candidates[idx];
}

export interface DilemmaResolutionResult {
  readonly ok: boolean;
  readonly state: FullTimeCareerState;
  readonly dilemma: WorkplaceDilemma | null;
  readonly choice: DilemmaChoice | null;
  readonly promoted: boolean;
  readonly newRankTitle: string | null;
  readonly deltas: {
    readonly karmaDelta: number;
    readonly recognitionDelta: number;
    readonly promotionDelta: number;
    readonly energyDelta: number;
  };
}

export function resolveWorkplaceDilemma(
  state: FullTimeCareerState,
  dilemmaId: string,
  choiceId: string,
  day: number,
): DilemmaResolutionResult {
  const dilemma = DILEMMA_BY_ID.get(dilemmaId) ?? null;
  const choice = dilemma?.choices.find(c => c.id === choiceId) ?? null;
  if (!dilemma || !choice) {
    return {
      ok: false,
      state,
      dilemma,
      choice: null,
      promoted: false,
      newRankTitle: null,
      deltas: { karmaDelta: 0, recognitionDelta: 0, promotionDelta: 0, energyDelta: 0 },
    };
  }

  let rank = state.rank;
  let progress = Math.max(0, state.promotionProgress + choice.promotionDelta);
  let promoted = false;
  while (progress >= 100 && rank < 5) {
    progress -= 100;
    rank = (rank + 1) as 1 | 2 | 3 | 4 | 5;
    promoted = true;
  }
  if (rank === 5) progress = Math.min(100, progress);

  const track = FULL_TIME_BY_ID.get(dilemma.careerId);
  const newRankTitle = track ? track.ranks[rank - 1].title : null;
  const resolvedDilemmaIds = state.resolvedDilemmaIds.includes(dilemma.id)
    ? state.resolvedDilemmaIds
    : [...state.resolvedDilemmaIds.slice(-11), dilemma.id];

  return {
    ok: true,
    state: {
      ...state,
      activeCareerId: state.activeCareerId ?? dilemma.careerId,
      rank,
      promotionProgress: progress,
      lastDilemmaDay: day,
      resolvedDilemmaIds,
    },
    dilemma,
    choice,
    promoted,
    newRankTitle,
    deltas: {
      karmaDelta: choice.karmaDelta,
      recognitionDelta: choice.recognitionDelta,
      promotionDelta: choice.promotionDelta,
      energyDelta: choice.energyDelta,
    },
  };
}

export function completeFullTimeWorkday(
  state: FullTimeCareerState,
  day: number,
): {
  ok: boolean;
  reason: string;
  state: FullTimeCareerState;
  promoted: boolean;
  rankTitle: string | null;
  stipendAdvisory: number;
  recognitionDelta: number;
  energyDelta: number;
} {
  const track = getFullTimeCareer(state.activeCareerId);
  if (!track) {
    return {
      ok: false,
      reason: 'Enroll in a full-time or hybrid career track first.',
      state,
      promoted: false,
      rankTitle: null,
      stipendAdvisory: 0,
      recognitionDelta: 0,
      energyDelta: 0,
    };
  }
  if (state.lastWorkedDay === day) {
    return {
      ok: false,
      reason: 'You already completed your scheduled workday today.',
      state,
      promoted: false,
      rankTitle: track.ranks[state.rank - 1].title,
      stipendAdvisory: 0,
      recognitionDelta: 0,
      energyDelta: 0,
    };
  }

  let rank = state.rank;
  let progress = state.promotionProgress + 35;
  let promoted = false;
  if (progress >= 100 && rank < 5) {
    progress -= 100;
    rank = (rank + 1) as 1 | 2 | 3 | 4 | 5;
    promoted = true;
  }
  if (rank === 5) progress = Math.min(100, progress);

  const rankSpec = track.ranks[rank - 1];
  return {
    ok: true,
    reason: promoted
      ? `Workday complete and promoted to ${rankSpec.title}!`
      : `Completed ${track.title} shift as ${rankSpec.title}.`,
    state: {
      ...state,
      rank,
      promotionProgress: progress,
      workdaysCompleted: state.workdaysCompleted + 1,
      lastWorkedDay: day,
    },
    promoted,
    rankTitle: rankSpec.title,
    stipendAdvisory: rankSpec.dailyStipend,
    recognitionDelta: rankSpec.recognitionBonus,
    energyDelta: -18,
  };
}
