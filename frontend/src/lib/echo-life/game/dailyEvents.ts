/**
 * Echo Life — Deterministic Daily, Weather & Seasonal Micro-Activity Director.
 *
 * Pure, read-only projection over vendored V3 state (`getCalendar`, `getWeather`, `getActiveEvents`, `WORLD_EVENTS`),
 * the 31-zone `CityPlan`, and real world `Hotspot` coordinates. Surfacing all six signature Riverside micro-activities
 * (Morning Run Club, Sunset Photography Overlooks, Fountain Plaza Acoustic Busking, Lantern Garden Tea Ritual,
 * Basketball 3-Point Streak Challenge, and Market Tue/Thu Flash Sale) plus live V3 world events for Journal, Map,
 * Minimap beacons, and non-repeating Feed announcements.
 *
 * Strictly zero V3 state mutation, zero network/AI calls, and 100% English-only copy.
 */
import * as V3 from '../v3/game-core/index.mjs';
import type { V3State } from '../v3/game-core/index.mjs';
import type { CityPlan } from '../city';
import { V3_ZONE_META, type V3ZoneId } from '../zones';
import type { Hotspot } from './hotspots';
import type { P } from './nav';

export type DailyActivityId =
  | 'micro_morning_run'
  | 'micro_sunset_photo'
  | 'micro_fountain_busking'
  | 'micro_lantern_tea'
  | 'micro_basketball_streak'
  | 'micro_market_sale'
  | 'micro_rainy_sanctuary'
  | 'micro_winter_hearth';

export type DailyActivityStatus = 'live' | 'upcoming' | 'weather_paused' | 'later';

export type SeasonIndex = 0 | 1 | 2 | 3;

export const SEASON_LABELS: readonly [string, string, string, string] = [
  'Spring',
  'Summer',
  'Autumn',
  'Winter',
];

const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export interface DailyEnvContext {
  /** Optional season override (0=Spring, 1=Summer, 2=Autumn, 3=Winter) from host atmosphere controls. */
  seasonIndex?: number | null;
  /** Optional rain flag override from host sky state (takes precedence over V3 weather). */
  rain?: boolean;
  /** Optional snow flag override from host sky state. */
  snow?: boolean;
  /** Optional weather label override from host sky state. */
  weatherLabel?: string | null;
  /** Optional shared-world clock minute override; defaults to `state.clock`. */
  minuteOverride?: number | null;
  /** Optional live basketball best streak from the current session. */
  bestBasketStreak?: number;
}

export interface DailyBeacon {
  id: string;
  label: string;
  zone: V3ZoneId;
  at: P;
  color: string;
  priority: number;
  kind: 'micro' | 'world_event';
}

export interface DailyMicroActivity {
  id: DailyActivityId;
  title: string;
  subtitle: string;
  category: 'Fitness' | 'Photography' | 'Music' | 'Mindfulness' | 'Sports' | 'Market' | 'Cozy';
  zone: V3ZoneId;
  zoneName: string;
  secondaryZones: V3ZoneId[];
  hotspotKey: string;
  at: P;
  status: DailyActivityStatus;
  statusNote: string;
  windowLabel: string;
  daysLabel: string;
  rewardSummary: string;
  tip: string;
  beaconColor: string;
  /** Linked V3 WORLD_EVENTS id when this activity coincides with a formal neighborhood gathering. */
  v3EventId: string | null;
  v3EventLive: boolean;
  attendedToday: boolean;
  discovered: boolean;
  /** Starts within the next 180 game minutes (null when live or not today). */
  minutesUntilStart: number | null;
  /** Minutes left in the active window (null when not live). */
  minutesRemaining: number | null;
  /** Crisp one-line announcement emitted once per day when the window opens. */
  announcement: string;
}

export interface DailyScheduleSnapshot {
  dayIndex: number;
  weekdayIndex: number;
  weekday: string;
  hour: number;
  minute: number;
  timeText: string;
  phase: string;
  seasonIndex: SeasonIndex;
  seasonName: string;
  weatherLabel: string;
  rain: boolean;
  snow: boolean;
  marketSaleLive: boolean;
  marketSaleNote: string;
  weatherSummary: string;
  weatherPicks: string[];
  activities: DailyMicroActivity[];
  liveActivities: DailyMicroActivity[];
  upcomingActivities: DailyMicroActivity[];
  beacons: DailyBeacon[];
}

interface OverlookSpot {
  zone: V3ZoneId;
  hotspotId: string;
  label: string;
  seasonCaption: readonly [string, string, string, string];
}

const SCENIC_OVERLOOKS: readonly OverlookSpot[] = [
  {
    zone: 'park',
    hotspotId: 'photo_spot_park',
    label: 'Riverside Park Overlook',
    seasonCaption: [
      'Spring blossoms framing the riverbank',
      'Summer sun glint across Riverside water',
      'Autumn amber foliage along the promenade',
      'Winter frost light over the river skyline',
    ],
  },
  {
    zone: 'greenway',
    hotspotId: 'greenway_overlook_cam',
    label: 'Greenway Milepost Overlook',
    seasonCaption: [
      'Fresh spring canopy over the cycling lane',
      'Warm evening breeze across the 220m Greenway',
      'Golden-hour shadows stretching down the towpath',
      'Crisp winter horizon over the eastern bend',
    ],
  },
  {
    zone: 'botanical',
    hotspotId: 'bot_cam',
    label: 'Botanical Pergola Viewpoint',
    seasonCaption: [
      'New herb blooms around the timber pergola',
      'Dappled sunlight in the Botanical Garden',
      'Warm russet leaves beside the planter troughs',
      'Quiet winter mist across the garden beds',
    ],
  },
  {
    zone: 'lantern_garden',
    hotspotId: 'lantern_cam',
    label: 'Hidden Lantern Pavilion Overlook',
    seasonCaption: [
      'Lantern reflections beside spring palms',
      'Twilight glow under the minka eaves',
      'Warm cedar and paper lanterns at dusk',
      'Serene winter twilight in the tea garden',
    ],
  },
];

function fmtHour(h: number): string {
  const whole = Math.floor(h);
  const mins = Math.round((h - whole) * 60);
  return `${String(whole).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function zoneLabel(zone: V3ZoneId): string {
  return V3_ZONE_META[zone]?.name.en ?? zone;
}

function resolvePoint(
  zone: V3ZoneId,
  hotspotId: string,
  city: CityPlan,
  hotspots: readonly Hotspot[],
): { at: P; hotspotKey: string } {
  const exact = hotspots.find(h => h.zone === zone && h.id === hotspotId);
  if (exact) return { at: { x: exact.stand.x, z: exact.stand.z }, hotspotKey: exact.key };
  const fallbackSpot = hotspots.find(h => h.zone === zone && h.kind === 'event')
    ?? hotspots.find(h => h.zone === zone);
  if (fallbackSpot) return { at: { x: fallbackSpot.stand.x, z: fallbackSpot.stand.z }, hotspotKey: fallbackSpot.key };
  const zoneDef = city.zones.find(z => z.id === zone);
  if (zoneDef) return { at: { x: zoneDef.waypoint.x, z: zoneDef.waypoint.z }, hotspotKey: `${zone}/${hotspotId}` };
  return { at: { x: 0, z: 0 }, hotspotKey: `${zone}/${hotspotId}` };
}

/**
 * Exact match for `EchoLifeGameService.java#marketSale` (Tue=1 & Thu=3, 10:00–15:00) so UI sale badges and
 * checkout previews agree 100% with authoritative server pricing.
 */
export function isMarketFlashSaleLive(clockMinutes: number): boolean {
  const minute = Math.max(0, Math.floor(clockMinutes));
  const weekday = Math.floor(minute / 1440) % 7;
  const hour = Math.floor((minute % 1440) / 60);
  return (weekday === 1 || weekday === 3) && hour >= 10 && hour < 15;
}

/**
 * Builds the deterministic schedule, status, and map/minimap beacons for all 6 daily/seasonal/weather
 * micro-activities plus active V3 neighborhood events.
 */
export function resolveDailyActivities(
  state: V3State,
  city: CityPlan,
  hotspots: readonly Hotspot[],
  env: DailyEnvContext = {},
): DailyScheduleSnapshot {
  const effectiveClock = env.minuteOverride != null && Number.isFinite(env.minuteOverride)
    ? Math.max(0, env.minuteOverride)
    : Math.max(0, state.clock);
  const cal = V3.getCalendar(effectiveClock);
  const dayIndex = cal.dayIndex;
  const weekdayIndex = ((dayIndex % 7) + 7) % 7;
  const weekday = WEEKDAY_NAMES[weekdayIndex] ?? cal.weekday;
  const hourFloat = cal.hour + cal.minute / 60;
  const timeText = `${String(cal.hour).padStart(2, '0')}:${String(cal.minute).padStart(2, '0')}`;

  const rawSeason = env.seasonIndex != null ? env.seasonIndex : Math.floor(dayIndex / 7) % 4;
  const seasonIndex = ((((rawSeason | 0) % 4) + 4) % 4) as SeasonIndex;
  const seasonName = SEASON_LABELS[seasonIndex];

  const baseWeather = V3.getWeather(state);
  const snow = env.snow !== undefined ? env.snow : (seasonIndex === 3 && baseWeather.rain);
  const rain = env.rain !== undefined ? env.rain : (!snow && baseWeather.rain);
  const weatherLabel = env.weatherLabel || (snow ? 'Snowy' : baseWeather.label);

  const activeV3Events = V3.getActiveEvents(state);
  const activeV3Ids = new Set(activeV3Events.map(e => e.id));
  const attendedSet = new Set(state.worldV3?.eventsAttended ?? []);
  const discoveredZones = new Set(state.worldV3?.exploration?.discoveredZones ?? ['study']);

  const marketSaleLive = isMarketFlashSaleLive(effectiveClock);
  const marketSaleNote = marketSaleLive
    ? '20% off all Sunrise Market groceries until 15:00'
    : weekdayIndex === 1 || weekdayIndex === 3
      ? (cal.hour < 10 ? 'Flash Sale opens today at 10:00 (20% off groceries)' : 'Today’s Flash Sale wrapped at 15:00 · Next sale Tue/Thu')
      : 'Runs every Tuesday and Thursday (10:00–15:00)';

  const evalWindow = (
    startHour: number,
    endHour: number,
    runsToday: boolean,
    blockedByWeather: boolean,
    weatherReason: string,
    daysNote: string,
  ): {
    status: DailyActivityStatus;
    statusNote: string;
    minutesUntilStart: number | null;
    minutesRemaining: number | null;
  } => {
    if (!runsToday) {
      return {
        status: 'later',
        statusNote: `Scheduled ${daysNote} (${fmtHour(startHour)}–${fmtHour(endHour)})`,
        minutesUntilStart: null,
        minutesRemaining: null,
      };
    }
    if (hourFloat >= startHour && hourFloat < endHour) {
      const rem = Math.max(1, Math.round((endHour - hourFloat) * 60));
      if (blockedByWeather) {
        return {
          status: 'weather_paused',
          statusNote: weatherReason,
          minutesUntilStart: null,
          minutesRemaining: rem,
        };
      }
      return {
        status: 'live',
        statusNote: `Live now · ${rem}m left (until ${fmtHour(endHour)})`,
        minutesUntilStart: null,
        minutesRemaining: rem,
      };
    }
    if (hourFloat < startHour) {
      const until = Math.max(1, Math.round((startHour - hourFloat) * 60));
      return {
        status: until <= 180 ? 'upcoming' : 'later',
        statusNote: until <= 60 ? `Starts in ${until}m (${fmtHour(startHour)})` : `Today at ${fmtHour(startHour)}–${fmtHour(endHour)}`,
        minutesUntilStart: until,
        minutesRemaining: null,
      };
    }
    return {
      status: 'later',
      statusNote: `Wrapped for today · Next window ${fmtHour(startHour)}–${fmtHour(endHour)}`,
      minutesUntilStart: null,
      minutesRemaining: null,
    };
  };

  // 1. Riverside Morning Run Club (Mon/Wed/Fri formal club 07:00–10:00 + daily sunrise jog 06:00–09:30)
  const isRunClubDay = weekdayIndex === 0 || weekdayIndex === 2 || weekdayIndex === 4;
  const runStart = isRunClubDay ? 7 : 6;
  const runEnd = isRunClubDay ? 10 : 9.5;
  const runV3Live = activeV3Ids.has('evt_morning_run_club') && !rain;
  const runEval = evalWindow(
    runStart,
    runEnd,
    true,
    rain,
    'Paused for rain — try stretching indoors or visit Willow Bistro for warm tea',
    'Mon / Wed / Fri',
  );
  const runLoc = resolvePoint('park', runV3Live ? 'event' : 'bench', city, hotspots);
  const morningRun: DailyMicroActivity = {
    id: 'micro_morning_run',
    title: isRunClubDay ? 'Riverside Morning Run Club' : 'Sunrise Riverfront Jog',
    subtitle: isRunClubDay
      ? 'Minh and Tuan Kiet lead a brisk group circuit at Riverside Park'
      : 'Crisp morning warm-up along Riverside Park and the Greenway',
    category: 'Fitness',
    zone: 'park',
    zoneName: zoneLabel('park'),
    secondaryZones: ['greenway'],
    hotspotKey: runLoc.hotspotKey,
    at: runLoc.at,
    status: runEval.status,
    statusNote: runEval.statusNote,
    windowLabel: `${fmtHour(runStart)}–${fmtHour(runEnd)}`,
    daysLabel: isRunClubDay ? 'Mon / Wed / Fri Club' : 'Daily Morning',
    rewardSummary: isRunClubDay ? '+35 CC, +32 Mobility XP, +16 Mood' : '+10 Mobility XP, +Fitness',
    tip: isRunClubDay
      ? 'Join the live event marker in Riverside Park or exercise at the riverside benches.'
      : 'Sprint along Riverside Park or use the slatted park benches for a morning workout.',
    beaconColor: '#14b8a6',
    v3EventId: 'evt_morning_run_club',
    v3EventLive: runV3Live,
    attendedToday: attendedSet.has(`evt_morning_run_club@day${dayIndex}`),
    discovered: discoveredZones.has('park'),
    minutesUntilStart: runEval.minutesUntilStart,
    minutesRemaining: runEval.minutesRemaining,
    announcement: isRunClubDay
      ? 'Live now: Riverside Morning Run Club at Riverside Park (until 10:00)!'
      : 'Sunrise jog window open along Riverside Park and Greenway.',
  };

  // 2. Sunset Photography and Scenic Overlooks (Daily Golden Hour 17:00–19:30, rotating featured overlook)
  const discoveredOverlooks = SCENIC_OVERLOOKS.filter(o => o.zone !== 'lantern_garden' || discoveredZones.has('lantern_garden'));
  const featuredOverlook = discoveredOverlooks[dayIndex % discoveredOverlooks.length] ?? SCENIC_OVERLOOKS[0];
  const photoLoc = resolvePoint(featuredOverlook.zone, featuredOverlook.hotspotId, city, hotspots);
  const photoEval = evalWindow(
    17,
    19.5,
    true,
    rain,
    'Heavy mist and rain — visit Riverside Atelier to browse your Photo Album indoors',
    'Daily Golden Hour',
  );
  const sunsetPhoto: DailyMicroActivity = {
    id: 'micro_sunset_photo',
    title: 'Sunset Photography and Scenic Overlooks',
    subtitle: `${featuredOverlook.label} · ${featuredOverlook.seasonCaption[seasonIndex]}`,
    category: 'Photography',
    zone: featuredOverlook.zone,
    zoneName: zoneLabel(featuredOverlook.zone),
    secondaryZones: SCENIC_OVERLOOKS.map(o => o.zone).filter(z => z !== featuredOverlook.zone),
    hotspotKey: photoLoc.hotspotKey,
    at: photoLoc.at,
    status: photoEval.status,
    statusNote: photoEval.statusNote,
    windowLabel: '17:00–19:30',
    daysLabel: `Daily · ${seasonName} Light`,
    rewardSummary: '+20 CC, +18 DIY XP, saved to Photo Album',
    tip: 'Interact with any scenic camera viewpoint in Riverside Park, Greenway, Botanical Garden, or Lantern Garden.',
    beaconColor: '#f59e0b',
    v3EventId: null,
    v3EventLive: false,
    attendedToday: (state.worldV3?.photos ?? []).some(ph => ph.day === dayIndex),
    discovered: discoveredZones.has(featuredOverlook.zone),
    minutesUntilStart: photoEval.minutesUntilStart,
    minutesRemaining: photoEval.minutesRemaining,
    announcement: `Golden Hour (${seasonName}): Scenic Sunset Photography at ${featuredOverlook.label}!`,
  };

  // 3. Fountain Plaza Acoustic Busking (Thu/Sat Open-Mic 17:00–22:00 + daily busking 16:00–21:00)
  const isOpenMicDay = weekdayIndex === 3 || weekdayIndex === 5;
  const buskStart = isOpenMicDay ? 17 : 16;
  const buskEnd = isOpenMicDay ? 22 : 21;
  const openMicLive = activeV3Ids.has('evt_open_mic_fountain') && !rain;
  const fountainDiscovered = discoveredZones.has('fountain_plaza');
  const buskZone: V3ZoneId = rain ? 'atelier' : 'fountain_plaza';
  const buskHotspotId = rain ? 'atelier_acoustic' : (openMicLive ? 'event' : 'plaza_stage');
  const buskLoc = resolvePoint(buskZone, buskHotspotId, city, hotspots);
  const buskEval = evalWindow(
    buskStart,
    buskEnd,
    true,
    false, // Rain moves acoustic jam smoothly inside Riverside Atelier!
    '',
    'Daily · Thu/Sat Open-Mic',
  );
  const fountainBusking: DailyMicroActivity = {
    id: 'micro_fountain_busking',
    title: isOpenMicDay && !rain ? 'Fountain Plaza Acoustic Open-Mic' : rain ? 'Rainy-Day Atelier Acoustic Jam' : 'Fountain Plaza Acoustic Busking',
    subtitle: rain
      ? 'Rain shifted guitars indoors — strum acoustic chords at Riverside Art and Music Atelier'
      : isOpenMicDay
        ? 'Hai Dang hosts twilight open-mic sets at Old Campus Fountain Court'
        : 'Step onto the Fountain Court stage for an afternoon acoustic guitar jam',
    category: 'Music',
    zone: buskZone,
    zoneName: zoneLabel(buskZone),
    secondaryZones: rain ? ['fountain_plaza'] : ['atelier'],
    hotspotKey: buskLoc.hotspotKey,
    at: buskLoc.at,
    status: buskEval.status,
    statusNote: rain && buskEval.status === 'live' ? 'Moved indoors (Rain) · Live at Riverside Atelier' : buskEval.statusNote,
    windowLabel: `${fmtHour(buskStart)}–${fmtHour(buskEnd)}`,
    daysLabel: isOpenMicDay ? 'Thu / Sat Open-Mic' : 'Daily Afternoon',
    rewardSummary: isOpenMicDay && !rain ? '+50 CC (Open-Mic) · +24 CC, +24 Social XP (Jam)' : '+24 CC, +24 Social XP, +6 Mood',
    tip: fountainDiscovered || rain
      ? 'Head to the stage or acoustic guitar stand to start a 4-chord rhythm jam.'
      : 'Explore east past University Green’s colonnade to discover Old Campus Fountain Court.',
    beaconColor: '#0ea5e9',
    v3EventId: 'evt_open_mic_fountain',
    v3EventLive: openMicLive,
    attendedToday: attendedSet.has(`evt_open_mic_fountain@day${dayIndex}`),
    discovered: fountainDiscovered || rain,
    minutesUntilStart: buskEval.minutesUntilStart,
    minutesRemaining: buskEval.minutesRemaining,
    announcement: isOpenMicDay && !rain
      ? 'Live now: Acoustic Open-Mic Night at Old Campus Fountain Court!'
      : rain
        ? 'Rainy-day acoustic jam open inside Riverside Art and Music Atelier.'
        : 'Hai Dang is warming up at Old Campus Fountain Court for evening busking!',
  };

  // 4. Lantern Garden Tea Ritual (Wed/Sun Twilight Gathering 18:00–23:00 + daily twilight tea 18:00–23:00)
  const isLanternEventDay = weekdayIndex === 2 || weekdayIndex === 6;
  const lanternLive = activeV3Ids.has('evt_lantern_twilight');
  const lanternDiscovered = discoveredZones.has('lantern_garden');
  const teaZone: V3ZoneId = lanternDiscovered ? 'lantern_garden' : 'bistro';
  const teaLoc = resolvePoint(
    teaZone,
    lanternDiscovered ? (lanternLive ? 'event' : 'tea_pavilion_table') : 'bistro_tea_table',
    city,
    hotspots,
  );
  const teaEval = evalWindow(18, 23, true, false, '', 'Daily Evening · Wed/Sun Gathering');
  const lanternTea: DailyMicroActivity = {
    id: 'micro_lantern_tea',
    title: isLanternEventDay ? 'Lantern Twilight Tea Gathering' : 'Lantern Garden Tea Ritual',
    subtitle: lanternDiscovered
      ? 'Steep moon-jasmine tea beneath glowing paper lanterns at the minka pavilion'
      : 'Follow the north path off Riverside Greenway to find the Hidden Lantern Tea Garden (or steep tea at Willow Bistro)',
    category: 'Mindfulness',
    zone: teaZone,
    zoneName: lanternDiscovered ? zoneLabel('lantern_garden') : `${zoneLabel('bistro')} (Tea Table)`,
    secondaryZones: lanternDiscovered ? ['bistro'] : ['lantern_garden'],
    hotspotKey: teaLoc.hotspotKey,
    at: teaLoc.at,
    status: teaEval.status,
    statusNote: teaEval.statusNote,
    windowLabel: '18:00–23:00',
    daysLabel: isLanternEventDay ? 'Wed / Sun Twilight Gathering' : 'Daily Twilight',
    rewardSummary: isLanternEventDay
      ? '+60 CC (Gathering) · +20 Mood, +18 Focus, +15 Energy, +1 Herbal Tea'
      : '+20 Mood, +18 Focus, +15 Energy, +1 Herbal Tea',
    tip: lanternDiscovered
      ? 'Use the Tea Pavilion Table in Hidden Lantern Tea Garden to restore Mood, Focus, and Energy.'
      : 'Ask Ngoc Bich at the Botanical Garden or follow Riverside Greenway north to unlock the hidden pavilion.',
    beaconColor: '#eab308',
    v3EventId: 'evt_lantern_twilight',
    v3EventLive: lanternLive,
    attendedToday: attendedSet.has(`evt_lantern_twilight@day${dayIndex}`),
    discovered: lanternDiscovered,
    minutesUntilStart: teaEval.minutesUntilStart,
    minutesRemaining: teaEval.minutesRemaining,
    announcement: isLanternEventDay
      ? 'Live now: Lantern Twilight Tea Gathering at Hidden Lantern Tea Garden!'
      : 'Twilight lanterns are lit — steep herbal tea to restore Mood and Focus.',
  };

  // 5. Basketball 3-Point Streak Challenge (Daily 07:00–21:00 dry + Sat 13:00–18:00 3v3 Pickup Showcase)
  const isPickupDay = weekdayIndex === 5;
  const pickupLive = activeV3Ids.has('evt_park_3v3_pickup') && !rain;
  const bballStart = isPickupDay && cal.hour >= 11 && cal.hour < 18 ? 13 : 7;
  const bballEnd = isPickupDay && cal.hour >= 11 && cal.hour < 18 ? 18 : 21;
  const bballEval = evalWindow(
    bballStart,
    bballEnd,
    true,
    rain,
    'Slick outdoor court during rain — shootaround resumes once skies clear',
    'Daily · Sat 3v3 Showcase',
  );
  const bballLoc = resolvePoint('park', pickupLive ? 'event' : 'hoop', city, hotspots);
  const bestStreak = Math.max(0, Math.floor(env.bestBasketStreak ?? 0));
  const basketballStreak: DailyMicroActivity = {
    id: 'micro_basketball_streak',
    title: pickupLive ? 'Riverside Park 3v3 Pickup and 3-Point Challenge' : 'Basketball 3-Point Streak Challenge',
    subtitle: bestStreak > 0
      ? `Step beyond the 4.7 m arc for 3-pointers · Session best streak: ${bestStreak}`
      : 'Step beyond the painted 4.7 m arc and sink 3 baskets in a row for a hot-streak bonus',
    category: 'Sports',
    zone: 'park',
    zoneName: zoneLabel('park'),
    secondaryZones: ['greenway'],
    hotspotKey: bballLoc.hotspotKey,
    at: bballLoc.at,
    status: bballEval.status,
    statusNote: bballEval.statusNote,
    windowLabel: pickupLive ? '13:00–18:00' : '07:00–21:00',
    daysLabel: isPickupDay ? 'Sat 3v3 Showcase' : 'Daily Court Open',
    rewardSummary: '+18 CC per basket (up to 5/day), +18 Mobility XP, +15 bonus XP on 3-streak',
    tip: 'Hold Space/button into the green sweet spot; press R to summon the ball or walk up to collect rebounds.',
    beaconColor: '#fb923c',
    v3EventId: 'evt_park_3v3_pickup',
    v3EventLive: pickupLive,
    attendedToday: attendedSet.has(`evt_park_3v3_pickup@day${dayIndex}`),
    discovered: discoveredZones.has('park'),
    minutesUntilStart: bballEval.minutesUntilStart,
    minutesRemaining: bballEval.minutesRemaining,
    announcement: isPickupDay
      ? 'Live now: Riverside Park 3v3 Pickup Showcase — test your 3-Point Streak!'
      : 'Riverside Park half-court is open for the 3-Point Streak Challenge.',
  };

  // 6. Market Tuesday/Thursday Flash Sale (Tue/Thu 10:00–15:00, all weather, server-validated 20% off)
  const isSaleDay = weekdayIndex === 1 || weekdayIndex === 3;
  const saleEval = evalWindow(10, 15, isSaleDay, false, '', 'Tue / Thu');
  const saleLoc = resolvePoint('market', marketSaleLive ? 'till' : 'shelf', city, hotspots);
  const marketSale: DailyMicroActivity = {
    id: 'micro_market_sale',
    title: 'Sunrise Market Flash Produce Sale',
    subtitle: 'Mai marks down fresh eggs, noodles, rice kits, paper, and jasmine tea by 20%',
    category: 'Market',
    zone: 'market',
    zoneName: zoneLabel('market'),
    secondaryZones: [],
    hotspotKey: saleLoc.hotspotKey,
    at: saleLoc.at,
    status: saleEval.status,
    statusNote: marketSaleLive ? saleEval.statusNote : marketSaleNote,
    windowLabel: '10:00–15:00',
    daysLabel: 'Tue / Thu',
    rewardSummary: '20% off all grocery baskets + 30 CC and +32 Business XP event bonus',
    tip: 'Pick kits from the Sunrise Market shelves and pay at the checkout counter before 15:00.',
    beaconColor: '#22c55e',
    v3EventId: 'evt_market_produce_sale',
    v3EventLive: marketSaleLive,
    attendedToday: attendedSet.has(`evt_market_produce_sale@day${dayIndex}`),
    discovered: discoveredZones.has('market'),
    minutesUntilStart: saleEval.minutesUntilStart,
    minutesRemaining: saleEval.minutesRemaining,
    announcement: 'Live now: Sunrise Market 20% Flash Produce Sale (10:00–15:00)!',
  };

  const activities: DailyMicroActivity[] = [
    marketSale,
    morningRun,
    basketballStreak,
    sunsetPhoto,
    fountainBusking,
    lanternTea,
  ];

  // Weather-exclusive micro-activities: surface dynamically ONLY during active rain or snow (never clutter sunny days).
  if (rain) {
    const rainyZone: V3ZoneId = cal.hour >= 9 && cal.hour < 18 ? 'library' : 'bistro';
    const rainyLoc = resolvePoint(rainyZone, rainyZone === 'library' ? 'lib_table_a' : 'bistro_counter', city, hotspots);
    activities.unshift({
      id: 'micro_rainy_sanctuary',
      title: 'Rainy Day Sanctuary: Study and Warm Drink',
      subtitle: 'Step out of the rain for quiet focus at University Library or a cozy rush shift at Willow Bistro',
      category: 'Cozy',
      zone: rainyZone,
      zoneName: zoneLabel(rainyZone),
      secondaryZones: rainyZone === 'library' ? ['bistro', 'cafe', 'atelier'] : ['library', 'cafe', 'atelier'],
      hotspotKey: rainyLoc.hotspotKey,
      at: rainyLoc.at,
      status: 'live',
      statusNote: 'Live while raining · Grants Rain-Cozy moodlet indoors',
      windowLabel: 'While Raining',
      daysLabel: 'Rainy Weather Exclusive',
      rewardSummary: 'Rain-Cozy buff (+6 Mood/hr and +6 Focus/hr) + cozy barista shift vibe',
      tip: 'Visit Willow Bistro, University Library, or Pixel Café indoors while rain falls to activate Rain-Cozy.',
      beaconColor: '#38bdf8',
      v3EventId: null,
      v3EventLive: false,
      attendedToday: false,
      discovered: true,
      minutesUntilStart: null,
      minutesRemaining: 60,
      announcement: 'Rainy Day Sanctuary is live — step inside Willow Bistro or University Library for the Rain-Cozy buff!',
    });
  } else if (snow) {
    const hearthZone: V3ZoneId = lanternDiscovered ? 'lantern_garden' : 'bistro';
    const hearthLoc = resolvePoint(hearthZone, lanternDiscovered ? 'tea_pavilion_table' : 'bistro_tea_table', city, hotspots);
    activities.unshift({
      id: 'micro_winter_hearth',
      title: 'Snowfall Photo and Hearth Tea',
      subtitle: 'Capture crisp winter overlooks along Riverside Park, then warm up with jasmine tea',
      category: 'Cozy',
      zone: hearthZone,
      zoneName: zoneLabel(hearthZone),
      secondaryZones: ['park', 'bistro', 'botanical'],
      hotspotKey: hearthLoc.hotspotKey,
      at: hearthLoc.at,
      status: 'live',
      statusNote: 'Live during snowfall · Warm tea restores extra Mood and Focus',
      windowLabel: 'During Snowfall',
      daysLabel: 'Winter Weather Exclusive',
      rewardSummary: 'Tea Calm buff + seasonal snowfall photography and hearth warmth',
      tip: 'Snap a snowy overlook photo in Riverside Park, then steep tea at Willow Bistro or Lantern Tea Garden.',
      beaconColor: '#7dd3fc',
      v3EventId: null,
      v3EventLive: false,
      attendedToday: false,
      discovered: true,
      minutesUntilStart: null,
      minutesRemaining: 60,
      announcement: 'Snowfall Photo and Hearth Tea is live — enjoy crisp snow views and warm jasmine tea!',
    });
  }

  const liveActivities = activities.filter(a => a.status === 'live');
  const upcomingActivities = activities
    .filter(a => a.status === 'upcoming')
    .sort((a, b) => (a.minutesUntilStart ?? 999) - (b.minutesUntilStart ?? 999));

  // Combine live micro-activity beacons with any other active V3 events (e.g., Pixel Rhythm Jam, Hardware Showcase, Artisan Market, Connection Festival)
  const beacons: DailyBeacon[] = [];
  const beaconZones = new Set<string>();

  for (const ev of activeV3Events) {
    const z = ev.zone as V3ZoneId;
    if (!(z in V3_ZONE_META)) continue;
    const loc = resolvePoint(z, 'event', city, hotspots);
    beacons.push({
      id: ev.id,
      label: ev.title.replace(/\s*&\s*/g, ' and '),
      zone: z,
      at: loc.at,
      color: '#14b8a6',
      priority: 2,
      kind: 'world_event',
    });
    beaconZones.add(z);
  }

  for (const act of liveActivities) {
    if (act.v3EventLive && act.v3EventId && beaconZones.has(act.zone)) continue;
    if (!act.discovered && act.zone === 'lantern_garden') continue;
    beacons.push({
      id: act.id,
      label: act.title,
      zone: act.zone,
      at: act.at,
      color: act.beaconColor,
      priority: act.id === 'micro_market_sale' ? 2 : 1,
      kind: 'micro',
    });
  }

  beacons.sort((a, b) => b.priority - a.priority);

  // Deterministic weather & seasonal summary
  let weatherSummary: string;
  let weatherPicks: string[];
  if (rain) {
    weatherSummary = `Rainy ${seasonName} day — cozy indoor venues and covered tea pavilions shine.`;
    weatherPicks = [
      'Deep Study or Archivist Shift at University Library',
      'Hot Matcha Crepe and Barista Shift at Willow Corner Bistro',
      'Indoor Acoustic Guitar Jam at Riverside Art and Music Atelier',
      'Rhythm Arcade and Tech Shift at Pixel Café',
    ];
  } else if (snow) {
    weatherSummary = `Snowy ${seasonName} skies — crisp river views and warm indoor hearths.`;
    weatherPicks = [
      'Winter Horizon Photography at Riverside Park and Greenway',
      'Steep Moon-Jasmine Tea at Willow Bistro or Lantern Tea Garden',
      'Cook a hot Riverside Feast in your home kitchen',
    ];
  } else if (cal.phase === 'evening' || cal.phase === 'night') {
    weatherSummary = `Clear ${seasonName} evening — lantern light, twilight music, and golden-hour views.`;
    weatherPicks = [
      'Acoustic Busking at Old Campus Fountain Court',
      'Lantern Twilight Tea Ritual for +Mood and +Focus',
      'Evening Rhythm Jam at Pixel Café',
    ];
  } else {
    weatherSummary = `${weatherLabel} ${seasonName} ${cal.phase} — ideal for outdoor sports, cycling, and riverside strolls.`;
    weatherPicks = [
      marketSaleLive ? '20% Flash Produce Sale at Sunrise Market (until 15:00)' : 'Fresh groceries and clerk shift at Sunrise Market',
      'Basketball 3-Point Streak Challenge at Riverside Park',
      'Cycling and Greenway Express deliveries along Riverside Greenway',
    ];
  }

  return {
    dayIndex,
    weekdayIndex,
    weekday,
    hour: cal.hour,
    minute: cal.minute,
    timeText,
    phase: cal.phase,
    seasonIndex,
    seasonName,
    weatherLabel,
    rain,
    snow,
    marketSaleLive,
    marketSaleNote,
    weatherSummary,
    weatherPicks,
    activities,
    liveActivities,
    upcomingActivities,
    beacons,
  };
}

/**
 * Computes non-repeating feed announcements for newly live timed events/micro-activities.
 * Mutates only the caller's `announced` set (never mutates V3 state).
 */
export function collectDailyAnnouncements(
  snapshot: DailyScheduleSnapshot,
  announced: Set<string>,
): string[] {
  const notices: string[] = [];
  for (const act of snapshot.liveActivities) {
    // Only proactively announce time-bounded / special windows (avoid noisy daily-all-day court banners)
    if (act.id === 'micro_basketball_streak' && !act.v3EventLive) continue;
    const key = `${act.id}@day${snapshot.dayIndex}`;
    if (announced.has(key)) continue;
    announced.add(key);
    notices.push(act.announcement);
    if (notices.length >= 2) break;
  }
  return notices;
}
