import * as T from 'three';
import type { EmbodiedAction } from '@/lib/embodiment/actions';
import { alignWrist } from '@/lib/embodiment/arms';
import { CROUCH, HumanRig, type BodyFrame, type HandGesture, type RestHand } from '@/lib/embodiment/human';
import { prepareCastMaterials } from '@/lib/embodiment/skin';
import { CastLook, type Mood } from '@/lib/embodiment/cast';
import { gaitTimeScale, stepWhileTurning } from '@/lib/embodiment/gait';
import { correctGaits, type GaitReport } from '@/lib/embodiment/gaitClip';
import {
  alignSprintPhaseOrigin,
  applyYawRateDeadzone,
  computeTargetBankRoll,
  measureClipGaitMeta,
  stepFilteredYawRate,
  stepSchmittLocomotionBand,
  upgradeGaitUpperBody,
  type SchmittLocomotionBand,
} from '@/lib/embodiment/locomotionBiomech';
import { isFloorPose, PostureMachine, type FloorEnvelope, type Posture } from '@/lib/embodiment/posture';
import { readRootMotion, RootMotionClock, type RootMotionTrack } from '@/lib/embodiment/rootMotion';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { WAVE11_CAST_URLS } from '@/lib/avatar/wardrobeAssets';
import type { BedContact } from './furnitureAnchors';
import type { Activity, CharacterConfig } from '@/lib/study-space/types';
import { Wardrobe } from '@/lib/avatar/wardrobe';
import { defaultLook, isSignature, normalizeLook, type AvatarLook } from '@/lib/avatar/look';
import {
  resolveActiveOutfitForWeather,
  sanitizeCreatorProfile,
  type BodyProportions,
  type CharacterCreatorProfile,
} from '@/lib/avatar/characterCreator';
import { setSkinToneUniform } from './echoLife/characterMaterials';
import { DeadBlendInertializer } from './echoLife/deadBlend';
import type { CharacterLife, LifeMood } from './echoLife/characterLife';
import type { SecondaryPhysics } from './echoLife/secondaryPhysics';

/**
 * The learner's character: the original rigged Lyra / Kai cast (the same files as Speaking Arena, 28 joints, 20
 * authored clips). The study activities the cast was not animated for — sitting, studying at a keyboard, reading,
 * writing, listening, relaxing, sleeping, stretching — are built here as real skeletal clips: each pose aims the limb
 * bones at directions in the character's own space (forward kinematics from the rest pose), and the clips are played
 * by the same AnimationMixer with cross-fades. Colours are changed in the cast's palette texture (hair, top, bottom,
 * shoes cells), so the mesh, skin weights and face atlas stay untouched.
 */

const SCALE = 1.04;
const JUMP_GRAVITY = 16.8;
const JUMP_HEIGHT = 0.45;
const JUMP_INITIAL_VELOCITY = Math.sqrt(2 * JUMP_GRAVITY * JUMP_HEIGHT);
const LOCO_POOL = ['Idle', 'Walk', 'Walk_Brisk', 'Run', 'Sprint'] as const;
const LOCO_GAIT_SET = new Set<string>(['Walk', 'Walk_Brisk', 'Run', 'Sprint']);
const DEAD_BLEND_EXCLUDE = /^(pony|scarf|side|fringe|hair_|coat_|skirt_|eye)/i;

function wrap01(x: number): number {
  const r = x % 1;
  return r < 0 ? r + 1 : r;
}

const loader = new GLTFLoader();
const templates = new Map<string, Promise<GLTF>>();
const upgradedGaitsCache = new Map<
  string,
  { clips: T.AnimationClip[]; sprintClip: T.AnimationClip | null; sprintDrawn: number }
>();
export function loadCast(model: CharacterConfig['model']): Promise<GLTF> {
  const url = WAVE11_CAST_URLS[model];
  let p = templates.get(url);
  if (!p) {
    p = loader.loadAsync(url).catch(error=>{
      if(templates.get(url)===p)templates.delete(url);
      throw error;
    });
    templates.set(url, p);
  }
  return p;
}
const DANCE_URL = '/assets/study-space/study-dances-13e98fbf0efb.glb';
const FLOOR_URL = '/assets/study-space/study-postures-48d6fc4919fb.glb';
function loadMotionPack(url: string) {
  let result = templates.get(url);
  if (!result) {
    result = loader.loadAsync(url);
    templates.set(url, result);
  }
  return result.catch(() => { if (templates.get(url) === result) templates.delete(url); return null; });
}
export function forgetCasts() { templates.clear(); upgradedGaitsCache.clear(); }

type V3 = [number, number, number];
interface PoseBoneSpec {
  dir?: V3;
  rot?: V3;
  /** Optional world-space palm normal (+Z of hand bone) paired with `dir` (+Y along fingers). */
  palm?: V3;
  /** Keep sole horizontal on the ground regardless of parent shin pitch/roll. */
  flatFoot?: boolean;
}
interface Pose { bones: Record<string, PoseBoneSpec> }

const mirror = (p: Pose): Pose => {
  const out: Pose = { bones: { ...p.bones } };
  for (const [k, v] of Object.entries(p.bones)) {
    if (!k.endsWith('.L')) continue;
    const r = k.replace('.L', '.R');
    if (out.bones[r] && p.bones[r]) continue;
    out.bones[r] = {
      dir: v.dir ? [-v.dir[0], v.dir[1], v.dir[2]] : undefined,
      rot: v.rot ? [v.rot[0], -v.rot[1], -v.rot[2]] : undefined,
      palm: v.palm ? [-v.palm[0], v.palm[1], v.palm[2]] : undefined,
      flatFoot: v.flatFoot,
    };
  }
  return out;
};

const SEAT_LEGS = { 'thigh.L': { dir: [0.08, -0.08, 1] as V3 }, 'shin.L': { dir: [0.02, -1, 0.08] as V3 } };

const POSES: Record<string, Pose[]> = {
  sit: [mirror({ bones: { ...SEAT_LEGS, spine: { rot: [0.04, 0, 0] }, 'upper_arm.L': { dir: [0.3, -0.85, 0.35] }, 'forearm.L': { dir: [-0.1, -0.35, 1] }, head: { rot: [0.05, 0, 0] } } })],
  type: [
    mirror({ bones: { ...SEAT_LEGS, spine: { rot: [0.12, 0, 0] }, 'upper_arm.L': { dir: [0.28, -0.62, 0.72] }, 'forearm.L': { dir: [-0.22, -0.08, 1] }, head: { rot: [0.22, 0, 0] } } }),
    { bones: { ...mirror({ bones: { ...SEAT_LEGS, spine: { rot: [0.12, 0, 0.01] }, 'upper_arm.L': { dir: [0.28, -0.6, 0.74] }, 'forearm.L': { dir: [-0.2, -0.02, 1] }, head: { rot: [0.24, 0.05, 0] } } }).bones, 'forearm.R': { dir: [0.24, -0.12, 1] } } },
  ],
  read: [
    mirror({ bones: { ...SEAT_LEGS, spine: { rot: [0.06, 0, 0] }, 'upper_arm.L': { dir: [0.25, -0.9, 0.35] }, 'forearm.L': { dir: [-0.45, 0.55, 0.7] }, head: { rot: [0.32, 0, 0] } } }),
    mirror({ bones: { ...SEAT_LEGS, spine: { rot: [0.07, 0, 0] }, 'upper_arm.L': { dir: [0.25, -0.9, 0.36] }, 'forearm.L': { dir: [-0.45, 0.5, 0.72] }, head: { rot: [0.34, 0.04, 0] } } }),
  ],
  write: [
    { bones: { ...mirror({ bones: { ...SEAT_LEGS, spine: { rot: [0.16, 0, 0] }, 'upper_arm.L': { dir: [0.35, -0.6, 0.65] }, 'forearm.L': { dir: [-0.5, -0.1, 0.85] }, head: { rot: [0.35, 0, 0] } } }).bones, 'forearm.R': { dir: [0.15, -0.2, 1] } } },
    { bones: { ...mirror({ bones: { ...SEAT_LEGS, spine: { rot: [0.16, 0, 0] }, 'upper_arm.L': { dir: [0.35, -0.6, 0.65] }, 'forearm.L': { dir: [-0.5, -0.1, 0.85] }, head: { rot: [0.36, -0.03, 0] } } }).bones, 'forearm.R': { dir: [0.32, -0.22, 0.95] } } },
  ],
  listen: [
    { bones: { ...mirror({ bones: { ...SEAT_LEGS, spine: { rot: [-0.04, 0, 0] }, 'upper_arm.L': { dir: [0.3, -0.85, 0.35] }, 'forearm.L': { dir: [-0.1, -0.35, 1] } } }).bones, 'upper_arm.L': { dir: [0.75, 0.15, 0.2] }, 'forearm.L': { dir: [-0.35, 0.92, 0.05] }, head: { rot: [0.05, 0, 0.12] } } },
    { bones: { ...mirror({ bones: { ...SEAT_LEGS, spine: { rot: [-0.02, 0, 0] }, 'upper_arm.L': { dir: [0.3, -0.85, 0.35] }, 'forearm.L': { dir: [-0.1, -0.35, 1] } } }).bones, 'upper_arm.L': { dir: [0.75, 0.15, 0.2] }, 'forearm.L': { dir: [-0.35, 0.92, 0.05] }, head: { rot: [0.16, 0, 0.16] } } },
  ],
  relax: [mirror({ bones: { 'thigh.L': { dir: [0.12, -0.2, 1] }, 'shin.L': { dir: [0.05, -1, 0.3] }, spine: { rot: [-0.28, 0, 0] }, chest: { rot: [-0.05, 0, 0] }, 'upper_arm.L': { dir: [0.45, -0.85, 0.2] }, 'forearm.L': { dir: [0.15, -0.3, 1] }, head: { rot: [0.05, 0.25, 0] } } })],
  sleep: [mirror({ bones: {
    hips: { rot: [-Math.PI / 2, 0, 0] }, spine: { rot: [.16, 0, 0] }, chest: { rot: [.04, 0, 0] }, neck: { rot: [-.10, 0, 0] }, head: { rot: [-.10, 0, 0] },
    'thigh.L': { dir: [.04, .015, 1] }, 'shin.L': { dir: [0, .01, 1] },
    'upper_arm.L': { dir: [.20, .04, 1] }, 'forearm.L': { dir: [-.04, .06, 1] },
  } })],
  stretch: [
    mirror({ bones: { spine: { rot: [-0.12, 0, 0] }, 'upper_arm.L': { dir: [0.25, 1, -0.05] }, 'forearm.L': { dir: [-0.25, 1, 0] }, head: { rot: [-0.3, 0, 0] } } }),
    mirror({ bones: { spine: { rot: [-0.18, 0, 0.05] }, 'upper_arm.L': { dir: [0.2, 1, -0.1] }, 'forearm.L': { dir: [-0.3, 1, -0.05] }, head: { rot: [-0.35, 0, 0.05] } } }),
  ],
  cycle: [
    { bones: { ...mirror({ bones: { spine: { rot: [0.28, 0, 0.015] }, chest: { rot: [0.08, 0, 0] }, head: { rot: [-0.26, 0, 0] }, 'upper_arm.L': { dir: [0.24, -0.56, 0.79] }, 'forearm.L': { dir: [-0.06, -0.18, 0.98] } } }).bones,
      'thigh.L': { dir: [0.10, 0.18, 0.98] }, 'shin.L': { dir: [0.05, -0.88, -0.46] },
      'thigh.R': { dir: [-0.10, -0.62, 0.78] }, 'shin.R': { dir: [-0.05, -0.96, 0.24] } } },
    { bones: { ...mirror({ bones: { spine: { rot: [0.28, 0, -0.015] }, chest: { rot: [0.08, 0, 0] }, head: { rot: [-0.26, 0, 0] }, 'upper_arm.L': { dir: [0.24, -0.56, 0.79] }, 'forearm.L': { dir: [-0.06, -0.18, 0.98] } } }).bones,
      'thigh.L': { dir: [0.10, -0.62, 0.78] }, 'shin.L': { dir: [0.05, -0.96, 0.24] },
      'thigh.R': { dir: [-0.10, 0.18, 0.98] }, 'shin.R': { dir: [-0.05, -0.88, -0.46] } } },
  ],
  drive: [
    // Upright seated driver posture: torso straight (not reclined into the seatback) with hands comfortably on the wheel.
    mirror({ bones: { spine: { rot: [0.05, 0, 0] }, chest: { rot: [-0.02, 0, 0] }, head: { rot: [0.02, 0, 0] },
      'thigh.L': { dir: [0.08, -0.02, 0.99] }, 'shin.L': { dir: [0.02, -0.82, 0.56] },
      'upper_arm.L': { dir: [0.24, -0.40, 0.88] }, 'forearm.L': { dir: [-0.14, 0.14, 0.98] } } }),
  ],
  dribble: [
    // Frame 0 (dribblePhase = 0.0): downward push on right side; left off-arm lifts gently into natural athletic guard
    { bones: {
      spine: { rot: [0.13, -0.08, 0] }, chest: { rot: [0.06, -0.05, 0] }, head: { rot: [-0.11, 0.08, 0] },
      'thigh.L': { dir: [0.14, -0.92, 0.35] }, 'shin.L': { dir: [0.04, -0.93, -0.35] },
      'thigh.R': { dir: [-0.14, -0.92, 0.35] }, 'shin.R': { dir: [-0.04, -0.93, -0.35] },
      'upper_arm.L': { dir: [0.28, -0.84, 0.46] }, 'forearm.L': { dir: [-0.18, -0.28, 0.94] },
      'upper_arm.R': { dir: [-0.42, -0.78, 0.46] }, 'forearm.R': { dir: [-0.14, -0.82, 0.55] },
    } },
    // Frame 1 (dribblePhase = 0.5): right palm cushions ball at apex; left off-arm dips smoothly in counter-phase balance
    { bones: {
      spine: { rot: [0.09, -0.05, 0] }, chest: { rot: [0.04, -0.04, 0] }, head: { rot: [-0.09, 0.06, 0] },
      'thigh.L': { dir: [0.14, -0.94, 0.29] }, 'shin.L': { dir: [0.04, -0.95, -0.29] },
      'thigh.R': { dir: [-0.14, -0.94, 0.29] }, 'shin.R': { dir: [-0.04, -0.95, -0.29] },
      'upper_arm.L': { dir: [0.34, -0.88, 0.34] }, 'forearm.L': { dir: [-0.22, -0.46, 0.86] },
      'upper_arm.R': { dir: [-0.44, -0.68, 0.58] }, 'forearm.R': { dir: [-0.16, -0.32, 0.93] },
    } },
  ],
  aim: [
    mirror({ bones: {
      spine: { rot: [0.08, 0, 0] }, chest: { rot: [0.04, 0, 0] }, head: { rot: [-0.18, 0, 0] },
      'thigh.L': { dir: [0.12, -0.93, 0.34] }, 'shin.L': { dir: [0.03, -0.94, -0.34] },
      'upper_arm.L': { dir: [0.22, 0.22, 0.95] }, 'forearm.L': { dir: [-0.32, 0.86, 0.38] },
    } }),
  ],
  shoot: [
    mirror({ bones: {
      spine: { rot: [-0.06, 0, 0] }, chest: { rot: [-0.05, 0, 0] }, head: { rot: [-0.24, 0, 0] },
      'thigh.L': { dir: [0.08, -0.99, 0.08] }, 'shin.L': { dir: [0.02, -0.99, -0.08] },
      'upper_arm.L': { dir: [0.16, 0.78, 0.60] }, 'forearm.L': { dir: [-0.14, 0.86, 0.49] },
    } }),
  ],
  studio_contrapposto: [
    { bones: {
      hips: { rot: [0.012, -0.055, -0.028] }, spine: { rot: [0.014, 0.032, 0.018] }, chest: { rot: [-0.014, 0.024, 0.012] },
      neck: { rot: [0.0, -0.014, -0.008] }, head: { rot: [0.012, 0.020, -0.006] },
      'thigh.L': { dir: [0.092, -0.985, 0.142] }, 'shin.L': { dir: [0.028, -0.992, -0.122] }, 'foot.L': { flatFoot: true },
      'thigh.R': { dir: [-0.052, -0.997, 0.036] }, 'shin.R': { dir: [-0.018, -0.999, -0.028] }, 'foot.R': { flatFoot: true },
      'upper_arm.L': { dir: [0.235, -0.970, 0.045] }, 'forearm.L': { dir: [0.155, -0.956, 0.248] },
      'hand.L': { dir: [0.110, -0.964, 0.242], palm: [-0.95, -0.12, 0.28] },
      'upper_arm.R': { dir: [-0.225, -0.973, 0.035] }, 'forearm.R': { dir: [-0.150, -0.962, 0.225] },
      'hand.R': { dir: [-0.105, -0.968, 0.226], palm: [0.95, -0.12, 0.28] },
    } },
    { bones: {
      hips: { rot: [0.016, -0.046, -0.024] }, spine: { rot: [0.018, 0.028, 0.015] }, chest: { rot: [-0.010, 0.020, 0.010] },
      neck: { rot: [-0.004, -0.010, -0.006] }, head: { rot: [0.016, 0.015, -0.004] },
      'thigh.L': { dir: [0.088, -0.987, 0.134] }, 'shin.L': { dir: [0.026, -0.993, -0.114] }, 'foot.L': { flatFoot: true },
      'thigh.R': { dir: [-0.054, -0.997, 0.038] }, 'shin.R': { dir: [-0.018, -0.999, -0.030] }, 'foot.R': { flatFoot: true },
      'upper_arm.L': { dir: [0.242, -0.968, 0.050] }, 'forearm.L': { dir: [0.160, -0.954, 0.254] },
      'hand.L': { dir: [0.115, -0.962, 0.248], palm: [-0.95, -0.12, 0.28] },
      'upper_arm.R': { dir: [-0.232, -0.971, 0.040] }, 'forearm.R': { dir: [-0.156, -0.960, 0.232] },
      'hand.R': { dir: [-0.110, -0.966, 0.232], palm: [0.95, -0.12, 0.28] },
    } },
  ],
  studio_wave: [
    { bones: {
      hips: { rot: [0.010, 0.038, 0.022] }, spine: { rot: [-0.012, -0.024, -0.016] }, chest: { rot: [-0.022, -0.028, -0.018] },
      neck: { rot: [-0.010, 0.018, 0.022] }, head: { rot: [-0.016, 0.026, 0.034] },
      'thigh.L': { dir: [0.056, -0.997, 0.042] }, 'shin.L': { dir: [0.018, -0.999, -0.032] }, 'foot.L': { flatFoot: true },
      'thigh.R': { dir: [-0.094, -0.986, 0.136] }, 'shin.R': { dir: [-0.028, -0.993, -0.116] }, 'foot.R': { flatFoot: true },
      'shoulder.R': { rot: [0.0, -0.05, -0.08] },
      'upper_arm.L': { dir: [0.235, -0.968, 0.085] }, 'forearm.L': { dir: [0.145, -0.946, 0.290] },
      'hand.L': { dir: [0.100, -0.954, 0.282], palm: [-0.95, -0.12, 0.28] },
      'upper_arm.R': { dir: [-0.74, 0.24, 0.63] }, 'forearm.R': { dir: [-0.18, 0.94, 0.28] },
      'hand.R': { dir: [-0.14, 0.97, 0.20], palm: [0.14, -0.16, 0.98] },
      'index.1.R': { rot: [0.06, 0, -0.05] }, 'middle.1.R': { rot: [0.05, 0, 0.0] },
      'ring.1.R': { rot: [0.07, 0, 0.05] }, 'little.1.R': { rot: [0.10, 0, 0.09] }, 'thumb.1.R': { rot: [0.08, -0.12, -0.18] },
    } },
    { bones: {
      hips: { rot: [0.012, 0.032, 0.018] }, spine: { rot: [-0.010, -0.020, -0.014] }, chest: { rot: [-0.020, -0.024, -0.014] },
      neck: { rot: [-0.008, 0.014, 0.018] }, head: { rot: [-0.012, 0.022, 0.026] },
      'thigh.L': { dir: [0.058, -0.997, 0.044] }, 'shin.L': { dir: [0.018, -0.999, -0.034] }, 'foot.L': { flatFoot: true },
      'thigh.R': { dir: [-0.090, -0.987, 0.130] }, 'shin.R': { dir: [-0.026, -0.994, -0.110] }, 'foot.R': { flatFoot: true },
      'shoulder.R': { rot: [0.0, -0.04, -0.07] },
      'upper_arm.L': { dir: [0.240, -0.967, 0.088] }, 'forearm.L': { dir: [0.148, -0.944, 0.296] },
      'hand.L': { dir: [0.104, -0.952, 0.288], palm: [-0.95, -0.12, 0.28] },
      'upper_arm.R': { dir: [-0.70, 0.28, 0.66] }, 'forearm.R': { dir: [0.08, 0.95, 0.30] },
      'hand.R': { dir: [0.12, 0.97, 0.21], palm: [0.06, -0.18, 0.98] },
      'index.1.R': { rot: [0.07, 0, -0.06] }, 'middle.1.R': { rot: [0.06, 0, 0.0] },
      'ring.1.R': { rot: [0.08, 0, 0.05] }, 'little.1.R': { rot: [0.11, 0, 0.09] }, 'thumb.1.R': { rot: [0.09, -0.12, -0.18] },
    } },
  ],
  studio_cheer: [
    { bones: {
      hips: { rot: [-0.018, -0.028, -0.018] }, spine: { rot: [-0.038, 0.018, 0.012] }, chest: { rot: [-0.048, 0.016, 0.010] },
      neck: { rot: [-0.024, -0.010, -0.008] }, head: { rot: [-0.036, 0.016, 0.018] },
      'thigh.L': { dir: [0.108, -0.986, 0.126] }, 'shin.L': { dir: [0.036, -0.993, -0.112] }, 'foot.L': { flatFoot: true },
      'thigh.R': { dir: [-0.088, -0.994, 0.062] }, 'shin.R': { dir: [-0.028, -0.998, -0.054] }, 'foot.R': { flatFoot: true },
      'shoulder.L': { rot: [0.0, 0.04, 0.10] }, 'shoulder.R': { rot: [0.0, -0.04, -0.10] },
      'upper_arm.L': { dir: [0.58, 0.68, 0.44] }, 'forearm.L': { dir: [0.22, 0.95, 0.22] },
      'hand.L': { dir: [0.16, 0.96, 0.21], palm: [-0.46, -0.18, 0.87] },
      'upper_arm.R': { dir: [-0.60, 0.72, 0.35] }, 'forearm.R': { dir: [-0.20, 0.95, 0.22] },
      'hand.R': { dir: [-0.14, 0.97, 0.20], palm: [0.46, -0.18, 0.87] },
    } },
    { bones: {
      hips: { rot: [-0.022, -0.022, -0.014] }, spine: { rot: [-0.044, 0.014, 0.010] }, chest: { rot: [-0.054, 0.012, 0.008] },
      neck: { rot: [-0.028, -0.008, -0.006] }, head: { rot: [-0.042, 0.012, 0.014] },
      'thigh.L': { dir: [0.104, -0.987, 0.120] }, 'shin.L': { dir: [0.034, -0.994, -0.106] }, 'foot.L': { flatFoot: true },
      'thigh.R': { dir: [-0.090, -0.994, 0.064] }, 'shin.R': { dir: [-0.028, -0.998, -0.056] }, 'foot.R': { flatFoot: true },
      'shoulder.L': { rot: [0.0, 0.04, 0.12] }, 'shoulder.R': { rot: [0.0, -0.04, -0.12] },
      'upper_arm.L': { dir: [0.54, 0.73, 0.41] }, 'forearm.L': { dir: [0.16, 0.96, 0.21] },
      'hand.L': { dir: [0.12, 0.97, 0.20], palm: [-0.42, -0.18, 0.89] },
      'upper_arm.R': { dir: [-0.56, 0.76, 0.34] }, 'forearm.R': { dir: [-0.14, 0.96, 0.22] },
      'hand.R': { dir: [-0.10, 0.97, 0.21], palm: [0.42, -0.18, 0.89] },
    } },
  ],
  studio_think: [
    { bones: {
      hips: { rot: [0.016, -0.062, -0.028] }, spine: { rot: [0.022, 0.036, 0.018] }, chest: { rot: [0.008, 0.028, 0.014] },
      neck: { rot: [0.018, -0.022, 0.028] }, head: { rot: [0.032, -0.028, 0.068] },
      'thigh.L': { dir: [0.090, -0.986, 0.138] }, 'shin.L': { dir: [0.028, -0.993, -0.118] }, 'foot.L': { flatFoot: true },
      'thigh.R': { dir: [-0.050, -0.997, 0.038] }, 'shin.R': { dir: [-0.018, -0.999, -0.030] }, 'foot.R': { flatFoot: true },
      'upper_arm.L': { dir: [0.245, -0.966, 0.070] }, 'forearm.L': { dir: [0.150, -0.950, 0.272] },
      'hand.L': { dir: [0.105, -0.958, 0.265], palm: [-0.95, -0.12, 0.28] },
      'upper_arm.R': { dir: [-0.06, -0.76, 0.65] }, 'forearm.R': { dir: [0.52, 0.85, 0.06] },
      'hand.R': { dir: [0.18, 0.97, -0.14], palm: [0.72, -0.14, -0.68] },
      'index.1.R': { rot: [0.18, 0, -0.04] }, 'index.2.R': { rot: [0.22, 0, 0] }, 'index.3.R': { rot: [0.14, 0, 0] },
      'middle.1.R': { rot: [1.12, 0, 0] }, 'middle.2.R': { rot: [1.28, 0, 0] }, 'middle.3.R': { rot: [0.78, 0, 0] },
      'ring.1.R': { rot: [1.22, 0, 0] }, 'ring.2.R': { rot: [1.34, 0, 0] }, 'ring.3.R': { rot: [0.84, 0, 0] },
      'little.1.R': { rot: [1.28, 0, 0] }, 'little.2.R': { rot: [1.36, 0, 0] }, 'little.3.R': { rot: [0.88, 0, 0] },
      'thumb.1.R': { rot: [0.32, 0.18, -0.14] }, 'thumb.2.R': { rot: [0.24, 0, 0] },
    } },
    { bones: {
      hips: { rot: [0.018, -0.056, -0.025] }, spine: { rot: [0.025, 0.032, 0.016] }, chest: { rot: [0.012, 0.024, 0.012] },
      neck: { rot: [0.022, -0.018, 0.032] }, head: { rot: [0.038, -0.024, 0.076] },
      'thigh.L': { dir: [0.088, -0.987, 0.132] }, 'shin.L': { dir: [0.026, -0.993, -0.112] }, 'foot.L': { flatFoot: true },
      'thigh.R': { dir: [-0.052, -0.997, 0.040] }, 'shin.R': { dir: [-0.018, -0.999, -0.032] }, 'foot.R': { flatFoot: true },
      'upper_arm.L': { dir: [0.250, -0.965, 0.074] }, 'forearm.L': { dir: [0.154, -0.948, 0.278] },
      'hand.L': { dir: [0.108, -0.956, 0.270], palm: [-0.95, -0.12, 0.28] },
      'upper_arm.R': { dir: [-0.05, -0.75, 0.66] }, 'forearm.R': { dir: [0.53, 0.85, 0.05] },
      'hand.R': { dir: [0.19, 0.97, -0.14], palm: [0.72, -0.14, -0.68] },
      'index.1.R': { rot: [0.16, 0, -0.04] }, 'index.2.R': { rot: [0.20, 0, 0] }, 'index.3.R': { rot: [0.12, 0, 0] },
      'middle.1.R': { rot: [1.14, 0, 0] }, 'middle.2.R': { rot: [1.30, 0, 0] }, 'middle.3.R': { rot: [0.80, 0, 0] },
      'ring.1.R': { rot: [1.24, 0, 0] }, 'ring.2.R': { rot: [1.36, 0, 0] }, 'ring.3.R': { rot: [0.86, 0, 0] },
      'little.1.R': { rot: [1.30, 0, 0] }, 'little.2.R': { rot: [1.38, 0, 0] }, 'little.3.R': { rot: [0.90, 0, 0] },
      'thumb.1.R': { rot: [0.34, 0.18, -0.14] }, 'thumb.2.R': { rot: [0.26, 0, 0] },
    } },
  ],
  studio_peace: [
    { bones: {
      hips: { rot: [0.008, 0.052, 0.028] }, spine: { rot: [-0.016, -0.030, -0.018] }, chest: { rot: [-0.020, -0.026, -0.016] },
      neck: { rot: [-0.008, 0.020, -0.022] }, head: { rot: [-0.012, 0.028, -0.052] },
      'thigh.L': { dir: [0.058, -0.997, 0.042] }, 'shin.L': { dir: [0.018, -0.999, -0.032] }, 'foot.L': { flatFoot: true },
      'thigh.R': { dir: [-0.098, -0.985, 0.140] }, 'shin.R': { dir: [-0.030, -0.992, -0.120] }, 'foot.R': { flatFoot: true },
      'shoulder.R': { rot: [0.0, -0.04, -0.06] },
      'upper_arm.L': { dir: [0.240, -0.967, 0.080] }, 'forearm.L': { dir: [0.150, -0.948, 0.280] },
      'hand.L': { dir: [0.106, -0.955, 0.275], palm: [-0.95, -0.12, 0.28] },
      'upper_arm.R': { dir: [-0.48, -0.24, 0.84] }, 'forearm.R': { dir: [0.14, 0.92, 0.36] },
      'hand.R': { dir: [0.08, 0.98, 0.17], palm: [0.12, -0.16, 0.98] },
      'index.1.R': { rot: [-0.06, 0, -0.20] }, 'index.2.R': { rot: [0.02, 0, 0] }, 'index.3.R': { rot: [0.02, 0, 0] },
      'middle.1.R': { rot: [-0.06, 0, 0.18] }, 'middle.2.R': { rot: [0.02, 0, 0] }, 'middle.3.R': { rot: [0.02, 0, 0] },
      'ring.1.R': { rot: [1.42, 0, 0.03] }, 'ring.2.R': { rot: [1.58, 0, 0] }, 'ring.3.R': { rot: [0.98, 0, 0] },
      'little.1.R': { rot: [1.46, 0, 0.06] }, 'little.2.R': { rot: [1.60, 0, 0] }, 'little.3.R': { rot: [1.00, 0, 0] },
      'thumb.1.R': { rot: [0.68, 0.58, 0.18] }, 'thumb.2.R': { rot: [0.88, 0, 0] }, 'thumb.3.R': { rot: [0.58, 0, 0] },
    } },
    { bones: {
      hips: { rot: [0.010, 0.046, 0.024] }, spine: { rot: [-0.014, -0.026, -0.015] }, chest: { rot: [-0.018, -0.022, -0.014] },
      neck: { rot: [-0.006, 0.018, -0.026] }, head: { rot: [-0.010, 0.024, -0.060] },
      'thigh.L': { dir: [0.060, -0.997, 0.044] }, 'shin.L': { dir: [0.018, -0.999, -0.034] }, 'foot.L': { flatFoot: true },
      'thigh.R': { dir: [-0.094, -0.986, 0.134] }, 'shin.R': { dir: [-0.028, -0.993, -0.114] }, 'foot.R': { flatFoot: true },
      'shoulder.R': { rot: [0.0, -0.05, -0.07] },
      'upper_arm.L': { dir: [0.245, -0.966, 0.084] }, 'forearm.L': { dir: [0.154, -0.946, 0.286] },
      'hand.L': { dir: [0.110, -0.953, 0.280], palm: [-0.95, -0.12, 0.28] },
      'upper_arm.R': { dir: [-0.46, -0.22, 0.86] }, 'forearm.R': { dir: [0.16, 0.92, 0.35] },
      'hand.R': { dir: [0.10, 0.98, 0.17], palm: [0.10, -0.16, 0.98] },
      'index.1.R': { rot: [-0.05, 0, -0.21] }, 'index.2.R': { rot: [0.03, 0, 0] }, 'index.3.R': { rot: [0.02, 0, 0] },
      'middle.1.R': { rot: [-0.05, 0, 0.19] }, 'middle.2.R': { rot: [0.03, 0, 0] }, 'middle.3.R': { rot: [0.02, 0, 0] },
      'ring.1.R': { rot: [1.44, 0, 0.03] }, 'ring.2.R': { rot: [1.60, 0, 0] }, 'ring.3.R': { rot: [0.99, 0, 0] },
      'little.1.R': { rot: [1.48, 0, 0.06] }, 'little.2.R': { rot: [1.62, 0, 0] }, 'little.3.R': { rot: [1.02, 0, 0] },
      'thumb.1.R': { rot: [0.70, 0.58, 0.18] }, 'thumb.2.R': { rot: [0.90, 0, 0] }, 'thumb.3.R': { rot: [0.60, 0, 0] },
    } },
  ],
  shower_rinse: [
    { bones: {
      hips: { rot: [0.010, -0.022, -0.012] }, spine: { rot: [0.028, 0.018, 0.010] }, chest: { rot: [0.018, 0.016, 0.008] },
      neck: { rot: [-0.035, 0.018, -0.012] }, head: { rot: [-0.10, 0.026, -0.016] },
      'thigh.L': { dir: [0.068, -0.994, 0.085] }, 'shin.L': { dir: [0.022, -0.997, -0.072] }, 'foot.L': { flatFoot: true },
      'thigh.R': { dir: [-0.064, -0.995, 0.070] }, 'shin.R': { dir: [-0.020, -0.998, -0.058] }, 'foot.R': { flatFoot: true },
      'upper_arm.L': { dir: [0.34, -0.78, 0.52] }, 'forearm.L': { dir: [-0.52, 0.62, 0.58] },
      'hand.L': { dir: [-0.48, 0.68, 0.55], palm: [-0.25, -0.45, -0.86] },
      'upper_arm.R': { dir: [-0.36, -0.72, 0.59] }, 'forearm.R': { dir: [0.46, 0.70, 0.54] },
      'hand.R': { dir: [0.42, 0.74, 0.52], palm: [0.25, -0.42, -0.87] },
    } },
    { bones: {
      hips: { rot: [0.012, 0.022, 0.012] }, spine: { rot: [0.022, -0.020, -0.010] }, chest: { rot: [0.012, -0.018, -0.008] },
      neck: { rot: [-0.040, -0.018, 0.012] }, head: { rot: [-0.10, -0.024, 0.016] },
      'thigh.L': { dir: [0.064, -0.995, 0.078] }, 'shin.L': { dir: [0.020, -0.998, -0.066] }, 'foot.L': { flatFoot: true },
      'thigh.R': { dir: [-0.068, -0.994, 0.076] }, 'shin.R': { dir: [-0.022, -0.997, -0.064] }, 'foot.R': { flatFoot: true },
      'upper_arm.L': { dir: [0.32, -0.82, 0.47] }, 'forearm.L': { dir: [-0.44, 0.52, 0.73] },
      'hand.L': { dir: [-0.40, 0.58, 0.71], palm: [-0.30, -0.48, -0.82] },
      'upper_arm.R': { dir: [-0.42, -0.48, 0.77] }, 'forearm.R': { dir: [0.32, 0.86, 0.40] },
      'hand.R': { dir: [0.26, 0.90, 0.35], palm: [0.22, -0.34, -0.91] },
    } },
  ],
};

/** Which poses are seated, and where the hips go relative to the anchor (metres, world). */
const SEATED = new Set(['sit', 'type', 'read', 'write', 'listen', 'relax']);
const NON_STEPPING_FULLBODY_CLIPS = new Set([
  'Greet_Wave',
  'Festival_Celebrate',
  'Dance_Pop',
  'Wave',
  'Cheer',
  'stretch',
  'shower_rinse',
  'Sport_Basketball_Shoot',
  'Talk_Gesture',
  'Festival_Guitar',
  'Festival_Present',
  'Exercise_Squat',
  'Stand_Up',
  'Sit_Down',
  'studio_contrapposto',
  'studio_wave',
  'studio_cheer',
  'studio_think',
  'studio_peace',
]);

interface Rest { local: T.Quaternion; world: T.Quaternion; dir: T.Vector3 | null }
/** `work`: the desk as measured from the seat, metres ahead of it: where its front edge is, where the hands go, how far off centre. */
export interface SeatContacts {
  armrest?: number;
  deskHeight?: number;
  work?: { edge: number; x: number; z: number };
  bed?: BedContact;
  approaches?: T.Vector3[];
  mobility?: 'stationary' | 'rolling';
  onChairPoseChange?: (pos: T.Vector3, rotY: number, moving: boolean) => void;
  slide?: { id?: string; distance: number; moved?: number; move: (d: number) => void; done: () => void };
}

export interface EmbodiedActionAlignment {
  anchor?: T.Vector3 | { x: number; y?: number; z: number } | null;
  yaw?: number;
  clip?: string;
  gesture?: EmbodiedAction;
  oneShot?: boolean;
  active?: boolean;
  snapRadius?: number;
  onStart?: () => void;
  onEnd?: () => void;
}

export interface EmbodiedSessionSpec {
  anchor: { x: number; y?: number; z: number };
  yaw: number;
  clip?: string;
  active?: boolean;
  snapRadius?: number;
  onStart?: () => void;
  onEnd?: () => void;
}

const MAX_POSE_FOREARM_TWIST_RAD = (85 * Math.PI) / 180;
const POSE_Y_AXIS = new T.Vector3(0, 1, 0);
const FINGER_BONE_RE = /^(thumb|index|middle|ring|little)\.\d\.[LR]$/;

function studioHingeWorldFrame(boneDir: T.Vector3, hingeAxis: T.Vector3): T.Quaternion {
  const y = boneDir.clone().normalize();
  const x = hingeAxis.clone().addScaledVector(y, -hingeAxis.dot(y));
  if (x.lengthSq() < 1e-6) {
    x.set(-1, 0, 0).addScaledVector(y, y.x);
    if (x.lengthSq() < 1e-6) x.set(0, 0, 1).addScaledVector(y, -y.z);
  }
  x.normalize();
  const z = new T.Vector3().crossVectors(x, y).normalize();
  return new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(x, y, z)).normalize();
}

function aimLimbFromRestWorld(
  rDir: T.Vector3,
  rWorld: T.Quaternion,
  boneDir: T.Vector3,
  wantAnteriorZ: T.Vector3 | null,
  blendZ: number,
): T.Quaternion {
  const dir = boneDir.clone().normalize();
  const qAim = new T.Quaternion().setFromUnitVectors(rDir, dir).multiply(rWorld).normalize();
  if (!wantAnteriorZ || blendZ <= 1e-3) return qAim;
  const curZ = new T.Vector3(0, 0, 1).applyQuaternion(qAim);
  const curProj = curZ.addScaledVector(dir, -curZ.dot(dir));
  const wantProj = wantAnteriorZ.clone().addScaledVector(dir, -wantAnteriorZ.dot(dir));
  if (curProj.lengthSq() < 0.025 || wantProj.lengthSq() < 0.025) return qAim;
  curProj.normalize();
  wantProj.normalize();
  const cross = new T.Vector3().crossVectors(curProj, wantProj);
  const rawAng = Math.atan2(dir.dot(cross), T.MathUtils.clamp(curProj.dot(wantProj), -1, 1));
  const clampedAng = T.MathUtils.clamp(rawAng, -1.05, 1.05) * blendZ;
  if (Math.abs(clampedAng) <= 1e-5) return qAim;
  return new T.Quaternion().setFromAxisAngle(dir, clampedAng).multiply(qAim).normalize();
}

function aimHandFromRestWorld(
  rWorld: T.Quaternion,
  fingersDir: T.Vector3,
  palmNormal: T.Vector3,
): T.Quaternion {
  const dir = fingersDir.clone().normalize();
  const restFingers = new T.Vector3(0, 1, 0).applyQuaternion(rWorld).normalize();
  const qAim = new T.Quaternion().setFromUnitVectors(restFingers, dir).multiply(rWorld).normalize();
  const curPalm = new T.Vector3(0, 0, 1).applyQuaternion(qAim);
  const curProj = curPalm.addScaledVector(dir, -curPalm.dot(dir));
  const wantProj = palmNormal.clone().addScaledVector(dir, -palmNormal.dot(dir));
  if (curProj.lengthSq() < 1e-5 || wantProj.lengthSq() < 1e-5) return qAim;
  curProj.normalize();
  wantProj.normalize();
  const cross = new T.Vector3().crossVectors(curProj, wantProj);
  const ang = Math.atan2(dir.dot(cross), T.MathUtils.clamp(curProj.dot(wantProj), -1, 1));
  return new T.Quaternion().setFromAxisAngle(dir, ang).multiply(qAim).normalize();
}

/** Builds one clip of `poses` (looped, `period` seconds) by aiming bones from `r.world` with bounded anatomical roll and wrist twist distribution. */
function buildClip(clipName: string, poses: Pose[], bones: Map<string, T.Bone>, rest: Map<string, Rest>, order: string[], period: number): T.AnimationClip {
  const keyTimes = poses.length === 1 ? [0, period] : [0, period / 2, period];
  const sequence = poses.length === 1 ? [poses[0], poses[0]] : [poses[0], poses[1], poses[0]];
  const tracks: T.KeyframeTrack[] = [];
  const values = new Map<string, number[]>();
  const isStudioClip = clipName.startsWith('studio_');
  const prevTwistByBone = new Map<string, number>();

  for (const pose of sequence) {
    const worldNow = new Map<string, T.Quaternion>();
    const authoredWorldNow = new Map<string, T.Quaternion>();
    for (const name of order) {
      const b = bones.get(name)!;
      const r = rest.get(name)!;
      const authored = (b.userData.name as string | undefined) ?? name;
      const parentName = b.parent && (b.parent as T.Bone).isBone ? b.parent.name : null;
      const parentWorld = parentName && worldNow.get(parentName) ? worldNow.get(parentName)! : parentName ? rest.get(parentName)!.world : null;
      const spec = pose.bones[authored] ?? pose.bones[name];
      let world: T.Quaternion;

      if (spec?.flatFoot) {
        world = r.world.clone();
        if (spec.rot) {
          const d = new T.Quaternion().setFromEuler(new T.Euler(...spec.rot, 'XYZ'));
          world.premultiply(d).normalize();
        }
      } else if (
        (authored === 'upper_arm.L' || authored === 'upper_arm.R' || authored === 'forearm.L' || authored === 'forearm.R') &&
        spec?.dir &&
        r.dir
      ) {
        const side = authored.endsWith('.L') ? 'L' : 'R';
        const uSpec = pose.bones[`upper_arm.${side}`];
        const fSpec = pose.bones[`forearm.${side}`];
        const boneDir = new T.Vector3(...spec.dir).normalize();
        if (uSpec?.dir && fSpec?.dir && clipName !== 'sleep' && clipName !== 'stretch') {
          const uDir = new T.Vector3(...uSpec.dir).normalize();
          const fDir = new T.Vector3(...fSpec.dir).normalize();
          const hinge = uDir.clone().cross(fDir);
          const hingeLen = hinge.length();
          if (hingeLen >= 0.28) {
            hinge.divideScalar(hingeLen);
            world = studioHingeWorldFrame(boneDir, hinge);
          } else if (isStudioClip) {
            if (hingeLen < 1e-2) hinge.set(-1, 0, 0);
            else hinge.divideScalar(hingeLen);
            world = studioHingeWorldFrame(boneDir, hinge);
          } else {
            world = aimLimbFromRestWorld(r.dir, r.world, boneDir, new T.Vector3(0, 0, 1), 0.65);
          }
        } else {
          world = aimLimbFromRestWorld(
            r.dir,
            r.world,
            boneDir,
            clipName === 'sleep' ? null : new T.Vector3(0, 0, 1),
            clipName === 'sleep' ? 0 : 0.45,
          );
        }
      } else if ((authored === 'hand.L' || authored === 'hand.R') && spec?.dir && spec?.palm) {
        const side = authored.endsWith('.L') ? 'L' : 'R';
        const fingersDir = new T.Vector3(...spec.dir).normalize();
        const palmNormal = new T.Vector3(...spec.palm).normalize();
        world = aimHandFromRestWorld(r.world, fingersDir, palmNormal);
        const foreSpec = pose.bones[`forearm.${side}`];
        if (foreSpec?.dir) {
          alignWrist(world, new T.Vector3(...foreSpec.dir).normalize(), 0.38);
        }
      } else if ((authored === 'fore_twist.L' || authored === 'fore_twist.R') && !spec) {
        const side = authored.endsWith('.L') ? 'L' : 'R';
        const foreW = authoredWorldNow.get(`forearm.${side}`);
        const handW = authoredWorldNow.get(`hand.${side}`);
        const handBone = bones.get(`hand.${side}`) ?? bones.get(`hand${side}`);
        const handRest = handBone ? rest.get(handBone.name) : undefined;
        if (foreW && handW && handRest) {
          const handLocal = foreW.clone().invert().multiply(handW).normalize();
          const qDelta = handRest.local.clone().invert().multiply(handLocal).normalize();
          const sy = qDelta.w < 0 ? -qDelta.y : qDelta.y;
          const sw = qDelta.w < 0 ? -qDelta.w : qDelta.w;
          let angle = 2 * Math.atan2(sy, sw);
          const prev = prevTwistByBone.get(authored);
          if (prev !== undefined) {
            const dAng = Math.atan2(Math.sin(angle - prev), Math.cos(angle - prev));
            angle = prev + dAng;
          }
          const clamped = T.MathUtils.clamp(angle, -MAX_POSE_FOREARM_TWIST_RAD, MAX_POSE_FOREARM_TWIST_RAD);
          prevTwistByBone.set(authored, clamped);
          const twistLocal = r.local.clone().multiply(new T.Quaternion().setFromAxisAngle(POSE_Y_AXIS, clamped * 0.72)).normalize();
          world = (parentWorld ?? new T.Quaternion()).clone().multiply(twistLocal);
        } else {
          world = (parentWorld ?? new T.Quaternion()).clone().multiply(r.local);
        }
      } else if (spec?.dir && r.dir) {
        const target = new T.Vector3(...spec.dir).normalize();
        world = new T.Quaternion().setFromUnitVectors(r.dir, target).multiply(r.world);
      } else if (spec?.rot && FINGER_BONE_RE.test(authored)) {
        // Finger flexion (+X), opposition (+Y), and spread (+Z) are authored in finger-bone local space (`r.local * d`).
        const d = new T.Quaternion().setFromEuler(new T.Euler(...spec.rot, 'XYZ'));
        const fingerLocal = r.local.clone().multiply(d).normalize();
        world = (parentWorld ?? new T.Quaternion()).clone().multiply(fingerLocal).normalize();
      } else if (spec?.rot) {
        const d = new T.Quaternion().setFromEuler(new T.Euler(...spec.rot, 'XYZ'));
        const parentRestWorld = parentName ? rest.get(parentName)!.world : new T.Quaternion();
        // A tilt is relative to the parent as posed: keep the rest offset from the parent, then tilt.
        const rel = parentRestWorld.clone().invert().multiply(r.world);
        world = d.multiply((parentWorld ?? new T.Quaternion()).clone().multiply(rel));
      } else {
        world = (parentWorld ?? new T.Quaternion()).clone().multiply(r.local);
      }
      worldNow.set(name, world);
      authoredWorldNow.set(authored, world);
      const local = parentWorld ? parentWorld.clone().invert().multiply(world) : world.clone();
      const list = values.get(name) ?? [];
      list.push(local.x, local.y, local.z, local.w);
      values.set(name, list);
    }
  }
  for (const [bone, v] of values) tracks.push(new T.QuaternionKeyframeTrack(`${bone}.quaternion`, keyTimes, v));
  return new T.AnimationClip(clipName, period, tracks);
}

/** Palette cells of the cast texture (8 x 8 grid of 8 px cells) by part, found from the skin weights of the cells. */
const PALETTE_CELLS: Record<'hair' | 'top' | 'bottom' | 'shoes', [number, number][]> = {
  hair: [[2, 1], [3, 1]],
  top: [[1, 1], [2, 0]],
  bottom: [[5, 0], [5, 1]],
  shoes: [[6, 0], [7, 0]],
};

const GESTURE_OF: Partial<Record<EmbodiedAction, HandGesture>> = { wave: 'wave', clap: 'clap', cheer: 'cheer', listen: 'listen', inspect: 'inspect', dance: 'dance', jump: 'hop' };
export interface LookFrame { yaw: number; yawRange: number; pitchMin: number; pitchMax: number; pitch: number }
const moodOf = (a: Activity): Mood => a === 'sleep' ? 'sleep' : a === 'wave' || a === 'stretch' ? 'happy' : a === 'study' || a === 'type' || a === 'write' || a === 'read' ? 'focus' : a === 'listen' ? 'listen' : a === 'relax' ? 'smile' : 'neutral';

/** three.js's own fade scheduler: a fade between two given weights (not in its typings). */
type Fading = { _scheduleFading(duration: number, weightNow: number, weightThen: number): unknown };
export class Character {
  readonly root = new T.Group();
  private model!: T.Object3D;
  private mixer!: T.AnimationMixer;
  private actions = new Map<string, T.AnimationAction>();
  private current: T.AnimationAction | null = null;
  private currentName = '';
  private expression: { action: EmbodiedAction; elapsed: number } | null = null;
  look: CastLook | null = null;
  /** From the head bone to between the eyes, measured from this skeleton. */
  private eyeUp = .13;
  private eyeForward = .06;
  private mood: Mood = 'neutral';
  private frame = { dt: 0, reduced: false };
  private palette: { canvas: HTMLCanvasElement; tex: T.CanvasTexture; base: ImageData } | null = null;
  private materials: T.Material[] = [];
  private hipRest = 0.86;
  private lyingProfile = { bodyMin: 0, headMin: 0, head: new T.Vector3() };
  private disposed = false;
  private poseEpoch = 0;
  private elapsed = 0;
  private blendRemaining = 0;
  private walkTo: { target: T.Vector3; points: T.Vector3[]; then: (() => void) | null; blockedFor: number } | null = null;
  private navigate: ((from: T.Vector3, to: T.Vector3) => T.Vector3[] | null) | null = null;
  setNavigator(navigate: (from: T.Vector3, to: T.Vector3) => T.Vector3[] | null) {
    this.navigate = navigate;
    if(this.walkTo) {
      const path=navigate(this.root.position,this.walkTo.target);
      if(path) this.walkTo.points=path;
      else { this.walkTo=null; this.play('Idle'); window.dispatchEvent(new Event('study:navigation-blocked')); }
    }
  }
  private seat: { key: string; pos: T.Vector3; approach: T.Vector3; rotY: number; drop: number; floorY: number; pelvisDrop: number; lie: boolean; started: number; top: number; mobility: 'stationary' | 'rolling'; contacts: SeatContacts; targetActivity: Activity; activityStarted: boolean; from?: T.Vector3 } | null = null;
  readonly body = new PostureMachine();
  private motions = new Map<string, { track: RootMotionTrack; hands: 'free' | 'carry'; holdAt?: number; envelope?: FloorEnvelope }>();
  private motion: { clock: RootMotionClock; action: T.AnimationAction; leaving: number; reason: string | null; holdAt?: number; settled?: boolean; rising?: boolean; aligning?: boolean } | null = null;
  private motionEye = 0;
  private lastMotion: { name: string; time: number; reason: string } | null = null;
  /** Admission is checked again while playing; a new manipulation cannot silently share the body. */
  motionAllowed: ((hands: 'free' | 'carry') => boolean) | null = null;
  motionClearance: ((from: T.Vector3, to: T.Vector3) => number) | null = null;
  floorSpaceFree: ((origin: {x:number;z:number;yaw:number}, envelope: FloorEnvelope) => boolean) | null = null;
  onFloorRest: ((at: [number,number,number], yaw: number, pose: NonNullable<CharacterConfig['floorPose']>) => void) | null = null;
  onMotionEnd: (() => void) | null = null;
  /** Invoked on `resetPose()` (teleport/fast-travel/layout reset) so callers can cancel active interaction actions. */
  onResetPose: (() => void) | null = null;
  /** Invoked whenever Character Creator body proportion sliders change standing height / build width (for Rapier actor capsule). */
  onActorDimensionsChange: ((standingHeightM: number, buildScale: number) => void) | null = null;
  /** Optional listener notified when a wheeled rolling chair moves or swivels (`chair.office` / `gaming-chair`). */
  onRollingChairPoseChange: ((seatKey: string, pos: T.Vector3, rotY: number, moving: boolean) => void) | null = null;
  /** When true (or once `updatePostIk()` is invoked by the engine), defers XPBD hair/scarf and CastLook gaze until after `HumanRig.update()`. */
  deferPostIk = false;
  /** Set true if `engine.ts` passes `leanRoll` and `leanPitch` directly into `HumanRig.update(BodyFrame)`. */
  bodyLeanDelegatedToRig = false;
  /** Live centripetal curve bank roll (radians) for 3rd-person running turns. */
  leanRoll = 0;
  /** Live forward acceleration / stair torso pitch (radians). */
  leanPitch = 0;
  private postIkRanThisFrame = false;
  private deadBlend: DeadBlendInertializer | null = null;
  private mixerBase = new Map<T.Bone, T.Quaternion>();
  private mixerBindQuat = new Map<T.Bone, T.Quaternion>();
  private bonesByNodeName = new Map<string, T.Bone>();
  private readonly clipQuatBoneCache = new WeakMap<T.AnimationClip, Set<T.Bone>>();
  private readonly activeClipBoneSetsScratch: Set<T.Bone>[] = [];
  private bindBonePos = new Map<string, T.Vector3>();
  private bindBoneQuat = new Map<string, T.Quaternion>();
  private bindBoneModelMat = new Map<string, T.Matrix4>();
  private propBoneModelInv = new Map<string, T.Matrix4>();
  private ownedPropGeometries = new Set<T.BufferGeometry>();
  private rawBindHipsPos = new T.Vector3(0, 0.895, -0.005);
  private baseFootRestY = new Map<string, number>();
  private baseGaitDrawn: Partial<Record<'Walk' | 'Run', number>> = {};
  private baseSprintDrawn = 2.85;
  private sprintDrawn = 2.85;
  private briskDrawn = 1.48;
  private heightScaleNow = 1;
  private buildScaleNow = 1;
  private shoulderWidthNow = 1;
  private legRatioNow = 1;
  private torsoDepthNow = 1;
  private hipWidthNow = 1;
  private modelScaleNow = SCALE;
  private hipsLegOffsetModelY = 0;
  private seatPelvisDropY = 0;
  private risingPelvisDropFrom = 0;
  private studioSpeaking = false;
  private studioSettlePending = false;
  private rollingVelX = 0;
  private rollingVelZ = 0;
  private rollingSpeedNow = 0;
  private rollingScootPhase = 0;
  private readonly eyeWorldScratchA = new T.Vector3();
  private readonly eyeWorldScratchB = new T.Vector3();
  private readonly headQuatScratch = new T.Quaternion();
  private readonly dismountCandScratch = new T.Vector3();
  private masterPhase = 0;
  private locomotionBlendActive = false;
  private locomotionSpeed = 0;
  private schmittBand: SchmittLocomotionBand = 'idle';
  private filteredYawRate = 0;
  private smoothedMoveYaw = 0;
  private isBackpedaling = false;
  private lastSharpTurnSign = 1;
  private idleLifeWeight = 1;
  private readonly driveDeltaScratch = new T.Vector3();
  private readonly driveFromScratch = new T.Vector3();
  private readonly driveTargetScratch = new T.Vector3();
  private readonly lifePreQuats = Array.from({ length: 7 }, () => new T.Quaternion());
  private readonly lifePreHipsPos = new T.Vector3();
  private jumpPhase: 'none' | 'takeoff' | 'airborne' | 'land' = 'none';
  private jumpLandLeft = 0;
  private readonly seatedTargetsScratch = {
    left: new T.Vector3(),
    right: new T.Vector3(),
    leftPole: new T.Vector3(),
    rightPole: new T.Vector3(),
    weight: 0,
  };
  private readonly leanRightScratch = new T.Vector3();
  private readonly leanFwdScratch = new T.Vector3();
  private readonly leanQuatScratch = new T.Quaternion();
  private readonly leanParentInvScratch = new T.Quaternion();
  private readonly leanWorldQuatScratch = new T.Quaternion();
  private handSkinMaterials: T.Material[] = [];
  private creatorProfile: CharacterCreatorProfile | null = null;
  private lastCreatorOutfitSig = '';
  private lastCreatorBodySig = '';
  private expressionOverride: Mood | null = null;
  private studioPose: string | null = null;
  private life: CharacterLife | null = null;
  private secondary: SecondaryPhysics | null = null;
  private secondaryWind = { x: 0, z: 0, gust: 0.35 };
  private sportMode: 'none' | 'dribble' | 'aim' | 'shoot' = 'none';
  private sportPhase = 0;
  private sportBallWorld: { x: number; y: number; z: number } | null = null;
  private sportContactOwned = false;
  private sportShootLeft = 0;
  private clipOneShotLeft = 0;
  private dialogueActive = false;
  private dialogueSpeaking = false;
  private dialogueLookTarget: T.Vector3 | null = null;
  private mirrorObserved = false;
  private embodiedSession: {
    clip: string;
    anchor: T.Vector3;
    yaw: number;
    onEnd?: () => void;
  } | null = null;
  get modelId(): CharacterConfig['model'] { return this.cfg.model; }
  get isMirrorObserved(): boolean { return this.mirrorObserved; }
  setMirrorObserved(observed: boolean): void {
    const next = Boolean(observed);
    if (this.mirrorObserved === next) return;
    this.mirrorObserved = next;
    this.look?.setMirrorObserved(next);
  }
  get isEmbodiedSessionActive(): boolean { return this.embodiedSession !== null; }
  private isHoldingRoomProp(): boolean {
    if (this.workingBody) return true;
    if (this.motionAllowed && this.motionAllowed('free') === false && this.motionAllowed('carry') === true) {
      return true;
    }
    for (const side of [1, -1]) {
      const onObj = this.rig?.contactOn(side)?.on;
      if (!onObj) continue;
      if (/grip|handlebar|steer|pedal|vehicle|bike|scooter/i.test(onObj.name)) continue;
      if (this.root.parent && onObj.parent === this.root.parent) return true;
    }
    return false;
  }
  get isStudioPoseActive(): boolean { return this.studioPose !== null || this.studioSpeaking || this.currentName.startsWith('studio_'); }
  get isNonSteppingEmoteActive(): boolean {
    return (
      this.clipOneShotLeft > 0 ||
      this.sportMode !== 'none' ||
      this.sportShootLeft > 0 ||
      (this.expression !== null && this.expression.action !== 'jump') ||
      NON_STEPPING_FULLBODY_CLIPS.has(this.currentName)
    );
  }
  get seatMobility(): 'stationary' | 'rolling' { return this.seat?.mobility ?? 'stationary'; }
  set seatMobility(v: 'stationary' | 'rolling') { if (this.seat) this.seat.mobility = v; }
  get activeSeatKey(): string | null { return this.seat?.key ?? this.body.seat; }
  get activeSeatPose(): { key: string; x: number; y: number; z: number; rotY: number; moving: boolean } | null {
    if (!this.seat) return null;
    return {
      key: this.seat.key,
      x: this.seat.pos.x,
      y: this.seat.floorY,
      z: this.seat.pos.z,
      rotY: this.seat.rotY,
      moving: this.rollingSpeedNow > 0.015,
    };
  }
  get isApproachingSeat(): boolean { return this.body.state === 'approaching' || Boolean(this.walkTo && (this.seatWalk || this.body.seat !== null)); }
  get isDismountingSeat(): boolean { return this.rising !== null || this.body.state === 'rising'; }
  get floorPostureActive() { return this.motion?.holdAt !== undefined; }
  get recliningWeight() {
    const name = this.motion?.clock.track.name;
    return name === 'Prone' || name === 'SideLying' ? this.motionWeight : 0;
  }
  get motionActive() { return this.motion !== null; }
  get motionState() { const m = this.motion; return m ? { name: m.clock.track.name, time: m.clock.time, result: m.leaving > 0 ? 'leaving' : m.settled && !m.rising ? 'resting' : m.clock.result, blockedFor: m.clock.blockedFor, contacts: m.clock.contacts, reason: m.reason } : this.lastMotion; }
  get motionContacts() { return this.motion && !this.motion.leaving ? this.motion.clock.contacts : null; }
  get motionWeight() { return this.motion?.action.getEffectiveWeight() ?? 0; }
  private ownView = false;
  /** A tool in the hands is working this body: the eyes go down with it. */
  workingBody = false;
  private eyes = { stand: new T.Vector3(0, 1.5, 0), sit: new T.Vector3(0, 1.1, 0), lie: new T.Vector3(0, .1, -.6) };
  private eyeSit = 0;
  private eyeLie = 0;
  private rising: {from:T.Vector3;to:T.Vector3;elapsed:number;seconds:number;lying:boolean}|null=null;
  private chairBack: {id?:string;left:number;move:(d:number)=>void;done:()=>void}|null=null;
  /** The weight leaning forward while sitting down or getting up, radians. */
  lean = 0;
  private paintKey='';
  private bones = new Map<string,T.Bone>();
  private footRest = new Map<string,{y:number;rotation:T.Quaternion}>();
  /** What the body wears. */
  wardrobe: Wardrobe | null = null;
  private lookKey = '';
  /** The one skeleton, whatever the camera. */
  rig: HumanRig | null = null;
  /** How far the hips turn from the shoulders towards the direction of travel. */
  moveYaw = 0;
  private turning = 0;
  activity: Activity = 'idle';
  ready = false;
  diagnostics() { return { ready:this.ready, moving:!!this.walkTo, position:this.root.position.toArray(), waypoints:this.walkTo?.points.map(p=>p.toArray())??[], joints:Object.fromEntries(['hips','spine','chest','neck','head','thigh.L','shin.L','foot.L','hand.L','hand.R'].map(n=>[n,this.bones.get(n)?.getWorldPosition(new T.Vector3()).toArray()])), seatTop:this.seat?.top, pose:this.rising?'getting-up':this.walkTo?'walking':this.seat?.lie?'lying':this.seat?'sitting':'standing', posture:this.body.state, postureChanges:this.body.changes, eyes:{stand:this.eyes.stand.toArray(),sit:this.eyes.sit.toArray(),lie:this.eyes.lie.toArray()}, rootRotation:this.root.rotation.toArray(), lyingProfile:{bodyMin:this.lyingProfile.bodyMin,headMin:this.lyingProfile.headMin,head:this.lyingProfile.head.toArray()}, bed:this.seat?.contacts.bed }; }

  constructor(private cfg: CharacterConfig) {
    this.root.name = 'character';
    this.root.rotation.order = 'YXZ';
  }

  async load(): Promise<void> {
    const [gltf, dances, floor, matMod, lifeMod, animMod, secMod] = await Promise.all([
      loadCast(this.cfg.model),
      loadMotionPack(DANCE_URL),
      loadMotionPack(FLOOR_URL),
      import('./echoLife/characterMaterials').catch(() => null),
      import('./echoLife/characterLife').catch(() => null),
      import('./echoLife/characterAnimator').catch(() => null),
      import('./echoLife/secondaryPhysics').catch(() => null),
    ]);
    if (this.disposed) return;
    this.model = clone(gltf.scene);
    this.modelScaleNow = SCALE;
    this.model.scale.setScalar(SCALE);
    const holder = new T.Group();
    holder.add(this.model);
    this.root.add(holder);
    this.materials.push(...prepareCastMaterials(this.model));
    this.look = new CastLook(this.model, this.cfg.model);
    this.look.setMirrorObserved(this.mirrorObserved);
    this.materials.push(...this.look.materials);
    // Upgrade Runner_Body / Cast_Scarf via unified Character PBR (cotton/knit sheen + cast/receive shadows) while preserving palette canvas and CastLook ownership.
    if (matMod) {
      const pbr = matMod.upgradeCharacterMaterials(this.model, {
        quality: 'high',
        castShadow: true,
        receiveShadow: true,
        vertexHairSway: false,
        skipMesh: (mesh) => CastLook.owns(mesh) || mesh.name.includes('Hands'),
      });
      this.materials.push(...pbr.materials);
    }
    this.model.traverse((o) => {
      const mesh = o as T.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      if (CastLook.owns(mesh)) {
        // Cast_Face and Cast_Hair receive world shadows; Cast_Eyes keep crisp wet cornea specular without shadow acne or flat emissive wash.
        const isEye = mesh.name.startsWith('Cast_Eyes');
        mesh.receiveShadow = !isEye;
        if (isEye && mesh.material instanceof T.MeshPhysicalMaterial) {
          mesh.material.roughness = 0.055;
          mesh.material.clearcoat = 1.0;
          mesh.material.clearcoatRoughness = 0.025;
          mesh.material.ior = 1.38;
          mesh.material.envMapIntensity = 1.22;
          mesh.material.emissiveIntensity = 0;
        }
        return;
      }
      if (mesh.name.includes('Hands')) {
        mesh.receiveShadow = true;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const hm of mats) if (hm && !this.handSkinMaterials.includes(hm)) this.handSkinMaterials.push(hm);
        return;
      }
      mesh.receiveShadow = true;
      let m = mesh.material as T.MeshStandardMaterial;
      if (!matMod) {
        m = m.clone();
        m.roughness = 0.82;
        m.metalness = 0.0;
        mesh.material = m;
        this.materials.push(m);
      }
      if (mesh.name.startsWith('Cast_Scarf')) this.look!.hideInOwnView(m);
      if (m.map && this.palette) m.map = this.palette.tex;
      else if (m.map && m.map.image) {
        const img = m.map.image as CanvasImageSource & { width: number; height: number };
        const canvas = document.createElement('canvas');
        canvas.width = img.width; canvas.height = img.height;
        const g = canvas.getContext('2d')!;
        g.drawImage(img, 0, 0);
        const tex = new T.CanvasTexture(canvas);
        tex.flipY = m.map.flipY; tex.colorSpace = m.map.colorSpace; tex.magFilter = m.map.magFilter; tex.minFilter = m.map.minFilter;
        tex.generateMipmaps = m.map.generateMipmaps;
        this.palette = { canvas, tex, base: g.getImageData(0, 0, canvas.width, canvas.height) };
        m.map = tex;
      }
    });
    const bones = new Map<string, T.Bone>();
    const coreDeadBlendBones: T.Bone[] = [];
    this.model.traverse((o) => {
      if ((o as T.Bone).isBone) {
        const b = o as T.Bone;
        const authored = (b.userData.name as string | undefined) ?? b.name;
        bones.set(b.name, b);
        this.bonesByNodeName.set(b.name, b);
        this.bonesByNodeName.set(authored, b);
        this.bones.set(authored, b);
        this.bindBonePos.set(authored, b.position.clone());
        this.bindBoneQuat.set(authored, b.quaternion.clone());
        if (!DEAD_BLEND_EXCLUDE.test(authored)) {
          coreDeadBlendBones.push(b);
          this.mixerBase.set(b, b.quaternion.clone());
          this.mixerBindQuat.set(b, b.quaternion.clone());
        }
      }
    });
    this.model.updateMatrixWorld(true);
    const invModelInit = this.model.matrixWorld.clone().invert();
    for (const [authored, b] of this.bones) {
      const m = new T.Matrix4().multiplyMatrices(invModelInit, b.matrixWorld);
      this.bindBoneModelMat.set(authored, m);
      this.propBoneModelInv.set(authored, m.clone().invert());
    }
    const inv = new T.Quaternion();
    this.model.getWorldQuaternion(inv).invert();
    const rest = new Map<string, Rest>();
    const order: string[] = [];
    const visit = (b: T.Bone) => {
      order.push(b.name);
      const world = inv.clone().multiply(b.getWorldQuaternion(new T.Quaternion()));
      const child = b.children.find((c) => (c as T.Bone).isBone) as T.Bone | undefined;
      let dir: T.Vector3 | null = null;
      if (child) {
        const a = b.getWorldPosition(new T.Vector3()), c = child.getWorldPosition(new T.Vector3());
        dir = c.sub(a).applyQuaternion(this.model.getWorldQuaternion(new T.Quaternion()).invert()).normalize();
      }
      rest.set(b.name, { local: b.quaternion.clone(), world, dir });
      b.children.forEach((c) => { if ((c as T.Bone).isBone) visit(c as T.Bone); });
    };
    const hips = bones.get('hips') ?? this.bones.get('hips');
    if (hips) {
      this.rawBindHipsPos.copy(hips.position);
      visit(hips);
      this.hipRest = this.root.worldToLocal(hips.getWorldPosition(new T.Vector3())).y;
    }
    this.deadBlend = new DeadBlendInertializer(coreDeadBlendBones, hips ?? null);
    for(const side of ['L','R']){
      const foot=this.bones.get(`foot.${side}`);
      if(foot){
        const restY = this.root.worldToLocal(foot.getWorldPosition(new T.Vector3())).y;
        this.baseFootRestY.set(side, restY);
        this.footRest.set(side,{y:restY,rotation:this.root.getWorldQuaternion(new T.Quaternion()).invert().multiply(foot.getWorldQuaternion(new T.Quaternion()))});
      }
    }
    this.rig = new HumanRig(this.model, this.root);
    this.mixer = new T.AnimationMixer(this.model);
    // The captured Walk and Run, put right for this skeleton: upright stance, flat shoes on the floor, no skating,
    // plus biomechanical 3P upper-body upgrade (75-91 deg bent-elbow Run/Sprint, inward palms, counter-torsion).
    const gaits = correctGaits(gltf.animations, this.model, this.rig.gaitSkeleton);
    this.baseGaitDrawn = { ...gaits.speed };
    this.gaitDrawn = { ...gaits.speed };
    this.gaitReports = gaits.reports;
    const reportsMap = gaits.reports as Partial<Record<'Walk' | 'Run', GaitReport>>;
    let cachedUpgraded = upgradedGaitsCache.get(this.cfg.model);
    if (!cachedUpgraded) {
      let walkUpgraded: T.AnimationClip | null = null;
      let runUpgraded: T.AnimationClip | null = null;
      const upgradedClips = gaits.clips.map((clip) => {
        if (clip.name === 'Walk') {
          walkUpgraded = upgradeGaitUpperBody(clip, this.model, 'Walk', reportsMap.Walk?.leftFootForwardFrac);
          return walkUpgraded;
        }
        if (clip.name === 'Run') {
          runUpgraded = upgradeGaitUpperBody(clip, this.model, 'Run', reportsMap.Run?.leftFootForwardFrac);
          return runUpgraded;
        }
        return clip;
      });
      let sprintClip: T.AnimationClip | null = null;
      let sprintDrawn = (gaits.speed.Run ?? 2.05) * 1.32;
      if (runUpgraded) {
        const aligned = alignSprintPhaseOrigin(runUpgraded, walkUpgraded ?? runUpgraded, this.model);
        const sprintBuilt = upgradeGaitUpperBody(aligned, this.model, 'Sprint');
        sprintBuilt.name = 'Sprint';
        sprintClip = sprintBuilt;
        const meta = measureClipGaitMeta(sprintBuilt, this.model, {
          hips: this.bones.get('hips') ?? null,
          footL: this.bones.get('foot.L') ?? null,
          footR: this.bones.get('foot.R') ?? null,
        });
        if (meta.nativeStanceSpeed > 0.5) sprintDrawn = Math.max(sprintDrawn, meta.nativeStanceSpeed);
      }
      cachedUpgraded = { clips: upgradedClips, sprintClip, sprintDrawn };
      upgradedGaitsCache.set(this.cfg.model, cachedUpgraded);
    }
    this.baseSprintDrawn = cachedUpgraded.sprintDrawn;
    this.sprintDrawn = cachedUpgraded.sprintDrawn * this.legRatioNow;
    for (const pack of [gltf, dances, floor]) {
      if (!pack) continue;
      for (const clip of pack === gltf ? cachedUpgraded.clips : pack.animations) {
        if (pack !== floor || isFloorPose(clip.name)) this.actions.set(clip.name, this.mixer.clipAction(clip));
      }
      for (const animation of pack.parser.json.animations ?? []) {
        const meta = animation.extras?.echoMotion;
        if (meta?.version === 1 && meta.track?.name === animation.name) {
          const holdAt = pack === floor && animation.name === 'FloorSit' ? meta.track.duration : meta.holdAt;
          this.registerMotion(meta.track, meta.hands, holdAt, meta.floorEnvelope);
        }
      }
    }
    if (cachedUpgraded.sprintClip && !this.actions.has('Sprint')) {
      this.actions.set('Sprint', this.mixer.clipAction(cachedUpgraded.sprintClip));
    }
    for (const [name, poses] of Object.entries(POSES)) {
      const period =
        name === 'type' ? 0.5
        : name === 'dribble' ? 0.72
        : name === 'cycle' ? 0.78
        : name === 'shoot' ? 0.85
        : name === 'write' ? 1.2
        : name === 'studio_cheer' ? 2.2
        : name === 'stretch' || name === 'studio_wave' ? 2.4
        : name === 'shower_rinse' ? 2.8
        : name === 'studio_peace' ? 3.4
        : name === 'studio_think' ? 3.8
        : name === 'studio_contrapposto' ? 4.2
        : name === 'sleep' ? 4.5
        : 3.2;
      const act = this.mixer.clipAction(buildClip(name, poses, bones, rest, order, period));
      if (name === 'stretch') {
        act.setLoop(T.LoopOnce, 1);
        act.clampWhenFinished = true;
      }
      this.actions.set(name, act);
    }
    // Procedural micro-life layer (organic breathing and subtle third-person standing sway; single-authority gaze in updatePostIk).
    if (lifeMod) {
      this.life = new lifeMod.CharacterLife(this.model, `player:${this.cfg.model}`);
    }
    // Fixed-60 Hz XPBD secondary physics driving pony.1..3, side.L/R, fringe, and scarf.L/R.1..3 bones with body colliders.
    if (secMod) {
      this.secondary = new secMod.SecondaryPhysics(this.model, `player:${this.cfg.model}`);
      this.model.userData.__ecSecondaryPhysics = this.secondary;
      if (this.secondary.active) this.look?.setExternalHairPhysics(true);
    }
    // Lazily bind retargeted 48-clip pack supplemental actions, upgrading Sprint and Walk_Brisk with phase alignment and 3P upper-body mechanics.
    // Restore exact bind bone transforms temporarily during retargeting so `inspectTargetSkeleton` NEVER treats a live animated pose as bind pose!
    if (animMod) {
      void animMod.loadEcho48Pack().then((pack) => {
        if (!pack || this.disposed || !this.model || !this.mixer || !this.rig) return;
        const savedModelPos = this.model.position.clone();
        const savedModelQuat = this.model.quaternion.clone();
        const savedModelScale = this.model.scale.clone();
        const savedLiveBones: Array<{ bone: T.Bone; pos: T.Vector3; quat: T.Quaternion; scale: T.Vector3 }> = [];
        this.model.traverse((o) => {
          if (!(o as T.Bone).isBone) return;
          const b = o as T.Bone;
          savedLiveBones.push({
            bone: b,
            pos: b.position.clone(),
            quat: b.quaternion.clone(),
            scale: b.scale.clone(),
          });
          const authored = (b.userData.name as string | undefined) ?? b.name;
          const bp = this.bindBonePos.get(authored);
          const bq = this.bindBoneQuat.get(authored);
          if (bp) b.position.copy(bp);
          if (bq) b.quaternion.copy(bq);
          b.scale.set(1, 1, 1);
        });
        const hipsBind = this.bones.get('hips');
        if (hipsBind) hipsBind.position.copy(this.rawBindHipsPos);
        this.model.position.set(0, 0, 0);
        this.model.quaternion.identity();
        this.model.scale.set(1, 1, 1);
        this.model.updateWorldMatrix(true, true);

        let retargeted: Map<string, T.AnimationClip>;
        let sprintUpgraded: { clip: T.AnimationClip; lead: number; speed: number } | null = null;
        let briskUpgraded: { clip: T.AnimationClip; lead: number; speed: number } | null = null;
        try {
          retargeted = animMod.getRetargeted48Clips(pack, this.model, 'RunnerRig');
          const walkRef = this.actions.get('Walk')?.getClip() ?? null;
          for (const [, rawClip] of retargeted) {
            if (rawClip.name === 'Sprint') {
              if (!this.locomotionBlendActive && this.currentName !== 'Sprint') {
                const aligned = alignSprintPhaseOrigin(rawClip, walkRef, this.model);
                const upgraded = upgradeGaitUpperBody(aligned, this.model, 'Sprint');
                upgraded.name = 'Sprint';
                const meta = measureClipGaitMeta(upgraded, this.model, {
                  hips: this.bones.get('hips') ?? null,
                  footL: this.bones.get('foot.L') ?? null,
                  footR: this.bones.get('foot.R') ?? null,
                });
                sprintUpgraded = {
                  clip: upgraded,
                  lead: meta.leftFootForwardFrac,
                  speed: meta.nativeStanceSpeed,
                };
              }
            } else if (rawClip.name === 'Walk_Brisk') {
              if (!this.actions.has('Walk_Brisk')) {
                const aligned = walkRef ? alignSprintPhaseOrigin(rawClip, walkRef, this.model) : rawClip;
                const upgraded = upgradeGaitUpperBody(aligned, this.model, 'Walk_Brisk');
                upgraded.name = 'Walk_Brisk';
                const meta = measureClipGaitMeta(upgraded, this.model, {
                  hips: this.bones.get('hips') ?? null,
                  footL: this.bones.get('foot.L') ?? null,
                  footR: this.bones.get('foot.R') ?? null,
                });
                briskUpgraded = {
                  clip: upgraded,
                  lead: meta.leftFootForwardFrac,
                  speed: meta.nativeStanceSpeed,
                };
              }
            }
          }
        } finally {
          for (let i = 0; i < savedLiveBones.length; i++) {
            const s = savedLiveBones[i];
            s.bone.position.copy(s.pos);
            s.bone.quaternion.copy(s.quat);
            s.bone.scale.copy(s.scale);
          }
          this.model.position.copy(savedModelPos);
          this.model.quaternion.copy(savedModelQuat);
          this.model.scale.copy(savedModelScale);
          this.model.updateWorldMatrix(true, true);
        }

        if (sprintUpgraded && !this.locomotionBlendActive && this.currentName !== 'Sprint') {
          if (sprintUpgraded.speed > 0.5) {
            this.baseSprintDrawn = sprintUpgraded.speed;
            this.sprintDrawn = sprintUpgraded.speed * this.legRatioNow;
          }
          const prevSprint = this.actions.get('Sprint');
          if (prevSprint) {
            prevSprint.stop();
            this.mixer.uncacheClip(prevSprint.getClip());
          }
          this.actions.set('Sprint', this.mixer.clipAction(sprintUpgraded.clip));
          this.leftFootForward['Sprint'] = sprintUpgraded.lead;
          this.gaitLift['Sprint'] = wrap01(sprintUpgraded.lead + 0.25);
        }
        if (briskUpgraded && !this.actions.has('Walk_Brisk')) {
          if (briskUpgraded.speed > 0.4) this.briskDrawn = briskUpgraded.speed;
          this.actions.set('Walk_Brisk', this.mixer.clipAction(briskUpgraded.clip));
          this.leftFootForward['Walk_Brisk'] = briskUpgraded.lead;
          this.gaitLift['Walk_Brisk'] = wrap01(briskUpgraded.lead + 0.25);
        }
        for (const [, rawClip] of retargeted) {
          if (rawClip.name === 'Sprint' || rawClip.name === 'Walk_Brisk') continue;
          if (this.actions.has(rawClip.name)) continue;
          this.actions.set(rawClip.name, this.mixer.clipAction(rawClip));
        }
      });
    }
    this.measureLyingPose();
    // The bind pose: from the head bone to between the eyes.
    this.root.updateWorldMatrix(true, true);
    const eyeL = this.bones.get('eye.L'), eyeR = this.bones.get('eye.R'), headBone = this.bones.get('head');
    if (eyeL && eyeR && headBone) {
      const mid = this.root.worldToLocal(eyeL.getWorldPosition(new T.Vector3()).add(eyeR.getWorldPosition(new T.Vector3())).multiplyScalar(.5));
      const hb = this.root.worldToLocal(headBone.getWorldPosition(new T.Vector3()));
      this.eyeUp = mid.y - hb.y; this.eyeForward = mid.z - hb.z;
    }
    this.measureEyes();
    this.wardrobe = new Wardrobe(this.model, this.cfg.model);
    // Nobody sees the body in its bind pose while the clothes come down the wire.
    holder.visible = false;
    await this.dress(this.cfg);
    holder.visible = true;
    if (this.disposed) return;
    this.play('Idle', 0);
    this.advanceMixer(0, false);
    this.deadBlend?.seedFromCurrent();
    this.root.position.set(...this.cfg.pos);
    this.root.rotation.y = this.cfg.rotY;
    this.ready = true;
    if (this.creatorProfile) {
      void this.applyCreatorProfile(this.creatorProfile);
    }
  }

  /** Calibrate the authored mesh in its skeletal lying pose, independent of room scale. */
  private measureLyingPose() {
    const action = this.actions.get('sleep')!; action.reset().play(); this.mixer.update(0);
    this.root.updateWorldMatrix(true, true);
    const inverse = this.root.matrixWorld.clone().invert(), point = new T.Vector3();
    let bodyMin = Infinity, headMin = Infinity;
    this.model.traverse(o => {
      const mesh = o as T.SkinnedMesh; if (!mesh.isSkinnedMesh) return; mesh.skeleton.update();
      const weights = mesh.geometry.getAttribute('skinWeight'), indices = mesh.geometry.getAttribute('skinIndex');
      for (let i = 0; i < mesh.geometry.getAttribute('position').count; i++) {
        let slot = 0; for (let k = 1; k < 4; k++) if (weights.getComponent(i, k) > weights.getComponent(i, slot)) slot = k;
        const b = mesh.skeleton.bones[indices.getComponent(i, slot)], name = b.userData.name ?? b.name;
        if (!/^(hips|spine|chest|thigh|shin|head|neck)/.test(name)) continue;
        mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
        if (name === 'head' && mesh.name.includes('Face')) headMin = Math.min(headMin, point.y);
        else if (/^(hips|spine|chest|thigh|shin)/.test(name)) bodyMin = Math.min(bodyMin, point.y);
      }
    });
    this.lyingProfile = { bodyMin, headMin, head: this.root.worldToLocal(this.bones.get('head')!.getWorldPosition(new T.Vector3())) };
    action.stop(); this.mixer.update(0);
  }

  private measureGaitClipPhase(clip: string) {
    const action = this.actions.get(clip), left = this.bones.get('foot.L'), right = this.bones.get('foot.R');
    if (!action || !left || !right) return;
    const wasRunning = action.isRunning();
    const savedTime = action.time;
    const savedWeight = action.getEffectiveWeight();
    action.reset().play();
    let best = -Infinity, at = 0, highest = -Infinity;
    const duration = action.getClip().duration, l = new T.Vector3(), r = new T.Vector3();
    const hips = this.bones.get('hips');
    for (let i = 0; i < 24; i++) {
      if (hips) hips.position.copy(this.rawBindHipsPos);
      action.time = duration * i / 24; this.mixer.update(0);
      if (hips && this.hipsLegOffsetModelY !== 0) hips.position.y += this.hipsLegOffsetModelY;
      this.root.updateWorldMatrix(true, true);
      const lead = this.root.worldToLocal(left.getWorldPosition(l)).z - this.root.worldToLocal(right.getWorldPosition(r)).z;
      if (lead > best) { best = lead; at = i / 24; }
      if (l.y > highest) { highest = l.y; this.gaitLift[clip] = i / 24; }
    }
    this.leftFootForward[clip] = at;
    action.stop();
    if (wasRunning) {
      action.reset().setEffectiveWeight(savedWeight).play();
      action.time = savedTime;
    }
    this.mixer.update(0);
  }

  /** Where the eyes are in the authored standing and seated poses: the camera follows these, never the animated head. */
  private measureEyes() {
    const savedCurrent = this.ready ? this.current : null;
    const savedName = this.ready ? this.currentName : '';
    const savedTime = savedCurrent ? savedCurrent.time : 0;
    const wasLoco = this.ready && this.locomotionBlendActive;
    if (this.ready && !wasLoco) {
      this.mixer.stopAllAction();
    }
    const hips = this.bones.get('hips');
    const headAt = (clip: string, out: T.Vector3) => {
      const action = this.actions.get(clip);
      if (!action) return;
      if (hips) hips.position.copy(this.rawBindHipsPos);
      action.reset().play(); this.mixer.update(0);
      if (hips && this.hipsLegOffsetModelY !== 0) hips.position.y += this.hipsLegOffsetModelY;
      this.root.updateWorldMatrix(true, true);
      out.copy(this.root.worldToLocal(this.bones.get('head')!.getWorldPosition(new T.Vector3()))).add(new T.Vector3(0, this.eyeUp * this.heightScaleNow, this.eyeForward * this.heightScaleNow));
      action.stop(); this.mixer.update(0);
    };
    if (!wasLoco) {
      headAt('Idle', this.eyes.stand);
      headAt('sit', this.eyes.sit);
      for (const clip of ['Walk', 'Walk_Brisk', 'Run', 'Sprint']) {
        if (this.actions.has(clip)) this.measureGaitClipPhase(clip);
      }
    }
    // On one's back the eyes look up out of the face, at the head's own place in the lying pose.
    this.eyes.lie.copy(this.lyingProfile.head).multiplyScalar(this.heightScaleNow).add(new T.Vector3(0, this.eyeUp * this.heightScaleNow * .95, .02));
    if (this.ready && !wasLoco && savedName) {
      const restored = this.actions.get(savedName);
      if (restored) {
        restored.reset().setEffectiveWeight(1).play();
        restored.time = savedTime;
        this.current = restored;
        this.currentName = savedName;
        this.advanceMixer(0, false);
        this.deadBlend?.seedFromCurrent();
      }
    }
  }

  /** Room/furniture identity changed: cancel every pending walk, callback and pose. */
  resetPose(pos: T.Vector3, rotY: number) {
    this.onResetPose?.();
    this.workingBody = false;
    this.expression = null;
    if (this.embodiedSession) {
      const endCb = this.embodiedSession.onEnd;
      this.embodiedSession = null;
      endCb?.();
    }
    this.airborne = false; this.verticalSpeed = 0; this.jumpPhase = 'none'; this.jumpLandLeft = 0; this.landSquash = 0;
    this.motion = null; this.motionEye = 0; this.lastMotion = null;
    this.sportMode = 'none'; this.sportBallWorld = null; this.sportShootLeft = 0; this.clipOneShotLeft = 0;
    this.locomotionBlendActive = false; this.locomotionSpeed = 0; this.schmittBand = 'idle'; this.filteredYawRate = 0;
    this.smoothedMoveYaw = 0; this.moveYaw = 0; this.isBackpedaling = false; this.turning = 0; this.stillFor = 0; this.turnStillFor = 0; this.gaitHeld = false;
    this.idleLifeWeight = 1;
    this.lean = 0; this.leanRoll = 0; this.leanPitch = 0; this.stairPitch = 0; this.seatPelvisDropY = 0; this.risingPelvisDropFrom = 0;
    this.releaseSportContacts();
    this.poseEpoch++; this.walkTo = null; this.seat = null; this.rising = null; this.risingSeatRef = null; this.chairBack = null;
    this.rollingVelX = 0; this.rollingVelZ = 0; this.rollingSpeedNow = 0;
    this.body.abortToStanding();
    const rawGround = this.groundAt?.(pos.x, pos.z);
    const resolvedY =
      rawGround !== null && rawGround !== undefined && Number.isFinite(rawGround)
        ? rawGround
        : Number.isFinite(pos.y)
          ? pos.y
          : 0;
    pos.y = resolvedY;
    this.root.position.set(pos.x, resolvedY, pos.z);
    this.root.rotation.set(0, rotY, 0);
    this.rig?.stopGesture();
    this.rig?.clearTransientContacts(true);
    this.rig?.resetFootDynamics();
    this.secondary?.reset();
    this.activity = 'idle'; this.mood = 'neutral';
    // Through the one pair: the mixer writes a held value once only, so a write the rig does not capture is lost the next frame (the arms sat in the bind pose).
    if (this.ready) {
      this.mixer.stopAllAction();
      this.current = null;
      this.currentName = '';
      this.play('Idle', 0);
      this.advanceMixer(0, false);
      this.deadBlend?.seedFromCurrent();
    }
  }

  /** Recolours the hair, top, bottom and shoes cells of the palette (shading inside a cell is kept). */
  applyColors(cfg: Pick<CharacterConfig, 'hair' | 'top' | 'bottom' | 'shoes'>) {
    if (!this.palette) return;
    const key=[cfg.hair,cfg.top,cfg.bottom,cfg.shoes].join('|');if(key===this.paintKey)return;this.paintKey=key;
    this.look?.setHairColor(cfg.hair);
    const { canvas, tex, base } = this.palette;
    const g = canvas.getContext('2d')!;
    const img = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
    const cell = canvas.width / 8;
    const paint = (cells: [number, number][], hex: string) => {
      const c = new T.Color(hex).convertLinearToSRGB();
      cells.forEach(([cx, cy], idx) => {
        const shade = idx === 0 ? 1 : 0.78;
        for (let y = cy * cell; y < (cy + 1) * cell; y++) for (let x = cx * cell; x < (cx + 1) * cell; x++) {
          const i = (y * canvas.width + x) * 4;
          img.data[i] = Math.round(c.r * 255 * shade);
          img.data[i + 1] = Math.round(c.g * 255 * shade);
          img.data[i + 2] = Math.round(c.b * 255 * shade);
        }
      });
    };
    paint(PALETTE_CELLS.hair, cfg.hair);
    paint(PALETTE_CELLS.top, cfg.top);
    paint(PALETTE_CELLS.bottom, cfg.bottom);
    paint(PALETTE_CELLS.shoes, cfg.shoes);
    g.putImageData(img, 0, 0);
    tex.needsUpdate = true;
  }

  /** Puts on what the layout says. Until the files arrive the old clothes stay on. */
  async dress(cfg: Pick<CharacterConfig, 'model' | 'look' | 'hair' | 'top' | 'bottom' | 'shoes'>) {
    const look: AvatarLook = cfg.look ? normalizeLook(cfg.model, cfg.look) : defaultLook(cfg.model);
    const key = JSON.stringify(look) + (isSignature(look) ? `${cfg.hair}|${cfg.top}|${cfg.bottom}|${cfg.shoes}` : '');
    if (key === this.lookKey) return;
    this.lookKey = key;
    if (isSignature(look)) this.applyColors(cfg);
    this.look?.setHairColor(cfg.look ? look.colors.hair : cfg.hair);
    await this.wardrobe?.apply(look, {
      onWearableContext: (ctx) => this.secondary?.setWearableContext(ctx),
    });
    this.model?.traverse((o) => {
      const mesh = o as T.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = !mesh.name.startsWith('Cast_Eyes');
    });
    this.syncProportionedMeshes();
    this.rig?.refreshFootSurfaces();
  }

  /**
   * Applies a full Wave 11 Character Creator V2 profile live onto the player rig:
   * 20 anatomical face sculpt morphs, skin tone synced across face/hands/body, iris pigment,
   * procedural facial makeup, modular 3D hair swap, layered outerwear + fabrics + patterns,
   * auto-seasonal outfit selection, and shear-free body proportion offsets (`0.0000` 3D shear).
   */
  async applyCreatorProfile(
    profile: CharacterCreatorProfile,
    weatherOverride?: { season: number; snow: number; tempC?: number },
  ): Promise<void> {
    const safe = sanitizeCreatorProfile(profile, this.cfg.model);
    this.creatorProfile = safe;
    if (!this.ready || this.disposed) return;

    // 1. Face sculpt morphs (indices 19..38), makeup, skin tone, iris, and hair tints (instant, 0 ms)
    this.look?.setFaceSculpt(safe.faceMorphs);
    this.look?.setSkinTone(safe.skinHex);
    for (const hm of this.handSkinMaterials) setSkinToneUniform(hm, safe.skinHex);
    this.wardrobe?.setSkinTone(safe.skinHex);
    this.look?.setIrisColor(safe.irisHex);
    this.look?.setFaceMakeup({
      blushIntensity: safe.makeup.blushIntensity,
      blushColor: safe.makeup.blushColor,
      lipOpacity: safe.makeup.lipOpacity,
      lipColor: safe.makeup.lipColor,
      freckleDensity: safe.makeup.freckleDensity,
      browDarkness: safe.makeup.browThickness,
      facialHair: safe.makeup.facialHair,
    });
    this.look?.setHairColor(safe.hairColor);
    this.look?.setHairTipColor(safe.hairTipColor, safe.hairTipMix);
    this.wardrobe?.setHairColors(safe.hairColor, safe.hairTipColor, safe.hairTipMix);

    // 2. Shear-free body proportions (uniform model scale + rest-pose joint translation offsets)
    this.applyBodyProportions(safe.body);

    // 3. Resolve outfit slot (honoring `autoSeasonalOutfit` when weather context is supplied)
    const resolved = weatherOverride
      ? resolveActiveOutfitForWeather(
          safe,
          Math.max(0, Math.min(3, Math.floor(weatherOverride.season))) as 0 | 1 | 2 | 3,
          weatherOverride.snow,
          weatherOverride.tempC,
        )
      : { slotId: safe.activeOutfitSlot, outfit: safe.outfits[safe.activeOutfitSlot] ?? safe.outfits.everyday };
    const outfit = resolved.outfit;

    const outfitSig = JSON.stringify({
      hairId: safe.hairId,
      hairColor: safe.hairColor,
      hairTipColor: safe.hairTipColor,
      hairTipMix: safe.hairTipMix,
      skinHex: safe.skinHex,
      outfit,
    });
    if (outfitSig !== this.lastCreatorOutfitSig) {
      this.lastCreatorOutfitSig = outfitSig;
      if (outfit.top === 'signature') {
        this.applyColors({
          hair: safe.hairColor,
          top: outfit.colors.top,
          bottom: outfit.colors.bottom,
          shoes: outfit.colors.shoes,
        });
      }
      await this.wardrobe?.applyProfile(safe, outfit, {
        onBuiltinHairVisible: (vis) => this.look?.setBuiltinHairVisible(vis),
        onExternalHair: (grp) => this.look?.bindExternalHair(grp),
        onWearableContext: (ctx) => this.secondary?.setWearableContext(ctx),
      });
      if (this.disposed) return;
      this.model?.traverse((o) => {
        const mesh = o as T.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = !mesh.name.startsWith('Cast_Eyes');
        mesh.receiveShadow = !mesh.name.startsWith('Cast_Eyes');
      });
      // Re-discover active hair/scarf bones after modular hair/outerwear swap and refresh shoe sole hull
      this.syncProportionedMeshes();
      this.secondary?.rebind(this.model);
      const savedWearCtx = this.model?.userData.__ecWearableContext;
      if (savedWearCtx) this.secondary?.setWearableContext(savedWearCtx);
      this.secondary?.rebuildColliders(safe.body.buildScale, safe.body.heightScale);
      this.rig?.refreshFootSurfaces();
    }
  }

  /** Lightweight O(1) seasonal outfit check invoked from `engine.ts` when season/snow changes. */
  updateSeasonalOutfit(weather: { season: number; snow: number; tempC?: number }) {
    if (!this.creatorProfile || !this.creatorProfile.autoSeasonalOutfit || !this.ready || this.disposed) return;
    const clampedSeason = Math.max(0, Math.min(3, Math.floor(weather.season))) as 0 | 1 | 2 | 3;
    const resolved = resolveActiveOutfitForWeather(this.creatorProfile, clampedSeason, weather.snow, weather.tempC);
    const sig = JSON.stringify({
      hairId: this.creatorProfile.hairId,
      hairColor: this.creatorProfile.hairColor,
      hairTipColor: this.creatorProfile.hairTipColor,
      hairTipMix: this.creatorProfile.hairTipMix,
      skinHex: this.creatorProfile.skinHex,
      outfit: resolved.outfit,
    });
    if (sig !== this.lastCreatorOutfitSig) {
      void this.applyCreatorProfile(this.creatorProfile, weather);
    }
  }

  /**
   * Shear-free CAZ body proportions (`RC-A3` + `syncProportionedMeshes` bind-pose diffeomorphism):
   *  - Keeps every skeletal bone `.scale` strictly at `(1, 1, 1)` so 3D rotation-scale shear is `0.0000`.
   *  - Applies stature `heightScale` uniformly on `model.scale` (`SCALE * h`) and passes `heightScaleNow` (not `modelScaleNow`)
   *    to `HumanRig.refreshProportions`.
   *  - Applies `legRatio`, `shoulderWidth`, `hipWidth`, `buildScale`, and `torsoDepth` via rest-pose joint offsets paired
   *    with a smooth C1 bind-mesh diffeomorphism and exact per-skeleton `boneInverses` update (`0` collar stretch,
   *    `0` ankle skin gap, `0` inter-layer coat poke-through).
   */
  private applyBodyProportions(body: BodyProportions) {
    if (!this.model) return;
    const sig = `${body.heightScale.toFixed(3)}|${body.buildScale.toFixed(3)}|${body.shoulderWidth.toFixed(3)}|${body.legRatio.toFixed(3)}|${body.torsoDepth.toFixed(3)}|${body.hipWidth.toFixed(3)}`;
    if (sig === this.lastCreatorBodySig) {
      this.syncProportionedMeshes();
      return;
    }
    this.lastCreatorBodySig = sig;

    const h = T.MathUtils.clamp(body.heightScale, 0.92, 1.12);
    const b = T.MathUtils.clamp(body.buildScale, 0.88, 1.18);
    const sh = T.MathUtils.clamp(body.shoulderWidth, 0.85, 1.14);
    const leg = T.MathUtils.clamp(body.legRatio, 0.92, 1.08);
    const td = T.MathUtils.clamp(body.torsoDepth, 0.88, 1.16);
    const hip = T.MathUtils.clamp(body.hipWidth, 0.88, 1.14);

    this.heightScaleNow = h;
    this.buildScaleNow = b;
    this.shoulderWidthNow = sh;
    this.legRatioNow = leg;
    this.torsoDepthNow = td;
    this.hipWidthNow = hip;
    this.modelScaleNow = SCALE * h;
    this.model.scale.setScalar(this.modelScaleNow);

    // Guarantee exact unit scale `(1, 1, 1)` on every bone in the hierarchy (`0.0000` 3D shear under arbitrary rotation)
    this.model.traverse((o) => {
      if ((o as T.Bone).isBone) o.scale.set(1, 1, 1);
    });

    const legEff = 1 + (leg - 1) * 0.85;
    const torsoLenScale = 1 - (legEff - 1) * 0.28;
    const shEff = 1 + (sh - 1) * 0.65 + (b - 1) * 0.16;
    const hipEff = 1 + (hip - 1) * 0.65 + (b - 1) * 0.18;

    // Save live bone quaternions (and any modular-hair bone position overrides) so rest-matrix capture never disturbs live pose
    const savedQuats = new Map<T.Bone, T.Quaternion>();
    const savedNonPropPos = new Map<T.Bone, T.Vector3>();
    const propPosNames = new Set([
      'hips',
      'spine',
      'chest',
      'shoulder.L',
      'shoulder.R',
      'upper_arm.L',
      'upper_arm.R',
      'thigh.L',
      'thigh.R',
      'shin.L',
      'shin.R',
      'foot.L',
      'foot.R',
    ]);
    for (const [authored, bone] of this.bones) {
      savedQuats.set(bone, bone.quaternion.clone());
      const bindQ = this.bindBoneQuat.get(authored);
      if (bindQ) bone.quaternion.copy(bindQ);
      if (!propPosNames.has(authored)) {
        savedNonPropPos.set(bone, bone.position.clone());
        const bindP = this.bindBonePos.get(authored);
        if (bindP) bone.position.copy(bindP);
      }
    }

    const hips = this.bones.get('hips');
    const savedHipsPos = hips ? hips.position.clone() : null;
    if (hips) hips.position.copy(this.rawBindHipsPos);

    const spine = this.bones.get('spine');
    const bindSpine = this.bindBonePos.get('spine');
    if (spine && bindSpine) spine.position.set(bindSpine.x, bindSpine.y * torsoLenScale, bindSpine.z);

    const chest = this.bones.get('chest');
    const bindChest = this.bindBonePos.get('chest');
    if (chest && bindChest) chest.position.set(bindChest.x, bindChest.y * torsoLenScale, bindChest.z);

    for (const side of ['L', 'R'] as const) {
      const shoulder = this.bones.get(`shoulder.${side}`);
      const bindShoulder = this.bindBonePos.get(`shoulder.${side}`);
      if (shoulder && bindShoulder) {
        shoulder.position.set(bindShoulder.x * shEff, bindShoulder.y, bindShoulder.z);
      }
      const upperArm = this.bones.get(`upper_arm.${side}`);
      const bindUpperArm = this.bindBonePos.get(`upper_arm.${side}`);
      if (upperArm && bindUpperArm) {
        // `shoulder` local +Y points laterally along the clavicle shaft
        upperArm.position.set(bindUpperArm.x, bindUpperArm.y * shEff, bindUpperArm.z);
      }

      const thigh = this.bones.get(`thigh.${side}`);
      const bindThigh = this.bindBonePos.get(`thigh.${side}`);
      if (thigh && bindThigh) {
        thigh.position.set(bindThigh.x * hipEff, bindThigh.y, bindThigh.z);
      }
      const shin = this.bones.get(`shin.${side}`);
      const bindShin = this.bindBonePos.get(`shin.${side}`);
      if (shin && bindShin) {
        shin.position.set(bindShin.x, bindShin.y * legEff, bindShin.z);
      }
      const foot = this.bones.get(`foot.${side}`);
      const bindFoot = this.bindBonePos.get(`foot.${side}`);
      if (foot && bindFoot) {
        foot.position.set(bindFoot.x, bindFoot.y * legEff, bindFoot.z);
      }

      const footRestEntry = this.footRest.get(side);
      const baseRestY = this.baseFootRestY.get(side);
      if (footRestEntry && baseRestY !== undefined) {
        footRestEntry.y = baseRestY * h;
      }
    }

    // Measure exact rest-pose ankle shift so `hipsLegOffsetModelY` keeps `foot.L/R` pinned to their exact bind model Y (`0.000 mm` drift)
    this.model.updateWorldMatrix(true, true);
    const invModel = this.model.matrixWorld.clone().invert();
    const footL = this.bones.get('foot.L');
    const bindFootMatL = this.bindBoneModelMat.get('foot.L');
    if (footL && bindFootMatL) {
      const footModelPos = new T.Vector3().setFromMatrixPosition(footL.matrixWorld).applyMatrix4(invModel);
      this.hipsLegOffsetModelY = bindFootMatL.elements[13] - footModelPos.y;
    } else {
      const bindShinL = this.bindBonePos.get('shin.L');
      const bindFootL = this.bindBonePos.get('foot.L');
      const bindLegLenModel = Math.abs(bindShinL?.y ?? 0.38532) + Math.abs(bindFootL?.y ?? 0.41158);
      this.hipsLegOffsetModelY = (legEff - 1) * bindLegLenModel;
    }

    if (hips) {
      hips.position.set(this.rawBindHipsPos.x, this.rawBindHipsPos.y + this.hipsLegOffsetModelY, this.rawBindHipsPos.z);
    }
    this.model.updateWorldMatrix(true, true);
    invModel.copy(this.model.matrixWorld).invert();
    for (const [authored, bone] of this.bones) {
      let propInv = this.propBoneModelInv.get(authored);
      if (!propInv) {
        propInv = new T.Matrix4();
        this.propBoneModelInv.set(authored, propInv);
      }
      propInv.multiplyMatrices(invModel, bone.matrixWorld).invert();
    }

    this.hipRest = (this.rawBindHipsPos.y + this.hipsLegOffsetModelY) * this.modelScaleNow;

    if (this.baseGaitDrawn.Walk !== undefined) this.gaitDrawn.Walk = this.baseGaitDrawn.Walk * legEff;
    if (this.baseGaitDrawn.Run !== undefined) this.gaitDrawn.Run = this.baseGaitDrawn.Run * legEff;
    this.sprintDrawn = this.baseSprintDrawn * legEff;

    // Sync bind-pose vertices and per-skeleton `boneInverses` across body + wardrobe layers
    this.syncProportionedMeshes();

    // Restore live non-proportioned bone positions (e.g., KAI modular hair overrides) and live posed quaternions
    for (const [bone, pos] of savedNonPropPos) bone.position.copy(pos);
    for (const [bone, quat] of savedQuats) bone.quaternion.copy(quat);
    if (hips && savedHipsPos) {
      hips.position.set(savedHipsPos.x, this.rawBindHipsPos.y + (this.vehicleMode === 'none' ? this.hipsLegOffsetModelY : 0), savedHipsPos.z);
    }

    this.root.updateWorldMatrix(true, true);
    this.rig?.refreshProportions(this.heightScaleNow);
    this.rig?.refreshFootSurfaces();
    this.measureEyes();
    this.secondary?.rebuildColliders(b, h);

    const baseHeight = this.cfg.model === 'KAI' ? 1.76 : 1.66;
    this.onActorDimensionsChange?.(baseHeight * h, b);
  }

  /**
   * Synchronizes every body & wardrobe `SkinnedMesh` (excluding `ExternalHair_*`, which rides rigidly with `head`)
   * with the active CAZ body proportions via a single smooth C1 bind-space diffeomorphism + exact `boneInverses` update.
   * Default (`1.000`) characters exit immediately with zero geometry clones and zero allocations.
   */
  private syncProportionedMeshes() {
    if (!this.model) return;
    const targetSig = this.lastCreatorBodySig || '1.000|1.000|1.000|1.000|1.000|1.000';
    const isIdentity = targetSig === '1.000|1.000|1.000|1.000|1.000|1.000';

    const bindAnkleY = this.bindBoneModelMat.get('foot.L')?.elements[13] ?? 0.0803;
    const bindHipsY = this.rawBindHipsPos.y;
    const bindChestMat = this.bindBoneModelMat.get('chest');
    const bindChestY = bindChestMat ? bindChestMat.elements[13] : bindHipsY + 0.305;
    const bindChestZ = bindChestMat ? bindChestMat.elements[14] : -0.015;
    const bindHeadY = this.bindBoneModelMat.get('head')?.elements[13] ?? (this.cfg.model === 'KAI' ? 1.4488 : 1.3738);
    const bindUpperArmX = Math.max(0.11, Math.abs(this.bindBoneModelMat.get('upper_arm.L')?.elements[12] ?? 0.145));
    const bindThighX = Math.max(0.065, Math.abs(this.bindBoneModelMat.get('thigh.L')?.elements[12] ?? 0.088));

    const legEff = 1 + (this.legRatioNow - 1) * 0.85;
    const torsoLenScale = 1 - (legEff - 1) * 0.28;
    const shEff = 1 + (this.shoulderWidthNow - 1) * 0.65 + (this.buildScaleNow - 1) * 0.16;
    const hipEff = 1 + (this.hipWidthNow - 1) * 0.65 + (this.buildScaleNow - 1) * 0.18;
    const buildDelta = this.buildScaleNow - 1;
    const tdEff = 1 + (this.torsoDepthNow - 1) * 0.65 + buildDelta * 0.35;

    const propHipsY = bindHipsY + this.hipsLegOffsetModelY;
    const legSpanBind = Math.max(0.25, bindHipsY - bindAnkleY);
    const legScaleActual = (propHipsY - bindAnkleY) / legSpanBind;
    const propChestY = propHipsY + (bindChestY - bindHipsY) * torsoLenScale;
    const headDeltaY = propChestY - bindChestY;

    // Exact lateral translations of `upper_arm.L` and `thigh.L` pivots in model space
    const propUpperArmInv = this.propBoneModelInv.get('upper_arm.L');
    const propUpperArmX = propUpperArmInv ? Math.abs(propUpperArmInv.clone().invert().elements[12]) : bindUpperArmX * shEff;
    const deltaArmX = propUpperArmX - bindUpperArmX;

    const propThighInv = this.propBoneModelInv.get('thigh.L');
    const propThighX = propThighInv ? Math.abs(propThighInv.clone().invert().elements[12]) : bindThighX * hipEff;
    const deltaLegX = propThighX - bindThighX;

    const smoothRamp01 = (u: number): number => {
      if (u <= 0) return 0;
      if (u >= 1) return 1;
      // C1-smooth monotone ramp with slope ~1.5 at midpoint and 0 slope at u = 1
      return u < 0.7 ? u * (1 / 0.85) : 1 - ((1 - u) * (1 - u)) / (0.3 * 1.7);
    };

    // Smooth C1 piecewise-linear vertical map matching ankle, hip, chest, and head pivots
    const filletHalf = 0.032;
    const evalPiecewiseCorner = (y: number, yCorner: number, yValAtCorner: number, mLeft: number, mRight: number): number => {
      const d = y - yCorner;
      if (d <= -filletHalf) return yValAtCorner + mLeft * d;
      if (d >= filletHalf) return yValAtCorner + mRight * d;
      const u = (d + filletHalf) / (2 * filletHalf);
      const slope = mLeft + (mRight - mLeft) * u;
      return yValAtCorner - mLeft * filletHalf + (mLeft * (d + filletHalf) + 0.5 * (mRight - mLeft) * (d + filletHalf) * u);
      void slope;
    };

    const deformY = (y: number): number => {
      if (Math.abs(y - bindAnkleY) < filletHalf) {
        return evalPiecewiseCorner(y, bindAnkleY, bindAnkleY, 1.0, legScaleActual);
      }
      if (y < bindAnkleY) return y;
      if (Math.abs(y - bindHipsY) < filletHalf) {
        return evalPiecewiseCorner(y, bindHipsY, propHipsY, legScaleActual, torsoLenScale);
      }
      if (y < bindHipsY) return bindAnkleY + (y - bindAnkleY) * legScaleActual;
      if (Math.abs(y - bindChestY) < filletHalf) {
        return evalPiecewiseCorner(y, bindChestY, propChestY, torsoLenScale, 1.0);
      }
      if (y < bindChestY) return propHipsY + (y - bindHipsY) * torsoLenScale;
      return y + headDeltaY;
    };

    const tmpMat = new T.Matrix4();

    this.model.traverse((obj) => {
      const sm = obj as T.SkinnedMesh;
      if (!sm.isSkinnedMesh || !sm.skeleton || !sm.geometry) return;
      // Modular hair (`ExternalHair_*`) uses scalp-aligned IBMs and already translates rigidly with `head`
      if (sm.parent?.name.startsWith('ExternalHair_')) return;

      const appliedSig = sm.userData.__ecPropSig as string | undefined;
      if (isIdentity && !appliedSig) return;
      if (appliedSig === targetSig) return;

      const baseGeom = (sm.geometry.userData.__ecSourceGeom as T.BufferGeometry | undefined) ?? sm.geometry;
      const basePosAttr = baseGeom.getAttribute('position') as T.BufferAttribute | undefined;
      if (!basePosAttr) return;

      let origPosArr = baseGeom.userData.__ecOrigPosArray as Float32Array | undefined;
      if (!origPosArr) {
        origPosArr = new Float32Array(basePosAttr.array as ArrayLike<number>);
        baseGeom.userData.__ecOrigPosArray = origPosArr;
      }

      // Ensure `sm.geometry` owns a private `position` attribute so shared GLTF cache geometries are NEVER mutated
      if (sm.geometry === baseGeom) {
        const wrapper = new T.BufferGeometry();
        for (const name of Object.keys(baseGeom.attributes)) {
          if (name === 'position') continue;
          wrapper.setAttribute(name, baseGeom.getAttribute(name));
        }
        wrapper.setAttribute('position', new T.BufferAttribute(new Float32Array(origPosArr), 3));
        if (baseGeom.index) wrapper.setIndex(baseGeom.index);
        wrapper.morphTargetsRelative = baseGeom.morphTargetsRelative;
        if (baseGeom.morphAttributes.position) wrapper.morphAttributes.position = baseGeom.morphAttributes.position;
        if (baseGeom.morphAttributes.normal) wrapper.morphAttributes.normal = baseGeom.morphAttributes.normal;
        if (baseGeom.morphAttributes.color) wrapper.morphAttributes.color = baseGeom.morphAttributes.color;
        for (const grp of baseGeom.groups) {
          wrapper.addGroup(grp.start, grp.count, grp.materialIndex);
        }
        if (baseGeom.boundingBox) wrapper.boundingBox = baseGeom.boundingBox.clone();
        if (baseGeom.boundingSphere) wrapper.boundingSphere = baseGeom.boundingSphere.clone();
        wrapper.userData.__ecSourceGeom = baseGeom;
        wrapper.userData.__ecOwnedByProp = true;
        sm.geometry = wrapper;
        this.ownedPropGeometries.add(wrapper);
      } else if (!sm.geometry.userData.__ecOwnedPosAttr) {
        sm.geometry.setAttribute('position', new T.BufferAttribute(new Float32Array(origPosArr), 3));
        sm.geometry.userData.__ecOwnedPosAttr = true;
      }

      // Ensure `sm.skeleton.boneInverses` owns private `Matrix4` instances (never mutating shared GLTF `source.skeleton.boneInverses`)
      let origInverses = sm.userData.__ecOrigBoneInverses as T.Matrix4[] | undefined;
      if (!origInverses) {
        origInverses = sm.skeleton.boneInverses.map((m) => m.clone());
        sm.userData.__ecOrigBoneInverses = origInverses;
        sm.skeleton.boneInverses = origInverses.map((m) => m.clone());
      }

      const posAttr = sm.geometry.getAttribute('position') as T.BufferAttribute;
      const dst = posAttr.array as Float32Array;

      if (isIdentity) {
        dst.set(origPosArr);
        posAttr.needsUpdate = true;
        for (let k = 0; k < sm.skeleton.boneInverses.length; k++) {
          if (origInverses[k]) sm.skeleton.boneInverses[k].copy(origInverses[k]);
        }
        delete sm.userData.__ecPropSig;
        return;
      }

      const vCount = origPosArr.length / 3;
      for (let i = 0; i < vCount; i++) {
        const i3 = i * 3;
        const x = origPosArr[i3];
        const y = origPosArr[i3 + 1];
        const z = origPosArr[i3 + 2];
        const absX = Math.abs(x);
        const signX = x >= 0 ? 1 : -1;

        const wBody = 1 - T.MathUtils.smoothstep(y, bindHeadY - 0.095, bindHeadY - 0.030);
        const wAboveSole = T.MathUtils.smoothstep(y, bindAnkleY + 0.008, bindAnkleY + 0.075);

        // 1. Shoulder & A-pose arm lateral carrier (`0` forearm/hand stretch)
        const wShTorso = T.MathUtils.smoothstep(y, bindHipsY + 0.16, bindChestY + 0.03) * wBody;
        const wArmOut =
          T.MathUtils.smoothstep(absX, 0.205, 0.255) *
          T.MathUtils.smoothstep(y, bindHipsY - 0.16, bindHipsY - 0.04) *
          wBody;
        const wSh = Math.max(wShTorso, wArmOut);
        const dxSh = signX * deltaArmX * smoothRamp01(absX / bindUpperArmX) * wSh;

        // 2. Hip & leg lateral carrier + fuller outer hip contour
        const wCoreColumn = 1 - T.MathUtils.smoothstep(absX, 0.205, 0.255);
        const wHipLower = (1 - T.MathUtils.smoothstep(y, bindHipsY + 0.02, bindHipsY + 0.18)) * wCoreColumn;
        const dxLeg = signX * deltaLegX * smoothRamp01(absX / bindThighX) * wHipLower;
        const wPelvisContour =
          T.MathUtils.smoothstep(y, bindHipsY - 0.16, bindHipsY - 0.04) *
          (1 - T.MathUtils.smoothstep(y, bindHipsY + 0.06, bindHipsY + 0.18)) *
          wCoreColumn;
        const dxPelvisExtra =
          absX > bindThighX
            ? signX * (absX - bindThighX) * (hipEff - 1) * 0.45 * wPelvisContour
            : 0;

        // 3. Build girth & torso AP depth (`torsoDepth` + `buildScale`)
        const wTorsoBand =
          T.MathUtils.smoothstep(y, bindHipsY - 0.06, bindHipsY + 0.08) *
          wCoreColumn *
          wBody;
        const dxBuildTorso = x * buildDelta * 0.36 * wTorsoBand;
        const dxLimbGirth =
          absX > bindThighX * 0.45 && y < bindHipsY - 0.04
            ? (x - signX * bindThighX) * buildDelta * 0.26 * wCoreColumn * wAboveSole
            : 0;

        const dzTorso = (z - bindChestZ) * (tdEff - 1) * wTorsoBand;
        const dzLowerGirth = (z - bindChestZ) * buildDelta * 0.24 * wHipLower * (1 - wTorsoBand) * wAboveSole;

        dst[i3] = x + dxSh + dxLeg + dxPelvisExtra + dxBuildTorso + dxLimbGirth;
        dst[i3 + 1] = deformY(y);
        dst[i3 + 2] = z + dzTorso + dzLowerGirth;
      }
      posAttr.needsUpdate = true;

      const bones = sm.skeleton.bones;
      for (let k = 0; k < bones.length; k++) {
        const b = bones[k];
        const origIbm = origInverses[k];
        if (!b || !origIbm) continue;
        const authored = (b.userData.name as string | undefined) ?? b.name;
        const bindMat = this.bindBoneModelMat.get(authored);
        const propInv = this.propBoneModelInv.get(authored);
        if (bindMat && propInv) {
          tmpMat.multiplyMatrices(propInv, bindMat);
          sm.skeleton.boneInverses[k].multiplyMatrices(tmpMat, origIbm);
        } else {
          sm.skeleton.boneInverses[k].copy(origIbm);
        }
      }

      sm.userData.__ecPropSig = targetSig;
    });
  }

  /**
   * Clears transient locomotion, door/prop hand reaches, foot-lock history, and inertializer velocity,
   * optionally settling into the relaxed CAZ/Photo Studio contrapposto stance.
   */
  clearTransientMotion(options?: { contrapposto?: boolean }) {
    this.cancelEmbodiedSession(false);
    this.expression = null;
    this.sportShootLeft = 0;
    this.clipOneShotLeft = 0;
    this.airborne = false;
    this.verticalSpeed = 0;
    this.jumpPhase = 'none';
    this.jumpLandLeft = 0;
    this.landSquash = 0;
    this.gaitHeld = false;
    this.stillFor = 0;
    this.turnStillFor = 0;
    this.turning = 0;
    this.isBackpedaling = false;
    this.smoothedMoveYaw = 0;
    this.moveYaw = 0;
    this.lean = 0;
    this.leanRoll = 0;
    this.leanPitch = 0;
    this.stairPitch = 0;
    this.locomotionSpeed = 0;
    this.schmittBand = 'idle';
    this.filteredYawRate = 0;
    this.exitLocomotionBlend(0);
    this.releaseSportContacts();
    this.rig?.stopGesture();
    this.rig?.clearTransientContacts(true);
    this.rig?.resetFootDynamics();
    if (!this.seat && !this.rising && this.vehicleMode === 'none') {
      this.seatPelvisDropY = 0;
      this.root.position.y = this.floorY(this.root.position.x, this.root.position.z);
      this.root.rotation.x = 0;
      this.root.rotation.z = 0;
    }
    if (options?.contrapposto && this.ready && this.standing && this.actions.has('studio_contrapposto')) {
      this.mixer.stopAllAction();
      this.current = null;
      this.currentName = '';
      this.play('studio_contrapposto', 0);
      this.advanceMixer(0, false);
    }
    this.deadBlend?.seedFromCurrent();
    this.secondary?.reset();
    this.studioSettlePending = true;
  }

  /**
   * Safely clears stuck interaction/tool/locomotion/navigation states (`actions`, `workingBody`, `turning`,
   * `walkTo` journey, hand contacts, `moveYaw`, `leanRoll`, `leanPitch`) and returns a standing character to clean `Idle`.
   * Safe for `Reset Room` or interaction recovery without mutating world placement when already seated/mounted unless standing.
   */
  resetStuckInteractionState(): void {
    this.cancelEmbodiedSession(false);
    if (this.motion) {
      this.motion.action.stop();
      this.body.endAction(this.motion.clock.track.name);
      this.motion = null;
      this.motionEye = 0;
    }
    this.workingBody = false;
    this.expression = null;
    this.expressionOverride = null;
    this.studioPose = null;
    this.studioSpeaking = false;
    this.dialogueActive = false;
    this.dialogueSpeaking = false;
    this.dialogueLookTarget = null;
    this.sportMode = 'none';
    this.sportBallWorld = null;
    this.sportShootLeft = 0;
    this.sportContactOwned = false;
    this.clipOneShotLeft = 0;

    this.poseEpoch++;
    this.walkTo = null;
    this.seatWalk = false;
    this.pendingActivity = null;
    this.chairBack = null;

    this.airborne = false;
    this.verticalSpeed = 0;
    this.jumpPhase = 'none';
    this.jumpLandLeft = 0;
    this.landSquash = 0;
    this.gaitHeld = false;
    this.drove = false;
    this.stillFor = 0;
    this.turnStillFor = 0;
    this.turning = 0;
    this.isBackpedaling = false;
    this.smoothedMoveYaw = 0;
    this.moveYaw = 0;
    this.lean = 0;
    this.leanRoll = 0;
    this.leanPitch = 0;
    this.stairPitch = 0;
    this.locomotionSpeed = 0;
    this.schmittBand = 'idle';
    this.filteredYawRate = 0;
    this.idleLifeWeight = 1;

    if (this.rig) {
      this.rig.stopGesture();
      this.rig.setContact(-1, null, 0.01, 0.01);
      this.rig.setContact(1, null, 0.01, 0.01);
      this.rig.clearTransientContacts(true);
      (this.rig as HumanRig & { clearAllContactsImmediate?: () => void }).clearAllContactsImmediate?.();
      this.rig.resetFootDynamics();
    }

    if (!this.seat && !this.rising && this.vehicleMode === 'none') {
      if (this.body.state !== 'standing') {
        this.body.abortToStanding();
      }
      this.seatPelvisDropY = 0;
      this.rollingVelX = 0;
      this.rollingVelZ = 0;
      this.rollingSpeedNow = 0;
      this.activity = 'idle';
      this.mood = 'neutral';
      this.root.position.y = this.floorY(this.root.position.x, this.root.position.z);
      this.root.rotation.x = 0;
      this.root.rotation.z = 0;
      if (this.ready) {
        this.locomotionBlendActive = false;
        this.mixer.stopAllAction();
        for (const [, act] of this.actions) {
          act.stopFading();
          act.stop();
          act.timeScale = 1;
          act.setEffectiveWeight(1);
        }
        for (const [bone, q] of this.mixerBase) {
          const bindQ = this.mixerBindQuat.get(bone);
          if (bindQ) {
            q.copy(bindQ);
            bone.quaternion.copy(bindQ);
          }
        }
        this.current = null;
        this.currentName = '';
        this.play('Idle', 0);
        this.advanceMixer(0, false);
        this.deadBlend?.seedFromCurrent();
      }
    }
    this.secondary?.reset();
  }

  /** Optional facial expression and preview pose override for Creator Studio (`neutral`, `smile`, `talk`, `walk`) and Photo Studio (`joy`, `focused`, `surprised`, etc.). */
  setExpressionOverride(mood: Mood | 'talk' | 'walk' | 'joy' | 'focused' | 'surprised' | string | null) {
    const raw = mood as string | null;
    const enteringStudio = this.expressionOverride === null && !this.studioSpeaking && raw !== null;
    if (raw === null) {
      const wasPreviewPose =
        this.studioSpeaking ||
        (this.studioPose === null &&
          (this.currentName.startsWith('studio_') ||
            this.currentName === 'Walk' ||
            this.currentName === 'Talk_Gesture'));
      this.expressionOverride = null;
      this.studioSpeaking = false;
      if (this.ready && this.standing && wasPreviewPose) {
        this.play('Idle', 0.22);
      }
      return;
    }
    if (enteringStudio && this.standing) {
      this.clearTransientMotion({ contrapposto: raw !== 'walk' && raw !== 'talk' && this.studioPose === null });
    }
    if (raw === 'walk') {
      this.expressionOverride = 'neutral';
      this.studioSpeaking = false;
      if (this.ready && this.standing) {
        this.play('Walk', 0.2);
        const w = this.actions.get('Walk');
        if (w) w.timeScale = 1;
      }
      return;
    }
    if (raw === 'talk') {
      this.expressionOverride = 'smile';
      this.studioSpeaking = true;
      if (this.ready && this.standing && this.studioPose === null) {
        if (!this.playClipActivity('Talk_Gesture', 0.22, false)) {
          this.play('studio_contrapposto', 0.22);
        }
      }
      return;
    }
    this.studioSpeaking = false;
    this.expressionOverride = raw as Mood;
    this.studioSettlePending = true;
    if (this.ready && this.standing && this.studioPose === null && !this.currentName.startsWith('studio_')) {
      this.play(this.actions.has('studio_contrapposto') ? 'studio_contrapposto' : 'Idle', 0.22);
    }
  }

  /** Optional pose preview for Photo Studio (`stand`, `idle`, `contrapposto`, `wave`, `cheer`, `think`, `peace`, `dance`, `stretch`, `sit`, `read`, etc.). */
  setStudioPose(pose: string | null) {
    const prev = this.studioPose;
    this.studioPose = pose;
    if (!this.ready) return;
    if (pose === null) {
      for (const studioKey of ['studio_contrapposto', 'studio_wave', 'studio_cheer', 'studio_think', 'studio_peace']) {
        const act = this.actions.get(studioKey);
        if (act) act.timeScale = 1;
      }
      const stretchAct = this.actions.get('stretch');
      if (stretchAct) {
        stretchAct.setLoop(T.LoopOnce, 1);
        stretchAct.clampWhenFinished = true;
      }
      if (prev !== null && this.standing) this.play('Idle', 0.22);
      return;
    }
    this.cancelEmbodiedSession(false);
    if (this.standing) {
      if (prev === null) {
        this.clearTransientMotion();
      } else {
        this.expression = null;
        this.clipOneShotLeft = 0;
        this.sportShootLeft = 0;
        this.exitLocomotionBlend(0.16);
        this.releaseSportContacts();
        this.rig?.stopGesture();
        this.rig?.clearTransientContacts(true);
      }
    }
    const aliases: Record<string, string> = {
      '': 'studio_contrapposto',
      stand: 'studio_contrapposto',
      idle: 'studio_contrapposto',
      contrapposto: 'studio_contrapposto',
      relaxed: 'studio_contrapposto',
      wave: 'studio_wave',
      cheer: 'studio_cheer',
      think: 'studio_think',
      peace: 'studio_peace',
      dance: 'Dance_Pop',
      stretch: 'stretch',
      sit: 'sit',
      read: 'read',
      relax: 'relax',
    };
    const target = aliases[pose] ?? pose;
    const fade = prev === null ? 0.16 : 0.18;
    if (this.actions.has(target)) {
      const act = this.actions.get(target)!;
      act.setLoop(T.LoopRepeat, Infinity);
      act.clampWhenFinished = false;
      act.timeScale = 1;
      this.clipOneShotLeft = 0;
      this.play(target, fade);
    } else if (!this.playClipActivity(target, fade, false)) {
      this.play(this.actions.has('studio_contrapposto') ? 'studio_contrapposto' : 'Idle', fade);
    }
    this.studioSettlePending = true;
  }

  private getClipQuatBones(clip: T.AnimationClip): Set<T.Bone> {
    let set = this.clipQuatBoneCache.get(clip);
    if (set) return set;
    set = new Set<T.Bone>();
    for (let i = 0; i < clip.tracks.length; i++) {
      const tr = clip.tracks[i];
      const dot = tr.name.lastIndexOf('.');
      if (dot < 0 || tr.name.slice(dot + 1) !== 'quaternion') continue;
      const rawNode = tr.name.slice(0, dot);
      const bone = this.bonesByNodeName.get(rawNode) ?? this.bones.get(rawNode);
      if (bone) set.add(bone);
    }
    this.clipQuatBoneCache.set(clip, set);
    return set;
  }

  private collectActiveClipBoneSets(): void {
    const out = this.activeClipBoneSetsScratch;
    out.length = 0;
    if (this.locomotionBlendActive) {
      for (let i = 0; i < LOCO_POOL.length; i++) {
        const act = this.actions.get(LOCO_POOL[i]);
        if (act && act.isRunning() && act.getEffectiveWeight() > 1e-4) {
          out.push(this.getClipQuatBones(act.getClip()));
        }
      }
      return;
    }
    if (this.current && this.current.isRunning() && this.current.getEffectiveWeight() > 1e-4) {
      out.push(this.getClipQuatBones(this.current.getClip()));
    }
    for (const [, act] of this.actions) {
      if (act !== this.current && act.isRunning() && act.getEffectiveWeight() > 1e-4) {
        out.push(this.getClipQuatBones(act.getClip()));
      }
    }
  }

  private exitLocomotionBlend(fadeDuration = 0.16) {
    if (!this.locomotionBlendActive) return;
    if (fadeDuration > 0.01) {
      this.deadBlend?.triggerTransition(Math.min(0.18, fadeDuration), 0.055);
    }
    for (const name of LOCO_POOL) {
      const act = this.actions.get(name);
      if (!act) continue;
      act.stopFading();
      act.stop();
      act.timeScale = 1;
      act.setEffectiveWeight(1);
    }
    this.locomotionBlendActive = false;
    this.current = null;
    this.currentName = '';
  }

  private play(name: string, fade = 0.45, resume = false) {
    if (this.locomotionBlendActive) {
      this.exitLocomotionBlend(Math.min(0.18, fade));
    }
    const next = this.actions.get(name);
    if (!next || this.currentName === name) return;
    const from = this.current, gait = (n: string) => LOCO_GAIT_SET.has(n);
    // Keep Three.js crossFadeTo when root-motion (`this.motion`) is active so `motionWeight` tracks action weight accurately.
    if (this.motion) {
      next.reset().setEffectiveWeight(1).play();
      if (from && fade > 0) from.crossFadeTo(next, fade, false);
      else if (from) from.stop();
      this.current = next;
      this.currentName = name;
      this.blendRemaining = Math.max(fade, 1 / 60);
      return;
    }
    if (resume && from && from !== next && fade > 0 && (gait(name) || (name === 'Idle' && gait(this.currentName))) && next.isScheduled() && next.getEffectiveWeight() > 1e-3) {
      const wNext = next.getEffectiveWeight(), wFrom = from.getEffectiveWeight(), left = Math.max(Math.min(0.18, fade) * (1 - wNext), 1 / 120);
      next.enabled = true; next.setEffectiveWeight(1); from.setEffectiveWeight(1);
      (next as unknown as Fading)._scheduleFading(left, wNext, 1);
      (from as unknown as Fading)._scheduleFading(left, wFrom, 0);
      this.current = next; this.currentName = name; this.blendRemaining = Math.max(Math.min(0.18, fade), 1 / 60);
      return;
    }
    if (from && fade > 0.015) {
      this.deadBlend?.triggerTransition(Math.min(0.18, fade), 0.055);
    }
    next.stopFading();
    next.reset().setEffectiveWeight(1).play();
    if (from && gait(name) && gait(this.currentName)) {
      next.time = (from.time / Math.max(1e-4, from.getClip().duration)) * next.getClip().duration;
    } else if (gait(name)) {
      const duration = next.getClip().duration;
      next.time = ((this.gaitLift[name] ?? .5) * duration - Math.min(fade, 0.18) + duration) % duration;
    }
    if (from && from !== next) {
      from.stopFading();
      from.stop();
    }
    this.current = next;
    this.currentName = name;
    this.blendRemaining = Math.max(Math.min(0.18, fade), 1 / 60);
  }

  private rotateBoneWorldAxis(bone: T.Bone, worldAxis: T.Vector3, angleRad: number) {
    if (Math.abs(angleRad) <= 1e-5) return;
    this.leanQuatScratch.setFromAxisAngle(worldAxis, angleRad);
    bone.getWorldQuaternion(this.leanWorldQuatScratch);
    this.leanWorldQuatScratch.premultiply(this.leanQuatScratch).normalize();
    if (bone.parent) {
      bone.parent.getWorldQuaternion(this.leanParentInvScratch).invert();
      bone.quaternion.copy(this.leanParentInvScratch).multiply(this.leanWorldQuatScratch).normalize();
    } else {
      bone.quaternion.copy(this.leanWorldQuatScratch);
    }
    bone.updateWorldMatrix(false, true);
  }

  private static readonly LIFE_BONE_KEYS = [
    'hips',
    'spine',
    'chest',
    'neck',
    'head',
    'shoulder.L',
    'shoulder.R',
  ] as const;

  private advanceMixer(dt: number, reduced: boolean, holdClipTime = false) {
    // Restore pure pre-layer mixer quaternions (`mixerBase`) BEFORE `mixer.update` so Three.js `PropertyMixer`'s
    // unchanged-slot optimization (`accu0 === accu1`) never retains post-mixer `deadBlend`, `lean`, or `CharacterLife` deltas,
    // while resetting any bone NOT driven by the active clip(s) back to `mixerBindQuat` (`0` stuck twist/finger curl).
    this.rig?.restore();
    this.secondary?.restore();
    if (this.mixerBase.size > 0) {
      this.collectActiveClipBoneSets();
      const activeSets = this.activeClipBoneSetsScratch;
      const setCount = activeSets.length;
      for (const [bone, q] of this.mixerBase) {
        let driven = setCount === 0;
        for (let i = 0; i < setCount; i++) {
          if (activeSets[i].has(bone)) {
            driven = true;
            break;
          }
        }
        if (driven) {
          bone.quaternion.copy(q);
        } else {
          const bindQ = this.mixerBindQuat.get(bone);
          if (bindQ) {
            bone.quaternion.copy(bindQ);
            q.copy(bindQ);
          } else {
            bone.quaternion.copy(q);
          }
        }
      }
    }
    const hips = this.bones.get('hips');
    if (hips) hips.position.copy(this.rawBindHipsPos);
    const mixerStep = holdClipTime ? 0 : (reduced && !this.currentName.startsWith('studio_') ? Math.min(dt, this.blendRemaining) : dt);
    this.mixer.update(mixerStep);
    for (const [bone, q] of this.mixerBase) q.copy(bone.quaternion);
    if (hips && this.hipsLegOffsetModelY !== 0 && !this.seat?.lie && !this.floorPostureActive && this.vehicleMode === 'none') {
      hips.position.y += this.hipsLegOffsetModelY;
    }
    this.deadBlend?.apply(dt, reduced);
    if (
      hips &&
      (Math.abs(this.seatPelvisDropY) > 1e-5 || this.landSquash > 1e-4) &&
      !this.seat?.lie &&
      !this.floorPostureActive &&
      this.vehicleMode === 'none'
    ) {
      hips.position.y += (this.seatPelvisDropY - this.landSquash) / this.modelScaleNow;
    }
    // Centripetal banking (`leanRoll`) and forward/stair lean (`leanPitch`) across lumbar/thoracic spine ONLY when not delegated to HumanRig
    if (
      !this.bodyLeanDelegatedToRig &&
      this.vehicleMode === 'none' &&
      !this.seat &&
      !this.motion &&
      (Math.abs(this.leanRoll) > 1e-4 || Math.abs(this.leanPitch) > 1e-4)
    ) {
      const spine = this.bones.get('spine');
      const chest = this.bones.get('chest');
      if (spine && chest) {
        this.root.getWorldQuaternion(this.leanWorldQuatScratch);
        this.leanFwdScratch.set(0, 0, 1).applyQuaternion(this.leanWorldQuatScratch).setY(0);
        if (this.leanFwdScratch.lengthSq() > 1e-6) this.leanFwdScratch.normalize();
        else this.leanFwdScratch.set(0, 0, 1);
        this.leanRightScratch.set(-this.leanFwdScratch.z, 0, this.leanFwdScratch.x);
        this.model.updateWorldMatrix(true, true);
        this.rotateBoneWorldAxis(spine, this.leanRightScratch, -this.leanPitch * 0.4);
        this.rotateBoneWorldAxis(spine, this.leanFwdScratch, this.leanRoll * 0.4);
        this.rotateBoneWorldAxis(chest, this.leanRightScratch, -this.leanPitch * 0.6);
        this.rotateBoneWorldAxis(chest, this.leanFwdScratch, this.leanRoll * 0.6);
      }
    }
    // Layer organic chest breathing and gentle standing weight-shift sway ONLY when stationary & hands-free:
    // smoothly attenuate `idleLifeWeight -> 0` whenever moving (`locomotionSpeed > 0.10`), turning rapidly, `workingBody`, or holding an object!
    const worldFrozen = this.frame.dt <= 1e-6 && this.isStudioPoseActive;
    const holdingAny =
      this.workingBody ||
      this.isHoldingRoomProp() ||
      Boolean(this.rig?.contactOn(1) || this.rig?.contactOn(-1));
    const turningNow = this.turning !== 0 || Math.abs(this.filteredYawRate) > 0.22;
    const movingNow =
      this.locomotionBlendActive ||
      this.locomotionSpeed > 0.10 ||
      this.stepping ||
      this.airborne ||
      this.jumpPhase !== 'none';
    const wantIdleLife =
      !movingNow &&
      !turningNow &&
      !holdingAny &&
      this.vehicleMode === 'none' &&
      !this.rising &&
      !this.deadBlend?.isBlending
        ? 1
        : 0;
    const lifeTau = wantIdleLife < this.idleLifeWeight ? 20 : 5.5;
    const lifeAlpha = reduced ? 1 : 1 - Math.exp(-lifeTau * Math.max(0, dt));
    this.idleLifeWeight += (wantIdleLife - this.idleLifeWeight) * lifeAlpha;
    if (this.idleLifeWeight < 1e-3 && wantIdleLife === 0) this.idleLifeWeight = 0;
    if (this.idleLifeWeight > 0.999 && wantIdleLife === 1) this.idleLifeWeight = 1;

    if (
      this.idleLifeWeight > 1e-3 &&
      this.life &&
      !this.motion &&
      (!this.ownView || this.mirrorObserved) &&
      !worldFrozen &&
      dt > 0
    ) {
      const partialLife = this.idleLifeWeight < 0.999;
      if (partialLife) {
        for (let i = 0; i < Character.LIFE_BONE_KEYS.length; i++) {
          const b = this.bones.get(Character.LIFE_BONE_KEYS[i]);
          if (b) this.lifePreQuats[i].copy(b.quaternion);
        }
        if (hips) this.lifePreHipsPos.copy(hips.position);
      }
      const lifeMood: LifeMood =
        this.mood === 'think' ? 'focus'
        : this.mood === 'smile' ? 'friendly'
        : (this.mood as LifeMood);
      this.life.update({
        dt,
        reduced,
        applyFace: false,
        curlFingers: false,
        speed: 0,
        seated: !!this.seat || this.vehicleMode !== 'none',
        inDialogue: this.dialogueActive,
        speaking: this.dialogueSpeaking || this.studioSpeaking,
        lookTargetWorld: null,
        mood: lifeMood,
      });
      if (partialLife) {
        const w = this.idleLifeWeight;
        for (let i = 0; i < Character.LIFE_BONE_KEYS.length; i++) {
          const b = this.bones.get(Character.LIFE_BONE_KEYS[i]);
          if (!b) continue;
          const qPre = this.lifePreQuats[i];
          if (qPre.dot(b.quaternion) < 0) {
            b.quaternion.set(-b.quaternion.x, -b.quaternion.y, -b.quaternion.z, -b.quaternion.w);
          }
          b.quaternion.copy(qPre).slerp(b.quaternion, w).normalize();
        }
        if (hips) {
          hips.position.lerpVectors(this.lifePreHipsPos, hips.position, w);
        }
        this.model.updateWorldMatrix(true, true);
      }
    }
    this.rig?.capture();
    this.secondary?.capture();
    this.blendRemaining = Math.max(0, this.blendRemaining - dt);
    // Follow the action's measured posture, not a fixed standing eye height or animation head jitter.
    const head = this.bones.get('head');
    const target = this.motion && !this.motion.leaving && head
      ? this.root.worldToLocal(head.getWorldPosition(this.eyeWorldScratchA)).y + this.eyeUp * this.heightScaleNow - this.eyes.stand.y : 0;
    this.motionEye += (target - this.motionEye) * (1 - Math.exp(-12 * dt));
  }

  /** Registration binds validated metadata to an existing clip on this exact skeleton. */
  registerMotion(value: unknown, hands: 'free' | 'carry' = 'free', holdAt?: number, envelope?: FloorEnvelope) {
    const track = readRootMotion(value), clip = track && this.actions.get(track.name)?.getClip();
    if (!track || !clip || Math.abs(clip.duration - track.duration) > 1e-5 || !['free', 'carry'].includes(hands)) return false;
    if (holdAt !== undefined && (!Number.isFinite(holdAt) || holdAt <= 0 || holdAt > track.duration)) return false;
    if (isFloorPose(track.name) && (!envelope || ![envelope.minX,envelope.maxX,envelope.minZ,envelope.maxZ,envelope.top].every(Number.isFinite)
      || envelope.minX >= envelope.maxX || envelope.minZ >= envelope.maxZ || envelope.top <= 0)) return false;
    this.motions.set(track.name, { track, hands, holdAt, envelope }); return true;
  }
  availableMotions() { return [...this.motions.keys()]; }
  performMotion(name: string, restoreRest = false) {
    const spec = this.motions.get(name);
    if (!this.ready || !spec || this.motion || !this.standing || this.expression || this.motionAllowed?.(spec.hands) === false) return false;
    const clock = new RootMotionClock(spec.track, { x:this.root.position.x, z:this.root.position.z, yaw:this.root.rotation.y }, SCALE);
    if (restoreRest && spec.holdAt !== undefined) {
      clock.origin.yaw -= clock.pose(spec.holdAt).yaw - clock.origin.yaw;
      const end = clock.pose(spec.holdAt);
      clock.origin.x += this.root.position.x - end.x; clock.origin.z += this.root.position.z - end.z;
    }
    if (spec.envelope && this.floorSpaceFree?.(clock.origin,spec.envelope) === false) {
      const facing = clock.origin.yaw, bounds = spec.envelope;
      const turn = !restoreRest && [1,-1,2,-2,3,-3,4].map(n => n * Math.PI / 4)
        .find(angle => this.floorSpaceFree?.({ ...clock.origin, yaw: facing + angle }, bounds));
      if (!turn) { this.lastMotion = {name,time:0,reason:'no-floor-space'}; return false; }
      clock.origin.yaw = facing + turn;
    }
    if (!this.body.beginAction(name)) return false;
    this.moveYaw = 0; this.turning = 0; this.activity = 'idle'; this.mood = 'neutral';
    this.play(name, .45);
    const action = this.actions.get(name)!;
    action.setLoop(T.LoopOnce, 1); action.clampWhenFinished = true; action.paused = true;
    this.motion = { clock, action, leaving: 0, reason: null, holdAt: spec.holdAt, aligning: !restoreRest && Math.abs(clock.origin.yaw - this.root.rotation.y) > .01 };
    if (restoreRest && spec.holdAt !== undefined) {
      const m = this.motion;
      clock.time = spec.holdAt; m.settled = true; action.time = clock.time;
      this.play(name,0); this.mixer.stopAllAction(); action.reset().setEffectiveWeight(1).play(); action.paused = true; action.time=clock.time;
      this.advanceMixer(0,false);
    }
    return true;
  }
  cancelMotion(reason = 'interrupted') {
    const m = this.motion; if (!m || m.leaving) return;
    if (m.holdAt !== undefined && (reason === 'interrupted' || reason === 'input-released')) {
      if (reason === 'interrupted') m.rising = true;
      return;
    }
    m.clock.cancel(); m.reason = reason; m.leaving = .35;
    this.play('Idle', m.leaving);
  }
  private advanceMotion(dt: number, reduced: boolean) {
    const m = this.motion!;
    if (m.aligning && !m.leaving) {
      if (m.rising) { this.cancelMotion('cancelled'); return; }
      const gap = Math.atan2(Math.sin(m.clock.origin.yaw - this.root.rotation.y), Math.cos(m.clock.origin.yaw - this.root.rotation.y));
      const turn = T.MathUtils.clamp(gap, -dt * 4, dt * 4);
      if (this.moveRoot(this.root.position.clone(), this.root.rotation.y + turn) < .999) this.cancelMotion('obstructed');
      else m.aligning = Math.abs(gap - turn) > .001;
      return;
    }
    if (!m.leaving) {
      const spec = this.motions.get(m.clock.track.name)!;
      if (this.motionAllowed?.(spec.hands) === false) this.cancelMotion('incompatible-action');
      else {
        // A hold at the final sample retraces its captured descent, including the root
        // and support annotations. A hold inside a clip has its own recorded rise.
        const reverse = m.holdAt === m.clock.track.duration && !!m.rising;
        const delta = m.holdAt !== undefined && !m.rising ? Math.min(dt,Math.max(0,m.holdAt-m.clock.time)) : dt;
        m.clock.advance(delta, pose => {
          const to = new T.Vector3(pose.x, this.root.position.y, pose.z);
          const allowed = this.motionClearance?.(this.root.position, to) ?? 1;
          const free = Number.isFinite(allowed) ? T.MathUtils.clamp(allowed, 0, 1) : 0;
          to.lerpVectors(this.root.position, to, free);
          const yaw = this.root.rotation.y + (pose.yaw - this.root.rotation.y) * free;
          return free * this.moveRoot(to, yaw);
        }, reverse);
        m.action.time = m.clock.time;
        if (m.holdAt !== undefined && !m.settled && !m.rising && m.clock.time >= m.holdAt-1e-8) {
          m.settled = true;
          const pose = m.clock.track.name;
          if (isFloorPose(pose)) this.onFloorRest?.(this.root.position.toArray(), this.root.rotation.y, pose);
        }
        if (m.clock.result === 'cancelled') this.cancelMotion('obstructed');
        else if (m.clock.result === 'completed' && (m.holdAt === undefined || m.rising)) this.cancelMotion('completed');
      }
    } else m.leaving = Math.max(0, m.leaving - dt);
    this.advanceMixer(dt, reduced); this.applyOwnView();
    if (m.reason && m.leaving <= 0) {
      m.action.stop(); this.body.endAction(m.clock.track.name);
      this.lastMotion = { name: m.clock.track.name, time: m.clock.time, reason: m.reason };
      this.motion = null; this.onMotionEnd?.();
    }
  }

  private risingSeatRef: { pos: T.Vector3; rotY: number; floorY: number; top: number } | null = null;

  /** Walks to a floor point, then runs `then`. */
  goTo(target: T.Vector3, then: (() => void) | null = null) {
    if (this.motion) { this.cancelMotion(); return false; }
    this.cancelEmbodiedSession(false);
    const from = this.seat?.approach ?? this.root.position;
    const points = this.navigate?.(from, target) ?? (this.navigate ? null : [target.clone().setY(this.floorY(target.x, target.z))]);
    const toSeat = this.seatWalk; this.seatWalk = false;
    if (!points?.length) return false;
    // A walk that is not to a seat ends any seat: told to the one authority, not left for it to find out.
    if (!toSeat && (this.body.seat || this.body.occupied)) {
      this.activity = 'idle';
      this.mood = 'neutral';
      this.body.stand();
      if (!this.seat) this.body.reset();
    } else if (!toSeat && this.activity === 'stretch') {
      this.activity = 'idle';
      this.mood = 'neutral';
    }
    this.rollingVelX = 0;
    this.rollingVelZ = 0;
    this.rollingSpeedNow = 0;
    // Getting up pushes the chair back the way it came, or there would be no room to stand.
    const drawn = this.seat?.contacts.slide;
    if (drawn?.moved) { this.chairBack = { id: drawn.id, left: drawn.moved, move: drawn.move, done: drawn.done }; drawn.moved = 0; }
    if (this.seat) {
      const standSeconds = this.seat.lie ? 1.15 : 0.68;
      this.risingPelvisDropFrom = this.seat.lie ? 0 : this.seatPelvisDropY;
      this.risingSeatRef = this.seat.lie
        ? null
        : { pos: this.seat.pos.clone(), rotY: this.seat.rotY, floorY: this.seat.floorY, top: this.seat.top };
      this.rising = {
        from: this.root.position.clone(),
        to: this.seat.approach.clone().setY(this.floorY(this.seat.approach.x, this.seat.approach.z)),
        elapsed: 0,
        seconds: standSeconds,
        lying: this.seat.lie,
      };
      if (!this.seat.lie && this.actions.has('Stand_Up')) {
        const st = this.actions.get('Stand_Up')!;
        st.setLoop(T.LoopOnce, 1);
        st.clampWhenFinished = true;
        st.timeScale = Math.max(0.75, (st.getClip().duration * 0.92) / standSeconds);
        this.play('Stand_Up', 0.18);
      }
    }
    this.seat = null;
    this.walkTo = { target: target.clone().setY(this.floorY(target.x, target.z)), points, then, blockedFor: 0 };
    return true;
  }

  get posture(): Posture { return this.body.state; }
  /** The chair the feet are drawing in or pushing back this moment: a layout write meanwhile must not put it back (it would leave the body sitting on air). */
  furnitureInHand(): string | null { if (this.chairBack) return this.chairBack.id ?? null; const s = this.seat?.contacts.slide; return s && s.distance > .001 ? s.id ?? null : null; }
  /** Is the body on, or on its way to, this seat? */
  occupies(key: string) { return this.body.seat === key; }
  private settleOn(
    key: string,
    target: T.Vector3,
    approach: T.Vector3,
    rotY: number,
    drop: number,
    floorY: number,
    pelvisDrop: number,
    lie: boolean,
    seatTop: number,
    contacts: SeatContacts,
    activity: Activity,
    instant = false,
  ) {
    this.cancelEmbodiedSession(false);
    this.expression = null;
    this.clipOneShotLeft = 0;
    this.sportMode = 'none';
    this.sportBallWorld = null;
    this.sportShootLeft = 0;
    this.releaseSportContacts();
    this.rig?.stopGesture();
    this.rig?.clearTransientContacts(!this.isHoldingRoomProp());
    this.risingSeatRef = null;
    this.rollingVelX = 0;
    this.rollingVelZ = 0;
    this.rollingSpeedNow = 0;
    const safeActivity: Activity = activity === 'stretch' ? 'idle' : activity;
    const mobility: 'stationary' | 'rolling' =
      contacts.mobility ??
      (/chair\.office|gaming[-_.]?chair/i.test(key) ? 'rolling' : 'stationary');
    const useSitDownClip = !instant && !lie && this.actions.has('Sit_Down');
    this.seat = {
      key,
      pos: target,
      approach: approach.clone(),
      rotY,
      drop,
      floorY,
      pelvisDrop,
      lie,
      started: this.elapsed,
      top: seatTop,
      mobility,
      contacts,
      targetActivity: safeActivity,
      activityStarted: !useSitDownClip,
    };
    this.body.arrived();
    if (useSitDownClip) {
      this.activity = safeActivity;
      this.mood = moodOf(safeActivity);
      const sitDownAct = this.actions.get('Sit_Down')!;
      sitDownAct.setLoop(T.LoopOnce, 1);
      sitDownAct.clampWhenFinished = true;
      sitDownAct.timeScale = Math.max(0.75, (sitDownAct.getClip().duration * 0.92) / 0.84);
      this.play('Sit_Down', 0.18);
    } else {
      this.setActivity(safeActivity, lie ? 1.1 : .55);
    }
  }

  /** Takes a seat / bed: hips placed at `seatTop` above `pos`, facing `rotY`; `lie` lays the body on its back. */
  sitAt(pos: T.Vector3, rotY: number, activity: Activity, seatTop: number, lie = false, contacts: SeatContacts = {}, key = 'seat', instant = false) {
    if (this.motion) { this.cancelMotion(); return false; }
    this.cancelEmbodiedSession(false);
    const safeReqActivity: Activity = activity === 'stretch' ? 'idle' : activity;
    // Asked again for the seat already in use: nothing moves, only what the body does there may change.
    if (!this.body.request(key, lie)) {
      if (this.seat) {
        this.seat.targetActivity = safeReqActivity;
        this.seat.activityStarted = true;
        this.setActivity(safeReqActivity);
      } else {
        this.pendingActivity = safeReqActivity;
      }
      return true;
    }
    const forward = new T.Vector3(Math.sin(rotY), 0, Math.cos(rotY));
    const right = new T.Vector3(Math.cos(rotY), 0, -Math.sin(rotY));
    const from = this.seat?.approach ?? this.root.position;
    let paths: Array<{ p: T.Vector3; path: T.Vector3[] | null | undefined }> = [];
    if (contacts.approaches) {
      paths = contacts.approaches
        .map(p => ({ p, path: this.navigate?.(from, p) }))
        .filter(p => !this.navigate || p.path?.length);
    } else if (lie) {
      paths = [pos.clone().addScaledVector(right, .95), pos.clone().addScaledVector(right, -.95)]
        .map(p => ({ p, path: this.navigate?.(from, p) }))
        .filter(p => !this.navigate || p.path?.length);
    } else {
      // Prefer front and lateral seat approaches; only fall back to rear-of-backrest if front/sides are unreachable.
      const primaryApproaches = [
        pos.clone().addScaledVector(forward, .72),
        pos.clone().addScaledVector(right, .72),
        pos.clone().addScaledVector(right, -.72),
      ];
      paths = primaryApproaches
        .map(p => ({ p, path: this.navigate?.(from, p) }))
        .filter(p => !this.navigate || p.path?.length);
      if (!paths.length) {
        const rearApproach = pos.clone().addScaledVector(forward, -.72);
        paths = [{ p: rearApproach, path: this.navigate?.(from, rearApproach) }]
          .filter(p => !this.navigate || p.path?.length);
      }
    }
    if (!paths.length) {
      if (this.activity === 'stretch') {
        this.activity = 'idle';
        this.mood = 'neutral';
      }
      this.body.reset();
      return false;
    }
    paths.sort((a, b) => a.p.distanceTo(this.root.position) - b.p.distanceTo(this.root.position));
    const chosenApproach = paths[0].p;
    const placement = () => {
      let target = pos.clone();
      const rawGround = this.groundAt?.(pos.x, pos.z);
      const appGround = this.groundAt?.(chosenApproach.x, chosenApproach.z);
      let seatFloorY =
        rawGround !== null && rawGround !== undefined && Number.isFinite(rawGround)
          ? rawGround
          : Number.isFinite(pos.y) && seatTop - pos.y >= 0.18
            ? pos.y
            : 0;
      if (
        appGround !== null &&
        appGround !== undefined &&
        Number.isFinite(appGround) &&
        seatFloorY - appGround > 0.24 &&
        Math.abs(seatFloorY - appGround) < 0.85
      ) {
        seatFloorY = appGround;
      }
      if (lie && contacts.bed) {
        const p = this.lyingProfile, bed = contacts.bed;
        target = bed.pillow.clone().sub(p.head.clone().applyAxisAngle(new T.Vector3(0, 1, 0), rotY));
        const lieDrop = Math.max(bed.surface - p.bodyMin * this.heightScaleNow, bed.pillow.y - p.headMin * this.heightScaleNow) + .004;
        return { target, drop: lieDrop, floorY: seatFloorY, pelvisDrop: 0, safeTop: seatTop };
      }
      if (lie) {
        const lieDrop = seatTop + .065 - this.hipRest;
        return { target, drop: lieDrop, floorY: seatFloorY, pelvisDrop: 0, safeTop: seatTop };
      }
      // Clamp cushion height relative to true floor so tilted/corrupt furniture metadata never sends pelvis skyward or underground.
      const safeTop = T.MathUtils.clamp(seatTop, seatFloorY + 0.24, seatFloorY + 0.78);
      const pelvisDrop = (safeTop + .065 - seatFloorY) - this.hipRest;
      return { target, drop: seatFloorY, floorY: seatFloorY, pelvisDrop, safeTop };
    };
    const epoch = ++this.poseEpoch;
    this.pendingActivity = null;
    if (instant) {
      // A saved seat comes back as a seat: a reload never walks the owner across the room to it.
      const { target, drop, floorY, pelvisDrop, safeTop } = placement();
      this.walkTo = null; this.rising = null; this.risingSeatRef = null;
      this.root.position.set(target.x, drop, target.z); this.root.rotation.set(0, rotY, 0);
      this.seatPelvisDropY = pelvisDrop;
      this.settleOn(key, target, chosenApproach, rotY, drop, floorY, pelvisDrop, lie, safeTop, contacts, safeReqActivity, true);
      if (this.seat) this.seat.started = -1e9;
      this.blendRemaining = 1 / 60; this.body.settled();
      this.eyeSit = lie ? 0 : 1; this.eyeLie = lie ? 1 : 0;
      this.advanceMixer(0, false);
      this.deadBlend?.seedFromCurrent();
      return true;
    }
    this.seatWalk = true;
    const walking = this.goTo(chosenApproach, () => {
      if (epoch !== this.poseEpoch) return;
      const { target, drop, floorY, pelvisDrop, safeTop } = placement();
      const actNow = this.pendingActivity ?? safeReqActivity;
      this.settleOn(key, target, chosenApproach, rotY, drop, floorY, pelvisDrop, lie, safeTop, contacts, actNow === 'stretch' ? 'idle' : actNow, false);
      this.pendingActivity = null;
    });
    if (!walking) {
      if (this.activity === 'stretch') {
        this.activity = 'idle';
        this.mood = 'neutral';
      }
      this.body.reset();
    }
    return walking;
  }
  private seatWalk = false;
  private pendingActivity: Activity | null = null;

  /** Cancels an active standing embodied session (e.g. walk-in shower) immediately in 0 locked frames. */
  cancelEmbodiedSession(playIdle = true): boolean {
    if (!this.embodiedSession) return false;
    const ended = this.embodiedSession;
    this.embodiedSession = null;
    this.clipOneShotLeft = 0;
    this.poseEpoch++;
    this.walkTo = null;
    this.activity = 'idle';
    this.mood = 'neutral';
    ended.onEnd?.();
    if (playIdle && this.ready && this.vehicleMode === 'none' && !this.seat && !this.rising && !this.motion) {
      this.root.position.y = this.floorY(this.root.position.x, this.root.position.z);
      this.root.rotation.x = 0;
      this.root.rotation.z = 0;
      this.play('Idle', 0.18);
    }
    return true;
  }

  /**
   * Starts or ends a standing embodied world session (e.g. walk-in shower `shower_rinse`):
   * resolves true `floorY` when `anchor.y` is omitted, clears stale hand contacts/gestures,
   * loops `clip` (default `'shower_rinse'`), and exits cleanly in 0 locked frames on WASD/Space/E/Escape or `active: false`.
   */
  setEmbodiedSession(spec: EmbodiedSessionSpec | null): boolean {
    if (!spec || spec.active === false) {
      return this.cancelEmbodiedSession(true);
    }
    if (!this.ready || this.vehicleMode !== 'none') return false;
    if (this.motion) this.cancelMotion();
    if (this.seat || this.rising) {
      this.standUp();
    }
    this.cancelEmbodiedSession(false);
    this.expression = null;
    this.clipOneShotLeft = 0;
    this.sportMode = 'none';
    this.sportBallWorld = null;
    this.sportShootLeft = 0;
    this.releaseSportContacts();
    this.rig?.stopGesture();
    this.rig?.clearTransientContacts(!this.isHoldingRoomProp());

    const clipName = spec.clip ?? 'shower_rinse';
    const ax = spec.anchor.x;
    const az = spec.anchor.z;
    const ay = spec.anchor.y !== undefined && Number.isFinite(spec.anchor.y) ? spec.anchor.y : this.floorY(ax, az);
    const target = new T.Vector3(ax, ay, az);
    const snapRadius = spec.snapRadius ?? 0.65;
    const epoch = ++this.poseEpoch;

    const enterSession = () => {
      if (epoch !== this.poseEpoch) return;
      this.walkTo = null;
      const moved = this.moveRoot(target, spec.yaw);
      if (moved < 0.999) {
        this.root.position.copy(target);
        this.root.rotation.y = spec.yaw;
      }
      this.root.rotation.x = 0;
      this.root.rotation.z = 0;
      this.activity = 'idle';
      this.mood = 'smile';
      this.embodiedSession = {
        clip: clipName,
        anchor: target.clone(),
        yaw: spec.yaw,
        onEnd: spec.onEnd,
      };
      if (!this.playClipActivity(clipName, 0.22, false)) {
        this.play('Idle', 0.22);
      }
      spec.onStart?.();
    };

    if (!this.rising && Math.hypot(ax - this.root.position.x, az - this.root.position.z) <= snapRadius) {
      enterSession();
      return true;
    }
    const walking = this.goTo(target, enterSession);
    if (!walking) {
      enterSession();
    }
    return true;
  }

  /**
   * Walks or snaps to an interactive city/world embodied action anchor, aligns facing yaw,
   * and triggers an authored 48-clip activity, standing session (`active !== undefined`), or hand gesture.
   */
  alignToEmbodiedAction(spec: EmbodiedActionAlignment): boolean {
    if (spec.active === false) {
      return this.cancelEmbodiedSession(true);
    }
    if (spec.active === true && spec.anchor && spec.yaw !== undefined && Number.isFinite(spec.yaw)) {
      return this.setEmbodiedSession({
        anchor: { x: spec.anchor.x, y: spec.anchor.y, z: spec.anchor.z },
        yaw: spec.yaw,
        clip: spec.clip,
        active: true,
        snapRadius: spec.snapRadius,
        onStart: spec.onStart,
        onEnd: spec.onEnd,
      });
    }
    if (!this.ready || this.vehicleMode !== 'none') return false;
    if (this.motion) this.cancelMotion();
    this.cancelEmbodiedSession(false);
    const snapRadius = spec.snapRadius ?? 0.42;
    const execute = () => {
      if (!spec.gesture) {
        this.expression = null;
        this.rig?.stopGesture();
      }
      this.releaseSportContacts();
      this.rig?.clearTransientContacts(!this.isHoldingRoomProp());
      if (spec.yaw !== undefined && Number.isFinite(spec.yaw)) {
        this.moveRoot(this.root.position, spec.yaw);
      }
      if (spec.clip) {
        const isOneShot = spec.oneShot ?? (spec.clip !== 'shower_rinse');
        this.playClipActivity(spec.clip, 0.24, isOneShot);
        if (!isOneShot && spec.anchor) {
          const ax0 = spec.anchor.x;
          const az0 = spec.anchor.z;
          const ay0 = spec.anchor.y !== undefined && Number.isFinite(spec.anchor.y) ? spec.anchor.y : this.floorY(ax0, az0);
          this.embodiedSession = {
            clip: spec.clip,
            anchor: new T.Vector3(ax0, ay0, az0),
            yaw: spec.yaw ?? this.root.rotation.y,
            onEnd: spec.onEnd,
          };
        }
      }
      if (spec.gesture) {
        this.express(spec.gesture);
      }
      spec.onStart?.();
    };
    if (!spec.anchor) {
      execute();
      return true;
    }
    const ax = spec.anchor.x;
    const az = spec.anchor.z;
    const ay = spec.anchor.y !== undefined && Number.isFinite(spec.anchor.y) ? spec.anchor.y : this.floorY(ax, az);
    const target = new T.Vector3(ax, ay, az);
    const dx = ax - this.root.position.x;
    const dz = az - this.root.position.z;
    if (!this.seat && !this.rising && Math.hypot(dx, dz) <= snapRadius) {
      this.walkTo = null;
      this.moveRoot(target, spec.yaw ?? this.root.rotation.y);
      execute();
      return true;
    }
    return this.goTo(target, execute);
  }

  setActivity(a: Activity, fade = .45) {
    if (this.motion) { this.cancelMotion(); return; }
    this.activity = a;
    const seated = this.seat && !this.seat.lie;
    const map: Record<Activity, string> = {
      idle: seated ? 'sit' : 'Idle', study: 'type', type: 'type', read: seated ? 'read' : 'Listen', write: 'write', listen: seated ? 'listen' : 'Listen',
      relax: seated ? 'relax' : 'Idle', sleep: 'sleep', stretch: 'stretch', wave: 'Wave',
    };
    let clip = map[a];
    if (!seated && SEATED.has(clip) && clip !== 'relax') clip = a === 'read' ? 'Listen' : 'Idle';
    if (this.seat?.lie) clip = 'sleep';
    if (a === 'wave') { clip = seated ? 'sit' : 'Idle'; this.rig?.play('wave'); }
    if (clip === 'stretch' && !this.isStudioPoseActive) {
      const stretchAct = this.actions.get('stretch');
      if (stretchAct) {
        stretchAct.setLoop(T.LoopOnce, 1);
        stretchAct.clampWhenFinished = true;
        this.clipOneShotLeft = Math.max(0.4, stretchAct.getClip().duration);
      }
    }
    this.play(clip, fade);
    this.mood = moodOf(a);
  }

  private pickClipName(candidates: readonly string[]): string | null {
    for (const c of candidates) {
      if (this.actions.has(c)) return c;
    }
    return null;
  }

  /** The same gesture, the same skeleton, whichever camera sees it. Sitting or lying the hands still answer; only a jump needs the feet. */
  private airborne = false;
  private verticalSpeed = 0;
  private landSquash = 0;
  private stairPitch = 0;
  jumpClear: ((pos: T.Vector3, y: number) => boolean) | null = null;
  express(action: EmbodiedAction) {
    if (this.motion) { this.cancelMotion(); return; }
    if (!this.ready || action === 'grab') return;
    if (action === 'jump' && this.embodiedSession) {
      this.cancelEmbodiedSession(false);
    }
    const gesture = GESTURE_OF[action];
    const canJump = !this.airborne && this.vehicleMode === 'none' && !this.seat && !this.rising && !this.walkTo && !this.motion;
    if (!gesture || (action === 'jump' && !canJump)) return;
    if (action === 'jump') {
      this.verticalSpeed = JUMP_INITIAL_VELOCITY;
      this.airborne = true;
      this.jumpPhase = 'takeoff';
      this.jumpLandLeft = 0;
      const takeoffClip = this.pickClipName(['Jump_Takeoff', 'JumpUp', 'Jump']);
      if (takeoffClip) {
        const act = this.actions.get(takeoffClip)!;
        act.setLoop(T.LoopOnce, 1);
        act.clampWhenFinished = true;
        this.play(takeoffClip, 0.10);
      }
    }
    this.rig?.play(gesture);
    this.expression = { action, elapsed: 0 };
    this.mood = action === 'jump' ? this.mood : action === 'inspect' ? 'think' : action === 'listen' ? 'listen' : action === 'wave' ? 'smile' : 'happy';
  }
  get standing() { return this.vehicleMode === 'none' && !this.seat && !this.rising && !this.walkTo && !this.motion; }
  /** The clip's legs are stepping: the feet are theirs. */
  get stepping() { return this.locomotionBlendActive || LOCO_GAIT_SET.has(this.currentName) || !!this.motion; }
  /** On its own two feet: not sitting, lying, on the way down or getting up. */
  get onFeet() { return !this.airborne && this.vehicleMode === 'none' && !this.seat && !this.rising && !this.body.occupied && this.body.state !== 'rising'; }
  /** What this body weighs. The two characters are not the same size. */
  get bodyKg() { return this.cfg.model === 'KAI' ? 68 : 55; }

  /** Aborts an in-flight seat walk, active embodied session, or early lowering cleanly so WASD/Space/Esc never deadlocks `PostureMachine`. */
  cancelSeatApproach(): boolean {
    if (this.embodiedSession && !this.seat && !this.isApproachingSeat) {
      return this.cancelEmbodiedSession(true);
    }
    const approaching = this.isApproachingSeat;
    if (!approaching && !(this.seat && this.body.state === 'lowering' && !this.rising)) {
      return false;
    }
    this.poseEpoch++;
    this.walkTo = null;
    this.seatWalk = false;
    this.pendingActivity = null;
    this.seat = null;
    this.seatPelvisDropY = 0;
    this.lean = 0;
    this.rollingVelX = 0;
    this.rollingVelZ = 0;
    this.rollingSpeedNow = 0;
    this.activity = 'idle';
    this.mood = 'neutral';
    this.expression = null;
    this.rig?.stopGesture();
    if (!this.body.cancelApproach()) {
      this.body.abortToStanding();
    }
    if (this.ready && !this.rising && this.vehicleMode === 'none') {
      this.root.position.y = this.floorY(this.root.position.x, this.root.position.z);
      this.root.rotation.x = 0;
      this.root.rotation.z = 0;
      this.play('Idle', 0.2);
    }
    return true;
  }

  /**
   * Atomic, deadlock-free seat/bed dismount:
   * resolves a valid floor dismount target (testing navmesh candidates with unconditional direct fallback
   * so `this.navigate` returning `null` can NEVER strand `this.seat` + `body.state === 'rising'`).
   */
  standUp(fallbackPoint?: T.Vector3): boolean {
    if (this.embodiedSession && !this.seat && !this.rising && !this.motion) {
      return this.cancelEmbodiedSession(true);
    }
    if (this.motion) {
      this.cancelMotion();
      return true;
    }
    if (this.isApproachingSeat && !this.seat) {
      return this.cancelSeatApproach();
    }
    if (this.rising) {
      this.seat = null;
      this.walkTo = null;
      this.activity = 'idle';
      this.mood = 'neutral';
      if (this.body.state !== 'rising') this.body.stand();
      return true;
    }
    if (!this.seat) {
      this.poseEpoch++;
      this.walkTo = null;
      this.seatWalk = false;
      this.pendingActivity = null;
      this.activity = 'idle';
      this.mood = 'neutral';
      if (this.body.state !== 'standing') {
        this.body.abortToStanding();
        return true;
      }
      return false;
    }

    const s = this.seat;
    this.activity = 'idle';
    this.mood = 'neutral';
    this.expression = null;
    this.rig?.stopGesture();
    this.rollingVelX = 0;
    this.rollingVelZ = 0;
    this.rollingSpeedNow = 0;
    const drawn = s.contacts.slide;
    if (drawn?.moved) {
      this.chairBack = { id: drawn.id, left: drawn.moved, move: drawn.move, done: drawn.done };
      drawn.moved = 0;
    }

    let dismountTo: T.Vector3 | null = null;
    if (fallbackPoint && Number.isFinite(fallbackPoint.x) && Number.isFinite(fallbackPoint.z)) {
      const fy = Number.isFinite(fallbackPoint.y) ? fallbackPoint.y : this.floorY(fallbackPoint.x, fallbackPoint.z);
      dismountTo = new T.Vector3(fallbackPoint.x, fy, fallbackPoint.z);
    } else {
      const candidates: T.Vector3[] = [s.approach];
      if (s.contacts.approaches) {
        for (const ap of s.contacts.approaches) candidates.push(ap);
      }
      const probeAngles = [0, 0.52, -0.52, 1.05, -1.05, 1.57, -1.57, Math.PI];
      const probeDists = [0.68, 0.86];
      for (const dist of probeDists) {
        for (const ang of probeAngles) {
          const a = s.rotY + ang;
          candidates.push(
            new T.Vector3(
              s.pos.x + Math.sin(a) * dist,
              s.floorY,
              s.pos.z + Math.cos(a) * dist,
            ),
          );
        }
      }
      for (const cand of candidates) {
        this.dismountCandScratch.set(cand.x, this.floorY(cand.x, cand.z), cand.z);
        if (!this.navigate) {
          dismountTo = this.dismountCandScratch.clone();
          break;
        }
        const path =
          this.navigate(s.approach, this.dismountCandScratch) ??
          this.navigate(s.pos, this.dismountCandScratch);
        if (path && path.length > 0) {
          const last = path[path.length - 1];
          dismountTo = last.clone().setY(this.floorY(last.x, last.z));
          break;
        }
      }
      if (!dismountTo) {
        const fx = Number.isFinite(s.approach.x) ? s.approach.x : s.pos.x + Math.sin(s.rotY) * 0.68;
        const fz = Number.isFinite(s.approach.z) ? s.approach.z : s.pos.z + Math.cos(s.rotY) * 0.68;
        dismountTo = new T.Vector3(fx, this.floorY(fx, fz), fz);
      }
    }

    const standSeconds = s.lie ? 1.1 : 0.68;
    this.poseEpoch++;
    this.pendingActivity = null;
    this.walkTo = null;
    this.seatWalk = false;
    this.risingPelvisDropFrom = s.lie ? 0 : this.seatPelvisDropY;
    this.risingSeatRef = s.lie
      ? null
      : { pos: s.pos.clone(), rotY: s.rotY, floorY: s.floorY, top: s.top };
    this.rising = {
      from: this.root.position.clone(),
      to: dismountTo,
      elapsed: 0,
      seconds: standSeconds,
      lying: s.lie,
    };
    this.seat = null;
    this.body.stand();
    if (!s.lie && this.actions.has('Stand_Up')) {
      const st = this.actions.get('Stand_Up')!;
      st.setLoop(T.LoopOnce, 1);
      st.clampWhenFinished = true;
      st.timeScale = Math.max(0.75, (st.getClip().duration * 0.92) / standSeconds);
      this.play('Stand_Up', 0.18);
    } else {
      this.play('Idle', 0.22);
    }
    return true;
  }

  /**
   * Drives a wheeled swivel chair (`chair.office` / `gaming-chair`) while seated:
   * integrates caster velocity with drag, slides cleanly along collision boundaries via `canRoll`,
   * swivels toward `targetYaw`, advances foot-scoot IK phase, and notifies furniture sync hooks.
   */
  driveRollingChair(
    dx: number,
    dz: number,
    targetYaw: number,
    dt: number,
    canRoll?: (x: number, z: number) => boolean,
  ): boolean {
    const s = this.seat;
    if (!this.ready || !s || s.lie || this.rising || s.mobility !== 'rolling') {
      return false;
    }
    if (dt <= 0) return true;
    const safeDt = Math.min(0.05, Math.max(dt, 1 / 240));
    const mag = Math.hypot(dx, dz);
    const hasInput = mag > 1e-3;
    const inX = mag > 1 ? dx / mag : dx;
    const inZ = mag > 1 ? dz / mag : dz;
    const maxSpeed = 1.08;

    if (hasInput) {
      const blend = 1 - Math.exp(-9 * safeDt);
      this.rollingVelX += (inX * maxSpeed - this.rollingVelX) * blend;
      this.rollingVelZ += (inZ * maxSpeed - this.rollingVelZ) * blend;
    } else {
      const drag = Math.exp(-7.5 * safeDt);
      this.rollingVelX *= drag;
      this.rollingVelZ *= drag;
      if (Math.hypot(this.rollingVelX, this.rollingVelZ) < 0.004) {
        this.rollingVelX = 0;
        this.rollingVelZ = 0;
      }
    }

    const stepX = this.rollingVelX * safeDt;
    const stepZ = this.rollingVelZ * safeDt;
    let actualDx = 0;
    let actualDz = 0;
    if (Math.abs(stepX) > 1e-6 || Math.abs(stepZ) > 1e-6) {
      const canOccupy = (tx: number, tz: number): boolean => {
        if (canRoll && !canRoll(tx, tz)) return false;
        return Math.abs(this.floorY(tx, tz) - s.floorY) <= 0.12;
      };
      if (canOccupy(s.pos.x + stepX, s.pos.z + stepZ)) {
        actualDx = stepX;
        actualDz = stepZ;
      } else if (Math.abs(stepX) > 1e-6 && canOccupy(s.pos.x + stepX, s.pos.z)) {
        actualDx = stepX;
        this.rollingVelZ = 0;
      } else if (Math.abs(stepZ) > 1e-6 && canOccupy(s.pos.x, s.pos.z + stepZ)) {
        actualDz = stepZ;
        this.rollingVelX = 0;
      } else {
        this.rollingVelX = 0;
        this.rollingVelZ = 0;
      }
    }

    if (actualDx !== 0 || actualDz !== 0) {
      s.pos.x += actualDx;
      s.pos.z += actualDz;
      s.approach.x += actualDx;
      s.approach.z += actualDz;
      if (s.from) {
        s.from.x += actualDx;
        s.from.z += actualDz;
      }
      this.root.position.x = s.pos.x;
      this.root.position.z = s.pos.z;
    }

    let yawStep = 0;
    if (Number.isFinite(targetYaw)) {
      const diffYaw = Math.atan2(Math.sin(targetYaw - s.rotY), Math.cos(targetYaw - s.rotY));
      if (hasInput || Math.hypot(actualDx, actualDz) > 1e-5 || Math.abs(diffYaw) > 0.22) {
        const maxYawStep = 3.6 * safeDt;
        yawStep = T.MathUtils.clamp(diffYaw * (1 - Math.exp(-10 * safeDt)), -maxYawStep, maxYawStep);
        if (Math.abs(yawStep) > 1e-6) {
          const relX = s.approach.x - s.pos.x;
          const relZ = s.approach.z - s.pos.z;
          const c = Math.cos(yawStep);
          const sn = Math.sin(yawStep);
          s.approach.x = s.pos.x + relX * c + relZ * sn;
          s.approach.z = s.pos.z - relX * sn + relZ * c;
          s.rotY = Math.atan2(Math.sin(s.rotY + yawStep), Math.cos(s.rotY + yawStep));
          this.root.rotation.y = s.rotY;
        }
      }
    }

    this.rollingSpeedNow = Math.hypot(actualDx, actualDz) / safeDt;
    if (this.rollingSpeedNow > 0.02) {
      this.rollingScootPhase = (this.rollingScootPhase + safeDt * (1.6 + this.rollingSpeedNow * 2.1)) % (Math.PI * 2);
    }
    if (this.elapsed - s.started >= 0.45) {
      this.body.settled();
    }
    const moving = this.rollingSpeedNow > 0.015 || Math.abs(yawStep) > 1e-4;
    if (moving || hasInput) {
      s.contacts.onChairPoseChange?.(s.pos, s.rotY, moving);
      this.onRollingChairPoseChange?.(s.key, s.pos, s.rotY, moving);
    }
    return true;
  }

  /** Manual exploration uses the same rig/mixer and the existing get-up transition. */
  driveReady() {
    // A seated body only gets up when asked: pressing a movement key never does it by accident.
    if (!this.ready || this.rising || this.seat || this.body.occupied || this.motion) return false;
    if (this.walkTo && this.body.state === 'approaching') this.body.reset();
    this.walkTo = null;
    return true;
  }
  /** Room constraints inspect the complete carried shape before the root or camera moves. */
  motionFraction: ((from: T.Vector3, to: T.Vector3, turn: number) => number) | null = null;
  /**
   * The floor under a point beyond the study room (Echo Life: the house's floors, its stair, the street), stage metres.
   * Null, or no hook: the room's own floor, y = 0, exactly as before.
   */
  groundAt: ((x: number, z: number) => number | null) | null = null;
  floorY(x: number, z: number) { return this.groundAt?.(x, z) ?? 0; }
  moveRoot(pos: T.Vector3, yaw = this.root.rotation.y) {
    const turn = Math.atan2(Math.sin(yaw - this.root.rotation.y), Math.cos(yaw - this.root.rotation.y));
    const accepted = this.motionFraction?.(this.root.position, pos, turn) ?? 1;
    const fraction = Number.isFinite(accepted) ? T.MathUtils.clamp(accepted, 0, 1) : 0;
    this.root.position.lerp(pos, fraction);
    this.root.rotation.y += turn * fraction;
    return fraction;
  }
  private stillFor = 0;
  private turnStillFor = 0;
  private gaitHeld = false;
  /** `drive` ran since the last `update`. */
  private drove = false;
  /** Active vehicle posture on this same HumanRig: bicycle pedaling or 4-wheel car driving (never plays Walk on wheels). */
  private vehicleMode: 'none' | 'bike' | 'motorbike' | 'car' = 'none';
  private vehicleSpeed = 0;
  private vehicleSteer = 0;
  private vehicleModelId = '';
  get vehicle() { return this.vehicleMode; }
  /** Standing rest pelvis height in stage metres (consumed by `getActivePlayerRiderBinding`). */
  get hipRestHeight() { return this.hipRest; }
  get publicPosture(): 'seated'|'mounted'|'airborne'|undefined {
    if (this.vehicleMode!=='none') return 'mounted';
    if (this.airborne) return 'airborne';
    if (this.posture==='seated' || this.posture==='lowering') return 'seated';
    return undefined;
  }
  setVehiclePose(mode: 'none' | 'bike' | 'motorbike' | 'car', speed = 0, steer = 0, vehicleModel?: string) {
    const prev = this.vehicleMode;
    this.vehicleMode = mode;
    this.vehicleSpeed = speed;
    this.vehicleSteer = steer;
    this.vehicleModelId = vehicleModel ?? '';
    if (prev === 'none' && mode !== 'none') {
      this.cancelEmbodiedSession(false);
      this.expression = null;
      this.clipOneShotLeft = 0;
      this.sportMode = 'none';
      this.sportBallWorld = null;
      this.sportShootLeft = 0;
      this.releaseSportContacts();
      this.rig?.stopGesture();
      this.rig?.clearTransientContacts(!this.isHoldingRoomProp());
      this.activity = 'idle';
      this.mood = 'neutral';
    } else if (prev !== 'none' && mode === 'none') {
      this.root.rotation.x = 0;
      this.root.rotation.z = 0;
      if (this.model) {
        this.model.position.set(0, 0, 0);
        this.model.rotation.set(0, 0, 0);
      }
      this.expression = null;
      this.rig?.stopGesture();
      this.rig?.resetFootDynamics();
      this.rig?.clearTransientContacts(!this.isHoldingRoomProp());
      this.activity = 'idle';
      this.mood = 'neutral';
      if (this.ready) {
        this.play('Idle', .22);
        this.deadBlend?.seedFromCurrent();
      }
    }
  }
  /** Returns the player's live `hand.R` position in stage-local coordinates (for closed-loop basketball coupling). */
  handRightStagePosition(out = new T.Vector3()): T.Vector3 | null {
    const hand = this.bones.get('hand.R');
    if (!hand) return null;
    hand.getWorldPosition(out);
    if (this.root.parent) this.root.parent.worldToLocal(out);
    return out;
  }
  private releaseSportContacts() {
    if (!this.sportContactOwned || !this.rig) return;
    this.sportContactOwned = false;
    if (!this.rig.contactOn(1)?.on) this.rig.setContact(1, null, 0.12, 0.18);
    if (!this.rig.contactOn(-1)?.on) this.rig.setContact(-1, null, 0.12, 0.18);
  }
  /** Closed-loop `hand.R` (and left guide hand during aim) basketball contact IK aligned to live ball coordinates. */
  private applySportHandIk(mode: 'dribble' | 'aim') {
    const rig = this.rig;
    const stage = this.root.parent;
    if (!rig || !stage) return;
    if (rig.contactOn(1)?.on || rig.contactOn(-1)?.on) return;

    const yaw = this.root.rotation.y;
    const fwdX = Math.sin(yaw);
    const fwdZ = Math.cos(yaw);
    const rightX = -Math.cos(yaw);
    const rightZ = Math.sin(yaw);
    const floor = this.floorY(this.root.position.x, this.root.position.z);
    const phase01 = (((this.sportPhase % 1) + 1) % 1);
    const bounce = Math.sin(phase01 * Math.PI);

    // Resolve ball stage position (live ballWorld if supplied, else exact right-side pocket formula)
    const ballStage = new T.Vector3();
    if (this.sportBallWorld) {
      ballStage.set(this.sportBallWorld.x, this.sportBallWorld.y, this.sportBallWorld.z);
    } else if (mode === 'aim') {
      ballStage.set(this.root.position.x + 0.42 * fwdX + 0.04 * rightX, floor + 1.48, this.root.position.z + 0.42 * fwdZ + 0.04 * rightZ);
    } else {
      ballStage.set(
        this.root.position.x + 0.40 * fwdX + 0.38 * rightX,
        floor + 0.1217 + bounce * 0.76,
        this.root.position.z + 0.40 * fwdZ + 0.38 * rightZ,
      );
    }

    const fwdWorld = new T.Vector3(fwdX, 0, fwdZ);
    const rightWorld = new T.Vector3(rightX, 0, rightZ);
    if (mode === 'dribble') {
      // Cushion and push the top of the ball through the upper dribble arc (`bounce > 0.35`)
      const wristStage = ballStage.clone().setY(Math.max(floor + 0.58, ballStage.y + 0.145));
      const wristWorld = stage.localToWorld(wristStage);
      rig.setContact(
        1,
        {
          wrist: wristWorld,
          fingers: fwdWorld.clone().addScaledVector(rightWorld, 0.18).setY(-0.22).normalize(),
          palm: new T.Vector3(0, -1, 0),
          grip: 'relaxed',
          bend: { pitch: 0.08, drop: 0.04 },
        },
        0.09,
        0.14,
      );
      if (!rig.contactOn(-1)?.on) rig.setContact(-1, null, 0.12, 0.18);
      this.sportContactOwned = true;
    } else {
      // Dual-hand gather: right palm beneath-rear launch pocket, left guide hand on left hemisphere
      const rStage = ballStage.clone().addScaledVector(rightWorld, 0.06).addScaledVector(fwdWorld, -0.06);
      rStage.y -= 0.07;
      const lStage = ballStage.clone().addScaledVector(rightWorld, -0.12);
      rig.setContact(
        1,
        {
          wrist: stage.localToWorld(rStage),
          fingers: new T.Vector3(fwdX * 0.35, 0.92, fwdZ * 0.35).normalize(),
          palm: new T.Vector3(fwdX * 0.3, 0.95, fwdZ * 0.3).normalize(),
          grip: 'relaxed',
          bend: { pitch: 0.04, drop: 0.02 },
        },
        0.12,
        0.18,
      );
      rig.setContact(
        -1,
        {
          wrist: stage.localToWorld(lStage),
          fingers: new T.Vector3(fwdX * 0.4, 0.9, fwdZ * 0.4).normalize(),
          palm: rightWorld.clone(),
          grip: 'relaxed',
          support: true,
        },
        0.12,
        0.18,
      );
      this.sportContactOwned = true;
    }
  }
  /** Drives basketball pose cues (`dribble` / `aim` / `shoot`) on the same skeleton alongside locomotion and hand IK. */
  setSportPose(
    mode: 'none' | 'dribble' | 'aim' | 'shoot',
    dribblePhase = 0,
    ballWorld?: { x: number; y: number; z: number } | null,
  ) {
    const prev = this.sportMode;
    this.sportMode = mode;
    this.sportPhase = dribblePhase;
    this.sportBallWorld = ballWorld ?? null;
    if (!this.ready || this.vehicleMode !== 'none' || this.seat || this.motion) {
      this.releaseSportContacts();
      return;
    }
    if (mode === 'shoot') {
      this.releaseSportContacts();
      const clipName = this.actions.has('Sport_Basketball_Shoot') ? 'Sport_Basketball_Shoot' : 'shoot';
      const act = this.actions.get(clipName);
      if (act) {
        act.setLoop(T.LoopOnce, 1);
        act.clampWhenFinished = true;
        this.sportShootLeft = Math.max(0.75, act.getClip().duration);
        this.play(clipName, 0.14);
        this.mood = 'focus';
      }
      return;
    }
    if (prev !== 'none' && mode === 'none') {
      this.sportShootLeft = 0;
      this.releaseSportContacts();
      if (['dribble', 'aim', 'shoot', 'Sport_Basketball_Shoot'].includes(this.currentName)) {
        this.play('Idle', 0.25);
        this.mood = moodOf(this.activity);
      }
    }
  }
  /** Plays a retargeted 48-clip activity pose (`Talk_Gesture`, `Listen_Nod`, `Eat_Seated`, `Drink_Cup`, etc.). */
  playClipActivity(name: string, fade = 0.28, oneShot = false): boolean {
    if (!this.ready || this.motion || this.vehicleMode !== 'none') return false;
    const lower = name.toLowerCase();
    let matched: string | null = null;
    if (this.actions.has(name)) matched = name;
    else {
      for (const k of this.actions.keys()) {
        if (k.toLowerCase() === lower) { matched = k; break; }
      }
    }
    if (!matched) return false;
    const act = this.actions.get(matched)!;
    if (oneShot) {
      act.setLoop(T.LoopOnce, 1);
      act.clampWhenFinished = true;
      this.clipOneShotLeft = Math.max(0.3, act.getClip().duration);
    } else {
      act.setLoop(T.LoopRepeat, Infinity);
      act.clampWhenFinished = false;
      this.clipOneShotLeft = 0;
    }
    this.play(matched, fade);
    return true;
  }
  /** Updates dialogue look-at target, speaking lip-sync, and conversational facial mood on the player cast. */
  setDialogueState(active: boolean, speaking = false, lookTargetWorld: T.Vector3 | null = null) {
    this.dialogueActive = active;
    this.dialogueSpeaking = active && speaking;
    this.dialogueLookTarget = active && lookTargetWorld ? lookTargetWorld.clone() : null;
    if (active) this.mood = speaking ? 'smile' : 'listen';
    else if (!this.expression) this.mood = moodOf(this.activity);
  }

  private stepLocomotionBlendSpace(
    rawSpeed: number,
    along: number,
    backward: boolean,
    stairFactor: number,
    yawTurnRad: number,
    dt: number,
  ) {
    const safeDt = Math.max(dt, 0.001);
    const wasBlending = this.locomotionBlendActive;
    const hasBrisk = this.actions.has('Walk_Brisk');
    const hasSprint = this.actions.has('Sprint');
    this.locomotionSpeed = !wasBlending
      ? rawSpeed
      : this.locomotionSpeed + (rawSpeed - this.locomotionSpeed) * (1 - Math.exp(-16 * safeDt));
    this.schmittBand = stepSchmittLocomotionBand(this.schmittBand, this.locomotionSpeed, {
      hasBrisk,
      hasSprint,
    });

    if (!wasBlending) {
      this.deadBlend?.triggerTransition(0.15, 0.055);
      for (const [clipKey, act] of this.actions) {
        if (act.isRunning() && !LOCO_POOL.includes(clipKey as (typeof LOCO_POOL)[number])) {
          act.stopFading();
          act.stop();
          act.setEffectiveWeight(0);
        }
      }
      if (!this.gaitHeld) {
        this.masterPhase = wrap01((this.gaitLift.Walk ?? 0.5) - (this.leftFootForward.Walk ?? 0));
      }
      this.locomotionBlendActive = true;
    }

    const v = this.locomotionSpeed;
    const uMove = T.MathUtils.smoothstep(v, 0.03, 0.40);
    const wIdle = 1 - uMove;
    let wWalk = 0;
    let wBrisk = 0;
    let wRun = 0;
    let wSprint = 0;

    if (hasBrisk) {
      if (v <= 1.30) {
        wWalk = uMove;
      } else if (v < 1.88) {
        const u = T.MathUtils.smoothstep(v, 1.30, 1.88);
        wWalk = uMove * (1 - u);
        wBrisk = uMove * u;
      } else if (v <= 2.10) {
        wBrisk = uMove;
      } else if (v < 2.85) {
        const u = T.MathUtils.smoothstep(v, 2.10, 2.85);
        wBrisk = uMove * (1 - u);
        wRun = uMove * u;
      } else if (!hasSprint || v <= 4.10) {
        wRun = uMove;
      } else {
        const u = T.MathUtils.smoothstep(v, 4.10, 5.30);
        wRun = uMove * (1 - u);
        wSprint = uMove * u;
      }
    } else {
      if (v <= 1.65) {
        wWalk = uMove;
      } else if (v < 2.75) {
        const u = T.MathUtils.smoothstep(v, 1.65, 2.75);
        wWalk = uMove * (1 - u);
        wRun = uMove * u;
      } else if (!hasSprint || v <= 4.10) {
        wRun = uMove;
      } else {
        const u = T.MathUtils.smoothstep(v, 4.10, 5.30);
        wRun = uMove * (1 - u);
        wSprint = uMove * u;
      }
    }

    const walkAct = this.actions.get('Walk');
    const briskAct = this.actions.get('Walk_Brisk');
    const runAct = this.actions.get('Run');
    const sprintAct = this.actions.get('Sprint');

    const sModel = this.modelScaleNow;
    const walkStride = (this.gaitDrawn.Walk ?? 0.91354) * sModel * (walkAct?.getClip().duration ?? 1.0);
    const briskStride = this.briskDrawn * this.legRatioNow * sModel * (briskAct?.getClip().duration ?? 0.88);
    const runStride = (this.gaitDrawn.Run ?? 2.04482) * sModel * (runAct?.getClip().duration ?? 0.72);
    const sprintStride = this.sprintDrawn * sModel * (sprintAct?.getClip().duration ?? 0.62);
    const gaitWeightSum = Math.max(1e-5, wWalk + wBrisk + wRun + wSprint);
    const effStride = (wWalk * walkStride + wBrisk * briskStride + wRun * runStride + wSprint * sprintStride) / gaitWeightSum;
    const vAlong = rawSpeed / Math.max(0.4, along);
    const cycleHz = T.MathUtils.clamp(vAlong / Math.max(0.28, effStride), 0.35, 2.65) * stairFactor;
    this.masterPhase = wrap01(this.masterPhase + (backward ? -1 : 1) * cycleHz * safeDt);

    const weights: Array<[string, number]> = [
      ['Idle', wIdle],
      ['Walk', wWalk],
      ['Walk_Brisk', wBrisk],
      ['Run', wRun],
      ['Sprint', wSprint],
    ];
    for (const [clipName, w] of weights) {
      const act = this.actions.get(clipName);
      if (!act) continue;
      if (w > 1e-4) {
        act.stopFading();
        if (!act.isRunning()) act.reset().play();
        act.enabled = true;
        act.setEffectiveWeight(w);
        if (clipName === 'Idle') {
          act.timeScale = 1;
        } else {
          act.timeScale = 0;
          const dur = act.getClip().duration;
          const lead = this.leftFootForward[clipName] ?? 0;
          act.time = wrap01(this.masterPhase + lead) * dur;
        }
      } else if (act.isRunning() || act.getEffectiveWeight() > 0) {
        act.stopFading();
        act.stop();
        act.setEffectiveWeight(0);
      }
    }

    const dominant =
      wSprint >= 0.5 ? 'Sprint'
      : wRun + wSprint >= 0.48 ? 'Run'
      : wBrisk >= 0.55 ? 'Walk_Brisk'
      : 'Walk';
    this.currentName = dominant;
    this.current = this.actions.get(dominant) ?? walkAct ?? null;

    const rawYawRate = yawTurnRad / Math.max(safeDt, 0.004);
    this.filteredYawRate = stepFilteredYawRate(this.filteredYawRate, rawYawRate, safeDt);
    if (this.bodyLeanDelegatedToRig) {
      this.leanRoll = 0;
      this.leanPitch = 0;
    } else {
      const targetRoll = backward ? 0 : computeTargetBankRoll(v, applyYawRateDeadzone(this.filteredYawRate));
      const accelPitch = backward ? -0.02 : T.MathUtils.smoothstep(v, 1.8, 5.2) * 0.055;
      const targetPitch = accelPitch + this.stairPitch;
      const kLean = 1 - Math.exp(-9 * safeDt);
      this.leanRoll += (targetRoll - this.leanRoll) * kLean;
      this.leanPitch += (targetPitch - this.leanPitch) * kLean;
    }
  }

  drive(pos: T.Vector3, moving: boolean, dt: number, face?: number) {
    if (!this.driveReady()) return;
    if (moving && this.embodiedSession) {
      this.cancelEmbodiedSession(false);
    }
    const safeDt = Math.max(dt, 0.001);
    const delta = this.driveDeltaScratch.copy(pos).sub(this.root.position).setY(0);
    const reqMoveSq = delta.lengthSq();
    const reqSpeed = Math.sqrt(reqMoveSq) / safeDt;
    const from = this.driveFromScratch.copy(this.root.position);
    const yawBefore = this.root.rotation.y;
    const yaw = moving && reqMoveSq > 1e-8 ? face ?? Math.atan2(delta.x, delta.z) : yawBefore;
    let diff = Math.atan2(Math.sin(yaw - yawBefore), Math.cos(yaw - yawBefore));
    if (face === undefined && moving && reqSpeed > 0.12) {
      if (Math.abs(diff) > 0.35 && Math.abs(diff) < 2.75) {
        this.lastSharpTurnSign = diff >= 0 ? 1 : -1;
      } else if (Math.abs(diff) >= 2.75) {
        diff = Math.abs(diff) * this.lastSharpTurnSign;
      }
    }
    const floor = this.floorY(pos.x, pos.z);
    // Honor caller `pos.y` (`Exploration`'s 60 Hz critically damped `elevationSpring`) when within 0.55 m of `floor` (`E5-02`).
    const dyFloor = floor - this.root.position.y;
    const onStair = !this.airborne && this.vehicleMode === 'none' && Math.abs(dyFloor) > .012 && Math.abs(dyFloor) < .55;
    const groundedY = Number.isFinite(pos.y) && Math.abs(pos.y - floor) <= 0.55 ? pos.y : floor;
    const target = this.driveTargetScratch.copy(pos).setY(this.airborne ? Math.max(this.root.position.y, floor) : groundedY);
    let turn: number;
    if (face === undefined) {
      // Velocity-scaled responsive 3rd-person root turn (`16–22 rad/s` cap) so rapid direction changes never lag with twisted hips.
      const speedT = T.MathUtils.smoothstep(reqSpeed, 0.6, 2.8);
      const maxTurnRate = T.MathUtils.lerp(16.0, 22.0, speedT);
      const propGain = T.MathUtils.lerp(15.0, 21.0, speedT);
      const rawTurn = diff * (1 - Math.exp(-propGain * safeDt));
      const sharpAssist = Math.abs(diff) > 0.65 ? Math.sign(diff) * Math.min(Math.abs(diff) * 0.65, maxTurnRate * safeDt) : 0;
      const turnMag = Math.min(Math.abs(diff), Math.min(maxTurnRate * safeDt, Math.max(Math.abs(rawTurn), Math.abs(sharpAssist))));
      turn = Math.sign(diff) * turnMag;
    } else {
      const maxTurnStep1P = 20.0 * safeDt;
      turn = T.MathUtils.clamp(diff * (1 - Math.exp(-16 * safeDt)), -maxTurnStep1P, maxTurnStep1P);
    }
    const admitted = this.moveRoot(target, yawBefore + turn);
    // A long prop beside a rack may have room to back away before it can
    // swing around. Test the remaining translation with the same constraints.
    if (moving && admitted < .999 && Math.abs(turn) > .001 && this.root.position.distanceToSquared(target) > 1e-8) this.moveRoot(target);
    const actualYawTurn = Math.atan2(Math.sin(this.root.rotation.y - yawBefore), Math.cos(this.root.rotation.y - yawBefore));
    delta.copy(this.root.position).sub(from).setY(0);
    const actualMoveSq = delta.lengthSq();
    if (this.vehicleMode !== 'none') {
      this.stillFor = 0; this.gaitHeld = false; this.isBackpedaling = false;
      this.smoothedMoveYaw *= Math.exp(-16 * safeDt);
      if (Math.abs(this.smoothedMoveYaw) < 1e-4) this.smoothedMoveYaw = 0;
      this.moveYaw = this.smoothedMoveYaw;
      this.leanRoll *= Math.exp(-10 * safeDt);
      this.leanPitch *= Math.exp(-10 * safeDt);
    } else if (moving && actualMoveSq > 1e-8) {
      this.stillFor = 0; this.gaitHeld = false;
      const speed = Math.sqrt(actualMoveSq) / safeDt;
      // Keep JumpUp / JumpFall playing cleanly while airborne; resume continuous velocity blend space upon landing!
      if (this.airborne || this.jumpPhase === 'takeoff' || this.jumpPhase === 'airborne') {
        this.locomotionSpeed = speed;
      } else {
        if (this.jumpPhase === 'land' && this.jumpLandLeft <= 0.04) this.jumpPhase = 'none';
        this.stairPitch += ((onStair ? (dyFloor > 0 ? .08 : -.045) : 0) - this.stairPitch) * (1 - Math.exp(-10 * safeDt));
        const heading = Math.atan2(delta.x, delta.z);
        const off = Math.atan2(Math.sin(heading - this.root.rotation.y), Math.cos(heading - this.root.rotation.y));
        const yawErr = Math.atan2(Math.sin(yaw - this.root.rotation.y), Math.cos(yaw - this.root.rotation.y));
        // Stationary-only `turningTo` (`speed < 0.12`): NEVER trigger mid-walk/run direction changes (prevents freezing leg stride)!
        const turningTo = face === undefined && speed < 0.12 && reqSpeed < 0.20 && Math.abs(yawErr) > 0.35;
        // Hysteretic `backward` (`enter > 2.25 rad`, `exit < 1.72 rad`) ONLY in 1st-person / locked-face or low-speed backstep!
        const allowBackpedal = this.ownView || face !== undefined || speed < 0.72;
        if (!allowBackpedal || turningTo) {
          this.isBackpedaling = false;
        } else if (this.isBackpedaling) {
          if (Math.abs(off) < 1.72) this.isBackpedaling = false;
        } else if (Math.abs(off) > 2.25) {
          this.isBackpedaling = true;
        }
        const backward = this.isBackpedaling;
        const MAX_MOVE_YAW = 0.68;
        let targetMoveYaw = 0;
        if (!turningTo) {
          if (backward) {
            const backOff = Math.atan2(Math.sin(off + Math.PI), Math.cos(off + Math.PI));
            targetMoveYaw = T.MathUtils.clamp(backOff, -MAX_MOVE_YAW, MAX_MOVE_YAW);
          } else if (face === undefined && !this.ownView) {
            const turnLeadTaper = 1 - T.MathUtils.smoothstep(Math.abs(off), 1.75, 2.85);
            targetMoveYaw = T.MathUtils.clamp(off * 0.65 * turnLeadTaper, -MAX_MOVE_YAW, MAX_MOVE_YAW);
          } else {
            const rearTaper = 1 - T.MathUtils.smoothstep(Math.abs(off), 1.95, 2.55);
            targetMoveYaw = T.MathUtils.clamp(off, -MAX_MOVE_YAW, MAX_MOVE_YAW) * rearTaper;
          }
        }
        const dMoveYaw = Math.atan2(Math.sin(targetMoveYaw - this.smoothedMoveYaw), Math.cos(targetMoveYaw - this.smoothedMoveYaw));
        this.smoothedMoveYaw = T.MathUtils.clamp(
          this.smoothedMoveYaw + dMoveYaw * (1 - Math.exp(-18 * safeDt)),
          -MAX_MOVE_YAW,
          MAX_MOVE_YAW,
        );
        this.moveYaw = this.smoothedMoveYaw;
        const travelRef = backward
          ? Math.atan2(Math.sin(off + Math.PI), Math.cos(off + Math.PI))
          : face === undefined && !this.ownView
            ? this.smoothedMoveYaw
            : off;
        const along = T.MathUtils.clamp(Math.cos(travelRef - this.smoothedMoveYaw), 0.72, 1.0);
        const stairFactor = onStair ? .86 : 1;
        if (this.jumpPhase !== 'land') {
          this.stepLocomotionBlendSpace(speed, along, backward, stairFactor, actualYawTurn, safeDt);
        }
      }
    } else {
      // A body pushing into a wall moves one frame in two or three: switching the clip on each of those restarted the
      // crossfade every few frames (hips jumping 0.3 m). The stride ends after 80 ms without travel, or as soon as nothing
      // drives the body any more (`update`).
      this.stillFor += safeDt;
      this.isBackpedaling = false;
      this.locomotionSpeed *= Math.exp(-12 * safeDt);
      this.filteredYawRate *= Math.exp(-10 * safeDt);
      this.leanRoll *= Math.exp(-10 * safeDt);
      this.leanPitch *= Math.exp(-10 * safeDt);
      if ((this.locomotionBlendActive || LOCO_GAIT_SET.has(this.currentName)) && this.stillFor < .08) {
        this.gaitHeld = true;
      } else {
        this.gaitHeld = false;
        this.schmittBand = 'idle';
        if (!this.airborne && this.jumpPhase === 'none') this.play('Idle', .18);
      }
      this.smoothedMoveYaw *= Math.exp(-16 * safeDt);
      if (Math.abs(this.smoothedMoveYaw) < 1e-4) this.smoothedMoveYaw = 0;
      this.moveYaw = this.smoothedMoveYaw;
    }
    this.drove = true;
    this.activity = 'idle';
  }
  /** The legs' phase in the gait being played; null when the body is not walking or running. */
  stridePhase(): number | null {
    if (this.locomotionBlendActive) {
      return this.masterPhase * Math.PI * 2 + Math.PI / 2;
    }
    if (!LOCO_GAIT_SET.has(this.currentName)) return null;
    const action = this.actions.get(this.currentName);
    if (!action) return null;
    return (action.time / action.getClip().duration - (this.leftFootForward[this.currentName] ?? 0)) * Math.PI * 2 + Math.PI / 2;
  }
  private leftFootForward: Record<string, number> = {};
  /** Travel speed each corrected gait is drawn for, model units a second (`correctGaits`). */
  private gaitDrawn: Partial<Record<'Walk' | 'Run', number>> = {};
  /** QA: what the gait correction measured on this cast. */
  gaitReports: object = {};
  private gaitLift: Record<string, number> = {};
  /**
   * Standing still the head turns first: the neck and chest take up to about 50 degrees (`lookYaw`), and only past that do
   * the feet step round. In 1st-person (`tightFirstPerson = true`), uses a tighter `0.22 rad` threshold and `0.42 rad` max
   * torso lag clamp so shoulders/collars/coats never intrude into the 1st-person view frustum.
   */
  faceToward(yaw: number, dt: number, tightFirstPerson = false) {
    if (!this.ready || this.seat || this.rising || this.walkTo || this.motion) return;
    if (this.vehicleMode !== 'none') {
      const diff = Math.atan2(Math.sin(yaw - this.root.rotation.y), Math.cos(yaw - this.root.rotation.y));
      this.moveRoot(this.root.position, this.root.rotation.y + diff * (1 - Math.exp(-8 * dt)));
      return;
    }
    const diff = Math.atan2(Math.sin(yaw - this.root.rotation.y), Math.cos(yaw - this.root.rotation.y));
    const startThresh = this.workingBody ? 0.015 : tightFirstPerson ? 0.22 : 0.85;
    const holdThresh = this.workingBody ? 0.015 : tightFirstPerson ? 0.035 : 0.08;
    const wants = Math.abs(diff) > (this.turning ? holdThresh : startThresh);
    this.turning = wants ? 1 : 0;
    if (wants) {
      const rate = tightFirstPerson ? 15 : 5.5;
      const effDt = Math.max(dt, 1 / 120);
      const wanted = diff * (1 - Math.exp(-rate * effDt));
      const step = wanted * this.moveRoot(this.root.position, this.root.rotation.y + wanted);
      if (tightFirstPerson) {
        const residual = Math.atan2(Math.sin(yaw - this.root.rotation.y), Math.cos(yaw - this.root.rotation.y));
        if (Math.abs(residual) > 0.42) {
          const snap = residual - Math.sign(residual) * 0.42;
          this.moveRoot(this.root.position, this.root.rotation.y + snap);
        }
      }
      this.turnStillFor = Math.abs(step) > 1e-6 ? 0 : this.turnStillFor + dt;
      if (!tightFirstPerson && Math.abs(step) > 1e-6) this.play('Walk', .22, true);
      else if (this.turnStillFor >= .08) this.play('Idle', .22, true);
      const walk = this.actions.get('Walk');
      if (walk && this.currentName === 'Walk') walk.timeScale = stepWhileTurning(step / Math.max(dt, .001));
    } else {
      this.turnStillFor = 0;
      if (this.currentName === 'Walk') this.play('Idle', .3, true);
    }
    this.isBackpedaling = false;
    this.smoothedMoveYaw *= Math.exp(-16 * Math.max(0, dt));
    if (Math.abs(this.smoothedMoveYaw) < 1e-4) this.smoothedMoveYaw = 0;
    this.moveYaw = this.smoothedMoveYaw;
  }
  /**
   * The eyes in the stage's space, from the root and the measured poses: steady while a clip moves the head. The two
   * weights ease, so sitting down and getting up carry the view instead of cutting it.
   */
  eyePoint(out: T.Vector3, crouch = 0) {
    const e = this.eyes, stand = Math.max(0, 1 - this.eyeSit - this.eyeLie);
    out.copy(e.stand).multiplyScalar(stand).addScaledVector(e.sit, this.eyeSit).addScaledVector(e.lie, this.eyeLie);
    out.applyAxisAngle(new T.Vector3(0, 1, 0), this.root.rotation.y).add(this.root.position);
    out.y += this.motionEye + this.seatPelvisDropY - CROUCH.eye * crouch;
    if (this.model) out.y += this.model.position.y;
    return out;
  }

  /**
   * Zero-alloc anatomical 1st-person eye position in stage coordinates:
   * - While seated, rising, performing floor motion, or mounted on a vehicle, reads the live post-IK `eye.L`/`eye.R`
   *   bridge-of-nose midpoint (+3.5 cm anterior corneal offset) so 1P camera rides seated/vehicle posture accurately.
   * - While standing or moving on foot, places the eye at the anterior corneal plane (`>= 9.8 cm` forward of spine axis)
   *   without gait head-bob, eliminating rear-neck, collar, and coat clipping in 1st-person view.
   */
  anatomicalEyeStagePoint(out: T.Vector3, crouch = 0): T.Vector3 {
    const stage = this.root.parent;
    if (this.seat || this.rising || this.motion || this.vehicleMode !== 'none') {
      const eyeL = this.bones.get('eye.L');
      const eyeR = this.bones.get('eye.R');
      const head = this.bones.get('head');
      if (eyeL && eyeR && head) {
        this.model?.updateWorldMatrix(true, true);
        eyeL.getWorldPosition(this.eyeWorldScratchA);
        eyeR.getWorldPosition(this.eyeWorldScratchB);
        out.copy(this.eyeWorldScratchA).add(this.eyeWorldScratchB).multiplyScalar(0.5);
        head.getWorldQuaternion(this.headQuatScratch);
        this.eyeWorldScratchA.set(0, 0, 0.035 * this.heightScaleNow).applyQuaternion(this.headQuatScratch);
        out.add(this.eyeWorldScratchA);
        if (stage) stage.worldToLocal(out);
        return out;
      }
      return this.eyePoint(out, crouch);
    }
    const yaw = this.root.rotation.y;
    const antFwd =
      Math.max(0.098, (this.eyes.stand.z || 0.06) + 0.038) * this.heightScaleNow +
      0.055 * crouch * this.heightScaleNow;
    out.set(
      this.root.position.x + Math.sin(yaw) * antFwd,
      this.root.position.y + this.eyes.stand.y - CROUCH.eye * crouch + this.motionEye + (this.model?.position.y ?? 0),
      this.root.position.z + Math.cos(yaw) * antFwd,
    );
    return out;
  }
  /** How far the neck turns from this posture. Null while standing: the whole body turns then. */
  lookFrame(): LookFrame | null {
    if (this.motion?.settled && !this.motion.rising) return { yaw: this.root.rotation.y + Math.PI, yawRange: 1.3, pitchMin: -.75, pitchMax: .95, pitch: 0 };
    const seat = this.seat;
    if (!seat) return null;
    const yaw = seat.rotY + Math.PI;
    return seat.lie
      ? { yaw, yawRange: 1.25, pitchMin: -.62, pitchMax: 1.42, pitch: .34 }
      : { yaw, yawRange: 1.95, pitchMin: -1.32, pitchMax: .98, pitch: -.26 };
  }
  /** First person: the owner's own head and rig arms are not drawn; the torso and legs stay, seen by looking down. */
  /** Through its own eyes the face and hair are not drawn (their shadow stays). Applied at once: a picture taken right after sees the whole body. */
  setOwnView(on: boolean) { this.ownView = on; this.wardrobe?.setOwnView(on); this.look?.setOwnView(on); }
  /** The feet turn the body to what its hand is going to. */
  turnBody(yaw: number, dt: number) {
    if (!this.ready || this.seat || this.rising || this.walkTo || this.motion) return;
    const diff = Math.atan2(Math.sin(yaw - this.root.rotation.y), Math.cos(yaw - this.root.rotation.y));
    this.moveRoot(this.root.position, this.root.rotation.y + diff * (1 - Math.exp(-7 * dt)));
  }
  /** Updates outdoor weather wind vector coupled into Lyra/Kai's 6-chain XPBD hair and scarf solver. */
  setSecondaryWind(x: number, z: number, gust = 0.35): void {
    this.secondaryWind.x = Number.isFinite(x) ? x : 0;
    this.secondaryWind.z = Number.isFinite(z) ? z : 0;
    this.secondaryWind.gust = Number.isFinite(gust) ? gust : 0.35;
  }

  /** Single-authority world-to-character conversational gaze angles (`RC-A4.3`). */
  dialogueLookAngles(out = { yaw: 0, pitch: 0 }): { yaw: number; pitch: number } | null {
    if (!this.dialogueActive || !this.dialogueLookTarget || (this.ownView && !this.mirrorObserved)) return null;
    const head = this.bones.get('head');
    if (!head) return null;
    const hp = head.getWorldPosition(this.leanFwdScratch);
    const dx = this.dialogueLookTarget.x - hp.x;
    const dy = this.dialogueLookTarget.y - hp.y;
    const dz = this.dialogueLookTarget.z - hp.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist <= 0.15) return null;
    const invD = 1 / dist;
    const tx = dx * invD;
    const ty = dy * invD;
    const tz = dz * invD;
    const fwdX = Math.sin(this.root.rotation.y);
    const fwdZ = Math.cos(this.root.rotation.y);
    const rightX = fwdZ;
    const rightZ = -fwdX;
    out.yaw = T.MathUtils.clamp(Math.atan2(tx * rightX + tz * rightZ, tx * fwdX + tz * fwdZ), -0.9, 0.9);
    out.pitch = T.MathUtils.clamp(Math.asin(T.MathUtils.clamp(ty, -1, 1)), -0.35, 0.35);
    return out;
  }

  private readonly dialogueAnglesScratch = { yaw: 0, pitch: 0 };
  private lastWallDt = 0;

  private runPostIkPass(dt: number, reduced: boolean, wallDt = this.lastWallDt) {
    if (!this.model) return;
    this.model.updateWorldMatrix(true, true);
    const dlg = this.dialogueLookAngles(this.dialogueAnglesScratch);
    const studioLive = this.isStudioPoseActive || this.expressionOverride !== null;
    this.look?.update({
      dt,
      liveDt: studioLive && wallDt > 0 ? wallDt : undefined,
      reduced,
      mood: this.expressionOverride ?? this.mood,
      speaking: this.dialogueSpeaking || this.studioSpeaking,
      lookYaw: dlg ? dlg.yaw : 0,
      lookPitch: dlg ? dlg.pitch : 0,
    });
    if (this.secondary && (!this.ownView || this.mirrorObserved)) {
      if (this.studioSettlePending && dt <= 1e-6) {
        this.studioSettlePending = false;
        const secWithSettle = this.secondary as SecondaryPhysics & {
          settleImmediate?: (steps?: number, stepDt?: number) => void;
        };
        if (typeof secWithSettle.settleImmediate === 'function') {
          secWithSettle.settleImmediate(12, 1 / 60);
        } else {
          for (let i = 0; i < 12; i++) {
            this.secondary.update(1 / 60, false, this.secondaryWind, 0);
          }
        }
      } else if (dt > 1e-6) {
        this.studioSettlePending = false;
        this.secondary.update(dt, reduced, this.secondaryWind, 0);
      } else if (studioLive && this.blendRemaining > 0 && wallDt > 0) {
        this.secondary.update(wallDt, reduced, this.secondaryWind, 0);
      }
    }
  }

  /**
   * Dedicated post-IK secondary simulation and facial gaze update (`RC-A4` / `E5-06` fix):
   * call from `engine.ts` AFTER `HumanRig.update()` and `manip.afterBody()` so XPBD hair/scarf
   * colliders and eye gaze solve against the exact final IK-posed skeleton with `0` raw limb overwrites.
   */
  updatePostIk(dt = this.frame.dt, reduced = this.frame.reduced, wallDt?: number): void {
    if (!this.ready || !this.model) return;
    this.deferPostIk = true;
    if (wallDt !== undefined && Number.isFinite(wallDt)) {
      this.lastWallDt = Math.max(0, Math.min(0.05, wallDt));
    }
    if (this.postIkRanThisFrame) {
      this.secondary?.restore();
    }
    this.runPostIkPass(dt, reduced, this.lastWallDt);
    this.postIkRanThisFrame = true;
  }

  /** After every mixer pass, whichever way this frame went: visibility flags, plus fallback post-IK when `deferPostIk` is false. */
  private applyOwnView() {
    this.look?.setOwnView(this.ownView);
    // Hide worn backpack cleanly while seated on chairs/benches (Bug #07)
    this.wardrobe?.setBackpackHiddenForSeat(!!this.seat || this.vehicleMode === 'car');
    if (!this.deferPostIk) {
      this.runPostIkPass(this.frame.dt, this.frame.reduced, this.lastWallDt);
      this.postIkRanThisFrame = true;
    }
  }
  /** The way the body faces, in world space. */
  bodyForward(out: T.Vector3) { return out.set(Math.sin(this.root.rotation.y), 0, Math.cos(this.root.rotation.y)); }
  /** Where the hands rest in this posture, on the real furniture or the body. Null while standing or turning into a seat. */
  restHands(): { left: RestHand; right: RestHand } | null {
    const seat = this.seat, stage = this.root.parent;
    if (!seat || !stage || this.rising) return null;
    if (!seat.lie) {
      const sitSeconds = this.frame.reduced ? .01 : 0.84;
      const sitProgress = T.MathUtils.clamp((this.elapsed - seat.started) / sitSeconds, 0, 1);
      const yawAlign = Math.cos(this.root.rotation.y - seat.rotY);
      if (sitProgress < 0.48 || yawAlign < 0.55) return null;
    }
    const scale = stage.getWorldScale(new T.Vector3()).x;
    const forward = new T.Vector3(Math.sin(seat.rotY), 0, Math.cos(seat.rotY)), left = new T.Vector3(Math.cos(seat.rotY), 0, -Math.sin(seat.rotY)), up = new T.Vector3(0, 1, 0);
    const hand = (side: number): RestHand => {
      // `side` +1 is the character's left.
      if (seat.lie) {
        const chest = this.bones.get('chest')!.getWorldPosition(new T.Vector3()), hips = this.bones.get('hips')!.getWorldPosition(new T.Vector3());
        const belly = chest.lerp(hips, .62).addScaledVector(up, .135 * scale).addScaledVector(left, side * .135 * scale);
        return { wrist: belly, fingers: forward.clone().multiplyScalar(.86).addScaledVector(left, -side * .5), palm: up.clone().multiplyScalar(-1).addScaledVector(left, -side * .1), curl: .3, grip: 'relaxed' as const };
      }
      // On the desk only if the desk is really within anatomical reach of this seat; otherwise on validated armrest or lap.
      const work = seat.contacts.work;
      const rawDeskH = seat.contacts.deskHeight;
      const validDeskH =
        rawDeskH !== undefined &&
        Number.isFinite(rawDeskH) &&
        rawDeskH >= seat.top + 0.12 &&
        rawDeskH <= seat.top + 0.42
          ? rawDeskH
          : undefined;
      const working =
        !!work &&
        validDeskH !== undefined &&
        work.z >= 0.12 &&
        work.z <= .46 &&
        ['study', 'type', 'write', 'read'].includes(this.activity);
      const rawArmrest = seat.contacts.armrest;
      const armrest =
        rawArmrest !== undefined &&
        Number.isFinite(rawArmrest) &&
        rawArmrest >= seat.top + 0.08 &&
        rawArmrest <= seat.top + 0.34
          ? rawArmrest
          : undefined;
      const y = working ? validDeskH! + .042 : armrest !== undefined ? armrest + .040 : seat.top + .205;
      const x = side * (working ? .15 : armrest !== undefined ? .285 : .135) + (working ? -work!.x * .5 : 0), z = working ? work!.z : armrest !== undefined ? .10 : .27;
      const wrist = stage.localToWorld(seat.pos.clone().addScaledVector(left, x).addScaledVector(forward, z).setY(y));
      const shoulderBone = this.bones.get(side > 0 ? 'upper_arm.L' : 'upper_arm.R');
      if (shoulderBone) {
        const shY = shoulderBone.getWorldPosition(this.eyeWorldScratchA).y;
        wrist.y = Math.min(wrist.y, shY - 0.12 * scale * this.heightScaleNow);
      }
      return { wrist, fingers: forward.clone().addScaledVector(left, -side * (working ? .22 : armrest !== undefined ? .05 : .36)).addScaledVector(up, working ? -.05 : -.1), palm: up.clone().multiplyScalar(-1).addScaledVector(left, -side * .16), curl: working ? .2 : .34, grip: working ? 'type' as const : 'relaxed' as const };
    };
    return { left: hand(1), right: hand(-1) };
  }

  update(dt: number, reduced: boolean, wallDt?: number) {
    if (!this.ready) return;
    this.postIkRanThisFrame = false;
    this.elapsed += dt;
    this.frame.dt = dt; this.frame.reduced = reduced;
    this.lastWallDt = wallDt !== undefined && Number.isFinite(wallDt) ? Math.max(0, Math.min(0.05, wallDt)) : dt;
    this.body.recoverStuck(Boolean(this.walkTo), Boolean(this.seat), Boolean(this.rising));
    if (this.model) { this.model.position.set(0, 0, 0); this.model.rotation.set(0, 0, 0); }
    if (this.vehicleMode !== 'none' && this.bodyLeanDelegatedToRig) {
      // Single-pass `RiderIk` (`computeHumanRigRiderFrame`) drives root quaternion, saddle/seat height,
      // trunk/head pitch, handlebar hands, and pedal/footrest legs inside `HumanRig.update()` (`E5-03`).
      this.play('Idle', .18);
    } else if ((this.vehicleMode === 'bike' || this.vehicleMode === 'motorbike') && this.model) {
      this.play('cycle', .22);
      const act = this.actions.get('cycle');
      if (act) {
        if (this.vehicleMode === 'motorbike') {
          // Symmetric neutral footrest pose (midpoint of cycle clip where knees stay even)
          act.time = act.getClip().duration * .04;
          act.timeScale = 0;
        } else if (Math.abs(this.vehicleSpeed) < .05) {
          act.timeScale = 0;
        } else {
          act.timeScale = T.MathUtils.clamp(this.vehicleSpeed * .36, -2.2, 2.2);
        }
      }
      this.model.position.y = .08;
      this.model.rotation.z = T.MathUtils.clamp(-this.vehicleSteer * .16 * Math.min(1, Math.abs(this.vehicleSpeed) / 2.2), -.24, .24);
    } else if (this.vehicleMode === 'car' && this.model) {
      this.play('drive', .22);
      // Calibrated per-vehicle seating height so head and hair stay 100% inside the cabin roof while visible through windows.
      const carSeatY =
        this.vehicleModelId === 'car_halo_vector' ? -.36
        : this.vehicleModelId === 'car_lotus_spider' ? -.34
        : this.vehicleModelId === 'car_river_sedan' ? -.34
        : -.36;
      this.model.position.y = carSeatY;
      this.model.rotation.z = T.MathUtils.clamp(-this.vehicleSteer * .055, -.06, .06);
    } else if (!this.drove && Math.abs(this.stairPitch) > .001) {
      this.stairPitch *= Math.exp(-10 * dt);
    }
    if (this.clipOneShotLeft > 0) {
      this.clipOneShotLeft -= dt;
      if (this.clipOneShotLeft <= 0 && !this.stepping && this.vehicleMode === 'none' && !this.seat) {
        if (this.activity === 'stretch') {
          this.activity = 'idle';
          this.mood = 'neutral';
        }
        this.play('Idle', .28);
      }
    }
    if (this.sportShootLeft > 0) {
      this.sportShootLeft -= dt;
      this.releaseSportContacts();
      if (this.sportShootLeft <= 0) {
        if (this.sportMode === 'dribble') this.play('dribble', .22);
        else if (this.sportMode === 'aim') this.play('aim', .22);
        else { this.sportMode = 'none'; this.play('Idle', .25); this.mood = moodOf(this.activity); }
      }
    } else if (this.sportMode !== 'none' && !this.stepping && this.vehicleMode === 'none' && !this.seat && !this.motion) {
      if (this.sportMode === 'dribble') {
        this.play('dribble', .22);
        const act = this.actions.get('dribble');
        if (act) {
          act.setLoop(T.LoopRepeat, Infinity);
          const phase01 = (((this.sportPhase % 1) + 1) % 1);
          act.time = phase01 * act.getClip().duration;
        }
        this.applySportHandIk('dribble');
      } else if (this.sportMode === 'aim') {
        this.play('aim', .20);
        this.mood = 'focus';
        this.applySportHandIk('aim');
      } else {
        this.releaseSportContacts();
      }
    } else if (this.sportContactOwned) {
      this.releaseSportContacts();
    }
    if (this.expression) {
      const e = this.expression; e.elapsed += dt;
      const duration = e.action === 'jump' ? .6 : 2.6;
      if (e.elapsed >= duration) { this.expression = null; this.mood = moodOf(this.activity); }
    }
    if (this.airborne) {
      const pos = this.root.position, floor = this.floorY(pos.x, pos.z);
      const vyBefore = this.verticalSpeed;
      const y = pos.y + (this.verticalSpeed - 0.5 * JUMP_GRAVITY * dt) * dt;
      this.verticalSpeed -= JUMP_GRAVITY * dt;
      if (this.jumpPhase === 'takeoff' && this.verticalSpeed <= 0.65) {
        this.jumpPhase = 'airborne';
        const fallClip = this.pickClipName(['Jump_Apex', 'JumpFall', 'Jump']);
        if (fallClip && this.currentName !== fallClip) {
          const act = this.actions.get(fallClip)!;
          act.setLoop(T.LoopOnce, 1);
          act.clampWhenFinished = true;
          this.play(fallClip, 0.14);
        }
      }
      const grounded = this.vehicleMode === 'none' && !this.seat && !this.rising && !this.motion;
      if (!grounded || y <= floor) {
        const impact = Math.min(1, Math.abs(vyBefore) / JUMP_INITIAL_VELOCITY);
        this.airborne = false;
        this.verticalSpeed = 0;
        if (grounded) {
          pos.y = floor;
          // Express landing compression via `hips.position.y` knee flexion inside `advanceMixer` (`0` `model.position.y` shoe sink!).
          this.landSquash = Math.max(this.landSquash, impact * 0.052);
          this.jumpPhase = 'land';
          this.jumpLandLeft = this.drove && this.locomotionSpeed > 0.35 ? 0.11 : 0.24;
          const landClip = this.pickClipName(['Jump_Land', 'Land']);
          if (landClip) {
            const act = this.actions.get(landClip)!;
            act.setLoop(T.LoopOnce, 1);
            act.clampWhenFinished = true;
            this.play(landClip, 0.09);
          }
        } else {
          this.jumpPhase = 'none';
          this.jumpLandLeft = 0;
        }
      } else if (y > pos.y && this.jumpClear && !this.jumpClear(pos, y)) {
        this.verticalSpeed = 0;
      } else {
        pos.y = y;
      }
    } else if (this.jumpPhase === 'land') {
      this.jumpLandLeft -= dt;
      if (this.jumpLandLeft <= 0) {
        this.jumpPhase = 'none';
        if (!this.drove && this.standing && (this.currentName === 'Land' || this.currentName === 'Jump_Land')) {
          this.play('Idle', 0.22);
        }
      }
    }
    if (this.landSquash > 1e-4) {
      this.landSquash *= Math.exp(-14 * dt);
      if (this.landSquash <= 1e-4) this.landSquash = 0;
    }
    {
      const k = reduced ? 1 : 1 - Math.exp(-5 * dt), lowering = !!this.seat;
      this.eyeSit += ((lowering && !this.seat!.lie ? 1 : 0) - this.eyeSit) * k;
      this.eyeLie += ((lowering && this.seat!.lie ? 1 : 0) - this.eyeLie) * k;
    }
    this.lean *= Math.exp(-6 * dt);
    // A stride kept through a short stillness ends as soon as nothing drives the body (input stopped, a plan took over).
    if (this.gaitHeld && !this.drove && !this.isStudioPoseActive) {
      this.gaitHeld = false;
      this.schmittBand = 'idle';
      if (this.locomotionBlendActive || LOCO_GAIT_SET.has(this.currentName)) this.play('Idle', .26);
    }
    if (!this.drove) {
      this.leanRoll *= Math.exp(-10 * dt);
      this.leanPitch *= Math.exp(-10 * dt);
    }
    this.drove = false;
    if (this.motion) { this.advanceMotion(dt, reduced); return; }
    if(this.rising){
      // Getting up is the reverse of sitting down: weight over the knees first, then the legs push while feet stay on the floor.
      if(this.chairBack){const b=this.chairBack,step=Math.min(b.left,(reduced?9:.8)*dt);b.left-=step;b.move(-step);if(b.left<=.001){this.chairBack=null;b.done();}}
      const r=this.rising;r.elapsed+=dt;const seconds=reduced?.01:r.seconds,t=Math.min(1,r.elapsed/seconds),ease=(v:number)=>v*v*(3-2*v);
      const move=ease(Math.max(0,(t-.24)/.76));
      this.root.position.lerpVectors(r.from,r.to,move);
      if (r.lying) {
        this.root.position.y = T.MathUtils.lerp(r.from.y, r.to.y, ease(Math.min(1, Math.max(0, (t - .18) / .72))));
        this.seatPelvisDropY = 0;
      } else {
        this.root.position.y = T.MathUtils.lerp(r.from.y, r.to.y, move);
        this.seatPelvisDropY = T.MathUtils.lerp(this.risingPelvisDropFrom, 0, ease(Math.min(1, Math.max(0, (t - .10) / .80))));
      }
      this.lean=Math.sin(Math.min(1,t*1.12)*Math.PI)*.42;
      if(r.lying&&t<.45)this.play('sit',seconds*.42);
      else if (!r.lying && t < .82 && this.actions.has('Stand_Up')) { /* keep Stand_Up running across full push-off */ }
      else this.play('Idle', 0.24);
      this.root.rotation.x*=1-Math.min(1,dt*8);
      this.advanceMixer(dt,reduced);
      this.applyOwnView();
      if(t===1){
        const standAct = this.actions.get('Stand_Up');
        if (standAct) standAct.timeScale = 1;
        this.rising=null;
        this.risingSeatRef=null;
        this.seatPelvisDropY=0;
        this.lean=0;
        this.body.risen();
        if (this.activity === 'stretch') {
          this.activity = 'idle';
          this.mood = 'neutral';
        }
        if (!this.walkTo && !this.seat) {
          this.setActivity(this.activity, 0.24);
        }
      }
      return;
    }
    if (this.walkTo) {
      const p = this.root.position;
      const to = this.walkTo.points[0];
      const d = to.clone().sub(p).setY(0);
      const dist = d.length();
      if (this.seat === null) {
        const floor = this.floorY(p.x, p.z);
        const dy = floor - p.y;
        if (Math.abs(dy) >= 0.55 || reduced) {
          p.y = floor;
          this.root.rotation.x = 0;
        } else if (Math.abs(dy) > 1e-4) {
          p.y += dy * (1 - Math.exp(-20 * dt));
          this.root.rotation.x = 0;
        }
      }
      if (dist < 0.05) {
        this.walkTo.points.shift();
        if(this.walkTo.points.length) { this.advanceMixer(dt,reduced); this.applyOwnView(); return; }
        const then = this.walkTo.then;
        this.walkTo = null;
        this.play('Idle', 0.3);
        then?.();
      } else {
        const yaw = Math.atan2(d.x, d.z);
        let diff = yaw - this.root.rotation.y;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        const before = p.clone(), yawBefore = this.root.rotation.y, next = p.clone();
        if (Math.abs(diff) < 1.2) next.add(d.normalize().multiplyScalar(Math.min(dist, dt * 1.12)));
        this.moveRoot(next, yawBefore + diff * Math.min(1, dt * 8));
        const moved = p.distanceTo(before), turned = Math.abs(this.root.rotation.y - yawBefore);
        const progress = moved > 1e-5 || turned > 1e-5;
        this.walkTo.blockedFor = progress ? 0 : this.walkTo.blockedFor + dt;
        if (this.walkTo.blockedFor >= .8) {
          this.walkTo = null; this.poseEpoch++; this.pendingActivity = null;
          if (this.activity === 'stretch') {
            this.activity = 'idle';
            this.mood = 'neutral';
          }
          if (this.body.state === 'approaching') this.body.reset();
          window.dispatchEvent(new Event('study:navigation-blocked'));
        }
        this.play(progress ? 'Walk' : 'Idle', 0.25);
        const walk = this.actions.get('Walk');
        if (walk) walk.timeScale = moved > 1e-5 ? gaitTimeScale('Walk', moved / Math.max(dt, .001), this.modelScaleNow, this.gaitDrawn) : stepWhileTurning(turned / Math.max(dt, .001));
      }
    } else if (this.seat) {
      const s = this.seat;
      // 3-phase sitting (`turn_in -> lowering -> settled`): align back to seat first, then lower pelvis onto cushion while feet stay planted on `s.floorY`.
      const seconds = reduced ? .01 : s.lie ? 1.3 : 0.84;
      const p = T.MathUtils.clamp((this.elapsed - s.started) / seconds, 0, 1);
      if (p < 1 && !s.from) s.from = this.root.position.clone();
      const target = s.pos.clone();
      target.y = s.drop;
      if (p < 1 && s.from) {
        const ease = (v: number) => v * v * (3 - 2 * v);
        if (!s.lie) {
          if (p < 0.26) this.body.beginTurnIn();
          else this.body.beginDescent();
        }
        const across = s.lie
          ? ease(Math.min(1, p * 1.45))
          : ease(T.MathUtils.clamp((p - 0.10) / 0.68, 0, 1));
        const down = s.lie
          ? ease(Math.max(0, (p - .16) / .84))
          : ease(T.MathUtils.clamp((p - 0.24) / 0.76, 0, 1));
        this.root.position.set(
          T.MathUtils.lerp(s.from.x, target.x, across),
          T.MathUtils.lerp(s.from.y, target.y, s.lie ? down : across),
          T.MathUtils.lerp(s.from.z, target.z, across),
        );
        this.seatPelvisDropY = s.lie ? 0 : T.MathUtils.lerp(0, s.pelvisDrop, down);
        this.lean = Math.sin(p * Math.PI) * (s.lie ? .2 : .38);
        if (!s.lie && !s.activityStarted && p >= 0.72) {
          s.activityStarted = true;
          const sitDownAct = this.actions.get('Sit_Down');
          if (sitDownAct) sitDownAct.timeScale = 1;
          this.setActivity(s.targetActivity, 0.28);
        }
      } else {
        this.root.position.lerp(target, Math.min(1, dt * 8));
        this.seatPelvisDropY = s.lie ? 0 : s.pelvisDrop;
        if (!s.activityStarted) {
          s.activityStarted = true;
          const sitDownAct = this.actions.get('Sit_Down');
          if (sitDownAct) sitDownAct.timeScale = 1;
          this.setActivity(s.targetActivity, 0.22);
        }
      }
      if (p >= 1 && this.root.position.distanceToSquared(target) < 4e-4) this.body.settled();
      // Seated, the chair is drawn up to the desk with the feet: it and the body go together.
      const slide = s.contacts.slide;
      if (p >= 1 && slide && slide.distance > .001 && this.body.state === 'seated') {
        const step = Math.min(slide.distance, (reduced ? 9 : .42) * dt);
        slide.distance -= step;
        slide.move(step);
        s.pos.addScaledVector(new T.Vector3(Math.sin(s.rotY), 0, Math.cos(s.rotY)), step);
        if (s.contacts.work) { s.contacts.work.edge -= step; s.contacts.work.z -= step; }
        slide.moved = (slide.moved ?? 0) + step;
        if (slide.distance <= .001) slide.done();
      }
      let diff = s.rotY - this.root.rotation.y;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      const turnRate = !s.lie && p < 0.45 ? 11.5 : 7.5;
      this.root.rotation.y += diff * Math.min(1, dt * turnRate);
      // Orientation belongs to the skeletal sleep clip, never the whole character.
      this.root.rotation.x = 0; this.root.rotation.z = 0;
    } else {
      this.seatPelvisDropY = 0;
      this.rollingSpeedNow = 0;
    }
    const studioFrozenStep =
      dt <= 1e-6 &&
      (this.isStudioPoseActive || this.blendRemaining > 0) &&
      this.lastWallDt > 0;
    const mixerDt = studioFrozenStep ? this.lastWallDt : dt;
    const holdClipTime =
      dt <= 1e-6 &&
      !this.currentName.startsWith('studio_') &&
      this.blendRemaining <= 0;
    this.advanceMixer(mixerDt, reduced, holdClipTime);
    this.applyOwnView();
  }

  /**
   * Zero-alloc floor-anchored seated leg IK targets compatible with `BodyFrame.legTargets` (`RC-A4.4`):
   * computed in `this.root` character frame and gated by yaw alignment (`cos(charYaw - refRotY)`)
   * so knees NEVER invert 180 deg during seat turn-in, plus subtle alternating caster-scoot on rolling chairs.
   */
  seatedLegTargets(): BodyFrame['legTargets'] {
    const stage = this.root.parent;
    if (!stage) return undefined;
    let refRotY = 0;
    let refFloorY = 0;
    let refTop = 0;
    let weight = 0;
    let isRolling = false;
    if (this.seat && !this.seat.lie) {
      refRotY = this.seat.rotY;
      refFloorY = this.seat.floorY;
      refTop = this.seat.top;
      weight = Math.min(1, Math.max(0, (this.elapsed - this.seat.started) / 0.42));
      isRolling = this.seat.mobility === 'rolling';
    } else if (this.rising && !this.rising.lying && this.risingSeatRef) {
      refRotY = this.risingSeatRef.rotY;
      refFloorY = this.risingSeatRef.floorY;
      refTop = this.risingSeatRef.top;
      const t = Math.min(1, this.rising.elapsed / Math.max(0.01, this.rising.seconds));
      weight = Math.max(0, 1 - t * 1.45);
    } else {
      return undefined;
    }
    const charYaw = this.root.rotation.y;
    const yawGate = T.MathUtils.smoothstep(Math.cos(charYaw - refRotY), 0.45, 0.88);
    weight *= yawGate;
    if (weight <= 1e-4) return undefined;

    stage.updateWorldMatrix(true, false);
    const fwdX = Math.sin(charYaw);
    const fwdZ = Math.cos(charYaw);
    const leftX = Math.cos(charYaw);
    const leftZ = -Math.sin(charYaw);
    const cx = this.root.position.x;
    const cz = this.root.position.z;
    const halfStance = 0.115 * this.heightScaleNow;
    const shinFwd = 0.36 * this.heightScaleNow * this.legRatioNow;
    const poleFwd = 0.80 * this.heightScaleNow * this.legRatioNow;
    const restYL = this.footRest.get('L')?.y ?? 0.08 * this.heightScaleNow;
    const restYR = this.footRest.get('R')?.y ?? 0.08 * this.heightScaleNow;

    let scootL = 0;
    let scootR = 0;
    let liftL = 0;
    let liftR = 0;
    if (isRolling && this.rollingSpeedNow > 0.02) {
      const scootScale = Math.min(1, this.rollingSpeedNow / 0.55);
      scootL = Math.sin(this.rollingScootPhase) * 0.042 * scootScale;
      scootR = -scootL;
      liftL = Math.max(0, Math.cos(this.rollingScootPhase)) * 0.018 * scootScale;
      liftR = Math.max(0, -Math.cos(this.rollingScootPhase)) * 0.018 * scootScale;
    }

    const out = this.seatedTargetsScratch;
    out.left.set(
      cx + halfStance * leftX + (shinFwd + scootL) * fwdX,
      refFloorY + restYL + liftL,
      cz + halfStance * leftZ + (shinFwd + scootL) * fwdZ,
    );
    out.right.set(
      cx - halfStance * leftX + (shinFwd + scootR) * fwdX,
      refFloorY + restYR + liftR,
      cz - halfStance * leftZ + (shinFwd + scootR) * fwdZ,
    );
    out.leftPole.set(
      cx + halfStance * 1.05 * leftX + poleFwd * fwdX,
      refTop + 0.15 * this.heightScaleNow,
      cz + halfStance * 1.05 * leftZ + poleFwd * fwdZ,
    );
    out.rightPole.set(
      cx - halfStance * 1.05 * leftX + poleFwd * fwdX,
      refTop + 0.15 * this.heightScaleNow,
      cz - halfStance * 1.05 * leftZ + poleFwd * fwdZ,
    );
    stage.localToWorld(out.left);
    stage.localToWorld(out.right);
    stage.localToWorld(out.leftPole);
    stage.localToWorld(out.rightPole);
    out.weight = weight;
    return out;
  }

  /** Where to aim the camera to frame the character. */
  focusPoint(out: T.Vector3) { return out.copy(this.root.position).setY(this.root.position.y + this.seatPelvisDropY * 0.5 + 0.9 * this.heightScaleNow); }

  dispose() {
    this.motion = null; this.motions.clear(); this.onMotionEnd = null;
    this.mixer?.stopAllAction();
    if (this.model) this.mixer?.uncacheRoot(this.model);
    this.wardrobe?.dispose();
    for (const g of this.ownedPropGeometries) g.dispose();
    this.ownedPropGeometries.clear();
    this.materials.forEach((m) => m.dispose());
    this.palette?.tex.dispose();
    this.disposed = true; this.poseEpoch++; this.walkTo = null; this.seat = null; this.rising = null; this.risingSeatRef = null; this.chairBack = null;
    this.rollingVelX = 0; this.rollingVelZ = 0; this.rollingSpeedNow = 0;
    this.body.reset();
    this.root.removeFromParent();
  }
}
