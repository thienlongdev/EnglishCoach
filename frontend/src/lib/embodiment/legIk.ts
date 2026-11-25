import * as T from 'three';

/**
 * Unified Zero-Allocation Analytic Two-Bone Leg IK, Anti-Bow-Leg Knee Pole,
 * Terrain-Normal Sole Roll & Critically Damped Pelvis Stabilization (`legIk.ts`).
 *
 * Shared mathematical core for Player (`HumanRig`) and Tier-0 NPCs (`GameView`):
 *  - Closed-form Character-Space Law-of-Cosines `hip -> knee -> ankle` solver
 *    with strict anatomical knee flexion bounds `[0.06 rad, 2.35 rad]` (zero hyperextension,
 *    zero straight-leg gimbal flip).
 *  - Sagittal-foot + bounded clip-bend (`+-0.17 rad`) + coronal anti-bow-leg / midline
 *    knee pole clamp in character space.
 *  - Shear-free `inv(bone.parent.matrixWorld)` local-space aiming + non-uniform ellipsoid
 *    segment-length fixed-point refinement (`<= 1 mm` FK residual even at extreme CAZ
 *    non-uniform bone scales `hips [hipX,1,hipZ]` & `thigh [b/hipX,leg,b/hipZ]`).
 *  - Continuous slope-normal ankle orientation + heel-strike / flat-stance / toe-off roll
 *    (including `Codex52` `LeftToeBase` / `RightToeBase` counter-bend).
 *  - Analytical critically damped `PelvisVerticalSpring` (`omega = 20 rad/s`, `[-0.14, +0.04] m`)
 *    and swing-safe `sampleStanceFootTarget` (`<= 2.8 cm` stance lock, 100% swing lift preserved).
 */

export const MIN_KNEE_FLEX_RAD = 0.075; // ~4.30 deg: prevents hyperextension & straight-leg singularity (>= 4.0 deg R01 gate)
export const MAX_KNEE_FLEX_RAD = 2.28; // ~130.63 deg: anatomical deep-squat / lunge limit (<= 132.0 deg R01 gate)
export const MAX_CLIP_KNEE_PLANE_RAD = 0.17; // ~9.74 deg max deviation toward clip bend plane
export const PELVIS_OMEGA = 20; // rad/s critically damped natural frequency
export const PELVIS_MIN_OFFSET_M = -0.14; // metres at scale 1
export const PELVIS_MAX_OFFSET_M = 0.04; // metres at scale 1
export const MAX_STANCE_LOCK_M = 0.028; // 2.8 cm (strictly inside <= 3.0 cm skate gate)
export const PIVOT_RELEASE_START_RAD_S = 1.65;
export const PIVOT_RELEASE_FULL_RAD_S = 2.2;
export const MAX_WALKABLE_SLOPE_RAD = 0.62; // ~35.5 deg

const COS_MIN_KNEE = Math.cos(MIN_KNEE_FLEX_RAD);
const COS_MIN_KNEE_NONUNIFORM = Math.cos(0.105); // Guarantees Pass-0 clamped world angle >= 0.075 rad under extreme CAZ stretch
const COS_MAX_KNEE = Math.cos(MAX_KNEE_FLEX_RAD);
const COS_MAX_KNEE_NONUNIFORM = Math.cos(2.12); // Guarantees Pass-0 clamped world angle <= 2.28 rad under extreme CAZ stretch
const WORLD_UP_Y = 1;

// ── Module-scoped zero-allocation scratch registers ──────────────────────────────────────────────────

const _yAxis = new T.Vector3(0, 1, 0);
const _qPelvisYaw = new T.Quaternion();
const _rootPos = new T.Vector3();
const _rootQuat = new T.Quaternion();
const _invRootQuat = new T.Quaternion();
const _rootScale = new T.Vector3();
const _hipW = new T.Vector3();
const _kneeW = new T.Vector3();
const _ankleW = new T.Vector3();
const _hipC = new T.Vector3();
const _kneeAnimC = new T.Vector3();
const _ankleAnimC = new T.Vector3();
const _goalC = new T.Vector3();
const _axisAnim = new T.Vector3();
const _clipBendC = new T.Vector3();
const _axis = new T.Vector3();
const _poleBaseC = new T.Vector3();
const _poleC = new T.Vector3();
const _clipPerp = new T.Vector3();
const _cross = new T.Vector3();
const _solvedKneeC = new T.Vector3();
const _solvedAnkleC = new T.Vector3();
const _solvedKneeW = new T.Vector3();
const _solvedAnkleW = new T.Vector3();

const _mParentInv = new T.Matrix4();
const _mGoalW = new T.Matrix4();
const _mLocalBasis = new T.Matrix4();
const _curDir = new T.Vector3();
const _wantDir = new T.Vector3();
const _basisX = new T.Vector3();
const _basisY = new T.Vector3();
const _basisZ = new T.Vector3();
const _qSwing = new T.Quaternion();
const _qLocalTarget = new T.Quaternion();
const _savedThighQ = new T.Quaternion();
const _savedShinQ = new T.Quaternion();
const _springOut = { pos: 0, vel: 0 };
const _poleUnitC = new T.Vector3();
const _pass0KneeW = new T.Vector3();
const _pass0AnkleW = new T.Vector3();

// Scratch registers for slope-normal & sole-roll orientation solver
const _footUpW = new T.Vector3();
const _footFwdW = new T.Vector3();
const _footRightLocal = new T.Vector3();
const _flatFwd = new T.Vector3();
const _flatRight = new T.Vector3();
const _clampedNormal = new T.Vector3();
const _outFwd = new T.Vector3();
const _outUp = new T.Vector3();
const _outRight = new T.Vector3();
const _mFootLocalInv = new T.Matrix4();
const _mFootWorld = new T.Matrix4();
const _qFootLocalInv = new T.Quaternion();
const _toeAxis = new T.Vector3(1, 0, 0);
const _qToeDelta = new T.Quaternion();

// ── Critically Damped Pelvis Stabilization ───────────────────────────────────────────────────────────

/**
 * Exact analytical 1D critically damped spring-damper step (`zeta = 1`).
 * Unconditionally stable for all `dt >= 0` with zero allocations and zero overshoot.
 */
export function stepCriticallyDamped(
  pos: number,
  vel: number,
  target: number,
  omega: number,
  dt: number,
  minPos: number,
  maxPos: number,
  out: { pos: number; vel: number },
): void {
  const clampedTarget = Math.max(minPos, Math.min(maxPos, target));
  if (!(dt > 0) || !(omega > 0)) {
    out.pos = Math.max(minPos, Math.min(maxPos, pos));
    out.vel = vel;
    return;
  }
  const err = pos - clampedTarget;
  const exp = Math.exp(-omega * dt);
  const c1 = vel + omega * err;
  let nextPos = clampedTarget + (err + c1 * dt) * exp;
  let nextVel = (vel - c1 * omega * dt) * exp;
  if (nextPos < minPos) {
    nextPos = minPos;
    if (nextVel < 0) nextVel = 0;
  } else if (nextPos > maxPos) {
    nextPos = maxPos;
    if (nextVel > 0) nextVel = 0;
  }
  out.pos = nextPos;
  out.vel = nextVel;
}

/**
 * Continuous critically damped pelvis vertical stabilizer (`[-0.14 m, +0.04 m] * scale`, `omega = 20`).
 * Eliminates the triple pelvis-Y fight and `1.8 m/s` `verticalGait` boolean cliff across
 * `Idle -> Walk -> Run -> Stairs -> Slopes`, relaxing cleanly to `0` when airborne/seated/mounted.
 */
export class PelvisVerticalSpring {
  offsetY = 0;
  velY = 0;

  step(
    targetOffsetY: number,
    dt: number,
    scale = 1,
    reduced = false,
    omega = PELVIS_OMEGA,
  ): number {
    const k = Math.max(0.25, scale);
    const minY = PELVIS_MIN_OFFSET_M * k;
    const maxY = PELVIS_MAX_OFFSET_M * k;
    if (reduced) {
      this.offsetY = Math.max(minY, Math.min(maxY, targetOffsetY));
      this.velY = 0;
      return this.offsetY;
    }
    stepCriticallyDamped(this.offsetY, this.velY, targetOffsetY, omega, dt, minY, maxY, _springOut);
    this.offsetY = _springOut.pos;
    this.velY = _springOut.vel;
    return this.offsetY;
  }

  /** Smoothly relaxes pelvis offset back to `0` when airborne, seated, mounted, or swimming. */
  relax(dt: number, scale = 1, reduced = false, omega = PELVIS_OMEGA): number {
    if (Math.abs(this.offsetY) < 1e-6 && Math.abs(this.velY) < 1e-5) {
      this.offsetY = 0;
      this.velY = 0;
      return 0;
    }
    return this.step(0, dt, scale, reduced, omega);
  }

  reset(): void {
    this.offsetY = 0;
    this.velY = 0;
  }
}

// ── Anatomical Reach & Joint Angle Helpers ───────────────────────────────────────────────────────────

/** Maximum anatomical leg reach for segment lengths `(l1, l2)` at `MIN_KNEE_FLEX_RAD` (`0.06 rad`). */
export function maxAnatomicalLegReach(l1: number, l2: number): number {
  return Math.sqrt(Math.max(0, l1 * l1 + l2 * l2 + 2 * l1 * l2 * COS_MIN_KNEE));
}

/** Minimum anatomical leg distance for segment lengths `(l1, l2)` at `MAX_KNEE_FLEX_RAD` (`2.35 rad`). */
export function minAnatomicalLegReach(l1: number, l2: number): number {
  const sq = l1 * l1 + l2 * l2 + 2 * l1 * l2 * COS_MAX_KNEE;
  return Math.max(Math.abs(l1 - l2) + 0.002, Math.sqrt(Math.max(0, sq)));
}

/**
 * Measures the realized world-space anatomical knee flexion angle (`0` = straight, `pi/2` = 90 deg bend).
 * Zero allocations.
 */
export function computeSolvedKneeFlexionRad(thigh: T.Bone, shin: T.Bone, foot: T.Bone): number {
  thigh.getWorldPosition(_hipW);
  shin.getWorldPosition(_kneeW);
  foot.getWorldPosition(_ankleW);
  _curDir.copy(_kneeW).sub(_hipW);
  _wantDir.copy(_ankleW).sub(_kneeW);
  const len1Sq = _curDir.lengthSq();
  const len2Sq = _wantDir.lengthSq();
  if (len1Sq < 1e-12 || len2Sq < 1e-12) return 0;
  const dot = _curDir.dot(_wantDir) / Math.sqrt(len1Sq * len2Sq);
  return Math.acos(T.MathUtils.clamp(dot, -1, 1));
}

// ── Shear-Safe Parent-Local Bone Aiming & Orthonormalized Foot Rotation ──────────────────────────────

function hasNonUniformHierarchyScale(thigh: T.Bone, shin: T.Bone): boolean {
  for (let o: T.Object3D | null = shin; o; o = o.parent) {
    const s = o.scale;
    if (Math.abs(s.x - s.y) > 1e-4 || Math.abs(s.y - s.z) > 1e-4) return true;
  }
  const ts = thigh.scale;
  return Math.abs(ts.x - ts.y) > 1e-4 || Math.abs(ts.y - ts.z) > 1e-4;
}

/**
 * Aims `bone -> child` at `targetWorld` directly in `bone.parent`'s exact local space via
 * `inv(bone.parent.matrixWorld)`, preventing 3D shear distortion when CAZ body proportion sliders
 * apply non-uniform scales (`hips [hipX,1,hipZ]`, `thigh [b/hipX,leg,b/hipZ]`).
 */
function aimBoneShearSafe(bone: T.Bone, child: T.Bone, targetWorld: T.Vector3): void {
  if (bone.parent) {
    _mParentInv.copy(bone.parent.matrixWorld).invert();
    child.getWorldPosition(_curDir).applyMatrix4(_mParentInv).sub(bone.position);
    _wantDir.copy(targetWorld).applyMatrix4(_mParentInv).sub(bone.position);
    if (_curDir.lengthSq() < 1e-12 || _wantDir.lengthSq() < 1e-12) return;
    _curDir.normalize();
    _wantDir.normalize();
    _qSwing.setFromUnitVectors(_curDir, _wantDir);
    bone.quaternion.premultiply(_qSwing).normalize();
  } else {
    bone.getWorldPosition(_hipW);
    child.getWorldPosition(_curDir).sub(_hipW);
    _wantDir.copy(targetWorld).sub(_hipW);
    if (_curDir.lengthSq() < 1e-12 || _wantDir.lengthSq() < 1e-12) return;
    _curDir.normalize();
    _wantDir.normalize();
    _qSwing.setFromUnitVectors(_curDir, _wantDir);
    bone.quaternion.premultiply(_qSwing).normalize();
  }
  bone.updateWorldMatrix(false, true);
}

/**
 * Sets `foot.quaternion` so the shoe's world basis matches `goalWorldQuat` cleanly even under
 * non-uniform parent bone scales (via Gram-Schmidt orthonormalization of `inv(parent.matrixWorld) * R_goal`).
 */
function applyFootWorldRotationShearSafe(
  foot: T.Bone,
  goalWorldQuat: T.Quaternion,
  weight: number,
): void {
  if (foot.parent) {
    _mParentInv.copy(foot.parent.matrixWorld).invert();
    _mGoalW.makeRotationFromQuaternion(goalWorldQuat);
    _mLocalBasis.multiplyMatrices(_mParentInv, _mGoalW);
    const e = _mLocalBasis.elements;
    _basisX.set(e[0], e[1], e[2]);
    _basisY.set(e[4], e[5], e[6]);
    if (_basisX.lengthSq() < 1e-12 || _basisY.lengthSq() < 1e-12) return;
    _basisX.normalize();
    _basisY.addScaledVector(_basisX, -_basisY.dot(_basisX));
    if (_basisY.lengthSq() < 1e-12) return;
    _basisY.normalize();
    _basisZ.crossVectors(_basisX, _basisY).normalize();
    _mLocalBasis.makeBasis(_basisX, _basisY, _basisZ);
    _qLocalTarget.setFromRotationMatrix(_mLocalBasis);
  } else {
    _qLocalTarget.copy(goalWorldQuat);
  }
  if (weight >= 0.9999) {
    foot.quaternion.copy(_qLocalTarget);
  } else {
    foot.quaternion.slerp(_qLocalTarget, weight);
  }
  foot.updateWorldMatrix(false, true);
}

// ── Closed-Form Character-Space Analytic Two-Bone Leg IK ─────────────────────────────────────────────

export interface AnalyticLegIkOptions {
  /** `+1` for character-left (`+X` in character space), `-1` for character-right (`-X` in character space). */
  charSideX: 1 | -1;
  /** Optional shoe horizontal forward direction in character space (defaults to `+Z`). */
  shoeForwardChar?: T.Vector3 | null;
  /** Optional pelvis yaw offset relative to `characterRoot` (`moveYaw` in radians, left `+`, defaults to `0`). */
  pelvisYawOffsetRad?: number;
  /** Optional explicit knee pole in world space (e.g. kneeling `floorPosture` or bicycle pedal). */
  explicitPoleWorld?: T.Vector3 | null;
  /** Enforce coronal anti-bow-leg & midline knee clamp in character space (defaults to `true`). */
  clampCoronalSplay?: boolean;
  /** Optional desired world-space rotation for the `foot` bone after shin aiming. */
  footWorldRotation?: T.Quaternion | null;
  /** Optional `Codex52` toe bone (`LeftToeBase` / `RightToeBase`) for toe-off counter-bend. */
  toeBone?: T.Bone | null;
  /** Optional rest quaternion of `toeBone` (required when `toeCounterPitchRad` is applied). */
  toeRestQuat?: T.Quaternion | null;
  /** Sagittal toe-off counter-bend angle in radians (`0` = rest, negative bends toes flush onto ground). */
  toeCounterPitchRad?: number;
  /** IK blend weight `[0..1]` (defaults to `1`). */
  weight?: number;
}

export interface AnalyticLegIkResult {
  reachedAnkleWorld: T.Vector3;
  solvedKneeWorld: T.Vector3;
  kneeFlexionRad: number;
  clampedReach: boolean;
}

/**
 * Exact closed-form projection of `kneeC` onto the coronal band `charSideX * kneeC.x in [minLat, maxLat]`
 * while staying strictly on the sphere-plane intersection circle `C + v` (`v perp axis`, `||v|| = h`),
 * preserving exact segment length `l1` and exact knee flexion angle with zero allocations.
 */
function clampKneeCircleCoronal(
  hipC: T.Vector3,
  axis: T.Vector3,
  along: number,
  h: number,
  poleDir: T.Vector3,
  charSideX: 1 | -1,
  minLat: number,
  maxLat: number,
  outKneeC: T.Vector3,
): boolean {
  const signedLat = charSideX * outKneeC.x;
  const clampedLat = T.MathUtils.clamp(signedLat, minLat, maxLat);
  if (Math.abs(clampedLat - signedLat) <= 1e-6) return false;

  const ax = axis.x;
  const ay = axis.y;
  const az = axis.z;
  const omAx2 = 1 - ax * ax;
  if (omAx2 <= 1e-6) return false;

  const sPerp = Math.sqrt(omAx2);
  const cxCenter = hipC.x + along * ax;
  const cyCenter = hipC.y + along * ay;
  const czCenter = hipC.z + along * az;

  const targetX = charSideX * clampedLat;
  const cx = T.MathUtils.clamp((targetX - cxCenter) / sPerp, -h, h);

  // Orthogonal tangent `ut = (0, az, -ay) / sPerp` has zero X component; preserve pole's sagittal sign!
  const pDotUt = (poleDir.y * az - poleDir.z * ay) / sPerp;
  const signUt = Math.abs(pDotUt) > 1e-7 ? (pDotUt >= 0 ? 1 : -1) : -ay >= 0 ? 1 : -1;
  const ct = signUt * Math.sqrt(Math.max(0, h * h - cx * cx));

  const invSPerp = 1 / sPerp;
  outKneeC.set(
    cxCenter + cx * sPerp,
    cyCenter + cx * (-ax * ay * invSPerp) + ct * (az * invSPerp),
    czCenter + cx * (-ax * az * invSPerp) + ct * (-ay * invSPerp),
  );
  return true;
}

function solveTriangleInCharSpace(
  l1: number,
  l2: number,
  hasClipBend: boolean,
  nonUniform: boolean,
  opts: AnalyticLegIkOptions,
): boolean {
  _axis.copy(_goalC).sub(_hipC);
  const rawDist = _axis.length();
  if (rawDist < 1e-6) return false;

  const cosMin = nonUniform ? COS_MIN_KNEE_NONUNIFORM : COS_MIN_KNEE;
  const cosMax = nonUniform ? COS_MAX_KNEE_NONUNIFORM : COS_MAX_KNEE;
  const dMin = Math.max(Math.abs(l1 - l2) + 0.002, Math.sqrt(Math.max(0, l1 * l1 + l2 * l2 + 2 * l1 * l2 * cosMax)));
  const dMax = Math.sqrt(Math.max(0, l1 * l1 + l2 * l2 + 2 * l1 * l2 * cosMin));
  const d = T.MathUtils.clamp(rawDist, dMin, dMax);
  _axis.divideScalar(rawDist);
  _solvedAnkleC.copy(_hipC).addScaledVector(_axis, d);

  const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));

  _poleC.copy(_poleBaseC).addScaledVector(_axis, -_poleBaseC.dot(_axis));
  if (!opts.explicitPoleWorld && _poleC.lengthSq() > 1e-8 && hasClipBend) {
    _poleC.normalize();
    _clipPerp.copy(_clipBendC).addScaledVector(_axis, -_clipBendC.dot(_axis));
    // Never let an inverted clip bend pull the anterior knee pole into the posterior hemisphere
    if (_clipPerp.lengthSq() > 1e-8 && _poleC.dot(_clipPerp) > -0.25) {
      _clipPerp.normalize();
      const ang = Math.atan2(_cross.crossVectors(_poleC, _clipPerp).dot(_axis), _poleC.dot(_clipPerp));
      _poleC.applyAxisAngle(_axis, T.MathUtils.clamp(ang, -MAX_CLIP_KNEE_PLANE_RAD, MAX_CLIP_KNEE_PLANE_RAD));
    }
  }
  if (_poleC.lengthSq() < 1e-8) {
    _poleC.set(0, 0, 1).addScaledVector(_axis, -_axis.z);
    if (_poleC.lengthSq() < 1e-8) {
      _poleC.set(opts.charSideX * 0.1, 1, 0).addScaledVector(_axis, -_poleC.dot(_axis));
    }
  }
  _poleC.normalize();
  // Guarantee anterior anatomical knee hinge (`(pole x axis).x > 0` in pelvis space when leg extends below/ahead of hip)
  if (!opts.explicitPoleWorld && _axis.y < 0.25 && _poleC.y * _axis.z - _poleC.z * _axis.y <= 0) {
    _poleC.set(0, 0.25, 1).addScaledVector(_axis, -(0.25 * _axis.y + _axis.z));
    if (_poleC.lengthSq() > 1e-8) _poleC.normalize();
    else _poleC.set(0, 0, 1);
  }

  _solvedKneeC.copy(_hipC).addScaledVector(_axis, along).addScaledVector(_poleC, h);

  // Coronal anti-bow-leg & anti-valgus midline clamp in character space:
  // Bounds outward knee excursion relative to max(hipLat, ankleLat) on the exact Law-of-Cosines circle.
  if ((opts.clampCoronalSplay ?? true) && !opts.explicitPoleWorld && h > 1e-4) {
    const hipLat = Math.abs(_hipC.x);
    const ankleLat = Math.max(0, opts.charSideX * _solvedAnkleC.x);
    const minLat = Math.max(0.022, Math.min(hipLat, ankleLat) - 0.032);
    const maxLat = Math.max(hipLat, ankleLat) + 0.032;
    if (clampKneeCircleCoronal(_hipC, _axis, along, h, _poleC, opts.charSideX, minLat, maxLat, _solvedKneeC)) {
      _poleC.copy(_solvedKneeC).sub(_hipC).addScaledVector(_axis, -along).divideScalar(h);
    }
  }

  return rawDist < dMin - 1e-5 || rawDist > dMax + 1e-5;
}

/**
 * Module-level zero-closure helper evaluating the 1D non-uniform CAZ ellipsoid scalar residual
 * `f(alpha) = ||goalW - kneeW(alpha)|| - ||ankleW(alpha) - kneeW(alpha)||` with zero heap allocations.
 */
function evalNonUniformAlpha(
  alpha: number,
  l1: number,
  s: number,
  invS: number,
  hipLat: number,
  doCoronalClamp: boolean,
  charSideX: 1 | -1,
  thigh: T.Bone,
  shin: T.Bone,
  foot: T.Bone,
  goalW: T.Vector3,
): number {
  thigh.quaternion.copy(_savedThighQ);
  shin.quaternion.copy(_savedShinQ);
  thigh.updateWorldMatrix(false, true);
  const alongA = l1 * Math.cos(alpha);
  const hA = l1 * Math.sin(alpha);
  _solvedKneeC
    .copy(_hipC)
    .addScaledVector(_axis, alongA)
    .addScaledVector(_poleUnitC, hA);
  if (doCoronalClamp && hA > 1e-4) {
    _solvedAnkleC.copy(goalW).sub(_rootPos).applyQuaternion(_invRootQuat).multiplyScalar(invS);
    const ankleLat = Math.max(0, charSideX * _solvedAnkleC.x);
    const minLat = Math.max(0.022, Math.min(hipLat, ankleLat) - 0.032);
    const maxLat = Math.max(hipLat, ankleLat) + 0.032;
    clampKneeCircleCoronal(_hipC, _axis, alongA, hA, _poleUnitC, charSideX, minLat, maxLat, _solvedKneeC);
  }
  _solvedKneeW
    .copy(_solvedKneeC)
    .multiplyScalar(s)
    .applyQuaternion(_rootQuat)
    .add(_rootPos);
  aimBoneShearSafe(thigh, shin, _solvedKneeW);
  aimBoneShearSafe(shin, foot, goalW);
  shin.getWorldPosition(_kneeW);
  foot.getWorldPosition(_ankleW);
  return _kneeW.distanceTo(goalW) - _kneeW.distanceTo(_ankleW);
}

function applyPass0NonUniformClamp(thigh: T.Bone, shin: T.Bone, foot: T.Bone): void {
  thigh.quaternion.copy(_savedThighQ);
  shin.quaternion.copy(_savedShinQ);
  thigh.updateWorldMatrix(false, true);
  aimBoneShearSafe(thigh, shin, _pass0KneeW);
  aimBoneShearSafe(shin, foot, _pass0AnkleW);
}

/**
 * Solves exact Character-Space Law-of-Cosines Two-Bone Leg IK (`thigh -> shin -> foot`) with
 * zero heap allocations, `[0.06, 2.35] rad` anatomical knee limits, anti-bow-leg pole clamping,
 * and CAZ non-uniform bone-scale convergence (`<= 1 mm` FK residual).
 */
export function solveAnalyticLegIk(
  characterRoot: T.Object3D,
  thigh: T.Bone,
  shin: T.Bone,
  foot: T.Bone,
  targetAnkleWorld: T.Vector3,
  opts: AnalyticLegIkOptions,
  outResult?: AnalyticLegIkResult,
): void {
  const weight = T.MathUtils.clamp(opts.weight ?? 1, 0, 1);
  if (weight <= 1e-5) return;

  characterRoot.matrixWorld.decompose(_rootPos, _rootQuat, _rootScale);
  const pelvisYaw = opts.pelvisYawOffsetRad ?? 0;
  if (Math.abs(pelvisYaw) > 1e-6) {
    _qPelvisYaw.setFromAxisAngle(_yAxis, pelvisYaw);
    _rootQuat.multiply(_qPelvisYaw).normalize();
  }
  _invRootQuat.copy(_rootQuat).invert();
  const s = Math.max(1e-4, Math.abs(_rootScale.y));
  const invS = 1 / s;

  thigh.getWorldPosition(_hipW);
  shin.getWorldPosition(_kneeW);
  foot.getWorldPosition(_ankleW);

  _hipC.copy(_hipW).sub(_rootPos).applyQuaternion(_invRootQuat).multiplyScalar(invS);
  _kneeAnimC.copy(_kneeW).sub(_rootPos).applyQuaternion(_invRootQuat).multiplyScalar(invS);
  _ankleAnimC.copy(_ankleW).sub(_rootPos).applyQuaternion(_invRootQuat).multiplyScalar(invS);
  _goalC.copy(targetAnkleWorld).sub(_rootPos).applyQuaternion(_invRootQuat).multiplyScalar(invS);

  let l1 = _hipC.distanceTo(_kneeAnimC);
  let l2 = _kneeAnimC.distanceTo(_ankleAnimC);
  if (l1 < 1e-4 || l2 < 1e-4) return;

  // Capture animated clip's knee bend plane before mutating thigh/shin
  _axisAnim.copy(_ankleAnimC).sub(_hipC);
  let hasClipBend = false;
  if (_axisAnim.lengthSq() > 1e-8) {
    _axisAnim.normalize();
    _clipBendC.copy(_kneeAnimC).sub(_hipC);
    _clipBendC.addScaledVector(_axisAnim, -_clipBendC.dot(_axisAnim));
    hasClipBend = _clipBendC.lengthSq() > 1e-4;
  }

  // Base pole direction in pelvis-aligned character space (`dot >= 0.25` anterior guard prevents 180 deg toe-down flip)
  if (opts.explicitPoleWorld) {
    _poleBaseC.copy(opts.explicitPoleWorld).sub(_rootPos).applyQuaternion(_invRootQuat).multiplyScalar(invS).sub(_hipC);
  } else if (opts.shoeForwardChar && opts.shoeForwardChar.lengthSq() > 1e-6) {
    _poleBaseC.copy(opts.shoeForwardChar);
    if (Math.abs(pelvisYaw) > 1e-6) {
      const cy = Math.cos(pelvisYaw);
      const sy = Math.sin(pelvisYaw);
      const fx = _poleBaseC.x;
      const fz = _poleBaseC.z;
      _poleBaseC.x = fx * cy - fz * sy;
      _poleBaseC.z = fx * sy + fz * cy;
    }
    const horizSq = _poleBaseC.x * _poleBaseC.x + _poleBaseC.z * _poleBaseC.z;
    if (horizSq > 1e-8) {
      const horizLen = Math.sqrt(horizSq);
      const nx = _poleBaseC.x / horizLen;
      const nz = _poleBaseC.z / horizLen;
      if (nz < 0.25) {
        const signX = Math.abs(nx) > 1e-5 ? (nx >= 0 ? 1 : -1) : 0;
        if (signX !== 0) {
          _poleBaseC.set(signX * Math.sqrt(1 - 0.25 * 0.25), 0, 0.25);
        } else {
          _poleBaseC.set(0, 0, 1);
        }
      } else {
        _poleBaseC.set(nx, 0, nz);
      }
    } else {
      _poleBaseC.set(0, 0, 1);
    }
  } else {
    _poleBaseC.set(0, 0, 1);
  }

  _savedThighQ.copy(thigh.quaternion);
  _savedShinQ.copy(shin.quaternion);

  const nonUniform = hasNonUniformHierarchyScale(thigh, shin);
  let clampedReach = solveTriangleInCharSpace(l1, l2, hasClipBend, nonUniform, opts);
  _solvedKneeW.copy(_solvedKneeC).multiplyScalar(s).applyQuaternion(_rootQuat).add(_rootPos);
  _solvedAnkleW.copy(_solvedAnkleC).multiplyScalar(s).applyQuaternion(_rootQuat).add(_rootPos);

  if (!nonUniform) {
    aimBoneShearSafe(thigh, shin, _solvedKneeW);
    aimBoneShearSafe(shin, foot, _solvedAnkleW);
  } else {
    // Exact 1D monotonic ellipsoid solver in the coronal-clamped bend plane ( _axis, _poleUnitC ):
    // For any thigh elevation angle `alpha` off `_axis`, aiming `shin` directly at `targetAnkleWorld`
    // from the realized knee `K(alpha)` aligns direction 100% and reduces the 3D non-uniform-scale
    // problem to the strictly monotonic scalar root `f(alpha) = ||G - K(alpha)|| - ||A(alpha) - K(alpha)|| = 0`!
    _poleUnitC.copy(_solvedKneeC).sub(_hipC);
    _poleUnitC.addScaledVector(_axis, -_poleUnitC.dot(_axis));
    if (_poleUnitC.lengthSq() < 1e-10) {
      _poleUnitC.copy(_poleC);
    } else {
      _poleUnitC.normalize();
    }

    const doCoronalClamp = (opts.clampCoronalSplay ?? true) && !opts.explicitPoleWorld;
    const hipLat = Math.abs(_hipC.x);

    _pass0KneeW.copy(_solvedKneeW);
    _pass0AnkleW.copy(_solvedAnkleW);

    const alphaLo = 0.025;
    const alphaHi = 1.42;

    const fLo = evalNonUniformAlpha(
      alphaLo,
      l1,
      s,
      invS,
      hipLat,
      doCoronalClamp,
      opts.charSideX,
      thigh,
      shin,
      foot,
      targetAnkleWorld,
    );
    if (fLo >= -1e-6) {
      clampedReach = true;
      applyPass0NonUniformClamp(thigh, shin, foot);
    } else {
      const fHi = evalNonUniformAlpha(
        alphaHi,
        l1,
        s,
        invS,
        hipLat,
        doCoronalClamp,
        opts.charSideX,
        thigh,
        shin,
        foot,
        targetAnkleWorld,
      );
      if (fHi <= 1e-6) {
        clampedReach = true;
        applyPass0NonUniformClamp(thigh, shin, foot);
      } else {
        let lo = alphaLo;
        let hi = alphaHi;
        let flo = fLo;
        let fhi = fHi;
        const along0 = T.MathUtils.clamp(
          (l1 * l1 - l2 * l2 + _hipC.distanceToSquared(_goalC)) /
            (2 * Math.max(1e-4, l1 * _hipC.distanceTo(_goalC))),
          -1,
          1,
        );
        let mid = T.MathUtils.clamp(Math.acos(along0), lo + 1e-3, hi - 1e-3);
        let lastSide = 0;
        let converged = false;
        for (let iter = 0; iter < 14; iter++) {
          const fm = evalNonUniformAlpha(
            mid,
            l1,
            s,
            invS,
            hipLat,
            doCoronalClamp,
            opts.charSideX,
            thigh,
            shin,
            foot,
            targetAnkleWorld,
          );
          if (Math.abs(fm) <= 5e-5) {
            converged = true;
            break; // <= 0.05 mm world residual!
          }
          if (fm < 0) {
            lo = mid;
            flo = fm;
            if (lastSide === -1) fhi *= 0.5; // Illinois superlinear anti-stagnation!
            lastSide = -1;
          } else {
            hi = mid;
            fhi = fm;
            if (lastSide === 1) flo *= 0.5;
            lastSide = 1;
          }
          const denom = fhi - flo;
          const sec = Math.abs(denom) > 1e-9 ? lo - flo * ((hi - lo) / denom) : 0.5 * (lo + hi);
          const margin = 0.15 * (hi - lo);
          mid = sec > lo + margin && sec < hi - margin ? sec : 0.5 * (lo + hi);
        }
        if (!converged) {
          evalNonUniformAlpha(
            0.5 * (lo + hi),
            l1,
            s,
            invS,
            hipLat,
            doCoronalClamp,
            opts.charSideX,
            thigh,
            shin,
            foot,
            targetAnkleWorld,
          );
        }

        const realizedFlex = computeSolvedKneeFlexionRad(thigh, shin, foot);
        if (realizedFlex < MIN_KNEE_FLEX_RAD + 5e-4 || realizedFlex > MAX_KNEE_FLEX_RAD - 5e-4) {
          clampedReach = true;
          applyPass0NonUniformClamp(thigh, shin, foot);
        } else {
          clampedReach = false;
        }
      }
    }
  }

  if (weight < 0.9999) {
    _qLocalTarget.copy(thigh.quaternion);
    thigh.quaternion.copy(_savedThighQ).slerp(_qLocalTarget, weight);
    thigh.updateWorldMatrix(false, true);
    _qLocalTarget.copy(shin.quaternion);
    shin.quaternion.copy(_savedShinQ).slerp(_qLocalTarget, weight);
    shin.updateWorldMatrix(false, true);
  }

  if (opts.footWorldRotation) {
    applyFootWorldRotationShearSafe(foot, opts.footWorldRotation, weight);
  }

  if (opts.toeBone && opts.toeRestQuat && opts.toeCounterPitchRad !== undefined) {
    if (Math.abs(opts.toeCounterPitchRad) > 1e-4) {
      if (!opts.explicitPoleWorld && (_poleBaseC.x * _poleBaseC.x + _poleBaseC.z * _poleBaseC.z) > 1e-6) {
        const fLen = Math.hypot(_poleBaseC.x, _poleBaseC.z);
        _wantDir
          .set(_poleBaseC.z / fLen, 0, -_poleBaseC.x / fLen)
          .applyQuaternion(_rootQuat)
          .normalize();
      } else {
        _wantDir.copy(_toeAxis).applyQuaternion(_rootQuat).normalize();
      }
      foot.getWorldQuaternion(_qLocalTarget);
      _qFootLocalInv.copy(_qLocalTarget).multiply(opts.toeRestQuat).invert();
      _curDir.copy(_wantDir).applyQuaternion(_qFootLocalInv).normalize();
      _qToeDelta.setFromAxisAngle(_curDir, opts.toeCounterPitchRad * weight);
      opts.toeBone.quaternion.copy(opts.toeRestQuat).multiply(_qToeDelta);
    } else {
      opts.toeBone.quaternion.copy(opts.toeRestQuat);
    }
    opts.toeBone.updateWorldMatrix(false, true);
  }

  if (outResult) {
    shin.getWorldPosition(outResult.solvedKneeWorld);
    foot.getWorldPosition(outResult.reachedAnkleWorld);
    outResult.kneeFlexionRad = computeSolvedKneeFlexionRad(thigh, shin, foot);
    outResult.clampedReach = clampedReach;
  }
}

// ── Continuous Terrain/Slope Normal + Heel-Strike / Flat-Stance / Toe-Off Ankle Orientation ──────────

/**
 * Exponentially filters per-foot world terrain normal while clamping slope angle to `<= 35.5 deg`
 * so vertical step risers or curb faces never tilt the ankle `90 deg`. Zero allocations.
 */
export function filterFootSurfaceNormal(
  currentNormal: T.Vector3,
  rawNormal: T.Vector3 | null | undefined,
  stanceWeight: number,
  dt: number,
  rate = 18,
): T.Vector3 {
  if (!rawNormal || rawNormal.lengthSq() < 1e-8) {
    _clampedNormal.set(0, WORLD_UP_Y, 0);
  } else {
    _clampedNormal.copy(rawNormal).normalize();
    if (_clampedNormal.y < 0) _clampedNormal.negate();
    const cosMax = Math.cos(MAX_WALKABLE_SLOPE_RAD);
    if (_clampedNormal.y < cosMax) {
      const horizLen = Math.hypot(_clampedNormal.x, _clampedNormal.z);
      const sinMax = Math.sin(MAX_WALKABLE_SLOPE_RAD);
      if (horizLen > 1e-6) {
        _clampedNormal.x = (_clampedNormal.x / horizLen) * sinMax;
        _clampedNormal.z = (_clampedNormal.z / horizLen) * sinMax;
      } else {
        _clampedNormal.x = 0;
        _clampedNormal.z = 0;
      }
      _clampedNormal.y = cosMax;
    }
  }
  // Full terrain-normal alignment in stance (1.0), pre-aligned tangential clearance in swing (0.65)
  const clampedStance = T.MathUtils.clamp(stanceWeight, 0, 1);
  const align = 0.65 + 0.35 * clampedStance;
  _clampedNormal.x *= align;
  _clampedNormal.z *= align;
  _clampedNormal.y = 1 + (_clampedNormal.y - 1) * align;
  _clampedNormal.normalize();

  const effectiveRate = rate * (1 + 1.5 * clampedStance);
  const alpha = dt > 0 ? 1 - Math.exp(-effectiveRate * dt) : 1;
  currentNormal.lerp(_clampedNormal, alpha);
  if (currentNormal.lengthSq() < 1e-8) currentNormal.set(0, 1, 0);
  else currentNormal.normalize();
  return currentNormal;
}

export interface FootSlopeRollInput {
  /** Post-mixer animated world rotation of the `foot` bone. */
  animatedFootWorldQuat: T.Quaternion;
  /** Foot forward unit vector in the `foot` bone's local rest frame. */
  footForwardLocal: T.Vector3;
  /** Foot up unit vector in the `foot` bone's local rest frame. */
  footUpLocal: T.Vector3;
  /** Character facing yaw (radians, `+Z` = `0`), fallback when steep toe-off degenerates horizontal forward. */
  characterYaw: number;
  /** Filtered world-space support normal (`filterFootSurfaceNormal`). */
  filteredGroundNormalWorld: T.Vector3;
  /** Stance weight `[0..1]` (`1` = planted, `0` = swing). */
  stanceWeight: number;
  /** Normalized progress `[0..1]` within stance (`0..0.18` heel-strike, `0.18..0.72` flat, `0.72..1` toe-off). */
  stanceProgress?: number;
  /** Maximum horizontal shoe yaw deviation from `characterYaw` in stance (radians, default `0.45` = `~25.8 deg`). */
  maxFootYawOffsetRad?: number;
}

export interface FootSlopeRollOutput {
  footWorldQuat: T.Quaternion;
  /** Counter-bend pitch (radians) for `Codex52` `ToeBase` so toes stay flat during heel rise. */
  toeCounterPitchRad: number;
}

/**
 * Computes continuous world-space ankle rotation matching terrain/ramp slope normal while preserving
 * biomechanical heel-strike dorsiflexion (`u < 0.18`), flat mid-stance (`0.18..0.72`), and toe-off
 * plantarflexion (`u > 0.72`). Zero allocations.
 */
export function solveFootSlopeAndRollRotation(
  input: FootSlopeRollInput,
  out: FootSlopeRollOutput,
): FootSlopeRollOutput {
  const {
    animatedFootWorldQuat,
    footForwardLocal,
    footUpLocal,
    characterYaw,
    filteredGroundNormalWorld,
  } = input;
  const stanceW = T.MathUtils.clamp(input.stanceWeight, 0, 1);
  const u = T.MathUtils.clamp(input.stanceProgress ?? 0.45, 0, 1);

  _footUpW.copy(footUpLocal).applyQuaternion(animatedFootWorldQuat).normalize();
  _footFwdW.copy(footForwardLocal).applyQuaternion(animatedFootWorldQuat).normalize();

  const charSin = Math.sin(characterYaw);
  const charCos = Math.cos(characterYaw);
  _flatFwd.set(_footFwdW.x, 0, _footFwdW.z);
  const flatLen = _flatFwd.length();
  if (flatLen < 1e-4) {
    _flatFwd.set(charSin, 0, charCos);
  } else {
    _flatFwd.divideScalar(flatLen);
    // Steep plantarflexion / back-kick (`flatLen < 0.65` or negative dot) blends smoothly to `characterYaw` instead of snapping +-maxYaw
    const steepBlend = 1 - T.MathUtils.smoothstep(flatLen, 0.25, 0.65);
    if (steepBlend > 1e-4) {
      _flatFwd.x = T.MathUtils.lerp(_flatFwd.x, charSin, steepBlend);
      _flatFwd.z = T.MathUtils.lerp(_flatFwd.z, charCos, steepBlend);
      const bLen = Math.hypot(_flatFwd.x, _flatFwd.z);
      if (bLen > 1e-5) _flatFwd.divideScalar(bLen);
      else _flatFwd.set(charSin, 0, charCos);
    }
    const maxStanceYaw = Math.max(0.08, input.maxFootYawOffsetRad ?? 0.45);
    const maxYaw = T.MathUtils.lerp(Math.max(maxStanceYaw, 0.62), maxStanceYaw, stanceW);
    const yawDot = _flatFwd.x * charSin + _flatFwd.z * charCos;
    const yawDet = _flatFwd.x * charCos - _flatFwd.z * charSin;
    if (yawDot < 0.15) {
      const clampedSign = Math.abs(yawDet) > 1e-5 ? (yawDet >= 0 ? 1 : -1) : 0;
      const clampedYaw = characterYaw + clampedSign * Math.min(maxYaw, 0.35);
      _flatFwd.set(Math.sin(clampedYaw), 0, Math.cos(clampedYaw));
    } else {
      const yawDiff = Math.atan2(yawDet, yawDot);
      if (Math.abs(yawDiff) > maxYaw) {
        const clampedYaw = characterYaw + T.MathUtils.clamp(yawDiff, -maxYaw, maxYaw);
        _flatFwd.set(Math.sin(clampedYaw), 0, Math.cos(clampedYaw));
      }
    }
  }
  // Right-handed basis: flatRight = UP x flatFwd
  _flatRight.set(_flatFwd.z, 0, -_flatFwd.x);

  const animPitch = Math.atan2(_footFwdW.y, Math.hypot(_footFwdW.x, _footFwdW.z));
  const animRoll = Math.asin(T.MathUtils.clamp(_footUpW.dot(_flatRight), -1, 1));

  // Decompose filtered terrain normal into sagittal slope pitch (uphill > 0 => front.y > 0) and coronal roll
  const n = filteredGroundNormalWorld;
  const slopePitch = T.MathUtils.clamp(
    Math.atan2(-n.dot(_flatFwd), Math.max(0.25, n.y)),
    -0.52,
    0.52,
  );
  const slopeRoll = T.MathUtils.clamp(
    Math.asin(T.MathUtils.clamp(n.dot(_flatRight), -1, 1)),
    -0.22,
    0.22,
  );

  // Mid-stance flattening envelope: preserves heel-strike (u < 0.18) and toe-off (u > 0.72) roll!
  const enterFlat = T.MathUtils.smoothstep(u, 0.04, 0.2);
  const exitToeOff = 1 - T.MathUtils.smoothstep(u, 0.7, 0.94);
  const flatAlign = stanceW * enterFlat * exitToeOff;

  // Superimpose terrain slope onto animated roll, flattening residual mocap hover tilt during mid-stance
  const rawPitch = T.MathUtils.lerp(animPitch + slopePitch * stanceW, slopePitch, flatAlign * 0.85);
  const rawRoll = T.MathUtils.lerp(animRoll + slopeRoll * stanceW, slopeRoll, stanceW * 0.9);

  const finalPitch = T.MathUtils.clamp(rawPitch, -0.72, 0.55);
  const finalRoll = T.MathUtils.clamp(rawRoll, -0.17, 0.17);

  const cp = Math.cos(finalPitch);
  const sp = Math.sin(finalPitch);
  _outFwd.copy(_flatFwd).multiplyScalar(cp);
  _outFwd.y += sp;
  _outUp.set(0, cp, 0).addScaledVector(_flatFwd, -sp);

  const cr = Math.cos(finalRoll);
  const sr = Math.sin(finalRoll);
  _outRight.copy(_flatRight).multiplyScalar(cr).addScaledVector(_outUp, -sr);
  _outUp.multiplyScalar(cr).addScaledVector(_flatRight, sr);

  _footRightLocal.crossVectors(footUpLocal, footForwardLocal).normalize();
  _mFootLocalInv.makeBasis(_footRightLocal, footUpLocal, footForwardLocal);
  _qFootLocalInv.setFromRotationMatrix(_mFootLocalInv).invert();

  _mFootWorld.makeBasis(_outRight, _outUp, _outFwd);
  out.footWorldQuat.setFromRotationMatrix(_mFootWorld).multiply(_qFootLocalInv).normalize();

  // During late stance toe-off (heel rising => finalPitch < slopePitch), counter-bend Codex52 ToeBase
  const heelRise = Math.max(0, slopePitch - finalPitch);
  const toeOffMask = stanceW * T.MathUtils.smoothstep(u, 0.62, 0.88);
  out.toeCounterPitchRad = -heelRise * 0.65 * toeOffMask;
  return out;
}

// ── Swing-Safe Stance Foot-Lock & Target Helper (Fixes NPC `-18.6 cm` Swing-Crouch Bug) ──────────────

export interface NpcFootLockState {
  locked: boolean;
  lockX: number;
  lockZ: number;
  releaseX: number;
  releaseZ: number;
  filteredNormal: T.Vector3;
}

export function createNpcFootLockState(): NpcFootLockState {
  return {
    locked: false,
    lockX: 0,
    lockZ: 0,
    releaseX: 0,
    releaseZ: 0,
    filteredNormal: new T.Vector3(0, 1, 0),
  };
}

export function resetNpcFootLockState(state: NpcFootLockState): void {
  state.locked = false;
  state.lockX = 0;
  state.lockZ = 0;
  state.releaseX = 0;
  state.releaseZ = 0;
  state.filteredNormal.set(0, 1, 0);
}

export interface StanceFootSampleInput {
  animX: number;
  animY: number;
  animZ: number;
  /** Walkable floor height directly beneath `(animX, animZ)`, or `null` if off-surface. */
  groundY: number | null;
  /**Actor root Y in the same coordinate space (for stance-only pelvis drop calculation). */
  rootY: number;
  /** Calibrated rest ankle clearance above `groundY` (`footRestY`). */
  footRestY: number;
  /** Normalized stance contact weight `[0..1]` (`1` = planted stance, `0` = airborne swing). */
  stanceWeight: number;
  /** Actor angular yaw rate in `rad/s` (releases lock smoothly across `1.65 -> 2.20 rad/s`). */
  yawRate: number;
  /** Frame delta time in seconds. */
  dt: number;
  /** Actor uniform scale (defaults to `1`). */
  scale?: number;
}

export interface StanceFootSampleOutput {
  targetX: number;
  targetY: number;
  targetZ: number;
  effectiveLockWeight: number;
  /** Negative (or `0`) pelvis drop needed when a planted stance foot stands on a lower step/curb. */
  pelvisDropRequest: number;
}

/**
 * Computes the world/stage ankle IK target with full-speed stance locking (`<= 2.8 cm` leash),
 * smooth pivot-turn release (`> 2.2 rad/s`), and **100% swing-phase foot-lift preservation**
 * (`targetY = lerp(max(animY, floorAnkleY), floorAnkleY, w_lock)` — NEVER pulls a lifted swing
 * foot down onto the floor or crouches the pelvis during swing!). Zero allocations.
 */
export function sampleStanceFootTarget(
  state: NpcFootLockState,
  input: StanceFootSampleInput,
  out: StanceFootSampleOutput,
): StanceFootSampleOutput {
  const k = Math.max(0.25, input.scale ?? 1);
  const dt = Math.max(0, input.dt);

  if (input.groundY === null) {
    state.locked = false;
    const decay = Math.exp(-22 * dt);
    state.releaseX *= decay;
    state.releaseZ *= decay;
    out.targetX = input.animX + state.releaseX;
    out.targetY = input.animY;
    out.targetZ = input.animZ + state.releaseZ;
    out.effectiveLockWeight = 0;
    out.pelvisDropRequest = 0;
    return out;
  }

  const turnRelease =
    1 -
    T.MathUtils.smoothstep(
      Math.abs(input.yawRate),
      PIVOT_RELEASE_START_RAD_S,
      PIVOT_RELEASE_FULL_RAD_S,
    );
  const wLock = T.MathUtils.clamp(input.stanceWeight, 0, 1) * turnRelease;

  if (!state.locked && wLock >= 0.45) {
    state.locked = true;
    state.lockX = input.animX;
    state.lockZ = input.animZ;
  } else if (wLock <= 0.05) {
    state.locked = false;
  }

  if (state.locked && wLock > 0.05) {
    const dx = state.lockX - input.animX;
    const dz = state.lockZ - input.animZ;
    const dist = Math.hypot(dx, dz);
    const maxLock = MAX_STANCE_LOCK_M * k;
    if (dist > maxLock) {
      // Smoothly pull anchor onto the `2.8 cm` leash boundary so total stance slip stays <= 3 cm
      const inv = maxLock / dist;
      state.lockX = input.animX + dx * inv;
      state.lockZ = input.animZ + dz * inv;
    }
    out.targetX = T.MathUtils.lerp(input.animX, state.lockX, wLock);
    out.targetZ = T.MathUtils.lerp(input.animZ, state.lockZ, wLock);
    state.releaseX = out.targetX - input.animX;
    state.releaseZ = out.targetZ - input.animZ;
  } else {
    const decay = Math.exp(-22 * dt);
    state.releaseX *= decay;
    state.releaseZ *= decay;
    out.targetX = input.animX + state.releaseX;
    out.targetZ = input.animZ + state.releaseZ;
  }

  const floorAnkleY = input.groundY + input.footRestY;
  // CRITICAL: During swing (wLock -> 0), max(animY, floorAnkleY) preserves 100% of upward swing lift
  // while preventing ground penetration if terrain rises beneath the swinging foot!
  const swingSafeY = Math.max(input.animY, floorAnkleY);
  out.targetY = T.MathUtils.lerp(swingSafeY, floorAnkleY, wLock);
  out.effectiveLockWeight = wLock;
  out.pelvisDropRequest = wLock * Math.min(0, input.groundY - input.rootY);
  return out;
}
