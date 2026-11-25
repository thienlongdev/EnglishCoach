import type * as T from 'three';
import type { ArenaIslandProfile } from './arenaContracts';
import {
  ARENA_PAVILIONS,
  ARENA_WATER_Y,
  arenaBathymetry,
  arenaBeachFactor,
  arenaHeight,
  arenaIslandAt,
  arenaLayout,
  arenaShoreRadius,
} from './arenaTerrain';

export interface FloraPlacement {
  x: number;
  y: number;
  z: number;
  yaw?: number;
  scale?: number;
  islandId?: string;
}

export type TreeColliderSpecies =
  | 'coconut'
  | 'royal_palm'
  | 'banyan'
  | 'canopy'
  | 'mango'
  | 'banana'
  | 'papaya';

export interface FloraTrunkCollider {
  x: number;
  z: number;
  radius: number;
  kind: 'tree_trunk';
  yaw: number;
  species: TreeColliderSpecies;
  islandId: string;
}

export interface ArchipelagoFloraPlacements {
  coconutPalms: FloraPlacement[];
  interactiveCoconutPalms: FloraPlacement[];
  royalPalms: FloraPlacement[];
  banyanTrees: FloraPlacement[];
  canopyTrees: FloraPlacement[];
  mangoTrees: FloraPlacement[];
  bananaTrees: FloraPlacement[];
  bougainvilleaBushes: FloraPlacement[];
  hibiscusBushes: FloraPlacement[];
  fernClusters: FloraPlacement[];
  beachGrasses: FloraPlacement[];
  coastalRockClusters: FloraPlacement[];
  marketStallPlacements: FloraPlacement[];
  stiltHousePlacements: FloraPlacement[];
  trunkColliders: FloraTrunkCollider[];
}

export type GroundHeightSampler = (x: number, z: number, outNormal?: T.Vector3) => number;

interface SpeciesRootSpec {
  /** Unscaled horizontal root-collar / buttress radius measured from the v7 LOD0 GLB (`y <= minY + 0.08 m`). */
  flareRadiusM: number;
  /** Unscaled lowest vertex Y of the GLB mesh (`> 0` on banyan/canopy). */
  glbMinYM: number;
  /** Additional soil embed depth below `minPerimeterGroundY` for wild procedural trees (`0.08..0.22 m`). */
  embedM: number;
  /** Tight collar embed for flat-terrace interactive fruit trees (`< 4 cm` crown-socket tolerance). */
  interactiveEmbedM: number;
  /** Waist-height physical trunk radius in `arenaLayout.json` (`solidBlocked` adds `+0.30 m` player capsule). */
  trunkRadiusM: number;
  /** Maximum terrain slope (degrees) where this root architecture looks natural without deep uphill burial. */
  maxSlopeDeg: number;
}

/**
 * Exact measured v7 LOD0 GLB base geometry and physical waist-height trunk collider radii:
 * - `coconut` / `royal_palm` / `banana` / `papaya`: `0.22 m` (`+0.30 m` capsule = `0.52 m` stop)
 * - `mango`: `0.28 m` (`0.58 m` stop)
 * - `canopy`: `0.34 m` (`0.64 m` stop)
 * - `banyan`: `0.48 m` (`0.78 m` stop)
 */
export const FLORA_SPECIES_SPECS: Readonly<Record<TreeColliderSpecies, SpeciesRootSpec>> = Object.freeze({
  coconut: {
    flareRadiusM: 0.59,
    glbMinYM: 0.0,
    embedM: 0.11,
    interactiveEmbedM: 0.005,
    trunkRadiusM: 0.22,
    maxSlopeDeg: 25.0,
  },
  royal_palm: {
    flareRadiusM: 0.67,
    glbMinYM: 0.0,
    embedM: 0.11,
    interactiveEmbedM: 0.005,
    trunkRadiusM: 0.22,
    maxSlopeDeg: 25.0,
  },
  papaya: {
    flareRadiusM: 0.67,
    glbMinYM: 0.0,
    embedM: 0.09,
    interactiveEmbedM: 0.005,
    trunkRadiusM: 0.22,
    maxSlopeDeg: 10.0,
  },
  mango: {
    flareRadiusM: 0.51,
    glbMinYM: 0.0,
    embedM: 0.10,
    interactiveEmbedM: 0.005,
    trunkRadiusM: 0.28,
    maxSlopeDeg: 10.0,
  },
  banana: {
    flareRadiusM: 0.47,
    glbMinYM: 0.0,
    embedM: 0.10,
    interactiveEmbedM: 0.005,
    trunkRadiusM: 0.22,
    maxSlopeDeg: 10.0,
  },
  canopy: {
    flareRadiusM: 1.25,
    glbMinYM: 0.0096,
    embedM: 0.15,
    interactiveEmbedM: 0.15,
    trunkRadiusM: 0.34,
    maxSlopeDeg: 19.0,
  },
  banyan: {
    flareRadiusM: 1.70,
    glbMinYM: 0.0049,
    embedM: 0.20,
    interactiveEmbedM: 0.20,
    trunkRadiusM: 0.48,
    maxSlopeDeg: 18.0,
  },
});

const SOFT_FLARE = Object.freeze({
  bougainvillea: { flareRadiusM: 0.36, embedM: 0.05 },
  hibiscus: { flareRadiusM: 0.36, embedM: 0.05 },
  fern: { flareRadiusM: 1.05, embedM: 0.06 },
  beachGrass: { flareRadiusM: 0.46, embedM: 0.05 },
  coastalRock: { flareRadiusM: 1.65, embedM: 0.22 },
  marketStall: { flareRadiusM: 1.88, embedM: 0.06 },
  stiltHouse: { flareRadiusM: 3.56, embedM: 0.16 },
});

/** Curated coastal stilt-house sites on `fishing_village` (wooden stilts grounded below lowest perimeter post). */
const STILT_HOUSE_SITES: ReadonlyArray<{ x: number; z: number; yaw: number; scale: number; islandId: string }> = [
  { x: -214, z: 108, yaw: 0.65, scale: 1.0, islandId: 'fishing_village' },
  { x: -222, z: 136, yaw: 1.45, scale: 0.96, islandId: 'fishing_village' },
  { x: -202, z: 162, yaw: 2.35, scale: 1.02, islandId: 'fishing_village' },
];

/** Curated dry, gentle-slope market-stall sites (`groundY >= +0.95 m >> ARENA_WATER_Y + 0.45 m`, clear of kiosks). */
const MARKET_STALL_SITES: ReadonlyArray<{ x: number; z: number; yaw: number; scale: number; islandId: string }> = [
  { x: -178, z: 118, yaw: -0.5, scale: 1.0, islandId: 'fishing_village' },
  { x: -172, z: 134, yaw: -1.6, scale: 1.0, islandId: 'fishing_village' },
  { x: -182, z: 146, yaw: 2.7, scale: 1.0, islandId: 'fishing_village' },
  { x: 186.5, z: 67.5, yaw: -2.1, scale: 0.95, islandId: 'tropical_beach' },
];

function roundCoord(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function segmentDistance(ax: number, az: number, bx: number, bz: number, x: number, z: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
  return Math.hypot(x - ax - t * dx, z - az - t * dz);
}

function angleDiff(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

/** Analytical terrain slope in degrees from `arenaBathymetry` (`0.25 m` central difference). */
export function arenaSlopeDegreesAt(x: number, z: number): number {
  const eps = 0.25;
  const gx = (arenaBathymetry(x + eps, z) - arenaBathymetry(x - eps, z)) / (2 * eps);
  const gz = (arenaBathymetry(x, z + eps) - arenaBathymetry(x, z - eps)) / (2 * eps);
  return (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
}

/**
 * Samples center + 6 inner-ring (`0.55 R`) + 12 outer-ring (`1.0 R`) points around `(x, z)`
 * so the root base never overhangs air on any downhill azimuth (`maxExposedRootGapM === 0`).
 */
export function sampleMinPerimeterGroundY(
  sampleGround: GroundHeightSampler,
  x: number,
  z: number,
  worldFlareRadius: number,
): number {
  let minY = sampleGround(x, z);
  if (worldFlareRadius <= 1e-4) return minY;
  const innerR = worldFlareRadius * 0.55;
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const h = sampleGround(x + Math.cos(a) * innerR, z + Math.sin(a) * innerR);
    if (h < minY) minY = h;
  }
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const h = sampleGround(x + Math.cos(a) * worldFlareRadius, z + Math.sin(a) * worldFlareRadius);
    if (h < minY) minY = h;
  }
  return minY;
}

export function computeGroundedTreeY(
  sampleGround: GroundHeightSampler,
  x: number,
  z: number,
  scale: number,
  species: TreeColliderSpecies,
  interactive = false,
): number {
  const spec = FLORA_SPECIES_SPECS[species];
  const minPerimY = sampleMinPerimeterGroundY(sampleGround, x, z, spec.flareRadiusM * scale);
  const embed = interactive ? spec.interactiveEmbedM : spec.embedM;
  return minPerimY - spec.glbMinYM * scale - embed;
}

function computeGroundedPropY(
  sampleGround: GroundHeightSampler,
  x: number,
  z: number,
  scale: number,
  flareRadiusM: number,
  embedM: number,
): number {
  const minPerimY = sampleMinPerimeterGroundY(sampleGround, x, z, flareRadiusM * scale);
  return minPerimY - embedM;
}

/**
 * Hydrological, architectural, promenade, and boat-landing corridor exclusion filter.
 * Depends strictly on analytical terrain & static non-tree layout entities so generated
 * `(x, z)` tree coordinates are 100% deterministic and idempotent across FE and BE.
 */
function isExcludedFloraSite(x: number, z: number, islId: string, isTree: boolean): boolean {
  // 1. Central Pearl Harbor arrival plaza & spawn
  if (Math.hypot(x, z) < 35) return true;

  // 2. Green Mountain waterfall hydrological corridor (spring -> cascade -> (6, -189) plunge pool -> river mouth)
  if (islId === 'green_mountain' && x >= -23 && x <= 19 && z >= -233 && z <= -151) {
    return true;
  }
  // Keep Green Mountain summit hike trail `(-6, -150) -> (-16, -225)` clear for smooth ascent
  if (islId === 'green_mountain' && segmentDistance(-6, -150, -16, -225, x, z) < 4.2) {
    return true;
  }

  // 3. Key harbor promenades & test walk corridors on `commons` and `tropical_beach`
  if (islId === 'commons') {
    if (segmentDistance(0, 0, 0, 36, x, z) < 4.0) return true;
    if (segmentDistance(0, 36, 18, 52, x, z) < 4.0) return true;
    if (segmentDistance(18, 52, 19.737, 65.947, x, z) < 4.5) return true;
    if (segmentDistance(0, 0, 64.62, 28.168, x, z) < 4.2) return true;
    if (Math.abs(z - 2) < 3.5 && x >= -6 && x <= 56) return true;
    const bearing = Math.atan2(z, x);
    if (Math.abs(angleDiff(bearing, 2.30)) < 0.12) return true;
    if (Math.abs(angleDiff(bearing, 0.85)) < 0.10) return true;
    if (Math.abs(angleDiff(bearing, -0.35)) < 0.10) return true;
  }
  if (islId === 'tropical_beach') {
    if (segmentDistance(120.104, 52.353, 195, 85, x, z) < 4.2) return true;
    if (segmentDistance(195, 85, 168, 32, x, z) < 4.0) return true;
    if (segmentDistance(168, 32, 159.129, 15.965, x, z) < 4.2) return true;
  }

  // 4. Island centers & landmark interior reference points
  for (const isl of arenaLayout.islands) {
    if (Math.hypot(x - isl.x, z - isl.z) < 4.5) return true;
    if (isl.id === 'lighthouse' && Math.hypot(x - (isl.x + 7), z - isl.z) < 5.5) return true;
    if (isl.profile === 'atoll') {
      if (Math.hypot(x - (isl.x + 54), z - isl.z) < 4.0) return true;
      if (Math.hypot(x - isl.x, z - (isl.z - 56)) < 4.0) return true;
      // Keep >= 4.5 m clear of inner snorkeling lagoon rim
      const ldx = x - isl.x;
      const ldz = z - isl.z - 2;
      const lr = Math.hypot(ldx, ldz);
      const lAngle = Math.atan2(ldz, ldx);
      const lagoonR = 35 + 3.0 * Math.sin(lAngle * 3 + isl.seed) + 1.6 * Math.cos(lAngle * 5 - isl.seed);
      if (lr < lagoonR + (isTree ? 4.8 : 2.5)) return true;
    }
  }

  // 5. Piers & bridges (full deck segments + approach plazas)
  for (const d of arenaLayout.docks) {
    if (segmentDistance(d.ax, d.az, d.bx, d.bz, x, z) < d.width / 2 + 5.2) return true;
    if (Math.hypot(x - d.ax, z - d.az) < 8.5 || Math.hypot(x - d.bx, z - d.bz) < 8.5) return true;
  }
  for (const b of arenaLayout.bridges) {
    if (segmentDistance(b.ax, b.az, b.bx, b.bz, x, z) < b.width / 2 + 5.2) return true;
    if (Math.hypot(x - b.ax, z - b.az) < 8.5 || Math.hypot(x - b.bx, z - b.bz) < 8.5) return true;
  }

  // 6. Pavilions, stilt houses, and market stalls
  for (const pav of ARENA_PAVILIONS) {
    if (Math.hypot(x - pav.x, z - pav.z) < 6.4 * pav.scale) return true;
  }
  for (const sh of STILT_HOUSE_SITES) {
    if (Math.hypot(x - sh.x, z - sh.z) < 5.6 * sh.scale) return true;
  }
  for (const ms of MARKET_STALL_SITES) {
    if (Math.hypot(x - ms.x, z - ms.z) < 4.4 * ms.scale) return true;
  }

  // 7. Benches, tables, and amphitheater tiers (`r < 3.4 m` + oriented half-extents)
  for (const f of arenaLayout.furniture) {
    const halfSpan = Math.hypot(f.width * 0.5, f.depth * 0.5);
    if (Math.hypot(x - f.x, z - f.z) < Math.max(3.4, halfSpan + 2.2)) return true;
  }

  // 8. All interactables (`kiosk`, `beacon`, `telescope`, `artifact`, `fishing_spot`, `fruit_tree`)
  for (const inter of arenaLayout.interactables) {
    if (Math.hypot(x - inter.x, z - inter.z) < 5.5) return true;
  }

  // 9. Static non-trunk obstacles (`planter`, `palm`, `shrub`, `lantern`, `sign`, `karst_spire`, `cargo`, `tower`, etc.)
  for (const o of arenaLayout.obstacles) {
    if (o.kind === 'tree_trunk' || o.kind === 'trunk') continue;
    if (Math.hypot(x - o.x, z - o.z) < o.radius + (isTree ? 2.8 : 1.6)) return true;
  }

  return false;
}

/**
 * Builds deterministic grounded flora, coastal rock, stilt-house, market-stall, and
 * `1:1` waist-height `tree_trunk` collider lists across all 15 Echo Archipelago v7 islands.
 */
export function buildArchipelagoFloraPlacements(
  sampleGround: GroundHeightSampler = arenaBathymetry,
): ArchipelagoFloraPlacements {
  const coconutPalms: FloraPlacement[] = [];
  const interactiveCoconutPalms: FloraPlacement[] = [];
  const royalPalms: FloraPlacement[] = [];
  const banyanTrees: FloraPlacement[] = [];
  const canopyTrees: FloraPlacement[] = [];
  const mangoTrees: FloraPlacement[] = [];
  const bananaTrees: FloraPlacement[] = [];
  const bougainvilleaBushes: FloraPlacement[] = [];
  const hibiscusBushes: FloraPlacement[] = [];
  const fernClusters: FloraPlacement[] = [];
  const beachGrasses: FloraPlacement[] = [];
  const coastalRockClusters: FloraPlacement[] = [];
  const trunkColliders: FloraTrunkCollider[] = [];

  // 1. Existing layout-authored `palm` stone planters & `shrub` beds (planters already own their `palm` / `shrub` colliders)
  for (const [idx, o] of arenaLayout.obstacles.entries()) {
    if (o.kind === 'palm') {
      royalPalms.push({
        x: o.x,
        y: arenaHeight(o.x, o.z) + 0.34,
        z: o.z,
        yaw: idx * 1.17,
        scale: 1.04,
        islandId: arenaIslandAt(o.x, o.z),
      });
    } else if (o.kind === 'shrub') {
      bougainvilleaBushes.push({
        x: o.x,
        y: computeGroundedPropY(
          sampleGround,
          o.x,
          o.z,
          1.08,
          SOFT_FLARE.bougainvillea.flareRadiusM,
          SOFT_FLARE.bougainvillea.embedM,
        ),
        z: o.z,
        yaw: o.yaw ?? idx,
        scale: 1.08,
        islandId: arenaIslandAt(o.x, o.z),
      });
    }
  }

  // 2. All 16 interactive `fruit_tree`s (`1:1` visual tree + tight waist-height `tree_trunk` collider at exact `(ft.x, ft.z)`)
  const fruitInteractables = arenaLayout.interactables.filter(i => i.kind === 'fruit_tree');
  for (const [idx, ft] of fruitInteractables.entries()) {
    const sub = ((ft as { subkind?: string }).subkind ?? 'coconut') as TreeColliderSpecies;
    const species: TreeColliderSpecies =
      sub === 'mango' || sub === 'banana' || sub === 'papaya' ? sub : 'coconut';
    const baseYaw = roundCoord(ft.yaw ?? idx * 1.3);
    const scale = species === 'papaya' ? 0.56 : 1.05;
    const y = computeGroundedTreeY(sampleGround, ft.x, ft.z, scale, species, true);

    if (species === 'mango') {
      mangoTrees.push({ x: ft.x, y, z: ft.z, yaw: baseYaw, scale, islandId: ft.island });
    } else if (species === 'banana') {
      bananaTrees.push({ x: ft.x, y, z: ft.z, yaw: baseYaw, scale, islandId: ft.island });
    } else if (species === 'papaya') {
      royalPalms.push({ x: ft.x, y, z: ft.z, yaw: baseYaw, scale, islandId: ft.island });
    } else {
      interactiveCoconutPalms.push({ x: ft.x, y, z: ft.z, yaw: baseYaw, scale, islandId: ft.island });
    }

    trunkColliders.push({
      x: roundCoord(ft.x),
      z: roundCoord(ft.z),
      radius: FLORA_SPECIES_SPECS[species].trunkRadiusM,
      kind: 'tree_trunk',
      yaw: baseYaw,
      species,
      islandId: ft.island,
    });
  }

  // 3. Deterministic archipelago groves & understory across all 15 islands (`vegSeed = 4099`)
  let vegSeed = 4099;
  const vRand = () => {
    vegSeed = (vegSeed * 1664525 + 1013904223) >>> 0;
    return vegSeed / 4294967296;
  };

  const hasNearbyTreeTrunk = (x: number, z: number, minGapM: number): boolean => {
    for (const tc of trunkColliders) {
      if (Math.hypot(x - tc.x, z - tc.z) < minGapM) return true;
    }
    return false;
  };

  for (const isl of arenaLayout.islands) {
    const prof = (isl.profile as ArenaIslandProfile | undefined) ?? 'outer';
    const samples = prof === 'islet' ? 7 : prof === 'mountain' || prof === 'beach' ? 38 : 28;
    for (let s = 0; s < samples; s++) {
      const a = (s / samples) * Math.PI * 2 + (vRand() - 0.5) * 0.18;
      const rfRand = vRand();
      const yaw = roundCoord(vRand() * Math.PI * 2);
      const sc = roundCoord(0.86 + vRand() * 0.34);

      const shoreR = arenaShoreRadius(isl, a);
      const rf = prof === 'atoll' ? 0.72 + rfRand * 0.17 : 0.34 + rfRand * 0.50;
      const radialDist = shoreR * rf;
      const x = roundCoord(isl.x + Math.cos(a) * radialDist);
      const z = roundCoord(isl.z + Math.sin(a) * radialDist);

      // Keep >= 4.6 m inland of shoreline so beach wading & all 15-island boat disembark/re-board corridors stay 100% open
      const minCoastMargin = prof === 'islet' ? 4.8 : 4.6;
      const clearOfCoast = radialDist <= shoreR - minCoastMargin;
      const centerBathY = arenaBathymetry(x, z);
      if (centerBathY < 0.28) continue;

      const bf = arenaBeachFactor(isl, a);
      const slopeDeg = arenaSlopeDegreesAt(x, z);

      // Decide candidate species vs understory
      let wantedTree: TreeColliderSpecies | null = null;
      let treeScale = sc;
      let fallbackShrub: 'beach_grass' | 'hibiscus' | 'fern' | 'bougainvillea' = 'hibiscus';

      if (bf > 0.35 || prof === 'beach' || prof === 'atoll' || prof === 'islet') {
        if (s % 3 === 0) wantedTree = 'coconut';
        else if (s % 3 === 1) fallbackShrub = 'beach_grass';
        else fallbackShrub = 'hibiscus';
      } else if (prof === 'mountain') {
        if (s % 5 === 0) {
          wantedTree = 'banyan';
          treeScale = roundCoord(sc * 0.95);
          fallbackShrub = 'fern';
        } else if (s % 3 === 0) {
          wantedTree = 'canopy';
          fallbackShrub = 'fern';
        } else {
          fallbackShrub = 'fern';
        }
      } else if (prof === 'karst') {
        if (s % 4 === 0) {
          wantedTree = 'canopy';
          treeScale = roundCoord(sc * 0.88);
          fallbackShrub = 'fern';
        } else if (s % 2 === 0) {
          fallbackShrub = 'fern';
        } else {
          fallbackShrub = 'bougainvillea';
        }
      } else {
        if (s % 4 === 0) wantedTree = 'royal_palm';
        else if (s % 4 === 1) {
          wantedTree = 'canopy';
          treeScale = roundCoord(sc * 0.9);
          fallbackShrub = 'hibiscus';
        } else if (s % 4 === 2) fallbackShrub = 'hibiscus';
        else fallbackShrub = 'bougainvillea';
      }

      // Enforce <= 26 deg hard slope ceiling for all trees & species-specific buttress slope limits
      if (wantedTree !== null) {
        if (slopeDeg > 26.0 || !clearOfCoast || isExcludedFloraSite(x, z, isl.id, true) || hasNearbyTreeTrunk(x, z, 3.2)) {
          wantedTree = null;
        } else if (slopeDeg > FLORA_SPECIES_SPECS[wantedTree].maxSlopeDeg) {
          // On 18.5..25 deg slopes, swap wide-buttress banyan/canopy for slender-collar royal palm so trunks never over-bury
          wantedTree = slopeDeg <= FLORA_SPECIES_SPECS.royal_palm.maxSlopeDeg ? 'royal_palm' : null;
          treeScale = sc;
        }
      }

      if (wantedTree !== null) {
        const spec = FLORA_SPECIES_SPECS[wantedTree];
        const minAnalyticalPerim = sampleMinPerimeterGroundY(arenaBathymetry, x, z, spec.flareRadiusM * treeScale);
        if (minAnalyticalPerim >= 0.12) {
          const y = computeGroundedTreeY(sampleGround, x, z, treeScale, wantedTree, false);
          const placement: FloraPlacement = { x, y, z, yaw, scale: treeScale, islandId: isl.id };
          if (wantedTree === 'coconut') coconutPalms.push(placement);
          else if (wantedTree === 'royal_palm') royalPalms.push(placement);
          else if (wantedTree === 'banyan') banyanTrees.push(placement);
          else if (wantedTree === 'canopy') canopyTrees.push(placement);

          trunkColliders.push({
            x,
            z,
            radius: spec.trunkRadiusM,
            kind: 'tree_trunk',
            yaw,
            species: wantedTree,
            islandId: isl.id,
          });
          continue;
        }
      }

      // Soft understory foliage (no trunk collider; still excluded from piers, water, waterfall, and furniture)
      if (radialDist > shoreR - 2.4 || slopeDeg > 32.0 || isExcludedFloraSite(x, z, isl.id, false)) {
        continue;
      }
      if (fallbackShrub === 'beach_grass') {
        const gScale = roundCoord(sc * 1.15);
        beachGrasses.push({
          x,
          y: computeGroundedPropY(sampleGround, x, z, gScale, SOFT_FLARE.beachGrass.flareRadiusM, SOFT_FLARE.beachGrass.embedM),
          z,
          yaw,
          scale: gScale,
          islandId: isl.id,
        });
      } else if (fallbackShrub === 'fern') {
        const fScale = roundCoord(prof === 'mountain' ? sc * 1.1 : sc);
        fernClusters.push({
          x,
          y: computeGroundedPropY(sampleGround, x, z, fScale, SOFT_FLARE.fern.flareRadiusM, SOFT_FLARE.fern.embedM),
          z,
          yaw,
          scale: fScale,
          islandId: isl.id,
        });
      } else if (fallbackShrub === 'bougainvillea') {
        bougainvilleaBushes.push({
          x,
          y: computeGroundedPropY(sampleGround, x, z, sc, SOFT_FLARE.bougainvillea.flareRadiusM, SOFT_FLARE.bougainvillea.embedM),
          z,
          yaw,
          scale: sc,
          islandId: isl.id,
        });
      } else {
        hibiscusBushes.push({
          x,
          y: computeGroundedPropY(sampleGround, x, z, sc, SOFT_FLARE.hibiscus.flareRadiusM, SOFT_FLARE.hibiscus.embedM),
          z,
          yaw,
          scale: sc,
          islandId: isl.id,
        });
      }
    }

    // 4. Scenic coastal headland rock clusters (clear of beaches, piers, and bridges)
    for (let rIdx = 0; rIdx < (prof === 'islet' ? 2 : 5); rIdx++) {
      const a = (rIdx / (prof === 'islet' ? 2 : 5)) * Math.PI * 2 + isl.seed;
      if (arenaBeachFactor(isl, a) > 0.3) continue;
      const sr = arenaShoreRadius(isl, a) - 1.2;
      const rx = roundCoord(isl.x + Math.cos(a) * sr);
      const rz = roundCoord(isl.z + Math.sin(a) * sr);
      if (isExcludedFloraSite(rx, rz, isl.id, false)) continue;
      const rScale = roundCoord(0.85 + (rIdx % 3) * 0.22);
      coastalRockClusters.push({
        x: rx,
        y: Math.max(
          ARENA_WATER_Y - 0.65,
          computeGroundedPropY(sampleGround, rx, rz, rScale, SOFT_FLARE.coastalRock.flareRadiusM, SOFT_FLARE.coastalRock.embedM),
        ),
        z: rz,
        yaw: roundCoord(a + 0.6),
        scale: rScale,
        islandId: isl.id,
      });
    }
  }

  // 5. Grounded stilt houses & dry flat market stalls (`groundY >= +0.95 m >> ARENA_WATER_Y + 0.45 m`)
  const stiltHousePlacements: FloraPlacement[] = STILT_HOUSE_SITES.map(sh => ({
    x: sh.x,
    y: computeGroundedPropY(sampleGround, sh.x, sh.z, sh.scale, SOFT_FLARE.stiltHouse.flareRadiusM, SOFT_FLARE.stiltHouse.embedM),
    z: sh.z,
    yaw: sh.yaw,
    scale: sh.scale,
    islandId: sh.islandId,
  }));

  const marketStallPlacements: FloraPlacement[] = MARKET_STALL_SITES.map(ms => ({
    x: ms.x,
    y: computeGroundedPropY(sampleGround, ms.x, ms.z, ms.scale, SOFT_FLARE.marketStall.flareRadiusM, SOFT_FLARE.marketStall.embedM),
    z: ms.z,
    yaw: ms.yaw,
    scale: ms.scale,
    islandId: ms.islandId,
  }));

  return {
    coconutPalms,
    interactiveCoconutPalms,
    royalPalms,
    banyanTrees,
    canopyTrees,
    mangoTrees,
    bananaTrees,
    bougainvilleaBushes,
    hibiscusBushes,
    fernClusters,
    beachGrasses,
    coastalRockClusters,
    marketStallPlacements,
    stiltHousePlacements,
    trunkColliders,
  };
}
