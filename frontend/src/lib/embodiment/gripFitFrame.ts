import * as T from 'three';
import type { GraspShape } from './human';

/** Geometry expressed in the hand frame. Common world movement cannot expire a
 * fit; changing the wrist orientation can, even if its origin never moves.
 * A cylinder's spin about its own axis is a coordinate gauge, not new contact. */
export function gripFitFrame(handWorld: T.Matrix4, shape: GraspShape): number[] {
  const local = handWorld.clone().invert().multiply(shape.toLocal.clone().invert());
  const p = new T.Vector3().setFromMatrixPosition(local);
  const axes = shape.kind === 'cyl'
    ? new T.Vector3(0, 1, 0).transformDirection(local).toArray()
    : [0, 1, 2].flatMap(i => new T.Vector3().setFromMatrixColumn(local, i).toArray());
  return [...p.toArray(), ...axes, ...shape.half];
}

export function gripFitChanged(before: readonly number[] | null | undefined, after: readonly number[]) {
  if (!before || before.length !== after.length) return true;
  return after.some((v, i) => Math.abs(v - before[i]) > (i < 3 || i >= after.length - 3 ? .0005 : .005));
}
