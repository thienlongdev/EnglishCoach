import * as T from 'three';
import type { GaitLeg } from './gaitClip';
import {
  HANDLE_WRAP_WRIST_LIMIT,
  MAX_FOREARM_ROLL_RAD,
  MAX_GENERAL_WRIST_FLEX_RAD,
  alignWrist,
  minJerk,
  reSeatCylindricalHandleWrist,
  reachableWrist,
  solveArm,
  type SolvedArm,
} from './arms';
import {
  clampFingerBend,
  clampFingerOpposition,
  clampFingerSpread,
  curlPose,
  GRIPS,
  FINGER_NAMES,
  type FingerPose,
  type Grip,
} from './fingers';
import { CLAP_CONTACT, GESTURE_SECONDS, gestureBody, gestureEnvelope, gesturePose, handRotation, wristLimit, type HandGesture, type HandPose } from './poses';
import { Balance, PlantedFeet, type Load, type Stance } from './balance';
import { FootSurface } from './footSurface';
import { FootGround } from './footGround';
import { gripFitChanged, gripFitFrame } from './gripFitFrame';
import {
  PelvisVerticalSpring,
  computeSolvedKneeFlexionRad,
  createNpcFootLockState,
  filterFootSurfaceNormal,
  maxAnatomicalLegReach,
  MIN_KNEE_FLEX_RAD,
  MAX_KNEE_FLEX_RAD,
  resetNpcFootLockState,
  sampleStanceFootTarget,
  solveAnalyticLegIk,
  solveFootSlopeAndRollRotation,
  type FootSlopeRollOutput,
  type NpcFootLockState,
  type StanceFootSampleOutput,
} from './legIk';

export {
  PelvisVerticalSpring,
  filterFootSurfaceNormal,
  maxAnatomicalLegReach,
  sampleStanceFootTarget,
  solveAnalyticLegIk,
  solveFootSlopeAndRollRotation,
};

export type { HandGesture };
/**
 * Holding C (an FPS crouch, not a floor posture), metres at scale 1. Counter-Strike lowers the eyes from 64 to 46 units
 * (28 %); here the pelvis goes down far enough for knees near a right angle on the walk clip's own legs (hips 0.6 m
 * over the floor), and the eyes, the camera, the ready hands and the body capsule go down with the head, by the same table.
 */
export const CROUCH = { pelvis: .34, eye: .36 } as const;
/** The lowest a standing reach takes the hips over the soles, metres at scale 1 (`planTrunk`). */
const REACH_HIP_FLOOR = .26;
/** Hip flexion a person has with the knees bent: about 120 degrees (thigh against trunk). */
const HIP_FLEXION = 2.4;
/** What the lumbar and thoracic spine add by rounding once the hip has none left, radians (about 35 degrees). */
const SPINE_FLEXION = .6;
/** Hip flexion with the knees straight: the hamstrings stop it near 80 degrees (straight-leg raise); bending the knees frees more. */
const HAMSTRING = 1.4;
/** The furthest a standing body leans for a reach, radians: a stoop for a pen on the floor takes the trunk past horizontal. */
export const TRUNK_PITCH_CAP = 2.0;
/** Pelvis rotation the hip still allows at this squat, radians: the hamstrings limit it with straight knees, the thigh
 * against the trunk in a deep squat. In between (knees a little bent) a person folds furthest: the stoop of a floor pickup. */
function hipRoomFor(drop: number, standing: number, leg: number) {
  const ankle = .08 * leg / .83, thigh = Math.acos(T.MathUtils.clamp((standing - ankle - Math.max(0, drop)) / leg, -1, 1));
  return Math.max(0, Math.min(HIP_FLEXION - thigh, HAMSTRING + thigh));
}
/**
 * The most the trunk may lean (`pitch`) when the hips have gone down by `drop`: the thighs come up as the knees bend,
 * and thigh plus trunk can never close past the hip's range. Squatting deep and folding the trunk fully at once put the
 * chest on the knees (the owner's ground-pickup collapse). `standing` = hips over the soles before the drop, `leg` =
 * thigh + shin, metres; the thigh angle is that of a symmetric knee bend with the hips over the feet.
 */
export function maxTrunkPitch(drop: number, standing: number, leg: number, cap = TRUNK_PITCH_CAP) {
  // The pelvis takes 80 % of a lean while the hip has room; past it the spine rounds, up to SPINE_FLEXION in all.
  const room = hipRoomFor(drop, standing, leg);
  return Math.max(0, Math.min(cap, room / .8, room + SPINE_FLEXION));
}
/** Where the eyes go when the trunk bends for a reach, in the body's frame, metres at scale 1: the eye point and the
 * first-person camera follow the head, so the view never floats above a body that is bending under it. */
export function reachEyeShift(bend: { drop: number; pitch: number }, lean = 0, out = { down: 0, forward: 0 }) {
  const stoop = Math.min(TRUNK_PITCH_CAP, bend.pitch + lean);
  out.down = bend.drop * .85 + (1 - Math.cos(stoop)) * .42;
  out.forward = Math.sin(stoop) * .36;
  return out;
}

/** A hand at rest on something real (a lap, a desk, an armrest, the body in bed), in world space. */
export interface RestHand { wrist: T.Vector3; fingers: T.Vector3; palm: T.Vector3; curl: number; grip?: Grip }
/** Where a hand has to be, in world space: read every frame, so a moving door handle carries the hand with it. */
export interface HandContact {
  /** A supporting hand on a thing the other hand holds fast (the lower hand on a broom): it follows the body and never bends it. */
  support?: boolean;
  wrist: T.Vector3; fingers: T.Vector3; palm: T.Vector3; grip: Grip; pole?: T.Vector3; limit?: number; shape?: () => GraspShape | null;
  /** The thing this hand holds, and where its origin stood (world) when the hand was sent: after the arms are solved the thing is drawn where the hand really is. */
  on?: T.Object3D; onAt?: T.Vector3;
  /** Planned destination for the torso only. Arm IK still follows the physical
   * object's wrist, so anticipation cannot detach a secured hand. */
  bodyGoal?: T.Vector3;
  bodyFingers?: T.Vector3;
  /** How far the body will go for this hand: someone sweeping does not fold in two to keep a low grip. Radians of back, metres of knees, radians of turn. */
  bend?: { pitch: number; drop: number; yaw?: number };
  /** The weight this hand is going to take, kilograms: a heavy thing is lifted with the knees, a light one with a bend of the back. */
  kg?: number;
  /** Round a bar: the fingers come all the way round it and stop short of it from the far side. A straight finger would go through what the handle is joined to, and a finger closing from open would stop on that. */
  wrap?: boolean;
  /** Rolling the prop about a measured forearm preserves its elbow bend plane. */
  wristPivot?: boolean;
  /** Collision-fitted digit poses for a known handle and cast size. */
  handleJoints?: readonly (readonly [number,number,number,number,number])[];
  /** The grip is established (`GraspFrame`): the thing is in the hand, not being reached for. */
  secured?: boolean;
}
/** The thing in the hand as the fingers feel it: its own frame and size. The fingers close until they touch it. */
export interface GraspMeshData { positions: Float32Array; indices: Uint32Array; scale: number }
export interface GraspShape { kind: 'box' | 'cyl' | 'sphere' | 'mesh'; toLocal: T.Matrix4; half: [number, number, number]; /** 'mesh': distance to the real triangles from a point in the thing's frame, metres. */ distance?: (local: T.Vector3) => number; inside?: (local: T.Vector3) => boolean; bounds?: T.Box3; signedDistance?: (local: T.Vector3, limit?: number) => number; meshData?: () => GraspMeshData }

/** Explicit world-space ankle IK targets (closed-loop bicycle pedals, scooter deck, or seated floor contacts). */
export interface LegTargets {
  left: T.Vector3;
  right: T.Vector3;
  leftNormal?: T.Vector3;
  rightNormal?: T.Vector3;
  leftPole?: T.Vector3;
  rightPole?: T.Vector3;
  leftFootQuat?: T.Quaternion;
  rightFootQuat?: T.Quaternion;
  skipSlopeRoll?: boolean;
  weight?: number;
}

export interface BodyFrame {
  dt: number;
  reduced: boolean;
  /** The owner looks through these eyes: the head is not drawn and gestures stay in view. */
  own: boolean;
  /** Eye position in world space (steady: measured from the skeleton, not the animated head). */
  eye: T.Vector3;
  /** Where the eyes look, relative to the way the body faces. Radians: yaw left +, pitch up +. */
  lookYaw: number;
  lookPitch: number;
  /** Hips turned towards the direction of travel while the shoulders keep facing forward. */
  moveYaw?: number;
  /** The body leaning its weight forward: over the knees, getting up or sitting down. Radians. */
  lean?: number;
  /** Optional sagittal pelvis COM pitch (forward +, radians) for cycling/diving/athletic posture. */
  pelvisPitch?: number;
  /** Optional 40% spine / 60% chest lateral turn banking roll (right +, radians) without tilting root. */
  leanRoll?: number;
  /** Optional 40% spine / 60% chest sagittal acceleration/swim lean pitch (forward +, radians) without tilting root. */
  leanPitch?: number;
  rest?: { left: RestHand; right: RestHand } | null;
  /** The hips stay on the seat: reaching from a chair the back bends, the knees do not. */
  seated?: boolean;
  /** Vehicle/bicycle rider mode: neutralizes standing Idle contrapposto sway on hips/spine/chest and skips planTrunk folding. */
  riderSeated?: boolean;
  crouch?: number;
  /** The upper body turned into what the hands are doing. Radians, left +. */
  twist?: number;
  /** A weight on one side: `side` is +1 right, -1 left; `kg` of it. The trunk leans away from it and the hip takes it. */
  load?: { side: number; kg: number } | null;
  /**
   * Through one's own eyes, standing: idle and walking keep the arms naturally lowered with the body's gait clip, while
   * running brings in a natural stride-synced counter-phase arm swing. Null when viewing from outside, seated, or lying down.
   */
  /** Arena third-person running uses measured arm lengths for the wrist arc. */
  trackArmSwing?: boolean;
  ready?: { forward: T.Vector3; up: T.Vector3; right: T.Vector3; speed: number; stride: number; turn: number; nod: number } | null;
  /** The body's weight: what it carries, what its hands strain against, how its feet stand. Null: the clip's legs and nothing else (sitting, lying, someone else's body). */
  dynamics?: BodyDynamics | null;
  /** Optional terrain height + world surface normal query beneath a foot probe (falls back to `dynamics.groundAt` flat normal). */
  surfaceAt?: (probe: T.Vector3, outNormal: T.Vector3) => number | null;
  /** Optional natural frequency (`rad/s`, e.g. `20`) enabling critically damped pelvis vertical stabilization across stairs/slopes. */
  pelvisSpringHz?: number;
  /** Continuous `[0..1]` fast-gait blend weight replacing the boolean `verticalGait` `1.8 m/s` reset cliff. */
  verticalGaitWeight?: number;
  /** Studio / Photo / non-stepping emote pose: frees feet from world-space PlantedFeet locks and PelvisVerticalSpring while preventing sole underground clipping. */
  freeFeet?: boolean;
  /** Weight `[0..1]` applied to captured clip finger rotations when hands are idle/free (default `0.55`; `1.0` preserves 100% of studio pose fingers even at `dt = 0`). */
  clipFingerWeight?: number;
  /** Optional closed-loop world-space ankle IK targets (bicycle pedals, scooter floorboards, seated floor rests). */
  legTargets?: LegTargets | null;
  /** Commit permitted recovery-root movement after balance, before torso/contact IK. */
  resolveRoot?: () => void;
  /** The torso and secured-grasp shoulders are final: advance held physics and refresh contacts before solving either arm. */
  resolveContacts?: () => void;
}
export interface BodyDynamics {
  /** The clip's legs are stepping: the feet are theirs. */
  stepping: boolean;
  /** Ordinary locomotion; reconstructed motions retain their annotated contacts. */
  gait?: boolean;
  /** Fast travel uses the animated horizontal footprint with sole-height correction only. */
  verticalGait?: boolean;
  /** Optional continuous `[0..1]` fast-gait weight (alias of `BodyFrame.verticalGaitWeight`). */
  verticalGaitWeight?: number;
  /** Current scene support below a world-space ankle; null means no support. */
  groundAt?: (at: T.Vector3) => number | null;
  /** Optional terrain height + surface normal query below a world-space ankle (alias of `BodyFrame.surfaceAt`). */
  surfaceAt?: (probe: T.Vector3, outNormal: T.Vector3) => number | null;
  /** Motion-time contact annotations, left/right; geometric foot locks, not measured support forces. */
  motionContacts?: readonly [number, number] | null;
  motionWeight?: number;
  floorPosture?: boolean;
  /** Existing room floor in world coordinates, only for a floor action. Not a support-force assertion. */
  motionFloorY?: number;
  /** Kilograms of the body itself. */
  mass: number;
  /** What is carried, and where it is now, world. */
  loads: { at: T.Vector3; kg: number }[];
  /** The force the hands bring to bear on something, newtons, world axes, and how high. The body feels the other side of it. */
  handForce?: { x: number; z: number; height: number } | null;
  stance?: Stance | null;
  /** How hard the body is working at it, 0..1: the arms tremble at the top of a strength. */
  strain?: number;
  /** A step would land here: is there room? World. */
  roomAt?: (x: number, z: number) => boolean;
  /** A foot came down. */
  land?: (side: number, hard: number) => void;
}

const UP = new T.Vector3(0, 1, 0);
/** How quickly a carried ankle correction gives way to the clip's own foot, per second. */
const CARRY_RELAX = 3;
const q1 =new T.Quaternion(), q2 = new T.Quaternion(), q3 = new T.Quaternion(), q4 = new T.Quaternion();
const v1 = new T.Vector3(), v2 = new T.Vector3(), v3 = new T.Vector3(), v4 = new T.Vector3();
/** How far a standing knee's plane may turn from the shoe's towards the clip's own bend, radians. */
const KNEE_PLANE = .17;
/** Milliseconds a frame given to finger fits in progress. */
const FIT_BUDGET_MS = 3;
/** Seconds over which the hips move between the clip's (walking) and over the feet (standing). */
const WEIGHT_BLEND_S = .3;
/** A walking body turning faster than this (rad/s) pivots on its feet: the stance lock lets the shoe go with the clip. */
const PIVOT_TURN = 2.2;
const e1 = new T.Euler();
const m1 = new T.Matrix4();
const MAX_FOREARM_TWIST_RAD = MAX_FOREARM_ROLL_RAD;
/** Anatomical limit (`~29.8 deg`) on net axial torsion between `hips` and `chest` so rapid counter-turns never wring the torso. */
const MAX_TORSO_TORSION_RAD = 0.52;
/** Anatomical pelvis lead limit (`~48.7 deg`) into travel direction while preserving oblique/side-step foot alignment. */
const MAX_PELVIS_MOVE_YAW_RAD = 0.85;
/** Anatomical cervical yaw bound (`~60.2 deg`) for combined `neck + head` rotation relative to `chest`. */
const MAX_CERVICAL_YAW_RAD = 1.05;
/** Anatomical clavicle shrug + protraction total angular limit (`<= 0.24 rad` / `~13.75 deg`). */
const MAX_CLAVICLE_RAD = 0.24;

// Zero-allocation scratch registers for clavicle, arm IK, trunk planning, palmSeat, and reachStance
const _clavShoulder = new T.Vector3();
const _clavTo = new T.Vector3();
const _clavBaseQ = new T.Quaternion();
const _clavTargetQ = new T.Quaternion();
const _clavParentInvQ = new T.Quaternion();

const _solveShoulder = new T.Vector3();
const _solveUpperDir = new T.Vector3();
const _solveForeDir = new T.Vector3();
const _solveHandQ = new T.Quaternion();
const _solveHandDir = new T.Vector3();
const _solvePalmDir = new T.Vector3();
const _solveHinge = new T.Vector3();
const _solvedArmOut: SolvedArm = {
  shoulder: new T.Vector3(),
  elbow: new T.Vector3(),
  wrist: new T.Vector3(),
};
const _handSpecScratch = {
  direction: new T.Vector3(),
  limit: 0.9,
  palm: new T.Vector3(),
  side: 1,
  maxRoll: MAX_FOREARM_ROLL_RAD as number | undefined,
};

const _armShoulderNow = new T.Vector3();
const _fkElbow = new T.Vector3();
const _fkWrist = new T.Vector3();
const _fkHandQ = new T.Quaternion();
const _armWrist = new T.Vector3();
const _armGoalQ = new T.Quaternion();
const _armPole = new T.Vector3();
const _gestFwd = new T.Vector3();
const _gestUp = new T.Vector3();
const _gestWristGoal = new T.Vector3();
const _gestFingersGoal = new T.Vector3();
const _gestPalmGoal = new T.Vector3();
const _gestTo = new T.Vector3();
const _gestAim = new T.Vector3();
const _spineBeforeQ = new T.Quaternion();
const _chestBeforeQ = new T.Quaternion();
const _armHomeRootQ = new T.Quaternion();
const _armHomeRootPos = new T.Vector3();
const _solvedRootInvM = new T.Matrix4();
const _artScale = new T.Vector3();
const _artBack = new T.Vector3();
const _artParentQ = new T.Quaternion();
const _tfScale = new T.Vector3();
const _ptHipW = new T.Vector3();
const _ptRel = new T.Vector3();
const _ptPole = new T.Vector3();
const _ptReachOut = new T.Vector3();
const _pstShoulder = new T.Vector3();
const _pstPole = new T.Vector3();
const _pstReachOut = new T.Vector3();
const _pstHipW = new T.Vector3();
const _hrmParentM = new T.Matrix4();
const _hrmInvParentM = new T.Matrix4();
const _hrmAt = new T.Vector3();
const _hrmQ = new T.Quaternion();
const _hrmShoulder = new T.Vector3();
const _hrmPole = new T.Vector3();
const _hrmReachOut = new T.Vector3();

const _palmFingerQuats: T.Quaternion[] = Array.from({ length: 20 }, () => new T.Quaternion());
let _palmBoneMats: T.Matrix4[] = [];
let _palmBoneStamp = new Uint32Array(0);
let _palmStampCounter = 1;
const _palmAt = new T.Vector3();
const _palmP = new T.Vector3();
const _palmX = new T.Vector3();
const _palmY = new T.Vector3();
const _palmZ = new T.Vector3();
const _palmOrigin = new T.Vector3();
let _palmPerpSq = new Float64Array(256);
let _palmVz = new Float64Array(256);

const _rsPos = new T.Vector3();
const _rsProbe = new T.Vector3();
const _rsPivot = new T.Vector3();
const _rsPivotW = new T.Vector3();
const _rsSeedAt = new T.Vector3();
const _rsIdealAt = new T.Vector3();
const _rsCand = new T.Vector3();
const _rsShoulder = new T.Vector3();
const _rsPole = new T.Vector3();
const _rsProj = new T.Vector3();
const _rsRootW = new T.Vector3();
const _rsRootQ = new T.Quaternion();
const _rsSavedRootP = new T.Vector3();
const _rsSavedRootQ = new T.Quaternion();
const _rsSavedFwd = new T.Vector3();
const _rsSavedRight = new T.Vector3();
const _rsFootW = new T.Vector3();
const _rsFootQ = new T.Quaternion();
const _rsFootS = new T.Vector3();
const _rsHipsW = new T.Vector3();
const _rsBestAt = new T.Vector3();
const _rsFallbackAt = new T.Vector3();
const _rsStartsPool: T.Vector3[] = Array.from({ length: 8 }, () => new T.Vector3());
const _rsStartScores = new Float64Array(8);
const _rsState = [0, 0, 0, 0, 0, 0, 0];

// Zero-allocation scratch registers for foot surface, slope-roll, and ankle envelope
const _solePt = new T.Vector3();
const _travelVec = new T.Vector3();
const _footScale = new T.Vector3();
const _shoeFwd3D = new T.Vector3();
const _shoeFwdW = new T.Vector3();
const _shoeFwdC = new T.Vector3();
const _modelQ = new T.Quaternion();
const _invModelQ = new T.Quaternion();
const _reachedAt = new T.Vector3();
const _reachedQ = new T.Quaternion();
const _slopeOut: FootSlopeRollOutput = { footWorldQuat: new T.Quaternion(), toeCounterPitchRad: 0 };
const _stanceSampleOut: StanceFootSampleOutput = {
  targetX: 0,
  targetY: 0,
  targetZ: 0,
  effectiveLockWeight: 0,
  pelvisDropRequest: 0,
};
const _kpHip = new T.Vector3();
const _kpTo = new T.Vector3();
const _kpPole = new T.Vector3();
const _kpAxis = new T.Vector3();
const _kpA = new T.Vector3();
const _kpB = new T.Vector3();
const _kpCross = new T.Vector3();
const _kpSag = new T.Vector3();
const _kpOut = new T.Vector3();
const _laKnee = new T.Vector3();
const _laTibia = new T.Vector3();
const _laFemur = new T.Vector3();
const _laNegTibia = new T.Vector3();
const _laUp = new T.Vector3();
const _laFront = new T.Vector3();
const _laRight = new T.Vector3();
const _laNeutral = new T.Vector3();
const _laForward = new T.Vector3();
const _laUpright = new T.Vector3();
const _laLateral = new T.Vector3();
const _laCross = new T.Vector3();
const _laLocalQ = new T.Quaternion();
const _laNextQ = new T.Quaternion();
const _laMat = new T.Matrix4();
const _reSeatWrist = new T.Vector3();
const _restRootPos = new T.Vector3();
const _restRootQ = new T.Quaternion();
const _restInvRootQ = new T.Quaternion();
const _restWristScratch = new T.Vector3();
const _restFingersScratch = new T.Vector3();
const _restPalmScratch = new T.Vector3();
const _releaseWristScratch = new T.Vector3();
const _releaseFingersScratch = new T.Vector3();
const _releasePalmScratch = new T.Vector3();

function contactWristLimit(c: HandContact, fallback = .8): number {
  if (c.grip === 'handle' && c.wrap) {
    return c.limit !== undefined ? Math.min(c.limit, HANDLE_WRAP_WRIST_LIMIT) : HANDLE_WRAP_WRIST_LIMIT;
  }
  const raw = c.limit !== undefined ? c.limit : (c.wristPivot ? .9 : fallback);
  return Math.min(raw, MAX_GENERAL_WRIST_FLEX_RAD);
}

function worldFrame(y: T.Vector3, x: T.Vector3, out: T.Quaternion) {
  v3.copy(x).addScaledVector(y, -x.dot(y)).normalize();
  v4.crossVectors(v3, y).normalize();
  return out.setFromRotationMatrix(m1.makeBasis(v3, y, v4));
}

interface Finger {
  bone: T.Bone; rest: T.Quaternion; finger: number; joint: number; bend: number; spread: number; opposition: number; tip: number;
}
// Starting poses from the cast-skin search across tapered and straight shafts.
// Flexion, spread and opposition follow HandSkin.setFinger's five-angle layout.
const SHAFT_THUMB_POSES = [
  [-.05, .15, .03125, .25, 0],
  [-.45, .4, .140625, 0, .675],
  [-.3, .36875, .290625, .5, -.25],
];
/** One finger's drawn skin: every vertex its bones move, with the cast's own weights, for skinning trial curls exactly. */
/** What the finger fit reads and writes of an arm: the live arm, or a frozen copy of its hand (`FitJob`). */
type FitArm = Pick<Arm, 'contact' | 'hand' | 'fingers' | 'skin' | 'side' | 'jointFit' | 'fit' | 'spreadFit'>;
interface FingerSkin {
  mesh: T.SkinnedMesh;
  bind: Float32Array;
  bones: Uint16Array;
  weights: Float32Array;
  count: number;
  /** `1` if vertex has zero weight on any finger bone (invariant across finger closure trials), `0` otherwise. */
  rigidMask?: Uint8Array;
}
interface Leg {
  capturedKnee?: T.Vector3;
  /** The clip's own knee bend this frame: the knee's offset from its hip→ankle line, world. The animator's bend plane. */
  clipBend?: T.Vector3;
  clipExtension?: number;
  side: number; thigh: T.Bone; shin: T.Bone; foot: T.Bone; toe: T.Bone | null; toeRest: T.Quaternion | null;
  sole: FootSurface; footForward: T.Vector3; footUp: T.Vector3; lenThigh: number; lenShin: number; at: T.Vector3; q: T.Quaternion; goal: T.Vector3; goalQ: T.Quaternion;
  /** The ankle envelope's last final correction, world delta: the next frame's shoe starts from it, so a stance shoe's rotation is continuous. */
  carry: T.Quaternion;
  /** This frame's shoe rotation before that correction. */
  carryFrom: T.Quaternion;
  filteredNormal: T.Vector3;
  rawNormal: T.Vector3;
  hasTerrainNormal: boolean;
  lockState: NpcFootLockState;
  toeCounterPitch: number;
}
interface Arm {
  /** +1 right, -1 left: the sign of `poses.ts`. */
  side: number;
  clavicle: T.Bone; upper: T.Bone; fore: T.Bone; twist: T.Bone | null; hand: T.Bone;
  fingers: Finger[];
  twistRest: T.Quaternion;
  bindHand: T.Quaternion;
  lastTwist: number;
  twistSeen: boolean;
  lenUpper: number; lenFore: number;
  contact: HandContact | null;
  contactT: number;
  contactSeconds: number;
  releaseSeconds: number;
  weight: number;
  grip: FingerPose;
  /** Fingers straight along the palm: the source hand's bind pose is a little curved, and a clap needs them flat. */
  flat: FingerPose;
  hinge?: T.Vector3;
  lastContact?: HandContact | null;
  lastContactLocal?: {
    offset: T.Vector3;
    fingersLocal: T.Vector3;
    palmLocal: T.Vector3;
    grip: Grip;
    limit?: number;
  } | null;
  lastRestLocal?: {
    offset: T.Vector3;
    fingersLocal: T.Vector3;
    palmLocal: T.Vector3;
    curl: number;
    grip?: Grip;
  } | null;
  /** How far each finger closes before it meets what it holds. */
  fit: number[];
  fitFor: (() => GraspShape | null) | null;
  fitFrame?: number[] | null;
  /** Set for the frame by a deliberate slide of the hand along a handle (a regrip): the closure is kept, the fit waits. */
  fitHeld?: boolean;
  /** Per finger (thumb first): its drawn skin, when the cast has a hands mesh. */
  skin?: (FingerSkin | null)[];
  /** The palm's own drawn skin (vertices the hand bone alone carries), for the clearance of a power grip. */
  palmSkin?: FingerSkin | null;
  palmSeats?: Map<string, number>;
  palmClosureLocal?: { scaleKey: string; xyz: Float32Array; count: number };
  /** Extra spread a fit found for each finger: a thumb opened round a handle rather than through it. Radians, in the grip's own sense. */
  spreadFit: number[];
  /** Joint by joint flexion a wrap found for each finger (null: the grip's pose scaled by `fit`). Radians. */
  jointFit: (number[] | null)[];
}

/** Every bone the layers write after the mixer: restored before the next mixer pass, so nothing compounds. */
const WRITES = /^(hips|spine|chest|neck|head|shoulder\.[LR]|upper_arm\.[LR]|forearm\.[LR]|hand\.[LR]|fore_twist\.[LR]|pony\.\d|thigh\.[LR]|shin\.[LR]|foot\.[LR]|toe\.[LR])$/;

/**
 * One human skeleton, whatever the camera. The mixer plays the body's clip (motion capture, authored seats); on top of it
 * this adds, in order: the hips turning into the travel direction, the look distributed over spine and neck, a gesture's
 * body and arms, resting hands, contact hands, and the fingers. Both arms are always the skinned arms of the same mesh:
 * nothing is attached to a camera.
 */
export type FirstPersonPoseState = 'idle' | 'walk' | 'run' | 'interact' | 'hold' | 'use_tool' | 'gesture' | 'rest' | 'release';

export class HumanRig {
  readonly arms: Arm[] = [];
  readonly legs: Leg[] = [];
  private motionFeet = new Map<number, { on: boolean; weight: number; at: T.Vector3; q: T.Quaternion }>();
  private gaitFeet = new Map<number, FootGround>();
  /** How far the body is bending for what the hands are reaching: metres the hips go down, radians the back leans, turns (left +) and tilts (right +). */
  private bend = { drop: 0, pitch: 0, yaw: 0, roll: 0 };
  private plan = { drop: 0, pitch: 0, yaw: 0, roll: 0 };
  /** The weight of the body over its feet. */
  readonly balance = new Balance();
  feet: PlantedFeet = new PlantedFeet([]);
  private lastRoot = new T.Vector3();
  private turnRate = 0;
  private strideLane = 0;
  private strideHinge = 0;
  private hipAxis = new T.Vector3();
  private lastMid = new T.Vector2();
  private midSeen = false;
  private velocity = new T.Vector2();
  private accel = new T.Vector2();
  private rootSeen = false;
  /** The body's axes the last time the weight was read, to carry the weight across a turn. */
  private lastRight = new T.Vector3(); private lastForward = new T.Vector3(); private axesSeen = false;
  private wasStepping = false;
  private strainNow = 0;
  private clock = 0;
  /** How far the feet have carried the body off where it stood, still to be followed by the root. World metres. */
  readonly drift = new T.Vector3();
  /** Where the head has gone from where the eyes are measured: the owner feels a stumble. World metres. */
  readonly eyeShift = new T.Vector3();
  private unstable = 0;
  private loadNow = 0;
  private loadSide = 1;
  private bones = new Map<string, T.Bone>();
  private base = new Map<T.Bone, T.Quaternion>();
  private baseHips = new T.Vector3();
  private bindTrunkLocal = new Map<T.Bone, T.Quaternion>();
  private bindHipsPos = new T.Vector3();
  private palmSeatCache = new Map<string, number>();
  private hips: T.Bone | null = null;
  /** The legs and pelvis the captured gaits are put right for, once, at load (`gaitClip.ts`). */
  get gaitSkeleton() { return this.hips ? { hips: this.hips, legs: this.legs as readonly GaitLeg[] } : null; }
  private gesture: HandGesture = 'idle';
  private phase = 0;
  private reachAt: T.Vector3 | null = null;
  private forward = new T.Vector3();
  private right = new T.Vector3();
  private up = new T.Vector3();
  private rootQ = new T.Quaternion();
  private restT = 0;
  private restMix = 0;
  private readyMix = 0;
  private readySpeed = 0;
  private readySway = new T.Vector2();
  private poseState: FirstPersonPoseState = 'idle';
  private gesturePitch = 0;
  private pelvisSpring = new PelvisVerticalSpring();
  private activeSurfaceAt: ((probe: T.Vector3, outNormal: T.Vector3) => number | null) | null = null;
  private activeVerticalGaitWeight: number | undefined = undefined;
  private activeMoveYaw = 0;
  private smoothedMoveYaw = 0;
  private smoothedLookYaw = 0;
  private lookYawSeeded = false;
  private pelvisFwd = new T.Vector3(0, 0, 1);
  private pelvisRight = new T.Vector3(-1, 0, 0);
  /** From the wrist's axis to the skin of the palm, at this model's own scale: measured once from the hand's vertices. */
  private palmDepth = CLAP_CONTACT;
  scale = 1;
  ready = false;

  constructor(readonly model: T.Object3D, readonly root: T.Object3D) {
    model.traverse(o => {
      if (!(o as T.Bone).isBone) return;
      const bone = o as T.Bone, name = (o.userData.name as string | undefined) ?? o.name;
      this.bones.set(name, bone);
      if (WRITES.test(name)) this.base.set(bone, bone.quaternion.clone());
    });
    this.hips = this.bones.get('hips') ?? null;
    model.updateWorldMatrix(true, true);
    if (this.hips) {
      this.baseHips.copy(this.hips.position);
      this.bindHipsPos.copy(this.hips.position);
    }
    for (const trunkName of ['hips', 'spine', 'Spine1', 'spine1', 'chest']) {
      const tb = this.bones.get(trunkName);
      if (tb && !this.bindTrunkLocal.has(tb)) {
        this.bindTrunkLocal.set(tb, tb.quaternion.clone());
      }
    }
    this.scale = this.model.getWorldScale(v1).x / 1.04;
    for (const [side, s] of [[1, 'R'], [-1, 'L']] as [number, string][]) {
      const clavicle = this.bones.get(`shoulder.${s}`), upper = this.bones.get(`upper_arm.${s}`), fore = this.bones.get(`forearm.${s}`), hand = this.bones.get(`hand.${s}`);
      if (!clavicle || !upper || !fore || !hand) continue;
      const twist = this.bones.get(`fore_twist.${s}`) ?? null;
      const fingers: Finger[] = [];
      FINGER_NAMES.forEach((name, finger) => {
        for (const joint of [1, 2, 3]) {
          const bone = this.bones.get(`${name}.${joint}.${s}`);
          if (bone) {
            this.base.set(bone,bone.quaternion.clone());
            fingers.push({ bone, rest: bone.quaternion.clone(), finger, joint: joint - 1, bend: GRIPS.relaxed[finger][joint - 1], spread: GRIPS.relaxed[finger][3], opposition: 0, tip: bone.position.length() * .8 });
          }
        }
      });
      const p = (b: T.Bone) => b.getWorldPosition(new T.Vector3());
      const bindFore = fore.getWorldQuaternion(new T.Quaternion()), bindHandW = hand.getWorldQuaternion(new T.Quaternion());
      this.arms.push({
        side, clavicle, upper, fore, twist, hand, fingers,
        twistRest: twist ? twist.quaternion.clone() : new T.Quaternion(),
        bindHand: bindFore.invert().multiply(bindHandW),
        lastTwist: 0,
        twistSeen: false,
        lenUpper: p(upper).distanceTo(p(fore)), lenFore: p(fore).distanceTo(p(hand)),
        contact: null, contactT: 0, contactSeconds: .5, releaseSeconds: .42, weight: 0, grip: GRIPS.relaxed, flat: flatPose(fingers), fit: [1, 1, 1, 1, 1], spreadFit: [0, 0, 0, 0, 0], jointFit: [null, null, null, null, null], fitFor: null,
      });
    }
    for (const [side, s] of [[1, 'R'], [-1, 'L']] as [number, string][]) {
      const thigh = this.bones.get(`thigh.${s}`), shin = this.bones.get(`shin.${s}`), foot = this.bones.get(`foot.${s}`);
      if (!thigh || !shin || !foot) continue;
      const toe = this.bones.get(`toe.${s}`) ?? null;
      const p = (b: T.Bone) => b.getWorldPosition(new T.Vector3());
      const footForward = new T.Vector3(0, 0, 1).transformDirection(model.matrixWorld).applyQuaternion(foot.getWorldQuaternion(new T.Quaternion()).invert());
      const footUp = new T.Vector3(0, 1, 0).transformDirection(model.matrixWorld).applyQuaternion(foot.getWorldQuaternion(new T.Quaternion()).invert());
      this.legs.push({
        side,
        thigh,
        shin,
        foot,
        toe,
        toeRest: toe ? toe.quaternion.clone() : null,
        sole: new FootSurface(model, foot),
        footForward,
        footUp,
        lenThigh: p(thigh).distanceTo(p(shin)),
        lenShin: p(shin).distanceTo(p(foot)),
        at: new T.Vector3(),
        q: new T.Quaternion(),
        goal: new T.Vector3(),
        goalQ: new T.Quaternion(),
        carry: new T.Quaternion(),
        carryFrom: new T.Quaternion(),
        filteredNormal: new T.Vector3(0, 1, 0),
        rawNormal: new T.Vector3(0, 1, 0),
        hasTerrainNormal: false,
        lockState: createNpcFootLockState(),
        toeCounterPitch: 0,
      });
    }
    this.feet = new PlantedFeet(this.legs.map(l => l.side));
    this.ready = this.arms.length === 2;
    this.measurePalm(model);
    this.measureFingerSkin(model);
  }

  /** Re-measures drawn shoe/foot sole geometry in place after Wardrobe footwear changes. */
  refreshFootSurfaces(): void {
    this.model.updateWorldMatrix(true, true);
    for (const leg of this.legs) {
      leg.sole.rebuild(this.model, leg.foot);
    }
  }

  /** Recomputes scale, arm/leg bone segment lengths, and foot sole offsets after body proportion sliders or wardrobe change. */
  refreshProportions(scale?: number): void {
    if (scale !== undefined && Number.isFinite(scale) && scale > 0.25) {
      this.scale = scale;
    } else {
      this.scale = this.model.getWorldScale(v1).x / 1.04;
    }
    this.model.updateWorldMatrix(true, true);
    this.palmSeatCache.clear();
    if (this.hips) this.bindHipsPos.copy(this.hips.position);
    for (const [tb] of this.bindTrunkLocal) {
      this.bindTrunkLocal.set(tb, tb.quaternion.clone());
    }
    for (const arm of this.arms) {
      arm.upper.getWorldPosition(v1);
      arm.fore.getWorldPosition(v2);
      arm.hand.getWorldPosition(v3);
      arm.lenUpper = Math.max(0.08, v1.distanceTo(v2));
      arm.lenFore = Math.max(0.08, v2.distanceTo(v3));
      arm.palmSeats?.clear();
      arm.palmClosureLocal = undefined;
    }
    for (const leg of this.legs) {
      leg.thigh.getWorldPosition(v1);
      leg.shin.getWorldPosition(v2);
      leg.foot.getWorldPosition(v3);
      leg.lenThigh = Math.max(0.12, v1.distanceTo(v2));
      leg.lenShin = Math.max(0.12, v2.distanceTo(v3));
      leg.sole.rebuild(this.model, leg.foot);
    }
    this.measurePalm(this.model);
  }

  /** Backwards-compatible alias for `refreshProportions`. */
  recalibrateProportions(scale?: number): void {
    this.refreshProportions(scale);
  }

  /**
   * Each finger's own drawn skin: every vertex of the hands mesh that its bones move, kept with the cast's weights so that a
   * trial curl is skinned exactly as it will be drawn (knuckle and pad vertices blend between bones; they are what meets a handle).
   */
  private measureFingerSkin(model: T.Object3D) {
    let mesh: T.SkinnedMesh | null = null;
    model.traverse(o => { if ((o as T.SkinnedMesh).isSkinnedMesh && o.name.includes('Hands')) mesh = o as T.SkinnedMesh; });
    const m = mesh as unknown as T.SkinnedMesh | null;
    if (!m) return;
    const position = m.geometry.getAttribute('position'), index = m.geometry.getAttribute('skinIndex'), weight = m.geometry.getAttribute('skinWeight');
    const drawn = m.geometry.index ? new Set(Array.from(m.geometry.index.array as ArrayLike<number>)) : null;
    const v = new T.Vector3();
    for (const arm of this.arms) {
      arm.skin = [0, 1, 2, 3, 4].map(finger => {
        const own = new Set(arm.fingers.filter(f => f.finger === finger).map(f => m.skeleton.bones.indexOf(f.bone)).filter(i => i >= 0));
        if (!own.size) return null;
        const picked: number[] = [];
        for (let i = 0; i < position.count; i++) {
          if (drawn && !drawn.has(i)) continue;
          let w = 0;
          for (let k = 0; k < 4; k++) if (own.has(index.getComponent(i, k))) w += weight.getComponent(i, k);
          if (w >= .2) picked.push(i);
        }
        if (!picked.length) return null;
        const bind = new Float32Array(picked.length * 3), bones = new Uint16Array(picked.length * 4), weights = new Float32Array(picked.length * 4);
        picked.forEach((i, n) => {
          v.fromBufferAttribute(position, i).applyMatrix4(m.bindMatrix);
          bind[n * 3] = v.x; bind[n * 3 + 1] = v.y; bind[n * 3 + 2] = v.z;
          for (let k = 0; k < 4; k++) { bones[n * 4 + k] = index.getComponent(i, k); weights[n * 4 + k] = weight.getComponent(i, k); }
        });
        return { mesh: m, bind, bones, weights, count: picked.length };
      });
      const hand = m.skeleton.bones.indexOf(arm.hand), palm: number[] = [];
      const handInv = hand >= 0 ? m.skeleton.boneInverses[hand] : null;
      const fingerBoneSet = new Set(
        arm.fingers.map(f => m.skeleton.bones.indexOf(f.bone)).filter(idx => idx >= 0),
      );
      // Every palmar vertex the hand bone carries most of: the palm, its pads and the creases where it meets the fingers.
      // Exclude purely dorsal (`z < -0.004` in hand bone space) back-of-hand vertices that can never face `+Z` into the palm.
      if (hand >= 0 && handInv) for (let i = 0; i < position.count; i++) {
        if (drawn && !drawn.has(i)) continue;
        let own = 0, other = 0;
        for (let k = 0; k < 4; k++) { const w = weight.getComponent(i, k); if (index.getComponent(i, k) === hand) own += w; else other = Math.max(other, w); }
        if (own >= .5 && own > other) {
          v.fromBufferAttribute(position, i).applyMatrix4(m.bindMatrix).applyMatrix4(handInv);
          if (v.z > -0.004) palm.push(i);
        }
      }
      if (palm.length) {
        const bind = new Float32Array(palm.length * 3);
        const bones = new Uint16Array(palm.length * 4);
        const weights = new Float32Array(palm.length * 4);
        const rigidMask = new Uint8Array(palm.length);
        palm.forEach((i, n) => {
          v.fromBufferAttribute(position, i).applyMatrix4(m.bindMatrix);
          bind[n * 3] = v.x; bind[n * 3 + 1] = v.y; bind[n * 3 + 2] = v.z;
          let touchesFinger = false;
          for (let k = 0; k < 4; k++) {
            const bIdx = index.getComponent(i, k);
            const wVal = weight.getComponent(i, k);
            bones[n * 4 + k] = bIdx;
            weights[n * 4 + k] = wVal;
            if (wVal > 1e-6 && fingerBoneSet.has(bIdx)) touchesFinger = true;
          }
          rigidMask[n] = touchesFinger ? 0 : 1;
        });
        arm.palmSkin = { mesh: m, bind, bones, weights, count: palm.length, rigidMask };
      }
    }
  }

  private ensurePalmClosureEnvelope(arm: Arm, sk: FingerSkin, scaleKey: string) {
    if (arm.palmClosureLocal && arm.palmClosureLocal.scaleKey === scaleKey) {
      return arm.palmClosureLocal;
    }
    arm.hand.updateWorldMatrix(true, false);
    const e = arm.hand.matrixWorld.elements;
    _palmOrigin.set(e[12], e[13], e[14]);
    _palmX.set(e[0], e[1], e[2]).normalize();
    _palmY.set(e[4], e[5], e[6]).normalize();
    _palmZ.set(e[8], e[9], e[10]).normalize();

    const bones = sk.mesh.skeleton.bones;
    const inverses = sk.mesh.skeleton.boneInverses;
    if (_palmBoneMats.length < bones.length) {
      while (_palmBoneMats.length < bones.length) _palmBoneMats.push(new T.Matrix4());
      _palmBoneStamp = new Uint32Array(bones.length);
    }

    const fingerCount = arm.fingers.length;
    while (_palmFingerQuats.length < fingerCount) _palmFingerQuats.push(new T.Quaternion());
    for (let i = 0; i < fingerCount; i++) {
      _palmFingerQuats[i].copy(arm.fingers[i].bone.quaternion);
    }

    const rigidMask = sk.rigidMask;
    let creaseCount = 0;
    if (rigidMask) {
      for (let n = 0; n < sk.count; n++) if (rigidMask[n] === 0) creaseCount++;
    } else {
      creaseCount = sk.count;
    }
    const maxPts = sk.count + creaseCount * 2;
    const xyz = new Float32Array(maxPts * 3);
    let outCount = 0;
    const side = arm.side;

    try {
      for (let cIdx = 0; cIdx < 3; cIdx++) {
        const closure = cIdx * 0.5;
        for (let i = 0; i < fingerCount; i++) {
          const f = arm.fingers[i];
          const limJ = f.finger === 0 ? (f.joint === 0 ? 1 : f.joint === 1 ? 1.2 : 1.4) : (f.joint === 0 ? 1.57 : f.joint === 1 ? 1.75 : 1.2);
          e1.set(limJ * closure, 0, f.joint === 0 ? GRIPS.handle[f.finger][3] * -side : 0);
          q1.setFromEuler(e1);
          f.bone.quaternion.copy(f.rest).multiply(q1);
        }
        for (let i = 0; i < fingerCount; i++) {
          if (arm.fingers[i].joint === 0) arm.fingers[i].bone.updateWorldMatrix(false, true);
        }

        _palmStampCounter = (_palmStampCounter + 1) & 0x3fffffff;
        if (_palmStampCounter === 0) {
          _palmBoneStamp.fill(0);
          _palmStampCounter = 1;
        }
        const stamp = _palmStampCounter;

        const ox = _palmOrigin.x, oy = _palmOrigin.y, oz = _palmOrigin.z;
        const xx = _palmX.x, xy = _palmX.y, xz = _palmX.z;
        const yx = _palmY.x, yy = _palmY.y, yz = _palmY.z;
        const zx = _palmZ.x, zy = _palmZ.y, zz = _palmZ.z;
        const skBones = sk.bones, skWeights = sk.weights, skBind = sk.bind;

        for (let n = 0; n < sk.count; n++) {
          if (cIdx > 0 && rigidMask && rigidMask[n] === 1) continue;
          let ax = 0, ay = 0, az = 0;
          const n4 = n * 4;
          const n3 = n * 3;
          const bx = skBind[n3], by = skBind[n3 + 1], bz = skBind[n3 + 2];
          for (let kIdx = 0; kIdx < 4; kIdx++) {
            const w = skWeights[n4 + kIdx];
            if (w === 0) continue;
            const b = skBones[n4 + kIdx];
            const mat = _palmBoneMats[b];
            if (_palmBoneStamp[b] !== stamp) {
              mat.multiplyMatrices(bones[b].matrixWorld, inverses[b]);
              _palmBoneStamp[b] = stamp;
            }
            const me = mat.elements;
            ax += (me[0] * bx + me[4] * by + me[8] * bz + me[12]) * w;
            ay += (me[1] * bx + me[5] * by + me[9] * bz + me[13]) * w;
            az += (me[2] * bx + me[6] * by + me[10] * bz + me[14]) * w;
          }
          const rx = ax - ox, ry = ay - oy, rz = az - oz;
          const vz = rx * zx + ry * zy + rz * zz;
          if (vz > 0) {
            const o3 = outCount * 3;
            xyz[o3] = rx * xx + ry * xy + rz * xz;
            xyz[o3 + 1] = rx * yx + ry * yy + rz * yz;
            xyz[o3 + 2] = vz;
            outCount++;
          }
        }
      }
    } finally {
      for (let i = 0; i < fingerCount; i++) {
        arm.fingers[i].bone.quaternion.copy(_palmFingerQuats[i]);
      }
      for (let i = 0; i < fingerCount; i++) {
        if (arm.fingers[i].joint === 0) arm.fingers[i].bone.updateWorldMatrix(false, true);
      }
    }

    const built = { scaleKey, xyz: xyz.subarray(0, outCount * 3), count: outCount };
    arm.palmClosureLocal = built;
    return built;
  }

  /**
   * Where a handle of this radius rests outside this palm's closure envelope: the distance from the hand bone's axis to the
   * handle's axis at which the palm's own skin (its pads and creases) just meets the handle, the handle crossing the palm
   * `along` metres from the wrist and tilted `oblique` radians from square, its index-finger end towards the fingers.
   * A rigid handle rests on the fullest pads along its line, as it does in a real palm. Metres, divided by the rig's scale.
   */
  palmSeat(side: number, radius: number, along: number, oblique: number, give = .0008) {
    const arm = this.arms.find(a => a.side === side), sk = arm?.palmSkin;
    if (!arm || !sk) return null;
    const k = this.scale;
    const scaleKey = k.toFixed(4);
    const rigKey = `${side}|${radius.toFixed(5)}|${along.toFixed(4)}|${oblique.toFixed(3)}|${give.toFixed(5)}|${scaleKey}`;
    const memo = this.palmSeatCache.get(rigKey);
    if (memo !== undefined) return Number.isNaN(memo) ? null : memo;
    const key = [radius, along, oblique, give, k].join('|');
    const cached = arm.palmSeats?.get(key);
    if (cached !== undefined) {
      this.palmSeatCache.set(rigKey, cached);
      return cached;
    }

    const env = this.ensurePalmClosureEnvelope(arm, sk, scaleKey);
    if (!env.count) return null;

    const dx = Math.cos(oblique), dy = side * Math.sin(oblique);
    const r = radius * k, half = .06 * k, alongK = along * k, giveK = give * k;
    const rEff = Math.max(0, r - giveK);
    const rEffSq = rEff * rEff;
    const xyz = env.xyz;
    const envCount = env.count;
    let requiredD = 0;
    for (let i = 0; i < envCount; i++) {
      const i3 = i * 3;
      const px = xyz[i3];
      const py = xyz[i3 + 1] - alongK;
      const t = px * dx + py * dy;
      if (t < -half || t > half) continue;
      const perpXY = px * dy - py * dx;
      const perpSq = perpXY * perpXY;
      if (perpSq >= rEffSq) continue;
      const need = xyz[i3 + 2] + Math.sqrt(rEffSq - perpSq);
      if (need > requiredD) requiredD = need;
    }
    const maxSeatD = .08 * k;
    if (requiredD > maxSeatD) {
      if (this.palmSeatCache.size >= 4096) {
        const oldest = this.palmSeatCache.keys().next().value;
        if (oldest !== undefined) this.palmSeatCache.delete(oldest);
      }
      this.palmSeatCache.set(rigKey, Number.NaN);
      return null;
    }
    const seat = requiredD / k;
    if (this.palmSeatCache.size >= 4096) {
      const oldest = this.palmSeatCache.keys().next().value;
      if (oldest !== undefined) this.palmSeatCache.delete(oldest);
    }
    this.palmSeatCache.set(rigKey, seat);
    const seats = arm.palmSeats ??= new Map();
    if (seats.size >= 512) {
      const oldest = seats.keys().next().value;
      if (oldest !== undefined) seats.delete(oldest);
    }
    seats.set(key, seat);
    return seat;
  }

  /** How far the palm's drawn skin is from what this hand holds, as it is posed now (negative: the palm is in it). Metres. */
  palmClearance(side: number) {
    const arm = this.arms.find(a => a.side === side), sk = arm?.palmSkin, c = arm?.contact;
    const g = c?.shape?.();
    if (!arm || !sk || !g) return null;
    arm.hand.updateWorldMatrix(true, false);
    const bones = sk.mesh.skeleton.bones, inverses = sk.mesh.skeleton.boneInverses, mats = new Map<number, T.Matrix4>(), at = new T.Vector3(), p = new T.Vector3(), local = new T.Vector3();
    let near = Infinity;
    for (let n = 0; n < sk.count; n++) {
      at.set(0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const w = sk.weights[n * 4 + k];
        if (w === 0) continue;
        const b = sk.bones[n * 4 + k];
        let mat = mats.get(b);
        if (!mat) { mat = new T.Matrix4().multiplyMatrices(bones[b].matrixWorld, inverses[b]); mats.set(b, mat); }
        at.addScaledVector(p.set(sk.bind[n * 3], sk.bind[n * 3 + 1], sk.bind[n * 3 + 2]).applyMatrix4(mat), w);
      }
      local.copy(at).applyMatrix4(g.toLocal);
      const d = g.kind === 'mesh' ? (g.signedDistance ? g.signedDistance(local, .025 * this.scale) : (g.distance?.(local) ?? Infinity))
        : g.kind === 'cyl' ? Math.max(Math.hypot(local.x, local.z) - Math.max(g.half[0], g.half[2]), Math.abs(local.y) - g.half[1])
        : g.kind === 'sphere' ? local.length() - Math.max(...g.half)
        : Math.max(Math.abs(local.x) - g.half[0], Math.abs(local.y) - g.half[1], Math.abs(local.z) - g.half[2]);
      near = Math.min(near, d);
    }
    return near;
  }

  private measurePalm(model: T.Object3D) {
    const hand = this.arms.find(a => a.side < 0)?.hand;
    let mesh: T.SkinnedMesh | null = null;
    model.traverse(o => { if ((o as T.SkinnedMesh).isSkinnedMesh && o.name.includes('Hands')) mesh = o as T.SkinnedMesh; });
    const m = mesh as unknown as T.SkinnedMesh | null;
    if (!hand || !m) return;
    const at = m.skeleton.bones.indexOf(hand);
    if (at < 0) return;
    const position = m.geometry.getAttribute('position'), index = m.geometry.getAttribute('skinIndex'), weight = m.geometry.getAttribute('skinWeight'), inverse = m.skeleton.boneInverses[at], p = new T.Vector3();
    const depths: number[] = [];
    for (let i = 0; i < position.count; i++) {
      for (let k = 0; k < 4; k++) if (index.getComponent(i, k) === at && weight.getComponent(i, k) > .6) { depths.push(p.fromBufferAttribute(position, i).applyMatrix4(inverse).z); break; }
    }
    if (depths.length < 20) return;
    depths.sort((a, b) => a - b);
    // The palm's fullest part, not a stray vertex. In model units: `inFrame` multiplies by the rig's scale.
    this.palmDepth = depths[Math.floor(depths.length * .985)] * model.getWorldScale(p).x / 1.04 * 1.0;
  }

  /** Call before the mixer: what the layers wrote last frame goes back, so a held clip cannot compound it. */
  restore() {
    for (const [bone, q] of this.base) bone.quaternion.copy(q);
    if (this.hips) this.hips.position.copy(this.baseHips);
  }
  /** Call after the mixer: this is the clip's pose, the base of the layers. */
  capture() {
    for (const [bone, q] of this.base) q.copy(bone.quaternion);
    if (this.hips) this.baseHips.copy(this.hips.position);
  }

  get currentGesture() { return this.gesture; }
  get gestureElapsed() { return this.phase; }
  /** Plays a gesture on this body. `at` aims a reach at something real in the world. */
  play(gesture: HandGesture, at?: T.Vector3 | null) { this.gesture = gesture; this.phase = 0; this.reachAt = gesture === 'reach' && at ? at.clone() : null; }
  /** Immediately cancels any active hand/body gesture (`cheer`, `wave`, `stretch`, `reach`, etc.). */
  stopGesture() {
    this.gesture = 'idle';
    this.phase = 0;
    this.reachAt = null;
  }

  private clearArmContactState(arm: Arm, immediateFingerReset = false) {
    arm.contact = null;
    arm.lastContact = null;
    arm.lastContactLocal = null;
    arm.contactT = 0;
    arm.hinge = undefined;
    arm.fitFor = null;
    arm.fitFrame = null;
    arm.fitHeld = false;
    arm.fit.fill(1);
    arm.spreadFit.fill(0);
    arm.jointFit.fill(null);
    this.fitJobs.delete(arm);
    if (immediateFingerReset) {
      arm.lastTwist = 0;
      arm.twistSeen = false;
      for (const f of arm.fingers) {
        f.bend = GRIPS.relaxed[f.finger][f.joint];
        f.spread = GRIPS.relaxed[f.finger][3];
        f.opposition = 0;
      }
    }
  }

  /** A hand goes to something real and stays with it. Null lets it go. Seconds: how long the reach takes. */
  setContact(side: number, contact: HandContact | null, seconds?: number, release?: number) {
    const arm = this.arms.find(a => a.side === side);
    if (!arm) return;
    if (contact) {
      const reachSec = seconds ?? .52;
      if (!arm.contact || reachSec <= 0) {
        arm.contactSeconds = Math.max(.01, reachSec);
      }
      if (reachSec <= 0) arm.contactT = 1;
      if (release !== undefined) arm.releaseSeconds = Math.max(.01, release);
      arm.contact = contact;
      return;
    }
    // Releasing (`contact === null`): support both 4-arg `setContact(side, null, seconds, releaseSec)`
    // and 3-arg `setContact(side, null, releaseSec)` callers, with immediate 0-frame clear when `<= 0`!
    const effRelease = release !== undefined ? release : (seconds !== undefined ? seconds : .42);
    arm.contact = null;
    arm.fitHeld = false;
    this.fitJobs.delete(arm);
    if (effRelease <= 1e-5) {
      this.clearArmContactState(arm, false);
      if (!this.arms.some(a => a.contact || a.contactT > 1e-4)) {
        this.bend.drop = this.bend.pitch = this.bend.yaw = this.bend.roll = 0;
        this.plan.drop = this.plan.pitch = this.plan.yaw = this.plan.roll = 0;
        this.trunkRaw.drop = this.trunkRaw.pitch = this.trunkRaw.yaw = this.trunkRaw.roll = 0;
        this.intendedRoot = null;
      }
    } else {
      arm.releaseSeconds = effRelease;
    }
  }
  /** What this hand has been told to be on. */
  contactOn(side: number) { return this.arms.find(a => a.side === side)?.contact ?? null; }
  /** Where the elbow is: the forearm comes from here, so a hand round a bar takes the way the forearm already lies and the wrist stays straight. */
  elbowWorld(side: number, out = new T.Vector3()) { const arm = this.arms.find(a => a.side === side); return arm ? arm.fore.getWorldPosition(out) : null; }
  /** 0..1: how far this hand has got to its contact. */
  contactProgress(side: number) { return this.arms.find(a => a.side === side)?.contactT ?? 0; }
  /**
   * Clears transient hand contacts (e.g. a door handle or switch reach) and resets accumulated torso bend so a
   * teleport, fast-travel, or posture reset never leaves the character folded toward a distant pre-teleport target.
   */
  clearTransientContacts(includeSecured = false) {
    for (const arm of this.arms) {
      if (!includeSecured && arm.contact?.on) continue;
      this.clearArmContactState(arm, false);
    }
    if (includeSecured || !this.arms.some(a => a.contact)) {
      this.bend.drop = this.bend.pitch = this.bend.yaw = this.bend.roll = 0;
      this.plan.drop = this.plan.pitch = this.plan.yaw = this.plan.roll = 0;
      this.trunkRaw.drop = this.trunkRaw.pitch = this.trunkRaw.yaw = this.trunkRaw.roll = 0;
      this.intendedRoot = null;
    }
    if (this.gesture === 'reach') {
      this.gesture = 'idle';
      this.reachAt = null;
      this.phase = 0;
    }
  }

  /**
   * Deterministic 0-frame emergency / `Reset Room` cleanup: zeroes both arms' contacts, `lastContact`,
   * `contactT`, `readyMix`, torso `bend`, forearm twist, and finger fits so neutral posture restores immediately.
   */
  clearAllContactsImmediate(): void {
    for (const arm of this.arms) {
      this.clearArmContactState(arm, true);
      arm.lastRestLocal = null;
      arm.weight = 0;
    }
    this.fitJobs.clear();
    this.bend.drop = this.bend.pitch = this.bend.yaw = this.bend.roll = 0;
    this.plan.drop = this.plan.pitch = this.plan.yaw = this.plan.roll = 0;
    this.trunkRaw.drop = this.trunkRaw.pitch = this.trunkRaw.yaw = this.trunkRaw.roll = 0;
    this.intendedRoot = null;
    this.readyMix = 0;
    this.readySpeed = 0;
    this.readySway.set(0, 0);
    this.restT = 0;
    this.restMix = 0;
    this.unstable = 0;
    this.loadNow = 0;
    this.strainNow = 0;
    this.smoothedMoveYaw = 0;
    this.smoothedLookYaw = 0;
    this.lookYawSeeded = false;
    this.gesture = 'idle';
    this.phase = 0;
    this.reachAt = null;
    this.poseState = 'idle';
  }

  /** How far the body has gone down for its hands: the eyes go with it. */
  get bendNow() { return this.bend; }
  private intendedRoot: T.Matrix4 | null = null;
  private solvedShoulders = new Map<number, T.Vector3>();
  /** Feed the permitted locomotion request to torso planning even when a
   * secured wrist temporarily prevents the root from completing that step. */
  prepareRootMotion(from: T.Vector3, to: T.Vector3, turn: number, maximum: number) {
    if (maximum <= 0 || (from.distanceToSquared(to) < 1e-14 && Math.abs(turn) < 1e-8)) return;
    this.root.parent?.updateWorldMatrix(true, false);
    const parent = this.root.parent?.matrixWorld ?? new T.Matrix4();
    const delta = new T.Matrix4().makeTranslation(...from.clone().lerp(to, maximum).toArray())
      .multiply(new T.Matrix4().makeRotationY(turn * maximum))
      .multiply(new T.Matrix4().makeTranslation(-from.x, -from.y, -from.z));
    this.intendedRoot = parent.clone().multiply(delta).multiply(parent.clone().invert()).invert();
  }
  private reachSavedBones: { b: T.Bone; p: T.Vector3; q: T.Quaternion }[] = [];
  private reachAffectedBones: { bone: T.Bone; position: T.Vector3; rotation: T.Quaternion }[] = [];
  private reachAncestorChain: T.Object3D[] = [];

  /** A physical prop does not move instantly when the root walks or turns.
   * Limit that root step against the stationary secured wrists until its
   * spring catches up. Trials transform shoulder/pole points only; no bone,
   * object, contact or camera transform is written by this query. */
  heldRootMotionFraction(from: T.Vector3, to: T.Vector3, turn: number, maximum = 1) {
    const held = this.arms.filter(a => a.contact?.on && a.contactT >= .97);
    if (!held.length || maximum <= 0 || (from.distanceToSquared(to) < 1e-14 && Math.abs(turn) < 1e-8)) return maximum;
    const parent = this.root.parent;
    parent?.updateWorldMatrix(true, false);
    if (parent) _hrmParentM.copy(parent.matrixWorld);
    else _hrmParentM.identity();
    _hrmInvParentM.copy(_hrmParentM).invert();
    const k = this.scale;
    this.root.updateWorldMatrix(true, false);
    const rows = held.map(a => {
      // Character.update may already have restored the animation clip before
      // manual/interaction movement. Use the last solved torso in root space,
      // carried through any root motion already accepted this frame.
      const local = this.solvedShoulders.get(a.side);
      const shoulder = local ? local.clone().applyMatrix4(this.root.matrixWorld) : a.upper.getWorldPosition(new T.Vector3());
      const pole = shoulder.clone().addScaledVector(this.right, a.side * .34 * k).addScaledVector(UP, -.42 * k).addScaledVector(this.forward, -.12 * k);
      return { a, shoulder: shoulder.applyMatrix4(_hrmInvParentM), pole: pole.applyMatrix4(_hrmInvParentM), allowance: 0 };
    });
    const error = (r: typeof rows[number], alpha: number) => {
      _hrmAt.copy(from).lerp(to, alpha);
      _hrmQ.setFromAxisAngle(UP, turn * alpha);
      _hrmShoulder.copy(r.shoulder).sub(from).applyQuaternion(_hrmQ).add(_hrmAt).applyMatrix4(_hrmParentM);
      _hrmPole.copy(r.pole).sub(from).applyQuaternion(_hrmQ).add(_hrmAt).applyMatrix4(_hrmParentM);
      const c = r.a.contact!;
      reachableWrist(_hrmShoulder, c.wrist, c.fingers, r.a.lenUpper, r.a.lenFore, contactWristLimit(c, .8), _hrmPole, _hrmReachOut);
      return Math.max(0, _hrmShoulder.distanceTo(c.wrist) - (r.a.lenUpper + r.a.lenFore - .012 * k), _hrmReachOut.distanceTo(c.wrist));
    };
    // An already constrained grip must still be allowed to retreat/recover.
    for (const r of rows) r.allowance = Math.max(.0001 * k, error(r, 0));
    const valid = (alpha: number) => rows.every(r => error(r, alpha) <= r.allowance + 1e-8);
    const steps = Math.max(1, Math.min(64, Math.ceil(maximum * Math.max(from.distanceTo(to) / .015, Math.abs(turn) / .06))));
    let lo = 0;
    for (let i = 1; i <= steps; i++) {
      let hi = maximum * i / steps;
      if (valid(hi)) { lo = hi; continue; }
      for (let j = 0; j < 12; j++) { const mid = (lo + hi) / 2; if (valid(mid)) lo = mid; else hi = mid; }
      return lo;
    }
    return maximum;
  }

  /** Find a stance for a future rigid grasp using analytical shoulder-reach geometry + fast zero-allocation cast FK.
   * Trials never reach the renderer, mixer, feet state or physics (`< 0.5 ms` worst-case, `0` per-trial allocations). */
  reachStance(
    contacts: readonly { side: number; wrist: T.Vector3; fingers: T.Vector3 }[],
    origin: T.Vector3,
    yaw: number,
    free: (at: T.Vector3) => boolean,
    maxPitch = 1.45,
    heading?: { yaw: number },
  ): T.Vector3 | null {
    if (!this.hips || !contacts.length) return null;
    const hips = this.hips, k = this.scale;
    const rows: { side: number; wrist: T.Vector3; fingers: T.Vector3; arm: Arm }[] = [];
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      const arm = this.arms.find(a => a.side === c.side);
      if (arm) rows.push({ side: c.side, wrist: c.wrist, fingers: c.fingers, arm });
    }
    if (!rows.length) return null;

    // Save skeleton state into reusable pool (zero per-call bone clone allocations after warmup)
    let saveIdx = 0;
    for (const b of this.base.keys()) {
      let slot = this.reachSavedBones[saveIdx];
      if (!slot) {
        slot = { b, p: new T.Vector3(), q: new T.Quaternion() };
        this.reachSavedBones.push(slot);
      }
      slot.b = b;
      slot.p.copy(b.position);
      slot.q.copy(b.quaternion);
      saveIdx++;
    }
    const savedCount = saveIdx;
    _rsSavedRootP.copy(this.root.position);
    _rsSavedRootQ.copy(this.root.quaternion);
    _rsSavedFwd.copy(this.forward);
    _rsSavedRight.copy(this.right);
    const hipRoomBefore = this.hipRoom;

    let hasBest = false;
    let bestCost = Infinity;
    let bestYaw = yaw;
    let hasCloseFallback = false;
    let fallbackMiss = Infinity;
    let fallbackCost = Infinity;
    let fallbackYaw = yaw;

    try {
      this.restore();
      this.root.position.copy(origin);
      this.root.rotation.y = yaw;
      this.root.updateWorldMatrix(true, true);
      this.root.getWorldQuaternion(_rsRootQ);
      this.forward.set(0, 0, 1).applyQuaternion(_rsRootQ).setY(0);
      if (this.forward.lengthSq() < 1e-8) this.forward.set(0, 0, 1);
      else this.forward.normalize();
      this.right.crossVectors(this.forward, UP).normalize();

      let floor = Infinity;
      for (let i = 0; i < this.legs.length; i++) {
        const l = this.legs[i];
        const ankle = l.foot.getWorldPosition(_rsFootW).y;
        const fY = maxPitch < 1.45
          ? ankle + l.sole.offsetY(l.foot.getWorldQuaternion(_rsFootQ), l.foot.getWorldScale(_rsFootS))
          : ankle;
        if (fY < floor) floor = fY;
      }
      if (!Number.isFinite(floor)) floor = this.root.getWorldPosition(_rsRootW).y;

      const hipsWorldY = hips.getWorldPosition(_rsHipsW).y;
      const hipsOverFloor = hipsWorldY - floor;
      let maxDrop = Math.max(0, Math.min(.75 * k, hipsOverFloor - REACH_HIP_FLOOR * k));
      let relaxed = false;
      const standing = hipsOverFloor / k;
      const leg = (this.legs.length ? this.legs[0].lenThigh + this.legs[0].lenShin : .83 * k) / k;
      this.hipRoom = { standing, leg };
      const pitchCap = maxPitch >= 1.45 ? TRUNK_PITCH_CAP : maxPitch;
      const pitchCapRelaxed = Math.min(1.45, maxPitch);
      const lim = (drop: number) => relaxed ? pitchCapRelaxed : maxTrunkPitch(drop / k, standing, leg, pitchCap);

      // Collect linear ancestor chain from `this.root` down to `hips.parent` for fast zero-traversal FK updates
      this.reachAncestorChain.length = 0;
      for (let o: T.Object3D | null = hips.parent; o && o !== this.root.parent; o = o.parent) {
        this.reachAncestorChain.push(o);
      }
      this.reachAncestorChain.reverse();

      const spineBone = this.bones.get('spine') ?? null;
      const chestBone = this.bones.get('chest') ?? null;
      let affCount = 0;
      const pushAffected = (b: T.Bone | null | undefined) => {
        if (!b) return;
        for (let i = 0; i < affCount; i++) if (this.reachAffectedBones[i].bone === b) return;
        let slot = this.reachAffectedBones[affCount];
        if (!slot) {
          slot = { bone: b, position: new T.Vector3(), rotation: new T.Quaternion() };
          this.reachAffectedBones.push(slot);
        }
        slot.bone = b;
        slot.position.copy(b.position);
        slot.rotation.copy(b.quaternion);
        affCount++;
      };
      pushAffected(hips);
      pushAffected(spineBone);
      pushAffected(chestBone);
      for (let i = 0; i < rows.length; i++) pushAffected(rows[i].arm.clavicle);

      // Measure standing shoulder height and mean arm length for analytical stance & stoop seeding
      let standShoulderY = hipsWorldY + 0.42 * k;
      let meanArmLen = 0;
      for (let i = 0; i < rows.length; i++) {
        standShoulderY = rows[i].arm.upper.getWorldPosition(_rsShoulder).y;
        meanArmLen += rows[i].arm.lenUpper + rows[i].arm.lenFore;
      }
      meanArmLen /= rows.length;

      _rsPivotW.set(0, 0, 0);
      for (let i = 0; i < contacts.length; i++) _rsPivotW.add(contacts[i].wrist);
      _rsPivotW.divideScalar(contacts.length);
      _rsPivot.copy(_rsPivotW);
      this.root.parent?.worldToLocal(_rsPivot);

      // Detect pinned-origin queries (`candidate => candidate.distanceToSquared(root) < 1e-12`) in O(1)
      const originFree = free(_rsPos.copy(origin));
      const pinnedXZ =
        originFree &&
        !free(_rsProbe.set(origin.x + 1e-3, origin.y, origin.z)) &&
        !free(_rsProbe.set(origin.x - 1e-3, origin.y, origin.z)) &&
        !free(_rsProbe.set(origin.x, origin.y, origin.z + 1e-3));

      let approachYaw = yaw;
      let lastYaw = yaw;
      let evalMiss = Infinity;
      let evalCost = Infinity;

      const stanceAt = (s: readonly number[], hasHeading: boolean) => {
        _rsPos.set(s[0], origin.y, s[1]);
        if (hasHeading) _rsPos.sub(_rsPivot).applyAxisAngle(UP, s[6]).add(_rsPivot);
        return _rsPos;
      };

      const updateTrialChain = (rootMoved: boolean) => {
        if (rootMoved) {
          for (let i = 0; i < this.reachAncestorChain.length; i++) {
            const obj = this.reachAncestorChain[i];
            obj.updateMatrix();
            if (obj.parent) obj.matrixWorld.multiplyMatrices(obj.parent.matrixWorld, obj.matrix);
            else obj.matrixWorld.copy(obj.matrix);
          }
        }
      };

      let lastX = NaN;
      let lastZ = NaN;

      const evaluate = (s: readonly number[], hasHeading: boolean) => {
        stanceAt(s, hasHeading);
        if (!free(_rsPos)) {
          evalMiss = Infinity;
          evalCost = Infinity;
          return;
        }
        for (let i = 0; i < affCount; i++) {
          const item = this.reachAffectedBones[i];
          item.bone.position.copy(item.position);
          item.bone.quaternion.copy(item.rotation);
        }
        const facing = approachYaw + (hasHeading ? s[6] : 0);
        const rootMoved = _rsPos.x !== lastX || _rsPos.z !== lastZ || facing !== lastYaw;
        if (rootMoved) {
          this.root.position.copy(_rsPos);
          lastX = _rsPos.x;
          lastZ = _rsPos.z;
          if (facing !== lastYaw) {
            this.root.rotation.y = facing;
            lastYaw = facing;
          }
          updateTrialChain(true);
          if (this.root.parent) {
            this.root.getWorldQuaternion(_rsRootQ);
            this.forward.set(0, 0, 1).applyQuaternion(_rsRootQ).setY(0);
          } else {
            this.forward.set(Math.sin(facing), 0, Math.cos(facing));
          }
          if (this.forward.lengthSq() < 1e-8) this.forward.set(0, 0, 1);
          else this.forward.normalize();
          this.right.crossVectors(this.forward, UP).normalize();
          this.root.getWorldPosition(_rsRootW);
        }

        this.applyReachTrunk({ drop: s[2], pitch: s[3], yaw: s[4], roll: s[5] }, true);
        for (let i = 0; i < rows.length; i++) {
          this.leadClavicle(rows[i].arm, rows[i].wrist, 1, true);
        }

        let error = 0, miss = 0;
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          _rsShoulder.copy(r.arm.upper.position).applyMatrix4(r.arm.clavicle.matrixWorld);
          _rsPole
            .copy(_rsShoulder)
            .addScaledVector(this.right, r.side * .34 * k)
            .addScaledVector(UP, -.42 * k)
            .addScaledVector(this.forward, -.12 * k);
          reachableWrist(_rsShoulder, r.wrist, r.fingers, r.arm.lenUpper, r.arm.lenFore, .8, _rsPole, _rsProj);
          const armSpan = r.arm.lenUpper + r.arm.lenFore;
          const gap = Math.max(
            _rsProj.distanceTo(r.wrist),
            _rsShoulder.distanceTo(r.wrist) - armSpan + .035 * k,
            0,
          );
          const gNorm = gap / k;
          error += gNorm * gNorm;
          if (gap > miss) miss = gap;
        }
        const reachOut = Math.hypot(_rsPivotW.x - _rsRootW.x, _rsPivotW.z - _rsRootW.z) / k;
        const headAng = hasHeading ? s[6] : 0;
        const dropN = s[2] / k;
        evalMiss = miss;
        evalCost =
          error * 10000 +
          .08 * dropN * dropN +
          .06 * s[3] * s[3] +
          .03 * s[4] * s[4] +
          .06 * s[5] * s[5] +
          .02 * headAng * headAng +
          .04 * (_rsPos.distanceToSquared(origin) / (k * k)) +
          .2 * reachOut * reachOut;
      };

      const hasHeading = !!heading && !pinnedXZ;
      const approaches = hasHeading ? [0, Math.PI / 2, -Math.PI / 2, Math.PI] : [0];
      const dimLen = hasHeading ? 7 : 6;
      const startDim = pinnedXZ ? 2 : 0;
      const stepSizes = [.09, .028, .008];
      const searchRadii = [.05, .10, .15, .22, .32, .44, .58, .74, .90];
      const isDeepFloorReach = _rsPivotW.y < floor + 0.12 * k;
      const passes = isDeepFloorReach ? [true] : [false, true];

      for (const pass of passes) {
        if (hasBest) break;
        relaxed = pass;
        if (relaxed) maxDrop = Math.max(0, Math.min(.75 * k, hipsOverFloor - .18 * k));

        for (let aIdx = 0; aIdx < approaches.length; aIdx++) {
          const approach = approaches[aIdx];
          approachYaw = yaw + approach;
          _rsSeedAt.copy(origin).sub(_rsPivot).applyAxisAngle(UP, approach).add(_rsPivot);

          let startsCount = 0;
          const tryPushStart = (cand: T.Vector3) => {
            if (!free(cand)) return;
            for (let j = 0; j < startsCount; j++) {
              if (_rsStartsPool[j].distanceToSquared(cand) <= (.08 * k) ** 2) return;
            }
            const horizToPivot = Math.hypot(cand.x - _rsPivot.x, cand.z - _rsPivot.z);
            const idealHoriz = 0.56 * meanArmLen;
            const score =
              Math.abs(horizToPivot - idealHoriz) * 2.2 +
              Math.hypot(cand.x - origin.x, cand.z - origin.z) * 0.35;
            if (startsCount < 4) {
              _rsStartsPool[startsCount].copy(cand);
              _rsStartScores[startsCount] = score;
              startsCount++;
            } else {
              let worstIdx = 0;
              for (let j = 1; j < startsCount; j++) {
                if (_rsStartScores[j] > _rsStartScores[worstIdx]) worstIdx = j;
              }
              if (score < _rsStartScores[worstIdx]) {
                _rsStartsPool[worstIdx].copy(cand);
                _rsStartScores[worstIdx] = score;
              }
            }
          };

          if (pinnedXZ) {
            _rsStartsPool[0].copy(origin);
            _rsStartScores[0] = 0;
            startsCount = 1;
          } else {
            if (free(_rsSeedAt)) {
              tryPushStart(_rsSeedAt);
            }
            // Analytical stand-off ray directly in front of `_rsPivot` along `-approachForward`
            // (with automatic furniture-edge bisection when the inner stand-off lies inside a desk/rack/table!)
            const fwdSin = Math.sin(approachYaw);
            const fwdCos = Math.cos(approachYaw);
            let prevBlockedDist = -1;
            const rayFracs = [0.48, 0.66, 0.84, 1.04, 1.26, 1.50];
            for (let rf = 0; rf < rayFracs.length; rf++) {
              const dStand = rayFracs[rf] * meanArmLen;
              _rsIdealAt.set(_rsPivot.x - fwdSin * dStand, origin.y, _rsPivot.z - fwdCos * dStand);
              if (free(_rsIdealAt)) {
                if (prevBlockedDist >= 0) {
                  let bLo = prevBlockedDist, bHi = dStand;
                  for (let b = 0; b < 4; b++) {
                    const bMid = (bLo + bHi) * 0.5;
                    _rsCand.set(_rsPivot.x - fwdSin * bMid, origin.y, _rsPivot.z - fwdCos * bMid);
                    if (free(_rsCand)) bHi = bMid;
                    else bLo = bMid;
                  }
                  _rsIdealAt.set(_rsPivot.x - fwdSin * bHi, origin.y, _rsPivot.z - fwdCos * bHi);
                }
                tryPushStart(_rsIdealAt);
                break;
              }
              prevBlockedDist = dStand;
            }
            if (startsCount === 0) {
              for (let rIdx = 0; rIdx < searchRadii.length; rIdx++) {
                const rad = searchRadii[rIdx] * k;
                for (let i = 0; i < 16; i++) {
                  const angle = i * (Math.PI / 8);
                  _rsCand.set(
                    _rsSeedAt.x + Math.cos(angle) * rad,
                    origin.y,
                    _rsSeedAt.z + Math.sin(angle) * rad,
                  );
                  tryPushStart(_rsCand);
                  if (startsCount >= 2) break;
                }
                if (startsCount >= 2) break;
              }
            }
            // Sort the selected starts by analytical reach score (best first)
            for (let i = 0; i < startsCount - 1; i++) {
              for (let j = i + 1; j < startsCount; j++) {
                if (_rsStartScores[j] < _rsStartScores[i]) {
                  const tmpS = _rsStartScores[i];
                  _rsStartScores[i] = _rsStartScores[j];
                  _rsStartScores[j] = tmpS;
                  _rsCand.copy(_rsStartsPool[i]);
                  _rsStartsPool[i].copy(_rsStartsPool[j]);
                  _rsStartsPool[j].copy(_rsCand);
                }
              }
            }
          }

          // Analytical stoop estimate from target height relative to standing shoulder
          const lowNeed = T.MathUtils.clamp((standShoulderY - 0.22 * k - _rsPivotW.y) / (0.95 * k), 0, 1);
          const dropAnalytic = maxDrop * T.MathUtils.clamp(lowNeed * 0.65, 0, 1);
          const pitchAnalytic = Math.min(lim(dropAnalytic), T.MathUtils.clamp(lowNeed * 1.65, 0, TRUNK_PITCH_CAP));

          for (let stIdx = 0; stIdx < startsCount; stIdx++) {
            const start = _rsStartsPool[stIdx];
            // Single-seed best-first selection: evaluate up to 3 candidate trunk postures in 3 micro-evals,
            // then run coordinate descent ONLY from the single best posture seed!
            let bestSeedDrop = dropAnalytic;
            let bestSeedPitch = Math.min(pitchAnalytic, lim(dropAnalytic));
            let bestSeedHead = 0;
            let bestSeedCost = Infinity;
            const seedCount = lowNeed > 0.15 ? 3 : 2;
            for (let sTry = 0; sTry < seedCount; sTry++) {
              const tryDrop = sTry === 0 ? dropAnalytic : sTry === 1 ? (lowNeed > 0.45 ? maxDrop * 0.35 : 0) : maxDrop * 0.85;
              const tryPitch = sTry === 0 ? pitchAnalytic : sTry === 1 ? (lowNeed > 0.45 ? lim(tryDrop) : 0) : lim(tryDrop) * 0.95;
              _rsState[0] = start.x;
              _rsState[1] = start.z;
              _rsState[2] = tryDrop;
              _rsState[3] = Math.min(tryPitch, lim(tryDrop));
              _rsState[4] = 0;
              _rsState[5] = 0;
              _rsState[6] = 0;
              evaluate(_rsState, hasHeading);
              if (evalCost < bestSeedCost) {
                bestSeedCost = evalCost;
                bestSeedDrop = _rsState[2];
                bestSeedPitch = _rsState[3];
                bestSeedHead = 0;
              }
            }
            const headTries = hasHeading ? [0, Math.PI / 4, -Math.PI / 4] : [0];
            for (let hIdx = 0; hIdx < headTries.length; hIdx++) {
              if (hIdx > 0 && hasBest) break;
              _rsState[0] = start.x;
              _rsState[1] = start.z;
              _rsState[2] = bestSeedDrop;
              _rsState[3] = bestSeedPitch;
              _rsState[4] = 0;
              _rsState[5] = 0;
              _rsState[6] = headTries[hIdx] || bestSeedHead;

              evaluate(_rsState, hasHeading);
              let curMiss = evalMiss;
              let curCost = evalCost;

              for (let stepIdx = 0; stepIdx < stepSizes.length; stepIdx++) {
                // Skip fine sub-centimetre refinement on strict pass if coarse descent is still > 3.5 cm short
                if (!relaxed && stepIdx > 0 && curMiss > 0.035 * k) break;
                if (stepIdx >= 1 && curMiss <= 0.0015 * k) break;
                const step = stepSizes[stepIdx];
                for (let subPass = 0; subPass < 2; subPass++) {
                  let changed = false;
                  for (let dim = startDim; dim < dimLen; dim++) {
                    if (dim === 5) continue;
                    const old = _rsState[dim];
                    const span = dim < 3 ? step * k : step;
                    let chosenVal = old;
                    const lo =
                      dim === 6 ? -Math.PI / 2
                      : dim === 2 || dim === 3 ? 0
                      : dim === 4 ? -.75
                      : dim === 5 ? -.2
                      : (dim === 0 ? start.x : start.z) - .55 * k;
                    const hi =
                      dim === 6 ? Math.PI / 2
                      : dim === 2 ? maxDrop
                      : dim === 3 ? lim(_rsState[2])
                      : dim === 4 ? .75
                      : dim === 5 ? .2
                      : (dim === 0 ? start.x : start.z) + .55 * k;
                    for (let sgn = -1; sgn <= 1; sgn += 2) {
                      let candVal = T.MathUtils.clamp(old + span * sgn, lo, hi);
                      if (candVal === old) continue;
                      _rsState[dim] = candVal;
                      if (dim === 2 && _rsState[3] > lim(_rsState[2]) + 1e-6) {
                        _rsState[dim] = old;
                        continue;
                      }
                      if (dim < 2) {
                        stanceAt(_rsState, hasHeading);
                        if (!free(_rsPos)) {
                          // Blocked by furniture edge: bisect 3 times toward `old` to land flush on the walkable boundary!
                          let fLo = old, fHi = candVal;
                          let foundEdge = false;
                          for (let b = 0; b < 3; b++) {
                            const fMid = (fLo + fHi) * 0.5;
                            _rsState[dim] = fMid;
                            stanceAt(_rsState, hasHeading);
                            if (free(_rsPos)) {
                              fLo = fMid;
                              foundEdge = true;
                            } else {
                              fHi = fMid;
                            }
                          }
                          if (!foundEdge) {
                            _rsState[dim] = old;
                            continue;
                          }
                          candVal = fLo;
                          _rsState[dim] = candVal;
                        }
                      }
                      evaluate(_rsState, hasHeading);
                      if (evalCost < curCost) {
                        chosenVal = candVal;
                        curCost = evalCost;
                        curMiss = evalMiss;
                      }
                    }
                    _rsState[dim] = chosenVal;
                    if (chosenVal !== old) changed = true;
                  }
                  if (!changed) break;
                }
              }

              if (curMiss <= .002 * k && (!hasBest || curCost < bestCost)) {
                stanceAt(_rsState, hasHeading);
                _rsBestAt.copy(_rsPos);
                bestYaw = approachYaw + (hasHeading ? _rsState[6] : 0);
                bestCost = curCost;
                hasBest = true;
              } else if (
                !pinnedXZ &&
                curMiss <= .065 * k &&
                (!hasCloseFallback || curMiss < fallbackMiss - 1e-4 || (Math.abs(curMiss - fallbackMiss) <= 1e-4 && curCost < fallbackCost))
              ) {
                stanceAt(_rsState, hasHeading);
                _rsFallbackAt.copy(_rsPos);
                fallbackYaw = approachYaw + (hasHeading ? _rsState[6] : 0);
                fallbackMiss = curMiss;
                fallbackCost = curCost;
                hasCloseFallback = true;
              }

              if (hasBest && curMiss <= 0.001 * k) break;
            }
            if (hasBest) break;
          }
          if (hasBest) break;
        }
      }
    } finally {
      this.hipRoom = hipRoomBefore ?? null;
      this.root.position.copy(_rsSavedRootP);
      this.root.quaternion.copy(_rsSavedRootQ);
      for (let i = 0; i < savedCount; i++) {
        const s = this.reachSavedBones[i];
        s.b.position.copy(s.p);
        s.b.quaternion.copy(s.q);
      }
      this.forward.copy(_rsSavedFwd);
      this.right.copy(_rsSavedRight);
      this.root.updateWorldMatrix(true, true);
    }

    if (hasBest) {
      if (heading) heading.yaw = bestYaw;
      return _rsBestAt.clone();
    }
    if (hasCloseFallback) {
      if (heading) heading.yaw = fallbackYaw;
      return _rsFallbackAt.clone();
    }
    return null;
  }
  /** Where this arm starts, right now, and how long it is: what a hand can really be asked to do. */
  /**
   * The shoulder of the body the clip is playing, with none of the trunk's reach bend: carried things are held from here.
   * Measured from the bent shoulder instead, a carry target sank with every crouch and the crouch never ended.
   */
  armHome(side: number, out = new T.Vector3()) {
    const arm = this.arms.find(a => a.side === side), local = this.clipShoulders.get(side);
    if (!arm) return null;
    if (!local) return this.armReach(side, out);
    this.root.updateWorldMatrix(true, false);
    out
      .copy(local)
      .applyQuaternion(this.root.getWorldQuaternion(_armHomeRootQ))
      .add(this.root.getWorldPosition(_armHomeRootPos));
    return { shoulder: out, length: arm.lenUpper + arm.lenFore, upper: arm.lenUpper, fore: arm.lenFore };
  }
  private clipShoulders = new Map<number, T.Vector3>();
  armReach(side: number, out = new T.Vector3()) {
    const arm = this.arms.find(a => a.side === side);
    if (!arm) return null;
    arm.upper.getWorldPosition(out);
    return { shoulder: out, length: arm.lenUpper + arm.lenFore, upper: arm.lenUpper, fore: arm.lenFore };
  }
  /** World position of the wrist right now, the hand's palm centre a little further along. */
  wristWorld(side: number, out = new T.Vector3()) {
    const arm = this.arms.find(a => a.side === side);
    return arm ? arm.hand.getWorldPosition(out) : out.set(0, 0, 0);
  }
  /** The hand as it really is after the arms were solved: wrist, the way the fingers point (+Y) and the way the palm faces (+Z). */
  handFrame(side: number, wrist: T.Vector3, fingers: T.Vector3, palm: T.Vector3) {
    const arm = this.arms.find(a => a.side === side);
    if (!arm) return false;
    arm.hand.updateWorldMatrix(true, false);
    const e = arm.hand.matrixWorld.elements;
    wrist.set(e[12], e[13], e[14]);
    fingers.set(e[4], e[5], e[6]).normalize();
    palm.set(e[8], e[9], e[10]).normalize();
    return true;
  }
  /** QA: every joint and fingertip of a hand, in world space, and how far each finger closed on what it holds. */
  fingerPoints(side: number) {
    const arm = this.arms.find(a => a.side === side);
    if (!arm) return [];
    const out: T.Vector3[] = [];
    for (const f of arm.fingers) { f.bone.updateWorldMatrix(true, false); out.push(f.bone.getWorldPosition(new T.Vector3())); if (f.tip) out.push(new T.Vector3(0, f.tip, 0).applyMatrix4(f.bone.matrixWorld)); }
    return out;
  }
  fitOf(side: number) { return [...(this.arms.find(a => a.side === side)?.fit ?? [])]; }
  /** The thing is in the palm now, where it is drawn: the fingers close on it from here. */
  fitNow(side: number) {
    const arm = this.arms.find(a => a.side === side), c = arm?.contact;
    if (!arm || !c?.shape) return false;
    if (c.handleJoints) { arm.fitFor = c.shape; return true; }
    const g = c.shape();
    if (!g) return false;
    arm.fitFor = c.shape;
    // A mesh handle is felt over the next frames on a frozen copy of this hand (see `startFit`).
    if (this.startFit(arm, g, GRIPS[c.grip], c.shape)) { arm.fitFrame = gripFitFrame(arm.hand.matrixWorld, g); return true; }
    // A power grip that closed on nothing was not felt where the hand is: it is tried again, rather than kept as a fist in the air.
    if (this.fitFingers(arm, g, GRIPS[c.grip]) === 0 && c.wrap) { arm.fitFor = null; return false; }
    arm.fitFrame = gripFitFrame(arm.hand.matrixWorld, g);
    return true;
  }
  /** Fits in progress, one per hand, each on a frozen copy of that hand. */
  private fitJobs = new Map<Arm, { steps: Generator<void, number>; copy: FitArm; shape: () => GraspShape | null }>();
  /**
   * A power grip round a mesh handle (a can, a kettle, a bucket) is hundreds of skin measurements against the handle's own
   * triangles: 113–271 ms in one frame, two to four times a pickup. It runs instead on a frozen copy of the hand, a few
   * milliseconds a frame (`runFitJobs`), and the result is the one the same fit gives at once: the same statements on the
   * same numbers. The fingers keep their approach shape meanwhile. False: fit it now (a cheap shape, or no copy possible).
   */
  private startFit(arm: Arm, shape: GraspShape, pose: FingerPose, owner: () => GraspShape | null) {
    if (!(shape.kind === 'mesh' && shape.signedDistance && arm.contact?.wrap && arm.skin?.some(Boolean))) return false;
    const copy = this.freezeHand(arm);
    if (!copy) return false;
    this.fitJobs.set(arm, { steps: this.fitSteps(copy, shape, pose), copy, shape: owner });
    return true;
  }
  /** The finger chains of a hand as they are now, detached: bones under the fingers cloned with their own local transforms,
   * every other bone a world matrix fixed at this moment. Skinning reads exactly what it would read on the live hand. */
  private freezeHand(arm: Arm): FitArm | null {
    arm.hand.updateWorldMatrix(true, true);
    const roots = new Set<T.Object3D>(arm.fingers.map(f => f.bone));
    const under = (o: T.Object3D | null): boolean => { for (let b = o; b && b !== arm.hand; b = b.parent) if (roots.has(b)) return true; return false; };
    const clones = new Map<T.Object3D, T.Bone>(), holders = new Map<T.Object3D, T.Object3D>();
    const cloneOf = (b: T.Object3D): T.Bone | null => {
      const done = clones.get(b);
      if (done) return done;
      if (!b.parent) return null;
      const c = new T.Bone();
      c.position.copy(b.position); c.quaternion.copy(b.quaternion); c.scale.copy(b.scale);
      if (under(b.parent)) { const p = cloneOf(b.parent); if (!p) return null; p.add(c); }
      else {
        let h = holders.get(b.parent);
        if (!h) { h = new T.Object3D(); h.matrixAutoUpdate = false; h.matrix.copy(b.parent.matrixWorld); h.matrixWorld.copy(b.parent.matrixWorld); holders.set(b.parent, h); }
        h.add(c);
      }
      clones.set(b, c);
      return c;
    };
    const proxies = new Map<T.Skeleton, T.Bone[]>();
    const proxy = (sk: T.Skeleton) => {
      let list = proxies.get(sk);
      if (!list) {
        list = sk.bones.map(b => under(b) ? cloneOf(b) ?? b : ({ matrixWorld: b.matrixWorld.clone() } as unknown as T.Bone));
        proxies.set(sk, list);
      }
      return list;
    };
    const fingers = arm.fingers.map(f => { const bone = cloneOf(f.bone); return bone ? { ...f, bone } : null; });
    if (fingers.some(f => !f)) return null;
    const skin = arm.skin?.map(sk => sk ? { ...sk, mesh: { skeleton: { bones: proxy(sk.mesh.skeleton), boneInverses: sk.mesh.skeleton.boneInverses } } as unknown as T.SkinnedMesh } : null);
    for (const c of clones.values()) c.updateWorldMatrix(true, false);
    return { side: arm.side, contact: arm.contact ? { ...arm.contact } : null, hand: new T.Bone(), fingers: fingers as Finger[], skin,
      fit: [...arm.fit], spreadFit: [...arm.spreadFit], jointFit: arm.jointFit.map(j => j ? [...j] : null) };
  }
  /** Advances the fits in progress within this frame's budget; a finished one is applied if its hand still holds that thing. */
  private runFitJobs() {
    const until = performance.now() + FIT_BUDGET_MS;
    for (const [arm, job] of this.fitJobs) {
      if (arm.contact?.shape !== job.shape || arm.fitFor !== job.shape) { this.fitJobs.delete(arm); continue; }
      let r = job.steps.next();
      while (!r.done && performance.now() < until) r = job.steps.next();
      if (!r.done) continue;
      this.fitJobs.delete(arm);
      for (let i = 0; i < arm.fit.length; i++) { arm.fit[i] = job.copy.fit[i]; arm.spreadFit[i] = job.copy.spreadFit[i]; arm.jointFit[i] = job.copy.jointFit[i]; }
      // As at once: a power grip that closed on nothing is tried again.
      if (r.value === 0 && arm.contact?.wrap) arm.fitFor = null;
    }
  }
  /** QA: whether a hand's fit is still being measured. */
  fitPending(side: number) { const arm = this.arms.find(a => a.side === side); return !!arm && this.fitJobs.has(arm); }
  /** Whether this hand's fingers have felt what it holds. */
  fitted(side: number) { const arm = this.arms.find(a => a.side === side); return !!arm && !!arm.contact?.shape && arm.fitFor === arm.contact.shape; }
  /** The thing moved in the hand: the fingers feel for it again on the next frame. */
  refit(side: number) { const arm = this.arms.find(a => a.side === side); if (arm) arm.fitFor = null; }
  /** The hand slides along what it holds on purpose this frame: refitting the fingers at every step of the slide cost 10-24 ms a frame. */
  holdFit(side: number) { const arm = this.arms.find(a => a.side === side); if (arm) arm.fitHeld = true; }

  private rotateWorld(bone: T.Bone, axis: T.Vector3, angle: number) {
    if (Math.abs(angle) < 1e-5 || !bone.parent) return;
    q1.setFromAxisAngle(axis, angle);
    bone.getWorldQuaternion(q2);
    q1.multiply(q2);
    bone.parent.getWorldQuaternion(q3).invert();
    bone.quaternion.copy(q3).multiply(q1);
    bone.updateWorldMatrix(false, false);
  }
  /** Zero-ancestor-walk world-axis rotation when `bone.parent.matrixWorld` is already current (`fastChain` trials). */
  private rotateWorldFast(bone: T.Bone, axis: T.Vector3, angle: number) {
    if (Math.abs(angle) < 1e-5 || !bone.parent) return;
    bone.updateMatrix();
    bone.matrixWorld.multiplyMatrices(bone.parent.matrixWorld, bone.matrix);
    m1.extractRotation(bone.matrixWorld);
    q2.setFromRotationMatrix(m1);
    q1.setFromAxisAngle(axis, angle).multiply(q2);
    m1.extractRotation(bone.parent.matrixWorld);
    q3.setFromRotationMatrix(m1).invert();
    bone.quaternion.copy(q3).multiply(q1);
  }
  private setWorldRotation(bone: T.Bone, q: T.Quaternion) {
    bone.parent!.getWorldQuaternion(q3).invert();
    bone.quaternion.copy(q3).multiply(q);
    bone.updateWorldMatrix(true, false);
  }

  update(f: BodyFrame) {
    if (!this.ready) return;
    const { dt } = f;
    this.root.getWorldQuaternion(this.rootQ);
    this.forward.set(0, 0, 1).applyQuaternion(this.rootQ).setY(0);
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, 1);
    this.forward.normalize();
    this.right.crossVectors(this.forward, UP).normalize();
    this.scale = this.model.getWorldScale(v1).x / 1.04;

    this.phase += dt;
    if (this.gesture !== 'idle' && this.phase > GESTURE_SECONDS[this.gesture]) { this.gesture = 'idle'; this.reachAt = null; }
    const g = this.gesture, t = this.phase, env = gestureEnvelope(g, t);
    const body = gestureBody(g, t);
    const hips = this.hips, spine = this.bones.get('spine'), chest = this.bones.get('chest'), neck = this.bones.get('neck'), head = this.bones.get('head');
    if (f.riderSeated) {
      for (const [tb, bindQ] of this.bindTrunkLocal) {
        tb.quaternion.copy(bindQ);
      }
      if (hips) hips.position.copy(this.bindHipsPos);
    }
    this.model.updateWorldMatrix(true, true);
    // The clip's shoulders, before any layer bends the trunk: where carried things are measured from (`armHome`).
    {
      this.root.updateWorldMatrix(true, false);
      const inverse = q1.copy(this.root.getWorldQuaternion(q2)).invert(), origin = this.root.getWorldPosition(v3);
      for (const arm of this.arms) {
        const s = this.clipShoulders.get(arm.side) ?? new T.Vector3();
        this.clipShoulders.set(arm.side, arm.upper.getWorldPosition(s).sub(origin).applyQuaternion(inverse));
      }
    }

    // ── Travel: the legs walk where the body goes, the shoulders stay cohesively within anatomical torsion. ──
    const rawMove = T.MathUtils.clamp(f.moveYaw ?? 0, -MAX_PELVIS_MOVE_YAW_RAD, MAX_PELVIS_MOVE_YAW_RAD);
    if (f.reduced || dt <= 0) {
      this.smoothedMoveYaw = rawMove;
    } else {
      this.smoothedMoveYaw += (rawMove - this.smoothedMoveYaw) * (1 - Math.exp(-20 * dt));
      if (Math.abs(rawMove) < 1e-4 && Math.abs(this.smoothedMoveYaw) < 5e-4) this.smoothedMoveYaw = 0;
    }
    const move = hips && spine && chest && Math.abs(this.smoothedMoveYaw) > .001 ? this.smoothedMoveYaw : 0;
    this.activeMoveYaw = move;
    this.pelvisFwd.copy(this.forward).applyAxisAngle(UP, this.activeMoveYaw).normalize();
    this.pelvisRight.crossVectors(this.pelvisFwd, UP).normalize();
    let torsionSoFar = 0;
    if (this.activeMoveYaw !== 0 && hips && spine && chest) {
      this.rotateWorld(hips, UP, move);
      hips.updateWorldMatrix(true, true);
      const counterMove = T.MathUtils.clamp(-move, -MAX_TORSO_TORSION_RAD, MAX_TORSO_TORSION_RAD);
      torsionSoFar = counterMove;
      this.rotateWorld(spine, UP, counterMove * .55);
      spine.updateWorldMatrix(true, true);
      this.rotateWorld(chest, UP, counterMove * .45);
    }
    const pelvisPitch = f.pelvisPitch ?? 0;
    if (hips && Math.abs(pelvisPitch) > 1e-4) {
      this.rotateWorld(hips, this.right, -pelvisPitch);
      hips.updateWorldMatrix(true, true);
    }

    // ── Where the clip has the feet, before anything moves the hips: the place they keep. ──
    for (const leg of this.legs) { leg.foot.getWorldPosition(leg.at); leg.foot.getWorldQuaternion(leg.q); leg.goal.copy(leg.at); leg.goalQ.copy(leg.q); }
    for (const leg of this.legs) {
      // A kneeling shin folds behind its knee. Preserve the captured bend
      // plane while solving the ankle on the measured ground.
      if (f.dynamics?.floorPosture) leg.capturedKnee = leg.shin.getWorldPosition(leg.capturedKnee ?? new T.Vector3());
      else leg.capturedKnee = undefined;
      // Standing legs keep the clip's bend plane too. Aiming every knee along the shoe swung toed-out walking knees
      // outward (feet 0.13 m apart, knees 0.205 m: a bow-legged gait the capture never had).
      const hip = leg.thigh.getWorldPosition(v1), knee = leg.shin.getWorldPosition(v2), axis = leg.at.clone().sub(hip);
      leg.clipExtension = axis.length();
      if (axis.lengthSq() > 1e-8) { axis.normalize(); knee.sub(hip); leg.clipBend = (leg.clipBend ?? new T.Vector3()).copy(knee).addScaledVector(axis, -knee.dot(axis)); }
    }
    const freeFeet = !!f.freeFeet;
    const dynamics = f.dynamics && !f.seated && !f.reduced && !freeFeet && this.legs.length === 2 ? f.dynamics : null;
    this.activeSurfaceAt = f.surfaceAt ?? f.dynamics?.surfaceAt ?? null;
    this.activeVerticalGaitWeight = f.verticalGaitWeight ?? dynamics?.verticalGaitWeight;
    const crouch = f.seated ? 0 : f.crouch ?? 0;
    this.crouchNow = crouch;
    if (crouch > 0) {
      this.applyReachTrunk({ drop: CROUCH.pelvis * this.scale * crouch, pitch: .2 * crouch, yaw: 0, roll: 0 });
      for (const shoulder of this.clipShoulders.values()) shoulder.y -= CROUCH.pelvis * this.scale * crouch;
    }
    const weight0 = dynamics ? this.weightOver(dynamics, dt) : this.noWeight();
    // Preserve the clip's stance-leg extension after grounding moves the
    // ankle. The other leg limits how far the hips can rise.
    let lift = 0, slack = Infinity;
    const hasArmContacts = this.arms.some(a => a.contact);
    const crouchLiftScale = 1 - T.MathUtils.clamp(crouch * 2.5, 0, 1);
    if (dynamics?.gait && dynamics.stepping && crouchLiftScale > 1e-4 && !hasArmContacts) {
      for (const leg of this.legs) {
        const hip = leg.thigh.getWorldPosition(v1), ankle = leg.goal;
        const lateralSq = (hip.x - ankle.x) ** 2 + (hip.z - ankle.z) ** 2;
        const rise = (length: number) => Math.sqrt(Math.max(0, length * length - lateralSq)) - (hip.y - ankle.y);
        lift = Math.max(lift, rise(leg.clipExtension ?? 0));
        const maxReach = maxAnatomicalLegReach(leg.lenThigh, leg.lenShin);
        slack = Math.min(slack, rise(maxReach * .996));
      }
      lift *= crouchLiftScale;
    }
    const usePelvisSpring = f.pelvisSpringHz !== undefined && f.pelvisSpringHz > 0;
    if (usePelvisSpring) {
      this.gaitRise = 0;
      const legTargetsActive = !!f.legTargets && (f.legTargets.weight ?? 1) > 0.5;
      if (!dynamics || f.seated || f.dynamics?.floorPosture || legTargetsActive) {
        this.pelvisSpring.relax(dt, this.scale, f.reduced, f.pelvisSpringHz);
      } else {
        const liftTerm = this.strideLane * Math.max(0, Math.min(lift, slack - .008 * this.scale));
        const vGaitNow = T.MathUtils.clamp(
          this.activeVerticalGaitWeight ?? (dynamics.verticalGait ? 1 : 0),
          0,
          1,
        );
        const rootNowY = this.root.getWorldPosition(v2).y;
        let preOver = 0;
        for (const leg of this.legs) {
          leg.thigh.getWorldPosition(v1);
          const reach = maxAnatomicalLegReach(leg.lenThigh, leg.lenShin) - .0005;
          const horizontal = (v1.x - leg.goal.x) ** 2 + (v1.z - leg.goal.z) ** 2;
          const height = Math.sqrt(Math.max(0, reach * reach - horizontal));
          const gaitFoot = this.gaitFeet.get(leg.side);
          // Only planted stance legs (or standing legs) pull pelvis down across stair risers — never airborne swing legs!
          let stanceW = !dynamics.stepping ? 1 : gaitFoot?.on ? 1 : 0;
          if (stanceW < 1 && dynamics.stepping && vGaitNow > 0.01) {
            leg.foot.getWorldScale(_footScale);
            const clearY = leg.at.y + leg.sole.offsetY(leg.q, _footScale) - rootNowY;
            const fastStance = 1 - T.MathUtils.smoothstep(clearY, 0.005 * this.scale, 0.035 * this.scale);
            stanceW = Math.max(stanceW, vGaitNow * fastStance);
          }
          preOver = Math.max(preOver, (v1.y - leg.goal.y - height) * stanceW);
        }
        this.pelvisSpring.step(liftTerm - weight0.sink - preOver, dt, this.scale, f.reduced, f.pelvisSpringHz);
      }
      if (hips && Math.abs(this.pelvisSpring.offsetY) > 1e-5 && !f.dynamics?.floorPosture && !f.seated) {
        hips.position.y += this.pelvisSpring.offsetY / this.model.getWorldScale(v1).x;
        hips.updateWorldMatrix(true, false);
      }
    } else {
      this.pelvisSpring.reset();
      this.gaitRise = T.MathUtils.damp(this.gaitRise, this.strideLane * Math.max(0, Math.min(lift, slack - .008 * this.scale)), 10, dt);
      if (hips && this.gaitRise > .0001 && !f.dynamics?.floorPosture && !f.seated) {
        hips.position.y += this.gaitRise / this.model.getWorldScale(v1).x;
        hips.updateWorldMatrix(true, false);
      }
    }
    f.resolveRoot?.();
    this.model.updateWorldMatrix(true, true);
    // ── A stroke turns the shoulders, not the feet (bounded within anatomical pelvis-to-chest torsion). ──
    const twistNow = f.twist ?? 0;
    if (spine && chest && Math.abs(twistNow) > .001) {
      const clampedTwistDelta =
        T.MathUtils.clamp(torsionSoFar - twistNow, -MAX_TORSO_TORSION_RAD, MAX_TORSO_TORSION_RAD) - torsionSoFar;
      torsionSoFar += clampedTwistDelta;
      this.rotateWorld(spine, UP, clampedTwistDelta * .4);
      spine.updateWorldMatrix(true, true);
      this.rotateWorld(chest, UP, clampedTwistDelta * .6);
      chest.updateWorldMatrix(true, true);
    }
    // ── A heavy thing on one side: the trunk leans away so the weight stays over the feet, the shoulder under load drops. ──
    const kg = f.load?.kg ?? 0, wantLoad = f.reduced ? kg : kg;
    this.loadNow += (Math.min(1, wantLoad / 10) * (f.load?.side ?? this.loadSide) - this.loadNow) * (1 - Math.exp(-5 * dt));
    if (f.load) this.loadSide = f.load.side;
    if (!dynamics && hips && spine && chest && Math.abs(this.loadNow) > .004) {
      const inModel = 1 / this.model.getWorldScale(v1).x, lean = this.loadNow;
      hips.position.addScaledVector(v2.copy(this.right).applyQuaternion(q1.copy(this.rootQ).invert()), -lean * .022 * this.scale * inModel);
      hips.updateWorldMatrix(true, true);
      this.rotateWorld(hips, this.forward, -lean * .05);
      hips.updateWorldMatrix(true, true);
      this.rotateWorld(spine, this.forward, lean * .11);
      spine.updateWorldMatrix(true, true);
      this.rotateWorld(chest, this.forward, lean * .08);
      chest.updateWorldMatrix(true, true);
    }

    // ── The body goes with the hand: to pick something off the floor the knees bend and the back leans, the feet stay where they are. ──
    // The trial solve and renderer use identical balance, gaze and gesture
    // layers, so no later torso writer invalidates planned shoulder reach.
    const rawLookYaw = T.MathUtils.clamp(f.lookYaw + body.headYaw * env, -2, 2);
    if (!this.lookYawSeeded || f.reduced || dt <= 0) {
      this.smoothedLookYaw = rawLookYaw;
      this.lookYawSeeded = true;
    } else if (dynamics?.stepping || Math.abs(rawMove) > 1e-3) {
      this.smoothedLookYaw += (rawLookYaw - this.smoothedLookYaw) * (1 - Math.exp(-18 * dt));
    } else {
      const maxLookStep = Math.max(0.55, 18 * dt);
      this.smoothedLookYaw += T.MathUtils.clamp(rawLookYaw - this.smoothedLookYaw, -maxLookStep, maxLookStep);
    }
    const yaw = this.smoothedLookYaw;
    const pitch = T.MathUtils.clamp(f.lookPitch, f.own ? -1.4 : -.38, 1.4);
    const leanPitchNow = f.leanPitch ?? 0;
    const leanRollNow = f.leanRoll ?? 0;
    let legSettle = 0;
    let appliedTorsoLookDeficit = 0;
    const finishTrunk = (pose: typeof this.bend) => {
      legSettle = 0;
      appliedTorsoLookDeficit = 0;
      let lookAmount = 1;
      if (hips) {
        const inModel = 1 / this.model.getWorldScale(v1).x;
        if (!usePelvisSpring) {
          hips.position.y -= weight0.sink * inModel;
        }
        v2.copy(this.forward).multiplyScalar(weight0.hipZ).addScaledVector(this.right, weight0.hipX).applyQuaternion(q1.copy(this.rootQ).invert());
        hips.position.addScaledVector(v2, inModel);
        if (Math.abs(weight0.hipX) > .001) { hips.updateWorldMatrix(true, false); this.rotateWorld(hips, this.forward, T.MathUtils.clamp(-weight0.hipX * 1.1, -.12, .12)); }
        hips.updateWorldMatrix(true, false);
        if (dynamics && (!usePelvisSpring || hasArmContacts)) {
          // A straight leg is as long as it gets: rather than a foot coming off the floor, the hips come down.
          let over = 0;
          for (const leg of this.legs) {
            leg.thigh.getWorldPosition(v1);
            // Use the solver's actual anatomical reach without `reach * 0.94` horizontal stride truncation.
            const reach = maxAnatomicalLegReach(leg.lenThigh, leg.lenShin) - .0005;
            const horizontal = (v1.x - leg.goal.x) ** 2 + (v1.z - leg.goal.z) ** 2;
            const height = Math.sqrt(Math.max(0, reach * reach - horizontal));
            over = Math.max(over, v1.y - leg.goal.y - height);
          }
          legSettle = over;
          if (over > 0) { hips.position.y -= over * inModel; hips.updateWorldMatrix(true, false); }
        }
      }

      // ── Gesture body: the weight goes somewhere before the arms do. ──
      if (hips && env > .001) {
        hips.position.y += body.rise * env;
        this.rotateWorld(hips, this.forward, body.hipRoll * env);
      }
      this.model.updateWorldMatrix(true, false);

      // ── The look, shared out along the spine (hips stay): net pelvis-to-chest axial torsion bounded <= 0.52 rad. ──
      if (spine && chest && neck && head) {
        const down = Math.max(0, -pitch), lift = Math.max(0, pitch);
        const weight = (f.lean ?? 0) + weight0.pitch;
        // Already bent over the work, looking down is the neck's job: a chest that followed the eyes as well would come up in front of them.
        const looked = f.own ? 1 - .8 * T.MathUtils.smoothstep(weight + pose.pitch, 0, .22) : .8;
        _spineBeforeQ.copy(spine.quaternion);
        _chestBeforeQ.copy(chest.quaternion);
        const preLookTorsion = torsionSoFar + 0.78 * pose.yaw;
        const torsoLook = (amount: number) => {
          spine.quaternion.copy(_spineBeforeQ); chest.quaternion.copy(_chestBeforeQ);
          const wantSpineYaw = yaw * .10 * amount + body.spineYaw * env;
          const wantChestYaw = yaw * .18 * amount;
          const wantTotalYaw = wantSpineYaw + wantChestYaw;
          const clampedTotalYaw =
            T.MathUtils.clamp(preLookTorsion + wantTotalYaw, -MAX_TORSO_TORSION_RAD, MAX_TORSO_TORSION_RAD) -
            preLookTorsion;
          const yawScale = Math.abs(wantTotalYaw) > 1e-6 ? clampedTotalYaw / wantTotalYaw : 0;
          appliedTorsoLookDeficit = wantTotalYaw - clampedTotalYaw;
          spine.updateWorldMatrix(true, false);
          this.rotateWorld(spine, this.right, (-down * .16 * looked + lift * .05 * (f.own ? 1 : .8)) * amount + body.spinePitch * env - weight * .55 - leanPitchNow * .4);
          spine.updateWorldMatrix(true, false);
          this.rotateWorld(spine, UP, wantSpineYaw * yawScale);
          this.rotateWorld(spine, this.forward, weight0.roll * .55 + leanRollNow * .4);
          spine.updateWorldMatrix(true, false);
          this.rotateWorld(chest, this.right, (-down * .22 * looked + lift * .08 * (f.own ? 1 : .8)) * amount + body.chestPitch * env - weight * .45 - this.balance.lagPitch - leanPitchNow * .6);
          chest.updateWorldMatrix(true, false);
          this.rotateWorld(chest, UP, wantChestYaw * yawScale);
          this.rotateWorld(chest, this.forward, body.chestRoll * env + weight0.roll * .45 + this.balance.lagRoll + leanRollNow * .6);
          chest.updateWorldMatrix(true, false);
        };
        // Eyes may turn away from a held thing; shoulders may only follow while both arms can
        // retain their contacts. Evaluate real shoulder positions, not a camera-angle exception.
        const heldArms = this.arms.filter(a => a.contact?.on && a.contactT >= .97);
        const reachError = () => heldArms.reduce((sum, a) => {
          const reach = a.lenUpper + a.lenFore - .018 * this.scale;
          const miss = Math.max(0, a.upper.getWorldPosition(v1).distanceTo(a.contact!.wrist) - reach);
          return sum + miss * miss;
        }, 0);
        // A planned placement owns the trunk; looking at its ring is handled by
        // the neck/head, rather than rotating already planned shoulders again.
        // A floor posture can bear weight on a palm. Let the head follow the
        // view without swinging the clip's supporting shoulder into the floor.
        lookAmount = heldArms.some(a => a.contact?.bodyGoal) ? 0
          : f.dynamics?.floorPosture ? 1 - (f.dynamics.motionWeight ?? 1) : 1;
        torsoLook(lookAmount);
        const fullError = reachError();
        if (heldArms.length && fullError > 1e-10) {
          torsoLook(0);
          const neutralError = reachError();
          if (neutralError < fullError) {
            lookAmount = 0;
            if (neutralError < 1e-10) {
              let hi = 1;
              for (let i = 0; i < 8; i++) {
                const mid = (lookAmount + hi) / 2; torsoLook(mid);
                if (reachError() < 1e-10) lookAmount = mid; else hi = mid;
              }
            }
          }
          torsoLook(lookAmount);
        }
      }
      if (dynamics && this.strainNow > .01) this.tremble(chest);
      this.model.updateWorldMatrix(true, false);
      return lookAmount;
    };
    // Guard against stale world contacts left behind by a teleport or fast-travel (> 2.6 m away).
    {
      const rootW = this.root.getWorldPosition(v1);
      const maxGhostDistSq = (2.6 * this.scale) ** 2;
      let clearedGhost = false;
      for (const arm of this.arms) {
        const ghostActive = arm.contact && !arm.contact.on && rootW.distanceToSquared(arm.contact.wrist) > maxGhostDistSq;
        const ghostRelease = !arm.contact && arm.contactT > 0 && arm.lastContact && rootW.distanceToSquared(arm.lastContact.wrist) > maxGhostDistSq;
        if (ghostActive || ghostRelease) {
          this.clearArmContactState(arm, false);
          clearedGhost = true;
        }
      }
      if (clearedGhost && !this.arms.some(a => a.contact)) {
        this.bend.drop = this.bend.pitch = this.bend.yaw = this.bend.roll = 0;
        this.plan.drop = this.plan.pitch = this.plan.yaw = this.plan.roll = 0;
        this.trunkRaw.drop = this.trunkRaw.pitch = this.trunkRaw.yaw = this.trunkRaw.roll = 0;
      }
    }
    let bending = false;
    let lookAmount = 1;
    let shouldersFixed = 0;
    const securedClavicleW = (arm: Arm) => (f.reduced ? 1 : minJerk(arm.contactT));
    if (f.riderSeated) {
      this.bend.drop = this.bend.pitch = this.bend.yaw = this.bend.roll = 0;
      this.plan.drop = this.plan.pitch = this.plan.yaw = this.plan.roll = 0;
      this.trunkRaw.drop = this.trunkRaw.pitch = this.trunkRaw.yaw = this.trunkRaw.roll = 0;
      lookAmount = finishTrunk(this.bend);
      if (f.resolveContacts) {
        for (const arm of this.arms) {
          if (!arm.contact?.on || arm.contactT < .97) continue;
          this.leadClavicle(arm, arm.contact.wrist, securedClavicleW(arm));
          shouldersFixed |= arm.side > 0 ? 1 : 2;
        }
      }
      this.model.updateWorldMatrix(true, true);
      f.resolveContacts?.();
    } else {
      const bendTarget = this.planTrunk(!!f.seated, pose => {
        finishTrunk(pose);
        return legSettle;
      });
      const easing = f.reduced ? 1 : 1 - Math.exp(-(this.arms.some(a => (a.contact?.kg ?? 0) > 4) ? 4.5 : 7) * dt);
      this.bend.drop += (bendTarget.drop - this.bend.drop) * easing;
      this.bend.pitch += (bendTarget.pitch - this.bend.pitch) * easing;
      this.bend.yaw += (bendTarget.yaw - this.bend.yaw) * easing;
      this.bend.roll += (bendTarget.roll - this.bend.roll) * easing;
      if (!this.arms.some(a => a.contact || a.contactT > 1e-4)) {
        if (
          f.reduced ||
          dt <= 0 ||
          (Math.abs(this.bend.drop) <= .002 &&
            Math.abs(this.bend.pitch) <= .012 &&
            Math.abs(this.bend.yaw) <= .012 &&
            Math.abs(this.bend.roll) <= .012)
        ) {
          this.bend.drop = this.bend.pitch = this.bend.yaw = this.bend.roll = 0;
        }
      }
      const trunkBase = f.resolveContacts && this.arms.some(a => a.contact?.on && a.contactT >= .97)
        ? [hips, spine, chest, ...this.arms.map(a => a.clavicle)].filter((b): b is T.Bone => !!b).map(b => ({ b, p: b.position.clone(), q: b.quaternion.clone() })) : null;
      bending = this.bend.drop > .002 || this.bend.pitch > .012 || Math.abs(this.bend.yaw) > .012 || Math.abs(this.bend.roll) > .012;
      if (bending) this.applyReachTrunk(this.bend);
      lookAmount = finishTrunk(this.bend);
      // A secured grasp is planned from the actual shoulders. The collarbone
      // previously moved them AFTER resolveContacts, invalidating a reachable
      // shared object target by centimetres. Lead once, before that callback;
      // the arm solve below must not move those same shoulders a second time.
      if (f.resolveContacts) for (const arm of this.arms) {
        if (!arm.contact?.on || arm.contactT < .97) continue;
        this.leadClavicle(arm, arm.contact.wrist, securedClavicleW(arm));
        shouldersFixed |= arm.side > 0 ? 1 : 2;
      }
      // FK trials update only the ancestry of joints they measure. Publish the
      // chosen full skeleton once before the physics/contact callback reads it.
      this.model.updateWorldMatrix(true, true);
      f.resolveContacts?.();
      if (trunkBase) {
        const apply = (pose: typeof this.bend) => {
          for (const s of trunkBase) { s.b.position.copy(s.p); s.b.quaternion.copy(s.q); }
          this.model.updateWorldMatrix(true, false);
          this.applyReachTrunk(pose);
          lookAmount = finishTrunk(pose);
          for (const arm of this.arms) {
            if (shouldersFixed & (arm.side > 0 ? 1 : 2)) {
              this.leadClavicle(arm, arm.contact!.wrist, securedClavicleW(arm));
            }
          }
          this.model.updateWorldMatrix(true, false);
        };
        // Rapier has now advanced. Resolve the actual secured contacts against
        // the articulated torso, damping sub-millimetre slack while strictly enforcing feasibility.
        bending = this.projectSecuredTrunk(!!f.seated, dt, !!f.reduced, apply) || bending;
      }
    }

    this.model.updateWorldMatrix(true, true);
    if (neck && head) {
      const chestTravelDrift = move + T.MathUtils.clamp(-move, -MAX_TORSO_TORSION_RAD, MAX_TORSO_TORSION_RAD);
      const cervicalComp = -chestTravelDrift + appliedTorsoLookDeficit * 0.65;
      const wantNeckYaw = T.MathUtils.clamp(yaw * (.30 + .14 * (1 - lookAmount)) + cervicalComp * .44, -.48, .48);
      const wantHeadYaw = T.MathUtils.clamp(yaw * (.38 + .14 * (1 - lookAmount)) + cervicalComp * .56, -.62, .62);
      const rawCervicalYaw = wantNeckYaw + wantHeadYaw;
      const clampedCervicalYaw = T.MathUtils.clamp(rawCervicalYaw, -MAX_CERVICAL_YAW_RAD, MAX_CERVICAL_YAW_RAD);
      const cervScale = Math.abs(rawCervicalYaw) > 1e-6 ? clampedCervicalYaw / rawCervicalYaw : 0;
      this.rotateWorld(neck, UP, wantNeckYaw * cervScale);
      neck.updateWorldMatrix(true, true);
      // The eyes stay level when the trunk leans: the neck takes back part of it.
      this.rotateWorld(neck, this.right, pitch * .24 + (weight0.pitch + this.balance.lagPitch) * .55 + (f.own ? 0 : Math.min(.55, this.bend.pitch * .42)));
      neck.updateWorldMatrix(true, true);
      this.rotateWorld(head, UP, wantHeadYaw * cervScale);
      head.updateWorldMatrix(true, true);
      this.rotateWorld(head, this.right, (f.own ? pitch * .3 : pitch * .4) + body.headPitch * env);
      this.rotateWorld(head, this.forward, body.headRoll * env);
      head.updateWorldMatrix(true, true);
    }
    this.model.updateWorldMatrix(true, true);

    // ── The arms ──
    // Gestures hang off the eyes' frame. For the owner it follows the view, so the hands are seen; for everyone else it follows the body.
    const targetPitch = f.own ? T.MathUtils.clamp(f.lookPitch, -.55, .32) * .85 : 0;
    this.gesturePitch = f.reduced ? targetPitch : this.gesturePitch + (targetPitch - this.gesturePitch) * (1 - Math.exp(-9 * dt));
    const c = Math.cos(this.gesturePitch), s = Math.sin(this.gesturePitch);
    _gestFwd.copy(this.forward).multiplyScalar(c).addScaledVector(UP, s);
    _gestUp.copy(UP).multiplyScalar(c).addScaledVector(this.forward, -s);
    const k = this.scale;
    // Through one's own eyes the hands come up into the view: nobody claps in the bottom pixel of their own sight.
    const ownLift = f.own ? (g === 'cheer' ? -.02 : .095) : 0;
    const inFrame = (out: T.Vector3, side: number, a: readonly number[], origin: T.Vector3 | null) => {
      out.copy(this.right).multiplyScalar(side * a[0] * k).addScaledVector(_gestUp, (a[1] + (origin === f.eye ? ownLift : 0)) * k).addScaledVector(_gestFwd, a[2] * k);
      if (origin) out.add(origin);
      return out;
    };
    const rest = f.rest ?? null;
    this.restT = f.reduced
      ? (rest ? 1 : 0)
      : rest
        ? Math.min(1, this.restT + dt / 0.26)
        : Math.max(0, this.restT - dt / 0.22);
    this.restMix = f.reduced ? this.restT : minJerk(this.restT);
    this.root.getWorldPosition(_restRootPos);
    this.root.getWorldQuaternion(_restRootQ);
    _restInvRootQ.copy(_restRootQ).invert();
    const ready = f.ready ?? null;
    const rawSpeed = ready ? Math.max(0, ready.speed) : 0;
    this.readySpeed = !ready ? 0 : f.reduced ? rawSpeed : this.readySpeed + (rawSpeed - this.readySpeed) * (1 - Math.exp(-14 * dt));
    // First-person locomotion pose state: idle and walk keep arms naturally lowered in the gait clip;
    // running blends in a stride-synced counter-phase arm swing without ever raising hands on camera look.
    // In 3rd-person (`!ready`), `readyMix` decays rapidly and `readyW` is strictly `0` so gait arm swing is never overridden!
    const runIntent = ready && !rest && !f.reduced ? T.MathUtils.smoothstep(this.readySpeed, 1.9, 2.7) : 0;
    const readyRate = !ready ? 18 : runIntent > this.readyMix ? 8.5 : 10.5;
    if (f.reduced || (dt <= 0 && !ready)) {
      this.readyMix = 0;
    } else {
      this.readyMix += (runIntent - this.readyMix) * (1 - Math.exp(-readyRate * dt));
      if (this.readyMix < 1e-4 && runIntent === 0) this.readyMix = 0;
    }
    if (ready && this.readyMix > .001) {
      const k2 = f.reduced ? 1 : 1 - Math.exp(-9 * dt);
      this.readySway.x += (T.MathUtils.clamp(-ready.turn * .01, -.022, .022) - this.readySway.x) * k2;
      this.readySway.y += (T.MathUtils.clamp(-ready.nod * .008, -.016, .016) - this.readySway.y) * k2;
    } else {
      this.readySway.multiplyScalar(dt > 0 ? Math.exp(-10 * dt) : 0);
    }

    for (const arm of this.arms) {
      const side = arm.side;
      const shoulderNow = arm.upper.getWorldPosition(_armShoulderNow);
      const over = gesturePose(g, side, t, this.palmDepth / this.scale);
      const restHand = rest ? (side < 0 ? rest.left : rest.right) : null;
      if (!arm.contact && (arm.releaseSeconds <= 1e-5 || f.reduced)) {
        arm.contactT = 0;
      } else {
        arm.contactT = T.MathUtils.clamp(arm.contactT + (arm.contact ? dt / arm.contactSeconds : -dt / arm.releaseSeconds), 0, 1);
      }
      if (!arm.contact && arm.contactT > 0 && arm.lastContact) {
        const rootDistSq = _restRootPos.distanceToSquared(arm.lastContact.wrist);
        const shDistSq = shoulderNow.distanceToSquared(arm.lastContact.wrist);
        const behindBody = v2.copy(arm.lastContact.wrist).sub(shoulderNow).dot(this.forward) < -0.08 * k;
        if (
          rootDistSq > (1.25 * k) ** 2 ||
          shDistSq > (0.88 * k) ** 2 ||
          arm.lastContact.wrist.y > shoulderNow.y + 0.15 * k ||
          behindBody
        ) {
          arm.contactT = Math.max(0, arm.contactT - (dt > 0 ? dt / 0.10 : 1));
        }
      }
      if (!arm.contact && arm.contactT <= 1e-4) {
        if (arm.lastContact || arm.lastContactLocal || arm.contactT !== 0 || arm.hinge) {
          this.clearArmContactState(arm, false);
        }
      }
      const contactW = f.reduced ? (arm.contact ? 1 : 0) : minJerk(arm.contactT);
      const gestureW = over ? env : 0;
      const hasCachedRest = !restHand && !arm.contact && this.restMix > .0005 && !!arm.lastRestLocal;
      const restW = restHand
        ? this.restMix
        : hasCachedRest
          ? this.restMix * (1 - contactW) * (1 - gestureW)
          : 0;
      const readyW = ready && !restHand ? this.readyMix * (1 - gestureW) * (1 - contactW) * (1 - restW) : 0;
      // Off balance a free standing arm goes out to the side; never flail arms during normal stepping locomotion!
      const rawCatchW =
        !arm.contact && !restHand && (!dynamics?.stepping || this.balance.out.over > 0.02)
          ? this.unstable * (1 - gestureW) * (1 - restW)
          : 0;
      const catchW = rawCatchW > 0.01 ? rawCatchW : 0;
      const hasContactLayer = (!!arm.contact && contactW > 0) || (arm.contactT > 1e-4 && !!(arm.contact ?? arm.lastContact));
      const hasGestureLayer = gestureW > 0.0005 && !!over;
      const hasRestLayer = restW > 0.0005 && !!(restHand || arm.lastRestLocal);
      const hasReadyLayer = readyW > 0.001 && !!ready;
      const any = Math.max(
        hasContactLayer ? Math.max(contactW, 0.001) : 0,
        hasGestureLayer ? gestureW : 0,
        hasRestLayer ? restW : 0,
        hasReadyLayer ? readyW : 0,
        catchW,
      );

      // What the clip has the hand doing, and the fingers' default.
      arm.fore.getWorldPosition(_fkElbow);
      arm.hand.getWorldPosition(_fkWrist);
      arm.hand.getWorldQuaternion(_fkHandQ);
      let pose: FingerPose = GRIPS.relaxed;

      if (any > .0005) {
        const wrist = _armWrist.copy(_fkWrist);
        const goalQ = _armGoalQ.copy(_fkHandQ);
        const pole = _armPole.copy(_fkElbow);
        let limit = 1.2;
        // Lifting off a rest and going to a gesture blends through the rest: each layer starts from the one under it.
        if (hasRestLayer) {
          let restCurl = 0.25;
          let restGrip: Grip | undefined;
          if (restHand) {
            _restWristScratch.copy(restHand.wrist);
            _restWristScratch.y = Math.min(_restWristScratch.y, shoulderNow.y - 0.12 * k);
            _restFingersScratch.copy(restHand.fingers);
            _restPalmScratch.copy(restHand.palm);
            restCurl = restHand.curl;
            restGrip = restHand.grip;
            const cache = arm.lastRestLocal ??= {
              offset: new T.Vector3(),
              fingersLocal: new T.Vector3(),
              palmLocal: new T.Vector3(),
              curl: restCurl,
            };
            cache.offset.copy(_restWristScratch).sub(_restRootPos).applyQuaternion(_restInvRootQ);
            cache.fingersLocal.copy(_restFingersScratch).applyQuaternion(_restInvRootQ);
            cache.palmLocal.copy(_restPalmScratch).applyQuaternion(_restInvRootQ);
            cache.curl = restCurl;
            cache.grip = restGrip;
          } else if (arm.lastRestLocal) {
            _restWristScratch.copy(arm.lastRestLocal.offset).applyQuaternion(_restRootQ).add(_restRootPos);
            _restWristScratch.y = Math.min(_restWristScratch.y, shoulderNow.y - 0.12 * k);
            _restFingersScratch.copy(arm.lastRestLocal.fingersLocal).applyQuaternion(_restRootQ).normalize();
            _restPalmScratch.copy(arm.lastRestLocal.palmLocal).applyQuaternion(_restRootQ).normalize();
            restCurl = arm.lastRestLocal.curl;
            restGrip = arm.lastRestLocal.grip;
          }
          wrist.lerp(_restWristScratch, restW);
          handRotation(_restFingersScratch, _restPalmScratch, q2);
          goalQ.slerp(q2, restW);
          pole.lerp(v2.copy(shoulderNow).addScaledVector(this.right, side * .22 * k).addScaledVector(UP, -.32 * k).addScaledVector(this.forward, -.05 * k), restW);
          limit = .75;
          pose = restGrip ? GRIPS[restGrip] : curlPose(restCurl);
        }
        if (hasReadyLayer && ready) {
          // Counter-phase athletic running swing anchored to the anatomical shoulder in body frame (never glued to camera pitch).
          const swing = Math.sin(ready.stride + (side > 0 ? 0 : Math.PI));
          const fwd = Math.max(0, swing), back = Math.max(0, -swing);
          const bounce = Math.cos(ready.stride * 2) * .014;
          const pitchFollow = f.own ? T.MathUtils.clamp(f.lookPitch, -.32, .2) * .22 : 0;
          const lateral = f.own
            ? (side * (.015 - .05 * fwd + .018 * back) + this.readySway.x) * k
            : side * (.022 - .042 * fwd + .024 * back) * k;
          const vertical = f.own
            ? (-.255 + .185 * fwd - .075 * back + bounce + pitchFollow * .08 + this.readySway.y) * k
            : (-.295 + .185 * fwd - .065 * back + bounce) * k;
          const forwardReach = f.own
            ? (.11 + .18 * fwd - .22 * back) * k
            : (.03 + .22 * fwd - .26 * back) * k;
          const goal = v2.copy(shoulderNow)
            .addScaledVector(this.right, lateral)
            .addScaledVector(UP, vertical)
            .addScaledVector(this.forward, forwardReach);
          if (f.trackArmSwing && !f.own) {
            // Arm angles from downward vertical. The upper arm leads, the forearm
            // follows with a softer elbow at the back and a tighter one in front.
            const shoulderAngle = -.12 + .55 * swing;
            const foreAngle = shoulderAngle + 1.03 + .21 * swing;
            goal.copy(shoulderNow)
              .addScaledVector(this.right, side * (.075 - .025 * swing) * k)
              .addScaledVector(UP, -arm.lenUpper * Math.cos(shoulderAngle) - arm.lenFore * Math.cos(foreAngle))
              .addScaledVector(this.forward, arm.lenUpper * Math.sin(shoulderAngle) + arm.lenFore * Math.sin(foreAngle));
          }
          wrist.lerp(goal, readyW);
          const fingers = v3.copy(this.forward).multiplyScalar(.78 + .14 * fwd - .34 * back)
            .addScaledVector(this.right, -side * (.16 + .08 * fwd))
            .addScaledVector(UP, .34 * fwd - .42 * back)
            .normalize();
          const palm = v4.copy(this.right).multiplyScalar(-side * .92)
            .addScaledVector(UP, .18 + .1 * fwd)
            .addScaledVector(this.forward, .08)
            .normalize();
          handRotation(fingers, palm, q2);
          goalQ.slerp(q2, readyW);
          pole.lerp(v2.copy(shoulderNow).addScaledVector(this.right, side * .26 * k).addScaledVector(UP, -.36 * k).addScaledVector(this.forward, (-.14 - .08 * back) * k), readyW);
          limit = .85;
          pose = blendPose(pose, curlPose(.32 + .08 * fwd, .06), readyW);
        }
        if (catchW > .01) {
          const out = v2.copy(shoulderNow).addScaledVector(this.right, side * .34 * k).addScaledVector(UP, -.1 * k).addScaledVector(this.forward, .08 * k);
          wrist.lerp(out, catchW);
          pole.lerp(v2.copy(shoulderNow).addScaledVector(this.right, side * .24 * k).addScaledVector(UP, -.34 * k).addScaledVector(this.forward, -.1 * k), catchW);
          limit = Math.max(limit, .9);
          pose = blendPose(pose, GRIPS.open, catchW);
        }
        if (over && hasGestureLayer) {
          // A real reach: the wrist goes to the thing, the fingers towards it.
          const wristGoal = inFrame(_gestWristGoal, side, over.wrist, f.eye);
          let fingersGoal = inFrame(_gestFingersGoal, side, over.fingers, null);
          let palmGoal = inFrame(_gestPalmGoal, side, over.palm, null);
          if (g === 'reach' && this.reachAt && side > 0) {
            _gestTo.copy(this.reachAt).sub(wristGoal);
            _gestAim.copy(_gestTo.lengthSq() > 1e-5 ? _gestTo : fingersGoal).normalize();
            wristGoal.add(_gestTo).addScaledVector(_gestAim, -.14 * k);
            fingersGoal = _gestAim;
            palmGoal = _gestPalmGoal.copy(this.right).multiplyScalar(-1).addScaledVector(UP, -.6).normalize();
          }
          wrist.lerp(wristGoal, gestureW);
          handRotation(fingersGoal, palmGoal, q2);
          goalQ.slerp(q2, gestureW);
          inFrame(v2, side, over.pole, shoulderNow);
          pole.lerp(v2, gestureW);
          limit = wristLimit(g, gestureW);
          pose = blendPose(pose, curlPose(over.curl, over.thumbOut ?? 0), gestureW);
          if (over.grip) pose = blendPose(pose, over.grip === 'flat' ? arm.flat : GRIPS[over.grip], gestureW);
        }
        if (hasContactLayer) {
          const ct = arm.contact ?? arm.lastContact;
          if (ct) {
            const behindBody = !arm.contact && v2.copy(ct.wrist).sub(shoulderNow).dot(this.forward) < -0.08 * k;
            const useBodyRelease =
              !arm.contact &&
              !!arm.lastContactLocal &&
              (_restRootPos.distanceToSquared(ct.wrist) > (1.25 * k) ** 2 ||
                shoulderNow.distanceToSquared(ct.wrist) > (0.88 * k) ** 2 ||
                ct.wrist.y > shoulderNow.y + 0.15 * k ||
                behindBody);
            if (useBodyRelease && arm.lastContactLocal) {
              _releaseWristScratch.copy(arm.lastContactLocal.offset).applyQuaternion(_restRootQ).add(shoulderNow);
              _releaseWristScratch.y = Math.min(_releaseWristScratch.y, shoulderNow.y + 0.05 * k);
              _releaseFingersScratch.copy(arm.lastContactLocal.fingersLocal).applyQuaternion(_restRootQ).normalize();
              _releasePalmScratch.copy(arm.lastContactLocal.palmLocal).applyQuaternion(_restRootQ).normalize();
              wrist.lerp(_releaseWristScratch, contactW);
              handRotation(_releaseFingersScratch, _releasePalmScratch, q2);
            } else {
              wrist.lerp(ct.wrist, contactW);
              handRotation(ct.fingers, ct.palm, q2);
            }
            goalQ.slerp(q2, contactW);
            if (ct.pole && !useBodyRelease) pole.lerp(ct.pole, contactW);
            else pole.lerp(v2.copy(shoulderNow).addScaledVector(this.right, side * .34 * k).addScaledVector(UP, -.42 * k).addScaledVector(this.forward, -.12 * k), contactW);
            limit = contactWristLimit(ct, .9);
            pose = blendPose(pose, GRIPS[ct.grip], T.MathUtils.smoothstep(arm.contactT, .55, 1));
          }
        }
        if (arm.contact) {
          arm.lastContact = arm.contact;
          const relCache = arm.lastContactLocal ??= {
            offset: new T.Vector3(),
            fingersLocal: new T.Vector3(),
            palmLocal: new T.Vector3(),
            grip: arm.contact.grip,
          };
          relCache.offset.copy(arm.contact.wrist).sub(shoulderNow).applyQuaternion(_restInvRootQ);
          relCache.fingersLocal.copy(arm.contact.fingers).applyQuaternion(_restInvRootQ);
          relCache.palmLocal.copy(arm.contact.palm).applyQuaternion(_restInvRootQ);
          relCache.grip = arm.contact.grip;
          relCache.limit = arm.contact.limit;
        }
        const clavicleW = Math.max(contactW, hasReadyLayer ? readyW * 0.35 : 0, hasGestureLayer ? gestureW : 0);
        this.solve(arm, wrist, pole, goalQ, limit, g === 'clap' && gestureW > .5, !!(shouldersFixed & (side > 0 ? 1 : 2)), clavicleW, dt);
      } else {
        // The arm is the clip's. Only the forearm's roll follows cleanly back to neutral, so the skin stays quiet.
        this.distributeTwist(arm, dt, true);
      }
      // Once the hand is on the thing the fingers close until they meet it, each by its own amount.
      if (this.fitJobs.has(arm)) this.runFitJobs();
      const shape = arm.contact?.shape ?? null;
      const wrapShape = shape && arm.contact?.wrap && !arm.contact.handleJoints && arm.contactT >= .94 ? shape() : null;
      const relative = wrapShape ? gripFitFrame(arm.hand.matrixWorld, wrapShape) : null;
      if (relative && arm.contactT >= .999 && !arm.fitHeld && gripFitChanged(arm.fitFrame, relative)) arm.fitFor = null;
      arm.fitHeld = false;
      // A thing that is carried is felt by its holder once it really sits in the palm (fitNow); until then the hand comes in open, shaped for it.
      // A power grip feels the handle here, where hand and handle are both this frame's: after the arm is solved, before drawing.
      if (shape && arm.contact?.handleJoints) arm.fitFor = shape;
      else if (shape && arm.contact?.wrap && arm.contactT >= .94 && arm.fitFor !== shape) {
        const g = wrapShape;
        arm.fitFor = shape;
        if (!g) arm.fitFor = null;
        else if (this.startFit(arm, g, GRIPS[arm.contact.grip], shape)) arm.fitFrame = relative;
        else if (this.fitFingers(arm, g, GRIPS[arm.contact.grip]) === 0) arm.fitFor = null;
        else arm.fitFrame = relative;
      }
      else if (shape && arm.contact?.on && arm.fitFor !== shape) { arm.fit.fill(.42); arm.jointFit.fill(null); }
      else if (shape && arm.contactT >= .94 && arm.fitFor !== shape) { arm.fitFor = shape; const g = shape(); if (g) this.fitFingers(arm, g, pose); }
      else if (!shape) {
        if (
          arm.fitFor ||
          arm.fitFrame ||
          this.fitJobs.has(arm) ||
          arm.fit[0] !== 1 ||
          arm.fit[1] !== 1 ||
          arm.spreadFit[0] !== 0 ||
          arm.jointFit[0] !== null ||
          arm.jointFit[1] !== null
        ) {
          arm.fitFor = null;
          arm.fitFrame = null;
          arm.fit.fill(1);
          arm.spreadFit.fill(0);
          arm.jointFit.fill(null);
          this.fitJobs.delete(arm);
        }
      }
      this.fingers(arm, pose, dt, f.reduced, f.dynamics?.floorPosture && !arm.contact ? f.dynamics.motionWeight ?? 0 : 0, any, f.clipFingerWeight ?? 0.55);
    }
    const vGaitW = T.MathUtils.clamp(
      this.activeVerticalGaitWeight ?? (dynamics?.verticalGait ? 1 : 0),
      0,
      1,
    );
    const hasGroundFn = !!(this.activeSurfaceAt || dynamics?.groundAt);
    const legTargetWeight = f.legTargets ? T.MathUtils.clamp(f.legTargets.weight ?? 1, 0, 1) : 0;
    const skipForLegTargets = legTargetWeight > 0.999 || (!!f.seated && legTargetWeight > 1e-4);
    if (!skipForLegTargets && (bending || dynamics || crouch > 0)) for (const leg of this.legs) {
      // The torso/load solve changes the tibia's final angle. Reconcile the
      // ankle against that reached pelvis while retaining its ground contact.
      leg.foot.getWorldScale(_footScale);
      const gRef = this.gaitFeet.get(leg.side);
      if (dynamics?.gait && vGaitW < 0.999 && hasGroundFn) {
        if (gRef) {
          const gY = this.querySupportY(dynamics, leg.goal, leg.rawNormal);
          this.limitAnkle(leg, _footScale, gY, gRef, dynamics.stepping);
          if (leg.hasTerrainNormal && gY !== null) {
            const slopeOff = this.soleTerrainOffsetY(leg, leg.goalQ, _footScale);
            leg.goal.y = Math.max(leg.goal.y, gY - slopeOff);
          }
        }
        leg.carry.copy(leg.goalQ).multiply(q1.copy(leg.carryFrom).invert()).normalize();
        leg.carry.slerp(q2.identity(), 1 - Math.exp(-CARRY_RELAX * dt));
      } else if (this.activeVerticalGaitWeight !== undefined) {
        // Continuous relaxation instead of 1-frame snap when verticalGaitWeight reaches 1
        leg.carry.slerp(q2.identity(), 1 - Math.exp(-CARRY_RELAX * 2 * dt));
        if (leg.hasTerrainNormal && dynamics) {
          const gY = this.querySupportY(dynamics, leg.goal, leg.rawNormal);
          if (gY !== null) {
            const slopeOff = this.soleTerrainOffsetY(leg, leg.goalQ, _footScale);
            leg.goal.y = Math.max(leg.goal.y, gY - slopeOff);
          }
        }
      } else {
        leg.carry.identity();
      }
      let skipHighSwingIk = false;
      if (
        !bending &&
        crouch <= 1e-4 &&
        !!dynamics?.stepping &&
        !gRef?.on &&
        !gRef?.recovering &&
        leg.goal.distanceToSquared(leg.at) < 1e-8 &&
        leg.goalQ.angleTo(leg.q) < 1e-3
      ) {
        leg.foot.getWorldPosition(_reachedAt);
        leg.foot.getWorldQuaternion(_reachedQ);
        const rawFlex = computeSolvedKneeFlexionRad(leg.thigh, leg.shin, leg.foot);
        // Check pure FK tibia-to-foot roll before bypassing so raw swing clips with >9.7 deg roll still get reconciled
        _laCross.crossVectors(leg.footUp, leg.footForward).applyQuaternion(_reachedQ);
        _laTibia.copy(leg.shin.getWorldPosition(_laKnee)).sub(_reachedAt).normalize();
        const rawRollAbs = Math.abs(_laTibia.dot(_laCross));
        if (
          _reachedAt.distanceToSquared(leg.goal) < 1e-8 &&
          rawFlex >= MIN_KNEE_FLEX_RAD &&
          rawFlex <= MAX_KNEE_FLEX_RAD &&
          rawRollAbs <= 0.17
        ) {
          const curSoleY = _reachedAt.y + leg.sole.offsetY(_reachedQ, _footScale);
          const gCheck = this.querySupportY(dynamics, _reachedAt, leg.rawNormal);
          if (gCheck === null || curSoleY > gCheck + 0.04 * this.scale) {
            skipHighSwingIk = true;
          }
        }
      }
      if (!skipHighSwingIk) {
        this.plantFoot(leg);
      }
      leg.foot.getWorldPosition(_reachedAt);
      leg.foot.getWorldQuaternion(_reachedQ);
      gRef?.reached(_reachedAt, _reachedQ, _reachedAt.y + leg.sole.offsetY(_reachedQ, _footScale));
      if (dynamics?.gait && dynamics.stepping) {
        const foot = this.feet.feet.find(f => f.side === leg.side);
        // The planted rotation is kept without the carry: next frame applies the carry to it once, not twice.
        if (foot) { foot.at.copy(_reachedAt); foot.q.copy(_reachedQ).premultiply(q1.copy(leg.carry).invert()); }
      }
    } else if (freeFeet && !skipForLegTargets && !f.seated && !f.reduced && this.legs.length === 2 && (this.activeSurfaceAt || f.dynamics?.groundAt)) {
      // Studio / expressive pose mode: keep lifted/expressive feet 100% free, only clamping soles that dip below floor
      for (const leg of this.legs) {
        leg.foot.getWorldScale(_footScale);
        const soleOff = leg.sole.offsetY(leg.q, _footScale);
        const gY = f.dynamics
          ? this.querySupportY(f.dynamics, leg.at, leg.rawNormal)
          : this.activeSurfaceAt
            ? this.activeSurfaceAt(leg.at, leg.rawNormal)
            : null;
        if (gY !== null && Number.isFinite(gY) && leg.at.y + soleOff < gY - 1e-4) {
          leg.goal.copy(leg.at);
          leg.goal.y = gY - soleOff;
          leg.goalQ.copy(leg.q);
          leg.carry.identity();
          this.plantFoot(leg);
        }
      }
    }
    // Optional closed-loop ankle IK override (bicycle crank pedals, scooter deck, or seated floor contacts)
    if (f.legTargets) {
      const ltW = T.MathUtils.clamp(f.legTargets.weight ?? 1, 0, 1);
      if (ltW > 1e-4) {
        const charYaw = Math.atan2(this.forward.x, this.forward.z) + this.activeMoveYaw;
        this.model.getWorldQuaternion(_modelQ);
        _invModelQ.copy(_modelQ).invert();
        for (const leg of this.legs) {
          const isLeft = leg.side < 0;
          const targetAnkle = isLeft ? f.legTargets.left : f.legTargets.right;
          const rawNorm = isLeft ? f.legTargets.leftNormal : f.legTargets.rightNormal;
          const explicitPole = isLeft ? f.legTargets.leftPole : f.legTargets.rightPole;
          const explicitFootQuat = isLeft ? f.legTargets.leftFootQuat : f.legTargets.rightFootQuat;
          let footWorldQuat: T.Quaternion;
          let toeCounterPitchRad = 0;
          if (explicitFootQuat) {
            footWorldQuat = explicitFootQuat;
            toeCounterPitchRad = 0;
          } else if (f.legTargets.skipSlopeRoll) {
            footWorldQuat = leg.q;
            toeCounterPitchRad = 0;
          } else {
            filterFootSurfaceNormal(leg.filteredNormal, rawNorm ?? UP, 1, dt);
            solveFootSlopeAndRollRotation(
              {
                animatedFootWorldQuat: leg.q,
                footForwardLocal: leg.footForward,
                footUpLocal: leg.footUp,
                characterYaw: charYaw,
                filteredGroundNormalWorld: leg.filteredNormal,
                stanceWeight: 1,
                stanceProgress: 0.45,
              },
              _slopeOut,
            );
            footWorldQuat = _slopeOut.footWorldQuat;
            toeCounterPitchRad = _slopeOut.toeCounterPitchRad;
          }
          this.safeShoeForwardWorld(leg.footForward, footWorldQuat, _shoeFwdW);
          _shoeFwdC.copy(_shoeFwdW).applyQuaternion(_invModelQ).normalize();
          solveAnalyticLegIk(
            this.model,
            leg.thigh,
            leg.shin,
            leg.foot,
            targetAnkle,
            {
              charSideX: isLeft ? 1 : -1,
              shoeForwardChar: _shoeFwdC,
              pelvisYawOffsetRad: this.activeMoveYaw,
              explicitPoleWorld: explicitPole ?? null,
              clampCoronalSplay: !explicitPole,
              footWorldRotation: footWorldQuat,
              toeBone: leg.toe,
              toeRestQuat: leg.toeRest,
              toeCounterPitchRad,
              weight: ltW,
            },
          );
        }
      }
    }
    this.root.updateWorldMatrix(true, false);
    _solvedRootInvM.copy(this.root.matrixWorld).invert();
    for (const arm of this.arms) {
      let shSlot = this.solvedShoulders.get(arm.side);
      if (!shSlot) {
        shSlot = new T.Vector3();
        this.solvedShoulders.set(arm.side, shSlot);
      }
      arm.upper.getWorldPosition(shSlot).applyMatrix4(_solvedRootInvM);
    }
    this.poseState = rest && this.restMix > .2
      ? 'rest'
      : this.arms.some(a => a.contact && (a.contact.handleJoints || a.contact.grip === 'handle'))
        ? 'use_tool'
        : this.arms.some(a => a.contact?.on)
          ? 'hold'
          : this.arms.some(a => !!a.contact)
            ? 'interact'
            : this.arms.some(a => a.contactT > .02)
              ? 'release'
              : env > .05 && g !== 'idle'
                ? 'gesture'
                : this.readyMix > .15 || this.readySpeed > 1.95
                  ? 'run'
                  : this.readySpeed > .12 || f.dynamics?.stepping
                    ? 'walk'
                    : 'idle';
  }

  private zero = { hipX: 0, hipZ: 0, sink: 0, pitch: 0, roll: 0 };
  /** The weight layer's last output, and the blend from it when walking starts or stops (`weightOver`). */
  private lastWeight = { hipX: 0, hipZ: 0, sink: 0, pitch: 0, roll: 0 };
  private weightFrom: { hipX: number; hipZ: number; sink: number; pitch: number; roll: number } | null = null;
  private weightBlend = 1;
  private gaitRise = 0;
  /** This frame's FPS crouch (0..1): the ankle envelope of a crouch walk. */
  private crouchNow = 0;
  private weightStepping: boolean | null = null;
  private noWeight() {
    this.strideLane = 0;
    this.strideHinge = 0;
    this.weightStepping = null; this.weightFrom = null; this.lastWeight = { ...this.zero };
    this.motionFeet.clear();
    for (const leg of this.legs) {
      leg.carry.identity();
      leg.filteredNormal.set(0, 1, 0);
      leg.toeCounterPitch = 0;
      resetNpcFootLockState(leg.lockState);
    }
    for (const foot of this.gaitFeet.values()) foot.reset();
    if (this.feet.plant > 0 || this.unstable) { this.feet.reset(); this.balance.reset(); this.unstable = 0; this.drift.set(0, 0, 0); this.eyeShift.set(0, 0, 0); this.rootSeen = false; this.midSeen = false; this.axesSeen = false; }
    return this.zero;
  }
  /** Reset all world-space planted foot & balance anchors after a teleport, vehicle dismount, or large jump. */
  resetFootDynamics() {
    this.strideLane = 0;
    this.strideHinge = 0;
    this.weightStepping = null; this.weightFrom = null; this.lastWeight = { ...this.zero };
    this.motionFeet.clear();
    for (const leg of this.legs) {
      leg.carry.identity();
      leg.filteredNormal.set(0, 1, 0);
      leg.toeCounterPitch = 0;
      resetNpcFootLockState(leg.lockState);
    }
    for (const foot of this.gaitFeet.values()) foot.reset();
    this.feet.reset();
    this.balance.reset();
    this.pelvisSpring.reset();
    this.gaitRise = 0;
    this.unstable = 0;
    this.drift.set(0, 0, 0);
    this.eyeShift.set(0, 0, 0);
    this.velocity.set(0, 0);
    this.accel.set(0, 0);
    this.rootSeen = false;
    this.midSeen = false;
    this.axesSeen = false;
    this.smoothedMoveYaw = 0;
    this.smoothedLookYaw = 0;
    this.lookYawSeeded = false;
  }
  private querySupportY(d: BodyDynamics, probe: T.Vector3, outNormal: T.Vector3): number | null {
    outNormal.set(0, 1, 0);
    if (this.activeSurfaceAt) {
      const y = this.activeSurfaceAt(probe, outNormal);
      return y !== null && Number.isFinite(y) ? y : null;
    }
    if (d.groundAt) {
      const y = d.groundAt(probe);
      return y !== null && Number.isFinite(y) ? y : null;
    }
    return null;
  }
  /** A knock from something: a change of velocity, m/s, world. */
  bump(x: number, z: number) { this.balance.impulse(x * this.right.x + z * this.right.z, x * this.forward.x + z * this.forward.z); }
  /** Where the feet are now, and where the weight is: QA and the world's own use. */
  get dynamicsState() { return { plant: this.feet.plant, steps: this.feet.steps, x: this.balance.x, z: this.balance.z, unstable: this.unstable, over: this.balance.out.over, feet: this.feet.feet.map(f => ({ side: f.side, at: f.at.toArray(), air: !!f.swing })), bend: { ...this.bend } }; }
  /**
   * The feet first, then what they have to hold. Everything here is in the body's own frame, from the middle of the feet.
   * What comes out is where the hips go and how the trunk leans; a step is asked for when the capture point has left the soles.
   */
  private weightOver(d: BodyDynamics, dt: number) {
    const at = this.root.getWorldPosition(new T.Vector3()), k = this.scale;
    // The weight is kept in the body's own axes. When the body turns on the spot the weight has not gone round with it: the same place in the
    // room, read in the new axes. Without this every turn swung the weight round the feet, and the feet stepped to catch a fall nobody had
    // (a learner turning to water a plant shuffled half a metre away from it).
    if (this.axesSeen) {
      const b = this.balance, wx = this.lastRight.x * b.x + this.lastForward.x * b.z, wz = this.lastRight.z * b.x + this.lastForward.z * b.z;
      const ux = this.lastRight.x * b.vx + this.lastForward.x * b.vz, uz = this.lastRight.z * b.vx + this.lastForward.z * b.vz;
      b.x = wx * this.right.x + wz * this.right.z; b.z = wx * this.forward.x + wz * this.forward.z;
      b.vx = ux * this.right.x + uz * this.right.z; b.vz = ux * this.forward.x + uz * this.forward.z;
    }
    // How fast the body is turning, rad/s: a walking body turning faster than a planted foot can hold pivots on its feet.
    this.turnRate = this.axesSeen ? Math.atan2(this.lastForward.x * this.forward.z - this.lastForward.z * this.forward.x, this.lastForward.x * this.forward.x + this.lastForward.z * this.forward.z) / Math.max(dt, 1 / 240) : 0;
    this.axesSeen = true; this.lastRight.copy(this.right); this.lastForward.copy(this.forward);
    // How the root itself is going, for the weight that lags behind it.
    if (!this.rootSeen) { this.rootSeen = true; this.lastRoot.copy(at); this.velocity.set(0, 0); this.accel.set(0, 0); }
    const moved = Math.hypot(at.x - this.lastRoot.x, at.z - this.lastRoot.z);
    if (moved > .6 * k) {
      // Teleport / dismount / large jump: discard stale world-space footprints so legs never stretch across the map.
      this.resetFootDynamics();
      this.rootSeen = true;
      this.axesSeen = true;
      this.lastRoot.copy(at);
      this.lastRight.copy(this.right);
      this.lastForward.copy(this.forward);
    }
    const stepDt = Math.max(dt, 1 / 240);
    const vx = moved > .6 * k ? 0 : (at.x - this.lastRoot.x) / stepDt, vz = moved > .6 * k ? 0 : (at.z - this.lastRoot.z) / stepDt;
    this.lastRoot.copy(at);
    const was = this.velocity.clone(), f1 = 1 - Math.exp(-16 * dt);
    this.velocity.x += (vx - this.velocity.x) * f1; this.velocity.y += (vz - this.velocity.y) * f1;
    const f2 = 1 - Math.exp(-14 * dt);
    this.accel.x += (T.MathUtils.clamp((this.velocity.x - was.x) / stepDt, -5, 5) - this.accel.x) * f2;
    this.accel.y += (T.MathUtils.clamp((this.velocity.y - was.y) / stepDt, -5, 5) - this.accel.y) * f2;
    // The feet.
    let catchAt: T.Vector3 | null = null;
    const out0 = this.balance.out;
    if (!d.stepping && this.feet.plant > .9 && !this.feet.swinging && out0.over > .012) {
      // The soles cannot hold it: a step, to about where the weight is heading, no longer than a leg gives.
      const n = Math.hypot(out0.captureX, out0.captureZ) || 1, len = Math.min(.42 * k, n * 1.12);
      const to = at.clone().add(v2.set(this.lastMid.x - at.x, 0, this.lastMid.y - at.z)).addScaledVector(this.right, out0.captureX / n * len).addScaledVector(this.forward, out0.captureZ / n * len);
      if (!d.roomAt || d.roomAt(to.x, to.z)) catchAt = to;
    }
    // A step the body chose (to turn, to stand wider, to settle after a walk) carries the weight with it; only a step that catches a fall is stepped under a weight left behind.
    let planned = false;
    this.feet.update({
      dt, stepping: d.stepping, rootAt: at, rootQ: this.rootQ, forward: this.forward, right: this.right, stance: d.stance ?? null,
      clip: this.legs.map(l => ({ at: l.at, q: l.q })), k, catchAt,
      land: (side, hard) => {
        d.land?.(side, hard);
        if (hard <= .8) planned = true;
        // A step that caught the body takes the body with it: half way between where the feet now are.
        if (hard > .8) { const foot = this.feet.feet.find(f => f.side === side); if (foot) { const other = this.feet.feet.find(f => f.side !== side)!; this.drift.x += (foot.at.x + other.at.x) / 2 - at.x; this.drift.z += (foot.at.z + other.at.z) / 2 - at.z; } }
      },
    });
    const plant = this.feet.plant, smooth = plant * plant * (3 - 2 * plant);
    const speed = this.velocity.length();
    const straight = speed > .1 ? Math.abs(this.velocity.x * this.forward.x + this.velocity.y * this.forward.z) / speed : 0;
    const trackingLane = d.gait && d.stepping ? T.MathUtils.smoothstep(straight, .72, .95) : 0;
    this.strideLane += (trackingLane - this.strideLane) * (1 - Math.exp(-12 * dt));
    this.strideHinge += ((d.gait && d.stepping ? 1 : 0) - this.strideHinge) * (1 - Math.exp(-24 * dt));
    if (this.strideHinge > .001) {
      this.legs[0].thigh.getWorldPosition(this.hipAxis).sub(this.legs[1].thigh.getWorldPosition(v1)).setY(0).normalize();
      if (this.hipAxis.dot(this.pelvisRight) < 0) this.hipAxis.negate();
    }
    for (let i = 0; i < this.legs.length; i++) {
      const leg = this.legs[i], foot = this.feet.feet[i];
      leg.goal.copy(leg.at).lerp(foot.at, smooth);
      if (this.strideLane > .001 && d.gait) {
        // Retarget the swing to this hip's line of travel. Keep the clip's
        // forward stride and lift; plant the resulting shoe on the real sole.
        const hip = leg.thigh.getWorldPosition(v1);
        const side = v2.copy(leg.goal).sub(hip).dot(this.right);
        const spread = .024 * k, lane = spread * Math.tanh(side / (.08 * k));
        leg.goal.addScaledVector(this.right, (lane - side) * this.strideLane * (1 - smooth));
      }
      leg.goalQ.copy(leg.q).slerp(foot.q, smooth);
      // The shoe starts from where the ankle envelope finally had it last frame. The envelope's last pass sees the
      // trunk's crouch; starting every frame from the clip's rotation instead rolled a stance shoe tens of degrees
      // about its toe and back each frame, and that 0.2 m lever walked the ankle away from its footprint.
      leg.carryFrom.copy(leg.goalQ);
      // The previous correction belongs to the supported ankle. During a
      // stride the new captured tibia/shoe pair defines its own frame.
      if (!(d.gait && d.stepping)) leg.goalQ.premultiply(leg.carry);
      leg.foot.getWorldScale(_footScale);
      leg.goal.y += leg.sole.offsetY(leg.q, _footScale) - leg.sole.offsetY(leg.goalQ, _footScale);
      let lock = this.motionFeet.get(leg.side);
      if (!lock) { lock = { on: false, weight: 0, at: leg.at.clone(), q: leg.q.clone() }; this.motionFeet.set(leg.side, lock); }
      const rawContactVal = d.motionContacts?.[leg.side < 0 ? 0 : 1] ?? 0;
      const contact = rawContactVal > 0.45;
      if (contact && !lock.on) { lock.at.copy(leg.at); lock.q.copy(leg.q); }
      lock.on = contact;
      lock.weight = T.MathUtils.clamp(lock.weight + (contact ? dt / .1 : -dt / .1), 0, 1);
      const contactWeight = minJerk(lock.weight) * (d.motionWeight ?? 0);
      const bottom = T.MathUtils.lerp(leg.goal.y + leg.sole.offsetY(leg.goalQ, _footScale), lock.at.y + leg.sole.offsetY(lock.q, _footScale), contactWeight);
      leg.goal.lerp(lock.at, contactWeight); leg.goalQ.slerp(lock.q, contactWeight);
      // A contact locks the captured sole, not the old ankle height combined
      // with the current clip's shoe pitch. This is geometry, not force proof.
      leg.goal.y = bottom - leg.sole.offsetY(leg.goalQ, _footScale);
      // Blending two legal skeletal poses can put a shoe below their common
      // floor. Ground its measured sole through leg IK, without moving the root.
      if (d.motionFloorY !== undefined) leg.goal.y = Math.max(leg.goal.y, d.motionFloorY - leg.sole.offsetY(leg.goalQ, _footScale));

      const hasGroundFn = !!(this.activeSurfaceAt || d.groundAt);
      const ground = this.querySupportY(d, leg.goal, leg.rawNormal);
      leg.hasTerrainNormal = !!this.activeSurfaceAt && ground !== null;
      const soleOff0 = leg.sole.offsetY(leg.goalQ, _footScale);

      // Continuous swing-safe stance foot locking when continuous `motionContacts` are supplied on non-FootGround gaits
      if (!d.gait && d.stepping && ground !== null && d.motionContacts) {
        sampleStanceFootTarget(
          leg.lockState,
          {
            animX: leg.goal.x,
            animY: leg.goal.y,
            animZ: leg.goal.z,
            groundY: ground,
            rootY: at.y,
            footRestY: -soleOff0,
            stanceWeight: rawContactVal,
            yawRate: this.turnRate,
            dt,
            scale: k,
          },
          _stanceSampleOut,
        );
        leg.goal.set(_stanceSampleOut.targetX, _stanceSampleOut.targetY, _stanceSampleOut.targetZ);
      } else {
        resetNpcFootLockState(leg.lockState);
        if (ground !== null) {
          const isPlantedSwing = !!foot?.swing;
          const dropBelowRoot = at.y - ground;
          if (!isPlantedSwing && dropBelowRoot > 1e-4 && dropBelowRoot < 0.42 * k) {
            const clipSoleOff = leg.sole.offsetY(leg.q, _footScale);
            const clipClearance = leg.at.y + clipSoleOff - at.y;
            const rangeMask = 1 - T.MathUtils.smoothstep(dropBelowRoot, 0.32 * k, 0.42 * k);
            const descendWeight = 1 - T.MathUtils.smoothstep(clipClearance, 0.004 * k, 0.065 * k);
            const clampedDrop = Math.min(dropBelowRoot, 0.34 * k);
            leg.goal.y -= clampedDrop * rangeMask * descendWeight;
          }
          leg.goal.y = Math.max(leg.goal.y, ground - soleOff0);
        }
      }

      let gait = this.gaitFeet.get(leg.side);
      if (!gait) { gait = new FootGround(); this.gaitFeet.set(leg.side, gait); }
      const vGaitW = T.MathUtils.clamp(
        this.activeVerticalGaitWeight ?? (d.verticalGait ? 1 : 0),
        0,
        1,
      );
      const lockWeight = 1 - vGaitW;
      if (d.gait && hasGroundFn && (lockWeight > 0.001 || this.activeVerticalGaitWeight !== undefined)) {
        gait.solve(
          leg.goal,
          leg.goalQ,
          _footScale,
          leg.sole.supportPoint(leg.goalQ, _footScale, _solePt),
          ground,
          dt,
          k,
          leg.goal,
          d.stepping && !!this.gaitFeet.get(-leg.side)?.on,
          _travelVec.set(this.velocity.x, 0, this.velocity.y),
          d.stepping && Math.abs(this.turnRate) > PIVOT_TURN,
          lockWeight,
        );
        const solvedGround = leg.hasTerrainNormal ? this.querySupportY(d, leg.goal, leg.rawNormal) : ground;
        const groundContactW =
          d.stepping && leg.hasTerrainNormal && solvedGround !== null
            ? 1 -
              T.MathUtils.smoothstep(
                leg.goal.y + this.soleTerrainOffsetY(leg, leg.goalQ, _footScale) - solvedGround,
                0.008 * k,
                0.045 * k,
              )
            : 0;
        const slopeStanceW = !d.stepping ? 1 : leg.hasTerrainNormal ? Math.max(gait.on ? 1 : 0, groundContactW) : gait.on ? lockWeight : 0;
        filterFootSurfaceNormal(leg.filteredNormal, leg.hasTerrainNormal ? leg.rawNormal : UP, slopeStanceW, dt);
        if (leg.hasTerrainNormal && (slopeStanceW > 1e-3 || 1 - leg.filteredNormal.y > 1e-4)) {
          const charYaw = Math.atan2(this.forward.x, this.forward.z) + (d.stepping ? this.activeMoveYaw : 0);
          const beforeLow = this.soleTerrainOffsetY(leg, leg.goalQ, _footScale);
          solveFootSlopeAndRollRotation(
            {
              animatedFootWorldQuat: leg.goalQ,
              footForwardLocal: leg.footForward,
              footUpLocal: leg.footUp,
              characterYaw: charYaw,
              filteredGroundNormalWorld: leg.filteredNormal,
              stanceWeight: slopeStanceW,
              stanceProgress: gait.on ? gait.stanceProgress : 0.45,
            },
            _slopeOut,
          );
          leg.goalQ.copy(_slopeOut.footWorldQuat);
          leg.toeCounterPitch = _slopeOut.toeCounterPitchRad;
          const afterLow = this.soleTerrainOffsetY(leg, leg.goalQ, _footScale);
          leg.goal.y += beforeLow - afterLow;
          if (solvedGround !== null) {
            if (slopeStanceW > 0.65 && vGaitW > 0.05) {
              leg.goal.y = T.MathUtils.lerp(leg.goal.y, solvedGround - afterLow, vGaitW * slopeStanceW);
            }
            leg.goal.y = Math.max(leg.goal.y, solvedGround - afterLow);
          }
        } else {
          leg.toeCounterPitch = 0;
        }
        if (lockWeight > 0.001) {
          this.limitAnkle(leg, _footScale, solvedGround, gait, d.stepping);
          if (leg.hasTerrainNormal && solvedGround !== null) {
            leg.goal.y = Math.max(leg.goal.y, solvedGround - this.soleTerrainOffsetY(leg, leg.goalQ, _footScale));
          }
        }
      } else {
        gait.reset();
        leg.filteredNormal.set(0, 1, 0);
        leg.toeCounterPitch = 0;
      }
    }
    // What the feet hold. The weight is measured from the middle of the feet: when they move, it has not.
    const { cx, cz, support } = this.feet.support(at, this.forward, this.right, k);
    const midX = at.x + this.right.x * cx + this.forward.x * cz, midZ = at.z + this.right.z * cx + this.forward.z * cz;
    if (this.feet.swinging?.swing && !this.feet.swinging.swing.recover) planned = true;
    // The last stride of a walk is put down under the weight, as a walker's is: what is left over is only what the soles can hold.
    if (this.wasStepping && !d.stepping) {
      const b = this.balance;
      b.x = T.MathUtils.clamp(b.x, -support.left * .5, support.right * .5); b.z = T.MathUtils.clamp(b.z, -support.back * .5, support.front * .5);
      b.vx *= .5; b.vz *= .5;
    }
    this.wasStepping = d.stepping;
    if (this.midSeen && !d.stepping && !planned) {
      const dx = midX - this.lastMid.x, dz = midZ - this.lastMid.y;
      if (Math.hypot(dx, dz) < .3) { this.balance.x -= dx * this.right.x + dz * this.right.z; this.balance.z -= dx * this.forward.x + dz * this.forward.z; }
    }
    this.midSeen = !d.stepping; this.lastMid.set(midX, midZ);
    const loads: Load[] = d.loads.map(l => ({ x: (l.at.x - at.x) * this.right.x + (l.at.z - at.z) * this.right.z - cx, z: (l.at.x - at.x) * this.forward.x + (l.at.z - at.z) * this.forward.z - cz, kg: l.kg }));
    const force = d.handForce ? { x: -(d.handForce.x * this.right.x + d.handForce.z * this.right.z), z: -(d.handForce.x * this.forward.x + d.handForce.z * this.forward.z), height: d.handForce.height } : null;
    const ax = this.accel.x * this.right.x + this.accel.y * this.right.z, az = this.accel.x * this.forward.x + this.accel.y * this.forward.z;
    const out = this.balance.update({ dt, mass: d.mass, loads, force, ax, az, stepping: d.stepping, support, cx: d.stepping ? 0 : cx, cz: d.stepping ? 0 : cz });
    // A step in the air: the hips are over the foot still on the floor.
    const inAir = this.feet.swinging;
    const shift = inAir ? -inAir.side * Math.sin(Math.PI * Math.min(1, inAir.phase * 1.1)) * .032 * k : 0;
    this.unstable += (out.unstable - this.unstable) * (1 - Math.exp(-(out.unstable > this.unstable ? 18 : 4) * dt));
    this.strainNow += ((d.strain ?? 0) - this.strainNow) * (1 - Math.exp(-5 * dt));
    this.clock += dt;
    // The root follows what the feet did. The weight, relative to the feet, is where it was.
    if (this.drift.lengthSq() > 1e-6) {
      const take = this.drift.clone().multiplyScalar(1 - Math.exp(-7 * dt));
      this.taken.add(take);
      this.drift.sub(take);
    }
    this.eyeShift.copy(this.forward).multiplyScalar(this.balance.z * .55).addScaledVector(this.right, this.balance.x * .55);
    this.eyeShift.y = -out.sink;
    const target = { hipX: out.hipX + shift, hipZ: out.hipZ, sink: out.sink + this.strainNow * .012, pitch: out.pitch, roll: out.roll };
    // Walking hands the hips to the clip; standing puts them over the feet. Switching between the two moved the drawn hips
    // 45–68 mm in one frame at every stop and start: the change is blended from where the hips were, over `WEIGHT_BLEND_S`.
    if (this.weightStepping !== null && this.weightStepping !== d.stepping) { this.weightFrom = { ...this.lastWeight }; this.weightBlend = 0; }
    this.weightStepping = d.stepping;
    let result = target;
    if (this.weightFrom && this.weightBlend < 1) {
      this.weightBlend = Math.min(1, this.weightBlend + dt / WEIGHT_BLEND_S);
      const e = minJerk(this.weightBlend), from = this.weightFrom;
      result = { hipX: T.MathUtils.lerp(from.hipX, target.hipX, e), hipZ: T.MathUtils.lerp(from.hipZ, target.hipZ, e), sink: T.MathUtils.lerp(from.sink, target.sink, e), pitch: T.MathUtils.lerp(from.pitch, target.pitch, e), roll: T.MathUtils.lerp(from.roll, target.roll, e) };
    } else this.weightFrom = null;
    this.lastWeight = result;
    return result;
  }
  /** What the feet moved the body by this frame: the owner of the root takes it and clears it. */
  readonly taken = new T.Vector3();
  /** Strength at its top: not a shake, the fine fast tremor of muscles near what they can do. */
  private tremble(chest: T.Bone | undefined) {
    if (!chest) return;
    const t = this.clock, a = this.strainNow * this.strainNow * .004;
    this.rotateWorld(chest, this.right, a * (Math.sin(t * 37) + Math.sin(t * 23.7)));
    this.rotateWorld(chest, this.forward, a * .7 * Math.sin(t * 29.3));
  }

  /**
   * How little the body has to do so that arms of their real length get there: both of them at once. Turning the shoulders brings one forward,
   * leaning brings both, the knees bring them down. The cheapest way that does the job: for a heavy thing that is the knees and a straight back,
   * for a light one a bend of the back. Coordinate descent from last frame's answer: a few steps a frame, and it never jumps.
   */
  private planTrunk(seated: boolean, finalize?: (pose: typeof this.bend) => number) {
    const rootIntent = this.intendedRoot; this.intendedRoot = null;
    const plan = this.plan;
    const hips = this.hips;
    let on = 0;
    for (const arm of this.arms) if (arm.contact) on++;
    if (!hips || !on) { plan.drop = plan.pitch = plan.yaw = plan.roll = 0; Object.assign(this.trunkRaw, plan); return plan; }
    const k = this.scale;
    // Evaluate the same articulated transforms that will be drawn. A single
    // pivot halfway up the spine predicted reach that this skeleton never had.
    const trunk = [hips, this.bones.get('spine'), this.bones.get('chest'), ...this.arms.map(a => a.clavicle)].filter((b): b is T.Bone => !!b);
    const saved = trunk.map(b => ({ b, p: b.position.clone(), q: b.quaternion.clone() }));
    const restore = () => { for (const s of saved) { s.b.position.copy(s.p); s.b.quaternion.copy(s.q); } hips.updateWorldMatrix(true, false); };
    // When reaching for an object, the soles define the available squat.
    // Treating ankle height as the floor strands a low grasp above the rim.
    const surfaceReach = this.arms.some(a => a.contact && ((a.contact.on && !a.contact.secured) || (a.contact.bodyGoal && a.contact.bend)));
    const floor = this.trunkFloor(surfaceReach);
    // A reach squats no lower than hips 0.38 m over the soles (knees near 130 degrees, heels down). Lower than that a
    // person kneels or sits instead; at 0.18 m the body folded onto its heels, knees past 160 degrees, and tipped over.
    const hipClearance = Math.max(0, hips.getWorldPosition(new T.Vector3()).y - floor - REACH_HIP_FLOOR * k);
    let maxDrop = seated ? 0 : Math.min(.75 * k, hipClearance), maxPitch = seated ? .8 : TRUNK_PITCH_CAP, maxYaw = seated ? .5 : .75, kg = 0, w = 0;
    const rows: { arm: Arm; goal: T.Vector3; fingers?: T.Vector3; reach: number; weight: number }[] = [];
    for (const arm of this.arms) {
      const c = arm.contact;
      if (!c) continue;
      // Past the reach of the arm it costs a lot; a reach for something wants a little bend left in it (90 %). A grip
      // already secured is held to just inside what the held object's fit allows (`fitGraspTranslation`, arm − 2.5 cm):
      // two different rules ratcheted the body down a little every frame until a carried book was held in a squat.
      const free = (arm.lenUpper + arm.lenFore) * .90, secured = arm.lenUpper + arm.lenFore - .03 * k;
      // A forearm roll changes the palm at the existing grasp. Keep planning
      // the trunk against the pre-roll reach axis. The live wrist is still
      // validated below, after physics, against the moving object.
      const reachAxis = c.wristPivot ? c.bodyFingers ?? c.fingers : c.fingers;
      // A supporting hand coming onto a thing the other hand already holds fast (the lower hand on a broom) follows the
      // body; it never bends it. It found a grip where it could, or gives up. Weighted like the holding hand, its
      // reach for the lower handle folded the trunk to 75 degrees over straight legs for every stroke.
      const other = this.arms.find(o => o !== arm)?.contact;
      const support = !!c.support || (!c.secured && !!other?.secured && !!c.on && c.on === other.on);
      const share = support ? .01 : 1;
      rows.push({ arm, goal: c.wrist, fingers: c.on ? reachAxis : undefined, reach: c.secured ? secured : free, weight: minJerk(arm.contactT) * share });
      if (c.bodyGoal) rows.push({ arm, goal: c.bodyGoal, fingers: c.bodyFingers ?? c.fingers, reach: free, weight: .2 * minJerk(arm.contactT) * share });
      if (rootIntent && c.on) rows.push({ arm, goal: c.wrist.clone().applyMatrix4(rootIntent), fingers: c.fingers.clone().transformDirection(rootIntent), reach: c.secured ? secured : free, weight: .2 * minJerk(arm.contactT) * share });
      if (support) continue;
      if (c.bend) { maxPitch = Math.min(maxPitch, c.bend.pitch); maxDrop = Math.min(maxDrop, (seated ? 0 : c.bend.drop) * k); if (c.bend.yaw !== undefined) maxYaw = Math.min(maxYaw, c.bend.yaw); }
      kg = Math.max(kg, c.kg ?? 0);
      w = Math.max(w, minJerk(arm.contactT));
    }
    const cPitch = .12 * (1 + kg / 3.5), cDrop = .9 / (1 + kg / 2.5), cYaw = .07, cRoll = .3;
    const standing = hips.getWorldPosition(_ptHipW).y - floor, leg = this.legs.length ? (this.legs[0].lenThigh + this.legs[0].lenShin) : .83 * k;
    const pitchFor = (drop: number) => maxTrunkPitch(drop / k, standing / k, leg / k, maxPitch);
    this.hipRoom = { standing: standing / k, leg: leg / k };
    let absorbedDrop = 0;
    const cost = (drop: number, pitch: number, yaw: number, roll: number) => {
      restore(); this.applyReachTrunk({ drop, pitch, yaw, roll });
      absorbedDrop = finalize?.({ drop, pitch, yaw, roll }) ?? 0;
      for (const a of this.arms) if (a.contact?.on && a.contactT >= .97) this.leadClavicle(a, a.contact.wrist, minJerk(a.contactT));
      let c = cPitch * pitch * pitch + cDrop * (drop / k) * (drop / k) + cYaw * yaw * yaw + cRoll * roll * roll;
      for (const r of rows) {
        r.arm.upper.getWorldPosition(_ptRel);
        const dist = _ptRel.distanceTo(r.goal);
        _ptPole.copy(_ptRel).addScaledVector(this.right, r.arm.side * .34 * k).addScaledVector(UP, -.42 * k).addScaledVector(this.forward, -.12 * k);
        const lim = r.arm.contact ? contactWristLimit(r.arm.contact, .8) : .8;
        const reachable = r.fingers ? reachableWrist(_ptRel, r.goal, r.fingers, r.arm.lenUpper, r.arm.lenFore, lim, _ptPole, _ptReachOut) : r.goal;
        const miss = Math.max(Math.max(0, dist - r.reach), reachable.distanceTo(r.goal)) / k;
        c += r.weight * (miss * miss * (r.fingers ? 10000 : 600) + (dist / r.reach) * (dist / r.reach) * .004);
      }
      return c;
    };
    // Last frame's answer, without the weight it was given.
    const t = this.trunkRaw;
    let best = cost(t.drop, t.pitch, t.yaw, t.roll);
    // A floor reach has two coupled degrees of freedom. From an upright
    // shoulder, a hinge alone can initially move it away from the contact.
    if (!seated && surfaceReach && rows.some(r => r.goal.y < floor + .22 * k) && best > 1) {
      // Seed from a few real ways down (more knee or more back), not only the deepest squat: coordinate descent
      // in small steps never climbs back out of a full squat it was started in.
      for (const share of [0, .2, .45, .7, 1]) for (const hinge of [.7, 1.15, 1.45, 1.8]) {
        const drop = maxDrop * share, pitch = Math.min(hinge, pitchFor(drop));
        const score = cost(drop, pitch, 0, 0);
        if (score < best) { Object.assign(t, { drop, pitch, yaw: 0, roll: 0 }); best = score; }
      }
    }
    // If planted legs already lowered the hips, a small voluntary drop just
    // replaces that correction. All the usual trials can then produce exactly
    // the same shoulder height. Test a knee bend beyond the measured slack.
    const down = this.arms.reduce((distance, arm) => {
      const c = arm.contact;
      return c?.bodyGoal ? Math.max(distance, c.wrist.y - c.bodyGoal.y) : distance;
    }, 0);
    if (down > .002 * k && absorbedDrop > .008 * k && t.drop < maxDrop) {
      const deeper = Math.min(maxDrop, t.drop + absorbedDrop + Math.min(down, .04 * k));
      const score = cost(deeper, t.pitch, t.yaw, t.roll);
      if (score < best) { t.drop = deeper; best = score; }
    }
    // Secured contacts need millimetre convergence: centimetre-only steps can
    // leave a reachable placement trapped outside both wrists' feasible band.
    // Free reaches keep their cheaper coarse solve.
    const steps = rows.some(r => r.fingers) ? [.05, .02, .008, .003, .001] : [.05, .02];
    for (const step of steps) {
      for (const key of ['pitch', 'drop', 'yaw', 'roll'] as const) {
        const span = key === 'drop' ? step * k : step;
        const hi = key === 'pitch' ? pitchFor(t.drop) : key === 'drop' ? maxDrop : key === 'yaw' ? maxYaw : .2;
        const lo = key === 'pitch' || key === 'drop' ? 0 : -hi;
        for (const dir of [1, -1]) {
          const was = t[key], next = T.MathUtils.clamp(was + dir * span, lo, hi);
          if (next === was) continue;
          // Going deeper may not leave the trunk folded past the hip's range.
          if (key === 'drop' && t.pitch > pitchFor(next) + 1e-6) continue;
          t[key] = next;
          const c = cost(t.drop, t.pitch, t.yaw, t.roll);
          if (c < best - 1e-6) { best = c; break; }
          t[key] = was;
        }
      }
    }
    // Anything left from a limit that shrank.
    t.drop = Math.min(t.drop, maxDrop); t.pitch = Math.min(t.pitch, pitchFor(t.drop)); t.yaw = T.MathUtils.clamp(t.yaw, -maxYaw, maxYaw);
    restore();
    plan.drop = t.drop * w; plan.pitch = t.pitch * w; plan.yaw = t.yaw * w; plan.roll = t.roll * w;
    return plan;
  }
  private trunkRaw = { drop: 0, pitch: 0, yaw: 0, roll: 0 };
  /** Hip height over the soles before a reach's drop, and leg length, metres at scale 1: what `applyReachTrunk` reads the hip's room from. */
  private hipRoom: { standing: number; leg: number } | null = null;

  /** Where the trunk measures its clearance from: each ankle as high as its shoe would hold it flat on the same ground.
   * A shoe the ankle envelope has pointed raises its ankle; that is the foot's answer to the crouch, not a higher floor. */
  private trunkFloor(useSupportSurface = false) {
    if (!this.legs.length) return 0;
    let lowest = Infinity;
    for (let i = 0; i < this.legs.length; i++) {
      const l = this.legs[i];
      l.foot.getWorldScale(_tfScale);
      const support = l.goal.y + l.sole.offsetY(l.goalQ, _tfScale);
      const val = useSupportSurface ? support : support - l.sole.offsetY(l.carryFrom, _tfScale);
      if (val < lowest) lowest = val;
    }
    return lowest;
  }

  /** Project the eased torso onto the current physical wrist constraints.
   * Usually idle; a stop, turn or collision can make the newly advanced prop
   * unreachable even though its spring target was reachable before the step. */
  private projectSecuredTrunk(seated: boolean, dt: number, reduced: boolean, apply: (pose: typeof this.bend) => void) {
    // A prospective support follows the trunk. Once its own grasp is secured,
    // verify both physical wrists after the step, including on a moving shaft.
    const held = this.arms.filter(a => a.contact?.on && a.contactT >= .999 && (!a.contact.support || a.contact.secured));
    if (!held.length || !this.hips) return false;
    const k = this.scale, start = { ...this.bend }, pose = { ...start };
    const error = () => {
      let squared = 0, worst = 0;
      for (const a of held) {
        const c = a.contact!;
        a.upper.getWorldPosition(_pstShoulder);
        _pstPole.copy(_pstShoulder).addScaledVector(this.right, a.side * .34 * k).addScaledVector(UP, -.42 * k).addScaledVector(this.forward, -.12 * k);
        reachableWrist(_pstShoulder, c.wrist, c.fingers, a.lenUpper, a.lenFore, contactWristLimit(c, .8), _pstPole, _pstReachOut);
        const miss = Math.max(0, _pstShoulder.distanceTo(c.wrist) - (a.lenUpper + a.lenFore - .004 * k), _pstReachOut.distanceTo(c.wrist));
        worst = Math.max(worst, miss); squared += (miss / k) ** 2;
      }
      return { squared, worst };
    };
    if (error().worst <= .0002 * k) return false;
    const floor = this.trunkFloor(held.some(a => a.contact?.bodyGoal && a.contact.bend));
    const hipsCurY = this.hips.getWorldPosition(_pstHipW).y;
    let drop = seated ? 0 : Math.min(.75 * k, start.drop + Math.max(0, hipsCurY - floor - REACH_HIP_FLOOR * k));
    let pitch = seated ? .8 : TRUNK_PITCH_CAP, yaw = seated ? .5 : .75;
    for (const a of held) if (a.contact?.bend) {
      drop = Math.min(drop, a.contact.bend.drop * k); pitch = Math.min(pitch, a.contact.bend.pitch);
      yaw = Math.min(yaw, a.contact.bend.yaw ?? yaw);
    }
    const limits = { drop, pitch, yaw, roll: .2 };
    const standing = (hipsCurY + start.drop - floor) / k, leg = (this.legs.length ? this.legs[0].lenThigh + this.legs[0].lenShin : .83 * k) / k;
    const evaluate = () => {
      apply(pose);
      const residual = error();
      const change =
        ((pose.drop - start.drop) / k) ** 2 +
        (pose.pitch - start.pitch) ** 2 +
        2.8 * (pose.yaw - start.yaw) ** 2 +
        3.4 * (pose.roll - start.roll) ** 2 +
        0.25 * ((pose.yaw - this.plan.yaw) ** 2 + (pose.roll - this.plan.roll) ** 2);
      return { cost: residual.squared * 1e6 + change, worst: residual.worst };
    };
    let best = evaluate();
    for (const step of [.04, .02, .008, .003, .001, .0003]) {
      // A gait/camera blend can displace the shoulders farther than two coarse
      // steps can recover. Continue useful descent at that scale before making
      // the steps smaller; the previous fixed travel budget left hard grasps
      // centimetres short even when a feasible torso pose was nearby.
      for (let pass = 0; pass < 8 && best.worst > .0001 * k; pass++) {
        let changed = false;
        for (const key of ['pitch', 'drop', 'yaw', 'roll'] as const) {
          const old = pose[key], span = key === 'drop' ? step * k : step;
          let value = old, chosen = best;
          for (const sign of [-1, 1]) {
            pose[key] = T.MathUtils.clamp(old + sign * span, key === 'pitch' || key === 'drop' ? 0 : -limits[key], key === 'pitch' ? maxTrunkPitch(pose.drop / k, standing, leg, limits.pitch) : limits[key]);
            if (key === 'drop' && pose.pitch > maxTrunkPitch(pose.drop / k, standing, leg, limits.pitch) + 1e-6) { pose[key] = old; continue; }
            const candidate = evaluate();
            if (candidate.cost < chosen.cost) { value = pose[key]; chosen = candidate; }
          }
          pose[key] = value; changed ||= value !== old; best = chosen;
        }
        if (!changed) break;
      }
    }
    const baseAlpha = reduced ? 1 : 1 - Math.exp(-14 * Math.max(0, dt));
    const chosenPose = { ...pose };
    if (baseAlpha < 0.999) {
      const tol = Math.max(.00035 * k, best.worst + 1e-5);
      const tryBlend = (a: number) => {
        chosenPose.drop = start.drop + (pose.drop - start.drop) * a;
        chosenPose.pitch = start.pitch + (pose.pitch - start.pitch) * a;
        chosenPose.yaw = start.yaw + (pose.yaw - start.yaw) * a;
        chosenPose.roll = start.roll + (pose.roll - start.roll) * a;
        apply(chosenPose);
        return error().worst;
      };
      if (tryBlend(baseAlpha) > tol) {
        let lo = baseAlpha, hi = 1;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) * 0.5;
          if (tryBlend(mid) <= tol) hi = mid;
          else lo = mid;
        }
        tryBlend(hi);
      }
    } else {
      apply(chosenPose);
    }
    Object.assign(this.bend, chosenPose);
    return true;
  }

  /** Hip hinge plus distributed spinal flexion; feet are solved back onto
   * their support after the arms. Used identically by planning and drawing. */
  private applyReachTrunk(pose: { drop: number; pitch: number; yaw: number; roll: number }, fastChain = false) {
    const hips = this.hips;
    if (!hips) return;
    const spine = this.bones.get('spine');
    const chest = this.bones.get('chest');
    const room = this.hipRoom ? hipRoomFor(pose.drop / this.scale, this.hipRoom.standing, this.hipRoom.leg) : Infinity;
    const pelvis = Math.min(pose.pitch * .8, room), rounding = pose.pitch * .8 - pelvis;
    if (fastChain) {
      // Fast 3-bone chain update (`hips -> spine -> chest`) with zero ancestor walks and zero child recursion!
      const scale = Math.hypot(
        this.model.matrixWorld.elements[0],
        this.model.matrixWorld.elements[1],
        this.model.matrixWorld.elements[2],
      ) || 1;
      hips.position.y -= pose.drop / scale;
      _artBack.copy(this.forward).multiplyScalar(-pose.pitch * .02 * this.scale);
      if (hips.parent) {
        m1.extractRotation(hips.parent.matrixWorld);
        _artParentQ.setFromRotationMatrix(m1).invert();
        _artBack.applyQuaternion(_artParentQ);
      }
      hips.position.addScaledVector(_artBack, 1 / scale);

      this.rotateWorldFast(hips, this.right, -pelvis);
      this.rotateWorldFast(hips, UP, pose.yaw * .22);
      hips.updateMatrix();
      if (hips.parent) hips.matrixWorld.multiplyMatrices(hips.parent.matrixWorld, hips.matrix);
      else hips.matrixWorld.copy(hips.matrix);

      if (spine) {
        this.rotateWorldFast(spine, this.right, -(pose.pitch * .12 + rounding * .6));
        this.rotateWorldFast(spine, UP, pose.yaw * .33);
        this.rotateWorldFast(spine, this.forward, pose.roll * .5);
        spine.updateMatrix();
        if (spine.parent) spine.matrixWorld.multiplyMatrices(spine.parent.matrixWorld, spine.matrix);
      }
      if (chest) {
        this.rotateWorldFast(chest, this.right, -(pose.pitch * .08 + rounding * .4));
        this.rotateWorldFast(chest, UP, pose.yaw * .45);
        this.rotateWorldFast(chest, this.forward, pose.roll * .5);
        chest.updateMatrix();
        if (chest.parent) chest.matrixWorld.multiplyMatrices(chest.parent.matrixWorld, chest.matrix);
      }
      return;
    }
    const scale = this.model.getWorldScale(_artScale).x;
    hips.position.y -= pose.drop / scale;
    _artBack.copy(this.forward).multiplyScalar(-pose.pitch * .02 * this.scale);
    if (hips.parent) _artBack.applyQuaternion(hips.parent.getWorldQuaternion(_artParentQ).invert());
    hips.position.addScaledVector(_artBack, 1 / scale);
    const b0 = hips;
    b0.updateWorldMatrix(true, false);
    this.rotateWorld(b0, this.right, -pelvis);
    this.rotateWorld(b0, UP, pose.yaw * .22);
    b0.updateWorldMatrix(false, false);
    if (spine) {
      spine.updateWorldMatrix(true, false);
      this.rotateWorld(spine, this.right, -(pose.pitch * .12 + rounding * .6));
      this.rotateWorld(spine, UP, pose.yaw * .33);
      this.rotateWorld(spine, this.forward, pose.roll * .5);
      spine.updateWorldMatrix(false, false);
    }
    if (chest) {
      chest.updateWorldMatrix(true, false);
      this.rotateWorld(chest, this.right, -(pose.pitch * .08 + rounding * .4));
      this.rotateWorld(chest, UP, pose.yaw * .45);
      this.rotateWorld(chest, this.forward, pose.roll * .5);
      chest.updateWorldMatrix(false, false);
    }
  }

  /**
   * Computes exact vertical ankle-to-sole offset `min_i (p_W . N) / N.y` relative to a sloped terrain tangent plane
   * with normal `leg.filteredNormal` (`N`), eliminating `+56 mm` downhill toe-lever float and `-25 mm` heel sink.
   * Identical to `leg.sole.offsetY(worldQ, scale)` when `N = UP`. Zero allocations.
   */
  private soleTerrainOffsetY(leg: Leg, worldQ: T.Quaternion, scale: T.Vector3): number {
    if (!leg.hasTerrainNormal || 1 - leg.rawNormal.y <= 1e-5) {
      return leg.sole.offsetY(worldQ, scale);
    }
    v4.copy(leg.rawNormal).normalize();
    if (v4.y < 0) v4.negate();
    const cosMax = Math.cos(0.62);
    if (v4.y < cosMax) {
      const hLen = Math.hypot(v4.x, v4.z);
      const sinMax = Math.sin(0.62);
      if (hLen > 1e-6) {
        v4.x = (v4.x / hLen) * sinMax;
        v4.z = (v4.z / hLen) * sinMax;
      } else {
        v4.x = 0;
        v4.z = 0;
      }
      v4.y = cosMax;
    }
    q4.setFromUnitVectors(v4, UP);
    q3.copy(q4).multiply(worldQ);
    return leg.sole.offsetY(q3, scale) / Math.max(0.5, v4.y);
  }

  /**
   * Computes a safe horizontal world shoe-forward pole vector that smoothly blends toward `pelvisFwd`
   * when a running/sprinting swing foot pitches steeply downward (`> 47..74 deg`) and clamps backward
   * yaw twist inside an anterior cone (`dot(outW, pelvisFwd) >= 0.25`), preventing `.setY(0)` 180 deg pole flips.
   */
  private safeShoeForwardWorld(footFwdLocal: T.Vector3, worldQ: T.Quaternion, outW: T.Vector3): T.Vector3 {
    _shoeFwd3D.copy(footFwdLocal).applyQuaternion(worldQ);
    const len3 = _shoeFwd3D.length();
    if (len3 > 1e-6) _shoeFwd3D.divideScalar(len3);
    else return outW.copy(this.pelvisFwd);

    outW.set(_shoeFwd3D.x, 0, _shoeFwd3D.z);
    const horizLen = outW.length();
    const horizBlend = T.MathUtils.smoothstep(horizLen, 0.28, 0.68);
    if (horizLen > 1e-6 && horizBlend > 1e-4) {
      outW.divideScalar(horizLen);
      if (horizBlend < 0.9999) {
        outW.lerp(this.pelvisFwd, 1 - horizBlend);
        if (outW.lengthSq() > 1e-6) outW.normalize();
        else outW.copy(this.pelvisFwd);
      }
    } else {
      return outW.copy(this.pelvisFwd);
    }

    const dFwd = outW.dot(this.pelvisFwd);
    if (dFwd < 0.25) {
      const dRight = outW.dot(this.pelvisRight);
      if (Math.abs(dRight) < 1e-4) {
        outW.copy(this.pelvisFwd);
      } else {
        const lat = (dRight >= 0 ? 1 : -1) * Math.sqrt(1 - 0.25 * 0.25);
        outW.copy(this.pelvisFwd).multiplyScalar(0.25).addScaledVector(this.pelvisRight, lat).normalize();
      }
    }
    return outW;
  }

  private kneePosition(leg: Leg, out = _kpOut): T.Vector3 {
    leg.thigh.getWorldPosition(_kpHip);
    const target = leg.goal;
    _kpTo.copy(target).sub(_kpHip);
    const l1 = leg.lenThigh, l2 = leg.lenShin;
    const d = T.MathUtils.clamp(_kpTo.length(), Math.abs(l1 - l2) + .001, l1 + l2 - .001);
    if (_kpTo.lengthSq() > 1e-12) _kpTo.normalize();
    else _kpTo.set(0, -1, 0);
    const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
    if (leg.capturedKnee) {
      _kpPole.copy(leg.capturedKnee).sub(_kpHip).normalize();
    } else {
      this.safeShoeForwardWorld(leg.footForward, leg.goalQ, _kpPole);
      if (leg.clipBend && leg.clipBend.lengthSq() > (.01 * this.scale) ** 2) {
        _kpAxis.copy(_kpTo);
        _kpA.copy(_kpPole).addScaledVector(_kpAxis, -_kpPole.dot(_kpAxis));
        _kpB.copy(leg.clipBend).addScaledVector(_kpAxis, -leg.clipBend.dot(_kpAxis));
        if (_kpA.lengthSq() > 1e-8 && _kpB.lengthSq() > 1e-8 && _kpA.dot(_kpB) > -0.25) {
          _kpA.normalize(); _kpB.normalize();
          const angle = Math.atan2(_kpCross.crossVectors(_kpA, _kpB).dot(_kpAxis), _kpA.dot(_kpB));
          _kpPole.copy(_kpA).applyAxisAngle(_kpAxis, T.MathUtils.clamp(angle, -KNEE_PLANE, KNEE_PLANE));
        }
      }
    }
    if (!leg.capturedKnee && this.strideHinge > .001) {
      _kpSag.copy(this.hipAxis).cross(_kpTo);
      _kpPole.addScaledVector(_kpTo, -_kpPole.dot(_kpTo));
      if (_kpPole.lengthSq() > 1e-8) _kpPole.normalize();
      if (_kpSag.lengthSq() > .01) {
        _kpSag.normalize();
        const angle = Math.atan2(_kpCross.copy(_kpPole).cross(_kpSag).dot(_kpTo), _kpPole.dot(_kpSag));
        if (_kpPole.lengthSq() < .01) _kpPole.copy(_kpSag);
        else _kpPole.applyAxisAngle(_kpTo, angle * this.strideHinge);
      }
    }
    if (_kpPole.lengthSq() < .01) _kpPole.copy(this.pelvisFwd);
    _kpPole.addScaledVector(_kpTo, -_kpPole.dot(_kpTo));
    if (_kpPole.lengthSq() > 1e-8) _kpPole.normalize();
    else _kpPole.copy(this.pelvisFwd);
    // Anterior knee hinge guard: `(pole x axis) . charLeft > 0` (where `charLeft = -pelvisRight`) when leg extends downward
    if (!leg.capturedKnee && _kpTo.y < 0.25) {
      const hingeDotLeft = -_kpCross.crossVectors(_kpPole, _kpTo).dot(this.pelvisRight);
      if (hingeDotLeft <= 0) {
        _kpPole.copy(this.pelvisFwd).addScaledVector(UP, 0.25).normalize();
        _kpPole.addScaledVector(_kpTo, -_kpPole.dot(_kpTo));
        if (_kpPole.lengthSq() > 1e-8) _kpPole.normalize();
        else _kpPole.copy(this.pelvisFwd);
      }
    }
    out.copy(_kpHip).addScaledVector(_kpTo, along).addScaledVector(_kpPole, h);
    if (!leg.capturedKnee && h > 1e-4) {
      const sW = Math.max(1e-4, this.scale * 1.04);
      this.model.getWorldPosition(_kpSag);
      _kpA.copy(this.pelvisRight).multiplyScalar(leg.side > 0 ? 1 : -1); // outward lateral unit vector
      const hipLat = Math.abs(_kpB.copy(_kpHip).sub(_kpSag).dot(_kpA));
      const ankleLat = Math.max(0, _kpB.copy(_kpHip).addScaledVector(_kpTo, d).sub(_kpSag).dot(_kpA));
      const minLat = Math.max(0.022 * sW, Math.min(hipLat, ankleLat) - 0.032 * sW);
      const maxLat = Math.max(hipLat, ankleLat) + 0.032 * sW;
      const curLat = _kpB.copy(out).sub(_kpSag).dot(_kpA);
      const clampedLat = T.MathUtils.clamp(curLat, minLat, maxLat);
      if (Math.abs(clampedLat - curLat) > 1e-6) {
        const ax = _kpTo.dot(_kpA);
        const omAx2 = 1 - ax * ax;
        if (omAx2 > 1e-6) {
          const sPerp = Math.sqrt(omAx2);
          const centerLat = _kpB.copy(_kpHip).addScaledVector(_kpTo, along).sub(_kpSag).dot(_kpA);
          const cx = T.MathUtils.clamp((clampedLat - centerLat) / sPerp, -h, h);
          // Orthonormal basis in plane perp to `_kpTo`: `uLat = proj_perp(_kpA)`, `uTan = _kpTo x uLat`
          _kpAxis.copy(_kpA).addScaledVector(_kpTo, -ax).divideScalar(sPerp);
          _kpCross.crossVectors(_kpTo, _kpAxis);
          const signTan = _kpPole.dot(_kpCross) >= 0 ? 1 : -1;
          const ct = signTan * Math.sqrt(Math.max(0, h * h - cx * cx));
          out
            .copy(_kpHip)
            .addScaledVector(_kpTo, along)
            .addScaledVector(_kpAxis, cx)
            .addScaledVector(_kpCross, ct);
        }
      }
    }
    return out;
  }

  private limitAnkle(leg: Leg, scale: T.Vector3, ground: number | null, gait: FootGround, stepping = false) {
    // Zero-allocation gastrocnemius-soleus ankle dorsiflexion/roll envelope
    _laCross.crossVectors(leg.footUp, leg.footForward);
    _laLocalQ.setFromRotationMatrix(_laMat.makeBasis(_laCross, leg.footUp, leg.footForward)).invert();
    const soleGroundW =
      leg.hasTerrainNormal && ground !== null
        ? 1 - T.MathUtils.smoothstep(leg.goal.y + leg.sole.offsetY(leg.goalQ, scale) - ground, 0.008 * this.scale, 0.045 * this.scale)
        : 0;
    for (let i = 0; i < 4; i++) {
      this.kneePosition(leg, _laKnee);
      _laTibia.copy(_laKnee).sub(leg.goal);
      if (_laTibia.lengthSq() < 1e-10) break;
      _laTibia.normalize();
      leg.thigh.getWorldPosition(_kpHip);
      _laFemur.copy(_laKnee).sub(_kpHip);
      if (_laFemur.lengthSq() < 1e-10) break;
      _laFemur.normalize();
      _laNegTibia.copy(_laTibia).negate();
      const kneeFlex = Math.acos(T.MathUtils.clamp(_laFemur.dot(_laNegTibia), -1, 1));
      const dorsi = .35 + .33 * T.MathUtils.smoothstep(kneeFlex, .55, 1.55) * (stepping ? this.crouchNow : 1);
      _laUp.copy(leg.footUp).applyQuaternion(leg.goalQ);
      _laFront.copy(leg.footForward).applyQuaternion(leg.goalQ);
      if (stepping) {
        _laRight.copy(_laCross).applyQuaternion(leg.hasTerrainNormal ? leg.goalQ : leg.q);
        _laRight.addScaledVector(_laTibia, -_laRight.dot(_laTibia));
        if (_laRight.lengthSq() < 1e-6) _laRight.copy(this.hipAxis).negate().addScaledVector(_laTibia, this.hipAxis.dot(_laTibia));
        _laRight.normalize();
        _laNeutral.copy(_laRight).cross(_laTibia).normalize();
        let minPitch = -.70;
        let maxPitch = dorsi;
        let minRoll = -.17;
        let maxRoll = .17;
        if (leg.hasTerrainNormal) {
          const terrainPitch = T.MathUtils.clamp(
            Math.atan2(-leg.filteredNormal.dot(_laNeutral), Math.max(0.25, leg.filteredNormal.dot(_laTibia))),
            -0.55,
            0.55,
          );
          const terrainRoll = T.MathUtils.clamp(
            Math.asin(T.MathUtils.clamp(leg.filteredNormal.dot(_laRight), -1, 1)),
            -0.42,
            0.42,
          );
          minPitch = Math.min(-.70, terrainPitch - 0.14);
          maxPitch = Math.max(dorsi, terrainPitch + 0.14);
          minRoll = T.MathUtils.lerp(-0.17, terrainRoll - 0.12, soleGroundW);
          maxRoll = T.MathUtils.lerp(0.17, terrainRoll + 0.12, soleGroundW);
        }
        const pitch = T.MathUtils.clamp(Math.atan2(_laFront.dot(_laTibia), _laFront.dot(_laNeutral)), minPitch, maxPitch);
        const roll = T.MathUtils.clamp(Math.asin(T.MathUtils.clamp(_laUp.dot(_laRight), -1, 1)), minRoll, maxRoll);
        _laForward.copy(_laNeutral).multiplyScalar(Math.cos(pitch)).addScaledVector(_laTibia, Math.sin(pitch));
        _laUpright.copy(_laTibia).multiplyScalar(Math.cos(pitch)).addScaledVector(_laNeutral, -Math.sin(pitch));
        _laLateral.copy(_laRight).multiplyScalar(Math.cos(roll)).addScaledVector(_laUpright, -Math.sin(roll));
        _laUpright.multiplyScalar(Math.cos(roll)).addScaledVector(_laRight, Math.sin(roll));
        _laNextQ.setFromRotationMatrix(_laMat.makeBasis(_laLateral, _laUpright, _laForward)).multiply(_laLocalQ);
        if (leg.goalQ.angleTo(_laNextQ) < .0001) break;
        const low = leg.sole.offsetY(leg.goalQ, scale);
        leg.goalQ.copy(_laNextQ);
        const after = leg.sole.offsetY(_laNextQ, scale);
        leg.goal.y += low - after;
        gait.reorient(leg.goal, _laNextQ, scale, leg.sole.supportPoint(_laNextQ, scale, _solePt), ground, after);
        continue;
      }
      _laNeutral.copy(_laFront).setY(0);
      if (_laNeutral.lengthSq() < 1e-6) _laNeutral.copy(this.pelvisFwd);
      else _laNeutral.normalize();
      _laRight.crossVectors(UP, _laNeutral);
      const toe = Math.atan2(_laFront.y, Math.hypot(_laFront.x, _laFront.z));
      const tilt = Math.asin(T.MathUtils.clamp(_laUp.dot(_laRight), -1, 1));
      const tibiaPitch = Math.atan2(_laTibia.dot(_laNeutral), _laTibia.y);
      const tibiaRoll = Math.asin(T.MathUtils.clamp(_laTibia.dot(_laRight), -1, 1));
      let minP = -.70 - tibiaPitch;
      let maxP = dorsi - tibiaPitch;
      let minR = tibiaRoll - .17;
      let maxR = tibiaRoll + .17;
      if (leg.hasTerrainNormal) {
        const terrainPitch = T.MathUtils.clamp(
          Math.atan2(-leg.filteredNormal.dot(_laNeutral), Math.max(0.25, leg.filteredNormal.y)),
          -0.52,
          0.52,
        );
        const terrainRoll = T.MathUtils.clamp(
          Math.asin(T.MathUtils.clamp(leg.filteredNormal.dot(_laRight), -1, 1)),
          -0.18,
          0.18,
        );
        minP = Math.min(minP, terrainPitch - 0.12);
        maxP = Math.max(maxP, terrainPitch + 0.12);
        minR = Math.max(-0.20, Math.min(minR, terrainRoll - 0.04));
        maxR = Math.min(0.20, Math.max(maxR, terrainRoll + 0.04));
      }
      const p = T.MathUtils.clamp(toe, minP, maxP);
      const r = T.MathUtils.clamp(tilt, minR, maxR);
      if (Math.abs(p - toe) + Math.abs(r - tilt) < .0001) break;
      _laForward.copy(_laNeutral).multiplyScalar(Math.cos(p)).addScaledVector(UP, Math.sin(p));
      _laUpright.copy(UP).multiplyScalar(Math.cos(p)).addScaledVector(_laNeutral, -Math.sin(p));
      _laLateral.copy(_laRight).multiplyScalar(Math.cos(r)).addScaledVector(_laUpright, -Math.sin(r));
      _laUpright.multiplyScalar(Math.cos(r)).addScaledVector(_laRight, Math.sin(r));
      const low = leg.sole.offsetY(leg.goalQ, scale);
      leg.goalQ.setFromRotationMatrix(_laMat.makeBasis(_laLateral, _laUpright, _laForward)).multiply(_laLocalQ);
      const after = leg.sole.offsetY(leg.goalQ, scale);
      leg.goal.y += low - after;
      gait.reorient(leg.goal, leg.goalQ, scale, leg.sole.supportPoint(leg.goalQ, scale, _solePt), ground, after);
    }
  }

  private plantFoot(leg: Leg, weight = 1) {
    this.model.getWorldQuaternion(_modelQ);
    _invModelQ.copy(_modelQ).invert();
    this.safeShoeForwardWorld(leg.footForward, leg.goalQ, _shoeFwdW);
    _shoeFwdC.copy(_shoeFwdW).applyQuaternion(_invModelQ).normalize();
    const unifiedKnee = leg.capturedKnee ?? this.kneePosition(leg, _kpOut);
    solveAnalyticLegIk(
      this.model,
      leg.thigh,
      leg.shin,
      leg.foot,
      leg.goal,
      {
        charSideX: leg.side < 0 ? 1 : -1,
        shoeForwardChar: _shoeFwdC,
        pelvisYawOffsetRad: this.activeMoveYaw,
        explicitPoleWorld: unifiedKnee,
        clampCoronalSplay: !leg.capturedKnee,
        footWorldRotation: leg.goalQ,
        toeBone: leg.toe,
        toeRestQuat: leg.toeRest,
        toeCounterPitchRad: leg.toeCounterPitch,
        weight,
      },
    );
  }

  /**
   * Each finger closes from open towards its grip's far end, in the hand's real place, and stops where it meets the thing: the joints,
   * the middle of each segment and the tip are tested, with the finger's own thickness, and the first touch is refined to a fraction of
   * a step. Against a mesh shape that is the thing's real triangles.
   */
  private fitFingers(arm: Arm, shape: GraspShape, pose: FingerPose): number {
    const steps = this.fitSteps(arm, shape, pose);
    let r = steps.next();
    while (!r.done) r = steps.next();
    return r.value;
  }
  /**
   * The finger fit itself, resumable: it pauses after every skin measurement. Run to the end at once (`fitFingers`) or a few
   * milliseconds a frame on a frozen copy of the hand (`FitJob`): the same statements in the same order, so the same answer.
   */
  private *fitSteps(arm: FitArm, shape: GraspShape, pose: FingerPose): Generator<void, number> {
    let met = 0;
    // The finger is about 1.6 cm thick: its centre line stops this far from the surface.
    const thick = .0082 * this.scale, p = new T.Vector3(), tip = new T.Vector3(), prev = new T.Vector3(), p2 = new T.Vector3(), acc = new T.Vector3();
    const wrap = !!arm.contact?.wrap;
    const sdf = (w: T.Vector3) => {
      p.copy(w).applyMatrix4(shape.toLocal);
      // Round a handle the surface has an inside: a finger centre in the shaft is negative, never "far from the surface".
      if (shape.kind === 'mesh' && wrap && shape.signedDistance) return shape.signedDistance(p, .025 * this.scale);
      if (shape.kind === 'mesh' && shape.distance) return shape.distance(p);
      const [hx, hy, hz] = shape.half;
      if (shape.kind === 'sphere') return p.length() - Math.max(hx, hy, hz);
      if (shape.kind === 'cyl') return Math.max(Math.hypot(p.x, p.z) - Math.max(hx, hz), Math.abs(p.y) - hy);
      const dx = Math.abs(p.x) - hx, dy = Math.abs(p.y) - hy, dz = Math.abs(p.z) - hz;
      return Math.min(0, Math.max(dx, dy, dz)) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0));
    };
    arm.hand.updateWorldMatrix(true, false);
    // Trial poses are measurements: the drawn fingers keep easing from where they were, never jump to the last trial.
    const drawn = arm.fingers.map(f => f.bone.quaternion.clone());
    for (let i = 0; i < 5; i++) {
      const chain = arm.fingers.filter(f => f.finger === i).sort((a, b) => a.joint - b.joint);
      if (!chain.length) continue;
      // The finger's drawn skin at this curl, skinned with the cast's own weights: the nearest any of it comes to the thing (negative: inside).
      const skin = arm.skin?.[i] ?? null;
      const distalBone = (sk0: FingerSkin) => sk0.mesh.skeleton.bones.indexOf(chain[chain.length - 1].bone);
      const skinAt = function* (sk: FingerSkin, s: number, spread = 0, stride = 1, angles?: number[], distal = false, stopBelow = -.02): Generator<void, number> {
        const tipBone = distal ? distalBone(sk) : -1;
        for (const f of chain) {
          e1.set(angles ? angles[f.joint] : pose[i][f.joint] * s, f.joint === 0 ? (angles?.[4] ?? 0) * arm.side : 0, f.joint === 0 ? (pose[i][3] + spread) * -arm.side : 0);
          q1.setFromEuler(e1);
          f.bone.quaternion.copy(f.rest).multiply(q1);
        }
        chain[0].bone.updateWorldMatrix(true, true);
        const bones = sk.mesh.skeleton.bones, inverses = sk.mesh.skeleton.boneInverses, mats = new Map<number, T.Matrix4>();
        let near = Infinity, visited = 0;
        for (let n = 0; n < sk.count; n += stride) {
          if (distal) { let tw = 0; for (let k = 0; k < 4; k++) if (sk.bones[n * 4 + k] === tipBone) tw += sk.weights[n * 4 + k]; if (tw < .5) continue; }
          acc.set(0, 0, 0);
          for (let k = 0; k < 4; k++) {
            const w = sk.weights[n * 4 + k];
            if (w === 0) continue;
            const b = sk.bones[n * 4 + k];
            let mat = mats.get(b);
            if (!mat) { mat = new T.Matrix4().multiplyMatrices(bones[b].matrixWorld, inverses[b]); mats.set(b, mat); }
            acc.addScaledVector(p2.set(sk.bind[n * 3], sk.bind[n * 3 + 1], sk.bind[n * 3 + 2]).applyMatrix4(mat), w);
          }
          near = Math.min(near, sdf(acc));
          if (near < stopBelow) break;
          if (++visited % 384 === 0) yield;
        }
        yield;
        return near;
      };
      const nearAt = (s: number) => {
        for (const f of chain) {
          e1.set(pose[i][f.joint] * s, 0, f.joint === 0 ? pose[i][3] * -arm.side : 0);
          q1.setFromEuler(e1);
          f.bone.quaternion.copy(f.rest).multiply(q1);
        }
        // From the hand down: the bones between the hand and this finger may not have been updated since the arm was solved.
        chain[0].bone.updateWorldMatrix(true, true);
        let near = Infinity;
        for (let j = 0; j < chain.length; j++) {
          chain[j].bone.getWorldPosition(tip);
          near = Math.min(near, sdf(tip));
          if (j > 0) { prev.lerp(tip, .5); near = Math.min(near, sdf(prev)); }
          prev.copy(tip);
        }
        const last = chain[chain.length - 1];
        tip.set(0, last.tip, 0).applyMatrix4(last.bone.matrixWorld);
        near = Math.min(near, sdf(tip));
        prev.lerp(tip, .5); near = Math.min(near, sdf(prev));
        return near;
      };
      if (arm.contact?.wrap) {
        // The drawn skin has no soft-tissue compression. Stop outside the
        // handle; the small clearance also accommodates skinned face chords.
        const allowed = skin ? .0002 * this.scale : thick * .72;
        arm.jointFit[i] = null;
        // A finger closes round a handle from its base, as a hand does: the knuckle flexes until the first segment meets the
        // handle, then the middle joint until the next one does, then the last. Each stops at its own contact; none goes in.
        if (skin && chain.length === 3) {
          // Fingers: flexion limits of MCP, PIP, DIP. Thumb: CMC, MCP, IP, tried at widening abduction (the opposition of a power
          // grip): the first abduction at which it closes onto the handle is kept.
          const thumb = i === 0, most = thumb ? [1.0, 1.2, 1.4] : [1.57, 1.75, 1.2];
          const spreads = thumb ? [0, .15, .3, .45, .6, .75, .9, 1.05] : [0];
          const starts = thumb ? [[.05, .05, .05], [.25, .05, .05]] : [[.02, .12, .08], [-.1, .05, .05], [.3, .1, .05], [.6, .1, .05]];
          let done = false, bestPad = Infinity, best: { angles: number[]; sp: number; touched: boolean } | null = null;
          if (thumb && shape.kind === 'cyl') {
            for (const angles of SHAFT_THUMB_POSES) {
              const sp = angles[3] - pose[i][3];
              if ((yield* skinAt(skin, 1, sp, 1, angles)) < allowed) continue;
              const pad = yield* skinAt(skin, 1, sp, 1, angles, true);
              if (pad <= .002 * this.scale && pad < bestPad) {
                bestPad = pad;
                best = { angles, sp, touched: true };
              }
            }
            if (best) {
              arm.jointFit[i] = best.angles; arm.fit[i] = 1; arm.spreadFit[i] = best.sp;
              met++; continue;
            }
          }
          for (const sp of spreads) {
            const clear = function* (a: number[]): Generator<void, boolean> { return (yield* skinAt(skin, 1, sp, 1, a, false, allowed)) >= allowed; };
            let start: number[] | undefined;
            for (const c of starts) if (yield* clear(c)) { start = c; break; }
            if (!start) continue;
            const angles = start.slice();
            let touched = false;
            for (let j = 0; j < 3; j++) {
              const at = angles.slice();
              at[j] = most[j];
              if (yield* clear(at)) { angles[j] = most[j]; continue; }
              let lo = angles[j], hi = most[j];
              // Keep a fully clear lower bracket at each joint. Backing off
              // the fingertip cannot resolve a collision at the knuckle.
              for (let k = 0; k < 7; k++) { const mid = (lo + hi) / 2; at[j] = mid; if (yield* clear(at)) lo = mid; else hi = mid; }
              angles[j] = lo; touched = true;
            }
            if (thumb) {
              // The thumb that opposes a power grip rests its pad on the handle: of the abductions that close without going
              // in, the one that brings the pad nearest the handle.
              const pad = yield* skinAt(skin, 1, sp, 1, angles, true);
              if (pad < bestPad) { bestPad = pad; best = { angles: angles.slice(), sp, touched }; }
              continue;
            }
            arm.jointFit[i] = angles; arm.fit[i] = 1; arm.spreadFit[i] = sp;
            if (touched) met++;
            done = true;
            break;
          }
          if (thumb && best) { arm.jointFit[i] = best.angles; arm.fit[i] = 1; arm.spreadFit[i] = best.sp; if (best.touched) met++; done = true; }
          if (done) continue;
        }
        // A thumb that cannot go round the handle as the grip holds it opens away from the palm, as far as a thumb
        // abducts, until it closes round the other side: the opposition of a power grip, never a thumb through the shaft.
        // The other fingers may part a little from their neighbours for the same reason, as far as fingers spread.
        const spreads = skin && i === 0 ? [0, .15, .3, .45, .6, .75, .9, 1.05] : skin ? [0, .1, -.1, .2, -.2] : [0];
        let found = -1, least = 1, most = -Infinity, spread = 0, leastSpread = 0;
        // Searched on every third skin vertex; the chosen curl is then checked on all of them.
        for (const sp of spreads) {
          const measure = function* (s: number): Generator<void, number> { return skin ? yield* skinAt(skin, s, sp, 3) : nearAt(s); };
          for (let s = 1.3; s >= .55; s -= .05) {
            const n = yield* measure(s);
            if (n >= allowed) { found = s; break; }
            if (n > most) { most = n; least = s; leastSpread = sp; }
          }
          // From the first curl that clears the handle towards the one that did not: closed until the skin meets it.
          if (found >= 0) {
            if (found < 1.3) {
              let lo = found, hi = Math.min(1.3, found + .05);
              for (let k = 0; k < 6; k++) { const mid = (lo + hi) / 2; if ((yield* measure(mid)) >= allowed) lo = mid; else hi = mid; }
              found = lo;
            }
            spread = sp;
            if (skin) for (let k = 0; k < 8 && found > .55 && (yield* skinAt(skin, found, sp)) < allowed; k++) found = Math.max(.55, found - .025);
            break;
          }
        }
        // No way round at all (a fifth finger where the bar is thick): curled and just touching, never a finger stuck out straight.
        arm.fit[i] = found >= 0 ? found : least;
        arm.spreadFit[i] = found >= 0 ? spread : leastSpread;
        if (found < 0 || found < 1.3 - 1e-3) met++;
        continue;
      }
      arm.spreadFit[i] = 0;
      let best = 1.45, open = 0;
      // Round a thin handle the fingers go all the way: the first joint touching it early is not the hand being closed.
      const least = shape.kind === 'cyl' && Math.max(shape.half[0], shape.half[2]) < .02 ? 1 : 0;
      for (let s = .12; s <= 1.45; s += .12) {
        if (s < least) { open = s; continue; }
        if (nearAt(s) < thick) {
          // Between the last open step and this one: the finger stops on the surface, not a step inside it.
          let lo = open, hi = s;
          for (let k = 0; k < 4; k++) { const mid = (lo + hi) / 2; if (nearAt(mid) < thick) hi = mid; else lo = mid; }
          best = Math.max(least, lo);
          break;
        }
        open = s;
      }
      arm.fit[i] = best;
    }
    arm.fingers.forEach((f, i) => f.bone.quaternion.copy(drawn[i]));
    arm.hand.updateWorldMatrix(false, true);
    return met;
  }

  private leadClavicle(arm: Arm, wristGoal: T.Vector3, weight = 1, fastChain = false) {
    const w = T.MathUtils.clamp(weight, 0, 1);
    const c = arm.clavicle;
    if (!c.parent) return;
    if (fastChain) {
      c.updateMatrix();
      c.matrixWorld.multiplyMatrices(c.parent.matrixWorld, c.matrix);
      if (w <= 1e-5) return;
      _clavShoulder.copy(arm.upper.position).applyMatrix4(c.matrixWorld);
    } else {
      if (w <= 1e-5) return;
      arm.upper.updateWorldMatrix(true, false);
      arm.upper.getWorldPosition(_clavShoulder);
    }
    _clavTo.copy(wristGoal).sub(_clavShoulder);
    const dist = _clavTo.length();
    if (dist <= 1e-4) return;

    _clavTo.divideScalar(dist);
    const rise = Math.max(0, _clavTo.dot(UP));
    const forward = Math.max(0, _clavTo.dot(this.forward));
    let shrug = arm.side * -.22 * rise * rise;
    let protract = arm.side * -.18 * forward * Math.min(1, dist / ((arm.lenUpper + arm.lenFore) * .8));
    const totalMag = Math.hypot(shrug, protract);
    if (totalMag <= 1e-5) return;
    if (totalMag > MAX_CLAVICLE_RAD) {
      const s = MAX_CLAVICLE_RAD / totalMag;
      shrug *= s;
      protract *= s;
    }

    _clavBaseQ.copy(c.quaternion);
    if (fastChain) {
      this.rotateWorldFast(c, this.forward, shrug);
      this.rotateWorldFast(c, UP, protract);
    } else {
      c.updateWorldMatrix(true, false);
      this.rotateWorld(c, this.forward, shrug);
      c.updateWorldMatrix(false, false);
      this.rotateWorld(c, UP, protract);
    }
    _clavTargetQ.copy(c.quaternion);
    if (_clavBaseQ.dot(_clavTargetQ) < 0) {
      _clavTargetQ.set(-_clavTargetQ.x, -_clavTargetQ.y, -_clavTargetQ.z, -_clavTargetQ.w);
    }
    if (w >= 0.9999) {
      c.quaternion.copy(_clavTargetQ);
    } else {
      c.quaternion.copy(_clavBaseQ).slerp(_clavTargetQ, w);
    }
    if (fastChain) {
      c.updateMatrix();
      c.matrixWorld.multiplyMatrices(c.parent.matrixWorld, c.matrix);
    } else {
      c.updateWorldMatrix(false, true);
    }
  }

  private solve(
    arm: Arm,
    wristGoal: T.Vector3,
    pole: T.Vector3,
    handGoal: T.Quaternion,
    limit: number,
    exact: boolean,
    shoulderFixed = false,
    clavicleWeight = 1,
    dt = 0,
  ) {
    if (!shoulderFixed) this.leadClavicle(arm, wristGoal, clavicleWeight);
    arm.upper.updateWorldMatrix(true, false);
    const shoulder = arm.upper.getWorldPosition(_solveShoulder);
    const isCylWrap = Boolean(arm.contact?.grip === 'handle' && arm.contact?.wrap);
    const effLimit = isCylWrap
      ? Math.max(limit, HANDLE_WRAP_WRIST_LIMIT)
      : arm.contact
        ? Math.min(limit, MAX_GENERAL_WRIST_FLEX_RAD)
        : limit;
    let handSpec: typeof _handSpecScratch | undefined;
    if (arm.contact?.on && !arm.contact.wristPivot && !exact) {
      _handSpecScratch.direction.copy(UP).applyQuaternion(handGoal);
      _handSpecScratch.limit = effLimit;
      _handSpecScratch.palm.set(0, 0, 1).applyQuaternion(handGoal);
      _handSpecScratch.side = arm.side;
      _handSpecScratch.maxRoll = isCylWrap ? HANDLE_WRAP_WRIST_LIMIT : MAX_FOREARM_ROLL_RAD;
      handSpec = _handSpecScratch;
    }
    // The roll controller fits the prop around the measured hinge. Preserve
    // that elbow here and apply the final wrist limit after the physics step.
    let solved = solveArm(shoulder, wristGoal, pole, arm.lenUpper, arm.lenFore, handSpec, _solvedArmOut);
    _solveUpperDir.copy(solved.elbow).sub(shoulder).normalize();
    _solveForeDir.copy(solved.wrist).sub(solved.elbow).normalize();
    const hand = _solveHandQ.copy(handGoal);
    if (!exact) alignWrist(hand, _solveForeDir, effLimit);
    if (!exact && isCylWrap && hand.angleTo(handGoal) > 1e-5) {
      const sh = arm.contact?.shape?.();
      if (sh && sh.kind === 'cyl') {
        for (let iter = 0; iter < 2; iter++) {
          reSeatCylindricalHandleWrist(wristGoal, handGoal, hand, sh.toLocal, _reSeatWrist);
          solved = solveArm(shoulder, _reSeatWrist, pole, arm.lenUpper, arm.lenFore, handSpec, _solvedArmOut);
          _solveUpperDir.copy(solved.elbow).sub(shoulder).normalize();
          _solveForeDir.copy(solved.wrist).sub(solved.elbow).normalize();
          hand.copy(handGoal);
          alignWrist(hand, _solveForeDir, effLimit);
        }
      }
    }
    // The elbow's hinge: the same axis for both bones, the way the elbow bends. A straight arm keeps the last good one.
    _solveHinge.copy(_solveUpperDir).cross(_solveForeDir);
    if (_solveHinge.lengthSq() > 1e-4) {
      (arm.hinge ??= new T.Vector3()).copy(_solveHinge).normalize();
    } else if (!arm.hinge) {
      arm.hinge = this.right.clone();
    }
    worldFrame(_solveUpperDir, arm.hinge!, q4);
    this.setWorldRotation(arm.upper, q4);
    arm.upper.updateWorldMatrix(false, true);
    worldFrame(_solveForeDir, arm.hinge!, q4);
    this.setWorldRotation(arm.fore, q4);
    arm.fore.updateWorldMatrix(false, true);
    this.setWorldRotation(arm.hand, hand);
    arm.hand.updateWorldMatrix(false, true);
    this.distributeTwist(arm, dt, false);
  }

  /** The hand's roll against the forearm is shared with the twist bone: the skin wrings along the arm, not at the wrist.
   * Canonical swing-twist extraction around +Y with branch-free neutral return and ±1.25 rad pronation/supination clamp. */
  private distributeTwist(arm: Arm, dt = 0, freeToClip = false) {
    if (!arm.twist) return;
    q1.copy(arm.bindHand).invert().multiply(arm.hand.quaternion);
    const norm = Math.hypot(q1.y, q1.w);
    let rawAngle = 0;
    if (norm > 1e-6) {
      const sy = q1.w < 0 ? -q1.y : q1.y;
      const sw = q1.w < 0 ? -q1.w : q1.w;
      rawAngle = 2 * Math.atan2(sy, sw);
    }
    let clamped: number;
    if (freeToClip) {
      // Free animation-clip arm: return directly along principal branch without 2pi unwrap lock!
      const target = T.MathUtils.clamp(rawAngle, -MAX_FOREARM_TWIST_RAD, MAX_FOREARM_TWIST_RAD);
      if (!arm.twistSeen || dt <= 0) {
        clamped = target;
      } else {
        clamped = arm.lastTwist + (target - arm.lastTwist) * (1 - Math.exp(-20 * dt));
        if (Math.abs(clamped - target) < 1e-4) clamped = target;
      }
    } else {
      let angle = rawAngle;
      if (arm.twistSeen) {
        let delta = angle - arm.lastTwist;
        delta = Math.atan2(Math.sin(delta), Math.cos(delta));
        angle = arm.lastTwist + delta;
      }
      clamped = T.MathUtils.clamp(angle, -MAX_FOREARM_TWIST_RAD, MAX_FOREARM_TWIST_RAD);
    }
    arm.lastTwist = clamped;
    arm.twistSeen = true;
    q2.setFromAxisAngle(UP, clamped * .72);
    arm.twist.quaternion.copy(arm.twistRest).multiply(q2);
  }

  private fingers(arm: Arm, pose: FingerPose, dt: number, reduced: boolean, floorWeight = 0, any = 1, clipFingerWeight = 0.55) {
    const open = reduced ? 1 : 1 - Math.exp(-16 * dt);
    const idleClipBlend = any <= 0.0005 && !arm.contact && floorWeight === 0;
    const clampedClipW = T.MathUtils.clamp(clipFingerWeight, 0, 1);
    const isFlatClap = pose === arm.flat;
    for (const f of arm.fingers) {
      const target = pose[f.finger];
      const loop = arm.contact?.handleJoints?.[f.finger];
      const rawWant = loop?.[f.joint] ?? arm.jointFit[f.finger]?.[f.joint] ?? target[f.joint] * arm.fit[f.finger];
      const minAllow = isFlatClap ? arm.flat[f.finger][f.joint] : undefined;
      const want = clampFingerBend(f.finger, f.joint, rawWant, minAllow);
      const wantSpread = clampFingerSpread(f.finger, loop?.[3] ?? (target[3] + arm.spreadFit[f.finger]));
      const wantOpp = clampFingerOpposition(f.finger, loop?.[4] ?? arm.jointFit[f.finger]?.[4] ?? 0);
      // Closing on something is a short wave from the thumb and index to the little finger; letting go opens them together.
      const a = reduced ? 1 : want > f.bend ? 1 - Math.exp(-(15 - f.finger * 1.6) * dt) : open;
      f.bend = clampFingerBend(f.finger, f.joint, f.bend + (want - f.bend) * a, minAllow);
      f.spread = clampFingerSpread(f.finger, f.spread + (wantSpread - f.spread) * open);
      f.opposition = clampFingerOpposition(f.finger, f.opposition + (wantOpp - f.opposition) * open);
      // +X flexes towards the palm in both hands. Spread: the index side is the thumb's side, mirrored between hands.
      e1.set(f.bend, f.joint === 0 ? f.opposition * arm.side : 0, f.joint === 0 ? f.spread * -arm.side : 0);
      q1.setFromEuler(e1);
      f.bone.quaternion.copy(f.rest).multiply(q1);
      // The captured palm and digits may bear weight on the floor; when completely idle/free, blend toward captured clip finger motion.
      if (floorWeight > 0) {
        const baseQ = this.base.get(f.bone);
        if (baseQ) f.bone.quaternion.slerp(baseQ, floorWeight);
      } else if (idleClipBlend && clampedClipW > 0) {
        const baseQ = this.base.get(f.bone);
        if (baseQ) f.bone.quaternion.slerp(baseQ, clampedClipW);
      }
    }
  }

  /** Points of the arms for tests and QA. */
  get state() {
    return {
      ready: this.ready, gesture: this.gesture, phase: this.phase, poseState: this.poseState,
      arms: this.arms.map(a => {
        const p = (b: T.Bone) => b.getWorldPosition(new T.Vector3()).toArray();
        return { side: a.side, shoulder: p(a.upper), elbow: p(a.fore), wrist: p(a.hand), contact: a.contactT, weight: a.weight, handAxis: new T.Vector3(0, 1, 0).applyQuaternion(a.hand.getWorldQuaternion(new T.Quaternion())).toArray(), palmAxis: new T.Vector3(0, 0, 1).applyQuaternion(a.hand.getWorldQuaternion(new T.Quaternion())).toArray() };
      }),
    };
  }
}

const yAxis = new T.Vector3(0, 1, 0);
/** For each joint: the bend that takes the bone straight along the one before it. Measured from this skeleton, once. */
function flatPose(fingers: Finger[]): FingerPose {
  const pose = GRIPS.flat.map(f => [...f]);
  for (const f of fingers) {
    if (f.finger === 0) continue;
    let best = 0, bestDot = -2;
    for (let a = -.7; a <= .3; a += .02) {
      q1.setFromAxisAngle(x1, a);
      const d = yAxis.clone().applyQuaternion(q1).applyQuaternion(f.rest).dot(yAxis);
      if (d > bestDot) { bestDot = d; best = a; }
    }
    pose[f.finger][f.joint] = best;
  }
  return pose;
}
const x1 = new T.Vector3(1, 0, 0);
const BLEND: FingerPose = GRIPS.relaxed.map(f => [...f]);
function blendPose(a: FingerPose, b: FingerPose, w: number): FingerPose {
  if (w <= 0) return a;
  if (w >= 1) return b;
  for (let i = 0; i < 5; i++) for (let j = 0; j < 4; j++) BLEND[i][j] = a[i][j] + (b[i][j] - a[i][j]) * w;
  return BLEND;
}
