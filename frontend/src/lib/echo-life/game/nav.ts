/**
 * Echo Life Phase 3 — the residents' navigation graph over the real Phase 2 world.
 *
 * V3's residents hop between zone-local rooms (`npc-ai/residents.mjs#nextZone` + a zone-local A* grid). In English Coach the
 * 31 zones are one continuous place, so the same idea is kept — a portal graph searched with A* — but its nodes are real
 * places of this world: every zone's verified waypoint, both ends of every house and building door, the ends of every stair,
 * every room and building floor, and sample points over the pavements, crossings, parks, gardens and plazas. Every edge is
 * proven walkable by the one walk model (`LifeWalk`, with every door taken as open) before it is used, so a resident can only
 * ever follow floor a body could walk on: through doorways, along pavements, up the stairs — never through a wall.
 * Edges are validated lazily and cached for the life of the world (`warm` validates them in idle time).
 */
import { BODY_RADIUS, inRect, type Door, type HousePlan, type Rect } from '../plan';
import type { CityPlan } from '../city';
import { LifeWalk } from '../walk';
import type { V3ZoneId } from '../zones';

export interface P { x: number; z: number }
export interface NavNode { id: number; x: number; z: number; zone: V3ZoneId | null; kind: 'waypoint' | 'door' | 'floor' | 'ground' | 'stair' }
export interface Route { points: P[]; doors: { door: string; index: number }[]; length: number }

/** Legs are proven at the walker's own step (3.5 cm, as `walkSlide`): a coarser step can clip a door jamb's corner. */
const STEP = .035;
const LINK = 13;
const NEAR = 14;

/** Every door of the house and the 13 enterable buildings. */
export function allDoors(house: HousePlan, city: CityPlan): Door[] {
  return [...house.doors, ...city.buildings.map(b => b.door)];
}

export class LifeNav {
  readonly walk: LifeWalk;
  readonly nodes: NavNode[] = [];
  readonly doors: Door[];
  private readonly cells = new Map<string, number[]>();
  private readonly edges = new Map<number, boolean>();
  private readonly neighbours = new Map<number, number[]>();
  private warmCursor = 0;
  furnitureRevision = 0;
  /** Validation work actually performed (QA telemetry). */
  stats = { validated: 0, routes: 0, routeMs: 0, failures: 0 };

  constructor(readonly house: HousePlan, readonly city: CityPlan) {
    this.doors = allDoors(house, city);
    const ids = new Set(this.doors.map(d => d.id as string));
    // The study room is the learner's own: residents never enter it (no room rule: its square is not walkable for them).
    this.walk = new LifeWalk(house, city, null, () => ids as ReadonlySet<string>);
    this.build();
  }

  setFurniture(solids: LifeWalk['furniture']) {
    const old=this.walk.furniture;
    if (old.length===solids.length && solids.every((p,i)=>p.x===old[i].x && p.y===old[i].y && p.z===old[i].z &&
      p.hx===old[i].hx && p.hy===old[i].hy && p.hz===old[i].hz)) return;
    this.walk.furniture = solids;
    this.furnitureRevision++;
    this.edges.clear();
    this.warmCursor = 0;
  }

  private add(x: number, z: number, kind: NavNode['kind'], forceKeep = false) {
    const p = { x, z };
    if (!this.walk.free(p)) return -1;
    const minSep = forceKeep ? .18 : .9;
    for (const id of this.near(p, minSep)) if (Math.hypot(this.nodes[id].x - x, this.nodes[id].z - z) < minSep) return id;
    const node: NavNode = { id: this.nodes.length, x, z, zone: this.walk.zone(p), kind };
    this.nodes.push(node);
    const k = this.cellKey(x, z);
    const list = this.cells.get(k);
    if (list) list.push(node.id); else this.cells.set(k, [node.id]);
    return node.id;
  }

  private cellKey(x: number, z: number) { return `${Math.floor(x / LINK)},${Math.floor(z / LINK)}`; }

  /** Node ids within `r` metres (grid lookup). */
  near(p: P, r: number): number[] {
    const out: number[] = [];
    const cx = Math.floor(p.x / LINK), cz = Math.floor(p.z / LINK), span = Math.ceil(r / LINK);
    for (let i = cx - span; i <= cx + span; i++) for (let j = cz - span; j <= cz + span; j++) {
      const list = this.cells.get(`${i},${j}`);
      if (list) for (const id of list) if (Math.hypot(this.nodes[id].x - p.x, this.nodes[id].z - p.z) <= r) out.push(id);
    }
    return out;
  }

  private build() {
    // 1. Verified zone waypoints (the study square excepted).
    for (const z of this.city.zones) if (z.id !== 'study') this.add(z.waypoint.x, z.waypoint.z, 'waypoint');
    // 2. Both ends of every door corridor (exempt from 0.9 m floor deduplication).
    for (const d of this.doors) {
      for (const [x, z] of doorEnds(d)) this.add(x, z, 'door', true);
    }
    // 3a. Staircase spines FIRST (`u in [0.06, 0.35, 0.65, 0.94]`, `forceKeep = true`) so floor grids never eat stair portals!
    const allZones: { id: string; rect: Rect; y1?: number; along?: 'x' | 'z' }[] = [
      ...this.house.zones.filter(z => z.id !== 'street'),
      ...this.city.buildings.flatMap(b => b.zones),
    ];
    for (const f of allZones) {
      if (f.y1 === undefined) continue;
      const r = f.rect, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
      const along = f.along ?? 'z';
      for (const u of [0.06, 0.35, 0.65, 0.94]) {
        if (along === 'z') this.add(cx, r.z0 + (r.z1 - r.z0) * u, 'stair', true);
        else this.add(r.x0 + (r.x1 - r.x0) * u, cz, 'stair', true);
      }
    }
    // 3b. House rooms and building floors (finer grid on 2F `:upper` / `:landing` galleries so narrow study-table aisles attach cleanly).
    for (const f of allZones) {
      if (f.y1 !== undefined) continue;
      const r = f.rect, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
      this.add(cx, cz, 'floor');
      const isUpper = f.id.endsWith(':upper') || f.id.endsWith(':landing');
      const padX = isUpper ? .36 : .45;
      const padZ = isUpper ? .32 : .45;
      const stepX = isUpper ? .95 : 1.05;
      const stepZ = isUpper ? .72 : 1.05;
      const w = r.x1 - r.x0, d = r.z1 - r.z0;
      if (w <= padX * 2 || d <= padZ * 2) continue;
      const nx = Math.max(1, Math.round((w - padX * 2) / stepX));
      const nz = Math.max(1, Math.round((d - padZ * 2) / stepZ));
      for (let i = 0; i <= nx; i++) {
        for (let j = 0; j <= nz; j++) {
          this.add(r.x0 + padX + (w - padX * 2) * (i / nx), r.z0 + padZ + (d - padZ * 2) * (j / nz), 'floor');
        }
      }
    }
    // 4. Pavements, crossings, parks, gardens and plazas (plus curb-shoulder portals flanking N-S cross-street mouths).
    for (const g of this.city.ground) {
      if (g.surface === 'road') {
        const r = g.rect;
        if (r.z1 - r.z0 > r.x1 - r.x0 + 4) {
          for (const zShoulder of [r.z0 + 1.4, r.z1 - 1.4]) {
            this.add(r.x0 - .8, zShoulder, 'ground', true);
            this.add(r.x1 + .8, zShoulder, 'ground', true);
          }
        }
        continue;
      }
      const r = g.rect, w = r.x1 - r.x0, d = r.z1 - r.z0, pad = Math.min(.6, w / 3, d / 3);
      const nx = Math.max(1, Math.round(w / 6)), nz = Math.max(1, Math.round(d / 6));
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const x = r.x0 + pad + (w - 2 * pad) * (nx === 1 ? .5 : i / (nx - 1));
        const z = r.z0 + pad + (d - 2 * pad) * (nz === 1 ? .5 : j / (nz - 1));
        this.add(x, z, 'ground');
      }
    }
  }

  /** Is the straight leg walkable (every door open), sampled every 0.18 m? */
  clear(a: P, b: P): boolean {
    const len = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(len / STEP));
    for (let i = 1; i <= n; i++) if (!this.walk.free({ x: a.x + (b.x - a.x) * i / n, z: a.z + (b.z - a.z) * i / n })) return false;
    return true;
  }

  private edge(a: number, b: number): boolean {
    const key = a < b ? a * 65536 + b : b * 65536 + a;
    let v = this.edges.get(key);
    if (v === undefined) {
      const A = this.nodes[a], B = this.nodes[b];
      // A drop or rise larger than a stair allows cannot be one leg; the walk model also checks every step.
      v = this.clear(A, B);
      this.edges.set(key, v);
      this.stats.validated++;
    }
    return v;
  }

  /**
   * Candidate legs, symmetric: everything within 2.5 m, the 12 nearest in the same zone and the 12 nearest in other zones
   * (so a dense furnished interior never hides the pavement outside its door, nor the pavement the room behind a wall).
   */
  private candidates(id: number): number[] {
    if (!this.neighbours.size) {
      const sets = this.nodes.map(() => new Set<number>());
      for (const n of this.nodes) {
        const dist = (o: number) => Math.hypot(this.nodes[o].x - n.x, this.nodes[o].z - n.z);
        const all = this.near(n, LINK).filter(o => o !== n.id).sort((p, q) => dist(p) - dist(q));
        let same = 0, other = 0;
        for (const o of all) {
          const mine = this.nodes[o].zone === n.zone;
          if (dist(o) < 2.5 || (mine && same++ < 12) || (!mine && other++ < 12)) { sets[n.id].add(o); sets[o].add(n.id); }
        }
      }
      sets.forEach((s, i) => this.neighbours.set(i, [...s]));
    }
    return this.neighbours.get(id) ?? [];
  }

  /** Validate a slice of the graph's edges (idle time): later routes need no proof work at all. */
  warm(budgetMs: number): boolean {
    const t0 = performance.now();
    while (this.warmCursor < this.nodes.length) {
      for (const o of this.candidates(this.warmCursor)) this.edge(this.warmCursor, o);
      this.warmCursor++;
      if (performance.now() - t0 > budgetMs) return false;
    }
    return true;
  }

  get warmed() { return this.warmCursor >= this.nodes.length; }

  /** Every proven leg, for handing the graph from the worker that proved it (`nav.worker.ts`) to the page. */
  exportEdges(): { nodes: number; keys: Float64Array; ok: Uint8Array } {
    const keys = new Float64Array(this.edges.size), ok = new Uint8Array(this.edges.size);
    let i = 0;
    for (const [k, v] of this.edges) { keys[i] = k; ok[i] = v ? 1 : 0; i++; }
    return { nodes: this.nodes.length, keys, ok };
  }

  /** Take the legs a worker proved (same deterministic graph: same node count) — no proof work on the page at all. */
  importEdges(data: { nodes: number; keys: Float64Array; ok: Uint8Array }, furnitureRevision=0): boolean {
    if (furnitureRevision !== this.furnitureRevision) return false;
    if (data.nodes !== this.nodes.length) return false;
    for (let i = 0; i < data.keys.length; i++) this.edges.set(data.keys[i], data.ok[i] === 1);
    this.warmCursor = this.nodes.length;
    return true;
  }

  /** Graph nodes a free point can walk straight to (nearest first). */
  private attach(p: P): number[] {
    const out: number[] = [];
    const list = this.near(p, NEAR).sort((a, b) => Math.hypot(this.nodes[a].x - p.x, this.nodes[a].z - p.z) - Math.hypot(this.nodes[b].x - p.x, this.nodes[b].z - p.z));
    for (const id of list) {
      if (this.clear(p, this.nodes[id])) out.push(id);
      if (out.length >= 4) break;
    }
    return out;
  }

  /**
   * A* from `from` to `to` over proven legs. The result starts after `from` and ends exactly at `to`; `doors` names each door
   * the leg starting at `index` passes through, so the walker can open it first.
   */
  route(from: P, to: P): Route | null {
    const t0 = performance.now();
    this.stats.routes++;
    try {
      if (!this.walk.free(to)) return null;
      if (Math.hypot(to.x - from.x, to.z - from.z) < 30 && this.clear(from, to)) return this.finish(from, [to]);
      const starts = this.attach(from), goals = new Set(this.attach(to));
      if (!starts.length || !goals.size) return null;
      const g = new Map<number, number>(), came = new Map<number, number>(), open: [number, number][] = [];
      const h = (id: number) => Math.hypot(this.nodes[id].x - to.x, this.nodes[id].z - to.z);
      for (const s of starts) {
        const c = Math.hypot(this.nodes[s].x - from.x, this.nodes[s].z - from.z);
        if (c < (g.get(s) ?? Infinity)) { g.set(s, c); came.set(s, -1); open.push([c + h(s), s]); }
      }
      let end = -1, expanded = 0;
      while (open.length && expanded++ < 6000) {
        let bi = 0;
        for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
        const [, cur] = open[bi];
        open[bi] = open[open.length - 1]; open.pop();
        if (goals.has(cur)) { end = cur; break; }
        const base = g.get(cur)!;
        for (const nb of this.candidates(cur)) {
          const c = base + Math.hypot(this.nodes[nb].x - this.nodes[cur].x, this.nodes[nb].z - this.nodes[cur].z);
          if (c >= (g.get(nb) ?? Infinity)) continue;
          if (!this.edge(cur, nb)) continue;
          g.set(nb, c); came.set(nb, cur); open.push([c + h(nb), nb]);
        }
      }
      if (end < 0) { this.stats.failures++; return null; }
      const chain: P[] = [];
      for (let k = end; k !== -1; k = came.get(k)!) chain.unshift({ x: this.nodes[k].x, z: this.nodes[k].z });
      chain.push(to);
      return this.finish(from, this.smooth(from, chain));
    } finally {
      this.stats.routeMs += performance.now() - t0;
    }
  }

  /** Drop corners a straight proven leg can skip (shorter, more natural walking lines). */
  private smooth(from: P, chain: P[]): P[] {
    const out: P[] = [];
    let at = from, i = 0;
    while (i < chain.length) {
      let j = Math.min(chain.length - 1, i + 3);
      while (j > i && !(Math.hypot(chain[j].x - at.x, chain[j].z - at.z) < 26 && this.clear(at, chain[j]))) j--;
      out.push(chain[j]);
      at = chain[j];
      i = j + 1;
    }
    return out;
  }

  private finish(from: P, points: P[]): Route {
    const doors: Route['doors'] = [];
    let length = 0, prev = from;
    points.forEach((p, index) => {
      length += Math.hypot(p.x - prev.x, p.z - prev.z);
      const seen = new Set<string>();
      const n = Math.max(2, Math.ceil(Math.hypot(p.x - prev.x, p.z - prev.z) / .25));
      for (let k = 0; k <= n; k++) {
        const q = { x: prev.x + (p.x - prev.x) * k / n, z: prev.z + (p.z - prev.z) * k / n };
        for (const d of this.doors) if (!seen.has(d.id) && inRect(q, d.corridor)) { seen.add(d.id); doors.push({ door: d.id, index }); }
      }
      prev = p;
    });
    return { points, doors, length };
  }

  /** Free standing spots inside a zone, spread out and deterministic (residents settle on them; a crowd never piles up). */
  spots(zone: V3ZoneId, count: number): P[] {
    const def = this.city.zones.find(z => z.id === zone);
    if (!def) return [];
    const r = def.rect, out: P[] = [];
    const add = (p: P) => {
      if (this.walk.zone(p) !== zone || !this.walk.free(p)) return;
      if (out.some(q => Math.hypot(q.x - p.x, q.z - p.z) < 1.1)) return;
      out.push(p);
    };
    add(def.waypoint);
    const w = r.x1 - r.x0, d = r.z1 - r.z0, step = Math.max(1.2, Math.sqrt(w * d / (count * 3)));
    for (let ring = 1; out.length < count && ring < 40; ring++) {
      for (let a = 0; a < ring * 6 && out.length < count; a++) {
        const t = a / (ring * 6) * Math.PI * 2;
        const p = { x: def.waypoint.x + Math.cos(t) * ring * step * .55, z: def.waypoint.z + Math.sin(t) * ring * step * .55 };
        if (p.x < r.x0 + BODY_RADIUS || p.x > r.x1 - BODY_RADIUS || p.z < r.z0 + BODY_RADIUS || p.z > r.z1 - BODY_RADIUS) continue;
        add(p);
      }
    }
    return out;
  }
}

/** Two points just beyond either face of a door's opening. */
export function doorEnds(d: Door): [number, number][] {
  const c = d.corridor;
  return d.wallAlong === 'z'
    ? [[c.x0 - .45, d.z], [c.x1 + .45, d.z]]
    : [[d.x, c.z0 - .45], [d.x, c.z1 + .45]];
}
