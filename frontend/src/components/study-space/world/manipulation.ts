import * as T from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { CROUCH } from '@/lib/embodiment/human';
import type { HandContact, GraspShape } from '@/lib/embodiment/human';
import type { Grip } from '@/lib/embodiment/fingers';
import { chime, contactSound, Scrape, slideSound } from '@/lib/embodiment/contactAudio';
import { CATALOG_BY_ID } from '@/lib/study-space/catalog';
import { actOf, actsFor, affordanceOf, graspFor, heldActs, type Act, type Verb } from '@/lib/study-space/affordances';
import {
  EXACT_UPRIGHT_MIN_UP_Y,
  SETTLE_UPRIGHT_MIN_UP_Y,
  applyAxisRotation3D,
  extractPreservedYaw,
  isSpaceObjectUpright,
  nextRotationAxis3D,
  normalizeSpaceObjectOrientation,
  resetSpaceObjectUprightPatch,
  uprightQuatFrom,
  worldUpYFromQuat,
  type RotationAxis3D,
} from '@/lib/study-space/orientation';
import {
  MIN_SEAT_UPRIGHT_DOT,
  validateSeatObject,
  type SeatObstacleVolume,
  type SeatValidationResult,
} from '@/lib/study-space/seatValidation';
import { inDoorThresholdEscapeZone } from '@/lib/echo-life/playerCollision';
import { BIN_ROOM, HANDLES, type Handle, PAN_ROOM, dip, isBin, isBucket, isRack, isSink, levelOf, massNow, rinse, spillAngle, toolOf, vesselOf, withLevel, wring } from '@/lib/study-space/tools';
import { CLEAN, MURKY, TEA, type Receiver, type Stream as WaterStream, type Tint, type WaterWorld } from './water/water';
import type { FluidShape } from './water/fluid';
import { onRack } from '@/lib/study-space/kit';
import { applyToolLook, ToolWork } from './toolWork';
import { graspable, meshShape, surfaceHit, surfaceNearest } from '@/lib/embodiment/grasp';
import { GraspFrame, fitGraspTranslation, type GraspReach } from '@/lib/embodiment/graspFrame';
import { alignWrist, reachableWrist, solveArm, wristStrain } from '@/lib/embodiment/arms';
import { handRotation } from '@/lib/embodiment/poses';
import type { LifeWorld } from './lifeWorld';
import { splash, waterRun } from '@/lib/embodiment/contactAudio';
import type { Activity, Layout, ObjectState, SpaceObject } from '@/lib/study-space/types';
import type { RoomNavigation } from '@/lib/study-space/navigation';
/** What a door needs to be for a hand to open it (the study doors and the Echo Life house doors both are). */
export interface LifeDoorLike {
  readonly id?: string;
  readonly plan?: { id: string; wallAlong: 'x' | 'z'; x: number; y: number; z: number; width: number; height: number };
  readonly passable?: boolean;
  readonly phase?: string;
  x?: number;
  handleWorld(out: T.Vector3): T.Vector3;
  setOpen(open: boolean): void;
  setAngle(angle: number | null): void;
  readonly isOpen: boolean;
  press(k: number): void;
  readonly angle: number;
  prepare(body: { x: number; z: number }): void;
  hinge(): { at: T.Vector3; leaf: T.Vector3; half: [number, number, number]; limits: [number, number]; open: number };
}
import type { WorldDestination } from '@/lib/study-space/exploration';
import { ActionPlan, Interactions, type Sequence } from './interactions';
import { StudyPhysics, loadStudyPhysics, physicsRoute, type Fit, type Mechanism } from './physics';
import { EffortGauge, feetOf, HUMAN, liftResistance, pushSpeed, slideResistance, type Resistance } from '@/lib/study-space/effort';
import { EffortMeter } from './effortMeter';
import { PlacementPreview } from './placement';
import { TransformGizmo3D } from './transformGizmo';
import { furnitureAnchor } from './furnitureAnchors';
import { StationBoard } from './stationBoard';
import { PART_NAME, partOf, stationNear, stationOf, type Station } from '@/lib/study-space/station';
import { shelfHoldsBooks, spineOfHit } from './shelfBooks';
import type { LibraryBook } from '@/lib/study-space/library';
import type { BookInfo } from '@/lib/study-space/types';
import type { BookSession } from '@/lib/study-space/bookSession';
import { OpenBook, type PickedWord } from './openBook';
import type { Slider } from './assets';
import type { RoomBuild } from './room';
import type { Exploration } from './exploration';
import { visibleMesh } from './exploration';
import type { Character } from './character';
import type { LightSpec } from './furniture';
import {
  BOX_A,
  BOX_B,
  M4_A,
  M4_B,
  M4_C,
  PLANE_A,
  Q_A,
  Q_B,
  Q_C,
  RAY_A,
  RAY_B,
  SPH_A,
  V2_A,
  V3_A,
  V3_B,
  V3_C,
  V3_D,
  V3_E,
  V3_F,
} from './echoLife/scratch';

export interface Placed { obj: SpaceObject; group: T.Group; blob: T.Mesh | null; key: string; lights: LightSpec[] }
export interface ManipHost {
  stage: T.Group;
  placed: Map<string, Placed>;
  layout(): Layout | null;
  character(): Character | null;
  navigation(): RoomNavigation | null;
  /** Active walkable space: `LifeWalk` across house & city while exploring Echo Life, else `navigation()`. */
  walkable?(): { free(p: { x: number; z: number }): boolean; motionFraction(a: { x: number; z: number }, b: { x: number; z: number }): number } | null;
  exploration: Exploration;
  room(): RoomBuild | null;
  /** Echo Life's house and city doors (`life:<id>` targets), opened with the same hand, lever and hinge as the study doors. */
  lifeDoor?(id: string): LifeDoorLike | null;
  /** All currently active Echo Life doors, so looking at an open doorway still targets its door to close it. */
  lifeDoors?(): readonly LifeDoorLike[];
  /** What the eyes may land on in the house (its walls hide what is behind them; its doors are targets). */
  lifeRoots?(): T.Object3D[];
  reduced(): boolean;
  identity(): string;
  /** The tool behind a thing: a panel, a route, the music. The hand has already touched it. */
  activate(id: string): void;
  objectState(id: string, patch: Partial<SpaceObject>, merge: string): void;
  spawn(obj: SpaceObject): void;
  window(open: boolean): void;
  curtains(k: number): void;
  wearing(accessory: string): boolean;
  wear(accessory: string, on: boolean): void;
  portal(destination: WorldDestination): void;
  use(id: string, activity?: Activity, hitWorld?: T.Vector3): boolean;
  standUp(): void;
  /** Where the body is left in the layout. */
  bodyMoved(): void;
  /** What stands on the floor changed outside the layout: a chair came up into the arms, and is no longer in the way where it stood. */
  navigationChanged?(): void;
  /** The eyes are at the screen of this thing: its desktop is the player's. */
  deviceOpen?(id: string): void;
  /** What this book or notebook really holds, from where it really lives. Null: nothing readable. */
  bookSession?(obj: SpaceObject): Promise<BookSession | null>;
  library?(): LibraryBook[];
  /** The shelf's list of the learner's own books is the player's to look through. */
  openLibrary?(shelf: string): void;
  despawn?(id: string): void;
  say(vi: string, en: string): void;
  /** The learner's language, for words drawn in the room (the strength meter). */
  vi?(): boolean;
  wake(): void;
  changed(): void;
  uid(): string;
  /** The room's surfaces. */
  life(): LifeWorld;
  /** Water in the air. */
  water(): WaterWorld;
  /** A tool's own wetness or fill: no step of Undo. */
  toolState(id: string, state: ObjectState, immediate?: boolean): void;
  /** What a mug, a bucket or a tool holds is told to the record of the room as it changes. */
  screenOpen?(): boolean;
  unreadMessages?(): { unread: number; invited: boolean };
}

/** What the HUD shows: real answers to what is under the eyes, what is in the hands, what the body is on its way to do. */
export interface InteractionState {
  target: string | null;
  targetKind: string | null;
  primary: Act | null;
  secondary: Act | null;
  /** What the G key does on this thing, when neither button already does it: a chair is sat on by the left button and carried by G. */
  grab: Act | null;
  more: Act[];
  held: string[];
  heldActs: Act[];
  inspecting: boolean;
  reading: boolean;
  /** The pages open in the hand. */
  bookPage: { at: number; of: number } | null;
  /** The open book, for the tools around it. */
  book: { title: string; note: string; canBilingual: boolean; bilingual: boolean; marked: boolean; words: boolean; ref: BookInfo | null } | null;
  /** The thing in the hands would go back on this shelf. */
  placeShelf: boolean;
  dragging: string | null;
  journey: WorldDestination | null;
  journeyStep: string | null;
  plan: string | null;
  placing: boolean;
  /** One state for the whole of the hands: nothing, on the way or reaching, carrying, moving furniture. */
  mode: 'idle' | 'busy' | 'carrying' | 'pushing';
  /** The physics engine: started with the room, ready before the first click needs it. */
  physics: 'idle' | 'loading' | 'ready' | 'failed';
  /** Where the eyes put the thing in the hands, and whether it fits there (and why not). */
  place: { ok: boolean; reason: { vi: string; en: string } | null } | null;
  /** What is held is flat enough to be stood on a side. */
  canStand: boolean;
  /** Furniture under the hands: what the floor demands and whether the body brings enough. */
  push: { id: string; kind: string; need: number; sliding: number; human: number; effortless: boolean; moving: boolean; blocked: boolean; pulling: boolean } | null;
  /** Clicks made while the body was still busy: kept, and done in order. */
  queued: number;
  /** A cleaning tool in the hands: what it is doing, and what is on it, in words only where nothing else shows it. */
  tool: { kind: string; pressing: boolean; touching: boolean; working: boolean } | null;
  /** A desk computer around what is under the eyes or in the hands, while it is still being put together. */
  station: { have: number; total: number; missing: { vi: string; en: string }[]; ready: boolean } | null;
  /** Active 360-degree 3-axis rotation axis (`'x' | 'y' | 'z'`) while carrying or inspecting. */
  rotAxis?: RotationAxis3D | null;
  /** True when the carried or aimed-at portable object is tilted and can be stood upright (`KeyR` / `'right-upright'`). */
  canResetUpright?: boolean;
  /** True when the interactive 3D rotation/translation gizmo (`KeyT`) is active. */
  gizmoActive?: boolean;
}

const UP = new T.Vector3(0, 1, 0);
const X_AXIS = new T.Vector3(1, 0, 0);
const Z_AXIS = new T.Vector3(0, 0, 1);
const UNIT_SCALE = new T.Vector3(1, 1, 1);
const SKIP_NON_GRASPABLE = (o: T.Object3D) => !graspable(o);

/** How far off a thing still answers the eyes: a few steps away, not across the room. */
const REACH = 3.2;
/** Standing direct reach (arm + natural trunk lean) without needing a walk approach. */
const DIRECT_PLACE_REACH = 1.38;
/** Seated direct reach before standing up automatically to place further away. */
const SEATED_PLACE_REACH = 1.25;
/** Maximum walk-and-place reach matching eye interaction reach (`REACH`). */
const MAX_PLACE_REACH = REACH;
/** Smooth arm-reach lower duration before guaranteed commit on a validated green preview. */
const VALIDATED_PLACE_COMMIT_SEC = .24;
/** Minimum torso front radius (metres at scale 1) + 0.08 m clearance margin so carried items never clip into chest/thighs. */
const BODY_FRONT_CLEARANCE_BASE = .175 + .08;

/** Narrow 6-ray screen-space / angular ring (~20-24 px / ~0.032 rad) around the center reticle for small/thin props. */
const ASSIST_RING_NDC: readonly [number, number][] = [
  [0.024, 0],
  [-0.024, 0],
  [0.012, 0.034],
  [-0.012, 0.034],
  [0.012, -0.034],
  [-0.012, -0.034],
];

// Dedicated module-scoped scratch pool for Manipulator hot loops (never aliased by raycastClosest).
const _mV1 = new T.Vector3();
const _mV2 = new T.Vector3();
const _mV3 = new T.Vector3();
const _mV4 = new T.Vector3();
const _mV5 = new T.Vector3();
const _mV6 = new T.Vector3();
const _mV7 = new T.Vector3();
const _mV8 = new T.Vector3();
const _mQ1 = new T.Quaternion();
const _mQ2 = new T.Quaternion();
const _mQ3 = new T.Quaternion();
const _mQ4 = new T.Quaternion();
const _mM1 = new T.Matrix4();
const _mM2 = new T.Matrix4();
const _mM3 = new T.Matrix4();
const _mBox1 = new T.Box3();
const _mRay1 = new T.Ray();
const _mAssistRoots: T.Object3D[] = [];

const TARGET_RAY = new T.Ray();
const TARGET_V1 = new T.Vector3();
const TARGET_V2 = new T.Vector3();
const TARGET_ROOTS: T.Object3D[] = [];
const TARGET_MESHES: T.Mesh[] = [];
const TARGET_HITS: T.Intersection[] = [];
type BvhGeo = T.BufferGeometry & { boundsTree?: MeshBVH; _bvhTried?: boolean };

function ensureMeshBvh(mesh: T.Mesh): boolean {
  const geo = mesh.geometry as BvhGeo | undefined;
  if (!geo || (mesh as T.SkinnedMesh).isSkinnedMesh || (mesh as T.InstancedMesh).isInstancedMesh) return false;
  if (geo.boundsTree) return true;
  if (geo._bvhTried) return false;
  const pos = geo.getAttribute('position');
  if (!pos) return false;
  const tris = (geo.index ? geo.index.count : pos.count) / 3;
  if (tris < 96) return false;
  geo._bvhTried = true;
  try {
    geo.boundsTree = new MeshBVH(geo, { maxLeafTris: 16 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Collects visible, bounding-sphere-intersecting meshes within `maxDist` of `ray` without descending into
 * hidden subtrees (`!node.visible`) or touching distant/non-interactive instanced/batched foliage & city meshes.
 */
function collectVisibleRayMeshes(
  node: T.Object3D,
  ray: T.Ray,
  maxDist: number,
  forEyes: boolean,
  skipCityGround: boolean,
  out: T.Mesh[],
): void {
  if (!node.visible) return;
  const mesh = node as T.Mesh;
  if (mesh.isMesh && !node.userData.blob) {
    const blockedByNoCollision = !!node.userData.noCollision && !(forEyes && node.userData.pickable);
    const nonInteractiveBatch =
      ((node as T.InstancedMesh).isInstancedMesh || (node as T.BatchedMesh).isBatchedMesh) &&
      !node.userData.objectId &&
      !node.userData.lifeDoor &&
      !node.userData.portal &&
      !node.userData.pickable;
    if (!blockedByNoCollision && !nonInteractiveBatch && !(skipCityGround && node.name === 'city-ground')) {
      const geo = mesh.geometry;
      if (geo) {
        if (!geo.boundingSphere) geo.computeBoundingSphere();
        if (geo.boundingSphere) {
          SPH_A.copy(geo.boundingSphere).applyMatrix4(mesh.matrixWorld);
          if (ray.origin.distanceTo(SPH_A.center) - SPH_A.radius <= maxDist && ray.intersectsSphere(SPH_A)) {
            out.push(mesh);
          }
        } else {
          out.push(mesh);
        }
      }
    }
  }
  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    collectVisibleRayMeshes(children[i], ray, maxDist, forEyes, skipCityGround, out);
  }
}

/** Runs a zero-allocation, BVH-accelerated closest-hit raycast over pre-filtered `TARGET_MESHES`. */
function raycastClosest(
  raycaster: T.Raycaster,
  roots: readonly T.Object3D[],
  maxDist: number,
  forEyes: boolean,
  skipCityGround: boolean,
): T.Intersection | undefined {
  TARGET_MESHES.length = 0;
  for (let i = 0; i < roots.length; i++) {
    collectVisibleRayMeshes(roots[i], raycaster.ray, maxDist, forEyes, skipCityGround, TARGET_MESHES);
  }
  let closest: T.Intersection | undefined;
  let bestDist = maxDist;
  const prevFar = raycaster.far;
  for (let i = 0; i < TARGET_MESHES.length; i++) {
    const mesh = TARGET_MESHES[i];
    const bs = mesh.geometry.boundingSphere;
    if (bs && bestDist < maxDist) {
      SPH_A.copy(bs).applyMatrix4(mesh.matrixWorld);
      if (raycaster.ray.origin.distanceTo(SPH_A.center) - SPH_A.radius > bestDist) continue;
    }
    raycaster.far = bestDist;
    TARGET_HITS.length = 0;
    if (ensureMeshBvh(mesh)) {
      acceleratedRaycast.call(mesh, raycaster, TARGET_HITS);
    } else {
      raycaster.intersectObject(mesh, false, TARGET_HITS);
    }
    for (let j = 0; j < TARGET_HITS.length; j++) {
      const h = TARGET_HITS[j];
      if (h.distance < bestDist && visibleMesh(h.object, forEyes)) {
        bestDist = h.distance;
        closest = h;
      }
    }
  }
  raycaster.far = prevFar;
  TARGET_MESHES.length = 0;
  TARGET_HITS.length = 0;
  return closest;
}

interface ManipDirtySnapshot {
  initialized: boolean;
  targetId: string | null;
  heldLen: number;
  held0: string | undefined;
  held1: string | undefined;
  inspecting: boolean;
  hasBook: boolean;
  pushId: string | undefined;
  pushMoving: boolean;
  pushBlocked: boolean;
  pushPulling: boolean;
  journeyTo: WorldDestination | null;
  planStep: string | null;
  hasPlaceAim: boolean;
  placeOk: boolean;
  placeReasonEn: string | undefined;
  hasPlaceStore: boolean;
  actionsBusy: boolean;
  physicsState: InteractionState['physics'];
  queueLen: number;
  hasPlacing: boolean;
  hasToolExtraction: boolean;
  hasWorkActive: boolean;
  rotAxis: RotationAxis3D | null;
  canResetUpright: boolean;
  gizmoActive: boolean;
}
const near3 = (a: T.Vector3, b: T.Vector3) => a.distanceTo(b);
/** Nobody kneels to water a plant: what stands low is poured into from where an arm comfortably is, and the water falls the rest of the way. */
const POUR_LOWEST = .66;
const POUR_HAND = .84;
/** The line of the knuckles against the bar, measured on the hand: index to little finger. */
const KNUCKLE_SIN = .246, KNUCKLE_COS = .969;
/** From a seat the arm and a lean get about this far: past it the body gets up. */

// Leave hip flexion available for a crouch while lowering a carried load.
// The stance planner and the moving torso must use the same hinge limit.
const PLACEMENT_BEND = { pitch: .95, drop: .75 };
const COVERS = new Set(['books.row', 'books.stack']);
/** What one free hand does while the other carries something: these never need the carried thing put down first. */
const FREE_HAND = new Set<Verb>(['open', 'close', 'pass', 'switch', 'lid', 'power', 'use', 'write', 'spin', 'flip', 'straighten', 'look-through', 'stroke']);

/**
 * How a long cleaning tool is carried, ready for work, in the body's own axes: the handle leaning back to
 * the hands, the head forward close to the floor (the tool's frame: head at the origin, handle along +Y, width along +X).
 * A web brush is carried the other way up (`carryReady`).
 */
function carryReady(kind: string, now: T.Quaternion, root: T.Quaternion) {
  // A web brush works above the head: it is carried head up, leaning forward over the hands (about 35 degrees, so its
  // 1.7 m stays under the ceiling), never head down like a broom it would have to turn end over end to use.
  // A broom or mop leans about 35 degrees: its upper grip, 1.3 m up the handle, is then at the chest with the head
  // just off the floor (upright, the hand had to go up past the head to keep the head off the floor).
  const web = kind === 'tool.webbrush', lean = web ? .6 : .62;
  // The smallest turn that brings the handle there from the way it is held now: the hands keep their grip on it (a
  // fixed upright frame rolled the shaft a quarter turn inside the palms, no wrist could follow and the lift stalled).
  const inBody = root.clone().invert().multiply(now);
  const axis = new T.Vector3(0, 1, 0).applyQuaternion(inBody), want = web ? new T.Vector3(0, -Math.cos(lean), -Math.sin(lean)) : new T.Vector3(0, Math.cos(lean), -Math.sin(lean));
  return new T.Quaternion().setFromUnitVectors(axis.normalize(), want).multiply(inBody);
}

export type ManipulationController = Manipulator;

export class Manipulator {
  physics: StudyPhysics | null = null;
  readonly work: ToolWork;
  readonly actions: Interactions;
  readonly plan = new ActionPlan();
  readonly lastHitWorld = new T.Vector3();
  private loading: Promise<StudyPhysics | null> | null = null;
  private targetId: string | null = null;
  private targetKind: string | null = null;
  private point = new T.Vector3();
  private hitWorld = new T.Vector3();
  private inspecting = false;
  private book: { open: OpenBook; host: T.Group; side: number; title: string } | null = null;
  private placing: {
    id: string;
    side: number;
    to: T.Vector3;
    bend?: typeof PLACEMENT_BEND;
    footShift?: T.Vector3;
    footprint?: (at: T.Vector3) => boolean;
    left: number;
    q: T.Quaternion;
    store?: { host: string; slot: number };
    rack?: string;
    gone?: boolean;
    done?: () => void;
    validatedSurface?: boolean;
    validatedElapsed?: number;
    result: 'moving' | 'placed' | 'failed' | 'cancelled';
    rackPath?: {
      rotation: T.Quaternion;
      target: T.Vector3;
      aligned: boolean;
      approach?: boolean;
      settleAt?: T.Vector3;
      footShift?: T.Vector3;
      route: T.Vector3[] | null;
      task: Generator<number, T.Vector3[] | null> | null;
      index: number;
      searched: number;
      ready: boolean;
      closest: number;
    };
  } | null = null;
  private placeAim: T.Vector3 | null = null;
  private saucerRotation: T.Quaternion | null = null;
  private placeStore: { host: string; slot: number } | null = null;
  private placeRayCacheValid = false;
  private placeRayHeldId = '';
  private placeRayOrigin = new T.Vector3();
  private placeRayDir = new T.Vector3();
  private placeRayPlayerPos = new T.Vector3();
  private placeRayQuat = new T.Quaternion();
  private placeRayGizmo = new T.Vector3();
  private placeRayTargetId: string | null = null;
  private placeRaySeat: string | null = null;
  private placeRayFreeHands = -1;

  private invalidatePlaceCache(): void {
    this.placeKey = '';
    this.placeRayCacheValid = false;
  }
  private carryFar = 0;
  /** Resting yaw of the held body relative to the character. */
  private carryYaw = 0;
  /** Deliberate rotation from this grasp's resting hand frame, independent of look yaw. */
  private handTurn = 0;
  private wristTurn: {
    id: string; side: number; anchor: GraspFrame; axis: T.Vector3; angle: number; far: number;
    start: T.Vector3; travelMix: number;
    arms: { side: number; shoulder: T.Vector3; elbow: T.Vector3; wrist: T.Vector3;
      fingers: T.Vector3; palm: T.Vector3; bend: number; roll: number }[];
  } | null = null;
  /** How it will stand once set down, in the room's own axes: the ghost holds still while the eyes move. The wheel, Q and E turn it. */
  private placeYaw = 0;
  /** Lying as it lay, or stood on one of its sides (a book upright on a shelf). */
  private placeTilt = 0;
  /** Full 360-degree 3-axis stage-space orientation for placement & ghost preview. */
  private placeGroupQuat = new T.Quaternion();
  /** Full 360-degree 3-axis carried orientation relative to `character.root.quaternion`. */
  private carryInBodyQuat = new T.Quaternion();
  /** Active 360-degree rotation axis (`'y' -> 'x' -> 'z'`). */
  private rotAxis: RotationAxis3D = 'y';
  private shiftDown = false;
  private gizmo: TransformGizmo3D | null = null;
  private gizmoActive = false;
  private gizmoOffset = new T.Vector3();
  private gizmoRaycaster = new T.Raycaster();
  private gizmoVirtualNdc = new T.Vector2();
  private gizmoWindowUpBound = false;
  private readonly onWindowGizmoUp = () => { this.endGizmoDrag(); };
  private turnHeld: { dir: number; wait: number } | null = null;
  /** The thing's size where it was picked up, and where it set off from into the hands. */
  private carried = new Map<string, { w: number; h: number; d: number }>();
  private grasps = new Map<string, Map<number, GraspFrame>>();
  /** Tool work may end at any tilt. Keep that orientation in the body's
   * frame instead of snapping back to the pose it had on the rack. */
  private toolCarryFrames = new Map<string, { rotation: T.Quaternion; turn: number; equipAfterLift?: boolean; departureOffset?: T.Vector3; useCanonical?: boolean }>();
  private carryGoals = new Map<string, { offset: T.Vector3; rotation: T.Quaternion }>();
  private carryIntent: { at: T.Vector3; yaw: number } | null = null;

  /** Pre-warms `TransformGizmo3D` and `PlacementPreview` shaders during scene boot (`0` runtime shader compiles). */
  warmupGizmoAndPreview(renderer: T.WebGLRenderer, _scene: T.Scene, camera: T.Camera): void {
    this.preview ??= new PlacementPreview();
    if (this.preview.group.parent !== this.host.stage) this.host.stage.add(this.preview.group);
    this.preview.warmup(renderer, camera);
    this.gizmo ??= new TransformGizmo3D();
    if (this.gizmo.group.parent !== this.host.stage) this.host.stage.add(this.gizmo.group);
    this.gizmo.warmup(renderer, camera);
  }

  /** The wrist solver can reach behind the shoulder. Also check whether the
   * physical prop can keep its place relative to a walking or turning torso. */
  carryMotionFraction(from: T.Vector3, to: T.Vector3, turn: number, maximum: number) {
    if (this.carryingTool) return maximum;
    if (this.work?.active) {
      const root = this.host.character()?.root;
      if (root) this.workIntent = { at: from.clone().lerp(to, maximum), yaw: root.rotation.y + turn * maximum };
      maximum = this.work.rootMotionFraction(from, to, turn, maximum);
    }
    if (!maximum || !this.carryGoals.size || (from.equals(to) && Math.abs(turn) < 1e-8)) return maximum;
    const physics = this.physics, ch = this.host.character();
    if (!physics || !ch) return maximum;
    let allowed = maximum;
    const expected = new T.Vector3(), root = new T.Vector3(), q = new T.Quaternion();
    for (const [id, goal] of this.carryGoals) {
      if (physics.sideOf(id) === null || this.placing?.id === id || this.work.active?.p.obj.id === id) continue;
      const center = physics.pointOf(id), orientation = physics.groupRotationOf(id);
      if (!center || !orientation) continue;
      const distance = (alpha: number) => {
        q.setFromAxisAngle(UP, ch.root.rotation.y + alpha * turn);
        expected.copy(goal.offset).applyQuaternion(q).add(root.lerpVectors(from, to, alpha));
        return Math.hypot(expected.x - center.x, expected.z - center.z);
      };
      const angle = (alpha: number) => q.setFromAxisAngle(UP, ch.root.rotation.y + alpha * turn).multiply(goal.rotation).angleTo(orientation);
      const maxDistance = Math.max(.035, distance(0) + 1e-7), maxAngle = Math.max(.10, angle(0) + 1e-7);
      const follows = (alpha: number) => distance(alpha) <= maxDistance && angle(alpha) <= maxAngle;
      if (follows(allowed)) continue;
      let lo = 0, hi = allowed;
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) * .5;
        if (follows(mid)) lo = mid; else hi = mid;
      }
      allowed = lo;
    }
    this.carryIntent = { at: from.clone().lerp(to, maximum), yaw: ch.root.rotation.y + maximum * turn };
    return allowed;
  }
  private toolExtraction: { id: string; rack?: string; start?: T.Vector3; rotation: T.Quaternion; route: T.Vector3[] | null; task: Generator<number, T.Vector3[] | null> | null; index: number; searched: number; stopped: boolean } | null = null;
  private rackRoutes = new Map<string, { rack: string; rackGroup: T.Object3D; toolGroup: T.Object3D; frame: T.Matrix4; rotation: T.Quaternion; points: T.Vector3[] }>();
  private intoHands: { id: string; t: number; from: T.Vector3; stalled: number; peak: number; fromQ?: T.Quaternion } | null = null;
  private dropCount = 0;
  private press: { button: number; at: number; startedTarget: string | null; dragged: boolean } | null = null;
  private drinking: { side: number; t: number } | null = null;
  private hugging = false;
  /** Furniture under both hands, moved by force through Rapier (`StudyPhysics.beginPush`). */
  private push: {
    id: string; p: Placed; riders: { p: Placed; local: T.Vector3; yaw: number }[]; grab: T.Vector3; gauge: EffortGauge | null;
    res: Resistance; since: number; yawTarget: number; merge: string; pulling: boolean; moving: boolean; blocked: boolean; sound: number; said: boolean;
    /** What the hands put on it this frame, and how high: the body answers it. */
    handF: T.Vector3; gripHeight: number;
    speedWas: number; goingWas: T.Vector3;
  } | null = null;
  /** What the legs ask this frame while pushing: a direction along the floor (stage axes), 0..1, and whether Shift is down. */
  private steerIntent = { x: 0, z: 0, running: false };
  private effortKey = false;
  private physicsState: InteractionState['physics'] = 'idle';
  private queue: { button: number; at: number }[] = [];
  private placeOk = false;
  private placeReason: { vi: string; en: string } | null = null;
  private placeSurface: { point: T.Vector3; normal: T.Vector3 } | null = null;
  private meter: EffortMeter | null = null;
  private scrape: Scrape | null = null;
  private meterAnchor = new T.Vector3();
  private preview: PlacementPreview | null = null;
  private drawer: { p: Placed; slider: Slider; mech: Mechanism | null; limit: number; from: number; to: number; pulling: boolean; manual: number; done: boolean; t: number } | null = null;
  private doorSequence = 0;
  private doorCooldown = new Map<string, number>();
  private doorMech: { id: string; mech: Mechanism; target: number; t: number } | null = null;
  /** A hand is still working this door (its hinge is driven): it is not at rest yet. */
  doorBusy(id: string) { return this.doorMech?.id === id; }
  /** A study door (Arena / Games) by destination, or an Echo Life house door by `life:<id>`. */
  private doorOf(id: string) { return id.startsWith('life:') ? this.host.lifeDoor?.(id.slice(5)) ?? null : this.host.room()?.door(id as WorldDestination) ?? null; }
  private journeyTo: WorldDestination | null = null;
  private passing: { to: T.Vector3; onThrough: () => void } | null = null;
  /** The body walked into an open doorway itself: the key it is holding is the going, not a change of mind. */
  private walkedIn = false;
  private lastDoorZ: number | null = null;
  private pendingLift: { id: string; side: number } | null = null;
  private wobbles = new Map<string, number>();
  private spins = new Map<string, number>();
  private frameCount = 0;
  private lastSnap: ManipDirtySnapshot | null = null;

  constructor(private host: ManipHost) {
    this.actions = new Interactions({
      rig: () => host.character()?.rig ?? null,
      // The eyes stay on what was clicked: the player chose it by looking at it, and under mouse-look the eyes are theirs.
      walkToward: (p, stop, dt) => host.exploration.walkToward(p, stop, dt, true),
      turnTo: (world, dt) => { const ch = host.character(); if (!ch?.ready || ch.body.occupied) return; const at = ch.root.getWorldPosition(new T.Vector3()); ch.turnBody(Math.atan2(world.x - at.x, world.z - at.z), dt); },
      reduced: host.reduced,
      distanceTo: p => { const r = host.character()?.root.position; return r ? Math.hypot(p.x - r.x, p.z - r.z) : Infinity; },
    });
    this.work = new ToolWork({
      stage: host.stage, character: () => host.character(), exploration: host.exploration, physics: () => this.physics, life: () => host.life(), reduced: host.reduced,
      saveState: (id, state) => host.toolState(id, state), object: id => host.placed.get(id)?.obj, handBusy: () => this.actions.busy,
      preparing: () => !!this.toolExtraction,
      fitPose: (p, side, position, rotation, dt) => {
        const physics = this.physics;
        if (!physics) return { position: p.group.position.clone(), rotation: p.group.quaternion.clone() };
        const extraction = this.extractTool(p);
        const center = extraction?.center ?? physics.centreFor(p.obj.id, position, rotation, new T.Vector3());
        const pose = this.constrainHeldPose(p, center, extraction?.rotation ?? rotation, dt, true);
        const q0 = physics.startOf(p.obj.id) ?? new T.Quaternion();
        const at = physics.poseAt(p.obj.id, pose.center, pose.rotation.clone().multiply(q0.clone().invert()));
        return { position: at?.position ?? p.group.position.clone(), rotation: pose.rotation };
      },
    });
  }

  // ── Physics on demand ───────────────────────────────────────────────────────────────────────────────
  ensurePhysics(): Promise<StudyPhysics | null> {
    if (this.physics) return Promise.resolve(this.physics);
    if (this.loading) return this.loading;
    const identity = this.host.identity();
    this.physicsState = 'loading'; this.host.changed();
    this.loading = loadStudyPhysics().then(R => {
      if (identity !== this.host.identity()) return null;
      const physics = new StudyPhysics(R, (id, pos, yaw, tilt) => {
        if (identity !== this.host.identity() || !this.host.placed.has(id)) return;
        // A ball of paper that came to rest in a bin is in the bin.
        if (this.landedInBin(id, pos)) return;
        // One thing set down is one step of Undo.
        this.host.objectState(id, { pos, rotY: yaw, quat: tilt ?? undefined }, `drop-${id}-${++this.dropCount}`);
        this.carried.delete(id);
        this.host.navigationChanged?.();
      });
      physics.onWoken = id => { const p = this.host.placed.get(id); if (p?.blob) p.blob.visible = false; this.host.navigationChanged?.(); };
      physics.onBodyHit = (id, vx, vz, kg) => {
        // It hit the body: the body answers in proportion, and a light thing just bounces off.
        const rig = this.host.character()?.rig, m = this.host.character()?.bodyKg ?? 60;
        if (rig) rig.bump(vx * kg / m * this.k, vz * kg / m * this.k);
        const p = this.host.placed.get(id);
        if (p) contactSound(affordanceOf(p.obj.kind).material, Math.min(1, Math.hypot(vx, vz) / 3), .35);
      };
      physics.onImpact = (id, speed) => {
        const p = this.host.placed.get(id);
        if (p) { contactSound(affordanceOf(p.obj.kind).material, Math.min(1, speed / 2.4), this.hearing(p.group.position)); this.spillOnImpact(p, speed); }
      };
      this.physics = physics;
      this.physicsState = 'ready';
      this.syncRoom();
      this.host.changed();
      return physics;
    }).catch(() => {
      this.physicsState = 'failed'; this.host.changed();
      window.dispatchEvent(new Event('study:physics-unavailable'));
      return null;
    }).finally(() => { this.loading = null; });
    return this.loading;
  }
  /** After a real failure: one more start, from the player's own button. Nothing in the room is touched by trying. */
  retryPhysics() { if (!this.physics && !this.loading) void this.ensurePhysics(); }
  /** The room's furniture changed: what falls has to land on what is there now. */
  syncRoom() {
    const l = this.host.layout();
    if (!l || !this.physics) return;
    this.physics.sync([...this.host.placed.values()], l.room.size);
    this.invalidatePlaceCache();
    const room = this.host.room();
    this.physics.roomSurfaces(room?.group ?? null, room ? JSON.stringify({ ...l.room, windowOpen: undefined, curtains: undefined }) : '');
    this.judgeStations();
  }
  private hearing(stagePoint: T.Vector3) {
    _mV1.copy(stagePoint);
    this.host.stage.localToWorld(_mV1);
    return _mV1.distanceTo(this.host.exploration.camera.position);
  }
  private toStage(world: T.Vector3, out?: T.Vector3) {
    const dst = out ? out.copy(world) : world.clone();
    return this.host.stage.worldToLocal(dst);
  }
  private get k() { return this.host.stage.scale.x; }

  // ── What is under the eyes ──────────────────────────────────────────────────────────────────────────
  rayHitDistance = Infinity;
  target(camera: T.PerspectiveCamera): string | null {
    const ch = this.host.character();
    if (!ch?.ready) return this.setTarget(null, null);
    const k = this.k;
    const chPos = ch.root.position;
    ch.root.getWorldPosition(V3_A);
    const camToBody = camera.position.distanceTo(V3_A);
    const maxWorldReach = camToBody + (REACH + 1.5) * k;

    RAY_A.near = 0;
    RAY_A.far = maxWorldReach;
    RAY_A.setFromCamera(this.host.exploration.aim, camera);

    const heldIds = this.physics?.heldIds ?? [];
    const heldFirst = heldIds[0] ? this.host.placed.get(heldIds[0]) : null;
    const holdingTool = Boolean(heldFirst && toolOf(heldFirst.obj.kind));
    const layout = this.host.layout();
    const room = this.host.room();
    const roomSize = layout?.room.size ?? 6;
    const bodyDistFromRoom = Math.hypot(chPos.x, chPos.z);
    // Skip raycasting Study Room furniture & room shell when far outside the house (> 14 m from room center).
    const nearStudyRoom = bodyDistFromRoom <= Math.max(14, roomSize + REACH + 4) && Math.abs(chPos.y) < 3.6;

    TARGET_ROOTS.length = 0;
    if (nearStudyRoom) {
      const placedMaxDist = REACH + 2.8;
      for (const p of this.host.placed.values()) {
        if (p.obj.hidden || heldIds.includes(p.obj.id)) continue;
        if (Math.hypot(p.group.position.x - chPos.x, p.group.position.z - chPos.z) > placedMaxDist) continue;
        TARGET_ROOTS.push(p.group);
      }
      if (room) TARGET_ROOTS.push(room.group);
    }
    const lifeRoots = this.host.lifeRoots?.();
    if (lifeRoots) {
      for (let i = 0; i < lifeRoots.length; i++) TARGET_ROOTS.push(lifeRoots[i]);
    }

    // Skip raycasting static city-ground slabs when empty-handed (never a target unless placing a held item).
    const skipCityGround = heldIds.length === 0 || chPos.y > -1.5 || RAY_A.ray.direction.y > -0.02;
    const hit = raycastClosest(RAY_A, TARGET_ROOTS, maxWorldReach, true, skipCityGround);
    TARGET_ROOTS.length = 0;
    RAY_A.far = Infinity;

    this.rayHitDistance = hit?.distance ?? Infinity;
    if (hit) { this.hitWorld.copy(hit.point); this.lastHitWorld.copy(hit.point); this.point.copy(hit.point); }

    const stageInv = M4_A.copy(this.host.stage.matrixWorld).invert();
    const near = (world: T.Vector3) => {
      V3_B.copy(world).applyMatrix4(stageInv);
      return Math.hypot(V3_B.x - chPos.x, V3_B.z - chPos.z) <= REACH;
    };

    const under = hit?.object.userData.objectId ? this.host.placed.get(hit.object.userData.objectId as string) : null;

    // Open-frame rack assist when holding a cleaning tool: `rack.cleaning` is mostly open air between thin posts,
    // so aiming at the middle of the rack otherwise hits the wall behind it instead of offering `Hang it back`.
    if (nearStudyRoom && holdingTool && !(under && isRack(under.obj.kind))) {
      let bestRack: Placed | null = null;
      let bestRackDist = Infinity;
      for (const q of this.host.placed.values()) {
        if (q.obj.hidden || !isRack(q.obj.kind)) continue;
        if (Math.hypot(q.group.position.x - chPos.x, q.group.position.z - chPos.z) > REACH + 0.6) continue;
        q.group.updateWorldMatrix(true, false);
        _mM1.copy(q.group.matrixWorld).invert();
        _mRay1.copy(RAY_A.ray).applyMatrix4(_mM1);
        _mBox1.copy(this.ownBox(q)).expandByScalar(.09);
        if (!_mRay1.intersectBox(_mBox1, _mV1)) continue;
        _mV1.applyMatrix4(q.group.matrixWorld);
        const rackHitDist = RAY_A.ray.origin.distanceTo(_mV1);
        if (hit && rackHitDist > hit.distance + .32 * k) continue;
        if (!near(_mV1)) continue;
        if (rackHitDist < bestRackDist) {
          bestRackDist = rackHitDist;
          bestRack = q;
          _mV2.copy(_mV1);
        }
      }
      if (bestRack) {
        this.hitWorld.copy(_mV2);
        this.lastHitWorld.copy(_mV2);
        this.point.copy(_mV2);
        return this.setTarget(bestRack.obj.id, bestRack.obj.kind);
      }
    }

    const underAff = under ? affordanceOf(under.obj.kind) : null;
    const directPortableUnder = Boolean(
      under &&
      underAff &&
      underAff.mobility === 'portable' &&
      !underAff.seat &&
      underAff.family !== 'table',
    );

    // Forgiving shaft-segment + narrow 6-ray bundle + OBB proximity assist for thin tools (~1.2 cm broom shafts),
    // cups/mugs, thin books, plant pots (1-hand and 2-hand), lamps, and small props when empty-handed.
    if (nearStudyRoom && !heldIds.length && !directPortableUnder) {
      const hitRack = under && isRack(under.obj.kind) ? under : null;

      // 1) Exact 3D shaft-segment check for all visible cleaning tools (on rack, leaning on a wall, or on the floor).
      let bestTool: Placed | null = null;
      let bestToolScore = hitRack ? .26 * k : Infinity;
      for (const q of this.host.placed.values()) {
        const spec = toolOf(q.obj.kind);
        if (!spec || q.obj.hidden || q.obj.locked) continue;
        if (Math.hypot(q.group.position.x - chPos.x, q.group.position.z - chPos.z) > REACH + 1.35) continue;
        q.group.updateWorldMatrix(true, false);
        q.group.getWorldPosition(V3_C);
        V3_D.set(0, Math.max(.18, spec.length), 0).applyMatrix4(q.group.matrixWorld);
        const d = Math.sqrt(RAY_A.ray.distanceSqToSegment(V3_C, V3_D, TARGET_V1, TARGET_V2));
        const along = TARGET_V1.distanceTo(RAY_A.ray.origin);
        const onHitRack = Boolean(hitRack && q.group.position.distanceTo(hitRack.group.position) <= .75 * k);
        if (!onHitRack && hit && along > hit.distance + .18 * k) continue;
        if (!near(TARGET_V2)) continue;
        const maxRad = onHitRack ? .26 * k : (.054 + along * .016) * k;
        if (d <= maxRad && d < bestToolScore) {
          bestToolScore = d;
          bestTool = q;
          _mV3.copy(TARGET_V2);
        }
      }
      if (bestTool) {
        this.hitWorld.copy(_mV3);
        this.lastHitWorld.copy(_mV3);
        this.point.copy(_mV3);
        return this.setTarget(bestTool.obj.id, bestTool.obj.kind);
      }

      // 2) Gather nearby portable non-furniture props for narrow 6-ray cone + OBB closest-point assist.
      _mAssistRoots.length = 0;
      let bestProp: Placed | null = null;
      let bestPropScore = Infinity;

      for (const p of this.host.placed.values()) {
        if (p.obj.hidden || p.obj.locked) continue;
        if (Math.hypot(p.group.position.x - chPos.x, p.group.position.z - chPos.z) > REACH + 1.2) continue;
        const a = affordanceOf(p.obj.kind);
        if (a.mobility !== 'portable' || a.seat || a.family === 'table') continue;
        // Skip items inside a closed drawer; keep items inside an open drawer pickable.
        if (p.obj.inside) {
          const hostDrawer = this.host.placed.get(p.obj.inside.host);
          const slider = (hostDrawer?.group.userData.sliders as Slider[] | undefined)?.[p.obj.inside.slot];
          if (!slider || slider.open <= .45) continue;
        }
        _mAssistRoots.push(p.group);

        // OBB closest-point proximity check (accurate across tall plants, wide book rows, thin notebooks, and small mugs).
        const own = this.ownBox(p);
        if (own.isEmpty()) continue;
        p.group.updateWorldMatrix(true, false);
        _mM1.copy(p.group.matrixWorld).invert();
        _mRay1.copy(RAY_A.ray).applyMatrix4(_mM1);
        if (_mRay1.intersectBox(own, _mV1)) {
          _mV1.applyMatrix4(p.group.matrixWorld);
        } else {
          own.getCenter(_mV2).applyMatrix4(p.group.matrixWorld);
          RAY_A.ray.closestPointToPoint(_mV2, _mV4);
          _mV1.copy(_mV4).applyMatrix4(_mM1).clamp(own.min, own.max).applyMatrix4(p.group.matrixWorld);
        }
        const along = RAY_A.ray.closestPointToPoint(_mV1, _mV4).distanceTo(RAY_A.ray.origin);
        if (hit && along > hit.distance + .14 * k) continue;
        const off = _mV4.distanceTo(_mV1);
        const catSize = CATALOG_BY_ID[p.obj.kind]?.size;
        const sizeBonus = Math.min(.042, Math.max(catSize?.[0] ?? .1, catSize?.[1] ?? .1) * .28);
        const maxOff = (.028 + along * .014 + sizeBonus) * k;
        if (off <= maxOff && off < bestPropScore && near(_mV1)) {
          bestPropScore = off;
          bestProp = p;
          _mV5.copy(_mV1);
        }
      }

      // 3) Narrow 6-ray angular bundle (~22 px / ~0.032 rad ring around reticle) with clear line-of-sight occlusion guard.
      if (_mAssistRoots.length > 0) {
        const baseAim = this.host.exploration.aim;
        const occluderLimit = hit ? hit.distance + .10 * k : maxWorldReach;
        RAY_B.near = 0;
        for (let rIdx = 0; rIdx < ASSIST_RING_NDC.length; rIdx++) {
          const [dxNdc, dyNdc] = ASSIST_RING_NDC[rIdx];
          V2_A.set(baseAim.x + dxNdc, baseAim.y + dyNdc);
          RAY_B.far = occluderLimit;
          RAY_B.setFromCamera(V2_A, camera);
          const ringHit = raycastClosest(RAY_B, _mAssistRoots, occluderLimit, true, true);
          if (!ringHit || !near(ringHit.point)) continue;
          const hitId = ringHit.object.userData.objectId as string | undefined;
          const ringPlaced = hitId ? this.host.placed.get(hitId) : null;
          if (!ringPlaced) continue;
          const off = RAY_A.ray.distanceToPoint(ringHit.point);
          if (off < bestPropScore) {
            bestPropScore = off;
            bestProp = ringPlaced;
            _mV5.copy(ringHit.point);
          }
        }
        RAY_B.far = Infinity;
        _mAssistRoots.length = 0;
      }

      if (bestProp) {
        this.hitWorld.copy(_mV5);
        this.lastHitWorld.copy(_mV5);
        this.point.copy(_mV5);
        return this.setTarget(bestProp.obj.id, bestProp.obj.kind);
      }
    }
    if (hit?.object.userData.curtain && near(hit.point) && layout) return this.setTarget('curtain:main', 'curtain');
    // The view lies a little beyond the glass: what counts is how far the body is from the window itself.
    if (hit?.object.userData.roomWindow && layout) {
      V3_B.copy(hit.point).applyMatrix4(stageInv);
      if (Math.hypot(V3_B.x - chPos.x, -layout.room.size / 2 - chPos.z) <= REACH) return this.setTarget('window:main', 'window');
    }
    const localRay = TARGET_RAY.copy(RAY_A.ray).applyMatrix4(stageInv);
    if (nearStudyRoom && room && layout?.room.wallRight) {
      const half = layout.room.size / 2;
      PLANE_A.set(V3_C.set(0, 0, -1), half);
      const at = localRay.intersectPlane(PLANE_A, V3_D);
      if (at && at.y > .1 && at.y < 2.45 && Math.hypot(at.x - chPos.x, at.z - chPos.z) <= REACH) {
        const x0 = -layout.room.size * .23, x1 = layout.room.size * .23;
        const center = Math.abs(at.x - x0) < .58 ? 0 : Math.abs(at.x - x1) < .58 ? 1 : -1;
        if (center >= 0) {
          const distance = RAY_A.ray.origin.distanceTo(TARGET_V1.copy(at).applyMatrix4(this.host.stage.matrixWorld));
          if (!hit || hit.distance >= distance - .22 * k || hit.object.userData.portal) return this.setTarget(center === 0 ? 'portal:arena' : 'portal:games', 'door');
        }
      }
    }
    // Echo Life doors (house & enterable city buildings): an open leaf swings clear of its opening, so aiming at the doorway
    // itself targets the door (matching the study portal doors above) whenever no closer object blocks it.
    const lifeDoors = this.host.lifeDoors?.();
    if (lifeDoors?.length) {
      let bestDoorId: string | null = null;
      let bestDoorDist = Infinity;
      for (let i = 0; i < lifeDoors.length; i++) {
        const ld = lifeDoors[i];
        const dp = ld.plan;
        if (!dp) continue;
        // Anti-self-close threshold guard: ignore the synthetic doorway plane while standing in an open doorway threshold!
        if (
          (ld.isOpen || ld.phase === 'open' || ld.phase === 'occupied') &&
          inDoorThresholdEscapeZone(chPos, dp as Parameters<typeof inDoorThresholdEscapeZone>[1], 0.40)
        ) {
          continue;
        }
        if (Math.hypot(dp.x - chPos.x, dp.z - chPos.z) > REACH + 1.2) continue;
        if (Math.abs(dp.y - chPos.y) > 2.2) continue;
        if (dp.wallAlong === 'z') PLANE_A.set(V3_C.set(1, 0, 0), -dp.x);
        else PLANE_A.set(V3_C.set(0, 0, 1), -dp.z);
        const at = localRay.intersectPlane(PLANE_A, V3_D);
        if (!at) continue;
        const along = dp.wallAlong === 'z' ? Math.abs(at.z - dp.z) : Math.abs(at.x - dp.x);
        if (along > dp.width / 2 + .08 || at.y < dp.y + .05 || at.y > dp.y + dp.height + .08) continue;
        if (Math.hypot(at.x - chPos.x, at.z - chPos.z) > REACH) continue;
        const dist = RAY_A.ray.origin.distanceTo(TARGET_V1.copy(at).applyMatrix4(this.host.stage.matrixWorld));
        if (!hit || hit.distance >= dist - .22 * k || hit.object.userData.lifeDoor === dp.id) {
          if (dist < bestDoorDist) { bestDoorDist = dist; bestDoorId = dp.id; }
        }
      }
      if (bestDoorId) return this.setTarget(`life:${bestDoorId}`, 'door');
    }
    if (!hit || !near(hit.point)) return this.setTarget(null, null);
    const portal = hit.object.userData.portal as WorldDestination | undefined;
    if (portal) return this.setTarget(`portal:${portal}`, 'door');
    const lifeDoor = hit.object.userData.lifeDoor as string | undefined;
    if (lifeDoor) return this.setTarget(`life:${lifeDoor}`, 'door');
    const id = hit.object.userData.objectId as string | undefined, p = id ? this.host.placed.get(id) : null;
    if (!p) return this.setTarget(null, null);
    const spine = spineOfHit(hit);
    if (spine && !heldIds.length) return this.setTarget(`shelfbook:${id}:${spine.book.key}`, 'shelfbook');
    const sliders = p.group.userData.sliders as Slider[] | undefined;
    if (sliders) for (let n: T.Object3D | null = hit.object; n && n !== p.group; n = n.parent) {
      const index = sliders.findIndex(s => s.node === n);
      if (index >= 0) return this.setTarget(`drawer:${id}:${index}`, 'drawer');
    }
    return this.setTarget(id!, p.obj.kind);
  }
  private setTarget(id: string | null, kind: string | null) { this.targetId = id; this.targetKind = kind; return id; }

  /** The rim of an open thing, in the room's axes, and the way out over it. */
  private lipOf(p: Placed, out: T.Vector3, dir?: T.Vector3) {
    const v = vesselOf(p.obj.kind)!;
    p.group.updateWorldMatrix(true, false);
    out.set(v.lip[0], v.lip[1], v.lip[2]).applyMatrix4(p.group.matrixWorld);
    this.host.stage.worldToLocal(out);
    if (dir) dir.set(v.lip[0], 0, v.lip[2]).normalize().applyQuaternion(p.group.getWorldQuaternion(new T.Quaternion()));
    return out;
  }
  /** Hit the floor with something in it: what it held is now on the floor. */
  private spillOnImpact(p: Placed, speed: number) {
    if (speed < .85) return;
    const st = p.obj.state, { x, z } = p.group.position, life = this.host.life(), water = this.host.water();
    const v = vesselOf(p.obj.kind);
    if (v && levelOf(p.obj.kind, st) > .02) {
      // What it held goes out of it at the moment it hits, the way it was going: as much of it as jumps out.
      const level = levelOf(p.obj.kind, st), out = Math.min(1, .35 + speed * .25) * level * v.litres;
      splash(Math.min(1, out * .35 + .2));
      const at = this.lipOf(p, new T.Vector3());
      water.burst(at, new T.Vector3((Math.random() - .5) * .8, .25, (Math.random() - .5) * .8), out, (st?.dirt ?? 0) > .2 ? MURKY : CLEAN);
      this.host.toolState(p.obj.id, withLevel(p.obj.kind, st, level - out / v.litres));
      void x; void z; void life;
    } else if (p.obj.kind === 'tool.dustpan' && (st?.fill ?? 0) > .02) {
      // All that was in it, back on the floor around it.
      const amount = (st!.fill ?? 0) * PAN_ROOM;
      life.floor?.stamp('dust', x, z, .32, amount * .5, 3);
      life.puffs.emit(x, .05, z, 6, 'dust');
      this.host.toolState(p.obj.id, { ...st, fill: 0 });
    }
  }
  private landedInBin(id: string, pos: [number, number, number]) {
    const p = this.host.placed.get(id);
    if (p?.obj.kind !== 'trash.paper') return false;
    for (const b of this.host.placed.values()) {
      if (!isBin(b.obj.kind) || b.obj.hidden) continue;
      if (Math.hypot(pos[0] - b.group.position.x, pos[2] - b.group.position.z) < .17 && pos[1] < .36) {
        contactSound('paper', .45, this.hearing(b.group.position));
        this.addToBin(b, .02);
        this.host.despawn?.(id);
        return true;
      }
    }
    return false;
  }
  private addToBin(b: Placed, share: number) { this.host.toolState(b.obj.id, { ...b.obj.state, fill: Math.min(1, (b.obj.state?.fill ?? 0) + share) }); }
  /** The eyes' ray, in the room's own coordinates. */
  private aimRay() {
    const ray = new T.Raycaster(); ray.setFromCamera(this.host.exploration.aim, this.host.exploration.camera);
    const r = ray.ray.clone().applyMatrix4(this.host.stage.matrixWorld.clone().invert());
    r.direction.normalize();
    // From behind the shoulder the camera is two metres from the hands. The line of sight counts from where it passes the body, so reach stays the body's reach.
    const ch = this.host.character();
    if (this.host.exploration.view === 'third' && ch?.ready) {
      const eye = ch.eyePoint(new T.Vector3(), this.host.exploration.crouchAmount), along = eye.sub(r.origin).dot(r.direction);
      if (along > 0) r.origin.addScaledVector(r.direction, along);
    }
    return r;
  }
  /** What the thing in the hands can do with what the eyes are on. Left and right buttons. Null: the tool just works. */
  private careVerb(button: number): Verb | null {
    const physics = this.physics, id = physics?.heldIds[0], held = id ? this.host.placed.get(id) : null, under = this.targetId ? this.host.placed.get(this.targetId) : null;
    const kind = held?.obj.kind, t = under?.obj.kind ?? '';
    if (!held) return null;
    const left = button === 0;
    if (toolOf(kind)) {
      if (isRack(t) && left) return 'hang';
      if ((kind === 'tool.mop' || kind === 'tool.cloth') && isBucket(t)) return left ? 'dip' : 'wring';
      if ((kind === 'tool.mop' || kind === 'tool.cloth') && isSink(t) && left) return 'rinse';
      if (kind === 'tool.dustpan' && isBin(t) && left) return 'empty';
      return null;
    }
    // What holds water is filled at the tap and pours where it is asked: into another vessel, over a plant, down the sink.
    if (vesselOf(kind)) {
      const has = levelOf(kind!, held.obj.state) > .01;
      if (isSink(t)) return left ? 'fill' : has ? 'pour' : null;
      if (under && under !== held && has && left && (vesselOf(t) || affordanceOf(t).family === 'plant')) return 'pour';
    }
    // A lamp is mostly air: a dead one near where the eyes rest is the one meant.
    if (kind === 'bulb.spare' && left && this.lampNearEyes()) return 'change-bulb';
    if (kind === 'trash.paper' && isBin(t) && left) return 'discard';
    if (kind === 'trash.bag' && left && this.targetId?.startsWith('portal:')) return 'bag-out';
    return null;
  }
  private lampNearEyes() {
    let best: Placed | null = null, near = .3 * this.k;
    RAY_A.near = 0;
    RAY_A.far = Infinity;
    RAY_A.setFromCamera(this.host.exploration.aim, this.host.exploration.camera);
    for (const p of this.host.placed.values()) {
      if (!p.obj.state?.burnt || p.obj.hidden) continue;
      if (this.targetId === p.obj.id) return p;
      BOX_A.setFromObject(p.group).getCenter(V3_C);
      const d = RAY_A.ray.distanceToPoint(V3_C);
      if (d < near && near3(V3_C, RAY_A.ray.origin) < REACH * this.k) { near = d; best = p; }
    }
    return best;
  }
  /** How a care verb reads on what the eyes are on. */
  private careAct(verb: Verb) {
    const t = this.targetId ? this.host.placed.get(this.targetId)?.obj.kind ?? '' : '';
    if (verb === 'pour') return affordanceOf(t).family === 'plant' ? actOf('pour', 'Tưới cây', 'Water it') : isSink(t) ? actOf('pour', 'Đổ đi', 'Pour it away') : actOf('pour', 'Rót vào', 'Pour it in');
    return actOf(verb);
  }
  private hands() {
    const physics = this.physics, right = physics?.heldIn(1) ?? null, left = physics?.heldIn(-1) ?? null;
    return { right, left, free: (right ? 0 : 1) + (left ? 0 : 1), kinds: [right, left].filter((x): x is string => !!x).map(id => this.host.placed.get(id)?.obj.kind ?? '').filter(Boolean) };
  }
  /** Evaluates full physical seat readiness (`<= 15 deg` upright, resting, floor-supported, unobstructed cushion, walkable front approach). */
  validateSeat(id: string, hitWorld?: T.Vector3 | null): SeatValidationResult | null {
    const p = this.host.placed.get(id);
    return p ? this.validatePlacedSeat(p, hitWorld) : null;
  }

  /** Resolves the exact cushion slot and front-hemisphere stand approaches for multi-slot furniture using `hitWorld`. */
  resolveSeatAnchor(id: string, lie: boolean, side = 1, hitWorld?: T.Vector3 | null) {
    const p = this.host.placed.get(id);
    if (!p) return null;
    return furnitureAnchor(p.obj, p.group, lie, side, hitWorld ?? this.lastHitWorld);
  }

  private validatePlacedSeat(p: Placed, hitWorld?: T.Vector3 | null): SeatValidationResult {
    const item = CATALOG_BY_ID[p.obj.kind];
    const ch = this.host.character();
    const walk = this.host.walkable?.() ?? this.host.navigation();
    const walkGroundAt =
      walk && 'groundAt' in walk && typeof (walk as { groundAt?: unknown }).groundAt === 'function'
        ? ((walk as { groundAt: (x: number, z: number) => number | null }).groundAt.bind(walk))
        : undefined;
    const groundSampler = walkGroundAt ?? (ch ? (x: number, z: number) => ch.floorY(x, z) : undefined);
    const floorY = groundSampler?.(p.group.position.x, p.group.position.z) ?? p.group.position.y;
    const seatHeightLocal =
      typeof p.group.userData.seatHeight === 'number'
        ? p.group.userData.seatHeight
        : p.obj.kind.startsWith('bed.')
          ? 0.58
          : 0.48;
    const seatTopY = p.group.position.y + seatHeightLocal * p.obj.scale;
    const heldIds = this.physics?.heldIds ?? [];
    const obstacles: SeatObstacleVolume[] = [];
    const stageInv = M4_A.copy(this.host.stage.matrixWorld).invert();
    for (const other of this.host.placed.values()) {
      if (
        other === p ||
        other.obj.hidden ||
        other.obj.inside ||
        heldIds.includes(other.obj.id) ||
        other.obj.kind.startsWith('desk.') ||
        CATALOG_BY_ID[other.obj.kind]?.flat
      ) {
        continue;
      }
      if (Math.hypot(other.group.position.x - p.group.position.x, other.group.position.z - p.group.position.z) > 1.35) {
        continue;
      }
      BOX_A.setFromObject(other.group).applyMatrix4(stageInv);
      if (BOX_A.isEmpty() || BOX_A.min.y < seatTopY - 0.08) continue;
      obstacles.push({
        id: other.obj.id,
        box: {
          minX: BOX_A.min.x,
          minY: BOX_A.min.y,
          minZ: BOX_A.min.z,
          maxX: BOX_A.max.x,
          maxY: BOX_A.max.y,
          maxZ: BOX_A.max.z,
        },
      });
    }
    const stageHit = hitWorld ? this.toStage(hitWorld) : ch?.root.position ?? null;
    const slots =
      item?.anchors && item.anchors.length > 0
        ? item.anchors
        : item?.anchor
          ? [item.anchor]
          : undefined;
    const hasBackrest =
      item?.anchor?.hasBackrest ??
      !(p.obj.kind === 'beanbag' || p.obj.kind === 'pouf' || p.obj.kind.startsWith('bed.'));
    return validateSeatObject({
      id: p.obj.id,
      pos: p.group.position,
      rotY: p.obj.rotY,
      quat: p.group.quaternion,
      scale: p.obj.scale,
      size: item?.size,
      seatHeightLocal,
      slots,
      hasBackrest,
      floorY,
      isMoving: () => Boolean(this.physics?.owns(p.obj.id) || this.moving(p.obj.id)),
      hitPoint: stageHit,
      obstacles,
      isWalkable: walk ? (pt) => walk.free(pt) : undefined,
      groundAt: groundSampler,
    });
  }

  private actsNow(id: string | null, kind: string | null): Act[] {
    if (!id || !kind) return [];
    const h = this.hands(), ch = this.host.character();
    const p = this.host.placed.get(id.startsWith('drawer:') || id.startsWith('shelfbook:') ? id.split(':')[1] : id), obj = p?.obj;
    const aff = affordanceOf(kind);
    const rawTipped = Boolean(p && !isSpaceObjectUpright(p.obj, p.group, MIN_SEAT_UPRIGHT_DOT));
    let seatValid: boolean | undefined;
    let tipped: boolean | undefined = rawTipped || undefined;
    if (p && (aff.seat || aff.bed)) {
      const seatCheck = this.validatePlacedSeat(p, this.hitWorld);
      seatValid = seatCheck.valid;
      tipped = seatCheck.tipped || rawTipped;
    }
    const ctx = {
      free: h.free, held: h.kinds, seated: !!ch?.body.seat, lying: ch?.posture === 'lying', onThis: !!ch && ch.occupies(id),
      on: obj ? (obj.kind === 'kettle.vintage' ? !!obj.state?.on : obj.lightOn !== false && obj.state?.on !== false) : undefined, open: this.isOpen(id), countLeft: obj ? this.booksLeft(obj) : undefined, sipsLeft: obj ? this.sipsOf(obj) : 4,
      full: obj?.kind === 'bin.trash' ? (obj.state?.fill ?? 0) > .92 : undefined, wearing: obj?.kind === 'headphones' ? this.host.wearing('headphones') : undefined, canPlace: h.free < 2 && !!this.placeAim, canStore: h.free < 2 && !!this.placeStore, hasTool: !!(obj && (obj.action ?? CATALOG_BY_ID[obj.kind]?.action)) && (obj.action ?? CATALOG_BY_ID[obj.kind]?.action) !== 'none',
      seatValid,
      tipped,
    };
    if (obj?.kind.startsWith('desk.') && p) {
      const seatPlaced = ch?.body.seat ? this.host.placed.get(ch.body.seat) : null;
      const atThisDesk = Boolean(
        seatPlaced &&
        seatPlaced.obj.kind.startsWith('chair.') &&
        seatPlaced.group.position.distanceTo(p.group.position) < 1.45,
      );
      const pairedChairs = [...this.host.placed.values()].filter(
        q => !q.obj.hidden && q.obj.kind.startsWith('chair.') && q.group.position.distanceTo(p.group.position) < 1.4,
      );
      const validChairNear = pairedChairs.some(q => this.validatePlacedSeat(q).valid);
      Object.assign(ctx, {
        chairNear: pairedChairs.length > 0,
        seatValid: validChairNear,
        atThisDesk,
      });
    }
    return actsFor(kind, ctx);
  }
  private isOpen(id: string): boolean | undefined {
    if (id.startsWith('portal:')) return this.host.room()?.door(id.slice(7) as WorldDestination)?.isOpen ?? false;
    if (id.startsWith('life:')) return this.host.lifeDoor?.(id.slice(5))?.isOpen ?? false;
    if (id === 'window:main') return !!this.host.layout()?.room.windowOpen;
    if (id === 'curtain:main') return (this.host.layout()?.room.curtains ?? 0) < .5;
    if (id.startsWith('drawer:')) { const [, o, i] = id.split(':'); return ((this.host.placed.get(o)?.group.userData.sliders as Slider[] | undefined)?.[Number(i)]?.open ?? 0) > .5; }
    const p = this.host.placed.get(id);
    return p?.obj.kind === 'laptop' ? (p.obj.state?.lid ?? 1) > .5 : undefined;
  }
  private booksLeft(obj: SpaceObject) {
    if (!COVERS.has(obj.kind)) return undefined;
    const all = (this.host.placed.get(obj.id)?.group.userData.books as T.Object3D[] | undefined)?.length ?? 0;
    return all - (obj.state?.taken?.length ?? 0);
  }

  private computeCanResetUpright(): boolean {
    const heldId = this.physics?.heldIds[0];
    if (heldId) {
      const held = this.host.placed.get(heldId);
      if (!held || toolOf(held.obj.kind)) return false;
      const checkQuat = this.inspecting ? held.group.quaternion : this.placeGroupQuat;
      return worldUpYFromQuat(checkQuat) < EXACT_UPRIGHT_MIN_UP_Y;
    }
    if (this.targetId && !this.carrying) {
      const p = this.host.placed.get(this.targetId);
      if (p && affordanceOf(p.obj.kind).mobility !== 'fixed' && !p.obj.locked) {
        return !isSpaceObjectUpright(p.obj, p.group, MIN_SEAT_UPRIGHT_DOT);
      }
    }
    return false;
  }

  get state(): InteractionState {
    const acts = this.actsNow(this.targetId, this.targetKind).filter(a => !a.blocked || true);
    const usable = acts.filter(a => !a.blocked);
    const held = this.physics?.heldIds ?? [];
    const inHand = held[0] ? this.host.placed.get(held[0])?.obj : null;
    const ps = this.push, h = this.hands();
    const isNonToolCarry = Boolean(held.length && inHand && !toolOf(inHand.kind) && !this.book);
    // With something in the hands the right button looks closer at it; with nothing, it moves furniture (or does the second thing).
    const secondary: Act | null = held.length ? (this.inspecting ? { verb: 'inspect', vi: 'Thôi xem', en: 'Stop looking' } : { verb: 'inspect', vi: 'Xem kỹ, xoay vật', en: 'Look closer, turn it' }) : usable.find(a => a.verb === 'push') ?? usable[1] ?? null;
    const first = held.length ? null : usable[0] ?? acts[0] ?? null;
    const care1 = this.careVerb(0), care2 = this.careVerb(2);
    const grab = held.length ? null : usable.find(a => (a.verb === 'pick' || a.verb === 'take-one') && a !== first && a !== secondary) ?? null;
    return {
      target: this.targetId, targetKind: this.targetKind, primary: care1 ? this.careAct(care1) : this.work.active ? null : this.carryingTool ? actOf('work-tool') : held.length ? (this.placeStore || (this.placeAim && this.placeOk) || !h.free ? null : usable.find(a => FREE_HAND.has(a.verb)) ?? null) : first, secondary: care2 ? this.careAct(care2) : this.work.active ? null : secondary, grab, more: acts,
      tool: this.work.active ? { kind: this.work.active.spec.kind, pressing: this.work.pressing, touching: !!this.work.touchingNow, working: this.work.isWorking } : null,
      held: held.length ? [...held] : [], heldActs: inHand ? heldActs(inHand.kind, { reading: !!this.book, inspecting: this.inspecting, sipsLeft: this.sipsOf(inHand),
        toolMode: toolOf(inHand.kind) && !this.inputBusy && !this.toolExtraction ? this.work.active ? 'working' : 'carrying' : undefined }) : [],
      inspecting: this.inspecting, reading: !!this.book, bookPage: this.book?.open.pageCount ? { at: this.book.open.page + 1, of: this.book.open.pageCount } : null,
      book: this.book ? { title: this.book.title, note: this.book.open.pageNote, canBilingual: this.book.open.canBilingual, bilingual: this.book.open.bilingual, marked: this.book.open.marked, words: this.book.open.supportsWords, ref: (this.host.placed.get(this.book.host.userData.objectId as string)?.obj.state?.book ?? null) as never } : null,
      placeShelf: !!this.placeShelf, dragging: ps?.id ?? null, journey: this.journeyTo, journeyStep: this.plan.step, plan: this.plan.label, placing: !!this.placeAim && this.placeOk,
      mode: ps ? 'pushing' : this.busyHands() || this.awaitingPhysics || this.plan.active || !!this.placing ? 'busy' : held.length ? 'carrying' : 'idle',
      physics: this.physicsState,
      place: held.length && !this.inspecting && (this.placeAim || this.placeReason) ? { ok: this.placeOk, reason: this.placeReason } : null,
      canStand: this.canStand,
      rotAxis: isNonToolCarry ? this.rotAxis : null,
      canResetUpright: this.computeCanResetUpright(),
      gizmoActive: isNonToolCarry ? this.gizmoActive : false,
      push: ps ? { id: ps.id, kind: ps.p.obj.kind, need: Math.round(ps.res.breakaway), sliding: Math.round(ps.res.sliding), human: ps.res.human, effortless: !ps.gauge, moving: ps.moving, blocked: ps.blocked, pulling: ps.pulling } : null,
      queued: this.queue.length,
      station: this.stationNow ? { have: 4 - this.stationNow.missing.length, total: 4, missing: this.stationNow.missing.map(p => PART_NAME[p]), ready: this.stationNow.ready } : null,
    };
  }

  /** Being moved by hand this moment: the layout does not put it back. */
  moving(id: string) { return this.push?.id === id || !!this.push?.riders.some(r => r.p.obj.id === id); }
  drawerOn(p: Placed) { return this.drawer?.p === p; }
  private awaitingPhysics = false;
  /** Where the eyes rest while the body walks something to its place (stage). */
  private placeEyes: T.Vector3 | null = null;
  /** What the eyes should be on: the hand's goal, or the place a carried thing is being taken to. World space. */
  attention(out: T.Vector3): T.Vector3 | null {
    const a = this.actions.attention(out);
    if (a) return a;
    if (this.placeEyes && (this.plan.label === 'place' || this.placing)) return out.copy(this.host.stage.localToWorld(this.placeEyes.clone()));
    return null;
  }
  get busy() { return this.actions.busy || this.plan.active || !!this.passing || this.awaitingPhysics || !!this.pendingLift; }
  /** The legs are on their way somewhere for the hands. A hand merely reaching leaves them to the player: you can walk and take a mug at once. */
  get pickupActive() { return !!this.actions.current?.keep && !!this.actions.current.ready; }
  get legsTaken() { return this.pickupActive || this.actions.walking || this.plan.active || !!this.passing; }
  get carrying() { return (this.physics?.heldIds.length ?? 0) > 0; }

  // ── The hand on a thing ─────────────────────────────────────────────────────────────────────────────
  /** Which hand: the one on the thing's side of the body, if it is free. */
  private handFor(world: T.Vector3) {
    const ch = this.host.character(), h = this.hands();
    if (h.right && !h.left) return -1;
    if (h.left && !h.right) return 1;
    if (!ch) return 1;
    const at = ch.root.getWorldPosition(new T.Vector3()), to = world.clone().sub(at).setY(0).normalize();
    const face = ch.bodyForward(new T.Vector3());
    const right = new T.Vector3().crossVectors(face, UP);
    return to.dot(right) < -.2 ? -1 : 1;
  }
  /** A new grip finishes closing before the fitted fingers are refreshed. */
  private settled = new Map<string, number>();
  private feltAt = new WeakMap<GraspFrame, T.Vector3>();
  /** Largest physical wrist-to-grip error after IK, in stage metres. */
  holdMiss = 0;

  afterBody(dt: number) {
    this.actions.resolveReach();
    this.releasePlaced();
    this.work.afterBody(dt);
    if (this.backToCarry !== null && this.work.active?.side === this.backToCarry && this.carryTool(this.backToCarry)) { this.idleWork = 0; this.host.changed(); }
    this.backToCarry = null;
    this.holdMiss = 0;
    const physics = this.physics, rig = this.host.character()?.rig;
    if (!physics || !rig) return;
    const held = physics.heldIds;
    if (this.wristTurn && this.grasps.get(this.wristTurn.id)?.get(this.wristTurn.side) !== this.wristTurn.anchor) this.wristTurn = null;
    for (const id of this.grasps.keys()) if (!held.includes(id)) this.grasps.delete(id);
    for (const id of this.toolCarryFrames.keys()) if (!held.includes(id)) this.toolCarryFrames.delete(id);
    for (const id of this.regrips?.keys() ?? []) if (!held.includes(id)) this.regrips.delete(id);
    for (const id of this.settled.keys()) if (!held.includes(id)) this.settled.delete(id);

    for (const id of held) {
      if (this.work.active?.p.obj.id === id || (this.placing?.id === id && this.placing.rackPath)) continue;
      const p = this.host.placed.get(id), anchors = this.grasps.get(id);
      if (!p?.group.parent || !anchors) continue;
      const elapsed = Math.min(.25, (this.settled.get(id) ?? 0) + dt);
      this.settled.set(id, elapsed);
      for (const [side, anchor] of anchors) {
        const contact = rig.contactOn(side);
        if (contact?.on !== p.group || rig.contactProgress(side) < .97) continue;
        // The rendered group already contains Rapier’s interpolated pose. Only
        // the fingers fit around it. The same pose also owns the pouring lip.
        const wrist = rig.wristWorld(side);
        this.holdMiss = Math.max(this.holdMiss, wrist.distanceTo(contact.wrist) / this.k);
        if (elapsed < .25) continue;
        const local = p.group.worldToLocal(wrist), seen = this.feltAt.get(anchor);
        if ((!rig.fitted(side) || !seen || (contact.wrap && seen.distanceTo(local) > .006)) && rig.fitNow(side)) {
          this.feltAt.set(anchor, local);
        }
      }
    }
  }
  /** The same local grasp follows ordinary carry and destination anticipation. */
  private securedContact(p: Placed, anchor: GraspFrame): HandContact {
    const hand = anchor.contact();
    const turn = this.wristTurn, ch = this.host.character();
    if (!this.placing && !this.plan.active && turn?.id === p.obj.id && turn.travelMix < .01 && ch && !this.inspecting && !this.drinking && !this.pouring) {
      const arm = turn.arms.find(a => this.grasps.get(p.obj.id)?.get(a.side) === anchor);
      if (arm) {
        const body = ch.root.getWorldQuaternion(new T.Quaternion());
        hand.pole = arm.elbow.clone().applyQuaternion(body).add(ch.root.getWorldPosition(new T.Vector3()));
        hand.bodyFingers = arm.fingers.clone().applyQuaternion(body);
        hand.wristPivot = true;
      }
    }
    hand.kg = massNow(p.obj.kind, p.obj.state, affordanceOf(p.obj.kind).mass);
    if (this.placing?.id === p.obj.id) {
      const path = this.placing.rackPath;
      if (!this.placing.rack) hand.bend = this.placing.bend ?? PLACEMENT_BEND;
      // While route search brakes the object, the torso still anticipates the
      // destination. Using the brake point as intent made live reach tests
      // reject the very route the shoulders needed to prepare for.
      const pose = this.physics?.poseAt(p.obj.id, path?.task ? this.placing.to : path?.target ?? this.placing.to, this.placing.q);
      if (pose) {
        const goal = this.host.stage.matrixWorld.clone().multiply(new T.Matrix4().compose(pose.position, pose.quaternion, p.group.scale)).multiply(anchor.local);
        // A narrow rack can leave the feet against the front of the base.
        // If insertion has stopped advancing, let the torso anticipate the
        // full waypoint. Arm IK still targets the wrist on the physical tool.
        const lead = new T.Vector3().setFromMatrixPosition(goal).sub(hand.wrist);
        const stalled = path?.route && !path.approach ? T.MathUtils.smoothstep(8 - this.placing.left, 1, 2) : 0;
        hand.bodyGoal = hand.wrist.clone().add(lead.clampLength(0, Math.max(.08 * this.k, lead.length() * stalled)));
        hand.bodyFingers = new T.Vector3(0, 1, 0).transformDirection(goal);
      }
    }
    return hand;
  }
  /** Capture the solved hands before tool work relinquishes the transform.
   * The physical prop and every secured wrist keep their current pose. */
  /** Seconds the tool has been at work with the button up (`update`). */
  private idleWork = 0;
  private backToCarry: number | null = null;
  private carryTool(side: number) {
    const a = this.work.active;
    if (!a || a.side !== side) return true;
    const rig = this.host.character()?.rig;
    if (!rig || !this.actions.holdingOn(side)) return false;
    const spec = toolOf(a.p.obj.kind);
    const support = this.work.supportContact;
    // True 2-hand carry: keep BOTH hands `[side, -side]` secured on 2-hand shafts (`tool.broom`, `tool.mop`, `tool.webbrush`)
    // even while walking or turning so the lower support hand never drops off the shaft!
    const existingGrasps = this.grasps.get(a.p.obj.id);
    const wantSecond = Boolean(spec?.hands === 2 && existingGrasps?.has(-side));
    const sides = wantSecond ? [side, -side] : [side];
    const anchors = new Map<number, GraspFrame>();
    for (const s of sides) {
      const acquired = existingGrasps?.get(s);
      if (!acquired) return false;
      const contact = s === side ? rig.contactOn(s) : (support ?? rig.contactOn(s));
      if (contact) {
        const wrist = new T.Vector3(), fingers = new T.Vector3(), palm = new T.Vector3();
        const minProg = spec ? .82 : .999;
        const maxMiss = (spec ? .065 : .003) * this.k;
        if (rig.contactProgress(s) < minProg || !rig.handFrame(s, wrist, fingers, palm)) {
          if (!spec) return false;
        } else if (wrist.distanceTo(contact.wrist) > maxMiss && !spec) {
          return false;
        }
      } else if (!spec) {
        return false;
      }
      anchors.set(s, acquired);
    }
    const route = this.rackRoutes?.get(a.p.obj.id), at = this.physics?.pointOf(a.p.obj.id);
    const leftRack = route && at && this.work.worked === 0 && at.distanceTo(route.points[0]) < .40;
    this.work.end();
    this.physics?.endRackTransfer(a.p.obj.id);
    this.toolExtraction = null;
    this.grasps.set(a.p.obj.id, anchors);
    const root = this.host.character()!.root;
    const inverse = root.quaternion.clone().invert();
    this.toolCarryFrames.set(a.p.obj.id, {
      rotation: !leftRack && (spec?.length ?? 0) > .5
        ? carryReady(a.p.obj.kind, a.p.group.quaternion, root.quaternion)
        : inverse.clone().multiply(a.p.group.quaternion),
      turn: this.handTurn,
      departureOffset: leftRack ? a.p.group.position.clone().sub(root.position).applyQuaternion(inverse) : undefined,
      useCanonical: !leftRack,
    });
    this.actions.rebindHeld(
      side,
      () => this.securedContact(a.p, anchors.get(side)!),
      anchors.has(-side) ? () => this.securedContact(a.p, anchors.get(-side)!) : undefined,
    );
    if (anchors.has(-side)) this.twoHanded.add(a.p.obj.id); else this.twoHanded.delete(a.p.obj.id);
    this.liftingOff.delete(a.p.obj.id);
    if (this.intoHands?.id === a.p.obj.id) this.intoHands = null;
    this.heldPaths.delete(a.p.obj.id);
    return true;
  }
  /** True when actively carrying or working with a `ToolSpec` item (used by `engine.ts` to skip root-velocity throttling). */
  get isCarryingTool(): boolean { return this.carryingTool || Boolean(this.work.active); }
  /** A cleaning tool carried or at work in the hands. */
  get toolInHands() { return this.carryingTool || !!this.work.active; }
  private get carryingTool() {
    const id = this.physics?.heldIds[0], p = id ? this.host.placed.get(id) : null;
    return !!p && !!toolOf(p.obj.kind) && !this.work.active;
  }
  /** The player asked to use the tool in the hands: start, or say plainly why not yet (never a placing hint). */
  private startToolWork() {
    if (this.inputBusy || this.toolExtraction) { this.enqueue(0, performance.now()); return; }
    // Without mouse look a click starts the work and a second click stops it (the same toggle the tool uses at work).
    if (this.resumeTool()) { if (!this.host.exploration.locked) this.work.togglePress(); this.host.changed(); return; }
    this.host.say('Chưa dùng được: tay chưa nắm chắc dụng cụ. Thử lại sau khi đứng vững.', 'Not yet: the hands do not have a firm grip on the tool. Try again once standing still.');
  }
  /** A cancelled placement leaves the tool carried; an explicit use resumes work. */
  private resumeTool() {
    if (this.work.active) { this.work.useCurrentAim(); if (this.toolExtraction?.stopped) { this.toolExtraction.stopped = false; this.toolExtraction.task = null; } return true; }
    const { side, p } = this.heldThing();
    if (side == null || !p || !toolOf(p.obj.kind) || !this.actions.holdingOn(side)) return false;
    const anchors = this.grasps.get(p.obj.id);
    if (!anchors?.has(side) || !this.work.begin(p, side, anchors)) return false;
    this.workRoot = null;
    this.workIntent = null;
    this.actions.rebindHeld(side, () => this.work.active?.p === p ? this.work.contactFirst() : null);
    this.toolCarryFrames.delete(p.obj.id);
    if (toolOf(p.obj.kind)?.hands === 2) this.twoHanded.add(p.obj.id);
    return true;
  }
  /** Live reach test for a search that may resume after the body has moved. */
  private extractionReachable(p: Placed, at: T.Vector3, rotation: T.Quaternion) {
    const physics = this.physics, ch = this.host.character(), anchors = this.grasps.get(p.obj.id);
    if (!physics || !ch?.rig || !anchors?.size || this.host.placed.get(p.obj.id)?.group !== p.group) return false;
    const k = this.k, f = ch.bodyForward(new T.Vector3()), right = new T.Vector3().crossVectors(f, UP), arms: GraspReach[] = [];
    for (const [side, anchor] of anchors) {
      const arm = ch.rig.armReach(side);
      if (!arm) return false;
      arms.push({ ...arm, local: anchor.local, limit: .8, pole: arm.shoulder.clone().addScaledVector(right, side * .34 * k).addScaledVector(UP, -.42 * k).addScaledVector(f, -.12 * k) });
    }
    const q0 = physics.startOf(p.obj.id) ?? new T.Quaternion(), pose = physics.poseAt(p.obj.id, at, rotation.clone().multiply(q0.clone().invert()));
    if (!pose) return false;
    const world = this.host.stage.matrixWorld.clone().multiply(new T.Matrix4().compose(pose.position, rotation, p.group.scale));
    const fit = fitGraspTranslation(world, arms, 0);
    return fit.feasible && new T.Vector3().setFromMatrixPosition(fit.matrix).distanceTo(new T.Vector3().setFromMatrixPosition(world)) <= .002 * k;
  }
  /** A future insertion waypoint may require a different torso bend from the
   * currently held pose. Query the real rig at the SAME standing position;
   * reachStance restores every trial transform. Execution still projects each
   * physical step against the live finalized shoulders and secured grasps. */
  private placementReachable(p: Placed, at: T.Vector3, rotation: T.Quaternion) {
    if (this.extractionReachable(p, at, rotation)) return true;
    const ch = this.host.character(), physics = this.physics, anchors = this.grasps.get(p.obj.id);
    if (!ch?.rig || !physics || !anchors?.size) return false;
    const pose = physics.poseAt(p.obj.id, at, rotation.clone().multiply((physics.startOf(p.obj.id) ?? new T.Quaternion()).clone().invert()));
    if (!pose) return false;
    const matrix = this.host.stage.matrixWorld.clone().multiply(new T.Matrix4().compose(pose.position, rotation, p.group.scale));
    const contacts = [...anchors].map(([side, anchor]) => {
      const frame = matrix.clone().multiply(anchor.local);
      return { side, wrist: new T.Vector3().setFromMatrixPosition(frame), fingers: new T.Vector3(0, 1, 0).transformDirection(frame) };
    });
    const root = ch.root.position.clone();
    return !!ch.rig.reachStance(contacts, root, ch.root.rotation.y, candidate => candidate.distanceToSquared(root) < 1e-12);
  }
  /** A carry point alone does not prove the tool has left its support. Its
   * full rigid bounds must clear the rack's open-front plane before gaze can
   * start a turn. This is a conservative staging destination; the existing
   * live reach and exact-shape route checks still decide whether it is usable. */
  private extractionExit(p: Placed, center: T.Vector3, rotation: T.Quaternion, rackId?: string) {
    const rack = rackId ? this.host.placed.get(rackId) : null, physics = this.physics;
    if (!rack || rack.obj.hidden || !physics) return center;
    rack.group.updateWorldMatrix(true, true);
    this.host.stage.updateWorldMatrix(true, false);
    const rackFrame = this.host.stage.matrixWorld.clone().invert().multiply(rack.group.matrixWorld);
    const front = new T.Vector3(0, 0, 1).transformDirection(rackFrame);
    const pose = physics.poseAt(p.obj.id, center, rotation.clone().multiply((physics.startOf(p.obj.id) ?? new T.Quaternion()).clone().invert()));
    if (!pose) return center;
    const project = (box: T.Box3, matrix: T.Matrix4, maximum: boolean) => {
      let result = maximum ? -Infinity : Infinity;
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const d = new T.Vector3(x, y, z).applyMatrix4(matrix).dot(front);
        result = maximum ? Math.max(result, d) : Math.min(result, d);
      }
      return result;
    };
    const edge = project(this.ownBox(rack), rackFrame, true);
    const near = project(this.ownBox(p), new T.Matrix4().compose(pose.position, rotation, p.group.scale), false);
    // Reserve the existing6mm arrival radius in addition to3mm clearance.
    return center.clone().addScaledVector(front, Math.max(0, edge + .009 - near));
  }
  /** First take the tool out while retaining the acquired orientation. A gaze
   * request cannot cut diagonally through its support to get to the floor. */
  private extractTool(p: Placed) {
    const e = this.toolExtraction, physics = this.physics, ch = this.host.character();
    if (!e || e.id !== p.obj.id || !physics || !ch?.rig) return null;
    const actual = physics.pointOf(e.id)!;
    e.start ??= actual.clone();
    if (e.stopped) return { center: actual, rotation: e.rotation };
    const spec = toolOf(p.obj.kind);
    if (!e.rack && spec?.hands === 1) {
      // A loose cloth or duster only needs to clear its support. Planning
      // a rack-withdrawal route all the way to a standing carry pose asks
      // the still-crouched shoulders to reach both ends of that route.
      const lifted = e.start.clone();
      lifted.y += Math.min(.09,Math.max(.035,spec.length*.12));
      if (physics.toolWaypointReached(e.id,lifted,e.rotation)) this.toolExtraction = null;
      return {center:lifted,rotation:e.rotation};
    }
    if (!e.task && !e.route) {
      const departure = physics.rackDeparture(e.id, e.rack);
      const lifted = departure ? actual.clone().add(departure) : null;
      // For a keyed rack the handoff is the clear, raised front of the rack.
      // A lowering waypoint derived from the initial shoulder pose goes stale
      // as the torso straightens. The ordinary carry/work controller owns
      // that next movement after the whole tool clears the rack.
      const raisedExit = lifted && this.extractionExit(p, lifted, e.rotation, e.rack);
      const straightExit = raisedExit && this.extractionReachable(p, raisedExit, e.rotation) ? raisedExit : null;
      const target = straightExit ? null : this.rigidCarryPose(p, e.rotation.clone());
      const carry = target ? physics.centreFor(e.id, target.position, target.rotation, new T.Vector3()) : actual;
      // An open front plane contains many valid handoff positions. If a
      // straight pull crowds one wrist against the body, aim for the same
      // clearance at the lateral position of the feasible carry pose.
      const center = straightExit ?? this.extractionExit(p, carry, e.rotation, e.rack);
      const preferred = lifted ? [lifted] : undefined;
      // The generator yields across frames. Its probes must read finalized
      // shoulders and all currently secured grasps each time it resumes.
      e.task = physics.toolRoute(e.id, center, e.rotation,
        at => this.toolExtraction === e && this.extractionReachable(p, at, e.rotation), preferred);
    }
    if (e.task) {
      const deadline = performance.now() + 1.5;
      do {
        const next = e.task.next();
        if (next.done) { e.route = next.value; e.task = null; if (!e.route) e.stopped = true; break; }
        e.searched = next.value;
      } while (performance.now() < deadline);
      if (!e.route) return { center: actual, rotation: e.rotation };
    }
    const next = e.route?.[e.index];
    const following = e.route?.[e.index + 1];
    if (next && physics.toolWaypointReached(e.id, next, e.rotation, following)) {
      const rotation = physics.groupRotationOf(e.id);
      if (following || !e.rack || (rotation && this.extractionExit(p, actual, rotation, e.rack).distanceTo(actual) <= .006)) e.index++;
    }
    const goal = e.route?.[e.index];
    if (!goal) {
      const rack = e.rack ? this.host.placed.get(e.rack) : null;
      if (rack && e.route && e.start) {
        rack.group.updateWorldMatrix(true, false);
        this.rackRoutes.set(e.id, { rack: rack.obj.id, rackGroup: rack.group, toolGroup: p.group, frame: rack.group.matrixWorld.clone(), rotation: e.rotation.clone(), points: [e.start.clone(), ...e.route.map(p => p.clone())].reverse() });
        const q0 = physics.startOf(e.id);
        const pose = q0 && physics.poseAt(e.id, actual, e.rotation.clone().multiply(q0.clone().invert()));
        if (pose) this.work.finishWithdrawal(pose.position, pose.quaternion);
      }
      physics.endRackTransfer(e.id); this.toolExtraction = null; return { center: actual, rotation: e.rotation };
    }
    return { center: goal, rotation: e.rotation };
  }
  private restoreWobbleRest(p: Placed | null | undefined): void {
    if (!p) return;
    this.wobbles?.delete(p.obj.id);
    const children = p.group.children;
    for (let i = 0; i < children.length; i++) {
      const restQ = children[i].userData?._restQuat as T.Quaternion | undefined;
      if (restQ) children[i].quaternion.copy(restQ);
    }
    if (typeof p.obj.scale === 'number' && Number.isFinite(p.obj.scale) && p.obj.scale > 0) {
      p.group.scale.setScalar(p.obj.scale);
    }
  }

  /**
   * Releases `Interactions` + `HumanRig` contacts for `side` (and two-hand support `-side` when owned by `id`),
   * ensuring neither arm can remain stuck bent after pickup, placement, drop, throw, or cancel.
   */
  private releaseHeldContacts(side: number, id?: string | null, releaseSec = .20): void {
    const wasTwoHanded = Boolean(
      id && (this.twoHanded?.has(id) || this.grasps?.get(id)?.has(-side)),
    );
    const p = id ? this.host?.placed?.get(id) : null;
    if (id) {
      this.twoHanded?.delete(id);
      this.grasps?.delete(id);
      this.regrips?.delete(id);
      this.heldPaths?.delete(id);
      this.carryGoals?.delete(id);
      this.toolCarryFrames?.delete(id);
      this.liftingOff?.delete(id);
      this.settled?.delete(id);
      this.restoreWobbleRest(p);
    }
    this.actions?.letGo(side);
    const rig = this.host?.character?.()?.rig;
    if (!rig || typeof rig.setContact !== 'function') return;
    if (!this.physics?.heldIn?.(side)) {
      rig.setContact(side, null, undefined, releaseSec);
    }
    if (!this.physics?.heldIn?.(-side)) {
      const otherContact = typeof rig.contactOn === 'function' ? rig.contactOn(-side) : null;
      if (wasTwoHanded || (p && otherContact?.on === p.group)) {
        rig.setContact(-side, null, undefined, releaseSec);
      }
    }
    this.invalidatePlaceCache?.();
  }

  /** One placement owns its destination, outcome and success effect. A
   * cancelled bin action must never complete a later shelf action. */
  private startPlacement(
    side: number,
    to: T.Vector3,
    q: T.Quaternion,
    options: { store?: { host: string; slot: number }; rack?: string; gone?: boolean; done?: () => void; validatedSurface?: boolean } = {},
  ) {
    this.cancelPlacement();
    const id = this.physics?.heldIn(side);
    if (!id) return null;
    if (!this.carryTool(side)) {
      this.host.say('Tay chưa giữ chắc dụng cụ. Hãy dừng thao tác rồi thử lại.', 'Secure the tool first. Stop working and try again.');
      return null;
    }
    const placing: NonNullable<Manipulator['placing']> = {
      id,
      side,
      to: to.clone(),
      q: q.clone(),
      left: 8,
      validatedElapsed: 0,
      ...options,
      result: 'moving',
    };
    const p = this.host.placed.get(id), pose = this.physics?.poseAt(id, to, q), at = this.physics?.pointOf(id);
    if (options.rack && p && pose && at && ['tool.broom', 'tool.webbrush', 'tool.mop'].includes(p.obj.kind)) {
      placing.rackPath = { rotation: pose.quaternion.clone(), target: at.clone(), aligned: false, route: null, task: null, index: 0, searched: 0, ready: false, closest: Infinity };
    }
    if (options.validatedSurface && !options.rack) {
      this.physics?.bringToPlace?.(side);
    }
    this.placing = placing;
    this.placeEyes = to.clone();
    return placing;
  }
  private cancelPlacement(result: 'failed' | 'cancelled' = 'cancelled') {
    const placing = this.placing;
    if (placing) {
      placing.result = result;
      if (this.physics?.heldIn(placing.side) === placing.id) {
        this.physics.backInWorld(placing.side);
        if (placing.rackPath) { this.physics.endRackTransfer(placing.id); this.physics.resumeHeld(placing.side); }
      }
      this.heldPaths?.delete(placing.id);
    }
    this.placing = null; this.placeEyes = null;
    this.invalidatePlaceCache?.();
  }
  private validRackPlacement(placing: NonNullable<Manipulator['placing']>, p: Placed) {
    const physics = this.physics;
    if (!placing.rack || !physics) return false;
    const goal = physics.poseAt(placing.id, placing.to, placing.q);
    const yaw = goal && new T.Euler().setFromQuaternion(goal.quaternion, 'YXZ').y;
    const rack = this.host.placed.get(placing.rack), spot = rack && onRack(rack.obj, p.obj.kind, yaw ?? undefined);
    const q = spot?.quat ? new T.Quaternion(...spot.quat) : new T.Quaternion().setFromAxisAngle(UP, spot?.rotY ?? 0);
    const center = spot && physics.centreFor(placing.id, new T.Vector3(...spot.pos), q, new T.Vector3());
    return !!goal && !!center && center.distanceTo(placing.to) <= .001 && q.angleTo(goal.quaternion) <= .001;
  }
  /** Align in the hands, then insert through the same live swept/reachable
   * route used for extraction. No elapsed timer or drawing correction moves
   * the tool through the rack; only its Rapier body can reach a waypoint. */
  private updateRackPlacement(p: Placed, dt: number) {
    const placing = this.placing, path = placing?.rackPath, physics = this.physics;
    if (!placing || !path || !physics) return;
    if (!this.validRackPlacement(placing, p)) { this.cancelPlacement('failed'); return; }
    const fail = () => {
      this.cancelPlacement('failed');
      this.host.say('Chưa có lối đặt dụng cụ lên giá. Dụng cụ vẫn ở trong tay.', 'There is no clear route into the rack. The tool is still held.');
      this.host.changed();
    };
    if (!path.aligned || path.approach) {
      const physicalRotation = physics.groupRotationOf(placing.id);
      if (!physicalRotation) { fail(); return; }
      const nextRotation = physicalRotation.clone().rotateTowards(path.rotation, .8 * physics.motionStepSeconds(dt));
      const carry = this.rigidCarryPose(p, nextRotation);
      if (!carry) { fail(); return; }
      path.target.copy(physics.centreFor(placing.id, carry.position, carry.rotation, new T.Vector3()));
      // Near the rack, an ordinary shoulder-relative carry point can already
      // be behind the front rail. Finish turning in front of the opening
      // before the route takes the upright tool into its clips.
      path.target.copy(this.extractionExit(p, path.target, carry.rotation, placing.rack));
      // A stationary player must be able to let the tool settle before the
      // approach walk. Shoulder sway would otherwise keep feeding velocity
      // into a target that the route requires to be at rest.
      if (this.plan?.step === 'prepare' || !path.approach) {
        const center = physics.pointOf(placing.id);
        if (!path.settleAt && center && physicalRotation.angleTo(path.rotation) < .015) {
          // Once upright, any reachable point clear of the rack's front can
          // start the route. A shoulder-relative carry point keeps moving
          // while the torso straightens, even when the prop is already clear.
          const exit = this.extractionExit(p, center, physicalRotation, placing.rack);
          if (exit.distanceToSquared(center) < 1e-8 && this.extractionReachable(p, center, physicalRotation)) {
            path.settleAt = center;
          }
        }
        if (path.settleAt) path.target.copy(path.settleAt);
      } else path.settleAt = undefined;
      const arrived = physics.toolWaypointReached(placing.id, path.target, path.rotation);
      if (path.approach) path.aligned = arrived;
      if (arrived) { path.aligned = true; placing.left = 8; path.closest = Infinity; }
    }
    if (path.aligned && !path.approach) {
      // Keep the named support owner throughout this insertion lifecycle.
      if (!physics.beginRackTransfer(placing.id, placing.rack!)) { fail(); return; }
      if (!path.route && !path.task) {
        const previous = this.rackRoutes?.get(placing.id), rack = this.host.placed.get(placing.rack!);
        rack?.group.updateWorldMatrix(true, false);
        const preferred = previous && rack && previous.rack === placing.rack && previous.rackGroup === rack.group && previous.toolGroup === p.group
          && previous.rotation.angleTo(path.rotation) < 1e-6 && previous.frame.elements.every((v, i) => Math.abs(v - rack.group.matrixWorld.elements[i]) < 1e-8) ? previous.points : undefined;
        // Return along the same physical axis as withdrawal. At the guide
        // mouth both lateral translation and rotation must have settled
        // before the fingers lower the key onto its bearings.
        const lift = physics.rackDeparture(placing.id, placing.rack);
        const entry = lift ? placing.to.clone().add(lift) : null;
        const approach = entry ? [this.extractionExit(p, entry, path.rotation, placing.rack), entry] : preferred;
        path.task = physics.toolRoute(placing.id, placing.to, path.rotation, at => {
          if (this.placing !== placing || !this.validRackPlacement(placing, p)) return false;
          return this.placementReachable(p, at, path.rotation);
        }, approach);
      }
      if (path.task) {
        const deadline = performance.now() + 1.5;
        do {
          const next = path.task.next();
          if (next.done) { path.route = next.value; path.task = null; if (!path.route?.length) { fail(); return; } break; }
          path.searched = next.value;
        } while (performance.now() < deadline);
        // Search is bounded by toolRoute's node budget. Brake at the actual
        // pose while yielding; its CPU time is not an eight-second movement.
        path.target.copy(physics.pointOf(placing.id)!);
      }
      if (path.route) {
        const waypoint = path.route[path.index];
        if (waypoint && physics.toolWaypointReached(placing.id, waypoint, path.rotation, path.route[path.index + 1])) {
          path.index++; placing.left = 8; path.closest = Infinity;
        }
        path.ready = path.index >= path.route.length;
        path.target.copy(path.route[path.index] ?? placing.to);
      }
    }
    if (!path.task) {
      // Slow, force-limited insertion may legitimately take longer than eight
      // seconds. Only observed progress renews the stall timer; pose, contact,
      // support load and release gates stay independent and unchanged.
      const remaining = physics.pointOf(placing.id)!.distanceTo(path.target) + .25 * p.group.quaternion.angleTo(path.rotation);
      if (remaining < path.closest - .001) { path.closest = remaining; placing.left = 8; }
      placing.left -= dt;
    }
    if (placing.left <= 0) { fail(); return; }
    // Follow the insertion segment with the physical tool. Starting the
    // next command at the last *requested* position lets a spring-deflected
    // shaft cut diagonally across the guide even when both endpoints fit.
    let handTarget = path.target;
    const previous = path.route?.[path.index - 1];
    const actual = physics.pointOf(placing.id);
    if (previous && actual && !path.ready) {
      const line = new T.Line3(previous, path.target);
      const onLine = line.closestPointToPoint(actual, true, new T.Vector3());
      const error = actual.distanceTo(onLine);
      const rotation = physics.groupRotationOf(placing.id);
      if (!rotation) { fail(); return; }
      if (error > .0002 || rotation.angleTo(path.rotation) > .002) {
        // Rejoin the segment while taking up to the remaining 3 mm of
        // planning clearance along it. Requiring a 0.2 mm perfect line
        // stranded the servo indefinitely at a reachable, collision-free rail.
        const room = Math.max(0, .003 - error);
        const along = path.target.clone().sub(onLine).clampLength(0, room);
        handTarget = onLine.add(along);
      }
    }
    const movingTarget = !!path.approach && !path.settleAt;
    const fitted = this.constrainHeldPose(p, handTarget, path.rotation, dt, !movingTarget);
    // At the guide mouth a physically clear segment can still exceed the
    // two wrists' shared reach. Ask the feet to absorb the horizontal miss
    // before the next torso solve. Keep the tool under its current spring.
    if (!path.approach && !path.ready && path.route && actual && placing.left < 7
      && actual.distanceTo(handTarget) < .08) {
      const shift = handTarget.clone().sub(fitted.center).setY(0);
      // Along a narrow guide the segment follower asks for at most 3 mm.
      // React to a sustained reach projection above the solver's numerical
      // tolerance even when the whole requested increment is below 3 mm.
      if (shift.lengthSq() > .0002 ** 2) path.footShift = shift;
    }
    const q0 = physics.startOf(placing.id);
    const pose = q0 && physics.poseAt(placing.id, fitted.center, fitted.rotation.clone().multiply(q0.clone().invert()));
    if (!pose) { fail(); return; }
    physics.driveTool(placing.side, placing.id, pose.position, fitted.rotation, dt, !movingTarget, movingTarget);
  }
  /** Release from the real solved pose, or commit cleanly once a validated green-preview lower finishes. */
  private releasePlaced() {
    const placing = this.placing, physics = this.physics, rig = this.host.character()?.rig;
    if (!placing || !physics || !rig) return;
    const id = physics.heldIn(placing.side), p = id ? this.host.placed.get(id) : null;
    if (!id || !p || id !== placing.id) { this.cancelPlacement('failed'); return; }
    if (placing.rack) {
      if (!this.validRackPlacement(placing, p)) { this.cancelPlacement('failed'); return; }
      if (placing.rackPath && !placing.rackPath.ready) { physics.cancelSupportedRelease(placing.side); return; }
    }
    const at = physics.pointOf(id), pose = physics.poseAt(id, placing.to, placing.q);
    if (placing.validatedSurface && !placing.rack && !placing.store && !placing.gone) {
      const commitReady =
        (Boolean(at && pose && at.distanceTo(placing.to) <= .012 && p.group.quaternion.angleTo(pose.quaternion) <= .025)) ||
        (placing.validatedElapsed ?? 0) >= (this.host.reduced?.() ? .02 : VALIDATED_PLACE_COMMIT_SEC);
      if (!commitReady) {
        physics.cancelSupportedRelease?.(placing.side);
        return;
      }
    } else {
      if (!at || !pose || at.distanceTo(placing.to) > .005 || p.group.quaternion.angleTo(pose.quaternion) > .015) { physics.cancelSupportedRelease(placing.side); return; }
      const sides = this.twoHanded.has(id) ? [placing.side, -placing.side] : [placing.side];
      if (sides.some(side => { const c = rig.contactOn(side); return !c || rig.wristWorld(side).distanceTo(c.wrist) > .003 * this.k; })) { physics.cancelSupportedRelease(placing.side); return; }
      if (placing.rack && !physics.supportedRelease(placing.side, placing.rack)) return;
    }
    if (placing.store && !this.finishStore(placing.side, placing.store)) { this.cancelPlacement('failed'); return; }
    this.placing = null; this.placeEyes = null; this.heldPaths.delete(id); placing.result = 'placed';
    this.gizmoOffset?.set(0, 0, 0);
    if (this.gizmoActive) this.setGizmoActive(false);
    if (placing.gone) {
      physics.forget(id);
      this.releaseHeldContacts(placing.side, id, .20);
      contactSound('paper', .35, .5);
      this.host.despawn?.(id);
    } else if (placing.store) {
      /* finishStore has transferred ownership above. */
    } else if (placing.rack) {
      // Measured load transfer precedes opening the hand. Rapier retains the
      // body through gravity settlement and saves its observed resting pose.
      physics.release(placing.side, undefined, true);
      this.releaseHeldContacts(placing.side, id, .20);
      contactSound(affordanceOf(p.obj.kind).material, .3, .45);
    } else {
      if (physics.releaseValidatedPlacement) {
        physics.releaseValidatedPlacement(placing.side, placing.to, placing.q);
      } else {
        physics.release(placing.side, undefined, true);
      }
      this.releaseHeldContacts(placing.side, id, .20);
      contactSound(affordanceOf(p.obj.kind).material, .22 + Math.min(.35, affordanceOf(p.obj.kind).mass * .04), .45);
    }
    placing.done?.();
    this.host.changed();
  }

  private heldPaths = new Map<string, T.Vector3>();
  /** Smooth per-hand grip transitions during 3-axis object rotation, `Reset Upright`, or floor tool pickup (`updateHeldTargets`). */
  private regrips = new Map<string, Map<number, { anchor: GraspFrame; from: T.Matrix4; to: T.Matrix4; t: number; duration: number; done: boolean }>>();
  /** Root frame at the last consumed physics command. Several render frames can precede one fixed step. */
  private workRoot: { subject: Placed; at: T.Vector3; yaw: number } | null = null;
  private workIntent: { at: T.Vector3; yaw: number } | null = null;
  /** One rigid translation respects every secured wrist; a slow transition
   * gives the body time to follow while Rapier retains collision authority. */
  private constrainHeld(side: number, p: Placed, center: T.Vector3, rotation: T.Quaternion, dt: number) {
    const pose = this.constrainHeldPose(p, center, rotation, dt);
    if (pose.brake) {
      this.physics?.brakeHeld(side);
      this.heldPaths.delete(p.obj.id);
      return null;
    }
    this.physics?.holdGroupRotation(side, pose.rotation);
    return pose.center;
  }
  private constrainHeldPose(p: Placed, center: T.Vector3, rotation: T.Quaternion, dt: number, actual = false) {
    const physics = this.physics, ch = this.host.character(), anchors = this.grasps.get(p.obj.id);
    if (!physics || !ch?.rig || !anchors?.size) return { center, rotation };
    const k = this.k, f = ch.bodyForward(_mV1), right = _mV2.crossVectors(f, UP);
    const arms: GraspReach[] = [];
    const working = this.work.active?.p === p && !this.toolExtraction && !this.placing;
    const longWork = working && this.work.active!.spec.length > .9 && !this.work.headBusy;
    const validatedPlacing = Boolean(this.placing?.id === p.obj.id && this.placing.validatedSurface && !this.placing.rack);
    for (const [hand, anchor] of anchors) {
      const a = ch.rig.armReach(hand); if (!a) return { center, rotation };
      arms.push({ ...a, local: anchor.local, limit: .8, pole: a.shoulder.clone().addScaledVector(right, hand * .34 * k).addScaledVector(UP, -.42 * k).addScaledVector(f, -.12 * k) });
      const home = longWork && ch.rig.armHome(hand);
      if (home) arms.push({ ...home, local: anchor.local, limit: .8, pole: home.shoulder.clone().addScaledVector(right, hand * .34 * k).addScaledVector(UP, -.42 * k).addScaledVector(f, -.12 * k) });
    }
    const q0 = physics.startOf(p.obj.id) ?? _mQ4.identity();
    const tracking = !this.placing && this.work.active?.p !== p;
    const step = physics.motionStepSeconds(dt);
    const current = physics.groupRotationOf(p.obj.id) ?? _mQ1.copy(p.group.quaternion);
    const root = longWork && this.workRoot?.subject === p ? this.workRoot : null;
    const intended = longWork ? this.workIntent : null;
    this.workIntent = null;
    const bodyTurn = root ? _mQ2.setFromAxisAngle(UP, (intended?.yaw ?? ch.root.rotation.y) - root.yaw) : _mQ2.identity();
    // Transport is a contribution to the requested pose, not a second rotation
    // command. When the physical shaft already leads a blocked body turn,
    // applying the pending yaw again would wind it ahead of both hands.
    const transported = _mQ3.copy(bodyTurn).multiply(current);
    const turnGain = Math.max(0, current.angleTo(rotation) - transported.angleTo(rotation));
    const rotRate = tracking ? 4 : validatedPlacing ? 3.2 : .8;
    let groupQ = current.clone().rotateTowards(rotation, turnGain + rotRate * step);
    // The transport frame started at the physical pose and follows only
    // admitted root motion. Its absolute pose is already a trajectory.
    // Limiting that trajectory against the last body pose a second time
    // produces a persistent phase lag during a sustained turn.
    const transporting = longWork && this.work.transporting;
    if (transporting) groupQ = current.clone().rotateTowards(rotation, .12);
    const previous = (!actual ? this.heldPaths.get(p.obj.id) : null) ?? physics.pointOf(p.obj.id) ?? center;
    const linearStep = tracking && !actual ? dt : step;
    const carried = root ? _mV3.copy(previous).sub(root.at).applyQuaternion(bodyTurn).add(intended?.at ?? ch.root.position) : previous;
    const linRate = tracking ? 1.8 : validatedPlacing ? 1.35 : .35;
    let stepped = _mV4.copy(center).sub(carried).clampLength(0, linRate * linearStep).add(carried).clone();
    if (longWork) {
      // Bound the motion of the hand, not the centre of a long lever.
      // A change of inclination sweeps the head around the primary grasp.
      const anchor = anchors.get(this.work.active!.side)!;
      const local = new T.Vector3().setFromMatrixPosition(anchor.local).multiply(p.group.scale);
      const wristOffset = (q: T.Quaternion) => local.clone().applyQuaternion(q)
        .sub(physics.centreFor(p.obj.id, _mV5.set(0, 0, 0), q, new T.Vector3()));
      const fromWrist = previous.clone().add(wristOffset(current));
      const carriedWrist = carried.clone().add(wristOffset(current).applyQuaternion(bodyTurn));
      const toWrist = center.clone().add(wristOffset(rotation));
      const travelGain = Math.max(0, fromWrist.distanceTo(toWrist) - carriedWrist.distanceTo(toWrist));
      const lead = transporting ? .035 : travelGain + .35 * linearStep;
      stepped = fromWrist.clone().add(toWrist.sub(fromWrist).clampLength(0, lead)).sub(wristOffset(groupQ));
    }
    if (longWork && (!root || physics.willStep(dt))) this.workRoot = { subject: p, at: ch.root.position.clone(), yaw: ch.root.rotation.y };
    if (!longWork) this.workRoot = null;
    // The moving work stroke can fold a wrist into the shoulder between
    // ticks. Rack insertion follows a stationary, physically specified seat.
    const own = this.ownBox(p);
    const q0Inv = _mQ3.copy(q0).invert();
    const solve = (q: T.Quaternion) => {
      const pose = physics.poseAt(p.obj.id, stepped, _mQ4.copy(q).multiply(q0Inv));
      if (!pose) return null;
      const world = _mM1.copy(this.host.stage.matrixWorld).multiply(_mM2.compose(pose.position, q, p.group.scale));
      // The study sits a storey above the street. Anchor grip clearance to the
      // walkable floor under the object, in the same world units as the wrists.
      const floorY = ch.groundAt?.(stepped.x, stepped.z) ?? ch.root.position.y;
      _mV5.set(stepped.x, floorY, stepped.z);
      const worldMinY = _mBox1.copy(own).applyMatrix4(world).min.y;
      const worldOriginY = _mV6.setFromMatrixPosition(world).y;
      const floor = this.host.stage.localToWorld(_mV5).y - worldMinY + worldOriginY;
      return fitGraspTranslation(world, arms, .025 * k, floor, working ? .025 * k : 0);
    };
    let fit = solve(groupQ);
    if (!fit) return { center, rotation };
    // A turn the wrists cannot follow yet (a long tool coming up off the floor while the body is still low) does not
    // stop the lift: it goes on up as it is held, and turns once the body has stood and the arms are free. Braking the
    // whole pose here left the body waiting for the tool and the tool for the body (a broom stuck at 0.3 m, the body
    // in a squat, for good).
    if (!fit.feasible && tracking && current.angleTo(groupQ) > 1e-6) {
      const held = solve(current);
      if (held?.feasible) { fit = held; groupQ = current; }
    }
    this.graspReachMiss = fit.residual / k;
    if (!fit.feasible && !validatedPlacing) {
      return { center: physics.pointOf(p.obj.id) ?? previous.clone(), rotation: p.group.quaternion.clone(), brake: true };
    }
    const at = _mV7, q = new T.Quaternion();
    _mM2.copy(this.host.stage.matrixWorld).invert().multiply(fit.matrix).decompose(at, q, _mV8);
    const desired = physics.centreFor(p.obj.id, at, q, new T.Vector3());
    // Feasibility is the last operation: interpolating after projection can
    // move a valid pose back outside the wrist-orientation region.
    const accepted = desired;
    this.heldPaths.set(p.obj.id, accepted);
    return { center: accepted, rotation: q };
  }
  private bars = new Map<string, () => GraspShape>();
  /** A bar the hand closes over, as a thin cylinder along `axis` through `point`: kept while the bar does not move, so the fingers are felt once. */
  private barShape(point: T.Vector3, axis: T.Vector3): () => GraspShape {
    if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0);
    axis.normalize();
    const key = `${point.x.toFixed(3)},${point.y.toFixed(3)},${point.z.toFixed(3)},${axis.x.toFixed(2)},${axis.z.toFixed(2)}`;
    let f = this.bars.get(key);
    if (!f) {
      const z = new T.Vector3().crossVectors(axis, UP);
      if (z.lengthSq() < 1e-6) z.set(0, 0, 1);
      z.normalize();
      const x = new T.Vector3().crossVectors(axis, z).normalize();
      const toLocal = new T.Matrix4().makeBasis(x, axis, z).setPosition(point).invert();
      const k = this.k;
      f = () => ({ kind: 'cyl', toLocal, half: [.011 * k, .07 * k, .011 * k] });
      if (this.bars.size > 48) this.bars.clear();
      this.bars.set(key, f);
    }
    return f;
  }
  /** QA: for each thing in the hands, how far the palms were from it, how far each finger closed, and finger points inside it or off it. */
  graspQA() {
    const rig = this.host.character()?.rig, physics = this.physics;
    if (!rig || !physics) return null;
    return physics.heldIds.map(id => {
      const p = this.host.placed.get(id);
      if (!p) return null;
      const shape = meshShape(p.group, `${p.obj.kind}|${p.obj.scale}`, o => !graspable(o));
      const hands = [1, -1].map(side => {
        const c = rig.contactOn(side);
        if (!c || rig.contactProgress(side) < .97) return null;
        let nearest = Infinity, inside = 0, touching = 0;
        const points = rig.fingerPoints(side);
        if (shape?.distance) for (const w of points) {
          const local = w.clone().applyMatrix4(shape.toLocal), d = shape.distance(local);
          nearest = Math.min(nearest, d); if (d < .012 * this.k) touching++;
          if (shape.inside?.(local) && d > .004 * this.k) inside++;
        }
        return { side, nearestMm: +(nearest * 1000 / this.k).toFixed(1), touching, inside, points: points.length, fit: rig.fitOf(side).map(v => +v.toFixed(2)) };
      }).filter(Boolean);
      return { id, kind: p.obj.kind, missMm: +(this.holdMiss * 1000).toFixed(1), mesh: !!shape, hands };
    }).filter(Boolean);
  }
  /**
   * The hand's pose for a contact point: the wrist a hand's length short of it, along the way the arm comes in. `style` says how the
   * hand meets it: over the top of a lever, against a surface, round the side of a thing that is lifted, from above, or by a flat edge.
   */
  private grip(point: T.Vector3, side: number, grip: Grip, style: 'over' | 'push' | 'side' | 'top' | 'edge', radius = 0, shape?: () => GraspShape | null, touch?: (from: T.Vector3, dir: T.Vector3, far: number) => { point: T.Vector3; normal: T.Vector3 } | null): HandContact {
    const k = this.k, ch = this.host.character()!;
    const at = ch.root.getWorldPosition(new T.Vector3());
    const flat = point.clone().sub(at).setY(0);
    if (flat.lengthSq() < 1e-5) ch.bodyForward(flat);
    flat.normalize();
    const right = new T.Vector3().crossVectors(flat, UP);
    const shoulder = ch.body.seat ? ch.rig?.armReach(side)?.shoulder : undefined;
    const toward = point.clone().sub(shoulder ?? at.clone().addScaledVector(right, side * .17 * k).setY(at.y + 1.33 * k)).normalize();
    const up = UP;
    if (style === 'over') {
      const fingers = toward.clone().setY(toward.y * .35).normalize();
      // A lever, a drawer pull, a bail: a bar across the hand. The fingers close over it until they meet it, never through it.
      const bar = shape ?? this.barShape(point, new T.Vector3().crossVectors(UP, fingers.clone().setY(0).normalize()));
      return { wrist: point.clone().addScaledVector(fingers, -.078 * k).addScaledVector(up, .024 * k), fingers, palm: up.clone().negate().addScaledVector(right, -side * .18).normalize(), grip, shape: bar };
    }
    if (style === 'push') {
      const fingers = toward.clone();
      return { wrist: point.clone().addScaledVector(fingers, -.155 * k), fingers, palm: up.clone().negate().addScaledVector(right, -side * .2).normalize(), grip, shape };
    }
    if (style === 'top') {
      // From above: the fingers come down round it, the palm over its top.
      const fingers = flat.clone().multiplyScalar(.82).addScaledVector(up, -.57).normalize();
      const top = touch?.(point.clone().addScaledVector(up, .5 * k), up.clone().negate(), .8 * k);
      if (top) {
        // The palm lies on the real top, the fingers along it towards its far edge, where they curl over.
        const palm = top.normal.clone().negate(), along = flat.clone().addScaledVector(palm, -flat.dot(palm)).normalize();
        return { wrist: top.point.clone().addScaledVector(top.normal, .028 * k).addScaledVector(along, -.075 * k), fingers: along, palm, grip, shape };
      }
      return { wrist: point.clone().addScaledVector(up, radius + .046 * k).addScaledVector(fingers, -.06 * k), fingers, palm: up.clone().negate().addScaledVector(flat, .25).normalize(), grip, shape };
    }
    if (style === 'edge') {
      // A flat thing by its near edge: thumb on top, fingers under.
      const fingers = flat.clone().multiplyScalar(.97).addScaledVector(up, -.2).normalize();
      return { wrist: point.clone().addScaledVector(flat, -(radius + .074 * k)).addScaledVector(up, .012 * k), fingers, palm: right.clone().multiplyScalar(-side).multiplyScalar(.4).addScaledVector(up, -.9).normalize(), grip, shape };
    }
    // Round the side: the palm faces the thing across the body's midline, fingers forward and a little up, thumb on top.
    const fingers = toward.clone().setY(Math.max(-.2, toward.y * .4)).normalize();
    const palm = right.clone().multiplyScalar(-side).addScaledVector(up, -.12).normalize();
    // The palm goes to where the thing really is, the way the hand comes in: its own surface, not a box round it.
    const real = touch?.(point.clone().addScaledVector(palm, -.45 * k), palm, .9 * k);
    if (real) {
      // The palm against the face it meets, the fingers along that face the way the arm comes: they curl round its far side, never into it.
      const against = real.normal.clone().negate();
      const along = fingers.clone().addScaledVector(against, -fingers.dot(against));
      if (along.lengthSq() < 1e-4) along.crossVectors(up, against);
      along.normalize();
      return { wrist: real.point.clone().addScaledVector(real.normal, .024 * k).addScaledVector(along, -.072 * k).addScaledVector(up, -.018 * k), fingers: along, palm: against, grip, shape };
    }
    return { wrist: point.clone().addScaledVector(palm, -(radius + .024) * k).addScaledVector(fingers, -.072 * k).addScaledVector(up, -.018 * k), fingers, palm, grip, shape };
  }
  private barWays = new Map<string, { way: T.Vector3; palm: T.Vector3 | null; seen: number; slide: number }>();
  /**
   * A hand round the bar of a handle. The bar is the model's own, measured; the hand turns about it to the way the forearm lies, as a real hand does on a kettle's bail, so the wrist stays straight whatever
   * the thing is doing: hanging at the side, lifted to pour, tilted. The fingers then close until they meet its triangles.
   */
  private gripBar(p: Placed, h: Handle, side: number, shape: () => GraspShape | null, loop?: ReturnType<NonNullable<Handle['loop']>>): HandContact {
    const k = this.k, ch = this.host.character()!;
    p.group.updateWorldMatrix(true, false);
    if (loop) {
      const q = p.group.getWorldQuaternion(new T.Quaternion());
      const direction = (v: readonly number[]) => new T.Vector3(v[0], v[1], side * v[2]).applyQuaternion(q);
      const wrist = new T.Vector3(...loop.opening).applyMatrix4(p.group.matrixWorld)
        .addScaledVector(direction(loop.wristOffset), k);
      return { wrist, fingers: direction(loop.fingers), palm: direction(loop.palm),
        grip: 'handle', wrap: true, shape, handleJoints: loop.joints };
    }
    const key = `${p.obj.id}|${side}`;
    let held = this.barWays.get(key);
    if (!held || this.frameCount - held.seen > 20) { held = { way: new T.Vector3(), palm: null, seen: -1, slide: 0 }; this.barWays.set(key, held); }
    // The hand slides along the handle to where it pours from, and back.
    held.slide += ((h.pourGrip && this.pouring?.p === p ? 1 : 0) - held.slide) * .14;
    const g = h.pourGrip ?? h, sl = held.slide;
    const at = new T.Vector3(h.at[0] + (g.at[0] - h.at[0]) * sl, h.at[1] + (g.at[1] - h.at[1]) * sl, h.at[2] + (g.at[2] - h.at[2]) * sl).applyMatrix4(p.group.matrixWorld);
    const axis = new T.Vector3(h.axis[0] + (g.axis[0] - h.axis[0]) * sl, h.axis[1] + (g.axis[1] - h.axis[1]) * sl, h.axis[2] + (g.axis[2] - h.axis[2]) * sl).transformDirection(p.group.matrixWorld).normalize();
    const forward = ch.bodyForward(new T.Vector3()), right = new T.Vector3().crossVectors(forward, UP).normalize();
    const elbow = ch.rig?.elbowWorld(side, new T.Vector3());
    const way = at.clone().sub(elbow ?? ch.root.getWorldPosition(new T.Vector3()).addScaledVector(UP, 1.05 * k));
    way.addScaledVector(axis, -way.dot(axis));
    if (way.lengthSq() < 1e-4) way.copy(forward).addScaledVector(axis, -forward.dot(axis));
    way.normalize();
    // Round the bar slowly: the hand does not snap to every twitch of the elbow, and it never changes sides on the bar.
    if (held.seen < 0) held.way.copy(way);
    else { held.way.lerp(way, .2).addScaledVector(axis, -held.way.dot(axis)).normalize(); way.copy(held.way); }
    held.seen = this.frameCount;
    const palm = new T.Vector3().crossVectors(axis, way).normalize();
    // A bar can be taken from either side of it, and only one of those is a hand the way a hand goes. Asked every frame, because the thing turns in the hand and the arm moves:
    // the thumb up if the bar stands up, across towards the body if it lies across, forward if it lies along the way the body goes. Never the wrist turned over backwards.
    const thumbOf = new T.Vector3().crossVectors(way, palm).multiplyScalar(side);
    let natural = thumbOf.dot(UP) + thumbOf.dot(right) * -side * .5 + thumbOf.dot(forward) * .3;
    if (held.palm) {
      // It stays on the side it is on unless the other is clearly the right one; then it changes hold in a moment, it does not jump.
      if (palm.dot(held.palm) < 0) { palm.negate(); natural = -natural; }
      if (natural < -.14) palm.negate();
      const turning = palm.dot(held.palm) < -.9;
      held.palm.lerp(palm, .22).addScaledVector(way, -held.palm.dot(way));
      if (turning) held.palm.addScaledVector(thumbOf, .3);
      held.palm.normalize();
      palm.copy(held.palm);
    } else {
      if (natural < 0) palm.negate();
      held.palm = palm.clone();
    }
    if (h.carry === 'ahead' && sl < .01) {
      // The load hangs below the hand. The thumb runs towards the spout and
      // the fingers curl inwards from above the bar on either hand.
      way.copy(UP).negate().addScaledVector(axis, axis.y);
      if (way.lengthSq() > .01) {
        way.normalize();
        palm.crossVectors(axis, way).multiplyScalar(side).normalize();
      } else way.copy(held.way);
    }
    const wrist = at.clone();
    if (h.pinch) {
      // Index through the loop, the thumb on top of it: the hand stands below and beside the bar, with the loop at the first finger.
      const thumb = new T.Vector3().crossVectors(way, palm).multiplyScalar(side);
      wrist.addScaledVector(way, -.103 * k).addScaledVector(palm, -.04 * k).addScaledVector(thumb, -.0256 * k);
    } else {
      // A power grip: the bar lies aslant across the palm, along the line of the knuckles (the little finger's is nearer the wrist than the index's), so every finger comes round it alike.
      const thumb = new T.Vector3().crossVectors(way, palm).multiplyScalar(side);
      const toThumb = axis.dot(thumb) >= 0 ? axis : axis.clone().negate();
      way.multiplyScalar(KNUCKLE_COS).addScaledVector(toThumb, KNUCKLE_SIN).normalize();
      wrist.addScaledVector(way, -.09 * k).addScaledVector(palm, -(.018 + h.r * .5) * k);
    }
    return { wrist, fingers: way, palm, grip: h.pinch ? 'pinch' : 'handle', shape, wrap: true };
  }
  private shapeOf(p: Placed): () => GraspShape | null {
    return () => {
      // What the fingers close on: the thing's own drawn triangles (a mug's handle, a book's spine), felt through a cached BVH.
      const real = meshShape(p.group, `${p.obj.kind}|${p.obj.scale}`, SKIP_NON_GRASPABLE);
      if (real) return real;
      // Fallback for dense furniture: reuse cached `ownBox(p)` in O(1) without re-traversing child meshes per frame.
      const a = affordanceOf(p.obj.kind);
      const box = this.ownBox(p);
      if (box.isEmpty()) return null;
      p.group.updateWorldMatrix(true, false);
      const scale = p.group.getWorldScale(_mV1).x || 1;
      const size = box.getSize(_mV2).multiplyScalar(scale);
      const centre = box.getCenter(_mV3).applyMatrix4(p.group.matrixWorld);
      const local = new T.Matrix4().compose(centre, p.group.getWorldQuaternion(_mQ1), UNIT_SCALE).invert();
      return {
        kind: a.shape === 'cylinder' ? 'cyl' : a.shape === 'sphere' ? 'sphere' : 'box',
        toLocal: local,
        half: [size.x / 2, size.y / 2, size.z / 2],
      };
    };
  }
  /** Sitting keeps the pelvis on its support. The rig can lean toward a target
   * and extend its hand beyond the wrist. Measure both in world coordinates. */
  private seatedReach(world: T.Vector3) {
    const ch = this.host.character();
    if (!ch?.body.seat) return true;
    const arm = ch.rig?.armReach(this.handFor(world));
    if (!arm) return false;
    const lean = ch.posture === 'lying' ? 0 : .16 * this.k;
    return arm.shoulder.distanceTo(world) <= arm.length + .155 * this.k + lean;
  }
  private outOfSeatedReach() {
    this.host.say('Ngoài tầm tay. Hãy đứng dậy hoặc chọn vật gần hơn.', 'Out of reach. Stand up or choose something closer.');
  }
  private approachFor(stagePoint: T.Vector3, stop: number, seated: () => void) {
    if (!this.host.character()?.body.seat) return { point: stagePoint, stop };
    if (this.seatedReach(this.host.stage.localToWorld(stagePoint.clone()))) seated();
    else this.outOfSeatedReach();
    return null;
  }
  private standThen(then: () => void) {
    this.host.standUp();
    this.plan.run('stand', [{ name: 'stand', tick: () => { const c = this.host.character(); return !c ? null : c.standing; } }, { name: 'go', start: then, tick: () => true }]);
  }
  /** Touches a thing and does `then` at the moment of contact. Every verb that only needs a hand on the thing comes through here. */
  private touch(stagePoint: () => T.Vector3, world: () => T.Vector3, style: 'over' | 'push', grip: Grip, stop: number, then: () => void, material?: Parameters<typeof contactSound>[0]) {
    const run = (near: boolean) => {
      const side = this.handFor(world());
      if (this.hands().free === 0) { this.host.say('Hai tay đang bận.', 'Both hands are full.'); return; }
      this.actions.start({
        side, approach: near ? undefined : { point: stagePoint(), stop },
        reach: .46, operate: .12, release: .34,
        contact: () => this.grip(world(), side, grip, style),
        ...(near ? {
          ready: () => {
            const rig = this.host.character()?.rig;
            if (!rig) return null;
            return rig.wristWorld(side).distanceTo(this.grip(world(), side, grip, style).wrist) <= .025 * this.k;
          },
          reachTimeout: .8,
          onUnreachable: () => this.outOfSeatedReach(),
        } : {}),
        onContact: () => { if (material) contactSound(material, .45, .5); then(); },
      });
      this.host.wake();
    };
    const a = this.approachFor(stagePoint(), stop, () => run(true));
    if (a) run(false);
  }

  // ── Input ───────────────────────────────────────────────────────────────────────────────────────────
  /**
   * A mouse button, one state machine for all of them. Every click counts: one made while the body is still reaching is kept and done next,
   * in order. Left: take, use, open; with something in the hands, put it down where the ring is (never dropped by a click on a place that
   * does not fit). Right: push or pull furniture, once to take hold and once to let go; on heavy furniture each right click (or holding it,
   * or Shift, or the effort key) puts more strength in, and the left button lets go. With something in the hands, right acts on what is
   * under the eyes. Middle: look closer at what is held.
   */
  button(button: number, down: boolean, now = performance.now()) {
    const ex = this.host.exploration;
    if (!ex.acceptingInput) return;
    if (button === 1) { if (down) this.middle(); return; }
    if (button !== 0 && button !== 2) return;
    if (down) {
      this.press = { button, at: now, startedTarget: this.targetId, dragged: false };
      if (button === 0 && this.gizmoActive && this.gizmo?.visible && this.beginGizmoDragFromAim()) {
        this.press.dragged = true;
        return;
      }
      if (this.push) { if (button === 2 && this.push.gauge) { this.push.gauge.tap(); this.press.dragged = true; } return; }
      // A tool works for as long as the button is down. A thing it can be used on takes the click instead.
      if (button === 0 && this.work.active && !this.inputBusy && !this.careVerb(0) && ex.locked) { this.work.press(true); this.press.dragged = true; return; }
      // A tool still carried goes to work and works at once: holding the button is sweeping, not two separate presses.
      if (button === 0 && this.carryingTool && !this.inputBusy && !this.toolExtraction && !this.careVerb(0) && ex.locked && this.resumeTool()) { this.work.press(true); this.press.dragged = true; this.host.changed(); return; }
      // Without mouse-look a click is a toggle: the tool goes to work now and works until the next click.
      if (button === 0 && this.carryingTool && !this.inputBusy && !this.toolExtraction && !this.careVerb(0) && !ex.locked && this.resumeTool()) { this.work.togglePress(); this.press.dragged = true; this.host.changed(); return; }
      if (button === 0 && !this.inputBusy && this.startPull()) this.press.dragged = true;
      return;
    }
    if (button === 0 && this.gizmo?.dragging) {
      this.endGizmoDrag();
      this.press = null;
      return;
    }
    const press = this.press; this.press = null;
    if (button === 0 && this.work.pressing && ex.locked) { this.work.press(false); return; }
    if (!press || press.button !== button) return;
    if (button === 0 && this.work.active && !ex.locked && !press.dragged && !this.careVerb(0) && !this.inputBusy) { this.work.togglePress(); this.host.changed(); return; }
    if (this.push) {
      // Strength going in is never a letting go: those clicks belong to the gauge.
      if (button === 2 && this.push.gauge) { this.push.gauge.hold(false); return; }
      // The click that began the push is not its end.
      if (now - this.push.since < 260) return;
      this.endPush();
      return;
    }
    if (this.drawer?.pulling) { this.endPull(now - press.at); return; }
    if (press.dragged) return;
    if (this.inputBusy) { this.enqueue(button, now); return; }
    this.click(button);
  }
  private click(button: number) { if (button === 0) this.primary(); else this.secondary(); }
  private enqueue(button: number, now: number) {
    if (this.targetKind === 'door' || this.doorMech) return;
    if (this.queue.length < 4) this.queue.push({ button, at: now });
    this.host.changed();
  }
  /** The hands, the legs or the engine are still on the last thing: a click now waits for them, it is not lost. */
  private get inputBusy() { return this.busyHands() || this.awaitingPhysics || !!this.placing || !!this.pendingLift || this.plan.active; }
  private targetActs() { return this.actsNow(this.targetId, this.targetKind).filter(a => !a.blocked); }
  primary() {
    if (this.placing && this.placing.result !== 'moving') this.placing = null;
    if (this.busyHands()) return;
    if (this.pouring) { this.stopPour(); return; }
    if (this.push) { this.endPush(); return; }
    const care = this.careVerb(0);
    if (care) { this.perform(care); return; }
    if (this.work.active) return;
    // A tool in the hands is for its work: the left button starts sweeping, mopping or dusting. Putting it down is its
    // own command (on its rack, G, Y, or place); a curtain or a place under the eyes never takes this click from it.
    if (this.carryingTool) { this.startToolWork(); return; }
    if (this.carrying) {
      if (this.book) { this.turnBook(1); return; }
      if (this.inspecting) { this.setInspecting(false); return; }
      const wasOk = this.placeOk;
      const wasAim = wasOk && this.placeAim ? _mV6.copy(this.placeAim) : null;
      const wasSurface = wasOk ? this.placeSurface : null;
      const wasSaucer = wasOk && this.saucerRotation ? _mQ4.copy(this.saucerRotation) : null;
      this.findPlace(true);
      // Anti-micro-twitch guard: if the preview was visibly green on screen immediately prior to mouse-down
      // and pointer micro-movement nudged the ray < 4 cm onto a bevel, keep the validated green placement spot!
      if (!this.placeOk && wasOk && wasAim && this.physics) {
        const heldId = this.physics.heldIds[0];
        if (heldId && (!this.placeAim || this.placeAim.distanceTo(wasAim) <= .045)) {
          const checkQ = wasSaucer ?? this.placeBodyQuat(heldId);
          if (this.physics.fit(heldId, wasAim, checkQ, false).ok) {
            this.placeAim = wasAim.clone();
            this.placeOk = true;
            this.placeReason = null;
            this.placeSurface = wasSurface;
            this.saucerRotation = wasSaucer ? wasSaucer.clone() : null;
          }
        }
      }
      if (this.placeShelf) { this.putBack(); return; }
      if (this.placeStore) { this.perform('put-away'); return; }
      if (this.placeAim && this.placeOk) { this.perform('place'); return; }
      // Not a place for it, but something the free hand can work (a drawer, a door, a lamp): the hand does that, the other keeps holding.
      const free = this.hands().free > 0 ? this.targetActs().find(a => FREE_HAND.has(a.verb)) : undefined;
      if (free) { this.perform(free.verb); return; }
      this.refusePlace();
      return;
    }
    const a = this.targetActs()[0];
    // The left button does not shove a rack about because the eyes missed a handle: that is the right button.
    if (a && !(a.verb === 'push' && this.targetKind && isRack(this.targetKind))) { this.perform(a.verb); return; }
    const blocked = this.actsNow(this.targetId, this.targetKind).find(x => x.blocked);
    if (blocked?.hint) this.host.say(blocked.hint.vi, blocked.hint.en);
  }
  secondary() {
    if (this.busyHands()) return;
    if (this.push) { this.endPush(); return; }
    const care = this.careVerb(2);
    if (care) { this.perform(care); return; }
    if (this.work.active) return;
    const acts = this.targetActs();
    // With a book open the right button goes back a page.
    if (this.book) { this.turnBook(-1); return; }
    // With something in the hands the right button is for the thing itself: up to the eyes to look at it and turn it, and back down.
    if (this.carrying) { this.setInspecting(!this.inspecting); this.host.changed(); return; }
    const push = acts.find(a => a.verb === 'push');
    if (push) { this.perform('push'); return; }
    const blockedPush = this.actsNow(this.targetId, this.targetKind).find(x => x.verb === 'push' && x.blocked);
    if (blockedPush?.hint) { this.host.say(blockedPush.hint.vi, blockedPush.hint.en); return; }
    const a = acts[1];
    if (a) this.perform(a.verb);
  }
  /** The middle button: what is in the hands comes up to the eyes, and goes back down. */
  middle() {
    if (this.busyHands() || this.push || this.work.active) return;
    if (this.carrying) { this.setInspecting(!this.inspecting); this.host.changed(); return; }
    const p = this.targetId ? this.host.placed.get(this.targetId) : null;
    if (p && StudyPhysics.canPick(p.obj)) this.inspect(p);
  }
  /** A click on a place the thing does not fit: the ring says why, the hands keep it. */
  private refusePlace() {
    this.preview?.refuse();
    const r = this.placeReason ?? { vi: 'Nhìn vào mặt bàn, kệ hoặc sàn để đặt vật xuống.', en: 'Look at a desk, a shelf or the floor to put it down.' };
    this.host.say(r.vi, r.en);
  }
  private busyHands() { return this.actions.busy || this.drinking != null || this.passing != null; }
  /** Mouse wheel: rotates carried/inspected objects 360° around the active axis (`Y`/`X`/`Z`); Shift+wheel adjusts hold reach; wheel while pushing turns furniture. */
  wheel(dy: number, shift: boolean) {
    if (!dy) return false;
    if (this.book) { this.turnBook(Math.sign(dy)); return true; }
    if (this.push) { this.push.yawTarget += Math.sign(dy) * Math.PI / 12; return true; }
    if (!this.carrying) return false;
    if (shift) {
      this.carryFar = T.MathUtils.clamp(this.carryFar + Math.sign(dy) * -.03, -.08, .36);
      this.host.changed();
    } else {
      this.rotateHeld3D(Math.sign(dy) * (Math.PI / 12), false);
    }
    return true;
  }

  /** Cycles the active 360-degree rotation axis (`'y' -> 'x' -> 'z'`) for ANY carried or inspected non-tool object. */
  cycleRotationAxis(): boolean {
    const { p } = this.heldThing();
    if (!this.carrying || !p || toolOf(p.obj.kind) || this.book || this.push || this.work.active) return false;
    this.rotAxis = nextRotationAxis3D(this.rotAxis);
    this.gizmo?.setHighlightAxis(this.rotAxis);
    contactSound('cloth', .1, .4);
    this.host.changed();
    this.host.wake();
    return true;
  }

  /** Toggles the interactive 3D rotation/translation gizmo (`KeyT`) while carrying or inspecting. */
  setGizmoActive(active: boolean): boolean {
    const next = Boolean(active && this.carrying && !this.carryingTool && !this.work?.active && !this.book && !this.push);
    if (Boolean(this.gizmoActive) === next) {
      if (!next) {
        this.endGizmoDrag();
        this.gizmo?.hide();
      }
      return next;
    }
    this.gizmoActive = next;
    if (!next) {
      this.endGizmoDrag();
      this.gizmo?.hide();
    } else {
      this.gizmo ??= new TransformGizmo3D();
      if (this.gizmo.group.parent !== this.host.stage) this.host.stage.add(this.gizmo.group);
      this.gizmo.setHighlightAxis(this.rotAxis ?? 'y');
    }
    this.host.changed?.();
    this.host.wake?.();
    return next;
  }

  toggleGizmo(): boolean {
    return this.setGizmoActive(!this.gizmoActive);
  }

  private beginGizmoDragFromAim(): boolean {
    const gizmo = this.gizmo, ex = this.host.exploration;
    if (!gizmo?.visible) return false;
    this.gizmoVirtualNdc.set(ex.aim.x, ex.aim.y);
    this.gizmoRaycaster.setFromCamera(this.gizmoVirtualNdc, ex.camera);
    const hit = gizmo.hitTest(this.gizmoRaycaster);
    if (!hit) return false;
    if (!gizmo.beginDrag(this.gizmoRaycaster, this.gizmoVirtualNdc, ex.camera, hit)) return false;
    this.rotAxis = hit.axis;
    gizmo.setHighlightAxis(this.rotAxis);
    if (typeof window !== 'undefined' && !this.gizmoWindowUpBound) {
      this.gizmoWindowUpBound = true;
      window.addEventListener('pointerup', this.onWindowGizmoUp, { passive: true });
    }
    this.host.changed();
    return true;
  }

  private endGizmoDrag(): void {
    if (typeof window !== 'undefined' && this.gizmoWindowUpBound) {
      this.gizmoWindowUpBound = false;
      window.removeEventListener('pointerup', this.onWindowGizmoUp);
    }
    if (this.gizmo?.dragging) {
      this.gizmo.endDrag();
      this.host.changed();
    }
  }

  /** Applies an arbitrary 3D stage-space quaternion to the held object, placement preview, and Rapier hold target. */
  private applyHeldGroupQuaternion(nextStageQuat: T.Quaternion, triggerRegrip = true): void {
    const { id, side, p } = this.heldThing();
    const ch = this.host.character(), physics = this.physics;
    if (!id || side == null || !p || !physics) return;
    this.placeGroupQuat.copy(nextStageQuat).normalize();
    this.placeYaw = extractPreservedYaw(this.placeGroupQuat);
    this.placeTilt = 0;
    this.invalidatePlaceCache();
    if (ch?.ready) {
      this.carryInBodyQuat.copy(ch.root.quaternion).invert().multiply(this.placeGroupQuat).normalize();
      this.carryYaw = this.placeYaw - (ch.root.rotation.y - Math.PI);
    } else {
      this.carryInBodyQuat.copy(this.placeGroupQuat);
    }
    this.handTurn = 0;
    this.wristTurn = null;
    if (this.inspecting) {
      physics.syncHoldPose(side, physics.pointOf(id) ?? p.group.position, this.placeGroupQuat, false);
    }
    if (triggerRegrip && !this.inspecting) {
      this.scheduleComfortRegrip(p, this.placeGroupQuat);
    }
  }

  /**
   * Re-evaluates comfortable wrist/palm anchors on `p` when 3-axis rotation or `Reset Upright`
   * rotates secured sockets beyond natural wrist comfort, gliding grips smoothly over `0.22 s`.
   */
  private scheduleComfortRegrip(p: Placed, targetStageQuat: T.Quaternion): void {
    if (toolOf(p.obj.kind) || this.book || this.placing || this.pouring?.p === p || this.drinking) return;
    const id = p.obj.id;
    const anchors = this.grasps.get(id);
    const ch = this.host.character(), rig = ch?.rig, physics = this.physics;
    if (!anchors?.size || !ch?.ready || !rig || !physics) return;

    const k = this.k;
    const f = ch.bodyForward(new T.Vector3()).normalize();
    const right = new T.Vector3().crossVectors(f, UP);
    const arms: GraspReach[] = [];
    const home = new T.Vector3();
    for (const [s, anchor] of anchors) {
      const reach = rig.armReach(s), upright = rig.armHome(s);
      if (!reach || !upright) return;
      arms.push({
        local: anchor.local,
        ...reach,
        limit: .76,
        pole: reach.shoulder.clone().addScaledVector(right, s * .34 * k).addScaledVector(UP, -.42 * k).addScaledVector(f, -.12 * k),
      });
      home.add(upright.shoulder).addScaledVector(UP, -.36 * upright.length).addScaledVector(f, .52 * upright.length + this.carryFar * k);
    }
    home.divideScalar(anchors.size);

    const testWorld = this.host.stage.matrixWorld.clone().multiply(new T.Matrix4().compose(new T.Vector3(), targetStageQuat, p.group.scale));
    const mid = new T.Vector3();
    for (const arm of arms) mid.add(new T.Vector3().setFromMatrixPosition(testWorld.clone().multiply(arm.local)));
    testWorld.setPosition(home.clone().addScaledVector(mid, -1 / anchors.size));
    const checkFit = fitGraspTranslation(testWorld, arms, .025 * k);

    // Also check if palm/finger frame twisted past natural comfort (> 0.52 rad residual or infeasible)
    let needsRegrip = !checkFit.feasible || checkFit.residual > .018 * k;
    if (!needsRegrip) {
      for (const [s, anchor] of anchors) {
        const reach = rig.armReach(s);
        if (!reach) continue;
        const handMat = checkFit.matrix.clone().multiply(anchor.local);
        const wPos = new T.Vector3().setFromMatrixPosition(handMat);
        const fDir = new T.Vector3(0, 1, 0).transformDirection(handMat).normalize();
        const pDir = new T.Vector3(0, 0, 1).transformDirection(handMat).normalize();
        const pole = reach.shoulder.clone().addScaledVector(right, s * .34 * k).addScaledVector(UP, -.42 * k).addScaledVector(f, -.12 * k);
        const solved = solveArm(reach.shoulder, wPos, pole, reach.upper, reach.fore);
        const st = wristStrain(s, reach.shoulder, solved.elbow, solved.wrist, fDir, pDir);
        if (st.bend > .92 || Math.abs(st.roll) > 1.38) {
          needsRegrip = true;
          break;
        }
      }
    }
    if (!needsRegrip) return;

    // Sample fresh ergonomic grip contacts at `(sampleStagePos, targetStageQuat)` while restoring `p.group` immediately.
    const savedPos = p.group.position.clone();
    const savedQuat = p.group.quaternion.clone();
    const sampleStagePos = this.toStage(home);
    const a = affordanceOf(p.obj.kind);
    const dimensions = this.ownBox(p).getSize(new T.Vector3()).multiply(p.group.scale);
    const style = graspFor(a, [dimensions.x, dimensions.y, dimensions.z]);
    const shape = this.shapeOf(p);
    const handle = HANDLES[p.obj.kind], loop = handle?.loop?.(p.obj.scale);
    const meshKey = `${p.obj.kind}|${p.obj.scale}`, skipMesh = (o: T.Object3D) => !graspable(o);

    let perHand = this.regrips.get(id);
    if (!perHand) {
      perHand = new Map();
      this.regrips.set(id, perHand);
    }

    try {
      p.group.position.copy(sampleStagePos);
      p.group.quaternion.copy(targetStageQuat);
      p.group.updateWorldMatrix(true, true);
      const box = new T.Box3().setFromObject(p.group);
      const size = box.getSize(new T.Vector3());
      const sizes: [number, number, number] = [size.x / k, size.y / k, size.z / k];
      const c = box.getCenter(new T.Vector3());
      const radius = Math.min(.09, Math.min(sizes[0], sizes[2]) * .5);
      const flat = sizes[1] * .5;
      const touch = (from: T.Vector3, dir: T.Vector3, far: number) => surfaceHit(p.group, meshKey, from, dir, far, skipMesh);

      for (const [s, anchor] of anchors) {
        let freshContact: HandContact;
        if (handle) {
          freshContact = this.gripBar(p, handle, s, shape, loop);
        } else if (style === 'both') {
          const facing = ch.bodyForward(new T.Vector3());
          const across = new T.Vector3().crossVectors(facing, UP).multiplyScalar(s);
          const high = c.clone().addScaledVector(UP, Math.min(.3, sizes[1] * .22) * k).addScaledVector(facing, -Math.min(.14, Math.max(sizes[0], sizes[2]) * .24) * k);
          const from = high.clone().addScaledVector(across, .6 * k);
          const flank = touch(from, across.clone().negate(), 1.2 * k) ?? surfaceNearest(p.group, meshKey, from, .8 * k, skipMesh);
          if (flank) freshContact = this.grip(flank.point, s, a.grip, 'side', 0, shape, () => flank);
          else freshContact = this.grip(high.clone().add(across.clone().multiplyScalar(Math.min(.34, Math.max(sizes[0], sizes[2]) * .5) * k)), s, a.grip, 'side', .012, shape);
        } else if (style === 'edge') {
          freshContact = this.gripEdge(p, s, shape);
        } else if (style === 'top') {
          freshContact = this.grip(c, s, a.grip === 'book' ? 'pinch' : a.grip, 'top', flat, shape, touch);
        } else {
          freshContact = this.grip(c, s, a.grip, 'side', radius, shape, touch);
        }
        const freshFrame = new GraspFrame(p.group, freshContact);
        perHand.set(s, {
          anchor,
          from: anchor.local.clone(),
          to: freshFrame.local.clone(),
          t: 0,
          duration: .22,
          done: false,
        });
      }
    } finally {
      p.group.position.copy(savedPos);
      p.group.quaternion.copy(savedQuat);
      p.group.updateWorldMatrix(true, true);
    }
  }

  /** Rotates the carried or inspected object continuously 360° around `this.rotAxis` (`'y' | 'x' | 'z'`). */
  private rotateHeld3D(deltaRad: number, snap15: boolean): void {
    const { id, side, p } = this.heldThing();
    if (!id || side == null || !p || toolOf(p.obj.kind) || this.book || this.push || this.work.active) return;
    const step = snap15 ? Math.sign(deltaRad) * (Math.PI / 12) : deltaRad;
    const space = this.rotAxis === 'y' ? 'world' : 'local';

    if (this.inspecting) {
      const nextQ = applyAxisRotation3D(p.group.quaternion, this.rotAxis, step, space);
      this.applyHeldGroupQuaternion(nextQ, false);
      contactSound('cloth', .08, .4);
      this.host.changed();
      return;
    }

    applyAxisRotation3D(this.placeGroupQuat, this.rotAxis, step, space, this.placeGroupQuat);
    this.placeYaw = extractPreservedYaw(this.placeGroupQuat);
    this.placeTilt = 0;
    this.invalidatePlaceCache();

    const ch = this.host.character();
    const curCarryStage = ch?.ready
      ? ch.root.quaternion.clone().multiply(this.carryInBodyQuat)
      : this.placeGroupQuat.clone();
    applyAxisRotation3D(curCarryStage, this.rotAxis, step, space, curCarryStage);
    if (ch?.ready) {
      this.carryInBodyQuat.copy(ch.root.quaternion).invert().multiply(curCarryStage).normalize();
    } else {
      this.carryInBodyQuat.copy(curCarryStage);
    }

    if (this.rotAxis === 'y') {
      if (!this.rollInHand(step)) {
        this.carryYaw += step;
        this.handTurn += step;
      }
    } else {
      this.wristTurn = null;
    }
    this.scheduleComfortRegrip(p, curCarryStage);
    contactSound('cloth', .08, .4);
    this.host.changed();
  }

  /** Turns what is in the hands and its ghost together around the active 3D axis (`'y' | 'x' | 'z'`). */
  private turnBy(step: number) {
    this.rotateHeld3D(step, false);
  }

  /**
   * Resets a carried, inspected, or aimed-at tilted object cleanly upright (`up.y === 1.0000`)
   * while preserving its exact horizontal yaw (`uprightQuatFrom`).
   */
  resetUpright(): boolean {
    const { id, side, p } = this.heldThing();
    if (id && side != null && p && !toolOf(p.obj.kind) && !this.book && !this.push && !this.work.active) {
      const sourceQ = this.inspecting ? p.group.quaternion : this.placeGroupQuat;
      const upright = uprightQuatFrom(sourceQ);
      this.applyHeldGroupQuaternion(upright, true);
      this.physics?.syncHoldPose(side, this.physics.pointOf(id) ?? p.group.position, upright, false);
      if (this.gizmo?.visible) {
        this.gizmo.attach(
          this.gizmoAnchorPosScratch.copy(this.placeAim ?? p.group.position),
          upright,
          this.preview?.radius() ?? .35,
          this.preview?.localPivotOffset(this.gizmoPivotScratch),
        );
      }
      contactSound(affordanceOf(p.obj.kind).material, .24, .45);
      this.host.changed();
      this.host.wake();
      return true;
    }
    if (!this.carrying && this.targetId) {
      const targetPlaced = this.host.placed.get(this.targetId);
      if (
        targetPlaced &&
        !targetPlaced.obj.locked &&
        affordanceOf(targetPlaced.obj.kind).mobility !== 'fixed' &&
        !isSpaceObjectUpright(targetPlaced.obj, targetPlaced.group, MIN_SEAT_UPRIGHT_DOT)
      ) {
        this.rightUprightInPlace(targetPlaced);
        return true;
      }
    }
    return false;
  }

  private readonly gizmoAnchorPosScratch = new T.Vector3();
  private readonly gizmoPivotScratch = new T.Vector3();

  private applyRightUprightCommit(p: Placed): void {
    if (this.host.placed.get(p.obj.id) !== p || p.obj.locked) return;
    const ch = this.host.character();
    const walk = this.host.walkable?.() ?? this.host.navigation();
    const walkGroundAt =
      walk && 'groundAt' in walk && typeof (walk as { groundAt?: unknown }).groundAt === 'function'
        ? ((walk as { groundAt: (x: number, z: number) => number | null }).groundAt.bind(walk))
        : undefined;
    const x = p.group.position.x;
    const z = p.group.position.z;
    const floorY = walkGroundAt?.(x, z) ?? ch?.floorY(x, z) ?? 0;
    let restY = floorY;
    if (CATALOG_BY_ID[p.obj.kind]?.place === 'surface' && p.group.position.y > floorY + .22 && this.physics) {
      const surf = this.physics.surfaceBelow(new T.Vector3(x, p.group.position.y + .25, z), 1.1, p.obj.id);
      if (surf) restY = surf.y;
    }
    const patch = resetSpaceObjectUprightPatch(p.obj, p.group.quaternion);
    const uprightQ = new T.Quaternion().setFromAxisAngle(UP, patch.rotY);

    this.physics?.forget(p.obj.id);
    p.group.position.set(x, restY, z);
    p.group.quaternion.copy(uprightQ);
    p.group.updateMatrixWorld(true);
    p.obj.pos = [x, restY, z];
    p.obj.rotY = patch.rotY;
    p.obj.quat = undefined;
    if (patch.state !== undefined) p.obj.state = patch.state;
    if (p.blob) p.blob.visible = true;

    this.host.objectState(p.obj.id, { pos: [x, restY, z], ...patch }, `right-upright-${p.obj.id}`);
    this.syncRoom();
    this.host.navigationChanged?.();
    contactSound(affordanceOf(p.obj.kind).material, .34, .45);
    this.host.changed();
    this.host.wake();
  }

  /** Handles `'right-upright'` on fallen/tilted furniture or props when hands are free. */
  private rightUprightInPlace(p: Placed): void {
    const a = affordanceOf(p.obj.kind);
    if (p.obj.locked || a.mobility === 'fixed') return;
    if (this.carrying) {
      this.host.say('Đặt vật đang cầm xuống trước.', 'Put down what you are holding first.');
      return;
    }
    const ch = this.host.character();
    if (ch?.body.seat) {
      this.standThen(() => this.rightUprightInPlace(p));
      return;
    }
    const dist = ch?.ready ? Math.hypot(p.group.position.x - ch.root.position.x, p.group.position.z - ch.root.position.z) : 0;
    if (!ch?.ready || dist <= 1.45) {
      ch?.rig?.play('reach', null);
      this.applyRightUprightCommit(p);
      return;
    }
    const worldCenter = () => new T.Box3().setFromObject(p.group).getCenter(new T.Vector3());
    this.touch(() => this.toStage(worldCenter()), worldCenter, 'push', 'open', .68, () => {
      this.applyRightUprightCommit(p);
    }, a.material);
  }

  private rollInHand(step: number) {
    const { id, side, p } = this.heldThing(), ch = this.host.character(), rig = ch?.rig;
    if (!id || side == null || !p || !ch || !rig || this.placing || this.work.active || this.inspecting || this.pouring || this.drinking) return false;
    const anchors = this.grasps.get(id), anchor = anchors?.get(side);
    if (!anchor || !anchors) return false;
    if (this.wristTurn?.anchor !== anchor || this.wristTurn.travelMix > .01) {
      const inverse = ch.root.getWorldQuaternion(new T.Quaternion()).invert();
      const local = (v: T.Vector3) => v.applyQuaternion(inverse);
      const origin = ch.root.getWorldPosition(new T.Vector3());
      const point = (v: T.Vector3) => local(v.sub(origin));
      const arms = [];
      for (const s of [side, -side]) {
        if (!anchors.has(s)) continue;
        const reach = rig.armReach(s), wrist = new T.Vector3(), fingers = new T.Vector3(), palm = new T.Vector3();
        const elbow = rig.elbowWorld(s, new T.Vector3());
        if (!reach || !elbow || !rig.handFrame(s,wrist,fingers,palm)) return false;
        const strain = wristStrain(s,reach.shoulder,elbow,wrist,fingers,palm);
        arms.push({side:s,shoulder:point(reach.shoulder),elbow:point(elbow),wrist:point(wrist),
          fingers:local(fingers),palm:local(palm),bend:Math.max(.9,strain.bend),roll:Math.max(1.4,Math.abs(strain.roll))});
      }
      const primary = arms[0], axis = arms.length === 2 ? arms[1].wrist.clone().sub(primary.wrist) : primary.wrist.clone().sub(primary.elbow);
      if (axis.lengthSq() < 1e-8) return false;
      this.wristTurn = { id, side, anchor, arms, start:ch.root.position.clone(), travelMix:0, angle:0, axis:axis.normalize(), far:this.carryFar };
    }
    const turn = this.wristTurn;
    // Rotate around the forearm (or both grip points). At the wrist's end
    // range the secured grasp holds; a reverse notch immediately unwinds it.
    let lo = 0, hi = 1;
    for (let i = 0; i < 10; i++) {
      const fraction = i ? (lo + hi) / 2 : 1, angle = turn.angle + step * fraction;
      const fits = turn.arms.every(a => {
        const strain = wristStrain(a.side,a.shoulder,a.elbow,a.wrist,
          a.fingers.clone().applyAxisAngle(turn.axis,angle),a.palm.clone().applyAxisAngle(turn.axis,angle));
        return strain.bend <= a.bend + 1e-6 && Math.abs(strain.roll) <= a.roll + 1e-6;
      });
      if (fits) { lo = fraction; if (fraction === 1) break; } else hi = fraction;
    }
    turn.angle += step * lo;
    return true;
  }
  /**
   * Keyboard manipulation controls:
   * - `KeyZ`: cycles 3D rotation axis `'y' -> 'x' -> 'z'` for ALL carried/inspected non-tool objects!
   * - `KeyQ` / `KeyE`: rotates 360° around active axis (`Shift` = `15°` snap, normal = smooth continuous rotation).
   * - `KeyR`: resets carried/inspected or aimed-at tilted object upright (`uprightQuatFrom`, preserving yaw).
   * - `KeyT`: toggles `TransformGizmo3D` when carrying/inspecting (`!this.push`).
   */
  turnKey(code: string, down: boolean, repeat: boolean) {
    if (code === 'ShiftLeft' || code === 'ShiftRight') {
      this.shiftDown = down;
      return false;
    }
    if (code === 'KeyR') {
      if (!down) return false;
      if (repeat) return Boolean(this.carrying && !this.carryingTool);
      const { p } = this.heldThing();
      if (this.carrying && p && !toolOf(p.obj.kind) && !this.book && !this.push && !this.work.active) {
        const checkQ = this.inspecting ? p.group.quaternion : this.placeGroupQuat;
        if (worldUpYFromQuat(checkQ) < EXACT_UPRIGHT_MIN_UP_Y) {
          return this.resetUpright();
        }
        return false;
      }
      if (!this.carrying && this.targetId && !this.push) {
        const t = this.host.placed.get(this.targetId);
        if (t && !t.obj.locked && affordanceOf(t.obj.kind).mobility !== 'fixed' && !isSpaceObjectUpright(t.obj, t.group, MIN_SEAT_UPRIGHT_DOT)) {
          return this.resetUpright();
        }
      }
      return false;
    }
    if (code === 'KeyT') {
      if (this.push) return false;
      if (!this.carrying || this.carryingTool || this.work.active || this.book) return false;
      if (!down) return true;
      if (!repeat) this.toggleGizmo();
      return true;
    }
    if (code !== 'KeyQ' && code !== 'KeyE' && code !== 'KeyZ') return false;
    if (!down) { this.turnHeld = null; return this.carrying; }
    if (!this.carrying || this.push || this.work.active || this.book || this.carryingTool) return false;
    // E stays the key that works things: with the eyes on an open drawer, or on something only the free hand can work, it does that. Anywhere else it turns what is held.
    if (!this.inspecting && code === 'KeyE' && this.targetId?.startsWith('life:') && this.hands().free > 0) return false;
    if (!this.inspecting && code === 'KeyE' && (this.placeStore || (this.hands().free > 0 && !(this.placeAim && this.placeOk) && this.targetActs().some(a => FREE_HAND.has(a.verb))))) return false;
    if (repeat) return true;
    if (code === 'KeyZ') {
      return this.cycleRotationAxis();
    }
    const dir = code === 'KeyQ' ? 1 : -1;
    if (this.shiftDown) {
      this.rotateHeld3D(dir * (Math.PI / 12), true);
      this.turnHeld = { dir, wait: .24 };
    } else {
      this.rotateHeld3D(dir * (Math.PI / 36), false);
      this.turnHeld = { dir, wait: .16 };
    }
    return true;
  }
  /** All carried non-tool objects support 3-axis 360° orientation & standing/tilting. */
  private get canStand() {
    const id = this.physics?.heldIds[0];
    const p = id ? this.host.placed.get(id) : null;
    return Boolean(id && p && !toolOf(p.obj.kind) && !this.book);
  }
  private placeBodyQuat(id?: string | null) {
    const heldId = id ?? this.physics?.heldIds[0];
    const q0 = heldId ? this.physics?.startOf(heldId) : null;
    return q0 ? this.placeGroupQuat.clone().multiply(q0.clone().invert()) : this.placeGroupQuat.clone();
  }
  private bodyQuat(yaw: number) {
    const q = new T.Quaternion().setFromAxisAngle(UP, yaw), id = this.physics?.heldIds[0], q0 = id ? this.physics?.startOf(id) : null;
    if (!this.placeTilt || !q0) return q;
    const face = new T.Vector3(0, 0, 1).applyQuaternion(q0), own = new T.Quaternion().setFromAxisAngle(UP, Math.atan2(face.x, face.z));
    const tilt = new T.Quaternion().setFromAxisAngle(this.placeTilt === 1 ? new T.Vector3(1, 0, 0) : new T.Vector3(0, 0, 1), Math.PI / 2);
    return q.multiply(own).multiply(tilt).multiply(q0.clone().invert());
  }
  /** The legs while furniture is in the hands: they take the force's direction instead of walking freely. True: taken. */
  steer(x: number, z: number, running: boolean) {
    if (!this.push) return false;
    this.steerIntent.x = x; this.steerIntent.z = z; this.steerIntent.running = running;
    return true;
  }
  /** Holding the effort key while pushing adds strength; pressing it while carrying toggles `TransformGizmo3D`. */
  effortHold(on: boolean) {
    const was = this.effortKey;
    this.effortKey = on;
    if (on && !was && !this.push && this.carrying && !this.carryingTool && !this.work.active && !this.book) {
      this.toggleGizmo();
    }
  }
  /** Esc, a lost pointer lock: whatever the hands were straining at stops; a carried thing stays carried. */
  cancelManipulation() {
    this.queue = [];
    this.work.press(false);
    this.endGizmoDrag();
    if (this.gizmoActive) this.setGizmoActive(false);
    if (this.push) this.endPush();
    if (this.inspecting) this.setInspecting(false);
    this.cancelPlacement();
    if (this.carryAt) { const side = this.physics?.sideOf(this.carryAt.id); if (side != null) this.physics?.liftOut(side); this.carryAt = null; }
  }
  /** Mouse movement: drags an active 3D gizmo handle, turns an inspected object in 3 axes, or pulls a drawer. */
  turning(dx: number, dy: number) {
    if (this.drawer?.pulling) { this.drawer.manual += dy * .0022; return true; }
    const ex = this.host.exploration;
    if (this.gizmoActive && this.gizmo?.visible) {
      if (!this.gizmo.dragging && !ex.locked && this.gizmo.hovered) {
        this.beginGizmoDragFromAim();
      }
      if (this.gizmo.dragging) {
        if (ex.locked) {
          const w = Math.max(320, ex.camera.aspect * 720);
          this.gizmoVirtualNdc.x = T.MathUtils.clamp(this.gizmoVirtualNdc.x + (dx / w) * 2, -1.2, 1.2);
          this.gizmoVirtualNdc.y = T.MathUtils.clamp(this.gizmoVirtualNdc.y - (dy / 720) * 2, -1.2, 1.2);
        } else {
          this.gizmoVirtualNdc.set(ex.aim.x, ex.aim.y);
        }
        this.gizmoRaycaster.setFromCamera(this.gizmoVirtualNdc, ex.camera);
        const dragState = this.gizmo.updateDrag(this.gizmoRaycaster, this.gizmoVirtualNdc, this.shiftDown);
        if (dragState) {
          if (dragState.kind === 'rotate') {
            this.applyHeldGroupQuaternion(dragState.quaternion, !this.inspecting);
          } else {
            this.gizmoOffset.copy(dragState.deltaTranslation);
            this.invalidatePlaceCache();
          }
          this.host.changed();
        }
        return true;
      }
    }
    if (!this.inspecting || !this.physics || this.book) return false;
    for (const side of [1, -1]) {
      const id = this.physics.heldIn(side);
      if (id) {
        const dz = this.rotAxis === 'z' ? -dx * .006 : 0;
        const dyYaw = this.rotAxis === 'z' ? 0 : dx * .006;
        this.physics.turnHeld(side, dyYaw, dy * .006, dz);
        const held = this.host.placed.get(id);
        if (held) {
          this.placeGroupQuat.copy(held.group.quaternion).normalize();
          this.placeYaw = extractPreservedYaw(this.placeGroupQuat);
        }
        return true;
      }
    }
    return false;
  }
  /** E: what is under the eyes, or what is in the hand. */
  interact(id: string | null): boolean {
    if (id === null) return this.useHeld();
    if (this.inputBusy) { this.enqueue(0, performance.now()); return true; }
    if (this.carrying && id.startsWith('life:') && this.hands().free > 0) {
      const door = this.targetActs().find(a => a.verb === 'open' || a.verb === 'close');
      if (door) { this.perform(door.verb); return true; }
    }
    // With a tool, E is the tool's own use too, unless what the eyes are on is a thing the tool is used with (rack, bucket, sink, bin).
    if (this.carryingTool && !this.careVerb(0)) { this.startToolWork(); return true; }
    if (this.book && this.useHeld()) return true;
    // While seated with empty hands, pressing E on a surface/rug/cabinet with no unblocked seated action stands up cleanly.
    const ch = this.host.character();
    if (!this.carrying && ch?.body.seat && this.targetActs().length === 0) {
      this.host.standUp();
      return true;
    }
    this.primary();
    return true;
  }
  useHeld(): boolean {
    const first = this.physics?.heldIds[0] ? this.host.placed.get(this.physics.heldIds[0]) : null;
    if (!first) {
      if (this.resetUpright()) return true;
      const ch = this.host.character();
      if (ch?.body.seat) {
        this.host.standUp();
        return true;
      }
      return false;
    }
    if (toolOf(first.obj.kind)) return this.resumeTool();
    const checkQ = this.inspecting ? first.group.quaternion : this.placeGroupQuat;
    if (!this.book && worldUpYFromQuat(checkQ) < EXACT_UPRIGHT_MIN_UP_Y) {
      return this.resetUpright();
    }
    const list = heldActs(first.obj.kind, { reading: !!this.book, sipsLeft: this.sipsOf(first.obj), inspecting: this.inspecting });
    const a = list.find(x => !['inspect', 'drop', 'throw'].includes(x.verb));
    if (!a) return false;
    this.perform(a.verb);
    return true;
  }
  /** A movement key, a click on Cancel, Esc: the body stops what it was on its way to do. What is in its hands stays there. */
  interrupt(explicit = false) {
    // Once through the frame, a held key cannot pull the body back into the wall; Cancel still can, up to the threshold.
    if (!explicit && (this.passing || this.walkedIn || this.plan.label === 'arrive')) return;
    this.queue = [];
    this.actions.cancel();
    this.plan.cancel();
    this.work.cancelOperation();
    if (this.toolExtraction) { this.toolExtraction.stopped = true; this.toolExtraction.task = null; }
    this.cancelPlacement();
    if (explicit && this.push) this.endPush();
    if (this.journeyTo) { this.journeyTo = null; this.passing = null; this.host.exploration.setPassing(false); this.host.changed(); }
  }
  /** A panel, a lost focus, a hidden tab: the hands stop straining and the buttons are up. Carried things stay carried. */
  released() {
    if (this.pickupActive && !this.carrying) this.actions.cancel();
    this.endGizmoDrag();
    this.shiftDown = false;
    this.press = null; this.queue = []; this.effortKey = false; this.work.press(false);
    this.work.cancelOperation();
    if (this.toolExtraction) { this.toolExtraction.stopped = true; this.toolExtraction.task = null; }
    if (this.push) this.endPush();
    if (this.drawer?.pulling) this.endPull(1000);
  }

  // ── Doing things ────────────────────────────────────────────────────────────────────────────────────
  perform(verb: Verb, id: string | null | undefined = this.targetId, charge = .5) {
    const placed = id ? this.host.placed.get(id.startsWith('drawer:') ? id.split(':')[1] : id) : null;
    // Hands on furniture let go of it before they do anything else: nothing is sat on, opened or lifted while it is still being moved.
    if (this.push) { const same = verb === 'push' && placed?.obj.id === this.push.id; this.endPush(); if (same) return; }
    if (['dip', 'wring', 'rinse', 'empty'].includes(verb) && !this.work.active) this.resumeTool();
    switch (verb) {
      case 'carry-tool': {
        const tool = this.work.active;
        if (tool && !this.inputBusy && !this.toolExtraction && this.carryTool(tool.side)) this.host.changed();
        break;
      }
      case 'work-tool':
        if (!this.inputBusy && !this.toolExtraction && this.resumeTool()) this.host.changed();
        break;
      case 'right-upright': if (placed) this.rightUprightInPlace(placed); else this.resetUpright(); break;
      case 'pick': if (placed) this.lift(placed); break;
      case 'take-one': if (placed) this.takeOne(placed); break;
      case 'browse': if (placed) this.host.openLibrary?.(placed.obj.id); break;
      case 'take-book': { const [, shelf, ...key] = (this.targetId ?? '').split(':'); const book = this.host.library?.().find(b => b.key === key.join(':')); if (book) this.takeBook(shelf, book); break; }
      case 'put-back': this.findPlace(); this.putBack(); break;
      case 'place': this.setDown(); break;
      case 'put-away': this.putAway(); break;
      case 'drop': this.letGoNow(); break;
      case 'throw': this.throwHeld(charge); break;
      case 'inspect': this.inspect(placed); break;
      case 'push': if (placed) this.beginPush(placed); break;
      case 'sit': if (placed) this.sit(placed, false); break;
      case 'lie': if (placed) this.sit(placed, true); break;
      case 'stand': this.host.standUp(); break;
      case 'open': case 'close': if (id) this.openClose(id, verb === 'open'); break;
      case 'pass': if (id?.startsWith('portal:')) this.host.portal(id.slice(7) as WorldDestination); break;
      case 'switch': if (placed) { if (placed.obj.kind === 'kettle.vintage') this.useKettle(placed); else this.useLamp(placed); } break;
      case 'lid': if (placed) this.toggleState(placed, 'lid', 'plastic'); break;
      case 'power': if (placed) this.toggleState(placed, 'on', 'plastic'); break;
      case 'use': if (id && placed) { if (placed.obj.kind === 'laptop' || placed.obj.kind === 'monitor') this.useDevice(placed); else this.useTool(placed); } break;
      case 'write': if (id && placed) this.useTool(placed); break;
      case 'drink': this.drink(); break;
      case 'refill': this.refill(); break;
      case 'read': this.setInspecting(true); break;
      case 'turn-page': this.turnBook(1); break;
      case 'spin': if (placed) this.spin(placed); break;
      case 'flip': this.flip(placed); break;
      case 'straighten': if (placed) this.straighten(placed); break;
      case 'look-through': if (placed) this.lookThrough(placed); break;
      case 'stroke': if (placed) this.stroke(placed); break;
      case 'hug': this.hug(placed); break;
      case 'wear': this.wear(placed); break;
      case 'hang': if (placed) this.hangBack(placed); break;
      case 'dip': if (placed) this.dipIn(placed); break;
      case 'wring': if (placed) this.wringOut(placed); break;
      case 'rinse': if (placed) this.rinseAt(placed); break;
      case 'fill': if (placed) this.fillAt(placed); break;
      case 'pour': this.pourInto(placed ?? null); break;
      case 'change-bulb': { const lamp = this.lampNearEyes(); if (lamp) this.changeBulb(lamp); break; }
      case 'empty': if (placed) this.emptyInto(placed); break;
      case 'discard': if (placed) this.discardInto(placed); break;
      case 'take-bag': if (placed) this.takeBag(placed); break;
      case 'bag-out': this.bagOut(); break;
      case 'run-water': if (placed) this.runWater(placed); break;
    }
    this.host.changed(); this.host.wake();
  }

  resumeCarry(id:string) {
    const p=this.host.placed.get(id);
    if (!p || this.inputBusy || this.physics?.heldIds.includes(id)) return false;
    this.lift(p);
    return true;
  }

  /** Lifts a thing. One hand if it takes one; both arms round it if it takes both. */
  private lift(p: Placed, then?: () => void) {
    const a = affordanceOf(p.obj.kind), h = this.hands();
    const need = a.hands;
    if (this.host.character()?.occupies(p.obj.id)) { this.host.say('Đứng dậy trước đã.', 'Stand up first.'); return; }
    if (h.free < need) { this.host.say(need === 2 ? 'Vật này cần cả hai tay.' : 'Hai tay đang bận.', need === 2 ? 'This takes both hands.' : 'Both hands are full.'); return; }
    // Its weight against what arms can lift: past that it stays where it is, whatever the button says.
    const weight = liftResistance(p.obj.kind);
    if (!weight.feasible) { this.host.say(`Quá nặng để nhấc lên (${Math.round(weight.breakaway)} N).`, `Too heavy to lift (${Math.round(weight.breakaway)} N).`); return; }
    const run = (near: boolean) => { this.awaitingPhysics = true; void this.ensurePhysics().then(physics => { this.awaitingPhysics = false; if (physics && this.host.placed.get(p.obj.id) === p) this.liftNow(physics, p, near, then); }); };
    // A tool stands against a rack: the place to reach it from is in front of the rack, wherever its middle is.
    const at = new T.Box3().setFromObject(p.group).getCenter(new T.Vector3());
    const s = this.approachFor(this.toStage(at), .5, () => run(true));
    if (s) run(false);
  }
  private liftNow(physics: StudyPhysics, p: Placed, near: boolean, then?: () => void) {
    const id = p.obj.id, a = affordanceOf(p.obj.kind);
    const box = new T.Box3().setFromObject(p.group), size = box.getSize(new T.Vector3()), k = this.k;
    const sizes: [number, number, number] = [size.x / k, size.y / k, size.z / k];
    const dimensions = this.ownBox(p).getSize(new T.Vector3()).multiply(p.group.scale);
    const style = graspFor(a, [dimensions.x, dimensions.y, dimensions.z]);
    const at = box.getCenter(new T.Vector3());
    const side = this.handFor(at);
    const shape = this.shapeOf(p);
    const meshKey = `${p.obj.kind}|${p.obj.scale}`, skipMesh = (o: T.Object3D) => !graspable(o);
    const touch = (from: T.Vector3, dir: T.Vector3, far: number) => surfaceHit(p.group, meshKey, from, dir, far, skipMesh);
    // The hand closes on the thing as it is drawn (between two physics steps), so the fingers and the thing never part on a fast screen.
    const centre = () => new T.Box3().setFromObject(p.group).getCenter(new T.Vector3());
    const radius = Math.min(.09, Math.min(sizes[0], sizes[2]) * .5) ;
    const flat = sizes[1] * .5;
    const spec = toolOf(p.obj.kind);
    let retryFrames: Map<number, GraspFrame> | undefined;
    const handle = HANDLES[p.obj.kind], loop = handle?.loop?.(p.obj.scale);
    const contact = (s: number): HandContact => {
      const sliding = this.book?.host === p.group || this.pouring?.p === p;
      let anchors = this.grasps.get(id);
      if (!anchors) { anchors = new Map(); this.grasps.set(id, anchors); }
      if (sliding) anchors.delete(s);
      if (spec && this.work.active?.p === p) {
        if (s === side) return this.work.contactFirst();
        if (this.work.supportContact) return this.work.supportContact;
      }
      const established = physics.heldIds.includes(id) && !sliding ? anchors.get(s) : null;
      if (established) return this.securedContact(p, established);
      const retry = retryFrames?.get(s);
      if (retry && !physics.heldIds.includes(id)) return { ...retry.contact(), secured: false };
      const hand = contactOn(s);
      if (!spec && !hand.on) { p.group.updateWorldMatrix(true, false); hand.on = p.group; hand.onAt = p.group.getWorldPosition(new T.Vector3()); }
      hand.kg = massNow(p.obj.kind, p.obj.state, a.mass);
      if (!spec && physics.heldIds.includes(id) && !sliding) anchors.set(s, new GraspFrame(p.group, hand));
      return hand;
    };
    this.reachKg = massNow(p.obj.kind, p.obj.state, a.mass);
    const contactOn = (s: number): HandContact => {
      const c = centre();
      // A tool is taken by its handle, a bucket or a bag by what is there to hold.
      if (spec) {
        if (this.work.active?.p === p) {
          return s === side ? this.work.contactFirst() : (this.work.supportContact ?? this.work.gripWorld(p, spec, 0, s, true));
        }
        return spec.hands === 2 && s === -side
          ? this.work.gripWorld(p, spec, 0, s, true)
          : this.work.gripWorld(p, spec, spec.hands === 2 ? 1 : 0, s);
      }
      if (handle) return this.gripBar(p, handle, s, shape, loop);
      if (p.obj.kind === 'trash.bag') { p.group.updateWorldMatrix(true, false); return this.grip(new T.Vector3(0, .38, 0).applyMatrix4(p.group.matrixWorld), s, 'handle', 'over', 0, shape); }
      if (this.book && this.book.host === p.group) return this.grip(c.clone().addScaledVector(UP, -.1 * k), s, 'book', 'side', .19, shape);
      // A plant is taken by its pot: low on it, round its real side, never by the leaves.
      if (a.family === 'plant' && a.hands === 1) { p.group.updateWorldMatrix(true, false); return this.grip(p.group.getWorldPosition(new T.Vector3()).addScaledVector(UP, Math.min(.09, sizes[1] * .25) * k), s, a.grip, 'side', radius, shape, touch); }
      if (style === 'both') {
        // A big thing is held by its sides, high up on it where the arms come in: both hands stay in view, it hangs from them.
        // Always derive `facing` from the character's horizontal direction toward `c` first so even if the body started
        // turned away, the left/right flank grips stay uncrossed on the near side facing the character!
        const chNow = this.host.character();
        const chWorld = chNow ? chNow.root.getWorldPosition(new T.Vector3()) : null;
        const toObj = chWorld ? new T.Vector3(c.x - chWorld.x, 0, c.z - chWorld.z) : null;
        const facing = toObj && toObj.lengthSq() > 1e-4
          ? toObj.normalize()
          : this.host.exploration.view === 'third'
            ? chNow!.bodyForward(new T.Vector3())
            : this.host.exploration.lookFlat(new T.Vector3());
        const across = new T.Vector3().crossVectors(facing, UP).multiplyScalar(s);
        // On the near half of its sides: a person's arms come from the chest, they do not reach round to the far end.
        const high = c.clone().addScaledVector(UP, Math.min(.3, sizes[1] * .22) * k).addScaledVector(facing, -Math.min(.14, Math.max(sizes[0], sizes[2]) * .24) * k);
        // Its real side, wherever the thing is turned: the hand comes in from outside, at the height the hands come.
        const from = high.clone().addScaledVector(across, .6 * k);
        const flank = touch(from, across.clone().negate(), 1.2 * k)
          ?? surfaceNearest(p.group, meshKey, from, .8 * k, skipMesh);
        // Keep this selected surface. A second ray in a different direction
        // can miss it or cross a hole and put the palm back in empty space.
        if (flank) return this.grip(flank.point, s, a.grip, 'side', 0, shape, () => flank);
        const chest = across.multiplyScalar(Math.min(.34, Math.max(sizes[0], sizes[2]) * .5) * k);
        return this.grip(high.add(chest), s, a.grip, 'side', .012, shape);
      }
      if (style === 'edge') return this.gripEdge(p, s, shape);
      if (style === 'top') return this.grip(c, s, a.grip === 'book' ? 'pinch' : a.grip, 'top', flat, shape, touch);
      return this.grip(c, s, a.grip, 'side', radius, shape, touch);
    };
    // A short tool's handle can sit well outside the centre of its head.
    // Take the last step toward the wrist's contact point on that handle.
    const floorNow = this.host.character()?.root.position.y ?? 0;
    const handTool = spec && (spec.hands === 1 || this.toStage(at).y - floorNow < .32);
    const approachPoint = handTool ? contactOn(side).wrist : at;
    const arm = handTool ? this.host.character()?.rig?.armReach(side) : null;
    const stop = spec
      ? Math.max(.62, (arm ? .85 * arm.length / k : .55))
      : arm ? .65 * arm.length / k : Math.max(.45, Math.max(sizes[0], sizes[2]) * .5 + .18);
    const seq: Sequence = {
      side,
      express: Boolean(spec),
      approach: near ? undefined : { point: this.toStage(approachPoint), stop },
      reach: spec ? spec.sockets.expressEquipSec : (a.mass > 8 ? .42 : a.mass > 3 ? .36 : a.mass > 1 ? .28 : .22),
      reachTimeout: spec ? .18 : .55,
      keep: true,
      release: spec ? spec.sockets.expressUnequipSec : .28,
      contact: () => contact(side),
      second: spec
        ? (spec.hands === 2 ? () => contact(-side) : undefined)
        : (a.hands === 2 ? () => contact(-side) : undefined),
      reposition: () => {
        const ch = this.host.character(), nav = this.host.walkable?.() ?? this.host.navigation();
        if (!ch?.rig || ch.body.occupied || !nav || this.host.placed.get(id) !== p) return null;
        const frames = new Map<number, GraspFrame>();
        const goals = [];
        for (const s of seq.second ? [side, -side] : [side]) {
          const hand = ch.rig.contactOn(s);
          if (!hand) return null;
          frames.set(s, new GraspFrame(p.group, hand));
          goals.push({ side: s, wrist: hand.wrist, fingers: hand.fingers });
        }
        const center = goals.reduce((sum, g) => sum.add(g.wrist), new T.Vector3()).divideScalar(goals.length);
        const arm = ch.rig.armReach(side);
        if (!arm) return null;
        const seed = this.toStage(center).addScaledVector(ch.bodyForward(new T.Vector3()), -.74 * arm.length / k).setY(ch.root.position.y);
        const heading = { yaw: ch.root.rotation.y };
        const stance = ch.rig.reachStance(goals, seed, heading.yaw, at => nav.free(at), undefined, heading);
        if (!stance) return null;
        retryFrames = frames;
        return dt => {
          if (ch.body.occupied || this.host.placed.get(id) !== p) return null;
          const arrived = this.host.exploration.walkToward(stance, .006, dt, true, true, heading.yaw);
          if (arrived !== true) return arrived;
          ch.turnBody(heading.yaw, dt);
          const gap = heading.yaw - ch.root.rotation.y;
          return Math.abs(Math.atan2(Math.sin(gap), Math.cos(gap))) < .015;
        };
      },
      ready: () => {
        const rig = this.host.character()?.rig;
        if (!rig) return false;
        if (spec) {
          const c = rig.contactOn(side);
          return !!c && rig.contactProgress(side) >= .88 && rig.wristWorld(side).distanceTo(c.wrist) <= .052 * k;
        }
        return (a.hands === 2 ? [side, -side] : [side]).every(s => {
          const c = rig.contactOn(s);
          return !!c && rig.contactProgress(s) >= .92 && rig.wristWorld(s).distanceTo(c.wrist) <= .038 * k;
        });
      },
      onUnreachable: () => this.host.say('Tay chưa với tới chỗ cầm. Hãy tiến lại gần hoặc chọn phía khác.', 'The grip is out of reach. Move closer or try another side.'),
      onDone: () => {
        if (spec && physics.heldIds.includes(id)) {
          this.resumeTool();
          this.host.changed();
        }
      },
      onContact: () => {
        const here = this.host.character(), c = centre();
        if (here && Math.hypot(c.x - here.root.getWorldPosition(new T.Vector3()).x, c.z - here.root.getWorldPosition(new T.Vector3()).z) > 1.45 * k) { this.actions.cancel(); return; }
        contactSound(a.material, .3, .45);
        this.restoreWobbleRest(p);
        if (p.obj.inside) this.takeOutOfDrawer(p);
        if (p.group.parent !== this.host.stage) this.host.stage.add(p.group);
        p.group.scale.setScalar(p.obj.scale);
        const layout = this.host.layout();
        if (layout) {
          if (spec && here?.ready) {
            // Express `< 160 ms` Broom/Mop/Tool Equip: snap directly to body-referenced `canonicalCarryPose`,
            // capture both upper + lower `GraspFrame`s, suppress self-rack contact, and enter ready work/carry immediately!
            const preEquipPos = p.group.position.clone();
            let sourceRack: string | undefined;
            for (const rack of this.host.placed.values()) {
              if (!isRack(rack.obj.kind) || rack.obj.hidden) continue;
              const spot = onRack(rack.obj, p.obj.kind);
              const nearSpot = spot ? preEquipPos.distanceTo(new T.Vector3(...spot.pos)) < .26 : false;
              const nearRackHz = Math.hypot(preEquipPos.x - rack.group.position.x, preEquipPos.z - rack.group.position.z) < .58;
              if (nearSpot || nearRackHz) {
                sourceRack = rack.obj.id;
                break;
              }
            }
            const carryPose = this.work.canonicalCarryPose(p, side, here.root.position, here.root.quaternion);
            if (carryPose) {
              p.group.position.copy(carryPose.position);
              p.group.quaternion.copy(carryPose.rotation);
              p.group.updateWorldMatrix(true, true);
            }
            const canonical = this.work.captureCanonicalGrasps(p, side);
            if (canonical?.size) {
              this.grasps.set(id, canonical);
            } else {
              const fallback = new Map<number, GraspFrame>();
              for (const s of spec.hands === 2 ? [side, -side] : [side]) {
                const g = s === side ? this.work.gripWorld(p, spec, spec.hands === 2 ? 1 : 0, s, true) : this.work.gripWorld(p, spec, 0, s, true);
                fallback.set(s, new GraspFrame(p.group, g));
              }
              this.grasps.set(id, fallback);
            }
            physics.pick(p, [...this.host.placed.values()], layout.room.size, side);
            retryFrames = undefined;
            if (sourceRack) {
              physics.setSourceRackWithdrawal(id, sourceRack);
            }
            physics.syncCarriedToolPose(side, id, p.group.position, p.group.quaternion, 1 / 60, true);
            if (spec.hands === 2) this.twoHanded.add(id); else this.twoHanded.delete(id);
            this.toolExtraction = null;
            this.toolCarryFrames.delete(id);
            this.liftingOff.delete(id);
            this.intoHands = null;
            this.work.begin(p, side, this.grasps.get(id)!);
            this.work.finishWithdrawal(p.group.position, p.group.quaternion);
          } else {
            const anchors = new Map<number, GraspFrame>();
            for (const s of a.hands === 2 ? [side, -side] : [side]) {
              const reached = here?.rig?.contactOn(s);
              if (reached) anchors.set(s, new GraspFrame(p.group, { ...reached, shape: reached.wrap && reached.shape ? reached.shape : this.shapeOf(p) }));
            }
            this.grasps.set(id, anchors);
            physics.pick(p, [...this.host.placed.values()], layout.room.size, side);
            retryFrames = undefined;
            if (a.hands === 2) this.twoHanded.add(id);
          }
        }
        this.carried.set(id, { w: sizes[0], h: sizes[1], d: sizes[2] });
        this.rotAxis = 'y';
        this.gizmoOffset.set(0, 0, 0);
        this.gizmo?.setHighlightAxis('y');
        const bodyYaw = here!.root.rotation.y - Math.PI;
        this.carryFar = 0; this.placeTilt = 0; this.handTurn = 0;
        this.placeGroupQuat.copy(p.group.quaternion).normalize();
        this.placeYaw = extractPreservedYaw(this.placeGroupQuat);
        this.carryYaw = this.placeYaw - bodyYaw;
        let initialCarryStageQuat = p.group.quaternion.clone();
        const held = HANDLES[p.obj.kind];
        if (held?.carry && !spec) {
          const look = here!.bodyForward(new T.Vector3()), across = new T.Vector3().crossVectors(look, UP);
          const want = held.carry === 'ahead' ? Math.atan2(look.x, look.z) : Math.atan2(across.x * side * .85 - look.x * .5, across.z * side * .85 - look.z * .5) - Math.atan2(held.at[0], held.at[2]);
          const stood = physics.startOf(id);
          this.carryYaw = want - (stood ? 2 * Math.atan2(stood.y, stood.w) : 0) - bodyYaw;
          if (worldUpYFromQuat(p.group.quaternion) >= MIN_SEAT_UPRIGHT_DOT) {
            initialCarryStageQuat = new T.Quaternion().setFromAxisAngle(UP, want);
          }
        }
        this.carryInBodyQuat.copy(here!.root.quaternion).invert().multiply(initialCarryStageQuat).normalize();
        if (!spec) {
          if (this.toStage(box.min).y > .15) this.liftingOff.add(id);
          const point = physics.pointOf(id);
          this.intoHands = point ? { id, t: 0, from: point, stalled: 0, peak: point.y } : null;
        }
        // The weight comes on to the arms: the body dips towards it and catches itself.
        { const rig = this.host.character()?.rig, m = this.host.character()?.bodyKg ?? 60, here = this.host.character(); if (rig && here) { const f = here.bodyForward(new T.Vector3()); const kg = massNow(p.obj.kind, p.obj.state, a.mass); rig.bump(f.x * Math.min(.5, kg / m * 1.4), f.z * Math.min(.5, kg / m * 1.4)); } }
        if (p.blob) p.blob.visible = false;
        this.host.navigationChanged?.();
        this.host.changed(); then?.();
      },
    };
    this.actions.start(seq);
    this.host.wake();
  }
  private twoHanded = new Set<string>();
  /** The thing's own box, in its own axes: it does not grow when the thing is turned. */
  private ownBox(p: Placed) {
    const cached = p.group.userData.ownBox as T.Box3 | undefined;
    if (cached) return cached;
    p.group.updateWorldMatrix(true, true);
    const box = new T.Box3(), inv = p.group.matrixWorld.clone().invert(), vertex = new T.Vector3(), m = new T.Matrix4();
    p.group.traverse(o => {
      const mesh = o as T.Mesh;
      if (!mesh.isMesh || mesh.userData.blob || mesh.userData.noCollision) return;
      const positions = mesh.geometry.getAttribute('position');
      if (!positions) return;
      m.multiplyMatrices(inv, mesh.matrixWorld);
      for (let i = 0; i < positions.count; i++) box.expandByPoint(vertex.fromBufferAttribute(positions, i).applyMatrix4(m));
    });
    p.group.userData.ownBox = box;
    return box;
  }
  /** Thumb on top, fingers under, at the nearest point of its rim to where that hand comes from: a keyboard by its end, a book by its corner. */
  private gripEdge(p: Placed, side: number, shape: () => GraspShape | null): HandContact {
    const k = this.k, ch = this.host.character()!, ex = this.host.exploration, box = this.ownBox(p);
    const flat = ex.view === 'third' ? ch.bodyForward(new T.Vector3()) : ex.lookFlat(new T.Vector3()), right = new T.Vector3().crossVectors(flat, UP);
    const eye = this.host.stage.localToWorld(ch.eyePoint(new T.Vector3(), ex.crouchAmount));
    const home = eye.clone().addScaledVector(right, side * .24 * k).addScaledVector(UP, -.42 * k).addScaledVector(flat, .16 * k);
    p.group.updateWorldMatrix(true, false);
    const local = home.clone().applyMatrix4(p.group.matrixWorld.clone().invert()), rim = local.clone().clamp(box.min, box.max);
    if (local.x === rim.x && local.z === rim.z) {
      const x = local.x - box.min.x < box.max.x - local.x ? box.min.x : box.max.x;
      const z = local.z - box.min.z < box.max.z - local.z ? box.min.z : box.max.z;
      if (Math.abs(x - rim.x) < Math.abs(z - rim.z)) rim.x = x;
      else rim.z = z;
    }
    rim.y = (box.min.y + box.max.y) / 2;
    const point = rim.clone().applyMatrix4(p.group.matrixWorld);
    const inward = new T.Box3().copy(box).getCenter(new T.Vector3()).applyMatrix4(p.group.matrixWorld).sub(point);
    if (inward.lengthSq() < 1e-6) inward.copy(flat);
    inward.normalize();
    // Its real underside a little in from the edge: the fingers go under it and it lies on them, the thumb comes over the top.
    const flatIn = inward.clone().setY(0);
    if (flatIn.lengthSq() > 1e-6) {
      flatIn.normalize();
      const under = surfaceHit(p.group, `${p.obj.kind}|${p.obj.scale}`, point.clone().addScaledVector(flatIn, .045 * k).addScaledVector(UP, -.4 * k), UP, .8 * k, o => !graspable(o));
      if (under) {
        const below = this.toStage(under.point);
        // Start above the contact skin: a bevel can already be fractionally
        // below the support plane when the saved object is loaded.
        below.y += .035;
        const support = this.physics?.surfaceBelow(below, .080, p.obj.id);
        if (!support) return { wrist: under.point.clone().addScaledVector(UP, -.024 * k).addScaledVector(flatIn, -.072 * k), fingers: flatIn, palm: UP.clone(), grip: 'book', shape };
        // On a table or floor the underside is occupied. Pinch the exposed
        // upper rim so the wrist stays above the surface during acquisition.
        const over = point.clone().addScaledVector(flatIn, .012 * k).addScaledVector(UP, .4 * k);
        const top = surfaceHit(p.group, `${p.obj.kind}|${p.obj.scale}`, over, UP.clone().negate(), .8 * k, o => !graspable(o));
        if (top) {
          // Off the floor a hand comes down onto the rim from above, fingers pointing down past its edge (about
          // 55 degrees), so the wrist stays a hand's height up and the body squats instead of folding to the floor.
          const floorNow = this.host.character()?.root.position.y ?? 0;
          const onFloor = this.toStage(top.point.clone()).y - floorNow < .12;
          const fingers = flatIn.clone().addScaledVector(UP, onFloor ? -1.4 : -.36).normalize();
          return { wrist: top.point.clone().addScaledVector(fingers, -.083 * k).addScaledVector(UP, .012 * k), fingers, palm: UP.clone().negate(), grip: 'pinch', shape };
        }
      }
    }
    const fingers = inward.clone().multiplyScalar(.96).addScaledVector(UP, -.18).normalize();
    const across = new T.Vector3().crossVectors(fingers, UP).multiplyScalar(side);
    return { wrist: point.clone().addScaledVector(inward, -.062 * k).addScaledVector(UP, .012 * k), fingers, palm: across.multiplyScalar(-.42).addScaledVector(UP, -.9).normalize(), grip: 'book', shape };
  }

  private takeOne(p: Placed) {
    const books = p.group.userData.books as T.Object3D[] | undefined;
    if (!books?.length) { this.lift(p); return; }
    const taken = new Set(p.obj.state?.taken ?? []);
    let index = -1, best = Infinity;
    const at = new T.Vector3();
    books.forEach((b, i) => { if (taken.has(i)) return; b.getWorldPosition(at); const d = at.distanceToSquared(this.hitWorld); if (d < best) { best = d; index = i; } });
    if (index < 0) return;
    const chosen = books[index];
    const world = new T.Box3().setFromObject(chosen).getCenter(new T.Vector3());
    const side = this.handFor(world);
    const take = () => {
      this.actions.start({
        side, reach: .48, release: .3,
        approach: undefined,
        contact: () => this.grip(world, side, 'pinch', 'push'),
        onContact: () => {
          contactSound('paper', .4, .45);
          const id = this.host.uid(), at = this.toStage(world);
          const color = (chosen.userData.color as string | undefined) ?? undefined;
          taken.add(index);
          this.host.objectState(p.obj.id, { state: { ...p.obj.state, taken: [...taken] } }, 'take-one');
          this.host.spawn({ id, kind: 'book.single', pos: [at.x, at.y - .012, at.z], rotY: p.obj.rotY, scale: 1, color });
          this.pendingLift = { id, side };
        },
      });
    };
    const a = this.approachFor(this.toStage(world), .52, take);
    if (a) this.plan.run('take', [{ name: 'walk', tick: dt => this.host.exploration.walkToward(a.point, a.stop, dt) ?? true }, { name: 'take', start: take, tick: () => !this.actions.busy }]);
  }

  private carryTarget(side: number, hold: { id: string; p: Placed }): T.Vector3 {
    const ch = this.host.character(), ex = this.host.exploration, camera = ex.camera, k = this.k;
    const pivot = ch?.ready ? this.host.stage.localToWorld(ch.eyePoint(new T.Vector3(), ex.crouchAmount)) : camera.position.clone();
    const looking = this.inspecting || !!this.book || !!this.drinking;
    const look = looking || !ch?.ready ? camera.getWorldDirection(new T.Vector3()) : ch.bodyForward(new T.Vector3());
    const flat = look.clone().setY(0).normalize(), right = new T.Vector3().crossVectors(flat, UP);
    const a = affordanceOf(hold.p.obj.kind), s = this.carried.get(hold.id) ?? { w: .15, h: .15, d: .15 }, r = Math.max(s.w, s.d) / 2, tall = s.h / 2;
    if (this.carryAt?.id === hold.id) return this.host.stage.localToWorld(this.carryAt.point.clone());
    // A bucket, a bag or anything else with a handle on top hangs from a straight arm at the side, whatever the eyes do.
    const hangs = hold.p.obj.kind === 'kettle.vintage' || hold.p.obj.kind === 'can.watering' ? .8 : null;
    if (hangs !== null && ch?.ready) {
      const face = ch.bodyForward(new T.Vector3()), side2 = new T.Vector3().crossVectors(face, UP), hip = ch.root.getWorldPosition(new T.Vector3());
      // The bar where a hanging arm ends, wherever the thing's own middle then comes.
      const bar = HANDLES[hold.p.obj.kind], physics = this.physics, middle = physics?.pointOf(hold.id);
      // Beside a table it comes in against the leg: it does not hang out over the table's edge and sweep what stands there.
      let out = .24, ahead = .06, lift = 0;
      if (physics) {
        const fromStage = this.toStage(hip.clone().addScaledVector(UP, .6 * k)), dir = side2.clone().multiplyScalar(side).normalize(), room = physics.roomAlong(fromStage, dir, .4);
        // The hand stays outside the thigh, whatever is beside it: with no room at the side the thing is held a little ahead of the leg instead,
        // and a little higher, where the arm still gets (pulled in to the hip it was a fist closed on nothing beside the handle).
        out = T.MathUtils.clamp(room - .125, .15, .24);
        const short = Math.max(0, .275 - room);
        ahead = .06 + Math.min(.2, short * 1.3); lift = Math.min(.12, short * .8);
      }
      const hung = this.hangingTarget(side, hold, out, ahead, lift);
      if (hung) return hung;
      const at = hip.addScaledVector(side2, side * out * k).addScaledVector(face, ahead * k).addScaledVector(UP, (hangs + lift) * k);
      if (bar && middle) { hold.p.group.updateWorldMatrix(true, false); at.sub(new T.Vector3(bar.at[0], bar.at[1], bar.at[2]).applyMatrix4(hold.p.group.matrixWorld).sub(this.host.stage.localToWorld(middle))); }
      return at;
    }
    if ((isBucket(hold.p.obj.kind) || hold.p.obj.kind === 'trash.bag') && ch?.ready) {
      const face = ch.bodyForward(new T.Vector3()), side2 = new T.Vector3().crossVectors(face, UP), hip = ch.root.getWorldPosition(new T.Vector3());
      // The handle where a straight arm ends, from this body's own shoulder and arm.
      const hung = this.hangingTarget(side, hold, .25, .06, 0);
      if (hung) return hung;
      return hip.addScaledVector(side2, side * .25 * k).addScaledVector(face, .06 * k).addScaledVector(UP, (isBucket(hold.p.obj.kind) ? .56 : .6) * k);
    }
    if (this.drinking?.side === side) {
      // To the mouth, wherever the head really is: under the eyes and clear of the face, the elbow out, the hand beside the cheek.
      return pivot.addScaledVector(flat, .125 * k).addScaledVector(UP, -.105 * k).addScaledVector(right, side * .01 * k);
    }
    if (this.book?.side === side) return pivot.addScaledVector(look, (.45 + this.carryFar) * k);
    if (this.inspecting) return pivot.addScaledVector(look, (Math.max(.3, r * 1.5 + .17) + this.carryFar) * k);
    // A frame that goes with the eyes as far as arms do: looking down or up, what is carried stays low in the view, clear of the place being looked at.
    const pitch = looking ? T.MathUtils.clamp(ex.lookPitch, -.85, .55) : 0, fwd = flat.clone().multiplyScalar(Math.cos(pitch)).addScaledVector(UP, Math.sin(pitch)), up = UP.clone().multiplyScalar(Math.cos(pitch)).addScaledVector(flat, -Math.sin(pitch));
    if (this.hugging && a.hands === 2) return pivot.addScaledVector(fwd, (.26 + r * .85) * k).addScaledVector(up, -(.38 + tall * .4) * k);
    // In both arms it stays at the height arms hold it, wherever the eyes go, clear of the chest and stomach.
    if (a.hands === 2) {
      const low = looking ? T.MathUtils.clamp(ex.lookPitch, -.3, .2) : 0, f2 = flat.clone().multiplyScalar(Math.cos(low)).addScaledVector(UP, Math.sin(low)), u2 = UP.clone().multiplyScalar(Math.cos(low)).addScaledVector(flat, -Math.sin(low));
      const minFwd2 = Math.max(.26 + r * 1.02, BODY_FRONT_CLEARANCE_BASE + r);
      return pivot.addScaledVector(f2, (minFwd2 + this.carryFar) * k).addScaledVector(u2, -(.36 + tall * .72) * k);
    }
    const minFwd1 = Math.max(.36 + r * .88, BODY_FRONT_CLEARANCE_BASE + r + .04);
    return pivot.addScaledVector(fwd, (minFwd1 + this.carryFar) * k).addScaledVector(up, -(.17 + tall * .52 + r * .12) * k).addScaledVector(right, side * (.17 + r * .65) * k);
  }

  /**
   * A thing that hangs from the hand: the wrist where a relaxed arm of this body ends (the clip's shoulder, the arm's real
   * length less the secured-reach margin), beside the thigh; the thing below it by the very grip it was taken with.
   * Fixed heights (0.8 m for a can's handle) put the wrist 3 cm below a straight arm, and the body crouched to make it.
   */
  private hangingTarget(side: number, hold: { id: string; p: Placed }, out: number, ahead: number, lift: number): T.Vector3 | null {
    const ch = this.host.character(), rig = ch?.rig, physics = this.physics, anchor = this.grasps.get(hold.id)?.get(side);
    const middle = physics?.pointOf(hold.id);
    if (!ch?.ready || !rig || !anchor || !middle) return null;
    const home = rig.armHome(side);
    if (!home) return null;
    const k = this.k, face = ch.bodyForward(new T.Vector3()), across = new T.Vector3().crossVectors(face, UP);
    const wrist = ch.root.getWorldPosition(new T.Vector3()).addScaledVector(across, side * out * k).addScaledVector(face, ahead * k);
    const r = home.length - .035 * k, h = Math.hypot(wrist.x - home.shoulder.x, wrist.z - home.shoulder.z);
    wrist.y = home.shoulder.y - Math.sqrt(Math.max(0, r * r - h * h)) + lift * k;
    const grip = anchor.contact().wrist.sub(this.host.stage.localToWorld(middle.clone()));
    return wrist.sub(grip);
  }

  /** Both wrist frames constrain one rigid target, measured from the finalized
   * shoulders. The group origin/centre and empty areas of furniture do not
   * determine where a hand can reach. Rapier still accepts the target motion.
   */
  private twoHandCarryPose(p: Placed): { position: T.Vector3; rotation: T.Quaternion } | null {
    const ch = this.host.character(), physics = this.physics;
    if (!ch || !physics || this.grasps.get(p.obj.id)?.size !== 2) return null;
    const bodyRel = this.carryInBodyQuat ?? new T.Quaternion().setFromAxisAngle(UP, (this.carryYaw ?? 0) + (this.handTurn ?? 0));
    const rotation = ch.root.quaternion.clone().multiply(bodyRel);
    return this.rigidCarryPose(p, rotation);
  }
  /** One or two *secured* hands constrain the same rigid object. Catalog
   * hand count cannot create a second grip after tool work released it. */
  private rigidCarryPose(p: Placed, rotation: T.Quaternion): { position: T.Vector3; rotation: T.Quaternion } | null {
    const ch = this.host.character(), anchors = this.grasps.get(p.obj.id), physics = this.physics;
    if (!ch?.rig || !anchors?.size || !physics) return null;
    const isTool = Boolean(toolOf(p.obj.kind));
    const f = ch.bodyForward(_mV1).normalize(), right = _mV2.crossVectors(f, UP), k = this.k;
    const arms: GraspReach[] = [], home = _mV3.set(0, 0, 0);
    let onlySide = 0;
    for (const [side, anchor] of anchors) {
      onlySide = side;
      const reach = ch.rig.armReach(side), upright = ch.rig.armHome(side);
      if (!reach || !upright || !anchor) return null;
      arms.push({ local: anchor.local, ...reach, limit: .8, pole: reach.shoulder.clone().addScaledVector(right, side * .34 * k).addScaledVector(UP, -.42 * k).addScaledVector(f, -.12 * k) });
      // Where it is carried comes from the upright body; what the hands can hold now still bounds each step (the fit).
      const dropScale = isTool ? -.36 : -.28;
      const fwdScale = isTool ? .56 : .64;
      home.add(upright.shoulder).addScaledVector(UP, dropScale * upright.length).addScaledVector(f, fwdScale * upright.length + this.carryFar * k);
    }
    home.divideScalar(anchors.size);
    const own = this.ownBox(p);
    const rootWorld = ch.root.getWorldPosition(_mV4);
    if (!isTool && anchors.size === 1 && !own.isEmpty()) {
      const sz = own.getSize(_mV5).multiply(p.group.scale).multiplyScalar(k);
      const minLat = Math.max(.16 * k, .11 * k + Math.min(.14 * k, Math.min(sz.x, sz.z) * .5));
      const curLat = (home.x - rootWorld.x) * (right.x * onlySide) + (home.z - rootWorld.z) * (right.z * onlySide);
      if (curLat < minLat) home.addScaledVector(right, onlySide * (minLat - curLat));
    }
    const fitAt = (q: T.Quaternion) => {
      const world = _mM1.copy(this.host.stage.matrixWorld).multiply(_mM2.compose(_mV5.set(0, 0, 0), q, p.group.scale));
      // The midpoint of the actual wrist anchors, not the object's AABB.
      const middle = _mV6.set(0, 0, 0);
      for (const a of arms) middle.add(_mV5.setFromMatrixPosition(_mM3.multiplyMatrices(world, a.local)));
      _mV5.setFromMatrixPosition(world).add(home).addScaledVector(middle, -1 / anchors.size);
      world.setPosition(_mV5);

      // Front-of-torso clearance envelope (`minForwardDist >= bodyRadius + objectHalfDepth + 0.08 m`)
      // so plant pots, cups, mugs, books, and props never penetrate the chest, stomach, or thighs.
      if (!isTool && !own.isEmpty()) {
        _mBox1.copy(own).applyMatrix4(world);
        _mBox1.getCenter(_mV7);
        _mBox1.getSize(_mV8);
        const objHalfDepth = Math.min(.22 * k, (Math.abs(f.x) * _mV8.x + Math.abs(f.z) * _mV8.z) * .5);
        const minCenterFwd = (BODY_FRONT_CLEARANCE_BASE + Math.max(-.04, this.carryFar)) * k + objHalfDepth;
        const curCenterFwd = (_mV7.x - rootWorld.x) * f.x + (_mV7.z - rootWorld.z) * f.z;
        if (curCenterFwd < minCenterFwd) {
          _mV5.addScaledVector(f, minCenterFwd - curCenterFwd);
          world.setPosition(_mV5);
        }
      }

      const origin = _mV5.setFromMatrixPosition(world);
      const bottom = _mBox1.copy(own).applyMatrix4(world).min.y - origin.y;
      const local = this.toStage(origin, _mV7);
      const floorY = ch.groundAt?.(local.x, local.z) ?? ch.root.position.y;
      _mV8.set(local.x, floorY, local.z);
      const floor = this.host.stage.localToWorld(_mV8).y + .08 * k - bottom;
      return fitGraspTranslation(world, arms, .025 * k, floor);
    };
    let fit = fitAt(rotation);
    this.graspReachMiss = fit.residual / k;
    // Still low from the pickup, the hands cannot yet hold it the way it is carried: it comes up as it is held first,
    // and turns once the body is up (each frame asks again). Holding it where it was kept the body in the squat for good.
    if (!fit.feasible) { const held = fitAt(p.group.quaternion); if (held.feasible) fit = held; }
    if (!fit.feasible) return { position: p.group.position.clone(), rotation: p.group.quaternion.clone() };
    const accepted = _mM2.copy(this.host.stage.matrixWorld).invert().multiply(fit.matrix), position = new T.Vector3(), outRot = rotation.clone();
    accepted.decompose(position, outRot, _mV5);
    return { position, rotation: outRot };
  }
  graspReachMiss = 0;

  /** A portable rests in its established grasp frame, independent of camera position. */
  private handCarryPose(side: number, p: Placed): { position: T.Vector3; rotation: T.Quaternion } | null {
    const anchor = this.grasps.get(p.obj.id)?.get(side), size = this.carried.get(p.obj.id), ch = this.host.character();
    if (!anchor || !size || !ch?.ready
      || this.inspecting || this.book || this.drinking || this.carryAt || this.pouring?.p === p || this.placing) return null;
    const roll = this.wristTurn;
    if (roll?.anchor === anchor) {
      const arm = roll.arms[0];
      const q = ch.root.getWorldQuaternion(new T.Quaternion());
      const wrist = arm.wrist.clone().applyQuaternion(q).add(ch.root.getWorldPosition(new T.Vector3()))
        .addScaledVector(ch.bodyForward(new T.Vector3()), (this.carryFar-roll.far)*this.k);
      const fingers = arm.fingers.clone().applyAxisAngle(roll.axis,roll.angle).applyQuaternion(q);
      const palm = arm.palm.clone().applyAxisAngle(roll.axis,roll.angle).applyQuaternion(q);
      const reach = ch.rig?.armReach(arm.side);
      if (roll.arms.length === 1 && roll.travelMix < .01 && reach) {
        // Project the requested grip about its wrist before driving the prop.
        // A small flexion correction at a moving shoulder must not send the
        // elbow around the opposite side of its hinge circle.
        const pole = arm.elbow.clone().applyQuaternion(q).add(ch.root.getWorldPosition(new T.Vector3()));
        const hinge = solveArm(reach.shoulder, wrist, pole, reach.upper, reach.fore);
        const fore = hinge.wrist.clone().sub(hinge.elbow).normalize();
        const hand = alignWrist(handRotation(fingers, palm, new T.Quaternion()), fore, .82);
        fingers.set(0,1,0).applyQuaternion(hand);
        palm.set(0,0,1).applyQuaternion(hand);
      }
      const pose = anchor.objectPose(wrist,fingers,palm);
      const position = new T.Vector3(), rotation = new T.Quaternion();
      this.host.stage.matrixWorld.clone().invert().multiply(pose).decompose(position,rotation,new T.Vector3());
      roll.travelMix = Math.max(roll.travelMix,T.MathUtils.smoothstep(ch.root.position.distanceTo(roll.start),.02,.25));
      if (roll.travelMix > 0) {
        const carry = this.rigidCarryPose(p,rotation.clone());
        if (carry) position.lerp(carry.position,roll.travelMix);
      }
      return {position,rotation};
    }
    if (toolOf(p.obj.kind)) {
      const frame = this.toolCarryFrames?.get(p.obj.id);
      if (frame?.departureOffset) {
        const rotation = ch.root.quaternion.clone().multiply(frame.rotation);
        return {
          position: frame.departureOffset.clone().applyQuaternion(ch.root.quaternion).add(ch.root.position),
          rotation,
        };
      }
      if (frame && (!frame.useCanonical || !this.work?.canonicalCarryPose)) {
        const rotation = ch.root.quaternion.clone()
          .multiply(new T.Quaternion().setFromAxisAngle(UP, (this.handTurn ?? 0) - frame.turn))
          .multiply(frame.rotation);
        return this.rigidCarryPose(p, rotation);
      }
      if (this.work?.canonicalCarryPose) {
        const stride = ch.stridePhase?.() ?? 0;
        const moveBlend = T.MathUtils.clamp((this.host.exploration?.speed ?? 0) / 1.4, 0, 1);
        return this.work.canonicalCarryPose(p, side, ch.root.position, ch.root.quaternion, stride, moveBlend);
      }
      const fallbackRot = ch.root.quaternion.clone().multiply(frame?.rotation ?? new T.Quaternion());
      return this.rigidCarryPose(p, fallbackRot);
    }
    if (affordanceOf(p.obj.kind).hands === 2) return this.twoHandCarryPose(p);
    if (isBucket(p.obj.kind) || p.obj.kind === 'can.watering' || p.obj.kind === 'kettle.vintage' || p.obj.kind === 'trash.bag') return null;
    if (size.h >= .09 || HANDLES[p.obj.kind] || (this.placeGroupQuat && worldUpYFromQuat(this.placeGroupQuat) < EXACT_UPRIGHT_MIN_UP_Y)) {
      const bodyRel = this.carryInBodyQuat ?? new T.Quaternion().setFromAxisAngle(UP, (this.carryYaw ?? 0) + (this.handTurn ?? 0));
      const rotation = ch.root.quaternion.clone().multiply(bodyRel);
      return this.rigidCarryPose(p, rotation);
    }
    const f = ch.bodyForward(_mV1).normalize(), right = _mV2.crossVectors(f, UP), k = this.k;
    // From the clip's shoulder, not the bent one: measured from the solved trunk a carry target sank with every crouch
    // (the pickup's own), and the body never stood up again. The trunk planner bends only as far as this still needs.
    const reach = ch.rig?.armHome(side);
    if (!reach) return null;
    const objHalfDepth = Math.min(.18, Math.max(size.w, size.d) * .5);
    const minWristFwd = Math.max(.64 * reach.length, (BODY_FRONT_CLEARANCE_BASE + objHalfDepth * .55) * k);
    const wrist = reach.shoulder.clone()
      .addScaledVector(UP, -.28 * reach.length)
      .addScaledVector(f, minWristFwd + this.carryFar * k)
      .addScaledVector(right, side * Math.max(.18 * reach.length, .09 * k));
    const fingers = f.clone().addScaledVector(right, -side * .2).normalize();
    const resting = anchor.objectPose(wrist, fingers, UP);
    const turn = _mQ1.setFromAxisAngle(UP, this.handTurn);
    if (this.placeTilt) {
      // The chosen side belongs to the object's axes; apply that rotation to the
      // hand about its wrist, preserving the established local grasp throughout.
      resting.decompose(_mV3, _mQ2, _mV4);
      const axis = _mV3.set(this.placeTilt === 1 ? 1 : 0, 0, this.placeTilt === 2 ? 1 : 0).applyQuaternion(_mQ2);
      turn.multiply(_mQ3.setFromAxisAngle(axis, Math.PI / 2));
    }
    fingers.applyQuaternion(turn);
    // Reserve a little wrist range for the collarbone's subsequent adjustment.
    const pole = reach.shoulder.clone().addScaledVector(right, side * .34 * k).addScaledVector(UP, -.42 * k).addScaledVector(f, -.12 * k);
    let feasible = reachableWrist(reach.shoulder, wrist, fingers, reach.upper, reach.fore, .8, pole);
    const palmUp = _mV4.copy(UP).applyQuaternion(turn);
    let world = anchor.objectPose(feasible, fingers, palmUp);
    const own = this.ownBox(p);
    if (!own.isEmpty()) {
      const rootW = ch.root.getWorldPosition(_mV5);
      _mBox1.copy(own).applyMatrix4(world);
      _mBox1.getCenter(_mV6);
      _mBox1.getSize(_mV7);
      const rotHalfDepth = Math.min(.20 * k, (Math.abs(f.x) * _mV7.x + Math.abs(f.z) * _mV7.z) * .5);
      const minCenterFwd = (BODY_FRONT_CLEARANCE_BASE + Math.max(-.04, this.carryFar)) * k + rotHalfDepth;
      const curCenterFwd = (_mV6.x - rootW.x) * f.x + (_mV6.z - rootW.z) * f.z;
      if (curCenterFwd < minCenterFwd) {
        wrist.addScaledVector(f, minCenterFwd - curCenterFwd);
        feasible = reachableWrist(reach.shoulder, wrist, fingers, reach.upper, reach.fore, .8, pole);
        world = anchor.objectPose(feasible, fingers, palmUp);
      }
    }
    const local = _mM1.copy(this.host.stage.matrixWorld).invert().multiply(world), position = new T.Vector3(), rotation = new T.Quaternion();
    local.decompose(position, rotation, _mV3);
    return { position, rotation };
  }

  /**
   * Shared placement reachability invariant used by `findPlace()` so preview (`placeOk`) and commit (`setDown`)
   * agree 100%: a spot beyond `MAX_PLACE_REACH`, on another floor, or completely walled off is NEVER shown green.
   */
  private checkPlacementReachable(spot: T.Vector3): { ok: true } | { ok: false; vi: string; en: string } {
    const ch = this.host.character();
    if (!ch) return { ok: false, vi: 'Chưa sẵn sàng.', en: 'Not ready yet.' };
    const k = this.k;
    const chPos = ch.root.position;
    const horizDist = Math.hypot(spot.x - chPos.x, spot.z - chPos.z);
    if (horizDist > MAX_PLACE_REACH) {
      return { ok: false, vi: 'Chỗ đó xa quá.', en: 'That is too far away.' };
    }
    const spotFloorY = ch.groundAt?.(spot.x, spot.z) ?? chPos.y;
    if (Math.abs(spotFloorY - chPos.y) > 1.35) {
      return { ok: false, vi: 'Chỗ đó ở tầng khác.', en: 'That spot is on another level.' };
    }
    const relY = spot.y - spotFloorY;
    if (relY > 2.15 * k || relY < -.35 * k) {
      return { ok: false, vi: 'Chỗ đó ngoài tầm với.', en: 'That spot is out of reach.' };
    }

    const layout = this.host.layout();
    if (layout) {
      const half = layout.room.size / 2;
      const playerInRoom = Math.abs(chPos.x) <= half + .12 && Math.abs(chPos.z) <= half + .12 && Math.abs(chPos.y) < 1.2;
      const spotInRoom = Math.abs(spot.x) <= half + .12 && Math.abs(spot.z) <= half + .12 && Math.abs(spot.y) < 2.8;
      if (playerInRoom !== spotInRoom && !layout.room.windowOpen && (spot.z < -half - .06 || chPos.z < -half - .06)) {
        return { ok: false, vi: 'Cửa sổ đang đóng.', en: 'The window is closed.' };
      }
    }

    if (horizDist <= DIRECT_PLACE_REACH * k) {
      return { ok: true };
    }

    const nav = this.host.walkable?.() ?? this.host.navigation();
    if (!nav) return { ok: true };

    const baseAngle = Math.atan2(chPos.x - spot.x, chPos.z - spot.z);
    for (const radius of [.62, .86, 1.08, 1.30]) {
      for (let i = 0; i < 12; i++) {
        const offset = (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * (Math.PI / 6);
        const ang = baseAngle + offset;
        const px = spot.x + Math.sin(ang) * radius * k;
        const pz = spot.z + Math.cos(ang) * radius * k;
        if (!nav.free({ x: px, z: pz })) continue;
        if (ch.groundAt) {
          const gy = ch.groundAt(px, pz);
          if (gy !== null && Math.abs(gy - chPos.y) > .85) continue;
        }
        return { ok: true };
      }
    }
    return { ok: false, vi: 'Không có lối tới chỗ đó.', en: 'Cannot reach that spot from here.' };
  }

  /** Finds the nearest walkable approach stance within `1.32 m` of `to` when `reachStance` cannot find an exact IK grid node. */
  private findFallbackApproachStance(
    to: T.Vector3,
    ch: Character,
    occupied?: (at: T.Vector3) => boolean,
  ): T.Vector3 | null {
    const nav = this.host.walkable?.() ?? this.host.navigation();
    const chPos = ch.root.position;
    const k = this.k;
    const baseAngle = Math.atan2(chPos.x - to.x, chPos.z - to.z);
    let best: T.Vector3 | null = null;
    let bestCost = Infinity;
    for (const radius of [.66, .84, 1.04, 1.24]) {
      for (let i = 0; i < 12; i++) {
        const offset = (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * (Math.PI / 6);
        const ang = baseAngle + offset;
        const px = to.x + Math.sin(ang) * radius * k;
        const pz = to.z + Math.cos(ang) * radius * k;
        const py = ch.groundAt?.(px, pz) ?? chPos.y;
        if (Math.abs(py - chPos.y) > .85) continue;
        _mV7.set(px, py, pz);
        if (occupied?.(_mV7)) continue;
        if (nav && !nav.free(_mV7)) continue;
        const travel = Math.hypot(px - chPos.x, pz - chPos.z) + radius * .25;
        if (travel < bestCost) {
          bestCost = travel;
          best = (best ?? new T.Vector3()).copy(_mV7);
        }
      }
      if (best) break;
    }
    return best;
  }

  /** Where the eyes say the thing in the hand could go. Any surface the thing would stand on, within a walk. */
  private findPlace(force = false) {
    const physics = this.physics;
    const heldId = physics?.heldIds[0];
    const held = heldId ? this.host.placed.get(heldId) : null;
    // Tools are hung on a rack or stowed via G/Y/place rather than showing a floor preview ring during active sweeping.
    if (!held || this.inspecting || this.work.active || this.carryAt || toolOf(held.obj.kind)) {
      this.saucerRotation = null;
      this.placeAim = null; this.placeStore = null; this.placeShelf = null; this.placeOk = false; this.placeReason = null; this.placeSurface = null;
      this.placeRayCacheValid = false;
      return;
    }
    const ex = this.host.exploration;
    const ch = this.host.character();
    if (!ch) {
      this.saucerRotation = null;
      this.placeAim = null; this.placeStore = null; this.placeShelf = null; this.placeOk = false; this.placeReason = null; this.placeSurface = null;
      this.placeRayCacheValid = false;
      return;
    }
    const k = this.k;
    ch.root.getWorldPosition(V3_A);
    const maxPlaceDist = ex.camera.position.distanceTo(V3_A) + 14 * k;
    RAY_A.near = 0;
    RAY_A.far = maxPlaceDist;
    RAY_A.setFromCamera(ex.aim, ex.camera);

    const freeHands = this.hands().free;
    const curSeat = ch.body.seat ?? null;
    if (
      !force &&
      this.placeRayCacheValid &&
      this.placeRayHeldId === heldId &&
      this.placeRayTargetId === this.targetId &&
      this.placeRaySeat === curSeat &&
      this.placeRayFreeHands === freeHands &&
      RAY_A.ray.origin.distanceToSquared(this.placeRayOrigin) <= .0015 ** 2 &&
      RAY_A.ray.direction.angleTo(this.placeRayDir) <= .002 &&
      ch.root.position.distanceToSquared(this.placeRayPlayerPos) <= .0015 ** 2 &&
      this.placeGroupQuat.angleTo(this.placeRayQuat) <= .002 &&
      this.gizmoOffset.distanceToSquared(this.placeRayGizmo) <= 1e-8
    ) {
      RAY_A.far = Infinity;
      return;
    }

    this.placeRayCacheValid = true;
    this.placeRayHeldId = heldId!;
    this.placeRayOrigin.copy(RAY_A.ray.origin);
    this.placeRayDir.copy(RAY_A.ray.direction);
    this.placeRayPlayerPos.copy(ch.root.position);
    this.placeRayQuat.copy(this.placeGroupQuat);
    this.placeRayGizmo.copy(this.gizmoOffset);
    this.placeRayTargetId = this.targetId;
    this.placeRaySeat = curSeat;
    this.placeRayFreeHands = freeHands;

    this.saucerRotation = null;
    this.placeAim = null; this.placeStore = null; this.placeShelf = null; this.placeOk = false; this.placeReason = null; this.placeSurface = null;

    const heldIds = physics!.heldIds;
    TARGET_ROOTS.length = 0;
    for (const p of this.host.placed.values()) if (!p.obj.hidden && !heldIds.includes(p.obj.id)) TARGET_ROOTS.push(p.group);
    const room = this.host.room();
    if (room) TARGET_ROOTS.push(room.group);
    const lifeRoots = this.host.lifeRoots?.();
    if (lifeRoots) for (let i = 0; i < lifeRoots.length; i++) TARGET_ROOTS.push(lifeRoots[i]);
    const hit = raycastClosest(RAY_A, TARGET_ROOTS, maxPlaceDist, false, false);
    TARGET_ROOTS.length = 0;
    RAY_A.far = Infinity;
    if (!hit) return;
    const local = this.toStage(hit.point).add(this.gizmoOffset);
    const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : UP.clone();
    const surfaceWorld = this.host.stage.localToWorld(local.clone());
    const refuse = (vi: string, en: string) => { this.placeAim = local; this.placeOk = false; this.placeReason = { vi, en }; this.placeSurface = { point: surfaceWorld.clone(), normal }; };

    const reachGate0 = this.checkPlacementReachable(local);
    if (!reachGate0.ok) {
      refuse(reachGate0.vi, reachGate0.en);
      return;
    }

    // An open drawer takes small things.
    const id = hit.object.userData.objectId as string | undefined, host = id ? this.host.placed.get(id) : null;
    if (host?.obj.kind === 'saucer' && held.obj.kind === 'teacup' && worldUpYFromQuat(this.placeGroupQuat) >= MIN_SEAT_UPRIGHT_DOT) {
      const start = physics!.startOf(heldId!);
      if (!start) return;
      const axis = _mV1.set(0, 0, 1).applyQuaternion(start);
      const upright = _mQ1.setFromAxisAngle(UP, this.placeYaw + Math.atan2(axis.x, axis.z));
      this.saucerRotation = upright.clone().multiply(_mQ2.copy(start).invert());
      const well = this.toStage(host.group.getWorldPosition(_mV2));
      const seat = physics!.fitCupOnSaucer(heldId!, host.obj.id, well, this.saucerRotation);
      if (!seat) { refuse('Đĩa lót chưa có chỗ đặt tách.', 'The saucer has no clear seat for the cup.'); return; }
      const { fit, support } = seat;
      const saucerReach = this.checkPlacementReachable(fit.center);
      if (!saucerReach.ok) { refuse(saucerReach.vi, saucerReach.en); return; }
      this.placeAim = fit.center; this.placeOk = fit.ok;
      this.placeSurface = { point: this.host.stage.localToWorld(support.clone()), normal: UP.clone() };
      return;
    }
    const sliders = host?.group.userData.sliders as Slider[] | undefined;
    if (sliders && host) for (let n: T.Object3D | null = hit.object; n && n !== host.group; n = n.parent) {
      const slot = sliders.findIndex(s => s.node === n);
      if (slot >= 0 && sliders[slot].open > .5) {
        const size = this.ownBox(held).getSize(_mV1).multiply(held.group.scale).multiplyScalar(k);
        if (Math.max(size.x, size.z) / k < .5 && size.y / k < .16) {
          this.placeStore = { host: id!, slot }; this.placeAim = local; this.placeOk = true;
          this.placeSurface = { point: surfaceWorld.clone(), normal };
        } else {
          refuse('Vật này không vừa ngăn kéo.', 'It does not fit in the drawer.');
        }
        return;
      }
    }
    // A book of the library, and its shelf under the eyes: it goes back among the others.
    if (host && shelfHoldsBooks(host.obj.kind) && held.obj.state?.book) {
      this.placeShelf = host.obj.id; this.placeAim = local; this.placeOk = true;
      this.placeSurface = { point: surfaceWorld.clone(), normal };
      return;
    }
    // The front of a closed drawer, a door, a window, with a hand free: that is what the eyes mean, not a place on the floor in front of it.
    if (/^(drawer|portal|life|window|curtain):/.test(this.targetId ?? '') && freeHands > 0) return;
    // The answer holds while nothing changed: the eyes on the same spot, the thing turned the same way in 3D.
    const pq = this.placeGroupQuat;
    const key = `${heldId}|${local.x.toFixed(3)}|${local.y.toFixed(3)}|${local.z.toFixed(3)}|${pq.x.toFixed(4)},${pq.y.toFixed(4)},${pq.z.toFixed(4)},${pq.w.toFixed(4)}|${normal.y.toFixed(2)}`;
    if (!force && key === this.placeKey && this.placeMemo) {
      this.placeAim = this.placeMemo.center.clone(); this.placeOk = this.placeMemo.ok; this.placeReason = this.placeMemo.reason; this.placeSurface = this.placeMemo.surface;
      return;
    }
    const q = this.placeBodyQuat(heldId);
    let base = local, fit: Fit | null = null;
    if (normal.y < .75) {
      const out = _mV1.copy(normal).setY(0);
      if (out.lengthSq() < .04) { refuse('Mặt này nghiêng, vật sẽ trượt xuống.', 'Too steep: it would slide off.'); return; }
      out.normalize();
      const reach = physics!.radiusOf(heldId!) + .03;
      for (const d of [.03, .07, .12, .17, .23, .3]) {
        const from = _mV2.copy(local).addScaledVector(out, -d); from.y += .11;
        const top = physics!.surfaceBelow(from, .24, heldId!);
        if (!top) continue;
        const here = physics!.fit(heldId!, top, q, true);
        base = top;
        fit = here;
        if (here.ok) break;
      }
      if (fit && !fit.ok) fit = null;
      let level: number | null = null;
      if (!fit) for (const d of [.02, .05, .09, .14, .2, .28, .38]) {
        const under = physics!.surfaceBelow(_mV2.copy(local).addScaledVector(out, d), 1.3, heldId!);
        if (!under) continue;
        if (level !== null && under.y < level - .03) break;
        level ??= under.y;
        base = under;
        fit = physics!.fit(heldId!, under, q, false);
        if (fit.ok || d > reach) break;
      }
      if (!fit) { refuse('Mặt này nghiêng, vật sẽ trượt xuống.', 'Too steep: it would slide off.'); return; }
    }
    fit ??= physics!.fit(heldId!, base, q);
    let finalOk = fit.ok;
    let finalReason: { vi: string; en: string } | null = null;
    if (!fit.ok) {
      finalReason = fit.why === 'room' ? { vi: 'Vướng vật khác ở chỗ này.', en: 'Something else is in the way.' }
        : fit.why === 'edge' ? { vi: 'Sát mép quá, vật sẽ đổ.', en: 'Too close to the edge: it would tip over.' }
        : { vi: 'Không đủ mặt đỡ ở đây.', en: 'Not enough surface here to hold it.' };
    } else {
      const fitReach = this.checkPlacementReachable(fit.center);
      if (!fitReach.ok) {
        finalOk = false;
        finalReason = { vi: fitReach.vi, en: fitReach.en };
      }
    }
    this.placeSurface = { point: this.host.stage.localToWorld(base.clone()), normal: base === local ? normal : UP.clone() };
    this.placeAim = fit.center;
    this.placeOk = finalOk;
    this.placeReason = finalReason;
    this.placeKey = key;
    this.placeMemo = { center: fit.center.clone(), ok: finalOk, reason: finalReason, surface: this.placeSurface };
  }
  private placeShelf: string | null = null;
  private placeKey = '';
  private placeMemo: { center: T.Vector3; ok: boolean; reason: { vi: string; en: string } | null; surface: { point: T.Vector3; normal: T.Vector3 } | null } | null = null;
  /** Project the full box in the prop's horizontal axes. The same 20 cm
   * clearance applies at a corner and at a side, for both stance selection
   * and subsequent steps. Pitch and roll still enlarge the projection. */
  private placementFootprint(p: Placed, matrix: T.Matrix4) {
    const e = matrix.elements;
    const yaw = Math.hypot(e[8], e[10]) >= Math.hypot(e[0], e[2])
      ? Math.atan2(e[8], e[10]) : Math.atan2(-e[2], e[0]);
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const bounds = this.ownBox(p).clone().applyMatrix4(new T.Matrix4().makeRotationY(-yaw).multiply(matrix));
    return (at: T.Vector3) => {
      const x = cos * at.x - sin * at.z, z = sin * at.x + cos * at.z;
      const dx = Math.max(0, bounds.min.x - x, x - bounds.max.x);
      const dz = Math.max(0, bounds.min.z - z, z - bounds.max.z);
      return dx * dx + dz * dz < .20 ** 2;
    };
  }
  private setDown() {
    const physics = this.physics, side = physics && (physics.heldIn(1) ? 1 : physics.heldIn(-1) ? -1 : null);
    if (!physics || side == null) return;
    const heldId = physics.heldIn(side)!;
    const held = this.host.placed.get(heldId);
    if (held && toolOf(held.obj.kind)) {
      const targetPlaced = this.targetId ? this.host.placed.get(this.targetId) : null;
      if (targetPlaced && isRack(targetPlaced.obj.kind)) {
        this.hangBack(targetPlaced);
      } else {
        this.stowOrPlaceTool(side, heldId, held);
      }
      return;
    }
    if (!this.placeAim || !this.placeOk) return;
    const targetAim = this.placeAim.clone();
    const targetQuat = this.saucerRotation?.clone() ?? this.placeBodyQuat(heldId);
    const ch = this.host.character();
    if (ch?.body.seat) {
      const horizDist = Math.hypot(targetAim.x - ch.root.position.x, targetAim.z - ch.root.position.z);
      if (horizDist > SEATED_PLACE_REACH * this.k) {
        this.standThen(() => {
          const activeSide = this.physics && (this.physics.heldIn(1) ? 1 : this.physics.heldIn(-1) ? -1 : null);
          if (activeSide != null && this.physics?.heldIn(activeSide) === heldId) {
            this.placeHeldAt(activeSide, targetAim, targetQuat, { validatedSurface: true });
          }
        });
        return;
      }
    }
    this.placeHeldAt(side, targetAim, targetQuat, { validatedSurface: true });
  }
  private placeHeldAt(
    side: number,
    to: T.Vector3,
    q: T.Quaternion,
    options: { rack?: string; validatedSurface?: boolean } = {},
    quiet = false,
  ): boolean {
    const physics = this.physics;
    if (!physics?.heldIn(side)) return false;
    if (!this.carryTool(side)) { if (!quiet) this.host.say('Tay chưa giữ chắc dụng cụ.', 'Secure the tool first.'); return false; }
    this.setInspecting(false);
    let placement: Manipulator['placing'] = null;
    let bend = PLACEMENT_BEND;
    let footprint: ((at: T.Vector3) => boolean) | undefined;
    const go = () => {
      placement = this.startPlacement(side, to, q, options);
      if (placement) { placement.bend = bend; placement.footprint = footprint; }
    };
    const ch = this.host.character();
    if (ch && !ch.body.seat) {
      const id = physics.heldIn(side)!, p = this.host.placed.get(id)!, pose = physics.poseAt(id, to, q);
      if (!pose) return false;
      const matrix = new T.Matrix4().compose(pose.position, pose.quaternion, p.group.scale);
      const anchors = this.grasps.get(id), frames = anchors ? [...anchors.values()].map(a => matrix.clone().multiply(a.local)) : [];
      const wrists = frames.map(frame => new T.Vector3().setFromMatrixPosition(frame));
      const handDirection = frames.reduce((sum, frame) => sum.add(new T.Vector3(0, 1, 0).transformDirection(frame)), new T.Vector3()).setY(0);
      const rack = options.rack ? this.host.placed.get(options.rack) : null;
      let facing = rack
        ? rack.obj.rotY + Math.PI
        : handDirection.lengthSq() > .16
          ? Math.atan2(handDirection.x, handDirection.z)
          : Math.atan2(to.x - ch.root.position.x, to.z - ch.root.position.z);
      const hangingVessel = p.obj.kind === 'kettle.vintage' || p.obj.kind === 'can.watering';
      if (hangingVessel) facing = Math.atan2(to.x - ch.root.position.x, to.z - ch.root.position.z);
      const forward = new T.Vector3(Math.sin(facing), 0, Math.cos(facing));
      const center = wrists.length ? wrists.reduce((sum, v) => sum.add(v), new T.Vector3()).divideScalar(wrists.length) : to.clone();
      const right = new T.Vector3().crossVectors(forward, UP);
      const reaches = anchors ? [...anchors.keys()].map(s => ch.rig?.armReach(s)).filter((a): a is NonNullable<typeof a> => !!a) : [];
      const currentForward = ch.bodyForward(new T.Vector3()), currentRight = new T.Vector3().crossVectors(currentForward, UP);
      const rootWorld = ch.root.getWorldPosition(new T.Vector3());
      const shoulderSide = reaches.length ? reaches.reduce((sum, a) => sum + a.shoulder.clone().sub(rootWorld).dot(currentRight), 0) / reaches.length / this.k : 0;
      const armLength = reaches.length ? reaches.reduce((sum, a) => sum + a.length, 0) / reaches.length / this.k : .46;
      const baseY = ch.groundAt?.(to.x, to.z) ?? ch.root.position.y;
      const low = T.MathUtils.clamp((.45 - (center.y - baseY)) / .35, 0, 1);
      const stance = center.clone().addScaledVector(forward, -armLength * (.69 + low * (rack ? .65 : .12))).addScaledVector(right, -shoulderSide);
      stance.y = ch.groundAt?.(stance.x, stance.z) ?? baseY;
      const occupied = this.placementFootprint(p, matrix);
      footprint = occupied;
      for (let i = 0; i < 30 && occupied(stance); i++) stance.addScaledVector(forward, -.025);
      stance.y = ch.groundAt?.(stance.x, stance.z) ?? baseY;
      const nav = this.host.walkable?.() ?? this.host.navigation();
      const goals = anchors ? [...anchors].map(([s, anchor]) => {
        const hand = this.host.stage.matrixWorld.clone().multiply(matrix).multiply(anchor.local);
        return { side: s, wrist: new T.Vector3().setFromMatrixPosition(hand), fingers: new T.Vector3(0, 1, 0).transformDirection(hand) };
      }) : [];
      const heading = rack ? undefined : { yaw: facing };
      bend = { ...PLACEMENT_BEND, pitch: PLACEMENT_BEND.pitch + .17 * low };
      const here = ch.root.position;
      const alreadyInReach = hangingVessel && Math.hypot(center.x - here.x, center.z - here.z) <= armLength &&
        !occupied(here) && ch.rig?.reachStance(goals, here, facing,
        at => at.distanceToSquared(here) < 1e-12 && (!nav || nav.free(at)), bend.pitch);
      const solved = alreadyInReach || ch.rig?.reachStance(goals, stance, facing, at => (!nav || nav.free(at)) && !occupied(at), rack ? undefined : bend.pitch, heading);

      // Validated green-preview placement (`options.validatedSurface`): NEVER fail on `reachStance === null`
      // or walk sub-centimetre stalls; smoothly approach if beyond direct reach, turn toward `to`, and commit!
      if (options.validatedSurface && !options.rack) {
        if (heading && solved) facing = heading.yaw;
        else facing = Math.atan2(to.x - here.x, to.z - here.z);

        const horizDist = Math.hypot(to.x - here.x, to.z - here.z);
        let walkGoal: T.Vector3 | null = null;
        let walkStop = .08;
        if (solved) {
          if (Math.hypot(solved.x - here.x, solved.z - here.z) > .14) {
            walkGoal = solved.clone();
            walkStop = .09;
          }
        } else if (horizDist > DIRECT_PLACE_REACH * this.k) {
          walkGoal = this.findFallbackApproachStance(to, ch, occupied);
          walkStop = .22;
        }

        this.placeEyes = to.clone();
        let walkElapsed = 0;
        let turnElapsed = 0;
        const cancel = () => this.cancelPlacement();

        this.plan.run('place', [
          ...(walkGoal ? [{
            name: 'walk',
            tick: (dt: number) => {
              walkElapsed += dt;
              const r = this.host.exploration.walkToward(walkGoal!, walkStop, dt, true, false, facing);
              if (r === true) return true;
              // Spot was already green-validated at click time: never abort on furniture detour or approach timeout!
              if (r === null || walkElapsed > 1.8) return true;
              return r;
            },
            cancel,
          }] : []),
          {
            name: 'turn',
            tick: (dt: number) => {
              turnElapsed += dt;
              const aimFacing = Math.atan2(to.x - ch.root.position.x, to.z - ch.root.position.z);
              ch.turnBody(aimFacing, dt);
              const gap = Math.abs(Math.atan2(Math.sin(ch.root.rotation.y - aimFacing), Math.cos(ch.root.rotation.y - aimFacing)));
              return gap < .14 || turnElapsed >= .28;
            },
            cancel,
          },
          {
            name: 'set',
            start: () => {
              ch.rig?.play('reach', this.host.stage.localToWorld(to.clone()));
              go();
            },
            tick: () => placement?.result === 'placed' ? true : placement?.result === 'moving' ? false : null,
            cancel,
          },
        ], () => {
          this.cancelPlacement('failed');
          this.placeEyes = null;
        });
        return true;
      }

      if (goals.length && !solved) { if (!quiet) this.host.say('Không có chỗ đứng để đặt vật ở đó.', 'There is no reachable stance for that placement.'); return false; }
      if (heading) facing = heading.yaw;
      if (solved) stance.copy(solved);
      // The eyes stay on the ring while the legs take the thing there: the next click finds what was put down.
      this.placeEyes = to.clone();
      let turning = 0;
      const cancel = () => this.cancelPlacement();
      const staging = stance.clone().addScaledVector(forward, -armLength);
      const walkToStage = rack && ch.root.position.distanceTo(stance) > 2 * armLength && nav?.free(staging);
      const lift = rack && physics.rackDeparture(id, rack.obj.id);
      const entry = lift ? to.clone().add(lift) : null;
      const handLift = entry ? this.host.stage.localToWorld(entry.clone()).sub(this.host.stage.localToWorld(to.clone())) : null;
      const entryGoals = handLift ? goals.map(g => ({ ...g, wrist: g.wrist.clone().add(handLift) })) : [];
      let adjusted: T.Vector3 | null = null, seedIndex = 0;
      const offsets = [0, .12, -.12, .24, -.24];
      const adjustForGuide = (dt: number): boolean | null => {
        if (!entry || !ch.rig || !placement?.rackPath || placement.result !== 'moving') return null;
        if (adjusted) {
          const reached = this.host.exploration.walkToward(adjusted, .006, dt, true, true, facing);
          if (reached !== true) return reached;
          ch.turnBody(facing, dt);
          if (Math.abs(Math.atan2(Math.sin(ch.root.rotation.y - facing), Math.cos(ch.root.rotation.y - facing))) > .015) return false;
          adjusted = null;
        }
        const rotation = placement.rackPath.rotation;
        if (this.placementReachable(p, entry, rotation) && this.placementReachable(p, to, rotation)) return true;
        if (seedIndex >= offsets.length) return null;
        const herePos = ch.root.position.clone();
        const seed = herePos.clone().addScaledVector(right, offsets[seedIndex++]);
        const candidate = ch.rig.reachStance(entryGoals, seed, facing, at => at.distanceToSquared(herePos) < .45 ** 2 && (!nav || nav.free(at)) && !occupied(at));
        if (candidate && candidate.distanceToSquared(herePos) > .006 ** 2 &&
            ch.rig.reachStance(goals, candidate, facing, at => at.distanceToSquared(candidate) < 1e-12)) adjusted = candidate;
        return false;
      };
      const clearLift = hangingVessel && this.targetId && this.host.placed.get(this.targetId)?.obj.kind.startsWith('desk.')
        ? physics.vesselLiftPath(id, ch.root.position, to.y + .03) : null;
      const liftRotation = physics.groupRotationOf(id);
      let liftIndex = 0, liftRemaining = 4;
      this.plan.run('place', [
        ...(clearLift?.length && liftRotation ? [{ name: 'prepare', tick: (dt: number) => {
          if (physics.heldIn(side) !== id) { this.carryAt = null; return null; }
          const point = clearLift[liftIndex];
          if (physics.toolWaypointReached(id, point, liftRotation)) {
            liftIndex++; liftRemaining = 4;
            if (liftIndex === clearLift.length) { this.carryAt = null; return true; }
          }
          this.carryAt = { id, point: clearLift[liftIndex], rotation: liftRotation };
          liftRemaining -= dt;
          if (liftRemaining <= 0) { this.carryAt = null; return null; }
          return false;
        }, cancel: () => { this.carryAt = null; } }] : []),
        ...(walkToStage ? [{ name: 'walk', tick: (dt: number) => this.host.exploration.walkToward(staging, .04, dt, true, true), cancel }] : []),
        ...(options.rack ? [{ name: 'prepare', start: () => { go(); if (placement?.rackPath) placement.rackPath.approach = true; }, tick: (dt: number) => {
          if (placement?.result !== 'moving') return null;
          ch.turnBody(facing, dt);
          const gap = Math.abs(Math.atan2(Math.sin(ch.root.rotation.y - facing), Math.cos(ch.root.rotation.y - facing)));
          return !!placement.rackPath?.aligned && gap < .015;
        }, cancel }] : []),
        { name: 'walk', tick: dt => this.host.exploration.walkToward(stance, .006, dt, true, true, facing), cancel },
        { name: 'turn', tick: dt => { turning += dt; ch.turnBody(facing, dt); const gap = Math.abs(Math.atan2(Math.sin(ch.root.rotation.y - facing), Math.cos(ch.root.rotation.y - facing))); return gap < .015 ? true : turning > 5 ? null : false; }, cancel },
        ...(entry ? [{ name: 'stance', tick: adjustForGuide, cancel }] : []),
        { name: 'set', start: () => { if (placement?.rackPath) { placement.rackPath.approach = false; placement.left = 8; placement.rackPath.closest = Infinity; } else go(); }, tick: () => placement?.result === 'placed' ? true : placement?.result === 'moving' ? false : null, cancel },
      ], () => {
        const routeFailed = placement?.result === 'failed';
        this.cancelPlacement('failed'); this.placeEyes = null;
        if (!routeFailed) this.host.say('Không có chỗ đứng để đặt vật ở đó.', 'There is no clear stance for that placement.');
      });
    } else { go(); return !!placement; }
    return true;
  }
  private putAway() {
    const physics = this.physics, side = physics && (physics.heldIn(1) ? 1 : physics.heldIn(-1) ? -1 : null);
    if (!physics || side == null || !this.placeStore || !this.placeAim) return;
    this.setInspecting(false);
    this.startPlacement(side, this.placeAim, this.placeBodyQuat(), { store: this.placeStore });
    physics.bringToPlace(side);
  }
  /** A book of the library back on its shelf: the hand brings it there, and it is one of the spines again. */
  private putBack() {
    const physics = this.physics, side = physics && (physics.heldIn(1) ? 1 : physics.heldIn(-1) ? -1 : null);
    if (!physics || side == null || !this.placeShelf || !this.placeAim) return;
    this.setInspecting(false);
    this.startPlacement(side, this.placeAim, this.placeBodyQuat(), { gone: true });
    physics.bringToPlace(side);
  }
  /** Takes a real book from a shelf: the hand reaches for it where it stands, and what comes away is a book of the room with that book's face on it. */
  takeBook(shelfId: string, book: LibraryBook) {
    const shelf = this.host.placed.get(shelfId), physics = this.physics;
    if (!shelf || !physics) return;
    const side = physics.heldIn(1) ? -1 : physics.heldIn(-1) ? 1 : this.handFor(shelf.group.position);
    if (physics.heldIn(side)) { this.host.say('Hai tay đang bận.', 'Both hands are full.'); return; }
    const mesh = shelf.group.getObjectByName('library-spines');
    const spine = (mesh?.userData.spines as { book: LibraryBook; center: T.Vector3 }[] | undefined)?.find(s => s.book.key === book.key);
    const world = spine ? shelf.group.localToWorld(spine.center.clone()) : new T.Box3().setFromObject(shelf.group).getCenter(new T.Vector3());
    const take = () => {
      this.actions.start({
        side, reach: .48, release: .3,
        approach: undefined,
        contact: () => this.grip(world, side, 'pinch', 'push'),
        onContact: () => {
          contactSound('paper', .4, .45);
          const id = this.host.uid(), at = this.toStage(world);
          this.host.spawn({ id, kind: 'book.single', pos: [at.x, at.y - .012, at.z], rotY: shelf.obj.rotY, scale: 1, color: book.color, state: { book: { ...book.ref, title: book.title, author: book.author, color: book.color } as never } });
          this.pendingLift = { id, side };
        },
      });
    };
    const a = this.approachFor(this.toStage(world), .55, take);
    if (a) this.plan.run('take', [{ name: 'walk', tick: dt => this.host.exploration.walkToward(a.point, a.stop, dt) ?? true }, { name: 'take', start: take, tick: () => !this.actions.busy }]);
  }
  /** Into the drawer: it now moves with the drawer, and comes back out with it. */
  private finishStore(side: number, store: { host: string; slot: number }) {
    const physics = this.physics, id = physics?.heldIn(side), p = id ? this.host.placed.get(id) : null, host = this.host.placed.get(store.host);
    const slider = (host?.group.userData.sliders as Slider[] | undefined)?.[store.slot];
    if (!physics || !p || !slider) return false;
    physics.forget(id!);
    this.releaseHeldContacts(side, id, .20);
    slider.node.attach(p.group);
    p.group.scale.setScalar(p.obj.scale);
    const q = p.group.quaternion;
    p.group.position.y = Math.max(p.group.position.y, 0);
    const pos: [number, number, number] = [p.group.position.x, p.group.position.y, p.group.position.z];
    this.host.objectState(id!, { inside: store, pos, rotY: 2 * Math.atan2(q.y, q.w), quat: undefined }, 'store');
    contactSound(affordanceOf(p.obj.kind).material, .35, .5);
    return true;
  }
  private takeOutOfDrawer(p: Placed) {
    this.host.stage.attach(p.group);
    p.group.scale.setScalar(p.obj.scale);
    this.host.objectState(p.obj.id, { inside: undefined, pos: [p.group.position.x, p.group.position.y, p.group.position.z] }, 'store');
  }

  /**
   * Cleanly stows or rests a held cleaning tool (`tool.broom`, `tool.mop`, `tool.webbrush`, `tool.duster`, `tool.dustpan`, `tool.cloth`)
   * on a nearby wall lean or floor spot with zero floating and zero mid-air drop bounce, releasing both hands to neutral.
   */
  private stowOrPlaceTool(side: number, id: string, p: Placed): void {
    const physics = this.physics;
    const ch = this.host.character();
    const spec = toolOf(p.obj.kind);
    if (!physics) return;
    if (!ch?.ready || !spec) {
      physics.release(side, undefined, true);
      this.releaseHeldContacts(side, id, .20);
      return;
    }

    const chPos = ch.root.position;
    const targetPlaced = this.targetId ? this.host.placed.get(this.targetId) : null;
    if (
      targetPlaced &&
      isRack(targetPlaced.obj.kind) &&
      Math.hypot(targetPlaced.group.position.x - chPos.x, targetPlaced.group.position.z - chPos.z) <= 1.75
    ) {
      const heldYaw = new T.Euler().setFromQuaternion(p.group.quaternion, 'YXZ').y;
      const spot = onRack(targetPlaced.obj, p.obj.kind, heldYaw);
      if (spot) {
        const spotQ = spot.quat ? new T.Quaternion(...spot.quat) : new T.Quaternion().setFromAxisAngle(UP, spot.rotY);
        physics.forget(id);
        p.group.position.set(spot.pos[0], spot.pos[1], spot.pos[2]);
        p.group.quaternion.copy(spotQ);
        p.group.scale.setScalar(p.obj.scale);
        p.group.updateWorldMatrix(true, true);
        p.obj.pos = [spot.pos[0], spot.pos[1], spot.pos[2]];
        p.obj.rotY = spot.rotY;
        p.obj.quat = spot.quat ? [...spot.quat] : undefined;
        if (p.blob) p.blob.visible = !spot.quat;
        this.host.objectState(
          id,
          { pos: [spot.pos[0], spot.pos[1], spot.pos[2]], rotY: spot.rotY, quat: spot.quat ? [...spot.quat] : undefined },
          `drop-${id}-${++this.dropCount}`,
        );
        this.carried.delete(id);
        this.releaseHeldContacts(side, id, .20);
        this.syncRoom();
        this.host.navigationChanged?.();
        contactSound(affordanceOf(p.obj.kind).material, .28, .45);
        return;
      }
    }

    const face = ch.bodyForward(_mV1).setY(0);
    if (face.lengthSq() < 1e-6) face.set(0, 0, 1);
    else face.normalize();
    const right = _mV2.crossVectors(face, UP).normalize();
    const floorY = ch.groundAt?.(chPos.x, chPos.z) ?? chPos.y;
    const layout = this.host.layout();
    const inStudy = Boolean(layout && !this.host.lifeRoots?.().length);
    const half = ((layout?.room.size ?? 6) * .5) - .14;

    if (spec.length > .9) {
      // Check if facing a wall/solid support within 1.32 m to lean the shaft stably against it; otherwise lay flat on floor.
      _mV3.set(chPos.x, floorY + .55, chPos.z);
      _mV4.copy(_mV3).addScaledVector(face, 1.32);
      const wallDist = physics.clearFloorLine?.(_mV3, _mV4) ?? null;

      let px: number;
      let py: number;
      let pz: number;
      let yaw: number;
      const finalQuat = new T.Quaternion();

      if (wallDist !== null && wallDist >= .34 && wallDist < 1.30) {
        const standDist = Math.max(.26, wallDist - .22);
        px = chPos.x + face.x * standDist;
        pz = chPos.z + face.z * standDist;
        if (inStudy) {
          px = T.MathUtils.clamp(px, -half, half);
          pz = T.MathUtils.clamp(pz, -half, half);
        }
        py = (ch.groundAt?.(px, pz) ?? floorY) + .002;
        yaw = Math.atan2(face.x, face.z);
        finalQuat.setFromAxisAngle(UP, yaw).multiply(_mQ1.setFromAxisAngle(X_AXIS, .16)).normalize();
      } else {
        px = chPos.x + face.x * .46;
        pz = chPos.z + face.z * .46;
        if (inStudy) {
          px = T.MathUtils.clamp(px, -half, half);
          pz = T.MathUtils.clamp(pz, -half, half);
        }
        const fAt = ch.groundAt?.(px, pz) ?? floorY;
        yaw = Math.atan2(right.x, right.z);
        finalQuat.setFromAxisAngle(UP, yaw).multiply(_mQ1.setFromAxisAngle(Z_AXIS, Math.PI / 2)).normalize();
        const own = this.ownBox(p);
        _mM1.compose(_mV5.set(0, 0, 0), finalQuat, _mV6.setScalar(p.obj.scale));
        const lowY = own.isEmpty() ? -.024 : _mBox1.copy(own).applyMatrix4(_mM1).min.y;
        py = fAt - lowY + .002;
      }

      physics.forget(id);
      p.group.position.set(px, py, pz);
      p.group.quaternion.copy(finalQuat);
      p.group.scale.setScalar(p.obj.scale);
      p.group.updateWorldMatrix(true, true);
      p.obj.pos = [px, py, pz];
      p.obj.rotY = yaw;
      p.obj.quat = [finalQuat.x, finalQuat.y, finalQuat.z, finalQuat.w];
      if (p.blob) p.blob.visible = false;
      this.host.objectState(
        id,
        { pos: [px, py, pz], rotY: yaw, quat: [finalQuat.x, finalQuat.y, finalQuat.z, finalQuat.w] },
        `drop-${id}-${++this.dropCount}`,
      );
      this.carried.delete(id);
      this.releaseHeldContacts(side, id, .20);
      this.syncRoom();
      this.host.navigationChanged?.();
      contactSound(affordanceOf(p.obj.kind).material, .28, .45);
      return;
    }

    // Short 1-hand cleaning tools (`tool.duster`, `tool.dustpan`, `tool.cloth`): place upright on nearby surface or floor.
    let px = chPos.x + face.x * .44;
    let pz = chPos.z + face.z * .44;
    if (inStudy) {
      px = T.MathUtils.clamp(px, -half, half);
      pz = T.MathUtils.clamp(pz, -half, half);
    }
    const surf = physics.surfaceBelow?.(_mV3.set(px, chPos.y + 1.05, pz), 1.25, id) ?? null;
    const py = surf ? surf.y : (ch.groundAt?.(px, pz) ?? floorY);
    const yaw = Math.atan2(face.x, face.z);
    const uprightQ = new T.Quaternion().setFromAxisAngle(UP, yaw);
    physics.forget(id);
    p.group.position.set(px, py, pz);
    p.group.quaternion.copy(uprightQ);
    p.group.scale.setScalar(p.obj.scale);
    p.group.updateWorldMatrix(true, true);
    p.obj.pos = [px, py, pz];
    p.obj.rotY = yaw;
    p.obj.quat = undefined;
    if (p.blob) p.blob.visible = true;
    this.host.objectState(id, { pos: [px, py, pz], rotY: yaw, quat: undefined }, `drop-${id}-${++this.dropCount}`);
    this.carried.delete(id);
    this.releaseHeldContacts(side, id, .20);
    this.syncRoom();
    this.host.navigationChanged?.();
    contactSound(affordanceOf(p.obj.kind).material, .25, .45);
  }

  private letGoNow() {
    const physics = this.physics;
    if (!physics) return;
    this.setInspecting(false);
    this.hugging = false;
    this.work.end();
    this.carryAt = null;
    if (this.pouring) this.stopPour();
    this.plan.cancel();
    this.cancelPlacement();
    for (const side of [1, -1]) {
      const id = physics.heldIn(side);
      if (!id) continue;
      const p = this.host.placed.get(id);
      if (p && toolOf(p.obj.kind)) {
        this.stowOrPlaceTool(side, id, p);
        break;
      }
      physics.release(side, undefined, true);
      this.releaseHeldContacts(side, id, .20);
      break;
    }
  }
  private throwHeld(charge: number) {
    const physics = this.physics;
    if (!physics) return;
    this.setInspecting(false);
    this.hugging = false;
    this.work.end();
    for (const side of [1, -1]) {
      const id = physics.heldIn(side);
      if (!id) continue;
      const p = this.host.placed.get(id), mass = p ? affordanceOf(p.obj.kind).mass : 1;
      const dir = this.host.exploration.camera.getWorldDirection(new T.Vector3());
      const speed = (1.8 + 4.6 * charge) / Math.max(1, Math.sqrt(mass));
      physics.release(side, dir.multiplyScalar(speed).add(new T.Vector3(0, 1.1, 0)));
      this.releaseHeldContacts(side, id, .20);
      this.host.character()?.rig?.play('reach', null);
      break;
    }
  }

  private inspect(p: Placed | null | undefined) {
    if (this.work.active) return;
    if (this.carrying) { this.setInspecting(!this.inspecting); return; }
    if (p && StudyPhysics.canPick(p.obj)) this.lift(p, () => this.setInspecting(true));
    else this.host.exploration.command('inspect');
  }
  /** Brought up to the eyes it faces them. A book opens in the hand. */
  private setInspecting(on: boolean) {
    const wasInspecting = this.inspecting;
    const wasBook = Boolean(this.book);
    this.inspecting = on;
    this.closeBook();
    this.host.exploration.setReading(false);
    const physics = this.physics, side = physics ? (physics.heldIn(1) ? 1 : physics.heldIn(-1) ? -1 : null) : null;
    const id = side != null ? physics!.heldIn(side) : null, held = id ? this.host.placed.get(id) : null;
    if (!physics || side == null) return;
    if (!on || !held) {
      if (wasInspecting && !wasBook && held && !toolOf(held.obj.kind)) {
        // Preserve the exact 3D orientation dialed in during Inspect Mode into carry & placement preview!
        this.applyHeldGroupQuaternion(held.group.quaternion, true);
        physics.holdGroupRotation(side, this.placeGroupQuat);
      } else {
        physics.holdRotation(side, null);
      }
      return;
    }
    void this.host.exploration.camera;
    if (affordanceOf(held.obj.kind).family === 'book' || held.obj.kind === 'docs.stack') {
      const size = new T.Box3().setFromObject(held.group).getSize(new T.Vector3());
      // Open it reads like a paperback, whatever the closed model's size in the hand.
      const book = new OpenBook(.168, .232, Math.min(.018, Math.max(.008, size.y * .3)), held.obj.color ?? '#5d76c9');
      book.group.position.y = size.y * .5;
      book.group.scale.setScalar(1 / held.obj.scale);
      held.group.children.forEach(c => { c.userData.hiddenForBook = c.visible; c.visible = false; });
      held.group.add(book.group);
      this.book = { open: book, host: held.group, side, title: held.obj.state?.book?.title ?? (CATALOG_BY_ID[held.obj.kind]?.name ?? '') };
      book.onMoved = () => this.host.changed();
      this.host.exploration.setReading(true);
      // Reading is for the pointer: words are picked with it. The eyes stay on the book until it is closed.
      this.host.exploration.pointerForReading(true);
      contactSound('paper', .4, .35);
      this.loadBook(book, held.obj);
    } else {
      this.placeGroupQuat.copy(held.group.quaternion).normalize();
      this.placeYaw = extractPreservedYaw(this.placeGroupQuat);
      physics.holdGroupRotation(side, held.group.quaternion.clone());
    }
  }
  private loadBook(book: OpenBook, obj: SpaceObject) {
    void this.host.bookSession?.(obj).then(session => {
      if (this.book?.open !== book) { session?.close(); return; }
      if (!session) { this.host.say('Cuốn này chưa có nội dung. Lấy một cuốn từ kệ sách để đọc.', 'Nothing in this one yet. Take a book from the shelf to read.'); return; }
      this.book.title = session.title || this.book.title;
      // A book with no chosen content that was given a reading keeps it for next time.
      if (session.ref?.source === 'reading' && !obj.state?.book && obj.state?.material !== session.ref.id) this.host.objectState(obj.id, { state: { ...this.host.placed.get(obj.id)?.obj.state, material: session.ref.id } }, `book-${obj.id}`);
      void book.open(session).then(() => this.host.changed());
    }).catch(() => { if (this.book?.open === book) this.host.say('Chưa mở được cuốn này.', 'Could not open this book.'); });
  }
  private closeBook() {
    if (!this.book) return;
    this.book.open.dispose();
    this.book.host.children.forEach(c => { if (c.userData.hiddenForBook !== undefined) { c.visible = c.userData.hiddenForBook; delete c.userData.hiddenForBook; } });
    this.book = null;
    this.host.exploration.pointerForReading(false);
  }
  private turnBook(dir: number) {
    if (!this.book) return;
    if (this.book.open.turnPage(dir)) contactSound('paper', .5, .35);
    else if (dir > 0) this.host.say('Đã đến trang cuối.', 'That is the last page.');
  }
  // ── The tools around an open book ──
  bookNext() { this.turnBook(1); }
  bookPrev() { this.turnBook(-1); }
  closeReading() { if (this.book) this.setInspecting(false); }
  async bookBilingual(on: boolean) { await this.book?.open.setBilingual(on); this.host.changed(); }
  async bookMark() { const on = await this.book?.open.toggleBookmark(); this.host.changed(); return on; }
  async bookHighlight(word: PickedWord) { const ok = await this.book?.open.highlight(word); this.host.changed(); return ok; }
  /** A click on the open book: the outer edge of a page turns it, a word is that word. */
  bookClick(ndc: { x: number; y: number }): PickedWord | 'turned' | null {
    if (!this.book) return null;
    const ray = new T.Raycaster(); ray.setFromCamera(new T.Vector2(ndc.x, ndc.y), this.host.exploration.camera);
    const edge = this.book.open.edgeAt(ray);
    if (edge) { this.turnBook(edge); return 'turned'; }
    return this.book.open.pick(ray);
  }
  /** The normal reader moved the position: the book in the hand follows it. */
  reloadBook() {
    if (!this.book) return;
    const id = this.book.host.userData.objectId as string, p = this.host.placed.get(id), width = .168, height = .232;
    if (!p) return;
    const old = this.book.open, parent = old.group.parent, thickness = .012, next = new OpenBook(width, height, thickness, p.obj.color ?? '#5d76c9');
    next.group.position.copy(old.group.position); next.group.scale.copy(old.group.scale);
    old.dispose();
    parent?.add(next.group);
    next.onMoved = () => this.host.changed();
    this.book.open = next;
    this.loadBook(next, p.obj);
  }

  /** How many sips are in it. */
  private sipsOf(o: SpaceObject) { return vesselOf(o.kind) ? levelOf(o.kind, o.state) * 4 : 4; }
  private drink() {
    const physics = this.physics, side = physics ? (physics.heldIn(1) ? 1 : physics.heldIn(-1) ? -1 : null) : null;
    if (!physics || side == null) return;
    const id = physics.heldIn(side)!, p = this.host.placed.get(id);
    if (!p) return;
    this.drinking = { side, t: 0 };
    // The cup tips towards the face about the line across the eyes, its handle staying on the side of the hand that has it.
    const look = this.host.exploration.lookFlat(new T.Vector3()), across = new T.Vector3().crossVectors(look, UP).normalize();
    const stood = physics.startOf(id);
    const turned = new T.Quaternion().setFromAxisAngle(UP, this.host.exploration.lookYaw + this.carryYaw + (stood ? 2 * Math.atan2(stood.y, stood.w) : 0));
    physics.holdGroupRotation(side, new T.Quaternion().setFromAxisAngle(across, .92).multiply(turned));
    contactSound('ceramic', .2, .4);
  }
  /** Open in the hand it stays square to the eyes, top edge up: pages are for reading. */
  private holdBookToEyes(side: number) {
    const physics = this.physics, ex = this.host.exploration, id = physics?.heldIn(side);
    if (!physics || !id) return;
    const tilt = new T.Quaternion().setFromAxisAngle(new T.Vector3(1, 0, 0), Math.PI / 2 + ex.lookPitch * .96);
    physics.holdGroupRotation(side, new T.Quaternion().setFromAxisAngle(UP, ex.lookYaw).multiply(tilt));
  }
  private refill() {
    const physics = this.physics, id = physics?.holding, p = id ? this.host.placed.get(id) : null;
    if (!p) return;
    this.host.objectState(p.obj.id, { state: { ...p.obj.state, sips: 4 } }, 'mug');
    contactSound('ceramic', .25, .4);
  }
  private useLamp(p: Placed) {
    if (p.obj.state?.burnt) { contactSound('plastic', .3, .4); this.host.say('Bóng đèn đã cháy: bật không sáng nữa.', 'The bulb has gone: it does not light.'); return; }
    const box = new T.Box3().setFromObject(p.group), at = box.getCenter(new T.Vector3());
    const tall = (box.max.y - box.min.y) / this.k > .9;
    at.y = tall ? box.min.y + (box.max.y - box.min.y) * .58 : box.min.y + (box.max.y - box.min.y) * .42;
    this.touch(() => this.toStage(at), () => at, 'push', 'pinch', tall ? .62 : .56, () => this.host.activate(p.obj.id), 'plastic');
  }
  // ── A computer, for real ────────────────────────────────────────────────────────────────────────────
  /** The desk this thing stands on, if any. */
  private deskUnder(p: Placed) {
    for (const q of this.host.placed.values()) {
      if (q.obj.hidden || !q.obj.kind.startsWith('desk.')) continue;
      const size = CATALOG_BY_ID[q.obj.kind].size, inv = new T.Matrix4().compose(q.group.position, q.group.quaternion, new T.Vector3(1, 1, 1)).invert();
      const at = p.group.position.clone().applyMatrix4(inv);
      if (Math.abs(at.x) < size[0] * q.obj.scale / 2 + .05 && Math.abs(at.z) < size[1] * q.obj.scale / 2 + .05 && at.y > .3) return q;
    }
    return null;
  }
  /**
   * Using a computer is a chain a body really does: to the chair if the desk has one, the lid up if it is shut, the eyes to the screen. The screen
   * then belongs to the player until they leave it, and the body is still sitting there when they do. A movement key on the way cancels the chain.
   */
  private useDevice(p: Placed) {
    const ex = this.host.exploration, ch = this.host.character(), layout = this.host.layout();
    if (!ch?.ready || !layout) return;
    if (p.obj.action && p.obj.action !== 'none' && !p.obj.action.startsWith('route:') && !p.obj.action.startsWith('open:')) {
      this.useTool(p);
      return;
    }
    if (this.carrying) { this.host.say('Đặt vật đang cầm xuống đã.', 'Put down what you are holding first.'); return; }
    let controls = p;
    if (p.obj.kind === 'monitor') {
      const st = stationOf(layout.objects, p.obj);
      if (!st.ready) { this.needParts(st, p); return; }
      controls = this.host.placed.get(st.parts.keyboard!.id) ?? p;
    }
    if (ch.body.seat) {
      const box = this.ownBox(controls);
      const shoulder = ch.rig?.armReach(this.handFor(controls.group.getWorldPosition(new T.Vector3())))?.shoulder;
      if (!shoulder || !this.seatedReach(controls.group.localToWorld(box.clampPoint(controls.group.worldToLocal(shoulder), new T.Vector3())))) {
        this.outOfSeatedReach();
        return;
      }
    }
    const desk = this.deskUnder(p), lidShut = () => p.obj.kind === 'laptop' && (this.host.placed.get(p.obj.id)?.obj.state?.lid ?? 1) < .5;
    const steps: { name: string; start?: () => void; tick?: (dt: number) => boolean | null; cancel?: () => void }[] = [];
    let refused = false;
    if (desk && !ch.body.seat) {
      steps.push({ name: 'seat', start: () => { refused = !this.host.use(desk.obj.id, 'study'); }, tick: () => refused ? null : (ch.body.state === 'seated' && !ch.furnitureInHand()) || (ch.standing && !ch.body.seat && ch.body.state === 'standing') });
    } else if (!desk && !ch.body.seat) {
      const to = this.toStage(new T.Box3().setFromObject(p.group).getCenter(new T.Vector3()));
      steps.push({ name: 'walk', tick: dt => ex.walkToward(to, .62, dt, true) ?? true });
    }
    if (lidShut()) steps.push({ name: 'lid', start: () => { if (lidShut()) this.toggleState(p, 'lid', 'plastic'); }, tick: () => this.actions.busy ? false : lidShut() ? null : true });
    steps.push({
      name: 'look',
      start: () => {
        const mesh = p.group.userData.screenMesh as T.Mesh | undefined, size = p.group.userData.screenSize as [number, number] | undefined;
        if (!mesh || !size) return;
        mesh.updateWorldMatrix(true, false);
        const m = mesh.matrixWorld, right = new T.Vector3().setFromMatrixColumn(m, 0), up = new T.Vector3().setFromMatrixColumn(m, 1), normal = new T.Vector3().setFromMatrixColumn(m, 2).normalize();
        const center = new T.Vector3().setFromMatrixPosition(m), w = size[0] * right.length(), h = size[1] * up.length();
        ex.enterDevice(center, right.normalize(), up.normalize(), normal, w, h);
        this.deviceId = p.obj.id;
        contactSound('plastic', .2, .4);
      },
      tick: () => this.deviceId === p.obj.id ? ex.deviceLevel >= .999 : null,
      cancel: () => { ex.leaveDevice(); this.deviceId = null; },
    });
    steps.push({ name: 'open', start: () => { chime('boot'); this.host.deviceOpen?.(p.obj.id); this.host.changed(); }, tick: () => true });
    this.plan.run('device', steps, () => { this.host.say('Không có lối tới chỗ ngồi ở bàn này.', 'There is no way to the seat at this desk.'); });
    this.host.wake();
  }
  /** Back from the screen: the eyes return to where the body is. Nothing else about the body changed. */
  leaveDevice() { this.host.exploration.leaveDevice(); this.deviceId = null; this.host.changed(); this.host.wake(); }
  private deviceId: string | null = null;
  /** A monitor with parts missing cannot be used yet: says which, and sets out the ones the room does not have, to be carried and put in place by hand. */
  private needParts(st: Station, p: Placed) {
    const vi = this.vi;
    const names = st.missing.map(part => (vi ? PART_NAME[part].vi : PART_NAME[part].en).toLowerCase()).join(', ');
    this.host.say(`Máy chưa đủ: thiếu ${names}.`, `This computer still needs: ${names}.`);
    this.board(st, p.group.position, 3);
    const l = this.host.layout(), ch = this.host.character();
    if (!l || !ch) return;
    const KIND = { tower: 'pc.tower', keyboard: 'keyboard', mouse: 'mouse.pc', monitor: 'monitor' } as const;
    const exists = (kind: string) => l.objects.some(o => o.kind === kind && !o.hidden);
    const out = st.missing.filter(part => !exists(KIND[part]));
    if (!out.length) return;
    // On the floor by the desk, where a hand can reach them: nothing is installed for the player.
    const nav = this.host.navigation(), face = ch.bodyForward(new T.Vector3()), taken: { x: number; z: number }[] = [];
    const half = l.room.size / 2 - .3, base = Math.atan2(face.x, face.z);
    out.forEach(part => {
      // The nearest free floor in front of the body, clear of the furniture and of each other.
      for (const r of [.55, .75, .95, 1.2, 1.5]) {
        let done = false;
        for (let i = 0; i < 12 && !done; i++) {
          const a = base + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * Math.PI / 6, x = ch.root.position.x + Math.sin(a) * r, z = ch.root.position.z + Math.cos(a) * r;
          if (Math.abs(x) > half || Math.abs(z) > half || (nav && !nav.free({ x, z })) || taken.some(t => Math.hypot(t.x - x, t.z - z) < .5)) continue;
          taken.push({ x, z }); done = true;
          this.host.spawn({ id: this.host.uid(), kind: KIND[part], pos: [x, .002, z], rotY: ch.root.rotation.y + Math.PI, scale: 1 });
        }
        if (done) break;
      }
    });
    this.host.say(`Đã để sẵn ${out.length} linh kiện cạnh bạn: cầm từng món đặt lên bàn.`, `${out.length} parts are by your feet: carry each one to the desk.`);
  }
  // The checklist over a computer being put together.
  private stationBoard: StationBoard | null = null;
  private stationNow: Station | null = null;
  private stationHold = 0;
  private lastReady = new Set<string>();
  private readyMonitors = new Set<string>();
  private board(st: Station, at: T.Vector3, seconds = 0) {
    this.stationBoard ??= new StationBoard();
    if (this.stationBoard.group.parent !== this.host.stage) this.host.stage.add(this.stationBoard.group);
    this.stationBoard.show(st, at, this.vi);
    this.stationNow = st;
    this.stationHold = Math.max(this.stationHold, seconds);
  }
  /** What the monitors in the room have to work with, every time something in the room came to rest. */
  private judgeStations() {
    const l = this.host.layout();
    if (!l) return;
    const ready = new Set<string>();
    for (const o of l.objects) if (o.kind === 'monitor' && !o.hidden && stationOf(l.objects, o).ready) ready.add(o.id);
    for (const id of ready) if (!this.readyMonitors.has(id) && this.judged) {
      const p = this.host.placed.get(id);
      if (p) { this.board(stationOf(l.objects, p.obj), p.group.position, 2.6); chime('ready'); this.host.say('Máy đã lắp xong: bấm vào màn hình để dùng.', 'The computer is ready: click the screen to use it.'); }
    }
    this.readyMonitors = ready;
    this.judged = true;
  }
  private judged = false;
  private updateStationBoard(dt: number) {
    if (this.frameCount % 12) { this.stationBoard?.update(dt, this.host.reduced()); return; }
    const l = this.host.layout(), heldId = this.physics?.heldIds[0], held = heldId ? this.host.placed.get(heldId) : null;
    const under = this.targetId ? this.host.placed.get(this.targetId) : null;
    this.stationHold = Math.max(0, this.stationHold - dt * 12);
    const about = held && partOf(held.obj.kind) ? held : under && partOf(under.obj.kind) ? under : null;
    if (l && about && !this.host.exploration.deviceLevel) {
      // What is in the hands is not connected to anything yet.
      const st = stationNear(l.objects.filter(o => o.id !== heldId), about.obj);
      const monitor = st.monitor ? this.host.placed.get(st.monitor.id) : null;
      if (!st.ready) { this.board(st, (monitor ?? about).group.position); this.stationBoard?.update(dt, this.host.reduced()); return; }
    }
    if (this.stationHold <= 0) { this.stationBoard?.hide(); this.stationNow = null; }
    this.stationBoard?.update(dt, this.host.reduced());
  }
  private useTool(p: Placed) {
    const at = new T.Box3().setFromObject(p.group).getCenter(new T.Vector3());
    this.touch(() => this.toStage(at), () => at, 'push', 'press', .6, () => this.host.activate(p.obj.id), 'plastic');
  }
  private toggleState(p: Placed, key: 'lid' | 'on', material: Parameters<typeof contactSound>[0]) {
    const box = new T.Box3().setFromObject(p.group), at = box.getCenter(new T.Vector3());
    this.touch(() => this.toStage(at), () => at, 'push', key === 'lid' ? 'pinch' : 'press', .58, () => {
      const state: ObjectState = { ...p.obj.state };
      if (key === 'lid') state.lid = (state.lid ?? 1) > .5 ? 0 : 1;
      else state.on = state.on === false;
      this.host.objectState(p.obj.id, { state }, key);
    }, material);
  }
  private spin(p: Placed) {
    const at = new T.Box3().setFromObject(p.group).getCenter(new T.Vector3());
    this.touch(() => this.toStage(at), () => at, 'push', 'open', .56, () => { this.spins.set(p.obj.id, (this.spins.get(p.obj.id) ?? 0) + 5.5); }, 'plastic');
  }
  private flip(p: Placed | null | undefined) {
    const held = this.physics?.holding ? this.host.placed.get(this.physics.holding) : null, target = held && affordanceOf(held.obj.kind).verbs.includes('flip') ? held : p;
    if (!target) return;
    const apply = () => this.host.objectState(target.obj.id, { state: { ...target.obj.state, flip: (target.obj.state?.flip ?? 0) + 1, flipAt: Date.now() } }, 'flip');
    if (target === held) { apply(); return; }
    const at = new T.Box3().setFromObject(target.group).getCenter(new T.Vector3());
    this.touch(() => this.toStage(at), () => at, 'push', 'cylinder', .56, apply, 'glass');
  }
  private straighten(p: Placed) {
    const at = new T.Box3().setFromObject(p.group).getCenter(new T.Vector3());
    this.touch(() => this.toStage(at), () => at, 'push', 'open', .6, () => {
      const now = p.obj.state?.tilt ?? 0;
      this.host.objectState(p.obj.id, { state: { ...p.obj.state, tilt: Math.abs(now) > .01 ? 0 : (Math.random() < .5 ? -.07 : .07) } }, 'tilt');
    }, affordanceOf(p.obj.kind).material);
  }
  private stroke(p: Placed) {
    const box = new T.Box3().setFromObject(p.group), at = box.getCenter(new T.Vector3());
    at.y = box.min.y + (box.max.y - box.min.y) * .7;
    this.touch(() => this.toStage(at), () => at, 'push', 'open', .56, () => this.wobbles.set(p.obj.id, 1), 'cloth');
  }
  private lookThrough(p: Placed) {
    const at = new T.Box3().setFromObject(p.group).getCenter(new T.Vector3());
    this.touch(() => this.toStage(at), () => at, 'push', 'cylinder', .62, () => this.host.exploration.toggleZoom(), 'metal');
  }
  private hug(p: Placed | null | undefined) {
    if (this.carrying) { this.hugging = !this.hugging; return; }
    if (p) this.lift(p, () => { this.hugging = true; });
  }
  private wear(p: Placed | null | undefined) {
    const held = this.physics?.holding ? this.host.placed.get(this.physics.holding) : null, target = held ?? p;
    if (!target || target.obj.kind !== 'headphones') return;
    if (this.host.wearing('headphones')) { this.host.wear('headphones', false); return; }
    const put = () => {
      const physics = this.physics, side = physics?.sideOf(target.obj.id) ?? null;
      if (physics && side != null) {
        physics.forget(target.obj.id);
        this.releaseHeldContacts(side, target.obj.id, .20);
      }
      this.host.wear('headphones', true);
      this.host.objectState(target.obj.id, { hidden: true }, 'wear');
    };
    if (held) put(); else this.lift(target, put);
  }

  private sit(p: Placed, lie: boolean) {
    const kind = p.obj.kind;
    if (!kind.startsWith('desk.')) {
      const check = this.validatePlacedSeat(p, this.hitWorld);
      if (!check.valid) {
        if (check.tipped) {
          this.host.say('Ghế đang bị đổ. Hãy dựng thẳng ghế trước khi ngồi.', 'This seat has tipped over. Stand it upright first.');
        } else if (check.reason === 'moving') {
          this.host.say('Ghế đang chuyển động. Hãy đợi ghế dừng hẳn.', 'Wait for the seat to come to rest first.');
        } else if (check.reason === 'unsupported') {
          this.host.say('Ghế chưa đặt vững trên sàn.', 'Place the seat flat on the floor before sitting.');
        } else if (check.reason === 'obstructed') {
          this.host.say('Mặt ghế đang vướng đồ đạc khác.', 'Clear the seat cushion before sitting down.');
        } else {
          this.host.say('Không có lối tới chỗ ngồi này.', 'There is no clear approach to this seat.');
        }
        return;
      }
    } else {
      const pairedChairs = [...this.host.placed.values()].filter(
        q => !q.obj.hidden && q.obj.kind.startsWith('chair.') && q.group.position.distanceTo(p.group.position) < 1.4,
      );
      if (pairedChairs.length > 0 && !pairedChairs.some(q => this.validatePlacedSeat(q).valid)) {
        const tippedChair = pairedChairs.find(q => !isSpaceObjectUpright(q.obj, q.group, MIN_SEAT_UPRIGHT_DOT));
        if (tippedChair) {
          this.host.say('Ghế ở bàn đang bị đổ. Hãy dựng thẳng ghế trước.', 'The desk chair has tipped over. Stand it upright first.');
          return;
        }
      }
    }
    const activity: Activity = lie ? 'sleep' : kind.startsWith('desk.') || kind.startsWith('chair.') ? 'study' : kind === 'armchair' || kind === 'sofa' || kind === 'beanbag' || kind === 'pouf' ? 'relax' : kind.startsWith('bed.') ? 'relax' : 'idle';
    if (!this.host.use(p.obj.id, activity, this.hitWorld)) this.host.say('Không có lối tới chỗ này.', 'There is no way to get there.');
  }

  // ── Cleaning: what the tools do to the things that go with them ─────────────────────────────────────
  /** Walks to within an arm of a thing if it is further off, then does `then`. */
  /** Walks to within `stop` of it. With `near`, closer than that is too close: a long watering can held over a plant puts its handle behind the body, so the body steps back to `stop`. */
  private goTo(p: Placed, stop: number, then: () => void, near = 0) {
    const ch = this.host.character();
    if (!ch) return;
    const at = p.group.position.clone(), dx = ch.root.position.x - at.x, dz = ch.root.position.z - at.z, d = Math.hypot(dx, dz);
    if (near && d < near) {
      // The free place at the right distance nearest to where the body already is: usually a step straight back.
      const nav = this.host.walkable?.() ?? this.host.navigation(), here = Math.atan2(dz, dx);
      let back: T.Vector3 | null = null, best = Infinity;
      for (let i = 0; i < 24; i++) {
        const a = here + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * Math.PI / 12, x = at.x + Math.cos(a) * stop, z = at.z + Math.sin(a) * stop;
        if (nav && !nav.free({ x, z })) continue;
        const cost = Math.hypot(x - ch.root.position.x, z - ch.root.position.z);
        if (cost < best) { best = cost; back = new T.Vector3(x, 0, z); }
      }
      if (back) { const to = back; this.plan.run('care', [{ name: 'walk', tick: dt => this.host.exploration.walkToward(to, .04, dt, true) ?? true }, { name: 'do', start: then, tick: () => true }]); return; }
    }
    if (d <= stop + .05) { then(); return; }
    this.plan.run('care', [{ name: 'walk', tick: dt => this.host.exploration.walkToward(at, stop, dt, true) ?? true }, { name: 'do', start: then, tick: () => true }]);
  }
  private sinkParts(p: Placed) { return p.group.userData.care as Record<string, T.Object3D> | undefined; }
  private runStream(sink: Placed, seconds: number, then?: () => void, flow = 2.4, until?: () => boolean) {
    const stream = this.sinkParts(sink)?.Stream;
    // Real water where there is any; the drawn column only when water goes straight to where it is going.
    if (stream) stream.visible = this.host.reduced();
    this.host.water().prepare();
    this.streaming?.stopAudio?.();
    const stopAudio = waterRun(seconds, this.hearing(sink.group.position));
    // The opening of the tap, in the room's axes.
    sink.group.updateWorldMatrix(true, false);
    const at = this.host.stage.worldToLocal(sink.group.localToWorld(new T.Vector3(0, 1.03, -.03)));
    this.streaming = { sink, left: seconds, then, until, stopAudio, tap: { at, dir: new T.Vector3(0, -1, 0), speed: 1.1, flow, width: .02, tint: CLEAN } };
  }
  private streaming: { stopAudio?: () => void; sink: Placed; left: number; then?: () => void; until?: () => boolean; tap: WaterStream } | null = null;
  /** What has been changed by water falling in, not yet told to the record: a level rises smoothly, the layout does not hear of every drop. */
  private levels = new Set<string>();
  private levelWait = 0;
  /** What is open to water right now: what stands upright and open, and the sink's basin, which drains. */
  waterReceivers(): Receiver[] {
    const out: Receiver[] = [], up = new T.Vector3(), q = new T.Quaternion();
    for (const p of this.host.placed.values()) {
      const o = p.obj;
      if (o.hidden || o.inside) continue;
      if (isSink(o.kind)) {
        const g = p.group.position, s = o.scale;
        out.push({ id: o.id, x: g.x, z: g.z, r: .2 * s, top: g.y + .69 * s, bottom: g.y + .55 * s, take: () => true });
        continue;
      }
      // The earth in a pot drinks what falls on it; once it has had enough, the rest runs through to the floor.
      if (affordanceOf(o.kind).family === 'plant') {
        const box = new T.Box3().setFromObject(p.group), g = p.group.position, r = Math.min(box.max.x - box.min.x, box.max.z - box.min.z) / 2 / this.k * .85;
        out.push({ id: o.id, x: g.x, z: g.z, r: Math.min(.17, r), top: g.y + Math.min(.26, (box.max.y - box.min.y) / this.k) * o.scale, bottom: g.y, take: litres => {
          const soil = o.state?.soil ?? .5;
          if (soil >= 1) return false;
          o.state = { ...o.state, soil: Math.min(1, soil + litres / .45) };
          this.levels.add(o.id);
          return true;
        } });
        continue;
      }
      const v = vesselOf(o.kind);
      if (!v) continue;
      p.group.getWorldQuaternion(q);
      if (up.set(0, 1, 0).applyQuaternion(q).y < .82) continue;
      const g = p.group.position, s = o.scale;
      out.push({
        // It falls past the rim and is taken where the water in it is.
        id: o.id, x: g.x, z: g.z, r: v.r * s, top: g.y + (v.bottom + (v.top - v.bottom) * levelOf(o.kind, o.state) + .02) * s, bottom: g.y + v.bottom * s - .03,
        take: (litres, tint, heat) => {
          const level = levelOf(o.kind, o.state);
          if (level >= .995) return false;
          // What is in it and what came in, by how much of each.
          const had = level * v.litres, mix = litres / Math.max(1e-4, had + litres), strength = Math.max(0, Math.min(1, (tint.b - CLEAN.b) / (TEA.b - CLEAN.b)));
          const temp = (o.state?.temp ?? 0) * (1 - mix) + heat * mix, tea = (o.state?.tea ?? 0) * (1 - mix) + (tint.b > .1 && tint.g > .15 ? strength : 0) * mix;
          o.state = { ...withLevel(o.kind, o.state, level + litres / v.litres), ...(isBucket(o.kind) ? {} : { temp, tea }) };
          if (tint.b > .1 && isBucket(o.kind)) o.state.dirt = Math.min(1, (o.state.dirt ?? 0) + litres * .1);
          this.levels.add(o.id);
          applyToolLook(p);
          return true;
        },
      });
    }
    return out;
  }
  /** What water runs off: the tops of things, and the body. */
  waterShapes(): FluidShape[] {
    const out: FluidShape[] = [], life = this.host.life();
    for (const f of life.films.values()) { const s = f.surface; out.push({ kind: 0, x: s.x, y: s.y - .02, z: s.z, hx: f.field.w / 2, hy: .02, hz: f.field.d / 2, yaw: s.rotY }); if (out.length > 20) break; }
    const ch = this.host.character();
    if (ch?.ready && !ch.body.seat) out.push({ kind: 1, x: ch.root.position.x, y: .75, z: ch.root.position.z, hx: .15, hy: .75, hz: 0, yaw: 0 });
    return out;
  }
  private carryAt: { id: string; point: T.Vector3; rotation?: T.Quaternion } | null = null;
  private fillHeading: { id: string; rotation: T.Quaternion } | null = null;
  /** Taken from a table and not yet clear of it. */
  private liftingOff = new Set<string>();
  private dipIn(bucket: Placed) {
    const a = this.work.active, st = bucket.obj.state ?? {};
    if (!a) return;
    if ((st.fill ?? 0) < .06) { this.host.say('Xô hết nước rồi.', 'The bucket is empty.'); return; }
    this.goTo(bucket, .72, () => {
      const down = bucket.group.position.clone().setY(bucket.group.position.y + .06);
      this.work.moveHead(down.clone().setY(down.y + .22), .35, () => {
        splash(.6);
        this.host.life().puffs.emit(down.x, .3, down.z, 6, 'drop');
        this.work.moveHead(down, .42, () => {
          const fresh = this.host.placed.get(bucket.obj.id)?.obj.state ?? st, done = dip(a.p.obj.state ?? {}, fresh);
          if (done) { a.p.obj.state = done.tool; this.host.toolState(a.p.obj.id, done.tool); this.host.toolState(bucket.obj.id, done.bucket); applyToolLook(a.p); }
          splash(.4);
          this.work.moveHead(down.clone().setY(down.y + .32), .4);
        });
      });
    });
  }
  private wringOut(bucket: Placed) {
    const a = this.work.active;
    if (!a) return;
    this.goTo(bucket, .72, () => {
      const at = bucket.group.localToWorld(new T.Vector3(.1 / bucket.obj.scale, .34, 0)), stage = this.toStage(at);
      this.work.moveHead(stage, .35, () => {
        contactSound('plastic', .4, .5);
        this.work.moveHead(stage.clone().setY(stage.y - .12), .55, () => {
          const next = wring(a.p.obj.state ?? {}), life = this.host.life();
          a.p.obj.state = next; this.host.toolState(a.p.obj.id, next); applyToolLook(a.p);
          life.puffs.emit(stage.x, stage.y - .05, stage.z, 10, 'drop');
          splash(.25);
          this.work.moveHead(stage.clone().setY(stage.y + .2), .3);
        }, undefined, undefined);
      });
    });
  }
  private rinseAt(sink: Placed) {
    const a = this.work.active;
    if (!a) return;
    this.goTo(sink, .72, () => {
      const under = sink.group.localToWorld(new T.Vector3(0, .72, .03)), stage = this.toStage(under);
      this.work.moveHead(stage, .4, () => this.runStream(sink, 1.3, () => { const next = rinse(a.p.obj.state ?? {}); a.p.obj.state = next; this.host.toolState(a.p.obj.id, next); applyToolLook(a.p); this.work.moveHead(stage.clone().setY(stage.y + .25), .3); }));
    });
  }
  private heldThing() { const physics = this.physics, side = physics && (physics.heldIn(1) ? 1 : physics.heldIn(-1) ? -1 : null); const id = side != null ? physics!.heldIn(side) : null; return { side, id, p: id ? this.host.placed.get(id) ?? null : null }; }
  /** Under the tap: it fills as far as the water really goes in, for about as long as the bucket takes, and the tap is turned off when it is full. */
  private fillAt(sink: Placed) {
    const { id, p } = this.heldThing(), v = p ? vesselOf(p.obj.kind) : null;
    if (!id || !p || !v) return;
    if (levelOf(p.obj.kind, p.obj.state) >= .985) { this.host.say('Đã đầy rồi.', 'It is full.'); return; }
    this.goTo(sink, .46, () => {
      // Into the basin: the hands take it past the rim, nothing else stops it.
      const side = this.physics?.sideOf(id) ?? 1;
      this.physics?.bringToPlace(side);
      // Its opening under the tap, its bottom in the basin: where its own origin stands, whatever its shape does to its middle.
      const under = this.toStage(sink.group.localToWorld(new T.Vector3(0, .71, -.03)));
      let rotation = p.group.quaternion.clone();
      if (p.obj.kind === 'kettle.vintage' || p.obj.kind === 'can.watering') {
        // A long spout pointing at the backsplash traps the vessel under
        // the faucet. Service it along the basin's width, on the nearer face.
        const left = new T.Quaternion().setFromAxisAngle(UP, sink.obj.rotY + Math.PI / 2);
        const right = new T.Quaternion().setFromAxisAngle(UP, sink.obj.rotY - Math.PI / 2);
        rotation = rotation.angleTo(left) < rotation.angleTo(right) ? left : right;
      }
      this.fillHeading = { id, rotation };
      this.carryAt = { id, point: this.physics!.centreFor(id, under, rotation, new T.Vector3()) };
      const seconds = 2.4, room = (1 - levelOf(p.obj.kind, p.obj.state)) * v.litres;
      this.runStream(sink, seconds + .5, () => {
        this.carryAt = null; this.physics?.liftOut(side);
        // Filling finishes below the basin rim. Plan the same up-and-out
        // clearance as a pickup from a shelf before resuming the carry.
        this.liftingOff.add(id);
        // Motion off: it filled all the same.
        if (this.host.reduced()) { p.obj.state = withLevel(p.obj.kind, p.obj.state, 1); applyToolLook(p); }
        p.obj.state = { ...p.obj.state, ...(isBucket(p.obj.kind) ? { dirt: 0 } : {}) };
        this.host.toolState(id, p.obj.state);
      }, Math.max(.35, room / seconds), () => levelOf(p.obj.kind, p.obj.state) >= .985);
    });
  }
  private tintOf(p: Placed): Tint {
    const st = p.obj.state, tea = st?.tea ?? 0;
    if (tea > .02) return { r: CLEAN.r + (TEA.r - CLEAN.r) * tea, g: CLEAN.g + (TEA.g - CLEAN.g) * tea, b: CLEAN.b + (TEA.b - CLEAN.b) * tea };
    return (st?.dirt ?? 0) > .2 ? MURKY : CLEAN;
  }
  /**
   * Pouring is tilting: the thing leans until the water reaches its lip, a full one at a touch, a nearly empty one almost over, and what goes over the lip is real water, going wherever it goes. Over a
   * vessel or a plant it goes in; anywhere else it is on the floor. Again, or a step away, stops it.
   */
  private pourInto(target: Placed | null) {
    if (this.pouring) { this.stopPour(); return; }
    const { side, id, p } = this.heldThing(), v = p ? vesselOf(p.obj.kind) : null;
    if (side == null || !id || !p || !v) return;
    if (levelOf(p.obj.kind, p.obj.state) < .01) { this.host.say('Không còn gì để rót.', 'There is nothing left to pour.'); return; }
    if (target && vesselOf(target.obj.kind) && new T.Vector3(0, 1, 0).applyQuaternion(target.group.quaternion).y < .82) {
      this.host.say('Hãy đặt vật nhận nước đứng thẳng trước khi rót.', 'Stand the receiving vessel upright before pouring.'); return;
    }
    const aim = target && (vesselOf(target.obj.kind) || isSink(target.obj.kind) || affordanceOf(target.obj.kind).family === 'plant') ? target : null;
    this.host.water().prepare();
    const go = () => {
      const ch = this.host.character();
      if (!ch?.ready || this.physics?.sideOf(id) !== side) return;
      this.physics.bringToPlace(side);
      this.pouring = { p, side, target: aim, tilt: 0, wait: 0, from: ch.root.position.clone(), stream: { at: new T.Vector3(), dir: new T.Vector3(), speed: v.speed, flow: 0, width: v.lipWidth, spray: v.spray, tint: CLEAN }, sound: 0 };
    };
    // A long spout is poured from further off: the hand stays where an arm is comfortable, and the spout reaches the rest of the way.
    const lever = this.pourLever(p), stand = aim ? this.pourStand(p, aim) : 0;
    if (aim) this.goTo(aim, stand, go, lever > .12 ? stand * .86 : 0); else go();
  }
  /** How far ahead of the hand the lip of a thing is when it is tipped: nothing for what is poured across the body. */
  private pourLever(p: Placed) {
    const h = HANDLES[p.obj.kind], v = vesselOf(p.obj.kind);
    if (!h || !v || h.pours === 'across') return 0;
    const g = h.pourGrip ?? h;
    return Math.hypot(v.lip[2] - g.at[2], v.lip[0] - g.at[0]) * .78 * p.obj.scale;
  }
  /**
   * How far from what it pours into the body stands: where the hand is when the thing is tipped to pour there. The water leaves the lip and carries
   * on before it reaches the rim, the lip is the length of the thing ahead of the hand, and the hand is a forearm ahead of the body. Leaving any of
   * these out put a watering can's handle behind the back, the wrist turned over to hold it.
   */
  private pourStand(p: Placed, target: Placed) {
    const v = vesselOf(p.obj.kind), h = HANDLES[p.obj.kind], sink = isSink(target.obj.kind);
    if (!v || !h || h.pours === 'across') return sink ? .46 : .52;
    const s = p.obj.scale, g = h.pourGrip ?? h, r = vesselOf(target.obj.kind), ts = target.obj.scale;
    const rim = target.group.position.y + (r ? r.top : sink ? .69 : .26) * ts;
    const tilt = Math.min(2.1, spillAngle(v, levelOf(p.obj.kind, p.obj.state)) + .26), q = new T.Quaternion().setFromAxisAngle(new T.Vector3(1, 0, 0), tilt);
    const lip = new T.Vector3(v.lip[0], v.lip[1], v.lip[2]).multiplyScalar(s).applyQuaternion(q), grip = new T.Vector3(g.at[0], g.at[1], g.at[2]).multiplyScalar(s).applyQuaternion(q);
    const ty = Math.max(rim + (r ? .1 : sink ? .29 : .04) * ts, POUR_LOWEST, POUR_HAND - (grip.y - lip.y));
    let outY = -Math.sin(tilt);
    const outH = Math.cos(tilt);
    if (v.spray) outY -= .55; else outY = Math.min(outY, -.12);
    const outLen = Math.hypot(outY, outH), down = -outY / outLen * v.speed;
    const carries = outH / outLen * v.speed * (-down + Math.sqrt(down * down + 2 * 9.81 * Math.max(.02, ty - rim))) / 9.81;
    return Math.max(sink ? .46 : .52, carries + Math.hypot(lip.z - grip.z, lip.x - grip.x) + .24);
  }
  private stopPour() {
    const pr = this.pouring;
    if (!pr) return;
    pr.stopAudio?.(); this.pouring = null;
    this.carryAt = null;
    this.host.water().stopStream(pr.stream);
    this.physics?.liftOut(pr.side); this.physics?.holdRotation(pr.side, null);
    this.fillHeading = null;
    this.liftingOff.add(pr.p.obj.id);
    if (pr.p.obj.state) this.host.toolState(pr.p.obj.id, pr.p.obj.state);
  }
  private pouring: { p: Placed; side: number; target: Placed | null; tilt: number; wait: number; from: T.Vector3; stream: WaterStream; sound: number; stopAudio?: () => void } | null = null;
  private updatePour(dt: number) {
    const pr = this.pouring, physics = this.physics, ch = this.host.character();
    if (!pr) return;
    const { p } = pr, v = vesselOf(p.obj.kind);
    // Walking off ends it; a foot shifting under the weight of a full can does not (the place it was started from comes along).
    if (ch?.ready && this.host.exploration.speed < .05) pr.from.copy(ch.root.position);
    if (!v || !physics || !ch?.ready || physics.sideOf(p.obj.id) !== pr.side || !this.host.placed.has(p.obj.id) || Math.hypot(ch.root.position.x - pr.from.x, ch.root.position.z - pr.from.z) > .45) { this.stopPour(); return; }
    const level = levelOf(p.obj.kind, p.obj.state), spill = spillAngle(v, level);
    // Over what it is pouring into, or a step ahead of the body. The spout goes that way.
    const body = ch.root.position, target = pr.target;
    let tx: number, tz: number, ty: number, rim = 0, wide = .1;
    if (target) {
      const r = vesselOf(target.obj.kind), s = target.obj.scale, y = target.group.position.y;
      tx = target.group.position.x; tz = target.group.position.z;
      rim = y + (r ? r.top : isSink(target.obj.kind) ? .69 : .26) * s;
      wide = (r ? r.r : .16) * s;
      ty = Math.max(rim + (r ? .1 : isSink(target.obj.kind) ? .29 : .04) * s, POUR_LOWEST);
    } else { const f = ch.bodyForward(new T.Vector3()), out = .36 + this.pourLever(p); tx = body.x + f.x * out; tz = body.z + f.z * out; ty = Math.max(POUR_LOWEST, .8 - out * .25); }
    // In line with the shoulder that has it, so the arm reaches straight out. A bar that runs along the spout lies across the forearm instead: the spout turns in across the body, and pouring is a roll of the forearm.
    const across = ch.bodyForward(new T.Vector3()).cross(UP).normalize(), sx = body.x + across.x * pr.side * .17, sz = body.z + across.z * pr.side * .17;
    let dirX = tx - sx, dirZ = tz - sz;
    { const n = Math.hypot(dirX, dirZ) || 1; dirX /= n; dirZ /= n; }
    if (HANDLES[p.obj.kind]?.pours === 'across') {
      let inX = -dirZ, inZ = dirX;
      if (inX * across.x * pr.side + inZ * across.z * pr.side > 0) { inX = -inX; inZ = -inZ; }
      dirX = inX * .9 + dirX * .42; dirZ = inZ * .9 + dirZ * .42;
    }
    const yaw = Math.atan2(dirX, dirZ);
    // Further than an arm and a lean get: nobody pours from there.
    if (Math.hypot(tx - body.x, tz - body.z) > Math.max(.92 + this.pourLever(p) * .6, (target ? this.pourStand(p, target) : 0) + .3)) { this.host.say('Xa quá, lại gần hơn đã.', 'Too far: go nearer first.'); this.stopPour(); return; }
    // Water leaves the lip going outward and falls: the lip stands short of the middle by as far as it carries on the way down.
    let outY = -Math.sin(pr.tilt), outH = Math.cos(pr.tilt);
    if (v.spray) outY -= .55; else outY = Math.min(outY, -.12);
    const outLen = Math.hypot(outY, outH), down = -outY / outLen * v.speed;
    const carries = target ? outH / outLen * v.speed * (-down + Math.sqrt(down * down + 2 * 9.81 * Math.max(.02, ty - rim))) / 9.81 : 0;
    const lipX = tx - Math.sin(yaw) * carries, lipZ = tz - Math.cos(yaw) * carries;
    // Nothing tips until the lip is there: a person does not start pouring on the way.
    const seen = this.lipOf(p, new T.Vector3());
    const there = !target || Math.hypot(seen.x - lipX, seen.z - lipZ) < .012 + wide * .5;
    if (there) { pr.tilt = Math.min(Math.min(2.1, spill + .26), pr.tilt + dt * .95); pr.wait = 0; }
    else {
      pr.tilt = Math.min(Math.max(0, spill - .05), pr.tilt + dt * 1.25);
      pr.wait += dt;
      if (pr.wait > 2.4) { this.host.say('Không với tới: lại gần hơn đã.', 'Out of reach: go nearer first.'); this.stopPour(); return; }
    }
    const q = new T.Quaternion().setFromAxisAngle(UP, yaw).multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(1, 0, 0), pr.tilt));
    const s = p.obj.scale, lip = new T.Vector3(v.lip[0], v.lip[1], v.lip[2]).multiplyScalar(s).applyQuaternion(q);
    // The hand stays where an arm hangs comfortably, at the waist or above: if that puts the lip high over what is low, the water falls further.
    { const h = HANDLES[p.obj.kind], g = h ? (h.pourGrip ?? h) : null;
      if (g) { const fromLip = new T.Vector3(g.at[0], g.at[1], g.at[2]).multiplyScalar(s).applyQuaternion(q).sub(lip); ty = Math.max(ty, POUR_HAND - fromLip.y); } }
    const groupAt = new T.Vector3(lipX, ty, lipZ).sub(lip);
    physics.holdGroupRotation(pr.side, q);
    this.carryAt = { id: p.obj.id, point: physics.centreFor(p.obj.id, groupAt, q, new T.Vector3()) };
    // As much goes over as the lean lets through.
    const open = T.MathUtils.smoothstep(pr.tilt - spill, 0, .3);
    const flow = Math.min(level * v.litres / Math.max(dt, 1e-3), v.litres * (v.litres > 5 ? .42 : v.spray ? .22 : .32) * open);
    if (flow > 1e-3 && level > .002) {
      this.lipOf(p, pr.stream.at, pr.stream.dir);
      if (v.spray) pr.stream.dir.y -= .55;
      else pr.stream.dir.y = Math.min(pr.stream.dir.y, -.12);
      pr.stream.dir.normalize();
      pr.stream.flow = flow; pr.stream.tint = this.tintOf(p); pr.stream.heat = p.obj.state?.temp ?? 0;
      this.host.water().stream(pr.stream, dt);
      p.obj.state = withLevel(p.obj.kind, p.obj.state, level - flow * dt / v.litres);
      applyToolLook(p);
      pr.sound -= dt;
      if (pr.sound <= 0) { pr.sound = 1; pr.stopAudio?.(); pr.stopAudio = waterRun(1, this.hearing(p.group.position)); }
    } else if (pr.stopAudio) { pr.stopAudio(); pr.stopAudio = undefined; pr.sound = 0; }
    const full = target && vesselOf(target.obj.kind) ? levelOf(target.obj.kind, target.obj.state) >= .985 : false;
    // Poured right out: the last film goes with it, and an empty thing holds nothing murky and no tea.
    if (levelOf(p.obj.kind, p.obj.state) <= .003) { const st = withLevel(p.obj.kind, p.obj.state, 0); if (st.dirt !== undefined) st.dirt = 0; if (st.tea !== undefined) st.tea = 0; p.obj.state = st; applyToolLook(p); }
    if (levelOf(p.obj.kind, p.obj.state) <= .003 || full) this.stopPour();
  }
  /** Switches the kettle on or off with a hand. It boils only what is in it. */
  private useKettle(p: Placed) {
    const at = p.group.localToWorld(new T.Vector3(.0, .05, -.1));
    this.touch(() => this.toStage(at), () => at, 'push', 'press', .56, () => {
      const st = p.obj.state ?? {};
      if (!st.on && levelOf(p.obj.kind, st) < .03) { this.host.say('Trong ấm không có nước.', 'There is no water in the kettle.'); return; }
      p.obj.state = { ...st, on: !st.on };
      this.host.toolState(p.obj.id, p.obj.state, true);
    }, 'metal');
  }
  /** A new bulb: the free hand turns the old one out, the one in the hand goes in, the lamp lights. */
  private changeBulb(lamp: Placed) {
    const { side, id } = this.heldThing();
    if (side == null || !id) return;
    const box = new T.Box3().setFromObject(lamp.group), at = box.getCenter(new T.Vector3());
    at.y = box.min.y + (box.max.y - box.min.y) * .78;
    this.touch(() => this.toStage(at), () => at, 'push', 'pinch', .58, () => {
      this.physics?.forget(id); this.releaseHeldContacts(side, id, .20); this.host.despawn?.(id);
      contactSound('glass', .4, .5); chime('ready');
      this.host.objectState(lamp.obj.id, { state: { ...lamp.obj.state, burnt: false }, lightOn: true }, 'bulb');
      this.host.say('Sáng lại rồi.', 'There is light again.');
    }, 'glass');
  }
  private vesselTick = 0;
  private vesselSave = 0;
  private hum: Scrape | null = null;
  /** What has happened to the things in the room with time: kettles heat, tea steeps and cools, earth dries. Four times a second is plenty. */
  private updateVessels(dt: number) {
    this.vesselTick += dt;
    if (this.vesselTick < .25) return;
    const step = this.vesselTick;
    this.vesselTick = 0;
    this.vesselSave -= step;
    const life = this.host.life();
    let hum = 0;
    for (const p of this.host.placed.values()) {
      const o = p.obj;
      if (o.hidden) continue;
      if (affordanceOf(o.kind).family === 'plant') { applyToolLook(p); this.plantLook(p); continue; }
      const v = vesselOf(o.kind);
      if (!v || isBucket(o.kind)) continue;
      const st = o.state ?? (o.state = {}), level = levelOf(o.kind, st);
      let temp = st.temp ?? 0;
      if (o.kind === 'kettle.vintage' && st.on) {
        temp = Math.min(1, temp + step / (9 + 16 * level));
        if (level < .02) { st.on = false; this.host.toolState(o.id, { ...st, temp }, true); }
        else if (temp >= 1) { st.on = false; contactSound('metal', .5, this.hearing(p.group.position)); this.host.toolState(o.id, { ...st, temp }, true); }
        else hum = Math.max(hum, (.1 + temp * .32) / (1 + .5 * this.hearing(p.group.position) ** 2));
      } else temp = Math.max(0, temp - step / (o.kind === 'teacup' ? 240 : 420));
      st.temp = temp;
      if (o.kind === 'teapot' && level > .04 && temp > .45) st.tea = Math.min(1, (st.tea ?? 0) + step / 26);
      if (level < .004) st.tea = 0;
      // Hot water shows it.
      if (temp > .42 && level > .02 && !this.host.reduced()) {
        const at = this.host.stage.worldToLocal(p.group.localToWorld(new T.Vector3(v.lip[0], v.lip[1] + .01, v.lip[2])));
        if (Math.random() < temp) life.puffs.emit(at.x, at.y, at.z, temp > .9 ? 2 : 1, 'steam');
      }
      applyToolLook(p);
    }
    if (hum > 0) { this.hum ??= new Scrape(); this.hum.set(hum, 'wet'); }
    else if (this.hum) { this.hum.stop(); this.hum = null; }
    if (this.vesselSave <= 0) {
      this.vesselSave = 6;
      for (const p of this.host.placed.values()) { const v = vesselOf(p.obj.kind); if (v && !isBucket(p.obj.kind) && p.obj.state && (p.obj.state.temp ?? 0) > 0) this.host.toolState(p.obj.id, { ...p.obj.state }); }
    }
  }
  /** A plant that has been looked after is a little bigger than it was; keeps strictly uniform scale (`0` squash/shear). */
  private plantLook(p: Placed) {
    const inner = p.group.children[0];
    if (!inner) return;
    const st = p.obj.state, grown = 1 + (st?.growth ?? 0) * .3, key = grown.toFixed(3);
    if (p.group.userData.plantKey === key) return;
    p.group.userData.plantKey = key;
    const restScale = (inner.userData._restScale as T.Vector3 | undefined) ?? (inner.userData._restScale = inner.scale.clone());
    inner.scale.copy(restScale).multiplyScalar(grown);
  }
  /** The room was left: what time does to what is in it. */
  timePassed(days: number) { this.daysOwed += days; }
  private daysOwed = 0;
  private settleTime() {
    const days = this.daysOwed;
    // A clock tick is not a day: what it did is told once there is something to tell.
    if (days < .02 || !this.host.placed.size) return;
    this.daysOwed = 0;
    const care = this.host.life().life.settings.care;
    for (const p of this.host.placed.values()) {
      const o = p.obj, a = affordanceOf(o.kind);
      if (o.hidden) continue;
      if (a.family === 'plant') {
        const st = o.state ?? {}, soil = Math.max(0, (st.soil ?? .5) - days * (care === 'off' ? 0 : care === 'relaxed' ? .12 : .26));
        // It grew if it was kept going, and the curtains let the light in.
        const light = 1 - (this.host.layout()?.room.curtains ?? 0);
        const growth = Math.min(1, (st.growth ?? 0) + (soil > .1 ? days * .012 * light : 0));
        this.host.toolState(o.id, { ...st, soil, growth });
      } else if (vesselOf(o.kind) && !isBucket(o.kind) && o.kind !== 'mug') {
        const st = o.state ?? {}, level = levelOf(o.kind, st);
        this.host.toolState(o.id, { ...withLevel(o.kind, st, level * Math.exp(-days * .03)), temp: 0, on: false });
      } else if (CATALOG_BY_ID[o.kind]?.light && !o.state?.burnt && care !== 'off') {
        // A bulb lasts some months: left long enough, one of them goes.
        if (Math.random() < 1 - Math.exp(-days / 70)) this.host.toolState(o.id, { ...o.state, burnt: true });
      }
    }
  }
  private emptyInto(bin: Placed) {
    const a = this.work.active, st = a?.p.obj.state;
    if (!a) return;
    if ((st?.fill ?? 0) < .01) { this.host.say('Ki đang rỗng.', 'The dustpan is empty.'); return; }
    if ((bin.obj.state?.fill ?? 0) > .97) { this.host.say('Thùng đầy rồi. Buộc túi lại đã.', 'The bin is full. Tie the bag first.'); return; }
    this.goTo(bin, .62, () => {
      const over = this.toStage(bin.group.localToWorld(new T.Vector3(0, .5, 0)));
      this.work.moveHead(over, .5, () => {
        this.work.moveHead(over, .7, () => {
          const fresh = a.p.obj.state ?? {}, share = (fresh.fill ?? 0) * PAN_ROOM / BIN_ROOM, life = this.host.life();
          life.puffs.emit(over.x, over.y, over.z, 8, 'dust');
          a.p.obj.state = { ...fresh, fill: 0 }; this.host.toolState(a.p.obj.id, a.p.obj.state); applyToolLook(a.p);
          this.addToBin(bin, share);
          contactSound('metal', .35, .5);
        }, -1.05);
      });
    });
  }
  private discardInto(bin: Placed) {
    const { side, id, p } = this.heldThing();
    if (side == null || !id || !p) return;
    if ((bin.obj.state?.fill ?? 0) > .97) { this.host.say('Thùng đầy rồi. Buộc túi lại đã.', 'The bin is full. Tie the bag first.'); return; }
    this.goTo(bin, .7, () => {
      this.startPlacement(side, this.toStage(bin.group.localToWorld(new T.Vector3(0, .42, 0))), new T.Quaternion(), { gone: true, done: () => this.addToBin(bin, .02) });
      this.physics?.bringToPlace(side);
    });
  }
  private takeBag(bin: Placed) {
    if (this.hands().free < 1) { this.host.say('Hai tay đang bận.', 'Both hands are full.'); return; }
    this.goTo(bin, .62, () => {
      const top = bin.group.localToWorld(new T.Vector3(0, .36, 0)), side = this.handFor(top);
      this.actions.start({
        side, reach: .46, release: .3, contact: () => this.grip(top, side, 'handle', 'over'),
        onContact: () => {
          contactSound('cloth', .5, .4);
          const id = this.host.uid(), at = this.toStage(top);
          this.host.toolState(bin.obj.id, { ...bin.obj.state, fill: 0 });
          this.host.spawn({ id, kind: 'trash.bag', pos: [at.x, at.y - .2, at.z], rotY: bin.obj.rotY, scale: 1 });
          this.pendingLift = { id, side };
        },
      });
    });
  }
  /** The bag goes out through a door that a free hand opens and closes. It is gone: that is what taking the rubbish out is. */
  private bagOut() {
    const { side, id, p } = this.heldThing(), dest = this.targetId?.slice(7) as WorldDestination, door = this.host.room()?.door(dest), l = this.host.layout();
    if (side == null || !id || !p || !door || !l) return;
    const half = l.room.size / 2, landing = new T.Vector3(door.x, 0, half - .78), out = new T.Vector3(door.x, .3, half + .4);
    let placement: Manipulator['placing'] = null;
    this.plan.run('care', [
      { name: 'walk', tick: dt => this.host.exploration.walkToward(landing, .3, dt, false) ?? true },
      { name: 'door', start: () => { if (!door.isOpen) this.useDoor(dest, true); }, tick: () => !this.actions.busy && door.isOpen },
      { name: 'out', start: () => { placement = this.startPlacement(side, out, new T.Quaternion(), { gone: true }); this.physics?.bringToPlace(side); contactSound('cloth', .6, .5); }, tick: () => placement?.result === 'placed' ? true : placement?.result === 'moving' ? false : null, cancel: () => this.cancelPlacement() },
      { name: 'close', start: () => this.useDoor(dest, false), tick: () => !this.actions.busy },
    ]);
  }
  private runWater(sink: Placed) {
    this.host.water().prepare?.();
    const at = sink.group.localToWorld(new T.Vector3(.095, .96, -.165));
    this.touch(() => this.toStage(at), () => at, 'push', 'pinch', .6, () => { this.runStream(sink, 1.6); }, 'metal');
  }
  /** Something to do with the sink's water and with things in motion. */
  private updateCare(dt: number) {
    if (this.streaming) {
      this.host.water().stream(this.streaming.tap, dt);
      this.streaming.left -= dt;
      if (this.streaming.left <= 0 || this.streaming.until?.()) { const s = this.streaming; s.stopAudio?.(); this.streaming = null; const stream = this.sinkParts(s.sink)?.Stream; if (stream) stream.visible = false; this.host.water().stopStream(s.tap); s.then?.(); }
    }
    this.updatePour(dt);
    this.updateVessels(dt);
    this.settleTime();
    this.levelWait -= dt;
    if (this.levelWait <= 0 && this.levels.size) {
      this.levelWait = .6;
      for (const id of this.levels) { const p = this.host.placed.get(id); if (p?.obj.state) this.host.toolState(id, { ...p.obj.state }); }
      this.levels.clear();
    }
  }
  /** Rack return for `ToolSpec` items, reusing original storage face when unchanged and probing symmetric `Math.PI` faces. */
  private hangBack(rack: Placed) {
    const { side, p } = this.heldThing(), physics = this.physics;
    if (side == null || !p || !physics) return;
    const id = p.obj.id;
    rack.group.updateWorldMatrix(true, false);
    const previous = this.rackRoutes?.get(id);
    const sameSlot = previous?.rack === rack.obj.id && previous.rackGroup === rack.group &&
      previous.toolGroup === p.group && previous.frame.elements.every((v, i) => Math.abs(v - rack.group.matrixWorld.elements[i]) < 1e-8);
    const heldYaw = new T.Euler().setFromQuaternion(sameSlot ? previous.rotation : p.group.quaternion, 'YXZ').y;
    const spot = onRack(rack.obj, p.obj.kind, heldYaw);
    if (!spot) { this.host.say('Giá này không có chỗ cho nó.', 'That rack has no place for it.'); return; }
    const q0Inv = (physics.startOf(id) ?? new T.Quaternion()).clone().invert();
    const toSpotQuat = (s: NonNullable<ReturnType<typeof onRack>>) =>
      s.quat ? new T.Quaternion(...s.quat) : new T.Quaternion().setFromAxisAngle(UP, s.rotY);
    const firstQ = toSpotQuat(spot);
    const candidates = [{ spot, q: firstQ }];
    const opposite = onRack(rack.obj, p.obj.kind, heldYaw + Math.PI);
    if (opposite) {
      const oppQ = toSpotQuat(opposite);
      if (oppQ.angleTo(firstQ) > 1e-4) candidates.push({ spot: opposite, q: oppQ });
    }
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const at = physics.centreFor(id, new T.Vector3(...c.spot.pos), c.q, new T.Vector3());
      const bodyQ = c.q.clone().multiply(q0Inv);
      if (this.placeHeldAt(side, at, bodyQ, { rack: rack.obj.id }, i < candidates.length - 1 || Boolean(this.plan))) return;
    }
    if (this.plan) {
      const fallback = candidates[0];
      this.goTo(rack, .74, () => {
        if (this.physics?.heldIn(side) !== id) return;
        this.work.end();
        this.physics.forget(id);
        p.group.position.set(fallback.spot.pos[0], fallback.spot.pos[1], fallback.spot.pos[2]);
        p.group.quaternion.copy(fallback.q);
        p.group.scale.setScalar(p.obj.scale);
        p.group.updateWorldMatrix(true, true);
        p.obj.pos = [fallback.spot.pos[0], fallback.spot.pos[1], fallback.spot.pos[2]];
        p.obj.rotY = fallback.spot.rotY;
        p.obj.quat = fallback.spot.quat ? [...fallback.spot.quat] : undefined;
        if (p.blob) p.blob.visible = !fallback.spot.quat;
        this.host.objectState(
          id,
          { pos: [fallback.spot.pos[0], fallback.spot.pos[1], fallback.spot.pos[2]], rotY: fallback.spot.rotY, quat: fallback.spot.quat ? [...fallback.spot.quat] : undefined },
          `place-${id}-${Date.now()}`,
        );
        this.carried.delete(id);
        this.releaseHeldContacts(side, id, .20);
        this.syncRoom();
        this.host.navigationChanged?.();
        contactSound(affordanceOf(p.obj.kind).material, .30, .45);
        this.host.changed();
      });
    }
  }
  /** What the body is carrying, and where it is: the weight that the feet have to stand under. */
  bodyLoads() {
    const out: { at: T.Vector3; kg: number }[] = [], physics = this.physics;
    if (!physics) return out;
    for (const id of physics.heldIds) {
      const p = this.host.placed.get(id);
      if (!p) continue;
      // A long tool rests on what it works on: the arms hold little of it.
      const spec = toolOf(p.obj.kind);
      const kg = massNow(p.obj.kind, p.obj.state, affordanceOf(p.obj.kind).mass) * (spec && spec.length > .5 && this.work.touchingNow ? .3 : 1);
      if (kg < .25) continue;
      out.push({ at: p.group.getWorldPosition(new T.Vector3()), kg });
    }
    return out;
  }
  /** What the hands are straining against, newtons, in the world's axes. */
  handForce() {
    const ps = this.push;
    if (!ps?.handF || ps.handF.lengthSq() < 1) return null;
    return { x: ps.handF.x, z: ps.handF.z, height: ps.gripHeight };
  }
  /** How the feet should stand for what the hands are doing. */
  bodyStance(): import('@/lib/embodiment/balance').Stance | null {
    const ps = this.push;
    if (ps) {
      const effort = ps.gauge ? Math.min(1, ps.gauge.applied / HUMAN.push) : .2;
      // One foot back to push from; pulling the weight goes over the back foot and the front one braces.
      return ps.pulling ? { lead: 1, front: .16 + effort * .1, back: .1 + effort * .06, wide: .03 } : { lead: 1, front: .05 + effort * .05, back: .14 + effort * .16, wide: .03 };
    }
    const a = this.work.active;
    if (a) {
      if (a.spec.length > .9) return this.work.isWorking ? { lead: -a.side, front: .1, back: .08, wide: .035 } : null;
      if (a.spec.work === 'scoop' && this.work.isWorking) return { lead: -a.side, front: .15, back: .12, wide: .05 };
      return null;
    }
    const held = this.bodyLoads();
    let kg = 0;
    for (const l of held) kg += l.kg;
    // Reaching for something heavy, or carrying it: feet a little wider apart.
    const lifting = this.actions.current?.keep && this.actions.current.reach !== undefined ? this.reachKg : 0;
    if (lifting > 3 || kg > 3) return { wide: Math.min(.07, .012 + Math.max(lifting, kg) * .0035) };
    return null;
  }
  /** How hard the body is working, 0..1. */
  bodyStrain() {
    const ps = this.push;
    if (ps?.gauge) return Math.min(1, ps.gauge.applied / HUMAN.push);
    let kg = 0;
    for (const l of this.bodyLoads()) kg += l.kg;
    return Math.min(.75, kg / 30);
  }
  private reachKg = 0;
  /** How heavy, and on which side: what the body has to lean against. */
  get bodyLoad() {
    const { side, p } = this.heldThing();
    if (side == null || !p || this.work.active) return null;
    const kg = massNow(p.obj.kind, p.obj.state, affordanceOf(p.obj.kind).mass);
    return affordanceOf(p.obj.kind).hands === 1 && kg > 2 ? { side, kg } : null;
  }
  get toolTwist() { return this.work.twist; }
  /** What the hands and the body know, for the room's stories. */
  factsForLife() {
    const l = this.host.layout(), held = this.physics?.heldIds.map(id => this.host.placed.get(id)?.obj.kind ?? '').filter(Boolean) ?? [];
    const of = (kind: string) => l?.objects.find(o => o.kind === kind && !o.hidden);
    const mop = of('tool.mop'), pan = of('tool.dustpan'), bucket = of('tool.bucket'), bin = of('bin.trash'), ch = this.host.character();
    const social = this.host.unreadMessages?.() ?? { unread: 0, invited: false };
    return {
      held, mopLoad: mop?.state?.load ?? 0, mopWet: mop?.state?.wet ?? 0, panFill: pan?.state?.fill ?? 0, panHeld: held.includes('tool.dustpan'),
      bucketDirt: bucket?.state?.dirt ?? 0, bucketFill: bucket?.state?.fill ?? 0, binFull: (bin?.state?.fill ?? 0) > .92,
      atDesk: !!ch?.body.seat && !!l?.objects.some(o => o.kind.startsWith('desk.') && !o.hidden && Math.hypot(o.pos[0] - ch.root.position.x, o.pos[2] - ch.root.position.z) < 1.5),
      onScreen: !!this.deviceId || !!this.host.screenOpen?.(), bookOpen: !!this.book, busy: this.busy || !!this.push || this.work.pressing || this.inspecting,
      trash: l?.objects.filter(o => o.kind === 'trash.paper' && !o.hidden).length ?? 0, ...social,
      hasKettle: !!of('kettle.vintage'), kettleHot: (of('kettle.vintage')?.state?.temp ?? 0) > .9, teaReady: (of('teapot')?.state?.tea ?? 0) > .55 && levelOf('teapot', of('teapot')?.state) > .04,
      cupHasTea: (of('teacup')?.state?.tea ?? 0) > .25 && levelOf('teacup', of('teacup')?.state) > .08, plantDry: !!l?.objects.some(o => !o.hidden && (o.state?.soil ?? 1) < .16), bulbBurnt: !!l?.objects.some(o => !o.hidden && o.state?.burnt),
    };
  }

  // ── Furniture moved by force ────────────────────────────────────────────────────────────────────────
  /**
   * Both hands on it, feet braced, then Rapier moves it: the floor holds it until the push beats static friction (μs·m·g, the arrow on
   * the meter), sliding friction and its own mass decide how it goes after that, walls and other furniture stop it. A light chair simply
   * goes with the legs; a desk or a bed needs strength gathered first, and keeps needing it to keep moving. The furniture never follows
   * the body: the body follows the furniture, at its hands, and nothing is ever placed by a script.
   */
  private beginPush(p: Placed) {
    const a = affordanceOf(p.obj.kind);
    if ((a.mobility !== 'movable' && !a.pushable) || p.obj.locked) { this.host.say('Vật này cố định, không đẩy được.', 'This is fixed in place.'); return; }
    const res = slideResistance(p.obj.kind);
    if (!res.feasible) { this.host.say(`Quá nặng để một người dịch chuyển (cần ${Math.round(res.breakaway)} N).`, `Too heavy for one person to move (needs ${Math.round(res.breakaway)} N).`); return; }
    if (this.hands().free < 2) { this.host.say('Cần cả hai tay.', 'That takes both hands.'); return; }
    const ch = this.host.character();
    if (!ch?.ready) return;
    if (ch.body.seat) { this.standThen(() => this.beginPush(p)); return; }
    if (ch.occupies(p.obj.id)) return;
    void this.ensurePhysics();
    const point = new T.Vector3(p.group.position.x, 0, p.group.position.z);
    // Arm's length from its near side, wherever the body comes from: a desk's long side and its short side are not the same distance from its centre.
    const away = ch.root.position.clone().sub(point).setY(0), around = p.group.rotation.y, sizes = CATALOG_BY_ID[p.obj.kind]?.size ?? [.5, .5];
    if (away.lengthSq() < 1e-4) away.set(0, 0, 1);
    away.normalize();
    const alongX = Math.abs(away.x * Math.cos(around) - away.z * Math.sin(around)), alongZ = Math.abs(away.x * Math.sin(around) + away.z * Math.cos(around));
    // Close enough to put the weight behind the hands: at arm's length a person has nothing to push with.
    const stop = Math.min(sizes[0] / 2 / Math.max(.001, alongX), sizes[1] / 2 / Math.max(.001, alongZ)) * p.obj.scale + .25;
    const edge = () => {
      const c = p.group.getWorldPosition(new T.Vector3());
      const at = ch.root.getWorldPosition(new T.Vector3()), to = at.clone().sub(c).setY(0).normalize();
      const size = CATALOG_BY_ID[p.obj.kind]?.size ?? [.5, .5], s = this.k * p.obj.scale, q = p.group.rotation.y;
      const fx = Math.abs(to.x * Math.cos(q) - to.z * Math.sin(q)), fz = Math.abs(to.x * Math.sin(q) + to.z * Math.cos(q));
      const r = Math.min(size[0] / 2 / Math.max(.001, fx), size[1] / 2 / Math.max(.001, fz)) * s;
      // As high up on it as arms comfortably push: the back of a chair rather than its seat.
      const box = new T.Box3().setFromObject(p.group), h = Math.min(box.max.y, box.min.y + 1.02 * this.k);
      return c.addScaledVector(to, r).setY(Math.max(h - .04 * this.k, box.min.y + .2 * this.k));
    };
    const contact = (s: number): HandContact => {
      const e = edge(), f = ch.bodyForward(new T.Vector3()), r = new T.Vector3().crossVectors(f, UP);
      return this.grip(e.addScaledVector(r, s * .17 * this.k), s, 'handle', 'over');
    };
    this.actions.start({
      side: 1, approach: { point, stop }, reach: .42, keep: true, release: .36,
      contact: () => contact(1), second: () => contact(-1),
      onContact: () => { contactSound(a.material, .35, .5); void this.ensurePhysics().then(physics => { if (physics && this.host.placed.get(p.obj.id) === p) this.takeHold(physics, p, res); else this.actions.letGoAll(); }); },
    });
  }
  /** The hands are on it: it becomes a body on the floor, and what stands on it rides along. */
  private takeHold(physics: StudyPhysics, p: Placed, res: Resistance) {
    const ch = this.host.character(), l = this.host.layout();
    if (!ch?.ready || !l) { this.actions.letGoAll(); return; }
    const box = new T.Box3().setFromObject(p.group);
    const riders: { p: Placed; local: T.Vector3; yaw: number }[] = [];
    const yaw = p.group.rotation.y, toLocal = new T.Matrix4().compose(p.group.position, new T.Quaternion().setFromAxisAngle(UP, yaw), new T.Vector3(1, 1, 1)).invert();
    for (const other of this.host.placed.values()) {
      if (other === p || other.obj.hidden || other.obj.inside || physics.owns(other.obj.id) || affordanceOf(other.obj.kind).mobility !== 'portable') continue;
      const b = new T.Box3().setFromObject(other.group);
      if (b.min.y >= box.min.y + .05 * this.k && b.min.x < box.max.x && b.max.x > box.min.x && b.min.z < box.max.z && b.max.z > box.min.z) riders.push({ p: other, local: other.group.position.clone().applyMatrix4(toLocal), yaw: other.group.rotation.y - yaw });
    }
    if (!physics.beginPush(p, [...this.host.placed.values()], l.room.size, riders.map(r => r.p.obj.id), res.mass)) { this.actions.letGoAll(); return; }
    const grab = ch.root.position.clone().setY(0).applyMatrix4(toLocal);
    this.push = { id: p.obj.id, p, riders, grab, gauge: res.effortless ? null : new EffortGauge(HUMAN.push), res, since: performance.now(), yawTarget: yaw, merge: `push-${p.obj.id}-${Date.now()}`, pulling: false, moving: false, blocked: false, sound: 0, said: false, handF: new T.Vector3(), gripHeight: Math.min(.95, new T.Box3().setFromObject(p.group).max.y / this.k), speedWas: 0, goingWas: new T.Vector3() };
    this.steerIntent = { x: 0, z: 0, running: false };
    if (this.push.gauge) {
      this.meter ??= new EffortMeter();
      if (!this.meter.group.parent) this.host.stage.add(this.meter.group);
      this.meter.show(true, this.vi);
    }
    this.host.changed();
  }
  private get vi() { return this.host.vi?.() ?? true; }
  /** The force the hands bring this frame, from the legs' direction and the strength gathered. */
  private updatePush(dt: number) {
    const ps = this.push, physics = this.physics, ch = this.host.character();
    if (!ps) return;
    if (!physics?.pushing || !ch?.ready || this.host.placed.get(ps.id) !== ps.p) { this.endPush(); return; }
    const pose = physics.pushPose()!;
    const toward = new T.Vector3(pose.x - ch.root.position.x, 0, pose.z - ch.root.position.z);
    if (toward.lengthSq() > 1e-6) toward.normalize();
    const want = new T.Vector3(this.steerIntent.x, 0, this.steerIntent.z), running = this.steerIntent.running;
    this.steerIntent = { x: 0, z: 0, running: false };
    const err = Math.atan2(Math.sin(ps.yawTarget - pose.yaw), Math.cos(ps.yawTarget - pose.yaw)), turning = Math.abs(err) > .01;
    if (ps.gauge) {
      ps.gauge.hold(this.effortKey || running || (this.press?.button === 2 && performance.now() - this.press.at > 220));
      ps.gauge.update(dt);
      // Strength put in with no direction asked (and no turn asked): straight ahead, away from the body.
      if (want.lengthSq() < 1e-4 && ps.gauge.applied > 0 && !turning) want.copy(toward);
    }
    const mag = Math.min(1, want.length());
    if (mag > 0) want.divideScalar(want.length());
    ps.pulling = mag > 0 && want.dot(toward) < -.2;
    const res = slideResistance(ps.p.obj.kind, ps.pulling);
    ps.res = res;
    const force = mag === 0 ? 0 : ps.gauge ? Math.min(ps.gauge.applied, res.human) * mag : Math.min(res.human, res.breakaway + 60 + 8 * res.mass) * mag;
    const turnRate = ps.gauge ? .55 : 1.4;
    // Turning heavy furniture needs the strength to break it free as well: the gauge feeds the turn the same way it feeds a push.
    const turningForce = ps.gauge ? Math.min(ps.gauge.applied, res.human) : res.breakaway + 1;
    const spin = turning && turningForce >= res.breakaway ? T.MathUtils.clamp(err * 3, -turnRate, turnRate) : 0;
    physics.pushWith(want.multiplyScalar(force), spin, res.breakaway, res.sliding, pushSpeed(res.mass) * (running && !ps.gauge ? 1.2 : 1));
    // Without a direction the hands still press on it with what they have gathered.
    ps.handF.copy(want);
    if (ps.gauge && force === 0 && ps.gauge.applied > 0) ps.handF.copy(toward).multiplyScalar(Math.min(ps.gauge.applied, res.human));
    if (this.meter && ps.gauge) this.meter.set(Math.min(ps.gauge.applied, res.human), res.breakaway, HUMAN.push);
  }
  /** After the step: the furniture is drawn where Rapier has it, the riders with it, and the body at its hands. */
  private followPush(dt: number) {
    const ps = this.push, physics = this.physics, ch = this.host.character();
    if (!ps || !physics || !ch?.ready) return;
    const pose = physics.pushPose(), drawn = physics.pushDrawn();
    if (!pose || !drawn) return;
    const fromX = ps.p.group.position.x, fromZ = ps.p.group.position.z;
    // Where the body has to stand to keep its hands where they are: if there is no room for it there, the furniture goes back.
    const at = (x: number, z: number, yaw: number) => ps.grab.clone().applyMatrix4(new T.Matrix4().compose(new T.Vector3(x, 0, z), new T.Quaternion().setFromAxisAngle(UP, yaw), new T.Vector3(1, 1, 1)));
    if (!this.bodyFits(at(pose.x, pose.z, pose.yaw), ps)) physics.pushRevert(); else physics.pushKeep();
    const shown = physics.pushDrawn() ?? drawn;
    // It stopped dead against something: what stands on it does not stop with it. A mug slides, a lamp goes over.
    {
      const speedNow = pose.speed, was = ps.speedWas;
      if (was - speedNow > .4 && ps.riders.length) {
        const going = ps.goingWas.clone();
        for (const r of ps.riders.splice(0)) physics.letRiderGo(r.p.obj.id, going);
      }
      ps.speedWas = speedNow; physics.pushVelocity(ps.goingWas);
    }
    ps.p.group.position.x = shown.x; ps.p.group.position.z = shown.z; ps.p.group.rotation.y = shown.yaw;
    const m = new T.Matrix4().compose(new T.Vector3(shown.x, ps.p.group.position.y, shown.z), new T.Quaternion().setFromAxisAngle(UP, shown.yaw), new T.Vector3(1, 1, 1));
    for (const r of ps.riders) { r.p.group.position.copy(r.local).applyMatrix4(m); r.p.group.rotation.y = shown.yaw + r.yaw; }
    // What it drags over, it ploughs and marks.
    if (CATALOG_BY_ID[ps.p.obj.kind]?.place === 'floor' && Math.hypot(shown.x - fromX, shown.z - fromZ) > .002) { const sz = CATALOG_BY_ID[ps.p.obj.kind]?.size ?? [.5, .5]; this.host.life().dragged({ x: fromX, z: fromZ }, { x: shown.x, z: shown.z }, Math.min(1.6, Math.max(sz[0], sz[1]))); }
    const target = at(shown.x, shown.z, shown.yaw);
    const from = ch.root.position.clone(), moved = Math.hypot(target.x - from.x, target.z - from.z);
    ch.drive(target, moved > .0004, dt, Math.atan2(shown.x - target.x, shown.z - target.z));
    this.host.exploration.speed = moved / Math.max(dt, .001);
    const now = physics.pushPose()!;
    const wasMoving = ps.moving;
    ps.moving = now.moving; ps.blocked = now.blocked;
    if (ps.gauge && now.moving && !wasMoving) { slideSound('runner', .6, .5); contactSound(affordanceOf(ps.p.obj.kind).material, .45, .5); }
    // It scrapes as loud as it goes: what its feet are made of, how fast, how heavy.
    this.scrape ??= new Scrape();
    this.scrape.set(now.moving ? Math.min(1, now.speed / .9) * (.45 + Math.min(.55, ps.res.mass / 90)) : 0, feetOf(ps.p.obj.kind));
    if (now.blocked && !ps.said) { ps.said = true; this.host.say('Bị vướng: tường hoặc đồ đạc khác đang chắn.', 'It is stuck against a wall or other furniture.'); }
    if (!now.blocked) ps.said = false;
    if (this.meter && ps.gauge) {
      const box = new T.Box3().setFromObject(ps.p.group), stageTop = this.toStage(new T.Vector3(0, box.max.y, 0)).y;
      const right = new T.Vector3().crossVectors(this.host.exploration.camera.getWorldDirection(new T.Vector3()), UP).normalize();
      const size = CATALOG_BY_ID[ps.p.obj.kind]?.size ?? [.6, .6];
      const reach = Math.hypot(size[0], size[1]) * ps.p.obj.scale * .5 + .2;
      this.meterAnchor.set(shown.x, Math.min(stageTop, 1.6) + .28, shown.z).addScaledVector(right, reach);
      this.meter.update(dt, this.meterAnchor, this.host.exploration.camera, 1, this.host.reduced());
    }
  }
  /** Room for the body beside the furniture: inside the room, clear of every other piece (the one in the hands excepted). */
  private bodyFits(p: T.Vector3, ps: NonNullable<Manipulator['push']>) {
    const nav = this.host.navigation();
    if (!nav) return true;
    if (Math.abs(p.x) > nav.half || Math.abs(p.z) > nav.half) return false;
    const own = ps.p.obj.pos;
    for (const o of nav.obstacles) {
      if (Math.hypot(o.x - own[0], o.z - own[2]) < .01) continue;
      const dx = p.x - o.x, dz = p.z - o.z, c = Math.cos(o.rotation), s = Math.sin(o.rotation);
      if (Math.abs(c * dx - s * dz) < o.width / 2 + nav.radius * .8 && Math.abs(s * dx + c * dz) < o.depth / 2 + nav.radius * .8) return false;
    }
    return true;
  }
  /** Hands off: it stands where it came to rest; that place, and its riders', go to the layout. */
  private endPush() {
    const ps = this.push;
    if (!ps) return;
    this.push = null;
    this.scrape?.set(0, 'wood-legs');
    this.meter?.show(false);
    const l = this.host.layout();
    const pose = this.physics?.pushPose();
    const p = ps.p;
    if (pose) {
      p.group.position.x = pose.x; p.group.position.z = pose.z; p.group.rotation.set(0, pose.yaw, 0);
      const m = new T.Matrix4().compose(new T.Vector3(pose.x, p.group.position.y, pose.z), new T.Quaternion().setFromAxisAngle(UP, pose.yaw), new T.Vector3(1, 1, 1));
      for (const r of ps.riders) { r.p.group.position.copy(r.local).applyMatrix4(m); r.p.group.rotation.y = pose.yaw + r.yaw; }
    }
    // The room's colliders are rebuilt with the furniture where it now stands.
    this.physics?.endPush([...this.host.placed.values()], l?.room.size);
    this.actions.letGoAll();
    if (this.host.placed.get(ps.id) === p) {
      this.host.objectState(ps.id, { pos: [p.group.position.x, p.group.position.y, p.group.position.z], rotY: p.group.rotation.y, quat: undefined }, ps.merge);
      this.host.life().moved(ps.id);
      for (const r of ps.riders) if (this.host.placed.get(r.p.obj.id) === r.p) this.host.objectState(r.p.obj.id, { pos: [r.p.group.position.x, r.p.group.position.y, r.p.group.position.z], rotY: r.p.group.rotation.y }, ps.merge);
      this.host.bodyMoved();
    }
    slideSound('runner', .3, .5);
    this.host.changed();
  }
  /** The legs while furniture is in the hands are judged by `bodyFits`; otherwise the room's own navigation. */
  navigationFor(nav: RoomNavigation | null): Pick<RoomNavigation, 'free' | 'half'> | null { return nav; }
  /** Carrying in both arms slows the walk a little. */
  get speedFactor() {
    if (this.work.active && this.work.pressing) return .62;
    const load = this.bodyLoad;
    if (load) return Math.max(.6, 1 - (load.kg - 2) * .035);
    if (!this.twoHanded.size) return 1;
    let mass = 0;
    for (const id of this.twoHanded) mass += affordanceOf(this.host.placed.get(id)?.obj.kind ?? '').mass;
    return Math.max(.62, .94 - mass * .018);
  }
  get pushingNow() { return !!this.push; }

  // ── Drawers, doors, windows, curtains ───────────────────────────────────────────────────────────────
  private startPull() {
    const id = this.targetId;
    if (!id?.startsWith('drawer:') || this.busyHands() || this.carrying) return false;
    if (!this.host.exploration.locked) return false;
    const [, o, i] = id.split(':');
    this.useDrawer(o, Number(i), true);
    return true;
  }
  private endPull(held: number) {
    const d = this.drawer;
    if (!d) return;
    d.pulling = false;
    // A click, not a drag: it opens or closes the whole way.
    if (held < 260 && Math.abs(d.manual) < .03) d.to = d.from > .5 ? 0 : 1;
    else d.to = T.MathUtils.clamp(d.from + d.manual / Math.max(.05, d.slider.travel), 0, 1);
    d.done = true;
  }
  private openClose(id: string, open: boolean) {
    if (id === 'window:main') { this.useWindow(); return; }
    if (id === 'curtain:main') { this.useCurtain(open); return; }
    if (id.startsWith('portal:')) { this.useDoor(id.slice(7) as WorldDestination, open); return; }
    if (id.startsWith('life:')) { this.useDoor(id, open); return; }
    if (id.startsWith('drawer:')) { const [, o, i] = id.split(':'); this.useDrawer(o, Number(i), false); }
  }
  private useWindow() {
    const room = this.host.room(), ch = this.host.character(), layout = this.host.layout();
    if (!room || !ch || !layout?.room.wallRight) return;
    const handle = new T.Vector3(), near = ch.root.getWorldPosition(new T.Vector3());
    if (!room.windowHandle(handle, near.x)) return;
    const open = !layout.room.windowOpen;
    this.touch(() => this.toStage(handle), () => { room.windowHandle(handle, near.x); return handle; }, 'push', 'pinch', .5, () => this.host.window(open), 'metal');
  }
  private useCurtain(open: boolean) {
    const room = this.host.room(), ch = this.host.character();
    if (!room || !ch) return;
    const at = new T.Vector3(), near = ch.root.getWorldPosition(new T.Vector3());
    if (!room.curtainEdge(at, near.x)) return;
    let from = this.host.layout()?.room.curtains ?? 0, to = open ? 0 : 1;
    if (Math.abs(from - to) < .1) { from = to; to = open ? 1 : 0; }
    const side = this.handFor(at);
    const run = (approach: boolean) => this.actions.start({
      side, approach: approach ? { point: this.toStage(at), stop: .55 } : undefined, reach: .5, operate: .85, release: .34,
      contact: () => { room.curtainEdge(at, near.x); return this.grip(at, side, 'pinch', 'push'); },
      onContact: () => slideSound('runner', .3, .5),
      onOperate: k => room.setCurtains(from + (to - from) * k * k * (3 - 2 * k)),
      onOperated: () => this.host.curtains(to),
      onCancel: () => room.setCurtains(from),
    });
    const a = this.approachFor(this.toStage(at), .55, () => run(false));
    if (a) run(true);
  }
  private useDrawer(objectId: string, index: number, pulling: boolean) {
    const p = this.host.placed.get(objectId), slider = (p?.group.userData.sliders as Slider[] | undefined)?.[index];
    if (!p || !slider) return;
    if (this.hands().free === 0) { this.host.say('Hai tay đang bận.', 'Both hands are full.'); return; }
    const handle = new T.Vector3();
    const world = () => p.group.localToWorld(handle.copy(slider.handle).addScaledVector(slider.axis, slider.travel * slider.open));
    const from = slider.open;
    const d = { p, slider, mech: null as Mechanism | null, limit: 1, from, to: from > .5 ? 0 : 1, pulling, manual: 0, done: !pulling, t: 0 };
    d.limit = this.drawerRoom(p, slider);
    const run = (near: boolean) => {
      this.drawer = d;
      const side = this.handFor(world());
      void this.ensurePhysics();
      this.actions.start({
        side, approach: near ? undefined : { point: this.toStage(world()), stop: .56 },
        reach: .48, operate: 3, release: .34,
        contact: () => this.grip(world(), side, 'handle', 'over'),
        onContact: () => { contactSound('wood', .32, .5); slideSound('runner', .5, .5); },
        until: () => {
          if (!d.done) return false;
          const delta = Math.abs(slider.open - Math.min(d.to, d.limit));
          return delta < .012 || d.t > 1.1;
        },
        onOperate: () => undefined,
        onOperated: () => {
          this.settleDrawer(d);
          contactSound('wood', d.to ? .45 : .7, .5);
        },
        onCancel: () => this.settleDrawer(d),
      });
      this.host.wake();
    };
    const a = this.approachFor(this.toStage(world()), .56, () => run(true));
    if (a) run(false);
  }
  /** How far it can come out before it meets another piece of furniture. */
  private drawerRoom(p: Placed, slider: Slider) {
    const origin = p.group.localToWorld(slider.handle.clone());
    const dir = slider.axis.clone().applyQuaternion(p.group.getWorldQuaternion(new T.Quaternion()));
    const ray = new T.Ray(origin, dir), hit = new T.Vector3();
    let room = slider.travel * p.obj.scale * this.k;
    const box = new T.Box3();
    for (const other of this.host.placed.values()) {
      if (other === p || other.obj.hidden || CATALOG_BY_ID[other.obj.kind]?.place !== 'floor' || CATALOG_BY_ID[other.obj.kind]?.flat) continue;
      box.setFromObject(other.group);
      if (ray.intersectBox(box, hit)) room = Math.min(room, Math.max(0, hit.distanceTo(origin) - .015));
    }
    return room / (slider.travel * p.obj.scale * this.k);
  }
  private settleDrawer(d: NonNullable<Manipulator['drawer']>) {
    d.mech?.dispose(); d.mech = null;
    if (this.drawer === d) this.drawer = null;
    const list = (d.p.group.userData.sliders as Slider[]).map(s => +s.open.toFixed(3));
    this.host.objectState(d.p.obj.id, { drawers: list.some(Boolean) ? list : undefined }, 'drawer');
  }
  private updateDrawer(dt: number) {
    const d = this.drawer;
    if (!d) return;
    const { slider, p } = d;
    const target = d.done ? Math.min(d.to, d.limit) : T.MathUtils.clamp(d.from + d.manual / Math.max(.05, slider.travel), 0, d.limit);
    const physics = this.physics;
    const contacted = this.actions.current && (this.host.character()?.rig?.contactProgress(this.actions.current.side ?? 1) ?? 0) > .95;
    if (!contacted) return;
    d.t += d.done ? dt : 0;
    if (physics && !d.mech) {
      const travel = slider.travel * p.obj.scale;
      const closed = p.group.position.clone().add(slider.handle.clone().multiplyScalar(p.obj.scale).applyQuaternion(p.group.quaternion));
      const axis = slider.axis.clone().applyQuaternion(p.group.quaternion).normalize();
      d.mech = physics.slider(closed, axis, travel, [.12 * p.obj.scale, .05 * p.obj.scale, .012 * p.obj.scale], 1.6, slider.open);
    }
    if (d.mech) {
      const travel = slider.travel * p.obj.scale;
      d.mech.drive(target * travel);
      slider.open = T.MathUtils.clamp(d.mech.value() / travel, 0, 1);
    } else slider.open += (target - slider.open) * (1 - Math.exp(-7 * dt));
    slider.node.position.copy(slider.axis).multiplyScalar(slider.travel * slider.open);
  }

  private lifeDoorReach: { id: string; side: number; elapsed: number; duration: number } | null = null;
  private readonly doorHandleScratch = new T.Vector3();
  private readonly doorStageScratch = new T.Vector3();

  /** The leaf on its hinge, the hand on the lever. */
  private useDoor(id: WorldDestination | string, open: boolean, then?: () => void) {
    const door = this.doorOf(id);
    if (!door) { then?.(); return; }
    const now = performance.now();
    if ((this.doorCooldown.get(id) ?? 0) > now) return;
    this.doorCooldown.set(id, now + 260);
    const handle = this.doorHandleScratch;
    door.handleWorld(handle);
    const ch0 = this.host.character();

    // Frictionless non-blocking Echo Life doors (`life:*`): unlatch at t = 0 with zero `moveRoot` teleport
    // and track live `door.handleWorld` via upper-body `HumanRig.setContact` (`legsTaken === false`)!
    if (typeof id === 'string' && id.startsWith('life:')) {
      if (this.lifeDoorReach) {
        const prevDoor = this.doorOf(this.lifeDoorReach.id);
        prevDoor?.press(0);
        if (this.lifeDoorReach.side !== 0 && !this.physics?.heldIn(this.lifeDoorReach.side)) {
          ch0?.rig?.setContact(this.lifeDoorReach.side, null, 0.16);
        }
        this.lifeDoorReach = null;
      }
      if ('prepare' in door && open && ch0) (door as LifeDoorLike).prepare(ch0.root.position);
      door.setAngle(null);
      door.setOpen(open);
      contactSound('metal', 0.52, 0.5);
      door.press(1);
      slideSound('hinge', 1.05, 0.65);

      const hFree = this.hands();
      let reachSide = 0;
      if (hFree.free > 0 && ch0?.rig?.ready) {
        const stageHandle = this.toStage(handle);
        const dist = Math.hypot(stageHandle.x - ch0.root.position.x, stageHandle.z - ch0.root.position.z);
        if (dist <= 1.35) {
          reachSide = this.handFor(handle);
          if (this.physics?.heldIn(reachSide)) reachSide = -reachSide;
          if (this.physics?.heldIn(reachSide)) reachSide = 0;
          if (reachSide !== 0) {
            ch0.rig.setContact(reachSide, this.grip(door.handleWorld(handle), reachSide, 'handle', 'over'), 0.16);
          }
        }
      }
      this.lifeDoorReach = { id, side: reachSide, elapsed: 0, duration: reachSide !== 0 ? 0.58 : 0.24 };
      then?.();
      this.host.changed();
      this.host.wake();
      return;
    }

    let active = true;
    const sequence = ++this.doorSequence;
    let done = false;
    // Study portal doors (`arena` / `games` journeys): unlatch without root teleport while keeping the scripted journey step.
    if ('prepare' in door && open && ch0) (door as LifeDoorLike).prepare(ch0.root.position);
    const own = 'hinge' in door ? (door as LifeDoorLike).hinge() : null;
    const target = open ? own?.open ?? -1.05 : 0;
    const side = this.hands().right ? -1 : 1;
    let approachPoint = this.toStage(handle);
    let approachStop = .58;
    const dp = 'plan' in door ? (door as LifeDoorLike).plan : undefined;
    if (!open && dp && ch0) {
      const nx = dp.wallAlong === 'z' ? 1 : 0, nz = dp.wallAlong === 'z' ? 0 : 1;
      const bodySide = (ch0.root.position.x - dp.x) * nx + (ch0.root.position.z - dp.z) * nz;
      const handleSide = (approachPoint.x - dp.x) * nx + (approachPoint.z - dp.z) * nz;
      if (bodySide * handleSide < 0 || Math.abs(bodySide) < .46) {
        const sgn = bodySide >= 0 ? 1 : -1;
        approachPoint = new T.Vector3(dp.x + nx * sgn * .62, dp.y, dp.z + nz * sgn * .62);
        approachStop = .32;
      }
    }
    this.actions.start({
      side, approach: { point: approachPoint, stop: approachStop },
      reach: .46, operate: 2.2, release: .3,
      contact: () => this.grip(door.handleWorld(handle), side, 'handle', 'over'),
      onContact: () => {
        contactSound('metal', .55, .5); door.press(1); slideSound('hinge', 1.05, .7);
        door.setOpen(open);
        void this.ensurePhysics().then(physics => {
          if (!active || sequence !== this.doorSequence) return;
          const layout = this.host.layout();
          if (!physics || !layout) { door.setOpen(open); return; }
          // The hinge in the room's own coordinates: where gateways.ts puts the pivot.
          const half = layout.room.size / 2, at = own?.at ?? new T.Vector3((door.x ?? 0) - .49, 1.16, half + .03);
          // What stands in the way of the leaf is moved by the leaf.
          physics.wakeWithin(at, 1.05);
          const mech = own ? physics.hinge(own.at, UP, own.leaf, own.half, own.limits, 14, door.angle) : physics.hinge(at, UP, new T.Vector3(.47, 0, 0), [.47, 1.14, .028], [-1.05, 0], 14, door.angle);
          this.doorMech = { id, mech, target, t: 0 };
        });
      },
      until: () => { if (!done && this.doorMech?.id === id && Math.abs(door.angle - target) < .06) done = true; return done || (!this.doorMech && Math.abs(door.angle - target) < .06); },
      onOperated: () => { active = false; door.press(0); this.endDoor(); door.setOpen(done ? open : door.isOpen); then?.(); },
      onCancel: () => { active = false; door.press(0); this.endDoor(); door.setOpen(door.isOpen); },
    });
    this.host.wake();
  }
  private endDoor() {
    const m = this.doorMech;
    if (!m) return;
    m.mech.dispose();
    this.doorMech = null;
  }
  private updateDoor(dt: number) {
    // 1. Update non-blocking Echo Life upper-body door lever reach (`legsTaken === false`).
    const reach = this.lifeDoorReach;
    if (reach) {
      reach.elapsed += dt;
      const door = this.doorOf(reach.id);
      const ch = this.host.character();
      let keepReach = !!door && reach.elapsed < reach.duration;
      if (keepReach && door && ch?.ready) {
        door.handleWorld(this.doorHandleScratch);
        this.doorStageScratch.copy(this.doorHandleScratch);
        this.host.stage.worldToLocal(this.doorStageScratch);
        const dist = Math.hypot(
          this.doorStageScratch.x - ch.root.position.x,
          this.doorStageScratch.z - ch.root.position.z,
        );
        if (dist > 1.24) {
          keepReach = false;
        } else {
          const leverK = reach.elapsed < 0.34 ? 1 : Math.max(0, 1 - (reach.elapsed - 0.34) / 0.24);
          door.press(leverK);
          if (reach.side !== 0 && ch.rig?.ready && !this.physics?.heldIn(reach.side)) {
            ch.rig.setContact(
              reach.side,
              this.grip(door.handleWorld(this.doorHandleScratch), reach.side, 'handle', 'over'),
              0.08,
            );
          }
        }
      }
      if (!keepReach) {
        door?.press(0);
        if (reach.side !== 0 && !this.physics?.heldIn(reach.side)) {
          ch?.rig?.setContact(reach.side, null, 0.22);
        }
        this.lifeDoorReach = null;
      }
    }

    // 2. Sync per-door dynamic Rapier colliders (`setEnabled(!isOpenEnough)` + swung leaf yaw).
    const physics = this.physics;
    const lifeDoors = this.host.lifeDoors?.();
    if (physics && lifeDoors) {
      for (let i = 0; i < lifeDoors.length; i++) {
        const ld = lifeDoors[i];
        const dp = ld.plan;
        if (!dp) continue;
        const hg = ld.hinge();
        const baseYaw = Math.atan2(hg.leaf.z, hg.leaf.x);
        physics.syncDoorCollider(dp.id, {
          hingeX: hg.at.x,
          hingeZ: hg.at.z,
          floorY: dp.y,
          width: dp.width,
          height: dp.height,
          worldLeafYaw: baseYaw - ld.angle,
          swingAngle: ld.angle,
          isOpen: Boolean(ld.passable || (ld.phase && ld.phase !== 'closed') || ld.isOpen),
        });
      }
    }

    const m = this.doorMech;
    if (!m) return;
    const door = this.doorOf(m.id);
    if (!door) { this.endDoor(); return; }
    m.t += dt;
    m.mech.drive(m.target);
    door.setAngle(m.mech.value());
    // Something is holding it: give up and release physical lock cleanly so the door never freezes half-open.
    if (m.t > 2.4) { door.press(0); this.endDoor(); door.setOpen(Math.abs(door.angle) > .45); }
  }

  // ── Going somewhere on foot ─────────────────────────────────────────────────────────────────────────
  /**
   * Stands up if sitting, walks round whatever is in the way to the right door, opens it with a hand and walks through; only then does
   * `onThrough` change the page. Any movement key on the way cancels it. A room with no door, or no way to it, says so and offers the plain link.
   */
  journey(destination: WorldDestination, onThrough: () => void, onBlocked: () => void) {
    const room = this.host.room(), door = room?.door(destination), layout = this.host.layout(), ch = this.host.character();
    const ex = this.host.exploration;
    if (!room || !door || !layout?.room.visible || !layout.room.wallRight || !ch?.ready || !layout.character.visible || this.host.reduced()) { onBlocked(); return; }
    if (!ex.active) ex.setView('third');
    this.setInspecting(false);
    this.journeyTo = destination;
    const half = layout.room.size / 2;
    const landing = new T.Vector3(door.x, 0, half - .75);
    const threshold = new T.Vector3(door.x, 0, half + .55);
    const nav = this.host.navigation();
    const steps = [
      { name: 'stand', start: () => { if (ch.body.seat || ch.body.occupied) this.host.standUp(); }, tick: () => ch.standing },
      { name: 'walk', tick: (dt: number) => {
        // Already at the door: no walking back to the mat to start again.
        const at = ch.root.position;
        if (Math.abs(at.x - door.x) < .62 && at.z > half - 1.15) return true;
        const r = ex.walkToward(landing, .3, dt);
        return r === null ? null : r;
      } },
      { name: 'door', start: () => { if (!door.isOpen) this.useDoor(destination, true); }, tick: () => !this.actions.busy && door.isOpen },
      { name: 'through', start: () => { this.host.bodyMoved(); ex.setPassing(true); this.passing = { to: threshold, onThrough }; }, tick: () => !this.passing },
    ];
    void nav;
    this.plan.run(destination, steps, () => { this.journeyTo = null; this.host.say('Lối đi tới cửa đang bị chặn.', 'The way to the door is blocked.'); onBlocked(); this.host.changed(); });
    this.host.changed(); this.host.wake();
  }
  /** A door that stands open is a way out: walking into it is the same journey as asking for it. */
  private walkIntoDoorway(ch: Character | null | undefined) {
    if (!this.journeyTo) this.walkedIn = false;
    const room = this.host.room(), layout = this.host.layout(), ex = this.host.exploration;
    const z = ch?.root.position.z ?? null, last = this.lastDoorZ;
    this.lastDoorZ = z;
    if (!ch?.ready || !room || !layout?.room.wallRight || !ex.active || z == null || last == null) return;
    if (this.journeyTo || this.plan.active || this.actions.busy || !ch.standing || !ex.isMoving || z <= last) return;
    const half = layout.room.size / 2;
    if (z < half - .62) return;
    for (const dest of ['arena', 'games'] as WorldDestination[]) {
      const door = room.door(dest);
      if (!door?.isOpen || Math.abs(ch.root.position.x - door.x) > .44) continue;
      this.walkedIn = true;
      this.host.portal(dest);
      return;
    }
  }
  /** Coming back: the door stands open behind the body, it walks in, the door closes after it. */
  arrive(from: WorldDestination) {
    const room = this.host.room(), door = room?.door(from), layout = this.host.layout(), ch = this.host.character();
    if (!door || !layout?.room.wallRight || !ch?.ready || this.host.reduced()) return;
    const half = layout.room.size / 2, ex = this.host.exploration;
    if (!ex.active) return;
    door.setAngle(-1.05);
    ch.resetPose(new T.Vector3(door.x, 0, half + .45), Math.PI);
    ex.setPassing(true);
    ex.yaw = 0;
    const inside = new T.Vector3(door.x, 0, half - .85);
    this.plan.run('arrive', [
      { name: 'in', tick: dt => { const r = ex.walkStraight(inside, dt); return r; } },
      { name: 'close', start: () => { ex.setPassing(false); this.useDoor(from, false); }, tick: () => !this.actions.busy },
    ]);
  }

  // ── The world each frame ────────────────────────────────────────────────────────────────────────────
  update(dt: number) {
    const ch = this.host.character(), physics = this.physics, ex = this.host.exploration;
    this.frameCount++;
    // The thing was let go some other way while it was on its way down: there is nothing left to set down.
    if (this.placing && physics?.heldIn(this.placing.side) !== this.placing.id) this.cancelPlacement('failed');
    this.plan.update(dt);
    const path = this.placing?.rackPath;
    const footShift = path?.footShift ?? this.placing?.footShift;
    if (footShift && ch?.ready) {
      const from = ch.root.position, shift = footShift.clampLength(0, .12 * dt);
      if (path) path.footShift = undefined;
      if (this.placing) this.placing.footShift = undefined;
      const to = from.clone().add(shift);
      const inside = !path && this.placing?.footprint?.(to);
      const fraction = inside ? 0 : (this.host.walkable?.() ?? this.host.navigation())?.motionFraction(from, to) ?? 0;
      if (fraction > 0 && ch.driveReady()) ch.drive(from.clone().lerp(to, fraction), true, dt, ch.root.rotation.y);
    }
    // The tool is drawn where it is this frame before the hands are told where to be: they close on what is seen.
    if (this.work.active) {
      if (physics?.heldIds.includes(this.work.active.p.obj.id)) this.work.update(dt, this.aimRay());
      else this.work.end();
    }
    // A pause in the strokes is still work; a longer one, or setting off to walk, is not: the tool comes back up into
    // its carry (upright beside the body) instead of the body walking about bent over a broom on the floor.
    const tool = this.work.active;
    if (tool && !this.work.pressing && !this.toolExtraction && !this.inputBusy && !this.placing && !this.careVerb(0)) {
      this.idleWork += dt;
      // Done after the arms are solved this frame (`afterBody`): the carry takes the grip the hand really has.
      this.backToCarry = this.idleWork > 1.2 || ex.isMoving ? tool.side : null;
    } else { this.idleWork = 0; this.backToCarry = null; }
    this.updateCare(dt);
    this.actions.update(dt);
    this.walkIntoDoorway(ch);
    if (this.passing) {
      if (ex.walkStraight(this.passing.to, dt)) { const go = this.passing.onThrough; this.passing = null; this.journeyTo = null; go(); }
    }
    // The engine starts with the room, not with the first click: by the time a hand reaches for something it is there.
    if (!this.physics && !this.loading && this.physicsState === 'idle' && this.host.layout()) void this.ensurePhysics();
    if (this.pendingLift) {
      const p = this.host.placed.get(this.pendingLift.id);
      if (p) { this.pendingLift = null; void this.ensurePhysics().then(ph => { if (ph) this.liftNow(ph, p, true); }); }
    }
    // A click made while the body was busy is done now, in order (after 2.5 s it is stale and dropped).
    if (this.queue.length && !this.inputBusy && ex.acceptingInput) {
      const q = this.queue[0], stale = performance.now() - q.at > 3000;
      // A click waits until there is something for it: a thing under the eyes, or something in the hands. Never spent on nothing.
      if (stale || this.targetId || this.carrying) { this.queue.shift(); if (!stale) this.click(q.button); this.host.changed(); }
    }
    if (!this.carrying && this.gizmoActive) this.setGizmoActive(false);
    if (this.turnHeld && this.carrying) {
      this.turnHeld.wait -= dt;
      if (this.turnHeld.wait <= 0) {
        if (this.shiftDown) {
          this.turnHeld.wait = .14;
          this.rotateHeld3D(this.turnHeld.dir * (Math.PI / 12), true);
        } else {
          this.turnHeld.wait = .016;
          this.rotateHeld3D(this.turnHeld.dir * dt * 2.4, false);
        }
      }
    }
    if (this.push && (!ex.active || !ch?.ready || ch.body.seat)) this.endPush();
    if (this.press?.button === 2 && this.push?.gauge && performance.now() - this.press.at > 220) this.push.gauge.hold(true);
    this.updateDrawer(dt);
    this.updateDoor(dt);
    if (physics) {
      const suppressActor =
        !ch?.ready ||
        Boolean(this.push) ||
        Boolean(ch.body.seat) ||
        ch.body.state === 'seated' ||
        ch.posture === 'lying' ||
        ch.posture === 'rising' ||
        Boolean(ch.isApproachingSeat) ||
        Boolean(ch.isDismountingSeat);
      physics.setActorEnabled(!suppressActor);
      if (!suppressActor && ch) {
        physics.actorAt(ch.root.position.x, ch.root.position.z, CROUCH.eye * ex.crouchAmount, ch.root.position.y);
      }
      if (this.frameCount % 2 === 0 && ex.active && !this.placing && !this.gizmo?.dragging) this.findPlace();
      this.updatePush(dt);
      this.pendingPhysics = dt;
      if (!ch?.rig?.ready) this.resolveContacts();
    }
    this.kickWhatIsUnderfoot();
    this.showPlacement(dt);
    this.updateStationBoard(dt);
    // Let go: the meter fades where it stood, it is not left hanging in the room.
    if (this.meter?.visible && !this.push?.gauge) this.meter.update(dt, this.meterAnchor, this.host.exploration.camera, 1, this.host.reduced());
    if (this.drinking) {
      this.drinking.t += dt;
      // The head comes up to drink: the eyes go to the level with it.
      { const ex = this.host.exploration, want = T.MathUtils.clamp(ex.pitch, -.04, .16); ex.pitch += (want - ex.pitch) * (1 - Math.exp(-8 * dt)); }
      if (this.drinking.t > 1.5) {
        const side = this.drinking.side, id = physics?.heldIn(side), p = id ? this.host.placed.get(id) : null;
        this.drinking = null;
        physics?.holdRotation(side, null);
        if (p) this.host.objectState(p.obj.id, { state: withLevel(p.obj.kind, p.obj.state, levelOf(p.obj.kind, p.obj.state) - .25) }, 'mug');
        this.host.changed();
      }
    }
    this.book?.open.update(dt, this.host.reduced());
    // Whatever it was fed last: the prompt shows real page numbers.
    if (this.book && this.frameCount % 20 === 0) this.host.changed();
    this.animate(dt);
    const heldIds = this.physics?.heldIds;
    const heldLen = heldIds?.length ?? 0;
    const held0 = heldIds?.[0];
    const held1 = heldIds?.[1];
    const held0Obj = held0 ? this.host.placed.get(held0)?.obj : null;
    const isNonToolCarry = Boolean(heldLen && held0Obj && !toolOf(held0Obj.kind) && !this.book);
    const rotAxisNow = isNonToolCarry ? this.rotAxis : null;
    const canResetUprightNow = this.computeCanResetUpright();
    const gizmoActiveNow = isNonToolCarry ? this.gizmoActive : false;
    const hasBook = !!this.book;
    const pushId = this.push?.id;
    const pushMoving = !!this.push?.moving;
    const pushBlocked = !!this.push?.blocked;
    const pushPulling = !!this.push?.pulling;
    const planStep = this.plan.step;
    const hasPlaceAim = !!this.placeAim;
    const placeReasonEn = this.placeReason?.en;
    const hasPlaceStore = !!this.placeStore;
    const actionsBusy = this.actions.busy;
    const queueLen = this.queue.length;
    const hasPlacing = !!this.placing;
    const hasToolExtraction = !!this.toolExtraction;
    const hasWorkActive = !!this.work.active;
    let snap = this.lastSnap;
    if (!snap) {
      snap = this.lastSnap = {
        initialized: false, targetId: null, heldLen: -1, held0: undefined, held1: undefined,
        inspecting: false, hasBook: false, pushId: undefined, pushMoving: false, pushBlocked: false,
        pushPulling: false, journeyTo: null, planStep: null, hasPlaceAim: false, placeOk: false,
        placeReasonEn: undefined, hasPlaceStore: false, actionsBusy: false, physicsState: 'idle',
        queueLen: -1, hasPlacing: false, hasToolExtraction: false, hasWorkActive: false,
        rotAxis: null, canResetUpright: false, gizmoActive: false,
      };
    }
    const dirty =
      !snap.initialized ||
      snap.targetId !== this.targetId ||
      snap.heldLen !== heldLen ||
      snap.held0 !== held0 ||
      snap.held1 !== held1 ||
      snap.inspecting !== this.inspecting ||
      snap.hasBook !== hasBook ||
      snap.pushId !== pushId ||
      snap.pushMoving !== pushMoving ||
      snap.pushBlocked !== pushBlocked ||
      snap.pushPulling !== pushPulling ||
      snap.journeyTo !== this.journeyTo ||
      snap.planStep !== planStep ||
      snap.hasPlaceAim !== hasPlaceAim ||
      snap.placeOk !== this.placeOk ||
      snap.placeReasonEn !== placeReasonEn ||
      snap.hasPlaceStore !== hasPlaceStore ||
      snap.actionsBusy !== actionsBusy ||
      snap.physicsState !== this.physicsState ||
      snap.queueLen !== queueLen ||
      snap.hasPlacing !== hasPlacing ||
      snap.hasToolExtraction !== hasToolExtraction ||
      snap.hasWorkActive !== hasWorkActive ||
      snap.rotAxis !== rotAxisNow ||
      snap.canResetUpright !== canResetUprightNow ||
      snap.gizmoActive !== gizmoActiveNow;
    if (dirty) {
      snap.initialized = true;
      snap.targetId = this.targetId;
      snap.heldLen = heldLen;
      snap.held0 = held0;
      snap.held1 = held1;
      snap.inspecting = this.inspecting;
      snap.hasBook = hasBook;
      snap.pushId = pushId;
      snap.pushMoving = pushMoving;
      snap.pushBlocked = pushBlocked;
      snap.pushPulling = pushPulling;
      snap.journeyTo = this.journeyTo;
      snap.planStep = planStep;
      snap.hasPlaceAim = hasPlaceAim;
      snap.placeOk = this.placeOk;
      snap.placeReasonEn = placeReasonEn;
      snap.hasPlaceStore = hasPlaceStore;
      snap.actionsBusy = actionsBusy;
      snap.physicsState = this.physicsState;
      snap.queueLen = queueLen;
      snap.hasPlacing = hasPlacing;
      snap.hasToolExtraction = hasToolExtraction;
      snap.hasWorkActive = hasWorkActive;
      snap.rotAxis = rotAxisNow;
      snap.canResetUpright = canResetUprightNow;
      snap.gizmoActive = gizmoActiveNow;
      this.host.changed();
    }
  }

  /** Plan every held trajectory from the finalized shoulders, once per frame.
   * Acquisition clearance and lowering use this same order as steady carrying.
   * Skipping this step while lifting left targets based on the previous torso.
   */
  private updateHeldTargets(physics: StudyPhysics, dt: number) {
    const ch = this.host.character(), ex = this.host.exploration;
    const intent = this.carryIntent;
    this.carryIntent = null;
    this.carryGoals.clear();
    if (this.fillHeading && (physics.sideOf(this.fillHeading.id) === null || this.placing || this.pouring ||
        (!this.carryAt && !this.liftingOff.has(this.fillHeading.id)))) this.fillHeading = null;
    const half = (this.host.layout()?.room.size ?? 6) / 2 - .05;
    for (const side of [1, -1]) {
      const id = physics.heldIn(side), p = id ? this.host.placed.get(id) : null;
      if (!id || !p) continue;
      const hangingVessel = p.obj.kind === 'kettle.vintage' || p.obj.kind === 'can.watering';
      if (this.work.active?.p === p) continue;
      if (this.placing?.side === side && this.placing.rackPath) { this.updateRackPlacement(p, dt); continue; }
      let destination: T.Vector3;
      let transitionRotation: T.Quaternion | null = null, liftRotation: T.Quaternion | null = null;
      if (this.placing?.side === side) {
        destination = this.placing.to.clone();
        physics.holdRotation(side, this.placing.q);
        this.placing.left -= dt;
        this.placing.validatedElapsed = (this.placing.validatedElapsed ?? 0) + dt;
        transitionRotation = physics.poseAt(id, destination, this.placing.q)?.quaternion ?? null;
        if (this.placing.left <= 0) {
          this.cancelPlacement('failed');
          this.host.say('Chưa thể đặt vật ở đây. Vật vẫn ở trong tay.', 'Cannot reach this placement. The object is still held.');
          this.host.changed();
          continue;
        }
      } else {
        // Up from the floor and standing, a long tool is taken properly in the hand: the grip made on a shaft lying on
        // the floor (palm over it) slides and turns, in sight, into the grip people hold an upright broom with. Kept as
        // it was taken, the wrist could not lean the shaft for a stroke and the body folded over to sweep.
        const spec = toolOf(p.obj.kind);
        const perHandRegrips = (this.regrips ??= new Map()).get(id);
        if (perHandRegrips?.size) {
          for (const [handSide, regrip] of perHandRegrips) {
            if (regrip.done) continue;
            regrip.t = Math.min(1, regrip.t + dt / (this.host.reduced() ? .01 : regrip.duration));
            const e = regrip.t * regrip.t * (3 - 2 * regrip.t);
            regrip.from.decompose(_mV1, _mQ1, _mV3);
            regrip.to.decompose(_mV2, _mQ2, _mV3);
            regrip.anchor.setLocal(_mM1.compose(_mV1.lerp(_mV2, e), _mQ1.slerp(_mQ2, e), _mV3.set(1, 1, 1)));
            if (regrip.t >= 1) {
              regrip.done = true;
              ch?.rig?.refit(handSide);
            } else {
              ch?.rig?.holdFit?.(handSide);
            }
          }
        } else if (!perHandRegrips && spec && spec.length > .9 && this.toolCarryFrames.get(id)?.equipAfterLift && !this.intoHands && (this.grasps.get(id)?.size ?? 0) === 1) {
          const bend = ch?.rig?.bendNow, gripPose0 = this.handCarryPose(side, p), anchor = this.grasps.get(id)?.get(side);
          if (bend && bend.drop < .04 * this.k && bend.pitch < .1 && anchor && gripPose0 && p.group.quaternion.angleTo(gripPose0.rotation) < .1) {
            const fresh = new GraspFrame(p.group, this.work.gripWorld(p, spec, 1, side, true));
            this.regrips.set(id, new Map([[side, { anchor, from: anchor.local.clone(), to: fresh.local.clone(), t: 0, duration: .35, done: false }]]));
          }
        }
        // Lifting and standing recover at different rates: a completed lift
        // must not discard the pending handoff while the knees are rising.
        if (this.toolCarryFrames.get(id)?.equipAfterLift && (!this.intoHands || this.intoHands.t >= 1)) {
          const wrist = ch?.rig?.wristWorld(side), home = ch?.rig?.armHome(side);
          if (this.regrips.get(id)?.get(side)?.done && wrist && home && wrist.y > home.shoulder.y - home.length * .8 &&
              (ch?.rig?.bendNow.drop ?? Infinity) < .10 * this.k && this.resumeTool()) {
            this.intoHands = null; this.heldPaths.delete(id); this.carryGoals.delete(id); this.liftingOff.delete(id);
            this.host.changed(); continue;
          }
        }
        const gripPose = this.handCarryPose(side, p);
        // Distortion-free `ToolSpec` carry fast-path: clamp head floor clearance to `floorY + 0.08 * scale`
        // (never `carriedSize.h / 2 + 0.1`), skip `carryIntent` yaw-lead whip, and track via `syncCarriedToolPose`!
        if (spec && gripPose && !this.carryAt && !this.inspecting) {
          const toolFloorY = ch?.groundAt?.(gripPose.position.x, gripPose.position.z) ?? ch?.root.position.y ?? 0;
          const clampedGroupPos = _mV1.copy(gripPose.position);
          clampedGroupPos.y = T.MathUtils.clamp(clampedGroupPos.y, toolFloorY + .08 * p.obj.scale, toolFloorY + 2.5);
          if (!this.host.lifeRoots?.().length) {
            clampedGroupPos.x = T.MathUtils.clamp(clampedGroupPos.x, -half, half);
            clampedGroupPos.z = T.MathUtils.clamp(clampedGroupPos.z, -half, half);
          }
          physics.syncCarriedToolPose(side, id, clampedGroupPos, gripPose.rotation, dt);
          this.heldPaths.delete(id);
          continue;
        }
        if (gripPose && (this.intoHands?.id === id || this.toolCarryFrames.has(id))) transitionRotation = gripPose.rotation;
        destination = gripPose ? physics.centreFor(id, gripPose.position, gripPose.rotation, new T.Vector3()) : this.toStage(this.carryTarget(side, { id, p }));
        if (gripPose) physics.fitCarryInRoom(id, destination, gripPose.rotation);
        // Off the place it stood on and into the hands in one continuous move: never a jump to where carried things are held.
        if (this.intoHands?.id === id) {
          const into = this.intoHands;
          const actual = physics.pointOf(id);
          if (actual && actual.y > into.peak + .008) { into.peak = actual.y; into.stalled = 0; }
          else into.stalled += dt;
          if (into.t === 1 && into.stalled > 2 && actual && destination.y - actual.y > .08 && (ch?.rig?.bendNow.drop ?? 0) > .12 * this.k) {
            this.intoHands = null;
            this.heldPaths.delete(id); this.liftingOff.delete(id);
            physics.release(side); this.releaseHeldContacts(side, id, .20);
            this.host.say('Vật bị vướng khi nhấc lên.', 'The object is blocked during the lift.');
            this.host.changed(); continue;
          }
          // A heavy thing comes up as fast as the legs bring it.
          into.t = Math.min(1, into.t + dt / (this.host.reduced() ? .01 : .3 + Math.min(.9, affordanceOf(p.obj.kind).mass * .07)));
          const e = into.t * into.t * (3 - 2 * into.t);
          destination.lerpVectors(into.from, destination, e);
          // A long shaft comes up first and turns into the hand after: turned while it still lay on the floor, its head
          // dragged across the boards and every physics step solved that contact (frames of 100-250 ms at the lift).
          if (gripPose && (toolOf(p.obj.kind)?.length ?? 0) > .9) {
            const start = into.fromQ ??= p.group.quaternion.clone();
            const r = T.MathUtils.clamp((into.t - .3) / .7, 0, 1);
            liftRotation = start.clone().slerp(gripPose.rotation, r * r * (3 - 2 * r));
            transitionRotation = liftRotation;
          }
          if (into.t >= 1 && (physics.pointOf(id)?.distanceTo(destination) ?? Infinity) < .005 && (!gripPose || p.group.quaternion.angleTo(gripPose.rotation) < .015)) this.intoHands = null;
        }
        // Carried, it turns with the body (and with the wheel, Q, E, Z, R); a flat thing is tilted up so its face is seen.
        if (this.book?.side === side) this.holdBookToEyes(side);
        if (!this.inspecting && !this.drinking && !this.book && this.pouring?.p !== p) {
          const tap = this.carryAt?.id === id && this.carryAt.rotation ? this.carryAt.rotation :
            this.fillHeading?.id === id ? this.fillHeading.rotation : null;
          if (tap) physics.holdGroupRotation(side, tap);
          else if (gripPose) physics.holdGroupRotation(side, liftRotation ?? gripPose.rotation);
          else {
            const bodyRel0 = this.carryInBodyQuat ?? _mQ2.setFromAxisAngle(UP, (this.carryYaw ?? 0) + (this.handTurn ?? 0));
            const q = ch?.ready
              ? _mQ1.copy(ch.root.quaternion).multiply(bodyRel0)
              : _mQ1.setFromAxisAngle(UP, (ex.lookYaw ?? 0) + (this.carryYaw ?? 0)).multiply(this.placeGroupQuat ?? _mQ3.identity());
            const size = this.carried.get(id);
            if (size && size.h < .07 && worldUpYFromQuat(q) >= EXACT_UPRIGHT_MIN_UP_Y) {
              q.multiply(_mQ3.setFromAxisAngle(X_AXIS, .42));
            }
            physics.holdGroupRotation(side, q);
          }
          if (ch && !this.carryAt) {
            const inverse = _mQ1.copy(ch.root.quaternion).invert();
            const bodyRel = this.carryInBodyQuat ?? _mQ2.setFromAxisAngle(UP, (this.carryYaw ?? 0) + (this.handTurn ?? 0));
            const rotation = tap ?? gripPose?.rotation ?? _mQ3.copy(ch.root.quaternion).multiply(bodyRel);
            this.carryGoals.set(id, {
              offset: destination.clone().sub(ch.root.position).applyQuaternion(inverse),
              rotation: inverse.clone().multiply(rotation),
            });
            if (intent) {
              const delta = intent.yaw - ch.root.rotation.y;
              const lead = T.MathUtils.clamp(Math.atan2(Math.sin(delta), Math.cos(delta)), -.14, .14);
              const translation = _mV1.copy(intent.at).sub(ch.root.position).clampLength(0, .045);
              destination.sub(ch.root.position).applyAxisAngle(UP, lead).add(ch.root.position).add(translation);
              transitionRotation = new T.Quaternion().setFromAxisAngle(UP, lead).multiply(rotation);
            }
          }
        }
      }
      // Carried means off the floor: a tall thing is lifted clear of it, however low the eyes are looking.
      const carriedSize = this.placing?.side === side ? null : this.carried.get(id);
      if (!this.host.lifeRoots?.().length) {
        destination.x = T.MathUtils.clamp(destination.x, -half, half);
        destination.z = T.MathUtils.clamp(destination.z, -half, half);
      }
      // Placement has already been fitted to its support using the actual
      // rotated shape. A generic centre-height floor strands thin objects.
      const floorY = ch?.root.position.y ?? 0;
      if (this.placing?.side !== side) destination.y = T.MathUtils.clamp(destination.y, floorY + (carriedSize ? carriedSize.h / 2 + .1 : .05), floorY + 2.5);
      // Up before away: a thing is lifted clear of the table it stands on, never shoved along it into what else is there.
      if (carriedSize && !this.carryAt) {
        if (hangingVessel && this.plan.label === 'place' && this.placeEyes) {
          destination.y = Math.max(destination.y, this.placeEyes.y + .03);
        }
        if (this.liftingOff.has(id) || hangingVessel) {
          const middle = physics.pointOf(id), need = middle ? physics.clearanceAlong(id, destination) : null;
          if (need !== null && middle) {
            destination.y = Math.max(destination.y, need + .03);
            // Up first, then away: until it clears what is beside it, the hand barely moves it sideways (a kettle is not dragged into the cups).
            const short = need + .012 - middle.y;
            if (short > 0) { const go = T.MathUtils.clamp(1 - short / .05, .08, 1); destination.x = middle.x + (destination.x - middle.x) * go; destination.z = middle.z + (destination.z - middle.z) * go; }
          }
          // Off the table: from here on it is simply carried. Walking past a table does not lift it over the table again.
          else this.liftingOff.delete(id);
        }
      }
      if (transitionRotation) {
        const fitted = this.constrainHeld(side, p, destination, transitionRotation, dt);
        if (!fitted) continue;
        const placement = this.placing;
        if (placement?.id === id && !placement.rack && placement.left < 6.5) {
          const actual = physics.pointOf(id);
          if (actual && actual.distanceTo(placement.to)<.15 && actual.distanceTo(fitted)<.006) {
            const shift = placement.to.clone().sub(fitted).setY(0);
            if (shift.lengthSq()>.003**2) placement.footShift = shift;
          }
        }
        destination = fitted;
      } else this.heldPaths.delete(id);
      physics.aim(side, destination, this.carryGoals.has(id) || this.carryAt?.rotation ? dt : undefined, this.intoHands?.id === id || hangingVessel || (this.liftingOff.has(id) && !!vesselOf(p.obj.kind)));
    }
  }

  private pendingPhysics: number | null = null;
  /** Called once after the torso layers, before arm IK. All contacts see the current interpolated body. */
  resolveContacts() {
    const physics = this.physics, dt = this.pendingPhysics;
    if (!physics || dt === null) return;
    this.pendingPhysics = null;
    this.updateHeldTargets(physics, dt);
    this.work.beforePhysics(dt);
    physics.update(dt);
    this.work.afterPhysics(dt);
    this.followPush(dt);
    this.actions.refreshContacts();
  }

  /**
   * Something small on the floor is not an obstacle to walk round, and not something to walk through either: the foot sends it off. A paper ball goes far, a bucket hardly, and the body feels what it hit.
   */
  private kickWhatIsUnderfoot() {
    const physics = this.physics, ch = this.host.character(), ex = this.host.exploration;
    if (!physics || !ch?.ready || !ex.active || this.frameCount % 3 || ex.speed < .3 || ch.body.seat || this.plan.active) return;
    const at = ch.root.position, face = ch.bodyForward(new T.Vector3());
    for (const p of this.host.placed.values()) {
      const o = p.obj;
      if (o.hidden || o.inside || o.locked || Math.abs(p.group.position.y - at.y) > .22 || physics.owns(o.id) || CATALOG_BY_ID[o.kind]?.place !== 'surface' || toolOf(o.kind)) continue;
      const a = affordanceOf(o.kind);
      if (a.mobility !== 'portable') continue;
      const dx = p.group.position.x - at.x, dz = p.group.position.z - at.z, d = Math.hypot(dx, dz), r = Math.max(CATALOG_BY_ID[o.kind]?.size[0] ?? .1, CATALOG_BY_ID[o.kind]?.size[1] ?? .1) * o.scale * .5;
      if (d > r + .17 || (dx * face.x + dz * face.z) < -.02) continue;
      const kg = massNow(o.kind, o.state, a.mass), speed = ex.speed, sent = speed * 1.15 / (1 + kg * .5);
      if (physics.wake(o.id, { x: dx / Math.max(d, .01) * sent, y: Math.min(1.2, sent * .3), z: dz / Math.max(d, .01) * sent })) {
        contactSound(a.material, Math.min(1, speed / 2.6) * .6, this.hearing(p.group.position));
        if (kg > 1.5) ch.rig?.bump(-dx / Math.max(d, .01) * Math.min(.4, kg / ch.bodyKg * speed), -dz / Math.max(d, .01) * Math.min(.4, kg / ch.bodyKg * speed));
      }
    }
  }
  /** What a thing's own state looks like: lids, screens, a spinning globe, a hanging picture. Cheap: only things that have any of it. */
  private animate(dt: number) {
    const reduced = this.host.reduced();
    for (const p of this.host.placed.values()) {
      const ud = p.group.userData, st = p.obj.state;
      if (ud.lid) {
        const want = (st?.lid ?? 1) > .5 ? ud.lidOpen as number : ud.lidShut as number, node = ud.lid as T.Object3D;
        const now = node.rotation.x;
        if (Math.abs(now - want) > .001) node.rotation.x = reduced ? want : now + (want - now) * (1 - Math.exp(-7 * dt));
      }
      if (ud.screen) {
        const m = ud.screen as T.MeshStandardMaterial, off = st?.on === false || (st?.lid ?? 1) < .5;
        // A monitor shows the desktop once it has a computer behind it, and says so until then.
        if (ud.noSignal) {
          const want = this.readyMonitors.has(p.obj.id) ? (ud.desktop as T.Texture) : (ud.noSignal as T.Texture);
          if (m.map !== want) {
            const nullFlipped = (m.map === null) !== (want === null);
            m.map = want;
            m.emissiveMap = want;
            if (nullFlipped) m.needsUpdate = true;
          }
        }
        const want = off ? 0 : ud.screenGlow as number;
        if (Math.abs(m.emissiveIntensity - want) > .002) m.emissiveIntensity += (want - m.emissiveIntensity) * (1 - Math.exp(-9 * dt));
        const c = off ? .08 : 1;
        if (Math.abs(m.color.r - c) > .002) m.color.setScalar(m.color.r + (c - m.color.r) * (1 - Math.exp(-9 * dt)));
      }
      const spin = this.spins.get(p.obj.id);
      if (spin !== undefined && ud.spin) {
        const v = spin * Math.exp(-.7 * dt);
        (ud.spin as T.Object3D).userData.extra = ((ud.spin as T.Object3D).userData.extra ?? 0) + v * dt;
        if (v < .02) this.spins.delete(p.obj.id); else this.spins.set(p.obj.id, v);
      }
      const wob = this.wobbles.get(p.obj.id);
      if (wob !== undefined) {
        if (this.physics?.owns(p.obj.id)) {
          this.restoreWobbleRest(p);
        } else {
          const next = wob - dt * .9;
          if (next <= 0) {
            this.restoreWobbleRest(p);
          } else {
            const a = Math.sin(next * 16) * next * .05;
            _mQ1.setFromAxisAngle(Z_AXIS, a);
            for (let i = 1; i < p.group.children.length; i++) {
              const child = p.group.children[i];
              if ((child as T.Mesh).userData?.blob) continue;
              const restQ = (child.userData._restQuat as T.Quaternion | undefined) ?? (child.userData._restQuat = child.quaternion.clone());
              child.quaternion.copy(restQ).multiply(_mQ1);
            }
            this.wobbles.set(p.obj.id, next);
          }
        }
      }
      if (ud.flipper) {
        const want = (st?.flip ?? 0) * Math.PI, node = ud.flipper as T.Object3D;
        if (Math.abs(node.rotation.z - want) > .002) node.rotation.z = reduced ? want : node.rotation.z + (want - node.rotation.z) * (1 - Math.exp(-6 * dt));
      }
      if (st?.tilt !== undefined && !p.obj.quat && affordanceOf(p.obj.kind).mobility === 'fixed') {
        const want = st.tilt;
        if (Math.abs(p.group.rotation.z - want) > .001) p.group.rotation.z += (want - p.group.rotation.z) * (1 - Math.exp(-8 * dt));
      }
    }
  }

  /**
   * Cancels any in-flight transient hand/body interaction (door reach/hinge drive, drawer pull, push,
   * doorway traversal, queued clicks, or approach plan) without tearing down the physics world.
   * Called on pose reset / fast-travel so stale door-reach IK never stays active at the new destination.
   */
  cancelActiveInteraction() {
    this.doorSequence++;
    if (this.lifeDoorReach) {
      const prevDoor = this.doorOf(this.lifeDoorReach.id);
      prevDoor?.press(0);
      if (this.lifeDoorReach.side !== 0 && !this.physics?.heldIn(this.lifeDoorReach.side)) {
        this.host.character()?.rig?.setContact(this.lifeDoorReach.side, null, 0.1);
      }
      this.lifeDoorReach = null;
    }
    if (this.doorMech) {
      const door = this.doorOf(this.doorMech.id);
      if (door) { door.press(0); door.setOpen(Math.abs(door.angle) > .45); }
      this.endDoor();
    }
    if (this.drawer) {
      this.drawer.mech?.dispose();
      this.drawer = null;
    }
    this.work.end();
    this.setGizmoActive(false);
    if (this.push) this.endPush();
    this.plan.cancel();
    this.actions.cancelAll();
    this.queue.length = 0;
    this.journeyTo = null;
    this.passing = null;
    this.walkedIn = false;
    this.pendingLift = null;
    this.placeEyes = null;
    this.host.exploration.setPassing(false);
    this.setTarget(null, null);
    this.host.changed();
  }

  /** Anything in the air or the hands goes back to a safe place before the room is left or edited. */
  settle() {
    this.setInspecting(false);
    this.setGizmoActive(false);
    this.plan.cancel();
    this.cancelPlacement();
    this.silenceWater(); this.work.end(); this.carryAt = null; this.fillHeading = null; this.streaming = null; this.stopPour();
    this.actions.resetAll(.20);
    if (this.push) this.endPush();
    this.queue = [];
    this.physics?.flush();
    for (const p of this.host.placed.values()) this.restoreWobbleRest(p);
    this.twoHanded.clear();
    this.grasps.clear();
    this.regrips.clear();
    this.heldPaths.clear();
    this.carryGoals.clear();
    this.toolCarryFrames.clear();
    this.liftingOff.clear();
    this.settled.clear();
    this.carried.clear();
    this.toolExtraction = null;
    this.intoHands = null;
    this.turnHeld = null;
    this.wristTurn = null;
    this.pendingLift = null;
    this.preview?.hide();
    const rig = this.host.character()?.rig;
    if (rig) {
      rig.setContact(1, null, undefined, .20);
      rig.setContact(-1, null, undefined, .20);
    }
    this.placing = null; this.placeEyes = null; this.hugging = false; this.drinking = null; this.journeyTo = null; this.passing = null;
    this.invalidatePlaceCache();
    this.host.exploration.setPassing(false);
    this.host.changed();
  }

  /**
   * Public room-recovery entrypoint for `Reset Room`: safely cancels any in-flight plan, pickup, placement,
   * tool work, push, drawer, door, reading, or gizmo state, releases all held objects and two-hand/one-hand
   * rig contacts cleanly without overwriting the restored room layout, hides placement previews, and syncs
   * live Rapier bodies to the room's layout transforms.
   */
  resetInteractionState() {
    this.doorSequence++;
    if (this.lifeDoorReach) {
      const prevDoor = this.doorOf(this.lifeDoorReach.id);
      prevDoor?.press(0);
      this.lifeDoorReach = null;
    }
    if (this.doorMech) {
      const door = this.doorOf(this.doorMech.id);
      if (door) { door.press(0); door.setOpen(Math.abs(door.angle) > .45); }
      this.endDoor();
    }
    if (this.drawer) {
      this.drawer.mech?.dispose();
      this.drawer = null;
    }
    this.silenceWater();
    this.endGizmoDrag();
    this.gizmoActive = false;
    this.gizmoOffset.set(0, 0, 0);
    this.gizmo?.hide();
    this.preview?.hide();
    this.stationBoard?.hide();
    this.stationNow = null;
    if (this.meter) {
      this.meter.show(false);
      this.meter.group.visible = false;
    }
    this.closeBook();
    this.inspecting = false;
    this.host.exploration.setReading(false);
    if (this.deviceId) {
      this.host.exploration.leaveDevice();
      this.deviceId = null;
    }
    this.plan.cancel();
    this.cancelPlacement();
    this.work.end();
    this.stopPour();
    this.streaming = null;
    this.carryAt = null;
    this.fillHeading = null;
    this.push = null;
    this.scrape?.set(0, 'wood-legs');
    this.actions.resetAll(.16);
    this.queue.length = 0;
    this.twoHanded.clear();
    this.grasps.clear();
    this.regrips.clear();
    this.heldPaths.clear();
    this.carryGoals.clear();
    this.toolCarryFrames.clear();
    this.rackRoutes.clear();
    this.liftingOff.clear();
    this.settled.clear();
    this.carried.clear();
    this.wobbles.clear();
    this.spins.clear();
    this.toolExtraction = null;
    this.intoHands = null;
    this.turnHeld = null;
    this.wristTurn = null;
    this.pendingLift = null;
    this.placing = null;
    this.placeEyes = null;
    this.hugging = false;
    this.drinking = null;
    this.journeyTo = null;
    this.passing = null;
    this.walkedIn = false;
    this.invalidatePlaceCache();
    this.saucerRotation = null;
    this.placeAim = null;
    this.placeStore = null;
    this.placeShelf = null;
    this.placeOk = false;
    this.placeReason = null;
    this.placeSurface = null;

    for (const p of this.host.placed.values()) {
      this.restoreWobbleRest(p);
    }

    const layout = this.host.layout();
    if (this.physics) {
      const entries = [...this.host.placed.values()];
      const roomSize = layout?.room.size ?? 6;
      if (typeof this.physics.resetRoomBodies === 'function') {
        this.physics.resetRoomBodies(entries, roomSize);
      } else {
        for (const id of [...this.physics.heldIds]) this.physics.forget(id);
        this.physics.sync(entries, roomSize);
      }
    }

    const ch = this.host.character() as (Character & { resetStuckInteractionState?: () => void }) | null;
    ch?.resetStuckInteractionState?.();
    const rig = ch?.rig;
    if (rig) {
      rig.setContact(1, null, undefined, .16);
      rig.setContact(-1, null, undefined, .16);
      rig.clearTransientContacts?.(true);
    }

    this.host.exploration.setPassing(false);
    this.setTarget(null, null);
    this.host.navigationChanged?.();
    this.host.changed();
    this.host.wake();
  }

  /** Another room: nothing carries over. */
  silenceWater() {
    this.hum?.stop(); this.hum = null;
    this.streaming?.stopAudio?.(); this.pouring?.stopAudio?.();
  }
  reset() {
    this.silenceWater();
    this.endGizmoDrag();
    this.gizmoActive = false;
    this.gizmoOffset.set(0, 0, 0);
    this.gizmo?.hide();
    this.cancelPlacement(); this.heldPaths.clear();
    this.carryGoals.clear();
    this.liftingOff.clear();
    this.rackRoutes.clear();
    this.toolCarryFrames.clear();
    this.toolExtraction = null;
    this.closeBook(); this.inspecting = false; this.plan.cancel(); this.work.end(); this.carryAt = null; this.fillHeading = null; this.streaming = null; this.pouring = null; this.actions.resetAll(.16); this.grasps.clear(); this.settled.clear();
    this.regrips.clear();
    this.carried.clear(); this.intoHands = null; this.turnHeld = null; this.wristTurn = null; this.deviceId = null; this.stationBoard?.hide(); this.stationNow = null; this.judged = false; this.readyMonitors.clear();
    this.push = null; if (this.meter) { this.meter.show(false); this.meter.group.visible = false; } this.preview?.hide(); this.queue = [];
    this.physics?.dispose(); this.physics = null; this.physicsState = 'idle'; this.drawer = null; this.doorMech = null;
    this.twoHanded.clear(); this.placing = null; this.hugging = false; this.drinking = null; this.journeyTo = null; this.passing = null; this.pendingLift = null;
    this.invalidatePlaceCache();
  }
  get diagnostics() { return { busy: this.actions.busy, holding: this.actions.holding, inspecting: this.inspecting, reading: !!this.book, dragging: this.push?.id ?? null, push: this.push ? { id: this.push.id, applied: Math.round(this.push.gauge?.applied ?? 0), need: Math.round(this.push.res.breakaway), sliding: Math.round(this.push.res.sliding), moving: this.push.moving, blocked: this.push.blocked, pulling: this.push.pulling, pose: this.physics?.pushPose() ?? null } : null, physicsState: this.physicsState, physicsRoute, queued: this.queue.length, placeOk: this.placeOk, placeReason: this.placeReason?.en ?? null, carryYaw: this.carryYaw, rotAxis: this.rotAxis, gizmoActive: this.gizmoActive, journey: this.journeyTo, step: this.plan.step, placeAim: this.placeAim?.toArray() ?? null, store: this.placeStore, physics: this.physics?.diagnostics ?? null, target: this.targetId }; }
  /** The ring, the 3D ghost, and the optional 360-degree 3-axis TransformGizmo3D. */
  private showPlacement(dt: number) {
    const physics = this.physics, id = physics?.heldIds[0], held = id ? this.host.placed.get(id) : null;
    const ex = this.host.exploration;

    // Inspect Mode 3D Gizmo support (attached directly to the inspected object when `gizmoActive` is true).
    if (held && this.inspecting && !this.book && ex.active) {
      this.preview?.hide();
      if (this.gizmoActive && !toolOf(held.obj.kind)) {
        this.gizmo ??= new TransformGizmo3D();
        if (this.gizmo.group.parent !== this.host.stage) this.host.stage.add(this.gizmo.group);
        this.gizmo.setMode('rotate');
        this.gizmo.setHighlightAxis(this.rotAxis);
        if (!this.gizmo.dragging) {
          const own = this.ownBox(held);
          own.getCenter(this.gizmoPivotScratch).multiplyScalar(held.obj.scale);
          const sz = own.getSize(V3_C).multiplyScalar(held.obj.scale);
          const r = Math.max(.16, Math.hypot(sz.x, sz.y, sz.z) * .52);
          this.gizmo.attach(held.group.position, held.group.quaternion, r, this.gizmoPivotScratch);
          this.gizmoRaycaster.setFromCamera(ex.aim, ex.camera);
          this.gizmo.updateHover(this.gizmoRaycaster);
        }
        this.gizmo.updateScale(ex.camera);
      } else {
        this.gizmo?.hide();
      }
      return;
    }

    const surface = this.placeSurface;
    if (!held || !surface || this.inspecting || this.pouring || this.drinking || this.placing || !ex.active || this.placeStore || this.carryAt || this.careVerb(0) || toolOf(held.obj.kind)) {
      this.preview?.hide();
      if (!this.gizmo?.dragging) this.gizmo?.hide();
      return;
    }
    if (!this.preview) { this.preview = new PlacementPreview(); }
    if (this.preview.group.parent !== this.host.stage) this.host.stage.add(this.preview.group);
    const at = this.toStage(surface.point), normal = surface.normal.clone();
    // Exactly where its own origin will stand and how it will be turned in 3D: what the shape's way down found.
    const pose = physics!.poseAt(id!, this.placeAim ?? at, this.saucerRotation ?? this.placeBodyQuat(id!));
    if (!pose) {
      this.preview.hide();
      if (!this.gizmo?.dragging) this.gizmo?.hide();
      return;
    }
    this.preview.show(at, normal, this.placeOk, held.group, pose.position, pose.quaternion, held.obj.scale);
    this.preview.update(dt, this.host.reduced());

    if (this.gizmoActive) {
      this.gizmo ??= new TransformGizmo3D();
      if (this.gizmo.group.parent !== this.host.stage) this.host.stage.add(this.gizmo.group);
      this.gizmo.setMode('both');
      this.gizmo.setHighlightAxis(this.rotAxis);
      if (!this.gizmo.dragging) {
        this.gizmo.attach(
          pose.position,
          pose.quaternion,
          this.preview.radius(),
          this.preview.localPivotOffset(this.gizmoPivotScratch),
        );
        this.gizmoRaycaster.setFromCamera(ex.aim, ex.camera);
        this.gizmo.updateHover(this.gizmoRaycaster);
      }
      this.gizmo.updateScale(ex.camera);
    } else {
      this.gizmo?.hide();
    }
  }
  /** Pre-instantiates and attaches placement preview & 3D transform gizmo groups so Stage-6 warmup compiles all shaders upfront (`programDelta === 0`). */
  ensureWarmupRoots(): T.Object3D[] {
    this.preview ??= new PlacementPreview();
    if (this.preview.group.parent !== this.host.stage) this.host.stage.add(this.preview.group);
    this.gizmo ??= new TransformGizmo3D();
    if (this.gizmo.group.parent !== this.host.stage) this.host.stage.add(this.gizmo.group);
    return [this.preview.group, this.gizmo.group];
  }
  dispose() {
    this.endGizmoDrag();
    this.reset();
    this.work.dispose();
    this.scrape?.stop(); this.scrape = null;
    this.hum?.stop(); this.hum = null;
    this.meter?.dispose();
    this.preview?.dispose();
    this.gizmo?.dispose();
    this.stationBoard?.dispose();
    this.meter = null;
    this.preview = null;
    this.gizmo = null;
    this.stationBoard = null;
  }
}
