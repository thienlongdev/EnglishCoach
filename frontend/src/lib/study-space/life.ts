import { GrimeField, settleDust, type GrimeRecord } from './grime';
import { CATALOG_BY_ID } from './catalog';
import type { Layout, SpaceObject } from './types';

/**
 * A room going on living between visits, kept with the room: what has settled on its surfaces, where crumbs and cobwebs are, which stories it has been through.
 * All of it is worked out once, when the room is opened, from how long it was left: nothing runs on any server, and no number of days away can make a room
 * worse than a room that was simply left for a fortnight. Learning is never behind any of this.
 */
export type CareMode = 'natural' | 'relaxed' | 'off';
export interface Crumb { x: number; z: number; kind: 0 | 1 | 2; r: number }
export interface Web { id: string; x: number; y: number; z: number; ry: number; size: number; k: number; on?: string }
export interface LifeSettings { care: CareMode; stories: boolean; words: boolean; weather: boolean; weatherSound?: boolean }
export type RoomLifeSettings = LifeSettings;
export interface StoryMemory { id: string; beat: number; at: number }
export interface RoomLife {
  v: 1;
  /** Last time time was allowed to pass in it. */
  at: number;
  settings: LifeSettings;
  floor?: GrimeRecord;
  tops?: Record<string, GrimeRecord>;
  crumbs: Crumb[];
  webs: Web[];
  /** The room's own seed: its weather, the look of its dust. */
  seed: string;
  /** Story in progress, ones told (id → when) and one-time remarks already made. */
  story?: StoryMemory | null;
  told: Record<string, number>;
  said: string[];
  /** What has been done with it, last first: how the room remembers. Short, and no text of the learner's. */
  log: { what: string; at: number }[];
  /** Air moving in the room right now is not stored: only whether anybody has ever been told how the tools work. */
  visits?: number;
  lastVisit?: number;
}
export const DEFAULT_SETTINGS: LifeSettings = { care: 'natural', stories: true, words: true, weather: true, weatherSound: false };
export const FLOOR_CELLS = 64;
const RATE: Record<CareMode, { perDay: number; cap: number; webEvery: number; webMax: number; crumbsPerDay: number; crumbMax: number }> = {
  natural: { perDay: .04, cap: .3, webEvery: 4.5, webMax: 4, crumbsPerDay: 2.2, crumbMax: 20 },
  relaxed: { perDay: .016, cap: .12, webEvery: 11, webMax: 2, crumbsPerDay: .7, crumbMax: 8 },
  off: { perDay: 0, cap: 0, webEvery: Infinity, webMax: 0, crumbsPerDay: 0, crumbMax: 0 },
};
const DAY = 86_400_000;

export function freshLife(seed: string, now: number): RoomLife {
  return { v: 1, at: now, settings: { ...DEFAULT_SETTINGS }, crumbs: [], webs: [], seed, told: {}, said: [], log: [] };
}
const num = (v: unknown, d: number, a: number, b: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d);
function readGrime(v: unknown): GrimeRecord | undefined {
  const r = v as GrimeRecord | undefined;
  if (!r || !Array.isArray(r.n) || typeof r.d !== 'string' || typeof r.s !== 'string' || typeof r.w !== 'string') return undefined;
  if (r.d.length > 9000 || r.s.length > 9000 || r.w.length > 9000) return undefined;
  return { n: [num(r.n[0], 0, 0, 256), num(r.n[1], 0, 0, 256)], d: r.d, s: r.s, w: r.w };
}
/** Reads stored JSON: whatever is odd falls back, a room is never lost to its dust. */
export function readLife(raw: unknown): RoomLife | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>, s = (v.settings ?? {}) as Record<string, unknown>;
  const crumbs = Array.isArray(v.crumbs) ? v.crumbs.slice(0, 60).flatMap((c): Crumb[] => { const q = c as Crumb; return q && typeof q.x === 'number' && typeof q.z === 'number' ? [{ x: num(q.x, 0, -20, 20), z: num(q.z, 0, -20, 20), kind: q.kind === 1 || q.kind === 2 ? q.kind : 0, r: num(q.r, 0, -10, 10) }] : []; }) : [];
  const webs = Array.isArray(v.webs) ? v.webs.slice(0, 8).flatMap((c): Web[] => { const q = c as Web; return q && typeof q.id === 'string' && typeof q.x === 'number' ? [{ id: q.id.slice(0, 40), x: num(q.x, 0, -20, 20), y: num(q.y, 2, 0, 6), z: num(q.z, 0, -20, 20), ry: num(q.ry, 0, -10, 10), size: num(q.size, .4, .1, 1), k: num(q.k, 1, 0, 1), ...(typeof q.on === 'string' ? { on: q.on.slice(0, 40) } : {}) }] : []; }) : [];
  const tops: Record<string, GrimeRecord> = {};
  if (v.tops && typeof v.tops === 'object') for (const [k, t] of Object.entries(v.tops as Record<string, unknown>).slice(0, 32)) { const g = readGrime(t); if (g) tops[k.slice(0, 48)] = g; }
  const told: Record<string, number> = {};
  if (v.told && typeof v.told === 'object') for (const [k, t] of Object.entries(v.told as Record<string, unknown>).slice(0, 32)) if (typeof t === 'number') told[k.slice(0, 40)] = t;
  const story = v.story as StoryMemory | null | undefined;
  return {
    v: 1, at: num(v.at, Date.now(), 0, 9e15), seed: typeof v.seed === 'string' ? v.seed.slice(0, 40) : 'room',
    settings: { care: s.care === 'relaxed' || s.care === 'off' ? s.care : 'natural', stories: s.stories !== false, words: s.words !== false, weather: s.weather !== false, weatherSound: s.weatherSound === true },
    ...(readGrime(v.floor) ? { floor: readGrime(v.floor) } : {}),
    ...(Object.keys(tops).length ? { tops } : {}),
    crumbs, webs, told,
    said: Array.isArray(v.said) ? v.said.filter((x): x is string => typeof x === 'string').map(x => x.slice(0, 40)).slice(0, 64) : [],
    log: Array.isArray(v.log) ? v.log.flatMap(e => { const q = e as { what?: unknown; at?: unknown }; return typeof q?.what === 'string' && typeof q.at === 'number' ? [{ what: q.what.slice(0, 32), at: q.at }] : []; }).slice(0, 24) : [],
    ...(story && typeof story.id === 'string' && typeof story.beat === 'number' ? { story: { id: story.id.slice(0, 40), beat: Math.max(0, Math.floor(story.beat)), at: num(story.at, 0, 0, 9e15) } } : {}),
    ...(typeof v.visits === 'number' ? { visits: Math.floor(v.visits) } : {}), ...(typeof v.lastVisit === 'number' ? { lastVisit: v.lastVisit } : {}),
  };
}

/** A surface things can be put on, in the room's own coordinates: one for each height a piece of furniture has. */
export interface TopSurface { key: string; object: string; level: number; x: number; y: number; z: number; rotY: number; w: number; d: number }
export function topsOf(objects: SpaceObject[]): TopSurface[] {
  const out: TopSurface[] = [];
  for (const o of objects) {
    const it = CATALOG_BY_ID[o.kind];
    if (!it?.tops || o.hidden || o.inside) continue;
    // A bed's or a seat's top is cloth, not a surface dust is wiped from.
    if (o.kind.startsWith('bed.') || o.kind === 'pouf') continue;
    it.tops.forEach((h, level) => out.push({ key: `${o.id}:${level}`, object: o.id, level, x: o.pos[0], y: o.pos[1] + h * o.scale, z: o.pos[2], rotY: o.rotY, w: it.size[0] * o.scale, d: it.size[1] * o.scale }));
  }
  return out.slice(0, 32);
}
export const topCells = (w: number, d: number): [number, number] => [Math.max(4, Math.min(28, Math.round(w / .07))), Math.max(4, Math.min(28, Math.round(d / .07)))];

/** Into a surface's own axes. */
export function toLocal(s: { x: number; z: number; rotY: number }, x: number, z: number) {
  const dx = x - s.x, dz = z - s.z, c = Math.cos(s.rotY), n = Math.sin(s.rotY);
  return { x: c * dx - n * dz, z: n * dx + c * dz };
}
/** What stands on a surface or floor keeps it covered: the dust stops at its edge, so lifting a book leaves its shape. */
export function markCovered(f: GrimeField, surface: { x: number; z: number; rotY: number; y?: number }, objects: SpaceObject[], onFloor: boolean) {
  f.covered.fill(0);
  for (const o of objects) {
    const it = CATALOG_BY_ID[o.kind];
    if (!it || o.hidden || o.inside || (it.flat && !onFloor)) continue;
    if (onFloor ? it.place !== 'floor' : (it.place !== 'surface' || Math.abs(o.pos[1] - (surface.y ?? 0)) > .03)) continue;
    const c = toLocal(surface, o.pos[0], o.pos[2]), yaw = o.rotY - surface.rotY, sx = it.size[0] * o.scale / 2, sz = it.size[1] * o.scale / 2, cs = Math.cos(yaw), sn = Math.sin(yaw);
    for (let k = 0; k < f.nz; k++) for (let i = 0; i < f.nx; i++) {
      const px = (i + .5) / f.nx * f.w - f.w / 2 - c.x, pz = (k + .5) / f.nz * f.d - f.d / 2 - c.z;
      if (Math.abs(cs * px - sn * pz) <= sx && Math.abs(sn * px + cs * pz) <= sz) f.covered[f.at(i, k)] = 1;
    }
  }
}
function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 4294967296; };
}

export interface AgeContext { floor: GrimeField; tops: Map<string, { field: GrimeField; surface: TopSurface }>; room: { size: number; wallLeft: boolean; wallRight: boolean }; objects: SpaceObject[] }
/**
 * How long the room was left, once. Dust settles on what is open to it, crumbs gather where people spend time, a cobweb starts in a corner nobody has been in. The
 * floor under a tall thing near a wall stays quiet long enough for webs behind it. Returns what changed, for the record.
 */
export function age(life: RoomLife, ctx: AgeContext, now: number): { days: number; webs: number; crumbs: number } {
  const days = Math.max(0, (now - life.at) / DAY);
  life.at = now;
  const r = RATE[life.settings.care];
  if (days < 1 / 48 || r.cap <= 0) return { days, webs: 0, crumbs: 0 };
  markCovered(ctx.floor, { x: 0, z: 0, rotY: 0 }, ctx.objects, true);
  settleDust(ctx.floor, days, r.perDay, r.cap, hashSeed(life.seed), true);
  for (const { field, surface } of ctx.tops.values()) { markCovered(field, surface, ctx.objects, false); settleDust(field, days, r.perDay * 1.15, r.cap * 1.1, hashSeed(life.seed + surface.key), false); }
  const rand = rng(`${life.seed}|${Math.floor(now / DAY)}`), half = ctx.room.size / 2;
  // Crumbs: by the desk and the door, a few a day, never more than it can hold.
  let crumbs = 0;
  const desk = ctx.objects.find(o => o.kind.startsWith('desk.') && !o.hidden);
  const wanted = Math.min(r.crumbMax - life.crumbs.length, Math.floor(days * r.crumbsPerDay + rand()));
  for (let i = 0; i < wanted; i++) {
    const nearDesk = desk && rand() < .55, a = rand() * Math.PI * 2, d = .25 + rand() * (nearDesk ? .9 : 2.4);
    const cx = nearDesk ? desk!.pos[0] : 0, cz = nearDesk ? desk!.pos[2] + .75 : .6;
    const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
    if (Math.abs(x) > half - .08 || Math.abs(z) > half - .08) continue;
    life.crumbs.push({ x, z, kind: rand() < .22 ? 1 : 0, r: rand() * 6.28 }); crumbs++;
  }
  // Webs: only in corners that exist and nobody touches; never a second in the same place.
  let webs = 0;
  const every = r.webEvery;
  const due = Math.floor((days + rand() * every * .5) / every);
  const places = cornerPlaces(ctx.room, ctx.objects).filter(p => !life.webs.some(w => Math.hypot(w.x - p.x, w.y - p.y, w.z - p.z) < .5));
  for (let i = 0; i < due && life.webs.length < r.webMax && places.length; i++) {
    const p = places.splice(Math.floor(rand() * places.length), 1)[0];
    life.webs.push({ id: `w${Math.floor(rand() * 1e6).toString(36)}`, ...p, size: .34 + rand() * .3, k: 1 });
    webs++;
  }
  return { days, webs, crumbs };
}
const hashSeed = (s: string) => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 9973; return h; };
function cornerPlaces(room: AgeContext['room'], objects: SpaceObject[]): Omit<Web, 'id' | 'size' | 'k'>[] {
  const h = room.size / 2 - .02, top = 2.92, out: Omit<Web, 'id' | 'size' | 'k'>[] = [];
  // The corner of two walls and the ceiling, seen from inside: the web's plane turned across the corner.
  if (room.wallLeft && room.wallRight) out.push({ x: -h, y: top, z: -h, ry: Math.PI / 4 });
  if (room.wallRight) out.push({ x: h, y: top, z: -h, ry: -Math.PI / 4 });
  if (room.wallLeft) out.push({ x: -h, y: top, z: h, ry: Math.PI * 3 / 4 });
  out.push({ x: h, y: top, z: h, ry: -Math.PI * 3 / 4 });
  // Up behind a tall piece against a wall: it goes when the piece is moved, that was all that held it.
  for (const o of objects) {
    if (o.kind !== 'shelf.tall' || o.hidden) continue;
    out.push({ x: o.pos[0] + Math.cos(o.rotY) * .44, y: o.pos[1] + 1.95, z: o.pos[2] - Math.sin(o.rotY) * .44, ry: o.rotY + Math.PI / 4, on: o.id });
  }
  return out;
}
/** A piece moved away takes with it the web that hung from it: nothing holds it now. */
export function dropWebsOf(life: RoomLife, id: string) { const n = life.webs.length; life.webs = life.webs.filter(w => w.on !== id); return n !== life.webs.length; }

export function logEvent(life: RoomLife, what: string, at: number) { life.log = [{ what, at }, ...life.log].slice(0, 24); }

/** Everything that says how clean the room is, for stories and for the one who asks. 1 is spotless. */
export function cleanliness(floor: GrimeField, tops: Iterable<GrimeField>, crumbs: number, webs: number) {
  let dust = floor.dustIndex() * 1.8, n = 1;
  for (const t of tops) { dust += t.dustIndex(); n++; }
  const stain = Math.min(1, floor.area('stain', .08) / 3);
  return Math.max(0, 1 - Math.min(1, dust / n * 1.5) * .6 - stain * .22 - Math.min(1, crumbs / 16) * .1 - Math.min(1, webs / 3) * .08);
}
/** What to leave out of a stored default: a room's design has no dust. */
export function withoutLife(l: Layout): Layout { const { life: _life, ...rest } = l; void _life; return rest as Layout; }
