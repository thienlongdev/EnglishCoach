import * as T from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import {
  GROUND_Y,
  STOREY,
  UPPER_WALL_TOP,
  WALL,
  type HousePlan,
  type WallSpan,
} from '@/lib/echo-life/plan';
import type { CityPlan } from '@/lib/echo-life/city';
import { stepCriticallyDamped1D } from '@/lib/echo-life/playerCollision';

/**
 * Study Space and Echo Life — AAA Unified 1st-Person and 3rd-Person Camera Rig (`cameraRig.ts`).
 *
 * Designed to execute strictly AFTER `Character.update` and `StudyWorld.updateBody` (`HumanRig` + `resolveRoot`)
 * so the camera reads current-frame poses with zero 1-frame latency:
 * 1. Analytical 3D critically damped pivot spring (`omegaPlanar = 18`, `omegaVertical = 14`).
 * 2. Swept-sphere (`r_cam = 0.18 m` > `0.087 m` frustum near-plane diagonal) obstruction solver
 *    against both analytic architectural OBBs (`house`, `buildings`, `city.lots`, `bookstacks`, `doors`)
 *    and Three.js blocker meshes (supporting `MeshBVH` + 5-whisker surface-normal pull-off so oblique
 *    grazing walls never slice the near frustum).
 * 3. Asymmetric boom spring (`omegaIn = 55`, `90 ms` hysteresis hold, `omegaOut = 9.5`) with a
 *    100% locked `(yaw, pitch)` horizon (`YXZ` Euler, zero roll/pitch slerp wobble).
 * 4. Stabilized 1st-person eye anchor with `r_head = 0.16 m` head-sphere stoop clamp and an
 *    own-limb near-plane guard (`viewZ < 0.35 m`, `y > eyeY - 0.45 m`) preventing any raised
 *    foot or leg from filling the 1P lens during dismount or crouch transitions.
 * 5. Seamless `~0.28 s` (`omega = 16.5`) `1P <-> 3P` dolly transition blending boom, shoulder offset,
 *    pivot elevation, FOV (`72 deg <-> 62 deg`), and head/avatar visibility without hard cuts.
 */

export const CAMERA_SPHERE_RADIUS = 0.18;
export const HEAD_SPHERE_RADIUS_1P = 0.16;
export const PIVOT_OMEGA_PLANAR = 18.0;
export const PIVOT_OMEGA_VERTICAL = 14.0;
export const BOOM_OMEGA_IN = 55.0;
export const BOOM_OMEGA_DOORWAY_IN = 22.0;
export const BOOM_OMEGA_OUT = 9.5;
export const BOOM_HOLD_SECONDS = 0.09;
export const VIEW_DOLLY_OMEGA = 22.0;
export const SHOULDER_CENTER_OMEGA = 14.0;
export const MIN_THIRD_PERSON_BOOM = 0.34;
export const FIRST_PERSON_SETTLED_BOOM = 0.055;
export const DOLLY_CROSSOVER_OUTER_BOOM = 0.42;
export const MIN_THIRD_PERSON_CORNER_BOOM = 0.26;
export const DEFAULT_FOV_FIRST = 72;
export const DEFAULT_FOV_THIRD = 62;
export const OWN_LIMB_NEAR_Z = 0.35;
export const OWN_LIMB_MIN_REL_Y = -0.45;

export type CameraViewMode = 'first' | 'third';

export interface AnalyticCameraBox {
  readonly id: string;
  /** Stage-local center `(x, y, z)`. */
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** Stage-local half-extents `(hx, hy, hz)`. */
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
  /** Stage Y rotation in radians (`0` for axis-aligned boxes). */
  readonly rotY: number;
}

export interface OwnLimbGuardUniforms {
  uOwnLimbGuardActive: { value: number };
  uOwnLimbEyeWorld: { value: T.Vector3 };
  uOwnLimbForwardWorld: { value: T.Vector3 };
}

export interface OwnLimbCheckResult {
  occluded: boolean;
  minViewZ: number;
}

export interface CameraRigStepInput {
  readonly dt: number;
  readonly viewMode: CameraViewMode;
  readonly reducedMotion?: boolean;
  /** Stage-to-world parent transform (`StudyWorld.stage`). Identity if omitted. */
  readonly stageMatrixWorld?: T.Matrix4;
  readonly stageInverseMatrixWorld?: T.Matrix4;
  /** Interpolated current-frame character root position in stage space (post `resolveRoot`). */
  readonly rootStagePos: T.Vector3;
  /** Optional post-IK anatomical eye midpoint in stage space (zero-lag 1st-person eye anchor). */
  readonly eyeStagePos?: T.Vector3;
  /** Smoothed floor/root elevation in stage space (from `VerticalElevationSpring` or vehicle/jump). */
  readonly smoothedRootY: number;
  /** Current-frame anatomical eye height above `rootStagePos.y` (`~1.52 m` standing, lower when crouched/seated). */
  readonly eyeHeight: number;
  /** Player mouse-look yaw and pitch in radians (`YXZ` convention). */
  readonly yaw: number;
  readonly pitch: number;
  /** Optional subtle bank roll in radians (clamped `[-0.04, 0.04]`, used only for cycling/driving). */
  readonly bankRoll?: number;
  /** Desired 3rd-person orbit boom length in metres (`e.g. 2.15 m` on foot, `3.4 m` on bike). */
  readonly targetOrbitDistance: number;
  /** Right-shoulder lateral framing offset in 3rd person (`default 0.20 m`). */
  readonly shoulderOffset3P?: number;
  /** Optional `[0..1]` proximity to an open doorway (`1` smoothly centers `shoulderOffset3P` `0.18 -> 0.04 m`). */
  readonly nearDoorwayBlend?: number;
  /** Forward torso stoop angle in radians (`0` upright .. `1.18` deep bend) for 1st-person reach framing. */
  readonly stoopRadians?: number;
  /** Normalized locomotion speed (`m/s`) and stride phase (`radians`) for subtle opt-in 1P breath/step feel. */
  readonly planarSpeed?: number;
  readonly stridePhase?: number;
  readonly fovFirst?: number;
  readonly fovThird?: number;
  /** Three.js scene meshes used for fine camera ray/BVH obstruction (`walls`, `floors`, `shells`). */
  readonly meshBlockers?: readonly T.Object3D[];
  /** Optional stage-space world positions of the player's own lower-limb joints (`thigh`, `shin`, `foot`, `toe`). */
  readonly ownLowerLimbWorldPoints?: readonly T.Vector3[];
}

export interface CameraRigStepOutput {
  /** `0` = pure 1st-person, `1` = pure 3rd-person. */
  readonly viewBlend: number;
  /** Current solved boom distance from pivot along `-forward` in metres. */
  readonly currentBoom: number;
  /** Unobstructed safe boom distance computed this frame in metres. */
  readonly safeBoom: number;
  readonly obstructed: boolean;
  /** True when character head/hair meshes should be hidden (`ownView`). */
  readonly ownViewHeadHidden: boolean;
  /** True when the character root should be visible in the main pass. */
  readonly characterVisible: boolean;
  /** Smooth `[0..1]` opacity factor across the `0.18..0.46 m` transition band. */
  readonly avatarOpacity: number;
  /** True if an own lower-limb joint entered the `0.35 m` 1P near-plane guard zone this frame. */
  readonly ownLimbNearClipped: boolean;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Optionally builds and attaches a `three-mesh-bvh` `boundsTree` onto static blocker geometries
 * once at load/warmup time so runtime camera queries run in O(log N) with zero triangle scan stalls.
 */
export function ensureMeshBlockerBVH(root: T.Object3D): number {
  let built = 0;
  root.traverse((node) => {
    const mesh = node as T.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geom = mesh.geometry as T.BufferGeometry & { boundsTree?: MeshBVH };
    if (!geom.boundsTree && geom.attributes.position && geom.attributes.position.count >= 12) {
      geom.boundsTree = new MeshBVH(geom);
      built++;
    }
  });
  return built;
}

/**
 * Builds analytic stage-space camera blocker boxes from `HousePlan` and `CityPlan` so 3rd-person and
 * 1st-person cameras NEVER clip through decorative `city.lots` buildings, house walls/slabs/stairs,
 * enterable building shells, or tall bookstacks (`top >= 1.25 m`) even before async GLBs stream in.
 * Small furniture (`< 1.25 m` chairs, tables, benches, plants) is intentionally excluded to prevent camera pumping.
 */
export function buildCameraBoxesFromPlan(
  house: HousePlan,
  city: CityPlan,
  extraTallObbs?: readonly {
    id: string;
    x: number;
    z: number;
    halfW: number;
    halfD: number;
    rotY: number;
    floorY: number;
    topRel: number;
  }[],
): AnalyticCameraBox[] {
  const boxes: AnalyticCameraBox[] = [];

  const pushWallSpan = (prefix: string, w: WallSpan, idx: number) => {
    const isAlongX = Math.abs(w.x1 - w.x0) >= Math.abs(w.z1 - w.z0);
    const spanMin = isAlongX ? w.x0 : w.z0;
    const spanMax = isAlongX ? w.x1 : w.z1;
    const fixedMin = isAlongX ? w.z0 : w.x0;
    const fixedMax = isAlongX ? w.z1 : w.x1;
    const fixedMid = (fixedMin + fixedMax) * 0.5;
    const fixedHalf = Math.max(WALL * 0.5, (fixedMax - fixedMin) * 0.5);

    if (!w.openings.length) {
      boxes.push({
        id: `${prefix}:w:${idx}`,
        cx: (w.x0 + w.x1) * 0.5,
        cy: (w.y0 + w.y1) * 0.5,
        cz: (w.z0 + w.z1) * 0.5,
        hx: Math.max(WALL * 0.5, (w.x1 - w.x0) * 0.5),
        hy: (w.y1 - w.y0) * 0.5,
        hz: Math.max(WALL * 0.5, (w.z1 - w.z0) * 0.5),
        rotY: 0,
      });
      return;
    }

    // Split wall span around door/window openings so open doorways stay unobstructed for camera sightlines!
    const sorted = [...w.openings].sort((a, b) => a.from - b.from);
    let cursor = spanMin;
    for (let i = 0; i < sorted.length; i++) {
      const op = sorted[i];
      if (op.from - cursor > 0.04) {
        const segMid = (cursor + op.from) * 0.5;
        const segHalf = (op.from - cursor) * 0.5;
        boxes.push({
          id: `${prefix}:w:${idx}:s${i}`,
          cx: isAlongX ? segMid : fixedMid,
          cy: (w.y0 + w.y1) * 0.5,
          cz: isAlongX ? fixedMid : segMid,
          hx: isAlongX ? segHalf : fixedHalf,
          hy: (w.y1 - w.y0) * 0.5,
          hz: isAlongX ? fixedHalf : segHalf,
          rotY: 0,
        });
      }
      // Header lintel above doorway/window opening.
      if (w.y1 - op.top > 0.05) {
        const opMid = (op.from + op.to) * 0.5;
        const opHalf = (op.to - op.from) * 0.5;
        boxes.push({
          id: `${prefix}:w:${idx}:top${i}`,
          cx: isAlongX ? opMid : fixedMid,
          cy: (op.top + w.y1) * 0.5,
          cz: isAlongX ? fixedMid : opMid,
          hx: isAlongX ? opHalf : fixedHalf,
          hy: (w.y1 - op.top) * 0.5,
          hz: isAlongX ? fixedHalf : opHalf,
          rotY: 0,
        });
      }
      // Window sill wall below `op.bottom` (doors have `bottom === undefined`).
      if (op.bottom !== undefined && op.bottom - w.y0 > 0.05) {
        const opMid = (op.from + op.to) * 0.5;
        const opHalf = (op.to - op.from) * 0.5;
        boxes.push({
          id: `${prefix}:w:${idx}:bot${i}`,
          cx: isAlongX ? opMid : fixedMid,
          cy: (w.y0 + op.bottom) * 0.5,
          cz: isAlongX ? fixedMid : opMid,
          hx: isAlongX ? opHalf : fixedHalf,
          hy: (op.bottom - w.y0) * 0.5,
          hz: isAlongX ? fixedHalf : opHalf,
          rotY: 0,
        });
      }
      cursor = Math.max(cursor, op.to);
    }
    if (spanMax - cursor > 0.04) {
      const segMid = (cursor + spanMax) * 0.5;
      const segHalf = (spanMax - cursor) * 0.5;
      boxes.push({
        id: `${prefix}:w:${idx}:end`,
        cx: isAlongX ? segMid : fixedMid,
        cy: (w.y0 + w.y1) * 0.5,
        cz: isAlongX ? fixedMid : segMid,
        hx: isAlongX ? segHalf : fixedHalf,
        hy: (w.y1 - w.y0) * 0.5,
        hz: isAlongX ? fixedHalf : segHalf,
        rotY: 0,
      });
    }
  };

  // Study Room 4 walls (with hall doorway opening on +X wall).
  const h = house.h;
  const hallDoor = house.doors.find((d) => d.id === 'hall');
  pushWallSpan(
    'study',
    {
      x0: h - WALL * 0.5,
      x1: h + WALL * 0.5,
      z0: -h,
      z1: h,
      y0: 0,
      y1: UPPER_WALL_TOP,
      openings: hallDoor
        ? [{ from: hallDoor.z - hallDoor.width * 0.5, to: hallDoor.z + hallDoor.width * 0.5, top: hallDoor.height }]
        : [],
      face: 'interior',
      finish: 'plaster',
    },
    0,
  );
  pushWallSpan(
    'study',
    { x0: -h - WALL * 0.5, x1: -h + WALL * 0.5, z0: -h, z1: h, y0: 0, y1: UPPER_WALL_TOP, openings: [], face: 'interior', finish: 'plaster' },
    1,
  );
  pushWallSpan(
    'study',
    { x0: -h, x1: h, z0: -h - WALL * 0.5, z1: -h + WALL * 0.5, y0: 0, y1: UPPER_WALL_TOP, openings: [], face: 'exterior', finish: 'plaster' },
    2,
  );
  pushWallSpan(
    'study',
    { x0: -h, x1: h, z0: h - WALL * 0.5, z1: h + WALL * 0.5, y0: 0, y1: UPPER_WALL_TOP, openings: [], face: 'interior', finish: 'plaster' },
    3,
  );

  // Starter house walls and ceiling/floor slabs.
  for (let i = 0; i < house.walls.length; i++) pushWallSpan('house', house.walls[i], i);
  for (let i = 0; i < house.slabs.length; i++) {
    const sl = house.slabs[i];
    boxes.push({
      id: `house:slab:${i}`,
      cx: (sl.rect.x0 + sl.rect.x1) * 0.5,
      cy: sl.y - sl.thick * 0.5,
      cz: (sl.rect.z0 + sl.rect.z1) * 0.5,
      hx: (sl.rect.x1 - sl.rect.x0) * 0.5,
      hy: Math.max(0.06, sl.thick * 0.5),
      hz: (sl.rect.z1 - sl.rect.z0) * 0.5,
      rotY: 0,
    });
  }
  // Study Room ceiling slab so 3P camera never rises above the room ceiling.
  boxes.push({
    id: 'study:ceiling',
    cx: 0,
    cy: UPPER_WALL_TOP + 0.08,
    cz: 0,
    hx: h,
    hy: 0.08,
    hz: h,
    rotY: 0,
  });

  // Enterable city buildings & residences (walls + slabs + tall `cameraOccluder` interior bookstacks).
  const allEnterable = [...city.buildings, ...city.residences];
  for (let bIdx = 0; bIdx < allEnterable.length; bIdx++) {
    const b = allEnterable[bIdx];
    for (let i = 0; i < b.walls.length; i++) pushWallSpan(`bld:${b.id}`, b.walls[i], i);
    for (let i = 0; i < b.slabs.length; i++) {
      const sl = b.slabs[i];
      boxes.push({
        id: `bld:${b.id}:slab:${i}`,
        cx: (sl.rect.x0 + sl.rect.x1) * 0.5,
        cy: sl.y - sl.thick * 0.5,
        cz: (sl.rect.z0 + sl.rect.z1) * 0.5,
        hx: (sl.rect.x1 - sl.rect.x0) * 0.5,
        hy: Math.max(0.06, sl.thick * 0.5),
        hz: (sl.rect.z1 - sl.rect.z0) * 0.5,
        rotY: 0,
      });
    }
    for (let i = 0; i < b.blocks.length; i++) {
      const bl = b.blocks[i];
      if (!bl.cameraOccluder) continue;
      const topRel = bl.topRel ?? 2.2;
      const baseY = bl.y ?? b.zones[0]?.y ?? GROUND_Y;
      boxes.push({
        id: `bld:${b.id}:occ:${i}`,
        cx: (bl.rect.x0 + bl.rect.x1) * 0.5,
        cy: baseY + topRel * 0.5,
        cz: (bl.rect.z0 + bl.rect.z1) * 0.5,
        hx: (bl.rect.x1 - bl.rect.x0) * 0.5,
        hy: topRel * 0.5,
        hz: (bl.rect.z1 - bl.rect.z0) * 0.5,
        rotY: 0,
      });
    }
  }

  // Decorative backdrop `city.lots` buildings (solid architectural blocks — previously 100% missing from `blockers()`!).
  for (let i = 0; i < city.lots.length; i++) {
    const lot = city.lots[i];
    const lotHeight = Math.max(3.4, lot.storeys * STOREY);
    boxes.push({
      id: `lot:${lot.id}`,
      cx: (lot.rect.x0 + lot.rect.x1) * 0.5,
      cy: GROUND_Y + lotHeight * 0.5,
      cz: (lot.rect.z0 + lot.rect.z1) * 0.5,
      hx: (lot.rect.x1 - lot.rect.x0) * 0.5,
      hy: lotHeight * 0.5,
      hz: (lot.rect.z1 - lot.rect.z0) * 0.5,
      rotY: 0,
    });
  }

  // Large solid interior bookstacks / tall wardrobes (`topRel >= 1.55 m`).
  if (extraTallObbs) {
    for (let i = 0; i < extraTallObbs.length; i++) {
      const ob = extraTallObbs[i];
      if (ob.topRel < 1.55) continue;
      boxes.push({
        id: `tall:${ob.id}`,
        cx: ob.x,
        cy: ob.floorY + ob.topRel * 0.5,
        cz: ob.z,
        hx: ob.halfW,
        hy: ob.topRel * 0.5,
        hz: ob.halfD,
        rotY: ob.rotY,
      });
    }
  }

  return boxes;
}

/**
 * Exact 3D swept-sphere vs Minkowski-expanded OBB (`box + sphereRadius`) slab intersection (`[0, maxDist]`).
 * Returns the earliest safe center distance along `origin + dir * t` (`maxDist` if unobstructed).
 */
export function sweepSphereAgainstBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
  radius: number,
  box: AnalyticCameraBox,
): number {
  let rx = ox - box.cx;
  let rz = oz - box.cz;
  const ry = oy - box.cy;
  let ldx = dx;
  let ldz = dz;
  const ldy = dy;

  if (Math.abs(box.rotY) > 1e-6) {
    const s = Math.sin(box.rotY);
    const c = Math.cos(box.rotY);
    const tx = rx * c - rz * s;
    const tz = rx * s + rz * c;
    rx = tx;
    rz = tz;
    const tdx = dx * c - dz * s;
    const tdz = dx * s + dz * c;
    ldx = tdx;
    ldz = tdz;
  }

  const ex = box.hx + radius;
  const ey = box.hy + radius;
  const ez = box.hz + radius;

  // Quick AABB reject over segment `[0, maxDist]`.
  const endX = rx + ldx * maxDist;
  const endY = ry + ldy * maxDist;
  const endZ = rz + ldz * maxDist;
  if (Math.min(rx, endX) > ex || Math.max(rx, endX) < -ex) return maxDist;
  if (Math.min(ry, endY) > ey || Math.max(ry, endY) < -ey) return maxDist;
  if (Math.min(rz, endZ) > ez || Math.max(rz, endZ) < -ez) return maxDist;

  // If ray origin is ALREADY slightly inside the expanded box (only if outside core box!), allow push-off to `0`.
  const insideCore = Math.abs(rx) < box.hx && Math.abs(ry) < box.hy && Math.abs(rz) < box.hz;
  if (!insideCore && Math.abs(rx) < ex && Math.abs(ry) < ey && Math.abs(rz) < ez) {
    // Check if ray moves deeper toward box center: if moving deeper, clamp at `0`; if moving away, ignore!
    const dotCenter = rx * ldx + ry * ldy + rz * ldz;
    if (dotCenter < 0) return 0;
  }

  let tMin = 0;
  let tMax = maxDist;

  // X slab
  if (Math.abs(ldx) < 1e-8) {
    if (Math.abs(rx) > ex) return maxDist;
  } else {
    const inv = 1 / ldx;
    let t1 = (-ex - rx) * inv;
    let t2 = (ex - rx) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return maxDist;
  }

  // Y slab
  if (Math.abs(ldy) < 1e-8) {
    if (Math.abs(ry) > ey) return maxDist;
  } else {
    const inv = 1 / ldy;
    let t1 = (-ey - ry) * inv;
    let t2 = (ey - ry) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return maxDist;
  }

  // Z slab
  if (Math.abs(ldz) < 1e-8) {
    if (Math.abs(rz) > ez) return maxDist;
  } else {
    const inv = 1 / ldz;
    let t1 = (-ez - rz) * inv;
    let t2 = (ez - rz) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return maxDist;
  }

  if (tMin >= 0 && tMin <= maxDist) {
    return Math.max(0, tMin);
  }
  return maxDist;
}

/**
 * Evaluates whether any of the player's own lower-limb joints (`thigh`, `shin`, `foot`, `toe`)
 * intrude into the 1st-person near-plane guard bubble (`viewZ < 0.35 m` and `y > eyeY - 0.45 m`,
 * or radial distance `< 0.28 m` from the lens). Zero heap allocations.
 */
export function evaluateOwnLimbNearPlaneGuard(
  eyeWorld: T.Vector3,
  forwardWorld: T.Vector3,
  limbWorldPoints: readonly T.Vector3[],
  out: OwnLimbCheckResult,
): OwnLimbCheckResult {
  out.occluded = false;
  out.minViewZ = Infinity;

  for (let i = 0; i < limbWorldPoints.length; i++) {
    const pt = limbWorldPoints[i];
    const dx = pt.x - eyeWorld.x;
    const dy = pt.y - eyeWorld.y;
    const dz = pt.z - eyeWorld.z;
    if (dy < OWN_LIMB_MIN_REL_Y) continue;

    const viewZ = dx * forwardWorld.x + dy * forwardWorld.y + dz * forwardWorld.z;
    const radialSq = dx * dx + dy * dy + dz * dz;
    const lateralSq = Math.max(0, radialSq - viewZ * viewZ);

    if (viewZ > -0.06 && viewZ < OWN_LIMB_NEAR_Z && lateralSq < 0.26 * 0.26) {
      out.occluded = true;
      if (viewZ < out.minViewZ) out.minViewZ = viewZ;
    } else if (radialSq < 0.24 * 0.24) {
      out.occluded = true;
      if (viewZ < out.minViewZ) out.minViewZ = viewZ;
    }
  }
  return out;
}

/**
 * Optional idempotent shader guard (`:ec-1p-limb-guard-v1`) for player lower-body materials.
 * Uses constant uniforms (`uOwnLimbGuardActive` `0.0` or `1.0`) so toggling 1P <-> 3P triggers
 * ZERO WebGL program recompiles while discarding any fragment inside the `0.35 m` 1P eye bubble.
 */
export function createOwnLimbGuardUniforms(): OwnLimbGuardUniforms {
  return {
    uOwnLimbGuardActive: { value: 0 },
    uOwnLimbEyeWorld: { value: new T.Vector3() },
    uOwnLimbForwardWorld: { value: new T.Vector3(0, 0, -1) },
  };
}

const OWN_LIMB_GUARD_TAG = ':ec-1p-limb-guard-v1';
const OWN_LIMB_GUARD_EXCLUDE_RE =
  /hand|forearm|arm|wrist|finger|thumb|head|face|hair|eye|brow|lash|teeth|tongue|mouth|oral|glasses|sunglass|hat|beanie|beret|cap|earring|necklace|^Trim$/i;
const OWN_LIMB_ARM_HEAD_ONLY_BONE_RE =
  /^(forearm|lower_arm|upper_arm|shoulder|clavicle|hand|wrist|thumb|index|middle|ring|pinky|finger|head|neck|eye|jaw|hair)/i;

/**
 * Returns `true` only for lower-body / torso / footwear character meshes that can poke into the 1st-person
 * near plane during crouch/sit/steep look-down — strictly excluding `Hands`, forearms, head, face, hair,
 * eyes, and headwear/eyewear so 1st-person held items in Study Space are NEVER clipped (`E5-05`).
 */
export function shouldAttachOwnBodyNearClip(mesh: T.Mesh, material: T.Material): boolean {
  if (OWN_LIMB_GUARD_EXCLUDE_RE.test(mesh.name) || OWN_LIMB_GUARD_EXCLUDE_RE.test(material.name)) {
    return false;
  }
  for (let p = mesh.parent, depth = 0; p && depth < 4; p = p.parent, depth++) {
    if (p.name && /hair|head_acc/i.test(p.name)) return false;
  }
  const skinned = mesh as T.SkinnedMesh;
  const bones = skinned.isSkinnedMesh ? skinned.skeleton?.bones : undefined;
  const skinIdx = mesh.geometry?.getAttribute('skinIndex');
  const skinW = mesh.geometry?.getAttribute('skinWeight');
  if (bones && bones.length > 0 && skinIdx && skinW && skinIdx.count > 0) {
    const step = Math.max(1, Math.floor(skinIdx.count / 64));
    let anyWeight = false;
    let anyTorsoOrLeg = false;
    for (let i = 0; i < skinIdx.count; i += step) {
      for (let k = 0; k < 4; k++) {
        const w = skinW.getComponent(i, k);
        if (w <= 0.04) continue;
        anyWeight = true;
        const b = bones[skinIdx.getComponent(i, k)];
        const bName = (b?.userData?.name as string | undefined) ?? b?.name ?? '';
        if (!OWN_LIMB_ARM_HEAD_ONLY_BONE_RE.test(bName)) {
          anyTorsoOrLeg = true;
          break;
        }
      }
      if (anyTorsoOrLeg) break;
    }
    if (anyWeight && !anyTorsoOrLeg) return false;
  }
  return true;
}

export function attachOwnBodyNearClipShader(
  material: T.Material,
  uniforms: OwnLimbGuardUniforms,
): void {
  const ud = material.userData ?? (material.userData = {});
  const hasCustomPrevKey = material.customProgramCacheKey !== T.Material.prototype.customProgramCacheKey;
  let applied = ud.__ecShaderTags as Set<string> | undefined;
  if (!(applied instanceof Set)) {
    applied = new Set<string>();
    if (hasCustomPrevKey) {
      try {
        const existingKey = material.customProgramCacheKey();
        if (typeof existingKey === 'string' && existingKey.length > 0) {
          for (const part of existingKey.split('|')) {
            if (part) applied.add(part);
          }
        }
      } catch {
        // Ignore third-party cache key closures requiring render context
      }
    }
    ud.__ecShaderTags = applied;
  }
  if (applied.has(OWN_LIMB_GUARD_TAG) || (ud.__ecOwnLimbGuardAttached && hasCustomPrevKey)) {
    applied.add(OWN_LIMB_GUARD_TAG);
    ud.__ecOwnLimbGuardAttached = true;
    return;
  }
  applied.add(OWN_LIMB_GUARD_TAG);
  ud.__ecOwnLimbGuardAttached = true;

  const prevCompile = material.onBeforeCompile;
  const hasCustomPrevCompile = prevCompile !== T.Material.prototype.onBeforeCompile;
  const prevCacheKey = hasCustomPrevKey ? material.customProgramCacheKey.bind(material) : null;
  const fallbackPrevKey = !hasCustomPrevKey && hasCustomPrevCompile ? prevCompile.toString() : '';

  material.customProgramCacheKey = () => {
    const base = prevCacheKey ? prevCacheKey() : fallbackPrevKey;
    return base ? `${base}|${OWN_LIMB_GUARD_TAG}` : OWN_LIMB_GUARD_TAG;
  };

  material.onBeforeCompile = (shader, renderer) => {
    if (hasCustomPrevCompile) prevCompile.call(material, shader, renderer);
    shader.uniforms.uOwnLimbGuardActive = uniforms.uOwnLimbGuardActive;
    shader.uniforms.uOwnLimbEyeWorld = uniforms.uOwnLimbEyeWorld;
    shader.uniforms.uOwnLimbForwardWorld = uniforms.uOwnLimbForwardWorld;

    if (!shader.vertexShader.includes('vEcOwnWorldPos')) {
      // `#include <worldpos_vertex>` runs AFTER `#include <skinning_vertex>`, where `transformed`
      // already holds `(bindMatrixInverse * skinned).xyz` in local space (`E5-05`).
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vEcOwnWorldPos;',
        )
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\nvec4 ecOwnWp = modelMatrix * vec4( transformed, 1.0 );\nvEcOwnWorldPos = ecOwnWp.xyz;',
        );
    }

    if (!shader.fragmentShader.includes('uOwnLimbGuardActive')) {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uOwnLimbGuardActive;
uniform vec3 uOwnLimbEyeWorld;
uniform vec3 uOwnLimbForwardWorld;
varying vec3 vEcOwnWorldPos;`,
        )
        .replace(
          'void main() {',
          `void main() {
  if (uOwnLimbGuardActive > 0.5) {
    vec3 ecRel = vEcOwnWorldPos - uOwnLimbEyeWorld;
    float ecDistSq = dot(ecRel, ecRel);
    float ecHorizSq = dot(ecRel.xz, ecRel.xz);
    float ecFwdLen = length(uOwnLimbForwardWorld.xz);
    vec2 ecFwdXZ = ecFwdLen > 1e-4 ? (uOwnLimbForwardWorld.xz / ecFwdLen) : vec2(0.0, -1.0);
    float ecPlanarFwd = dot(ecRel.xz, ecFwdXZ);
    if (ecRel.y > -0.36 && ecPlanarFwd < 0.14 && ecHorizSq < 0.1156) discard;
    if (!gl_FrontFacing && ecRel.y > -0.72 && ecDistSq < 0.64) discard;
    if (ecRel.y > -0.68 && ecPlanarFwd < -0.02 && ecHorizSq < 0.1225) discard;
    if (ecRel.y > -0.48 && ecRel.y < 0.12) {
      float ecVz = dot(ecRel, uOwnLimbForwardWorld);
      float ecLatSq = max(0.0, ecDistSq - ecVz * ecVz);
      if (ecVz > -0.08 && ecVz < 0.17 && ecLatSq < 0.0324) discard;
    }
  }`,
        );
    }
  };

  material.needsUpdate = true;
}

const OBSERVED_CHAR_NODES = new WeakSet<T.Object3D>();

/**
 * Attaches `attachOwnBodyNearClipShader` to eligible meshes under `root` AND hooks container `.add`
 * so `Character.load()`, `Wardrobe.dress()`, and `applyCreatorProfile()` patch newly created avatar
 * materials synchronously at mount time — strictly before `runPreEntryWarmup` (`0` post-warmup recompiles).
 */
export function observeCharacterOwnBodyMaterials(
  root: T.Object3D,
  uniforms: OwnLimbGuardUniforms,
  onStructureChanged?: () => void,
): void {
  root.traverse((node) => {
    const mesh = node as T.Mesh;
    if (mesh.isMesh && mesh.material) {
      if (Array.isArray(mesh.material)) {
        for (let i = 0; i < mesh.material.length; i++) {
          const mat = mesh.material[i];
          if (mat && shouldAttachOwnBodyNearClip(mesh, mat)) {
            attachOwnBodyNearClipShader(mat, uniforms);
          }
        }
      } else if (shouldAttachOwnBodyNearClip(mesh, mesh.material)) {
        attachOwnBodyNearClipShader(mesh.material, uniforms);
      }
      return;
    }

    if ((node as T.Bone).isBone || OBSERVED_CHAR_NODES.has(node)) return;
    OBSERVED_CHAR_NODES.add(node);
    const origAdd = node.add;
    node.add = function (...children: T.Object3D[]) {
      const res = origAdd.apply(this, children);
      for (let i = 0; i < children.length; i++) {
        if (children[i]) {
          observeCharacterOwnBodyMaterials(children[i], uniforms, onStructureChanged);
        }
      }
      onStructureChanged?.();
      return res;
    };
  });
}

/**
 * Zero-allocation 3D critically damped spring with independent planar (`X, Z`) and vertical (`Y`) omegas.
 */
export class CriticallyDampedSpring3D {
  readonly position = new T.Vector3();
  readonly velocity = new T.Vector3();
  private initialized = false;
  private readonly scratch = { value: 0, velocity: 0 };

  snap(target: T.Vector3): void {
    this.position.copy(target);
    this.velocity.set(0, 0, 0);
    this.initialized = true;
  }

  step(
    target: T.Vector3,
    omegaPlanar: number,
    omegaVertical: number,
    dt: number,
    teleportThreshold = 3.2,
  ): T.Vector3 {
    if (!this.initialized || this.position.distanceToSquared(target) > teleportThreshold * teleportThreshold) {
      this.snap(target);
      return this.position;
    }

    stepCriticallyDamped1D(this.position.x, this.velocity.x, target.x, omegaPlanar, dt, this.scratch);
    this.position.x = this.scratch.value;
    this.velocity.x = this.scratch.velocity;

    stepCriticallyDamped1D(this.position.y, this.velocity.y, target.y, omegaVertical, dt, this.scratch);
    this.position.y = this.scratch.value;
    this.velocity.y = this.scratch.velocity;

    stepCriticallyDamped1D(this.position.z, this.velocity.z, target.z, omegaPlanar, dt, this.scratch);
    this.position.z = this.scratch.value;
    this.velocity.z = this.scratch.velocity;

    return this.position;
  }
}

const BOX_CELL = 6.0;
function boxGridKey(ix: number, iz: number): number {
  return ((ix + 4096) << 14) ^ (iz + 4096);
}

function isSwingingDoorLeafObject(obj: T.Object3D | null): boolean {
  for (let cur = obj, depth = 0; cur && depth < 5; cur = cur.parent, depth++) {
    if (cur.userData?.isDoorLeaf === true) return true;
  }
  return false;
}

/**
 * Unified 1st-Person and 3rd-Person Camera Embodiment Rig.
 */
export class CameraEmbodimentRig {
  readonly pivotSpring = new CriticallyDampedSpring3D();
  readonly ownLimbUniforms = createOwnLimbGuardUniforms();

  private viewBlend = 1.0;
  private viewBlendVel = 0.0;
  private currentBoom = 2.15;
  private boomVel = 0.0;
  private holdTimer = 0.0;
  private shoulderCenterScale = 1.0;
  private shoulderCenterVel = 0.0;
  private strideBobSmoothed = 0.0;
  private lastGuardDesired = false;
  private initialized = false;

  private readonly boxGrid = new Map<number, AnalyticCameraBox[]>();
  private allBoxes: AnalyticCameraBox[] = [];
  private liveDoorBoxes: AnalyticCameraBox[] = [];

  // Pre-allocated scratch math objects (0 per-frame GC).
  private readonly euler = new T.Euler(0, 0, 0, 'YXZ');
  private readonly forwardStage = new T.Vector3();
  private readonly rightStage = new T.Vector3();
  private readonly upStage = new T.Vector3(0, 1, 0);
  private readonly targetPivotStage = new T.Vector3();
  private readonly pivot3PBaseStage = new T.Vector3();
  private readonly pivotStage = new T.Vector3();
  private readonly stoopedEyeStage = new T.Vector3();
  private readonly rayDirStage = new T.Vector3();
  private readonly camStage = new T.Vector3();
  private readonly camWorld = new T.Vector3();
  private readonly pivotWorld = new T.Vector3();
  private readonly rayDirWorld = new T.Vector3();
  private readonly forwardWorld = new T.Vector3();
  private readonly stageRotQuat = new T.Quaternion();
  private readonly localQuat = new T.Quaternion();
  private readonly whiskerRight = new T.Vector3();
  private readonly whiskerUp = new T.Vector3();
  private readonly whiskerOrigin = new T.Vector3();
  private readonly hitNormalWorld = new T.Vector3();
  private readonly raycaster = new T.Raycaster();
  private readonly rayHits: T.Intersection[] = [];
  private readonly scratch1D = { value: 0, velocity: 0 };
  private readonly boomSweepScratch = { centerDist: 0, whiskerDist: 0 };
  private readonly limbCheck: OwnLimbCheckResult = { occluded: false, minViewZ: Infinity };

  constructor(initialView: CameraViewMode = 'third', initialOrbit = 2.15) {
    this.viewBlend = initialView === 'third' ? 1.0 : 0.0;
    this.currentBoom = initialView === 'third' ? initialOrbit : 0.0;
  }

  /** Indexes static architectural camera-blocker boxes into a 6 m spatial grid. */
  setAnalyticBoxes(boxes: readonly AnalyticCameraBox[]): void {
    this.allBoxes = boxes.slice();
    this.boxGrid.clear();
    for (let i = 0; i < this.allBoxes.length; i++) {
      const b = this.allBoxes[i];
      const reach = Math.hypot(b.hx, b.hz) + 0.5;
      const ix0 = Math.floor((b.cx - reach) / BOX_CELL);
      const ix1 = Math.floor((b.cx + reach) / BOX_CELL);
      const iz0 = Math.floor((b.cz - reach) / BOX_CELL);
      const iz1 = Math.floor((b.cz + reach) / BOX_CELL);
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const k = boxGridKey(ix, iz);
          let cell = this.boxGrid.get(k);
          if (!cell) {
            cell = [];
            this.boxGrid.set(k, cell);
          }
          cell.push(b);
        }
      }
    }
  }

  /** Updates dynamic swung `LifeDoor` leaf camera blockers (`~0.04 m` thick OBBs). */
  setLiveDoorBoxes(doors: readonly AnalyticCameraBox[]): void {
    this.liveDoorBoxes = doors.slice();
  }

  /** Immediately disables the 1st-person torso/limb near-clip shader uniform (`0` shader recompiles). */
  clearOwnLimbGuard(): void {
    this.ownLimbUniforms.uOwnLimbGuardActive.value = 0;
  }

  /** Restores the 1st-person torso/limb near-clip uniform after an offscreen reflection/capture pass. */
  restoreOwnLimbGuard(): void {
    this.ownLimbUniforms.uOwnLimbGuardActive.value = this.lastGuardDesired ? 1 : 0;
  }

  /** Hard-resets springs at spawn, teleport, or initial world mount. */
  snapTo(
    viewMode: CameraViewMode,
    rootStagePos: T.Vector3,
    eyeHeight: number,
    orbitDistance: number,
    eyeStagePos?: T.Vector3,
  ): void {
    this.viewBlend = viewMode === 'third' ? 1.0 : 0.0;
    this.viewBlendVel = 0;
    this.currentBoom = viewMode === 'third' ? orbitDistance : 0;
    this.boomVel = 0;
    this.holdTimer = 0;
    this.shoulderCenterScale = 1.0;
    this.shoulderCenterVel = 0;
    this.strideBobSmoothed = 0;
    this.targetPivotStage.set(rootStagePos.x, rootStagePos.y + eyeHeight * 0.91, rootStagePos.z);
    this.pivotSpring.snap(this.targetPivotStage);
    if (eyeStagePos && viewMode === 'first') {
      this.stoopedEyeStage.copy(eyeStagePos);
    }
    this.lastGuardDesired = viewMode === 'first';
    this.ownLimbUniforms.uOwnLimbGuardActive.value = viewMode === 'first' ? 1 : 0;
    this.initialized = true;
  }

  /**
   * Sweeps a sphere of `radius` from `originStage` along unit `dirStage` up to `maxDist` against
   * indexed analytic boxes + live doors + optional Three.js mesh blockers (with capped oblique surface-normal margin).
   */
  sweepSphereStage(
    originStage: T.Vector3,
    dirStage: T.Vector3,
    maxDist: number,
    radius: number,
    stageMatrixWorld?: T.Matrix4,
    meshBlockers?: readonly T.Object3D[],
  ): number {
    this.sweepBoomStage(
      originStage,
      dirStage,
      maxDist,
      radius,
      stageMatrixWorld,
      meshBlockers,
      this.boomSweepScratch,
    );
    return this.boomSweepScratch.whiskerDist;
  }

  /**
   * Dual-tier swept obstruction query:
   * - `centerDist`: exact `w === 0` center sightline + tight core lens sphere (`0.065 m`), used for the hard 1-frame wall ceiling.
   * - `whiskerDist`: full `radius` analytic sweep + 5-whisker cone with oblique pullback capped at `<= 1.45 * radius` (never `0.75 m`!).
   */
  private sweepBoomStage(
    originStage: T.Vector3,
    dirStage: T.Vector3,
    maxDist: number,
    radius: number,
    stageMatrixWorld: T.Matrix4 | undefined,
    meshBlockers: readonly T.Object3D[] | undefined,
    out: { centerDist: number; whiskerDist: number },
  ): void {
    if (maxDist <= 1e-5) {
      out.centerDist = 0;
      out.whiskerDist = 0;
      return;
    }
    let centerDist = maxDist;
    let whiskerDist = maxDist;
    const coreRadius = Math.min(0.065, radius * 0.36);

    // 1. Spatial-grid Analytic OBBs (walls, slabs, city lots, bookstacks).
    const endX = originStage.x + dirStage.x * maxDist;
    const endZ = originStage.z + dirStage.z * maxDist;
    const ix0 = Math.floor((Math.min(originStage.x, endX) - radius) / BOX_CELL);
    const ix1 = Math.floor((Math.max(originStage.x, endX) + radius) / BOX_CELL);
    const iz0 = Math.floor((Math.min(originStage.z, endZ) - radius) / BOX_CELL);
    const iz1 = Math.floor((Math.max(originStage.z, endZ) + radius) / BOX_CELL);

    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const cell = this.boxGrid.get(boxGridKey(ix, iz));
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const hitFull = sweepSphereAgainstBox(
            originStage.x,
            originStage.y,
            originStage.z,
            dirStage.x,
            dirStage.y,
            dirStage.z,
            whiskerDist,
            radius,
            cell[i],
          );
          if (hitFull < whiskerDist) whiskerDist = hitFull;
          const hitCore = sweepSphereAgainstBox(
            originStage.x,
            originStage.y,
            originStage.z,
            dirStage.x,
            dirStage.y,
            dirStage.z,
            centerDist,
            coreRadius,
            cell[i],
          );
          if (hitCore < centerDist) centerDist = hitCore;
        }
      }
    }

    // 2. Live swung door leaf OBBs (if explicitly registered).
    for (let i = 0; i < this.liveDoorBoxes.length; i++) {
      const hitFull = sweepSphereAgainstBox(
        originStage.x,
        originStage.y,
        originStage.z,
        dirStage.x,
        dirStage.y,
        dirStage.z,
        whiskerDist,
        radius,
        this.liveDoorBoxes[i],
      );
      if (hitFull < whiskerDist) whiskerDist = hitFull;
    }

    // 3. Three.js Mesh Blockers: 5-whisker cone + capped oblique surface-normal clearance (`<= 1.45 * radius`)!
    if (meshBlockers && meshBlockers.length > 0 && centerDist > 1e-4) {
      this.pivotWorld.copy(originStage);
      this.rayDirWorld.copy(dirStage);
      if (stageMatrixWorld) {
        this.pivotWorld.applyMatrix4(stageMatrixWorld);
        this.rayDirWorld.transformDirection(stageMatrixWorld).normalize();
      }

      if (Math.abs(this.rayDirWorld.y) > 0.92) {
        this.whiskerRight.set(1, 0, 0).cross(this.rayDirWorld).normalize();
      } else {
        this.whiskerRight.set(0, 1, 0).cross(this.rayDirWorld).normalize();
      }
      this.whiskerUp.crossVectors(this.rayDirWorld, this.whiskerRight).normalize();

      const wR = radius * 0.78;
      const maxPullback = radius * 1.45;

      for (let w = 0; w < 5; w++) {
        this.whiskerOrigin.copy(this.pivotWorld);
        if (w === 1) this.whiskerOrigin.addScaledVector(this.whiskerRight, wR);
        else if (w === 2) this.whiskerOrigin.addScaledVector(this.whiskerRight, -wR);
        else if (w === 3) this.whiskerOrigin.addScaledVector(this.whiskerUp, wR);
        else if (w === 4) this.whiskerOrigin.addScaledVector(this.whiskerUp, -wR);

        // Verify the shifted whisker origin did not cross a non-door-leaf wall from `pivotWorld`.
        if (w > 0) {
          const shiftVec = this.camWorld.copy(this.whiskerOrigin).sub(this.pivotWorld);
          const shiftLen = shiftVec.length();
          if (shiftLen > 1e-5) {
            shiftVec.divideScalar(shiftLen);
            this.raycaster.set(this.pivotWorld, shiftVec);
            this.raycaster.near = 0;
            this.raycaster.far = shiftLen;
            this.rayHits.length = 0;
            this.raycaster.intersectObjects(meshBlockers as T.Object3D[], true, this.rayHits);
            let blockedShift = false;
            for (let sh = 0; sh < this.rayHits.length; sh++) {
              if (!isSwingingDoorLeafObject(this.rayHits[sh].object)) {
                blockedShift = true;
                break;
              }
            }
            if (blockedShift) {
              this.whiskerOrigin.copy(this.pivotWorld);
            }
          }
        }

        const farLimit = (w === 0 ? centerDist : whiskerDist) + maxPullback;
        this.raycaster.set(this.whiskerOrigin, this.rayDirWorld);
        this.raycaster.near = 0;
        this.raycaster.far = farLimit;
        this.rayHits.length = 0;
        this.raycaster.intersectObjects(meshBlockers as T.Object3D[], true, this.rayHits);

        for (let h = 0; h < this.rayHits.length; h++) {
          const hit = this.rayHits[h];
          if (isSwingingDoorLeafObject(hit.object)) continue;
          let pullback = radius;
          if (hit.face) {
            this.hitNormalWorld.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize();
            const cosIncidence = Math.abs(this.rayDirWorld.dot(this.hitNormalWorld));
            pullback = Math.min(maxPullback, radius / Math.max(0.42, cosIncidence));
          }
          const safeD = Math.max(0, hit.distance - pullback);
          if (w === 0 && safeD < centerDist) centerDist = safeD;
          if (safeD < whiskerDist) whiskerDist = safeD;
          break;
        }
      }
      this.rayHits.length = 0;
    }

    if (whiskerDist > centerDist) whiskerDist = centerDist;
    out.centerDist = centerDist;
    out.whiskerDist = whiskerDist;
  }

  /**
   * Executes one post-IK camera update step and writes the finalized transform + FOV onto `camera`.
   */
  update(camera: T.PerspectiveCamera, input: CameraRigStepInput): CameraRigStepOutput {
    const dt = Math.max(0, Math.min(0.1, input.dt));
    const targetView = input.viewMode === 'third' ? 1.0 : 0.0;

    if (!this.initialized) {
      this.snapTo(input.viewMode, input.rootStagePos, input.eyeHeight, input.targetOrbitDistance);
    }

    // 1. Smooth `~0.20 s` 1P <-> 3P view dolly blend (`omega = 22.0`, zero snap).
    if (input.reducedMotion) {
      this.viewBlend = targetView;
      this.viewBlendVel = 0;
    } else {
      stepCriticallyDamped1D(this.viewBlend, this.viewBlendVel, targetView, VIEW_DOLLY_OMEGA, dt, this.scratch1D);
      this.viewBlend = Math.max(0, Math.min(1, this.scratch1D.value));
      this.viewBlendVel = this.scratch1D.velocity;
      if (Math.abs(this.viewBlend - targetView) < 2e-3 && Math.abs(this.viewBlendVel) < 8e-3) {
        this.viewBlend = targetView;
        this.viewBlendVel = 0;
      }
    }
    const vb = this.viewBlend;

    // 2. Construct locked `(yaw, pitch)` orientation (`YXZ`, zero horizon wobble!).
    const bank = input.bankRoll ? Math.max(-0.04, Math.min(0.04, input.bankRoll)) : 0;
    this.euler.set(input.pitch, input.yaw, bank, 'YXZ');
    this.localQuat.setFromEuler(this.euler);

    // Stage-local forward (`-Z` in Three camera convention) and right (`+X`).
    this.forwardStage.set(0, 0, -1).applyQuaternion(this.localQuat).normalize();
    this.rightStage.set(1, 0, 0).applyQuaternion(this.localQuat);
    this.rightStage.y = 0;
    if (this.rightStage.lengthSq() > 1e-6) this.rightStage.normalize();
    else this.rightStage.set(Math.cos(input.yaw), 0, -Math.sin(input.yaw));

    // 3. Zero-lag anatomical 1P eye anchor & damped 3P shoulder-head pivot anchor.
    const baseY = Number.isFinite(input.smoothedRootY) ? input.smoothedRootY : input.rootStagePos.y;
    const speed = input.planarSpeed ?? 0;
    const targetBob =
      !input.reducedMotion && speed > 0.15 && input.stridePhase !== undefined
        ? Math.cos(input.stridePhase * 2) * Math.min(0.0035, speed * 0.0014) * (1 - vb * 0.75)
        : 0;
    this.strideBobSmoothed += (targetBob - this.strideBobSmoothed) * (1 - Math.exp(-16 * dt));

    const eye1PY = baseY + input.eyeHeight + this.strideBobSmoothed;
    const pivot3PY = baseY + input.eyeHeight * 0.91;

    // 1st-person forward stoop + subtle natural cervical nod (`horizDistCamToRoot ~ 0.12..0.156 m`)
    // so looking down (`pitch = -1.1 rad`) clears the upper coat collar/lapels and frames lower torso, sleeves, hands, jeans, and shoes!
    const stoop = Math.max(0, Math.min(1.25, input.stoopRadians ?? 0));
    const lookDownDrop = input.pitch < -0.22 ? Math.min(0.042, (-input.pitch - 0.22) * 0.045) : 0;
    const raw1PDown = ((1 - Math.cos(stoop)) * 0.22 + lookDownDrop) * (1 - vb);

    if (input.eyeStagePos) {
      // `eyeStagePos` already sits at the live anatomical eye plane (`~0.095 m` ahead of spine); cap extra nod <= 0.056 m!
      this.stoopedEyeStage.set(
        input.eyeStagePos.x,
        input.eyeStagePos.y + this.strideBobSmoothed - raw1PDown,
        input.eyeStagePos.z,
      );
      const lookDownExtraFwd = input.pitch < -0.20 ? Math.min(0.038, (-input.pitch - 0.20) * 0.042) : 0;
      const extra1PFwd = (0.018 + Math.sin(stoop) * 0.34 + lookDownExtraFwd) * (1 - vb);
      if (extra1PFwd > 1e-4) {
        this.rayDirStage.set(-Math.sin(input.yaw), 0, -Math.cos(input.yaw)).normalize();
        const safe1PFwd = this.sweepSphereStage(
          this.stoopedEyeStage,
          this.rayDirStage,
          extra1PFwd,
          HEAD_SPHERE_RADIUS_1P,
          input.stageMatrixWorld,
          input.meshBlockers,
        );
        this.stoopedEyeStage.addScaledVector(this.rayDirStage, safe1PFwd);
      }
    } else {
      this.stoopedEyeStage.set(input.rootStagePos.x, eye1PY - raw1PDown, input.rootStagePos.z);
      const lookDownFallbackFwd = input.pitch < -0.20 ? Math.min(0.040, (-input.pitch - 0.20) * 0.044) : 0;
      const fallback1PFwd = (0.108 + Math.sin(stoop) * 0.34 + lookDownFallbackFwd) * (1 - vb);
      if (fallback1PFwd > 1e-4) {
        this.rayDirStage.set(-Math.sin(input.yaw), 0, -Math.cos(input.yaw)).normalize();
        const safe1PFwd = this.sweepSphereStage(
          this.stoopedEyeStage,
          this.rayDirStage,
          fallback1PFwd,
          HEAD_SPHERE_RADIUS_1P,
          input.stageMatrixWorld,
          input.meshBlockers,
        );
        this.stoopedEyeStage.addScaledVector(this.rayDirStage, safe1PFwd);
      }
    }

    // Separate 3rd-person shoulder-head pivot target (`0 -> shoulderOffset3P`), smoothly centered (`0.18 -> 0.04 m`)
    // when traversing narrow doorways (`corridorSpan < 1.15 m` or `nearDoorwayBlend > 0`) so jambs never whip the boom!
    this.pivot3PBaseStage.set(input.rootStagePos.x, pivot3PY, input.rootStagePos.z);
    const rawShoulder = input.shoulderOffset3P ?? 0.20;
    let targetShoulderScale = 1.0 - Math.max(0, Math.min(1, input.nearDoorwayBlend ?? 0)) * 0.78;
    if (vb > 0.05 && Math.abs(rawShoulder) > 0.045) {
      this.rayDirStage.copy(this.rightStage);
      const rightClear = this.sweepSphereStage(
        this.pivot3PBaseStage,
        this.rayDirStage,
        0.72,
        CAMERA_SPHERE_RADIUS,
        input.stageMatrixWorld,
        input.meshBlockers,
      );
      this.rayDirStage.copy(this.rightStage).negate();
      const leftClear = this.sweepSphereStage(
        this.pivot3PBaseStage,
        this.rayDirStage,
        0.72,
        CAMERA_SPHERE_RADIUS,
        input.stageMatrixWorld,
        input.meshBlockers,
      );
      const apertureSpan = leftClear + rightClear;
      if (apertureSpan < 1.18) {
        const minScale = Math.min(1.0, 0.04 / Math.max(0.04, Math.abs(rawShoulder)));
        const spanT = smoothstep(0.58, 1.18, apertureSpan);
        const probeScale = minScale + (1.0 - minScale) * spanT;
        if (probeScale < targetShoulderScale) targetShoulderScale = probeScale;
      }
    }
    if (input.reducedMotion) {
      this.shoulderCenterScale = targetShoulderScale;
      this.shoulderCenterVel = 0;
    } else {
      stepCriticallyDamped1D(
        this.shoulderCenterScale,
        this.shoulderCenterVel,
        targetShoulderScale,
        SHOULDER_CENTER_OMEGA,
        dt,
        this.scratch1D,
      );
      this.shoulderCenterScale = Math.max(0.18, Math.min(1.0, this.scratch1D.value));
      this.shoulderCenterVel = this.scratch1D.velocity;
    }

    const wantShoulder = rawShoulder * this.shoulderCenterScale * vb;
    if (Math.abs(wantShoulder) > 1e-4) {
      const sSign = wantShoulder >= 0 ? 1 : -1;
      this.rayDirStage.copy(this.rightStage).multiplyScalar(sSign);
      const safeShoulder = this.sweepSphereStage(
        this.pivot3PBaseStage,
        this.rayDirStage,
        Math.abs(wantShoulder),
        CAMERA_SPHERE_RADIUS,
        input.stageMatrixWorld,
        input.meshBlockers,
      );
      this.targetPivotStage.copy(this.pivot3PBaseStage).addScaledVector(this.rayDirStage, safeShoulder);
    } else {
      this.targetPivotStage.copy(this.pivot3PBaseStage);
    }

    // Zero planar velocity lag in 1P (`vb = 0`) so sprinting/cycling NEVER pulls camera behind the spine,
    // while keeping critically damped 3D follow in 3P (`vb = 1`) and smooth C1 blending across dolly transitions.
    if (vb <= 1e-4 || input.reducedMotion) {
      this.pivotStage.copy(this.stoopedEyeStage);
      this.pivotSpring.snap(this.targetPivotStage);
    } else {
      const sprung3P = this.pivotSpring.step(
        this.targetPivotStage,
        PIVOT_OMEGA_PLANAR,
        PIVOT_OMEGA_VERTICAL,
        dt,
      );
      this.pivotStage.lerpVectors(this.stoopedEyeStage, sprung3P, vb);
    }

    // 4. Swept-sphere (`r_cam = 0.18 m`) boom obstruction along `-forwardStage`.
    const desiredBoom = Math.max(0, input.targetOrbitDistance) * vb;
    let safeBoom = desiredBoom;
    let centerCeilingBoom = desiredBoom;
    let doorwayApertureGrazing = false;
    let isObstructed = false;

    if (desiredBoom > 1e-4) {
      this.rayDirStage.copy(this.forwardStage).negate();
      this.sweepBoomStage(
        this.pivotStage,
        this.rayDirStage,
        desiredBoom,
        CAMERA_SPHERE_RADIUS,
        input.stageMatrixWorld,
        input.meshBlockers,
        this.boomSweepScratch,
      );
      const { centerDist, whiskerDist } = this.boomSweepScratch;
      doorwayApertureGrazing = centerDist > whiskerDist + 0.45;
      centerCeilingBoom = vb > 0.5 ? Math.max(MIN_THIRD_PERSON_BOOM * vb, centerDist) : centerDist;
      if (whiskerDist < desiredBoom - 1e-3) {
        isObstructed = true;
        safeBoom = vb > 0.5 ? Math.max(MIN_THIRD_PERSON_BOOM * vb, whiskerDist) : whiskerDist;
      }
    }

    // 5. Asymmetric boom spring (`omegaIn = 55` on solid walls, `omega = 22` on open-aperture lateral whisker graze,
    //    hard 1-frame ceiling strictly on `w === 0` `centerCeilingBoom`, `90 ms` hold, `omegaOut = 9.5`).
    if (isObstructed && input.viewMode === 'third' && vb > 0.95) {
      this.holdTimer = BOOM_HOLD_SECONDS;
    }
    if (input.reducedMotion || desiredBoom <= 1e-4) {
      this.currentBoom = safeBoom;
      this.boomVel = 0;
      this.holdTimer = 0;
    } else if (safeBoom < this.currentBoom - 1e-4) {
      const inOmega = doorwayApertureGrazing ? BOOM_OMEGA_DOORWAY_IN : BOOM_OMEGA_IN;
      stepCriticallyDamped1D(this.currentBoom, this.boomVel, safeBoom, inOmega, dt, this.scratch1D);
      this.currentBoom = Math.min(centerCeilingBoom + 0.012, this.scratch1D.value);
      this.boomVel = Math.min(0, this.scratch1D.velocity);
    } else {
      // Recovering outward after obstacle clears: wait out 90 ms hysteresis, then smooth `omegaOut = 9.5`.
      if (this.holdTimer > 0 && input.viewMode === 'third' && vb > 0.95) {
        this.holdTimer = Math.max(0, this.holdTimer - dt);
        this.boomVel = 0;
      } else {
        const outOmega = Math.abs(vb - targetView) > 0.02 ? VIEW_DOLLY_OMEGA : BOOM_OMEGA_OUT;
        stepCriticallyDamped1D(this.currentBoom, this.boomVel, safeBoom, outOmega, dt, this.scratch1D);
        this.currentBoom = this.scratch1D.value;
        this.boomVel = this.scratch1D.velocity;
      }
    }
    this.currentBoom = Math.max(0, this.currentBoom);

    // 6. Commit finalized world camera position, locked horizon quaternion, and smooth dolly FOV.
    this.camStage.copy(this.pivotStage).addScaledVector(this.forwardStage, -this.currentBoom);
    if (input.stageMatrixWorld) {
      this.camWorld.copy(this.camStage).applyMatrix4(input.stageMatrixWorld);
      input.stageMatrixWorld.decompose(this.pivotWorld, this.stageRotQuat, this.whiskerOrigin);
      camera.position.copy(this.camWorld);
      camera.quaternion.copy(this.stageRotQuat).multiply(this.localQuat);
      this.forwardWorld.copy(this.forwardStage).transformDirection(input.stageMatrixWorld).normalize();
    } else {
      camera.position.copy(this.camStage);
      camera.quaternion.copy(this.localQuat);
      this.forwardWorld.copy(this.forwardStage);
    }
    camera.up.copy(this.upStage);

    const fov1 = input.fovFirst ?? DEFAULT_FOV_FIRST;
    const fov3 = input.fovThird ?? DEFAULT_FOV_THIRD;
    const nextFov = fov1 + (fov3 - fov1) * vb;
    if (Math.abs(camera.fov - nextFov) > 1e-3) {
      camera.fov = nextFov;
      camera.updateProjectionMatrix();
    }

    // 7. 1st-Person head/collar self-occlusion & own-limb near-plane guard (`viewZ < 0.35 m`, `y > eyeY - 0.45 m`).
    // STRICTLY active only once settled inside the 1P eye socket (`currentBoom <= 0.055 m`, `vb <= 0.03`):
    // NEVER hide only the head while the boom is still behind the player (`>= 0.055 m`), preventing any headless back!
    const settledFirstPerson =
      input.viewMode === 'first' &&
      this.currentBoom <= FIRST_PERSON_SETTLED_BOOM &&
      vb <= 0.03;
    const ownViewHeadHidden = settledFirstPerson;
    this.lastGuardDesired = ownViewHeadHidden;
    let ownLimbNearClipped = false;
    if (ownViewHeadHidden) {
      this.ownLimbUniforms.uOwnLimbGuardActive.value = 1;
      this.ownLimbUniforms.uOwnLimbEyeWorld.value.copy(camera.position);
      this.ownLimbUniforms.uOwnLimbForwardWorld.value.copy(this.forwardWorld);
      if (input.ownLowerLimbWorldPoints && input.ownLowerLimbWorldPoints.length > 0) {
        evaluateOwnLimbNearPlaneGuard(
          camera.position,
          this.forwardWorld,
          input.ownLowerLimbWorldPoints,
          this.limbCheck,
        );
        ownLimbNearClipped = this.limbCheck.occluded;
      }
    } else {
      this.ownLimbUniforms.uOwnLimbGuardActive.value = 0;
    }

    // Clean 1P <-> 3P crossover (`0.055 < currentBoom < 0.42`) & 3P tight-corner squeeze (`< 0.30 m`):
    // hide the entire avatar cleanly across the skull/collar boundary rather than clipping inside the head or showing a headless back.
    const inDollySkullBand =
      (this.currentBoom > FIRST_PERSON_SETTLED_BOOM && this.currentBoom < DOLLY_CROSSOVER_OUTER_BOOM) ||
      (input.viewMode === 'first' && !settledFirstPerson && this.currentBoom < DOLLY_CROSSOVER_OUTER_BOOM) ||
      (input.viewMode === 'third' && this.currentBoom < MIN_THIRD_PERSON_CORNER_BOOM);
    const characterVisible = !inDollySkullBand && !ownLimbNearClipped;
    const avatarOpacity = ownViewHeadHidden ? 1.0 : smoothstep(0.26, 0.50, this.currentBoom);

    return {
      viewBlend: vb,
      currentBoom: this.currentBoom,
      safeBoom,
      obstructed: isObstructed,
      ownViewHeadHidden,
      characterVisible,
      avatarOpacity,
      ownLimbNearClipped,
    };
  }
}
