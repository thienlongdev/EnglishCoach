import * as T from 'three';
import { detectRigFamily, type RigFamily } from './characterAnimator';

/**
 * Expanded FACS Facial Presence, Deterministic Text Lip-Sync & Procedural Micro-Life Controller.
 *
 * Drives living details cleanly on top of any skeletal animation clip (zero compounding via
 * `restore()` -> `mixer.update()` -> `capture()` -> `update(frame)`):
 *  - Asymmetric natural blinking (6–14 ms L/R stagger, 55 ms close / 115 ms ease-out open, saccade-triggered blinks)
 *  - Eyelid-gaze vertical coupling (downward gaze gently lowers upper eyelids; upward gaze raises brows)
 *  - Ocular micro-saccades (0.5°–3° fixation darts across eye/mouth landmarks during dialogue)
 *  - Deterministic 6-viseme co-articulation synced to dialogue/banter English text (0 LLM, 0 audio files)
 *  - Multi-AU emotional FACS recipes across BOTH 19-morph (`RunnerRig`/`EchoStudentRig`) & 6-morph (`Codex52`)
 *  - Organic chest/clavicle breathing, standing weight shift, cold-weather snow micro-shiver, & natural finger curl
 */

export type LifeMood =
  | 'neutral'
  | 'friendly'
  | 'happy'
  | 'focus'
  | 'listen'
  | 'surprise'
  | 'sad'
  | 'sleep'
  | 'annoyed'
  | 'tired'
  | 'excited';

/**
 * Calibrated natural resting finger cascade (`[MCP, PIP, DIP, spread]` per digit, thumb first).
 * Closes Lyra/Kai's 29.3° bind-pose fan to a soft relaxed ~8° curve with index-to-pinky progressive flexion.
 */
export const NATURAL_RELAXED_GRIP: readonly (readonly [number, number, number, number])[] = [
  [0.14, 0.18, 0.12, -0.14], // thumb: gently flexed & softly tucked
  [0.16, 0.28, 0.16, -0.10], // index: gentle curve, closed from +9.4° splay
  [0.24, 0.38, 0.22, -0.03], // middle: natural cascade
  [0.34, 0.46, 0.26, 0.06], // ring: deeper cascade, closed from -15.9° splay
  [0.44, 0.54, 0.30, 0.12], // little: deepest natural cascade, closed from -19.9° splay
];

/** Anatomical resting flexion cascade `[MCP, PIP, DIP]` (in radians toward true palm normal) per digit, thumb first. */
const PALM_RELAXED_FLEXION: readonly (readonly [number, number, number])[] = [
  [0.16, 0.22, 0.14], // thumb: soft palmar opposition, zero hitchhiker extension
  [0.22, 0.32, 0.20], // index
  [0.28, 0.38, 0.24], // middle
  [0.34, 0.44, 0.28], // ring
  [0.40, 0.50, 0.32], // little / pinky
];

type MorphAttr = T.BufferAttribute | T.InterleavedBufferAttribute;

/**
 * One-time load-time sanitizer (`< 0.15 ms`, zero extra VRAM, zero disk GLB edits) for all 22 `Codex52` resident GLBs:
 * MakeHuman's `Face_and_visible_skin` merges outer face skin with the pink/red oral-mucosa/tongue UV island (`uv.y > 0.90`),
 * and baked `Target "aa"` as a `33.3 mm` scream that retracts the lower lip `-25..35 mm` backward behind the stationary
 * `z = 0.1407 m` oral pouch (`09-dialogue-closeup.png` protruding red tongue/mouth bug!).
 * Sanitizing `morphAttributes.position` in-place before first GPU upload guarantees `0` oral protrusion even at `aa = 1.0`.
 */
export function sanitizeCodex52OralMorphs(root: T.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as T.Mesh;
    if (!mesh.isMesh || !mesh.geometry || !mesh.morphTargetDictionary) return;
    const geom = mesh.geometry;
    if (geom.userData.__ecOralMorphSanitized) return;

    const aaIdx = mesh.morphTargetDictionary['aa'];
    if (aaIdx === undefined) return;
    const morphPosList = geom.morphAttributes?.position;
    const aaAttr = morphPosList?.[aaIdx] as MorphAttr | undefined;
    const uvAttr = geom.getAttribute('uv') as MorphAttr | undefined;
    const posAttr = geom.getAttribute('position') as MorphAttr | undefined;
    if (!aaAttr || !uvAttr || !posAttr) return;

    // Only apply MakeHuman UV-island oral-pouch sanitizer on 6-morph Codex52 resident meshes
    if (mesh.morphTargetDictionary['ih'] !== undefined || mesh.morphTargetDictionary['squint'] !== undefined) {
      geom.userData.__ecOralMorphSanitized = true;
      return;
    }

    geom.userData.__ecOralMorphSanitized = true;
    const smileIdx = mesh.morphTargetDictionary['smile'];
    const smileAttr =
      smileIdx !== undefined ? (morphPosList?.[smileIdx] as MorphAttr | undefined) : undefined;

    // Three.js `setXYZ` natively handles both `BufferAttribute` and `KHR_mesh_quantization` `InterleavedBufferAttribute`
    // (`stride = 4` `[x,y,z,pad]` normalized `Int16Array`) without mis-indexing `idx * itemSize`!
    const writeDelta = (attr: MorphAttr, idx: number, dx: number, dy: number, dz: number) => {
      if (attr.normalized) {
        attr.setXYZ(
          idx,
          T.MathUtils.clamp(dx, -1, 1),
          T.MathUtils.clamp(dy, -1, 1),
          T.MathUtils.clamp(dz, -1, 1),
        );
      } else {
        attr.setXYZ(idx, dx, dy, dz);
      }
    };

    // Locate the active jaw/mouth morph region so non-head UV islands (e.g. MakeHuman hand/wrist skin) are never touched
    let mouthMinX = Infinity;
    let mouthMaxX = -Infinity;
    let mouthMinY = Infinity;
    let mouthMaxY = -Infinity;
    let mouthMinZ = Infinity;
    for (let v = 0; v < aaAttr.count; v++) {
      if (Math.abs(aaAttr.getY(v)) + Math.abs(aaAttr.getZ(v)) > 0.005) {
        const px = posAttr.getX(v);
        const py = posAttr.getY(v);
        const pz = posAttr.getZ(v);
        if (px < mouthMinX) mouthMinX = px;
        if (px > mouthMaxX) mouthMaxX = px;
        if (py < mouthMinY) mouthMinY = py;
        if (py > mouthMaxY) mouthMaxY = py;
        if (pz < mouthMinZ) mouthMinZ = pz;
      }
    }
    if (!Number.isFinite(mouthMinY)) return;
    mouthMinX -= 0.015;
    mouthMaxX += 0.015;
    mouthMinY -= 0.020;
    mouthMaxY += 0.030;
    mouthMinZ -= 0.045;

    for (let v = 0; v < aaAttr.count; v++) {
      const px = posAttr.getX(v);
      const py = posAttr.getY(v);
      const pz = posAttr.getZ(v);
      if (px < mouthMinX || px > mouthMaxX || py < mouthMinY || py > mouthMaxY || pz < mouthMinZ) {
        continue;
      }
      const u = uvAttr.getX(v);
      const uvY = uvAttr.getY(v);
      const dx = aaAttr.getX(v);
      let dy = aaAttr.getY(v);
      let dz = aaAttr.getZ(v);

      // 1) MakeHuman oral-mucosa / tongue / teeth UV island inside the mouth box sits at u ∈ [0.70, 0.97], uvY > 0.88:
      //    Recess -21 mm backward (-Z) and gently down so inner red tissue stays +11..13 mm behind the lower lip even at aa=1.0!
      if (u > 0.70 && u < 0.97 && uvY > 0.88) {
        dz = Math.min(dz, 0) - 0.021;
        dy = dy * 0.45 - 0.006;
        writeDelta(aaAttr, v, dx * 0.65, dy, dz);
        if (smileAttr) {
          const sdx = smileAttr.getX(v);
          const sdy = smileAttr.getY(v);
          const sdz = Math.min(smileAttr.getZ(v), 0) - 0.006;
          writeDelta(smileAttr, v, sdx * 0.7, sdy * 0.7, sdz);
        }
        continue;
      }

      // 2) Attenuate excessive backward (-Z) chin/lower-lip collapse (-27mm -> -9mm) and scream drop (-37mm -> -19mm)
      if (dy < -0.004 || dz < -0.004) {
        if (dy < 0) dy *= 0.52;
        if (dz < 0) dz *= 0.35;
        writeDelta(aaAttr, v, dx, dy, dz);
      } else if (dz > 0.0015) {
        writeDelta(aaAttr, v, dx, dy, Math.min(dz, 0.0015));
      }
    }

    aaAttr.needsUpdate = true;
    if (smileAttr) smileAttr.needsUpdate = true;
  });
}

export interface CharacterLifeFrame {
  dt: number;
  reduced?: boolean;
  /** World-space point to glance/look toward (typically player eye position within 10 m, or null). */
  lookTargetWorld?: T.Vector3 | null;
  /** Actor horizontal travel speed (m/s). Suppresses idle sway while walking/running. */
  speed?: number;
  seated?: boolean;
  /** True when this actor is in an active conversation with the player. */
  inDialogue?: boolean;
  /** True while this actor is delivering spoken dialogue (drives lip-sync visemes + brow cadence). */
  speaking?: boolean;
  /** Optional displayed English speech/banter line driving deterministic 6-viseme co-articulation. */
  speechText?: string | null;
  mood?: LifeMood;
  /** Optional emotional intensity multiplier (0.2..1.2, defaults to 1.0). */
  moodIntensity?: number;
  /** Active outdoor snow intensity (0..1) triggering subtle cold-weather micro-shiver & hunch. */
  snowIntensity?: number;
  /** Set false when another controller (e.g. `CastLook` on the player) already owns face morphs & eye bones. */
  applyFace?: boolean;
  /** Set false when the actor is currently holding/grasping a physical object via IK (e.g. player hands busy). */
  curlFingers?: boolean;
}

interface FingerJointRef {
  bone: T.Bone;
  rest: T.Quaternion;
  qRelaxedLocal: T.Quaternion;
  localFlexAxis: T.Vector3;
  finger: number; // 0..4 (thumb..little)
  joint: number; // 0..2
  side: number; // -1 left, +1 right
}

interface EyeRef {
  bone: T.Bone;
  rest: T.Quaternion;
}

/** Multi-AU emotional FACS recipes for 19-morph `RunnerRig` / `EchoStudentRig`. */
const MOODS_19: Record<LifeMood, Record<string, number>> = {
  neutral: { smile: 0.24 },
  friendly: { smile: 0.64, squint: 0.26, browUp: 0.14 }, // Duchenne warmth (AU12 + AU6 + AU1)
  happy: { happy: 0.48, smile: 0.70, squint: 0.38, browUp: 0.16 },
  excited: { happy: 0.56, smile: 0.78, wide: 0.28, browUp: 0.34, squint: 0.22 },
  focus: { browDown: 0.26, squint: 0.16, lookDown: 0.20, mm: 0.14 },
  listen: { smile: 0.30, browUp: 0.14, browInner: 0.08, squint: 0.08 },
  surprise: { wide: 0.72, browUp: 0.78, ou: 0.30, aa: 0.18 },
  sad: { sad: 0.66, browInner: 0.52, lookDown: 0.16 },
  annoyed: { browDown: 0.58, sad: 0.34, squint: 0.24, mm: 0.22 },
  tired: { 'blink.L': 0.22, 'blink.R': 0.22, browDown: 0.14, lookDown: 0.14 },
  sleep: { 'blink.L': 1, 'blink.R': 1 },
};

/** Multi-AU emotional FACS recipes mapped cleanly onto 6-morph `Codex52` (`blink.L/R, smile, aa, browUp.L/R`). */
const MOODS_6: Record<LifeMood, Record<string, number>> = {
  neutral: { smile: 0.20 },
  friendly: { smile: 0.60, 'browUp.L': 0.16, 'browUp.R': 0.16 },
  happy: { smile: 0.84, 'browUp.L': 0.26, 'browUp.R': 0.26 },
  excited: { smile: 0.88, 'browUp.L': 0.42, 'browUp.R': 0.42, aa: 0.18 },
  focus: { smile: 0.06 },
  listen: { smile: 0.32, 'browUp.L': 0.14, 'browUp.R': 0.14 },
  surprise: { 'browUp.L': 0.76, 'browUp.R': 0.76, aa: 0.30 },
  sad: { smile: 0, 'browUp.L': 0.28, 'browUp.R': 0.28 },
  annoyed: { smile: 0, 'blink.L': 0.16, 'blink.R': 0.16 },
  tired: { 'blink.L': 0.24, 'blink.R': 0.24, smile: 0.04 },
  sleep: { 'blink.L': 1, 'blink.R': 1 },
};

/** 6 viseme classes: 0=SIL, 1=PP(p/b/m), 2=FV(f/v/s/th), 3=AA(a/o), 4=EE(e/i), 5=OO(u/w). */
const VISEME_SHAPES_19: readonly (readonly [string, number, string?, number?])[] = [
  ['mm', 0.0], // 0: SIL
  ['mm', 0.68], // 1: PP (bilabial closure)
  ['ss', 0.48, 'aa', 0.14], // 2: FV / sibilant
  ['aa', 0.74], // 3: AA (open vowel)
  ['ih', 0.58, 'smile', 0.24], // 4: EE (spread vowel)
  ['ou', 0.58, 'uu', 0.34], // 5: OO (rounded vowel)
];

const VISEME_SHAPES_6: readonly (readonly [number, number])[] = [
  // [aaWeight, smileWeight] — calibrated to natural conversational aperture (paired with bilinear smile clamp)
  [0.0, 0.0], // 0: SIL
  [0.05, 0.0], // 1: PP
  [0.20, 0.10], // 2: FV
  [0.54, 0.04], // 3: AA
  [0.28, 0.26], // 4: EE
  [0.36, 0.0], // 5: OO
];

const FALLBACK_VISEMES: readonly number[] = [3, 4, 5, 2, 1, 3];
const MOUTH_NAMES = new Set(['aa', 'ih', 'ou', 'ss', 'uu', 'mm']);

interface VisemeTrack {
  /** Flat triples: [timeSec, visemeId (0..5), amp (0..1)] */
  data: Float32Array;
  count: number;
  duration: number;
}

/** Deterministic zero-LLM English text-to-6-viseme track compiler (cached per active dialogue line). */
export function compileVisemeTrack(text: string): VisemeTrack {
  const clean = text.trim();
  if (!clean) {
    return { data: new Float32Array([0, 0, 0]), count: 1, duration: 0.2 };
  }
  const rows: number[] = [];
  let t = 0;
  let lastV = -1;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i].toLowerCase();
    if (ch === ' ') {
      t += 0.045;
      continue;
    }
    if (ch === ',' || ch === ';' || ch === ':') {
      rows.push(t, 0, 0);
      t += 0.15;
      lastV = 0;
      continue;
    }
    if (ch === '.' || ch === '!' || ch === '?') {
      rows.push(t, 0, 0);
      t += 0.23;
      lastV = 0;
      continue;
    }
    let v = -1;
    let dur = 0.075;
    let amp = 0.72;
    if (ch === 'p' || ch === 'b' || ch === 'm') {
      v = 1;
      dur = 0.068;
      amp = 0.82;
    } else if (ch === 'f' || ch === 'v' || ch === 's' || ch === 'z' || ch === 'c') {
      v = 2;
      dur = 0.068;
      amp = 0.64;
    } else if (ch === 'a' || ch === 'o') {
      v = 3;
      dur = 0.095;
      amp = 0.88;
    } else if (ch === 'e' || ch === 'i' || ch === 'y') {
      v = 4;
      dur = 0.088;
      amp = 0.78;
    } else if (ch === 'u' || ch === 'w') {
      v = 5;
      dur = 0.092;
      amp = 0.84;
    } else if (ch >= 'a' && ch <= 'z') {
      // Other consonants provide light articulatory transition
      v = lastV === 3 ? 2 : 4;
      dur = 0.055;
      amp = 0.42;
    }
    if (v >= 0) {
      if (v !== lastV || amp > 0.7) {
        rows.push(t, v, amp);
        lastV = v;
      }
      t += dur;
    }
  }
  rows.push(t, 0, 0);
  const duration = Math.max(0.25, t + 0.12);
  return { data: Float32Array.from(rows), count: rows.length / 3, duration };
}

const UP = new T.Vector3(0, 1, 0);
const _q1 = new T.Quaternion();
const _q2 = new T.Quaternion();
const _q3 = new T.Quaternion();
const _e1 = new T.Euler();
const _v1 = new T.Vector3();
const _v2 = new T.Vector3();
const _fwd = new T.Vector3();
const _right = new T.Vector3();
const _rootQ = new T.Quaternion();
const _invRootQ = new T.Quaternion();

const ECHO_FINGER_RE = /^(?:f_)?(thumb|index|middle|ring|little|pinky)[._]?0?([123])[._]?([LR])$/i;
const CODEX_FINGER_RE = /^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)([123])$/;
const FINGER_INDEX: Record<string, number> = {
  thumb: 0,
  index: 1,
  middle: 2,
  ring: 3,
  little: 4,
  pinky: 4,
};

export class CharacterLife {
  readonly family: RigFamily;
  private readonly baseQuats = new Map<T.Bone, T.Quaternion>();
  private readonly baseHipsPos = new T.Vector3();
  private hips: T.Bone | null = null;
  private spine: T.Bone | null = null;
  private chest: T.Bone | null = null;
  private neck: T.Bone | null = null;
  private head: T.Bone | null = null;
  private shoulderL: T.Bone | null = null;
  private shoulderR: T.Bone | null = null;
  private handL: T.Bone | null = null;
  private handR: T.Bone | null = null;
  private readonly eyes: EyeRef[] = [];
  private readonly fingers: FingerJointRef[] = [];

  private faceMesh: T.Mesh | null = null;
  private readonly morphKeys = new Map<string, number>();
  private wantedMorphs: Float32Array = new Float32Array(0);
  private has19Morphs = false;

  private readonly seed: number;
  private time = 0;
  private blinkAt: number;
  private blinkT = -1;
  private blinkStagger = 0.008;
  private doubleBlink = false;
  private visemeAt = 0;
  private visemeId = 3;
  private prevVisemeId = 0;
  private visemeLevel = 0;
  private visemeBlendT = 1;
  private activeSpeechText = '';
  private speechTrack: VisemeTrack | null = null;
  private speechElapsed = 0;
  private gazeYaw = 0;
  private gazePitch = 0;
  private prevWantYaw = 0;
  private saccadeAt = 0.7;
  private saccadeTargetYaw = 0;
  private saccadeTargetPitch = 0;
  private saccadeCurYaw = 0;
  private saccadeCurPitch = 0;
  private saccadeLandmark = 0;
  private swayWeight = 1;
  private yawnPhase = -1;
  private nextYawnAt = 16;

  constructor(
    readonly root: T.Object3D,
    actorKey = '',
  ) {
    this.family = detectRigFamily(root);
    this.seed = hashString(actorKey);
    this.blinkAt = 0.8 + this.seed * 2.4;
    this.nextYawnAt = 11 + this.seed * 14;

    if (this.family === 'Codex52') {
      sanitizeCodex52OralMorphs(root);
    }

    root.traverse((o) => {
      if ((o as T.Bone).isBone) {
        const bone = o as T.Bone;
        const name = (bone.userData.name as string | undefined) ?? bone.name;

        if (name === 'hips' || name === 'Hips') this.hips = bone;
        else if (name === 'spine' || name === 'Spine') this.spine = bone;
        else if (name === 'chest' || name === 'Spine2') this.chest = bone;
        else if (name === 'neck' || name === 'Neck') this.neck = bone;
        else if (name === 'head' || name === 'Head') this.head = bone;
        else if (name === 'shoulder.L' || name === 'shoulderL' || name === 'LeftShoulder') this.shoulderL = bone;
        else if (name === 'shoulder.R' || name === 'shoulderR' || name === 'RightShoulder') this.shoulderR = bone;
        else if (name === 'hand.L' || name === 'handL' || name === 'LeftHand') this.handL = bone;
        else if (name === 'hand.R' || name === 'handR' || name === 'RightHand') this.handR = bone;
        else if (name === 'eye.L' || name === 'eyeL' || name === 'eye.R' || name === 'eyeR') {
          this.eyes.push({ bone, rest: bone.quaternion.clone() });
        } else {
          const em = ECHO_FINGER_RE.exec(name);
          if (em) {
            this.fingers.push({
              bone,
              rest: bone.quaternion.clone(),
              qRelaxedLocal: bone.quaternion.clone(),
              localFlexAxis: new T.Vector3(1, 0, 0),
              finger: FINGER_INDEX[em[1].toLowerCase()],
              joint: Number(em[2]) - 1,
              side: em[3].toUpperCase() === 'R' ? 1 : -1,
            });
          } else {
            const cm = CODEX_FINGER_RE.exec(name);
            if (cm) {
              this.fingers.push({
                bone,
                rest: bone.quaternion.clone(),
                qRelaxedLocal: bone.quaternion.clone(),
                localFlexAxis: new T.Vector3(1, 0, 0),
                finger: FINGER_INDEX[cm[2].toLowerCase()],
                joint: Number(cm[3]) - 1,
                side: cm[1] === 'Right' ? 1 : -1,
              });
            }
          }
        }
        return;
      }

      const mesh = o as T.Mesh;
      if (mesh.isMesh && mesh.morphTargetDictionary && mesh.morphTargetInfluences?.length) {
        const count = mesh.morphTargetInfluences.length;
        if (!this.faceMesh || count > this.wantedMorphs.length) {
          this.faceMesh = mesh;
          this.morphKeys.clear();
          for (const [k, i] of Object.entries(mesh.morphTargetDictionary)) {
            this.morphKeys.set(k, i);
          }
          this.wantedMorphs = new Float32Array(count);
          this.has19Morphs = this.morphKeys.has('ih') || this.morphKeys.has('squint');
        }
      }
    });

    // Calibrate true anatomical palm-frame finger adduction & flexion axes once from bind pose
    if (this.fingers.length > 0) {
      this.calibrateNaturalHandPoses();
    }

    // Register every bone this controller writes so restore()/capture() stays 100% drift-free
    for (const b of [this.hips, this.spine, this.chest, this.neck, this.head, this.shoulderL, this.shoulderR]) {
      if (b) this.baseQuats.set(b, b.quaternion.clone());
    }
    for (const e of this.eyes) this.baseQuats.set(e.bone, e.bone.quaternion.clone());
    for (const f of this.fingers) this.baseQuats.set(f.bone, f.bone.quaternion.clone());
    if (this.hips) this.baseHipsPos.copy(this.hips.position);
  }

  /** Diagnostics helper for verification tests & QA inspection. */
  get capabilities() {
    return {
      family: this.family,
      morphCount: this.wantedMorphs.length,
      morphNames: [...this.morphKeys.keys()],
      has19Facs: this.has19Morphs,
      eyeBoneCount: this.eyes.length,
      fingerBoneCount: this.fingers.length,
      hasLookAtChain: !!(this.chest && this.neck && this.head),
    };
  }

  /** Current morph target influence map snapshot (for QA / tests). */
  get morphSnapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    const inf = this.faceMesh?.morphTargetInfluences;
    if (!inf) return out;
    for (const [k, i] of this.morphKeys) out[k] = +(inf[i] ?? 0).toFixed(4);
    return out;
  }

  /** Call BEFORE `mixer.update(dt)` so procedural offsets never compound across frames. */
  restore(): void {
    for (const [bone, q] of this.baseQuats) bone.quaternion.copy(q);
    if (this.hips) this.hips.position.copy(this.baseHipsPos);
  }

  /** Call AFTER `mixer.update(dt)` to record the animation clip's clean base pose. */
  capture(): void {
    for (const [bone, q] of this.baseQuats) q.copy(bone.quaternion);
    if (this.hips) this.baseHipsPos.copy(this.hips.position);
  }

  /** Applies breathing, weight-shift sway, snow shiver, look-at, expanded FACS, saccades & natural finger curl. */
  update(f: CharacterLifeFrame): void {
    const dt = Math.min(0.05, Math.max(0, f.dt));
    this.time += dt;
    const reduced = !!f.reduced;
    const mood: LifeMood = f.mood ?? (f.inDialogue ? 'friendly' : 'neutral');
    const moodIntensity = T.MathUtils.clamp(f.moodIntensity ?? 1, 0.2, 1.2);
    const snowIntensity = T.MathUtils.clamp(f.snowIntensity ?? 0, 0, 1);

    // 1. Body basis vectors in world space (needed before look-at & eyelid-gaze coupling)
    this.root.updateWorldMatrix(true, true);
    this.root.getWorldQuaternion(_rootQ);
    _invRootQ.copy(_rootQ).invert();
    _fwd.set(0, 0, 1).applyQuaternion(_rootQ).setY(0);
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    _fwd.normalize();
    _right.crossVectors(_fwd, UP).normalize();

    // 2. Natural finger curl cascade (always on for NPCs unless grasping an object)
    if (f.curlFingers !== false && this.fingers.length > 0) {
      this.applyNaturalFingers();
    }

    // 3. Organic breathing, standing weight-shift sway, mood micro-posture & cold snow shiver
    if (!reduced) {
      this.applyBreathingAndSway(
        dt,
        f.speed ?? 0,
        !!f.seated,
        !!f.inDialogue,
        mood,
        snowIntensity,
      );
    }

    // 4. Proximity / dialogue look-at across Chest -> Neck -> Head -> Eye bones (also sets gazePitch for lid coupling!)
    const driveFace = f.applyFace !== false;
    this.applyLookAt(dt, reduced, f.lookTargetWorld ?? null, !!f.inDialogue, mood === 'sleep', driveFace);

    // 5. Expanded FACS morph targets (asymmetric blinks, eyelid-gaze coupling, mood AUs, 6-viseme co-articulation)
    if (driveFace) {
      this.updateFaceMorphs(
        dt,
        reduced,
        mood,
        moodIntensity,
        !!f.speaking,
        f.speechText ?? null,
      );
    }
  }

  private addMorph(name: string, weight: number): void {
    const idx = this.morphKeys.get(name);
    if (idx !== undefined && weight > 0) {
      this.wantedMorphs[idx] = Math.min(1, this.wantedMorphs[idx] + weight);
    }
  }

  private applyViseme(visemeId: number, weight: number): void {
    if (weight <= 1e-3 || visemeId <= 0 || visemeId > 5) return;
    if (this.has19Morphs) {
      const shape = VISEME_SHAPES_19[visemeId];
      this.addMorph(shape[0], shape[1] * weight);
      if (shape[2] && shape[3]) this.addMorph(shape[2], shape[3] * weight);
      this.addMorph('browUp', 0.12 * weight);
    } else {
      const [aaW, smW] = VISEME_SHAPES_6[visemeId];
      this.addMorph('aa', aaW * weight);
      if (smW > 0) this.addMorph('smile', smW * weight);
      this.addMorph('browUp.L', 0.16 * weight);
      this.addMorph('browUp.R', 0.16 * weight);
    }
  }

  private updateFaceMorphs(
    dt: number,
    reduced: boolean,
    mood: LifeMood,
    moodIntensity: number,
    speaking: boolean,
    speechText: string | null,
  ): void {
    if (!this.faceMesh || !this.faceMesh.morphTargetInfluences) return;
    this.wantedMorphs.fill(0);

    const table = this.has19Morphs ? MOODS_19 : MOODS_6;
    const moodTargets = table[mood] ?? table.neutral;
    for (const [k, w] of Object.entries(moodTargets)) {
      this.addMorph(k, mood === 'sleep' ? w : w * moodIntensity);
    }

    // Natural asymmetric blinking (6–14 ms L/R stagger, 55 ms close / 115 ms ease-out open, 15% double-blink)
    if (mood !== 'sleep' && !reduced) {
      if (this.blinkT < 0 && this.time >= this.blinkAt) {
        this.blinkT = 0;
        this.doubleBlink = pseudoRandom(this.time + this.seed * 31) < 0.15;
        const dir = pseudoRandom(this.time * 2.3 + this.seed * 7) < 0.5 ? 1 : -1;
        this.blinkStagger = dir * (0.006 + pseudoRandom(this.time * 4.1 + this.seed * 11) * 0.008);
      }
      if (this.blinkT >= 0) {
        this.blinkT += dt;
        const closeS = 0.055;
        const openS = mood === 'tired' ? 0.19 : 0.115;
        const total = closeS + openS;
        const evalLid = (t: number) => {
          if (t <= 0 || t >= total) return 0;
          if (t < closeS) return t / closeS;
          const u = (t - closeS) / openS;
          return 1 - u * u * (3 - 2 * u);
        };
        const tL = this.blinkT - Math.max(0, this.blinkStagger);
        const tR = this.blinkT - Math.max(0, -this.blinkStagger);
        if (this.blinkT >= total + Math.abs(this.blinkStagger)) {
          this.blinkT = -1;
          const gap = this.doubleBlink ? 0.14 : 2.1 + pseudoRandom(this.time * 1.7 + this.seed * 13) * 3.1;
          this.blinkAt = this.time + gap;
          this.doubleBlink = false;
        } else {
          this.addMorph('blink.L', evalLid(tL));
          this.addMorph('blink.R', evalLid(tR));
        }
      }

      // Eyelid-gaze vertical coupling: looking down softly droops upper lids; looking up subtly lifts brows
      const effectivePitch = this.gazePitch + this.saccadeCurPitch;
      if (effectivePitch < -0.05) {
        const droop = T.MathUtils.clamp(-effectivePitch / 0.45, 0, 1) * 0.34;
        this.addMorph('blink.L', droop);
        this.addMorph('blink.R', droop);
        if (this.has19Morphs) this.addMorph('lookDown', droop * 1.15);
      } else if (effectivePitch > 0.08) {
        const lift = T.MathUtils.clamp(effectivePitch / 0.42, 0, 1) * 0.18;
        if (this.has19Morphs) this.addMorph('browUp', lift);
        else {
          this.addMorph('browUp.L', lift);
          this.addMorph('browUp.R', lift);
        }
      }

      // Occasional tired yawn cycle (2.2 s smooth jaw open + squint)
      if (mood === 'tired' && !speaking) {
        if (this.yawnPhase < 0 && this.time >= this.nextYawnAt) {
          this.yawnPhase = 0;
        }
        if (this.yawnPhase >= 0) {
          this.yawnPhase += dt;
          if (this.yawnPhase >= 2.2) {
            this.yawnPhase = -1;
            this.nextYawnAt = this.time + 14 + pseudoRandom(this.time + this.seed * 5) * 14;
          } else {
            const u = this.yawnPhase / 2.2;
            const bell = Math.sin(u * Math.PI);
            const yawn = bell * bell;
            this.addMorph('aa', yawn * 0.82);
            this.addMorph('blink.L', yawn * 0.55);
            this.addMorph('blink.R', yawn * 0.55);
          }
        }
      } else {
        this.yawnPhase = -1;
      }
    }

    // Deterministic 6-viseme co-articulation (synced to displayed English text when provided, smooth fallback otherwise)
    if (speaking && mood !== 'sleep' && !reduced) {
      if (speechText && speechText.trim().length > 0) {
        if (speechText !== this.activeSpeechText) {
          this.activeSpeechText = speechText;
          this.speechTrack = compileVisemeTrack(speechText);
          this.speechElapsed = 0;
        }
        if (this.speechTrack) {
          this.speechElapsed = (this.speechElapsed + dt) % this.speechTrack.duration;
          const d = this.speechTrack.data;
          const n = this.speechTrack.count;
          let idx = 0;
          for (let i = 0; i < n; i++) {
            if (d[i * 3] <= this.speechElapsed) idx = i;
            else break;
          }
          const curV = d[idx * 3 + 1];
          const curA = d[idx * 3 + 2];
          // 60 ms look-ahead co-articulation with cubic Hermite blend into upcoming phoneme
          if (idx + 1 < n) {
            const nextT = d[(idx + 1) * 3];
            const distToNext = nextT - this.speechElapsed;
            if (distToNext < 0.06 && distToNext >= 0) {
              const u = 1 - distToNext / 0.06;
              const s = u * u * (3 - 2 * u);
              this.applyViseme(curV, curA * (1 - s));
              this.applyViseme(d[(idx + 1) * 3 + 1], d[(idx + 1) * 3 + 2] * s);
            } else {
              this.applyViseme(curV, curA);
            }
          } else {
            this.applyViseme(curV, curA);
          }
        }
      } else {
        // Fallback procedural 6-viseme cadence with smooth co-articulation
        if (this.time >= this.visemeAt) {
          const r1 = pseudoRandom(this.time * 7.3 + this.seed * 19);
          const r2 = pseudoRandom(this.time * 11.1 + this.seed * 23);
          const pause = r1 < 0.13;
          this.prevVisemeId = this.visemeId;
          this.visemeId = pause ? 0 : FALLBACK_VISEMES[Math.floor(r2 * FALLBACK_VISEMES.length) % FALLBACK_VISEMES.length];
          this.visemeLevel = pause ? 0 : 0.50 + r1 * 0.46;
          this.visemeBlendT = 0;
          this.visemeAt = this.time + (pause ? 0.14 + r2 * 0.14 : 0.08 + r2 * 0.075);
        }
        this.visemeBlendT = Math.min(1, this.visemeBlendT + dt / 0.055);
        const h = this.visemeBlendT * this.visemeBlendT * (3 - 2 * this.visemeBlendT);
        if (this.prevVisemeId > 0 && h < 0.99) {
          this.applyViseme(this.prevVisemeId, this.visemeLevel * (1 - h) * 0.65);
        }
        this.applyViseme(this.visemeId, this.visemeLevel * h);
      }
    } else {
      this.activeSpeechText = '';
      this.speechTrack = null;
      this.speechElapsed = 0;
    }

    // Enforce non-additive co-articulation & bilinear jaw-vs-smile complementarity so mouth/tongue NEVER protrudes
    const smileIdx = this.morphKeys.get('smile');
    const aaIdx = this.morphKeys.get('aa');
    if (speaking && mood !== 'sleep') {
      if (this.has19Morphs) {
        if (smileIdx !== undefined) {
          const curSm = Math.min(0.84, this.wantedMorphs[smileIdx]);
          this.wantedMorphs[smileIdx] = curSm;
          if (aaIdx !== undefined) {
            const maxSafeAa = 0.64 * (1.0 - 0.32 * curSm);
            this.wantedMorphs[aaIdx] = Math.min(maxSafeAa, this.wantedMorphs[aaIdx]);
          }
        }
      } else {
        // 6-morph Codex52: blend mood smile + viseme smile softly and cap `aa` inversely with `smile`
        const baseMoodSmile = Math.min(0.82, (moodTargets.smile ?? 0) * moodIntensity);
        const curAaRaw = aaIdx !== undefined ? this.wantedMorphs[aaIdx] : 0;
        if (smileIdx !== undefined) {
          const totalAddedSmile = this.wantedMorphs[smileIdx];
          const visemeExtraSmile = Math.max(0, totalAddedSmile - baseMoodSmile);
          const attenuatedBase = baseMoodSmile * (1.0 - 0.25 * curAaRaw);
          const softCombined = 1.0 - (1.0 - attenuatedBase) * (1.0 - visemeExtraSmile);
          this.wantedMorphs[smileIdx] = Math.min(0.82, softCombined);
        }
        if (aaIdx !== undefined) {
          const effSmile = smileIdx !== undefined ? this.wantedMorphs[smileIdx] : 0;
          const maxSafeAa = 0.58 * (1.0 - 0.35 * effSmile);
          this.wantedMorphs[aaIdx] = Math.min(maxSafeAa, curAaRaw);
        }
      }
    }

    const influences = this.faceMesh.morphTargetInfluences;
    const lidA = this.morphKeys.get('blink.L');
    const lidB = this.morphKeys.get('blink.R');
    const kLid = reduced ? 1 : 1 - Math.exp(-46 * dt);
    const kMouth = reduced ? 1 : 1 - Math.exp(-(speaking ? 24 : 11) * dt);
    const kMood = reduced ? 1 : 1 - Math.exp(-7 * dt);

    for (let i = 0; i < influences.length; i++) {
      const rate = i === lidA || i === lidB ? kLid : this.isMouthIndex(i) ? kMouth : kMood;
      influences[i] += (this.wantedMorphs[i] - influences[i]) * rate;
    }
  }

  private isMouthIndex(index: number): boolean {
    for (const name of MOUTH_NAMES) {
      if (this.morphKeys.get(name) === index) return true;
    }
    return false;
  }

  private applyBreathingAndSway(
    dt: number,
    speed: number,
    seated: boolean,
    inDialogue: boolean,
    mood: LifeMood,
    snowIntensity: number,
  ): void {
    const sleeping = mood === 'sleep';
    const phase = this.time + this.seed * 19.7;
    const breathFreq = sleeping ? 1.15 : mood === 'excited' ? 2.05 : 1.55 + this.seed * 0.25; // ~0.25-0.32 Hz
    const breath = Math.sin(phase * breathFreq);

    // Subtle chest expansion & shoulder rise on inhale
    if (this.chest) {
      this.rotateBoneWorld(this.chest, _right, breath * (sleeping ? 0.024 : 0.018));
    }
    if (this.spine) {
      this.rotateBoneWorld(this.spine, _right, -breath * 0.007);
    }
    if (this.shoulderL) {
      this.rotateBoneWorld(this.shoulderL, _fwd, -breath * 0.011);
    }
    if (this.shoulderR) {
      this.rotateBoneWorld(this.shoulderR, _fwd, breath * 0.011);
    }

    // Subtle cold-weather snow micro-shiver & protective shoulder hunch when outdoors in active snowfall
    if (snowIntensity > 0.25 && !sleeping) {
      const cold = T.MathUtils.clamp((snowIntensity - 0.25) / 0.75, 0, 1);
      // Periodic 0.6 s shiver bursts every ~4.5 s (never constant buzzing)
      const burstWave = Math.max(0, Math.sin(phase * 1.4) - 0.72) / 0.28;
      const shiver = Math.sin(this.time * 40.0 + this.seed * 13) * burstWave * cold;
      if (this.shoulderL) this.rotateBoneWorld(this.shoulderL, _fwd, -0.024 * cold - shiver * 0.012);
      if (this.shoulderR) this.rotateBoneWorld(this.shoulderR, _fwd, 0.024 * cold + shiver * 0.012);
      if (this.chest && Math.abs(shiver) > 1e-4) {
        this.rotateBoneWorld(this.chest, UP, shiver * 0.006);
      }
    }

    // Gentle weight-shift idle sway when standing still (fades out cleanly during walk/run/sit/sleep)
    const wantSway = speed < 0.08 && !seated && !sleeping ? 1 : 0;
    this.swayWeight += (wantSway - this.swayWeight) * (1 - Math.exp(-5 * dt));
    if (this.swayWeight > 0.01 && this.hips) {
      const sway = Math.sin(phase * (0.62 + this.seed * 0.14)) * this.swayWeight;
      const scale = this.root.getWorldScale(_v1).x || 1;
      // Lateral pelvic weight shift in root frame
      _v2.copy(_right).multiplyScalar(sway * 0.011).applyQuaternion(_invRootQ).divideScalar(scale);
      this.hips.position.add(_v2);
      this.hips.updateWorldMatrix(true, false);
      this.rotateBoneWorld(this.hips, _fwd, -sway * 0.016);
      if (this.chest) this.rotateBoneWorld(this.chest, _fwd, sway * 0.018);
    }

    // Conversational / emotional head micro-motion cues
    if (!sleeping && this.head) {
      if (inDialogue) {
        const nod = Math.sin(phase * 2.1) * 0.030;
        const warmthTilt = mood === 'friendly' || mood === 'happy' ? 0.042 : 0;
        const tilt = Math.sin(phase * 0.95) * 0.032 + warmthTilt;
        this.rotateBoneWorld(this.head, _right, nod);
        this.rotateBoneWorld(this.head, _fwd, tilt);
      } else if (mood === 'annoyed') {
        this.rotateBoneWorld(this.head, _right, 0.045); // subtle guarded chin tuck
      } else if (mood === 'focus' || mood === 'listen') {
        const microNod = Math.max(0, Math.sin(phase * 1.8) - 0.78) * 0.14;
        if (microNod > 1e-4) this.rotateBoneWorld(this.head, _right, microNod);
      }
    }
  }

  private applyLookAt(
    dt: number,
    reduced: boolean,
    targetWorld: T.Vector3 | null,
    inDialogue: boolean,
    sleeping: boolean,
    driveEyes = true,
  ): void {
    let wantYaw = 0;
    let wantPitch = 0;

    if (targetWorld && !sleeping && this.head) {
      this.head.getWorldPosition(_v1);
      _v2.copy(targetWorld).sub(_v1);
      const dist = _v2.length();
      const maxRange = inDialogue ? 14 : 9.5;
      if (dist > 0.18 && dist < maxRange) {
        _v2.divideScalar(dist);
        const fDot = _v2.dot(_fwd);
        const rDot = _v2.dot(_right);
        const rawYaw = Math.atan2(rDot, fDot);
        const rawPitch = Math.asin(T.MathUtils.clamp(_v2.y, -1, 1));
        const maxYaw = inDialogue ? 1.25 : 1.15;
        if (Math.abs(rawYaw) <= maxYaw + 0.25) {
          const coneFade = 1 - T.MathUtils.smoothstep(Math.abs(rawYaw), maxYaw * 0.78, maxYaw + 0.25);
          const distFade = inDialogue ? 1 : 1 - T.MathUtils.smoothstep(dist, 5.5, maxRange);
          const gain = (inDialogue ? 1.0 : 0.68) * coneFade * distFade;
          wantYaw = T.MathUtils.clamp(rawYaw, -1.05, 1.05) * gain;
          wantPitch = T.MathUtils.clamp(rawPitch, -0.45, 0.42) * gain;
        }
      }
    }

    // Saccade-triggered physiological blink: 70% probability when gaze shifts > 22° (0.38 rad)
    if (!reduced && !sleeping && Math.abs(wantYaw - this.prevWantYaw) > 0.38 && this.blinkT < 0) {
      if (pseudoRandom(this.time * 9.3 + this.seed * 17) < 0.70) {
        this.blinkT = 0;
        this.doubleBlink = false;
        this.blinkStagger = 0.008;
      }
    }
    this.prevWantYaw = wantYaw;

    const rate = reduced ? 1 : 1 - Math.exp(-(inDialogue ? 8.5 : 5.5) * dt);
    this.gazeYaw += (wantYaw - this.gazeYaw) * rate;
    this.gazePitch += (wantPitch - this.gazePitch) * rate;

    // Distribute look across Chest (15%) -> Neck (35%) -> Head (50%)
    if (Math.abs(this.gazeYaw) + Math.abs(this.gazePitch) > 1e-4) {
      if (this.chest) {
        this.rotateBoneWorld(this.chest, UP, -this.gazeYaw * 0.15);
        this.rotateBoneWorld(this.chest, _right, this.gazePitch * 0.12);
      }
      if (this.neck) {
        this.rotateBoneWorld(this.neck, UP, -this.gazeYaw * 0.35);
        this.rotateBoneWorld(this.neck, _right, this.gazePitch * 0.34);
      }
      if (this.head) {
        this.rotateBoneWorld(this.head, UP, -this.gazeYaw * 0.50);
        this.rotateBoneWorld(this.head, _right, this.gazePitch * 0.54);
      }
    }

    // Ocular micro-saccades (0.5°–3° fixation darts across eye/mouth landmarks) with 75 ms critically damped tracking
    if (!sleeping && !reduced) {
      if (this.time >= this.saccadeAt) {
        const rA = pseudoRandom(this.time * 3.1 + this.seed * 41) - 0.5;
        const rB = pseudoRandom(this.time * 5.7 + this.seed * 53) - 0.5;
        if (inDialogue) {
          // Subtle 0.5°–2.0° triangular eye-eye-mouth fixation pattern during face-to-face dialogue
          this.saccadeLandmark = (this.saccadeLandmark + 1) % 3;
          const lmYaw = this.saccadeLandmark === 0 ? -0.022 : this.saccadeLandmark === 1 ? 0.022 : 0.0;
          const lmPitch = this.saccadeLandmark === 2 ? -0.028 : 0.008;
          this.saccadeTargetYaw = lmYaw + rB * 0.018 - this.gazeYaw * 0.20;
          this.saccadeTargetPitch = lmPitch + rA * 0.015 + this.gazePitch * 0.20;
          this.saccadeAt = this.time + 0.85 + pseudoRandom(this.time + this.seed * 7) * 1.45;
        } else {
          // Natural ambient 1°–3° scanning darts
          this.saccadeTargetYaw = rB * 0.09 - this.gazeYaw * 0.24;
          this.saccadeTargetPitch = rA * 0.055 + this.gazePitch * 0.22;
          this.saccadeAt = this.time + 0.75 + pseudoRandom(this.time + this.seed) * 2.25;
        }
      }
      const eyeTrack = 1 - Math.exp(-28 * dt);
      this.saccadeCurYaw += (this.saccadeTargetYaw - this.saccadeCurYaw) * eyeTrack;
      this.saccadeCurPitch += (this.saccadeTargetPitch - this.saccadeCurPitch) * eyeTrack;
    }

    if (driveEyes && this.eyes.length > 0 && !sleeping) {
      _e1.set(
        T.MathUtils.clamp(this.saccadeCurPitch, -0.26, 0.26),
        0,
        T.MathUtils.clamp(this.saccadeCurYaw, -0.36, 0.36),
      );
      _q1.setFromEuler(_e1);
      for (const eye of this.eyes) {
        eye.bone.quaternion.copy(eye.rest).multiply(_q1);
      }
    }
  }

  /**
   * Calibrates exact anatomical adduction (closing the 31°–35° bind starfish fan to a ~8° cascade)
   * and palmar flexion axes in world palm space once at construction time across both `Codex52` and `EchoStudentRig`.
   */
  private calibrateNaturalHandPoses(): void {
    this.root.updateWorldMatrix(true, true);
    const rootWorldQ = this.root.getWorldQuaternion(new T.Quaternion());
    const handPos = new T.Vector3();
    const midPos = new T.Vector3();
    const idxPos = new T.Vector3();
    const outerPos = new T.Vector3();
    const pA = new T.Vector3();
    const pB = new T.Vector3();
    const handDistalW = new T.Vector3();
    const handRadialW = new T.Vector3();
    const palmNormalW = new T.Vector3();
    const wantInwardW = new T.Vector3();
    const boneDirW = new T.Vector3();
    const dProj = new T.Vector3();
    const mProj = new T.Vector3();
    const axisW = new T.Vector3();
    const thumbGoalW = new T.Vector3();
    const qInv = new T.Quaternion();

    for (const side of [-1, 1] as const) {
      const handBone = side < 0 ? this.handL : this.handR;
      if (!handBone) continue;
      const grid: (FingerJointRef | null)[][] = Array.from({ length: 5 }, () => [null, null, null]);
      for (const f of this.fingers) {
        if (f.side === side && f.finger >= 0 && f.finger < 5 && f.joint >= 0 && f.joint < 3) {
          grid[f.finger][f.joint] = f;
        }
      }
      const mid0 = grid[2][0];
      const idx0 = grid[1][0];
      const outer0 = grid[4][0] ?? grid[3][0];
      if (!mid0 || !idx0 || !outer0) continue;

      handBone.getWorldPosition(handPos);
      mid0.bone.getWorldPosition(midPos);
      idx0.bone.getWorldPosition(idxPos);
      outer0.bone.getWorldPosition(outerPos);

      handDistalW.subVectors(midPos, handPos);
      if (handDistalW.lengthSq() < 1e-6) continue;
      handDistalW.normalize();

      handRadialW.subVectors(idxPos, outerPos);
      if (handRadialW.lengthSq() < 1e-6) continue;
      handRadialW.normalize();

      palmNormalW.crossVectors(handRadialW, handDistalW);
      if (palmNormalW.lengthSq() < 1e-6) continue;
      palmNormalW.normalize();

      // Orient palmNormalW inward toward body midline (-X for Left side=-1, +X for Right side=+1) & downward (-Y)
      wantInwardW.set(side * 0.72, -0.58, -0.10).applyQuaternion(rootWorldQ).normalize();
      if (palmNormalW.dot(wantInwardW) < 0) palmNormalW.negate();

      for (let fIdx = 0; fIdx < 5; fIdx++) {
        let lastDirValid = false;
        for (let j = 0; j < 3; j++) {
          const ref = grid[fIdx][j];
          if (!ref) continue;
          ref.bone.getWorldPosition(pA);
          const nextRef = j + 1 < 3 ? grid[fIdx][j + 1] : null;
          if (nextRef) {
            nextRef.bone.getWorldPosition(pB);
            boneDirW.subVectors(pB, pA);
            if (boneDirW.lengthSq() > 1e-8) {
              boneDirW.normalize();
              lastDirValid = true;
            }
          } else if (!lastDirValid && j > 0 && grid[fIdx][j - 1]) {
            grid[fIdx][j - 1]!.bone.getWorldPosition(pB);
            boneDirW.subVectors(pA, pB);
            if (boneDirW.lengthSq() > 1e-8) {
              boneDirW.normalize();
              lastDirValid = true;
            }
          }
          if (!lastDirValid) continue;

          // Step A: Proximal phalanx (MCP) adduction closing bind starfish splay / hitchhiker thumb
          if (j === 0) {
            if (fIdx >= 1) {
              dProj.copy(boneDirW).addScaledVector(palmNormalW, -boneDirW.dot(palmNormalW));
              mProj.copy(handDistalW).addScaledVector(palmNormalW, -handDistalW.dot(palmNormalW));
              if (dProj.lengthSq() > 1e-6 && mProj.lengthSq() > 1e-6) {
                dProj.normalize();
                mProj.normalize();
                const fanAngle = Math.acos(T.MathUtils.clamp(dProj.dot(mProj), -1, 1));
                const closeAngle = Math.min(0.42, fanAngle * 0.74);
                axisW.crossVectors(dProj, mProj);
                if (closeAngle > 1e-3 && axisW.lengthSq() > 1e-6) {
                  axisW.normalize();
                  this.rotateBoneWorld(ref.bone, axisW, closeAngle);
                  ref.bone.updateWorldMatrix(true, true);
                  if (nextRef) {
                    ref.bone.getWorldPosition(pA);
                    nextRef.bone.getWorldPosition(pB);
                    boneDirW.subVectors(pB, pA).normalize();
                  }
                }
              }
            } else {
              // Thumb MCP: tuck gently alongside radial-palmar side of index finger (zero upward +Y claw lift!)
              thumbGoalW
                .copy(handDistalW)
                .multiplyScalar(0.74)
                .addScaledVector(palmNormalW, 0.52)
                .addScaledVector(handRadialW, 0.16)
                .normalize();
              const thumbAngle = Math.acos(T.MathUtils.clamp(boneDirW.dot(thumbGoalW), -1, 1));
              axisW.crossVectors(boneDirW, thumbGoalW);
              if (thumbAngle > 1e-3 && axisW.lengthSq() > 1e-6) {
                axisW.normalize();
                this.rotateBoneWorld(ref.bone, axisW, Math.min(0.36, thumbAngle * 0.48));
                ref.bone.updateWorldMatrix(true, true);
                if (nextRef) {
                  ref.bone.getWorldPosition(pA);
                  nextRef.bone.getWorldPosition(pB);
                  boneDirW.subVectors(pB, pA).normalize();
                }
              }
            }
          }

          // Step B: True palmar flexion (`cross(boneDirW, palmNormalW)` curls phalanx directly inward toward palm!)
          const flexAngle = PALM_RELAXED_FLEXION[fIdx][j];
          axisW.crossVectors(boneDirW, palmNormalW);
          if (axisW.lengthSq() > 1e-6) {
            axisW.normalize();
            this.rotateBoneWorld(ref.bone, axisW, flexAngle);
            ref.bone.updateWorldMatrix(true, true);
            ref.qRelaxedLocal.copy(ref.bone.quaternion);
            ref.bone.getWorldQuaternion(qInv).invert();
            ref.localFlexAxis.copy(axisW).applyQuaternion(qInv).normalize();
            if (nextRef) {
              ref.bone.getWorldPosition(pA);
              nextRef.bone.getWorldPosition(pB);
              boneDirW.subVectors(pB, pA).normalize();
            }
          } else {
            ref.qRelaxedLocal.copy(ref.bone.quaternion);
          }
        }
      }

      // Restore clean bind rest quaternions after calibration
      for (const f of this.fingers) {
        if (f.side === side) f.bone.quaternion.copy(f.rest);
      }
      handBone.updateWorldMatrix(true, true);
    }
  }

  private applyNaturalFingers(): void {
    const microFlex = Math.sin((this.time + this.seed * 13.3) * 1.45) * 0.022;
    for (const f of this.fingers) {
      _q1.setFromAxisAngle(f.localFlexAxis, microFlex * (0.6 + f.joint * 0.2));
      f.bone.quaternion.copy(f.qRelaxedLocal).multiply(_q1);
    }
  }

  private rotateBoneWorld(bone: T.Bone, axis: T.Vector3, angle: number): void {
    if (Math.abs(angle) < 1e-5 || !bone.parent) return;
    _q1.setFromAxisAngle(axis, angle);
    bone.getWorldQuaternion(_q2);
    _q1.multiply(_q2);
    bone.parent.getWorldQuaternion(_q3).invert();
    bone.quaternion.copy(_q3).multiply(_q1);
    bone.updateWorldMatrix(true, false);
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

function pseudoRandom(x: number): number {
  const v = Math.sin(x * 12.9898 + 78.233) * 43758.5453;
  return v - Math.floor(v);
}
