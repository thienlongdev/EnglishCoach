import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GROUND_Y, inRect, rect as makeRect, type HousePlan, type Rect } from '@/lib/echo-life/plan';
import { hash01, type CityPlan } from '@/lib/echo-life/city';
import type { V3ZoneId } from '@/lib/echo-life/zones';
import type { QualityTier } from './renderConfig';
import type { SharedWeatherUniforms } from './weatherSystem';
import {
  VEGETATION_BY_ID,
  VEGETATION_MANIFEST,
  type VegetationCategory,
  type VegetationSpecies,
} from './vegetationManifest';
import {
  acquireStreetProp,
  instanceStreetProp,
  placeStreetPropOn,
  releaseStreetProp,
} from './streetPropsManifest';
import { chainMaterialShader, patchMaterialWithEchoCsm } from './echoCsm';
import { getSharedHeightFogUniforms, patchHeightFog } from './atmosphere';
import { getEchoLifeTextureUploadQueue, LoadPriority } from './loadScheduler';
import { clampToBounds } from './streaming';

/**
 * Echo Life Total Rebirth — Ecological Botanical Vegetation Ecosystem Controller (A03 / Wave 2B).
 *
 * Replaces legacy primitive trees with the 22-species, 30-GLB photorealistic botanical library
 * staged in `/echo-life/vegetation/` (standard glTF 2.0 + WebP textures, ZERO WASM decoders):
 * - Deterministic zone-aware ecological layout across every outdoor district (`park`, `botanical`,
 *   `campus`, `fountain_plaza`, `fair`, `greenway`, `lantern_garden`, `yard`, and street-side
 *   green verges) with mathematically verified zero overlap against roads, sidewalks, crossings,
 *   buildings, residences, starter house, doors, basketball court, badminton court, and river.
 * - True distance-based GPU instanced LOD0 <-> LOD1 switching at 4 Hz with hysteresis and sector
 *   visibility culling (`north` / `south` / `sides`), using pre-allocated `InstancedMesh` buffers
 *   and static bounding spheres (zero per-frame allocations or `computeBoundingSphere()` churn).
 * - Coordinated GPU vertex wind shader (`onBeforeCompile`) synchronized with `SharedWeatherUniforms`
 *   so gusts travel spatially across `(worldPos.x, worldPos.z)` with locked ground bases (`Y = 0`),
 *   plus 4-season foliage tinting (never tinting bark/trunks/rocks) and winter snow frosting.
 */

export interface VegetationSystemOptions {
  city: CityPlan;
  house: HousePlan;
  quality: QualityTier;
  weatherUniforms?: SharedWeatherUniforms;
  maxAnisotropy?: number;
}

export interface VegetationStats {
  treeCount: number;
  understoryCount: number;
  activeLod0: number;
  activeLod1: number;
  loadedSpecies: number;
}

export type SectorKey = 'north' | 'south' | 'sides';

export interface VegetationPlacement {
  readonly id: number;
  readonly speciesId: string;
  readonly category: VegetationCategory;
  readonly zone: V3ZoneId | 'verge';
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
  readonly rotY: number;
  readonly leanX: number;
  readonly leanZ: number;
  readonly sector: SectorKey;
  /** Optional priority tier (`0` = essential kept even on `low`, `1` = balanced+, `2` = high/ultra detail). */
  readonly detailTier: 0 | 1 | 2;
}

export interface VegetationExclusions {
  readonly roadsAndCrossings: Rect[];
  readonly sidewalks: Rect[];
  readonly buildingsAndLots: Rect[];
  readonly basketballCourts: Rect[];
  readonly badmintonCourts: Rect[];
  readonly doorClearances: { x: number; z: number; r: number }[];
  readonly propClearances: { x: number; z: number; r: number; kind: string }[];
  readonly studyWindowView: Rect;
  readonly riverSafeZ: number;
  readonly cityBounds: Rect;
}

export interface VegetationLayoutResult {
  readonly placements: VegetationPlacement[];
  readonly trees: VegetationPlacement[];
  readonly understory: VegetationPlacement[];
  readonly exclusions: VegetationExclusions;
}

interface TierPolicy {
  readonly lod0Dist: number;
  readonly lod1Dist: number;
  readonly understoryDist: number;
  readonly hysteresis: number;
  readonly lod0OnlyDisabled: boolean; // true on `low` -> always use LOD1 for trees
  readonly maxDetailTier: 0 | 1 | 2;
  readonly maxDrawCalls: number;
  readonly castTreeShadows: boolean;
  readonly castBoulderShadows: boolean;
  readonly receiveFoliageShadows: boolean;
  readonly defaultAnisotropy: number;
}

const TIER_POLICY: Record<QualityTier, TierPolicy> = {
  ultra: {
    lod0Dist: 58,
    lod1Dist: 155,
    understoryDist: 65,
    hysteresis: 5.5,
    lod0OnlyDisabled: false,
    maxDetailTier: 2,
    maxDrawCalls: 34,
    castTreeShadows: true,
    castBoulderShadows: true,
    receiveFoliageShadows: true,
    defaultAnisotropy: 12,
  },
  high: {
    lod0Dist: 48,
    lod1Dist: 130,
    understoryDist: 50,
    hysteresis: 5.0,
    lod0OnlyDisabled: false,
    maxDetailTier: 2,
    maxDrawCalls: 34,
    castTreeShadows: true,
    castBoulderShadows: true,
    receiveFoliageShadows: true,
    defaultAnisotropy: 8,
  },
  balanced: {
    lod0Dist: 34,
    lod1Dist: 105,
    understoryDist: 36,
    hysteresis: 4.5,
    lod0OnlyDisabled: false,
    maxDetailTier: 1,
    maxDrawCalls: 32,
    castTreeShadows: false,
    castBoulderShadows: false,
    receiveFoliageShadows: false,
    defaultAnisotropy: 4,
  },
  low: {
    lod0Dist: 0,
    lod1Dist: 85,
    understoryDist: 24,
    hysteresis: 4.0,
    lod0OnlyDisabled: true,
    maxDetailTier: 0,
    maxDrawCalls: 18,
    castTreeShadows: false,
    castBoulderShadows: false,
    receiveFoliageShadows: false,
    defaultAnisotropy: 2,
  },
};

// 4-Season foliage multiplicative tint table: [Spring, Summer, Autumn, Winter].
// Bark, trunks, crownshafts, rocks, and non-tintable evergreen species NEVER receive these tints.
const SEASON_TINTS_DEFAULT: readonly [number, number, number][] = [
  [1.10, 1.22, 0.94], // Spring: fresh sunlit emerald vibrancy
  [1.06, 1.16, 0.97], // Summer: lush sunlit tropical green
  [1.26, 0.88, 0.52], // Autumn: warm golden-amber foliage shift
  [0.86, 0.91, 0.95], // Winter: cool muted slate-emerald
];

const SEASON_TINTS_BANYAN: readonly [number, number, number][] = [
  [1.18, 1.32, 1.00], // Spring: bright sunlit Ficus canopy bounce
  [1.14, 1.26, 1.00], // Summer: lush sunlit broadleaf emerald
  [1.28, 0.94, 0.56], // Autumn: warm amber-bronze Ficus crown
  [0.92, 0.98, 0.98], // Winter: crisp cool winter Ficus green
];

const SEASON_TINTS_FLAME: readonly [number, number, number][] = [
  [1.10, 1.04, 1.04], // Spring: rosy-coral early blossoms + sunlit fern leaves
  [1.08, 1.04, 0.96], // Summer: peak fiery scarlet-orange Phượng Vĩ bloom!
  [1.16, 0.90, 0.62], // Autumn: copper-amber late season
  [0.84, 0.88, 0.92], // Winter: subdued frosted crown
];

const SEASON_TINTS_JACARANDA: readonly [number, number, number][] = [
  [1.08, 1.10, 1.20], // Spring: sunlit lavender-violet tinted spring canopy
  [1.06, 1.14, 0.98], // Summer: vibrant sunlit bipinnate canopy
  [1.24, 0.94, 0.56], // Autumn: warm golden-honey leaflets
  [0.86, 0.90, 0.94], // Winter: cool frosted silhouette
];

const SEASON_TINTS_GRASS: readonly [number, number, number][] = [
  [1.08, 1.16, 0.92],
  [1.04, 1.10, 0.96],
  [1.18, 0.96, 0.64],
  [0.88, 0.92, 0.88],
];

// Explicit badminton court clearance requested for South receiving spot & full rally envelope.
const EXPLICIT_BADMINTON_COURT_RECT: Rect = makeRect(-34, -22, -26, -14);
// Keep the primary Riverside Park walkway spawn corridor clear of low hanging tree branches & boulders.
const PARK_WALKWAY_SPAWN_CORRIDOR: Rect = makeRect(24.0, 38.0, -32.2, -28.2);

function inExpandedRect(x: number, z: number, r: Rect, pad: number): boolean {
  return x >= r.x0 - pad && x <= r.x1 + pad && z >= r.z0 - pad && z <= r.z1 + pad;
}

const VEGETATION_LAYOUT_CACHE = new WeakMap<CityPlan, WeakMap<HousePlan, VegetationLayoutResult>>();

function classifySector(z: number, x: number, house: HousePlan, city: CityPlan): SectorKey {
  if (z < house.footprint.z0) return 'north';
  if (
    z > house.front - 1 &&
    ((x > city.bounds.x0 + 30 && x < city.bounds.x1 - 30) || z < house.front + 14)
  ) {
    return 'south';
  }
  return 'sides';
}

function buildExclusions(city: CityPlan, house: HousePlan): VegetationExclusions {
  const roadsAndCrossings: Rect[] = [];
  const sidewalks: Rect[] = [];
  for (const gr of city.ground) {
    if (gr.surface === 'road' || gr.surface === 'crossing') {
      roadsAndCrossings.push(gr.rect);
    } else if (gr.surface === 'sidewalk') {
      sidewalks.push(gr.rect);
    }
  }

  const buildingsAndLots: Rect[] = [house.footprint];
  for (const b of city.buildings) buildingsAndLots.push(b.rect);
  for (const res of city.residences) buildingsAndLots.push(res.rect);
  for (const lot of city.lots) buildingsAndLots.push(lot.rect);

  // Basketball half-court slabs: `cityView.ts` builds an 11.6×11.6 m slab offset 4.8 m in front of every `hoop-post`.
  const basketballCourts: Rect[] = [];
  for (const pr of city.props) {
    if (pr.asset === 'hoop-post') {
      const nx = Math.sin(pr.rotY);
      const nz = Math.cos(pr.rotY);
      const cx = pr.x + nx * 4.8;
      const cz = pr.z + nz * 4.8;
      basketballCourts.push(makeRect(cx - 6.2, cx + 6.2, cz - 6.2, cz + 6.2));
    }
  }

  // Badminton courts: both explicit south-court envelope and every `badminton-net` prop in `city.props`.
  const badmintonCourts: Rect[] = [EXPLICIT_BADMINTON_COURT_RECT];
  for (const pr of city.props) {
    if (pr.asset === 'badminton-net') {
      badmintonCourts.push(makeRect(pr.x - 5.2, pr.x + 5.2, pr.z - 6.8, pr.z + 6.8));
    }
  }

  // Door clearances (front door, garage street door, and every enterable building door).
  const doorClearances: { x: number; z: number; r: number }[] = [];
  for (const d of house.doors) {
    if (d.id === 'entrance' || d.id === 'garage_out') {
      doorClearances.push({ x: d.x, z: d.z, r: 3.6 });
    }
  }
  for (const b of city.buildings) {
    doorClearances.push({ x: b.outsidePoint.x, z: b.outsidePoint.z, r: 3.6 });
    doorClearances.push({ x: b.entryPoint.x, z: b.entryPoint.z, r: 3.2 });
  }
  for (const res of city.residences) {
    doorClearances.push({ x: res.outsidePoint.x, z: res.outsidePoint.z, r: 3.4 });
  }

  // All non-tree static props (benches, lamps, gazebos, fountain, fair rides, campus arches, etc.).
  const propClearances: { x: number; z: number; r: number; kind: string }[] = [];
  for (const pr of city.props) {
    if (pr.kind === 'tree') continue;
    const baseR = pr.asset === 'bld-minka'
      ? Math.max(pr.radius, 5.2)
      : pr.asset === 'park-gazebo'
        ? Math.max(pr.radius, 3.0)
        : pr.asset === 'fair-ferris' || pr.asset === 'fair-carousel'
          ? Math.max(pr.radius, 3.4)
          : pr.asset === 'festival-stage'
            ? Math.max(pr.radius, 3.8)
            : pr.asset === 'campus-gate'
              ? Math.max(pr.radius, 4.6)
              : pr.asset === 'campus-colonnade'
                ? Math.max(pr.radius, 3.4)
                : pr.asset === 'fountain-tiered'
                  ? Math.max(pr.radius, 2.8)
                  : Math.max(pr.radius, 0.55);
    propClearances.push({ x: pr.x, z: pr.z, r: baseR, kind: pr.asset ?? pr.kind });
  }

  // Preserve open northern sightline from the Study Room window across back yard toward Riverside Park & River.
  const studyWindowView: Rect = makeRect(-house.h - 2.4, house.h + 2.4, house.footprint.z0 - 6.2, house.footprint.z0 + 0.5);

  return {
    roadsAndCrossings,
    sidewalks,
    buildingsAndLots,
    basketballCourts,
    badmintonCourts,
    doorClearances,
    propClearances,
    studyWindowView,
    riverSafeZ: city.river.z1 + 0.9,
    cityBounds: city.bounds,
  };
}

/**
 * Pure deterministic ecological placement planner for all 22 botanical species across the 31-zone city.
 * Exported so unit/contract tests can audit every coordinate against roads, sidewalks, buildings, and courts.
 */
export function buildVegetationLayout(city: CityPlan, house: HousePlan): VegetationLayoutResult {
  const byHouse = VEGETATION_LAYOUT_CACHE.get(city);
  const cached = byHouse?.get(house);
  if (cached) return cached;

  const ex = buildExclusions(city, house);
  const trees: VegetationPlacement[] = [];
  const understory: VegetationPlacement[] = [];
  let nextId = 1;

  const zoneRectOf = (id: V3ZoneId): Rect | null => city.zones.find(z => z.id === id)?.rect ?? null;
  const parkRectForClear = zoneRectOf('park');
  // Keep Scene 17 Riverside Park social clearing open around Minh Thu & camera sightline (no blocking banyan canopy!).
  const parkSocialClearing = parkRectForClear
    ? { cx: parkRectForClear.x0 + 32.0, cz: parkRectForClear.z0 + 6.8, rx: 5.5, rz: 4.2 }
    : null;

  // Check whether a point (x, z) is mathematically clear of ALL exclusions (zero temporary object allocations).
  const isClear = (x: number, z: number, isTree: boolean, allowNearBench = false): boolean => {
    const edgePad = isTree ? 1.15 : 0.6;
    if (
      x < ex.cityBounds.x0 + edgePad ||
      x > ex.cityBounds.x1 - edgePad ||
      z < Math.max(ex.riverSafeZ + (isTree ? 0.85 : 0.2), ex.cityBounds.z0 + (isTree ? 0.9 : 0.4)) ||
      z > ex.cityBounds.z1 - edgePad
    ) {
      return false;
    }

    const roadPad = isTree ? 0.72 : 0.42;
    for (const r of ex.roadsAndCrossings) {
      if (inExpandedRect(x, z, r, roadPad)) return false;
    }

    // Strict zero-overlap with every sidewalk rectangle (zero sidewalk encroachment!)
    const swPad = isTree ? 0.45 : 0.24;
    for (const r of ex.sidewalks) {
      if (inExpandedRect(x, z, r, swPad)) return false;
    }

    const bldPad = isTree ? 1.45 : 0.72;
    for (const r of ex.buildingsAndLots) {
      if (inExpandedRect(x, z, r, bldPad)) return false;
    }

    // Generous 3.5 m tree clearance around basketball courts so foreground leaf cards never crowd court sightlines (Scene 10).
    const bballPad = isTree ? 3.5 : 0.9;
    for (const r of ex.basketballCourts) {
      if (inExpandedRect(x, z, r, bballPad)) return false;
    }
    const courtPad = isTree ? 1.4 : 0.9;
    for (const r of ex.badmintonCourts) {
      if (inExpandedRect(x, z, r, courtPad)) return false;
    }

    if (isTree && inExpandedRect(x, z, ex.studyWindowView, 0)) return false;
    if (isTree && inExpandedRect(x, z, PARK_WALKWAY_SPAWN_CORRIDOR, 0)) return false;
    if (isTree && parkSocialClearing) {
      const nx = (x - parkSocialClearing.cx) / parkSocialClearing.rx;
      const nz = (z - parkSocialClearing.cz) / parkSocialClearing.rz;
      if (nx * nx + nz * nz < 1.0) return false;
    }

    const doorScale = isTree ? 1.0 : 0.65;
    for (const d of ex.doorClearances) {
      if (Math.hypot(x - d.x, z - d.z) < d.r * doorScale) return false;
    }

    for (const pr of ex.propClearances) {
      const extra = isTree
        ? 1.15
        : allowNearBench && pr.kind === 'bench'
          ? 0.42
          : 0.65;
      if (Math.hypot(x - pr.x, z - pr.z) < pr.r + extra) return false;
    }

    return true;
  };

  const canPlaceTree = (x: number, z: number, speciesId: string, minDistOverride?: number): boolean => {
    if (!isClear(x, z, true)) return false;
    const sp = VEGETATION_BY_ID[speciesId];
    const baseMin = minDistOverride ?? (sp && sp.crownRadius > 4.6 ? 5.2 : sp && sp.crownRadius < 2.8 ? 3.5 : 4.2);
    for (const existing of trees) {
      const exSp = VEGETATION_BY_ID[existing.speciesId];
      const pairMin = Math.max(baseMin, exSp && exSp.crownRadius > 4.6 ? 4.8 : 3.4);
      if (Math.hypot(x - existing.x, z - existing.z) < pairMin) return false;
    }
    return true;
  };

  const canPlaceUnderstory = (x: number, z: number, minDist = 0.95, allowNearBench = false): boolean => {
    if (!isClear(x, z, false, allowNearBench)) return false;
    // Keep understory clear of tree trunk bases (`>= 0.72 m` from trunk axis) while tucking nicely under canopies!
    for (const tr of trees) {
      if (Math.hypot(x - tr.x, z - tr.z) < 0.78) return false;
    }
    for (const u of understory) {
      if (Math.hypot(x - u.x, z - u.z) < minDist) return false;
    }
    return true;
  };

  const pushTree = (
    speciesId: string,
    zone: V3ZoneId | 'verge',
    x: number,
    z: number,
    seedA: number,
    seedB: number,
    scaleRange: [number, number] = [0.85, 1.16],
    detailTier: 0 | 1 | 2 = 0,
    minDistOverride?: number,
  ): VegetationPlacement | null => {
    if (!VEGETATION_BY_ID[speciesId]) return null;
    if (!canPlaceTree(x, z, speciesId, minDistOverride)) return null;
    const h0 = hash01(seedA, seedB);
    const h1 = hash01(seedA + 31, seedB + 17);
    const h2 = hash01(seedA + 67, seedB + 53);
    const h3 = hash01(seedA + 109, seedB + 89);
    const scale = scaleRange[0] + h0 * (scaleRange[1] - scaleRange[0]);
    const rotY = h1 * Math.PI * 2;
    // Subtle organic botanical lean (±3.8° max so zero clones look ruler-straight!)
    const maxLean = speciesId === 'veg-tree-palm-royal' ? 0.068 : 0.045;
    const leanX = (h2 - 0.5) * 2 * maxLean;
    const leanZ = (h3 - 0.5) * 2 * maxLean;
    const p: VegetationPlacement = {
      id: nextId++,
      speciesId,
      category: 'tree',
      zone,
      x: Math.round(x * 100) / 100,
      y: GROUND_Y,
      z: Math.round(z * 100) / 100,
      scale: Math.round(scale * 1000) / 1000,
      rotY: Math.round(rotY * 1000) / 1000,
      leanX: Math.round(leanX * 1000) / 1000,
      leanZ: Math.round(leanZ * 1000) / 1000,
      sector: classifySector(z, x, house, city),
      detailTier,
    };
    trees.push(p);
    return p;
  };

  const pushUnderstory = (
    speciesId: string,
    zone: V3ZoneId | 'verge',
    x: number,
    z: number,
    seedA: number,
    seedB: number,
    scaleRange: [number, number] = [0.82, 1.24],
    detailTier: 0 | 1 | 2 = 1,
    minDist = 0.95,
    allowNearBench = false,
    yOffset = 0,
  ): VegetationPlacement | null => {
    const sp = VEGETATION_BY_ID[speciesId];
    if (!sp) return null;
    if (!canPlaceUnderstory(x, z, minDist, allowNearBench)) return null;
    const h0 = hash01(seedA, seedB);
    const h1 = hash01(seedA + 23, seedB + 41);
    const h2 = hash01(seedA + 59, seedB + 73);
    const scale = scaleRange[0] + h0 * (scaleRange[1] - scaleRange[0]);
    const rotY = h1 * Math.PI * 2;
    const leanX = sp.category === 'rock' ? 0 : (h2 - 0.5) * 0.07;
    const leanZ = sp.category === 'rock' ? 0 : (hash01(seedA + 97, seedB + 11) - 0.5) * 0.07;
    const p: VegetationPlacement = {
      id: nextId++,
      speciesId,
      category: sp.category,
      zone,
      x: Math.round(x * 100) / 100,
      y: Math.round((GROUND_Y + yOffset) * 1000) / 1000,
      z: Math.round(z * 100) / 100,
      scale: Math.round(scale * 1000) / 1000,
      rotY: Math.round(rotY * 1000) / 1000,
      leanX: Math.round(leanX * 1000) / 1000,
      leanZ: Math.round(leanZ * 1000) / 1000,
      sector: classifySector(z, x, house, city),
      detailTier,
    };
    understory.push(p);
    return p;
  };

  /**
   * Sculpted Poly Haven CC0-1.0 granite rock outcrop cluster replacing smooth `veg-rock-boulder` eggs (Scenes 01, 12):
   * places 2-3 intersecting scaled `veg-rock-garden` meshes at varied yaw angles, sunk -0.12 m cleanly into the turf!
   */
  const pushRockCluster = (
    zone: V3ZoneId | 'verge',
    bx: number,
    bz: number,
    seedA: number,
    seedB: number,
    detailTier: 0 | 1 | 2 = 1,
  ): void => {
    const main = pushUnderstory('veg-rock-garden', zone, bx, bz, seedA, seedB, [1.55, 2.05], detailTier, 1.05, false, -0.12);
    if (!main) return;
    const subCount = hash01(seedA + 17, seedB + 29) > 0.45 ? 2 : 1;
    const baseAng = hash01(seedA + 43, seedB + 13) * Math.PI * 2;
    for (let k = 0; k < subCount; k++) {
      const ang = baseAng + k * 2.15 + 0.35;
      const dist = 0.36 + hash01(seedA + k * 19, seedB + 7) * 0.18;
      pushUnderstory(
        'veg-rock-garden',
        zone,
        main.x + Math.cos(ang) * dist,
        main.z + Math.sin(ang) * dist,
        seedA + 71 + k * 23,
        seedB + 11 + k * 5,
        [1.35, 1.72],
        detailTier,
        0.28,
        false,
        -0.12,
      );
    }
  };

  const tryPlaceWithJitter = (
    speciesId: string,
    zone: V3ZoneId | 'verge',
    baseX: number,
    baseZ: number,
    seed: number,
    scaleRange: [number, number],
    detailTier: 0 | 1 | 2,
    minDist?: number,
  ): VegetationPlacement | null => {
    const offsets: [number, number][] = [
      [0, 0], [1.2, 0.8], [-1.2, -0.8], [0.9, -1.3], [-1.0, 1.3], [2.1, 0], [-2.1, 0],
    ];
    for (let k = 0; k < offsets.length; k++) {
      const [ox, oz] = offsets[k];
      const placed = pushTree(speciesId, zone, baseX + ox, baseZ + oz, seed + k * 13, 17 + k, scaleRange, detailTier, minDist);
      if (placed) return placed;
    }
    return null;
  };

  // =========================================================================
  // 1. RIVERSIDE PARK (`park`): Royal Palms promenade + Banyan / Tropical Shade groves + understory
  // =========================================================================
  const parkRect = zoneRectOf('park');
  if (parkRect) {
    // 1a) Scenic curved Royal Palms lining the north riverfront promenade (varied height/lean/yaw!)
    let pIdx = 0;
    for (let px = parkRect.x0 + 4.8; px < parkRect.x1 - 3.8; px += 8.6) {
      pIdx++;
      const jx = (hash01(pIdx, 101) - 0.5) * 2.2;
      const jz = hash01(pIdx, 107) * 1.5;
      const palm = tryPlaceWithJitter(
        'veg-tree-palm-royal', 'park',
        px + jx, parkRect.z0 + 2.2 + jz,
        1000 + pIdx, [0.85, 1.18], pIdx % 2 === 0 ? 0 : 1, 3.8,
      );
      if (palm) {
        const ang = hash01(pIdx, 113) * Math.PI * 2;
        pushUnderstory(pIdx % 2 === 0 ? 'veg-fern-clump' : 'veg-shrub-a', 'park', palm.x + Math.cos(ang) * 1.35, palm.z + Math.sin(ang) * 1.25, 1100 + pIdx, 3, [0.88, 1.22], 1, 0.9);
      }
    }

    // 1b) Natural Banyan & Tropical Shade A/B canopy groves across the mid/south park lawn
    // Positioned south of the central gravel promenade (`z0 + 9.2` and `z1 - 1.9`) so the riverfront
    // walking path & spawn corridor stay wide open while shaded canopies frame the lawn naturally.
    const parkShadePalette = ['veg-tree-banyan', 'veg-tree-shade-a', 'veg-tree-shade-b', 'veg-tree-shade-a'] as const;
    let sIdx = 0;
    for (let px = parkRect.x0 + 6.5; px < parkRect.x1 - 4.5; px += 7.8) {
      sIdx++;
      const sp = parkShadePalette[sIdx % parkShadePalette.length];
      const jx = (hash01(sIdx, 131) - 0.5) * 2.4;
      const laneZ = sIdx % 2 === 0 ? parkRect.z0 + 9.2 : parkRect.z1 - 1.9;
      const jz = (hash01(sIdx, 137) - 0.5) * 1.1;
      // Shift Scene 17 banyan (`sIdx === 4`) ~4 m west/south so it frames the clearing without blocking Minh Thu.
      const shiftX = sIdx === 4 ? -4.0 : 0;
      const shiftZ = sIdx === 4 ? 2.2 : 0;
      const scaleR: [number, number] = sp === 'veg-tree-banyan' ? [0.84, 1.06] : [0.90, 1.18];
      const tree = tryPlaceWithJitter(sp, 'park', px + jx + shiftX, laneZ + jz + shiftZ, 1200 + sIdx, scaleR, sIdx % 3 === 0 ? 1 : 0, 3.8);
      if (tree) {
        const a1 = hash01(sIdx, 149) * Math.PI * 2;
        const a2 = a1 + 2.2;
        pushUnderstory(sIdx % 2 === 0 ? 'veg-shrub-b' : 'veg-shrub-a', 'park', tree.x + Math.cos(a1) * 1.65, tree.z + Math.sin(a1) * 1.45, 1300 + sIdx, 5, [0.78, 1.12], 0, 1.0);
        pushUnderstory('veg-fern-clump', 'park', tree.x + Math.cos(a2) * 1.35, tree.z + Math.sin(a2) * 1.25, 1350 + sIdx, 7, [0.85, 1.25], 1, 0.9);
        if (sIdx % 3 === 0) {
          const bx = tree.x + Math.cos(a1 + 1.1) * 2.1;
          const bz = Math.max(tree.z + Math.sin(a1 + 1.1) * 1.5, parkRect.z0 + 8.6);
          if (!inRect({ x: bx, z: bz }, PARK_WALKWAY_SPAWN_CORRIDOR)) {
            pushRockCluster('park', bx, bz, 1390 + sIdx, 9, 1);
          }
        }
      }
    }

    // 1c) Gazania & Ursinia flower clusters near park benches + granite border stones along park lawn edge
    let bIdx = 0;
    for (const pr of city.props) {
      if (pr.kind === 'bench' && inRect({ x: pr.x, z: pr.z }, parkRect)) {
        bIdx++;
        pushUnderstory(
          bIdx % 2 === 0 ? 'veg-flower-gazania' : 'veg-flower-ursinia',
          'park', pr.x + 1.45, pr.z + 0.35, 1400 + bIdx, 11, [0.92, 1.28], 1, 0.85, true,
        );
        pushUnderstory(
          bIdx % 2 === 0 ? 'veg-flower-ursinia' : 'veg-flower-gazania',
          'park', pr.x - 1.45, pr.z + 0.45, 1450 + bIdx, 13, [0.86, 1.20], 2, 0.85, true,
        );
      }
    }
    for (let px = parkRect.x0 + 6; px < parkRect.x1 - 4; px += 13) {
      const k = Math.round(px);
      pushUnderstory('veg-rock-border', 'park', px + hash01(k, 161) * 2.0, parkRect.z1 - 0.95, 1500 + k, 19, [0.90, 1.35], 2, 1.2);
      if (hash01(k, 167) > 0.45) {
        const bx = px + 4.5;
        const bz = parkRect.z1 - 2.4 - hash01(k, 173) * 2.2;
        if (!inRect({ x: bx, z: bz }, PARK_WALKWAY_SPAWN_CORRIDOR)) {
          pushRockCluster('park', bx, bz, 1550 + k, 23, 1);
        }
      }
    }
  }

  // =========================================================================
  // 2. BOTANICAL GARDEN (`botanical`): Jacaranda, Banyan, Shade A/B, Palms, Anthurium, Calathea, Ferns
  // =========================================================================
  const botRect = zoneRectOf('botanical');
  if (botRect) {
    const botPalette = [
      'veg-tree-jacaranda', 'veg-tree-palm-royal', 'veg-tree-shade-a',
      'veg-tree-banyan', 'veg-tree-shade-b', 'veg-tree-jacaranda',
    ] as const;
    let bi = 0;
    for (let bx = botRect.x0 + 5.5; bx < botRect.x1 - 4.5; bx += 7.6) {
      bi++;
      const spNorth = bi % 3 === 0 ? 'veg-tree-palm-royal' : botPalette[bi % botPalette.length];
      const t1 = tryPlaceWithJitter(
        spNorth, 'botanical',
        bx + (hash01(bi, 201) - 0.5) * 1.8,
        botRect.z0 + 2.6 + hash01(bi, 207) * 2.4,
        2000 + bi, spNorth === 'veg-tree-jacaranda' ? [0.85, 1.05] : [0.86, 1.14], bi % 2 === 0 ? 0 : 1, 3.8,
      );
      if (t1) {
        pushUnderstory(bi % 2 === 0 ? 'veg-plant-anthurium' : 'veg-plant-calathea', 'botanical', t1.x + 1.35, t1.z + 1.1, 2100 + bi, 3, [0.90, 1.28], 0, 0.9);
        pushUnderstory('veg-fern-clump', 'botanical', t1.x - 1.25, t1.z + 1.15, 2150 + bi, 5, [0.92, 1.28], 1, 0.9);
      }
      if (bi % 2 === 1) {
        const spSouth = botPalette[(bi + 2) % botPalette.length];
        const t2 = tryPlaceWithJitter(
          spSouth, 'botanical',
          bx + 3.4,
          botRect.z1 - 2.1 - hash01(bi, 211) * 1.3,
          2200 + bi, [0.84, 1.08], 1, 3.8,
        );
        if (t2) {
          pushUnderstory('veg-shrub-garden', 'botanical', t2.x - 1.3, t2.z - 0.9, 2250 + bi, 7, [0.90, 1.25], 1, 0.9);
        }
      }
    }
    // Lush tropical garden beds (Anthurium, Calathea, Ursinia, Gazania, Ferns, Accent Rocks)
    for (let i = 0; i < 20; i++) {
      const fx = botRect.x0 + 4.5 + hash01(i, 233) * (botRect.x1 - botRect.x0 - 9.0);
      const fz = botRect.z0 + 2.4 + hash01(i, 239) * (botRect.z1 - botRect.z0 - 4.4);
      const bedSpecies = [
        'veg-plant-anthurium', 'veg-plant-calathea', 'veg-fern-clump',
        'veg-flower-ursinia', 'veg-flower-gazania', 'veg-rock-garden', 'veg-shrub-garden',
      ][i % 7];
      pushUnderstory(bedSpecies, 'botanical', fx, fz, 2300 + i, 13, [0.88, 1.32], i < 8 ? 0 : i < 15 ? 1 : 2, 1.05);
    }
    // Blend organic botanical foliage tufts (`veg-shrub-garden` + `veg-shrub-a`) seamlessly around southern terrace hedges (Scene 11).
    let bhIdx = 0;
    for (let bx = botRect.x0 + 9; bx < botRect.x1 - 8; bx += 11.5) {
      bhIdx++;
      const hz = botRect.z1 - 1.35;
      pushUnderstory('veg-shrub-garden', 'botanical', bx - 0.85, hz - 0.22, 2410 + bhIdx, 5, [0.95, 1.28], 1, 0.45);
      pushUnderstory('veg-shrub-a', 'botanical', bx + 0.85, hz + 0.20, 2450 + bhIdx, 7, [0.76, 0.96], 1, 0.45);
      pushUnderstory('veg-shrub-garden', 'botanical', bx, hz - 0.36, 2490 + bhIdx, 11, [0.85, 1.15], 2, 0.45);
    }
  }

  // =========================================================================
  // 3. UNIVERSITY CAMPUS (`campus`): Flame Poincianas, tall Campus Pines, Jacarandas, Hedges
  // =========================================================================
  const campusRect = zoneRectOf('campus');
  if (campusRect) {
    const camCx = (campusRect.x0 + campusRect.x1) / 2;
    // Iconic Vietnamese Flame Poincianas flanking the campus quad + Campus Pines on the eastern academic lawn
    const campusHeroSpots: [string, number, number, [number, number]][] = [
      ['veg-tree-flame-poinciana', campusRect.x0 + 6.5, campusRect.z0 + 3.4, [0.92, 1.12]],
      ['veg-tree-flame-poinciana', campusRect.x1 - 4.6, campusRect.z0 + 3.4, [0.92, 1.12]],
      ['veg-tree-flame-poinciana', campusRect.x0 + 7.0, campusRect.z1 - 4.2, [0.88, 1.06]],
      ['veg-tree-flame-poinciana', campusRect.x1 - 5.2, campusRect.z1 - 4.2, [0.88, 1.06]],
      ['veg-tree-flame-poinciana', camCx + 4.5, campusRect.z0 + 3.8, [0.90, 1.08]],
      ['veg-tree-pine', campusRect.x1 - 3.6, (campusRect.z0 + campusRect.z1) / 2 - 3.2, [0.92, 1.15]],
      ['veg-tree-pine', campusRect.x1 - 3.8, (campusRect.z0 + campusRect.z1) / 2 + 3.5, [0.88, 1.12]],
      ['veg-tree-pine', campusRect.x1 - 9.5, campusRect.z1 - 4.8, [0.90, 1.12]],
      ['veg-tree-jacaranda', campusRect.x1 - 11.0, campusRect.z0 + 4.8, [0.86, 1.04]],
      ['veg-tree-sapling', camCx - 7.8, campusRect.z0 + 3.2, [0.92, 1.15]],
      ['veg-tree-sapling', camCx + 7.8, campusRect.z0 + 3.2, [0.92, 1.15]],
    ];
    campusHeroSpots.forEach(([sp, tx, tz, sr], idx) => {
      const tr = tryPlaceWithJitter(sp, 'campus', tx, tz, 3000 + idx, sr, idx < 8 ? 0 : 1);
      if (tr) {
        pushUnderstory('veg-shrub-hedge', 'campus', tr.x + (tx < camCx ? 1.5 : -1.5), tr.z + 1.0, 3100 + idx, 5, [0.92, 1.20], 0, 0.95);
        if (idx % 2 === 0) {
          pushUnderstory('veg-flower-gazania', 'campus', tr.x, tr.z + 1.65, 3150 + idx, 7, [0.90, 1.24], 1, 0.85);
        }
      }
    });

    // Manicured campus hedges & flowers framing the quad perimeter
    for (let cx = campusRect.x0 + 6; cx < campusRect.x1 - 5; cx += 6.2) {
      const k = Math.round(cx);
      if (Math.abs(cx - camCx) > 5.5) {
        pushUnderstory('veg-shrub-hedge', 'campus', cx, campusRect.z1 - 1.3, 3200 + k, 11, [0.95, 1.18], 1, 1.1);
        pushUnderstory('veg-shrub-hedge', 'campus', cx, campusRect.z0 + 1.3, 3250 + k, 13, [0.95, 1.18], 1, 1.1);
      }
    }

    // Library surround plazas (`campus` zone east of `xE2+13`)
    const lib = city.buildings.find(b => b.id === 'library');
    if (lib) {
      const libTrees: [string, number, number][] = [
        ['veg-tree-pine', lib.rect.x0 - 3.2, lib.rect.z0 + 1.5],
        ['veg-tree-pine', lib.rect.x0 - 3.2, lib.rect.z1 - 1.5],
        ['veg-tree-flame-poinciana', (lib.rect.x0 + lib.rect.x1) / 2 - 5.0, lib.rect.z0 - 2.6],
        ['veg-tree-jacaranda', (lib.rect.x0 + lib.rect.x1) / 2 + 5.0, lib.rect.z0 - 2.6],
      ];
      libTrees.forEach(([sp, tx, tz], idx) => {
        const tr = tryPlaceWithJitter(sp, 'campus', tx, tz, 3400 + idx, [0.88, 1.08], 1);
        if (tr) {
          pushUnderstory('veg-shrub-hedge', 'campus', tr.x + 1.3, tr.z + 0.8, 3450 + idx, 3, [0.90, 1.16], 1, 0.9);
        }
      });
    }
  }

  // =========================================================================
  // 4. FOUNTAIN PLAZA (`fountain_plaza`): Sculpted Jacaranda/Banyan/Shade corners + tropical planters
  // =========================================================================
  const fRect = zoneRectOf('fountain_plaza');
  if (fRect) {
    const fTrees: [string, number, number][] = [
      ['veg-tree-jacaranda', fRect.x0 + 4.2, fRect.z0 + 3.4],
      ['veg-tree-banyan', fRect.x1 - 4.4, fRect.z0 + 3.6],
      ['veg-tree-shade-a', fRect.x0 + 4.2, fRect.z1 - 3.4],
      ['veg-tree-shade-b', fRect.x1 - 4.2, fRect.z1 - 3.4],
      ['veg-tree-flame-poinciana', fRect.x1 - 3.6, (fRect.z0 + fRect.z1) / 2],
    ];
    fTrees.forEach(([sp, tx, tz], idx) => {
      const tr = tryPlaceWithJitter(sp, 'fountain_plaza', tx, tz, 4000 + idx, [0.86, 1.08], idx < 3 ? 0 : 1);
      if (tr) {
        pushUnderstory(idx % 2 === 0 ? 'veg-plant-anthurium' : 'veg-fern-clump', 'fountain_plaza', tr.x + (tx < (fRect.x0 + fRect.x1) / 2 ? 1.5 : -1.5), tr.z, 4100 + idx, 5, [0.92, 1.24], 1, 0.9);
        pushUnderstory('veg-flower-ursinia', 'fountain_plaza', tr.x, tr.z + (tz < (fRect.z0 + fRect.z1) / 2 ? 1.5 : -1.5), 4150 + idx, 7, [0.92, 1.26], 1, 0.9);
      }
    });
    for (let i = 0; i < 8; i++) {
      const sideX = i % 2 === 0 ? fRect.x0 + 2.2 : fRect.x1 - 2.2;
      const pz = fRect.z0 + 3.5 + (i / 7) * (fRect.z1 - fRect.z0 - 7.0);
      pushUnderstory(i % 3 === 0 ? 'veg-rock-garden' : 'veg-shrub-garden', 'fountain_plaza', sideX, pz, 4200 + i, 11, [0.90, 1.22], 2, 1.0);
    }
  }

  // =========================================================================
  // 5. BOARDWALK FAIR (`fair`): Festive perimeter Royal Palms & Tropical Shade B + border blooms
  // =========================================================================
  const fairRect = zoneRectOf('fair');
  if (fairRect) {
    const fairTrees: [string, number, number][] = [
      ['veg-tree-palm-royal', fairRect.x0 + 3.2, fairRect.z0 + 2.6],
      ['veg-tree-palm-royal', fairRect.x1 - 3.2, fairRect.z0 + 2.6],
      ['veg-tree-palm-royal', fairRect.x0 + 3.4, fairRect.z1 - 2.4],
      ['veg-tree-palm-royal', fairRect.x1 - 3.4, fairRect.z1 - 2.4],
      ['veg-tree-shade-b', (fairRect.x0 + fairRect.x1) / 2 - 14.5, fairRect.z0 + 3.0],
      ['veg-tree-shade-b', (fairRect.x0 + fairRect.x1) / 2 + 14.5, fairRect.z0 + 3.0],
    ];
    fairTrees.forEach(([sp, tx, tz], idx) => {
      const tr = tryPlaceWithJitter(sp, 'fair', tx, tz, 5000 + idx, [0.88, 1.15], idx < 4 ? 0 : 1, 3.8);
      if (tr) {
        pushUnderstory(idx % 2 === 0 ? 'veg-flower-gazania' : 'veg-shrub-garden', 'fair', tr.x + 1.2, tr.z + 0.8, 5100 + idx, 5, [0.92, 1.25], 1, 0.9);
      }
    });
    for (let i = 0; i < 8; i++) {
      const fx = fairRect.x0 + 4.5 + (i / 7) * (fairRect.x1 - fairRect.x0 - 9.0);
      pushUnderstory(i % 2 === 0 ? 'veg-grass-bermuda' : 'veg-rock-border', 'fair', fx, fairRect.z0 + 1.45, 5200 + i, 9, [0.95, 1.30], 2, 1.1);
    }
  }

  // =========================================================================
  // 6. RIVERSIDE GREENWAY (`greenway`): Palms, Poincianas, Banyans, Pines, Meadow Grass, Wildflowers, Boulders
  // =========================================================================
  const greenwayRects = city.ground.filter(g => g.zone === 'greenway').map(g => g.rect);
  const gwPalette = [
    'veg-tree-palm-royal', 'veg-tree-banyan', 'veg-tree-flame-poinciana',
    'veg-tree-shade-a', 'veg-tree-pine', 'veg-tree-jacaranda',
  ] as const;
  let gIdx = 0;
  for (const gr of greenwayRects) {
    const isNorthStrip = gr.z0 < house.footprint.z0 - 10;
    for (let gx = gr.x0 + 5.5; gx < gr.x1 - 4.0; gx += 7.8) {
      gIdx++;
      const sp = isNorthStrip
        ? (gIdx % 2 === 0 ? 'veg-tree-palm-royal' : gwPalette[gIdx % gwPalette.length])
        : gwPalette[(gIdx + 2) % gwPalette.length];
      const gz = isNorthStrip
        ? gr.z0 + 2.8 + hash01(gIdx, 601) * 7.2
        : gr.z0 + 2.8 + hash01(gIdx, 607) * (gr.z1 - gr.z0 - 5.6);
      const tr = tryPlaceWithJitter(sp, 'greenway', gx + (hash01(gIdx, 613) - 0.5) * 2.2, gz, 6000 + gIdx, [0.86, 1.16], gIdx % 3 === 0 ? 1 : 0, 3.8);
      if (tr) {
        const ang = hash01(gIdx, 619) * Math.PI * 2;
        pushUnderstory(gIdx % 2 === 0 ? 'veg-grass-meadow' : 'veg-shrub-a', 'greenway', tr.x + Math.cos(ang) * 1.6, tr.z + Math.sin(ang) * 1.4, 6100 + gIdx, 3, [0.90, 1.32], 0, 1.0);
        if (gIdx % 2 === 1) {
          pushUnderstory(gIdx % 3 === 0 ? 'veg-flower-ursinia' : 'veg-grass-bermuda', 'greenway', tr.x - Math.cos(ang) * 1.7, tr.z - Math.sin(ang) * 1.5, 6150 + gIdx, 5, [0.92, 1.30], 1, 0.95);
        }
        if (gIdx % 4 === 1) {
          if (gIdx % 2 === 0) {
            pushRockCluster('greenway', tr.x + 2.1, tr.z - 1.1, 6190 + gIdx, 7, 1);
          } else {
            pushUnderstory('veg-rock-border', 'greenway', tr.x + 2.1, tr.z - 1.1, 6190 + gIdx, 7, [0.82, 1.25], 1, 1.1);
          }
        }
      }
    }
    // Natural meadow tufts, wildflowers & river stones along greenway grass lawn
    for (let i = 0; i < 10; i++) {
      const mx = gr.x0 + 4.0 + hash01(i + gIdx, 641) * (gr.x1 - gr.x0 - 8.0);
      const mz = gr.z0 + 1.8 + hash01(i + gIdx, 647) * (gr.z1 - gr.z0 - 3.4);
      const mSp = ['veg-grass-meadow', 'veg-grass-bermuda', 'veg-flower-ursinia', 'veg-shrub-b', 'veg-rock-border'][i % 5];
      pushUnderstory(mSp, 'greenway', mx, mz, 6300 + gIdx * 10 + i, 11, [0.90, 1.35], i < 5 ? 1 : 2, 1.15);
    }
  }

  // =========================================================================
  // 7. HIDDEN LANTERN TEA GARDEN (`lantern_garden`): Jacaranda, Banyan, Shade, Palms + Zen ferns/boulders
  // =========================================================================
  const lgRect = zoneRectOf('lantern_garden');
  if (lgRect) {
    const lgCx = (lgRect.x0 + lgRect.x1) / 2;
    const lgCz = (lgRect.z0 + lgRect.z1) / 2;
    const lgTrees: [string, number, number][] = [
      ['veg-tree-jacaranda', lgRect.x0 + 5.5, lgRect.z0 + 3.6],
      ['veg-tree-banyan', lgRect.x1 - 6.0, lgRect.z0 + 4.0],
      ['veg-tree-palm-royal', lgCx - 14.5, lgCz - 5.5],
      ['veg-tree-palm-royal', lgCx + 14.5, lgCz - 5.5],
      ['veg-tree-palm-royal', lgCx - 16.0, lgCz + 4.2],
      ['veg-tree-palm-royal', lgCx + 16.0, lgCz + 4.2],
      ['veg-tree-shade-a', lgRect.x0 + 7.5, lgRect.z1 - 4.2],
      ['veg-tree-shade-b', lgRect.x1 - 7.5, lgRect.z1 - 4.2],
      ['veg-tree-pine', lgRect.x1 - 4.2, lgCz],
      ['veg-tree-pine', lgRect.x1 - 4.5, lgRect.z0 + 8.5],
      ['veg-tree-jacaranda', lgRect.x0 + 4.5, lgCz + 1.0],
      ['veg-tree-flame-poinciana', lgCx - 19.0, lgRect.z0 + 4.5],
      ['veg-tree-flame-poinciana', lgCx + 19.0, lgRect.z1 - 4.5],
    ];
    lgTrees.forEach(([sp, tx, tz], idx) => {
      const tr = tryPlaceWithJitter(sp, 'lantern_garden', tx, tz, 7000 + idx, [0.85, 1.12], idx < 6 ? 0 : 1);
      if (tr) {
        pushUnderstory(idx % 2 === 0 ? 'veg-fern-clump' : 'veg-plant-calathea', 'lantern_garden', tr.x + 1.4, tr.z + 1.1, 7100 + idx, 3, [0.92, 1.30], 0, 0.95);
        if (idx % 3 === 0) {
          pushRockCluster('lantern_garden', tr.x - 1.5, tr.z - 0.9, 7150 + idx, 5, 1);
        } else {
          pushUnderstory('veg-plant-anthurium', 'lantern_garden', tr.x - 1.5, tr.z - 0.9, 7150 + idx, 5, [0.85, 1.22], 1, 1.0);
        }
      }
    });
    for (let i = 0; i < 16; i++) {
      const gx = lgRect.x0 + 4.0 + hash01(i, 731) * (lgRect.x1 - lgRect.x0 - 8.0);
      const gz = lgRect.z0 + 2.2 + hash01(i, 739) * (lgRect.z1 - lgRect.z0 - 4.4);
      const gSp = ['veg-fern-clump', 'veg-plant-calathea', 'veg-plant-anthurium', 'veg-shrub-b', 'veg-rock-garden', 'veg-flower-ursinia'][i % 6];
      pushUnderstory(gSp, 'lantern_garden', gx, gz, 7200 + i, 9, [0.90, 1.28], i < 8 ? 1 : 2, 1.15);
    }
  }

  // =========================================================================
  // 8. HOME BACK YARD (`yard`): Street Sapling, Tropical Shade B, flanking Royal Palms + ornamental blooms
  // =========================================================================
  const yardRect = zoneRectOf('yard');
  if (yardRect) {
    const f = house.footprint;
    const room = house.h;
    const yardTrees: [string, number, number, [number, number]][] = [
      ['veg-tree-sapling', f.x0 - 2.4, yardRect.z0 + 2.4, [0.88, 1.04]],
      ['veg-tree-palm-royal', room + 3.6, yardRect.z0 + 2.4, [0.84, 0.98]],
      ['veg-tree-shade-b', room + 8.4, yardRect.z0 + 2.6, [0.85, 1.02]],
      ['veg-tree-palm-royal', f.x1 + 3.4, yardRect.z0 + 2.5, [0.86, 1.04]],
      ['veg-tree-sapling', f.x1 + 6.8, (f.z0 + house.front) * 0.5, [0.86, 1.05]],
    ];
    yardTrees.forEach(([sp, tx, tz, sr], idx) => {
      const tr = tryPlaceWithJitter(sp, 'yard', tx, tz, 8000 + idx, sr, idx < 3 ? 0 : 1, 3.2);
      if (tr) {
        pushUnderstory(idx % 2 === 0 ? 'veg-shrub-garden' : 'veg-flower-gazania', 'yard', tr.x + 1.15, tr.z + 0.95, 8100 + idx, 3, [0.88, 1.18], 0, 0.85);
      }
    });
    // Ornamental home yard flowers, ferns & border stones (strictly clear of yard waypoint & window!)
    // Uses park-shared hardy yard ornamentals so tropical shade houseplants stay clustered in Botanical/Lantern gardens.
    const yardOrnamentals: [string, number, number][] = [
      ['veg-flower-gazania', f.x0 - 3.2, yardRect.z0 + 4.2],
      ['veg-fern-clump', room + 5.2, yardRect.z0 + 4.4],
      ['veg-shrub-garden', f.x1 + 2.2, yardRect.z0 + 4.6],
      ['veg-rock-border', f.x1 + 1.6, yardRect.z0 + 2.2],
      ['veg-shrub-garden', f.x1 + 7.6, f.z0 + 1.8],
      ['veg-flower-ursinia', f.x1 + 7.8, house.front - 2.6],
    ];
    yardOrnamentals.forEach(([sp, ox, oz], idx) => {
      pushUnderstory(sp, 'yard', ox, oz, 8200 + idx, 7, [0.90, 1.22], 1, 0.85);
    });
  }

  // =========================================================================
  // 9. LANTERN STREET, SHOPPING ROW & MARKET BOULEVARD VERGES (Non-sidewalk pockets & boulevards!)
  // =========================================================================
  // 9a) Pedestrian plazas & side setbacks between Shopping Row buildings (`s3..m0`) + West Neighborhood lawn verges
  const lanternStreet = city.streets.find(s => s.id === 'lantern')?.rect;
  const marketBlvd = city.streets.find(s => s.id === 'market_blvd')?.rect;
  const riversideRd = city.streets.find(s => s.id === 'riverside')?.rect;

  if (lanternStreet) {
    // Non-sidewalk green pockets directly south of Lantern Street (`s3 + 1.3`) and along breeze-ways (`s3 + 13`)
    let vIdx = 0;
    for (let vx = ex.cityBounds.x0 + 8; vx < lanternStreet.x1 - 8; vx += 11.5) {
      vIdx++;
      const sp = vIdx % 4 === 0 ? 'veg-tree-flame-poinciana' : 'veg-tree-sapling';
      // Try north-of-Lantern-Street pocket (non-sidewalk setback) & south-of-Lantern-Street pocket
      const trN = tryPlaceWithJitter(sp, 'verge', vx, lanternStreet.z0 - 1.5, 9000 + vIdx, [0.85, 1.08], 1, 4.0);
      if (trN) {
        pushUnderstory('veg-shrub-garden', 'verge', trN.x + 1.25, trN.z, 9100 + vIdx, 3, [0.86, 1.15], 2, 0.9);
      }
      const trS = tryPlaceWithJitter(
        vIdx % 5 === 0 ? 'veg-tree-flame-poinciana' : 'veg-tree-sapling',
        'verge', vx + 4.5, lanternStreet.z1 + 1.5, 9200 + vIdx, [0.85, 1.06], 1, 4.0,
      );
      if (trS) {
        pushUnderstory(vIdx % 2 === 0 ? 'veg-shrub-garden' : 'veg-flower-gazania', 'verge', trS.x - 1.2, trS.z, 9300 + vIdx, 5, [0.88, 1.18], 2, 0.9);
      }
    }
    // Pedestrian breeze-way pockets between north & south shopping rows
    const breezeways = city.ground.filter(g => g.surface === 'plaza' && g.zone === 'street');
    breezeways.forEach((bw, bwi) => {
      const bz = (bw.rect.z0 + bw.rect.z1) * 0.5;
      for (let bx = bw.rect.x0 + 5; bx < bw.rect.x1 - 4; bx += 12) {
        const k = bwi * 100 + Math.round(bx);
        const tr = tryPlaceWithJitter('veg-tree-sapling', 'verge', bx, bz, 9400 + k, [0.86, 1.08], 1, 4.2);
        if (tr) {
          pushUnderstory('veg-shrub-garden', 'verge', tr.x + 1.2, tr.z, 9450 + k, 7, [0.85, 1.15], 2, 0.9);
        }
      }
    });
  }

  // 9b) West Neighborhood & North-of-Lantern-Street residential pockets south of Riverside Road (`n3 + 1.8`)
  if (riversideRd) {
    let rIdx = 0;
    for (let rx = ex.cityBounds.x0 + 7; rx < house.footprint.x0 - 6; rx += 8.4) {
      rIdx++;
      const sp = rIdx % 3 === 0 ? 'veg-tree-shade-b' : 'veg-tree-sapling';
      const tr = tryPlaceWithJitter(sp, 'verge', rx, riversideRd.z1 + 2.2, 9500 + rIdx, [0.86, 1.10], 1, 3.8);
      if (tr) {
        pushUnderstory('veg-shrub-a', 'verge', tr.x + 1.3, tr.z + 0.6, 9550 + rIdx, 3, [0.84, 1.14], 2, 0.9);
      }
    }
  }

  // 9c) Market Boulevard scenic southern residential fringe (`m3 + 2.4` between `south-fringe-*` lots!)
  if (marketBlvd) {
    let mIdx = 0;
    for (let mx = marketBlvd.x0 + 6; mx < marketBlvd.x1 - 5; mx += 7.8) {
      mIdx++;
      const sp = mIdx % 3 === 0 ? 'veg-tree-flame-poinciana' : mIdx % 2 === 0 ? 'veg-tree-sapling' : 'veg-tree-shade-a';
      const tr = tryPlaceWithJitter(sp, 'verge', mx, marketBlvd.z1 + 2.6, 9600 + mIdx, [0.88, 1.14], 1, 3.8);
      if (tr) {
        pushUnderstory(mIdx % 2 === 0 ? 'veg-shrub-hedge' : 'veg-grass-bermuda', 'verge', tr.x + 1.4, tr.z - 0.6, 9650 + mIdx, 5, [0.90, 1.20], 2, 0.9);
      }
    }
  }

  const result: VegetationLayoutResult = {
    placements: [...trees, ...understory],
    trees,
    understory,
    exclusions: ex,
  };
  let houseMap = VEGETATION_LAYOUT_CACHE.get(city);
  if (!houseMap) {
    houseMap = new WeakMap<HousePlan, VegetationLayoutResult>();
    VEGETATION_LAYOUT_CACHE.set(city, houseMap);
  }
  houseMap.set(house, result);
  return result;
}

// ---------------------------------------------------------------------------
// GPU Wind + 4-Season Foliage Tinting + Snow-Dusting Shader Injection
// ---------------------------------------------------------------------------
interface VegShaderUniforms {
  uVegTime: { value: number };
  uVegWind: { value: T.Vector2 };
  uVegSnow: { value: number };
  uVegWetness: { value: number };
}

interface PatchedMaterialEntry {
  readonly material: T.MeshStandardMaterial;
  readonly isFoliage: boolean;
  readonly tintUniform: { value: T.Color };
  readonly tintWeight: number;
  readonly speciesId: string;
}

function classifyIsFoliageMaterial(mat: T.Material, species: VegetationSpecies): boolean {
  if (species.category === 'rock') return false;
  if (species.category !== 'tree') return true;
  const std = mat as T.MeshStandardMaterial;
  if (std.alphaTest > 0 || std.transparent) return true;
  const n = (mat.name || '').toLowerCase();
  if (
    n.includes('leaf') ||
    n.includes('leaves') ||
    n.includes('leaflet') ||
    n.includes('frond') ||
    n.includes('foliage') ||
    n.includes('twig')
  ) {
    return true;
  }
  return false;
}

function seasonColorForSpecies(speciesId: string, seasonIndex: number, out: T.Color): T.Color {
  const s = Math.max(0, Math.min(3, seasonIndex | 0));
  let table = SEASON_TINTS_DEFAULT;
  if (speciesId === 'veg-tree-banyan') table = SEASON_TINTS_BANYAN;
  else if (speciesId === 'veg-tree-flame-poinciana') table = SEASON_TINTS_FLAME;
  else if (speciesId === 'veg-tree-jacaranda') table = SEASON_TINTS_JACARANDA;
  else if (speciesId.startsWith('veg-grass-')) table = SEASON_TINTS_GRASS;
  const [r, g, b] = table[s];
  return out.setRGB(r, g, b);
}

type WinterPolicy = 'keep' | 'swap-pine' | 'dormant' | 'suppress';

function winterPolicyForSpecies(speciesId: string): WinterPolicy {
  if (speciesId === 'veg-tree-palm-royal') return 'swap-pine';
  if (
    speciesId === 'veg-flower-gazania' ||
    speciesId === 'veg-flower-ursinia' ||
    speciesId === 'veg-plant-anthurium' ||
    speciesId === 'veg-plant-calathea'
  ) {
    return 'suppress';
  }
  if (speciesId === 'veg-tree-flame-poinciana' || speciesId === 'veg-tree-jacaranda') {
    return 'dormant';
  }
  return 'keep';
}

function patchVegetationMaterial(
  mat: T.MeshStandardMaterial,
  species: VegetationSpecies,
  isFoliage: boolean,
  shared: VegShaderUniforms,
): PatchedMaterialEntry {
  const tintWeight =
    isFoliage && species.seasonalTintable
      ? species.id === 'veg-tree-flame-poinciana'
        ? 0.56
        : 0.85
      : 0.0;

  const tintUniform = { value: new T.Color(1, 1, 1) };
  const stiffnessUniform = { value: species.windStiffness };
  const heightUniform = { value: Math.max(0.25, species.height) };
  const isFoliageUniform = { value: isFoliage ? 1.0 : 0.0 };
  const tintWeightUniform = { value: tintWeight };
  const dormantUniform = { value: winterPolicyForSpecies(species.id) === 'dormant' ? 1.0 : 0.0 };
  const isRock = species.category === 'rock';
  const isBark = !isFoliage && !isRock;

  // Ensure crisp alpha-tested foliage shadows and preserve thin connecting twigs via 0.28 cutoff + mip alpha lift.
  if (isFoliage && (mat.alphaTest > 0 || mat.transparent)) {
    mat.transparent = false;
    mat.alphaTest = 0.28;
    mat.side = T.DoubleSide;
    mat.depthWrite = true;
  } else if (isFoliage) {
    mat.side = T.DoubleSide;
  }

  const cacheTag = `veg-v3-${isFoliage ? 'fol' : isRock ? 'rock' : 'bark'}-${tintWeight > 0 ? 'tint' : 'ever'}`;

  chainMaterialShader(mat, cacheTag, (shader) => {
    shader.uniforms.uVegTime = shared.uVegTime;
    shader.uniforms.uVegWind = shared.uVegWind;
    shader.uniforms.uVegSnow = shared.uVegSnow;
    shader.uniforms.uVegWetness = shared.uVegWetness;
    shader.uniforms.uVegStiffness = stiffnessUniform;
    shader.uniforms.uVegHeight = heightUniform;
    shader.uniforms.uVegIsFoliage = isFoliageUniform;
    shader.uniforms.uVegSeasonTint = tintUniform;
    shader.uniforms.uVegTintWeight = tintWeightUniform;
    shader.uniforms.uVegDormant = dormantUniform;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uVegTime;
uniform vec2 uVegWind;
uniform float uVegStiffness;
uniform float uVegHeight;
uniform float uVegIsFoliage;
varying vec3 vVegWorldPos;
varying vec3 vVegWorldNorm;${isBark ? '\nvarying vec3 vVegLocalPos;' : ''}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec4 vegOrigin = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
#ifdef USE_INSTANCING
  vegOrigin = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
#endif
${isRock ? '' : `
float vegHNorm = clamp(smoothstep(0.15, max(uVegHeight, 0.5), position.y), 0.0, 1.0);
float vegBend = vegHNorm * vegHNorm;
float vegWMag = length(uVegWind);
vec2 vegWDir = vegWMag > 0.001 ? (uVegWind / vegWMag) : vec2(0.85, 0.52);
float vegPhase = dot(vegOrigin.xz, vec2(0.16, 0.12)) + uVegTime * (1.05 + vegWMag * 0.28);
float vegGust = sin(vegPhase) * 0.65 + sin(vegPhase * 1.83 + 1.3) * 0.35;
float vegFlex = max(0.0, 1.15 - uVegStiffness * 0.88);
float vegAmp = (0.04 + vegWMag * 0.072) * vegFlex * vegBend;
transformed.x += vegWDir.x * vegGust * vegAmp;
transformed.z += vegWDir.y * vegGust * vegAmp;
if (uVegIsFoliage > 0.5) {
  float vegLPhase = uVegTime * (3.0 + vegWMag * 0.72) + dot(position.xyz + vegOrigin.xyz, vec3(2.3, 1.9, 2.7));
  float vegFlut = sin(vegLPhase) * (0.013 + vegWMag * 0.022) * vegHNorm * vegFlex;
  transformed.x += vegFlut * 0.85;
  transformed.y += cos(vegLPhase * 1.27) * vegFlut * 0.50;
  transformed.z -= vegFlut * 0.72;
}
`}`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vec4 vegWp = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  vegWp = instanceMatrix * vegWp;
#endif
vegWp = modelMatrix * vegWp;
vVegWorldPos = vegWp.xyz;
vec3 vegWn = objectNormal;
#ifdef USE_INSTANCING
  vegWn = mat3(instanceMatrix) * vegWn;
#endif
vVegWorldNorm = normalize(mat3(modelMatrix) * vegWn);${isBark ? '\nvVegLocalPos = position;' : ''}`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uVegSeasonTint;
uniform float uVegTintWeight;
uniform float uVegDormant;
uniform float uVegSnow;
uniform float uVegWetness;
varying vec3 vVegWorldPos;
varying vec3 vVegWorldNorm;${
  isBark
    ? `
varying vec3 vVegLocalPos;
float vegBarkHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vegBarkNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(vegBarkHash(i), vegBarkHash(i + vec2(1.0, 0.0)), u.x),
    mix(vegBarkHash(i + vec2(0.0, 1.0)), vegBarkHash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}`
    : ''
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
${isFoliage ? `
#ifdef USE_MAP
  // Preserve thin connecting twigs across mip levels via mild screen-space derivative alpha lift (Scenes 01, 10).
  float vegMipLift = clamp(max(length(dFdx(vMapUv)), length(dFdy(vMapUv))) * 32.0, 0.0, 0.65);
  diffuseColor.a *= (1.0 + vegMipLift * 0.42);
#endif
` : ''}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
${isFoliage ? `
// Smooth camera-proximity Interleaved Gradient Noise dissolve (1.20..2.85 m) so overhanging foreground
// branches dissolve gracefully before crowding the lens (Scenes 01, 10).
float vegCamDist = distance(vVegWorldPos, cameraPosition);
if (vegCamDist < 2.85) {
  float vegCamFade = smoothstep(1.20, 2.85, vegCamDist);
  float vegIgn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  if (vegCamFade < vegIgn) discard;
}
` : ''}${isBark ? `
// Seamless 2-octave cylindrical bark weathering FBM + root-flare earth grounding breaks periodic UV rings
// (eliminates Royal Palm corrugated-pipe look with 0 extra samplers & 0 new shader variants).
float vegBarkSeed = fract(sin(dot(floor(vVegWorldPos.xz * 0.45), vec2(12.9898, 78.233))) * 43758.5453) * 19.7;
vec2 vegBarkXZ = normalize(vVegLocalPos.xz + vec2(1e-4, 0.0));
vec2 vegBarkC1 = vec2(dot(vegBarkXZ, vec2(1.45, 0.95)) + vegBarkSeed, vVegLocalPos.y * 0.45 + vegBarkSeed * 0.37);
vec2 vegBarkC2 = vec2(dot(vegBarkXZ, vec2(-1.85, 2.25)) + vegBarkSeed * 1.3, vVegLocalPos.y * 1.10 + 3.1);
float vegBarkW = vegBarkNoise(vegBarkC1) * 0.62 + vegBarkNoise(vegBarkC2) * 0.38;
diffuseColor.rgb *= mix(vec3(0.88, 0.87, 0.85), vec3(1.10, 1.12, 1.05), vegBarkW);
float vegRootFlare = smoothstep(0.0, 1.4, max(0.0, vVegLocalPos.y));
diffuseColor.rgb *= mix(vec3(0.75, 0.78, 0.71), vec3(1.0), vegRootFlare);
` : ''}
if (uVegTintWeight > 0.001) {
  float vegVar = fract(sin(dot(floor(vVegWorldPos.xz * 0.35), vec2(12.9898, 78.233))) * 43758.5453);
  vec3 vegTint = mix(vec3(1.0), uVegSeasonTint * (0.93 + 0.14 * vegVar), uVegTintWeight);
  diffuseColor.rgb *= vegTint;
}
if (uVegWetness > 0.01) {
  diffuseColor.rgb *= mix(1.0, 0.78, uVegWetness * 0.52);
}
if (uVegSnow > 0.01) {
  float vegUp = smoothstep(${isRock ? '0.42, 0.88' : '0.24, 0.82'}, vVegWorldNorm.y);
  float vegN = fract(sin(dot(floor(vVegWorldPos.xz * ${isRock ? '1.4' : '2.4'}), vec2(37.17, 91.53))) * 19531.7);
  ${isFoliage ? `
  // Mute bright summer greens & dormant flame/jacaranda blooms in winter snow so canopies harmonize with snow drifts.
  float vegFrostChill = smoothstep(0.25, 0.90, uVegSnow);
  float vegLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(vegLum) * vec3(0.76, 0.83, 0.81), vegFrostChill * mix(0.46, 0.80, uVegDormant));
  ` : ''}
  float vegSnowAmt = clamp(uVegSnow * vegUp * (${isRock ? '0.76 + 0.18 * vegN' : '0.64 + 0.16 * uVegDormant + 0.32 * vegN'}), 0.0, ${isRock ? '0.86' : '0.84 + 0.08 * uVegDormant'});
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 0.92, 0.97), vegSnowAmt);
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
if (uVegWetness > 0.01) {
  roughnessFactor = mix(roughnessFactor, max(0.24, roughnessFactor * 0.58), uVegWetness * 0.62);
}
if (uVegSnow > 0.01) {
  float vegUpR = smoothstep(0.35, 0.85, vVegWorldNorm.y);
  roughnessFactor = mix(roughnessFactor, 0.88, clamp(uVegSnow * vegUpR * 0.72, 0.0, 0.72));
}`,
      );
  });
  // Chain analytical Height Fog & 3-cascade CSM at creation time (canonical order: domain -> fog -> CSM)
  // so no late post-compile mutation ever triggers a second FXC compile!
  patchHeightFog(mat, getSharedHeightFogUniforms());
  patchMaterialWithEchoCsm(mat);

  return {
    material: mat,
    isFoliage,
    tintUniform,
    tintWeight,
    speciesId: species.id,
  };
}

/**
 * Demotes GLTF `MeshPhysicalMaterial` (e.g. from `KHR_materials_specular` on Poly Haven botanical GLBs)
 * down to lean `MeshStandardMaterial`, stripping `USE_SPECULAR`/`USE_IOR`/`USE_TRANSMISSION`/sheen/iridescence
 * shader bloat while preserving every standard PBR texture and scalar parameter.
 */
function demoteVegetationMaterial(srcMat: T.Material | undefined): T.MeshStandardMaterial {
  if (srcMat instanceof T.MeshStandardMaterial) {
    if ((srcMat as T.MeshPhysicalMaterial).isMeshPhysicalMaterial) {
      return new T.MeshStandardMaterial({
        name: srcMat.name,
        color: srcMat.color.clone(),
        map: srcMat.map,
        normalMap: srcMat.normalMap,
        normalScale: srcMat.normalScale.clone(),
        roughnessMap: srcMat.roughnessMap,
        metalnessMap: srcMat.metalnessMap,
        aoMap: srcMat.aoMap,
        aoMapIntensity: srcMat.aoMapIntensity,
        emissive: srcMat.emissive.clone(),
        emissiveMap: srcMat.emissiveMap,
        emissiveIntensity: srcMat.emissiveIntensity,
        alphaMap: srcMat.alphaMap,
        alphaTest: srcMat.alphaTest,
        transparent: srcMat.transparent,
        opacity: srcMat.opacity,
        roughness: srcMat.roughness,
        metalness: srcMat.metalness,
        envMapIntensity: srcMat.envMapIntensity,
        vertexColors: srcMat.vertexColors,
        side: srcMat.side,
        depthWrite: srcMat.depthWrite,
        depthTest: srcMat.depthTest,
        fog: srcMat.fog,
      });
    }
    const cloned = srcMat.clone();
    // Defend against Three.js Material.copy() JSON-cloning a Set in userData.__ecShaderTags into `{}`.
    if (cloned.userData.__ecShaderTags && !(cloned.userData.__ecShaderTags instanceof Set)) {
      const origTags = srcMat.userData.__ecShaderTags;
      cloned.userData.__ecShaderTags = origTags instanceof Set ? new Set(origTags) : new Set<string>();
    }
    return cloned;
  }
  return new T.MeshStandardMaterial({ color: 0x4f7a42, roughness: 0.78 });
}

// ---------------------------------------------------------------------------
// Per-Species Runtime Instanced Bucket
// ---------------------------------------------------------------------------
interface LodPart {
  readonly mesh: T.InstancedMesh;
  readonly geometry: T.BufferGeometry;
  readonly material: T.MeshStandardMaterial;
  readonly isFoliage: boolean;
}

interface SpeciesBucket {
  readonly species: VegetationSpecies;
  readonly winterPolicy: WinterPolicy;
  /** Instances at index >= winterOnlyFromIndex are pre-allocated winter swap slots (e.g. palm -> pine). */
  readonly winterOnlyFromIndex: number;
  readonly instances: VegetationPlacement[];
  /** Precomputed world transform matrix for every placed instance of this species (zero per-frame compose!). */
  readonly matrices: Float32Array;
  /** Current LOD classification per instance: 0 = culled, 1 = LOD0, 2 = LOD1. */
  readonly states: Uint8Array;
  /** Previously packed effective GPU render slot per instance (`0 | 1 | 2`, `255` = uninitialized). */
  readonly packedSlots: Uint8Array;
  /** Tight static bounding sphere covering all placed instances of this species. */
  readonly staticSphere: T.Sphere;
  lod0Parts: LodPart[];
  lod1Parts: LodPart[];
  lod0Loaded: boolean;
  lod1Loaded: boolean;
  lod0Loading: boolean;
  lod1Loading: boolean;
  packedCanUseLod0: boolean;
  packedCanUseLod1: boolean;
  activeLod0Count: number;
  activeLod1Count: number;
}

const LOADER_SHARED = typeof window !== 'undefined' ? new GLTFLoader() : null;

// Priority order for staggered async loading: visible hero trees first, secondary trees, then understory.
const LOAD_PRIORITY: readonly string[] = [
  'veg-tree-palm-royal',
  'veg-tree-banyan',
  'veg-tree-flame-poinciana',
  'veg-tree-shade-a',
  'veg-tree-sapling',
  'veg-tree-jacaranda',
  'veg-tree-shade-b',
  'veg-tree-pine',
  'veg-shrub-a',
  'veg-shrub-b',
  'veg-shrub-garden',
  'veg-shrub-hedge',
  'veg-flower-gazania',
  'veg-flower-ursinia',
  'veg-fern-clump',
  'veg-plant-anthurium',
  'veg-plant-calathea',
  'veg-grass-bermuda',
  'veg-grass-meadow',
  'veg-rock-boulder',
  'veg-rock-garden',
  'veg-rock-border',
];

function computeStaticSphere(instances: VegetationPlacement[], species: VegetationSpecies): T.Sphere {
  if (instances.length === 0) return new T.Sphere(new T.Vector3(0, GROUND_Y, 0), 1);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let maxScale = 1;
  for (const inst of instances) {
    if (inst.x < minX) minX = inst.x;
    if (inst.x > maxX) maxX = inst.x;
    if (inst.z < minZ) minZ = inst.z;
    if (inst.z > maxZ) maxZ = inst.z;
    if (inst.scale > maxScale) maxScale = inst.scale;
  }
  const cx = (minX + maxX) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const h = species.height * maxScale;
  const r = Math.hypot((maxX - minX) * 0.5, (maxZ - minZ) * 0.5, h * 0.5) + species.crownRadius * maxScale + 1.5;
  return new T.Sphere(new T.Vector3(cx, GROUND_Y + h * 0.5, cz), Math.max(r, 4.0));
}

function applyAnisotropyToMaterial(mat: T.MeshStandardMaterial, anisotropy: number): void {
  const aniso = Math.max(1, Math.min(16, Math.round(anisotropy)));
  for (const tex of [mat.map, mat.normalMap, mat.roughnessMap, mat.metalnessMap, mat.aoMap]) {
    if (tex && tex.anisotropy !== aniso) {
      tex.anisotropy = aniso;
      if (tex.image) tex.needsUpdate = true;
    }
  }
}

/**
 * Unpacks KHR_mesh_quantization (`Int16Array`/`Uint16Array` normalized or interleaved) into
 * `Float32BufferAttribute` BEFORE `applyMatrix4()` or `mergeGeometries()` so Cycles-baked
 * `veg_palm_royal_aaa` (LOD0 & LOD1) never overflows or silently drops primitives!
 */
function unpackVegQuantizedAttr(g: T.BufferGeometry, name: string, itemSize: number): void {
  const attr = g.getAttribute(name);
  if (!attr) return;
  const isInterleaved = (attr as T.InterleavedBufferAttribute).isInterleavedBufferAttribute;
  if (!isInterleaved && attr.array instanceof Float32Array && !attr.normalized) return;
  const out = new Float32Array(attr.count * itemSize);
  for (let i = 0; i < attr.count; i++) {
    out[i * itemSize] = attr.getX(i);
    if (itemSize > 1) out[i * itemSize + 1] = attr.getY(i);
    if (itemSize > 2) out[i * itemSize + 2] = attr.getZ(i);
  }
  g.setAttribute(name, new T.Float32BufferAttribute(out, itemSize));
}

interface HedgePlacement {
  x: number;
  z: number;
  rotY: number;
}

function planTrimmedHedges(city: CityPlan, ex: VegetationExclusions): HedgePlacement[] {
  const out: HedgePlacement[] = [];
  const canFit = (x: number, z: number): boolean => {
    if (x < ex.cityBounds.x0 + 1.4 || x > ex.cityBounds.x1 - 1.4) return false;
    if (z < ex.riverSafeZ + 0.8 || z > ex.cityBounds.z1 - 1.4) return false;
    for (const r of ex.roadsAndCrossings) {
      if (inExpandedRect(x, z, r, 0.75)) return false;
    }
    for (const r of ex.sidewalks) {
      if (inExpandedRect(x, z, r, 0.48)) return false;
    }
    for (const r of ex.buildingsAndLots) {
      if (inExpandedRect(x, z, r, 0.85)) return false;
    }
    for (const d of ex.doorClearances) {
      if (Math.hypot(x - d.x, z - d.z) < d.r + 0.6) return false;
    }
    for (const pr of ex.propClearances) {
      if (Math.hypot(x - pr.x, z - pr.z) < pr.r + 0.9) return false;
    }
    for (const prev of out) {
      if (Math.hypot(x - prev.x, z - prev.z) < 2.05) return false;
    }
    return true;
  };
  const tryPush = (x: number, z: number, rotY: number) => {
    if (canFit(x, z)) out.push({ x, z, rotY });
  };

  // 1. Campus Library grand plaza manicured hedge flanks (north & west academic quad borders).
  const lib = city.buildings.find((b) => b.id === 'library');
  if (lib) {
    tryPush(lib.rect.x0 - 1.6, lib.rect.z1 - 2.6, Math.PI / 2);
    tryPush(lib.rect.x0 - 1.6, lib.rect.z1 - 5.2, Math.PI / 2);
    tryPush(lib.rect.x0 + 2.8, lib.rect.z1 + 1.2, 0);
    tryPush(lib.rect.x1 - 2.8, lib.rect.z1 + 1.2, 0);
  }

  // 2. Botanical Garden terrace manicured hedge borders along the southern entrance verge.
  const bot = city.zones.find((z) => z.id === 'botanical')?.rect;
  if (bot) {
    for (let bx = bot.x0 + 9; bx < bot.x1 - 8; bx += 11.5) {
      tryPush(bx, bot.z1 - 1.35, 0);
    }
  }

  // 3. Market Boulevard southern residential garden dividers between south-fringe residences.
  const mBlvd = city.streets.find((s) => s.id === 'market_blvd')?.rect;
  if (mBlvd) {
    for (let mx = mBlvd.x0 + 11; mx < mBlvd.x1 - 10; mx += 13.5) {
      tryPush(mx, mBlvd.z1 + 1.55, 0);
    }
  }

  return out;
}

export class VegetationSystem {
  readonly group = new T.Group();
  private readonly buckets: SpeciesBucket[] = [];
  private readonly patchedMaterials: PatchedMaterialEntry[] = [];
  private readonly ownedTextures = new Set<T.Texture>();
  private hedgeGroup: T.Group | null = null;
  private hedgeAcquired = false;
  private readonly hedgePlacements: HedgePlacement[];
  private readonly sharedUniforms: VegShaderUniforms = {
    uVegTime: { value: 0 },
    uVegWind: { value: new T.Vector2(0.75, 0.28) },
    uVegSnow: { value: 0 },
    uVegWetness: { value: 0 },
  };
  private readonly externalWeather?: SharedWeatherUniforms;

  private quality: QualityTier;
  private policy: TierPolicy;
  private maxAnisotropy: number;
  private sectorVis: Record<SectorKey, boolean> = { north: true, south: true, sides: true };

  private totalTrees = 0;
  private totalUnderstory = 0;
  private activeLod0Total = 0;
  private activeLod1Total = 0;
  private loadedSpeciesCount = 0;

  private reclassifyTimer = 999; // Force immediate classification on first update()
  private reclassifyDirty = true;
  private readonly cityBounds: Rect;
  private readonly clampedPos = { x: 0, z: 0 };
  private lastPlayerX = 0;
  private lastPlayerZ = 0;
  private lastClassifiedX = Number.NaN;
  private lastClassifiedZ = Number.NaN;
  private lastClassifiedCellKey = Number.NaN;
  private readonly memoizedEmptyVegCells = new Set<number>();
  private lastSeason = -1;
  private winterBiomeActive = false;
  private disposed = false;

  private readonly tmpMat = new T.Matrix4();
  private readonly tmpColor = new T.Color();
  // Pre-allocated scratch arrays for zero-GC 4 Hz LOD classification + draw-call budget coalescing.
  private readonly scratchRawL0: Int32Array;
  private readonly scratchRawL1: Int32Array;
  private readonly scratchMinL0Sq: Float64Array;

  constructor(opts: VegetationSystemOptions) {
    this.group.name = 'echo-life-vegetation-system';
    this.quality = opts.quality;
    this.policy = TIER_POLICY[opts.quality];
    this.maxAnisotropy = opts.maxAnisotropy ?? this.policy.defaultAnisotropy;
    this.externalWeather = opts.weatherUniforms;
    this.cityBounds = opts.city.bounds;
    clampToBounds(0, 0, this.cityBounds, this.clampedPos);
    this.lastPlayerX = this.clampedPos.x;
    this.lastPlayerZ = this.clampedPos.z;

    const layout = buildVegetationLayout(opts.city, opts.house);
    this.totalTrees = layout.trees.length;
    this.totalUnderstory = layout.understory.length;
    this.hedgePlacements = planTrimmedHedges(opts.city, layout.exclusions);

    const bySpecies = new Map<string, VegetationPlacement[]>();
    const winterSwapPlacements: VegetationPlacement[] = [];
    for (const p of layout.placements) {
      const list = bySpecies.get(p.speciesId);
      if (list) list.push(p);
      else bySpecies.set(p.speciesId, [p]);
      if (winterPolicyForSpecies(p.speciesId) === 'swap-pine') {
        // Pre-allocate winter pine swap slot at exact palm coordinates (`scale * 0.86` matches palm crown clearance).
        winterSwapPlacements.push({
          ...p,
          speciesId: 'veg-tree-pine',
          scale: p.scale * 0.86,
        });
      }
    }

    // Precompute every instance's static world Matrix4 once at startup.
    const pos = new T.Vector3();
    const euler = new T.Euler(0, 0, 0, 'YXZ');
    const quat = new T.Quaternion();
    const scl = new T.Vector3();
    const mat = new T.Matrix4();

    for (const species of VEGETATION_MANIFEST) {
      const baseList = bySpecies.get(species.id) ?? [];
      const isPine = species.id === 'veg-tree-pine';
      const list = isPine && winterSwapPlacements.length > 0
        ? [...baseList, ...winterSwapPlacements]
        : baseList;
      if (list.length === 0) continue;
      const winterOnlyFromIndex = isPine ? baseList.length : list.length;
      const matrices = new Float32Array(list.length * 16);
      for (let i = 0; i < list.length; i++) {
        const inst = list[i];
        pos.set(inst.x, inst.y, inst.z);
        euler.set(inst.leanX, inst.rotY, inst.leanZ, 'YXZ');
        quat.setFromEuler(euler);
        scl.set(inst.scale, inst.scale, inst.scale);
        mat.compose(pos, quat, scl);
        mat.toArray(matrices, i * 16);
      }
      const packedSlots = new Uint8Array(list.length);
      packedSlots.fill(255);
      this.buckets.push({
        species,
        winterPolicy: winterPolicyForSpecies(species.id),
        winterOnlyFromIndex,
        instances: list,
        matrices,
        states: new Uint8Array(list.length),
        packedSlots,
        staticSphere: computeStaticSphere(list, species),
        lod0Parts: [],
        lod1Parts: [],
        lod0Loaded: false,
        lod1Loaded: false,
        lod0Loading: false,
        lod1Loading: false,
        packedCanUseLod0: false,
        packedCanUseLod1: false,
        activeLod0Count: 0,
        activeLod1Count: 0,
      });
    }

    this.scratchRawL0 = new Int32Array(this.buckets.length);
    this.scratchRawL1 = new Int32Array(this.buckets.length);
    this.scratchMinL0Sq = new Float64Array(this.buckets.length);

    // Begin staggered non-blocking GLB loading in browser environments.
    if (LOADER_SHARED) {
      void this.loadAllStaggered();
      if (this.hedgePlacements.length) void this.loadTrimmedHedges();
    }
  }

  private async loadTrimmedHedges(): Promise<void> {
    if (this.disposed || !this.hedgePlacements.length) return;
    this.hedgeAcquired = true;
    const prop = await acquireStreetProp('hedgeTrimmed');
    if (this.disposed || !prop) return;
    const matrices = this.hedgePlacements.map((h) =>
      placeStreetPropOn(h.x, GROUND_Y, h.z, h.rotY, 1.0),
    );
    const grp = instanceStreetProp(prop, matrices, this.policy.castTreeShadows);
    grp.name = 'echo-life-trimmed-hedges';
    grp.visible = this.quality !== 'low';
    this.hedgeGroup = grp;
    this.group.add(grp);
  }

  private async loadBucketsStaggered(buckets: SpeciesBucket[]): Promise<void> {
    if (!LOADER_SHARED || this.disposed || buckets.length === 0) return;
    const byId = new Map(buckets.map(b => [b.species.id, b]));
    const ordered: SpeciesBucket[] = [];
    for (const id of LOAD_PRIORITY) {
      const b = byId.get(id);
      if (b) ordered.push(b);
    }
    for (const b of buckets) {
      if (!ordered.includes(b)) ordered.push(b);
    }

    const yieldFrame = () =>
      new Promise<void>(resolve => {
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => resolve());
        } else {
          setTimeout(resolve, 16);
        }
      });

    // Wave 1 & 2: Load trees in small staggered batches of 3 so first paint never hitches.
    const batchSize = 3;
    for (let i = 0; i < ordered.length; i += batchSize) {
      if (this.disposed) return;
      const slice = ordered.slice(i, i + batchSize);
      await Promise.all(slice.map(b => this.loadSpeciesBucket(b)));
      if (this.disposed) return;
      this.memoizedEmptyVegCells.clear();
      this.lastClassifiedX = this.lastPlayerX;
      this.lastClassifiedZ = this.lastPlayerZ;
      this.reclassifyLods(this.lastPlayerX, this.lastPlayerZ);
      this.reclassifyDirty = false;
      await yieldFrame();
    }
  }

  private async loadAllStaggered(): Promise<void> {
    await this.loadBucketsStaggered(this.buckets);
  }

  private async loadSpeciesBucket(bucket: SpeciesBucket): Promise<void> {
    if (!LOADER_SHARED || this.disposed) return;
    const skipLod0 = this.policy.lod0OnlyDisabled && Boolean(bucket.species.lod1Url);
    const jobs: Promise<void>[] = [];
    if (!skipLod0 && !bucket.lod0Loaded && !bucket.lod0Loading) {
      jobs.push(this.loadLodVariant(bucket, 0, bucket.species.lod0Url));
    }
    if (bucket.species.lod1Url && !bucket.lod1Loaded && !bucket.lod1Loading) {
      jobs.push(this.loadLodVariant(bucket, 1, bucket.species.lod1Url));
    }
    if (jobs.length === 0) return;
    await Promise.all(jobs);
    if (!this.disposed && (bucket.lod0Loaded || bucket.lod1Loaded)) {
      let loadedCount = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        const b = this.buckets[i];
        if (b.lod0Loaded || b.lod1Loaded) loadedCount++;
      }
      this.loadedSpeciesCount = loadedCount;
    }
  }

  private async loadLodVariant(bucket: SpeciesBucket, lod: 0 | 1, url: string): Promise<void> {
    if (!LOADER_SHARED || this.disposed) return;
    if (lod === 0) {
      if (bucket.lod0Loaded || bucket.lod0Loading) return;
      bucket.lod0Loading = true;
    } else {
      if (bucket.lod1Loaded || bucket.lod1Loading) return;
      bucket.lod1Loading = true;
    }
    try {
      const gltf = await LOADER_SHARED.loadAsync(url);
      if (this.disposed) {
        this.disposeSceneResources(gltf.scene);
        return;
      }

      gltf.scene.updateMatrixWorld(true);
      const parts: LodPart[] = [];
      const capacity = bucket.instances.length;

      // Collect meshes separated into opaque wood parts vs foliage parts.
      // For distant LOD1 trees (58–155 m), consolidate multiple opaque bark primitives (trunk + branches)
      // into ONE single merged InstancedMesh draw call so total active vegetation draw calls stay <= 35!
      const rawEntries: {
        geo: T.BufferGeometry;
        mat: T.MeshStandardMaterial;
        isFoliage: boolean;
      }[] = [];

      gltf.scene.traverse(obj => {
        if (!(obj instanceof T.Mesh) || !obj.geometry) return;
        const srcGeo = obj.geometry as T.BufferGeometry;
        const geo = srcGeo.clone();
        unpackVegQuantizedAttr(geo, 'position', 3);
        unpackVegQuantizedAttr(geo, 'normal', 3);
        unpackVegQuantizedAttr(geo, 'uv', 2);
        if (!obj.matrixWorld.equals(this.tmpMat.identity())) {
          geo.applyMatrix4(obj.matrixWorld);
        }
        const srcMat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
        const stdMat = demoteVegetationMaterial(srcMat);
        const isFoliage = classifyIsFoliageMaterial(stdMat, bucket.species);
        rawEntries.push({ geo, mat: stdMat, isFoliage });
      });

      const woodEntries = rawEntries.filter(e => !e.isFoliage);
      const folEntries = rawEntries.filter(e => e.isFoliage);
      const finalEntries: { geo: T.BufferGeometry; mat: T.MeshStandardMaterial; isFoliage: boolean }[] = [];

      // Keep LOD0 hero trees 100% authentic (separate photogrammetry trunk, branch, and crownshaft PBR materials!).
      // On distant LOD1 trees (58–155 m), consolidate opaque bark sub-meshes into ONE tiled-bark InstancedMesh
      // to save 1 draw call per distant tree species with zero visible difference at silhouette distance.
      const shouldMergeWood =
        bucket.species.category === 'tree' &&
        lod === 1 &&
        woodEntries.length > 1;

      if (shouldMergeWood) {
        // Normalize attribute set before mergeGeometries (position, normal, uv)
        const normalizedWood = woodEntries.map(e => {
          const g = e.geo.index ? e.geo.toNonIndexed() : e.geo.clone();
          for (const key of Object.keys(g.attributes)) {
            if (key !== 'position' && key !== 'normal' && key !== 'uv') {
              g.deleteAttribute(key);
            }
          }
          if (!g.attributes.normal) g.computeVertexNormals();
          return g;
        });
        const mergedWood = mergeGeometries(normalizedWood, false);
        for (const g of normalizedWood) g.dispose();
        if (mergedWood) {
          // Prefer tiled bark/branch material over unique-UV trunk material so merged UVs look crisp.
          const preferredMat =
            woodEntries.find(e => /branch|bark/i.test(e.mat.name))?.mat ?? woodEntries[0].mat;
          // Collect textures retained by preferredMat or foliage materials so discarded wood textures dispose cleanly (0 leak!).
          const keptTextures = new Set<T.Texture>();
          for (const matRef of [preferredMat, ...folEntries.map(f => f.mat)]) {
            for (const tex of [matRef.map, matRef.normalMap, matRef.roughnessMap, matRef.metalnessMap, matRef.aoMap, matRef.emissiveMap]) {
              if (tex) keptTextures.add(tex);
            }
          }
          for (const e of woodEntries) {
            e.geo.dispose();
            if (e.mat !== preferredMat) {
              for (const tex of [e.mat.map, e.mat.normalMap, e.mat.roughnessMap, e.mat.metalnessMap, e.mat.aoMap, e.mat.emissiveMap]) {
                if (tex && !keptTextures.has(tex)) tex.dispose();
              }
              e.mat.dispose();
            }
          }
          finalEntries.push({ geo: mergedWood, mat: preferredMat, isFoliage: false });
        } else {
          finalEntries.push(...woodEntries);
        }
      } else {
        finalEntries.push(...woodEntries);
      }
      finalEntries.push(...folEntries);

      const uploadQueue = getEchoLifeTextureUploadQueue();
      for (const entry of finalEntries) {
        const { geo, mat: stdMat, isFoliage } = entry;
        // Track textures for clean disposal, apply anisotropy cap & pace GPU initTexture uploads.
        for (const tex of [stdMat.map, stdMat.normalMap, stdMat.roughnessMap, stdMat.metalnessMap, stdMat.aoMap]) {
          if (tex) {
            this.ownedTextures.add(tex);
            if (tex.image) uploadQueue.enqueue(tex, LoadPriority.P2_NEAR_CHUNK);
          }
        }
        if (bucket.species.normalScale !== undefined && stdMat.normalMap) {
          stdMat.normalScale.set(bucket.species.normalScale, bucket.species.normalScale);
        }
        // Fix Royal Palm corrugated-pipe bark: widen leaf-scar ring spacing (`repeat.y = 0.52`), dampen glossy
        // plastic normal highlights (`normalScale = 0.36`), and calibrate matte fibrous bark (`roughness = 0.90`).
        const isPalmBark =
          bucket.species.id === 'veg-tree-palm-royal' &&
          !isFoliage &&
          (/bark|trunk/i.test(stdMat.name) || !/crown/i.test(stdMat.name));
        if (isPalmBark) {
          if (stdMat.normalMap) stdMat.normalScale.set(0.36, 0.36);
          stdMat.roughness = Math.max(stdMat.roughness, 0.90);
          for (const tex of [stdMat.map, stdMat.normalMap, stdMat.roughnessMap, stdMat.metalnessMap, stdMat.aoMap]) {
            if (!tex) continue;
            tex.wrapS = T.RepeatWrapping;
            tex.wrapT = T.RepeatWrapping;
            tex.repeat.set(1.0, 0.52);
          }
        }
        applyAnisotropyToMaterial(stdMat, this.maxAnisotropy);

        const patched = patchVegetationMaterial(stdMat, bucket.species, isFoliage, this.sharedUniforms);
        if (this.lastSeason >= 0 && patched.tintWeight > 0) {
          seasonColorForSpecies(bucket.species.id, this.lastSeason, patched.tintUniform.value);
        }
        this.patchedMaterials.push(patched);

        const im = new T.InstancedMesh(geo, stdMat, capacity);
        im.name = `${bucket.species.id}-lod${lod}-${parts.length}`;
        im.count = 0;
        im.visible = false;
        im.frustumCulled = true;
        // Static generous bounding sphere — NEVER recomputed per frame!
        im.boundingSphere = bucket.staticSphere.clone();
        im.matrixAutoUpdate = false;
        im.updateMatrix();
        this.applyShadowFlags(im, bucket.species, lod, isFoliage);

        this.group.add(im);
        parts.push({ mesh: im, geometry: geo, material: stdMat, isFoliage });
      }

      // Release original temporary GLTF geometries/materials (our InstancedMeshes hold clones).
      gltf.scene.traverse(obj => {
        if (obj instanceof T.Mesh) {
          obj.geometry?.dispose();
          const ms = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of ms) m?.dispose();
        }
      });

      if (lod === 0) {
        bucket.lod0Parts = parts;
        bucket.lod0Loaded = true;
      } else {
        bucket.lod1Parts = parts;
        bucket.lod1Loaded = true;
      }
    } catch {
      // Non-fatal in headless/offline tests: keep running gracefully without crashing world startup.
    } finally {
      if (lod === 0) bucket.lod0Loading = false;
      else bucket.lod1Loading = false;
    }
  }

  private applyShadowFlags(
    im: T.InstancedMesh,
    species: VegetationSpecies,
    lod: 0 | 1,
    isFoliage: boolean,
  ): void {
    const isTree = species.category === 'tree';
    const isBoulder = species.id === 'veg-rock-boulder';
    im.castShadow =
      (isTree && lod === 0 && this.policy.castTreeShadows) ||
      (isBoulder && this.policy.castBoulderShadows);
    im.receiveShadow = isFoliage ? this.policy.receiveFoliageShadows : this.policy.castTreeShadows;
  }

  setQuality(tier: QualityTier, maxAnisotropy?: number): void {
    if (this.disposed) return;
    this.quality = tier;
    this.policy = TIER_POLICY[tier];
    this.maxAnisotropy = maxAnisotropy ?? this.policy.defaultAnisotropy;

    for (const b of this.buckets) {
      for (const p of b.lod0Parts) {
        this.applyShadowFlags(p.mesh, b.species, 0, p.isFoliage);
        applyAnisotropyToMaterial(p.material, this.maxAnisotropy);
      }
      for (const p of b.lod1Parts) {
        this.applyShadowFlags(p.mesh, b.species, 1, p.isFoliage);
        applyAnisotropyToMaterial(p.material, this.maxAnisotropy);
      }
    }
    if (this.hedgeGroup) {
      this.hedgeGroup.visible = tier !== 'low';
      this.hedgeGroup.traverse((o) => {
        if (o instanceof T.InstancedMesh) o.castShadow = this.policy.castTreeShadows;
      });
    }
    this.memoizedEmptyVegCells.clear();
    this.reclassifyDirty = true;

    // If upgrading out of `low` (where LOD0 tree GLBs were skipped), stream in missing LOD0 buckets cleanly.
    if (!this.policy.lod0OnlyDisabled && LOADER_SHARED) {
      const missingLod0 = this.buckets.filter(b => !b.lod0Loaded && !b.lod0Loading);
      if (missingLod0.length > 0) {
        void this.loadBucketsStaggered(missingLod0);
      }
    }
  }

  setSectorVisibility(north: boolean, south: boolean, sides: boolean): void {
    if (
      this.sectorVis.north === north &&
      this.sectorVis.south === south &&
      this.sectorVis.sides === sides
    ) {
      return;
    }
    this.sectorVis.north = north;
    this.sectorVis.south = south;
    this.sectorVis.sides = sides;
    this.memoizedEmptyVegCells.clear();
    this.reclassifyDirty = true;
    this.lastClassifiedX = this.lastPlayerX;
    this.lastClassifiedZ = this.lastPlayerZ;
    this.reclassifyLods(this.lastPlayerX, this.lastPlayerZ);
    this.reclassifyDirty = false;
  }

  update(
    dt: number,
    playerX: number,
    playerZ: number,
    seasonIndex: number,
    snowCover: number,
    windStrength: number,
    timeSec: number,
  ): void {
    if (this.disposed) return;

    // Clamp player/camera query strictly to resident `city.bounds` so boundary riding never evaluates non-existent space.
    clampToBounds(playerX, playerZ, this.cityBounds, this.clampedPos);
    const cx = this.clampedPos.x;
    const cz = this.clampedPos.z;
    this.lastPlayerX = cx;
    this.lastPlayerZ = cz;

    // 1. Update shared GPU wind, snow & rain wetness uniforms (zero allocations).
    this.sharedUniforms.uVegTime.value = Number.isFinite(timeSec)
      ? timeSec
      : this.sharedUniforms.uVegTime.value + Math.max(0, Math.min(dt, 0.1));

    const ext = this.externalWeather;
    const clampedWind = Math.max(0, Math.min(3.5, Number.isFinite(windStrength) ? windStrength : 0.6));
    if (ext) {
      // Follow weather system's animated gust direction while honoring caller windStrength multiplier.
      const wx = ext.uWindVec.value.x;
      const wz = ext.uWindVec.value.y;
      const mag = Math.hypot(wx, wz);
      if (mag > 0.01) {
        const eff = Math.max(mag, clampedWind);
        this.sharedUniforms.uVegWind.value.set((wx / mag) * eff, (wz / mag) * eff);
      } else {
        this.sharedUniforms.uVegWind.value.set(clampedWind * 0.85, clampedWind * 0.52);
      }
      this.sharedUniforms.uVegWetness.value = ext.uWetness.value;
      this.sharedUniforms.uVegSnow.value = Math.max(snowCover, ext.uSnowCover.value);
    } else {
      const ang = 0.34 + Math.sin(this.sharedUniforms.uVegTime.value * 0.14) * 0.28;
      this.sharedUniforms.uVegWind.value.set(Math.cos(ang) * clampedWind, Math.sin(ang) * clampedWind);
      this.sharedUniforms.uVegWetness.value = 0;
      this.sharedUniforms.uVegSnow.value = Math.max(0, Math.min(1, snowCover));
    }

    // 2. Apply 4-season foliage tinting cleanly when season changes (NEVER tints bark/trunks/rocks!).
    const s = Math.max(0, Math.min(3, seasonIndex | 0));
    if (s !== this.lastSeason) {
      this.lastSeason = s;
      for (const entry of this.patchedMaterials) {
        if (entry.tintWeight > 0) {
          seasonColorForSpecies(entry.speciesId, s, this.tmpColor);
          entry.tintUniform.value.copy(this.tmpColor);
        }
      }
    }

    // 2b. Toggle winter biome policy (`swap-pine` for tropical palms, `suppress` for summer blooms) with 0 allocs.
    const isWinterBiome = s === 3 || this.sharedUniforms.uVegSnow.value >= 0.30;
    if (isWinterBiome !== this.winterBiomeActive) {
      this.winterBiomeActive = isWinterBiome;
      this.memoizedEmptyVegCells.clear();
      this.reclassifyDirty = true;
    }

    // 3. Distance LOD0 <-> LOD1 reclassification at 4 Hz (0.25 s cadence) with movement & perimeter cell guards.
    this.reclassifyTimer += Math.max(0, Math.min(dt, 0.25));
    if (this.reclassifyDirty || this.reclassifyTimer >= 0.25) {
      const dx = Number.isFinite(this.lastClassifiedX) ? cx - this.lastClassifiedX : Infinity;
      const dz = Number.isFinite(this.lastClassifiedZ) ? cz - this.lastClassifiedZ : Infinity;
      const movedEnough = dx * dx + dz * dz >= 2.25; // >= 1.5 m clamped displacement
      const cellX = Math.floor(cx * 0.25);
      const cellZ = Math.floor(cz * 0.25);
      const cellKey = (cellX + 8192) * 16384 + (cellZ + 8192);

      if (this.reclassifyDirty) {
        this.memoizedEmptyVegCells.clear();
      }
      if (this.reclassifyDirty || (movedEnough && !this.memoizedEmptyVegCells.has(cellKey))) {
        this.reclassifyTimer = 0;
        const wasDirty = this.reclassifyDirty;
        this.reclassifyDirty = false;
        this.lastClassifiedX = cx;
        this.lastClassifiedZ = cz;
        this.lastClassifiedCellKey = cellKey;
        this.reclassifyLods(cx, cz);
        if (!wasDirty && this.activeLod0Total === 0 && this.activeLod1Total === 0) {
          this.maybeMemoizeEmptyPerimeterCell(cx, cz, cellKey);
        }
      } else {
        // Keep timer primed so the next >= 1.5 m movement reclassifies immediately with zero wasted stationary ticks.
        this.reclassifyTimer = 0.25;
      }
    }
  }

  private maybeMemoizeEmptyPerimeterCell(cx: number, cz: number, cellKey: number): void {
    const safeClearDist = this.policy.lod1Dist + this.policy.hysteresis + 8.0;
    const safeSq = safeClearDist * safeClearDist;
    for (let bi = 0; bi < this.buckets.length; bi++) {
      const insts = this.buckets[bi].instances;
      for (let i = 0; i < insts.length; i++) {
        const dx = insts[i].x - cx;
        const dz = insts[i].z - cz;
        if (dx * dx + dz * dz <= safeSq) return;
      }
    }
    this.memoizedEmptyVegCells.add(cellKey);
  }

  private expectedPartCount(bucket: SpeciesBucket, lod: 0 | 1): number {
    if (lod === 0) {
      if (bucket.lod0Loaded) return bucket.lod0Parts.length;
      if (bucket.species.category !== 'tree') return 1;
      return bucket.species.id === 'veg-tree-banyan' || bucket.species.id === 'veg-tree-flame-poinciana' ? 2 : 3;
    }
    if (!bucket.species.lod1Url) return 0;
    if (bucket.lod1Loaded) return bucket.lod1Parts.length;
    return 2; // Merged wood + foliage on LOD1 trees
  }

  private reclassifyLods(playerX: number, playerZ: number): void {
    const pol = this.policy;
    const h = pol.hysteresis;
    const lod0EnterSq = pol.lod0Dist * pol.lod0Dist;
    const lod0ExitSq = (pol.lod0Dist + h) * (pol.lod0Dist + h);
    const lod1EnterSq = pol.lod1Dist * pol.lod1Dist;
    const lod1ExitSq = (pol.lod1Dist + h) * (pol.lod1Dist + h);
    const underEnterSq = pol.understoryDist * pol.understoryDist;
    const underExitSq = (pol.understoryDist + h * 0.7) * (pol.understoryDist + h * 0.7);
    // Low ground-huggers (< 0.60 m: flowers, grass tufts, ferns, calathea, small garden/border stones)
    // fade out closer than tall shrubs & boulders so sub-pixel accents in adjacent districts don't waste draw calls.
    const smallUnderDist = pol.understoryDist * 0.58;
    const smallUnderEnterSq = smallUnderDist * smallUnderDist;
    const smallUnderExitSq = (smallUnderDist + h * 0.6) * (smallUnderDist + h * 0.6);
    const innerGuardSq = (pol.lod0Dist * 0.62) * (pol.lod0Dist * 0.62);

    const nBuckets = this.buckets.length;
    const rawL0Arr = this.scratchRawL0;
    const rawL1Arr = this.scratchRawL1;
    const minL0SqArr = this.scratchMinL0Sq;

    // Pass 1: Distance + sector + detailTier + hysteresis classification for every instance.
    let activeDrawCalls = 0;
    for (let bi = 0; bi < nBuckets; bi++) {
      const bucket = this.buckets[bi];
      const isTree = bucket.species.category === 'tree';
      const isSmallUnderstory = !isTree && bucket.species.height < 0.6;
      const hasLod1 = Boolean(bucket.species.lod1Url);
      const insts = bucket.instances;
      const states = bucket.states;

      // Winter biome swap/suppression: hide tropical palms (`swap-pine` rendered via pre-allocated pine slots)
      // and summer tropical blooms (`suppress`) -> 0 winter palms & -6..-7 draw calls in snow!
      if (this.winterBiomeActive && (bucket.winterPolicy === 'swap-pine' || bucket.winterPolicy === 'suppress')) {
        states.fill(0);
        rawL0Arr[bi] = 0;
        rawL1Arr[bi] = 0;
        minL0SqArr[bi] = Infinity;
        continue;
      }

      let rawL0 = 0;
      let rawL1 = 0;
      let minL0DistSq = Infinity;
      const winterOnlyFrom = bucket.winterOnlyFromIndex;

      for (let i = 0; i < insts.length; i++) {
        if (!this.winterBiomeActive && i >= winterOnlyFrom) {
          states[i] = 0;
          continue;
        }
        const inst = insts[i];
        if (!this.sectorVis[inst.sector] || inst.detailTier > pol.maxDetailTier) {
          states[i] = 0;
          continue;
        }

        const dx = inst.x - playerX;
        const dz = inst.z - playerZ;
        const dSq = dx * dx + dz * dz;
        const prev = states[i];

        let desired: 0 | 1 | 2 = 0;
        if (isTree) {
          if (pol.lod0OnlyDisabled) {
            const maxSq = prev === 2 ? lod1ExitSq : lod1EnterSq;
            desired = dSq <= maxSq ? 2 : 0;
          } else if (prev === 1) {
            desired = dSq <= lod0ExitSq ? 1 : dSq <= lod1EnterSq ? 2 : 0;
          } else if (prev === 2) {
            desired = dSq <= lod0EnterSq ? 1 : dSq <= lod1ExitSq ? 2 : 0;
          } else {
            desired = dSq <= lod0EnterSq ? 1 : dSq <= lod1EnterSq ? 2 : 0;
          }
          if (desired === 2 && !hasLod1) desired = 1;
        } else {
          const enterSq = isSmallUnderstory ? smallUnderEnterSq : underEnterSq;
          const exitSq = isSmallUnderstory ? smallUnderExitSq : underExitSq;
          const maxSq = prev === 1 ? exitSq : enterSq;
          desired = dSq <= maxSq ? 1 : 0;
        }

        states[i] = desired;
        if (desired === 1) {
          rawL0++;
          if (dSq < minL0DistSq) minL0DistSq = dSq;
        } else if (desired === 2) {
          rawL1++;
        }
      }

      // Always coalesce trivial 1–2 instance distant tails so a lone tree never spawns an extra 2-DC LOD bucket.
      if (isTree && hasLod1 && !pol.lod0OnlyDisabled && rawL0 > 0 && rawL1 > 0) {
        if (rawL1 <= 2) {
          for (let i = 0; i < insts.length; i++) {
            if (states[i] === 2) states[i] = 1;
          }
          rawL0 += rawL1;
          rawL1 = 0;
        } else if (rawL0 <= 2 && rawL1 >= 5 && minL0DistSq >= innerGuardSq) {
          for (let i = 0; i < insts.length; i++) {
            if (states[i] === 1) states[i] = 2;
          }
          rawL1 += rawL0;
          rawL0 = 0;
        }
      }

      rawL0Arr[bi] = rawL0;
      rawL1Arr[bi] = rawL1;
      minL0SqArr[bi] = minL0DistSq;

      if (rawL0 > 0) activeDrawCalls += this.expectedPartCount(bucket, 0);
      if (rawL1 > 0) activeDrawCalls += this.expectedPartCount(bucket, 1);
    }

    // Pass 2: Disciplined draw-call budget guard (strictly <= pol.maxDrawCalls even across 360°!).
    // Coalesces dual-LOD tree species with the smallest secondary LOD tail first, preserving LOD0 for all
    // close hero trees (< 0.62 * lod0Dist) while keeping LOD1 active on major distant tree populations.
    while (activeDrawCalls > pol.maxDrawCalls && !pol.lod0OnlyDisabled) {
      let bestIdx = -1;
      let bestScore = Infinity;

      for (let bi = 0; bi < nBuckets; bi++) {
        const b = this.buckets[bi];
        if (b.species.category !== 'tree' || !b.species.lod1Url) continue;
        const r0 = rawL0Arr[bi];
        const r1 = rawL1Arr[bi];
        if (r0 <= 0 || r1 <= 0) continue;
        // Prefer coalescing the bucket with the smallest secondary tail (`min(r0, r1)`), tie-break by smaller `r1`.
        const score = Math.min(r0, r1) * 1000 + r1;
        if (score < bestScore) {
          bestScore = score;
          bestIdx = bi;
        }
      }

      if (bestIdx < 0) break;

      const b = this.buckets[bestIdx];
      const states = b.states;
      const r0 = rawL0Arr[bestIdx];
      const r1 = rawL1Arr[bestIdx];
      const minSq = minL0SqArr[bestIdx];

      // Promote distant tail into already-active LOD0 if close hero trees exist or tail is small (`<= 10`),
      // otherwise demote distant-edge LOD0 fringe (`>= 0.62 * lod0Dist`) into already-active LOD1.
      const shouldPromoteToLod0 = minSq < innerGuardSq || r1 <= 10;
      if (shouldPromoteToLod0) {
        for (let i = 0; i < states.length; i++) {
          if (states[i] === 2) states[i] = 1;
        }
        activeDrawCalls -= this.expectedPartCount(b, 1);
        rawL0Arr[bestIdx] = r0 + r1;
        rawL1Arr[bestIdx] = 0;
      } else {
        for (let i = 0; i < states.length; i++) {
          if (states[i] === 1) states[i] = 2;
        }
        activeDrawCalls -= this.expectedPartCount(b, 0);
        rawL1Arr[bestIdx] = r0 + r1;
        rawL0Arr[bestIdx] = 0;
      }
    }

    // Pass 3: Diff effective render slots & pack active world matrices ONLY for dirty LOD buffers (zero redundant GPU uploads!).
    let totalL0 = 0;
    let totalL1 = 0;

    for (let bi = 0; bi < nBuckets; bi++) {
      const bucket = this.buckets[bi];
      const canUseLod0 = bucket.lod0Loaded && bucket.lod0Parts.length > 0;
      const canUseLod1 = bucket.lod1Loaded && bucket.lod1Parts.length > 0;
      const insts = bucket.instances;
      const states = bucket.states;
      const packedSlots = bucket.packedSlots;
      const mats = bucket.matrices;

      let lod0Dirty = canUseLod0 !== bucket.packedCanUseLod0;
      let lod1Dirty = canUseLod1 !== bucket.packedCanUseLod1;
      bucket.packedCanUseLod0 = canUseLod0;
      bucket.packedCanUseLod1 = canUseLod1;

      let l0Count = 0;
      let l1Count = 0;
      for (let i = 0; i < insts.length; i++) {
        let renderSlot: 0 | 1 | 2 = states[i] as 0 | 1 | 2;
        if (renderSlot === 1 && !canUseLod0 && canUseLod1) renderSlot = 2;
        else if (renderSlot === 2 && !canUseLod1 && canUseLod0) renderSlot = 1;

        const prevSlot = packedSlots[i];
        if (prevSlot !== renderSlot) {
          if (prevSlot === 1 || renderSlot === 1) lod0Dirty = true;
          if (prevSlot === 2 || renderSlot === 2) lod1Dirty = true;
          packedSlots[i] = renderSlot;
        }
        if (renderSlot === 1) l0Count++;
        else if (renderSlot === 2) l1Count++;
      }

      bucket.activeLod0Count = l0Count;
      bucket.activeLod1Count = l1Count;
      totalL0 += l0Count;
      totalL1 += l1Count;

      if (!lod0Dirty && !lod1Dirty) continue;

      let l0Write = 0;
      let l1Write = 0;
      let l0MinX = Infinity, l0MaxX = -Infinity, l0MinZ = Infinity, l0MaxZ = -Infinity, l0MaxS = 1;
      let l1MinX = Infinity, l1MaxX = -Infinity, l1MinZ = Infinity, l1MaxZ = -Infinity, l1MaxS = 1;

      for (let i = 0; i < insts.length; i++) {
        const renderSlot = packedSlots[i];
        if (renderSlot === 0) continue;

        const inst = insts[i];
        if (renderSlot === 1 && lod0Dirty) {
          if (canUseLod0) {
            this.tmpMat.fromArray(mats, i * 16);
            for (let pi = 0; pi < bucket.lod0Parts.length; pi++) {
              bucket.lod0Parts[pi].mesh.setMatrixAt(l0Write, this.tmpMat);
            }
          }
          if (inst.x < l0MinX) l0MinX = inst.x;
          if (inst.x > l0MaxX) l0MaxX = inst.x;
          if (inst.z < l0MinZ) l0MinZ = inst.z;
          if (inst.z > l0MaxZ) l0MaxZ = inst.z;
          if (inst.scale > l0MaxS) l0MaxS = inst.scale;
          l0Write++;
        } else if (renderSlot === 2 && lod1Dirty) {
          if (canUseLod1) {
            this.tmpMat.fromArray(mats, i * 16);
            for (let pi = 0; pi < bucket.lod1Parts.length; pi++) {
              bucket.lod1Parts[pi].mesh.setMatrixAt(l1Write, this.tmpMat);
            }
          }
          if (inst.x < l1MinX) l1MinX = inst.x;
          if (inst.x > l1MaxX) l1MaxX = inst.x;
          if (inst.z < l1MinZ) l1MinZ = inst.z;
          if (inst.z > l1MaxZ) l1MaxZ = inst.z;
          if (inst.scale > l1MaxS) l1MaxS = inst.scale;
          l1Write++;
        }
      }

      // Update active InstancedMesh bounding spheres in-place & flag GPU upload ONLY for changed LOD buffers!
      if (lod0Dirty && canUseLod0) {
        const cx = l0Count > 0 ? (l0MinX + l0MaxX) * 0.5 : 0;
        const cz = l0Count > 0 ? (l0MinZ + l0MaxZ) * 0.5 : 0;
        const h = bucket.species.height * l0MaxS;
        const r = l0Count > 0
          ? Math.max(4.0, Math.hypot((l0MaxX - l0MinX) * 0.5, (l0MaxZ - l0MinZ) * 0.5, h * 0.5) + bucket.species.crownRadius * l0MaxS + 1.2)
          : 1.0;
        for (let pi = 0; pi < bucket.lod0Parts.length; pi++) {
          const part = bucket.lod0Parts[pi];
          part.mesh.count = l0Count;
          part.mesh.visible = l0Count > 0;
          if (l0Count > 0) {
            part.mesh.instanceMatrix.needsUpdate = true;
            if (part.mesh.boundingSphere) {
              part.mesh.boundingSphere.center.set(cx, GROUND_Y + h * 0.5, cz);
              part.mesh.boundingSphere.radius = r;
            }
          }
        }
      }
      if (lod1Dirty && canUseLod1) {
        const cx = l1Count > 0 ? (l1MinX + l1MaxX) * 0.5 : 0;
        const cz = l1Count > 0 ? (l1MinZ + l1MaxZ) * 0.5 : 0;
        const h = bucket.species.height * l1MaxS;
        const r = l1Count > 0
          ? Math.max(4.0, Math.hypot((l1MaxX - l1MinX) * 0.5, (l1MaxZ - l1MinZ) * 0.5, h * 0.5) + bucket.species.crownRadius * l1MaxS + 1.2)
          : 1.0;
        for (let pi = 0; pi < bucket.lod1Parts.length; pi++) {
          const part = bucket.lod1Parts[pi];
          part.mesh.count = l1Count;
          part.mesh.visible = l1Count > 0;
          if (l1Count > 0) {
            part.mesh.instanceMatrix.needsUpdate = true;
            if (part.mesh.boundingSphere) {
              part.mesh.boundingSphere.center.set(cx, GROUND_Y + h * 0.5, cz);
              part.mesh.boundingSphere.radius = r;
            }
          }
        }
      }
    }

    this.activeLod0Total = totalL0;
    this.activeLod1Total = totalL1;
  }

  stats(): VegetationStats {
    return {
      treeCount: this.totalTrees,
      understoryCount: this.totalUnderstory,
      activeLod0: this.activeLod0Total,
      activeLod1: this.activeLod1Total,
      loadedSpecies: this.loadedSpeciesCount,
    };
  }

  private disposeSceneResources(root: T.Object3D): void {
    root.traverse(obj => {
      if (obj instanceof T.Mesh) {
        obj.geometry?.dispose();
        const ms = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of ms) {
          if (m instanceof T.MeshStandardMaterial) {
            m.map?.dispose();
            m.normalMap?.dispose();
            m.roughnessMap?.dispose();
            m.metalnessMap?.dispose();
            m.aoMap?.dispose();
          }
          m?.dispose();
        }
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const bucket of this.buckets) {
      for (const p of bucket.lod0Parts) {
        p.mesh.removeFromParent();
        p.geometry.dispose();
        p.material.dispose();
      }
      for (const p of bucket.lod1Parts) {
        p.mesh.removeFromParent();
        p.geometry.dispose();
        p.material.dispose();
      }
      bucket.lod0Parts = [];
      bucket.lod1Parts = [];
    }
    if (this.hedgeGroup) {
      this.hedgeGroup.traverse((o) => {
        if (o instanceof T.InstancedMesh) o.dispose();
      });
      this.hedgeGroup.removeFromParent();
      this.hedgeGroup = null;
    }
    if (this.hedgeAcquired) {
      this.hedgeAcquired = false;
      releaseStreetProp('hedgeTrimmed');
    }
    for (const tex of this.ownedTextures) {
      tex.dispose();
    }
    this.ownedTextures.clear();
    this.patchedMaterials.length = 0;
    this.group.clear();
  }
}
