import * as T from 'three';
import type { HandContact } from './human';
import { handRotation } from './poses';
import { reachableWrist } from './arms';

export interface GraspReach {
  local: T.Matrix4;
  shoulder: T.Vector3;
  upper: number;
  fore: number;
  pole: T.Vector3;
  limit: number;
}

interface ArmOffsetSlot {
  offset: T.Vector3;
  fingers: T.Vector3;
  delta: T.Vector3;
}

const _fgtOrigin = new T.Vector3();
const _fgtPosition = new T.Vector3();
const _fgtBest = new T.Vector3();
const _fgtStep = new T.Vector3();
const _fgtWrist = new T.Vector3();
const _fgtRadial = new T.Vector3();
const _fgtHandMat = new T.Matrix4();
const _fgtArmPool: ArmOffsetSlot[] = [];

const _gfHandMat = new T.Matrix4();
const _gfQuat = new T.Quaternion();
const _gfUnitScale = new T.Vector3(1, 1, 1);

function ensureArmSlot(index: number): ArmOffsetSlot {
  let slot = _fgtArmPool[index];
  if (!slot) {
    slot = {
      offset: new T.Vector3(),
      fingers: new T.Vector3(),
      delta: new T.Vector3(),
    };
    _fgtArmPool[index] = slot;
  }
  return slot;
}

/** Project ONE rigid object translation into the intersection of its holders'
 * reachable wrist regions. Neither local grasp nor object rotation is changed.
 * The margin reserves reach for motion between physics steps; it never changes
 * a bone length. Callers provide finalized shoulders. A non-convergent pair
 * is explicitly reported.
 */
export function fitGraspTranslation(
  wanted: T.Matrix4,
  arms: readonly GraspReach[],
  margin: number,
  floorY = -Infinity,
  foldedMargin = 0,
) {
  const armCount = arms.length;
  _fgtOrigin.setFromMatrixPosition(wanted);
  _fgtPosition.copy(_fgtOrigin);

  for (let i = 0; i < armCount; i++) {
    const a = arms[i];
    const slot = ensureArmSlot(i);
    _fgtHandMat.multiplyMatrices(wanted, a.local);
    slot.offset.setFromMatrixPosition(_fgtHandMat).sub(_fgtOrigin);
    slot.fingers.set(0, 1, 0).transformDirection(_fgtHandMat);
  }

  _fgtBest.copy(_fgtPosition);
  let residual = Infinity;
  let iterations = 0;

  for (; iterations < 64; iterations++) {
    if (_fgtPosition.y < floorY) _fgtPosition.y = floorY;

    let miss = 0;
    _fgtStep.set(0, 0, 0);

    for (let i = 0; i < armCount; i++) {
      const a = arms[i];
      const slot = _fgtArmPool[i];
      _fgtWrist.copy(_fgtPosition).add(slot.offset);
      _fgtRadial.copy(_fgtWrist).sub(a.shoulder);

      // The forearm can run out of room at either end of its travel. Leave
      // room for spring lag as the grip passes close to the shoulder, too.
      const folded = Math.abs(a.upper - a.fore) + .02;
      const extended = Math.max(folded, a.upper + a.fore - margin);
      const minimum = Math.min(extended, folded + foldedMargin);
      if (foldedMargin > 0 && _fgtRadial.lengthSq() < 1e-12) {
        _fgtRadial.copy(a.pole).sub(a.shoulder);
        if (_fgtRadial.lengthSq() < 1e-12) _fgtRadial.set(0, -1, 0);
        _fgtRadial.setLength(minimum);
      }
      _fgtRadial.clampLength(minimum, extended);
      const accepted = reachableWrist(
        a.shoulder,
        _fgtRadial.add(a.shoulder),
        slot.fingers,
        a.upper,
        a.fore,
        a.limit,
        a.pole,
      );
      slot.delta.copy(accepted).sub(_fgtWrist);
      const errLen = slot.delta.length();
      if (errLen > miss) miss = errLen;
      _fgtStep.add(slot.delta);
    }

    if (miss < residual) {
      residual = miss;
      _fgtBest.copy(_fgtPosition);
    }
    if (miss <= .0001) break;

    // Simultaneous corrections avoid giving either hand transform ownership.
    if (armCount > 1) _fgtStep.divideScalar(armCount);
    if (_fgtStep.lengthSq() < 1e-16) break;
    _fgtPosition.add(_fgtStep);
  }

  return {
    matrix: wanted.clone().setPosition(_fgtBest),
    residual,
    feasible: residual <= .0001,
    iterations,
  };
}

/** A rigid grasp is chosen once, in the object's own coordinates, independently of camera and world axes. */
export class GraspFrame {
  readonly local: T.Matrix4;
  private readonly inverse: T.Matrix4;
  private readonly template: HandContact;
  constructor(readonly object: T.Object3D, template: HandContact) {
    // Capture grasp properties before the action proxy is rebound. The
    // active controller supplies its own torso intention at the current pose.
    this.template = { ...template, bodyGoal: undefined, bodyFingers: undefined };
    object.updateWorldMatrix(true, false);
    _gfHandMat.compose(template.wrist, handRotation(template.fingers, template.palm, _gfQuat), _gfUnitScale);
    this.local = object.matrixWorld.clone().invert().multiply(_gfHandMat);
    this.inverse = this.local.clone().invert();
  }
  /** A grip changed where everyone can see it (the hand sliding and turning on the handle), one step at a time:
   * the new object-local hand pose. The object itself is not moved by this. */
  setLocal(local: T.Matrix4) { this.local.copy(local); this.inverse.copy(local).invert(); }
  /** After physics interpolation, the arm solves the very same grasp on the current object pose. */
  contact(): HandContact {
    this.object.updateWorldMatrix(true, false);
    _gfHandMat.multiplyMatrices(this.object.matrixWorld, this.local);
    return {
      ...this.template,
      wrist: new T.Vector3().setFromMatrixPosition(_gfHandMat),
      fingers: new T.Vector3(0, 1, 0).transformDirection(_gfHandMat),
      palm: new T.Vector3(0, 0, 1).transformDirection(_gfHandMat),
      on: this.object,
      onAt: this.object.getWorldPosition(new T.Vector3()),
      secured: true,
    };
  }
  /** The hand's desired pose defines the object's desired pose. Rapier, rather than this matrix, accepts the motion. */
  objectPose(wrist: T.Vector3, fingers: T.Vector3, palm: T.Vector3) {
    return new T.Matrix4().compose(wrist, handRotation(fingers, palm, _gfQuat), _gfUnitScale).multiply(this.inverse);
  }
}
