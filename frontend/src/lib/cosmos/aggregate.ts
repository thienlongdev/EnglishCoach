/**
 * Progressive disclosure of edges. At a distance, many relations between two communities are ONE bundled strand whose count
 * and members stay inspectable; up close the real edges appear. Hiding is never deletion: every bundle lists its edge ids.
 */
import type { Category } from './ontology';
import type { CosmosGraph } from './types';

export type Level = 'universe' | 'galaxy' | 'constellation' | 'system' | 'star';
export interface Bundle { key: string; a: number; b: number; kind: 'galaxy' | 'constellation'; edges: number[]; categories: Partial<Record<Category, number>>;
  /** Drawn as a short fading stub from `from` toward the other end (up close, so no line crosses the whole screen). */
  stub?: boolean; from?: number }

export function bundles(graph: CosmosGraph, kind: 'galaxy' | 'constellation', filter: (edge: number) => boolean, within?: number): Bundle[] {
  const out = new Map<string, Bundle>();
  for (const e of graph.edges) {
    if (!filter(e.i) || e.note === 'concept') continue;
    const s = graph.nodes[e.s], t = graph.nodes[e.t];
    const a = kind === 'galaxy' ? s.galaxy : s.constellation, b = kind === 'galaxy' ? t.galaxy : t.constellation;
    if (a === b || a < 0 || b < 0) continue;
    if (within !== undefined && s.galaxy !== within && t.galaxy !== within) continue;
    const [x, y] = a < b ? [a, b] : [b, a];
    const key = `${kind}:${x}:${y}`;
    let bu = out.get(key);
    if (!bu) { bu = { key, a: x, b: y, kind, edges: [], categories: {} }; out.set(key, bu); }
    bu.edges.push(e.i);
    bu.categories[e.category] = (bu.categories[e.category] ?? 0) + 1;
  }
  return [...out.values()].sort((p, q) => q.edges.length - p.edges.length);
}

/** The dominant category of a bundle (its colour). */
export function dominant(b: Bundle): Category {
  let best: Category = 'lexical', n = -1;
  for (const [k, v] of Object.entries(b.categories) as [Category, number][]) if (v > n) { best = k; n = v; }
  return best;
}
