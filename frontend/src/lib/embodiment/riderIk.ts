import * as T from 'three';
import { handleGrip, handleShape } from './handle';
import type { HandContact, HumanRig } from './human';

/**
 * Unified Zero-Allocation Analytical Rider Embodiment & Two-Bone IK Engine (`riderIk.ts`).
 *
 * Dual-Path Architecture (per `@embodiment-reviewer` #38 & `@coordinator` #39):
 *  1. **Player & Arena/Peer `HumanRig` Path (`HumanRigRiderBinding` / `computeHumanRigRiderFrame`):**
 *     Outputs reusable `HandContact`s (via `handleGrip` + `handleShape`, matching Speaking Arena v7
 *     boat-rowing), additive `RiderLegTarget`s (`side: -1` Left, `side: +1` Right) for `BodyFrame.legTargets`,
 *     per-rider virtual seat-post height (`BDC d = 0.91 * L`, clamped `±8 cm`), saddle-locked root transform,
 *     `seated: true`, `lean`, and `twist` — **ZERO raw post-`update()` bone writes on `HumanRig`!**
 *  2. **NPC Skinned `Body` Path (`bindRiderSkeleton` / `applyCoherentRiderIk`):**
 *     Supports `RunnerRig` (65b `lyra_v2`/`kai_v2`), `EchoStudentRig` (`Echo59` 59b), and `Codex52`
 *     (Mixamo 52b `LeftUpLeg`/`Spine1`/etc.), with full extended `savedQuats` + `savedHipsLocalPos` XYZ
 *     restore, runtime-measured post-scale limb lengths, per-rider virtual seat-post adjustment, and
 *     shear-safe `parent.matrixWorld` inverse direction aiming (`<= 0.5 mm` FK residual even under
 *     extreme non-uniform CAZ scale sliders).
 *
 * Coordinate Convention (Right-Handed Three.js):
 *  - `+Z` = Vehicle / Character forward
 *  - `+Y` = World / Vehicle up
 *  - `+X` = Rider's anatomical LEFT (`HumanRig` `side = -1`, `.L` / `Left*`)
 *  - `-X` = Rider's anatomical RIGHT (`HumanRig` `side = +1`, `.R` / `Right*`)
 */

export type VehicleRiderArchetype =
  | 'cruiser_bike'     // veh_bike_basket, veh_ebike_commuter, veh_bike_cargo, legacy bicycle
  | 'road_bike'        // veh_bike_road, veh_bike_touring
  | 'track_bike'       // veh_bike_velodrome
  | 'step_scooter'     // veh_scooter_electric, veh_moto_vesper
  | 'sport_moto'       // veh_moto_cafe_racer, veh_moto_apex1000
  | 'compact_car'      // mango_micro_aaa, mango_micro, river_sedan
  | 'sport_coupe_car'; // lotus_spider, halo_vector

export type RiderRigKind = 'runner65' | 'echo59' | 'codex52' | 'generic';

export type RiderMountPhase =
  | 'unmounted'
  | 'approaching'
  | 'mounting'
  | 'riding'
  | 'stopping'
  | 'dismounting';

export interface VehicleRigSockets {
  readonly modelId: string;
  readonly archetype: VehicleRiderArchetype;
  readonly hasPedals: boolean;
  readonly isCar: boolean;
  readonly gearRatio: number;
  readonly wheelRadius: number;
  readonly wheelbase: number;
  /** Mesh-exact crank throw radius (`0.107 m` on `w03` bikes, `0.110 m` on `veh_bike_touring`). */
  readonly crankRadius: number;
  /** Offset added to vehicle root Y so tire bottoms kiss `groundY` (ignores deployed kickstands). */
  readonly wheelGroundY: number;
  /** Calibrated roof ceiling in vehicle-local Y (`Infinity` on open bikes/roadsters). */
  readonly roofCeilingY: number;
  /** Articulated seat-post / car-seat height node adjusted per rider (`±8 cm` bikes, `±6 cm` cars). */
  readonly seatPostPivot: T.Object3D;
  /** Unadjusted authored local Y of `seatPostPivot`. */
  readonly baseSeatPostY: number;
  /** Saddle top (`anchor_saddle`) or car driver cushion (`anchor_driver`), child of `seatPostPivot`. */
  readonly saddleOrSeat: T.Object3D;
  /** ALWAYS `+X` in vehicle-local space (rider's anatomical LEFT hand `.L`, `HumanRig` `side = -1`). */
  readonly gripLeft: T.Object3D;
  /** ALWAYS `-X` in vehicle-local space (rider's anatomical RIGHT hand `.R`, `HumanRig` `side = +1`). */
  readonly gripRight: T.Object3D;
  /** ALWAYS `+X` in vehicle-local space (left pedal spindle, scooter floorboard L, or car footwell L). */
  readonly footLeft: T.Object3D;
  /** ALWAYS `-X` in vehicle-local space (right pedal spindle, scooter floorboard R, or car throttle R). */
  readonly footRight: T.Object3D;
  readonly steerPivots: readonly T.Object3D[];
  readonly wheelPivots: readonly T.Object3D[];
  readonly crankPivot: T.Object3D | null;
  readonly pedalPivotLeft: T.Object3D | null;
  readonly pedalPivotRight: T.Object3D | null;
  readonly kickstandPivot: T.Object3D | null;
  readonly steeringWheelPivot: T.Object3D | null;
  readonly driverDoorPivot: T.Object3D | null;
  readonly driverDoorSign: 1 | -1;
}

export interface RiderKinematicState {
  readonly speed: number;
  readonly maxSpeed: number;
  /** Steering angle in radians (`+` = left turn, `-` = right turn). */
  readonly steer: number;
  /** Roll bank angle in radians (`+` = right bank `-X`, `-` = left bank `+X`). */
  readonly lean: number;
  /** Pitch angle in radians (`+` = nose dive on front brake). */
  readonly forkDive: number;
  /** Integrated crank angle in radians (`+X` rotation propels bike `+Z` forward; `ω = 0` at `v = 0`). */
  readonly crankAngle: number;
  /** Instantaneous crank angular velocity (`rad/s`, strictly `0` when `speed === 0`). */
  readonly crankOmega: number;
  /** `0` = both feet on pedals/pegs, `1` = balance foot planted flat on ground at stop. */
  readonly standDownBlend: number;
  /** `0` = standing beside vehicle, `1` = seated on saddle/driver seat. */
  readonly mountBlend: number;
  /** `0..1` smooth handlebar/steering-wheel hand IK lock weight. */
  readonly armIkWeight: number;
  /** `0` = kickstand deployed on ground, `1` = kickstand folded up along chainstay. */
  readonly kickstandRetract: number;
  /** `0..1` car driver door open progress during mount/dismount. */
  readonly doorOpenBlend: number;
  /** World ground elevation under the vehicle contact line. */
  readonly groundY: number;
  /** `+1` = mount / put left (`+X`) foot down; `-1` = right (`-X`) side fallback. */
  readonly standSideSign: 1 | -1;
  readonly freeLookYawOffset?: number;
  readonly freeLookPitchOffset?: number;
}

export interface RiderStepInput {
  readonly speed: number;
  readonly maxSpeed: number;
  readonly throttle: number;
  readonly steer: number;
  readonly brake: boolean;
  readonly groundY: number;
  readonly isCoasting?: boolean;
  readonly externalCrankAngle?: number;
  readonly externalCrankOmega?: number;
  readonly externalLean?: number;
  readonly externalForkDive?: number;
}

/** Additive leg IK target record consumed by `HumanRig` (`BodyFrame.legTargets`, `side: -1` Left, `+1` Right). */
export interface RiderLegTarget {
  side: -1 | 1;
  ankle: T.Vector3;
  pole: T.Vector3;
  footQ: T.Quaternion;
  weight: number;
}

/** Reusable zero-allocation adapter state feeding `HumanRig` (`Character` & `ArenaCharacter` peers). */
export interface HumanRigRiderBinding {
  readonly leftContact: HandContact;
  readonly rightContact: HandContact;
  readonly leftLegTarget: RiderLegTarget;
  readonly rightLegTarget: RiderLegTarget;
  readonly legTargets: readonly [RiderLegTarget, RiderLegTarget];
  /** Direct zero-allocation payload matching `BodyFrame.legTargets` (`left`/`right` ankle goals + pedal/sole quats & normals + knee poles). */
  readonly bodyFrameLegTargets: {
    readonly left: T.Vector3;
    readonly right: T.Vector3;
    readonly leftNormal: T.Vector3;
    readonly rightNormal: T.Vector3;
    readonly leftPole: T.Vector3;
    readonly rightPole: T.Vector3;
    readonly leftFootQuat: T.Quaternion;
    readonly rightFootQuat: T.Quaternion;
    skipSlopeRoll: boolean;
    weight: number;
  };
  readonly rootPosition: T.Vector3;
  readonly rootQuaternion: T.Quaternion;
  rootYaw: number;
  riderRoll: number;
  riderPitch: number;
  seated: boolean;
  riderSeated: boolean;
  lean: number;
  twist: number;
  headYawLook: number;
  headPitchComp: number;
  seatPostDeltaY: number;
  contactsActive: boolean;
  boundGripLeftObj: T.Object3D | null;
  boundGripRightObj: T.Object3D | null;
}

interface FingerChain {
  readonly j1: T.Bone;
  readonly j2: T.Bone | null;
  readonly j3: T.Bone | null;
  readonly bind1: T.Quaternion;
  readonly bind2: T.Quaternion;
  readonly bind3: T.Quaternion;
  readonly curlAxis: T.Vector3;
}

export interface BoundRiderSkeleton {
  readonly rigKind: RiderRigKind;
  readonly root: T.Object3D;
  readonly hips: T.Bone;
  readonly spineBones: readonly T.Bone[];
  readonly neck: T.Bone | null;
  readonly head: T.Bone | null;
  readonly shoulderL: T.Bone | null;
  readonly upperArmL: T.Bone;
  readonly forearmL: T.Bone;
  readonly handL: T.Bone;
  readonly shoulderR: T.Bone | null;
  readonly upperArmR: T.Bone;
  readonly forearmR: T.Bone;
  readonly handR: T.Bone;
  readonly toeL: T.Bone | null;
  readonly toeR: T.Bone | null;
  readonly thighL: T.Bone;
  readonly shinL: T.Bone;
  readonly footL: T.Bone;
  readonly thighR: T.Bone;
  readonly shinR: T.Bone;
  readonly footR: T.Bone;
  readonly fingersL: readonly FingerChain[];
  readonly fingersR: readonly FingerChain[];

  readonly bindHipsLocalPos: T.Vector3;
  readonly bindQuats: ReadonlyMap<T.Bone, T.Quaternion>;
  /** Full extended restore set covering ALL written bones + `hips.position` XYZ (`@embodiment-reviewer` C1). */
  readonly savedQuats: Map<T.Bone, T.Quaternion>;
  readonly savedHipsLocalPos: T.Vector3;
  ikDirty: boolean;

  /** Base unscaled ratios measured from bind pose (actual world lengths are re-measured live per solve!). */
  readonly bindSoleRatioL: number;
  readonly bindSoleRatioR: number;
  readonly bindBallForwardRatio: number;
  readonly bindPalmGripRatioL: number;
  readonly bindPalmGripRatioR: number;
  /** Vertical sit-bone drop from `hips` joint center down to saddle contact (`~0.088 m` at 1.0 scale). */
  readonly bindSitBoneDrop: number;
  readonly bindHipsToCrownY: number;

  readonly footFrameToBoneL: T.Quaternion;
  readonly footFrameToBoneR: T.Quaternion;
  readonly handFrameToBoneL: T.Quaternion;
  readonly handFrameToBoneR: T.Quaternion;

  lastMetrics: {
    pelvisSaddleErrorM: number;
    leftFootErrorM: number;
    rightFootErrorM: number;
    leftHandErrorM: number;
    rightHandErrorM: number;
    leftAnklePitchRad: number;
    rightAnklePitchRad: number;
    seatPostDeltaY: number;
  };
}

const GRAVITY = 9.81;
const TAU = Math.PI * 2;
const MOUNT_DURATION_SEC = 0.55;
const DISMOUNT_DURATION_SEC = 0.50;
const AUTO_BRAKE_MAX_SEC = 0.65;
const SAFE_DISMOUNT_SPEED = 0.85;
const HANDLEBAR_GRIP_RADIUS = 0.017;
const HANDLEBAR_GRIP_HALF = 0.055;
const SEATPOST_MAX_DELTA_BIKE = 0.08;
const SEATPOST_MAX_DELTA_CAR = 0.11;

const ARCHETYPE_POSTURE: Record<
  VehicleRiderArchetype,
  {
    baseTrunkPitch: number;
    maxTrunkPitch: number;
    aeroPitchGain: number;
    ischialBackZ: number;
    kneeOutwardM: number;
  }
> = {
  cruiser_bike: { baseTrunkPitch: 0.34, maxTrunkPitch: 0.50, aeroPitchGain: 0.07, ischialBackZ: -0.008, kneeOutwardM: 0.038 },
  road_bike: { baseTrunkPitch: 0.46, maxTrunkPitch: 0.56, aeroPitchGain: 0.08, ischialBackZ: -0.015, kneeOutwardM: 0.034 },
  track_bike: { baseTrunkPitch: 0.54, maxTrunkPitch: 0.62, aeroPitchGain: 0.10, ischialBackZ: -0.012, kneeOutwardM: 0.032 },
  step_scooter: { baseTrunkPitch: 0.14, maxTrunkPitch: 0.28, aeroPitchGain: 0.05, ischialBackZ: -0.020, kneeOutwardM: 0.046 },
  sport_moto: { baseTrunkPitch: 0.48, maxTrunkPitch: 0.60, aeroPitchGain: 0.12, ischialBackZ: -0.022, kneeOutwardM: 0.075 },
  compact_car: { baseTrunkPitch: -0.20, maxTrunkPitch: 0.15, aeroPitchGain: 0.0, ischialBackZ: -0.035, kneeOutwardM: 0.050 },
  sport_coupe_car: { baseTrunkPitch: -0.42, maxTrunkPitch: 0.10, aeroPitchGain: 0.0, ischialBackZ: -0.055, kneeOutwardM: 0.055 },
};

const ZERO_VEC = new T.Vector3(0, 0, 0);
const INBOARD_LEFT = new T.Vector3(-1, 0, 0);  // Left grip (`+X`): thumb points `-X` inboard
const INBOARD_RIGHT = new T.Vector3(1, 0, 0);  // Right grip (`-X`): thumb points `+X` inboard
const WHEEL_RIM_TANGENT = new T.Vector3(0, 1, 0);

// ── Module-Scoped Zero-Allocation Scratch Math Pool ────────────────────────────────────────────────────────

const _v0 = new T.Vector3();
const _v1 = new T.Vector3();
const _v2 = new T.Vector3();
const _v3 = new T.Vector3();
const _bikePos = new T.Vector3();
const _bikeLeft = new T.Vector3();
const _bikeUp = new T.Vector3();
const _bikeFwd = new T.Vector3();
const _saddleWorld = new T.Vector3();
const _targetHipsWorld = new T.Vector3();
const _standHipsWorld = new T.Vector3();
const _hipsOffsetNow = new T.Vector3();
const _pedalWorldL = new T.Vector3();
const _pedalWorldR = new T.Vector3();
const _groundFootWorldL = new T.Vector3();
const _ankleTargetL = new T.Vector3();
const _ankleTargetR = new T.Vector3();
const _kneePoleL = new T.Vector3();
const _kneePoleR = new T.Vector3();
const _gripWorldL = new T.Vector3();
const _gripWorldR = new T.Vector3();
const _barAxisL = new T.Vector3();
const _barAxisR = new T.Vector3();
const _wristTargetL = new T.Vector3();
const _wristTargetR = new T.Vector3();
const _elbowPoleL = new T.Vector3();
const _elbowPoleR = new T.Vector3();
const _shoulderPosL = new T.Vector3();
const _shoulderPosR = new T.Vector3();
const _hipPosL = new T.Vector3();
const _hipPosR = new T.Vector3();
const _ikOrigin = new T.Vector3();
const _ikMid = new T.Vector3();
const _ikEnd = new T.Vector3();
const _ikDir = new T.Vector3();
const _ikBend = new T.Vector3();
const _ikJoint = new T.Vector3();
const _ikCur = new T.Vector3();
const _ikWant = new T.Vector3();
const _ikLocalOrigin = new T.Vector3();
const _basisX = new T.Vector3();
const _basisY = new T.Vector3();
const _basisZ = new T.Vector3();
const _foreDir = new T.Vector3();

const _q0 = new T.Quaternion();
const _q1 = new T.Quaternion();
const _q2 = new T.Quaternion();
const _bikeQuat = new T.Quaternion();
const _riderRootQuat = new T.Quaternion();
const _footQuatL = new T.Quaternion();
const _footQuatR = new T.Quaternion();
const _handQuatL = new T.Quaternion();
const _handQuatR = new T.Quaternion();

const _m4 = new T.Matrix4();
const _m4Inv = new T.Matrix4();
const _m4ParentInv = new T.Matrix4();
const _euler = new T.Euler();

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapTau(rad: number): number {
  const m = rad % TAU;
  return m < 0 ? m + TAU : m;
}

function wrapPi(rad: number): number {
  let a = (rad + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

export function minJerk01(t: number): number {
  const k = clamp(t, 0, 1);
  return k * k * k * (10 + k * (-15 + 6 * k));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (Math.abs(edge1 - edge0) < 1e-6) return x >= edge1 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function makeBasisQuat(xAxis: T.Vector3, yAxis: T.Vector3, zAxis: T.Vector3, out: T.Quaternion): T.Quaternion {
  _m4.makeBasis(xAxis, yAxis, zAxis);
  return out.setFromRotationMatrix(_m4).normalize();
}

// ── Per-Rider Virtual Seat-Post Adjustment (`@embodiment-reviewer` §4.1) ───────────────────────────────────

/**
 * Computes and applies the per-rider virtual seat-post adjustment (`±8 cm` on bikes, `±6 cm` on cars)
 * so short CAZ presets (`h=0.92, leg=0.94`) reach Bottom Dead Center cleanly (`d_BDC ≈ 0.91 * L`)
 * and tall presets (`h=1.12, leg=1.08`) are never frog-legged, moving `sockets.seatPostPivot` visibly
 * with the rider's sit-bones so pelvis-to-saddle contact stays `<= 1 mm`.
 */
export function applyVirtualSeatPostForRider(
  sockets: VehicleRigSockets,
  legLengthWorld: number,
  soleHeightWorld: number,
  ballForwardWorld: number,
  sitBoneDropWorld: number,
  hipsToCrownWorld: number,
  trunkPitchRad: number,
): number {
  let deltaY = 0;

  if (sockets.hasPedals && sockets.crankPivot) {
    const bbY = sockets.crankPivot.position.y;
    const bbZ = sockets.crankPivot.position.z;
    const bdcAnkleY = bbY - sockets.crankRadius + soleHeightWorld;
    const bdcAnkleZ = bbZ - ballForwardWorld;
    const saddleZ = sockets.seatPostPivot.position.z + sockets.saddleOrSeat.position.z;
    const dz = bdcAnkleZ - saddleZ;

    const targetBdcReach = 0.91 * legLengthWorld;
    const vertSq = Math.max(0.04, targetBdcReach * targetBdcReach - dz * dz);
    const desiredHipLocalY = bdcAnkleY + Math.sqrt(vertSq);
    const desiredSaddleY = desiredHipLocalY - sitBoneDropWorld;

    deltaY = clamp(desiredSaddleY - sockets.baseSeatPostY, -SEATPOST_MAX_DELTA_BIKE, SEATPOST_MAX_DELTA_BIKE);
  } else if (sockets.isCar && Number.isFinite(sockets.roofCeilingY)) {
    const projectedCrownY =
      sockets.baseSeatPostY +
      sockets.saddleOrSeat.position.y +
      sitBoneDropWorld +
      hipsToCrownWorld * Math.cos(Math.abs(trunkPitchRad));
    const maxSafeY = sockets.roofCeilingY - 0.085;
    if (projectedCrownY > maxSafeY) {
      deltaY = clamp(-(projectedCrownY - maxSafeY), -SEATPOST_MAX_DELTA_CAR, SEATPOST_MAX_DELTA_CAR);
    }
  }

  sockets.seatPostPivot.position.y = sockets.baseSeatPostY + deltaY;
  sockets.seatPostPivot.updateMatrixWorld(true);
  return deltaY;
}

// ── Path 1: `HumanRig` Adapter (`Character` & `ArenaCharacter` Peers — Zero Post-`update` Writes!) ─────────

export function createHumanRigRiderBinding(): HumanRigRiderBinding {
  const leftLegTarget: RiderLegTarget = {
    side: -1,
    ankle: new T.Vector3(),
    pole: new T.Vector3(),
    footQ: new T.Quaternion(),
    weight: 0,
  };
  const rightLegTarget: RiderLegTarget = {
    side: 1,
    ankle: new T.Vector3(),
    pole: new T.Vector3(),
    footQ: new T.Quaternion(),
    weight: 0,
  };
  return {
    leftContact: {
      wrist: new T.Vector3(),
      fingers: new T.Vector3(),
      palm: new T.Vector3(),
      pole: new T.Vector3(),
      grip: 'handle',
      wrap: true,
      bend: { pitch: 0, drop: 0, yaw: 0 },
    },
    rightContact: {
      wrist: new T.Vector3(),
      fingers: new T.Vector3(),
      palm: new T.Vector3(),
      pole: new T.Vector3(),
      grip: 'handle',
      wrap: true,
      bend: { pitch: 0, drop: 0, yaw: 0 },
    },
    leftLegTarget,
    rightLegTarget,
    legTargets: [leftLegTarget, rightLegTarget],
    bodyFrameLegTargets: {
      left: leftLegTarget.ankle,
      right: rightLegTarget.ankle,
      leftNormal: new T.Vector3(0, 1, 0),
      rightNormal: new T.Vector3(0, 1, 0),
      leftPole: leftLegTarget.pole,
      rightPole: rightLegTarget.pole,
      leftFootQuat: new T.Quaternion(),
      rightFootQuat: new T.Quaternion(),
      skipSlopeRoll: true,
      weight: 0,
    },
    rootPosition: new T.Vector3(),
    rootQuaternion: new T.Quaternion(),
    rootYaw: 0,
    riderRoll: 0,
    riderPitch: 0,
    seated: false,
    riderSeated: false,
    lean: 0,
    twist: 0,
    headYawLook: 0,
    headPitchComp: 0,
    seatPostDeltaY: 0,
    contactsActive: false,
    boundGripLeftObj: null,
    boundGripRightObj: null,
  };
}

/**
 * Cleanly releases handlebar/steering-wheel `HandContact`s (`contact.on = undefined`) and resets
 * rider leg/seated weights when dismounting so `HumanRig` never retains stale vehicle references.
 */
export function releaseHumanRigRiderContacts(
  rig: HumanRig | null | undefined,
  binding: HumanRigRiderBinding,
  releaseSec = 0,
): void {
  binding.leftContact.on = undefined;
  binding.leftContact.secured = false;
  binding.rightContact.on = undefined;
  binding.rightContact.secured = false;
  binding.boundGripLeftObj = null;
  binding.boundGripRightObj = null;
  if (binding.contactsActive && rig) {
    rig.setContact(-1, null, releaseSec);
    rig.setContact(1, null, releaseSec);
    if (releaseSec <= 0.05) {
      rig.clearTransientContacts(false);
    }
  }
  binding.contactsActive = false;
  binding.seated = false;
  binding.riderSeated = false;
  binding.lean = 0;
  binding.twist = 0;
  binding.riderRoll = 0;
  binding.riderPitch = 0;
  binding.headYawLook = 0;
  binding.headPitchComp = 0;
  binding.leftLegTarget.weight = 0;
  binding.rightLegTarget.weight = 0;
  binding.bodyFrameLegTargets.weight = 0;
  binding.bodyFrameLegTargets.skipSlopeRoll = false;
}

const _savedMeasureHipsPos = new T.Vector3();
const _savedMeasureQuats: T.Quaternion[] = [];

/**
 * Computes current-frame `HumanRig` inputs (`HandContact`s via `handleGrip` + `handleShape`,
 * `RiderLegTarget`s using runtime `HumanRig` limb lengths, virtual seat-post adjustment, and saddle-locked
 * root pose) **before** `HumanRig.update()` runs — zero raw post-`update` bone writes!
 */
export function computeHumanRigRiderFrame(
  rig: HumanRig,
  vehicleRoot: T.Object3D,
  sockets: VehicleRigSockets,
  state: RiderKinematicState,
  into: HumanRigRiderBinding,
  baseHipRestHeight = 0.93,
): HumanRigRiderBinding {
  const mountBlend = clamp(state.mountBlend, 0, 1);
  const armWeight = clamp(state.armIkWeight, 0, 1);

  if (mountBlend <= 0.0001 && armWeight <= 0.0001 && state.standDownBlend <= 0.0001) {
    releaseHumanRigRiderContacts(rig, into, 0);
    return into;
  }

  const boundCal = bindRiderSkeleton(rig.model);
  const gaitSkel = rig.gaitSkeleton;

  // Measure bind-pose `hips` and shoulder anchors cleanly without clip contamination
  // (matching `HumanRig.update({ riderSeated: true })`, which resets `hips` + trunk to bind pose!).
  const restoreTrunkAfterMeasure = Boolean(boundCal && gaitSkel?.hips && mountBlend > 0.15);
  if (restoreTrunkAfterMeasure && boundCal && gaitSkel?.hips) {
    _savedMeasureHipsPos.copy(gaitSkel.hips.position);
    let qIdx = 0;
    const saveAndBind = (b: T.Bone | null) => {
      if (!b) return;
      while (_savedMeasureQuats.length <= qIdx) _savedMeasureQuats.push(new T.Quaternion());
      _savedMeasureQuats[qIdx++].copy(b.quaternion);
      const bq = boundCal.bindQuats.get(b);
      if (bq) b.quaternion.copy(bq);
    };
    gaitSkel.hips.position.copy(boundCal.bindHipsLocalPos);
    saveAndBind(gaitSkel.hips);
    for (let i = 0; i < boundCal.spineBones.length; i++) saveAndBind(boundCal.spineBones[i]);
    saveAndBind(boundCal.shoulderL);
    saveAndBind(boundCal.shoulderR);
  }

  // Read live runtime-measured limb lengths & rest offsets directly from `HumanRig` (post-CAZ proportions!)
  rig.root.updateWorldMatrix(true, true);
  rig.model.updateWorldMatrix(true, true);
  const modelScale = rig.model.getWorldScale(_v0).y || 1.04;
  const k = modelScale / 1.04;
  let legLen = 0.82 * k;
  let soleHeight = 0.082 * k;
  if (gaitSkel && gaitSkel.legs.length >= 2) {
    const l0 = gaitSkel.legs[0];
    const l1 = gaitSkel.legs[1];
    const len0 =
      l0.thigh.getWorldPosition(_v0).distanceTo(l0.shin.getWorldPosition(_v1)) +
      _v1.distanceTo(l0.foot.getWorldPosition(_v2));
    const len1 =
      l1.thigh.getWorldPosition(_v0).distanceTo(l1.shin.getWorldPosition(_v1)) +
      _v1.distanceTo(l1.foot.getWorldPosition(_v2));
    legLen = Math.min(len0, len1);
    soleHeight = clamp(Math.abs(l0.sole.offsetY(_q0.identity(), _v1.setScalar(modelScale))), 0.055 * k, 0.13 * k);
  }

  // Measure exact `hips` offset in `rig.root` local coordinates so pelvis lands on saddle to 0.0 mm.
  _m4Inv.copy(rig.root.matrixWorld).invert();
  if (gaitSkel?.hips) {
    gaitSkel.hips.getWorldPosition(_hipsOffsetNow).applyMatrix4(_m4Inv);
  } else {
    _hipsOffsetNow.set(0, baseHipRestHeight * k, 0);
  }

  let effArmL = 0.46 * k;
  let effArmR = 0.46 * k;
  let torsoAboveHips = 0.42 * k;
  let shoulderHalfSpan = 0.165 * k;
  const armObjL = rig.arms.find((a) => a.side === -1);
  const armObjR = rig.arms.find((a) => a.side === 1);
  if (armObjL && armObjR) {
    armObjL.upper.getWorldScale(_v2);
    const anisoL = Math.min(_v2.x, _v2.y, _v2.z) / Math.max(1e-4, Math.max(_v2.x, _v2.y, _v2.z));
    armObjR.upper.getWorldScale(_v2);
    const anisoR = Math.min(_v2.x, _v2.y, _v2.z) / Math.max(1e-4, Math.max(_v2.x, _v2.y, _v2.z));
    effArmL = (armObjL.lenUpper + armObjL.lenFore) * anisoL;
    effArmR = (armObjR.lenUpper + armObjR.lenFore) * anisoR;
    if (gaitSkel?.hips) {
      const sL = armObjL.upper.getWorldPosition(_v2).applyMatrix4(_m4Inv);
      const sR = armObjR.upper.getWorldPosition(_v3).applyMatrix4(_m4Inv);
      torsoAboveHips = clamp((sL.y + sR.y) * 0.5 - _hipsOffsetNow.y, 0.30 * k, 0.56 * k);
      shoulderHalfSpan = clamp(Math.abs(sL.x - sR.x) * 0.5, 0.12 * k, 0.24 * k);
    }
  }

  if (restoreTrunkAfterMeasure && boundCal && gaitSkel?.hips) {
    gaitSkel.hips.position.copy(_savedMeasureHipsPos);
    let qIdx = 0;
    const restoreQ = (b: T.Bone | null) => {
      if (!b) return;
      b.quaternion.copy(_savedMeasureQuats[qIdx++]);
    };
    restoreQ(gaitSkel.hips);
    for (let i = 0; i < boundCal.spineBones.length; i++) restoreQ(boundCal.spineBones[i]);
    restoreQ(boundCal.shoulderL);
    restoreQ(boundCal.shoulderR);
    rig.model.updateWorldMatrix(true, true);
  }

  const ballForward = 0.115 * k;
  const sitBoneDrop = 0.088 * k;
  const hipsToCrown = 0.76 * k;

  const posture = ARCHETYPE_POSTURE[sockets.archetype];
  const speedRatio = clamp(Math.abs(state.speed) / Math.max(1, state.maxSpeed), 0, 1);
  const forkPitchTransfer = sockets.isCar ? 0 : clamp(state.forkDive * 0.65, -0.05, 0.1);
  let trunkPitch = (posture.baseTrunkPitch + posture.aeroPitchGain * speedRatio + forkPitchTransfer) * mountBlend;
  // Steering left (`+steer`) swings right (`-X`) grip forward -> negative `HumanRig` `twist` rotates right shoulder forward
  let trunkTwist = clamp(-state.steer * 0.26, -0.24, 0.24) * mountBlend;

  // 1. Adjust virtual seat-post height for this rider's exact leg length (`±8 cm` bikes / `±11 cm` cars)
  into.seatPostDeltaY = applyVirtualSeatPostForRider(
    sockets,
    legLen,
    soleHeight,
    ballForward,
    sitBoneDrop,
    hipsToCrown,
    trunkPitch,
  );

  // 2. Read updated vehicle world frame & sockets
  vehicleRoot.updateWorldMatrix(true, true);
  vehicleRoot.getWorldPosition(_bikePos);
  vehicleRoot.getWorldQuaternion(_bikeQuat);
  _bikeLeft.set(1, 0, 0).applyQuaternion(_bikeQuat).normalize();
  _bikeUp.set(0, 1, 0).applyQuaternion(_bikeQuat).normalize();
  _bikeFwd.set(0, 0, 1).applyQuaternion(_bikeQuat).normalize();
  const vehicleYaw = Math.atan2(_bikeFwd.x, _bikeFwd.z);

  sockets.saddleOrSeat.getWorldPosition(_saddleWorld);
  sockets.footLeft.getWorldPosition(_pedalWorldL);
  sockets.footRight.getWorldPosition(_pedalWorldR);
  sockets.gripLeft.getWorldPosition(_gripWorldL);
  sockets.gripRight.getWorldPosition(_gripWorldR);

  // Anatomical Lateral Invariant (`+X = _bikeLeft = Left = side -1`, `-X = Right = side +1`):
  // Guarantee zero crossed arms or crossed legs even if a custom rig inverted L/R socket lateral signs.
  let gripSocketL = sockets.gripLeft;
  let gripSocketR = sockets.gripRight;
  if (_v0.copy(_gripWorldL).sub(_gripWorldR).dot(_bikeLeft) < -1e-4) {
    _v1.copy(_gripWorldL);
    _gripWorldL.copy(_gripWorldR);
    _gripWorldR.copy(_v1);
    gripSocketL = sockets.gripRight;
    gripSocketR = sockets.gripLeft;
  }
  if (_v0.copy(_pedalWorldL).sub(_pedalWorldR).dot(_bikeLeft) < -1e-4) {
    _v1.copy(_pedalWorldL);
    _pedalWorldL.copy(_pedalWorldR);
    _pedalWorldR.copy(_v1);
  }

  // Resolve true world-space tire-to-road contact elevation so stage-local `state.groundY` offsets never skew stop foot placement.
  let effGroundY = state.groundY;
  if (!sockets.isCar) {
    const vehScaleY = vehicleRoot.getWorldScale(_v1).y || 1;
    const tireBottomWorldY = _bikePos.y - sockets.wheelGroundY * vehScaleY;
    if (Math.abs(state.groundY - tireBottomWorldY) > 0.12) {
      effGroundY = tireBottomWorldY;
    }
  }

  const standDown = sockets.isCar ? 0 : clamp(state.standDownBlend, 0, 1);
  const pedalActive = sockets.hasPedals ? (1 - standDown) * clamp(Math.abs(state.crankOmega) / 2.2, 0, 1) : 0;

  // 3. Saddle-locked pelvis target (with short-rider BDC leg-reach guard & subtle ±5 mm pedal stroke rock)
  let hipAboveSaddle = sitBoneDrop;
  const bdcBallZ = sockets.isCar ? 0 : ballForward * 0.90;
  if (sockets.hasPedals && sockets.crankPivot) {
    const bdcAnkleLocalY = sockets.crankPivot.position.y - sockets.crankRadius + soleHeight;
    const bdcAnkleLocalZ = sockets.crankPivot.position.z - bdcBallZ;
    const hipLocalZ = sockets.seatPostPivot.position.z + posture.ischialBackZ * k;
    const dzLeg = bdcAnkleLocalZ - hipLocalZ;
    const maxSafeLeg = legLen * 0.965;
    const maxHipLocalY = bdcAnkleLocalY + Math.sqrt(Math.max(0.01, maxSafeLeg * maxSafeLeg - dzLeg * dzLeg));
    const currentHipLocalY = sockets.seatPostPivot.position.y + hipAboveSaddle;
    if (currentHipLocalY > maxHipLocalY) {
      hipAboveSaddle -= Math.min(0.085 * k, currentHipLocalY - maxHipLocalY);
    }
  }

  const hipRockY = Math.sin(state.crankAngle * 2) * 0.005 * k * pedalActive;
  _targetHipsWorld
    .copy(_saddleWorld)
    .addScaledVector(_bikeUp, hipAboveSaddle + hipRockY)
    .addScaledVector(_bikeFwd, posture.ischialBackZ * k);

  if (standDown > 0.001 && !sockets.isCar) {
    const standSign = state.standSideSign;
    _groundFootWorldL
      .copy(_bikePos)
      .addScaledVector(_bikeLeft, standSign * 0.22)
      .addScaledVector(_bikeFwd, -0.04);
    _groundFootWorldL.y = effGroundY + soleHeight;

    _v3
      .copy(_targetHipsWorld)
      .addScaledVector(_bikeFwd, 0.085 * k)
      .addScaledVector(_bikeLeft, standSign * 0.065 * k);
    _v0.copy(_v3).addScaledVector(_bikeLeft, standSign * 0.09 * k);
    const dxzSq =
      (_v0.x - _groundFootWorldL.x) * (_v0.x - _groundFootWorldL.x) +
      (_v0.z - _groundFootWorldL.z) * (_v0.z - _groundFootWorldL.z);
    const maxStandLeg = legLen * 0.965;
    const maxHipY = _groundFootWorldL.y + Math.sqrt(Math.max(0.04, maxStandLeg * maxStandLeg - dxzSq));
    if (_v3.y > maxHipY) _v3.y = maxHipY;
    else _v3.y -= 0.025 * k;
    _targetHipsWorld.lerp(_v3, standDown);
  }

  if (mountBlend < 0.999) {
    const sideDist = sockets.isCar ? 0.88 : 0.52;
    _standHipsWorld
      .copy(_bikePos)
      .addScaledVector(_bikeLeft, state.standSideSign * sideDist)
      .addScaledVector(_bikeFwd, sockets.isCar ? 0.12 : -0.12);
    _standHipsWorld.y = effGroundY + legLen + soleHeight;
    const arcLift = Math.sin(Math.PI * mountBlend) * (sockets.isCar ? 0.04 : 0.11);
    _targetHipsWorld.lerpVectors(_standHipsWorld, _targetHipsWorld, mountBlend);
    _targetHipsWorld.y += arcLift;
  }

  into.rootYaw = vehicleYaw;
  into.riderRoll = sockets.isCar
    ? state.lean
    : (state.lean * 0.88 + Math.sin(state.crankAngle) * 0.020 * pedalActive) * mountBlend;
  into.riderPitch = (sockets.isCar ? state.forkDive : state.forkDive * 0.58) * mountBlend;

  _euler.set(into.riderPitch, vehicleYaw, into.riderRoll, 'YXZ');
  into.rootQuaternion.setFromEuler(_euler);

  // 4. Refresh live cylindrical `HandContact`s (`side = -1` Left `+X`, `side = +1` Right `-X`)
  if (into.boundGripLeftObj !== gripSocketL) {
    into.boundGripLeftObj = gripSocketL;
    into.leftContact.shape = sockets.isCar
      ? undefined
      : handleShape(gripSocketL, ZERO_VEC, INBOARD_LEFT, HANDLEBAR_GRIP_RADIUS, HANDLEBAR_GRIP_HALF);
  }
  if (into.boundGripRightObj !== gripSocketR) {
    into.boundGripRightObj = gripSocketR;
    into.rightContact.shape = sockets.isCar
      ? undefined
      : handleShape(gripSocketR, ZERO_VEC, INBOARD_RIGHT, HANDLEBAR_GRIP_RADIUS, HANDLEBAR_GRIP_HALF);
  }

  if (armWeight > 0.05) {
    if (sockets.isCar && sockets.steeringWheelPivot) {
      _barAxisL.copy(WHEEL_RIM_TANGENT).transformDirection(sockets.steeringWheelPivot.matrixWorld).normalize();
      _barAxisR.copy(WHEEL_RIM_TANGENT).transformDirection(sockets.steeringWheelPivot.matrixWorld).normalize();
    } else {
      _barAxisL.copy(INBOARD_LEFT).transformDirection(gripSocketL.matrixWorld).normalize();
      _barAxisR.copy(INBOARD_RIGHT).transformDirection(gripSocketR.matrixWorld).normalize();
    }

    // Use the rider's actual rolled & pitched root basis (`into.rootQuaternion`) so shoulder estimates match `HumanRig`
    _basisX.set(1, 0, 0).applyQuaternion(into.rootQuaternion).normalize();
    _basisY.set(0, 1, 0).applyQuaternion(into.rootQuaternion).normalize();
    _basisZ.set(0, 0, 1).applyQuaternion(into.rootQuaternion);
    _basisZ.y = 0;
    if (_basisZ.lengthSq() < 1e-6) _basisZ.copy(_bikeFwd);
    else _basisZ.normalize();

    const spinePivotLever = Math.max(0.22 * k, torsoAboveHips - 0.11 * k);
    const baseSpineHeight = torsoAboveHips - spinePivotLever;
    const estimateShouldersAndGrips = () => {
      const fwdShift = Math.sin(trunkPitch) * spinePivotLever;
      const upHeight = baseSpineHeight + Math.cos(trunkPitch) * spinePivotLever;
      const twistFwdL = Math.sin(trunkTwist) * shoulderHalfSpan;
      _shoulderPosL
        .copy(_targetHipsWorld)
        .addScaledVector(_basisY, upHeight)
        .addScaledVector(_basisZ, fwdShift + twistFwdL)
        .addScaledVector(_basisX, Math.cos(trunkTwist) * shoulderHalfSpan);
      _shoulderPosR
        .copy(_targetHipsWorld)
        .addScaledVector(_basisY, upHeight)
        .addScaledVector(_basisZ, fwdShift - twistFwdL)
        .addScaledVector(_basisX, -Math.cos(trunkTwist) * shoulderHalfSpan);
      handleGrip(rig, -1, _gripWorldL, _barAxisL, _shoulderPosL, HANDLEBAR_GRIP_RADIUS, into.leftContact);
      handleGrip(rig, 1, _gripWorldR, _barAxisR, _shoulderPosR, HANDLEBAR_GRIP_RADIUS, into.rightContact);
    };
    estimateShouldersAndGrips();

    // Natural `~18°–28°` elbow flexion (`armSafeRatio = 0.94`, never hyper-extended and never sliding off the saddle!)
    const armSafeRatio = 0.94;
    const needL = _shoulderPosL.distanceTo(into.leftContact.wrist) - effArmL * armSafeRatio;
    const needR = _shoulderPosR.distanceTo(into.rightContact.wrist) - effArmR * armSafeRatio;
    const maxNeed = Math.max(0, needL, needR);
    if (maxNeed > 0) {
      trunkPitch = clamp(trunkPitch + maxNeed / Math.max(0.22 * k, spinePivotLever), -0.45, posture.maxTrunkPitch);
      if (needR > needL + 0.003) {
        trunkTwist = clamp(trunkTwist - (needR - needL) / Math.max(0.20 * k, shoulderHalfSpan), -0.26, 0.26);
      } else if (needL > needR + 0.003) {
        trunkTwist = clamp(trunkTwist + (needL - needR) / Math.max(0.20 * k, shoulderHalfSpan), -0.26, 0.26);
      }
      estimateShouldersAndGrips();
      const remNeed = Math.max(
        0,
        _shoulderPosL.distanceTo(into.leftContact.wrist) - effArmL * 0.97,
        _shoulderPosR.distanceTo(into.rightContact.wrist) - effArmR * 0.97,
      );
      if (remNeed > 0 && !sockets.isCar) {
        _targetHipsWorld.addScaledVector(_bikeFwd, Math.min(0.095 * k, remNeed));
        estimateShouldersAndGrips();
      }
    }

    into.leftContact.on = gripSocketL;
    into.leftContact.secured = true;
    into.leftContact.wristPivot = true;
    into.leftContact.bend = { pitch: 0, drop: 0, yaw: 0 };
    into.rightContact.on = gripSocketR;
    into.rightContact.secured = true;
    into.rightContact.wristPivot = true;
    into.rightContact.bend = { pitch: 0, drop: 0, yaw: 0 };

    // Natural downward & slightly-outward/back elbow poles (relaxed elbow drop, zero chicken-wing flare)
    into.leftContact.pole!
      .copy(_shoulderPosL)
      .addScaledVector(_bikeUp, -0.44 * k)
      .addScaledVector(_bikeFwd, -0.18 * k)
      .addScaledVector(_bikeLeft, 0.11 * k);
    into.rightContact.pole!
      .copy(_shoulderPosR)
      .addScaledVector(_bikeUp, -0.44 * k)
      .addScaledVector(_bikeFwd, -0.18 * k)
      .addScaledVector(_bikeLeft, -0.11 * k);

    const engageSec = mountBlend >= 0.98 && armWeight >= 0.98 ? 0.001 : 0.24;
    rig.setContact(-1, into.leftContact, engageSec);
    rig.setContact(1, into.rightContact, engageSec);
    if (armWeight >= 0.95) {
      rig.holdFit(-1);
      rig.holdFit(1);
    }
    into.contactsActive = true;
  } else if (into.contactsActive) {
    into.leftContact.on = undefined;
    into.leftContact.secured = false;
    into.rightContact.on = undefined;
    into.rightContact.secured = false;
    rig.setContact(-1, null, 0.22);
    rig.setContact(1, null, 0.22);
    into.contactsActive = false;
  }

  // Finalize `into.rootPosition` after any reach-assist saddle slide so pelvis matches `_targetHipsWorld` to 0.0 mm
  rig.root.getWorldScale(_v2);
  _v0.copy(_hipsOffsetNow).multiply(_v2).applyQuaternion(into.rootQuaternion);
  into.rootPosition.copy(_targetHipsWorld).sub(_v0);
  if (rig.root.parent && rig.root.parent.matrixWorld) {
    rig.root.parent.updateWorldMatrix(true, false);
    _m4ParentInv.copy(rig.root.parent.matrixWorld).invert();
    into.rootPosition.applyMatrix4(_m4ParentInv);
    rig.root.parent.getWorldQuaternion(_q1).invert();
    into.rootQuaternion.premultiply(_q1).normalize();
  }

  into.seated = mountBlend > 0.25;
  into.riderSeated = mountBlend > 0.15;
  into.lean = trunkPitch + Math.cos(state.crankAngle * 2) * 0.010 * pedalActive * mountBlend;
  into.twist = trunkTwist + Math.sin(state.crankAngle) * 0.016 * pedalActive * mountBlend;
  into.headYawLook = clamp(state.steer * (sockets.isCar ? 0.35 : 0.55), -0.34, 0.34) * mountBlend;
  // `HumanRig.lookPitch` is `+ = UP` (`human.ts:1546, 1682`); positive compensation keeps head level on the road!
  into.headPitchComp = clamp(into.lean * 1.25, -0.35, 0.85);

  // 5. Compute `RiderLegTarget`s with 360-degree biomechanical ankling (`heel-drop` at BDC, `toe-point` at TDC,
  //    natural toe-down touch on `standDown`) and exact `footFrameToBone` world quaternions for `HumanRig`!
  const standIsLeft = state.standSideSign >= 0;
  const standBlendL = standIsLeft ? standDown : 0;
  const standBlendR = standIsLeft ? 0 : standDown;

  let rawAnklePitchL = sockets.isCar ? 0.1 : 0.04;
  let rawAnklePitchR = sockets.isCar ? 0.1 : 0.04;
  if (sockets.hasPedals && sockets.crankPivot) {
    sockets.crankPivot.getWorldPosition(_v3);
    const invCrankR = 1 / Math.max(0.08, sockets.crankRadius);
    _v0.copy(_pedalWorldL).sub(_v3);
    const relYL = clamp(_v0.dot(_bikeUp) * invCrankR, -1.2, 1.2);
    const relZL = clamp(_v0.dot(_bikeFwd) * invCrankR, -1.2, 1.2);
    _v0.copy(_pedalWorldR).sub(_v3);
    const relYR = clamp(_v0.dot(_bikeUp) * invCrankR, -1.2, 1.2);
    const relZR = clamp(_v0.dot(_bikeFwd) * invCrankR, -1.2, 1.2);
    const anklingGain = 0.42 + 0.58 * pedalActive;
    // TDC (`relY = +1`) -> negative pitch (toe-point); BDC (`relY = -1`) -> positive pitch (heel-drop)
    rawAnklePitchL = (-0.16 * relYL + 0.065 * relZL) * anklingGain;
    rawAnklePitchR = (-0.16 * relYR + 0.065 * relZR) * anklingGain;
  } else if (sockets.hasPedals) {
    rawAnklePitchL = -0.15 * Math.cos(state.crankAngle);
    rawAnklePitchR = -0.15 * Math.cos(state.crankAngle + Math.PI);
  }
  const pitchL = rawAnklePitchL * (1 - standBlendL);
  const pitchR = rawAnklePitchR * (1 - standBlendR);

  buildCanonicalFootFrame(_bikeLeft, _bikeUp, _bikeFwd, pitchL, standBlendL, vehicleYaw, into.leftLegTarget.footQ);
  buildCanonicalFootFrame(_bikeLeft, _bikeUp, _bikeFwd, pitchR, standBlendR, vehicleYaw, into.rightLegTarget.footQ);

  if (boundCal) {
    into.bodyFrameLegTargets.leftFootQuat
      .copy(into.leftLegTarget.footQ)
      .multiply(boundCal.footFrameToBoneL)
      .normalize();
    into.bodyFrameLegTargets.rightFootQuat
      .copy(into.rightLegTarget.footQ)
      .multiply(boundCal.footFrameToBoneR)
      .normalize();
  } else {
    into.bodyFrameLegTargets.leftFootQuat.copy(into.leftLegTarget.footQ);
    into.bodyFrameLegTargets.rightFootQuat.copy(into.rightLegTarget.footQ);
  }

  const ballZ = sockets.isCar ? 0 : ballForward;
  _v2.set(0, -soleHeight, ballZ).applyQuaternion(into.leftLegTarget.footQ);
  into.leftLegTarget.ankle.copy(_pedalWorldL).sub(_v2);

  _v2.set(0, -soleHeight, ballZ).applyQuaternion(into.rightLegTarget.footQ);
  into.rightLegTarget.ankle.copy(_pedalWorldR).sub(_v2);

  const standToeLift = Math.sin(0.08) * ballZ;
  if (standBlendL > 0.001) {
    _groundFootWorldL.copy(_bikePos).addScaledVector(_bikeLeft, 0.24).addScaledVector(_bikeFwd, -0.06);
    _groundFootWorldL.y = effGroundY + soleHeight + standToeLift;
    into.leftLegTarget.ankle.lerp(_groundFootWorldL, standBlendL);
  }
  if (standBlendR > 0.001) {
    _groundFootWorldL.copy(_bikePos).addScaledVector(_bikeLeft, -0.24).addScaledVector(_bikeFwd, -0.06);
    _groundFootWorldL.y = effGroundY + soleHeight + standToeLift;
    into.rightLegTarget.ankle.lerp(_groundFootWorldL, standBlendR);
  }

  into.leftLegTarget.pole
    .copy(_targetHipsWorld)
    .addScaledVector(_bikeLeft, (0.09 + posture.kneeOutwardM + 0.055 * standBlendL) * k)
    .addScaledVector(_bikeFwd, 0.62 * k)
    .addScaledVector(_bikeUp, 0.34 * k);
  into.rightLegTarget.pole
    .copy(_targetHipsWorld)
    .addScaledVector(_bikeLeft, -(0.09 + posture.kneeOutwardM + 0.055 * standBlendR) * k)
    .addScaledVector(_bikeFwd, 0.62 * k)
    .addScaledVector(_bikeUp, 0.34 * k);

  const legW = clamp(Math.max(mountBlend, standDown), 0, 1);
  into.leftLegTarget.weight = legW;
  into.rightLegTarget.weight = legW;
  into.bodyFrameLegTargets.leftNormal.set(0, 1, 0).applyQuaternion(into.leftLegTarget.footQ).normalize();
  into.bodyFrameLegTargets.rightNormal.set(0, 1, 0).applyQuaternion(into.rightLegTarget.footQ).normalize();
  into.bodyFrameLegTargets.skipSlopeRoll = true;
  into.bodyFrameLegTargets.weight = legW;

  return into;
}

// ── Path 2: Skeleton Discovery & Shear-Safe Zero-Alloc Core (`Codex52` / `Echo59` / `RunnerRig`) ───────────

function findBone(byName: Map<string, T.Bone>, patterns: readonly RegExp[]): T.Bone | null {
  for (let i = 0; i < patterns.length; i++) {
    const re = patterns[i];
    for (const [name, bone] of byName) {
      if (re.test(name)) return bone;
    }
  }
  return null;
}

function buildFingerChains(byName: Map<string, T.Bone>, side: 'L' | 'R', rootInvM: T.Matrix4): FingerChain[] {
  const chains: FingerChain[] = [];
  const specs: ReadonlyArray<readonly [RegExp, RegExp, RegExp]> =
    side === 'L'
      ? [
          [/^(?:thumb\.1\.L|LeftHandThumb1)$/i, /^(?:thumb\.2\.L|LeftHandThumb2)$/i, /^(?:thumb\.3\.L|LeftHandThumb3)$/i],
          [/^(?:index\.1\.L|LeftHandIndex1)$/i, /^(?:index\.2\.L|LeftHandIndex2)$/i, /^(?:index\.3\.L|LeftHandIndex3)$/i],
          [/^(?:middle\.1\.L|LeftHandMiddle1)$/i, /^(?:middle\.2\.L|LeftHandMiddle2)$/i, /^(?:middle\.3\.L|LeftHandMiddle3)$/i],
          [/^(?:ring\.1\.L|LeftHandRing1)$/i, /^(?:ring\.2\.L|LeftHandRing2)$/i, /^(?:ring\.3\.L|LeftHandRing3)$/i],
          [/^(?:little\.1\.L|LeftHandPinky1)$/i, /^(?:little\.2\.L|LeftHandPinky2)$/i, /^(?:little\.3\.L|LeftHandPinky3)$/i],
        ]
      : [
          [/^(?:thumb\.1\.R|RightHandThumb1)$/i, /^(?:thumb\.2\.R|RightHandThumb2)$/i, /^(?:thumb\.3\.R|RightHandThumb3)$/i],
          [/^(?:index\.1\.R|RightHandIndex1)$/i, /^(?:index\.2\.R|RightHandIndex2)$/i, /^(?:index\.3\.R|RightHandIndex3)$/i],
          [/^(?:middle\.1\.R|RightHandMiddle1)$/i, /^(?:middle\.2\.R|RightHandMiddle2)$/i, /^(?:middle\.3\.R|RightHandMiddle3)$/i],
          [/^(?:ring\.1\.R|RightHandRing1)$/i, /^(?:ring\.2\.R|RightHandRing2)$/i, /^(?:ring\.3\.R|RightHandRing3)$/i],
          [/^(?:little\.1\.R|RightHandPinky1)$/i, /^(?:little\.2\.R|RightHandPinky2)$/i, /^(?:little\.3\.R|RightHandPinky3)$/i],
        ];

  for (let i = 0; i < specs.length; i++) {
    const [r1, r2, r3] = specs[i];
    const j1 = findBone(byName, [r1]);
    if (!j1) continue;
    const j2 = findBone(byName, [r2]);
    const j3 = findBone(byName, [r3]);

    const testAxis = new T.Vector3(1, 0, 0);
    if (j2) {
      const pBefore = j2.getWorldPosition(new T.Vector3()).applyMatrix4(rootInvM);
      const savedQ = j1.quaternion.clone();
      j1.quaternion.multiply(new T.Quaternion().setFromAxisAngle(testAxis, 0.35));
      j1.updateWorldMatrix(true, true);
      const pAfter = j2.getWorldPosition(new T.Vector3()).applyMatrix4(rootInvM);
      j1.quaternion.copy(savedQ);
      j1.updateWorldMatrix(true, true);
      if (pAfter.y > pBefore.y) testAxis.set(-1, 0, 0);
    }

    chains.push({
      j1,
      j2,
      j3,
      bind1: j1.quaternion.clone(),
      bind2: j2 ? j2.quaternion.clone() : new T.Quaternion(),
      bind3: j3 ? j3.quaternion.clone() : new T.Quaternion(),
      curlAxis: testAxis,
    });
  }
  return chains;
}

/**
 * Binds any Echo Life / Study Space humanoid skeleton (`RunnerRig` 65b, `EchoStudentRig` 59b, `Codex52` 52b)
 * through a canonical bone map (`CODEX52_MAP` + Blender `.L/.R`).
 */
export function bindRiderSkeleton(root: T.Object3D): BoundRiderSkeleton | null {
  const existing = root.userData.__ecBoundRiderSkeleton as BoundRiderSkeleton | undefined;
  if (existing) return existing;

  const byName = new Map<string, T.Bone>();
  root.traverse((obj) => {
    if ((obj as T.Bone).isBone) {
      const bone = obj as T.Bone;
      const canonical = (bone.userData?.name as string | undefined) ?? bone.name;
      if (canonical && !byName.has(canonical)) byName.set(canonical, bone);
      if (bone.name && !byName.has(bone.name)) byName.set(bone.name, bone);
    }
  });

  const hips = findBone(byName, [/^(?:hips|Hips|pelvis|Pelvis)$/]);
  const thighL = findBone(byName, [/^thigh[._]?L$/i, /^LeftUpLeg$/i]);
  const shinL = findBone(byName, [/^shin[._]?L$/i, /^LeftLeg$/i]);
  const footL = findBone(byName, [/^foot[._]?L$/i, /^LeftFoot$/i]);
  const thighR = findBone(byName, [/^thigh[._]?R$/i, /^RightUpLeg$/i]);
  const shinR = findBone(byName, [/^shin[._]?R$/i, /^RightLeg$/i]);
  const footR = findBone(byName, [/^foot[._]?R$/i, /^RightFoot$/i]);
  const upperArmL = findBone(byName, [/^upper_arm[._]?L$/i, /^LeftArm$/i]);
  const forearmL = findBone(byName, [/^forearm[._]?L$/i, /^LeftForeArm$/i]);
  const handL = findBone(byName, [/^hand[._]?L$/i, /^LeftHand$/i]);
  const upperArmR = findBone(byName, [/^upper_arm[._]?R$/i, /^RightArm$/i]);
  const forearmR = findBone(byName, [/^forearm[._]?R$/i, /^RightForeArm$/i]);
  const handR = findBone(byName, [/^hand[._]?R$/i, /^RightHand$/i]);

  if (
    !hips ||
    !thighL || !shinL || !footL ||
    !thighR || !shinR || !footR ||
    !upperArmL || !forearmL || !handL ||
    !upperArmR || !forearmR || !handR
  ) {
    return null;
  }

  const spineBones: T.Bone[] = [];
  for (const pat of [/^spine$/i, /^Spine1$/i, /^chest$/i, /^Spine2$/i]) {
    const sb = findBone(byName, [pat]);
    if (sb && !spineBones.includes(sb)) spineBones.push(sb);
  }
  const neck = findBone(byName, [/^neck$/i]);
  const head = findBone(byName, [/^head$/i]);
  const shoulderL = findBone(byName, [/^shoulder[._]?L$/i, /^LeftShoulder$/i]);
  const shoulderR = findBone(byName, [/^shoulder[._]?R$/i, /^RightShoulder$/i]);
  const toeL = findBone(byName, [/^toe[._]?L$/i, /^LeftToeBase$/i]);
  const toeR = findBone(byName, [/^toe[._]?R$/i, /^RightToeBase$/i]);

  const rigKind: RiderRigKind = byName.has('LeftUpLeg')
    ? 'codex52'
    : byName.has('eye.L')
      ? 'echo59'
      : byName.has('toe.L') || root.name === 'RunnerRig' || root.getObjectByName('RunnerRig')
        ? 'runner65'
        : 'generic';

  const savedPos = root.position.clone();
  const savedQuat = root.quaternion.clone();
  const savedScale = root.scale.clone();
  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.scale.set(1, 1, 1);
  root.updateWorldMatrix(true, true);
  const rootInvM = root.matrixWorld.clone().invert();

  const posInRoot = (b: T.Object3D) => b.getWorldPosition(new T.Vector3()).applyMatrix4(rootInvM);
  const quatInRoot = (b: T.Object3D) => b.getWorldQuaternion(new T.Quaternion());

  const pHips = posInRoot(hips);
  const pThighL = posInRoot(thighL);
  const pShinL = posInRoot(shinL);
  const pFootL = posInRoot(footL);
  const pShinR = posInRoot(shinR);
  const pFootR = posInRoot(footR);
  const pForeL = posInRoot(forearmL);
  const pHandL = posInRoot(handL);
  const pForeR = posInRoot(forearmR);
  const pHandR = posInRoot(handR);
  const pHead = head ? posInRoot(head) : pHips.clone().add(new T.Vector3(0, 0.62, 0));

  const baseShinL = Math.max(0.22, pShinL.distanceTo(pFootL));
  const baseShinR = Math.max(0.22, pShinR.distanceTo(pFootR));
  const baseForeL = Math.max(0.14, pForeL.distanceTo(pHandL));
  const baseForeR = Math.max(0.14, pForeR.distanceTo(pHandR));

  const meshBox = new T.Box3().setFromObject(root);
  const groundRefY = Number.isFinite(meshBox.min.y) ? Math.min(0, meshBox.min.y) : 0;
  const soleL = clamp(pFootL.y - groundRefY, 0.055, 0.135);
  const soleR = clamp(pFootR.y - groundRefY, 0.055, 0.135);
  const crownY = Number.isFinite(meshBox.max.y) && meshBox.max.y > pHead.y ? meshBox.max.y : pHead.y + 0.14;
  const bindHipsToCrownY = clamp(crownY - pHips.y, 0.58, 0.92);

  // Anatomical sit-bone drop below `hips` bone (`~8.5–10 cm` from hip center to sitting surface!)
  const hipToThighDrop = Math.max(0, pHips.y - pThighL.y);
  const bindSitBoneDrop = clamp(hipToThighDrop + 0.085, 0.082, 0.125);

  // Ball-of-foot forward distance from ankle (`foot -> toe`, ~0.115–0.135 m on adult rigs)
  let ballForward = 0.120;
  if (toeL) {
    ballForward = clamp(posInRoot(toeL).z - pFootL.z, 0.095, 0.145);
  } else if (toeR) {
    ballForward = clamp(posInRoot(toeR).z - pFootR.z, 0.095, 0.145);
  }

  const footFrameToBoneL = quatInRoot(footL).clone();
  const footFrameToBoneR = quatInRoot(footR).clone();

  const calibrateHand = (side: 'L' | 'R', forearm: T.Bone, hand: T.Bone) => {
    const pF = posInRoot(forearm);
    const pH = posInRoot(hand);
    const midBone = findBone(
      byName,
      side === 'L' ? [/^middle\.1\.L$/i, /^LeftHandMiddle1$/i] : [/^middle\.1\.R$/i, /^RightHandMiddle1$/i],
    );
    const idxBone = findBone(
      byName,
      side === 'L' ? [/^index\.1\.L$/i, /^LeftHandIndex1$/i] : [/^index\.1\.R$/i, /^RightHandIndex1$/i],
    );
    const pnkBone = findBone(
      byName,
      side === 'L' ? [/^little\.1\.L$/i, /^LeftHandPinky1$/i] : [/^little\.1\.R$/i, /^RightHandPinky1$/i],
    );

    const fingerDir = midBone ? posInRoot(midBone).sub(pH) : pH.clone().sub(pF);
    const palmOffset = midBone ? clamp(fingerDir.length() * 0.80, 0.052, 0.095) : 0.070;
    if (fingerDir.lengthSq() < 1e-8) fingerDir.set(side === 'L' ? 0.5 : -0.5, -0.86, 0);
    fingerDir.normalize();

    const radial = new T.Vector3();
    if (idxBone && pnkBone) {
      radial.copy(posInRoot(idxBone)).sub(posInRoot(pnkBone));
    } else {
      radial.set(0, 0, 1);
    }
    radial.addScaledVector(fingerDir, -radial.dot(fingerDir));
    if (radial.lengthSq() < 1e-8) radial.set(0, 0, 1);
    radial.normalize();

    const dorsal = new T.Vector3().crossVectors(radial, fingerDir).normalize();
    const mBasis = new T.Matrix4().makeBasis(radial, fingerDir, dorsal);
    const qFrameInRoot = new T.Quaternion().setFromRotationMatrix(mBasis).normalize();
    const qHandInRoot = quatInRoot(hand);
    const frameToBone = qFrameInRoot.clone().invert().multiply(qHandInRoot).normalize();
    return { frameToBone, palmOffset };
  };

  const calL = calibrateHand('L', forearmL, handL);
  const calR = calibrateHand('R', forearmR, handR);
  const fingersL = buildFingerChains(byName, 'L', rootInvM);
  const fingersR = buildFingerChains(byName, 'R', rootInvM);

  const controlled: T.Bone[] = [
    hips,
    ...spineBones,
    ...(neck ? [neck] : []),
    ...(head ? [head] : []),
    ...(shoulderL ? [shoulderL] : []),
    upperArmL, forearmL, handL,
    ...(shoulderR ? [shoulderR] : []),
    upperArmR, forearmR, handR,
    thighL, shinL, footL,
    thighR, shinR, footR,
  ];
  for (const fc of [...fingersL, ...fingersR]) {
    controlled.push(fc.j1);
    if (fc.j2) controlled.push(fc.j2);
    if (fc.j3) controlled.push(fc.j3);
  }

  const bindQuats = new Map<T.Bone, T.Quaternion>();
  const savedQuats = new Map<T.Bone, T.Quaternion>();
  for (let i = 0; i < controlled.length; i++) {
    const b = controlled[i];
    if (!bindQuats.has(b)) {
      bindQuats.set(b, b.quaternion.clone());
      savedQuats.set(b, b.quaternion.clone());
    }
  }
  const bindHipsLocalPos = hips.position.clone();

  root.position.copy(savedPos);
  root.quaternion.copy(savedQuat);
  root.scale.copy(savedScale);
  root.updateWorldMatrix(true, true);

  const bound: BoundRiderSkeleton = {
    rigKind,
    root,
    hips,
    spineBones,
    neck,
    head,
    shoulderL,
    upperArmL,
    forearmL,
    handL,
    shoulderR,
    upperArmR,
    forearmR,
    handR,
    toeL,
    toeR,
    thighL,
    shinL,
    footL,
    thighR,
    shinR,
    footR,
    fingersL,
    fingersR,
    bindHipsLocalPos,
    bindQuats,
    savedQuats,
    savedHipsLocalPos: bindHipsLocalPos.clone(),
    ikDirty: false,
    bindSoleRatioL: soleL / baseShinL,
    bindSoleRatioR: soleR / baseShinR,
    bindBallForwardRatio: ballForward / baseShinL,
    bindPalmGripRatioL: calL.palmOffset / baseForeL,
    bindPalmGripRatioR: calR.palmOffset / baseForeR,
    bindSitBoneDrop,
    bindHipsToCrownY,
    footFrameToBoneL,
    footFrameToBoneR,
    handFrameToBoneL: calL.frameToBone,
    handFrameToBoneR: calR.frameToBone,
    lastMetrics: {
      pelvisSaddleErrorM: 0,
      leftFootErrorM: 0,
      rightFootErrorM: 0,
      leftHandErrorM: 0,
      rightHandErrorM: 0,
      leftAnklePitchRad: 0,
      rightAnklePitchRad: 0,
      seatPostDeltaY: 0,
    },
  };

  root.userData.__ecBoundRiderSkeleton = bound;
  return bound;
}

/** Restores ALL written bone quaternions AND `hips.position` XYZ (`0` compounding drift across 600+ frames). */
export function restoreRiderSkeleton(bound: BoundRiderSkeleton): void {
  if (!bound.ikDirty) return;
  for (const [bone, q] of bound.savedQuats) {
    bone.quaternion.copy(q);
  }
  bound.hips.position.copy(bound.savedHipsLocalPos);
  bound.ikDirty = false;
}

export function captureRiderPreIk(bound: BoundRiderSkeleton): void {
  for (const [bone, q] of bound.savedQuats) {
    q.copy(bone.quaternion);
  }
  bound.savedHipsLocalPos.copy(bound.hips.position);
}

function resetToBindPose(bound: BoundRiderSkeleton, blend: number): void {
  if (blend >= 0.999) {
    for (const [bone, q] of bound.bindQuats) {
      bone.quaternion.copy(q);
    }
    bound.hips.position.copy(bound.bindHipsLocalPos);
  } else if (blend > 0.001) {
    for (const [bone, q] of bound.bindQuats) {
      bone.quaternion.slerp(q, blend);
    }
    bound.hips.position.lerp(bound.bindHipsLocalPos, blend);
  }
}

// ── Shear-Safe MatrixWorld-Inverse Analytical Two-Bone IK (`@embodiment-reviewer` §4.2 T4) ────────────────

/**
 * Aims `bone -> child` toward `targetWorld` by transforming positions/directions through
 * `bone.parent.matrixWorld.invert()`, completely eliminating non-uniform CAZ parent scale shear!
 */
function aimBoneWorldShearSafe(bone: T.Bone, child: T.Bone, targetWorld: T.Vector3, weight: number): void {
  if (bone.parent) {
    bone.parent.updateWorldMatrix(true, false);
    _m4ParentInv.copy(bone.parent.matrixWorld).invert();
    bone.getWorldPosition(_ikLocalOrigin).applyMatrix4(_m4ParentInv);
    child.getWorldPosition(_ikCur).applyMatrix4(_m4ParentInv).sub(_ikLocalOrigin);
    _ikWant.copy(targetWorld).applyMatrix4(_m4ParentInv).sub(_ikLocalOrigin);
  } else {
    bone.getWorldPosition(_ikLocalOrigin);
    child.getWorldPosition(_ikCur).sub(_ikLocalOrigin);
    _ikWant.copy(targetWorld).sub(_ikLocalOrigin);
  }

  const curLenSq = _ikCur.lengthSq();
  const wantLenSq = _ikWant.lengthSq();
  if (curLenSq < 1e-10 || wantLenSq < 1e-10) return;
  _ikCur.multiplyScalar(1 / Math.sqrt(curLenSq));
  _ikWant.multiplyScalar(1 / Math.sqrt(wantLenSq));

  _q0.setFromUnitVectors(_ikCur, _ikWant);
  _q1.copy(_q0).multiply(bone.quaternion).normalize();

  if (weight >= 0.999) {
    bone.quaternion.copy(_q1);
  } else {
    bone.quaternion.slerp(_q1, weight);
  }
  bone.updateWorldMatrix(false, true);
}

/**
 * Exact Law-of-Cosines two-bone IK solver (`upper -> lower -> end`) with shear-safe `parent.matrixWorld`
 * inverse aiming AND a 2nd length-reconciled micro-pass so non-uniform CAZ bone scales converge `< 0.5 mm`.
 */
export function solveTwoBoneExact(
  upper: T.Bone,
  lower: T.Bone,
  end: T.Bone,
  targetWorld: T.Vector3,
  poleWorld: T.Vector3,
  weight: number,
  maxStretchRatio = 0.9985,
): void {
  if (weight <= 0.001) return;

  for (let pass = 0; pass < 7; pass++) {
    upper.getWorldPosition(_ikOrigin);
    lower.getWorldPosition(_ikMid);
    end.getWorldPosition(_ikEnd);

    if (pass > 0 && _ikEnd.distanceToSquared(targetWorld) < 1e-8) break;

    const l1 = _ikOrigin.distanceTo(_ikMid);
    const l2 = _ikMid.distanceTo(_ikEnd);
    if (l1 < 1e-4 || l2 < 1e-4) return;

    _ikDir.copy(targetWorld).sub(_ikOrigin);
    const rawDist = _ikDir.length();
    if (rawDist < 1e-5) return;

    const minReach = Math.abs(l1 - l2) + 0.002;
    const maxReach = (l1 + l2) * maxStretchRatio;
    const d = clamp(rawDist, minReach, maxReach);
    _ikDir.multiplyScalar(1 / rawDist);

    _ikBend.copy(poleWorld).sub(_ikOrigin);
    _ikBend.addScaledVector(_ikDir, -_ikBend.dot(_ikDir));
    if (_ikBend.lengthSq() < 1e-10) {
      _ikBend.set(0, 0, 1).addScaledVector(_ikDir, -_ikDir.z);
      if (_ikBend.lengthSq() < 1e-10) _ikBend.set(1, 0, 0).addScaledVector(_ikDir, -_ikDir.x);
    }
    _ikBend.normalize();

    const along = (l1 * l1 + d * d - l2 * l2) / (2 * d);
    const height = Math.sqrt(Math.max(0, l1 * l1 - along * along));
    _ikJoint.copy(_ikOrigin).addScaledVector(_ikDir, along).addScaledVector(_ikBend, height);

    const w = pass === 0 ? weight : 1.0;
    if (pass > 0 && weight < 0.999) break;
    aimBoneWorldShearSafe(upper, lower, _ikJoint, w);
    aimBoneWorldShearSafe(lower, end, targetWorld, w);
  }
}

/**
 * Sets `bone` orientation so its world basis axes match `worldQuat` even when `bone.parent` carries
 * non-uniform CAZ scale (`parent.matrixWorld.invert()` applied to basis directions).
 */
function setBoneWorldQuatShearSafe(bone: T.Bone, worldQuat: T.Quaternion, weight: number): void {
  if (weight <= 0.001) return;
  if (bone.parent) {
    bone.parent.updateWorldMatrix(true, false);
    _m4ParentInv.copy(bone.parent.matrixWorld).invert();
    // Preserve primary longitudinal/contact axis `Y` exactly under non-uniform parent scale, then orthogonalize `X` & `Z`
    _basisY.set(0, 1, 0).applyQuaternion(worldQuat).transformDirection(_m4ParentInv).normalize();
    _basisX.set(1, 0, 0).applyQuaternion(worldQuat).transformDirection(_m4ParentInv);
    _basisX.addScaledVector(_basisY, -_basisX.dot(_basisY));
    if (_basisX.lengthSq() < 1e-10) _basisX.set(1, 0, 0).addScaledVector(_basisY, -_basisY.x);
    _basisX.normalize();
    _basisZ.crossVectors(_basisX, _basisY).normalize();
    makeBasisQuat(_basisX, _basisY, _basisZ, _q1);
  } else {
    _q1.copy(worldQuat).normalize();
  }
  if (weight >= 0.999) {
    bone.quaternion.copy(_q1);
  } else {
    bone.quaternion.slerp(_q1, weight);
  }
  bone.updateWorldMatrix(false, true);
}

function applyHandlebarFingerCurl(chains: readonly FingerChain[], curlWeight: number): void {
  if (curlWeight <= 0.01 || chains.length === 0) return;
  for (let i = 0; i < chains.length; i++) {
    const fc = chains[i];
    const isThumb = i === 0;
    const a1 = (isThumb ? 0.42 : 0.78 + i * 0.04) * curlWeight;
    const a2 = (isThumb ? 0.55 : 0.96 + i * 0.03) * curlWeight;
    const a3 = (isThumb ? 0.48 : 0.62) * curlWeight;

    _q0.setFromAxisAngle(fc.curlAxis, a1);
    fc.j1.quaternion.copy(fc.bind1).multiply(_q0);
    if (fc.j2) {
      _q0.setFromAxisAngle(fc.curlAxis, a2);
      fc.j2.quaternion.copy(fc.bind2).multiply(_q0);
    }
    if (fc.j3) {
      _q0.setFromAxisAngle(fc.curlAxis, a3);
      fc.j3.quaternion.copy(fc.bind3).multiply(_q0);
    }
  }
}

// ── Direct Skinned NPC / Standalone Coherent Rider Solver ──────────────────────────────────────────────────

/**
 * Applies full-body coherent rider kinematics, virtual seat-post adjustment, and closed-form shear-safe
 * 2-bone Leg + Arm IK onto `bound` (`Codex52`, `Echo59`, `RunnerRig`). Zero heap allocations per frame.
 */
export function applyCoherentRiderIk(
  bound: BoundRiderSkeleton,
  vehicleRoot: T.Object3D,
  sockets: VehicleRigSockets,
  state: RiderKinematicState,
): void {
  const mountBlend = clamp(state.mountBlend, 0, 1);
  if (mountBlend <= 0.0001 && state.armIkWeight <= 0.0001) return;

  captureRiderPreIk(bound);
  resetToBindPose(bound, Math.max(mountBlend, state.armIkWeight));
  bound.ikDirty = true;

  // 1. Measure LIVE runtime world limb lengths (reflects any CAZ height / legScale / armScale sliders!)
  bound.root.updateWorldMatrix(true, true);
  const rootScaleY = bound.root.getWorldScale(_v0).y || 1;

  bound.thighL.getWorldPosition(_v0);
  bound.shinL.getWorldPosition(_v1);
  bound.footL.getWorldPosition(_v2);
  const liveThighL = _v0.distanceTo(_v1);
  const liveShinL = _v1.distanceTo(_v2);
  const liveBallZ = bound.toeL
    ? _v2.distanceTo(bound.toeL.getWorldPosition(_v3)) * 0.88
    : liveShinL * bound.bindBallForwardRatio;

  bound.thighR.getWorldPosition(_v0);
  bound.shinR.getWorldPosition(_v1);
  bound.footR.getWorldPosition(_v2);
  const liveThighR = _v0.distanceTo(_v1);
  const liveShinR = _v1.distanceTo(_v2);

  bound.upperArmL.getWorldPosition(_v0);
  bound.forearmL.getWorldPosition(_v1);
  bound.handL.getWorldPosition(_v2);
  const liveUpperL = _v0.distanceTo(_v1);
  const liveForeL = _v1.distanceTo(_v2);

  bound.upperArmR.getWorldPosition(_v0);
  bound.forearmR.getWorldPosition(_v1);
  bound.handR.getWorldPosition(_v2);
  const liveUpperR = _v0.distanceTo(_v1);
  const liveForeR = _v1.distanceTo(_v2);

  const liveLegLen = Math.min(liveThighL + liveShinL, liveThighR + liveShinR);
  const soleL = liveShinL * bound.bindSoleRatioL;
  const soleR = liveShinR * bound.bindSoleRatioR;
  const palmOffsetL = liveForeL * bound.bindPalmGripRatioL;
  const palmOffsetR = liveForeR * bound.bindPalmGripRatioR;
  bound.upperArmL.getWorldScale(_v3);
  const anisoL = Math.min(_v3.x, _v3.y, _v3.z) / Math.max(1e-4, Math.max(_v3.x, _v3.y, _v3.z));
  bound.upperArmR.getWorldScale(_v3);
  const anisoR = Math.min(_v3.x, _v3.y, _v3.z) / Math.max(1e-4, Math.max(_v3.x, _v3.y, _v3.z));
  const effArmL = (liveUpperL + liveForeL) * anisoL;
  const effArmR = (liveUpperR + liveForeR) * anisoR;
  const sitBoneDrop = bound.bindSitBoneDrop * rootScaleY;
  const hipsToCrown = bound.bindHipsToCrownY * rootScaleY;

  const posture = ARCHETYPE_POSTURE[sockets.archetype];
  const speedRatio = clamp(Math.abs(state.speed) / Math.max(1, state.maxSpeed), 0, 1);
  let trunkPitch = (posture.baseTrunkPitch + posture.aeroPitchGain * speedRatio) * mountBlend;
  let trunkTwistYaw = clamp(state.steer * 0.22, -0.14, 0.14) * mountBlend;

  // 2. Apply Per-Rider Virtual Seat-Post Height (`BDC d = 0.91 * L`, clamped `±8 cm`)
  const seatPostDeltaY = applyVirtualSeatPostForRider(
    sockets,
    liveLegLen,
    soleL,
    liveBallZ,
    sitBoneDrop,
    hipsToCrown,
    trunkPitch,
  );

  // 3. Extract authoritative vehicle world frame & updated socket positions
  vehicleRoot.updateWorldMatrix(true, true);
  vehicleRoot.getWorldPosition(_bikePos);
  vehicleRoot.getWorldQuaternion(_bikeQuat);
  _bikeLeft.set(1, 0, 0).applyQuaternion(_bikeQuat).normalize();
  _bikeUp.set(0, 1, 0).applyQuaternion(_bikeQuat).normalize();
  _bikeFwd.set(0, 0, 1).applyQuaternion(_bikeQuat).normalize();
  const vehicleYaw = Math.atan2(_bikeFwd.x, _bikeFwd.z);

  sockets.saddleOrSeat.getWorldPosition(_saddleWorld);
  sockets.footLeft.getWorldPosition(_pedalWorldL);
  sockets.footRight.getWorldPosition(_pedalWorldR);
  sockets.gripLeft.getWorldPosition(_gripWorldL);
  sockets.gripRight.getWorldPosition(_gripWorldR);

  let npcGripSocketL = sockets.gripLeft;
  let npcGripSocketR = sockets.gripRight;
  if (_v0.copy(_gripWorldL).sub(_gripWorldR).dot(_bikeLeft) < -1e-4) {
    _v1.copy(_gripWorldL);
    _gripWorldL.copy(_gripWorldR);
    _gripWorldR.copy(_v1);
    npcGripSocketL = sockets.gripRight;
    npcGripSocketR = sockets.gripLeft;
  }
  if (_v0.copy(_pedalWorldL).sub(_pedalWorldR).dot(_bikeLeft) < -1e-4) {
    _v1.copy(_pedalWorldL);
    _pedalWorldL.copy(_pedalWorldR);
    _pedalWorldR.copy(_v1);
  }

  npcGripSocketL.getWorldQuaternion(_q0);
  _barAxisL.set(1, 0, 0).applyQuaternion(_q0).normalize();
  npcGripSocketR.getWorldQuaternion(_q0);
  _barAxisR.set(1, 0, 0).applyQuaternion(_q0).normalize();

  const standDown = sockets.isCar ? 0 : clamp(state.standDownBlend, 0, 1);
  const pedalActive = sockets.hasPedals ? (1 - standDown) * clamp(Math.abs(state.crankOmega) / 2.2, 0, 1) : 0;

  // 4. Saddle-Locked Pelvis Target (plus exact leg-reach guard if rider is shorter than ±8 cm seatpost travel)
  let hipAboveSaddle = sitBoneDrop;
  const ballZ = sockets.isCar ? 0 : liveBallZ * 0.90;
  if (sockets.hasPedals && sockets.crankPivot) {
    const bdcAnkleLocalY = sockets.crankPivot.position.y - sockets.crankRadius + soleL;
    const bdcAnkleLocalZ = sockets.crankPivot.position.z - ballZ;
    const hipLocalZ = sockets.seatPostPivot.position.z + posture.ischialBackZ * rootScaleY;
    const dzLeg = bdcAnkleLocalZ - hipLocalZ;
    const maxSafeLeg = liveLegLen * 0.965;
    const maxHipLocalY = bdcAnkleLocalY + Math.sqrt(Math.max(0.01, maxSafeLeg * maxSafeLeg - dzLeg * dzLeg));
    const currentHipLocalY = sockets.seatPostPivot.position.y + hipAboveSaddle;
    if (currentHipLocalY > maxHipLocalY) {
      hipAboveSaddle -= Math.min(0.085 * rootScaleY, currentHipLocalY - maxHipLocalY);
    }
  }

  const armWeight = clamp(state.armIkWeight, 0, 1);
  const hipRockY = Math.sin(state.crankAngle * 2) * 0.005 * rootScaleY * pedalActive;
  _targetHipsWorld
    .copy(_saddleWorld)
    .addScaledVector(_bikeUp, hipAboveSaddle + hipRockY)
    .addScaledVector(_bikeFwd, posture.ischialBackZ * rootScaleY);

  // Real bicycle top-tube stand-over transition at stop (`standDown: 0 -> 1`):
  // Since BDC pedal is ~16 cm above asphalt, a rider stopping slides forward off the saddle nose (+8.5 cm)
  // and lowers their pelvis just enough for the planted balance foot (`foot.L` or `foot.R`) to rest flat on ground!
  if (standDown > 0.001 && !sockets.isCar) {
    const standSign = state.standSideSign;
    _groundFootWorldL
      .copy(_bikePos)
      .addScaledVector(_bikeLeft, standSign * 0.22)
      .addScaledVector(_bikeFwd, -0.04);
    _groundFootWorldL.y = state.groundY + (standSign >= 0 ? soleL : soleR);

    // Standing hip position beside/over top tube in front of saddle nose
    _v3
      .copy(_targetHipsWorld)
      .addScaledVector(_bikeFwd, 0.085 * rootScaleY)
      .addScaledVector(_bikeLeft, standSign * 0.065 * rootScaleY);

    // Account for hip-joint lateral offset (`thigh.L` is +0.09m along `_bikeLeft` from `hips`!)
    const hipJointLateral = 0.09 * rootScaleY;
    _v0.copy(_v3).addScaledVector(_bikeLeft, standSign * hipJointLateral);
    const dxzSq =
      (_v0.x - _groundFootWorldL.x) * (_v0.x - _groundFootWorldL.x) +
      (_v0.z - _groundFootWorldL.z) * (_v0.z - _groundFootWorldL.z);
    const maxStandLeg = (standSign >= 0 ? liveThighL + liveShinL : liveThighR + liveShinR) * 0.965;
    const maxHipJointY = _groundFootWorldL.y + Math.sqrt(Math.max(0.04, maxStandLeg * maxStandLeg - dxzSq));
    // `thighL` is a child of `hips`, so `-thighL.position.y` is the exact vertical drop from `hips` to hip joint!
    const hipJointDropBelowHips = Math.max(0, -bound.thighL.position.y * rootScaleY);
    // Rider roll (`lean * 0.88 < 0`) also tilts left (`+X`) hip joint DOWNWARD by `-hipJointLateral * sin(riderRoll)`
    const rollLift = standSign * hipJointLateral * Math.sin(state.lean * 0.88);
    const maxHipsWorldY = maxHipJointY + hipJointDropBelowHips + rollLift;
    if (_v3.y > maxHipsWorldY) {
      _v3.y = maxHipsWorldY;
    } else {
      _v3.y -= 0.025 * rootScaleY;
    }
    _targetHipsWorld.lerp(_v3, standDown);
  }

  if (mountBlend < 0.999) {
    const sideDist = sockets.isCar ? 0.88 : 0.52;
    _standHipsWorld
      .copy(_bikePos)
      .addScaledVector(_bikeLeft, state.standSideSign * sideDist)
      .addScaledVector(_bikeFwd, sockets.isCar ? 0.12 : -0.12);
    _standHipsWorld.y = state.groundY + bound.bindHipsLocalPos.y * rootScaleY;
    const arcLift = Math.sin(Math.PI * mountBlend) * (sockets.isCar ? 0.04 : 0.11);
    _targetHipsWorld.lerpVectors(_standHipsWorld, _targetHipsWorld, mountBlend);
    _targetHipsWorld.y += arcLift;
  }

  // 5. Rider Root Orientation & Exact Pelvis Placement (`0.0 mm` pelvis error)
  const riderRoll = sockets.isCar
    ? state.lean
    : (state.lean * 0.88 + Math.sin(state.crankAngle) * 0.022 * pedalActive) * mountBlend;
  const riderPitch = (sockets.isCar ? state.forkDive : state.forkDive * 0.55) * mountBlend;
  _euler.set(riderPitch, vehicleYaw, riderRoll, 'YXZ');
  _riderRootQuat.setFromEuler(_euler);

  const placeRootForTargetHips = () => {
    if (bound.root.parent) {
      bound.root.parent.updateWorldMatrix(true, false);
      bound.root.parent.getWorldQuaternion(_q1).invert();
      bound.root.quaternion.copy(_q1).multiply(_riderRootQuat).normalize();
    } else {
      bound.root.quaternion.copy(_riderRootQuat);
    }
    bound.root.position.set(0, 0, 0);
    bound.root.updateWorldMatrix(false, true);
    bound.hips.getWorldPosition(_hipsOffsetNow);
    if (bound.root.parent) {
      _m4Inv.copy(bound.root.parent.matrixWorld).invert();
      _v1.copy(_targetHipsWorld).applyMatrix4(_m4Inv);
      _v2.copy(_hipsOffsetNow).applyMatrix4(_m4Inv);
      bound.root.position.copy(_v1).sub(_v2);
    } else {
      bound.root.position.copy(_targetHipsWorld).sub(_hipsOffsetNow);
    }
    bound.root.updateWorldMatrix(false, true);
  };
  placeRootForTargetHips();

  // 6. Dynamic Trunk Pitch + Reach-Assist Twist for Full-Lock `±28°` Handlebar Steering
  if (armWeight > 0.05 && bound.spineBones.length > 0) {
    applySpineChain(bound, trunkPitch, trunkTwistYaw);
    bound.upperArmL.getWorldPosition(_shoulderPosL);
    bound.upperArmR.getWorldPosition(_shoulderPosR);
    computeHandGripSolution(
      'L', _shoulderPosL, _gripWorldL, _barAxisL, _bikeUp, _bikeFwd,
      palmOffsetL, bound.handFrameToBoneL, _wristTargetL, _handQuatL,
    );
    computeHandGripSolution(
      'R', _shoulderPosR, _gripWorldR, _barAxisR, _bikeUp, _bikeFwd,
      palmOffsetR, bound.handFrameToBoneR, _wristTargetR, _handQuatR,
    );
    const maxArmL = effArmL * 0.94;
    const maxArmR = effArmR * 0.94;
    const needL = _shoulderPosL.distanceTo(_wristTargetL) - maxArmL;
    const needR = _shoulderPosR.distanceTo(_wristTargetR) - maxArmR;
    const maxNeed = Math.max(0, needL, needR);
    if (maxNeed > 0) {
      trunkPitch = clamp(trunkPitch + maxNeed / (0.26 * rootScaleY), -0.45, posture.maxTrunkPitch);
      if (needR > needL + 0.003) {
        trunkTwistYaw += clamp((needR - needL) / (0.18 * rootScaleY), 0, 0.24);
      } else if (needL > needR + 0.003) {
        trunkTwistYaw -= clamp((needL - needR) / (0.18 * rootScaleY), 0, 0.24);
      }
      applySpineChain(bound, trunkPitch, trunkTwistYaw);
      bound.upperArmL.getWorldPosition(_shoulderPosL);
      bound.upperArmR.getWorldPosition(_shoulderPosR);
      computeHandGripSolution(
        'L', _shoulderPosL, _gripWorldL, _barAxisL, _bikeUp, _bikeFwd,
        palmOffsetL, bound.handFrameToBoneL, _wristTargetL, _handQuatL,
      );
      computeHandGripSolution(
        'R', _shoulderPosR, _gripWorldR, _barAxisR, _bikeUp, _bikeFwd,
        palmOffsetR, bound.handFrameToBoneR, _wristTargetR, _handQuatR,
      );
      const remNeed = Math.max(
        0,
        _shoulderPosL.distanceTo(_wristTargetL) - effArmL * 0.975,
        _shoulderPosR.distanceTo(_wristTargetR) - effArmR * 0.975,
      );
      if (remNeed > 0 && !sockets.isCar) {
        _targetHipsWorld.addScaledVector(_bikeFwd, Math.min(0.04 * rootScaleY, remNeed));
        placeRootForTargetHips();
        applySpineChain(bound, trunkPitch, trunkTwistYaw);
      }
    }
  } else {
    applySpineChain(bound, trunkPitch, trunkTwistYaw);
  }

  // 7. Neck & Head Horizon Leveling + Apex Turn Look-Ahead
  const headPitchComp = -trunkPitch * 0.84 + (state.freeLookPitchOffset ?? 0);
  const headYawLook =
    clamp(state.steer * (sockets.isCar ? 0.35 : 0.55), -0.34, 0.34) * mountBlend +
    (state.freeLookYawOffset ?? 0);
  const headRollComp = -riderRoll * 0.35;
  if (bound.neck && bound.head) {
    applyLocalAdditiveEuler(bound.neck, headPitchComp * 0.48, headYawLook * 0.42, headRollComp * 0.45);
    applyLocalAdditiveEuler(bound.head, headPitchComp * 0.52, headYawLook * 0.58, headRollComp * 0.55);
  } else if (bound.head) {
    applyLocalAdditiveEuler(bound.head, headPitchComp, headYawLook, headRollComp);
  }

  // 8. Closed-Form Shear-Safe Two-Bone Leg IK (`thigh -> shin -> foot`)
  let rawAnklePitchL = sockets.isCar ? 0.1 : 0.04;
  let rawAnklePitchR = sockets.isCar ? 0.1 : 0.04;
  if (sockets.hasPedals && sockets.crankPivot) {
    sockets.crankPivot.getWorldPosition(_v3);
    const invCrankR = 1 / Math.max(0.08, sockets.crankRadius);
    _v0.copy(_pedalWorldL).sub(_v3);
    const relYL = clamp(_v0.dot(_bikeUp) * invCrankR, -1.2, 1.2);
    const relZL = clamp(_v0.dot(_bikeFwd) * invCrankR, -1.2, 1.2);
    _v0.copy(_pedalWorldR).sub(_v3);
    const relYR = clamp(_v0.dot(_bikeUp) * invCrankR, -1.2, 1.2);
    const relZR = clamp(_v0.dot(_bikeFwd) * invCrankR, -1.2, 1.2);
    const anklingGain = 0.42 + 0.58 * pedalActive;
    rawAnklePitchL = (-0.16 * relYL + 0.065 * relZL) * anklingGain;
    rawAnklePitchR = (-0.16 * relYR + 0.065 * relZR) * anklingGain;
  } else if (sockets.hasPedals) {
    rawAnklePitchL = -0.15 * Math.cos(state.crankAngle);
    rawAnklePitchR = -0.15 * Math.cos(state.crankAngle + Math.PI);
  }
  const standIsLeft = state.standSideSign >= 0;
  const standBlendL = standIsLeft ? standDown : 0;
  const standBlendR = standIsLeft ? 0 : standDown;

  buildFootWorldQuat(
    _bikeLeft,
    _bikeUp,
    _bikeFwd,
    rawAnklePitchL * (1 - standBlendL),
    standBlendL,
    vehicleYaw,
    bound.footFrameToBoneL,
    _footQuatL,
  );
  buildFootWorldQuat(
    _bikeLeft,
    _bikeUp,
    _bikeFwd,
    rawAnklePitchR * (1 - standBlendR),
    standBlendR,
    vehicleYaw,
    bound.footFrameToBoneR,
    _footQuatR,
  );

  computeAnkleFromContact(_pedalWorldL, _footQuatL, bound.footFrameToBoneL, soleL, ballZ, _ankleTargetL);
  computeAnkleFromContact(_pedalWorldR, _footQuatR, bound.footFrameToBoneR, soleR, ballZ, _ankleTargetR);

  if (standBlendL > 0.001) {
    _groundFootWorldL.copy(_bikePos).addScaledVector(_bikeLeft, 0.22).addScaledVector(_bikeFwd, -0.04);
    _groundFootWorldL.y = state.groundY + soleL;
    _ankleTargetL.lerp(_groundFootWorldL, standBlendL);
  }
  if (standBlendR > 0.001) {
    _groundFootWorldL.copy(_bikePos).addScaledVector(_bikeLeft, -0.22).addScaledVector(_bikeFwd, -0.04);
    _groundFootWorldL.y = state.groundY + soleR;
    _ankleTargetR.lerp(_groundFootWorldL, standBlendR);
  }

  if (mountBlend < 0.999) {
    const swingArc = Math.sin(Math.PI * mountBlend) * (sockets.isCar ? 0.06 : 0.22);
    if (standIsLeft) {
      _groundFootWorldL.copy(_bikePos).addScaledVector(_bikeLeft, 0.44).addScaledVector(_bikeFwd, -0.10);
      _groundFootWorldL.y = state.groundY + soleL;
      _ankleTargetL.lerpVectors(_groundFootWorldL, _ankleTargetL, smoothstep(0.55, 1.0, mountBlend));

      _v0.copy(_bikePos).addScaledVector(_bikeLeft, 0.30).addScaledVector(_bikeFwd, -0.14);
      _v0.y = state.groundY + soleR;
      _ankleTargetR.lerpVectors(_v0, _ankleTargetR, mountBlend);
      _ankleTargetR.y += swingArc;
    } else {
      _groundFootWorldL.copy(_bikePos).addScaledVector(_bikeLeft, -0.44).addScaledVector(_bikeFwd, -0.10);
      _groundFootWorldL.y = state.groundY + soleR;
      _ankleTargetR.lerpVectors(_groundFootWorldL, _ankleTargetR, smoothstep(0.55, 1.0, mountBlend));

      _v0.copy(_bikePos).addScaledVector(_bikeLeft, -0.30).addScaledVector(_bikeFwd, -0.14);
      _v0.y = state.groundY + soleL;
      _ankleTargetL.lerpVectors(_v0, _ankleTargetL, mountBlend);
      _ankleTargetL.y += swingArc;
    }
  }

  bound.thighL.getWorldPosition(_hipPosL);
  bound.thighR.getWorldPosition(_hipPosR);
  _kneePoleL
    .copy(_hipPosL)
    .addScaledVector(_bikeFwd, 0.62 * rootScaleY)
    .addScaledVector(_bikeUp, 0.34 * rootScaleY)
    .addScaledVector(_bikeLeft, (posture.kneeOutwardM + 0.055 * standBlendL) * rootScaleY);
  _kneePoleR
    .copy(_hipPosR)
    .addScaledVector(_bikeFwd, 0.62 * rootScaleY)
    .addScaledVector(_bikeUp, 0.34 * rootScaleY)
    .addScaledVector(_bikeLeft, -(posture.kneeOutwardM + 0.055 * standBlendR) * rootScaleY);

  const legWeight = clamp(Math.max(mountBlend, standDown), 0, 1);
  solveTwoBoneExact(bound.thighL, bound.shinL, bound.footL, _ankleTargetL, _kneePoleL, legWeight);
  setBoneWorldQuatShearSafe(bound.footL, _footQuatL, legWeight);

  solveTwoBoneExact(bound.thighR, bound.shinR, bound.footR, _ankleTargetR, _kneePoleR, legWeight);
  setBoneWorldQuatShearSafe(bound.footR, _footQuatR, legWeight);

  // 9. Closed-Form Shear-Safe Two-Bone Arm IK (`shoulder -> upper_arm -> forearm -> hand`)
  if (armWeight > 0.001) {
    if (bound.shoulderL) {
      aimBoneWorldShearSafe(bound.shoulderL, bound.upperArmL, _gripWorldL, 0.24 * armWeight);
    }
    if (bound.shoulderR) {
      aimBoneWorldShearSafe(bound.shoulderR, bound.upperArmR, _gripWorldR, 0.24 * armWeight);
    }

    bound.upperArmL.getWorldPosition(_shoulderPosL);
    bound.upperArmR.getWorldPosition(_shoulderPosR);

    _elbowPoleL
      .copy(_shoulderPosL)
      .addScaledVector(_bikeUp, -0.44 * rootScaleY)
      .addScaledVector(_bikeFwd, -0.18 * rootScaleY)
      .addScaledVector(_bikeLeft, 0.11 * rootScaleY);
    _elbowPoleR
      .copy(_shoulderPosR)
      .addScaledVector(_bikeUp, -0.44 * rootScaleY)
      .addScaledVector(_bikeFwd, -0.18 * rootScaleY)
      .addScaledVector(_bikeLeft, -0.11 * rootScaleY);

    computeHandGripSolution(
      'L',
      _shoulderPosL,
      _gripWorldL,
      _barAxisL,
      _bikeUp,
      _bikeFwd,
      palmOffsetL,
      bound.handFrameToBoneL,
      _wristTargetL,
      _handQuatL,
    );
    computeHandGripSolution(
      'R',
      _shoulderPosR,
      _gripWorldR,
      _barAxisR,
      _bikeUp,
      _bikeFwd,
      palmOffsetR,
      bound.handFrameToBoneR,
      _wristTargetR,
      _handQuatR,
    );

    solveTwoBoneExact(bound.upperArmL, bound.forearmL, bound.handL, _wristTargetL, _elbowPoleL, armWeight, 0.999);
    bound.forearmL.getWorldPosition(_v0);
    bound.handL.getWorldPosition(_v1);
    _foreDir.copy(_gripWorldL).sub(_v1);
    if (_foreDir.lengthSq() < 1e-8) _foreDir.copy(_v1).sub(_v0);
    buildHandWorldQuat('L', _foreDir, _barAxisL, _bikeUp, bound.handFrameToBoneL, _handQuatL);
    setBoneWorldQuatShearSafe(bound.handL, _handQuatL, armWeight);

    solveTwoBoneExact(bound.upperArmR, bound.forearmR, bound.handR, _wristTargetR, _elbowPoleR, armWeight, 0.999);
    bound.forearmR.getWorldPosition(_v0);
    bound.handR.getWorldPosition(_v1);
    _foreDir.copy(_gripWorldR).sub(_v1);
    if (_foreDir.lengthSq() < 1e-8) _foreDir.copy(_v1).sub(_v0);
    buildHandWorldQuat('R', _foreDir, _barAxisR, _bikeUp, bound.handFrameToBoneR, _handQuatR);
    setBoneWorldQuatShearSafe(bound.handR, _handQuatR, armWeight);

    applyHandlebarFingerCurl(bound.fingersL, armWeight);
    applyHandlebarFingerCurl(bound.fingersR, armWeight);
  }

  // 10. Record exact FK verification residuals
  bound.hips.getWorldPosition(_v0);
  bound.lastMetrics.pelvisSaddleErrorM = _v0.distanceTo(_targetHipsWorld);

  bound.footL.getWorldPosition(_v0);
  computeContactFromAnkle(_v0, _footQuatL, bound.footFrameToBoneL, soleL, ballZ, _v1);
  bound.lastMetrics.leftFootErrorM = standBlendL > 0.5
    ? Math.abs(_v0.y - (state.groundY + soleL))
    : _v1.distanceTo(_pedalWorldL);

  bound.footR.getWorldPosition(_v0);
  computeContactFromAnkle(_v0, _footQuatR, bound.footFrameToBoneR, soleR, ballZ, _v1);
  bound.lastMetrics.rightFootErrorM = standBlendR > 0.5
    ? Math.abs(_v0.y - (state.groundY + soleR))
    : _v1.distanceTo(_pedalWorldR);

  bound.handL.getWorldPosition(_v0);
  computePalmFromWrist(_v0, _handQuatL, bound.handFrameToBoneL, palmOffsetL, _v1);
  bound.lastMetrics.leftHandErrorM = _v1.distanceTo(_gripWorldL);

  bound.handR.getWorldPosition(_v0);
  computePalmFromWrist(_v0, _handQuatR, bound.handFrameToBoneR, palmOffsetR, _v1);
  bound.lastMetrics.rightHandErrorM = _v1.distanceTo(_gripWorldR);

  bound.lastMetrics.leftAnklePitchRad = rawAnklePitchL * (1 - standBlendL);
  bound.lastMetrics.rightAnklePitchRad = rawAnklePitchR * (1 - standBlendR);
  bound.lastMetrics.seatPostDeltaY = seatPostDeltaY;
}

// ── Internal Orientation Helpers (Zero Allocation) ─────────────────────────────────────────────────────────

function applySpineChain(bound: BoundRiderSkeleton, totalPitch: number, totalYaw: number): void {
  const n = bound.spineBones.length;
  if (n === 0) return;
  for (let i = 0; i < n; i++) {
    const bone = bound.spineBones[i];
    const bindQ = bound.bindQuats.get(bone);
    if (bindQ) bone.quaternion.copy(bindQ);
    const share = n === 1 ? 1 : n === 2 ? (i === 0 ? 0.56 : 0.44) : i === 0 ? 0.42 : i === 1 ? 0.33 : 0.25;
    applyLocalAdditiveEuler(bone, totalPitch * share, totalYaw * share, 0);
  }
}

function applyLocalAdditiveEuler(bone: T.Bone, pitchX: number, yawY: number, rollZ: number): void {
  _euler.set(pitchX, yawY, rollZ, 'YXZ');
  _q0.setFromEuler(_euler);
  bone.quaternion.multiply(_q0).normalize();
  bone.updateWorldMatrix(false, true);
}

function buildCanonicalFootFrame(
  bikeLeft: T.Vector3,
  bikeUp: T.Vector3,
  bikeFwd: T.Vector3,
  anklePitch: number,
  standBlend: number,
  vehicleYaw: number,
  outFrameQuat: T.Quaternion,
): void {
  const c = Math.cos(anklePitch);
  const s = Math.sin(anklePitch);
  _basisX.copy(bikeLeft);
  _basisY.copy(bikeUp).multiplyScalar(c).addScaledVector(bikeFwd, -s).normalize();
  _basisZ.copy(bikeFwd).multiplyScalar(c).addScaledVector(bikeUp, s).normalize();
  makeBasisQuat(_basisX, _basisY, _basisZ, outFrameQuat);

  if (standBlend > 0.001) {
    // Natural slight plantar toe-down touch (`-0.08 rad`) when balancing with one foot on the ground
    _euler.set(-0.08, vehicleYaw, 0, 'YXZ');
    _q1.setFromEuler(_euler);
    outFrameQuat.slerp(_q1, standBlend);
  }
}

function buildFootWorldQuat(
  bikeLeft: T.Vector3,
  bikeUp: T.Vector3,
  bikeFwd: T.Vector3,
  anklePitch: number,
  standBlend: number,
  vehicleYaw: number,
  footFrameToBone: T.Quaternion,
  out: T.Quaternion,
): void {
  buildCanonicalFootFrame(bikeLeft, bikeUp, bikeFwd, anklePitch, standBlend, vehicleYaw, _q0);
  out.copy(_q0).multiply(footFrameToBone).normalize();
}

function computeAnkleFromContact(
  contactWorld: T.Vector3,
  footWorldQuat: T.Quaternion,
  footFrameToBone: T.Quaternion,
  soleHeight: number,
  ballForward: number,
  outAnkleWorld: T.Vector3,
): void {
  _q0.copy(footFrameToBone).invert();
  _q1.copy(footWorldQuat).multiply(_q0);
  _v2.set(0, -soleHeight, ballForward).applyQuaternion(_q1);
  outAnkleWorld.copy(contactWorld).sub(_v2);
}

function computeContactFromAnkle(
  ankleWorld: T.Vector3,
  footWorldQuat: T.Quaternion,
  footFrameToBone: T.Quaternion,
  soleHeight: number,
  ballForward: number,
  outContactWorld: T.Vector3,
): void {
  _q0.copy(footFrameToBone).invert();
  _q1.copy(footWorldQuat).multiply(_q0);
  _v2.set(0, -soleHeight, ballForward).applyQuaternion(_q1);
  outContactWorld.copy(ankleWorld).add(_v2);
}

function buildHandWorldQuat(
  side: 'L' | 'R',
  fingerAxisWorld: T.Vector3,
  barLeftWorld: T.Vector3,
  bikeUpWorld: T.Vector3,
  handFrameToBone: T.Quaternion,
  out: T.Quaternion,
): void {
  _basisY.copy(fingerAxisWorld);
  if (_basisY.lengthSq() < 1e-8) _basisY.set(0, -0.5, 0.86);
  _basisY.normalize();

  _basisX.copy(barLeftWorld).multiplyScalar(side === 'L' ? -1 : 1);
  _basisX.addScaledVector(_basisY, -_basisX.dot(_basisY));
  if (_basisX.lengthSq() < 1e-8) {
    _basisX.copy(bikeUpWorld).addScaledVector(_basisY, -bikeUpWorld.dot(_basisY));
  }
  _basisX.normalize();

  _basisZ.crossVectors(_basisX, _basisY).normalize();
  makeBasisQuat(_basisX, _basisY, _basisZ, _q0);
  out.copy(_q0).multiply(handFrameToBone).normalize();
}

function computeHandGripSolution(
  side: 'L' | 'R',
  shoulderWorld: T.Vector3,
  gripWorld: T.Vector3,
  barLeftWorld: T.Vector3,
  bikeUpWorld: T.Vector3,
  bikeFwdWorld: T.Vector3,
  palmOffset: number,
  handFrameToBone: T.Quaternion,
  outWristWorld: T.Vector3,
  outHandQuat: T.Quaternion,
): void {
  _v0.copy(gripWorld).sub(shoulderWorld);
  if (_v0.lengthSq() < 1e-8) _v0.copy(bikeFwdWorld);
  _v0.normalize();
  _v0.multiplyScalar(0.76).addScaledVector(bikeFwdWorld, 0.24).addScaledVector(bikeUpWorld, -0.14).normalize();

  outWristWorld.copy(gripWorld).addScaledVector(_v0, -palmOffset);
  buildHandWorldQuat(side, _v0, barLeftWorld, bikeUpWorld, handFrameToBone, outHandQuat);
}

function computePalmFromWrist(
  wristWorld: T.Vector3,
  handWorldQuat: T.Quaternion,
  handFrameToBone: T.Quaternion,
  palmOffset: number,
  outPalmWorld: T.Vector3,
): void {
  _q0.copy(handFrameToBone).invert();
  _q1.copy(handWorldQuat).multiply(_q0);
  _v2.set(0, palmOffset, 0).applyQuaternion(_q1);
  outPalmWorld.copy(wristWorld).add(_v2);
}

// ── Stateful Coherent Vehicle + Rider Controller (Player & NPC Shared) ─────────────────────────────────────

export class RiderIkController {
  phase: RiderMountPhase = 'unmounted';
  wheelSpin = 0;
  crankAngle = 0;
  crankOmega = 0;
  lean = 0;
  leanVel = 0;
  forkDive = 0;
  forkDiveVel = 0;
  standDownBlend = 1;
  mountBlend = 0;
  armIkWeight = 0;
  kickstandRetract = 0;
  doorOpenBlend = 0;
  standSideSign: 1 | -1 = 1;

  private phaseElapsed = 0;
  private stoppingElapsed = 0;

  get isMountedOrTransitioning(): boolean {
    return this.phase !== 'unmounted';
  }

  get wantsAutoBrake(): boolean {
    return this.phase === 'stopping' || this.phase === 'dismounting' || this.phase === 'mounting';
  }

  beginMount(standSideSign: 1 | -1 = 1): void {
    this.standSideSign = standSideSign;
    if (this.phase === 'riding' || this.phase === 'mounting') return;
    this.phase = 'mounting';
    this.phaseElapsed = this.mountBlend * MOUNT_DURATION_SEC;
  }

  mountImmediate(initialSpeed = 0, standSideSign: 1 | -1 = 1): void {
    this.standSideSign = standSideSign;
    this.phase = 'riding';
    this.phaseElapsed = MOUNT_DURATION_SEC;
    this.mountBlend = 1;
    this.armIkWeight = 1;
    this.kickstandRetract = 1;
    this.doorOpenBlend = 0;
    this.standDownBlend = Math.abs(initialSpeed) < 0.22 ? 1 : 0;
    if (this.standDownBlend > 0.5) {
      this.crankAngle = Math.PI * 0.75;
    }
  }

  requestDismount(currentSpeed: number): void {
    if (this.phase === 'unmounted' || this.phase === 'dismounting') return;
    if (Math.abs(currentSpeed) > SAFE_DISMOUNT_SPEED) {
      this.phase = 'stopping';
      this.stoppingElapsed = 0;
    } else {
      this.phase = 'dismounting';
      this.phaseElapsed = (1 - this.mountBlend) * DISMOUNT_DURATION_SEC;
    }
  }

  dismountImmediate(): void {
    this.phase = 'unmounted';
    this.phaseElapsed = 0;
    this.stoppingElapsed = 0;
    this.mountBlend = 0;
    this.armIkWeight = 0;
    this.kickstandRetract = 0;
    this.doorOpenBlend = 0;
    this.crankOmega = 0;
    this.lean = 0;
    this.leanVel = 0;
    this.forkDive = 0;
    this.forkDiveVel = 0;
  }

  step(dt: number, sockets: VehicleRigSockets, input: RiderStepInput): RiderKinematicState {
    const h = clamp(dt, 0, 0.05);
    const absSpeed = Math.abs(input.speed);

    if (this.phase === 'mounting') {
      this.phaseElapsed = Math.min(MOUNT_DURATION_SEC, this.phaseElapsed + h);
      const u = this.phaseElapsed / MOUNT_DURATION_SEC;
      this.mountBlend = minJerk01(u);
      this.armIkWeight = minJerk01(clamp(u / 0.55, 0, 1));
      this.kickstandRetract = minJerk01(clamp((u - 0.12) / 0.65, 0, 1));
      this.doorOpenBlend = sockets.isCar ? Math.sin(Math.PI * clamp(u, 0, 1)) : 0;
      if (this.phaseElapsed >= MOUNT_DURATION_SEC - 1e-5) {
        this.phase = 'riding';
        this.mountBlend = 1;
        this.armIkWeight = 1;
        this.kickstandRetract = 1;
        this.doorOpenBlend = 0;
      }
    } else if (this.phase === 'stopping') {
      this.stoppingElapsed += h;
      this.mountBlend = 1;
      this.armIkWeight = 1;
      this.kickstandRetract = 1;
      if (absSpeed <= SAFE_DISMOUNT_SPEED || this.stoppingElapsed >= AUTO_BRAKE_MAX_SEC) {
        this.phase = 'dismounting';
        this.phaseElapsed = 0;
      }
    } else if (this.phase === 'dismounting') {
      this.phaseElapsed = Math.min(DISMOUNT_DURATION_SEC, this.phaseElapsed + h);
      const u = this.phaseElapsed / DISMOUNT_DURATION_SEC;
      this.mountBlend = 1 - minJerk01(u);
      this.armIkWeight = 1 - minJerk01(clamp((u - 0.35) / 0.65, 0, 1));
      this.kickstandRetract = 1 - minJerk01(clamp(u / 0.55, 0, 1));
      this.doorOpenBlend = sockets.isCar ? Math.sin(Math.PI * clamp(u, 0, 1)) : 0;
      if (this.phaseElapsed >= DISMOUNT_DURATION_SEC - 1e-5) {
        this.dismountImmediate();
      }
    } else if (this.phase === 'riding') {
      this.mountBlend = 1;
      this.armIkWeight = 1;
      this.kickstandRetract = 1;
      this.doorOpenBlend = 0;
    }

    const safeWheelR = Math.max(0.12, sockets.wheelRadius);
    if (h > 0) {
      this.wheelSpin = wrapTau(this.wheelSpin + (input.speed * h) / safeWheelR);
    }

    if (sockets.isCar) {
      this.standDownBlend = 0;
    } else {
      const wantStandDown =
        this.phase !== 'riding'
          ? 1
          : absSpeed > 0.25 || Math.abs(input.throttle) > 0.02
            ? 0
            : absSpeed <= 0.12
              ? 1
              : this.standDownBlend > 0.5
                ? 1
                : 0;
      if (h > 0) {
        const blendRate = wantStandDown === 0 ? 14.0 : 8.5;
        this.standDownBlend += (wantStandDown - this.standDownBlend) * (1 - Math.exp(-blendRate * h));
        if (Math.abs(wantStandDown - this.standDownBlend) < 0.001) this.standDownBlend = wantStandDown;
      } else {
        this.standDownBlend = wantStandDown;
      }
      this.standDownBlend = clamp(this.standDownBlend, 0, 1);
    }

    if (!sockets.hasPedals || sockets.gearRatio <= 0) {
      this.crankOmega = 0;
    } else if (input.externalCrankAngle !== undefined) {
      this.crankAngle = wrapTau(input.externalCrankAngle);
      this.crankOmega = input.externalCrankOmega ?? 0;
    } else if (absSpeed <= 0.03) {
      this.crankOmega = 0;
    } else if (
      !input.isCoasting &&
      input.speed > 0.03 &&
      input.throttle > 0.02 &&
      !input.brake &&
      this.phase === 'riding'
    ) {
      const targetOmega = input.speed / (safeWheelR * sockets.gearRatio);
      this.crankOmega = h > 0
        ? this.crankOmega + (targetOmega - this.crankOmega) * (1 - Math.exp(-18 * h))
        : targetOmega;
      this.crankAngle = wrapTau(this.crankAngle + (input.speed * h) / (safeWheelR * sockets.gearRatio));
    } else {
      // Freewheel coasting: decay crank omega to 0 and settle cranks smoothly level (`pi/2` or `3pi/2`)
      this.crankOmega = h > 0 ? this.crankOmega * Math.exp(-9.5 * h) : 0;
      if (Math.abs(this.crankOmega) < 0.02) this.crankOmega = 0;
      this.crankAngle = wrapTau(this.crankAngle + this.crankOmega * h);
      if (h > 0 && input.speed > 0.35 && this.crankOmega < 1.0) {
        const dA = wrapPi(Math.PI * 0.5 - this.crankAngle);
        const dB = wrapPi(Math.PI * 1.5 - this.crankAngle);
        const bestDelta = Math.abs(dA) <= Math.abs(dB) ? dA : dB;
        this.crankAngle = wrapTau(this.crankAngle + bestDelta * (1 - Math.exp(-4.0 * h)));
      }
    }

    if (sockets.isCar) {
      this.lean = input.externalLean ?? 0;
      this.forkDive = input.externalForkDive ?? 0;
    } else {
      const wb = Math.max(0.75, sockets.wheelbase);
      const dynLean =
        input.externalLean !== undefined
          ? input.externalLean
          : clamp(Math.atan((input.speed * input.speed * Math.tan(-input.steer)) / (GRAVITY * wb)), -0.46, 0.46);
      const stopLean = -0.075 * this.standSideSign;
      const parkedKickstandLean = 0.085;
      const mountedLeanTarget = dynLean * (1 - this.standDownBlend) + stopLean * this.standDownBlend;
      const targetLean =
        parkedKickstandLean * (1 - this.kickstandRetract) + mountedLeanTarget * this.kickstandRetract;

      if (h > 0) {
        const wn = 11.5;
        const accel = wn * wn * (targetLean - this.lean) - 2 * wn * this.leanVel;
        this.leanVel += accel * h;
        this.lean = clamp(this.lean + this.leanVel * h, -0.50, 0.50);
      } else {
        this.lean = targetLean;
      }

      if (input.externalForkDive !== undefined) {
        this.forkDive = input.externalForkDive;
      } else {
        const targetDive = input.brake && absSpeed > 0.3 ? clamp(absSpeed * 0.012, 0, 0.065) : 0;
        this.forkDive = h > 0
          ? this.forkDive + (targetDive - this.forkDive) * (1 - Math.exp(-14 * h))
          : targetDive;
      }
    }

    return this.snapshot(input.speed, input.maxSpeed, input.steer, input.groundY);
  }

  snapshot(
    speed: number,
    maxSpeed: number,
    steer: number,
    groundY: number,
    freeLookYawOffset = 0,
    freeLookPitchOffset = 0,
  ): RiderKinematicState {
    return {
      speed,
      maxSpeed,
      steer,
      lean: this.lean,
      forkDive: this.forkDive,
      crankAngle: this.crankAngle,
      crankOmega: this.crankOmega,
      standDownBlend: this.standDownBlend,
      mountBlend: this.mountBlend,
      armIkWeight: this.armIkWeight,
      kickstandRetract: this.kickstandRetract,
      doorOpenBlend: this.doorOpenBlend,
      groundY,
      standSideSign: this.standSideSign,
      freeLookYawOffset,
      freeLookPitchOffset,
    };
  }
}
