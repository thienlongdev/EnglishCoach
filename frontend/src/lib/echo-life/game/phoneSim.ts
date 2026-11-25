/**
 * Echo Life Wave 11 — Echo Phone Simulation, 22-Resident Messaging and Hangout Invites,
 * Campus Social Feed, Daily Schedule, Echo Bank Ledger, Photo Album Metadata,
 * Manage City Config, and Riverside Shuttle Bus Routes.
 *
 * Pure deterministic reducers with bounded serialization (`<= 12 KB` for `lifeMeta`).
 * Zero LLM calls, zero V3 edits, 100% clean English copy.
 */
import type { CityPlan } from '../city';
import type { V3ZoneId } from '../zones';
import type { ResidentId, ResidentMood } from './npcMind';
import type { FullTimeCareerId } from './careerSim';
import { getFullTimeCareer } from './careerSim';

export const MAX_PHONE_SAVE_BYTES = 12 * 1024;
export const MAX_BANK_LEDGER_ENTRIES = 25;
export const MAX_PHOTO_ALBUM_ENTRIES = 24;
export const MAX_FEED_POSTS = 24;
export const MAX_MESSAGES_PER_THREAD = 16;

// ── 1. 22-Resident Phone Directory ───────────────────────────────────────────────────────────────────────

export interface ResidentContact {
  readonly id: ResidentId;
  readonly name: string;
  readonly role: string;
  readonly tone: 'warm' | 'witty' | 'gentle' | 'energetic' | 'steady';
  readonly favoriteZone: V3ZoneId;
}

export const RESIDENT_CONTACTS: readonly ResidentContact[] = [
  { id: 'linh', name: 'Linh', role: 'Architecture Student and Organizer', tone: 'warm', favoriteZone: 'bistro' },
  { id: 'minh', name: 'Minh', role: 'Sports Science Junior and Court Captain', tone: 'energetic', favoriteZone: 'park' },
  { id: 'huy', name: 'Huy', role: 'Pixel Cafe Sound Technician', tone: 'witty', favoriteZone: 'cafe' },
  { id: 'mai', name: 'Mai', role: 'Sunrise Market Owner', tone: 'warm', favoriteZone: 'market' },
  { id: 'lan', name: 'Ms. Lan', role: 'Communications Lecturer', tone: 'gentle', favoriteZone: 'library' },
  { id: 'anchi', name: 'An Chi', role: 'Head Student Librarian', tone: 'gentle', favoriteZone: 'library' },
  { id: 'baolong', name: 'Bao Long', role: 'Volt and Silicon Founder', tone: 'energetic', favoriteZone: 'electronics_shop' },
  { id: 'khanhha', name: 'Khanh Ha', role: 'Willow Corner Bistro Barista', tone: 'warm', favoriteZone: 'bistro' },
  { id: 'ductri', name: 'Duc Tri', role: 'Master Mechanic at Tech and Fix', tone: 'steady', favoriteZone: 'repair_shop' },
  { id: 'diemmy', name: 'Diem My', role: 'Fine Arts Senior and Painter', tone: 'gentle', favoriteZone: 'atelier' },
  { id: 'haidang', name: 'Hai Dang', role: 'Indie Guitarist and Radio Host', tone: 'warm', favoriteZone: 'fountain_plaza' },
  { id: 'kimngan', name: 'Kim Ngan', role: 'Interior Designer at Riverside Living', tone: 'gentle', favoriteZone: 'furniture_shop' },
  { id: 'quocbao', name: 'Quoc Bao', role: 'Campus Security and Watchman', tone: 'steady', favoriteZone: 'street' },
  { id: 'thaovy', name: 'Thao Vy', role: 'First-Year Literature Student', tone: 'gentle', favoriteZone: 'library' },
  { id: 'duykhoa', name: 'Duy Khoa', role: 'Esports Strategist and Rival', tone: 'witty', favoriteZone: 'cafe' },
  { id: 'ngocbich', name: 'Ngoc Bich', role: 'Botanical Garden Caretaker', tone: 'gentle', favoriteZone: 'botanical' },
  { id: 'tuankiet', name: 'Tuan Kiet', role: 'Greenway Motors Lead', tone: 'energetic', favoriteZone: 'vehicle_dealer' },
  { id: 'phuonglien', name: 'Phuong Lien', role: 'Stylist at Thread and Campus Apparel', tone: 'warm', favoriteZone: 'clothing_shop' },
  { id: 'quangvinh', name: 'Quang Vinh', role: 'Property Advisor at Timber and Stone', tone: 'steady', favoriteZone: 'home_center' },
  { id: 'minhthu', name: 'Minh Thu', role: 'Campus Photojournalist', tone: 'energetic', favoriteZone: 'greenway' },
  { id: 'hoangphuc', name: 'Hoang Phuc', role: 'Student Council Treasurer', tone: 'steady', favoriteZone: 'campus' },
  { id: 'yennhi', name: 'Yen Nhi', role: 'Boardwalk Fair Coordinator', tone: 'energetic', favoriteZone: 'fair' },
] as const;

const CONTACT_BY_ID = new Map<string, ResidentContact>(RESIDENT_CONTACTS.map(c => [c.id, c]));

export function getResidentContact(npcId: string): ResidentContact | null {
  return CONTACT_BY_ID.get(npcId) ?? null;
}

// ── 2. Messages and Hangout Invites ──────────────────────────────────────────────────────────────────────

export interface PhoneMessage {
  id: string;
  sender: 'player' | ResidentId;
  text: string;
  day: number;
  clock: number;
  kind?: 'text' | 'invite' | 'reply';
}

export type HangoutVenue = 'bistro' | 'park' | 'home';

export interface HangoutMeetupPlan {
  id: string;
  npcId: ResidentId;
  npcName: string;
  venue: HangoutVenue;
  venueLabel: string;
  zoneId: V3ZoneId;
  targetPos: { x: number; y: number; z: number };
  scheduledDay: number;
  scheduledClock: number;
  expiresClock: number;
  status: 'accepted' | 'completed' | 'expired';
}

export interface ResidentReplyContext {
  friendship: number;
  npcZone?: string;
  npcMood?: ResidentMood | string;
  weatherLabel?: string;
  rain?: boolean;
  snow?: boolean;
  day: number;
  clock: number;
}

const HANGOUT_VENUES: Readonly<Record<HangoutVenue, { label: string; zoneId: V3ZoneId; pos: { x: number; y: number; z: number } }>> = {
  bistro: { label: 'Willow Corner Bistro', zoneId: 'bistro', pos: { x: 12.84, y: -3.2, z: 27.97 } },
  park: { label: 'Riverside Park', zoneId: 'park', pos: { x: -2.5, y: -3.2, z: -32.66 } },
  home: { label: 'Your Riverside Home', zoneId: 'living', pos: { x: 6.07, y: 0, z: -1.6 } },
};

function cleanUserText(raw: string, maxLen: number): string {
  return String(raw ?? '')
    .replace(/&/g, ' and ')
    .replace(/[<>]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function formatClock(clock: number): string {
  const mins = ((Math.floor(clock) % 1440) + 1440) % 1440;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function composeResidentReply(
  contact: ResidentContact,
  messageText: string,
  ctx: ResidentReplyContext,
): string {
  const lower = messageText.toLowerCase();
  const warmTier = ctx.friendship >= 50 ? 'close' : ctx.friendship >= 20 ? 'friendly' : 'new';
  const hour = Math.floor((((ctx.clock % 1440) + 1440) % 1440) / 60);
  const zonePhrase = ctx.npcZone ? `over near ${ctx.npcZone.replace(/_/g, ' ')}` : 'around Riverside';

  if (lower.includes('coffee') || lower.includes('tea') || lower.includes('bistro') || lower.includes('matcha')) {
    return warmTier === 'close'
      ? `Always up for a warm cup with you. I am ${zonePhrase} right now — save me a seat at Willow Bistro soon.`
      : `A fresh drink sounds lovely today. Catch me ${zonePhrase} whenever you stroll by.`;
  }
  if (lower.includes('rain') || lower.includes('snow') || lower.includes('weather')) {
    if (ctx.snow) {
      return `The snowfall across Lantern Street is magical today. Stay bundled up while you walk ${zonePhrase}.`;
    }
    if (ctx.rain) {
      return `Keeping dry ${zonePhrase} while this shower rolls through. Rainy days always make tea taste better.`;
    }
    return `Clear skies make walking around Riverside feel effortless today.`;
  }
  if (lower.includes('work') || lower.includes('shift') || lower.includes('study')) {
    return contact.tone === 'witty'
      ? `Grinding responsibly, respect. Swing by ${zonePhrase} if you need a quick break.`
      : `Cheering you on with your work today. Take a short breather whenever you pass ${zonePhrase}.`;
  }

  const moodTag = ctx.npcMood === 'tired'
    ? 'a little low on energy, taking things slow'
    : ctx.npcMood === 'excited' || ctx.npcMood === 'cheerful'
      ? 'in great spirits'
      : 'feeling steady';

  if (hour >= 21 || hour < 6) {
    return `Hey! Winding down ${zonePhrase} tonight, ${moodTag}. Let us catch up in the morning.`;
  }
  if (warmTier === 'close') {
    return `Always glad to hear from you! I am ${zonePhrase} and ${moodTag}. Drop by or send a meetup invite anytime.`;
  }
  if (contact.tone === 'witty') {
    return `Message received loud and clear. Hanging out ${zonePhrase}, ${moodTag}.`;
  }
  if (contact.tone === 'energetic') {
    return `Great timing! I am ${zonePhrase} and ${moodTag}. Let us keep the momentum going today.`;
  }
  return `Thanks for checking in! I am ${zonePhrase} right now and ${moodTag}. Hope your day is going smoothly.`;
}

// ── 3. Campus Social Feed ────────────────────────────────────────────────────────────────────────────────

export type FeedMilestoneTag =
  | 'weather_rain'
  | 'weather_snow'
  | 'weather_sunny'
  | 'festival'
  | 'shift_promotion'
  | 'basketball_streak'
  | 'new_home'
  | 'photo_upload'
  | 'cooking_feast'
  | 'daily_note';

export interface FeedComment {
  id: string;
  authorId: 'player' | ResidentId;
  authorName: string;
  text: string;
  day: number;
  clock: number;
}

export interface CampusFeedPost {
  id: string;
  authorId: 'player' | ResidentId;
  authorName: string;
  tag: FeedMilestoneTag;
  text: string;
  zone?: string;
  day: number;
  clock: number;
  likes: number;
  likedByPlayer: boolean;
  comments: FeedComment[];
}

export interface FeedGenerationContext {
  weather?: 'sunny' | 'rain' | 'snow';
  seasonIndex?: 0 | 1 | 2 | 3;
  festivalTitle?: string | null;
  recentMilestones?: readonly FeedMilestoneTag[];
  playerName?: string;
  clock?: number;
}

export function generateCampusFeedPosts(
  day: number,
  ctx: FeedGenerationContext = {},
): CampusFeedPost[] {
  const posts: CampusFeedPost[] = [];
  const clock = ctx.clock ?? 540;
  const pName = ctx.playerName || 'our newest Riverside neighbor';

  if (ctx.weather === 'snow') {
    posts.push({
      id: `post_snow_d${day}`,
      authorId: 'minhthu',
      authorName: 'Minh Thu',
      tag: 'weather_snow',
      text: 'Fresh powder along Lantern Street awnings this morning. Winter overcoats look incredible in this light.',
      zone: 'street',
      day,
      clock: Math.max(480, clock - 45),
      likes: 11 + (day % 7),
      likedByPlayer: false,
      comments: [],
    });
  } else if (ctx.weather === 'rain') {
    posts.push({
      id: `post_rain_d${day}`,
      authorId: 'khanhha',
      authorName: 'Khanh Ha',
      tag: 'weather_rain',
      text: 'Warm crepes and steaming Moon-Jasmine tea are ready inside Willow Corner Bistro while the shower passes.',
      zone: 'bistro',
      day,
      clock: Math.max(480, clock - 35),
      likes: 9 + (day % 6),
      likedByPlayer: false,
      comments: [],
    });
  } else {
    posts.push({
      id: `post_sun_d${day}`,
      authorId: 'minh',
      authorName: 'Minh',
      tag: 'weather_sunny',
      text: 'Crisp river breeze at Riverside Park court today. Open shootaround all afternoon for anyone passing by.',
      zone: 'park',
      day,
      clock: Math.max(480, clock - 50),
      likes: 8 + (day % 9),
      likedByPlayer: false,
      comments: [],
    });
  }

  if (ctx.festivalTitle) {
    posts.push({
      id: `post_fest_d${day}`,
      authorId: 'yennhi',
      authorName: 'Yen Nhi',
      tag: 'festival',
      text: `${cleanUserText(ctx.festivalTitle, 48)} lanterns are lit! Come browse student crafts and acoustic sets at Fountain Court.`,
      zone: 'fountain_plaza',
      day,
      clock: Math.max(540, clock - 20),
      likes: 16 + (day % 8),
      likedByPlayer: false,
      comments: [],
    });
  }

  for (const tag of ctx.recentMilestones ?? []) {
    if (tag === 'shift_promotion') {
      posts.push({
        id: `post_promo_d${day}`,
        authorId: 'linh',
        authorName: 'Linh',
        tag,
        text: `Huge congrats to ${pName} on earning a career promotion today. Hard work around Riverside never goes unnoticed!`,
        zone: 'campus',
        day,
        clock,
        likes: 14,
        likedByPlayer: false,
        comments: [],
      });
    } else if (tag === 'basketball_streak') {
      posts.push({
        id: `post_bball_d${day}`,
        authorId: 'minh',
        authorName: 'Minh',
        tag,
        text: `Just watched ${pName} drain a clean streak at Riverside Park hoop. Next weekend tournament is going to be electric.`,
        zone: 'park',
        day,
        clock,
        likes: 12,
        likedByPlayer: false,
        comments: [],
      });
    } else if (tag === 'new_home') {
      posts.push({
        id: `post_home_d${day}`,
        authorId: 'kimngan',
        authorName: 'Kim Ngan',
        tag,
        text: `Word along Market Boulevard says ${pName} just upgraded to a gorgeous new residence. Cannot wait to see the interior styling.`,
        zone: 'furniture_shop',
        day,
        clock,
        likes: 18,
        likedByPlayer: false,
        comments: [],
      });
    } else if (tag === 'photo_upload') {
      posts.push({
        id: `post_photo_d${day}`,
        authorId: 'diemmy',
        authorName: 'Diem My',
        tag,
        text: `Loved the golden framing in ${pName}'s latest Photo Studio shot. Drop by Riverside Atelier to print a wall copy!`,
        zone: 'atelier',
        day,
        clock,
        likes: 10,
        likedByPlayer: false,
        comments: [],
      });
    }
  }

  return posts;
}

// ── 4. Daily Schedule and Seasonal Festivals ─────────────────────────────────────────────────────────────

export interface SeasonalFestival {
  readonly seasonIndex: 0 | 1 | 2 | 3;
  readonly dayInSeason: number;
  readonly title: string;
  readonly zone: V3ZoneId;
  readonly startHour: number;
  readonly endHour: number;
  readonly description: string;
}

export const SEASONAL_FESTIVALS: readonly SeasonalFestival[] = [
  {
    seasonIndex: 0,
    dayInSeason: 5,
    title: 'Spring Blossom Fair',
    zone: 'botanical',
    startHour: 10,
    endHour: 20,
    description: 'Petal lanterns, herb workshops, and acoustic sets across Botanical Garden.',
  },
  {
    seasonIndex: 1,
    dayInSeason: 5,
    title: 'Summer River Regatta',
    zone: 'fair',
    startHour: 11,
    endHour: 21,
    description: 'Boardwalk games, iced matcha pop-ups, and twilight lantern boats on the river.',
  },
  {
    seasonIndex: 2,
    dayInSeason: 5,
    title: 'Autumn Lantern Festival',
    zone: 'fountain_plaza',
    startHour: 16,
    endHour: 23,
    description: 'Handcrafted paper lanterns, poetry readings, and student booths at Fountain Court.',
  },
  {
    seasonIndex: 3,
    dayInSeason: 5,
    title: 'Winter Cocoa Market',
    zone: 'street',
    startHour: 14,
    endHour: 22,
    description: 'Warm truffle ramen, winter scarf stalls, and snowlit carols along Lantern Street.',
  },
] as const;

export interface ScheduleEntry {
  readonly id: string;
  readonly kind: 'shift' | 'hangout' | 'festival';
  readonly title: string;
  readonly zone: V3ZoneId;
  readonly startClock: number;
  readonly endClock: number;
  readonly timeLabel: string;
  readonly note: string;
}

// ── 5. Echo Bank Financial Ledger ────────────────────────────────────────────────────────────────────────

export interface BankLedgerEntry {
  id: string;
  source: string;
  delta: number;
  balanceAfter: number;
  day: number;
  time: string;
}

export interface BankSummary {
  readonly currentBalance: number;
  readonly totalIncomeRecent: number;
  readonly totalExpenseRecent: number;
  readonly netCashflowRecent: number;
  readonly estimatedNetWorth: number;
  readonly entryCount: number;
}

// ── 6. Photo Album Metadata + Safe External Thumbnail Storage ────────────────────────────────────────────

export interface PhonePhotoMeta {
  id: string;
  title: string;
  zone: string;
  season: string;
  filter: string;
  timestamp: number;
  thumbKey: string;
}

const THUMB_KEY_PREFIX = 'ec_echo_life_photo_thumb:v1';

function safeStorageKey(accountKey: string, thumbKey: string): string {
  const acct = String(accountKey || 'local').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
  const tk = String(thumbKey || 'shot').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  return `${THUMB_KEY_PREFIX}:${acct}:${tk}`;
}

/** Saves bounded photo thumbnail data URL outside the server save JSON (per-account localStorage). */
export function savePhotoThumb(accountKey: string, thumbKey: string, dataUrlThumb: string): boolean {
  if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) return false;
  if (!dataUrlThumb.startsWith('data:image/') || dataUrlThumb.length > 90_000) return false;
  try {
    globalThis.localStorage.setItem(safeStorageKey(accountKey, thumbKey), dataUrlThumb);
    return true;
  } catch {
    return false;
  }
}

export function loadPhotoThumb(accountKey: string, thumbKey: string): string | null {
  if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) return null;
  try {
    return globalThis.localStorage.getItem(safeStorageKey(accountKey, thumbKey));
  } catch {
    return null;
  }
}

export function deletePhotoThumb(accountKey: string, thumbKey: string): void {
  if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) return;
  try {
    globalThis.localStorage.removeItem(safeStorageKey(accountKey, thumbKey));
  } catch {
    // Ignore storage quota or SSR errors
  }
}

// ── 7. Manage City Config ────────────────────────────────────────────────────────────────────────────────

export type BillboardTheme = 'academic' | 'spring' | 'neon' | 'eco';

export const BILLBOARD_THEMES: readonly BillboardTheme[] = [
  'academic',
  'spring',
  'neon',
  'eco',
] as const;

export interface ManageCityConfig {
  cleanliness: number;
  pedestrianDensity: number;
  trafficDensity: number;
  billboardHeadline: string;
  billboardTheme: BillboardTheme;
  cityKarma: number;
}

const DEFAULT_HEADLINE = 'Welcome to Riverside Campus';

export function sanitizeBillboardHeadline(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_HEADLINE;
  const cleaned = raw
    .replace(/&/g, ' and ')
    .replace(/<[^>]*>/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[`'"\\;]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return cleaned.length >= 2 ? cleaned : DEFAULT_HEADLINE;
}

export function defaultManageCityConfig(): ManageCityConfig {
  return {
    cleanliness: 84,
    pedestrianDensity: 1.0,
    trafficDensity: 0.9,
    billboardHeadline: DEFAULT_HEADLINE,
    billboardTheme: 'academic',
    cityKarma: 70,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function sanitizeManageCityConfig(raw: unknown): ManageCityConfig {
  const def = defaultManageCityConfig();
  if (!raw || typeof raw !== 'object') return def;
  const obj = raw as Record<string, unknown>;
  const num = (v: unknown, fb: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fb;
  const theme: BillboardTheme =
    typeof obj.billboardTheme === 'string' && BILLBOARD_THEMES.includes(obj.billboardTheme as BillboardTheme)
      ? (obj.billboardTheme as BillboardTheme)
      : def.billboardTheme;
  return {
    cleanliness: Math.round(num(obj.cleanliness, def.cleanliness, 0, 100)),
    pedestrianDensity: Math.round(num(obj.pedestrianDensity, def.pedestrianDensity, 0.3, 1.5) * 100) / 100,
    trafficDensity: Math.round(num(obj.trafficDensity, def.trafficDensity, 0.3, 1.5) * 100) / 100,
    billboardHeadline: sanitizeBillboardHeadline(obj.billboardHeadline),
    billboardTheme: theme,
    cityKarma: Math.round(num(obj.cityKarma, def.cityKarma, 0, 100)),
  };
}

// ── 8. Riverside Shuttle Bus Routes (6 Connected Stops) ──────────────────────────────────────────────────

export type BusStopId =
  | 'lantern_street'
  | 'riverside_park'
  | 'university_library'
  | 'market_boulevard'
  | 'botanical_garden'
  | 'fountain_plaza';

export interface BusStop {
  readonly id: BusStopId;
  readonly name: string;
  readonly district: string;
  readonly zone: V3ZoneId;
  readonly arrival: { readonly x: number; readonly y: number; readonly z: number };
  readonly yaw: number;
  readonly description: string;
}

export const SHUTTLE_STANDARD_FARE = 2;

/**
 * Canonical 6 Riverside Shuttle stops anchored on real walkable sidewalks and waypoints
 * for the default 6 m study room world (`city.ts` / `zone-waypoints.json`).
 */
export const BUS_STOPS: readonly BusStop[] = [
  {
    id: 'lantern_street',
    name: 'Lantern Street',
    district: 'Neighborhood',
    zone: 'street',
    arrival: { x: 7.24, y: -3.2, z: 14.96 },
    yaw: Math.PI,
    description: 'Home frontage shelter beside Willow Corner Bistro and Pixel Cafe.',
  },
  {
    id: 'riverside_park',
    name: 'Riverside Park',
    district: 'Parks and River',
    zone: 'park',
    arrival: { x: -2.5, y: -3.2, z: -32.66 },
    yaw: 0,
    description: 'Waterfront basketball court, badminton lawn, and shaded river benches.',
  },
  {
    id: 'university_library',
    name: 'University Library',
    district: 'Campus',
    zone: 'library',
    arrival: { x: 103.7, y: -3.2, z: 14.96 },
    yaw: Math.PI,
    description: 'Two-storey University Library promenade and University Green gate.',
  },
  {
    id: 'market_boulevard',
    name: 'Market Boulevard',
    district: 'Shopping Row',
    zone: 'street',
    arrival: { x: 5.84, y: -3.2, z: 57.96 },
    yaw: 0,
    description: 'Commercial Row avenue serving Thread Apparel, Motors, Homeworks, and Residences.',
  },
  {
    id: 'botanical_garden',
    name: 'Community Botanical Garden',
    district: 'Hidden Gems',
    zone: 'botanical',
    arrival: { x: -59.66, y: -3.2, z: -24.66 },
    yaw: 0,
    description: 'West riverfront herb pergola, moon-jasmine planters, and Riverside Atelier.',
  },
  {
    id: 'fountain_plaza',
    name: 'Old Campus Fountain Court',
    district: 'Hidden Gems',
    zone: 'fountain_plaza',
    arrival: { x: 127.2, y: -3.2, z: 10.26 },
    yaw: Math.PI,
    description: 'East campus festival stage, tiered fountain, and footpath to Lantern Tea Garden.',
  },
] as const;

const BUS_STOP_BY_ID = new Map<string, BusStop>(BUS_STOPS.map(s => [s.id, s]));

/** Dynamically aligns the 6 shuttle stops to any live CityPlan (room sizes 4 m to 9 m). */
export function resolveBusStops(city?: Pick<CityPlan, 'zones' | 'streets'> | null): BusStop[] {
  if (!city) return [...BUS_STOPS];
  const zoneMap = new Map(city.zones.map(z => [z.id, z]));
  const marketBlvd = city.streets.find(s => s.id === 'market_blvd');
  return BUS_STOPS.map(stop => {
    if (stop.id === 'market_boulevard' && marketBlvd) {
      return {
        ...stop,
        arrival: {
          x: Math.round(((marketBlvd.rect.x0 + marketBlvd.rect.x1) / 2) * 100) / 100,
          y: -3.2,
          z: Math.round((marketBlvd.rect.z0 + 1.5) * 100) / 100,
        },
      };
    }
    const z = zoneMap.get(stop.zone);
    if (!z) return stop;
    return {
      ...stop,
      arrival: {
        x: Math.round(z.waypoint.x * 100) / 100,
        y: -3.2,
        z: Math.round(z.waypoint.z * 100) / 100,
      },
    };
  });
}

export interface BusTripPlan {
  readonly ok: boolean;
  readonly reason: string;
  readonly from: BusStop | null;
  readonly to: BusStop | null;
  readonly fare: number;
  readonly transitMinutes: number;
  readonly distanceMeters: number;
  readonly arrival: { readonly x: number; readonly y: number; readonly z: number } | null;
}

export function planBusTrip(
  fromStopId: BusStopId,
  toStopId: BusStopId,
  credits: number,
  hasStudentPass = false,
  city?: Pick<CityPlan, 'zones' | 'streets'> | null,
): BusTripPlan {
  const stops = resolveBusStops(city);
  const from = stops.find(s => s.id === fromStopId) ?? BUS_STOP_BY_ID.get(fromStopId) ?? null;
  const to = stops.find(s => s.id === toStopId) ?? BUS_STOP_BY_ID.get(toStopId) ?? null;
  if (!from || !to) {
    return { ok: false, reason: 'Select valid origin and destination shuttle stops.', from, to, fare: 0, transitMinutes: 0, distanceMeters: 0, arrival: null };
  }
  if (from.id === to.id) {
    return { ok: false, reason: `You are already at ${to.name}.`, from, to, fare: 0, transitMinutes: 0, distanceMeters: 0, arrival: to.arrival };
  }
  const fare = hasStudentPass ? 0 : SHUTTLE_STANDARD_FARE;
  const safeCredits = Math.max(0, Math.floor(Number.isFinite(credits) ? credits : 0));
  if (safeCredits < fare) {
    return { ok: false, reason: `Need ${fare} CC for the Riverside Shuttle fare.`, from, to, fare, transitMinutes: 0, distanceMeters: 0, arrival: null };
  }
  const dist = Math.hypot(to.arrival.x - from.arrival.x, to.arrival.z - from.arrival.z);
  const transitMinutes = Math.round(clamp(3 + dist / 24, 4, 15));
  return {
    ok: true,
    reason: hasStudentPass
      ? `Boarded Riverside Shuttle to ${to.name} (Free with Student Pass, ${transitMinutes} min).`
      : `Boarded Riverside Shuttle to ${to.name} (-${fare} CC, ${transitMinutes} min).`,
    from,
    to,
    fare,
    transitMinutes,
    distanceMeters: Math.round(dist),
    arrival: to.arrival,
  };
}

// ── 9. Complete EchoPhoneState + Pure Reducers + Bounded Serialization (<= 12 KB) ────────────────────────

export interface EchoPhoneState {
  version: 1;
  threads: Partial<Record<ResidentId, PhoneMessage[]>>;
  meetups: HangoutMeetupPlan[];
  feed: CampusFeedPost[];
  ledger: BankLedgerEntry[];
  photos: PhonePhotoMeta[];
  cityConfig: ManageCityConfig;
  hasStudentPass: boolean;
  seq: number;
}

export function createInitialPhoneState(day = 0): EchoPhoneState {
  return {
    version: 1,
    threads: {
      linh: [
        {
          id: 'msg_welcome_linh',
          sender: 'linh',
          text: 'Welcome to Echo Phone! Message any Riverside neighbor or send a meetup invite whenever you want company.',
          day,
          clock: 480,
          kind: 'text',
        },
      ],
    },
    meetups: [],
    feed: generateCampusFeedPosts(day, { weather: 'sunny', clock: 540 }),
    ledger: [
      {
        id: 'led_start',
        source: 'Starter Student Balance',
        delta: 120,
        balanceAfter: 120,
        day,
        time: '08:00',
      },
    ],
    photos: [],
    cityConfig: defaultManageCityConfig(),
    hasStudentPass: false,
    seq: 10,
  };
}

export function sendResidentMessage(
  state: EchoPhoneState,
  npcId: ResidentId,
  rawText: string,
  ctx: ResidentReplyContext,
): { state: EchoPhoneState; reply: PhoneMessage | null; friendshipDelta: number } {
  const contact = getResidentContact(npcId);
  const text = cleanUserText(rawText, 140);
  if (!contact || !text) {
    return { state, reply: null, friendshipDelta: 0 };
  }
  const seq1 = state.seq + 1;
  const seq2 = state.seq + 2;
  const playerMsg: PhoneMessage = {
    id: `m_${seq1}`,
    sender: 'player',
    text,
    day: ctx.day,
    clock: Math.floor(ctx.clock),
    kind: 'text',
  };
  const replyMsg: PhoneMessage = {
    id: `m_${seq2}`,
    sender: npcId,
    text: composeResidentReply(contact, text, ctx),
    day: ctx.day,
    clock: Math.floor(ctx.clock) + 1,
    kind: 'reply',
  };
  const prev = state.threads[npcId] ?? [];
  const nextThread = [...prev, playerMsg, replyMsg].slice(-MAX_MESSAGES_PER_THREAD);
  return {
    state: {
      ...state,
      seq: seq2,
      threads: { ...state.threads, [npcId]: nextThread },
    },
    reply: replyMsg,
    friendshipDelta: 2,
  };
}

export function sendHangoutInvite(
  state: EchoPhoneState,
  npcId: ResidentId,
  venue: HangoutVenue,
  ctx: ResidentReplyContext,
): {
  state: EchoPhoneState;
  accepted: boolean;
  meetupPlan: HangoutMeetupPlan | null;
  replyText: string;
} {
  const contact = getResidentContact(npcId);
  const vInfo = HANGOUT_VENUES[venue];
  if (!contact || !vInfo) {
    return { state, accepted: false, meetupPlan: null, replyText: 'Resident or venue could not be reached.' };
  }
  const hour = Math.floor((((ctx.clock % 1440) + 1440) % 1440) / 60);
  const minFriend = venue === 'home' ? 20 : 0;
  const tooLate = hour >= 22 || hour < 7;
  const accepted = !tooLate && ctx.friendship >= minFriend;

  const inviteText = `Want to meet at ${vInfo.label} soon?`;
  const replyText = tooLate
    ? `It is getting quite late on Riverside Lane. Let us meet at ${vInfo.label} tomorrow morning instead.`
    : !accepted
      ? `That sounds thoughtful! Let us chat around town a bit more first before visiting your home.`
      : `Count me in! I will head over to ${vInfo.label} and meet you there shortly.`;

  const seq1 = state.seq + 1;
  const seq2 = state.seq + 2;
  const prev = state.threads[npcId] ?? [];
  const nextThread = [
    ...prev,
    { id: `m_${seq1}`, sender: 'player' as const, text: inviteText, day: ctx.day, clock: Math.floor(ctx.clock), kind: 'invite' as const },
    { id: `m_${seq2}`, sender: npcId, text: replyText, day: ctx.day, clock: Math.floor(ctx.clock) + 1, kind: 'reply' as const },
  ].slice(-MAX_MESSAGES_PER_THREAD);

  let meetupPlan: HangoutMeetupPlan | null = null;
  let nextMeetups = state.meetups;
  if (accepted) {
    meetupPlan = {
      id: `meet_${seq2}`,
      npcId,
      npcName: contact.name,
      venue,
      venueLabel: vInfo.label,
      zoneId: vInfo.zoneId,
      targetPos: { ...vInfo.pos },
      scheduledDay: ctx.day,
      scheduledClock: Math.floor(ctx.clock) + 15,
      expiresClock: Math.floor(ctx.clock) + 150,
      status: 'accepted',
    };
    nextMeetups = [...state.meetups.filter(m => m.npcId !== npcId || m.status !== 'accepted'), meetupPlan].slice(-8);
  }

  return {
    state: {
      ...state,
      seq: seq2,
      threads: { ...state.threads, [npcId]: nextThread },
      meetups: nextMeetups,
    },
    accepted,
    meetupPlan,
    replyText,
  };
}

export function addFeedPosts(state: EchoPhoneState, posts: readonly CampusFeedPost[]): EchoPhoneState {
  const existingIds = new Set(state.feed.map(p => p.id));
  const fresh = posts.filter(p => !existingIds.has(p.id));
  if (fresh.length === 0) return state;
  return {
    ...state,
    feed: [...fresh, ...state.feed].slice(0, MAX_FEED_POSTS),
  };
}

export function createPlayerFeedPost(
  state: EchoPhoneState,
  caption: string,
  tag: FeedMilestoneTag,
  day: number,
  clock: number,
  playerName = 'You',
  zone?: string,
): { state: EchoPhoneState; post: CampusFeedPost | null; recognitionDelta: number } {
  const clean = cleanUserText(caption, 160);
  if (!clean) return { state, post: null, recognitionDelta: 0 };
  const seq1 = state.seq + 1;
  const supporter = RESIDENT_CONTACTS[hashStr(`${day}:${clean}`) % RESIDENT_CONTACTS.length];
  const cheerLine =
    tag === 'photo_upload' ? 'Incredible lighting and framing! Riverside looks peaceful here.'
    : tag === 'shift_promotion' ? 'Well earned! Let us celebrate with matcha crepes soon.'
    : tag === 'cooking_feast' ? 'Save a recipe tip for the rest of us — looks delicious!'
    : 'Love seeing updates from around the neighborhood today.';

  const post: CampusFeedPost = {
    id: `post_p_${seq1}`,
    authorId: 'player',
    authorName: cleanUserText(playerName, 28) || 'You',
    tag,
    text: clean,
    zone,
    day,
    clock: Math.floor(clock),
    likes: 3 + (seq1 % 5),
    likedByPlayer: true,
    comments: [
      {
        id: `c_${seq1}`,
        authorId: supporter.id,
        authorName: supporter.name,
        text: cheerLine,
        day,
        clock: Math.floor(clock) + 4,
      },
    ],
  };

  return {
    state: {
      ...state,
      seq: seq1,
      feed: [post, ...state.feed].slice(0, MAX_FEED_POSTS),
    },
    post,
    recognitionDelta: 4,
  };
}

export function likeFeedPost(
  state: EchoPhoneState,
  postId: string,
): { state: EchoPhoneState; liked: boolean; friendshipDelta: number; recognitionDelta: number; authorNpcId: ResidentId | null } {
  let liked = false;
  let authorNpcId: ResidentId | null = null;
  const nextFeed = state.feed.map(post => {
    if (post.id !== postId) return post;
    liked = !post.likedByPlayer;
    if (post.authorId !== 'player') authorNpcId = post.authorId;
    return {
      ...post,
      likedByPlayer: liked,
      likes: Math.max(0, post.likes + (liked ? 1 : -1)),
    };
  });
  return {
    state: { ...state, feed: nextFeed },
    liked,
    friendshipDelta: liked && authorNpcId ? 2 : 0,
    recognitionDelta: liked ? 1 : 0,
    authorNpcId,
  };
}

export function replyToFeedPost(
  state: EchoPhoneState,
  postId: string,
  replyText: string,
  day: number,
  clock: number,
  playerName = 'You',
): { state: EchoPhoneState; ok: boolean; friendshipDelta: number; recognitionDelta: number; authorNpcId: ResidentId | null } {
  const clean = cleanUserText(replyText, 120);
  if (!clean) return { state, ok: false, friendshipDelta: 0, recognitionDelta: 0, authorNpcId: null };
  let found = false;
  let authorNpcId: ResidentId | null = null;
  const seq1 = state.seq + 1;
  const seq2 = state.seq + 2;

  const nextFeed = state.feed.map(post => {
    if (post.id !== postId) return post;
    found = true;
    if (post.authorId !== 'player') authorNpcId = post.authorId;
    const playerComment: FeedComment = {
      id: `c_${seq1}`,
      authorId: 'player',
      authorName: cleanUserText(playerName, 28) || 'You',
      text: clean,
      day,
      clock: Math.floor(clock),
    };
    const comments = [...post.comments, playerComment];
    if (post.authorId !== 'player') {
      comments.push({
        id: `c_${seq2}`,
        authorId: post.authorId,
        authorName: post.authorName,
        text: 'Appreciate the kind note! See you around Riverside soon.',
        day,
        clock: Math.floor(clock) + 2,
      });
    }
    return { ...post, comments: comments.slice(-6) };
  });

  if (!found) return { state, ok: false, friendshipDelta: 0, recognitionDelta: 0, authorNpcId: null };
  return {
    state: { ...state, seq: seq2, feed: nextFeed },
    ok: true,
    friendshipDelta: authorNpcId ? 4 : 0,
    recognitionDelta: 2,
    authorNpcId,
  };
}

export function getDailySchedule(
  state: EchoPhoneState,
  day: number,
  options: {
    seasonIndex?: 0 | 1 | 2 | 3;
    weekdayIndex?: number;
    fullTimeCareerId?: FullTimeCareerId | null;
  } = {},
): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];
  const weekdayIndex = options.weekdayIndex ?? (day % 7);
  const seasonIndex = (options.seasonIndex ?? (Math.floor(day / 7) % 4)) as 0 | 1 | 2 | 3;

  // Full-time career shift if scheduled today
  const career = getFullTimeCareer(options.fullTimeCareerId);
  if (career && career.workDays.includes(weekdayIndex)) {
    entries.push({
      id: `sch_career_d${day}`,
      kind: 'shift',
      title: `${career.title} Workday`,
      zone: career.workZones[0],
      startClock: career.startHour * 60,
      endClock: career.endHour * 60,
      timeLabel: `${String(career.startHour).padStart(2, '0')}:00 to ${String(career.endHour).padStart(2, '0')}:00`,
      note: career.scheduleLabel,
    });
  }

  // Accepted hangouts for today
  for (const m of state.meetups) {
    if (m.status !== 'accepted' || m.scheduledDay !== day) continue;
    entries.push({
      id: `sch_${m.id}`,
      kind: 'hangout',
      title: `Meet ${m.npcName} at ${m.venueLabel}`,
      zone: m.zoneId,
      startClock: m.scheduledClock % 1440,
      endClock: m.expiresClock % 1440,
      timeLabel: formatClock(m.scheduledClock),
      note: `Confirmed meetup with ${m.npcName}.`,
    });
  }

  // Seasonal festival calendar
  const dayInSeason = day % 7;
  const fest = SEASONAL_FESTIVALS.find(f => f.seasonIndex === seasonIndex && f.dayInSeason === dayInSeason);
  if (fest) {
    entries.push({
      id: `sch_fest_${seasonIndex}_d${day}`,
      kind: 'festival',
      title: fest.title,
      zone: fest.zone,
      startClock: fest.startHour * 60,
      endClock: fest.endHour * 60,
      timeLabel: `${String(fest.startHour).padStart(2, '0')}:00 to ${String(fest.endHour).padStart(2, '0')}:00`,
      note: fest.description,
    });
  }

  return entries.sort((a, b) => a.startClock - b.startClock);
}

export function recordBankTransaction(
  state: EchoPhoneState,
  entry: { source: string; delta: number; balanceAfter: number; day: number; clock: number },
): EchoPhoneState {
  const seq = state.seq + 1;
  const cleanEntry: BankLedgerEntry = {
    id: `led_${seq}`,
    source: cleanUserText(entry.source, 48) || 'Campus Transaction',
    delta: Math.round(Number.isFinite(entry.delta) ? entry.delta : 0),
    balanceAfter: Math.max(0, Math.round(Number.isFinite(entry.balanceAfter) ? entry.balanceAfter : 0)),
    day: Math.max(0, Math.floor(entry.day)),
    time: formatClock(entry.clock),
  };
  return {
    ...state,
    seq,
    ledger: [...state.ledger, cleanEntry].slice(-MAX_BANK_LEDGER_ENTRIES),
  };
}

export function getBankSummary(
  state: EchoPhoneState,
  currentBalance: number,
  ownedAssetValue = 0,
): BankSummary {
  let income = 0;
  let expense = 0;
  for (const e of state.ledger) {
    if (e.delta >= 0) income += e.delta;
    else expense += Math.abs(e.delta);
  }
  const safeBal = Math.max(0, Math.round(Number.isFinite(currentBalance) ? currentBalance : 0));
  const safeAssets = Math.max(0, Math.round(Number.isFinite(ownedAssetValue) ? ownedAssetValue : 0));
  return {
    currentBalance: safeBal,
    totalIncomeRecent: income,
    totalExpenseRecent: expense,
    netCashflowRecent: income - expense,
    estimatedNetWorth: safeBal + safeAssets,
    entryCount: state.ledger.length,
  };
}

export function addPhotoToAlbum(
  state: EchoPhoneState,
  meta: Omit<PhonePhotoMeta, 'id' | 'thumbKey'>,
  options: { dataUrlThumb?: string; accountKey?: string } = {},
): { state: EchoPhoneState; photo: PhonePhotoMeta; thumbSaved: boolean } {
  const seq = state.seq + 1;
  const id = `photo_${seq}`;
  const thumbKey = `thumb_${seq}`;
  const photo: PhonePhotoMeta = {
    id,
    title: cleanUserText(meta.title, 48) || 'Riverside Snapshot',
    zone: cleanUserText(meta.zone, 24) || 'street',
    season: cleanUserText(meta.season, 16) || 'Spring',
    filter: cleanUserText(meta.filter, 20) || 'Natural',
    timestamp: Math.max(0, Math.floor(Number.isFinite(meta.timestamp) ? meta.timestamp : Date.now())),
    thumbKey,
  };
  const thumbSaved = options.dataUrlThumb && options.accountKey
    ? savePhotoThumb(options.accountKey, thumbKey, options.dataUrlThumb)
    : false;
  const nextPhotos = [photo, ...state.photos];
  if (nextPhotos.length > MAX_PHOTO_ALBUM_ENTRIES && options.accountKey) {
    const evicted = nextPhotos.slice(MAX_PHOTO_ALBUM_ENTRIES);
    for (const old of evicted) deletePhotoThumb(options.accountKey, old.thumbKey);
  }
  return {
    state: {
      ...state,
      seq,
      photos: nextPhotos.slice(0, MAX_PHOTO_ALBUM_ENTRIES),
    },
    photo,
    thumbSaved,
  };
}

export function updateManageCityConfig(
  state: EchoPhoneState,
  patch: Partial<ManageCityConfig>,
): EchoPhoneState {
  return {
    ...state,
    cityConfig: sanitizeManageCityConfig({ ...state.cityConfig, ...patch }),
  };
}

/**
 * Produces a strictly bounded JSON-serializable snapshot guaranteed to stay `<= 12 KB`
 * so `lifeMeta` persists cleanly without ever bloating server saves.
 */
export function serializePhoneState(state: EchoPhoneState): EchoPhoneState {
  const out: EchoPhoneState = {
    version: 1,
    threads: {},
    meetups: state.meetups.slice(-6),
    feed: state.feed.slice(0, 16).map(p => ({ ...p, comments: p.comments.slice(-4) })),
    ledger: state.ledger.slice(-MAX_BANK_LEDGER_ENTRIES),
    photos: state.photos.slice(0, MAX_PHOTO_ALBUM_ENTRIES),
    cityConfig: sanitizeManageCityConfig(state.cityConfig),
    hasStudentPass: Boolean(state.hasStudentPass),
    seq: Math.max(0, Math.floor(Number.isFinite(state.seq) ? state.seq : 0)),
  };

  for (const [k, msgs] of Object.entries(state.threads)) {
    if (!CONTACT_BY_ID.has(k) || !Array.isArray(msgs) || msgs.length === 0) continue;
    out.threads[k as ResidentId] = msgs.slice(-8);
  }

  // Progressive trimming guarantee if a heavy session ever exceeds 12 KB
  const byteSize = (obj: unknown) => JSON.stringify(obj).length;
  if (byteSize(out) > MAX_PHONE_SAVE_BYTES) {
    out.feed = out.feed.slice(0, 8).map(p => ({ ...p, comments: p.comments.slice(-2) }));
  }
  if (byteSize(out) > MAX_PHONE_SAVE_BYTES) {
    for (const k of Object.keys(out.threads) as ResidentId[]) {
      const list = out.threads[k];
      if (list) out.threads[k] = list.slice(-3);
    }
  }
  if (byteSize(out) > MAX_PHONE_SAVE_BYTES) {
    out.ledger = out.ledger.slice(-12);
    out.photos = out.photos.slice(0, 12);
  }
  if (byteSize(out) > MAX_PHONE_SAVE_BYTES) {
    const keys = Object.keys(out.threads) as ResidentId[];
    for (const k of keys.slice(6)) delete out.threads[k];
  }
  return out;
}

export function deserializePhoneState(raw: unknown, day = 0): EchoPhoneState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return createInitialPhoneState(day);
  }
  const obj = raw as Record<string, unknown>;
  const base = createInitialPhoneState(day);
  const threads: Partial<Record<ResidentId, PhoneMessage[]>> = {};
  if (obj.threads && typeof obj.threads === 'object' && !Array.isArray(obj.threads)) {
    for (const [k, v] of Object.entries(obj.threads as Record<string, unknown>)) {
      if (!CONTACT_BY_ID.has(k) || !Array.isArray(v)) continue;
      const clean = v
        .filter((m): m is PhoneMessage => Boolean(m && typeof m === 'object' && typeof (m as PhoneMessage).text === 'string'))
        .slice(-MAX_MESSAGES_PER_THREAD);
      if (clean.length > 0) threads[k as ResidentId] = clean;
    }
  }

  return serializePhoneState({
    version: 1,
    threads: Object.keys(threads).length > 0 ? threads : base.threads,
    meetups: Array.isArray(obj.meetups) ? (obj.meetups as HangoutMeetupPlan[]).slice(-8) : base.meetups,
    feed: Array.isArray(obj.feed) ? (obj.feed as CampusFeedPost[]).slice(0, MAX_FEED_POSTS) : base.feed,
    ledger: Array.isArray(obj.ledger) ? (obj.ledger as BankLedgerEntry[]).slice(-MAX_BANK_LEDGER_ENTRIES) : base.ledger,
    photos: Array.isArray(obj.photos) ? (obj.photos as PhonePhotoMeta[]).slice(0, MAX_PHOTO_ALBUM_ENTRIES) : base.photos,
    cityConfig: sanitizeManageCityConfig(obj.cityConfig),
    hasStudentPass: Boolean(obj.hasStudentPass),
    seq: typeof obj.seq === 'number' && Number.isFinite(obj.seq) ? Math.max(0, Math.floor(obj.seq)) : base.seq,
  });
}
