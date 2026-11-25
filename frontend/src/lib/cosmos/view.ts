/**
 * Progressive disclosure: what one zoom level shows. Render the minimum needed to understand the current context while
 * every hidden relation stays reachable (bundles list their edges; a focused star lists all of its edges). Pure function.
 */
import { bundles, type Bundle, type Level } from './aggregate';
import type { Category } from './ontology';
import type { Slice } from './timeline';
import { memoryCode, memoryOf, MEMORY_CODE } from './memory';
import type { CosmosGraph } from './types';

export interface Focus { level: Level; galaxy: number; constellation: number; system: number; node: number }
export const UNIVERSE: Focus = { level: 'universe', galaxy: -1, constellation: -1, system: -1, node: -1 };

export interface Filters { categories: Record<Category, boolean>; suggestions: boolean; allSenses: boolean; frontier: boolean; met: boolean }
export const DEFAULT_FILTERS: Filters = {
  categories: { lexical: true, hierarchy: true, part: true, family: true, expression: true, grammar: true, source: true, transfer: true, suggested: true },
  // frontier = the third knowledge layer ("Có thể khám phá": verified WordNet neighbours you have not met): opt-in, bounded
  suggestions: false, allSenses: false, frontier: false, met: true,
};
/** Discoverable layer budget: ghosts around one star, and around a whole system (never thousands of WordNet nodes). */
export const DISCOVER_CAP = { star: 8, perMember: 3, system: 24 };

/** Bit flags shared with the star shader. fresh = discovered since the learner's last visit / during this visit. */
export const FLAG = { selected: 1, neighbour: 2, weak: 4, gap: 8, concept: 16, context: 32, fresh: 64, due: 128 } as const;

export interface LabelCandidate { key: string; text: string; x: number; y: number; z: number; priority: number; kind: 'galaxy' | 'constellation' | 'system' | 'star' | 'ghost'; node: number; community: number }
export interface Ghost { lemma: string; x: number; y: number; z: number; from: number; type: string }
export interface ViewModel {
  starAlpha: Float32Array; starScale: Float32Array; starFlag: Uint8Array;
  /** Memory state per star at the frame's moment (memory.ts code, + 16 for cross-skill); 0 = not a knowledge star. */
  starMem: Uint8Array;
  edges: number[]; bundles: Bundle[]; labels: LabelCandidate[]; ghosts: Ghost[];
  /** How many verified relations exist in the focused context but are not drawn (shown as a count, never lost). */
  hiddenEdges: number;
  /** Knowledge stars per galaxy / constellation in THIS frame (time travel counts only what existed by T). */
  counts: { galaxy: Int32Array; constellation: Int32Array };
}

/** Caps per level (anti-clutter budget). */
export const CAPS = { universeStrands: 6, galaxyStrands: 36, constellationEdges: 500, constellationStrands: 12, systemEdges: 400, starLabels: 60 };

export function edgeAllowed(graph: CosmosGraph, i: number, filters: Filters, slice: Slice | null): boolean {
  const e = graph.edges[i];
  if (!filters.categories[e.category]) return false;
  if (e.status === 'SUGGESTED' && !filters.suggestions) return false;
  if ((!e.posMatch || !e.common) && !filters.allSenses) return false;
  if (slice && !slice.edgeVisible[i]) return false;
  return true;
}

export function computeView(graph: CosmosGraph, focus: Focus, filters: Filters, slice: Slice | null): ViewModel {
  const { nodes, edges } = graph;
  const N = nodes.length;
  const starAlpha = new Float32Array(N), starScale = new Float32Array(N), starFlag = new Uint8Array(N), starMem = new Uint8Array(N);
  const isMetNode = (i: number) => nodes[i].kind === 'word' && nodes[i].cardIds.length === 0;
  const visible = (i: number) => (!slice || slice.nodeVisible[i] === 1) && (filters.met || !isMetNode(i));
  const allowed = (i: number) => edgeAllowed(graph, i, filters, slice);
  const labels: LabelCandidate[] = [];
  const ghosts: Ghost[] = [];
  let drawn: number[] = [];
  let strands: Bundle[] = [];
  let hiddenEdges = 0;

  const counts = { galaxy: new Int32Array(graph.galaxies.length), constellation: new Int32Array(graph.constellations.length) };
  for (const n of nodes) if (visible(n.i) && n.kind !== 'concept' && !isMetNode(n.i)) { counts.galaxy[n.galaxy]++; if (n.constellation >= 0) counts.constellation[n.constellation]++; }
  // memory state at the frame's moment (time travel: only evidence recorded by then)
  const t = slice ? slice.t : graph.generatedAt;
  for (const n of nodes) if (visible(n.i) && (n.kind === 'word' || n.kind === 'grammar')) starMem[n.i] = memoryCode(memoryOf(n, t, graph.generatedAt));
  for (const n of nodes) {
    if (!visible(n.i)) continue;
    const weak = slice ? slice.lastRating[n.i] === 0 : n.weak;
    const gap = slice ? weak && slice.hardCount[n.i] >= 3 : n.gap;
    // due = the Flashcards scheduler's stored next review has passed; the schedule has no history, so only "now" (never in time travel)
    const due = !slice && n.kind === 'word' && n.dueAt > 0 && n.dueAt <= graph.generatedAt && n.stage !== 'saved';
    starFlag[n.i] = (weak ? FLAG.weak : 0) | (gap ? FLAG.gap : 0) | (n.kind === 'concept' ? FLAG.concept : 0) | (due ? FLAG.due : 0);
  }

  const inGalaxy = (i: number) => nodes[i].galaxy === focus.galaxy;
  const inCons = (i: number) => nodes[i].constellation === focus.constellation;
  const inSystem = (i: number) => nodes[i].system === focus.system;

  // Level of detail: from afar a galaxy is an aggregate; only its brightest stars are drawn (the rest appear on approach).
  const bright = brightest(graph);
  if (focus.level === 'universe') {
    for (const n of nodes) if (visible(n.i) && bright[n.i] < LOD.universePerGalaxy) { starAlpha[n.i] = n.kind === 'concept' ? 0 : 0.55; starScale[n.i] = 0.45; }
    strands = bundles(graph, 'galaxy', allowed).slice(0, CAPS.universeStrands);
    graph.galaxies.forEach(g => { if (counts.galaxy[g.i]) labels.push(cLabel(g, 'galaxy', 100 + counts.galaxy[g.i])); });
  } else if (focus.level === 'galaxy') {
    for (const n of nodes) if (visible(n.i)) {
      const own = inGalaxy(n.i);
      if (!own && bright[n.i] >= LOD.otherGalaxy) continue;
      starAlpha[n.i] = n.kind === 'concept' ? (own ? 0.35 : 0) : own ? 0.9 : 0.25;
      starScale[n.i] = own ? 0.7 : 0.4;
    }
    const inner = bundles(graph, 'constellation', i => allowed(i) && inGalaxy(edges[i].s) && inGalaxy(edges[i].t));
    const outer = bundles(graph, 'galaxy', allowed, focus.galaxy);
    strands = [...inner.slice(0, CAPS.galaxyStrands), ...outer.slice(0, 4).map(b => ({ ...b, stub: true, from: focus.galaxy }))];
    hiddenEdges = Math.max(0, inner.length - CAPS.galaxyStrands);
    graph.constellations.forEach(c => { if (counts.constellation[c.i] && c.galaxy === focus.galaxy) labels.push(cLabel(c, 'constellation', 80 + counts.constellation[c.i])); });
    graph.galaxies.forEach(g => { if (counts.galaxy[g.i] && g.i !== focus.galaxy) labels.push(cLabel(g, 'galaxy', 40)); });
  } else if (focus.level === 'constellation') {
    for (const n of nodes) if (visible(n.i)) {
      const own = inCons(n.i);
      starAlpha[n.i] = own ? (n.kind === 'concept' ? 0.6 : 1) : inGalaxy(n.i) ? 0.3 : 0.12;
      starScale[n.i] = own ? 1 : 0.5;
      if (own) starFlag[n.i] |= FLAG.context;
      if (own && n.kind !== 'concept') labels.push(sLabel(n.i, 30 + n.size * 10 + (n.status === 'MASTERED' ? 6 : 0)));
    }
    const local = edges.filter(e => allowed(e.i) && inCons(e.s) && inCons(e.t)).sort((a, b) => rankEdge(graph, b.i) - rankEdge(graph, a.i));
    drawn = local.slice(0, CAPS.constellationEdges).map(e => e.i);
    hiddenEdges = local.length - drawn.length;
    strands = bundles(graph, 'constellation', i => allowed(i) && (inCons(edges[i].s) !== inCons(edges[i].t))).filter(b => b.a === focus.constellation || b.b === focus.constellation).slice(0, CAPS.constellationStrands)
      .map(b => ({ ...b, stub: true, from: focus.constellation }));
    graph.systems.forEach(s => { if (s.constellation === focus.constellation && s.center >= 0 && nodes[s.center].kind === 'concept' && s.count > 1 && visible(s.center)) labels.push({ ...cLabel(s, 'system', 70 + s.count), node: s.center }); });
  } else {
    // system or star: the neighbourhood is legible on its own; everything else fades but stays in place.
    const centre = focus.level === 'star' ? focus.node : -1;
    const near = new Set<number>();
    const mine = edges.filter(e => allowed(e.i) && (centre >= 0 ? e.s === centre || e.t === centre : inSystem(e.s) || inSystem(e.t)));
    drawn = mine.slice(0, CAPS.systemEdges).map(e => e.i);
    hiddenEdges = mine.length - drawn.length;
    for (const i of drawn) { near.add(edges[i].s); near.add(edges[i].t); }
    for (const n of nodes) if (visible(n.i)) {
      const own = centre >= 0 ? n.i === centre : inSystem(n.i);
      const neighbour = near.has(n.i) && !own;
      starAlpha[n.i] = own ? 1 : neighbour ? 0.95 : inCons(n.i) ? 0.22 : 0.08;
      starScale[n.i] = own ? 1.35 : neighbour ? 1 : 0.55;
      if (own) starFlag[n.i] |= centre >= 0 ? FLAG.selected : FLAG.context;
      if (neighbour) starFlag[n.i] |= FLAG.neighbour;
      if (own || neighbour) labels.push(sLabel(n.i, own ? 200 : 60 + n.size * 10));
    }
    if (filters.frontier) {
      // the discoverable layer: verified neighbours not yet learned, around the star (or each member of the system), bounded
      const around = (i: number, take: number) => {
        const c = nodes[i];
        if (c.kind !== 'word' || (slice && !slice.nodeVisible[i])) return;
        const fr = c.frontier.slice(0, take);
        fr.forEach((f, k) => {
          if (ghosts.length >= (centre >= 0 ? DISCOVER_CAP.star : DISCOVER_CAP.system)) return;
          const a = (k / Math.max(1, fr.length)) * Math.PI * 2 + 0.4, r = 9 + (k % 2) * 3;
          ghosts.push({ lemma: f.lemma, x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r * 0.6, z: c.z + Math.sin(a) * r * 0.5, from: i, type: f.type });
        });
      };
      if (centre >= 0) around(centre, DISCOVER_CAP.star);
      else for (const n of nodes) if (inSystem(n.i) && visible(n.i)) around(n.i, DISCOVER_CAP.perMember);
      // named, quieter than every learned star (a ghost label never wins a place over knowledge)
      for (const gh of ghosts) labels.push({ key: `ghost:${nodes[gh.from].id}:${gh.lemma}`, text: gh.lemma, x: gh.x, y: gh.y, z: gh.z, priority: 15, kind: 'ghost', node: gh.from, community: -1 });
    }
  }
  // The met layer and fading memories are quieter, never louder, than what was studied; labels of met words lose to studied ones.
  for (let i = 0; i < N; i++) {
    const m = starMem[i] & 15;
    if (m === MEMORY_CODE.met) { starAlpha[i] *= 0.42; starScale[i] *= 0.7; }
    else if (m === MEMORY_CODE.fading) starAlpha[i] *= 0.72;
    else if (m === MEMORY_CODE.atRisk) starAlpha[i] *= 0.58;
  }
  for (const l of labels) if (l.node >= 0 && isMetNode(l.node) && !(focus.level === 'star' && l.node === focus.node)) l.priority -= 40;
  return { starAlpha, starScale, starFlag, starMem, edges: drawn, bundles: strands, labels, ghosts, hiddenEdges, counts };

  function cLabel(c: { i: number; vi: string; en: string; x: number; y: number; z: number; key: string }, kind: 'galaxy' | 'constellation' | 'system', priority: number): LabelCandidate {
    return { key: `${kind}:${c.key}`, text: '', x: c.x, y: c.y, z: c.z, priority, kind, node: -1, community: c.i };
  }
  function sLabel(i: number, priority: number): LabelCandidate {
    const n = nodes[i];
    return { key: `n:${n.id}`, text: n.kind === 'grammar' ? n.sub || n.label : n.label, x: n.x, y: n.y, z: n.z, priority, kind: 'star', node: i, community: -1 };
  }
}

/** Stars drawn per galaxy from afar (universe level) and for the galaxies around a focused one. */
export const LOD = { universePerGalaxy: 120, otherGalaxy: 60 };
const brightCache = new WeakMap<CosmosGraph, Int32Array>();
/** A star's brightness rank inside its galaxy (0 = brightest): size first, then id (stable). Concepts rank last. */
export function brightest(graph: CosmosGraph): Int32Array {
  const hit = brightCache.get(graph);
  if (hit) return hit;
  const rank = new Int32Array(graph.nodes.length).fill(1 << 30);
  const byGalaxy = new Map<number, typeof graph.nodes>();
  for (const n of graph.nodes) if (n.kind !== 'concept') { const a = byGalaxy.get(n.galaxy); if (a) a.push(n); else byGalaxy.set(n.galaxy, [n]); }
  for (const list of byGalaxy.values()) [...list].sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1)).forEach((n, k) => { rank[n.i] = k; });
  brightCache.set(graph, rank);
  return rank;
}

/** Edge importance for the density budget: lexical meaning first, then structure, then evidence. */
function rankEdge(graph: CosmosGraph, i: number) {
  const e = graph.edges[i];
  const base = { lexical: 6, part: 5, family: 4, expression: 4, grammar: 4, hierarchy: 3, transfer: 3, source: 1, suggested: 0 }[e.category];
  return base * 10 + Math.min(9, graph.nodes[e.s].degree + graph.nodes[e.t].degree) - (e.note === 'concept' ? 15 : 0);
}

/** Greedy, priority-ordered, collision-free label placement in screen space with hysteresis (no flicker). */
export interface Placed { key: string; x: number; y: number; w: number; h: number }
export function placeLabels(cands: { key: string; sx: number; sy: number; w: number; h: number; priority: number; depth: number }[], width: number, height: number,
  previous: Set<string>, max: number): Placed[] {
  const sorted = [...cands].sort((a, b) => (b.priority + (previous.has(b.key) ? 25 : 0)) - (a.priority + (previous.has(a.key) ? 25 : 0)) || a.depth - b.depth);
  const placed: Placed[] = [];
  for (const c of sorted) {
    if (placed.length >= max) break;
    // above the point first, then below, right and left: a label moves before it is dropped
    const spots: [number, number][] = [[c.sx - c.w / 2, c.sy - c.h - 8], [c.sx - c.w / 2, c.sy + 10], [c.sx + 12, c.sy - c.h / 2], [c.sx - c.w - 12, c.sy - c.h / 2]];
    for (const [x, y] of spots) {
      if (x < 4 || y < 4 || x + c.w > width - 4 || y + c.h > height - 4) continue;
      let clash = false;
      for (const p of placed) if (x < p.x + p.w + 4 && x + c.w + 4 > p.x && y < p.y + p.h + 2 && y + c.h + 2 > p.y) { clash = true; break; }
      if (!clash) { placed.push({ key: c.key, x, y, w: c.w, h: c.h }); break; }
    }
  }
  return placed;
}
