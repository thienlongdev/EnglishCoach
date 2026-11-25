import { CATALOG_BY_ID } from './catalog';
import type { SpaceObject, Vec3 } from './types';

/**
 * The cleaning things come to a room as one set and stand where they would in a real one: the rack against a free stretch of wall, the sink beside it, the bucket and
 * the bin at hand. Worked out from what is already in the room: nothing moves to make space, and a room with no room for it still gets it, wherever there is floor.
 */
const DOOR_CLEAR = .75;
interface Box { x: number; z: number; hx: number; hz: number }
function footprint(o: Pick<SpaceObject, 'kind' | 'pos' | 'rotY' | 'scale'>): Box | null {
  const it = CATALOG_BY_ID[o.kind];
  if (!it || it.flat || (it.place !== 'floor' && o.pos[1] > .1)) return null;
  const c = Math.abs(Math.cos(o.rotY)), s = Math.abs(Math.sin(o.rotY));
  return { x: o.pos[0], z: o.pos[2], hx: (it.size[0] * c + it.size[1] * s) * o.scale / 2, hz: (it.size[0] * s + it.size[1] * c) * o.scale / 2 };
}
const hits = (a: Box, b: Box, gap = .04) => Math.abs(a.x - b.x) < a.hx + b.hx + gap && Math.abs(a.z - b.z) < a.hz + b.hz + gap;

/** Where a thing of this size stands free, as near as it can to `want`. */
function freeNear(boxes: Box[], want: { x: number; z: number }, w: number, d: number, half: number, doors: number[]): { x: number; z: number } | null {
  const ok = (x: number, z: number) => {
    const me = { x, z, hx: w / 2, hz: d / 2 };
    if (Math.abs(x) + w / 2 > half - .02 || Math.abs(z) + d / 2 > half - .02) return false;
    if (doors.some(dx => Math.abs(x - dx) < .55 + w / 2 && z + d / 2 > half - DOOR_CLEAR)) return false;
    return !boxes.some(b => hits(me, b));
  };
  for (const r of [0, .08, .16, .26, .38, .52, .7, .92, 1.2, 1.6, 2.1]) for (let i = 0; i < 16; i++) {
    const a = i / 16 * Math.PI * 2, x = want.x + Math.cos(a) * r, z = want.z + Math.sin(a) * r;
    if (ok(x, z)) return { x, z };
    if (r === 0) break;
  }
  return null;
}
/** The stretches of wall a rack could stand against: its back to the wall, the way it faces into the room. */
const WALLS = (half: number): { along: 'x' | 'z'; fixed: number; rotY: number; tangent: [number, number] }[] => [
  { along: 'z', fixed: -half + .2, rotY: Math.PI / 2, tangent: [0, 1] },
  { along: 'x', fixed: half - .2, rotY: Math.PI, tangent: [1, 0] },      // the wall with the doors, between them
  { along: 'z', fixed: half - .2, rotY: -Math.PI / 2, tangent: [0, -1] },
  { along: 'x', fixed: -half + .2, rotY: 0, tangent: [-1, 0] },
];
/** How the tools stand on the rack, in its own axes: y on the base board, under the clips of the rail. */
export const RACK_SPOTS: Record<string, { at: Vec3; quat?: [number, number, number, number]; halfTurn?: boolean }> = {
  // The round shaft clips and centred heads accept either face. Keep the
  // nearer face when returning a held tool; forcing a half-turn crosses the
  // two secured hands even though the rack does not require that turn.
  'tool.broom': { at: [-.36, .05, -.08], halfTurn: true },
  'tool.webbrush': { at: [-.13, .05, -.08], halfTurn: true },
  'tool.mop': { at: [.11, .05, -.08], halfTurn: true },
  'tool.dustpan': { at: [.34, .05, .12] },
  'tool.cloth': { at: [.36, .05, .09] },
  'tool.duster': { at: [-.26, .065, .1], quat: [0, 0, -Math.SQRT1_2, Math.SQRT1_2] },
};
export function onRack(rack: Pick<SpaceObject, 'pos' | 'rotY'>, kind: string, heldYaw?: number) {
  const s = RACK_SPOTS[kind];
  if (!s) return null;
  const c = Math.cos(rack.rotY), n = Math.sin(rack.rotY), [x, y, z] = s.at;
  const pos: Vec3 = [rack.pos[0] + c * x + n * z, rack.pos[1] + y, rack.pos[2] - n * x + c * z];
  let quat: [number, number, number, number] | undefined;
  if (s.quat) { const hy = rack.rotY / 2, a = Math.sin(hy), w = Math.cos(hy), [qx, qy, qz, qw] = s.quat; quat = [w * qx + a * qz, a * qw + w * qy, w * qz - a * qx, w * qw - a * qy]; }
  const turn = heldYaw === undefined ? 0 : Math.atan2(Math.sin(heldYaw - rack.rotY), Math.cos(heldYaw - rack.rotY));
  return { pos, rotY: rack.rotY + (s.halfTurn && Math.abs(turn) > Math.PI / 2 ? Math.PI : 0), quat };
}
export const KIT_KINDS = ['rack.cleaning', 'tool.broom', 'tool.webbrush', 'tool.mop', 'tool.dustpan', 'tool.cloth', 'tool.duster', 'tool.bucket', 'bin.trash', 'sink.utility'];
export const hasKit = (objects: Pick<SpaceObject, 'kind' | 'hidden'>[]) => objects.some(o => o.kind === 'tool.broom' && !o.hidden);

/** The set for this room, or the pieces it does not have yet. */
export function kitObjects(existing: SpaceObject[], size: number, id: () => string): SpaceObject[] {
  const half = size / 2, doors = [-size * .23, size * .23], out: SpaceObject[] = [];
  const boxes = existing.map(footprint).filter((b): b is Box => !!b);
  const have = new Set(existing.map(o => o.kind));
  const reserve = (kind: string, p: { x: number; z: number }, rotY: number) => { const it = CATALOG_BY_ID[kind]; const c = Math.abs(Math.cos(rotY)), s = Math.abs(Math.sin(rotY)); boxes.push({ x: p.x, z: p.z, hx: (it.size[0] * c + it.size[1] * s) / 2, hz: (it.size[0] * s + it.size[1] * c) / 2 }); };
  // The stretch of wall with the most room for the rack and the sink together.
  let rackAt: { x: number; z: number } | null = null, wall = WALLS(half)[0];
  const existingRack = existing.find(o => o.kind === 'rack.cleaning' && !o.hidden);
  if (existingRack) { rackAt = { x: existingRack.pos[0], z: existingRack.pos[2] }; wall = WALLS(half).find(w => Math.abs(w.rotY - existingRack.rotY) < .01) ?? wall; }
  else for (const w of WALLS(half)) {
    const rx = w.along === 'z' ? .36 / 2 + .02 : 1.02 / 2 + .02, rz = w.along === 'z' ? 1.02 / 2 + .02 : .36 / 2 + .02;
    let found: { x: number; z: number } | null = null;
    for (let t = -half + .6; t <= half - .6 && !found; t += .15) {
      const p = w.along === 'z' ? { x: w.fixed, z: t } : { x: t, z: w.fixed };
      const q = freeNear(boxes, p, rx * 2, rz * 2, half, doors);
      if (q && Math.hypot(q.x - p.x, q.z - p.z) < .001) found = q;
    }
    if (found) { rackAt = found; wall = w; break; }
  }
  rackAt ??= freeNear(boxes, { x: 0, z: 0 }, 1.02, .36, half, doors);
  if (!rackAt) return out;
  const rotY = wall.rotY;
  if (!existingRack) {
    const rack: SpaceObject = { id: id(), kind: 'rack.cleaning', pos: [rackAt.x, 0, rackAt.z], rotY, scale: 1 };
    reserve(rack.kind, rackAt, rotY); out.push(rack);
    for (const kind of Object.keys(RACK_SPOTS)) { if (have.has(kind)) continue; const s = onRack(rack, kind)!; out.push({ id: id(), kind, pos: s.pos, rotY: s.rotY, scale: 1, ...(s.quat ? { quat: s.quat } : {}), ...(kind === 'tool.mop' ? { state: { wet: .1, load: 0 } } : {}) }); }
  } else for (const kind of Object.keys(RACK_SPOTS)) { if (have.has(kind)) continue; const s = onRack(existingRack, kind)!; out.push({ id: id(), kind, pos: s.pos, rotY: s.rotY, scale: 1, ...(s.quat ? { quat: s.quat } : {}) }); }
  const [tx, tz] = wall.tangent;
  const near = (kind: string, along: number, w: number, d: number, state?: SpaceObject['state']) => {
    if (have.has(kind)) return;
    const q = freeNear(boxes, { x: rackAt!.x + tx * along, z: rackAt!.z + tz * along }, w, d, half, doors);
    if (!q) return;
    reserve(kind, q, rotY); out.push({ id: id(), kind, pos: [q.x, 0, q.z], rotY, scale: 1, ...(state ? { state } : {}) });
  };
  near('sink.utility', .86, .54, .54);
  near('tool.bucket', -.74, .34, .34, { fill: .85, dirt: 0 });
  near('bin.trash', -1.14, .38, .38, { fill: 0 });
  // By the sink, what is filled at it; beside the window, what wants the light.
  near('can.watering', 1.34, .24, .46, { fill: .5 });
  near('plant.terracotta', 1.86, .3, .3, { soil: .55, growth: 0 });
  // The tea things on the desk, if it has room; by the sink if not. Each away from what is already there.
  const tops: { x: number; z: number; hx: number; hz: number; y: number }[] = [];
  for (const o of existing) { const it = CATALOG_BY_ID[o.kind]; if (o.hidden || !it?.tops?.length || !o.kind.startsWith('desk.')) continue; tops.push({ x: o.pos[0], z: o.pos[2], hx: it.size[0] * o.scale / 2, hz: it.size[1] * o.scale / 2, y: o.pos[1] + it.tops[0] * o.scale }); }
  const onTop = existing.filter(o => !o.hidden && CATALOG_BY_ID[o.kind]?.place === 'surface' && o.pos[1] > .3).map(o => ({ x: o.pos[0], z: o.pos[2], r: Math.max(CATALOG_BY_ID[o.kind].size[0], CATALOG_BY_ID[o.kind].size[1]) * o.scale / 2 }));
  const tea = (kind: string, r: number, state?: SpaceObject['state']) => {
    if (have.has(kind)) return;
    for (const t of tops) for (let i = 0; i < 40; i++) {
      const x = t.x + (i % 9 - 4) / 4.4 * (t.hx - r - .03), z = t.z + (Math.floor(i / 9) - 2) / 2.4 * (t.hz - r - .03);
      if (onTop.some(s => Math.hypot(s.x - x, s.z - z) < s.r + r + .02)) continue;
      onTop.push({ x, z, r });
      out.push({ id: id(), kind, pos: [x, t.y, z], rotY: 0, scale: 1, ...(state ? { state } : {}) });
      return;
    }
    const q = freeNear(boxes, { x: rackAt!.x + tx * 1.5, z: rackAt!.z + tz * 1.5 }, r * 2, r * 2, half, doors);
    if (q) { reserve(kind, q, 0); out.push({ id: id(), kind, pos: [q.x, 0, q.z], rotY: 0, scale: 1, ...(state ? { state } : {}) }); }
  };
  tea('kettle.vintage', .13, { fill: .6, temp: 0 });
  tea('teapot', .13, { fill: 0, tea: 0, temp: 0 });
  tea('saucer', .08);
  // The cup stands on its saucer.
  { const s = out[out.length - 1]; if (s?.kind === 'saucer') out.push({ id: id(), kind: 'teacup', pos: [s.pos[0], s.pos[1] + .012, s.pos[2]], rotY: 0, scale: 1, state: { fill: 0, tea: 0, temp: 0 } }); }
  tea('bulb.spare', .05);
  return out;
}
