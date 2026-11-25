import * as T from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Basketball } from './basketball';
import { MarketStock } from './marketStock';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { EchoLifeGame, Target } from '@/lib/echo-life/game/session';
import { TwoWheeler, rideModels } from '@/lib/echo-life/game/twoWheeler';
import { Automobile, type RoadVehicle } from '@/lib/echo-life/game/automobile';
import type { FootSupportSample, LifeWalk } from '@/lib/echo-life/walk';
import type { Seat, Walker } from '@/lib/echo-life/game/people';
import { CHARACTERS } from '@/lib/echo-life/v3/game-core/index.mjs';
import {
  PelvisVerticalSpring,
  createNpcFootLockState,
  filterFootSurfaceNormal,
  resetNpcFootLockState,
  sampleStanceFootTarget,
  solveAnalyticLegIk,
  solveFootSlopeAndRollRotation,
  type AnalyticLegIkOptions,
  type FootSlopeRollOutput,
  type NpcFootLockState,
  type StanceFootSampleOutput,
} from '@/lib/embodiment/legIk';
import {
  RiderIkController,
  applyCoherentRiderIk,
  bindRiderSkeleton,
  restoreRiderSkeleton,
  type BoundRiderSkeleton,
  type RiderKinematicState,
} from '@/lib/embodiment/riderIk';
import {
  LIFE_ASSETS,
  installGltfTextureDedupPlugin,
  isDedupManagedTexture,
  stripTransmissionFromHierarchy,
} from './assets';
import {
  applyClothAaaShader,
  upgradeCharacterMaterials,
  setCharacterSeasonState,
  isShadowMicroDetailMesh,
  type CharacterQuality,
} from './characterMaterials';
import { WAVE11_WINTER_NPC_URLS } from '@/lib/avatar/wardrobeAssets';
import { CharacterAnimator, loadEcho48Pack } from './characterAnimator';
import { CharacterLife, sanitizeCodex52OralMorphs, type LifeMood } from './characterLife';
import { getInFlightCompileCount } from './echoCsm';
import { RENDER_CONFIGS } from './renderConfig';
import { estimateObjectGpuBytes, getEchoLifeResidencyManager } from './residencyManager';
import { bindDirtyGatedSkeleton, type DirtyGatedSkeletonHandle } from './scratch';
import { SecondaryPhysics, type SecondaryWind } from './secondaryPhysics';
import {
  CAR_STEERING_WHEEL_RATIO,
  KICKSTAND_FOLD_RAD,
  applyVehicleRigKinematics,
  extractVehicleRig,
  type VehicleRigSockets,
} from './vehicleRigExtractor';
import {
  createDummyVehicleWarmupGroup,
  disposeDummyVehicleWarmupGroup,
  disposeVehicleVisualRig,
  getVehiclePrewarmHook,
  setVehiclePrewarmHook,
  upgradeAndOptimizeVehicleRig,
  type VehiclePrewarmHook,
  type VehicleVisualRig,
} from './workshopView';

export {
  createDummyVehicleWarmupGroup,
  disposeDummyVehicleWarmupGroup,
  setVehiclePrewarmHook,
  type VehiclePrewarmHook,
};

/**
 * Echo Life AAA Character, Crowd, Vehicle, Basketball & Hotspot Renderer inside the Study Space stage.
 *
 * Key upgrades:
 *  - Wired `RENDER_CONFIGS[tier].crowd.*` & `shadow.castNpcs` (disables wasted skinned NPC shadows on
 *    Balanced/Low, cutting Lantern Street NPC shadow draw calls by >40%).
 *  - Zero-allocation per-frame update loop (reusable `NearActor` pool, typed coordinate scratch buffers,
 *    reusable `Set`/`Array`, zero per-frame closure allocations).
 *  - Full ambient crowd state mapping (`sit`, `jog`, `browse`, `chat`, `yield`, `umbrella`, `umbrellaColor`)
 *    so city passers sit on benches, jog in parks, browse storefronts, chat in pairs, and carry umbrellas.
 *  - Tier-0 (`< 12 m`, cap 6) analytical 2-bone foot-lock ground alignment & right-hand umbrella grip IK.
 *  - Live winter outerwear / snow-shiver / wind uniform sync, deterministic text-driven dialogue lip-sync,
 *    and player-yaw-coupled basketball hand clearance.
 */

export type GameViewQuality = 'ultra' | 'high' | 'balanced' | 'low';

export interface GameViewEnv {
  snow?: number;
  season?: number;
  windX?: number;
  windZ?: number;
  activeDialogueText?: string | null;
  activeDialogueSpeakerId?: string | null;
  handRight?: T.Vector3 | null;
}

/** Shared zero-alloc player right-hand stage position channel for closed-loop basketball dribbling (Bug #10). */
const _sharedPlayerHandRight = new T.Vector3();
let _sharedPlayerHandRightActive = false;
export function setEchoLifePlayerHandRight(pos: T.Vector3 | null): void {
  if (pos) {
    _sharedPlayerHandRight.copy(pos);
    _sharedPlayerHandRightActive = true;
  } else {
    _sharedPlayerHandRightActive = false;
  }
}

type WinterRigKind = keyof typeof WAVE11_WINTER_NPC_URLS;

const CODEX52_MALE_MODELS = new Set([
  'minh', 'huy', 'baolong', 'ductri', 'haidang', 'quocbao',
  'duykhoa', 'tuankiet', 'quangvinh', 'hoangphuc', 'visitor',
]);

const WINTER_COAT_WOOL_PALETTE = [
  '#243347', '#8c6846', '#284035', '#5a2632',
  '#2f343c', '#4a3529', '#3d4c41', '#483552',
] as const;

const WINTER_SCARF_PALETTE = [
  '#b84a42', '#d8c5a3', '#3b6a6c', '#9c6e3b',
  '#c7b8c9', '#5a785e', '#c97b52', '#d6dce6',
] as const;

const WINTER_TROUSERS_PALETTE = ['#22262e', '#2d3138', '#332d29', '#252e3a'] as const;
const WINTER_BOOTS_PALETTE = ['#2b2019', '#1e1c1b', '#442c1e', '#322923'] as const;

const SUMMER_CLOTHING_RE =
  /^(?:Wardrobe_|upper_|lower_|Wear_Top_|Wear_Bottom_|Wear_Outer_|Shoes_|footwear|outfit|Skirt|Shorts|Dress|Mat_Top_|Mat_Bottom_|Mat_Outer_|Mat_Shoe_|Mat_Sole_)/i;
const BACKPACK_MESH_RE = /backpack|satchel|knapsack|bag|^Mat_Acc_/i;
const BARE_SKIN_MASK_RE = /^(?:Face_and_visible_skin|Canonical_MH_Body|Mat_Skin_|skin$)/i;
const KEEP_VISIBLE_SKIN_BONE_RE =
  /^(?:Head|head|Neck|neck|.*Hand.*|hand[._]?[LR]|thumb|index|middle|ring|little|eye|jaw|face|ear)/i;
const MASKED_LIMB_BONE_RE =
  /^(?:Hips|hips|Spine|Spine1|Spine2|spine|chest|LeftShoulder|RightShoulder|shoulder[._]?[LR]|LeftArm|RightArm|upper_arm[._]?[LR]|LeftForeArm|RightForeArm|forearm[._]?[LR]|fore_twist[._]?[LR]|LeftUpLeg|RightUpLeg|thigh[._]?[LR]|LeftLeg|RightLeg|shin[._]?[LR]|LeftFoot|RightFoot|LeftToeBase|RightToeBase|foot[._]?[LR])/i;

interface SkinMaskTarget {
  mesh: T.SkinnedMesh;
  origIndex: T.BufferAttribute | null;
  maskedIndex: T.BufferAttribute | null;
  built: boolean;
}

export const LIFE_PEOPLE: Record<string, string> = {
  linh: '/echo-life/people/linh-73a0df577f32.glb',
  minh: '/echo-life/people/minh-04c5cf7f8968.glb',
  huy: '/echo-life/people/huy-54be8601ed52.glb',
  mai: '/echo-life/people/mai-2570b86ac946.glb',
  lan: '/echo-life/people/lan-f18b82ca79cf.glb',
  anchi: '/echo-life/people/anchi-29658e8e7f32.glb',
  baolong: '/echo-life/people/baolong-dcb1bcef8a41.glb',
  khanhha: '/echo-life/people/khanhha-f338d61fed2c.glb',
  ductri: '/echo-life/people/ductri-fb65fe028c99.glb',
  diemmy: '/echo-life/people/diemmy-23f3e65e63bf.glb',
  haidang: '/echo-life/people/haidang-5da45d40f997.glb',
  kimngan: '/echo-life/people/kimngan-e4e34ba63579.glb',
  quocbao: '/echo-life/people/quocbao-dd370326369f.glb',
  thaovy: '/echo-life/people/thaovy-ad58ffb6920d.glb',
  duykhoa: '/echo-life/people/duykhoa-514a04785c51.glb',
  ngocbich: '/echo-life/people/ngocbich-7f00b5116b97.glb',
  tuankiet: '/echo-life/people/tuankiet-7abf8489c49c.glb',
  phuonglien: '/echo-life/people/phuonglien-962563a7ae2a.glb',
  quangvinh: '/echo-life/people/quangvinh-023dd47bf4ef.glb',
  minhthu: '/echo-life/people/minhthu-172b1176c1fa.glb',
  hoangphuc: '/echo-life/people/hoangphuc-be93ddf3fd11.glb',
  yennhi: '/echo-life/people/yennhi-00aa83abad6d.glb',
  visitor: '/echo-life/people/visitor-f65736a9638f.glb',
  student2: '/echo-life/people/student2-0b954208550b.glb',
  crowd_student_a: '/echo-life/people/crowd_student_a-e94723726be7.glb',
  crowd_student_b: '/echo-life/people/crowd_student_b-2d1e7d3f26e5.glb',
  crowd_shopkeeper: '/echo-life/people/crowd_shopkeeper-cc5a66d46f79.glb',
  crowd_barista: '/echo-life/people/crowd_barista-3e8974cca13b.glb',
};
const CROWD_MODELS = ['visitor', 'crowd_student_a', 'crowd_student_b', 'crowd_shopkeeper', 'crowd_barista', 'student2'];
const OUTDOOR = new Set(['sidewalk', 'road', 'crossing', 'park', 'garden', 'plaza']);
const IMPOSTOR_PALETTE = ['#4c6d94', '#7a5865', '#4b7a68', '#8b6f4e', '#5d5782', '#3f6e78', '#8c5a4a', '#5a6b52'];
const UMB_COLORS = ['#2f5d7a', '#8c3b4a', '#3c6e59', '#5a4e7c', '#b37432'];

/** Backwards-compatible extension fields emitted by upgraded NPC social/mood/seat simulation. */
type ResidentExt = Walker & {
  mood?: string;
  microAct?: string | null;
  lookTarget?: { x: number; y?: number; z: number } | null;
  rainUmbrella?: boolean;
  quip?: string | null;
  visualX?: number;
  visualZ?: number;
  visualYaw?: number;
  lastSeat?: Seat | null;
};

interface NearActor {
  key: string;
  model: string;
  x: number;
  y: number;
  z: number;
  standX: number;
  standZ: number;
  yaw: number;
  act: string;
  d: number;
  named: boolean;
  seated: boolean;
  onBench: boolean;
  cushion: number | undefined;
  outdoor: boolean;
  inDialogue: boolean;
  speaking: boolean;
  speechText: string | null;
  mood: LifeMood;
  lookTarget: { x: number; y?: number; z: number } | null;
  facingId: string | null;
  rainUmbrella: boolean | undefined;
  umbrellaColorIdx: number;
  /** `-1` on foot/chair, `0..9` when riding `game.traffic[ridingVehicleIdx]`. */
  ridingVehicleIdx: number;
}

type NpcSeatPhase = 'none' | 'sitting_down' | 'seated' | 'standing_up';

interface Body {
  key: string;
  model: string;
  root: T.Object3D;
  animator: CharacterAnimator;
  life: CharacterLife;
  secondary: SecondaryPhysics;
  dirtySkeleton: DirtyGatedSkeletonHandle;
  riderSkel: BoundRiderSkeleton | null;
  ownedMaterials: T.Material[];
  ownedGeometries: T.BufferGeometry[];
  /** Main body/outfit/hair meshes eligible for Cascade-0 shadow casting (`<= 22 m`, excludes micro-trims). */
  shadowMeshes: T.Mesh[];
  /** Micro-detail meshes (`Brows`, `Eyes`, `Soles`, small accessories) hidden at distance (`> 14 m` on balanced/low). */
  microDetailMeshes: T.Mesh[];
  microHidden: boolean;
  /** Summer outfit meshes hidden during outdoor winter coat mesh swap (P0 Veto Gate #5). */
  summerClothingMeshes: T.Mesh[];
  /** Backpack/bag meshes hidden while seated on benches so zero straps intersect backrests (Bug #07). */
  backpackMeshes: T.Mesh[];
  hasBackpack: boolean;
  backpackHidden: boolean;
  /** Skin meshes whose bare arm/leg/torso triangles are masked via index buffer swap in winter. */
  skinMaskTargets: SkinMaskTarget[];
  /** Exact skeleton bone lookup for O(1) winter outerwear mesh rebinding. */
  boneMap: Map<string, T.Bone>;
  winterKind: WinterRigKind;
  winterGroup: T.Group | null;
  winterMeshes: T.SkinnedMesh[];
  winterMaterials: T.Material[];
  winterActive: boolean;
  castingShadow: boolean;
  debt: number;
  seen: number;
  initialized: boolean;
  wasInView: boolean;
  yaw: number;
  prevX: number;
  prevZ: number;
  prevYaw: number;
  hips?: T.Bone;
  head?: T.Bone;
  thighL?: T.Bone;
  shinL?: T.Bone;
  footL?: T.Bone;
  toeL?: T.Bone;
  thighR?: T.Bone;
  shinR?: T.Bone;
  footR?: T.Bone;
  toeR?: T.Bone;
  upperArmR?: T.Bone;
  forearmR?: T.Bone;
  handR?: T.Bone;
  toeRestQL: T.Quaternion;
  toeRestQR: T.Quaternion;
  footForwardLocalL: T.Vector3;
  footUpLocalL: T.Vector3;
  footForwardLocalR: T.Vector3;
  footUpLocalR: T.Vector3;
  footRestYL: number;
  footRestYR: number;
  hasFootIkRest: boolean;
  // Saved base quaternions for Tier-0 IK bones so IK never compounds across frames
  ikSavedQ: Map<T.Bone, T.Quaternion>;
  ikSavedHipsY: number;
  ikDirty: boolean;
  // Swing-safe stance foot-lock & damped pelvis state (`legIk.ts`)
  footLockL: NpcFootLockState;
  footLockR: NpcFootLockState;
  pelvisSpring: PelvisVerticalSpring;
  stairTreadBlend: number;
  // Zero-float `Sit_Down` -> `Sit_Idle` -> `Stand_Up` transition state (`root.y === groundY` always!)
  seatAnchorX: number;
  seatAnchorZ: number;
  seatStandX: number;
  seatStandZ: number;
  seatYaw: number;
  seatTopY: number;
  hasSeatMemory: boolean;
  seatPhase: NpcSeatPhase;
  seatPhaseTimer: number;
  wasSeatedInView: boolean;
}

export interface Label {
  id: string;
  name: string;
  role: string;
  x: number;
  y: number;
  dist: number;
  focus: boolean;
  scene: string | null;
}

const loader = new GLTFLoader();
installGltfTextureDedupPlugin(loader);
const VEHICLE_URL: Record<string, string> = {
  ...Object.fromEntries(Object.entries(rideModels).map(([id, m]) => [id, m.url])),
  // Matches `AAA_VEHICLE_URLS.car_mango_micro` in `workshopView.ts` without pulling workshop V3 placement deps into character tests.
  car_mango_micro: '/echo-life/aaa-v2/vehicles/mango_micro_aaa-9bd136ebad7d.glb',
  car_river_sedan: '/echo-life/vehicles/river_sedan-83b2a876daa9.glb',
  car_lotus_spider: '/echo-life/vehicles/lotus_spider-052b2681796a.glb',
  car_halo_vector: '/echo-life/vehicles/halo_vector-80f6d2bea2f4.glb',
};

// Module-scoped zero-alloc scratch math for Tier-0 NPC 2-bone leg & umbrella-arm IK
const _ikOrigin = new T.Vector3();
const _ikMid = new T.Vector3();
const _ikEnd = new T.Vector3();
const _ikDir = new T.Vector3();
const _ikBend = new T.Vector3();
const _ikPole = new T.Vector3();
const _ikTarget = new T.Vector3();
const _ikKnee = new T.Vector3();
const _ikCur = new T.Vector3();
const _ikWant = new T.Vector3();
const _ikQ1 = new T.Quaternion();
const _ikQ2 = new T.Quaternion();
const _ikQ3 = new T.Quaternion();
const _umbEuler = new T.Euler();
const _rawNormL = new T.Vector3(0, 1, 0);
const _rawNormR = new T.Vector3(0, 1, 0);
const _animFootQuatL = new T.Quaternion();
const _animFootQuatR = new T.Quaternion();
const _footSupportL: FootSupportSample = { y: 0, nx: 0, ny: 1, nz: 0, onStair: false };
const _footSupportR: FootSupportSample = { y: 0, nx: 0, ny: 1, nz: 0, onStair: false };
const _stanceOutL: StanceFootSampleOutput = {
  targetX: 0,
  targetY: 0,
  targetZ: 0,
  effectiveLockWeight: 0,
  pelvisDropRequest: 0,
};
const _stanceOutR: StanceFootSampleOutput = {
  targetX: 0,
  targetY: 0,
  targetZ: 0,
  effectiveLockWeight: 0,
  pelvisDropRequest: 0,
};
const _slopeRollOutL: FootSlopeRollOutput = {
  footWorldQuat: new T.Quaternion(),
  toeCounterPitchRad: 0,
};
const _slopeRollOutR: FootSlopeRollOutput = {
  footWorldQuat: new T.Quaternion(),
  toeCounterPitchRad: 0,
};
const _shoeFwdCharL = new T.Vector3(0, 0, 1);
const _shoeFwdCharR = new T.Vector3(0, 0, 1);
const _legIkOptsL: AnalyticLegIkOptions = {
  charSideX: 1,
  shoeForwardChar: _shoeFwdCharL,
  clampCoronalSplay: true,
  footWorldRotation: null,
  toeBone: null,
  toeRestQuat: null,
  toeCounterPitchRad: 0,
  weight: 1,
};
const _legIkOptsR: AnalyticLegIkOptions = {
  charSideX: -1,
  shoeForwardChar: _shoeFwdCharR,
  clampCoronalSplay: true,
  footWorldRotation: null,
  toeBone: null,
  toeRestQuat: null,
  toeCounterPitchRad: 0,
  weight: 1,
};
const _trafficRiderStateScratch: {
  speed: number;
  maxSpeed: number;
  steer: number;
  lean: number;
  forkDive: number;
  crankAngle: number;
  crankOmega: number;
  standDownBlend: number;
  mountBlend: number;
  armIkWeight: number;
  kickstandRetract: number;
  doorOpenBlend: number;
  groundY: number;
  standSideSign: 1 | -1;
} = {
  speed: 0,
  maxSpeed: 6,
  steer: 0,
  lean: 0,
  forkDive: 0,
  crankAngle: 0,
  crankOmega: 0,
  standDownBlend: 0,
  mountBlend: 1,
  armIkWeight: 1,
  kickstandRetract: 1,
  doorOpenBlend: 0,
  groundY: 0,
  standSideSign: 1,
};
const _bikeStepInputScratch: {
  speed: number;
  maxSpeed: number;
  throttle: number;
  steer: number;
  brake: boolean;
  isCoasting?: boolean;
  groundY: number;
} = {
  speed: 0,
  maxSpeed: 7.5,
  throttle: 0,
  steer: 0,
  brake: false,
  isCoasting: false,
  groundY: 0,
};
const _bikePoseScratch = { x: 0, z: 0, yaw: 0 };

function smoothstep01(t: number): number {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return u * u * (3 - 2 * u);
}

/** Zero-allocation world-space bone aim preserving authored twist. */
function aimBoneWorld(bone: T.Bone, child: T.Bone, targetWorld: T.Vector3, weight: number): void {
  bone.getWorldPosition(_ikOrigin);
  child.getWorldPosition(_ikCur).sub(_ikOrigin);
  _ikWant.copy(targetWorld).sub(_ikOrigin);
  if (_ikCur.lengthSq() < 1e-8 || _ikWant.lengthSq() < 1e-8) return;
  _ikCur.normalize();
  _ikWant.normalize();
  _ikQ1.setFromUnitVectors(_ikCur, _ikWant);
  bone.getWorldQuaternion(_ikQ2);
  _ikQ1.multiply(_ikQ2);
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_ikQ3).invert();
    _ikQ2.copy(_ikQ3).multiply(_ikQ1);
  } else {
    _ikQ2.copy(_ikQ1);
  }
  bone.quaternion.slerp(_ikQ2, weight);
  bone.updateWorldMatrix(true, true);
}

/** Zero-allocation analytical 2-bone cosine-law IK solver (`thigh->shin->foot` or `upper_arm->forearm->hand`). */
function solveTwoBoneZeroAlloc(
  a: T.Bone,
  b: T.Bone,
  c: T.Bone,
  targetWorld: T.Vector3,
  poleWorld: T.Vector3,
  weight: number,
): void {
  a.getWorldPosition(_ikOrigin);
  b.getWorldPosition(_ikMid);
  c.getWorldPosition(_ikEnd);
  const l1 = _ikOrigin.distanceTo(_ikMid);
  const l2 = _ikMid.distanceTo(_ikEnd);
  if (l1 < 1e-4 || l2 < 1e-4) return;
  _ikDir.copy(targetWorld).sub(_ikOrigin);
  const rawDist = _ikDir.length();
  if (rawDist < 1e-5) return;
  const dist = Math.max(Math.abs(l1 - l2) + 0.002, Math.min(l1 + l2 - 0.002, rawDist));
  _ikDir.divideScalar(rawDist);
  _ikBend.copy(poleWorld).sub(_ikOrigin);
  _ikBend.addScaledVector(_ikDir, -_ikBend.dot(_ikDir));
  if (_ikBend.lengthSq() < 1e-8) return;
  _ikBend.normalize();
  const along = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const height = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  _ikKnee.copy(_ikOrigin).addScaledVector(_ikDir, along).addScaledVector(_ikBend, height);
  aimBoneWorld(a, b, _ikKnee, weight);
  aimBoneWorld(b, c, targetWorld, weight);
}

/** Builds a clean single-draw-call merged umbrella (canopy + handle shaft, handle grip anchored at local y = 0). */
function buildUmbrellaGeometry(): T.BufferGeometry {
  const canopy = new T.ConeGeometry(0.54, 0.19, 12, 1, true);
  canopy.translate(0, 0.68, 0);
  const shaft = new T.CylinderGeometry(0.008, 0.008, 0.74, 6);
  shaft.translate(0, 0.36, 0);
  const handle = new T.CylinderGeometry(0.015, 0.015, 0.10, 6);
  handle.translate(0, 0.02, 0);
  const merged = mergeGeometries([canopy, shaft, handle], false);
  canopy.dispose();
  shaft.dispose();
  handle.dispose();
  if (merged) {
    merged.computeVertexNormals();
    return merged;
  }
  const fallback = new T.ConeGeometry(0.54, 0.19, 10, 1, true);
  fallback.translate(0, 0.68, 0);
  return fallback;
}

export interface LoadedRoadVehicleRig {
  gltf: GLTF;
  sockets: VehicleRigSockets;
  wheels: T.Object3D[];
  steer: T.Object3D[];
  door?: T.Object3D;
  paint: T.MeshStandardMaterial[];
}

class RoadVehicleView {
  model = '';
  rig: LoadedRoadVehicleRig | null = null;
  private generation = 0;
  private prewarmReady = false;
  private loadPromise: Promise<void> | null = null;
  constructor(
    private group: T.Group,
    private twoWheels: boolean,
    private readonly isPlayerOwned = false,
  ) {}

  waitReady(): Promise<void> {
    return this.loadPromise ?? Promise.resolve();
  }

  setTwoWheels(twoWheels: boolean): void {
    this.twoWheels = twoWheels;
  }

  hide(): void {
    if (this.rig) this.rig.gltf.scene.visible = false;
  }

  update(car: RoadVehicle, walk: LifeWalk, player: { x: number; z: number }, dt: number) {
    const pose = car.pose;
    car.updateDoor(dt);
    const urlKey = car.spec?.model ?? '';
    const withinRange =
      this.isPlayerOwned || Math.hypot(player.x - pose.x, player.z - pose.z) < 95;
    const model = urlKey && VEHICLE_URL[urlKey] && withinRange ? urlKey : '';
    if (model !== this.model) {
      this.release();
      this.model = model;
      const generation = this.generation;
      if (model) {
        const p = loader
          .loadAsync(VEHICLE_URL[model])
          .then((gltf) => {
            if (generation !== this.generation) {
              disposeGltf(gltf);
              return;
            }
            const root = gltf.scene;
            stripTransmissionFromHierarchy(root);
            const sockets = extractVehicleRig(root, model);
            const paint = new Set<T.MeshStandardMaterial>();
            root.traverse((o) => {
              const mesh = o as T.Mesh;
              if (mesh.isMesh) {
                mesh.frustumCulled = false;
                for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
                  if (m instanceof T.MeshStandardMaterial && /^#[a-f\d]{6}$/i.test(m.name)) paint.add(m);
                }
              }
            });
            this.rig = {
              gltf,
              sockets,
              wheels: [...sockets.wheelPivots],
              steer: [...sockets.steerPivots],
              door: sockets.driverDoorPivot ?? root.getObjectByName('pivot_door_L0') ?? undefined,
              paint: [...paint],
            };
            for (const mat of paint) mat.userData.factoryColor = mat.color.clone();
            const hook = getVehiclePrewarmHook();
            root.visible = !hook;
            this.prewarmReady = !hook;
            this.group.add(root);
            if (hook) {
              void Promise.resolve(hook(root)).finally(() => {
                if (generation === this.generation && this.rig?.gltf.scene === root) {
                  this.prewarmReady = true;
                }
              });
            }
          })
          .catch(() => {
            if (generation === this.generation) this.model = '';
          })
          .finally(() => {
            if (this.loadPromise === p) this.loadPromise = null;
          });
        this.loadPromise = p;
      }
    }
    const rig = this.rig;
    if (!rig || !car.spec) return;
    rig.gltf.scene.visible = this.prewarmReady;
    // Single visual authority: when `gameHost.syncVehicleVisualRigs` owns this upgraded player vehicle,
    // `updateVehicleVisualRig` is the sole writer of root transform, wheels, crank/pedals, door, and paint!
    if (rig.gltf.scene.userData.__ecUpgradedVehicleRig === true) {
      return;
    }
    const groundY = walk.groundAt(pose.x, pose.z) ?? 0;
    const wheelGroundY = rig.sockets.wheelGroundY;
    const carExt = car as RoadVehicle & {
      lean?: number;
      forkDive?: number;
      crankAngle?: number;
      roll?: number;
      pitch?: number;
      dynamics?: { crankAngle?: number };
    };

    if (car instanceof Automobile && car.chassis.initialized) {
      rig.gltf.scene.position.set(pose.x, car.chassis.height + wheelGroundY, pose.z);
      rig.gltf.scene.rotation.set(car.chassis.pitch, pose.yaw, car.chassis.roll, 'YXZ');
      for (const pivot of rig.wheels) {
        const wheel = car.wheels.find((w) => pivot.name === `pivot_wheel_${w.side}_${w.axle}`);
        if (wheel) {
          pivot.rotation.x = wheel.spin;
          pivot.position.y = wheel.travel;
        }
      }
    } else if (car instanceof TwoWheeler) {
      rig.gltf.scene.position.set(pose.x, groundY + wheelGroundY, pose.z);
      rig.gltf.scene.rotation.set(car.forkDive, pose.yaw, car.lean, 'YXZ');
      for (const w of rig.wheels) w.rotation.x = car.spin;
    } else {
      const roll =
        carExt.lean !== undefined
          ? carExt.lean
          : this.twoWheels && car.driving
            ? -0.14 * car.steer * Math.min(1, Math.abs(car.speed) / 2)
            : (carExt.roll ?? 0);
      const pitch = carExt.forkDive ?? carExt.pitch ?? 0;
      rig.gltf.scene.position.set(pose.x, groundY + wheelGroundY, pose.z);
      rig.gltf.scene.rotation.set(pitch, pose.yaw, roll, 'YXZ');
      for (const w of rig.wheels) w.rotation.x = car.spin;
    }

    for (const s of rig.steer) {
      s.rotation.y = this.twoWheels ? car.steer : car.wheelSteer(s.name.endsWith('_-1') ? -1 : 1);
    }
    const crankAngle = carExt.crankAngle ?? carExt.dynamics?.crankAngle ?? 0;
    if (rig.sockets.crankPivot) rig.sockets.crankPivot.rotation.x = crankAngle;
    if (rig.sockets.pedalPivotLeft) rig.sockets.pedalPivotLeft.rotation.x = -crankAngle;
    if (rig.sockets.pedalPivotRight) rig.sockets.pedalPivotRight.rotation.x = -crankAngle;
    if (rig.sockets.kickstandPivot) {
      rig.sockets.kickstandPivot.rotation.x = car.driving ? KICKSTAND_FOLD_RAD : 0;
    }
    if (rig.sockets.steeringWheelPivot) {
      rig.sockets.steeringWheelPivot.rotation.z = -car.steer * CAR_STEERING_WHEEL_RATIO;
    }
    if (rig.door) rig.door.rotation.y = -0.95 * car.door;
    for (const m of rig.paint) {
      if (car.spec.paintHex) m.color.set(car.spec.paintHex);
      else m.color.copy(m.userData.factoryColor);
    }
    rig.gltf.scene.updateWorldMatrix(true, true);
  }

  release() {
    this.generation++;
    this.prewarmReady = false;
    if (this.rig) {
      this.rig.gltf.scene.removeFromParent();
      disposeGltf(this.rig.gltf);
      this.rig = null;
    }
  }
}

/** Builds a clean tapered human torso/legs silhouette for distant instanced crowd impostors (single draw call). */
function buildImpostorBodyGeometry(): T.BufferGeometry {
  const profile = [
    new T.Vector2(0.0, 0.0),
    new T.Vector2(0.11, 0.02),
    new T.Vector2(0.125, 0.44),
    new T.Vector2(0.165, 0.84),
    new T.Vector2(0.14, 1.04),
    new T.Vector2(0.195, 1.32),
    new T.Vector2(0.085, 1.42),
    new T.Vector2(0.0, 1.44),
  ];
  const geo = new T.LatheGeometry(profile, 10);
  geo.computeVertexNormals();
  return geo;
}

let _gameViewResId = 0;

export class GameView {
  readonly group = new T.Group();
  private readonly resPrefix = `gv${++_gameViewResId}`;
  private readonly gltfs = new Map<string, Promise<GLTF | null>>();
  private readonly ready = new Map<string, { gltf: GLTF; scale: number; used: number; bytes: number }>();
  private readonly bodies = new Map<string, Body>();
  private pack48: GLTF | null = null;
  private pack48Loading = false;
  private readonly bodyMesh: T.InstancedMesh;
  private readonly headMesh: T.InstancedMesh;
  private readonly umbrellaMesh: T.InstancedMesh;
  private readonly contactShadows: T.InstancedMesh;
  private readonly rings: T.InstancedMesh;
  private readonly focusRing: T.Mesh;
  private time = 0;
  private pruneClock = 0;
  private disposed = false;
  private lastCamera: T.Camera | null = null;
  private readonly frustum = new T.Frustum();
  private readonly projScreenM = new T.Matrix4();
  private readonly tmpSphere = new T.Sphere();
  private readonly tmpM = new T.Matrix4();
  private readonly tmpC = new T.Color();
  private readonly tmpV = new T.Vector3();
  private readonly tmpV2 = new T.Vector3();
  private readonly tmpEye = new T.Vector3();
  private readonly tmpLook = new T.Vector3();
  private readonly tmpQ = new T.Quaternion();
  private readonly tmpS = new T.Vector3(1, 1, 1);
  private readonly up = new T.Vector3(0, 1, 0);
  private readonly windScratch: SecondaryWind = { x: 0.45, z: 0.2, gust: 0.35 };

  // Zero-alloc per-frame pools (eliminates NearActor, namedPos, wantSet & closure GC churn!)
  private readonly nearPool: NearActor[] = [];
  private readonly nearActive: NearActor[] = [];
  private readonly namedPosX = new Float32Array(32);
  private readonly namedPosZ = new Float32Array(32);
  private namedPosCount = 0;
  private readonly wantSet = new Set<string>();
  private readonly dropKeys: string[] = [];
  private trafficCtxPlayerX = 0;
  private trafficCtxPlayerZ = 0;
  private trafficCtxGame: EchoLifeGame | null = null;
  private trafficCtxCrowd: readonly { x: number; z: number }[] = [];
  private trafficCtxDist = 0;
  private readonly trafficClearCheck = (at: { x: number; z: number }): boolean => {
    if (this.trafficCtxDist > 40) return true;
    if (Math.hypot(at.x - this.trafficCtxPlayerX, at.z - this.trafficCtxPlayerZ) < 1.25) return false;
    for (let j = 0; j < this.namedPosCount; j++) {
      if (Math.hypot(this.namedPosX[j] - at.x, this.namedPosZ[j] - at.z) < 1.1) return false;
    }
    const crowd = this.trafficCtxCrowd;
    for (let j = 0; j < crowd.length; j++) {
      if (Math.hypot(crowd[j].x - at.x, crowd[j].z - at.z) < 0.85) return false;
    }
    const g = this.trafficCtxGame;
    if (g) {
      const car = g.car;
      if (car.spec && Math.hypot(car.pose.x - at.x, car.pose.z - at.z) < car.spec.collisionRadius + 1) return false;
      const tw = g.twoWheeler;
      if (tw.spec && Math.hypot(tw.pose.x - at.x, tw.pose.z - at.z) < tw.spec.collisionRadius + 1) return false;
    }
    return true;
  };

  stats = { skinned: 0, impostors: 0, models: 0, crowd: 0, spots: 0 };
  /** The learner's own bicycle (the staged Codex `bicycle`), parked or under the rider. */
  private bike: T.Group | null = null;
  private bikeGltf: GLTF | null = null;
  private bikeVisualRig: VehicleVisualRig | null = null;
  private bikeSockets: VehicleRigSockets | null = null;
  private readonly bikeRiderCtrl = new RiderIkController();
  private bikeLastState: RiderKinematicState | null = null;
  private prevBikeYaw = 0;
  private prevBikeSpeed = 0;
  private prevBikeX = 0;
  private prevBikeZ = 0;
  private bikePosSeeded = false;
  private bikeWheelSpin = 0;
  private bikeYawSeeded = false;
  private bikePrewarmReady = false;
  private vehiclesSyncedAtTime = -1;
  private readonly lastTrafficClock = new Float64Array(16).fill(-1);
  readonly basketball = new Basketball(this.group);
  readonly market = new MarketStock(this.group);
  private trafficViews: RoadVehicleView[] = [];
  private vehicles = {
    car: new RoadVehicleView(this.group, false, true),
    twoWheeler: new RoadVehicleView(this.group, true, true),
  };
  get carRig() { return this.vehicles.car.rig; }
  get twoWheelerRig() { return this.vehicles.twoWheeler.rig; }
  get starterBikeGroup() { return this.bike; }
  get starterBikeSockets() { return this.bikeSockets; }
  get starterBikeController() { return this.bikeRiderCtrl; }
  get starterBikeState() { return this.bikeLastState; }
  vehicleReady(kind: 'car' | 'twoWheeler', model?: string) {
    const view = this.vehicles[kind];
    return view.model === model && !!view.rig;
  }
  private bikeLoading = false;
  private bikeLoadPromise: Promise<void> | null = null;
  private winterTemplates = new Map<WinterRigKind, GLTF>();
  private winterBytes = new Map<WinterRigKind, number>();
  private winterLoading = new Set<WinterRigKind>();
  private winterIdleClock = 0;
  private winterGen = 0;

  private npcResKey(model: string): string {
    return `${this.resPrefix}:npc:${model}`;
  }

  private winterResKey(kind: WinterRigKind): string {
    return `${this.resPrefix}:winter:${kind}`;
  }

  private ensureWinterTemplates(): void {
    const gen = this.winterGen;
    for (const kind of ['codex52Female', 'codex52Male', 'echo59'] as const) {
      if (this.winterTemplates.has(kind) || this.winterLoading.has(kind)) continue;
      this.winterLoading.add(kind);
      void loader
        .loadAsync(WAVE11_WINTER_NPC_URLS[kind])
        .then((gltf) => {
          if (this.disposed || gen !== this.winterGen) {
            disposeGltf(gltf);
            this.winterLoading.delete(kind);
            return;
          }
          const bytes = Math.max(384 * 1024, estimateObjectGpuBytes(gltf.scene));
          this.winterTemplates.set(kind, gltf);
          this.winterBytes.set(kind, bytes);
          let activeRefs = 0;
          for (const b of this.bodies.values()) {
            if (b.winterActive && b.winterKind === kind) activeRefs++;
          }
          getEchoLifeResidencyManager().register({
            key: this.winterResKey(kind),
            category: 'npc',
            estimatedBytes: bytes,
            initialRefs: activeRefs,
            minRetentionSec: 60,
            dispose: () => this.evictWinterTemplate(kind),
          });
        })
        .catch(() => {
          this.winterLoading.delete(kind);
        });
    }
  }

  /**
   * Governed strictly by `EchoLifeResidencyManager` (`minRetentionSec: 60`) AND guarded against
   * in-flight shader compilations (`getInFlightCompileCount() === 0`).
   */
  private evictWinterTemplate(kind: WinterRigKind): void {
    if (this.disposed) return;
    const tpl = this.winterTemplates.get(kind);
    if (!tpl) return;
    let activeRefs = 0;
    for (const b of this.bodies.values()) {
      if (b.winterActive && b.winterKind === kind) activeRefs++;
    }
    if (activeRefs > 0 || getInFlightCompileCount() > 0) {
      getEchoLifeResidencyManager().register({
        key: this.winterResKey(kind),
        category: 'npc',
        estimatedBytes: this.winterBytes.get(kind) ?? 384 * 1024,
        initialRefs: activeRefs,
        minRetentionSec: 60,
        dispose: () => this.evictWinterTemplate(kind),
      });
      return;
    }
    for (const b of this.bodies.values()) {
      if (b.winterKind !== kind || !b.winterGroup) continue;
      b.winterGroup.removeFromParent();
      for (const wm of b.winterMeshes) {
        if (wm.skeleton) wm.skeleton.dispose();
        const idx = b.shadowMeshes.indexOf(wm);
        if (idx >= 0) b.shadowMeshes.splice(idx, 1);
      }
      for (const mt of b.winterMaterials) mt.dispose();
      b.winterGroup = null;
      b.winterMeshes = [];
      b.winterMaterials = [];
    }
    disposeGltf(tpl);
    this.winterTemplates.delete(kind);
    this.winterBytes.delete(kind);
    this.winterLoading.delete(kind);
  }

  /** Builds a filtered index buffer removing triangles weighted to covered torso/arm/leg bones while keeping Head/Neck/Hands 100% visible. */
  private buildMaskedSkinIndex(target: SkinMaskTarget): void {
    if (target.built) return;
    target.built = true;
    const mesh = target.mesh;
    const geom = mesh.geometry;
    const skinIndex = geom.getAttribute('skinIndex');
    const skinWeight = geom.getAttribute('skinWeight');
    if (!skinIndex || !skinWeight || !mesh.skeleton) return;

    const bones = mesh.skeleton.bones;
    const boneMask = new Uint8Array(bones.length); // 1 = masked (arm/leg/torso), 0 = keep visible (head/neck/hand)
    for (let i = 0; i < bones.length; i++) {
      const b = bones[i];
      const bn = (b.userData.name as string | undefined) ?? b.name;
      if (KEEP_VISIBLE_SKIN_BONE_RE.test(bn)) {
        boneMask[i] = 0;
      } else if (MASKED_LIMB_BONE_RE.test(bn)) {
        boneMask[i] = 1;
      }
    }

    const posCount = geom.getAttribute('position')?.count ?? 0;
    const vertMasked = new Uint8Array(posCount);
    for (let v = 0; v < posCount; v++) {
      let coveredW = 0;
      let keepW = 0;
      for (let k = 0; k < 4; k++) {
        const w = skinWeight.getComponent(v, k);
        if (w <= 0) continue;
        const bi = skinIndex.getComponent(v, k);
        if (bi < bones.length && boneMask[bi] === 1) coveredW += w;
        else keepW += w;
      }
      if (coveredW >= 0.45 && coveredW > keepW) vertMasked[v] = 1;
    }

    const orig = geom.index;
    const srcArr: ArrayLike<number> = orig ? orig.array : Array.from({ length: posCount }, (_, i) => i);
    const kept: number[] = [];
    for (let i = 0; i < srcArr.length; i += 3) {
      const a = srcArr[i], bIdx = srcArr[i + 1], c = srcArr[i + 2];
      // Drop triangle if majority/any limb-only vertices belong to covered limbs
      if (vertMasked[a] && vertMasked[bIdx] && vertMasked[c]) continue;
      if ((vertMasked[a] + vertMasked[bIdx] + vertMasked[c]) >= 2) continue;
      kept.push(a, bIdx, c);
    }

    target.origIndex = orig ? orig : new T.Uint32BufferAttribute(Array.from({ length: posCount }, (_, i) => i), 1);
    target.maskedIndex =
      posCount <= 65535
        ? new T.Uint16BufferAttribute(kept, 1)
        : new T.Uint32BufferAttribute(kept, 1);
  }

  /** Lazily clones & rebinds matching Wave 11 winter outerwear directly onto an NPC's live Skeleton (P0 Veto Gate #5). */
  private ensureBodyWinterOverlay(b: Body): boolean {
    if (b.winterGroup) return true;
    const tpl = this.winterTemplates.get(b.winterKind);
    if (!tpl) return false;

    const hash = hashKey(b.key);
    const coatHex = WINTER_COAT_WOOL_PALETTE[hash % WINTER_COAT_WOOL_PALETTE.length];
    const scarfHex = WINTER_SCARF_PALETTE[(hash >>> 3) % WINTER_SCARF_PALETTE.length];
    const trouserHex = WINTER_TROUSERS_PALETTE[(hash >>> 6) % WINTER_TROUSERS_PALETTE.length];
    const bootHex = WINTER_BOOTS_PALETTE[(hash >>> 9) % WINTER_BOOTS_PALETTE.length];

    const grp = new T.Group();
    grp.name = `WinterOuterwear_${b.winterKind}`;
    const meshes: T.SkinnedMesh[] = [];
    const mats: T.Material[] = [];
    const low = this.quality === 'low';
    const cfg = RENDER_CONFIGS[this.quality];
    const castNpcs = cfg.shadow.enabled && cfg.shadow.castNpcs;
    const receiveNpcs = cfg.shadow.enabled;

    tpl.scene.traverse((o) => {
      const src = o as T.SkinnedMesh;
      if (!src.isSkinnedMesh || !src.skeleton) return;
      const boundBones: T.Bone[] = [];
      let allFound = true;
      for (let i = 0; i < src.skeleton.bones.length; i++) {
        const sb = src.skeleton.bones[i];
        const bName = (sb.userData.name as string | undefined) ?? sb.name;
        const liveBone = b.boneMap.get(bName) ?? b.boneMap.get(sb.name);
        if (!liveBone) {
          allFound = false;
          break;
        }
        boundBones.push(liveBone);
      }
      if (!allFound) return;

      const srcMat = Array.isArray(src.material) ? src.material[0] : src.material;
      const rawName = `${src.name} ${srcMat?.name ?? ''}`;
      const isScarf = /WinterScarf|scarf/i.test(rawName);
      const isTrousers = /WinterTrousers|trouser/i.test(rawName);
      const isBoots = /WinterBoots|boot/i.test(rawName);
      const tintHex = isScarf ? scarfHex : isTrousers ? trouserHex : isBoots ? bootHex : coatHex;
      const stdSrc = srcMat instanceof T.MeshStandardMaterial ? srcMat : null;

      let mat: T.Material;
      if (low) {
        mat = new T.MeshStandardMaterial({
          name: `PBR_Winter_${srcMat?.name || src.name}`,
          map: stdSrc?.map ?? null,
          color: new T.Color(tintHex),
          vertexColors: true,
          roughness: isBoots ? 0.44 : isScarf ? 0.92 : 0.88,
          metalness: isBoots ? 0.04 : 0,
          envMapIntensity: isBoots ? 0.55 : 0.42,
          side: T.FrontSide,
        });
      } else if (isBoots) {
        mat = new T.MeshPhysicalMaterial({
          name: `PBR_Winter_${srcMat?.name || 'WinterBoots'}`,
          map: stdSrc?.map ?? null,
          color: new T.Color(tintHex),
          vertexColors: true,
          roughness: 0.40,
          metalness: 0.03,
          clearcoat: 0.22,
          clearcoatRoughness: 0.36,
          envMapIntensity: 0.62,
          side: T.FrontSide,
        });
      } else {
        const wool = new T.MeshPhysicalMaterial({
          name: `PBR_Winter_${srcMat?.name || 'WinterCoat'}`,
          map: stdSrc?.map ?? null,
          color: new T.Color(tintHex),
          vertexColors: true,
          roughness: isScarf ? 0.94 : 0.88,
          metalness: 0,
          sheen: isScarf ? 0.52 : 0.36,
          sheenRoughness: 0.78,
          sheenColor: new T.Color(tintHex).lerp(new T.Color('#ffffff'), 0.28),
          envMapIntensity: 0.46,
          side: T.FrontSide,
        });
        applyClothAaaShader(wool, tintHex, { allowWinterTint: false });
        mat = wool;
      }

      const skel = new T.Skeleton(
        boundBones,
        src.skeleton.boneInverses.map((m) => m.clone()),
      );
      const mesh = new T.SkinnedMesh(src.geometry, mat);
      mesh.name = src.name;
      mesh.bindMode = src.bindMode;
      mesh.bind(skel, src.bindMatrix);
      mesh.frustumCulled = true;
      if (!mesh.geometry.boundingSphere || mesh.geometry.boundingSphere.radius < 1.8) {
        mesh.geometry.boundingSphere = new T.Sphere(new T.Vector3(0, 0.95, 0), 1.9);
      }
      mesh.castShadow = castNpcs && b.castingShadow;
      mesh.receiveShadow = receiveNpcs;
      grp.add(mesh);
      meshes.push(mesh);
      mats.push(mat);
      b.shadowMeshes.push(mesh);
    });

    if (meshes.length === 0) return false;
    grp.visible = false;
    b.root.add(grp);
    b.dirtySkeleton.registerRoot(grp);
    b.winterGroup = grp;
    b.winterMeshes = meshes;
    b.winterMaterials = mats;
    return true;
  }

  /** Toggles an NPC cleanly between winter outerwear mesh swap + bare-limb masking and original summer outfit. */
  private setBodyWinterState(b: Body, wantWinter: boolean): void {
    if (wantWinter === b.winterActive) return;
    if (wantWinter) {
      if (!this.ensureBodyWinterOverlay(b)) return;
      b.winterActive = true;
      getEchoLifeResidencyManager().acquire(this.winterResKey(b.winterKind));
      if (b.winterGroup) b.winterGroup.visible = true;
      for (let i = 0; i < b.summerClothingMeshes.length; i++) {
        b.summerClothingMeshes[i].visible = false;
      }
      for (let i = 0; i < b.skinMaskTargets.length; i++) {
        const target = b.skinMaskTargets[i];
        this.buildMaskedSkinIndex(target);
        if (target.maskedIndex) target.mesh.geometry.setIndex(target.maskedIndex);
      }
    } else {
      b.winterActive = false;
      getEchoLifeResidencyManager().release(this.winterResKey(b.winterKind));
      if (b.winterGroup) b.winterGroup.visible = false;
      for (let i = 0; i < b.summerClothingMeshes.length; i++) {
        b.summerClothingMeshes[i].visible = true;
      }
      for (let i = 0; i < b.skinMaskTargets.length; i++) {
        const target = b.skinMaskTargets[i];
        if (target.origIndex) target.mesh.geometry.setIndex(target.origIndex);
      }
    }
  }

  constructor(public quality: GameViewQuality) {
    this.group.name = 'echo-life-people';
    const body = buildImpostorBodyGeometry();
    const head = new T.SphereGeometry(0.115, 10, 8);
    const bodyMat = new T.MeshStandardMaterial({ roughness: 0.84, metalness: 0 });
    const headMat = new T.MeshStandardMaterial({ color: '#d8ad8b', roughness: 0.64, metalness: 0 });
    this.bodyMesh = new T.InstancedMesh(body, bodyMat, 140);
    this.headMesh = new T.InstancedMesh(head, headMat, 140);
    for (const m of [this.bodyMesh, this.headMesh]) {
      m.count = 0;
      m.visible = false;
      m.castShadow = false;
      m.receiveShadow = true;
      this.group.add(m);
    }
    // Single-draw-call instanced rain umbrellas (canopy + handle shaft, gripped at local y=0 by hand.R!).
    const umbGeo = buildUmbrellaGeometry();
    this.umbrellaMesh = new T.InstancedMesh(
      umbGeo,
      new T.MeshStandardMaterial({ color: '#ffffff', roughness: 0.55, side: T.DoubleSide }),
      48,
    );
    this.umbrellaMesh.count = 0;
    this.umbrellaMesh.visible = false;
    this.umbrellaMesh.castShadow = false;
    this.group.add(this.umbrellaMesh);
    // Single-draw-call soft contact shadow blobs active on Low quality when shadowMap is off.
    const blobGeo = new T.CircleGeometry(0.48, 12);
    blobGeo.rotateX(-Math.PI / 2);
    this.contactShadows = new T.InstancedMesh(
      blobGeo,
      new T.MeshBasicMaterial({ color: '#0a1420', transparent: true, opacity: 0.34, depthWrite: false }),
      64,
    );
    this.contactShadows.count = 0;
    this.contactShadows.visible = false;
    this.contactShadows.renderOrder = 1;
    this.group.add(this.contactShadows);
    // Grounded floor rings for non-anchored hotspots (floating yellow octahedron gems removed for natural visuals).
    const ring = new T.RingGeometry(0.32, 0.38, 32);
    ring.rotateX(-Math.PI / 2);
    this.rings = new T.InstancedMesh(
      ring,
      new T.MeshBasicMaterial({ color: '#fff3c2', transparent: true, opacity: 0.42, depthWrite: false }),
      96,
    );
    this.rings.count = 0;
    this.rings.visible = false;
    this.group.add(this.rings);
    this.focusRing = new T.Mesh(
      new T.RingGeometry(0.42, 0.5, 40).rotateX(-Math.PI / 2),
      new T.MeshBasicMaterial({ color: '#7fe3ff', transparent: true, opacity: 0.85, depthWrite: false }),
    );
    this.focusRing.visible = false;
    this.group.add(this.focusRing);

    // Generous static bounding spheres set ONCE at creation — zero per-frame computeBoundingSphere() overhead on 4x CPU.
    const worldSphere = new T.Sphere(new T.Vector3(0, 0, 0), 420);
    for (const m of [this.bodyMesh, this.headMesh, this.umbrellaMesh, this.contactShadows, this.rings]) {
      m.boundingSphere = worldSphere.clone();
      m.frustumCulled = false;
    }
  }

  /** Live 4-tier quality control (`ultra` | `high` | `balanced` | `low`), honoring `renderConfig.shadow.castNpcs`. */
  setQuality(tier: GameViewQuality) {
    this.quality = tier;
    const cfg = RENDER_CONFIGS[tier];
    const castNpcs = cfg.shadow.enabled && cfg.shadow.castNpcs;
    const receiveNpcs = cfg.shadow.enabled;
    for (const b of this.bodies.values()) {
      b.root.traverse((o) => {
        const mesh = o as T.Mesh;
        if (!mesh.isMesh) return;
        const isEye = /^Cast_Eyes|^Eyes/i.test(mesh.name);
        mesh.receiveShadow = isEye ? false : receiveNpcs;
        if (!castNpcs) mesh.castShadow = false;
      });
      if (!castNpcs) {
        b.castingShadow = false;
      } else {
        for (let i = 0; i < b.shadowMeshes.length; i++) b.shadowMeshes[i].castShadow = b.castingShadow;
      }
    }
  }

  private get maxSkinned() {
    return RENDER_CONFIGS[this.quality].crowd.maxNamedSkinned;
  }
  private get maxCrowdSkinned() {
    return RENDER_CONFIGS[this.quality].crowd.maxCrowdSkinned;
  }
  private get maxCrowdSkinnedDist() {
    return this.quality === 'ultra' ? 36 : this.quality === 'high' ? 30 : this.quality === 'balanced' ? 22 : 16;
  }
  private get materialQuality(): CharacterQuality {
    return this.quality === 'ultra' ? 'high' : this.quality;
  }

  private acquireNearActor(idx: number): NearActor {
    if (idx < this.nearPool.length) return this.nearPool[idx];
    const entry: NearActor = {
      key: '',
      model: '',
      x: 0,
      y: 0,
      z: 0,
      standX: 0,
      standZ: 0,
      yaw: 0,
      act: 'idle',
      d: 0,
      named: false,
      seated: false,
      onBench: false,
      cushion: undefined,
      outdoor: true,
      inDialogue: false,
      speaking: false,
      speechText: null,
      mood: 'neutral',
      lookTarget: null,
      facingId: null,
      rainUmbrella: undefined,
      umbrellaColorIdx: 0,
      ridingVehicleIdx: -1,
    };
    this.nearPool.push(entry);
    return entry;
  }

  private ensurePack48() {
    if (this.pack48 || this.pack48Loading) return;
    this.pack48Loading = true;
    void loadEcho48Pack().then((pack) => {
      if (this.disposed || !pack) return;
      this.pack48 = pack;
      for (const b of this.bodies.values()) {
        b.animator.bindPack(pack);
      }
    });
  }

  private load(model: string): Promise<GLTF | null> {
    this.ensurePack48();
    let p = this.gltfs.get(model);
    if (!p) {
      p = loader
        .loadAsync(LIFE_PEOPLE[model])
        .then((gltf) => {
          if (this.disposed) {
            disposeGltf(gltf);
            return null;
          }
          // One-time load-time MakeHuman oral-mucosa recess on Codex52 templates (0 extra VRAM, fixes all 22 residents)
          sanitizeCodex52OralMorphs(gltf.scene);
          const box = new T.Box3().setFromObject(gltf.scene),
            h = box.max.y - box.min.y;
          const scale = h > 0.2 && (h > 2.15 || h < 1.25) ? 1.66 / h : 1;
          const bytes = Math.max(512 * 1024, estimateObjectGpuBytes(gltf.scene));
          this.ready.set(model, { gltf, scale, used: this.time, bytes });
          let activeRefs = 0;
          for (const b of this.bodies.values()) {
            if (b.model === model) activeRefs++;
          }
          getEchoLifeResidencyManager().register({
            key: this.npcResKey(model),
            category: 'npc',
            estimatedBytes: bytes,
            initialRefs: activeRefs,
            minRetentionSec: 60,
            dispose: () => this.evictNpcTemplate(model),
          });
          return gltf;
        })
        .catch(() => null);
      this.gltfs.set(model, p);
    }
    return p;
  }

  /**
   * Governed strictly by `EchoLifeResidencyManager` (`minRetentionSec: 60`) AND guarded against
   * in-flight shader compilations (`getInFlightCompileCount() === 0`).
   */
  private evictNpcTemplate(model: string): void {
    if (this.disposed) return;
    const r = this.ready.get(model);
    if (!r) return;
    let activeRefs = 0;
    for (const b of this.bodies.values()) {
      if (b.model === model) activeRefs++;
    }
    if (activeRefs > 0 || getInFlightCompileCount() > 0) {
      getEchoLifeResidencyManager().register({
        key: this.npcResKey(model),
        category: 'npc',
        estimatedBytes: r.bytes,
        initialRefs: activeRefs,
        minRetentionSec: 60,
        dispose: () => this.evictNpcTemplate(model),
      });
      return;
    }
    disposeGltf(r.gltf);
    this.ready.delete(model);
    this.gltfs.delete(model);
  }

  private body(key: string, model: string, allowSpawn: boolean): { body: Body | null; spawned: boolean } {
    const have = this.bodies.get(key);
    if (have) {
      if (have.model === model) return { body: have, spawned: false };
      this.drop(key);
    }
    const r = this.ready.get(model);
    if (!r) {
      void this.load(model);
      return { body: null, spawned: false };
    }
    // Time-slice SkeletonUtils.clone() to at most 1 newly-spawned skinned NPC per frame (prevents 4x-CPU Long Tasks).
    if (!allowSpawn) return { body: null, spawned: false };

    r.used = this.time;
    const root = cloneSkinned(r.gltf.scene);
    root.scale.setScalar(r.scale);

    // Honor `renderConfig.shadow.castNpcs` so Balanced/Low omit expensive skinned NPC shadow draws!
    const cfg = RENDER_CONFIGS[this.quality];
    const castNpcs = cfg.shadow.enabled && cfg.shadow.castNpcs;
    const receiveNpcs = cfg.shadow.enabled;
    const pbr = upgradeCharacterMaterials(root, {
      quality: this.materialQuality,
      castShadow: castNpcs,
      receiveShadow: receiveNpcs,
      vertexHairSway: true,
      actorKey: key,
    });

    const shadowMeshes: T.Mesh[] = [];
    const microDetailMeshes: T.Mesh[] = [];
    const summerClothingMeshes: T.Mesh[] = [];
    const backpackMeshes: T.Mesh[] = [];
    const skinMaskTargets: SkinMaskTarget[] = [];
    const ownedGeometries: T.BufferGeometry[] = [];
    const boneMap = new Map<string, T.Bone>();
    let hasLowercaseHips = false;
    let hips: T.Bone | undefined;
    let head: T.Bone | undefined;
    let thighL: T.Bone | undefined;
    let shinL: T.Bone | undefined;
    let footL: T.Bone | undefined;
    let toeL: T.Bone | undefined;
    let thighR: T.Bone | undefined;
    let shinR: T.Bone | undefined;
    let footR: T.Bone | undefined;
    let toeR: T.Bone | undefined;
    let upperArmR: T.Bone | undefined;
    let forearmR: T.Bone | undefined;
    let handR: T.Bone | undefined;

    root.traverse((o) => {
      if ((o as T.Bone).isBone) {
        const bone = o as T.Bone;
        const n = (bone.userData.name as string | undefined) ?? bone.name;
        boneMap.set(n, bone);
        if (bone.name !== n) boneMap.set(bone.name, bone);
        if (n === 'hips') hasLowercaseHips = true;
        if (!hips && /^(?:hips|pelvis)$/i.test(n)) hips = bone;
        else if (!head && /^head$/i.test(n)) head = bone;
        else if (!thighL && /^(?:thigh[._]?L|LeftUpLeg)$/i.test(n)) thighL = bone;
        else if (!shinL && /^(?:shin[._]?L|LeftLeg)$/i.test(n)) shinL = bone;
        else if (!footL && /^(?:foot[._]?L|LeftFoot)$/i.test(n)) footL = bone;
        else if (!toeL && /^(?:toe[._]?L|LeftToeBase)$/i.test(n)) toeL = bone;
        else if (!thighR && /^(?:thigh[._]?R|RightUpLeg)$/i.test(n)) thighR = bone;
        else if (!shinR && /^(?:shin[._]?R|RightLeg)$/i.test(n)) shinR = bone;
        else if (!footR && /^(?:foot[._]?R|RightFoot)$/i.test(n)) footR = bone;
        else if (!toeR && /^(?:toe[._]?R|RightToeBase)$/i.test(n)) toeR = bone;
        else if (!upperArmR && /^(?:upper_arm[._]?R|RightArm)$/i.test(n)) upperArmR = bone;
        else if (!forearmR && /^(?:forearm[._]?R|RightForeArm)$/i.test(n)) forearmR = bone;
        else if (!handR && /^(?:hand[._]?R|RightHand)$/i.test(n)) handR = bone;
      }
      const mesh = o as T.Mesh;
      if (mesh.isMesh) {
        const mat0 = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        const matName = mat0?.name ?? '';
        const micro =
          /^Cast_Eyes|^Eyes|^Runner_Hands/i.test(mesh.name) || isShadowMicroDetailMesh(mesh.name, matName);
        if (micro) {
          mesh.castShadow = false;
          if (!/^Runner_Hands/i.test(mesh.name)) microDetailMeshes.push(mesh);
        } else {
          shadowMeshes.push(mesh);
          mesh.castShadow = castNpcs;
        }
        if (BACKPACK_MESH_RE.test(mesh.name) || BACKPACK_MESH_RE.test(matName)) {
          backpackMeshes.push(mesh);
        }
        if (
          (SUMMER_CLOTHING_RE.test(mesh.name) || SUMMER_CLOTHING_RE.test(matName)) &&
          !/^Hair|^Cast_Hair|^Face|^Eyes|^Brows/i.test(mesh.name)
        ) {
          summerClothingMeshes.push(mesh);
        }
      }
      const sm = o as T.SkinnedMesh;
      if (sm.isSkinnedMesh) {
        const mat0 = Array.isArray(sm.material) ? sm.material[0] : sm.material;
        const matName = mat0?.name ?? '';
        if (
          BARE_SKIN_MASK_RE.test(sm.name) ||
          BARE_SKIN_MASK_RE.test(matName) ||
          /^PBR_Skin_(?:skin|Mat_Skin_)/i.test(matName)
        ) {
          // Clone geometry once so index-buffer winter bare-limb masking never mutates shared template geometry!
          const clonedGeo = sm.geometry.clone();
          sm.geometry = clonedGeo;
          ownedGeometries.push(clonedGeo);
          skinMaskTargets.push({ mesh: sm, origIndex: clonedGeo.index, maskedIndex: null, built: false });
        }
        // Inflate local bounding sphere once so frustum culling discards off-camera actors cleanly without pop-out.
        if (!sm.geometry.boundingSphere) sm.geometry.computeBoundingSphere();
        if (sm.geometry.boundingSphere && sm.geometry.boundingSphere.radius < 1.8) {
          sm.geometry.boundingSphere = new T.Sphere(new T.Vector3(0, 0.95, 0), 1.9);
        }
        sm.frustumCulled = true;
      }
    });

    const winterKind: WinterRigKind = hasLowercaseHips
      ? 'echo59'
      : CODEX52_MALE_MODELS.has(model)
        ? 'codex52Male'
        : 'codex52Female';

    // Measure calibrated rest ankle sole clearance (accounting for any mesh sole below y=0, e.g. `minh` -25.3 mm!)
    // and rest foot local axes once at spawn time so `legIk.ts` keeps every resident's shoes flush on ground.
    root.position.set(0, 0, 0);
    root.rotation.set(0, 0, 0);
    root.updateWorldMatrix(true, true);
    const modelBox = new T.Box3().setFromObject(root);
    const soleMinY = Number.isFinite(modelBox.min.y) ? modelBox.min.y : 0;
    const footRestYL = footL ? Math.max(0.055, footL.getWorldPosition(this.tmpV).y - soleMinY) : 0.085;
    const footRestYR = footR ? Math.max(0.055, footR.getWorldPosition(this.tmpV).y - soleMinY) : 0.085;

    const footForwardLocalL = new T.Vector3(0, 0, 1);
    const footUpLocalL = new T.Vector3(0, 1, 0);
    if (footL) {
      footL.getWorldQuaternion(_ikQ1).invert();
      footForwardLocalL.set(0, 0, 1).applyQuaternion(_ikQ1).normalize();
      footUpLocalL.set(0, 1, 0).applyQuaternion(_ikQ1).normalize();
    }
    const footForwardLocalR = new T.Vector3(0, 0, 1);
    const footUpLocalR = new T.Vector3(0, 1, 0);
    if (footR) {
      footR.getWorldQuaternion(_ikQ1).invert();
      footForwardLocalR.set(0, 0, 1).applyQuaternion(_ikQ1).normalize();
      footUpLocalR.set(0, 1, 0).applyQuaternion(_ikQ1).normalize();
    }
    const toeRestQL = toeL ? toeL.quaternion.clone() : new T.Quaternion();
    const toeRestQR = toeR ? toeR.quaternion.clone() : new T.Quaternion();

    const ikSavedQ = new Map<T.Bone, T.Quaternion>();
    for (const kb of [thighL, shinL, footL, toeL, thighR, shinR, footR, toeR, upperArmR, forearmR, handR]) {
      if (kb) ikSavedQ.set(kb, kb.quaternion.clone());
    }

    // E5-04 [P0]: Bind rider skeleton on pure rest-pose `root` BEFORE `CharacterAnimator` poses any bones!
    const riderSkel = bindRiderSkeleton(root);

    // Cross-rig 48-clip animator (rest-pose signature cached, Dead-Blending inertializer & Motion Matching)
    const animator = new CharacterAnimator(root, r.gltf.animations, key);
    if (this.pack48) animator.bindPack(this.pack48);

    // Expanded FACS micro-life & facial presence (asymmetric blinks, saccades, eyelid-gaze, 6-viseme lip-sync)
    const life = new CharacterLife(root, key);
    // Optional XPBD secondary hair/cloth solver (activates automatically if model carries hair/scarf bones)
    const secondary = new SecondaryPhysics(root, key);
    const dirtySkeleton = bindDirtyGatedSkeleton(root);

    const b: Body = {
      key,
      model,
      root,
      animator,
      life,
      secondary,
      dirtySkeleton,
      riderSkel,
      ownedMaterials: pbr.materials,
      ownedGeometries,
      shadowMeshes,
      microDetailMeshes,
      microHidden: false,
      summerClothingMeshes,
      backpackMeshes,
      hasBackpack: backpackMeshes.length > 0,
      backpackHidden: false,
      skinMaskTargets,
      boneMap,
      winterKind,
      winterGroup: null,
      winterMeshes: [],
      winterMaterials: [],
      winterActive: false,
      castingShadow: castNpcs,
      debt: 0,
      seen: this.time,
      initialized: false,
      wasInView: false,
      yaw: 0,
      prevX: 0,
      prevZ: 0,
      prevYaw: 0,
      hips,
      head,
      thighL,
      shinL,
      footL,
      toeL,
      thighR,
      shinR,
      footR,
      toeR,
      upperArmR,
      forearmR,
      handR,
      toeRestQL,
      toeRestQR,
      footForwardLocalL,
      footUpLocalL,
      footForwardLocalR,
      footUpLocalR,
      footRestYL,
      footRestYR,
      hasFootIkRest: !!(hips && thighL && shinL && footL && thighR && shinR && footR),
      ikSavedQ,
      ikSavedHipsY: hips ? hips.position.y : 0,
      ikDirty: false,
      footLockL: createNpcFootLockState(),
      footLockR: createNpcFootLockState(),
      pelvisSpring: new PelvisVerticalSpring(),
      stairTreadBlend: 0,
      seatAnchorX: 0,
      seatAnchorZ: 0,
      seatStandX: 0,
      seatStandZ: 0,
      seatYaw: 0,
      seatTopY: 0,
      hasSeatMemory: false,
      seatPhase: 'none',
      seatPhaseTimer: 0,
      wasSeatedInView: false,
    };
    this.group.add(root);
    this.bodies.set(key, b);
    getEchoLifeResidencyManager().acquire(this.npcResKey(model));
    return { body: b, spawned: true };
  }

  private drop(key: string) {
    const b = this.bodies.get(key);
    if (!b) return;
    const residency = getEchoLifeResidencyManager();
    if (b.winterActive) {
      residency.release(this.winterResKey(b.winterKind));
    }
    residency.release(this.npcResKey(b.model));
    if (b.riderSkel) restoreRiderSkeleton(b.riderSkel);
    b.dirtySkeleton.dispose();
    b.animator.dispose();
    for (const mat of b.ownedMaterials) mat.dispose();
    for (const mat of b.winterMaterials) mat.dispose();
    for (const geo of b.ownedGeometries) geo.dispose();
    b.root.removeFromParent();
    // Each SkeletonUtils.clone owns independent Skeleton instances and GPU bone DataTextures; free them with the clone.
    disposeSkeletons(b.root);
    this.bodies.delete(key);
  }

  /** Restores any Tier-0 leg/arm/rider IK writes before the next animation mixer pass (zero compounding drift). */
  private restoreBodyIk(b: Body): void {
    if (b.riderSkel) restoreRiderSkeleton(b.riderSkel);
    if (!b.ikDirty) return;
    for (const [bone, q] of b.ikSavedQ) bone.quaternion.copy(q);
    if (b.hips) b.hips.position.y = b.ikSavedHipsY;
    b.ikDirty = false;
  }

  private captureBodyIk(b: Body): void {
    for (const [bone, q] of b.ikSavedQ) q.copy(bone.quaternion);
    if (b.hips) b.ikSavedHipsY = b.hips.position.y;
  }

  /**
   * Swing-safe 2-bone stance foot-lock, ramp/stair normal roll & critically damped pelvis stabilizer (`legIk.ts`).
   * Uses `walk.sampleFootSupport` (zero Rapier raycasts, zero heap allocations), locks stance feet at ALL speeds
   * (`<= 2.8 cm` leash), and preserves 100% of swing-phase foot lift (`0` `-18.6 cm` swing crouch!).
   */
  private applyNpcFootGroundIk(
    b: Body,
    walk: LifeWalk,
    dt: number,
    actorSpeed: number,
    yawRate: number,
    reduced: boolean,
  ): void {
    if (!b.hasFootIkRest || !b.hips || !b.thighL || !b.shinL || !b.footL || !b.thighR || !b.shinR || !b.footR) return;
    b.root.updateWorldMatrix(true, true);
    const scale = Math.max(0.5, b.root.scale.y || 1);
    const invGroupM = this.tmpM.copy(this.group.matrixWorld).invert();

    // Smoothly blend between ramp inclination while walking (`>= 0.55 m/s`) and flat horizontal treads when stopped (`<= 0.12 m/s`)
    const wantTread = actorSpeed <= 0.12 ? 1 : actorSpeed >= 0.55 ? 0 : 1 - (actorSpeed - 0.12) / 0.43;
    b.stairTreadBlend += (wantTread - b.stairTreadBlend) * (dt > 0 ? 1 - Math.exp(-12 * dt) : 1);

    // Read animated foot positions & world orientations
    b.footL.getWorldPosition(this.tmpV).applyMatrix4(invGroupM);
    const lx = this.tmpV.x, ly = this.tmpV.y, lz = this.tmpV.z;
    b.footL.getWorldQuaternion(_animFootQuatL);

    b.footR.getWorldPosition(this.tmpV2).applyMatrix4(invGroupM);
    const rx = this.tmpV2.x, ry = this.tmpV2.y, rz = this.tmpV2.z;
    b.footR.getWorldQuaternion(_animFootQuatR);

    const rootY = b.root.position.y;
    const supL = walk.sampleFootSupport(lx, lz, b.stairTreadBlend, _footSupportL, rootY);
    const supR = walk.sampleFootSupport(rx, rz, b.stairTreadBlend, _footSupportR, rootY);
    if (!supL && !supR) {
      b.pelvisSpring.relax(dt, scale, reduced);
      return;
    }

    const stance = b.animator.getStanceWeights();
    const hoverBiasY = b.animator.getHoverBiasY();

    sampleStanceFootTarget(
      b.footLockL,
      {
        animX: lx,
        animY: ly - hoverBiasY,
        animZ: lz,
        groundY: supL ? supL.y : null,
        rootY,
        footRestY: b.footRestYL,
        stanceWeight: stance.stanceL,
        yawRate,
        dt,
        scale,
      },
      _stanceOutL,
    );

    sampleStanceFootTarget(
      b.footLockR,
      {
        animX: rx,
        animY: ry - hoverBiasY,
        animZ: rz,
        groundY: supR ? supR.y : null,
        rootY,
        footRestY: b.footRestYR,
        stanceWeight: stance.stanceR,
        yawRate,
        dt,
        scale,
      },
      _stanceOutR,
    );

    // Critically damped pelvis stabilization (stance-only step-down + residual hover removal; 0 swing crouch!)
    const targetPelvisOffset =
      Math.min(_stanceOutL.pelvisDropRequest, _stanceOutR.pelvisDropRequest) - hoverBiasY;
    const pelvisOffset = b.pelvisSpring.step(targetPelvisOffset, dt, scale, reduced);
    if (Math.abs(pelvisOffset) > 1e-4) {
      b.hips.position.y += pelvisOffset / scale;
      b.hips.updateWorldMatrix(false, true);
    }

    // Transform stage-space support normals to world space (`group` rotation-safe)
    if (supL) _rawNormL.set(supL.nx, supL.ny, supL.nz).transformDirection(this.group.matrixWorld);
    else _rawNormL.set(0, 1, 0);
    if (supR) _rawNormR.set(supR.nx, supR.ny, supR.nz).transformDirection(this.group.matrixWorld);
    else _rawNormR.set(0, 1, 0);

    const normL = filterFootSurfaceNormal(b.footLockL.filteredNormal, _rawNormL, stance.stanceL, dt);
    const normR = filterFootSurfaceNormal(b.footLockR.filteredNormal, _rawNormR, stance.stanceR, dt);

    b.root.getWorldQuaternion(_ikQ1);
    _ikQ2.copy(_ikQ1).invert();
    _ikDir.set(0, 0, 1).applyQuaternion(_ikQ1);
    const worldCharYaw = Math.atan2(_ikDir.x, _ikDir.z);

    solveFootSlopeAndRollRotation(
      {
        animatedFootWorldQuat: _animFootQuatL,
        footForwardLocal: b.footForwardLocalL,
        footUpLocal: b.footUpLocalL,
        characterYaw: worldCharYaw,
        filteredGroundNormalWorld: normL,
        stanceWeight: stance.stanceL,
        stanceProgress: stance.progressL,
        maxFootYawOffsetRad: 0.35,
      },
      _slopeRollOutL,
    );

    solveFootSlopeAndRollRotation(
      {
        animatedFootWorldQuat: _animFootQuatR,
        footForwardLocal: b.footForwardLocalR,
        footUpLocal: b.footUpLocalR,
        characterYaw: worldCharYaw,
        filteredGroundNormalWorld: normR,
        stanceWeight: stance.stanceR,
        stanceProgress: stance.progressR,
        maxFootYawOffsetRad: 0.35,
      },
      _slopeRollOutR,
    );

    _shoeFwdCharL.copy(b.footForwardLocalL).applyQuaternion(_slopeRollOutL.footWorldQuat).setY(0);
    if (_shoeFwdCharL.lengthSq() > 1e-6) _shoeFwdCharL.applyQuaternion(_ikQ2).normalize();
    else _shoeFwdCharL.set(0, 0, 1);

    _shoeFwdCharR.copy(b.footForwardLocalR).applyQuaternion(_slopeRollOutR.footWorldQuat).setY(0);
    if (_shoeFwdCharR.lengthSq() > 1e-6) _shoeFwdCharR.applyQuaternion(_ikQ2).normalize();
    else _shoeFwdCharR.set(0, 0, 1);

    _ikTarget.set(_stanceOutL.targetX, _stanceOutL.targetY, _stanceOutL.targetZ);
    this.group.localToWorld(_ikTarget);
    _legIkOptsL.shoeForwardChar = _shoeFwdCharL;
    _legIkOptsL.footWorldRotation = _slopeRollOutL.footWorldQuat;
    _legIkOptsL.toeBone = b.toeL ?? null;
    _legIkOptsL.toeRestQuat = b.toeRestQL;
    _legIkOptsL.toeCounterPitchRad = _slopeRollOutL.toeCounterPitchRad;
    _legIkOptsL.weight = 1;
    solveAnalyticLegIk(b.root, b.thighL, b.shinL, b.footL, _ikTarget, _legIkOptsL);

    _ikTarget.set(_stanceOutR.targetX, _stanceOutR.targetY, _stanceOutR.targetZ);
    this.group.localToWorld(_ikTarget);
    _legIkOptsR.shoeForwardChar = _shoeFwdCharR;
    _legIkOptsR.footWorldRotation = _slopeRollOutR.footWorldQuat;
    _legIkOptsR.toeBone = b.toeR ?? null;
    _legIkOptsR.toeRestQuat = b.toeRestQR;
    _legIkOptsR.toeCounterPitchRad = _slopeRollOutR.toeCounterPitchRad;
    _legIkOptsR.weight = 1;
    solveAnalyticLegIk(b.root, b.thighR, b.shinR, b.footR, _ikTarget, _legIkOptsR);

    b.ikDirty = true;
  }

  /**
   * Plants both shoes flat on `groundY` during `Sit_Down` / `Sit_Idle` / `Stand_Up` whenever skeleton
   * `hips.position.y` adjusts to a bench/bistro/reading-chair cushion height (`|soleY - groundY| === 0`).
   */
  private applyNpcSeatedFootFloorIk(b: Body, groundY: number, weight: number): void {
    if (!b.hasFootIkRest || !b.thighL || !b.shinL || !b.footL || !b.thighR || !b.shinR || !b.footR) return;
    if (weight <= 0.01) return;
    b.root.updateWorldMatrix(true, true);
    const invGroupM = this.tmpM.copy(this.group.matrixWorld).invert();

    b.footL.getWorldPosition(this.tmpV).applyMatrix4(invGroupM);
    b.footL.getWorldQuaternion(_animFootQuatL);
    b.footR.getWorldPosition(this.tmpV2).applyMatrix4(invGroupM);
    b.footR.getWorldQuaternion(_animFootQuatR);

    b.root.getWorldQuaternion(_ikQ1);
    _ikQ2.copy(_ikQ1).invert();
    _ikDir.set(0, 0, 1).applyQuaternion(_ikQ1);
    const worldCharYaw = Math.atan2(_ikDir.x, _ikDir.z);

    _rawNormL.set(0, 1, 0);
    solveFootSlopeAndRollRotation(
      {
        animatedFootWorldQuat: _animFootQuatL,
        footForwardLocal: b.footForwardLocalL,
        footUpLocal: b.footUpLocalL,
        characterYaw: worldCharYaw,
        filteredGroundNormalWorld: _rawNormL,
        stanceWeight: 1,
        stanceProgress: 0.45,
        maxFootYawOffsetRad: 0.28,
      },
      _slopeRollOutL,
    );
    solveFootSlopeAndRollRotation(
      {
        animatedFootWorldQuat: _animFootQuatR,
        footForwardLocal: b.footForwardLocalR,
        footUpLocal: b.footUpLocalR,
        characterYaw: worldCharYaw,
        filteredGroundNormalWorld: _rawNormL,
        stanceWeight: 1,
        stanceProgress: 0.45,
        maxFootYawOffsetRad: 0.28,
      },
      _slopeRollOutR,
    );

    _shoeFwdCharL.copy(b.footForwardLocalL).applyQuaternion(_slopeRollOutL.footWorldQuat).setY(0);
    if (_shoeFwdCharL.lengthSq() > 1e-6) _shoeFwdCharL.applyQuaternion(_ikQ2).normalize();
    else _shoeFwdCharL.set(0, 0, 1);

    _shoeFwdCharR.copy(b.footForwardLocalR).applyQuaternion(_slopeRollOutR.footWorldQuat).setY(0);
    if (_shoeFwdCharR.lengthSq() > 1e-6) _shoeFwdCharR.applyQuaternion(_ikQ2).normalize();
    else _shoeFwdCharR.set(0, 0, 1);

    _ikTarget.set(this.tmpV.x, groundY + b.footRestYL, this.tmpV.z);
    this.group.localToWorld(_ikTarget);
    _legIkOptsL.shoeForwardChar = _shoeFwdCharL;
    _legIkOptsL.footWorldRotation = _slopeRollOutL.footWorldQuat;
    _legIkOptsL.toeBone = b.toeL ?? null;
    _legIkOptsL.toeRestQuat = b.toeRestQL;
    _legIkOptsL.toeCounterPitchRad = 0;
    _legIkOptsL.weight = weight;
    solveAnalyticLegIk(b.root, b.thighL, b.shinL, b.footL, _ikTarget, _legIkOptsL);

    _ikTarget.set(this.tmpV2.x, groundY + b.footRestYR, this.tmpV2.z);
    this.group.localToWorld(_ikTarget);
    _legIkOptsR.shoeForwardChar = _shoeFwdCharR;
    _legIkOptsR.footWorldRotation = _slopeRollOutR.footWorldQuat;
    _legIkOptsR.toeBone = b.toeR ?? null;
    _legIkOptsR.toeRestQuat = b.toeRestQR;
    _legIkOptsR.toeCounterPitchRad = 0;
    _legIkOptsR.weight = weight;
    solveAnalyticLegIk(b.root, b.thighR, b.shinR, b.footR, _ikTarget, _legIkOptsR);

    b.ikDirty = true;
  }

  /**
   * Aligns a skinned Tier-0/1 rain-walking NPC's right hand onto a natural umbrella-handle grip point,
   * returning the live stage-local hand grip coordinates in `outStagePos` so the umbrella shaft sits IN the hand!
   */
  private applyNpcUmbrellaGrip(b: Body, outStagePos: T.Vector3): boolean {
    if (!b.upperArmR || !b.forearmR || !b.handR) return false;
    b.root.updateWorldMatrix(true, true);
    const fwdX = Math.sin(b.yaw);
    const fwdZ = Math.cos(b.yaw);
    const rightX = -Math.cos(b.yaw);
    const rightZ = Math.sin(b.yaw);

    // Natural right-hand umbrella grip target in stage space (shoulder-front, ~1.22 m above ground)
    const gx = b.root.position.x + rightX * 0.21 + fwdX * 0.25;
    const gy = b.root.position.y + 1.24;
    const gz = b.root.position.z + rightZ * 0.21 + fwdZ * 0.25;

    _ikTarget.set(gx, gy, gz);
    this.group.localToWorld(_ikTarget);
    _ikPole.set(
      b.root.position.x + rightX * 0.42 - fwdX * 0.14,
      b.root.position.y + 0.92,
      b.root.position.z + rightZ * 0.42 - fwdZ * 0.14,
    );
    this.group.localToWorld(_ikPole);
    solveTwoBoneZeroAlloc(b.upperArmR, b.forearmR, b.handR, _ikTarget, _ikPole, 0.92);
    b.ikDirty = true;

    // Read actual solved `hand.R` world position back into stage space so shaft aligns 1:1 with palm
    b.handR.getWorldPosition(outStagePos);
    this.group.worldToLocal(outStagePos);
    return true;
  }

  /**
   * Pre-synchronizes the learner's own vehicles (starter bicycle, car, and workshop two-wheeler)
   * BEFORE `Character.updateBody` / `GameView.update` so `getActivePlayerRiderBinding` reads
   * current-frame handlebar/pedal/seat world sockets (`0` 1-frame rider IK lag!).
   */
  syncPlayerVehicles(
    dt: number,
    game: EchoLifeGame,
    walk: LifeWalk,
    player: { x: number; z: number } | null,
    riderYaw = 0,
    riderSpeed = 0,
    sharedVisualOwned = false,
  ): void {
    this.group.updateWorldMatrix(true, false);
    const p = player ?? { x: 0, z: 0 };
    this.updateBike(dt, game, walk, player, riderYaw, riderSpeed, sharedVisualOwned);
    this.vehicles.car.update(game.car, walk, p, dt);
    this.vehicles.twoWheeler.update(game.twoWheeler, walk, p, dt);
    this.vehiclesSyncedAtTime = this.time;
  }

  /**
   * One frame: residents & ambient crowd placed on proven walkable ground or settled onto seats,
   * nearest actors upgraded to skinned PBR rigs with 48-clip retargeted animation, Dead-Blending,
   * expanded FACS micro-life, swing-safe `legIk.ts` foot/seat/umbrella IK, coherent `riderIk.ts`
   * cyclist/scooter/car embodiment & XPBD secondary physics; distant actors as impostors.
   */
  update(
    dt: number,
    game: EchoLifeGame,
    walk: LifeWalk,
    player: { x: number; z: number } | null,
    focus: Target | null,
    reduced: boolean,
    riderYaw = 0,
    raining = false,
    camera?: T.Camera | null,
    env?: GameViewEnv,
    handRight?: T.Vector3 | null,
  ) {
    const preSyncedThisFrame = this.vehiclesSyncedAtTime === this.time;
    this.time += dt;
    if (camera) this.lastCamera = camera;
    const cam = camera ?? this.lastCamera;
    let hasFrustum = false;
    if (cam) {
      this.projScreenM.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.projScreenM);
      hasFrustum = true;
    }

    // Sync winter outerwear, snow frost/shiver & wind uniforms once per frame (O(1) across all characters!)
    const weatherId = (game.weather as { id?: string } | undefined)?.id ?? '';
    const dayIdx = Math.floor((game.s?.clock ?? 0) / 1440);
    const inferredSeason = env?.season ?? (Math.floor(dayIdx / 7) % 4);
    const snowIntensity = env?.snow ?? (weatherId === 'snowy' ? 0.85 : 0);
    const winterFactor = snowIntensity > 0.1 ? Math.max(0.85, snowIntensity) : inferredSeason === 3 ? 0.82 : 0;
    if (winterFactor > 0.35) {
      this.winterIdleClock = 0;
      this.ensureWinterTemplates();
    } else {
      this.winterIdleClock += dt;
    }
    const windX = env?.windX ?? (raining ? 1.8 : snowIntensity > 0.1 ? 1.4 : 0.45);
    const windZ = env?.windZ ?? (raining ? 0.85 : snowIntensity > 0.1 ? 0.65 : 0.22);
    setCharacterSeasonState(winterFactor, snowIntensity, windX, windZ, this.time);
    this.windScratch.x = windX;
    this.windScratch.z = windZ;
    this.windScratch.gust = raining || snowIntensity > 0.1 ? 0.72 : 0.35;

    this.group.updateWorldMatrix(true, false);
    const p = player ?? { x: 0, z: 0 };
    const playerRegion = player ? (walk.surface(player)?.region ?? '') : '';
    const playerOutdoor = !player || OUTDOOR.has(playerRegion);
    const playerGroundY = player ? (walk.groundAt(player.x, player.z) ?? 0) : 0;
    this.tmpEye.set(p.x, playerGroundY + 1.56, p.z);
    this.group.localToWorld(this.tmpEye);

    const cfg = RENDER_CONFIGS[this.quality];
    const crowdCfg = cfg.crowd;
    const banter = (game.people as { overheardBanter?: { speakerId?: string; text?: string } | null }).overheardBanter ?? null;

    let nearCount = 0;
    let imp = 0,
      umb = 0,
      csh = 0;
    this.namedPosCount = 0;

    // 1. Collect named residents (zero allocations via `nearPool`)
    for (const w of game.people.walkers.values()) {
      const ext = w as ResidentExt;
      const standingUpSeat = !w.seat && w.seatTransition?.phase === 'standing_up' ? w.lastSeat : null;
      const activeSeat = w.seat ?? standingUpSeat;
      const baseX = ext.visualX ?? w.x;
      const baseZ = ext.visualZ ?? w.z;
      const rx = activeSeat ? activeSeat.sit.x : baseX;
      const rz = activeSeat ? activeSeat.sit.z : baseZ;
      // CRITICAL (#58): `root.position.y` is ALWAYS floor `groundY` (never elevated cushion `sit.y`)!
      const ry = walk.groundAt(rx, rz) ?? w.groundY ?? 0;
      const d = Math.hypot(rx - p.x, rz - p.z);
      if (d > 110) continue;
      const region = walk.surface(w)?.region ?? '';
      const outdoor = OUTDOOR.has(region);
      const inDialogue = game.people.talking === w.id;
      // Keep indoor NPCs visible through glass storefronts & open doors within 18 m while culling far interior actors!
      if (!outdoor && !inDialogue && d > (playerOutdoor ? 18.0 : 28.0)) continue;
      if (this.namedPosCount < this.namedPosX.length) {
        this.namedPosX[this.namedPosCount] = rx;
        this.namedPosZ[this.namedPosCount] = rz;
        this.namedPosCount++;
      }
      const banterSpeaking = !inDialogue && banter?.speakerId === w.id && !!banter.text;
      const speaking = inDialogue
        ? reduced || Math.sin(this.time * 1.15 + hashKey(w.id)) > -0.25
        : banterSpeaking;
      const dialogueText =
        inDialogue && (!env?.activeDialogueSpeakerId || env.activeDialogueSpeakerId === w.id)
          ? (env?.activeDialogueText ?? null)
          : null;
      const speechText = dialogueText ?? (banterSpeaking ? (banter?.text ?? null) : ext.quip ?? null);
      const rawAct = !w.moving && ext.microAct ? ext.microAct : w.activity;
      const seated = !!w.seat;
      // Never allow unseated residents on grass/sidewalks to play squat/sit/pedal clips!
      const effectiveAct =
        !seated && (rawAct === 'exercise_squat' || rawAct === 'sit' || rawAct === 'sit_idle' || rawAct === 'cycle')
          ? (speaking ? 'talk' : 'idle')
          : rawAct;

      const slot = this.acquireNearActor(nearCount++);
      slot.key = 'npc:' + w.id;
      slot.model = CHARACTERS[w.id]?.model ?? w.id;
      slot.x = rx;
      slot.y = ry;
      slot.z = rz;
      slot.standX = activeSeat ? activeSeat.stand.x : baseX;
      slot.standZ = activeSeat ? activeSeat.stand.z : baseZ;
      slot.yaw = activeSeat ? activeSeat.yaw : (ext.visualYaw ?? w.yaw);
      slot.act = effectiveAct;
      slot.d = d;
      slot.named = true;
      slot.seated = seated;
      slot.onBench = !!activeSeat?.id.startsWith('prop:bench:');
      slot.cushion = activeSeat?.top;
      slot.outdoor = outdoor;
      slot.inDialogue = inDialogue;
      slot.speaking = speaking;
      slot.speechText = speechText;
      slot.mood = resolveMood(ext.mood, effectiveAct, inDialogue, speaking);
      slot.lookTarget = ext.lookTarget ?? null;
      slot.facingId = w.facing;
      slot.rainUmbrella = ext.rainUmbrella;
      slot.umbrellaColorIdx = hashKey(slot.key) % UMB_COLORS.length;
      slot.ridingVehicleIdx = -1;
    }

    // 2. Collect living ambient crowd (preserving sit / jog / browse / chat / yield / umbrella & Stand_Up retention!)
    const crowd = game.crowd(player);
    this.stats.crowd = crowd.length;
    for (let i = 0; i < crowd.length; i++) {
      const c = crowd[i];
      const isSit = c.activity === 'sit' && c.sitX !== undefined && c.sitZ !== undefined;
      const isStandingUp =
        !isSit && c.seatPhase === 'standing_up' && c.lastSitX !== undefined && c.lastSitZ !== undefined;
      const cx = isSit ? c.sitX! : isStandingUp ? c.lastSitX! : c.x;
      const cz = isSit ? c.sitZ! : isStandingUp ? c.lastSitZ! : c.z;
      const d = Math.hypot(cx - p.x, cz - p.z);
      if (d > 70) continue;
      // ORCA-Lite in `crowd.ts` smoothly steers passers around residents; only reject exact `< 0.22 m` overlap!
      let overlapsNamed = false;
      for (let j = 0; j < this.namedPosCount; j++) {
        if (Math.hypot(cx - this.namedPosX[j], cz - this.namedPosZ[j]) < 0.22) {
          overlapsNamed = true;
          break;
        }
      }
      if (overlapsNamed) continue;
      const cy = walk.groundAt(c.x, c.z) ?? 0;

      // Map ALL upgraded CrowdActivity states faithfully instead of stripping to walk/idle!
      let act: string;
      let mood: LifeMood = 'neutral';
      let speaking = false;
      switch (c.activity) {
        case 'sit':
          act = 'sit';
          mood = 'neutral';
          break;
        case 'jog':
          act = 'run';
          mood = 'focus';
          break;
        case 'browse':
          act = 'listen';
          mood = 'listen';
          break;
        case 'chat':
          act = 'talk';
          mood = 'friendly';
          speaking = ((c.id + Math.floor(this.time * 0.45)) & 1) === 0;
          break;
        case 'yield':
          act = 'idle';
          mood = 'surprise';
          break;
        default:
          act = c.walking ? 'walk' : 'idle';
          break;
      }

      const slot = this.acquireNearActor(nearCount++);
      slot.key = 'crowd:' + c.id;
      slot.model = CROWD_MODELS[c.model % CROWD_MODELS.length];
      slot.x = cx;
      slot.y = cy;
      slot.z = cz;
      slot.standX = c.x;
      slot.standZ = c.z;
      slot.yaw = isStandingUp && c.lastSeatYaw !== undefined ? c.lastSeatYaw : c.yaw;
      slot.act = act;
      slot.d = d;
      slot.named = false;
      slot.seated = isSit;
      slot.onBench = !!(isSit && c.seatId?.startsWith('prop:bench:'));
      slot.cushion = isSit ? c.seatTop : isStandingUp ? c.lastSeatTop : undefined;
      slot.outdoor = true;
      slot.inDialogue = false;
      slot.speaking = speaking;
      slot.speechText = null;
      slot.mood = mood;
      slot.lookTarget = null;
      slot.facingId = null;
      slot.rainUmbrella = c.umbrella;
      slot.umbrellaColorIdx = (c.umbrellaColor ?? c.id) % UMB_COLORS.length;
      slot.ridingVehicleIdx = -1;
    }

    // 3. Mixed Street Traffic Fleet & Coherent Riders (bicycles, scooters & cars; zero double-stepping!)
    this.trafficCtxPlayerX = p.x;
    this.trafficCtxPlayerZ = p.z;
    this.trafficCtxGame = game;
    this.trafficCtxCrowd = crowd;
    const sessionSteppedTraffic = Boolean(
      (game as { trafficSteppedInSession?: boolean }).trafficSteppedInSession,
    );
    for (let i = 0; i < game.traffic.length; i++) {
      const bike = game.traffic[i];
      const active = (bike as { active?: boolean }).active !== false;
      const bikeKind = (bike as { kind?: string }).kind ?? 'bicycle';
      const view = (this.trafficViews[i] ??= new RoadVehicleView(this.group, bikeKind !== 'car'));
      view.setTwoWheels(bikeKind !== 'car');
      if (!active) {
        view.hide();
        continue;
      }
      const pose = bike.pose;
      const d = Math.hypot(p.x - pose.x, p.z - pose.z);
      if (!sessionSteppedTraffic) {
        this.trafficCtxDist = d;
        bike.step(dt, raining || !!game.weather.rain, this.trafficClearCheck);
      }
      view.update(bike, walk, p, dt);
      const riderMaxDist = bikeKind === 'car' ? 28 : 60;
      if (d > riderMaxDist) continue;
      const groundY = walk.groundAt(pose.x, pose.z) ?? 0;
      const slot = this.acquireNearActor(nearCount++);
      slot.key = 'commuter:' + i;
      slot.model = CROWD_MODELS[i % CROWD_MODELS.length];
      slot.x = pose.x;
      slot.y = groundY;
      slot.z = pose.z;
      slot.standX = pose.x;
      slot.standZ = pose.z;
      slot.yaw = pose.yaw;
      slot.act = bike.activity;
      slot.d = d;
      slot.named = false;
      // CRITICAL (#71): `seated: true` + `ridingVehicleIdx = i` prevents `'cycle'` -> `'idle'` remap & 0.44 m lag!
      slot.seated = true;
      slot.onBench = false;
      slot.cushion = undefined;
      slot.outdoor = true;
      slot.inDialogue = false;
      slot.speaking = false;
      slot.speechText = null;
      slot.mood = 'focus';
      slot.lookTarget = null;
      slot.facingId = null;
      slot.rainUmbrella = false;
      slot.umbrellaColorIdx = i % UMB_COLORS.length;
      slot.ridingVehicleIdx = i;
    }
    this.trafficCtxGame = null;
    this.trafficCtxCrowd = [];

    // Sort active slice in-place without allocating a new array
    this.nearActive.length = nearCount;
    for (let i = 0; i < nearCount; i++) this.nearActive[i] = this.nearPool[i];
    this.nearActive.sort(sortNearByDist);

    this.wantSet.clear();
    let named = 0,
      extras = 0,
      clonesThisFrame = 0,
      footIkCount = 0;
    const locoBlend = reduced ? 1 : 1 - Math.exp(-14 * dt);
    const lowBlobs = this.quality === 'low';
    const safeDt = Math.max(dt, 1 / 240);
    const maxNamed = this.maxSkinned;
    const maxCrowd = this.maxCrowdSkinned;
    const maxCrowdDist = this.maxCrowdSkinnedDist;
    const animFullDist = crowdCfg.animFullDist ?? 12;
    const animHalfDist = crowdCfg.animHalfDist ?? 25;
    const maxFootIkDist = this.quality === 'ultra' || this.quality === 'high' ? 18 : this.quality === 'balanced' ? 14 : 10;
    const maxFootIkActors = this.quality === 'ultra' || this.quality === 'high' ? 12 : this.quality === 'balanced' ? 8 : 4;
    const castNpcsAllowed = cfg.shadow.enabled && cfg.shadow.castNpcs;
    const npcShadowMaxDist = Math.min(22, cfg.shadow.maxNpcShadowDist ?? 22);
    const precipActive = raining || snowIntensity > 0.4;

    for (let i = 0; i < nearCount; i++) {
      const n = this.nearActive[i];
      const isRidingTraffic = n.ridingVehicleIdx >= 0;
      // Umbrellas ONLY render in active rain/heavy snow for non-seated, non-cycling, non-jogging outdoor actors
      const carryUmbrella =
        precipActive &&
        n.outdoor &&
        !n.seated &&
        !isRidingTraffic &&
        n.act !== 'cycle' &&
        n.act !== 'run' &&
        n.rainUmbrella !== false;

      if (lowBlobs && n.d < 28 && csh < 60 && !isRidingTraffic) {
        this.tmpM.makeTranslation(n.x, n.y + 0.02, n.z);
        this.contactShadows.setMatrixAt(csh++, this.tmpM);
      }

      const skin = n.named
        ? named < maxNamed && n.d < 40
        : isRidingTraffic
          ? extras < maxCrowd + 6 && n.d < 60
          : extras < maxCrowd && n.d < maxCrowdDist;
      const res = skin ? this.body(n.key, n.model, clonesThisFrame < 1) : null;
      if (res?.spawned) clonesThisFrame++;
      const b = res?.body ?? null;

      if (b) {
        if (n.named) named++;
        else extras++;
        this.wantSet.add(n.key);
        b.seen = this.time;

        // P0 Veto Gate #5: Winter NPC outerwear mesh swap with hysteresis (indoor heated buildings revert to summer!)
        const prevWinter = b.winterActive;
        const wantWinter = n.outdoor && (b.winterActive ? winterFactor > 0.30 : winterFactor > 0.35);
        this.setBodyWinterState(b, wantWinter);
        let submeshRevealed = b.winterActive && !prevWinter;

        // 4x CPU Perf Fix: hide micro-detail skinned meshes (brows, eyes, soles, small accessories) at distance
        const microCutoff = this.quality === 'balanced' || this.quality === 'low' ? 14 : 22;
        const hideMicro = n.d > (b.microHidden ? microCutoff - 1.0 : microCutoff) && !n.inDialogue;
        if (hideMicro !== b.microHidden) {
          if (!hideMicro) submeshRevealed = true;
          b.microHidden = hideMicro;
          for (let mi = 0; mi < b.microDetailMeshes.length; mi++) {
            b.microDetailMeshes[mi].visible = !hideMicro;
          }
        }

        // Bug #07: hide backpack/satchel accessory meshes when seated on chairs/benches or inside cars
        const inCarTraffic =
          isRidingTraffic && ((game.traffic[n.ridingVehicleIdx] as { kind?: string } | undefined)?.kind === 'car');
        const hideBackpack = (n.seated && !isRidingTraffic) || inCarTraffic;
        if (hideBackpack !== b.backpackHidden) {
          if (!hideBackpack) submeshRevealed = true;
          b.backpackHidden = hideBackpack;
          for (let bi = 0; bi < b.backpackMeshes.length; bi++) {
            b.backpackMeshes[bi].visible = !hideBackpack;
          }
        }

        // Cascade-0-only NPC shadow culling (<= 22 m with 1.5 m hysteresis; 0 traversals, 0 allocs; micro-trims always off!)
        const wantShadow =
          castNpcsAllowed && n.d <= (b.castingShadow ? npcShadowMaxDist + 1.0 : Math.max(4, npcShadowMaxDist - 0.5));
        if (wantShadow !== b.castingShadow) {
          b.castingShadow = wantShadow;
          for (let smi = 0; smi < b.shadowMeshes.length; smi++) {
            b.shadowMeshes[smi].castShadow = wantShadow;
          }
        }

        // Zero-Float Seated Transition State Machine (`Sit_Down` 1.25s -> `Sit_Idle` -> `Stand_Up` 1.10s; #58):
        // `b.root.position.y` stays strictly at floor `groundY` while `b.hips.position.y` settles onto `seatTopY`!
        const wasUninitialized = !b.initialized;
        let rootAlignW = 0;
        let hipContactW = 0;
        if (isRidingTraffic) {
          b.seatPhase = 'none';
          b.seatPhaseTimer = 0;
          b.hasSeatMemory = false;
          b.wasSeatedInView = false;
        } else {
          if (n.seated && !b.wasSeatedInView) {
            const desiredClearance = n.outdoor ? (b.winterActive ? 0.08 : 0.04) : 0.03;
            const seatFwd = n.onBench ? (b.winterActive ? 0.03 : 0) : desiredClearance;
            b.seatAnchorX = n.x + Math.sin(n.yaw) * seatFwd;
            b.seatAnchorZ = n.z + Math.cos(n.yaw) * seatFwd;
            b.seatStandX = n.standX;
            b.seatStandZ = n.standZ;
            b.seatYaw = n.yaw;
            b.seatTopY = n.cushion ?? (n.y + 0.48);
            b.hasSeatMemory = true;
            if (wasUninitialized || reduced) {
              b.seatPhase = 'seated';
              b.seatPhaseTimer = 1.25;
            } else {
              b.seatPhase = 'sitting_down';
              b.seatPhaseTimer = 0;
            }
          } else if (n.seated) {
            if (n.cushion !== undefined) b.seatTopY = n.cushion;
            if (b.seatPhase === 'sitting_down') {
              b.seatPhaseTimer += dt;
              if (b.seatPhaseTimer >= 1.25) b.seatPhase = 'seated';
            } else {
              b.seatPhase = 'seated';
            }
          } else {
            if (b.wasSeatedInView) {
              b.seatPhase = reduced ? 'none' : 'standing_up';
              b.seatPhaseTimer = 0;
              b.seatStandX = n.standX;
              b.seatStandZ = n.standZ;
              if (reduced) b.hasSeatMemory = false;
            } else if (b.seatPhase === 'standing_up') {
              b.seatPhaseTimer += dt;
              b.seatStandX = n.standX;
              b.seatStandZ = n.standZ;
              if (b.seatPhaseTimer >= 1.10) {
                b.seatPhase = 'none';
                b.hasSeatMemory = false;
              }
            }
          }
          b.wasSeatedInView = n.seated;

          if (b.seatPhase === 'sitting_down') {
            const u = Math.min(1, b.seatPhaseTimer / 1.25);
            rootAlignW = smoothstep01((u - 0.05) / 0.68);
            hipContactW = smoothstep01((u - 0.58) / 0.38);
          } else if (b.seatPhase === 'seated') {
            rootAlignW = 1;
            hipContactW = 1;
          } else if (b.seatPhase === 'standing_up') {
            const u = Math.min(1, b.seatPhaseTimer / 1.10);
            hipContactW = 1 - smoothstep01((u - 0.04) / 0.36);
            rootAlignW = 1 - smoothstep01((u - 0.24) / 0.68);
          }
        }

        let targetX = n.x;
        let targetY = n.y;
        let targetZ = n.z;
        let targetYaw = n.yaw;
        if (!isRidingTraffic && b.seatPhase !== 'none' && b.hasSeatMemory) {
          targetX = b.seatStandX + (b.seatAnchorX - b.seatStandX) * rootAlignW;
          targetZ = b.seatStandZ + (b.seatAnchorZ - b.seatStandZ) * rootAlignW;
          targetY = walk.groundAt(targetX, targetZ) ?? n.y;
          targetYaw = lerpAngleRad(n.yaw, b.seatYaw, rootAlignW);
        }

        let speed = 0;
        let yawRate = 0;
        if (isRidingTraffic) {
          // Zero lerp lag when mounted on a moving traffic vehicle (`0.00 mm` saddle lock!)
          b.root.position.set(targetX, targetY, targetZ);
          b.yaw = targetYaw;
          b.prevX = targetX;
          b.prevZ = targetZ;
          b.prevYaw = targetYaw;
          b.initialized = true;
          speed = Math.abs(game.traffic[n.ridingVehicleIdx]?.speed ?? 0);
          yawRate = 0;
        } else if (!b.initialized || b.root.position.distanceToSquared(this.tmpV.set(targetX, targetY, targetZ)) > 4) {
          b.root.position.set(targetX, targetY, targetZ);
          b.yaw = targetYaw;
          b.prevX = targetX;
          b.prevZ = targetZ;
          b.prevYaw = targetYaw;
          b.initialized = true;
          resetNpcFootLockState(b.footLockL);
          resetNpcFootLockState(b.footLockR);
          b.pelvisSpring.reset();
          b.animator.resetDynamics();
          b.secondary.reset();
        } else {
          b.root.position.lerp(this.tmpV.set(targetX, targetY, targetZ), locoBlend);
          let dyaw = targetYaw - b.yaw;
          while (dyaw > Math.PI) dyaw -= Math.PI * 2;
          while (dyaw < -Math.PI) dyaw += Math.PI * 2;
          b.yaw += dyaw * locoBlend;
          speed = Math.hypot(b.root.position.x - b.prevX, b.root.position.z - b.prevZ) / safeDt;
          let stepYaw = b.yaw - b.prevYaw;
          while (stepYaw > Math.PI) stepYaw -= Math.PI * 2;
          while (stepYaw < -Math.PI) stepYaw += Math.PI * 2;
          yawRate = stepYaw / safeDt;
          b.prevX = b.root.position.x;
          b.prevZ = b.root.position.z;
          b.prevYaw = b.yaw;
        }
        b.root.rotation.set(0, b.yaw, 0);

        // Frustum-cull off-screen skinned NPCs per `renderConfig.crowd.frustumCullMixers`
        this.tmpSphere.center.set(b.root.position.x, b.root.position.y + 0.95, b.root.position.z);
        this.group.localToWorld(this.tmpSphere.center);
        this.tmpSphere.radius = 1.85;
        const inView = !crowdCfg.frustumCullMixers || !hasFrustum || this.frustum.intersectsSphere(this.tmpSphere);
        const justEnteredView = inView && !b.wasInView;
        b.wasInView = inView;

        let umbrellaGripped = false;
        let steppedSkeleton = wasUninitialized;
        if (wasUninitialized || inView || n.d <= 3.5 || n.inDialogue) {
          b.debt += dt;
          // Per-tier distance animation throttle (`animFullDist` 60 Hz, `animHalfDist` 30 Hz, far 15 Hz; riders/spawn/re-entry 60 Hz)
          const every =
            wasUninitialized || justEnteredView || n.d < animFullDist || n.inDialogue || isRidingTraffic
              ? 0
              : n.d < animHalfDist
                ? 1 / 30
                : 1 / 15;
          if (wasUninitialized || justEnteredView || (dt > 0 && b.debt >= every)) {
            steppedSkeleton = true;
            const stepDt = dt <= 0 && !wasUninitialized ? 0 : b.debt > 0 ? b.debt : safeDt;
            b.debt = 0;
            let lookTargetWorld: T.Vector3 | null = null;
            if (n.lookTarget) {
              this.tmpLook.set(n.lookTarget.x, n.lookTarget.y ?? n.y + 1.54, n.lookTarget.z);
              this.group.localToWorld(this.tmpLook);
              lookTargetWorld = this.tmpLook;
            } else if (n.inDialogue || (player && n.d < 8.5 && !isRidingTraffic)) {
              lookTargetWorld = this.tmpEye;
            } else if (n.facingId) {
              const partner = game.people.walkers.get(n.facingId);
              if (partner) {
                const px = partner.seat ? partner.seat.sit.x : partner.x;
                const pz = partner.seat ? partner.seat.sit.z : partner.z;
                const py = (walk.groundAt(px, pz) ?? n.y) + (partner.seat ? 1.24 : 1.54);
                this.tmpLook.set(px, py, pz);
                this.group.localToWorld(this.tmpLook);
                lookTargetWorld = this.tmpLook;
              }
            }

            this.restoreBodyIk(b);
            b.secondary.restore();
            b.life.restore();
            b.animator.update({
              dt: stepDt,
              activity: n.act,
              speed,
              yawRate,
              seated: n.seated,
              inDialogue: n.inDialogue,
              speaking: n.speaking,
              scale: b.root.scale.y,
              reduced,
            });
            b.life.capture();
            b.secondary.capture();
            b.life.update({
              dt: stepDt,
              reduced,
              lookTargetWorld,
              speed,
              seated: n.seated,
              inDialogue: n.inDialogue,
              speaking: n.speaking,
              speechText: n.speechText,
              mood: n.mood,
              snowIntensity: n.outdoor ? snowIntensity : 0,
              curlFingers: true,
            });

            // Capture post-life bone orientations before applying Tier-0 rider / seat / foot / umbrella IK
            this.captureBodyIk(b);

            if (isRidingTraffic) {
              // Coherent Bicycle / Scooter / Car Rider Embodiment (`riderIk.ts` + `vehicleRigExtractor.ts`)
              const tBike = game.traffic[n.ridingVehicleIdx] as RoadVehicle & {
                lean?: number;
                forkDive?: number;
                crankAngle?: number;
                standDownBlend?: number;
                dynamics?: { crankAngle?: number; pedalCadence?: number };
              };
              const tView = this.trafficViews[n.ridingVehicleIdx];
              if (tBike && tView?.rig) {
                this.tmpV.set(n.x, n.y, n.z);
                this.group.localToWorld(this.tmpV);
                _trafficRiderStateScratch.speed = tBike.speed;
                _trafficRiderStateScratch.maxSpeed = tBike.spec?.maxSpeed ?? 6;
                _trafficRiderStateScratch.steer = tBike.steer;
                _trafficRiderStateScratch.lean = tBike.lean ?? 0;
                _trafficRiderStateScratch.forkDive = tBike.forkDive ?? 0;
                _trafficRiderStateScratch.crankAngle = tBike.crankAngle ?? tBike.dynamics?.crankAngle ?? 0;
                _trafficRiderStateScratch.crankOmega = tBike.dynamics?.pedalCadence ?? 0;
                _trafficRiderStateScratch.standDownBlend =
                  tBike.standDownBlend ?? (Math.abs(tBike.speed) < 0.18 ? 1 : 0);
                _trafficRiderStateScratch.mountBlend = 1;
                _trafficRiderStateScratch.armIkWeight = 1;
                _trafficRiderStateScratch.kickstandRetract = 1;
                _trafficRiderStateScratch.doorOpenBlend = tBike.door ?? 0;
                _trafficRiderStateScratch.groundY = this.tmpV.y;
                _trafficRiderStateScratch.standSideSign = 1;

                tView.rig.gltf.scene.updateWorldMatrix(true, true);
                if (b.riderSkel) {
                  applyCoherentRiderIk(
                    b.riderSkel,
                    tView.rig.gltf.scene,
                    tView.rig.sockets,
                    _trafficRiderStateScratch,
                  );
                  b.ikDirty = true;
                }
              }
            } else if (hipContactW > 1e-3 && b.hasSeatMemory && b.hips) {
              // Zero-Float Seated Cushion Settlement: adjust `hips.position.y` inside skeleton while `root.y === groundY`
              b.root.updateWorldMatrix(true, true);
              const scaleY = Math.max(0.5, b.root.scale.y || 1);
              const invGroupM = this.tmpM.copy(this.group.matrixWorld).invert();
              const animHipStageY = b.hips.getWorldPosition(this.tmpV).applyMatrix4(invGroupM).y;
              const desiredHipStageY = b.seatTopY + 0.082 * scaleY;
              const deltaStageY =
                T.MathUtils.clamp(desiredHipStageY - animHipStageY, -0.18 * scaleY, 0.16 * scaleY) * hipContactW;
              if (Math.abs(deltaStageY) > 1e-4) {
                b.hips.position.y += deltaStageY / scaleY;
                b.hips.updateWorldMatrix(false, true);
                b.ikDirty = true;
              }
              if (!reduced && n.d < 20) {
                this.applyNpcSeatedFootFloorIk(b, b.root.position.y, hipContactW);
              }
            } else if (!reduced && !n.seated && footIkCount < maxFootIkActors && n.d < maxFootIkDist) {
              // Swing-safe 2-bone stance foot-lock, ramp/stair roll & damped pelvis spring (`legIk.ts`)
              this.applyNpcFootGroundIk(b, walk, stepDt, speed, yawRate, reduced);
              footIkCount++;
            }

            // Umbrella-hand grip alignment for skinned NPCs carrying umbrellas
            if (carryUmbrella && n.d < 34 && umb < 48) {
              umbrellaGripped = this.applyNpcUmbrellaGrip(b, this.tmpV);
              if (umbrellaGripped) {
                // Tilt umbrella subtly forward into rain/wind with live hand grip at local y=0
                _umbEuler.set(0.10, b.yaw, -0.06, 'YXZ');
                this.tmpQ.setFromEuler(_umbEuler);
                this.tmpS.set(1, 1, 1);
                this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpS);
                this.umbrellaMesh.setMatrixAt(umb, this.tmpM);
                this.umbrellaMesh.setColorAt(umb, this.tmpC.set(UMB_COLORS[n.umbrellaColorIdx]));
                umb++;
              }
            }

            // XPBD secondary physics (runs AFTER IK so hair/scarf reacts to post-IK head/chest pose!)
            if (b.secondary.active) {
              b.secondary.update(stepDt, reduced, this.windScratch, n.d);
            }
          }
        }

        // Dirty-gated `Skeleton.update` (`scratch.ts` #57): skip bone texture & world-matrix uploads on stationary throttled off-frames,
        // NEVER freezing when root moved/rotated, newly entered view, or sub-meshes (winter/eyes/backpack) became visible!
        const rootMoved = wasUninitialized || speed > 0.005 || Math.abs(yawRate) > 0.01;
        const mustRefreshSkeleton = steppedSkeleton || rootMoved || isRidingTraffic || justEnteredView || submeshRevealed;
        if (submeshRevealed) {
          b.dirtySkeleton.markDirty();
        }
        b.dirtySkeleton.setFrozenThisFrame(!mustRefreshSkeleton);
        if (mustRefreshSkeleton || n.d < animFullDist) {
          b.root.matrixWorldAutoUpdate = true;
          b.root.updateMatrixWorld(true);
        } else {
          b.root.matrixWorldAutoUpdate = false;
        }

        // Fallback umbrella placement on throttled frames so umbrella never blinks out
        if (carryUmbrella && !umbrellaGripped && n.d < 34 && umb < 48) {
          const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
          const rx = -Math.cos(b.yaw), rz = Math.sin(b.yaw);
          this.tmpV.set(b.root.position.x + rx * 0.21 + fx * 0.24, b.root.position.y + 1.24, b.root.position.z + rz * 0.21 + fz * 0.24);
          _umbEuler.set(0.10, b.yaw, -0.06, 'YXZ');
          this.tmpQ.setFromEuler(_umbEuler);
          this.tmpS.set(1, 1, 1);
          this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpS);
          this.umbrellaMesh.setMatrixAt(umb, this.tmpM);
          this.umbrellaMesh.setColorAt(umb, this.tmpC.set(UMB_COLORS[n.umbrellaColorIdx]));
          umb++;
        }
        continue;
      }

      // Non-skinned umbrella holder (outside skinned cap, within 34 m)
      if (carryUmbrella && n.d < 34 && umb < 48) {
        this.tmpV.set(n.x, n.y + 1.24, n.z);
        this.tmpQ.setFromAxisAngle(this.up, n.yaw);
        this.tmpS.set(1, 1, 1);
        this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpS);
        this.umbrellaMesh.setMatrixAt(umb, this.tmpM);
        this.umbrellaMesh.setColorAt(umb, this.tmpC.set(UMB_COLORS[n.umbrellaColorIdx]));
        umb++;
      }

      // Never draw untextured silhouette impostor pawns within 42 m of the player (keeps sidewalks 100% textured skinned humans).
      if (n.d < 42 || isRidingTraffic) continue;
      if (!OUTDOOR.has(walk.surface(n)?.region ?? '')) continue;
      if (imp < 140) {
        const hash = hashKey(n.key);
        const walking = n.act === 'walk' || n.act === 'run';
        const bob = walking && !reduced ? Math.abs(Math.sin(this.time * 6.2 + hash * 12)) * 0.045 : 0;
        this.tmpQ.setFromAxisAngle(this.up, n.yaw);
        this.tmpS.set(1, 1, 1);
        this.tmpM.compose(this.tmpV.set(n.x, n.y + bob, n.z), this.tmpQ, this.tmpS);
        this.bodyMesh.setMatrixAt(imp, this.tmpM);
        this.tmpM.makeTranslation(n.x, n.y + 1.54 + bob, n.z);
        this.headMesh.setMatrixAt(imp, this.tmpM);
        const colorHex = n.named
          ? IMPOSTOR_PALETTE[hash % IMPOSTOR_PALETTE.length]
          : IMPOSTOR_PALETTE[(hash + 3) % IMPOSTOR_PALETTE.length];
        this.bodyMesh.setColorAt(imp, this.tmpC.set(colorHex));
        imp++;
      }
    }

    const playerMounted = Boolean(game.riding || game.drivenVehicle);
    if (lowBlobs && player && !playerMounted && csh < 64) {
      const py = walk.groundAt(player.x, player.z) ?? 0;
      this.tmpM.makeTranslation(player.x, py + 0.02, player.z);
      this.contactShadows.setMatrixAt(csh++, this.tmpM);
    }

    // Drop departed skinned bodies without allocating key arrays
    this.dropKeys.length = 0;
    for (const key of this.bodies.keys()) {
      if (!this.wantSet.has(key)) this.dropKeys.push(key);
    }
    for (let i = 0; i < this.dropKeys.length; i++) this.drop(this.dropKeys[i]);

    this.bodyMesh.count = imp;
    this.headMesh.count = imp;
    this.bodyMesh.visible = imp > 0;
    this.headMesh.visible = imp > 0;
    if (imp > 0) {
      this.bodyMesh.instanceMatrix.needsUpdate = true;
      this.headMesh.instanceMatrix.needsUpdate = true;
      if (this.bodyMesh.instanceColor) this.bodyMesh.instanceColor.needsUpdate = true;
    }
    if (!precipActive || umb === 0) {
      if (this.umbrellaMesh.count > 0) {
        this.tmpM.makeScale(0, 0, 0);
        for (let i = 0; i < this.umbrellaMesh.count; i++) this.umbrellaMesh.setMatrixAt(i, this.tmpM);
        this.umbrellaMesh.instanceMatrix.needsUpdate = true;
      }
      this.umbrellaMesh.count = 0;
      this.umbrellaMesh.visible = false;
    } else {
      this.umbrellaMesh.count = umb;
      this.umbrellaMesh.visible = true;
      this.umbrellaMesh.instanceMatrix.needsUpdate = true;
      if (this.umbrellaMesh.instanceColor) this.umbrellaMesh.instanceColor.needsUpdate = true;
    }
    this.contactShadows.count = csh;
    this.contactShadows.visible = csh > 0;
    if (csh > 0) {
      this.contactShadows.instanceMatrix.needsUpdate = true;
    }
    this.stats.skinned = this.bodies.size;
    this.stats.impostors = imp;

    // Grounded floor rings for non-anchored hotspots (hidden while mounted on a vehicle or during a minigame).
    const challengeActive = !!game.s.challenge;
    let k = 0;
    if (!challengeActive && !playerMounted) {
      for (const h of game.hotspots) {
        if (k >= 96) break;
        if (h.anchored && h.kind === 'prop') continue;
        const d = Math.hypot(h.at.x - p.x, h.at.z - p.z);
        if (d > 14 || d < 0.35) continue;
        if (!game.entityFor(h)) continue;
        const y = walk.groundAt(h.stand.x, h.stand.z) ?? 0;
        this.tmpM.makeTranslation(h.stand.x, y + 0.02, h.stand.z);
        this.rings.setMatrixAt(k, this.tmpM);
        k++;
      }
    }
    this.rings.count = k;
    this.rings.visible = k > 0;
    if (k > 0) {
      this.rings.instanceMatrix.needsUpdate = true;
    }
    this.stats.spots = k;

    if (focus && !challengeActive && !playerMounted) {
      const at = focus.kind === 'spot' ? focus.hotspot.stand : focus.at;
      this.focusRing.position.set(at.x, (walk.groundAt(at.x, at.z) ?? 0) + 0.03, at.z);
      this.focusRing.visible = true;
    } else {
      this.focusRing.visible = false;
    }

    // Bug #10: Pass live player facing yaw + exact right-hand stage position for closed-loop palm-to-ball dribbling!
    const resolvedHandRight =
      handRight ?? env?.handRight ?? (_sharedPlayerHandRightActive ? _sharedPlayerHandRight : null);
    this.basketball.update(dt, game, p, { playerYaw: riderYaw, handRight: resolvedHandRight });
    this.market.update(game, p);
    if (!preSyncedThisFrame) {
      this.updateBike(dt, game, walk, player, riderYaw, 0, false);
      this.vehicles.car.update(game.car, walk, p, dt);
      this.vehicles.twoWheeler.update(game.twoWheeler, walk, p, dt);
    }

    // P5-Perf #2: Delegate NPC & winter template retention (`>= 60 s`) strictly to `EchoLifeResidencyManager`
    // and never run eviction while any `compileAsync` is in flight (`getInFlightCompileCount() === 0`).
    this.pruneClock += dt;
    if (this.pruneClock >= 1.0) {
      this.pruneClock = 0;
      const residency = getEchoLifeResidencyManager();
      for (const b of this.bodies.values()) {
        const r = this.ready.get(b.model);
        if (r) r.used = this.time;
        residency.touch(this.npcResKey(b.model));
        if (b.winterActive) residency.touch(this.winterResKey(b.winterKind));
      }
      if (getInFlightCompileCount() === 0) {
        residency.tick();
      }
    }
    this.stats.models = this.ready.size;
  }

  /**
   * Articulated starter bicycle (`LIFE_ASSETS.bicycle`) loaded directly with `upgradeAndOptimizeVehicleRig`
   * + `extractVehicleRig` so tires kiss `groundY` (`0` `+24.6 cm` kickstand float!), `Stand_Rod` retracts
   * when ridden, and wheels/crank/counter-pedals/fork articulate coherently with the learner's speed & yaw!
   */
  ensureStarterBikeLoaded(): Promise<void> {
    if (this.bike || this.disposed) return Promise.resolve();
    if (this.bikeLoadPromise) return this.bikeLoadPromise;
    this.bikeLoading = true;
    const p = loader
      .loadAsync(LIFE_ASSETS.bicycle)
      .then((gltf) => {
        this.bikeLoading = false;
        if (this.disposed) {
          disposeGltf(gltf);
          return;
        }
        const g = gltf.scene;
        g.name = 'echo-life-bicycle';
        stripTransmissionFromHierarchy(g);
        this.bikeGltf = gltf;
        this.bikeVisualRig = upgradeAndOptimizeVehicleRig(g, { twoWheels: true, modelId: 'bicycle' });
        this.bikeSockets = this.bikeVisualRig.sockets;
        const hook = getVehiclePrewarmHook();
        g.visible = false;
        this.bikePrewarmReady = !hook;
        this.bike = g;
        this.group.add(g);
        if (hook) {
          void Promise.resolve(hook(g)).finally(() => {
            if (!this.disposed && this.bike === g) this.bikePrewarmReady = true;
          });
        }
      })
      .catch(() => {
        this.bikeLoading = false;
      })
      .finally(() => {
        if (this.bikeLoadPromise === p) this.bikeLoadPromise = null;
      });
    this.bikeLoadPromise = p;
    return p;
  }

  async prewarmPlayerVehicles(game: EchoLifeGame, walk: LifeWalk): Promise<void> {
    const p = { x: 0, z: 0 };
    this.vehicles.car.update(game.car, walk, p, 0);
    this.vehicles.twoWheeler.update(game.twoWheeler, walk, p, 0);
    await Promise.all([
      this.ensureStarterBikeLoaded(),
      this.vehicles.car.waitReady(),
      this.vehicles.twoWheeler.waitReady(),
    ]);
  }

  private updateBike(
    dt: number,
    game: EchoLifeGame,
    walk: LifeWalk,
    player: { x: number; z: number } | null,
    riderYaw: number,
    riderSpeed: number,
    sharedVisualOwned = false,
  ) {
    if (game.twoWheeler.spec) {
      if (this.bike) this.bike.visible = false;
      return;
    }
    if (!this.bike && !this.bikeLoading) {
      void this.ensureStarterBikeLoaded();
    }
    if (!this.bike) return;
    const activeRide = game.riding && (!game.ridingShared || !sharedVisualOwned);
    const at = activeRide && player ? player : game.bike;
    const yaw = activeRide ? riderYaw : game.bike.yaw;
    const groundStageY = walk.groundAt(at.x, at.z) ?? 0;

    if (this.bikeSockets) {
      const stepDx = this.bikePosSeeded ? at.x - this.prevBikeX : 0;
      const stepDz = this.bikePosSeeded ? at.z - this.prevBikeZ : 0;
      const stepDist = Math.hypot(stepDx, stepDz);
      const signedFwd =
        this.bikePosSeeded && stepDist < 5
          ? stepDx * Math.sin(yaw) + stepDz * Math.cos(yaw)
          : 0;
      this.prevBikeX = at.x;
      this.prevBikeZ = at.z;
      this.bikePosSeeded = true;

      let yawRate = 0;
      if (this.bikeYawSeeded && dt > 1e-4) {
        let dy = yaw - this.prevBikeYaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        yawRate = dy / dt;
      }
      this.prevBikeYaw = yaw;
      this.bikeYawSeeded = true;

      const derivedSpeed = dt > 1e-4 ? signedFwd / dt : 0;
      const effSpeed = activeRide ? (Math.abs(riderSpeed) > 1e-4 ? riderSpeed : derivedSpeed) : 0;

      if (activeRide && this.bikeRiderCtrl.phase === 'unmounted') {
        this.bikeRiderCtrl.mountImmediate(effSpeed, 1);
      } else if (!activeRide && (this.bikeRiderCtrl.phase === 'riding' || this.bikeRiderCtrl.phase === 'mounting')) {
        this.bikeRiderCtrl.dismountImmediate();
      }
      const accel = dt > 1e-4 ? (effSpeed - this.prevBikeSpeed) / dt : 0;
      this.prevBikeSpeed = effSpeed;
      const isCoasting = !activeRide || effSpeed <= 0.12 || accel < -0.25;
      const isBraking = activeRide && effSpeed > 0.2 && accel < -2.2;
      const steer =
        activeRide && Math.abs(effSpeed) > 0.12
          ? T.MathUtils.clamp(
              Math.atan((this.bikeSockets.wheelbase * yawRate) / Math.max(0.8, Math.abs(effSpeed))) *
                (effSpeed >= 0 ? 1 : -1),
              -0.58,
              0.58,
            )
          : 0;
      this.tmpV.set(at.x, groundStageY, at.z);
      this.group.localToWorld(this.tmpV);
      const worldGroundY = this.tmpV.y;

      _bikeStepInputScratch.speed = effSpeed;
      _bikeStepInputScratch.maxSpeed = 7.5;
      _bikeStepInputScratch.throttle = !isCoasting ? 0.7 : 0;
      _bikeStepInputScratch.steer = steer;
      _bikeStepInputScratch.brake = isBraking;
      _bikeStepInputScratch.isCoasting = isCoasting;
      _bikeStepInputScratch.groundY = worldGroundY;

      const state = this.bikeRiderCtrl.step(Math.max(0, dt), this.bikeSockets, _bikeStepInputScratch);
      if (stepDist < 5) {
        const wheelR = Math.max(0.12, this.bikeSockets.wheelRadius);
        this.bikeWheelSpin = (this.bikeWheelSpin + signedFwd / wheelR) % (Math.PI * 2000);
        this.bikeRiderCtrl.wheelSpin = this.bikeWheelSpin;
      }
      this.bikeLastState = state;
      _trafficRiderStateScratch.speed = state.speed;
      _trafficRiderStateScratch.maxSpeed = state.maxSpeed;
      _trafficRiderStateScratch.steer = state.steer;
      _trafficRiderStateScratch.lean = state.lean;
      _trafficRiderStateScratch.forkDive = state.forkDive;
      _trafficRiderStateScratch.crankAngle = state.crankAngle;
      _trafficRiderStateScratch.crankOmega = state.crankOmega;
      _trafficRiderStateScratch.standDownBlend = state.standDownBlend;
      _trafficRiderStateScratch.mountBlend = state.mountBlend;
      _trafficRiderStateScratch.armIkWeight = state.armIkWeight;
      _trafficRiderStateScratch.kickstandRetract = state.kickstandRetract;
      _trafficRiderStateScratch.doorOpenBlend = state.doorOpenBlend;
      _trafficRiderStateScratch.groundY = groundStageY;
      _trafficRiderStateScratch.standSideSign = state.standSideSign;

      _bikePoseScratch.x = at.x;
      _bikePoseScratch.z = at.z;
      _bikePoseScratch.yaw = yaw;
      applyVehicleRigKinematics(
        this.bike,
        this.bikeSockets,
        _trafficRiderStateScratch,
        _bikePoseScratch,
        this.bikeWheelSpin,
      );
    } else {
      this.bike.position.set(at.x, groundStageY, at.z);
      this.bike.rotation.set(0, yaw, 0, 'YXZ');
      this.bike.updateWorldMatrix(true, true);
    }
    this.bike.visible = this.bikePrewarmReady && !game.twoWheeler.spec;
  }

  /** Name tags of the residents in view and near, projected accurately from stage-world head positions. */
  labels(
    game: EchoLifeGame,
    walk: LifeWalk,
    camera: T.Camera,
    width: number,
    height: number,
    player: { x: number; z: number } | null,
    focus: Target | null,
  ): Label[] {
    this.lastCamera = camera;
    if (!player) return [];
    this.group.updateWorldMatrix(true, false);
    const out: Label[] = [];
    const scenes = new Map<string, string>();
    for (const id of game.people.stats.scenes) {
      const sc = game.sceneById(id);
      if (sc) for (const pid of sc.participants) scenes.set(pid, sc.caption);
    }
    for (const w of game.people.walkers.values()) {
      const rx = w.seat ? w.seat.sit.x : w.x;
      const rz = w.seat ? w.seat.sit.z : w.z;
      const d = Math.hypot(rx - player.x, rz - player.z);
      if (d > 11) continue;
      const live = this.bodies.get('npc:' + w.id);
      if (live) {
        this.tmpV.set(live.root.position.x, live.root.position.y + (w.seat ? 1.46 : 1.88), live.root.position.z);
      } else {
        const y = (walk.groundAt(rx, rz) ?? 0) + (w.seat ? 1.50 : 1.92);
        this.tmpV.set(rx, y, rz);
      }
      // Convert stage-local coordinates into world space BEFORE camera projection so nameplates never drift.
      this.group.localToWorld(this.tmpV);
      this.tmpV.project(camera);
      if (this.tmpV.z > 1 || this.tmpV.z < -1 || Math.abs(this.tmpV.x) > 1.05 || Math.abs(this.tmpV.y) > 1.05) continue;
      const c = CHARACTERS[w.id];
      out.push({
        id: w.id,
        name: c?.name ?? w.id,
        role: c?.role ?? '',
        x: ((this.tmpV.x + 1) / 2) * width,
        y: ((1 - this.tmpV.y) / 2) * height,
        dist: d,
        focus: focus?.kind === 'npc' && focus.id === w.id,
        scene: scenes.get(w.id) ?? null,
      });
    }
    return out;
  }

  dispose() {
    this.disposed = true;
    this.pack48 = null;
    this.lastCamera = null;
    this.basketball.dispose();
    this.market.dispose();
    this.trafficViews.forEach((view) => view.release());
    this.vehicles.car.release();
    this.vehicles.twoWheeler.release();
    for (const key of [...this.bodies.keys()]) this.drop(key);
    const residency = getEchoLifeResidencyManager();
    for (const model of this.ready.keys()) {
      residency.unregister(this.npcResKey(model), false);
    }
    for (const r of this.ready.values()) disposeGltf(r.gltf);
    this.ready.clear();
    this.gltfs.clear();
    for (const kind of this.winterTemplates.keys()) {
      residency.unregister(this.winterResKey(kind), false);
    }
    for (const tpl of this.winterTemplates.values()) disposeGltf(tpl);
    this.winterTemplates.clear();
    this.winterBytes.clear();
    this.winterLoading.clear();
    for (const m of [this.bodyMesh, this.headMesh, this.umbrellaMesh, this.contactShadows, this.rings]) {
      m.dispose();
      m.geometry.dispose();
      (m.material as T.Material).dispose();
    }
    this.focusRing.geometry.dispose();
    (this.focusRing.material as T.Material).dispose();
    this.bikeLoading = false;
    this.bike?.removeFromParent();
    if (this.bikeVisualRig) {
      disposeVehicleVisualRig(this.bikeVisualRig);
      this.bikeVisualRig = null;
    }
    if (this.bikeGltf) {
      disposeGltf(this.bikeGltf);
      this.bikeGltf = null;
    }
    this.bikeSockets = null;
    this.bikeLastState = null;
    this.bike = null;
    this.group.removeFromParent();
  }
}

function lerpAngleRad(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function sortNearByDist(a: NearActor, b: NearActor): number {
  return a.d - b.d;
}

function resolveMood(rawMood: string | undefined, act: string, inDialogue: boolean, speaking: boolean): LifeMood {
  if (rawMood) {
    const m = rawMood.toLowerCase();
    if (m === 'happy' || m === 'joy' || m === 'cheerful') return 'happy';
    if (m === 'excited' || m === 'delighted') return 'excited';
    if (m === 'friendly' || m === 'warm' || m === 'smile') return 'friendly';
    if (m === 'focus' || m === 'focused' || m === 'think' || m === 'studious') return 'focus';
    if (m === 'listen' || m === 'attentive' || m === 'curious') return 'listen';
    if (m === 'surprise' || m === 'surprised') return 'surprise';
    if (m === 'annoyed' || m === 'guarded' || m === 'grumpy') return 'annoyed';
    if (m === 'tired' || m === 'exhausted' || m === 'sleepy') return 'tired';
    if (m === 'sad' || m === 'down') return 'sad';
    if (m === 'sleep' || m === 'sleeping') return 'sleep';
  }
  if (inDialogue) return speaking ? 'friendly' : 'listen';
  const a = (act || 'idle').toLowerCase();
  if (a === 'sleep') return 'sleep';
  if (a === 'celebrate' || a === 'wave' || a === 'guitar') return 'happy';
  if (a === 'study' || a === 'read' || a === 'write' || a === 'computer' || a === 'cook' || a === 'shoot_basket') return 'focus';
  if (a === 'talk' || a === 'present') return 'friendly';
  if (a === 'listen') return 'listen';
  return 'neutral';
}

function hashKey(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function disposeSkeletons(root: T.Object3D) {
  const seen = new Set<T.Skeleton>();
  root.traverse((o) => {
    const sk = (o as T.SkinnedMesh).isSkinnedMesh ? (o as T.SkinnedMesh).skeleton : null;
    if (sk && !seen.has(sk)) {
      seen.add(sk);
      sk.dispose();
    }
  });
}

function disposeGltf(g: GLTF) {
  const roots = new Set([g.scene, ...g.scenes]);
  const skeletons = new Set<T.Skeleton>();
  const geoms = new Set<T.BufferGeometry>(),
    mats = new Set<T.Material>(),
    texs = new Set<T.Texture>();
  for (const root of roots) {
    root.traverse((o) => {
      if ((o as T.SkinnedMesh).isSkinnedMesh) skeletons.add((o as T.SkinnedMesh).skeleton);
      const m = o as T.Mesh;
      if (!m.isMesh) return;
      if (m.geometry) geoms.add(m.geometry);
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if (!mat) continue;
        mats.add(mat);
        for (const v of Object.values(mat)) if (v instanceof T.Texture) texs.add(v);
      }
    });
  }
  for (const sk of skeletons) sk.dispose();
  const images = new Set<ImageBitmap>();
  for (const tx of texs) {
    tx.dispose();
    if (
      !isDedupManagedTexture(tx) &&
      typeof ImageBitmap !== 'undefined' &&
      tx.source.data instanceof ImageBitmap
    ) {
      images.add(tx.source.data);
    }
  }
  if (!T.Cache.enabled) for (const bitmap of images) bitmap.close();
  for (const mt of mats) mt.dispose();
  for (const gm of geoms) gm.dispose();
}
