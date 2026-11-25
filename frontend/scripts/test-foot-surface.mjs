// Independent actual Three skinning vs measured rigid shoe surface, both production casts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from 'three';
import { loadCastGeometry } from './lib/load-cast.mjs';
import { tsLoader } from './lib/ts-load.mjs';
const { FootSurface } = tsLoader({ three: T })('lib/embodiment/footSurface.ts');
const assets = readFileSync(new URL('../src/components/features/speaking/arena/arenaAssets.ts', import.meta.url), 'utf8');
let samples = 0, error = 0;
for (const hero of ['LYRA', 'KAI']) {
  const { scene: model } = await loadCastGeometry(assets.match(new RegExp(hero + ": '([^']+)'"))[1]);
  model.position.set(2.1, .71, -1.42); model.rotation.set(.12, .87, -.06); model.scale.setScalar(.83); model.updateMatrixWorld(true);
  for (const side of ['L', 'R']) {
    let foot; model.traverse(b => { if (b.isBone && (b.userData.name ?? b.name) === 'foot.' + side) foot = b; });
    const surface = new FootSurface(model, foot), rest = foot.quaternion.clone();
    assert.ok(surface.vertices > 20, 'actual indexed rigid shoe vertices required');
    const meshes = [];
    model.traverse(m => {
      if (!m.isSkinnedMesh) return;
      const index = m.skeleton.bones.indexOf(foot), g = m.geometry, drawn = new Set(g.index.array), indices = [];
      for (const i of drawn) {
        let weight = 0; for (let k = 0; k < 4; k++) if (g.attributes.skinIndex.getComponent(i, k) === index) weight += g.attributes.skinWeight.getComponent(i, k);
        if (Math.abs(weight - 1) < 1e-6) indices.push(i);
      }
      if (indices.length) meshes.push({ m, indices });
    });
    for (let i = 0; i < 80; i++) {
      foot.quaternion.copy(rest).multiply(new T.Quaternion().setFromEuler(new T.Euler(Math.sin(i * 2.399) * .7, Math.cos(i * 1.417) * 2, Math.sin(i * .733) * .3)));
      model.scale.setScalar(.7 + (i % 11) * .05); model.updateMatrixWorld(true);
      const position = foot.getWorldPosition(new T.Vector3()), rotation = foot.getWorldQuaternion(new T.Quaternion()), scale = foot.getWorldScale(new T.Vector3());
      const predicted = position.y + surface.offsetY(rotation, scale), p = new T.Vector3(); let actual = Infinity;
      for (const { m, indices } of meshes) { m.skeleton.update(); for (const v of indices) { m.getVertexPosition(v, p).applyMatrix4(m.matrixWorld); actual = Math.min(actual, p.y); } }
      error = Math.max(error, Math.abs(actual - predicted)); samples++;
    }
    foot.quaternion.copy(rest); model.updateMatrixWorld(true);
  }
}
assert.ok(error < 1e-7, 'measured clearance matches independent skinning: ' + error);
console.log(JSON.stringify({ samples, maximumErrorMeters: error, casts: 2, feet: 4 }));
