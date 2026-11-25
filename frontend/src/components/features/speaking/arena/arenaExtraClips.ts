import * as T from 'three';
import { alignWrist } from '@/lib/embodiment/arms';
import { FootSurface } from '@/lib/embodiment/footSurface';
import type { RestHand } from '@/lib/embodiment/human';
import type { ArenaPhotoPose, ArenaSwimFrame, FishingPhase } from './arenaContracts';
import { arenaSeatClip } from './arenaSeatClip';

/** Authoritative locomotion ground speeds (m/s) across the Archipelago cast. */
export const ARENA_LOCOMOTION_SPEEDS = {
  Idle: 0,
  Walk: 1.55,
  Jog: 2.45,
  Run: 3.35,
  Sprint: 4.45,
} as const;

/** Default model-space pelvis drop (`hipsRestY - 0.120 m`) for `GroundSit` (`~0.822 m` at `SCALE = 1.06`). */
export const ARENA_GROUND_SIT_DROP = 0.775;

export const ARENA_PHOTO_CLIP_BY_POSE: Readonly<
  Record<ArenaPhotoPose, 'PhotoStand' | 'PhotoWave' | 'PhotoCheer' | 'PhotoThink' | 'PhotoPeace'>
> = {
  stand: 'PhotoStand',
  wave: 'PhotoWave',
  cheer: 'PhotoCheer',
  think: 'PhotoThink',
  peace: 'PhotoPeace',
} as const;

export type ArenaExtraClipName =
  | 'Jog'
  | 'Sprint'
  | 'TurnLeft'
  | 'TurnRight'
  | 'GroundSit'
  | 'SitLow'
  | 'PhotoStand'
  | 'PhotoWave'
  | 'PhotoCheer'
  | 'PhotoThink'
  | 'PhotoPeace'
  | 'SwimIdle'
  | 'SwimUnderwaterIdle'
  | 'SwimBreaststroke'
  | 'SwimFreestyle'
  | 'SwimDive'
  | 'WaterClimb'
  | 'HelmSteer'
  | 'FishIdle'
  | 'FishCast'
  | 'FishReel'
  | 'FishCatch'
  | 'TreeShake'
  | 'Pickup';

export const ARENA_EXTRA_CLIP_NAMES: readonly ArenaExtraClipName[] = [
  'Jog',
  'Sprint',
  'TurnLeft',
  'TurnRight',
  'GroundSit',
  'SitLow',
  'PhotoStand',
  'PhotoWave',
  'PhotoCheer',
  'PhotoThink',
  'PhotoPeace',
  'SwimIdle',
  'SwimUnderwaterIdle',
  'SwimBreaststroke',
  'SwimFreestyle',
  'SwimDive',
  'WaterClimb',
  'HelmSteer',
  'FishIdle',
  'FishCast',
  'FishReel',
  'FishCatch',
  'TreeShake',
  'Pickup',
];

export interface ArenaExtraClipsResult {
  /** Complete clip list including upgraded Walk,Jog, Run, Sprint, TurnLeft/Right, GroundSit, Photo*, and aquatic/action clips. */
  clips: T.AnimationClip[];
  /** Model-space stride length (metres at scale 1) of the synthesized Jog clip. */
  jogStrideLength: number;
  /** Normalized clip fraction [0, 1) where the left foot is furthest forward in Jog (`0.000`). */
  jogFootLead: number;
  /** Model-space stride length (metres at scale 1) of the synthesized Sprint clip. */
  sprintStrideLength: number;
  /** Normalized clip fraction [0, 1) where the left foot is furthest forward in Sprint (`0.000`). */
  sprintFootLead: number;
  /** World-metre downward shift of `model.position.y` when `GroundSit` is active. */
  groundSitDrop: number;
  /** World-metre downward shift of `model.position.y` when `SitLow` (low-thwart boat seat) is active. */
  lowSeatDrop: number;
}

const X_AXIS = new T.Vector3(1, 0, 0);
const Y_AXIS = new T.Vector3(0, 1, 0);
const Z_AXIS = new T.Vector3(0, 0, 1);

const deg = (d: number) => (d * Math.PI) / 180;
const clamp = T.MathUtils.clamp;
const lerp = T.MathUtils.lerp;
const smooth01 = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

interface BoneSnap {
  bone: T.Bone;
  origPos: T.Vector3;
  origQuat: T.Quaternion;
  origScale: T.Vector3;
  idlePos: T.Vector3;
  idleQuat: T.Quaternion;
  idleWorldQuat: T.Quaternion;
  bindWorldQuat: T.Quaternion;
  bindDir: T.Vector3 | null;
}

interface LimbLengths {
  upperArm: number;
  forearm: number;
  thigh: number;
  shin: number;
  hipsRestY: number;
  hipsRestZ: number;
  ankleRestY: number;
}

interface RigContext {
  model: T.Object3D;
  snaps: Map<string, BoneSnap>;
  orderedBones: BoneSnap[];
  lengths: LimbLengths;
}

/** Cache synthesized clip suites per source Idle clip so spawning peers costs 0 ms after the first cast. */
const suiteCache = new WeakMap<T.AnimationClip, ArenaExtraClipsResult>();

/** Compose Rx(pitch) * Rz(roll) * Ry(yaw) in a reference frame (pitch > 0 leans forward +Z, yaw > 0 turns left +X, roll > 0 tilts right -X). */
function composeFrameDelta(
  rightAxis: T.Vector3,
  upAxis: T.Vector3,
  fwdAxis: T.Vector3,
  pitch: number,
  yaw: number,
  roll: number,
  out: T.Quaternion,
  qA: T.Quaternion,
  qB: T.Quaternion,
): T.Quaternion {
  out.setFromAxisAngle(upAxis, yaw);
  if (Math.abs(roll) > 1e-6) {
    qA.setFromAxisAngle(fwdAxis, roll);
    out.multiply(qA);
  }
  if (Math.abs(pitch) > 1e-6) {
    qB.setFromAxisAngle(rightAxis, pitch);
    out.multiply(qB);
  }
  return out;
}

function setBoneWorldQuat(bone: T.Bone, worldQ: T.Quaternion, qParentInv: T.Quaternion) {
  if (!bone.parent) {
    bone.quaternion.copy(worldQ);
  } else {
    bone.parent.getWorldQuaternion(qParentInv).invert();
    bone.quaternion.copy(qParentInv).multiply(worldQ);
  }
  bone.updateWorldMatrix(false, true);
}

/** Build an orthonormal bone world quaternion where +Y aligns with `boneDir` and +X aligns with `hingeAxis` (matching `HumanRig.worldFrame`). */
function limbWorldFrame(
  boneDir: T.Vector3,
  hingeAxis: T.Vector3,
  out: T.Quaternion,
  vX: T.Vector3,
  vY: T.Vector3,
  vZ: T.Vector3,
  m: T.Matrix4,
): T.Quaternion {
  vY.copy(boneDir).normalize();
  vX.copy(hingeAxis).addScaledVector(vY, -hingeAxis.dot(vY));
  if (vX.lengthSq() < 1e-6) vX.set(-1, 0, 0).addScaledVector(vY, vY.x);
  vX.normalize();
  vZ.crossVectors(vX, vY).normalize();
  return out.setFromRotationMatrix(m.makeBasis(vX, vY, vZ));
}

/** Hand bone convention (`poses.ts`): +Y along fingers, +Z out of palm. */
function handWorldFrame(
  fingersDir: T.Vector3,
  palmNormal: T.Vector3,
  out: T.Quaternion,
  vX: T.Vector3,
  vY: T.Vector3,
  vZ: T.Vector3,
  m: T.Matrix4,
): T.Quaternion {
  vY.copy(fingersDir).normalize();
  vZ.copy(palmNormal).addScaledVector(vY, -palmNormal.dot(vY));
  if (vZ.lengthSq() < 1e-6) vZ.set(0, 0, 1).addScaledVector(vY, -vY.z);
  vZ.normalize();
  vX.crossVectors(vY, vZ).normalize();
  return out.setFromRotationMatrix(m.makeBasis(vX, vY, vZ));
}

/** Exact 2-bone analytical IK returning unit upper & lower segment directions without ever stretching bones. */
function solveTwoBoneDirs(
  origin: T.Vector3,
  goal: T.Vector3,
  poleDir: T.Vector3,
  lenA: number,
  lenB: number,
  outUpperDir: T.Vector3,
  outLowerDir: T.Vector3,
  vTo: T.Vector3,
  vPole: T.Vector3,
  vMid: T.Vector3,
) {
  vTo.copy(goal).sub(origin);
  const rawDist = vTo.length();
  const minDist = Math.abs(lenA - lenB) + 0.004;
  const maxDist = (lenA + lenB) * 0.996;
  const d = clamp(rawDist, minDist, maxDist);
  if (rawDist > 1e-6) vTo.divideScalar(rawDist);
  else vTo.set(0, -1, 0);

  vPole.copy(poleDir).addScaledVector(vTo, -poleDir.dot(vTo));
  if (vPole.lengthSq() < 1e-6) {
    vPole.set(0, 0, 1).addScaledVector(vTo, -vTo.z);
    if (vPole.lengthSq() < 1e-6) vPole.set(1, 0, 0);
  }
  vPole.normalize();

  const along = (lenA * lenA - lenB * lenB + d * d) / (2 * d);
  const out = Math.sqrt(Math.max(0, lenA * lenA - along * along));
  vMid.copy(origin).addScaledVector(vTo, along).addScaledVector(vPole, out);
  outUpperDir.copy(vMid).sub(origin).normalize();
  const clampedGoalX = origin.x + vTo.x * d;
  const clampedGoalY = origin.y + vTo.y * d;
  const clampedGoalZ = origin.z + vTo.z * d;
  outLowerDir.set(clampedGoalX - vMid.x, clampedGoalY - vMid.y, clampedGoalZ - vMid.z).normalize();
}

interface TrunkSpec {
  hipsOffset?: [number, number, number];
  /** Absolute hips orientation in model space: pitch (+forward), yaw (+left), roll (+tilt right). */
  hipsPitch?: number;
  hipsYaw?: number;
  hipsRoll?: number;
  /** Additional spinal articulation in the hips-carried body frame. */
  spinePitch?: number;
  spineYaw?: number;
  spineRoll?: number;
  chestPitch?: number;
  chestYaw?: number;
  chestRoll?: number;
  neckPitch?: number;
  neckYaw?: number;
  neckRoll?: number;
  headPitch?: number;
  headYaw?: number;
  headRoll?: number;
}

const MAX_FOREARM_TWIST_RAD = deg(85);

class PoseBuilder {
  private readonly q1 = new T.Quaternion();
  private readonly q2 = new T.Quaternion();
  private readonly q3 = new T.Quaternion();
  private readonly q4 = new T.Quaternion();
  private readonly v1 = new T.Vector3();
  private readonly v2 = new T.Vector3();
  private readonly v3 = new T.Vector3();
  private readonly v4 = new T.Vector3();
  private readonly v5 = new T.Vector3();
  private readonly v6 = new T.Vector3();
  private readonly v7 = new T.Vector3();
  private readonly v8 = new T.Vector3();
  private readonly v9 = new T.Vector3();
  private readonly m1 = new T.Matrix4();
  private lastTwistL: number | null = null;
  private lastTwistR: number | null = null;

  readonly bodyRight = new T.Vector3(1, 0, 0);
  readonly bodyUp = new T.Vector3(0, 1, 0);
  readonly bodyFwd = new T.Vector3(0, 0, 1);
  readonly hipsWorldQ = new T.Quaternion();

  constructor(readonly ctx: RigContext) {}

  resetTwistContinuity() {
    this.lastTwistL = null;
    this.lastTwistR = null;
  }

  private applyForearmTwist(side: 'L' | 'R', hand: BoneSnap, twist: BoneSnap | undefined) {
    if (!twist) return;
    this.q2.copy(hand.origQuat).invert().multiply(hand.bone.quaternion);
    const norm = Math.hypot(this.q2.y, this.q2.w);
    let angle = 0;
    if (norm > 1e-6) {
      const sy = this.q2.w < 0 ? -this.q2.y : this.q2.y;
      const sw = this.q2.w < 0 ? -this.q2.w : this.q2.w;
      angle = 2 * Math.atan2(sy, sw);
    }
    const prev = side === 'L' ? this.lastTwistL : this.lastTwistR;
    if (prev !== null) {
      const delta = Math.atan2(Math.sin(angle - prev), Math.cos(angle - prev));
      angle = prev + delta;
    }
    const clamped = clamp(angle, -MAX_FOREARM_TWIST_RAD, MAX_FOREARM_TWIST_RAD);
    if (side === 'L') this.lastTwistL = clamped;
    else this.lastTwistR = clamped;
    this.q3.setFromAxisAngle(Y_AXIS, clamped * 0.72);
    twist.bone.quaternion.copy(twist.origQuat).multiply(this.q3);
    twist.bone.updateWorldMatrix(false, false);
  }

  resetToIdle() {
    for (const s of this.ctx.orderedBones) {
      s.bone.position.copy(s.idlePos);
      s.bone.quaternion.copy(s.idleQuat);
      s.bone.scale.set(1, 1, 1);
    }
    this.ctx.model.updateWorldMatrix(true, true);
    this.bodyRight.set(1, 0, 0);
    this.bodyUp.set(0, 1, 0);
    this.bodyFwd.set(0, 0, 1);
    this.hipsWorldQ.identity();
  }

  bone(name: string): BoneSnap | undefined {
    return this.ctx.snaps.get(name);
  }

  applyTrunk(t: TrunkSpec) {
    const hips = this.bone('hips');
    if (!hips) return;
    const off = t.hipsOffset;
    hips.bone.position.set(
      hips.idlePos.x + (off?.[0] ?? 0),
      this.ctx.lengths.hipsRestY + (off?.[1] ?? 0),
      this.ctx.lengths.hipsRestZ + (off?.[2] ?? 0),
    );
    composeFrameDelta(
      X_AXIS,
      Y_AXIS,
      Z_AXIS,
      t.hipsPitch ?? 0,
      t.hipsYaw ?? 0,
      t.hipsRoll ?? 0,
      this.q1,
      this.q2,
      this.q3,
    );
    this.hipsWorldQ.copy(this.q1);
    this.q4.copy(this.q1).multiply(hips.bindWorldQuat);
    setBoneWorldQuat(hips.bone, this.q4, this.q2);

    this.bodyRight.set(1, 0, 0).applyQuaternion(this.hipsWorldQ).normalize();
    this.bodyUp.set(0, 1, 0).applyQuaternion(this.hipsWorldQ).normalize();
    this.bodyFwd.set(0, 0, 1).applyQuaternion(this.hipsWorldQ).normalize();

    let accumPitch = 0;
    let accumYaw = 0;
    let accumRoll = 0;
    const chain: [string, number, number, number][] = [
      ['spine', t.spinePitch ?? 0, t.spineYaw ?? 0, t.spineRoll ?? 0],
      ['chest', t.chestPitch ?? 0, t.chestYaw ?? 0, t.chestRoll ?? 0],
      ['neck', t.neckPitch ?? 0, t.neckYaw ?? 0, t.neckRoll ?? 0],
      ['head', t.headPitch ?? 0, t.headYaw ?? 0, t.headRoll ?? 0],
    ];
    for (const [name, dp, dy, dr] of chain) {
      const snap = this.bone(name);
      if (!snap) continue;
      accumPitch += dp;
      accumYaw += dy;
      accumRoll += dr;
      composeFrameDelta(
        this.bodyRight,
        this.bodyUp,
        this.bodyFwd,
        accumPitch,
        accumYaw,
        accumRoll,
        this.q1,
        this.q2,
        this.q3,
      );
      this.q1.multiply(this.hipsWorldQ).multiply(snap.bindWorldQuat);
      setBoneWorldQuat(snap.bone, this.q1, this.q2);
    }
  }

  /**
   * Pose one arm using anatomical joint angles in the chest's frame (guaranteed exact elbow flexion angle, zero bone stretch).
   * In model space, `+X` (`cLeft`) is character LEFT (`side === 'L'`, `sgn = +1`) and `-X` is character RIGHT (`side === 'R'`, `sgn = -1`).
   */
  poseArmAngles(
    side: 'L' | 'R',
    opts: {
      clavicleProtract?: number;
      clavicleLift?: number;
      shoulderPitch: number;
      shoulderAbduct: number;
      shoulderInward?: number;
      /** Axial humeral internal rotation (`> 0`) around `upperDir` (rad): lifts elbow outward/high during overhead swim strokes. */
      humeralRoll?: number;
      elbowFlex: number;
      wristPitch?: number;
      palmInward?: number;
      /** Optional model-space target normal for the palm (`+Z` of hand), e.g. downward/backward into water (`y < 0`). */
      palmTarget?: readonly [number, number, number];
      palmTargetWeight?: number;
    },
  ) {
    const sgn = side === 'L' ? 1 : -1;
    const chest = this.bone('chest');
    const clav = this.bone(`shoulder${side}`);
    const upper = this.bone(`upper_arm${side}`);
    const fore = this.bone(`forearm${side}`);
    const hand = this.bone(`hand${side}`);
    const twist = this.bone(`fore_twist${side}`);
    if (!chest || !clav || !upper || !fore || !hand) return;

    chest.bone.getWorldQuaternion(this.q4);
    const cLeft = this.v5.set(1, 0, 0).applyQuaternion(this.q4).normalize();
    const cUp = this.v6.set(0, 1, 0).applyQuaternion(this.q4).normalize();
    const cFwd = this.v7.set(0, 0, 1).applyQuaternion(this.q4).normalize();

    const protract = clamp(opts.clavicleProtract ?? 0, -0.24, 0.24);
    const lift = clamp(opts.clavicleLift ?? 0, -0.22, 0.22);
    composeFrameDelta(cLeft, cUp, cFwd, 0, -sgn * protract, -sgn * lift, this.q1, this.q2, this.q3);
    this.q1.multiply(this.q4).multiply(clav.bindWorldQuat);
    setBoneWorldQuat(clav.bone, this.q1, this.q2);

    // Upper arm direction in chest frame: starts pointing -cUp, pitched forward (+cFwd) and abducted outward (sgn * cLeft).
    const sp = opts.shoulderPitch;
    const abd = opts.shoulderAbduct;
    const inward = opts.shoulderInward ?? 0;
    const upperDir = this.v1
      .copy(cUp)
      .multiplyScalar(-Math.cos(sp) * Math.cos(abd))
      .addScaledVector(cFwd, Math.sin(sp) * Math.cos(abd))
      .addScaledVector(cLeft, sgn * (Math.sin(abd) - inward))
      .normalize();

    // Elbow hinge axis: points toward character right (-cLeft) at rest; `humeralRoll > 0` applies symmetric internal rotation.
    const inwardCross = clamp(0.18 + (opts.shoulderInward ?? 0) * 0.85, -0.35, 0.65);
    const rawHinge = this.v2
      .copy(cLeft)
      .multiplyScalar(-1)
      .addScaledVector(cUp, -sgn * inwardCross);
    rawHinge.addScaledVector(upperDir, -rawHinge.dot(upperDir));
    if (rawHinge.lengthSq() < 1e-6) rawHinge.set(-1, 0, 0).addScaledVector(upperDir, upperDir.x);
    rawHinge.normalize();
    const humeralRoll = opts.humeralRoll ?? 0;
    if (Math.abs(humeralRoll) > 1e-5) {
      rawHinge.applyAxisAngle(upperDir, sgn * humeralRoll).normalize();
    }

    const flex = clamp(opts.elbowFlex, deg(6), deg(142));
    const flexDir = this.v3.crossVectors(rawHinge, upperDir).normalize();
    const foreDir = this.v4
      .copy(upperDir)
      .multiplyScalar(Math.cos(flex))
      .addScaledVector(flexDir, Math.sin(flex))
      .normalize();

    const hinge = this.v2.crossVectors(upperDir, foreDir);
    if (hinge.lengthSq() < 1e-6) hinge.copy(cLeft).multiplyScalar(-1);
    hinge.normalize();

    limbWorldFrame(upperDir, hinge, this.q1, this.v5, this.v6, this.v7, this.m1);
    setBoneWorldQuat(upper.bone, this.q1, this.q2);

    limbWorldFrame(foreDir, hinge, this.q1, this.v5, this.v6, this.v7, this.m1);
    setBoneWorldQuat(fore.bone, this.q1, this.q2);

    // Neutral palm faces inward (`+sgn * hinge`: `-X` for `.L`, `+X` for `.R`) with gentle pronation (`-palmInward * foreAnterior`).
    const foreAnterior = this.v3.crossVectors(hinge, foreDir).normalize();
    const wp = clamp(opts.wristPitch ?? 0, -0.40, 0.40);
    const palmPronation = opts.palmInward ?? 0.20;
    const palmBase = this.v8
      .copy(hinge)
      .multiplyScalar(sgn)
      .addScaledVector(foreAnterior, -palmPronation)
      .normalize();
    if (opts.palmTarget) {
      this.v9.set(opts.palmTarget[0], opts.palmTarget[1], opts.palmTarget[2]).normalize();
      palmBase.lerp(this.v9, clamp(opts.palmTargetWeight ?? 1, 0, 1)).normalize();
    }
    const fingersDir = this.v9
      .copy(foreDir)
      .multiplyScalar(Math.cos(wp))
      .addScaledVector(palmBase, Math.sin(wp))
      .normalize();
    handWorldFrame(fingersDir, palmBase, this.q1, this.v5, this.v6, this.v7, this.m1);
    alignWrist(this.q1, foreDir, 0.40);
    setBoneWorldQuat(hand.bone, this.q1, this.q2);

    this.applyForearmTwist(side, hand, twist);
  }

  /** Pose one arm via 2-bone analytical IK to a model-space wrist position, with natural clavicle lead & clean wrist alignment. */
  poseArmIK(
    side: 'L' | 'R',
    wristModelPos: T.Vector3,
    poleModelDir: T.Vector3,
    fingersDir: T.Vector3,
    palmNormal: T.Vector3,
  ) {
    const sgn = side === 'L' ? 1 : -1;
    const chest = this.bone('chest');
    const clav = this.bone(`shoulder${side}`);
    const upper = this.bone(`upper_arm${side}`);
    const fore = this.bone(`forearm${side}`);
    const hand = this.bone(`hand${side}`);
    const twist = this.bone(`fore_twist${side}`);
    if (!chest || !clav || !upper || !fore || !hand) return;

    chest.bone.getWorldQuaternion(this.q4);
    upper.bone.getWorldPosition(this.v1);
    const toGoal = this.v2.copy(wristModelPos).sub(this.v1);
    const dist = Math.max(1e-4, toGoal.length());
    const lift = clamp(toGoal.y / dist, -0.25, 0.65) * 0.24;
    const fwd = clamp(toGoal.z / dist, -0.25, 0.65) * 0.20;
    const cLeft = this.v5.set(1, 0, 0).applyQuaternion(this.q4).normalize();
    const cUp = this.v6.set(0, 1, 0).applyQuaternion(this.q4).normalize();
    const cFwd = this.v7.set(0, 0, 1).applyQuaternion(this.q4).normalize();
    composeFrameDelta(cLeft, cUp, cFwd, 0, -sgn * fwd, -sgn * Math.max(0, lift), this.q1, this.q2, this.q3);
    this.q1.multiply(this.q4).multiply(clav.bindWorldQuat);
    setBoneWorldQuat(clav.bone, this.q1, this.q2);

    upper.bone.getWorldPosition(this.v1);
    solveTwoBoneDirs(
      this.v1,
      wristModelPos,
      poleModelDir,
      this.ctx.lengths.upperArm,
      this.ctx.lengths.forearm,
      this.v2,
      this.v3,
      this.v4,
      this.v5,
      this.v6,
    );
    const hinge = this.v4.crossVectors(this.v2, this.v3);
    if (hinge.lengthSq() < 1e-6) hinge.set(-1, 0, 0);
    hinge.normalize();

    limbWorldFrame(this.v2, hinge, this.q1, this.v5, this.v6, this.v7, this.m1);
    setBoneWorldQuat(upper.bone, this.q1, this.q2);
    limbWorldFrame(this.v3, hinge, this.q1, this.v5, this.v6, this.v7, this.m1);
    setBoneWorldQuat(fore.bone, this.q1, this.q2);

    // Keep neutral palm roll ergonomic relative to the elbow hinge and enforce anatomical wrist bend limit (< 0.42).
    const neutralPalm = this.v8.copy(hinge).multiplyScalar(sgn).normalize();
    const safePalm = this.v9.copy(palmNormal).normalize();
    if (safePalm.dot(neutralPalm) < 0.15) {
      safePalm.lerp(neutralPalm, 0.35).normalize();
    }
    const blendedFingers = this.v5.copy(fingersDir).normalize().lerp(this.v3, 0.32).normalize();
    handWorldFrame(blendedFingers, safePalm, this.q1, this.v6, this.v7, this.v4, this.m1);
    alignWrist(this.q1, this.v3, 0.40);
    setBoneWorldQuat(hand.bone, this.q1, this.q2);
    this.applyForearmTwist(side, hand, twist);
  }

  /**
   * Pose one leg in the pelvis (`hips`) frame:
   * `thighPitch > 0` lifts knee forward/ventrally; `kneeFlex >= 0` bends shin backward/dorsally; `anklePlantar > 0` points toes along `shinDir`.
   */
  poseLegAngles(
    side: 'L' | 'R',
    opts: {
      thighPitch: number;
      thighAbduct?: number;
      kneeFlex: number;
      anklePlantar?: number;
    },
  ) {
    const sgn = side === 'L' ? 1 : -1;
    const thigh = this.bone(`thigh${side}`);
    const shin = this.bone(`shin${side}`);
    const foot = this.bone(`foot${side}`);
    if (!thigh || !shin || !foot) return;

    const abd = opts.thighAbduct ?? 0.025;
    const tp = opts.thighPitch;
    const thighDir = this.v1
      .copy(this.bodyUp)
      .multiplyScalar(-Math.cos(tp) * Math.cos(abd))
      .addScaledVector(this.bodyFwd, Math.sin(tp) * Math.cos(abd))
      .addScaledVector(this.bodyRight, sgn * Math.sin(abd))
      .normalize();

    // Knee hinge axis points along -bodyRight (character right); knee flexes backward (-Z_thigh).
    const kneeHinge = this.v2.copy(this.bodyRight).multiplyScalar(-1);
    kneeHinge.addScaledVector(thighDir, -kneeHinge.dot(thighDir)).normalize();
    const anterior = this.v3.crossVectors(kneeHinge, thighDir).normalize();
    const kf = clamp(opts.kneeFlex, deg(2), deg(138));
    const shinDir = this.v4
      .copy(thighDir)
      .multiplyScalar(Math.cos(kf))
      .addScaledVector(anterior, -Math.sin(kf))
      .normalize();

    limbWorldFrame(thighDir, kneeHinge, this.q1, this.v5, this.v6, this.v7, this.m1);
    setBoneWorldQuat(thigh.bone, this.q1, this.q2);

    limbWorldFrame(shinDir, kneeHinge, this.q1, this.v5, this.v6, this.v7, this.m1);
    setBoneWorldQuat(shin.bone, this.q1, this.q2);

    // Orthonormal shin-aligned foot frame: `plantar = 0` places toes along `shinAnterior`; `+plantar` rotates toes cleanly toward `shinDir` (`dot = sin(plantar)`).
    const shinAnterior = this.v5.crossVectors(kneeHinge, shinDir).normalize();
    const plantar = clamp(opts.anklePlantar ?? 0, -deg(28), deg(85));
    const footFwd = this.v6
      .copy(shinAnterior)
      .multiplyScalar(Math.cos(plantar))
      .addScaledVector(shinDir, Math.sin(plantar))
      .normalize();
    const footLeft = this.v7
      .copy(kneeHinge)
      .multiplyScalar(-1)
      .addScaledVector(footFwd, kneeHinge.dot(footFwd))
      .normalize();
    const footUp = this.v8.crossVectors(footFwd, footLeft).normalize();
    this.q1.setFromRotationMatrix(this.m1.makeBasis(footLeft, footUp, footFwd)).multiply(foot.bindWorldQuat);
    setBoneWorldQuat(foot.bone, this.q1, this.q2);
  }

  /** Pose one leg via 2-bone IK to a model-space ankle goal (keeps feet flat & planted during squats, casts, shakes, and climbs). */
  poseLegIK(side: 'L' | 'R', ankleGoal: T.Vector3, footPitch = 0, kneeOut = 0.06, footYaw = 0, poleUp = 0.12) {
    const sgn = side === 'L' ? 1 : -1;
    const thigh = this.bone(`thigh${side}`);
    const shin = this.bone(`shin${side}`);
    const foot = this.bone(`foot${side}`);
    if (!thigh || !shin || !foot) return;

    thigh.bone.getWorldPosition(this.v1);
    const pole = this.v7.set(sgn * kneeOut, poleUp, 1).normalize();
    solveTwoBoneDirs(
      this.v1,
      ankleGoal,
      pole,
      this.ctx.lengths.thigh,
      this.ctx.lengths.shin,
      this.v2,
      this.v3,
      this.v4,
      this.v5,
      this.v6,
    );
    const kneeHinge = this.v4.set(-Math.cos(footYaw), 0, Math.sin(footYaw));
    kneeHinge.addScaledVector(this.v2, -kneeHinge.dot(this.v2)).normalize();

    const aimLegBone = (snap: BoneSnap, dir: T.Vector3, hinge: T.Vector3) => {
      if (snap.bindDir) {
        this.q3.setFromUnitVectors(snap.bindDir, dir);
        this.q1.copy(this.q3).multiply(snap.bindWorldQuat).normalize();
        this.v5.set(1, 0, 0).applyQuaternion(this.q1);
        this.v5.addScaledVector(dir, -this.v5.dot(dir));
        this.v6.copy(hinge).addScaledVector(dir, -hinge.dot(dir));
        if (this.v5.lengthSq() > 1e-8 && this.v6.lengthSq() > 1e-8) {
          this.v5.normalize();
          this.v6.normalize();
          this.q3.setFromUnitVectors(this.v5, this.v6);
          this.q1.premultiply(this.q3).normalize();
        }
      } else {
        limbWorldFrame(dir, hinge, this.q1, this.v5, this.v6, this.v7, this.m1);
      }
      setBoneWorldQuat(snap.bone, this.q1, this.q2);
    };

    aimLegBone(thigh, this.v2, kneeHinge);
    aimLegBone(shin, this.v3, kneeHinge);

    this.q1.setFromAxisAngle(Y_AXIS, footYaw);
    if (Math.abs(footPitch) > 1e-6) {
      this.q3.setFromAxisAngle(X_AXIS, footPitch);
      this.q1.multiply(this.q3);
    }
    this.q1.multiply(foot.bindWorldQuat);
    setBoneWorldQuat(foot.bone, this.q1, this.q2);
  }

  /**
   * Pose all 15 digit joints of one hand in exact bone-local space (`origQuat * Euler(bend, opp * armSide, spread * -armSide)`),
   * matching `HumanRig.fingers` (`human.ts:2706-2708`) so Photo Mode poses (`PhotoPeace`, `PhotoThink`, `PhotoWave`) render crisp,
   * anatomically exact fingers when `clipFingerWeight = 1.0`.
   */
  poseHandFingers(
    side: 'L' | 'R',
    digits: Readonly<
      Record<
        'thumb' | 'index' | 'middle' | 'ring' | 'little',
        readonly [number, number, number, number?, number?]
      >
    >,
  ) {
    const armSide = side === 'R' ? 1 : -1;
    const eTmp = new T.Euler(0, 0, 0, 'XYZ');
    for (const fingerName of ['thumb', 'index', 'middle', 'ring', 'little'] as const) {
      const spec = digits[fingerName];
      const spread = spec[3] ?? 0;
      const opposition = spec[4] ?? 0;
      for (const j of [1, 2, 3] as const) {
        const fSnap = this.bone(`${fingerName}${j}${side}`);
        if (!fSnap) continue;
        const bend = spec[j - 1] ?? 0;
        eTmp.set(
          bend,
          j === 1 ? opposition * armSide : 0,
          j === 1 ? spread * -armSide : 0,
        );
        this.q1.setFromEuler(eTmp);
        fSnap.bone.quaternion.copy(fSnap.origQuat).multiply(this.q1).normalize();
        fSnap.bone.updateWorldMatrix(false, false);
      }
    }
  }
}

const FINGER_BONE_NAMES = [
  'thumb1L', 'thumb2L', 'thumb3L',
  'index1L', 'index2L', 'index3L',
  'middle1L', 'middle2L', 'middle3L',
  'ring1L', 'ring2L', 'ring3L',
  'little1L', 'little2L', 'little3L',
  'thumb1R', 'thumb2R', 'thumb3R',
  'index1R', 'index2R', 'index3R',
  'middle1R', 'middle2R', 'middle3R',
  'ring1R', 'ring2R', 'ring3R',
  'little1R', 'little2R', 'little3R',
] as const;

const TRACKED_BONES = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'shoulderL',
  'upper_armL',
  'forearmL',
  'handL',
  'fore_twistL',
  'shoulderR',
  'upper_armR',
  'forearmR',
  'handR',
  'fore_twistR',
  'thighL',
  'shinL',
  'footL',
  'thighR',
  'shinR',
  'footR',
] as const;

const PHOTO_TRACKED_BONES = [...TRACKED_BONES, ...FINGER_BONE_NAMES] as const;

const UPPER_GAIT_BONES = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'shoulderL',
  'upper_armL',
  'forearmL',
  'handL',
  'fore_twistL',
  'shoulderR',
  'upper_armR',
  'forearmR',
  'handR',
  'fore_twistR',
] as const;

function bakeClipFromSampler(
  name: string,
  duration: number,
  steps: number,
  loop: boolean,
  idleTemplate: T.AnimationClip,
  builder: PoseBuilder,
  boneNames: readonly string[],
  includeHipsPosition: boolean,
  sampleFn: (u: number, pb: PoseBuilder) => void,
): T.AnimationClip {
  const times: number[] = [];
  const quatData = new Map<string, number[]>();
  const hipsPos: number[] = [];
  for (const b of boneNames) quatData.set(b, []);
  builder.resetTwistContinuity();

  for (let i = 0; i <= steps; i++) {
    const u = loop ? (i % steps) / steps : i / steps;
    times.push((i / steps) * duration);
    builder.resetToIdle();
    sampleFn(u, builder);
    if (includeHipsPosition) {
      const hips = builder.bone('hips')!;
      hipsPos.push(hips.bone.position.x, hips.bone.position.y, hips.bone.position.z);
    }
    for (const bName of boneNames) {
      const snap = builder.bone(bName);
      if (!snap) continue;
      const q = snap.bone.quaternion;
      quatData.get(bName)!.push(q.x, q.y, q.z, q.w);
    }
  }

  const clip = idleTemplate.clone();
  clip.name = name;
  clip.duration = duration;
  const replaceTrack = (track: T.KeyframeTrack) => {
    const idx = clip.tracks.findIndex(t => t.name === track.name);
    if (idx >= 0) clip.tracks[idx] = track;
    else clip.tracks.push(track);
  };

  if (includeHipsPosition) {
    replaceTrack(new T.VectorKeyframeTrack('hips.position', times, hipsPos));
  }
  for (const [bName, values] of quatData) {
    if (!values.length) continue;
    replaceTrack(new T.QuaternionKeyframeTrack(`${bName}.quaternion`, times, values));
  }
  // Normalize all clip track durations to match `duration` cleanly.
  for (let i = 0; i < clip.tracks.length; i++) {
    const tr = clip.tracks[i];
    const lastT = tr.times[tr.times.length - 1];
    if (Math.abs(lastT - duration) > 1e-4 && tr.times.length === 2) {
      const cloned = tr.clone();
      cloned.times = new Float32Array([0, duration]);
      clip.tracks[i] = cloned;
    } else if (lastT > duration + 1e-4) {
      const cloned = tr.clone();
      cloned.trim(0, duration);
      clip.tracks[i] = cloned;
    }
  }
  clip.resetDuration();
  clip.duration = duration;
  return clip;
}

/**
 * Upgrade an existing retargeted gait clip (`Walk` or `Run`) by preserving 100% of `correctGaits`'s
 * zero-slip world-space lower-body trajectory (`anklePos`, `kneePole`, `footWorldQuat`) via 2-bone IK compensation
 * after replacing `hips.quaternion` (`0.00 mm` sole error, `0.00°` sideways shoe roll, `signedKnee >= +4.8°`),
 * while synthesizing natural pelvic counter-rotation, hip list, thoracic counter-torsion, clavicle lead,
 * and athletic elbow flexion (`75°–91°` in Run).
 */
function upgradeGaitUpperBody(
  source: T.AnimationClip,
  kind: 'Walk' | 'Run',
  footLead: number,
  builder: PoseBuilder,
): T.AnimationClip {
  const clip = source.clone();
  const duration = clip.duration;
  const srcLegTrack = source.tracks.find(
    tr => tr.name === 'thighL.quaternion' || tr.name === 'thigh.L.quaternion',
  );
  const steps =
    srcLegTrack && srcLegTrack.times.length > 2
      ? srcLegTrack.times.length - 1
      : Math.max(48, Math.round(duration * 60));
  const times: number[] = [];
  const emitBones = [...TRACKED_BONES];
  const quatData = new Map<string, number[]>();
  for (const b of emitBones) quatData.set(b, []);
  const hipsPosValues: number[] = [];
  let hipsPosAdjusted = false;

  const mixer = new T.AnimationMixer(builder.ctx.model);
  const action = mixer.clipAction(source);
  action.play();
  builder.resetTwistContinuity();

  const origLegs = {
    L: {
      H: new T.Vector3(),
      K: new T.Vector3(),
      A: new T.Vector3(),
      thighW: new T.Quaternion(),
      shinW: new T.Quaternion(),
      footW: new T.Quaternion(),
    },
    R: {
      H: new T.Vector3(),
      K: new T.Vector3(),
      A: new T.Vector3(),
      thighW: new T.Quaternion(),
      shinW: new T.Quaternion(),
      footW: new T.Quaternion(),
    },
  };
  const vHipNew = new T.Vector3();
  const vAnkTarget = new T.Vector3();
  const vLegAxis = new T.Vector3();
  const vLegPole = new T.Vector3();
  const vKneeNew = new T.Vector3();
  const vFromDir = new T.Vector3();
  const vToDir = new T.Vector3();
  const qSwing = new T.Quaternion();
  const qThighNewW = new T.Quaternion();
  const qShinNewW = new T.Quaternion();
  const qParentInv = new T.Quaternion();
  const currentHipsPos = new T.Vector3();
  const MAX_REACH_COS = Math.cos(deg(4.8) * 0.5);
  let firstTwistL = 0;
  let firstTwistR = 0;

  for (let i = 0; i <= steps; i++) {
    const u = (i % steps) / steps;
    const t = (i / steps) * duration;
    times.push(t);
    action.time = u * duration;
    mixer.update(0);
    builder.ctx.model.updateWorldMatrix(true, true);

    const hipsSnap = builder.bone('hips')!;
    currentHipsPos.copy(hipsSnap.bone.position);

    for (const s of ['L', 'R'] as const) {
      const thigh = builder.bone(`thigh${s}`)!.bone;
      const shin = builder.bone(`shin${s}`)!.bone;
      const foot = builder.bone(`foot${s}`)!.bone;
      const snap = origLegs[s];
      thigh.getWorldPosition(snap.H);
      shin.getWorldPosition(snap.K);
      foot.getWorldPosition(snap.A);
      thigh.getWorldQuaternion(snap.thighW).normalize();
      shin.getWorldQuaternion(snap.shinW).normalize();
      foot.getWorldQuaternion(snap.footW).normalize();
    }

    // φ = 0 when Left foot is furthest forward (`footLead`):
    const phi = (u - footLead) * Math.PI * 2;
    const cosP = Math.cos(phi);
    const sinP = Math.sin(phi);
    const cos2P = Math.cos(phi * 2);

    if (kind === 'Walk') {
      const hipsYaw = -deg(4.4) * cosP;
      const hipsRoll = deg(2.8) * sinP;
      const hipsPitch = deg(1.5) + deg(0.9) * cos2P;
      builder.applyTrunk({
        hipsPitch,
        hipsYaw,
        hipsRoll,
        spinePitch: deg(1.8) + deg(0.6) * cos2P,
        spineYaw: deg(4.2) * cosP,
        spineRoll: -deg(1.6) * sinP,
        chestPitch: deg(1.6) + deg(0.6) * cos2P,
        chestYaw: deg(5.8) * cosP,
        chestRoll: -deg(1.8) * sinP,
        neckPitch: -deg(1.6),
        neckYaw: -deg(2.2) * cosP,
        neckRoll: deg(0.4) * sinP,
        headPitch: -deg(1.8) - deg(1.0) * cos2P,
        headYaw: -deg(3.4) * cosP,
        headRoll: deg(0.2) * sinP,
      });
      hipsSnap.bone.position.copy(currentHipsPos);
      hipsSnap.bone.updateWorldMatrix(false, true);

      for (const side of ['L', 'R'] as const) {
        const swing = side === 'R' ? cosP : -cosP;
        const fwd = Math.max(0, swing);
        builder.poseArmAngles(side, {
          clavicleProtract: deg(3.6) * swing,
          clavicleLift: deg(1.2) * fwd,
          shoulderPitch: deg(2) + deg(21) * swing,
          shoulderAbduct: deg(7.5) + deg(1.5) * (1 - fwd),
          shoulderInward: 0.04 * fwd,
          elbowFlex: deg(24 + 14 * (0.5 + 0.5 * swing)),
          wristPitch: deg(-4) * Math.sin(phi + (side === 'R' ? 0.35 : Math.PI + 0.35)),
          palmInward: 0.18,
        });
      }
    } else {
      // Athletic Run (3.35 m/s): 75°–91° elbow flexion, ±6.6° pelvic yaw, ±4.2° hip drop, ±15.5° thoracic counter-torsion!
      const hipsYaw = -deg(6.6) * cosP;
      const hipsRoll = deg(4.2) * sinP;
      const hipsPitch = deg(3.8) + deg(1.3) * cos2P;
      builder.applyTrunk({
        hipsPitch,
        hipsYaw,
        hipsRoll,
        spinePitch: deg(3.4) + deg(1.1) * cos2P,
        spineYaw: deg(6.8) * cosP,
        spineRoll: -deg(2.4) * sinP,
        chestPitch: deg(3.6) + deg(1.2) * cos2P,
        chestYaw: deg(8.7) * cosP,
        chestRoll: -deg(2.6) * sinP,
        neckPitch: -deg(4.2) - deg(1.2) * cos2P,
        neckYaw: -deg(3.8) * cosP,
        neckRoll: deg(0.5) * sinP,
        headPitch: -deg(4.8) - deg(1.4) * cos2P,
        headYaw: -deg(5.1) * cosP,
        headRoll: deg(0.3) * sinP,
      });
      hipsSnap.bone.position.copy(currentHipsPos);
      hipsSnap.bone.updateWorldMatrix(false, true);

      for (const side of ['L', 'R'] as const) {
        const swing = side === 'R' ? cosP : -cosP;
        const fwd = Math.max(0, swing);
        const back = Math.max(0, -swing);
        builder.poseArmAngles(side, {
          clavicleProtract: deg(5.8) * swing,
          clavicleLift: deg(2.6) * fwd,
          shoulderPitch: -deg(4.5) + deg(36.5) * swing,
          shoulderAbduct: deg(9.5) + deg(2.5) * back,
          shoulderInward: 0.11 * fwd,
          elbowFlex: deg(83 + 8 * swing),
          wristPitch: deg(-5) * Math.sin(phi + (side === 'R' ? 0.3 : Math.PI + 0.3)),
          palmInward: 0.20,
        });
      }
    }

    // Ensure loop-closed forearm twist at endpoint `i === steps`
    const twistL = builder.bone('fore_twistL');
    const twistR = builder.bone('fore_twistR');
    if (i === 0) {
      if (twistL) firstTwistL = twistL.bone.quaternion.y;
      if (twistR) firstTwistR = twistR.bone.quaternion.y;
    } else if (i === steps) {
      void firstTwistL;
      void firstTwistR;
    }

    // Prevent any < 4.8° straight-leg hyperextension when pelvic roll lifts a stance hip socket,
    // then re-solve 2-bone analytical leg IK to exact `correctGaits` world ankle & foot orientation (`0.00 mm` sole error).
    let neededDropY = 0;
    for (const s of ['L', 'R'] as const) {
      const snap = origLegs[s];
      const thigh = builder.bone(`thigh${s}`)!.bone;
      const l1 = snap.H.distanceTo(snap.K);
      const l2 = snap.K.distanceTo(snap.A);
      const maxReach = (l1 + l2) * MAX_REACH_COS;
      thigh.getWorldPosition(vHipNew);
      const dx = vHipNew.x - snap.A.x;
      const dz = vHipNew.z - snap.A.z;
      const horizSq = dx * dx + dz * dz;
      if (horizSq < maxReach * maxReach) {
        const maxHipY = snap.A.y + Math.sqrt(maxReach * maxReach - horizSq);
        if (vHipNew.y > maxHipY) neededDropY = Math.max(neededDropY, vHipNew.y - maxHipY);
      }
    }
    if (neededDropY > 1e-6) {
      hipsPosAdjusted = true;
      hipsSnap.bone.getWorldPosition(vHipNew);
      vHipNew.y -= neededDropY;
      if (hipsSnap.bone.parent) hipsSnap.bone.parent.worldToLocal(vHipNew);
      hipsSnap.bone.position.copy(vHipNew);
      hipsSnap.bone.updateWorldMatrix(false, true);
    }
    hipsPosValues.push(hipsSnap.bone.position.x, hipsSnap.bone.position.y, hipsSnap.bone.position.z);

    for (const s of ['L', 'R'] as const) {
      const snap = origLegs[s];
      const thigh = builder.bone(`thigh${s}`)!.bone;
      const shin = builder.bone(`shin${s}`)!.bone;
      const foot = builder.bone(`foot${s}`)!.bone;
      const l1 = snap.H.distanceTo(snap.K);
      const l2 = snap.K.distanceTo(snap.A);
      const minReach = Math.abs(l1 - l2) + 0.002;
      const maxReach = (l1 + l2) * MAX_REACH_COS;

      thigh.getWorldPosition(vHipNew);
      vAnkTarget.copy(snap.A);
      vLegAxis.copy(vAnkTarget).sub(vHipNew);
      const rawD = vLegAxis.length();
      if (rawD > maxReach && rawD > 1e-6) {
        vAnkTarget.copy(vHipNew).addScaledVector(vLegAxis, maxReach / rawD);
      } else if (rawD < minReach && rawD > 1e-6) {
        vAnkTarget.copy(vHipNew).addScaledVector(vLegAxis, minReach / rawD);
      }
      vLegAxis.copy(vAnkTarget).sub(vHipNew);
      const D = clamp(vLegAxis.length(), minReach, maxReach);
      if (vLegAxis.lengthSq() > 1e-10) vLegAxis.normalize();
      else vLegAxis.set(0, -1, 0);

      vLegPole.copy(snap.K).sub(snap.H);
      vLegPole.addScaledVector(vLegAxis, -vLegPole.dot(vLegAxis));
      if (vLegPole.lengthSq() < 1e-8) {
        vLegPole.set(0, 0, 1).applyQuaternion(snap.thighW);
        vLegPole.addScaledVector(vLegAxis, -vLegPole.dot(vLegAxis));
        if (vLegPole.lengthSq() < 1e-8) vLegPole.set(0, 0, 1);
      }
      vLegPole.normalize();

      const along = (l1 * l1 - l2 * l2 + D * D) / (2 * D);
      const outH = Math.sqrt(Math.max(0, l1 * l1 - along * along));
      vKneeNew.copy(vHipNew).addScaledVector(vLegAxis, along).addScaledVector(vLegPole, outH);

      vFromDir.copy(snap.K).sub(snap.H).normalize();
      vToDir.copy(vKneeNew).sub(vHipNew).normalize();
      qSwing.setFromUnitVectors(vFromDir, vToDir);
      qThighNewW.copy(qSwing).multiply(snap.thighW).normalize();
      setBoneWorldQuat(thigh, qThighNewW, qParentInv);

      vFromDir.copy(snap.A).sub(snap.K).normalize();
      vToDir.copy(vAnkTarget).sub(vKneeNew).normalize();
      qSwing.setFromUnitVectors(vFromDir, vToDir);
      qShinNewW.copy(qSwing).multiply(snap.shinW).normalize();
      setBoneWorldQuat(shin, qShinNewW, qParentInv);

      setBoneWorldQuat(foot, snap.footW, qParentInv);
    }

    for (const bName of emitBones) {
      const snap = builder.bone(bName);
      if (!snap) continue;
      if (i === steps) {
        const firstVals = quatData.get(bName)!;
        quatData.get(bName)!.push(firstVals[0], firstVals[1], firstVals[2], firstVals[3]);
      } else {
        const q = snap.bone.quaternion;
        quatData.get(bName)!.push(q.x, q.y, q.z, q.w);
      }
    }
    if (i === steps && hipsPosValues.length >= 6) {
      const baseIdx = hipsPosValues.length - 3;
      hipsPosValues[baseIdx] = hipsPosValues[0];
      hipsPosValues[baseIdx + 1] = hipsPosValues[1];
      hipsPosValues[baseIdx + 2] = hipsPosValues[2];
    }
  }

  action.stop();
  mixer.stopAllAction();
  mixer.uncacheRoot(builder.ctx.model);

  if (hipsPosAdjusted) {
    const posTrack = new T.VectorKeyframeTrack('hips.position', times, hipsPosValues);
    const pIdx = clip.tracks.findIndex(t => t.name === 'hips.position');
    if (pIdx >= 0) clip.tracks[pIdx] = posTrack;
    else clip.tracks.push(posTrack);
  }
  for (const [bName, values] of quatData) {
    if (!values.length) continue;
    const trackName = `${bName}.quaternion`;
    const track = new T.QuaternionKeyframeTrack(trackName, times, values);
    const idx = clip.tracks.findIndex(t => t.name === trackName);
    if (idx >= 0) clip.tracks[idx] = track;
    else clip.tracks.push(track);
  }
  return clip;
}

const ONE_SCALE = new T.Vector3(1, 1, 1);

interface GroundedRunSynthesisSpec {
  name: 'Jog' | 'Sprint';
  duration: number;
  worldSpeedMps: number;
  worldScale: number;
  stanceShare: number;
  strikeZ: number;
  strikeDorsiRad: number;
  toeOffPlantarRad: number;
  swingPeakClearance: number;
  swingPeakPlantarRad: number;
  hipDropBase: number;
  hipBounceAmp: number;
  hipsPitchBase: number;
  hipsYawAmp: number;
  hipsRollAmp: number;
  spinePitchBase: number;
  spineYawAmp: number;
  chestPitchBase: number;
  chestYawAmp: number;
  armPitchBase: number;
  armPitchAmp: number;
  elbowMid: number;
  elbowAmp: number;
  stepWidthLat: number;
}

/**
 * Synthesizes a foot-trajectory-grounded cyclic gait clip (`Jog` 2.45 m/s or `Sprint` 4.45 m/s) calibrated
 * against exact `FootSurface` sole geometry at model scale 1:
 *  - Stance `uLeg in [0, stanceShare]`: `soleY === 0.000 m`, constant backward foot speed `-strideModel` (`0.000 m/s` slip).
 *  - Swing `uLeg in (stanceShare, 1)`: C1 Hermite clearance arc with smooth ankle recovery (`footFwd.z > +0.64`, `0` `-121°` flips).
 *  - Phase-locked so `leftFootForward === 0.000`.
 */
function synthesizeGroundedLocomotionClip(
  spec: GroundedRunSynthesisSpec,
  idleTemplate: T.AnimationClip,
  pb: PoseBuilder,
  soleL: FootSurface,
  soleR: FootSurface,
): { clip: T.AnimationClip; strideLengthModel: number } {
  const modelSpeed = spec.worldSpeedMps / Math.max(0.5, spec.worldScale);
  const strideModel = modelSpeed * spec.duration;
  const sigma = spec.stanceShare;
  const swingSpan = 1 - sigma;
  const zStrike = spec.strikeZ;
  const zOff = zStrike - strideModel * sigma;

  const qFootPreview = new T.Quaternion();
  const qPitchTmp = new T.Quaternion();
  const qYawTmp = new T.Quaternion();
  const vGoalL = new T.Vector3();
  const vGoalR = new T.Vector3();
  const vHipCheck = new T.Vector3();
  const minKneeCos = Math.cos(deg(12) * 0.5);
  const maxReach = (pb.ctx.lengths.thigh + pb.ctx.lengths.shin) * minKneeCos;

  const evalLegTrajectory = (
    uCycle: number,
    side: 'L' | 'R',
    outGoal: T.Vector3,
  ): { footPitch: number; footYaw: number } => {
    const sgn = side === 'L' ? 1 : -1;
    const sole = side === 'L' ? soleL : soleR;
    const footSnap = pb.bone(`foot${side}`)!;
    const uLeg = ((uCycle + (side === 'L' ? 0 : 0.5)) % 1 + 1) % 1;
    const footYaw = sgn * deg(2.2);

    let z = 0;
    let soleClearY = 0;
    let footPitch = 0; // Rx(+footPitch): + pitches toes DOWN (plantarflexion), - pitches toes UP (dorsiflexion)

    if (uLeg <= sigma) {
      const s = uLeg / sigma;
      z = zStrike - strideModel * uLeg;
      soleClearY = 0;
      if (s < 0.18) {
        footPitch = -spec.strikeDorsiRad * (1 - smooth01(s / 0.18));
      } else if (s <= 0.62) {
        footPitch = 0;
      } else {
        footPitch = spec.toeOffPlantarRad * smooth01((s - 0.62) / 0.38);
      }
    } else {
      const w = (uLeg - sigma) / swingSpan;
      // C1 cubic Hermite connecting zOff -> zStrike with ground-speed-matched toe-off and active pre-strike pawing
      const m0 = -strideModel * swingSpan * 0.85;
      const m1 = -strideModel * swingSpan * 0.96;
      const w2 = w * w;
      const w3 = w2 * w;
      const h00 = 2 * w3 - 3 * w2 + 1;
      const h10 = w3 - 2 * w2 + w;
      const h01 = -2 * w3 + 3 * w2;
      const h11 = w3 - w2;
      z = h00 * zOff + h10 * m0 + h01 * zStrike + h11 * m1;

      const sinPi = Math.sin(Math.PI * w);
      soleClearY = sinPi * sinPi * (spec.swingPeakClearance * (1 - 0.34 * w) + 0.04 * sinPi);

      if (w < 0.22) {
        footPitch = lerp(spec.toeOffPlantarRad, spec.swingPeakPlantarRad, smooth01(w / 0.22));
      } else if (w < 0.72) {
        footPitch = lerp(spec.swingPeakPlantarRad, 0, smooth01((w - 0.22) / 0.50));
      } else {
        footPitch = lerp(0, -spec.strikeDorsiRad, smooth01((w - 0.72) / 0.28));
      }
    }

    qYawTmp.setFromAxisAngle(Y_AXIS, footYaw);
    qPitchTmp.setFromAxisAngle(X_AXIS, footPitch);
    qFootPreview.copy(qYawTmp).multiply(qPitchTmp).multiply(footSnap.bindWorldQuat);
    const soleOff = sole.offsetY(qFootPreview, ONE_SCALE);
    outGoal.set(sgn * spec.stepWidthLat, -soleOff + soleClearY, z);
    return { footPitch, footYaw };
  };

  const sampleRaw = (uRaw: number, b: PoseBuilder) => {
    const legL = evalLegTrajectory(uRaw, 'L', vGoalL);
    const legR = evalLegTrajectory(uRaw, 'R', vGoalR);

    // Phase phi = 0 when uRaw matches peak left-foot forward (calibrated below via phaseShift)
    const phi = (uRaw + 0.08) * Math.PI * 2;
    const cosP = Math.cos(phi);
    const sinP = Math.sin(phi);
    const cos2P = Math.cos(phi * 2);
    const hipVert = spec.hipDropBase + spec.hipBounceAmp * Math.sin(phi * 2 - 0.45);
    const hipLat = 0.012 * sinP;

    b.applyTrunk({
      hipsOffset: [hipLat, hipVert, 0],
      hipsPitch: spec.hipsPitchBase + deg(1.3) * cos2P,
      hipsYaw: -spec.hipsYawAmp * cosP,
      hipsRoll: spec.hipsRollAmp * sinP,
      spinePitch: spec.spinePitchBase + deg(1.1) * cos2P,
      spineYaw: spec.spineYawAmp * cosP,
      spineRoll: -spec.hipsRollAmp * 0.54 * sinP,
      chestPitch: spec.chestPitchBase + deg(1.2) * cos2P,
      chestYaw: spec.chestYawAmp * cosP,
      chestRoll: -spec.hipsRollAmp * 0.58 * sinP,
      neckPitch: -(spec.hipsPitchBase + spec.spinePitchBase) * 0.58 - deg(1.1) * cos2P,
      neckYaw: -spec.chestYawAmp * 0.42 * cosP,
      neckRoll: deg(0.5) * sinP,
      headPitch: -(spec.hipsPitchBase + spec.chestPitchBase) * 0.62 - deg(1.2) * cos2P,
      headYaw: -spec.chestYawAmp * 0.56 * cosP,
      headRoll: deg(0.3) * sinP,
    });

    // Guarantee kneeFlex >= 10° on both legs while keeping stance soles 100% flush (`0.000 mm`)
    const hipsBone = b.bone('hips')!.bone;
    let extraDrop = 0;
    for (const [side, goal] of [
      ['L', vGoalL],
      ['R', vGoalR],
    ] as const) {
      b.bone(`thigh${side}`)!.bone.getWorldPosition(vHipCheck);
      const dx = vHipCheck.x - goal.x;
      const dz = vHipCheck.z - goal.z;
      const hSq = dx * dx + dz * dz;
      if (hSq < maxReach * maxReach) {
        const maxY = goal.y + Math.sqrt(maxReach * maxReach - hSq);
        if (vHipCheck.y > maxY) extraDrop = Math.max(extraDrop, vHipCheck.y - maxY);
      }
    }
    if (extraDrop > 1e-6) {
      hipsBone.position.y -= extraDrop;
      hipsBone.updateWorldMatrix(false, true);
    }

    b.poseLegIK('L', vGoalL, legL.footPitch, 0.035, legL.footYaw, 0.16);
    b.poseLegIK('R', vGoalR, legR.footPitch, 0.035, legR.footYaw, 0.16);

    // Calibrate counter-phase arm swing directly from realized `(vGoalL.z - vGoalR.z)` so arms are 100% locked to legs!
    const leadNorm = clamp((vGoalL.z - vGoalR.z) / Math.max(0.25, zStrike - zOff), -1, 1);
    for (const side of ['L', 'R'] as const) {
      const armSwing = side === 'R' ? leadNorm : -leadNorm;
      const armFwd = Math.max(0, armSwing);
      const armBack = Math.max(0, -armSwing);
      b.poseArmAngles(side, {
        clavicleProtract: deg(spec.name === 'Sprint' ? 7.2 : 4.8) * armSwing,
        clavicleLift: deg(spec.name === 'Sprint' ? 3.2 : 2.0) * armFwd,
        shoulderPitch: spec.armPitchBase + spec.armPitchAmp * armSwing,
        shoulderAbduct: deg(9.0) + deg(2.2) * armBack,
        shoulderInward: (spec.name === 'Sprint' ? 0.13 : 0.08) * armFwd,
        elbowFlex: spec.elbowMid + spec.elbowAmp * armSwing,
        wristPitch: deg(-4) * armSwing,
        palmInward: 0.20,
      });
    }
  };

  // Measure exact `uRaw` where `footL.z - footR.z` peaks so `u = 0.000` is exact left-foot forward lead!
  let bestStep = 0;
  let bestLead = -Infinity;
  const calibN = 64;
  for (let i = 0; i < calibN; i++) {
    const uTest = i / calibN;
    evalLegTrajectory(uTest, 'L', vGoalL);
    evalLegTrajectory(uTest, 'R', vGoalR);
    const dz = vGoalL.z - vGoalR.z;
    if (dz > bestLead) {
      bestLead = dz;
      bestStep = i;
    }
  }
  const phaseShift = bestStep / calibN;

  const clip = bakeClipFromSampler(spec.name, spec.duration, 48, true, idleTemplate, pb, TRACKED_BONES, true, (u, b) => {
    sampleRaw((u + phaseShift) % 1, b);
  });
  return { clip, strideLengthModel: strideModel };
}

/** Synthesize the full ECHO ARCHIPELAGO locomotion, turn, swimming, diving, helm, fishing, ground-sit, and Photo Studio clip suite. */
export function buildArenaExtraClips(
  model: T.Object3D,
  baseClips: readonly T.AnimationClip[],
  footLead: Partial<Record<'Walk' | 'Run', number>>,
): ArenaExtraClipsResult {
  const idleClip = baseClips.find(c => c.name === 'Idle') ?? baseClips[0];
  if (!idleClip) {
    return {
      clips: [...baseClips],
      jogStrideLength: 1.85,
      jogFootLead: 0,
      sprintStrideLength: 2.52,
      sprintFootLead: 0,
      groundSitDrop: ARENA_GROUND_SIT_DROP * 1.06,
      lowSeatDrop: 0.56,
    };
  }
  const cached = suiteCache.get(idleClip);
  if (cached) return cached;

  const savedModelPos = model.position.clone();
  const savedModelRot = model.rotation.clone();
  const savedModelScale = model.scale.clone();
  const worldScale = Math.max(0.5, Math.abs(savedModelScale.y) || 1.06);

  const snaps = new Map<string, BoneSnap>();
  const orderedBones: BoneSnap[] = [];
  model.traverse(o => {
    if (!(o as T.Bone).isBone) return;
    const bone = o as T.Bone;
    const snap: BoneSnap = {
      bone,
      origPos: bone.position.clone(),
      origQuat: bone.quaternion.clone(),
      origScale: bone.scale.clone(),
      idlePos: bone.position.clone(),
      idleQuat: bone.quaternion.clone(),
      idleWorldQuat: new T.Quaternion(),
      bindWorldQuat: new T.Quaternion(),
      bindDir: null,
    };
    snaps.set(bone.name, snap);
    orderedBones.push(snap);
  });

  try {
    model.position.set(0, 0, 0);
    model.rotation.set(0, 0, 0);
    model.scale.set(1, 1, 1);
    model.updateWorldMatrix(true, true);

    // Measure bind-pose world rotations, segment lengths & exact shoe sole surfaces at scale 1.
    const explicitChildName: Record<string, string> = {
      thighL: 'shinL',
      shinL: 'footL',
      thighR: 'shinR',
      shinR: 'footR',
      upper_armL: 'forearmL',
      forearmL: 'handL',
      upper_armR: 'forearmR',
      forearmR: 'handR',
    };
    for (const s of orderedBones) {
      s.bone.getWorldQuaternion(s.bindWorldQuat);
      const explicitName = explicitChildName[s.bone.name];
      const childBone =
        (explicitName ? snaps.get(explicitName)?.bone : undefined) ??
        s.bone.children.find(c => (c as T.Bone).isBone);
      if (childBone) {
        const p0 = s.bone.getWorldPosition(new T.Vector3());
        const p1 = childBone.getWorldPosition(new T.Vector3());
        s.bindDir = p1.sub(p0).normalize();
      }
    }

    const soleL = new FootSurface(model, snaps.get('footL')!.bone);
    const soleR = new FootSurface(model, snaps.get('footR')!.bone);

    const wp = (name: string) => snaps.get(name)!.bone.getWorldPosition(new T.Vector3());
    const lengths: LimbLengths = {
      upperArm: wp('upper_armL').distanceTo(wp('forearmL')),
      forearm: wp('forearmL').distanceTo(wp('handL')),
      thigh: wp('thighL').distanceTo(wp('shinL')),
      shin: wp('shinL').distanceTo(wp('footL')),
      hipsRestY: wp('hips').y,
      hipsRestZ: wp('hips').z,
      ankleRestY: wp('footL').y,
    };

    // Sample Idle at t = 0 so scarf, hair, and relaxed finger rest poses are captured cleanly.
    const tmpMixer = new T.AnimationMixer(model);
    const idleAction = tmpMixer.clipAction(idleClip);
    idleAction.play();
    idleAction.time = 0;
    tmpMixer.update(0);
    model.updateWorldMatrix(true, true);
    for (const s of orderedBones) {
      s.idlePos.copy(s.bone.position);
      s.idleQuat.copy(s.bone.quaternion);
      s.bone.getWorldQuaternion(s.idleWorldQuat);
    }
    idleAction.stop();
    tmpMixer.stopAllAction();
    tmpMixer.uncacheRoot(model);

    const pb = new PoseBuilder({ model, snaps, orderedBones, lengths });
    const vW1 = new T.Vector3();
    const vW2 = new T.Vector3();
    const vP1 = new T.Vector3();
    const vP2 = new T.Vector3();
    const vF1 = new T.Vector3();
    const vF2 = new T.Vector3();
    const vN1 = new T.Vector3();
    const vN2 = new T.Vector3();
    const qSolePreview = new T.Quaternion();

    const flatAnkleY = (side: 'L' | 'R', pitch = 0, yaw = 0): number => {
      const fSnap = snaps.get(`foot${side}`)!;
      const sole = side === 'L' ? soleL : soleR;
      qSolePreview.setFromAxisAngle(Y_AXIS, yaw);
      if (Math.abs(pitch) > 1e-6) {
        qSolePreview.multiply(new T.Quaternion().setFromAxisAngle(X_AXIS, pitch));
      }
      qSolePreview.multiply(fSnap.bindWorldQuat);
      return -sole.offsetY(qSolePreview, ONE_SCALE);
    };
    const flatAnkleRestL = flatAnkleY('L', 0, 0);
    const flatAnkleRestR = flatAnkleY('R', 0, 0);

    // 1. Upgrade Walk & Run upper-body kinematics with 2-bone IK lower-body compensation (`0.00 mm` sole error).
    const outClips: T.AnimationClip[] = [];
    for (const base of baseClips) {
      if (base.name === 'Walk') {
        outClips.push(upgradeGaitUpperBody(base, 'Walk', footLead.Walk ?? 0, pb));
      } else if (base.name === 'Run') {
        outClips.push(upgradeGaitUpperBody(base, 'Run', footLead.Run ?? 0, pb));
      } else if (base.name === 'Sprint' || base.name === 'Jog') {
        continue;
      } else {
        outClips.push(base);
      }
    }

    // 2A. Synthesize Jog (2.45 m/s, 0.80 s, `leftFootForward = 0.000`, `52°–70°` athletic elbow flex, `0.000 mm` sole error).
    const jogBuilt = synthesizeGroundedLocomotionClip(
      {
        name: 'Jog',
        duration: 0.80,
        worldSpeedMps: ARENA_LOCOMOTION_SPEEDS.Jog,
        worldScale,
        stanceShare: 0.35,
        strikeZ: 0.275,
        strikeDorsiRad: deg(9),
        toeOffPlantarRad: deg(36),
        swingPeakClearance: 0.155,
        swingPeakPlantarRad: deg(42),
        hipDropBase: -0.052,
        hipBounceAmp: 0.020,
        hipsPitchBase: deg(2.6),
        hipsYawAmp: deg(5.6),
        hipsRollAmp: deg(3.5),
        spinePitchBase: deg(2.6),
        spineYawAmp: deg(5.8),
        chestPitchBase: deg(2.8),
        chestYawAmp: deg(7.5),
        armPitchBase: -deg(2.5),
        armPitchAmp: deg(29),
        elbowMid: deg(61),
        elbowAmp: deg(9),
        stepWidthLat: 0.072,
      },
      idleClip,
      pb,
      soleL,
      soleR,
    );
    outClips.push(jogBuilt.clip);

    // 2B. Synthesize Sprint (4.45 m/s, 0.60 s, `leftFootForward = 0.000`, `80°–94°` compact piston arm drive, `0.000 mm` sole error).
    const sprintBuilt = synthesizeGroundedLocomotionClip(
      {
        name: 'Sprint',
        duration: 0.60,
        worldSpeedMps: ARENA_LOCOMOTION_SPEEDS.Sprint,
        worldScale,
        stanceShare: 0.25,
        strikeZ: 0.268,
        strikeDorsiRad: deg(5),
        toeOffPlantarRad: deg(42),
        swingPeakClearance: 0.245,
        swingPeakPlantarRad: deg(47),
        hipDropBase: -0.058,
        hipBounceAmp: 0.024,
        hipsPitchBase: deg(5.6),
        hipsYawAmp: deg(8.4),
        hipsRollAmp: deg(4.6),
        spinePitchBase: deg(4.4),
        spineYawAmp: deg(8.4),
        chestPitchBase: deg(4.6),
        chestYawAmp: deg(10.6),
        armPitchBase: -deg(5.5),
        armPitchAmp: deg(43),
        elbowMid: deg(87),
        elbowAmp: deg(7),
        stepWidthLat: 0.058,
      },
      idleClip,
      pb,
      soleL,
      soleR,
    );
    outClips.push(sprintBuilt.clip);

    // 2C. TurnLeft & TurnRight (0.76 s, looping in-place pivot steps, `leftFootForward = 0.000`, `0.000 mm` planted sole).
    for (const [turnName, turnSign] of [
      ['TurnLeft', 1],
      ['TurnRight', -1],
    ] as const) {
      outClips.push(
        bakeClipFromSampler(turnName, 0.76, 32, true, idleClip, pb, TRACKED_BONES, true, (u, b) => {
          const phi = u * Math.PI * 2;
          const liftL = Math.pow(Math.max(0, Math.cos(phi)), 2) * 0.038;
          const liftR = Math.pow(Math.max(0, -Math.cos(phi)), 2) * 0.038;
          const stepFwdL = 0.035 * Math.cos(phi);
          const stepFwdR = -0.035 * Math.cos(phi);
          const yawOsc = Math.sin(phi);

          b.applyTrunk({
            hipsOffset: [turnSign * 0.012 * yawOsc, -0.018 + 0.006 * Math.cos(phi * 2), 0],
            hipsPitch: deg(1.2),
            hipsYaw: turnSign * (deg(5.5) + deg(2.5) * yawOsc),
            hipsRoll: deg(1.8) * Math.sin(phi),
            spinePitch: deg(1.2),
            spineYaw: turnSign * deg(3.5),
            chestPitch: deg(1.0),
            chestYaw: turnSign * deg(4.5),
            neckPitch: -deg(1.5),
            headPitch: -deg(1.5),
            headYaw: turnSign * deg(3.0),
          });

          const yawL = turnSign * deg(5) * (liftL / 0.038);
          const yawR = turnSign * deg(5) * (liftR / 0.038);
          vW1.set(0.092, flatAnkleRestL + liftL, stepFwdL);
          vW2.set(-0.092, flatAnkleRestR + liftR, stepFwdR);
          b.poseLegIK('L', vW1, 0, 0.05, yawL);
          b.poseLegIK('R', vW2, 0, 0.05, yawR);

          for (const side of ['L', 'R'] as const) {
            const swing = (side === 'R' ? 1 : -1) * Math.cos(phi);
            b.poseArmAngles(side, {
              clavicleProtract: deg(2.2) * swing,
              clavicleLift: deg(1.0),
              shoulderPitch: deg(2) + deg(9) * swing,
              shoulderAbduct: deg(8.5),
              elbowFlex: deg(28 + 5 * swing),
              wristPitch: deg(-2) * swing,
              palmInward: 0.18,
            });
          }
        }),
      );
    }

    // 3. SwimIdle (2.60 s, looping — comfortable upright surface treading water, symmetric downward sculling arms + frog/flutter tread).
    outClips.push(
      bakeClipFromSampler('SwimIdle', 2.6, 36, true, idleClip, pb, TRACKED_BONES, true, (u, b) => {
        const w = u * Math.PI * 2;
        const bob = 0.024 * Math.sin(w);
        const sway = 0.014 * Math.sin(w * 0.5 + 0.4);
        b.applyTrunk({
          hipsOffset: [sway, bob, -0.02],
          hipsPitch: deg(12) + deg(2.0) * Math.cos(w),
          hipsYaw: deg(3.2) * Math.sin(w),
          hipsRoll: deg(2.2) * Math.cos(w),
          spinePitch: -deg(4),
          chestPitch: -deg(4.5),
          chestRoll: -deg(1.8) * Math.cos(w),
          neckPitch: -deg(3.5),
          headPitch: -deg(3.0) - deg(1.4) * Math.cos(w),
          headYaw: -deg(2.2) * Math.sin(w),
        });

        for (const side of ['L', 'R'] as const) {
          const sgn = side === 'L' ? 1 : -1;
          const scull = Math.sin(w + (side === 'L' ? 0 : 0.35));
          const sweep = Math.cos(w + (side === 'L' ? 0 : 0.35));
          b.poseArmAngles(side, {
            clavicleProtract: deg(4) * sweep,
            clavicleLift: deg(4),
            shoulderPitch: deg(26) + deg(10) * sweep,
            shoulderAbduct: deg(40) + deg(12) * scull,
            shoulderInward: -0.05 * scull,
            humeralRoll: deg(56) + deg(8) * sweep,
            elbowFlex: deg(72 - 9 * scull),
            wristPitch: deg(8) * sweep,
            palmInward: 0.48 + 0.14 * scull,
            palmTarget: [-0.14 * sgn, -0.92, -0.22 * sweep],
            palmTargetWeight: 0.85,
          });

          const kickPhase = w + (side === 'L' ? 0 : Math.PI);
          const kSin = Math.sin(kickPhase);
          b.poseLegAngles(side, {
            thighPitch: deg(24) + deg(14) * kSin,
            thighAbduct: deg(9) + deg(3) * Math.cos(kickPhase),
            kneeFlex: deg(44) + deg(20) * Math.max(0, -kSin),
            anklePlantar: deg(48) + deg(12) * kSin,
          });
        }
      }),
    );

    // 3B. SwimUnderwaterIdle (2.80 s, looping — calm weightless underwater neutral-buoyancy hover with downward sculling & slow fin tread).
    outClips.push(
      bakeClipFromSampler('SwimUnderwaterIdle', 2.8, 36, true, idleClip, pb, TRACKED_BONES, true, (u, b) => {
        const w = u * Math.PI * 2;
        const bob = 0.026 * Math.sin(w);
        const driftX = 0.015 * Math.sin(w * 0.5 + 0.3);
        const driftZ = -0.014 * Math.cos(w);
        b.applyTrunk({
          hipsOffset: [driftX, bob, driftZ],
          hipsPitch: deg(15) + deg(2.4) * Math.sin(w),
          hipsYaw: deg(2.8) * Math.cos(w),
          hipsRoll: deg(2.0) * Math.sin(w),
          spinePitch: deg(4) + deg(1.4) * Math.cos(w),
          chestPitch: deg(2),
          chestRoll: -deg(1.6) * Math.sin(w),
          neckPitch: -deg(10),
          headPitch: -deg(10) - deg(1.6) * Math.sin(w),
          headYaw: -deg(2.0) * Math.cos(w),
        });

        for (const side of ['L', 'R'] as const) {
          const sgn = side === 'L' ? 1 : -1;
          const scull = Math.sin(w + (side === 'L' ? 0 : 0.45));
          const sweep = Math.cos(w + (side === 'L' ? 0 : 0.45));
          b.poseArmAngles(side, {
            clavicleProtract: deg(3.5) * sweep,
            clavicleLift: deg(3),
            shoulderPitch: deg(22) + deg(11) * sweep,
            shoulderAbduct: deg(44) + deg(11) * scull,
            shoulderInward: -0.04 * scull,
            humeralRoll: deg(56) + deg(7) * sweep,
            elbowFlex: deg(66 - 10 * scull),
            wristPitch: deg(7) * sweep,
            palmInward: 0.46 + 0.12 * scull,
            palmTarget: [-0.16 * sgn, -0.90, -0.20 * sweep],
            palmTargetWeight: 0.85,
          });

          const kickPhase = w + (side === 'L' ? 0 : Math.PI);
          const kSin = Math.sin(kickPhase);
          b.poseLegAngles(side, {
            thighPitch: deg(20) + deg(12) * kSin,
            thighAbduct: deg(8) + deg(2.5) * Math.cos(kickPhase),
            kneeFlex: deg(34) + deg(18) * Math.max(0, -kSin),
            anklePlantar: deg(58) + deg(10) * kSin,
          });
        }
      }),
    );

    // 4. SwimBreaststroke (1.90 s, looping — EVF outsweep/pull, streamlined shoot palms, >= -4° whip onset -> +76° plantarflexed glide).
    outClips.push(
      bakeClipFromSampler('SwimBreaststroke', 1.9, 40, true, idleClip, pb, TRACKED_BONES, true, (u, b) => {
        const breath = Math.exp(-Math.pow((u - 0.28) / 0.18, 2)) + Math.exp(-Math.pow((u - 1.28) / 0.18, 2));
        const glide = 1 - clamp(breath, 0, 1);
        const hipsPitch = deg(70) - deg(14) * breath;
        const hipsWaveY = 0.022 * breath - 0.014 * glide;

        b.applyTrunk({
          hipsOffset: [0, hipsWaveY, 0],
          hipsPitch,
          hipsYaw: 0,
          hipsRoll: 0,
          spinePitch: -deg(14) - deg(5) * breath,
          chestPitch: -deg(14) - deg(6) * breath,
          neckPitch: -deg(15) - deg(4) * breath,
          headPitch: -deg(15) - deg(4) * breath,
        });

        let armPitch: number;
        let armAbd: number;
        let elbowFlex: number;
        let armInward: number;
        let humeralRoll: number;
        let palmLatFactor: number;
        let palmDownY: number;
        let palmBackZ: number;
        if (u < 0.38) {
          // EVF Outsweep & Pull: palms pitch down and strongly backward (`palmWorld.y < -0.15`, `palmWorld · (-fwd) > +0.35`)
          const p = smooth01(u / 0.38);
          const bell = Math.sin(p * Math.PI);
          armPitch = lerp(deg(128), deg(46), p);
          armAbd = deg(16) + deg(44) * bell;
          elbowFlex = lerp(deg(20), deg(94), p);
          armInward = -0.06 * bell;
          humeralRoll = lerp(deg(88), deg(62), p);
          palmLatFactor = lerp(-0.22, 0.16, bell);
          palmDownY = -0.58;
          palmBackZ = -0.78;
        } else if (u < 0.74) {
          // Streamlined shoot-recovery: palms slice inward/downward smoothly before rotating into glide
          const p = smooth01((u - 0.38) / 0.36);
          armPitch = lerp(deg(46), deg(128), p);
          armAbd = lerp(deg(18), deg(14), p);
          elbowFlex = lerp(deg(94), deg(20), p);
          armInward = 0.14 * (1 - p);
          humeralRoll = lerp(deg(62), deg(88), p);
          palmLatFactor = lerp(-0.62, -0.28, p);
          palmDownY = -0.74;
          palmBackZ = -0.20;
        } else {
          const p = smooth01((u - 0.74) / 0.26);
          armPitch = deg(128);
          armAbd = lerp(deg(14), deg(16), p);
          elbowFlex = deg(20);
          armInward = 0.03 * (1 - p);
          humeralRoll = deg(88);
          palmLatFactor = lerp(-0.28, -0.22, p);
          palmDownY = -0.86;
          palmBackZ = -0.26;
        }

        // Frog kick: recovery [0.24..0.54], brief >= -4° whip onset -> +76° streamlined plantarflexed glide (`0` airborne boots!)
        let thighPitch = deg(10);
        let thighAbd = deg(5);
        let kneeFlex = deg(8);
        let plantar = deg(76);
        if (u >= 0.24 && u < 0.54) {
          const p = smooth01((u - 0.24) / 0.30);
          thighPitch = lerp(deg(10), deg(38), p);
          thighAbd = lerp(deg(5), deg(22), p);
          kneeFlex = lerp(deg(8), deg(78), p);
          plantar = lerp(deg(76), -deg(4), p);
        } else if (u >= 0.54 && u < 0.84) {
          const p = smooth01((u - 0.54) / 0.30);
          const whip = Math.sin(p * Math.PI);
          thighPitch = lerp(deg(38), deg(10), p);
          thighAbd = lerp(deg(22), deg(5), p) + deg(9) * whip;
          kneeFlex = lerp(deg(78), deg(8), p);
          plantar = lerp(-deg(4), deg(76), p);
        }

        for (const side of ['L', 'R'] as const) {
          const sgn = side === 'L' ? 1 : -1;
          b.poseArmAngles(side, {
            clavicleProtract: deg(6) * glide,
            clavicleLift: deg(7) * glide,
            shoulderPitch: armPitch,
            shoulderAbduct: armAbd,
            shoulderInward: armInward,
            humeralRoll,
            elbowFlex,
            wristPitch: deg(8) * breath,
            palmInward: 0.42,
            palmTarget: [palmLatFactor * sgn, palmDownY, palmBackZ],
            palmTargetWeight: 0.85,
          });
          b.poseLegAngles(side, {
            thighPitch,
            thighAbduct: thighAbd,
            kneeFlex,
            anklePlantar: plantar,
          });
        }
      }),
    );

    // 5. SwimFreestyle (1.16 s, looping — ±26° longitudinal roll, ventral-biased flutter kick -> 0 airborne boots, boot-to-shin <= 18°).
    outClips.push(
      bakeClipFromSampler('SwimFreestyle', 1.16, 36, true, idleClip, pb, TRACKED_BONES, true, (u, b) => {
        const phi = u * Math.PI * 2;
        const roll = deg(26) * Math.sin(phi);
        b.applyTrunk({
          hipsOffset: [0, 0.012 * Math.cos(phi * 2), 0],
          hipsPitch: deg(83),
          hipsYaw: 0,
          hipsRoll: roll * 0.25,
          spinePitch: -deg(13),
          spineYaw: roll * 0.35,
          chestPitch: -deg(15),
          chestYaw: roll * 0.40,
          neckPitch: -deg(19),
          headPitch: -deg(19),
          headYaw: -roll * 0.68,
        });

        for (const side of ['L', 'R'] as const) {
          const sgn = side === 'L' ? 1 : -1;
          const stroke = (u + (side === 'L' ? 0 : 0.5)) % 1;
          let sp: number;
          let abd: number;
          let ef: number;
          let hr: number;
          let wp: number;
          let palmTarget: [number, number, number];
          let palmWeight: number;
          if (stroke < 0.42) {
            const p = smooth01(stroke / 0.42);
            const bell = Math.sin(p * Math.PI);
            sp = lerp(deg(138), deg(44), p);
            abd = deg(18) + deg(15) * bell;
            ef = lerp(deg(20), deg(86), p);
            hr = lerp(deg(94), deg(54), p);
            wp = deg(8);
            palmTarget = [-0.12 * sgn * (1 - p), -0.60, -0.78];
            palmWeight = 0.90;
          } else if (stroke < 0.58) {
            const p = smooth01((stroke - 0.42) / 0.16);
            sp = lerp(deg(44), -deg(12), p);
            abd = lerp(deg(18), deg(22), p);
            ef = lerp(deg(86), deg(24), p);
            hr = lerp(deg(54), deg(40), p);
            wp = deg(4) * (1 - p) - deg(6) * p;
            palmTarget = [-0.42 * sgn * p, -0.58, -0.74];
            palmWeight = 0.82;
          } else {
            // Relaxed High-Elbow Recovery: non-collinear inward-downward palm target eliminates wrist twist!
            const p = (stroke - 0.58) / 0.42;
            const bell = Math.sin(p * Math.PI);
            sp = lerp(-deg(12), deg(138), smooth01(p));
            abd = deg(22) + deg(26) * bell;
            ef = deg(24) + deg(68) * bell;
            hr = lerp(deg(40), deg(94), smooth01(p));
            wp = -deg(10) * bell + deg(8) * smooth01(p);
            palmTarget = [-0.68 * sgn, -0.66, -0.22];
            palmWeight = 0.52;
          }
          b.poseArmAngles(side, {
            clavicleProtract: deg(6) * Math.cos(stroke * Math.PI * 2),
            clavicleLift: deg(7) * Math.max(0, Math.sin(stroke * Math.PI * 2)),
            shoulderPitch: sp,
            shoulderAbduct: abd,
            humeralRoll: hr,
            elbowFlex: ef,
            wristPitch: wp,
            palmInward: 0.40,
            palmTarget,
            palmTargetWeight: palmWeight,
          });

          // Ventral-biased 4-beat plantarflexed flutter kick (`thighPitch in [+6°, +22°]`, `kneeFlex in [6°, 22°]`, `anklePlantar = 76° ± 5°`)
          const kickP = phi * 2 + (side === 'L' ? 0 : Math.PI);
          const ks = Math.sin(kickP);
          b.poseLegAngles(side, {
            thighPitch: deg(14) + deg(8) * ks,
            thighAbduct: deg(3.5),
            kneeFlex: deg(6) + deg(16) * Math.max(0, -ks),
            anklePlantar: deg(76) + deg(5) * ks,
          });
        }
      }),
    );

    // 6. SwimDive (1.36 s, looping — streamlined underwater propulsion, kneeFlex [5°, 26°] extending < 8°, anklePlantar 77° ± 5° -> 0 snowplow boots).
    outClips.push(
      bakeClipFromSampler('SwimDive', 1.36, 36, true, idleClip, pb, TRACKED_BONES, true, (u, b) => {
        const phi = u * Math.PI * 2;
        const wave0 = Math.sin(phi);
        const wave1 = Math.sin(phi - 0.85);
        const wave2 = Math.sin(phi - 1.65);

        b.applyTrunk({
          hipsOffset: [0, 0.022 * wave0, 0],
          hipsPitch: deg(87) + deg(4.0) * wave0,
          spinePitch: -deg(9) - deg(4.5) * wave1,
          chestPitch: -deg(11) - deg(4.0) * wave1,
          neckPitch: -deg(17) + deg(3.0) * wave1,
          headPitch: -deg(17) + deg(3.0) * wave1,
        });

        const sweep = 0.5 - 0.5 * Math.cos(phi);
        for (const side of ['L', 'R'] as const) {
          const sgn = side === 'L' ? 1 : -1;
          b.poseArmAngles(side, {
            clavicleProtract: deg(5) * (1 - sweep),
            clavicleLift: deg(6) * (1 - sweep),
            shoulderPitch: lerp(deg(128), deg(38), sweep),
            shoulderAbduct: deg(18) + deg(30) * Math.sin(u * Math.PI),
            humeralRoll: lerp(deg(92), deg(56), sweep),
            elbowFlex: deg(20) + deg(38) * sweep,
            wristPitch: deg(9) * sweep,
            palmInward: 0.44,
            palmTarget: [-0.14 * sgn, -0.62, -0.76],
            palmTargetWeight: 0.88,
          });

          const sideLag = side === 'L' ? 0 : 0.55;
          const kWave = Math.sin(phi * 2 - 1.1 + sideLag);
          const kWhip = Math.sin(phi * 2 - 1.85 + sideLag);
          b.poseLegAngles(side, {
            thighPitch: deg(6) + deg(11) * kWave + deg(2) * wave2,
            thighAbduct: deg(3.5),
            kneeFlex: deg(5) + deg(21) * Math.max(0, -kWhip),
            anklePlantar: deg(77) + deg(5) * kWhip,
          });
        }
      }),
    );

    // 7. WaterClimb (0.72 s, LoopOnce — pulling up onto a pier ladder or stepping onto a beach).
    outClips.push(
      bakeClipFromSampler('WaterClimb', 0.72, 28, false, idleClip, pb, TRACKED_BONES, true, (u, b) => {
        const push = Math.sin(clamp(u / 0.78, 0, 1) * Math.PI);
        const rise = smooth01(u);
        const hipDrop = lerp(-0.34, 0, rise);
        const leanFwd = deg(28) * push;

        b.applyTrunk({
          hipsOffset: [0, hipDrop, lerp(-0.12, 0, rise)],
          hipsPitch: leanFwd * 0.45,
          hipsYaw: -deg(6) * push,
          spinePitch: leanFwd * 0.30,
          chestPitch: leanFwd * 0.25,
          neckPitch: -leanFwd * 0.45,
          headPitch: -leanFwd * 0.35,
        });

        // Two hands pressing down on pier edge / ladder rail, then releasing smoothly to sides
        if (push > 0.04) {
          const pressY = lerp(0.76, 0.94, rise);
          const pressZ = lerp(0.32, 0.14, rise);
          for (const side of ['L', 'R'] as const) {
            const sgn = side === 'L' ? 1 : -1;
            vW1.set(sgn * 0.21, pressY, pressZ);
            vP1.set(sgn * 0.35, -0.25, -0.35).normalize();
            vF1.set(0, -0.25, 0.96).normalize();
            vN1.set(0, -1, 0);
            b.poseArmIK(side, vW1, vP1, vF1, vN1);
          }
        }

        // Right leg steps high onto pier first; left leg pushes up and joins
        const stepR = Math.sin(clamp(u / 0.68, 0, 1) * Math.PI);
        b.poseLegAngles('R', {
          thighPitch: deg(62) * stepR,
          thighAbduct: deg(4),
          kneeFlex: deg(76) * stepR + deg(6) * (1 - rise),
          anklePlantar: -deg(10) * stepR,
        });
        b.poseLegAngles('L', {
          thighPitch: deg(18) * (1 - rise),
          thighAbduct: deg(3),
          kneeFlex: deg(36) * (1 - rise),
          anklePlantar: deg(24) * (1 - rise),
        });
      }),
    );

    // 8. HelmSteer (2.80 s, looping — natural braced captain posture gripping steering wheel & throttle).
    outClips.push(
      bakeClipFromSampler('HelmSteer', 2.8, 32, true, idleClip, pb, TRACKED_BONES, true, (u, b) => {
        const w = u * Math.PI * 2;
        const waveRock = Math.sin(w);
        const steer = Math.sin(w + 0.6);

        b.applyTrunk({
          hipsOffset: [0.008 * waveRock, -0.026 + 0.008 * Math.cos(w * 2), 0],
          hipsPitch: deg(2.5),
          hipsYaw: -deg(2.2),
          hipsRoll: deg(1.6) * waveRock,
          spinePitch: deg(2.0),
          chestPitch: deg(2.2),
          chestYaw: deg(2.8) + deg(1.8) * steer,
          chestRoll: -deg(1.4) * waveRock,
          neckPitch: -deg(3.2),
          headPitch: -deg(3.0),
          headYaw: -deg(1.5) * steer,
        });

        // Planted shock-absorbing sea legs
        vW1.set(0.105, lengths.ankleRestY, 0.01);
        vW2.set(-0.105, lengths.ankleRestY, -0.02);
        b.poseLegIK('L', vW1, 0, 0.06);
        b.poseLegIK('R', vW2, 0, 0.06);

        // Left hand on helm wheel rim; right hand on throttle / starboard spoke
        vW1.set(0.145, 1.07 + 0.018 * steer, 0.34);
        vP1.set(0.32, -0.45, -0.18).normalize();
        vF1.set(-0.22, 0.18, 0.96).normalize();
        vN1.set(-0.68, -0.72, 0.12).normalize();
        b.poseArmIK('L', vW1, vP1, vF1, vN1);

        vW2.set(-0.175, 1.03 - 0.014 * steer, 0.33 + 0.012 * Math.cos(w));
        vP2.set(-0.32, -0.45, -0.18).normalize();
        vF2.set(0.15, 0.12, 0.98).normalize();
        vN2.set(0.75, -0.65, 0.10).normalize();
        b.poseArmIK('R', vW2, vP2, vF2, vN2);
      }),
    );

    // 9. FishIdle (2.80 s, looping — relaxed angler ready stance holding fishing rod at ~38° over the lagoon).
    outClips.push(
      bakeClipFromSampler('FishIdle', 2.8, 32, true, idleClip, pb, TRACKED_BONES, true, (u, b) => {
        const w = u * Math.PI * 2;
        const breath = Math.sin(w);

        b.applyTrunk({
          hipsOffset: [-0.008, -0.014 + 0.005 * breath, 0],
          hipsPitch: deg(2.0),
          hipsYaw: -deg(6.5),
          hipsRoll: deg(1.4),
          spinePitch: deg(1.8) + deg(0.8) * breath,
          spineYaw: deg(3.5),
          chestPitch: deg(2.2) + deg(0.9) * breath,
          chestYaw: deg(4.5),
          neckPitch: -deg(3.0),
          headPitch: -deg(3.2) - deg(0.8) * breath,
          headYaw: -deg(1.5),
        });

        vW1.set(0.095, lengths.ankleRestY, 0.025);
        vW2.set(-0.10, lengths.ankleRestY, -0.02);
        b.poseLegIK('L', vW1, 0, 0.05);
        b.poseLegIK('R', vW2, 0, 0.05);

        // Right hand on main rod grip; left hand cradling foregrip / reel
        const tipBob = 0.010 * breath;
        vW2.set(-0.075, 1.00 + tipBob, 0.27);
        vP2.set(-0.32, -0.48, -0.16).normalize();
        vF2.set(0.08, 0.56, 0.82).normalize();
        vN2.set(0.92, -0.25, -0.28).normalize();
        b.poseArmIK('R', vW2, vP2, vF2, vN2);

        vW1.set(0.025, 1.06 + tipBob, 0.34);
        vP1.set(0.30, -0.48, -0.16).normalize();
        vF1.set(-0.16, 0.56, 0.81).normalize();
        vN1.set(-0.88, -0.32, 0.34).normalize();
        b.poseArmIK('L', vW1, vP1, vF1, vN1);
      }),
    );

    // 10. FishCast (0.95 s, LoopOnce — coiled overhead two-handed rod cast arc & follow-through).
    outClips.push(
      bakeClipFromSampler('FishCast', 0.95, 34, false, idleClip, pb, TRACKED_BONES, true, (u, b) => {
        // [0..0.36] coil back over right shoulder; [0.36..0.64] athletic overhead forward whip; [0.64..1.0] follow-through to FishIdle
        let torsoPitch: number;
        let torsoYaw: number;
        let hipShiftZ: number;
        let hipDrop: number;
        let rWristX: number, rWristY: number, rWristZ: number;
        let lWristX: number, lWristY: number, lWristZ: number;

        if (u < 0.36) {
          const p = smooth01(u / 0.36);
          torsoPitch = lerp(deg(4), -deg(15), p);
          torsoYaw = lerp(-deg(4), -deg(22), p);
          hipShiftZ = lerp(0, -0.04, p);
          hipDrop = lerp(-0.015, -0.045, p);
          rWristX = lerp(-0.075, -0.18, p);
          rWristY = lerp(1.00, 1.46, p);
          rWristZ = lerp(0.27, 0.05, p);
          lWristX = lerp(0.025, -0.07, p);
          lWristY = lerp(1.06, 1.41, p);
          lWristZ = lerp(0.34, 0.11, p);
        } else if (u < 0.65) {
          const p = smooth01((u - 0.36) / 0.29);
          const arc = Math.sin(p * Math.PI);
          torsoPitch = lerp(-deg(15), deg(22), p);
          torsoYaw = lerp(-deg(22), deg(12), p);
          hipShiftZ = lerp(-0.04, 0.055, p);
          hipDrop = lerp(-0.045, -0.065, p);
          rWristX = lerp(-0.18, -0.06, p);
          rWristY = lerp(1.46, 1.12, p) + 0.10 * arc;
          rWristZ = lerp(0.05, 0.43, p);
          lWristX = lerp(-0.07, 0.03, p);
          lWristY = lerp(1.41, 1.16, p) + 0.10 * arc;
          lWristZ = lerp(0.11, 0.46, p);
        } else {
          const p = smooth01((u - 0.65) / 0.35);
          torsoPitch = lerp(deg(22), deg(4), p);
          torsoYaw = lerp(deg(12), -deg(4), p);
          hipShiftZ = lerp(0.055, 0, p);
          hipDrop = lerp(-0.065, -0.015, p);
          rWristX = lerp(-0.06, -0.075, p);
          rWristY = lerp(1.12, 1.00, p);
          rWristZ = lerp(0.43, 0.27, p);
          lWristX = lerp(0.03, 0.025, p);
          lWristY = lerp(1.16, 1.06, p);
          lWristZ = lerp(0.46, 0.34, p);
        }

        b.applyTrunk({
          hipsOffset: [0, hipDrop, hipShiftZ],
          hipsPitch: torsoPitch * 0.38,
          hipsYaw: torsoYaw * 0.42,
          spinePitch: torsoPitch * 0.32,
          spineYaw: torsoYaw * 0.30,
          chestPitch: torsoPitch * 0.30,
          chestYaw: torsoYaw * 0.28,
          neckPitch: -torsoPitch * 0.42,
          headPitch: -torsoPitch * 0.35,
          headYaw: -torsoYaw * 0.45,
        });

        vW1.set(0.10, lengths.ankleRestY, 0.05);
        vW2.set(-0.10, lengths.ankleRestY, -0.04);
        b.poseLegIK('L', vW1, 0, 0.06);
        b.poseLegIK('R', vW2, 0, 0.06);

        vW2.set(rWristX, rWristY, rWristZ);
        vP2.set(-0.36, -0.32, -0.22).normalize();
        vF2.set(0.05, 0.62, 0.78).normalize();
        vN2.set(0.94, -0.20, -0.26).normalize();
        b.poseArmIK('R', vW2, vP2, vF2, vN2);

        vW1.set(lWristX, lWristY, lWristZ);
        vP1.set(0.32, -0.35, -0.22).normalize();
        vF1.set(-0.14, 0.62, 0.77).normalize();
        vN1.set(-0.90, -0.24, 0.36).normalize();
        b.poseArmIK('L', vW1, vP1, vF1, vN1);
      }),
    );

    // 11. FishReel (0.68 s, looping — right hand bracing bent rod + left hand cranking circular reel + braced fighting knees).
    outClips.push(
      bakeClipFromSampler('FishReel', 0.68, 28, true, idleClip, pb, TRACKED_BONES, true, (u, b) => {
        const w = u * Math.PI * 2;
        const pump = Math.sin(w);

        b.applyTrunk({
          hipsOffset: [0, -0.058 + 0.012 * pump, -0.028],
          // Base athletic backward brace (-7°), dynamically amplified in ArenaCharacter proportional to fish tension!
          hipsPitch: -deg(3.2) - deg(1.5) * pump,
          hipsYaw: -deg(9.0),
          hipsRoll: deg(2.2),
          spinePitch: -deg(2.4) - deg(1.2) * pump,
          spineYaw: deg(4.5),
          chestPitch: -deg(2.2) - deg(1.2) * pump,
          chestYaw: deg(6.5),
          neckPitch: deg(4.2),
          headPitch: deg(3.5),
          headYaw: -deg(2.0),
        });

        vW1.set(0.11, lengths.ankleRestY, 0.06);
        vW2.set(-0.11, lengths.ankleRestY, -0.05);
        b.poseLegIK('L', vW1, 0, 0.07);
        b.poseLegIK('R', vW2, 0, 0.07);

        // Right hand firmly bracing bent rod grip
        const rodY = 1.13 + 0.028 * pump;
        vW2.set(-0.07, rodY, 0.30);
        vP2.set(-0.34, -0.44, -0.18).normalize();
        vF2.set(0.06, 0.68, 0.73).normalize();
        vN2.set(0.94, -0.20, -0.25).normalize();
        b.poseArmIK('R', vW2, vP2, vF2, vN2);

        // Left hand cranking circular reel orbit (radius = 5.2 cm around reel axle)
        vW1.set(0.032, rodY - 0.01 + 0.052 * Math.sin(w), 0.31 + 0.052 * Math.cos(w));
        vP1.set(0.34, -0.42, -0.20).normalize();
        vF1.set(-0.22, 0.45, 0.86).normalize();
        vN1.set(-0.92, -0.22, 0.32).normalize();
        b.poseArmIK('L', vW1, vP1, vF1, vN1);
      }),
    );

    // 12. FishCatch (1.50 s, LoopOnce — celebratory trophy presentation pose).
    outClips.push(
      bakeClipFromSampler('FishCatch', 1.5, 32, false, idleClip, pb, TRACKED_BONES, true, (u, b) => {
        const lift = smooth01(u / 0.34);
        const bounce = u > 0.3 ? Math.sin(((u - 0.3) / 0.7) * Math.PI * 2) * (1 - u) * 0.5 : 0;

        b.applyTrunk({
          hipsOffset: [0, -0.025 * (1 - lift) + 0.018 * bounce, 0],
          hipsPitch: -deg(3.5) * lift,
          hipsYaw: deg(6) * lift,
          spinePitch: -deg(3.5) * lift,
          chestPitch: -deg(4.5) * lift,
          chestYaw: deg(5) * lift,
          chestRoll: -deg(2.5) * lift,
          neckPitch: deg(3.5) * lift,
          headPitch: deg(4.5) * lift + deg(3) * bounce,
          headYaw: -deg(5) * lift,
        });

        vW1.set(0.095, lengths.ankleRestY, 0.02);
        vW2.set(-0.095, lengths.ankleRestY, -0.01);
        b.poseLegIK('L', vW1, 0, 0.05);
        b.poseLegIK('R', vW2, 0, 0.05);

        // Right hand holds rod proudly upright at side; left hand presents the catch forward
        vW2.set(lerp(-0.08, -0.23, lift), lerp(1.04, 1.25, lift) + 0.025 * bounce, lerp(0.28, 0.24, lift));
        vP2.set(-0.38, -0.42, -0.16).normalize();
        vF2.set(-0.08, 0.85, 0.52).normalize();
        vN2.set(0.92, -0.15, 0.36).normalize();
        b.poseArmIK('R', vW2, vP2, vF2, vN2);

        vW1.set(lerp(0.04, 0.15, lift), lerp(1.05, 1.27, lift) + 0.03 * bounce, lerp(0.30, 0.36, lift));
        vP1.set(0.36, -0.44, -0.16).normalize();
        vF1.set(-0.12, 0.78, 0.61).normalize();
        vN1.set(-0.82, 0.18, 0.54).normalize();
        b.poseArmIK('L', vW1, vP1, vF1, vN1);
      }),
    );

    // 13. TreeShake (0.72 s, looping — two-handed trunk embrace & rhythmic athletic shake).
    outClips.push(
      bakeClipFromSampler('TreeShake', 0.72, 28, true, idleClip, pb, TRACKED_BONES, true, (u, b) => {
        // Two vigorous push-pull shakes per 0.72 s cycle (~2.78 Hz)
        const w = u * Math.PI * 4;
        const push = Math.sin(w);
        const sideJolt = Math.sin(u * Math.PI * 2);

        b.applyTrunk({
          hipsOffset: [0.012 * sideJolt, -0.048 - 0.016 * Math.abs(push), 0.028 * push],
          hipsPitch: deg(7.5) + deg(3.5) * push,
          hipsYaw: deg(2.5) * sideJolt,
          spinePitch: deg(5.5) + deg(3.2) * push,
          chestPitch: deg(5.0) + deg(3.5) * push,
          chestYaw: -deg(3.2) * sideJolt,
          neckPitch: -deg(7.5) - deg(2.5) * push,
          headPitch: -deg(6.5) - deg(2.0) * push,
        });

        vW1.set(0.115, lengths.ankleRestY, 0.04);
        vW2.set(-0.115, lengths.ankleRestY, -0.03);
        b.poseLegIK('L', vW1, 0, 0.08);
        b.poseLegIK('R', vW2, 0, 0.08);

        // Two-handed trunk embrace at chest height, bowed elbows driving push/pull
        const handZ = 0.36 + 0.036 * push;
        const handY = 1.16 + 0.014 * Math.cos(w);
        for (const side of ['L', 'R'] as const) {
          const sgn = side === 'L' ? 1 : -1;
          vW1.set(sgn * 0.165, handY, handZ);
          vP1.set(sgn * 0.42, -0.28, -0.18).normalize();
          vF1.set(-sgn * 0.28, 0.24, 0.93).normalize();
          vN1.set(-sgn * 0.94, -0.12, 0.32).normalize();
          b.poseArmIK(side, vW1, vP1, vF1, vN1);
        }
      }),
    );

    // 14. Pickup (0.78 s, LoopOnce — smooth anatomical knee bend + hip hinge + right hand reach to gather fallen fruit).
    outClips.push(
      bakeClipFromSampler('Pickup', 0.78, 30, false, idleClip, pb, TRACKED_BONES, true, (u, b) => {
        // Bell curve peaking at u = 0.46 (reaching fruit on ground), rising cleanly with fruit at u = 1.0
        const reach = u < 0.46 ? smooth01(u / 0.46) : smooth01((1 - u) / 0.54);
        const drop = -0.25 * reach;
        const stoop = deg(36) * reach;

        b.applyTrunk({
          hipsOffset: [0, drop, -0.02 * reach],
          hipsPitch: stoop * 0.48,
          hipsYaw: -deg(8) * reach,
          spinePitch: stoop * 0.30,
          spineYaw: -deg(5) * reach,
          chestPitch: stoop * 0.22,
          chestYaw: -deg(6) * reach,
          neckPitch: -stoop * 0.42,
          headPitch: -stoop * 0.25,
        });

        // Both feet remain flat & grounded while knees flex into a clean balanced squat
        vW1.set(0.105, lengths.ankleRestY, -0.02);
        vW2.set(-0.105, lengths.ankleRestY, 0.04);
        b.poseLegIK('L', vW1, 0, 0.08);
        b.poseLegIK('R', vW2, 0, 0.08);

        if (reach > 0.02) {
          // Right hand reaches smoothly down to gather fruit; left arm counter-balances naturally
          vW2.set(
            lerp(-0.19, -0.12, reach),
            lerp(0.95, 0.24, reach),
            lerp(0.06, 0.34, reach),
          );
          vP2.set(-0.34, -0.35, -0.22).normalize();
          vF2.set(0.06, lerp(-0.88, -0.72, reach), lerp(0.46, 0.69, reach)).normalize();
          vN2.set(0.65, -0.68, -0.34).normalize();
          b.poseArmIK('R', vW2, vP2, vF2, vN2);

          vW1.set(
            lerp(0.19, 0.23, reach),
            lerp(0.95, 0.78, reach),
            lerp(0.06, 0.14, reach),
          );
          vP1.set(0.36, -0.44, -0.18).normalize();
          vF1.set(-0.08, -0.82, 0.56).normalize();
          vN1.set(-0.88, -0.44, 0.18).normalize();
          b.poseArmIK('L', vW1, vP1, vF1, vN1);
        }
      }),
    );

    // 15. GroundSit (2.80 s, looping — relaxed open-knee beach/meadow ground sit, `0` underground shin/boot clip).
    const groundSitDropModel = Math.max(0.65, lengths.hipsRestY - 0.120);
    const groundYInModel = groundSitDropModel;
    outClips.push(
      bakeClipFromSampler('GroundSit', 2.8, 32, true, idleClip, pb, TRACKED_BONES, true, (u, b) => {
        const w = u * Math.PI * 2;
        const breath = Math.sin(w);

        b.applyTrunk({
          hipsOffset: [0, 0.003 * breath, -0.02],
          hipsPitch: -deg(9) + deg(0.8) * breath,
          hipsYaw: -deg(3.5),
          hipsRoll: deg(1.2),
          spinePitch: deg(3.5) + deg(0.9) * breath,
          spineYaw: deg(2.0),
          chestPitch: deg(3.2) + deg(1.0) * breath,
          chestYaw: deg(2.2),
          neckPitch: deg(1.8),
          headPitch: deg(1.5) - deg(0.8) * breath,
          headYaw: -deg(1.2),
        });

        // Open-knee beach posture: heels rest cleanly on `groundYInModel` (`soleY === 0.000 m`), knees elevated `+0.34 m` above ground!
        const pitchL = -deg(10);
        const pitchR = -deg(12);
        const yawL = deg(16);
        const yawR = -deg(18);
        vW1.set(0.155, groundYInModel + flatAnkleY('L', pitchL, yawL) + 0.002, 0.455);
        vW2.set(-0.165, groundYInModel + flatAnkleY('R', pitchR, yawR) + 0.002, 0.425);
        b.poseLegIK('L', vW1, pitchL, 0.30, yawL, 0.55);
        b.poseLegIK('R', vW2, pitchR, 0.32, yawR, 0.55);

        // Relaxed forearms resting naturally across elevated knees/shins
        vW1.set(0.195, 1.07 + 0.005 * breath, 0.255);
        vP1.set(0.36, -0.42, -0.16).normalize();
        vF1.set(-0.18, -0.28, 0.94).normalize();
        vN1.set(-0.48, -0.84, -0.24).normalize();
        b.poseArmIK('L', vW1, vP1, vF1, vN1);

        vW2.set(-0.205, 1.05 + 0.005 * breath, 0.240);
        vP2.set(-0.36, -0.42, -0.16).normalize();
        vF2.set(0.18, -0.28, 0.94).normalize();
        vN2.set(0.48, -0.84, -0.24).normalize();
        b.poseArmIK('R', vW2, vP2, vF2, vN2);
      }),
    );

    // 16. SitLow — adaptive low-thwart boat seat clip (`0.33 m` skiff/sampan thwart, `0.000 mm` hull-deck sole alignment).
    model.scale.copy(savedModelScale);
    model.updateWorldMatrix(true, true);
    const sitLow = arenaSeatClip(model, idleClip, { seatHeightAboveDeck: 0.33, clipName: 'SitLow' });
    outClips.push(sitLow.clip);
    model.scale.set(1, 1, 1);
    model.updateWorldMatrix(true, true);

    // 17. Photo Studio Poses (`PhotoStand`, `PhotoWave`, `PhotoCheer`, `PhotoThink`, `PhotoPeace` — 3.20 s breathing,
    //     30-finger bone-local tracks, crisp 2-finger V-sign on `PhotoPeace`, shared-hinge arms, flat grounded soles).
    const RELAXED_PHOTO_DIGITS = {
      thumb: [0.16, 0.14, 0.08, 0.08, 0.12],
      index: [0.14, 0.22, 0.12, -0.03, 0],
      middle: [0.18, 0.26, 0.15, 0.0, 0],
      ring: [0.22, 0.30, 0.18, 0.03, 0],
      little: [0.26, 0.34, 0.20, 0.06, 0],
    } as const;

    // 17A. PhotoStand (Contrapposto)
    outClips.push(
      bakeClipFromSampler('PhotoStand', 3.2, 24, true, idleClip, pb, PHOTO_TRACKED_BONES, true, (u, b) => {
        const w = u * Math.PI * 2;
        const br = Math.sin(w);
        b.applyTrunk({
          hipsOffset: [-0.014, -0.012 + 0.004 * br, 0],
          hipsPitch: deg(1.0),
          hipsYaw: -deg(5.5),
          hipsRoll: deg(2.6),
          spinePitch: -deg(1.2) + deg(0.6) * br,
          spineYaw: deg(3.2),
          spineRoll: -deg(1.5),
          chestPitch: -deg(1.4) + deg(0.8) * br,
          chestYaw: deg(3.0),
          chestRoll: -deg(1.4),
          neckPitch: deg(0.8),
          headPitch: deg(1.0) - deg(0.6) * br,
          headYaw: -deg(1.5),
          headRoll: deg(1.2),
        });
        vW1.set(0.105, flatAnkleY('L', 0, deg(6)), 0.045);
        vW2.set(-0.088, flatAnkleY('R', 0, -deg(4)), -0.020);
        b.poseLegIK('L', vW1, 0, 0.06, deg(6));
        b.poseLegIK('R', vW2, 0, 0.05, -deg(4));
        for (const side of ['L', 'R'] as const) {
          b.poseArmAngles(side, {
            clavicleLift: deg(1.2),
            shoulderPitch: deg(3.5) + deg(1.2) * br,
            shoulderAbduct: deg(9.5),
            elbowFlex: deg(18),
            wristPitch: deg(-2),
            palmInward: 0.18,
          });
          b.poseHandFingers(side, RELAXED_PHOTO_DIGITS);
        }
      }),
    );

    // 17B. PhotoWave
    outClips.push(
      bakeClipFromSampler('PhotoWave', 3.2, 28, true, idleClip, pb, PHOTO_TRACKED_BONES, true, (u, b) => {
        const w = u * Math.PI * 2;
        const wave = Math.sin(w * 2);
        const br = Math.sin(w);
        b.applyTrunk({
          hipsOffset: [0.012, -0.010 + 0.004 * br, 0],
          hipsPitch: deg(0.8),
          hipsYaw: deg(4.2),
          hipsRoll: -deg(2.2),
          spinePitch: -deg(1.4),
          spineYaw: -deg(2.5),
          spineRoll: deg(1.4),
          chestPitch: -deg(1.8) + deg(0.8) * br,
          chestYaw: -deg(2.8),
          chestRoll: deg(1.6),
          neckPitch: -deg(0.6),
          headPitch: -deg(0.8),
          headYaw: deg(2.2),
          headRoll: deg(2.4),
        });
        vW1.set(0.088, flatAnkleY('L', 0, deg(4)), -0.018);
        vW2.set(-0.106, flatAnkleY('R', 0, -deg(6)), 0.042);
        b.poseLegIK('L', vW1, 0, 0.05, deg(4));
        b.poseLegIK('R', vW2, 0, 0.06, -deg(6));

        b.poseArmAngles('L', {
          shoulderPitch: deg(4),
          shoulderAbduct: deg(10),
          elbowFlex: deg(20),
          palmInward: 0.18,
        });
        b.poseHandFingers('L', RELAXED_PHOTO_DIGITS);

        // Shared-hinge friendly raised wave on right arm (`0°` elbow twist jump!)
        vW2.set(-0.27 + 0.045 * wave, 1.46 + 0.012 * br, 0.22);
        vP2.set(-0.46, -0.28, 0.22).normalize();
        vF2.set(0.14 * wave, 0.96, 0.22).normalize();
        vN2.set(0.10, -0.16, 0.98).normalize();
        b.poseArmIK('R', vW2, vP2, vF2, vN2);
        b.poseHandFingers('R', {
          thumb: [-0.04, -0.06, 0.0, -0.22, -0.10],
          index: [-0.08, -0.14, -0.02, -0.09, 0],
          middle: [-0.08, -0.14, -0.02, 0.0, 0],
          ring: [-0.06, -0.12, -0.02, 0.08, 0],
          little: [-0.04, -0.10, -0.02, 0.16, 0],
        });
      }),
    );

    // 17C. PhotoCheer
    outClips.push(
      bakeClipFromSampler('PhotoCheer', 3.2, 28, true, idleClip, pb, PHOTO_TRACKED_BONES, true, (u, b) => {
        const w = u * Math.PI * 2;
        const lift = Math.sin(w);
        b.applyTrunk({
          hipsOffset: [0, -0.012 + 0.008 * lift, 0],
          hipsPitch: -deg(1.6),
          hipsYaw: -deg(2.0),
          spinePitch: -deg(2.6) - deg(0.8) * lift,
          chestPitch: -deg(3.4) - deg(1.0) * lift,
          neckPitch: -deg(1.8),
          headPitch: -deg(2.2) - deg(0.8) * lift,
          headYaw: deg(1.2),
        });
        vW1.set(0.112, flatAnkleY('L', 0, deg(7)), 0.032);
        vW2.set(-0.108, flatAnkleY('R', 0, -deg(7)), -0.016);
        b.poseLegIK('L', vW1, 0, 0.06, deg(7));
        b.poseLegIK('R', vW2, 0, 0.06, -deg(7));

        for (const side of ['L', 'R'] as const) {
          const sgn = side === 'L' ? 1 : -1;
          vW1.set(sgn * 0.28, 1.56 + 0.022 * lift, 0.19);
          vP1.set(sgn * 0.48, -0.18, 0.28).normalize();
          vF1.set(sgn * 0.14, 0.96, 0.21).normalize();
          vN1.set(-sgn * 0.42, -0.18, 0.89).normalize();
          b.poseArmIK(side, vW1, vP1, vF1, vN1);
          b.poseHandFingers(side, {
            thumb: [0.05, 0.06, 0.04, -0.18, 0.08],
            index: [-0.04, -0.08, 0.0, -0.08, 0],
            middle: [-0.04, -0.08, 0.0, 0.0, 0],
            ring: [0.02, -0.04, 0.02, 0.07, 0],
            little: [0.06, 0.0, 0.04, 0.14, 0],
          });
        }
      }),
    );

    // 17D. PhotoThink
    outClips.push(
      bakeClipFromSampler('PhotoThink', 3.2, 24, true, idleClip, pb, PHOTO_TRACKED_BONES, true, (u, b) => {
        const w = u * Math.PI * 2;
        const br = Math.sin(w);
        b.applyTrunk({
          hipsOffset: [-0.012, -0.012 + 0.004 * br, 0],
          hipsPitch: deg(1.2),
          hipsYaw: -deg(4.8),
          hipsRoll: deg(2.2),
          spinePitch: deg(1.4),
          spineYaw: deg(2.6),
          chestPitch: deg(0.8) + deg(0.6) * br,
          chestYaw: deg(2.2),
          neckPitch: deg(1.4),
          headPitch: deg(2.2) - deg(0.5) * br,
          headYaw: -deg(2.0),
          headRoll: deg(4.2),
        });
        vW1.set(0.102, flatAnkleY('L', 0, deg(6)), 0.040);
        vW2.set(-0.088, flatAnkleY('R', 0, -deg(4)), -0.018);
        b.poseLegIK('L', vW1, 0, 0.06, deg(6));
        b.poseLegIK('R', vW2, 0, 0.05, -deg(4));

        // Left hand lightly cradling waist/elbow; right hand thoughtfully near chin
        b.poseArmAngles('L', {
          shoulderPitch: deg(8),
          shoulderAbduct: deg(9),
          elbowFlex: deg(32),
          palmInward: 0.22,
        });
        b.poseHandFingers('L', RELAXED_PHOTO_DIGITS);

        vW2.set(-0.055, 1.34 + 0.004 * br, 0.205);
        vP2.set(-0.28, -0.48, 0.24).normalize();
        vF2.set(0.16, 0.96, -0.14).normalize();
        vN2.set(0.72, -0.14, -0.68).normalize();
        b.poseArmIK('R', vW2, vP2, vF2, vN2);
        b.poseHandFingers('R', {
          thumb: [0.36, 0.30, 0.16, 0.12, 0.34],
          index: [-0.06, 0.12, 0.08, -0.05, 0],
          middle: [1.18, 1.32, 0.82, 0.0, 0],
          ring: [1.28, 1.38, 0.88, 0.04, 0],
          little: [1.34, 1.42, 0.92, 0.08, 0],
        });
      }),
    );

    // 17E. PhotoPeace — Crisp 2-finger V-sign (`index` & `middle` extended < 10° curl with 26° V-spread; `ring`, `little`, `thumb` curled > 105°!)
    outClips.push(
      bakeClipFromSampler('PhotoPeace', 3.2, 24, true, idleClip, pb, PHOTO_TRACKED_BONES, true, (u, b) => {
        const w = u * Math.PI * 2;
        const br = Math.sin(w);
        b.applyTrunk({
          hipsOffset: [0.012, -0.012 + 0.004 * br, 0],
          hipsPitch: deg(0.8),
          hipsYaw: deg(4.6),
          hipsRoll: -deg(2.4),
          spinePitch: -deg(1.2),
          spineYaw: -deg(2.6),
          chestPitch: -deg(1.4) + deg(0.7) * br,
          chestYaw: -deg(2.2),
          neckPitch: -deg(0.6),
          headPitch: -deg(0.8) - deg(0.5) * br,
          headYaw: deg(2.2),
          headRoll: -deg(3.2),
        });
        vW1.set(0.088, flatAnkleY('L', 0, deg(4)), -0.018);
        vW2.set(-0.104, flatAnkleY('R', 0, -deg(6)), 0.040);
        b.poseLegIK('L', vW1, 0, 0.05, deg(4));
        b.poseLegIK('R', vW2, 0, 0.06, -deg(6));

        b.poseArmAngles('L', {
          shoulderPitch: deg(5),
          shoulderAbduct: deg(9.5),
          elbowFlex: deg(22),
          palmInward: 0.18,
        });
        b.poseHandFingers('L', RELAXED_PHOTO_DIGITS);

        // Right arm presents crisp V-sign beside cheek/shoulder (`palm` facing camera `+Z`, shared-hinge `poseArmIK` -> `0°` elbow twist jump)
        vW2.set(-0.185, 1.38 + 0.008 * br, 0.265);
        vP2.set(-0.42, -0.36, 0.20).normalize();
        vF2.set(0.08, 0.98, 0.16).normalize();
        vN2.set(0.10, -0.14, 0.985).normalize();
        b.poseArmIK('R', vW2, vP2, vF2, vN2);
        b.poseHandFingers('R', {
          thumb: [0.76, 0.86, 0.56, 0.26, 0.64],
          index: [-0.12, -0.19, -0.03, 0.18, 0],
          middle: [-0.11, -0.19, -0.03, -0.16, 0],
          ring: [1.42, 1.52, 0.96, 0.04, 0],
          little: [1.46, 1.56, 0.98, 0.08, 0],
        });
      }),
    );

    const result: ArenaExtraClipsResult = {
      clips: outClips,
      jogStrideLength: jogBuilt.strideLengthModel,
      jogFootLead: 0,
      sprintStrideLength: sprintBuilt.strideLengthModel,
      sprintFootLead: 0,
      groundSitDrop: groundSitDropModel * worldScale,
      lowSeatDrop: sitLow.drop,
    };
    suiteCache.set(idleClip, result);
    return result;
  } finally {
    for (const s of orderedBones) {
      s.bone.position.copy(s.origPos);
      s.bone.quaternion.copy(s.origQuat);
      s.bone.scale.copy(s.origScale);
    }
    model.position.copy(savedModelPos);
    model.rotation.copy(savedModelRot);
    model.scale.copy(savedModelScale);
    model.updateWorldMatrix(true, true);
  }
}

/** Pre-allocated scratch buffers for zero-GC per-frame `HumanRig` action overlays (`HelmSteer`, `Fishing`, `TreeShake`). */
export interface ArenaRigOverlayScratch {
  left: RestHand;
  right: RestHand;
  pair: { left: RestHand; right: RestHand };
  fwd: T.Vector3;
  leftAxis: T.Vector3;
  aimDir: T.Vector3;
  out: {
    rest: { left: RestHand; right: RestHand } | null;
    lean: number;
    twist: number;
    crouch: number;
  };
}

export function createArenaRigOverlayScratch(): ArenaRigOverlayScratch {
  const left: RestHand = {
    wrist: new T.Vector3(),
    fingers: new T.Vector3(0, 0, 1),
    palm: new T.Vector3(-1, 0, 0),
    curl: 0.55,
    grip: 'handle',
  };
  const right: RestHand = {
    wrist: new T.Vector3(),
    fingers: new T.Vector3(0, 0, 1),
    palm: new T.Vector3(1, 0, 0),
    curl: 0.55,
    grip: 'handle',
  };
  return {
    left,
    right,
    pair: { left, right },
    fwd: new T.Vector3(),
    leftAxis: new T.Vector3(),
    aimDir: new T.Vector3(),
    out: { rest: null, lean: 0, twist: 0, crouch: 0 },
  };
}

/**
 * Zero-allocation evaluator computing `HumanRig` world-space `rest` hand targets (for `HelmSteer` & `TreeShake`)
 * and dynamic backward/forward torso `lean` & `twist` for `Fishing` (`charging`, `reeling`, `bite_alert`) without
 * overriding fishing `HandContact` arm IK (`out.rest = null` on all `Fish*` states).
 */
export function evaluateArenaRigOverlay(
  scratch: ArenaRigOverlayScratch,
  rootPos: T.Vector3,
  rootYaw: number,
  scale: number,
  elapsed: number,
  activeClip: string,
  fishing?: { phase: FishingPhase; tension: number; chargePower?: number; rodTipWorld?: T.Vector3 } | null,
  steering = 0,
): ArenaRigOverlayScratch['out'] {
  const out = scratch.out;
  out.rest = null;
  out.lean = 0;
  out.twist = 0;
  out.crouch = 0;

  const sinY = Math.sin(rootYaw);
  const cosY = Math.cos(rootYaw);
  const fwd = scratch.fwd.set(sinY, 0, cosY);
  const leftAxis = scratch.leftAxis.set(cosY, 0, -sinY);
  const L = scratch.left;
  const R = scratch.right;

  if (activeClip === 'HelmSteer') {
    const wheelTurn = clamp(steering, -1, 1) * 0.045 * scale;
    const swell = Math.sin(elapsed * 2.2) * 0.008 * scale;
    L.wrist
      .copy(rootPos)
      .addScaledVector(leftAxis, 0.145 * scale)
      .addScaledVector(fwd, 0.34 * scale)
      .setY(rootPos.y + 1.07 * scale + wheelTurn + swell);
    L.fingers.copy(fwd).addScaledVector(leftAxis, -0.22).setY(0.18).normalize();
    L.palm.copy(leftAxis).multiplyScalar(-0.68).setY(-0.72).normalize();
    L.curl = 0.72;
    L.grip = 'handle';

    R.wrist
      .copy(rootPos)
      .addScaledVector(leftAxis, -0.175 * scale)
      .addScaledVector(fwd, 0.33 * scale)
      .setY(rootPos.y + 1.03 * scale - wheelTurn + swell);
    R.fingers.copy(fwd).addScaledVector(leftAxis, 0.15).setY(0.12).normalize();
    R.palm.copy(leftAxis).multiplyScalar(0.74).setY(-0.65).normalize();
    R.curl = 0.72;
    R.grip = 'handle';

    out.rest = scratch.pair;
    out.lean = 0.04;
    out.twist = clamp(steering, -1, 1) * 0.08;
    return out;
  }

  if (fishing?.phase === 'charging') {
    const power = clamp(fishing.chargePower ?? 0.5, 0, 1);
    out.lean = -(0.06 + 0.16 * power);
    out.twist = -(0.08 + 0.18 * power);
    out.rest = null;
    return out;
  }

  if (activeClip === 'FishReel' || (fishing && (fishing.phase === 'reeling' || fishing.phase === 'bite_alert'))) {
    const tension = clamp(fishing?.tension ?? 0.45, 0, 1);
    const pump = Math.sin(elapsed * (3.8 + tension * 2.4));
    // Dynamic backward torso brace proportional to fish line tension; arms are driven 100% by `ArenaFishingController` `HandContact`s!
    out.lean = -(0.14 + 0.34 * tension + 0.035 * pump);
    out.twist = 0.12 + 0.06 * tension;
    out.crouch = 0;
    out.rest = null;
    return out;
  }

  if (activeClip === 'FishIdle' || fishing?.phase === 'equipped' || fishing?.phase === 'waiting_bite') {
    out.lean = 0.02;
    out.rest = null;
    return out;
  }

  if (activeClip === 'TreeShake') {
    const pulse = Math.sin(elapsed * 17.5);
    const handZ = (0.36 + 0.034 * pulse) * scale;
    const handY = rootPos.y + (1.16 + 0.012 * Math.cos(elapsed * 17.5)) * scale;

    L.wrist.copy(rootPos).addScaledVector(leftAxis, 0.165 * scale).addScaledVector(fwd, handZ).setY(handY);
    L.fingers.copy(fwd).multiplyScalar(0.92).addScaledVector(leftAxis, -0.28).setY(0.24).normalize();
    L.palm.copy(leftAxis).multiplyScalar(-0.94).setY(-0.12).normalize();
    L.curl = 0.45;
    L.grip = 'cylinder';

    R.wrist.copy(rootPos).addScaledVector(leftAxis, -0.165 * scale).addScaledVector(fwd, handZ).setY(handY);
    R.fingers.copy(fwd).multiplyScalar(0.92).addScaledVector(leftAxis, 0.28).setY(0.24).normalize();
    R.palm.copy(leftAxis).multiplyScalar(0.94).setY(-0.12).normalize();
    R.curl = 0.45;
    R.grip = 'cylinder';

    out.rest = scratch.pair;
    out.lean = 0.12 + 0.05 * pulse;
    out.crouch = 0.06;
    return out;
  }

  return out;
}

export type { ArenaSwimFrame };
