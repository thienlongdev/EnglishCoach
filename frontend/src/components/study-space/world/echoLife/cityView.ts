import * as T from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GROUND_Y, type HousePlan, type Rect } from '@/lib/echo-life/plan';
import { ROAD_DROP, type CityPlan, type Surface } from '@/lib/echo-life/city';
import { textBoard } from './buildingsView';
import type { QualityTier } from './renderConfig';
import {
  AtmosphereSystem,
  buildSkylineView,
  patchHeightFog,
  type AtmosphereInput,
  type AtmosphereSnapshot,
  type SkylineView,
} from './atmosphere';
import { patchMaterialWithEchoCsm } from './echoCsm';
import { freezeStaticHierarchy } from './scratch';
import { WaterSurface } from './waterSurface';
import {
  WeatherDynamics,
  WeatherParticleSystem,
  createSharedWeatherUniforms,
  patchWeatherWetness,
  type SharedWeatherUniforms,
  type WeatherParticleMode,
} from './weatherSystem';
import { WorldSurfaceLibrary } from './worldSurfaces';
import { updateStreetProps } from './streetPropsManifest';

/**
 * The base landscape drawn from `cityPlan`: Poly Haven PBR roads (wheel tracks + rain puddles), concrete-paver
 * sidewalks, granite curbs & storm drains, crosswalks, dual-surface grass/dirt park & garden lawns, oak boardwalk,
 * waterline-moss stone river embankment & AAA river water shader with swaying reeds, continuous zero-void urban
 * block infill & 920 m coastal horizon terrain skirt, physical Rayleigh + Mie + FBM sky dome, sculpted downtown
 * skyline synced to `FogExp2`, street wayfinding signs, and GPU instanced billboard weather particles.
 *
 * Static ground geometry is partitioned into tight spatial X-parcels per sector and merged by shared PBR material
 * so frustum culling & CSM shadow culling work tightly while slashing `city-ground` draw calls (`80c -> <= 16c`).
 */
export interface CityView {
  group: T.Group;
  sectors: { north: T.Group; south: T.Group; sides: T.Group };
  readonly atmosphere: AtmosphereSystem;
  readonly weatherUniforms: SharedWeatherUniforms;
  readonly surfaces: WorldSurfaceLibrary;
  readonly water: WaterSurface;
  setDay(
    day: number,
    rain: number,
    angle?: number,
    season?: number,
    cloud?: number,
    outdoors?: boolean,
    snow?: number,
  ): void;
  updateAtmosphere(
    dt: number,
    input: AtmosphereInput,
    camera: T.Camera,
    lampPositions?: readonly T.Vector3[],
    snapOverride?: boolean,
  ): AtmosphereSnapshot;
  setLampPositions(positions: readonly T.Vector3[]): void;
  setQuality(tier: QualityTier): void;
  update(dt: number, reduced: boolean, camera: T.Camera): void;
  dispose(): void;
}

export interface BuildCityOptions {
  weather?: SharedWeatherUniforms;
  surfaces?: WorldSurfaceLibrary;
  atmosphere?: AtmosphereSystem;
  fallbackEnv?: T.Texture | null;
}

/**
 * Axis-aligned box whose UVs are anchored in world metres (`pos / unit`) so adjoining parcels and
 * split ground strips tile with 100% seamless PBR continuity across parcel boundaries.
 */
function worldMeteredBox(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  unit = 3,
): T.BufferGeometry {
  const w = Math.max(1e-4, x1 - x0);
  const h = Math.max(1e-4, y1 - y0);
  const d = Math.max(1e-4, z1 - z0);
  const cx = (x0 + x1) * 0.5;
  const cy = (y0 + y1) * 0.5;
  const cz = (z0 + z1) * 0.5;
  const g = new T.BoxGeometry(w, h, d);
  g.translate(cx, cy, cz);
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
    if (ay > 0.5) {
      uv.setXY(i, px * inv, pz * inv);
    } else if (ax > 0.5) {
      uv.setXY(i, pz * inv, py * inv);
    } else {
      uv.setXY(i, px * inv, py * inv);
    }
  }
  return g;
}

/** Exact 2D rectangle difference (`target \ cutters`) matching `outdoorAt` last-write-wins ground priority. */
function subtractRect2D(target: Rect, cutters: readonly Rect[], eps = 1e-4): Rect[] {
  let parts: Rect[] = [target];
  for (let ci = 0; ci < cutters.length && parts.length > 0; ci++) {
    const b = cutters[ci];
    const next: Rect[] = [];
    for (let pi = 0; pi < parts.length; pi++) {
      const a = parts[pi];
      const ix0 = Math.max(a.x0, b.x0);
      const ix1 = Math.min(a.x1, b.x1);
      const iz0 = Math.max(a.z0, b.z0);
      const iz1 = Math.min(a.z1, b.z1);
      if (ix1 - ix0 <= eps || iz1 - iz0 <= eps) {
        next.push(a);
        continue;
      }
      if (b.x0 - a.x0 > eps) next.push({ x0: a.x0, x1: b.x0, z0: a.z0, z1: a.z1 });
      if (a.x1 - b.x1 > eps) next.push({ x0: b.x1, x1: a.x1, z0: a.z0, z1: a.z1 });
      if (b.z0 - a.z0 > eps) next.push({ x0: ix0, x1: ix1, z0: a.z0, z1: b.z0 });
      if (a.z1 - b.z1 > eps) next.push({ x0: ix0, x1: ix1, z0: b.z1, z1: a.z1 });
    }
    parts = next;
  }
  return parts;
}

function rectsOverlap2D(a: Rect, b: Rect, pad = 0): boolean {
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > -pad && Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) > -pad;
}

/** Complement of sorted blocked X intervals `[b0, b1]` inside `[xMin, xMax]`, inset slightly from road edges. */
function complementSpans(
  xMin: number,
  xMax: number,
  blocked: readonly [number, number][],
  pad = 0.04,
): [number, number][] {
  const sorted = blocked
    .map(([a, b]): [number, number] => [a - pad, b + pad])
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let cur = xMin;
  for (const [b0, b1] of sorted) {
    if (b0 > cur + 0.05) out.push([cur, Math.min(b0, xMax)]);
    cur = Math.max(cur, b1);
    if (cur >= xMax) break;
  }
  if (xMax > cur + 0.05) out.push([cur, xMax]);
  return out;
}

/**
 * Builds a single continuous 920 m rolling coastal terrain skirt surrounding the city footprint
 * (west, east, south countryside + north coastal hills behind the far riverbank) with a clean riverbed trough
 * so looking past any avenue, botanical garden, or south residence blends organically into distance fog.
 */
function buildCoastalHorizonSkirt(
  innerX0: number,
  innerX1: number,
  innerZ0: number,
  innerZ1: number,
  riverZ0: number,
  riverZ1: number,
  baseY: number,
): T.BufferGeometry | null {
  const OUTER = 920;
  const cx = (innerX0 + innerX1) * 0.5;
  const cz = (innerZ0 + innerZ1) * 0.5;
  const halfInnerX = (innerX1 - innerX0) * 0.5;
  const halfInnerZ = (innerZ1 - innerZ0) * 0.5;
  const outerX0 = cx - halfInnerX - OUTER;
  const outerX1 = cx + halfInnerX + OUTER;
  const outerZ0 = cz - halfInnerZ - OUTER;
  const outerZ1 = cz + halfInnerZ + OUTER;

  // Non-uniform ring stops: fine transition near the city edge, broad quads toward the 920 m horizon.
  const xStops = [
    outerX0,
    innerX0 - 480,
    innerX0 - 210,
    innerX0 - 85,
    innerX0 - 30,
    innerX0,
    innerX0 + (innerX1 - innerX0) * 0.25,
    innerX0 + (innerX1 - innerX0) * 0.5,
    innerX0 + (innerX1 - innerX0) * 0.75,
    innerX1,
    innerX1 + 30,
    innerX1 + 85,
    innerX1 + 210,
    innerX1 + 480,
    outerX1,
  ];
  const zStops = [
    outerZ0,
    innerZ0 - 480,
    innerZ0 - 240,
    innerZ0 - 110,
    innerZ0 - 32,
    innerZ0,
    riverZ0,
    (riverZ0 + riverZ1) * 0.5,
    riverZ1,
    (riverZ1 + innerZ1) * 0.5,
    innerZ1,
    innerZ1 + 30,
    innerZ1 + 85,
    innerZ1 + 210,
    innerZ1 + 480,
    outerZ1,
  ];

  const nx = xStops.length;
  const nz = zStops.length;
  const positions = new Float32Array(nx * nz * 3);
  const colors = new Float32Array(nx * nz * 3);
  const uvs = new Float32Array(nx * nz * 2);

  // Linear-space natural coastal palette (lush lowland meadow -> sunlit olive slope -> misty distant coastal ridge).
  const lowCol = new T.Color('#5a8648');
  const midCol = new T.Color('#476b41');
  const ridgeCol = new T.Color('#4d6964');
  const bankCol = new T.Color('#395238');
  const tmpCol = new T.Color();

  for (let iz = 0; iz < nz; iz++) {
    const z = zStops[iz];
    for (let ix = 0; ix < nx; ix++) {
      const x = xStops[ix];
      const dx = Math.max(innerX0 - x, 0, x - innerX1);
      const dz = Math.max(innerZ0 - z, 0, z - innerZ1);
      const dist = Math.hypot(dx, dz);

      // Keep the first 96 m outside the city rim level so road continuations & perimeter lawns sit cleanly without clipping.
      const hillRamp = T.MathUtils.smoothstep(dist, 96, 320);
      const farRamp = T.MathUtils.smoothstep(dist, 240, 780);

      // Multi-frequency deterministic coastal hills (higher scenic ridges north behind the skyline & far west/east).
      const waveA = Math.sin(x * 0.0085 + 0.7) * Math.cos(z * 0.0092 - 0.4) * 0.5 + 0.5;
      const waveB = Math.sin(x * 0.019 - z * 0.015 + 1.9) * 0.5 + 0.5;
      const waveC = Math.cos(x * 0.0042 + z * 0.0038) * 0.5 + 0.5;
      const northBoost = z < riverZ0 - 80 ? 1.45 : 1.0;

      let elev = (hillRamp * (4.0 + waveA * 14.0 + waveB * 5.5) + farRamp * (18.0 + waveC * 34.0)) * northBoost;

      // Carve a graceful river valley trough along the river corridor so the water channel flows smoothly into fog.
      const inRiverBand = z >= riverZ0 - 8 && z <= riverZ1 + 8;
      if (inRiverBand && dist < 240) {
        const valleyWeight = 1.0 - T.MathUtils.smoothstep(Math.abs(z - (riverZ0 + riverZ1) * 0.5), 14, 28);
        const channelFade = 1.0 - T.MathUtils.smoothstep(dist, 140, 240);
        elev = elev * (1 - valleyWeight * channelFade) - 1.35 * valleyWeight * channelFade;
      }

      // Gently tuck strictly inside the inner rectangle (cells omitted below, edge vertices flush at baseY).
      const y = dist <= 1e-3 ? baseY - 0.04 : baseY + elev;

      const vi = iz * nx + ix;
      positions[vi * 3] = x;
      positions[vi * 3 + 1] = y;
      positions[vi * 3 + 2] = z;
      uvs[vi * 2] = x / 28;
      uvs[vi * 2 + 1] = z / 28;

      const elevT = T.MathUtils.clamp(elev / 38, 0, 1);
      tmpCol.copy(lowCol).lerp(midCol, T.MathUtils.clamp(elevT * 1.4, 0, 1)).lerp(ridgeCol, farRamp * 0.75);
      if (elev < -0.2) tmpCol.lerp(bankCol, 0.7);
      colors[vi * 3] = tmpCol.r;
      colors[vi * 3 + 1] = tmpCol.g;
      colors[vi * 3 + 2] = tmpCol.b;
    }
  }

  const indices: number[] = [];
  for (let iz = 0; iz < nz - 1; iz++) {
    const zMid = (zStops[iz] + zStops[iz + 1]) * 0.5;
    for (let ix = 0; ix < nx - 1; ix++) {
      const xMid = (xStops[ix] + xStops[ix + 1]) * 0.5;
      // Leave an exact clean cutout for the urban core + river channel (covered by `city-ground`, `city-base-ground`, and `WaterSurface`).
      if (xMid > innerX0 && xMid < innerX1 && zMid > innerZ0 && zMid < innerZ1) continue;
      const a = iz * nx + ix;
      const b = a + 1;
      const c = (iz + 1) * nx + ix;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.BufferAttribute(positions, 3));
  geo.setAttribute('color', new T.BufferAttribute(colors, 3));
  geo.setAttribute('uv', new T.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

export function buildCity(
  city: CityPlan,
  house: HousePlan,
  quality: QualityTier,
  shared: BuildCityOptions = {},
): CityView {
  const group = new T.Group(); group.name = 'echo-life-city';
  const north = new T.Group(), south = new T.Group(), sides = new T.Group();
  north.name = 'city-north'; south.name = 'city-south'; sides.name = 'city-sides';
  group.add(north, south, sides);

  const owned: { dispose(): void }[] = [];
  const waterY = GROUND_Y - 0.55;
  const riverTop = city.river.z1;

  // Shared weather uniform state, PBR world surface library & physical atmosphere system.
  const weatherUniforms = shared.weather ?? createSharedWeatherUniforms();
  const weatherDynamics = new WeatherDynamics(weatherUniforms);

  const ownedSurfaces = !shared.surfaces
    ? new WorldSurfaceLibrary(weatherUniforms, quality, { riverZ1: riverTop, waterY })
    : null;
  const surfaces = shared.surfaces ?? ownedSurfaces!;
  if (ownedSurfaces) owned.push(ownedSurfaces);

  const ownedAtmosphere = !shared.atmosphere
    ? new AtmosphereSystem(weatherUniforms, quality, shared.fallbackEnv ?? null)
    : null;
  const atmosphere = shared.atmosphere ?? ownedAtmosphere!;
  if (ownedAtmosphere) owned.push(ownedAtmosphere);

  // Consolidate matching north/south ground & road surfaces (including urban alley infill, south-fringe lawn,
  // and distant road continuations) into 1 merged static mesh per shared PBR material (`City_Ground_Roads`: 17 -> 7 draws!).
  // Keep riverfront-exclusive features (`embankmentMat`, `farBankMat`, `boardwalkMat`) on `north` so river reflections
  // still reflect the stone quay wall & far-bank meadow while hiding `city-ground`.
  const sectorOf = (z: number, _x?: number): T.Group => (z < house.footprint.z0 ? north : south);

  const roadMat = surfaces.road();
  const sidewalkMat = surfaces.sidewalk();
  const parkMat = surfaces.parkLawn('park');
  const plazaMat = surfaces.plaza();
  const SURF: Record<Surface, T.Material> = {
    sidewalk: sidewalkMat,
    road: roadMat,
    crossing: roadMat,
    park: parkMat,
    garden: parkMat,
    plaza: plazaMat,
  };
  const boardwalkMat = surfaces.boardwalk();
  const markingMat = surfaces.roadMarking();
  const curbMat = surfaces.graniteCurb();
  const ironMat = surfaces.embankmentRail();
  const embankmentMat = surfaces.embankmentWall();
  const farBankMat = surfaces.farBank();

  const unifiedGround = new Map<T.Material, T.BufferGeometry[]>();
  const northOnlyGround = new Map<T.Material, T.BufferGeometry[]>();
  const addUnified = (m: T.Material, g: T.BufferGeometry) => {
    let list = unifiedGround.get(m);
    if (!list) { list = []; unifiedGround.set(m, list); }
    list.push(g);
  };
  const addNorthOnly = (m: T.Material, g: T.BufferGeometry) => {
    let list = northOnlyGround.get(m);
    if (!list) { list = []; northOnlyGround.set(m, list); }
    list.push(g);
  };

  // Clip each `city.ground[i]` against all later non-crossing `city.ground[j]` (`j > i`) to match `outdoorAt`
  // last-write-wins semantics (eliminating sidewalk barriers across cross-street road throats & coplanar plaza overlaps),
  // and skip duplicate asphalt boxes under `crossing` (which sit inside `road` and emit thermoplastic zebra stripes below).
  const nonCrossingRects: { idx: number; rect: Rect }[] = [];
  for (let i = 0; i < city.ground.length; i++) {
    if (city.ground[i].surface !== 'crossing') {
      nonCrossingRects.push({ idx: i, rect: city.ground[i].rect });
    }
  }
  for (let i = 0; i < city.ground.length; i++) {
    const gr = city.ground[i];
    if (gr.surface === 'crossing') continue;
    const laterCutters: Rect[] = [];
    for (let k = 0; k < nonCrossingRects.length; k++) {
      if (nonCrossingRects[k].idx > i) laterCutters.push(nonCrossingRects[k].rect);
    }
    const disjoint = subtractRect2D(gr.rect, laterCutters);
    const depth = 0.4;
    const topY = gr.y;
    const unit = gr.surface === 'road' ? 3.5 : 3.0;
    for (let di = 0; di < disjoint.length; di++) {
      const sub = disjoint[di];
      const box = worldMeteredBox(sub.x0, sub.x1, topY - depth, topY, sub.z0, sub.z1, unit);
      if (gr.surface === 'plaza' && gr.zone === 'fair') {
        addNorthOnly(boardwalkMat, box);
      } else {
        addUnified(SURF[gr.surface], box);
      }
    }
  }

  // Road markings (worn thermoplastic zebra stripes & lane dashes), granite curbs, and cast-iron gutter storm drains.
  const allRoadRects = city.ground.filter(g => g.surface === 'road').map(g => g.rect);
  const allCrossingRects = city.ground.filter(g => g.surface === 'crossing').map(g => g.rect);
  const emittedCurbRects: Rect[] = [];
  const addClippedCurb = (curbRect: Rect, curbBot: number, curbTop: number) => {
    const afterRoads = subtractRect2D(curbRect, allRoadRects);
    for (let ci = 0; ci < afterRoads.length; ci++) {
      const clean = subtractRect2D(afterRoads[ci], emittedCurbRects);
      for (let cj = 0; cj < clean.length; cj++) {
        const cr = clean[cj];
        emittedCurbRects.push(cr);
        addUnified(curbMat, worldMeteredBox(cr.x0, cr.x1, curbBot, curbTop, cr.z0, cr.z1, 1.8));
      }
    }
  };

  for (const gr of city.ground) {
    const w = gr.rect.x1 - gr.rect.x0, d = gr.rect.z1 - gr.rect.z0;
    const cx = (gr.rect.x0 + gr.rect.x1) / 2, cz = (gr.rect.z0 + gr.rect.z1) / 2;
    if (gr.surface === 'crossing') {
      const alongX = w < d;
      for (let k = 0.4; k < (alongX ? w : d) - 0.2; k += 0.8) {
        const bx0 = alongX ? gr.rect.x0 + k - 0.225 : gr.rect.x0 + 0.15;
        const bx1 = alongX ? gr.rect.x0 + k + 0.225 : gr.rect.x1 - 0.15;
        const bz0 = alongX ? gr.rect.z0 + 0.15 : gr.rect.z0 + k - 0.225;
        const bz1 = alongX ? gr.rect.z1 - 0.15 : gr.rect.z0 + k + 0.225;
        addUnified(markingMat, worldMeteredBox(bx0, bx1, gr.y + 0.006, gr.y + 0.016, bz0, bz1, 2.0));
      }
    } else if (gr.surface === 'road') {
      const alongX = w > d;
      const span = alongX ? w : d;
      const otherRoads = allRoadRects.filter(rr => rr !== gr.rect);
      // Lane centre dashes (lifted +6..+16 mm above road asphalt, skipping crosswalks & intersections).
      for (let k = 1; k < span - 1; k += 6) {
        const bx0 = alongX ? gr.rect.x0 + k - 1.5 : cx - 0.07;
        const bx1 = alongX ? gr.rect.x0 + k + 1.5 : cx + 0.07;
        const bz0 = alongX ? cz - 0.07 : gr.rect.z0 + k - 1.5;
        const bz1 = alongX ? cz + 0.07 : gr.rect.z0 + k + 1.5;
        const dashRect: Rect = { x0: bx0, x1: bx1, z0: bz0, z1: bz1 };
        if (
          allCrossingRects.some(cr => rectsOverlap2D(dashRect, cr, 0.25)) ||
          otherRoads.some(rr => rectsOverlap2D(dashRect, rr, 0.25))
        ) {
          continue;
        }
        addUnified(markingMat, worldMeteredBox(bx0, bx1, gr.y + 0.006, gr.y + 0.016, bz0, bz1, 2.0));
      }
      // Chamfered granite road-edge curb trims clipped cleanly at cross-street intersections (+16 mm above sidewalk).
      const curbH = ROAD_DROP + 0.036;
      const curbTop = GROUND_Y + 0.016;
      const curbBot = curbTop - curbH;
      if (alongX) {
        for (const edgeZ of [gr.rect.z0 - 0.08, gr.rect.z1 + 0.08]) {
          addClippedCurb({ x0: gr.rect.x0, x1: gr.rect.x1, z0: edgeZ - 0.08, z1: edgeZ + 0.08 }, curbBot, curbTop);
        }
        // Slotted cast-iron gutter storm drains spaced cleanly along major avenues (clear of cross streets).
        if (w >= 18) {
          for (let x = gr.rect.x0 + 8; x < gr.rect.x1 - 8; x += 18) {
            const d1: Rect = { x0: x - 0.34, x1: x + 0.34, z0: gr.rect.z0 + 0.05, z1: gr.rect.z0 + 0.39 };
            if (!otherRoads.some(rr => rectsOverlap2D(d1, rr, 0.4))) {
              addUnified(ironMat, worldMeteredBox(d1.x0, d1.x1, gr.y + 0.004, gr.y + 0.014, d1.z0, d1.z1, 1.0));
            }
            const x2 = x + 9 < gr.rect.x1 - 6 ? x + 9 : x;
            const d2: Rect = { x0: x2 - 0.34, x1: x2 + 0.34, z0: gr.rect.z1 - 0.39, z1: gr.rect.z1 - 0.05 };
            if (!otherRoads.some(rr => rectsOverlap2D(d2, rr, 0.4))) {
              addUnified(ironMat, worldMeteredBox(d2.x0, d2.x1, gr.y + 0.004, gr.y + 0.014, d2.z0, d2.z1, 1.0));
            }
          }
        }
      } else {
        for (const edgeX of [gr.rect.x0 - 0.08, gr.rect.x1 + 0.08]) {
          addClippedCurb({ x0: edgeX - 0.08, x1: edgeX + 0.08, z0: gr.rect.z0, z1: gr.rect.z1 }, curbBot, curbTop);
        }
      }
    }
  }

  // River embankment: waterline-moss stone walls (stopped 6 mm below coping bottom), granite coping capstone, wrought-iron railings, far bank meadow.
  addNorthOnly(embankmentMat, worldMeteredBox(city.river.x0, city.river.x1, GROUND_Y - 1.245, GROUND_Y - 0.036, riverTop - 0.48, riverTop, 2.4));
  addUnified(curbMat, worldMeteredBox(city.river.x0, city.river.x1, GROUND_Y - 0.03, GROUND_Y + 0.06, riverTop - 0.50, riverTop + 0.08, 1.8));
  addUnified(ironMat, worldMeteredBox(city.bounds.x0, city.bounds.x1, GROUND_Y + 0.924, GROUND_Y + 0.976, riverTop + 0.114, riverTop + 0.186, 2.0));
  addUnified(ironMat, worldMeteredBox(city.bounds.x0, city.bounds.x1, GROUND_Y + 0.466, GROUND_Y + 0.494, riverTop + 0.132, riverTop + 0.168, 2.0));
  for (let x = city.bounds.x0; x <= city.bounds.x1; x += 3.5) {
    addUnified(ironMat, worldMeteredBox(x - 0.024, x + 0.024, GROUND_Y, GROUND_Y + 0.96, riverTop + 0.126, riverTop + 0.174, 1.0));
  }
  // Far riverbank seawall + Poly Haven textured meadow + gentle shoreline berm (kept on `north` for river reflections).
  addNorthOnly(farBankMat, worldMeteredBox(city.river.x0, city.river.x1, GROUND_Y - 0.60, GROUND_Y - 0.30, city.river.z0 - 280, city.river.z0, 6.0));
  addNorthOnly(farBankMat, worldMeteredBox(city.river.x0, city.river.x1, GROUND_Y - 0.445, GROUND_Y + 0.205, city.river.z0 - 22, city.river.z0 - 6, 6.0));
  addNorthOnly(embankmentMat, worldMeteredBox(city.river.x0, city.river.x1, GROUND_Y - 1.195, GROUND_Y - 0.245, city.river.z0 - 0.01, city.river.z0 + 0.51, 2.4));

  // ── ZERO-VOID URBAN BASE GROUND, ALLEY INFILL, SOUTH FRINGE APRON & 920 m COASTAL HORIZON SKIRT (G-03) ──
  // Merged straight into matching `sidewalkMat` / `parkMat` / `roadMat` ground batches (0 extra draw calls!).
  {
    const lantern = city.streets.find(s => s.id === 'lantern')!.rect;
    const riverside = city.streets.find(s => s.id === 'riverside')!.rect;
    const marketBlvd = city.streets.find(s => s.id === 'market_blvd')?.rect;
    const x0 = city.bounds.x0;
    const x1 = city.bounds.x1;
    const m0 = marketBlvd ? marketBlvd.z0 : lantern.z1 + 30;
    const m3 = marketBlvd ? marketBlvd.z1 : lantern.z1 + 43;

    // Collect vertical cross-street road corridors separately for north band (n3..s0) & south band (s3..m0).
    const nsNorthRoads: [number, number][] = [];
    const nsSouthRoads: [number, number][] = [];
    for (const gr of city.ground) {
      if (gr.surface !== 'road') continue;
      const w = gr.rect.x1 - gr.rect.x0;
      const d = gr.rect.z1 - gr.rect.z0;
      if (d <= w) continue;
      const cz = (gr.rect.z0 + gr.rect.z1) * 0.5;
      if (cz < lantern.z0) nsNorthRoads.push([gr.rect.x0, gr.rect.x1]);
      else nsSouthRoads.push([gr.rect.x0, gr.rect.x1]);
    }

    // 1. Urban alley, under-building & setback paved infill (2.8 cm below sidewalk/interior floors -> zero Z-fighting!).
    const infillTop = GROUND_Y - 0.028;
    const infillBot = infillTop - 0.24;
    for (const [ax0, ax1] of complementSpans(x0 - 40, x1 + 40, nsNorthRoads, 0.05)) {
      addUnified(sidewalkMat, worldMeteredBox(ax0, ax1, infillBot, infillTop, riverside.z1 - 0.02, lantern.z0 + 0.02, 3.0));
    }
    for (const [ax0, ax1] of complementSpans(x0 - 40, x1 + 40, nsSouthRoads, 0.05)) {
      addUnified(sidewalkMat, worldMeteredBox(ax0, ax1, infillBot, infillTop, lantern.z1 - 0.02, m0 + 0.02, 3.0));
    }
    // Paved entrance driveways connecting Market Boulevard south sidewalk cleanly to every `south-fringe-*` lot/residence.
    for (const lot of city.lots) {
      if (!lot.id.startsWith('south-fringe-')) continue;
      addUnified(
        sidewalkMat,
        worldMeteredBox(
          lot.rect.x0 - 0.5,
          lot.rect.x1 + 0.5,
          GROUND_Y - 0.22,
          GROUND_Y - 0.012,
          m3 - 0.05,
          lot.rect.z1 + 1.4,
          3.0,
        ),
      );
    }

    // 2. Continuous sub-grade safety plinth (`GROUND_Y - ROAD_DROP - 0.04` = 4 cm below every asphalt road!).
    const subTop = GROUND_Y - ROAD_DROP - 0.04;
    addUnified(
      sidewalkMat,
      worldMeteredBox(x0 - 60, x1 + 60, subTop - 0.35, subTop, riverTop - 0.14, m3 + 56, 4.5),
    );
    // Deep submerged riverbed slab under river water so steep downward angles never glimpse sky void.
    addUnified(
      sidewalkMat,
      worldMeteredBox(city.river.x0 - 40, city.river.x1 + 40, GROUND_Y - 3.2, GROUND_Y - 2.3, city.river.z0 - 6, city.river.z1 + 6, 8.0),
    );

    // 3. South residential green lawn apron (covers ALL `south-fringe-0..5`, Market Blvd flanks & Botanical west verge!).
    const lawnTop = GROUND_Y - 0.024;
    const lawnBot = lawnTop - 0.26;
    addUnified(parkMat, worldMeteredBox(x0 - 52, x1 + 52, lawnBot, lawnTop, m3 - 0.04, m3 + 52, 4.0));
    if (marketBlvd) {
      addUnified(parkMat, worldMeteredBox(x0 - 52, marketBlvd.x0 + 0.04, lawnBot, lawnTop, m0 - 0.02, m3 + 0.02, 4.0));
      addUnified(parkMat, worldMeteredBox(marketBlvd.x1 - 0.04, x1 + 52, lawnBot, lawnTop, m0 - 0.02, m3 + 0.02, 4.0));
    }
    // West & east riverfront continuation meadows past Botanical Garden (`x < x0`) & Greenway (`x > x1`).
    addUnified(parkMat, worldMeteredBox(x0 - 52, x0 + 0.06, lawnBot, lawnTop, riverTop - 0.05, riverside.z0 + 0.05, 4.0));
    addUnified(parkMat, worldMeteredBox(x1 - 0.06, x1 + 52, lawnBot, lawnTop, riverTop - 0.05, riverside.z0 + 0.05, 4.0));

    // 4. Visual-only distant road continuation ribbons (eliminate abrupt cliff-ends in Scenes 05, 08, 11!).
    const contRoadTop = GROUND_Y - ROAD_DROP - 0.004;
    const contRoadBot = contRoadTop - 0.24;
    const contSwTop = GROUND_Y - 0.008;
    const contSwBot = contSwTop - 0.24;
    const roadContLen = 135;
    addUnified(roadMat, worldMeteredBox(x0 - roadContLen, x0 + 0.05, contRoadBot, contRoadTop, riverside.z0 + 3, riverside.z1 - 3, 3.5));
    addUnified(roadMat, worldMeteredBox(x1 - 0.05, x1 + roadContLen, contRoadBot, contRoadTop, riverside.z0 + 3, riverside.z1 - 3, 3.5));
    addUnified(sidewalkMat, worldMeteredBox(x0 - roadContLen, x0 + 0.05, contSwBot, contSwTop, riverside.z0, riverside.z0 + 3, 3.0));
    addUnified(sidewalkMat, worldMeteredBox(x0 - roadContLen, x0 + 0.05, contSwBot, contSwTop, riverside.z1 - 3, riverside.z1, 3.0));
    addUnified(sidewalkMat, worldMeteredBox(x1 - 0.05, x1 + roadContLen, contSwBot, contSwTop, riverside.z0, riverside.z0 + 3, 3.0));
    addUnified(sidewalkMat, worldMeteredBox(x1 - 0.05, x1 + roadContLen, contSwBot, contSwTop, riverside.z1 - 3, riverside.z1, 3.0));
    addUnified(roadMat, worldMeteredBox(x0 - roadContLen, x0 + 0.05, contRoadBot, contRoadTop, lantern.z0 + 3, lantern.z1 - 3, 3.5));
    addUnified(roadMat, worldMeteredBox(lantern.x1 - 0.05, x1 + roadContLen, contRoadBot, contRoadTop, lantern.z0 + 3, lantern.z1 - 3, 3.5));
    if (marketBlvd) {
      addUnified(roadMat, worldMeteredBox(x0 - roadContLen, marketBlvd.x0 + 0.05, contRoadBot, contRoadTop, marketBlvd.z0 + 3, marketBlvd.z1 - 3, 3.5));
      addUnified(roadMat, worldMeteredBox(marketBlvd.x1 - 0.05, x1 + roadContLen, contRoadBot, contRoadTop, marketBlvd.z0 + 3, marketBlvd.z1 - 3, 3.5));
    }

    // 5. Seamless 920 m rolling coastal terrain skirt blended smoothly into FogExp2 (1 draw call!).
    const skirtGeo = buildCoastalHorizonSkirt(
      x0 - 48,
      x1 + 48,
      city.river.z0 - 12,
      m3 + 48,
      city.river.z0,
      city.river.z1,
      GROUND_Y - 0.14,
    );
    if (skirtGeo) {
      const skirtMat = new T.MeshStandardMaterial({
        color: '#ffffff',
        vertexColors: true,
        roughness: 0.94,
        metalness: 0.0,
        envMapIntensity: 0.55,
      });
      patchWeatherWetness(skirtMat, weatherUniforms, {
        tier: quality,
        porosity: 0.40,
        puddleStrength: 0,
        snowReceptivity: 0.94,
        wetRoughnessScale: 0.70,
        cacheTag: 'far-bank',
      });
      patchMaterialWithEchoCsm(skirtMat);
      patchHeightFog(skirtMat);
      const skirtMesh = new T.Mesh(skirtGeo, skirtMat);
      skirtMesh.name = 'city-horizon-skirt';
      skirtMesh.receiveShadow = true;
      skirtMesh.castShadow = false;
      skirtMesh.frustumCulled = false;
      group.add(skirtMesh);
      freezeStaticHierarchy(skirtMesh);
      owned.push(skirtGeo, skirtMat);
    }
  }

  // Emit unified static ground meshes (7 draws city-wide, frozen matrices) + north-only riverfront meshes (3 draws).
  const mountGroundMap = (
    buckets: Map<T.Material, T.BufferGeometry[]>,
    parent: T.Group,
    nameFor: (m: T.Material) => string,
  ) => {
    for (const [m, list] of buckets) {
      if (!list.length) continue;
      const merged = mergeGeometries(list, false);
      list.forEach(g => g.dispose());
      if (!merged) continue;
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      owned.push(merged);
      const mesh = new T.Mesh(merged, m);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.frustumCulled = true;
      mesh.name = nameFor(m);
      parent.add(mesh);
      freezeStaticHierarchy(mesh);
    }
  };

  mountGroundMap(unifiedGround, group, () => 'city-ground');
  mountGroundMap(northOnlyGround, north, (m) =>
    m === embankmentMat ? 'city-embankment' : m === farBankMat ? 'city-farbank' : 'city-ground',
  );

  // AAA river water surface + instanced wind-swaying shoreline reeds.
  const water = new WaterSurface({
    river: city.river,
    waterY,
    tier: quality,
    weather: weatherUniforms,
  });
  north.add(water.group);
  owned.push(water);

  // Painted Riverside Park basketball half-court slab under the real hoop-post (1 draw call + weather rain puddles!).
  const hoop = city.props.find(pr => pr.asset === 'hoop-post');
  if (hoop && typeof document !== 'undefined') {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 512;
    const g2 = cv.getContext('2d');
    if (g2) {
      g2.fillStyle = '#335d77'; g2.fillRect(0, 0, 512, 512);
      g2.fillStyle = '#3e6f8c'; g2.fillRect(28, 24, 456, 464);
      g2.fillStyle = '#c5673b'; g2.fillRect(184, 24, 144, 210);
      g2.strokeStyle = '#f4f7fb'; g2.lineWidth = 6;
      g2.strokeRect(28, 24, 456, 464);
      g2.strokeRect(184, 24, 144, 210);
      g2.beginPath(); g2.arc(256, 234, 62, 0, Math.PI * 2); g2.stroke();
      g2.beginPath(); g2.arc(256, 72, 206, 0.14 * Math.PI, 0.86 * Math.PI); g2.stroke();
      g2.beginPath(); g2.moveTo(64, 24); g2.lineTo(64, 152); g2.moveTo(448, 24); g2.lineTo(448, 152); g2.stroke();
      g2.beginPath(); g2.arc(256, 488, 68, Math.PI, 0); g2.stroke();
      const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = quality === 'ultra' ? 16 : 8;
      const courtMat = new T.MeshStandardMaterial({
        map: tex,
        roughness: 0.82,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -2,
      });
      patchWeatherWetness(courtMat, weatherUniforms, {
        tier: quality,
        porosity: 0.72,
        puddleStrength: 0.64,
        puddleScale: 0.22,
        snowReceptivity: 0.68,
        wetRoughnessFloor: 0.045,
        cacheTag: 'bball-court',
      });
      patchMaterialWithEchoCsm(courtMat);
      patchHeightFog(courtMat);
      const courtGeo = new T.PlaneGeometry(11.6, 11.6); courtGeo.rotateX(-Math.PI / 2);
      const courtMesh = new T.Mesh(courtGeo, courtMat);
      const nx = Math.sin(hoop.rotY), nz = Math.cos(hoop.rotY);
      courtMesh.position.set(hoop.x + nx * 4.8, GROUND_Y + 0.016, hoop.z + nz * 4.8);
      courtMesh.rotation.y = hoop.rotY;
      courtMesh.receiveShadow = true;
      courtMesh.name = 'basketball-court-slab';
      sectorOf(courtMesh.position.z, courtMesh.position.x).add(courtMesh);
      freezeStaticHierarchy(courtMesh);
      owned.push(tex, courtMat, courtGeo);
    }
  }

  // Physical Rayleigh + Mie + 5-octave FBM sky dome (drawn at infinity, keeps Study Overview transparent!).
  group.add(atmosphere.skyMesh);

  // Sculpted downtown skyline across the river synced to FogExp2.
  const skylineView: SkylineView = buildSkylineView(city.skyline, GROUND_Y, weatherUniforms, quality);
  north.add(skylineView.mesh);
  owned.push(skylineView);

  // Core street & district wayfinding signboards.
  const boards: { at: T.Vector3; rotY: number; w: number; h: number; lines: string[]; sector: T.Group; bg?: string }[] = [];
  const lantern = city.streets.find(s => s.id === 'lantern')!.rect;
  const river = city.streets.find(s => s.id === 'riverside')!.rect;
  const marketBlvd = city.streets.find(s => s.id === 'market_blvd')?.rect;
  const campus = city.streets.find(s => s.id === 'campus')?.rect;
  const entrance = house.doors.find(d => d.id === 'entrance')!;
  boards.push({ at: new T.Vector3(entrance.x + 0.95, GROUND_Y + 1.7, house.front + 0.03), rotY: 0, w: 0.5, h: 0.32, lines: ['No. 12', 'Lantern Street'], sector: south, bg: '#1d3b4a' });
  boards.push({ at: new T.Vector3(0, GROUND_Y + 2.95, house.front + 0.075), rotY: 0, w: 3.6, h: 0.55, lines: ['Echo Bookshop'], sector: south, bg: '#2c4a3f' });
  boards.push({ at: new T.Vector3(house.footprint.x0 - 5 + 0.3, GROUND_Y + 2.6, lantern.z0 + 0.5), rotY: 0, w: 1.3, h: 0.36, lines: ['Lantern Street'], sector: south, bg: '#25507a' });
  boards.push({ at: new T.Vector3(house.footprint.x0 - 5 + 0.3, GROUND_Y + 2.6, river.z1 - 0.5), rotY: Math.PI, w: 1.4, h: 0.36, lines: ['Riverside Road'], sector: north, bg: '#25507a' });
  if (marketBlvd) {
    boards.push({ at: new T.Vector3(house.footprint.x0 - 5 + 0.3, GROUND_Y + 2.6, marketBlvd.z0 + 0.5), rotY: 0, w: 1.7, h: 0.38, lines: ['Market Boulevard'], sector: south, bg: '#25507a' });
  }
  if (campus) {
    boards.push({ at: new T.Vector3((campus.x0 + campus.x1) / 2, GROUND_Y + 2.75, campus.z1 - 0.4), rotY: 0, w: 2.2, h: 0.44, lines: ['University Square'], sector: sides, bg: '#24405a' });
  }
  for (const b of boards) {
    const tex = textBoard(b.lines, b.w, b.h, b.bg);
    const m = new T.MeshStandardMaterial({
      map: tex,
      roughness: 0.55,
      emissive: '#ffffff',
      emissiveMap: tex,
      emissiveIntensity: 0.15,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    patchMaterialWithEchoCsm(m);
    patchHeightFog(m);
    const g = new T.PlaneGeometry(b.w, b.h);
    const mesh = new T.Mesh(g, m);
    mesh.position.copy(b.at); mesh.rotation.y = b.rotY;
    b.sector.add(mesh);
    freezeStaticHierarchy(mesh);
    owned.push(tex, m, g);
  }

  // 2-draw-call GPU instanced billboard weather particles (rain + ground splashes, bokeh snow, 3D petals, autumn leaves).
  const particles = new WeatherParticleSystem(weatherUniforms, quality, GROUND_Y);
  group.add(particles.group);
  owned.push(particles);

  let currentTier: QualityTier = quality;
  const localEye = new T.Vector3();
  let lampPositions: readonly T.Vector3[] = [];
  let atmosphereDrivenThisFrame = false;

  // Fallback state driven by legacy `setDay(...)` until callers invoke `updateAtmosphere(...)` directly.
  const legacyState = {
    hour: 12,
    day: 1,
    rain: 0,
    snow: 0,
    season: 0,
    cloud: 0.12,
    outdoors: false,
    snapPending: false,
  };
  let lastWeatherBucket = 'clear';

  function resolveParticleMode(rain: number, snow: number, season: number, outdoors: boolean): { mode: WeatherParticleMode; intensity: number } {
    if (!outdoors) return { mode: 'none', intensity: 0 };
    if (rain > 0.1) return { mode: 'rain', intensity: Math.min(1.4, 0.72 + rain * 0.72) };
    if (snow > 0.1) return { mode: 'snow', intensity: Math.min(1.25, 0.70 + snow * 0.58) };
    if (currentTier !== 'low' && (season === 0 || season === 2)) {
      return { mode: season === 0 ? 'petals' : 'leaves', intensity: 0.78 };
    }
    return { mode: 'none', intensity: 0 };
  }

  function applyAtmosphereStep(
    dt: number,
    input: AtmosphereInput,
    camera: T.Camera,
    lamps: readonly T.Vector3[],
    snapOverride: boolean,
  ): AtmosphereSnapshot {
    const local = group.worldToLocal(camera.getWorldPosition(localEye));
    const snap = atmosphere.update(dt, input, local);
    weatherDynamics.step(dt, {
      rain: input.rain,
      snow: input.snow,
      day: snap.day,
      season: input.season,
      reduced: input.reduced,
      snapOverride,
    });
    skylineView.syncAtmosphere(snap, local);
    updateStreetProps(1 - snap.day);
    water.setAtmosphere(atmosphere.toWaterAtmosphere(lamps));
    water.update(dt, local, input.reduced);

    const { mode, intensity } = resolveParticleMode(input.rain, input.snow, input.season, input.outdoors);
    particles.setState({
      mode,
      intensity,
      day: snap.day,
      sunColor: snap.sunColor,
      fogColor: snap.fogColor,
      groundY: GROUND_Y,
      outdoors: input.outdoors,
      reduced: input.reduced,
    });
    particles.update(dt, local, input.reduced);
    return snap;
  }

  return {
    group,
    sectors: { north, south, sides },
    atmosphere,
    weatherUniforms,
    surfaces,
    water,
    setDay(day, rain, angle, season = 0, cloud = rain, outdoors = false, snow = 0) {
      const sIdx = Math.max(0, Math.min(3, season | 0));
      const hour = angle !== undefined
        ? (((angle * 12) / Math.PI + 6) % 24 + 24) % 24
        : day > 0.5 ? 12 : 22;
      const bucket = rain > 0.5 ? 'heavy_rain' : rain > 0.1 ? 'rain' : snow > 0.1 ? 'snow' : 'clear';
      if (bucket !== lastWeatherBucket) {
        const bigJump = Math.abs(rain - legacyState.rain) > 0.45 || Math.abs(snow - legacyState.snow) > 0.45;
        if (bigJump) legacyState.snapPending = true;
        lastWeatherBucket = bucket;
      }
      legacyState.hour = hour;
      legacyState.day = day;
      legacyState.rain = rain;
      legacyState.snow = snow;
      legacyState.season = sIdx;
      legacyState.cloud = cloud;
      legacyState.outdoors = outdoors;
    },
    updateAtmosphere(dt, input, camera, lamps, snapOverride = false) {
      atmosphereDrivenThisFrame = true;
      if (lamps) lampPositions = lamps;
      return applyAtmosphereStep(dt, input, camera, lampPositions, snapOverride);
    },
    setLampPositions(positions) {
      lampPositions = positions;
    },
    setQuality(nextTier) {
      currentTier = nextTier;
      particles.setTier(nextTier);
    },
    update(dt, reduced, camera) {
      if (atmosphereDrivenThisFrame) {
        atmosphereDrivenThisFrame = false;
        return;
      }
      const snapNow = legacyState.snapPending;
      legacyState.snapPending = false;
      applyAtmosphereStep(
        dt,
        {
          hour: legacyState.hour,
          season: legacyState.season,
          rain: legacyState.rain,
          snow: legacyState.snow,
          cloud: legacyState.cloud,
          outdoors: legacyState.outdoors,
          reduced,
        },
        camera,
        lampPositions,
        snapNow,
      );
    },
    dispose() {
      owned.forEach(o => o.dispose());
      group.removeFromParent();
    },
  };
}
