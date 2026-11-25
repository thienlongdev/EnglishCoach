/**
 * Echo Life — Pure Deterministic Layout, Height-Banded Solid Colliders, and Verified Seat Anchors
 * for Wave 11 Interior and Sidewalk Storefront Props.
 *
 * Zero Three.js / DOM / WASM imports so both simulation data (`buildings.ts`, `city.ts`, `walk.ts`,
 * `nav.ts`, `people.ts`, `crowd.ts`, `playerCollision.ts`) and 3D view builders (`buildingsView.ts`)
 * share one byte-exact source of truth:
 * - 67 height-banded `Block` colliders (`topRel < 0.95 m` -> `PLAYER_R_LOW = 0.20 m`;
 *   `topRel >= 0.95 m` -> `PLAYER_R_HIGH = 0.26 m`).
 * - 35 verified `AaaSeatSpec` anchors across University Library 1F/2F (15), Pixel Cafe interior (8),
 *   and sidewalk patios outside Pixel Cafe, Willow Bistro, and Riverside Atelier (12).
 */
import { GROUND_Y, WALL, rect as r, type Block, type Rect } from './plan';

export type AaaPropId =
  | 'libBookstackTall'
  | 'libReadingChair'
  | 'libArmchair'
  | 'libBankerLamp'
  | 'libRugWoven'
  | 'libPottedPlant'
  | 'libCeilingPendant'
  | 'cafeBistroSet'
  | 'awningStriped'
  | 'chalkboard'
  | 'airconUnit';

export interface AaaPropPlacementSpec {
  id: AaaPropId;
  x: number;
  y: number;
  z: number;
  rotY: number;
  scale?: number | readonly [number, number, number];
  castShadow?: boolean;
  /** True when the visual prop is omitted on `'low'` quality while its collider stays tier-invariant. */
  hideOnLowTier?: boolean;
}

export interface AaaSeatSpec {
  id: string;
  /** Canonical V3 zone ID (`'library'`, `'cafe'`, `'street'`). */
  zone: 'library' | 'cafe' | 'street';
  /** Disambiguated floor sub-zone (`'library:main'`, `'library:upper'`, `'cafe:main'`, `'street'`). */
  floorZone: string;
  sit: { x: number; y: number; z: number };
  yaw: number;
  /** Measured world Y of the chair cushion / wooden slat top surface. */
  top: number;
  /** True for chairs tucked facing a reading or bistro table (prefers lateral +-90 deg pull-out stand points). */
  tableTucked: boolean;
}

export interface BuildingAaaLayout {
  exteriorProps: AaaPropPlacementSpec[];
  interiorProps: AaaPropPlacementSpec[];
  /** Height-banded solid blocks (`exterior: true` for sidewalk patio sets and menu chalkboards). */
  blocks: Block[];
  /** Usable seats inside or on the sidewalk patio of this building. */
  seats: AaaSeatSpec[];
}

/**
 * Canonical park/street bench 3-slot geometry matching `STREET_PROPS.bench`
 * (`prop-bench-7e551133a507.glb` faces `+Z`; `yawOffset: 0`, `scaleVec: [1.32, 0.92, 0.95]`,
 * backrest `~0.78-0.82 m`, seat plank top `+0.44 m`, 3 slots `[-0.58, 0, 0.58] m`, `+0.05 m` forward).
 */
export const STREET_BENCH_SEAT_GEOMETRY = {
  yawOffset: 0,
  width: 1.54,
  depth: 0.47,
  seatTopOffset: 0.44,
  slotLateralOffsets: [-0.58, 0, 0.58] as const,
  pairLateralOffsets: [-0.58, 0, 0.58] as const,
  forwardOffset: 0.05,
  standDist: 0.64,
} as const;

/**
 * Canonical bus shelter 3-slot cedar bench geometry matching `STREET_PROPS.busShelter`
 * (`prop_bus_shelter_aaa-16ed1e762011.glb`, `[3.8, 2.525, 1.875]`, rear cedar bench slats at `-0.28 m`,
 * 3 slots `[-0.75, 0, 0.75] m`, seat top `+0.45 m`, clear interior approach at `0.66 m`).
 */
export const BUS_SHELTER_SEAT_GEOMETRY = {
  yawOffset: 0,
  width: 3.8,
  depth: 1.875,
  seatTopOffset: 0.45,
  slotLateralOffsets: [-0.75, 0, 0.75] as const,
  forwardOffset: -0.28,
  standDist: 0.66,
} as const;

/**
 * Canonical Botanical Garden vine pergola 2-slot bench geometry matching `STREET_PROPS.pergolaVine`
 * (`prop_pergola_vine_aaa-8b29dd32dafe.glb`, `[5.08, 2.98, 5.15]`, 2 shaded bench slots `[-0.65, 0.65] m`).
 */
export const PERGOLA_BENCH_SEAT_GEOMETRY = {
  yawOffset: 0,
  width: 5.08,
  depth: 5.15,
  seatTopOffset: 0.45,
  slotLateralOffsets: [-0.65, 0.65] as const,
  forwardOffset: 0.0,
  standDist: 0.72,
} as const;

/**
 * Canonical `patio-set` -> `cafeBistroSet` (`prop_cafe_bistro_set_aaa-c55d3be288fb.glb`) geometry:
 * raw span `[0.74, 0.855, 1.716]`, chair A at `-0.41 * s` (`yaw = rotY`), chair B at `+0.40 * s` (`yaw = rotY + PI`),
 * wooden slat seat top at `0.435 * s`.
 */
export const PATIO_BISTRO_SEAT_GEOMETRY = {
  spanDenom: 1.72,
  chairAOffset: -0.41,
  chairBOffset: 0.40,
  seatTopFactor: 0.435,
  standDist: 0.62,
} as const;

/** Front/side-hemisphere stand angles (`cos(angle) >= -0.20`, strictly excluding `PI` behind a backrest). */
export const OPEN_SEAT_STAND_ANGLES = [
  0,
  0.35,
  -0.35,
  0.75,
  -0.75,
  Math.PI * 0.5,
  -Math.PI * 0.5,
  1.72,
  -1.72,
] as const;

/** Lateral-first pull-out angles (`+-90 deg` beside the chair) so `stand` never lands inside a solid table. */
export const TABLE_TUCKED_STAND_ANGLES = [
  Math.PI * 0.5,
  -Math.PI * 0.5,
  2.15,
  -2.15,
  0.48,
  -0.48,
  Math.PI,
  0,
] as const;

export const SEAT_STAND_DISTS = [0.54, 0.66, 0.78, 0.90] as const;

/** Resolves a verified walkable `stand` approach point for an `AaaSeatSpec` or public seat. */
export function resolveSeatStandPoint(
  seat: Pick<AaaSeatSpec, 'sit' | 'yaw' | 'tableTucked'>,
  isFree: (p: { x: number; z: number }) => boolean,
  preferredDist = 0.66,
): { x: number; y: number; z: number } | null {
  const angles = seat.tableTucked ? TABLE_TUCKED_STAND_ANGLES : OPEN_SEAT_STAND_ANGLES;
  const dists = seat.tableTucked
    ? SEAT_STAND_DISTS
    : [preferredDist, 0.54, 0.78, 0.90];
  for (let i = 0; i < angles.length; i++) {
    const a = seat.yaw + angles[i];
    const fx = Math.sin(a);
    const fz = Math.cos(a);
    for (let j = 0; j < dists.length; j++) {
      const dist = dists[j];
      const x = seat.sit.x + fx * dist;
      const z = seat.sit.z + fz * dist;
      if (isFree({ x, z })) {
        return { x, y: seat.sit.y, z };
      }
    }
  }
  return null;
}

const AWNING_SHOP_BUILDINGS = new Set([
  'cafe',
  'bistro',
  'market',
  'electronics_shop',
  'furniture_shop',
  'clothing_shop',
  'home_center',
  'atelier',
]);
const CAFE_PATIO_BUILDINGS = new Set(['cafe', 'bistro', 'atelier']);
const CHALKBOARD_BUILDINGS = new Set([
  'cafe',
  'bistro',
  'market',
  'clothing_shop',
  'furniture_shop',
  'atelier',
]);
const AIRCON_BUILDINGS = new Set([
  'cafe',
  'bistro',
  'market',
  'electronics_shop',
  'clothing_shop',
  'repair_shop',
]);

function rotatedAabb(cx: number, cz: number, halfW: number, halfD: number, rotY: number): Rect {
  const c = Math.abs(Math.cos(rotY));
  const s = Math.abs(Math.sin(rotY));
  const hx = halfW * c + halfD * s;
  const hz = halfW * s + halfD * c;
  return r(cx - hx, cx + hx, cz - hz, cz + hz);
}

function scaleTuple(
  scale: number | readonly [number, number, number] | undefined,
): readonly [number, number, number] {
  if (scale === undefined) return [1, 1, 1];
  if (typeof scale === 'number') return [scale, scale, scale];
  return scale;
}

export function buildBuildingAaaLayout(b: {
  id: string;
  rect: Rect;
  facing: 'north' | 'south';
  twoStorey?: boolean;
}): BuildingAaaLayout {
  const exteriorProps: AaaPropPlacementSpec[] = [];
  const interiorProps: AaaPropPlacementSpec[] = [];
  const blocks: Block[] = [];
  const seats: AaaSeatSpec[] = [];

  const ix0 = b.rect.x0 + WALL;
  const ix1 = b.rect.x1 - WALL;
  const iz0 = b.rect.z0 + WALL;
  const iz1 = b.rect.z1 - WALL;
  const bcx = (ix0 + ix1) * 0.5;
  const bcz = (iz0 + iz1) * 0.5;
  const doorX = bcx;
  const roofY = b.twoStorey ? GROUND_Y + 2.6 + 3.0 : GROUND_Y + 3.35;

  const frontFaceZ = b.facing === 'north' ? b.rect.z0 : b.rect.z1;
  const frontOut = b.facing === 'north' ? -1 : 1;
  const awningZ = frontFaceZ + frontOut * 0.04;
  const awningRotY = b.facing === 'north' ? Math.PI : 0;

  const addBookstack = (
    label: string,
    zone: string,
    x: number,
    y: number,
    z: number,
    rotY: number,
    scale: readonly [number, number, number],
  ) => {
    interiorProps.push({ id: 'libBookstackTall', x, y, z, rotY, scale });
    const [sx, sy, sz] = scale;
    // Raw GLB: [2.092, 2.550, 0.560] -> tall opaque shelf (`topRel >= 2.30 m` -> `PLAYER_R_HIGH = 0.26 m`).
    blocks.push({
      rect: rotatedAabb(x, z, 1.046 * sx, 0.28 * sz, rotY),
      zone,
      label,
      y,
      topRel: 2.55 * sy,
      cameraOccluder: true,
    });
  };

  const addReadingChair = (
    seatId: string,
    zone: 'library',
    floorZone: string,
    x: number,
    y: number,
    z: number,
    rotY: number,
  ) => {
    interiorProps.push({ id: 'libReadingChair', x, y, z, rotY });
    // Raw GLB: [0.500, 0.850, 0.520], cushion top y = 0.450 m (`topRel = 0.85 < 0.95` -> `PLAYER_R_LOW = 0.20 m`).
    blocks.push({
      rect: r(x - 0.24, x + 0.24, z - 0.24, z + 0.24),
      zone: floorZone,
      label: seatId,
      y,
      topRel: 0.85,
    });
    const fx = Math.sin(rotY);
    const fz = Math.cos(rotY);
    seats.push({
      id: seatId,
      zone,
      floorZone,
      sit: { x: x + fx * 0.03, y, z: z + fz * 0.03 },
      yaw: rotY,
      top: y + 0.45,
      tableTucked: true,
    });
  };

  const addArmchair = (
    seatId: string,
    zone: 'library' | 'cafe',
    floorZone: string,
    x: number,
    y: number,
    z: number,
    rotY: number,
  ) => {
    interiorProps.push({ id: 'libArmchair', x, y, z, rotY });
    // Raw GLB: [0.820, 0.850, 0.822], cushion top y = 0.448 m (`topRel = 0.85 < 0.95` -> `PLAYER_R_LOW = 0.20 m`).
    blocks.push({
      rect: rotatedAabb(x, z, 0.39, 0.39, rotY),
      zone: floorZone,
      label: seatId,
      y,
      topRel: 0.85,
    });
    const fx = Math.sin(rotY);
    const fz = Math.cos(rotY);
    seats.push({
      id: seatId,
      zone,
      floorZone,
      sit: { x: x + fx * 0.04, y, z: z + fz * 0.04 },
      yaw: rotY,
      top: y + 0.448,
      tableTucked: false,
    });
  };

  const addPottedPlant = (
    label: string,
    zone: string,
    x: number,
    y: number,
    z: number,
    rotY: number,
    scale?: number,
  ) => {
    interiorProps.push({ id: 'libPottedPlant', x, y, z, rotY, scale });
    const [sx, sy, sz] = scaleTuple(scale);
    // Ceramic pot base is 0.42 x 0.42 m while Ficus foliage rises 1.32 m (`topRel >= 1.12 m` -> `PLAYER_R_HIGH = 0.26 m`).
    blocks.push({
      rect: r(x - 0.21 * sx, x + 0.21 * sx, z - 0.21 * sz, z + 0.21 * sz),
      zone,
      label,
      y,
      topRel: 1.30 * sy,
    });
  };

  const addBistroSet = (
    prefix: string,
    zone: 'cafe' | 'street',
    floorZone: string,
    x: number,
    y: number,
    z: number,
    rotY: number,
    scale: number,
    exterior: boolean,
  ) => {
    if (exterior) {
      exteriorProps.push({
        id: 'cafeBistroSet',
        x,
        y,
        z,
        rotY,
        scale,
        castShadow: true,
      });
    } else {
      interiorProps.push({ id: 'cafeBistroSet', x, y, z, rotY, scale });
    }
    const fx = Math.sin(rotY);
    const fz = Math.cos(rotY);
    // Split into 2 compact half-set `R_low` blocks (`topRel = 0.85 < 0.95`) covering table + each chair cleanly.
    const halfOff = 0.365 * scale;
    for (const [tag, sign] of [['A', -1], ['B', 1]] as const) {
      const bx = x + fx * halfOff * sign;
      const bz = z + fz * halfOff * sign;
      blocks.push({
        rect: rotatedAabb(bx, bz, 0.33 * scale, 0.365 * scale, rotY),
        zone: floorZone,
        label: `${prefix}:${tag}`,
        y,
        topRel: 0.85 * scale,
        exterior,
      });
    }
    const dA = PATIO_BISTRO_SEAT_GEOMETRY.chairAOffset * scale;
    const dB = PATIO_BISTRO_SEAT_GEOMETRY.chairBOffset * scale;
    const cushionTop = y + PATIO_BISTRO_SEAT_GEOMETRY.seatTopFactor * scale;
    seats.push(
      {
        id: `${prefix}:A`,
        zone,
        floorZone,
        sit: { x: x + fx * dA, y, z: z + fz * dA },
        yaw: rotY,
        top: cushionTop,
        tableTucked: true,
      },
      {
        id: `${prefix}:B`,
        zone,
        floorZone,
        sit: { x: x + fx * dB, y, z: z + fz * dB },
        yaw: rotY + Math.PI,
        top: cushionTop,
        tableTucked: true,
      },
    );
  };

  // ── 1. Exterior Storefront Awnings, Sidewalk Patios, Menu Chalkboards, and Aircon Units ──
  if (AWNING_SHOP_BUILDINGS.has(b.id)) {
    const leftW = doorX - 1.1 - (ix0 + 0.5);
    const rightW = ix1 - 0.5 - (doorX + 1.1);
    if (leftW >= 1.6) {
      const lx = (ix0 + 0.5 + doorX - 1.1) * 0.5;
      const sx = Math.min(1.45, Math.max(0.75, (leftW + 0.35) / 2.66));
      exteriorProps.push({
        id: 'awningStriped',
        x: lx,
        y: GROUND_Y + 2.18,
        z: awningZ,
        rotY: awningRotY,
        scale: [sx, 0.92, 0.95],
        castShadow: true,
      });
    }
    if (rightW >= 1.6) {
      const rx = (doorX + 1.1 + ix1 - 0.5) * 0.5;
      const sx = Math.min(1.45, Math.max(0.75, (rightW + 0.35) / 2.66));
      exteriorProps.push({
        id: 'awningStriped',
        x: rx,
        y: GROUND_Y + 2.18,
        z: awningZ,
        rotY: awningRotY,
        scale: [sx, 0.92, 0.95],
        castShadow: true,
      });
    }
    if (CAFE_PATIO_BUILDINGS.has(b.id)) {
      exteriorProps.push({
        id: 'awningStriped',
        x: doorX,
        y: GROUND_Y + 2.22,
        z: awningZ,
        rotY: awningRotY,
        scale: [0.78, 0.88, 0.92],
        castShadow: true,
      });
    }
  }

  if (CAFE_PATIO_BUILDINGS.has(b.id)) {
    const patioZ = frontFaceZ + frontOut * 0.54;
    const leftPatioX = ix0 + 2.15;
    const rightPatioX = ix1 - 2.15;
    if (doorX - leftPatioX >= 2.4) {
      addBistroSet(
        `aaa:patio:${b.id}:L`,
        'street',
        'street',
        leftPatioX,
        GROUND_Y,
        patioZ,
        Math.PI * 0.5,
        0.92,
        true,
      );
    }
    if (rightPatioX - doorX >= 2.4) {
      addBistroSet(
        `aaa:patio:${b.id}:R`,
        'street',
        'street',
        rightPatioX,
        GROUND_Y,
        patioZ,
        Math.PI * 0.5,
        0.92,
        true,
      );
    }
  }

  if (CHALKBOARD_BUILDINGS.has(b.id)) {
    const boardZ = frontFaceZ + frontOut * 0.52;
    const boardX = doorX + 1.38;
    if (boardX < ix1 - 0.6) {
      const rotY = (b.facing === 'north' ? Math.PI : 0) + (b.facing === 'north' ? 0.26 : -0.26);
      exteriorProps.push({
        id: 'chalkboard',
        x: boardX,
        y: GROUND_Y,
        z: boardZ,
        rotY,
        scale: 0.92,
        castShadow: false,
        hideOnLowTier: true,
      });
      // Tier-invariant sidewalk A-frame chalkboard collider (`topRel = 0.99 >= 0.95` -> `PLAYER_R_HIGH = 0.26 m`).
      blocks.push({
        rect: rotatedAabb(boardX, boardZ, 0.25, 0.23, rotY),
        zone: 'street',
        label: `aaa:chalkboard:${b.id}`,
        y: GROUND_Y,
        topRel: 0.99,
        exterior: true,
      });
    }
  }

  if (AIRCON_BUILDINGS.has(b.id)) {
    const acZ = b.facing === 'north' ? b.rect.z1 - 1.35 : b.rect.z0 + 1.35;
    exteriorProps.push({
      id: 'airconUnit',
      x: b.rect.x1 + 0.14,
      y: GROUND_Y + 2.28,
      z: acZ,
      rotY: Math.PI * 0.5,
      scale: 0.84,
      castShadow: false,
      hideOnLowTier: true,
    });
  }

  // ── 2. Curated AAA Interior Props, Solid Colliders, and Verified Seats ──
  if (b.id === 'library') {
    const splitZ = iz0 + 4.0;
    const upperY = GROUND_Y + 2.6;
    const upperX0 = ix0 + 1.86;
    const upperZ1 = splitZ - 0.16;
    const upperCx = (upperX0 + ix1) * 0.5;

    // 11 tall walnut bookstacks (8 ground-floor + 3 2F mezzanine archive).
    const gallerySpan = ix1 - upperX0 - 1.2;
    const galleryStacks = 4;
    for (let i = 0; i < galleryStacks; i++) {
      const sx = upperX0 + 1.35 + (gallerySpan - 1.5) * (i / (galleryStacks - 1));
      addBookstack(
        `aaa:lib:stack:gal:${i}`,
        'library:main',
        sx,
        GROUND_Y,
        splitZ + 0.38,
        0,
        [1.0, 0.95, 0.95],
      );
    }
    addBookstack('aaa:lib:stack:east:0', 'library:main', ix1 - 0.38, GROUND_Y, iz1 - 1.55, Math.PI * 0.5, [1.0, 0.98, 0.95]);
    addBookstack('aaa:lib:stack:east:1', 'library:main', ix1 - 0.38, GROUND_Y, iz1 - 4.15, Math.PI * 0.5, [1.0, 0.98, 0.95]);
    addBookstack('aaa:lib:stack:east:2', 'library:main', ix1 - 0.38, GROUND_Y, splitZ + 1.45, Math.PI * 0.5, [1.0, 0.98, 0.95]);
    addBookstack('aaa:lib:stack:west:0', 'library:main', ix0 + 0.38, GROUND_Y, iz1 - 1.65, Math.PI * 0.5, [1.0, 0.98, 0.95]);

    addBookstack('aaa:lib:stack:2f:mid', 'library:upper', upperCx, upperY, iz0 + 0.38, 0, [1.04, 0.98, 0.95]);
    addBookstack('aaa:lib:stack:2f:east', 'library:upper', ix1 - 0.38, upperY, (iz0 + upperZ1) * 0.5, Math.PI * 0.5, [1.0, 0.98, 0.95]);
    addBookstack('aaa:lib:stack:2f:land', 'library:landing', ix0 + 0.92, upperY, iz0 + 0.38, 0, [0.78, 0.98, 0.9]);

    // 13 oak reading chairs (8 around 1F Tables A and B + 1 at Catalog Desk + 4 around 2F Mezzanine Study Table).
    const tableAX = ix1 - 2.8;
    const tableBX = ix0 + 5.0;
    const tableZ = iz1 - 6.8;
    let rIdx = 0;
    for (const tx of [tableAX, tableBX]) {
      for (const ox of [-0.52, 0.52]) {
        addReadingChair(`aaa:library:rchair1f:${rIdx++}`, 'library', 'library:main', tx + ox, GROUND_Y, tableZ - 0.76, 0);
        addReadingChair(`aaa:library:rchair1f:${rIdx++}`, 'library', 'library:main', tx + ox, GROUND_Y, tableZ + 0.76, Math.PI);
      }
    }
    addReadingChair('aaa:library:rchair1f:desk', 'library', 'library:main', bcx + 1.2, GROUND_Y, iz1 - 4.35, 0);

    const upTableZ = upperZ1 - 1.2;
    let uIdx = 0;
    for (const ox of [-0.52, 0.52]) {
      addReadingChair(`aaa:library:rchair2f:${uIdx++}`, 'library', 'library:upper', upperCx + ox, upperY, upTableZ - 0.72, 0);
      addReadingChair(`aaa:library:rchair2f:${uIdx++}`, 'library', 'library:upper', upperCx + ox, upperY, upTableZ + 0.68, Math.PI);
    }

    // 7 tabletop emerald-glass banker lamps (non-blocking tabletop elevation).
    const deskTopY = GROUND_Y + 0.76;
    interiorProps.push(
      { id: 'libBankerLamp', x: tableAX - 0.52, y: deskTopY, z: tableZ, rotY: Math.PI * 0.25 },
      { id: 'libBankerLamp', x: tableAX + 0.52, y: deskTopY, z: tableZ, rotY: -Math.PI * 0.75 },
      { id: 'libBankerLamp', x: tableBX - 0.52, y: deskTopY, z: tableZ, rotY: Math.PI * 0.25 },
      { id: 'libBankerLamp', x: tableBX + 0.52, y: deskTopY, z: tableZ, rotY: -Math.PI * 0.75 },
      { id: 'libBankerLamp', x: bcx + 1.92, y: GROUND_Y + 1.015, z: iz1 - 3.55, rotY: -Math.PI * 0.35 },
      { id: 'libBankerLamp', x: upperCx - 0.52, y: upperY + 0.76, z: upTableZ, rotY: Math.PI * 0.2 },
      { id: 'libBankerLamp', x: upperCx + 0.52, y: upperY + 0.76, z: upTableZ, rotY: -Math.PI * 0.8 },
    );

    // 2 flat woven area rugs (walk-over, 0 colliders).
    interiorProps.push(
      { id: 'libRugWoven', x: (tableAX + tableBX) * 0.5, y: GROUND_Y + 0.004, z: tableZ, rotY: 0, scale: [3.35, 1, 2.05] },
      { id: 'libRugWoven', x: ix0 + 2.9, y: GROUND_Y + 0.004, z: iz1 - 2.6, rotY: 0, scale: [1.35, 1, 1.15] },
    );

    // 2 cozy SW Lounge armchairs.
    addArmchair('aaa:library:armchair:0', 'library', 'library:main', ix0 + 1.55, GROUND_Y, iz1 - 4.05, Math.PI * 0.24);
    addArmchair('aaa:library:armchair:1', 'library', 'library:main', ix0 + 4.45, GROUND_Y, iz1 - 1.55, -Math.PI * 0.78);

    // 4 indoor potted Ficus plants (3 on 1F + 1 on 2F).
    addPottedPlant('aaa:lib:plant:0', 'library:main', doorX - 1.48, GROUND_Y, iz1 - 0.68, 0.4);
    addPottedPlant('aaa:lib:plant:1', 'library:main', doorX + 1.48, GROUND_Y, iz1 - 0.68, -0.5);
    addPottedPlant('aaa:lib:plant:2', 'library:main', ix0 + 2.42, GROUND_Y, splitZ + 3.85, 1.1);
    addPottedPlant('aaa:lib:plant:2f', 'library:upper', ix1 - 0.78, upperY, upperZ1 - 0.78, 2.2);

    // 5 overhead ceiling pendants (non-blocking overhead).
    const pendantY = roofY - 0.95;
    interiorProps.push(
      { id: 'libCeilingPendant', x: bcx - 3.6, y: pendantY, z: iz1 - 6.6, rotY: 0 },
      { id: 'libCeilingPendant', x: bcx, y: pendantY, z: iz1 - 6.6, rotY: 0 },
      { id: 'libCeilingPendant', x: bcx + 3.6, y: pendantY, z: iz1 - 6.6, rotY: 0 },
      { id: 'libCeilingPendant', x: bcx - 2.6, y: pendantY, z: iz1 - 3.1, rotY: 0 },
      { id: 'libCeilingPendant', x: bcx + 2.6, y: pendantY, z: iz1 - 3.1, rotY: 0 },
    );
  } else if (b.id === 'cafe') {
    interiorProps.push({
      id: 'libRugWoven',
      x: bcx - 0.2,
      y: GROUND_Y + 0.004,
      z: iz0 + 4.9,
      rotY: 0,
      scale: [2.15, 1, 1.75],
    });
    addBistroSet('aaa:cafe:bistro:0', 'cafe', 'cafe:main', bcx - 1.9, GROUND_Y, iz0 + 4.5, Math.PI * 0.5, 0.94, false);
    addBistroSet('aaa:cafe:bistro:1', 'cafe', 'cafe:main', bcx + 0.55, GROUND_Y, iz0 + 5.1, 0, 0.94, false);
    addBistroSet('aaa:cafe:bistro:2', 'cafe', 'cafe:main', ix1 - 2.25, GROUND_Y, iz0 + 2.25, Math.PI * 0.5, 0.92, false);

    addArmchair('aaa:cafe:armchair:0', 'cafe', 'cafe:main', ix0 + 1.65, GROUND_Y, iz0 + 1.85, Math.PI * 0.22);
    addArmchair('aaa:cafe:armchair:1', 'cafe', 'cafe:main', ix0 + 3.25, GROUND_Y, iz0 + 1.65, -Math.PI * 0.18);

    addBookstack('aaa:cafe:stack:0', 'cafe:main', bcx, GROUND_Y, iz1 - 0.38, Math.PI, [0.88, 0.92, 0.90]);

    addPottedPlant('aaa:cafe:plant:0', 'cafe:main', ix0 + 0.75, GROUND_Y, iz0 + 0.78, 0.5, 0.90);
    addPottedPlant('aaa:cafe:plant:1', 'cafe:main', ix1 - 0.75, GROUND_Y, iz0 + 0.78, -0.8, 0.90);
    addPottedPlant('aaa:cafe:plant:2', 'cafe:main', bcx - 1.35, GROUND_Y, iz1 - 0.72, 1.4, 0.86);
    addPottedPlant('aaa:cafe:plant:3', 'cafe:main', ix1 - 0.75, GROUND_Y, iz1 - 0.78, -1.2, 0.88);

    interiorProps.push(
      { id: 'libCeilingPendant', x: bcx - 2.3, y: roofY - 0.95, z: iz0 + 3.4, rotY: 0, scale: 0.88 },
      { id: 'libCeilingPendant', x: bcx + 2.3, y: roofY - 0.95, z: iz0 + 3.4, rotY: 0, scale: 0.88 },
      { id: 'libCeilingPendant', x: bcx - 2.3, y: roofY - 0.95, z: iz1 - 3.2, rotY: 0, scale: 0.88 },
      { id: 'libCeilingPendant', x: bcx + 2.3, y: roofY - 0.95, z: iz1 - 3.2, rotY: 0, scale: 0.88 },
    );
  } else if (b.id === 'bistro' || b.id === 'atelier') {
    const backZ = b.facing === 'north' ? iz1 - 0.78 : iz0 + 0.78;
    const frontInZ = b.facing === 'north' ? iz0 + 0.78 : iz1 - 0.78;
    addPottedPlant(`aaa:${b.id}:plant:0`, `${b.id}:main`, ix0 + 0.75, GROUND_Y, frontInZ, 0.5, 0.88);
    addPottedPlant(`aaa:${b.id}:plant:1`, `${b.id}:main`, ix1 - 0.75, GROUND_Y, backZ, -1.2, 0.88);
    interiorProps.push(
      { id: 'libCeilingPendant', x: bcx - 2.1, y: roofY - 0.95, z: bcz, rotY: 0, scale: 0.88 },
      { id: 'libCeilingPendant', x: bcx + 2.1, y: roofY - 0.95, z: bcz, rotY: 0, scale: 0.88 },
    );
    if (b.id === 'bistro') {
      interiorProps.push({
        id: 'libRugWoven',
        x: bcx,
        y: GROUND_Y + 0.004,
        z: iz0 + 4.0,
        rotY: 0,
        scale: [1.45, 1, 1.05],
      });
    }
  } else if (b.id === 'furniture_shop' || b.id === 'clothing_shop') {
    addPottedPlant(
      `aaa:${b.id}:plant:0`,
      `${b.id}:main`,
      ix0 + 0.82,
      GROUND_Y,
      b.facing === 'north' ? iz0 + 0.82 : iz1 - 0.82,
      0.3,
      0.92,
    );
    interiorProps.push({
      id: 'libRugWoven',
      x: bcx,
      y: GROUND_Y + 0.004,
      z: b.facing === 'north' ? iz0 + 4.3 : iz0 + 4.6,
      rotY: 0,
      scale: [1.6, 1, 1.2],
    });
  } else if (b.id === 'linh' || b.id === 'minh') {
    interiorProps.push({
      id: 'libRugWoven',
      x: bcx,
      y: GROUND_Y + 0.004,
      z: iz0 + 3.4,
      rotY: 0,
      scale: [1.25, 1, 1.05],
    });
  }

  return { exteriorProps, interiorProps, blocks, seats };
}
