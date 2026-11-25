/**
 * Spatial navigation of Vũ trụ tri thức: where a press leads, how the camera frames a place, when zooming crosses a level.
 * Pure functions over the graph (no three.js), so the rules are tested in Node (test-cosmos.mjs §13).
 *
 * Navigation never touches knowledge: a shortcut between branches is a ROUTE of the camera, never a relation, and no
 * function here reads or writes an edge. The hierarchy is the graph's own: Universe → Galaxy → Constellation → Star system
 * → Knowledge star.
 */
import { UNIVERSE, type Focus } from './view';
import { UNIVERSE_RADIUS } from './layout';
import type { CosmosGraph, CosmosNode } from './types';

export type RegionKind = 'galaxy' | 'constellation' | 'system';
export interface RegionRef { kind: RegionKind; index: number }
export type Target = { kind: 'node'; index: number } | { kind: RegionKind; index: number };

export const starFocus = (n: CosmosNode): Focus => ({ level: 'star', galaxy: n.galaxy, constellation: n.constellation, system: n.system, node: n.i });
export const galaxyFocus = (galaxy: number): Focus => ({ ...UNIVERSE, level: 'galaxy', galaxy });
export const constellationFocus = (g: CosmosGraph, c: number): Focus => ({ ...UNIVERSE, level: 'constellation', galaxy: g.constellations[c].galaxy, constellation: c });
export const systemFocus = (g: CosmosGraph, y: number): Focus => ({ level: 'system', galaxy: g.systems[y].galaxy, constellation: g.systems[y].constellation, system: y, node: -1 });

/** A system worth its own level: more than one member (the rule the page always used for system level and its crumb). */
export const isRealSystem = (g: CosmosGraph, y: number) => (g.systems[y]?.count ?? 0) > 1;

/** One level up (Esc, the ↑ key of the puck, zooming far out). */
export function parentOf(g: CosmosGraph, f: Focus): Focus | null {
  if (f.level === 'star') { const n = g.nodes[f.node]; return n && isRealSystem(g, n.system) ? { ...f, level: 'system', node: -1 } : { ...f, level: 'constellation', system: -1, node: -1 }; }
  if (f.level === 'system') return { ...f, level: 'constellation', system: -1, node: -1 };
  if (f.level === 'constellation') return galaxyFocus(f.galaxy);
  if (f.level === 'galaxy') return UNIVERSE;
  return null;
}

/**
 * The places a press may land on at this focus, besides stars: every other galaxy (from anywhere: no need to climb back to
 * the root first), the constellations of the galaxy in view, the real systems of the constellation in view. The place the
 * learner is in is not a destination (going up is Esc / ↑ / zooming out).
 */
export function pickableRegions(g: CosmosGraph, f: Focus, counts?: { galaxy: Int32Array; constellation: Int32Array }): RegionRef[] {
  const out: RegionRef[] = [];
  const gal = (i: number) => (counts ? counts.galaxy[i] : g.galaxies[i].count) > 0;
  const con = (i: number) => (counts ? counts.constellation[i] : g.constellations[i].count) > 0;
  for (const x of g.galaxies) if (gal(x.i) && x.i !== f.galaxy) out.push({ kind: 'galaxy', index: x.i });
  if (f.level === 'universe') return out;
  for (const c of g.constellations) if (c.galaxy === f.galaxy && c.i !== f.constellation && con(c.i)) out.push({ kind: 'constellation', index: c.i });
  if (f.level === 'galaxy') return out;
  for (const y of g.systems) if (y.constellation === f.constellation && y.i !== f.system && isRealSystem(g, y.i)) out.push({ kind: 'system', index: y.i });
  return out;
}

/**
 * Where a press leads (null: nowhere). A star of another galaxy brings you to that galaxy; of another constellation, to
 * that constellation; inside the constellation in view, to its system (when it has one) or to the star itself. A region
 * brings you to that region, whatever level you are at now: the camera travels through the hierarchy for you.
 */
export function destination(g: CosmosGraph, f: Focus, t: Target): Focus | null {
  if (t.kind === 'galaxy') return t.index === f.galaxy && f.level === 'galaxy' ? null : galaxyFocus(t.index);
  if (t.kind === 'constellation') return t.index === f.constellation && f.level === 'constellation' ? null : constellationFocus(g, t.index);
  if (t.kind === 'system') return isRealSystem(g, t.index) ? (t.index === f.system && f.level === 'system' ? null : systemFocus(g, t.index)) : null;
  const n = g.nodes[t.index];
  if (!n) return null;
  if (f.level === 'universe' || n.galaxy !== f.galaxy) return galaxyFocus(n.galaxy);
  if (f.level === 'galaxy' || n.constellation !== f.constellation) return n.constellation >= 0 ? constellationFocus(g, n.constellation) : starFocus(n);
  if (f.level === 'constellation' && n.kind !== 'source' && isRealSystem(g, n.system)) return systemFocus(g, n.system);
  if (f.level === 'star' && f.node === n.i) return null;
  return starFocus(n);
}

/** Where the universe-level camera looks: the region the learner's galaxies actually occupy (never the empty anchors). */
export function universeFrame(g: CosmosGraph | null): { target: [number, number, number]; distance: number } {
  const gs = g ? g.galaxies.filter(x => x.count > 0) : [];
  if (!gs.length) return { target: [0, -200, 0], distance: UNIVERSE_RADIUS * 1.9 };
  let cx = 0, cy = 0, cz = 0;
  for (const x of gs) { cx += x.x; cy += x.y; cz += x.z; }
  cx /= gs.length; cy /= gs.length; cz /= gs.length;
  let r = 0;
  for (const x of gs) r = Math.max(r, Math.hypot(x.x - cx, (x.y - cy) * 0.6, x.z - cz) + x.radius * 0.9);
  return { target: [cx, cy - 60, cz], distance: Math.min(UNIVERSE_RADIUS * 1.9, Math.max(620, r * 2.15)) };
}
export const UNIVERSE_DIR: [number, number, number] = [0, 0.95, 0.62];

/** How the camera frames a place: what it looks at and from how far (the same numbers for a flight and for semantic zoom). */
export function frameOf(g: CosmosGraph, f: Focus): { target: [number, number, number]; distance: number } {
  if (f.level === 'universe') return universeFrame(g);
  if (f.level === 'galaxy') { const x = g.galaxies[f.galaxy]; return { target: [x.x, x.y, x.z], distance: x.radius * 2.4 + 160 }; }
  if (f.level === 'constellation') { const c = g.constellations[f.constellation]; return { target: [c.x, c.y, c.z], distance: c.radius * 2.6 + 50 }; }
  if (f.level === 'system') { const y = g.systems[f.system]; return { target: [y.x, y.y, y.z], distance: y.radius * 4.2 + 24 }; }
  const n = g.nodes[f.node], y = g.systems[n.system];
  return { target: [n.x, n.y, n.z], distance: Math.max(26, (y?.radius ?? 8) * 2.6) };
}

/** A trip that leaves the galaxy in view (or crosses most of the universe) arcs out and back in, so the learner sees where they go. */
export function isLongTrip(from: Focus, to: Focus) {
  if (from.level === 'universe' || to.level === 'universe') return false;
  return from.galaxy !== to.galaxy;
}

/** How far out (× the level's own framing distance) zooming must go before the view climbs one level. */
// One wheel notch is ×1.047 of the camera distance: climbing from a framed place takes ~14–19 notches; entering happens near
// ×1.0 of the framing (a region filling ~30 % of the view), so the band between keeps a level from flickering.
export const ZOOM_OUT: Record<Exclude<Focus['level'], 'universe'>, number> = { galaxy: 1.9, constellation: 2.0, system: 2.2, star: 2.4 };
/**
 * Zooming in enters a region when it fills enough of the view: its projected radius is at least this share of the view's
 * shorter side and its centre lies inside the view's middle. Measured on screen (not by camera distance): zoom-to-cursor
 * keeps the region under the pointer instead of centring it, so only its size on screen says the learner came close to it.
 */
export const ZOOM_IN_SHARE = 0.3;
/** Where a region stands on screen: centre (0..1 of the view) and radius (share of the view's shorter side); null off screen. */
export type Measure = (kind: 'galaxy' | 'constellation', index: number) => { x: number; y: number; r: number } | null;

/**
 * Semantic zoom: the level the camera's own view implies, or null when it still fits the current one. Zooming far out
 * climbs (up to the universe); zooming in until a galaxy fills the view enters it, and in a galaxy, until one of its
 * constellations does, enters that constellation. Systems and stars are entered only by a press (too small to enter by accident).
 */
export function semanticStep(g: CosmosGraph, f: Focus, cam: { target: [number, number, number]; distance: number }, measure?: Measure): Focus | null {
  if (f.level !== 'universe') {
    const own = frameOf(g, f);
    if (cam.distance > own.distance * ZOOM_OUT[f.level]) return parentOf(g, f);
  }
  if (!measure || (f.level !== 'universe' && f.level !== 'galaxy')) return null;
  let best: Focus | null = null, bestR = ZOOM_IN_SHARE;
  const list = f.level === 'universe' ? g.galaxies.filter(x => x.count > 0) : g.constellations.filter(c => c.galaxy === f.galaxy && c.count > 0);
  for (const c of list) {
    const m = measure(f.level === 'universe' ? 'galaxy' : 'constellation', c.i);
    if (!m || m.x < 0.15 || m.x > 0.85 || m.y < 0.15 || m.y > 0.85 || m.r < bestR) continue;
    bestR = m.r; best = f.level === 'universe' ? galaxyFocus(c.i) : constellationFocus(g, c.i);
  }
  // never straight back into a level the camera is about to leave (no ping-pong at a threshold)
  if (best && best.level !== 'universe' && cam.distance > frameOf(g, best).distance * ZOOM_OUT[best.level] * 0.8) return null;
  return best;
}

/** Stable text code of a place (URL `?focus=`): ids never move between rebuilds, indices may. */
export function encodeFocus(g: CosmosGraph, f: Focus): string {
  if (f.level === 'star' && f.node >= 0) return g.nodes[f.node]?.id ?? '';
  if (f.level === 'system') return `sys:${g.systems[f.system]?.key}`;
  if (f.level === 'constellation') return `con:${g.constellations[f.constellation]?.key}`;
  if (f.level === 'galaxy') return `gal:${g.galaxies[f.galaxy]?.key}`;
  return '';
}
