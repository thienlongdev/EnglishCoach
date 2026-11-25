// One body, one posture authority, hands that are hands; sign-in that spends one Turnstile token per attempt; a room that cannot be lost by one press.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
const require = createRequire(import.meta.url), babel = require('next/dist/compiled/babel/bundle.js');
const root = new URL('../src/', import.meta.url);
const read = (file) => readFileSync(new URL(file, root), 'utf8');
function load(file, deps = {}) {
  const { code } = babel.core().transformSync(read(file), { filename: file, configFile: false, babelrc: false, presets: [babel.presetTypescript()], plugins: [babel.pluginTransformModulesCommonjs()] });
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, require: (n) => deps[n] ?? require(n), Math, console });
  return module.exports;
}

// ── Posture: asking again for the seat in use changes nothing ──────────────────────────────────────────────
const { PostureMachine } = load('lib/embodiment/posture.ts');
const body = new PostureMachine();
assert.equal(body.request('chair', false), true);
assert.equal(body.state, 'approaching');
body.arrived(); body.settled();
assert.equal(body.state, 'seated');
const changes = body.changes;
for (let i = 0; i < 50; i++) assert.equal(body.request('chair', false), false, 'the same seat again is not a command');
assert.equal(body.changes, changes, 'a repeated request can never make a seated body stand and sit');
body.stand();
assert.equal(body.state, 'rising');
body.risen();
assert.equal(body.state, 'standing');
assert.equal(body.request('bed', true), true); body.arrived(); body.settled();
assert.equal(body.state, 'lying');
assert.equal(body.request('chair', false), true, 'another seat: up first');
assert.equal(body.state, 'rising');
body.risen();
assert.equal(body.state, 'approaching');

// ── Poses ──────────────────────────────────────────────────────────────────────────────────────────────────
const P = load('lib/embodiment/poses.ts', { three: THREE });
for (let t = 0; t <= P.GESTURE_SECONDS.clap; t += .004) {
  const clap = P.gesturePose('clap', 1, t);
  assert.ok(clap.wrist[0] >= P.CLAP_CONTACT - 1e-9, 'clapping hands meet at their thickness and never pass through each other');
  assert.ok(clap.fingers[0] <= 0 && clap.fingers[0] > -.1, 'the hands lean in only as much as a palm is thicker than its fingers');
  assert.ok(clap.palm[0] < -.9, 'palms face each other');
}
{
  // Every clap is a real contact, reached faster than it is left, and there are as many contacts as beats.
  assert.ok(P.CLAP_BEATS.length >= 3);
  for (const beat of P.CLAP_BEATS) {
    assert.equal(P.clapState(beat + .001).open, 0, 'palm on palm at the beat');
    assert.ok(P.clapState(beat - .08).open > P.clapState(beat + .08 + .03).open * .5);
    assert.ok(P.clapState(beat + .005).impact > .8, 'the impact is at the contact');
    assert.ok(P.clapState(beat + .25).impact < .02, 'and has gone a moment later');
  }
  const gaps = P.CLAP_BEATS.slice(1).map((b, i) => +(b - P.CLAP_BEATS[i]).toFixed(3));
  assert.ok(new Set(gaps).size > 1, 'not a metronome');
  const closing = (.5 - P.clapState(P.CLAP_BEATS[1] - .02).open), opening = (.5 - P.clapState(P.CLAP_BEATS[1] + .05).open);
  assert.ok(closing !== opening);
}
assert.equal(P.gesturePose('wave', -1, 1), null, 'one hand waves');
for (const g of ['wave', 'clap', 'cheer', 'listen', 'inspect', 'reach', 'dance', 'hop']) {
  assert.ok(P.GESTURE_SECONDS[g] > 0);
  assert.equal(P.gestureEnvelope(g, 0), 0, `${g} eases in`);
  assert.ok(P.gestureEnvelope(g, P.GESTURE_SECONDS[g]) < .001, `${g} eases out`);
}
// The right hand, palm in, fingers forward: the thumb is up, on a mirrored authored left hand whose thumb lies on -X.
const q = P.handRotation(new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0));
const mirroredThumb = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
assert.ok(mirroredThumb.y > .99, 'the frame is right-handed and the thumb side follows from the mesh');

// ── Wrists: every pose stays inside what a forearm and a wrist can do, on both hands, through the whole gesture ──
const Arm = load('lib/embodiment/arms.ts', { three: THREE });
const body3 = (a, s) => new THREE.Vector3(s * a[0], a[1], -a[2]);
const strained = (name, side, pose, limit) => {
  const shoulder = new THREE.Vector3(side * .19, -.26, -.02), arm = Arm.solveArm(shoulder, body3(pose.wrist, side), shoulder.clone().add(body3(pose.pole, side)));
  const hand = P.handRotation(body3(pose.fingers, side), body3(pose.palm, side)), forearm = arm.wrist.clone().sub(arm.elbow);
  Arm.alignWrist(hand, forearm, limit);
  const fingers = new THREE.Vector3(0, 1, 0).applyQuaternion(hand), palm = new THREE.Vector3(0, 0, 1).applyQuaternion(hand);
  const { bend, roll } = Arm.wristStrain(side, arm.shoulder, arm.elbow, arm.wrist, fingers, palm);
  assert.ok(bend <= limit + 1e-3, `${name}: wrist bends ${bend.toFixed(2)} rad`);
  assert.ok(Math.abs(roll) <= 1.65, `${name}: forearm rolls ${roll.toFixed(2)} rad, past what an arm can`);
  // A hand parallel to its forearm has its fingers pointing away from the elbow, never back along the arm.
  assert.ok(fingers.dot(forearm.normalize()) > .4, `${name}: fingers follow the forearm`);
};
for (const side of [-1, 1]) {
  for (const g of ['wave', 'clap', 'cheer', 'listen', 'inspect', 'reach', 'dance', 'hop']) for (let t = 0; t <= P.GESTURE_SECONDS[g]; t += .05) {
    const pose = P.gesturePose(g, side, t);
    if (pose) strained(`${g}@${t.toFixed(2)}`, side, pose, P.wristLimit(g, 1));
  }
}
// ── The world's own writes are not commands ────────────────────────────────────────────────────────────────
const space = read('components/study-space/StudySpace.tsx');
const engine = read('components/study-space/world/engine.ts');
const character = read('components/study-space/world/character.ts');
assert.doesNotMatch(engine, /poseKey/, 'no layout echo re-places the body');
assert.match(engine, /ch\.occupies\(anchorId\)/);
assert.doesNotMatch(character, /if \(this\.seat\) \{ this\.activity = 'idle'; this\.standUp\(\); return false; \}/, 'a movement key does not stand a seated body up');
assert.match(space, /w\.exploration\.active\) return;/, 'the focus timer never moves a body the learner is in');
assert.doesNotMatch(space, /const \{ state: focus \} = useFocus\(\)/, 'a timer tick re-renders nothing of the page');
assert.doesNotMatch(read('components/study-space/ExplorerControls.tsx'), /roomName|\.help\b|s\.help\}/, 'no development label, no permanent instruction box');
assert.match(read('components/study-space/FocusDock.tsx'), /data-morph="off"/, 'a press on the dock is not the page\'s business');
assert.match(space, /journeyGo\(href\)/, 'doors reuse the one passage engine');
assert.doesNotMatch(space, /startViewTransition/);

// ── A room cannot be lost by one press ─────────────────────────────────────────────────────────────────────
const toolbar = read('components/study-space/Toolbar.tsx');
assert.match(toolbar, /onClick=\{\(\) => api\.askClear\(\)\} data-testid="tool-clear"/);
assert.doesNotMatch(toolbar, /api\.clearAll\(\)/, 'the toolbar cannot clear directly');
assert.match(space, /Chưa xóa được vì chưa lưu được/, 'an unsaved clear gives the room back');

// ── Sign-in ────────────────────────────────────────────────────────────────────────────────────────────────
const route = read('app/api/auth/[...nextauth]/route.ts');
const login = route.slice(route.indexOf('const loginBody'), route.indexOf('pages: {'));
assert.match(login, /if \(neverDelivered\(e\)\) continue;/, 'only a connection that never opened may try another address');
assert.equal((login.match(/\bcontinue;/g) || []).length, 1, 'no other path sends the same token again');
assert.match(login, /throw new Error\("AUTH_UNAVAILABLE"\)/, 'a server fault is told as one');
assert.match(read('lib/server/internal-auth.ts') + '\n' + read('lib/server/backend-origin.ts'), /new Set\(/, 'one address is never tried twice');
for (const form of ['LoginForm', 'RegisterForm', 'ForgotPasswordForm']) {
  const source = read(`components/auth/${form}.tsx`);
  assert.match(source, /freshToken\(\)/, `${form} asks the widget for an unspent token`);
  assert.doesNotMatch(source, /turnstileToken \|\| undefined/, `${form} never reuses the state copy`);
  assert.match(source, /submitting\.current/, `${form} sends one request per submit`);
}
const widget = read('components/auth/TurnstileChallenge.tsx');
assert.match(widget, /spentRef\.current = true/);
assert.match(widget, /isExpired/);
console.log('PASS human immersion: posture authority, anatomical poses, world writes, clear safety, one token per sign-in attempt.');
