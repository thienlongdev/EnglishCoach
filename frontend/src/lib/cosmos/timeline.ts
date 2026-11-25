/**
 * Neural Time Travel: the universe as it was at time T, rebuilt only from evidence recorded at or before T.
 * A star exists if it was discovered by T; an edge if both ends were known by T (the relation itself is a fact of the
 * language, stated by the lexicon version in use); a rating counts only if it was given by T. Nothing learned later leaks
 * into an earlier frame. A slice depends only on HOW MANY events happened by T (every relevant time is an event time), so
 * slices are cached by that count: exact at any T, and scrubbing reuses them.
 */
import type { CosmosGraph } from './types';

export interface Slice {
  t: number;
  nodeVisible: Uint8Array;  // 1 = discovered by t
  edgeVisible: Uint8Array;
  /** Latest rating at t: -1 none, 0 hard, 1 good, 2 easy. */
  lastRating: Int8Array;
  hardCount: Uint16Array;
  counts: { stars: number; edges: number; constellations: number };
}

/** Memory allowed for cached slices (performance release 2026-11-16, PERF-14): a dense graph keeps fewer, a small one more. */
const SLICE_BUDGET_BYTES = 24 * 1024 * 1024;
const MIN_SLICES = 24;
const MAX_SLICES = 450;

export class Timeline {
  readonly start: number;
  readonly end: number;
  /** Least recently used first (Map insertion order; a hit moves its slice to the end). */
  private cache = new Map<number, Slice>();
  private readonly times: number[];
  private readonly maxSlices: number;
  constructor(private graph: CosmosGraph) {
    this.times = graph.events.map(e => e.t).filter(t => t > 0 && t < Number.MAX_SAFE_INTEGER).sort((a, b) => a - b);
    this.start = this.times.length ? this.times[0] : graph.generatedAt;
    this.end = Math.max(this.times.length ? this.times[this.times.length - 1] : graph.generatedAt, graph.generatedAt);
    // bytes of one slice: nodeVisible 1 + lastRating 1 + hardCount 2 per node, edgeVisible 1 per edge
    const sliceBytes = Math.max(1, graph.nodes.length * 4 + graph.edges.length);
    this.maxSlices = Math.max(MIN_SLICES, Math.min(MAX_SLICES, Math.floor(SLICE_BUDGET_BYTES / sliceBytes)));
  }

  /** Index of the event-count slice that holds t: equal indices give the very same slice (exact, cached). */
  indexAt(t: number): number {
    return this.count(t);
  }

  /** Number of events at or before t (binary search). */
  private count(t: number): number {
    let lo = 0, hi = this.times.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.times[mid] <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  at(t: number): Slice {
    const k = this.count(t);
    const hit = this.cache.get(k);
    if (hit) { this.cache.delete(k); this.cache.set(k, hit); return hit; }
    const tt = k > 0 ? this.times[k - 1] : this.start - 1;
    const { nodes, edges, constellations } = this.graph;
    const nodeVisible = new Uint8Array(nodes.length), lastRating = new Int8Array(nodes.length).fill(-1), hardCount = new Uint16Array(nodes.length);
    let stars = 0;
    for (const n of nodes) {
      if (n.discoveredAt <= tt) { nodeVisible[n.i] = 1; if (n.kind !== 'concept' && !(n.kind === 'word' && !n.cardIds.length)) stars++; }
      for (const [rt, q] of n.ratings) { if (rt > tt) break; lastRating[n.i] = q; if (q === 0) hardCount[n.i]++; }
    }
    const edgeVisible = new Uint8Array(edges.length);
    let edgeCount = 0;
    for (const e of edges) if (e.at <= tt && nodeVisible[e.s] && nodeVisible[e.t]) { edgeVisible[e.i] = 1; if (e.status === 'VERIFIED') edgeCount++; }
    let cons = 0;
    for (const c of constellations) if (c.createdAt <= tt) cons++;
    const slice: Slice = { t: tt, nodeVisible, edgeVisible, lastRating, hardCount, counts: { stars, edges: edgeCount, constellations: cons } };
    // evict the least recently used slices one by one (never the whole cache at once: scrubbing back stays warm)
    while (this.cache.size >= this.maxSlices) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(k, slice);
    return slice;
  }
}
