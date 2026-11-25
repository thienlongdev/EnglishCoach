import * as T from 'three';
import type { GraspShape, HandContact, HumanRig } from './human';

/** Where a power grip puts a straight handle in the palm (the same numbers the study room's tools use). */
export const HANDLE_ALONG = .072;
export const HANDLE_OBLIQUE = .25;
const UP = new T.Vector3(0, 1, 0);
const q = new T.Quaternion();

/**
 * A hand closed round a straight handle, as a broom or an oar is held: the handle lies across the palm on the distal crease,
 * obliquely from the heel to the base of the index finger, at the depth this cast's own palm skin measures (`palmSeat`).
 * `axis` runs along the handle towards the thumb; `from` is where the forearm comes from (the shoulder). The fingers wrap from
 * that side. The wrist is set back from the handle by the palm, so the handle is in the hand, never through the wrist.
 * `into` is reused: one stable contact per hand keeps the finger fit from being redone every frame.
 */
export function handleGrip(rig: HumanRig, side: number, point: T.Vector3, axis: T.Vector3, from: T.Vector3, radius: number, into: HandContact): HandContact {
  const k = rig.scale;
  const fingers = into.fingers.copy(point).sub(from).normalize();
  fingers.addScaledVector(axis, -fingers.dot(axis));
  if (fingers.lengthSq() < 1e-6) fingers.set(0, -1, 0).addScaledVector(axis, -axis.y);
  fingers.normalize();
  const palm = into.palm.crossVectors(fingers, axis).multiplyScalar(-side).normalize();
  fingers.applyAxisAngle(palm, -HANDLE_OBLIQUE * side);
  const seat = rig.palmSeat(side, radius, HANDLE_ALONG, HANDLE_OBLIQUE) ?? radius + .024;
  into.wrist.copy(point).addScaledVector(palm, -seat * k).addScaledVector(fingers, -HANDLE_ALONG * k).addScaledVector(axis, -.006 * k);
  into.grip = 'handle';
  into.wrap = true;
  return into;
}

/** A straight handle the fingers can feel: a cylinder along `axis` through `centre` in the frame of `on`, read live. */
export function handleShape(on: T.Object3D, centre: T.Vector3, axis: T.Vector3, radius: number, half: number): () => GraspShape {
  const at = new T.Vector3(), along = new T.Vector3(), scale = new T.Vector3();
  return () => {
    on.updateWorldMatrix(true, false);
    at.copy(centre).applyMatrix4(on.matrixWorld);
    along.copy(axis).transformDirection(on.matrixWorld).normalize();
    const s = on.getWorldScale(scale).x;
    const toLocal = new T.Matrix4().makeRotationFromQuaternion(q.setFromUnitVectors(UP, along)).setPosition(at).invert();
    return { kind: 'cyl', toLocal, half: [radius * s, half * s, radius * s] };
  };
}
