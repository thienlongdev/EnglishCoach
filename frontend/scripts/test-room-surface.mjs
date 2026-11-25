// Actual captured room, independent source geometry and lifecycle checks.
import assert from 'node:assert/strict';
import * as T from 'three';
import R from '@dimforge/rapier3d-compat';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { tsLoader } from './lib/ts-load.mjs';
await R.init();
const here = dirname(fileURLToPath(import.meta.url)), frontend = resolve(here, '..');
const input = resolve(process.argv[2]), out = resolve(process.argv[3]); mkdirSync(out);
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const files = ['src/components/study-space/world/physics.ts', 'src/components/study-space/world/roomSurface.ts', 'scripts/test-room-surface.mjs'].map(p => resolve(frontend, p));
const hashes = () => Object.fromEntries(files.map(p => [p, sha(p)]));
const report = { scope: 'Captured room exact geometry, native contact non-regression and lifecycle; analytic 1um accuracy is reported separately, not assumed.', before: hashes(), cases: [], contacts: 0, maxError: 0, maxNativeDifference: 0, analyticWithin1um: true, inheritedAnalyticMisses: 0, errors: [] };
for (const f of files) writeFileSync(resolve(out, f.split(/[\\/]/).at(-1)), readFileSync(f), { flag: 'wx' });
const bytes = readFileSync(resolve(input, 'world-before-step.bin'));
const capture = JSON.parse(readFileSync(resolve(input, 'report.json'), 'utf8'));
assert.equal(createHash('sha256').update(bytes).digest('hex'), capture.snapshot.sha256);
const world = R.World.restoreSnapshot(bytes); let original;
world.forEachCollider(c => { if (c.shape instanceof R.TriMesh && c.shape.indices.length / 3 === capture.measurements.meta.roomTriangles) original = c.shape; });
assert.ok(original);
const vertices = original.vertices.slice(), indices = original.indices.slice(); world.free();
const { StudyPhysics } = tsLoader({ three: T })('components/study-space/world/physics.ts');
const expand = (v, ix) => Array.from({ length: ix.length / 3 }, (_, face) => {
  const b = Buffer.alloc(36); for (let j = 0; j < 9; j++) b.writeFloatLE(v[ix[face * 3 + Math.floor(j / 3)] * 3 + j % 3], j * 4); return b.toString('hex');
}).sort();
let ph;
try {
  for (const [yaw, scale] of [[0, 1], [.713, .85], [2.371, 1.2]]) {
    ph = new StudyPhysics(R, () => {});
    const stage = new T.Group(), room = new T.Group(), geometry = new T.BufferGeometry();
    stage.position.set(.8, -.1, .6); stage.rotation.y = -.31; stage.scale.setScalar(1.1);
    room.position.set(.15, .02, -.3); room.rotation.y = yaw; room.scale.setScalar(scale); stage.add(room);
    geometry.setAttribute('position', new T.BufferAttribute(vertices.slice(), 3)); geometry.setIndex(new T.BufferAttribute(indices.slice(), 1));
    room.add(new T.Mesh(geometry)); stage.updateWorldMatrix(true, true);
    const transformed = new Float32Array(vertices.length), m = stage.matrixWorld.clone().invert().multiply(room.matrixWorld), point = new T.Vector3();
    for (let i = 0; i < vertices.length; i += 3) point.fromArray(vertices, i).applyMatrix4(m).toArray(transformed, i);
    ph.roomSurfaces(room, 'test');
    const record = ph.roomSolid, parts = record.colliders;
    assert.equal(parts.reduce((n, c) => n + c.shape.indices.length, 0), indices.length);
    assert.equal(JSON.stringify(parts.flatMap(c => expand(c.shape.vertices, c.shape.indices)).sort()), JSON.stringify(expand(transformed, indices)), 'Exact source triangle coordinates, multiplicity, winding, degenerate faces');
    const triangles = Array.from({ length: indices.length / 3 }, (_, f) => new T.Triangle(...[0, 1, 2].map(j => new T.Vector3().fromArray(transformed, indices[f * 3 + j] * 3))));
    const ball = new R.Ball(.00025), q = new T.Quaternion(), closest = new T.Vector3();
    const whole = new R.TriMesh(transformed, indices);
    for (let i = 0; i < triangles.length; i += 41) {
      const triangle = triangles[i]; if (triangle.getArea() < 1e-12) continue;
      for (const side of [-1, 1]) {
        const at = triangle.getMidpoint(new T.Vector3()).addScaledVector(triangle.getNormal(new T.Vector3()), side * .0004);
        let expected = Infinity;
        for (const source of triangles) expected = Math.min(expected, source.closestPointToPoint(at, closest).distanceTo(at));
        const contacts = parts.map(c => c.contactShape(ball, at, q, .002)).filter(Boolean);
        assert.ok(contacts.length, 'Every sampled room surface remains physical on both sides');
        const error = Math.abs(Math.min(...contacts.map(c => c.distance)) - (expected - ball.radius));
        report.maxError = Math.max(report.maxError, error); report.contacts++;
        const baseline = whole.contactShape({x:0,y:0,z:0}, q, ball, at, q, .002);
        assert.ok(baseline, 'The unchanged whole source surface also contacts this sample');
        const nativeDifference = Math.abs(Math.min(...contacts.map(c => c.distance)) - baseline.distance);
        report.maxNativeDifference = Math.max(report.maxNativeDifference, nativeDifference);
        assert.ok(nativeDifference < 1e-6, `Partition changed native contact by ${nativeDifference}`);
        if (error >= 1e-6) {
          // The first absolute-distance gate exposed a pinned-native error
          // identical in the old and new surfaces. Keep that failed evidence
          // and report the mathematical limit; do not label it ideal contact.
          report.analyticWithin1um = false; report.inheritedAnalyticMisses++;
          writeFileSync(resolve(out, 'contact-witness.json'), JSON.stringify({yaw, scale, face:i, side, at:at.toArray(), expected:expected-ball.radius, candidate:Math.min(...contacts.map(c=>c.distance)), baseline:baseline?.distance, error},null,2));
        }
      }
    }
    ph.roomSurfaces(room, 'test'); assert.equal(ph.roomSolid, record, 'Identical root/key reuses all parts');
    room.position.x += .04; ph.roomSurfaces(room, 'moved'); assert.ok(parts.every(c => !c.isValid()));
    const moved = ph.roomSolid.colliders; void ph.scene; assert.equal(ph.stale, false);
    ph.roomSurfaces(null, 'hidden'); assert.equal(ph.stale, true, 'Removal invalidates native query index'); assert.ok(moved.every(c => !c.isValid())); assert.equal(ph.world.colliders.len(), 0);
    ph.roomSurfaces(room, 'restored'); const restored = ph.roomSolid;
    const replacement = room.clone(true); stage.add(replacement); ph.roomSurfaces(replacement, 'restored');
    assert.notEqual(ph.roomSolid, restored, 'New geometry identity invalidates same-key cache'); assert.ok(restored.colliders.every(c => !c.isValid()));
    ph.roomSurfaces(null, 'removed'); assert.equal(ph.world.colliders.len(), 0);
    report.cases.push({ yaw, scale, parts: parts.length, triangles: indices.length / 3, lifecycle: true });
    ph.dispose(); ph = null;
  }
} catch (error) { report.errors.push(String(error.stack ?? error)); process.exitCode = 1; }
finally { ph?.dispose(); report.after = hashes(); report.sourceUnchanged = JSON.stringify(report.before) === JSON.stringify(report.after); report.pass = report.errors.length === 0 && report.cases.length === 3 && report.sourceUnchanged; writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
