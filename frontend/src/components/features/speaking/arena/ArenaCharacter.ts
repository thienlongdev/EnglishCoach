import * as T from 'three';
import {
  arenaSeatClip,
  computeArenaSeatedFootPlacement,
  type ArenaSeatedFootPlacement,
} from './arenaSeatClip';
import {
  ARENA_LOCOMOTION_SPEEDS,
  ARENA_PHOTO_CLIP_BY_POSE,
  buildArenaExtraClips,
  createArenaRigOverlayScratch,
  evaluateArenaRigOverlay,
  type ArenaRigOverlayScratch,
} from './arenaExtraClips';
import type {
  ArenaPhotoExpression,
  ArenaPhotoPose,
  ArenaSwimFrame,
  FishingPhase,
} from './arenaContracts';
import { GROUND_SEAT_ID } from './arenaInteractions';
import type { EmbodiedAction } from '@/lib/embodiment/actions';
import {
  HumanRig,
  type BodyFrame,
  type HandContact,
  type HandGesture,
  type LegTargets,
  type RestHand,
} from '@/lib/embodiment/human';
import { prepareCastMaterials } from '@/lib/embodiment/skin';
import { CastLook, type Mood } from '@/lib/embodiment/cast';
import { GAIT_SPEED } from '@/lib/embodiment/gait';
import { correctGaits } from '@/lib/embodiment/gaitClip';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { ArenaPlayer } from '@/types/speakingArena';
import { Wardrobe } from '@/lib/avatar/wardrobe';
import { decodeLook } from '@/lib/avatar/look';

const SCALE = 1.06;
const WORLD_UP = new T.Vector3(0, 1, 0);
const SHADOW_LOD_OFF_DIST = 48;
const SHADOW_LOD_ON_DIST = 45;
const LOOK_MORPH_LOD_DIST = 56;

const PHOTO_MOOD_BY_EXPR: Readonly<Record<ArenaPhotoExpression, Mood>> = {
  neutral: 'neutral',
  smile: 'smile',
  joy: 'joy',
  focused: 'focused',
  surprised: 'surprised',
};

const GESTURES: Partial<Record<EmbodiedAction, HandGesture>> = {
  wave: 'wave',
  clap: 'clap',
  cheer: 'cheer',
  listen: 'listen',
  inspect: 'inspect',
  dance: 'dance',
  jump: 'hop',
};
const FROM_SERVER: Record<string, HandGesture | undefined> = {
  OBSERVE: 'inspect',
  WAVE: 'wave',
  CHEER: 'cheer',
  LISTEN: 'listen',
  CLAP: 'clap',
  DANCE: 'dance',
};

export interface ArenaBoatRigPose {
  role: 'ROWER' | 'PASSENGER' | 'HELM';
  /** Each hand closed round its own oar or helm handle (stable objects: the finger fit is kept while the grip holds). */
  left?: HandContact;
  right?: HandContact;
  /** The stroke's torso lean, radians: forward while the drive pushes the handles away, back on the recovery. */
  torsoLean?: number;
  /** Normalized helm steering [-1, 1] when role === 'HELM'. */
  steering?: number;
  /** Optional seat cushion height above hull deck (m) for low-thwart/bench seated calibration. */
  seatHeightAboveDeck?: number;
  /** Optional live hull pitch/roll (radians) for dynamic wave counter-balance. */
  hullPitch?: number;
  hullRoll?: number;
}

export interface ArenaCharacterFishingState {
  phase: FishingPhase;
  tension: number;
  chargePower?: number;
  rodTipWorld?: T.Vector3;
  resolveContacts?: () => void;
}

export interface ArenaCharacterArchipelagoState {
  swim?: ArenaSwimFrame;
  fishing?: ArenaCharacterFishingState | null;
  shakingTree?: boolean;
  pickingUp?: boolean;
  climbingWater?: boolean;
  helmSteer?: boolean;
  sprinting?: boolean;
  groundSlope?: number;
  distanceToCamera?: number;
  /** Optional Photo Mode pose override (`Stand | Wave | Cheer | Think | Peace`). */
  photoPose?: ArenaPhotoPose | null;
  /** Optional Photo Mode FACS expression override (`Neutral | Smile | Joy | Focused | Surprised`). */
  photoExpression?: ArenaPhotoExpression | null;
  /** Optional real wall-clock dt (s) so Photo Mode poses & expressions animate smoothly even when `Time Frozen` (`dt = 0`). */
  photoLiveDt?: number;
  /** Optional world-space terrain/bridge/pier height query `(x, z) => y` driving HumanRig Foot IK & PelvisVerticalSpring. */
  groundAt?: (x: number, z: number) => number;
  /** Optional world-space surface height + normal query `(probe, outNormal) => y | null` for slope-aligned foot planting. */
  surfaceAt?: (probe: T.Vector3, outNormal: T.Vector3) => number | null;
  /** Optional seat height above floor/deck (m) for exact dynamic pelvis seatDrop & seated Foot IK across benches (0.53 m), tiers (0.45 m), & boats (0.31–0.50 m). */
  seatHeightAboveGround?: number;
}

type DistanceGaitName = 'Walk' | 'Jog' | 'Run' | 'Sprint';

interface ActionEntry {
  name: string;
  action: T.AnimationAction;
  duration: number;
  distanceDriven: boolean;
  footLeadOffset: number;
}

interface CachedHeroClipPack {
  clips: T.AnimationClip[];
  strideLength: Partial<Record<DistanceGaitName, number>>;
  leftFootForward: Partial<Record<DistanceGaitName, number>>;
  seatDrop: number;
  lowSeatDrop: number;
  groundSitDrop: number;
  hipsBindY: number;
  thighLenModel: number;
  shinLenModel: number;
  ankleBindModelY: number;
}

const heroClipPackCache = new WeakMap<readonly T.AnimationClip[], Map<string, CachedHeroClipPack>>();

/** The shared cast on the same one-skeleton rig as the study room; continuous 5-node phase-locked gaits, aquatic/action/photo clips, and zero-GC damped blends. */
export class ArenaCharacter {
  rig: HumanRig;
  /** One stride's length on the floor, model units at scale 1, per gait. */
  private strideLength: Partial<Record<DistanceGaitName, number>> = {};
  /** Normalized clip fraction [0, 1) where the left foot is furthest forward, calibrating 1:1 counter-phase arm swing. */
  private leftFootForward: Partial<Record<DistanceGaitName, number>> = {};
  /** Height of the eyes above the feet, measured from this skeleton. */
  eyeHeight = 1.6;
  private ownView = false;
  look: CastLook;
  /** Two-beat step phase (4π per full stride), used for footsteps and subtle vertical head-bob. */
  stridePhase = 0;
  /** True one-cycle locomotion gait phase (2π per full stride), synchronized 1:1 with leg cadence. */
  gaitPhase = 0;
  private runningState = false;
  private sprintingState = false;
  private hadBoatContacts = false;
  private holdingItem = false;
  private lastGestureAt = -1;
  private eye = new T.Vector3();
  private headBone: T.Bone | null = null;
  private readonly eyeInHead = new T.Vector3();
  root = new T.Group();
  model: T.Object3D;
  mixer: T.AnimationMixer;
  actions = new Map<string, T.AnimationAction>();
  weights = new Map<string, number>();
  private readonly targetWeights = new Map<string, number>();
  private readonly actionEntries: ActionEntry[] = [];
  materials: T.Material[] = [];
  locomotion = 'Idle';
  seatDrop = 0;
  lowSeatDrop = 0;
  groundSitDrop = 0.822;
  private hipsBindY = 0.895;
  private thighLenModel = 0.3853;
  private shinLenModel = 0.4116;
  private ankleBindModelY = 0.0988;
  get cameraHeight() {
    return this.eyeHeight + this.model.position.y;
  }
  private inAir = false;
  private lastYaw = 0;
  private vertical = 0;
  private landing = 0;

  // Athletic inertia, turn banking, slope & aquatic/action state
  private prevRawSpeed = 0;
  private smoothedAccel = 0;
  private peakRecentSpeed = 0;
  private stopSettle = 0;
  private yawRate = 0;
  private bankRoll = 0;
  private slopeGrade = 0;
  private pelvisPitchNow = 0;
  private waterClimbTimer = 0;
  private pickupTimer = 0;
  private treeShakeTimer = 0;
  private activeWaterMode: ArenaSwimFrame['mode'] = 'land';
  private hadGroundDynamics = false;
  private _activeGroundAt?: (x: number, z: number) => number;
  private readonly _groundAtAdapter = (probe: T.Vector3): number | null =>
    this._activeGroundAt ? this._activeGroundAt(probe.x, probe.z) : null;
  private readonly _emptyLoads: { at: T.Vector3; kg: number }[] = [];
  private readonly _dynamics: NonNullable<BodyFrame['dynamics']> = {
    stepping: false,
    gait: true,
    verticalGait: false,
    verticalGaitWeight: 0,
    mass: 56,
    loads: this._emptyLoads,
    groundAt: undefined,
    surfaceAt: undefined,
  };

  // Character shadow LOD tracking (> 48 m disables castShadow, saving ~100k shadow tris/peer)
  private readonly baseShadowMeshes: T.Mesh[] = [];
  private shadowsCast = true;
  private wardrobeAppliedSeq = 0;
  private syncedWardrobeSeq = 0;

  // Reusable zero-GC scratch structs for update()
  private readonly _passFwd = new T.Vector3();
  private readonly _passLeft = new T.Vector3();
  private readonly _seatHipTmp = new T.Vector3();
  private readonly _seatKneeTmp = new T.Vector3();
  private readonly _seatFootScale = new T.Vector3();
  private readonly _hullTiltQuat = new T.Quaternion();
  private readonly _hullTiltEuler = new T.Euler(0, 0, 0, 'YXZ');
  private readonly _seatPlacementScratch: ArenaSeatedFootPlacement = {
    seatHeightAboveDeck: 0.5275,
    pelvisPad: 0.04,
    drop: 0.381,
    ankleForwardM: 0.42,
    ankleLateralM: 0.125,
    kneeOutModel: 0.075,
    toeOutRad: 0.095,
  };
  private readonly _seatedLegTargets: LegTargets = {
    left: new T.Vector3(),
    right: new T.Vector3(),
    leftNormal: new T.Vector3(0, 1, 0),
    rightNormal: new T.Vector3(0, 1, 0),
    leftPole: new T.Vector3(),
    rightPole: new T.Vector3(),
    weight: 1,
  };
  private readonly _passLeftHand: RestHand = {
    wrist: new T.Vector3(),
    fingers: new T.Vector3(),
    palm: new T.Vector3(),
    curl: 0.34,
    grip: 'relaxed',
  };
  private readonly _passRightHand: RestHand = {
    wrist: new T.Vector3(),
    fingers: new T.Vector3(),
    palm: new T.Vector3(),
    curl: 0.34,
    grip: 'relaxed',
  };
  private readonly _passRest = { left: this._passLeftHand, right: this._passRightHand };
  private readonly _readyFlat = new T.Vector3();
  private readonly _readyFwd = new T.Vector3();
  private readonly _readyUp = new T.Vector3();
  private readonly _readyRight = new T.Vector3();
  private readonly _readyState: NonNullable<BodyFrame['ready']> = {
    forward: this._readyFwd,
    up: this._readyUp,
    right: this._readyRight,
    speed: 0,
    stride: 0,
    turn: 0,
    nod: 0,
  };
  private readonly _overlayScratch: ArenaRigOverlayScratch = createArenaRigOverlayScratch();
  private readonly _rigFrame: BodyFrame = {
    dt: 1 / 60,
    reduced: false,
    seated: false,
    own: false,
    eye: new T.Vector3(),
    lookYaw: 0,
    lookPitch: 0,
    moveYaw: 0,
    lean: 0,
    twist: 0,
    crouch: 0,
    trackArmSwing: false,
    rest: null,
    ready: null,
    freeFeet: false,
    clipFingerWeight: undefined,
    legTargets: null,
    resolveContacts: undefined,
  };
  private readonly _lookFrame = {
    dt: 1 / 60,
    reduced: false,
    mood: 'neutral' as Mood,
    speaking: false,
    lookYaw: undefined as number | undefined,
    lookPitch: undefined as number | undefined,
  };

  /** The same gesture on the same body, whoever is looking. Only what the protocol carries reaches the others. */
  express(action: EmbodiedAction) {
    const gesture = GESTURES[action];
    if (gesture) this.rig.play(gesture);
  }

  /** Imperatively trigger the pier-ladder / beach exit climb animation. */
  triggerWaterClimb(durationSeconds = 0.72) {
    this.waterClimbTimer = Math.max(this.waterClimbTimer, durationSeconds);
  }

  /** Imperatively trigger the smooth knee-squat fruit/item pickup animation. */
  triggerPickup(at?: T.Vector3 | null, durationSeconds = 0.78) {
    this.pickupTimer = Math.max(this.pickupTimer, durationSeconds);
    if (at) this.rig.play('reach', at);
  }

  /** Imperatively trigger the two-handed fruit tree trunk shake animation. */
  triggerTreeShake(durationSeconds = 0.9) {
    this.treeShakeTimer = Math.max(this.treeShakeTimer, durationSeconds);
  }

  get isSwimming() {
    return this.activeWaterMode === 'surface_swim' || this.activeWaterMode === 'underwater_dive';
  }

  get isSubmerged() {
    return this.activeWaterMode === 'underwater_dive';
  }

  /** Toggle character submesh shadow casting using distance hysteresis (off > 48 m, on < 45 m). */
  setShadowLodDistance(distanceToCamera?: number) {
    const wantShadows =
      distanceToCamera === undefined
        ? true
        : this.shadowsCast
          ? distanceToCamera <= SHADOW_LOD_OFF_DIST
          : distanceToCamera < SHADOW_LOD_ON_DIST;

    if (wantShadows === this.shadowsCast && this.syncedWardrobeSeq === this.wardrobeAppliedSeq) return;
    this.shadowsCast = wantShadows;
    this.syncedWardrobeSeq = this.wardrobeAppliedSeq;
    for (let i = 0; i < this.baseShadowMeshes.length; i++) {
      this.baseShadowMeshes[i].castShadow = wantShadows;
    }
    this.model.traverse(o => {
      const m = o as T.Mesh;
      if (!m.isMesh || m.name.startsWith('Cast_Eyes')) return;
      m.castShadow = wantShadows;
    });
  }

  /** The owner's eyes: everything of the body stays except the head that would be in the way. */
  setOwnView(on: boolean) {
    if (on === this.ownView) return;
    this.ownView = on;
    this.look.setOwnView(on);
    this.wardrobe.setOwnView(on);
  }

  /** Dressed by what the room says this player wears. Nothing is fetched until a garment other than the character's own is on someone. */
  private wearing = '';
  dress(hero: 'LYRA' | 'KAI', wire: string | null | undefined): Promise<void> {
    const code = wire ?? '';
    if (code === this.wearing) return Promise.resolve();
    this.wearing = code;
    const look = decodeLook(hero, code);
    if (code) this.look.setHairColor(look.colors.hair);
    return this.wardrobe
      .apply(look, {
        onExternalHair: (g: T.Object3D | null) => {
          (this.look as CastLook & { bindExternalHair?: (o: T.Object3D | null) => void }).bindExternalHair?.(g);
        },
        onBuiltinHairVisible: (v: boolean) => {
          (this.look as CastLook & { setBuiltinHairVisible?: (vis: boolean) => void }).setBuiltinHairVisible?.(v);
        },
      })
      .then(() => {
        this.wardrobeAppliedSeq++;
        this.rig.refreshFootSurfaces();
        if (!this.shadowsCast) this.setShadowLodDistance(SHADOW_LOD_OFF_DIST + 1);
      });
  }

  private lastLook = { yaw: 0, pitch: 0 };
  private stride = 0;
  private speed = 0;
  private elapsed = 0;
  private old = new T.Vector3();
  ring: T.Mesh<T.RingGeometry, T.MeshBasicMaterial>;
  private wardrobe: Wardrobe;

  constructor(template: GLTF, team: number, readonly hero: 'LYRA' | 'KAI' = 'LYRA') {
    this._dynamics.mass = hero === 'KAI' ? 68 : 55;
    this.model = clone(template.scene);
    this.model.scale.setScalar(SCALE);
    this.root.add(this.model);
    this.materials.push(...prepareCastMaterials(this.model));
    this.look = new CastLook(this.model, hero);
    this.materials.push(...this.look.materials);
    this.model.traverse(o => {
      const mesh = o as T.Mesh;
      if (!mesh.isMesh) return;
      const casts = !mesh.name.startsWith('Cast_Eyes');
      mesh.castShadow = casts;
      if (casts) this.baseShadowMeshes.push(mesh);
      mesh.frustumCulled = false;
      if (CastLook.owns(mesh)) return;
      if (mesh.name.includes('Hands')) {
        mesh.receiveShadow = true;
        return;
      }
      const material = (mesh.material as T.MeshStandardMaterial).clone();
      material.roughness = 0.65;
      material.metalness = 0.04;
      mesh.material = material;
      this.materials.push(material);
      if (mesh.name.startsWith('Cast_Scarf')) this.look.hideInOwnView(material);
    });
    this.wardrobe = new Wardrobe(this.model, hero);
    this.rig = new HumanRig(this.model, this.root);
    this.model.updateWorldMatrix(true, true);
    const eyes = this.look.eyeOffset();
    if (eyes) this.eyeHeight = eyes.y * SCALE;

    // Measure exact skeleton eye midpoint `(eye.L + eye.R) * 0.5` in `headBone` local space, plus leg bind ratios.
    const tmpPosA = new T.Vector3();
    const tmpPosB = new T.Vector3();
    const tmpPosC = new T.Vector3();
    let eyeBoneL: T.Bone | null = null;
    let eyeBoneR: T.Bone | null = null;
    let thighBoneL: T.Bone | null = null;
    let shinBoneL: T.Bone | null = null;
    let footBoneL: T.Bone | null = null;
    this.model.traverse(o => {
      if (!(o as T.Bone).isBone) return;
      const b = o as T.Bone;
      if (!this.headBone && /^head$/i.test(b.name)) this.headBone = b;
      else if (/^eye[._]?L$/i.test(b.name)) eyeBoneL = b;
      else if (/^eye[._]?R$/i.test(b.name)) eyeBoneR = b;
      else if (/^hips$/i.test(b.name)) {
        b.getWorldPosition(tmpPosA);
        if (tmpPosA.y > 0.4) this.hipsBindY = tmpPosA.y / SCALE;
      } else if (/^thigh[._]?L$/i.test(b.name)) thighBoneL = b;
      else if (/^shin[._]?L$/i.test(b.name)) shinBoneL = b;
      else if (/^foot[._]?L$/i.test(b.name)) footBoneL = b;
    });

    if (thighBoneL && shinBoneL && footBoneL) {
      (thighBoneL as T.Bone).getWorldPosition(tmpPosA);
      (shinBoneL as T.Bone).getWorldPosition(tmpPosB);
      (footBoneL as T.Bone).getWorldPosition(tmpPosC);
      this.thighLenModel = tmpPosA.distanceTo(tmpPosB) / SCALE;
      this.shinLenModel = tmpPosB.distanceTo(tmpPosC) / SCALE;
      this.ankleBindModelY = tmpPosC.y / SCALE;
    }

    if (this.headBone) {
      this.root.updateWorldMatrix(true, true);
      if (eyeBoneL && eyeBoneR) {
        (eyeBoneL as T.Bone).getWorldPosition(tmpPosA);
        (eyeBoneR as T.Bone).getWorldPosition(tmpPosB);
        this.eyeInHead.addVectors(tmpPosA, tmpPosB).multiplyScalar(0.5);
        this.eyeHeight = this.eyeInHead.y - this.root.position.y;
        // Advance 24 mm toward anterior cornea surface so 1P lens sits cleanly in front of eye sockets
        this.eyeInHead.z += 0.024 * SCALE;
        this.headBone.worldToLocal(this.eyeInHead);
      } else {
        this.headBone.worldToLocal(
          this.eyeInHead.set(0, this.eyeHeight, 0.055).applyMatrix4(this.root.matrixWorld),
        );
      }
    }

    this.mixer = new T.AnimationMixer(this.model);

    let perHeroMap = heroClipPackCache.get(template.animations);
    if (!perHeroMap) {
      perHeroMap = new Map<string, CachedHeroClipPack>();
      heroClipPackCache.set(template.animations, perHeroMap);
    }
    let pack = perHeroMap.get(hero);
    if (!pack) {
      const gaits = correctGaits(template.animations, this.model, this.rig.gaitSkeleton);
      const strideLength: Partial<Record<DistanceGaitName, number>> = {};
      const leftFootForward: Partial<Record<DistanceGaitName, number>> = {};
      for (const clip of gaits.clips) {
        if (clip.name === 'Walk' || clip.name === 'Run') {
          const v = gaits.speed[clip.name];
          if (v) strideLength[clip.name] = v * clip.duration;
        }
      }
      this.measureFootLeadInto(gaits.clips, ['Walk', 'Run'], leftFootForward);

      const idleClip = gaits.clips.find(c => c.name === 'Idle')!;
      const sit = arenaSeatClip(this.model, idleClip);
      const extra = buildArenaExtraClips(this.model, gaits.clips, leftFootForward);
      strideLength.Jog = extra.jogStrideLength;
      leftFootForward.Jog = extra.jogFootLead;
      strideLength.Sprint = extra.sprintStrideLength;
      leftFootForward.Sprint = extra.sprintFootLead;

      pack = {
        clips: [...extra.clips, sit.clip],
        strideLength,
        leftFootForward,
        seatDrop: sit.drop,
        lowSeatDrop: extra.lowSeatDrop,
        groundSitDrop: extra.groundSitDrop,
        hipsBindY: this.hipsBindY,
        thighLenModel: this.thighLenModel,
        shinLenModel: this.shinLenModel,
        ankleBindModelY: this.ankleBindModelY,
      };
      perHeroMap.set(hero, pack);
    }

    this.strideLength = { ...pack.strideLength };
    this.leftFootForward = { ...pack.leftFootForward };
    this.seatDrop = pack.seatDrop;
    this.lowSeatDrop = pack.lowSeatDrop;
    this.groundSitDrop = pack.groundSitDrop;

    const refFootLead = this.leftFootForward.Walk ?? 0;
    for (const clip of pack.clips) {
      const action = this.mixer.clipAction(clip);
      action.play();
      action.setEffectiveWeight(0);
      const distanceDriven =
        clip.name === 'Walk' ||
        clip.name === 'Jog' ||
        clip.name === 'Run' ||
        clip.name === 'Sprint';
      if (distanceDriven) action.timeScale = 0;
      const clipLead = distanceDriven
        ? (this.leftFootForward[clip.name as DistanceGaitName] ?? refFootLead)
        : 0;
      this.actions.set(clip.name, action);
      this.weights.set(clip.name, 0);
      this.actionEntries.push({
        name: clip.name,
        action,
        duration: clip.duration,
        distanceDriven,
        footLeadOffset: distanceDriven ? clipLead - refFootLead : 0,
      });
    }

    this.ring = new T.Mesh(
      new T.RingGeometry(0.43, 0.5, 32),
      new T.MeshBasicMaterial({
        color: team === 0 ? '#edaf9a' : '#80e6df',
        transparent: true,
        opacity: 0.75,
        side: T.DoubleSide,
        depthWrite: false,
      }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.045;
    this.root.add(this.ring);
  }

  private measureFootLeadInto(
    clips: readonly T.AnimationClip[],
    kinds: readonly DistanceGaitName[],
    out: Partial<Record<DistanceGaitName, number>>,
  ) {
    let left: T.Object3D | undefined;
    let right: T.Object3D | undefined;
    this.model.traverse(o => {
      if ((o as T.Bone).isBone) {
        if (/^foot[._]?L$/i.test(o.name)) left = o;
        else if (/^foot[._]?R$/i.test(o.name)) right = o;
      }
    });
    if (!left || !right) return;
    const lv = new T.Vector3();
    const rv = new T.Vector3();
    for (const kind of kinds) {
      const clip = clips.find(c => c.name === kind);
      if (!clip) continue;
      const action = this.mixer.clipAction(clip);
      action.play();
      action.setEffectiveWeight(1);
      const duration = clip.duration;
      let best = -Infinity;
      let bestAt = 0;
      for (let i = 0; i < 48; i++) {
        action.time = (duration * i) / 48;
        this.mixer.update(0);
        this.root.updateWorldMatrix(true, true);
        const lead =
          this.root.worldToLocal(left.getWorldPosition(lv)).z -
          this.root.worldToLocal(right.getWorldPosition(rv)).z;
        if (lead > best) {
          best = lead;
          bestAt = i / 48;
        }
      }
      action.stop();
      this.mixer.uncacheClip(clip);
      out[kind] = bestAt;
    }
    this.mixer.update(0);
  }

  /** The eyes of the body standing (or seated) upright, measured from the skeleton: steady, whatever the arms pull the trunk to. */
  stableEye(out: T.Vector3) {
    this.root.updateWorldMatrix(true, false);
    return out.set(0, this.eyeHeight + this.model.position.y, 0.02).applyMatrix4(this.root.matrixWorld);
  }

  /** Where the eyes are now, after the rig bent the trunk: a seated rower, runner, or underwater diver carries the camera with the head. */
  eyeWorld(out: T.Vector3) {
    if (!this.headBone) return out.copy(this.eye);
    this.headBone.updateWorldMatrix(true, false);
    return out.copy(this.eyeInHead).applyMatrix4(this.headBone.matrixWorld);
  }

  resetPosition() {
    this.old.copy(this.root.position);
    this.lastYaw = this.root.rotation.y;
    this.speed = 0;
    this.prevRawSpeed = 0;
    this.smoothedAccel = 0;
    this.peakRecentSpeed = 0;
    this.stopSettle = 0;
    this.yawRate = 0;
    this.bankRoll = 0;
    this.slopeGrade = 0;
    this.pelvisPitchNow = 0;
    this.runningState = false;
    this.sprintingState = false;
    this.hadGroundDynamics = false;
    this.rig.resetFootDynamics();
    this.model.rotation.set(0, 0, 0);
  }

  update(
    dt: number,
    p: Pick<ArenaPlayer, 'seat' | 'gestureAt' | 'gesture' | 'ready' | 'team' | 'online'>,
    speaking: boolean,
    finished: boolean,
    won: boolean,
    reduced: boolean,
    look?: { yaw: number; pitch: number; own: boolean },
    moveYaw = 0,
    airborne = false,
    boatPose?: ArenaBoatRigPose,
    holding: { left?: HandContact | null; right?: HandContact | null } | null = null,
    archipelagoState?: ArenaCharacterArchipelagoState,
  ) {
    const safeDt = Math.min(Math.max(dt, 0), 0.1);
    const liveDt = Math.min(
      Math.max(archipelagoState?.photoLiveDt ?? (safeDt > 1e-4 ? safeDt : 1 / 60), 1e-4),
      0.1,
    );
    const physicsDt = safeDt > 1e-4 ? safeDt : liveDt;
    this.elapsed += safeDt;

    this.setShadowLodDistance(archipelagoState?.distanceToCamera);

    const photoPose = archipelagoState?.photoPose ?? null;
    const isPhotoActive = photoPose !== null;
    const inBoat = !!boatPose;
    const isHelm = (inBoat && boatPose.role === 'HELM') || !!archipelagoState?.helmSteer;
    const isGroundSit = !inBoat && p.seat === GROUND_SEAT_ID;
    const isSeated = (!!p.seat || inBoat) && !isHelm && !isPhotoActive;
    if (inBoat || isHelm || isPhotoActive) airborne = false;

    const swim = !isSeated && !inBoat ? archipelagoState?.swim : undefined;
    const waterMode = swim?.mode ?? 'land';
    this.activeWaterMode = waterMode;
    const isSwimming = !isPhotoActive && (waterMode === 'surface_swim' || waterMode === 'underwater_dive');
    if (isSwimming) airborne = false;

    this.waterClimbTimer = Math.max(0, this.waterClimbTimer - safeDt);
    this.pickupTimer = Math.max(0, this.pickupTimer - safeDt);
    this.treeShakeTimer = Math.max(0, this.treeShakeTimer - safeDt);

    if (this.inAir && !airborne && !isSwimming && !isPhotoActive) this.landing = 0.24;
    this.landing = Math.max(0, this.landing - safeDt);
    this.vertical = this.root.position.y - this.old.y;
    const yawStep = Math.atan2(
      Math.sin(this.root.rotation.y - this.lastYaw),
      Math.cos(this.root.rotation.y - this.lastYaw),
    );
    this.lastYaw = this.root.rotation.y;
    this.inAir = airborne;

    if (!look && !isPhotoActive && p.gestureAt !== this.lastGestureAt) {
      this.lastGestureAt = p.gestureAt ?? 0;
      const g = FROM_SERVER[p.gesture];
      if (g) this.rig.play(g);
    }

    const distance =
      isSeated || isHelm || isPhotoActive
        ? 0
        : Math.hypot(this.old.x - this.root.position.x, this.old.z - this.root.position.z);
    this.old.copy(this.root.position);
    const instantSpeed =
      isSeated || isHelm || isPhotoActive || safeDt <= 1e-5
        ? 0
        : Math.min(6.2, distance / physicsDt);
    const rawAccel = T.MathUtils.clamp((instantSpeed - this.prevRawSpeed) / physicsDt, -18, 18);
    this.prevRawSpeed = instantSpeed;
    this.smoothedAccel += (rawAccel - this.smoothedAccel) * (1 - Math.exp(-physicsDt * 10));
    this.speed += (instantSpeed - this.speed) * (1 - Math.exp(-physicsDt * 14));

    // Track recent peak speed so stopping from a brisk run triggers a smooth planted stop-settle cushion.
    if (this.speed > this.peakRecentSpeed) {
      this.peakRecentSpeed = this.speed;
    } else {
      this.peakRecentSpeed *= Math.exp(-physicsDt * 2.6);
    }
    if (
      !isSeated &&
      !isHelm &&
      !airborne &&
      !isSwimming &&
      !isPhotoActive &&
      this.peakRecentSpeed > 2.1 &&
      instantSpeed < 0.2
    ) {
      this.stopSettle = Math.max(
        this.stopSettle,
        T.MathUtils.clamp(this.peakRecentSpeed / 3.8, 0.35, 1) * 0.28,
      );
      this.peakRecentSpeed = 0;
    }
    this.stopSettle = Math.max(0, this.stopSettle - safeDt);

    // Continuous 5-node speed continuum: Idle (0) <-> Walk (1.55) <-> Jog (2.45) <-> Run (3.35) <-> Sprint (4.45).
    const wadeDrag = waterMode === 'wading' ? 0.88 : 1;
    const vWalk = ARENA_LOCOMOTION_SPEEDS.Walk * wadeDrag;
    const vJog = ARENA_LOCOMOTION_SPEEDS.Jog * wadeDrag;
    const vRun = ARENA_LOCOMOTION_SPEEDS.Run * wadeDrag;
    const vSprint = ARENA_LOCOMOTION_SPEEDS.Sprint * wadeDrag;

    const walkLength = (this.strideLength.Walk ?? GAIT_SPEED.Walk * 1.125) * SCALE * wadeDrag;
    const jogLength = (this.strideLength.Jog ?? 1.85) * SCALE * wadeDrag;
    const runLength = (this.strideLength.Run ?? GAIT_SPEED.Run * 0.958) * SCALE * wadeDrag;
    const sprintLength = (this.strideLength.Sprint ?? 2.52) * SCALE;

    this.runningState = !isSeated && !isHelm && !isSwimming && (this.runningState ? this.speed > 1.95 : this.speed > 2.35);
    const wantSprint = archipelagoState?.sprinting ? this.speed > 3.55 : this.speed > 3.85;
    const keepSprint = archipelagoState?.sprinting ? this.speed > 3.25 : this.speed > 3.55;
    this.sprintingState = this.runningState && (this.sprintingState ? keepSprint : wantSprint);

    let wIdleLoco = 1;
    let wWalk = 0;
    let wJog = 0;
    let wRun = 0;
    let wSprint = 0;
    let clipLength = walkLength;

    if (this.speed <= vWalk) {
      wWalk = T.MathUtils.smoothstep(this.speed, 0.08, 1.32 * wadeDrag);
      wIdleLoco = 1 - wWalk;
      clipLength = walkLength * T.MathUtils.clamp(this.speed / Math.max(0.2, vWalk), 0.38, 1.0);
    } else if (this.speed <= vJog) {
      wJog = T.MathUtils.smoothstep(this.speed, vWalk, vJog);
      wWalk = 1 - wJog;
      wIdleLoco = 0;
      clipLength = T.MathUtils.lerp(walkLength, jogLength, wJog);
    } else if (this.speed <= vRun) {
      wRun = T.MathUtils.smoothstep(this.speed, vJog, vRun);
      wJog = 1 - wRun;
      wIdleLoco = 0;
      clipLength = T.MathUtils.lerp(jogLength, runLength, wRun);
    } else {
      wSprint = T.MathUtils.smoothstep(this.speed, vRun, vSprint);
      wRun = 1 - wSprint;
      wIdleLoco = 0;
      clipLength = T.MathUtils.lerp(runLength, sprintLength, wSprint);
    }

    // Uphill grade shortens effective stride slightly for realistic cadence.
    const uphillScale = 1 - 0.12 * Math.max(0, this.slopeGrade);
    const effectiveStrideLen = Math.max(0.32, clipLength * uphillScale);

    const rawYawRate = safeDt > 1e-5 ? T.MathUtils.clamp(yawStep / physicsDt, -7, 7) : 0;
    this.yawRate += (rawYawRate - this.yawRate) * (1 - Math.exp(-physicsDt * 11));

    const turning =
      !isSeated &&
      !isHelm &&
      !airborne &&
      !isSwimming &&
      !isPhotoActive &&
      this.speed <= 0.12 &&
      Math.abs(this.yawRate) > 0.35;

    if (!airborne && !isSeated && !isHelm && !isSwimming && !isPhotoActive && distance > 0) {
      this.stride = (this.stride + distance / effectiveStrideLen) % 1;
    } else if (!isPhotoActive && this.speed <= 0.08 && !turning) {
      // Gently relax idle foot phase toward neutral foot-passing (`0.25` / `0.75`) so stopping never freezes in a wide split
      const targetNeutral = Math.abs(this.stride - 0.25) < Math.abs(this.stride - 0.75) ? 0.25 : 0.75;
      this.stride += (targetNeutral - this.stride) * (1 - Math.exp(-physicsDt * 3.2));
    }

    const moving = !isSeated && !isHelm && !airborne && !isSwimming && !isPhotoActive && this.speed > 0.1;
    const swimSpeed = swim ? Math.max(this.speed, swim.strokeSpeed) : this.speed;
    const swimVertSpeed = Math.abs(swim?.verticalSpeed ?? (safeDt > 1e-4 ? this.vertical / physicsDt : 0));
    const fishing = !isSwimming && !isPhotoActive ? archipelagoState?.fishing : null;
    const social = finished ? (won ? 'Cheer' : 'Defeat') : 'Idle';

    this.targetWeights.clear();
    const setTarget = (name: string, val: number) => {
      if (val > 1e-4) this.targetWeights.set(name, val);
    };

    const seatH =
      !isGroundSit && isSeated
        ? (archipelagoState?.seatHeightAboveGround ?? boatPose?.seatHeightAboveDeck ?? 0.5275)
        : 0.5275;
    const lowSeatShare = !isGroundSit && isSeated ? 1 - T.MathUtils.smoothstep(seatH, 0.34, 0.49) : 0;

    let lead: string;
    if (isPhotoActive && photoPose) {
      lead = ARENA_PHOTO_CLIP_BY_POSE[photoPose];
      setTarget(lead, 1);
    } else if (isHelm) {
      lead = 'HelmSteer';
      setTarget('HelmSteer', 1);
    } else if (isGroundSit) {
      lead = 'GroundSit';
      setTarget('GroundSit', 1);
    } else if (isSeated) {
      lead = 'Sit';
      setTarget('Sit', 1 - lowSeatShare);
      setTarget('SitLow', lowSeatShare);
    } else if (this.waterClimbTimer > 0 || archipelagoState?.climbingWater) {
      lead = 'WaterClimb';
      setTarget('WaterClimb', 1);
    } else if (waterMode === 'underwater_dive') {
      const underwaterHover = !!swim?.isTreading || (swimSpeed < 0.32 && swimVertSpeed < 0.25);
      lead = underwaterHover ? 'SwimUnderwaterIdle' : 'SwimDive';
      setTarget(lead, 1);
    } else if (waterMode === 'surface_swim') {
      if (swim?.isTreading || swimSpeed < 0.28) {
        lead = 'SwimIdle';
        setTarget('SwimIdle', 1);
      } else {
        const wFree = archipelagoState?.sprinting
          ? T.MathUtils.smoothstep(swimSpeed, 1.35, 1.85)
          : T.MathUtils.smoothstep(swimSpeed, 1.65, 2.12);
        lead = wFree >= 0.5 ? 'SwimFreestyle' : 'SwimBreaststroke';
        setTarget('SwimBreaststroke', 1 - wFree);
        setTarget('SwimFreestyle', wFree);
      }
    } else if (fishing?.phase === 'casting') {
      lead = 'FishCast';
      setTarget('FishCast', 1);
    } else if (fishing?.phase === 'reeling' || fishing?.phase === 'bite_alert') {
      lead = 'FishReel';
      setTarget('FishReel', 1);
    } else if (fishing?.phase === 'caught') {
      lead = 'FishCatch';
      setTarget('FishCatch', 1);
    } else if (
      fishing &&
      (fishing.phase === 'equipped' || fishing.phase === 'charging' || fishing.phase === 'waiting_bite') &&
      !moving
    ) {
      lead = 'FishIdle';
      setTarget('FishIdle', 1);
    } else if (this.treeShakeTimer > 0 || archipelagoState?.shakingTree) {
      lead = 'TreeShake';
      setTarget('TreeShake', 1);
    } else if (this.pickupTimer > 0 || archipelagoState?.pickingUp) {
      lead = 'Pickup';
      setTarget('Pickup', 1);
    } else if (airborne) {
      lead = this.vertical >= 0 ? 'JumpUp' : 'JumpFall';
      setTarget(lead, 1);
    } else if (this.landing > 0) {
      lead = 'Land';
      setTarget('Land', 1);
    } else if (moving) {
      if (wSprint >= 0.45 || this.sprintingState) lead = 'Sprint';
      else if (wRun >= 0.45) lead = 'Run';
      else if (wJog >= 0.45) lead = 'Jog';
      else lead = 'Walk';
      setTarget(social, wIdleLoco);
      setTarget('Walk', wWalk);
      setTarget('Jog', wJog);
      setTarget('Run', wRun);
      setTarget('Sprint', wSprint);
    } else if (turning) {
      const turnClip = this.yawRate >= 0 ? 'TurnLeft' : 'TurnRight';
      const turnW = T.MathUtils.clamp(Math.abs(this.yawRate) / 2.2, 0.25, 0.78);
      lead = turnClip;
      setTarget(social, 1 - turnW);
      setTarget(turnClip, turnW);
    } else {
      lead = social;
      setTarget(social, 1);
    }

    if (
      lead !== this.locomotion &&
      (lead === 'JumpUp' ||
        lead === 'JumpFall' ||
        lead === 'Land' ||
        lead === 'WaterClimb' ||
        lead === 'FishCast' ||
        lead === 'FishCatch' ||
        lead === 'Pickup')
    ) {
      const action = this.actions.get(lead);
      if (action) {
        action.reset().setLoop(T.LoopOnce, 1);
        action.clampWhenFinished = true;
        action.play();
      }
    }
    this.locomotion = lead;

    // 4π per full stride (2 footsteps/bobs per stride); gaitPhase is 2π per full stride (1:1 counter-phase arm swing).
    this.stridePhase = this.stride * Math.PI * 4;
    const refFootLead = this.leftFootForward.Walk ?? 0;
    this.gaitPhase = (this.stride - refFootLead) * Math.PI * 2 + Math.PI / 2;

    const blendAlpha = 1 - Math.exp(-(isPhotoActive ? liveDt * 14 : physicsDt * 11));
    const treadCadence = 0.95 + Math.min(swimSpeed, 0.35) * 0.32;
    const breaststrokeCadence = T.MathUtils.clamp(0.78 + swimSpeed * 0.34, 0.72, 1.38);
    const freestyleCadence = T.MathUtils.clamp(0.76 + swimSpeed * 0.32, 0.75, 1.52);
    const diveCadence = T.MathUtils.clamp(
      0.74 + Math.hypot(swimSpeed, swimVertSpeed * 0.7) * 0.34,
      0.72,
      1.48,
    );
    const reelCadence = 0.85 + T.MathUtils.clamp(fishing?.tension ?? 0.4, 0, 1) * 0.75;
    const turnCadence = T.MathUtils.clamp(0.85 + Math.abs(this.yawRate) * 0.25, 0.8, 1.45);

    for (let i = 0; i < this.actionEntries.length; i++) {
      const entry = this.actionEntries[i];
      const currentW = this.weights.get(entry.name) ?? 0;
      const targetW = this.targetWeights.get(entry.name) ?? 0;
      const weight = Math.abs(targetW - currentW) < 1e-4 ? targetW : currentW + (targetW - currentW) * blendAlpha;
      this.weights.set(entry.name, weight);
      entry.action.setEffectiveWeight(weight);
      if (entry.distanceDriven) {
        const phaseU = (((this.stride + entry.footLeadOffset) % 1) + 1) % 1;
        entry.action.time = phaseU * entry.duration;
      } else if (entry.name === 'SwimIdle' || entry.name === 'SwimUnderwaterIdle') {
        entry.action.timeScale = treadCadence;
      } else if (entry.name === 'SwimBreaststroke') {
        entry.action.timeScale = breaststrokeCadence;
      } else if (entry.name === 'SwimFreestyle') {
        entry.action.timeScale = freestyleCadence;
      } else if (entry.name === 'SwimDive') {
        entry.action.timeScale = diveCadence;
      } else if (entry.name === 'FishReel') {
        entry.action.timeScale = reelCadence;
      } else if (entry.name === 'TurnLeft' || entry.name === 'TurnRight') {
        entry.action.timeScale = turnCadence;
      }
    }

    // Smooth spinal turn banking (`leanRoll` w/ 0.20 rad/s deadzone) & pelvis-COM underwater dive pitch — ZERO rigid root tilt!
    const deadzonedYawRate =
      Math.abs(this.yawRate) <= 0.2 ? 0 : this.yawRate - Math.sign(this.yawRate) * 0.2;
    const targetBank =
      !isSeated && !isHelm && !isPhotoActive && !reduced && (moving || isSwimming)
        ? T.MathUtils.clamp(
            -Math.atan2(Math.min(this.speed, 4.6) * deadzonedYawRate, 9.81) * 0.45,
            -0.12,
            0.12,
          )
        : 0;
    this.bankRoll += (targetBank - this.bankRoll) * (reduced ? 1 : 1 - Math.exp(-physicsDt * 9));

    const rawSlope =
      !isSeated && !isHelm && !airborne && !isSwimming && !isPhotoActive
        ? archipelagoState?.groundSlope !== undefined
          ? T.MathUtils.clamp(archipelagoState.groundSlope, -0.55, 0.55)
          : distance > 0.003
            ? T.MathUtils.clamp(this.vertical / distance, -0.45, 0.45)
            : 0
        : 0;
    this.slopeGrade += (rawSlope - this.slopeGrade) * (reduced ? 1 : 1 - Math.exp(-physicsDt * 8));

    const targetPelvisPitch =
      waterMode === 'underwater_dive' && lead === 'SwimDive'
        ? T.MathUtils.clamp(-(swim?.pitch ?? 0) * 0.55, -0.48, 0.48)
        : 0;
    this.pelvisPitchNow +=
      (targetPelvisPitch - this.pelvisPitchNow) * (reduced ? 1 : 1 - Math.exp(-physicsDt * 8));

    const seatPlacement = computeArenaSeatedFootPlacement(
      seatH,
      SCALE,
      this.hipsBindY,
      this.thighLenModel,
      this.shinLenModel,
      this.ankleBindModelY,
      undefined,
      this._seatPlacementScratch,
    );
    const sitCombinedWeight = (this.weights.get('Sit') ?? 0) + (this.weights.get('SitLow') ?? 0);
    const groundSitWeight = this.weights.get('GroundSit') ?? 0;
    this.model.position.y = -seatPlacement.drop * sitCombinedWeight - this.groundSitDrop * groundSitWeight;
    this.model.rotation.z = 0;
    this.model.rotation.x = 0;

    this.rig.restore();
    const mixerDt = isPhotoActive ? liveDt : reduced && lead === 'Idle' ? 0 : safeDt;
    this.mixer.update(mixerDt);
    this.rig.capture();
    this.root.updateWorldMatrix(true, false);
    this.eye.set(0, this.eyeHeight + this.model.position.y, 0.02).applyMatrix4(this.root.matrixWorld);
    this.setOwnView(!isPhotoActive && !!look?.own);

    // Held object, fishing rod two-hand contacts, or boat oar/helm handles.
    const hasHoldingContacts = !isPhotoActive && Boolean(holding && (holding.left || holding.right));
    if (hasHoldingContacts && holding) {
      this.rig.setContact(1, holding.right ?? null, 0.24);
      this.rig.setContact(-1, holding.left ?? null, 0.24);
      this.holdingItem = true;
      this.hadBoatContacts = false;
    } else if (
      !isPhotoActive &&
      boatPose &&
      (boatPose.role === 'ROWER' || boatPose.role === 'HELM') &&
      boatPose.left &&
      boatPose.right
    ) {
      this.rig.setContact(1, boatPose.right, 0.3);
      this.rig.setContact(-1, boatPose.left, 0.3);
      this.rig.holdFit(1);
      this.rig.holdFit(-1);
      this.hadBoatContacts = true;
      this.holdingItem = false;
    } else if (this.hadBoatContacts || this.holdingItem) {
      this.holdingItem = false;
      this.hadBoatContacts = false;
      this.rig.setContact(1, null, 0.22);
      this.rig.setContact(-1, null, 0.22);
    }

    let rest: BodyFrame['rest'] = null;
    let overlayLean = 0;
    let overlayTwist = 0;
    let overlayCrouch = 0;

    if (!isPhotoActive && !hasHoldingContacts && boatPose?.role === 'PASSENGER') {
      const yaw = this.root.rotation.y;
      this._passFwd.set(Math.sin(yaw), 0, Math.cos(yaw));
      this._passLeft.set(Math.cos(yaw), 0, -Math.sin(yaw));

      // Anchor passenger palms directly onto solved mid-thighs so low/high thwarts never leave wrists floating
      let placedOnThighs = false;
      if (this.rig.legs.length === 2) {
        const legL = this.rig.legs.find(l => l.side < 0);
        const legR = this.rig.legs.find(l => l.side > 0);
        if (legL && legR) {
          legL.thigh.getWorldPosition(this._seatHipTmp);
          legL.shin.getWorldPosition(this._seatKneeTmp);
          this._passLeftHand.wrist.lerpVectors(this._seatHipTmp, this._seatKneeTmp, 0.62);
          this._passLeftHand.wrist.y += 0.038 * SCALE;

          legR.thigh.getWorldPosition(this._seatHipTmp);
          legR.shin.getWorldPosition(this._seatKneeTmp);
          this._passRightHand.wrist.lerpVectors(this._seatHipTmp, this._seatKneeTmp, 0.62);
          this._passRightHand.wrist.y += 0.038 * SCALE;
          placedOnThighs = true;
        }
      }
      if (!placedOnThighs) {
        const thighY = seatH + 0.055 * SCALE;
        this._passLeftHand.wrist
          .copy(this.root.position)
          .addScaledVector(this._passLeft, 0.145 * SCALE)
          .addScaledVector(this._passFwd, 0.24 * SCALE)
          .addScaledVector(WORLD_UP, thighY);
        this._passRightHand.wrist
          .copy(this.root.position)
          .addScaledVector(this._passLeft, -0.145 * SCALE)
          .addScaledVector(this._passFwd, 0.24 * SCALE)
          .addScaledVector(WORLD_UP, thighY);
      }
      this._passLeftHand.fingers
        .copy(this._passFwd)
        .addScaledVector(this._passLeft, -0.28)
        .addScaledVector(WORLD_UP, -0.14);
      this._passLeftHand.palm
        .copy(WORLD_UP)
        .multiplyScalar(-1)
        .addScaledVector(this._passLeft, -0.15);

      this._passRightHand.fingers
        .copy(this._passFwd)
        .addScaledVector(this._passLeft, 0.28)
        .addScaledVector(WORLD_UP, -0.14);
      this._passRightHand.palm
        .copy(WORLD_UP)
        .multiplyScalar(-1)
        .addScaledVector(this._passLeft, 0.15);

      rest = this._passRest;
    } else if (!isPhotoActive && !this.hadBoatContacts && !isSwimming) {
      const ov = evaluateArenaRigOverlay(
        this._overlayScratch,
        this.root.position,
        this.root.rotation.y,
        SCALE,
        this.elapsed,
        lead,
        fishing,
        boatPose?.steering ?? 0,
      );
      rest = hasHoldingContacts ? null : ov.rest;
      overlayLean = ov.lean;
      overlayTwist = ov.twist;
      overlayCrouch = ov.crouch;
    }

    // Per 10-rules §CE & human.ts: `ready` drives first-person running arm swing ONLY (`!!look?.own`);
    // third-person running/sprinting uses our calibrated 75°–95° elbow skeletal clips directly without straight-arm override!
    let ready: BodyFrame['ready'] = null;
    if (!isPhotoActive && look?.own && !isSeated && !isSwimming && !hasHoldingContacts) {
      const yaw = this.root.rotation.y + look.yaw;
      const pitch = T.MathUtils.clamp(look.pitch, -0.95, 0.5);
      const cosPitch = Math.cos(pitch);
      const sinPitch = Math.sin(pitch);
      this._readyFlat.set(Math.sin(yaw), 0, Math.cos(yaw));
      this._readyFwd.copy(this._readyFlat).multiplyScalar(cosPitch).setY(sinPitch);
      this._readyUp.set(0, cosPitch, 0).addScaledVector(this._readyFlat, -sinPitch);
      this._readyRight.crossVectors(this._readyFlat, WORLD_UP);
      const turn =
        Math.atan2(Math.sin(yaw - this.lastLook.yaw), Math.cos(yaw - this.lastLook.yaw)) / physicsDt;
      const nod = (look.pitch - this.lastLook.pitch) / physicsDt;
      this._readyState.speed = this.speed;
      this._readyState.stride = this.gaitPhase;
      this._readyState.turn = turn;
      this._readyState.nod = nod;
      ready = this._readyState;
      this.lastLook.yaw = yaw;
      this.lastLook.pitch = look.pitch;
    }

    // Athletic acceleration/slope/braking lean + stop/landing cushion (without double-stacking baked clip lean).
    let locomotionLean = 0;
    let locomotionCrouch = 0;
    if (!isSeated && !isHelm && !isSwimming && !airborne && !isPhotoActive && !reduced) {
      const speedLean = T.MathUtils.smoothstep(this.speed, 0.8, 4.5) * 0.042;
      const accelLean = T.MathUtils.clamp(this.smoothedAccel * 0.014, -0.055, 0.08);
      const slopeLean = this.slopeGrade > 0 ? this.slopeGrade * 0.18 : this.slopeGrade * 0.08;
      const settlePulse = this.stopSettle > 0 ? Math.sin((this.stopSettle / 0.28) * Math.PI) : 0;
      const landingPulse = this.landing > 0 ? Math.sin((this.landing / 0.24) * Math.PI) : 0;
      locomotionLean = speedLean + accelLean + slopeLean - settlePulse * 0.035;
      locomotionCrouch =
        settlePulse * 0.068 +
        landingPulse * 0.11 +
        Math.abs(this.slopeGrade) * (moving ? 0.055 : 0) +
        (waterMode === 'wading' && moving ? 0.04 : 0);
    }

    const totalLean =
      boatPose?.role === 'ROWER' ? (boatPose.torsoLean ?? 0) : overlayLean + locomotionLean;
    const totalCrouch = isSwimming || isPhotoActive ? 0 : T.MathUtils.clamp(overlayCrouch + locomotionCrouch, 0, 0.35);

    const proneSwim =
      (waterMode === 'underwater_dive' && lead === 'SwimDive') ||
      (waterMode === 'surface_swim' && lead !== 'SwimIdle');
    const effLookYaw = proneSwim ? T.MathUtils.clamp(look?.yaw ?? 0, -0.65, 0.65) : (look?.yaw ?? 0);
    const effLookPitch = proneSwim ? T.MathUtils.clamp(look?.pitch ?? 0, -0.35, 0.45) : (look?.pitch ?? 0);

    // Zero-GC Analytic 2-Bone Foot IK & PelvisVerticalSpring on land / wading within 34 m of camera (`!inBoat && !isHelm`).
    const hasTerrainQuery = !!(archipelagoState?.surfaceAt || archipelagoState?.groundAt);
    const nearForFootIk = !!look?.own || (archipelagoState?.distanceToCamera ?? 0) <= 34;
    const wantGroundDynamics =
      !reduced &&
      !isSeated &&
      !inBoat &&
      !isHelm &&
      !isSwimming &&
      !airborne &&
      !isPhotoActive &&
      this.waterClimbTimer <= 0 &&
      !archipelagoState?.climbingWater &&
      nearForFootIk &&
      hasTerrainQuery;

    const rf = this._rigFrame;
    if (wantGroundDynamics) {
      this.hadGroundDynamics = true;
      this._activeGroundAt = archipelagoState?.groundAt;
      const vGaitW = T.MathUtils.smoothstep(this.speed, 1.4, 2.4);
      this._dynamics.stepping = moving || turning;
      this._dynamics.gait = !isHelm;
      this._dynamics.verticalGait = vGaitW > 0.5;
      this._dynamics.verticalGaitWeight = vGaitW;
      this._dynamics.groundAt = archipelagoState?.groundAt ? this._groundAtAdapter : undefined;
      this._dynamics.surfaceAt = isHelm ? undefined : archipelagoState?.surfaceAt;
      rf.dynamics = this._dynamics;
      rf.surfaceAt = isHelm ? undefined : archipelagoState?.surfaceAt;
      rf.pelvisSpringHz = isHelm ? undefined : 18;
      rf.verticalGaitWeight = vGaitW;
    } else {
      if (this.hadGroundDynamics) {
        this.hadGroundDynamics = false;
        this._activeGroundAt = undefined;
        this.rig.resetFootDynamics();
      }
      rf.dynamics = null;
      rf.surfaceAt = isPhotoActive ? archipelagoState?.surfaceAt : undefined;
      rf.pelvisSpringHz = undefined;
      rf.verticalGaitWeight = undefined;
    }

    // Closed-loop seated Foot IK (`Bench 0.53 m`, `Cruiser/Motor 0.495 m`, `Stone Tier 0.45 m`, `Skiff 0.353 m`, `Sampan 0.308 m`)
    let activeLegTargets: LegTargets | null = null;
    if (!isGroundSit && isSeated && sitCombinedWeight > 0.35 && this.rig.legs.length === 2) {
      const legL = this.rig.legs.find(l => l.side < 0);
      const legR = this.rig.legs.find(l => l.side > 0);
      if (legL && legR) {
        const yaw = this.root.rotation.y;
        this._passFwd.set(Math.sin(yaw), 0, Math.cos(yaw));
        this._passLeft.set(Math.cos(yaw), 0, -Math.sin(yaw));

        const hullPitch = inBoat ? (boatPose?.hullPitch ?? 0) : 0;
        const hullRoll = inBoat ? (boatPose?.hullRoll ?? 0) : 0;
        this._hullTiltEuler.set(hullPitch, yaw, hullRoll);
        this._hullTiltQuat.setFromEuler(this._hullTiltEuler);
        this._seatedLegTargets.leftNormal!.set(0, 1, 0).applyQuaternion(this._hullTiltQuat).normalize();
        this._seatedLegTargets.rightNormal!.copy(this._seatedLegTargets.leftNormal!);

        legL.foot.getWorldScale(this._seatFootScale);
        legL.foot.getWorldQuaternion(this._hullTiltQuat);
        const soleOffL = legL.sole.offsetY(this._hullTiltQuat, this._seatFootScale);
        legR.foot.getWorldQuaternion(this._hullTiltQuat);
        const soleOffR = legR.sole.offsetY(this._hullTiltQuat, this._seatFootScale);

        const lx =
          this.root.position.x +
          this._passLeft.x * seatPlacement.ankleLateralM +
          this._passFwd.x * seatPlacement.ankleForwardM;
        const lz =
          this.root.position.z +
          this._passLeft.z * seatPlacement.ankleLateralM +
          this._passFwd.z * seatPlacement.ankleForwardM;
        const rx =
          this.root.position.x -
          this._passLeft.x * seatPlacement.ankleLateralM +
          this._passFwd.x * seatPlacement.ankleForwardM;
        const rz =
          this.root.position.z -
          this._passLeft.z * seatPlacement.ankleLateralM +
          this._passFwd.z * seatPlacement.ankleForwardM;

        const deckYL = inBoat
          ? this.root.position.y - Math.sin(hullPitch) * seatPlacement.ankleForwardM
          : archipelagoState?.groundAt
            ? archipelagoState.groundAt(lx, lz)
            : this.root.position.y;
        const deckYR = inBoat
          ? this.root.position.y - Math.sin(hullPitch) * seatPlacement.ankleForwardM
          : archipelagoState?.groundAt
            ? archipelagoState.groundAt(rx, rz)
            : this.root.position.y;

        this._seatedLegTargets.left.set(lx, deckYL - soleOffL, lz);
        this._seatedLegTargets.right.set(rx, deckYR - soleOffR, rz);

        const lowPoleShare = 1 - T.MathUtils.smoothstep(seatH / SCALE, 0.29, 0.46);
        const poleUp = T.MathUtils.lerp(0.36, 0.08, lowPoleShare);
        const poleFwd = T.MathUtils.lerp(0.72, 0.42, lowPoleShare);

        legL.thigh.getWorldPosition(this._seatHipTmp);
        this._seatedLegTargets.leftPole!
          .copy(this._seatHipTmp)
          .addScaledVector(this._passLeft, seatPlacement.kneeOutModel)
          .addScaledVector(this._passFwd, poleFwd)
          .addScaledVector(WORLD_UP, poleUp);

        legR.thigh.getWorldPosition(this._seatHipTmp);
        this._seatedLegTargets.rightPole!
          .copy(this._seatHipTmp)
          .addScaledVector(this._passLeft, -seatPlacement.kneeOutModel)
          .addScaledVector(this._passFwd, poleFwd)
          .addScaledVector(WORLD_UP, poleUp);

        this._seatedLegTargets.weight = T.MathUtils.smoothstep(sitCombinedWeight, 0.35, 0.85);
        activeLegTargets = this._seatedLegTargets;
      }
    }

    const waveBalanceRoll = inBoat ? T.MathUtils.clamp(-(boatPose?.hullRoll ?? 0) * 0.45, -0.14, 0.14) : 0;
    const waveBalancePitch = inBoat ? T.MathUtils.clamp(-(boatPose?.hullPitch ?? 0) * 0.38, -0.14, 0.14) : 0;

    rf.dt = isPhotoActive ? liveDt : safeDt;
    rf.reduced = reduced;
    rf.seated = isSeated;
    rf.own = !isPhotoActive && !!look?.own;
    rf.eye.copy(this.eye);
    rf.lookYaw = isPhotoActive ? 0 : effLookYaw;
    rf.lookPitch = isPhotoActive ? 0 : effLookPitch;
    rf.moveYaw = isSeated || isHelm || isSwimming || isPhotoActive ? 0 : moveYaw;
    rf.lean = isPhotoActive ? 0 : totalLean;
    rf.leanRoll = isPhotoActive ? 0 : inBoat ? waveBalanceRoll : !isSeated && !isHelm ? this.bankRoll : 0;
    rf.leanPitch = isPhotoActive ? 0 : waveBalancePitch;
    rf.pelvisPitch = isPhotoActive ? 0 : this.pelvisPitchNow;
    rf.twist = isPhotoActive ? 0 : overlayTwist;
    rf.crouch = totalCrouch;
    rf.trackArmSwing = false;
    rf.rest = rest;
    rf.ready = ready;
    rf.freeFeet = isPhotoActive;
    rf.clipFingerWeight = isPhotoActive ? 1.0 : undefined;
    rf.legTargets = activeLegTargets;
    rf.resolveContacts = !isPhotoActive ? archipelagoState?.fishing?.resolveContacts : undefined;
    this.rig.update(rf);

    // Lightweight O(1) floor clearance guard when Foot IK is disabled (`reduced` Low tier / distant peer)
    // so multi-clip quaternion nlerp (`Walk <-> Jog`) or `moveYaw` hip rotation never dips soles below terrain.
    if (
      !wantGroundDynamics &&
      !isSeated &&
      !inBoat &&
      !isHelm &&
      !isSwimming &&
      !airborne &&
      !isPhotoActive &&
      this.rig.legs.length === 2
    ) {
      let maxPenetration = 0;
      for (let i = 0; i < this.rig.legs.length; i++) {
        const leg = this.rig.legs[i];
        leg.foot.getWorldPosition(this._seatHipTmp);
        leg.foot.getWorldQuaternion(this._hullTiltQuat);
        leg.foot.getWorldScale(this._seatFootScale);
        const soleY = this._seatHipTmp.y + leg.sole.offsetY(this._hullTiltQuat, this._seatFootScale);
        const gY = archipelagoState?.groundAt
          ? archipelagoState.groundAt(this._seatHipTmp.x, this._seatHipTmp.z)
          : this.root.position.y;
        if (gY - soleY > maxPenetration) maxPenetration = gY - soleY;
      }
      if (maxPenetration > 1e-4) {
        this.model.position.y += Math.min(maxPenetration, 0.06);
        this.model.updateWorldMatrix(false, true);
      }
    }

    const gesture = this.rig.currentGesture;
    const mood: Mood =
      isPhotoActive && archipelagoState?.photoExpression
        ? PHOTO_MOOD_BY_EXPR[archipelagoState.photoExpression]
        : finished
          ? won
            ? 'happy'
            : 'sad'
          : lead === 'FishCatch' || gesture === 'clap' || gesture === 'cheer' || gesture === 'dance'
            ? 'happy'
            : gesture === 'wave'
              ? 'smile'
              : gesture === 'listen'
                ? 'listen'
                : gesture === 'inspect' || lead === 'FishReel'
                  ? 'focus'
                  : speaking
                    ? 'smile'
                    : p.ready
                      ? 'smile'
                      : 'neutral';

    const distantPeer =
      !isPhotoActive &&
      !look?.own &&
      archipelagoState?.distanceToCamera !== undefined &&
      archipelagoState.distanceToCamera > LOOK_MORPH_LOD_DIST;
    const lf = this._lookFrame;
    lf.dt = isPhotoActive ? liveDt : safeDt;
    lf.reduced = !isPhotoActive && (reduced || distantPeer);
    lf.mood = mood;
    lf.speaking = !isPhotoActive && speaking;
    lf.lookYaw = isPhotoActive ? 0 : look?.yaw;
    lf.lookPitch = isPhotoActive ? 0 : look?.pitch;
    this.look.update(lf);

    this.ring.visible = !this.ownView && !inBoat && !isSwimming && !isPhotoActive;
    this.ring.material.color.set(p.team === 0 ? '#edaf9a' : '#80e6df');
    this.ring.material.opacity = speaking ? 0.95 : p.online ? 0.45 : 0.15;
    const scale = speaking && !reduced && !isPhotoActive ? 1 + Math.sin(this.elapsed * 5) * 0.08 : 1;
    this.ring.scale.setScalar(scale);
  }

  dispose() {
    this.wardrobe.dispose();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    this.materials.forEach(m => m.dispose());
    this.ring.geometry.dispose();
    this.ring.material.dispose();
  }
}
