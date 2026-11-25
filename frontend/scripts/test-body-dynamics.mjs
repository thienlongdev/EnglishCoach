// Echo Life 5.0, a body with weight: the model that says where the hips go, how the trunk leans, and when a foot has to move. Numbers in real units.
import assert from 'node:assert/strict';
import { tsLoader } from './lib/ts-load.mjs';

const T = await import('three');
const load = tsLoader({ three: T });
const { Balance, PlantedFeet, GRAVITY } = load('lib/embodiment/balance.ts');

const support = { left: .14, right: .14, back: .1, front: .2 };
const frame = (over = {}) => ({ dt: 1 / 60, mass: 55, loads: [], force: null, ax: 0, az: 0, stepping: false, support, cx: 0, cz: 0, ...over });
const run = (b, seconds, over = {}) => { let out; for (let t = 0; t < seconds; t += 1 / 60) out = b.update(frame(over)); return out; };
const near = (a, b, e, why) => assert.ok(Math.abs(a - b) <= e, `${why ?? ''} ${a} is not ${b} ± ${e}`);

// ── Left alone it stands still, and comes back from small things without a step ──
{
  const b = new Balance();
  run(b, 2);
  near(b.x, 0, 1e-6); near(b.z, 0, 1e-6);
  b.impulse(0, .22);
  let most = 0, over = 0;
  for (let t = 0; t < 2; t += 1 / 60) { const o = b.update(frame()); most = Math.max(most, b.z); over = Math.max(over, o.over); }
  assert.ok(most > .02 && most < .12, 'a small push shows, and the soles hold it: ' + most);
  assert.equal(over, 0, 'no step for a small push');
  near(b.z, 0, .004, 'and it settles');
}
// ── A hard shove leaves the soles: a step is asked for ──
{
  const b = new Balance();
  b.impulse(0, 1.2);
  let over = 0, unstable = 0;
  for (let t = 0; t < .3; t += 1 / 60) { const o = b.update(frame()); over = Math.max(over, o.over); unstable = Math.max(unstable, o.unstable); }
  assert.ok(over > .03, 'the capture point is past the toes: ' + over);
  assert.ok(unstable > .7, 'and the body knows it: ' + unstable);
}
// ── A step under the capture point ends it: the weight is measured from the new middle of the feet ──
{
  const b = new Balance();
  b.impulse(0, 1.2);
  let t = 0, steps = 0, wait = 0;
  for (; t < 3; t += 1 / 60) {
    const o = b.update(frame());
    wait -= 1 / 60;
    if (o.over > .012 && wait <= 0) {
      // The foot lands half of the way there for the middle of the feet, a quarter second later.
      for (let s = 0; s < 15; s++) { b.update(frame({ support: { ...support, front: .12, back: .08 } })); t += 1 / 60; }
      b.z -= Math.min(.21, Math.max(0, b.z + b.vz / Math.sqrt(GRAVITY / .92)) * .56);
      steps++; wait = .05;
    }
  }
  assert.ok(steps >= 1 && steps <= 4, 'a stumble is a few steps, not a run: ' + steps);
  near(b.z, 0, .01, 'and it stands again');
}
// ── A weight held out in front: the body leans back, in proportion to its moment ──
{
  const b = new Balance();
  run(b, 3, { loads: [{ x: 0, z: .42, kg: 8 }] });
  near(b.z, -(8 * .42) / 55, .004, 'm·r over M');
  const big = new Balance();
  run(big, 3, { loads: [{ x: 0, z: .42, kg: 16 }] });
  assert.ok(big.z < b.z - .03, 'twice the weight, about twice the lean');
  const out = big.update(frame({ loads: [{ x: 0, z: .42, kg: 16 }] }));
  assert.ok(out.pitch < -.05, 'the trunk goes back: ' + out.pitch);
  assert.ok(out.hipZ < -.02, 'and the hips: ' + out.hipZ);
  assert.ok(out.sink > .005, 'knees soft under it: ' + out.sink);
}
// ── A bucket in the right hand: the body leans left ──
{
  // A chair in both hands can put the unloaded torso's projected centre
  // behind the heels while the combined centre stays over the feet.
  const balance = new Balance();
  const held = { loads: [{ x: 0, z: .50, kg: 13 }], support: { ...support, back: .055 } };
  const settled = run(balance, 8, held);
  near(balance.z, -.50 * 13 / 55, .004, 'static counterweight under a carried chair');
  near(settled.captureZ, 0, .004, 'capture point includes the held load');
  near(settled.over, 0, 1e-6, 'a supported load cannot trigger endless recovery steps');
}
{
  const b = new Balance();
  run(b, 3, { loads: [{ x: .32, z: .05, kg: 9 }] });
  assert.ok(b.x < -.03 && b.x > -.08, 'away from the weight: ' + b.x);
}
// ── Pushing: F·h = m·g·x. The furniture pushes back on the hands, so the weight goes forward ──
{
  const b = new Balance();
  const force = { x: 0, z: -150, height: .9 };
  const s = { ...support, front: .26, back: .26 };
  run(b, 3, { force, support: s });
  near(b.z, 150 * .9 / (55 * GRAVITY), .012, 'the lean that answers the force');
  const out = b.update(frame({ force, support: s }));
  assert.ok(out.pitch > .2, 'into it: ' + out.pitch);
  // Pulling: the other way.
  const p = new Balance();
  run(p, 3, { force: { x: 0, z: 150, height: .9 }, support: s });
  assert.ok(p.z < -.15, 'sitting back from a pull: ' + p.z);
}
// ── Walking: the stepping is the balance, nothing is ever "over" ──
{
  const b = new Balance();
  let over = 0;
  for (let t = 0; t < 4; t += 1 / 60) { const a = Math.sin(t * 7) * 4; const o = b.update(frame({ stepping: true, az: a, ax: a * .3 })); over = Math.max(over, o.over); }
  assert.equal(over, 0, 'no stumbling through a walk');
  assert.ok(Math.abs(b.z) < .1, 'and the weight stays over the walk: ' + b.z);
}
// ── Feet stay planted; too far and they step, one at a time ──
{
  const right = new T.Vector3(-1, 0, 0), forward = new T.Vector3(0, 0, 1), rootQ = new T.Quaternion();
  const feet = new PlantedFeet([1, -1]);
  const clip = [{ at: new T.Vector3(-.09, .08, 0), q: new T.Quaternion() }, { at: new T.Vector3(.09, .08, 0), q: new T.Quaternion() }];
  const fr = (extra = {}) => ({ dt: 1 / 60, stepping: false, rootAt: new T.Vector3(), rootQ, forward, right, stance: null, clip, k: 1, catchAt: null, ...extra });
  for (let i = 0; i < 30; i++) feet.update(fr());
  assert.equal(feet.steps, 0, 'standing: no steps');
  assert.equal(feet.plant, 1);
  // The body moved a little under them: they stay.
  clip[0].at.x -= .05; clip[1].at.x -= .05;
  for (let i = 0; i < 30; i++) feet.update(fr());
  assert.equal(feet.steps, 0, 'a small shift is not a step');
  near(feet.feet[0].at.x, -.09, 1e-6);
  // Further: one foot, then the other.
  clip[0].at.x -= .08; clip[1].at.x -= .08;
  let inAir = 0, both = 0;
  for (let i = 0; i < 120; i++) { feet.update(fr()); const n = feet.feet.filter(f => f.swing).length; inAir = Math.max(inAir, n); if (n > 1) both++; }
  assert.equal(both, 0, 'never both feet in the air');
  assert.equal(feet.steps, 2, 'one step each: ' + feet.steps);
  near(feet.feet[0].at.x, clip[0].at.x, .002, 'where the body now is');
  near(feet.feet[0].at.y, .08, 1e-6, 'and on the floor');
  // A wider stance is stepped into.
  const steps = feet.steps;
  for (let i = 0; i < 120; i++) feet.update(fr({ stance: { wide: .1 } }));
  assert.equal(feet.steps, steps + 2, 'a wider stance, two steps');
  near(feet.feet[0].at.x - clip[0].at.x, right.x * .1, .002);
  // Walking gives them back to the clip.
  for (let i = 0; i < 30; i++) feet.update(fr({ stepping: true }));
  assert.equal(feet.plant, 0);
  near(feet.feet[0].at.x, clip[0].at.x, 1e-6);
}
// A slow, fixed-target step must not inject an ankle impulse halfway through.
// Dense sampling straddles the historical phase-.55 sign discontinuity.
{
  const feet = new PlantedFeet([1, -1]), right = new T.Vector3(-1, 0, 0), forward = new T.Vector3(0, 0, 1);
  const clip = [1, -1].map(s => ({ at: new T.Vector3(-s * .09, .08, 0), q: new T.Quaternion() }));
  const frame = { dt: 1 / 10000, stepping: false, rootAt: new T.Vector3(), rootQ: new T.Quaternion(), forward, right, stance: null, clip, k: 1, catchAt: null };
  feet.update(frame); clip[0].at.z = .15;
  let previous = feet.feet[0].q.clone(), maxSpeed = 0, reversalSpeed = 0;
  for (let i = 0; i < 5500; i++) {
    feet.update(frame);
    const foot = feet.feet[0], speed = previous.angleTo(foot.q) / frame.dt;
    maxSpeed = Math.max(maxSpeed, speed);
    if (Math.abs(foot.phase - .55) < .001) reversalSpeed = Math.max(reversalSpeed, speed);
    previous.copy(foot.q);
  }
  assert.ok(maxSpeed < 6.1, 'no angular impulse during the whole step: ' + maxSpeed);
  assert.ok(reversalSpeed < .1, 'toe reversal has continuous angular velocity: ' + reversalSpeed);
  assert.equal(feet.steps, 1); assert.equal(feet.swinging, null);
  near(feet.feet[0].q.angleTo(clip[0].q), 0, 1e-7, 'lands at requested rotation');
}
console.log('PASS body dynamics: load balance, planted feet and continuous toe reversal.');
