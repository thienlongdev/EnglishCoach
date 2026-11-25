import * as T from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { embodiedKeys, type EmbodiedAction } from '@/lib/embodiment/actions';
import type { CameraConfig } from '@/lib/study-space/types';
import type { RoomNavigation } from '@/lib/study-space/navigation';
import { walkSlide } from '@/lib/study-space/exploration';
import type { Character } from './character';
import { reachEyeShift } from '@/lib/embodiment/human';
import { MouseLook, prefersFreePointer, rememberFreePointer } from '@/lib/embodiment/mouseLook';
import { actionForKey, loadKeymap, type Shortcut } from '@/lib/study-space/keymap';
import type { HousePlan } from '@/lib/echo-life/plan';
import type { CityPlan } from '@/lib/echo-life/city';
import {
  FixedStepLocomotionAccumulator,
  PlayerCollisionWorld,
  VerticalElevationSpring,
  sanitizePlayerPosition,
  shortestArcAngleDelta,
  type WorkshopFurnitureBox,
} from '@/lib/echo-life/playerCollision';
import {
  CAMERA_SPHERE_RADIUS,
  CameraEmbodimentRig,
  buildCameraBoxesFromPlan,
  observeCharacterOwnBodyMaterials,
  type AnalyticCameraBox,
} from './cameraRig';

export type CameraView = NonNullable<CameraConfig['view']>;
export interface ExplorationState {
  view: CameraView;
  locked: boolean;
  resume?: boolean;
  target: string | null;
  seated?: boolean;
  /** The player chose to keep the cursor: clicks act on what is under it instead of taking the mouse. */
  pointerMode?: boolean;
}

export type DialogueCameraTarget = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  eyeY?: number;
};

export interface DriveCarState {
  yaw: number;
  speed: number;
  maxSpeed?: number;
  steer?: number;
  pitch?: number;
  roll?: number;
  reversing?: boolean;
  isTwoWheeler?: boolean;
}

export interface FootSupportOut {
  y: number;
  nx: number;
  ny: number;
  nz: number;
  onStair: boolean;
}

const WALK_SPEED = 1.4;
const BRISK_SPEED = 1.95;
const RUN_SPEED = 2.9;
/** GTA-style asymmetric traction acceleration and deceleration bounds (m/s^2). */
const ACCEL_WALK = 5.4;
const ACCEL_RUN = 6.6;
const DECEL_WALK = 8.8;
const DECEL_RUN = 11.0;
const REVERSE_PLANT_DECEL = 11.2;
/** As far down as the eyes go: nearly straight down, so a thing standing at the toes can be looked at and taken. */
const LOOK_DOWN = -1.5;
const DIALOGUE_FOV = 46;
const DIALOGUE_FOV_FIRST = 65;
const DRIVE_BASE_FOV = 62;
const DRIVE_TOP_SPEED_FOV_BOOST = 6;
const BLOCKER_CACHE_TTL = 0.25;
const WALK_FROM_SCRATCH = new T.Vector3();
const WALK_DRIVE_SCRATCH = new T.Vector3();

interface Host {
  character: () => Character | null;
  navigation: () => RoomNavigation | null;
  blockers: () => T.Object3D[];
  enclosureVisRevision?: () => number;
  activate: (id: string) => void;
  inlineAction: (id: string) => boolean;
  /** Echo Life: E acts on the resident or game hotspot in focus (true: taken). `objectTarget` says a room thing is targeted too. */
  lifeInteract?: (objectTarget: boolean) => boolean;
  changed: (state: ExplorationState) => void;
  save: () => void;
  interacted: () => void;
  moved: () => void;
  command: (action: EmbodiedAction) => void;
  released: () => void;
  target: (camera: T.PerspectiveCamera) => string | null;
  /** The body is seated and the owner pressed a way to get up. */
  stand: () => void;
  /** A movement key while the body is in the middle of doing something: it stops what it was doing. */
  interrupt: () => void;
  /** The hands are busy with something the body has to finish, or walk up to. */
  occupied: () => boolean;
  /** Inspecting a held thing: the mouse turns the thing, not the head. */
  turning: (dx: number, dy: number) => boolean;
  /** E with a book open in the hand turns the page. */
  useHeld: () => boolean;
  /** What the hands are on, in world space: the eyes go there. */
  attention: (out: T.Vector3) => T.Vector3 | null;
  /** A mouse button on the world. */
  button: (button: number, down: boolean) => void;
  /** A cleaning tool is in the hands: a click on the room is a press of it, whether or not mouse-look is granted. */
  toolInHands?: () => boolean;
  /** True: the wheel was used for something in the hands. */
  wheel: (dy: number, shift: boolean) => boolean;
  /** What the legs may walk on right now: furniture in the hands has to fit there too. */
  walkable: () => Walkable | null;
  speedFactor: () => number;
  actorFits: (x: number, z: number, crouch: number) => boolean;
  shortcut: (action: Shortcut) => void;
  /** Furniture in the hands: the legs give the push its direction (stage axes, 0..1) and the body follows the furniture. True: taken. */
  driving?: () => boolean;
  driveCar?: (
    dt: number,
    throttle: number,
    turn: number,
    brake: boolean,
    extras?: { hornHeld?: boolean; handbrake?: boolean },
  ) => DriveCarState | undefined;
  /** Optional vehicle-only controls while driving (L headlights, H horn, [ / ] blinkers). */
  vehicleAction?: (action: 'headlights' | 'horn' | 'blinkerLeft' | 'blinkerRight') => void;
  steer?: (x: number, z: number, running: boolean) => boolean;
  /** The effort key held or let go. */
  effort?: (on: boolean) => void;
  /** Esc, or mouse-look given up by the player: whatever the hands strain at stops; what they carry stays. */
  cancelHands?: () => void;
  /** The body walked into something, this fast. */
  bumped?: (speed: number) => void;
  /** Q, E, Z with something in the hands. True: the key was for that. */
  turnKey?: (code: string, down: boolean, repeat: boolean) => boolean;
}

/**
 * What the legs may walk on. The study room's navigation answers `free` and `half` alone; the Echo Life walk
 * also provides house/city plans, height-banded clearance, and analytical stair/floor foot support.
 */
export type Walkable = Pick<RoomNavigation, 'free' | 'half'> & {
  clampCamera?: (local: T.Vector3, body: T.Vector3, passing: boolean) => unknown;
  groundAt?: (x: number, z: number) => number | null;
  path?: (from: { x: number; z: number }, to: { x: number; z: number }) => { x: number; z: number }[] | null;
  clearLine?: (a: { x: number; z: number }, b: { x: number; z: number }) => boolean;
  sampleFootSupport?: (
    x: number,
    z: number,
    stairTreadBlend?: number,
    out?: FootSupportOut,
    referenceY?: number,
  ) => FootSupportOut | null;
  surface?: (p: { x: number; z: number }) => { y: number; region: string } | null;
  house?: HousePlan;
  city?: CityPlan;
  furniture?: readonly WorkshopFurnitureBox[];
};

function smoothstep01(edge0: number, edge1: number, x: number): number {
  const t = T.MathUtils.clamp((x - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

const LOWER_LIMB_BONE_RE = /^(thigh|shin|foot|toe)[._]?[LR]$|^(Left|Right)(UpLeg|Leg|Foot|ToeBase)$/;

/** One perspective rig beside the retained editor camera, sharing its renderer and scene. */
export class Exploration {
  readonly camera = new T.PerspectiveCamera(62, 1, 0.055, 90);
  /** The field of view this rig wants; the engine adds the passage's own lens to it. */
  fovNow = 62;
  private lastProjectedFov = 62;
  private lastProjectedNear = 0.055;
  private lastProjectedAspect = 1;

  // Unified Phase 1/3B physics, elevation, collision, and post-IK camera embodiment controllers
  readonly locomotionAcc = new FixedStepLocomotionAccumulator();
  readonly elevationSpring = new VerticalElevationSpring();
  readonly cameraRig = new CameraEmbodimentRig('third', 2.15);

  /**
   * When set to `true` by Wave 4 `StudyWorld.frame()`, `update(dt, reduced)` runs input and locomotion ONLY,
   * deferring camera placement to `syncCameraPostIk(dt, reduced)` AFTER `updateBody()` and `updatePostIk()`
   * so the camera reads current-frame poses with zero 1-frame latency.
   * Defaults to `false` for 100% backward compatibility with callers invoking `update()` alone.
   */
  deferCameraToPostIk = false;

  /** Wobble-free character-root lean readouts (radians) ready for `BodyFrame.leanRoll` and `BodyFrame.leanPitch`. */
  leanRoll = 0;
  leanPitch = 0;
  /** True while executing a 180-degree GTA-style brake-plant-surge reversal. */
  isBrakingReverse = false;
  /** True if an own lower-limb bone entered the 0.35 m 1st-person near-plane guard bubble this frame. */
  ownLimbNearClipped = false;

  private injectedCollisionWorld: PlayerCollisionWorld | null = null;
  private autoCollisionWorld: PlayerCollisionWorld | null = null;
  private autoCollisionHouse: HousePlan | null = null;
  private autoCollisionRoom: RoomNavigation | null = null;
  private autoOpenDoorsSet = new Set<string>();
  private standaloneRoomHalf = -1;
  private locomotionSynced = false;
  private lastCommittedRoot = new T.Vector3();
  private worldVel = new T.Vector2();
  private prevSpeed = 0;
  private brakePlantTimer = 0;
  private lastBodyYaw = 0;
  private bodyYawInitialized = false;
  private filteredYawRate = 0;

  private patchedModelUuid = '';
  private cachedLimbBones: T.Object3D[] = [];
  private readonly cachedLimbPoints: T.Vector3[] = [
    new T.Vector3(),
    new T.Vector3(),
    new T.Vector3(),
    new T.Vector3(),
    new T.Vector3(),
    new T.Vector3(),
    new T.Vector3(),
    new T.Vector3(),
  ];
  private activeLimbPointList: T.Vector3[] = [];
  private readonly footSampleScratch: FootSupportOut = { y: 0, nx: 0, ny: 1, nz: 0, onStair: false };
  private lastReduced = false;
  private lastDriving = false;

  /** Up close to a screen: the eyes go to where the screen fills the view, and come back to where they were. */
  private device: {
    center: T.Vector3;
    right: T.Vector3;
    up: T.Vector3;
    normal: T.Vector3;
    w: number;
    h: number;
    k: number;
    dir: 1 | -1;
    to: T.Vector3;
    q: T.Quaternion;
  } | null = null;
  /** 0 in the room, 1 with the screen filling the view. */
  get deviceLevel() {
    const k = this.device?.k ?? 0;
    return k * k * k * (k * (k * 6 - 15) + 10);
  }
  get deviceBack() {
    return !!this.device && this.device.dir < 0;
  }
  /** The screen's rectangle in the world, which way it faces, how big. */
  enterDevice(center: T.Vector3, right: T.Vector3, up: T.Vector3, normal: T.Vector3, w: number, h: number) {
    this.device = {
      center: center.clone(),
      right: right.clone(),
      up: up.clone(),
      normal: normal.clone(),
      w,
      h,
      k: this.device?.k ?? 0,
      dir: 1,
      to: new T.Vector3(),
      q: new T.Quaternion(),
    };
  }
  leaveDevice() {
    if (this.device) this.device.dir = -1;
  }
  /** Where the screen is on the page, in CSS pixels, once the eyes are there. */
  deviceRect(width: number, height: number) {
    const d = this.device;
    if (!d) return null;
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([x, y]) =>
      d.center
        .clone()
        .addScaledVector(d.right, (x * d.w) / 2)
        .addScaledVector(d.up, (y * d.h) / 2)
        .project(this.camera),
    );
    const xs = corners.map((c) => ((c.x + 1) / 2) * width);
    const ys = corners.map((c) => ((1 - c.y) / 2) * height);
    return {
      left: Math.min(...xs),
      top: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  }

  /** Cinematic over-the-shoulder / two-shot dialogue camera target (frames speaker above lower-third box). */
  private dialogueTarget: DialogueCameraTarget | null = null;
  private lastDialogueTarget: DialogueCameraTarget | null = null;
  private dialogueBlend = 0;
  private dialogueFocusBlend = 0;

  setDialogueCamera(target: DialogueCameraTarget | null) {
    this.dialogueTarget = target ? { ...target } : null;
    if (target) this.lastDialogueTarget = { ...target };
  }

  get dialogueCameraActive() {
    return !!this.dialogueTarget || this.dialogueBlend > 0.015;
  }

  view: CameraView = 'overview';
  yaw = Math.PI;
  pitch = 0;
  private yawNow = Math.PI;
  private pitchNow = 0;
  private keys = new Set<string>();
  crouchAmount = 0;
  private crouchHeld = false;
  private touch = new T.Vector2();
  private touchButtons = new Map<number, { x: number; y: number }>();
  private velocity = new T.Vector2();
  private drag: { id: number; x: number; y: number } | null = null;
  private blocked = false;
  private moving = false;
  private targetId: string | null = null;
  private lastState = '';
  private initialized = false;
  /** A seat restored from the saved layout keeps the saved look instead of turning to the front. */
  private restoredSeat = false;
  /** What the player asked for, what the browser holds, and what needs a cursor: `lib/embodiment/mouseLook.ts`. */
  readonly mouseLook: MouseLook;
  private disposed = false;

  // Pre-allocated raycast and blocker cache (zero per-frame scene-graph allocations)
  private blockerMeshes: T.Mesh[] = [];
  private blockerRootSig = '';
  private blockerCacheAge = BLOCKER_CACHE_TTL;

  // Reusable per-frame scratch math objects (zero hot-loop heap churn)
  private up = new T.Vector3(0, 1, 0);
  private tmpForward = new T.Vector3();
  private tmpFlatForward = new T.Vector3();
  private tmpSide = new T.Vector3();
  private tmpPivot = new T.Vector3();
  private tmpDesired = new T.Vector3();
  private tmpLocal = new T.Vector3();
  private tmpSafe = new T.Vector3();
  private tmpLook = new T.Vector3();
  private tmpDir = new T.Vector3();
  private tmpEye = new T.Vector3();
  private tmpEyeStagePos = new T.Vector3();
  private tmpFrom = new T.Vector3();
  private wasSeatedOrRising = false;
  private tmpDrivePos = new T.Vector3();
  private tmpRawInput = new T.Vector2();
  private tmpMoveInput = new T.Vector2();
  private tmpMat = new T.Matrix4();
  private tmpQuat = new T.Quaternion();
  private tmpDlgPivot = new T.Vector3();
  private tmpDlgPos = new T.Vector3();
  private tmpDlgLocal = new T.Vector3();
  private tmpDlgSafe = new T.Vector3();
  private tmpDlgLook = new T.Vector3();
  private tmpDlgQuat = new T.Quaternion();

  private wasLocked = false;
  private seatedFrame: string | null = null;
  private pressAt: { x: number; y: number } | null = null;
  private bob = 0;
  private passage: { to: T.Vector3; elapsed: number; seconds: number; from: T.Vector3 } | null = null;
  /** Walking through a doorway: the room's edge is not the edge any more. */
  private passing = false;
  private zoom = false;
  /** Where the eyes aim: the middle of the view under mouse-look, the pointer without it. */
  readonly aim = new T.Vector2();
  private pointerAim = new T.Vector2();
  private pointerInside = false;
  private keymap = loadKeymap();
  private route: { key: string; points: { x: number; z: number }[]; bestDistance: number } | null = null;
  /** Metres per second actually travelled this frame: what the arms and the camera move by. */
  speed = 0;

  // Vehicles 2.0 driving camera dynamics
  private vehicleHeading: number | null = null;
  private orbitHold = 0;
  private driveCam: 'chase' | 'hood' | 'cockpit' = 'chase';
  private driveSpeedRatio = 0;
  private driveLookAhead = 0;
  private driveReverseHold = 0;
  private origStageAdd: T.Group['add'] | null = null;
  private observedCharRoot: T.Object3D | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private stage: T.Group,
    private host: Host,
  ) {
    // Hook `stage.add` so `Character.load()` and `Wardrobe.dress()` attach `:ec-1p-limb-guard-v1`
    // synchronously at mesh/material mount time — strictly before `runPreEntryWarmup` (`0` post-warmup recompiles).
    const origAdd = stage.add;
    this.origStageAdd = origAdd;
    stage.add = (...children: T.Object3D[]) => {
      const res = origAdd.apply(stage, children);
      const chNow = this.host.character();
      if (chNow) {
        for (let i = 0; i < children.length; i++) {
          if (children[i] === chNow.root) {
            this.prepareCharacterMaterials(chNow);
          }
        }
      }
      return res;
    };
    const initialChar = this.host.character();
    if (initialChar) this.prepareCharacterMaterials(initialChar);

    this.mouseLook = new MouseLook(canvas, (state) => {
      if (this.wasLocked && !state.locked) this.crouchHeld = false;
      if (!state.locked) {
        this.keys.clear();
        this.velocity.set(0, 0);
        this.worldVel.set(0, 0);
        if (this.wasLocked && !this.blocked && !this.reading) this.host.cancelHands?.();
      }
      this.wasLocked = state.locked;
      this.notify();
    });
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', this.release);
    document.addEventListener('visibilitychange', this.visibility);
    document.addEventListener('mousemove', this.mouse);
    canvas.addEventListener('pointerdown', this.pointerDown);
    canvas.addEventListener('mousedown', this.mouseDown);
    document.addEventListener('mouseup', this.mouseUp);
    canvas.addEventListener('auxclick', this.noMenu);
    canvas.addEventListener('pointermove', this.pointerMove);
    canvas.addEventListener('pointerup', this.pointerUp);
    canvas.addEventListener('pointercancel', this.pointerUp);
    canvas.addEventListener('lostpointercapture', this.pointerUp);
    canvas.addEventListener('pointerleave', this.pointerLeave);
    canvas.addEventListener('contextmenu', this.noMenu);
    canvas.addEventListener('wheel', this.wheel, { passive: false });
  }

  /** Optional explicit injection hook for Wave 4 `EchoLifeWorld` shared collision registry. */
  setCollisionWorld(world: PlayerCollisionWorld | null): void {
    this.injectedCollisionWorld = world;
    if (world) {
      this.cameraRig.setAnalyticBoxes(buildCameraBoxesFromPlan(world.house, world.city));
    }
  }

  get collisionWorld(): PlayerCollisionWorld | null {
    return this.injectedCollisionWorld ?? this.autoCollisionWorld;
  }

  setDeferCameraToPostIk(on: boolean): void {
    this.deferCameraToPostIk = on;
  }

  /**
   * Idempotently arms pre-warmup `:ec-1p-limb-guard-v1` attachment on eligible lower-body/torso character
   * meshes (`Hands`, forearms, head, face, hair, eyes, and eyewear strictly excluded).
   */
  prepareCharacterMaterials(ch: Character | null = this.host.character()): void {
    if (!ch?.root) return;
    if (this.observedCharRoot !== ch.root) {
      this.observedCharRoot = ch.root;
      this.patchedModelUuid = '';
    }
    observeCharacterOwnBodyMaterials(ch.root, this.cameraRig.ownLimbUniforms, () => {
      this.patchedModelUuid = '';
    });
  }

  /** Immediately disables the 1st-person torso/limb near-clip shader uniform (`0` shader recompiles). */
  clearOwnLimbGuard(): void {
    this.cameraRig.clearOwnLimbGuard();
    this.ownLimbNearClipped = false;
  }

  /** Restores the 1st-person torso/limb near-clip uniform after an offscreen reflection/capture pass. */
  restoreOwnLimbGuard(): void {
    this.cameraRig.restoreOwnLimbGuard();
  }

  /**
   * Zero-allocation foot support height and surface normal sampler for `BodyFrame.surfaceAt`.
   * Blends smoothly from continuous stair ramp (`speed >= 0.32 m/s` -> `0` step-riser pops)
   * to centered horizontal stair treads (`speed <= 0.04 m/s`) when stopped, rejecting cross-storey `|y - referenceY| > 0.55`.
   */
  sampleFootSupport(stageX: number, stageZ: number, outNormal?: T.Vector3, referenceY?: number): number {
    const ch = this.host.character();
    const refY = referenceY ?? ch?.root.position.y;
    const nav = this.host.walkable();
    if (nav?.sampleFootSupport) {
      const treadBlend = 1 - smoothstep01(0.04, 0.32, this.speed);
      const hit = nav.sampleFootSupport(stageX, stageZ, treadBlend, this.footSampleScratch, refY);
      if (hit && (refY === undefined || Math.abs(hit.y - refY) <= 0.55)) {
        outNormal?.set(hit.nx, hit.ny, hit.nz);
        return hit.y;
      }
    }
    outNormal?.set(0, 1, 0);
    const groundY = nav?.groundAt?.(stageX, stageZ);
    if (groundY !== null && groundY !== undefined && (refY === undefined || Math.abs(groundY - refY) <= 0.55)) {
      return groundY;
    }
    return refY ?? 0;
  }

  private resolveGroundedFloorY(
    ch: Character,
    nav: Walkable,
    x: number,
    z: number,
    currentY: number,
  ): number {
    if (nav.sampleFootSupport) {
      const hit = nav.sampleFootSupport(x, z, 1, this.footSampleScratch, currentY);
      if (hit && Math.abs(hit.y - currentY) <= 0.55) return hit.y;
    }
    const baseFloor = ch.floorY(x, z);
    if (Number.isFinite(baseFloor)) {
      if (nav.sampleFootSupport) {
        const hitBase = nav.sampleFootSupport(x, z, 1, this.footSampleScratch, baseFloor);
        if (hitBase && Math.abs(hitBase.y - baseFloor) <= 0.55) return hitBase.y;
      }
      return baseFloor;
    }
    const g = nav.groundAt?.(x, z);
    return g !== null && g !== undefined && Number.isFinite(g) ? g : currentY;
  }

  /**
   * Sanitizes the player's root position out of penetrated walls, furniture gaps, or sealed pockets
   * on load, spawn, stand-up, or vehicle dismount, snapping locomotion and vertical springs cleanly.
   */
  sanitizeCharacterRoot(fallback?: { x: number; z: number }): boolean {
    const ch = this.host.character();
    const nav = this.host.walkable();
    if (!ch?.ready || !nav) return false;
    const cw = this.resolveCollisionWorld(nav);

    this.refreshAutoOpenDoors(nav);
    let sanitized = false;
    if (cw) {
      const res = sanitizePlayerPosition(cw, ch.root.position, {
        referenceY: ch.root.position.y,
        fallback,
      });
      if (res.sanitized) {
        ch.root.position.set(res.x, res.y, res.z);
        sanitized = true;
      }
    }
    if (
      !ch.body.seat &&
      !ch.isDismountingSeat &&
      ch.posture !== 'rising' &&
      ch.publicPosture !== 'airborne'
    ) {
      const floorY = this.resolveGroundedFloorY(ch, nav, ch.root.position.x, ch.root.position.z, ch.root.position.y);
      if (Math.abs(ch.root.position.y - floorY) > 1e-4) {
        ch.root.position.y = floorY;
        ch.rig?.resetFootDynamics();
      }
    }
    this.locomotionAcc.snap(ch.root.position.x, ch.root.position.y, ch.root.position.z, ch.root.rotation.y);
    this.elevationSpring.reset(ch.root.position.y);
    this.lastCommittedRoot.copy(ch.root.position);
    return sanitized;
  }

  private resolveCollisionWorld(nav: Walkable): PlayerCollisionWorld | null {
    if (this.injectedCollisionWorld) {
      const room = this.host.navigation();
      this.injectedCollisionWorld.setRoomNavigation(room);
      if (nav.furniture) this.injectedCollisionWorld.setWorkshopFurniture(nav.furniture);
      return this.injectedCollisionWorld;
    }
    if (!nav.house || !nav.city) {
      // Standalone Study Room: index simple 4-wall + ceiling analytic camera box once per room size.
      const fullHalf = nav.half + 0.2;
      if (Math.abs(fullHalf - this.standaloneRoomHalf) > 1e-3) {
        this.standaloneRoomHalf = fullHalf;
        const boxes: AnalyticCameraBox[] = [
          { id: 'sr:wx+', cx: fullHalf + 0.08, cy: 1.5, cz: 0, hx: 0.08, hy: 1.5, hz: fullHalf, rotY: 0 },
          { id: 'sr:wx-', cx: -fullHalf - 0.08, cy: 1.5, cz: 0, hx: 0.08, hy: 1.5, hz: fullHalf, rotY: 0 },
          { id: 'sr:wz+', cx: 0, cy: 1.5, cz: fullHalf + 0.08, hx: fullHalf, hy: 1.5, hz: 0.08, rotY: 0 },
          { id: 'sr:wz-', cx: 0, cy: 1.5, cz: -fullHalf - 0.08, hx: fullHalf, hy: 1.5, hz: 0.08, rotY: 0 },
          { id: 'sr:ceil', cx: 0, cy: 3.08, cz: 0, hx: fullHalf, hy: 0.08, hz: fullHalf, rotY: 0 },
          { id: 'sr:flr', cx: 0, cy: -0.08, cz: 0, hx: fullHalf, hy: 0.08, hz: fullHalf, rotY: 0 },
        ];
        this.cameraRig.setAnalyticBoxes(boxes);
      }
      return null;
    }

    const room = this.host.navigation();
    if (!this.autoCollisionWorld || this.autoCollisionHouse !== nav.house) {
      this.autoCollisionHouse = nav.house;
      this.autoCollisionRoom = room;
      this.autoCollisionWorld = new PlayerCollisionWorld({
        house: nav.house,
        city: nav.city,
        room,
        openDoors: () => this.autoOpenDoorsSet,
      });
      this.cameraRig.setAnalyticBoxes(buildCameraBoxesFromPlan(nav.house, nav.city));
    } else if (this.autoCollisionRoom !== room) {
      this.autoCollisionRoom = room;
      this.autoCollisionWorld.setRoomNavigation(room);
    }
    if (nav.furniture) {
      this.autoCollisionWorld.setWorkshopFurniture(nav.furniture);
    }
    return this.autoCollisionWorld;
  }

  private refreshAutoOpenDoors(nav: Walkable): void {
    if (this.injectedCollisionWorld || !nav.house || !nav.city || !nav.surface) return;
    this.autoOpenDoorsSet.clear();
    const check = (id: string, x: number, z: number) => {
      const s = nav.surface!({ x, z });
      if (s && s.region.startsWith('door:')) this.autoOpenDoorsSet.add(id);
    };
    for (let i = 0; i < nav.house.doors.length; i++) {
      const d = nav.house.doors[i];
      check(d.id, d.x, d.z);
    }
    for (let i = 0; i < nav.city.buildings.length; i++) {
      const d = nav.city.buildings[i].door;
      check(d.id, d.x, d.z);
    }
    const ownedIds: string[] = [];
    for (let i = 0; i < nav.city.residences.length; i++) {
      const r = nav.city.residences[i];
      const d = r.door;
      check(d.id, d.x, d.z);
      if (r.property && nav.surface(r.entryPoint)) {
        ownedIds.push(r.property.id);
      }
    }
    this.autoCollisionWorld?.setOwnedHomes(ownedIds);
  }

  get isMoving() {
    return this.moving;
  }
  /** Where the eyes look right now: the same numbers the camera used this frame. */
  get lookYaw() {
    return this.yawNow;
  }
  get lookPitch() {
    return this.pitchNow;
  }
  /** The way the eyes look, horizontal, in world space. */
  lookFlat(out: T.Vector3) {
    return out.set(-Math.sin(this.yawNow), 0, -Math.cos(this.yawNow));
  }

  private syncProjection(force = false) {
    const fovChanged = Math.abs(this.camera.fov - this.lastProjectedFov) > 0.01;
    const nearChanged = Math.abs(this.camera.near - this.lastProjectedNear) > 0.002;
    const aspectChanged = Math.abs(this.camera.aspect - this.lastProjectedAspect) > 1e-4;
    if (force || fovChanged || nearChanged || aspectChanged) {
      this.camera.updateProjectionMatrix();
      this.lastProjectedFov = this.camera.fov;
      this.lastProjectedNear = this.camera.near;
      this.lastProjectedAspect = this.camera.aspect;
    }
  }

  /**
   * One frame of walking up to something, on the same legs and through the same collision as the keys. True: arrived.
   * Null: something is in the way, the arm will have to do.
   */
  walkToward(
    point: T.Vector3,
    stop: number,
    dt: number,
    keepEyes = false,
    precise = false,
    carryFacing?: number,
  ): boolean | null {
    const ch = this.host.character();
    const nav = this.host.walkable?.() ?? this.host.navigation();
    if (!ch?.ready || !nav || !ch.driveReady()) return null;
    const dx = point.x - ch.root.position.x;
    const dz = point.z - ch.root.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= stop) {
      const heading = Math.atan2(-dx, -dz);
      if (!keepEyes)
        this.yaw += Math.atan2(Math.sin(heading - this.yaw), Math.cos(heading - this.yaw)) * (1 - Math.exp(-5 * dt));
      this.speed = 0;
      ch.drive(ch.root.position.clone(), false, dt);
      this.stuck = 0;
      this.route = null;
      return true;
    }
    const key = `${point.x.toFixed(2)}|${point.z.toFixed(2)}|${stop}|${precise}`;
    if (this.route?.key !== key) {
      const here = { x: ch.root.position.x, z: ch.root.position.z };
      let best: { x: number; z: number }[] | null = null;
      let length = Infinity;
      for (const r of precise ? [0] : [stop * 0.92, stop, stop * 1.1, stop * 1.25, stop * 1.55])
        for (let i = 0; i < (precise ? 1 : 16); i++) {
          const a = (i / 16) * Math.PI * 2;
          const end = { x: point.x + Math.cos(a) * r, z: point.z + Math.sin(a) * r };
          if (Math.hypot(end.x - here.x, end.z - here.z) + Math.max(0, r - stop) * 5 >= length || !nav.free(end))
            continue;
          const path = nav.path ? nav.path(here, end) : [end];
          if (!path?.length) continue;
          let total = Math.max(0, r - stop) * 5;
          let from = here;
          for (const q of path) {
            total += Math.hypot(q.x - from.x, q.z - from.z);
            from = q;
          }
          if (total < length) {
            length = total;
            best = path;
          }
        }
      if (!best) return null;
      this.route = { key, points: best.slice(), bestDistance: Infinity };
      this.stuck = 0;
    }
    const next = this.route.points[0];
    if (!next) {
      this.route = null;
      return true;
    }
    const nx = next.x - ch.root.position.x;
    const nz = next.z - ch.root.position.z;
    const nd = Math.hypot(nx, nz);
    const following = this.route.points[1];
    const near = nd < (precise && !following ? stop : 0.06);
    if (near && (!following || !nav.clearLine || nav.clearLine(ch.root.position, following))) {
      this.route.points.shift();
      this.route.bestDistance = Infinity;
      this.stuck = 0;
      if (!this.route.points.length) {
        this.route = null;
        this.speed = 0;
        ch.drive(ch.root.position.clone(), false, dt);
        return !precise || dist <= stop;
      }
      return false;
    }
    if (nd < 1e-8) {
      this.route = null;
      return null;
    }
    const heading = Math.atan2(-nx, -nz);
    if (!keepEyes)
      this.yaw += Math.atan2(Math.sin(heading - this.yaw), Math.cos(heading - this.yaw)) * (1 - Math.exp(-5 * dt));
    const step = Math.min((keepEyes ? BRISK_SPEED : WALK_SPEED) * dt, nd);
    const from = WALK_FROM_SCRATCH.copy(ch.root.position);
    const p = walkSlide(nav, ch.root.position, (nx / nd) * step, (nz / nd) * step);
    const rawFloor = ('groundAt' in nav ? nav.groundAt?.(p.x, p.z) : null) ?? ch.root.position.y;
    const py = this.elevationSpring ? this.elevationSpring.step(rawFloor, dt, 24, 0.55) : rawFloor;
    ch.drive(
      WALK_DRIVE_SCRATCH.set(p.x, py, p.z),
      true,
      dt,
      carryFacing ?? (this.view === 'third' ? undefined : this.yaw + Math.PI),
    );
    this.locomotionAcc?.snap(ch.root.position.x, ch.root.position.y, ch.root.position.z, ch.root.rotation.y);
    this.lastCommittedRoot?.copy(ch.root.position);
    const moved = ch.root.position.distanceTo(from);
    const remaining = Math.hypot(next.x - ch.root.position.x, next.z - ch.root.position.z);
    if (remaining < this.route.bestDistance - 0.001) {
      this.route.bestDistance = remaining;
      this.stuck = 0;
    } else this.stuck += dt;
    if (this.stuck > (carryFacing !== undefined ? 0.75 : 0.28)) {
      this.stuck = 0;
      this.speed = 0;
      this.route = null;
      ch.drive(ch.root.position.clone(), false, dt);
      return null;
    }
    this.speed = moved / Math.max(dt, 0.001);
    return false;
  }

  /** Straight on, whatever the room's edge says: only through a doorway that is open. True when there. */
  walkStraight(point: T.Vector3, dt: number): boolean {
    const ch = this.host.character();
    if (!ch?.ready) return true;
    const dx = point.x - ch.root.position.x;
    const dz = point.z - ch.root.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.04) {
      this.speed = 0;
      return true;
    }
    const heading = Math.atan2(-dx, -dz);
    this.yaw += Math.atan2(Math.sin(heading - this.yaw), Math.cos(heading - this.yaw)) * (1 - Math.exp(-6 * dt));
    const step = Math.min(WALK_SPEED * dt, dist);
    const from = WALK_FROM_SCRATCH.copy(ch.root.position);
    ch.drive(
      WALK_DRIVE_SCRATCH.set(
        ch.root.position.x + (dx / dist) * step,
        ch.root.position.y,
        ch.root.position.z + (dz / dist) * step,
      ),
      true,
      dt,
      this.view === 'third' ? undefined : this.yaw + Math.PI,
    );
    this.locomotionAcc?.snap(ch.root.position.x, ch.root.position.y, ch.root.position.z, ch.root.rotation.y);
    this.lastCommittedRoot?.copy(ch.root.position);
    this.speed = ch.root.position.distanceTo(from) / Math.max(dt, 0.001);
    return false;
  }

  setPassing(on: boolean) {
    this.passing = on;
  }
  private reading = false;
  private stoopK = 0;
  /** A book open in the hands: the lens comes in, the way eyes settle on a page. */
  setReading(on: boolean) {
    this.reading = on;
  }
  /** Words on a page are picked with the pointer: mouse-look lets go for as long as a book is open, and comes back when it closes. */
  pointerForReading(on: boolean) {
    if (on) this.mouseLook.suspend();
    else this.play();
  }
  /** Looking through a telescope: the same eyes, a narrow field. */
  toggleZoom() {
    this.zoom = !this.zoom;
  }
  command(action: EmbodiedAction) {
    this.host.command(action);
  }
  reloadKeys() {
    this.keymap = loadKeymap();
  }
  private stuck = 0;
  private bumpWait = 0;
  private deviceShot: { position: T.Vector3; quaternion: T.Quaternion; e: number } | null = null;
  private attentionAt = new T.Vector3();
  get active() {
    return this.view !== 'overview';
  }
  /** True when the player camera is in 1st-person eye view (on-foot 1P or cockpit driving; false in 3P chase/cycling). */
  get isFirstPersonCameraActive(): boolean {
    if (!this.active) return false;
    const driving = Boolean(this.host.driving?.());
    return (this.view !== 'third' && !driving) || (driving && this.driveCam === 'cockpit');
  }
  get acceptingInput() {
    return this.active && !this.blocked && !this.disposed;
  }
  get locked() {
    return this.mouseLook.locked;
  }
  setView(view: CameraView, cfg?: CameraConfig) {
    const prevView = this.view;
    const wasActive = this.active;
    const ch = this.host.character();
    if (view === 'overview' || !wasActive) this.release();
    else {
      this.keys.clear();
      this.touchButtons.clear();
      this.touch.set(0, 0);
      this.velocity.set(0, 0);
      this.worldVel.set(0, 0);
      this.drag = null;
    }
    if (!cfg && (!this.initialized || !wasActive) && view !== 'overview') {
      this.yaw = (ch?.root.rotation.y ?? 0) + Math.PI;
      if (!this.initialized) this.pitch = 0;
    }
    this.view = view;
    this.targetId = null;
    if (cfg) {
      this.yaw = cfg.yaw ?? Math.PI;
      this.pitch = cfg.pitch ?? 0;
      this.restoredSeat = true;
    }
    if (!wasActive && view !== 'overview') {
      // Entering exploration from Overview snaps directly to the requested view mode (zero stale boom).
      this.initialized = false;
    }
    if (!this.initialized || (wasActive && prevView !== view)) {
      this.yawNow = this.yaw;
      this.pitchNow = this.pitch;
    }
    // Switching from 3rd-person to 1st-person while standing aligns body facing to gaze immediately
    // so the player NEVER sees the character's back or reversed collar on entry (`RC-1P-2`).
    if (
      wasActive &&
      prevView === 'third' &&
      view !== 'third' &&
      view !== 'overview' &&
      !cfg &&
      ch?.ready &&
      ch.standing &&
      !ch.body.seat &&
      !ch.isApproachingSeat &&
      !ch.isDismountingSeat &&
      !(this.host.driving?.() ?? false)
    ) {
      ch.root.rotation.y = this.yaw + Math.PI;
      this.locomotionAcc.snap(ch.root.position.x, ch.root.position.y, ch.root.position.z, ch.root.rotation.y);
      this.lastBodyYaw = ch.root.rotation.y;
    }
    if (view === 'overview') {
      this.clearOwnLimbGuard();
      if (ch) {
        ch.setOwnView(false);
        ch.root.visible = true;
      }
      this.mouseLook.suspend();
    }
    this.notify();
  }
  resize(w: number, h: number) {
    this.camera.aspect = w / Math.max(1, h);
    this.syncProjection(false);
  }
  setBlocked(blocked: boolean) {
    this.blocked = blocked;
    if (blocked) this.release();
    this.mouseLook.cursorNeeded('panel', blocked);
  }
  touchMove(x: number, y: number, id = 0) {
    if ((x || y) && this.touch.lengthSq() < 0.01 && this.host.occupied()) this.host.interrupt();
    if (x || y) this.touchButtons.set(id, { x, y });
    else this.touchButtons.delete(id);
    this.touch.set(0, 0);
    for (const direction of this.touchButtons.values()) {
      this.touch.x += direction.x;
      this.touch.y += direction.y;
    }
    this.touch.clampLength(0, 1);
  }
  /** The player's own button: on with a gesture; off keeps the cursor, and clicks act on what is under it, until they ask again. */
  toggleLook() {
    if (!this.active || this.blocked) return;
    this.mouseLook.toggle();
    this.pointerMode = !this.mouseLook.desired;
    rememberFreePointer(this.pointerMode);
    this.notify();
  }
  /** Going into the room by a click: the mouse is the eyes from here on. Esc gives it back; a click on the room takes it again. */
  play() {
    if (this.active && !this.blocked && !this.pointerMode && !this.touched) this.mouseLook.enable();
  }
  private pointerMode = prefersFreePointer();
  private touched = false;
  /** Leaving the room: the wish goes with it. */
  unlock() {
    this.mouseLook.suspend();
  }
  /** The camera goes through a doorway, then the page changes. Interrupted by anything that clears it. */
  enterDoor(to: T.Vector3 | null, seconds = 0.6) {
    this.passage = to ? { to: to.clone(), elapsed: 0, seconds, from: this.camera.position.clone() } : null;
  }
  interact() {
    if (this.blocked || !this.active) return;
    const ch = this.host.character();
    if (ch?.isApproachingSeat) {
      ch.cancelSeatApproach();
      this.host.stand();
      return;
    }
    if (this.host.occupied()) return;
    if (this.host.lifeInteract?.(!!this.targetId)) return;
    const isSeated = Boolean(ch?.body.seat || this.seatedFrame) && !ch?.isDismountingSeat;
    if (!this.targetId) {
      if (this.host.useHeld()) return;
      if (isSeated) this.host.stand();
      return;
    }
    if (this.host.inlineAction(this.targetId)) return;
    if (isSeated && this.targetId === ch?.body.seat) {
      this.host.stand();
      return;
    }
    this.keys.clear();
    this.velocity.set(0, 0);
    this.worldVel.set(0, 0);
    this.host.save();
    this.host.interacted();
    this.host.activate(this.targetId);
  }
  state(): ExplorationState {
    const ch = this.host.character();
    return {
      view: this.view,
      locked: this.locked,
      resume: this.mouseLook.needsResume,
      target: this.targetId,
      seated: Boolean(this.seatedFrame || ch?.body.seat) && !ch?.isDismountingSeat,
      pointerMode: this.pointerMode || this.touched,
    };
  }
  private notify() {
    const state = this.state();
    const key = JSON.stringify(state);
    if (key !== this.lastState) {
      this.lastState = key;
      this.host.changed(state);
    }
  }
  private focused() {
    return this.locked || document.activeElement === this.canvas;
  }
  private keyDown = (e: KeyboardEvent) => {
    if (!this.active || this.blocked || !this.focused() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (
      this.host.driving?.() &&
      (e.code === 'Space' ||
        e.code === 'KeyE' ||
        e.code === 'KeyC' ||
        e.code === 'KeyL' ||
        e.code === 'KeyH' ||
        e.code === 'KeyQ' ||
        e.code === 'KeyZ' ||
        e.code === 'BracketLeft' ||
        e.code === 'BracketRight')
    ) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code === 'Space') this.keys.add('Space');
      else if (e.code === 'KeyC' && !e.repeat) {
        this.cycleDriveCamera();
      } else if (e.code === 'KeyE' && !e.repeat) this.interact();
      else if (e.code === 'KeyL' && !e.repeat) this.host.vehicleAction?.('headlights');
      else if (e.code === 'KeyH') {
        this.keys.add('KeyH');
        if (!e.repeat) this.host.vehicleAction?.('horn');
      } else if ((e.code === 'BracketLeft' || e.code === 'KeyQ') && !e.repeat) this.host.vehicleAction?.('blinkerLeft');
      else if ((e.code === 'BracketRight' || e.code === 'KeyZ') && !e.repeat) this.host.vehicleAction?.('blinkerRight');
      return;
    }
    if (e.code === 'Escape') this.host.cancelHands?.();
    if (this.host.turnKey?.(e.code, true, e.repeat)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (e.code === 'KeyC') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat && this.host.character()?.standing && !this.host.occupied()) this.crouchHeld = true;
      return;
    }
    const shortcut = actionForKey(this.keymap, e.code);
    if (shortcut) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (shortcut === 'effort') {
        this.host.effort?.(true);
        return;
      }
      if (!e.repeat) {
        if (this.zoom && shortcut === 'cancel') this.zoom = false;
        this.host.shortcut(shortcut);
      }
      return;
    }
    const action = embodiedKeys[e.code];
    if (action) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) {
        const chNow = this.host.character();
        if (action === 'jump' && (this.seatedFrame || chNow?.body.seat || chNow?.isApproachingSeat)) {
          if (chNow?.isApproachingSeat) chNow.cancelSeatApproach();
          this.host.stand();
        } else {
          this.host.command(action);
        }
      }
      return;
    }
    if (
      [
        'KeyW',
        'KeyA',
        'KeyS',
        'KeyD',
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'KeyE',
        'ShiftLeft',
        'ShiftRight',
      ].includes(e.code)
    ) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code === 'KeyE') {
        if (!e.repeat) this.interact();
      } else {
        if (!e.repeat && e.code.startsWith('Key')) {
          const chNow = this.host.character();
          if (chNow?.isApproachingSeat) {
            chNow.cancelSeatApproach();
            this.host.stand();
          } else if (this.host.occupied()) {
            this.host.interrupt();
          }
        }
        this.keys.add(e.code);
      }
    }
  };
  private keyUp = (e: KeyboardEvent) => {
    if (e.code === 'KeyC') this.crouchHeld = false;
    this.host.turnKey?.(e.code, false, false);
    if (actionForKey(this.keymap, e.code) === 'effort') this.host.effort?.(false);
    if (this.keys.delete(e.code) && e.code.startsWith('Arrow') && !Boolean(this.host.driving?.())) this.host.save();
  };
  private release = () => {
    this.crouchHeld = false;
    this.host.released();
    this.keys.clear();
    this.touchButtons.clear();
    this.touch.set(0, 0);
    this.velocity.set(0, 0);
    this.worldVel.set(0, 0);
    this.drag = null;
    if (this.moving) {
      const ch = this.host.character();
      if (ch?.ready) ch.drive(ch.root.position.clone(), false, 1 / 60);
    }
    this.moving = false;
    if (!this.disposed && this.active) this.host.save();
  };
  private visibility = () => {
    if (document.hidden) this.release();
  };
  private mouse = (e: MouseEvent) => {
    if (this.locked && !this.blocked && !this.host.turning(e.movementX, e.movementY))
      this.look(e.movementX, e.movementY);
  };
  get driveCamera() {
    return this.driveCam;
  }
  cycleDriveCamera() {
    this.driveCam = this.driveCam === 'chase' ? 'hood' : this.driveCam === 'hood' ? 'cockpit' : 'chase';
    this.orbitHold = 0;
    return this.driveCam;
  }
  private look(x: number, y: number) {
    if (this.host.driving?.() && (Math.abs(x) > 0.01 || Math.abs(y) > 0.01)) {
      this.orbitHold = 2.0;
    }
    this.yaw -= x * 0.0026;
    this.pitch = T.MathUtils.clamp(this.pitch - y * 0.0026, LOOK_DOWN, 1.42);
  }
  private mouseDown = (e: MouseEvent) => {
    if (!this.locked || !this.active || this.blocked) return;
    if (e.button === 1) e.preventDefault();
    this.host.button(e.button, true);
  };
  private mouseUp = (e: MouseEvent) => {
    if (this.locked) this.host.button(e.button, false);
  };
  private pointerDown = (e: PointerEvent) => {
    if (!this.active || this.blocked) return;
    this.canvas.focus({ preventScroll: true });
    if (e.pointerType === 'touch') this.touched = true;
    if (this.locked) return;
    if (e.button === 1) {
      e.preventDefault();
      this.host.button(1, true);
      return;
    }
    if (e.button === 2) {
      this.host.button(2, true);
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    this.pressAt = { x: e.clientX, y: e.clientY };
    this.canvas.setPointerCapture(e.pointerId);
  };
  private pointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && !this.locked) {
      const r = this.canvas.getBoundingClientRect();
      this.pointerAim.set(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
      this.pointerInside = true;
    }
    if (!this.drag || this.drag.id !== e.pointerId || this.locked) return;
    if (!this.host.turning(e.clientX - this.drag.x, e.clientY - this.drag.y))
      this.look(e.clientX - this.drag.x, e.clientY - this.drag.y);
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
  };
  private pointerLeave = () => {
    this.pointerInside = false;
  };
  private noMenu = (e: Event) => {
    if (this.active) e.preventDefault();
  };
  private wheel = (e: WheelEvent) => {
    if (this.active && !this.blocked && this.host.wheel(e.deltaY || e.deltaX, e.shiftKey || e.altKey))
      e.preventDefault();
  };
  private pointerUp = (e: PointerEvent) => {
    if (this.locked) return;
    if (this.drag?.id !== e.pointerId) return;
    this.drag = null;
    this.host.save();
    if (e.type !== 'pointerup') return;
    if (e.button === 2) {
      this.host.button(2, false);
      return;
    }
    const still = !!this.pressAt && Math.hypot(e.clientX - this.pressAt.x, e.clientY - this.pressAt.y) < 5;
    this.pressAt = null;
    if (!still) return;
    if (this.mouseLook.needsResume) {
      this.mouseLook.resume();
      return;
    }
    if (e.pointerType === 'mouse' && !this.pointerMode && !this.touched) {
      this.mouseLook.enable(
        this.host.toolInHands?.()
          ? () => {
              this.host.button(0, true);
              this.host.button(0, false);
            }
          : undefined,
      );
      return;
    }
    this.host.button(0, true);
    this.host.button(0, false);
  };

  /**
   * Phase 1 of frame: Input, Fixed-60Hz Capsule Locomotion, Vehicle Driving, and Lean Dynamics.
   * When `deferCameraToPostIk` is `false` (default), also invokes `syncCameraPostIk` immediately for
   * full backward compatibility until `StudyWorld.frame()` runs `syncCameraPostIk` after `updateBody()`.
   */
  update(rawDt: number, reduced: boolean) {
    const ch = this.host.character();
    if (ch) this.prepareCharacterMaterials(ch);
    const nav = this.host.walkable();
    const simDt = Math.max(0, Math.min(rawDt, 0.0667));
    this.lastReduced = reduced;

    if (ch?.ready && (this.crouchAmount > 0 || this.crouchHeld)) {
      const target = this.crouchHeld && this.active && ch.standing && !this.host.occupied() ? 1 : 0;
      const next = T.MathUtils.damp(this.crouchAmount, target, 18, Math.min(simDt, 0.05));
      const amount = Math.abs(next - target) < 0.002 ? target : next;
      if (amount >= this.crouchAmount || this.host.actorFits(ch.root.position.x, ch.root.position.z, amount))
        this.crouchAmount = amount;
    }
    if (!this.active || !ch?.ready || !nav) {
      this.clearOwnLimbGuard();
      if (ch) {
        ch.root.visible = true;
        ch.setOwnView(false);
      }
      this.locomotionSynced = false;
      this.leanRoll = 0;
      this.leanPitch = 0;
      return;
    }

    this.blockerCacheAge += simDt;
    if (this.locked || !this.pointerInside) this.aim.set(0, 0);
    else this.aim.copy(this.pointerAim);

    const cw = this.resolveCollisionWorld(nav);
    this.refreshAutoOpenDoors(nav);

    const driving = Boolean(this.host.driving?.());
    this.lastDriving = driving;
    if (!driving) {
      this.vehicleHeading = null;
      this.orbitHold = 0;
      this.driveReverseHold = 0;
      this.driveSpeedRatio += (0 - this.driveSpeedRatio) * (1 - Math.exp(-6 * simDt));
      this.driveLookAhead += (0 - this.driveLookAhead) * (1 - Math.exp(-6 * simDt));
    }
    const cockpit = driving && this.driveCam === 'cockpit';
    const hood = driving && this.driveCam === 'hood';
    const chase = driving && this.driveCam === 'chase';
    const own = (this.view !== 'third' && !driving) || cockpit;

    // Sync or sanitize initial / externally-modified root (`resolveRoot` balance step vs teleport/dismount).
    if (!this.locomotionSynced) {
      this.locomotionSynced = true;
      if (
        !driving &&
        !ch.body.seat &&
        !ch.isDismountingSeat &&
        ch.posture !== 'rising' &&
        ch.publicPosture !== 'airborne'
      ) {
        if (cw) {
          const clean = sanitizePlayerPosition(cw, ch.root.position, { referenceY: ch.root.position.y });
          if (clean.sanitized) ch.root.position.set(clean.x, clean.y, clean.z);
        }
        const floorY = this.resolveGroundedFloorY(ch, nav, ch.root.position.x, ch.root.position.z, ch.root.position.y);
        if (Math.abs(ch.root.position.y - floorY) > 1e-4) {
          ch.root.position.y = floorY;
          ch.rig?.resetFootDynamics();
        }
      }
      this.locomotionAcc.snap(ch.root.position.x, ch.root.position.y, ch.root.position.z, ch.root.rotation.y);
      this.elevationSpring.reset(ch.root.position.y);
      this.lastCommittedRoot.copy(ch.root.position);
    } else if (!driving) {
      const extDx = ch.root.position.x - this.lastCommittedRoot.x;
      const extDy = ch.root.position.y - this.lastCommittedRoot.y;
      const extDz = ch.root.position.z - this.lastCommittedRoot.z;
      const extDistSq = extDx * extDx + extDz * extDz + extDy * extDy;
      if (extDistSq > 0.65 * 0.65) {
        // Teleport, fast-travel, resetPose, stand-up, or vehicle dismount: sanitize if on foot and snap floorY + springs.
        if (
          !ch.body.seat &&
          !ch.isDismountingSeat &&
          ch.posture !== 'rising' &&
          ch.publicPosture !== 'airborne'
        ) {
          if (cw) {
            const clean = sanitizePlayerPosition(cw, ch.root.position, { referenceY: ch.root.position.y });
            if (clean.sanitized) ch.root.position.set(clean.x, clean.y, clean.z);
          }
          const floorY = this.resolveGroundedFloorY(
            ch,
            nav,
            ch.root.position.x,
            ch.root.position.z,
            ch.root.position.y,
          );
          ch.root.position.y = floorY;
          ch.rig?.resetFootDynamics();
        }
        this.locomotionAcc.snap(ch.root.position.x, ch.root.position.y, ch.root.position.z, ch.root.rotation.y);
        this.elevationSpring.reset(ch.root.position.y);
      } else if (extDistSq > 1e-10) {
        // Preserve `HumanRig.taken` (`resolveRoot` balance steps) or jump Y cleanly inside the accumulator!
        this.locomotionAcc.applyExternalRootDelta(extDx, extDy, extDz);
        if (ch.publicPosture === 'airborne') this.elevationSpring.reset(ch.root.position.y);
      }
    }

    // Entering a seat or bed aligns initial gaze once, then allows free neck-bounded look.
    const frame = ch.lookFrame();
    const seatKey = frame ? `${ch.body.seat}|${frame.yaw.toFixed(3)}` : null;
    if (seatKey !== this.seatedFrame) {
      const was = this.seatedFrame;
      this.seatedFrame = seatKey;
      if (frame && (!was || was !== seatKey) && !this.restoredSeat) {
        this.yaw = frame.yaw;
        this.pitch = frame.pitch;
      }
      this.restoredSeat = false;
      this.notify();
    } else if (!frame) this.restoredSeat = false;

    if (!this.blocked) {
      if (!driving) {
        this.yaw += (Number(this.keys.has('ArrowLeft')) - Number(this.keys.has('ArrowRight'))) * simDt * 1.6;
        this.pitch = T.MathUtils.clamp(
          this.pitch + (Number(this.keys.has('ArrowUp')) - Number(this.keys.has('ArrowDown'))) * simDt,
          LOOK_DOWN,
          1.42,
        );
      }
      const rawMoveX = Number(this.keys.has('KeyD')) - Number(this.keys.has('KeyA')) + this.touch.x;
      const rawMoveY = Number(this.keys.has('KeyW')) - Number(this.keys.has('KeyS')) + this.touch.y;
      const hasMoveInput = Math.hypot(rawMoveX, rawMoveY) > 0.08;
      const wantStandKey = this.keys.has('Space') || this.keys.has('KeyX');
      const inDeviceZoom = Boolean(this.device && this.device.dir > 0);
      const isSeatedNow =
        Boolean(ch.body.seat || this.seatedFrame) && !ch.isDismountingSeat && ch.posture !== 'rising';

      if (driving) {
        const turnKey =
          (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) -
          (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);
        const throttleKey =
          (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) -
          (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
        const turnInput = T.MathUtils.clamp(turnKey + this.touch.x, -1, 1);
        const throttleInput = T.MathUtils.clamp(throttleKey + this.touch.y, -1, 1);
        const driveState = this.host.driveCar?.(simDt, throttleInput, turnInput, this.keys.has('Space'), {
          hornHeld: this.keys.has('KeyH'),
        });
        if (driveState) {
          const maxSpd = Math.max(6, driveState.maxSpeed ?? 15);
          const targetRatio = T.MathUtils.clamp(Math.abs(driveState.speed) / maxSpd, 0, 1);
          this.driveSpeedRatio += (targetRatio - this.driveSpeedRatio) * (1 - Math.exp(-4.5 * simDt));

          const steerFactor =
            driveState.steer !== undefined
              ? T.MathUtils.clamp(-driveState.steer / 0.42, -1, 1)
              : T.MathUtils.clamp(turnInput, -1, 1);
          const targetLookAhead = steerFactor * (0.25 + 0.75 * this.driveSpeedRatio);
          this.driveLookAhead += (targetLookAhead - this.driveLookAhead) * (1 - Math.exp(-5.5 * simDt));

          const reversing = driveState.reversing ?? driveState.speed < -0.6;
          this.driveReverseHold = reversing ? this.driveReverseHold + simDt : 0;

          const baseBehind = this.driveReverseHold > 0.9 && chase ? driveState.yaw : driveState.yaw + Math.PI;
          const lookAheadYaw = chase && this.orbitHold <= 0 ? -this.driveLookAhead * 0.14 : 0;
          const desiredYaw = baseBehind + lookAheadYaw;
          const desiredPitch = chase ? -0.18 - 0.04 * this.driveSpeedRatio : hood ? -0.05 : -0.04;

          if (this.vehicleHeading === null) {
            this.yaw = desiredYaw;
            this.pitch = desiredPitch;
          } else if (this.orbitHold <= 0) {
            if (hood || cockpit) {
              const delta = desiredYaw - this.yaw;
              this.yaw += Math.atan2(Math.sin(delta), Math.cos(delta)) * (1 - Math.exp(-12 * simDt));
              this.pitch += (desiredPitch - this.pitch) * (1 - Math.exp(-8 * simDt));
            } else if (Math.abs(driveState.speed) > 0.1) {
              const delta = desiredYaw - this.yaw;
              const alignRate = 3.6 + 2.4 * this.driveSpeedRatio;
              this.yaw += Math.atan2(Math.sin(delta), Math.cos(delta)) * (1 - Math.exp(-alignRate * simDt));
              this.pitch += (desiredPitch - this.pitch) * (1 - Math.exp(-3.4 * simDt));
            }
          }
          this.vehicleHeading = driveState.yaw;
          this.orbitHold = Math.max(0, this.orbitHold - simDt);
          this.speed = Math.abs(driveState.speed);
        }
        this.velocity.set(0, 0);
        this.worldVel.set(0, 0);
        this.moving = false;
        this.isBrakingReverse = false;
        this.locomotionAcc.snap(ch.root.position.x, ch.root.position.y, ch.root.position.z, ch.root.rotation.y);
        this.elevationSpring.reset(ch.root.position.y);
        this.lastCommittedRoot.copy(ch.root.position);
      } else if (ch.isApproachingSeat) {
        if (hasMoveInput || wantStandKey) {
          this.keys.delete('Space');
          this.keys.delete('KeyX');
          ch.cancelSeatApproach();
          this.host.stand();
        }
        this.velocity.set(0, 0);
        this.worldVel.set(0, 0);
        this.speed = 0;
        this.moving = false;
        this.isBrakingReverse = false;
        this.locomotionAcc.snap(ch.root.position.x, ch.root.position.y, ch.root.position.z, ch.root.rotation.y);
        this.elevationSpring.reset(ch.root.position.y);
        this.lastCommittedRoot.copy(ch.root.position);
      } else if (isSeatedNow) {
        this.wasSeatedOrRising = true;
        if (!inDeviceZoom) {
          if (wantStandKey) {
            this.keys.delete('Space');
            this.keys.delete('KeyX');
            this.host.stand();
          } else if (ch.seatMobility === 'rolling') {
            this.tmpRawInput.set(rawMoveX, rawMoveY).clampLength(0, 1);
            const rollDirX = Math.cos(this.yaw) * this.tmpRawInput.x - Math.sin(this.yaw) * this.tmpRawInput.y;
            const rollDirZ = -Math.sin(this.yaw) * this.tmpRawInput.x - Math.cos(this.yaw) * this.tmpRawInput.y;
            const canRoll = (x: number, z: number) =>
              nav.clampCamera
                ? nav.free({ x, z })
                : Math.abs(x) <= nav.half - 0.28 && Math.abs(z) <= nav.half - 0.28 && nav.free({ x, z });
            if (ch.driveRollingChair(rollDirX, rollDirZ, this.yaw + Math.PI, simDt, canRoll)) {
              this.host.moved();
            }
          } else if (hasMoveInput) {
            // Stationary seats (Study Room + House + City benches/chairs + Beds): dismount cleanly into walk!
            this.host.stand();
          }
        }
        this.velocity.set(0, 0);
        this.worldVel.set(0, 0);
        this.speed = 0;
        this.moving = false;
        this.isBrakingReverse = false;
        this.locomotionAcc.snap(ch.root.position.x, ch.root.position.y, ch.root.position.z, ch.root.rotation.y);
        this.elevationSpring.reset(ch.root.position.y);
        this.lastCommittedRoot.copy(ch.root.position);
      } else if (ch.isDismountingSeat || ch.posture === 'rising') {
        this.wasSeatedOrRising = true;
        this.velocity.set(0, 0);
        this.worldVel.set(0, 0);
        this.speed = 0;
        this.moving = false;
        this.isBrakingReverse = false;
        this.locomotionAcc.snap(ch.root.position.x, ch.root.position.y, ch.root.position.z, ch.root.rotation.y);
        this.elevationSpring.reset(ch.root.position.y);
        this.lastCommittedRoot.copy(ch.root.position);
      } else if (this.host.occupied()) {
        this.velocity.set(0, 0);
        this.worldVel.set(0, 0);
        this.moving = false;
        this.isBrakingReverse = false;
        this.locomotionAcc.snap(ch.root.position.x, ch.root.position.y, ch.root.position.z, ch.root.rotation.y);
        this.lastCommittedRoot.copy(ch.root.position);
      } else if (!ch.body.occupied) {
        if (this.wasSeatedOrRising) {
          this.wasSeatedOrRising = false;
          this.locomotionAcc.snap(ch.root.position.x, ch.root.position.y, ch.root.position.z, ch.root.rotation.y);
          this.elevationSpring.reset(ch.root.position.y);
          this.lastCommittedRoot.copy(ch.root.position);
        }
        const running = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
        this.tmpRawInput.set(rawMoveX, rawMoveY).clampLength(0, 1);

        // Camera-relative world input vector (works identically in 3rd-person orbit and 1st-person).
        const worldDirX = Math.cos(this.yaw) * this.tmpRawInput.x - Math.sin(this.yaw) * this.tmpRawInput.y;
        const worldDirZ = -Math.sin(this.yaw) * this.tmpRawInput.x - Math.cos(this.yaw) * this.tmpRawInput.y;

        const steered = this.host.steer?.(worldDirX, worldDirZ, running) ?? false;
        const targetTopSpeed =
          T.MathUtils.lerp(running ? RUN_SPEED : WALK_SPEED, 0.78, this.crouchAmount) * this.host.speedFactor();

        if (steered) {
          this.tmpMoveInput.set(0, 0);
          this.velocity.set(0, 0);
          this.worldVel.set(0, 0);
          this.moving = false;
          this.isBrakingReverse = false;
          this.locomotionAcc.snap(ch.root.position.x, ch.root.position.y, ch.root.position.z, ch.root.rotation.y);
          this.lastCommittedRoot.copy(ch.root.position);
        } else {
          const wantWorldX = worldDirX * targetTopSpeed;
          const wantWorldZ = worldDirZ * targetTopSpeed;
          const face = own ? this.yaw + Math.PI : undefined;

          if (ch.driveReady()) {
            this.tmpFrom.copy(ch.root.position);
            let bumpedSpeed = 0;
            let bumpDirX = 0;
            let bumpDirZ = 0;

            const rendered = this.locomotionAcc.advance(simDt, (fixedDt, st) => {
              const currSpd = Math.hypot(this.worldVel.x, this.worldVel.y);
              const wantSpd = Math.hypot(wantWorldX, wantWorldZ);

              // 180-degree GTA-style brake-plant-surge detection (`cos < -0.45` at speed > 1.0 m/s).
              if (currSpd > 1.0 && wantSpd > 0.35) {
                const cosTurn = (this.worldVel.x * wantWorldX + this.worldVel.y * wantWorldZ) / (currSpd * wantSpd);
                if (cosTurn < -0.45) {
                  this.brakePlantTimer = 0.11;
                }
              }
              if (this.brakePlantTimer > 0) {
                this.brakePlantTimer = Math.max(0, this.brakePlantTimer - fixedDt);
                if (currSpd < 0.22) this.brakePlantTimer = 0;
              }
              this.isBrakingReverse = this.brakePlantTimer > 0;

              const goalVx = this.brakePlantTimer > 0 ? 0 : wantWorldX;
              const goalVz = this.brakePlantTimer > 0 ? 0 : wantWorldZ;
              const goalSpd = Math.hypot(goalVx, goalVz);
              const dvx = goalVx - this.worldVel.x;
              const dvz = goalVz - this.worldVel.y;
              const dvLen = Math.hypot(dvx, dvz);

              if (dvLen > 1e-6) {
                const rate =
                  this.brakePlantTimer > 0
                    ? REVERSE_PLANT_DECEL
                    : goalSpd > currSpd + 0.04
                      ? running
                        ? ACCEL_RUN
                        : ACCEL_WALK
                      : running
                        ? DECEL_RUN
                        : DECEL_WALK;
                const maxStepV = rate * fixedDt;
                if (dvLen <= maxStepV) {
                  this.worldVel.set(goalVx, goalVz);
                } else {
                  this.worldVel.x += (dvx / dvLen) * maxStepV;
                  this.worldVel.y += (dvz / dvLen) * maxStepV;
                }
              }

              const moveSpd = Math.hypot(this.worldVel.x, this.worldVel.y);
              if (moveSpd > 0.03) {
                const stepDx = this.worldVel.x * fixedDt;
                const stepDz = this.worldVel.y * fixedDt;
                let nextX = st.x;
                let nextZ = st.z;

                let slidAtWorldBoundary = false;
                if (cw && this.crouchAmount <= 0) {
                  const slide = cw.slideStep({ x: st.x, z: st.z }, stepDx, stepDz);
                  nextX = slide.x;
                  nextZ = slide.z;
                  if (cw.boundaryClearanceAt(nextX, nextZ) <= 0.08) {
                    slidAtWorldBoundary = true;
                  }
                } else {
                  const clearance =
                    this.crouchAmount <= 0
                      ? nav
                      : {
                          free: (at: { x: number; z: number }) =>
                            (nav.clampCamera
                              ? nav.free(at)
                              : Math.abs(at.x) <= nav.half && Math.abs(at.z) <= nav.half) &&
                            this.host.actorFits(at.x, at.z, this.crouchAmount),
                        };
                  const p = walkSlide(clearance, { x: st.x, z: st.z }, stepDx, stepDz);
                  nextX = p.x;
                  nextZ = p.z;
                }

                const actualStepDist = Math.hypot(nextX - st.x, nextZ - st.z);
                const actualSpd = actualStepDist / fixedDt;
                if (!slidAtWorldBoundary && moveSpd > 1.2 && actualSpd < moveSpd * 0.35 && this.bumpWait <= 0) {
                  bumpedSpeed = moveSpd;
                  bumpDirX = stepDx / fixedDt;
                  bumpDirZ = stepDz / fixedDt;
                  this.worldVel.multiplyScalar(0.2);
                } else if (actualStepDist < Math.hypot(stepDx, stepDz) * 0.92) {
                  // Damp velocity component into the blocking wall or map perimeter so tangential sliding stays smooth.
                  this.worldVel.set((nextX - st.x) / fixedDt, (nextZ - st.z) / fixedDt);
                }
                st.x = nextX;
                st.z = nextZ;
              } else {
                this.worldVel.set(0, 0);
              }

              if (ch.publicPosture !== 'airborne') {
                const treadBlend = 1 - smoothstep01(0.04, 0.32, moveSpd);
                let floorY = st.y;
                if (nav.sampleFootSupport) {
                  const hit = nav.sampleFootSupport(st.x, st.z, treadBlend, this.footSampleScratch, st.y);
                  if (hit && Math.abs(hit.y - st.y) <= 0.55) floorY = hit.y;
                } else {
                  const g = nav.groundAt?.(st.x, st.z);
                  if (g !== null && g !== undefined && Math.abs(g - st.y) <= 0.55) floorY = g;
                }
                st.y = this.elevationSpring.step(floorY, fixedDt, 24, 0.55);
              }
            });

            const activeNow = this.worldVel.lengthSq() > 0.002 || Math.hypot(wantWorldX, wantWorldZ) > 0.04;
            this.bumpWait = Math.max(0, this.bumpWait - simDt);
            const airborneNow = ch.publicPosture === 'airborne';

            if (activeNow) {
              this.host.moved();
              const targetY = airborneNow ? ch.root.position.y : rendered.y;
              ch.drive(this.tmpDrivePos.set(rendered.x, targetY, rendered.z), true, simDt, face);
              this.speed = ch.root.position.distanceTo(this.tmpFrom) / Math.max(simDt, 0.001);
              if (bumpedSpeed > 0) {
                this.bumpWait = 0.9;
                const k = this.stage.scale.x;
                ch.rig?.bump(-bumpDirX * 0.36 * k, -bumpDirZ * 0.36 * k);
                this.host.bumped?.(bumpedSpeed);
              }
            } else {
              this.speed = 0;
              if (this.moving) {
                const restY = airborneNow ? ch.root.position.y : rendered.y;
                ch.drive(this.tmpDrivePos.set(ch.root.position.x, restY, ch.root.position.z), false, simDt);
                this.host.save();
              } else if (!airborneNow && Math.abs(ch.root.position.y - rendered.y) > 1e-4) {
                ch.root.position.y = rendered.y;
              }
              if (own) ch.faceToward(this.yaw + Math.PI, simDt, true);
            }
            this.moving = activeNow;
            this.lastCommittedRoot.copy(ch.root.position);
          } else {
            this.worldVel.set(0, 0);
            this.speed = 0;
            this.moving = false;
            this.lastCommittedRoot.copy(ch.root.position);
          }
        }
      } else {
        this.velocity.set(0, 0);
        this.worldVel.set(0, 0);
        this.speed = 0;
        this.moving = false;
        this.isBrakingReverse = false;
        this.lastCommittedRoot.copy(ch.root.position);
      }
    } else {
      this.speed = 0;
      this.worldVel.set(0, 0);
      this.isBrakingReverse = false;
      this.lastCommittedRoot.copy(ch.root.position);
    }

    // Keep standing idle root elevation synced to real floor support (prevents buried `-3.20 m` squat on `-2.80 m` grass!).
    if (
      !driving &&
      !this.moving &&
      ch.onFeet &&
      !ch.body.seat &&
      !ch.isApproachingSeat &&
      !ch.isDismountingSeat &&
      ch.posture !== 'rising' &&
      ch.publicPosture !== 'airborne'
    ) {
      const supportY = this.resolveGroundedFloorY(ch, nav, ch.root.position.x, ch.root.position.z, ch.root.position.y);
      const dySupport = Math.abs(ch.root.position.y - supportY);
      if (dySupport > 0.18) {
        ch.root.position.y = supportY;
        this.locomotionAcc.snap(ch.root.position.x, supportY, ch.root.position.z, ch.root.rotation.y);
        this.elevationSpring.reset(supportY);
        ch.rig?.resetFootDynamics();
        this.lastCommittedRoot.copy(ch.root.position);
      } else if (dySupport > 0.006 && simDt > 0) {
        const nextY = this.elevationSpring.step(supportY, simDt, 24, 0.55);
        ch.root.position.y = nextY;
        this.locomotionAcc.snap(ch.root.position.x, nextY, ch.root.position.z, ch.root.rotation.y);
        this.lastCommittedRoot.copy(ch.root.position);
      }
    }

    // Update wobble-free character-root `leanRoll` and `leanPitch` readouts for `BodyFrame`.
    this.updateTorsoLeanReadouts(ch, simDt, driving);

    if (!this.deferCameraToPostIk) {
      this.syncCameraPostIk(simDt, reduced);
    }
  }

  private updateTorsoLeanReadouts(ch: Character, dt: number, driving: boolean): void {
    if (driving || ch.body.seat || dt <= 1e-5) {
      this.leanRoll += (0 - this.leanRoll) * (1 - Math.exp(-12 * Math.max(0, dt)));
      this.leanPitch += (0 - this.leanPitch) * (1 - Math.exp(-12 * Math.max(0, dt)));
      this.prevSpeed = this.speed;
      this.bodyYawInitialized = false;
      return;
    }

    const bodyYaw = ch.root.rotation.y;
    if (!this.bodyYawInitialized) {
      this.lastBodyYaw = bodyYaw;
      this.bodyYawInitialized = true;
    }
    const rawYawRate = shortestArcAngleDelta(this.lastBodyYaw, bodyYaw) / dt;
    this.lastBodyYaw = bodyYaw;

    // 9 Hz low-pass filter (`omega = 2 * PI * 9 = 56.5`) + 0.18 rad/s deadzone (`#69` centripetal lean law).
    this.filteredYawRate += (rawYawRate - this.filteredYawRate) * (1 - Math.exp(-56.5 * dt));
    const absRate = Math.abs(this.filteredYawRate);
    const effYawRate = absRate <= 0.18 ? 0 : Math.sign(this.filteredYawRate) * (absRate - 0.18);
    const targetRoll = T.MathUtils.clamp(-this.speed * effYawRate * 0.038, -0.14, 0.14);
    this.leanRoll += (targetRoll - this.leanRoll) * (1 - Math.exp(-11 * dt));

    const fwdAccel = T.MathUtils.clamp((this.speed - this.prevSpeed) / dt, -12, 10);
    this.prevSpeed = this.speed;
    const accelPitch = this.moving ? T.MathUtils.clamp(fwdAccel * 0.0085, -0.045, 0.055) : 0;
    const targetPitch = T.MathUtils.clamp(accelPitch + this.elevationSpring.slopeLeanPitch, -0.06, 0.095);
    this.leanPitch += (targetPitch - this.leanPitch) * (1 - Math.exp(-10 * dt));
  }

  private ensureAvatarOwnLimbSetup(ch: Character): readonly T.Vector3[] {
    this.prepareCharacterMaterials(ch);
    const holder = ch.root.children[0];
    if (!holder) return this.activeLimbPointList;

    const modelSig = `${holder.uuid}:${holder.children.length}:${holder.children[0]?.children.length ?? 0}`;
    if (this.patchedModelUuid !== modelSig) {
      this.patchedModelUuid = modelSig;
      this.cachedLimbBones.length = 0;
      holder.traverse((node) => {
        const boneName = (node.userData?.name as string | undefined) ?? node.name;
        if ((node as T.Bone).isBone && LOWER_LIMB_BONE_RE.test(boneName)) {
          if (this.cachedLimbBones.length < this.cachedLimbPoints.length) {
            this.cachedLimbBones.push(node);
          }
        }
      });
    }

    this.activeLimbPointList.length = 0;
    for (let i = 0; i < this.cachedLimbBones.length; i++) {
      const pt = this.cachedLimbPoints[i];
      this.cachedLimbBones[i].getWorldPosition(pt);
      this.activeLimbPointList.push(pt);
    }
    return this.activeLimbPointList;
  }

  /**
   * Phase 2 of frame: Post-IK Camera Placement, Swept-Sphere Obstruction, Smooth 1P <-> 3P Dolly,
   * and 1st-Person Own-Limb Self-Occlusion Guard (`0`-frame latency when run after `updateBody()`).
   * Preserves optional additive `fovOffset` (`passage` / `dialogueZoom`) from `StudyWorld` (`E5-05`).
   */
  syncCameraPostIk(rawDt: number, reduced = this.lastReduced, fovOffset = 0): void {
    const ch = this.host.character();
    const nav = this.host.walkable();
    if (!this.active || !ch?.ready || !nav) {
      this.clearOwnLimbGuard();
      return;
    }

    const dt = Math.max(0, Math.min(rawDt, 0.0667));
    const driving = this.lastDriving || (this.host.driving?.() ?? false);
    const cockpit = driving && this.driveCam === 'cockpit';
    const hood = driving && this.driveCam === 'hood';
    const chase = driving && this.driveCam === 'chase';
    const isThirdPerson = this.view === 'third';
    const own = (!isThirdPerson && !driving) || cockpit;
    const onFootFirstPerson = !isThirdPerson && !driving;

    // Mode-persistent dialogue framing (`RC-DLG-1`):
    // - In 3rd-person (`isThirdPerson`): smooth over-the-shoulder two-shot (`dialogueBlend`).
    // - In 1st-person (`!isThirdPerson`): NEVER pull camera behind the player (`dialogueBlend === 0`);
    //   instead orient eye-level gaze naturally toward the NPC with gentle `72 -> 65 deg` focus (`dialogueFocusBlend`).
    const dlg3PGoal = this.dialogueTarget && !driving && isThirdPerson ? 1 : 0;
    const dlgFocusGoal = this.dialogueTarget && !driving && !isThirdPerson ? 1 : 0;
    if (!isThirdPerson) {
      this.dialogueBlend = 0;
      if (!this.dialogueTarget) this.lastDialogueTarget = null;
    } else if (reduced) {
      this.dialogueBlend = dlg3PGoal;
    } else {
      const dlgRate = dlg3PGoal > this.dialogueBlend ? 6.5 : 12.0;
      this.dialogueBlend += (dlg3PGoal - this.dialogueBlend) * (1 - Math.exp(-dlgRate * dt));
      if (this.dialogueBlend < 0.015 && !this.dialogueTarget) {
        this.dialogueBlend = 0;
        this.lastDialogueTarget = null;
      }
    }
    if (reduced) {
      this.dialogueFocusBlend = dlgFocusGoal;
    } else {
      const focusRate = dlgFocusGoal > this.dialogueFocusBlend ? 7.5 : 14.0;
      this.dialogueFocusBlend += (dlgFocusGoal - this.dialogueFocusBlend) * (1 - Math.exp(-focusRate * dt));
      if (this.dialogueFocusBlend < 0.005 && !this.dialogueTarget) this.dialogueFocusBlend = 0;
    }
    const dlg3PE = this.dialogueBlend * this.dialogueBlend * (3 - 2 * this.dialogueBlend);
    const dlgFocusE = this.dialogueFocusBlend * this.dialogueFocusBlend * (3 - 2 * this.dialogueFocusBlend);

    this.camera.near = 0.055 * this.stage.scale.x;

    // In 1st-person NPC conversation, keep the camera at the player's eye anchor and turn gaze + body toward the speaker!
    if (this.dialogueTarget && !driving && !isThirdPerson && !this.device) {
      const myEyeStage = ch.anatomicalEyeStagePoint
        ? ch.anatomicalEyeStagePoint(this.tmpEye, this.crouchAmount)
        : ch.eyePoint(this.tmpEye, this.crouchAmount);
      const spEyeY = this.dialogueTarget.eyeY ?? this.dialogueTarget.y + 1.56;
      const dx = this.dialogueTarget.x - myEyeStage.x;
      const dy = spEyeY - 0.06 - myEyeStage.y;
      const dz = this.dialogueTarget.z - myEyeStage.z;
      const horiz = Math.hypot(dx, dz);
      if (horiz > 0.12) {
        const wantYaw = Math.atan2(-dx, -dz);
        const wantPitch = T.MathUtils.clamp(Math.atan2(dy, horiz), -0.45, 0.35);
        const k = reduced ? 1 : 1 - Math.exp(-9.0 * dt);
        this.yaw += Math.atan2(Math.sin(wantYaw - this.yaw), Math.cos(wantYaw - this.yaw)) * k;
        this.pitch = T.MathUtils.clamp(this.pitch + (wantPitch - this.pitch) * k, LOOK_DOWN, 1.42);
        if (
          ch.standing &&
          !ch.body.seat &&
          !ch.isApproachingSeat &&
          !ch.isDismountingSeat
        ) {
          const wantBodyYaw = wantYaw + Math.PI;
          const bDiff = shortestArcAngleDelta(ch.root.rotation.y, wantBodyYaw);
          ch.root.rotation.y += bDiff * (reduced ? 1 : 1 - Math.exp(-10.0 * dt));
          this.locomotionAcc.snap(ch.root.position.x, ch.root.position.y, ch.root.position.z, ch.root.rotation.y);
          this.lastBodyYaw = ch.root.rotation.y;
        }
      }
    }

    // Under unlocked pointer, smoothly aim toward active Study Room desk/shelf/book attention targets
    // (explicitly suppressed for `life:*` doors so swinging door handles never wrench the camera).
    if (
      !this.locked &&
      !driving &&
      !this.dialogueTarget &&
      !this.targetId?.startsWith('life:') &&
      this.host.attention(this.attentionAt)
    ) {
      const eye = this.stage.localToWorld(ch.eyePoint(this.tmpEye, this.crouchAmount));
      const dx = this.attentionAt.x - eye.x;
      const dy = this.attentionAt.y - eye.y;
      const dz = this.attentionAt.z - eye.z;
      const k = 1 - Math.exp(-4.5 * dt);
      this.yaw += Math.atan2(Math.sin(Math.atan2(-dx, -dz) - this.yaw), Math.cos(Math.atan2(-dx, -dz) - this.yaw)) * k;
      this.pitch = T.MathUtils.clamp(
        this.pitch + (Math.atan2(dy, Math.hypot(dx, dz)) - this.pitch) * k,
        LOOK_DOWN,
        1.42,
      );
    }

    const frame = ch.lookFrame();
    if (frame) {
      // Wheeled swivel chairs (`chair.office`) allow unrestricted 360-degree yaw rotation.
      if (ch.seatMobility !== 'rolling') {
        const off = Math.atan2(Math.sin(this.yaw - frame.yaw), Math.cos(this.yaw - frame.yaw));
        this.yaw = frame.yaw + T.MathUtils.clamp(off, -frame.yawRange, frame.yawRange);
      }
      this.pitch = T.MathUtils.clamp(this.pitch, frame.pitchMin, frame.pitchMax);
    }

    const lookSmooth = reduced ? 1 : 1 - Math.exp(-(own ? 30 : chase ? 12 : 22) * dt);
    this.yawNow += Math.atan2(Math.sin(this.yaw - this.yawNow), Math.cos(this.yaw - this.yawNow)) * lookSmooth;
    this.pitchNow = T.MathUtils.lerp(this.pitchNow, this.pitch, lookSmooth);

    // Hard 1st-person standing neck-yaw envelope (`<= 24 deg`) so rapid mouse turns never leave shoulders/coat in front of lens.
    if (
      onFootFirstPerson &&
      ch.standing &&
      !ch.body.seat &&
      !ch.isApproachingSeat &&
      !ch.isDismountingSeat &&
      !ch.motionActive &&
      !this.host.occupied()
    ) {
      const gazeBodyYaw = this.yawNow + Math.PI;
      const yawGap = shortestArcAngleDelta(ch.root.rotation.y, gazeBodyYaw);
      if (Math.abs(yawGap) > 0.42) {
        ch.root.rotation.y = gazeBodyYaw - Math.sign(yawGap) * 0.42;
        this.locomotionAcc.snap(ch.root.position.x, ch.root.position.y, ch.root.position.z, ch.root.rotation.y);
        this.lastBodyYaw = ch.root.rotation.y;
      }
    }

    const scale = this.stage.scale.x;
    this.refreshBlockerCache();

    if (driving) {
      // Vehicles 2.0 driving camera (chase / hood / cockpit) with 0.18 m swept-sphere obstruction.
      this.cameraRig.ownLimbUniforms.uOwnLimbGuardActive.value = cockpit ? 1 : 0;
      const forward = this.tmpForward.set(
        -Math.sin(this.yawNow) * Math.cos(this.pitchNow),
        Math.sin(this.pitchNow),
        -Math.cos(this.yawNow) * Math.cos(this.pitchNow),
      );
      const pivotStage = ch.anatomicalEyeStagePoint
        ? ch.anatomicalEyeStagePoint(this.tmpPivot, this.crouchAmount)
        : ch.eyePoint(this.tmpPivot, this.crouchAmount);
      this.tmpFlatForward.set(-Math.sin(this.yawNow), 0, -Math.cos(this.yawNow));
      this.tmpSide.set(Math.cos(this.yawNow), 0, -Math.sin(this.yawNow));

      const desiredStage = this.tmpDesired.copy(pivotStage);
      if (hood) {
        desiredStage.addScaledVector(this.tmpFlatForward, 0.72).addScaledVector(this.up, 0.24);
      } else if (cockpit) {
        desiredStage.addScaledVector(this.tmpFlatForward, 0.14).addScaledVector(this.up, 0.04);
      } else {
        const chaseBack = -(4.25 + 0.55 * this.driveSpeedRatio);
        const chaseUp = 1.12 + 0.12 * this.driveSpeedRatio;
        const lateralShift = this.orbitHold <= 0 ? this.driveLookAhead * 0.42 : 0;
        desiredStage
          .addScaledVector(forward, chaseBack)
          .addScaledVector(this.up, chaseUp)
          .addScaledVector(this.tmpSide, lateralShift);
      }

      const rayVec = this.tmpDir.copy(desiredStage).sub(pivotStage);
      const wantDist = rayVec.length();
      if (wantDist > 1e-4 && !this.passing) {
        rayVec.divideScalar(wantDist);
        const safeDist = this.cameraRig.sweepSphereStage(
          pivotStage,
          rayVec,
          wantDist,
          CAMERA_SPHERE_RADIUS,
          this.stage.matrixWorld,
          this.blockerMeshes,
        );
        this.tmpSafe.copy(pivotStage).addScaledVector(rayVec, safeDist);
      } else {
        this.tmpSafe.copy(desiredStage);
      }
      this.stage.localToWorld(this.tmpSafe);
      const pivotWorld = this.stage.localToWorld(this.tmpLocal.copy(pivotStage));

      if (!this.initialized || cockpit || hood) {
        this.camera.position.copy(this.tmpSafe);
        this.initialized = true;
      } else {
        const followRate = 7.8 + 1.8 * this.driveSpeedRatio;
        this.camera.position.lerp(this.tmpSafe, reduced ? 1 : 1 - Math.exp(-followRate * dt));
      }

      const look = this.tmpLook;
      if (chase) {
        const ahead = (2.5 + 2.2 * this.driveSpeedRatio) * scale;
        const cornerPreview = this.orbitHold <= 0 ? this.driveLookAhead * 0.85 * scale : 0;
        look
          .copy(pivotWorld)
          .addScaledVector(forward, ahead)
          .addScaledVector(this.tmpSide, cornerPreview)
          .addScaledVector(this.up, 0.16 * scale);
      } else {
        look.copy(this.camera.position).add(forward);
      }
      this.tmpMat.lookAt(this.camera.position, look, this.up);
      this.tmpQuat.setFromRotationMatrix(this.tmpMat);
      this.camera.quaternion.slerp(this.tmpQuat, reduced || cockpit || hood ? 1 : 1 - Math.exp(-13 * dt));

      const driveBaseFov = cockpit ? 66 : DRIVE_BASE_FOV;
      const targetDriveFov = this.zoom ? 20 : driveBaseFov + this.driveSpeedRatio * DRIVE_TOP_SPEED_FOV_BOOST;
      this.fovNow += (targetDriveFov - this.fovNow) * Math.min(1, dt * 8);
      this.camera.fov = this.fovNow;
      ch.setOwnView(cockpit);
      ch.root.visible = true;
      this.ownLimbNearClipped = false;
      this.cameraRig.snapTo('third', ch.root.position, 1.52, 2.15);
    } else {
      // On-Foot / Seated / Bicycle Unified 1st-Person and 3rd-Person Camera Embodiment Rig (`cameraRig.ts`)
      this.bob = ch.stridePhase() ?? this.bob;
      this.stoopK += ((onFootFirstPerson && !ch.body.seat ? 1 : 0) - this.stoopK) * (reduced ? 1 : 1 - Math.exp(-8 * dt));
      const bentNow = this.stoopK > 0.002 ? ch.rig?.bendNow : null;
      const stoopShift = bentNow ? reachEyeShift(bentNow, ch.lean) : null;
      const stoopRadians = bentNow ? Math.min(1.2, bentNow.pitch + ch.lean) * this.stoopK : 0;

      const eyeStage = ch.anatomicalEyeStagePoint
        ? ch.anatomicalEyeStagePoint(this.tmpPivot, this.crouchAmount)
        : ch.eyePoint(this.tmpPivot, this.crouchAmount);
      let eyeHeightAboveRoot = Math.max(0.42, eyeStage.y - ch.root.position.y);
      if (stoopShift) eyeHeightAboveRoot = Math.max(0.38, eyeHeightAboveRoot - stoopShift.down * this.stoopK);

      const useRawRootY =
        !ch.onFeet ||
        ch.publicPosture === 'airborne' ||
        Boolean(ch.body.seat) ||
        Boolean(ch.isDismountingSeat);
      const smoothedRootY = useRawRootY ? ch.root.position.y : this.elevationSpring.y;
      this.tmpEyeStagePos.set(eyeStage.x, smoothedRootY + eyeHeightAboveRoot, eyeStage.z);

      const sprintFovBoost = Math.min(1, Math.max(0, (this.speed - 1.8) / 1.5)) * 3;
      const fov1P = this.zoom ? 20 : this.reading ? 44 : 72 + sprintFovBoost;
      const fov3P = this.zoom ? 20 : this.reading ? 44 : 62;
      const targetMode = isThirdPerson ? 'third' : 'first';

      if (!this.initialized) {
        this.cameraRig.snapTo(targetMode, ch.root.position, eyeHeightAboveRoot, 2.15, this.tmpEyeStagePos);
        this.initialized = true;
      }

      const limbPts = this.ensureAvatarOwnLimbSetup(ch);
      const camOut = this.cameraRig.update(this.camera, {
        dt,
        viewMode: targetMode,
        reducedMotion: reduced,
        stageMatrixWorld: this.stage.matrixWorld,
        rootStagePos: ch.root.position,
        eyeStagePos: this.tmpEyeStagePos,
        smoothedRootY,
        eyeHeight: eyeHeightAboveRoot,
        yaw: this.yawNow,
        pitch: this.pitchNow,
        targetOrbitDistance: 2.15,
        shoulderOffset3P: this.passing ? 0 : 0.18,
        stoopRadians,
        planarSpeed: this.speed,
        stridePhase: this.bob,
        fovFirst: dlgFocusE > 0.001 ? T.MathUtils.lerp(fov1P, DIALOGUE_FOV_FIRST, dlgFocusE) : fov1P,
        fovThird: dlg3PE > 0.001 ? T.MathUtils.lerp(fov3P, DIALOGUE_FOV, dlg3PE) : fov3P,
        meshBlockers: this.passing ? undefined : this.blockerMeshes,
        ownLowerLimbWorldPoints: limbPts,
      });

      this.fovNow = this.camera.fov;
      this.ownLimbNearClipped = camOut.ownLimbNearClipped;
      ch.setOwnView(camOut.ownViewHeadHidden);
      ch.root.visible = camOut.characterVisible;
    }

    // Device screen close-up blend
    if (this.device) {
      const d = this.device;
      const devFov = 34;
      const tan = Math.tan(((devFov / 2) * Math.PI) / 180);
      const fill = 0.97;
      d.k = T.MathUtils.clamp(d.k + (d.dir * dt) / (reduced ? 0.01 : 0.72), 0, 1);
      if (d.k <= 0 && d.dir < 0) this.device = null;
      else {
        const dist = Math.max(d.h / 2 / (tan * fill), d.w / 2 / (tan * this.camera.aspect * fill));
        const e = this.deviceLevel;
        d.to.copy(d.center).addScaledVector(d.normal, dist);
        d.q.setFromRotationMatrix(this.tmpMat.makeBasis(d.right, d.up, d.normal));
        this.deviceShot = { position: d.to, quaternion: d.q, e };
        this.fovNow = T.MathUtils.lerp(this.fovNow, devFov, e);
        this.camera.fov = this.fovNow;
        this.camera.near = Math.min(this.camera.near, 0.02);
      }
    }

    // Portal doorway exit passage blend
    if (this.passage) {
      const p = this.passage;
      p.elapsed += dt;
      const k = reduced ? 1 : Math.min(1, p.elapsed / p.seconds);
      this.camera.position.lerpVectors(p.from, p.to, k * k * (3 - 2 * k));
    }

    // 3rd-person ONLY cinematic over-the-shoulder two-shot dialogue camera blend (`1P` stays at eye anchor!)
    const dlgSpeaker = this.dialogueTarget ?? this.lastDialogueTarget;
    if (isThirdPerson && dlg3PE > 0.001 && dlgSpeaker && !driving && !this.device) {
      ch.setOwnView(false);
      this.cameraRig.clearOwnLimbGuard();
      const eyeY = dlgSpeaker.eyeY ?? dlgSpeaker.y + 1.56;
      const spFwdX = Math.sin(dlgSpeaker.yaw);
      const spFwdZ = Math.cos(dlgSpeaker.yaw);
      const camRightX = Math.cos(dlgSpeaker.yaw);
      const camRightZ = -Math.sin(dlgSpeaker.yaw);

      this.tmpDlgPivot.set(dlgSpeaker.x, eyeY - 0.12, dlgSpeaker.z);
      this.tmpDlgLocal.set(
        dlgSpeaker.x + spFwdX * 1.95 + camRightX * 0.48,
        eyeY + 0.06,
        dlgSpeaker.z + spFwdZ * 1.95 + camRightZ * 0.48,
      );

      if (!this.passing) {
        const dlgRay = this.tmpDir.copy(this.tmpDlgLocal).sub(this.tmpDlgPivot);
        const dlgDist = dlgRay.length();
        if (dlgDist > 1e-4) {
          dlgRay.divideScalar(dlgDist);
          const safeD = this.cameraRig.sweepSphereStage(
            this.tmpDlgPivot,
            dlgRay,
            dlgDist,
            CAMERA_SPHERE_RADIUS,
            this.stage.matrixWorld,
            this.blockerMeshes,
          );
          this.tmpDlgPos.copy(this.tmpDlgPivot).addScaledVector(dlgRay, safeD);
        } else {
          this.tmpDlgPos.copy(this.tmpDlgLocal);
        }
      } else {
        this.tmpDlgPos.copy(this.tmpDlgLocal);
      }

      const safeDlgWorld = this.stage.localToWorld(this.tmpDlgSafe.copy(this.tmpDlgPos));
      this.tmpDlgLook.set(dlgSpeaker.x, eyeY - 0.34, dlgSpeaker.z);
      this.stage.localToWorld(this.tmpDlgLook);
      this.tmpMat.lookAt(safeDlgWorld, this.tmpDlgLook, this.up);
      this.tmpDlgQuat.setFromRotationMatrix(this.tmpMat);

      this.camera.position.lerp(safeDlgWorld, dlg3PE);
      this.camera.quaternion.slerp(this.tmpDlgQuat, dlg3PE);
    }

    if (this.device && this.deviceShot) {
      this.camera.position.lerp(this.deviceShot.position, this.deviceShot.e);
      this.camera.quaternion.slerp(this.deviceShot.quaternion, this.deviceShot.e);
    }

    const safeFovOffset = Number.isFinite(fovOffset) ? fovOffset : 0;
    if (safeFovOffset !== 0) {
      this.camera.fov = T.MathUtils.clamp(this.fovNow + safeFovOffset, this.zoom ? 18 : 24, 110);
    }
    this.syncProjection(false);
    this.camera.updateMatrixWorld();
    this.targetId = this.blocked ? null : this.host.target(this.camera);
    this.notify();
  }

  private refreshBlockerCache() {
    const roots = this.host.blockers();
    const encRev = this.host.enclosureVisRevision?.() ?? 0;
    let sig = `${roots.length}@${encRev}`;
    for (let i = 0; i < roots.length; i++) sig += '|' + roots[i].id;
    if (sig === this.blockerRootSig && this.blockerCacheAge < BLOCKER_CACHE_TTL) return;
    this.blockerRootSig = sig;
    this.blockerCacheAge = 0;
    const meshes = this.blockerMeshes;
    meshes.length = 0;
    let bvhBudget = 2;
    const visit = (object: T.Object3D) => {
      if (!object.visible) return;
      const ud = object.userData;
      if (ud && (ud.isDoorLeaf || ud.noCollision || ud.isTransformGizmo)) return;
      if ((object as T.Mesh).isMesh && !ud?.blob) {
        const mesh = object as T.Mesh;
        meshes.push(mesh);
        // Cooperatively attach `MeshBVH` to static architectural blocker meshes (<= 2 per cache refresh, 0 hitch).
        if (
          bvhBudget > 0 &&
          !(mesh as T.SkinnedMesh).isSkinnedMesh &&
          !(mesh as T.InstancedMesh).isInstancedMesh &&
          !mesh.morphTargetInfluences &&
          mesh.geometry
        ) {
          const geom = mesh.geometry as T.BufferGeometry & { boundsTree?: MeshBVH };
          if (!geom.boundsTree && geom.attributes.position && geom.attributes.position.count >= 12 && geom.attributes.position.count <= 24000) {
            geom.boundsTree = new MeshBVH(geom);
            bvhBudget--;
          }
        }
      }
      const children = object.children;
      for (let c = 0; c < children.length; c++) visit(children[c]);
    };
    for (let i = 0; i < roots.length; i++) {
      let rootVis = roots[i].visible;
      for (let p = roots[i].parent; p && rootVis; p = p.parent) {
        if (!p.visible) rootVis = false;
      }
      if (rootVis) visit(roots[i]);
    }
  }

  dispose() {
    this.disposed = true;
    this.clearOwnLimbGuard();
    if (this.origStageAdd) {
      this.stage.add = this.origStageAdd;
      this.origStageAdd = null;
    }
    this.observedCharRoot = null;
    this.release();
    this.mouseLook.dispose();
    this.blockerMeshes.length = 0;
    this.cachedLimbBones.length = 0;
    this.activeLimbPointList.length = 0;
    window.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('keyup', this.keyUp);
    window.removeEventListener('blur', this.release);
    this.canvas.removeEventListener('mousedown', this.mouseDown);
    document.removeEventListener('mouseup', this.mouseUp);
    document.removeEventListener('visibilitychange', this.visibility);
    document.removeEventListener('mousemove', this.mouse);
    this.canvas.removeEventListener('pointerdown', this.pointerDown);
    this.canvas.removeEventListener('pointermove', this.pointerMove);
    this.canvas.removeEventListener('pointerup', this.pointerUp);
    this.canvas.removeEventListener('pointercancel', this.pointerUp);
    this.canvas.removeEventListener('lostpointercapture', this.pointerUp);
    this.canvas.removeEventListener('pointerleave', this.pointerLeave);
    this.canvas.removeEventListener('contextmenu', this.noMenu);
    this.canvas.removeEventListener('auxclick', this.noMenu);
    this.canvas.removeEventListener('wheel', this.wheel);
  }
}

/**
 * Raycaster does not honour hidden ancestors; invisible cutaway walls must not obstruct. `forEyes`: what the eyes rest on, where a thing that is no
 * collider can still be looked at and chosen (`pickable`: the spines of the learner's books on a shelf).
 */
export function visibleMesh(object: T.Object3D, forEyes = false): boolean {
  if (!(object as T.Mesh).isMesh || object.userData.blob) return false;
  if (object.userData.noCollision && !(forEyes && object.userData.pickable)) return false;
  for (let parent: T.Object3D | null = object; parent; parent = parent.parent) if (!parent.visible) return false;
  return true;
}
