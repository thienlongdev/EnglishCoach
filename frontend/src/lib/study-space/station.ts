import type { SpaceObject } from './types';

/**
 * A desk computer, put together by hand. Nothing here places anything: the player chooses where each part goes, and a part counts as connected
 * when it is where a cable would reach (a tower beside the monitor or on the floor by the desk, a keyboard and a mouse within arm's reach of it).
 * Pure logic, no three.js: the world, the prompt and the tests read the same answer.
 */
export type StationPart = 'tower' | 'monitor' | 'keyboard' | 'mouse';
export const STATION_PARTS: StationPart[] = ['tower', 'monitor', 'keyboard', 'mouse'];
const KIND_OF: Record<string, StationPart> = { 'pc.tower': 'tower', monitor: 'monitor', keyboard: 'keyboard', 'mouse.pc': 'mouse' };
export const partOf = (kind: string): StationPart | null => KIND_OF[kind] ?? null;
export const PART_NAME: Record<StationPart, { vi: string; en: string }> = {
  tower: { vi: 'Thùng máy', en: 'Tower' }, monitor: { vi: 'Màn hình', en: 'Monitor' }, keyboard: { vi: 'Bàn phím', en: 'Keyboard' }, mouse: { vi: 'Chuột', en: 'Mouse' },
};

export interface Station {
  monitor: SpaceObject | null;
  parts: Partial<Record<StationPart, SpaceObject>>;
  missing: StationPart[];
  ready: boolean;
}

const flat = (a: SpaceObject, b: SpaceObject) => Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]);
/** How far a cable reaches, and what counts as the same desk. */
const REACH: Record<StationPart, { far: number; drop: number }> = { monitor: { far: 0, drop: 0 }, tower: { far: 1.15, drop: 1.1 }, keyboard: { far: .8, drop: .18 }, mouse: { far: .95, drop: .18 } };

/** The computer a monitor makes with what is around it. Hidden things and things in a drawer are not connected to anything. */
export function stationOf(objects: SpaceObject[], monitor: SpaceObject): Station {
  const parts: Station['parts'] = { monitor };
  for (const part of ['tower', 'keyboard', 'mouse'] as StationPart[]) {
    let best: SpaceObject | undefined, d = Infinity;
    for (const o of objects) {
      if (o.hidden || o.inside || partOf(o.kind) !== part) continue;
      const here = flat(o, monitor);
      if (here <= REACH[part].far && Math.abs(o.pos[1] - monitor.pos[1]) <= REACH[part].drop && here < d) { best = o; d = here; }
    }
    if (best) parts[part] = best;
  }
  const missing = STATION_PARTS.filter(p => !parts[p]);
  return { monitor, parts, missing, ready: !missing.length };
}

/** The computer a part belongs to, or would: the nearest monitor. Null when the room has none: then the monitor is what is missing. */
export function stationNear(objects: SpaceObject[], part: SpaceObject): Station {
  if (part.kind === 'monitor') return stationOf(objects, part);
  let best: SpaceObject | null = null, d = Infinity;
  for (const o of objects) {
    if (o.hidden || o.inside || o.kind !== 'monitor') continue;
    const here = flat(o, part);
    if (here < d) { best = o; d = here; }
  }
  if (best && d < 2.2) return stationOf(objects, best);
  const own = partOf(part.kind);
  return { monitor: null, parts: own ? { [own]: part } : {}, missing: STATION_PARTS.filter(p => p !== own), ready: false };
}
