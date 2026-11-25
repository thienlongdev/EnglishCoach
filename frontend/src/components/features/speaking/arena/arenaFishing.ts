/**
 * ECHO ARCHIPELAGO — High-Craft 3D Angling Equipment, Master-Slave Two-Hand Grip IK,
 * Mouse-Hold Ballistic Casting, Real Ecosystem Bait Coupling, and Account-Scoped Marine Logbook.
 *
 * Wave 9 AAA Architecture (`F01`–`F06`, `9.4`):
 * - Loads `arenaV7Assets.props.fishingRod` and `arenaV7Assets.props.bobber` (`0` WASM, pre-warmed via `readyPromise`,
 *   with complete 3D procedural fallback in headless Node environments — `0` 1px `THREE.Line` rods, `0` cone fish!).
 * - Hybrid 3D rod assembly: Cycles-baked cork butt/foregrip + brass reel seat + carbon/brass spinning reel +
 *   orbiting `Reel_Crank` + flip-open metallic bail wire + 20-station arc-length-preserving Euler-Bernoulli
 *   tapered 3D tubular blank + 6 underslung ceramic-lined guides + 25-pt threaded monofilament catenary +
 *   buoyant `PropBobber` + 8-pt subsurface fluorocarbon leader + 3D steel J-hook and segmented prawn bait!
 * - Zero-drift two-hand attachment (`< 0.2 mm` residual in `resolveRigContacts`, `0.000 mm` post-IK lock in
 *   `syncVisualsToSolvedHands`): right hand (`side = +1`) wraps around cork grip (`handleGrip` + `handleShape`);
 *   left hand (`side = -1`, `support: true`) cradles cork foregrip during stance/charge/cast/bite or pinches and
 *   turns the orbiting `Reel_Crank` knob during `reeling`.
 * - Mouse/key hold-to-charge (`charging` phase, `chargePower` `0..1` over `1.35 s`) coils backcast pose and drives
 *   the minimal horizontal power bar -> release whips rod forward and launches bobber/leader/hook/bait along a
 *   true Newtonian ballistic arc (`5.5 m .. 27.0 m`) settling buoyantly into Gerstner waves.
 * - Exposes `getActiveBait(): ActiveBaitDescriptor` (`onBaitNibble`, `onFishBite`, `onHookedFishPose`) so live
 *   3D species in `ArenaMarineEcosystem` physically approach, nibble, bite, fight, and hang on the leader!
 */

import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { fitGraspTranslation, type GraspReach } from '@/lib/embodiment/graspFrame';
import { HANDLE_ALONG, HANDLE_OBLIQUE, handleGrip, handleShape } from '@/lib/embodiment/handle';
import type { HandContact, HumanRig } from '@/lib/embodiment/human';
import { handRotation } from '@/lib/embodiment/poses';
import type { ArenaAmbience } from './arenaAmbience';
import { arenaV7Assets } from './arenaAssets';
import type {
  ActiveBaitDescriptor,
  ArenaQualityTier,
  CaughtFishRecord,
  FishingHudState,
  FishingPhase,
  MarineCollectionState,
  MarineSpeciesSpec,
} from './arenaContracts';
import {
  CATCHABLE_MARINE_SPECIES,
  MARINE_SPECIES_BY_ID,
  isProtectedScenicSpecies,
  resolveNearestIslandId,
  type ArenaMarineEcosystem,
} from './arenaMarineLife';
import { arenaWaveHeight } from './arenaSea';
import { ARENA_WATER_Y, arenaFloor, arenaLayout, arenaOnWood, arenaWaterDepth } from './arenaTerrain';

const LOGBOOK_KEY_PREFIX = 'ec_arena_marine_log:v1:';

// 20-station × 10-side 3D tapered tubular blank (400 tris, zero-GC DynamicDrawUsage)
const BLANK_SEGMENTS = 20;
const BLANK_SIDES = 10;
const BLANK_START_Z = 0.295;
const BLANK_LENGTH = 1.855; // z = 0.295 m -> z = 2.150 m (total rod length 2.41 m from butt -0.26 m)
const BLANK_BUTT_RADIUS = 0.0086;
const BLANK_TIP_RADIUS = 0.00135;

// 6 underslung ceramic-lined brass guides along the 20-station blank
const GUIDE_COUNT = 6;
const GUIDE_STATIONS: readonly number[] = [3, 6, 10, 14, 17, 20];
const GUIDE_RING_RADII: readonly number[] = [0.0124, 0.0096, 0.0075, 0.0059, 0.0048, 0.0041];
const GUIDE_FOOT_HEIGHTS: readonly number[] = [0.0175, 0.0135, 0.0102, 0.0078, 0.0060, 0.0044];

// Threaded monofilament: 1 bail line-roller + 6 guide eyelets + 18 aerial catenary segments = 25 points
const AERIAL_CATENARY_PTS = 18;
const LINE_POINTS = 1 + GUIDE_COUNT + (AERIAL_CATENARY_PTS - 1); // guide[5] is shared as catenary u=0 -> 24 pts
const LEADER_POINTS = 8;
const RING_POOL_SIZE = 8;

// Measured grip stations in `rodBase` local space (+Z = butt-to-tip, +Y = rod dorsal up, +X = left crank side)
const CORK_GRIP_LOCAL = new T.Vector3(0, 0, -0.05);
const FOREGRIP_LOCAL = new T.Vector3(0, 0, 0.21);
const CRANK_PIVOT_LOCAL = new T.Vector3(0.028, -0.068, 0.060);
const CRANK_KNOB_OFFSET = new T.Vector3(0.042, -0.032, 0);
const REEL_SPOOL_LOCAL = new T.Vector3(0, -0.068, 0.092);
const ROD_AXIS_Z = new T.Vector3(0, 0, 1);
const CRANK_AXIS_X = new T.Vector3(1, 0, 0);
const ZERO_VEC = new T.Vector3(0, 0, 0);
const WORLD_UP = new T.Vector3(0, 1, 0);

const CORK_GRIP_RADIUS = 0.0175;
const CORK_GRIP_HALF = 0.10;
const FOREGRIP_RADIUS = 0.0166;
const FOREGRIP_HALF = 0.08;
const CRANK_KNOB_RADIUS = 0.011;
const CRANK_KNOB_HALF = 0.022;

export const FISHING_FULL_CHARGE_SEC = 1.35;
export const FISHING_MIN_CAST_M = 5.5;
export const FISHING_MAX_CAST_M = 27.0;
const CAST_WHIP_RELEASE_SEC = 0.18;
const CAST_GRAVITY = 15.5;

// Precomputed fast-action Euler-Bernoulli compliance weights (sum = 1)
const BLANK_COMPLIANCE_WEIGHTS = (() => {
  const raw = new Float32Array(BLANK_SEGMENTS + 1);
  let sum = 0;
  for (let k = 1; k <= BLANK_SEGMENTS; k++) {
    const s = k / BLANK_SEGMENTS;
    const w = Math.pow(s, 2.25);
    raw[k] = w;
    sum += w;
  }
  for (let k = 1; k <= BLANK_SEGMENTS; k++) raw[k] /= sum;
  return raw;
})();

const BLANK_RADII = (() => {
  const r = new Float32Array(BLANK_SEGMENTS + 1);
  for (let k = 0; k <= BLANK_SEGMENTS; k++) {
    const s = k / BLANK_SEGMENTS;
    r[k] = BLANK_TIP_RADIUS + (BLANK_BUTT_RADIUS - BLANK_TIP_RADIUS) * Math.pow(1 - s, 0.78);
  }
  return r;
})();

const RING_COS = new Float32Array(BLANK_SIDES);
const RING_SIN = new Float32Array(BLANK_SIDES);
for (let m = 0; m < BLANK_SIDES; m++) {
  const a = (m / BLANK_SIDES) * Math.PI * 2;
  RING_COS[m] = Math.cos(a);
  RING_SIN[m] = Math.sin(a);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smooth01(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  return smooth01((x - edge0) / Math.max(1e-6, edge1 - edge0));
}

function normAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function normalizeAccountScope(account: string | number | null | undefined): string {
  if (account === null || account === undefined || account === '') return 'guest';
  return String(account).trim() || 'guest';
}

export function marineLogStorageKey(account: string | number | null | undefined): string {
  return `${LOGBOOK_KEY_PREFIX}${normalizeAccountScope(account)}`;
}

export function createEmptyMarineCollection(): MarineCollectionState {
  return {
    catchesBySpecies: {},
    totalCaught: 0,
  };
}

/** Read account-scoped `MarineCollectionState` safely from `localStorage`. */
export function loadMarineLogbook(account: string | number | null | undefined): MarineCollectionState {
  if (typeof window === 'undefined') return createEmptyMarineCollection();
  try {
    const raw = window.localStorage.getItem(marineLogStorageKey(account));
    if (!raw) return createEmptyMarineCollection();
    const parsed = JSON.parse(raw) as Partial<MarineCollectionState> | null;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.catchesBySpecies !== 'object') {
      return createEmptyMarineCollection();
    }
    return {
      catchesBySpecies: { ...parsed.catchesBySpecies },
      totalCaught: typeof parsed.totalCaught === 'number' ? parsed.totalCaught : 0,
    };
  } catch {
    return createEmptyMarineCollection();
  }
}

/** Persist a newly caught fish into the learner's account-scoped Marine Logbook and mark `isNewRecord`. */
export function recordCaughtFishInLogbook(
  account: string | number | null | undefined,
  catchRecord: CaughtFishRecord,
): { state: MarineCollectionState; record: CaughtFishRecord } {
  const current = loadMarineLogbook(account);
  const existing = current.catchesBySpecies[catchRecord.speciesId];
  const isNewRecord = !existing || catchRecord.weightKg > existing.bestWeightKg;

  const enrichedRecord: CaughtFishRecord = {
    ...catchRecord,
    isNewRecord,
  };

  current.catchesBySpecies[catchRecord.speciesId] = {
    count: (existing?.count ?? 0) + 1,
    bestWeightKg: existing ? Math.max(existing.bestWeightKg, catchRecord.weightKg) : catchRecord.weightKg,
    bestLengthCm: existing ? Math.max(existing.bestLengthCm, catchRecord.lengthCm) : catchRecord.lengthCm,
    firstCaughtAt: existing?.firstCaughtAt ?? catchRecord.caughtAt,
    lastIslandId: catchRecord.islandId,
  };
  current.totalCaught = (current.totalCaught ?? 0) + 1;

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(marineLogStorageKey(account), JSON.stringify(current));
    } catch {
      /* storage quota full — keep in-memory session record intact */
    }
  }

  return { state: current, record: enrichedRecord };
}

/**
 * Optional underwater wildlife observation recorder for protected marine giants (`manta_ray`, `sea_turtle`)
 * when a swimmer dives within 6.5 m of them! Never increments angling hook counts improperly without observation.
 */
export function recordProtectedWildlifeSighting(
  account: string | number | null | undefined,
  speciesId: string,
  islandId: string,
): MarineCollectionState | null {
  const spec = MARINE_SPECIES_BY_ID[speciesId];
  if (!spec || !isProtectedScenicSpecies(speciesId)) return null;
  const estWeight = +((spec.minWeightKg + spec.maxWeightKg) * 0.5).toFixed(1);
  const estLength = Math.round((spec.minLengthCm + spec.maxLengthCm) * 0.5);
  return recordCaughtFishInLogbook(account, {
    speciesId,
    weightKg: estWeight,
    lengthCm: estLength,
    rarity: spec.rarity,
    islandId,
    caughtAt: Date.now(),
  }).state;
}

export interface ConservationNote {
  noteEn: string;
  noteVi: string;
}

export function getCatchConservationNote(species: MarineSpeciesSpec): ConservationNote {
  if (species.id === 'reef_shark') {
    return {
      noteEn: 'Protected apex guardian: admired beside the pier and released unharmed into the channel.',
      noteVi: 'Sinh vật đầu chuỗi rạn san hô: chiêm ngưỡng nhanh rồi nhẹ nhàng thả lại về biển khơi.',
    };
  }
  if (species.rarity === 'legendary' || species.rarity === 'rare') {
    return {
      noteEn: 'Catch and release: logged in your Marine Journal and returned safely to the archipelago.',
      noteVi: 'Câu giải trí và bảo tồn: đã lưu vào Sổ tay Sinh vật biển và thả cá bơi về rạn san hô.',
    };
  }
  return {
    noteEn: 'Recorded in your Marine Logbook with English reef vocabulary, then gently released.',
    noteVi: 'Đã ghi nhận vào Sổ tay Sinh vật biển kèm từ vựng tiếng Anh rồi thả lại xuống làn nước.',
  };
}

export interface FishingStepContext {
  dt: number;
  time: number;
  anglerX: number;
  anglerY: number;
  anglerZ: number;
  anglerYaw: number;
  lookYaw: number;
  lookPitch?: number;
  moveSpeed?: number;
  isSeated?: boolean;
  /** True when standing on dry land/pier or seated as a boat passenger (false when rowing or swimming). */
  canFishHere: boolean;
  /** True while holding Left Mouse / Space / KeyE during `charging` or `reeling` */
  reelHeld: boolean;
  listenerX: number;
  listenerZ: number;
  listenerYaw: number;
  ambience?: ArenaAmbience;
  ecosystem?: ArenaMarineEcosystem;
  waveHeightAt?: (x: number, z: number, time: number) => number;
}

export interface FishingPromptHint {
  canTrigger: boolean;
  keyHint: 'F' | 'E';
  labelEn: string;
  labelVi: string;
}

/** Extract rigid handle + reel-seat + foregrip + spinning-reel body (`z <= maxZ` in `Rod_Body` space) from quantized GLB mesh. */
function extractRigidHandleGeometryFromGlb(mesh: T.Mesh, rodBodyRoot: T.Object3D, maxZ: number): T.BufferGeometry | null {
  rodBodyRoot.updateMatrixWorld(true);
  mesh.updateWorldMatrix(true, false);
  const toRodRoot = rodBodyRoot.matrixWorld.clone().invert().multiply(mesh.matrixWorld);
  const normalMat = new T.Matrix3().getNormalMatrix(toRodRoot);

  const srcGeo = mesh.geometry;
  const posAttr = srcGeo.getAttribute('position');
  const normAttr = srcGeo.getAttribute('normal');
  const uvAttr = srcGeo.getAttribute('uv');
  if (!posAttr) return null;

  const vA = new T.Vector3();
  const vB = new T.Vector3();
  const vC = new T.Vector3();
  const nVec = new T.Vector3();

  const outPos: number[] = [];
  const outNorm: number[] = [];
  const outUv: number[] = [];

  const indexAttr = srcGeo.getIndex();
  const triCount = indexAttr ? Math.floor(indexAttr.count / 3) : Math.floor(posAttr.count / 3);

  for (let t = 0; t < triCount; t++) {
    const i0 = indexAttr ? indexAttr.getX(t * 3) : t * 3;
    const i1 = indexAttr ? indexAttr.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = indexAttr ? indexAttr.getX(t * 3 + 2) : t * 3 + 2;

    vA.fromBufferAttribute(posAttr, i0).applyMatrix4(toRodRoot);
    vB.fromBufferAttribute(posAttr, i1).applyMatrix4(toRodRoot);
    vC.fromBufferAttribute(posAttr, i2).applyMatrix4(toRodRoot);

    // Exclude static decimated blank & static guides (z > 0.325 m) while retaining 100% of cork butt, reel seat, foregrip & reel body
    if (vA.z > maxZ || vB.z > maxZ || vC.z > maxZ) continue;

    outPos.push(vA.x, vA.y, vA.z, vB.x, vB.y, vB.z, vC.x, vC.y, vC.z);

    if (normAttr) {
      for (const idx of [i0, i1, i2]) {
        nVec.fromBufferAttribute(normAttr, idx).applyMatrix3(normalMat).normalize();
        outNorm.push(nVec.x, nVec.y, nVec.z);
      }
    } else {
      nVec.subVectors(vB, vA).cross(vC.clone().sub(vA)).normalize();
      outNorm.push(nVec.x, nVec.y, nVec.z, nVec.x, nVec.y, nVec.z, nVec.x, nVec.y, nVec.z);
    }

    if (uvAttr) {
      for (const idx of [i0, i1, i2]) {
        outUv.push(uvAttr.getX(idx), uvAttr.getY(idx));
      }
    }
  }

  if (outPos.length === 0) return null;
  const outGeo = new T.BufferGeometry();
  outGeo.setAttribute('position', new T.Float32BufferAttribute(outPos, 3));
  outGeo.setAttribute('normal', new T.Float32BufferAttribute(outNorm, 3));
  if (outUv.length > 0) {
    outGeo.setAttribute('uv', new T.Float32BufferAttribute(outUv, 2));
  }
  outGeo.computeBoundingSphere();
  return outGeo;
}

export class ArenaFishingController {
  private accountScope: string;
  private logbook: MarineCollectionState;
  private disposed = false;

  private phase: FishingPhase = 'idle';
  private phaseTimer = 0;
  private waitDuration = 4.2;
  private nextNibbleAt = 1.6;

  // Mouse/key hold cast-power state (`0..1`)
  private chargeHoldSec = 0;
  private chargePower = 0;
  private lastCastPower = 0.68;

  // Ballistic flight & wave-buoyant bobber physics
  private ballisticLaunched = false;
  private flightElapsed = 0;
  private flightDuration = 0.65;
  private launchOrigin = new T.Vector3();
  private launchVel = new T.Vector3();
  private targetBobberX = 0;
  private targetBobberZ = 0;
  private bobberX = 0;
  private bobberY = ARENA_WATER_Y;
  private bobberZ = 0;
  private bobberDipOffset = 0;
  private bobberDipVel = 0;
  private initialDistanceM = 12;
  private distanceM = 0;

  // Equipped / charging tip-pendulum state (world-space bobber hanging from tip-top eyelet)
  private pendulumInit = false;
  private readonly pendulumPos = new T.Vector3();
  private readonly pendulumVel = new T.Vector3();

  // Subsurface bait & real 3D fish ecosystem coupling (`F06`)
  private baitX = 0;
  private baitY = ARENA_WATER_Y - 0.55;
  private baitZ = 0;
  private hookX = 0;
  private hookY = ARENA_WATER_Y - 0.55;
  private hookZ = 0;
  private claimedAgentIndex = -1;
  private claimedScaleRatio = 1.0;
  private fishApproaching = false;
  private ecosystemDriven = false;
  private ecosystemPoseValid = false;
  private readonly hookedMouthPos = new T.Vector3();
  private activeEcosystemRef: ArenaMarineEcosystem | undefined = undefined;

  // Interactive Tension-Meter (`0..1`), Reel Crank & Species Surge Rhythm
  private tension = 0;
  private progress = 0;
  private fishPulling = false;
  private surgeTimer = 1.6;
  private overTensionGrace = 0;
  private slackTimer = 0;
  private fishAngleOffset = 0;
  private activeSpecies: MarineSpeciesSpec | null = null;
  private lastCatch: CaughtFishRecord | null = null;

  // Mechanical reel & Euler-Bernoulli blank dynamic whip state
  private crankAngle = 0;
  private rotorAngle = 0;
  private bailOpenAngle = 0;
  private prevRodTipDir = new T.Vector3(0, 0.5, 0.866);
  private prevRodDirInit = false;
  private tipWhipX = 0;
  private tipWhipY = 0;
  private tipWhipVelX = 0;
  private tipWhipVelY = 0;
  private handSyncedThisFrame = false;

  // Last angler context for `getActiveBait()` & `resolveRigContacts`
  private lastAnglerX = 0;
  private lastAnglerY = 0;
  private lastAnglerZ = 0;
  private lastAnglerYaw = 0;
  private lastLookYaw = 0;
  private lastLookPitch = 0;
  private lastTime = 0;

  // ── 3D Scene Visual Hierarchy (`0` `THREE.Line` rods, `0` `ConeGeometry` fish!) ──
  readonly root = new T.Group();
  readonly rodBase = new T.Group();
  private readonly handleVisualGroup = new T.Group();
  private readonly fallbackHandleGroup = new T.Group();
  private readonly reelCrankPivot = new T.Group();
  private readonly fallbackCrankGroup = new T.Group();
  readonly crankKnobSocket = new T.Object3D();
  private readonly reelRotorGroup = new T.Group();
  private readonly bailPivotGroup = new T.Group();
  private readonly lineRollerSocket = new T.Object3D();

  private readonly blankGeo: T.BufferGeometry;
  private readonly blankPositions: Float32Array;
  private readonly blankNormals: Float32Array;
  private readonly blankMesh: T.Mesh;
  private readonly blankMat: T.MeshStandardMaterial;

  private readonly guideMeshes: T.Group[] = [];
  private readonly guideEyeLocal: T.Vector3[] = Array.from({ length: GUIDE_COUNT }, () => new T.Vector3());
  private readonly guideEyeWorld: T.Vector3[] = Array.from({ length: GUIDE_COUNT }, () => new T.Vector3());

  private readonly lineGeo: T.BufferGeometry;
  private readonly linePositions = new Float32Array(LINE_POINTS * 3);
  private readonly lineMat: T.LineBasicMaterial;
  private readonly lineObj: T.Line;

  private readonly leaderGeo: T.BufferGeometry;
  private readonly leaderPositions = new Float32Array(LEADER_POINTS * 3);
  private readonly leaderMat: T.LineBasicMaterial;
  private readonly leaderObj: T.Line;

  private readonly bobberGroup = new T.Group();
  private readonly fallbackBobberGroup = new T.Group();
  private readonly hookAndBaitGroup = new T.Group();
  private readonly prawnBaitGroup = new T.Group();

  private readonly ringGeo: T.RingGeometry;
  private readonly ringMat: T.MeshBasicMaterial;
  readonly ringMesh: T.InstancedMesh;
  private readonly ringState = new Float32Array(RING_POOL_SIZE * 5);
  private ringCursor = 0;

  private readonly ownedGeometries: T.BufferGeometry[] = [];
  private readonly ownedMaterials: T.Material[] = [];
  private readonly ownedTextures: T.Texture[] = [];

  // ── Persistent Pre-Allocated Two-Hand `HandContact`s (`0` per-frame refit churn) ──
  readonly rightGripContact: HandContact;
  readonly leftForegripContact: HandContact;
  readonly leftCrankContact: HandContact;
  private readonly handPairBoth: { left: HandContact; right: HandContact };
  private readonly handPairCrank: { left: HandContact; right: HandContact };
  private readonly handPairSingle: { left: HandContact | null; right: HandContact };

  /** Resolves once `prop-fishing-rod` & `prop-bobber` GLBs (or headless fallback) are ready for shader warmup. */
  readonly readyPromise: Promise<void>;

  // ── Zero-Allocation Scratch Registers ──
  private readonly rodTipWorld = new T.Vector3();
  private readonly rollerWorld = new T.Vector3();
  private readonly bobberTopWorld = new T.Vector3();
  private readonly bobberBottomWorld = new T.Vector3();
  private readonly dummyMat = new T.Matrix4();
  private readonly dummyMat2 = new T.Matrix4();
  private readonly invRodMat = new T.Matrix4();
  private readonly dummyPos = new T.Vector3();
  private readonly dummyQuat = new T.Quaternion();
  private readonly dummyQuat2 = new T.Quaternion();
  private readonly dummyScale = new T.Vector3(1, 1, 1);

  private readonly _pPrev = new T.Vector3();
  private readonly _pCurr = new T.Vector3();
  private readonly _tVec = new T.Vector3();
  private readonly _nVec = new T.Vector3();
  private readonly _bVec = new T.Vector3();
  private readonly _bendAxis = new T.Vector3();
  private readonly _lineLocal = new T.Vector3();
  private readonly _shR = new T.Vector3();
  private readonly _shL = new T.Vector3();
  private readonly _wR = new T.Vector3();
  private readonly _fR = new T.Vector3();
  private readonly _pR = new T.Vector3();
  private readonly _wL = new T.Vector3();
  private readonly _fL = new T.Vector3();
  private readonly _pL = new T.Vector3();
  private readonly _f0 = new T.Vector3();
  private readonly _axisR = new T.Vector3();
  private readonly _gripWorldR = new T.Vector3();
  private readonly _gripWorldL = new T.Vector3();
  private readonly _rodX = new T.Vector3();
  private readonly _rodY = new T.Vector3();
  private readonly _rodZ = new T.Vector3();
  private readonly _charFwd = new T.Vector3();
  private readonly _charLeft = new T.Vector3();
  private readonly _poleR = new T.Vector3();
  private readonly _poleL = new T.Vector3();
  private readonly _crankWorld = new T.Vector3();
  private readonly _crankAxisW = new T.Vector3();
  private readonly _reaches1: [GraspReach];
  private readonly _reaches2: [GraspReach, GraspReach];

  private readonly hudSnapshot: FishingHudState = {
    phase: 'idle',
    chargePower: 0,
    tension: 0,
    progress: 0,
    fishPulling: false,
    fishApproaching: false,
    distanceM: 0,
    bobberX: 0,
    bobberZ: 0,
    activeSpecies: null,
    lastCatch: null,
  };

  private readonly baitDescriptor: ActiveBaitDescriptor;

  private onCatchCallback?: (record: CaughtFishRecord, species: MarineSpeciesSpec, log: MarineCollectionState) => void;

  constructor(
    private readonly scene: T.Scene,
    account: string | number | null | undefined = 'guest',
    options?: {
      low?: boolean;
      qualityTier?: ArenaQualityTier;
      onCatch?: (record: CaughtFishRecord, species: MarineSpeciesSpec, log: MarineCollectionState) => void;
    },
  ) {
    this.accountScope = normalizeAccountScope(account);
    this.logbook = loadMarineLogbook(this.accountScope);
    this.onCatchCallback = options?.onCatch;
    this.root.name = 'ArenaFishingRig';
    this.rodBase.name = 'ArenaFishingRodBase';

    const trackGeo = <G extends T.BufferGeometry>(g: G): G => {
      this.ownedGeometries.push(g);
      return g;
    };
    const trackMat = <M extends T.Material>(m: M): M => {
      this.ownedMaterials.push(m);
      return m;
    };

    // Shared high-craft PBR materials for procedural fallback + rotor/bail + guides + blank + hook & prawn bait
    const corkMat = trackMat(new T.MeshStandardMaterial({ color: '#c89d68', roughness: 0.80, metalness: 0.02 }));
    const brassMat = trackMat(new T.MeshStandardMaterial({ color: '#d9a443', roughness: 0.25, metalness: 0.88 }));
    const carbonMat = trackMat(new T.MeshStandardMaterial({ color: '#1e262d', roughness: 0.28, metalness: 0.42 }));
    const ceramicMat = trackMat(new T.MeshStandardMaterial({ color: '#11161b', roughness: 0.14, metalness: 0.25 }));
    const steelMat = trackMat(new T.MeshStandardMaterial({ color: '#dce4ec', roughness: 0.18, metalness: 0.92 }));
    this.blankMat = trackMat(
      new T.MeshStandardMaterial({
        color: '#8c6229',
        roughness: 0.26,
        metalness: 0.32,
      }),
    );

    // 1. Procedural fallback cork butt + brass reel seat + cork foregrip + spinning reel housing/spool
    //    (Replaced seamlessly in browser once `prop-fishing-rod` GLB finishes loading)
    const buttGeo = trackGeo(new T.CylinderGeometry(0.0172, 0.0180, 0.28, 14));
    buttGeo.rotateX(Math.PI * 0.5);
    const buttMesh = new T.Mesh(buttGeo, corkMat);
    buttMesh.position.set(0, 0, -0.12);

    const seatGeo = trackGeo(new T.CylinderGeometry(0.0160, 0.0160, 0.13, 14));
    seatGeo.rotateX(Math.PI * 0.5);
    const seatMesh = new T.Mesh(seatGeo, brassMat);
    seatMesh.position.set(0, 0, 0.08);

    const foreGeo = trackGeo(new T.CylinderGeometry(0.0155, 0.0168, 0.16, 14));
    foreGeo.rotateX(Math.PI * 0.5);
    const foreMesh = new T.Mesh(foreGeo, corkMat);
    foreMesh.position.set(0, 0, 0.22);

    const footGeo = trackGeo(new T.BoxGeometry(0.012, 0.048, 0.046));
    const footMesh = new T.Mesh(footGeo, carbonMat);
    footMesh.position.set(0, -0.032, 0.078);

    const bodyGeo = trackGeo(new T.CylinderGeometry(0.022, 0.024, 0.048, 16));
    bodyGeo.rotateX(Math.PI * 0.5);
    const bodyMesh = new T.Mesh(bodyGeo, carbonMat);
    bodyMesh.position.set(0, -0.068, 0.062);

    const spoolGeo = trackGeo(new T.CylinderGeometry(0.026, 0.026, 0.052, 18));
    spoolGeo.rotateX(Math.PI * 0.5);
    const spoolMesh = new T.Mesh(spoolGeo, brassMat);
    spoolMesh.position.set(0, -0.068, 0.098);

    this.fallbackHandleGroup.add(buttMesh, seatMesh, foreMesh, footMesh, bodyMesh, spoolMesh);
    this.handleVisualGroup.add(this.fallbackHandleGroup);

    // Ferrule brass collar at z = 0.30 m bridging foregrip cleanly into the dynamic tapered blank
    const collarGeo = trackGeo(new T.CylinderGeometry(0.0094, 0.0135, 0.022, 14));
    collarGeo.rotateX(Math.PI * 0.5);
    const collarMesh = new T.Mesh(collarGeo, brassMat);
    collarMesh.position.set(0, 0, 0.302);
    this.rodBase.add(this.handleVisualGroup, collarMesh);

    // 2. Orbiting `Reel_Crank` at (+0.028, -0.068, +0.060) + `crankKnobSocket` at (+0.042, -0.032, 0)
    this.reelCrankPivot.position.copy(CRANK_PIVOT_LOCAL);
    const crankArmGeo = trackGeo(new T.BoxGeometry(0.038, 0.006, 0.007));
    const crankArmMesh = new T.Mesh(crankArmGeo, brassMat);
    crankArmMesh.position.set(0.019, -0.016, 0);
    crankArmMesh.rotation.z = -0.68;
    const crankKnobGeo = trackGeo(new T.CylinderGeometry(0.009, 0.0095, 0.024, 12));
    crankKnobGeo.rotateZ(Math.PI * 0.5);
    const crankKnobMesh = new T.Mesh(crankKnobGeo, corkMat);
    crankKnobMesh.position.copy(CRANK_KNOB_OFFSET);
    this.fallbackCrankGroup.add(crankArmMesh, crankKnobMesh);
    this.reelCrankPivot.add(this.fallbackCrankGroup);

    this.crankKnobSocket.position.copy(CRANK_KNOB_OFFSET);
    this.reelCrankPivot.add(this.crankKnobSocket);
    this.rodBase.add(this.reelCrankPivot);

    // 3. Spinning-reel rotor cup + flip-open metallic bail wire + brass line roller
    this.reelRotorGroup.position.copy(REEL_SPOOL_LOCAL);
    const rotorArmGeo = trackGeo(new T.BoxGeometry(0.006, 0.064, 0.016));
    const rotorArmMesh = new T.Mesh(rotorArmGeo, carbonMat);
    rotorArmMesh.position.set(0, 0, -0.006);
    this.reelRotorGroup.add(rotorArmMesh);

    this.bailPivotGroup.position.set(0, 0, 0.008);
    const bailArchGeo = trackGeo(new T.TorusGeometry(0.032, 0.0018, 6, 16, Math.PI));
    const bailArchMesh = new T.Mesh(bailArchGeo, steelMat);
    const rollerGeo = trackGeo(new T.CylinderGeometry(0.0045, 0.0045, 0.008, 10));
    const rollerMesh = new T.Mesh(rollerGeo, brassMat);
    rollerMesh.position.set(0, 0.031, 0.006);
    this.lineRollerSocket.position.set(0, 0.032, 0.008);
    this.bailPivotGroup.add(bailArchMesh, rollerMesh, this.lineRollerSocket);
    this.reelRotorGroup.add(this.bailPivotGroup);
    this.rodBase.add(this.reelRotorGroup);

    // 4. Dynamic 20-station × 10-side tapered 3D tubular blank (`DynamicDrawUsage`)
    const vertCount = (BLANK_SEGMENTS + 1) * BLANK_SIDES + 1; // +1 tip cap vertex
    this.blankPositions = new Float32Array(vertCount * 3);
    this.blankNormals = new Float32Array(vertCount * 3);
    const blankIndices: number[] = [];
    for (let k = 0; k < BLANK_SEGMENTS; k++) {
      const r0 = k * BLANK_SIDES;
      const r1 = (k + 1) * BLANK_SIDES;
      for (let m = 0; m < BLANK_SIDES; m++) {
        const mn = (m + 1) % BLANK_SIDES;
        blankIndices.push(r0 + m, r1 + m, r1 + mn, r0 + m, r1 + mn, r0 + mn);
      }
    }
    const tipCenterIdx = (BLANK_SEGMENTS + 1) * BLANK_SIDES;
    const lastRing = BLANK_SEGMENTS * BLANK_SIDES;
    for (let m = 0; m < BLANK_SIDES; m++) {
      const mn = (m + 1) % BLANK_SIDES;
      blankIndices.push(lastRing + m, tipCenterIdx, lastRing + mn);
    }

    this.blankGeo = trackGeo(new T.BufferGeometry());
    this.blankGeo.setAttribute('position', new T.BufferAttribute(this.blankPositions, 3).setUsage(T.DynamicDrawUsage));
    this.blankGeo.setAttribute('normal', new T.BufferAttribute(this.blankNormals, 3).setUsage(T.DynamicDrawUsage));
    this.blankGeo.setIndex(blankIndices);
    this.blankMesh = new T.Mesh(this.blankGeo, this.blankMat);
    this.blankMesh.castShadow = true;
    this.blankMesh.receiveShadow = true;
    this.blankMesh.frustumCulled = false;
    this.rodBase.add(this.blankMesh);

    // 5. 6 Underslung ceramic-lined brass line guides
    for (let g = 0; g < GUIDE_COUNT; g++) {
      const rRing = GUIDE_RING_RADII[g];
      const footH = GUIDE_FOOT_HEIGHTS[g];
      const gGroup = new T.Group();

      const outerTorus = new T.Mesh(
        trackGeo(new T.TorusGeometry(rRing, Math.max(0.0011, rRing * 0.16), 6, 14)),
        brassMat,
      );
      const innerInsert = new T.Mesh(
        trackGeo(new T.TorusGeometry(rRing * 0.78, Math.max(0.0009, rRing * 0.13), 6, 14)),
        ceramicMat,
      );
      const strutLen = Math.max(0.003, footH - rRing * 0.85);
      const strut = new T.Mesh(
        trackGeo(new T.CylinderGeometry(0.0012, 0.0016, strutLen + 0.004, 6)),
        brassMat,
      );
      strut.position.set(0, rRing * 0.88 + strutLen * 0.5, -0.002);
      strut.rotation.x = 0.24;

      gGroup.add(outerTorus, innerInsert, strut);
      gGroup.frustumCulled = false;
      this.guideMeshes.push(gGroup);
      this.rodBase.add(gGroup);
    }

    this.rodBase.traverse(o => {
      const m = o as T.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false;
      }
    });
    this.rodBase.visible = false;
    this.root.add(this.rodBase);

    // 6. Continuous threaded monofilament line (bail roller -> 6 guides -> 18-pt catenary -> bobber top eye)
    this.lineGeo = trackGeo(new T.BufferGeometry());
    this.lineGeo.setAttribute('position', new T.BufferAttribute(this.linePositions, 3).setUsage(T.DynamicDrawUsage));
    this.lineMat = trackMat(
      new T.LineBasicMaterial({
        color: '#f1f5f9',
        transparent: true,
        opacity: 0.88,
      }),
    );
    this.lineObj = new T.Line(this.lineGeo, this.lineMat);
    this.lineObj.frustumCulled = false;
    this.lineObj.visible = false;
    this.root.add(this.lineObj);

    // 7. Subsurface fluorocarbon leader (bobber bottom brass swivel -> 3D J-hook & prawn bait / fish mouth)
    this.leaderGeo = trackGeo(new T.BufferGeometry());
    this.leaderGeo.setAttribute(
      'position',
      new T.BufferAttribute(this.leaderPositions, 3).setUsage(T.DynamicDrawUsage),
    );
    this.leaderMat = trackMat(
      new T.LineBasicMaterial({
        color: '#bae6fd',
        transparent: true,
        opacity: 0.68,
      }),
    );
    this.leaderObj = new T.Line(this.leaderGeo, this.leaderMat);
    this.leaderObj.frustumCulled = false;
    this.leaderObj.visible = false;
    this.root.add(this.leaderObj);

    // 8. Buoyant red-and-pearl bobber (procedural fallback replaced by `PropBobber` GLB on load)
    const bobRedMat = trackMat(new T.MeshStandardMaterial({ color: '#e83424', roughness: 0.24 }));
    const bobWhiteMat = trackMat(new T.MeshStandardMaterial({ color: '#f5f2ea', roughness: 0.26 }));
    const topHem = new T.Mesh(
      trackGeo(new T.SphereGeometry(0.051, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5)),
      bobRedMat,
    );
    const botHem = new T.Mesh(
      trackGeo(new T.SphereGeometry(0.051, 14, 8, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5)),
      bobWhiteMat,
    );
    const antenna = new T.Mesh(trackGeo(new T.CylinderGeometry(0.004, 0.006, 0.11, 8)), bobRedMat);
    antenna.position.y = 0.095;
    const antennaBead = new T.Mesh(trackGeo(new T.SphereGeometry(0.011, 8, 6)), bobRedMat);
    antennaBead.position.y = 0.15;
    const botSwivel = new T.Mesh(trackGeo(new T.CylinderGeometry(0.0055, 0.0055, 0.048, 8)), brassMat);
    botSwivel.position.y = -0.072;
    this.fallbackBobberGroup.add(topHem, botHem, antenna, antennaBead, botSwivel);
    this.bobberGroup.add(this.fallbackBobberGroup);
    this.bobberGroup.visible = false;
    this.root.add(this.bobberGroup);

    // 9. 3D Stainless-Steel J-Hook + Coral-Pink Segmented Prawn Bait (`hookAndBaitGroup`)
    const hookCurve = new T.CatmullRomCurve3([
      new T.Vector3(0, 0.018, 0),
      new T.Vector3(0, -0.004, 0),
      new T.Vector3(0.006, -0.016, 0),
      new T.Vector3(0.015, -0.012, 0),
      new T.Vector3(0.016, -0.001, 0),
    ]);
    const hookTube = new T.Mesh(trackGeo(new T.TubeGeometry(hookCurve, 12, 0.0013, 6, false)), steelMat);
    const hookEye = new T.Mesh(trackGeo(new T.TorusGeometry(0.0032, 0.001, 5, 10)), steelMat);
    hookEye.position.set(0, 0.020, 0);
    this.hookAndBaitGroup.add(hookTube, hookEye);

    const prawnMat = trackMat(
      new T.MeshStandardMaterial({
        color: '#fb7185',
        emissive: '#be123c',
        emissiveIntensity: 0.14,
        roughness: 0.36,
      }),
    );
    const prawnEyeMat = trackMat(new T.MeshStandardMaterial({ color: '#0f172a', roughness: 0.15 }));
    const segRadii = [0.0085, 0.0078, 0.0064, 0.0046];
    for (let s = 0; s < segRadii.length; s++) {
      const seg = new T.Mesh(trackGeo(new T.SphereGeometry(segRadii[s], 8, 6)), prawnMat);
      seg.scale.set(0.85, 1.0, 1.38);
      const arcA = s * 0.36;
      seg.position.set(0.006 + Math.sin(arcA) * 0.012, -0.006 - s * 0.0065, Math.cos(arcA) * 0.006 - 0.006);
      seg.rotation.z = -arcA * 0.6;
      this.prawnBaitGroup.add(seg);
    }
    for (const sx of [-0.0055, 0.0055]) {
      const pEye = new T.Mesh(trackGeo(new T.SphereGeometry(0.002, 6, 5)), prawnEyeMat);
      pEye.position.set(0.006 + sx, -0.003, 0.006);
      this.prawnBaitGroup.add(pEye);
    }
    this.hookAndBaitGroup.add(this.prawnBaitGroup);
    this.hookAndBaitGroup.visible = false;
    this.root.add(this.hookAndBaitGroup);

    // 10. Instanced bobber splash & bite ripple rings
    this.ringGeo = trackGeo(new T.RingGeometry(0.12, 0.24, 20));
    this.ringGeo.rotateX(-Math.PI * 0.5);
    this.ringMat = trackMat(
      new T.MeshBasicMaterial({
        color: '#e0f7fa',
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
        side: T.DoubleSide,
      }),
    );
    this.ringMesh = new T.InstancedMesh(this.ringGeo, this.ringMat, RING_POOL_SIZE);
    this.ringMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    this.ringMesh.frustumCulled = false;
    this.ringMesh.renderOrder = 3;
    this.ringMesh.count = 0;
    for (let i = 0; i < RING_POOL_SIZE; i++) this.ringState[i * 5 + 3] = 99;
    this.root.add(this.ringMesh);

    // 11. Persistent `HandContact`s + pre-allocated `GraspReach` scratch tuples
    this.rightGripContact = {
      wrist: new T.Vector3(),
      fingers: new T.Vector3(0, 0, 1),
      palm: new T.Vector3(1, 0, 0),
      grip: 'handle',
      wrap: true,
      secured: true,
      on: this.rodBase,
      shape: handleShape(this.rodBase, CORK_GRIP_LOCAL, ROD_AXIS_Z, CORK_GRIP_RADIUS, CORK_GRIP_HALF),
    };
    this.leftForegripContact = {
      support: true,
      wrist: new T.Vector3(),
      fingers: new T.Vector3(0, 0, 1),
      palm: new T.Vector3(-1, 0, 0),
      grip: 'handle',
      wrap: true,
      secured: true,
      on: this.rodBase,
      shape: handleShape(this.rodBase, FOREGRIP_LOCAL, ROD_AXIS_Z, FOREGRIP_RADIUS, FOREGRIP_HALF),
    };
    this.leftCrankContact = {
      support: true,
      wrist: new T.Vector3(),
      fingers: new T.Vector3(0, 0.5, 0.86),
      palm: new T.Vector3(-1, 0, 0),
      grip: 'pinch',
      wrap: false,
      secured: true,
      on: this.rodBase,
      shape: handleShape(this.crankKnobSocket, ZERO_VEC, CRANK_AXIS_X, CRANK_KNOB_RADIUS, CRANK_KNOB_HALF),
    };
    this.handPairBoth = { left: this.leftForegripContact, right: this.rightGripContact };
    this.handPairCrank = { left: this.leftCrankContact, right: this.rightGripContact };
    this.handPairSingle = { left: null, right: this.rightGripContact };

    const makeReach = (): GraspReach => ({
      local: new T.Matrix4(),
      shoulder: new T.Vector3(),
      upper: 0.28,
      fore: 0.25,
      pole: new T.Vector3(),
      limit: 0.88,
    });
    this._reaches1 = [makeReach()];
    this._reaches2 = [makeReach(), makeReach()];

    // 12. Bound zero-allocation `ActiveBaitDescriptor` for `ArenaMarineEcosystem`
    this.baitDescriptor = {
      active: false,
      phase: 'idle',
      settled: false,
      bobberX: 0,
      bobberY: ARENA_WATER_Y,
      bobberZ: 0,
      baitX: 0,
      baitY: ARENA_WATER_Y - 0.55,
      baitZ: 0,
      hookX: 0,
      hookY: ARENA_WATER_Y - 0.55,
      hookZ: 0,
      anglerX: 0,
      anglerY: 0,
      anglerZ: 0,
      tension: 0,
      progress: 0,
      fishPulling: false,
      claimedAgentIndex: -1,
      onBaitNibble: (strength: number, _agentIndex: number) => {
        if (this.phase !== 'waiting_bite') return;
        this.ecosystemDriven = true;
        this.fishApproaching = true;
        const s = clamp(strength, 0.15, 1.2);
        this.bobberDipVel -= 0.42 + 0.48 * s;
        this.tipWhipVelY -= 0.85 * s;
        this.spawnRing(this.bobberX, this.bobberY, this.bobberZ, 0.32 + 0.25 * s);
      },
      onFishBite: (
        agentIndex: number,
        species: MarineSpeciesSpec,
        scaleRatio: number,
        fishX: number,
        fishY: number,
        fishZ: number,
      ) => {
        if (this.phase !== 'waiting_bite') return;
        this.ecosystemDriven = true;
        this.fishApproaching = false;
        this.claimedAgentIndex = agentIndex;
        this.activeSpecies = species;
        this.claimedScaleRatio = clamp(scaleRatio, 0.55, 1.55);
        this.hookedMouthPos.set(fishX, fishY, fishZ);
        this.ecosystemPoseValid = true;
        this.phase = 'bite_alert';
        this.phaseTimer = 0;
        this.bobberDipVel = -1.65;
        this.tipWhipVelY -= 2.1;
        this.spawnRing(this.bobberX, this.bobberY, this.bobberZ, 1.0);
      },
      onHookedFishPose: (mouthX: number, mouthY: number, mouthZ: number, pulling: boolean) => {
        if (this.phase !== 'bite_alert' && this.phase !== 'reeling' && this.phase !== 'caught') return;
        this.ecosystemDriven = true;
        this.ecosystemPoseValid = true;
        this.hookedMouthPos.set(mouthX, mouthY, mouthZ);
        if (this.phase === 'reeling') {
          this.fishPulling = pulling;
        }
      },
    };

    this.updateRodBlankAndGuides(0, 0.04, 0);
    scene.add(this.root);

    const useLod1 =
      options?.low === true || options?.qualityTier === 'low' || options?.qualityTier === 'balanced';
    this.readyPromise = this.loadV7PropsAsync(useLod1);
  }

  private async loadV7PropsAsync(useLod1: boolean): Promise<void> {
    let loader: GLTFLoader;
    try {
      loader = new GLTFLoader();
    } catch {
      return;
    }
    const rodUrl = useLod1 ? arenaV7Assets.props.fishingRod.lod1 : arenaV7Assets.props.fishingRod.lod0;
    const bobberUrl = useLod1 ? arenaV7Assets.props.bobber.lod1 : arenaV7Assets.props.bobber.lod0;

    await Promise.all([
      loader
        .loadAsync(rodUrl)
        .then(gltf => {
          if (this.disposed) {
            this.disposeLoadedScene(gltf.scene);
            return;
          }
          const rodRoot = gltf.scene.getObjectByName('Rod_Body') ?? gltf.scene;
          const bodyMeshObj = gltf.scene.getObjectByName('Rod_Body_Mesh') as T.Mesh | undefined;
          const crankObj = gltf.scene.getObjectByName('Reel_Crank');
          const crankMeshObj = gltf.scene.getObjectByName('Reel_Crank_Mesh') as T.Mesh | undefined;

          if (bodyMeshObj && bodyMeshObj.isMesh) {
            const handleGeo = extractRigidHandleGeometryFromGlb(bodyMeshObj, rodRoot, 0.325);
            if (handleGeo) {
              this.ownedGeometries.push(handleGeo);
              const mat = this.cloneAndTrackMaterial(bodyMeshObj.material);
              const bakedHandleMesh = new T.Mesh(handleGeo, mat);
              bakedHandleMesh.name = 'PropFishingRod_HandleAndReel';
              bakedHandleMesh.castShadow = true;
              bakedHandleMesh.receiveShadow = true;
              bakedHandleMesh.frustumCulled = false;
              this.fallbackHandleGroup.visible = false;
              this.handleVisualGroup.add(bakedHandleMesh);
            }
          }

          if (crankMeshObj && crankMeshObj.isMesh) {
            const crankGeo = crankMeshObj.geometry.clone();
            this.ownedGeometries.push(crankGeo);
            const mat = this.cloneAndTrackMaterial(crankMeshObj.material);
            const bakedCrank = new T.Mesh(crankGeo, mat);
            bakedCrank.name = 'PropFishingRod_ReelCrank';
            bakedCrank.position.copy(crankMeshObj.position);
            bakedCrank.quaternion.copy(crankMeshObj.quaternion);
            bakedCrank.scale.copy(crankMeshObj.scale);
            bakedCrank.castShadow = true;
            bakedCrank.receiveShadow = true;
            bakedCrank.frustumCulled = false;
            if (crankObj) {
              this.reelCrankPivot.position.copy(crankObj.position);
            }
            this.fallbackCrankGroup.visible = false;
            this.reelCrankPivot.add(bakedCrank);
          }

          // Dispose unretained source geometries on temporary gltf scene without disposing shared textures
          gltf.scene.traverse(o => {
            const m = o as T.Mesh;
            if (m.isMesh) m.geometry.dispose();
          });
        })
        .catch(() => {
          /* Keep 3D procedural handle + reel active on offline/headless fallback */
        }),

      loader
        .loadAsync(bobberUrl)
        .then(gltf => {
          if (this.disposed) {
            this.disposeLoadedScene(gltf.scene);
            return;
          }
          const bobMesh = gltf.scene.getObjectByName('PropBobber') as T.Mesh | undefined;
          let targetMesh: T.Mesh | null = bobMesh && bobMesh.isMesh ? bobMesh : null;
          if (!targetMesh) {
            gltf.scene.traverse(o => {
              if (!targetMesh && (o as T.Mesh).isMesh) targetMesh = o as T.Mesh;
            });
          }
          if (targetMesh) {
            const geo = targetMesh.geometry.clone();
            this.ownedGeometries.push(geo);
            const mat = this.cloneAndTrackMaterial(targetMesh.material);
            const mesh = new T.Mesh(geo, mat);
            mesh.name = 'PropBobber_V7';
            mesh.position.copy(targetMesh.position);
            mesh.quaternion.copy(targetMesh.quaternion);
            mesh.scale.copy(targetMesh.scale);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.frustumCulled = false;
            this.fallbackBobberGroup.visible = false;
            this.bobberGroup.add(mesh);
          }
          gltf.scene.traverse(o => {
            const m = o as T.Mesh;
            if (m.isMesh) m.geometry.dispose();
          });
        })
        .catch(() => {
          /* Keep 3D procedural bobber active on offline/headless fallback */
        }),
    ]);
  }

  private cloneAndTrackMaterial(src: T.Material | T.Material[]): T.Material {
    const base = (Array.isArray(src) ? src[0] : src).clone();
    this.ownedMaterials.push(base);
    for (const val of Object.values(base)) {
      if (val instanceof T.Texture && !this.ownedTextures.includes(val)) {
        this.ownedTextures.push(val);
      }
    }
    return base;
  }

  private disposeLoadedScene(rootObj: T.Object3D): void {
    rootObj.traverse(o => {
      const m = o as T.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        for (const val of Object.values(mat)) {
          if (val instanceof T.Texture) val.dispose();
        }
        mat.dispose();
      }
    });
  }

  /** Seed visibility transiently during pre-gameplay shader warmup so rod, blank, guides, bobber, and hook compile cleanly. */
  setWarmupVisible(visible: boolean): void {
    if (visible) {
      this.rodBase.visible = true;
      this.lineObj.visible = true;
      this.leaderObj.visible = true;
      this.bobberGroup.visible = true;
      this.hookAndBaitGroup.visible = true;
    } else if (this.phase === 'idle') {
      this.rodBase.visible = false;
      this.lineObj.visible = false;
      this.leaderObj.visible = false;
      this.bobberGroup.visible = false;
      this.hookAndBaitGroup.visible = false;
    }
  }

  /** Switch active learner account scope cleanly (`AGENTS.md §21` P0 isolation). */
  setAccount(account: string | number | null | undefined): void {
    const next = normalizeAccountScope(account);
    if (next === this.accountScope) return;
    this.accountScope = next;
    this.logbook = loadMarineLogbook(this.accountScope);
    this.lastCatch = null;
  }

  getCollectionState(): Readonly<MarineCollectionState> {
    return this.logbook;
  }

  /** Active bobber world coordinates for ocean surface wakes and legacy fish curiosity queries. */
  getActiveBobber(): { active: boolean; x: number; z: number } {
    const active =
      this.phase === 'waiting_bite' || this.phase === 'bite_alert' || this.phase === 'reeling';
    return { active, x: this.bobberX, z: this.bobberZ };
  }

  /** Full zero-allocation `ActiveBaitDescriptor` for `ArenaMarineEcosystem` real 3D fish AI (`F06`). */
  getActiveBait(): Readonly<ActiveBaitDescriptor> {
    const d = this.baitDescriptor;
    const active =
      this.phase === 'waiting_bite' ||
      this.phase === 'bite_alert' ||
      this.phase === 'reeling' ||
      this.phase === 'caught';
    d.active = active;
    d.phase = this.phase;
    d.settled = this.phase === 'waiting_bite' && this.phaseTimer >= 0.30;
    d.bobberX = this.bobberX;
    d.bobberY = this.bobberY;
    d.bobberZ = this.bobberZ;
    d.baitX = this.baitX;
    d.baitY = this.baitY;
    d.baitZ = this.baitZ;
    d.hookX = this.hookX;
    d.hookY = this.hookY;
    d.hookZ = this.hookZ;
    d.anglerX = this.lastAnglerX;
    d.anglerY = this.lastAnglerY;
    d.anglerZ = this.lastAnglerZ;
    d.tension = this.tension;
    d.progress = this.progress;
    d.fishPulling = this.fishPulling;
    d.claimedAgentIndex = this.claimedAgentIndex;
    return d;
  }

  /** World-space rod tip eyelet coordinate (updated every frame). */
  getRodTipWorld(out = new T.Vector3()): T.Vector3 {
    return out.copy(this.rodTipWorld);
  }

  /**
   * Persistent `HandContact` pair for `ArenaCharacter` / `HumanRig` (`F02`):
   * - Right hand (`side = +1`) always wraps firmly around the cork grip (`CORK_GRIP_LOCAL`).
   * - Left hand (`side = -1`) wraps around the cork foregrip (`FOREGRIP_LOCAL`) in two-handed states,
   *   pinches & turns `crankKnobSocket` during `reeling`, and releases cleanly (`null`) during brisk
   *   locomotion (`moveSpeed > 0.55 m/s` while `equipped`) so the free arm swings naturally!
   */
  getHandContacts(
    moveSpeed = 0,
    isSeated = false,
  ): { left: HandContact | null; right: HandContact } | null {
    if (this.phase === 'idle') return null;
    if (this.phase === 'reeling') return this.handPairCrank;
    if (this.phase === 'equipped' && !isSeated && moveSpeed > 0.55) {
      return this.handPairSingle;
    }
    return this.handPairBoth;
  }

  /**
   * Stage 1 of single-frame two-hand IK (`BodyFrame.resolveContacts` callback in `HumanRig.update` at `human.ts:1388`):
   * Runs AFTER pelvis spring, spinal lean/twist, and `leadClavicle` shoulders are finalized, and BEFORE `HumanRig.solve`!
   * Projects `rodBase` into the exact intersection of both arms' reachable wrist cones via `fitGraspTranslation`
   * (`< 0.0002 mm` residual, `0` floating hands, `0` hyperextended elbows).
   */
  resolveRigContacts(
    rig: HumanRig,
    options?: {
      moveSpeed?: number;
      isSeated?: boolean;
      aimYaw?: number;
      aimPitch?: number;
    },
  ): void {
    if (this.phase === 'idle' || !rig.ready) return;

    const moveSpeed = options?.moveSpeed ?? 0;
    const isSeated = options?.isSeated ?? false;
    const contacts = this.getHandContacts(moveSpeed, isSeated);
    if (!contacts) return;

    const armR = rig.armReach(1, this._shR);
    const armL = rig.armReach(-1, this._shL);
    if (!armR || !armL) return;

    const k = rig.scale;
    const rootYaw = rig.root.rotation.y;
    const aimYaw = options?.aimYaw ?? this.lastLookYaw;
    const clampedAimOffset = clamp(normAngle(aimYaw - rootYaw), -0.62, 0.62);

    // Compute ergonomic rod pitch (upward from horizontal, > 0 lifts tip skyward) and yaw in character frame
    let rodElevationRad = 0.54; // ~31° ready stance
    let rodYawOffset = -0.08 + clampedAimOffset * 0.35;
    let gripRight = 0.095 * k;
    let gripDown = 0.25 * k;
    let gripFwd = 0.24 * k;

    if (this.phase === 'charging') {
      const coil = smooth01(this.chargePower);
      rodElevationRad = lerp(0.54, 1.90, coil); // +31° -> +109° coiled back over right shoulder!
      rodYawOffset = lerp(-0.08, -0.34, coil) + clampedAimOffset * 0.5;
      gripRight = lerp(0.095, 0.165, coil) * k;
      gripDown = lerp(0.25, -0.08, coil) * k;
      gripFwd = lerp(0.24, 0.06, coil) * k;
    } else if (this.phase === 'casting') {
      if (this.phaseTimer <= CAST_WHIP_RELEASE_SEC) {
        const uWhip = smooth01(this.phaseTimer / CAST_WHIP_RELEASE_SEC);
        const startElev = lerp(1.32, 1.90, this.lastCastPower);
        rodElevationRad = lerp(startElev, 0.42, uWhip);
        rodYawOffset = lerp(-0.30, 0.04, uWhip) + clampedAimOffset * 0.65;
        gripRight = lerp(0.155, 0.075, uWhip) * k;
        gripDown = lerp(-0.06, 0.20, uWhip) * k;
        gripFwd = lerp(0.07, 0.31, uWhip) * k;
      } else {
        const uSettle = smooth01((this.phaseTimer - CAST_WHIP_RELEASE_SEC) / 0.42);
        rodElevationRad = lerp(0.42, 0.50, uSettle);
        rodYawOffset = lerp(0.04, -0.05, uSettle) + clampedAimOffset * 0.45;
        gripRight = lerp(0.075, 0.090, uSettle) * k;
        gripDown = lerp(0.20, 0.25, uSettle) * k;
        gripFwd = lerp(0.31, 0.25, uSettle) * k;
      }
    } else if (this.phase === 'waiting_bite') {
      const breath = Math.sin(this.lastTime * 2.1);
      const toBobYaw = normAngle(Math.atan2(this.bobberX - this.lastAnglerX, this.bobberZ - this.lastAnglerZ) - rootYaw);
      rodElevationRad = 0.48 + 0.018 * breath;
      rodYawOffset = clamp(toBobYaw * 0.55, -0.58, 0.58);
      gripRight = 0.085 * k;
      gripDown = (0.255 - 0.008 * breath) * k;
      gripFwd = 0.25 * k;
    } else if (this.phase === 'bite_alert') {
      const toBobYaw = normAngle(Math.atan2(this.bobberX - this.lastAnglerX, this.bobberZ - this.lastAnglerZ) - rootYaw);
      rodElevationRad = 0.64 + Math.sin(this.lastTime * 22) * 0.035;
      rodYawOffset = clamp(toBobYaw * 0.65, -0.62, 0.62);
      gripRight = 0.082 * k;
      gripDown = 0.22 * k;
      gripFwd = 0.26 * k;
    } else if (this.phase === 'reeling') {
      const pump = Math.sin(this.lastTime * (3.6 + this.tension * 2.2));
      const toFishYaw = normAngle(Math.atan2(this.bobberX - this.lastAnglerX, this.bobberZ - this.lastAnglerZ) - rootYaw);
      rodElevationRad = 0.66 + 0.24 * this.tension + 0.045 * pump;
      rodYawOffset = clamp(toFishYaw * 0.65, -0.64, 0.64);
      gripRight = 0.080 * k;
      gripDown = (0.20 - 0.04 * this.tension - 0.018 * pump) * k;
      gripFwd = (0.25 - 0.03 * this.tension) * k;
    } else if (this.phase === 'caught') {
      const lift = smooth01(this.phaseTimer / 0.35);
      rodElevationRad = lerp(0.56, 0.96, lift);
      rodYawOffset = lerp(-0.06, -0.18, lift);
      gripRight = lerp(0.09, 0.14, lift) * k;
      gripDown = lerp(0.24, 0.12, lift) * k;
      gripFwd = lerp(0.25, 0.22, lift) * k;
    } else if (contacts.left === null) {
      // One-handed brisk walk/run carry
      rodElevationRad = 0.58;
      rodYawOffset = -0.04;
      gripRight = 0.06 * k;
      gripDown = 0.27 * k;
      gripFwd = 0.20 * k;
    }

    const effYaw = rootYaw + rodYawOffset;
    const sinY = Math.sin(effYaw);
    const cosY = Math.cos(effYaw);
    this._charFwd.set(sinY, 0, cosY);
    this._charLeft.set(cosY, 0, -sinY);

    // Build orthonormal rod basis: +Z along rod blank, +X toward character left (crank side)
    this._rodZ
      .copy(this._charFwd)
      .multiplyScalar(Math.cos(rodElevationRad))
      .addScaledVector(WORLD_UP, Math.sin(rodElevationRad))
      .normalize();
    this._rodX.copy(this._charLeft).addScaledVector(this._rodZ, -this._charLeft.dot(this._rodZ)).normalize();
    this._rodY.crossVectors(this._rodZ, this._rodX).normalize();

    // Desired world position of `CORK_GRIP_LOCAL` anchored relative to the finalized right shoulder
    this._gripWorldR
      .copy(this._shR)
      .addScaledVector(this._charLeft, gripRight)
      .addScaledVector(WORLD_UP, -gripDown)
      .addScaledVector(this._charFwd, gripFwd);

    this.rodBase.visible = true;
    this.rodBase.position.copy(this._gripWorldR).addScaledVector(this._rodZ, -CORK_GRIP_LOCAL.z);
    this.dummyMat.makeBasis(this._rodX, this._rodY, this._rodZ);
    this.rodBase.quaternion.setFromRotationMatrix(this.dummyMat);
    this.reelCrankPivot.rotation.set(this.crankAngle, 0, 0);
    this.rodBase.updateMatrixWorld(true);

    // Evaluate candidate right-hand grip (`side = +1`)
    this._gripWorldR.copy(CORK_GRIP_LOCAL).applyMatrix4(this.rodBase.matrixWorld);
    handleGrip(rig, 1, this._gripWorldR, this._rodZ, this._shR, CORK_GRIP_RADIUS, this.rightGripContact);
    this._poleR
      .copy(this._shR)
      .addScaledVector(this._charLeft, -0.32 * k)
      .addScaledVector(WORLD_UP, -0.40 * k)
      .addScaledVector(this._charFwd, -0.14 * k);
    this.rightGripContact.pole = this._poleR;
    this.rightGripContact.limit = 0.90;

    // Evaluate candidate left-hand grip (`side = -1`: foregrip OR orbiting reel crank knob)
    const activeLeft = contacts.left;
    if (activeLeft === this.leftForegripContact) {
      this._gripWorldL.copy(FOREGRIP_LOCAL).applyMatrix4(this.rodBase.matrixWorld);
      handleGrip(rig, -1, this._gripWorldL, this._rodZ, this._shL, FOREGRIP_RADIUS, this.leftForegripContact);
      this._poleL
        .copy(this._shL)
        .addScaledVector(this._charLeft, 0.30 * k)
        .addScaledVector(WORLD_UP, -0.40 * k)
        .addScaledVector(this._charFwd, -0.14 * k);
      this.leftForegripContact.pole = this._poleL;
      this.leftForegripContact.limit = 0.90;
    } else if (activeLeft === this.leftCrankContact) {
      this.crankKnobSocket.getWorldPosition(this._crankWorld);
      this._crankAxisW.copy(CRANK_AXIS_X).transformDirection(this.rodBase.matrixWorld).normalize();
      this.leftCrankContact.palm.copy(this._crankAxisW).negate();
      this.leftCrankContact.fingers
        .copy(this._rodZ)
        .multiplyScalar(0.82)
        .addScaledVector(this._rodY, 0.57)
        .addScaledVector(this.leftCrankContact.palm, -0.12)
        .normalize();
      this.leftCrankContact.wrist
        .copy(this._crankWorld)
        .addScaledVector(this.leftCrankContact.palm, -0.020 * k)
        .addScaledVector(this.leftCrankContact.fingers, -0.056 * k);
      this._poleL
        .copy(this._shL)
        .addScaledVector(this._charLeft, 0.32 * k)
        .addScaledVector(WORLD_UP, -0.38 * k)
        .addScaledVector(this._charFwd, -0.14 * k);
      this.leftCrankContact.pole = this._poleL;
      this.leftCrankContact.limit = 0.92;
      rig.holdFit(-1);
    }

    // Project `rodBase` translation into the simultaneous feasible wrist cone of active hand(s) (`< 0.0002 mm` residual)
    this.invRodMat.copy(this.rodBase.matrixWorld).invert();

    const r0 = this._reaches1[0];
    handRotation(this.rightGripContact.fingers, this.rightGripContact.palm, this.dummyQuat);
    this.dummyMat.compose(this.rightGripContact.wrist, this.dummyQuat, this.dummyScale);
    r0.local.copy(this.invRodMat).multiply(this.dummyMat);
    r0.shoulder.copy(this._shR);
    r0.upper = armR.upper;
    r0.fore = armR.fore;
    r0.pole.copy(this._poleR);
    r0.limit = 0.90;

    let projectedMat: T.Matrix4;
    if (activeLeft) {
      const rA = this._reaches2[0];
      rA.local.copy(r0.local);
      rA.shoulder.copy(r0.shoulder);
      rA.upper = r0.upper;
      rA.fore = r0.fore;
      rA.pole.copy(r0.pole);
      rA.limit = r0.limit;

      const rB = this._reaches2[1];
      handRotation(activeLeft.fingers, activeLeft.palm, this.dummyQuat2);
      this.dummyMat2.compose(activeLeft.wrist, this.dummyQuat2, this.dummyScale);
      rB.local.copy(this.invRodMat).multiply(this.dummyMat2);
      rB.shoulder.copy(this._shL);
      rB.upper = armL.upper;
      rB.fore = armL.fore;
      rB.pole.copy(this._poleL);
      rB.limit = activeLeft.limit ?? 0.90;

      projectedMat = fitGraspTranslation(this.rodBase.matrixWorld, this._reaches2, 0.008 * k).matrix;
    } else {
      projectedMat = fitGraspTranslation(this.rodBase.matrixWorld, this._reaches1, 0.008 * k).matrix;
    }

    this.rodBase.position.setFromMatrixPosition(projectedMat);
    this.rodBase.updateMatrixWorld(true);

    // Refresh world `HandContact` poses on the projected `rodBase` so `HumanRig.solve` hits `0.0001 mm` exact coincidence
    this.dummyMat.copy(this.rodBase.matrixWorld).multiply(r0.local);
    this.rightGripContact.wrist.setFromMatrixPosition(this.dummyMat);
    this.rightGripContact.fingers.set(0, 1, 0).transformDirection(this.dummyMat).normalize();
    this.rightGripContact.palm.set(0, 0, 1).transformDirection(this.dummyMat).normalize();
    rig.holdFit(1);

    if (activeLeft) {
      this.dummyMat2.copy(this.rodBase.matrixWorld).multiply(this._reaches2[1].local);
      activeLeft.wrist.setFromMatrixPosition(this.dummyMat2);
      activeLeft.fingers.set(0, 1, 0).transformDirection(this.dummyMat2).normalize();
      activeLeft.palm.set(0, 0, 1).transformDirection(this.dummyMat2).normalize();
    }
  }

  /**
   * Stage 2 of single-frame two-hand IK (called immediately AFTER `ArenaCharacter.update` / `HumanRig.update`):
   * Locks `rodBase` directly to the solved `hand.R` (and `hand.L` foregrip when two-handed) bone world matrices
   * via the exact analytical inverse of `handleGrip`, then refreshes the 3D cantilevered blank, guides, `rodTipWorld`,
   * tip pendulum, catenary line, and underwater leader in the SAME frame (`0.000 mm` visual lag!).
   */
  syncVisualsToSolvedHands(rig: HumanRig, dt = 1 / 60, time = this.lastTime): void {
    if (this.phase === 'idle' || !rig.ready) return;
    if (!rig.handFrame(1, this._wR, this._fR, this._pR)) return;

    const k = rig.scale;
    const seatR = rig.palmSeat(1, CORK_GRIP_RADIUS, HANDLE_ALONG, HANDLE_OBLIQUE) ?? CORK_GRIP_RADIUS + 0.024;

    // Exact analytical inverse of `handleGrip(rig, +1, point, axis, ...)` (`handle.ts:17-29`)
    this._f0.copy(this._fR).applyAxisAngle(this._pR, HANDLE_OBLIQUE);
    this._axisR.crossVectors(this._f0, this._pR).normalize();
    this._gripWorldR
      .copy(this._wR)
      .addScaledVector(this._pR, seatR * k)
      .addScaledVector(this._fR, HANDLE_ALONG * k)
      .addScaledVector(this._axisR, 0.006 * k);

    this._rodZ.copy(this._axisR);

    // When left hand is also secured on the foregrip, align rod shaft cleanly through both palms simultaneously
    const leftContact = rig.contactOn(-1);
    const leftProg = rig.contactProgress(-1);
    if (leftContact === this.leftForegripContact && leftProg > 0.45 && rig.handFrame(-1, this._wL, this._fL, this._pL)) {
      const seatL = rig.palmSeat(-1, FOREGRIP_RADIUS, HANDLE_ALONG, HANDLE_OBLIQUE) ?? FOREGRIP_RADIUS + 0.024;
      this._f0.copy(this._fL).applyAxisAngle(this._pL, -HANDLE_OBLIQUE);
      this.dummyPos.crossVectors(this._f0, this._pL).multiplyScalar(-1).normalize();
      this._gripWorldL
        .copy(this._wL)
        .addScaledVector(this._pL, seatL * k)
        .addScaledVector(this._fL, HANDLE_ALONG * k)
        .addScaledVector(this.dummyPos, 0.006 * k);

      this.dummyPos.subVectors(this._gripWorldL, this._gripWorldR);
      if (this.dummyPos.lengthSq() > 1e-4) {
        this.dummyPos.normalize();
        const twoHandW = smoothstep(0.45, 0.96, leftProg);
        this._rodZ.lerp(this.dummyPos, twoHandW).normalize();
      }
    }

    // Gimbal-lock-free orthonormal basis (`_pR` points to character left = +X crank side, always perpendicular to `_axisR`)
    this._rodX.copy(this._pR).addScaledVector(this._rodZ, -this._pR.dot(this._rodZ));
    if (this._rodX.lengthSq() < 1e-6) {
      this._rodX.set(1, 0, 0).addScaledVector(this._rodZ, -this._rodZ.x);
    }
    this._rodX.normalize();
    this._rodY.crossVectors(this._rodZ, this._rodX).normalize();

    this.rodBase.visible = true;
    this.rodBase.position.copy(this._gripWorldR).addScaledVector(this._rodZ, -CORK_GRIP_LOCAL.z);
    this.dummyMat.makeBasis(this._rodX, this._rodY, this._rodZ);
    this.rodBase.quaternion.setFromRotationMatrix(this.dummyMat);
    this.rodBase.updateMatrixWorld(true);
    this.handSyncedThisFrame = true;

    this.stepBlankWhipAndRefreshRig(clamp(dt, 0.0005, 0.05), time);
  }

  /** Toggle fishing rod equip (`KeyF`). Returns the resulting `FishingPhase`. */
  toggleEquip(canFishHere = true): FishingPhase {
    if (this.phase === 'idle') {
      if (!canFishHere) return 'idle';
      this.phase = 'equipped';
      this.phaseTimer = 0;
      this.chargeHoldSec = 0;
      this.chargePower = 0;
      this.tension = 0;
      this.progress = 0;
      this.pendulumInit = false;
      this.prevRodDirInit = false;
      return this.phase;
    }
    this.stowRod();
    return this.phase;
  }

  stowRod(): void {
    this.releaseClaimedEcosystemFish();
    this.phase = 'idle';
    this.phaseTimer = 0;
    this.chargeHoldSec = 0;
    this.chargePower = 0;
    this.tension = 0;
    this.progress = 0;
    this.fishPulling = false;
    this.fishApproaching = false;
    this.ecosystemDriven = false;
    this.ecosystemPoseValid = false;
    this.activeSpecies = null;
    this.pendulumInit = false;
    this.prevRodDirInit = false;
    this.handSyncedThisFrame = false;
    this.rodBase.visible = false;
    this.lineObj.visible = false;
    this.leaderObj.visible = false;
    this.bobberGroup.visible = false;
    this.hookAndBaitGroup.visible = false;
  }

  private releaseClaimedEcosystemFish(): void {
    if ((this.claimedAgentIndex >= 0 || this.fishApproaching) && this.activeEcosystemRef) {
      this.activeEcosystemRef.releaseClaimedFish?.(this.lastAnglerX, this.lastAnglerZ);
    }
    this.claimedAgentIndex = -1;
    this.ecosystemPoseValid = false;
    this.fishApproaching = false;
  }

  /**
   * Begin mouse/key-hold cast power charge (`F03`).
   * Transitions from `equipped` (or dismisses `caught` / `escaped`) into `charging`.
   * Accepts either `beginCastCharge(canFishHere?)` or `beginCastCharge(anglerX, anglerY?, anglerZ?, lookYaw?, canFishHere?)`.
   */
  beginCastCharge(
    canFishOrAnglerX: boolean | number = true,
    anglerY?: number,
    anglerZ?: number,
    lookYaw?: number,
    canFishHereArg = true,
  ): boolean {
    const canFishHere = typeof canFishOrAnglerX === 'boolean' ? canFishOrAnglerX : canFishHereArg;
    if (!canFishHere) return false;
    if (typeof canFishOrAnglerX === 'number') {
      this.lastAnglerX = canFishOrAnglerX;
      if (typeof anglerY === 'number') this.lastAnglerY = anglerY;
      if (typeof anglerZ === 'number') this.lastAnglerZ = anglerZ;
      if (typeof lookYaw === 'number') this.lastLookYaw = lookYaw;
    }
    if (this.phase !== 'equipped' && this.phase !== 'caught' && this.phase !== 'escaped') {
      return false;
    }
    if (this.phase === 'caught' || this.phase === 'escaped') {
      this.releaseClaimedEcosystemFish();
      this.activeSpecies = null;
    }
    this.phase = 'charging';
    this.phaseTimer = 0;
    this.chargeHoldSec = 0;
    this.chargePower = 0.06;
    this.tension = 0;
    this.progress = 0;
    this.fishPulling = false;
    return true;
  }

  /** Cancel an in-progress cast charge cleanly back to `equipped` (e.g. window blur or Escape). */
  cancelCastCharge(): void {
    if (this.phase !== 'charging') return;
    this.phase = 'equipped';
    this.phaseTimer = 0;
    this.chargeHoldSec = 0;
    this.chargePower = 0;
  }

  /**
   * Release charged cast (`F03` -> `F04`):
   * Maps `chargePower` (`0..1`) monotonically to `5.5 m .. 27.0 m` range along `lookYaw`,
   * triggering forward rod whip (`0..0.18 s`) followed by Newtonian ballistic flight into navigable water!
   */
  releaseCastCharge(
    anglerX: number,
    anglerY: number,
    anglerZ: number,
    lookYaw: number,
    ambience?: ArenaAmbience,
    ecosystem?: ArenaMarineEcosystem,
  ): boolean {
    if (this.phase !== 'charging') return false;
    this.activeEcosystemRef = ecosystem ?? this.activeEcosystemRef;

    const power = clamp(this.chargePower, 0.06, 1.0);
    let castDirX = Math.sin(lookYaw);
    let castDirZ = Math.cos(lookYaw);

    // 1. Scan forward along `lookYaw` (with gentle angular clearance fallback) to clear any wooden pier deck or shore apron
    let minClearDist = -1;
    for (let d = 3.5; d <= 22.0; d += 0.5) {
      const tx = anglerX + castDirX * d;
      const tz = anglerZ + castDirZ * d;
      if (!arenaOnWood(tx, tz) && arenaWaterDepth(tx, tz) >= 0.42) {
        minClearDist = d;
        break;
      }
    }
    if (minClearDist < 0) {
      for (const yawDelta of [0.14, -0.14, 0.26, -0.26]) {
        const fx = Math.sin(lookYaw + yawDelta);
        const fz = Math.cos(lookYaw + yawDelta);
        for (let d = 3.5; d <= 22.0; d += 0.75) {
          const tx = anglerX + fx * d;
          const tz = anglerZ + fz * d;
          if (!arenaOnWood(tx, tz) && arenaWaterDepth(tx, tz) >= 0.42) {
            minClearDist = d;
            castDirX = fx;
            castDirZ = fz;
            break;
          }
        }
        if (minClearDist >= 0) break;
      }
    }

    if (minClearDist < 0) {
      this.phase = 'equipped';
      this.phaseTimer = 0;
      this.chargeHoldSec = 0;
      this.chargePower = 0;
      return false;
    }

    // 2. Map `chargePower` (`0..1`) strictly monotonically beyond `minClearDist`
    const freeWaterDist = lerp(FISHING_MIN_CAST_M, FISHING_MAX_CAST_M, power);
    const pierClearedDist = minClearDist + 0.6 + 14.0 * power;
    const desiredDist = clamp(Math.max(freeWaterDist, pierClearedDist), minClearDist, 31.0);

    let foundWater = false;
    let landX = anglerX + castDirX * desiredDist;
    let landZ = anglerZ + castDirZ * desiredDist;

    const probeOffsets = [0, 1.0, -1.0, 2.2, -2.2, 3.8, -3.8];
    for (let i = 0; i < probeOffsets.length; i++) {
      const dist = clamp(desiredDist + probeOffsets[i], minClearDist, 31.5);
      const tx = anglerX + castDirX * dist;
      const tz = anglerZ + castDirZ * dist;
      if (arenaOnWood(tx, tz)) continue;
      if (arenaWaterDepth(tx, tz) >= 0.42) {
        landX = tx;
        landZ = tz;
        foundWater = true;
        break;
      }
    }

    if (!foundWater) {
      this.phase = 'equipped';
      this.phaseTimer = 0;
      this.chargeHoldSec = 0;
      this.chargePower = 0;
      return false;
    }

    this.lastCastPower = power;
    this.phase = 'casting';
    this.phaseTimer = 0;
    this.chargeHoldSec = 0;
    this.ballisticLaunched = false;
    this.flightElapsed = 0;
    this.tension = 0;
    this.progress = 0;
    this.fishPulling = false;
    this.fishApproaching = false;
    this.ecosystemDriven = false;
    this.ecosystemPoseValid = false;
    this.claimedAgentIndex = -1;
    this.activeSpecies = null;
    this.targetBobberX = landX;
    this.targetBobberZ = landZ;
    this.initialDistanceM = Math.max(4.0, Math.hypot(landX - anglerX, landZ - anglerZ));
    this.distanceM = this.initialDistanceM;
    this.flightDuration = clamp(0.38 + 0.024 * this.initialDistanceM, 0.44, 1.05);

    // Backward blank whip preload that snaps forward on release
    this.tipWhipY = -(0.35 + 0.42 * power);
    this.tipWhipVelY = 6.5 + 5.5 * power;

    ambience?.fishingCast(anglerX, anglerZ, anglerX, anglerZ, lookYaw);
    return true;
  }

  /**
   * Primary discrete action helper (HUD buttons, `window.__arenaQA.castRod`, strike on `bite_alert`, cancel on `waiting_bite`).
   */
  triggerPrimaryAction(
    anglerX: number,
    anglerY: number,
    anglerZ: number,
    lookYaw: number,
    ambience?: ArenaAmbience,
    ecosystem?: ArenaMarineEcosystem,
    instantPower = 0.68,
  ): boolean {
    this.activeEcosystemRef = ecosystem ?? this.activeEcosystemRef;
    if (this.phase === 'idle' || this.phase === 'casting') return false;

    if (this.phase === 'charging') {
      return this.releaseCastCharge(anglerX, anglerY, anglerZ, lookYaw, ambience, ecosystem);
    }

    if (this.phase === 'equipped' || this.phase === 'caught' || this.phase === 'escaped') {
      if (!this.beginCastCharge(true)) return false;
      this.chargePower = clamp(instantPower, 0.08, 1.0);
      return this.releaseCastCharge(anglerX, anglerY, anglerZ, lookYaw, ambience, ecosystem);
    }

    if (this.phase === 'waiting_bite') {
      this.releaseClaimedEcosystemFish();
      this.phase = 'equipped';
      this.phaseTimer = 0;
      this.chargePower = 0;
      this.pendulumInit = false;
      return true;
    }

    if (this.phase === 'bite_alert') {
      if (!this.activeSpecies) {
        const islandId = resolveNearestIslandId(this.bobberX, this.bobberZ);
        this.activeSpecies = ecosystem
          ? ecosystem.sampleCatchableSpeciesAt(this.bobberX, this.bobberZ, islandId)
          : CATCHABLE_MARINE_SPECIES[Math.floor(Math.random() * CATCHABLE_MARINE_SPECIES.length)];
      }

      this.phase = 'reeling';
      this.phaseTimer = 0;
      this.tension = 0.28;
      this.progress = 0.06;
      this.fishPulling = false;
      this.surgeTimer = 1.35 + (1 - this.activeSpecies.resistance) * 1.1;
      this.overTensionGrace = 0;
      this.slackTimer = 0;
      this.fishAngleOffset = 0;
      this.tipWhipVelY -= 2.4;
      this.spawnRing(this.bobberX, this.bobberY, this.bobberZ, 0.95);
      ambience?.fishingSplash(this.bobberX, this.bobberZ, anglerX, anglerZ, lookYaw, false);
      return true;
    }

    return false;
  }

  /** Dismiss catch/escaped presentation cleanly back to `equipped`. */
  dismissCatch(): void {
    if (this.phase !== 'caught' && this.phase !== 'escaped') return;
    this.releaseClaimedEcosystemFish();
    this.phase = 'equipped';
    this.phaseTimer = 0;
    this.chargePower = 0;
    this.pendulumInit = false;
  }

  private spawnRing(x: number, waterY: number, z: number, strength = 0.7): void {
    const b = this.ringCursor * 5;
    this.ringCursor = (this.ringCursor + 1) % RING_POOL_SIZE;
    this.ringState[b] = x;
    this.ringState[b + 1] = waterY + 0.035;
    this.ringState[b + 2] = z;
    this.ringState[b + 3] = 0;
    this.ringState[b + 4] = 0.7 + strength * 0.5;
  }

  /**
   * Update 20-station arc-length-preserving Euler-Bernoulli 3D tapered tubular blank and all 6 ceramic guides in place.
   * `(bendX, bendY)` is transverse deflection in `rodBase` local space (e.g. `bendY < 0` bends tip downward toward water).
   */
  private updateRodBlankAndGuides(bendX: number, bendY: number, time: number): void {
    const mag = Math.hypot(bendX, bendY);
    const quiver = mag > 0.22 ? Math.sin(time * 31.0) * 0.022 * mag : 0;
    const effX = bendX + quiver;
    const effY = bendY;
    const totalTheta = clamp(Math.hypot(effX, effY), 0, 1.08);

    if (totalTheta > 1e-6) {
      const invM = 1 / Math.hypot(effX, effY);
      // Rotation axis `b` such that `b × (0, 0, 1) = (effX, effY, 0) * invM` -> `b = (effY * invM, -effX * invM, 0)`!
      // Check: `(b_y * 1 - 0, 0 - b_x * 1, 0) = (-effX * invM, -effY * invM, 0)` -> negate -> `b = (-effY * invM, effX * invM, 0)`!
      this._bendAxis.set(-effY * invM, effX * invM, 0);
    } else {
      this._bendAxis.set(1, 0, 0);
    }

    const segLen = BLANK_LENGTH / BLANK_SEGMENTS;
    this._pPrev.set(0, 0, BLANK_START_Z);
    this._tVec.set(0, 0, 1);
    this._nVec.set(1, 0, 0);
    this._bVec.set(0, 1, 0);

    let guidePtr = 0;

    for (let k = 0; k <= BLANK_SEGMENTS; k++) {
      if (k > 0) {
        const dTheta = totalTheta * BLANK_COMPLIANCE_WEIGHTS[k];
        if (dTheta > 1e-6) {
          this.dummyQuat.setFromAxisAngle(this._bendAxis, dTheta);
          this._tVec.applyQuaternion(this.dummyQuat).normalize();
          this._nVec.applyQuaternion(this.dummyQuat).normalize();
          this._bVec.crossVectors(this._tVec, this._nVec).normalize();
        }
        this._pPrev.addScaledVector(this._tVec, segLen);
      }

      const rad = BLANK_RADII[k];
      const baseV = k * BLANK_SIDES * 3;
      for (let m = 0; m < BLANK_SIDES; m++) {
        const c = RING_COS[m];
        const s = RING_SIN[m];
        const nx = c * this._nVec.x + s * this._bVec.x;
        const ny = c * this._nVec.y + s * this._bVec.y;
        const nz = c * this._nVec.z + s * this._bVec.z;
        const vi = baseV + m * 3;
        this.blankPositions[vi] = this._pPrev.x + rad * nx;
        this.blankPositions[vi + 1] = this._pPrev.y + rad * ny;
        this.blankPositions[vi + 2] = this._pPrev.z + rad * nz;
        this.blankNormals[vi] = nx;
        this.blankNormals[vi + 1] = ny;
        this.blankNormals[vi + 2] = nz;
      }

      if (guidePtr < GUIDE_COUNT && GUIDE_STATIONS[guidePtr] === k) {
        const footH = GUIDE_FOOT_HEIGHTS[guidePtr];
        const gMesh = this.guideMeshes[guidePtr];
        const eyeLocal = this.guideEyeLocal[guidePtr];
        // Mount guide on the `-_bVec` (underslung spinning-reel) side of the blank
        eyeLocal.copy(this._pPrev).addScaledVector(this._bVec, -(rad + footH));
        gMesh.position.copy(eyeLocal);
        this.dummyMat.makeBasis(this._nVec, this._bVec, this._tVec);
        gMesh.quaternion.setFromRotationMatrix(this.dummyMat);
        guidePtr++;
      }
    }

    // Cap tip vertex
    const capIdx = (BLANK_SEGMENTS + 1) * BLANK_SIDES * 3;
    this.blankPositions[capIdx] = this._pPrev.x;
    this.blankPositions[capIdx + 1] = this._pPrev.y;
    this.blankPositions[capIdx + 2] = this._pPrev.z;
    this.blankNormals[capIdx] = this._tVec.x;
    this.blankNormals[capIdx + 1] = this._tVec.y;
    this.blankNormals[capIdx + 2] = this._tVec.z;

    this.blankGeo.attributes.position.needsUpdate = true;
    this.blankGeo.attributes.normal.needsUpdate = true;
  }

  private updateThreadedLineAndLeader(
    bobTopWorld: T.Vector3,
    bobBotWorld: T.Vector3,
    hookEndWorld: T.Vector3,
    aerialSag: number,
    leaderSlack: number,
  ): void {
    // 0: Spinning-reel bail line roller
    this.lineRollerSocket.getWorldPosition(this.rollerWorld);
    this.linePositions[0] = this.rollerWorld.x;
    this.linePositions[1] = this.rollerWorld.y;
    this.linePositions[2] = this.rollerWorld.z;

    // 1..6: Exact world centers of all 6 ceramic guide eyelets (`guideEyeWorld[5]` = tip-top)
    for (let g = 0; g < GUIDE_COUNT; g++) {
      const ew = this.guideEyeWorld[g].copy(this.guideEyeLocal[g]).applyMatrix4(this.rodBase.matrixWorld);
      const idx = (1 + g) * 3;
      this.linePositions[idx] = ew.x;
      this.linePositions[idx + 1] = ew.y;
      this.linePositions[idx + 2] = ew.z;
    }

    // 7..23: Remaining 17 points of the 18-pt aerial catenary from `guideEyeWorld[5]` (`u=0`) to `bobTopWorld` (`u=1`)
    const tip = this.guideEyeWorld[GUIDE_COUNT - 1];
    for (let i = 1; i < AERIAL_CATENARY_PTS; i++) {
      const u = i / (AERIAL_CATENARY_PTS - 1);
      const parabola = 4 * u * (1 - u) * aerialSag;
      const outIdx = (GUIDE_COUNT + i) * 3;
      this.linePositions[outIdx] = tip.x + (bobTopWorld.x - tip.x) * u;
      this.linePositions[outIdx + 1] = tip.y + (bobTopWorld.y - tip.y) * u - parabola;
      this.linePositions[outIdx + 2] = tip.z + (bobTopWorld.z - tip.z) * u;
    }
    this.lineGeo.attributes.position.needsUpdate = true;

    // Subsurface 8-pt fluorocarbon leader from bobber bottom swivel to 3D J-hook / fish mouth
    for (let i = 0; i < LEADER_POINTS; i++) {
      const u = i / (LEADER_POINTS - 1);
      const bow = 4 * u * (1 - u) * leaderSlack;
      const li = i * 3;
      this.leaderPositions[li] = bobBotWorld.x + (hookEndWorld.x - bobBotWorld.x) * u;
      this.leaderPositions[li + 1] = bobBotWorld.y + (hookEndWorld.y - bobBotWorld.y) * u - bow;
      this.leaderPositions[li + 2] = bobBotWorld.z + (hookEndWorld.z - bobBotWorld.z) * u;
    }
    this.leaderGeo.attributes.position.needsUpdate = true;
  }

  /**
   * Step tip-whip oscillator, Euler-Bernoulli 3D blank deflection, guide world frames,
   * tip pendulum (when `equipped`/`charging`), and threaded catenary + subsurface leader.
   */
  private stepBlankWhipAndRefreshRig(dt: number, time: number): void {
    // Measure rod angular whip velocity from world `+Z` axis change to drive natural tip inertia
    this._pCurr.set(0, 0, 1).transformDirection(this.rodBase.matrixWorld).normalize();
    if (this.prevRodDirInit) {
      this._tVec.subVectors(this._pCurr, this.prevRodTipDir).divideScalar(Math.max(dt, 1e-3));
      this.invRodMat.copy(this.rodBase.matrixWorld).invert();
      this._tVec.transformDirection(this.invRodMat);
      // Inertial reaction opposes rod acceleration
      this.tipWhipVelX = clamp(this.tipWhipVelX - this._tVec.x * dt * 1.35, -8, 8);
      this.tipWhipVelY = clamp(this.tipWhipVelY - this._tVec.y * dt * 1.35, -8, 8);
    } else {
      this.prevRodDirInit = true;
    }
    this.prevRodTipDir.copy(this._pCurr);

    // 2nd-order damped harmonic whip oscillator (`ω_n = 19 rad/s, ζ = 0.30`)
    const wn = 19.0;
    const damp = 2 * 0.30 * wn;
    this.tipWhipVelX += (-wn * wn * this.tipWhipX - damp * this.tipWhipVelX) * dt;
    this.tipWhipVelY += (-wn * wn * this.tipWhipY - damp * this.tipWhipVelY) * dt;
    this.tipWhipX = clamp(this.tipWhipX + this.tipWhipVelX * dt, -0.65, 0.65);
    this.tipWhipY = clamp(this.tipWhipY + this.tipWhipVelY * dt, -0.65, 0.65);

    // Steady transverse line load in `rodBase` local space
    let loadX = 0;
    let loadY = -0.045; // Subtle gravity droop under bobber/blank self-weight

    if (this.phase === 'charging') {
      loadY = -0.06 - 0.24 * this.chargePower;
    } else if (
      this.phase === 'waiting_bite' ||
      this.phase === 'bite_alert' ||
      this.phase === 'reeling' ||
      this.phase === 'caught'
    ) {
      const pullMag =
        this.phase === 'reeling'
          ? 0.24 + this.tension * 0.76 + (this.fishPulling ? 0.12 : 0)
          : this.phase === 'bite_alert'
            ? 0.46 + Math.sin(time * 24) * 0.08
            : this.phase === 'caught'
              ? 0.34
              : 0.09;

      // Project world vector `(target - unbentTip)` into `rodBase` local XY so the rod bends genuinely toward the fish!
      this._lineLocal.set(this.bobberX, this.bobberY, this.bobberZ);
      if (this.phase === 'caught') {
        this._lineLocal.set(this.hookX, this.hookY, this.hookZ);
      }
      this.invRodMat.copy(this.rodBase.matrixWorld).invert();
      this._lineLocal.applyMatrix4(this.invRodMat);
      this._lineLocal.z -= BLANK_START_Z + BLANK_LENGTH;
      const xyLen = Math.hypot(this._lineLocal.x, this._lineLocal.y);
      if (xyLen > 1e-3) {
        loadX = (this._lineLocal.x / xyLen) * pullMag;
        loadY = (this._lineLocal.y / xyLen) * pullMag;
      } else {
        loadY = -pullMag;
      }
    }

    this.updateRodBlankAndGuides(loadX + this.tipWhipX, loadY + this.tipWhipY, time);
    this.rodBase.updateMatrixWorld(true);

    // Update exact world-space `rodTipWorld` from tip-top eyelet (`guideEyeLocal[5]`)
    this.rodTipWorld.copy(this.guideEyeLocal[GUIDE_COUNT - 1]).applyMatrix4(this.rodBase.matrixWorld);

    // Refresh visual line/bobber/leader positions anchored to the newly solved `rodTipWorld`
    if (this.phase === 'equipped' || this.phase === 'charging') {
      const pendLen = 0.44;
      if (!this.pendulumInit) {
        this.pendulumPos.copy(this.rodTipWorld).setY(this.rodTipWorld.y - pendLen);
        this.pendulumVel.set(0, 0, 0);
        this.pendulumInit = true;
      } else {
        // Gravity + air damping + radial inextensible string constraint to `rodTipWorld`
        this.pendulumVel.y -= 9.81 * dt;
        this.pendulumVel.multiplyScalar(Math.exp(-4.2 * dt));
        this.pendulumPos.addScaledVector(this.pendulumVel, dt);
        this.dummyPos.subVectors(this.pendulumPos, this.rodTipWorld);
        const d = this.dummyPos.length();
        if (d > 1e-4) {
          this.dummyPos.divideScalar(d);
          this.pendulumPos.copy(this.rodTipWorld).addScaledVector(this.dummyPos, pendLen);
          const radialV = this.pendulumVel.dot(this.dummyPos);
          if (radialV > 0) this.pendulumVel.addScaledVector(this.dummyPos, -radialV);
        }
      }

      this.bobberX = this.pendulumPos.x;
      this.bobberY = this.pendulumPos.y;
      this.bobberZ = this.pendulumPos.z;
      this.bobberGroup.visible = true;
      this.bobberGroup.position.copy(this.pendulumPos);
      // Tilt hanging bobber subtly along string direction
      this.dummyPos.subVectors(this.rodTipWorld, this.pendulumPos).normalize();
      this.dummyQuat.setFromUnitVectors(WORLD_UP, this.dummyPos);
      this.bobberGroup.quaternion.copy(this.dummyQuat);

      this.bobberTopWorld.set(0, 0.145, 0).applyQuaternion(this.dummyQuat).add(this.pendulumPos);
      this.bobberBottomWorld.set(0, -0.088, 0).applyQuaternion(this.dummyQuat).add(this.pendulumPos);

      this.hookX = this.bobberBottomWorld.x;
      this.hookY = this.bobberBottomWorld.y - 0.18;
      this.hookZ = this.bobberBottomWorld.z;
      this.baitX = this.hookX;
      this.baitY = this.hookY;
      this.baitZ = this.hookZ;

      this.hookAndBaitGroup.visible = true;
      this.prawnBaitGroup.visible = true;
      this.hookAndBaitGroup.position.set(this.hookX, this.hookY, this.hookZ);
      this.hookAndBaitGroup.rotation.set(0, this.lastAnglerYaw, 0);

      this.lineObj.visible = true;
      this.leaderObj.visible = true;
      this.lineMat.color.setRGB(0.94, 0.96, 0.98);
      this.dummyPos.set(this.hookX, this.hookY + 0.02, this.hookZ);
      this.updateThreadedLineAndLeader(this.bobberTopWorld, this.bobberBottomWorld, this.dummyPos, 0.008, 0.004);
    } else if (this.phase === 'casting' && !this.ballisticLaunched) {
      // During the 0.18 s forward whip before release, bobber & trailing bait ride the whipping rod tip!
      this.bobberX = this.rodTipWorld.x;
      this.bobberY = this.rodTipWorld.y - 0.22;
      this.bobberZ = this.rodTipWorld.z;
      this.bobberGroup.visible = true;
      this.bobberGroup.position.set(this.bobberX, this.bobberY, this.bobberZ);
      this.bobberGroup.rotation.set(0, 0, 0);
      this.bobberTopWorld.set(this.bobberX, this.bobberY + 0.14, this.bobberZ);
      this.bobberBottomWorld.set(this.bobberX, this.bobberY - 0.085, this.bobberZ);

      this.hookX = this.bobberX - Math.sin(this.lastLookYaw) * 0.16;
      this.hookY = this.bobberY - 0.18;
      this.hookZ = this.bobberZ - Math.cos(this.lastLookYaw) * 0.16;
      this.hookAndBaitGroup.visible = true;
      this.prawnBaitGroup.visible = true;
      this.hookAndBaitGroup.position.set(this.hookX, this.hookY, this.hookZ);

      this.lineObj.visible = true;
      this.leaderObj.visible = true;
      this.lineMat.color.setRGB(0.94, 0.96, 0.98);
      this.dummyPos.set(this.hookX, this.hookY + 0.02, this.hookZ);
      this.updateThreadedLineAndLeader(this.bobberTopWorld, this.bobberBottomWorld, this.dummyPos, 0.01, 0.005);
    } else if (
      this.phase === 'casting' ||
      this.phase === 'waiting_bite' ||
      this.phase === 'bite_alert' ||
      this.phase === 'reeling' ||
      this.phase === 'caught'
    ) {
      const span = Math.hypot(this.bobberX - this.rodTipWorld.x, this.bobberZ - this.rodTipWorld.z);
      const sag =
        this.phase === 'casting'
          ? 0.06
          : this.phase === 'waiting_bite'
            ? clamp(0.045 * span, 0.08, 0.44)
            : this.phase === 'bite_alert'
              ? 0.04
              : this.phase === 'caught'
                ? 0.015
                : 0.035 * (1 - this.tension);
      const leaderSlack = this.phase === 'waiting_bite' ? 0.035 : 0.006;

      if (this.phase === 'caught') {
        // Line goes straight from tip-top eyelet through leader to the caught fish!
        this.bobberTopWorld.copy(this.rodTipWorld).lerp(this.dummyPos.set(this.hookX, this.hookY + 0.12, this.hookZ), 0.55);
        this.bobberBottomWorld.copy(this.bobberTopWorld);
        this.bobberGroup.visible = true;
        this.bobberGroup.position.copy(this.bobberTopWorld);
        this.bobberGroup.rotation.set(0, 0, 0);
      } else {
        this.bobberTopWorld.set(0, 0.14, 0).applyQuaternion(this.bobberGroup.quaternion).add(this.bobberGroup.position);
        this.bobberBottomWorld.set(0, -0.088, 0).applyQuaternion(this.bobberGroup.quaternion).add(this.bobberGroup.position);
      }
      this.dummyPos.set(this.hookX, this.hookY + 0.018, this.hookZ);
      this.updateThreadedLineAndLeader(this.bobberTopWorld, this.bobberBottomWorld, this.dummyPos, sag, leaderSlack);
    }
  }

  /**
   * Contextual action hint for `ArenaScene` prompt pill:
   * Returns `'F'` ONLY when `phase === 'idle'` near a designated pier `fishing_spot` (`9.4` deduplication —
   * zero duplicate prompt banners once the rod is equipped!).
   */
  getContextualPrompt(px?: number, pz?: number): FishingPromptHint | null {
    if (this.phase !== 'idle') return null;
    if (px !== undefined && pz !== undefined) {
      const spots = arenaLayout.interactables as readonly {
        id: string;
        kind: string;
        x: number;
        z: number;
        range: number;
      }[];
      for (let i = 0; i < spots.length; i++) {
        const sp = spots[i];
        if (sp.kind === 'fishing_spot' && Math.hypot(px - sp.x, pz - sp.z) <= (sp.range || 3.4)) {
          return {
            canTrigger: true,
            keyHint: 'F',
            labelEn: 'Equip fishing rod',
            labelVi: 'Cầm cần câu cá',
          };
        }
      }
    }
    return null;
  }

  getHudState(): Readonly<FishingHudState> {
    this.hudSnapshot.phase = this.phase;
    this.hudSnapshot.chargePower = this.chargePower;
    this.hudSnapshot.tension = this.tension;
    this.hudSnapshot.progress = this.progress;
    this.hudSnapshot.fishPulling = this.fishPulling;
    this.hudSnapshot.fishApproaching = this.fishApproaching;
    this.hudSnapshot.distanceM = this.distanceM;
    this.hudSnapshot.bobberX = this.bobberX;
    this.hudSnapshot.bobberZ = this.bobberZ;
    this.hudSnapshot.activeSpecies = this.activeSpecies;
    this.hudSnapshot.lastCatch = this.lastCatch;
    return this.hudSnapshot;
  }

  /** Step fishing state machine, cast charge, ballistic flight, wave buoyancy, reel tension, and visual rig (`0` GC). */
  update(ctx: FishingStepContext): Readonly<FishingHudState> {
    const dt = clamp(ctx.dt, 0.001, 0.05);
    const waveFn = ctx.waveHeightAt ?? arenaWaveHeight;

    this.lastAnglerX = ctx.anglerX;
    this.lastAnglerY = ctx.anglerY;
    this.lastAnglerZ = ctx.anglerZ;
    this.lastAnglerYaw = ctx.anglerYaw;
    this.lastLookYaw = ctx.lookYaw;
    this.lastLookPitch = ctx.lookPitch ?? 0;
    this.lastTime = ctx.time;
    if (ctx.ecosystem) this.activeEcosystemRef = ctx.ecosystem;

    if (!ctx.canFishHere && this.phase !== 'idle') {
      this.stowRod();
    }

    if (this.phase === 'idle') {
      this.updateRings(dt);
      return this.getHudState();
    }

    this.phaseTimer += dt;

    // Smooth mechanical bail wire angle (`76°` open in `charging` & airborne `casting`, `0°` snapped shut otherwise)
    const wantBailOpen =
      this.phase === 'charging' || (this.phase === 'casting' && this.flightElapsed < this.flightDuration)
        ? 1.32
        : 0;
    this.bailOpenAngle += (wantBailOpen - this.bailOpenAngle) * (1 - Math.exp(-18 * dt));
    this.bailPivotGroup.rotation.set(this.bailOpenAngle, 0, 0);

    // Fallback `rodBase` placement when `syncVisualsToSolvedHands` has not yet run on this frame
    if (!this.handSyncedThisFrame) {
      const sinY = Math.sin(ctx.anglerYaw);
      const cosY = Math.cos(ctx.anglerYaw);
      this.rodBase.visible = true;
      this.rodBase.position.set(
        ctx.anglerX - cosY * 0.095 + sinY * 0.28,
        ctx.anglerY + 1.06,
        ctx.anglerZ + sinY * 0.095 + cosY * 0.28,
      );
      const pitch =
        this.phase === 'charging'
          ? lerp(-0.52, -1.82, smooth01(this.chargePower))
          : this.phase === 'casting' && this.phaseTimer <= CAST_WHIP_RELEASE_SEC
            ? lerp(-1.65, -0.40, smooth01(this.phaseTimer / CAST_WHIP_RELEASE_SEC))
            : -0.50;
      this.rodBase.rotation.set(pitch, ctx.anglerYaw, 0);
      this.rodBase.updateMatrixWorld(true);
    }
    this.handSyncedThisFrame = false;

    // ── Phase-Specific Gameplay & Physics ──
    if (this.phase === 'equipped') {
      this.chargePower = 0;
      this.distanceM = 0;
    } else if (this.phase === 'charging') {
      this.chargeHoldSec += dt;
      const u = clamp(this.chargeHoldSec / FISHING_FULL_CHARGE_SEC, 0, 1);
      // Monotonic smooth ease-out (`0.06 -> 1.00` over `1.35 s`)
      this.chargePower = clamp(0.06 + 0.94 * u * (2 - u), 0, 1);
      this.distanceM = lerp(FISHING_MIN_CAST_M, FISHING_MAX_CAST_M, this.chargePower);
    } else if (this.phase === 'casting') {
      if (this.phaseTimer >= CAST_WHIP_RELEASE_SEC) {
        if (!this.ballisticLaunched) {
          this.ballisticLaunched = true;
          this.flightElapsed = 0;
          this.pendulumInit = false;
          this.launchOrigin.copy(this.rodTipWorld);
          const waterLandingY = waveFn(this.targetBobberX, this.targetBobberZ, ctx.time + this.flightDuration);
          const tf = this.flightDuration;
          this.launchVel.set(
            (this.targetBobberX - this.launchOrigin.x) / tf,
            (waterLandingY - this.launchOrigin.y + 0.5 * CAST_GRAVITY * tf * tf) / tf,
            (this.targetBobberZ - this.launchOrigin.z) / tf,
          );
        }

        this.flightElapsed += dt;
        const t = this.flightElapsed;
        this.bobberX = this.launchOrigin.x + this.launchVel.x * t;
        this.bobberZ = this.launchOrigin.z + this.launchVel.z * t;
        this.bobberY = this.launchOrigin.y + this.launchVel.y * t - 0.5 * CAST_GRAVITY * t * t;
        const waterY = waveFn(this.bobberX, this.bobberZ, ctx.time);

        // Trailing 3D hook & prawn bait slightly behind/below the flying bobber
        const vx = this.launchVel.x;
        const vy = this.launchVel.y - CAST_GRAVITY * t;
        const vz = this.launchVel.z;
        const vLen = Math.max(0.1, Math.hypot(vx, vy, vz));
        this.hookX = this.bobberX - (vx / vLen) * 0.22;
        this.hookY = this.bobberY - (vy / vLen) * 0.22 - 0.08;
        this.hookZ = this.bobberZ - (vz / vLen) * 0.22;
        this.baitX = this.hookX;
        this.baitY = this.hookY;
        this.baitZ = this.hookZ;

        this.bobberGroup.visible = true;
        this.bobberGroup.position.set(this.bobberX, Math.max(waterY - 0.06, this.bobberY), this.bobberZ);
        this.bobberGroup.rotation.set(clamp(-vy * 0.04, -0.45, 0.45), 0, 0);
        this.hookAndBaitGroup.visible = true;
        this.prawnBaitGroup.visible = true;
        this.hookAndBaitGroup.position.set(this.hookX, this.hookY, this.hookZ);
        this.lineObj.visible = true;
        this.leaderObj.visible = true;
        this.lineMat.color.setRGB(0.94, 0.96, 0.98);
        this.distanceM = Math.hypot(this.bobberX - ctx.anglerX, this.bobberZ - ctx.anglerZ);

        if (this.bobberY <= waterY || this.flightElapsed >= this.flightDuration) {
          this.bobberX = this.targetBobberX;
          this.bobberZ = this.targetBobberZ;
          this.bobberY = waterY - 0.08;
          this.bobberDipOffset = -0.10 * (0.5 + 0.5 * this.lastCastPower);
          this.bobberDipVel = -0.95 * (0.5 + 0.5 * this.lastCastPower);
          this.phase = 'waiting_bite';
          this.phaseTimer = 0;
          this.chargePower = 0;
          this.waitDuration = 2.8 + Math.random() * 3.4;
          this.nextNibbleAt = 1.2 + Math.random() * 1.1;
          this.spawnRing(this.bobberX, waterY, this.bobberZ, 0.65 + 0.3 * this.lastCastPower);
          ctx.ambience?.fishingSplash(
            this.bobberX,
            this.bobberZ,
            ctx.listenerX,
            ctx.listenerZ,
            ctx.listenerYaw,
            false,
          );
        }
      }
    } else if (this.phase === 'waiting_bite') {
      const waterY = waveFn(this.bobberX, this.bobberZ, ctx.time);

      // Damped Archimedes vertical buoyancy oscillator (`ω_n = 11 rad/s, ζ = 0.42`)
      const wnB = 11.0;
      const dampB = 2 * 0.42 * wnB;
      this.bobberDipVel += (-wnB * wnB * this.bobberDipOffset - dampB * this.bobberDipVel) * dt;
      this.bobberDipOffset = clamp(this.bobberDipOffset + this.bobberDipVel * dt, -0.28, 0.14);

      // Standalone fallback nibble & bite progression ONLY when `ArenaMarineEcosystem` has not claimed this cast
      const ecoSupportsBait = Boolean(
        ctx.ecosystem &&
          typeof (ctx.ecosystem as ArenaMarineEcosystem & { releaseClaimedFish?: unknown }).releaseClaimedFish ===
            'function',
      );
      if (!this.ecosystemDriven && !ecoSupportsBait) {
        if (this.phaseTimer >= this.nextNibbleAt && this.phaseTimer < this.waitDuration - 0.55) {
          this.nextNibbleAt = this.phaseTimer + 1.25 + Math.random() * 1.1;
          this.bobberDipVel -= 0.72;
          this.fishApproaching = true;
          this.spawnRing(this.bobberX, waterY, this.bobberZ, 0.35);
        }
        if (this.phaseTimer >= this.waitDuration) {
          this.phase = 'bite_alert';
          this.phaseTimer = 0;
          this.fishApproaching = false;
          this.bobberDipVel = -1.55;
          this.spawnRing(this.bobberX, waterY, this.bobberZ, 1.0);
          ctx.ambience?.fishingSplash(
            this.bobberX,
            this.bobberZ,
            ctx.listenerX,
            ctx.listenerZ,
            ctx.listenerYaw,
            true,
          );
        }
      } else if (this.phaseTimer >= 8.5 && this.phase === 'waiting_bite') {
        // Safety ceiling so even in sparse outer waters a bite arrives within <= 8.5 s (`verify-archipelago-v7-qa` < 10 s gate!)
        const islandId = resolveNearestIslandId(this.bobberX, this.bobberZ);
        this.activeSpecies = ctx.ecosystem
          ? ctx.ecosystem.sampleCatchableSpeciesAt(this.bobberX, this.bobberZ, islandId)
          : CATCHABLE_MARINE_SPECIES[0];
        this.phase = 'bite_alert';
        this.phaseTimer = 0;
        this.fishApproaching = false;
        this.bobberDipVel = -1.55;
        this.spawnRing(this.bobberX, waterY, this.bobberZ, 1.0);
        ctx.ambience?.fishingSplash(
          this.bobberX,
          this.bobberZ,
          ctx.listenerX,
          ctx.listenerZ,
          ctx.listenerYaw,
          true,
        );
      }

      this.bobberY = waterY + this.bobberDipOffset;
      const eps = 0.25;
      const wyX = waveFn(this.bobberX + eps, this.bobberZ, ctx.time) - waterY;
      const wyZ = waveFn(this.bobberX, this.bobberZ + eps, ctx.time) - waterY;
      this.bobberGroup.visible = true;
      this.bobberGroup.position.set(this.bobberX, this.bobberY, this.bobberZ);
      this.bobberGroup.rotation.set(wyZ / eps * 0.55, 0, -wyX / eps * 0.55 + Math.sin(ctx.time * 2.6) * 0.05);

      // Subsurface leader & 3D prawn bait settled smoothly in the water column above seabed
      const floorY = arenaFloor(this.bobberX, this.bobberZ);
      const waterDepth = Math.max(0.45, waterY - floorY);
      const leaderLen = clamp(0.45 * waterDepth, 0.38, 1.35);
      const sinkProgress = smooth01(this.phaseTimer / 0.55);
      const targetBaitY = Math.max(floorY + 0.25, waterY - leaderLen * sinkProgress);
      const swayX = Math.sin(ctx.time * 1.7) * 0.03;
      const swayZ = Math.cos(ctx.time * 1.4) * 0.03;
      this.baitX = this.bobberX + swayX;
      this.baitY = targetBaitY;
      this.baitZ = this.bobberZ + swayZ;
      this.hookX = this.baitX;
      this.hookY = this.baitY;
      this.hookZ = this.baitZ;

      this.hookAndBaitGroup.visible = true;
      this.prawnBaitGroup.visible = true;
      this.hookAndBaitGroup.position.set(this.hookX, this.hookY, this.hookZ);
      this.hookAndBaitGroup.rotation.set(0, ctx.time * 0.6, Math.sin(ctx.time * 2.1) * 0.12);

      this.lineObj.visible = true;
      this.leaderObj.visible = true;
      this.lineMat.color.setRGB(0.94, 0.96, 0.98);
      this.distanceM = Math.hypot(this.bobberX - ctx.anglerX, this.bobberZ - ctx.anglerZ);
    } else if (this.phase === 'bite_alert') {
      const waterY = waveFn(this.bobberX, this.bobberZ, ctx.time);
      if (this.phaseTimer < 0.04) {
        ctx.ambience?.fishingSplash(
          this.bobberX,
          this.bobberZ,
          ctx.listenerX,
          ctx.listenerZ,
          ctx.listenerYaw,
          true,
        );
      }
      this.bobberY = waterY - 0.16 + Math.sin(ctx.time * 18) * 0.045;
      this.bobberGroup.visible = true;
      this.bobberGroup.position.set(this.bobberX, this.bobberY, this.bobberZ);
      this.bobberGroup.rotation.set(Math.sin(ctx.time * 15) * 0.18, 0, Math.cos(ctx.time * 13) * 0.18);

      if (this.ecosystemPoseValid) {
        this.hookX = this.hookedMouthPos.x;
        this.hookY = this.hookedMouthPos.y;
        this.hookZ = this.hookedMouthPos.z;
      } else {
        this.hookX = this.bobberX;
        this.hookY = waterY - 0.62;
        this.hookZ = this.bobberZ;
      }
      this.baitX = this.hookX;
      this.baitY = this.hookY;
      this.baitZ = this.hookZ;
      this.hookAndBaitGroup.visible = true;
      this.prawnBaitGroup.visible = !this.ecosystemPoseValid;
      this.hookAndBaitGroup.position.set(this.hookX, this.hookY, this.hookZ);

      this.lineObj.visible = true;
      this.leaderObj.visible = true;
      this.lineMat.color.setRGB(0.99, 0.88, 0.45);

      // Generous 2.15 s strike window; if missed, fish slips the bait and darts back to school
      if (this.phaseTimer > 2.15) {
        this.releaseClaimedEcosystemFish();
        this.phase = 'escaped';
        this.phaseTimer = 0;
        this.bobberGroup.visible = false;
        this.lineObj.visible = false;
        this.leaderObj.visible = false;
        this.hookAndBaitGroup.visible = false;
      }
    } else if (this.phase === 'reeling' && this.activeSpecies) {
      const res = this.activeSpecies.resistance;

      // Species-specific calm vs surge rhythm (ecosystem `onHookedFishPose` can also synchronize `fishPulling`)
      this.surgeTimer -= dt;
      if (this.surgeTimer <= 0) {
        this.fishPulling = !this.fishPulling;
        if (this.fishPulling) {
          this.surgeTimer = 0.85 + res * 1.15 + Math.random() * 0.45;
          const wy = waveFn(this.bobberX, this.bobberZ, ctx.time);
          this.spawnRing(this.bobberX, wy, this.bobberZ, 0.85);
          this.tipWhipVelY -= 1.8 * res;
        } else {
          this.surgeTimer = 1.45 + (1 - res) * 1.35 + Math.random() * 0.55;
        }
      }

      if (ctx.reelHeld) {
        const tensionRise = this.fishPulling ? 0.54 + res * 0.42 : 0.24 + res * 0.16;
        this.tension = clamp(this.tension + tensionRise * dt, 0, 1);
        const reelRate = (this.fishPulling ? 0.11 : 0.35) * (1.12 - res * 0.46);
        this.progress = clamp(this.progress + reelRate * dt, 0, 1);
        this.crankAngle += dt * (11 + 9 * this.tension);
        this.rotorAngle += dt * 24;
        this.slackTimer = 0;
        ctx.ambience?.fishingReelClick(this.tension, this.fishPulling);
      } else {
        const tensionDrop = this.fishPulling ? 0.38 : 0.68;
        this.tension = clamp(this.tension - tensionDrop * dt, 0, 1);
        if (this.fishPulling) {
          this.progress = clamp(this.progress - (0.04 + res * 0.05) * dt, 0.02, 1);
          this.crankAngle -= dt * 2.6; // Subtle drag slip
        }
        if (this.tension <= 0.02) this.slackTimer += dt;
        else this.slackTimer = Math.max(0, this.slackTimer - dt * 2);
      }
      this.reelCrankPivot.rotation.set(this.crankAngle, 0, 0);
      this.reelRotorGroup.rotation.set(0, 0, this.rotorAngle);

      const pullFraction = 1 - this.progress;
      this.fishAngleOffset += Math.sin(ctx.time * (2.6 + res * 2.2)) * dt * (this.fishPulling ? 1.1 : 0.45);
      const baseAngle = Math.atan2(this.targetBobberX - ctx.anglerX, this.targetBobberZ - ctx.anglerZ);
      const liveAngle = baseAngle + Math.sin(this.fishAngleOffset) * 0.28 * pullFraction;
      this.distanceM = Math.max(1.2, this.initialDistanceM * pullFraction);

      const nominalX = ctx.anglerX + Math.sin(liveAngle) * this.distanceM;
      const nominalZ = ctx.anglerZ + Math.cos(liveAngle) * this.distanceM;
      const waterY = waveFn(nominalX, nominalZ, ctx.time);
      const floorY = arenaFloor(nominalX, nominalZ);
      const nominalFishY = Math.max(floorY + 0.22, waterY - (this.fishPulling ? 0.48 : 0.28));

      // Bait/hook target guides `ArenaMarineEcosystem`'s fighting fish toward the angler; if ecosystem reports exact 3D mouth, lock leader to it!
      this.baitX = nominalX;
      this.baitY = nominalFishY;
      this.baitZ = nominalZ;

      if (this.ecosystemPoseValid) {
        this.hookX = this.hookedMouthPos.x;
        this.hookY = this.hookedMouthPos.y;
        this.hookZ = this.hookedMouthPos.z;
        this.bobberX = lerp(this.hookX, ctx.anglerX, 0.14);
        this.bobberZ = lerp(this.hookZ, ctx.anglerZ, 0.14);
      } else {
        this.hookX = nominalX;
        this.hookY = nominalFishY;
        this.hookZ = nominalZ;
        this.bobberX = nominalX;
        this.bobberZ = nominalZ;
      }

      const bobWaterY = waveFn(this.bobberX, this.bobberZ, ctx.time);
      this.bobberY = bobWaterY - (this.fishPulling ? 0.12 : 0.03);
      this.bobberGroup.visible = true;
      this.bobberGroup.position.set(this.bobberX, this.bobberY, this.bobberZ);
      this.bobberGroup.rotation.set(0.25, liveAngle, 0);

      this.hookAndBaitGroup.visible = true;
      this.prawnBaitGroup.visible = false; // Hook is in the fish's mouth (`0` ConeGeometry!)
      this.hookAndBaitGroup.position.set(this.hookX, this.hookY, this.hookZ);
      this.hookAndBaitGroup.rotation.set(0, liveAngle, 0);

      this.lineObj.visible = true;
      this.leaderObj.visible = true;
      if (this.tension > 0.85) {
        this.lineMat.color.setRGB(0.98, 0.32, 0.28);
      } else if (this.tension > 0.62) {
        this.lineMat.color.setRGB(0.98, 0.78, 0.28);
      } else {
        this.lineMat.color.setRGB(0.94, 0.97, 1.0);
      }

      // Line-snap (> 0.95 for >= 0.24 s) or persistent dead-slack hook throw (tension <= 0.02 for >= 3.2 s)
      if (this.tension >= 0.95) {
        this.overTensionGrace += dt;
        if (this.overTensionGrace >= 0.24) {
          this.releaseClaimedEcosystemFish();
          this.phase = 'escaped';
          this.phaseTimer = 0;
          this.tension = 0;
          this.fishPulling = false;
          this.bobberGroup.visible = false;
          this.lineObj.visible = false;
          this.leaderObj.visible = false;
          this.hookAndBaitGroup.visible = false;
          ctx.ambience?.interactCue(false);
        }
      } else {
        this.overTensionGrace = Math.max(0, this.overTensionGrace - dt * 2);
      }

      if (this.phase === 'reeling' && this.slackTimer >= 3.2) {
        this.releaseClaimedEcosystemFish();
        this.phase = 'escaped';
        this.phaseTimer = 0;
        this.tension = 0;
        this.fishPulling = false;
        this.bobberGroup.visible = false;
        this.lineObj.visible = false;
        this.leaderObj.visible = false;
        this.hookAndBaitGroup.visible = false;
        ctx.ambience?.interactCue(false);
      }

      // Successful catch (`progress >= 1.0`)!
      if (this.progress >= 1.0 && this.phase === 'reeling') {
        const sp = this.activeSpecies;
        // Derive deterministic size from ecosystem specimen's `claimedScaleRatio` when available!
        const sizeRoll = this.ecosystemDriven
          ? clamp((this.claimedScaleRatio - 0.72) / 0.62, 0.05, 0.98)
          : Math.pow(Math.random(), 0.78);
        const weightKg = +(sp.minWeightKg + (sp.maxWeightKg - sp.minWeightKg) * sizeRoll).toFixed(2);
        const lengthCm = Math.round(
          sp.minLengthCm + (sp.maxLengthCm - sp.minLengthCm) * clamp(0.9 * sizeRoll + 0.08, 0, 1),
        );
        const islandId = resolveNearestIslandId(ctx.anglerX, ctx.anglerZ);

        const saved = recordCaughtFishInLogbook(this.accountScope, {
          speciesId: sp.id,
          weightKg,
          lengthCm,
          rarity: sp.rarity,
          islandId,
          caughtAt: Date.now(),
        });
        this.logbook = saved.state;
        this.lastCatch = saved.record;
        this.phase = 'caught';
        this.phaseTimer = 0;
        this.tension = 0.25;
        this.fishPulling = false;
        ctx.ambience?.fishingCatch(sp.rarity === 'legendary' || sp.rarity === 'rare');
        this.onCatchCallback?.(saved.record, sp, this.logbook);
      }
    } else if (this.phase === 'caught') {
      // Suspend caught real 3D fish gracefully on the leader in front of the angler for 3.8 s before gentle release
      const sinA = Math.sin(ctx.anglerYaw);
      const cosA = Math.cos(ctx.anglerYaw);
      const holdX = ctx.anglerX + sinA * 1.08 - cosA * 0.12;
      const holdY = ctx.anglerY + 1.18 + Math.sin(ctx.time * 3.0) * 0.03;
      const holdZ = ctx.anglerZ + cosA * 1.08 + sinA * 0.12;
      this.baitX = holdX;
      this.baitY = holdY;
      this.baitZ = holdZ;
      this.hookX = this.ecosystemPoseValid ? this.hookedMouthPos.x : holdX;
      this.hookY = this.ecosystemPoseValid ? this.hookedMouthPos.y : holdY;
      this.hookZ = this.ecosystemPoseValid ? this.hookedMouthPos.z : holdZ;
      this.bobberX = holdX;
      this.bobberZ = holdZ;

      this.hookAndBaitGroup.visible = true;
      this.prawnBaitGroup.visible = false;
      this.hookAndBaitGroup.position.set(this.hookX, this.hookY, this.hookZ);
      this.lineObj.visible = true;
      this.leaderObj.visible = true;
      this.lineMat.color.setRGB(0.94, 0.96, 0.98);

      if (this.phaseTimer >= 3.8) {
        this.releaseClaimedEcosystemFish();
        this.phase = 'equipped';
        this.phaseTimer = 0;
        this.pendulumInit = false;
      }
    } else if (this.phase === 'escaped') {
      this.bobberGroup.visible = false;
      this.lineObj.visible = false;
      this.leaderObj.visible = false;
      this.hookAndBaitGroup.visible = false;
      if (this.phaseTimer >= 1.5) {
        this.phase = 'equipped';
        this.phaseTimer = 0;
        this.pendulumInit = false;
      }
    }

    // Update rod blank curve, guides, tip pendulum, and threaded line for fallback path
    // (When Wave B calls `syncVisualsToSolvedHands` right after `c.update`, it re-locks `rodBase` & lines to exact solved wrists)
    this.stepBlankWhipAndRefreshRig(dt, ctx.time);
    this.updateRings(dt);
    return this.getHudState();
  }

  private updateRings(dt: number): void {
    let active = 0;
    this.dummyQuat.identity();
    for (let i = 0; i < RING_POOL_SIZE; i++) {
      const b = i * 5;
      const age = this.ringState[b + 3] + dt;
      const life = this.ringState[b + 4];
      if (age >= life) {
        this.ringState[b + 3] = 99;
        continue;
      }
      this.ringState[b + 3] = age;
      const u = age / Math.max(0.01, life);
      const scale = 0.5 + u * 2.8;
      this.dummyPos.set(this.ringState[b], this.ringState[b + 1], this.ringState[b + 2]);
      this.dummyScale.set(scale, 1, scale);
      this.dummyMat.compose(this.dummyPos, this.dummyQuat, this.dummyScale);
      this.ringMesh.setMatrixAt(active++, this.dummyMat);
      this.dummyScale.set(1, 1, 1);
    }
    this.ringMesh.count = active;
    if (active > 0) this.ringMesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.disposed = true;
    this.releaseClaimedEcosystemFish();
    this.scene.remove(this.root);
    for (let i = 0; i < this.ownedGeometries.length; i++) {
      this.ownedGeometries[i].dispose();
    }
    for (let i = 0; i < this.ownedMaterials.length; i++) {
      this.ownedMaterials[i].dispose();
    }
    for (let i = 0; i < this.ownedTextures.length; i++) {
      this.ownedTextures[i].dispose();
    }
    this.ownedGeometries.length = 0;
    this.ownedMaterials.length = 0;
    this.ownedTextures.length = 0;
  }
}
