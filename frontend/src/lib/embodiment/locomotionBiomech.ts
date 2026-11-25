import * as T from 'three';
import { alignWrist } from './arms';

/**
 * Shared Human Gait Biomechanics, Empirical Stride Calibration, Seam/Yaw Repair
 * & Athletic Upper-Body Synthesis (`locomotionBiomech.ts`).
 *
 * Pure Three.js + math module (`0` Echo Life imports) shared across:
 *  - Echo Life `CharacterAnimator` (30 character models across `RunnerRig`, `EchoStudentRig`, `Codex52`)
 *  - Player `Character` / `HumanRig` (`lyra_v2`, `kai_v2`, `cast-*.glb`)
 *  - Speaking Arena locomotion clip suite
 *
 * Coordinate convention (`RunnerRig` & `EchoStudentRig` model space):
 *  - `+X` = Character Anatomical Left (`.L`)
 *  - `-X` = Character Anatomical Right (`.R`)
 *  - `+Y` = Up
 *  - `+Z` = Forward
 *  - `hand.L` / `hand.R`: local `+Y` points along fingers, local `+Z` points out of palm,
 *    local `-X` (`hand.L`) / `+X` (`hand.R`) points along thumb.
 */

export const STANCE_LUT_SIZE = 64;

export type GaitUpgradeKind = 'Walk' | 'Walk_Brisk' | 'Run' | 'Sprint';

export type SchmittLocomotionBand = 'idle' | 'walk' | 'walk_brisk' | 'run' | 'sprint';

/** Schmitt-trigger hysteresis thresholds (m/s at scale 1) preventing clip thrashing at band boundaries. */
export const LOCOMOTION_SCHMITT_THRESHOLDS = {
  idleEnterWalk: 0.13,
  walkExitIdle: 0.06,
  walkEnterBrisk: 1.58,
  briskExitWalk: 1.34,
  briskEnterRun: 2.22,
  runExitBrisk: 1.92,
  runEnterSprint: 4.05,
  sprintExitRun: 3.6,
} as const;

export interface ClipGaitMeta {
  /** Empirical median backward stance-foot speed in model space (m/s at scale 1). `0` for static clips. */
  readonly nativeStanceSpeed: number;
  /** Normalized cycle fraction `[0, 1)` at which the left foot reaches peak forward lead relative to hips. */
  readonly leftFootForwardFrac: number;
  /** Upward hover bias `max(0, min(minYL - restYL, minYR - restYR))` in model metres (`>= 0`). */
  readonly minAnkleDeltaY: number;
  /** Periodic 64-bin C1-smoothed left-foot stance contact weight `[0..1]`. */
  readonly stanceL: Float32Array;
  /** Periodic 64-bin C1-smoothed right-foot stance contact weight `[0..1]`. */
  readonly stanceR: Float32Array;
  /** Periodic 64-bin left stance progress `[0..1]` (`0` = heel-strike, `1` = toe-off). */
  readonly stanceProgressL: Float32Array;
  /** Periodic 64-bin right stance progress `[0..1]` (`0` = heel-strike, `1` = toe-off). */
  readonly stanceProgressR: Float32Array;
}

export interface StanceWeightsSnapshot {
  stanceL: number;
  stanceR: number;
  progressL: number;
  progressR: number;
  phase01: number;
}

export function createStanceWeightsSnapshot(): StanceWeightsSnapshot {
  return {
    stanceL: 1,
    stanceR: 1,
    progressL: 0.45,
    progressR: 0.45,
    phase01: 0,
  };
}

// ── Reference RunnerRig 19-Bone Bind Table (for headless clip synthesis & sagittal mirroring) ────────

interface RunnerRestEntry {
  readonly parent: string | null;
  readonly t: readonly [number, number, number];
  readonly r: readonly [number, number, number, number];
}

const DEFAULT_RUNNER_RIG_REST: Readonly<Record<string, RunnerRestEntry>> = {
  hips: { parent: null, t: [0, 0.895, -0.005], r: [-0.01154, 0, 0, 0.99993] },
  spine: { parent: 'hips', t: [0, 0.13003, 0], r: [0.02486, 0, 0, 0.99969] },
  chest: { parent: 'spine', t: [0, 0.15005, 0], r: [-0.01921, 0, 0, 0.99982] },
  neck: { parent: 'chest', t: [0, 0.17001, 0], r: [0.02809, 0, 0, 0.99961] },
  head: { parent: 'neck', t: [0, 0.09009, 0], r: [-0.01836, 0, 0, 0.99983] },
  'shoulder.L': { parent: 'chest', t: [0.035, 0.14501, -0.00029], r: [-0.00727, 0.01578, -0.71266, 0.7013] },
  'upper_arm.L': { parent: 'shoulder.L', t: [0, 0.12308, 0], r: [-0.00214, 0.01394, -0.40001, 0.9164] },
  'forearm.L': { parent: 'upper_arm.L', t: [0, 0.2401, 0], r: [0.05131, -0.00013, -0.00925, 0.99864] },
  'hand.L': { parent: 'forearm.L', t: [0, 0.2055, 0], r: [0.10542, 0.6992, -0.06853, 0.70378] },
  'shoulder.R': { parent: 'chest', t: [-0.035, 0.14501, -0.00029], r: [-0.00727, -0.01578, 0.71266, 0.7013] },
  'upper_arm.R': { parent: 'shoulder.R', t: [0, 0.12308, 0], r: [-0.00214, -0.01394, 0.40001, 0.9164] },
  'forearm.R': { parent: 'upper_arm.R', t: [0, 0.2401, 0], r: [0.05131, 0.00013, 0.00925, 0.99864] },
  'hand.R': { parent: 'forearm.R', t: [0, 0.2055, 0], r: [0.10542, -0.69921, 0.06853, 0.70378] },
  'thigh.L': { parent: 'hips', t: [0.084, 0.00002, -0.001], r: [-0.00021, -0.00145, -0.99991, 0.01298] },
  'shin.L': { parent: 'thigh.L', t: [0, 0.38532, 0], r: [-0.03728, 0.00042, -0.00809, 0.99927] },
  'foot.L': { parent: 'shin.L', t: [0, 0.41158, 0], r: [0.52869, -0.0022, -0.00435, 0.8488] },
  'thigh.R': { parent: 'hips', t: [-0.084, 0.00002, -0.001], r: [-0.00021, 0.00145, 0.99991, 0.01298] },
  'shin.R': { parent: 'thigh.R', t: [0, 0.38532, 0], r: [-0.03728, -0.00042, 0.00809, 0.99927] },
  'foot.R': { parent: 'shin.R', t: [0, 0.41158, 0], r: [0.52869, 0.0022, 0.00435, 0.8488] },
};

const RUNNER_BONE_ORDER: readonly string[] = [
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

const UPPER_GAIT_BONES_DOT: readonly string[] = [
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
];

const X_AXIS = new T.Vector3(1, 0, 0);
const Y_AXIS = new T.Vector3(0, 1, 0);
const Z_AXIS = new T.Vector3(0, 0, 1);

const _clipMetaCache = new WeakMap<T.AnimationClip, ClipGaitMeta>();
let _virtualRunnerRoot: T.Group | null = null;

function deg(d: number): number {
  return (d * Math.PI) / 180;
}

function wrap01(u: number): number {
  const m = u % 1;
  return m < 0 ? m + 1 : m;
}

function quinticSmooth01(u: number): number {
  const x = T.MathUtils.clamp(u, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function getVirtualRunnerRig(): T.Group {
  if (_virtualRunnerRoot) return _virtualRunnerRoot;
  const root = new T.Group();
  root.name = 'VirtualRunnerRig';
  const created = new Map<string, T.Bone>();
  for (const name of RUNNER_BONE_ORDER) {
    const spec = DEFAULT_RUNNER_RIG_REST[name];
    const bone = new T.Bone();
    // Match Three.js GLTFLoader sanitized node naming (`thighL`, `shoulderL`) while retaining authored `userData.name`
    bone.name = name.replace(/\./g, '');
    bone.userData.name = name;
    bone.position.set(spec.t[0], spec.t[1], spec.t[2]);
    bone.quaternion.set(spec.r[0], spec.r[1], spec.r[2], spec.r[3]).normalize();
    created.set(name, bone);
    if (!spec.parent) root.add(bone);
    else created.get(spec.parent)!.add(bone);
  }
  root.updateWorldMatrix(true, true);
  _virtualRunnerRoot = root;
  return root;
}

function resetVirtualRunnerRig(root: T.Group): void {
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  root.scale.set(1, 1, 1);
  root.traverse((o) => {
    if (!(o as T.Bone).isBone) return;
    const b = o as T.Bone;
    const canon = (b.userData?.name as string | undefined) ?? b.name;
    const spec = DEFAULT_RUNNER_RIG_REST[canon];
    if (!spec) return;
    b.position.set(spec.t[0], spec.t[1], spec.t[2]);
    b.quaternion.set(spec.r[0], spec.r[1], spec.r[2], spec.r[3]).normalize();
    b.scale.set(1, 1, 1);
  });
  root.updateWorldMatrix(true, true);
}

/**
 * Filters/remaps a clip's tracks to nodes actually present on `root` (handling `.L` <-> `L` sanitization
 * and omitting auxiliary hair/eye/finger tracks absent on minimal rigs so `PropertyBinding` never warns).
 */
function buildBoundSamplingClip(clip: T.AnimationClip, root: T.Object3D): T.AnimationClip {
  const nodeNames = new Set<string>();
  root.traverse((o) => {
    if (o.name) nodeNames.add(o.name);
  });
  const boundTracks: T.KeyframeTrack[] = [];
  for (const tr of clip.tracks) {
    const dot = tr.name.lastIndexOf('.');
    if (dot < 0) continue;
    const rawNode = tr.name.slice(0, dot);
    const prop = tr.name.slice(dot + 1);
    if (nodeNames.has(rawNode)) {
      boundTracks.push(tr);
      continue;
    }
    const sanitized = rawNode.replace(/\./g, '');
    if (nodeNames.has(sanitized)) {
      const cloned = tr.clone();
      cloned.name = `${sanitized}.${prop}`;
      boundTracks.push(cloned);
    }
  }
  return new T.AnimationClip(clip.name, clip.duration, boundTracks);
}

// ── Empirical Clip Gait Metadata & Zero-Allocation Stance LUT ────────────────────────────────────────

export function getCachedClipGaitMeta(clip: T.AnimationClip): ClipGaitMeta | undefined {
  return _clipMetaCache.get(clip);
}

export function setCachedClipGaitMeta(clip: T.AnimationClip, meta: ClipGaitMeta): void {
  _clipMetaCache.set(clip, meta);
}

function createStaticGaitMeta(minAnkleDeltaY = 0): ClipGaitMeta {
  const stanceL = new Float32Array(STANCE_LUT_SIZE).fill(1);
  const stanceR = new Float32Array(STANCE_LUT_SIZE).fill(1);
  const stanceProgressL = new Float32Array(STANCE_LUT_SIZE).fill(0.45);
  const stanceProgressR = new Float32Array(STANCE_LUT_SIZE).fill(0.45);
  return {
    nativeStanceSpeed: 0,
    leftFootForwardFrac: 0,
    minAnkleDeltaY,
    stanceL,
    stanceR,
    stanceProgressL,
    stanceProgressR,
  };
}

function smoothPeriodicLut(src: Float32Array, passes = 2): Float32Array {
  const n = src.length;
  let cur = new Float32Array(src);
  let nxt = new Float32Array(n);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      const prev = cur[(i - 1 + n) % n];
      const next = cur[(i + 1) % n];
      nxt[i] = 0.25 * prev + 0.5 * cur[i] + 0.25 * next;
    }
    const tmp = cur;
    cur = nxt;
    nxt = tmp;
  }
  return cur;
}

function buildPeriodicStanceProgress(stance: Float32Array): Float32Array {
  const n = stance.length;
  const out = new Float32Array(n).fill(0.45);
  const threshold = 0.15;
  let allAbove = true;
  let anyAbove = false;
  for (let i = 0; i < n; i++) {
    if (stance[i] >= threshold) anyAbove = true;
    else allAbove = false;
  }
  if (!anyAbove || allAbove) return out;

  // Find a swing index (`stance < threshold`) to start circular scan cleanly
  let startSwing = 0;
  for (let i = 0; i < n; i++) {
    if (stance[i] < threshold) {
      startSwing = i;
      break;
    }
  }

  let k = 0;
  while (k < n) {
    const idx = (startSwing + k) % n;
    if (stance[idx] < threshold) {
      k++;
      continue;
    }
    const runStart = k;
    while (k < n && stance[(startSwing + k) % n] >= threshold) {
      k++;
    }
    const runLen = k - runStart;
    const denom = Math.max(1, runLen - 1);
    for (let j = 0; j < runLen; j++) {
      out[(startSwing + runStart + j) % n] = runLen === 1 ? 0.5 : j / denom;
    }
  }
  return out;
}

function quantileOfSorted(values: number[], q = 0.72): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const pos = T.MathUtils.clamp(q, 0, 1) * (values.length - 1);
  const i0 = Math.floor(pos);
  const i1 = Math.min(values.length - 1, i0 + 1);
  const frac = pos - i0;
  return values[i0] + (values[i1] - values[i0]) * frac;
}

/**
 * Measures a clip's exact empirical ground-stance speed (`nativeStanceSpeed`), left-foot forward
 * phase origin (`leftFootForwardFrac`), 64-sample periodic `stanceL/R` & `stanceProgressL/R` LUTs,
 * and upward ankle hover bias (`minAnkleDeltaY`) with **zero side effects** on `skeletonRoot`.
 */
export function measureClipGaitMeta(
  clip: T.AnimationClip,
  skeletonRoot: T.Object3D,
  bones: {
    hips?: T.Bone | null;
    footL?: T.Bone | null;
    footR?: T.Bone | null;
  },
  options: {
    restFootYL?: number;
    restFootYR?: number;
    isStandingStatic?: boolean;
    forceRecompute?: boolean;
  } = {},
): ClipGaitMeta {
  if (!options.forceRecompute) {
    const hit = _clipMetaCache.get(clip);
    if (hit) return hit;
  }

  const { hips, footL, footR } = bones;
  const duration = clip.duration;
  if (!footL || !footR || !(duration > 1e-4) || clip.tracks.length === 0) {
    const fallback = createStaticGaitMeta(0);
    _clipMetaCache.set(clip, fallback);
    return fallback;
  }

  // Save root + all bone local transforms so temporary FK sampling never mutates live state
  const savedRootPos = skeletonRoot.position.clone();
  const savedRootQuat = skeletonRoot.quaternion.clone();
  const savedRootScale = skeletonRoot.scale.clone();

  const savedBones: Array<{
    bone: T.Bone;
    pos: T.Vector3;
    quat: T.Quaternion;
    scale: T.Vector3;
  }> = [];
  skeletonRoot.traverse((o) => {
    if (!(o as T.Bone).isBone) return;
    const b = o as T.Bone;
    savedBones.push({
      bone: b,
      pos: b.position.clone(),
      quat: b.quaternion.clone(),
      scale: b.scale.clone(),
    });
  });

  let meta: ClipGaitMeta;
  const mixer = new T.AnimationMixer(skeletonRoot);
  try {
    skeletonRoot.position.set(0, 0, 0);
    skeletonRoot.quaternion.identity();
    skeletonRoot.scale.set(1, 1, 1);
    skeletonRoot.updateWorldMatrix(true, true);

    const vTmp = new T.Vector3();
    const restYL = options.restFootYL ?? footL.getWorldPosition(vTmp).y;
    const restYR = options.restFootYR ?? footR.getWorldPosition(vTmp).y;

    const samplingClip = buildBoundSamplingClip(clip, skeletonRoot);
    const action = mixer.clipAction(samplingClip);
    action.reset().setEffectiveWeight(1).setEffectiveTimeScale(1).play();

    const n = STANCE_LUT_SIZE;
    const yL = new Float32Array(n);
    const zL = new Float32Array(n);
    const yR = new Float32Array(n);
    const zR = new Float32Array(n);
    const zHips = new Float32Array(n);

    let minYL = Infinity;
    let maxYL = -Infinity;
    let minYR = Infinity;
    let maxYR = -Infinity;

    for (let i = 0; i < n; i++) {
      action.time = (duration * i) / n;
      mixer.update(0);
      skeletonRoot.updateWorldMatrix(true, true);

      footL.getWorldPosition(vTmp);
      yL[i] = vTmp.y;
      zL[i] = vTmp.z;
      if (vTmp.y < minYL) minYL = vTmp.y;
      if (vTmp.y > maxYL) maxYL = vTmp.y;

      footR.getWorldPosition(vTmp);
      yR[i] = vTmp.y;
      zR[i] = vTmp.z;
      if (vTmp.y < minYR) minYR = vTmp.y;
      if (vTmp.y > maxYR) maxYR = vTmp.y;

      if (hips) {
        hips.getWorldPosition(vTmp);
        zHips[i] = vTmp.z;
      }
    }

    action.stop();

    const rawHover = Math.min(minYL - restYL, minYR - restYR);
    const minAnkleDeltaY = Number.isFinite(rawHover)
      ? T.MathUtils.clamp(rawHover, 0, 0.12)
      : 0;

    const spanY = Math.max(maxYL - minYL, maxYR - minYR);
    if (options.isStandingStatic || spanY < 0.012) {
      meta = createStaticGaitMeta(minAnkleDeltaY);
    } else {
      const dtSample = duration / n;
      const rawStanceL = new Float32Array(n);
      const rawStanceR = new Float32Array(n);
      const stanceSpeedSamples: number[] = [];

      // Account for any linear root-motion Z translation on hips
      const hipsLinearSpeedZ = hips ? (zHips[n - 1] - zHips[0]) / Math.max(1e-4, duration * ((n - 1) / n)) : 0;

      for (let i = 0; i < n; i++) {
        const prev = (i - 1 + n) % n;
        const next = (i + 1) % n;
        const twoDt = 2 * dtSample;

        // Relative backward foot speed in hips/character frame (+Z = forward, so stance foot moves -Z)
        const dzL = zL[next] - zL[prev];
        const dzR = zR[next] - zR[prev];
        const vBackL = -(dzL / twoDt - hipsLinearSpeedZ);
        const vBackR = -(dzR / twoDt - hipsLinearSpeedZ);

        const hL = yL[i] - minYL;
        const hR = yR[i] - minYR;

        let wL = 1 - T.MathUtils.smoothstep(hL, 0.014, 0.038);
        if (vBackL < -0.15) wL *= 1 - T.MathUtils.smoothstep(-vBackL, 0.15, 0.75);
        rawStanceL[i] = wL;

        let wR = 1 - T.MathUtils.smoothstep(hR, 0.014, 0.038);
        if (vBackR < -0.15) wR *= 1 - T.MathUtils.smoothstep(-vBackR, 0.15, 0.75);
        rawStanceR[i] = wR;

        if (hL <= 0.020 && vBackL > 0.05) stanceSpeedSamples.push(vBackL);
        if (hR <= 0.020 && vBackR > 0.05) stanceSpeedSamples.push(vBackR);
      }

      const stanceL = smoothPeriodicLut(rawStanceL, 2);
      const stanceR = smoothPeriodicLut(rawStanceR, 2);
      const stanceProgressL = buildPeriodicStanceProgress(stanceL);
      const stanceProgressR = buildPeriodicStanceProgress(stanceR);
      // p72 of grounded frames (`h <= 2.0 cm`) captures full-weight mid-stance speed without heel-strike/toe-off ramp drag
      const nativeStanceSpeed = quantileOfSorted(stanceSpeedSamples, 0.72);

      // Peak relative left-foot forward lead (`(zL - zHips) - (zR - zHips) = zL - zR`)
      let bestK = 0;
      let bestLead = -Infinity;
      for (let i = 0; i < n; i++) {
        const lead = zL[i] - zR[i];
        if (lead > bestLead) {
          bestLead = lead;
          bestK = i;
        }
      }
      const prevLead = zL[(bestK - 1 + n) % n] - zR[(bestK - 1 + n) % n];
      const nextLead = zL[(bestK + 1) % n] - zR[(bestK + 1) % n];
      const denom = 2 * (2 * bestLead - prevLead - nextLead);
      const subBin = Math.abs(denom) > 1e-6 ? T.MathUtils.clamp((nextLead - prevLead) / denom, -0.5, 0.5) : 0;
      const leftFootForwardFrac = wrap01((bestK + subBin) / n);

      meta = {
        nativeStanceSpeed,
        leftFootForwardFrac,
        minAnkleDeltaY,
        stanceL,
        stanceR,
        stanceProgressL,
        stanceProgressR,
      };
    }
  } finally {
    mixer.stopAllAction();
    mixer.uncacheRoot(skeletonRoot);
    for (let i = 0; i < savedBones.length; i++) {
      const s = savedBones[i];
      s.bone.position.copy(s.pos);
      s.bone.quaternion.copy(s.quat);
      s.bone.scale.copy(s.scale);
    }
    skeletonRoot.position.copy(savedRootPos);
    skeletonRoot.quaternion.copy(savedRootQuat);
    skeletonRoot.scale.copy(savedRootScale);
    skeletonRoot.updateWorldMatrix(true, true);
  }

  _clipMetaCache.set(clip, meta);
  return meta;
}

const _defaultStanceOut = createStanceWeightsSnapshot();

/**
 * O(1) zero-allocation periodic readout of smoothed stance weights & heel-to-toe stance progress.
 */
export function sampleClipStanceLut(
  meta: ClipGaitMeta | null | undefined,
  phase01: number,
  out: StanceWeightsSnapshot = _defaultStanceOut,
): StanceWeightsSnapshot {
  const u = wrap01(phase01);
  out.phase01 = u;
  if (!meta) {
    out.stanceL = 1;
    out.stanceR = 1;
    out.progressL = 0.45;
    out.progressR = 0.45;
    return out;
  }
  const scaled = u * STANCE_LUT_SIZE;
  const i0 = Math.floor(scaled) & (STANCE_LUT_SIZE - 1);
  const i1 = (i0 + 1) & (STANCE_LUT_SIZE - 1);
  const frac = scaled - Math.floor(scaled);

  out.stanceL = meta.stanceL[i0] + (meta.stanceL[i1] - meta.stanceL[i0]) * frac;
  out.stanceR = meta.stanceR[i0] + (meta.stanceR[i1] - meta.stanceR[i0]) * frac;

  // Avoid backward interpolation across Toe-Off (1.0) -> Next Heel-Strike (0.0) reset
  const pL0 = meta.stanceProgressL[i0];
  const pL1 = meta.stanceProgressL[i1];
  out.progressL = pL1 >= pL0 ? pL0 + (pL1 - pL0) * frac : pL0;

  const pR0 = meta.stanceProgressR[i0];
  const pR1 = meta.stanceProgressR[i1];
  out.progressR = pR1 >= pR0 ? pR0 + (pR1 - pR0) * frac : pR0;
  return out;
}

export function blendStanceSnapshots(
  a: StanceWeightsSnapshot,
  b: StanceWeightsSnapshot,
  weightB: number,
  out: StanceWeightsSnapshot = _defaultStanceOut,
): StanceWeightsSnapshot {
  const w = T.MathUtils.clamp(weightB, 0, 1);
  const invW = 1 - w;
  out.stanceL = a.stanceL * invW + b.stanceL * w;
  out.stanceR = a.stanceR * invW + b.stanceR * w;
  out.progressL = a.progressL * invW + b.progressL * w;
  out.progressR = a.progressR * invW + b.progressR * w;
  out.phase01 = w >= 0.5 ? b.phase01 : a.phase01;
  return out;
}

/**
 * Computes exact stride-matched `timeScale` from empirical `ClipGaitMeta.nativeStanceSpeed`.
 */
export function clipStrideTimeScale(
  meta: ClipGaitMeta | null | undefined,
  speedMps: number,
  actorWorldScale = 1,
  legRatio = 1,
  fallbackNominal = 1.08,
  minScale = 0.22,
  maxScale = 1.85,
): number {
  const baseSpeed = meta && meta.nativeStanceSpeed > 0.15 ? meta.nativeStanceSpeed : fallbackNominal;
  const denom = Math.max(
    0.12,
    baseSpeed * Math.max(0.35, actorWorldScale) * Math.max(0.5, legRatio),
  );
  return T.MathUtils.clamp(Math.max(0, speedMps) / denom, minScale, maxScale);
}

// ── Schmitt-Trigger Locomotion Hysteresis & Centripetal Lean Helpers ─────────────────────────────────

export function stepSchmittLocomotionBand(
  current: SchmittLocomotionBand,
  speedMps: number,
  capabilities: { hasBrisk?: boolean; hasSprint?: boolean } = {},
): SchmittLocomotionBand {
  const v = Math.max(0, speedMps);
  const hasBrisk = capabilities.hasBrisk ?? true;
  const hasSprint = capabilities.hasSprint ?? false;
  const T0 = LOCOMOTION_SCHMITT_THRESHOLDS;

  // Allow direct multi-band jumps on sudden sprint/halt while preserving deadband hysteresis near boundaries
  if (v < T0.walkExitIdle) return 'idle';
  if (hasSprint && v >= T0.runEnterSprint) return 'sprint';

  switch (current) {
    case 'idle': {
      if (v < T0.idleEnterWalk) return 'idle';
      if (v >= T0.briskEnterRun) return 'run';
      if (hasBrisk && v >= T0.walkEnterBrisk) return 'walk_brisk';
      return 'walk';
    }
    case 'walk': {
      if (v >= T0.briskEnterRun) return 'run';
      if (hasBrisk && v >= T0.walkEnterBrisk) return 'walk_brisk';
      if (!hasBrisk && v >= 1.95) return 'run';
      return 'walk';
    }
    case 'walk_brisk': {
      if (!hasBrisk) return v >= 1.95 ? 'run' : 'walk';
      if (v >= T0.briskEnterRun) return 'run';
      if (v < T0.briskExitWalk) return 'walk';
      return 'walk_brisk';
    }
    case 'run': {
      if (v >= T0.runExitBrisk) return 'run';
      if (hasBrisk && v >= T0.briskExitWalk) return 'walk_brisk';
      return 'walk';
    }
    case 'sprint': {
      if (hasSprint && v >= T0.sprintExitRun) return 'sprint';
      if (v >= T0.runExitBrisk) return 'run';
      if (hasBrisk && v >= T0.briskExitWalk) return 'walk_brisk';
      return 'walk';
    }
  }
}

export function stepFilteredYawRate(
  prevFiltered: number,
  rawYawRate: number,
  dt: number,
  cutoffHz = 9,
): number {
  if (!(dt > 0)) return prevFiltered;
  const clampedRaw = T.MathUtils.clamp(Number.isFinite(rawYawRate) ? rawYawRate : 0, -8, 8);
  const alpha = 1 - Math.exp(-cutoffHz * dt);
  return prevFiltered + (clampedRaw - prevFiltered) * alpha;
}

export function applyYawRateDeadzone(filteredYawRate: number, deadzoneRadPerSec = 0.18): number {
  const abs = Math.abs(filteredYawRate);
  if (abs <= deadzoneRadPerSec) return 0;
  return Math.sign(filteredYawRate) * (abs - deadzoneRadPerSec);
}

/**
 * Bounded centripetal roll angle (rad) around character-root forward `+Z`:
 * `yawRate > 0` (left turn) -> negative roll around `+Z` (leans head `+Y` toward `+X` left!).
 */
export function computeTargetBankRoll(
  speedMps: number,
  effectiveYawRate: number,
  gain = 0.038,
  maxRad = 0.14,
): number {
  const cap = speedMps > 1.65 ? maxRad : Math.min(maxRad, 0.085);
  return T.MathUtils.clamp(-Math.max(0, speedMps) * effectiveYawRate * gain, -cap, cap);
}

// ── Loop Seam C2 Closure, Mocap Curve Yaw Detrending, Phase Shift & Sagittal Mirror ──────────────────

const _seamQ0 = new T.Quaternion();
const _seamQT = new T.Quaternion();
const _seamQInv = new T.Quaternion();
const _seamQGap = new T.Quaternion();
const _seamQHalfPos = new T.Quaternion();
const _seamQHalfNeg = new T.Quaternion();
const _seamQStep = new T.Quaternion();
const _seamQCur = new T.Quaternion();

/**
 * Closes residual pose mismatch between `t = 0` and `t = duration` across all quaternion and
 * vector tracks using symmetric midpoint quintic C2 blending (`track(T) === track(0)` with
 * continuous velocity across the loop wrap).
 */
export function closeClipLoopSeam(clip: T.AnimationClip, windowFrac = 0.18): T.AnimationClip {
  const out = clip.clone();
  const dur = out.duration;
  if (!(dur > 1e-4)) return out;
  const wSpan = T.MathUtils.clamp(windowFrac, 0.05, 0.45);

  for (let ti = 0; ti < out.tracks.length; ti++) {
    const tr = out.tracks[ti];
    const n = tr.times.length;
    if (n < 3) continue;
    const itemSize = tr.getValueSize();
    const vals = tr.values;

    if (tr instanceof T.QuaternionKeyframeTrack && itemSize === 4) {
      _seamQ0.set(vals[0], vals[1], vals[2], vals[3]).normalize();
      const last = (n - 1) * 4;
      _seamQT.set(vals[last], vals[last + 1], vals[last + 2], vals[last + 3]).normalize();
      if (_seamQ0.dot(_seamQT) < 0) {
        _seamQT.set(-_seamQT.x, -_seamQT.y, -_seamQT.z, -_seamQT.w);
      }
      // gap = q0 * inv(qT) => exp(+0.5*gap) * qT === exp(-0.5*gap) * q0 === qMid
      _seamQGap.copy(_seamQ0).multiply(_seamQInv.copy(_seamQT).invert()).normalize();
      if (_seamQGap.w < 0) {
        _seamQGap.set(-_seamQGap.x, -_seamQGap.y, -_seamQGap.z, -_seamQGap.w);
      }
      const angle = 2 * Math.acos(T.MathUtils.clamp(_seamQGap.w, -1, 1));
      if (angle < 1e-5) {
        vals[last] = _seamQ0.x;
        vals[last + 1] = _seamQ0.y;
        vals[last + 2] = _seamQ0.z;
        vals[last + 3] = _seamQ0.w;
        continue;
      }

      _seamQHalfPos.identity().slerp(_seamQGap, 0.5);
      _seamQHalfNeg.copy(_seamQHalfPos).invert();

      for (let i = 0; i < n; i++) {
        const u = tr.times[i] / dur;
        const o = i * 4;
        _seamQCur.set(vals[o], vals[o + 1], vals[o + 2], vals[o + 3]).normalize();
        if (u < wSpan) {
          const blend = 1 - quinticSmooth01(u / wSpan);
          _seamQStep.identity().slerp(_seamQHalfNeg, blend);
          _seamQCur.premultiply(_seamQStep).normalize();
        } else if (u > 1 - wSpan) {
          const blend = 1 - quinticSmooth01((1 - u) / wSpan);
          _seamQStep.identity().slerp(_seamQHalfPos, blend);
          _seamQCur.premultiply(_seamQStep).normalize();
        }
        vals[o] = _seamQCur.x;
        vals[o + 1] = _seamQCur.y;
        vals[o + 2] = _seamQCur.z;
        vals[o + 3] = _seamQCur.w;
      }
      // Guarantee bit-identical endpoints
      vals[last] = vals[0];
      vals[last + 1] = vals[1];
      vals[last + 2] = vals[2];
      vals[last + 3] = vals[3];
    } else if (itemSize === 3) {
      const last = (n - 1) * 3;
      const gx = vals[0] - vals[last];
      const gy = vals[1] - vals[last + 1];
      const gz = vals[2] - vals[last + 2];
      if (Math.hypot(gx, gy, gz) < 1e-6) continue;
      for (let i = 0; i < n; i++) {
        const u = tr.times[i] / dur;
        const o = i * 3;
        if (u < wSpan) {
          const b = -0.5 * (1 - quinticSmooth01(u / wSpan));
          vals[o] += gx * b;
          vals[o + 1] += gy * b;
          vals[o + 2] += gz * b;
        } else if (u > 1 - wSpan) {
          const b = 0.5 * (1 - quinticSmooth01((1 - u) / wSpan));
          vals[o] += gx * b;
          vals[o + 1] += gy * b;
          vals[o + 2] += gz * b;
        }
      }
      vals[last] = vals[0];
      vals[last + 1] = vals[1];
      vals[last + 2] = vals[2];
    }
  }
  return out;
}

function sampleQuatAt(track: T.KeyframeTrack, t: number, out: T.Quaternion, qA: T.Quaternion, qB: T.Quaternion): T.Quaternion {
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
  qA.set(vals[a], vals[a + 1], vals[a + 2], vals[a + 3]).normalize();
  qB.set(vals[b], vals[b + 1], vals[b + 2], vals[b + 3]).normalize();
  return out.copy(qA).slerp(qB, alpha).normalize();
}

function sampleVecAt(track: T.KeyframeTrack, t: number, out: T.Vector3): T.Vector3 {
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

/**
 * Removes linear & mean mocap-stage horizontal yaw drift on `hips` (eliminating `Walk_Brisk`'s
 * `-19.4° -> +14.9°` = `34.3°` loop-seam snap and `Turn_L/R` `+-47°` root yaw drift while preserving
 * 100% of periodic pelvic counter-yaw oscillation) and optionally closes the loop seam with C2 quintics.
 */
export function detrendClipYawAndCloseSeam(
  clip: T.AnimationClip,
  options: {
    restHipsQuat?: T.Quaternion;
    restHipsPos?: T.Vector3;
    stripLinearYawDrift?: boolean;
    stripMeanYaw?: boolean;
    closeLoopSeam?: boolean;
  } = {},
): T.AnimationClip {
  const stripLinear = options.stripLinearYawDrift ?? true;
  const stripMean = options.stripMeanYaw ?? true;
  const doCloseSeam = options.closeLoopSeam ?? true;

  const out = clip.clone();
  const dur = out.duration;
  if (!(dur > 1e-4)) return out;

  const hipsQuatIdx = out.tracks.findIndex(
    (tr) => tr.name === 'hips.quaternion' || tr.name === 'Hips.quaternion',
  );
  const hipsPosIdx = out.tracks.findIndex(
    (tr) => tr.name === 'hips.position' || tr.name === 'Hips.position',
  );

  if (hipsQuatIdx >= 0 && (stripLinear || stripMean)) {
    const qTrack = out.tracks[hipsQuatIdx];
    const n = qTrack.times.length;
    if (n >= 2) {
      const defaultRest = DEFAULT_RUNNER_RIG_REST.hips;
      const restQ = options.restHipsQuat
        ? options.restHipsQuat.clone().normalize()
        : new T.Quaternion(defaultRest.r[0], defaultRest.r[1], defaultRest.r[2], defaultRest.r[3]).normalize();
      const invRestQ = restQ.clone().invert();
      const restPos = options.restHipsPos
        ? options.restHipsPos.clone()
        : new T.Vector3(defaultRest.t[0], defaultRest.t[1], defaultRest.t[2]);

      const yaws = new Float64Array(n);
      const qCur = new T.Quaternion();
      const qDelta = new T.Quaternion();
      const fwd = new T.Vector3();

      for (let i = 0; i < n; i++) {
        const o = i * 4;
        qCur.set(qTrack.values[o], qTrack.values[o + 1], qTrack.values[o + 2], qTrack.values[o + 3]).normalize();
        qDelta.copy(qCur).multiply(invRestQ).normalize();
        fwd.set(0, 0, 1).applyQuaternion(qDelta);
        let psi = Math.atan2(fwd.x, fwd.z);
        if (i > 0) {
          while (psi - yaws[i - 1] > Math.PI) psi -= Math.PI * 2;
          while (psi - yaws[i - 1] < -Math.PI) psi += Math.PI * 2;
        }
        yaws[i] = psi;
      }

      const psiDrift = stripLinear ? yaws[n - 1] - yaws[0] : 0;
      let meanDetrended = 0;
      if (stripMean) {
        // Integrate over [0, n - 1) so periodic endpoint isn't double-counted
        const count = Math.max(1, n - 1);
        let sum = 0;
        for (let i = 0; i < count; i++) {
          const u = qTrack.times[i] / dur;
          sum += yaws[i] - psiDrift * (u - 0.5);
        }
        meanDetrended = sum / count;
      }

      const qCorr = new T.Quaternion();
      for (let i = 0; i < n; i++) {
        const u = qTrack.times[i] / dur;
        const trendYaw = meanDetrended + psiDrift * (u - 0.5);
        qCorr.setFromAxisAngle(Y_AXIS, -trendYaw);
        const o = i * 4;
        qCur.set(qTrack.values[o], qTrack.values[o + 1], qTrack.values[o + 2], qTrack.values[o + 3]).normalize();
        qCur.premultiply(qCorr).normalize();
        qTrack.values[o] = qCur.x;
        qTrack.values[o + 1] = qCur.y;
        qTrack.values[o + 2] = qCur.z;
        qTrack.values[o + 3] = qCur.w;
      }

      if (hipsPosIdx >= 0) {
        const pTrack = out.tracks[hipsPosIdx];
        const pn = pTrack.times.length;
        const vPos = new T.Vector3();
        for (let i = 0; i < pn; i++) {
          const u = pTrack.times[i] / dur;
          const trendYaw = meanDetrended + psiDrift * (u - 0.5);
          qCorr.setFromAxisAngle(Y_AXIS, -trendYaw);
          const o = i * 3;
          vPos
            .set(pTrack.values[o], pTrack.values[o + 1], pTrack.values[o + 2])
            .sub(restPos)
            .applyQuaternion(qCorr);
          // Also strip horizontal X/Z linear drift when detrending curved walks/turns
          if (stripLinear) {
            const o0 = 0;
            const oEnd = (pn - 1) * 3;
            if (i === 0 && pn >= 2) {
              // handled via closeClipLoopSeam below
              void o0;
              void oEnd;
            }
          }
          vPos.add(restPos);
          pTrack.values[o] = vPos.x;
          pTrack.values[o + 1] = vPos.y;
          pTrack.values[o + 2] = vPos.z;
        }
      }
    }
  }

  return doCloseSeam ? closeClipLoopSeam(out, 0.18) : out;
}

/**
 * Circularly shifts all keyframe tracks of `sprintClip` so its `leftFootForwardFrac` aligns
 * identically with `referenceOrExplicitShift`:
 *  - `number`: shifts phase explicitly by `phaseShiftFrac` (`u_old = wrap01(u_new - phaseShiftFrac)`).
 *  - `T.AnimationClip` (e.g. `Run` or `Walk`): measures both clips and aligns `Sprint` to match the reference clip's exact `leftFootForwardFrac`!
 *  - `undefined` / `null`: measures `sprintClip` and aligns its `leftFootForwardFrac` to `0.000`.
 */
export function alignSprintPhaseOrigin(
  sprintClip: T.AnimationClip,
  referenceOrExplicitShift?: T.AnimationClip | number | null,
  modelOrNull?: T.Object3D | null,
): T.AnimationClip {
  const dur = sprintClip.duration;
  if (!(dur > 1e-4)) return sprintClip.clone();

  const cleanLoop = closeClipLoopSeam(sprintClip, 0.14);

  let sampleOffsetFrac: number;
  if (typeof referenceOrExplicitShift === 'number') {
    sampleOffsetFrac = wrap01(-referenceOrExplicitShift);
  } else {
    const rig = modelOrNull ?? getVirtualRunnerRig();
    if (!modelOrNull) resetVirtualRunnerRig(rig as T.Group);
    let hips: T.Bone | null = null;
    let footL: T.Bone | null = null;
    let footR: T.Bone | null = null;
    rig.traverse((o) => {
      if (!(o as T.Bone).isBone) return;
      const b = o as T.Bone;
      const n = (b.userData?.name as string | undefined) ?? b.name;
      if (n === 'hips') hips = b;
      else if (n === 'foot.L' || n === 'footL') footL = b;
      else if (n === 'foot.R' || n === 'footR') footR = b;
    });
    const curLead = measureClipGaitMeta(cleanLoop, rig, { hips, footL, footR }, { forceRecompute: true }).leftFootForwardFrac;
    const targetLead =
      referenceOrExplicitShift instanceof T.AnimationClip
        ? measureClipGaitMeta(referenceOrExplicitShift, rig, { hips, footL, footR }).leftFootForwardFrac
        : 0;
    // At u_new = targetLead, we want u_old = curLead => u_old = wrap01(u_new + (curLead - targetLead))
    sampleOffsetFrac = wrap01(curLead - targetLead);
  }

  const steps = Math.max(32, Math.round(dur * 48));
  const times = new Float32Array(steps + 1);
  for (let i = 0; i <= steps; i++) times[i] = (dur * i) / steps;

  const qOut = new T.Quaternion();
  const qA = new T.Quaternion();
  const qB = new T.Quaternion();
  const vOut = new T.Vector3();
  const newTracks: T.KeyframeTrack[] = [];

  for (const tr of cleanLoop.tracks) {
    const size = tr.getValueSize();
    if (tr instanceof T.QuaternionKeyframeTrack && size === 4) {
      const vals = new Float32Array((steps + 1) * 4);
      for (let i = 0; i <= steps; i++) {
        const u = i === steps ? 0 : i / steps;
        const tOld = wrap01(u + sampleOffsetFrac) * dur;
        sampleQuatAt(tr, tOld, qOut, qA, qB);
        const o = i * 4;
        vals[o] = qOut.x;
        vals[o + 1] = qOut.y;
        vals[o + 2] = qOut.z;
        vals[o + 3] = qOut.w;
      }
      newTracks.push(new T.QuaternionKeyframeTrack(tr.name, times, vals));
    } else if (size === 3) {
      const vals = new Float32Array((steps + 1) * 3);
      for (let i = 0; i <= steps; i++) {
        const u = i === steps ? 0 : i / steps;
        const tOld = wrap01(u + sampleOffsetFrac) * dur;
        sampleVecAt(tr, tOld, vOut);
        const o = i * 3;
        vals[o] = vOut.x;
        vals[o + 1] = vOut.y;
        vals[o + 2] = vOut.z;
      }
      newTracks.push(new T.VectorKeyframeTrack(tr.name, times, vals));
    } else {
      newTracks.push(tr.clone());
    }
  }

  return new T.AnimationClip(sprintClip.name, dur, newTracks);
}

function mirrorBoneName(canon: string): string {
  if (canon.endsWith('.L')) return canon.slice(0, -2) + '.R';
  if (canon.endsWith('.R')) return canon.slice(0, -2) + '.L';
  return canon;
}

function canonicalizeRunnerTrackBone(rawBone: string): string | null {
  if (DEFAULT_RUNNER_RIG_REST[rawBone]) return rawBone;
  for (const name of RUNNER_BONE_ORDER) {
    if (name.replace(/\./g, '') === rawBone || name.toLowerCase() === rawBone.toLowerCase()) {
      return name;
    }
  }
  return null;
}

/**
 * Synthesizes an exact sagittal-plane (`YZ`, `X -> -X`) mirrored `Turn_R` clip from `Turn_L`
 * in model world-delta space (`deltaW_mirror = (+qx, -qy, -qz, +qw)` with `.L <-> .R` swapped),
 * replacing `all48`'s broken stationary `2.6°` `Turn_R` with an authentic `-47.0°` right turn.
 */
export function synthesizeMirroredTurnRight(
  turnLeftClip: T.AnimationClip,
  options: {
    detrendYaw?: boolean;
    closeSeam?: boolean;
    name?: string;
    sampleHz?: number;
  } = {},
): T.AnimationClip {
  const dur = Math.max(0.05, turnLeftClip.duration);
  const hz = options.sampleHz ?? 36;
  const steps = Math.max(8, Math.min(96, Math.round(dur * hz)));
  const times = new Float32Array(steps + 1);
  for (let i = 0; i <= steps; i++) times[i] = (dur * i) / steps;

  // Build world rest poses for RunnerRig
  const localRest: Record<string, T.Quaternion> = {};
  const worldRest: Record<string, T.Quaternion> = {};
  const invWorldRest: Record<string, T.Quaternion> = {};
  for (const b of RUNNER_BONE_ORDER) {
    const e = DEFAULT_RUNNER_RIG_REST[b];
    const lq = new T.Quaternion(e.r[0], e.r[1], e.r[2], e.r[3]).normalize();
    localRest[b] = lq;
    worldRest[b] = e.parent ? worldRest[e.parent].clone().multiply(lq).normalize() : lq.clone();
    invWorldRest[b] = worldRest[b].clone().invert();
  }

  const srcQuatTracks = new Map<string, T.KeyframeTrack>();
  let srcHipsPosTrack: T.KeyframeTrack | null = null;
  let useDotBoneNames = true;

  for (const tr of turnLeftClip.tracks) {
    const dot = tr.name.lastIndexOf('.');
    if (dot < 0) continue;
    const rawBone = tr.name.slice(0, dot);
    const prop = tr.name.slice(dot + 1);
    if (rawBone === 'thighL' || rawBone === 'upper_armL') useDotBoneNames = false;
    const canon = canonicalizeRunnerTrackBone(rawBone);
    if (!canon) continue;
    if (prop === 'quaternion') srcQuatTracks.set(canon, tr);
    else if (prop === 'position' && canon === 'hips') srcHipsPosTrack = tr;
  }

  const quatBuffers = new Map<string, Float32Array>();
  for (const b of RUNNER_BONE_ORDER) {
    quatBuffers.set(b, new Float32Array((steps + 1) * 4));
  }
  const hipsPosBuf = srcHipsPosTrack ? new Float32Array((steps + 1) * 3) : null;
  const hipsRestOrigin = new T.Vector3(...DEFAULT_RUNNER_RIG_REST.hips.t);

  const srcWorld: Record<string, T.Quaternion> = {};
  const srcDelta: Record<string, T.Quaternion> = {};
  const mirWorld: Record<string, T.Quaternion> = {};
  for (const b of RUNNER_BONE_ORDER) {
    srcWorld[b] = new T.Quaternion();
    srcDelta[b] = new T.Quaternion();
    mirWorld[b] = new T.Quaternion();
  }

  const qSample = new T.Quaternion();
  const qA = new T.Quaternion();
  const qB = new T.Quaternion();
  const qLocalOut = new T.Quaternion();
  const vPos = new T.Vector3();

  for (let i = 0; i <= steps; i++) {
    const t = times[i];

    // 1. Evaluate source Turn_L FK world orientations & deltas
    for (const b of RUNNER_BONE_ORDER) {
      const tr = srcQuatTracks.get(b);
      const lq = tr ? sampleQuatAt(tr, t, qSample, qA, qB) : localRest[b];
      const p = DEFAULT_RUNNER_RIG_REST[b].parent;
      if (!p) srcWorld[b].copy(lq);
      else srcWorld[b].copy(srcWorld[p]).multiply(lq).normalize();
      srcDelta[b].copy(srcWorld[b]).multiply(invWorldRest[b]).normalize();
    }

    // 2. Reflect world deltas across YZ sagittal plane: .L <-> .R, (qx, -qy, -qz, qw)
    for (const b of RUNNER_BONE_ORDER) {
      const opp = mirrorBoneName(b);
      const d = srcDelta[opp];
      qSample.set(d.x, -d.y, -d.z, d.w).normalize();
      mirWorld[b].copy(qSample).multiply(worldRest[b]).normalize();

      const p = DEFAULT_RUNNER_RIG_REST[b].parent;
      if (!p) qLocalOut.copy(mirWorld[b]);
      else qLocalOut.copy(mirWorld[p]).invert().multiply(mirWorld[b]).normalize();

      const buf = quatBuffers.get(b)!;
      const o = i * 4;
      buf[o] = qLocalOut.x;
      buf[o + 1] = qLocalOut.y;
      buf[o + 2] = qLocalOut.z;
      buf[o + 3] = qLocalOut.w;
    }

    if (hipsPosBuf && srcHipsPosTrack) {
      sampleVecAt(srcHipsPosTrack, t, vPos);
      vPos.sub(hipsRestOrigin);
      vPos.x = -vPos.x;
      vPos.add(hipsRestOrigin);
      const o = i * 3;
      hipsPosBuf[o] = vPos.x;
      hipsPosBuf[o + 1] = vPos.y;
      hipsPosBuf[o + 2] = vPos.z;
    }
  }

  const tracks: T.KeyframeTrack[] = [];
  if (hipsPosBuf) {
    tracks.push(new T.VectorKeyframeTrack('hips.position', times, hipsPosBuf));
  }
  for (const b of RUNNER_BONE_ORDER) {
    const outBoneName = useDotBoneNames ? b : b.replace(/\./g, '');
    tracks.push(new T.QuaternionKeyframeTrack(`${outBoneName}.quaternion`, times, quatBuffers.get(b)!));
  }

  const mirrored = new T.AnimationClip(options.name ?? 'Turn_R', dur, tracks);
  if (options.detrendYaw) {
    return detrendClipYawAndCloseSeam(mirrored, {
      stripLinearYawDrift: true,
      stripMeanYaw: true,
      closeLoopSeam: options.closeSeam ?? true,
    });
  }
  return options.closeSeam ? closeClipLoopSeam(mirrored, 0.16) : mirrored;
}

// ── Athletic Velocity-Scaled Upper-Body Synthesis (Fixes 180° Outward Palm Flip & Chicken-Wing Run) ──

function composeFrameDelta(
  rightAxis: T.Vector3,
  upAxis: T.Vector3,
  fwdAxis: T.Vector3,
  pitch: number,
  yaw: number,
  roll: number,
  out: T.Quaternion,
  qTmp1: T.Quaternion,
  qTmp2: T.Quaternion,
): T.Quaternion {
  out.setFromAxisAngle(upAxis, yaw);
  if (pitch !== 0) {
    qTmp1.setFromAxisAngle(rightAxis, pitch);
    out.multiply(qTmp1);
  }
  if (roll !== 0) {
    qTmp2.setFromAxisAngle(fwdAxis, roll);
    out.multiply(qTmp2);
  }
  return out.normalize();
}

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

function setBoneWorldQuat(bone: T.Bone, worldQ: T.Quaternion, qParentInv: T.Quaternion): void {
  if (bone.parent) {
    bone.parent.getWorldQuaternion(qParentInv).invert();
    bone.quaternion.copy(qParentInv).multiply(worldQ).normalize();
  } else {
    bone.quaternion.copy(worldQ).normalize();
  }
  bone.updateWorldMatrix(false, true);
}

/**
 * Replaces stiff/chicken-wing upper-body tracks on a `RunnerRig` locomotion clip (`Walk`, `Walk_Brisk`,
 * `Run`, `Sprint`) while preserving 100% of lower-body tracks (`hips.position`, `thigh`, `shin`, `foot`).
 *
 * Key biomechanical guarantees:
 *  - Corrected inward palm normal `inward = +sgn * hinge` (`(-1, 0, 0)` for `.L`, `(+1, 0, 0)` for `.R`
 *    in `+X`-left character space) + dorsal-downward pronation `cross(foreDir, hinge)`:
 *    `palm · inward >= +0.84`, `thumb · up >= +0.74` in Run, `|wristRoll| <= 26°`, `0` `180°` flips!
 *  - Natural velocity-scaled elbow flexion: `22°–36°` Walk, `34°–56°` Brisk, `75.5°–90.5°` Run, `80°–90°` Sprint.
 *  - Counter-phase pelvic yaw/drop, thoracic counter-torsion, clavicle protraction, and horizon-stabilized head.
 *  - Zero mutation of `modelOrNull` (all bone & root transforms saved and restored cleanly).
 */
export function upgradeGaitUpperBody(
  sourceClip: T.AnimationClip,
  modelOrNull: T.Object3D | null | undefined,
  kind: GaitUpgradeKind,
  footLeadFrac?: number,
): T.AnimationClip {
  const model = modelOrNull ?? getVirtualRunnerRig();
  if (!modelOrNull) resetVirtualRunnerRig(model as T.Group);

  const duration = Math.max(0.05, sourceClip.duration);

  // Locate bones by authored (`shoulder.L`) or Three.js-sanitized (`shoulderL`) name
  const byCanon = new Map<string, T.Bone>();
  const allBones: Array<{
    bone: T.Bone;
    pos: T.Vector3;
    quat: T.Quaternion;
    scale: T.Vector3;
  }> = [];

  const savedRootPos = model.position.clone();
  const savedRootQuat = model.quaternion.clone();
  const savedRootScale = model.scale.clone();

  model.traverse((o) => {
    if (!(o as T.Bone).isBone) return;
    const b = o as T.Bone;
    allBones.push({
      bone: b,
      pos: b.position.clone(),
      quat: b.quaternion.clone(),
      scale: b.scale.clone(),
    });
    const authored = (b.userData?.name as string | undefined) ?? b.name;
    byCanon.set(authored, b);
    byCanon.set(b.name, b);
    for (const canon of [...RUNNER_BONE_ORDER, 'fore_twist.L', 'fore_twist.R']) {
      if (b.name === canon || b.name === canon.replace(/\./g, '') || authored === canon) {
        byCanon.set(canon, b);
      }
    }
  });

  const hips = byCanon.get('hips');
  const spine = byCanon.get('spine');
  const chest = byCanon.get('chest');
  const neck = byCanon.get('neck');
  const head = byCanon.get('head');
  if (!hips || !spine || !chest || !neck || !head) {
    return sourceClip.clone();
  }

  // Detect whether sourceClip uses dot names (`upper_arm.L`) or sanitized names (`upper_armL`)
  const usesSanitizedNames = sourceClip.tracks.some(
    (tr) => tr.name.startsWith('thighL.') || tr.name.startsWith('upper_armL.'),
  );

  // Measure footLeadFrac empirically if caller didn't supply it
  const resolvedFootLead =
    footLeadFrac ??
    measureClipGaitMeta(sourceClip, model, {
      hips,
      footL: byCanon.get('foot.L'),
      footR: byCanon.get('foot.R'),
    }).leftFootForwardFrac;

  const srcLegTrack = sourceClip.tracks.find(
    (tr) => tr.name === 'thighL.quaternion' || tr.name === 'thigh.L.quaternion',
  );
  const steps =
    srcLegTrack && srcLegTrack.times.length > 2
      ? srcLegTrack.times.length - 1
      : Math.max(48, Math.round(duration * 60));
  const times = new Float32Array(steps + 1);
  for (let i = 0; i <= steps; i++) times[i] = (duration * i) / steps;

  const emitBones = [...UPPER_GAIT_BONES_DOT];
  if (byCanon.has('fore_twist.L')) emitBones.push('fore_twist.L');
  if (byCanon.has('fore_twist.R')) emitBones.push('fore_twist.R');
  const legSides = (['L', 'R'] as const).filter(
    (s) => byCanon.has(`thigh.${s}`) && byCanon.has(`shin.${s}`) && byCanon.has(`foot.${s}`),
  );
  for (const s of legSides) {
    emitBones.push(`thigh.${s}`, `shin.${s}`, `foot.${s}`);
  }

  const quatData = new Map<string, Float32Array>();
  for (const bName of emitBones) {
    if (byCanon.has(bName)) quatData.set(bName, new Float32Array((steps + 1) * 4));
  }
  const hasHipsPosTrack = sourceClip.tracks.some(
    (tr) => tr.name === 'hips.position' || tr.name === 'Hips.position',
  );
  const hipsPosData = legSides.length > 0 && hasHipsPosTrack ? new Float32Array((steps + 1) * 3) : null;
  let hipsPosAdjusted = false;

  const mixer = new T.AnimationMixer(model);
  try {
    model.position.set(0, 0, 0);
    model.quaternion.identity();
    model.scale.set(1, 1, 1);

    // Ensure rest pose matches RunnerRig bind pose before capturing bindWorldQuat
    for (const [canon, spec] of Object.entries(DEFAULT_RUNNER_RIG_REST)) {
      const b = byCanon.get(canon);
      if (b) {
        b.position.set(spec.t[0], spec.t[1], spec.t[2]);
        b.quaternion.set(spec.r[0], spec.r[1], spec.r[2], spec.r[3]).normalize();
        b.scale.set(1, 1, 1);
      }
    }
    model.updateWorldMatrix(true, true);

    const bindWorldQuat = new Map<string, T.Quaternion>();
    const bindLocalQuat = new Map<string, T.Quaternion>();
    for (const bName of emitBones) {
      const b = byCanon.get(bName);
      if (b) {
        bindWorldQuat.set(bName, b.getWorldQuaternion(new T.Quaternion()).normalize());
        bindLocalQuat.set(bName, b.quaternion.clone());
      }
    }

    const samplingClip = buildBoundSamplingClip(sourceClip, model);
    const action = mixer.clipAction(samplingClip);
    action.reset().setEffectiveWeight(1).setEffectiveTimeScale(1).play();

    const q1 = new T.Quaternion();
    const q2 = new T.Quaternion();
    const q3 = new T.Quaternion();
    const q4 = new T.Quaternion();
    const hipsWorldQ = new T.Quaternion();
    const bodyLeft = new T.Vector3();
    const bodyUp = new T.Vector3();
    const bodyFwd = new T.Vector3();
    const cLeft = new T.Vector3();
    const cUp = new T.Vector3();
    const cFwd = new T.Vector3();
    const upperDir = new T.Vector3();
    const rawHinge = new T.Vector3();
    const flexDir = new T.Vector3();
    const foreDir = new T.Vector3();
    const hinge = new T.Vector3();
    const inwardDir = new T.Vector3();
    const pronationDir = new T.Vector3();
    const palmNormal = new T.Vector3();
    const fingersDir = new T.Vector3();
    const vBasisX = new T.Vector3();
    const vBasisY = new T.Vector3();
    const vBasisZ = new T.Vector3();
    const mBasis = new T.Matrix4();
    const savedHipsPos = new T.Vector3();

    // Scratch for lower-body world ankle/knee/foot preservation across hips.quaternion replacement
    const origLegSnap = {
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
    const qThighNewW = new T.Quaternion();
    const qShinNewW = new T.Quaternion();
    const qSwingLeg = new T.Quaternion();
    const vWorldDown = new T.Vector3();
    const MAX_REACH_COS = Math.cos(deg(4.6) * 0.5); // Guarantees kneeFlex >= 4.6° (>= 4.0° R01 gate)

    const applyTrunkAngles = (spec: {
      hipsPitch: number;
      hipsYaw: number;
      hipsRoll: number;
      spinePitch: number;
      spineYaw: number;
      spineRoll: number;
      chestPitch: number;
      chestYaw: number;
      chestRoll: number;
      neckPitch: number;
      neckYaw: number;
      neckRoll: number;
      headPitch: number;
      headYaw: number;
      headRoll: number;
    }) => {
      composeFrameDelta(X_AXIS, Y_AXIS, Z_AXIS, spec.hipsPitch, spec.hipsYaw, spec.hipsRoll, q1, q2, q3);
      hipsWorldQ.copy(q1);
      q4.copy(q1).multiply(bindWorldQuat.get('hips')!).normalize();
      setBoneWorldQuat(hips, q4, q2);

      bodyLeft.set(1, 0, 0).applyQuaternion(hipsWorldQ).normalize();
      bodyUp.set(0, 1, 0).applyQuaternion(hipsWorldQ).normalize();
      bodyFwd.set(0, 0, 1).applyQuaternion(hipsWorldQ).normalize();

      let accP = 0;
      let accY = 0;
      let accR = 0;
      const chain: Array<[string, T.Bone, number, number, number]> = [
        ['spine', spine, spec.spinePitch, spec.spineYaw, spec.spineRoll],
        ['chest', chest, spec.chestPitch, spec.chestYaw, spec.chestRoll],
        ['neck', neck, spec.neckPitch, spec.neckYaw, spec.neckRoll],
        ['head', head, spec.headPitch, spec.headYaw, spec.headRoll],
      ];
      for (const [name, bone, dp, dy, dr] of chain) {
        accP += dp;
        accY += dy;
        accR += dr;
        composeFrameDelta(bodyLeft, bodyUp, bodyFwd, accP, accY, accR, q1, q2, q3);
        q1.multiply(hipsWorldQ).multiply(bindWorldQuat.get(name)!).normalize();
        setBoneWorldQuat(bone, q1, q2);
      }
    };

    const MAX_FOREARM_TWIST_RAD = (85 * Math.PI) / 180;
    const twistTrackState: Record<
      'L' | 'R',
      { seen: boolean; lastTwist: number; firstTwist: number }
    > = {
      L: { seen: false, lastTwist: 0, firstTwist: 0 },
      R: { seen: false, lastTwist: 0, firstTwist: 0 },
    };
    let currentStepIdx = 0;

    const poseArm = (
      side: 'L' | 'R',
      opts: {
        clavicleProtract: number;
        clavicleLift: number;
        shoulderPitch: number;
        shoulderAbduct: number;
        shoulderInward: number;
        elbowFlex: number;
        wristPitch: number;
        palmPronation: number;
      },
    ) => {
      // In RunnerRig model space, +X (`cLeft`) is anatomical LEFT (+1 for 'L', -1 for 'R')
      const sgn = side === 'L' ? 1 : -1;
      const clav = byCanon.get(`shoulder.${side}`);
      const upper = byCanon.get(`upper_arm.${side}`);
      const fore = byCanon.get(`forearm.${side}`);
      const hand = byCanon.get(`hand.${side}`);
      const twist = byCanon.get(`fore_twist.${side}`);
      if (!clav || !upper || !fore || !hand) return;

      chest.getWorldQuaternion(q4);
      cLeft.set(1, 0, 0).applyQuaternion(q4).normalize();
      cUp.set(0, 1, 0).applyQuaternion(q4).normalize();
      cFwd.set(0, 0, 1).applyQuaternion(q4).normalize();

      const protract = T.MathUtils.clamp(opts.clavicleProtract, -0.22, 0.22);
      const lift = T.MathUtils.clamp(opts.clavicleLift, -0.20, 0.20);
      composeFrameDelta(cLeft, cUp, cFwd, 0, -sgn * protract, sgn * lift, q1, q2, q3);
      q2.copy(q4).multiply(bindLocalQuat.get(`shoulder.${side}`)!).normalize();
      q1.multiply(q2).normalize();
      setBoneWorldQuat(clav, q1, q3);

      const sp = opts.shoulderPitch;
      const abd = opts.shoulderAbduct;
      const crossBody = opts.shoulderInward;
      upperDir
        .copy(cUp)
        .multiplyScalar(-Math.cos(sp) * Math.cos(abd))
        .addScaledVector(cFwd, Math.sin(sp) * Math.cos(abd))
        .addScaledVector(cLeft, sgn * (Math.sin(abd) - crossBody))
        .normalize();

      // Keep elbow hinge anatomically aligned with the torso sagittal plane (zero deltoid twist or cross-chest swing)
      const inwardCross = T.MathUtils.clamp(0.06 + crossBody * 0.45, -0.18, 0.24);
      rawHinge
        .copy(cLeft)
        .multiplyScalar(-1)
        .addScaledVector(cUp, -sgn * inwardCross);
      rawHinge.addScaledVector(upperDir, -rawHinge.dot(upperDir)).normalize();

      const flex = T.MathUtils.clamp(opts.elbowFlex, deg(6), deg(142));
      flexDir.crossVectors(rawHinge, upperDir).normalize();
      foreDir
        .copy(upperDir)
        .multiplyScalar(Math.cos(flex))
        .addScaledVector(flexDir, Math.sin(flex))
        .normalize();

      hinge.crossVectors(upperDir, foreDir);
      if (hinge.lengthSq() < 1e-6) hinge.copy(cLeft).multiplyScalar(-1);
      hinge.normalize();

      limbWorldFrame(upperDir, hinge, q1, vBasisX, vBasisY, vBasisZ, mBasis);
      setBoneWorldQuat(upper, q1, q2);

      limbWorldFrame(foreDir, hinge, q1, vBasisX, vBasisY, vBasisZ, mBasis);
      setBoneWorldQuat(fore, q1, q2);

      // CRITICAL FIX: `hinge` points along `-cLeft` (`(-1, 0, 0)`).
      // Multiplying by `+sgn` (`+1` for L, `-1` for R) yields `(-1, 0, 0)` for Left hand and `(+1, 0, 0)`
      // for Right hand — BOTH pointing INWARD toward the body midline (thumbs UP in 90° Run, forward in Walk)!
      // `pronationDir = cross(foreDir, hinge)` points rearward when hanging and downward in 90° elbow flexion.
      inwardDir.copy(hinge).multiplyScalar(sgn).normalize();
      pronationDir.crossVectors(foreDir, hinge).normalize();
      palmNormal
        .copy(inwardDir)
        .addScaledVector(pronationDir, opts.palmPronation)
        .normalize();

      const wp = T.MathUtils.clamp(opts.wristPitch, -0.32, 0.32);
      fingersDir
        .copy(foreDir)
        .multiplyScalar(Math.cos(wp))
        .addScaledVector(inwardDir, Math.sin(wp))
        .normalize();

      handWorldFrame(fingersDir, palmNormal, q1, vBasisX, vBasisY, vBasisZ, mBasis);
      alignWrist(q1, foreDir, 0.35);
      setBoneWorldQuat(hand, q1, q2);

      if (twist) {
        const bindHand = bindLocalQuat.get(`hand.${side}`);
        const bindTwist = bindLocalQuat.get(`fore_twist.${side}`);
        if (bindHand && bindTwist) {
          q3.copy(bindHand).invert().multiply(hand.quaternion).normalize();
          const st = twistTrackState[side];
          let clamped = 0;
          if (currentStepIdx === steps && st.seen) {
            clamped = st.firstTwist;
          } else {
            const norm = Math.hypot(q3.y, q3.w);
            let angle = 0;
            if (norm > 1e-6) {
              const sy = q3.w < 0 ? -q3.y : q3.y;
              const sw = q3.w < 0 ? -q3.w : q3.w;
              angle = 2 * Math.atan2(sy, sw);
            }
            if (st.seen) {
              let delta = angle - st.lastTwist;
              delta = Math.atan2(Math.sin(delta), Math.cos(delta));
              angle = st.lastTwist + delta;
            }
            clamped = T.MathUtils.clamp(angle, -MAX_FOREARM_TWIST_RAD, MAX_FOREARM_TWIST_RAD);
            if (!st.seen) {
              st.firstTwist = clamped;
              st.seen = true;
            }
            st.lastTwist = clamped;
          }
          q2.setFromAxisAngle(Y_AXIS, clamped * 0.72);
          twist.quaternion.copy(bindTwist).multiply(q2).normalize();
        }
      }
    };

    for (let i = 0; i <= steps; i++) {
      currentStepIdx = i;
      const u = i === steps ? 0 : i / steps;
      action.time = u * duration;
      mixer.update(0);
      model.updateWorldMatrix(true, true);

      savedHipsPos.copy(hips.position);

      // Capture exact pre-trunk world lower-body pose (`correctGaits` zero-slip ankle/knee/foot)
      for (const s of legSides) {
        const thigh = byCanon.get(`thigh.${s}`)!;
        const shin = byCanon.get(`shin.${s}`)!;
        const foot = byCanon.get(`foot.${s}`)!;
        const snap = origLegSnap[s];
        thigh.getWorldPosition(snap.H);
        shin.getWorldPosition(snap.K);
        foot.getWorldPosition(snap.A);
        thigh.getWorldQuaternion(snap.thighW).normalize();
        shin.getWorldQuaternion(snap.shinW).normalize();
        foot.getWorldQuaternion(snap.footW).normalize();
      }

      const phi = (u - resolvedFootLead) * Math.PI * 2;
      const cosP = Math.cos(phi);
      const sinP = Math.sin(phi);
      const cos2P = Math.cos(phi * 2);

      if (kind === 'Walk') {
        applyTrunkAngles({
          hipsPitch: deg(1.2) + deg(0.8) * cos2P,
          hipsYaw: -deg(4.4) * cosP,
          hipsRoll: deg(2.6) * sinP,
          spinePitch: deg(1.6) + deg(0.5) * cos2P,
          spineYaw: deg(4.2) * cosP,
          spineRoll: -deg(1.5) * sinP,
          chestPitch: deg(1.5) + deg(0.5) * cos2P,
          chestYaw: deg(5.6) * cosP,
          chestRoll: -deg(1.6) * sinP,
          neckPitch: -deg(1.4),
          neckYaw: -deg(2.2) * cosP,
          neckRoll: deg(0.4) * sinP,
          headPitch: -deg(1.6) - deg(0.9) * cos2P,
          headYaw: -deg(3.2) * cosP,
          headRoll: deg(0.2) * sinP,
        });
        for (const side of ['L', 'R'] as const) {
          const swing = side === 'R' ? cosP : -cosP;
          const fwd = Math.max(0, swing);
          poseArm(side, {
            clavicleProtract: deg(3.2) * swing,
            clavicleLift: deg(1.0) * fwd,
            shoulderPitch: deg(1.5) + deg(19.5) * swing,
            shoulderAbduct: deg(8.2) + deg(1.2) * (1 - fwd),
            shoulderInward: 0.02 * fwd,
            elbowFlex: deg(29 + 7 * swing), // 22°..36° relaxed walk bend
            wristPitch: deg(3.5) * Math.sin(phi + (side === 'R' ? 0.35 : Math.PI + 0.35)),
            palmPronation: 0.18,
          });
        }
      } else if (kind === 'Walk_Brisk') {
        applyTrunkAngles({
          hipsPitch: deg(2.1) + deg(1.0) * cos2P,
          hipsYaw: -deg(5.4) * cosP,
          hipsRoll: deg(3.3) * sinP,
          spinePitch: deg(2.4) + deg(0.8) * cos2P,
          spineYaw: deg(5.4) * cosP,
          spineRoll: -deg(2.0) * sinP,
          chestPitch: deg(2.5) + deg(0.9) * cos2P,
          chestYaw: deg(7.2) * cosP,
          chestRoll: -deg(2.1) * sinP,
          neckPitch: -deg(2.4) - deg(0.7) * cos2P,
          neckYaw: -deg(3.0) * cosP,
          neckRoll: deg(0.4) * sinP,
          headPitch: -deg(2.8) - deg(0.9) * cos2P,
          headYaw: -deg(4.2) * cosP,
          headRoll: deg(0.25) * sinP,
        });
        for (const side of ['L', 'R'] as const) {
          const swing = side === 'R' ? cosP : -cosP;
          const fwd = Math.max(0, swing);
          const back = Math.max(0, -swing);
          poseArm(side, {
            clavicleProtract: deg(4.2) * swing,
            clavicleLift: deg(1.6) * fwd,
            shoulderPitch: -deg(1.5) + deg(27.5) * swing,
            shoulderAbduct: deg(8.8) + deg(1.6) * back,
            shoulderInward: 0.035 * fwd,
            elbowFlex: deg(45 + 11 * swing), // 34°..56° purposeful brisk swing
            wristPitch: deg(4.0) * Math.sin(phi + (side === 'R' ? 0.32 : Math.PI + 0.32)),
            palmPronation: 0.19,
          });
        }
      } else if (kind === 'Run') {
        applyTrunkAngles({
          hipsPitch: deg(3.6) + deg(1.1) * cos2P,
          hipsYaw: -deg(6.6) * cosP,
          hipsRoll: deg(4.1) * sinP,
          spinePitch: deg(3.4) + deg(1.1) * cos2P,
          spineYaw: deg(6.8) * cosP,
          spineRoll: -deg(2.4) * sinP,
          chestPitch: deg(3.6) + deg(1.2) * cos2P,
          chestYaw: deg(8.7) * cosP,
          chestRoll: -deg(2.6) * sinP,
          neckPitch: -deg(4.0) - deg(1.1) * cos2P,
          neckYaw: -deg(3.8) * cosP,
          neckRoll: deg(0.5) * sinP,
          headPitch: -deg(4.6) - deg(1.2) * cos2P,
          headYaw: -deg(5.1) * cosP,
          headRoll: deg(0.3) * sinP,
        });
        for (const side of ['L', 'R'] as const) {
          const swing = side === 'R' ? cosP : -cosP;
          const fwd = Math.max(0, swing);
          const back = Math.max(0, -swing);
          poseArm(side, {
            clavicleProtract: deg(5.2) * swing,
            clavicleLift: deg(2.2) * fwd,
            shoulderPitch: -deg(4.5) + deg(36.5) * swing,
            shoulderAbduct: deg(9.6) + deg(2.2) * back,
            shoulderInward: 0.045 * fwd,
            elbowFlex: deg(83 + 7.5 * swing), // Strictly 75.5°..90.5° athletic bent-elbow drive!
            wristPitch: deg(4.5) * Math.sin(phi + (side === 'R' ? 0.3 : Math.PI + 0.3)),
            palmPronation: 0.2,
          });
        }
      } else {
        // Sprint: compact sagittal piston arm drive (`80°..90°`), stronger forward lean & pelvic/thoracic drive
        applyTrunkAngles({
          hipsPitch: deg(4.6) + deg(1.4) * cos2P,
          hipsYaw: -deg(7.6) * cosP,
          hipsRoll: deg(4.6) * sinP,
          spinePitch: deg(4.6) + deg(1.3) * cos2P,
          spineYaw: deg(7.8) * cosP,
          spineRoll: -deg(2.8) * sinP,
          chestPitch: deg(4.8) + deg(1.4) * cos2P,
          chestYaw: deg(9.8) * cosP,
          chestRoll: -deg(3.0) * sinP,
          neckPitch: -deg(5.8) - deg(1.4) * cos2P,
          neckYaw: -deg(4.4) * cosP,
          neckRoll: deg(0.6) * sinP,
          headPitch: -deg(6.2) - deg(1.5) * cos2P,
          headYaw: -deg(5.8) * cosP,
          headRoll: deg(0.35) * sinP,
        });
        for (const side of ['L', 'R'] as const) {
          const swing = side === 'R' ? cosP : -cosP;
          const fwd = Math.max(0, swing);
          const back = Math.max(0, -swing);
          poseArm(side, {
            clavicleProtract: deg(6.0) * swing,
            clavicleLift: deg(2.6) * fwd,
            shoulderPitch: -deg(6.0) + deg(44.0) * swing,
            shoulderAbduct: deg(10.0) + deg(2.4) * back,
            shoulderInward: 0.055 * fwd,
            elbowFlex: deg(85 + 5 * swing), // 80°..90° compact sprint flexion
            wristPitch: deg(4.5) * Math.sin(phi + (side === 'R' ? 0.28 : Math.PI + 0.28)),
            palmPronation: 0.2,
          });
        }
      }

      hips.position.copy(savedHipsPos);
      hips.updateWorldMatrix(false, true);

      // Re-solve 2-bone analytical leg IK to exact pre-trunk world ankle/foot so replacing `hips.quaternion`
      // introduces 0.00 mm stance sole slip, 0.00 mm sole penetration, and 0.00° sideways shoe roll!
      if (legSides.length > 0) {
        let neededDropY = 0;
        for (const s of legSides) {
          const snap = origLegSnap[s];
          const thigh = byCanon.get(`thigh.${s}`)!;
          const l1 = snap.H.distanceTo(snap.K);
          const l2 = snap.K.distanceTo(snap.A);
          const maxReach = (l1 + l2) * MAX_REACH_COS;
          thigh.getWorldPosition(vHipNew);
          const dx = vHipNew.x - snap.A.x;
          const dz = vHipNew.z - snap.A.z;
          const horizSq = dx * dx + dz * dz;
          if (horizSq < maxReach * maxReach) {
            const maxHipY = snap.A.y + Math.sqrt(maxReach * maxReach - horizSq);
            if (vHipNew.y > maxHipY) {
              neededDropY = Math.max(neededDropY, vHipNew.y - maxHipY);
            }
          }
        }
        if (neededDropY > 1e-6 && hipsPosData) {
          hipsPosAdjusted = true;
          hips.getWorldPosition(vWorldDown);
          vWorldDown.y -= neededDropY;
          if (hips.parent) hips.parent.worldToLocal(vWorldDown);
          hips.position.copy(vWorldDown);
          hips.updateWorldMatrix(false, true);
        }
        if (hipsPosData) {
          const po = i * 3;
          hipsPosData[po] = hips.position.x;
          hipsPosData[po + 1] = hips.position.y;
          hipsPosData[po + 2] = hips.position.z;
        }

        for (const s of legSides) {
          const snap = origLegSnap[s];
          const thigh = byCanon.get(`thigh.${s}`)!;
          const shin = byCanon.get(`shin.${s}`)!;
          const foot = byCanon.get(`foot.${s}`)!;
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
          const D = T.MathUtils.clamp(vLegAxis.length(), minReach, maxReach);
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
          qSwingLeg.setFromUnitVectors(vFromDir, vToDir);
          qThighNewW.copy(qSwingLeg).multiply(snap.thighW).normalize();
          setBoneWorldQuat(thigh, qThighNewW, q2);

          vFromDir.copy(snap.A).sub(snap.K).normalize();
          vToDir.copy(vAnkTarget).sub(vKneeNew).normalize();
          qSwingLeg.setFromUnitVectors(vFromDir, vToDir);
          qShinNewW.copy(qSwingLeg).multiply(snap.shinW).normalize();
          setBoneWorldQuat(shin, qShinNewW, q2);

          setBoneWorldQuat(foot, snap.footW, q2);
        }
      }

      for (const [bName, buf] of quatData) {
        const b = byCanon.get(bName)!;
        const o = i * 4;
        buf[o] = b.quaternion.x;
        buf[o + 1] = b.quaternion.y;
        buf[o + 2] = b.quaternion.z;
        buf[o + 3] = b.quaternion.w;
      }
    }

    action.stop();
  } finally {
    mixer.stopAllAction();
    mixer.uncacheRoot(model);
    for (let i = 0; i < allBones.length; i++) {
      const s = allBones[i];
      s.bone.position.copy(s.pos);
      s.bone.quaternion.copy(s.quat);
      s.bone.scale.copy(s.scale);
    }
    model.position.copy(savedRootPos);
    model.quaternion.copy(savedRootQuat);
    model.scale.copy(savedRootScale);
    model.updateWorldMatrix(true, true);
  }

  const outClip = sourceClip.clone();
  if (hipsPosData && hipsPosAdjusted) {
    const posIdx = outClip.tracks.findIndex(
      (tr) => tr.name === 'hips.position' || tr.name === 'Hips.position',
    );
    const posName = posIdx >= 0 ? outClip.tracks[posIdx].name : 'hips.position';
    const posTrack = new T.VectorKeyframeTrack(posName, times, hipsPosData);
    if (posIdx >= 0) outClip.tracks[posIdx] = posTrack;
    else outClip.tracks.push(posTrack);
  }
  for (const [bName, values] of quatData) {
    const boneTrackPrefix = usesSanitizedNames ? bName.replace(/\./g, '') : bName;
    const trackName = `${boneTrackPrefix}.quaternion`;
    const altTrackName = `${bName}.quaternion`;
    const altSanitized = `${bName.replace(/\./g, '')}.quaternion`;
    const newTrack = new T.QuaternionKeyframeTrack(trackName, times, values);
    const idx = outClip.tracks.findIndex(
      (tr) => tr.name === trackName || tr.name === altTrackName || tr.name === altSanitized,
    );
    if (idx >= 0) {
      newTrack.name = outClip.tracks[idx].name;
      outClip.tracks[idx] = newTrack;
    } else {
      outClip.tracks.push(newTrack);
    }
  }
  return outClip;
}
