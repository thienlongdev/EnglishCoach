import * as T from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  type ClipGaitMeta,
  type SchmittLocomotionBand,
  type StanceWeightsSnapshot,
  applyYawRateDeadzone,
  blendStanceSnapshots,
  clipStrideTimeScale,
  closeClipLoopSeam,
  computeTargetBankRoll,
  createStanceWeightsSnapshot,
  detrendClipYawAndCloseSeam,
  getCachedClipGaitMeta,
  measureClipGaitMeta,
  sampleClipStanceLut,
  setCachedClipGaitMeta,
  STANCE_LUT_SIZE,
  stepFilteredYawRate,
  stepSchmittLocomotionBand,
  synthesizeMirroredTurnRight,
  upgradeGaitUpperBody,
} from '@/lib/embodiment/locomotionBiomech';
import {
  DeadBlendInertializer,
  getOrBuildMotionMatchDb,
  clearMotionMatchCache,
  type MotionMatchDatabase,
} from './deadBlend';

export {
  type ClipGaitMeta,
  type StanceWeightsSnapshot,
  clipStrideTimeScale,
  getCachedClipGaitMeta,
};

/**
 * Universal Cross-Rig Retargeter & Biomechanical Locomotion State Machine for Echo Life.
 *
 * Key architectural guarantees across all 30 character models (`RunnerRig`, `EchoStudentRig`, `Codex52`):
 *  1. **Pure Bind-Frame World-Delta Retargeting (`RC-A1` fix):** Zero child-vector `poseAlign` on
 *     `hips`, `spine`, `chest`, `neck`, `head`, or `shoulder.L/R` (eliminates backward pelvis tilt and
 *     clavicle shrugging on `Codex52`), smooth 4-bone `Spine -> Spine1 -> Spine2` lumbar/thoracic split,
 *     and gentle bind-direction alignment only on `upper_arm`, `forearm`, `hand`, and `Codex52` `thigh`.
 *  2. **Source Clip Repair & Athletic Upper Body:** Repairs the 9 raw `RunnerRig` clips in `all48` and
 *     `crowd_*` GLBs, detrends `Walk_Brisk`'s `34.3°` mocap curve yaw drift (`0.00°` loop seam), replaces
 *     broken stationary `Turn_R` (`2.6°`) with an exact sagittal mirror of `Turn_L` (`-47.0°`), upgrades
 *     `Walk` / `Walk_Brisk` / `Run` upper-body arm swing (`75.5°–90.5°` Run elbow drive, inward palms),
 *     and removes post-retarget upward ankle hover bias so near and far NPCs stand flush on pavement.
 *  3. **Target-Angle Standing & Seated Lap Arm Relaxation:** Pulls calm standing clips (`idle`, `breathing`,
 *     `stand_up`) cleanly to `~8.5°` (`0.15 rad`) natural hang across all rig families (including same-family
 *     embedded clips), tames wide elbows on standing prop/dialogue clips, and rests `sit_idle` / `sit`
 *     hands naturally on the thighs instead of `91.3°` horizontal mid-air zombie forearms.
 *  4. **Lazy Per-Clip Pack Binding & Master-Phase Dual-Clip Locomotion:** `bindPack` pre-warms only the
 *     7-clip locomotion pose-search core and lazily retargets remaining activity clips on first demand;
 *     locomotion uses Schmitt-trigger hysteresis (`0.13/0.06`, `1.58/1.34`, `2.22/1.92 m/s`), zero
 *     blocked-NPC moonwalk, master-phase `Phi in [0, 1)` dual-clip stride matching via empirical
 *     `ClipGaitMeta.nativeStanceSpeed`, and character-root world-space centripetal torso lean with
 *     snapshot restore (`0` unbounded spine drift, `0` sideways hip/foot wobble).
 */

export const ALL48_PACK_URL = '/echo-life/animations/all48-47eccef24467.glb';

export type RigFamily = 'RunnerRig' | 'EchoStudentRig' | 'Codex52';

export type CanonicalBone =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'neck'
  | 'head'
  | 'shoulder.L'
  | 'upper_arm.L'
  | 'forearm.L'
  | 'hand.L'
  | 'shoulder.R'
  | 'upper_arm.R'
  | 'forearm.R'
  | 'hand.R'
  | 'thigh.L'
  | 'shin.L'
  | 'foot.L'
  | 'thigh.R'
  | 'shin.R'
  | 'foot.R';

const CANONICAL_ORDER: readonly CanonicalBone[] = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'shoulder.L',
  'upper_arm.L',
  'forearm.L',
  'hand.L',
  'shoulder.R',
  'upper_arm.R',
  'forearm.R',
  'hand.R',
  'thigh.L',
  'shin.L',
  'foot.L',
  'thigh.R',
  'shin.R',
  'foot.R',
];

const CANONICAL_PARENT: Record<CanonicalBone, CanonicalBone | null> = {
  hips: null,
  spine: 'hips',
  chest: 'spine',
  neck: 'chest',
  head: 'neck',
  'shoulder.L': 'chest',
  'upper_arm.L': 'shoulder.L',
  'forearm.L': 'upper_arm.L',
  'hand.L': 'forearm.L',
  'shoulder.R': 'chest',
  'upper_arm.R': 'shoulder.R',
  'forearm.R': 'upper_arm.R',
  'hand.R': 'forearm.R',
  'thigh.L': 'hips',
  'shin.L': 'thigh.L',
  'foot.L': 'shin.L',
  'thigh.R': 'hips',
  'shin.R': 'thigh.R',
  'foot.R': 'shin.R',
};

const CANONICAL_CHILD: Partial<Record<CanonicalBone, CanonicalBone>> = {
  hips: 'spine',
  spine: 'chest',
  chest: 'neck',
  neck: 'head',
  'shoulder.L': 'upper_arm.L',
  'upper_arm.L': 'forearm.L',
  'forearm.L': 'hand.L',
  'shoulder.R': 'upper_arm.R',
  'upper_arm.R': 'forearm.R',
  'forearm.R': 'hand.R',
  'thigh.L': 'shin.L',
  'shin.L': 'foot.L',
  'thigh.R': 'shin.R',
  'shin.R': 'foot.R',
};

interface RestEntry {
  t: readonly [number, number, number];
  r: readonly [number, number, number, number];
}

const RUNNER_RIG_REST: Record<CanonicalBone, RestEntry> = {
  hips: { t: [0, 0.895, -0.005], r: [-0.01154, 0, 0, 0.99993] },
  spine: { t: [0, 0.13003, 0], r: [0.02486, 0, 0, 0.99969] },
  chest: { t: [0, 0.15005, 0], r: [-0.01921, 0, 0, 0.99982] },
  neck: { t: [0, 0.17001, 0], r: [0.02809, 0, 0, 0.99961] },
  head: { t: [0, 0.09009, 0], r: [-0.01836, 0, 0, 0.99983] },
  'shoulder.L': { t: [0.035, 0.14501, -0.00029], r: [-0.00727, 0.01578, -0.71266, 0.7013] },
  'upper_arm.L': { t: [0, 0.12308, 0], r: [-0.00214, 0.01394, -0.40001, 0.9164] },
  'forearm.L': { t: [0, 0.2401, 0], r: [0.05131, -0.00013, -0.00925, 0.99864] },
  'hand.L': { t: [0, 0.2055, 0], r: [0.10542, 0.6992, -0.06853, 0.70378] },
  'shoulder.R': { t: [-0.035, 0.14501, -0.00029], r: [-0.00727, -0.01578, 0.71266, 0.7013] },
  'upper_arm.R': { t: [0, 0.12308, 0], r: [-0.00214, -0.01394, 0.40001, 0.9164] },
  'forearm.R': { t: [0, 0.2401, 0], r: [0.05131, 0.00013, 0.00925, 0.99864] },
  'hand.R': { t: [0, 0.2055, 0], r: [0.10542, -0.69921, 0.06853, 0.70378] },
  'thigh.L': { t: [0.084, 0.00002, -0.001], r: [-0.00021, -0.00145, -0.99991, 0.01298] },
  'shin.L': { t: [0, 0.38532, 0], r: [-0.03728, 0.00042, -0.00809, 0.99927] },
  'foot.L': { t: [0, 0.41158, 0], r: [0.52869, -0.0022, -0.00435, 0.8488] },
  'thigh.R': { t: [-0.084, 0.00002, -0.001], r: [-0.00021, 0.00145, 0.99991, 0.01298] },
  'shin.R': { t: [0, 0.38532, 0], r: [-0.03728, -0.00042, 0.00809, 0.99927] },
  'foot.R': { t: [0, 0.41158, 0], r: [0.52869, 0.0022, 0.00435, 0.8488] },
};

const ECHO_RIG_REST: Record<CanonicalBone, RestEntry> = {
  hips: { t: [0, 0.89955, 0.01445], r: [-0.20129, 0, 0, 0.97953] },
  spine: { t: [0, 0.06105, 0], r: [0.3064, 0, 0, 0.9519] },
  chest: { t: [0, 0.16486, 0], r: [-0.13917, 0, 0, 0.99027] },
  neck: { t: [0, 0.30995, 0], r: [0.07346, 0, 0, 0.9973] },
  head: { t: [0, 0.10887, 0], r: [-0.04261, 0, 0, 0.99909] },
  'shoulder.L': { t: [0.02656, 0.22624, 0.05756], r: [-0.11374, 0.14242, -0.6519, 0.73608] },
  'upper_arm.L': { t: [0, 0.15223, 0], r: [0.15857, 0.08833, -0.4661, 0.86591] },
  'forearm.L': { t: [0, 0.22761, 0], r: [0.2431, 0.01863, 0.07608, 0.96683] },
  'hand.L': { t: [0, 0.22632, 0], r: [0.10885, 0.6615, -0.06293, 0.73933] },
  'shoulder.R': { t: [-0.02655, 0.22624, 0.05756], r: [-0.11374, -0.14242, 0.6519, 0.73608] },
  'upper_arm.R': { t: [0, 0.15223, 0], r: [0.15857, -0.08833, 0.4661, 0.86591] },
  'forearm.R': { t: [0, 0.22761, 0], r: [0.2431, -0.01863, -0.07608, 0.96683] },
  'hand.R': { t: [0, 0.22632, 0], r: [0.10885, -0.6615, 0.06293, 0.73933] },
  'thigh.L': { t: [0.11037, -0.02127, -0.01147], r: [0.0026, -0.17793, 0.98398, 0.01127] },
  'shin.L': { t: [0, 0.41119, 0], r: [-0.06696, -0.00049, 0.02506, 0.99744] },
  'foot.L': { t: [0, 0.38173, 0], r: [0.56384, -0.04367, 0.00916, 0.82468] },
  'thigh.R': { t: [-0.11037, -0.02127, -0.01147], r: [0.0026, 0.17793, -0.98398, 0.01127] },
  'shin.R': { t: [0, 0.41119, 0], r: [-0.06696, 0.00049, -0.02506, 0.99744] },
  'foot.R': { t: [0, 0.38173, 0], r: [0.56384, 0.04367, -0.00916, 0.82468] },
};

/** The 9 clips verified by binary inspection to carry raw `RunnerRig` local bone rotations. */
export const RAW_RUNNERRIG_CLIP_NAMES = new Set([
  'walk',
  'walk_brisk',
  'run',
  'turn_l',
  'turn_r',
  'run_stop',
  'pick_up_floor',
  'greet_wave',
  'festival_celebrate',
]);

/** Codex52 Mixamo bone names per canonical bone. */
const CODEX52_MAP: Record<CanonicalBone, string> = {
  hips: 'Hips',
  spine: 'Spine',
  chest: 'Spine2',
  neck: 'Neck',
  head: 'Head',
  'shoulder.L': 'LeftShoulder',
  'upper_arm.L': 'LeftArm',
  'forearm.L': 'LeftForeArm',
  'hand.L': 'LeftHand',
  'shoulder.R': 'RightShoulder',
  'upper_arm.R': 'RightArm',
  'forearm.R': 'RightForeArm',
  'hand.R': 'RightHand',
  'thigh.L': 'LeftUpLeg',
  'shin.L': 'LeftLeg',
  'foot.L': 'LeftFoot',
  'thigh.R': 'RightUpLeg',
  'shin.R': 'RightLeg',
  'foot.R': 'RightFoot',
};

const ALIAS_TO_CANONICAL = new Map<string, CanonicalBone>();
for (const key of CANONICAL_ORDER) {
  ALIAS_TO_CANONICAL.set(key, key);
  ALIAS_TO_CANONICAL.set(key.replace(/\./g, ''), key);
  ALIAS_TO_CANONICAL.set(key.toLowerCase(), key);
  ALIAS_TO_CANONICAL.set(key.replace(/\./g, '').toLowerCase(), key);
  const c52 = CODEX52_MAP[key];
  ALIAS_TO_CANONICAL.set(c52, key);
  ALIAS_TO_CANONICAL.set(c52.toLowerCase(), key);
}

const ECHO_HIPS_REST_Q = new T.Quaternion(...ECHO_RIG_REST.hips.r);
const RUNNER_HIPS_REST_Q = new T.Quaternion(...RUNNER_RIG_REST.hips.r);
const IDENTITY_Q = new T.Quaternion();
const WORLD_X_AXIS = new T.Vector3(1, 0, 0);
const WORLD_Y_AXIS = new T.Vector3(0, 1, 0);
const WORLD_Z_AXIS = new T.Vector3(0, 0, 1);

interface ComputedRestPose {
  localQ: Record<CanonicalBone, T.Quaternion>;
  worldQ: Record<CanonicalBone, T.Quaternion>;
  worldDir: Partial<Record<CanonicalBone, T.Vector3>>;
  hipsY: number;
}

function computeRestFromTable(table: Record<CanonicalBone, RestEntry>): ComputedRestPose {
  const localQ = {} as Record<CanonicalBone, T.Quaternion>;
  const worldQ = {} as Record<CanonicalBone, T.Quaternion>;
  const worldP = {} as Record<CanonicalBone, T.Vector3>;
  const worldDir: Partial<Record<CanonicalBone, T.Vector3>> = {};
  for (const b of CANONICAL_ORDER) {
    const e = table[b];
    const q = new T.Quaternion(e.r[0], e.r[1], e.r[2], e.r[3]).normalize();
    localQ[b] = q;
    const p = CANONICAL_PARENT[b];
    if (!p) {
      worldQ[b] = q.clone();
      worldP[b] = new T.Vector3(e.t[0], e.t[1], e.t[2]);
    } else {
      worldQ[b] = worldQ[p].clone().multiply(q);
      worldP[b] = new T.Vector3(e.t[0], e.t[1], e.t[2]).applyQuaternion(worldQ[p]).add(worldP[p]);
    }
  }
  for (const b of CANONICAL_ORDER) {
    const ch = CANONICAL_CHILD[b];
    if (ch) {
      const dir = worldP[ch].clone().sub(worldP[b]);
      if (dir.lengthSq() > 1e-8) worldDir[b] = dir.normalize();
    } else {
      worldDir[b] = new T.Vector3(0, 1, 0).applyQuaternion(worldQ[b]).normalize();
    }
  }
  return { localQ, worldQ, worldDir, hipsY: table.hips.t[1] };
}

const RUNNER_REST_COMPUTED = computeRestFromTable(RUNNER_RIG_REST);
const ECHO_REST_COMPUTED = computeRestFromTable(ECHO_RIG_REST);

/** Detects which of the 3 character rig families a loaded Three.js scene belongs to. */
export function detectRigFamily(root: T.Object3D): RigFamily {
  let hasMixamo = false;
  let hasScarf = false;
  let hipsQ: T.Quaternion | null = null;
  root.traverse((o) => {
    if (!(o as T.Bone).isBone) return;
    const n = (o.userData.name as string | undefined) ?? o.name;
    if (n === 'Hips' || n === 'LeftUpLeg' || n === 'Spine2') hasMixamo = true;
    if (/^scarf[._]?L/i.test(n)) hasScarf = true;
    if (n === 'hips') hipsQ = o.quaternion;
  });
  if (hasMixamo) return 'Codex52';
  if (hasScarf) return 'RunnerRig';
  if (hipsQ && (hipsQ as T.Quaternion).angleTo(ECHO_HIPS_REST_Q) < 0.18) return 'EchoStudentRig';
  return 'RunnerRig';
}

/**
 * Inspects a clip's `hips.quaternion` at `t = 0` (plus the verified allowlist) to determine whether
 * the clip carries raw `RunnerRig` local rotations (which cause the hunched squat on `EchoStudentRig`).
 */
export function detectClipSourceFamily(clip: T.AnimationClip, fallback: RigFamily = 'EchoStudentRig'): RigFamily {
  const lower = clip.name.toLowerCase();
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.');
    const boneRaw = dot >= 0 ? track.name.slice(0, dot) : track.name;
    const prop = dot >= 0 ? track.name.slice(dot + 1) : '';
    if (prop !== 'quaternion') continue;
    if (boneRaw === 'Hips') return 'Codex52';
    if (boneRaw === 'hips' && track.values.length >= 4) {
      const q0 = new T.Quaternion(track.values[0], track.values[1], track.values[2], track.values[3]).normalize();
      const dEcho = q0.angleTo(ECHO_HIPS_REST_Q);
      const dRunner = q0.angleTo(RUNNER_HIPS_REST_Q);
      if (dEcho > 0.25 && dRunner < 0.30) return 'RunnerRig';
      if (dEcho < 0.16) return 'EchoStudentRig';
    }
  }
  if (RAW_RUNNERRIG_CLIP_NAMES.has(lower)) return 'RunnerRig';
  return fallback;
}

export interface TargetSkeletonInfo {
  family: RigFamily;
  poseSignature: string;
  bones: Partial<Record<CanonicalBone, T.Bone>>;
  spine1: T.Bone | null;
  worldRestQ: Partial<Record<CanonicalBone, T.Quaternion>>;
  worldRestP: Partial<Record<CanonicalBone, T.Vector3>>;
  spine1WorldRestQ: T.Quaternion | null;
  worldRestDir: Partial<Record<CanonicalBone, T.Vector3>>;
  hipsRestPos: T.Vector3;
  hipsWorldP: T.Vector3;
  hipsWorldY: number;
  footRestYL: number;
  footRestYR: number;
  hipsParentModelQ: T.Quaternion;
  hipsParentInvQ: T.Quaternion;
  hipsParentInvScale: number;
}

const SIGNATURE_BONES: readonly CanonicalBone[] = [
  'hips',
  'spine',
  'chest',
  'shoulder.L',
  'shoulder.R',
  'upper_arm.L',
  'upper_arm.R',
  'thigh.L',
  'thigh.R',
];

function computePoseSignatureFromBones(
  family: RigFamily,
  bones: Partial<Record<CanonicalBone, T.Bone>>,
  spine1: T.Bone | null,
): string {
  let h = 2166136261;
  const mixInt = (n: number) => {
    h ^= n & 0xffff;
    h = Math.imul(h, 16777619);
  };
  const mixQuat = (q: T.Quaternion | undefined) => {
    if (!q) {
      mixInt(0x7fff);
      return;
    }
    const sign = q.w < 0 ? -1 : 1;
    mixInt(Math.round(q.x * sign * 100));
    mixInt(Math.round(q.y * sign * 100));
    mixInt(Math.round(q.z * sign * 100));
    mixInt(Math.round(q.w * sign * 100));
  };
  for (const k of SIGNATURE_BONES) mixQuat(bones[k]?.quaternion);
  if (spine1) mixQuat(spine1.quaternion);
  return `${family}_${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/** Public helper computing a skeleton's exact rest-pose signature hash for retarget caching & diagnostics. */
export function computeSkeletonPoseSignature(root: T.Object3D, family = detectRigFamily(root)): string {
  return inspectTargetSkeleton(root, family).poseSignature;
}

function inspectTargetSkeleton(root: T.Object3D, family: RigFamily): TargetSkeletonInfo {
  root.updateWorldMatrix(true, true);
  const rootInvQ = root.getWorldQuaternion(new T.Quaternion()).invert();
  const rootInvM = root.matrixWorld.clone().invert();
  const byName = new Map<string, T.Bone>();
  root.traverse((o) => {
    if (!(o as T.Bone).isBone) return;
    const b = o as T.Bone;
    byName.set(b.name, b);
    const authored = b.userData.name as string | undefined;
    if (authored) byName.set(authored, b);
  });

  const bones: Partial<Record<CanonicalBone, T.Bone>> = {};
  const worldRestQ: Partial<Record<CanonicalBone, T.Quaternion>> = {};
  const worldRestP: Partial<Record<CanonicalBone, T.Vector3>> = {};
  const worldRestDir: Partial<Record<CanonicalBone, T.Vector3>> = {};

  for (const key of CANONICAL_ORDER) {
    const candidates =
      family === 'Codex52'
        ? [CODEX52_MAP[key]]
        : [key, key.replace(/\./g, '')];
    let found: T.Bone | undefined;
    for (const c of candidates) {
      found = byName.get(c);
      if (found) break;
    }
    if (!found) continue;
    bones[key] = found;
    worldRestQ[key] = rootInvQ.clone().multiply(found.getWorldQuaternion(new T.Quaternion())).normalize();
    worldRestP[key] = found.getWorldPosition(new T.Vector3()).applyMatrix4(rootInvM);
  }

  for (const key of CANONICAL_ORDER) {
    const p = worldRestP[key];
    const ch = CANONICAL_CHILD[key];
    const cp = ch ? worldRestP[ch] : undefined;
    if (p && cp) {
      const d = cp.clone().sub(p);
      if (d.lengthSq() > 1e-8) worldRestDir[key] = d.normalize();
    } else if (worldRestQ[key]) {
      worldRestDir[key] = new T.Vector3(0, 1, 0).applyQuaternion(worldRestQ[key]!).normalize();
    }
  }

  const spine1 = family === 'Codex52' ? byName.get('Spine1') ?? null : null;
  const spine1WorldRestQ = spine1
    ? rootInvQ.clone().multiply(spine1.getWorldQuaternion(new T.Quaternion())).normalize()
    : null;

  const hips = bones.hips;
  const hipsRestPos = hips ? hips.position.clone() : new T.Vector3(0, 0.89, 0);
  const hipsWorldP = worldRestP.hips ? worldRestP.hips.clone() : new T.Vector3(0, 0.89, 0);
  const hipsWorldY = hipsWorldP.y;
  const footRestYL = worldRestP['foot.L']?.y ?? 0.08;
  const footRestYR = worldRestP['foot.R']?.y ?? 0.08;

  const hipsParentModelQ = hips?.parent
    ? rootInvQ.clone().multiply(hips.parent.getWorldQuaternion(new T.Quaternion())).normalize()
    : new T.Quaternion();
  const hipsParentInvQ = hipsParentModelQ.clone().invert();

  const rootScale = root.getWorldScale(new T.Vector3()).x || 1;
  const parentScale = hips?.parent ? hips.parent.getWorldScale(new T.Vector3()).x / rootScale : 1;
  const poseSignature = computePoseSignatureFromBones(family, bones, spine1);

  return {
    family,
    poseSignature,
    bones,
    spine1,
    worldRestQ,
    worldRestP,
    spine1WorldRestQ,
    worldRestDir,
    hipsRestPos,
    hipsWorldP,
    hipsWorldY,
    footRestYL,
    footRestYR,
    hipsParentModelQ,
    hipsParentInvQ,
    hipsParentInvScale: parentScale > 1e-4 ? 1 / parentScale : 1,
  };
}

/** Sample a `QuaternionKeyframeTrack` at arbitrary time `t` with shortest-arc slerp. */
function sampleQuatTrack(track: T.KeyframeTrack, t: number, out: T.Quaternion): T.Quaternion {
  const times = track.times;
  const vals = track.values;
  const n = times.length;
  if (n === 0) return out.identity();
  if (n === 1 || t <= times[0]) return out.set(vals[0], vals[1], vals[2], vals[3]).normalize();
  if (t >= times[n - 1]) {
    const o = (n - 1) * 4;
    return out.set(vals[o], vals[o + 1], vals[o + 2], vals[o + 3]).normalize();
  }
  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  const alpha = span > 1e-6 ? (t - times[lo]) / span : 0;
  const a = lo * 4;
  const b = hi * 4;
  const qa = _tmpQ1.set(vals[a], vals[a + 1], vals[a + 2], vals[a + 3]).normalize();
  const qb = _tmpQ2.set(vals[b], vals[b + 1], vals[b + 2], vals[b + 3]).normalize();
  return out.copy(qa).slerp(qb, alpha).normalize();
}

/** Sample a `VectorKeyframeTrack` at arbitrary time `t` with linear interpolation. */
function sampleVecTrack(track: T.KeyframeTrack, t: number, out: T.Vector3): T.Vector3 {
  const times = track.times;
  const vals = track.values;
  const n = times.length;
  if (n === 0) return out.set(0, 0, 0);
  if (n === 1 || t <= times[0]) return out.set(vals[0], vals[1], vals[2]);
  if (t >= times[n - 1]) {
    const o = (n - 1) * 3;
    return out.set(vals[o], vals[o + 1], vals[o + 2]);
  }
  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  const alpha = span > 1e-6 ? (t - times[lo]) / span : 0;
  const a = lo * 3;
  const b = hi * 3;
  return out.set(
    vals[a] + (vals[b] - vals[a]) * alpha,
    vals[a + 1] + (vals[b + 1] - vals[a + 1]) * alpha,
    vals[a + 2] + (vals[b + 2] - vals[a + 2]) * alpha,
  );
}

const _tmpQ1 = new T.Quaternion();
const _tmpQ2 = new T.Quaternion();
const _tmpQ3 = new T.Quaternion();
const _tmpQ4 = new T.Quaternion();
const _tmpQ5 = new T.Quaternion();
const _tmpQ6 = new T.Quaternion();
const _tmpQ7 = new T.Quaternion();
const _tmpV1 = new T.Vector3();
const _tmpV2 = new T.Vector3();
const _tmpV3 = new T.Vector3();
const _tmpV4 = new T.Vector3();

// ── Posture Refinement & Grounded Clip Classification Sets ────────────────────────────────────────────

/** Calm standing clips pulled cleanly to natural `~8.5°` (`0.15 rad`) arm hang across all rigs. */
const CALM_STANDING_RELAX_CLIPS = new Set(['idle', 'breathing', 'stand_up']);

/** Conversational & standing-prop clips whose wide A-pose elbows are tucked without crushing gestures. */
const ACTIVE_STANDING_RELAX_CLIPS = new Set([
  'listen_nod',
  'talk_gesture',
  'study_read',
  'drink_cup',
  'open_door',
  'present',
  'festival_present',
]);

/** Seated idle & sit-down clips whose `91.3°` horizontal zombie forearms are lowered naturally onto the thighs. */
const SEATED_LAP_RELAX_CLIPS = new Set(['sit_idle', 'sit', 'sit_down']);

const ALL_POSTURE_RELAX_CLIPS = new Set([
  ...CALM_STANDING_RELAX_CLIPS,
  ...ACTIVE_STANDING_RELAX_CLIPS,
  ...SEATED_LAP_RELAX_CLIPS,
]);

/** Grounded standing/locomotion clips whose upward ankle hover bias is baked out of `hips.position.y`. */
const GROUNDED_HOVER_FIX_CLIPS = new Set([
  'idle',
  'breathing',
  'walk',
  'walk_brisk',
  'run',
  'run_stop',
  'turn_l',
  'turn_r',
  'listen_nod',
  'talk_gesture',
  'stand_up',
  'study_read',
  'drink_cup',
  'open_door',
  'present',
  'festival_present',
  'greet_wave',
  'festival_celebrate',
]);

const STATIC_STANDING_META_CLIPS = new Set([
  'idle',
  'breathing',
  'listen_nod',
  'talk_gesture',
  'study_read',
  'drink_cup',
  'open_door',
  'present',
  'festival_present',
  'greet_wave',
]);

const _preparedSourceClipCache = new WeakMap<T.AnimationClip, T.AnimationClip>();

/**
 * Repairs raw `RunnerRig` source clips once before cross-rig retargeting:
 *  - `Walk_Brisk`: removes `-19.4° -> +14.9°` mocap curve yaw drift (`0.00°` loop seam) + upgrades upper body.
 *  - `Walk` & `Run`: upgrades upper-body arm swing (`75.5°–90.5°` Run elbow drive, inward palms) + C2 seam closure.
 *  - `Turn_L` & `Turn_R`: strips linear mocap root yaw drift so `root.rotation.y` owns world heading cleanly.
 */
function prepareSourceClip(rawClip: T.AnimationClip, sourceFamily: RigFamily, clipLower: string): T.AnimationClip {
  const cached = _preparedSourceClipCache.get(rawClip);
  if (cached) return cached;

  let prepared = rawClip;
  if (sourceFamily === 'RunnerRig') {
    if (clipLower === 'walk') {
      const detrended = detrendClipYawAndCloseSeam(rawClip, {
        stripLinearYawDrift: false,
        stripMeanYaw: true,
        closeLoopSeam: true,
      });
      prepared = closeClipLoopSeam(upgradeGaitUpperBody(detrended, null, 'Walk'), 0.16);
    } else if (clipLower === 'walk_brisk') {
      const detrended = detrendClipYawAndCloseSeam(rawClip, {
        stripLinearYawDrift: true,
        stripMeanYaw: true,
        closeLoopSeam: true,
      });
      prepared = closeClipLoopSeam(upgradeGaitUpperBody(detrended, null, 'Walk_Brisk'), 0.16);
    } else if (clipLower === 'run') {
      const detrended = detrendClipYawAndCloseSeam(rawClip, {
        stripLinearYawDrift: false,
        stripMeanYaw: true,
        closeLoopSeam: true,
      });
      prepared = closeClipLoopSeam(upgradeGaitUpperBody(detrended, null, 'Run'), 0.16);
    } else if (clipLower === 'turn_l' || clipLower === 'turn_r') {
      prepared = detrendClipYawAndCloseSeam(rawClip, {
        stripLinearYawDrift: true,
        stripMeanYaw: true,
        closeLoopSeam: true,
      });
    }
  }

  _preparedSourceClipCache.set(rawClip, prepared);
  return prepared;
}

function buildFastGaitMetaFromSamples(
  duration: number,
  steps: number,
  yL: Float32Array,
  zL: Float32Array,
  yR: Float32Array,
  zR: Float32Array,
  zHips: Float32Array,
  residualHoverY: number,
  isStaticStanding: boolean,
): ClipGaitMeta {
  const n = STANCE_LUT_SIZE;
  const stanceL = new Float32Array(n);
  const stanceR = new Float32Array(n);
  const stanceProgressL = new Float32Array(n).fill(0.45);
  const stanceProgressR = new Float32Array(n).fill(0.45);

  let minYL = Infinity;
  let maxYL = -Infinity;
  let minYR = Infinity;
  let maxYR = -Infinity;

  const lutYL = new Float32Array(n);
  const lutZL = new Float32Array(n);
  const lutYR = new Float32Array(n);
  const lutZR = new Float32Array(n);
  const lutZH = new Float32Array(n);

  for (let k = 0; k < n; k++) {
    const pos = (k / n) * steps;
    const i0 = Math.min(steps, Math.floor(pos));
    const i1 = Math.min(steps, i0 + 1);
    const f = pos - i0;
    const yl = yL[i0] + (yL[i1] - yL[i0]) * f;
    const zl = zL[i0] + (zL[i1] - zL[i0]) * f;
    const yr = yR[i0] + (yR[i1] - yR[i0]) * f;
    const zr = zR[i0] + (zR[i1] - zR[i0]) * f;
    const zh = zHips[i0] + (zHips[i1] - zHips[i0]) * f;

    lutYL[k] = yl;
    lutZL[k] = zl;
    lutYR[k] = yr;
    lutZR[k] = zr;
    lutZH[k] = zh;

    if (yl < minYL) minYL = yl;
    if (yl > maxYL) maxYL = yl;
    if (yr < minYR) minYR = yr;
    if (yr > maxYR) maxYR = yr;
  }

  const spanY = Math.max(maxYL - minYL, maxYR - minYR);
  if (isStaticStanding || spanY < 0.012 || !(duration > 1e-4)) {
    stanceL.fill(1);
    stanceR.fill(1);
    return {
      nativeStanceSpeed: 0,
      leftFootForwardFrac: 0,
      minAnkleDeltaY: residualHoverY,
      stanceL,
      stanceR,
      stanceProgressL,
      stanceProgressR,
    };
  }

  const dtSample = duration / n;
  const hipsLinearSpeedZ = (lutZH[n - 1] - lutZH[0]) / Math.max(1e-4, duration * ((n - 1) / n));
  const rawL = new Float32Array(n);
  const rawR = new Float32Array(n);
  const speeds: number[] = [];

  for (let k = 0; k < n; k++) {
    const prev = (k - 1 + n) % n;
    const next = (k + 1) % n;
    const twoDt = 2 * dtSample;

    const vBackL = -((lutZL[next] - lutZL[prev]) / twoDt - hipsLinearSpeedZ);
    const vBackR = -((lutZR[next] - lutZR[prev]) / twoDt - hipsLinearSpeedZ);

    const hL = lutYL[k] - minYL;
    const hR = lutYR[k] - minYR;

    let wL = 1 - T.MathUtils.smoothstep(hL, 0.014, 0.038);
    if (vBackL < -0.15) wL *= 1 - T.MathUtils.smoothstep(-vBackL, 0.15, 0.75);
    rawL[k] = wL;

    let wR = 1 - T.MathUtils.smoothstep(hR, 0.014, 0.038);
    if (vBackR < -0.15) wR *= 1 - T.MathUtils.smoothstep(-vBackR, 0.15, 0.75);
    rawR[k] = wR;

    if (hL <= 0.020 && vBackL > 0.05) speeds.push(vBackL);
    if (hR <= 0.020 && vBackR > 0.05) speeds.push(vBackR);
  }

  // Two-pass periodic [0.25, 0.5, 0.25] C1 smoothing
  const tmp = new Float32Array(n);
  for (const [src, dst] of [
    [rawL, stanceL],
    [rawR, stanceR],
  ] as const) {
    for (let k = 0; k < n; k++) {
      tmp[k] = 0.25 * src[(k - 1 + n) % n] + 0.5 * src[k] + 0.25 * src[(k + 1) % n];
    }
    for (let k = 0; k < n; k++) {
      dst[k] = 0.25 * tmp[(k - 1 + n) % n] + 0.5 * tmp[k] + 0.25 * tmp[(k + 1) % n];
    }
  }

  // Periodic stance progress [0..1]
  for (const [st, prog] of [
    [stanceL, stanceProgressL],
    [stanceR, stanceProgressR],
  ] as const) {
    let startSwing = -1;
    let anyStance = false;
    for (let k = 0; k < n; k++) {
      if (st[k] >= 0.15) anyStance = true;
      else if (startSwing < 0) startSwing = k;
    }
    if (!anyStance || startSwing < 0) continue;
    let idx = 0;
    while (idx < n) {
      const c = (startSwing + idx) % n;
      if (st[c] < 0.15) {
        idx++;
        continue;
      }
      const runStart = idx;
      while (idx < n && st[(startSwing + idx) % n] >= 0.15) idx++;
      const runLen = idx - runStart;
      const denom = Math.max(1, runLen - 1);
      for (let j = 0; j < runLen; j++) {
        prog[(startSwing + runStart + j) % n] = runLen === 1 ? 0.5 : j / denom;
      }
    }
  }

  speeds.sort((a, b) => a - b);
  let nativeStanceSpeed = 0;
  if (speeds.length > 0) {
    const qPos = 0.72 * (speeds.length - 1);
    const q0 = Math.floor(qPos);
    const q1 = Math.min(speeds.length - 1, q0 + 1);
    nativeStanceSpeed = speeds[q0] + (speeds[q1] - speeds[q0]) * (qPos - q0);
  }

  let bestK = 0;
  let bestLead = -Infinity;
  for (let k = 0; k < n; k++) {
    const lead = lutZL[k] - lutZR[k];
    if (lead > bestLead) {
      bestLead = lead;
      bestK = k;
    }
  }
  const prevLead = lutZL[(bestK - 1 + n) % n] - lutZR[(bestK - 1 + n) % n];
  const nextLead = lutZL[(bestK + 1) % n] - lutZR[(bestK + 1) % n];
  const denom = 2 * (2 * bestLead - prevLead - nextLead);
  const sub = Math.abs(denom) > 1e-6 ? T.MathUtils.clamp((nextLead - prevLead) / denom, -0.5, 0.5) : 0;
  const rawFrac = ((bestK + sub) / n) % 1;
  const leftFootForwardFrac = rawFrac < 0 ? rawFrac + 1 : rawFrac;

  return {
    nativeStanceSpeed,
    leftFootForwardFrac,
    minAnkleDeltaY: residualHoverY,
    stanceL,
    stanceR,
    stanceProgressL,
    stanceProgressR,
  };
}

/**
 * Exact world-space rest-pose delta retargeter (`RunnerRig` <-> `EchoStudentRig` <-> `Codex52`).
 */
export function retargetClip(
  rawSourceClip: T.AnimationClip,
  targetRoot: T.Object3D,
  options: {
    sourceFamily?: RigFamily;
    targetFamily?: RigFamily;
    targetRestInfo?: TargetSkeletonInfo;
    echoHipsTranslation?: boolean;
    name?: string;
    sampleHz?: number;
  } = {},
): T.AnimationClip {
  const targetFamily = options.targetFamily ?? detectRigFamily(targetRoot);
  const sourceFamily = options.sourceFamily ?? detectClipSourceFamily(rawSourceClip, 'EchoStudentRig');
  const clipLower = (options.name ?? rawSourceClip.name).toLowerCase();

  const sourceClip = prepareSourceClip(rawSourceClip, sourceFamily, clipLower);
  const needsPostureRelax = ALL_POSTURE_RELAX_CLIPS.has(clipLower);
  const tgt = options.targetRestInfo ?? inspectTargetSkeleton(targetRoot, targetFamily);

  // Same-family non-RunnerRig clips that don't require posture relaxation or pack hips scaling clone cleanly
  if (
    sourceFamily === targetFamily &&
    !needsPostureRelax &&
    sourceClip === rawSourceClip &&
    !(options.echoHipsTranslation && targetFamily !== 'EchoStudentRig')
  ) {
    const copy = sourceClip.clone();
    if (options.name) copy.name = options.name;
    measureClipGaitMeta(
      copy,
      targetRoot,
      { hips: tgt.bones.hips, footL: tgt.bones['foot.L'], footR: tgt.bones['foot.R'] },
      {
        restFootYL: tgt.footRestYL,
        restFootYR: tgt.footRestYR,
        isStandingStatic: STATIC_STANDING_META_CLIPS.has(clipLower),
      },
    );
    return copy;
  }

  // Support exact same-family Codex52 posture relaxation using target skeleton's own bind pose
  const srcRest: ComputedRestPose =
    sourceFamily === 'Codex52'
      ? {
          localQ: Object.fromEntries(
            CANONICAL_ORDER.map((b) => [b, tgt.bones[b]?.quaternion.clone().normalize() ?? new T.Quaternion()]),
          ) as Record<CanonicalBone, T.Quaternion>,
          worldQ: Object.fromEntries(
            CANONICAL_ORDER.map((b) => [b, tgt.worldRestQ[b]?.clone() ?? new T.Quaternion()]),
          ) as Record<CanonicalBone, T.Quaternion>,
          worldDir: tgt.worldRestDir,
          hipsY: tgt.hipsWorldY,
        }
      : sourceFamily === 'RunnerRig'
        ? RUNNER_REST_COMPUTED
        : ECHO_REST_COMPUTED;

  const srcQuatTracks: Partial<Record<CanonicalBone, T.KeyframeTrack>> = {};
  let srcSpine1Track: T.KeyframeTrack | null = null;
  let srcHipsPosTrack: T.KeyframeTrack | null = null;
  for (const track of sourceClip.tracks) {
    const dot = track.name.lastIndexOf('.');
    if (dot < 0) continue;
    const boneRaw = track.name.slice(0, dot);
    const prop = track.name.slice(dot + 1);
    if (boneRaw === 'Spine1' && prop === 'quaternion') {
      srcSpine1Track = track;
      continue;
    }
    const canon = ALIAS_TO_CANONICAL.get(boneRaw) ?? ALIAS_TO_CANONICAL.get(boneRaw.toLowerCase());
    if (!canon) continue;
    if (prop === 'quaternion') srcQuatTracks[canon] = track;
    else if (prop === 'position' && canon === 'hips') srcHipsPosTrack = track;
  }

  // RC-A1 FIX: NEVER apply child-vector `bindAlign` on `hips`, `spine`, `chest`, `neck`, `head`, or `shoulder.L/R`!
  // Only align limb segments (`upper_arm`, `forearm`, `hand`, and `Codex52` `thigh` coronal splay).
  const bindAlign: Partial<Record<CanonicalBone, T.Quaternion>> = {};
  if (sourceFamily !== targetFamily) {
    for (const b of ['forearm.L', 'forearm.R', 'hand.L', 'hand.R'] as const) {
      const sd = srcRest.worldDir[b];
      const td = tgt.worldRestDir[b];
      if (sd && td) {
        const ang = td.angleTo(sd);
        if (ang > 0.08 && ang < 1.1) {
          const full = new T.Quaternion().setFromUnitVectors(td, sd);
          const maxAng = b.startsWith('hand') ? 0.42 : 0.65;
          bindAlign[b] = ang > maxAng ? new T.Quaternion().slerp(full, maxAng / ang) : full;
        }
      }
    }
    for (const b of ['upper_arm.L', 'upper_arm.R', 'thigh.L', 'thigh.R'] as const) {
      if (targetFamily !== 'Codex52' && (b === 'thigh.L' || b === 'thigh.R')) continue;
      const sd = srcRest.worldDir[b];
      const td = tgt.worldRestDir[b];
      if (sd && td) {
        const ang = td.angleTo(sd);
        if (ang > 0.04 && ang < 1.1) {
          const full = new T.Quaternion().setFromUnitVectors(td, sd);
          const maxAng = b.startsWith('thigh') ? 0.26 : 0.48;
          bindAlign[b] = ang > maxAng ? new T.Quaternion().slerp(full, maxAng / ang) : full;
        }
      }
    }
  }

  const duration = Math.max(0.05, sourceClip.duration);
  const hz = options.sampleHz ?? (duration < 0.9 ? 48 : 30);
  const steps = Math.max(2, Math.min(96, Math.round(duration * hz)));
  const times = new Float32Array(steps + 1);
  for (let i = 0; i <= steps; i++) times[i] = (duration * i) / steps;

  const quatBuffers = new Map<string, Float32Array>();
  for (const b of CANONICAL_ORDER) {
    const tb = tgt.bones[b];
    if (tb) quatBuffers.set(tb.name, new Float32Array((steps + 1) * 4));
  }
  if (tgt.spine1) quatBuffers.set(tgt.spine1.name, new Float32Array((steps + 1) * 4));

  const isGroundedHoverFix = GROUNDED_HOVER_FIX_CLIPS.has(clipLower);
  const emitHipsPos = Boolean(tgt.bones.hips && (srcHipsPosTrack || isGroundedHoverFix));
  const hipsPosBuf = emitHipsPos ? new Float32Array((steps + 1) * 3) : null;

  const srcHipsRestY = options.echoHipsTranslation ? ECHO_RIG_REST.hips.t[1] : srcRest.hipsY;
  const hipsScale = tgt.hipsWorldY / Math.max(0.2, srcHipsRestY);
  const srcHipsRestOrigin = options.echoHipsTranslation
    ? new T.Vector3(...ECHO_RIG_REST.hips.t)
    : sourceFamily === 'Codex52'
      ? tgt.hipsRestPos.clone()
      : new T.Vector3(...(sourceFamily === 'RunnerRig' ? RUNNER_RIG_REST.hips.t : ECHO_RIG_REST.hips.t));

  const srcWorldAnim = {} as Record<CanonicalBone, T.Quaternion>;
  const srcDeltaMap = {} as Record<CanonicalBone, T.Quaternion>;
  const tgtWorldAnim = {} as Record<CanonicalBone, T.Quaternion>;
  const invSrcRest = {} as Record<CanonicalBone, T.Quaternion>;
  const invTgtRest: Partial<Record<CanonicalBone, T.Quaternion>> = {};
  for (const b of CANONICAL_ORDER) {
    srcWorldAnim[b] = new T.Quaternion();
    srcDeltaMap[b] = new T.Quaternion();
    tgtWorldAnim[b] = new T.Quaternion();
    invSrcRest[b] = srcRest.worldQ[b].clone().invert();
    const tw = tgt.worldRestQ[b];
    if (tw) invTgtRest[b] = tw.clone().invert();
  }

  const deltaW = new T.Quaternion();
  const spineLumbarShare = new T.Quaternion();
  const spine1ThoracicShare = new T.Quaternion();
  const spine1WorldAnim = new T.Quaternion();
  const localOut = new T.Quaternion();
  const shoulderDamp = targetFamily === 'Codex52' ? 0.68 : 1.0;

  const isCalmStanding = CALM_STANDING_RELAX_CLIPS.has(clipLower);
  const isActiveStanding = ACTIVE_STANDING_RELAX_CLIPS.has(clipLower);
  const isSeatedLap = SEATED_LAP_RELAX_CLIPS.has(clipLower);
  const isPureIdle = clipLower === 'idle' || clipLower === 'breathing';

  const contraHipsQ = isPureIdle ? new T.Quaternion().setFromAxisAngle(WORLD_Z_AXIS, 0.022) : null;
  const contraChestQ = isPureIdle ? new T.Quaternion().setFromAxisAngle(WORLD_Z_AXIS, -0.020) : null;

  // Strip the constant baked ~-72° mocap-stage yaw offset on `Greet_Wave` so waving NPCs face forward cleanly
  let rootYawFixQ: T.Quaternion | null = null;
  if (clipLower === 'greet_wave' && srcQuatTracks.hips) {
    const q0 = sampleQuatTrack(srcQuatTracks.hips, 0, _tmpQ3);
    const d0 = _tmpQ4.copy(q0).multiply(invSrcRest.hips).normalize();
    const fwd0 = _tmpV2.set(0, 0, 1).applyQuaternion(d0);
    const yaw0 = Math.atan2(fwd0.x, fwd0.z);
    if (Math.abs(yaw0) > 0.45) {
      rootYawFixQ = new T.Quaternion().setFromAxisAngle(WORLD_Y_AXIS, -yaw0);
    }
  }

  /**
   * Rotates bone `b`'s world direction toward `(gx, gy, gz)` by `blendWeight` AND propagates the
   * exact swing quaternion down `children` so wrists/hands never kink backward!
   */
  const swingLimbWithChildren = (
    b: CanonicalBone,
    gx: number,
    gy: number,
    gz: number,
    blendWeight: number,
    children: readonly CanonicalBone[],
  ) => {
    if (blendWeight <= 1e-4) return;
    const restDir = tgt.worldRestDir[b];
    const invRest = invTgtRest[b];
    if (!restDir || !invRest) return;
    _tmpQ5.copy(tgtWorldAnim[b]).multiply(invRest).normalize();
    _tmpV2.copy(restDir).applyQuaternion(_tmpQ5).normalize();
    _tmpV3.set(gx, gy, gz).normalize();
    if (blendWeight < 0.999) {
      _tmpV3.lerp(_tmpV2, 1 - blendWeight).normalize();
    }
    if (_tmpV2.dot(_tmpV3) < 0.999999) {
      _tmpQ6.setFromUnitVectors(_tmpV2, _tmpV3);
      tgtWorldAnim[b].premultiply(_tmpQ6).normalize();
      for (let ci = 0; ci < children.length; ci++) {
        const ch = children[ci];
        if (tgt.bones[ch]) tgtWorldAnim[ch].premultiply(_tmpQ6).normalize();
      }
    }
  };

  /**
   * Target-angle-driven upper-arm flare relaxation: measures actual angle from `-UP` (`curFlare`)
   * and pulls any excess flare above `targetFlareRad` cleanly down to `targetFlareRad`!
   */
  const relaxUpperArmToTargetFlare = (
    side: 'L' | 'R',
    targetFlareRad: number,
    fwdHintZ: number,
    envelope: number,
    preserveRaisedGesture: boolean,
  ) => {
    if (envelope <= 1e-4) return;
    const sgn = side === 'L' ? 1 : -1;
    const bUpper: CanonicalBone = side === 'L' ? 'upper_arm.L' : 'upper_arm.R';
    const bFore: CanonicalBone = side === 'L' ? 'forearm.L' : 'forearm.R';
    const bHand: CanonicalBone = side === 'L' ? 'hand.L' : 'hand.R';
    const restDir = tgt.worldRestDir[bUpper];
    const invRest = invTgtRest[bUpper];
    if (!restDir || !invRest) return;

    _tmpQ5.copy(tgtWorldAnim[bUpper]).multiply(invRest).normalize();
    _tmpV2.copy(restDir).applyQuaternion(_tmpQ5).normalize();

    // If preserveRaisedGesture is active and the arm is intentionally raised forward/upward, keep gesture alive
    let gestureAtten = 1;
    if (preserveRaisedGesture) {
      const raised = Math.max(0, _tmpV2.z - 0.24) + Math.max(0, _tmpV2.y + 0.65);
      gestureAtten = 1 - T.MathUtils.smoothstep(raised, 0.05, 0.42) * 0.72;
    }

    const curFlare = Math.acos(T.MathUtils.clamp(-_tmpV2.y, -1, 1));
    const excess = Math.max(0, curFlare - targetFlareRad);
    if (excess <= 1e-4) return;

    // `goal` is already constructed at `targetFlareRad` (~8.6°), so blend directly onto `goal` by `envelope * gestureAtten`!
    const blend = Math.min(1, envelope * gestureAtten);
    const goalX = sgn * Math.sin(targetFlareRad);
    const goalY = -Math.cos(targetFlareRad);
    const goalZ = T.MathUtils.clamp(T.MathUtils.lerp(_tmpV2.z, fwdHintZ, 0.8), -0.06, 0.08);
    swingLimbWithChildren(bUpper, goalX, goalY, goalZ, blend, [bFore, bHand]);
  };

  // Precompute rest leg bone vectors in targetRoot metre space for ultra-fast exact FK ankle tracking
  const hasFastFkLegs = Boolean(
    tgt.worldRestP.hips &&
      tgt.worldRestP['thigh.L'] &&
      tgt.worldRestP['shin.L'] &&
      tgt.worldRestP['foot.L'] &&
      tgt.worldRestP['thigh.R'] &&
      tgt.worldRestP['shin.R'] &&
      tgt.worldRestP['foot.R'],
  );
  const restHipsToThighL = hasFastFkLegs
    ? tgt.worldRestP['thigh.L']!.clone().sub(tgt.worldRestP.hips!)
    : new T.Vector3();
  const restThighToShinL = hasFastFkLegs
    ? tgt.worldRestP['shin.L']!.clone().sub(tgt.worldRestP['thigh.L']!)
    : new T.Vector3();
  const restShinToFootL = hasFastFkLegs
    ? tgt.worldRestP['foot.L']!.clone().sub(tgt.worldRestP['shin.L']!)
    : new T.Vector3();
  const restHipsToThighR = hasFastFkLegs
    ? tgt.worldRestP['thigh.R']!.clone().sub(tgt.worldRestP.hips!)
    : new T.Vector3();
  const restThighToShinR = hasFastFkLegs
    ? tgt.worldRestP['shin.R']!.clone().sub(tgt.worldRestP['thigh.R']!)
    : new T.Vector3();
  const restShinToFootR = hasFastFkLegs
    ? tgt.worldRestP['foot.R']!.clone().sub(tgt.worldRestP['shin.R']!)
    : new T.Vector3();

  const sampleYL = new Float32Array(steps + 1);
  const sampleZL = new Float32Array(steps + 1);
  const sampleYR = new Float32Array(steps + 1);
  const sampleZR = new Float32Array(steps + 1);
  const sampleZHips = new Float32Array(steps + 1);
  const hipsModelPos = new T.Vector3();
  let minSampleYL = Infinity;
  let minSampleYR = Infinity;

  for (let i = 0; i <= steps; i++) {
    const t = times[i];
    const u = i / steps;

    // 1. Source FK + world deltas
    if (sourceFamily === 'Codex52' && tgt.spine1) {
      // Exact 4-bone Codex52 self-FK when relaxing embedded Codex52 clips
      let curW = IDENTITY_Q;
      for (const b of CANONICAL_ORDER) {
        if (b === 'chest' && srcSpine1Track) {
          const s1Local = sampleQuatTrack(srcSpine1Track, t, _tmpQ3);
          curW = _tmpQ7.copy(srcWorldAnim.spine).multiply(s1Local).normalize();
        } else if (b === 'chest' && tgt.spine1) {
          curW = _tmpQ7.copy(srcWorldAnim.spine).multiply(tgt.spine1.quaternion).normalize();
        } else {
          const p = CANONICAL_PARENT[b];
          curW = p ? srcWorldAnim[p] : IDENTITY_Q;
        }
        const tr = srcQuatTracks[b];
        const localS = tr ? sampleQuatTrack(tr, t, _tmpQ3) : srcRest.localQ[b];
        srcWorldAnim[b].copy(curW).multiply(localS).normalize();
        srcDeltaMap[b].copy(srcWorldAnim[b]).multiply(invSrcRest[b]).normalize();
        if (rootYawFixQ) srcDeltaMap[b].premultiply(rootYawFixQ).normalize();
      }
    } else {
      for (const b of CANONICAL_ORDER) {
        const tr = srcQuatTracks[b];
        const localS = tr ? sampleQuatTrack(tr, t, _tmpQ3) : srcRest.localQ[b];
        const p = CANONICAL_PARENT[b];
        if (!p) srcWorldAnim[b].copy(localS);
        else srcWorldAnim[b].copy(srcWorldAnim[p]).multiply(localS).normalize();
        srcDeltaMap[b].copy(srcWorldAnim[b]).multiply(invSrcRest[b]).normalize();
        if (rootYawFixQ) srcDeltaMap[b].premultiply(rootYawFixQ).normalize();
      }
    }

    // 2. Map world-space deltas onto target hierarchy (pure world-delta on trunk & clavicles!)
    for (const b of CANONICAL_ORDER) {
      const tb = tgt.bones[b];
      const tRestW = tgt.worldRestQ[b];
      if (!tb || !tRestW) continue;

      deltaW.copy(srcDeltaMap[b]);

      if (shoulderDamp < 1 && (b === 'shoulder.L' || b === 'shoulder.R')) {
        deltaW.copy(IDENTITY_Q).slerp(deltaW, shoulderDamp);
      }

      // Smooth 4-bone Codex52 lumbar/thoracic split across `Spine -> Spine1 -> Spine2`:
      // `Spine` takes 50% of `relSpine`, `Spine1` takes 100% of `spine` + 35% of `relChest`,
      // and `Spine2` (`chest`) receives 100% exact `deltaW_chest`! Zero `_tmpQ` aliasing.
      if (b === 'spine' && tgt.spine1 && tgt.spine1WorldRestQ) {
        const hipsDelta = srcDeltaMap.hips;
        const spineDelta = srcDeltaMap.spine;
        const chestDelta = srcDeltaMap.chest;

        const hipsDeltaInv = _tmpQ4.copy(hipsDelta).invert();
        const relSpine = _tmpQ1.copy(spineDelta).multiply(hipsDeltaInv).normalize();
        spineLumbarShare.copy(IDENTITY_Q).slerp(relSpine, 0.5);

        const spineDeltaInv = _tmpQ2.copy(spineDelta).invert();
        const relChest = _tmpQ3.copy(chestDelta).multiply(spineDeltaInv).normalize();
        spine1ThoracicShare.copy(IDENTITY_Q).slerp(relChest, 0.35);

        tgtWorldAnim.spine.copy(spineLumbarShare).multiply(hipsDelta).multiply(tRestW).normalize();
        spine1WorldAnim.copy(spine1ThoracicShare).multiply(spineDelta).multiply(tgt.spine1WorldRestQ).normalize();
        continue;
      }

      const align = bindAlign[b];
      if (align) {
        tgtWorldAnim[b].copy(deltaW).multiply(align).multiply(tRestW).normalize();
      } else {
        tgtWorldAnim[b].copy(deltaW).multiply(tRestW).normalize();
      }
    }

    // 3. Post-retarget Biomechanical Arm & Posture Relaxation (propagating swings cleanly to hands!)
    if (isCalmStanding) {
      // `stand_up` transitions seamlessly from seated thigh-rest (`u = 0`) into natural `8.5°` (`0.15 rad`) hang (`u -> 0.88`)
      const env = clipLower === 'stand_up' ? T.MathUtils.smoothstep(u, 0.28, 0.88) : 1.0;
      const lapFromSeat = clipLower === 'stand_up' ? 1 - T.MathUtils.smoothstep(u, 0.08, 0.62) : 0;
      if (lapFromSeat > 1e-4) {
        swingLimbWithChildren('upper_arm.L', 0.14, -0.96, 0.24, 0.90 * lapFromSeat, ['forearm.L', 'hand.L']);
        swingLimbWithChildren('upper_arm.R', -0.14, -0.96, 0.24, 0.90 * lapFromSeat, ['forearm.R', 'hand.R']);
        swingLimbWithChildren('forearm.L', -0.22, -0.34, 0.91, 0.92 * lapFromSeat, ['hand.L']);
        swingLimbWithChildren('forearm.R', 0.22, -0.34, 0.91, 0.92 * lapFromSeat, ['hand.R']);
        for (const side of ['L', 'R'] as const) {
          const sgn = side === 'L' ? 1 : -1;
          const bHand: CanonicalBone = side === 'L' ? 'hand.L' : 'hand.R';
          if (tgt.bones[bHand]) {
            _tmpV2.set(-sgn * 0.22, -0.34, 0.91).normalize();
            _tmpQ6.setFromAxisAngle(_tmpV2, -sgn * 0.38 * lapFromSeat);
            tgtWorldAnim[bHand].premultiply(_tmpQ6).normalize();
          }
        }
      }

      if (isPureIdle) {
        if (contraHipsQ && tgt.bones.hips) {
          tgtWorldAnim.hips.premultiply(contraHipsQ).normalize();
        }
        if (contraChestQ && tgt.bones.chest) {
          tgtWorldAnim.chest.premultiply(contraChestQ).normalize();
          for (const ch of [
            'neck',
            'head',
            'shoulder.L',
            'upper_arm.L',
            'forearm.L',
            'hand.L',
            'shoulder.R',
            'upper_arm.R',
            'forearm.R',
            'hand.R',
          ] as const) {
            if (tgt.bones[ch]) tgtWorldAnim[ch].premultiply(contraChestQ).normalize();
          }
        }
      }

      // Pull upper arms cleanly to `0.15 rad` (~8.6°) hang and forearms to `0.28 rad` (~16°) pitch
      relaxUpperArmToTargetFlare('L', 0.15, 0.03, env, false);
      relaxUpperArmToTargetFlare('R', 0.15, 0.03, env, false);
      swingLimbWithChildren('forearm.L', 0.045, -0.959, 0.28, 0.86 * env, ['hand.L']);
      swingLimbWithChildren('forearm.R', -0.045, -0.959, 0.28, 0.86 * env, ['hand.R']);

      if (isPureIdle && targetFamily === 'Codex52') {
        swingLimbWithChildren('thigh.L', 0.052, -0.998, 0.015, 0.45, ['shin.L', 'foot.L']);
        swingLimbWithChildren('thigh.R', -0.052, -0.998, 0.015, 0.45, ['shin.R', 'foot.R']);
      }
    } else if (isActiveStanding) {
      if (clipLower === 'listen_nod') {
        relaxUpperArmToTargetFlare('L', 0.165, 0.05, 1.0, false);
        relaxUpperArmToTargetFlare('R', 0.165, 0.05, 1.0, false);
        swingLimbWithChildren('forearm.L', 0.04, -0.91, 0.41, 0.76, ['hand.L']);
        swingLimbWithChildren('forearm.R', -0.04, -0.91, 0.41, 0.76, ['hand.R']);
      } else if (clipLower === 'talk_gesture') {
        relaxUpperArmToTargetFlare('L', 0.175, 0.10, 0.92, true);
        relaxUpperArmToTargetFlare('R', 0.21, 0.26, 0.65, true);
        swingLimbWithChildren('forearm.L', -0.05, -0.82, 0.56, 0.68, ['hand.L']);
        swingLimbWithChildren('forearm.R', 0.08, -0.48, 0.87, 0.34, ['hand.R']);
      } else {
        // Standing prop/presentation clips (`study_read`, `drink_cup`, `open_door`, `present`):
        // tuck wide A-pose lateral elbow flare toward `0.20 rad` (~11.5°) while preserving hand reach!
        relaxUpperArmToTargetFlare('L', 0.20, 0.12, 0.82, true);
        relaxUpperArmToTargetFlare('R', 0.20, 0.12, 0.82, true);
      }
    } else if (isSeatedLap) {
      // For `sit_down`, blend smoothly from calm standing hang (`u = 0`) onto thigh-lap rest (`u >= 0.78`),
      // eliminating `91.3°` horizontal zombie forearms throughout descent and matching `sit_idle` 1:1 on settle!
      const lapEnv = clipLower === 'sit_down' ? T.MathUtils.smoothstep(u, 0.14, 0.78) : 1.0;
      const standEnv = 1 - lapEnv;
      if (standEnv > 1e-4) {
        relaxUpperArmToTargetFlare('L', 0.15, 0.03, standEnv, false);
        relaxUpperArmToTargetFlare('R', 0.15, 0.03, standEnv, false);
        swingLimbWithChildren('forearm.L', 0.045, -0.959, 0.28, 0.86 * standEnv, ['hand.L']);
        swingLimbWithChildren('forearm.R', -0.045, -0.959, 0.28, 0.86 * standEnv, ['hand.R']);
      }
      if (lapEnv > 1e-4) {
        swingLimbWithChildren('upper_arm.L', 0.14, -0.96, 0.24, 0.90 * lapEnv, ['forearm.L', 'hand.L']);
        swingLimbWithChildren('upper_arm.R', -0.14, -0.96, 0.24, 0.90 * lapEnv, ['forearm.R', 'hand.R']);
        swingLimbWithChildren('forearm.L', -0.22, -0.34, 0.91, 0.92 * lapEnv, ['hand.L']);
        swingLimbWithChildren('forearm.R', 0.22, -0.34, 0.91, 0.92 * lapEnv, ['hand.R']);

        // Subtle forearm pronation (`~22°` inward roll around forearm axis) so palms rest flat over thighs
        for (const side of ['L', 'R'] as const) {
          const sgn = side === 'L' ? 1 : -1;
          const bHand: CanonicalBone = side === 'L' ? 'hand.L' : 'hand.R';
          if (tgt.bones[bHand]) {
            _tmpV2.set(-sgn * 0.22, -0.34, 0.91).normalize();
            _tmpQ6.setFromAxisAngle(_tmpV2, -sgn * 0.38 * lapEnv);
            tgtWorldAnim[bHand].premultiply(_tmpQ6).normalize();
          }
        }
      }
    }

    // 4. Emit local bone quaternions from finalized world orientations
    for (const b of CANONICAL_ORDER) {
      const tb = tgt.bones[b];
      if (!tb) continue;

      if (b === 'spine' && tgt.spine1) {
        localOut.copy(tgtWorldAnim.hips).invert().multiply(tgtWorldAnim.spine).normalize();
        const sBuf = quatBuffers.get(tb.name)!;
        sBuf[i * 4] = localOut.x;
        sBuf[i * 4 + 1] = localOut.y;
        sBuf[i * 4 + 2] = localOut.z;
        sBuf[i * 4 + 3] = localOut.w;

        localOut.copy(tgtWorldAnim.spine).invert().multiply(spine1WorldAnim).normalize();
        const s1Buf = quatBuffers.get(tgt.spine1.name)!;
        s1Buf[i * 4] = localOut.x;
        s1Buf[i * 4 + 1] = localOut.y;
        s1Buf[i * 4 + 2] = localOut.z;
        s1Buf[i * 4 + 3] = localOut.w;
        continue;
      }

      const p = CANONICAL_PARENT[b];
      let parentWorld: T.Quaternion;
      if (!p) {
        parentWorld = tgt.hipsParentModelQ;
      } else if (b === 'chest' && tgt.spine1) {
        parentWorld = spine1WorldAnim;
      } else {
        parentWorld = tgtWorldAnim[p];
      }

      localOut.copy(parentWorld).invert().multiply(tgtWorldAnim[b]).normalize();
      const buf = quatBuffers.get(tb.name)!;
      buf[i * 4] = localOut.x;
      buf[i * 4 + 1] = localOut.y;
      buf[i * 4 + 2] = localOut.z;
      buf[i * 4 + 3] = localOut.w;
    }

    // 5. Hips position delta (in targetRoot metre space) & exact ankle height/Z tracking
    if (srcHipsPosTrack) {
      sampleVecTrack(srcHipsPosTrack, t, _tmpV1);
      if (sourceFamily === 'Codex52') {
        _tmpV1
          .sub(srcHipsRestOrigin)
          .multiplyScalar(1 / Math.max(1e-4, tgt.hipsParentInvScale))
          .applyQuaternion(tgt.hipsParentModelQ);
      } else {
        _tmpV1.sub(srcHipsRestOrigin).multiplyScalar(hipsScale);
        if (rootYawFixQ) _tmpV1.applyQuaternion(rootYawFixQ);
      }
      hipsModelPos.copy(tgt.hipsWorldP).add(_tmpV1);
    } else {
      _tmpV1.set(0, 0, 0);
      hipsModelPos.copy(tgt.hipsWorldP);
    }

    if (hipsPosBuf) {
      _tmpV4
        .copy(_tmpV1)
        .applyQuaternion(tgt.hipsParentInvQ)
        .multiplyScalar(tgt.hipsParentInvScale)
        .add(tgt.hipsRestPos);
      hipsPosBuf[i * 3] = _tmpV4.x;
      hipsPosBuf[i * 3 + 1] = _tmpV4.y;
      hipsPosBuf[i * 3 + 2] = _tmpV4.z;
    }

    if (hasFastFkLegs && invTgtRest.hips && invTgtRest['thigh.L'] && invTgtRest['shin.L'] && invTgtRest['thigh.R'] && invTgtRest['shin.R']) {
      // Left ankle in targetRoot metre space
      _tmpQ5.copy(tgtWorldAnim.hips).multiply(invTgtRest.hips).normalize();
      _tmpV2.copy(restHipsToThighL).applyQuaternion(_tmpQ5).add(hipsModelPos);
      _tmpQ5.copy(tgtWorldAnim['thigh.L']).multiply(invTgtRest['thigh.L']).normalize();
      _tmpV3.copy(restThighToShinL).applyQuaternion(_tmpQ5).add(_tmpV2);
      _tmpQ5.copy(tgtWorldAnim['shin.L']).multiply(invTgtRest['shin.L']).normalize();
      _tmpV4.copy(restShinToFootL).applyQuaternion(_tmpQ5).add(_tmpV3);
      sampleYL[i] = _tmpV4.y;
      sampleZL[i] = _tmpV4.z;
      if (_tmpV4.y < minSampleYL) minSampleYL = _tmpV4.y;

      // Right ankle in targetRoot metre space
      _tmpQ5.copy(tgtWorldAnim.hips).multiply(invTgtRest.hips).normalize();
      _tmpV2.copy(restHipsToThighR).applyQuaternion(_tmpQ5).add(hipsModelPos);
      _tmpQ5.copy(tgtWorldAnim['thigh.R']).multiply(invTgtRest['thigh.R']).normalize();
      _tmpV3.copy(restThighToShinR).applyQuaternion(_tmpQ5).add(_tmpV2);
      _tmpQ5.copy(tgtWorldAnim['shin.R']).multiply(invTgtRest['shin.R']).normalize();
      _tmpV4.copy(restShinToFootR).applyQuaternion(_tmpQ5).add(_tmpV3);
      sampleYR[i] = _tmpV4.y;
      sampleZR[i] = _tmpV4.z;
      if (_tmpV4.y < minSampleYR) minSampleYR = _tmpV4.y;

      sampleZHips[i] = hipsModelPos.z;
    }
  }

  // 6. Bake out post-retarget upward ankle hover bias (`+3..+6 cm` floating fix) on grounded clips
  let residualHoverY = 0;
  if (hasFastFkLegs && Number.isFinite(minSampleYL) && Number.isFinite(minSampleYR)) {
    const rawHover = T.MathUtils.clamp(
      Math.min(minSampleYL - tgt.footRestYL, minSampleYR - tgt.footRestYR),
      0,
      0.12,
    );
    if (isGroundedHoverFix && hipsPosBuf && rawHover > 0.0015) {
      // Shift hips downward in model space by `-rawHover` along `-WORLD_Y`
      _tmpV4.set(0, -rawHover, 0).applyQuaternion(tgt.hipsParentInvQ).multiplyScalar(tgt.hipsParentInvScale);
      for (let i = 0; i <= steps; i++) {
        hipsPosBuf[i * 3] += _tmpV4.x;
        hipsPosBuf[i * 3 + 1] += _tmpV4.y;
        hipsPosBuf[i * 3 + 2] += _tmpV4.z;
        sampleYL[i] -= rawHover;
        sampleYR[i] -= rawHover;
      }
      residualHoverY = 0;
    } else {
      residualHoverY = rawHover;
    }
  }

  const tracks: T.KeyframeTrack[] = [];
  if (hipsPosBuf && tgt.bones.hips) {
    tracks.push(new T.VectorKeyframeTrack(`${tgt.bones.hips.name}.position`, times, hipsPosBuf));
  }
  for (const [boneName, values] of quatBuffers) {
    tracks.push(new T.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, values));
  }

  const outClip = new T.AnimationClip(options.name ?? rawSourceClip.name, duration, tracks);

  if (hasFastFkLegs) {
    const meta = buildFastGaitMetaFromSamples(
      duration,
      steps,
      sampleYL,
      sampleZL,
      sampleYR,
      sampleZR,
      sampleZHips,
      residualHoverY,
      STATIC_STANDING_META_CLIPS.has(clipLower),
    );
    setCachedClipGaitMeta(outClip, meta);
  }

  return outClip;
}

const embeddedRepairCache = new WeakMap<T.AnimationClip, Map<string, T.AnimationClip>>();

/**
 * Repairs embedded clips on a loaded character GLB:
 *  - Repairs raw-`RunnerRig` squat clips (`Walk`, `Run`, `Greet_Wave`) on `crowd_*` (`EchoStudentRig`).
 *  - Runs target-angle standing/seated arm relaxation on same-family embedded clips (`idle`, `sit`, etc.)
 *    instead of bypassing them (`L818` fix), cached per `(clip, poseSignature)` for zero repeat cost.
 */
export function repairActorClips(
  clips: readonly T.AnimationClip[],
  root: T.Object3D,
  targetRestInfo?: TargetSkeletonInfo,
): T.AnimationClip[] {
  const targetFamily = targetRestInfo?.family ?? detectRigFamily(root);
  const restInfo = targetRestInfo ?? inspectTargetSkeleton(root, targetFamily);
  return clips.map((clip) => {
    let bySig = embeddedRepairCache.get(clip);
    const cached = bySig?.get(restInfo.poseSignature);
    if (cached) return cached;

    const sourceFamily = detectClipSourceFamily(clip, targetFamily);
    const lower = clip.name.toLowerCase();
    if (
      sourceFamily === targetFamily &&
      !ALL_POSTURE_RELAX_CLIPS.has(lower) &&
      !(sourceFamily === 'RunnerRig' && (lower === 'walk' || lower === 'walk_brisk' || lower === 'run'))
    ) {
      return clip;
    }
    const repaired = retargetClip(clip, root, {
      sourceFamily,
      targetFamily,
      targetRestInfo: restInfo,
      echoHipsTranslation: targetFamily === 'EchoStudentRig' && sourceFamily !== targetFamily,
      name: clip.name,
    });
    if (!bySig) {
      bySig = new Map<string, T.AnimationClip>();
      embeddedRepairCache.set(clip, bySig);
    }
    bySig.set(restInfo.poseSignature, repaired);
    return repaired;
  });
}

// ── Global 48-Clip Pack Loader, Source Index & Lazy Per-Signature Retarget Cache ───────────────────────

const packLoader = new GLTFLoader();
let packPromise: Promise<GLTF | null> | null = null;
const retargetCache = new Map<string, T.AnimationClip>();
const packSourceIndexCache = new WeakMap<GLTF, Map<string, T.AnimationClip>>();

export function loadEcho48Pack(url = ALL48_PACK_URL): Promise<GLTF | null> {
  if (!packPromise) {
    packPromise = packLoader.loadAsync(url).catch(() => {
      packPromise = null;
      return null;
    });
  }
  return packPromise;
}

export function clearRetargetCache(): void {
  retargetCache.clear();
  clearMotionMatchCache();
}

function getPackSourceIndex(pack: GLTF): Map<string, T.AnimationClip> {
  let index = packSourceIndexCache.get(pack);
  if (index) return index;

  index = new Map<string, T.AnimationClip>();
  let rawTurnL: T.AnimationClip | null = null;
  for (const clip of pack.animations) {
    const lower = clip.name.toLowerCase();
    index.set(lower, clip);
    if (lower === 'turn_l') rawTurnL = clip;
  }

  // Replace `all48`'s broken stationary `2.6°` `Turn_R` with an exact sagittal mirror of `Turn_L` (`-47.0°`)
  if (rawTurnL) {
    const mirroredTurnR = synthesizeMirroredTurnRight(rawTurnL, {
      detrendYaw: false,
      closeSeam: false,
      name: index.get('turn_r')?.name ?? 'Turn_R',
    });
    index.set('turn_r', mirroredTurnR);
  }

  packSourceIndexCache.set(pack, index);
  return index;
}

function getRetargetedPackClipByKey(
  pack: GLTF,
  clipKeyLower: string,
  targetRoot: T.Object3D,
  targetFamily: RigFamily,
  restInfo: TargetSkeletonInfo,
): T.AnimationClip | undefined {
  const sourceIndex = getPackSourceIndex(pack);
  const srcClip = sourceIndex.get(clipKeyLower);
  if (!srcClip) return undefined;

  const cacheKey = `${targetFamily}:${restInfo.poseSignature}:${clipKeyLower}`;
  let ready = retargetCache.get(cacheKey);
  if (!ready) {
    const sourceFamily = detectClipSourceFamily(srcClip, 'EchoStudentRig');
    ready = retargetClip(srcClip, targetRoot, {
      sourceFamily,
      targetFamily,
      targetRestInfo: restInfo,
      echoHipsTranslation: sourceFamily === 'EchoStudentRig',
      name: srcClip.name,
    });
    retargetCache.set(cacheKey, ready);
  }
  return ready;
}

/**
 * Returns retargeted versions of all 48 clips in `EchoStudentRig_All48Clips_Pack.glb` for `targetRoot`,
 * cached by `(rigFamily, restPoseSignature, clipName)` (shares the same per-clip cache used lazily by
 * `CharacterAnimator.bindPack`).
 */
export function getRetargeted48Clips(
  pack: GLTF,
  targetRoot: T.Object3D,
  targetFamily = detectRigFamily(targetRoot),
  targetRestInfo?: TargetSkeletonInfo,
): Map<string, T.AnimationClip> {
  const restInfo = targetRestInfo ?? inspectTargetSkeleton(targetRoot, targetFamily);
  const sourceIndex = getPackSourceIndex(pack);
  const out = new Map<string, T.AnimationClip>();
  for (const key of sourceIndex.keys()) {
    const ready = getRetargetedPackClipByKey(pack, key, targetRoot, targetFamily, restInfo);
    if (ready) out.set(key, ready);
  }
  return out;
}

// ── Stride-Matched Locomotion & Activity State Machine ────────────────────────────────────────────────

/** Legacy nominal stride ground speeds (m/s at scale 1) retained for backward-compatible unit callers. */
export const LOCOMOTION_STRIDE_SPEED = {
  walk: 1.08,
  walk_brisk: 1.72,
  run: 2.55,
  crouch_walk: 0.72,
  stairs_ascend: 0.88,
} as const;

export function strideTimeScale(
  gait: keyof typeof LOCOMOTION_STRIDE_SPEED,
  speedMetersPerSec: number,
  actorScale = 1,
): number {
  const nominal = LOCOMOTION_STRIDE_SPEED[gait] * Math.max(0.5, actorScale);
  return T.MathUtils.clamp(speedMetersPerSec / nominal, 0.38, 1.55);
}

/** Activity alias resolution table spanning Echo Life V3 activities + 48-clip names. */
export const ACTIVITY_CLIP_PRIORITY: Record<string, readonly string[]> = {
  idle: ['idle', 'breathing'],
  breathing: ['breathing', 'idle'],
  walk: ['walk'],
  walk_brisk: ['walk_brisk', 'walk'],
  run: ['run', 'walk_brisk', 'walk'],
  run_stop: ['run_stop', 'idle'],
  turn_l: ['turn_l', 'walk', 'idle'],
  turn_r: ['turn_r', 'walk', 'idle'],
  jump: ['jump', 'idle'],
  land: ['land', 'idle'],
  crouch_idle: ['crouch_idle', 'idle'],
  crouch_walk: ['crouch_walk', 'walk'],
  stairs_ascend: ['stairs_ascend', 'walk'],
  sit: ['sit_idle', 'sit', 'idle'],
  sit_down: ['sit_down', 'sit_idle', 'sit'],
  stand_up: ['stand_up', 'idle'],
  sleep: ['sleep_loop', 'sleep', 'sit_idle', 'idle'],
  study: ['use_computer_type', 'study_write', 'study_read', 'study', 'sit_idle', 'idle'],
  computer: ['use_computer_type', 'study', 'sit_idle'],
  read: ['study_read', 'study', 'idle'],
  write: ['study_write', 'study', 'sit_idle'],
  wave: ['greet_wave', 'wave', 'idle'],
  talk: ['talk_gesture', 'present', 'idle'],
  listen: ['listen_nod', 'idle'],
  present: ['festival_present', 'present', 'talk_gesture', 'idle'],
  guitar: ['festival_guitar', 'present', 'idle'],
  celebrate: ['festival_celebrate', 'celebrate', 'greet_wave', 'idle'],
  cook: ['cook_stir', 'cook_chop', 'cook', 'talk_gesture', 'idle'],
  cook_chop: ['cook_chop', 'cook', 'idle'],
  cook_flip: ['cook_flip', 'cook', 'idle'],
  eat: ['eat_seated', 'sit_idle', 'idle'],
  drink: ['drink_cup', 'idle'],
  wipe: ['wipe_surface', 'wipe', 'idle'],
  sweep: ['sweep_broom', 'sweep', 'idle'],
  mop: ['mop_floor', 'sweep', 'idle'],
  exercise_squat: ['exercise_squat', 'idle'],
  stretch: ['breathing', 'idle'],
  shoot_basket: ['sport_basketball_shoot', 'shoot_basket', 'idle'],
  cycle: ['bicycle_pedal', 'cycle', 'sit_idle', 'idle'],
  cycle_coast: ['bicycle_coast', 'bicycle_pedal', 'cycle', 'idle'],
  carry_basket: ['carry_twohand', 'carry_onehand', 'carry_basket', 'walk'],
  brush_teeth: ['brush_teeth', 'idle'],
  shower_rinse: ['shower_rinse', 'brush_teeth', 'idle'],
};

const LOCOMOTION_CLIPS = new Set(['walk', 'walk_brisk', 'run', 'crouch_walk', 'stairs_ascend']);
const STANDARD_GAIT_BANDS = new Set(['walk', 'walk_brisk', 'run']);

/** Core 7-clip subset pre-warmed on `bindPack` for `MotionMatchDatabase` (other 41 clips resolve lazily). */
const CORE_PACK_PREWARM_KEYS: readonly string[] = [
  'idle',
  'breathing',
  'walk',
  'walk_brisk',
  'run',
  'turn_l',
  'turn_r',
];

const SEATED_ONLY_CLIPS = new Set([
  'sit',
  'sit_idle',
  'sit_down',
  'stand_up',
  'eat_seated',
  'use_computer_type',
  'study_write',
  'sleep',
  'sleep_loop',
  'bicycle_pedal',
  'bicycle_coast',
  'cycle',
  'crouch_idle',
  'exercise_squat',
]);

const STANDING_BLOCKED_ACTIVITIES = new Set([
  'sit',
  'sit_idle',
  'sit_down',
  'stand_up',
  'sleep',
  'sleep_loop',
  'crouch_idle',
  'exercise_squat',
  'relax',
  'rest',
]);

const STANDING_SOCIAL_REMAP_ACTIVITIES = new Set([
  'study',
  'computer',
  'use_computer_type',
  'write',
  'study_write',
  'cycle',
  'cycle_coast',
  'bicycle_pedal',
  'bicycle_coast',
  'eat',
  'eat_seated',
]);

export interface AnimatorFrame {
  dt: number;
  /** High-level activity name from game schedule or player state (e.g. 'walk', 'sit', 'talk', 'shoot_basket'). */
  activity: string;
  /** Measured ground travel speed in m/s (used for Schmitt locomotion blend space & stride-matched timeScale). */
  speed: number;
  /** Angular yaw turn rate in rad/s (triggers Turn_L / Turn_R when pivoting on the spot & centripetal lean). */
  yawRate?: number;
  /** True only when physically settled on a real seat. */
  seated?: boolean;
  /** True while actively conversing with the player (alternates Talk_Gesture / Listen_Nod). */
  inDialogue?: boolean;
  /** True when this actor is the active speaker in dialogue. */
  speaking?: boolean;
  /** Actor root scale (defaults to 1). */
  scale?: number;
  reduced?: boolean;
  /**
   * When true, `update()` captures clean post-DeadBlend spine quaternions and defers applying procedural
   * `bankRoll`/`accelPitch` until the caller invokes `applyPostCaptureLean()` (after `CharacterLife.capture()`).
   */
  deferLean?: boolean;
}

const _leanQuatRoll = new T.Quaternion();
const _leanQuatPitch = new T.Quaternion();
const _leanDelta = new T.Quaternion();
const _wHips = new T.Quaternion();
const _wSpine = new T.Quaternion();
const _wSpine1 = new T.Quaternion();
const _wChest = new T.Quaternion();
const _wInvParent = new T.Quaternion();
const _stanceSnapA = createStanceWeightsSnapshot();
const _stanceSnapB = createStanceWeightsSnapshot();

function wrapPhase01(u: number): number {
  const m = u % 1;
  return m < 0 ? m + 1 : m;
}

/**
 * Full-featured per-actor Biomechanical Animation State Machine & Master-Phase Blend Space.
 */
export class CharacterAnimator {
  readonly family: RigFamily;
  readonly mixer: T.AnimationMixer;
  readonly actions = new Map<string, T.AnimationAction>();
  readonly poseSignature: string;
  current: T.AnimationAction | null = null;
  currentName = '';

  private readonly restInfo: TargetSkeletonInfo;
  private readonly deadBlend: DeadBlendInertializer;
  private mmDb: MotionMatchDatabase | null = null;
  private pack: GLTF | null = null;
  private packSourceIndex: Map<string, T.AnimationClip> | null = null;
  private preserveKeys: ReadonlySet<string> | null = null;

  private secondaryAction: T.AnimationAction | null = null;
  private secondaryName = '';
  private secondaryWeight = 0;
  private locoBand: SchmittLocomotionBand = 'idle';
  private locoPhase = 0;
  private lastScale = 1;
  private isSeatedState = false;

  private readonly invRestThighL: T.Quaternion;
  private readonly invRestThighR: T.Quaternion;
  private prevSwingL = 0;
  private prevSwingR = 0;
  private velSwingL = 0;
  private velSwingR = 0;
  private oneShot: { name: string; remaining: number } | null = null;
  private wasSeated = false;
  private smoothedSpeed = 0;
  private prevSpeed = 0;
  private filteredYawRate = 0;
  private bankRoll = 0;
  private accelPitch = 0;
  private idleClock = 0;
  private packBound = false;
  private readonly seed: number;

  // Clean pre-lean bone quaternion snapshot preventing unbounded spine/chest drift (`RC-A2` fix)
  private readonly cleanHipsQ = new T.Quaternion();
  private readonly cleanSpineQ = new T.Quaternion();
  private readonly cleanSpine1Q = new T.Quaternion();
  private readonly cleanChestQ = new T.Quaternion();
  private leanSnapshotValid = false;
  private leanCurrentlyApplied = false;

  private readonly defaultStanceOut = createStanceWeightsSnapshot();

  constructor(
    readonly root: T.Object3D,
    embeddedClips: readonly T.AnimationClip[],
    actorKey = '',
  ) {
    this.family = detectRigFamily(root);
    this.restInfo = inspectTargetSkeleton(root, this.family);
    this.poseSignature = this.restInfo.poseSignature;
    this.mixer = new T.AnimationMixer(root);
    this.seed = hashString(actorKey);
    this.locoPhase = this.seed;

    const animatedBones: T.Bone[] = [];
    for (const k of CANONICAL_ORDER) {
      const b = this.restInfo.bones[k];
      if (b) animatedBones.push(b);
    }
    if (this.restInfo.spine1) animatedBones.push(this.restInfo.spine1);
    this.deadBlend = new DeadBlendInertializer(animatedBones, this.restInfo.bones.hips ?? null);
    this.invRestThighL = (this.restInfo.bones['thigh.L']?.quaternion.clone() ?? new T.Quaternion()).invert();
    this.invRestThighR = (this.restInfo.bones['thigh.R']?.quaternion.clone() ?? new T.Quaternion()).invert();

    const repaired = repairActorClips(embeddedClips, root, this.restInfo);
    for (const clip of repaired) {
      const key = clip.name.toLowerCase();
      this.actions.set(key, this.mixer.clipAction(clip));
    }
  }

  /**
   * Binds the shared 48-clip animation pack onto this actor's mixer with **lazy per-clip retargeting**:
   * only the 7-clip locomotion pose-search core is materialized immediately (`< 1 ms` cold, `< 0.05 ms`
   * cached), while the remaining 41 activity clips retarget on first demand (`0` main-thread spikes).
   */
  bindPack(pack: GLTF, preserveKeys?: ReadonlySet<string>): void {
    if (this.packBound) return;
    this.packBound = true;
    this.pack = pack;
    this.packSourceIndex = getPackSourceIndex(pack);
    this.preserveKeys = preserveKeys ?? null;

    // Upgrade currently playing embedded clip immediately if not preserved
    if (this.currentName && !(preserveKeys?.has(this.currentName))) {
      const upgraded = getRetargetedPackClipByKey(pack, this.currentName, this.root, this.family, this.restInfo);
      if (upgraded && this.current) {
        const prevTime = this.current.time;
        this.current.stop();
        const next = this.mixer.clipAction(upgraded);
        next.reset().setEffectiveWeight(1).play();
        next.time = prevTime % Math.max(0.05, upgraded.duration);
        this.actions.set(this.currentName, next);
        this.current = next;
      }
    }

    // Pre-warm only the 7-clip locomotion core for MotionMatchDatabase
    const coreMap = new Map<string, T.AnimationClip>();
    for (const key of CORE_PACK_PREWARM_KEYS) {
      if (preserveKeys?.has(key) && this.actions.has(key)) {
        coreMap.set(key, this.actions.get(key)!.getClip());
        continue;
      }
      const clip = getRetargetedPackClipByKey(pack, key, this.root, this.family, this.restInfo);
      if (!clip) continue;
      coreMap.set(key, clip);
      if (!this.actions.has(key) || this.currentName !== key) {
        this.actions.set(key, this.mixer.clipAction(clip));
      }
    }

    const restL = this.restInfo.bones['thigh.L']?.quaternion ?? IDENTITY_Q;
    const restR = this.restInfo.bones['thigh.R']?.quaternion ?? IDENTITY_Q;
    this.mmDb = getOrBuildMotionMatchDb(`${this.family}:${this.poseSignature}`, coreMap, restL, restR);
  }

  /** True if `name` is available either as an already-bound action or lazily from the 48-clip pack. */
  hasClip(name: string): boolean {
    const key = name.toLowerCase();
    if (this.actions.has(key)) return true;
    return Boolean(this.packSourceIndex?.has(key));
  }

  /** Lazily materializes and caches a retargeted `AnimationAction` on first use. */
  ensureAction(name: string): T.AnimationAction | undefined {
    const key = name.toLowerCase();
    const existing = this.actions.get(key);
    if (existing) {
      // If `bindPack` happened after embedded clip registration and this non-core clip wasn't upgraded yet, upgrade once
      if (
        this.pack &&
        this.packSourceIndex?.has(key) &&
        !this.preserveKeys?.has(key) &&
        existing !== this.current &&
        existing !== this.secondaryAction
      ) {
        const packClip = getRetargetedPackClipByKey(this.pack, key, this.root, this.family, this.restInfo);
        if (packClip && existing.getClip() !== packClip) {
          existing.stop();
          const upgraded = this.mixer.clipAction(packClip);
          this.actions.set(key, upgraded);
          return upgraded;
        }
      }
      return existing;
    }
    if (!this.pack || !this.packSourceIndex?.has(key)) return undefined;
    const clip = getRetargetedPackClipByKey(this.pack, key, this.root, this.family, this.restInfo);
    if (!clip) return undefined;
    const action = this.mixer.clipAction(clip);
    this.actions.set(key, action);
    return action;
  }

  /** Resets inertializer, Schmitt gait band, and lean dynamics cleanly (call after large teleports). */
  resetDynamics(): void {
    this.restoreLeanSnapshot();
    this.stopSecondaryAction();
    this.deadBlend.seedFromCurrent();
    this.bankRoll = 0;
    this.accelPitch = 0;
    this.filteredYawRate = 0;
    this.smoothedSpeed = 0;
    this.prevSpeed = 0;
    this.locoBand = 'idle';
  }

  /** Triggers a one-shot animation (e.g. `greet_wave`, `sport_basketball_shoot`, `festival_celebrate`). */
  triggerOneShot(activityOrClip: string, fade = 0.22): boolean {
    const resolved = this.resolveClipName(activityOrClip);
    if (!resolved) return false;
    const action = this.ensureAction(resolved);
    if (!action) return false;
    const dur = Math.max(0.25, action.getClip().duration);
    this.stopSecondaryAction();
    action.setLoop(T.LoopOnce, 1);
    action.clampWhenFinished = true;
    this.transitionTo(resolved, fade, false);
    this.oneShot = { name: resolved, remaining: dur };
    return true;
  }

  private stopSecondaryAction(): void {
    if (this.secondaryAction) {
      this.secondaryAction.setEffectiveWeight(0);
      this.secondaryAction.enabled = false;
      this.secondaryAction.stop();
      this.secondaryAction = null;
    }
    this.secondaryName = '';
    this.secondaryWeight = 0;
  }

  private restoreLeanSnapshot(): void {
    if (!this.leanCurrentlyApplied || !this.leanSnapshotValid) return;
    const { hips, spine, chest } = this.restInfo.bones;
    const spine1 = this.restInfo.spine1;
    if (hips) hips.quaternion.copy(this.cleanHipsQ);
    if (spine) spine.quaternion.copy(this.cleanSpineQ);
    if (spine1) spine1.quaternion.copy(this.cleanSpine1Q);
    if (chest) chest.quaternion.copy(this.cleanChestQ);
    this.leanCurrentlyApplied = false;
  }

  private captureLeanSnapshot(): void {
    const { hips, spine, chest } = this.restInfo.bones;
    const spine1 = this.restInfo.spine1;
    if (hips) this.cleanHipsQ.copy(hips.quaternion);
    if (spine) this.cleanSpineQ.copy(spine.quaternion);
    if (spine1) this.cleanSpine1Q.copy(spine1.quaternion);
    if (chest) this.cleanChestQ.copy(chest.quaternion);
    this.leanSnapshotValid = true;
    this.leanCurrentlyApplied = false;
  }

  /**
   * Applies bounded character-root world-space centripetal `bankRoll` (`40%` lumbar spine / `60%` chest)
   * and start/stop `accelPitch` (`55%` lumbar spine / `45%` chest) strictly above `hips` (`0` sideways
   * foot wobble, `0` unbounded frame-to-frame spine drift). Zero heap allocations.
   */
  applyPostCaptureLean(): void {
    if (this.leanCurrentlyApplied || !this.leanSnapshotValid) return;
    if (Math.abs(this.bankRoll) <= 1e-4 && Math.abs(this.accelPitch) <= 1e-4) return;

    const { hips, spine, chest } = this.restInfo.bones;
    const spine1 = this.restInfo.spine1;
    if (!hips || !spine || !chest) return;

    // Evaluate trunk chain in character-root model space (+X left, +Y up, +Z forward)
    _wHips.copy(this.restInfo.hipsParentModelQ).multiply(hips.quaternion).normalize();

    if (spine1) {
      // 4-bone Codex52: 20% bank / 27.5% pitch on Spine, 20% bank / 27.5% pitch on Spine1, 60% bank / 45% pitch on Spine2
      _leanQuatRoll.setFromAxisAngle(WORLD_Z_AXIS, this.bankRoll * 0.2);
      _leanQuatPitch.setFromAxisAngle(WORLD_X_AXIS, this.accelPitch * 0.275);
      _leanDelta.copy(_leanQuatRoll).multiply(_leanQuatPitch).normalize();

      _wSpine.copy(_wHips).multiply(spine.quaternion).normalize();
      _wSpine.premultiply(_leanDelta).normalize();
      _wInvParent.copy(_wHips).invert();
      spine.quaternion.copy(_wInvParent).multiply(_wSpine).normalize();

      _wSpine1.copy(_wSpine).multiply(spine1.quaternion).normalize();
      _wSpine1.premultiply(_leanDelta).normalize();
      _wInvParent.copy(_wSpine).invert();
      spine1.quaternion.copy(_wInvParent).multiply(_wSpine1).normalize();

      _leanQuatRoll.setFromAxisAngle(WORLD_Z_AXIS, this.bankRoll * 0.6);
      _leanQuatPitch.setFromAxisAngle(WORLD_X_AXIS, this.accelPitch * 0.45);
      _leanDelta.copy(_leanQuatRoll).multiply(_leanQuatPitch).normalize();

      _wChest.copy(_wSpine1).multiply(chest.quaternion).normalize();
      _wChest.premultiply(_leanDelta).normalize();
      _wInvParent.copy(_wSpine1).invert();
      chest.quaternion.copy(_wInvParent).multiply(_wChest).normalize();
    } else {
      // 3-bone RunnerRig / EchoStudentRig: 40% bank / 55% pitch on spine, 60% bank / 45% pitch on chest
      _leanQuatRoll.setFromAxisAngle(WORLD_Z_AXIS, this.bankRoll * 0.4);
      _leanQuatPitch.setFromAxisAngle(WORLD_X_AXIS, this.accelPitch * 0.55);
      _leanDelta.copy(_leanQuatRoll).multiply(_leanQuatPitch).normalize();

      _wSpine.copy(_wHips).multiply(spine.quaternion).normalize();
      _wSpine.premultiply(_leanDelta).normalize();
      _wInvParent.copy(_wHips).invert();
      spine.quaternion.copy(_wInvParent).multiply(_wSpine).normalize();

      _leanQuatRoll.setFromAxisAngle(WORLD_Z_AXIS, this.bankRoll * 0.6);
      _leanQuatPitch.setFromAxisAngle(WORLD_X_AXIS, this.accelPitch * 0.45);
      _leanDelta.copy(_leanQuatRoll).multiply(_leanQuatPitch).normalize();

      _wChest.copy(_wSpine).multiply(chest.quaternion).normalize();
      _wChest.premultiply(_leanDelta).normalize();
      _wInvParent.copy(_wSpine).invert();
      chest.quaternion.copy(_wInvParent).multiply(_wChest).normalize();
    }

    this.leanCurrentlyApplied = true;
  }

  /**
   * Zero-allocation readout of smoothed left/right stance contact weights `[0..1]` and heel-to-toe
   * stance progress `[0..1]` for `legIk.ts` (`sampleStanceFootTarget` & `solveSlopeFootQuat`).
   */
  getStanceWeights(out: StanceWeightsSnapshot = this.defaultStanceOut): StanceWeightsSnapshot {
    if (this.isSeatedState || this.currentName === 'jump' || this.currentName === 'bicycle_pedal' || this.currentName === 'bicycle_coast') {
      out.stanceL = 0;
      out.stanceR = 0;
      out.progressL = 0.45;
      out.progressR = 0.45;
      out.phase01 = this.locoPhase;
      return out;
    }

    if (!this.current) {
      out.stanceL = 1;
      out.stanceR = 1;
      out.progressL = 0.45;
      out.progressR = 0.45;
      out.phase01 = 0;
      return out;
    }

    const clipA = this.current.getClip();
    const metaA = this.getOrMeasureMeta(clipA, this.currentName);
    const durA = Math.max(1e-4, clipA.duration);
    const rawPhaseA = wrapPhase01(this.current.time / durA);

    if (this.secondaryAction && this.secondaryWeight > 0.01) {
      const clipB = this.secondaryAction.getClip();
      const metaB = this.getOrMeasureMeta(clipB, this.secondaryName);
      const durB = Math.max(1e-4, clipB.duration);
      const rawPhaseB = wrapPhase01(this.secondaryAction.time / durB);
      sampleClipStanceLut(metaA, rawPhaseA, _stanceSnapA);
      sampleClipStanceLut(metaB, rawPhaseB, _stanceSnapB);
      return blendStanceSnapshots(_stanceSnapA, _stanceSnapB, this.secondaryWeight, out);
    }

    return sampleClipStanceLut(metaA, rawPhaseA, out);
  }

  /** Residual upward ankle hover bias in world metres (`0` on grounded clips whose hover bias was baked out). */
  getHoverBiasY(): number {
    if (!this.current) return 0;
    const meta = getCachedClipGaitMeta(this.current.getClip());
    return (meta?.minAnkleDeltaY ?? 0) * this.lastScale;
  }

  private getOrMeasureMeta(clip: T.AnimationClip, clipNameLower: string): ClipGaitMeta {
    const hit = getCachedClipGaitMeta(clip);
    if (hit) return hit;
    return measureClipGaitMeta(
      clip,
      this.root,
      {
        hips: this.restInfo.bones.hips,
        footL: this.restInfo.bones['foot.L'],
        footR: this.restInfo.bones['foot.R'],
      },
      {
        restFootYL: this.restInfo.footRestYL,
        restFootYR: this.restInfo.footRestYR,
        isStandingStatic: STATIC_STANDING_META_CLIPS.has(clipNameLower),
      },
    );
  }

  private resolveClipName(activity: string): string | null {
    const key = activity.toLowerCase();
    const list = ACTIVITY_CLIP_PRIORITY[key];
    if (list) {
      for (const candidate of list) {
        if (this.hasClip(candidate)) return candidate;
      }
    }
    if (this.hasClip(key)) return key;
    if (this.hasClip('idle')) return 'idle';
    return this.actions.keys().next().value ?? null;
  }

  private transitionTo(name: string, fade = 0.24, loop = true): void {
    const next = this.ensureAction(name);
    if (!next) return;
    if (next === this.current) {
      if (loop && next.loop !== T.LoopRepeat) {
        next.setLoop(T.LoopRepeat, Infinity);
        next.clampWhenFinished = false;
      }
      return;
    }

    // If `next` was already warmed as `secondaryAction` in dual-clip locomotion, promote cleanly!
    const wasSecondary = next === this.secondaryAction;
    const promotedTime = wasSecondary ? next.time : 0;
    if (this.secondaryAction) {
      if (wasSecondary) {
        this.secondaryAction = null;
        this.secondaryName = '';
        this.secondaryWeight = 0;
      } else {
        this.stopSecondaryAction();
      }
    }

    const from = this.current;
    const fromName = this.currentName;

    // Trigger Daniel Holden Dead-Blending snapshot BEFORE swapping active primary mixer clip (bounded <= 0.18 s)
    if (from && fade > 0) {
      this.deadBlend.triggerTransition(Math.min(0.18, fade), 0.055);
      from.setEffectiveWeight(0);
      from.stop();
    } else if (from) {
      from.setEffectiveWeight(0);
      from.stop();
    }

    if (loop) {
      next.setLoop(T.LoopRepeat, Infinity);
      next.clampWhenFinished = false;
    }
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.setEffectiveTimeScale(1);
    if (!wasSecondary) {
      next.reset().play();
    } else {
      next.play();
      next.time = promotedTime;
    }

    const nextClip = next.getClip();
    const nextDur = Math.max(1e-4, nextClip.duration);
    const nextMeta = this.getOrMeasureMeta(nextClip, name);

    if (wasSecondary) {
      this.locoPhase = wrapPhase01(promotedTime / nextDur - nextMeta.leftFootForwardFrac);
    } else if (from && (LOCOMOTION_CLIPS.has(name) || name === 'turn_l' || name === 'turn_r')) {
      if (STANDARD_GAIT_BANDS.has(fromName) && STANDARD_GAIT_BANDS.has(name)) {
        // Exact master-phase continuity across Walk <-> Walk_Brisk <-> Run
        next.time = wrapPhase01(this.locoPhase + nextMeta.leftFootForwardFrac) * nextDur;
      } else {
        const srcDur = Math.max(1e-4, from.getClip().duration);
        const fallbackPhase = LOCOMOTION_CLIPS.has(fromName) ? (from.time / srcDur) % 1 : 0;
        if (this.mmDb) {
          next.time = this.mmDb.bestEntryTime(
            name,
            this.prevSwingL,
            this.prevSwingR,
            this.velSwingL,
            this.velSwingR,
            fallbackPhase,
          );
        } else {
          next.time = fallbackPhase * nextDur;
        }
        this.locoPhase = wrapPhase01(next.time / nextDur - nextMeta.leftFootForwardFrac);
      }
    } else if (!from) {
      next.time = (this.seed * nextDur) % Math.max(0.05, nextDur);
    }

    this.current = next;
    this.currentName = name;
  }

  private updateDualLocomotionBlend(stepDt: number, scale: number, reduced: boolean): void {
    const primary = this.current;
    if (!primary || !STANDARD_GAIT_BANDS.has(this.currentName)) {
      this.stopSecondaryAction();
      return;
    }

    const clipA = primary.getClip();
    const metaA = this.getOrMeasureMeta(clipA, this.currentName);
    const durA = Math.max(1e-4, clipA.duration);
    const fallbackNomA =
      this.currentName === 'run' ? 2.2 : this.currentName === 'walk_brisk' ? 1.5 : 1.05;
    const vNativeA = metaA.nativeStanceSpeed > 0.15 ? metaA.nativeStanceSpeed : fallbackNomA;

    // Determine optional companion clip inside cross-band transition corridors (`[1.30, 1.62]` & `[1.88, 2.26]`)
    let wantSecondary = '';
    let wantWeightB = 0;
    if (!reduced && !this.deadBlend.isBlending) {
      const vNorm = this.smoothedSpeed / Math.max(0.5, scale);
      const hasBrisk = this.hasClip('walk_brisk');
      if (this.currentName === 'walk' && hasBrisk && vNorm > 1.24) {
        wantSecondary = 'walk_brisk';
        wantWeightB = T.MathUtils.smoothstep(vNorm, 1.24, 1.64) * 0.48;
      } else if (this.currentName === 'walk_brisk' && vNorm < 1.54 && this.hasClip('walk')) {
        wantSecondary = 'walk';
        wantWeightB = (1 - T.MathUtils.smoothstep(vNorm, 1.28, 1.54)) * 0.46;
      } else if (this.currentName === 'walk_brisk' && vNorm > 1.84 && this.hasClip('run')) {
        wantSecondary = 'run';
        wantWeightB = T.MathUtils.smoothstep(vNorm, 1.84, 2.28) * 0.48;
      } else if (this.currentName === 'run' && vNorm < 2.18) {
        const companion = hasBrisk ? 'walk_brisk' : this.hasClip('walk') ? 'walk' : '';
        if (companion) {
          wantSecondary = companion;
          wantWeightB = (1 - T.MathUtils.smoothstep(vNorm, 1.86, 2.18)) * 0.46;
        }
      }
    }

    if (wantWeightB < 0.03 || !wantSecondary || wantSecondary === this.currentName) {
      this.stopSecondaryAction();
      primary.setEffectiveWeight(1);
      const scaleA = clipStrideTimeScale(metaA, this.smoothedSpeed, scale, 1, fallbackNomA, 0.22, 1.85);
      primary.timeScale = scaleA;
      this.locoPhase = wrapPhase01(primary.time / durA - metaA.leftFootForwardFrac);
      return;
    }

    const sec = this.ensureAction(wantSecondary);
    if (!sec || sec === primary) {
      this.stopSecondaryAction();
      primary.setEffectiveWeight(1);
      primary.timeScale = clipStrideTimeScale(metaA, this.smoothedSpeed, scale, 1, fallbackNomA, 0.22, 1.85);
      return;
    }

    if (this.secondaryAction && this.secondaryAction !== sec) {
      this.stopSecondaryAction();
    }
    this.secondaryAction = sec;
    this.secondaryName = wantSecondary;
    this.secondaryWeight = wantWeightB;

    const clipB = sec.getClip();
    const metaB = this.getOrMeasureMeta(clipB, wantSecondary);
    const durB = Math.max(1e-4, clipB.duration);
    const fallbackNomB =
      wantSecondary === 'run' ? 2.2 : wantSecondary === 'walk_brisk' ? 1.5 : 1.05;
    const vNativeB = metaB.nativeStanceSpeed > 0.15 ? metaB.nativeStanceSpeed : fallbackNomB;

    if (!sec.isRunning()) {
      sec.setLoop(T.LoopRepeat, Infinity);
      sec.clampWhenFinished = false;
      sec.enabled = true;
      sec.reset().play();
    } else {
      sec.enabled = true;
    }

    primary.setEffectiveWeight(1 - wantWeightB);
    sec.setEffectiveWeight(wantWeightB);

    // Phase-locked blended stride advancement: both clips advance by identical dPhi inside mixer.update(stepDt)!
    const curMasterPhase = wrapPhase01(primary.time / durA - metaA.leftFootForwardFrac);
    sec.time = wrapPhase01(curMasterPhase + metaB.leftFootForwardFrac) * durB;

    const strideLenA = vNativeA * durA * scale;
    const strideLenB = vNativeB * durB * scale;
    const effStrideLen = Math.max(0.15, (1 - wantWeightB) * strideLenA + wantWeightB * strideLenB);
    const clampedSpeed = Math.max(0.22 * ((1 - wantWeightB) * vNativeA + wantWeightB * vNativeB) * scale, this.smoothedSpeed);
    const phaseRate = clampedSpeed / effStrideLen; // cycles per second

    primary.timeScale = T.MathUtils.clamp(phaseRate * durA, 0.22, 1.85);
    sec.timeScale = T.MathUtils.clamp(phaseRate * durB, 0.22, 1.85);
    this.locoPhase = wrapPhase01(curMasterPhase + phaseRate * stepDt);
  }

  /** Evaluates Schmitt locomotion blend space, Motion-Matching entry, Dead-Blending & centripetal lean. */
  update(f: AnimatorFrame): void {
    // Always restore any procedural torso lean from last frame BEFORE mixer/DeadBlend runs (`RC-A2` fix)
    this.restoreLeanSnapshot();

    const dt = Math.min(0.1, Math.max(0, f.dt));
    const scale = Math.max(0.35, f.scale ?? 1);
    this.lastScale = scale;

    // Fast asymmetric speed tracking (`tauUp = 18`, `tauDown = 22`) eliminates lingering stop moonwalk
    const rawSpeed = Math.max(0, Number.isFinite(f.speed) ? f.speed : 0);
    const tau = rawSpeed > this.smoothedSpeed ? 18 : 22;
    const k = f.reduced ? 1 : 1 - Math.exp(-tau * dt);
    this.prevSpeed = this.smoothedSpeed;
    this.smoothedSpeed += (rawSpeed - this.smoothedSpeed) * k;

    if (this.oneShot) {
      this.oneShot.remaining -= dt;
      if (this.oneShot.remaining <= 0.16) this.oneShot = null;
    }

    const seated = !!f.seated;
    this.isSeatedState = seated;

    if (this.oneShot) {
      if (this.oneShot.name === 'sit_down' && !seated) this.oneShot = null;
      else if (this.oneShot.name === 'stand_up' && seated) this.oneShot = null;
      else if (this.oneShot.name === 'run_stop' && (rawSpeed > 0.18 || this.smoothedSpeed > 0.28 || seated || f.inDialogue)) {
        this.oneShot = null;
      }
    }

    // Seat enter / exit transitions (`hasClip` supports lazy 48-pack resolution)
    if (seated && !this.wasSeated && !this.oneShot && this.hasClip('sit_down')) {
      this.triggerOneShot('sit_down', 0.18);
    } else if (!seated && this.wasSeated && !this.oneShot && !f.inDialogue && this.hasClip('stand_up')) {
      this.triggerOneShot('stand_up', 0.18);
    }
    this.wasSeated = seated;

    // Abrupt halt from run -> brief Run_Stop momentum recovery (never mid-direction-reversal when rawSpeed >= 0.12)
    if (!seated && !this.oneShot && this.prevSpeed > 2.05 && rawSpeed < 0.12 && this.smoothedSpeed < 0.28 && this.hasClip('run_stop')) {
      this.triggerOneShot('run_stop', 0.15);
    }

    if (!this.oneShot) {
      const target = this.chooseDesiredClip(f, seated, scale);
      if (target) {
        const isLoco = LOCOMOTION_CLIPS.has(target);
        this.transitionTo(target, isLoco ? 0.15 : 0.18, true);
      }
    }

    const stepDt = f.reduced ? Math.min(0.05, dt) : dt;

    // Apply calibrated `ClipGaitMeta` stride timeScale & optional dual-clip phase-locked locomotion blend
    if (this.current) {
      const n = this.currentName;
      if (!this.oneShot && STANDARD_GAIT_BANDS.has(n)) {
        this.updateDualLocomotionBlend(stepDt, scale, !!f.reduced);
      } else {
        this.stopSecondaryAction();
        this.current.setEffectiveWeight(1);
        if (n === 'crouch_walk' || n === 'stairs_ascend') {
          const meta = this.getOrMeasureMeta(this.current.getClip(), n);
          const fallback = n === 'crouch_walk' ? 0.72 : 0.88;
          this.current.timeScale = clipStrideTimeScale(meta, this.smoothedSpeed, scale, 1, fallback, 0.22, 1.65);
        } else if (n === 'bicycle_pedal') {
          this.current.timeScale = T.MathUtils.clamp((this.smoothedSpeed || 2.5) * 0.42, 0.35, 2.0);
        } else {
          this.current.timeScale = 1;
        }
      }
    }

    this.mixer.update(stepDt);

    if (this.current && STANDARD_GAIT_BANDS.has(this.currentName)) {
      const clipA = this.current.getClip();
      const metaA = this.getOrMeasureMeta(clipA, this.currentName);
      this.locoPhase = wrapPhase01(this.current.time / Math.max(1e-4, clipA.duration) - metaA.leftFootForwardFrac);
    }

    // Apply overshoot-free Daniel Holden Dead-Blending over the live mixer output
    this.deadBlend.apply(stepDt, !!f.reduced);

    // Snapshot clean post-DeadBlend spine quaternions BEFORE any procedural lean
    this.captureLeanSnapshot();

    // Update live sagittal thigh swing trackers for Motion-Matching queries (zero alloc)
    const thighL = this.restInfo.bones['thigh.L'];
    const thighR = this.restInfo.bones['thigh.R'];
    if (thighL && thighR && stepDt > 1e-4) {
      _tmpQ1.copy(thighL.quaternion).multiply(this.invRestThighL);
      const curL = _tmpV1.set(0, 1, 0).applyQuaternion(_tmpQ1).z;
      _tmpQ1.copy(thighR.quaternion).multiply(this.invRestThighR);
      const curR = _tmpV1.set(0, 1, 0).applyQuaternion(_tmpQ1).z;
      this.velSwingL = (curL - this.prevSwingL) / stepDt;
      this.velSwingR = (curR - this.prevSwingR) / stepDt;
      this.prevSwingL = curL;
      this.prevSwingR = curR;
    }

    // Filtered centripetal banking + start/stop pitch anticipation (0.18 rad/s deadzone, 9 Hz filter)
    if (!f.reduced && !seated && stepDt > 1e-4) {
      this.filteredYawRate = stepFilteredYawRate(this.filteredYawRate, f.yawRate ?? 0, stepDt, 9);
      const yawRateEff = applyYawRateDeadzone(this.filteredYawRate, 0.18);
      const targetBank = computeTargetBankRoll(this.smoothedSpeed, yawRateEff, 0.038, 0.14);
      const fwdAccel = (this.smoothedSpeed - this.prevSpeed) / stepDt;
      const targetPitch =
        this.smoothedSpeed > 0.08 || Math.abs(fwdAccel) > 0.25
          ? T.MathUtils.clamp(fwdAccel * 0.016, -0.09, 0.085)
          : 0;
      const dynK = 1 - Math.exp(-9 * stepDt);
      this.bankRoll += (targetBank - this.bankRoll) * dynK;
      this.accelPitch += (targetPitch - this.accelPitch) * dynK;

      if (!f.deferLean) {
        this.applyPostCaptureLean();
      }
    } else {
      this.filteredYawRate = 0;
      this.bankRoll = 0;
      this.accelPitch = 0;
    }
  }

  private chooseDesiredClip(f: AnimatorFrame, seated: boolean, scale: number): string | null {
    const act = (f.activity || 'idle').toLowerCase();

    if (f.inDialogue && !seated) {
      this.locoBand = 'idle';
      return this.resolveClipName(f.speaking ? 'talk' : 'listen');
    }

    if (seated) {
      this.locoBand = 'idle';
      if (act === 'eat') return this.resolveClipName('eat');
      if (act === 'study' || act === 'computer' || act === 'write' || act === 'read') {
        return this.resolveClipName(act);
      }
      if (act === 'sleep') return this.resolveClipName('sleep');
      return this.resolveClipName('sit');
    }

    // Standing locomotion blend space driven strictly by actual ground speed (NEVER `|| act === 'walk'` moonwalk!)
    if (
      act === 'walk' ||
      act === 'walk_brisk' ||
      act === 'run' ||
      act === 'idle' ||
      STANDING_BLOCKED_ACTIVITIES.has(act)
    ) {
      const normalizedSpeed = this.smoothedSpeed / Math.max(0.5, scale);
      const hasBrisk = this.hasClip('walk_brisk');
      this.locoBand = stepSchmittLocomotionBand(this.locoBand, normalizedSpeed, {
        hasBrisk,
        hasSprint: false,
      });

      if (this.locoBand === 'run') return this.resolveClipName('run');
      if (this.locoBand === 'walk_brisk' && hasBrisk) return 'walk_brisk';
      if (this.locoBand === 'walk') return this.resolveClipName('walk');

      // Stationary (`normalizedSpeed < 0.12` & `rawSpdNorm < 0.12`): check in-place pivot turn ONLY when standing still
      const rawSpdNorm = Math.max(0, Number.isFinite(f.speed) ? f.speed : 0) / Math.max(0.5, scale);
      const yawRate = f.yawRate ?? 0;
      if (Math.abs(yawRate) > 0.72 && normalizedSpeed < 0.12 && rawSpdNorm < 0.12) {
        return this.resolveClipName(yawRate > 0 ? 'turn_l' : 'turn_r');
      }

      if (act === 'exercise_squat') {
        return this.resolveClipName(f.speaking ? 'talk' : 'listen');
      }

      this.idleClock += f.dt;
      const cycle = ((this.idleClock + this.seed * 17) % 14) / 14;
      if (cycle > 0.55 && this.hasClip('breathing')) return 'breathing';
      return this.resolveClipName('idle');
    }

    this.locoBand = 'idle';

    if (STANDING_SOCIAL_REMAP_ACTIVITIES.has(act)) {
      if (act === 'eat' || act === 'eat_seated') {
        return this.hasClip('drink_cup') ? 'drink_cup' : this.resolveClipName('idle');
      }
      return this.resolveClipName(f.speaking ? 'talk' : 'idle');
    }

    const resolved = this.resolveClipName(act);
    if (resolved && SEATED_ONLY_CLIPS.has(resolved)) {
      return this.resolveClipName('idle');
    }
    return resolved;
  }

  dispose(): void {
    this.restoreLeanSnapshot();
    this.stopSecondaryAction();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.actions.clear();
    this.current = null;
    this.pack = null;
    this.packSourceIndex = null;
  }
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}
