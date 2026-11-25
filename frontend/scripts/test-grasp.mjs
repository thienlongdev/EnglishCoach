// Echo Life 5.0, what the hand feels: the real surface of a thing (three-mesh-bvh over its drawn triangles), the point and the normal a
// hand coming in meets, leaves that a hand never closes on, and the guards that keep big meshes and helper geometry out.
import assert from 'node:assert/strict';
import { tsLoader } from './lib/ts-load.mjs';

const THREE = await import('three');
const BVH = await import('three-mesh-bvh');
const load = tsLoader({ three: THREE, 'three-mesh-bvh': BVH });
const { meshShape, surfaceHit, surfaceNearest, surfaceOf, graspable, graspCacheSize } = load('lib/embodiment/grasp.ts');
const T = THREE;
const near = (a, b, e = 1e-3) => assert.ok(Math.abs(a - b) <= e, `${a} is not ${b}`);

// A mug-sized cylinder, turned and moved, inside a group scaled like a stage.
const stage = new T.Group(); stage.scale.setScalar(1);
const mug = new T.Group(); mug.position.set(1.2, .8, -2.3); mug.rotation.y = .7; stage.add(mug);
const body = new T.Mesh(new T.CylinderGeometry(.045, .045, .1, 32), new T.MeshStandardMaterial()); body.position.y = .05; mug.add(body);
const blob = new T.Mesh(new T.PlaneGeometry(.3, .3), new T.MeshBasicMaterial()); blob.userData.blob = true; blob.rotation.x = -Math.PI / 2; mug.add(blob);
stage.updateMatrixWorld(true);
const skip = o => !graspable(o);

// ── Distances are to the real triangles, in metres, wherever the thing stands ──
{
  const shape = meshShape(mug, 'test-mug', skip);
  assert.ok(shape && shape.kind === 'mesh', 'a mesh shape');
  const side = new T.Vector3(.045 + .02, .05, 0).applyMatrix4(mug.matrixWorld);
  near(shape.distance(side.clone().applyMatrix4(shape.toLocal)), .02, 1.5e-3);
  const onIt = new T.Vector3(.045, .05, 0).applyMatrix4(mug.matrixWorld);
  assert.ok(shape.distance(onIt.applyMatrix4(shape.toLocal)) < 1.5e-3, 'on the surface is touching');
  // Far away is reported as "not touching" quickly (the search stops a few centimetres out).
  const far = new T.Vector3(.5, .05, 0).applyMatrix4(mug.matrixWorld).applyMatrix4(shape.toLocal);
  assert.ok(shape.distance(far) >= .05, 'far is far');
  // The shadow blob under it is not something a finger meets.
  const underBlob = new T.Vector3(.12, .001, .0).applyMatrix4(mug.matrixWorld).applyMatrix4(shape.toLocal);
  assert.ok(shape.distance(underBlob) > .06 - 1e-6, 'the shadow blob is not felt');
  assert.equal(shape.inside(new T.Vector3(0, .05, 0)), true, 'its middle is inside');
  assert.equal(shape.inside(new T.Vector3(.2, .05, 0)), false, 'beside it is outside');
  assert.ok(shape.signedDistance(new T.Vector3(0, .05, 0)) < -.04, 'signed triangle distance is negative inside the vessel solid');
  near(shape.signedDistance(new T.Vector3(.065, .05, 0)), .02, .0015);
  assert.ok(shape.bounds && shape.bounds.max.y >= .099, 'contact search uses bounds in the object frame');
}

// ── A hand coming in meets the real side, and its normal faces the hand ──
{
  const from = new T.Vector3(1.2 + .5, .85, -2.3), dir = new T.Vector3(-1, 0, 0);
  const hit = surfaceHit(mug, 'test-mug', from, dir, 1, skip);
  assert.ok(hit, 'it is met');
  near(hit.point.distanceTo(new T.Vector3(1.2, .85, -2.3)), .045, 2e-3);
  assert.ok(hit.normal.dot(dir) < -.9, 'the normal faces the hand that comes: ' + hit.normal.toArray());
  assert.equal(surfaceHit(mug, 'test-mug', from, new T.Vector3(1, 0, 0), 1, skip), null, 'away from it, nothing');
  assert.equal(surfaceHit(mug, 'test-mug', from, dir, .3, skip), null, 'beyond what the hand reaches, nothing');
}

// ── Leaves are never closed on: a plant is taken by its pot ──
{
  const leaf = new T.Mesh(new T.PlaneGeometry(.1, .1), new T.MeshStandardMaterial()); leaf.material.name = 'leaf:#4f9a5e:';
  const pot = new T.Mesh(new T.BoxGeometry(.1, .1, .1), new T.MeshStandardMaterial()); pot.material.name = 'ceramic:#ffffff:';
  assert.equal(graspable(leaf), false); assert.equal(graspable(pot), true);
  const hidden = new T.Mesh(new T.BoxGeometry(.1, .1, .1)); hidden.userData.noCollision = true;
  assert.equal(graspable(hidden), false, 'an invisible helper is not felt');
  hidden.userData.pickable = true;
  assert.equal(graspable(hidden), true, 'unless it is the thing to pick');
}

// ── Furniture-sized meshes are not felt (the primitive is used), and each kind is built once ──
{
  const big = new T.Group(); big.add(new T.Mesh(new T.SphereGeometry(1, 256, 256))); big.updateMatrixWorld(true);
  assert.equal(surfaceOf(big, 'test-big'), null, 'too many triangles to feel');
  const before = graspCacheSize();
  meshShape(mug, 'test-mug', skip); meshShape(mug, 'test-mug', skip);
  assert.equal(graspCacheSize(), before, 'built once per kind');
}
console.log('grasp: real surfaces, normals towards the hand, no leaves, bounded and cached');

// A chair-like open frame: the side ray at shoulder level crosses empty space.
// The fallback must land on a real post/seat, retain world transforms and refuse
// a distant surface. A bounding-box face would be 17 cm from any drawn mesh.
{
  const frame = new T.Group(); frame.position.set(1.2, .1, -2); frame.rotation.y = .72; frame.scale.setScalar(1.3);
  const seat = new T.Mesh(new T.BoxGeometry(.5, .04, .5)); seat.position.y = .45; frame.add(seat);
  for (const x of [-.22, .22]) { const post = new T.Mesh(new T.BoxGeometry(.04, .5, .04)); post.position.set(x, .7, -.22); frame.add(post); }
  frame.updateMatrixWorld(true);
  const origin = new T.Vector3(.6, .72, 0).applyMatrix4(frame.matrixWorld);
  const direction = new T.Vector3(-1, 0, 0).transformDirection(frame.matrixWorld);
  assert.equal(surfaceHit(frame, 'open-frame', origin, direction, 1.5), null, 'approach ray passes through the open back');
  const hit = surfaceNearest(frame, 'open-frame', origin, .8);
  assert.ok(hit, 'a real nearby post is selected');
  const shape = meshShape(frame, 'open-frame');
  near(shape.distance(hit.point.clone().applyMatrix4(shape.toLocal)), 0, 1e-6);
  assert.ok(hit.normal.dot(origin.clone().sub(hit.point)) > 0, 'palm normal points out toward the hand');
  assert.equal(surfaceNearest(frame, 'open-frame', origin, .03), null, 'does not reach across an unbounded gap');
}
console.log('grasp: hollow-object pre-grasp selects a bounded real surface');
