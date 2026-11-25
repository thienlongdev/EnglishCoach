/* Echo Odyssey — Journey Atlas layout (pure, no DOM). One region's stations become knowledge branches (lanes, by
   Grammar domain) laid out top to bottom: each row is a prerequisite depth inside its branch, rows wrap to the
   available width, so the atlas never needs a horizontal scrollbar. Links are drawn only between real prerequisites
   inside a branch; prerequisites in another branch or region are listed on the node and highlighted on selection.
   The layout never invents, drops or reorders a dependency: it only positions what the server sent. */
import type { Station } from './types';

export const NODE_W = 236, NODE_H = 92, GAP_X = 22, GAP_Y = 46, LANE_HEAD = 56, LANE_GAP = 30, PAD = 22;

export interface AtlasNode { id: string; station: Station; lane: string; depth: number; x: number; y: number; w: number; h: number;
  /** Prerequisites of this node outside its own branch (other branch of the region, or another region). */
  outside: string[] }
export interface AtlasEdge { from: string; to: string; path: string }
export interface AtlasLane { id: string; kind: 'today' | 'grammar' | 'explore'; y: number; h: number; stations: Station[] }
export interface AtlasLayout { nodes: AtlasNode[]; edges: AtlasEdge[]; lanes: AtlasLane[]; width: number; height: number; columns: number }

export const slugOf = (id: string) => id.startsWith('grammar:') ? id.slice(8) : id;

/** Columns that fit the width (at least one). */
export function columnsFor(width: number) { return Math.max(1, Math.floor((width - 2 * PAD + GAP_X) / (NODE_W + GAP_X))); }

export function layoutRegion(stations: Station[], width: number, domainOrder: string[] = []): AtlasLayout {
  const columns = columnsFor(width);
  const rowWidth = (n: number) => n * NODE_W + (n - 1) * GAP_X;
  const groups = new Map<string, Station[]>();
  const today: Station[] = [], explore: Station[] = [];
  for (const s of stations) {
    if (s.kind === 'GRAMMAR') { const k = s.domain || s.skill; groups.set(k, [...(groups.get(k) ?? []), s]); }
    else if (s.kind === 'WORKFLOW') explore.push(s); else today.push(s);
  }
  const order = (id: string) => { const i = domainOrder.indexOf(id); return i < 0 ? 999 : i; };
  const laneIds = [...groups.keys()].sort((a, b) => order(a) - order(b));
  const nodes: AtlasNode[] = [], edges: AtlasEdge[] = [], lanes: AtlasLane[] = [];
  let y = PAD;
  const placeRow = (items: Station[], lane: string, depth: number, outside: (s: Station) => string[], xs: Map<string, number>) => {
    for (let start = 0; start < items.length; start += columns) {
      const row = items.slice(start, start + columns), left = Math.max(PAD, (width - rowWidth(row.length)) / 2);
      row.forEach((s, i) => { const x = left + i * (NODE_W + GAP_X); xs.set(s.id, x); nodes.push({ id: s.id, station: s, lane, depth, x, y, w: NODE_W, h: NODE_H, outside: outside(s) }); });
      y += NODE_H + GAP_Y;
    }
  };
  // Today's quests first: they are the plan of the day (no prerequisite links between them).
  if (today.length) {
    const top = y; y += LANE_HEAD;
    placeRow(today, 'today', 0, () => [], new Map());
    lanes.push({ id: 'today', kind: 'today', y: top, h: y - top - GAP_Y, stations: today }); y += LANE_GAP - GAP_Y + GAP_Y;
  }
  for (const lane of laneIds) {
    const items = groups.get(lane)!, inLane = new Map(items.map(s => [slugOf(s.id), s]));
    // Longest path of prerequisites inside the branch = the row of a node (cycle-safe; the source graph is acyclic).
    const depth = new Map<string, number>();
    const depthOf = (s: Station, stack = new Set<string>()): number => {
      const known = depth.get(s.id); if (known !== undefined) return known;
      if (stack.has(s.id)) return 0;
      const next = new Set(stack).add(s.id);
      const parents = s.prerequisites.map(p => inLane.get(p)).filter((v): v is Station => !!v);
      const d = parents.length ? 1 + Math.max(...parents.map(p => depthOf(p, next))) : 0;
      depth.set(s.id, d); return d;
    };
    items.forEach(s => depthOf(s));
    const top = y; y += LANE_HEAD;
    const xs = new Map<string, number>();
    const maxDepth = Math.max(0, ...depth.values());
    for (let d = 0; d <= maxDepth; d++) {
      const index = new Map(items.map((s, i) => [s.id, i]));
      // Order a row by where its parents stand (fewer crossings), keeping the server's order otherwise.
      const row = items.filter(s => depth.get(s.id) === d).map(s => {
        const px = s.prerequisites.map(p => inLane.get(p)).filter((v): v is Station => !!v).map(p => xs.get(p.id) ?? 0);
        return { s, key: px.length ? px.reduce((a, b) => a + b, 0) / px.length : index.get(s.id)! * 1e-3 - 1e6 };
      }).sort((a, b) => a.key - b.key || index.get(a.s.id)! - index.get(b.s.id)!).map(v => v.s);
      placeRow(row, lane, d, s => s.prerequisites.filter(p => !inLane.has(p)), xs);
    }
    lanes.push({ id: lane, kind: 'grammar', y: top, h: y - top - GAP_Y, stations: items });
    y += LANE_GAP;
  }
  if (explore.length) {
    const top = y; y += LANE_HEAD;
    placeRow(explore, 'explore', 0, () => [], new Map());
    lanes.push({ id: 'explore', kind: 'explore', y: top, h: y - top - GAP_Y, stations: explore }); y += LANE_GAP;
  }
  // Links: parent bottom → child top, inside a branch only (both ends are real stations of that branch).
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const n of nodes) {
    if (n.station.kind !== 'GRAMMAR') continue;
    for (const p of n.station.prerequisites) {
      const parent = byId.get('grammar:' + p); if (!parent || parent.lane !== n.lane) continue;
      const x1 = parent.x + NODE_W / 2, y1 = parent.y + NODE_H, x2 = n.x + NODE_W / 2, y2 = n.y, dy = Math.max(16, (y2 - y1) * 0.5);
      edges.push({ from: parent.id, to: n.id, path: `M${x1.toFixed(1)},${y1.toFixed(1)} C${x1.toFixed(1)},${(y1 + dy).toFixed(1)} ${x2.toFixed(1)},${(y2 - dy).toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}` });
    }
  }
  return { nodes, edges, lanes, width, height: y - LANE_GAP + PAD, columns };
}

/** Every prerequisite of a station (all branches, all regions), and every station it opens. */
export function relations(id: string, all: Station[]) {
  const bySlug = new Map(all.filter(s => s.kind === 'GRAMMAR').map(s => [slugOf(s.id), s]));
  const station = all.find(s => s.id === id);
  const before = (station?.prerequisites ?? []).map(p => bySlug.get(p)).filter((s): s is Station => !!s);
  const after = all.filter(s => s.kind === 'GRAMMAR' && s.prerequisites.includes(slugOf(id)));
  return { before, after };
}

/** The chain of prerequisites (ancestors) of a station, for highlighting. */
export function ancestors(id: string, all: Station[]) {
  const bySlug = new Map(all.filter(s => s.kind === 'GRAMMAR').map(s => [slugOf(s.id), s]));
  const out = new Set<string>(), stack = [id];
  while (stack.length) {
    const s = all.find(v => v.id === stack.pop()) ?? null; if (!s) continue;
    for (const p of s.prerequisites) { const parent = bySlug.get(p); if (parent && !out.has(parent.id)) { out.add(parent.id); stack.push(parent.id); } }
  }
  return out;
}
