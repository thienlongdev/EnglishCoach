import assert from 'node:assert/strict';
import { tsLoader } from './lib/ts-load.mjs';
const { layoutKnowledgeTree } = tsLoader()('lib/cosmos/treeLayout.ts');
const make = (id, parent, depth, kind, label = id) => ({ id, parent, depth, kind, label, sub: '', color: '#56aada', count: 12, node: -1, focus: {} });
const root = make('u', '', 0, 'universe'), kids = new Map(), byId = new Map([['u', root]]);
const add = n => { byId.set(n.id, n); kids.set(n.parent, [...(kids.get(n.parent) || []), n]); return n; };
for (let i = 0; i < 11; i++) {
  const g = add(make(`g${i}`, 'u', 1, 'galaxy', `Miền kiến thức số ${i}`));
  for (let j = 0; j < 20; j++) {
    const c = add(make(`c${i}:${j}`, g.id, 2, 'constellation', j === 2 ? 'A particularly long multilingual topic with a readable wrapped label' : `Chủ đề ${j}`));
    for (let k = 0; k < 24; k++) add(make(`s${i}:${j}:${k}`, c.id, 3, 'star', `knowledge-${k}`));
  }
}
const index = { root, kids, byId }, rows = [...byId.values()];
const original = JSON.stringify(rows);
const t = performance.now(), layout = layoutKnowledgeTree(index, rows, new Map());
assert.ok(performance.now() - t < 1500, '5,000-node source projection stays bounded');
assert.equal(JSON.stringify(rows), original, 'layout never modifies facts');
assert.equal(layout.paths.length, layout.boxes.length - 1, 'exactly one hierarchy path per visible non-root box');
assert.equal(layout.boxes.filter(b => b.item.kind === 'galaxy' && !b.remaining).length, 11, 'genuine multi-child root, not forced binary');
assert.ok(layout.boxes.some(b => b.x < 0) && layout.boxes.some(b => b.x > 0), 'both sides of the trunk');
for (const b of layout.boxes) {
  assert.ok(Number.isFinite(b.x + b.y + b.w + b.h));
  if (b.remaining) assert.ok(kids.get(b.parent).length >= b.remaining, 'disclosure is honest');
  else assert.equal(b.parent, byId.get(b.id).parent, 'hierarchy relationship unchanged');
}
for (let i = 0; i < layout.boxes.length; i++) for (let j = i + 1; j < layout.boxes.length; j++) {
  const a = layout.boxes[i], b = layout.boxes[j];
  assert.ok(Math.abs(a.x - b.x) >= (a.w + b.w) / 2 || Math.abs(a.y - b.y) >= (a.h + b.h) / 2, `no overlap: ${a.id}/${b.id}`);
}
const deep = 's9:19:23', selected = layoutKnowledgeTree(index, rows, new Map(), deep);
assert.ok(selected.boxes.some(b => b.id === deep), 'a selected star beyond the disclosure page is revealed');
assert.ok(selected.boxes.some(b => b.id === 'c9:19'), 'its real ancestor is included');
const expanded = layoutKnowledgeTree(index, rows, new Map([['g0', 30], ['c0:19', 30]]));
assert.equal(expanded.boxes.filter(b => b.parent === 'c0:19' && !b.remaining).length, 24, 'last child reachable by disclosure');
for (const g of layout.boxes.filter(b => b.item.kind === 'galaxy' && !b.remaining)) assert.equal(Math.sign(g.x), Math.sign(expanded.boxes.find(b => b.id === g.id).x), 'expansion preserves branch side');
const closed = layoutKnowledgeTree(index, [root], new Map());
assert.equal(closed.boxes.length, 1); assert.equal(closed.paths.length, 0);
assert.ok(closed.bounds.w > 0 && closed.bounds.h > 0, 'empty/new learner root has finite fit bounds');
console.log(`PASS living tree: ${rows.length} source nodes, ${layout.boxes.length} disclosed surfaces; hierarchy, sizing, overlap, selection, disclosure and stability`);
