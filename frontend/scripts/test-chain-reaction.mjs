// Echo Life 5.0: what happens to one thing happens to the things it touches. On the real Rapier build the room ships.
import { tsLoader } from './lib/ts-load.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import R from '@dimforge/rapier3d-compat';
const require = createRequire(import.meta.url), babel = require('next/dist/compiled/babel/bundle.js');
const root = new URL('../src/', import.meta.url);
function load(file, deps = {}) { const { code } = babel.core().transformSync(readFileSync(new URL(file, root), 'utf8'), { filename: file, configFile: false, babelrc: false, presets: [babel.presetTypescript()], plugins: [babel.pluginTransformModulesCommonjs ? babel.pluginTransformModulesCommonjs() : 'transform-modules-commonjs'] }); const module = { exports: {} }; runInNewContext(code, { module, exports: module.exports, require: n => deps[n] ?? require(n), Math, console, performance, window: { setTimeout, clearTimeout }, WebAssembly, Worker: undefined, setTimeout }); return module.exports; }
await R.init();
const catalog = load('lib/study-space/catalog.ts', {}), affordances = load('lib/study-space/affordances.ts', { './catalog': catalog }), tools = tsLoader()('lib/study-space/tools.ts');
const { StudyPhysics } = load('components/study-space/world/physics.ts', { three: THREE, '@/lib/study-space/affordances': affordances, '@/lib/study-space/catalog': catalog, './rackStorage':load('components/study-space/world/rackStorage.ts',{three:THREE}), '@/components/study-space/world/roomSurface':load('components/study-space/world/roomSurface.ts',{}),'@/components/study-space/world/rackMechanism':load('components/study-space/world/rackMechanism.ts',{three:THREE} ),'@/components/study-space/world/fixedRackSurface':load('components/study-space/world/fixedRackSurface.ts',{three:THREE}),'@/components/study-space/world/rigidToolSurface':load('components/study-space/world/rigidToolSurface.ts',{three:THREE}),'@/lib/study-space/tools': tools });

const stage = new THREE.Group();
const entry = (id, kind, pos, dims, rotY = 0) => { const group = new THREE.Group(); const mesh = new THREE.Mesh(new THREE.BoxGeometry(...dims), new THREE.MeshBasicMaterial()); mesh.position.y = dims[1] / 2; group.add(mesh); group.position.set(...pos); group.rotation.y = rotY; stage.add(group); stage.updateMatrixWorld(true); return { obj: { id, kind, pos, rotY, scale: 1 }, group }; };
const world = (entries) => {
  const landed = new Map();
  const physics = new StudyPhysics(R, (id, pos, yaw, tilt) => landed.set(id, { pos, tilt }));
  physics.sync(entries, 6);
  return { physics, landed, run: s => { for (let t = 0; t < s; t += 1 / 60) physics.update(1 / 60); } };
};

// ── A thrown thing knocks what stands in its way; what it missed stays exactly where it is ──
{
  const desk = entry('desk', 'desk.wood', [0, 0, 0], [1.4, .78, .7]);
  const mug = entry('mug', 'mug', [0, .78, 0], [.09, .1, .09]), far = entry('far', 'lamp.desk', [.6, .78, .2], [.14, .4, .14]);
  const ball = entry('ball', 'book.single', [-.6, .84, 0], [.16, .03, .22]);
  const { physics, landed, run } = world([desk, mug, far, ball]);
  const woken = [];
  physics.onWoken = id => woken.push(id);
  assert.ok(physics.wake('ball', { x: 3.2, y: .2, z: 0 }), 'the thrown book is a body');
  run(.5);
  assert.ok(woken.includes('mug'), 'the mug it hit woke up: ' + woken);
  assert.ok(!woken.includes('far'), 'the lamp it never touched stayed asleep');
  assert.ok(!physics.owns('far'));
  run(3);
  assert.ok(landed.has('mug'), 'the mug came to rest, and its new place is told');
  const p = landed.get('mug').pos;
  assert.ok(Math.hypot(p[0], p[2]) > .03, 'somewhere other than where it stood: ' + p);
  physics.dispose();
}
// ── A light tap does not shift something much heavier ──
{
  const desk = entry('desk', 'desk.wood', [0, 0, 0], [1.4, .78, .7]);
  const pc = entry('pc', 'pc.tower', [0, .78, 0], [.2, .44, .42]), paper = entry('paper', 'trash.paper', [-.3, .86, 0], [.05, .05, .05]);
  const { physics, run } = world([desk, pc, paper]);
  const woken = [];
  physics.onWoken = id => woken.push(id);
  physics.wake('paper', { x: 1.5, y: 0, z: 0 });
  run(.6);
  assert.ok(!woken.includes('pc'), 'a ball of paper does not move a computer: ' + woken);
  physics.dispose();
}
// ── Lift what lies under another: the top one comes alive with it ──
{
  const floor = entry('table', 'table.side', [0, 0, 0], [.6, .5, .6]);
  const a = entry('a', 'book.single', [0, .5, 0], [.2, .04, .28]), b = entry('b', 'book.single', [0, .54, 0], [.2, .04, .28]), c = entry('c', 'book.single', [0, .58, 0], [.2, .04, .28]);
  const { physics, landed, run } = world([floor, a, b, c]);
  physics.wake('a', { x: 2.4, y: 0, z: 0 });
  assert.ok(physics.owns('b') && physics.owns('c'), 'what was on it comes along, all the way up');
  run(4);
  assert.ok(landed.has('a') && landed.has('b') && landed.has('c'), 'all three come to rest');
  physics.dispose();
}
// ── Furniture pushed into something light shoves it; into something heavy it stops ──
{
  const desk = entry('desk', 'desk.wood', [0, 0, 0], [1.4, .78, .7]);
  const lamp = entry('flamp', 'lamp.floor', [0, 0, -1.1], [.3, 1.6, .3]), chest = entry('chest', 'drawers', [.0, 0, -2.4], [1, .9, .5]);
  const all = [desk, lamp, chest];
  const { physics, landed, run } = world(all);
  const woken = [];
  physics.onWoken = id => woken.push(id);
  physics.beginPush(desk, all, 6, [], 48);
  const go = s => { for (let t = 0; t < s; t += 1 / 60) { physics.pushWith(new THREE.Vector3(0, 0, -420), 0, 200, 140, .9); physics.update(1 / 60); } return physics.pushPose(); };
  let p = go(1.2);
  assert.ok(woken.includes('flamp'), 'the lamp woke when the desk reached it: ' + JSON.stringify(p));
  p = go(3.5);
  assert.ok(p.z > -1.95, 'the chest of drawers is too heavy to shove, it stops the desk: ' + p.z);
  assert.ok(physics.pushPose().blocked, 'and the hands are told');
  physics.endPush(all, 6);
  run(6);
  const l = landed.get('flamp');
  assert.ok(l, 'the lamp came to rest');
  assert.ok(l.tilt || Math.hypot(l.pos[0], l.pos[2] + 1.1) > .05, 'moved or knocked over: ' + JSON.stringify(l));
  physics.dispose();
}
// ── Something walked into or thrown at the body is told, with its momentum ──
{
  const box = entry('box', 'whale.plush', [1, 1, 0], [.3, .3, .3]);
  const { physics, run } = world([box]);
  physics.actorAt(0, 0);
  run(.05);
  let hit = null;
  physics.onBodyHit = (id, vx, vz, kg) => { hit = { id, vx, vz, kg }; };
  physics.wake('box', { x: -3, y: .2, z: 0 });
  run(.5);
  assert.ok(hit && hit.id === 'box' && hit.vx < -1 && hit.kg > .5, 'the body felt it: ' + JSON.stringify(hit));
  physics.dispose();
}
console.log('PASS chain reaction: a thing hit wakes, a light tap does not, supports go, furniture shoves what is light and stops at what is heavy, the body feels what hits it.');
