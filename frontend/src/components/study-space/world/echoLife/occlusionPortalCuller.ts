/**
 * Echo Life — Zero-Alloc Analytical Outdoor Hi-Z Occlusion Culler & Indoor Window/Door Portal Frustum Culler.
 *
 * Pure Three.js math module (zero WASM, zero per-frame heap allocations, zero React/DOM dependencies):
 *
 * 1. `OutdoorHiZOcclusionCuller`:
 *    - L1-cache-resident 64x16 (`4 KB`) fine conservative depth buffer + 16x4 (`256 B`) coarse Hi-Z max-depth mip.
 *    - Selects up to 12 dominant front-facing static/registered opaque building occluders, clips each front-facing
 *      quad against near/far clip planes, and scan-converts strictly interior pixels with exact affine screen-space
 *      conservative depth (`zCellMax >= true_z_ndc` everywhere in the pixel cell).
 *    - Classifies world AABBs into `VIS_CULLED (0) | VIS_SHADOW_ONLY (1) | VIS_BOTH (2)` using sun-extruded shadow
 *      volumes (`sunDir.y >= 0.20`, matching `echoCsm.ts`) so objects behind tall 4-storey blocks can be culled cleanly
 *      before BOTH main pass and CSM cascades while never dropping cast shadows that extend onto visible streets.
 *
 * 2. `IndoorPortalFrustumCuller`:
 *    - Auto-extracts exact `ExteriorPortal` window and door quads from `buildings.ts` (`EnterableBuilding.walls`)
 *      and `plan.ts` (`HousePlan.walls` + Study Room window) across all 4 room sizes (`4, 6, 7.5, 9 m`).
 *    - Clips active windows and open doors (`isOpen || |angle| > 0.03`) to NDC and builds tight 6-plane sub-frusta
 *      directly from `viewProj` rows (`row0 - u0 * row3`, etc.) with zero matrix inversions.
 *    - Exposes explicit `keepSkyAndHorizon` (always `true` when any portal is visible so G-04 sky voids cannot occur)
 *      and `hideAllExterior` (`true` when `visiblePortalCount === 0` for instant zero-exterior-DC interior views).
 *
 * Target CPU budget: `< 0.08 ms` total per frame (typically `0.03–0.05 ms` outdoor, `< 0.02 ms` indoor).
 */

import * as T from 'three';
import {
  GROUND_Y,
  UPPER_WALL_TOP,
  WALL,
  type DoorId,
  type HousePlan,
  type Rect,
  type WallSpan,
} from '@/lib/echo-life/plan';
import type { CityPlan, Lot } from '@/lib/echo-life/city';
import type { EnterableBuilding } from '@/lib/echo-life/buildings';

/** Mirrors `room.ts` `WINDOW` constant without importing DOM/AudioContext room helpers. */
export const STUDY_ROOM_WINDOW = { x0: -0.6, x1: 2.3, y0: 0.95, y1: 2.55 } as const;

// ── Visibility Classification Constants ──────────────────────────────────────────────────────────

/** Hidden from main pass, planar reflection, AND CSM shadow cascades. */
export const VIS_CULLED = 0 as const;
/** Occluded from main camera, but its sun-extruded shadow volume reaches visible space: render in CSM only. */
export const VIS_SHADOW_ONLY = 1 as const;
/** Visible to main camera (and CSM shadow cascades when casting shadows). */
export const VIS_BOTH = 2 as const;

export type OcclusionVisibility = typeof VIS_CULLED | typeof VIS_SHADOW_ONLY | typeof VIS_BOTH;

export const AABB_OUTSIDE_FRUSTUM = 0 as const;
export const AABB_OCCLUDED = 1 as const;
export const AABB_VISIBLE = 2 as const;

export type HiZAabbResult = typeof AABB_OUTSIDE_FRUSTUM | typeof AABB_OCCLUDED | typeof AABB_VISIBLE;

// ── Grid & Pool Constants ────────────────────────────────────────────────────────────────────────

export const HIZ_WIDTH = 64;
export const HIZ_HEIGHT = 16;
export const HIZ_COARSE_W = 16; // 64 / 4
export const HIZ_COARSE_H = 4;  // 16 / 4
const HIZ_FINE_SIZE = HIZ_WIDTH * HIZ_HEIGHT;
const HIZ_COARSE_SIZE = HIZ_COARSE_W * HIZ_COARSE_H;

const MAX_RASTER_OCCLUDERS = 12;
const MAX_ACTIVE_PORTALS = 8;
const MAX_CLIP_VERTS = 12;

/** Matches `echoCsm.ts:617` minimum sun elevation (`sin(11.5°) = 0.20`). */
const MIN_SUN_DIR_Y = 0.20;
/** Slightly below `GROUND_Y - ROAD_DROP` (`-3.32`) so shadows falling onto depressed roads are always covered. */
const DEFAULT_SHADOW_RECEIVER_Y = GROUND_Y - 0.25;
/** Underground foundation floor for ground-anchored opaque building occluders (eliminates 64x16 ground-line seam). */
export const GROUND_OCCLUDER_FOUNDATION_Y = GROUND_Y - 1.8;
/** Conservative depth bias against FP rounding when comparing occluder vs occludee NDC Z. */
const OCCLUDER_Z_BIAS = 2.0e-5;
const OCCLUDEE_Z_BIAS = 3.0e-5;
const EDGE_CONSERVATIVE_EPS = 1.0e-4;
const PORTAL_NDC_PAD = 0.028;
const PORTAL_NDC_ENTER_LIMIT = 1.01;
const PORTAL_NDC_EXIT_LIMIT = 1.09;
const PORTAL_OPENING_PAD_M = 0.14;
const PORTAL_BOUNDS_ENTER_MARGIN = 0.22;
const PORTAL_BOUNDS_EXIT_MARGIN = 0.04;
const PORTAL_APERTURE_ENTER_IN = -0.28;
const PORTAL_APERTURE_EXIT_IN = -0.52;
const PORTAL_APERTURE_ENTER_OUT = 0.55;
const PORTAL_APERTURE_EXIT_OUT = 0.80;
const PORTAL_APERTURE_ENTER_LAT = 0.68;
const PORTAL_APERTURE_EXIT_LAT = 0.92;
const DOOR_OPEN_ANGLE_EPS = 0.03;
const OCCLUDER_DIST_HYSTERESIS_M = 1.5;
const MAX_TRACKED_PORTALS_PER_SET = 64;

// ── Public Data Types ────────────────────────────────────────────────────────────────────────────

export interface Aabb3 {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

export interface StaticOccluderDef {
  readonly id: string;
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  readonly x1: number;
  readonly y1: number;
  readonly z1: number;
  /** Minimum camera distance (metres) before this occluder activates (0 = always opaque). */
  readonly minDistanceM: number;
  /** Optional chunk id for streaming enable/disable toggles. */
  readonly chunkId?: string;
  /** Whether initially active. */
  readonly enabled?: boolean;
}

export interface OccluderExtractOptions {
  /** Low tier sets `filterHalfLots = true` in `streaming.ts`; skip decorative lots that may be filtered. */
  readonly filterHalfLots?: boolean;
  /** Minimum camera distance before enterable buildings' ground floors act as solid occluders (default 18 m). */
  readonly enterableGroundMinDistM?: number;
}

export interface OutdoorHiZStats {
  occluderPoolSize: number;
  selectedOccluders: number;
  rasterizedFaces: number;
  rasterizedPixels: number;
  queriesMain: number;
  culledFrustum: number;
  culledHiZ: number;
  shadowOnlyCount: number;
  visibleCount: number;
}

/**
 * World-space exterior window or doorway quad for indoor portal frustum culling.
 * Corners are ordered CCW when viewed from inside the enclosure looking outward along `normalOut`.
 */
export interface ExteriorPortal {
  readonly id: string;
  /** 4 world corners flattened `[x0,y0,z0, x1,y1,z1, x2,y2,z2, x3,y3,z3]` (length 12) for zero-alloc reads. */
  readonly corners: Float32Array;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** Half-extents along the portal wall tangent and vertical axis (used for near-portal eye fallback). */
  readonly halfW: number;
  readonly halfH: number;
  /** Wall orientation along world X (`true`) or world Z (`false`). */
  readonly alongX: boolean;
  /** If set, portal is ONLY active while the corresponding exterior door is open (`isOpen || |angle| > 0.03`). */
  readonly doorId?: string;
  /** Optional interior connecting door that must ALSO be open to see this neighbor-room portal. */
  readonly gateDoorId?: string;
  /** If set, portal is ONLY active when the Study Room window is NOT occluded by opaque view/curtains. */
  readonly isStudyWindow?: boolean;
  /** Owning room or enclosure id (used to distinguish direct vs neighbor-room portals in Starter House). */
  readonly ownerRoomId: string;
}

export interface DoorStateQuery {
  isDoorOpen(doorId: string): boolean;
}

export interface BuildingPortalSet {
  readonly enclosureId: string;
  readonly bounds: Aabb3;
  readonly portals: readonly ExteriorPortal[];
}

export interface IndoorPortalFrameState {
  /** True when camera is enclosed and portal culling is active. */
  active: boolean;
  /** Active enclosure id (`city building id`, `property id`, or `house:<roomId>`), or null when outdoors. */
  enclosureId: string | null;
  /** True when camera is pressed up against / stepping through an active portal or outside the enclosure box. */
  fullExteriorFallback: boolean;
  /** Number of active clipped screen portals (`0..MAX_ACTIVE_PORTALS`). */
  visiblePortalCount: number;
  /** Instant fast-path: `true` iff enclosed with 0 visible portals (hide 100% of exterior geometry). */
  hideAllExterior: boolean;
  /**
   * G-04 sky-void invariant: ALWAYS `true` whenever `visiblePortalCount > 0 || fullExteriorFallback || !active`.
   * Callers MUST keep `skyMesh` and `city-horizon-skirt` visible whenever this flag is `true`.
   */
  keepSkyAndHorizon: boolean;
  /** Total exterior portals evaluated this frame. */
  evaluatedPortals: number;
}

// ── Shared Zero-Alloc Frustum Math Helpers ───────────────────────────────────────────────────────

/**
 * Extracts 6 normalized inward-facing frustum planes from a Three.js column-major `viewProj` matrix
 * into `out` (24 floats: 6 planes × `[nx, ny, nz, d]`). Order: Left, Right, Bottom, Top, Near, Far.
 */
function extractFrustumPlanesFromVP(m: readonly number[] | Float32Array, out: Float32Array): void {
  // Three.js Matrix4.elements is column-major: row r = [m[r], m[4+r], m[8+r], m[12+r]].
  const r00 = m[0], r01 = m[4], r02 = m[8],  r03 = m[12];
  const r10 = m[1], r11 = m[5], r12 = m[9],  r13 = m[13];
  const r20 = m[2], r21 = m[6], r22 = m[10], r23 = m[14];
  const r30 = m[3], r31 = m[7], r32 = m[11], r33 = m[15];

  writeNormPlane(out, 0,  r30 + r00, r31 + r01, r32 + r02, r33 + r03); // Left   (x >= -w)
  writeNormPlane(out, 4,  r30 - r00, r31 - r01, r32 - r02, r33 - r03); // Right  (x <= +w)
  writeNormPlane(out, 8,  r30 + r10, r31 + r11, r32 + r12, r33 + r13); // Bottom (y >= -w)
  writeNormPlane(out, 12, r30 - r10, r31 - r11, r32 - r12, r33 - r13); // Top    (y <= +w)
  writeNormPlane(out, 16, r30 + r20, r31 + r21, r32 + r22, r33 + r23); // Near   (z >= -w)
  writeNormPlane(out, 20, r30 - r20, r31 - r21, r32 - r22, r33 - r23); // Far    (z <= +w)
}

function writeNormPlane(
  out: Float32Array,
  offset: number,
  nx: number,
  ny: number,
  nz: number,
  d: number,
): void {
  const len = Math.hypot(nx, ny, nz);
  if (len > 1e-12) {
    const inv = 1 / len;
    out[offset]     = nx * inv;
    out[offset + 1] = ny * inv;
    out[offset + 2] = nz * inv;
    out[offset + 3] = d * inv;
  } else {
    out[offset]     = 0;
    out[offset + 1] = 1;
    out[offset + 2] = 0;
    out[offset + 3] = 1e6;
  }
}

/** Returns `true` if world AABB intersects (or lies inside) the 6-plane frustum at `planes[base .. base+23]`. */
function aabbIntersects6Planes(
  planes: Float32Array,
  base: number,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): boolean {
  for (let p = 0; p < 24; p += 4) {
    const nx = planes[base + p];
    const ny = planes[base + p + 1];
    const nz = planes[base + p + 2];
    const d  = planes[base + p + 3];
    const px = nx >= 0 ? x1 : x0;
    const py = ny >= 0 ? y1 : y0;
    const pz = nz >= 0 ? z1 : z0;
    if (nx * px + ny * py + nz * pz + d < 0) return false;
  }
  return true;
}

/** Returns `true` if world sphere intersects (or lies inside) the 6-plane frustum at `planes[base .. base+23]`. */
function sphereIntersects6Planes(
  planes: Float32Array,
  base: number,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
): boolean {
  for (let p = 0; p < 24; p += 4) {
    const nx = planes[base + p];
    const ny = planes[base + p + 1];
    const nz = planes[base + p + 2];
    const d  = planes[base + p + 3];
    if (nx * cx + ny * cy + nz * cz + d < -radius) return false;
  }
  return true;
}

/** Squared Euclidean distance from point `(px, py, pz)` to AABB. Returns `0` when inside. */
function distSqPointToAabb(
  px: number,
  py: number,
  pz: number,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): number {
  const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
  const dy = py < y0 ? y0 - py : py > y1 ? py - y1 : 0;
  const dz = pz < z0 ? z0 - pz : pz > z1 ? pz - z1 : 0;
  return dx * dx + dy * dy + dz * dz;
}

// ── Static Outdoor Occluder Auto-Extraction ──────────────────────────────────────────────────────

/**
 * Extracts conservative solid opaque building occluder boxes from `HousePlan` and `CityPlan` across
 * all 4 room sizes (`4, 6, 7.5, 9 m`).
 *
 * Conservative guarantees:
 * - Every box is shrunk strictly inside the rendered opaque shell (never protrudes past eaves/corners).
 * - Starter House includes ONLY the 100% opaque closed ground-floor bookshop cores (`shop: true` parallax glass,
 *   never overlapping transparent upper rooms, lobby windows, or garage doors).
 * - Enterable city buildings split into:
 *   1. Always-opaque 2nd-storey solid band (`[y0 + 2.75, roofY - 0.15]`) for 2-storey buildings (`library`,
 *      `furniture_shop`, `residences`) since all ground-floor window openings terminate at `top <= 2.55`.
 *   2. Distance-gated (`minDistanceM >= 18 m`) full-height body for all enterable buildings (so standing close
 *      and looking through transparent café/library windows NEVER produces false occlusion).
 * - Decorative backdrop lots (`home-west`, `se-campus-a`, `sc-dorm-b`, etc.) are conservatively inset to sit
 *   strictly within the minimum rendered `bld_urban_facade_aaa` / `bld-*-lod` footprint, and Wave 2 streaming
 *   can refine exact GLB world boxes via `registerOccluder()` / `updateOccluderBounds()`.
 */
export function extractStaticOccluders(
  house: HousePlan,
  city: CityPlan,
  opts: OccluderExtractOptions = {},
): StaticOccluderDef[] {
  const out: StaticOccluderDef[] = [];
  const h = house.h;
  const front = house.front;
  const filterHalfLots = opts.filterHalfLots === true;
  const enterableMinDist = opts.enterableGroundMinDistM ?? 18;
  // Ground-anchored buildings extend conservatively into solid earth below `GROUND_Y` so row-boundary
  // quantization in the 64x16 Hi-Z grid never leaves a 1/16th-screen gap along the ground line.
  // Because the entire city ground plane (`GROUND_Y - 0.12`) is opaque and every camera sits above ground,
  // no ray from eye to any above-ground point behind a building can ever pass below `GROUND_Y - 0.12`.
  const foundationY = GROUND_OCCLUDER_FOUNDATION_Y;

  // 1. Starter House closed ground-floor bookshop L-core (100% opaque `shop: true` walls, zero transparent panes).
  const hallZone = house.zones.find(z => z.id === 'hall');
  const balconyZone = house.zones.find(z => z.id === 'balcony');
  const hallEnd = hallZone ? hallZone.rect.z1 : h + 2.4;
  const bx1 = balconyZone ? balconyZone.rect.x1 : h + 13.4;

  // West bookshop under Study Room (`[-h - WALL, h]` x `[foundationY, 0]` x `[-h - WALL, front]`).
  pushShrunkOccluder(out, 'house:ground-west-bookshop', -h - WALL, foundationY, -h - WALL, h, 0, front, 0.28, 0.16, 0, 'home-core');
  // North ground bookshop under Hall/Living/Bedroom/Balcony (`[h, bx1 + WALL]` x `[foundationY, 0]` x `[-h - WALL, hallEnd]`).
  pushShrunkOccluder(out, 'house:ground-north-bookshop', h, foundationY, -h - WALL, bx1 + WALL, 0, hallEnd, 0.28, 0.16, 0, 'home-core');

  // 2. All 13 enterable city buildings + 5 Market Blvd residences.
  const allEnterable: readonly EnterableBuilding[] = [...city.buildings, ...city.residences];
  for (let i = 0; i < allEnterable.length; i++) {
    const b = allEnterable[i];
    const bid = b.property?.id ?? b.id;
    const roofY = b.storeys >= 2 ? GROUND_Y + 5.6 : GROUND_Y + 3.35;

    // For 2-storey buildings, the upper storey (`[GROUND_Y + 2.75, roofY]`) has ZERO window openings in `buildings.ts`!
    if (b.storeys >= 2) {
      pushShrunkOccluder(
        out,
        `bld-upper:${bid}`,
        b.rect.x0,
        GROUND_Y + 2.72,
        b.rect.z0,
        b.rect.x1,
        roofY,
        b.rect.z1,
        0.30,
        0.18,
        0,
        b.chunkId,
      );
    }

    // Full-height body: active only beyond `enterableMinDist` (when interior is culled / WARM shell is active).
    pushShrunkOccluder(
      out,
      `bld-full:${bid}`,
      b.rect.x0,
      foundationY,
      b.rect.z0,
      b.rect.x1,
      roofY,
      b.rect.z1,
      0.35,
      0.22,
      enterableMinDist,
      b.chunkId,
    );
  }

  // 3. Always-present decorative opaque lots (conservatively inset until runtime GLB bounds refine them).
  const residenceLots = new Set<string>();
  for (let i = 0; i < city.residences.length; i++) {
    const lotId = city.residences[i].property?.lot;
    if (lotId) residenceLots.add(lotId);
  }

  for (let i = 0; i < city.lots.length; i++) {
    const l: Lot = city.lots[i];
    // Skip lots that Low tier omits (`streaming.ts:880-882`).
    if (filterHalfLots && !residenceLots.has(l.id) && !l.id.startsWith('home') && !l.name && i % 2 !== 0) {
      continue;
    }
    // Residences share their lot with the enterable wing already added above.
    if (residenceLots.has(l.id)) continue;

    const w = l.rect.x1 - l.rect.x0;
    const d = l.rect.z1 - l.rect.z0;
    if (w < 4.0 || d < 4.0) continue;

    // Conservative inner core: WARM massing uses `0.92 * w`, `h = max(3.6, storeys * 3.1)`; HOT GLBs fit inside.
    const insetX = Math.max(0.55, w * 0.14);
    const insetZ = Math.max(0.55, d * 0.14);
    const height = Math.max(3.2, l.storeys * 2.75);
    pushShrunkOccluder(
      out,
      `lot:${l.id}`,
      l.rect.x0,
      foundationY,
      l.rect.z0,
      l.rect.x1,
      GROUND_Y + height,
      l.rect.z1,
      Math.min(insetX, w * 0.35),
      0.30,
      0,
      l.chunkId,
      Math.min(insetZ, d * 0.35),
    );
  }

  return out;
}

function pushShrunkOccluder(
  out: StaticOccluderDef[],
  id: string,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  insetX: number,
  insetTop: number,
  minDistanceM: number,
  chunkId?: string,
  insetZ = insetX,
): void {
  const sx0 = x0 + insetX;
  const sx1 = x1 - insetX;
  const sz0 = z0 + insetZ;
  const sz1 = z1 - insetZ;
  const sy1 = y1 - insetTop;
  if (sx1 - sx0 < 0.8 || sz1 - sz0 < 0.8 || sy1 - y0 < 1.2) return;
  out.push({ id, x0: sx0, y0, z0: sz0, x1: sx1, y1: sy1, z1: sz1, minDistanceM, chunkId, enabled: true });
}

// ── Part 1: Zero-Alloc Conservative 64x16 Software Hi-Z Outdoor Occlusion Culler ─────────────────

interface OccluderSlot {
  id: string;
  chunkId: string | undefined;
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  cx: number;
  cy: number;
  cz: number;
  areaWeight: number;
  minDistSq: number;
  exitDistSq: number;
  wasActive: boolean;
  enabled: boolean;
}

export class OutdoorHiZOcclusionCuller {
  /** Fine 64x16 conservative depth buffer (4 KB, L1-resident). Stores max-conservative occluder NDC Z in `[-1, 1]`. */
  readonly fineZ = new Float32Array(HIZ_FINE_SIZE);
  /** Coarse 16x4 max-depth Hi-Z mip (256 B). Each entry is max over its 4x4 fine block. */
  readonly coarseZ = new Float32Array(HIZ_COARSE_SIZE);

  private readonly occluders: OccluderSlot[] = [];
  private readonly occluderIndexById = new Map<string, number>();

  // Camera & lighting state cached per frame in `beginFrame()` (zero allocs).
  private readonly vpMat = new T.Matrix4();
  private readonly frustumPlanes = new Float32Array(24);
  private eyeX = 0;
  private eyeY = 0;
  private eyeZ = 0;
  private nearClipW = 0.05;
  private nearPad = 0.35;

  private shadowsActive = true;
  private sunDirX = 0.35;
  private sunDirY = 0.72;
  private sunDirZ = -0.58;
  private invSunDirY = 1 / 0.72;
  private shadowReceiverY = DEFAULT_SHADOW_RECEIVER_Y;
  private shadowMaxDistSq = 155 * 155;

  // Pre-allocated top-K selection & polygon clip buffers (zero per-frame allocs).
  private readonly topIndices = new Int32Array(MAX_RASTER_OCCLUDERS);
  private readonly topScores = new Float32Array(MAX_RASTER_OCCLUDERS);
  private topCount = 0;

  private readonly clipAX = new Float32Array(MAX_CLIP_VERTS);
  private readonly clipAY = new Float32Array(MAX_CLIP_VERTS);
  private readonly clipAZ = new Float32Array(MAX_CLIP_VERTS);
  private readonly clipAW = new Float32Array(MAX_CLIP_VERTS);
  private readonly clipBX = new Float32Array(MAX_CLIP_VERTS);
  private readonly clipBY = new Float32Array(MAX_CLIP_VERTS);
  private readonly clipBZ = new Float32Array(MAX_CLIP_VERTS);
  private readonly clipBW = new Float32Array(MAX_CLIP_VERTS);

  private readonly polySX = new Float32Array(MAX_CLIP_VERTS);
  private readonly polySY = new Float32Array(MAX_CLIP_VERTS);
  private readonly polySZ = new Float32Array(MAX_CLIP_VERTS);
  private readonly edgeNX = new Float32Array(MAX_CLIP_VERTS);
  private readonly edgeNY = new Float32Array(MAX_CLIP_VERTS);
  private readonly edgeC = new Float32Array(MAX_CLIP_VERTS);

  private readonly tmpEye = new T.Vector3();
  private hasOccluders = false;

  readonly stats: OutdoorHiZStats = {
    occluderPoolSize: 0,
    selectedOccluders: 0,
    rasterizedFaces: 0,
    rasterizedPixels: 0,
    queriesMain: 0,
    culledFrustum: 0,
    culledHiZ: 0,
    shadowOnlyCount: 0,
    visibleCount: 0,
  };

  constructor(initialOccluders?: readonly StaticOccluderDef[]) {
    this.fineZ.fill(1.0);
    this.coarseZ.fill(1.0);
    if (initialOccluders) {
      for (let i = 0; i < initialOccluders.length; i++) {
        this.registerOccluder(initialOccluders[i]);
      }
    }
  }

  /** Registers or updates a static/dynamic opaque occluder box. Returns its stable integer handle. */
  registerOccluder(def: StaticOccluderDef): number {
    const existing = this.occluderIndexById.get(def.id);
    const w = Math.max(0, def.x1 - def.x0);
    const h = Math.max(0, def.y1 - def.y0);
    const d = Math.max(0, def.z1 - def.z0);
    const minDist = Math.max(0, def.minDistanceM);
    const exitDist = minDist > 0 ? Math.max(0, minDist - OCCLUDER_DIST_HYSTERESIS_M) : 0;
    const slot: OccluderSlot = {
      id: def.id,
      chunkId: def.chunkId,
      x0: def.x0,
      y0: def.y0,
      z0: def.z0,
      x1: def.x1,
      y1: def.y1,
      z1: def.z1,
      cx: (def.x0 + def.x1) * 0.5,
      cy: (def.y0 + def.y1) * 0.5,
      cz: (def.z0 + def.z1) * 0.5,
      areaWeight: (w + d) * h,
      minDistSq: minDist * minDist,
      exitDistSq: exitDist * exitDist,
      wasActive: false,
      enabled: def.enabled ?? true,
    };
    if (existing !== undefined) {
      this.occluders[existing] = slot;
      return existing;
    }
    const idx = this.occluders.length;
    this.occluders.push(slot);
    this.occluderIndexById.set(def.id, idx);
    this.stats.occluderPoolSize = this.occluders.length;
    return idx;
  }

  /** Refines an already-registered occluder's world bounds (e.g. once a `bld_urban_facade_aaa` GLB finishes loading). */
  updateOccluderBounds(
    id: string,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    minDistanceM?: number,
  ): boolean {
    const idx = this.occluderIndexById.get(id);
    if (idx === undefined) return false;
    const s = this.occluders[idx];
    s.x0 = x0; s.y0 = y0; s.z0 = z0;
    s.x1 = x1; s.y1 = y1; s.z1 = z1;
    s.cx = (x0 + x1) * 0.5;
    s.cy = (y0 + y1) * 0.5;
    s.cz = (z0 + z1) * 0.5;
    s.areaWeight = (Math.max(0, x1 - x0) + Math.max(0, z1 - z0)) * Math.max(0, y1 - y0);
    if (minDistanceM !== undefined) {
      const minDist = Math.max(0, minDistanceM);
      const exitDist = minDist > 0 ? Math.max(0, minDist - OCCLUDER_DIST_HYSTERESIS_M) : 0;
      s.minDistSq = minDist * minDist;
      s.exitDistSq = exitDist * exitDist;
    }
    return true;
  }

  setOccluderEnabled(id: string, enabled: boolean): void {
    const idx = this.occluderIndexById.get(id);
    if (idx !== undefined) this.occluders[idx].enabled = enabled;
  }

  /** Bulk enable/disable occluders belonging to a specific streaming chunk (e.g., when chunk goes COLD). */
  setChunkOccludersEnabled(chunkId: string, enabled: boolean): void {
    for (let i = 0; i < this.occluders.length; i++) {
      if (this.occluders[i].chunkId === chunkId) {
        this.occluders[i].enabled = enabled;
      }
    }
  }

  clearOccluders(): void {
    this.occluders.length = 0;
    this.occluderIndexById.clear();
    this.stats.occluderPoolSize = 0;
  }

  /**
   * Builds the `64x16` + `16x4` conservative Hi-Z buffer for the current camera and sun direction.
   * Call ONCE per frame BEFORE querying occludees and BEFORE `renderer.render()`.
   *
   * @param camera Active perspective/orthographic camera (its matrices are read without mutating scene graph).
   * @param sunDirTowardSun Unit direction pointing FROM ground TOWARD the sun/moon (same convention as `echoCsm.ts`).
   * @param opts Optional shadow configuration (`shadowsEnabled`, `shadowReceiverY`, `shadowMaxDistM`).
   */
  beginFrame(
    camera: T.Camera,
    sunDirTowardSun?: { x: number; y: number; z: number } | null,
    opts?: { shadowsEnabled?: boolean; shadowReceiverY?: number; shadowMaxDistM?: number },
  ): void {
    // 1. Update camera VP matrix and 6 frustum planes.
    this.vpMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const m = this.vpMat.elements;
    extractFrustumPlanesFromVP(m, this.frustumPlanes);

    camera.getWorldPosition(this.tmpEye);
    this.eyeX = this.tmpEye.x;
    this.eyeY = this.tmpEye.y;
    this.eyeZ = this.tmpEye.z;

    const persp = (camera as T.PerspectiveCamera).isPerspectiveCamera ? (camera as T.PerspectiveCamera) : null;
    const camNear = persp ? Math.max(0.05, persp.near) : 0.1;
    this.nearClipW = Math.max(0.02, camNear * 0.98);
    this.nearPad = Math.max(0.25, camNear + 0.15);

    // 2. Normalize and clamp sun direction identically to `echoCsm.ts:614-622` (`sunDir.y >= 0.20`).
    this.shadowsActive = opts?.shadowsEnabled ?? true;
    this.shadowReceiverY = opts?.shadowReceiverY ?? DEFAULT_SHADOW_RECEIVER_Y;
    const maxDist = opts?.shadowMaxDistM ?? 155;
    this.shadowMaxDistSq = maxDist > 0 ? maxDist * maxDist : 0;

    if (sunDirTowardSun) {
      let sx = sunDirTowardSun.x;
      let sy = sunDirTowardSun.y;
      let sz = sunDirTowardSun.z;
      const len = Math.hypot(sx, sy, sz);
      if (len > 1e-5) {
        sx /= len; sy /= len; sz /= len;
      } else {
        sx = 0.35; sy = 0.72; sz = -0.58;
      }
      if (sy < MIN_SUN_DIR_Y) {
        const hLen = Math.hypot(sx, sz);
        const hScale = hLen > 1e-4 ? Math.sqrt(1 - MIN_SUN_DIR_Y * MIN_SUN_DIR_Y) / hLen : 0;
        sx *= hScale;
        sy = MIN_SUN_DIR_Y;
        sz *= hScale;
      }
      this.sunDirX = sx;
      this.sunDirY = sy;
      this.sunDirZ = sz;
      this.invSunDirY = 1 / sy;
    }

    // 3. Reset Hi-Z buffers & per-frame counters.
    this.fineZ.fill(1.0);
    this.coarseZ.fill(1.0);
    this.topCount = 0;
    this.hasOccluders = false;
    this.stats.selectedOccluders = 0;
    this.stats.rasterizedFaces = 0;
    this.stats.rasterizedPixels = 0;
    this.stats.queriesMain = 0;
    this.stats.culledFrustum = 0;
    this.stats.culledHiZ = 0;
    this.stats.shadowOnlyCount = 0;
    this.stats.visibleCount = 0;

    // 4. Select top-K dominant visible occluders (zero alloc insertion into fixed arrays).
    const ex = this.eyeX, ey = this.eyeY, ez = this.eyeZ;
    const occs = this.occluders;
    const nOcc = occs.length;
    const planes = this.frustumPlanes;
    const maxOccDistSq = 185 * 185;

    for (let i = 0; i < nOcc; i++) {
      const o = occs[i];
      if (!o.enabled) {
        o.wasActive = false;
        continue;
      }

      const d2 = distSqPointToAabb(ex, ey, ez, o.x0, o.y0, o.z0, o.x1, o.y1, o.z1);
      const minThresholdSq = o.wasActive ? o.exitDistSq : o.minDistSq;
      // Skip if camera is inside/touching the occluder, closer than hysteresis `minDistanceM`, or too far to cover cells.
      if (d2 <= 0.04 || d2 < minThresholdSq || d2 > maxOccDistSq) {
        o.wasActive = false;
        continue;
      }

      if (!aabbIntersects6Planes(planes, 0, o.x0, o.y0, o.z0, o.x1, o.y1, o.z1)) {
        o.wasActive = false;
        continue;
      }

      o.wasActive = true;
      const score = o.areaWeight / (d2 + 4.0);
      this.insertTopOccluder(i, score);
    }

    this.stats.selectedOccluders = this.topCount;
    if (this.topCount === 0) return;

    // 5. Rasterize front-facing faces of the top-K occluders conservatively into `fineZ`.
    let totalPixels = 0;
    for (let k = 0; k < this.topCount; k++) {
      const o = occs[this.topIndices[k]];
      const { x0, y0, z0, x1, y1, z1 } = o;

      // Only front-facing AABB faces are rasterized (at most 3 faces per box).
      // All quads are emitted in CCW order when viewed from outside the box.
      if (ez > z1) {
        totalPixels += this.rasterizeQuad(m, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1);
      } else if (ez < z0) {
        totalPixels += this.rasterizeQuad(m, x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0);
      }

      if (ex > x1) {
        totalPixels += this.rasterizeQuad(m, x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1);
      } else if (ex < x0) {
        totalPixels += this.rasterizeQuad(m, x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0);
      }

      if (ey > y1) {
        totalPixels += this.rasterizeQuad(m, x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0);
      } else if (ey < y0) {
        totalPixels += this.rasterizeQuad(m, x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1);
      }
    }

    this.stats.rasterizedPixels = totalPixels;
    if (totalPixels === 0) return;
    this.hasOccluders = true;

    // 6. Build 16x4 coarse Hi-Z max-depth mip (`4x4` reduction over `fineZ`).
    const fine = this.fineZ;
    const coarse = this.coarseZ;
    for (let cy = 0; cy < HIZ_COARSE_H; cy++) {
      const fyBase = cy << 2;
      const r0 = fyBase * HIZ_WIDTH;
      const r1 = r0 + HIZ_WIDTH;
      const r2 = r1 + HIZ_WIDTH;
      const r3 = r2 + HIZ_WIDTH;
      const cRow = cy * HIZ_COARSE_W;
      for (let cx = 0; cx < HIZ_COARSE_W; cx++) {
        const fx = cx << 2;
        let maxZ = fine[r0 + fx];
        let v: number;
        v = fine[r0 + fx + 1]; if (v > maxZ) maxZ = v;
        v = fine[r0 + fx + 2]; if (v > maxZ) maxZ = v;
        v = fine[r0 + fx + 3]; if (v > maxZ) maxZ = v;

        v = fine[r1 + fx];     if (v > maxZ) maxZ = v;
        v = fine[r1 + fx + 1]; if (v > maxZ) maxZ = v;
        v = fine[r1 + fx + 2]; if (v > maxZ) maxZ = v;
        v = fine[r1 + fx + 3]; if (v > maxZ) maxZ = v;

        v = fine[r2 + fx];     if (v > maxZ) maxZ = v;
        v = fine[r2 + fx + 1]; if (v > maxZ) maxZ = v;
        v = fine[r2 + fx + 2]; if (v > maxZ) maxZ = v;
        v = fine[r2 + fx + 3]; if (v > maxZ) maxZ = v;

        v = fine[r3 + fx];     if (v > maxZ) maxZ = v;
        v = fine[r3 + fx + 1]; if (v > maxZ) maxZ = v;
        v = fine[r3 + fx + 2]; if (v > maxZ) maxZ = v;
        v = fine[r3 + fx + 3]; if (v > maxZ) maxZ = v;

        coarse[cRow + cx] = maxZ;
      }
    }
  }

  /**
   * Tests a world AABB against camera frustum + `64x16` conservative Hi-Z buffer.
   * Guaranteed conservative: NEVER returns `AABB_OCCLUDED` or `AABB_OUTSIDE_FRUSTUM` for any AABB
   * that could have even one visible pixel on screen.
   */
  testAabb(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): HiZAabbResult {
    this.stats.queriesMain++;

    // 1. Camera-inside / near-plane guard.
    const pad = this.nearPad;
    const ex = this.eyeX, ey = this.eyeY, ez = this.eyeZ;
    if (
      ex >= x0 - pad && ex <= x1 + pad &&
      ey >= y0 - pad && ey <= y1 + pad &&
      ez >= z0 - pad && ez <= z1 + pad
    ) {
      return AABB_VISIBLE;
    }

    // 2. Fast 6-plane frustum reject.
    if (!aabbIntersects6Planes(this.frustumPlanes, 0, x0, y0, z0, x1, y1, z1)) {
      this.stats.culledFrustum++;
      return AABB_OUTSIDE_FRUSTUM;
    }

    // If no occluders rasterized any pixels this frame, anything inside the frustum is visible.
    if (!this.hasOccluders) return AABB_VISIBLE;

    // 3. Project all 8 AABB corners through `viewProj` (unrolled via column deltas for max JIT speed).
    const m = this.vpMat.elements;
    const m0 = m[0],  m4 = m[4],  m8  = m[8],  m12 = m[12];
    const m1 = m[1],  m5 = m[5],  m9  = m[9],  m13 = m[13];
    const m2 = m[2],  m6 = m[6],  m10 = m[10], m14 = m[14];
    const m3 = m[3],  m7 = m[7],  m11 = m[11], m15 = m[15];

    const nearW = this.nearClipW;
    let ndcMinX = 2.0, ndcMaxX = -2.0;
    let ndcMinY = 2.0, ndcMaxY = -2.0;
    let ndcMinZ = 2.0;

    // Precompute X, Y, Z contributions once (`8` corners = only `24` adds instead of `96` muls!).
    const x0m0 = m0 * x0, x1m0 = m0 * x1;
    const x0m1 = m1 * x0, x1m1 = m1 * x1;
    const x0m2 = m2 * x0, x1m2 = m2 * x1;
    const x0m3 = m3 * x0, x1m3 = m3 * x1;

    const y0m4 = m4 * y0, y1m4 = m4 * y1;
    const y0m5 = m5 * y0, y1m5 = m5 * y1;
    const y0m6 = m6 * y0, y1m6 = m6 * y1;
    const y0m7 = m7 * y0, y1m7 = m7 * y1;

    const z0m8  = m8  * z0 + m12, z1m8  = m8  * z1 + m12;
    const z0m9  = m9  * z0 + m13, z1m9  = m9  * z1 + m13;
    const z0m10 = m10 * z0 + m14, z1m10 = m10 * z1 + m14;
    const z0m11 = m11 * z0 + m15, z1m11 = m11 * z1 + m15;

    for (let c = 0; c < 8; c++) {
      const xm0 = (c & 1) ? x1m0 : x0m0;
      const xm1 = (c & 1) ? x1m1 : x0m1;
      const xm2 = (c & 1) ? x1m2 : x0m2;
      const xm3 = (c & 1) ? x1m3 : x0m3;

      const ym4 = (c & 2) ? y1m4 : y0m4;
      const ym5 = (c & 2) ? y1m5 : y0m5;
      const ym6 = (c & 2) ? y1m6 : y0m6;
      const ym7 = (c & 2) ? y1m7 : y0m7;

      const zm8  = (c & 4) ? z1m8  : z0m8;
      const zm9  = (c & 4) ? z1m9  : z0m9;
      const zm10 = (c & 4) ? z1m10 : z0m10;
      const zm11 = (c & 4) ? z1m11 : z0m11;

      const cw = xm3 + ym7 + zm11;
      // Conservative near-plane guard: any corner on/behind the camera near plane marks the AABB visible.
      if (cw <= nearW) return AABB_VISIBLE;

      const invW = 1 / cw;
      const nx = (xm0 + ym4 + zm8) * invW;
      const ny = (xm1 + ym5 + zm9) * invW;
      const nz = (xm2 + ym6 + zm10) * invW;

      if (nx < ndcMinX) ndcMinX = nx;
      if (nx > ndcMaxX) ndcMaxX = nx;
      if (ny < ndcMinY) ndcMinY = ny;
      if (ny > ndcMaxY) ndcMaxY = ny;
      if (nz < ndcMinZ) ndcMinZ = nz;
    }

    if (ndcMaxX < -1.0 || ndcMinX > 1.0 || ndcMaxY < -1.0 || ndcMinY > 1.0) {
      this.stats.culledFrustum++;
      return AABB_OUTSIDE_FRUSTUM;
    }

    // Closest corner is at or ahead of the near plane -> always visible.
    if (ndcMinZ <= -1.0) return AABB_VISIBLE;

    // Expand screen bounds slightly outward before mapping to integer pixel range (conservative grazing guard).
    const u0 = ndcMinX < -1.0 ? -1.0 : ndcMinX - 1e-4;
    const u1 = ndcMaxX >  1.0 ?  1.0 : ndcMaxX + 1e-4;
    const v0 = ndcMinY < -1.0 ? -1.0 : ndcMinY - 1e-4;
    const v1 = ndcMaxY >  1.0 ?  1.0 : ndcMaxY + 1e-4;

    let px0 = Math.floor((u0 * 0.5 + 0.5) * HIZ_WIDTH);
    let px1 = Math.floor((u1 * 0.5 + 0.5) * HIZ_WIDTH);
    let py0 = Math.floor((v0 * 0.5 + 0.5) * HIZ_HEIGHT);
    let py1 = Math.floor((v1 * 0.5 + 0.5) * HIZ_HEIGHT);

    if (px0 < 0) px0 = 0; else if (px0 >= HIZ_WIDTH) px0 = HIZ_WIDTH - 1;
    if (px1 < 0) px1 = 0; else if (px1 >= HIZ_WIDTH) px1 = HIZ_WIDTH - 1;
    if (py0 < 0) py0 = 0; else if (py0 >= HIZ_HEIGHT) py0 = HIZ_HEIGHT - 1;
    if (py1 < 0) py1 = 0; else if (py1 >= HIZ_HEIGHT) py1 = HIZ_HEIGHT - 1;

    const testZ = ndcMinZ - OCCLUDEE_Z_BIAS;
    const coarse = this.coarseZ;
    const fine = this.fineZ;

    const cx0 = px0 >> 2;
    const cx1 = px1 >> 2;
    const cy0 = py0 >> 2;
    const cy1 = py1 >> 2;

    // 4. Two-level conservative Hi-Z test (coarse 16x4 skip -> fine 64x16 early-exit).
    for (let cy = cy0; cy <= cy1; cy++) {
      const cRow = cy * HIZ_COARSE_W;
      const fyStart = (cy << 2) > py0 ? (cy << 2) : py0;
      const fyEnd = ((cy << 2) + 3) < py1 ? ((cy << 2) + 3) : py1;
      for (let cx = cx0; cx <= cx1; cx++) {
        if (testZ > coarse[cRow + cx]) continue; // Entire 4x4 block is strictly in front of occludee!

        const fxStart = (cx << 2) > px0 ? (cx << 2) : px0;
        const fxEnd = ((cx << 2) + 3) < px1 ? ((cx << 2) + 3) : px1;
        for (let fy = fyStart; fy <= fyEnd; fy++) {
          const fRow = fy * HIZ_WIDTH;
          for (let fx = fxStart; fx <= fxEnd; fx++) {
            if (testZ <= fine[fRow + fx]) {
              return AABB_VISIBLE;
            }
          }
        }
      }
    }

    this.stats.culledHiZ++;
    return AABB_OCCLUDED;
  }

  /**
   * Shadow-safe three-state visibility classification (`VIS_CULLED | VIS_SHADOW_ONLY | VIS_BOTH`).
   *
   * When `castShadow` is `true` and the object's body is occluded or outside the main frustum, this projects
   * the object's sun-extruded shadow AABB onto `shadowReceiverY` and tests that shadow volume against Hi-Z:
   * - If the shadow volume reaches visible pixels -> `VIS_SHADOW_ONLY` (draw in CSM, hide in main pass).
   * - Otherwise -> `VIS_CULLED` (hide before BOTH CSM and main pass with zero dropped shadows!).
   */
  classifyAabb(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    castShadow: boolean,
  ): OcclusionVisibility {
    const main = this.testAabb(x0, y0, z0, x1, y1, z1);
    if (main === AABB_VISIBLE) {
      this.stats.visibleCount++;
      return VIS_BOTH;
    }

    if (!castShadow || !this.shadowsActive) {
      return VIS_CULLED;
    }

    // Extrude top of AABB along `-sunDir` down to `shadowReceiverY`.
    const recvY = this.shadowReceiverY;
    const drop = y1 > recvY ? y1 - recvY : 0;
    const sx = -this.sunDirX * drop * this.invSunDirY;
    const sz = -this.sunDirZ * drop * this.invSunDirY;

    const shX0 = sx < 0 ? x0 + sx : x0;
    const shX1 = sx > 0 ? x1 + sx : x1;
    const shZ0 = sz < 0 ? z0 + sz : z0;
    const shZ1 = sz > 0 ? z1 + sz : z1;
    const shY0 = y0 < recvY ? y0 : recvY;

    // Beyond the farthest CSM cascade split, this caster cannot contribute visible shadows anyway.
    if (
      this.shadowMaxDistSq > 0 &&
      distSqPointToAabb(this.eyeX, this.eyeY, this.eyeZ, shX0, shY0, shZ0, shX1, y1, shZ1) > this.shadowMaxDistSq
    ) {
      return VIS_CULLED;
    }

    const shadowVis = this.testAabb(shX0, shY0, shZ0, shX1, y1, shZ1);
    if (shadowVis === AABB_VISIBLE) {
      this.stats.shadowOnlyCount++;
      return VIS_SHADOW_ONLY;
    }
    return VIS_CULLED;
  }

  /** Convenience overload taking a Three.js `Box3` (zero allocations). */
  classifyBox3(box: T.Box3, castShadow: boolean): OcclusionVisibility {
    return this.classifyAabb(box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z, castShadow);
  }

  /** Convenience sphere test (wraps tight AABB around sphere). */
  classifySphere(cx: number, cy: number, cz: number, radius: number, castShadow: boolean): OcclusionVisibility {
    return this.classifyAabb(
      cx - radius, cy - radius, cz - radius,
      cx + radius, cy + radius, cz + radius,
      castShadow,
    );
  }

  // ── Internal Occluder Selection & Conservative Quad Scan Conversion ────────────────────────────

  private insertTopOccluder(index: number, score: number): void {
    let count = this.topCount;
    const scores = this.topScores;
    const indices = this.topIndices;

    if (count === MAX_RASTER_OCCLUDERS && score <= scores[count - 1]) return;

    let pos = count < MAX_RASTER_OCCLUDERS ? count : MAX_RASTER_OCCLUDERS - 1;
    if (count < MAX_RASTER_OCCLUDERS) this.topCount = ++count;

    while (pos > 0 && score > scores[pos - 1]) {
      scores[pos] = scores[pos - 1];
      indices[pos] = indices[pos - 1];
      pos--;
    }
    scores[pos] = score;
    indices[pos] = index;
  }

  /**
   * Clips a 3D convex occluder quad against near & far clip planes and conservatively scan-converts ONLY
   * pixel cells `[ix, ix+1] x [iy, iy+1]` whose ALL 4 corners lie strictly inside the projected polygon,
   * writing the maximum (farthest, conservative) `z_ndc` across each covered cell into `fineZ`.
   */
  private rasterizeQuad(
    m: readonly number[] | Float32Array,
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    x3: number, y3: number, z3: number,
  ): number {
    const ax = this.clipAX, ay = this.clipAY, az = this.clipAZ, aw = this.clipAW;
    const bx = this.clipBX, by = this.clipBY, bz = this.clipBZ, bw = this.clipBW;

    // 1. Transform 4 corners into clip space.
    ax[0] = m[0]*x0 + m[4]*y0 + m[8]*z0  + m[12];
    ay[0] = m[1]*x0 + m[5]*y0 + m[9]*z0  + m[13];
    az[0] = m[2]*x0 + m[6]*y0 + m[10]*z0 + m[14];
    aw[0] = m[3]*x0 + m[7]*y0 + m[11]*z0 + m[15];

    ax[1] = m[0]*x1 + m[4]*y1 + m[8]*z1  + m[12];
    ay[1] = m[1]*x1 + m[5]*y1 + m[9]*z1  + m[13];
    az[1] = m[2]*x1 + m[6]*y1 + m[10]*z1 + m[14];
    aw[1] = m[3]*x1 + m[7]*y1 + m[11]*z1 + m[15];

    ax[2] = m[0]*x2 + m[4]*y2 + m[8]*z2  + m[12];
    ay[2] = m[1]*x2 + m[5]*y2 + m[9]*z2  + m[13];
    az[2] = m[2]*x2 + m[6]*y2 + m[10]*z2 + m[14];
    aw[2] = m[3]*x2 + m[7]*y2 + m[11]*z2 + m[15];

    ax[3] = m[0]*x3 + m[4]*y3 + m[8]*z3  + m[12];
    ay[3] = m[1]*x3 + m[5]*y3 + m[9]*z3  + m[13];
    az[3] = m[2]*x3 + m[6]*y3 + m[10]*z3 + m[14];
    aw[3] = m[3]*x3 + m[7]*y3 + m[11]*z3 + m[15];

    // 2. Clip against exact linear near plane (`cz + cw >= 0`, which also guarantees `cw >= near > 0`).
    let n = clipPolyNear(ax, ay, az, aw, 4, bx, by, bz, bw);
    if (n < 3) return 0;

    // 3. Clip against exact linear far plane (`cw - cz >= 0`).
    n = clipPolyFar(bx, by, bz, bw, n, ax, ay, az, aw);
    if (n < 3) return 0;

    // 4. Perspective divide into pixel space `(0..64, 0..16)` and compute bounding box + depth bounds.
    const psx = this.polySX, psy = this.polySY, psz = this.polySZ;
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    let faceMaxZ = -2.0;

    for (let i = 0; i < n; i++) {
      if (aw[i] <= 1e-6) return 0;
      const invW = 1 / aw[i];
      const sx = (ax[i] * invW * 0.5 + 0.5) * HIZ_WIDTH;
      const sy = (ay[i] * invW * 0.5 + 0.5) * HIZ_HEIGHT;
      let sz = az[i] * invW;
      if (sz > 1.0) sz = 1.0;
      else if (sz < -1.0) sz = -1.0;

      psx[i] = sx;
      psy[i] = sy;
      psz[i] = sz;

      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
      if (sz > faceMaxZ) faceMaxZ = sz;
    }

    // Must span at least 1 whole pixel horizontally and vertically to cover a cell completely.
    const yStart = Math.max(0, Math.floor(minY));
    const yEnd = Math.min(HIZ_HEIGHT - 1, Math.ceil(maxY) - 1);
    const xBound0 = Math.max(0, Math.floor(minX));
    const xBound1 = Math.min(HIZ_WIDTH - 1, Math.ceil(maxX) - 1);
    if (yStart > yEnd || xBound0 > xBound1) return 0;

    // 5. Compute signed screen-space area (verify non-degenerate & winding orientation).
    let area2 = 0;
    for (let i = 0; i < n; i++) {
      const j = i + 1 < n ? i + 1 : 0;
      area2 += psx[i] * psy[j] - psx[j] * psy[i];
    }
    if (Math.abs(area2) < 0.25) return 0;
    const windSign = area2 > 0 ? 1 : -1;

    // 6. Compute exact screen-space affine depth plane `z_ndc(sx, sy) = dzdx * sx + dzdy * sy + zBase`.
    // Pick the triangle `(0, i, i+1)` with largest screen area for maximum numerical precision.
    let bestDet = 0;
    let bestI = 1;
    const sx0 = psx[0], sy0 = psy[0], sz0 = psz[0];
    for (let i = 1; i < n - 1; i++) {
      const det = (psx[i] - sx0) * (psy[i + 1] - sy0) - (psx[i + 1] - sx0) * (psy[i] - sy0);
      if (Math.abs(det) > Math.abs(bestDet)) {
        bestDet = det;
        bestI = i;
      }
    }

    let dzdx = 0;
    let dzdy = 0;
    let zBaseCell = faceMaxZ + OCCLUDER_Z_BIAS;
    if (Math.abs(bestDet) > 1e-3) {
      const invDet = 1 / bestDet;
      const dx1 = psx[bestI] - sx0,     dy1 = psy[bestI] - sy0,     dz1 = psz[bestI] - sz0;
      const dx2 = psx[bestI + 1] - sx0, dy2 = psy[bestI + 1] - sy0, dz2 = psz[bestI + 1] - sz0;
      dzdx = (dz1 * dy2 - dz2 * dy1) * invDet;
      dzdy = (dx1 * dz2 - dx2 * dz1) * invDet;
      // Add worst-case corner shift (`max(0, dzdx) + max(0, dzdy)`) so zCellMax >= true_z at ALL 4 pixel corners!
      zBaseCell =
        (sz0 - dzdx * sx0 - dzdy * sy0) +
        (dzdx > 0 ? dzdx : 0) +
        (dzdy > 0 ? dzdy : 0) +
        OCCLUDER_Z_BIAS;
    }
    const zCap = Math.min(1.0, faceMaxZ + OCCLUDER_Z_BIAS);

    // 7. Precompute conservative inward edge half-spaces for cell `[ix, ix+1] x [iy, iy+1]`.
    // Cell is fully inside edge k iff `nx * ix + ny * iy + edgeC[k] >= 0`.
    const enx = this.edgeNX, eny = this.edgeNY, ec = this.edgeC;
    let edgeCount = 0;
    for (let i = 0; i < n; i++) {
      const j = i + 1 < n ? i + 1 : 0;
      const ex = psx[j] - psx[i];
      const ey = psy[j] - psy[i];
      const elen = Math.hypot(ex, ey);
      if (elen < 1e-5) continue;
      // Inward normal for CCW polygon is `(-ey, ex)` (flipped by `windSign`).
      const nx = (-ey * windSign) / elen;
      const ny = (ex * windSign) / elen;
      const minCornerShift = (nx < 0 ? nx : 0) + (ny < 0 ? ny : 0);
      enx[edgeCount] = nx;
      eny[edgeCount] = ny;
      ec[edgeCount] = -(nx * psx[i] + ny * psy[i]) + minCornerShift - EDGE_CONSERVATIVE_EPS;
      edgeCount++;
    }
    if (edgeCount < 3) return 0;

    // 8. Scanline solve per row (`<= 16` rows): O(edgeCount) interval solve, zero per-pixel edge tests!
    this.stats.rasterizedFaces++;
    const fine = this.fineZ;
    let written = 0;

    for (let iy = yStart; iy <= yEnd; iy++) {
      let rowX0 = xBound0;
      let rowX1 = xBound1;
      let valid = true;

      for (let k = 0; k < edgeCount; k++) {
        const nx = enx[k];
        const rhs = -(eny[k] * iy + ec[k]); // Need `nx * ix >= rhs`.
        if (nx > 1e-7) {
          const lo = Math.ceil(rhs / nx);
          if (lo > rowX0) rowX0 = lo;
        } else if (nx < -1e-7) {
          const hi = Math.floor(rhs / nx);
          if (hi < rowX1) rowX1 = hi;
        } else if (rhs > 0) {
          valid = false;
          break;
        }
        if (rowX0 > rowX1) {
          valid = false;
          break;
        }
      }

      if (!valid) continue;

      const rowOff = iy * HIZ_WIDTH;
      let zVal = zBaseCell + dzdy * iy + dzdx * rowX0;
      for (let ix = rowX0; ix <= rowX1; ix++) {
        const zClamped = zVal > zCap ? zCap : zVal;
        if (zClamped < fine[rowOff + ix]) {
          fine[rowOff + ix] = zClamped;
        }
        zVal += dzdx;
        written++;
      }
    }

    return written;
  }
}

// ── Zero-Alloc Sutherland-Hodgman Clip-Space Polygon Clippers ────────────────────────────────────

function clipPolyNear(
  inX: Float32Array, inY: Float32Array, inZ: Float32Array, inW: Float32Array,
  count: number,
  outX: Float32Array, outY: Float32Array, outZ: Float32Array, outW: Float32Array,
): number {
  let outN = 0;
  let px = inX[count - 1], py = inY[count - 1], pz = inZ[count - 1], pw = inW[count - 1];
  // Exact linear clip plane `cz + cw >= 0`: guarantees `z_ndc >= -1` AND `cw >= near > 0` for perspective
  // (`cz + cw = (2*far/(far-near)) * (cw - near)`) and `cw = 1 > 0` for orthographic cameras.
  let pDist = pz + pw;

  for (let i = 0; i < count; i++) {
    const cx = inX[i], cy = inY[i], cz = inZ[i], cw = inW[i];
    const cDist = cz + cw;

    if (cDist >= 0) {
      if (pDist < 0 && outN < MAX_CLIP_VERTS) {
        const t = pDist / (pDist - cDist);
        outX[outN] = px + (cx - px) * t;
        outY[outN] = py + (cy - py) * t;
        outZ[outN] = pz + (cz - pz) * t;
        outW[outN] = pw + (cw - pw) * t;
        outN++;
      }
      if (outN < MAX_CLIP_VERTS) {
        outX[outN] = cx;
        outY[outN] = cy;
        outZ[outN] = cz;
        outW[outN] = cw;
        outN++;
      }
    } else if (pDist >= 0 && outN < MAX_CLIP_VERTS) {
      const t = pDist / (pDist - cDist);
      outX[outN] = px + (cx - px) * t;
      outY[outN] = py + (cy - py) * t;
      outZ[outN] = pz + (cz - pz) * t;
      outW[outN] = pw + (cw - pw) * t;
      outN++;
    }

    px = cx; py = cy; pz = cz; pw = cw; pDist = cDist;
  }

  return outN;
}

function clipPolyFar(
  inX: Float32Array, inY: Float32Array, inZ: Float32Array, inW: Float32Array,
  count: number,
  outX: Float32Array, outY: Float32Array, outZ: Float32Array, outW: Float32Array,
): number {
  let outN = 0;
  let px = inX[count - 1], py = inY[count - 1], pz = inZ[count - 1], pw = inW[count - 1];
  let pDist = pw - pz;

  for (let i = 0; i < count; i++) {
    const cx = inX[i], cy = inY[i], cz = inZ[i], cw = inW[i];
    const cDist = cw - cz;

    if (cDist >= 0) {
      if (pDist < 0 && outN < MAX_CLIP_VERTS) {
        const t = pDist / (pDist - cDist);
        outX[outN] = px + (cx - px) * t;
        outY[outN] = py + (cy - py) * t;
        outZ[outN] = pz + (cz - pz) * t;
        outW[outN] = pw + (cw - pw) * t;
        outN++;
      }
      if (outN < MAX_CLIP_VERTS) {
        outX[outN] = cx;
        outY[outN] = cy;
        outZ[outN] = cz;
        outW[outN] = cw;
        outN++;
      }
    } else if (pDist >= 0 && outN < MAX_CLIP_VERTS) {
      const t = pDist / (pDist - cDist);
      outX[outN] = px + (cx - px) * t;
      outY[outN] = py + (cy - py) * t;
      outZ[outN] = pz + (cz - pz) * t;
      outW[outN] = pw + (cw - pw) * t;
      outN++;
    }

    px = cx; py = cy; pz = cz; pw = cw; pDist = cDist;
  }

  return outN;
}

// ── Part 2: Auto-Extracted Window & Open-Door Portal Quads (`buildings.ts` & `plan.ts`) ──────────

function makeExteriorPortal(
  id: string,
  alongX: boolean,
  planeCoord: number,
  u0: number,
  u1: number,
  y0: number,
  y1: number,
  outSign: 1 | -1,
  ownerRoomId: string,
  opts?: { doorId?: string; isStudyWindow?: boolean },
): ExteriorPortal {
  const pu0 = u0 - PORTAL_OPENING_PAD_M;
  const pu1 = u1 + PORTAL_OPENING_PAD_M;
  const py0 = y0 - PORTAL_OPENING_PAD_M;
  const py1 = y1 + PORTAL_OPENING_PAD_M;

  const corners = new Float32Array(12);
  let nx = 0, nz = 0;
  let cx = 0, cz = 0;
  const cy = (py0 + py1) * 0.5;

  if (alongX) {
    nz = outSign;
    cx = (pu0 + pu1) * 0.5;
    cz = planeCoord;
    if (outSign < 0) {
      // Looking toward -Z (North): right is +X, up is +Y.
      corners[0] = pu0; corners[1] = py0; corners[2] = planeCoord;
      corners[3] = pu1; corners[4] = py0; corners[5] = planeCoord;
      corners[6] = pu1; corners[7] = py1; corners[8] = planeCoord;
      corners[9] = pu0; corners[10] = py1; corners[11] = planeCoord;
    } else {
      // Looking toward +Z (South): right is -X, up is +Y.
      corners[0] = pu1; corners[1] = py0; corners[2] = planeCoord;
      corners[3] = pu0; corners[4] = py0; corners[5] = planeCoord;
      corners[6] = pu0; corners[7] = py1; corners[8] = planeCoord;
      corners[9] = pu1; corners[10] = py1; corners[11] = planeCoord;
    }
  } else {
    nx = outSign;
    cx = planeCoord;
    cz = (pu0 + pu1) * 0.5;
    if (outSign > 0) {
      // Looking toward +X (East): right is +Z, up is +Y.
      corners[0] = planeCoord; corners[1] = py0; corners[2] = pu0;
      corners[3] = planeCoord; corners[4] = py0; corners[5] = pu1;
      corners[6] = planeCoord; corners[7] = py1; corners[8] = pu1;
      corners[9] = planeCoord; corners[10] = py1; corners[11] = pu0;
    } else {
      // Looking toward -X (West): right is -Z, up is +Y.
      corners[0] = planeCoord; corners[1] = py0; corners[2] = pu1;
      corners[3] = planeCoord; corners[4] = py0; corners[5] = pu0;
      corners[6] = planeCoord; corners[7] = py1; corners[8] = pu0;
      corners[9] = planeCoord; corners[10] = py1; corners[11] = pu1;
    }
  }

  return {
    id,
    corners,
    nx,
    ny: 0,
    nz,
    cx,
    cy,
    cz,
    halfW: (pu1 - pu0) * 0.5,
    halfH: (py1 - py0) * 0.5,
    alongX,
    doorId: opts?.doorId,
    isStudyWindow: opts?.isStudyWindow,
    ownerRoomId,
  };
}

/**
 * Extracts exact window and doorway `ExteriorPortal` quads from an `EnterableBuilding`'s exterior `WallSpan[]`.
 * Works identically for all 13 city buildings and all 5 Market Boulevard residences across all 4 room sizes.
 */
export function extractBuildingPortals(building: EnterableBuilding): BuildingPortalSet {
  const enclosureId = building.property?.id ?? building.id;
  const bcx = (building.rect.x0 + building.rect.x1) * 0.5;
  const bcz = (building.rect.z0 + building.rect.z1) * 0.5;
  const roofY = building.storeys >= 2 ? GROUND_Y + 5.75 : GROUND_Y + 3.5;

  const portals: ExteriorPortal[] = [];
  let pIdx = 0;

  for (let wi = 0; wi < building.walls.length; wi++) {
    const w: WallSpan = building.walls[wi];
    if (w.face !== 'exterior' || w.openings.length === 0) continue;

    const alongX = (w.x1 - w.x0) >= (w.z1 - w.z0);
    // Outward normal points away from building center; inner plane is the wall face closer to interior.
    let outSign: 1 | -1;
    let innerPlane: number;
    if (alongX) {
      const midZ = (w.z0 + w.z1) * 0.5;
      outSign = midZ < bcz ? -1 : 1;
      innerPlane = outSign < 0 ? w.z1 : w.z0;
    } else {
      const midX = (w.x0 + w.x1) * 0.5;
      outSign = midX < bcx ? -1 : 1;
      innerPlane = outSign < 0 ? w.x1 : w.x0;
    }

    for (let oi = 0; oi < w.openings.length; oi++) {
      const o = w.openings[oi];
      if (o.shop) continue; // Opaque parallax shop glass is not a see-through portal.

      const u0 = o.from;
      const u1 = o.to;
      if (u1 - u0 <= 0.05) continue;
      const oy0 = w.y0 + (o.bottom ?? 0);
      const oy1 = w.y0 + o.top;
      if (oy1 - oy0 <= 0.05) continue;

      // Match doorway opening to `building.door`.
      const isDoorOpening =
        o.bottom === undefined &&
        Math.abs((u0 + u1) * 0.5 - (alongX ? building.door.x : building.door.z)) < 0.25 &&
        Math.abs((alongX ? (w.z0 + w.z1) * 0.5 - building.door.z : (w.x0 + w.x1) * 0.5 - building.door.x)) < 0.35;

      portals.push(
        makeExteriorPortal(
          `${enclosureId}:p${pIdx++}`,
          alongX,
          innerPlane,
          u0,
          u1,
          oy0,
          oy1,
          outSign,
          enclosureId,
          isDoorOpening ? { doorId: building.door.id } : undefined,
        ),
      );
    }
  }

  return {
    enclosureId,
    bounds: {
      x0: building.rect.x0,
      y0: GROUND_Y - 0.15,
      z0: building.rect.z0,
      x1: building.rect.x1,
      y1: roofY,
      z1: building.rect.z1,
    },
    portals,
  };
}

/**
 * Extracts exact exterior window and doorway portals for the Starter House (`plan.ts`) across all 4 room sizes
 * (`4, 6, 7.5, 9 m`), indexed by house room/region id (`study`, `hall`, `living`, `kitchen`, `bath`, `bedroom`,
 * `gaming_room`, `stair`, `lobby`, `lobbyFoot`, `garage`).
 *
 * Notice:
 * - `shop: true` opaque bookshop ground windows are skipped automatically.
 * - `balcony` is open-sky (`ceiling === null`) and intentionally has no closed enclosure entry.
 * - Multi-room sightlines (e.g. `study -> hall -> living` when `hall` door opens, or `lobby <-> garage` when
 *   `garage` door opens) are modeled explicitly via `houseRoomPortals` + `doorId` gates so opening an interior
 *   door never hides an exterior window seen through that doorway!
 */
export function extractHousePortalSets(house: HousePlan): Map<string, BuildingPortalSet> {
  const h = house.h;
  const fp = house.footprint;
  const front = house.front;

  // 1. Collect all individual transparent exterior portals from `house.walls` + Study Room window, tagged by room.
  const portalsByRoom = new Map<string, ExteriorPortal[]>();
  const addPortal = (roomId: string, p: ExteriorPortal) => {
    let arr = portalsByRoom.get(roomId);
    if (!arr) {
      arr = [];
      portalsByRoom.set(roomId, arr);
    }
    arr.push(p);
  };

  // Study Room north window (clamped to `[-h, h]` for `size === 4` where `h = 2.0 < STUDY_ROOM_WINDOW.x1`).
  const swX0 = Math.max(-h + 0.05, STUDY_ROOM_WINDOW.x0);
  const swX1 = Math.min(h - 0.05, STUDY_ROOM_WINDOW.x1);
  if (swX1 > swX0 + 0.1) {
    addPortal(
      'study',
      makeExteriorPortal(
        'house:study:north-win',
        true,
        -h,
        swX0,
        swX1,
        STUDY_ROOM_WINDOW.y0,
        STUDY_ROOM_WINDOW.y1,
        -1,
        'study',
        { isStudyWindow: true },
      ),
    );
  }

  // Extract every non-shop opening on exterior walls of `house.walls`.
  const zoneById = new Map(house.zones.map(z => [z.id, z]));
  const hallZone = zoneById.get('hall')!;
  const livingZone = zoneById.get('living')!;
  const bedroomZone = zoneById.get('bedroom')!;
  const gamingZone = zoneById.get('gaming_room')!;
  const lobbyZone = zoneById.get('lobby')!;
  const garageZone = zoneById.get('garage')!;

  const findRoomForOpening = (alongX: boolean, midU: number, wallMidPerp: number, y0: number): string => {
    if (y0 < -0.5) {
      // Ground floor: lobby vs garage.
      if (!alongX && wallMidPerp > garageZone.rect.x0) return 'garage';
      return midU >= garageZone.rect.x0 - 0.1 ? 'garage' : 'lobby';
    }
    // Upper floor.
    if (!alongX) {
      // East walls (`wx1..bx0`): bedroom↔balcony (`z <= gamingZone.rect.z0`) vs gaming_room east window.
      return midU <= bedroomZone.rect.z1 + 0.2 ? 'bedroom' : 'gaming_room';
    }
    if (wallMidPerp <= -h + 0.25) {
      // North exterior wall (`hall` / `living` / `bedroom`).
      if (midU <= hallZone.rect.x1 + 0.2) return 'hall';
      if (midU <= livingZone.rect.x1 + 0.2) return 'living';
      return 'bedroom';
    }
    if (Math.abs(wallMidPerp - gamingZone.rect.z1) < 0.35) {
      return 'gaming_room';
    }
    // Upper south stairwell window at `z = front`.
    return 'stair';
  };

  let idx = 0;
  for (let wi = 0; wi < house.walls.length; wi++) {
    const w = house.walls[wi];
    if (w.face !== 'exterior' || w.openings.length === 0) continue;

    const alongX = (w.x1 - w.x0) >= (w.z1 - w.z0);
    const midPerp = alongX ? (w.z0 + w.z1) * 0.5 : (w.x0 + w.x1) * 0.5;

    // Determine outward normal for each house exterior wall.
    let outSign: 1 | -1;
    let innerPlane: number;
    if (alongX) {
      // North wall (`z <= -h`) faces -Z; south walls (`hallEnd`, `front`) face +Z.
      outSign = midPerp <= -h + 0.25 ? -1 : 1;
      innerPlane = outSign < 0 ? w.z1 : w.z0;
    } else {
      // West walls (`x <= h + WALL`) face -X; east walls (`wx1`, `bx1`) face +X.
      outSign = midPerp <= h + WALL + 0.2 ? -1 : 1;
      innerPlane = outSign < 0 ? w.x1 : w.x0;
    }

    for (let oi = 0; oi < w.openings.length; oi++) {
      const o = w.openings[oi];
      if (o.shop) continue; // Opaque shopfront glass.

      const u0 = o.from;
      const u1 = o.to;
      const oy0 = w.y0 + (o.bottom ?? 0);
      const oy1 = w.y0 + o.top;
      if (u1 - u0 <= 0.05 || oy1 - oy0 <= 0.05) continue;

      const midU = (u0 + u1) * 0.5;
      const roomId = findRoomForOpening(alongX, midU, midPerp, w.y0);

      // Match exterior door if this opening has no sill (`bottom === undefined`).
      let matchedDoorId: string | undefined;
      if (o.bottom === undefined) {
        for (let di = 0; di < house.doors.length; di++) {
          const d = house.doors[di];
          const dAlongX = d.wallAlong === 'x';
          if (dAlongX !== alongX) continue;
          const dU = dAlongX ? d.x : d.z;
          const dPerp = dAlongX ? d.z : d.x;
          if (Math.abs(dU - midU) < 0.25 && Math.abs(dPerp - midPerp) < 0.35 && Math.abs(d.y - w.y0) < 0.35) {
            matchedDoorId = d.id;
            break;
          }
        }
      }

      addPortal(
        roomId,
        makeExteriorPortal(
          `house:${roomId}:p${idx++}`,
          alongX,
          innerPlane,
          u0,
          u1,
          oy0,
          oy1,
          outSign,
          roomId,
          matchedDoorId ? { doorId: matchedDoorId } : undefined,
        ),
      );
    }
  }

  // 2. Build enclosure portal sets per house room, conservatively including portals reachable through open arches/doors.
  const getP = (r: string) => portalsByRoom.get(r) ?? [];
  const houseBounds: Aabb3 = {
    x0: fp.x0,
    y0: GROUND_Y - 0.15,
    z0: fp.z0,
    x1: fp.x1,
    y1: UPPER_WALL_TOP + 0.35,
    z1: front,
  };

  // Helper: wraps neighbor portals with an interior door gate so BOTH connecting door and exterior door must open.
  const gatedByDoor = (list: readonly ExteriorPortal[], gateDoorId: DoorId): ExteriorPortal[] =>
    list.map(p => ({
      ...p,
      id: `${p.id}@via:${gateDoorId}`,
      gateDoorId,
    }));

  const sets = new Map<string, BuildingPortalSet>();
  const registerRoom = (roomId: string, rect: Rect, y0: number, y1: number, portals: ExteriorPortal[]) => {
    sets.set(`house:${roomId}`, {
      enclosureId: `house:${roomId}`,
      bounds: { x0: rect.x0 - WALL, y0: y0 - 0.15, z0: rect.z0 - WALL, x1: rect.x1 + WALL, y1: y1 + 0.3, z1: rect.z1 + WALL },
      portals,
    });
  };

  const upperMainCore = [...getP('hall'), ...getP('living'), ...getP('stair')];
  const studyP = getP('study');
  const bedroomP = getP('bedroom');
  const gamingP = getP('gaming_room');
  const lobbyP = [...getP('lobby'), ...getP('stair')];
  const garageP = getP('garage');

  // Study Room: north study window (if not opaque) + hall/living windows when `hall` door is open.
  registerRoom(
    'study',
    { x0: -h, x1: h, z0: -h, z1: h },
    0,
    UPPER_WALL_TOP,
    [...studyP, ...gatedByDoor(upperMainCore, 'hall')],
  );

  // Hall / Living / Kitchen share open arch + open stair well.
  const hallLivingPortals = [
    ...upperMainCore,
    ...gatedByDoor(studyP, 'hall'),
    ...gatedByDoor(bedroomP, 'bedroom'),
    ...gatedByDoor(gamingP, 'bedroom'),
    ...lobbyP,
  ];
  registerRoom('hall', hallZone.rect, 0, UPPER_WALL_TOP, hallLivingPortals);
  registerRoom('living', livingZone.rect, 0, UPPER_WALL_TOP, hallLivingPortals);
  const kitchenZone = zoneById.get('kitchen')!;
  registerRoom('kitchen', kitchenZone.rect, 0, UPPER_WALL_TOP, hallLivingPortals);

  // Bathroom: zero direct exterior windows; gated strictly by `bath` door!
  const bathZone = zoneById.get('bath')!;
  registerRoom('bath', bathZone.rect, 0, UPPER_WALL_TOP, gatedByDoor(upperMainCore, 'bath'));

  // Bedroom: own north window + balcony door (if open) + gated living/gaming portals.
  registerRoom('bedroom', bedroomZone.rect, 0, UPPER_WALL_TOP, [
    ...bedroomP,
    ...gatedByDoor(upperMainCore, 'bedroom'),
    ...gatedByDoor(gamingP, 'gaming'),
  ]);

  // Gaming studio: own east & south windows + gated bedroom portals.
  registerRoom('gaming_room', gamingZone.rect, 0, UPPER_WALL_TOP, [
    ...gamingP,
    ...gatedByDoor(bedroomP, 'gaming'),
  ]);

  // Staircase connects hall (upper) and lobby (lower).
  const stairZone = zoneById.get('stair')!;
  registerRoom('stair', stairZone.rect, GROUND_Y, UPPER_WALL_TOP, [...upperMainCore, ...lobbyP]);

  // Lobby & lobbyFoot: own south windows + entrance door + stairwell window + gated garage portals.
  const lobbyAll = [...lobbyP, ...gatedByDoor(garageP, 'garage')];
  registerRoom('lobby', lobbyZone.rect, GROUND_Y, 0, lobbyAll);
  const lobbyFootZone = zoneById.get('lobbyFoot')!;
  registerRoom('lobbyFoot', lobbyFootZone.rect, GROUND_Y, 0, lobbyAll);

  // Garage: own south & east windows + garage_out door + gated lobby portals.
  registerRoom('garage', garageZone.rect, GROUND_Y, 0, [...garageP, ...gatedByDoor(lobbyP, 'garage')]);

  // Whole-house fallback set (if caller passes `house:any`).
  sets.set('house:any', {
    enclosureId: 'house:any',
    bounds: houseBounds,
    portals: [...studyP, ...upperMainCore, ...bedroomP, ...gamingP, ...lobbyP, ...garageP],
  });

  return sets;
}

// ── Part 2B: Zero-Alloc `IndoorPortalFrustumCuller` ──────────────────────────────────────────────

export class IndoorPortalFrustumCuller {
  private readonly portalSets = new Map<string, BuildingPortalSet>();

  // Pre-allocated pool of `MAX_ACTIVE_PORTALS` 6-plane sub-frusta (8 × 24 floats = 768 bytes).
  private readonly portalPlanes = new Float32Array(MAX_ACTIVE_PORTALS * 24);
  private readonly portalNdcRects = new Float32Array(MAX_ACTIVE_PORTALS * 4); // [u0, v0, u1, v1]
  private readonly vpMat = new T.Matrix4();
  private readonly fullFrustumPlanes = new Float32Array(24);
  private readonly tmpEye = new T.Vector3();

  private readonly clipAX = new Float32Array(MAX_CLIP_VERTS);
  private readonly clipAY = new Float32Array(MAX_CLIP_VERTS);
  private readonly clipAZ = new Float32Array(MAX_CLIP_VERTS);
  private readonly clipAW = new Float32Array(MAX_CLIP_VERTS);
  private readonly clipBX = new Float32Array(MAX_CLIP_VERTS);
  private readonly clipBY = new Float32Array(MAX_CLIP_VERTS);
  private readonly clipBZ = new Float32Array(MAX_CLIP_VERTS);
  private readonly clipBW = new Float32Array(MAX_CLIP_VERTS);

  // Zero-alloc spatial & screen-edge hysteresis latches (prevent consecutive-frame doorway/window flicker).
  private prevEnclosureId: string | null = null;
  private latchedBoundsFallback = false;
  private latchedAperturePortalIdx = -1;
  private readonly portalVisMask = new Uint8Array(MAX_TRACKED_PORTALS_PER_SET);

  readonly state: IndoorPortalFrameState = {
    active: false,
    enclosureId: null,
    fullExteriorFallback: false,
    visiblePortalCount: 0,
    hideAllExterior: false,
    keepSkyAndHorizon: true,
    evaluatedPortals: 0,
  };

  constructor(house?: HousePlan, city?: CityPlan) {
    if (house && city) {
      this.rebuildFromPlans(house, city);
    }
  }

  /** Rebuilds all city building, residence, and Starter House portal sets for the current room size. */
  rebuildFromPlans(house: HousePlan, city: CityPlan): void {
    this.portalSets.clear();
    this.prevEnclosureId = null;
    this.latchedBoundsFallback = false;
    this.latchedAperturePortalIdx = -1;
    this.portalVisMask.fill(0);
    for (let i = 0; i < city.buildings.length; i++) {
      const set = extractBuildingPortals(city.buildings[i]);
      this.portalSets.set(set.enclosureId, set);
    }
    for (let i = 0; i < city.residences.length; i++) {
      const set = extractBuildingPortals(city.residences[i]);
      this.portalSets.set(set.enclosureId, set);
    }
    const houseSets = extractHousePortalSets(house);
    houseSets.forEach((set, key) => {
      this.portalSets.set(key, set);
    });
  }

  getPortalSet(enclosureId: string): BuildingPortalSet | undefined {
    return this.portalSets.get(enclosureId);
  }

  get registeredEnclosureCount(): number {
    return this.portalSets.size;
  }

  /**
   * Computes active clipped window/open-door sub-frusta for the current frame.
   *
   * @param camera Active camera.
   * @param enclosureId Building id (`library`, `cafe`, `prop_cozy_townhouse`, ...), `house:<roomId>`, or `null` outdoors.
   * @param doors Door openness query (e.g. `{ isDoorOpen: id => { const d = doors.get(id); return !!d && (d.isOpen || Math.abs(d.angle) > 0.03); } }`).
   * @param studyWindowOccluded True when Study Room window has opaque themed view or drawn curtains.
   */
  update(
    camera: T.Camera,
    enclosureId: string | null,
    doors?: DoorStateQuery | null,
    studyWindowOccluded = false,
  ): IndoorPortalFrameState {
    const st = this.state;
    st.enclosureId = enclosureId;
    st.visiblePortalCount = 0;
    st.evaluatedPortals = 0;
    st.fullExteriorFallback = false;

    if (!enclosureId) {
      this.prevEnclosureId = null;
      this.latchedBoundsFallback = false;
      this.latchedAperturePortalIdx = -1;
      this.portalVisMask.fill(0);
      st.active = false;
      st.hideAllExterior = false;
      st.keepSkyAndHorizon = true;
      return st;
    }

    const set = this.portalSets.get(enclosureId);
    if (!set) {
      this.prevEnclosureId = null;
      this.latchedBoundsFallback = false;
      this.latchedAperturePortalIdx = -1;
      this.portalVisMask.fill(0);
      st.active = false;
      st.fullExteriorFallback = true;
      st.hideAllExterior = false;
      st.keepSkyAndHorizon = true;
      return st;
    }

    if (enclosureId !== this.prevEnclosureId) {
      this.prevEnclosureId = enclosureId;
      this.latchedBoundsFallback = false;
      this.latchedAperturePortalIdx = -1;
      this.portalVisMask.fill(0);
    }

    this.vpMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const m = this.vpMat.elements;
    extractFrustumPlanesFromVP(m, this.fullFrustumPlanes);

    camera.getWorldPosition(this.tmpEye);
    const ex = this.tmpEye.x;
    const ey = this.tmpEye.y;
    const ez = this.tmpEye.z;

    // 3rd-person safety guard with spatial hysteresis (`0.22 m` enter vs `0.04 m` exit):
    // if the camera boom sits outside the enclosure bounds while stepping through a doorway, keep exterior visible
    // and never toggle `active` / `fullExteriorFallback` back-and-forth on consecutive frames!
    const b = set.bounds;
    const margin = this.latchedBoundsFallback ? PORTAL_BOUNDS_EXIT_MARGIN : PORTAL_BOUNDS_ENTER_MARGIN;
    if (
      ex < b.x0 - margin || ex > b.x1 + margin ||
      ey < b.y0 - margin || ey > b.y1 + margin ||
      ez < b.z0 - margin || ez > b.z1 + margin
    ) {
      this.latchedBoundsFallback = true;
      st.active = false;
      st.fullExteriorFallback = true;
      st.hideAllExterior = false;
      st.keepSkyAndHorizon = true;
      return st;
    }
    this.latchedBoundsFallback = false;

    const portals = set.portals;

    // Maintain latched doorway/window aperture fallback across a 24 cm spatial hysteresis band
    // so standing in an open doorway or leaning close to a closed glass window never flickers!
    if (this.latchedAperturePortalIdx >= 0 && this.latchedAperturePortalIdx < portals.length) {
      const lp = portals[this.latchedAperturePortalIdx];
      const lpOpen =
        (!lp.gateDoorId || (doors != null && doors.isDoorOpen(lp.gateDoorId))) &&
        (!lp.doorId || (doors != null && doors.isDoorOpen(lp.doorId))) &&
        !(lp.isStudyWindow && studyWindowOccluded);
      if (lpOpen) {
        const lSignedOut = (ex - lp.cx) * lp.nx + (ey - lp.cy) * lp.ny + (ez - lp.cz) * lp.nz;
        const lAlong = Math.abs(lp.alongX ? ex - lp.cx : ez - lp.cz);
        const lVert = Math.abs(ey - lp.cy);
        if (
          lSignedOut > PORTAL_APERTURE_EXIT_IN &&
          lSignedOut < PORTAL_APERTURE_EXIT_OUT &&
          lAlong <= lp.halfW + PORTAL_APERTURE_EXIT_LAT &&
          lVert <= lp.halfH + PORTAL_APERTURE_EXIT_LAT
        ) {
          st.active = true;
          st.fullExteriorFallback = true;
          st.hideAllExterior = false;
          st.keepSkyAndHorizon = true;
          return st;
        }
      }
      this.latchedAperturePortalIdx = -1;
    }

    st.active = true;

    for (let i = 0; i < portals.length; i++) {
      const p = portals[i];
      st.evaluatedPortals++;

      // Skip closed exterior doors, closed connecting interior doors, and occluded Study Room window.
      // Closed transparent glass windows (`doorId === undefined`, `studyWindowOccluded === false`) ALWAYS remain active!
      if (p.gateDoorId && (!doors || !doors.isDoorOpen(p.gateDoorId))) {
        if (i < MAX_TRACKED_PORTALS_PER_SET) this.portalVisMask[i] = 0;
        continue;
      }
      if (p.doorId && (!doors || !doors.isDoorOpen(p.doorId))) {
        if (i < MAX_TRACKED_PORTALS_PER_SET) this.portalVisMask[i] = 0;
        continue;
      }
      if (p.isStudyWindow && studyWindowOccluded) {
        if (i < MAX_TRACKED_PORTALS_PER_SET) this.portalVisMask[i] = 0;
        continue;
      }

      // Signed distance from portal inner plane along outward normal (negative = strictly inside room).
      const signedOut = (ex - p.cx) * p.nx + (ey - p.cy) * p.ny + (ez - p.cz) * p.nz;

      // Near-portal aperture fallback across ALL active portals in this room set (including multi-zone open-arch windows):
      // if eye is within 28 cm of an active window/doorway aperture, promote to full exterior with hysteresis latch.
      if (signedOut > PORTAL_APERTURE_ENTER_IN && signedOut < PORTAL_APERTURE_ENTER_OUT) {
        const dAlong = Math.abs(p.alongX ? ex - p.cx : ez - p.cz);
        const dVert = Math.abs(ey - p.cy);
        if (dAlong <= p.halfW + PORTAL_APERTURE_ENTER_LAT && dVert <= p.halfH + PORTAL_APERTURE_ENTER_LAT) {
          this.latchedAperturePortalIdx = i;
          st.fullExteriorFallback = true;
          st.hideAllExterior = false;
          st.keepSkyAndHorizon = true;
          return st;
        }
      }

      // Eye is already on/beyond the exterior side of this portal plane -> cannot look outward through it.
      if (signedOut >= -0.02) {
        if (i < MAX_TRACKED_PORTALS_PER_SET) this.portalVisMask[i] = 0;
        continue;
      }

      // Clip portal quad against near/far planes into screen NDC.
      const c = p.corners;
      const ax = this.clipAX, ay = this.clipAY, az = this.clipAZ, aw = this.clipAW;
      const bx = this.clipBX, by = this.clipBY, bz = this.clipBZ, bw = this.clipBW;

      for (let v = 0; v < 4; v++) {
        const vx = c[v * 3];
        const vy = c[v * 3 + 1];
        const vz = c[v * 3 + 2];
        ax[v] = m[0]*vx + m[4]*vy + m[8]*vz  + m[12];
        ay[v] = m[1]*vx + m[5]*vy + m[9]*vz  + m[13];
        az[v] = m[2]*vx + m[6]*vy + m[10]*vz + m[14];
        aw[v] = m[3]*vx + m[7]*vy + m[11]*vz + m[15];
      }

      let n = clipPolyNear(ax, ay, az, aw, 4, bx, by, bz, bw);
      if (n < 3) {
        if (i < MAX_TRACKED_PORTALS_PER_SET) this.portalVisMask[i] = 0;
        continue;
      }
      n = clipPolyFar(bx, by, bz, bw, n, ax, ay, az, aw);
      if (n < 3) {
        if (i < MAX_TRACKED_PORTALS_PER_SET) this.portalVisMask[i] = 0;
        continue;
      }

      let u0 = 2.0, u1 = -2.0, v0 = 2.0, v1 = -2.0;
      let validW = true;
      for (let v = 0; v < n; v++) {
        if (aw[v] <= 1e-6) { validW = false; break; }
        const invW = 1 / aw[v];
        const nx = ax[v] * invW;
        const ny = ay[v] * invW;
        if (nx < u0) u0 = nx;
        if (nx > u1) u1 = nx;
        if (ny < v0) v0 = ny;
        if (ny > v1) v1 = ny;
      }
      if (!validW) {
        if (i < MAX_TRACKED_PORTALS_PER_SET) this.portalVisMask[i] = 0;
        continue;
      }

      // Screen-edge NDC hysteresis (`1.01` enter vs `1.09` exit) eliminates grazing-angle flicker!
      const wasVis = i < MAX_TRACKED_PORTALS_PER_SET && this.portalVisMask[i] === 1;
      const ndcLimit = wasVis ? PORTAL_NDC_EXIT_LIMIT : PORTAL_NDC_ENTER_LIMIT;
      if (u1 < -ndcLimit || u0 > ndcLimit || v1 < -ndcLimit || v0 > ndcLimit) {
        if (i < MAX_TRACKED_PORTALS_PER_SET) this.portalVisMask[i] = 0;
        continue;
      }

      u0 = Math.max(-1.0, Math.min(1.0, u0 - PORTAL_NDC_PAD));
      u1 = Math.max(-1.0, Math.min(1.0, u1 + PORTAL_NDC_PAD));
      v0 = Math.max(-1.0, Math.min(1.0, v0 - PORTAL_NDC_PAD));
      v1 = Math.max(-1.0, Math.min(1.0, v1 + PORTAL_NDC_PAD));
      // When grazing just outside `[-1, 1]` under exit hysteresis, preserve a thin conservative edge strip.
      if (wasVis) {
        if (u1 - u0 < 1e-4) {
          if (u0 >= 1.0 - 1e-4) u0 = 1.0 - PORTAL_NDC_PAD;
          else u1 = -1.0 + PORTAL_NDC_PAD;
        }
        if (v1 - v0 < 1e-4) {
          if (v0 >= 1.0 - 1e-4) v0 = 1.0 - PORTAL_NDC_PAD;
          else v1 = -1.0 + PORTAL_NDC_PAD;
        }
      }
      if (u1 - u0 < 1e-4 || v1 - v0 < 1e-4) {
        if (i < MAX_TRACKED_PORTALS_PER_SET) this.portalVisMask[i] = 0;
        continue;
      }

      if (i < MAX_TRACKED_PORTALS_PER_SET) this.portalVisMask[i] = 1;

      if (st.visiblePortalCount < MAX_ACTIVE_PORTALS) {
        const slot = st.visiblePortalCount++;
        const rectOff = slot * 4;
        this.portalNdcRects[rectOff]     = u0;
        this.portalNdcRects[rectOff + 1] = v0;
        this.portalNdcRects[rectOff + 2] = u1;
        this.portalNdcRects[rectOff + 3] = v1;
        this.writeSubFrustumPlanes(slot, m, u0, v0, u1, v1, p.nx, p.ny, p.nz, p.cx, p.cy, p.cz);
      } else {
        // Conservative overflow merge into the last slot's NDC union (without near-plane restriction).
        const slot = MAX_ACTIVE_PORTALS - 1;
        const rectOff = slot * 4;
        const mu0 = Math.min(this.portalNdcRects[rectOff], u0);
        const mv0 = Math.min(this.portalNdcRects[rectOff + 1], v0);
        const mu1 = Math.max(this.portalNdcRects[rectOff + 2], u1);
        const mv1 = Math.max(this.portalNdcRects[rectOff + 3], v1);
        this.portalNdcRects[rectOff]     = mu0;
        this.portalNdcRects[rectOff + 1] = mv0;
        this.portalNdcRects[rectOff + 2] = mu1;
        this.portalNdcRects[rectOff + 3] = mv1;
        // Use camera near plane as safe fallback for merged overflow slot.
        this.writeSubFrustumPlanes(slot, m, mu0, mv0, mu1, mv1, 0, 0, 0, 0, 0, 0);
      }
    }

    st.hideAllExterior = st.visiblePortalCount === 0;
    // G-04 invariant: keep `skyMesh` and `city-horizon-skirt` whenever >= 1 portal is visible!
    st.keepSkyAndHorizon = st.visiblePortalCount > 0;
    return st;
  }

  /** Returns `true` if exterior world AABB is visible through AT LEAST ONE active portal frustum. */
  isAabbVisible(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    const st = this.state;
    if (!st.active || st.fullExteriorFallback) {
      // Outdoors or stepping through an open doorway: fall back to normal full camera frustum.
      return !st.active || aabbIntersects6Planes(this.fullFrustumPlanes, 0, x0, y0, z0, x1, y1, z1);
    }
    const count = st.visiblePortalCount;
    if (count === 0) return false;
    const planes = this.portalPlanes;
    for (let k = 0; k < count; k++) {
      if (aabbIntersects6Planes(planes, k * 24, x0, y0, z0, x1, y1, z1)) return true;
    }
    return false;
  }

  /** Returns `true` if exterior `THREE.Box3` is visible through AT LEAST ONE active portal frustum. */
  isBox3Visible(box: T.Box3): boolean {
    return this.isAabbVisible(box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z);
  }

  /** Returns `true` if exterior world sphere is visible through AT LEAST ONE active portal frustum. */
  isSphereVisible(cx: number, cy: number, cz: number, radius: number): boolean {
    const st = this.state;
    if (!st.active || st.fullExteriorFallback) {
      return !st.active || sphereIntersects6Planes(this.fullFrustumPlanes, 0, cx, cy, cz, radius);
    }
    const count = st.visiblePortalCount;
    if (count === 0) return false;
    const planes = this.portalPlanes;
    for (let k = 0; k < count; k++) {
      if (sphereIntersects6Planes(planes, k * 24, cx, cy, cz, radius)) return true;
    }
    return false;
  }

  /**
   * Constructs 6 inward-facing world-space sub-frustum planes directly from `viewProj` rows:
   * - Left:   `row0 - u0 * row3 >= 0`
   * - Right:  `u1 * row3 - row0 >= 0`
   * - Bottom: `row1 - v0 * row3 >= 0`
   * - Top:    `v1 * row3 - row1 >= 0`
   * - Near:   portal outward plane `n · (P - c) >= -0.25` (or camera near plane when `n == 0`)
   * - Far:    `row3 - row2 >= 0`
   */
  private writeSubFrustumPlanes(
    slot: number,
    m: readonly number[] | Float32Array,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    pnx: number,
    pny: number,
    pnz: number,
    pcx: number,
    pcy: number,
    pcz: number,
  ): void {
    const base = slot * 24;
    const out = this.portalPlanes;

    const r00 = m[0], r01 = m[4], r02 = m[8],  r03 = m[12];
    const r10 = m[1], r11 = m[5], r12 = m[9],  r13 = m[13];
    const r20 = m[2], r21 = m[6], r22 = m[10], r23 = m[14];
    const r30 = m[3], r31 = m[7], r32 = m[11], r33 = m[15];

    writeNormPlane(out, base,      r00 - u0 * r30, r01 - u0 * r31, r02 - u0 * r32, r03 - u0 * r33);
    writeNormPlane(out, base + 4,  u1 * r30 - r00, u1 * r31 - r01, u1 * r32 - r02, u1 * r33 - r03);
    writeNormPlane(out, base + 8,  r10 - v0 * r30, r11 - v0 * r31, r12 - v0 * r32, r13 - v0 * r33);
    writeNormPlane(out, base + 12, v1 * r30 - r10, v1 * r31 - r11, v1 * r32 - r12, v1 * r33 - r13);

    if (pnx !== 0 || pny !== 0 || pnz !== 0) {
      // Allow 0.25 m behind portal inner plane so exterior trim/planters flush against the facade are never clipped.
      const d = -(pnx * pcx + pny * pcy + pnz * pcz) + 0.25;
      writeNormPlane(out, base + 16, pnx, pny, pnz, d);
    } else {
      writeNormPlane(out, base + 16, r30 + r20, r31 + r21, r32 + r22, r33 + r23);
    }

    writeNormPlane(out, base + 20, r30 - r20, r31 - r21, r32 - r22, r33 - r23);
  }
}

// ── Part 3: Zero-Alloc Unified Facade & Shadow-Only Toggle Tracker ───────────────────────────────

export interface OcclusionPortalFrameInput {
  readonly camera: T.Camera;
  readonly enclosureId: string | null;
  readonly sunDirTowardSun?: { x: number; y: number; z: number } | null;
  readonly doors?: DoorStateQuery | null;
  readonly studyWindowOccluded?: boolean;
  readonly shadowsEnabled?: boolean;
  readonly shadowReceiverY?: number;
  readonly shadowMaxDistM?: number;
}

/**
 * Convenience helper for Wave 2 `echoCsm.ts` / `world.ts` integration: tracks `VIS_SHADOW_ONLY`
 * objects & `BatchedMesh` instances so they remain visible during `WebGLShadowMap.render()` and are
 * hidden immediately before the main color pass (and restored afterward), with zero per-frame allocs.
 */
export class ShadowOnlyVisibilityList {
  private readonly objects: T.Object3D[] = [];
  private objectCount = 0;

  private readonly batchMeshes: T.BatchedMesh[] = [];
  private readonly batchInstanceIds: number[] = [];
  private batchCount = 0;

  private hiddenForMain = false;

  reset(): void {
    if (this.hiddenForMain) this.restoreAfterMainPass();
    this.objectCount = 0;
    this.batchCount = 0;
  }

  trackObject(obj: T.Object3D): void {
    const idx = this.objectCount++;
    if (idx < this.objects.length) this.objects[idx] = obj;
    else this.objects.push(obj);
  }

  trackBatchInstance(mesh: T.BatchedMesh, instanceId: number): void {
    const idx = this.batchCount++;
    if (idx < this.batchMeshes.length) {
      this.batchMeshes[idx] = mesh;
      this.batchInstanceIds[idx] = instanceId;
    } else {
      this.batchMeshes.push(mesh);
      this.batchInstanceIds.push(instanceId);
    }
  }

  /** Call at the end of `WebGLShadowMap.render()` (before Three.js runs the main color pass). */
  hideForMainPass(): void {
    if (this.hiddenForMain) return;
    this.hiddenForMain = true;
    for (let i = 0; i < this.objectCount; i++) {
      this.objects[i].visible = false;
    }
    for (let i = 0; i < this.batchCount; i++) {
      this.batchMeshes[i].setVisibleAt(this.batchInstanceIds[i], false);
    }
  }

  /** Call right after `renderer.render()` (or before next shadow pass) to restore shadow-only casters. */
  restoreAfterMainPass(): void {
    if (!this.hiddenForMain) return;
    this.hiddenForMain = false;
    for (let i = 0; i < this.objectCount; i++) {
      this.objects[i].visible = true;
    }
    for (let i = 0; i < this.batchCount; i++) {
      this.batchMeshes[i].setVisibleAt(this.batchInstanceIds[i], true);
    }
  }

  get trackedCount(): number {
    return this.objectCount + this.batchCount;
  }
}

/**
 * Unified Echo Life Occlusion + Portal Culling coordinator.
 * Automatically dispatches between `IndoorPortalFrustumCuller` (when enclosed inside a city building,
 * residence, or closed Starter House room) and `OutdoorHiZOcclusionCuller` (when outdoors / on balcony).
 */
export class EchoLifeOcclusionPortalCuller {
  readonly outdoor: OutdoorHiZOcclusionCuller;
  readonly indoor: IndoorPortalFrustumCuller;
  readonly shadowOnly = new ShadowOnlyVisibilityList();

  private mode: 'outdoor' | 'indoor' = 'outdoor';
  private readonly outdoorOpts = {
    shadowsEnabled: true,
    shadowReceiverY: DEFAULT_SHADOW_RECEIVER_Y,
    shadowMaxDistM: 155,
  };

  constructor(house: HousePlan, city: CityPlan, opts?: OccluderExtractOptions) {
    this.outdoor = new OutdoorHiZOcclusionCuller(extractStaticOccluders(house, city, opts));
    this.indoor = new IndoorPortalFrustumCuller(house, city);
  }

  /**
   * Rebuilds static occluders and indoor portal sets when the player changes Study Room size (`4, 6, 7.5, 9 m`).
   */
  rebuild(house: HousePlan, city: CityPlan, opts?: OccluderExtractOptions): void {
    this.outdoor.clearOccluders();
    const occs = extractStaticOccluders(house, city, opts);
    for (let i = 0; i < occs.length; i++) {
      this.outdoor.registerOccluder(occs[i]);
    }
    this.indoor.rebuildFromPlans(house, city);
  }

  /** Updates either the indoor portal frusta or the outdoor 64x16 Hi-Z buffer for this frame. */
  beginFrame(input: OcclusionPortalFrameInput): 'outdoor' | 'indoor' {
    this.shadowOnly.reset();

    if (input.enclosureId) {
      const pState = this.indoor.update(
        input.camera,
        input.enclosureId,
        input.doors,
        input.studyWindowOccluded ?? false,
      );
      if (pState.active && !pState.fullExteriorFallback) {
        this.mode = 'indoor';
        return 'indoor';
      }
    } else {
      this.indoor.update(input.camera, null, null, false);
    }

    this.mode = 'outdoor';
    this.outdoorOpts.shadowsEnabled = input.shadowsEnabled ?? true;
    this.outdoorOpts.shadowReceiverY = input.shadowReceiverY ?? DEFAULT_SHADOW_RECEIVER_Y;
    this.outdoorOpts.shadowMaxDistM = input.shadowMaxDistM ?? 155;
    this.outdoor.beginFrame(input.camera, input.sunDirTowardSun, this.outdoorOpts);
    return 'outdoor';
  }

  get activeMode(): 'outdoor' | 'indoor' {
    return this.mode;
  }

  /** G-04 sky-void invariant: always true outdoors or whenever >= 1 indoor portal is visible. */
  get keepSkyAndHorizon(): boolean {
    return this.mode === 'outdoor' || this.indoor.state.keepSkyAndHorizon;
  }

  /** Fast-path flag: true iff enclosed with zero visible windows/open doors (hide 100% of exterior). */
  get hideAllExterior(): boolean {
    return this.mode === 'indoor' && this.indoor.state.hideAllExterior;
  }

  /**
   * Unified exterior AABB visibility query across both indoor portal mode and outdoor Hi-Z mode.
   * When indoors, shadows are disabled outdoors (`echoCsm` inactive indoors), so returns `VIS_BOTH` or `VIS_CULLED`.
   */
  classifyExteriorAabb(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    castShadow: boolean,
  ): OcclusionVisibility {
    if (this.mode === 'indoor') {
      return this.indoor.isAabbVisible(x0, y0, z0, x1, y1, z1) ? VIS_BOTH : VIS_CULLED;
    }
    return this.outdoor.classifyAabb(x0, y0, z0, x1, y1, z1, castShadow);
  }

  classifyExteriorSphere(
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    castShadow: boolean,
  ): OcclusionVisibility {
    if (this.mode === 'indoor') {
      return this.indoor.isSphereVisible(cx, cy, cz, radius) ? VIS_BOTH : VIS_CULLED;
    }
    return this.outdoor.classifySphere(cx, cy, cz, radius, castShadow);
  }
}

/**
 * Helper adapting a `Map<DoorId, { isOpen: boolean; angle: number }>` (like `house.doors` / `buildingsView.doors`)
 * to `DoorStateQuery` with zero per-frame allocations.
 */
export function createDoorMapQuery(
  doors: ReadonlyMap<string, { readonly isOpen: boolean; readonly angle: number }>,
): DoorStateQuery {
  return {
    isDoorOpen(doorId: string): boolean {
      const d = doors.get(doorId);
      return !!d && (d.isOpen || Math.abs(d.angle) > DOOR_OPEN_ANGLE_EPS);
    },
  };
}
