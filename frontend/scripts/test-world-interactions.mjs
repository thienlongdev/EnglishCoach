// The room as a place to act in: what the catalogue says it allows has to exist in the code, and the figures hold the wardrobe and the coverage to what was promised.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { tsLoader } from './lib/ts-load.mjs';

const src = p => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
const load = tsLoader({});
const { CATALOG } = load('lib/study-space/catalog.ts');
const A = load('lib/study-space/affordances.ts');
const L = load('lib/avatar/look.ts');
const K = load('lib/study-space/keymap.ts');

// Every row of the catalogue answers, and a new row with no entry still does.
for (const { id } of CATALOG) {
  const a = A.affordanceOf(id);
  assert.ok(a.family && a.mobility && a.mass > 0, id + ' has real properties');
  const acts = A.actsFor(id, { free: 2, held: [], seated: false, lying: false, onThis: false, hasTool: true, countLeft: 3 });
  assert.ok(acts.length > 0, id + ' can be touched in some way');
}
assert.equal(A.affordanceOf('a.kind.from.tomorrow').mobility, 'portable', 'an unknown thing is still a thing');

const cover = A.coverage();
console.log('coverage', JSON.stringify(cover));
assert.ok(cover.families >= 20, 'at least 20 families: ' + cover.families);
assert.ok(cover.combos >= 100, 'at least 100 object-action-context combinations: ' + cover.combos);

// Context changes the answer.
const free = { free: 2, held: [], seated: false, lying: false, onThis: false };
assert.equal(A.actsFor('mug', free)[0].verb, 'pick');
assert.equal(A.actsFor('mug', { ...free, free: 0, held: ['mug', 'notebook'] })[0].blocked, true, 'two full hands cannot take a third thing');
assert.equal(A.actsFor('whale.plush', { ...free, free: 1, held: ['mug'] })[0].blocked, true, 'a thing that takes both arms needs both arms');
assert.equal(A.actsFor('chair.office', free)[0].verb, 'sit');
assert.equal(A.actsFor('chair.office', { ...free, onThis: true })[0].verb, 'stand');
assert.equal(A.actsFor('laptop', { ...free, hasTool: true })[0].verb, 'use', 'a screen is for using');
assert.equal(A.actsFor('door', { ...free, open: false })[0].verb, 'open');
assert.equal(A.actsFor('door', { ...free, open: true })[0].verb, 'close');
assert.equal(A.actsFor('drawer', { ...free, open: true, canStore: true, held: ['mug'], free: 1 })[0].verb, 'put-away');
assert.equal(A.actsFor('lamp.floor', { ...free, on: true })[0].vi, 'Tắt đèn');
assert.equal(A.actsFor('lamp.floor', { ...free, on: false })[0].vi, 'Bật đèn');
assert.equal(A.heldActs('mug', { sipsLeft: 0 })[0].verb, 'refill', 'an empty cup asks to be filled');
assert.equal(A.graspFor(A.affordanceOf('mug'), [.12, .1, .12]), 'wrap');
assert.equal(A.graspFor(A.affordanceOf('notebook'), [.24, .02, .3]), 'edge');
assert.equal(A.graspFor(A.affordanceOf('keyboard'), [.44, .023, .15]), 'edge');
assert.equal(A.graspFor(A.affordanceOf('whale.plush'), [.9, .4, .5]), 'both');

// Every verb has one implementation, not a label only.
const manip = src('components/study-space/world/manipulation.ts');
const verbs = [...src('lib/study-space/affordances.ts').matchAll(/'([a-z-]+)'/g)].map(m => m[1]);
for (const v of ['change-bulb', 'pick', 'take-one', 'put-away', 'place', 'drop', 'throw', 'inspect', 'push', 'sit', 'lie', 'stand', 'open', 'close', 'pass', 'switch', 'lid', 'power', 'use', 'drink', 'refill', 'read', 'turn-page', 'write', 'spin', 'flip', 'straighten', 'look-through', 'stroke', 'hug', 'wear']) {
  assert.ok(verbs.includes(v), v + ' is a verb');
  assert.ok(manip.includes(`case '${v}':`), v + ' does something');
}

// The physical parts are physics: no scripted motion stands in for the joints.
const physics = src('components/study-space/world/physics.ts');
assert.ok(physics.includes('JointData.prismatic'), 'a drawer runs on a prismatic joint');
assert.ok(physics.includes('JointData.revolute'), 'a door turns on a revolute joint');
assert.ok(physics.includes('this.asleep'), 'nothing to move, no physics step');
assert.ok(physics.includes('world.timestep = 1 / 60'), 'a fixed step');
const rush = src('components/features/games/echo-quiz-rush/rushReforged.ts');
assert.ok(!rush.includes('rapier') && !rush.includes('avatar'), 'race physics knows nothing of clothes or room physics');

// One journey: the page changes only when the body is through.
const page = src('components/study-space/StudySpace.tsx');
assert.ok(page.includes('w.journey(destination, () => { markArrival(destination); void leaveTo(href); }, direct)'), 'the route changes after the threshold, with the plain link as the way out');
assert.ok(manip.includes("{ name: 'stand'") && manip.includes("{ name: 'walk'") && manip.includes("{ name: 'door'") && manip.includes("{ name: 'through'"), 'stand, walk, door, through');

// The wardrobe.
for (const hero of ['LYRA', 'KAI']) {
  const n = L.outfitCount(hero);
  assert.ok(n >= 12, `${hero}: at least 12 complete outfits: ${n}`);
  for (const item of Object.values(L.itemsOf(hero))) assert.ok(existsSync(new URL('../public' + item.url, import.meta.url)), item.url + ' is in the build');
  const d = L.defaultLook(hero);
  assert.equal(d.accessories.length, 0, 'nothing is worn on the head unless chosen');
  assert.equal(L.isSignature(d), true);
  const wire = L.encodeLook({ ...d, top: 'hoodie', bottom: 'jeans', shoes: 'sneakers', accessories: ['headphones', 'glasses'] });
  const back = L.decodeLook(hero, wire);
  assert.equal(back.top, 'hoodie'); assert.equal(back.accessories.join(), 'headphones,glasses');
  assert.ok(/^[a-z]{1,16}(\.[a-z]{1,16}){2}\.(-|[a-z]{1,16}(\+[a-z]{1,16}){0,3})(\.[0-9a-f]{6}){5}$/.test(wire) && wire.length <= 96, 'the server\'s shape: ' + wire);
  assert.equal(L.isSignature(L.decodeLook(hero, 'http://evil.example/x.glb')), true, 'what is not a look is the character\'s own clothes');
  assert.equal(L.isSignature(L.normalizeLook(hero, { top: 'nothing.that.exists' })), true);
  const part = L.normalizeLook(hero, { top: 'tee' });
  assert.notEqual(part.bottom, L.SIGNATURE, 'a top alone still makes a whole outfit');
  assert.notEqual(part.shoes, L.SIGNATURE);
}
assert.equal(L.normalizeLook('KAI', { top: 'dress' }).top, L.SIGNATURE, 'each hero wears what was made for that hero');

// Keys.
const map = K.defaultKeymap();
assert.equal(new Set(Object.values(map)).size, Object.keys(map).length, 'no key does two things');
for (const held of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyG', 'KeyH', 'Space', 'Escape', 'Digit1']) assert.equal(K.actionForKey(map, held), null, held + ' stays the body\'s own');
assert.equal(K.remap(map, 'camera', 'KeyW'), null, 'WASD cannot be taken');

// Skin: no secret default: an old layout's headphones are not a choice.
assert.ok(src('lib/study-space/layout.ts').includes("accessory: 'none'"));
console.log('world interactions: ok');
