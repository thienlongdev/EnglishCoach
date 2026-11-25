import * as T from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { SpaceObject } from '@/lib/study-space/types';
import { affordanceOf } from '@/lib/study-space/affordances';
import { CATALOG_BY_ID } from '@/lib/study-space/catalog';
import {
  SETTLE_UPRIGHT_MIN_UP_Y,
  applySpaceObjectTransform,
  extractPreservedYaw,
  normalizeSpaceObjectOrientation,
  sameSpaceObjectTransform,
  uprightQuatFrom,
  worldUpYFromQuat,
  type QuatTuple,
} from '@/lib/study-space/orientation';
import { massNow, toolOf } from '@/lib/study-space/tools';
import { rigidToolSurface, RigidToolQueryBounds } from '@/components/study-space/world/rigidToolSurface';
import { fixedRackSurface } from '@/components/study-space/world/fixedRackSurface';
import { createRackMechanism, type RackMechanism } from '@/components/study-space/world/rackMechanism';
import { roomSurfaceParts } from '@/components/study-space/world/roomSurface';
import { rackStorageSurface, storageKey, type RackStorage } from './rackStorage';

type LowestMemo = {
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  y: number;
  base: [number, number][];
  samples: [number, number][];
  comX: number;
  comZ: number;
  ownDepth: number;
};

type Entry = { obj: SpaceObject; group: T.Group };
type Body = { body: RAPIER.RigidBody; collider: RAPIER.Collider; colliders: RAPIER.Collider[]; hull: Float32Array; sweepRadius: number; com: T.Vector3; massHalfExtents: T.Vector3; radius: number; entry: Entry; center: T.Vector3; start: T.Vector3; startQuat: T.Quaternion; q0: T.Quaternion; layoutPos: [number, number, number]; layoutRotY: number; layoutQuat: QuatTuple | undefined; surfaceDamped?: boolean; lowestCache?: LowestMemo; storageKey?: ReturnType<typeof storageKey>; time: number; contacted: boolean; lastSpeed: number; prevP: T.Vector3; prevQ: T.Quaternion; kg: number; before: T.Vector3; /** Where it was when it last moved, and how long it has kept still since: the test of rest. */ restP: T.Vector3; restQ: T.Quaternion; restT: number };
type Hold = { brake?: { center: T.Vector3; rotation: T.Quaternion }; id: string; target: T.Vector3; rotation: T.Quaternion | null; stiffness: number; force?: T.Vector3; previousTarget?: T.Vector3; velocity?: T.Vector3; previousRotation?: T.Quaternion; angularVelocity?: T.Vector3; working?: boolean; motionTarget?: boolean; stationaryTarget?: boolean; lifting?: boolean; rackTransfer?: string; rackBias?: T.Vector3; rackBiasTarget?: T.Vector3; supportTrial?: { id: string; time: number; load: number; lastMeasuredLoad?: number; events: number[] } };
/** The answer to "would it stand here": where its centre comes to rest, or why it would not. */
export type Fit = { ok: true; center: T.Vector3 } | { ok: false; why: 'room' | 'support' | 'edge'; center: T.Vector3 };

/**
 * The page's script policy never allows WebAssembly compilation (security closure: no 'wasm-unsafe-eval' on pages, 10 §AP). The worker under
 * /vendor/study-physics/ is served with a policy that does, compiles exactly the pinned Rapier bytes and hands the module back; the page
 * only instantiates it. Production failed here before 2026-11-06: every pick-up answered "physical interaction could not load".
 */
const COMPILER = '/vendor/study-physics/compile-v1.js';
let rapierPromise: Promise<typeof RAPIER> | null = null;
export type PhysicsRoute = 'worker' | 'page';
export let physicsRoute: PhysicsRoute | null = null;
export function loadStudyPhysics() {
  return rapierPromise ??= (async () => {
    const m = await import('@dimforge/rapier3d-compat');
    await withPrecompiled(() => m.init());
    return m.default;
  })().catch(e => { rapierPromise = null; throw e; });
}
/** While Rapier starts, its one instantiate call gets the module the worker compiled from the very same bytes. */
async function withPrecompiled(run: () => Promise<unknown>) {
  const W = WebAssembly as unknown as { instantiate: (source: unknown, imports?: unknown) => Promise<unknown> };
  const real = W.instantiate;
  let used = false;
  const patched = async (source: unknown, imports?: unknown) => {
    if (used || source instanceof WebAssembly.Module) return real.call(WebAssembly, source, imports);
    used = true;
    const module = await compileInWorker(source as ArrayBuffer | ArrayBufferView).catch(() => null);
    if (module) { physicsRoute = 'worker'; return { instance: await real.call(WebAssembly, module, imports), module }; }
    // A browser that cannot hand a compiled module across (or no worker): the page compiles itself where its policy allows (development).
    physicsRoute = 'page';
    return real.call(WebAssembly, source, imports);
  };
  W.instantiate = patched;
  try { await run(); } finally { if (W.instantiate === patched) W.instantiate = real; }
}
function compileInWorker(source: ArrayBuffer | ArrayBufferView): Promise<WebAssembly.Module> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try { worker = new Worker(COMPILER); } catch (e) { reject(e); return; }
    const view = source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    const bytes = view.slice().buffer;
    const timer = window.setTimeout(() => { worker.terminate(); reject(new Error('physics compile timed out')); }, 20000);
    worker.onmessage = (e: MessageEvent<{ module?: WebAssembly.Module; error?: string }>) => {
      window.clearTimeout(timer); worker.terminate();
      if (e.data?.module instanceof WebAssembly.Module) resolve(e.data.module); else reject(new Error(e.data?.error ?? 'no module'));
    };
    worker.onerror = e => { window.clearTimeout(timer); worker.terminate(); reject(new Error(e.message || 'physics worker failed')); };
    worker.postMessage({ id: 1, bytes }, [bytes]);
  });
}
const UP = new T.Vector3(0, 1, 0);
const MAX_BODIES = 16;
const FIXED_STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 3;
const MAX_ACCUMULATOR = FIXED_STEP * MAX_STEPS_PER_FRAME;
// Reusable zero-alloc scratch math objects for hot query & fixed-step loops.
const _pV1 = new T.Vector3();
const _pV2 = new T.Vector3();
const _pV3 = new T.Vector3();
const _pV4 = new T.Vector3();
const _pV5 = new T.Vector3();
const _pV6 = new T.Vector3();
const _pQ1 = new T.Quaternion();
const _pQ2 = new T.Quaternion();
const _pQ3 = new T.Quaternion();
const _pQ4 = new T.Quaternion();
const _pQueryPos = { x: 0, y: 0, z: 0 };
const _pQueryRot = { x: 0, y: 0, z: 0, w: 1 };

/** Validated placement skin tolerance (`0.25 mm` in `[0.0..0.5] mm`): zero upward pop and zero mid-air hover. */
const SURFACE_SKIN_M = 0.00025;
const HELD_LINEAR_DAMPING = 0.25;
const HELD_ANGULAR_DAMPING = 0.9;
const REST_FRICTION = 0.82;
const REST_LINEAR_DAMPING = 2.2;
const REST_ANGULAR_DAMPING = 3.4;
const EMPTY_HANDLE_SET: ReadonlySet<number> = new Set<number>();

// Subsystem-isolated scratch objects so nested fit / motion / carry queries never alias each other.
const _fitStartV = new T.Vector3();
const _fitEndV = new T.Vector3();
const _fitCastStart = { x: 0, y: 0, z: 0 };
const _fitCastRot = { x: 0, y: 0, z: 0, w: 1 };
const _downDir = { x: 0, y: -1, z: 0 };
const _lowScratchV = new T.Vector3();
const _supportHeldScratch: [number, number][] = [];

const _hmTrans = new T.Vector3();
const _hmOrigin = new T.Vector3();
const _hmRot = new T.Quaternion();
const _hmTurnQ = new T.Quaternion();
const _hmStartP = new T.Vector3();
const _hmStartQ = new T.Quaternion();
const _hmEndP = new T.Vector3();
const _hmEndQ = new T.Quaternion();
const _hmVel = new T.Vector3();

const _tmStartP = new T.Vector3();
const _tmStartQ = new T.Quaternion();
const _tmEndP = new T.Vector3();
const _tmEndQ = new T.Quaternion();
const _tmDelta = new T.Vector3();

const _carryWantCenter = new T.Vector3();
const _carryWantBodyQ = new T.Quaternion();
const _carryQ0Inv = new T.Quaternion();
const _carryFromP = new T.Vector3();
const _carryFromQ = new T.Quaternion();
const _carryNextP = new T.Vector3();
const _carryNextQ = new T.Quaternion();
const _carryDrawnQ = new T.Quaternion();
const _carryOffsetV = new T.Vector3();

const _aimFrom = new T.Vector3();
const _aimOrient = new T.Quaternion();
const _aimTo = new T.Vector3();
const _aimNextQ = new T.Quaternion();
const _aimMotion = new T.Vector3();
const _aimTrialEnd = new T.Vector3();
const _aimDeltaA = new T.Vector3();
const _aimDeltaB = new T.Vector3();
const _aimIdentityQ = new T.Quaternion();

const _fitRoomQ = new T.Quaternion();
const _fitRoomQ0Inv = new T.Quaternion();
const _fitRoomBounds = new T.Box3();
const _fitRoomPoint = new T.Vector3();

const _settleQ0Inv = new T.Quaternion();
const _settleBodyQ = new T.Quaternion();
const _settleOffset = new T.Vector3();
export type WorldSolidBox = { hx: number; hy: number; hz: number; x: number; y: number; z: number };
export type OrientedSolidBox = WorldSolidBox & { yaw: number };
function solidBoxesSignature(boxes: readonly WorldSolidBox[]): string {
  if (!boxes.length) return '';
  let h1 = 2166136261 >>> 0;
  let h2 = 2166136261 >>> 0;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const x = Math.round(b.x * 1000) | 0;
    const y = Math.round(b.y * 1000) | 0;
    const z = Math.round(b.z * 1000) | 0;
    const hx = Math.round(b.hx * 1000) | 0;
    const hy = Math.round(b.hy * 1000) | 0;
    const hz = Math.round(b.hz * 1000) | 0;
    h1 = Math.imul(h1 ^ x ^ (y << 1) ^ (z << 2), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ hx ^ (hy << 1) ^ (hz << 2), 16777619) >>> 0;
  }
  return `${boxes.length}:${h1.toString(36)}:${h2.toString(36)}`;
}
/** Retained box approximation, not a calibrated material distribution. Keep
 * creation and state changes identical, in the body's original local frame. */
function massInertia(kg: number, half: T.Vector3) {
  const axis = (u: number, v: number) => Math.max(1e-5, kg / 12 * (4 * u * u + 4 * v * v));
  return new T.Vector3(axis(half.y, half.z), axis(half.x, half.z), axis(half.x, half.y));
}
/** How far a thing must be sent for it to count as moved at all, m/s: a pencil does not shift a plant pot. */
const KNOCK_LEAST = .07;
/** Floor furniture lighter than this gets shoved along by what is pushed into it, instead of stopping it. */
const SHOVE_MOST = 26;
/** The directions a thing's convex collider is taken from: evenly over the sphere, the axes first so its box is exact. */
const HULL_DIRECTIONS: [number, number, number][] = (() => {
  const d: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) d.push([x * .577, y * .577, z * .577]);
  const n = 90, g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) { const y = 1 - (i + .5) / n * 2, r = Math.sqrt(1 - y * y), a = g * i; d.push([Math.cos(a) * r, y, Math.sin(a) * r]); }
  return d;
})();

/** Every triangle a thing shows, in the stage's space: what lands on it lands on what is seen, never on a box round it. */
function triangles(root: T.Object3D, toStage: T.Matrix4, skip?: (o: T.Object3D) => boolean) {
  const verts: number[] = [], idx: number[] = [], v = new T.Vector3(), m = new T.Matrix4();
  root.updateWorldMatrix(true, true);
  root.traverse(o => {
    const mesh = o as T.Mesh;
    if (!mesh.isMesh || mesh.userData.blob || mesh.userData.noCollision || skip?.(mesh)) return;
    const position = mesh.geometry.getAttribute('position');
    if (!position) return;
    m.multiplyMatrices(toStage, mesh.matrixWorld);
    const base = verts.length / 3;
    for (let i = 0; i < position.count; i++) { v.fromBufferAttribute(position, i).applyMatrix4(m); verts.push(v.x, v.y, v.z); }
    const index = mesh.geometry.index;
    if (index) for (let i = 0; i < index.count; i++) idx.push(base + index.getX(i));
    else for (let i = 0; i < position.count; i++) idx.push(base + i);
  });
  return { verts, idx };
}
/** Andrew's monotone chain over the floor plane. */
function hull2d<P extends [number, number]>(points: P[]): P[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P[] = [], upper: P[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}
/** How far inside this outline a point lies (negative: outside). Counter-clockwise outline: inside is to the left of every edge. */
function depthInside(poly: [number, number][], x: number, z: number) {
  if (poly.length < 3) return -1;
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], ex = b[0] - a[0], ez = b[1] - a[1], len = Math.hypot(ex, ez) || 1;
    d = Math.min(d, (ex * (z - a[1]) - ez * (x - a[0])) / len);
  }
  return d;
}
/**
 * Who collides with whom: the room stays still, things land on it, the body and the mechanisms push things and each other. Furniture
 * being pushed meets the walls and the other furniture by its footprint; it never meets the body pushing it.
 */
const G_FIXED = 1, G_THING = 2, G_ACTOR = 4, G_MECH = 8, G_PUSHED = 16, G_FURN = 32;
const groups = (member: number, filter: number) => (member << 16) | filter;

/** A piece of furniture under the hands: Rapier moves it, the hands only bring force. */
interface PushState {
  id: string; body: RAPIER.RigidBody; entry: Entry;
  /** Newtons along the floor this frame, in the stage's axes; the yaw rate asked by the wheel. */
  force: T.Vector3; spin: number;
  breakaway: number; sliding: number; maxSpeed: number;
  moving: boolean; still: number;
  good: { x: number; z: number; yaw: number };
  prev: { x: number; z: number; yaw: number };
}

/** A hinged or sliding part: the hand drives it through a motor, Rapier keeps it inside its limits and against whatever is in the way. */
export interface Mechanism {
  /** Metres along the slide, or radians round the hinge. */
  value(): number;
  drive(target: number, strength?: number): void;
  /** Stopped by something it cannot move. */
  readonly speed: number;
  dispose(): void;
}

/**
 * A bounded Rapier world, one for the room, stepped at a fixed 60 Hz and only while something can move. Things in the hands are carried by
 * a bounded spring, so they stop at furniture and walls instead of going through; a thing let go falls, lands and settles, then its
 * resting place goes back to the layout and its body is gone. Never a second avatar or a network engine.
 */
export class StudyPhysics {
  private world: RAPIER.World;
  private fixed: RAPIER.Collider[] = [];
  /** Furniture surfaces share one owner; a rack retains its disconnected meshes. */
  private solids = new Map<string, { key: string; collider: RAPIER.Collider; colliders: RAPIER.Collider[]; rack?: RackMechanism; storage?: RackStorage }>();
  private rackGuides = new Map<string, { rack: string; key: string; slot: number; base: RAPIER.RigidBody; joint: RAPIER.PrismaticImpulseJoint }>();
  private roomSolid: { key: string; root: T.Object3D | null; colliders: RAPIER.Collider[] } | null = null;
  private bodies = new Map<string, Body>();
  private holds = new Map<number, Hold>();
  private workPathsScratch = new Map<Hold, { from: T.Vector3; rotation: T.Quaternion }>();
  private workPathPool = new WeakMap<Hold, { from: T.Vector3; rotation: T.Quaternion }>();
  private mechanisms = new Set<{ body: RAPIER.RigidBody; base: RAPIER.RigidBody; joint: RAPIER.ImpulseJoint; last: number; speed: number }>();
  private accumulator = 0;
  private disposed = false;
  private actor: RAPIER.RigidBody | null = null;
  private push: PushState | null = null;
  /** Left out of the room's colliders: the furniture being pushed and what rides on it. */
  private ignore = new Set<string>();
  /** The events of the step: what touched what, the moment it did. */
  private events: RAPIER.EventQueue;
  private entries: Entry[] = [];
  private roomSize = 6;
  /** Whose collider is this: resting things by their triangles, light floor things by the footprint that wakes them. */
  private solidOf_ = new Map<number, string>();
  private footOf = new Map<number, string>();
  private colliderOf = new Map<number, string>();
  private actorCollider: RAPIER.Collider | null = null;
  private pushCollider: RAPIER.Collider | null = null;
  /** What just came alive because something hit it. The world may want to know (a mug that fell, a lamp knocked over). */
  onWoken: ((id: string) => void) | null = null;
  /** Something moving hit the body: which, how fast, how heavy. */
  onBodyHit: ((id: string, vx: number, vz: number, kg: number) => void) | null = null;
  /** Where the middle of the thing has to be for the thing itself to stand here, turned this way. */
  centreFor(id: string, groupAt: T.Vector3, q: T.Quaternion, out: T.Vector3) {
    const r = this.bodies.get(id);
    if (!r) return out.copy(groupAt);
    _pQ1.copy(r.q0).invert();
    _pQ2.copy(q).multiply(_pQ1);
    return out.copy(r.center).applyQuaternion(_pQ2).add(groupAt);
  }
  /** A body came to rest against something, hard enough to hear. */
  onImpact: ((id: string, speed: number) => void) | null = null;

  constructor(private R: typeof RAPIER, private commit: (id: string, pos: [number, number, number], yaw: number, tilt: [number, number, number, number] | null) => void) {
    this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 60;
    this.events = new R.EventQueue(true);
    // Rapier answers rays and shape casts from the shapes as they stood at the last step. A pick rebuilds the room's colliders, a thing settling
    // turns its body into a solid, and a resting world takes no step at all: until told, a ray from a lifted kettle fell straight through the desk,
    // so nothing lifted it over the cups beside it. Every change to what exists marks the answers stale; the next question brings them up to date.
    const w = this.world as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const k of ['createCollider', 'removeCollider', 'createRigidBody', 'removeRigidBody']) { const f = w[k].bind(this.world); w[k] = (...a: unknown[]) => { this.stale = true; return f(...a); }; }
  }
  /** Shapes and places have changed since Rapier last indexed them for questions. */
  private stale = true;
  private sweepShapes = new WeakMap<RAPIER.Collider, RAPIER.Shape>();
  private routeShapes = new WeakMap<RAPIER.Collider, RAPIER.Shape>();
  private boundaryQueries: RigidToolQueryBounds | null = null;
  private sharedRay: RAPIER.Ray | null = null;
  private queryIgnoreId: string | null = null;
  private stepHitsScratch: [number, number][] = [];

  private ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): RAPIER.Ray {
    let r = this.sharedRay;
    if (!r) {
      r = new this.R.Ray({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz });
      this.sharedRay = r;
      return r;
    }
    r.origin.x = ox;
    r.origin.y = oy;
    r.origin.z = oz;
    r.dir.x = dx;
    r.dir.y = dy;
    r.dir.z = dz;
    return r;
  }

  /** Builds indexed convex faces once per collider so Rapier WASM shape casts skip O(N log N) QuickHull per query. */
  private indexedConvexFaces(points: Float32Array): { vertices: Float32Array; indices: Uint32Array } | null {
    if (points.length < 12) return null;
    const cloud: T.Vector3[] = [];
    for (let i = 0; i < points.length; i += 3) {
      cloud.push(new T.Vector3(points[i], points[i + 1], points[i + 2]));
    }
    const hull = new ConvexHull().setFromPoints(cloud);
    if (hull.faces.length < 4) return null;
    const vertices: number[] = [];
    const indices: number[] = [];
    const ids = new Map<T.Vector3, number>();
    for (const face of hull.faces) {
      let edge = face.edge;
      do {
        const p = edge.head().point;
        let id = ids.get(p);
        if (id === undefined) {
          id = ids.size;
          ids.set(p, id);
          vertices.push(p.x, p.y, p.z);
        }
        indices.push(id);
        edge = edge.next;
      } while (edge !== face.edge);
    }
    return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
  }

  private *queryParts(r: Body, from: T.Vector3, fromQ: T.Quaternion, to: T.Vector3, toQ: T.Quaternion, filter: number,
    memo: { selected?: RAPIER.Collider[] } = {}): Generator<RAPIER.Collider> {
    if (!memo.selected) {
      memo.selected = (this.boundaryQueries ??= new RigidToolQueryBounds(this.R)).select(this.scene, r.colliders, from, fromQ, to, toQ, filter, this.notHeld);
    }
    yield* memo.selected;
  }
  /** Reuse Rapier's already-built convex faces for queries. Rebuilding a convex
   * hull from the authored point cloud on every sweep dominated route planning.
   * These are the collider's exact vertices/indices; no collision is resized. */
  private sweepShape(collider: RAPIER.Collider, clearance = false) {
    const cache = clearance ? this.routeShapes : this.sweepShapes;
    let shape = cache.get(collider);
    if (!shape) {
      shape = collider.shape;
      if (shape instanceof this.R.ConvexPolyhedron) {
        // Keep the validated descriptor faces. When a collider was created via
        // `ColliderDesc.convexHull`, pre-index its faces once so WASM `intoRaw()`
        // takes the fast `convexMesh` path instead of recomputing 3D QuickHull per frame.
        let vertices = shape.vertices, indices = shape.indices;
        if (vertices && !indices) {
          const built = this.indexedConvexFaces(vertices);
          if (built) { vertices = built.vertices; indices = built.indices; }
        }
        if (vertices && indices) shape = clearance ? new this.R.RoundConvexPolyhedron(vertices, indices, .003) : new this.R.ConvexPolyhedron(vertices, indices);
      } else if (clearance && shape instanceof this.R.Triangle) shape = new this.R.RoundTriangle(shape.a, shape.b, shape.c, .003);
      cache.set(collider, shape);
    }
    return shape;
  }
  /** The world, its question index brought up to date first: every ray and shape cast goes through here. */
  private get scene() {
    if (this.stale) { this.world.updateSceneQueries(); this.stale = false; }
    return this.world;
  }
  static canPick(obj: SpaceObject) { return !obj.hidden && !obj.locked && affordanceOf(obj.kind).mobility === 'portable'; }
  owns(id: string) { return this.bodies.has(id); }
  private cachedHeldIds: string[] = [];
  private heldIdsDirty = false;
  /** The thing in a hand. With no side, whichever hand has one. */
  heldIn(side: number) { return this.holds.get(side)?.id ?? null; }
  get holding() { return this.holds.get(1)?.id ?? this.holds.get(-1)?.id ?? null; }
  isHeld(id: string) { return this.sideOf(id) !== null; }
  get heldIds(): readonly string[] {
    if (this.heldIdsDirty) {
      this.cachedHeldIds.length = 0;
      for (const h of this.holds.values()) {
        if (!this.cachedHeldIds.includes(h.id)) this.cachedHeldIds.push(h.id);
      }
      this.heldIdsDirty = false;
    }
    return this.cachedHeldIds;
  }
  sideOf(id: string) { for (const [side, h] of this.holds) if (h.id === id) return side; return null; }
  pointOf(id: string): T.Vector3 | null { const p = this.bodies.get(id)?.body.translation(); return p ? new T.Vector3(p.x, p.y, p.z) : null; }
  /** Planning reads the physics pose; the interpolated drawing is observation only. */
  groupRotationOf(id: string) {
    const b = this.bodies.get(id), q = b?.body.rotation();
    return b && q ? new T.Quaternion(q.x, q.y, q.z, q.w).multiply(b.q0) : null;
  }
  /** Duration of the next consumed physics window, shared by bounded commands. */
  motionStepSeconds(dt: number) {
    const steps = Math.min(MAX_STEPS_PER_FRAME, Math.floor(Math.min(MAX_ACCUMULATOR, this.accumulator + dt) / FIXED_STEP));
    return Math.max(1, steps) * FIXED_STEP;
  }
  willStep(dt: number) { return this.accumulator + dt >= FIXED_STEP; }
  get point(): T.Vector3 | null { const id = this.holding; return id ? this.pointOf(id) : null; }
  /** The body's turn about the vertical, the way a hand holds it upright. */
  yawOf(id: string) { const r = this.bodies.get(id)?.body.rotation(); return r ? extractPreservedYaw(r) : 0; }

  private queryCapsule: { half: number; radius: number; shape: RAPIER.Capsule } | null = null;
  private queryCuboids = new Map<string, RAPIER.Cuboid>();
  private actorBaseHalf = 0.6;
  private actorRadius = 0.2;
  /** Rebuilds the Rapier actor capsule safely for custom Character Creator height/build proportions. */
  setActorHeight(standingHeightM: number, buildScale = 1) {
    if (this.disposed) return;
    const h = Number.isFinite(standingHeightM) ? standingHeightM : 1.7;
    const b = Number.isFinite(buildScale) ? buildScale : 1;
    const nextHalf = T.MathUtils.clamp((h - 0.50) * 0.5, 0.45, 0.76);
    const nextRadius = T.MathUtils.clamp(0.20 * (0.65 + 0.35 * b), 0.18, 0.23);
    if (Math.abs(nextHalf - this.actorBaseHalf) < 1e-4 && Math.abs(nextRadius - this.actorRadius) < 1e-4) return;
    this.actorBaseHalf = nextHalf;
    this.actorRadius = nextRadius;
    this.queryCapsule = null;
    if (this.actorCollider) {
      this.actorCollider.setHalfHeight(nextHalf);
      this.actorCollider.setRadius(nextRadius);
      this.actorHalf = nextHalf;
    }
  }
  /** The body stands in the room: what is dropped lands beside it, and it can nudge what lies on the floor. */
  /** Same capsule and sole height for admission and for physical contact. */
  /** `lower`: how far a crouch takes the head down, metres (`CROUCH.eye` × amount): the capsule shortens by as much. */
  actorFits(x: number, z: number, lower: number, floor = 0) {
    const half = Math.max(.05, this.actorBaseHalf - lower / 2);
    if (!this.queryCapsule || Math.abs(this.queryCapsule.half - half) > 1e-4 || Math.abs(this.queryCapsule.radius - this.actorRadius) > 1e-4) {
      this.queryCapsule = { half, radius: this.actorRadius, shape: new this.R.Capsule(half, this.actorRadius) };
    }
    _pQueryPos.x = x; _pQueryPos.y = floor + half + this.actorRadius + 0.05; _pQueryPos.z = z;
    _pQueryRot.x = 0; _pQueryRot.y = 0; _pQueryRot.z = 0; _pQueryRot.w = 1;
    const hit = this.scene.intersectionWithShape(_pQueryPos, _pQueryRot,
      this.queryCapsule.shape, undefined, undefined, this.actorCollider ?? undefined, undefined, c => {
        if (c.isSensor() || (c.collisionGroups() >>> 16) === G_FURN) return false;
        const id = this.colliderOf.get(c.handle);
        return !id || this.sideOf(id) === null;
      });
    return !hit;
  }
  vehicleFits(x: number, z: number, floor: number, yaw: number, halfWidth: number, halfLength: number) {
    const key = `${halfWidth.toFixed(3)}:${halfLength.toFixed(3)}`;
    let shape = this.queryCuboids.get(key);
    if (!shape) {
      if (this.queryCuboids.size > 16) this.queryCuboids.clear();
      shape = new this.R.Cuboid(halfWidth, .55, halfLength);
      this.queryCuboids.set(key, shape);
    }
    _pQueryPos.x = x; _pQueryPos.y = floor + .75; _pQueryPos.z = z;
    _pQueryRot.x = 0; _pQueryRot.y = Math.sin(yaw / 2); _pQueryRot.z = 0; _pQueryRot.w = Math.cos(yaw / 2);
    return !this.scene.intersectionWithShape(_pQueryPos, _pQueryRot, shape,
      undefined, undefined, this.actorCollider ?? undefined, undefined, c => !c.isSensor());
  }
  private actorHalf = .6;
  /** Enables or suppresses the standing actor capsule (disabled while seated/rising so a player never kicks their own chair). */
  setActorEnabled(enabled: boolean) {
    if (this.disposed || !this.actorCollider) return;
    if (this.actorCollider.isEnabled() !== enabled) {
      this.actorCollider.setEnabled(enabled);
      this.stale = true;
    }
  }
  /** `floor`: the height the body stands on (the house's lower floor, a stair); the room's own is 0. */
  actorAt(x: number, z: number, lower = 0, floor = 0) {
    if (this.disposed) return;
    if (!this.actor) {
      this.actor = this.world.createRigidBody(this.R.RigidBodyDesc.kinematicPositionBased().setTranslation(x, this.actorBaseHalf + this.actorRadius + 0.05, z));
      this.actorCollider = this.world.createCollider(this.R.ColliderDesc.capsule(this.actorBaseHalf, this.actorRadius).setFriction(.6).setCollisionGroups(groups(G_ACTOR, G_THING | G_MECH)).setActiveEvents(this.R.ActiveEvents.COLLISION_EVENTS), this.actor);
      this.actorHalf = this.actorBaseHalf;
    } else if (this.actorCollider && !this.actorCollider.isEnabled()) {
      this.actorCollider.setEnabled(true);
      this.stale = true;
    }
    const half = Math.max(.05, this.actorBaseHalf - lower / 2);
    if (Math.abs(this.actorHalf - half) > 1e-5) { this.actorCollider!.setHalfHeight(half); this.actorHalf = half; }
    _pQueryPos.x = x; _pQueryPos.y = floor + half + this.actorRadius + 0.05; _pQueryPos.z = z;
    this.actor.setNextKinematicTranslation(_pQueryPos);
  }

  private worldSolidBuckets = new Map<string, { sig: string; colliders: RAPIER.Collider[] }>();
  private parkedVehicleColliders: { sig: string; colliders: RAPIER.Collider[] } = { sig: '', colliders: [] };
  /**
   * Bucketed fixed world solids: chunk/building transitions update ONLY the changed bucket instead of
   * tearing down and rebuilding all 450+ city colliders and invalidating Rapier's entire BVH (`O(1)` per building).
   */
  setWorldSolidBucket(key: string, boxes: readonly WorldSolidBox[]) {
    if (this.disposed) return;
    const prev = this.worldSolidBuckets.get(key);
    if (!boxes.length) {
      if (!prev) return;
      for (const c of prev.colliders) this.world.removeCollider(c, false);
      this.worldSolidBuckets.delete(key);
      return;
    }
    const sig = solidBoxesSignature(boxes);
    if (prev && prev.sig === sig) return;
    if (prev) for (const c of prev.colliders) this.world.removeCollider(c, false);
    const colliders = boxes.map(b => this.world.createCollider(this.R.ColliderDesc.cuboid(b.hx, b.hy, b.hz).setTranslation(b.x, b.y, b.z)
      .setFriction(.8).setRestitution(.05).setCollisionGroups(groups(G_FIXED, G_THING | G_PUSHED))));
    this.worldSolidBuckets.set(key, { sig, colliders });
  }
  /** Registers yaw-oriented solid footprints for parked city/player vehicles (signature-cached, zero-cost steady state). */
  setParkedVehicleBoxes(boxes: readonly OrientedSolidBox[]) {
    if (this.disposed) return;
    if (!boxes.length) {
      if (!this.parkedVehicleColliders.colliders.length) return;
      for (const c of this.parkedVehicleColliders.colliders) this.world.removeCollider(c, false);
      this.parkedVehicleColliders.colliders.length = 0;
      this.parkedVehicleColliders.sig = '';
      return;
    }
    let h = 2166136261 >>> 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      h = Math.imul(h ^ (Math.round(b.x * 50) | 0) ^ ((Math.round(b.z * 50) | 0) << 1) ^ ((Math.round(b.yaw * 100) | 0) << 2), 16777619) >>> 0;
      h = Math.imul(h ^ (Math.round(b.hx * 50) | 0) ^ ((Math.round(b.hz * 50) | 0) << 1), 16777619) >>> 0;
    }
    const sig = `${boxes.length}:${h.toString(36)}`;
    if (sig === this.parkedVehicleColliders.sig) return;
    for (const c of this.parkedVehicleColliders.colliders) this.world.removeCollider(c, false);
    this.parkedVehicleColliders.colliders = boxes.map(b => {
      const halfYaw = b.yaw * 0.5;
      return this.world.createCollider(
        this.R.ColliderDesc.cuboid(b.hx, b.hy, b.hz)
          .setTranslation(b.x, b.y, b.z)
          .setRotation({ x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) })
          .setFriction(.75)
          .setRestitution(.05)
          .setCollisionGroups(groups(G_FIXED, G_THING | G_PUSHED)),
      );
    });
    this.parkedVehicleColliders.sig = sig;
  }
  removeWorldSolidBucket(key: string) {
    this.setWorldSolidBucket(key, []);
  }
  /**
   * Echo Life's house beyond the room: floors, stair treads, walls and furniture as fixed solids. Things land on them and the feet
   * find them (`surfaceBelow`); like the room's own walls they never stop the body's capsule (navigation does that).
   */
  setWorldSolids(boxes: readonly WorldSolidBox[]) {
    this.setWorldSolidBucket('__default__', boxes);
  }

  /** Echo Life's hall door, cut into the room's +x wall (stage metres): its opening, and whether the leaf is shut. */
  private doorway: { z: number; width: number; top: number } | null = null;
  private plug: RAPIER.Collider | null = null;
  private plugWanted = true;
  private extraPlugs: RAPIER.Collider[] = [];
  private extraPlugKey = '';
  private doorLeafColliders = new Map<
    string,
    { collider: RAPIER.Collider; hx: number; hy: number; hz: number; lastYaw: number; enabled: boolean }
  >();
  /** Takes effect at the next `sync` (the room's walls are rebuilt there). */
  setRoomDoorway(d: { z: number; width: number; top: number } | null) { this.doorway = d; }
  /** A shut leaf stops things like the wall around it; an open one lets a carried thing through. */
  setDoorwayOpen(open: boolean) { if (this.plugWanted === !open) return; this.plugWanted = !open; this.placePlug(); }
  /**
   * Per-door zero-churn Rapier collider sync: updates live swung leaf pose (`setTranslation` + `setRotation`)
   * and disables the doorway collider (`collider.setEnabled(false)`) once the door opens past passable threshold
   * so open doors NEVER block `actorFits`, carried props, or `surfaceBelow` foot raycasts.
   */
  syncDoorCollider(
    id: string,
    opts: {
      hingeX: number;
      hingeZ: number;
      floorY: number;
      width: number;
      height: number;
      thickness?: number;
      worldLeafYaw: number;
      swingAngle: number;
      isOpen: boolean;
    } | null,
  ) {
    if (this.disposed) return;
    const existing = this.doorLeafColliders.get(id);
    if (!opts) {
      if (existing) {
        if (existing.collider.isValid()) this.world.removeCollider(existing.collider, false);
        this.doorLeafColliders.delete(id);
        this.stale = true;
      }
      return;
    }
    const hx = Math.max(0.15, opts.width * 0.5);
    const hy = Math.max(0.4, opts.height * 0.5);
    const hz = Math.max(0.02, (opts.thickness ?? 0.05) * 0.5);
    const isOpenEnough = Math.abs(opts.swingAngle) >= 0.88 || (opts.isOpen && Math.abs(opts.swingAngle) > 0.55);
    const wantEnabled = !isOpenEnough;
    const cx = opts.hingeX + Math.cos(opts.worldLeafYaw) * hx;
    const cy = opts.floorY + hy;
    const cz = opts.hingeZ + Math.sin(opts.worldLeafYaw) * hx;
    const rotYaw = -opts.worldLeafYaw;
    const halfYaw = rotYaw * 0.5;

    if (!existing || Math.abs(existing.hx - hx) > 1e-3 || Math.abs(existing.hy - hy) > 1e-3) {
      if (existing?.collider.isValid()) this.world.removeCollider(existing.collider, false);
      const col = this.world.createCollider(
        this.R.ColliderDesc.cuboid(hx, hy, hz)
          .setTranslation(cx, cy, cz)
          .setRotation({ x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) })
          .setFriction(0.6)
          .setRestitution(0.05)
          .setCollisionGroups(groups(G_FIXED, G_THING | G_PUSHED))
          .setEnabled(wantEnabled),
      );
      this.doorLeafColliders.set(id, { collider: col, hx, hy, hz, lastYaw: opts.worldLeafYaw, enabled: wantEnabled });
      this.stale = true;
      return;
    }

    if (existing.enabled !== wantEnabled) {
      existing.collider.setEnabled(wantEnabled);
      existing.enabled = wantEnabled;
      this.stale = true;
    }
    if (wantEnabled && Math.abs(existing.lastYaw - opts.worldLeafYaw) > 1e-3) {
      existing.collider.setTranslation({ x: cx, y: cy, z: cz });
      existing.collider.setRotation({ x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) });
      existing.lastYaw = opts.worldLeafYaw;
      this.stale = true;
    }
  }
  /** Closed house/city doors also plug their openings so carried/dropped objects never pass through shut leaves. */
  setDoorPlugs(boxes: readonly { hx: number; hy: number; hz: number; x: number; y: number; z: number }[]) {
    if (this.disposed) return;
    const key = boxes.map(b => `${b.x.toFixed(2)},${b.y.toFixed(2)},${b.z.toFixed(2)}`).join('|');
    if (key === this.extraPlugKey) return;
    this.extraPlugKey = key;
    for (const c of this.extraPlugs) this.world.removeCollider(c, false);
    this.extraPlugs = boxes.map(b => this.world.createCollider(this.R.ColliderDesc.cuboid(b.hx, b.hy, b.hz)
      .setTranslation(b.x, b.y, b.z).setFriction(.8).setRestitution(.05).setCollisionGroups(groups(G_FIXED, G_THING | G_PUSHED))));
    this.stale = true;
  }
  private placePlug() {
    if (this.disposed) return;
    if (this.plug) { this.world.removeCollider(this.plug, false); this.plug = null; this.stale = true; }
    const d = this.doorway;
    if (!d || !this.plugWanted) return;
    this.plug = this.world.createCollider(this.R.ColliderDesc.cuboid(.06, d.top / 2, d.width / 2).setTranslation(this.roomSize / 2 + .08, d.top / 2, d.z)
      .setFriction(.8).setRestitution(.05).setCollisionGroups(groups(G_FIXED, G_THING | G_PUSHED)));
    this.stale = true;
  }

  sync(entries: Entry[], size: number) {
    if (this.disposed) return;
    this.entries = entries; this.roomSize = size;
    for (const [id, record] of this.bodies) {
      const current = entries.find(e => e.obj.id === id);
      if (!current || current.group !== record.entry.group || !StudyPhysics.canPick(current.obj)) {
        const side = this.sideOf(id);
        if (side !== null) this.release(side);
        this.removeRackGuide(id);
        for (const c of record.colliders) this.colliderOf.delete(c.handle); this.world.removeRigidBody(record.body); this.bodies.delete(id);
      } else if (
        this.sideOf(id) === null &&
        !sameSpaceObjectTransform(current.obj, record.layoutPos, record.layoutRotY, record.layoutQuat)
      ) {
        // Undo, Redo, or Reset Room explicitly restored a new layout transform while this unheld body was active:
        // drop the stale dynamic body with zero velocity and snap the group cleanly to the restored layout pose.
        this.discardDynamicBody(id, record);
        applySpaceObjectTransform(current.obj, current.group.position, current.group.quaternion);
        current.group.scale.setScalar(current.obj.scale);
        current.group.updateWorldMatrix(true, true);
      } else {
        record.entry = current;
        this.refreshMass(record);
      }
    }
    for (const collider of this.fixed) this.world.removeCollider(collider, false);
    this.fixed = []; this.footOf.clear();
    const alive = new Set<string>();
    const add = (hx: number, hy: number, hz: number, x: number, y: number, z: number, yaw = 0, member = G_FIXED, filter = G_THING, sensor = false) => {
      _pQ1.setFromAxisAngle(UP, yaw);
      const c = this.world.createCollider(this.R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setRotation({ x: _pQ1.x, y: _pQ1.y, z: _pQ1.z, w: _pQ1.w }).setFriction(.8).setRestitution(.05).setCollisionGroups(groups(member, filter)).setSensor(sensor));
      this.fixed.push(c);
      return c;
    };
    add(size / 2, .08, size / 2, 0, -.08, 0);
    for (const sign of [-1, 1]) {
      const d = this.doorway;
      if (sign > 0 && d) {
        // Echo Life: the hall door's opening is cut into the +x wall; the plug (`placePlug`) fills it while the leaf is shut.
        const z0 = d.z - d.width / 2, z1 = d.z + d.width / 2, x = size / 2 + .08;
        if (z0 > -size / 2) add(.08, 1.5, (z0 + size / 2) / 2, x, 1.5, (z0 - size / 2) / 2, 0, G_FIXED, G_THING | G_PUSHED);
        if (z1 < size / 2) add(.08, 1.5, (size / 2 - z1) / 2, x, 1.5, (z1 + size / 2) / 2, 0, G_FIXED, G_THING | G_PUSHED);
        add(.08, (3 - d.top) / 2, d.width / 2, x, (3 + d.top) / 2, d.z, 0, G_FIXED, G_THING | G_PUSHED);
      } else add(.08, 1.5, size / 2, sign * (size / 2 + .08), 1.5, 0, 0, G_FIXED, G_THING | G_PUSHED);
      add(size / 2, 1.5, .08, 0, 1.5, sign * (size / 2 + .08), 0, G_FIXED, G_THING | G_PUSHED);
    }
    this.placePlug();
    for (const entry of entries) {
      if (entry.obj.hidden || entry.obj.inside || this.bodies.has(entry.obj.id) || this.ignore.has(entry.obj.id)) continue;
      // Every piece standing on the floor is in the way of furniture being pushed: by its footprint, a little inside its edges.
      const item = CATALOG_BY_ID[entry.obj.kind];
      if (item?.place === 'floor' && !item.flat) {
        const s = entry.obj.scale, h = Math.max(.2, this.bounds(entry).getSize(_pV1).y);
        // Something light is not a wall: what is pushed into it wakes it, and from then on it is a body being shoved (and it may well go over).
        const light = StudyPhysics.canPick(entry.obj) && massNow(entry.obj.kind, entry.obj.state, affordanceOf(entry.obj.kind).mass) <= SHOVE_MOST;
        const foot = add(Math.max(.03, item.size[0] * s / 2 - .02), h / 2, Math.max(.03, item.size[1] * s / 2 - .02), entry.group.position.x, entry.group.position.y + h / 2, entry.group.position.z, entry.group.rotation.y, G_FURN, G_PUSHED, light);
        if (light) this.footOf.set(foot.handle, entry.obj.id);
      }
      alive.add(entry.obj.id);
      this.solidOf(entry);
    }
    for (const id of this.solids.keys()) if (!alive.has(id)) this.removeSolid(id);
  }

  private discardDynamicBody(id: string, record: Body) {
    this.setSourceRackWithdrawal(id, null);
    const side = this.sideOf(id);
    if (side !== null) {
      this.cancelSupportedRelease(side);
      this.holds.delete(side);
      this.heldIdsDirty = true;
    }
    this.removeRackGuide(id);
    if (!this.disposed && record.body.isValid()) {
      record.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      record.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      record.body.resetForces(false);
    }
    for (const c of record.colliders) this.colliderOf.delete(c.handle);
    this.bodies.delete(id);
    if (!this.disposed && record.body.isValid()) this.world.removeRigidBody(record.body);
  }

  /** Snaps a single object's Rapier state and scene group directly to its exact layout transform (`pos`, `rotY`, `quat`) with zero velocity. */
  syncObject(entry: Entry) {
    if (this.disposed) return;
    const id = entry.obj.id;
    const record = this.bodies.get(id);
    if (record) this.discardDynamicBody(id, record);
    applySpaceObjectTransform(entry.obj, entry.group.position, entry.group.quaternion);
    entry.group.scale.setScalar(entry.obj.scale);
    entry.group.updateWorldMatrix(true, true);
    if (entry.obj.hidden || entry.obj.inside) {
      this.removeSolid(id);
    } else {
      this.solidOf(entry);
    }
    this.stale = true;
  }

  /**
   * Resets all Rapier dynamic bodies, holds, rack guides, and pushed furniture cleanly to exact layout transforms
   * (`pos`, `rotY`, `quat`) with zero residual linear/angular velocity (`Reset Room` / full layout restore).
   */
  resetRoomBodies(entries: Entry[] = this.entries, size: number = this.roomSize) {
    if (this.disposed) return;
    for (const side of [...this.holds.keys()]) this.cancelSupportedRelease(side);
    this.holds.clear();
    this.cachedHeldIds.length = 0;
    this.heldIdsDirty = false;
    if (this.push) {
      if (this.push.body.isValid()) {
        this.push.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
        this.push.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
        this.world.removeRigidBody(this.push.body);
      }
      this.push = null;
      this.pushCollider = null;
    }
    this.ignore.clear();
    for (const id of [...this.rackGuides.keys()]) this.removeRackGuide(id);
    for (const [id, record] of [...this.bodies.entries()]) {
      this.discardDynamicBody(id, record);
    }
    this.events.clear();
    this.accumulator = 0;
    for (const entry of entries) {
      applySpaceObjectTransform(entry.obj, entry.group.position, entry.group.quaternion);
      entry.group.scale.setScalar(entry.obj.scale);
      entry.group.updateWorldMatrix(true, true);
    }
    this.sync(entries, size);
    this.stale = true;
  }

  /** Alias for `resetRoomBodies`: synchronizes all Rapier bodies and static solids to exact layout transforms. */
  syncAllToLayout(entries: Entry[] = this.entries, size: number = this.roomSize) {
    this.resetRoomBodies(entries, size);
  }
  private removeSolid(id: string) {
    const solid = this.solids.get(id);
    if (!solid) return;
    for (const [tool, guide] of this.rackGuides) if (guide.rack === id) this.removeRackGuide(tool);
    for (const hold of this.holds.values()) if (hold.rackTransfer === id) hold.rackTransfer = undefined;
    for (const collider of solid.rack?.colliders ?? []) this.solidOf_.delete(collider.handle);
    solid.rack?.dispose();
    for (const collider of solid.colliders) { this.solidOf_.delete(collider.handle); if (collider.isValid()) this.world.removeCollider(collider, false); }
    this.solids.delete(id);
  }
  /** A thing's own triangles: a mug lands on the desk's top, a book on the shelf board under it, nothing on the air inside a bounding box. */
  private solidOf(entry: Entry) {
    const g = entry.group, id = entry.obj.id;
    const sliders = g.userData.sliders as { open: number }[] | undefined;
    const r = (n: number) => Math.round(n * 2000) / 2000;
    const key = g.uuid + '|' + [g.position.x, g.position.y, g.position.z, g.quaternion.x, g.quaternion.y, g.quaternion.z, g.quaternion.w, g.scale.x, g.scale.y, g.scale.z].map(r).join() + '|' + (sliders?.map(s => r(s.open)).join() ?? '') + '|' + (entry.obj.state?.taken?.length ?? 0) + '|' + (entry.obj.state?.lid ?? 1);
    const had = this.solids.get(id);
    if (had?.key === key) return;
    if (had) this.removeSolid(id);
    const toStage = g.parent ? g.parent.matrixWorld.clone().invert() : new T.Matrix4();
    if (entry.obj.kind === 'rack.cleaning') {
      const rack = createRackMechanism(this.R, this.world, g, toStage);
      const storage = rackStorageSurface(this.R, g, toStage);
      const descriptors = fixedRackSurface(this.R, g, toStage, !!rack, !!storage);
      if (descriptors) {
        const colliders = descriptors.map(desc => this.world.createCollider(desc.setFriction(.8).setRestitution(.05).setCollisionGroups(groups(G_FIXED, G_THING | (rack ? G_MECH : 0)))));
        if (storage) for (const part of storage.parts) {
          const collider = this.world.createCollider(part.descriptor.setFriction(.4).setRestitution(0).setCollisionGroups(groups(G_FIXED, G_THING | G_MECH)));
          colliders.push(collider);
          if (part.role !== 'mount') {
            if (!storage.handles.has(part.slot)) storage.handles.set(part.slot, new Set());
            storage.handles.get(part.slot)!.add(collider.handle);
          }
        }
        if (rack) colliders.push(...rack.colliders);
        this.solids.set(id, { key, collider: colliders[0], colliders, rack: rack ?? undefined, storage: storage ?? undefined });
        for (const collider of colliders) this.solidOf_.set(collider.handle, id);
        if (this.withdrawingRackIds.has(id)) this.syncWithdrawingRackGroups(id);
        return;
      }
      rack?.dispose();
    }
    const { verts, idx } = triangles(g, toStage);
    if (idx.length < 3) return;
    const vertices = new Float32Array(verts), indices = new Uint32Array(idx);
    // CCD against a chair's single enclosing mesh visits its wheels, seat and
    // back even when a sweeping tool can only reach the legs. Keep every face.
    const parts = entry.obj.kind === 'chair.office' ? roomSurfaceParts(vertices, indices) : [{ vertices, indices }];
    const colliders = parts.map(part => this.world.createCollider(this.R.ColliderDesc.trimesh(part.vertices, part.indices)
      .setFriction(.8).setRestitution(.05).setCollisionGroups(groups(G_FIXED, G_THING))));
    this.solids.set(id, { key, collider: colliders[0], colliders });
    for (const collider of colliders) this.solidOf_.set(collider.handle, id);
  }
  /** The room's own surfaces (window sills, frames, skirting): what stands on them stands on what is seen. Curtains, doors and the sash move and are left out. */
  roomSurfaces(room: T.Object3D | null, key: string) {
    if (this.disposed || (this.roomSolid?.key === key && this.roomSolid.root === room)) return;
    for (const collider of this.roomSolid?.colliders ?? []) this.world.removeCollider(collider, false);
    this.roomSolid = { key, root: room, colliders: [] };
    this.stale = true;
    if (!room) return;
    const toStage = room.parent ? room.parent.matrixWorld.clone().invert() : new T.Matrix4();
    const { verts, idx } = triangles(room, toStage, o => !!(o.userData.curtain || o.userData.portal || o.userData.roomWindow));
    if (idx.length < 3) return;
    for (const part of roomSurfaceParts(new Float32Array(verts), new Uint32Array(idx)))
      this.roomSolid.colliders.push(this.world.createCollider(this.R.ColliderDesc.trimesh(part.vertices, part.indices).setFriction(.8).setRestitution(.05).setCollisionGroups(groups(G_FIXED, G_THING))));
  }
  private bounds(entry: Entry) {
    entry.group.updateWorldMatrix(true, true);
    const box = new T.Box3().setFromObject(entry.group);
    const parent = entry.group.parent;
    return parent ? box.applyMatrix4(parent.matrixWorld.clone().invert()) : box;
  }

  private ensureBody(entry: Entry, velocity?: T.Vector3) {
    let record = this.bodies.get(entry.obj.id);
    if (record) { record.entry = entry; this.refreshMass(record); return record; }
    if (this.bodies.size >= MAX_BODIES) return null;

    const savedPos = entry.group.position.clone();
    const savedQuat = entry.group.quaternion.clone().normalize();
    const a = affordanceOf(entry.obj.kind), kg = massNow(entry.obj.kind, entry.obj.state, a.mass);
    const initialExtent = this.bounds(entry).getSize(new T.Vector3()).multiplyScalar(.5);
    const massHalfExtents = new T.Vector3(
      Math.max(.025, initialExtent.x),
      Math.max(.012, initialExtent.y),
      Math.max(.025, initialExtent.z),
    );

    let hx = 0.025, hy = 0.012, hz = 0.025;
    let hull: Float32Array;
    const shapes: RAPIER.ColliderDesc[] = [];
    const localCenter = new T.Vector3();
    let sKey: ReturnType<typeof storageKey>;

    // Evaluate collider hulls, compound parts, storage key, and base Center-of-Mass strictly
    // in the canonical upright object frame (`quaternion = Identity`), then spawn the Rapier
    // rigid body at `savedQuat` with `q0 = Identity` so `q_fallen` is NEVER baked into colliders!
    entry.group.quaternion.set(0, 0, 0, 1);
    try {
      const canonicalBox = this.bounds(entry);
      const extent = canonicalBox.getSize(new T.Vector3()).multiplyScalar(.5);
      const canonicalCenter = canonicalBox.getCenter(new T.Vector3());
      localCenter.copy(canonicalCenter).sub(savedPos);
      hx = Math.max(.025, extent.x);
      hy = Math.max(.012, extent.y);
      hz = Math.max(.025, extent.z);
      hull = this.hullOf(entry, canonicalCenter)
        ?? new Float32Array([-hx, -hy, -hz, hx, -hy, -hz, -hx, -hy, hz, hx, -hy, hz, -hx, hy, -hz, hx, hy, -hz, -hx, hy, hz, hx, hy, hz]);

      if ((toolOf(entry.obj.kind)?.length ?? 0) > .5) {
        const parts: T.Object3D[] = [];
        entry.group.traverse(o => { if ((o as T.Mesh).isMesh && !o.userData.noCollision && !o.userData.blob) parts.push(o); });
        if (parts.length <= 12) for (const part of parts) {
          const toStage = entry.group.parent ? entry.group.parent.matrixWorld.clone().invert() : new T.Matrix4();
          try {
            const surface = rigidToolSurface(this.R, entry.obj.kind, part, toStage, canonicalCenter);
            if (surface) { shapes.push(...surface); continue; }
          } catch { shapes.length = 0; break; }
          const points = this.hullOf(entry, canonicalCenter, part);
          let shape: RAPIER.ColliderDesc | null = null;
          try { if (points) shape = this.partShape(points); } catch { /* use the complete fallback below */ }
          if (!shape) { shapes.length = 0; break; }
          shapes.push(shape);
        }
      }
      sKey = storageKey(entry.group);
    } finally {
      entry.group.quaternion.copy(savedQuat);
      entry.group.updateWorldMatrix(true, true);
    }

    if (!shapes.length) {
      let shape: RAPIER.ColliderDesc | null = null;
      try { shape = this.R.ColliderDesc.convexHull(hull); } catch { shape = null; }
      shapes.push(shape ?? this.R.ColliderDesc.cuboid(hx, hy, hz));
    }

    // Canonical upright CoM: centered over the object's true feet/base for ALL furniture and props.
    let low = Infinity, up = -Infinity, sweepRadius = 0;
    for (let i = 0; i < hull.length; i += 3) {
      low = Math.min(low, hull[i + 1]); up = Math.max(up, hull[i + 1]);
      sweepRadius = Math.max(sweepRadius, Math.hypot(hull[i], hull[i + 1], hull[i + 2]));
    }
    let cx = 0, cz = 0, n = 0;
    const baseBand = Math.max(.012, (up - low) * .08);
    for (let i = 0; i < hull.length; i += 3) {
      if (hull[i + 1] <= low + baseBand) { cx += hull[i]; cz += hull[i + 2]; n++; }
    }
    const com = new T.Vector3(n ? cx / n : 0, low + (up - low) * .38, n ? cz / n : 0);

    const bodyCenter = savedPos.clone().add(localCenter.clone().applyQuaternion(savedQuat));
    const body = this.world.createRigidBody(
      this.R.RigidBodyDesc.dynamic()
        .setTranslation(bodyCenter.x, bodyCenter.y, bodyCenter.z)
        .setRotation({ x: savedQuat.x, y: savedQuat.y, z: savedQuat.z, w: savedQuat.w })
        .setLinearDamping(HELD_LINEAR_DAMPING)
        .setAngularDamping(HELD_ANGULAR_DAMPING)
        .setCcdEnabled(true),
    );

    const inertia = massInertia(kg, massHalfExtents);
    const colliders = shapes.map((desc, i) => {
      if (i === 0) desc.setMassProperties(kg, com, inertia, { x: 0, y: 0, z: 0, w: 1 });
      else desc.setDensity(0);
      const c = this.world.createCollider(desc.setFriction(REST_FRICTION).setRestitution(a.material === 'cloth' ? .01 : .03).setCollisionGroups(groups(G_THING, G_FIXED | G_THING | G_ACTOR | G_MECH | G_PUSHED)).setActiveEvents(this.R.ActiveEvents.COLLISION_EVENTS), body);
      this.colliderOf.set(c.handle, entry.obj.id);
      return c;
    });
    const collider = colliders[0];
    if (velocity) body.setLinvel({ x: velocity.x, y: velocity.y, z: velocity.z }, true);
    const rawPos = entry.obj.pos ?? [savedPos.x, savedPos.y, savedPos.z];
    const layoutPos: [number, number, number] = [rawPos[0], rawPos[1], rawPos[2]];
    const layoutRotY = entry.obj.rotY ?? 0;
    const layoutQuat: QuatTuple | undefined = entry.obj.quat
      ? [entry.obj.quat[0], entry.obj.quat[1], entry.obj.quat[2], entry.obj.quat[3]]
      : undefined;
    record = {
      body,
      collider,
      colliders,
      hull,
      sweepRadius,
      com,
      massHalfExtents,
      radius: Math.hypot(hx, hz),
      entry,
      center: localCenter,
      start: savedPos,
      startQuat: savedQuat.clone(),
      q0: new T.Quaternion(0, 0, 0, 1),
      layoutPos,
      layoutRotY,
      layoutQuat,
      surfaceDamped: false,
      storageKey: sKey,
      time: 0,
      contacted: false,
      lastSpeed: 0,
      prevP: bodyCenter.clone(),
      prevQ: savedQuat.clone(),
      kg,
      before: new T.Vector3(),
      restP: bodyCenter.clone(),
      restQ: savedQuat.clone(),
      restT: 0,
    };
    this.bodies.set(entry.obj.id, record);
    return record;
  }

  /** Water changes while the same body is held or settling. Update its one
   * mass owner without rebuilding colliders, moving it or rebinding the grasp. */
  private refreshMass(record: Body) {
    const { obj } = record.entry, kg = massNow(obj.kind, obj.state, affordanceOf(obj.kind).mass);
    if (kg === record.kg) return;
    const side = this.sideOf(obj.id), hold = side === null ? null : this.holds.get(side);
    if (side !== null) this.cancelSupportedRelease(side);
    if (hold?.force) { record.body.addForce(hold.force.clone().negate(), true); hold.force = undefined; }
    record.collider.setMassProperties(kg, record.com, massInertia(kg, record.massHalfExtents), { x: 0, y: 0, z: 0, w: 1 });
    // Rapier otherwise defers this until its next step; release queries and
    // collision bookkeeping must already see the new weight this frame.
    record.body.recomputeMassPropertiesFromColliders();
    record.kg = kg;
    record.time = 0; record.restT = 0;
    const p = record.body.translation(), q = record.body.rotation();
    record.restP.set(p.x, p.y, p.z); record.restQ.set(q.x, q.y, q.z, q.w);
    record.body.wakeUp();
  }

  /** The points of a thing's shape relative to its centre, thinned evenly: its collider, and what the placement check turns and measures. */
  /** Build faces with double-precision QuickHull before Rapier stores them as
   * floats. Its point-cloud hull can return inward/non-supporting faces for a
   * rotated, centimetre-wide metre-long shaft. Explicit convex faces keep the
   * authored envelope and avoid rebuilding the hull for every scene query. */
  private partShape(points: Float32Array) {
    const cloud: T.Vector3[] = [];
    for (let i = 0; i < points.length; i += 3) cloud.push(new T.Vector3(points[i], points[i + 1], points[i + 2]));
    const hull = new ConvexHull().setFromPoints(cloud);
    if (hull.faces.length < 4) return null;
    const vertices: number[] = [], indices: number[] = [], ids = new Map<T.Vector3, number>();
    for (const face of hull.faces) {
      let edge = face.edge;
      do {
        const p = edge.head().point;
        let id = ids.get(p);
        if (id === undefined) { id = ids.size; ids.set(p, id); vertices.push(p.x, p.y, p.z); }
        indices.push(id); edge = edge.next;
      } while (edge !== face.edge);
    }
    return this.R.ColliderDesc.convexMesh(new Float32Array(vertices), new Uint32Array(indices));
  }
  private hullOf(entry: Entry, center: T.Vector3, part: T.Object3D = entry.group) {
    const toStage = entry.group.parent ? entry.group.parent.matrixWorld.clone().invert() : new T.Matrix4();
    // Mesh nodes may themselves parent meshes; each authored part owns only its
    // own triangles, while the aggregate hull still traverses the whole group.
    const { verts } = triangles(part, toStage, part === entry.group ? undefined : o => o !== part);
    const count = verts.length / 3;
    if (count < 4) return null;
    // A sparse set of support directions is only an approximation. In a long
    // tool it kept the bottom ring and narrowed tip, discarding full-width
    // shaft rings between them. Every vertex of each authored rigid part must
    // enter its hull; otherwise the collider is smaller than the visible tool.
    // Generic aggregate fallback retains its existing bounded approximation.
    const seen = new Set<number>(), out: number[] = [], stride = Math.max(1, Math.floor(count / 12000));
    let lo = Infinity, hi = -Infinity;
    if (part !== entry.group) {
      for (let i = 0; i < count; i++) {
        const y = verts[i * 3 + 1] - center.y;
        out.push(verts[i * 3] - center.x, y, verts[i * 3 + 2] - center.z);
        lo = Math.min(lo, y); hi = Math.max(hi, y);
      }
    } else for (const [dx, dy, dz] of HULL_DIRECTIONS) {
      let best = -Infinity, at = 0;
      for (let i = 0; i < count; i += stride) {
        const d = (verts[i * 3] - center.x) * dx + (verts[i * 3 + 1] - center.y) * dy + (verts[i * 3 + 2] - center.z) * dz;
        if (d > best) { best = d; at = i; }
      }
      if (seen.has(at)) continue;
      seen.add(at);
      const y = verts[at * 3 + 1] - center.y;
      out.push(verts[at * 3] - center.x, y, verts[at * 3 + 2] - center.z);
      lo = Math.min(lo, y); hi = Math.max(hi, y);
    }
    // Extremes sampled over a sphere describe the sides well, but may leave
    // just three off-centre points around a rounded base. Preserve the actual
    // perimeter at both contact depths used by lowest(), including each
    // perimeter vertex's original height. Interior vertices add no support.
    if (part === entry.group) {
      type BasePoint = [number, number] & { vertex: number };
      const bottom: BasePoint[] = [], band: BasePoint[] = [];
      for (let i = 0; i < count; i++) {
        const y = verts[i * 3 + 1] - center.y;
        if (y >= lo + .035) continue;
        const point = [verts[i * 3], verts[i * 3 + 2]] as BasePoint;
        point.vertex = i;
        band.push(point);
        if (y < lo + .012) bottom.push(point);
      }
      for (const point of [...hull2d(bottom), ...hull2d(band)]) {
        const i = point.vertex;
        if (seen.has(i)) continue;
        seen.add(i);
        out.push(verts[i * 3] - center.x, verts[i * 3 + 1] - center.y, verts[i * 3 + 2] - center.z);
      }
    }
    if (out.length < 12) return null;
    // Paper-thin things keep a body a contact can hold on to: below a centimetre the solver lets them through what they lie on.
    if (hi - lo < .012) { const extra = (.012 - (hi - lo)) / 2; for (let i = 1; i < out.length; i += 3) out[i] += out[i] < (lo + hi) / 2 ? -extra : extra; const k = out.length; for (let i = 0; i < k; i += 3) out.push(out[i], out[i + 1] < (lo + hi) / 2 ? hi + extra : lo - extra, out[i + 2]); }
    return new Float32Array(out);
  }
  /** How the thing itself stood when the body was made: a body's own turn is relative to this. */
  startOf(id: string) { return this.bodies.get(id)?.q0 ?? null; }
  /** Centre the foot in the well, retaining only poses supported by the actual saucer. */
  fitCupOnSaucer(id: string, saucer: string, well: T.Vector3, rotation: T.Quaternion) {
    const record = this.bodies.get(id);
    if (!record) return null;
    const { base } = this.lowest(record, rotation);
    if (base.length < 3) return null;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < base.length; i++) {
      const bx = base[i][0], bz = base[i][1];
      if (bx < minX) minX = bx;
      if (bx > maxX) maxX = bx;
      if (bz < minZ) minZ = bz;
      if (bz > maxZ) maxZ = bz;
    }
    const center = well.clone().sub(_pV1.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2));
    const radius = Math.min(maxX - minX, maxZ - minZ) / 2;
    // Real ceramic surfaces are curved. Allow the base to find a bearing
    // within half its radius while the rim and neighbouring objects remain solid.
    for (const offset of [0, radius / 4, radius / 2]) {
      for (let i = 0; i < (offset ? 8 : 1); i++) {
        const angle = i * Math.PI / 4, p = center.clone();
        p.x += offset * Math.cos(angle); p.z += offset * Math.sin(angle);
        p.y += .08;
        const hit = this.scene.castRay(this.ray(p.x, p.y, p.z, 0, -1, 0), .14, true, undefined, groups(G_THING, G_FIXED | G_THING), undefined, record.body, this.notHeld);
        if (!hit || (this.solidOf_.get(hit.collider.handle) ?? this.colliderOf.get(hit.collider.handle)) !== saucer) continue;
        p.y -= hit.toi;
        const fit = this.fit(id, p, rotation, false);
        if (fit.ok) return { fit, support: p };
      }
    }
    return null;
  }
  /** How far the thing reaches from its centre over the floor. */
  radiusOf(id: string) { return this.bodies.get(id)?.radius ?? .1; }
  /** Before crossing a worktop with a hanging vessel, find a clear lift.
   * If the lip is under the overhang, pull it toward the carrier first. */
  vesselLiftPath(id: string, root: T.Vector3, height: number) {
    const record = this.bodies.get(id), from = this.pointOf(id);
    if (!record || !from || from.y >= height) return [];
    const br = record.body.rotation(), q = new T.Quaternion(br.x, br.y, br.z, br.w);
    const retreat = root.clone().sub(from).setY(0);
    const clear = (a: T.Vector3, b: T.Vector3) => this.toolMotionFraction(record, a, q, b, q, false, false) >= 1 - 1e-7;
    const samples = Math.max(1, Math.ceil(retreat.length() / .02));
    for (let i = 0; i <= samples; i++) {
      const foot = from.clone().addScaledVector(retreat, i / samples);
      const raised = foot.clone().setY(height);
      if (clear(from, foot) && clear(foot, raised)) return i ? [foot, raised] : [raised];
    }
    return null;
  }
  /** The nearest thing a straight drop from this point lands on, within `far`: what is in front of a wall or under a shelf board. */
  surfaceBelow(from: T.Vector3, far: number, ignore?: string, out?: T.Vector3): T.Vector3 | null {
    const body = ignore ? this.bodies.get(ignore)?.body : undefined;
    const prevIgnore = this.queryIgnoreId;
    this.queryIgnoreId = ignore ?? null;
    try {
      const hit = this.scene.castRayAndGetNormal(
        this.ray(from.x, from.y, from.z, 0, -1, 0),
        far,
        true,
        undefined,
        groups(G_THING, G_FIXED | G_THING),
        undefined,
        body,
        this.queryFilter,
      );
      if (!hit || (hit.toi > 1e-4 && hit.normal.y < 0.35)) return null;
      return (out ?? new T.Vector3()).set(from.x, from.y - hit.toi, from.z);
    } finally {
      this.queryIgnoreId = prevIgnore;
    }
  }
  /** Alias for downward support raycast (`surfaceBelow`). */
  castSurface(from: T.Vector3, far: number, ignore?: string, out?: T.Vector3): T.Vector3 | null {
    return this.surfaceBelow(from, far, ignore, out);
  }
  /** Alias for downward drop-surface lookup (`surfaceBelow`). */
  dropSurface(from: T.Vector3, far: number, ignore?: string, out?: T.Vector3): T.Vector3 | null {
    return this.surfaceBelow(from, far, ignore, out);
  }
  /**
   * How high the middle of a carried thing has to be to pass over everything between where it is and `to`: the table it stood on and what else
   * stands there. Its own shape, turned the way the hand holds it, is lowered onto each point of the way, so a spout, a saucer wider than its cup
   * or a cup a few centimetres across are all under it wherever they stand (a grid of rays stepped over them). Null: nothing but the floor.
   */
  clearanceAlong(id: string, to: T.Vector3): number | null {
    const record = this.bodies.get(id), at = this.pointOf(id);
    if (!record || !at) return null;
    const outside = this.worldSolidBuckets.size > 0 && (Math.abs(at.x) > this.roomSize / 2 || Math.abs(at.z) > this.roomSize / 2);
    const floorY = outside ? (this.surfaceBelow(_pV1.set(at.x, at.y + .05, at.z), 3, id, _pV2)?.y ?? -3.2) : 0;
    if (at.y - floorY < .3) return null;
    const r = record.body.rotation();
    _fitCastRot.x = r.x; _fitCastRot.y = r.y; _fitCastRot.z = r.z; _fitCastRot.w = r.w;
    const low = this.lowest(record, _pQ1.set(r.x, r.y, r.z, r.w)).y;
    const dx = to.x - at.x, dz = to.z - at.z, len = Math.min(.5, Math.hypot(dx, dz)), ux = len > 1e-3 ? dx / len : 1, uz = len > 1e-3 ? dz / len : 0;
    // From a little above it: a shelf overhead is above what lifts past it, and a cast that starts inside something learns nothing.
    const up = .26, filter = groups(G_THING, G_FIXED | G_THING), maxToi = up + .5;
    let need: number | null = null;
    const prevIgnore = this.queryIgnoreId;
    this.queryIgnoreId = id;
    try {
      for (let along = 0; along <= len + 1e-3; along += .04) {
        _fitCastStart.x = at.x + ux * along;
        _fitCastStart.y = at.y + up;
        _fitCastStart.z = at.z + uz * along;
        let bestToi = Infinity;
        for (let i = 0; i < record.colliders.length; i++) {
          const shape = this.sweepShape(record.colliders[i], false);
          const hit = this.scene.castShape(_fitCastStart, _fitCastRot, _downDir, shape, maxToi, true, undefined, filter, undefined, record.body, this.queryFilter);
          if (hit && hit.toi < bestToi) bestToi = hit.toi;
        }
        if (!Number.isFinite(bestToi) || bestToi < 1e-4) continue;
        const y = _fitCastStart.y - bestToi;
        // What it would come to rest on at the floor is not something to lift over.
        if (y + low - floorY < .2) continue;
        if (need === null || y > need) need = y;
      }
    } finally {
      this.queryIgnoreId = prevIgnore;
    }
    return need;
  }
  /** How far a straight line goes from this point before it meets what stands there, up to `len`: room beside the body for what hangs from a hand. */
  roomAlong(from: T.Vector3, dir: T.Vector3, len: number) {
    const hit = this.scene.castRay(this.ray(from.x, from.y, from.z, dir.x, dir.y, dir.z), len, true, undefined, groups(G_THING, G_FIXED), undefined, undefined, this.notHeld);
    return hit ? hit.toi : len;
  }
  private notHeld = (c: RAPIER.Collider) => {
    if (c.isSensor() || (c.collisionGroups() >>> 16) === G_FURN) return false;
    const id = this.colliderOf.get(c.handle) ?? this.solidOf_.get(c.handle) ?? this.footOf.get(c.handle);
    if (id !== undefined && this.withdrawingRackIds.has(id)) return false;
    return id === undefined || this.sideOf(id) === null;
  };
  private queryFilter = (c: RAPIER.Collider) => {
    if (c.isSensor() || (c.collisionGroups() >>> 16) === G_FURN) return false;
    const id = this.colliderOf.get(c.handle) ?? this.solidOf_.get(c.handle) ?? this.footOf.get(c.handle);
    if (id !== undefined && (id === this.queryIgnoreId || this.sideOf(id) !== null || this.withdrawingRackIds.has(id))) return false;
    return true;
  };
  private sourceRackWithdrawals = new Map<string, string>();
  private withdrawingRackIds = new Set<string>();

  /**
   * Suppresses self-rack solver & sweep blocking right after express-equipping a long tool off `rack.cleaning`
   * until the player walks `> 1.10 m` clear of that rack (or starts hanging back / releases the tool).
   */
  setSourceRackWithdrawal(toolId: string, rackId: string | null) {
    if (rackId) this.removeRackGuide(toolId);
    const prev = this.sourceRackWithdrawals.get(toolId);
    if (prev && prev !== rackId) {
      this.sourceRackWithdrawals.delete(toolId);
      this.syncWithdrawingRackGroups(prev);
    }
    if (rackId && this.solids.has(rackId)) {
      this.sourceRackWithdrawals.set(toolId, rackId);
      this.syncWithdrawingRackGroups(rackId);
    } else if (prev) {
      this.sourceRackWithdrawals.delete(toolId);
      this.syncWithdrawingRackGroups(prev);
    }
  }

  private syncWithdrawingRackGroups(rackId: string) {
    let stillActive = false;
    for (const rId of this.sourceRackWithdrawals.values()) {
      if (rId === rackId) { stillActive = true; break; }
    }
    if (stillActive) this.withdrawingRackIds.add(rackId);
    else this.withdrawingRackIds.delete(rackId);
    const solid = this.solids.get(rackId);
    if (!solid) return;
    const storageHandles = new Set<number>();
    if (solid.storage) {
      for (const set of solid.storage.handles.values()) {
        for (const h of set) storageHandles.add(h);
      }
    }
    const fingerHandles = new Set<number>();
    if (solid.rack) {
      for (const f of solid.rack.fingers) {
        for (const fc of f.colliders) fingerHandles.add(fc.handle);
      }
    }
    for (const c of solid.colliders) {
      if (!c.isValid()) continue;
      if (fingerHandles.has(c.handle)) {
        c.setCollisionGroups(
          stillActive
            ? groups(G_MECH, G_FIXED | G_MECH)
            : groups(G_MECH, G_FIXED | G_THING | G_MECH),
        );
        continue;
      }
      if (stillActive) {
        c.setCollisionGroups(groups(G_FIXED, G_PUSHED | (solid.rack ? G_MECH : 0)));
      } else if (storageHandles.has(c.handle)) {
        c.setCollisionGroups(groups(G_FIXED, G_THING | G_MECH));
      } else {
        c.setCollisionGroups(groups(G_FIXED, G_THING | (solid.rack ? G_MECH : 0)));
      }
    }
  }

  private refreshSourceRackWithdrawalDistance(toolId: string, posX: number, posZ: number) {
    const rackId = this.sourceRackWithdrawals.get(toolId);
    if (!rackId) return;
    const rackEntry = this.entries.find(e => e.obj.id === rackId);
    if (!rackEntry) {
      this.setSourceRackWithdrawal(toolId, null);
      return;
    }
    if (Math.hypot(posX - rackEntry.group.position.x, posZ - rackEntry.group.position.z) > 1.12) {
      this.setSourceRackWithdrawal(toolId, null);
    }
  }
  /**
   * Admit a root motion only while every carried shape can follow its established hand frame.
   * Query the requested pose, not the lagging spring body: otherwise the body can keep walking
   * through a blocked hand. Linear sweeps cover translation; short angular intervals and exact
   * overlap checks cover rotation. An existing contact may separate, but may not deepen.
   */
  heldMotionFraction(from: T.Vector3, to: T.Vector3, turn: number, maximum = 1): number {
    if (!this.holds.size || maximum <= 0) return maximum;
    const translation = _hmTrans.copy(to).sub(from), distance = translation.length();
    if (distance + Math.abs(turn) < 1e-8) return maximum;
    const scene = this.scene, filter = groups(G_THING, G_FIXED | G_THING | G_MECH | G_PUSHED);
    let allowed = maximum;
    for (const id of this.heldIds) {
      let h: Hold | undefined;
      for (const candidate of this.holds.values()) {
        if (candidate.id === id) { h = candidate; break; }
      }
      const r = this.bodies.get(id);
      if (!h || !r) continue;
      // A working tool can be pressed against an obstruction. The actual
      // collision-limited pose, not the unreachable target, travels with feet.
      const bp = r.body.translation();
      if (h.working) {
        _hmOrigin.set(bp.x, bp.y, bp.z).sub(from);
      } else {
        _hmOrigin.copy(h.target).sub(from);
      }
      const br = r.body.rotation();
      if (!h.working && h.rotation) _hmRot.copy(h.rotation);
      else _hmRot.set(br.x, br.y, br.z, br.w);
      const radius = _hmOrigin.length() + r.sweepRadius;
      // At most 4 mm of surface travel per angular interval (or 20 mm for real-time gameplay tool turns).
      const range = allowed;
      this.refreshSourceRackWithdrawalDistance(id, bp.x, bp.z);
      const fastSweepTool = (h.working || Math.abs(turn) <= 0.40) && Boolean(toolOf(r.entry.obj.kind)) && !this.rackGuides.has(id);
      const arcStep = fastSweepTool ? .020 : .004;
      const rawSteps = Math.max(1, Math.ceil(range * Math.abs(turn) * radius / arcStep));
      const steps = fastSweepTool ? Math.min(12, rawSteps) : rawSteps;
      const writePose = (t: number, outP: T.Vector3, outQ: T.Quaternion) => {
        _hmTurnQ.setFromAxisAngle(UP, turn * t);
        outP.copy(_hmOrigin).applyQuaternion(_hmTurnQ).add(from).addScaledVector(translation, t);
        outQ.copy(_hmTurnQ).multiply(_hmRot);
      };
      const bounds = this.boundaryQueries ??= new RigidToolQueryBounds(this.R);
      const candidates = (a: number, b: number) => {
        writePose(a, _hmStartP, _hmStartQ);
        writePose(b, _hmEndP, _hmEndQ);
        const angle = Math.abs(turn * (b - a));
        const chordError = Math.hypot(_hmOrigin.x, _hmOrigin.z) * Math.min(2, angle * angle / 8);
        return bounds.select(scene, r.colliders, _hmStartP, _hmStartQ, _hmEndP, _hmEndQ, filter, this.notHeld, { angle, chordError });
      };
      const broad = candidates(0, range);
      if (!broad.length) continue;
      const blockSize = 16;
      const subdivide = steps > blockSize && broad.some(part => part.shape instanceof this.R.Triangle);
      let parts = broad;
      const blocked = (a: number, b: number) => {
        writePose(a, _hmStartP, _hmStartQ);
        writePose(b, _hmEndP, _hmEndQ);
        _hmVel.copy(_hmEndP).sub(_hmStartP);
        const hasVel = _hmVel.lengthSq() > 1e-12;
        for (let pi = 0; pi < parts.length; pi++) {
          const shape = this.sweepShape(parts[pi], false);
          if (hasVel) {
            const hit = scene.castShape(_hmStartP, _hmStartQ, _hmVel, shape, 1, false, undefined, filter, undefined, r.body, this.notHeld);
            if (hit && hit.toi < 1) return true;
          }
          let overlap = false;
          scene.intersectionsWithShape(_hmEndP, _hmEndQ, shape, c => {
            const next = c.contactShape(shape, _hmEndP, _hmEndQ, .005);
            const before = c.contactShape(shape, _hmStartP, _hmStartQ, .005);
            if (next && next.distance < -1e-5 && (!before || next.distance < before.distance - 1e-5)) overlap = true;
            return !overlap;
          }, undefined, filter, undefined, r.body, this.notHeld);
          if (overlap) return true;
        }
        return false;
      };
      let previous = 0;
      for (let i = 1; i <= steps; i++) {
        const next = range * i / steps;
        if (subdivide && (i - 1) % blockSize === 0) {
          parts = candidates(previous, range * Math.min(steps, i - 1 + blockSize) / steps);
        }
        if (parts.length && blocked(previous, next)) {
          let lo = previous, hi = next;
          for (let n = 0; n < 10; n++) { const mid = (lo + hi) / 2; if (blocked(previous, mid)) hi = mid; else lo = mid; }
          // Keep a small gap for the force-driven prop and numerical contact tolerance.
          allowed = Math.max(0, lo - .003 / Math.max(.003, distance + Math.abs(turn) * radius));
          break;
        }
        previous = next;
        if (next >= allowed) break;
      }
    }
    return allowed;
  }
  /**
   * Would the thing stand on this point, turned this way? Its own shape comes down from just above the point until it touches: where it stops is
   * where it will rest (the ghost shows exactly that). It fits if nothing is in its way on the way down, nothing but the aimed surface stops it,
   * it does not penetrate walls, furniture, floors, or the standing player capsule, and what is under its base holds its centre of mass.
   */
  fit(id: string, point: T.Vector3, q: T.Quaternion, nudge = true): Fit {
    const record = this.bodies.get(id);
    if (!record) return { ok: false, why: 'support', center: point.clone() };
    const low = this.lowest(record, q);
    const supportFilter = groups(G_THING, G_FIXED | G_THING);
    const overlapFilter = groups(G_THING, G_FIXED | G_THING | G_ACTOR | G_PUSHED);
    _fitCastRot.x = q.x; _fitCastRot.y = q.y; _fitCastRot.z = q.z; _fitCastRot.w = q.w;
    const prevIgnore = this.queryIgnoreId;
    this.queryIgnoreId = id;
    try {
      const castDown = (sx: number, sz: number, clearance: number, downSpan: number) => {
        const sy = point.y - low.y + clearance;
        const maxToi = clearance + downSpan;
        _fitCastStart.x = sx; _fitCastStart.y = sy; _fitCastStart.z = sz;
        const parts = record.colliders.length < 16 ? record.colliders :
          (this.boundaryQueries ??= new RigidToolQueryBounds(this.R)).select(
            this.scene,
            record.colliders,
            _fitStartV.set(sx, sy, sz),
            q,
            _fitEndV.set(sx, sy - maxToi, sz),
            q,
            supportFilter,
            this.queryFilter,
            { angle: 0, chordError: 0 },
          );
        let bestToi = Infinity;
        for (let i = 0; i < parts.length; i++) {
          const shape = this.sweepShape(parts[i], false);
          const hit = this.scene.castShape(_fitCastStart, _fitCastRot, _downDir, shape, maxToi, true, undefined, supportFilter, undefined, record.body, this.queryFilter);
          if (hit && hit.toi < bestToi) bestToi = hit.toi;
        }
        return { sy, bestToi, parts };
      };

      const attempt = (dx: number, dz: number): Fit => {
        const sx = point.x + dx, sz = point.z + dz;
        const center = new T.Vector3(sx, point.y - low.y + SURFACE_SKIN_M, sz);
        let res = castDown(sx, sz, .025, .050);
        // If `+2.5 cm` clipped an overhead shelf cubby / cabinet underside, retry with tight `+6 mm` clearance.
        if (res.bestToi < 1e-4) {
          res = castDown(sx, sz, .006, .050);
        }
        if (!Number.isFinite(res.bestToi)) return { ok: false, why: 'support', center };
        if (res.bestToi < 1e-4) return { ok: false, why: 'room', center };
        center.y = res.sy - res.bestToi + SURFACE_SKIN_M;
        // It came to rest on something standing proud of the aimed surface: that is in the way, not under it.
        if (center.y + low.y > point.y + .020) return { ok: false, why: 'room', center };

        // Full 3D penetration check against walls, furniture, floors, closed doors, and the standing player capsule.
        _fitCastStart.x = center.x; _fitCastStart.y = center.y; _fitCastStart.z = center.z;
        let penetrated = false;
        for (let i = 0; i < res.parts.length && !penetrated; i++) {
          const shape = this.sweepShape(res.parts[i], false);
          this.scene.intersectionsWithShape(_fitCastStart, _fitCastRot, shape, c => {
            const ct = c.contactShape(shape, _fitCastStart, _fitCastRot, .002);
            if (ct && ct.distance < -.0018) penetrated = true;
            return !penetrated;
          }, undefined, overlapFilter, undefined, record.body, this.queryFilter);
        }
        if (penetrated) return { ok: false, why: 'room', center };

        return this.supported(record, center, low, q) ? { ok: true, center } : { ok: false, why: 'edge', center };
      };

      const first = attempt(0, 0);
      if (first.ok || first.why !== 'room' || !nudge) return first;
      // A hair from a wall, neighbour, or player capsule is still the place the player chose: smallest move that makes it fit.
      for (const d of [.015, .035, .065, .10, .14]) for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4, next = attempt(Math.cos(a) * d, Math.sin(a) * d);
        if (next.ok) return next;
      }
      return first;
    } finally {
      this.queryIgnoreId = prevIgnore;
    }
  }
  /** The lowest point of the shape turned this way, and the memoized outline + support samples around its centre. */
  private lowest(record: Body, q: T.Quaternion): LowestMemo {
    const cached = record.lowestCache;
    if (
      cached &&
      Math.abs(cached.qx - q.x) +
        Math.abs(cached.qy - q.y) +
        Math.abs(cached.qz - q.z) +
        Math.abs(cached.qw - q.w) <
        1e-6
    ) {
      return cached;
    }
    const h = record.hull, v = _lowScratchV;
    let y = Infinity;
    const pts: [number, number, number][] = [];
    for (let i = 0; i < h.length; i += 3) {
      v.set(h[i], h[i + 1], h[i + 2]).applyQuaternion(q);
      pts.push([v.x, v.y, v.z]);
      if (v.y < y) y = v.y;
    }
    const near = (t: number) => {
      const out: [number, number][] = [];
      for (let i = 0; i < pts.length; i++) {
        if (pts[i][1] < y + t) out.push([pts[i][0], pts[i][2]]);
      }
      return out;
    };
    let base = hull2d(near(.012));
    if (base.length < 3) base = hull2d(near(.035));

    const samples: [number, number][] = [[0, 0]];
    if (base.length >= 3) {
      const step = Math.max(1, Math.floor(base.length / 12));
      const outline: [number, number][] = [];
      for (let i = 0; i < base.length; i += step) outline.push(base[i]);
      for (const s of [.98, .66, .33]) {
        for (let i = 0; i < outline.length; i++) {
          const p = outline[i];
          samples.push([p[0] * s, p[1] * s]);
          if (s > .9) {
            const n = outline[(i + 1) % outline.length];
            samples.push([(p[0] + n[0]) * .5 * s, (p[1] + n[1]) * .5 * s]);
          }
        }
      }
    }
    v.copy(record.com).applyQuaternion(q);
    const comX = v.x, comZ = v.z;
    const ownDepth = base.length >= 3 ? depthInside(base, comX, comZ) : 0;
    const memo: LowestMemo = {
      qx: q.x,
      qy: q.y,
      qz: q.z,
      qw: q.w,
      y,
      base,
      samples,
      comX,
      comZ,
      ownDepth,
    };
    record.lowestCache = memo;
    return memo;
  }
  /** Rays straight down under its base: the part of the base that has something under it has to hold the centre of mass. */
  private supported(record: Body, center: T.Vector3, low: LowestMemo, _q: T.Quaternion) {
    const base = low.base;
    if (base.length < 3) return true;
    const bottom = center.y + low.y;
    const samples = low.samples;
    const held = _supportHeldScratch;
    held.length = 0;
    const filter = groups(G_THING, G_FIXED | G_THING);
    const prevIgnore = this.queryIgnoreId;
    this.queryIgnoreId = record.entry.obj.id;
    try {
      for (let i = 0; i < samples.length; i++) {
        const sx = samples[i][0], sz = samples[i][1];
        // Under the base itself, not somewhere down a rounded edge: only what really touches it counts.
        const hit = this.scene.castRay(
          this.ray(center.x + sx, bottom + .008, center.z + sz, 0, -1, 0),
          .016,
          true,
          undefined,
          filter,
          undefined,
          record.body,
          this.queryFilter,
        );
        if (hit) held.push(samples[i]);
      }
    } finally {
      this.queryIgnoreId = prevIgnore;
    }
    if (held.length < 3) return false;
    // Its weight has to sit well inside what holds it: nearly as far in as its own base would put it. A mug on a hair of support tips over.
    const supportedHull = hull2d(held);
    held.length = 0;
    return depthInside(supportedHull, low.comX, low.comZ) >= Math.max(.004, low.ownDepth * .45);
  }
  /** Where the thing's own origin stands and how it is turned, if its centre comes to rest there: the ghost. */
  poseAt(id: string, center: T.Vector3, q: T.Quaternion) {
    const record = this.bodies.get(id);
    if (!record) return null;
    _pV1.copy(record.center).applyQuaternion(q);
    return { position: center.clone().sub(_pV1), quaternion: q.clone().multiply(record.q0) };
  }
  /** Alias for `bringToPlace`: suspends external collider contacts during hand-guided placement/insertion. */
  suspendHeld(side: number) { this.bringToPlace(side); }
  /**
   * The last move onto its place: the place was proven free for its whole shape, so nothing on the way (a shelf board under which the hand came in) may stop it short
   * and drop it. Only the hands move it now; it meets the world again where it was shown to stand.
   */
  bringToPlace(side: number) { const h = this.holds.get(side), r = h ? this.bodies.get(h.id) : null; if (r) for (const c of r.colliders) c.setCollisionGroups(groups(G_THING, 0)); }
  /** Back in the world, after going somewhere only the hands could take it. */
  backInWorld(side: number) { const h = this.holds.get(side), r = h ? this.bodies.get(h.id) : null; this.cancelSupportedRelease(side); if (r) this.withBody(r, false); }
  /** Lifted back out of where only the hands could take it: it meets the world again once it is back at the hand, not while it is still in the basin. */
  liftOut(side: number) { const h = this.holds.get(side); if (h) h.lifting = true; }
  /** Set down exactly where it was brought: no drop, no swing. */
  setAt(side: number, to: T.Vector3, q: T.Quaternion) {
    const h = this.holds.get(side), r = h ? this.bodies.get(h.id) : null;
    if (!r) return;
    r.body.setTranslation({ x: to.x, y: to.y, z: to.z }, true);
    r.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.withBody(r, false);
  }
  /** In the hands, or just set down, it does not bump the body beside it. */
  private withBody(record: Body, on: boolean) { for (const c of record.colliders) c.setCollisionGroups(groups(G_THING, G_FIXED | G_THING | G_MECH | G_PUSHED | (on ? G_ACTOR : 0))); }
  /**
   * Something that was resting comes alive where it stands: it was hit, its support went, or it was walked into. From here gravity, friction and its own shape decide: it may only
   * shift, it may go over, and what stands on it comes along. When it comes to rest its new place goes back to the layout like anything else set down.
   */
  wake(id: string, kick?: { x: number; y?: number; z: number }) {
    if (this.disposed || this.bodies.has(id)) return false;
    const entry = this.entries.find(e => e.obj.id === id);
    if (!entry || !StudyPhysics.canPick(entry.obj) || entry.obj.inside || this.ignore.has(id)) return false;
    if (this.bodies.size >= MAX_BODIES) return false;
    // What it carries, before its place in the room goes away.
    const riders = this.riders(entry, this.entries);
    this.removeSolid(id);
    const record = this.ensureBody(entry);
    if (!record) return false;
    record.time = 0; record.contacted = false; record.lastSpeed = 0; record.restT = 0;
    if (kick) { record.body.setLinvel({ x: kick.x, y: kick.y ?? 0, z: kick.z }, true); record.body.setAngvel({ x: kick.z * 1.6, y: 0, z: -kick.x * 1.6 }, true); }
    this.onWoken?.(id);
    for (const r of riders) this.wake(r.obj.id);
    return true;
  }
  /** Everything loose within reach of a moving part: a door swinging into what stands behind it. */
  wakeWithin(at: T.Vector3, radius: number) {
    for (const e of this.entries) {
      if (this.bodies.has(e.obj.id) || e.obj.hidden || e.obj.inside || !StudyPhysics.canPick(e.obj) || e.group.position.y > 1.3) continue;
      if (Math.hypot(e.group.position.x - at.x, e.group.position.z - at.z) <= radius) this.wake(e.obj.id);
    }
  }
  /** What the last step's touches did: a moving thing hit a resting one, furniture was pushed into something light, something hit the body. */
  private afterStep() {
    const hits = this.stepHitsScratch;
    hits.length = 0;
    this.events.drainCollisionEvents((a, b, started) => { if (started) hits.push([a, b]); });
    for (let i = 0; i < hits.length; i++) {
      const [a, b] = hits[i];
      this.touched(a, b) || this.touched(b, a);
    }
    hits.length = 0;
  }
  private touched(a: number, b: number) {
    // A moving thing against a resting one.
    const movingId = this.colliderOf.get(a), moving = movingId ? this.bodies.get(movingId) : null;
    const rested = this.solidOf_.get(b);
    if (moving && rested) {
      const v = moving.before, speed = v.length();
      const other = this.entries.find(e => e.obj.id === rested);
      if (!other || !StudyPhysics.canPick(other.obj)) return false;
      const m2 = massNow(other.obj.kind, other.obj.state, affordanceOf(other.obj.kind).mass), dv = moving.kg * speed / (moving.kg + m2) * 1.1;
      if (dv < KNOCK_LEAST) return false;
      const k = dv / Math.max(speed, 1e-3);
      this.wake(rested, { x: v.x * k, y: Math.max(0, v.y * k) * .3, z: v.z * k });
      return true;
    }
    // Furniture pushed into something light: it wakes in the furniture's way.
    const foot = this.footOf.get(b);
    if (foot && this.pushCollider && a === this.pushCollider.handle) { this.wake(foot); return true; }
    // Something moving hit the body.
    if (moving && this.actorCollider && b === this.actorCollider.handle) {
      const v = moving.before;
      if (Math.hypot(v.x, v.z) > .6) this.onBodyHit?.(movingId!, v.x, v.z, moving.kg);
      return true;
    }
    return false;
  }

  /** Applies high contact friction (`>= 0.75`), zero bounce, and post-placement damping (`linear >= 1.8`, `angular >= 2.8`). */
  private applyRestingStability(record: Body, zeroBounce = true) {
    record.body.setLinearDamping(REST_LINEAR_DAMPING);
    record.body.setAngularDamping(REST_ANGULAR_DAMPING);
    record.surfaceDamped = true;
    const restit = zeroBounce ? 0 : 0.01;
    for (let i = 0; i < record.colliders.length; i++) {
      const c = record.colliders[i];
      if (c.friction() < REST_FRICTION) c.setFriction(REST_FRICTION);
      c.setRestitution(restit);
    }
  }

  /** Restores responsive held-servo damping when picked up into a hand. */
  private applyHeldDamping(record: Body) {
    record.body.setLinearDamping(HELD_LINEAR_DAMPING);
    record.body.setAngularDamping(HELD_ANGULAR_DAMPING);
    record.surfaceDamped = false;
  }

  /**
   * Snaps `centerY` onto the validated supporting surface beneath `(cx, centerY, cz)` with `0.25 mm` (`SURFACE_SKIN_M`)
   * tolerance so placed objects neither penetrate & pop upward nor hover in mid-air.
   */
  private snapCenterYToSupport(record: Body, id: string, cx: number, centerY: number, cz: number, bodyQuat: T.Quaternion): number {
    _fitCastRot.x = bodyQuat.x; _fitCastRot.y = bodyQuat.y; _fitCastRot.z = bodyQuat.z; _fitCastRot.w = bodyQuat.w;
    const filter = groups(G_THING, G_FIXED | G_THING);
    const prevIgnore = this.queryIgnoreId;
    this.queryIgnoreId = id;
    try {
      for (const lift of [.020, .005]) {
        const sy = centerY + lift;
        const maxToi = lift + .035;
        _fitCastStart.x = cx; _fitCastStart.y = sy; _fitCastStart.z = cz;
        const parts = record.colliders.length < 16 ? record.colliders :
          (this.boundaryQueries ??= new RigidToolQueryBounds(this.R)).select(
            this.scene,
            record.colliders,
            _fitStartV.set(cx, sy, cz),
            bodyQuat,
            _fitEndV.set(cx, sy - maxToi, cz),
            bodyQuat,
            filter,
            this.queryFilter,
            { angle: 0, chordError: 0 },
          );
        let bestToi = Infinity;
        for (let i = 0; i < parts.length; i++) {
          const shape = this.sweepShape(parts[i], false);
          const hit = this.scene.castShape(_fitCastStart, _fitCastRot, _downDir, shape, maxToi, true, undefined, filter, undefined, record.body, this.queryFilter);
          if (hit && hit.toi < bestToi) bestToi = hit.toi;
        }
        if (Number.isFinite(bestToi) && bestToi > 1e-4) {
          return sy - bestToi + SURFACE_SKIN_M;
        }
      }
      return centerY;
    } finally {
      this.queryIgnoreId = prevIgnore;
    }
  }

  /** A hand takes it. Whatever was resting on it loses its support and comes alive too: lift the bottom book and the top one falls. */
  pick(entry: Entry, entries: Entry[], size: number, side = 1) {
    if (this.holds.has(side) || !StudyPhysics.canPick(entry.obj)) return false;
    const riders = this.riders(entry, entries);
    const record = this.ensureBody(entry);
    if (!record) return false;
    this.applyHeldDamping(record);
    record.body.wakeUp(); record.time = 0;
    const p = record.body.translation(), r = record.body.rotation();
    this.holds.set(side, {
      id: entry.obj.id,
      target: new T.Vector3(p.x, p.y, p.z),
      rotation: new T.Quaternion(r.x, r.y, r.z, r.w),
      stiffness: 200,
    });
    this.heldIdsDirty = true;
    this.withBody(record, false);
    // Before the room is rebuilt: a thing left out of the bodies would become a fixed lid on the one being lifted.
    for (const rider of riders) { if (this.ensureBody(rider)) this.bodies.get(rider.obj.id)!.body.wakeUp(); }
    this.sync(entries, size);
    return true;
  }
  /** What rests directly on top of this thing, in the stage's space. */
  riders(entry: Entry, entries: Entry[]) {
    const box = this.bounds(entry);
    return entries.filter(e => {
      if (e === entry || e.obj.hidden || e.obj.inside || this.bodies.has(e.obj.id) || !StudyPhysics.canPick(e.obj)) return false;
      const b = this.bounds(e);
      return Math.abs(b.min.y - box.max.y) < .025 && b.min.x < box.max.x && b.max.x > box.min.x && b.min.z < box.max.z && b.max.z > box.min.z;
    });
  }
  /** Lets go. With a velocity it was thrown. */
  release(side: number, velocity?: T.Vector3, still = false) {
    const hold = this.holds.get(side);
    if (!hold) return;
    const id = hold.id;
    this.setSourceRackWithdrawal(id, null);
    const record = this.bodies.get(id);
    if (record) this.refreshMass(record);
    this.cancelSupportedRelease(side);
    this.holds.delete(side);
    this.heldIdsDirty = true;
    if (record && hold.force) record.body.addForce(_pV5.copy(hold.force).negate(), true);
    if (record) { record.body.wakeUp(); this.withBody(record, true); }
    // Set down, not dropped: the hand opens over the place with nothing left of the carrying swing.
    if (record && still) {
      record.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      record.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      if (!velocity) {
        const bt = record.body.translation(), br = record.body.rotation();
        const low = this.lowest(record, _pQ1.set(br.x, br.y, br.z, br.w));
        const surf = this.surfaceBelow(_pV1.set(bt.x, bt.y + low.y + .012, bt.z), .038, id, _pV2);
        if (surf) this.applyRestingStability(record, true);
      }
    }
    if (record) {
      record.time = 0; record.contacted = false; record.lastSpeed = 0; record.restT = 0;
      if (velocity) {
        this.applyHeldDamping(record);
        record.body.wakeUp();
        record.body.setLinvel({ x: velocity.x, y: velocity.y, z: velocity.z }, true);
        record.body.setAngvel({ x: velocity.z * 1.4, y: .6, z: -velocity.x * 1.4 }, true);
      }
    }
  }
  /**
   * Releases a validated floor/surface placement cleanly with zero bounce, zero hover, and zero sliding.
   * Snaps bottom support onto the supporting surface (`0.25 mm` skin tolerance), zeroes velocities, applies
   * high resting damping/friction, and immediately settles supported upright or 3-axis oriented placements
   * into static solids on Frame 0.
   */
  releaseValidatedPlacement(side: number, stageCenter: T.Vector3, bodyQuat: T.Quaternion) {
    const hold = this.holds.get(side);
    if (!hold) return;
    const record = this.bodies.get(hold.id);
    if (!record) {
      this.holds.delete(side);
      this.heldIdsDirty = true;
      return;
    }
    const id = hold.id;
    this.setSourceRackWithdrawal(id, null);
    this.refreshMass(record);
    this.cancelSupportedRelease(side);
    if (hold.force) record.body.addForce(_pV5.copy(hold.force).negate(), true);
    this.holds.delete(side);
    this.heldIdsDirty = true;

    const cleanQ = bodyQuat.clone().normalize();
    const groupQ = cleanQ.clone().multiply(record.q0).normalize();
    const isUpright = worldUpYFromQuat(groupQ) >= SETTLE_UPRIGHT_MIN_UP_Y;
    if (isUpright) {
      uprightQuatFrom(groupQ, groupQ);
      _settleQ0Inv.copy(record.q0).invert();
      cleanQ.copy(groupQ).multiply(_settleQ0Inv).normalize();
    }

    const snappedY = this.snapCenterYToSupport(record, id, stageCenter.x, stageCenter.y, stageCenter.z, cleanQ);
    const settledCenter = _pV4.set(stageCenter.x, snappedY, stageCenter.z);

    this.applyRestingStability(record, true);
    record.body.setTranslation({ x: settledCenter.x, y: settledCenter.y, z: settledCenter.z }, true);
    record.body.setRotation({ x: cleanQ.x, y: cleanQ.y, z: cleanQ.z, w: cleanQ.w }, true);
    record.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    record.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    record.prevP.copy(settledCenter);
    record.prevQ.copy(cleanQ);
    record.restP.copy(settledCenter);
    record.restQ.copy(cleanQ);
    _settleOffset.copy(record.center).applyQuaternion(cleanQ);
    record.entry.group.position.copy(settledCenter).sub(_settleOffset);
    record.entry.group.quaternion.copy(groupQ);
    record.entry.group.updateWorldMatrix(true, true);
    this.withBody(record, true);

    const low = this.lowest(record, cleanQ);
    if (isUpright || this.supported(record, settledCenter, low, cleanQ)) {
      this.settle(id, record);
      this.sync(this.entries, this.roomSize);
    } else {
      record.time = 0.35;
      record.contacted = true;
      record.lastSpeed = 0;
      record.restT = 0.24;
    }
  }
  dropAll() { for (const side of [...this.holds.keys()]) this.release(side); }
  /** Hands remain attached while the actual support takes the load. A pose or
   * a nearby surface is insufficient: require consecutive gravity-only steps
   * with measured upward contact impulse and negligible motion. */
  supportedRelease(side: number, supportId: string) {
    const h = this.holds.get(side), r = h ? this.bodies.get(h.id) : null;
    if (!h || !r) return false;
    this.refreshMass(r);
    if (h.supportTrial?.id !== supportId) this.cancelSupportedRelease(side);
    if (!this.supportReaction(r, supportId).touching) { this.cancelSupportedRelease(side); return false; }
    if (!h.supportTrial) {
      h.supportTrial = { id: supportId, time: 0, load: 0, events: r.colliders.map(c => c.activeEvents()) };
      for (const c of r.colliders) c.setActiveEvents(c.activeEvents() | this.R.ActiveEvents.CONTACT_FORCE_EVENTS);
    }
    return h.supportTrial.time >= .35;
  }
  cancelSupportedRelease(side: number) {
    const h = this.holds.get(side), r = h ? this.bodies.get(h.id) : null;
    if (!h?.supportTrial) return;
    if (r) r.colliders.forEach((c, i) => c.setActiveEvents(h.supportTrial!.events[i]));
    h.supportTrial = undefined;
  }
  /** Conservative base support: only the named furniture's real, upward
   * contacts count. Friction-only clips are not proven by this measurement. */
  private supportReaction(record: Body, supportId: string) {
    let touching = false, impulse = 0;
    const scene = this.scene;
    for (const collider of record.colliders) scene.contactPairsWith(collider, other => {
      if (other.isSensor() || this.solidOf_.get(other.handle) !== supportId) return;
      scene.contactPair(collider, other, (m, flipped) => {
        // Rapier's manifold normal points out of its first collider. The
        // queried pair may be reversed; reaction on the held body is opposite.
        const up = m.normal().y * (flipped ? 1 : -1);
        if (up < .5) return;
        for (let i = 0; i < m.numContacts(); i++) {
          const distance = m.contactDist(i);
          if (distance < -.003 || distance > .0025) continue;
          touching = true; impulse += Math.max(0, m.contactImpulse(i)) * up;
        }
      });
    });
    return { touching, impulse };
  }
  /** The thing goes where the layout says, not where physics has it: into a drawer, onto a hook. */
  forget(id: string) {
    this.setSourceRackWithdrawal(id, null);
    const record = this.bodies.get(id);
    const side = this.sideOf(id);
    if (side !== null) { this.cancelSupportedRelease(side); this.holds.delete(side); this.heldIdsDirty = true; }
    if (record) { this.removeRackGuide(id); for (const c of record.colliders) this.colliderOf.delete(c.handle); this.bodies.delete(id); this.world.removeRigidBody(record.body); }
  }
  /** Inspecting: the hand turns the thing. */
  turnHeld(side: number, dx: number, dy: number, dz = 0) {
    const hold = this.holds.get(side), record = hold ? this.bodies.get(hold.id) : null;
    if (!hold || !record) return;
    const r = record.body.rotation();
    const q = hold.rotation ?? new T.Quaternion(r.x, r.y, r.z, r.w);
    if (dx) q.premultiply(new T.Quaternion().setFromAxisAngle(UP, dx));
    if (dy) q.premultiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(1, 0, 0), dy));
    if (dz) q.premultiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 0, 1), dz));
    hold.rotation = q.normalize();
  }
  /** Holds it at this rotation; null lets it settle back upright in the hand. */
  holdRotation(side: number, q: T.Quaternion | null) { const h = this.holds.get(side); if (h) h.rotation = q ? q.clone() : null; }
  /** Holds it so that the thing itself (its drawn group) is turned this way, however it stood when it was picked up. */
  holdGroupRotation(side: number, q: T.Quaternion) {
    const h = this.holds.get(side), record = h ? this.bodies.get(h.id) : null;
    if (h && record) h.rotation = q.clone().multiply(record.q0.clone().invert());
  }
  /**
   * Updates hold target and 3D group rotation without PD derivative spikes (`0` yank on `Reset Upright` or gizmo drag).
   */
  syncHoldPose(side: number, stageCenter: T.Vector3 | null, groupQuat: T.Quaternion, snap = false) {
    const h = this.holds.get(side), record = h ? this.bodies.get(h.id) : null;
    if (!h || !record) return;
    h.brake = undefined;
    const bodyQ = groupQuat.clone().multiply(record.q0.clone().invert()).normalize();
    if (stageCenter) h.target.copy(stageCenter);
    h.rotation = bodyQ;
    if (snap) {
      h.stationaryTarget = false;
      (h.previousTarget ??= new T.Vector3()).copy(h.target);
      (h.previousRotation ??= new T.Quaternion()).copy(bodyQ);
      h.velocity?.set(0, 0, 0);
      h.angularVelocity?.set(0, 0, 0);
      if (h.force) {
        record.body.addForce(h.force.clone().negate(), true);
        h.force = undefined;
      }
      const curP = record.body.translation(), curR = record.body.rotation();
      const fromP = new T.Vector3(curP.x, curP.y, curP.z);
      const fromQ = new T.Quaternion(curR.x, curR.y, curR.z, curR.w);
      if (this.toolMotionFraction(record, fromP, fromQ, h.target, bodyQ, false, true) >= .999) {
        record.body.setTranslation({ x: h.target.x, y: h.target.y, z: h.target.z }, true);
        record.body.setRotation({ x: bodyQ.x, y: bodyQ.y, z: bodyQ.z, w: bodyQ.w }, true);
        record.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        record.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        record.prevP.copy(h.target);
        record.prevQ.copy(bodyQ);
        record.entry.group.position.copy(h.target).sub(record.center.clone().applyQuaternion(bodyQ));
        record.entry.group.quaternion.copy(groupQuat);
      } else {
        record.body.wakeUp();
      }
    }
  }
  /**
   * Distortion-free 2-hand / 1-hand carried `ToolSpec` tracker: follows `canonicalCarryPose` cleanly
   * during locomotion without `!fit.feasible -> brakeHeld()` freezes or ceiling-clamp head thrusts.
   */
  syncCarriedToolPose(
    side: number,
    id: string,
    stageGroupPos: T.Vector3,
    stageGroupQuat: T.Quaternion,
    dt = 1 / 60,
    immediateSnap = false,
  ) {
    const h = this.holds.get(side), r = this.bodies.get(id);
    if (!h || !r || h.id !== id) return;
    if (immediateSnap) this.removeRackGuide(id);
    h.brake = undefined;
    h.working = false;
    h.motionTarget = false;
    h.stationaryTarget = false;
    const wantCenter = this.centreFor(id, stageGroupPos, stageGroupQuat, _carryWantCenter);
    this.fitCarryInRoom(id, wantCenter, stageGroupQuat);
    _carryQ0Inv.copy(r.q0).invert();
    const wantBodyQ = _carryWantBodyQ.copy(stageGroupQuat).multiply(_carryQ0Inv).normalize();
    const curP = r.body.translation(), curR = r.body.rotation();
    const fromP = _carryFromP.set(curP.x, curP.y, curP.z);
    const fromQ = _carryFromQ.set(curR.x, curR.y, curR.z, curR.w);
    const fraction = immediateSnap
      ? 1
      : this.toolMotionFraction(r, fromP, fromQ, wantCenter, wantBodyQ, false, true);
    const nextP = _carryNextP.copy(fromP).lerp(wantCenter, fraction);
    const nextQ = _carryNextQ.copy(fromQ).slerp(wantBodyQ, fraction).normalize();
    this.refreshSourceRackWithdrawalDistance(id, nextP.x, nextP.z);
    h.target.copy(nextP);
    (h.rotation ??= new T.Quaternion()).copy(nextQ);
    (h.previousTarget ??= new T.Vector3()).copy(nextP);
    (h.previousRotation ??= new T.Quaternion()).copy(nextQ);
    h.velocity?.set(0, 0, 0);
    h.angularVelocity?.set(0, 0, 0);
    if (h.force) {
      r.body.addForce(_pV5.copy(h.force).negate(), true);
      h.force = undefined;
    }
    r.body.setTranslation({ x: nextP.x, y: nextP.y, z: nextP.z }, true);
    r.body.setRotation({ x: nextQ.x, y: nextQ.y, z: nextQ.z, w: nextQ.w }, true);
    r.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    r.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    r.prevP.copy(nextP);
    r.prevQ.copy(nextQ);
    const drawnGroupQ = _carryDrawnQ.copy(nextQ).multiply(r.q0).normalize();
    _carryOffsetV.copy(r.center).applyQuaternion(nextQ);
    r.entry.group.position.copy(nextP).sub(_carryOffsetV);
    r.entry.group.quaternion.copy(drawnGroupQ);
    void dt;
  }
  /** Fit the requested carry pose inside the room before planning the wrists.
   * A centre inside the room can still put part of the rotated object through a wall. */
  fitCarryInRoom(id: string, center: T.Vector3, rotation: T.Quaternion) {
    const record = this.bodies.get(id);
    const edge = this.roomSize / 2 - .006;
    if (!record || Math.max(Math.abs(center.x), Math.abs(center.z)) + record.sweepRadius < edge) return;
    // Echo Life: beyond the room's square the house's own walls and floors (Rapier) are what stop it, not this square.
    if (this.doorway && Math.max(Math.abs(center.x), Math.abs(center.z)) > this.roomSize / 2) return;
    _fitRoomQ0Inv.copy(record.q0).invert();
    const q = _fitRoomQ.copy(rotation).multiply(_fitRoomQ0Inv);
    const bounds = _fitRoomBounds.makeEmpty(), point = _fitRoomPoint;
    for (let i = 0; i < record.hull.length; i += 3) {
      bounds.expandByPoint(point.fromArray(record.hull, i).applyQuaternion(q));
    }
    // Through the hall doorway (open) the +x side is not a wall for a thing that fits between the jambs and under the lintel.
    const d = this.doorway, through = !!d && !this.plugWanted
      && center.z + bounds.min.z >= d.z - d.width / 2 && center.z + bounds.max.z <= d.z + d.width / 2
      && center.y + bounds.max.y <= d.top;
    center.x = T.MathUtils.clamp(center.x, -edge - bounds.min.x, through ? Infinity : edge - bounds.max.x);
    center.z = T.MathUtils.clamp(center.z, -edge - bounds.min.z, edge - bounds.max.z);
  }
  aim(side: number, stageTarget: T.Vector3, carryDt?: number, lifting = false) {
    const h = this.holds.get(side);
    if (!h) return;
    if (h.brake) {
      h.brake = undefined;
      h.stationaryTarget = false;
      h.previousTarget = undefined;
      h.previousRotation = undefined;
    }
    const r = carryDt !== undefined ? this.bodies.get(h.id) : null;
    if (!r || carryDt === undefined) {
      h.target.copy(stageTarget);
      if (!h.working) h.motionTarget = false;
      return;
    }
    // The root checks the hand's target on its next step. Never leave that
    // target embedded in the rail while the physical tool is outside it.
    const t = r.body.translation(), q = r.body.rotation();
    const from = _aimFrom.set(t.x, t.y, t.z), orientation = _aimOrient.set(q.x, q.y, q.z, q.w);
    const step = this.motionStepSeconds(carryDt);
    const to = _aimTo.copy(stageTarget).sub(from).clampLength(0, 3 * step).add(from);
    const next = _aimNextQ.copy(orientation).rotateTowards(h.rotation ?? _aimIdentityQ, 6 * step);
    const fraction = this.toolMotionFraction(r, from, orientation, to, next, false, false);
    h.target.copy(from).lerp(to, fraction);
    (h.rotation ??= new T.Quaternion()).copy(orientation).slerp(next, fraction);
    // A long tool beside a rack can back out before there is room to turn.
    // Sweep the remaining translation at the angle actually admitted above.
    if (fraction < 1 && h.target.distanceToSquared(to) > 1e-10 && h.rotation.angleTo(next) > 1e-5) {
      const travel = this.toolMotionFraction(r, h.target, h.rotation, to, h.rotation, false, false);
      h.target.lerp(to, travel);
    }
    if (lifting && fraction < 1 && to.y > from.y) {
      // A tap can obstruct the lift while the basin rim blocks a direct
      // pull. Slide outward or lift first, whichever clear sweep makes
      // more progress. Every trial starts at the same actual body pose.
      const motion = _aimMotion.copy(to).sub(from);
      let progress = _aimTrialEnd.copy(h.target).sub(from).dot(motion);
      _aimDeltaA.set(motion.x, 0, motion.z);
      _aimDeltaB.set(0, motion.y, 0);
      for (const delta of [_aimDeltaA, _aimDeltaB]) {
        if (delta.lengthSq() < 1e-10) continue;
        _aimTrialEnd.copy(from).add(delta);
        const allowed = this.toolMotionFraction(r, from, orientation, _aimTrialEnd, orientation, false, false);
        const along = delta.dot(motion) * allowed;
        if (along > progress) {
          h.target.copy(from).addScaledVector(delta, allowed);
          h.rotation.copy(orientation);
          progress = along;
        }
      }
    }
    h.motionTarget = true; h.stationaryTarget = false;
  }
  /** When both wrists cannot accept a carry step, stop at one physical pose.
   * Resampling the drifting body's centre every render would tell the velocity
   * controller to keep moving even though the reach solver requested a stop. */
  brakeHeld(side: number) {
    const h = this.holds.get(side), body = h && this.bodies.get(h.id)?.body;
    if (!h || !body) return;
    if (!h.brake) {
      const at = body.translation(), q = body.rotation();
      h.brake = { center: new T.Vector3(at.x, at.y, at.z), rotation: new T.Quaternion(q.x, q.y, q.z, q.w) };
    }
    h.stationaryTarget = true;
    h.target.copy(h.brake.center);
    (h.rotation ??= new T.Quaternion()).copy(h.brake.rotation);
  }
  /** Work stops at the actual tool pose; subsequent carrying resumes through
   * forces with fresh target history and normal held-object collisions. */
  resumeHeld(side: number) {
    const h = this.holds.get(side), r = h ? this.bodies.get(h.id) : null;
    if (!h?.working || !r) return;
    h.brake = undefined;
    h.working = false;
    h.motionTarget = false;
    h.stationaryTarget = false;
    const at = r.body.translation(), q = r.body.rotation();
    h.target.set(at.x, at.y, at.z);
    (h.rotation ??= new T.Quaternion()).set(q.x, q.y, q.z, q.w);
    h.previousTarget = undefined; h.previousRotation = undefined;
    h.velocity = undefined; h.angularVelocity = undefined;
    this.applyHeldDamping(r);
    this.withBody(r, false); r.body.wakeUp();
  }
  /** A working hand requests a pose through the same bounded forces and
   * contacts as carrying. It never writes the body or drawing directly. */
  beginRackTransfer(id: string, rackId: string) {
    this.setSourceRackWithdrawal(id, null);
    const side = this.sideOf(id), hold = side === null ? null : this.holds.get(side), record = this.bodies.get(id);
    if (!hold || !record || !toolOf(record.entry.obj.kind) || !this.solids.has(rackId)) return false;
    hold.rackTransfer = rackId; return true;
  }
  endRackTransfer(id: string) { const side = this.sideOf(id), hold = side === null ? null : this.holds.get(side); if (hold) { hold.rackTransfer = undefined; hold.rackBias = undefined; hold.rackBiasTarget = undefined; } }
  private storagePose(record: Body, storage: RackStorage, slot: number, position: T.Vector3, rotation: T.Quaternion) {
    const key = record.storageKey;
    if (!key) return null;
    const size = key.size.clone().multiply(record.entry.group.scale), expectedSize = new T.Vector3(...storage.collar.size).multiplyScalar(storage.scale);
    const snug = size.distanceTo(expectedSize) < .00001 * storage.scale;
    const groupQ = rotation.clone().multiply(record.q0);
    const at = key.center.clone().multiply(record.entry.group.scale).applyQuaternion(groupQ)
      .add(position).sub(record.center.clone().applyQuaternion(rotation)).applyMatrix4(storage.inverse);
    const expected = new T.Vector3(...storage.slots[slot].position).add(new T.Vector3(...storage.collar.center));
    const reverse = storage.rotation.clone().multiply(new T.Quaternion().setFromAxisAngle(UP, Math.PI));
    return { at, bottom: at.y - storage.collar.size[1] / 2, snug,
      lateral: Math.max(Math.abs(at.x - expected.x), Math.abs(at.z - expected.z)),
      angle: Math.min(groupQ.angleTo(storage.rotation), groupQ.angleTo(reverse)) };
  }
  private removeRackGuide(id: string) {
    const guide = this.rackGuides.get(id);
    if (!guide) return;
    this.rackGuides.delete(id);
    if (guide.joint.isValid()) this.world.removeImpulseJoint(guide.joint, true);
    if (guide.base.isValid()) this.world.removeRigidBody(guide.base);
  }
  /** The visible keyed sleeve constrains five axes; its vertical slide has
   * neither limits nor a motor. Only actual bearing contacts support weight.
   * Engagement preserves the current pose and withdrawal removes the joint. */
  private updateRackGuides() {
    for (const [id, record] of this.bodies) {
      if (!record.storageKey || this.sourceRackWithdrawals.has(id)) continue;
      const p = record.body.translation(), q = record.body.rotation(), position = new T.Vector3(p.x, p.y, p.z), rotation = new T.Quaternion(q.x, q.y, q.z, q.w);
      const previous = this.rackGuides.get(id);
      if (previous) {
        const solid = this.solids.get(previous.rack), storage = solid?.storage;
        const pose = storage ? this.storagePose(record, storage, previous.slot, position, rotation) : null;
        if (!storage || !pose?.snug || solid!.key !== previous.key || !previous.joint.isValid()
          || pose.bottom > storage.slots[previous.slot].guideTopY + .003) this.removeRackGuide(id);
        else continue;
      }
      for (const [rack, solid] of this.solids) {
        const storage = solid.storage;
        if (!storage) continue;
        const slot = storage.slots.findIndex(s => s.kind === record.entry.obj.kind);
        if (slot < 0) continue;
        const pose = this.storagePose(record, storage, slot, position, rotation), bounds = storage.slots[slot];
        if (!pose?.snug || pose.lateral > .0004 || pose.angle > .002 || pose.bottom < bounds.bearingY - .002 || pose.bottom > bounds.guideTopY - .0005) continue;
        const base = this.world.createRigidBody(this.R.RigidBodyDesc.fixed().setTranslation(p.x, p.y, p.z).setRotation(q));
        const axis = UP.clone().transformDirection(storage.frame).applyQuaternion(rotation.clone().invert());
        const joint = this.world.createImpulseJoint(this.R.JointData.prismatic(new T.Vector3(), new T.Vector3(), axis), base, record.body, true) as RAPIER.PrismaticImpulseJoint;
        joint.setContactsEnabled(true);
        this.rackGuides.set(id, { rack, key: solid.key, slot, base, joint });
        break;
      }
    }
  }
  /** Lift the key fully out of the measured sleeve before pulling away. */
  rackDeparture(id: string, rackId?: string) {
    const storage = rackId ? this.solids.get(rackId)?.storage : null;
    if (!storage || !this.bodies.get(id)?.storageKey) return null;
    return UP.clone().transformDirection(storage.frame).multiplyScalar((storage.guide.height + .003 + .006) * storage.scale);
  }
  private intentionalRackContacts(record: Body, from?: T.Vector3, fromQ?: T.Quaternion, to?: T.Vector3, toQ?: T.Quaternion): ReadonlySet<number> {
    const side = this.sideOf(record.entry.obj.id), hold = side === null ? null : this.holds.get(side);
    const solid = hold?.rackTransfer ? this.solids.get(hold.rackTransfer) : null;
    if (!solid) return EMPTY_HANDLE_SET;
    const rack = solid.rack, handles = new Set<number>();
    if (toolOf(record.entry.obj.kind)) {
      for (const c of solid.colliders) handles.add(c.handle);
    }
    const slot = ['tool.broom', 'tool.webbrush', 'tool.mop'].indexOf(record.entry.obj.kind);
    if (rack && slot >= 0) for (const finger of rack.fingers.slice(slot * 2, slot * 2 + 2)) {
      if (finger.joint.isValid() && finger.body.isDynamic() && finger.joint.body2().handle === finger.body.handle)
        for (const collider of finger.colliders) handles.add(collider.handle);
    }
    if (solid.storage && slot >= 0 && from && fromQ && to && toQ) {
      const a = this.storagePose(record, solid.storage, slot, from, fromQ), b = this.storagePose(record, solid.storage, slot, to, toQ);
      const bearing = solid.storage.slots[slot].bearingY;
      if (a?.snug && b?.snug && Math.min(a.bottom, b.bottom) >= bearing - .0001
        && a.lateral <= .0004 && b.lateral <= .0004 && a.angle <= .002 && b.angle <= .002)
        for (const handle of solid.storage.handles.get(slot) ?? []) handles.add(handle);
    }
    return handles;
  }
  driveTool(side: number, id: string, position: T.Vector3, rotation: T.Quaternion, dt = 1 / 60, stationaryTarget = false, motionTarget = false, fittedTurn = false) {
    const h = this.holds.get(side), r = this.bodies.get(id);
    if (!h || !r || h.id !== id) return;
    h.brake = undefined;
    h.working = true;
    h.motionTarget = motionTarget;
    h.stationaryTarget = stationaryTarget;
    const at = r.body.translation(), br = r.body.rotation();
    const from = new T.Vector3(at.x, at.y, at.z), fromQ = new T.Quaternion(br.x, br.y, br.z, br.w);
    const wantedQ = rotation.clone().multiply(r.q0.clone().invert());
    const toQ = fittedTurn ? wantedQ : fromQ.clone().rotateTowards(wantedQ, .8 * this.motionStepSeconds(dt));
    const to = this.centreFor(id, position, toQ.clone().multiply(r.q0), new T.Vector3());
    this.refreshSourceRackWithdrawalDistance(id, from.x, from.z);
    const isCarriedToolShaft = Boolean(toolOf(r.entry.obj.kind));
    const rackContact = !isCarriedToolShaft && !!h.rackTransfer && this.toolMotionFraction(r, from, fromQ, to, toQ, true, false) < 1 - 1e-7;
    if (rackContact) { const delta = to.clone().sub(from).clampLength(0, .0025); to.copy(from).add(delta); }
    const fraction = this.toolMotionFraction(r, from, fromQ, to, toQ, !!h.rackTransfer && !isCarriedToolShaft, true);
    h.target.copy(from).lerp(to, fraction);
    h.rotation = fromQ.slerp(toQ, fraction);
    r.body.wakeUp();
  }
  /** A route may turn only after the prop has slowed and its ACTUAL pose has a
   * clear next edge. The nominal node's clearance cannot stand in for that pose:
   * millimetres of spring lag can put a long shaft on the wrong side of a clip. */
  toolWaypointReached(id: string, center: T.Vector3, rotation: T.Quaternion, next?: T.Vector3) {
    const r = this.bodies.get(id), at = this.pointOf(id);
    if (!r || !at) return false;
    const side = this.sideOf(id);
    const rack = side === null ? undefined : this.holds.get(side)?.rackTransfer;
    const storage = rack ? this.solids.get(rack)?.storage : null;
    const slot = storage?.slots.findIndex(s => s.kind === r.entry.obj.kind) ?? -1;
    const wanted = rotation.clone().multiply(r.q0.clone().invert());
    const nextKey = storage && next && slot >= 0 ? this.storagePose(r, storage, slot, next, wanted) : null;
    const entering = !!(nextKey?.snug && nextKey.lateral <= .0004 && nextKey.angle <= .002
      && nextKey.bottom <= storage!.slots[slot].guideTopY && center.y > next!.y);
    if (at.distanceTo(center) > (entering ? .0002 : .006)) return false;
    const v = r.body.linvel(), w = r.body.angvel(), br = r.body.rotation();
    const q = new T.Quaternion(br.x, br.y, br.z, br.w).normalize();
    if (Math.hypot(v.x, v.y, v.z) > .01 || Math.hypot(w.x, w.y, w.z) > .01 || q.angleTo(wanted) > (entering ? .002 : .015)) return false;
    return !next || this.toolMotionFraction(r, at, q, next, wanted) >= 1 - 1e-7;
  }
  /** Keep a work target outside obstacles before applying a force. Rapier
   * still resolves the actual body/contact; this prevents a blocked request
   * from storing enough compression to punch a light tool through a thin rail. */
  private toolMotionFraction(r: Body, from: T.Vector3, fromQ: T.Quaternion, to: T.Vector3, toQ: T.Quaternion, clearance = false, allowRackContact = true) {
    const distance = from.distanceTo(to), angle = fromQ.angleTo(toQ);
    if (distance + angle < 1e-8) return 1;
    const radius = r.sweepRadius;
    const scene = this.scene, filter = groups(G_THING, G_FIXED | G_THING | G_MECH | G_PUSHED);
    const intentional = allowRackContact ? this.intentionalRackContacts(r, from, fromQ, to, toQ) : EMPTY_HANDLE_SET;
    const external = intentional.size === 0
      ? this.notHeld
      : (c: RAPIER.Collider) => !c.isSensor() && !intentional.has(c.handle) && this.notHeld(c);
    const fastSweepTool = !clearance && Boolean(toolOf(r.entry.obj.kind)) && !this.rackGuides.has(r.entry.obj.id);
    const arcStep = fastSweepTool ? .024 : .004;
    const rawSteps = Math.max(1, Math.ceil(angle * radius / arcStep));
    const steps = fastSweepTool ? Math.min(10, rawSteps) : rawSteps;
    const bisectIters = fastSweepTool ? 6 : 10;
    // One conservative full-path envelope covers every angular interval and
    // bisection prefix. Keep it only for this synchronous, unchanged scene.
    const queryMemo: { selected?: RAPIER.Collider[] } = {};
    const blocked = (a: number, b: number) => {
      _tmStartP.copy(from).lerp(to, a);
      _tmStartQ.copy(fromQ).slerp(toQ, a);
      _tmEndP.copy(from).lerp(to, b);
      _tmEndQ.copy(fromQ).slerp(toQ, b);
      _tmDelta.copy(_tmEndP).sub(_tmStartP);
      const hasDelta = _tmDelta.lengthSq() > 1e-12;
      for (const part of this.queryParts(r, from, fromQ, to, toQ, filter, queryMemo)) {
        const shape = this.sweepShape(part, clearance);
        if (hasDelta) {
          const hit = scene.castShape(_tmStartP, _tmStartQ, _tmDelta, shape, 1, false, undefined, filter, undefined, r.body, external);
          if (hit && hit.toi < 1) return true;
        }
        let overlap = false;
        scene.intersectionsWithShape(_tmEndP, _tmEndQ, shape, c => {
          const next = c.contactShape(shape, _tmEndP, _tmEndQ, .005), before = c.contactShape(shape, _tmStartP, _tmStartQ, .005);
          if (next && next.distance < -1e-5 && (!before || next.distance < before.distance - 1e-5)) overlap = true;
          return !overlap;
        }, undefined, filter, undefined, r.body, external);
        if (overlap) return true;
      }
      return false;
    };
    let previous = 0;
    for (let i = 1; i <= steps; i++) {
      const next = i / steps;
      if (blocked(previous, next)) {
        let lo = previous, hi = next;
        for (let n = 0; n < bisectIters; n++) { const mid = (lo + hi) / 2; if (blocked(previous, mid)) hi = mid; else lo = mid; }
        return Math.max(0, lo - .003 / Math.max(.003, distance + angle * radius));
      }
      previous = next;
    }
    return 1;
  }
  /** Bounded translation search for an acquired tool, without rotating its
   * secured grasp or moving any body. Every edge casts every collider part;
   * the caller also rejects anatomically unreachable samples. Yielding after
   * each neighbour lets the owner spread the search across animation frames.
   * Execution still rechecks both constraints against the live scene. */
  *toolRoute(id: string, goal: T.Vector3, rotation: T.Quaternion, reachable: (at: T.Vector3) => boolean, preferred?: readonly T.Vector3[]): Generator<number, T.Vector3[] | null> {
    const r = this.bodies.get(id), start = this.pointOf(id);
    if (!r || !start) return null;
    const q = rotation.clone().multiply(r.q0.clone().invert()), step = .04;
    // Search in the acquired tool's axes. A world-aligned grid could extract
    // the same rack at yaw zero but miss its narrow corridor after a room turn.
    const frame = rotation.clone().normalize(), inverse = frame.clone().invert();
    const local = (p: T.Vector3) => p.clone().sub(start).applyQuaternion(inverse);
    const clear = (a: T.Vector3, b: T.Vector3) => {
      const n = Math.max(1, Math.ceil(a.distanceTo(b) / .02));
      for (let i = 1; i <= n; i++) if (!reachable(a.clone().lerp(b, i / n))) return false;
      return this.toolMotionFraction(r, a, q, b, q, true) >= 1 - 1e-7;
    };
    // A just-completed extraction supplies a useful reverse route. Treat it
    // as a candidate only: every segment must still pass live anatomy and
    // exact-shape collision checks, including the current approach to it.
    if (preferred?.length) {
      const route = [...preferred.map(p => p.clone()), goal.clone()];
      let previous = start, valid = true;
      for (const next of route) { if (!clear(previous, next)) { valid = false; break; } previous = next; }
      if (valid) return route;
    }
    if (clear(start, goal)) return [goal.clone()];
    type Node = { at: T.Vector3; cost: number; score: number; key: string; parent: Node | null };
    const keyOf = (p: T.Vector3) => local(p).toArray().map(v => Math.round(v / .002)).join(',');
    const first: Node = { at: start, cost: 0, score: start.distanceTo(goal), key: keyOf(start), parent: null };
    const open = [first], best = new Map<string, number>([[first.key, 0]]);
    const low = new T.Vector3().min(local(goal)).addScalar(-.5), high = new T.Vector3().max(local(goal)).addScalar(.5);
    let visited = 0;
    while (open.length && visited < 1800 && !this.disposed && this.bodies.get(id) === r) {
      open.sort((a, b) => b.score - a.score);
      const node = open.pop()!;
      if (node.cost !== best.get(node.key)) continue;
      visited++;
      if (clear(node.at, goal)) {
        const path = [goal.clone()];
        for (let n: Node | null = node; n?.parent; n = n.parent) path.unshift(n.at.clone());
        // Earlier edges were visited before a yield. A changed body or scene
        // can invalidate them even if the last edge is still clear now.
        let previous = this.pointOf(id);
        if (!previous) return null;
        for (const waypoint of path) {
          if (!clear(previous, waypoint)) return null;
          previous = waypoint;
        }
        return path;
      }
      for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
        if (!x && !y && !z) continue;
        const requested = node.at.clone().add(new T.Vector3(x, y, z).multiplyScalar(step).applyQuaternion(frame));
        const fraction = this.toolMotionFraction(r, node.at, q, requested, q, true);
        const at = node.at.clone().lerp(requested, fraction), here = local(at), key = keyOf(at), cost = node.cost + node.at.distanceTo(at);
        if (here.x >= low.x && here.y >= low.y && here.z >= low.z && here.x <= high.x && here.y <= high.y && here.z <= high.z
          && at.distanceTo(node.at) > .002 && cost < (best.get(key) ?? Infinity) && clear(node.at, at)) {
          best.set(key, cost); open.push({ at, cost, score: cost + at.distanceTo(goal), key, parent: node });
        }
        yield visited;
      }
    }
    return null;
  }
  /** How far along the floor from one point towards another before something solid is met (a wall, a table leg, a bed base). Null: no answer. */
  clearFloorLine(from: T.Vector3, to: T.Vector3): number | null {
    if (this.disposed) return null;
    const dx = to.x - from.x, dz = to.z - from.z, len = Math.hypot(dx, to.y - from.y, dz);
    if (len < 1e-4) return len;
    const hit = this.scene.castRay(this.ray(from.x, from.y, from.z, dx / len, 0, dz / len), len, true, undefined, groups(G_THING, G_FIXED), undefined, undefined, this.notHeld);
    return hit ? hit.toi : len;
  }
  /** How far a ray goes before something solid: what a long brush would meet up in the air. */
  clearRay(from: T.Vector3, dir: T.Vector3, far: number): number {
    if (this.disposed) return far;
    const hit = this.scene.castRay(this.ray(from.x, from.y, from.z, dir.x, dir.y, dir.z), far, true, undefined, groups(G_THING, G_FIXED), undefined, undefined, this.notHeld);
    return hit ? hit.toi : far;
  }

  /** A drawer on its runners: closed at `closed`, sliding along `axis` up to `travel`. */
  slider(closed: T.Vector3, axis: T.Vector3, travel: number, half: [number, number, number], mass: number, start: number): Mechanism {
    const R = this.R;
    const base = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(closed.x, closed.y, closed.z));
    const at = closed.clone().addScaledVector(axis, start * travel);
    const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(at.x, at.y, at.z).setLinearDamping(5).setAngularDamping(8).setGravityScale(0));
    const c = R.ColliderDesc.cuboid(...half).setCollisionGroups(groups(G_MECH, G_THING | G_ACTOR)).setFriction(.3);
    c.setDensity(mass / Math.max(1e-4, 8 * half[0] * half[1] * half[2]));
    this.world.createCollider(c, body);
    const joint = this.world.createImpulseJoint(R.JointData.prismatic({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: axis.x, y: axis.y, z: axis.z }), base, body, true) as RAPIER.PrismaticImpulseJoint;
    joint.setLimits(0, travel);
    const record = { body, base, joint, last: start * travel, speed: 0 };
    this.mechanisms.add(record);
    const self = this, axisN = axis.clone().normalize();
    return {
      value() { const p = body.translation(); return (p.x - closed.x) * axisN.x + (p.y - closed.y) * axisN.y + (p.z - closed.z) * axisN.z; },
      drive(target, strength = 1) { body.wakeUp(); joint.configureMotorPosition(T.MathUtils.clamp(target, 0, travel), 260 * mass * strength, 42 * mass); },
      get speed() { return record.speed; },
      dispose() { if (self.mechanisms.delete(record) && !self.disposed) { self.world.removeImpulseJoint(joint, true); self.world.removeRigidBody(body); self.world.removeRigidBody(base); } },
    };
  }
  /** A door or a sash on its hinge: `leaf` is the leaf's centre relative to the hinge at angle 0, its limits in radians round `axis`. */
  hinge(at: T.Vector3, axis: T.Vector3, leaf: T.Vector3, half: [number, number, number], limits: [number, number], mass: number, start: number): Mechanism {
    const R = this.R;
    const base = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(at.x, at.y, at.z));
    const q = new T.Quaternion().setFromAxisAngle(axis, start), centre = leaf.clone().applyQuaternion(q).add(at);
    const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(centre.x, centre.y, centre.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setLinearDamping(1.5).setAngularDamping(3.2).setGravityScale(0));
    const c = R.ColliderDesc.cuboid(...half).setCollisionGroups(groups(G_MECH, G_THING | G_ACTOR)).setFriction(.3);
    c.setDensity(mass / Math.max(1e-4, 8 * half[0] * half[1] * half[2]));
    const leafCollider = this.world.createCollider(c, body);
    const local = leaf.clone().negate();
    const joint = this.world.createImpulseJoint(R.JointData.revolute({ x: 0, y: 0, z: 0 }, { x: local.x, y: local.y, z: local.z }, { x: axis.x, y: axis.y, z: axis.z }), base, body, true) as RAPIER.RevoluteImpulseJoint;
    joint.setLimits(limits[0], limits[1]);
    const record = { body, base, joint, last: start, speed: 0 };
    this.mechanisms.add(record);
    const self = this, tmp = new T.Quaternion(), axisN = axis.clone().normalize();
    let actorIgnored = false;
    return {
      value() {
        const r = body.rotation();
        tmp.set(r.x, r.y, r.z, r.w);
        const s = tmp.x * axisN.x + tmp.y * axisN.y + tmp.z * axisN.z;
        const ang = 2 * Math.atan2(s, tmp.w);
        const openWide = Math.abs(ang) > 0.82;
        if (openWide !== actorIgnored && leafCollider.isValid()) {
          actorIgnored = openWide;
          leafCollider.setCollisionGroups(groups(G_MECH, openWide ? G_THING : G_THING | G_ACTOR));
        }
        return ang;
      },
      drive(target, strength = 1) { body.wakeUp(); joint.configureMotorPosition(T.MathUtils.clamp(target, limits[0], limits[1]), 220 * mass * strength, 40 * mass); },
      get speed() { return record.speed; },
      dispose() { if (self.mechanisms.delete(record) && !self.disposed) { self.world.removeImpulseJoint(joint, true); self.world.removeRigidBody(body); self.world.removeRigidBody(base); } },
    };
  }

  // ── Furniture moved by force ────────────────────────────────────────────────────────────────────────
  /**
   * The furniture becomes a body on the floor: it slides and turns, never lifts or tips, and has its real mass. It stays exactly where it
   * stands until a push beats static friction; once going, sliding friction and its own inertia decide how it moves and stops. Walls and the
   * other furniture stop it by their footprints. `riders` (what stands on it) leave the room's colliders while it moves.
   */
  beginPush(entry: Entry, entries: Entry[], size: number, riders: string[], mass: number) {
    if (this.disposed) return false;
    this.endPush();
    const item = CATALOG_BY_ID[entry.obj.kind], s = entry.obj.scale;
    const w = Math.max(.12, (item?.size[0] ?? .5) * s), d = Math.max(.12, (item?.size[1] ?? .5) * s);
    const h = Math.max(.2, this.bounds(entry).getSize(new T.Vector3()).y);
    const p = entry.group.position, yaw = entry.group.rotation.y, q = new T.Quaternion().setFromAxisAngle(UP, yaw);
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.dynamic().setTranslation(p.x, h / 2 + .01, p.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .enabledTranslations(true, false, true).enabledRotations(false, true, false).setGravityScale(0).setLinearDamping(0).setAngularDamping(4).setCcdEnabled(true));
    const hx = Math.max(.04, w / 2 - .03), hz = Math.max(.04, d / 2 - .03), hy = Math.max(.08, h / 2 - .02);
    this.pushCollider = this.world.createCollider(this.R.ColliderDesc.cuboid(hx, hy, hz).setDensity(mass / (8 * hx * hy * hz)).setFriction(.3).setRestitution(0).setCollisionGroups(groups(G_PUSHED, G_FIXED | G_FURN | G_THING)).setActiveEvents(this.R.ActiveEvents.COLLISION_EVENTS), body);
    this.push = { id: entry.obj.id, body, entry, force: new T.Vector3(), spin: 0, breakaway: 0, sliding: 0, maxSpeed: 1, moving: false, still: 0, good: { x: p.x, z: p.z, yaw }, prev: { x: p.x, z: p.z, yaw } };
    this.ignore = new Set([entry.obj.id, ...riders]);
    this.sync(entries, size);
    return true;
  }
  /** What the hands bring this frame: newtons along the floor, the friction that holds it, how fast the legs can follow. */
  pushWith(force: T.Vector3, spin: number, breakaway: number, sliding: number, maxSpeed: number) {
    const ps = this.push;
    if (!ps) return;
    ps.force.copy(force).setY(0); ps.spin = spin; ps.breakaway = breakaway; ps.sliding = sliding; ps.maxSpeed = maxSpeed;
    if (force.lengthSq() > 0 || spin) ps.body.wakeUp();
  }
  /** Where the pushed furniture is now, in the stage: its centre on the floor and its yaw. */
  pushPose(): { x: number; z: number; yaw: number; speed: number; moving: boolean; blocked: boolean } | null {
    const ps = this.push;
    if (!ps) return null;
    const t = ps.body.translation(), r = ps.body.rotation(), v = ps.body.linvel();
    const yaw = 2 * Math.atan2(r.y, r.w);
    const speed = Math.hypot(v.x, v.z);
    return { x: t.x, z: t.z, yaw, speed, moving: ps.moving, blocked: ps.still > .35 && ps.force.length() >= ps.breakaway && ps.breakaway > 0 };
  }
  /** The body behind it has no room to follow: the furniture goes back to where it last was with room for both. */
  pushRevert() {
    const ps = this.push;
    if (!ps) return;
    const q = new T.Quaternion().setFromAxisAngle(UP, ps.good.yaw), t = ps.body.translation();
    ps.body.setTranslation({ x: ps.good.x, y: t.y, z: ps.good.z }, true);
    ps.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    ps.body.setLinvel({ x: 0, y: 0, z: 0 }, true); ps.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    ps.prev = { ...ps.good };
  }
  /** The pose to draw this frame: between the last two steps. */
  pushDrawn(): { x: number; z: number; yaw: number } | null {
    const ps = this.push;
    if (!ps) return null;
    const a = Math.min(1, this.accumulator * 60), t = ps.body.translation(), r = ps.body.rotation(), yaw = 2 * Math.atan2(r.y, r.w);
    const dy = Math.atan2(Math.sin(yaw - ps.prev.yaw), Math.cos(yaw - ps.prev.yaw));
    return { x: ps.prev.x + (t.x - ps.prev.x) * a, z: ps.prev.z + (t.z - ps.prev.z) * a, yaw: ps.prev.yaw + dy * a };
  }
  pushKeep() { const p = this.pushPose(); if (p && this.push) this.push.good = { x: p.x, z: p.z, yaw: p.yaw }; }
  get pushing() { return this.push?.id ?? null; }
  /** What stood on the furniture being pushed stops riding with it: it goes on the way it was going. */
  letRiderGo(id: string, velocity: T.Vector3) { this.ignore.delete(id); this.wake(id, velocity); }
  /** How the pushed furniture is going, the stage's axes. */
  pushVelocity(out: T.Vector3) { const v = this.push?.body.linvel(); return v ? out.set(v.x, 0, v.z) : out.set(0, 0, 0); }
  /** Hands off: the body is gone, the furniture stands where it came to rest. */
  endPush(entries?: Entry[], size?: number) {
    const ps = this.push;
    this.push = null; this.ignore.clear(); this.pushCollider = null;
    if (!ps) return null;
    const pose = { x: ps.body.translation().x, z: ps.body.translation().z, yaw: 2 * Math.atan2(ps.body.rotation().y, ps.body.rotation().w) };
    if (!this.disposed) this.world.removeRigidBody(ps.body);
    if (entries && size) this.sync(entries, size);
    return pose;
  }

  /** Nothing can move: no reason to spend a physics step. */
  get asleep() { return !this.bodies.size && !this.mechanisms.size && !this.push && ![...this.solids.values()].some(s => s.rack?.awake()); }
  /** Applies the hands' force and the floor's friction for one fixed step. Static friction holds until beaten; sliding friction never reverses the motion. */
  private stepPush(h: number) {
    const ps = this.push;
    if (!ps) return;
    const b = ps.body, v = b.linvel(), m = b.mass(), F = ps.force, Fm = Math.hypot(F.x, F.z), speed = Math.hypot(v.x, v.z);
    if (speed < .02 && Fm < ps.breakaway) {
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      ps.moving = false;
    } else {
      ps.moving = true;
      const dx = speed > .02 ? v.x / speed : F.x / Math.max(1e-6, Fm), dz = speed > .02 ? v.z / speed : F.z / Math.max(1e-6, Fm);
      b.applyImpulse({ x: (F.x - dx * ps.sliding) * h, y: 0, z: (F.z - dz * ps.sliding) * h }, true);
      const n = b.linvel(), ns = Math.hypot(n.x, n.z);
      // Friction stops it; it never pushes it back the other way.
      if (n.x * dx + n.z * dz < 0 && Fm < ps.sliding) { b.setLinvel({ x: 0, y: 0, z: 0 }, true); ps.moving = false; }
      else if (ns > ps.maxSpeed) b.setLinvel({ x: n.x / ns * ps.maxSpeed, y: 0, z: n.z / ns * ps.maxSpeed }, true);
      void m;
    }
    // The hands decide whether it may turn (they gate it on the strength put in); Rapier keeps the turn out of the walls.
    b.setAngvel({ x: 0, y: ps.spin, z: 0 }, true);
    ps.still = Fm >= ps.breakaway && speed < .02 ? ps.still + h : 0;
  }

  update(dt: number) {
    if (this.disposed) return;
    if (this.asleep) { this.accumulator = 0; return; }
    for (const record of this.bodies.values()) this.refreshMass(record);
    this.accumulator = Math.min(MAX_ACCUMULATOR, this.accumulator + dt);
    const plannedSteps = Math.min(MAX_STEPS_PER_FRAME, Math.floor(this.accumulator / FIXED_STEP));
    const steppedSeconds = plannedSteps * FIXED_STEP;
    const workPaths = this.workPathsScratch;
    workPaths.clear();
    if (plannedSteps > 0) for (const hold of this.holds.values()) {
      const velocity = hold.velocity ??= new T.Vector3();
      const body = this.bodies.get(hold.id)?.body;
      if (hold.motionTarget && body) {
        const p = body.translation(), q = body.rotation();
        let wp = this.workPathPool.get(hold);
        if (!wp) { wp = { from: new T.Vector3(), rotation: new T.Quaternion() }; this.workPathPool.set(hold, wp); }
        wp.from.set(p.x, p.y, p.z);
        wp.rotation.set(q.x, q.y, q.z, q.w);
        workPaths.set(hold, wp);
      }
      const path = workPaths.get(hold);
      if (path && !hold.stationaryTarget) velocity.copy(hold.target).sub(path.from).divideScalar(steppedSeconds).clampLength(0, 3);
      else if (hold.previousTarget && !hold.stationaryTarget) velocity.copy(hold.target).sub(hold.previousTarget).divideScalar(steppedSeconds).clampLength(0, 3);
      else velocity.set(0, 0, 0);
      (hold.previousTarget ??= new T.Vector3()).copy(hold.target);
      const angular = hold.angularVelocity ??= new T.Vector3();
      angular.set(0, 0, 0);
      const previousRotation = path?.rotation ?? hold.previousRotation;
      if (hold.rotation && previousRotation && !hold.stationaryTarget) {
        _pQ4.copy(previousRotation).invert();
        const delta = _pQ3.copy(hold.rotation).multiply(_pQ4).normalize();
        if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
        const n = Math.hypot(delta.x, delta.y, delta.z);
        if (n > 1e-8) angular.set(delta.x, delta.y, delta.z).multiplyScalar(2 * Math.atan2(n, delta.w) / (n * steppedSeconds)).clampLength(0, 6);
      }
      if (hold.rotation) (hold.previousRotation ??= new T.Quaternion()).copy(hold.rotation);
      else hold.previousRotation = undefined;
    }
    let workTime = 0;
    let stepsRun = 0;
    while (this.accumulator >= FIXED_STEP && stepsRun < MAX_STEPS_PER_FRAME) {
      stepsRun++;
      workTime += FIXED_STEP;
      this.updateRackGuides();
      for (const hold of this.holds.values()) {
        const held = this.bodies.get(hold.id);
        if (!held) continue;
        if (hold.supportTrial) {
          hold.rackBias = undefined; hold.rackBiasTarget = undefined;
          if (this.supportReaction(held, hold.supportTrial.id).touching) {
            if (hold.force) held.body.addForce(_pV6.copy(hold.force).negate(), true);
            hold.force = undefined;
            continue;
          }
          this.cancelSupportedRelease(this.sideOf(hold.id)!);
        }
        const p = held.body.translation(), v = held.body.linvel(), mass = held.body.mass();
        const path = workPaths.get(hold), phase = Math.min(1, workTime / steppedSeconds);
        const target = path && !hold.stationaryTarget ? _pV1.copy(path.from).lerp(hold.target, phase) : hold.target;
        const rotation = path && hold.rotation && !hold.stationaryTarget ? _pQ1.copy(path.rotation).slerp(hold.rotation, phase) : hold.rotation;
        // Bounded spring impulse: collisions are solved by Rapier, never teleported through furniture.
        // Critically damped: it arrives without swinging, and it never takes more force than a hand has, so a wall still stops it.
        _pV2.set(p.x, p.y, p.z);
        if (hold.lifting && hold.target.distanceTo(_pV2) < .12) { hold.lifting = false; this.withBody(held, false); }
        const damping = 2 * Math.sqrt(hold.stiffness), step = 1 / 60;
        const force = (hold.force ??= new T.Vector3());
        if (hold.force) held.body.addForce(_pV5.copy(hold.force).negate(), true);
        _pV3.set(v.x, v.y, v.z);
        force.copy(target).sub(_pV2).multiplyScalar(hold.stiffness).addScaledVector(_pV4.copy(_pV3).sub(hold.velocity!), -damping);
        // A static spring alone leaves an equilibrium offset against the
        // rack's opposing spring fingers. A bounded hand-force integrator
        // closes that small residual at a fixed insertion waypoint. It resets
        // with motion/target changes and contributes nothing to support proof.
        if (hold.rackTransfer && hold.stationaryTarget) {
          const bias = hold.rackBias ??= new T.Vector3();
          if (!hold.rackBiasTarget || hold.rackBiasTarget.distanceTo(target) > .00002) bias.set(0, 0, 0);
          (hold.rackBiasTarget ??= new T.Vector3()).copy(target);
          _pV4.copy(target).sub(_pV2);
          if (_pV4.length() <= .0025) bias.addScaledVector(_pV4, hold.stiffness * 4 * step).clampLength(0, hold.stiffness * .0025);
          force.add(bias);
        } else { hold.rackBias = undefined; hold.rackBiasTarget = undefined; }
        // Implicit PD evaluates the position term at the next fixed step.
        // Keep the same force limits and let Rapier solve every collision.
        if (path && !hold.stationaryTarget) force.addScaledVector(_pV3, -hold.stiffness * step).divideScalar(1 + damping * step + hold.stiffness * step * step);
        force.y += 9.81; force.clampLength(0, 90).multiplyScalar(mass);
        // Gravity and the hand must act throughout the same integration step.
        // A once-per-step gravity impulse left a reproducible 8.71mm hover bias.
        // Remove only our prior force; preserve other forces and contact impulses.
        held.body.addForce(force, true);
        // Torque drives orientation through the same collision solver as translation. Direct setRotation bypassed collision response.
        const r = held.body.rotation();
        _pQ2.set(r.x, r.y, r.z, r.w).invert();
        const targetRot = rotation ?? uprightQuatFrom(r, _pQ4);
        const error = _pQ3.copy(targetRot).multiply(_pQ2).normalize();
        if (error.w < 0) error.set(-error.x, -error.y, -error.z, -error.w);
        const n = Math.hypot(error.x, error.y, error.z), omega = held.body.angvel();
        _pV3.set(omega.x, omega.y, omega.z);
        const a = _pV4.set(error.x, error.y, error.z).multiplyScalar(n > 1e-8 ? 2 * Math.atan2(n, error.w) * 400 / n : 0)
          .addScaledVector(_pV5.copy(_pV3).sub(hold.angularVelocity!), -40);
        if (path && !hold.stationaryTarget) a.addScaledVector(_pV3, -400 * step).divideScalar(1 + 40 * step + 400 * step * step);
        a.clampLength(0, 400);
        const I = held.body.effectiveAngularInertia();
        const torque = _pV5.set(I.m11 * a.x + I.m12 * a.y + I.m13 * a.z, I.m21 * a.x + I.m22 * a.y + I.m23 * a.z, I.m31 * a.x + I.m32 * a.y + I.m33 * a.z).clampLength(0, 20);
        held.body.applyTorqueImpulse(torque.multiplyScalar(1 / 60), true);
      }
      this.stepPush(1 / 60);
      // The pose before this step: what is drawn between two steps is a blend of these two, never a 60 Hz staircase on a faster screen.
      for (const record of this.bodies.values()) { const t = record.body.translation(), r = record.body.rotation(), v = record.body.linvel(); record.prevP.set(t.x, t.y, t.z); record.prevQ.set(r.x, r.y, r.z, r.w); record.before.set(v.x, v.y, v.z); }
      if (this.push) { const t = this.push.body.translation(), r = this.push.body.rotation(); this.push.prev = { x: t.x, z: t.z, yaw: 2 * Math.atan2(r.y, r.w) }; }
      for (const solid of this.solids.values()) solid.rack?.beforeStep();
      this.world.step(this.events); this.stale = false; this.accumulator -= 1 / 60;
      this.afterStep();
      for (const h of this.holds.values()) if (h.supportTrial) h.supportTrial.load = 0;
      // In pinned Rapier 0.12 small-steps mode the force event reports the
      // final solver substep's impulse divided by the OUTER step duration.
      // Normalize by its substep count (verified at 1/2/4/8 iterations).
      // Geometric contactImpulse can be zero for convex/trimesh contacts even
      // when this event contains their reaction; never infer load from it.
      this.events.drainContactForceEvents(e => {
        for (const [owned, other, sign] of [[e.collider1(), e.collider2(), -1], [e.collider2(), e.collider1(), 1]]) {
          const id = this.colliderOf.get(owned), side = id ? this.sideOf(id) : null;
          const trial = side === null ? null : this.holds.get(side)?.supportTrial;
          if (trial && this.solidOf_.get(other) === trial.id) trial.load += Math.max(0, e.totalForce().y * sign) * this.world.integrationParameters.numSolverIterations;
        }
      });
      for (const hold of this.holds.values()) {
        const trial = hold.supportTrial, record = this.bodies.get(hold.id);
        if (!trial || !record) continue;
        const support = this.supportReaction(record, trial.id), v = record.body.linvel(), w = record.body.angvel();
        // Sleeping islands retain their solved contact impulses but emit no
        // new force events. Preserve the last measured reaction only while
        // the same physical support contact remains and the body is asleep.
        // Any awake step, cancellation, support loss or changed mass still
        // has to satisfy the original load and motion gates anew.
        if (!record.body.isSleeping() || trial.load > 0) trial.lastMeasuredLoad = trial.load;
        else if (support.touching) trial.load = trial.lastMeasuredLoad ?? 0;
        const stable = support.touching && trial.load >= record.body.mass() * 9.81 * .95
          && Math.hypot(v.x, v.y, v.z) < .01 && Math.hypot(w.x, w.y, w.z) < .01;
        trial.time = stable ? trial.time + 1 / 60 : 0;
      }
    }
    const alpha = Math.min(1, this.accumulator * 60);
    for (const solid of this.solids.values()) solid.rack?.draw(alpha);
    for (const m of this.mechanisms) { const v = m.body.linvel(), w = m.body.angvel(); m.speed = Math.hypot(v.x, v.y, v.z) + Math.hypot(w.x, w.y, w.z); }
    for (const [id, record] of this.bodies) {
      const t = record.body.translation(), r = record.body.rotation();
      _pV1.set(t.x, t.y, t.z);
      _pV2.copy(record.prevP).lerp(_pV1, alpha);
      _pQ2.set(r.x, r.y, r.z, r.w);
      _pQ1.copy(record.prevQ).slerp(_pQ2, alpha);
      _pV3.copy(record.center).applyQuaternion(_pQ1);
      record.entry.group.position.set(_pV2.x - _pV3.x, _pV2.y - _pV3.y, _pV2.z - _pV3.z);
      record.entry.group.quaternion.copy(_pQ1).multiply(record.q0);
      if (this.sideOf(id) === null) {
        record.time += dt;
        const v = record.body.linvel(), w = record.body.angvel();
        const speed = Math.hypot(v.x, v.y, v.z);
        const angSpeed = Math.hypot(w.x, w.y, w.z);
        // The first hard stop is the sound of it landing.
        if (!record.contacted && record.time > .03 && record.lastSpeed > .55 && speed < record.lastSpeed * .55) {
          record.contacted = true;
          this.onImpact?.(id, record.lastSpeed);
        }
        record.lastSpeed = speed;
        // Engage surface resting damping (`linear >= 1.8`, `angular >= 2.8`) once touching or settling on a surface
        // so dropped/bumped cups, books, pots, and tools never slide endlessly or micro-jitter.
        if (!record.surfaceDamped && (record.contacted || (record.time > .08 && Math.abs(v.y) < .16))) {
          const low = this.lowest(record, _pQ2);
          if (this.surfaceBelow(_pV4.set(t.x, t.y + low.y + .012, t.z), .028, id, _pV5)) {
            this.applyRestingStability(record, false);
          }
        }
        // Come to rest: a small light thing (a mouse, a pen) keeps a tremble of velocity on its contacts for ever while its pose does not change.
        // Rest is judged by the pose, as an eye would: within 2 mm and 2 deg for a third of a second, or a velocity that is really gone.
        const turned = record.restQ.angleTo(_pQ2);
        if (record.restP.distanceTo(_pV1) > .002 || turned > .035) { record.restP.set(t.x, t.y, t.z); record.restQ.set(r.x, r.y, r.z, r.w); record.restT = 0; }
        else record.restT += dt;
        if (record.surfaceDamped && record.restT > .16 && speed < .025 && angSpeed < .12 && !record.body.isSleeping()) {
          record.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
          record.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
          record.body.sleep();
        }
        if ((record.time > .5 && ((speed < .05 && angSpeed < .3) || record.restT > .32)) || record.time > 8) this.settle(id, record);
      } else { record.contacted = false; record.lastSpeed = 0; }
    }
  }
  private settle(id: string, record: Body) {
    const p = record.entry.group.position;
    const minY = this.worldSolidBuckets.size ? -20 : -.05;
    const bt = record.body.translation(), br = record.body.rotation();
    const hasBodyPose = Number.isFinite(bt.x + bt.y + bt.z) && Number.isFinite(br.x + br.y + br.z + br.w);
    const bottomY = hasBodyPose
      ? bt.y + this.lowest(record, _pQ1.set(br.x, br.y, br.z, br.w)).y
      : p.y;
    let restoredFallback = false;
    if (!Number.isFinite(p.x + p.y + p.z) || (p.y < minY && bottomY < minY)) {
      p.copy(record.start);
      record.entry.group.quaternion.copy(record.startQuat);
      restoredFallback = true;
    }
    const q = record.entry.group.quaternion;
    const wasSlightlyTilted = worldUpYFromQuat(q) < 0.999999;
    const upright = worldUpYFromQuat(q) >= SETTLE_UPRIGHT_MIN_UP_Y;
    if (upright) {
      uprightQuatFrom(q, q);
      if (hasBodyPose && !restoredFallback && wasSlightlyTilted) {
        // Keep the uprighted object's bottom flush with the measured contact surface (`0.25 mm` skin).
        _settleQ0Inv.copy(record.q0).invert();
        _settleBodyQ.copy(q).multiply(_settleQ0Inv).normalize();
        const uprightLowY = this.lowest(record, _settleBodyQ).y;
        const settledCenterY = bottomY - uprightLowY;
        _settleOffset.copy(record.center).applyQuaternion(_settleBodyQ);
        p.set(bt.x - _settleOffset.x, settledCenterY - _settleOffset.y, bt.z - _settleOffset.z);
      }
    }
    const normalized = normalizeSpaceObjectOrientation(q);
    const inRoom = Math.abs(p.x) <= this.roomSize / 2 && Math.abs(p.z) <= this.roomSize / 2;
    const pos: [number, number, number] = [p.x, inRoom && p.y > -.02 ? Math.max(0, p.y) : p.y, p.z];
    for (const c of record.colliders) this.colliderOf.delete(c.handle);
    this.removeRackGuide(id); this.bodies.delete(id); this.world.removeRigidBody(record.body);
    this.commit(id, pos, normalized.rotY, upright || !normalized.quat ? null : normalized.quat);
  }
  flush() {
    this.dropAll();
    // Exiting while an object is airborne restores its last safe placement. No floating saved layout.
    for (const [id, record] of this.bodies) { record.entry.group.position.copy(record.start); record.entry.group.quaternion.copy(record.startQuat); this.settle(id, record); }
  }
  get diagnostics() { return { held: this.heldIds, bodies: this.bodies.size, mechanisms: this.mechanisms.size, solids: this.solids.size }; }
  // Scope changes/unmount MUST discard: callbacks may already address the next room/account.
  // Explicit route departure calls flush() while the original room is still current.
  dispose() { if (this.disposed) return; for (const id of this.rackGuides.keys()) this.removeRackGuide(id); for (const solid of this.solids.values()) solid.rack?.dispose(); this.holds.clear(); this.cachedHeldIds.length = 0; this.heldIdsDirty = false; this.bodies.clear(); this.mechanisms.clear(); this.solids.clear(); this.solidOf_.clear(); this.footOf.clear(); this.colliderOf.clear(); this.worldSolidBuckets.clear(); this.parkedVehicleColliders.colliders.length = 0; this.parkedVehicleColliders.sig = ''; this.extraPlugs.length = 0; this.doorLeafColliders.clear(); this.queryCapsule = null; this.queryCuboids.clear(); this.roomSolid = null; this.push = null; this.ignore.clear(); this.disposed = true; this.events.free(); this.world.free(); }
}
