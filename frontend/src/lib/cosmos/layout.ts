/**
 * Stable spatial memory. Positions are a pure function of identity: a galaxy has a fixed anchor, a constellation / system /
 * star gets a seed from a hash of its key, and a short anchored relaxation only removes overlaps. Adding a star moves (a
 * little) only the other members of its own system and the systems of its own constellation; nothing else changes. Runs
 * once in the worker; nothing simulates afterwards. Physics never decides meaning: positions come from the hierarchy.
 */
import { GALAXIES } from './domains';
import type { Community, CosmosGraph, CosmosNode } from './types';

export const UNIVERSE_RADIUS = 2200;

/**
 * How far the galaxy anchors sit from the centre, as a share of UNIVERSE_RADIUS, for a universe of `stars` knowledge stars.
 * A small personal universe gathers into one comfortably visible region; it opens out in discrete steps (each doubling of
 * real knowledge past 16 stars) — so adding a star almost never moves anything, and a step is a visible expansion. Angles,
 * order and every relative arrangement stay fixed: a galaxy is always in the same direction.
 */
export function universeSpread(stars: number): number {
  const step = Math.floor(Math.log2(Math.max(1, stars) / 16));
  return Math.min(1, 0.36 + 0.09 * Math.max(0, step));
}

export function hash01(key: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

type V = { x: number; y: number; z: number };

/** Rotate a galaxy-local point into the galaxy's tilted plane (fixed tilt per galaxy: depth without randomness). */
export function tilt(g: number, p: V): V {
  const a = (hash01(GALAXIES[g].id, 7) - 0.5) * 0.7, b = (hash01(GALAXIES[g].id, 9) - 0.5) * 0.7;
  const y1 = p.y * Math.cos(a) - p.z * Math.sin(a), z1 = p.y * Math.sin(a) + p.z * Math.cos(a);
  const x2 = p.x * Math.cos(b) - y1 * Math.sin(b), y2 = p.x * Math.sin(b) + y1 * Math.cos(b);
  return { x: x2, y: y2, z: z1 };
}

/** The inverse of `tilt`: a world offset back into the galaxy-local frame. */
export function untilt(g: number, p: V): V {
  const a = (hash01(GALAXIES[g].id, 7) - 0.5) * 0.7, b = (hash01(GALAXIES[g].id, 9) - 0.5) * 0.7;
  const x = p.x * Math.cos(b) + p.y * Math.sin(b), y1 = -p.x * Math.sin(b) + p.y * Math.cos(b);
  const y = y1 * Math.cos(a) + p.z * Math.sin(a), z = -y1 * Math.sin(a) + p.z * Math.cos(a);
  return { x, y, z };
}
/** Anchored overlap removal: circles of `r` around seeds, pulled back to their seed. Deterministic, bounded. */
function relax(items: { x: number; z: number; sx: number; sz: number; r: number }[], iterations = 60) {
  for (let it = 0; it < iterations; it++) {
    let moved = 0;
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz) || 1e-3, min = a.r + b.r;
      if (d < min) {
        const push = (min - d) / 2, ux = dx / d, uz = dz / d;
        a.x -= ux * push; a.z -= uz * push; b.x += ux * push; b.z += uz * push; moved++;
      }
    }
    for (const a of items) { a.x += (a.sx - a.x) * 0.04; a.z += (a.sz - a.z) * 0.04; }
    if (!moved) break;
  }
}

export function layout(graph: CosmosGraph): CosmosGraph {
  const { nodes, galaxies, constellations, systems } = graph;
  const spread = universeSpread(nodes.filter(n => n.kind !== 'concept' && !(n.kind === 'word' && !n.cardIds.length)).length);
  const membersOf = (list: CosmosNode[], key: (n: CosmosNode) => number) => {
    const m = new Map<number, CosmosNode[]>();
    for (const n of list) { const k = key(n); if (k < 0) continue; const a = m.get(k); if (a) a.push(n); else m.set(k, [n]); }
    return m;
  };
  const sysMembers = membersOf(nodes, n => n.system);

  // 1. Systems: local radius from membership; members on a shell around the centre (golden spiral, hash order).
  for (const s of systems) {
    const members = (sysMembers.get(s.i) ?? []).filter(n => n.i !== s.center);
    s.radius = members.length ? 6 + 3.2 * Math.sqrt(members.length) : 3;
    const ordered = [...members].sort((a, b) => hash01(a.id) - hash01(b.id));
    ordered.forEach((n, k) => {
      const t = (k + 0.5) / ordered.length, inc = Math.acos(1 - 2 * t) * 0.62 + 0.55, az = k * 2.399963 + hash01(s.key) * 6.283;
      const r = s.radius * (0.65 + 0.35 * hash01(n.id, 3));
      n.x = Math.sin(inc) * Math.cos(az) * r; n.y = Math.cos(inc) * r * 0.45 - r * 0.1; n.z = Math.sin(inc) * Math.sin(az) * r;
    });
    if (s.center >= 0) { const c = nodes[s.center]; c.x = 0; c.y = 0; c.z = 0; }
  }

  // 2. Constellations: systems placed around the constellation centre, seeded by key, relaxed by their radii.
  const consSystems = new Map<number, Community[]>();
  for (const s of systems) { const a = consSystems.get(s.constellation); if (a) a.push(s); else consSystems.set(s.constellation, [s]); }
  for (const c of constellations) {
    const list = consSystems.get(c.i) ?? [];
    const area = list.reduce((sum, s) => sum + (s.radius + 4) ** 2, 0);
    c.radius = Math.max(24, Math.sqrt(area) * 1.25);
    const items = list.map(s => {
      const a = hash01(s.key, 1) * Math.PI * 2, r = Math.sqrt(hash01(s.key, 2)) * c.radius * 0.8;
      return { s, x: Math.cos(a) * r, z: Math.sin(a) * r, sx: Math.cos(a) * r, sz: Math.sin(a) * r, r: s.radius + 4 };
    });
    relax(items, list.length > 400 ? 12 : 50);
    for (const it of items) { it.s.x = it.x; it.s.z = it.z; it.s.y = (hash01(it.s.key, 4) - 0.5) * c.radius * 0.35; }
  }

  // 3. Galaxies: constellations on two spiral arms, seeded by key; galaxy radius from its constellations.
  const galCons = new Map<number, Community[]>();
  for (const c of constellations) { const a = galCons.get(c.galaxy); if (a) a.push(c); else galCons.set(c.galaxy, [c]); }
  for (const g of galaxies) {
    const list = galCons.get(g.i) ?? [];
    const area = list.reduce((sum, c) => sum + (c.radius + 12) ** 2, 0);
    g.radius = Math.max(140, Math.min(900, Math.sqrt(area) * 1.6));
    const items = list.map(c => {
      const arm = hash01(c.key, 5) < 0.5 ? 0 : Math.PI, t = 0.18 + 0.78 * hash01(c.key, 6);
      const a = arm + t * 3.4, r = t * g.radius * 0.85;
      return { c, x: Math.cos(a) * r, z: Math.sin(a) * r, sx: Math.cos(a) * r, sz: Math.sin(a) * r, r: c.radius + 10 };
    });
    relax(items, 80);
    for (const it of items) { it.c.x = it.x; it.c.z = it.z; it.c.y = (hash01(it.c.key, 8) - 0.5) * 30; }
    const def = GALAXIES[g.i];
    g.x = Math.cos(def.angle) * UNIVERSE_RADIUS * spread; g.z = Math.sin(def.angle) * UNIVERSE_RADIUS * 0.62 * spread; g.y = def.lift * Math.sqrt(spread);
  }

  // 4. Compose: node = galaxy + tilt(constellation + system + local). Communities get world centres too.
  for (const c of constellations) {
    const g = galaxies[c.galaxy], p = tilt(c.galaxy, c);
    c.x = g.x + p.x; c.y = g.y + p.y; c.z = g.z + p.z;
  }
  for (const s of systems) {
    const c = constellations[s.constellation];
    const local = tilt(s.galaxy, s);
    s.x = c.x + local.x; s.y = c.y + local.y; s.z = c.z + local.z;
  }
  for (const n of nodes) {
    if (n.system < 0) continue;
    const s = systems[n.system], local = tilt(n.galaxy, n);
    n.x = s.x + local.x; n.y = s.y + local.y; n.z = s.z + local.z;
  }
  return graph;
}
