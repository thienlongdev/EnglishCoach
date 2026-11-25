// Carried-object clearance against the actual pinned Rapier engine, including angular paths.
import { tsLoader } from './lib/ts-load.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as T from 'three';
import R from '@dimforge/rapier3d-compat';
const require = createRequire(import.meta.url), babel = require('next/dist/compiled/babel/bundle.js');
const navigationEvents = [];
function load(file, deps = {}) {
  const { code } = babel.core().transformSync(readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'), { filename: file, configFile: false, babelrc: false, presets: [babel.presetTypescript()], plugins: [babel.pluginTransformModulesCommonjs()] });
  const exports = {}; runInNewContext(code, { exports, require: p => deps[p] ?? require(p), console, window: { dispatchEvent: e => navigationEvents.push(e.type) }, Event }); return exports;
}
await R.init();
const catalog = load('lib/study-space/catalog.ts');
const orientation = load('lib/study-space/orientation.ts', { three: T });
const { StudyPhysics } = load('components/study-space/world/physics.ts', { three: T, '@/lib/study-space/orientation': orientation, '@/lib/study-space/catalog': catalog, '@/lib/study-space/affordances': load('lib/study-space/affordances.ts', { './catalog': catalog }), './rackStorage':load('components/study-space/world/rackStorage.ts',{three:T}), '@/components/study-space/world/roomSurface':load('components/study-space/world/roomSurface.ts',{}),'@/components/study-space/world/rackMechanism':load('components/study-space/world/rackMechanism.ts',{three:T} ),'@/components/study-space/world/fixedRackSurface':load('components/study-space/world/fixedRackSurface.ts',{three:T}),'@/components/study-space/world/rigidToolSurface':load('components/study-space/world/rigidToolSurface.ts',{three:T}),'@/lib/study-space/tools': tsLoader()('lib/study-space/tools.ts') });
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z), UP = V(0, 1, 0);
let count = 0;
function ok(value, why) { assert.ok(value, why); count++; }
function fixture(props = [{ id: 'book', side: 1, at: [.45, 1.25, .3], dims: [.24, .03, .34] }]) {
  const stage = new T.Group(), ph = new StudyPhysics(R, () => {});
  const entries = props.map(p => {
    const group = new T.Group(); group.add(new T.Mesh(new T.BoxGeometry(...p.dims), new T.MeshBasicMaterial())); group.position.set(...p.at); stage.add(group);
    return { group, obj: { id: p.id, kind: 'book.single', pos: p.at, rotY: 0, scale: 1, hidden: false, locked: false } };
  });
  ph.sync(entries, 6);
  props.forEach((p, i) => { assert.ok(ph.pick(entries[i], entries, 6, p.side)); ph.aim(p.side, V(...p.at)); ph.holdRotation(p.side, new T.Quaternion()); });
  return ph;
}
{
  const p = fixture();
  ok(p.heldMotionFraction(V(), V(.5, 0, .5), .3) === 1, 'free room admits translation and rotation');
  const f = p.heldMotionFraction(V(), V(4, 0, 0), 0);
  ok(f > .5 && f < .62, 'book stops before wall even while feet would still fit: ' + f);
  ok(p.heldMotionFraction(V(), V(-4, 0, 0), 0) > f, 'asymmetric grip changes the clearance in the opposite direction');
  p.actorAt(.45, .3);
  ok(p.heldMotionFraction(V(), V(.1, 0, 0), 0) === 1, 'own capsule is not an obstacle to the held thing');
  p.dispose();
}
{
  const p = fixture([{ id: 'long', side: 1, at: [.7, 1.2, 0], dims: [.6, .08, .12] }]);
  // Both endpoints of a half-turn fit; the carried shape crosses this post halfway through.
  const post = p.world.createCollider(R.ColliderDesc.cuboid(.012, .5, .012).setTranslation(0, 1.2, -.85));
  const f = p.heldMotionFraction(V(), V(), Math.PI);
  ok(f > .2 && f < .55, 'rotation checks the arc, not only its endpoints: ' + f);
  ok(p.heldMotionFraction(V(), V(), -Math.PI) === 1, 'turning the other way stays free');
  p.world.removeCollider(post, false);
  ok(p.heldMotionFraction(V(), V(), Math.PI) === 1, 'removed collider immediately leaves the query index');
  p.dispose();
}
{
  const p = fixture([{ id: 'left', side: -1, at: [-.5, 1.2, 0], dims: [.4, .06, .3] }, { id: 'right', side: 1, at: [.5, 1.2, 0], dims: [.2, .06, .3] }]);
  ok(p.heldMotionFraction(V(), V(-3, 0, 0), 0) < .78, 'the left hand constrains the body as well');
  ok(p.heldMotionFraction(V(), V(3, 0, 0), 0) < .81, 'the right hand constrains the body as well');
  p.dispose();
}
{
  const p = fixture([{ id: 'book', side: 1, at: [2.91, 1.2, 0], dims: [.2, .04, .3] }]);
  ok(p.heldMotionFraction(V(), V(-.2, 0, 0), 0) === 1, 'an initial contact can retreat');
  ok(p.heldMotionFraction(V(), V(.2, 0, 0), 0) < .001, 'an initial overlap cannot deepen');
  p.dispose();
}
{
  const p = fixture(), side = 1;
  p.world.createCollider(R.ColliderDesc.cuboid(.01,.5,.5).setTranslation(.72,1.25,.3));
  for (let i = 0; i < 90; i++) { p.aim(side,V(1,1.25,.3),1/60); p.update(1/60); }
  const stop = p.pointOf('book'), target = p.holds.get(side).target;
  ok(stop.x < .60 && target.x < .60, 'both carried body and requested centre stop before a blocking surface');
  ok(p.heldMotionFraction(V(),V(-.08,0,0),0,.4) === .4, 'a reachable fraction can retreat from a blocked carry');
  for (let i = 0; i < 60; i++) { p.aim(side,V(.4,1.25,.3),1/60); p.update(1/60); }
  ok(p.pointOf('book').distanceTo(V(.4,1.25,.3)) < .01, 'the same grasp can pull away');
  p.dispose();
}
for (const hz of [30, 60, 120]) {
  const p = fixture(), root = V(), offset = V(.45, 1.25, .3);
  let min = Infinity;
  for (let i = 0; i < hz * 3; i++) {
    const to = root.clone().add(V(1.4 / hz, 0, 0)), f = p.heldMotionFraction(root, to, 0);
    root.lerp(to, f); p.aim(1, root.clone().add(offset)); p.update(1 / hz);
    const r = p.bodies.get('book');
    const wall = p.scene.castRay(new R.Ray(V(0, 1.2, 0), V(1, 0, 0)), 4, true, undefined, (2 << 16) | 1);
    const c = wall.collider.contactShape(r.collider.shape, p.holds.get(1).target, r.body.rotation(), .1);
    if (c) min = Math.min(min, c.distance);
  }
  ok(root.x > 2.35 && root.x < 2.435, `${hz} Hz reaches the wall and stops: ${root.x}`);
  ok(min >= -.001, `${hz} Hz held target stays outside wall: ${min}`);
  const f = p.heldMotionFraction(root, root.clone().add(V(-.2, 0, 0)), 0);
  ok(f === 1, `${hz} Hz can walk back after being blocked`);
  p.dispose();
}
// Exercise the real root-motion callers as well: a correct sweep is ineffective if
// navigation or an interaction turns/translates the character without consulting it.
const tsl = tsLoader({ three: T });
const { Character } = load('components/study-space/world/character.ts', {
  three: T,
  '@/lib/embodiment/arms': {},
  '@/lib/embodiment/human': {},
  '@/lib/embodiment/gaitClip': {},
  '@/lib/embodiment/locomotionBiomech': tsl('lib/embodiment/locomotionBiomech.ts'),
  '@/lib/embodiment/skin': {},
  '@/lib/embodiment/cast': {},
  '@/lib/embodiment/gait': load('lib/embodiment/gait.ts'),
  '@/lib/embodiment/posture': load('lib/embodiment/posture.ts'),
  '@/lib/embodiment/rootMotion': load('lib/embodiment/rootMotion.ts'),
  '@/components/features/speaking/arena/arenaAssets': {},
  '@/lib/avatar/wardrobeAssets': {},
  '@/lib/avatar/wardrobe': {},
  '@/lib/avatar/look': {},
  '@/lib/avatar/characterCreator': {},
  './echoLife/characterMaterials': {},
  './echoLife/deadBlend': tsl('components/study-space/world/echoLife/deadBlend.ts'),
});
function character() {
  const ch = new Character({ model: 'LYRA' }); ch.ready = true;
  ch.mixer = new T.AnimationMixer(ch.root);
  for (const name of ['Idle', 'Walk']) ch.actions.set(name, ch.mixer.clipAction(new T.AnimationClip(name, 1, [])));
  return ch;
}
{
  const ch = character(); ch.motionFraction = () => 0;
  ch.turnBody(Math.PI / 2, .1);
  ok(ch.root.rotation.y === 0, 'interaction turn respects a blocked held shape');
  ch.motionFraction = () => .5; ch.turnBody(Math.PI / 2, .1);
  ok(Math.abs(ch.root.rotation.y - Math.PI / 4 * (1 - Math.exp(-.7))) < 1e-9, 'interaction turn consumes the accepted fraction');
  ch.motionFraction = () => NaN; ch.moveRoot(V(100, 0, 0));
  ok(ch.root.position.length() === 0 && Number.isFinite(ch.root.rotation.y), 'invalid constraint result cannot corrupt the root');
}
for (const hz of [30, 60, 120]) {
  const ph = fixture(), ch = character(), offset = V(.45, 1.25, .3);
  // Face the route initially: a target attached to the side of the body stays there.
  ch.root.rotation.y = Math.PI / 2;
  const orientation = ch.root.rotation.y;
  ch.motionFraction = (from, to, turn) => ph.heldMotionFraction(from, to, turn);
  let arrived = 0; ch.goTo(V(4, 0, 0), () => arrived++);
  for (let i = 0; i < 5 * hz; i++) {
    ch.update(1 / hz, false);
    const q = new T.Quaternion().setFromAxisAngle(UP, ch.root.rotation.y - orientation);
    ph.aim(1, offset.clone().applyQuaternion(q).add(ch.root.position)); ph.holdRotation(1, q); ph.update(1 / hz);
  }
  ok(ch.root.position.x > 2.3 && ch.root.position.x < 2.435, `${hz} Hz automatic route stops before the book enters the wall`);
  ok(arrived === 0 && !ch.diagnostics().moving, `${hz} Hz blocked route ends without running its arrival action`);
  ok(ch.currentName === 'Idle', `${hz} Hz feet stop when navigation is blocked`);
  const atWall = ch.root.position.x; ch.goTo(V(atWall - .35, 0, 0), () => arrived++);
  for (let i = 0; i < 4 * hz; i++) {
    ch.update(1 / hz, false);
    const q = new T.Quaternion().setFromAxisAngle(UP, ch.root.rotation.y - orientation);
    ph.aim(1, offset.clone().applyQuaternion(q).add(ch.root.position)); ph.holdRotation(1, q); ph.update(1 / hz);
  }
  ok(arrived === 1 && ch.root.position.x < atWall - .29, `${hz} Hz a later clear route still completes`);
  ph.dispose();
}
ok(navigationEvents.filter(e => e === 'study:navigation-blocked').length === 3, 'one navigation failure event per blocked route');
console.log(`held motion: ${count} checks pass`);
