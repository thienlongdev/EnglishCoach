// Echo Life 5.0, the rules of a room that goes on living: cleaning happens only where a tool goes, nothing is lost or made up, time passing is bounded, stories never ask for what is already true.
import assert from 'node:assert/strict';
import { tsLoader } from './lib/ts-load.mjs';

const load = tsLoader({});
const G = load('lib/study-space/grime.ts');
const L = load('lib/study-space/life.ts');
const W = load('lib/study-space/weather.ts');
const T = load('lib/study-space/tools.ts');
const S = load('lib/study-space/stories.ts');
const { GrimeField, settleDust, DUST_HEAP } = G;

const room = () => new GrimeField(64, 64, 6, 6);
const near = (a, b, e = 1e-3) => assert.ok(Math.abs(a - b) <= e, `${a} is not ${b}`);
const uniform = (f, v) => f.dust.fill(v);

// ── A broom moves dust and makes none ───────────────────────────────────────────────────────────────────
{
  const f = room(); uniform(f, .3);
  const before = f.total('dust');
  for (let i = 0; i < 12; i++) f.sweep({ x: -1, z: i * .02 }, { x: 1, z: i * .02 }, .3);
  near(f.total('dust'), before, 1e-2);
  assert.ok(f.sample('dust', -.5, 0) < .12, 'behind the broom the floor is clean: ' + f.sample('dust', -.5, 0));
  assert.ok(f.sample('dust', 1.1, 0) > .8, 'ahead of it the dust has gathered: ' + f.sample('dust', 1.1, 0));
  near(f.sample('dust', 0, 2), .3, 1e-3);   // where it never went, nothing changed
  assert.ok(f.heap(), 'a heap can be pointed at');
}
// A wall stops it: it stays against the wall, it does not vanish.
{
  const f = room(); uniform(f, .2);
  const before = f.total('dust');
  for (let i = 0; i < 10; i++) f.sweep({ x: 2.2, z: 0 }, { x: 2.99, z: 0 }, .3);
  near(f.total('dust'), before, 1e-2);
}
// ── A dustpan takes only what is under it, up to what it holds ──────────────────────────────────────────
{
  const f = room(); f.stamp('dust', 0, 0, .25, 3, DUST_HEAP);
  const t = f.total('dust');
  const a = f.scoop({ x: 0, z: 0 }, { x: 1, z: 0 }, .25, .2, 2);
  near(a, 2, 1e-3); near(f.total('dust'), t - 2, 1e-2);
  assert.equal(f.scoop({ x: 2, z: 2 }, { x: 1, z: 0 }, .25, .2, 5), 0, 'nothing there, nothing taken');
  assert.equal(f.scoop({ x: 0, z: 0 }, { x: 1, z: 0 }, .25, .2, 0), 0, 'a full pan takes nothing');
}
// ── A mop: only where it goes; wet, it cleans; dry, hardly; dirty, it streaks ───────────────────────────
{
  const fresh = () => { const f = room(); f.stamp('stain', 0, 0, .5, .9); return f; };
  const strokes = (f, tool, n = 8) => { for (let i = 0; i < n; i++) f.mop({ x: -.5, z: 0 }, { x: .5, z: 0 }, .3, .16, tool); };
  const wet = fresh(), dry = fresh();
  strokes(wet, { wet: .9, load: 0 });
  strokes(dry, { wet: 0, load: 0 });
  assert.ok(wet.sample('stain', 0, 0) < dry.sample('stain', 0, 0) * .6, `wet cleans more than dry: ${wet.sample('stain', 0, 0)} vs ${dry.sample('stain', 0, 0)}`);
  assert.ok(wet.sample('wet', 0, 0) > .2, 'it leaves water');
  near(wet.sample('wet', 0, 1.5), 0); near(wet.sample('stain', 1.5, 1.5), 0);
  // A stubborn stain goes a little with each pass: not at a click.
  const once = fresh(); once.mop({ x: -.5, z: 0 }, { x: .5, z: 0 }, .3, .16, { wet: .9, load: 0 });
  assert.ok(once.sample('stain', 0, 0) > .45, 'one stroke does not finish it: ' + once.sample('stain', 0, 0));
  // A dirty head puts dirt back on a clean floor.
  const clean = room(), dirty = { wet: .8, load: .9 };
  clean.mop({ x: -1, z: 1 }, { x: 1, z: 1 }, .3, .16, dirty);
  assert.ok(clean.sample('stain', 0, 1) > 0, 'a streak');
  const t = { wet: .9, load: 0 }; const g = room(); uniform(g, .5); for (let i = 0; i < 30; i++) g.mop({ x: -1, z: 0 }, { x: 1, z: 0 }, .3, .16, t);
  assert.ok(t.load > .05, 'it took the dirt into itself'); assert.ok(t.wet < .9, 'and used its water');
}
// ── Water dries, and a dry room costs nothing ───────────────────────────────────────────────────────────
{
  const f = room(); assert.equal(f.dry(1, .1), false, 'nothing to do'); const r0 = f.rev;
  f.stamp('wet', 0, 0, .4, 1); assert.ok(f.wetting);
  for (let i = 0; i < 40 && f.wetting; i++) f.dry(1, .05);
  assert.equal(f.wetting, false); assert.ok(f.rev > r0);
  const r1 = f.rev; f.dry(1, .05); assert.equal(f.rev, r1, 'asleep again');
}
// ── Stored and back ─────────────────────────────────────────────────────────────────────────────────────
{
  const f = room(); settleDust(f, 5, .05, .42, 3, true); f.stamp('stain', 1, 1, .3, .7); f.stamp('wet', -1, 0, .4, .8);
  for (let i = 0; i < 6; i++) f.sweep({ x: -2, z: -2 }, { x: 0, z: -2 }, .3);
  const rec = f.encode(), size = rec.d.length + rec.s.length + rec.w.length;
  assert.ok(size < 9000, 'small enough to keep with the room: ' + size);
  const g = GrimeField.decode(JSON.parse(JSON.stringify(rec)), 64, 64, 6, 6);
  for (const c of ['dust', 'stain', 'wet']) assert.ok(Math.abs(f.total(c) - g.total(c)) < f.total(c) * .08 + .5, `${c} survives: ${f.total(c)} / ${g.total(c)}`);
  assert.ok(Math.abs(f.sample('dust', -1, -2) - g.sample('dust', -1, -2)) < .08, 'the swept path is still there');
  // The heap is where it was: stored dust is rounded, and the fullest single cell of a heap may change, but the heap does not move.
  for (let seed = 1; seed <= 12; seed++) {
    const h = room(); settleDust(h, 5, .05, .42, 3, true);
    for (let i = 0; i < 5 + seed % 4; i++) h.sweep({ x: -2 + seed * .05, z: -2 }, { x: seed * .08, z: -2 + seed * .03 }, .3);
    const a = h.heap(), b = GrimeField.decode(JSON.parse(JSON.stringify(h.encode())), 64, 64, 6, 6).heap();
    assert.ok(a && b && Math.hypot(a.x - b.x, a.z - b.z) < .2, `the heap stays put through storing (${seed}): ${JSON.stringify(a)} / ${JSON.stringify(b)}`);
  }
  assert.equal(GrimeField.decode({ n: [8, 8], d: '', s: '', w: '' }, 64, 64, 6, 6).total('dust'), 0, 'another size starts clean');
  assert.equal(GrimeField.decode({ n: [64, 64], d: '!!', s: 5, w: null }, 64, 64, 6, 6).total('dust'), 0, 'rubbish reads as nothing');
}
// ── Time passing is bounded, and never reaches what is covered ──────────────────────────────────────────
{
  const objects = [{ id: 'desk', kind: 'desk.wood', pos: [0, 0, -2], rotY: 0, scale: 1 }, { id: 'book', kind: 'book.single', pos: [0, .78, -2], rotY: 0, scale: 1 }];
  const ctx = (life) => {
    const floor = room(), tops = new Map();
    for (const t of L.topsOf(objects)) tops.set(t.key, { field: new GrimeField(...L.topCells(t.w, t.d), t.w, t.d), surface: t });
    return { floor, tops, room: { size: 6, wallLeft: true, wallRight: true }, objects };
  };
  const T0 = Date.parse('2026-11-01T08:00:00');
  const after = (days, care = 'natural') => { const life = L.freshLife('seed', T0); life.settings.care = care; const c = ctx(life); L.age(life, c, T0 + days * 86_400_000); return { life, c }; };
  const a = after(3), b = after(14), c = after(365), off = after(100, 'off'), rel = after(100, 'relaxed');
  assert.ok(a.c.floor.dustIndex() > .05, 'three days show: ' + a.c.floor.dustIndex());
  assert.ok(b.c.floor.dustIndex() > a.c.floor.dustIndex());
  assert.ok(c.c.floor.dustIndex() < .62, 'a year away is not filth: ' + c.c.floor.dustIndex());
  assert.ok(c.c.floor.dustIndex() - b.c.floor.dustIndex() < .2, 'it levels off');
  assert.equal(off.c.floor.total('dust'), 0, 'off means off');
  assert.ok(rel.c.floor.dustIndex() < c.c.floor.dustIndex() * .6, 'relaxed stays gentle');
  assert.ok(c.life.crumbs.length <= 20 && c.life.webs.length <= 4, 'crumbs and webs have an end');
  assert.ok(rel.life.webs.length <= 2);
  // The desk's own footprint keeps the floor under it clean, the book keeps its shape on the desk.
  const under = c.c.floor; const cell = under.at(32, Math.floor((-2 / 6 + .5) * 64));
  assert.equal(under.covered[cell], 1); assert.equal(under.dust[cell], 0);
  const top = c.c.tops.get('desk:0');
  assert.ok(top.field.sample('dust', 0, 0) < .02, 'nothing under the book'); assert.ok(top.field.sample('dust', .6, .3) > .1, 'all round it');
  // Time passing twice over a moment adds nothing.
  const twice = L.freshLife('seed', T0), cc = ctx(twice); L.age(twice, cc, T0 + 86_400_000); const d1 = cc.floor.total('dust'); L.age(twice, cc, T0 + 86_400_000); near(cc.floor.total('dust'), d1);
  // The same room on the same day: the same dust.
  const r1 = after(7).c.floor, r2 = after(7).c.floor; near(r1.total('dust'), r2.total('dust'));
  // Lifted away, a piece takes its web along.
  const l2 = L.freshLife('s', T0); l2.webs = [{ id: 'a', x: 0, y: 2, z: 0, ry: 0, size: .4, k: 1, on: 'shelf' }, { id: 'b', x: 1, y: 2, z: 0, ry: 0, size: .4, k: 1 }];
  assert.equal(L.dropWebsOf(l2, 'shelf'), true); assert.equal(l2.webs.length, 1);
  // A record that makes no sense never costs the room.
  assert.equal(L.readLife('x'), undefined);
  const odd = L.readLife({ settings: { care: 'nonsense' }, crumbs: [{ x: 'a' }, { x: 1, z: 1, kind: 9, r: 0 }], webs: [{}], told: { a: 'b' }, floor: { n: 3 } });
  assert.equal(odd.settings.care, 'natural'); assert.equal(odd.crumbs.length, 1); assert.equal(odd.webs.length, 0); assert.equal(odd.floor, undefined);
}
// ── Tools: their state decides what they do ─────────────────────────────────────────────────────────────
{
  for (const [k, t] of Object.entries(T.TOOLS)) {
    assert.equal(t.kind, k);
    assert.ok(t.grips[0] <= t.grips[1] && t.grips[1] <= t.length, k + ' hands are on it');
    assert.ok(t.reach[0] < t.reach[1], k);
    assert.ok(t.on.length > 0);
  }
  const d = T.dip({ wet: 0, load: .8 }, { fill: 1, dirt: 0 });
  assert.equal(d.tool.wet, 1); assert.ok(d.tool.load < .3, 'the dirt went into the water'); assert.ok(d.bucket.dirt > 0); assert.ok(d.bucket.fill < 1);
  assert.equal(T.dip({ wet: 0, load: 0 }, { fill: 0 }), null, 'an empty bucket wets nothing');
  const m = T.dip({ wet: .2, load: .1 }, { fill: 1, dirt: 1 }); assert.ok(m.tool.load > .2, 'murky water does not clean a mop');
  assert.ok(T.wring({ wet: 1 }).wet < 1 && T.wring({ wet: .2 }).wet === .2, 'wringing only takes water out');
  assert.equal(T.rinse({ wet: .1, load: .9 }).load, 0);
  assert.ok(T.massNow('tool.bucket', { fill: 1 }, 1) > T.massNow('tool.bucket', { fill: 0 }, 1) + 7, 'water has weight');
}
// ── Weather: the same for everybody looking, sometimes rain, never owed ─────────────────────────────────
{
  const t = Date.parse('2026-11-10T12:00:00');
  assert.deepEqual(W.weatherAt('a', t), W.weatherAt('a', t));
  let rainy = 0;
  for (let d = 0; d < 200; d++) if (W.showers('room', `2026-1-${d}`).length) rainy++;
  assert.ok(rainy > 40 && rainy < 120, 'rain on some days: ' + rainy);
  const w = W.weatherAt('a', Date.parse('2026-11-10T03:00:00')); assert.equal(w.sun, 0, 'no sun at three in the morning');
  assert.ok(W.weatherAt('a', Date.parse('2026-11-10T12:30:00')).sun > .9);
  assert.equal(W.hasWeather('space'), false); assert.equal(W.hasWeather('ocean'), false); assert.equal(W.hasWeather('live'), true);
  assert.equal(W.viewRain('space', { rain: 1 }), 0); assert.ok(W.viewRain('rain', { rain: 0 }) >= .55);
}
// ── Stories: words only, once, and never asking for what is already true ───────────────────────────────
{
  const base = { now: Date.parse('2026-11-09T08:00:00'), hour: 8, weekend: false, firstToday: true, awayHours: 12, hasWindow: true, hasRoom: true, curtains: 1, windowOpen: false, rain: 0, wetUnderWindow: 0, wet: 0, dust: .02, clean: .95, stains: 0, crumbs: 0, webs: 0, trash: 0, heap: false, hasKit: true, held: [], mopLoad: 0, mopWet: 0, panFill: 0, panHeld: false, bucketDirt: 0, bucketFill: 1, binFull: false, atDesk: false, onScreen: false, bookOpen: false, lampOn: false, busy: false, unread: 0, invited: false, wetSoles: false, spilled: false };
  const life = L.freshLife('s', base.now), d = new S.StoryDirector(life);
  let f = { ...base };
  assert.equal(d.update(f, false).line, null, 'a story begins without a word in that very moment');
  assert.equal(life.story.id, 'morning');
  f = { ...f, now: f.now + 1000 };
  const first = d.update(f, false).line; assert.equal(first.id, 'light');
  // Quiet between lines; said once.
  f = { ...f, now: f.now + 2000 }; assert.equal(d.update(f, false).line, null);
  // In any order: sitting down first, nobody is sent back to the curtain.
  f = { ...f, now: f.now + 20000, atDesk: true };
  const next = d.update(f, false).line; assert.equal(next.id, 'begin', 'what the player chose to skip is not asked for again');
  assert.equal(d.update({ ...f, now: f.now + 1000 }, false).line, null, 'said once');
  // Nothing is said while the hands are busy.
  f = { ...f, now: f.now + 20000, onScreen: true }; assert.equal(d.update(f, true).line, null);
  const end = d.update({ ...f, now: f.now + 20000 }, false).line; assert.equal(end.id, 'morning-end'); assert.equal(life.story, null); assert.ok(life.told.morning);
  // Not again this morning; room between stories.
  assert.equal(new S.StoryDirector(life).update({ ...f, now: f.now + 60000 }, false).line, null);
  assert.equal(life.story, null, 'room between stories');
  // Off means off.
  const off = L.freshLife('s', base.now); off.settings.stories = false;
  assert.equal(new S.StoryDirector(off).update(base, false).line, null); assert.equal(off.story, undefined);
  // A story that goes nowhere ends without a word.
  const stale = L.freshLife('s', base.now), ds = new S.StoryDirector(stale);
  ds.update(base, false); const later = { ...base, now: base.now + 3 * 3_600_000 };
  const out = ds.update(later, false); assert.equal(out.line, null); assert.equal(stale.story, null);
  // A remark comes when it is true, once, and from what is in the hands.
  const rem = L.freshLife('s', base.now); rem.settings.stories = true; rem.told.morning = base.now; const dr = new S.StoryDirector(rem);
  const dirty = { ...base, firstToday: false, held: ['tool.mop'], mopLoad: .8, mopWet: .6 };
  assert.equal(dr.update(dirty, false).line.id, 'mop-dirty');
  assert.notEqual(dr.update({ ...dirty, now: dirty.now + 60000 }, false).line?.id, 'mop-dirty', 'once');
  // Every line is short, in both languages, and spells "and" the way the product does.
  for (const s of S.STORIES) for (const b of [...s.beats, ...(s.end ? [s.end] : [])]) { for (const t of [b.vi, b.en]) { assert.ok(t.length <= 90, 'a caption is short: ' + t); assert.ok(!t.includes('&')); } }
  for (const r of S.REMARKS) { assert.ok(r.vi.length <= 90 && r.en.length <= 90, r.id); }
  const ids = new Set(); for (const s of S.STORIES) for (const b of s.beats) { const k = s.id + b.id; assert.ok(!ids.has(k)); ids.add(k); }
  // The four stories the room was asked to have, reachable from the facts.
  assert.ok(S.STORIES.find(s => s.id === 'rain').begin({ ...base, rain: .5 }));
  assert.ok(S.STORIES.find(s => s.id === 'clean').begin({ ...base, dust: .3 }));
  assert.ok(S.STORIES.find(s => s.id === 'friend').begin({ ...base, unread: 2 }));
}
console.log('room life: pass');
