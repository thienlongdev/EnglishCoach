// The captured Walk and Run, put right for each cast (lib/embodiment/gaitClip.ts), measured on the shipped skeletons.
// Norms: Perry and Burnfield, Gait Analysis (2010); Winter, Biomechanics and Motor Control of Human Movement (2009);
// Novacheck, The biomechanics of running, Gait and Posture 7 (1998).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadCastGeometry } from './lib/load-cast.mjs';
import { tsLoader } from './lib/ts-load.mjs';
const load = tsLoader({ three: T, '@/lib/embodiment/skin': {}, '@/lib/embodiment/cast': {}, '@/lib/avatar/wardrobe': {}, '@/lib/avatar/look': {} });
const { HumanRig } = load('lib/embodiment/human.ts'), { correctGaits } = load('lib/embodiment/gaitClip.ts');
const assets = readFileSync(new URL('../src/components/features/speaking/arena/arenaAssets.ts', import.meta.url), 'utf8');
for (const hero of ['LYRA', 'KAI']) {
  const gltf = await loadCastGeometry(assets.match(new RegExp(hero + ": '([^']+)'"))[1]);
  for (const [scale, yaw] of [[1, 0], [.85, 1.3]]) {
    const stage = new T.Group(), root = new T.Group(), model = clone(gltf.scene);
    stage.scale.setScalar(scale); stage.rotation.y = yaw; stage.add(root); model.scale.setScalar(1.04); root.add(model); stage.updateMatrixWorld(true);
    const rig = new HumanRig(model, root), { clips, reports } = correctGaits(gltf.animations, model, rig.gaitSkeleton);
    assert.equal(clips.length, gltf.animations.length, 'every other clip kept');
    for (const kind of ['Walk', 'Run']) {
      const r = reports[kind];
      assert.ok(r, hero + ' ' + kind + ' corrected');
      console.log(JSON.stringify({ hero, scale, kind, ...r }));
      assert.ok(r.minSole >= -1e-6, 'sole never under the floor');
      assert.ok(r.maxSlip < 1e-6, 'a flat stance shoe never skates against the floor it is played over');
      assert.ok(r.maxAnkleTwist < 15, 'no sideways twist of the shoe about the shin');
      if (kind === 'Walk') {
        assert.ok(r.stanceKnee[1] < 18 && r.stanceKnee[2] < 30, 'walking stance knee: 5 to 20 degrees, not a crouch');
        assert.ok(r.stanceShare.every(v => v > .57 && v < .66), 'a walking foot is on the floor about 60 % of the stride');
        assert.ok(r.swingKneeMax > 55 && r.swingKneeMax < 75, 'swing knee flexion about 60 degrees');
        assert.ok(r.speed > .8 && r.speed < 1.1, 'drawn for a walker’s pace');
      } else {
        assert.ok(r.stanceKnee[1] > 25 && r.stanceKnee[1] < 50, 'running stance knee near 40 degrees');
        assert.ok(r.swingKneeMax > 90, 'running swing knee folds past 90 degrees');
        assert.ok(r.stanceShare.every(v => v < .5), 'a running stride has a flight');
      }
    }
  }
}
console.log('PASS gait clips: upright walking stance, flat non-skating shoes on the floor, no shoe twist, running flight, both casts');
