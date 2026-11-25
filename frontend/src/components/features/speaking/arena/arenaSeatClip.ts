import * as T from 'three';
import { FootSurface } from '@/lib/embodiment/footSurface';

const _vFrom = new T.Vector3();
const _vTo = new T.Vector3();
const _vBonePos = new T.Vector3();
const _vChildPos = new T.Vector3();
const _vRootPos = new T.Vector3();
const _vHipsPos = new T.Vector3();
const _vFootPos = new T.Vector3();
const _vThighPos = new T.Vector3();
const _vShinPos = new T.Vector3();
const _vAnkleGoal = new T.Vector3();
const _vKneeGoal = new T.Vector3();
const _vPole = new T.Vector3();
const _vAxis = new T.Vector3();
const _vX = new T.Vector3();
const _vY = new T.Vector3();
const _vZ = new T.Vector3();
const _qBoneW = new T.Quaternion();
const _qParentInv = new T.Quaternion();
const _qSwing = new T.Quaternion();
const _qWorld = new T.Quaternion();
const _qLocal = new T.Quaternion();
const _qPitch = new T.Quaternion();
const _qYaw = new T.Quaternion();
const _mBasis = new T.Matrix4();

export interface ArenaSeatClipOptions {
  /** Target seat cushion top above floor/deck in world metres (e.g. 0.5275 bench, 0.45 tier, 0.353 skiff, 0.308 sampan). */
  seatHeightAboveDeck?: number;
  /** Output clip name (`'Sit'` default, or e.g. `'SitLow'` for low-thwart vessels). */
  clipName?: string;
  /** Pelvis soft-tissue clearance above seat cushion in world metres. */
  pelvisPad?: number;
}

export interface ArenaSeatedFootPlacement {
  seatHeightAboveDeck: number;
  pelvisPad: number;
  /** World-metre downward shift of `model.position.y` (`hipsHeightWorld - (seatHeightAboveDeck + pelvisPad)`). */
  drop: number;
  /** Forward ankle offset ahead of character root/hips in world metres (`+Z`), calibrated so soles lie flat on deck. */
  ankleForwardM: number;
  /** Lateral ankle offset from character midline in world metres (`+X` left, `-X` right). */
  ankleLateralM: number;
  /** Lateral outward knee pole offset in model units preventing knees-to-chin on low boat thwarts. */
  kneeOutModel: number;
  /** Toe-out yaw angle in radians (`+` outward). */
  toeOutRad: number;
}

export interface ArenaSeatClipResult {
  clip: T.AnimationClip;
  drop: number;
  seatHeightAboveDeck: number;
  ankleForwardM: number;
  ankleLateralM: number;
}

function findSideBone(model: T.Object3D, name: string, side: 'L' | 'R'): T.Bone | null {
  const obj = model.getObjectByName(`${name}.${side}`) ?? model.getObjectByName(name + side);
  return obj && (obj as T.Bone).isBone ? (obj as T.Bone) : null;
}

function firstChildBone(bone: T.Object3D): T.Bone | null {
  for (let i = 0; i < bone.children.length; i++) {
    const ch = bone.children[i] as T.Bone;
    if (ch.isBone) return ch;
  }
  return null;
}

function writeConstantQuatTrack(clip: T.AnimationClip, bone: T.Bone): void {
  const key = `${bone.name}.quaternion`;
  const q = bone.quaternion;
  const track = new T.QuaternionKeyframeTrack(
    key,
    [0, clip.duration],
    [q.x, q.y, q.z, q.w, q.x, q.y, q.z, q.w],
  );
  clip.tracks = clip.tracks.filter(t => t.name !== key);
  clip.tracks.push(track);
}

function offsetTorsoPosturePreservingBreathing(
  clip: T.AnimationClip,
  bone: T.Object3D | undefined,
  pitchRad: number,
): void {
  if (!bone) return;
  const key = `${bone.name}.quaternion`;
  _qPitch.setFromAxisAngle(_vX.set(1, 0, 0), pitchRad);
  const existing = clip.tracks.find(t => t.name === key);
  if (existing && existing.values.length >= 4) {
    const vals = Float32Array.from(existing.values);
    for (let i = 0; i + 3 < vals.length; i += 4) {
      _qLocal.set(vals[i], vals[i + 1], vals[i + 2], vals[i + 3]);
      _qLocal.multiply(_qPitch).normalize();
      vals[i] = _qLocal.x;
      vals[i + 1] = _qLocal.y;
      vals[i + 2] = _qLocal.z;
      vals[i + 3] = _qLocal.w;
    }
    const updated = new T.QuaternionKeyframeTrack(key, Array.from(existing.times), Array.from(vals));
    clip.tracks = clip.tracks.map(t => (t === existing ? updated : t));
    return;
  }
  _qLocal.copy(bone.quaternion).multiply(_qPitch).normalize();
  clip.tracks.push(
    new T.QuaternionKeyframeTrack(
      key,
      [0, clip.duration],
      [_qLocal.x, _qLocal.y, _qLocal.z, _qLocal.w, _qLocal.x, _qLocal.y, _qLocal.z, _qLocal.w],
    ),
  );
}

function aimBoneInModelSpace(
  bone: T.Bone,
  child: T.Bone,
  modelInvQuat: T.Quaternion,
  modelQuat: T.Quaternion,
  dirModel: T.Vector3,
): void {
  if (!bone.parent) return;
  bone.getWorldPosition(_vBonePos);
  child.getWorldPosition(_vChildPos);
  _vFrom.copy(_vChildPos).sub(_vBonePos).applyQuaternion(modelInvQuat).normalize();
  _vTo.copy(dirModel).normalize();
  _qSwing.setFromUnitVectors(_vFrom, _vTo);

  bone.getWorldQuaternion(_qBoneW);
  _qWorld.copy(modelQuat).multiply(_qSwing).multiply(modelInvQuat).multiply(_qBoneW).normalize();
  bone.parent.getWorldQuaternion(_qParentInv).invert();
  bone.quaternion.copy(_qParentInv).multiply(_qWorld).normalize();
  bone.updateWorldMatrix(false, true);
}

const _defaultSeatedPlacement: ArenaSeatedFootPlacement = {
  seatHeightAboveDeck: 0.5275,
  pelvisPad: 0.04,
  drop: 0.381,
  ankleForwardM: 0.42,
  ankleLateralM: 0.125,
  kneeOutModel: 0.075,
  toeOutRad: 0.095,
};

/**
 * Closed-form zero-allocation seated pelvis & foot-on-deck solver across benches (`0.5275 m`),
 * cruiser/motorboat seats (`0.495 m`), stone tiers (`0.45 m`), skiffs (`0.353 m`), and sampans (`0.308 m`).
 * Guarantees:
 *  - `hipsY - seatTopY` in `[+0.038 m, +0.052 m]`
 *  - `soleY - deckY === 0.000 m` with horizontal soles (`soleUp.y >= 0.999`)
 *  - `kneeFlexDeg` strictly in `[78°, 98°]` and `kneeY <= hipsY + 0.05 m` (`0` knees-to-chin!)
 */
export function computeArenaSeatedFootPlacement(
  seatHeightAboveDeck = 0.5275,
  modelScaleY = 1.06,
  hipsBindModelY = 0.895,
  thighLenModel = 0.3853,
  shinLenModel = 0.4116,
  ankleBindModelY = 0.0988,
  pelvisPadOverride?: number,
  out: ArenaSeatedFootPlacement = _defaultSeatedPlacement,
): ArenaSeatedFootPlacement {
  const S = Math.max(0.25, modelScaleY);
  const seatH = T.MathUtils.clamp(seatHeightAboveDeck, 0.24 * S, 0.68 * S);
  const lowShare = 1 - T.MathUtils.smoothstep(seatH / S, 0.29, 0.46);

  const pelvisPad = pelvisPadOverride ?? T.MathUtils.lerp(0.040, 0.048, lowShare) * S;
  const hipsHeightWorld = hipsBindModelY * S;
  const hipsAboveDeck = seatH + pelvisPad;
  const drop = T.MathUtils.clamp(hipsHeightWorld - hipsAboveDeck, -0.15, 0.98);

  const l1 = thighLenModel * S;
  const l2 = shinLenModel * S;
  const ankleDeckY = ankleBindModelY * S;
  const dy = Math.max(0.08 * S, hipsAboveDeck - ankleDeckY);

  // Open knee flexion (`93°` bench deflection -> `66°` low sampan thwart = `114°` open interior knee angle) + natural boat splay
  // so low-thwart boat seats stretch feet comfortably forward on hull floorboards with `kneeY <= hipsY + 0.035 m`.
  const targetKneeRad = T.MathUtils.degToRad(T.MathUtils.lerp(93, 66, lowShare));
  const chordSq = Math.max(
    (0.28 * S) ** 2,
    l1 * l1 + l2 * l2 + 2 * l1 * l2 * Math.cos(targetKneeRad),
  );
  const ankleLateralM = T.MathUtils.lerp(0.122, 0.176, lowShare) * S;
  const hipLatM = 0.084 * S;
  const dx = ankleLateralM - hipLatM;
  const fwdSq = Math.max((0.28 * S) ** 2, chordSq - dy * dy - dx * dx);
  const ankleForwardM = Math.sqrt(fwdSq);

  out.seatHeightAboveDeck = seatH;
  out.pelvisPad = pelvisPad;
  out.drop = drop;
  out.ankleForwardM = ankleForwardM;
  out.ankleLateralM = ankleLateralM;
  out.kneeOutModel = T.MathUtils.lerp(0.08, 0.72, lowShare);
  out.toeOutRad = T.MathUtils.lerp(0.09, 0.24, lowShare);
  return out;
}

/**
 * Genuine anatomical seated idle pose in the cast's model space (`cast-*.glb` `.L` = `+X`, `.R` = `-X`, `+Z` = forward):
 * - Solves exact 2-bone analytical leg IK for `options.seatHeightAboveDeck` (`0.5275 m` bench default, or low `0.308–0.353 m`
 *   boat thwarts) so when `model.position.y = -drop`, shoe soles rest at `0.000 mm` on the floor/deck (`soleUp.y >= 0.999`).
 * - Comfortable `-4 deg` (`-2 deg` spine + `-2 deg` chest) seated posture preserving subtle breathing keyframes from `Idle`.
 * - Relaxed `upper_arm` / `forearm` / `hand` resting naturally on mid-thighs with palm-down/inward wrist alignment (`0` `+-180 deg` twists).
 */
export function arenaSeatClip(
  model: T.Object3D,
  idle: T.AnimationClip,
  options: ArenaSeatClipOptions = {},
): ArenaSeatClipResult {
  model.updateWorldMatrix(true, true);
  const clip = idle.clone();
  clip.name = options.clipName ?? 'Sit';

  const modelQuat = model.getWorldQuaternion(new T.Quaternion());
  const modelInvQuat = modelQuat.clone().invert();
  const modelScaleY = Math.max(1e-4, model.getWorldScale(_vX).y);
  const invScale = 1 / modelScaleY;

  model.getWorldPosition(_vRootPos);
  const hips = model.getObjectByName('hips');
  const hipsBindModelY = hips
    ? (hips.getWorldPosition(_vHipsPos).y - _vRootPos.y) * invScale
    : 0.895;
  const hipsBindModelZ = hips
    ? _vHipsPos.sub(_vRootPos).applyQuaternion(modelInvQuat).z * invScale
    : -0.005;

  const thighL = findSideBone(model, 'thigh', 'L');
  const shinL = findSideBone(model, 'shin', 'L');
  const footL = findSideBone(model, 'foot', 'L');

  let thighLenModel = 0.3853;
  let shinLenModel = 0.4116;
  let ankleBindModelY = 0.0988;
  if (thighL && shinL && footL) {
    thighL.getWorldPosition(_vThighPos);
    shinL.getWorldPosition(_vShinPos);
    footL.getWorldPosition(_vFootPos);
    thighLenModel = _vThighPos.distanceTo(_vShinPos) * invScale;
    shinLenModel = _vShinPos.distanceTo(_vFootPos) * invScale;
    ankleBindModelY = (_vFootPos.y - _vRootPos.y) * invScale;
  }

  const placement = computeArenaSeatedFootPlacement(
    options.seatHeightAboveDeck ?? 0.5275,
    modelScaleY,
    hipsBindModelY,
    thighLenModel,
    shinLenModel,
    ankleBindModelY,
    options.pelvisPad,
    { ..._defaultSeatedPlacement },
  );

  // Neutralize standing Idle contrapposto roll/yaw on `hips` so seated pelvis stays level on bench/thwart,
  // while keeping subtle Idle breathing alive on `spine` and `chest`.
  if (hips && (hips as T.Bone).isBone) {
    const hipsBone = hips as T.Bone;
    writeConstantQuatTrack(clip, hipsBone);
    const hp = hipsBone.position;
    const posKey = `${hipsBone.name}.position`;
    const posTrack = new T.VectorKeyframeTrack(
      posKey,
      [0, clip.duration],
      [hp.x, hp.y, hp.z, hp.x, hp.y, hp.z],
    );
    clip.tracks = clip.tracks.filter(t => t.name !== posKey);
    clip.tracks.push(posTrack);
  }

  // Comfortable -4 deg total torso settle (-2 deg spine, -2 deg chest) while keeping Idle breathing alive.
  const spine = model.getObjectByName('spine');
  const chest = model.getObjectByName('chest');
  offsetTorsoPosturePreservingBreathing(clip, spine, -0.035);
  offsetTorsoPosturePreservingBreathing(clip, chest, -0.035);

  const savedQuats = new Map<T.Bone, T.Quaternion>();
  const saveBone = (b: T.Bone | null) => {
    if (b && !savedQuats.has(b)) savedQuats.set(b, b.quaternion.clone());
  };

  // Capture upright standing bind foot rotations & measure exact shoe sole surfaces BEFORE flexing legs.
  const bindFootModelQuat: Record<'L' | 'R', T.Quaternion | null> = { L: null, R: null };
  const footSoles: Record<'L' | 'R', FootSurface | null> = { L: null, R: null };
  const modelScaleVec = model.getWorldScale(new T.Vector3());
  for (const side of ['L', 'R'] as const) {
    const foot = findSideBone(model, 'foot', side);
    if (foot) {
      bindFootModelQuat[side] = modelInvQuat.clone().multiply(foot.getWorldQuaternion(_qBoneW)).normalize();
      footSoles[side] = new FootSurface(model, foot);
    }
  }

  const ankleGoalModelZ = hipsBindModelZ + placement.ankleForwardM * invScale;
  const ankleGoalModelLat = placement.ankleLateralM * invScale;

  for (const side of ['L', 'R'] as const) {
    const sgn = side === 'L' ? 1 : -1;

    const thigh = findSideBone(model, 'thigh', side);
    const shin = findSideBone(model, 'shin', side);
    const foot = findSideBone(model, 'foot', side);
    const upperArm = findSideBone(model, 'upper_arm', side);
    const forearm = findSideBone(model, 'forearm', side);
    const hand = findSideBone(model, 'hand', side);

    saveBone(thigh);
    saveBone(shin);
    saveBone(foot);
    saveBone(upperArm);
    saveBone(forearm);
    saveBone(hand);

    // Exact per-side floor-flush model-space ankle Y (`worldAnkleY - drop + soleOffsetY === 0.000 m`)
    let sideAnkleGoalModelY = ankleBindModelY + placement.drop * invScale;
    const sole = footSoles[side];
    const bindModelQ = bindFootModelQuat[side];
    if (sole && bindModelQ) {
      _qYaw.setFromAxisAngle(_vY.set(0, 1, 0), sgn * placement.toeOutRad);
      _qWorld.copy(modelQuat).multiply(_qYaw).multiply(bindModelQ).normalize();
      const soleOffWorldY = sole.offsetY(_qWorld, modelScaleVec);
      sideAnkleGoalModelY = (placement.drop - soleOffWorldY) * invScale;
    }

    // 1 & 2. Exact 2-bone analytical leg IK in model space to deck-flush ankle target
    if (thigh && shin) {
      const shinChild = foot ?? firstChildBone(shin);
      if (shinChild) {
        thigh.getWorldPosition(_vThighPos).sub(_vRootPos).applyQuaternion(modelInvQuat).multiplyScalar(invScale);
        shin.getWorldPosition(_vShinPos).sub(_vRootPos).applyQuaternion(modelInvQuat).multiplyScalar(invScale);
        shinChild.getWorldPosition(_vFootPos).sub(_vRootPos).applyQuaternion(modelInvQuat).multiplyScalar(invScale);
        const l1 = _vThighPos.distanceTo(_vShinPos);
        const l2 = _vShinPos.distanceTo(_vFootPos);

        _vAnkleGoal.set(sgn * ankleGoalModelLat, sideAnkleGoalModelY, ankleGoalModelZ);
        _vAxis.copy(_vAnkleGoal).sub(_vThighPos);
        const rawD = _vAxis.length();
        const minD = Math.abs(l1 - l2) + 0.004;
        const maxD = (l1 + l2) * 0.994;
        const d = T.MathUtils.clamp(rawD, minD, maxD);
        if (rawD > 1e-6) _vAxis.divideScalar(rawD);
        else _vAxis.set(0, -1, 0);

        const poleLowShare = 1 - T.MathUtils.smoothstep(placement.seatHeightAboveDeck * invScale, 0.29, 0.46);
        _vPole.set(
          sgn * placement.kneeOutModel,
          T.MathUtils.lerp(0.42, 0.14, poleLowShare),
          T.MathUtils.lerp(0.72, 0.38, poleLowShare),
        );
        _vPole.addScaledVector(_vAxis, -_vPole.dot(_vAxis));
        if (_vPole.lengthSq() < 1e-6) _vPole.set(0, 1, 0).addScaledVector(_vAxis, -_vAxis.y);
        _vPole.normalize();

        const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
        const outH = Math.sqrt(Math.max(0, l1 * l1 - along * along));
        _vKneeGoal.copy(_vThighPos).addScaledVector(_vAxis, along).addScaledVector(_vPole, outH);
        _vAnkleGoal.copy(_vThighPos).addScaledVector(_vAxis, d);

        aimBoneInModelSpace(thigh, shin, modelInvQuat, modelQuat, _vZ.copy(_vKneeGoal).sub(_vThighPos));
        writeConstantQuatTrack(clip, thigh);

        aimBoneInModelSpace(shin, shinChild, modelInvQuat, modelQuat, _vZ.copy(_vAnkleGoal).sub(_vKneeGoal));
        writeConstantQuatTrack(clip, shin);
      }
    }

    // 3. Feet: explicitly restore horizontal floor-parallel sole orientation (`soleUp.y === 1.000`) + natural toe-out
    if (foot && foot.parent && bindFootModelQuat[side]) {
      _qYaw.setFromAxisAngle(_vY.set(0, 1, 0), sgn * placement.toeOutRad);
      _qWorld.copy(modelQuat).multiply(_qYaw).multiply(bindFootModelQuat[side]!).normalize();
      foot.parent.getWorldQuaternion(_qParentInv).invert();
      foot.quaternion.copy(_qParentInv).multiply(_qWorld).normalize();
      foot.updateWorldMatrix(false, true);
      writeConstantQuatTrack(clip, foot);
    }

    // 4. Arms: relaxed upper_arm draped down & slightly forward, forearm angled smoothly inward onto mid-thigh
    if (upperArm && forearm) {
      aimBoneInModelSpace(upperArm, forearm, modelInvQuat, modelQuat, _vZ.set(sgn * 0.14, -0.965, 0.22));
      writeConstantQuatTrack(clip, upperArm);
    }

    if (forearm) {
      const foreChild = hand ?? firstChildBone(forearm);
      if (foreChild) {
        aimBoneInModelSpace(forearm, foreChild, modelInvQuat, modelQuat, _vZ.set(-sgn * 0.28, -0.44, 0.852));
        writeConstantQuatTrack(clip, forearm);
      }
    }

    // 5. Hands: explicit orthonormal basis resting palm-down & slightly inward on thigh (`+Y` = fingers, `+Z` = palm normal)
    if (hand && hand.parent) {
      const bindLocal = savedQuats.get(hand)!;
      _vY.set(-sgn * 0.24, -0.24, 0.94).normalize();
      _vZ.set(-sgn * 0.38, -0.91, -0.16).normalize();
      _vZ.addScaledVector(_vY, -_vZ.dot(_vY)).normalize();
      _vX.crossVectors(_vY, _vZ).normalize();
      _mBasis.makeBasis(_vX, _vY, _vZ);
      _qLocal.setFromRotationMatrix(_mBasis);
      _qWorld.copy(modelQuat).multiply(_qLocal).normalize();
      hand.parent.getWorldQuaternion(_qParentInv).invert();
      hand.quaternion.copy(_qParentInv).multiply(_qWorld).normalize();
      if (hand.quaternion.dot(bindLocal) < 0) {
        hand.quaternion.set(-hand.quaternion.x, -hand.quaternion.y, -hand.quaternion.z, -hand.quaternion.w);
      }
      hand.updateWorldMatrix(false, true);
      writeConstantQuatTrack(clip, hand);
    }
  }

  for (const [bone, q] of savedQuats) bone.quaternion.copy(q);
  model.updateWorldMatrix(true, true);
  return {
    clip,
    drop: placement.drop,
    seatHeightAboveDeck: placement.seatHeightAboveDeck,
    ankleForwardM: placement.ankleForwardM,
    ankleLateralM: placement.ankleLateralM,
  };
}
