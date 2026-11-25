// Actual shipped meshes. This qualifies topology/surface mapping, NOT physical
// support, contact response, humanoid manipulation or browser visual quality.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import * as T from 'three';
import {MeshBVH} from 'three-mesh-bvh';
import {loadCastGeometry} from './lib/load-cast.mjs';
import {fibreTopology, headSurface} from './lib/flexible-head-surface.mjs';

const sourceFiles=['scripts/lib/flexible-head-surface.mjs','scripts/test-flexible-head-surface.mjs','public/assets/study-space/study-care-aad100a0a3cc.glb'];
const sourceHashes=async()=>Object.fromEntries(await Promise.all(sourceFiles.map(async p=>[p,createHash('sha256').update(await readFile(new URL('../'+p,import.meta.url))).digest('hex')])));
const sourceBefore=await sourceHashes();console.log(JSON.stringify({phase:'source',hashes:sourceBefore}));

const pack = await loadCastGeometry(fileURLToPath(new URL('../public/assets/study-space/study-care-aad100a0a3cc.glb', import.meta.url)));
const expected = {'tool.broom': [420, 2, 4], 'tool.mop': [84, 9, 5], 'tool.webbrush': [300, 2, 3]};
const digest = g => createHash('sha256').update(Buffer.from(g.attributes.position.array.buffer)).update(Buffer.from(g.attributes.normal.array.buffer)).update(Buffer.from(g.attributes.uv.array.buffer)).digest('hex');
const area = g => {
  const a = g.attributes.position, ix = g.index, v = [new T.Vector3(), new T.Vector3(), new T.Vector3()]; let sum = 0;
  for (let i = 0; i < (ix?.count ?? a.count); i += 3) { for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(a, ix ? ix.getX(i + k) : i + k); sum += new T.Triangle(...v).getArea(); }
  return sum;
};
let checks = 0;
const ok = (condition, message) => { checks++; assert.ok(condition, message); };
for (const [kind, [count, rings, sides]] of Object.entries(expected)) {
  let tool, mesh;
  pack.scene.traverse(o => { if ((o.userData.name ?? o.name) === kind) tool = o; });
  tool.traverse(o => { if (o.isMesh && o.userData.noCollision && /^(Bristles|Strands)(\.\d+)?$/.test(o.userData.name ?? o.name)) mesh = o; });
  assert.ok(mesh, kind);
  const source = mesh.geometry, before = digest(source), begin = performance.now(), surface = headSurface(source), setupMs = performance.now() - begin;
  assert.equal(surface.topology.fibres.length, count); checks++;
  ok(surface.topology.fibres.every(f => f.rings.length === rings && f.rings.every(r => r.length === sides)), kind + ' authored rings');
  ok(surface.nodes.every(f => f.lengths.every((s, i) => !i || s - f.lengths[i - 1] <= .012000001)), kind + ' bounded rod segment length');
  const bvGeometry = source.clone(), bvh = new MeshBVH(bvGeometry), point = new T.Vector3(); let maxRestSurfaceError = 0;
  const a = surface.geometry.attributes.position;
  for (let i = 0; i < a.count; i++) {
    point.fromBufferAttribute(a, i);
    maxRestSurfaceError = Math.max(maxRestSurfaceError, bvh.closestPointToPoint(point).distance);
  }
  ok(maxRestSurfaceError <= 1e-7, kind + ' all subdivided vertices remain on authored triangles');
  const relativeAreaError = Math.abs(area(surface.geometry) / area(source) - 1);
  ok(relativeAreaError < 2e-6, kind + ' preserves complete authored surface area');
  const roots = surface.bindings.map((b, i) => b.segment === 0 && b.t === 0 ? i : -1).filter(i => i >= 0);
  for (let f = 0; f < surface.nodes.length; f++) {
    const node = surface.nodes[f], pose = surface.states[f], direction = new T.Vector3(.7, .1, -.4).normalize();
    for (let i = 0; i < node.centers.length; i++) {
      const u = node.lengths[i] / node.lengths.at(-1);
      pose.centers[i].addScaledVector(direction, .01 * u * u);
      pose.rotations[i].setFromAxisAngle(new T.Vector3(1, 0, 0), .16 * u);
    }
  }
  surface.write();
  let maxRootError = 0, maximumDeformation = 0;
  for (let i = 0; i < a.count; i++) {
    const error = point.fromBufferAttribute(a, i).distanceTo(new T.Vector3().fromArray(surface.restPositions, i * 3));
    maximumDeformation = Math.max(maximumDeformation, error);
  }
  for (const i of roots) maxRootError = Math.max(maxRootError, point.fromBufferAttribute(a, i).distanceTo(new T.Vector3().fromArray(surface.restPositions, i * 3)));
  ok(maxRootError < 1e-7, kind + ' fixed attachment');
  ok(maximumDeformation > .008, kind + ' material nodes actually deform visible vertices');
  ok([...a.array, ...surface.geometry.attributes.normal.array].every(Number.isFinite), kind + ' finite deformed surface');
  // One geometry instance cannot deform another clone or the loaded source.
  assert.equal(digest(source), before); checks++;
  const other = headSurface(source);
  assert.deepEqual(other.geometry.attributes.position.array, surface.restPositions); checks++;
  // Global frame covariance: any single rigid transform on every rod node must
  // produce that same transform on every visible vertex, without world axes.
  const q = new T.Quaternion().setFromEuler(new T.Euler(.93, -1.71, 2.23)), offset = new T.Vector3(.17, -.38, .53);
  for (let f = 0; f < surface.nodes.length; f++) for (let i = 0; i < surface.nodes[f].centers.length; i++) {
    surface.states[f].centers[i].copy(surface.nodes[f].centers[i]).applyQuaternion(q).add(offset);
    surface.states[f].rotations[i].copy(q);
  }
  surface.write(); let maxCovarianceError = 0;
  for (let i = 0; i < a.count; i++) {
    const target = new T.Vector3().fromArray(surface.restPositions, i * 3).applyQuaternion(q).add(offset);
    maxCovarianceError = Math.max(maxCovarianceError, point.fromBufferAttribute(a, i).distanceTo(target));
  }
  ok(maxCovarianceError < 1e-7, kind + ' arbitrary rigid frame covariance');
  for (let f = 0; f < surface.nodes.length; f++) for (let i = 0; i < surface.nodes[f].centers.length; i++) {
    surface.states[f].centers[i].copy(surface.nodes[f].centers[i]); surface.states[f].rotations[i].identity();
  }
  surface.write(); let maxRestoreError = 0;
  for (let i = 0; i < a.array.length; i++) maxRestoreError = Math.max(maxRestoreError, Math.abs(a.array[i] - surface.restPositions[i]));
  ok(maxRestoreError < 1e-7, kind + ' exact undeformed restoration');
  const validDrawing=surface.geometry.attributes.position.array.slice();
  surface.states.at(-1).centers.at(-1).x=NaN;
  assert.throws(()=>surface.write(),/Invalid head pose/);checks++;
  assert.deepEqual(surface.geometry.attributes.position.array,validDrawing);checks++;
  surface.states.at(-1).centers.at(-1).copy(surface.nodes.at(-1).centers.at(-1));
  assert.throws(()=>surface.write([]),/topology mismatch/);checks++;
  // Extracting the same mesh after arbitrary rotation must not swap root/tip.
  for (const angles of [[2.7, -.4, .6], [-1.9, 2.2, -2.6], [.4, .8, 1.2]]) {
    const rotation = new T.Quaternion().setFromEuler(new T.Euler(...angles));
    const rotated = source.clone().applyQuaternion(rotation), topology = fibreTopology(rotated);
    assert.equal(topology.fibres.length, count); checks++;
    ok(topology.fibres.every((f, i) => f.centers[0].distanceTo(surface.topology.fibres[i].centers[0].clone().applyQuaternion(rotation)) < 1e-7), kind + ' rotation-independent attachments');
    rotated.dispose();
  }
  const times = [];
  for (let i = 0; i < 20; i++) surface.write();
  for (let i = 0; i < 120; i++) { const at = performance.now(); surface.write(); times.push(performance.now() - at); }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({kind, fibres: count, authoredRings: rings, nodes: surface.nodes.reduce((n, f) => n + f.centers.length, 0), sourceTriangles: surface.topology.sourceTriangles, surfaceTriangles: a.count / 3, setupMs, writeP95Ms: times[Math.floor(times.length*.95)], maxRestSurfaceError, relativeAreaError, maxRootError, maximumDeformation, maxCovarianceError, maxRestoreError, limitation: 'surface/topology only; no rod physics, collision, runtime or rendered visual acceptance'}));
  surface.dispose(); other.dispose(); bvGeometry.dispose();
}
assert.throws(() => fibreTopology(new T.BoxGeometry()), /boundaries/); checks++;
assert.throws(() => headSurface(new T.BoxGeometry(), 0), /segment length/); checks++;
assert.deepEqual(await sourceHashes(),sourceBefore);checks++;
console.log(JSON.stringify({checks, result: 'PASS', sourceUnchanged:true, scope: 'authored fibre surface mapping only'}));
