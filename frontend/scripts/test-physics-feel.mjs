// Human effort and force-driven furniture, on the real Rapier build the room ships (2026-11-06 polish).
import { tsLoader } from './lib/ts-load.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import R from '@dimforge/rapier3d-compat';
const require = createRequire(import.meta.url), babel = require('next/dist/compiled/babel/bundle.js');
const root = new URL('../src/', import.meta.url);
function load(file, deps = {}) { const { code } = babel.core().transformSync(readFileSync(new URL(file, root), 'utf8'), { filename: file, configFile: false, babelrc: false, presets: [babel.presetTypescript()], plugins: [babel.pluginTransformModulesCommonjs()] }); const exports = {}; runInNewContext(code, { exports, require: p => deps[p] ?? require(p), console, window: globalThis }); return exports; }
await R.init();
const catalog = load('lib/study-space/catalog.ts', {}), affordances = load('lib/study-space/affordances.ts', { './catalog': catalog });
const effort = load('lib/study-space/effort.ts', { './affordances': affordances });
const orientation = load('lib/study-space/orientation.ts', { three: THREE });
const { StudyPhysics } = load('components/study-space/world/physics.ts', { three: THREE, '@/lib/study-space/orientation': orientation, '@/lib/study-space/affordances': affordances, '@/lib/study-space/catalog': catalog, './rackStorage':load('components/study-space/world/rackStorage.ts',{three:THREE}), '@/components/study-space/world/roomSurface':load('components/study-space/world/roomSurface.ts',{}),'@/components/study-space/world/rackMechanism':load('components/study-space/world/rackMechanism.ts',{three:THREE} ),'@/components/study-space/world/fixedRackSurface':load('components/study-space/world/fixedRackSurface.ts',{three:THREE}),'@/components/study-space/world/rigidToolSurface':load('components/study-space/world/rigidToolSurface.ts',{three:THREE}),'@/lib/study-space/tools': tsLoader()('lib/study-space/tools.ts') });
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// ── The numbers: weight and friction, never one threshold for everything ──
const push = k => effort.slideResistance(k), lift = k => effort.liftResistance(k);
ok(lift('mug').breakaway < 5 && lift('mug').effortless && lift('mug').feasible, 'a mug is lifted at once');
ok(push('chair.simple').effortless && push('chair.office').breakaway < push('chair.simple').breakaway, 'a chair slides without gathering strength; casters roll easier than legs');
ok(!push('desk.wood').effortless && push('desk.wood').breakaway > 150, 'a desk needs strength: ' + push('desk.wood').breakaway.toFixed(0));
ok(push('bed.drawer').breakaway > 350 && push('bed.drawer').breakaway <= effort.HUMAN.push && push('bed.drawer').feasible, 'a bed needs nearly all a person has: ' + push('bed.drawer').breakaway.toFixed(0));
ok(push('mug').breakaway < push('chair.simple').breakaway && push('chair.simple').breakaway < push('armchair').breakaway && push('armchair').breakaway < push('desk.corner').breakaway && push('desk.corner').breakaway < push('bed.drawer').breakaway, 'mug < chair < armchair < desk < bed');
ok(!push('whiteboard').feasible, 'a fixed board never moves, however many clicks');
ok(!lift('desk.wood').feasible && !lift('bed.single').feasible, 'furniture is not lifted: only slid');
ok(push('desk.wood').sliding < push('desk.wood').breakaway, 'once going, it takes less to keep it going');
ok(effort.slideResistance('bed.drawer', true).human < effort.slideResistance('bed.drawer').human, 'pulling brings less strength than pushing');

// ── The gauge: clicks and holding reach the same strength, which fades when nothing feeds it ──
const tapsTo = (need, rate) => { const g = new effort.EffortGauge(effort.HUMAN.push); let t = 0, next = 0; while (g.applied < need && t < 10) { if (t >= next) { g.tap(); next += 1 / rate; } g.update(1 / 120); t += 1 / 120; } return t; };
const holdTo = need => { const g = new effort.EffortGauge(effort.HUMAN.push); g.hold(true); let t = 0; while (g.applied < need && t < 10) { g.update(1 / 120); t += 1 / 120; } return t; };
const bed = push('bed.drawer').breakaway, desk = push('desk.wood').breakaway, arm = push('armchair').breakaway;
ok(tapsTo(arm, 6) < tapsTo(desk, 6) && tapsTo(desk, 6) < tapsTo(bed, 6), 'heavier needs longer');
ok(tapsTo(bed, 6) < 3.2, 'a bed is reachable in a few seconds of fast clicks: ' + tapsTo(bed, 6).toFixed(2));
ok(holdTo(bed) < 3.2 && Math.abs(holdTo(desk) - tapsTo(desk, 6)) < 1.5, 'holding is an equal way to the same strength');
{ const g = new effort.EffortGauge(400); g.tap(); g.tap(); const was = g.applied; for (let i = 0; i < 120; i++) g.update(1 / 60); ok(g.applied < was * .7, 'strength fades when nothing feeds it'); }

// ── Rapier: furniture moved by force ──
const stage = new THREE.Group();
const entry = (id, kind, pos, dims, rotY = 0) => { const group = new THREE.Group(); const mesh = new THREE.Mesh(new THREE.BoxGeometry(...dims), new THREE.MeshBasicMaterial()); mesh.position.y = dims[1] / 2; group.add(mesh); group.position.set(...pos); group.rotation.y = rotY; stage.add(group); return { group, obj: { id, kind, pos, rotY, scale: 1, hidden: false, locked: false } }; };
const bedE = entry('bed', 'bed.drawer', [0, 0, 0], [1.25, .6, 2.1]);
const shelf = entry('shelf', 'shelf.tall', [0, 0, -2.4], [.9, 2, .4]);
const entries = [bedE, shelf];
const physics = new StudyPhysics(R, () => {});
physics.sync(entries, 6);
ok(physics.beginPush(bedE, entries, 6, [], affordances.affordanceOf('bed.drawer').mass), 'the bed becomes a body under the hands');
const res = push('bed.drawer');
const run = (force, seconds) => { for (let t = 0; t < seconds; t += 1 / 60) { physics.pushWith(new THREE.Vector3(0, 0, -force), 0, res.breakaway, res.sliding, effort.pushSpeed(res.mass)); physics.update(1 / 60); } return physics.pushPose(); };
let p = run(res.breakaway * .9, 1.2);
ok(Math.abs(p.z) < 1e-4 && !p.moving, 'below the arrow it does not move at all: ' + p.z);
p = run(res.breakaway * 1.06, .6);
ok(p.z < -.03 && p.moving, 'past the arrow it breaks free and slides: ' + p.z.toFixed(3));
ok(p.speed <= effort.pushSpeed(res.mass) + 1e-3, 'no faster than legs carrying that weight');
const z0 = p.z; p = run(res.sliding * .5, 1.5);
ok(p.speed < .01 && p.z - z0 > -.5, 'too little to keep it sliding: friction brings it to rest, never backwards');
p = run(effort.HUMAN.push, 8);
ok(p.z > -1.3 && p.z < -.6, 'the shelf stops it by its footprint: ' + p.z.toFixed(3));
ok(physics.pushPose().blocked, 'and the hands are told it is stuck');
const end = physics.endPush(entries, 6);
ok(end && !physics.pushing, 'hands off: no body left');
ok(physics.asleep, 'nothing moves: no physics step');
// A light chair just goes with the push.
const chair = entry('chair', 'chair.simple', [2, 0, 2], [.45, .9, .45]);
entries.push(chair); physics.sync(entries, 6);
physics.beginPush(chair, entries, 6, [], 6);
const cr = push('chair.simple');
for (let t = 0; t < .5; t += 1 / 60) { physics.pushWith(new THREE.Vector3(140, 0, 0), 0, cr.breakaway, cr.sliding, effort.pushSpeed(6)); physics.update(1 / 60); }
ok(physics.pushPose().x > 2.3, 'a chair moves at walking pace with an ordinary push');
// Turning only with the strength that breaks it free (gated by the hands), Rapier turns it.
for (let t = 0; t < .6; t += 1 / 60) { physics.pushWith(new THREE.Vector3(), 1, cr.breakaway, cr.sliding, 1); physics.update(1 / 60); }
ok(Math.abs(physics.pushPose().yaw) > .3, 'it turns on the floor');
physics.endPush(entries, 6);
physics.dispose();

// ── Placement: its own shape, on what is really there (Echo Life 4.0) ──
{
  const spots = new StudyPhysics(R, () => {});
  const desk = entry('desk2', 'desk.wood', [1, 0, -1], [1.4, .75, .7]);
  const mug = entry('mug2', 'mug', [1.2, .75, -1], [.08, .1, .08]);
  const note = entry('note2', 'notebook', [.8, .75, -1], [.2, .003, .28]);
  const post = entry('post2', 'lamp.desk', [1.1, .75, -.8], [.1, .4, .1]);
  const list = [desk, mug, note, post];
  stage.updateWorldMatrix(true, true);
  spots.sync(list, 6);
  ok(spots.pick(mug, list, 6, 1), 'a hand takes the mug');
  for (let i = 0; i < 3; i++) spots.update(1 / 60);
  const q = new THREE.Quaternion();
  const middle = spots.fit('mug2', new THREE.Vector3(1.3, .75, -1.1), q);
  ok(middle.ok && Math.abs(middle.center.y - .8) < .012, 'it stands on the top it was aimed at, not at a guessed height: ' + middle.center.y.toFixed(3));
  ok(spots.fit('mug2', new THREE.Vector3(1.655, .75, -1.1), q, false).ok, 'right at the edge of the desk is a real place: no false refusal');
  const over = spots.fit('mug2', new THREE.Vector3(1.72, .75, -1.1), q, false);
  ok(!over.ok && over.why === 'edge', 'half of it over nothing is refused for that reason: ' + over.why);
  const blocked = spots.fit('mug2', new THREE.Vector3(1.03, .75, -.8), q, false);
  ok(!blocked.ok && blocked.why === 'room', 'against something else, overlapping it, is refused by its shape: ' + blocked.why);
  ok(!spots.fit('mug2', new THREE.Vector3(1.3, .4, -1.1), q, false).ok, 'a point in mid-air under the top holds nothing');
  ok(spots.pick(note, list, 6, -1), 'the other hand takes the paper-thin notebook');
  const hull = spots.bodies.get('note2').hull; let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < hull.length; i += 3) { lo = Math.min(lo, hull[i]); hi = Math.max(hi, hull[i]); }
  ok(hi - lo >= .0119, 'a paper-thin thing keeps a body a contact can hold on to: ' + (hi - lo).toFixed(4));
  const body = spots.bodies.get('mug2');
  ok(body.body.mass() > 0 && Math.abs(body.body.mass() - (affordances.affordanceOf('mug').mass + .24)) < 1e-3, 'its mass is its own, and the tea in it');
  ok(body.com.y < 0, 'its weight sits low over its base, not at the middle of its hull');
  spots.dispose();
}
const manipSrc = readFileSync(new URL('../src/components/study-space/world/manipulation.ts', import.meta.url), 'utf8');
// Position/orientation/each-hand admission and low support are exercised by
// test-placement-release.mjs. Ordinary placement must never force a pose.
ok(!/physics\.setAt\(/.test(manipSrc), 'placement waits for physical arrival without forcing its pose');
ok(!/teleport/i.test(manipSrc.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'nothing jumps into the hands');
ok(/resist|pushable/.test(manipSrc) && /Math\.min\(sizes\[0\] \/ 2/.test(manipSrc), 'hands reach the near side of wide furniture, from whichever side the body comes');

// ── A computer put together by hand: cables reach, nothing places itself ──
{
  const station = load('lib/study-space/station.ts');
  const thing = (id, kind, x, y, z, more = {}) => ({ id, kind, pos: [x, y, z], rotY: 0, scale: 1, hidden: false, locked: false, ...more });
  const mon = thing('m', 'monitor', 0, .75, 0), tower = thing('t', 'pc.tower', .7, 0, 0), keys = thing('k', 'keyboard', 0, .75, .35), mouse = thing('x', 'mouse.pc', .3, .75, .35);
  ok(station.stationOf([mon, tower, keys, mouse], mon).ready, 'tower by the desk, keyboard and mouse at hand: it works');
  ok(station.stationOf([mon, keys, mouse], mon).missing.join() === 'tower', 'without a tower the monitor says exactly that');
  ok(station.stationOf([mon, { ...tower, inside: 'drawer' }, keys, mouse], mon).missing.includes('tower'), 'a part in a drawer is connected to nothing');
  ok(station.stationOf([mon, tower, { ...keys, pos: [3, .75, 3] }, mouse], mon).missing.join() === 'keyboard', 'across the room a cable does not reach');
  ok(station.stationOf([mon, tower, { ...mouse, pos: [.3, 0, .35] }, keys], mon).missing.join() === 'mouse', 'a mouse on the floor is not at hand');
  const alone = station.stationNear([keys], keys);
  ok(!alone.monitor && alone.missing.includes('monitor') && !alone.ready, 'a keyboard alone needs a monitor first');
}

// ── Undo: the room changes back, the player stays where they are ──
{
  const types = load('lib/study-space/types.ts', {});
  const fake = { emptyLayout: () => ({ objects: [], camera: { a: 1 }, character: { pos: [0, 0, 0], rotY: 0, anchor: null, activity: null } }), uid: p => p };
  const store = load('lib/study-space/store.ts', { './layout': fake, './types': types, zustand: require('zustand') });
  const S = store.useSpace, world = () => S.getState();
  world().load({ objects: [{ id: 'a', pos: [0, 0, 0] }], camera: { a: 1 }, character: { pos: [0, 0, 0], rotY: 0, anchor: null, activity: null } });
  world().apply(l => ({ ...l, objects: [{ id: 'a', pos: [1, 0, 0] }] }), 'drop-a-1');
  world().apply(l => ({ ...l, character: { ...l.character, pos: [5, 0, 5] }, camera: { a: 2 } }), 'char-move');
  ok(world().past.length === 1, 'walking is not a step of Undo');
  world().undo();
  ok(world().layout.objects[0].pos[0] === 0, 'Undo puts the thing back');
  ok(world().layout.character.pos[0] === 5 && world().layout.camera.a === 2, 'and never moves the player or the view');
  world().redo();
  ok(world().layout.objects[0].pos[0] === 1 && world().layout.character.pos[0] === 5, 'Redo the same');
}

// ── The compile worker: only the exact engine the room ships ──
const worker = readFileSync(new URL('../public/vendor/study-physics/compile-v1.js', import.meta.url), 'utf8');
const pinned = /const PINNED = '([0-9a-f]{64})'/.exec(worker)[1];
const wasm = readFileSync(new URL('../node_modules/@dimforge/rapier3d-compat/rapier_wasm3d_bg.wasm', import.meta.url));
ok(createHash('sha256').update(wasm).digest('hex') === pinned, 'the worker pins the engine bytes the package inlines');
const workerCode = worker.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join(' ');
ok(/crypto\.subtle\.digest\('SHA-256'/.test(workerCode) && /WebAssembly\.compile\(bytes\)/.test(workerCode) && !/fetch|importScripts|eval|Function\(/.test(workerCode), 'it hashes before compiling and loads nothing');
const physicsSrc = readFileSync(new URL('../src/components/study-space/world/physics.ts', import.meta.url), 'utf8');
ok(physicsSrc.includes("const COMPILER = '/vendor/study-physics/compile-v1.js'"), 'the room asks that worker');
const nginx = readFileSync(new URL('../../deploy/nginx/default.conf', import.meta.url), 'utf8');
const block = /location \^~ \/vendor\/study-physics\/ \{([\s\S]*?)\r?\n    \}/.exec(nginx)?.[1] ?? '';
ok(/add_header_inherit off;/.test(block) && block.includes(`add_header Content-Security-Policy "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; report-uri /api/csp-report" always;`), 'the edge gives only the worker response a policy that compiles WebAssembly and fetches nothing');
ok(!/wasm-unsafe-eval/.test(/add_header Content-Security-Policy "default-src 'self';[^"]+"/.exec(nginx)[0]), 'the site policy for pages is unchanged');
const proxy = readFileSync(new URL('../src/proxy.ts', import.meta.url), 'utf8');
ok(!/wasm-unsafe-eval/.test(proxy), 'the page policy never allows WebAssembly compilation');
// ── Input: no long-press throw, no furniture that follows the body ──
const manip = readFileSync(new URL('../src/components/study-space/world/manipulation.ts', import.meta.url), 'utf8');
ok(!/held > 420/.test(manip) && !/\b(?:private\s+|this\.)beginDrag\b|this\.drag\b/.test(manip), 'clicks never throw by accident; the old follow-the-body drag is gone');
ok(/enqueue\(button, now\)/.test(manip) && /this\.queue\.shift\(\)/.test(manip), 'a click while the body is busy is kept and done next');
ok(/refusePlace\(\)/.test(manip) && !/perform\(held > 420 \? 'throw' : 'drop'\)/.test(manip), 'a click on a place that does not fit never drops the thing');
const exploration = readFileSync(new URL('../src/components/study-space/world/exploration.ts', import.meta.url), 'utf8');
ok(/addEventListener\('mousedown', this\.mouseDown\)/.test(exploration) && /e\.deltaY \|\| e\.deltaX/.test(exploration), 'every button under mouse-look; Shift + wheel is read on either axis');
const arena = readFileSync(new URL('../src/components/features/speaking/arena/ArenaScene.tsx', import.meta.url), 'utf8');
ok(/rig\.eyeWorld\s*=\s*p\.view\s*===\s*'first'[\s\S]*?c\.eyeWorld\(/.test(arena), 'Arena: the first-person eyes ride the jump');
console.log(`physics feel: ${n} checks pass`);
