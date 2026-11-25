import * as T from 'three';

const UP = new T.Vector3(0, 1, 0);
/** The cast's arm in metres at scale 1.04: Character builds them from the loaded skeleton; these are the reference numbers. */
export const UPPER_ARM = .25, FOREARM = .213;
/** Natural wrist flexion/pronation envelope (radians) for cylindrical power-grip handles (`grip === 'handle' && wrap`). */
export const HANDLE_WRAP_WRIST_LIMIT = 1.35;
/** Maximum wrist flexion off the forearm for general props (`<= 0.95 rad`). */
export const MAX_GENERAL_WRIST_FLEX_RAD = 0.95;
/** Maximum anatomical forearm pronation/supination roll (`<= 1.25 rad` / `~71.6°`). */
export const MAX_FOREARM_ROLL_RAD = 1.25;

const _cylWorldM = new T.Matrix4();
const _cylOrigin = new T.Vector3();
const _cylAxis = new T.Vector3();
const _shaftPt = new T.Vector3();
const _palmLocal = new T.Vector3();
const _invGoalQ = new T.Quaternion();

// Zero-allocation scratch registers for alignWrist, reachableWrist, solveArm, wristStrain
const _awHandAxis = new T.Vector3();
const _awArmAxis = new T.Vector3();
const _awCross = new T.Vector3();
const _awSwing = new T.Quaternion();

const _rwOffset = new T.Vector3();
const _rwHand = new T.Vector3();
const _rwAcross = new T.Vector3();

const _saAxis = new T.Vector3();
const _saBend = new T.Vector3();
const _saHand = new T.Vector3();
const _saProj = new T.Vector3();
const _saTangent = new T.Vector3();
const _saTrial = new T.Vector3();
const _saFore = new T.Vector3();
const _saNeutral = new T.Vector3();

const _wsUpper = new T.Vector3();
const _wsFore = new T.Vector3();
const _wsHinge = new T.Vector3();
const _wsHand = new T.Vector3();
const _wsNeutral = new T.Vector3();
const _wsAcross = new T.Vector3();
const _wsCross = new T.Vector3();

/** Preserve palm twist while limiting wrist bend relative to the actual forearm (zero heap allocations). */
export function alignWrist(rotation: T.Quaternion, forearm: T.Vector3, limit: number) {
  _awHandAxis.copy(UP).applyQuaternion(rotation);
  _awArmAxis.copy(forearm);
  const armLenSq = _awArmAxis.lengthSq();
  if (armLenSq < 1e-12) return rotation;
  _awArmAxis.divideScalar(Math.sqrt(armLenSq));
  const clampedLim = Math.max(0, limit);
  const angle = _awHandAxis.angleTo(_awArmAxis);
  if (angle <= clampedLim + 1e-7) return rotation;
  _awCross.crossVectors(_awHandAxis, _awArmAxis);
  const crossLenSq = _awCross.lengthSq();
  if (crossLenSq < 1e-12) {
    _awCross.set(Math.abs(_awArmAxis.x) < 0.8 ? 1 : 0, Math.abs(_awArmAxis.x) < 0.8 ? 0 : 1, 0);
    _awCross.addScaledVector(_awArmAxis, -_awCross.dot(_awArmAxis)).normalize();
  } else {
    _awCross.divideScalar(Math.sqrt(crossLenSq));
  }
  _awSwing.setFromAxisAngle(_awCross, angle - clampedLim);
  return rotation.premultiply(_awSwing).normalize();
}

/**
 * Re-seats a cylindrical handle's wrist target when `alignWrist` adjusts `alignedHand` relative to `goalHand`:
 * preserves the planned hand-local palm seat offset onto the cylinder's world axis (`shapeToLocal^-1`) so the
 * palm grip cylinder axis stays `< 0.1 mm` coaxial with the tool shaft (`0` palm peel, `0` bone stretch).
 */
export function reSeatCylindricalHandleWrist(
  wristGoal: T.Vector3,
  goalHand: T.Quaternion,
  alignedHand: T.Quaternion,
  shapeToLocal: T.Matrix4,
  out = new T.Vector3(),
): T.Vector3 {
  if (goalHand.angleTo(alignedHand) <= 1e-5) return out.copy(wristGoal);
  const det = shapeToLocal.determinant();
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return out.copy(wristGoal);
  _cylWorldM.copy(shapeToLocal).invert();
  const e = _cylWorldM.elements;
  _cylOrigin.set(e[12], e[13], e[14]);
  _cylAxis.set(e[4], e[5], e[6]);
  if (_cylAxis.lengthSq() < 1e-10) return out.copy(wristGoal);
  _cylAxis.normalize();

  // Closest point on the shaft axis to `wristGoal` defines the axial station; its offset in `goalHand` is the palm seat.
  const s0 = _shaftPt.copy(wristGoal).sub(_cylOrigin).dot(_cylAxis);
  _shaftPt.copy(_cylOrigin).addScaledVector(_cylAxis, s0);
  _invGoalQ.copy(goalHand).invert();
  _palmLocal.copy(_shaftPt).sub(wristGoal).applyQuaternion(_invGoalQ);

  // Rotate that same hand-local palm seat by `alignedHand` and place the wrist so the palm seat lands back on `_shaftPt`.
  _palmLocal.applyQuaternion(alignedHand);
  return out.copy(_shaftPt).sub(_palmLocal);
}

/** Closest direction at the requested reach that permits the desired hand axis.
 * For fixed shoulder/wrist distance the forearm lies on a cone. Move the wrist
 * onto its feasible band before asking physics to move the held object there.
 */
export function reachableWrist(
  shoulder: T.Vector3,
  target: T.Vector3,
  hand: T.Vector3,
  upper: number,
  fore: number,
  limit: number,
  pole: T.Vector3,
  out = new T.Vector3(),
): T.Vector3 {
  _rwOffset.copy(target).sub(shoulder);
  const rawLenSq = _rwOffset.lengthSq();
  const length = T.MathUtils.clamp(Math.sqrt(rawLenSq), Math.abs(upper - fore) + .02, upper + fore - .004);
  if (rawLenSq < 1e-12) _rwOffset.copy(pole).sub(shoulder);
  if (_rwOffset.lengthSq() < 1e-12) _rwOffset.set(0, -1, 0);
  _rwOffset.normalize();
  _rwHand.copy(hand);
  const hLenSq = _rwHand.lengthSq();
  if (hLenSq < 1e-12) return out.copy(shoulder).addScaledVector(_rwOffset, length);
  _rwHand.divideScalar(Math.sqrt(hLenSq));
  const cone = Math.acos(T.MathUtils.clamp((length * length + fore * fore - upper * upper) / (2 * length * fore), -1, 1));
  const angle = _rwOffset.angleTo(_rwHand), wanted = T.MathUtils.clamp(angle, Math.max(0, cone - limit), Math.min(Math.PI, cone + limit));
  if (Math.abs(angle - wanted) < 1e-8) return out.copy(shoulder).addScaledVector(_rwOffset, length);
  _rwAcross.copy(_rwOffset).addScaledVector(_rwHand, -_rwOffset.dot(_rwHand));
  if (_rwAcross.lengthSq() < 1e-10) { _rwAcross.copy(pole).sub(shoulder); _rwAcross.addScaledVector(_rwHand, -_rwAcross.dot(_rwHand)); }
  if (_rwAcross.lengthSq() < 1e-10) { _rwAcross.set(Math.abs(_rwHand.x) < .8 ? 1 : 0, Math.abs(_rwHand.x) < .8 ? 0 : 1, 0); _rwAcross.addScaledVector(_rwHand, -_rwAcross.dot(_rwHand)); }
  _rwAcross.normalize();
  return out.copy(shoulder).addScaledVector(_rwHand, length * Math.cos(wanted)).addScaledVector(_rwAcross, length * Math.sin(wanted));
}

export interface SolvedArm {
  shoulder: T.Vector3;
  elbow: T.Vector3;
  wrist: T.Vector3;
}

/** Anatomical reach constraint with an outward/downward elbow pole. Bone lengths never stretch. */
export function solveArm(
  shoulder: T.Vector3,
  target: T.Vector3,
  pole: T.Vector3,
  upper = UPPER_ARM,
  forearm = FOREARM,
  hand?: { direction: T.Vector3; limit: number; palm?: T.Vector3; side?: number; maxRoll?: number },
  out?: SolvedArm,
): SolvedArm {
  _saAxis.copy(target).sub(shoulder);
  let axisLenSq = _saAxis.lengthSq();
  if (axisLenSq < 1e-12) {
    _saAxis.copy(pole).sub(shoulder);
    axisLenSq = _saAxis.lengthSq();
  }
  if (axisLenSq < 1e-12) {
    _saAxis.set(0, -1, 0);
    axisLenSq = 1;
  }
  const rawDist = Math.sqrt(axisLenSq);
  const d = T.MathUtils.clamp(rawDist, Math.abs(upper - forearm) + .02, upper + forearm - .004);
  _saAxis.divideScalar(rawDist);
  const along = (upper ** 2 - forearm ** 2 + d ** 2) / (2 * d);
  _saBend.copy(pole).sub(shoulder);
  _saBend.addScaledVector(_saAxis, -_saBend.dot(_saAxis));
  if (_saBend.lengthSq() < 1e-8) {
    _saBend.set(Math.abs(_saAxis.x) < .8 ? 1 : 0, Math.abs(_saAxis.x) < .8 ? 0 : 1, 0);
    _saBend.addScaledVector(_saAxis, -_saBend.dot(_saAxis));
  }
  _saBend.normalize();
  const radius = Math.sqrt(Math.max(0, upper ** 2 - along ** 2));
  if (hand && radius > 1e-6) {
    // All elbows reaching this wrist lie on a circle. Choose the closest natural pole on the arc that also permits the wrist's orientation.
    _saHand.copy(hand.direction).normalize();
    _saProj.copy(_saHand).addScaledVector(_saAxis, -_saHand.dot(_saAxis));
    const n = _saProj.length();
    if (n > 1e-6) {
      const inward = _saProj.multiplyScalar(-1 / n);
      _saTangent.crossVectors(_saAxis, inward);
      const bound = (forearm * Math.cos(hand.limit - .001) - (d - along) * _saHand.dot(_saAxis)) / (radius * n);
      const arc = Math.acos(T.MathUtils.clamp(bound, -1, 1));
      let angle = T.MathUtils.clamp(Math.atan2(_saBend.dot(_saTangent), _saBend.dot(inward)), -arc, arc);
      if (hand.palm && hand.side) {
        // Elbows on this arc all reach the same wrist within its bend limit.
        // Choose the nearest bend plane that also permits natural forearm roll.
        const palm = hand.palm, side = hand.side;
        const rollCos = (theta: number) => {
          _saTrial.copy(inward).multiplyScalar(Math.cos(theta)).addScaledVector(_saTangent, Math.sin(theta));
          _saFore.copy(_saAxis).multiplyScalar(d - along).addScaledVector(_saTrial, -radius).normalize();
          _saNeutral.crossVectors(_saAxis, _saTrial).multiplyScalar(side);
          const forePalm = _saFore.dot(palm);
          return _saNeutral.dot(palm) / Math.sqrt(Math.max(1e-8, 1 - forePalm * forePalm));
        };
        const start = angle, threshold = Math.cos(hand.maxRoll ?? MAX_FOREARM_ROLL_RAD);
        let best = rollCos(angle);
        for (let step = 1; step <= 12 && best < threshold; step++) {
          for (const sign of [-1, 1]) {
            const test = T.MathUtils.clamp(start + sign * step * .09, -arc, arc);
            const score = rollCos(test);
            if (score <= best) continue;
            if (score >= threshold) {
              let lo = angle, hi = test;
              for (let i = 0; i < 6; i++) {
                const mid = (lo + hi) / 2;
                if (rollCos(mid) < threshold) lo = mid; else hi = mid;
              }
              angle = hi; best = threshold; break;
            }
            angle = test; best = score;
          }
        }
      }
      _saBend.copy(inward).multiplyScalar(Math.cos(angle)).addScaledVector(_saTangent, Math.sin(angle));
    }
  }
  if (out) {
    out.shoulder.copy(shoulder);
    out.wrist.copy(shoulder).addScaledVector(_saAxis, d);
    out.elbow.copy(shoulder).addScaledVector(_saAxis, along).addScaledVector(_saBend, radius);
    return out;
  }
  const wrist = shoulder.clone().addScaledVector(_saAxis, d);
  const elbow = shoulder.clone().addScaledVector(_saAxis, along).addScaledVector(_saBend, radius);
  return { shoulder, elbow, wrist };
}

/**
 * What a forearm has to do to carry this hand: how far the wrist bends off the forearm, and how far the forearm rolls
 * from neutral (thumb up: the palm faces across the elbow's hinge). Radians, positive roll is pronation. A real arm
 * manages about 1.1 of bend at most and about 1.5 of roll either way; the poses stay inside that.
 */
export function wristStrain(side: number, shoulder: T.Vector3, elbow: T.Vector3, wrist: T.Vector3, fingers: T.Vector3, palm: T.Vector3) {
  _wsUpper.copy(elbow).sub(shoulder).normalize();
  _wsFore.copy(wrist).sub(elbow).normalize();
  _wsHinge.copy(_wsUpper).cross(_wsFore);
  if (_wsHinge.lengthSq() < 1e-6) _wsHinge.set(1, 0, 0);
  else _wsHinge.normalize();
  _wsHand.copy(fingers).normalize();
  const bend = _wsHand.angleTo(_wsFore);
  _wsNeutral.copy(_wsHinge).multiplyScalar(-side);
  _wsAcross.copy(palm).addScaledVector(_wsFore, -palm.dot(_wsFore)).normalize();
  const roll = Math.atan2(_wsCross.copy(_wsNeutral).cross(_wsAcross).dot(_wsFore) * -side, _wsNeutral.dot(_wsAcross));
  return { bend, roll };
}

/** Minimum-jerk progress, the bell-shaped speed of a human reach (Flash and Hogan). */
export function minJerk(t: number) {
  const k = Math.min(1, Math.max(0, t));
  return k * k * k * (10 + k * (-15 + 6 * k));
}
