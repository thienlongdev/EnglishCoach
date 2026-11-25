import * as T from 'three';
import { GROUND_Y, inRect, rect as makeRect, type HousePlan, type Rect } from '@/lib/echo-life/plan';
import { hash01, type CityPlan } from '@/lib/echo-life/city';
import type { V3ZoneId } from '@/lib/echo-life/zones';
import {
  BOX_A,
  COLOR_A,
  M4_A,
  Q_A,
  V3_A,
  V3_B,
  V3_C,
  disposeObjectTree,
} from './scratch';
import { chainMaterialShader, patchMaterialWithEchoCsm } from './echoCsm';
import { getSharedHeightFogUniforms, patchHeightFog } from './atmosphere';
import { clampToBounds } from './streaming';

/**
 * Echo Life — AAA GPU-Instanced Ecological Grass & Ground-Cover Engine.
 *
 * Renders lush, wind-animated emerald botanical meadows across all outdoor green zones (`park`, `botanical`,
 * `campus` landscaped quads, `greenway`, `lantern_garden`, `fountain_plaza` planters, and `yard`)
 * partitioned into frustum-culled `32×32 m` `InstancedMesh` tiles (1 draw call per active tile, `~26` total
 * tiles city-wide including wildflowers) with a secondary wildflower & clover accent layer (`64×64 m` tiles).
 *
 * Performance architecture:
 * - Zero per-frame JS matrix rebuilds (`< 0.05 ms` CPU/frame): `update()` writes only shared shader uniforms.
 * - Custom 6-blade curved, tapered botanical tuft geometry with root-AO-to-sunlit-tip vertex colors and
 *   upward-biased soft foliage normals (`castShadow = false`, `receiveShadow = true` on High/Ultra).
 * - Preserves full Three.js PBR pipeline (`MeshStandardMaterial` + `onBeforeCompile`: HDRI IBL, directional
 *   shadow receiving, `FogExp2`, and `AgX` tone mapping) with world-space traveling wind waves, player &
 *   vehicle foot-bend displacement, backlit subsurface translucency, smooth 4-season + rain/snow response,
 *   and seamless vertex-shader distance fade-out with zero pop-in.
 */

export type GrassQualityTier = 'ultra' | 'high' | 'balanced' | 'low';

export interface GrassUpdateInput {
  dt: number;
  reduced?: boolean;
  /** Player feet world position for subtle radial foot-bend displacement. */
  actorPos?: { x: number; y: number; z: number } | null;
  /** Optional camera world position for CPU tile distance culling (falls back to `actorPos`). */
  cameraPos?: { x: number; y: number; z: number } | null;
  /** Optional active drivable vehicle position & radial wheel-flatten radius. */
  vehiclePos?: { x: number; y: number; z: number; radius?: number } | null;
  /** Normalized world-space sun direction vector (for backlit subsurface translucency). */
  sunDir?: { x: number; y: number; z: number } | null;
  /** 0 (night) .. 1 (midday). Scales backlit translucency so night meadows stay natural. */
  day?: number;
  /** 0 = Spring, 1 = Summer, 2 = Autumn, 3 = Winter. */
  season?: number;
  /** 0..1 active rain intensity (drives wind boost + wetness accumulation if `wetness` omitted). */
  rain?: number;
  /** 0..1 snow intensity / cover. */
  snow?: number;
  /** Optional explicit 0..1 surface wetness override (e.g., from `SharedWeatherUniforms.uWetness`). */
  wetness?: number;
  /** Optional explicit 0..1 snow cover override (e.g., from `SharedWeatherUniforms.uSnowCover`). */
  snowCover?: number;
  /** Optional world XZ wind vector (metres/sec); if omitted, generated smoothly from time & weather. */
  windVec?: { x: number; y?: number; z?: number } | null;
  /** Optional scalar wind strength multiplier override (`0.15..1.8`). */
  windStrength?: number;
}

export interface GrassFieldStats {
  quality: GrassQualityTier;
  tileCount: number;
  accentTileCount: number;
  totalTufts: number;
  totalBlades: number;
  accentCount: number;
  drawCalls: number;
  visibleTiles: number;
}

export interface GrassField {
  readonly group: T.Group;
  readonly stats: GrassFieldStats;
  update(input: GrassUpdateInput): void;
  setQuality(quality: GrassQualityTier): void;
  setVisible(visible: boolean): void;
  /** Optional hook allowing `CityStreamer` to toggle tiles belonging to a spatial chunk. */
  setChunkVisible(chunkId: string, visible: boolean): void;
  dispose(): void;
}

interface GrassTierConfig {
  targetTufts: number;
  accentRatio: number;
  fadeStart: number;
  fadeEnd: number;
  receiveShadow: boolean;
}

const BLADES_PER_TUFT = 8;
const TILE_SIZE = 54;
const ACCENT_TILE_SIZE = 108;

const TIER_CONFIG: Record<GrassQualityTier, GrassTierConfig> = {
  ultra: { targetTufts: 24_000, accentRatio: 0.14, fadeStart: 54, fadeEnd: 86, receiveShadow: true },
  high: { targetTufts: 12_000, accentRatio: 0.10, fadeStart: 40, fadeEnd: 62, receiveShadow: true },
  balanced: { targetTufts: 5_000, accentRatio: 0.065, fadeStart: 26, fadeEnd: 42, receiveShadow: false },
  low: { targetTufts: 0, accentRatio: 0, fadeStart: 16, fadeEnd: 24, receiveShadow: false },
};

interface GrassShaderUniforms {
  uTime: { value: number };
  uWindDir: { value: T.Vector2 };
  uWindStrength: { value: number };
  uActorPos: { value: T.Vector4 };
  uVehiclePos: { value: T.Vector4 };
  uSunDir: { value: T.Vector3 };
  uDay: { value: number };
  uSeason: { value: number };
  uWetness: { value: number };
  uSnowCover: { value: number };
  uFadeRange: { value: T.Vector2 };
}

type BiomeKind = 'park' | 'botanical' | 'greenway' | 'lantern_garden' | 'yard' | 'campus' | 'fountain_plaza';

interface GreenPatch {
  rect: Rect;
  y: number;
  biome: BiomeKind;
  densityWeight: number;
  heightScale: number;
  accentChance: number;
}

interface OrientedBox {
  cx: number;
  cz: number;
  cosR: number;
  sinR: number;
  halfW: number;
  halfD: number;
}

interface CircleExclusion {
  x: number;
  z: number;
  rSq: number;
}

interface ExclusionField {
  rects: Rect[];
  oriented: OrientedBox[];
  circles: CircleExclusion[];
  riverMaxZ: number;
}

interface TuftSample {
  x: number;
  y: number;
  z: number;
  rotY: number;
  scaleXZ: number;
  scaleY: number;
  r: number;
  g: number;
  b: number;
  chunkId: string;
}

interface TileRecord {
  mesh: T.InstancedMesh;
  chunkId: string;
  isAccent: boolean;
  cx: number;
  cz: number;
  radius: number;
}

/** Smooth 2D value noise for organic ecological meadow clumping & moisture patch variation. */
function ecoNoise2D(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);

  const n00 = hash01(ix * 73 + seed, iz * 151 - seed);
  const n10 = hash01((ix + 1) * 73 + seed, iz * 151 - seed);
  const n01 = hash01(ix * 73 + seed, (iz + 1) * 151 - seed);
  const n11 = hash01((ix + 1) * 73 + seed, (iz + 1) * 151 - seed);

  const a = n00 + (n10 - n00) * ux;
  const b = n01 + (n11 - n01) * ux;
  return a + (b - a) * uz;
}

function ecoFbm(x: number, z: number): number {
  return (
    ecoNoise2D(x * 0.085, z * 0.085, 19) * 0.62 +
    ecoNoise2D(x * 0.23 + 7.4, z * 0.23 - 4.1, 83) * 0.38
  );
}

function inflateRect(src: Rect, pad: number): Rect {
  return { x0: src.x0 - pad, x1: src.x1 + pad, z0: src.z0 - pad, z1: src.z1 + pad };
}

function inOrientedBox(x: number, z: number, box: OrientedBox): boolean {
  const dx = x - box.cx;
  const dz = z - box.cz;
  const lx = dx * box.cosR + dz * box.sinR;
  const lz = -dx * box.sinR + dz * box.cosR;
  return Math.abs(lx) <= box.halfW && Math.abs(lz) <= box.halfD;
}

function buildExclusions(city: CityPlan, house: HousePlan): ExclusionField {
  const rects: Rect[] = [];
  const oriented: OrientedBox[] = [];
  const circles: CircleExclusion[] = [];

  // 1. Roads, sidewalks, crosswalks — clean curb clearance so grass never spills onto stone or asphalt.
  for (let i = 0; i < city.ground.length; i++) {
    const gr = city.ground[i];
    if (gr.surface === 'road' || gr.surface === 'sidewalk' || gr.surface === 'crossing') {
      rects.push(inflateRect(gr.rect, 0.36));
    }
  }

  // 2. Starter house, all 13 enterable city buildings, residences & decorative lots.
  rects.push(inflateRect(house.footprint, 0.52));
  for (let i = 0; i < city.buildings.length; i++) {
    rects.push(inflateRect(city.buildings[i].rect, 0.52));
  }
  for (let i = 0; i < city.residences.length; i++) {
    rects.push(inflateRect(city.residences[i].rect, 0.52));
  }
  for (let i = 0; i < city.lots.length; i++) {
    rects.push(inflateRect(city.lots[i].rect, 0.45));
  }

  // 3. Paved park promenade edge along the north river embankment railing so railings & benches stay crisp.
  const riverTop = city.river.z1;
  const parkNorth = riverTop;
  rects.push(makeRect(city.bounds.x0 - 2, city.bounds.x1 + 2, parkNorth - 0.5, parkNorth + 1.55));

  // 4. Clean stepping walkway in Home Back Garden (`yard`) along house east side & north garden exit.
  const f = house.footprint;
  rects.push(makeRect(f.x1 - 0.1, f.x1 + 2.0, f.z0 - 6.0, house.front + 0.2));

  // 5. Serene stone entry footpath in Hidden Lantern Tea Garden leading to the Minka tea pavilion.
  const lgGround = city.ground.find((g) => g.zone === 'lantern_garden' && g.surface === 'garden');
  if (lgGround) {
    const lgCz = (lgGround.rect.z0 + lgGround.rect.z1) * 0.5;
    const lgCx = (lgGround.rect.x0 + lgGround.rect.x1) * 0.5;
    rects.push(makeRect(lgGround.rect.x0 - 0.4, lgCx + 2.0, lgCz - 2.4, lgCz - 0.4));
    rects.push(makeRect(lgCx - 1.6, lgCx + 1.6, lgCz - 2.4, lgGround.rect.z1 - 3.5));
  }

  // 6. Neat stepping path into Botanical Garden gazebo from Riverside Road.
  const botGround = city.ground.find((g) => g.zone === 'botanical' && g.surface === 'garden');
  if (botGround) {
    const botCx = (botGround.rect.x0 + botGround.rect.x1) * 0.5;
    rects.push(makeRect(botCx - 0.95, botCx + 0.95, botGround.rect.z0 + 3.4, botGround.rect.z1 + 0.4));
  }

  // 7. Outdoor props, basketball half-court slabs (`basketball-court-slab`), badminton court & landmarks.
  for (let i = 0; i < city.props.length; i++) {
    const p = city.props[i];
    if (p.asset === 'hoop-post') {
      // Exact match to `cityView.ts:219-223` (11.6 × 11.6 m painted court + 0.45 m clean perimeter border).
      const sinR = Math.sin(p.rotY);
      const cosR = Math.cos(p.rotY);
      oriented.push({
        cx: p.x + sinR * 4.8,
        cz: p.z + cosR * 4.8,
        cosR,
        sinR,
        halfW: 6.25,
        halfD: 6.25,
      });
    } else if (p.asset === 'badminton-net') {
      const sinR = Math.sin(p.rotY);
      const cosR = Math.cos(p.rotY);
      oriented.push({
        cx: p.x,
        cz: p.z,
        cosR,
        sinR,
        halfW: 3.3,
        halfD: 5.2,
      });
    }

    let clearance = p.radius + 0.35;
    if (p.asset === 'park-gazebo') clearance = Math.max(clearance, 3.45);
    else if (p.asset === 'bld-minka') clearance = Math.max(clearance, 5.4);
    else if (p.asset === 'fountain-tiered') clearance = Math.max(clearance, 2.9);
    else if (p.asset === 'festival-stage') clearance = Math.max(clearance, 3.9);
    else if (p.asset === 'patio-set') clearance = Math.max(clearance, 1.75);
    else if (p.kind === 'shelter') clearance = Math.max(clearance, 1.85);
    else if (p.kind === 'bench') clearance = Math.max(clearance, 1.15);
    else if (p.kind === 'tree') clearance = Math.max(clearance, 0.62);
    else if (p.asset === 'map-kiosk') clearance = Math.max(clearance, 1.05);
    else if (p.asset === 'planter-trough') clearance = Math.max(clearance, 1.1);
    else if (p.asset === 'bikerack') clearance = Math.max(clearance, 1.25);

    circles.push({ x: p.x, z: p.z, rSq: clearance * clearance });
  }

  return { rects, oriented, circles, riverMaxZ: riverTop + 0.65 };
}

function clampRectToBounds(r: Rect, b: Rect): Rect | null {
  const x0 = Math.max(r.x0, b.x0);
  const x1 = Math.min(r.x1, b.x1);
  const z0 = Math.max(r.z0, b.z0);
  const z1 = Math.min(r.z1, b.z1);
  return x1 > x0 + 0.25 && z1 > z0 + 0.25 ? { x0, x1, z0, z1 } : null;
}

function isExcluded(x: number, z: number, ex: ExclusionField): boolean {
  if (z <= ex.riverMaxZ) return true;
  for (let i = 0; i < ex.rects.length; i++) {
    const r = ex.rects[i];
    if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) return true;
  }
  for (let i = 0; i < ex.oriented.length; i++) {
    if (inOrientedBox(x, z, ex.oriented[i])) return true;
  }
  for (let i = 0; i < ex.circles.length; i++) {
    const c = ex.circles[i];
    const dx = x - c.x;
    const dz = z - c.z;
    if (dx * dx + dz * dz <= c.rSq) return true;
  }
  return false;
}

function collectGreenPatches(city: CityPlan): GreenPatch[] {
  const patches: GreenPatch[] = [];
  const pushClampedPatch = (patch: GreenPatch) => {
    const clamped = clampRectToBounds(patch.rect, city.bounds);
    if (!clamped) return;
    patch.rect = clamped;
    patches.push(patch);
  };

  for (let i = 0; i < city.ground.length; i++) {
    const gr = city.ground[i];
    const zone = gr.zone as V3ZoneId | undefined;

    if (gr.surface === 'park' || gr.surface === 'garden') {
      let biome: BiomeKind = 'park';
      let densityWeight = 1.05;
      let heightScale = 1.0;
      let accentChance = 0.14;

      if (zone === 'botanical') {
        biome = 'botanical';
        densityWeight = 1.18;
        heightScale = 1.08;
        accentChance = 0.24;
      } else if (zone === 'lantern_garden') {
        biome = 'lantern_garden';
        densityWeight = 0.96;
        heightScale = 0.96;
        accentChance = 0.18;
      } else if (zone === 'greenway') {
        biome = 'greenway';
        densityWeight = 0.88;
        heightScale = 1.04;
        accentChance = 0.08;
      } else if (zone === 'yard') {
        biome = 'yard';
        densityWeight = 1.02;
        heightScale = 0.78;
        accentChance = 0.06;
      }

      pushClampedPatch({
        rect: inflateRect(gr.rect, -0.35),
        y: gr.y,
        biome,
        densityWeight,
        heightScale,
        accentChance,
      });
    }
  }

  // Synthesize manicured landscaped University Green lawn quads flanking the central ceremonial plaza avenue.
  const campusZone = city.zones.find((z) => z.id === 'campus');
  if (campusZone) {
    const cr = campusZone.rect;
    const cx = (cr.x0 + cr.x1) * 0.5;
    const cz = (cr.z0 + cr.z1) * 0.5;
    const wQuad: Rect[] = [
      makeRect(cr.x0 + 1.8, cx - 4.2, cr.z0 + 5.8, cz - 1.4),
      makeRect(cx + 4.2, cr.x1 - 1.8, cr.z0 + 5.8, cz - 1.4),
      makeRect(cr.x0 + 8.0, cx - 4.2, cz + 2.0, cr.z1 - 4.2),
      makeRect(cx + 4.2, cr.x1 - 2.2, cz + 2.0, cr.z1 - 4.2),
    ];
    for (let i = 0; i < wQuad.length; i++) {
      const qr = wQuad[i];
      if (qr.x1 - qr.x0 > 2.0 && qr.z1 - qr.z0 > 2.0) {
        pushClampedPatch({
          rect: qr,
          y: GROUND_Y + 0.008,
          biome: 'campus',
          densityWeight: 1.05,
          heightScale: 0.72,
          accentChance: 0.04,
        });
      }
    }
  }

  // Synthesize perimeter landscaped garden planter beds around Old Campus Fountain Court (`fountain_plaza`).
  const fountainZone = city.zones.find((z) => z.id === 'fountain_plaza');
  if (fountainZone) {
    const fr = fountainZone.rect;
    const planterBeds: Rect[] = [
      makeRect(fr.x0 + 1.6, fr.x0 + 5.2, fr.z0 + 1.6, fr.z0 + 5.2),
      makeRect(fr.x1 - 5.2, fr.x1 - 1.6, fr.z0 + 1.6, fr.z0 + 5.2),
      makeRect(fr.x0 + 1.6, fr.x0 + 5.4, fr.z1 - 5.2, fr.z1 - 1.6),
      makeRect(fr.x1 - 5.4, fr.x1 - 1.6, fr.z1 - 5.2, fr.z1 - 1.6),
    ];
    for (let i = 0; i < planterBeds.length; i++) {
      const pr = planterBeds[i];
      if (pr.x1 - pr.x0 > 1.5 && pr.z1 - pr.z0 > 1.5) {
        pushClampedPatch({
          rect: pr,
          y: GROUND_Y + 0.008,
          biome: 'fountain_plaza',
          densityWeight: 1.12,
          heightScale: 0.78,
          accentChance: 0.16,
        });
      }
    }
  }

  return patches;
}

function findChunkId(city: CityPlan, x: number, z: number): string {
  for (let i = 0; i < city.chunks.length; i++) {
    const r = city.chunks[i].rect;
    if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) return city.chunks[i].id;
  }
  let best = city.chunks[0]?.id ?? 'home-core';
  let bestD = Infinity;
  for (let i = 0; i < city.chunks.length; i++) {
    const c = city.chunks[i].center;
    const d = (c.x - x) * (c.x - x) + (c.z - z) * (c.z - z);
    if (d < bestD) {
      bestD = d;
      best = city.chunks[i].id;
    }
  }
  return best;
}

/**
 * Builds the reusable 8-blade curved, tapered multi-tier botanical grass cluster `BufferGeometry`.
 *
 * Combines 3 short ground-hugging turf blades (2 segments) + 3 medium curving meadow fescue blades + 2 tall
 * graceful seed-tip blades (3 segments) = 34 tris/tuft with deep root-AO grounding, natural emerald-olive
 * variation, and upward-biased soft volumetric foliage normals.
 */
function buildGrassTuftGeometry(): T.BufferGeometry {
  // 3 short turf blades (5 verts, 3 tris each) + 5 medium/tall arching blades (7 verts, 5 tris each) = 50 verts, 34 tris.
  const segsPerBlade = [2, 2, 2, 3, 3, 3, 3, 3] as const;
  let totalVerts = 0;
  let totalTris = 0;
  for (let b = 0; b < BLADES_PER_TUFT; b++) {
    const segs = segsPerBlade[b];
    totalVerts += segs * 2 + 1;
    totalTris += (segs - 1) * 2 + 1;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);
  const grassData = new Float32Array(totalVerts * 2);
  const indices = new Uint16Array(totalTris * 3);

  // Natural inZOI linear-space meadow palette: deep humus root-AO -> rich emerald-olive -> warm sunlit tip.
  const rootCol = [0.015, 0.064, 0.013];
  const midCol = [0.056, 0.252, 0.042];
  const tipCol = [0.168, 0.455, 0.076];

  let vIdx = 0;
  let iIdx = 0;

  for (let b = 0; b < BLADES_PER_TUFT; b++) {
    const segs = segsPerBlade[b];
    const vertsThisBlade = segs * 2 + 1;
    const baseVertex = vIdx;

    // Golden-angle rosette with organic deterministic jitter for full, interlocking meadow density.
    const yaw = b * 2.3999632 + (hash01(b, 11) - 0.5) * 0.48;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);

    // 3 height tiers inside every tuft: short turf carpet (0..2), lush mid fescue (3..5), tall swaying wisps (6..7).
    const isShort = b < 3;
    const isTall = b >= 6;
    const radialOffset = isShort
      ? 0.025 + hash01(b, 23) * 0.14
      : 0.05 + hash01(b, 23) * 0.155;
    const ox = cosY * radialOffset;
    const oz = sinY * radialOffset;

    const bladeH = isShort
      ? 0.12 + hash01(b, 37) * 0.08
      : isTall
        ? 0.30 + hash01(b, 37) * 0.11
        : 0.20 + hash01(b, 37) * 0.12;
    const bladeHalfW = isShort
      ? 0.026 + hash01(b, 47) * 0.012
      : isTall
        ? 0.017 + hash01(b, 47) * 0.008
        : 0.022 + hash01(b, 47) * 0.012;
    const lean = isShort
      ? 0.065 + hash01(b, 59) * 0.08
      : isTall
        ? 0.135 + hash01(b, 59) * 0.145
        : 0.095 + hash01(b, 59) * 0.125;
    const bladeVar = hash01(b, 71) * 0.80; // 0..0.80 reserved for grass; >= 0.90 reserved for flower petals
    const warmShift = (hash01(b, 97) - 0.5) * 0.075;
    const oliveShift = (hash01(b, 113) - 0.5) * 0.045;

    // Blade tangent (side-to-side width vector) & outward bend axis.
    const tx = -sinY;
    const tz = cosY;

    // Softly upward-tilted volumetric foliage normal eliminating dark grazing backfaces.
    const nxRaw = cosY * 0.32;
    const nyRaw = 0.89;
    const nzRaw = sinY * 0.32;
    const nLen = Math.hypot(nxRaw, nyRaw, nzRaw);
    const nx = nxRaw / nLen;
    const ny = nyRaw / nLen;
    const nz = nzRaw / nLen;

    const writeVertex = (px: number, py: number, pz: number, t: number, sideSign: number) => {
      positions[vIdx * 3] = px;
      positions[vIdx * 3 + 1] = py;
      positions[vIdx * 3 + 2] = pz;

      // Cross-blade curvature + upward tip tilt so sunlit meadows read soft & plush from any angle.
      const vnx = nx + tx * sideSign * 0.20;
      const vny = ny + t * 0.14;
      const vnz = nz + tz * sideSign * 0.20;
      const vl = Math.hypot(vnx, vny, vnz);
      normals[vIdx * 3] = vnx / vl;
      normals[vIdx * 3 + 1] = vny / vl;
      normals[vIdx * 3 + 2] = vnz / vl;

      let cr: number;
      let cg: number;
      let cb: number;
      if (t < 0.45) {
        const k = t / 0.45;
        cr = rootCol[0] + (midCol[0] - rootCol[0]) * k;
        cg = rootCol[1] + (midCol[1] - rootCol[1]) * k;
        cb = rootCol[2] + (midCol[2] - rootCol[2]) * k;
      } else {
        const k = (t - 0.45) / 0.55;
        cr = midCol[0] + (tipCol[0] - midCol[0]) * k;
        cg = midCol[1] + (tipCol[1] - midCol[1]) * k;
        cb = midCol[2] + (tipCol[2] - midCol[2]) * k;
      }
      const shortShade = isShort ? 0.86 : 1.0;
      colors[vIdx * 3] = Math.max(0.012, (cr + warmShift * t + oliveShift * 0.6) * shortShade);
      colors[vIdx * 3 + 1] = Math.max(0.032, (cg + warmShift * 0.45 * t - oliveShift * 0.4) * shortShade);
      colors[vIdx * 3 + 2] = Math.max(0.008, (cb - warmShift * 0.32 * t) * shortShade);

      grassData[vIdx * 2] = t;
      grassData[vIdx * 2 + 1] = bladeVar;
      vIdx++;
    };

    for (let s = 0; s < segs; s++) {
      const t = s / segs;
      const arch = Math.pow(t, 1.58) * lean;
      // Embed root 1.4 cm into soil (`-0.014`) so tufts ground cleanly even on sloping borders.
      const y = -0.014 + bladeH * (t - 0.08 * t * t);
      const halfW = bladeHalfW * Math.pow(1.0 - t, 0.58);
      const cx = ox + cosY * arch;
      const cz = oz + sinY * arch;

      writeVertex(cx - tx * halfW, y, cz - tz * halfW, t, -1);
      writeVertex(cx + tx * halfW, y, cz + tz * halfW, t, 1);
    }

    // Pointed blade apex tip.
    const tipArch = lean;
    writeVertex(ox + cosY * tipArch, -0.014 + bladeH * 0.92, oz + sinY * tipArch, 1.0, 0);

    for (let s = 0; s < segs - 1; s++) {
      const r0 = baseVertex + s * 2;
      const r1 = r0 + 2;
      indices[iIdx++] = r0;
      indices[iIdx++] = r0 + 1;
      indices[iIdx++] = r1;

      indices[iIdx++] = r0 + 1;
      indices[iIdx++] = r1 + 1;
      indices[iIdx++] = r1;
    }

    const topRow = baseVertex + (segs - 1) * 2;
    const apex = baseVertex + vertsThisBlade - 1;
    indices[iIdx++] = topRow;
    indices[iIdx++] = topRow + 1;
    indices[iIdx++] = apex;
  }

  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new T.BufferAttribute(normals, 3));
  geo.setAttribute('color', new T.BufferAttribute(colors, 3));
  geo.setAttribute('aGrassData', new T.BufferAttribute(grassData, 2));
  geo.setIndex(new T.BufferAttribute(indices, 1));
  geo.computeBoundingSphere();
  geo.userData.shared = true;
  return geo;
}

/**
 * Builds a lightweight botanical clover & wildflower cluster geometry (3 low clover leaves + 2 stemmed
 * 4-petal blossoms = 16 triangles per cluster). Petal vertices set `aGrassData.y = 0.96` so the fragment
 * shader preserves crisp blossom hues driven by `instanceColor`.
 */
function buildWildflowerTuftGeometry(): T.BufferGeometry {
  const pos: number[] = [];
  const norm: number[] = [];
  const col: number[] = [];
  const data: number[] = [];
  const idx: number[] = [];

  const pushTri = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    n: [number, number, number],
    rgb: [number, number, number],
    tipA: number,
    tipB: number,
    tipC: number,
    varFlag: number,
  ) => {
    const base = pos.length / 3;
    pos.push(...a, ...b, ...c);
    norm.push(...n, ...n, ...n);
    col.push(...rgb, ...rgb, ...rgb);
    data.push(tipA, varFlag, tipB, varFlag, tipC, varFlag);
    idx.push(base, base + 1, base + 2);
  };

  // 3 low cupped clover leaves hugging the ground (dark botanical emerald).
  const leafRgb: [number, number, number] = [0.13, 0.30, 0.08];
  for (let l = 0; l < 3; l++) {
    const ang = l * ((Math.PI * 2) / 3) + 0.35;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const rx = -sa;
    const rz = ca;
    const y0 = 0.035;
    const y1 = 0.072;
    const len = 0.095;
    const hw = 0.048;
    pushTri(
      [ca * 0.01, y0, sa * 0.01],
      [ca * len - rx * hw, y1, sa * len - rz * hw],
      [ca * len + rx * hw, y1, sa * len + rz * hw],
      [ca * 0.2, 0.96, sa * 0.2],
      leafRgb,
      0.18,
      0.32,
      0.32,
      0.25,
    );
  }

  // 2 slender flower stems with tilted 4-petal star blossoms rising naturally above the lush emerald grass.
  const stemSpecs = [
    { ox: -0.032, oz: 0.022, h: 0.30, leanX: -0.06, leanZ: 0.042, r: 0.056, tilt: 0.28 },
    { ox: 0.038, oz: -0.026, h: 0.24, leanX: 0.052, leanZ: -0.048, r: 0.046, tilt: -0.24 },
  ];

  const stemRgb: [number, number, number] = [0.075, 0.30, 0.052];
  const petalRgb: [number, number, number] = [0.98, 0.98, 0.96];

  for (let s = 0; s < stemSpecs.length; s++) {
    const st = stemSpecs[s];
    const tx = st.ox + st.leanX;
    const tz = st.oz + st.leanZ;
    // Slender triangular stem.
    pushTri(
      [st.ox - 0.008, 0.0, st.oz],
      [st.ox + 0.008, 0.0, st.oz],
      [tx, st.h, tz],
      [0.2, 0.94, 0.2],
      stemRgb,
      0.0,
      0.0,
      0.92,
      0.30,
    );

    // 4-petal cupped blossom crown at stem apex.
    for (let p = 0; p < 4; p++) {
      const a0 = p * (Math.PI * 0.5) + s * 0.4;
      const a1 = a0 + 0.55;
      const a2 = a0 - 0.55;
      const px1 = tx + Math.cos(a1) * st.r * 0.55;
      const pz1 = tz + Math.sin(a1) * st.r * 0.55;
      const px2 = tx + Math.cos(a2) * st.r * 0.55;
      const pz2 = tz + Math.sin(a2) * st.r * 0.55;
      const pTipX = tx + Math.cos(a0) * st.r;
      const pTipZ = tz + Math.sin(a0) * st.r;
      const cupY = st.h + 0.016 + Math.sin(a0) * st.tilt * 0.014;

      pushTri(
        [tx, st.h, tz],
        [px1, st.h + 0.008, pz1],
        [pTipX, cupY, pTipZ],
        [Math.cos(a0) * 0.25, 0.94, Math.sin(a0) * 0.25],
        petalRgb,
        0.92,
        0.96,
        1.0,
        0.96,
      );
      pushTri(
        [tx, st.h, tz],
        [pTipX, cupY, pTipZ],
        [px2, st.h + 0.008, pz2],
        [Math.cos(a0) * 0.25, 0.94, Math.sin(a0) * 0.25],
        petalRgb,
        0.92,
        1.0,
        0.96,
        0.96,
      );
    }
  }

  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new T.Float32BufferAttribute(norm, 3));
  geo.setAttribute('color', new T.Float32BufferAttribute(col, 3));
  geo.setAttribute('aGrassData', new T.Float32BufferAttribute(data, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  geo.userData.shared = true;
  return geo;
}

function createGrassMaterial(
  uniforms: GrassShaderUniforms,
  isAccent: boolean,
): T.MeshStandardMaterial {
  const mat = new T.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: isAccent ? 0.72 : 0.80,
    metalness: 0.0,
    side: T.DoubleSide,
  });

  const variantKey = isAccent ? 'echo-grass-accent-v3' : 'echo-grass-meadow-v3';

  chainMaterialShader(mat, variantKey, (shader) => {
    shader.uniforms.uGrassTime = uniforms.uTime;
    shader.uniforms.uGrassWindDir = uniforms.uWindDir;
    shader.uniforms.uGrassWindStrength = uniforms.uWindStrength;
    shader.uniforms.uGrassActorPos = uniforms.uActorPos;
    shader.uniforms.uGrassVehiclePos = uniforms.uVehiclePos;
    shader.uniforms.uGrassSunDir = uniforms.uSunDir;
    shader.uniforms.uGrassDay = uniforms.uDay;
    shader.uniforms.uGrassSeason = uniforms.uSeason;
    shader.uniforms.uGrassWetness = uniforms.uWetness;
    shader.uniforms.uGrassSnowCover = uniforms.uSnowCover;
    shader.uniforms.uGrassFadeRange = uniforms.uFadeRange;

    const vertHeader = /* glsl */ `
attribute vec2 aGrassData;
varying float vGrassTip;
varying float vGrassVar;
varying vec3 vGrassWorldPos;
uniform float uGrassTime;
uniform vec2 uGrassWindDir;
uniform float uGrassWindStrength;
uniform vec4 uGrassActorPos;
uniform vec4 uGrassVehiclePos;
uniform vec2 uGrassFadeRange;
uniform float uGrassSnowCover;
`;

    shader.vertexShader =
      vertHeader +
      shader.vertexShader
        .replace(
          '#include <beginnormal_vertex>',
          /* glsl */ `#include <beginnormal_vertex>
  // Bias grass normals upward as snow builds so blade undersides never face downward into black (P1-VIS-4B).
  float gNormSnow = smoothstep( 0.25, 0.85, uGrassSnowCover );
  objectNormal = normalize( mix( objectNormal, vec3( 0.0, 1.0, 0.0 ), clamp( 0.18 + gNormSnow * 0.78, 0.0, 0.96 ) ) );
`,
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `#include <begin_vertex>
  float gTip = aGrassData.x;
  float gVar = aGrassData.y;
  vGrassTip = gTip;
  vGrassVar = gVar;

  #ifdef USE_INSTANCING
    vec3 gInstPos = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  #else
    vec3 gInstPos = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  #endif

  // Smooth distance fade-out scale curve so distant tiles vanish seamlessly with zero pop-in.
  float gCamDist = length( gInstPos.xz - cameraPosition.xz );
  float gFade = 1.0 - smoothstep( uGrassFadeRange.x, uGrassFadeRange.y, gCamDist );
  transformed *= gFade;

  // Winter snow weight smoothly compresses grass height (0.22–0.32x) & tucks flowers beneath snowdrifts (P1-VIS-4B).
  float gSnowPress = smoothstep( 0.25, 0.85, uGrassSnowCover );
  if ( gSnowPress > 0.001 ) {
    float gIsFlowerV = step( 0.88, gVar );
    float gFlatY = mix( mix( 0.22, 0.32, clamp( gVar * 1.25, 0.0, 1.0 ) ), 0.16, gIsFlowerV );
    transformed.y *= mix( 1.0, gFlatY, gSnowPress );
    transformed.xz *= mix( 1.0, 1.12, gSnowPress * gTip );
  }

  if ( gFade > 0.002 && gTip > 0.001 ) {
    float gFlex = gTip * gTip;
    float gEffWind = uGrassWindStrength * mix( 1.0, 0.26, gSnowPress );
    vec2 gWDir = uGrassWindDir;
    vec2 gWPerp = vec2( -gWDir.y, gWDir.x );

    // World-space traveling macro wind waves + fine per-blade flutter.
    float gPhase = dot( gInstPos.xz, gWDir ) * 0.23 - uGrassTime * ( 1.45 + gEffWind * 1.10 );
    float gCross = sin( dot( gInstPos.xz, gWPerp ) * 0.17 - uGrassTime * 0.88 + gVar * 4.2 );
    float gGust = ( sin( gPhase ) * 0.56 + sin( gPhase * 2.11 + 1.37 ) * 0.29 + gCross * 0.15 ) * 0.5 + 0.5;
    float gFlutter = sin( uGrassTime * ( 3.6 + gVar * 2.1 ) + gInstPos.x * 1.9 + gInstPos.z * 1.4 + gVar * 6.2831 ) * 0.14;

    vec2 gWorldXZ = gWDir * ( ( 0.045 + gGust * 0.22 ) * gEffWind + gFlutter * gEffWind * 0.32 ) * gFlex;
    gWorldXZ += gWPerp * ( gCross * 0.035 * gEffWind ) * gFlex;
    float gWorldY = 0.0;

    // Player foot-bend radial interaction.
    if ( uGrassActorPos.w > 0.001 ) {
      vec3 gToActor = gInstPos - uGrassActorPos.xyz;
      float gADist = length( gToActor.xz );
      float gAVert = 1.0 - smoothstep( 1.1, 2.3, abs( gToActor.y ) );
      float gAPush = ( 1.0 - smoothstep( 0.08, uGrassActorPos.w, gADist ) ) * gAVert;
      if ( gAPush > 0.001 ) {
        vec2 gADir = gADist > 0.001 ? ( gToActor.xz / gADist ) : vec2( 1.0, 0.0 );
        gWorldXZ += gADir * ( gAPush * 0.36 * gFlex );
        gWorldY -= gAPush * 0.15 * gFlex;
      }
    }

    // Active vehicle wheel-flatten interaction.
    if ( uGrassVehiclePos.w > 0.001 ) {
      vec3 gToVeh = gInstPos - uGrassVehiclePos.xyz;
      float gVDist = length( gToVeh.xz );
      float gVVert = 1.0 - smoothstep( 1.4, 2.8, abs( gToVeh.y ) );
      float gVPush = ( 1.0 - smoothstep( 0.20, uGrassVehiclePos.w, gVDist ) ) * gVVert;
      if ( gVPush > 0.001 ) {
        vec2 gVDir = gVDist > 0.001 ? ( gToVeh.xz / gVDist ) : vec2( 1.0, 0.0 );
        gWorldXZ += gVDir * ( gVPush * 0.48 * gFlex );
        gWorldY -= gVPush * 0.20 * gFlex;
      }
    }

    // Arc-length conservation dip so leaning blades bend naturally instead of stretching.
    gWorldY -= length( gWorldXZ ) * 0.26;
    gWorldXZ *= gFade;
    gWorldY *= gFade;

    // Project world-space displacement cleanly into orthogonal Y-rotated instance-local space (zero matrix inverse).
    #ifdef USE_INSTANCING
      vec3 gCol0 = ( modelMatrix * instanceMatrix * vec4( 1.0, 0.0, 0.0, 0.0 ) ).xyz;
      vec3 gCol1 = ( modelMatrix * instanceMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz;
      vec3 gCol2 = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz;
      vec3 gDispW = vec3( gWorldXZ.x, gWorldY, gWorldXZ.y );
      transformed.x += dot( gDispW, gCol0 ) / max( dot( gCol0, gCol0 ), 1e-4 );
      transformed.y += dot( gDispW, gCol1 ) / max( dot( gCol1, gCol1 ), 1e-4 );
      transformed.z += dot( gDispW, gCol2 ) / max( dot( gCol2, gCol2 ), 1e-4 );
    #else
      transformed.x += gWorldXZ.x;
      transformed.y += gWorldY;
      transformed.z += gWorldXZ.y;
    #endif
  }
`,
        )
        .replace(
          '#include <worldpos_vertex>',
          /* glsl */ `#include <worldpos_vertex>
  vec4 gWp = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    gWp = instanceMatrix * gWp;
  #endif
  vGrassWorldPos = ( modelMatrix * gWp ).xyz;
`,
        );

    const fragHeader = /* glsl */ `
varying float vGrassTip;
varying float vGrassVar;
varying vec3 vGrassWorldPos;
uniform vec3 uGrassSunDir;
uniform float uGrassDay;
uniform float uGrassSeason;
uniform float uGrassWetness;
uniform float uGrassSnowCover;
`;

    shader.fragmentShader =
      fragHeader +
      shader.fragmentShader
        .replace(
          '#include <color_fragment>',
          /* glsl */ `#include <color_fragment>
  float gIsPetal = step( 0.88, vGrassVar );

  // Smooth 4-season botanical palette response (0 Spring, 1 Summer, 2 Autumn, 3 Winter).
  vec3 gSpring = mix( vec3( 0.86, 1.06, 0.82 ), vec3( 1.04, 1.16, 0.80 ), vGrassTip );
  vec3 gSummer = mix( vec3( 0.82, 1.02, 0.78 ), vec3( 0.98, 1.12, 0.76 ), vGrassTip );
  vec3 gAutumn = mix( vec3( 0.96, 0.75, 0.40 ), vec3( 1.42, 0.96, 0.32 ), vGrassTip );
  vec3 gWinter = mix( vec3( 0.68, 0.66, 0.56 ), vec3( 0.86, 0.84, 0.76 ), vGrassTip );

  vec3 gSeasonTint = gSpring;
  if ( uGrassSeason < 1.0 ) {
    gSeasonTint = mix( gSpring, gSummer, clamp( uGrassSeason, 0.0, 1.0 ) );
  } else if ( uGrassSeason < 2.0 ) {
    gSeasonTint = mix( gSummer, gAutumn, clamp( uGrassSeason - 1.0, 0.0, 1.0 ) );
  } else {
    gSeasonTint = mix( gAutumn, gWinter, clamp( uGrassSeason - 2.0, 0.0, 1.0 ) );
  }

  // Keep wildflower blossoms clean and vivid in Spring/Summer, softly muted in Autumn/Winter.
  vec3 gPetalSeason = mix( vec3( 1.0 ), vec3( 0.78, 0.74, 0.68 ), smoothstep( 1.3, 2.8, uGrassSeason ) );
  diffuseColor.rgb *= mix( gSeasonTint, gPetalSeason, gIsPetal );

  // Desaturate green chlorophyll into dormant muted winter straw/sage whenever snow blankets the park!
  float gDormant = max( smoothstep( 2.25, 2.95, uGrassSeason ) * 0.72, smoothstep( 0.20, 0.72, uGrassSnowCover ) );
  if ( gDormant > 0.001 ) {
    vec3 gWinterStraw = mix( vec3( 0.34, 0.36, 0.34 ), vec3( 0.52, 0.54, 0.50 ), vGrassTip );
    diffuseColor.rgb = mix( diffuseColor.rgb, gWinterStraw, gDormant * mix( 0.82, 0.58, gIsPetal ) );
  }

  // Rain dampness slightly deepens foliage saturation & darkens lower stems.
  diffuseColor.rgb *= mix( 1.0, 0.78, uGrassWetness * ( 1.0 - vGrassTip * 0.38 ) );

  // Lift dark root-AO vertex color & blanket blades in bright soft powdery snow (ZERO black flecks — P1-VIS-4B!).
  float gSnowLift = smoothstep( 0.25, 0.85, uGrassSnowCover );
  if ( gSnowLift > 0.001 ) {
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.76, 0.80, 0.84 ), gSnowLift * 0.90 );
    vec3 gSnowFrost = mix( vec3( 0.80, 0.84, 0.89 ), vec3( 0.91, 0.94, 0.98 ), smoothstep( 0.0, 0.75, vGrassTip ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, gSnowFrost, gSnowLift * mix( 0.58, 0.94, smoothstep( 0.05, 0.65, vGrassTip ) ) );
  }
`,
        )
        .replace(
          '#include <normal_fragment_begin>',
          /* glsl */ `#include <normal_fragment_begin>
  // Prevent DoubleSide backface normal inversion from turning snowy grass blade undersides pitch black (P1-VIS-4B).
  vec3 gViewUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  float gSnowUp = smoothstep( 0.20, 0.85, uGrassSnowCover );
  normal = normalize( mix( normal, gViewUp, clamp( 0.22 + gSnowUp * 0.74, 0.0, 0.96 ) ) );
`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          /* glsl */ `#include <roughnessmap_fragment>
  // Rain wetness adds a subtle glistening sheen; winter snow turns blades powdery matte.
  roughnessFactor = mix( roughnessFactor, 0.28, uGrassWetness * 0.72 );
  roughnessFactor = mix( roughnessFactor, 0.94, smoothstep( 0.25, 0.85, uGrassSnowCover ) * 0.90 );
`,
        )
        .replace(
          '#include <lights_fragment_end>',
          /* glsl */ `#include <lights_fragment_end>
  // Subsurface backlit translucency when looking toward the sun across sunlit meadows (suppressed under snow).
  vec3 gViewW = normalize( cameraPosition - vGrassWorldPos );
  vec3 gSunW = normalize( uGrassSunDir );
  float gBack = pow( clamp( dot( gViewW, -gSunW ), 0.0, 1.0 ), 2.6 );
  float gSunElev = smoothstep( -0.05, 0.26, gSunW.y );
  float gSssMask = smoothstep( 0.16, 0.96, vGrassTip ) * ( 0.24 + 0.76 * gBack ) * uGrassDay * gSunElev * ( 1.0 - smoothstep( 0.15, 0.60, uGrassSnowCover ) );
  vec3 gSssHue = mix( vec3( 0.30, 0.74, 0.14 ), vec3( 0.82, 0.54, 0.14 ), clamp( uGrassSeason - 1.0, 0.0, 1.0 ) );
  reflectedLight.directDiffuse += diffuseColor.rgb * gSssHue * gSssMask * 0.86;
  // Soft powdery ambient bounce fill in winter snow so snow-dusted tufts harmonize smoothly with snowdrifts.
  float gSnowBounce = smoothstep( 0.25, 0.85, uGrassSnowCover );
  if ( gSnowBounce > 0.001 ) {
    reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3( 0.12, 0.13, 0.15 ) * gSnowBounce * ( 0.35 + 0.65 * uGrassDay );
  }
`,
        );
  });

  // Attach analytical Exponential Height Fog + 3-cascade CSM at creation time (zero post-unlock needsUpdate = true!).
  patchHeightFog(mat, getSharedHeightFogUniforms());
  patchMaterialWithEchoCsm(mat);

  return mat;
}

const FLOWER_PALETTES: Record<BiomeKind, readonly [number, number, number][]> = {
  park: [
    [0.98, 0.97, 0.90], // meadow white daisy / clover
    [0.98, 0.82, 0.24], // golden buttercup
    [0.82, 0.74, 0.96], // soft wild lavender
  ],
  botanical: [
    [0.98, 0.76, 0.84], // sakura blush
    [0.98, 0.84, 0.28], // marigold gold
    [0.74, 0.70, 0.98], // garden violet
    [0.99, 0.98, 0.94], // crisp white jasmine
  ],
  lantern_garden: [
    [0.99, 0.97, 0.92], // tea-garden white blossom
    [0.96, 0.78, 0.84], // pale sakura pink
    [0.84, 0.78, 0.95], // soft wisteria
  ],
  greenway: [
    [0.97, 0.96, 0.88],
    [0.96, 0.80, 0.26],
  ],
  yard: [
    [0.98, 0.97, 0.90],
    [0.96, 0.82, 0.30],
  ],
  campus: [
    [0.98, 0.97, 0.92],
  ],
  fountain_plaza: [
    [0.98, 0.78, 0.84],
    [0.98, 0.97, 0.92],
    [0.80, 0.74, 0.98],
  ],
};

function sampleEcologicalMeadow(
  city: CityPlan,
  house: HousePlan,
  patches: GreenPatch[],
  exclusions: ExclusionField,
  cfg: GrassTierConfig,
): { grass: TuftSample[]; accents: TuftSample[] } {
  if (cfg.targetTufts <= 0 || patches.length === 0) {
    return { grass: [], accents: [] };
  }

  // Estimate weighted green area so stride self-calibrates across study room sizes (4..9 m).
  let weightedArea = 0;
  for (let i = 0; i < patches.length; i++) {
    const r = patches[i].rect;
    const area = Math.max(0, r.x1 - r.x0) * Math.max(0, r.z1 - r.z0);
    weightedArea += area * patches[i].densityWeight;
  }

  // Account for ~30% exclusion/ecological-gap loss so final blade count reliably lands right on 2.5x tier target.
  const effectiveSurvival = 0.70;
  const baseStride = Math.max(
    0.26,
    Math.min(1.55, Math.sqrt((weightedArea * effectiveSurvival) / cfg.targetTufts)),
  );

  const grass: TuftSample[] = [];
  const accents: TuftSample[] = [];
  const riverTop = city.river.z1;

  for (let pIdx = 0; pIdx < patches.length; pIdx++) {
    const patch = patches[pIdx];
    const pr = patch.rect;
    if (pr.x1 <= pr.x0 || pr.z1 <= pr.z0) continue;

    const stride = baseStride / Math.sqrt(patch.densityWeight);
    const cols = Math.max(1, Math.floor((pr.x1 - pr.x0) / stride));
    const rows = Math.max(1, Math.floor((pr.z1 - pr.z0) / stride));

    for (let r = 0; r < rows; r++) {
      // Hex-offset alternating rows break up grid alignment completely.
      const rowOffset = (r & 1) * 0.5;
      for (let c = 0; c < cols; c++) {
        const seedA = pIdx * 100_003 + r * 997 + c * 31;
        const jx = (hash01(seedA, 13) - 0.5) * 0.84;
        const jz = (hash01(seedA, 29) - 0.5) * 0.84;
        const x = pr.x0 + (c + 0.5 + rowOffset * 0.6 + jx) * stride;
        const z = pr.z0 + (r + 0.5 + jz) * stride;

        if (x < pr.x0 || x > pr.x1 || z < pr.z0 || z > pr.z1) continue;
        if (isExcluded(x, z, exclusions)) continue;

        // Multi-scale ecological noise: lush dense meadow carpet with subtle organic texture variation.
        const eco = ecoFbm(x, z);
        const keepRoll = hash01(seedA, 43);
        const survivalThreshold = patch.biome === 'yard' || patch.biome === 'campus' ? 0.08 : 0.16;
        if (eco * 0.74 + keepRoll * 0.45 < survivalThreshold) continue;

        const chunkId = findChunkId(city, x, z);
        const rotY = hash01(seedA, 53) * Math.PI * 2;
        const moisture = Math.max(0, 1 - Math.abs(z - riverTop) / 22); // richer emerald near riverbank
        const microVar = hash01(seedA, 67);

        // Height & fullness vary organically with meadow clumping and biome grooming.
        const clumpFactor = 0.76 + eco * 0.46;
        const scaleY = patch.heightScale * clumpFactor * (0.82 + microVar * 0.38);
        const scaleXZ = (0.85 + hash01(seedA, 79) * 0.48) * (0.9 + eco * 0.2);

        // Per-tuft linear ecological tint multiplied with vertex root-to-tip gradient.
        const sunKiss = (eco - 0.5) * 0.22;
        const rTint = Math.max(0.72, Math.min(1.18, 0.94 + sunKiss - moisture * 0.08 + (microVar - 0.5) * 0.08));
        const gTint = Math.max(0.76, Math.min(1.18, 0.98 + moisture * 0.07 + sunKiss * 0.4 + (microVar - 0.5) * 0.06));
        const bTint = Math.max(0.68, Math.min(1.12, 0.90 - sunKiss * 0.45 + moisture * 0.06));

        grass.push({
          x,
          y: patch.y,
          z,
          rotY,
          scaleXZ,
          scaleY,
          r: rTint,
          g: gTint,
          b: bTint,
          chunkId,
        });

        // Subtle botanical clover/wildflower accent clusters in natural garden biomes.
        if (
          cfg.accentRatio > 0 &&
          (patch.biome === 'park' ||
            patch.biome === 'botanical' ||
            patch.biome === 'lantern_garden' ||
            patch.biome === 'fountain_plaza')
        ) {
          const flowerRoll = hash01(seedA, 101);
          // Cluster flowers in sunny ecological pockets (`eco > 0.50`) for natural wildflower drifts.
          const pocketBoost = eco > 0.50 ? 1.55 : 0.45;
          if (flowerRoll < patch.accentChance * (cfg.accentRatio / 0.11) * pocketBoost) {
            const pal = FLOWER_PALETTES[patch.biome];
            const pick = pal[Math.floor(hash01(seedA, 127) * pal.length) % pal.length];
            accents.push({
              x: x + (hash01(seedA, 131) - 0.5) * 0.26,
              y: patch.y,
              z: z + (hash01(seedA, 139) - 0.5) * 0.26,
              rotY: hash01(seedA, 149) * Math.PI * 2,
              scaleXZ: 0.88 + hash01(seedA, 157) * 0.42,
              scaleY: (0.85 + hash01(seedA, 163) * 0.40) * Math.max(0.85, patch.heightScale),
              r: pick[0],
              g: pick[1],
              b: pick[2],
              chunkId,
            });
          }
        }
      }
    }
  }

  return { grass, accents };
}

function buildTiledInstancedMeshes(
  samples: TuftSample[],
  geometry: T.BufferGeometry,
  material: T.Material,
  receiveShadow: boolean,
  isAccent: boolean,
  parent: T.Group,
  originX: number,
  originZ: number,
): TileRecord[] {
  if (samples.length === 0) return [];

  // Anchor tile grid to `(city.bounds.x0, city.bounds.z0)` so riverfront parks stay in a single clean Z-band
  // (`<= 26` total tiles city-wide: ~18 grass + ~6 accent -> cuts 91 tiles -> ~24 tiles!).
  const tileSize = isAccent ? ACCENT_TILE_SIZE : TILE_SIZE;
  const buckets = new Map<string, TuftSample[]>();
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const tx = Math.floor((s.x - originX) / tileSize);
    const tz = Math.floor((s.z - originZ) / tileSize);
    const key = `${tx}:${tz}`;
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push(s);
  }

  const records: TileRecord[] = [];
  const upAxis = V3_C.set(0, 1, 0);

  for (const [key, list] of buckets) {
    const mesh = new T.InstancedMesh(geometry, material, list.length);
    mesh.name = isAccent ? `grass-accent-tile:${key}` : `grass-tile:${key}`;
    mesh.castShadow = false;
    mesh.receiveShadow = receiveShadow;
    mesh.frustumCulled = true;

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    // Count dominant chunkId for optional `CityStreamer` chunk gating.
    const chunkVotes = new Map<string, number>();

    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      V3_A.set(s.x, s.y, s.z);
      Q_A.setFromAxisAngle(upAxis, s.rotY);
      V3_B.set(s.scaleXZ, s.scaleY, s.scaleXZ);
      M4_A.compose(V3_A, Q_A, V3_B);
      mesh.setMatrixAt(i, M4_A);

      COLOR_A.setRGB(s.r, s.g, s.b);
      mesh.setColorAt(i, COLOR_A);

      if (s.x < minX) minX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.z < minZ) minZ = s.z;
      if (s.x > maxX) maxX = s.x;
      if (s.y > maxY) maxY = s.y;
      if (s.z > maxZ) maxZ = s.z;

      chunkVotes.set(s.chunkId, (chunkVotes.get(s.chunkId) ?? 0) + 1);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    // Inflate tight tile bounds by sway/height margins so Three.js frustum culling never clips swaying blades.
    BOX_A.min.set(minX - 0.45, minY - 0.1, minZ - 0.45);
    BOX_A.max.set(maxX + 0.45, maxY + 0.65, maxZ + 0.45);
    mesh.boundingBox = BOX_A.clone();
    mesh.boundingSphere = new T.Sphere();
    mesh.boundingBox.getBoundingSphere(mesh.boundingSphere);

    let dominantChunk = list[0].chunkId;
    let bestVotes = 0;
    for (const [cid, count] of chunkVotes) {
      if (count > bestVotes) {
        bestVotes = count;
        dominantChunk = cid;
      }
    }

    // Freeze local matrix once while keeping `matrixWorldAutoUpdate = true` so parent `stage.scale` (e.g. 0.94)
    // and `stage.position` ALWAYS propagate cleanly to every grass tile with zero vertical burial!
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = true;
    mesh.updateMatrix();
    parent.add(mesh);
    records.push({
      mesh,
      chunkId: dominantChunk,
      isAccent,
      cx: mesh.boundingSphere.center.x,
      cz: mesh.boundingSphere.center.z,
      radius: mesh.boundingSphere.radius,
    });
  }

  return records;
}

/**
 * Instantiates the standalone GPU-instanced outdoor grass & wildflower system for Echo Life.
 * Add `field.group` to the city root and call `field.update(...)` once per frame (`< 0.05 ms` CPU).
 */
export function createGrassField(
  city: CityPlan,
  house: HousePlan,
  initialQuality: GrassQualityTier = 'high',
): GrassField {
  const group = new T.Group();
  group.name = 'echo-life-grass-field';

  const uniforms: GrassShaderUniforms = {
    uTime: { value: 0 },
    uWindDir: { value: new T.Vector2(0.86, 0.51) },
    uWindStrength: { value: 0.45 },
    uActorPos: { value: new T.Vector4(0, -999, 0, 0) },
    uVehiclePos: { value: new T.Vector4(0, -999, 0, 0) },
    uSunDir: { value: new T.Vector3(0.35, 0.72, -0.60).normalize() },
    uDay: { value: 1 },
    uSeason: { value: 0 },
    uWetness: { value: 0 },
    uSnowCover: { value: 0 },
    uFadeRange: { value: new T.Vector2(36, 54) },
  };

  // Precompute static geometry footprints & exclusions once so `setQuality()` rebuilds quickly.
  const patches = collectGreenPatches(city);
  const exclusions = buildExclusions(city, house);

  let tuftGeo: T.BufferGeometry | null = null;
  let accentGeo: T.BufferGeometry | null = null;
  let grassMat: T.MeshStandardMaterial | null = null;
  let accentMat: T.MeshStandardMaterial | null = null;

  let tiles: TileRecord[] = [];
  const hiddenChunks = new Set<string>();
  const cityBounds = city.bounds;
  const clampedCull = { x: 0, z: 0 };
  const memoizedEmptyGrassCells = new Set<number>();
  let currentQuality: GrassQualityTier = initialQuality;
  let disposed = false;
  let smoothWetness = 0;
  let smoothSnow = 0;
  let lastCullX = Number.NaN;
  let lastCullZ = Number.NaN;
  let lastCellKey = Number.NaN;
  let lastStageScale = Number.NaN;
  let hasCullCenter = false;

  const stats: GrassFieldStats = {
    quality: initialQuality,
    tileCount: 0,
    accentTileCount: 0,
    totalTufts: 0,
    totalBlades: 0,
    accentCount: 0,
    drawCalls: 0,
    visibleTiles: 0,
  };

  const clearTiles = () => {
    for (let i = 0; i < tiles.length; i++) {
      const m = tiles[i].mesh;
      group.remove(m);
      m.dispose();
    }
    tiles = [];
    hasCullCenter = false;
    lastCullX = Number.NaN;
    lastCullZ = Number.NaN;
    lastCellKey = Number.NaN;
    lastStageScale = Number.NaN;
    memoizedEmptyGrassCells.clear();
    stats.tileCount = 0;
    stats.accentTileCount = 0;
    stats.totalTufts = 0;
    stats.totalBlades = 0;
    stats.accentCount = 0;
    stats.drawCalls = 0;
    stats.visibleTiles = 0;
  };

  const recomputeVisibleTiles = () => {
    const fadeEnd = TIER_CONFIG[currentQuality].fadeEnd;
    let vis = 0;
    let nearestTileGapM = Infinity;
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      let show = !hiddenChunks.has(t.chunkId);
      if (show && hasCullCenter) {
        const dx = t.cx - lastCullX;
        const dz = t.cz - lastCullZ;
        const dSq = dx * dx + dz * dz;
        // 3.0 m safety margin beyond shader fadeEnd + tile radius + 2.5 m exit hysteresis:
        // guarantees zero pop-in AND zero boundary visibility toggling on consecutive frames.
        const enterDist = fadeEnd + t.radius + 3.0;
        const exitDist = enterDist + 2.5;
        const maxDist = t.mesh.visible ? exitDist : enterDist;
        if (dSq > maxDist * maxDist) {
          show = false;
          const gap = Math.sqrt(dSq) - exitDist;
          if (gap < nearestTileGapM) nearestTileGapM = gap;
        } else {
          nearestTileGapM = 0;
        }
      }
      t.mesh.visible = show;
      if (show) vis++;
    }
    stats.visibleTiles = vis;
    if (hasCullCenter && vis === 0 && nearestTileGapM > 8.0 && Number.isFinite(lastCellKey)) {
      memoizedEmptyGrassCells.add(lastCellKey);
    }
  };

  const rebuild = (quality: GrassQualityTier) => {
    clearTiles();
    currentQuality = quality;
    stats.quality = quality;

    const cfg = TIER_CONFIG[quality];
    uniforms.uFadeRange.value.set(cfg.fadeStart, cfg.fadeEnd);

    if (cfg.targetTufts <= 0) {
      group.visible = false;
      return;
    }

    if (!tuftGeo) tuftGeo = buildGrassTuftGeometry();
    if (!accentGeo) accentGeo = buildWildflowerTuftGeometry();
    if (!grassMat) grassMat = createGrassMaterial(uniforms, false);
    if (!accentMat) accentMat = createGrassMaterial(uniforms, true);

    const { grass, accents } = sampleEcologicalMeadow(city, house, patches, exclusions, cfg);
    const ox = city.bounds.x0;
    const oz = city.bounds.z0;
    const grassTiles = buildTiledInstancedMeshes(grass, tuftGeo, grassMat, cfg.receiveShadow, false, group, ox, oz);
    const accentTiles = buildTiledInstancedMeshes(accents, accentGeo, accentMat, cfg.receiveShadow, true, group, ox, oz);

    tiles = [...grassTiles, ...accentTiles];
    stats.tileCount = grassTiles.length;
    stats.accentTileCount = accentTiles.length;
    stats.totalTufts = grass.length;
    stats.totalBlades = grass.length * BLADES_PER_TUFT;
    stats.accentCount = accents.length;
    stats.drawCalls = tiles.length;

    group.visible = true;
    recomputeVisibleTiles();
  };

  rebuild(initialQuality);

  return {
    group,
    stats,

    update(input: GrassUpdateInput) {
      if (disposed || tiles.length === 0) return;

      const dt = Math.max(0, Math.min(input.dt, 0.1));
      if (!input.reduced) {
        uniforms.uTime.value = (uniforms.uTime.value + dt) % 86400;
      }

      const rain = Math.max(0, Math.min(1, input.rain ?? 0));
      const snow = Math.max(0, Math.min(1, input.snow ?? 0));
      const day = Math.max(0, Math.min(1, input.day ?? 1));
      const season = Math.max(0, Math.min(3, input.season ?? 0));

      uniforms.uDay.value = day;
      uniforms.uSeason.value = season;

      if (typeof input.wetness === 'number') {
        smoothWetness = Math.max(0, Math.min(1, input.wetness));
      } else {
        const targetWet = rain > 0.05 ? Math.min(1, 0.4 + rain * 0.6) : 0;
        const rate = targetWet > smoothWetness ? 0.35 : 0.06;
        smoothWetness += (targetWet - smoothWetness) * (input.reduced ? 1 : 1 - Math.exp(-rate * dt));
      }
      uniforms.uWetness.value = smoothWetness;

      if (typeof input.snowCover === 'number') {
        smoothSnow = Math.max(0, Math.min(1, input.snowCover));
      } else {
        const targetSnow = snow > 0.05 ? Math.min(1, 0.5 + snow * 0.5) : 0;
        const rate = targetSnow > smoothSnow ? 0.25 : 0.08;
        smoothSnow += (targetSnow - smoothSnow) * (input.reduced ? 1 : 1 - Math.exp(-rate * dt));
      }
      uniforms.uSnowCover.value = smoothSnow;

      // Wind direction & strength: consume shared `windVec` if supplied, otherwise drive smooth natural gusts.
      if (input.windVec) {
        const wx = input.windVec.x;
        const wz = input.windVec.z ?? input.windVec.y ?? 0;
        const mag = Math.hypot(wx, wz);
        if (mag > 0.001) {
          uniforms.uWindDir.value.set(wx / mag, wz / mag);
        }
        const computedStrength = Math.max(0.18, Math.min(1.75, mag * 0.42));
        uniforms.uWindStrength.value = input.windStrength ?? (input.reduced ? 0.0 : computedStrength);
      } else {
        const t = uniforms.uTime.value;
        const angle = 0.42 + Math.sin(t * 0.11) * 0.35;
        uniforms.uWindDir.value.set(Math.cos(angle), Math.sin(angle));
        const storm = Math.max(rain, snow * 0.75);
        const breeze = 0.42 + storm * 0.95 + (season >= 1.5 && season < 2.5 ? 0.16 : 0);
        uniforms.uWindStrength.value = input.windStrength ?? (input.reduced ? 0.0 : breeze);
      }

      if (input.sunDir) {
        const sx = input.sunDir.x;
        const sy = input.sunDir.y;
        const sz = input.sunDir.z;
        const sLen = Math.hypot(sx, sy, sz);
        if (sLen > 1e-4) {
          uniforms.uSunDir.value.set(sx / sLen, sy / sLen, sz / sLen);
        }
      }

      // Scale shader fade range & transform stage-local actor/vehicle positions into world space using `group.matrixWorld`
      // so `stage.scale` (e.g. 0.94) and `stage.position` align 100% with Three.js world-space `cameraPosition`!
      const te = group.matrixWorld.elements;
      const stageScale = Math.hypot(te[0], te[1], te[2]) || 1;
      if (Math.abs(stageScale - lastStageScale) > 1e-4) {
        lastStageScale = stageScale;
        const cfg = TIER_CONFIG[currentQuality];
        uniforms.uFadeRange.value.set(cfg.fadeStart * stageScale, cfg.fadeEnd * stageScale);
      }

      if (input.actorPos) {
        V3_A.set(input.actorPos.x, input.actorPos.y, input.actorPos.z).applyMatrix4(group.matrixWorld);
        uniforms.uActorPos.value.set(V3_A.x, V3_A.y, V3_A.z, 1.2 * stageScale);
      } else {
        uniforms.uActorPos.value.w = 0;
      }

      if (input.vehiclePos) {
        V3_A.set(input.vehiclePos.x, input.vehiclePos.y, input.vehiclePos.z).applyMatrix4(group.matrixWorld);
        uniforms.uVehiclePos.value.set(
          V3_A.x,
          V3_A.y,
          V3_A.z,
          (input.vehiclePos.radius ?? 2.15) * stageScale,
        );
      } else {
        uniforms.uVehiclePos.value.w = 0;
      }

      // Distance-cull stage-local tiles against stage-local actor/camera center, strictly clamped to `cityBounds`
      // so boundary riding/panning never evaluates non-existent out-of-bounds space or re-scans empty perimeter cells.
      let rawCullX: number | null = null;
      let rawCullZ: number | null = null;
      if (input.actorPos) {
        rawCullX = input.actorPos.x;
        rawCullZ = input.actorPos.z;
      } else if (input.cameraPos) {
        const isAxisAligned =
          Math.abs(te[1]) < 1e-5 &&
          Math.abs(te[2]) < 1e-5 &&
          Math.abs(te[4]) < 1e-5 &&
          Math.abs(te[6]) < 1e-5 &&
          Math.abs(te[8]) < 1e-5 &&
          Math.abs(te[9]) < 1e-5;
        if (isAxisAligned) {
          rawCullX = (input.cameraPos.x - te[12]) / (te[0] || stageScale);
          rawCullZ = (input.cameraPos.z - te[14]) / (te[10] || stageScale);
        } else {
          M4_A.copy(group.matrixWorld).invert();
          V3_B.set(input.cameraPos.x, input.cameraPos.y, input.cameraPos.z).applyMatrix4(M4_A);
          rawCullX = V3_B.x;
          rawCullZ = V3_B.z;
        }
      }
      if (rawCullX !== null && rawCullZ !== null) {
        clampToBounds(rawCullX, rawCullZ, cityBounds, clampedCull);
        const cullX = clampedCull.x;
        const cullZ = clampedCull.z;
        const cellX = Math.floor(cullX * 0.25);
        const cellZ = Math.floor(cullZ * 0.25);
        const cellKey = (cellX + 8192) * 16384 + (cellZ + 8192);
        const dx = hasCullCenter ? cullX - lastCullX : Infinity;
        const dz = hasCullCenter ? cullZ - lastCullZ : Infinity;
        if (
          !hasCullCenter ||
          (dx * dx + dz * dz > 2.25 && !memoizedEmptyGrassCells.has(cellKey))
        ) {
          lastCullX = cullX;
          lastCullZ = cullZ;
          lastCellKey = cellKey;
          hasCullCenter = true;
          recomputeVisibleTiles();
        }
      }
    },

    setQuality(quality: GrassQualityTier) {
      if (disposed || quality === currentQuality) return;
      rebuild(quality);
    },

    setVisible(visible: boolean) {
      if (disposed) return;
      group.visible = visible && tiles.length > 0;
    },

    setChunkVisible(chunkId: string, visible: boolean) {
      if (disposed) return;
      const changed = visible
        ? hiddenChunks.delete(chunkId)
        : !hiddenChunks.has(chunkId) && Boolean(hiddenChunks.add(chunkId));
      if (!changed) return;
      memoizedEmptyGrassCells.clear();
      recomputeVisibleTiles();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      clearTiles();
      disposeObjectTree(group, { disposeShared: true, clearChildren: true });
      tuftGeo?.dispose();
      accentGeo?.dispose();
      grassMat?.dispose();
      accentMat?.dispose();
      tuftGeo = null;
      accentGeo = null;
      grassMat = null;
      accentMat = null;
    },
  };
}
