import * as T from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { stepSpring } from '@/lib/morph/spring';
import { mat, type MatKind } from '../materials';
import { gatewayAsset } from '../gatewayAssets';
import {
  DOOR_W,
  GROUND_Y,
  UPPER_WALL_TOP,
  WALL,
  houseZoneAt,
  type Door,
  type DoorId,
  type HousePlan,
  type WallSpan,
} from '@/lib/echo-life/plan';
import {
  LIFE_ASSETS,
  acquireLifeAsset,
  placeOn,
  releaseLifeAsset,
  type LifeAsset,
  type Prepared,
  type PreparedPart,
} from './assets';
import { patchHeightFog } from './atmosphere';
import { patchMaterialWithEchoCsm } from './echoCsm';
import { getEchoLifeTextureUploadQueue, LoadPriority } from './loadScheduler';
import type { QualityTier } from './renderConfig';
import { createSharedWeatherUniforms, type SharedWeatherUniforms } from './weatherSystem';
import { WorldSurfaceLibrary, type ArchitecturalGlassHandle } from './worldSurfaces';
import { instanceStreetProp, loadStreetProp, placeStreetPropOn } from './streetPropsManifest';

/** An axis-aligned solid in stage metres: what the house gives Rapier (floors, walls, treads, furniture) for things and feet. */
export interface SolidBox { hx: number; hy: number; hz: number; x: number; y: number; z: number }

export type DoorPhase = 'closed' | 'opening' | 'open' | 'occupied' | 'closing';

export interface DoorOccupant {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  readonly id?: string;
}

export interface DoorRuntimeSnapshot {
  readonly id: DoorId;
  readonly phase: DoorPhase;
  readonly angle: number;
  readonly dir: 1 | -1;
  readonly passable: boolean;
  readonly pendingClose: boolean;
  readonly occupiedByPlayer: boolean;
  readonly occupiedByNpc: boolean;
}

export interface ShowerEmitterSpec {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly floorY: number;
  readonly radius: number;
  readonly valve: { readonly x: number; readonly y: number; readonly z: number };
  readonly zoneId: string;
}

export interface HouseMirrorPlacement {
  readonly id: string;
  readonly zoneId: string;
  readonly matrixWorld: T.Matrix4;
  readonly part: PreparedPart;
}

/**
 * A house door: the same contract as the study room's Arena / Games doors (`RoomBuild.door`), so the Manipulator opens it
 * with the same hand on the same lever and the same Rapier revolute joint. `hinge()` says where that joint is.
 */
export interface LifeDoor {
  readonly id: DoorId;
  readonly plan: Door;
  handleWorld(out: T.Vector3): T.Vector3;
  setOpen(open: boolean): void;
  setAngle(angle: number | null): void;
  readonly isOpen: boolean;
  /** Open far enough for a body to pass the leaf. */
  readonly passable: boolean;
  readonly phase: DoorPhase;
  readonly pendingClose: boolean;
  updateOccupancy(occupants: readonly DoorOccupant[]): void;
  snapshot(): DoorRuntimeSnapshot;
  press(k: number): void;
  readonly angle: number;
  /** The leaf swings away from whoever opens it: the side the body stands on picks the way (stage metres). */
  prepare(body: { x: number; z: number }): void;
  hinge(): { at: T.Vector3; leaf: T.Vector3; half: [number, number, number]; limits: [number, number]; open: number };
  /** The leaf where the world save left it (a reload): its swing side follows the angle's sign; no hand, no sound. */
  restore(angle: number): void;
}

export interface HouseBuild {
  group: T.Group;
  interiorGroup: T.Group;
  doors: Map<DoorId, LifeDoor>;
  /** What the third-person camera must not pass through. */
  blockers: T.Object3D[];
  solids: SolidBox[];
  /** Ceiling lights: the world's small pool of real lights moves to the ones near the body. */
  fixtures: { at: T.Vector3; room: string; warm: boolean }[];
  /** Extracted `Mirror_Glass` planar mirror placements populated during `furnish()`. */
  mirrorPlacements: HouseMirrorPlacement[];
  /** Overhead rain-showerhead & wall mixer telemetry for walk-in shower spray/steam VFX. */
  showerEmitterSpec: ShowerEmitterSpec | null;
  furnish(): Promise<boolean>;
  setFinishes(finishes: Record<string, { wallColor: string; floorColor: string }>): void;
  setNight(night: number): void;
  setTvActive(on: boolean): void;
  readonly isTvActive: boolean;
  isInteriorVisible(): boolean;
  setQuality?(tier: QualityTier): void;
  setCameraPos?(pos: T.Vector3): void;
  update(dt: number, reduced: boolean, body: { x: number; z: number }): void;
  dispose(): void;
}

export interface BuildHouseOptions {
  surfaces?: WorldSurfaceLibrary;
  tier?: QualityTier;
  weather?: SharedWeatherUniforms;
}

const OPEN = -1.32;
const DOOR_OPEN = { stiffness: 26, damping: 8.4, mass: 1, precision: .001 };
const DOOR_CLOSE = { stiffness: 34, damping: 10, mass: 1, precision: .001 };
const DOOR_OPEN_SETTLED_RAD = 0.92;
const DOOR_CLOSED_EPS_RAD = 0.025;
const DOOR_OCCUPANCY_HYST = 0.12;

function shortestArcRad(fromRad: number, toRad: number): number {
  let d = (toRad - fromRad) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function sdDoorOpeningRect(px: number, pz: number, d: Door): number {
  const hx = d.wallAlong === 'x' ? d.width * 0.5 : WALL * 0.5;
  const hz = d.wallAlong === 'z' ? d.width * 0.5 : WALL * 0.5;
  const dx = Math.abs(px - d.x) - hx;
  const dz = Math.abs(pz - d.z) - hz;
  const ox = dx > 0 ? dx : 0;
  const oz = dz > 0 ? dz : 0;
  return Math.hypot(ox, oz) + Math.min(Math.max(dx, dz), 0);
}

function overlapsDoorSweepSector(
  ox: number,
  oz: number,
  r: number,
  hingeX: number,
  hingeZ: number,
  baseYaw: number,
  swingSpan: number,
  maxRadius: number,
  hyst: number,
): boolean {
  if (Math.abs(swingSpan) <= 1e-4) return false;
  const dx = ox - hingeX;
  const dz = oz - hingeZ;
  const dist = Math.hypot(dx, dz);
  if (dist > maxRadius) return false;
  const effR = r + 0.04 + hyst;
  if (dist <= effR) return true;
  const midWorldYaw = baseYaw - swingSpan * 0.5;
  const halfSpan = Math.abs(swingSpan) * 0.5;
  const angDiff = Math.abs(shortestArcRad(midWorldYaw, Math.atan2(dz, dx)));
  const angPad = Math.asin(Math.min(1, effR / dist));
  return angDiff <= halfSpan + angPad;
}

export interface DoorPart {
  plan: Door;
  hingeX: number;
  hingeZ: number;
  baseYaw: number;
  state: {
    spring: { position: number; velocity: number };
    open: boolean;
    desiredOpen: boolean;
    pendingClose: boolean;
    phase: DoorPhase;
    occupiedNow: boolean;
    occupiedByPlayer: boolean;
    occupiedByNpc: boolean;
    explicitOccTick: boolean;
    leverNow: number;
    leverTarget: number;
    physical: boolean;
    dir: 1 | -1;
  };
  pivot: T.Group;
  lever: T.Group;
  frame: T.Group;
  distantLeaf: T.Group;
}

function syncLifeDoorPartOccupancy(part: DoorPart, occupants: readonly DoorOccupant[]): void {
  const { plan: d, hingeX, hingeZ, baseYaw, state } = part;
  const hyst = state.phase === 'occupied' ? DOOR_OCCUPANCY_HYST : 0;
  const targetOpenAngle = OPEN * state.dir;
  let inGuard = false;
  let inRemaining = false;
  let byPlayer = false;
  let byNpc = false;

  for (let i = 0; i < occupants.length; i++) {
    const occ = occupants[i];
    if (Math.abs(occ.y - d.y) > 1.65) continue;
    const r = Math.max(0.18, occ.radius);
    const sdOpen = sdDoorOpeningRect(occ.x, occ.z, d);
    const hitGuard =
      sdOpen <= r + 0.12 + hyst ||
      overlapsDoorSweepSector(
        occ.x,
        occ.z,
        r,
        hingeX,
        hingeZ,
        baseYaw,
        targetOpenAngle,
        d.width + r + 0.06 + hyst,
        hyst,
      );
    if (hitGuard) {
      inGuard = true;
      if (occ.id === 'player' || occ.id === undefined) byPlayer = true;
      else byNpc = true;
    }
    if (
      Math.abs(state.spring.position) > DOOR_CLOSED_EPS_RAD &&
      (sdOpen <= r + 0.08 ||
        overlapsDoorSweepSector(
          occ.x,
          occ.z,
          r,
          hingeX,
          hingeZ,
          baseYaw,
          state.spring.position,
          d.width + r + 0.06,
          0,
        ))
    ) {
      inRemaining = true;
    }
  }

  state.occupiedNow = inGuard;
  state.occupiedByPlayer = byPlayer;
  state.occupiedByNpc = byNpc;

  if (state.phase === 'closing' && inRemaining) {
    // Immediate safety auto-reverse (`closing -> opening -> occupied`): 0 corner wedging, 0 closing onto moving player!
    state.desiredOpen = true;
    state.open = true;
    state.pendingClose = true;
    state.physical = false;
    state.phase = Math.abs(state.spring.position) >= DOOR_OPEN_SETTLED_RAD ? 'occupied' : 'opening';
    return;
  }

  if (state.phase === 'occupied') {
    if (!inGuard) {
      if (state.pendingClose) {
        state.pendingClose = false;
        state.desiredOpen = false;
        state.open = false;
        state.phase = Math.abs(state.spring.position) <= DOOR_CLOSED_EPS_RAD ? 'closed' : 'closing';
      } else {
        state.phase = Math.abs(state.spring.position) >= DOOR_OPEN_SETTLED_RAD ? 'open' : 'opening';
      }
    }
    return;
  }

  if (state.desiredOpen || state.open) {
    if (Math.abs(state.spring.position) >= DOOR_OPEN_SETTLED_RAD) {
      if (inGuard) {
        state.phase = 'occupied';
      } else if (state.pendingClose) {
        state.pendingClose = false;
        state.desiredOpen = false;
        state.open = false;
        state.phase = 'closing';
      } else {
        state.phase = 'open';
      }
    } else {
      state.phase = inGuard && state.pendingClose ? 'occupied' : 'opening';
    }
  } else {
    state.phase = Math.abs(state.spring.position) <= DOOR_CLOSED_EPS_RAD ? 'closed' : 'closing';
  }
}

const SINGLE_DOOR_OCC_SCRATCH: DoorOccupant[] = [{ x: 0, y: 0, z: 0, radius: 0.26, id: 'player' }];

/** Returns true when a `PreparedPart` represents reflective `Mirror_Glass` reserved for `PlanarMirrorSystem`. */
export function isMirrorGlassPart(part: PreparedPart): boolean {
  const role = (part as { role?: string }).role ?? (part.material?.userData?.partRole as string | undefined);
  if (role === 'mirror-glass') return true;
  const pName = (part as { name?: string }).name ?? '';
  const mName = part.material?.name ?? '';
  const gName = part.geometry?.name ?? '';
  return pName === 'Mirror_Glass' || mName === 'Mirror_Glass' || gName === 'Mirror_Glass';
}

/** Shared physical door builder used by both the home (`buildHouse`) and all 13 enterable city buildings (`buildingsView`). */
export function createLifeDoor(d: Door, parent: T.Group, owned: { dispose(): void }[], doorParts: DoorPart[]): LifeDoor {
  const leafM = mat('wood', '#47736e'), panelM = mat('paint', '#365f5b'), brass = mat('brass', '#c3a67b'), jamb = mat('wood', '#806346');
  const out = new T.Vector3(Math.sin(d.yaw), 0, Math.cos(d.yaw));
  const frame = new T.Group(); frame.position.set(d.x - out.x * .08, d.y, d.z - out.z * .08); frame.rotation.y = d.yaw; parent.add(frame);
  const pivot = new T.Group(); pivot.position.set(-DOOR_W / 2 + .02, 0, .03); frame.add(pivot);
  const lever = new T.Group(); pivot.add(lever);
  const authored = gatewayAsset();
  if (authored) {
    frame.add(authored.frame); pivot.add(authored.leaf);
    lever.position.set(.85, 1.09, -.122); authored.handle.position.set(-.85, -1.09, .122); lever.add(authored.handle);
  } else {
    const bx = (p: T.Object3D, w: number, h: number, dd: number, x: number, y: number, z: number, m: T.Material) => {
      const g = new T.BoxGeometry(w, h, dd); owned.push(g);
      const mesh = new T.Mesh(g, m); mesh.position.set(x, y, z); mesh.castShadow = mesh.receiveShadow = true; p.add(mesh);
    };
    for (const sign of [-1, 1]) bx(frame, .11, 2.44, .23, sign * (DOOR_W / 2 + .02), 1.22, 0, jamb);
    bx(frame, DOOR_W + .16, .13, .23, 0, 2.34, 0, jamb);
    bx(pivot, DOOR_W - .04, 2.28, .055, (DOOR_W - .04) / 2, 1.16, 0, leafM);
    for (const y of [.56, 1.57]) bx(pivot, DOOR_W - .25, .84, .021, DOOR_W / 2 - .02, y, -.052, panelM);
    lever.position.set(DOOR_W - .16, 1.11, -.1);
    bx(lever, .15, .032, .035, -.05, 0, -.03, brass);
  }
  frame.traverse(o => { o.userData.lifeDoor = d.id; });
  pivot.traverse(o => { o.userData.isDoorLeaf = true; });
  const state: DoorPart['state'] = {
    spring: { position: 0, velocity: 0 },
    open: false,
    desiredOpen: false,
    pendingClose: false,
    phase: 'closed',
    occupiedNow: false,
    occupiedByPlayer: false,
    occupiedByNpc: false,
    explicitOccTick: false,
    leverNow: 0,
    leverTarget: 0,
    physical: false,
    dir: 1,
  };
  const distantLeaf = new T.Group();
  const leafGeo = new T.BoxGeometry(DOOR_W, 2.3, .06);
  owned.push(leafGeo);
  const leaf = new T.Mesh(leafGeo, leafM);
  leaf.position.set(DOOR_W / 2, 1.15, 0);
  distantLeaf.add(leaf);
  distantLeaf.position.copy(pivot.position).applyAxisAngle(new T.Vector3(0, 1, 0), d.yaw).add(frame.position);
  distantLeaf.visible = false;
  distantLeaf.traverse(o => { o.userData.isDoorLeaf = true; });
  parent.add(distantLeaf);
  const right = new T.Vector3(Math.cos(d.yaw), 0, -Math.sin(d.yaw));
  const hingeAt = frame.position.clone().addScaledVector(right, -DOOR_W / 2 + .02).addScaledVector(out, .03).setY(d.y + 1.16);
  const baseYaw = Math.atan2(right.z, right.x);
  const across = Math.abs(right.x) > .5;
  const part: DoorPart = {
    plan: d,
    hingeX: hingeAt.x,
    hingeZ: hingeAt.z,
    baseYaw,
    state,
    pivot,
    lever,
    frame,
    distantLeaf,
  };
  doorParts.push(part);

  return {
    id: d.id,
    plan: d,
    handleWorld: o => lever.localToWorld(o.set(-.065, 0, -.038)),
    setOpen(open) {
      state.physical = false;
      if (open) {
        state.desiredOpen = true;
        state.open = true;
        state.pendingClose = false;
        state.phase =
          Math.abs(state.spring.position) >= DOOR_OPEN_SETTLED_RAD
            ? (state.occupiedNow ? 'occupied' : 'open')
            : 'opening';
      } else if (
        state.occupiedNow &&
        (state.desiredOpen || state.open || Math.abs(state.spring.position) > 0.08)
      ) {
        // Hold door in `'occupied'` at open target until occupants clear Guard Zone + 0.12 m hysteresis!
        state.desiredOpen = true;
        state.open = true;
        state.pendingClose = true;
        state.phase = 'occupied';
      } else {
        state.desiredOpen = false;
        state.open = false;
        state.pendingClose = false;
        state.phase = Math.abs(state.spring.position) <= DOOR_CLOSED_EPS_RAD ? 'closed' : 'closing';
      }
    },
    setAngle(angle) {
      state.physical = angle !== null;
      if (angle !== null) {
        state.spring = { position: angle, velocity: 0 };
        if (state.occupiedNow && !state.desiredOpen && Math.abs(angle) > 0.08) {
          state.desiredOpen = true;
          state.open = true;
          state.pendingClose = true;
          state.phase = 'occupied';
        } else if (state.desiredOpen) {
          state.open = true;
        } else {
          state.open = Math.abs(angle) > .3;
        }
      }
    },
    get isOpen() { return state.open && !state.pendingClose; },
    get passable() {
      return state.phase === 'open' || state.phase === 'occupied' || Math.abs(state.spring.position) > .55;
    },
    get phase() { return state.phase; },
    get pendingClose() { return state.pendingClose; },
    updateOccupancy(occupants) {
      state.explicitOccTick = true;
      syncLifeDoorPartOccupancy(part, occupants);
    },
    snapshot: () => ({
      id: d.id,
      phase: state.phase,
      angle: state.spring.position,
      dir: state.dir,
      passable: state.phase === 'open' || state.phase === 'occupied' || Math.abs(state.spring.position) > .55,
      pendingClose: state.pendingClose,
      occupiedByPlayer: state.occupiedByPlayer,
      occupiedByNpc: state.occupiedByNpc,
    }),
    press(k) { state.leverTarget = k; },
    get angle() { return state.spring.position; },
    prepare(at) {
      if (!state.open && Math.abs(state.spring.position) < .15) {
        state.dir = (at.x - d.x) * out.x + (at.z - d.z) * out.z > 0 ? -1 : 1;
      }
    },
    hinge: () => ({
      at: hingeAt.clone(),
      leaf: right.clone().multiplyScalar(.47),
      half: across ? [.47, 1.14, .028] : [.028, 1.14, .47],
      limits: state.dir > 0 ? [OPEN, 0] : [0, -OPEN],
      open: OPEN * state.dir,
    }),
    restore(angle) {
      const a = Math.max(-Math.abs(OPEN), Math.min(Math.abs(OPEN), angle));
      if (Math.abs(a) > .02) state.dir = Math.sign(a) === Math.sign(OPEN) ? 1 : -1;
      state.spring = { position: a, velocity: 0 };
      const isOp = Math.abs(a) > .3;
      state.open = isOp;
      state.desiredOpen = isOp;
      state.pendingClose = false;
      state.phase = Math.abs(a) >= DOOR_OPEN_SETTLED_RAD ? 'open' : isOp ? 'opening' : 'closed';
      state.physical = true;
    },
  };
}

export function stepDoorParts(doorParts: readonly DoorPart[], dt: number, reduced: boolean, body: { x: number; z: number }) {
  for (let i = 0; i < doorParts.length; i++) {
    const part = doorParts[i];
    const { state, pivot, lever, frame, distantLeaf, plan: d } = part;
    if (!state.explicitOccTick) {
      SINGLE_DOOR_OCC_SCRATCH[0] = { x: body.x, y: d.y, z: body.z, radius: 0.26, id: 'player' };
      syncLifeDoorPartOccupancy(part, SINGLE_DOOR_OCC_SCRATCH);
    }
    state.explicitOccTick = false;

    const holdOpen = state.open || state.phase === 'occupied' || state.phase === 'open' || state.phase === 'opening';
    const angle = holdOpen ? OPEN * state.dir : 0;
    if (!state.physical) {
      state.spring = reduced
        ? { position: angle, velocity: 0 }
        : stepSpring(state.spring, angle, dt, holdOpen ? DOOR_OPEN : DOOR_CLOSE);
      if (holdOpen && Math.abs(state.spring.position) >= DOOR_OPEN_SETTLED_RAD) {
        if (state.occupiedNow) {
          state.phase = 'occupied';
        } else if (state.pendingClose) {
          state.pendingClose = false;
          state.desiredOpen = false;
          state.open = false;
          state.phase = 'closing';
        } else {
          state.phase = 'open';
        }
      } else if (!holdOpen && Math.abs(state.spring.position) <= DOOR_CLOSED_EPS_RAD) {
        state.phase = 'closed';
      }
    }
    pivot.rotation.y = state.spring.position;
    const dx = frame.position.x - body.x, dz = frame.position.z - body.z;
    frame.visible = dx * dx + dz * dz < (frame.visible ? 18 * 18 : 16 * 16);
    distantLeaf.visible = !frame.visible;
    distantLeaf.rotation.y = frame.rotation.y + pivot.rotation.y;
    state.leverNow += (state.leverTarget - state.leverNow) * (reduced ? 1 : 1 - Math.exp(-22 * dt));
    lever.rotation.z = state.leverNow * .62;
  }
}

/** Box UVs in metres (÷ `unit`), so a textured floor or wall keeps its scale however large the box. */
export function meteredBox(w: number, h: number, d: number, unit = 2.4) {
  const g = new T.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as T.BufferAttribute;
  // BoxGeometry faces: +x, −x (u: depth, v: height), +y, −y (u: width, v: depth), +z, −z (u: width, v: height); 4 vertices each.
  const spans: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) { const i = f * 4 + k; uv.setXY(i, uv.getX(i) * spans[f][0] / unit, uv.getY(i) * spans[f][1] / unit); }
  return g;
}

export interface AxisBoxBounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

/**
 * Exact 3D AABB boolean difference (`target \ cutters`) eliminating coplanar corner/junction Z-fighting
 * across architectural walls, slabs, window mullions, belt courses, and skirting trims.
 */
export function subtractAxisBox3D(
  target: AxisBoxBounds,
  cutters: readonly AxisBoxBounds[],
  eps = 1e-4,
): AxisBoxBounds[] {
  let parts: AxisBoxBounds[] = [target];
  for (let ci = 0; ci < cutters.length && parts.length > 0; ci++) {
    const b = cutters[ci];
    const next: AxisBoxBounds[] = [];
    for (let pi = 0; pi < parts.length; pi++) {
      const a = parts[pi];
      const ix0 = Math.max(a.x0, b.x0);
      const ix1 = Math.min(a.x1, b.x1);
      const iy0 = Math.max(a.y0, b.y0);
      const iy1 = Math.min(a.y1, b.y1);
      const iz0 = Math.max(a.z0, b.z0);
      const iz1 = Math.min(a.z1, b.z1);
      if (ix1 - ix0 <= eps || iy1 - iy0 <= eps || iz1 - iz0 <= eps) {
        next.push(a);
        continue;
      }
      if (b.x0 - a.x0 > eps) next.push({ x0: a.x0, x1: b.x0, y0: a.y0, y1: a.y1, z0: a.z0, z1: a.z1 });
      if (a.x1 - b.x1 > eps) next.push({ x0: b.x1, x1: a.x1, y0: a.y0, y1: a.y1, z0: a.z0, z1: a.z1 });
      if (b.y0 - a.y0 > eps) next.push({ x0: ix0, x1: ix1, y0: a.y0, y1: b.y0, z0: a.z0, z1: a.z1 });
      if (a.y1 - b.y1 > eps) next.push({ x0: ix0, x1: ix1, y0: b.y1, y1: a.y1, z0: a.z0, z1: a.z1 });
      if (b.z0 - a.z0 > eps) next.push({ x0: ix0, x1: ix1, y0: iy0, y1: iy1, z0: a.z0, z1: b.z0 });
      if (a.z1 - b.z1 > eps) next.push({ x0: ix0, x1: ix1, y0: iy0, y1: iy1, z0: b.z1, z1: a.z1 });
    }
    parts = next;
  }
  return parts;
}

/** World-anchored metered axis-aligned box so split/adjacent wall & slab spans tile seamlessly across joints. */
export function worldAnchoredMeteredBox(b: AxisBoxBounds, unit = 2.4): T.BufferGeometry {
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  const d = b.z1 - b.z0;
  const g = new T.BoxGeometry(w, h, d);
  g.translate((b.x0 + b.x1) * 0.5, (b.y0 + b.y1) * 0.5, (b.z0 + b.z1) * 0.5);
  const pos = g.attributes.position as T.BufferAttribute;
  const norm = g.attributes.normal as T.BufferAttribute;
  const uv = g.attributes.uv as T.BufferAttribute;
  const inv = 1 / unit;
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    const ax = Math.abs(norm.getX(i));
    const ay = Math.abs(norm.getY(i));
    if (ay > 0.5) uv.setXY(i, px * inv, pz * inv);
    else if (ax > 0.5) uv.setXY(i, pz * inv, py * inv);
    else uv.setXY(i, px * inv, py * inv);
  }
  return g;
}

export class Batch {
  private pieces = new Map<T.Material, T.BufferGeometry[]>();
  private occupied: AxisBoxBounds[] = [];

  get occupiedBounds(): readonly AxisBoxBounds[] {
    return this.occupied;
  }

  add(
    material: T.Material,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    rotY = 0,
    extraCutters?: readonly AxisBoxBounds[],
  ) {
    if (w <= 1e-4 || h <= 1e-4 || d <= 1e-4) return;
    const list = this.pieces.get(material) ?? [];
    if (rotY !== 0) {
      const g = meteredBox(w, h, d);
      g.rotateY(rotY);
      g.translate(x, y, z);
      list.push(g);
      this.pieces.set(material, list);
      return;
    }
    const target: AxisBoxBounds = {
      x0: x - w * 0.5,
      x1: x + w * 0.5,
      y0: y - h * 0.5,
      y1: y + h * 0.5,
      z0: z - d * 0.5,
      z1: z + d * 0.5,
    };
    let subBoxes = subtractAxisBox3D(target, this.occupied);
    if (extraCutters && extraCutters.length > 0 && subBoxes.length > 0) {
      const filtered: AxisBoxBounds[] = [];
      for (let i = 0; i < subBoxes.length; i++) {
        filtered.push(...subtractAxisBox3D(subBoxes[i], extraCutters));
      }
      subBoxes = filtered;
    }
    if (!subBoxes.length) return;
    for (let i = 0; i < subBoxes.length; i++) {
      const sb = subBoxes[i];
      this.occupied.push(sb);
      list.push(worldAnchoredMeteredBox(sb));
    }
    this.pieces.set(material, list);
  }
  addGeometry(material: T.Material, g: T.BufferGeometry) {
    const list = this.pieces.get(material) ?? []; list.push(g); this.pieces.set(material, list);
  }
  build(into: T.Group, shadows: boolean, name: string) {
    const meshes: T.Mesh[] = [];
    for (const [material, list] of this.pieces) {
      const merged = mergeGeometries(list, false); list.forEach(g => g.dispose());
      if (!merged) continue;
      const mesh = new T.Mesh(merged, material); mesh.name = name; mesh.castShadow = shadows; mesh.receiveShadow = true;
      into.add(mesh); meshes.push(mesh);
    }
    this.pieces.clear();
    this.occupied.length = 0;
    return meshes;
  }
}

/**
 * Cross-asset static interior furniture batcher:
 * Collapses repeated & shared-material GLB parts across an entire room/building into the minimum number of
 * static merged `Mesh`es (per shared `(material, hasColor)`) or `InstancedMesh`es (for high-count repeated props).
 * Disposes only the merged geometries it constructs — never shared `Prepared` geometries/materials owned by `assets.ts`.
 */
export function batchStaticFurnishings(
  entries: readonly { kind: LifeAsset; prepared: Prepared; matrices: T.Matrix4[] }[],
  parent: T.Group,
  owned: { dispose(): void }[],
): void {
  // Count how many distinct asset kinds touch each material so shared materials (like `paletteMaterials`) always merge!
  const matKinds = new Map<T.Material, number>();
  for (const e of entries) {
    const seen = new Set<T.Material>();
    for (const part of e.prepared.parts) {
      if (isMirrorGlassPart(part)) continue;
      seen.add(part.material);
    }
    for (const m of seen) matKinds.set(m, (matKinds.get(m) ?? 0) + 1);
  }

  const mergeBuckets = new Map<T.Material, { withColor: T.BufferGeometry[]; noColor: T.BufferGeometry[]; kinds: Set<string> }>();
  const pushMerge = (matRef: T.Material, geom: T.BufferGeometry, kind: string) => {
    let bucket = mergeBuckets.get(matRef);
    if (!bucket) {
      bucket = { withColor: [], noColor: [], kinds: new Set() };
      mergeBuckets.set(matRef, bucket);
    }
    bucket.kinds.add(kind);
    if (geom.hasAttribute('color')) bucket.withColor.push(geom);
    else bucket.noColor.push(geom);
  };

  for (const { kind, prepared, matrices } of entries) {
    if (!matrices.length) continue;
    for (const part of prepared.parts) {
      if (isMirrorGlassPart(part)) continue;
      const sharedAcrossAssets = (matKinds.get(part.material) ?? 0) > 1;
      const triCount = (part.geometry.index?.count ?? part.geometry.attributes.position.count) / 3;
      // Keep InstancedMesh for heavy multi-copy props with unique materials; merge everything else per shared material!
      if (!sharedAcrossAssets && matrices.length >= 3 && triCount > 180) {
        const inst = new T.InstancedMesh(part.geometry, part.material, matrices.length);
        for (let i = 0; i < matrices.length; i++) inst.setMatrixAt(i, matrices[i]);
        inst.instanceMatrix.needsUpdate = true;
        inst.computeBoundingSphere();
        inst.castShadow = false;
        inst.receiveShadow = true;
        inst.userData.lifeFurniture = kind;
        parent.add(inst);
      } else if (!sharedAcrossAssets && matrices.length === 1) {
        // Single placement of an asset-exclusive material: bake transform into a lightweight clone or share via mesh.
        const m = new T.Mesh(part.geometry, part.material);
        m.applyMatrix4(matrices[0]);
        m.castShadow = false;
        m.receiveShadow = true;
        m.userData.lifeFurniture = kind;
        parent.add(m);
      } else {
        for (const mtx of matrices) {
          const clone = part.geometry.clone();
          clone.applyMatrix4(mtx);
          pushMerge(part.material, clone, kind);
        }
      }
    }
  }

  for (const [matRef, bucket] of mergeBuckets) {
    const label = [...bucket.kinds].join(',');
    for (const list of [bucket.withColor, bucket.noColor]) {
      if (!list.length) continue;
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (list.length > 1) list.forEach(g => g.dispose());
      if (!merged) continue;
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      owned.push(merged);
      const mesh = new T.Mesh(merged, matRef);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.userData.lifeFurniture = label;
      parent.add(mesh);
    }
  }
}

export function glassMaterial(dark: boolean) {
  return new T.MeshPhysicalMaterial({
    color: dark ? '#202833' : '#d8ecfa',
    roughness: .045,
    metalness: .02,
    clearcoat: 1.0,
    clearcoatRoughness: .04,
    ior: 1.52,
    reflectivity: .90,
    envMapIntensity: 1.2,
    transparent: true,
    opacity: dark ? .84 : .18,
    depthWrite: false,
    side: T.DoubleSide,
  });
}

const FINISH: Record<WallSpan['finish'], [MatKind, string]> = { plaster: ['wall', '#efe7db'], tile: ['floorTile', '#eef0f6'], stone: ['paint', '#b9a68f'] };
void FINISH;

export function buildHouse(plan: HousePlan, theme: string, opts: BuildHouseOptions = {}): HouseBuild {
  const group = new T.Group(); group.name = 'echo-life-house';
  const interiorGroup = new T.Group(); interiorGroup.name = 'house-interior';
  group.add(interiorGroup);
  const owned: { dispose(): void }[] = [];
  const tier: QualityTier = opts.tier ?? 'high';
  let extShadows = tier === 'high' || tier === 'ultra';

  const localSurfaces = !opts.surfaces
    ? new WorldSurfaceLibrary(opts.weather ?? createSharedWeatherUniforms(), tier)
    : null;
  const surfaces = opts.surfaces ?? localSurfaces!;
  if (localSurfaces) owned.push(localSurfaces);

  const solids: SolidBox[] = [];
  const solid = (w: number, h: number, d: number, x: number, y: number, z: number) => solids.push({ hx: w / 2, hy: h / 2, hz: d / 2, x, y, z });
  const extWalls = new Batch(), intWalls = new Batch();
  const extFloors = new Batch(), intFloors = new Batch();
  const extTrims = new Batch(), intTrims = new Batch();

  // Poly Haven PBR architectural surfaces (stucco walls, stone ground plinth, terracotta roof tiles, parquet/tile/terrazzo interiors).
  const interior = surfaces.interiorWall(theme === 'library' ? '#eadfcf' : '#f1ebe1');
  const exterior = surfaces.exteriorWall('#ead9bf', 'stucco');
  const stonePlinth = surfaces.exteriorWall('#c2b29b', 'stone');
  const trim = mat('trim', '#fbf7f0');
  const frameM = surfaces.exteriorTrim('#444e5a', true);
  const fasciaM = surfaces.exteriorTrim('#52453b', false);
  const curtainM = new T.MeshStandardMaterial({
    color: '#f5efe4',
    roughness: 0.92,
    metalness: 0.0,
    side: T.DoubleSide,
  });
  owned.push(curtainM);
  const curtainGeos: T.BufferGeometry[] = [];

  const clearGlassHandle: ArchitecturalGlassHandle = surfaces.createGlass({ shop: false, enterable: true });
  const shopGlassHandle: ArchitecturalGlassHandle = surfaces.createGlass({ shop: true, enterable: false });
  const glass = clearGlassHandle.material;
  const shopGlass = shopGlassHandle.material;
  if (!localSurfaces) owned.push(clearGlassHandle, shopGlassHandle);

  const clearPanes: T.BufferGeometry[] = [], darkPanes: T.BufferGeometry[] = [];
  const pane = (shop: boolean, w: number, h: number, x: number, y: number, z: number, rotY: number) => {
    const g = new T.PlaneGeometry(w, h);
    if (rotY) g.rotateY(rotY);
    g.translate(x, y, z);
    (shop ? darkPanes : clearPanes).push(g);
  };

  // Walls, cut around their openings. Process exterior stone -> exterior stucco -> interior plaster (alongX before alongZ)
  // so corner butt-joints and interior-to-exterior junctions have 0.0 mm³ overlapping volume and 0 coplanar Z-fighting!
  const wallPriority = (w: WallSpan) => {
    const alongX = w.x1 - w.x0 >= w.z1 - w.z0 ? 0 : 1;
    if (w.face === 'exterior' && w.finish === 'stone') return alongX;
    if (w.face === 'exterior') return 2 + alongX;
    return 4 + alongX;
  };
  const orderedWalls = [...plan.walls].sort((a, b) => wallPriority(a) - wallPriority(b));
  for (const w of orderedWalls) {
    const alongX = w.x1 - w.x0 >= w.z1 - w.z0;
    const a0 = alongX ? w.x0 : w.z0, a1 = alongX ? w.x1 : w.z1, t0 = alongX ? w.z0 : w.x0, t1 = alongX ? w.z1 : w.x1;
    const thick = t1 - t0, mid = (t0 + t1) / 2, height = w.y1 - w.y0;
    const isInt = w.face === 'interior';
    const isStudyHallPartition =
      isInt && !alongX && Math.abs(t0 - plan.h) < 1e-3 && Math.abs(t1 - (plan.h + WALL)) < 1e-3 && w.z0 < plan.h - 1e-3;
    // Study-side [h .. h + 0.072] is rendered by `gateways.ts`; Hallway-side [h + 0.088 .. h + 0.16] renders here (16 mm separation!).
    const visThick = isStudyHallPartition ? Math.max(0.04, WALL - 0.088) : thick;
    const visMid = isStudyHallPartition ? plan.h + 0.088 + visThick * 0.5 : mid;
    const wBatch = isInt ? intWalls : extWalls;
    const tBatch = isInt ? intTrims : extTrims;
    const extCutters = isInt ? extWalls.occupiedBounds : undefined;
    const material = w.finish === 'stone' ? stonePlinth : isInt ? interior : exterior;
    const piece = (from: number, to: number, y0: number, y1: number, m = material) => {
      const len = to - from, c = (from + to) / 2, cy = (y0 + y1) / 2;
      if (len <= 1e-4 || y1 - y0 <= 1e-4) return;
      if (alongX) wBatch.add(m, len, y1 - y0, visThick, c, cy, visMid, 0, extCutters);
      else wBatch.add(m, visThick, y1 - y0, len, visMid, cy, c, 0, extCutters);
      if (alongX) solid(len, y1 - y0, thick, c, cy, mid); else solid(thick, y1 - y0, len, mid, cy, c);
    };
    const openings = [...w.openings].sort((p, q) => p.from - q.from);
    let at = a0;
    for (const o of openings) {
      const from = Math.max(a0, o.from), to = Math.min(a1, o.to);
      if (to <= from) continue;
      piece(at, from, w.y0, w.y1);
      const top = Math.min(height, o.top), bottom = o.bottom ?? 0;
      piece(from, to, w.y0 + top, w.y1);
      if (bottom > 0) piece(from, to, w.y0, w.y0 + bottom);
      const len = to - from, c = (from + to) / 2;
      // Orient every exterior window pane so its PlaneGeometry +Z normal deterministically points OUTDOORS.
      const outSign = mid < 0 ? -1 : 1;
      const paneRot = alongX ? (outSign < 0 ? Math.PI : 0) : (outSign < 0 ? -Math.PI / 2 : Math.PI / 2);
      if (o.bottom !== undefined) {
        // 3-depth window reveal: projecting outer sill & lintel, recessed dark aluminum casing, mullions & transom.
        const y0 = w.y0 + bottom, y1 = w.y0 + top, cy = (y0 + y1) / 2;
        const winH = y1 - y0;
        const shop = !!o.shop;
        const put = (lw: number, lh: number, ld: number, along: number, y: number, m: T.Material = frameM) =>
          alongX ? tBatch.add(m, lw, lh, ld, along, y, mid) : tBatch.add(m, ld, lh, lw, mid, y, along);
        put(len + .14, .08, thick + .09, c, y1 + .02, fasciaM);
        put(len + .18, .065, thick + .14, c, y0 - .015, fasciaM);
        put(.065, winH, thick + .05, from, cy);
        put(.065, winH, thick + .05, to, cy);
        if (len > 1.15) put(.042, winH, thick * .64, c, cy);
        if (winH > 1.35) put(len, .038, thick * .58, c, y1 - winH * .28);
        if (alongX) pane(shop, len, winH, c, cy, mid, paneRot); else pane(shop, len, winH, mid, cy, c, paneRot);
        // Subtle sheer linen curtain panels framing upper residential windows inside `interiorGroup` (0 draws outdoors!).
        if (!shop && w.y0 >= -0.05 && len >= 1.1) {
          const panelW = Math.min(0.28, len * 0.22);
          const panelH = winH + 0.22;
          const inset = alongX ? (mid < 0 ? 0.14 : -0.14) : (mid > 0 ? -0.14 : 0.14);
          for (const side of [-1, 1]) {
            const g = new T.BoxGeometry(alongX ? panelW : 0.035, panelH, alongX ? 0.035 : panelW);
            const alongPos = c + side * (len * 0.5 - panelW * 0.42);
            if (alongX) g.translate(alongPos, cy + 0.06, mid + inset);
            else g.translate(mid + inset, cy + 0.06, alongPos);
            curtainGeos.push(g);
          }
        }
      } else if (!plan.doors.some(d => Math.abs((alongX ? d.x : d.z) - c) < .05 && Math.abs((alongX ? d.z : d.x) - mid) < .2)) {
        // An open arch: a trim reveal around it.
        const y1 = w.y0 + top;
        const put = (lw: number, lh: number, ld: number, along: number, y: number) => alongX ? tBatch.add(trim, lw, lh, ld, along, y, mid) : tBatch.add(trim, ld, lh, lw, mid, y, along);
        put(len + .12, .07, thick + .05, c, y1 + .035); put(.06, top, thick + .05, from - .03, w.y0 + top / 2); put(.06, top, thick + .05, to + .03, w.y0 + top / 2);
      }
      at = to;
    }
    piece(at, a1, w.y0, w.y1);
    // Skirting on interior walls (lifted +2 mm above floor y=0 and kept on Hallway side for Study<->Hallway partition).
    if (isInt && w.y0 >= -.2) {
      if (isStudyHallPartition) {
        intTrims.add(trim, .016, .098, a1 - a0, plan.h + WALL + .008, w.y0 + .051, (a0 + a1) / 2, 0, extCutters);
      } else if (alongX) {
        intTrims.add(trim, a1 - a0, .098, thick + .03, (a0 + a1) / 2, w.y0 + .051, mid, 0, extCutters);
      } else {
        intTrims.add(trim, thick + .03, .098, a1 - a0, mid, w.y0 + .051, (a0 + a1) / 2, 0, extCutters);
      }
    }
  }
  for (const [list, material] of [[clearPanes, glass], [darkPanes, shopGlass]] as const) {
    if (!list.length) continue;
    const merged = mergeGeometries(list, false); list.forEach(g => g.dispose());
    if (!merged) continue;
    owned.push(merged);
    const m = new T.Mesh(merged, material); m.renderOrder = 2; m.name = 'house-glass'; group.add(m);
  }

  if (curtainGeos.length) {
    const mergedCurtains = mergeGeometries(curtainGeos, false);
    curtainGeos.forEach(g => g.dispose());
    if (mergedCurtains) {
      owned.push(mergedCurtains);
      const cm = new T.Mesh(mergedCurtains, curtainM);
      cm.name = 'house-curtains';
      cm.receiveShadow = true;
      interiorGroup.add(cm);
    }
  }

  // Floors, terracotta roof tiles, terrace decks, ceilings.
  // Consolidate `extFloors` strictly to exterior roofs + open-sky balcony (2 meshes total -> <= 4 life-floor calls outdoors!)
  // while keeping all enclosed upper/lower room slabs inside `intFloors` (`interiorGroup`, 0 calls outdoors!).
  const FLOOR: Record<string, T.Material> = {
    oak: surfaces.interiorFloor('oak', '#e4d4be'),
    tile: surfaces.interiorFloor('tile', '#eef1f5'),
    terrazzo: surfaces.interiorFloor('terrazzo', '#ece6db'),
    roof: surfaces.exteriorRoof('#e2d4c8', true),
    roofFlat: surfaces.exteriorRoof('#a6a098', false),
    concrete: surfaces.interiorFloor('concrete', '#b4aea6'),
  };
  const balconyZone = plan.zones.find(z => z.id === 'balcony')?.rect;
  const isBalconySlab = (s: HousePlan['slabs'][number]) => {
    if (!balconyZone || s.y < -0.15) return false;
    const cx = (s.rect.x0 + s.rect.x1) * 0.5;
    const cz = (s.rect.z0 + s.rect.z1) * 0.5;
    return cx >= balconyZone.x0 - 0.25 && cx <= balconyZone.x1 + 0.25 && cz >= balconyZone.z0 - 0.25 && cz <= balconyZone.z1 + 0.25;
  };
  for (const s of plan.slabs) {
    const w = s.rect.x1 - s.rect.x0, d = s.rect.z1 - s.rect.z0;
    const cx = (s.rect.x0 + s.rect.x1) / 2, cz = (s.rect.z0 + s.rect.z1) / 2;
    const isUpperRoof = s.finish === 'roof' && s.y > 1.5;
    const isExtSlab = s.finish === 'roof' || isBalconySlab(s);
    const slabMat = isExtSlab
      ? (isUpperRoof ? FLOOR.roof : FLOOR.roofFlat)
      : FLOOR[s.finish];
    (isExtSlab ? extFloors : intFloors).add(slabMat, w, s.thick, d, cx, s.y - s.thick / 2, cz);
    solid(w, s.thick, d, cx, s.y - s.thick / 2, cz);
  }
  // Merge interior room ceilings into `intWalls` (`interior` plaster) with >= 30-40 mm separation from slabs/roofs,
  // and add crisp crown molding strips merged into `intTrims` (skipping open living<->kitchen passage).
  for (const room of plan.rooms) {
    const w = room.rect.x1 - room.rect.x0, d = room.rect.z1 - room.rect.z0;
    const cx = (room.rect.x0 + room.rect.x1) / 2, cz = (room.rect.z0 + room.rect.z1) / 2;
    if (room.y < -1) {
      // Ground-floor ceilings [-0.174 .. -0.150], >= 30 mm below -0.120 upper floor & flat terrace roof undersides.
      const top = -0.15;
      intWalls.add(interior, w, .024, d, cx, top - .012, cz);
      intTrims.add(trim, w, .05, .05, cx, top - .037, room.rect.z0 + .03);
      intTrims.add(trim, w, .05, .05, cx, top - .037, room.rect.z1 - .03);
    } else {
      // Upper-floor ceilings [3.06 .. 3.10], >= 40 mm below [3.14 .. 3.34] upper roof slabs.
      const top = UPPER_WALL_TOP;
      intWalls.add(interior, w, .04, d, cx, top + .02, cz);
      if (room.id !== 'kitchen') intTrims.add(trim, w, .055, .055, cx, top - .028, room.rect.z0 + .03);
      if (room.id !== 'living') intTrims.add(trim, w, .055, .055, cx, top - .028, room.rect.z1 - .03);
    }
  }

  // Crisp exterior architectural fascia: perimeter roof eaves cornice (never covering terracotta roof tiles!),
  // outward-only belt-course stringcourse, balcony parapet coping & entrance canopy!
  {
    const fp = plan.footprint;
    const fpw = fp.x1 - fp.x0, fpd = fp.z1 - fp.z0;
    const fpcx = (fp.x0 + fp.x1) * 0.5, fpcz = (fp.z0 + fp.z1) * 0.5;
    // Outward-projecting belt-course stringcourse separating stone plinth from upper stucco (0 overlap with walls/slabs).
    extTrims.add(fasciaM, fpw + .12, .14, .06, fpcx, -0.06, plan.front + .03);
    extTrims.add(fasciaM, fpw + .12, .14, .06, fpcx, -0.06, fp.z0 - .03);
    extTrims.add(fasciaM, .06, .14, fpd, fp.x0 - .03, -0.06, fpcz);
    extTrims.add(fasciaM, .06, .14, fpd, fp.x1 + .03, -0.06, fpcz);
    // Perimeter eave frieze ([3.06..3.14]) + outer overhang fascia ([3.12..3.30]) framing upper terracotta roofs cleanly.
    const upperRoofs = plan.slabs.filter(s => s.finish === 'roof' && s.y > 1.5);
    if (upperRoofs.length >= 2) {
      const mainR = upperRoofs[0].rect;
      const stairR = upperRoofs[1].rect;
      const friezeY = UPPER_WALL_TOP + 0.04; // [3.06 .. 3.14]
      const eaveY = UPPER_WALL_TOP + 0.21;   // [3.12 .. 3.30], strictly outside roof slabs
      // Under-eave frieze sealing [3.06 .. 3.14] along outer walls
      extTrims.add(fasciaM, mainR.x1 - mainR.x0, .08, WALL, (mainR.x0 + mainR.x1) * 0.5, friezeY, mainR.z0 + WALL * 0.5);
      extTrims.add(fasciaM, WALL, .08, mainR.z1 - mainR.z0, mainR.x0 + WALL * 0.5, friezeY, (mainR.z0 + mainR.z1) * 0.5);
      extTrims.add(fasciaM, WALL, .08, mainR.z1 - mainR.z0, mainR.x1 - WALL * 0.5, friezeY, (mainR.z0 + mainR.z1) * 0.5);
      extTrims.add(fasciaM, stairR.x0 - mainR.x0, .08, WALL, (mainR.x0 + stairR.x0) * 0.5, friezeY, mainR.z1 - WALL * 0.5);
      extTrims.add(fasciaM, mainR.x1 - stairR.x1, .08, WALL, (stairR.x1 + mainR.x1) * 0.5, friezeY, mainR.z1 - WALL * 0.5);
      extTrims.add(fasciaM, WALL, .08, stairR.z1 - stairR.z0, stairR.x0 + WALL * 0.5, friezeY, (stairR.z0 + stairR.z1) * 0.5);
      extTrims.add(fasciaM, WALL, .08, stairR.z1 - stairR.z0, stairR.x1 - WALL * 0.5, friezeY, (stairR.z0 + stairR.z1) * 0.5);
      extTrims.add(fasciaM, stairR.x1 - stairR.x0, .08, WALL, (stairR.x0 + stairR.x1) * 0.5, friezeY, stairR.z1 - WALL * 0.5);
      // Projecting perimeter eaves fascia strictly outside roof slab footprint (keeps terracotta top 100% clear)
      const oh = 0.11;
      extTrims.add(fasciaM, (mainR.x1 - mainR.x0) + oh * 2, .18, oh, (mainR.x0 + mainR.x1) * 0.5, eaveY, mainR.z0 - oh * 0.5);
      extTrims.add(fasciaM, oh, .18, (mainR.z1 - mainR.z0) + oh * 2, mainR.x0 - oh * 0.5, eaveY, (mainR.z0 + mainR.z1) * 0.5);
      extTrims.add(fasciaM, oh, .18, (mainR.z1 - mainR.z0) + oh * 2, mainR.x1 + oh * 0.5, eaveY, (mainR.z0 + mainR.z1) * 0.5);
      extTrims.add(fasciaM, stairR.x0 - mainR.x0, .18, oh, (mainR.x0 + stairR.x0) * 0.5, eaveY, mainR.z1 + oh * 0.5);
      extTrims.add(fasciaM, mainR.x1 - stairR.x1, .18, oh, (stairR.x1 + mainR.x1) * 0.5, eaveY, mainR.z1 + oh * 0.5);
      extTrims.add(fasciaM, oh, .18, stairR.z1 - stairR.z0, stairR.x0 - oh * 0.5, eaveY, (stairR.z0 + stairR.z1) * 0.5);
      extTrims.add(fasciaM, oh, .18, stairR.z1 - stairR.z0, stairR.x1 + oh * 0.5, eaveY, (stairR.z0 + stairR.z1) * 0.5);
      extTrims.add(fasciaM, (stairR.x1 - stairR.x0) + oh * 2, .18, oh, (stairR.x0 + stairR.x1) * 0.5, eaveY, stairR.z1 + oh * 0.5);
    }
    // Front entrance rain canopy & flanking vertical pilasters along Lantern Street.
    const ent = plan.doors.find(d => d.id === 'entrance');
    if (ent) {
      extTrims.add(fasciaM, 2.25, .11, .78, ent.x, GROUND_Y + 2.52, plan.front + .39);
      extTrims.add(frameM, .09, 2.52, .08, ent.x - .74, GROUND_Y + 1.26, plan.front + .04);
      extTrims.add(frameM, .09, 2.52, .08, ent.x + .74, GROUND_Y + 1.26, plan.front + .04);
    }
    if (balconyZone) {
      const bw = balconyZone.x1 - balconyZone.x0, bd = balconyZone.z1 - balconyZone.z0;
      extTrims.add(frameM, bw + .26, .06, .22, (balconyZone.x0 + balconyZone.x1) * 0.5, 1.08, balconyZone.z0 - .08);
      extTrims.add(frameM, .22, .06, bd + .26, balconyZone.x1 + .08, 1.08, (balconyZone.z0 + balconyZone.z1) * 0.5);
    }
  }

  // The stair: 17 risers from the hallway down to the lobby; treads centered on `(i + 0.5)` to match the analytical `zoneY` ramp (`0.0 cm` error!).
  const st = plan.stair, steps = st.steps, rise = (st.y0 - st.y1) / steps, run = (st.rect.z1 - st.rect.z0) / steps;
  for (let i = 0; i < steps; i++) {
    const top = st.y0 - (i + 0.5) * rise, z0 = st.rect.z0 + i * run, h = top - GROUND_Y;
    const w = st.rect.x1 - st.rect.x0, cx = (st.rect.x0 + st.rect.x1) / 2;
    intWalls.add(interior, w, h - .035, run, cx, GROUND_Y + (h - .035) / 2, z0 + run / 2);
    intFloors.add(FLOOR.oak, w + .02, .035, run + .025, cx, top - .0175, z0 + run / 2 - .0125);
    solid(w, h, run, cx, GROUND_Y + h / 2, z0 + run / 2);
  }
  // Handrails merged into `intTrims` (zero extra draw calls per handrail).
  const railM = surfaces.timber('#7d5a3f', true, false), postM = mat('metal', '#3d4148');
  const brassTrimM = new T.MeshStandardMaterial({ color: '#c8ab7c', roughness: 0.28, metalness: 0.86 });
  const chromeTrimM = new T.MeshStandardMaterial({ color: '#dfe5ec', roughness: 0.16, metalness: 0.94 });
  patchMaterialWithEchoCsm(postM);
  patchHeightFog(postM);
  patchMaterialWithEchoCsm(brassTrimM);
  patchHeightFog(brassTrimM);
  patchMaterialWithEchoCsm(chromeTrimM);
  patchHeightFog(chromeTrimM);
  owned.push(brassTrimM, chromeTrimM);

  const heightAt = (z: number) => st.y0 - (z - st.rect.z0) / (st.rect.z1 - st.rect.z0) * (st.y0 - st.y1);
  const rail = (x: number, z0: number, z1: number) => {
    const y0 = heightAt(z0), y1 = heightAt(z1), dir = new T.Vector3(0, y1 - y0, z1 - z0);
    const g = new T.CylinderGeometry(.025, .025, dir.length(), 10);
    const q = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), dir.normalize());
    g.applyMatrix4(new T.Matrix4().compose(new T.Vector3(x, (y0 + y1) / 2 + .9, (z0 + z1) / 2), q, new T.Vector3(1, 1, 1)));
    intTrims.addGeometry(railM, g);
  };
  rail(st.rect.x0 + .06, st.rect.z0, st.rect.z1);
  rail(st.rect.x1 - .02, st.rect.z1 - 1.4, st.rect.z1);
  for (let k = 0; k <= 4; k++) {
    const z = st.rect.z1 - 1.4 + k * .35, y = heightAt(z);
    intTrims.add(postM, .03, .9, .03, st.rect.x1 - .02, y + .45, z);
  }

  // A8: Procedural mid-century walnut + matte-slate `'tv-console'` lowboard (`H = 0.55 m`) merged into `intTrims` (`0` extra draws!).
  for (const f of plan.furniture) {
    if (f.asset !== 'tv-console') continue;
    const fpSpanA = f.footprint ? f.footprint.x1 - f.footprint.x0 : f.size;
    const fpSpanB = f.footprint ? f.footprint.z1 - f.footprint.z0 : 0.44;
    const cw = Math.max(1.25, Math.max(fpSpanA, fpSpanB, f.size));
    const cd = Math.max(0.36, Math.min(0.48, Math.min(fpSpanA, fpSpanB)));
    const cosY = Math.cos(f.rotY);
    const sinY = Math.sin(f.rotY);
    const addLocalBox = (m: T.Material, w: number, h: number, d: number, lx: number, ly: number, lz: number) => {
      const wx = f.x + lx * cosY + lz * sinY;
      const wz = f.z - lx * sinY + lz * cosY;
      intTrims.add(m, w, h, d, wx, f.y + ly, wz, f.rotY);
    };

    // 4 splayed mid-century tapered walnut legs (`y = 0..0.165 m`) + matte-slate plinth rail.
    const legHalfX = cw * 0.5 - 0.11;
    const legHalfZ = cd * 0.5 - 0.08;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const legGeo = new T.CylinderGeometry(0.019, 0.013, 0.172, 8);
        legGeo.rotateZ(-sx * 0.14);
        legGeo.rotateX(sz * 0.12);
        legGeo.translate(sx * legHalfX, 0.082, sz * legHalfZ);
        if (f.rotY) legGeo.rotateY(f.rotY);
        legGeo.translate(f.x, f.y, f.z);
        intTrims.addGeometry(railM, legGeo);
      }
    }
    addLocalBox(postM, cw - 0.24, 0.022, 0.024, 0, 0.095, 0);

    // Walnut cabinet carcass (`y = 0.16..0.55 m`, exact top surface at `f.y + 0.55 m`).
    addLocalBox(railM, cw, 0.026, cd, 0, 0.173, 0);
    addLocalBox(railM, cw, 0.028, cd, 0, 0.536, 0);
    addLocalBox(postM, cw - 0.06, 0.008, cd - 0.06, 0, 0.548, 0);
    addLocalBox(railM, 0.026, 0.35, cd - 0.01, -cw * 0.5 + 0.013, 0.355, 0);
    addLocalBox(railM, 0.026, 0.35, cd - 0.01, cw * 0.5 - 0.013, 0.355, 0);
    addLocalBox(postM, cw - 0.04, 0.35, 0.018, 0, 0.355, -cd * 0.5 + 0.014);

    // Center open AV bay (`bayW`) flanked by two slatted walnut cabinet doors with warm brass pulls.
    const bayW = Math.min(0.54, cw * 0.36);
    addLocalBox(railM, 0.022, 0.34, cd - 0.03, -bayW * 0.5, 0.355, 0.005);
    addLocalBox(railM, 0.022, 0.34, cd - 0.03, bayW * 0.5, 0.355, 0.005);
    addLocalBox(railM, bayW - 0.02, 0.020, cd - 0.05, 0, 0.345, 0.005);
    // Matte-slate AV streamer/amplifier on lower shelf + sleek soundbar resting on front top edge.
    addLocalBox(postM, Math.min(0.38, bayW - 0.08), 0.052, cd * 0.62, 0, 0.214, 0.02);
    addLocalBox(brassTrimM, 0.045, 0.008, 0.008, 0.10, 0.216, cd * 0.31 + 0.022);
    addLocalBox(postM, Math.min(0.76, cw * 0.54), 0.046, 0.068, 0, 0.55 + 0.023, cd * 0.28);

    const doorW = (cw - bayW - 0.07) * 0.5;
    if (doorW > 0.18) {
      for (const side of [-1, 1]) {
        const doorCx = side * (bayW * 0.5 + 0.012 + doorW * 0.5);
        addLocalBox(railM, doorW - 0.012, 0.334, 0.018, doorCx, 0.355, cd * 0.5 - 0.016);
        const slatCount = Math.max(4, Math.min(8, Math.floor(doorW / 0.055)));
        const slatStep = (doorW - 0.05) / slatCount;
        for (let sIdx = 0; sIdx <= slatCount; sIdx++) {
          const sx = doorCx - (doorW - 0.05) * 0.5 + sIdx * slatStep;
          addLocalBox(railM, 0.014, 0.326, 0.012, sx, 0.355, cd * 0.5 - 0.004);
        }
        const pullX = side * (bayW * 0.5 + 0.048);
        addLocalBox(brassTrimM, 0.014, 0.115, 0.018, pullX, 0.375, cd * 0.5 + 0.008);
      }
    }
  }

  // A7: Walk-in SE shower brushed-chrome Rain-Showerhead (`y = 2.24 m`), overhead arm, riser (`1.12..2.26 m`) & mixer valve (`1.12 m`).
  let showerEmitterSpec: ShowerEmitterSpec | null = null;
  const bathRect = plan.zones.find(z => z.id === 'bath')?.rect;
  const showerItem = plan.furniture.find(f => f.asset === 'shower');
  if (showerItem) {
    const sy = showerItem.y;
    // Anchor riser & mixer flush against the nearest enclosing bathroom wall (East wall `bathRect.x1` for SE walk-in).
    let wallX = showerItem.x + 0.56;
    let wallZ = showerItem.z;
    let nx = -1;
    let nz = 0;
    if (bathRect) {
      const dEast = Math.abs(bathRect.x1 - showerItem.x);
      const dSouth = Math.abs(bathRect.z1 - showerItem.z);
      const dNorth = Math.abs(showerItem.z - bathRect.z0);
      if (dEast <= dSouth && dEast <= dNorth) {
        wallX = bathRect.x1 - 0.016;
        wallZ = showerItem.z;
        nx = -1;
        nz = 0;
      } else if (dSouth <= dNorth) {
        wallX = showerItem.x;
        wallZ = bathRect.z1 - 0.016;
        nx = 0;
        nz = -1;
      } else {
        wallX = showerItem.x;
        wallZ = bathRect.z0 + 0.016;
        nx = 0;
        nz = 1;
      }
    }
    const riserX = wallX + nx * 0.028;
    const riserZ = wallZ + nz * 0.028;
    const riserGeo = new T.CylinderGeometry(0.013, 0.013, 2.26 - 1.12, 12);
    riserGeo.translate(riserX, sy + (1.12 + 2.26) * 0.5, riserZ);
    intTrims.addGeometry(chromeTrimM, riserGeo);

    // Upper & lower wall escutcheon brackets.
    for (const by of [1.20, 2.18]) {
      intTrims.add(chromeTrimM, 0.044, 0.044, 0.044, wallX + nx * 0.014, sy + by, wallZ + nz * 0.014);
    }

    // Wall thermostatic mixer valve + temperature/flow lever (`y = 1.12 m`).
    const valveX = wallX + nx * 0.042;
    const valveY = sy + 1.12;
    const valveZ = wallZ + nz * 0.042;
    intTrims.add(
      chromeTrimM,
      nx !== 0 ? 0.016 : 0.16,
      0.11,
      nx !== 0 ? 0.16 : 0.016,
      wallX + nx * 0.008,
      valveY,
      wallZ + nz * 0.008,
    );
    const mixerBar = new T.CylinderGeometry(0.024, 0.024, 0.15, 12);
    if (nx !== 0) mixerBar.rotateX(Math.PI * 0.5);
    else mixerBar.rotateZ(Math.PI * 0.5);
    mixerBar.translate(valveX, valveY, valveZ);
    intTrims.addGeometry(chromeTrimM, mixerBar);
    intTrims.add(chromeTrimM, 0.024, 0.075, 0.024, valveX + nx * 0.026, valveY + 0.036, valveZ + nz * 0.026);

    // Overhead cantilever arm (`y = 2.26 m`) from riser to `(showerItem.x, showerItem.z)` + drop neck to `y = 2.24 m`.
    const armVec = new T.Vector3(showerItem.x - riserX, 0, showerItem.z - riserZ);
    const armLen = armVec.length();
    if (armLen > 0.04) {
      const armGeo = new T.CylinderGeometry(0.012, 0.012, armLen, 10);
      const armQuat = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), armVec.clone().normalize());
      armGeo.applyMatrix4(
        new T.Matrix4().compose(
          new T.Vector3((riserX + showerItem.x) * 0.5, sy + 2.26, (riserZ + showerItem.z) * 0.5),
          armQuat,
          new T.Vector3(1, 1, 1),
        ),
      );
      intTrims.addGeometry(chromeTrimM, armGeo);
    }
    const neckGeo = new T.CylinderGeometry(0.014, 0.014, 0.028, 10);
    neckGeo.translate(showerItem.x, sy + 2.252, showerItem.z);
    intTrims.addGeometry(chromeTrimM, neckGeo);

    const headGeo = new T.CylinderGeometry(0.135, 0.142, 0.016, 20);
    headGeo.translate(showerItem.x, sy + 2.24, showerItem.z);
    intTrims.addGeometry(chromeTrimM, headGeo);

    const nozzleGeo = new T.CylinderGeometry(0.126, 0.126, 0.005, 20);
    nozzleGeo.translate(showerItem.x, sy + 2.231, showerItem.z);
    intTrims.addGeometry(postM, nozzleGeo);

    showerEmitterSpec = {
      x: showerItem.x,
      y: sy + 2.23,
      z: showerItem.z,
      floorY: sy,
      radius: 0.125,
      valve: { x: valveX, y: valveY, z: valveZ },
      zoneId: 'bath',
    };
  }

  // A7: Emit `SolidBox` + frameless glass screen + chrome U-channel ONLY for `plan.blocks` with `label === 'shower_glass'`.
  const showerGlassGeos: T.BufferGeometry[] = [];
  for (const bl of plan.blocks) {
    if (bl.label !== 'shower_glass') continue;
    const bw = Math.max(0.02, bl.rect.x1 - bl.rect.x0);
    const bd = Math.max(0.02, bl.rect.z1 - bl.rect.z0);
    const bcx = (bl.rect.x0 + bl.rect.x1) * 0.5;
    const bcz = (bl.rect.z0 + bl.rect.z1) * 0.5;
    const by = bl.y ?? 0;
    const bh = bl.topRel ?? 2.12;
    solid(bw, bh, bd, bcx, by + bh * 0.5, bcz);
    intTrims.add(chromeTrimM, bw + 0.012, 0.024, bd + 0.012, bcx, by + 0.012, bcz);
    const gp = new T.BoxGeometry(bw, Math.max(0.2, bh - 0.024), bd);
    gp.translate(bcx, by + 0.024 + (bh - 0.024) * 0.5, bcz);
    showerGlassGeos.push(gp);
  }
  if (showerGlassGeos.length) {
    const mergedShowerGlass = mergeGeometries(showerGlassGeos, false);
    showerGlassGeos.forEach(g => g.dispose());
    if (mergedShowerGlass) {
      owned.push(mergedShowerGlass);
      const sgm = new T.Mesh(mergedShowerGlass, glass);
      sgm.renderOrder = 2;
      sgm.name = 'house-shower-glass';
      interiorGroup.add(sgm);
    }
  }

  // A8: Elevated TV screen quad (`y = tvItem.y + tvItem.size * 0.385`) + `setTvActive(on)` modulating `emissiveIntensity` (`0` recompile!).
  let tvActive = false;
  let tvScreenMat: T.MeshStandardMaterial | null = null;
  const tvItem = plan.furniture.find(f => f.asset === 'tv');
  if (tvItem) {
    let tvTex: T.Texture;
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = 256;
      c.height = 144;
      const ctx = c.getContext('2d');
      if (ctx) {
        const grad = ctx.createLinearGradient(0, 0, 256, 144);
        grad.addColorStop(0, '#18344c');
        grad.addColorStop(0.52, '#2d5c7a');
        grad.addColorStop(1, '#e2a86f');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 256, 144);
        ctx.fillStyle = 'rgba(255, 246, 228, 0.22)';
        ctx.beginPath();
        ctx.arc(182, 52, 26, 0, Math.PI * 2);
        ctx.fill();
      }
      const cTex = new T.CanvasTexture(c);
      cTex.colorSpace = T.SRGBColorSpace;
      tvTex = cTex;
    } else {
      const data = new Uint8Array([36, 76, 108, 255]);
      const dTex = new T.DataTexture(data, 1, 1);
      dTex.colorSpace = T.SRGBColorSpace;
      dTex.needsUpdate = true;
      tvTex = dTex;
    }
    owned.push(tvTex);
    tvScreenMat = new T.MeshStandardMaterial({
      color: '#0d1218',
      roughness: 0.14,
      metalness: 0.08,
      emissive: '#ffffff',
      emissiveMap: tvTex,
      emissiveIntensity: 0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    patchMaterialWithEchoCsm(tvScreenMat);
    patchHeightFog(tvScreenMat);
    getEchoLifeTextureUploadQueue().enqueue(tvTex, LoadPriority.P1_PREFETCH);
    owned.push(tvScreenMat);

    const screenGeo = new T.PlaneGeometry(tvItem.size * 0.88, tvItem.size * 0.495);
    owned.push(screenGeo);
    const screenMesh = new T.Mesh(screenGeo, tvScreenMat);
    screenMesh.name = 'house-tv-screen';
    const fwdX = Math.sin(tvItem.rotY);
    const fwdZ = Math.cos(tvItem.rotY);
    screenMesh.position.set(
      tvItem.x + fwdX * 0.044,
      tvItem.y + tvItem.size * 0.385,
      tvItem.z + fwdZ * 0.044,
    );
    screenMesh.rotation.y = tvItem.rotY;
    interiorGroup.add(screenMesh);
  }

  // Exterior shell casts shadows on High/Ultra and stays visible across the city; interior hides cleanly when enclosed/away.
  const extWallMeshes = extWalls.build(group, extShadows, 'life-wall');
  const intWallMeshes = intWalls.build(interiorGroup, false, 'life-wall');
  const extFloorMeshes = extFloors.build(group, extShadows, 'life-floor');
  const intFloorMeshes = intFloors.build(interiorGroup, false, 'life-floor');
  const wallMeshes = [...extWallMeshes, ...intWallMeshes];
  const floorMeshes = [...extFloorMeshes, ...intFloorMeshes];
  const shadowCasters = [...extWallMeshes, ...extFloorMeshes];

  let finishKey = '';
  const painted = new Map<T.Mesh, { original: T.MeshStandardMaterial; paint: T.MeshStandardMaterial }>();
  const restoreFinish = (mesh: T.Mesh) => {
    const entry = painted.get(mesh);
    if (!entry) return;
    mesh.material = entry.original;
    mesh.geometry.deleteAttribute('color');
    entry.paint.dispose();
    painted.delete(mesh);
  };
  const setFinishes: HouseBuild['setFinishes'] = finishes => {
    const key = JSON.stringify(finishes);
    if (key === finishKey) return;
    finishKey = key;
    const rooms = plan.rooms.filter(r => finishes[r.id]).map(r => ({
      ...r,
      wall: new T.Color(finishes[r.id].wallColor),
      floor: new T.Color(finishes[r.id].floorColor),
    }));
    for (const mesh of [...wallMeshes, ...floorMeshes]) {
      restoreFinish(mesh);
      if (!rooms.length || !(mesh.material instanceof T.MeshStandardMaterial)) continue;
      const geometry = mesh.geometry, position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
      const index = geometry.getIndex(), count = index?.count ?? position.count;
      const colors = new T.Float32BufferAttribute(new Float32Array(position.count * 3), 3);
      const original = mesh.material;
      for (let i = 0; i < position.count; i++) colors.setXYZ(i, original.color.r, original.color.g, original.color.b);
      let changed = false;
      for (let i = 0; i < count; i += 3) {
        const a = index?.getX(i) ?? i, b = index?.getX(i + 1) ?? i + 1, c = index?.getX(i + 2) ?? i + 2;
        const floor = mesh.name === 'life-floor';
        if (floor ? normal.getY(a) < .99 : Math.abs(normal.getY(a)) > .1) continue;
        const x = (position.getX(a) + position.getX(b) + position.getX(c)) / 3 + normal.getX(a) * .09;
        const y = (position.getY(a) + position.getY(b) + position.getY(c)) / 3;
        const z = (position.getZ(a) + position.getZ(b) + position.getZ(c)) / 3 + normal.getZ(a) * .09;
        const room = rooms.find(r => x >= r.rect.x0 && x <= r.rect.x1 && z >= r.rect.z0 && z <= r.rect.z1 &&
          (floor ? Math.abs(y - r.y) < .04 : y >= r.y && y < r.y + 3));
        if (!room) continue;
        const color = floor ? room.floor : room.wall;
        for (const vertex of [a, b, c]) colors.setXYZ(vertex, color.r, color.g, color.b);
        changed = true;
      }
      if (!changed) continue;
      const paint = original.clone();
      paint.color.set(0xffffff); paint.vertexColors = true;
      geometry.setAttribute('color', colors); mesh.material = paint;
      painted.set(mesh, { original, paint });
    }
  };
  const extTrimMeshes = extTrims.build(group, extShadows, 'life-trim');
  intTrims.build(interiorGroup, false, 'life-trim');
  shadowCasters.push(...extTrimMeshes);
  for (const m of [...wallMeshes, ...floorMeshes, ...extTrimMeshes]) m.receiveShadow = true;

  // Doors: outer shell & study->hall threshold door live on `group` so study room door stays visible even when `interiorGroup` is culled!
  const doors = new Map<DoorId, LifeDoor>();
  const extDoorParts: DoorPart[] = [];
  const intDoorParts: DoorPart[] = [];
  const SHELL_DOORS = new Set<DoorId>(['hall', 'entrance', 'garage_out', 'balcony', 'yard']);
  for (const d of plan.doors) {
    const shell = SHELL_DOORS.has(d.id);
    doors.set(d.id, createLifeDoor(d, shell ? group : interiorGroup, owned, shell ? extDoorParts : intDoorParts));
  }

  // Ceiling fixtures: one InstancedMesh inside interiorGroup instead of N separate draw calls.
  const fixtures: HouseBuild['fixtures'] = [];
  const fixturePos: [number, number, number][] = [];
  const fixture = (x: number, y: number, z: number, room: string, warm = true) => {
    fixturePos.push([x, y - .022, z]);
    fixtures.push({ at: new T.Vector3(x, y - .25, z), room, warm });
  };
  for (const room of plan.rooms) {
    const cx = (room.rect.x0 + room.rect.x1) / 2, cz = (room.rect.z0 + room.rect.z1) / 2, top = room.y < -1 ? -.174 : UPPER_WALL_TOP;
    if (room.id === 'hall') { fixture(cx, top, room.rect.z0 + 1.6, 'hall'); fixture(cx, top, room.rect.z1 - 1.6, 'hall'); }
    else fixture(cx, top, cz, room.id);
  }
  if (fixturePos.length) {
    const disc = new T.CylinderGeometry(.16, .16, .03, 18); owned.push(disc);
    const glow = mat('glow', '#ffe9c6', '1.05');
    const inst = new T.InstancedMesh(disc, glow, fixturePos.length);
    const m4 = new T.Matrix4();
    fixturePos.forEach(([x, y, z], i) => inst.setMatrixAt(i, m4.makeTranslation(x, y, z)));
    inst.instanceMatrix.needsUpdate = true; inst.computeBoundingSphere();
    interiorGroup.add(inst);
    owned.push(inst);
  }

  // Curated interior furniture batched per shared material (cuts draw calls dramatically while keeping footprints exact).
  let furnished = false;
  let disposed = false;
  const acquired: LifeAsset[] = [];
  const mirrorPlacements: HouseMirrorPlacement[] = [];
  const furnishings = new T.Group();
  interiorGroup.add(furnishings);
  const furnish = async () => {
    if (furnished || disposed) return false;
    furnished = true;
    const kinds = [
      ...new Set(
        plan.furniture
          .map(f => f.asset)
          .filter((a): a is LifeAsset => Object.prototype.hasOwnProperty.call(LIFE_ASSETS, a)),
      ),
    ];
    for (const k of kinds) acquired.push(k);
    const [loaded, rug] = await Promise.all([
      Promise.all(kinds.map(k => acquireLifeAsset(k))),
      loadStreetProp('libRugWoven'),
    ]);
    if (disposed) return false;

    const entries: { kind: LifeAsset; prepared: Prepared; matrices: T.Matrix4[] }[] = [];
    kinds.forEach((kind, i) => {
      const p = loaded[i];
      if (!p) return;
      const size = p.box.getSize(new T.Vector3());
      const mirrorParts = p.parts.filter(isMirrorGlassPart);
      const matrices: T.Matrix4[] = [];
      plan.furniture.forEach((f, fIdx) => {
        if (f.asset !== kind) return;
        const mtx = placeOn(p, f.x, f.y, f.z, f.rotY, f.size / Math.max(size.x, size.z, 1e-3));
        matrices.push(mtx);
        if (mirrorParts.length > 0) {
          const zHit = houseZoneAt(plan, { x: f.x, z: f.z }, 0);
          const rmHit = plan.rooms.find(
            rm =>
              f.x >= rm.rect.x0 - 0.25 &&
              f.x <= rm.rect.x1 + 0.25 &&
              f.z >= rm.rect.z0 - 0.25 &&
              f.z <= rm.rect.z1 + 0.25 &&
              Math.abs(f.y - rm.y) < 1.2,
          );
          const zoneId = zHit?.id ?? rmHit?.id ?? 'bath';
          for (let mp = 0; mp < mirrorParts.length; mp++) {
            mirrorPlacements.push({
              id: mirrorParts.length === 1 ? `house:mirror:${fIdx}` : `house:mirror:${fIdx}:${mp}`,
              zoneId,
              matrixWorld: mtx.clone(),
              part: mirrorParts[mp],
            });
          }
        }
      });
      entries.push({ kind, prepared: p, matrices });
    });
    batchStaticFurnishings(entries, furnishings, owned);

    // A9: Awaited warm woven area rugs in Living Room & Bedroom via AAA-v2 prop pack (patched & texture-queued before Stage-6 warmup!).
    if (rug && !disposed) {
      const livRoom = plan.rooms.find(r => r.id === 'living');
      const bedRoom = plan.rooms.find(r => r.id === 'bedroom');
      const rugMats: T.Matrix4[] = [];
      if (livRoom) {
        const rw = livRoom.rect.x1 - livRoom.rect.x0;
        const rd = livRoom.rect.z1 - livRoom.rect.z0;
        const sx = Math.min(0.92, (rw - 1.2) / 2.8);
        const sz = Math.min(0.88, (rd - 0.8) / 2.0);
        if (sx > 0.35 && sz > 0.35) {
          rugMats.push(placeStreetPropOn((livRoom.rect.x0 + livRoom.rect.x1) * 0.5, livRoom.y + 0.012, (livRoom.rect.z0 + livRoom.rect.z1) * 0.5, 0, [sx, 1, sz]));
        }
      }
      if (bedRoom) {
        rugMats.push(placeStreetPropOn((bedRoom.rect.x0 + bedRoom.rect.x1) * 0.5 + 0.2, bedRoom.y + 0.012, (bedRoom.rect.z0 + bedRoom.rect.z1) * 0.5 + 0.25, Math.PI / 2, [0.68, 1, 0.72]));
      }
      if (rugMats.length) {
        const rg = instanceStreetProp(rug, rugMats, false);
        rg.name = 'house-woven-rugs';
        rg.traverse((node) => {
          const m = node as T.Mesh;
          if (!m.isMesh || !m.material) return;
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (let mi = 0; mi < mats.length; mi++) {
            const matItem = mats[mi];
            if (!matItem) continue;
            matItem.polygonOffset = true;
            matItem.polygonOffsetFactor = -1;
            matItem.polygonOffsetUnits = -2;
            patchMaterialWithEchoCsm(matItem);
            patchHeightFog(matItem);
          }
        });
        getEchoLifeTextureUploadQueue().enqueueFromObject(rg, LoadPriority.P1_PREFETCH);
        furnishings.add(rg);
      }
    }

    let added = false;
    for (const f of plan.furniture) {
      // `shower` is a walk-in zone (`footprint: null`, 0 solid inside tray; West `shower_glass` block emitted above).
      if (!f.footprint || f.asset === 'shower') continue;
      const w = f.footprint.x1 - f.footprint.x0;
      const d = f.footprint.z1 - f.footprint.z0;
      const hBox = f.asset === 'tv-console' ? 0.55 : 0.78;
      solid(w, hBox, d, (f.footprint.x0 + f.footprint.x1) / 2, f.y + hBox * 0.5, (f.footprint.z0 + f.footprint.z1) / 2);
      added = true;
    }
    return added;
  };

  const doorOpen = (id: DoorId) => {
    const d = doors.get(id);
    return !!d && (d.isOpen || Math.abs(d.angle) > 0.02);
  };
  const doorNear = (id: DoorId, body: { x: number; z: number }, rDist: number) => {
    const d = doors.get(id);
    if (!d) return false;
    const dx = d.plan.x - body.x, dz = d.plan.z - body.z;
    return dx * dx + dz * dz <= rDist * rDist;
  };
  const tmpEye = new T.Vector3();

  return {
    group,
    interiorGroup,
    doors,
    solids,
    fixtures,
    mirrorPlacements,
    showerEmitterSpec,
    furnish,
    setFinishes,
    setNight(night) {
      clearGlassHandle.setNight(night);
      shopGlassHandle.setNight(night);
    },
    setTvActive(on: boolean) {
      tvActive = on;
      if (tvScreenMat) {
        tvScreenMat.emissiveIntensity = on ? 0.85 : 0.0;
      }
    },
    get isTvActive() {
      return tvActive;
    },
    isInteriorVisible() {
      return interiorGroup.visible;
    },
    setQuality(nextTier) {
      extShadows = nextTier === 'high' || nextTier === 'ultra';
      for (const m of shadowCasters) m.castShadow = extShadows;
    },
    setCameraPos(pos) {
      clearGlassHandle.setCameraPos(pos);
      shopGlassHandle.setCameraPos(pos);
    },
    blockers: [...wallMeshes, ...floorMeshes],
    update(dt, reduced, body) {
      // Keep parallax glass eye position roughly updated even before Wave 2B passes exact camera world pos.
      const bodyY = (body as { y?: number }).y ?? GROUND_Y;
      tmpEye.set(body.x, bodyY + 1.6, body.z);
      clearGlassHandle.setCameraPos(tmpEye);
      shopGlassHandle.setCameraPos(tmpEye);

      const r = plan.footprint;
      const inStudySquare = Math.abs(body.x) <= plan.h - 0.02 && Math.abs(body.z) <= plan.h - 0.02;
      const dx = Math.max(r.x0 - body.x, 0, body.x - r.x1);
      const dz = Math.max(r.z0 - body.z, 0, body.z - r.z1);
      const insideFootprint = dx <= 0.15 && dz <= 0.15;

      // Enclosure culling: hide `house-interior` when deep inside closed Study Room or outdoors beyond open thresholds,
      // while predictively un-culling at `<= 2.8 m` (`3.2 m` hysteresis) before reaching the `hall` door handle!
      let showInterior = false;
      if (inStudySquare) {
        showInterior = doorOpen('hall') || doorNear('hall', body, interiorGroup.visible ? 3.2 : 2.8);
      } else if (insideFootprint) {
        showInterior = true;
      } else {
        const extDoorRadius = interiorGroup.visible ? 12 : 10;
        const openExtDoor =
          (doorOpen('entrance') && doorNear('entrance', body, extDoorRadius)) ||
          (doorOpen('garage_out') && doorNear('garage_out', body, extDoorRadius)) ||
          (doorOpen('balcony') && doorNear('balcony', body, extDoorRadius));
        const stoopPeek =
          body.x >= r.x0 - 0.5 && body.x <= r.x1 + 0.5 &&
          body.z >= plan.front - 0.2 && body.z <= plan.front + (interiorGroup.visible ? 3.2 : 2.4);
        showInterior = openExtDoor || stoopPeek;
      }

      interiorGroup.visible = showInterior;
      stepDoorParts(extDoorParts, dt, reduced, body);
      if (showInterior) stepDoorParts(intDoorParts, dt, reduced, body);
    },
    dispose() {
      disposed = true;
      mirrorPlacements.length = 0;
      furnishings.traverse(o => { if (o instanceof T.InstancedMesh) o.dispose(); });
      for (const mesh of painted.keys()) restoreFinish(mesh);
      for (const k of acquired) releaseLifeAsset(k);
      acquired.length = 0;
      owned.forEach(o => o.dispose());
      group.traverse(o => {
        const m = o as T.Mesh;
        if (m.isMesh && (m.name === 'life-wall' || m.name === 'life-floor' || m.name === 'life-trim')) m.geometry.dispose();
      });
      group.removeFromParent();
    },
  };
}
