import { CATALOG_BY_ID } from './catalog';
import { WIDGET_GEOMETRY, widgetSize } from './widgetGeometry';
import { normalizePreference } from '@/lib/wallpaper/storage';
import { normalizeSpatial } from '@/lib/spatial/preference';
import {
  LAYOUT_VERSION, type CharacterConfig, type Layout, type ObjectState, type RoomConfig, type RoomTheme, type SpaceObject, type Widget, type WidgetType,
} from './types';
import { normalizeLook } from '@/lib/avatar/look';
import { readLife } from './life';
import { isFloorPose } from '@/lib/embodiment/posture';
import { kitObjects } from './kit';

/** Layout helpers: defaults, the four starting templates, an empty foreground, and a tolerant reader for stored JSON. */

export const uid = (prefix: string) =>
  `${prefix}-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)}`;

export const WALL_HEIGHT = 3;

const ROOM_BASE: Record<RoomTheme, Omit<RoomConfig, 'visible' | 'wallLeft' | 'wallRight' | 'floor' | 'base' | 'size'>> = {
  ocean: { theme: 'ocean', wallColor: '#c9d3f6', accentColor: '#7c8cf0', floorStyle: 'oak', windowView: 'ocean', particles: 'bubbles', daylight: 0.55 },
  rain: { theme: 'rain', wallColor: '#e8d9c8', accentColor: '#f0a75c', floorStyle: 'walnut', windowView: 'rain', particles: 'none', daylight: 0.25 },
  library: { theme: 'library', wallColor: '#b9a6dc', accentColor: '#d8a85b', floorStyle: 'walnut', windowView: 'magic', particles: 'motes', daylight: 0.2 },
  station: { theme: 'station', wallColor: '#dfe3f3', accentColor: '#7dd3fc', floorStyle: 'metal', windowView: 'space', particles: 'stars', daylight: 0.4 },
  plain: { theme: 'plain', wallColor: '#e9e5f7', accentColor: '#8b7cf0', floorStyle: 'oak', windowView: 'day', particles: 'none', daylight: 0.8 },
};

export function roomFor(theme: RoomTheme, visible = true): RoomConfig {
  return { ...ROOM_BASE[theme], visible, wallLeft: true, wallRight: true, floor: true, base: true, size: 6 };
}

export const DEFAULT_CHARACTER: CharacterConfig = {
  visible: true, model: 'LYRA', hair: '#5a3a2a', top: '#f2f0f6', bottom: '#5b6b9a', shoes: '#f4f4f8', accessory: 'none',
  pos: [1.2, 0, 0.4], rotY: Math.PI * 0.8, anchor: null, activity: 'idle', followFocus: true,
};

function readState(raw: unknown): ObjectState | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>, out: ObjectState = {};
  if (typeof v.on === 'boolean') out.on = v.on;
  if (typeof v.lid === 'number') out.lid = Math.max(0, Math.min(1, v.lid));
  if (typeof v.tilt === 'number') out.tilt = Math.max(-.3, Math.min(.3, v.tilt));
  if (typeof v.flip === 'number') out.flip = Math.max(0, Math.min(9999, Math.floor(v.flip)));
  if (typeof v.flipAt === 'number') out.flipAt = v.flipAt;
  if (typeof v.sips === 'number') out.sips = Math.max(0, Math.min(4, Math.round(v.sips * 100) / 100));
  for (const k of ['temp', 'tea', 'soil', 'growth'] as const) if (typeof v[k] === 'number') out[k] = Math.max(0, Math.min(1, v[k] as number));
  if (typeof v.burnt === 'boolean') out.burnt = v.burnt;
  if (Number.isSafeInteger(v.material) && (v.material as number) > 0) out.material = v.material as number;
  if (typeof v.page === 'number') out.page = Math.max(0, Math.min(99999, Math.floor(v.page)));
  const b = v.book as Record<string, unknown> | undefined;
  if (b && typeof b === 'object' && typeof b.title === 'string' && typeof b.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(b.color)) {
    const shared = { title: b.title.slice(0, 200), author: typeof b.author === 'string' ? b.author.slice(0, 120) : '', color: b.color };
    if (b.source === 'mybooks' && typeof b.id === 'string' && b.id.length <= 64) out.book = { source: 'mybooks', id: b.id, ...shared };
    else if ((b.source === 'reading' || b.source === 'bilingual') && Number.isSafeInteger(b.id) && (b.id as number) > 0) out.book = { source: b.source, id: b.id as number, ...shared };
  }
  for (const k of ['wet', 'load', 'fill', 'dirt'] as const) if (typeof v[k] === 'number' && Number.isFinite(v[k])) out[k] = Math.max(0, Math.min(1, v[k] as number));
  if (Array.isArray(v.taken)) out.taken = v.taken.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < 32).slice(0, 32);
  return Object.keys(out).length ? out : undefined;
}

export function newWidget(type: WidgetType, x = 0.36, y = 0.3, z = 10): Widget {
  const [w, h] = WIDGET_GEOMETRY[type].initial;
  return { id: uid('w'), type, x, y, w, h, z, opacity: 1, refId: null, settings: {} };
}

const o = (kind: string, pos: [number, number, number], rotY = 0, extra: Partial<SpaceObject> = {}): SpaceObject => ({
  id: uid('o'), kind, pos, rotY, scale: 1, ...extra,
});

const H = Math.PI / 2;

/**
 * Builds a fresh, upright set of default Study Room objects (furniture, books, cups, plant pots, lamps, and
 * rack-mounted cleaning tools) for `theme` scaled cleanly to `roomSize`, used by both `templateLayout` and `Reset Room`.
 */
export function buildDefaultRoomObjects(theme: RoomTheme, roomSize = 6): { objects: SpaceObject[]; anchor: string | null } {
  const effectiveTheme: Exclude<RoomTheme, 'plain'> = theme === 'plain' ? 'ocean' : theme;
  let objects: SpaceObject[] = [];
  let anchor: string | null = null;
  if (effectiveTheme === 'ocean') {
    const chair = o('chair.office', [0.62, 0, -1.86], Math.PI);
    anchor = chair.id;
    objects = [
      o('rug.round', [0.4, 0, 0.7]),
      o('bed.single', [-2.0, 0, 1.05], H, { color: '#9fb4ee' }),
      o('nightstand', [-2.72, 0, -0.32], H),
      o('lamp.shell', [-2.72, 0.56, -0.32], H),
      o('desk.corner', [0.9, 0, -2.58]),
      chair,
      o('laptop', [0.62, 0.76, -2.6]),
      o('lamp.desk', [1.62, 0.76, -2.74], -0.4),
      o('books.stack', [0.05, 0.76, -2.72]),
      o('mug', [1.22, 0.76, -2.42]),
      o('lamp.jelly', [-0.05, 1.38, -2.78]),
      o('plant.pothos', [1.55, 1.38, -2.78]),
      o('shelf.wall', [-2.87, 1.65, -1.55], H),
      o('books.row', [-2.87, 1.67, -1.75], H),
      o('lighthouse', [-2.87, 1.67, -1.2], H),
      o('art.whale', [-2.97, 1.55, 1.05], H),
      o('clock.wall', [-1.6, 2.15, -2.96]),
      o('plant.monstera', [2.45, 0, -2.45]),
      o('whale.plush', [0.55, 0, 1.0], 0.5),
      o('pouf', [2.1, 0, 0.6]),
      o('coral', [-2.72, 0.56, -0.12], H),
    ];
  } else if (effectiveTheme === 'rain') {
    const chair = o('chair.simple', [0.5, 0, -1.86], Math.PI, { color: '#e9e2d8' });
    anchor = chair.id;
    objects = [
      o('rug.rect', [0.2, 0, 0.6], 0, { color: '#d9c7b8' }),
      o('bed.drawer', [-1.95, 0, 1.1], H, { color: '#a48fd8' }),
      o('nightstand', [-2.72, 0, -0.25], H, { color: '#c49a6c' }),
      o('lamp.moon', [-2.72, 0.56, -0.25], H),
      o('desk.wood', [0.55, 0, -2.55], 0, { color: '#9a6a46' }),
      chair,
      o('laptop', [0.5, 0.78, -2.6]),
      o('lamp.desk', [1.15, 0.78, -2.72], -0.5),
      o('notebook', [-0.05, 0.78, -2.45], 0.3),
      o('mug', [0.98, 0.78, -2.35]),
      o('shelf.tall', [-2.78, 0, -2.0], H, { color: '#b98b5f' }),
      o('books.row', [-2.78, 0.84, -2.05], H),
      o('books.row', [-2.78, 1.26, -1.95], H),
      o('plant.succulent', [-2.78, 1.68, -2.0], H),
      o('art.leaf', [-2.97, 1.6, 1.1], H),
      o('clock.wall', [2.2, 2.2, -2.96]),
      o('plant.snake', [2.45, 0, -2.4]),
      o('armchair', [2.0, 0, 0.9], -2.4, { color: '#c7a07a' }),
      o('table.side', [2.35, 0, -0.3]),
      o('lamp.lantern', [2.35, 0.56, -0.3]),
      o('plant.hanging', [1.5, 1.95, -2.92]),
    ];
  } else if (effectiveTheme === 'library') {
    const chair = o('chair.simple', [0.7, 0, -1.84], Math.PI, { color: '#d8c4f0' });
    anchor = chair.id;
    objects = [
      o('rug.round', [0.4, 0, 0.5], 0, { color: '#8f7bd8' }),
      o('shelf.tall', [-2.78, 0, -2.2], H, { color: '#c9a77c' }),
      o('shelf.tall', [-2.78, 0, -1.25], H, { color: '#c9a77c' }),
      o('shelf.tall', [-2.78, 0, -0.3], H, { color: '#c9a77c' }),
      o('books.row', [-2.78, 0.42, -2.2], H), o('books.row', [-2.78, 0.84, -2.2], H), o('books.row', [-2.78, 1.26, -2.2], H),
      o('books.row', [-2.78, 0.42, -1.25], H), o('books.row', [-2.78, 1.26, -1.25], H), o('globe', [-2.78, 0.84, -1.25], H),
      o('books.row', [-2.78, 0.84, -0.3], H), o('books.row', [-2.78, 1.68, -0.3], H), o('crystal', [-2.78, 0.42, -0.3], H),
      o('desk.wood', [0.7, 0, -2.5], 0, { color: '#7a4b2f' }),
      chair,
      o('books.stack', [0.15, 0.78, -2.6]),
      o('lamp.lantern', [1.3, 0.78, -2.7]),
      o('notebook', [0.75, 0.78, -2.45], -0.2),
      o('hourglass', [1.05, 0.78, -2.72]),
      o('armchair', [-1.6, 0, 1.2], 0.7, { color: '#8e78d4' }),
      o('table.side', [-0.7, 0, 1.6], 0, { color: '#b78a5e' }),
      o('books.stack', [-0.7, 0.56, 1.6], 0.6),
      o('lamp.floor', [-2.45, 0, 1.9]),
      o('plant.monstera', [2.4, 0, -2.4]),
      o('plant.hanging', [-1.6, 2.1, -2.92]),
      o('art.sky', [-2.97, 1.75, 1.2], H),
      o('pouf', [1.8, 0, 0.9], 0, { color: '#e6dcf5' }),
    ];
  } else if (effectiveTheme === 'station') {
    const chair = o('chair.office', [0.7, 0, -1.86], Math.PI, { color: '#e8ecf8' });
    anchor = chair.id;
    objects = [
      o('rug.round', [0.4, 0, 0.5], 0, { color: '#9aa7e6' }),
      o('bed.single', [-2.0, 0, 1.05], H, { color: '#3d4a8a' }),
      o('desk.corner', [0.9, 0, -2.58], 0, { color: '#eef1fa' }),
      chair,
      o('monitor', [0.7, 0.76, -2.7]),
      o('laptop', [1.55, 0.76, -2.55], -0.4),
      o('rocket', [-0.05, 1.38, -2.78]),
      o('crystal', [1.7, 1.38, -2.78]),
      o('mug', [0.15, 0.76, -2.45]),
      o('shelf.wall', [-2.87, 1.7, -1.6], H, { color: '#eef1fa' }),
      o('books.row', [-2.87, 1.72, -1.8], H),
      o('globe', [-2.87, 1.72, -1.25], H),
      o('beanbag', [1.9, 0, 0.8], 0, { color: '#c7cdf3' }),
      o('telescope', [2.35, 0, -0.9], -0.6),
      o('plant.pothos', [-2.72, 0.56, -0.32], H),
      o('nightstand', [-2.72, 0, -0.32], H, { color: '#eef1fa' }),
      o('clock.digital', [-2.72, 0.56, -0.12], H),
      o('plant.snake', [2.45, 0, -2.45]),
    ];
  }
  const safeSize = Math.max(4, Math.min(9, Number.isFinite(roomSize) ? roomSize : 6));
  if (Math.abs(safeSize - 6) > 1e-3) {
    const ratio = safeSize / 6;
    const halfDelta = (safeSize - 6) / 2;
    objects = objects.map((obj) => {
      const it = CATALOG_BY_ID[obj.kind];
      let [x, y, z] = obj.pos;
      if (it?.place === 'wall') {
        if (Math.abs(x) > Math.abs(z)) x += Math.sign(x) * halfDelta;
        else z += Math.sign(z) * halfDelta;
      } else {
        x = +(x * ratio).toFixed(3);
        z = +(z * ratio).toFixed(3);
      }
      return { ...obj, pos: [x, y, z] };
    });
  }
  objects = [...objects, ...kitObjects(objects, safeSize, () => uid('o'))];
  return { objects, anchor };
}

/** The starting templates. After choosing one, every part of it is the learner's to move, change or delete. */
export function templateLayout(theme: RoomTheme): Layout {
  let objects: SpaceObject[] = [];
  let anchor: string | null = null;
  if (theme !== 'plain') {
    const built = buildDefaultRoomObjects(theme, 6);
    objects = built.objects;
    anchor = built.anchor;
  }
  const room = roomFor(theme, theme !== 'plain');
  const character: CharacterConfig = { ...DEFAULT_CHARACTER, visible: theme !== 'plain', anchor };
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight;
  const vw = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const focusHeight = vh < 720 ? 280 : vh < 820 ? 300 : 340;
  const taskHeight = Math.max(220, Math.min(292, vh - focusHeight - 64));
  const toolTop = Math.max(16, Math.min(80, (vh - focusHeight - taskHeight - 16) / 2));
  const toolX = Math.max(0, (vw - 328) / vw);
  const widgets: Widget[] = theme === 'plain' ? [] : [
    { ...newWidget('focus', toolX, toolTop / vh), h: focusHeight, z: 11 },
    { ...newWidget('tasks', toolX, (toolTop + focusHeight + 16) / vh), h: taskHeight, z: 12 },
    { ...newWidget('music', 0.34, 0.86), z: 13 },
  ];
  return {
    v: LAYOUT_VERSION, room, objects, character, pet: { visible: theme === 'ocean', kind: 'echo', roam: true }, widgets,
    camera: { azimuth: Math.PI / 4, polar: 1.02, zoom: 1, target: [0, 0.9, 0] }, stage: { scale: 0.94, offsetX: -0.2, offsetZ: 0.15 },
    quality: 'high',
  };
}

/** A layout with nothing in the foreground: the background of Giao diện alone. */
export function emptyLayout(from?: Layout): Layout {
  const base = from ?? templateLayout('plain');
  return {
    ...base, v: LAYOUT_VERSION, objects: [], widgets: [],
    room: { ...base.room, visible: false }, character: { ...base.character, visible: false }, pet: { ...base.pet, visible: false },
  };
}

export const isEmptyForeground = (l: Layout) =>
  !l.room.visible && !l.character.visible && !l.pet.visible && l.objects.every((x) => x.hidden) && l.widgets.every((w) => w.hidden);

const num = (v: unknown, d: number, min = -1e6, max = 1e6) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);
const str = (v: unknown, d: string, max = 80) => (typeof v === 'string' && v.length <= max ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const color = (v: unknown, d: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : d);
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const vec = (v: unknown, d: [number, number, number]): [number, number, number] =>
  Array.isArray(v) && v.length === 3 ? [num(v[0], d[0], -20, 20), num(v[1], d[1], -5, 10), num(v[2], d[2], -20, 20)] : d;

const WIDGET_TYPES: WidgetType[] = ['focus', 'tasks', 'note', 'clock', 'calendar', 'music', 'ambient', 'flashcards', 'path', 'stats', 'dictionary', 'links', 'countdown', 'quote'];

/**
 * Reads stored JSON as a layout: unknown fields are dropped, missing ones take defaults, an object whose catalogue id
 * no longer exists is kept (reported as missing by the scene) instead of losing the rest of the room.
 */
export function readLayout(raw: unknown): Layout {
  const d = templateLayout('plain');
  if (!raw || typeof raw !== 'object') return emptyLayout();
  const r = raw as Record<string, unknown>;
  const room = (r.room ?? {}) as Record<string, unknown>;
  const theme = oneOf(room.theme, ['ocean', 'rain', 'library', 'station', 'plain'] as const, 'plain');
  const roomDefault = roomFor(theme, false);
  const ch = (r.character ?? {}) as Record<string, unknown>;
  const pet = (r.pet ?? {}) as Record<string, unknown>;
  const cam = (r.camera ?? {}) as Record<string, unknown>;
  const stage = (r.stage ?? {}) as Record<string, unknown>;
  const appearance = r.appearance as Record<string, unknown> | undefined;
  const objects = Array.isArray(r.objects) ? r.objects.slice(0, 400) : [];
  const widgets = Array.isArray(r.widgets) ? r.widgets.slice(0, 60) : [];
  return {
    v: LAYOUT_VERSION,
    ...(appearance?.mode === 'override' ? { appearance: { mode: 'override' as const, wallpaper: normalizePreference(appearance.wallpaper), spatial: normalizeSpatial(appearance.spatial), theme: oneOf(appearance.theme, ['system', 'light', 'dark'] as const, 'system') } } : {}),
    room: {
      visible: bool(room.visible, false), theme, wallLeft: bool(room.wallLeft, true), wallRight: bool(room.wallRight, true),
      floor: bool(room.floor, true), base: bool(room.base, true), wallColor: color(room.wallColor, roomDefault.wallColor),
      accentColor: color(room.accentColor, roomDefault.accentColor),
      floorStyle: oneOf(room.floorStyle, ['oak', 'walnut', 'tile', 'carpet', 'metal', 'marble'] as const, roomDefault.floorStyle),
      windowView: oneOf(room.windowView, ['ocean', 'rain', 'magic', 'space', 'day', 'sunset', 'night', 'live'] as const, roomDefault.windowView),
      particles: oneOf(room.particles, ['bubbles', 'rain', 'motes', 'stars', 'none'] as const, roomDefault.particles),
      daylight: num(room.daylight, roomDefault.daylight, 0, 1), size: num(room.size, 6, 4, 9),
      ...(room.windowOpen === true ? { windowOpen: true } : {}),
      ...(typeof room.curtains === 'number' && room.curtains > 0 ? { curtains: Math.min(1, room.curtains) } : {}),
    },
    objects: objects.flatMap((x): SpaceObject[] => {
      if (!x || typeof x !== 'object') return [];
      const v = x as Record<string, unknown>;
      if (typeof v.kind !== 'string' || typeof v.id !== 'string') return [];
      return [{
        id: str(v.id, uid('o'), 40), kind: str(v.kind, 'missing', 40), pos: vec(v.pos, [0, 0, 0]), rotY: num(v.rotY, 0, -100, 100),
        lightOn: typeof v.lightOn === 'boolean' ? v.lightOn : undefined,
        quat: Array.isArray(v.quat) && v.quat.length === 4 && v.quat.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1.001) ? (v.quat as [number, number, number, number]) : undefined,
        drawers: Array.isArray(v.drawers) && v.drawers.length <= 8 && v.drawers.every((n) => typeof n === 'number' && n >= 0 && n <= 1) ? (v.drawers as number[]) : undefined,
        inside: v.inside && typeof v.inside === 'object' && typeof (v.inside as { host?: unknown }).host === 'string' && Number.isInteger((v.inside as { slot?: unknown }).slot) ? { host: String((v.inside as { host: string }).host).slice(0, 40), slot: Math.max(0, Math.min(8, (v.inside as { slot: number }).slot)) } : undefined,
        state: readState(v.state),
        scale: num(v.scale, 1, 0.2, 4), hidden: bool(v.hidden, false), locked: bool(v.locked, false),
        group: typeof v.group === 'string' ? v.group.slice(0, 40) : undefined,
        color: typeof v.color === 'string' && /^#[0-9a-f]{6}$/i.test(v.color) ? v.color : undefined,
        action: typeof v.action === 'string' ? (v.action as SpaceObject['action']) : undefined,
      }];
    }),
    character: {
      visible: bool(ch.visible, false), model: oneOf(ch.model, ['LYRA', 'KAI'] as const, 'LYRA'), hair: color(ch.hair, d.character.hair),
      top: color(ch.top, d.character.top), bottom: color(ch.bottom, d.character.bottom), shoes: color(ch.shoes, d.character.shoes),
      // Headphones used to be on every character without anyone choosing them: an old layout's value is not a choice.
      accessory: 'none', ...(ch.look && typeof ch.look === 'object' ? { look: normalizeLook(oneOf(ch.model, ['LYRA', 'KAI'] as const, 'LYRA'), ch.look) } : {}), ...(typeof ch.lookAt === 'number' && Number.isFinite(ch.lookAt) ? { lookAt: ch.lookAt } : {}),
      pos: vec(ch.pos, d.character.pos),
      rotY: num(ch.rotY, d.character.rotY, -100, 100), anchor: typeof ch.anchor === 'string' ? ch.anchor : null,
      activity: oneOf(ch.activity, ['idle', 'study', 'read', 'write', 'type', 'listen', 'relax', 'sleep', 'stretch', 'wave'] as const, 'idle'),
      ...(isFloorPose(ch.floorPose) && !ch.anchor && ch.activity === 'idle' ? {floorPose: ch.floorPose} : {}),
      followFocus: bool(ch.followFocus, true),
    },
    pet: { visible: bool(pet.visible, false), kind: 'echo', roam: bool(pet.roam, true) },
    widgets: widgets.flatMap((x): Widget[] => {
      if (!x || typeof x !== 'object') return [];
      const v = x as Record<string, unknown>;
      if (!WIDGET_TYPES.includes(v.type as WidgetType) || typeof v.id !== 'string') return [];
      const settings: Widget['settings'] = {};
      if (v.settings && typeof v.settings === 'object') {
        for (const [k, val] of Object.entries(v.settings as Record<string, unknown>).slice(0, 20)) {
          if (val === null || typeof val === 'number' || typeof val === 'boolean' || (typeof val === 'string' && val.length <= 400)) settings[k.slice(0, 40)] = val as never;
        }
      }
      return [{
        id: str(v.id, uid('w'), 40), type: v.type as WidgetType, x: num(v.x, 0.3, 0, 1), y: num(v.y, 0.3, 0, 1),
        ...widgetSize(v.type as WidgetType, num(v.w, 280, 120, 1600), num(v.h, 200, 80, 1200)),
        z: num(v.z, 10, 0, 9999), hidden: bool(v.hidden, false), locked: bool(v.locked, false),
        opacity: num(v.opacity, 1, 0.3, 1), refId: typeof v.refId === 'string' ? v.refId.slice(0, 60) : null, settings,
      }];
    }),
    camera: {
      view: oneOf(cam.view, ['overview', 'first', 'third', 'desk'] as const, 'overview'),
      yaw: num(cam.yaw, Math.PI, -100, 100), pitch: num(cam.pitch, 0, -1.1, 1.1),
      azimuth: num(cam.azimuth, Math.PI / 4, -10, 10), polar: num(cam.polar, 1.02, 0.3, 1.45), zoom: num(cam.zoom, 1, 0.3, 4),
      target: vec(cam.target, [0, 0.9, 0]),
    },
    stage: { scale: num(stage.scale, 1, 0.3, 2), offsetX: num(stage.offsetX, 0, -12, 12), offsetZ: num(stage.offsetZ, 0, -12, 12) },
    quality: oneOf(r.quality, ['high', 'balanced', 'low'] as const, 'high'),
    ...(readLife(r.life) ? { life: readLife(r.life) } : {}),
  };
}

export const missingKinds = (l: Layout) => l.objects.filter((x) => !CATALOG_BY_ID[x.kind]).map((x) => x.kind);

export const THEME_LABEL: Record<RoomTheme, string> = {
  ocean: 'Đại dương', rain: 'Phòng mưa', library: 'Thư viện huyền ảo', station: 'Trạm vũ trụ', plain: 'Không gian trống',
};
