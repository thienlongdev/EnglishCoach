import type { Focus } from './view';

/** A projection of existing Cosmos groups. These parent links never become semantic graph edges. */
export interface TreeItem {
  id: string; kind: 'universe' | 'galaxy' | 'constellation' | 'system' | 'star'; label: string; sub: string;
  count: number; met?: number; depth: number; parent: string; node: number; focus: Focus; color: string;
}
export interface TreeIndex { root: TreeItem; kids: Map<string, TreeItem[]>; byId: Map<string, TreeItem> }
export interface TreeBox { id: string; item: TreeItem; parent: string; x: number; y: number; w: number; h: number; side: number; remaining: number }
export interface TreeLayout { boxes: TreeBox[]; paths: { id: string; parent: string; d: string; color: string }[]; bounds: { x: number; y: number; w: number; h: number } }

/** Bilateral tidy tree: sibling subtrees own disjoint vertical intervals; columns account for actual label sizes.
 * Domain sides depend only on the original order, so expanding a branch never throws it across the trunk.
 * Disclosure controls represent hidden children honestly. Every child is reachable through more/search/the outline.
 */
export function layoutKnowledgeTree(index: TreeIndex, rows: TreeItem[], limits: ReadonlyMap<string, number>, selected = '',
  measure: (text: string) => number = text => Array.from(text).length * 7.2): TreeLayout {
  const allowed = new Set(rows.map(t => t.id));
  const chosenAncestors = new Set<string>();
  let chosen = index.byId.get(selected);
  while (chosen?.parent) { chosenAncestors.add(chosen.id); chosen = index.byId.get(chosen.parent); }
  const sizes = new Map<string, { w: number; h: number }>();
  const children = new Map<string, { item: TreeItem; more: number }[]>();
  const widths = [224, 0, 0, 0, 0];
  const size = (t: TreeItem, more = 0) => {
    const w = more ? 194 : t.kind === 'universe' ? 224 : Math.max(t.kind === 'star' ? 190 : 216, Math.min(286, measure(t.label) + 86));
    const lines = Math.max(1, Math.ceil(measure(t.label) / (w - 78)));
    const h = more ? 44 : t.kind === 'universe' ? 112 : Math.max(t.kind === 'star' ? 76 : 86, 48 + lines * 20);
    return { w, h };
  };
  const prepare = (t: TreeItem) => {
    const dim = size(t); sizes.set(t.id, dim); widths[t.depth] = Math.max(widths[t.depth] || 0, dim.w);
    const all = (index.kids.get(t.id) ?? []).filter(c => allowed.has(c.id));
    const cap = t.kind === 'universe' ? all.length : limits.get(t.id) ?? 6;
    const shown = all.filter((c, i) => i < cap || chosenAncestors.has(c.id));
    const list = shown.map(item => ({ item, more: 0 }));
    if (shown.length < all.length) list.push({ item: t, more: all.length - shown.length });
    children.set(t.id, list);
    shown.forEach(prepare);
  };
  prepare(index.root);
  const span = new Map<string, number>();
  const gap = 24;
  const extent = (t: TreeItem): number => {
    const total = (children.get(t.id) ?? []).reduce((sum, c) => sum + (c.more ? 44 : extent(c.item)) + gap, -gap);
    const value = Math.max(sizes.get(t.id)!.h, total); span.set(t.id, value); return value;
  };
  extent(index.root);
  const columns = [0];
  for (let d = 1; d < widths.length; d++) columns[d] = columns[d - 1] + (widths[d - 1] + widths[d]) / 2 + 82;
  const boxes: TreeBox[] = [];
  const place = (t: TreeItem, cy: number, side: number) => {
    const dim = sizes.get(t.id)!;
    boxes.push({ id: t.id, item: t, parent: t.parent, x: columns[t.depth] * side, y: cy, ...dim, side, remaining: 0 });
    const list = children.get(t.id) ?? [];
    const total = list.reduce((sum, c) => sum + (c.more ? 44 : span.get(c.item.id)!) + gap, -gap);
    let y = cy - total / 2;
    for (const c of list) {
      const h = c.more ? 44 : span.get(c.item.id)!;
      if (c.more) boxes.push({ id: `more:${t.id}`, item: t, parent: t.id, x: columns[t.depth + 1] * side, y: y + h / 2, ...size(t, c.more), side, remaining: c.more });
      else place(c.item, y + h / 2, side);
      y += h + gap;
    }
  };
  const root = index.root;
  boxes.push({ id: root.id, item: root, parent: '', x: 0, y: 0, ...sizes.get(root.id)!, side: 0, remaining: 0 });
  const domains = children.get(root.id) ?? [];
  for (const side of [-1, 1]) {
    const branch = domains.filter((_, i) => (i % 2 ? 1 : -1) === side);
    const total = branch.reduce((sum, c) => sum + span.get(c.item.id)! + 42, -42);
    let y = -total / 2;
    for (const c of branch) { const h = span.get(c.item.id)!; place(c.item, y + h / 2, side); y += h + 42; }
  }
  const lookup = new Map(boxes.map(b => [b.id, b]));
  const paths = boxes.filter(b => b.parent).map(b => {
    const p = lookup.get(b.parent)!;
    const x1 = p.x + b.side * p.w / 2, x2 = b.x - b.side * b.w / 2;
    const mid = (x1 + x2) / 2;
    return { id: b.id, parent: b.parent, color: b.item.color, d: `M${x1},${p.y} C${mid},${p.y} ${mid},${b.y} ${x2},${b.y}` };
  });
  const x = Math.min(...boxes.map(b => b.x - b.w / 2)), y = Math.min(...boxes.map(b => b.y - b.h / 2));
  return { boxes, paths, bounds: { x, y, w: Math.max(...boxes.map(b => b.x + b.w / 2)) - x, h: Math.max(...boxes.map(b => b.y + b.h / 2)) - y } };
}
