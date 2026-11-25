/**
 * Physical Seat Validation and Multi-Slot Selection for Study Space and Echo Life.
 *
 * Pure mathematical and geometric predicates (zero Three.js, DOM, or WASM imports) so
 * unit tests, `affordances.ts`, `furnitureAnchors.ts`, `manipulation.ts`, and `engine.ts`
 * share one deterministic source of truth for:
 * 1. Upright orientation (`seatUp.y >= cos(15 deg)` and quaternion-derived horizontal forward yaw).
 * 2. Dynamic physics exclusion (rejects carried, pushed, or actively falling/tumbling bodies).
 * 3. Floor/base support (`|posY - floorY| <= 0.08 m`, rejecting chairs stacked on desks or beds).
 * 4. Cushion-volume obstruction (`[cx +- seatW*0.36, seatTopY + 0.02 .. seatTopY + 0.45, cz +- seatD*0.36]`).
 * 5. Front-hemisphere walkable approach filtering (`cos(angle - forwardYaw) >= -0.20` for backed seats,
 *    strictly forbidding `PI` behind-the-backrest walk-throughs, verified walkable on the same storey).
 * 6. Multi-slot selection (`selectNearestSeatSlot`) nearest to crosshair `hitPoint` or player position.
 */

export const MAX_SEAT_TILT_DEG = 15;
export const MIN_SEAT_UPRIGHT_DOT = Math.cos((MAX_SEAT_TILT_DEG * Math.PI) / 180);
export const MAX_SEAT_FLOOR_GAP_M = 0.08;
export const MAX_APPROACH_STEP_DELTA_M = 0.28;
export const MIN_BACKED_APPROACH_COS = -0.20;

export type SeatInvalidReason =
  | 'tilted'
  | 'moving'
  | 'unsupported'
  | 'obstructed'
  | 'no_approach'
  | 'occupied';

export interface QuatLike {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export type QuatInput = QuatLike | readonly [number, number, number, number] | null | undefined;

export interface Vec2Like {
  readonly x: number;
  readonly z: number;
}

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Aabb3Like {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface SeatObstacleVolume {
  readonly id?: string;
  readonly box?: Aabb3Like;
  readonly aabb?: Aabb3Like;
}

export interface SeatSlotSpec {
  readonly id?: string;
  readonly x: number;
  readonly z: number;
  readonly y?: number;
  readonly rotY?: number;
  readonly activity?: 'study' | 'sit' | 'sleep' | 'relax' | 'read';
  readonly hasBackrest?: boolean;
}

export interface SelectedSeatSlot {
  readonly slotIndex: number;
  readonly slot: SeatSlotSpec;
  readonly sitPos: { x: number; y: number; z: number };
  readonly forwardYaw: number;
  readonly distSq: number;
}

export interface SeatValidationResult {
  readonly ok: boolean;
  readonly valid: boolean;
  readonly reason?: SeatInvalidReason;
  /** True when `uprightDot < MIN_SEAT_UPRIGHT_DOT` (> 15 deg tilt), eligible for `'right-upright'`. */
  readonly tipped: boolean;
  readonly uprightDot: number;
  readonly tiltDeg: number;
  readonly floorY: number;
  readonly seatTopY: number;
  readonly forwardYaw: number;
  readonly slotIndex: number;
  readonly sitPos: { x: number; y: number; z: number };
  readonly validApproaches: { x: number; y: number; z: number }[];
  readonly approaches: { x: number; y: number; z: number }[];
}

export interface SeatValidationInput {
  readonly id?: string;
  readonly pos: Vec3Like | readonly [number, number, number];
  readonly rotY?: number;
  readonly quat?: QuatInput;
  readonly scale?: number;
  /** Width (X) and depth (Z) of the seat piece in metres before `scale`. */
  readonly size?: readonly [number, number] | { readonly w: number; readonly d: number; readonly h?: number };
  /** Local height of the seat surface above the object base before `scale` (default `0.48 m`). */
  readonly seatHeightLocal?: number;
  /** Single or multi-slot local anchor specifications (`catalog.ts` `anchors ?? [anchor]`). */
  readonly slots?: readonly SeatSlotSpec[];
  /** True when the seat has a backrest blocking rear (`PI`) entry (default `true`). */
  readonly hasBackrest?: boolean;
  /** Floor elevation directly beneath the seat (`walkable.groundAt(x, z) ?? 0`). */
  readonly floorY?: number;
  /** Optional explicit dynamic-body motion predicate (`StudyPhysics` held / pushed / non-resting body). */
  readonly isMoving?: boolean | (() => boolean);
  /** Optional explicit base-support override (`false` when cantilevered off a ledge). */
  readonly isSupported?: boolean;
  /** Crosshair raycast hit or player position used to pick the closest available cushion slot. */
  readonly referencePoint?: Vec2Like | Vec3Like | null;
  /** Alias for `referencePoint` (crosshair raycast hit point on multi-slot furniture). */
  readonly hitPoint?: Vec2Like | Vec3Like | null;
  /** Occupied slot indices or IDs (`npc` or peer player claims). */
  readonly occupiedSlots?: ReadonlySet<number | string> | null;
  /** World/stage AABBs of other room objects checked against the cushion volume above the seat. */
  readonly obstacles?: Iterable<SeatObstacleVolume> | null;
  /** Explicit candidate stand points; when omitted, front-hemisphere arc candidates are generated. */
  readonly candidateApproaches?: readonly (Vec2Like | Vec3Like)[];
  /** Walkability predicate (`RoomNavigation.free` / `LifeWalk.free` / `StudyPhysics.actorFits`). */
  readonly isWalkable?: (pt: { x: number; z: number; y: number }) => boolean;
  /** Floor elevation sampler at approach candidate `(x, z)` for same-storey check (`<= 0.28 m`). */
  readonly groundAt?: (x: number, z: number) => number | null | undefined;
}

const DEFAULT_FRONT_APPROACH_ANGLES = [
  0,
  0.40,
  -0.40,
  0.82,
  -0.82,
  Math.PI * 0.5,
  -Math.PI * 0.5,
  1.72,
  -1.72,
] as const;

const OPEN_360_APPROACH_ANGLES = [
  ...DEFAULT_FRONT_APPROACH_ANGLES,
  2.35,
  -2.35,
  Math.PI,
] as const;

const DEFAULT_APPROACH_RADII = [0.62, 0.74, 0.86, 0.52] as const;

const DEFAULT_SLOT: SeatSlotSpec = { x: 0, z: 0, y: 0, rotY: 0, activity: 'sit', hasBackrest: true };

export function wrapAngleRad(angle: number): number {
  let a = angle % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function normalizeQuat(quat: QuatInput): { qx: number; qy: number; qz: number; qw: number } | null {
  if (!quat) return null;
  const rawX = Array.isArray(quat) ? quat[0] : (quat as QuatLike).x;
  const rawY = Array.isArray(quat) ? quat[1] : (quat as QuatLike).y;
  const rawZ = Array.isArray(quat) ? quat[2] : (quat as QuatLike).z;
  const rawW = Array.isArray(quat) ? quat[3] : (quat as QuatLike).w;
  if (!Number.isFinite(rawX + rawY + rawZ + rawW)) return null;
  const len = Math.hypot(rawX, rawY, rawZ, rawW);
  if (len < 1e-8) return null;
  return { qx: rawX / len, qy: rawY / len, qz: rawZ / len, qw: rawW / len };
}

function readPos(pos: Vec3Like | readonly [number, number, number]): { x: number; y: number; z: number } {
  if (Array.isArray(pos)) {
    return { x: pos[0], y: pos[1], z: pos[2] };
  }
  const v = pos as Vec3Like;
  return { x: v.x, y: v.y, z: v.z };
}

/**
 * Computes `worldUp · seatUp = 1 - 2 * (qx^2 + qz^2)` in `[-1, 1]` from a full quaternion.
 * Returns `1` when `quat` is null/undefined (pure Y-yaw upright placement).
 */
export function computeSeatUpDot(quat?: QuatInput): number {
  const n = normalizeQuat(quat);
  if (!n) return 1;
  const upY = 1 - 2 * (n.qx * n.qx + n.qz * n.qz);
  return Math.max(-1, Math.min(1, upY));
}

/**
 * Returns `true` when an object's local `+Y` axis is tilted beyond `MAX_SEAT_TILT_DEG` (`15 deg`).
 */
export function isObjectTipped(quat?: QuatInput, minUprightDot = MIN_SEAT_UPRIGHT_DOT): boolean {
  return computeSeatUpDot(quat) < minUprightDot;
}

/**
 * Extracts the true horizontal forward yaw (`atan2(fwd.x, fwd.z) + anchorRotY`) by rotating local `+Z`
 * through the full quaternion `quat`, falling back to `fallbackRotY` only when `quat` is absent or singular.
 */
export function extractHorizontalForwardYaw(
  quat?: QuatInput,
  fallbackRotY = 0,
  anchorRotY = 0,
): number {
  const n = normalizeQuat(quat);
  if (!n) return wrapAngleRad(fallbackRotY + anchorRotY);
  const fwdX = 2 * (n.qx * n.qz + n.qw * n.qy);
  const fwdZ = 1 - 2 * (n.qx * n.qx + n.qy * n.qy);
  const horiz = Math.hypot(fwdX, fwdZ);
  const baseYaw = horiz > 1e-5 ? Math.atan2(fwdX, fwdZ) : fallbackRotY;
  return wrapAngleRad(baseYaw + anchorRotY);
}

/** Transforms local offset `(lx, ly, lz)` by `(pos, quat ?? rotY, scale)` without allocating Three.js matrices. */
export function transformSeatLocalPoint(
  lx: number,
  ly: number,
  lz: number,
  pos: { x: number; y: number; z: number },
  rotY = 0,
  quat?: QuatInput,
  scale = 1,
): { x: number; y: number; z: number } {
  const sx = lx * scale;
  const sy = ly * scale;
  const sz = lz * scale;
  const n = normalizeQuat(quat);
  if (n) {
    const { qx, qy, qz, qw } = n;
    const ix = qw * sx + qy * sz - qz * sy;
    const iy = qw * sy + qz * sx - qx * sz;
    const iz = qw * sz + qx * sy - qy * sx;
    const iw = -qx * sx - qy * sy - qz * sz;
    return {
      x: pos.x + ix * qw + iw * -qx + iy * -qz - iz * -qy,
      y: pos.y + iy * qw + iw * -qy + iz * -qx - ix * -qz,
      z: pos.z + iz * qw + iw * -qz + ix * -qy - iy * -qx,
    };
  }
  const s = Math.sin(rotY);
  const c = Math.cos(rotY);
  return {
    x: pos.x + sx * c + sz * s,
    y: pos.y + sy,
    z: pos.z - sx * s + sz * c,
  };
}

/**
 * Checks whether any foreign placed object's AABB overlaps the seat cushion volume
 * `[cx +- seatW*0.36, seatTopY + 0.02 .. seatTopY + 0.45, cz +- seatD*0.36]`.
 */
export function hasSeatVolumeObstruction(
  sitPos: Vec2Like,
  seatTopY: number,
  seatWidth: number,
  seatDepth: number,
  obstacles: Iterable<SeatObstacleVolume> | null | undefined,
  selfId?: string,
): boolean {
  if (!obstacles) return false;
  const hx = Math.max(0.12, seatWidth * 0.36);
  const hz = Math.max(0.12, seatDepth * 0.36);
  const minX = sitPos.x - hx;
  const maxX = sitPos.x + hx;
  const minY = seatTopY + 0.02;
  const maxY = seatTopY + 0.45;
  const minZ = sitPos.z - hz;
  const maxZ = sitPos.z + hz;

  for (const obs of obstacles) {
    if (selfId && obs.id === selfId) continue;
    const b = obs.box ?? obs.aabb;
    if (!b) continue;
    if (
      b.maxX > minX &&
      b.minX < maxX &&
      b.maxY > minY &&
      b.minY < maxY &&
      b.maxZ > minZ &&
      b.minZ < maxZ
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Filters approach stand points strictly to the front/side hemisphere (`cos(angle - forwardYaw) >= -0.20`
 * when `hasBackrest` is true — NEVER admitting `PI` behind a backrest!), verified walkable and same-storey.
 */
export function filterFrontHemisphereApproaches(opts: {
  readonly sitPos: Vec2Like;
  readonly forwardYaw: number;
  readonly floorY: number;
  readonly hasBackrest?: boolean;
  readonly candidates?: readonly (Vec2Like | Vec3Like)[];
  readonly isWalkable?: (pt: { x: number; z: number; y: number }) => boolean;
  readonly groundAt?: (x: number, z: number) => number | null | undefined;
}): { x: number; y: number; z: number }[] {
  const { sitPos, forwardYaw, floorY, hasBackrest = true, candidates, isWalkable, groundAt } = opts;
  const fwdX = Math.sin(forwardYaw);
  const fwdZ = Math.cos(forwardYaw);
  const out: { x: number; y: number; z: number }[] = [];

  const testPoint = (cx: number, cz: number, fallbackY: number) => {
    const dx = cx - sitPos.x;
    const dz = cz - sitPos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.24) return;
    if (hasBackrest) {
      const cosAng = (dx * fwdX + dz * fwdZ) / dist;
      if (cosAng < MIN_BACKED_APPROACH_COS) return;
    }
    const sampledY = groundAt ? groundAt(cx, cz) : fallbackY;
    if (sampledY === null || sampledY === undefined || !Number.isFinite(sampledY)) return;
    if (Math.abs(sampledY - floorY) > MAX_APPROACH_STEP_DELTA_M) return;
    if (isWalkable && !isWalkable({ x: cx, z: cz, y: sampledY })) return;
    out.push({ x: cx, y: sampledY, z: cz });
  };

  if (candidates && candidates.length > 0) {
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const cy = 'y' in c && typeof c.y === 'number' && Number.isFinite(c.y) ? c.y : floorY;
      testPoint(c.x, c.z, cy);
    }
    return out;
  }

  const angles = hasBackrest ? DEFAULT_FRONT_APPROACH_ANGLES : OPEN_360_APPROACH_ANGLES;
  for (let ri = 0; ri < DEFAULT_APPROACH_RADII.length; ri++) {
    const rad = DEFAULT_APPROACH_RADII[ri];
    for (let ai = 0; ai < angles.length; ai++) {
      const ang = forwardYaw + angles[ai];
      testPoint(sitPos.x + Math.sin(ang) * rad, sitPos.z + Math.cos(ang) * rad, floorY);
    }
  }
  return out;
}

/**
 * Selects the nearest unoccupied, unobstructed cushion slot on a single or multi-slot bench/sofa/bed
 * relative to crosshair `referencePoint` (or player body position).
 */
export function selectNearestSeatSlot(opts: {
  readonly id?: string;
  readonly pos: Vec3Like | readonly [number, number, number];
  readonly rotY?: number;
  readonly quat?: QuatInput;
  readonly scale?: number;
  readonly floorY?: number;
  readonly seatTopY: number;
  readonly slotWidth?: number;
  readonly slotDepth?: number;
  readonly slots: readonly SeatSlotSpec[];
  readonly referencePoint?: Vec2Like | Vec3Like | null;
  readonly hitPoint?: Vec2Like | Vec3Like | null;
  readonly occupiedSlots?: ReadonlySet<number | string> | null;
  readonly obstacles?: Iterable<SeatObstacleVolume> | null;
}): { selected: SelectedSeatSlot | null; anyUnoccupied: boolean } {
  const basePos = readPos(opts.pos);
  const rotY = opts.rotY ?? 0;
  const scale = opts.scale ?? 1;
  const floorY = opts.floorY ?? basePos.y;
  const slotList = opts.slots.length > 0 ? opts.slots : [DEFAULT_SLOT];
  const slotW = opts.slotWidth ?? 0.52 * scale;
  const slotD = opts.slotDepth ?? 0.52 * scale;
  const refPt = opts.referencePoint ?? opts.hitPoint ?? null;

  let best: SelectedSeatSlot | null = null;
  let anyUnoccupied = false;

  for (let i = 0; i < slotList.length; i++) {
    const slot = slotList[i];
    if (opts.occupiedSlots && (opts.occupiedSlots.has(i) || (slot.id !== undefined && opts.occupiedSlots.has(slot.id)))) {
      continue;
    }
    anyUnoccupied = true;
    const worldPt = transformSeatLocalPoint(slot.x, 0, slot.z, basePos, rotY, opts.quat, scale);
    const sitPos = { x: worldPt.x, y: floorY, z: worldPt.z };
    if (hasSeatVolumeObstruction(sitPos, opts.seatTopY, slotW, slotD, opts.obstacles, opts.id)) {
      continue;
    }
    const forwardYaw = extractHorizontalForwardYaw(opts.quat, rotY, slot.rotY ?? 0);
    const dx = refPt ? refPt.x - sitPos.x : 0;
    const dz = refPt ? refPt.z - sitPos.z : 0;
    const distSq = dx * dx + dz * dz;
    if (!best || distSq < best.distSq) {
      best = { slotIndex: i, slot, sitPos, forwardYaw, distSq };
    }
  }

  return { selected: best, anyUnoccupied };
}

/**
 * Pure 5-stage physical seat validator for Study Space chairs, sofas, beds, and Echo Life benches.
 */
export function validateSeatObject(input: SeatValidationInput): SeatValidationResult {
  const pos = readPos(input.pos);
  const rotY = input.rotY ?? 0;
  const scale = input.scale ?? 1;
  const floorY = input.floorY ?? 0;
  const seatHeightLocal = input.seatHeightLocal ?? 0.48;
  const slots = input.slots && input.slots.length > 0 ? input.slots : [DEFAULT_SLOT];
  const primarySlot = slots[0];

  const uprightDot = computeSeatUpDot(input.quat);
  const tiltDeg = (Math.acos(Math.max(-1, Math.min(1, uprightDot))) * 180) / Math.PI;
  const tipped = uprightDot < MIN_SEAT_UPRIGHT_DOT;
  const fallbackForwardYaw = extractHorizontalForwardYaw(input.quat, rotY, primarySlot.rotY ?? 0);
  const topWorld = transformSeatLocalPoint(0, seatHeightLocal, 0, pos, rotY, input.quat, scale);
  const seatTopY = topWorld.y;
  const defaultSitWorld = transformSeatLocalPoint(primarySlot.x, 0, primarySlot.z, pos, rotY, input.quat, scale);
  const fallbackSitPos = { x: defaultSitWorld.x, y: floorY, z: defaultSitWorld.z };
  const emptyApproaches: { x: number; y: number; z: number }[] = [];

  const fail = (
    reason: SeatInvalidReason,
    isTipped: boolean,
    forwardYaw = fallbackForwardYaw,
    slotIndex = 0,
    sitPos = fallbackSitPos,
  ): SeatValidationResult => ({
    ok: false,
    valid: false,
    reason,
    tipped: isTipped,
    uprightDot,
    tiltDeg,
    floorY,
    seatTopY,
    forwardYaw,
    slotIndex,
    sitPos,
    validApproaches: emptyApproaches,
    approaches: emptyApproaches,
  });

  // 1. Orientation check: reject tilted / tipped / inverted chairs (> 15 deg from world up).
  if (tipped) {
    return fail('tilted', true);
  }

  // 2. Dynamic physics state check: reject carried, pushed, or actively falling/tumbling bodies.
  const moving = typeof input.isMoving === 'function' ? input.isMoving() : Boolean(input.isMoving);
  if (moving) {
    return fail('moving', false);
  }

  // 3. Floor support check: reject chairs perched on desks/beds/shelves or floating > 8 cm off floor.
  if (input.isSupported === false || Math.abs(pos.y - floorY) > MAX_SEAT_FLOOR_GAP_M) {
    return fail('unsupported', false);
  }

  // 4. Multi-slot occupancy & cushion-volume obstruction check.
  const sizeW = Array.isArray(input.size) ? input.size[0] : (input.size as { w: number } | undefined)?.w ?? 0.56;
  const sizeD = Array.isArray(input.size) ? input.size[1] : (input.size as { d: number } | undefined)?.d ?? 0.56;
  const rawW = sizeW * scale;
  const rawD = sizeD * scale;
  const slotWidth = slots.length > 1 ? Math.max(0.42, rawW / slots.length) : rawW;
  const { selected, anyUnoccupied } = selectNearestSeatSlot({
    id: input.id,
    pos,
    rotY,
    quat: input.quat,
    scale,
    floorY,
    seatTopY,
    slotWidth,
    slotDepth: rawD,
    slots,
    referencePoint: input.referencePoint ?? input.hitPoint,
    occupiedSlots: input.occupiedSlots,
    obstacles: input.obstacles,
  });

  if (!anyUnoccupied) {
    return fail('occupied', false);
  }

  if (!selected) {
    return fail('obstructed', false);
  }

  // 5. Front-hemisphere walkable approach check (never behind backrest, verified walkable & same-storey).
  const hasBackrest = selected.slot.hasBackrest ?? input.hasBackrest ?? true;
  const validApproaches = filterFrontHemisphereApproaches({
    sitPos: selected.sitPos,
    forwardYaw: selected.forwardYaw,
    floorY,
    hasBackrest,
    candidates: input.candidateApproaches,
    isWalkable: input.isWalkable,
    groundAt: input.groundAt,
  });

  if (validApproaches.length === 0) {
    return fail('no_approach', false, selected.forwardYaw, selected.slotIndex, selected.sitPos);
  }

  return {
    ok: true,
    valid: true,
    tipped: false,
    uprightDot,
    tiltDeg,
    floorY,
    seatTopY,
    forwardYaw: selected.forwardYaw,
    slotIndex: selected.slotIndex,
    sitPos: selected.sitPos,
    validApproaches,
    approaches: validApproaches,
  };
}
