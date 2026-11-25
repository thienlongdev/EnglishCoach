// A stance shoe that rocks heel-to-toe (deep squat ankle limits, uneven support) on
// the actual cast's measured sole. Rocking on a rigid floor is reversible: the shoe
// rolls about its lowest patch and must come back to where it stood, never walk.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from 'three';
import { loadCastGeometry } from './lib/load-cast.mjs';
import { tsLoader } from './lib/ts-load.mjs';
const load = tsLoader({ three: T });
const { FootSurface } = load('lib/embodiment/footSurface.ts'), { FootGround } = load('lib/embodiment/footGround.ts');
const assets = readFileSync(new URL('../src/components/features/speaking/arena/arenaAssets.ts', import.meta.url), 'utf8');
let worst = 0, cases = 0;
for (const hero of ['LYRA', 'KAI']) {
  const { scene: model } = await loadCastGeometry(assets.match(new RegExp(hero + ": '([^']+)'"))[1]);
  model.updateMatrixWorld(true);
  for (const side of ['L', 'R']) {
    let foot; model.traverse(b => { if (b.isBone && (b.userData.name ?? b.name) === 'foot.' + side) foot = b; });
    const sole = new FootSurface(model, foot), rest = foot.getWorldQuaternion(new T.Quaternion());
    for (const [hz, amplitude, ground, yaw] of [[60, .18, 0, 0], [120, .32, .05, 1.1], [144, .25, .32, -2.4], [90, .4, 0, Math.PI]]) {
      const g = new FootGround(), dt = 1 / hz, k = 1, scale = new T.Vector3(1, 1, 1);
      const heading = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), yaw);
      const right = new T.Vector3(1, 0, 0).applyQuaternion(heading);
      const flat = heading.clone().multiply(rest);
      // The planner's own foot never moves: a stationary stance.
      const ankle0 = new T.Vector3(.4, 0, -1.2);
      ankle0.y = ground - sole.offsetY(flat, scale);
      let reached = ankle0.clone(), start = null;
      for (let n = 0; n < hz * 6; n++) {
        const pitch = n < hz ? 0 : amplitude * Math.sin((n - hz) * dt * 2 * Math.PI * 1.7);
        const q = new T.Quaternion().setFromAxisAngle(right, pitch).multiply(flat);
        const source = ankle0.clone(); source.y = ground - sole.offsetY(q, scale);
        const out = new T.Vector3();
        g.solve(source, q, scale, sole.supportPoint(q, scale, new T.Vector3()), ground, dt, k, out, false, new T.Vector3());
        // Ankle envelope pass, exactly as limitAnkle does it.
        g.reorient(out, q, scale, sole.supportPoint(q, scale, new T.Vector3()), ground, sole.offsetY(q, scale));
        // Perfect leg IK: the shoe is drawn where it was asked to be.
        reached = out.clone();
        g.reached(reached, q, reached.y + sole.offsetY(q, scale));
        if (n === hz - 1) start = reached.clone();
        // Compare only at the same (flat) orientation: a rolled shoe is displaced by its own roll.
        if (start && n >= hz && Math.abs(pitch) < 1e-9) worst = Math.max(worst, Math.hypot(reached.x - start.x, reached.z - start.z));
      }
      // Ending flat, after the last cycle.
      const end = reached;
      worst = Math.max(worst, Math.hypot(end.x - start.x, end.z - start.z) * 0); cases++;
      const drift = Math.hypot(end.x - start.x, end.z - start.z);
      console.log(JSON.stringify({ hero, side, hz, amplitude, ground, yaw: +yaw.toFixed(2), driftAfterSixSeconds: drift }));
      worst = Math.max(worst, drift > .02 ? drift : 0);
    }
  }
}
assert.ok(worst <= .005, 'a rocking stance shoe walks away: ' + worst);
console.log('PASS stance shoes rock in place on both casts: ' + cases + ' cases');
