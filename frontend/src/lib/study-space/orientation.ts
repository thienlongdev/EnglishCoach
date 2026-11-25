import * as T from 'three';
import type { ObjectState, SpaceObject } from './types';

/**
 * Pure 3D orientation, uprightness validation, and wrap-free 360-degree rotation math
 * shared across StudySpace manipulation, Rapier physics settlement, seat validation,
 * placement preview, and the Room Inspector.
 *
 * Uses module-private scratch objects so hot-loop callers allocate zero temporary
 * vectors/quaternions when supplying an `out` target.
 */

export type RotationAxis3D = 'x' | 'y' | 'z';
export type TransformSpace = 'local' | 'world';
export type QuatTuple = [number, number, number, number];

export interface QuatLike {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export type QuatInput = QuatLike | Readonly<QuatTuple>;

/** Maximum tilt from world +Y (12 degrees) at which a chair/bed remains safely usable as a seat. */
export const SEAT_UPRIGHT_MAX_TILT_DEG = 12;
export const SEAT_UPRIGHT_MIN_UP_Y = Math.cos((SEAT_UPRIGHT_MAX_TILT_DEG * Math.PI) / 180);

/** Physics settle threshold (~7.25 degrees) within which dynamic bodies snap cleanly to +Y. */
export const SETTLE_UPRIGHT_MIN_UP_Y = 0.992;

/** Exact upright threshold (~2.56 degrees) at which `SpaceObject.quat` is cleared to `undefined`. */
export const EXACT_UPRIGHT_MIN_UP_Y = 0.999;

const DEG_PER_RAD = 180 / Math.PI;
const RAD_PER_DEG = Math.PI / 180;
const WORLD_UP = new T.Vector3(0, 1, 0);

const _qA = new T.Quaternion();
const _qDelta = new T.Quaternion();
const _vFwd = new T.Vector3();
const _vRight = new T.Vector3();
const _vAxis = new T.Vector3();
const _euler = new T.Euler(0, 0, 0, 'YXZ');

function readUnitQuat(q: QuatInput, out: T.Quaternion): T.Quaternion {
  if (Array.isArray(q)) {
    out.set(q[0], q[1], q[2], q[3]);
  } else {
    const ql = q as QuatLike;
    out.set(ql.x, ql.y, ql.z, ql.w);
  }
  const lenSq = out.x * out.x + out.y * out.y + out.z * out.z + out.w * out.w;
  if (!Number.isFinite(lenSq) || lenSq < 1e-12) {
    return out.set(0, 0, 0, 1);
  }
  if (Math.abs(lenSq - 1) > 1e-7) {
    const inv = 1 / Math.sqrt(lenSq);
    out.set(out.x * inv, out.y * inv, out.z * inv, out.w * inv);
  }
  return out;
}

function canonicalizeHemisphere(q: T.Quaternion): T.Quaternion {
  if (q.w < 0 || (q.w === 0 && (q.z < 0 || (q.z === 0 && (q.y < 0 || (q.y === 0 && q.x < 0)))))) {
    q.set(-q.x, -q.y, -q.z, -q.w);
  }
  return q;
}

function round6(n: number): number {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

export function wrapRadiansPi(rad: number): number {
  if (!Number.isFinite(rad)) return 0;
  const w = Math.atan2(Math.sin(rad), Math.cos(rad));
  return Object.is(w, -0) ? 0 : w;
}

export function normalizeDegrees360(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const wrapped = ((deg % 360) + 360) % 360;
  if (wrapped < 1e-4 || wrapped > 360 - 1e-4) return 0;
  return Math.round(wrapped * 100) / 100;
}

/**
 * Returns the world Y component in [-1, 1] of the object's local +Y up axis `(0, 1, 0)`
 * under quaternion `q`. `1` means perfectly upright; `0` means lying 90 degrees on its side;
 * `-1` means completely upside-down.
 */
export function worldUpYFromQuat(q: QuatInput): number {
  readUnitQuat(q, _qA);
  const upY = 1 - 2 * (_qA.x * _qA.x + _qA.z * _qA.z);
  return T.MathUtils.clamp(upY, -1, 1);
}

/** Tilt angle in degrees `[0..180]` between local +Y and world +Y. */
export function tiltDegreesFromQuat(q: QuatInput): number {
  return Math.acos(worldUpYFromQuat(q)) * DEG_PER_RAD;
}

/** Reconstructs the stage-space quaternion of a `SpaceObject` matching `StudyWorld.sync`. */
export function quatFromSpaceObject(
  obj: Pick<SpaceObject, 'rotY' | 'quat' | 'state'>,
  out: T.Quaternion = new T.Quaternion(),
): T.Quaternion {
  if (obj.quat) {
    return canonicalizeHemisphere(readUnitQuat(obj.quat, out));
  }
  _euler.set(0, obj.rotY || 0, obj.state?.tilt ?? 0, 'XYZ');
  return canonicalizeHemisphere(out.setFromEuler(_euler).normalize());
}

/**
 * Applies a `SpaceObject`'s exact layout transform (`pos`, `rotY`, `quat`, `state.tilt`)
 * to target position and quaternion objects with zero heap allocations.
 */
export function applySpaceObjectTransform(
  obj: Pick<SpaceObject, 'pos' | 'rotY' | 'quat' | 'state'>,
  outPos: T.Vector3,
  outQuat: T.Quaternion,
): void {
  outPos.set(obj.pos[0], obj.pos[1], obj.pos[2]);
  quatFromSpaceObject(obj, outQuat);
}

/**
 * Checks whether a `SpaceObject`'s layout transform (`pos`, `rotY`, `quat`) still matches
 * a recorded snapshot within sub-tenth-millimetre / sub-milliradian tolerance (`0` allocations).
 */
export function sameSpaceObjectTransform(
  obj: Pick<SpaceObject, 'pos' | 'rotY' | 'quat'>,
  pos: readonly [number, number, number],
  rotY: number,
  quat: Readonly<QuatTuple> | undefined,
): boolean {
  if (
    Math.abs(obj.pos[0] - pos[0]) > 1e-4 ||
    Math.abs(obj.pos[1] - pos[1]) > 1e-4 ||
    Math.abs(obj.pos[2] - pos[2]) > 1e-4
  ) {
    return false;
  }
  const hasA = Boolean(obj.quat);
  const hasB = Boolean(quat);
  if (hasA !== hasB) return false;
  if (obj.quat && quat) {
    const dot =
      obj.quat[0] * quat[0] +
      obj.quat[1] * quat[1] +
      obj.quat[2] * quat[2] +
      obj.quat[3] * quat[3];
    return Math.abs(dot) >= 1 - 1e-6;
  }
  return Math.abs(wrapRadiansPi((obj.rotY || 0) - (rotY || 0))) <= 1e-4;
}

/**
 *Canonical uprightness check shared with Seat Validation (A2) and Manipulation (A3).
 * Inspects live `group.quaternion` when provided, otherwise evaluates `obj.quat` / `obj.state.tilt`.
 */
export function isSpaceObjectUpright(
  obj: Pick<SpaceObject, 'quat' | 'state'>,
  group?: { readonly quaternion: QuatLike } | null,
  minUpY: number = SEAT_UPRIGHT_MIN_UP_Y,
): boolean {
  if (group) {
    return worldUpYFromQuat(group.quaternion) >= minUpY;
  }
  if (obj.quat) {
    return worldUpYFromQuat(obj.quat) >= minUpY;
  }
  return Math.cos(obj.state?.tilt ?? 0) >= minUpY;
}

/**
 * Singularity-free horizontal yaw extraction (`(-pi, pi]`) that preserves an object's
 * room facing even when pitched +/-90 degrees nose-down/on-backrest or rolled sideways.
 *
 * Uses Y-axis swing-twist decomposition (`q = q_swing_xz * RotY(yaw)`) across the upper
 * and side hemispheres, with an exact horizontal basis fallback at the antipodal `180 deg`
 * upside-down pole (`q.y^2 + q.w^2 -> 0`).
 */
export function extractPreservedYaw(q: QuatInput): number {
  readUnitQuat(q, _qA);
  const twistSq = _qA.y * _qA.y + _qA.w * _qA.w;
  if (twistSq > 1e-6) {
    return wrapRadiansPi(2 * Math.atan2(_qA.y, _qA.w));
  }
  // Antipodal 180-degree inversion (`up.y ≈ -1`): both local +Z and local +X lie in world XZ.
  _vFwd.set(0, 0, 1).applyQuaternion(_qA);
  const fwdSq = _vFwd.x * _vFwd.x + _vFwd.z * _vFwd.z;
  if (fwdSq > 1e-6) {
    return wrapRadiansPi(Math.atan2(_vFwd.x, _vFwd.z));
  }
  _vRight.set(1, 0, 0).applyQuaternion(_qA);
  const rightSq = _vRight.x * _vRight.x + _vRight.z * _vRight.z;
  if (rightSq > 1e-6) {
    return wrapRadiansPi(Math.atan2(-_vRight.z, _vRight.x));
  }
  return 0;
}

/**
 * Computes the exact upright quaternion (`up.y === 1.0`) preserving horizontal yaw
 * from any fallen, tilted, or upside-down 3D orientation.
 */
export function uprightQuatFrom(q: QuatInput, out: T.Quaternion = new T.Quaternion()): T.Quaternion {
  const yaw = extractPreservedYaw(q);
  return canonicalizeHemisphere(out.setFromAxisAngle(WORLD_UP, yaw));
}

/** Cycles the active 3D rotation axis in intuitive order: Yaw (`y`) -> Pitch (`x`) -> Roll (`z`). */
export function nextRotationAxis3D(axis: RotationAxis3D): RotationAxis3D {
  if (axis === 'y') return 'x';
  if (axis === 'x') return 'z';
  return 'y';
}

/**
 * Applies a wrap-free 3D rotation delta (supporting arbitrary continuous 360-degree turns)
 * around `axis` (`'x' | 'y' | 'z'`) in `'local'` or `'world'` space.
 */
export function applyAxisRotation3D(
  currentQuat: QuatInput,
  axis: RotationAxis3D,
  deltaRad: number,
  space: TransformSpace = 'local',
  out: T.Quaternion = new T.Quaternion(),
): T.Quaternion {
  readUnitQuat(currentQuat, out);
  if (!Number.isFinite(deltaRad) || Math.abs(deltaRad) < 1e-12) {
    return canonicalizeHemisphere(out);
  }
  if (axis === 'x') _vAxis.set(1, 0, 0);
  else if (axis === 'y') _vAxis.set(0, 1, 0);
  else _vAxis.set(0, 0, 1);

  _qDelta.setFromAxisAngle(_vAxis, deltaRad);
  if (space === 'world') {
    out.premultiply(_qDelta);
  } else {
    out.multiply(_qDelta);
  }
  return canonicalizeHemisphere(out.normalize());
}

/**
 * Converts a quaternion to `[0..360)` degrees in `'YXZ'` (Yaw-Pitch-Roll) room order
 * so upright objects always display `x = 0, z = 0` and exact `y = rotY` across `[0..360)`.
 */
export function eulerDegreesFromQuat(q: QuatInput): { x: number; y: number; z: number } {
  readUnitQuat(q, _qA);
  if (worldUpYFromQuat(_qA) >= EXACT_UPRIGHT_MIN_UP_Y) {
    const yaw = extractPreservedYaw(_qA);
    return {
      x: 0,
      y: normalizeDegrees360(yaw * DEG_PER_RAD),
      z: 0,
    };
  }
  _euler.setFromQuaternion(_qA, 'YXZ');
  return {
    x: normalizeDegrees360(_euler.x * DEG_PER_RAD),
    y: normalizeDegrees360(_euler.y * DEG_PER_RAD),
    z: normalizeDegrees360(_euler.z * DEG_PER_RAD),
  };
}

/** Reconstructs a normalized unit quaternion from `[0..360)` `'YXZ'` degree angles. */
export function quatFromEulerDegrees(
  rxDeg: number,
  ryDeg: number,
  rzDeg: number,
  out: T.Quaternion = new T.Quaternion(),
): T.Quaternion {
  const rx = (Number.isFinite(rxDeg) ? rxDeg : 0) * RAD_PER_DEG;
  const ry = (Number.isFinite(ryDeg) ? ryDeg : 0) * RAD_PER_DEG;
  const rz = (Number.isFinite(rzDeg) ? rzDeg : 0) * RAD_PER_DEG;
  _euler.set(rx, ry, rz, 'YXZ');
  return canonicalizeHemisphere(out.setFromEuler(_euler).normalize());
}

/**
 * Normalizes a 3D quaternion for persistence on `SpaceObject` (`Layout` and `WorldSaver`).
 * Clears `quat` to `undefined` whenever the orientation is upright (`up.y >= EXACT_UPRIGHT_MIN_UP_Y`)
 * so uprighted chairs/furniture never retain stale fallen quaternions.
 */
export function normalizeSpaceObjectOrientation(q: QuatInput): {
  rotY: number;
  quat: QuatTuple | undefined;
} {
  readUnitQuat(q, _qA);
  canonicalizeHemisphere(_qA);
  const yaw = round6(extractPreservedYaw(_qA));
  if (worldUpYFromQuat(_qA) >= EXACT_UPRIGHT_MIN_UP_Y) {
    return { rotY: yaw, quat: undefined };
  }
  return {
    rotY: yaw,
    quat: [round6(_qA.x), round6(_qA.y), round6(_qA.z), round6(_qA.w)],
  };
}

/**
 * Builds a complete `Partial<SpaceObject>` patch that resets an object upright while
 * preserving its horizontal yaw and clearing both `obj.quat` and any legacy `obj.state.tilt`.
 */
export function resetSpaceObjectUprightPatch(
  obj: Pick<SpaceObject, 'rotY' | 'quat' | 'state'>,
  overrideQuat?: QuatInput,
): { rotY: number; quat: undefined; state?: ObjectState } {
  const source = overrideQuat ?? quatFromSpaceObject(obj, _qA);
  const yaw = round6(extractPreservedYaw(source));
  if (obj.state?.tilt) {
    const nextState: ObjectState = { ...obj.state, tilt: undefined };
    return { rotY: yaw, quat: undefined, state: nextState };
  }
  return { rotY: yaw, quat: undefined };
}
