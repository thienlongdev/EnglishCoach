import * as T from 'three';

/**
 * Zero-Allocation Fixed-60 Hz XPBD Hair & Cloth Secondary Physics Solver for Echo Life AAA.
 *
 * Activates real-time physical hair & cloth bone dynamics with analytical body collision avoidance:
 *  - Player `RunnerRig` (`Lyra` / `Kai`): `pony.1..3`, `side.L/R`, `fringe`, AND all 6 previously-static
 *    `scarf.L.1..3` + `scarf.R.1..3` scarf tails!
 *  - Future upgraded hero NPCs / outfits: auto-discovers `hair_back.*`, `coat_*`, `skirt_*`, `bag_strap.*`.
 *  - 5 analytical body colliders (`headSphere`, `neckCapsule`, `chestCapsule`, `upperArmCapsule.L/R`)
 *    prevent ponytail-through-back and scarf-through-chest clipping during sprints, turns, and seating.
 *  - 3-tier distance LOD: Tier-0 (`< 12 m`) 60 Hz / 2 Gauss-Seidel iterations, Tier-1 (`12–28 m`) 30 Hz /
 *    1 iteration (head+chest colliders), Tier-2 (`> 28 m`) paused at 0.00 ms CPU.
 */

export interface SecondaryWind {
  x: number;
  z: number;
  gust?: number;
}

export interface SecondaryWearableContext {
  headwear?: 'none' | 'beanie' | 'cap' | string | null;
  outerwear?:
    | 'none'
    | 'cardigan'
    | 'wool_overcoat'
    | 'trench_coat'
    | 'puffer_parka'
    | 'winter_scarf'
    | string
    | null;
  hasBackpack?: boolean;
  hasScarfAccessory?: boolean;
}

export interface HairBoneRestOverride {
  position: T.Vector3;
  quaternion: T.Quaternion;
}

interface OuterwearColliderSpec {
  collarR: number;
  collarOffY: number;
  collarOffZ: number;
  backR: number;
  backOffZ: number;
  armExtra: number;
}

const OUTERWEAR_COLLIDER_SPECS: Record<string, OuterwearColliderSpec> = {
  none: { collarR: 0.066, collarOffY: 0.010, collarOffZ: -0.012, backR: 0.136, backOffZ: -0.015, armExtra: 0.0 },
  cardigan: { collarR: 0.082, collarOffY: 0.012, collarOffZ: -0.020, backR: 0.148, backOffZ: -0.024, armExtra: 0.012 },
  wool_overcoat: { collarR: 0.106, collarOffY: 0.016, collarOffZ: -0.034, backR: 0.166, backOffZ: -0.032, armExtra: 0.022 },
  trench_coat: { collarR: 0.112, collarOffY: 0.018, collarOffZ: -0.038, backR: 0.174, backOffZ: -0.036, armExtra: 0.020 },
  puffer_parka: { collarR: 0.116, collarOffY: 0.022, collarOffZ: -0.036, backR: 0.170, backOffZ: -0.030, armExtra: 0.026 },
  winter_scarf: { collarR: 0.118, collarOffY: 0.024, collarOffZ: -0.022, backR: 0.145, backOffZ: -0.018, armExtra: 0.0 },
  jacket: { collarR: 0.092, collarOffY: 0.014, collarOffZ: -0.024, backR: 0.154, backOffZ: -0.024, armExtra: 0.016 },
  hoodie: { collarR: 0.104, collarOffY: 0.020, collarOffZ: -0.032, backR: 0.158, backOffZ: -0.026, armExtra: 0.016 },
};

interface ChainConfig {
  bones: T.Bone[];
  stiffness: number; // 0..1 rest-pose tether pull per iteration
  drag: number; // 0..1 velocity damping per 60 Hz step
  maxConeRad: number; // max deflection angle from animated rest axis
  windGain: number; // aerodynamic drag coupling multiplier
  gravityScale: number; // 1.0 = full gravity
  particleRadius: number; // meters at scale 1
  tipLength: number; // virtual tip length beyond last bone (meters at scale 1)
}

interface SimChain {
  bones: T.Bone[];
  /** Number of simulated particles = bones.length + 1 (index 0 pinned to bone[0] world pos, last is virtual tip). */
  n: number;
  // Flat pre-allocated particle buffers (world space)
  pos: Float32Array;
  prev: Float32Array;
  restDirLocal: Float32Array; // unit rest direction of each segment in its bone's parent frame (n-1)*3
  segLen: Float32Array; // rest segment length (n-1)
  stiffness: number;
  drag: number;
  cosMaxCone: number;
  maxConeRad: number;
  windGain: number;
  gravityScale: number;
  particleRadius: number;
  seeded: boolean;
}

interface ColliderCache {
  // Spheres: [x, y, z, r]
  head: Float32Array;
  collar: Float32Array;
  backpack: Float32Array;
  // Capsules: [ax, ay, az, bx, by, bz, r]
  neck: Float32Array;
  chest: Float32Array;
  upperBack: Float32Array;
  armL: Float32Array;
  armR: Float32Array;
  hasCollar: boolean;
  hasBackpack: boolean;
  hasNeck: boolean;
  hasChest: boolean;
  hasUpperBack: boolean;
  hasArmL: boolean;
  hasArmR: boolean;
}

const FIXED_DT = 1 / 60;
const GRAVITY = -9.81;
const TELEPORT_DIST_SQ = 1.44; // > 1.2 m jump in one frame triggers clean snap reset
const _beanieTuckPitchQ = new T.Quaternion().setFromAxisAngle(new T.Vector3(1, 0, 0), -0.24);

// Module-scoped zero-alloc scratch math
const _v0 = new T.Vector3();
const _v1 = new T.Vector3();
const _v2 = new T.Vector3();
const _v3 = new T.Vector3();
const _v4 = new T.Vector3();
const _q0 = new T.Quaternion();
const _q1 = new T.Quaternion();
const _q2 = new T.Quaternion();

function findBonesMap(root: T.Object3D): Map<string, T.Bone> {
  const map = new Map<string, T.Bone>();
  root.traverse((o) => {
    if (!(o as T.Bone).isBone) return;
    const bone = o as T.Bone;
    const authored = (bone.userData.name as string | undefined) ?? bone.name;
    map.set(authored, bone);
    if (bone.name !== authored) map.set(bone.name, bone);
  });
  return map;
}

function pickBone(map: Map<string, T.Bone>, names: readonly string[]): T.Bone | null {
  for (const n of names) {
    const b = map.get(n);
    if (b) return b;
  }
  return null;
}

function collectOrderedChain(map: Map<string, T.Bone>, patterns: readonly RegExp[]): T.Bone[] {
  const matched: { idx: number; bone: T.Bone }[] = [];
  const seen = new Set<T.Bone>();
  for (const [name, bone] of map) {
    if (seen.has(bone)) continue;
    for (const re of patterns) {
      const m = re.exec(name);
      if (m) {
        seen.add(bone);
        matched.push({ idx: Number(m[1] ?? 1), bone });
        break;
      }
    }
  }
  matched.sort((a, b) => a.idx - b.idx);
  return matched.map((m) => m.bone);
}

/** Pushes particle `(px, py, pz)` cleanly outside sphere `[sx, sy, sz, sr]` (returns updated coords via `_v3`). */
function pushOutSphere(
  px: number,
  py: number,
  pz: number,
  pr: number,
  s: Float32Array,
  out: T.Vector3,
): boolean {
  const dx = px - s[0];
  const dy = py - s[1];
  const dz = pz - s[2];
  const minDist = s[3] + pr;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= minDist * minDist || d2 < 1e-10) return false;
  const d = Math.sqrt(d2);
  const k = minDist / d;
  out.set(s[0] + dx * k, s[1] + dy * k, s[2] + dz * k);
  return true;
}

/** Pushes particle `(px, py, pz)` cleanly outside capsule `[ax, ay, az, bx, by, bz, r]`. */
function pushOutCapsule(
  px: number,
  py: number,
  pz: number,
  pr: number,
  c: Float32Array,
  out: T.Vector3,
): boolean {
  const abx = c[3] - c[0];
  const aby = c[4] - c[1];
  const abz = c[5] - c[2];
  const ab2 = abx * abx + aby * aby + abz * abz;
  let t = 0;
  if (ab2 > 1e-8) {
    t = ((px - c[0]) * abx + (py - c[1]) * aby + (pz - c[2]) * abz) / ab2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const qx = c[0] + abx * t;
  const qy = c[1] + aby * t;
  const qz = c[2] + abz * t;
  const dx = px - qx;
  const dy = py - qy;
  const dz = pz - qz;
  const minDist = c[6] + pr;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= minDist * minDist || d2 < 1e-10) return false;
  const d = Math.sqrt(d2);
  const k = minDist / d;
  out.set(qx + dx * k, qy + dy * k, qz + dz * k);
  return true;
}

export class SecondaryPhysics {
  private readonly chains: SimChain[] = [];
  private readonly baseQuats = new Map<T.Bone, T.Quaternion>();
  private readonly preTuckQuats = new Map<T.Bone, T.Quaternion>();
  private readonly hairRestOverrides = new Map<T.Bone, HairBoneRestOverride>();
  private ponyRootBone: T.Bone | null = null;
  private readonly ponyBindLocalPos = new T.Vector3();
  private readonly ponyTuckLocalDelta = new T.Vector3();
  private ponyCanTuckUnderBeanie = false;
  private ponyTuckedNow = false;
  private wearables: Required<SecondaryWearableContext> = {
    headwear: 'none',
    outerwear: 'none',
    hasBackpack: false,
    hasScarfAccessory: false,
  };
  private boneHead: T.Bone | null = null;
  private boneNeck: T.Bone | null = null;
  private boneSpine: T.Bone | null = null;
  private boneChest: T.Bone | null = null;
  private boneUpperArmL: T.Bone | null = null;
  private boneForearmL: T.Bone | null = null;
  private boneUpperArmR: T.Bone | null = null;
  private boneForearmR: T.Bone | null = null;
  private readonly colliders: ColliderCache = {
    head: new Float32Array(4),
    collar: new Float32Array(4),
    backpack: new Float32Array(4),
    neck: new Float32Array(7),
    chest: new Float32Array(7),
    upperBack: new Float32Array(7),
    armL: new Float32Array(7),
    armR: new Float32Array(7),
    hasCollar: false,
    hasBackpack: false,
    hasNeck: false,
    hasChest: false,
    hasUpperBack: false,
    hasArmL: false,
    hasArmR: false,
  };
  private colliderBuildScale = 1;
  private colliderHeightScale = 1;
  private readonly seed: number;
  private accumulator = 0;
  private time = 0;
  private tier1Skip = false;
  root: T.Object3D;

  constructor(
    root: T.Object3D,
    actorKey = '',
  ) {
    this.root = root;
    this.seed = hashSeed(actorKey);
    this.rebind(root);
  }

  /** Re-discovers active hair/scarf bones and collider anchors after modular hair or outerwear swaps. */
  rebind(model: T.Object3D): void {
    this.restore();
    this.root = model;
    model.userData.__ecSecondaryPhysics = this;
    if (model.userData.__ecWearableContext) {
      const saved = model.userData.__ecWearableContext as SecondaryWearableContext;
      this.wearables = {
        headwear: saved.headwear ?? 'none',
        outerwear: saved.outerwear ?? 'none',
        hasBackpack: Boolean(saved.hasBackpack),
        hasScarfAccessory: Boolean(saved.hasScarfAccessory),
      };
    }
    this.chains.length = 0;
    this.baseQuats.clear();
    this.preTuckQuats.clear();
    this.hairRestOverrides.clear();
    this.ponyRootBone = null;
    this.ponyCanTuckUnderBeanie = false;
    this.ponyTuckedNow = false;
    this.accumulator = 0;
    const map = findBonesMap(model);

    const rawHairOverrides = model.userData.__ecHairRigOverrides as
      | ReadonlyMap<string, HairBoneRestOverride>
      | undefined;
    if (rawHairOverrides) {
      for (const [name, ov] of rawHairOverrides) {
        const b = map.get(name);
        if (b) {
          b.position.copy(ov.position);
          b.quaternion.copy(ov.quaternion);
          this.hairRestOverrides.set(b, {
            position: ov.position.clone(),
            quaternion: ov.quaternion.clone(),
          });
        }
      }
    }

    this.boneHead = pickBone(map, ['head', 'Head']);
    this.boneNeck = pickBone(map, ['neck', 'Neck']);
    this.boneSpine = pickBone(map, ['spine', 'Spine', 'Spine1']);
    this.boneChest = pickBone(map, ['chest', 'Spine2']);
    this.boneUpperArmL = pickBone(map, ['upper_arm.L', 'upper_armL', 'LeftArm']);
    this.boneForearmL = pickBone(map, ['forearm.L', 'forearmL', 'LeftForeArm']);
    this.boneUpperArmR = pickBone(map, ['upper_arm.R', 'upper_armR', 'RightArm']);
    this.boneForearmR = pickBone(map, ['forearm.R', 'forearmR', 'RightForeArm']);

    const configs: ChainConfig[] = [];

    // 1. RunnerRig ponytail (`pony.1 -> pony.2 -> pony.3`)
    const pony = collectOrderedChain(map, [/^pony[._]?(\d+)$/i]);
    if (pony.length > 0) {
      configs.push({
        bones: pony,
        stiffness: 0.24,
        drag: 0.13,
        maxConeRad: 1.12, // ~64°
        windGain: 0.85,
        gravityScale: 0.92,
        particleRadius: 0.032,
        tipLength: 0.125,
      });
    }

    // 2. RunnerRig scarf tails (`scarf.L.1..3` and `scarf.R.1..3`) — tightened so tails stay clear of crossbody strap!
    const scarfL = collectOrderedChain(map, [/^scarf[._]?L[._]?(\d+)$/i]);
    if (scarfL.length > 0) {
      configs.push({
        bones: scarfL,
        stiffness: 0.34,
        drag: 0.18,
        maxConeRad: 0.78, // ~45° restrained scarf drape
        windGain: 0.85,
        gravityScale: 1.0,
        particleRadius: 0.024,
        tipLength: 0.11,
      });
    }
    const scarfR = collectOrderedChain(map, [/^scarf[._]?R[._]?(\d+)$/i]);
    if (scarfR.length > 0) {
      configs.push({
        bones: scarfR,
        stiffness: 0.34,
        drag: 0.18,
        maxConeRad: 0.78, // ~45° restrained scarf drape
        windGain: 0.85,
        gravityScale: 1.0,
        particleRadius: 0.024,
        tipLength: 0.11,
      });
    }

    // 3. RunnerRig face-framing side locks & fringe
    const sideL = pickBone(map, ['side.L', 'sideL']);
    if (sideL) {
      configs.push({
        bones: [sideL],
        stiffness: 0.56,
        drag: 0.19,
        maxConeRad: 0.48,
        windGain: 0.65,
        gravityScale: 0.72,
        particleRadius: 0.018,
        tipLength: 0.115,
      });
    }
    const sideR = pickBone(map, ['side.R', 'sideR']);
    if (sideR) {
      configs.push({
        bones: [sideR],
        stiffness: 0.56,
        drag: 0.19,
        maxConeRad: 0.48,
        windGain: 0.65,
        gravityScale: 0.72,
        particleRadius: 0.018,
        tipLength: 0.115,
      });
    }
    const fringe = pickBone(map, ['fringe']);
    if (fringe) {
      configs.push({
        bones: [fringe],
        stiffness: 0.74,
        drag: 0.22,
        maxConeRad: 0.28,
        windGain: 0.42,
        gravityScale: 0.48,
        particleRadius: 0.014,
        tipLength: 0.085,
      });
    }

    // 4. Optional upgraded hero resident hair / coat / skirt chains
    for (const [re, stiff, cone, wind] of [
      [/^hair_back[._]?(\d+)$/i, 0.28, 1.05, 0.9],
      [/^hair_L[._]?(\d+)$/i, 0.44, 0.65, 0.75],
      [/^hair_R[._]?(\d+)$/i, 0.44, 0.65, 0.75],
      [/^coat_B[._]?(\d+)$/i, 0.36, 0.85, 0.95],
      [/^skirt_B[._]?(\d+)$/i, 0.42, 0.72, 0.85],
    ] as const) {
      const ch = collectOrderedChain(map, [re]);
      if (ch.length > 0) {
        configs.push({
          bones: ch,
          stiffness: stiff,
          drag: 0.17,
          maxConeRad: cone,
          windGain: wind,
          gravityScale: 0.95,
          particleRadius: 0.025,
          tipLength: 0.11,
        });
      }
    }

    model.updateWorldMatrix(true, true);
    if (pony.length > 0) {
      const p0 = pony[0];
      p0.getWorldPosition(_v0);
      const localInModel = model.worldToLocal(_v1.copy(_v0));
      // High ponytails anchored above y=1.53m tuck under the beanie cuff (y≈1.509m) when a beanie is equipped
      if (localInModel.y > 1.53 && p0.parent) {
        this.ponyRootBone = p0;
        this.ponyBindLocalPos.copy(p0.position);
        model.getWorldQuaternion(_q0);
        // Desired offset in character model frame: -76mm down, +30mm forward into nape beneath beanie brim
        _v2.set(0, -0.076, 0.030).applyQuaternion(_q0);
        p0.parent.getWorldQuaternion(_q1).invert();
        this.ponyTuckLocalDelta.copy(_v2).applyQuaternion(_q1);
        this.ponyCanTuckUnderBeanie = true;
      }
    }

    for (const cfg of configs) {
      const built = this.buildChain(cfg);
      if (built) {
        this.chains.push(built);
        for (const b of built.bones) {
          this.baseQuats.set(b, b.quaternion.clone());
          this.preTuckQuats.set(b, b.quaternion.clone());
        }
      }
    }
    this.syncBeaniePonytailPose();
  }

  /**
   * Updates active headwear, outerwear, and backpack context so collar/upper-back/backpack spheres
   * expand cleanly around winter coats and high ponytails tuck beneath winter beanies.
   */
  setWearableContext(ctx: SecondaryWearableContext): void {
    const nextHeadwear = ctx.headwear ?? 'none';
    const nextOuter = ctx.outerwear ?? 'none';
    const nextPack = Boolean(ctx.hasBackpack);
    const nextScarf = Boolean(ctx.hasScarfAccessory);
    const changed =
      this.wearables.headwear !== nextHeadwear ||
      this.wearables.outerwear !== nextOuter ||
      this.wearables.hasBackpack !== nextPack ||
      this.wearables.hasScarfAccessory !== nextScarf;
    this.wearables = {
      headwear: nextHeadwear,
      outerwear: nextOuter,
      hasBackpack: nextPack,
      hasScarfAccessory: nextScarf,
    };
    this.root.userData.__ecWearableContext = this.wearables;
    if (changed) {
      this.syncBeaniePonytailPose();
      this.root.updateWorldMatrix(true, true);
      this.updateColliders(true);
      this.reset();
    }
  }

  private syncBeaniePonytailPose(): void {
    const wantTuck = this.ponyCanTuckUnderBeanie && this.wearables.headwear === 'beanie';
    const p0 = this.ponyRootBone;
    if (!p0) return;
    const preQ = this.preTuckQuats.get(p0);
    const baseQ = this.baseQuats.get(p0);
    if (!preQ || !baseQ) return;
    if (wantTuck && !this.ponyTuckedNow) {
      p0.position.copy(this.ponyBindLocalPos).add(this.ponyTuckLocalDelta);
      p0.quaternion.copy(preQ).multiply(_beanieTuckPitchQ);
      baseQ.copy(p0.quaternion);
      this.ponyTuckedNow = true;
    } else if (!wantTuck && this.ponyTuckedNow) {
      p0.position.copy(this.ponyBindLocalPos);
      p0.quaternion.copy(preQ);
      baseQ.copy(preQ);
      this.ponyTuckedNow = false;
    }
  }

  /** Scales body collider radii cleanly when Character Creator body sliders change. */
  rebuildColliders(buildScale: number, heightScale = 1): void {
    this.colliderBuildScale = T.MathUtils.clamp(Number.isFinite(buildScale) ? buildScale : 1, 0.82, 1.25);
    this.colliderHeightScale = T.MathUtils.clamp(Number.isFinite(heightScale) ? heightScale : 1, 0.88, 1.18);
    this.root.updateWorldMatrix(true, true);
    this.updateColliders(true);
    this.reset();
  }

  get chainCount(): number {
    return this.chains.length;
  }

  get active(): boolean {
    return this.chains.length > 0;
  }

  private buildChain(cfg: ChainConfig): SimChain | null {
    const m = cfg.bones.length;
    if (m === 0) return null;
    const n = m + 1;
    const pos = new Float32Array(n * 3);
    const prev = new Float32Array(n * 3);
    const restDirLocal = new Float32Array(m * 3);
    const segLen = new Float32Array(m);

    for (let i = 0; i < m; i++) {
      const b = cfg.bones[i];
      b.getWorldPosition(_v0);
      if (i + 1 < m) {
        cfg.bones[i + 1].getWorldPosition(_v1);
        _v2.subVectors(_v1, _v0);
        const len = Math.max(0.03, _v2.length());
        segLen[i] = len;
        _v2.divideScalar(len);
      } else {
        // Virtual tip direction: continue along last segment or bone's local +Y (downward hair/scarf bone axis)
        if (i > 0) {
          cfg.bones[i - 1].getWorldPosition(_v1);
          _v2.subVectors(_v0, _v1);
          if (_v2.lengthSq() > 1e-6) _v2.normalize();
          else _v2.set(0, -1, 0);
        } else {
          b.getWorldQuaternion(_q0);
          _v2.set(0, 1, 0).applyQuaternion(_q0).normalize();
          // Ensure side locks / fringe hang generally downward rather than straight up into the scalp
          if (_v2.y > 0.35) _v2.negate();
        }
        const rootScale = this.root.getWorldScale(_v1).y || 1;
        segLen[i] = cfg.tipLength * rootScale;
      }

      // Express unit rest direction in bone's own local space (`inv(boneWorldQ) * worldDir`)
      b.getWorldQuaternion(_q0).invert();
      _v2.applyQuaternion(_q0).normalize();
      restDirLocal[i * 3] = _v2.x;
      restDirLocal[i * 3 + 1] = _v2.y;
      restDirLocal[i * 3 + 2] = _v2.z;
    }

    return {
      bones: cfg.bones,
      n,
      pos,
      prev,
      restDirLocal,
      segLen,
      stiffness: cfg.stiffness,
      drag: cfg.drag,
      cosMaxCone: Math.cos(cfg.maxConeRad),
      maxConeRad: cfg.maxConeRad,
      windGain: cfg.windGain,
      gravityScale: cfg.gravityScale,
      particleRadius: cfg.particleRadius,
      seeded: false,
    };
  }

  /**
   * Syncs hair-chain bone rest transforms (`pony.1..3`, `side.L/R`, `fringe`) to an equipped modular
   * `hair_*` GLB so cross-hero rigs (`KAI`) measure true segment lengths and pivots without XPBD shear.
   */
  setHairRigOverrides(overrides: ReadonlyMap<string, HairBoneRestOverride> | null): void {
    this.root.userData.__ecHairRigOverrides = overrides ?? undefined;
    this.rebind(this.root);
  }

  /** Call BEFORE `mixer.update(dt)` so XPBD and hat-tuck offsets never compound across frames. */
  restore(): void {
    if (this.ponyRootBone && this.ponyTuckedNow) {
      this.ponyRootBone.position.copy(this.ponyBindLocalPos);
      this.ponyTuckedNow = false;
    }
    for (const [bone, ov] of this.hairRestOverrides) {
      bone.position.copy(ov.position);
    }
    for (const [bone, q] of this.preTuckQuats) {
      bone.quaternion.copy(q);
    }
  }

  /** Call AFTER `mixer.update(dt)` (and before `update()`) to capture the clip's animated rest pose. */
  capture(): void {
    for (const [bone, ov] of this.hairRestOverrides) {
      bone.position.copy(ov.position);
      bone.quaternion.copy(ov.quaternion);
    }
    for (const [bone, q] of this.preTuckQuats) {
      q.copy(bone.quaternion);
      const bq = this.baseQuats.get(bone);
      if (bq) bq.copy(bone.quaternion);
    }
    this.ponyTuckedNow = false;
    this.syncBeaniePonytailPose();
  }

  /** Clears particle velocities and snaps chains onto current animated rest pose (call on teleport). */
  reset(): void {
    this.accumulator = 0;
    for (let c = 0; c < this.chains.length; c++) {
      this.chains[c].seeded = false;
    }
  }

  /**
   * Immediately relaxes XPBD hair/scarf chains into static gravity + body-collider equilibrium
   * when simulation time (`simDt`) is frozen at 0 (e.g. Photo Studio pose or CAZ outfit switches).
   */
  settleImmediate(steps = 12, stepDt = 1 / 60): void {
    if (this.chains.length === 0) return;
    const nSteps = Math.max(1, Math.min(48, Math.floor(steps)));
    const h = T.MathUtils.clamp(stepDt, 1 / 240, 0.05);
    this.root.updateWorldMatrix(true, true);
    this.updateColliders(true);
    const scale = this.root.getWorldScale(_v0).y || 1;
    for (let c = 0; c < this.chains.length; c++) {
      if (!this.chains[c].seeded) {
        this.seedChain(this.chains[c]);
      }
    }
    for (let s = 0; s < nSteps; s++) {
      this.stepAllChains(h, 3, 0, 0, scale, true);
    }
    for (let c = 0; c < this.chains.length; c++) {
      this.chains[c].prev.set(this.chains[c].pos);
    }
    this.accumulator = 0;
    this.applyCurrentParticlesToBones();
  }

  private seedChain(chain: SimChain): void {
    const m = chain.bones.length;
    for (let i = 0; i < m; i++) {
      const b = chain.bones[i];
      b.getWorldPosition(_v0);
      const o = i * 3;
      chain.pos[o] = chain.prev[o] = _v0.x;
      chain.pos[o + 1] = chain.prev[o + 1] = _v0.y;
      chain.pos[o + 2] = chain.prev[o + 2] = _v0.z;
    }
    const lastB = chain.bones[m - 1];
    lastB.getWorldQuaternion(_q0);
    _v1
      .set(chain.restDirLocal[(m - 1) * 3], chain.restDirLocal[(m - 1) * 3 + 1], chain.restDirLocal[(m - 1) * 3 + 2])
      .applyQuaternion(_q0)
      .multiplyScalar(chain.segLen[m - 1]);
    const prevO = (m - 1) * 3;
    const tipO = m * 3;
    chain.pos[tipO] = chain.prev[tipO] = chain.pos[prevO] + _v1.x;
    chain.pos[tipO + 1] = chain.prev[tipO + 1] = chain.pos[prevO + 1] + _v1.y;
    chain.pos[tipO + 2] = chain.prev[tipO + 2] = chain.pos[prevO + 2] + _v1.z;
    chain.seeded = true;
  }

  private updateColliders(fullBody: boolean): void {
    const scale = (this.root.getWorldScale(_v0).y || 1) * this.colliderHeightScale;
    const bScale = this.colliderBuildScale;
    const col = this.colliders;
    const outerKey = this.wearables.outerwear || 'none';
    const spec = OUTERWEAR_COLLIDER_SPECS[outerKey] ?? OUTERWEAR_COLLIDER_SPECS.none;
    const collarRBase = this.wearables.hasScarfAccessory ? Math.max(spec.collarR, 0.118) : spec.collarR;

    if (this.boneHead) {
      this.boneHead.getWorldPosition(_v0);
      this.boneHead.getWorldQuaternion(_q0);
      const hatExtra = this.wearables.headwear === 'beanie' ? 0.010 : 0;
      _v1.set(0, 0.075 * scale, 0.008 * scale).applyQuaternion(_q0).add(_v0);
      col.head[0] = _v1.x;
      col.head[1] = _v1.y;
      col.head[2] = _v1.z;
      col.head[3] = (0.118 + hatExtra) * scale;
    } else {
      col.head[3] = 0;
    }

    // Yaw-invariant collar sphere anchored to neck bone & shifted backward (-Z in bone local frame)
    if (this.boneNeck) {
      this.boneNeck.getWorldPosition(_v0);
      this.boneNeck.getWorldQuaternion(_q0);
      _v1.set(0, spec.collarOffY * scale, spec.collarOffZ * scale).applyQuaternion(_q0).add(_v0);
      col.collar[0] = _v1.x;
      col.collar[1] = _v1.y;
      col.collar[2] = _v1.z;
      col.collar[3] = collarRBase * scale * (0.55 + 0.45 * bScale);
      col.hasCollar = true;
    } else {
      col.hasCollar = false;
    }

    if (this.boneNeck && this.boneHead) {
      this.boneNeck.getWorldPosition(_v0);
      this.boneHead.getWorldPosition(_v1);
      col.neck[0] = _v0.x;
      col.neck[1] = _v0.y;
      col.neck[2] = _v0.z;
      col.neck[3] = _v1.x;
      col.neck[4] = _v1.y;
      col.neck[5] = _v1.z;
      col.neck[6] = Math.max(0.062, collarRBase * 0.78) * scale * (0.5 + 0.5 * bScale);
      col.hasNeck = true;
    } else {
      col.hasNeck = false;
    }

    if (this.boneSpine && this.boneChest) {
      this.boneSpine.getWorldPosition(_v0);
      this.boneChest.getWorldPosition(_v1);
      col.chest[0] = _v0.x;
      col.chest[1] = _v0.y;
      col.chest[2] = _v0.z;
      col.chest[3] = _v1.x;
      col.chest[4] = _v1.y;
      col.chest[5] = _v1.z;
      col.chest[6] = (0.152 + spec.armExtra * 0.65) * scale * bScale;
      col.hasChest = true;
    } else {
      col.hasChest = false;
    }

    // Yaw-invariant upper-back capsule (`chest -> neck`) shifted backward along local -Z to clear winter coat collars/backs
    if (this.boneChest && this.boneNeck) {
      this.boneChest.getWorldPosition(_v0);
      this.boneChest.getWorldQuaternion(_q0);
      _v2.set(0, 0.015 * scale, spec.backOffZ * scale).applyQuaternion(_q0);
      _v0.add(_v2);

      this.boneNeck.getWorldPosition(_v1);
      this.boneNeck.getWorldQuaternion(_q0);
      _v2.set(0, 0.010 * scale, spec.collarOffZ * scale).applyQuaternion(_q0);
      _v1.add(_v2);

      col.upperBack[0] = _v0.x;
      col.upperBack[1] = _v0.y;
      col.upperBack[2] = _v0.z;
      col.upperBack[3] = _v1.x;
      col.upperBack[4] = _v1.y;
      col.upperBack[5] = _v1.z;
      col.upperBack[6] = spec.backR * scale * bScale;
      col.hasUpperBack = true;
    } else {
      col.hasUpperBack = false;
    }

    // Optional backpack sphere (`acc_backpack` extends to z = -0.312m behind chest)
    if (this.wearables.hasBackpack && this.boneChest) {
      this.boneChest.getWorldPosition(_v0);
      this.boneChest.getWorldQuaternion(_q0);
      _v1.set(0, -0.035 * scale, -0.165 * scale).applyQuaternion(_q0).add(_v0);
      col.backpack[0] = _v1.x;
      col.backpack[1] = _v1.y;
      col.backpack[2] = _v1.z;
      col.backpack[3] = 0.158 * scale * bScale;
      col.hasBackpack = true;
    } else {
      col.hasBackpack = false;
    }

    if (fullBody && this.boneUpperArmL && this.boneForearmL) {
      this.boneUpperArmL.getWorldPosition(_v0);
      this.boneForearmL.getWorldPosition(_v1);
      _v1.lerp(_v0, 0.35);
      col.armL[0] = _v0.x;
      col.armL[1] = _v0.y;
      col.armL[2] = _v0.z;
      col.armL[3] = _v1.x;
      col.armL[4] = _v1.y;
      col.armL[5] = _v1.z;
      col.armL[6] = (0.066 + spec.armExtra) * scale * bScale;
      col.hasArmL = true;
    } else {
      col.hasArmL = false;
    }

    if (fullBody && this.boneUpperArmR && this.boneForearmR) {
      this.boneUpperArmR.getWorldPosition(_v0);
      this.boneForearmR.getWorldPosition(_v1);
      _v1.lerp(_v0, 0.35);
      col.armR[0] = _v0.x;
      col.armR[1] = _v0.y;
      col.armR[2] = _v0.z;
      col.armR[3] = _v1.x;
      col.armR[4] = _v1.y;
      col.armR[5] = _v1.z;
      col.armR[6] = (0.066 + spec.armExtra) * scale * bScale;
      col.hasArmR = true;
    } else {
      col.hasArmR = false;
    }
  }

  /**
   * Advances XPBD secondary physics and writes shortest-arc bone rotations back onto the skeleton.
   * Distance LOD automatically downgrades Tier-1 (`12–28 m`) to 30 Hz / 1 iter and skips Tier-2 (`> 28 m`).
   */
  update(dt: number, reduced: boolean, wind: SecondaryWind | null = null, distFromCam = 0): void {
    if (this.chains.length === 0 || dt <= 0) return;

    // Tier-2 distance LOD (> 28 m): zero CPU cost
    if (distFromCam > 28) return;

    // Reduced motion keeps clean animated rest pose
    if (reduced) {
      this.reset();
      return;
    }

    // Tier-1 midground LOD (12..28 m): 30 Hz staggered, 1 XPBD iter, head+chest colliders only
    const isTier0 = distFromCam <= 12;
    if (!isTier0) {
      this.tier1Skip = !this.tier1Skip;
      if (this.tier1Skip) {
        this.applyCurrentParticlesToBones();
        return;
      }
    }

    this.time += Math.min(0.05, dt);
    this.root.updateWorldMatrix(true, true);
    this.updateColliders(isTier0);

    const scale = this.root.getWorldScale(_v0).y || 1;
    const baseWindX = wind?.x ?? 0.55;
    const baseWindZ = wind?.z ?? 0.25;
    const gust = wind?.gust ?? 0.45;
    const gustWave =
      Math.sin(this.time * 2.1 + this.seed * 17.3) * 0.55 +
      Math.sin(this.time * 4.7 + this.seed * 9.1) * 0.45;
    const wx = baseWindX + baseWindX * gust * 0.45 * gustWave;
    const wz = baseWindZ + baseWindZ * gust * 0.45 * gustWave;

    this.accumulator = Math.min(this.accumulator + Math.min(0.05, dt), FIXED_DT * 2);
    let substeps = 0;
    const maxSubsteps = isTier0 ? 2 : 1;
    const iterations = isTier0 ? 2 : 1;

    while (this.accumulator >= FIXED_DT * 0.5 && substeps < maxSubsteps) {
      const h = isTier0 ? FIXED_DT : Math.min(0.034, this.accumulator);
      this.accumulator = Math.max(0, this.accumulator - h);
      substeps++;
      this.stepAllChains(h, iterations, wx, wz, scale, isTier0);
    }

    this.applyCurrentParticlesToBones();
  }

  private stepAllChains(
    h: number,
    iterations: number,
    windX: number,
    windZ: number,
    scale: number,
    fullBody: boolean,
  ): void {
    const h2 = h * h;
    const col = this.colliders;

    for (let c = 0; c < this.chains.length; c++) {
      const ch = this.chains[c];
      const rootBone = ch.bones[0];
      rootBone.getWorldPosition(_v0);

      if (!ch.seeded) {
        this.seedChain(ch);
        continue;
      }

      // Teleport clamp: if root anchor jumped > 1.2 m in a frame, snap cleanly without explosion
      const tdx = _v0.x - ch.pos[0];
      const tdy = _v0.y - ch.pos[1];
      const tdz = _v0.z - ch.pos[2];
      if (tdx * tdx + tdy * tdy + tdz * tdz > TELEPORT_DIST_SQ) {
        this.seedChain(ch);
        continue;
      }

      // Pin root particle 0 to bone[0]'s live world origin
      ch.pos[0] = ch.prev[0] = _v0.x;
      ch.pos[1] = ch.prev[1] = _v0.y;
      ch.pos[2] = ch.prev[2] = _v0.z;

      const damp = 1 - ch.drag;
      const gY = GRAVITY * ch.gravityScale;
      const pr = ch.particleRadius * scale;

      // 1. Symplectic Verlet prediction with gravity & aerodynamic wind drag
      for (let i = 1; i < ch.n; i++) {
        const o = i * 3;
        const px = ch.pos[o];
        const py = ch.pos[o + 1];
        const pz = ch.pos[o + 2];
        const vx = (px - ch.prev[o]) * damp;
        const vy = (py - ch.prev[o + 1]) * damp;
        const vz = (pz - ch.prev[o + 2]) * damp;

        ch.prev[o] = px;
        ch.prev[o + 1] = py;
        ch.prev[o + 2] = pz;

        // Flutter increases smoothly toward distal hair/scarf tips
        const tipWeight = i / (ch.n - 1);
        const flutter = Math.sin(this.time * 6.4 + i * 1.9 + this.seed * 23) * 0.28 * tipWeight;
        const ax = (windX + flutter) * ch.windGain * (0.45 + 0.55 * tipWeight);
        const az = (windZ - flutter * 0.7) * ch.windGain * (0.45 + 0.55 * tipWeight);

        ch.pos[o] = px + vx + ax * h2;
        ch.pos[o + 1] = py + vy + gY * h2;
        ch.pos[o + 2] = pz + vz + az * h2;
      }

      // Compute world-space animated rest direction for root segment (used for tether + cone clamp)
      const parentObj = rootBone.parent;
      if (parentObj) parentObj.getWorldQuaternion(_q0);
      else _q0.identity();
      const baseQ0 = this.baseQuats.get(rootBone);
      if (baseQ0) _q0.multiply(baseQ0);

      // 2. XPBD Gauss-Seidel constraint projection
      for (let iter = 0; iter < iterations; iter++) {
        let curQ = _q0;
        for (let i = 1; i < ch.n; i++) {
          const prevO = (i - 1) * 3;
          const o = i * 3;
          const len = ch.segLen[i - 1];

          // Animated rest target direction in world space for segment i-1
          if (i > 1) {
            const bPrev = ch.bones[i - 1];
            const bq = this.baseQuats.get(bPrev);
            if (bq && i - 1 < ch.bones.length) {
              curQ = _q1.copy(curQ).multiply(bq);
            }
          }
          const rIdx = (i - 1) * 3;
          _v2.set(ch.restDirLocal[rIdx], ch.restDirLocal[rIdx + 1], ch.restDirLocal[rIdx + 2]).applyQuaternion(curQ).normalize();

          // Soft rest-pose tether pulls particle gently toward hairstyle/scarf rest silhouette
          const stiff = ch.stiffness / iterations;
          const rx = ch.pos[prevO] + _v2.x * len;
          const ry = ch.pos[prevO + 1] + _v2.y * len;
          const rz = ch.pos[prevO + 2] + _v2.z * len;
          let px = ch.pos[o] + (rx - ch.pos[o]) * stiff;
          let py = ch.pos[o + 1] + (ry - ch.pos[o + 1]) * stiff;
          let pz = ch.pos[o + 2] + (rz - ch.pos[o + 2]) * stiff;

          // Max cone-angle clamp around rest direction prevents scalp/neck inversion
          let dx = px - ch.pos[prevO];
          let dy = py - ch.pos[prevO + 1];
          let dz = pz - ch.pos[prevO + 2];
          let d = Math.hypot(dx, dy, dz);
          if (d > 1e-6) {
            dx /= d;
            dy /= d;
            dz /= d;
            const dot = dx * _v2.x + dy * _v2.y + dz * _v2.z;
            if (dot < ch.cosMaxCone) {
              // Project onto cone boundary cleanly
              const pxPerp = dx - _v2.x * dot;
              const pyPerp = dy - _v2.y * dot;
              const pzPerp = dz - _v2.z * dot;
              const perpLen = Math.hypot(pxPerp, pyPerp, pzPerp);
              const sinCone = Math.sin(ch.maxConeRad);
              if (perpLen > 1e-6) {
                const s = sinCone / perpLen;
                dx = _v2.x * ch.cosMaxCone + pxPerp * s;
                dy = _v2.y * ch.cosMaxCone + pyPerp * s;
                dz = _v2.z * ch.cosMaxCone + pzPerp * s;
              } else {
                dx = _v2.x;
                dy = _v2.y;
                dz = _v2.z;
              }
            }
            // Inextensible distance constraint (compliance = 0)
            px = ch.pos[prevO] + dx * len;
            py = ch.pos[prevO + 1] + dy * len;
            pz = ch.pos[prevO + 2] + dz * len;
          } else {
            px = rx;
            py = ry;
            pz = rz;
          }

          // Analytical body collider push-out (head, collar, neck, chest, upper-back, backpack, left/right shoulders)
          if (col.head[3] > 0 && pushOutSphere(px, py, pz, pr, col.head, _v3)) {
            px = _v3.x;
            py = _v3.y;
            pz = _v3.z;
          }
          if (col.hasCollar && pushOutSphere(px, py, pz, pr, col.collar, _v3)) {
            px = _v3.x;
            py = _v3.y;
            pz = _v3.z;
          }
          if (col.hasNeck && pushOutCapsule(px, py, pz, pr, col.neck, _v3)) {
            px = _v3.x;
            py = _v3.y;
            pz = _v3.z;
          }
          if (col.hasChest && pushOutCapsule(px, py, pz, pr, col.chest, _v3)) {
            px = _v3.x;
            py = _v3.y;
            pz = _v3.z;
          }
          if (col.hasUpperBack && pushOutCapsule(px, py, pz, pr, col.upperBack, _v3)) {
            px = _v3.x;
            py = _v3.y;
            pz = _v3.z;
          }
          if (col.hasBackpack && pushOutSphere(px, py, pz, pr, col.backpack, _v3)) {
            px = _v3.x;
            py = _v3.y;
            pz = _v3.z;
          }
          if (fullBody) {
            if (col.hasArmL && pushOutCapsule(px, py, pz, pr, col.armL, _v3)) {
              px = _v3.x;
              py = _v3.y;
              pz = _v3.z;
            }
            if (col.hasArmR && pushOutCapsule(px, py, pz, pr, col.armR, _v3)) {
              px = _v3.x;
              py = _v3.y;
              pz = _v3.z;
            }
          }

          // Re-enforce exact segment length after collision push-out
          dx = px - ch.pos[prevO];
          dy = py - ch.pos[prevO + 1];
          dz = pz - ch.pos[prevO + 2];
          d = Math.hypot(dx, dy, dz);
          if (d > 1e-6) {
            const invD = len / d;
            ch.pos[o] = ch.pos[prevO] + dx * invD;
            ch.pos[o + 1] = ch.pos[prevO + 1] + dy * invD;
            ch.pos[o + 2] = ch.pos[prevO + 2] + dz * invD;
          }
        }
      }
    }
  }

  private applyCurrentParticlesToBones(): void {
    for (let c = 0; c < this.chains.length; c++) {
      const ch = this.chains[c];
      if (!ch.seeded) continue;
      const m = ch.bones.length;
      for (let i = 0; i < m; i++) {
        const bone = ch.bones[i];
        const parent = bone.parent;
        if (!parent) continue;
        const o0 = i * 3;
        const o1 = (i + 1) * 3;
        _v0.set(
          ch.pos[o1] - ch.pos[o0],
          ch.pos[o1 + 1] - ch.pos[o0 + 1],
          ch.pos[o1 + 2] - ch.pos[o0 + 2],
        );
        if (_v0.lengthSq() < 1e-8) continue;
        _v0.normalize();

        // Current bone world orientation from animated base pose
        parent.getWorldQuaternion(_q0);
        const baseQ = this.baseQuats.get(bone);
        if (baseQ) _q1.copy(_q0).multiply(baseQ);
        else _q1.copy(_q0).multiply(bone.quaternion);

        // Rest bone axis in world space under current parent orientation
        _v4.set(ch.restDirLocal[o0], ch.restDirLocal[o0 + 1], ch.restDirLocal[o0 + 2]).applyQuaternion(_q1).normalize();
        if (_v4.dot(_v0) < 0.999999) {
          _q2.setFromUnitVectors(_v4, _v0);
          // Desired world rotation = deltaSwing * animatedBaseWorldQ
          _q1.premultiply(_q2).normalize();
          // Convert back into parent-local quaternion
          bone.quaternion.copy(_q0).invert().multiply(_q1).normalize();
          bone.updateWorldMatrix(true, false);
        }
      }
    }
  }
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}
