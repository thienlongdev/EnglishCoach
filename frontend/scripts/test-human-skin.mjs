// Exercise the exported skin with the actual HumanRig. CPU measurements complement browser inspection.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { tsLoader } from './lib/ts-load.mjs';

const { HumanRig } = tsLoader({ three: T })('lib/embodiment/human.ts');
const assets = readFileSync(new URL('../src/components/features/speaking/arena/arenaAssets.ts', import.meta.url), 'utf8');
const argument = key => { const i = process.argv.indexOf(key); return i < 0 ? null : process.argv[i + 1]; };
async function cast(url) {
  const data = readFileSync(new URL('../public' + url, import.meta.url));
  const n = data.readUInt32LE(12), j = JSON.parse(data.subarray(20, 20 + n));
  j.materials = j.materials.map(m => ({ name: m.name })); delete j.textures; delete j.images;
  const raw = Buffer.from(JSON.stringify(j)), json = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 32); raw.copy(json);
  const bin = data.subarray(20 + n), header = Buffer.from(data.subarray(0, 20));
  header.writeUInt32LE(20 + json.length + bin.length, 8); header.writeUInt32LE(json.length, 12);
  const b = Buffer.concat([header, json, bin]);
  return new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '');
}
const report = { cpuOnly: true, heroes: {}, failures: [] };
for (const hero of ['LYRA', 'KAI']) {
  const url = argument('--' + hero.toLowerCase()) || assets.match(new RegExp(hero + ": '([^']+)'"))[1];
  const gltf = await cast(url), root = new T.Group(), model = gltf.scene; root.add(model);
  model.scale.setScalar(1.04); root.updateWorldMatrix(true, true);
  const rig = new HumanRig(model, root), mixer = new T.AnimationMixer(model);
  mixer.clipAction(gltf.animations.find(c => c.name === 'Idle')).play();
  const meshes = [];
  model.traverse(m => {
    if (!m.isSkinnedMesh || !['Runner_Body', 'Runner_Hands'].includes(m.name)) return;
    const pos = m.geometry.getAttribute('position'), si = m.geometry.getAttribute('skinIndex'), sw = m.geometry.getAttribute('skinWeight');
    const rest = Array.from({ length: pos.count }, (_, i) => new T.Vector3().fromBufferAttribute(pos, i));
    let badWeights = 0, torsoHeadWeights = 0;
    for (let i = 0; i < pos.count; i++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const index = si.getComponent(i, k), weight = sw.getComponent(i, k);
        if (!Number.isFinite(weight) || weight < 0 || !m.skeleton.bones[index]) badWeights++;
        sum += weight;
        // The Arena cast has its face in a separate mesh. The old proximity test accidentally bound shoulder vertices to head.
        if (m.name === 'Runner_Body' && weight > .001 && m.skeleton.bones[index]?.name === 'head') torsoHeadWeights++;
      }
      if (Math.abs(sum - 1) > .00001) badWeights++;
    }
    const unique = new Set(), edges = [], idx = m.geometry.index;
    for (let i = 0; i < (idx?.count ?? pos.count); i += 3) for (let k = 0; k < 3; k++) {
      let a = idx ? idx.getX(i + k) : i + k, b = idx ? idx.getX(i + (k + 1) % 3) : i + (k + 1) % 3;
      if (a > b) [a, b] = [b, a]; const key = a + ':' + b;
      if (unique.has(key)) continue; unique.add(key);
      const length = rest[a].distanceTo(rest[b]);
      if (length > .002) edges.push({ a, b, length });
    }
    meshes.push({ mesh: m, edges, stats: { name: m.name, vertices: pos.count, badWeights, torsoHeadWeights, worst: [] } });
  });
  const frame = () => {
    rig.restore(); mixer.update(1 / 60); rig.capture(); root.updateWorldMatrix(true, true);
    rig.update({ dt: 1 / 60, reduced: false, own: false, eye: new T.Vector3(0, 1.6, .02), lookYaw: 0, lookPitch: 0 });
    root.updateWorldMatrix(true, true);
  };
  for (const angle of [0, .5, 1, 1.5, 2, 2.5]) {
    const f = new T.Vector3(Math.sin(angle), .12, Math.cos(angle)).normalize();
    for (const side of [1, -1]) rig.setContact(side, { wrist: new T.Vector3(-side * .23, 1.14, .31), fingers: f.clone(), palm: new T.Vector3(0, 1, 0), grip: 'book' }, .01);
    for (let t = 0; t < 45; t++) frame();
    for (const { mesh, edges, stats } of meshes) {
      mesh.skeleton.update();
      const deformed = Array.from({ length: mesh.geometry.getAttribute('position').count }, (_, i) => mesh.getVertexPosition(i, new T.Vector3()));
      const worst = edges.map(e => ({ a: e.a, b: e.b, rest: e.length, length: deformed[e.a].distanceTo(deformed[e.b]) }))
        .map(e => ({ ...e, ratio: e.length / e.rest, angle })).sort((a, b) => b.ratio - a.ratio).slice(0, 3);
      stats.worst.push(...worst);
    }
  }
  for (const { stats } of meshes) {
    stats.worst.sort((a, b) => b.ratio - a.ratio); stats.worst = stats.worst.slice(0, 5);
    if (stats.badWeights) report.failures.push(`${hero} ${stats.name}: ${stats.badWeights} invalid weights`);
    if (stats.torsoHeadWeights) report.failures.push(`${hero}: ${stats.torsoHeadWeights} body weights bound to head`);
    const tear = stats.worst.find(e => e.ratio > 4 && e.length - e.rest > .02);
    if (tear) report.failures.push(`${hero} ${stats.name}: edge ${tear.a}:${tear.b} grows ${tear.ratio.toFixed(2)}x`);
  }
  report.heroes[hero] = { url, meshes: meshes.map(m => m.stats) };
}
report.passed = report.failures.length === 0;
if (argument('--report')) writeFileSync(argument('--report'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
assert.equal(report.passed, true, report.failures.join('; '));
