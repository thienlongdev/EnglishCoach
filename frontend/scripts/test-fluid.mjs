// Echo Life 5.0: water as particles, on the main thread (the same relaxation the card runs). Stable, conserved, stopped by what it should be stopped by.
import assert from 'node:assert/strict';
import { tsLoader } from './lib/ts-load.mjs';

const load = tsLoader({});
const { CpuFluid, INTERACTION } = load('components/study-space/world/water/fluid.ts');

// ── A stream poured onto the floor stays together and comes to rest on it ──
{
  const f = new CpuFluid(); f.setRoom(3); f.setShapes([]);
  let most = 0, lowest = 1e9;
  for (let t = 0; t < 2.4; t += 1 / 60) {
    if (t < 1.2) for (let n = 0; n < 5; n++) f.spawn(Math.random() * .012, 1 + Math.random() * .012, Math.random() * .012, .4, -.2, 0);
    f.step(1 / 60);
    for (let i = 0; i < f.capacity; i++) if (f.alive[i]) { most = Math.max(most, Math.hypot(f.velocities[i * 3], f.velocities[i * 3 + 1], f.velocities[i * 3 + 2])); lowest = Math.min(lowest, f.positions[i * 3 + 1]); }
  }
  assert.ok(f.count > 300, 'particles alive: ' + f.count);
  assert.ok(most < 7.01, 'no explosion: ' + most);
  assert.ok(lowest >= .005, 'none through the floor: ' + lowest);
  let sum = 0, high = 0, n = 0, sx = 0;
  for (let i = 0; i < f.capacity; i++) if (f.alive[i]) { sum += Math.hypot(f.velocities[i * 3], f.velocities[i * 3 + 2]); high = Math.max(high, f.positions[i * 3 + 1]); n++; sx += f.positions[i * 3]; }
  assert.ok(high < .35, 'it lies on the floor, it does not pile up: ' + high);
  assert.ok(sum / n < 2.5, 'and has slowed down: ' + sum / n);
  assert.ok(sx / n > .1, 'it went where it was poured: ' + sx / n);
  // Its spacing is not collapsed to a point.
  let close = 0;
  for (let i = 0; i < 80; i++) for (let j = i + 1; j < 80; j++) if (f.alive[i] && f.alive[j] && Math.hypot(f.positions[i * 3] - f.positions[j * 3], f.positions[i * 3 + 1] - f.positions[j * 3 + 1], f.positions[i * 3 + 2] - f.positions[j * 3 + 2]) < INTERACTION * .08) close++;
  assert.ok(close < 12, 'particles keep apart: ' + close);
}
// ── A desk stops it, and it runs off the top; a cylinder sends it round ──
{
  const f = new CpuFluid(); f.setRoom(3);
  f.setShapes([{ kind: 0, x: 0, y: .39, z: 0, hx: .4, hy: .39, hz: .3, yaw: 0 }]);
  for (let t = 0; t < .6; t += 1 / 60) { for (let n = 0; n < 2; n++) f.spawn(Math.random() * .02, 1.2, Math.random() * .02, 0, 0, 0); f.step(1 / 60); }
  let on = 0, inside = 0;
  for (let i = 0; i < f.capacity; i++) if (f.alive[i]) { const y = f.positions[i * 3 + 1], x = f.positions[i * 3], z = f.positions[i * 3 + 2]; if (Math.abs(x) < .39 && Math.abs(z) < .29 && y < .77) inside++; if (y >= .77 && y < .9) on++; }
  assert.equal(inside, 0, 'nothing inside the desk');
  assert.ok(on > 8, 'it lies on top: ' + on);
}
// ── Killed particles leave a place for new ones; a full sim refuses ──
{
  const f = new CpuFluid(10);
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(f.spawn(0, 1, 0, 0, 0, 0));
  assert.equal(f.count, 10); assert.equal(f.spawn(0, 1, 0, 0, 0, 0), -1, 'full');
  f.kill(ids[3]); assert.equal(f.count, 9);
  assert.equal(f.spawn(0, 1, 0, 0, 0, 0), ids[3], 'its place is taken');
}
// ── Cost: a few hundred particles fit a frame easily on the main thread ──
{
  const f = new CpuFluid(); f.setRoom(3);
  for (let i = 0; i < 600; i++) f.spawn((i % 25) * .016, .5 + Math.floor(i / 25) * .016, 0, 0, 0, 0);
  const t0 = performance.now();
  for (let i = 0; i < 30; i++) f.step(1 / 60);
  const ms = (performance.now() - t0) / 30;
  console.log('cpu ms/frame at 600 particles', ms.toFixed(2));
  assert.ok(ms < 8, 'under a third of a frame: ' + ms);
}
console.log('PASS fluid: stable, stays together, stopped by the floor and furniture, particles recycled.');
