import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH, acceleratedRaycast, disposeBoundsTree } from 'three-mesh-bvh';
import type {
  ArenaIslandProfile,
  ArenaIslandSpec,
  ArenaQualityTier,
  ArenaTimeOfDay,
  SurfaceFishSchool,
} from './arenaContracts';
import { arenaArchipelagoAssets, arenaV7Assets } from './arenaAssets';
import { arenaStations } from './arenaCopy';
import { buildArchipelagoFloraPlacements } from './arenaFloraManifest';
import { buildArenaGrassSystem } from './arenaGrass';
import { arenaMaterials } from './arenaMaterials';
import { ARENA_ATMOSPHERE_PRESETS, ARENA_QUALITY_CONFIGS } from './arenaQuality';
import { buildArenaSea, type SeaWakeSource } from './arenaSea';
import { buildArenaSkyBirds } from './arenaSkyBirds';
import { yieldToMainThread, type ArenaResidencyManager } from './arenaStreaming';
import { arenaTableItems } from './arenaTableItems';
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
import { buildArenaUnderwaterWorld } from './arenaUnderwaterWorld';
import { buildArenaWaterfallSystem } from './arenaWaterfall';

interface Placement {
  x: number;
  y: number;
  z: number;
  yaw?: number;
  scale?: number;
  islandId?: string;
}

export interface ArenaWorldBuildOptions {
  quality?: ArenaQualityTier;
  timeOfDay?: ArenaTimeOfDay;
  residency?: ArenaResidencyManager;
}

interface IslandTerrainSampler {
  island: ArenaIslandSpec;
  cx: number;
  cz: number;
  maxOuterR: number;
  angularSegs: number;
  stride: number;
  radialFracs: Float32Array;
  shoreRBySeg: Float32Array;
  cosBySeg: Float32Array;
  sinBySeg: Float32Array;
  posArr: Float32Array;
  nrmArr: Float32Array;
}

/**
 * Computes deterministic 64-bit dual-FNV1a + byteLength content fingerprints for embedded
 * GLB binary images (`bufferViews`) without WASM decoders (`10-rules-frozen.md §CJ`).
 */
function extractGlbImageHashes(buffer: ArrayBuffer): string[] {
  if (buffer.byteLength < 28) return [];
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2) return [];
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLen > buffer.byteLength) return [];

  let meta: {
    images?: Array<{ bufferView?: number; uri?: string }>;
    bufferViews?: Array<{ byteOffset?: number; byteLength: number }>;
  };
  try {
    const jsonText = new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen));
    meta = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const binChunkHeader = 20 + jsonLen;
  if (binChunkHeader + 8 > buffer.byteLength) return [];
  const binChunkType = dv.getUint32(binChunkHeader + 4, true);
  if (binChunkType !== 0x004e4942) return [];
  const binStart = binChunkHeader + 8;

  const images = meta.images ?? [];
  const views = meta.bufferViews ?? [];
  const hashes = new Array<string>(images.length).fill('');

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (img.bufferView === undefined) continue;
    const bv = views[img.bufferView];
    if (!bv || bv.byteLength <= 0) continue;
    const start = binStart + (bv.byteOffset ?? 0);
    if (start < binStart || start + bv.byteLength > buffer.byteLength) continue;
    const bytes = new Uint8Array(buffer, start, bv.byteLength);
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    const stride = bytes.length > 16384 ? 4 : 1;
    for (let k = 0; k < bytes.length; k += stride) {
      const b = bytes[k];
      h1 ^= b;
      h1 = Math.imul(h1, 0x01000193);
      h2 ^= b;
      h2 = Math.imul(h2, 0x85ebca6b);
    }
    // Always mix exact head & tail bytes so subsampled buffers cannot collide
    for (let k = Math.max(0, bytes.length - 32); k < bytes.length; k++) {
      h1 = Math.imul(h1 ^ bytes[k], 0x01000193);
      h2 = Math.imul(h2 ^ bytes[k], 0xc2b2ae35);
    }
    hashes[i] = `${(h1 >>> 0).toString(16)}_${(h2 >>> 0).toString(16)}_${bytes.length}`;
  }
  return hashes;
}

export function buildArenaWorld(
  scene: T.Scene,
  lowOrOptions: boolean | ArenaWorldBuildOptions = false,
) {
  let currentTier: ArenaQualityTier =
    typeof lowOrOptions === 'boolean'
      ? lowOrOptions
        ? 'low'
        : 'high'
      : (lowOrOptions.quality ?? 'high');
  let currentTod: ArenaTimeOfDay =
    typeof lowOrOptions === 'boolean' ? 'daylight' : (lowOrOptions.timeOfDay ?? 'daylight');
  const residency = typeof lowOrOptions === 'object' ? lowOrOptions.residency : undefined;
  let low = currentTier === 'low';

  const preset0 = ARENA_ATMOSPHERE_PRESETS[currentTod];
  scene.background = new T.Color(preset0.fogColor);
  scene.fog = new T.FogExp2(preset0.fogColor, 0.00095);

  const surfaces = arenaMaterials({ quality: currentTier, timeOfDay: currentTod });
  const materials = surfaces.mats;
  type Mat = keyof typeof materials;

  const cameraBlockers: T.Object3D[] = [];
  const batches = new Map<string, { m: Mat; geometries: T.BufferGeometry[]; islandId: string }>();
  const lod: T.Object3D[] = [];
  const propObjects: T.Object3D[] = [];
  const instruments = new Map<string, T.Object3D[]>();
  let currentLitBeacons = new Set<string>(
    arenaLayout.interactables.filter(i => i.kind === 'beacon').map(i => i.id),
  );
  let beaconLitAttr: T.InstancedBufferAttribute | null = null;
  const beaconIndexById = new Map<string, number>();
  let plaqueAtlasCanvas: HTMLCanvasElement | null = null;
  let disposed = false;
  const assetTextures = new Set<T.Texture>();
  const assetGeometries = new Set<T.BufferGeometry>();
  const assetMaterials = new Set<T.Material>();
  const islandSamplers: IslandTerrainSampler[] = [];
  const center = new T.Vector3();

  // Permanent scene-level light carrier for the 3 Pearl Harbor (`commons`) beacon PointLights.
  // Keeping `light.visible = true` ALWAYS and modulating ONLY `light.intensity` prevents
  // `NUM_POINT_LIGHTS` PBR shader recompilation hitches during island streaming or quality changes!
  const lightCarrierGroup = new T.Group();
  lightCarrierGroup.name = 'ArenaConstantLightCarrier';
  scene.add(lightCarrierGroup);

  const harborBeaconLights = new Map<string, T.PointLight>();
  for (const b of arenaLayout.interactables) {
    if (b.kind !== 'beacon' || b.island !== 'commons') continue;
    const wx = b.x + 0.25 * Math.sin(b.yaw);
    const wy = arenaHeight(b.x, b.z) + 2.55;
    const wz = b.z + 0.25 * Math.cos(b.yaw);
    const pt = new T.PointLight(
      '#ffbe66',
      !low && currentLitBeacons.has(b.id) ? 2.2 : 0,
      14,
      1.8,
    );
    pt.name = `BeaconLight_${b.id}`;
    pt.position.set(wx, wy, wz);
    pt.visible = true;
    lightCarrierGroup.add(pt);
    harborBeaconLights.set(b.id, pt);
  }

  // Per-island 3-ring spatial streaming groups (`detailGroup`, `midGroup`, `hlodGroup`)
  const islandGroups = new Map<
    string,
    { detail: T.Group; mid: T.Group; hlod: T.Group }
  >();
  for (const isl of arenaLayout.islands) {
    const detail = new T.Group();
    detail.name = `IslandDetail_${isl.id}`;
    const mid = new T.Group();
    mid.name = `IslandMid_${isl.id}`;
    const hlod = new T.Group();
    hlod.name = `IslandHlod_${isl.id}`;
    scene.add(hlod, mid, detail);
    islandGroups.set(isl.id, { detail, mid, hlod });
  }

  const getIslandGroup = (islandId: string, ring: 'detail' | 'mid' | 'hlod'): T.Group | T.Scene => {
    const g = islandGroups.get(islandId);
    return g ? g[ring] : scene;
  };

  const tileGeo = new T.BoxGeometry(2.025, 0.055, 1.425);
  tileGeo.setAttribute(
    'color',
    new T.Float32BufferAttribute(new Float32Array(tileGeo.attributes.position.count * 3).fill(1), 3),
  );
  const tileMatrix = new T.Matrix4();
  const tileColor = new T.Color();

  let seed = 7321;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const vec = (x: number, y: number, z: number) => new T.Vector3(x, y, z);

  const add = (
    g: T.BufferGeometry,
    m: Mat,
    x = 0,
    y = 0,
    z = 0,
    scale = new T.Vector3(1, 1, 1),
    rotation = new T.Euler(),
    tint = 1,
    shadeAt?: (x: number, y: number, z: number) => number,
    keepUv = false,
    explicitIslandId?: string,
  ) => {
    const source = g;
    g = g.index ? g.toNonIndexed() : g.clone();
    source.dispose();
    g.applyMatrix4(new T.Matrix4().compose(vec(x, y, z), new T.Quaternion().setFromEuler(rotation), scale));
    const p = g.getAttribute('position');
    const normal = g.getAttribute('normal');
    const own = keepUv ? g.getAttribute('uv') : null;
    const uv = new Float32Array(p.count * 2);
    const colors = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const nx = Math.abs(normal.getX(i));
      const ny = Math.abs(normal.getY(i));
      const nz = Math.abs(normal.getZ(i));
      uv[i * 2] = own ? own.getX(i) : (nx > ny && nx > nz ? p.getZ(i) : p.getX(i)) * 0.28;
      uv[i * 2 + 1] = own ? own.getY(i) : (ny > nx && ny > nz ? p.getZ(i) : p.getY(i)) * 0.28;
      const shade =
        tint *
        (0.95 + 0.05 * Math.sin(p.getX(i) * 0.18 + p.getZ(i) * 0.24)) *
        (shadeAt ? shadeAt(p.getX(i), p.getY(i), p.getZ(i)) : 1);
      colors.set([shade, shade, shade], i * 3);
    }
    g.setAttribute('uv', new T.BufferAttribute(uv, 2));
    g.setAttribute('color', new T.BufferAttribute(colors, 3));
    g.computeBoundingBox();
    g.boundingBox!.getCenter(center);
    const islId = explicitIslandId ?? arenaIslandAt(center.x, center.z);
    const key = `${islId}:${m}:${Math.floor(center.x / 96)}:${Math.floor(center.z / 96)}`;
    let batch = batches.get(key);
    if (!batch) {
      batch = { m, geometries: [], islandId: islId };
      batches.set(key, batch);
    }
    batch.geometries.push(g);
  };

  const box = (m: Mat, x: number, y: number, z: number, w: number, h: number, d: number, ry = 0, tint = 1) =>
    add(new T.BoxGeometry(w, h, d), m, x, y, z, undefined, new T.Euler(0, ry, 0), tint);
  const cyl = (m: Mat, x: number, y: number, z: number, rt: number, rb: number, h: number, n = 28) =>
    add(new T.CylinderGeometry(rt, rb, h, n), m, x, y, z);
  const tube = (m: Mat, points: T.Vector3[], r: number, segments = 16) =>
    add(new T.TubeGeometry(new T.CatmullRomCurve3(points), segments, r, low ? 5 : 7, false), m);
  const ring = (m: Mat, x: number, y: number, z: number, r: number, t = 0.035) =>
    add(new T.TorusGeometry(r, t, 5, low ? 56 : 84), m, x, y, z, undefined, new T.Euler(-Math.PI / 2, 0, 0));

  const wetline = (_x: number, y: number) =>
    0.72 + 0.28 * T.MathUtils.smoothstep(y, ARENA_WATER_Y - 0.12, ARENA_WATER_Y + 0.65);

  // =========================================================================
  // 1. Continuous Analytical Bathymetry & Island Topography Meshes (All 15 Islands)
  // =========================================================================
  function buildIslandTerrain(island: ArenaIslandSpec) {
    const profile: ArenaIslandProfile = (island.profile as ArenaIslandProfile | undefined) ?? 'outer';
    const isIslet = profile === 'islet';
    const angularSegs = isIslet ? (low ? 48 : 72) : low ? 96 : 160;
    const radialFracsArr = isIslet
      ? [0, 0.16, 0.34, 0.52, 0.68, 0.82, 0.92, 0.97, 1.0, 1.12, 1.28, 1.48]
      : profile === 'atoll'
        ? [0, 0.12, 0.24, 0.34, 0.42, 0.48, 0.54, 0.60, 0.66, 0.72, 0.78, 0.84, 0.90, 0.94, 0.98, 1.0, 1.06, 1.16, 1.30, 1.48]
        : [0, 0.09, 0.18, 0.27, 0.36, 0.45, 0.54, 0.62, 0.70, 0.77, 0.83, 0.88, 0.93, 0.97, 1.0, 1.06, 1.15, 1.28, 1.45];

    const ringLen = radialFracsArr.length;
    const stride = angularSegs + 1;
    const vertCount = ringLen * stride;
    const posArr = new Float32Array(vertCount * 3);
    const uvArr = new Float32Array(vertCount * 2);
    const colArr = new Float32Array(vertCount * 3);
    const shoreRBySeg = new Float32Array(stride);
    const cosBySeg = new Float32Array(stride);
    const sinBySeg = new Float32Array(stride);
    let maxShoreR = 0;

    for (let i = 0; i <= angularSegs; i++) {
      const a = i === angularSegs ? 0 : (i / angularSegs) * Math.PI * 2;
      const sr = arenaShoreRadius(island, a);
      shoreRBySeg[i] = sr;
      cosBySeg[i] = Math.cos(a);
      sinBySeg[i] = Math.sin(a);
      if (sr > maxShoreR) maxShoreR = sr;
    }

    for (let j = 0; j < ringLen; j++) {
      const s = radialFracsArr[j];
      for (let i = 0; i <= angularSegs; i++) {
        const a = i === angularSegs ? 0 : (i / angularSegs) * Math.PI * 2;
        const shoreR = shoreRBySeg[i];
        const r = shoreR * s;
        const wx = island.x + cosBySeg[i] * r;
        const wz = island.z + sinBySeg[i] * r;
        let wy = arenaBathymetry(wx, wz);

        // Keep central Pearl Harbor plaza slightly tucked beneath marble courtyard slabs for zero Z-fighting
        if (island.id === 'commons' && r < 29.8) {
          wy -= 0.06;
        }

        const idx = j * stride + i;
        posArr[idx * 3] = wx;
        posArr[idx * 3 + 1] = wy;
        posArr[idx * 3 + 2] = wz;
        uvArr[idx * 2] = wx * 0.22;
        uvArr[idx * 2 + 1] = wz * 0.22;

        // Biome-driven vertex tint (warm coral sand near shore/beaches, lush tropical turf inland, mossy limestone on peaks)
        const bf = arenaBeachFactor(island, a);
        const wet = wetline(wx, wy);
        const aboveWater = T.MathUtils.clamp((wy - ARENA_WATER_Y) / 2.2, 0, 1);
        const sandWeight = T.MathUtils.clamp(
          Math.max(bf * (1 - T.MathUtils.smoothstep(wy, 0.2, 2.4)), 1 - T.MathUtils.smoothstep(wy, -1.6, 0.55)),
          0,
          1,
        );

        let cr = 0.94;
        let cg = 0.91;
        let cb = 0.84;

        if (profile === 'beach' || profile === 'atoll') {
          const grassBlend = aboveWater * (1 - sandWeight) * 0.72;
          cr = T.MathUtils.lerp(0.98, 0.56, grassBlend);
          cg = T.MathUtils.lerp(0.93, 0.76, grassBlend);
          cb = T.MathUtils.lerp(0.82, 0.48, grassBlend);
        } else if (profile === 'mountain') {
          const peakRock = T.MathUtils.smoothstep(wy, 9.5, 15.5);
          const lush = aboveWater * (1 - sandWeight * 0.85);
          cr = T.MathUtils.lerp(0.86, T.MathUtils.lerp(0.42, 0.62, peakRock), lush);
          cg = T.MathUtils.lerp(0.84, T.MathUtils.lerp(0.68, 0.66, peakRock), lush);
          cb = T.MathUtils.lerp(0.76, T.MathUtils.lerp(0.40, 0.58, peakRock), lush);
        } else if (profile === 'karst') {
          const crownMoss = T.MathUtils.smoothstep(wy, 2.2, 6.2) * 0.55;
          cr = T.MathUtils.lerp(0.88, 0.52, crownMoss);
          cg = T.MathUtils.lerp(0.87, 0.70, crownMoss);
          cb = T.MathUtils.lerp(0.83, 0.50, crownMoss);
        } else if (profile === 'village') {
          const villageGreen = aboveWater * (1 - sandWeight) * 0.6;
          cr = T.MathUtils.lerp(0.93, 0.62, villageGreen);
          cg = T.MathUtils.lerp(0.88, 0.74, villageGreen);
          cb = T.MathUtils.lerp(0.77, 0.52, villageGreen);
        } else {
          const meadow = aboveWater * (1 - sandWeight) * 0.58;
          cr = T.MathUtils.lerp(0.92, 0.58, meadow);
          cg = T.MathUtils.lerp(0.89, 0.74, meadow);
          cb = T.MathUtils.lerp(0.82, 0.52, meadow);
        }

        colArr[idx * 3] = cr * wet;
        colArr[idx * 3 + 1] = cg * wet;
        colArr[idx * 3 + 2] = cb * wet;
      }
    }

    const indices: number[] = [];
    for (let j = 0; j < ringLen - 1; j++) {
      for (let i = 0; i < angularSegs; i++) {
        const k = j * stride + i;
        indices.push(k, k + 1, k + stride, k + 1, k + stride + 1, k + stride);
      }
    }

    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(posArr, 3));
    geo.setAttribute('uv', new T.BufferAttribute(uvArr, 2));
    geo.setAttribute('color', new T.BufferAttribute(colArr, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.boundsTree = new MeshBVH(geo);

    const nrmAttr = geo.getAttribute('normal') as T.BufferAttribute;
    islandSamplers.push({
      island,
      cx: island.x,
      cz: island.z,
      maxOuterR: maxShoreR * radialFracsArr[ringLen - 1],
      angularSegs,
      stride,
      radialFracs: new Float32Array(radialFracsArr),
      shoreRBySeg,
      cosBySeg,
      sinBySeg,
      posArr,
      nrmArr: nrmAttr.array as Float32Array,
    });

    const matKey: Mat =
      profile === 'beach' || profile === 'atoll'
        ? 'sand'
        : profile === 'karst'
          ? 'limestone'
          : profile === 'mountain'
            ? 'mossRock'
            : 'stone';

    const mesh = new T.Mesh(geo, materials[matKey]);
    mesh.receiveShadow = true;
    mesh.castShadow = !low && (profile === 'karst' || profile === 'mountain');
    mesh.raycast = acceleratedRaycast;
    getIslandGroup(island.id, 'hlod').add(mesh);
    cameraBlockers.push(mesh);
    assetGeometries.add(geo);
  }

  for (const island of arenaLayout.islands) {
    buildIslandTerrain(island);
  }

  /**
   * Zero-GC, zero-raycast visual ground height & smooth surface normal sampler:
   * - Evaluates exact visual bridge (`archPeak = 0.25`) & dock ramp deck height + slope normal
   *   (respecting `referenceY` so swimmers beneath bridges/piers sample the seafloor below).
   * - Evaluates Pearl Harbor (`commons`) courtyard pavers (`+0.0315 m` / `+0.050 m` medallions).
   * - Evaluates exact closed-form barycentric height & Phong-interpolated normal on the actual
   *   rendered GPU island terrain triangles (excluding benches, tables, railings, and props!).
   */
  const sampleGroundSurface = (
    x: number,
    z: number,
    outNormal?: T.Vector3,
    referenceY?: number,
  ): number => {
    // 1. Walkable timber bridges (`archPeak = 0.25` — 0.000 mm match with `arenaTerrain.ts:306`)
    for (let bi = 0; bi < arenaLayout.bridges.length; bi++) {
      const b = arenaLayout.bridges[bi];
      const dx = b.bx - b.ax;
      const dz = b.bz - b.az;
      const len2 = dx * dx + dz * dz;
      if (len2 <= 1e-6) continue;
      const t = T.MathUtils.clamp(((x - b.ax) * dx + (z - b.az) * dz) / len2, 0, 1);
      const px = b.ax + t * dx;
      const pz = b.az + t * dz;
      const dist2 = (x - px) * (x - px) + (z - pz) * (z - pz);
      const halfW = b.width * 0.5;
      if (dist2 <= halfW * halfW) {
        const deckY = b.ah + (b.bh - b.ah) * t + Math.sin(t * Math.PI) * 0.25;
        if (referenceY === undefined || referenceY >= deckY - 1.1) {
          if (outNormal) {
            const len = Math.sqrt(len2);
            const ux = dx / len;
            const uz = dz / len;
            const dhds = (b.bh - b.ah + 0.25 * Math.PI * Math.cos(t * Math.PI)) / len;
            const nx = -ux * dhds;
            const nz = -uz * dhds;
            const invL = 1 / Math.hypot(nx, 1, nz);
            outNormal.set(nx * invL, invL, nz * invL);
          }
          return deckY;
        }
      }
    }

    // 2. Walkable coastal piers / docks (`0.08 m` planks centered at `h - 0.04` -> top === `h`)
    for (let di = 0; di < arenaLayout.docks.length; di++) {
      const d = arenaLayout.docks[di];
      const dx = d.bx - d.ax;
      const dz = d.bz - d.az;
      const len2 = dx * dx + dz * dz;
      if (len2 <= 1e-6) continue;
      const t = T.MathUtils.clamp(((x - d.ax) * dx + (z - d.az) * dz) / len2, 0, 1);
      const px = d.ax + t * dx;
      const pz = d.az + t * dz;
      const dist2 = (x - px) * (x - px) + (z - pz) * (z - pz);
      const halfW = d.width * 0.5;
      if (dist2 <= halfW * halfW) {
        const ramp = t <= 0.12 ? 0 : t >= 0.76 ? 1 : (t - 0.12) / 0.64;
        const s = ramp * ramp * (3 - 2 * ramp);
        const deckY = d.ah + (d.bh - d.ah) * s;
        if (referenceY === undefined || referenceY >= deckY - 1.1) {
          if (outNormal) {
            const len = Math.sqrt(len2);
            const ux = dx / len;
            const uz = dz / len;
            const dsdt = t > 0.12 && t < 0.76 ? (6 * ramp * (1 - ramp)) / 0.64 : 0;
            const dhds = ((d.bh - d.ah) * dsdt) / len;
            const nx = -ux * dhds;
            const nz = -uz * dhds;
            const invL = 1 / Math.hypot(nx, 1, nz);
            outNormal.set(nx * invL, invL, nz * invL);
          }
          return deckY;
        }
      }
    }

    // 3. Pearl Harbor (`commons`) marble courtyard slabs (`+0.0315 m`) & compass medallions (`+0.050 m`)
    const rCommons2 = x * x + z * z;
    if (rCommons2 <= 29.6 * 29.6) {
      const rCommons = Math.sqrt(rCommons2);
      const leftMed2 = (x + 7) * (x + 7) + z * z;
      const rightMed2 = (x - 7) * (x - 7) + z * z;
      if (rCommons <= 4.22 || leftMed2 <= 2.32 * 2.32 || rightMed2 <= 2.32 * 2.32) {
        outNormal?.set(0, 1, 0);
        return 0.05;
      }
      if (rCommons <= 29.2) {
        outNormal?.set(0, 1, 0);
        return 0.0315;
      }
      const edgeBlend = T.MathUtils.clamp((29.6 - rCommons) / 0.4, 0, 1);
      const smoothEdge = edgeBlend * edgeBlend * (3 - 2 * edgeBlend);
      outNormal?.set(0, 1, 0);
      return smoothEdge * 0.0315;
    }

    // 4. Exact O(1) barycentric interpolation on rendered polar island BufferGeometries
    const TWO_PI = Math.PI * 2;
    let bestY = -Infinity;
    let bestNx = 0;
    let bestNy = 1;
    let bestNz = 0;
    let hitIslandMesh = false;

    for (let si = 0; si < islandSamplers.length; si++) {
      const smp = islandSamplers[si];
      const dx = x - smp.cx;
      const dz = z - smp.cz;
      const r2 = dx * dx + dz * dz;
      if (r2 > smp.maxOuterR * smp.maxOuterR) continue;

      if (r2 < 1e-8) {
        const y0 = smp.posArr[1];
        if (y0 > bestY) {
          bestY = y0;
          bestNx = smp.nrmArr[0];
          bestNy = smp.nrmArr[1];
          bestNz = smp.nrmArr[2];
          hitIslandMesh = true;
        }
        continue;
      }

      let ang = Math.atan2(dz, dx);
      if (ang < 0) ang += TWO_PI;
      const seg = Math.min(smp.angularSegs - 1, Math.floor((ang / TWO_PI) * smp.angularSegs));

      const r0 = smp.shoreRBySeg[seg];
      const r1 = smp.shoreRBySeg[seg + 1];
      const q0x = r0 * smp.cosBySeg[seg];
      const q0z = r0 * smp.sinBySeg[seg];
      const q1x = r1 * smp.cosBySeg[seg + 1];
      const q1z = r1 * smp.sinBySeg[seg + 1];
      const det = q0x * q1z - q0z * q1x;
      if (Math.abs(det) <= 1e-8) continue;

      const invDet = 1 / det;
      const alpha = Math.max(0, (dx * q1z - dz * q1x) * invDet);
      const beta = Math.max(0, (q0x * dz - q0z * dx) * invDet);
      const s = alpha + beta;
      const fracs = smp.radialFracs;
      const maxFrac = fracs[fracs.length - 1];
      if (s > maxFrac) continue;

      let j = 0;
      while (j < fracs.length - 2 && fracs[j + 1] < s) {
        j += 1;
      }
      const s0 = fracs[j];
      const s1 = fracs[j + 1];
      const ds = Math.max(1e-6, s1 - s0);
      const k = j * smp.stride + seg;

      let v0: number;
      let v1: number;
      let v2: number;
      let w0: number;
      let w1: number;
      let w2: number;

      if (s0 > 1e-6 && alpha / s1 + beta / s0 <= 1) {
        // Triangle 1: (k, k + 1, k + stride) -> (s0*q0, s0*q1, s1*q0)
        v0 = k;
        v1 = k + 1;
        v2 = k + smp.stride;
        w1 = beta / s0;
        w2 = (alpha - (1 - w1) * s0) / ds;
        w0 = 1 - w1 - w2;
      } else {
        // Triangle 2: (k + 1, k + stride + 1, k + stride) -> (s0*q1, s1*q1, s1*q0)
        v0 = k + 1;
        v1 = k + smp.stride + 1;
        v2 = k + smp.stride;
        w2 = s1 > 1e-6 ? alpha / s1 : 0;
        w1 = (beta - (1 - w2) * s0) / ds;
        w0 = 1 - w1 - w2;
      }

      const triY =
        w0 * smp.posArr[v0 * 3 + 1] +
        w1 * smp.posArr[v1 * 3 + 1] +
        w2 * smp.posArr[v2 * 3 + 1];

      if (triY > bestY) {
        bestY = triY;
        if (outNormal) {
          bestNx =
            w0 * smp.nrmArr[v0 * 3] +
            w1 * smp.nrmArr[v1 * 3] +
            w2 * smp.nrmArr[v2 * 3];
          bestNy =
            w0 * smp.nrmArr[v0 * 3 + 1] +
            w1 * smp.nrmArr[v1 * 3 + 1] +
            w2 * smp.nrmArr[v2 * 3 + 1];
          bestNz =
            w0 * smp.nrmArr[v0 * 3 + 2] +
            w1 * smp.nrmArr[v1 * 3 + 2] +
            w2 * smp.nrmArr[v2 * 3 + 2];
        }
        hitIslandMesh = true;
      }
    }

    if (hitIslandMesh) {
      for (const pav of ARENA_PAVILIONS) {
        const outerR = 4.2 * pav.scale;
        const dx = x - pav.x;
        const dz = z - pav.z;
        if (Math.abs(dx) > outerR || Math.abs(dz) > outerR) continue;
        const d = Math.hypot(dx, dz);
        if (d >= outerR) continue;
        const slabY = pav.base + 0.245 * pav.scale;
        const t = T.MathUtils.clamp((outerR - d) / (0.85 * pav.scale), 0, 1);
        const smoothT = t * t * (3 - 2 * t);
        const liftedY = bestY + Math.max(0, slabY - bestY) * smoothT;
        if (liftedY > bestY) {
          bestY = liftedY;
          if (t >= 0.98) {
            bestNx = 0;
            bestNy = 1;
            bestNz = 0;
          }
        }
      }
      if (outNormal) {
        const invL = 1 / (Math.hypot(bestNx, bestNy, bestNz) || 1);
        outNormal.set(bestNx * invL, bestNy * invL, bestNz * invL);
      }
      return bestY;
    }

    // 5. Open-ocean bathymetry fallback
    const ySea = arenaBathymetry(x, z);
    if (outNormal) {
      const e = 0.35;
      const nx = arenaBathymetry(x - e, z) - arenaBathymetry(x + e, z);
      const ny = 2 * e;
      const nz = arenaBathymetry(x, z - e) - arenaBathymetry(x, z + e);
      const invL = 1 / (Math.hypot(nx, ny, nz) || 1);
      outNormal.set(nx * invL, ny * invL, nz * invL);
    }
    return ySea;
  };

  // Pearl Harbor (`commons`) central marble courtyard slabs, bronze compass inlays & colonnade
  {
    const plazaR = 30.8;
    cyl('slate', 0, -0.28, 0, plazaR, plazaR + 0.25, 0.44, 72);
    const sectors = new Map<string, T.Vector3[]>();
    for (let row = -Math.ceil(plazaR / 1.45); row <= plazaR / 1.45; row++) {
      for (let col = -Math.ceil(plazaR / 2.05); col <= plazaR / 2.05; col++) {
        const px = col * 2.05 + (row % 2) * 1.025;
        const pz = row * 1.45;
        if (Math.hypot(px, pz) > plazaR - 1.2) continue;
        const sector = `${Math.floor(px / 24)}:${Math.floor(pz / 24)}`;
        const cells = sectors.get(sector) ?? [];
        cells.push(vec(px, 0.004, pz));
        sectors.set(sector, cells);
      }
    }
    for (const cells of sectors.values()) {
      const tiles = new T.InstancedMesh(tileGeo, materials.stone, cells.length);
      cells.forEach((p, index) => {
        tiles.setMatrixAt(index, tileMatrix.makeTranslation(p.x, p.y, p.z));
        const distCenter = Math.hypot(p.x, p.z);
        const band = Math.abs(distCenter - 16.5) < 1.1 || Math.abs(distCenter - 27.5) < 1.1;
        const shade = 0.9 + rand() * 0.12;
        if (band) tileColor.setRGB(shade * 0.95, shade * 0.91, shade * 0.83);
        else tileColor.setRGB(shade, shade * (0.98 + rand() * 0.02), shade * (0.95 + rand() * 0.03));
        tiles.setColorAt(index, tileColor);
      });
      tiles.computeBoundingSphere();
      tiles.receiveShadow = true;
      getIslandGroup('commons', 'detail').add(tiles);
      tiles.userData.center = tiles.boundingSphere!.center;
      lod.push(tiles);
    }

    cyl('teal', 0, 0.038, 0, 4.2, 4.2, 0.024, 72);
    ring('bronze', 0, 0.062, 0, 4.28, 0.045);
    ring('chalk', 0, 0.058, 0, 4.6, 0.04);
    ring('bronze', 0, 0.055, 0, 16.5, 0.03);
    ring('bronze', 0, 0.055, 0, 27.5, 0.03);
    for (let j = 0; j < 24; j++) {
      const a = (j / 24) * Math.PI * 2;
      box('bronze', Math.sin(a) * 3.8, 0.064, Math.cos(a) * 3.8, 0.035, 0.018, j % 2 ? 0.2 : 0.48, a);
    }
    for (const side of [-1, 1]) {
      cyl(side < 0 ? 'coral' : 'teal', side * 7, 0.038, 0, 2.3, 2.3, 0.024, 56);
      ring('bronze', side * 7, 0.06, 0, 2.4);
    }
  }

  // =========================================================================
  // 2. Arched Coastal Timber Bridges & 11 Walkable Piers (Exact Terrain Match)
  // =========================================================================
  for (const b of arenaLayout.bridges) {
    const length = Math.hypot(b.bx - b.ax, b.bz - b.az);
    const angle = Math.atan2(b.bx - b.ax, b.bz - b.az);
    const archPeak = 0.25;
    const n = Math.ceil(length / 0.42);
    for (let j = 0; j <= n; j++) {
      const t = j / n;
      const x = T.MathUtils.lerp(b.ax, b.bx, t);
      const z = T.MathUtils.lerp(b.az, b.bz, t);
      const h = b.ah + (b.bh - b.ah) * t + Math.sin(t * Math.PI) * archPeak;
      box('wood', x, h - 0.055, z, b.width, 0.11, length / n - 0.018, angle, 0.84 + rand() * 0.16);
      if (j % 6 === 0) {
        for (const side of [-1, 1]) {
          const px = x + Math.cos(angle) * side * (b.width / 2 - 0.06);
          const pz = z - Math.sin(angle) * side * (b.width / 2 - 0.06);
          cyl('slate', px, h + 0.5, pz, 0.07, 0.09, 1.05, 8);
          box('bronze', px, h + 1.04, pz, 0.16, 0.07, 0.16, angle);
        }
      }
    }
    for (let j = 1; j < 7; j++) {
      const t = j / 7;
      const x = T.MathUtils.lerp(b.ax, b.bx, t);
      const z = T.MathUtils.lerp(b.az, b.bz, t);
      const h = b.ah + (b.bh - b.ah) * t + Math.sin(t * Math.PI) * archPeak;
      const bed = Math.min(ARENA_WATER_Y - 2.4, arenaBathymetry(x, z) - 0.5);
      for (const side of [-1, 1]) {
        const px = x + Math.cos(angle) * side * (b.width / 2 - 0.22);
        const pz = z - Math.sin(angle) * side * (b.width / 2 - 0.22);
        cyl('wood', px, (h - 0.1 + bed) * 0.5, pz, 0.15, 0.18, h - 0.1 - bed, 10);
      }
      box('wood', x, h - 0.2, z, b.width - 0.12, 0.16, 0.22, angle, 0.8);
    }
    for (const side of [-1, 1]) {
      const points: T.Vector3[] = [];
      for (let j = 0; j <= 10; j++) {
        const t = j / 10;
        points.push(
          vec(
            T.MathUtils.lerp(b.ax, b.bx, t) + Math.cos(angle) * side * (b.width / 2 - 0.06),
            b.ah + (b.bh - b.ah) * t + Math.sin(t * Math.PI) * archPeak + 0.9,
            T.MathUtils.lerp(b.az, b.bz, t) - Math.sin(angle) * side * (b.width / 2 - 0.06),
          ),
        );
      }
      tube('wood', points, 0.052, 24);
    }
  }

  for (const d of arenaLayout.docks) {
    const length = Math.hypot(d.bx - d.ax, d.bz - d.az);
    const angle = Math.atan2(d.bx - d.ax, d.bz - d.az);
    const plankCount = Math.ceil(length / 0.36);
    for (let j = 0; j <= plankCount; j++) {
      const t = j / plankCount;
      const ramp = t <= 0.12 ? 0 : t >= 0.76 ? 1 : (t - 0.12) / 0.64;
      const s = ramp * ramp * (3 - 2 * ramp);
      const h = d.ah + (d.bh - d.ah) * s;
      const x = T.MathUtils.lerp(d.ax, d.bx, t);
      const z = T.MathUtils.lerp(d.az, d.bz, t);
      box('wood', x, h - 0.04, z, d.width, 0.08, length / plankCount - 0.022, angle, 0.85 + rand() * 0.15);
      if (j % 7 === 2 || j === plankCount) {
        for (const side of [-1, 1]) {
          const px = x + Math.cos(angle) * side * (d.width / 2 + 0.06);
          const pz = z - Math.sin(angle) * side * (d.width / 2 + 0.06);
          const pileTop = h + 0.48;
          const pileBottom = Math.min(-3.4, arenaBathymetry(px, pz) - 0.6);
          cyl('wood', px, (pileTop + pileBottom) / 2, pz, 0.12, 0.14, pileTop - pileBottom, 10);
          cyl('bronze', px, pileTop + 0.025, pz, 0.08, 0.14, 0.05, 10);
        }
      }
    }
    // Dock swimmer climb-out ladder on the outer seaward tip
    {
      const lx = d.bx + Math.cos(angle) * (d.width / 2 + 0.06);
      const lz = d.bz - Math.sin(angle) * (d.width / 2 + 0.06);
      for (const railOff of [-0.22, 0.22]) {
        const rx = lx + Math.sin(angle) * railOff;
        const rz = lz + Math.cos(angle) * railOff;
        cyl('bronze', rx, d.bh - 0.45, rz, 0.026, 0.026, 1.55, 8);
      }
      for (let rung = 0; rung < 4; rung++) {
        box('bronze', lx, d.bh - 1.05 + rung * 0.34, lz, 0.05, 0.035, 0.44, angle);
      }
    }
  }

  // =========================================================================
  // 3. Furniture, Benches, Lanterns, Planters, Tables & Shore Rocks
  // =========================================================================
  function bench(x: number, z: number, angle: number) {
    const h = arenaHeight(x, z);
    const local = (xx: number, zz: number) => ({
      x: x + Math.cos(angle) * xx + Math.sin(angle) * zz,
      z: z - Math.sin(angle) * xx + Math.cos(angle) * zz,
    });
    for (let i = 0; i < 5; i++) {
      const p = local(0, (i - 2) * 0.15);
      box('wood', p.x, h + 0.49, p.z, 2, 0.075, 0.12, angle, 0.9 + rand() * 0.1);
    }
    for (const xx of [-0.76, 0.76]) {
      const p = local(xx, 0);
      box('slate', p.x, h + 0.25, p.z, 0.13, 0.5, 0.72, angle);
    }
    for (let i = 0; i < 3; i++) {
      const p = local(0, 0.36);
      box('wood', p.x, h + 0.8 + i * 0.17, p.z, 2, 0.12, 0.07, angle);
    }
  }

  function lantern(x: number, z: number) {
    const h = arenaHeight(x, z);
    cyl('slate', x, h + 0.12, z, 0.22, 0.3, 0.24, 8);
    cyl('bronze', x, h + 1.1, z, 0.045, 0.065, 1.95, 8);
    box('lamp', x, h + 2.12, z, 0.18, 0.3, 0.18);
    cyl('bronze', x, h + 2.32, z, 0, 0.26, 0.14, 4);
  }

  function boulder(k: (typeof arenaLayout.rocks)[number]) {
    const g = new T.IcosahedronGeometry(1, low ? 1 : 2);
    const p = g.getAttribute('position');
    const r0 = rand() * 9;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      const bump =
        1 +
        0.18 * Math.sin(x * 3.1 + r0) * Math.sin(z * 2.7 - r0) +
        0.09 * Math.sin(y * 5.3 + x * 2 + r0);
      p.setXYZ(i, x * bump, Math.min(y, 0.62) * bump, z * bump);
    }
    g.computeVertexNormals();
    const tall = k.h + 0.55;
    add(
      g,
      'rock',
      k.x,
      ARENA_WATER_Y + k.h - tall * 0.62,
      k.z,
      vec(k.r * 1.02, tall, k.r * 0.92),
      new T.Euler(0, rand() * Math.PI * 2, (rand() - 0.5) * 0.22),
      0.82 + rand() * 0.2,
      wetline,
    );
  }

  for (const o of arenaLayout.obstacles) {
    if (o.kind === 'planter') {
      const h = arenaHeight(o.x, o.z);
      const r = o.radius - 0.15;
      cyl('stone', o.x, h + 0.18, o.z, r, r + 0.1, 0.36, 32);
      cyl('soil', o.x, h + 0.37, o.z, r - 0.18, r - 0.18, 0.05, 32);
      ring('chalk', o.x, h + 0.37, o.z, r - 0.06, 0.08);
    } else if (o.kind === 'lantern') {
      lantern(o.x, o.z);
    } else if (o.kind === 'palm') {
      const h = arenaHeight(o.x, o.z);
      cyl('stone', o.x, h + 0.18, o.z, 1.35, 1.45, 0.36, 20);
      cyl('soil', o.x, h + 0.37, o.z, 1.2, 1.2, 0.05, 20);
    }
  }

  for (const f of arenaLayout.furniture) {
    if (f.kind === 'bench') {
      bench(f.x, f.z, f.yaw);
    } else if (f.kind === 'tier') {
      const y = arenaHeight(f.x, f.z) + f.top;
      box('slate', f.x, y - 0.27, f.z, f.width - 0.15, 0.36, 0.7, f.yaw);
      box('stone', f.x, y - 0.06, f.z, f.width, 0.12, f.depth, f.yaw);
    } else if (f.kind === 'table') {
      const h = arenaHeight(f.x, f.z);
      cyl('slate', f.x, h + 0.4, f.z, 0.08, 0.32, 0.8, 12);
      cyl('wood', f.x, h + 0.84, f.z, 0.7, 0.7, 0.09, 28);
      cyl('bronze', f.x + 0.32, h + 0.93, f.z - 0.12, 0.11, 0.12, 0.05, 14);
    }
  }

  for (const k of arenaLayout.rocks) {
    boulder(k);
  }

  const tableItems = arenaTableItems(scene);

  // Merge static architectural sector batches per island and build MeshBVH
  for (const { m: key, geometries, islandId } of batches.values()) {
    const merged = mergeGeometries(geometries, false);
    geometries.forEach(g => g.dispose());
    if (!merged) continue;
    const mesh = new T.Mesh(merged, materials[key]);
    mesh.receiveShadow = true;
    mesh.castShadow = !low && key !== 'glow' && key !== 'lamp' && key !== 'rock' && key !== 'sand';
    getIslandGroup(islandId, key === 'rock' ? 'hlod' : 'mid').add(mesh);
    assetGeometries.add(merged);
    if (!['leaf', 'lightLeaf', 'glow', 'lamp', 'flower'].includes(key)) {
      merged.boundsTree = new MeshBVH(merged);
      mesh.raycast = acceleratedRaycast;
      cameraBlockers.push(mesh);
    }
  }

  // =========================================================================
  // 4. Green Mountain (`green_mountain`) Terrain-Conforming Waterfall, Slope Grass & Sky Birds
  // =========================================================================
  let seaRef: ReturnType<typeof buildArenaSea> | null = null;
  const waterfall = buildArenaWaterfallSystem({
    parentGroup: getIslandGroup('green_mountain', 'mid'),
    rockGroup: getIslandGroup('green_mountain', 'hlod'),
    quality: currentTier,
    timeOfDay: currentTod,
    sampleGround: sampleGroundSurface,
    onOceanOutflowSplash: (wx, wz, strength) => {
      seaRef?.triggerSurfaceSplash(wx, wz, strength, 2.8);
    },
  });
  const waterfallPos = waterfall.waterfallPos;
  cameraBlockers.push(waterfall.rockMesh);

  const grass = buildArenaGrassSystem({
    getIslandGroup,
    sampleGround: sampleGroundSurface,
    quality: currentTier,
    timeOfDay: currentTod,
    exclusions: waterfall.riverExclusionPoints,
  });

  const skyBirds = buildArenaSkyBirds(scene, {
    quality: currentTier,
    timeOfDay: currentTod,
  });

  // =========================================================================
  // 5. Load & GPU-Instance v7 Zero-WASM PBR Assets + Shared Plaque UV Atlas
  // =========================================================================
  const loader = new GLTFLoader();
  const pendingLoads: Promise<void>[] = [];
  const canonicalTexturesByHash = new Map<string, T.Texture>();
  const loadedGltfByUrl = new Map<string, Promise<{ scene: T.Group }>>();
  const swayedMaterials = new WeakSet<T.Material>();
  let lastSliceYieldMs = typeof performance !== 'undefined' ? performance.now() : 0;

  const maybeYieldLoadSlice = async () => {
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    if (now - lastSliceYieldMs >= 8.5) {
      await yieldToMainThread();
      lastSliceYieldMs = typeof performance !== 'undefined' ? performance.now() : 0;
    }
  };

  const trackAssetHierarchy = (root: T.Object3D) => {
    root.traverse(o => {
      const m = o as T.Mesh;
      if (!m.isMesh) return;
      assetGeometries.add(m.geometry);
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        assetMaterials.add(mat);
        for (const v of Object.values(mat)) {
          if (v instanceof T.Texture) assetTextures.add(v);
        }
      }
    });
  };

  const loadDedupedGltf = (url: string): Promise<{ scene: T.Group }> => {
    const cached = loadedGltfByUrl.get(url);
    if (cached) return cached;

    const task = (async () => {
      let gltf: {
        scene: T.Group;
        parser?: {
          associations?: Map<unknown, { textures?: number }>;
          json?: {
            textures?: Array<{
              source?: number;
              extensions?: { EXT_texture_webp?: { source?: number } };
            }>;
          };
        };
      };
      let imageHashes: string[] = [];

      if (typeof fetch === 'function') {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`GLB HTTP ${res.status}: ${url}`);
        const buf = await res.arrayBuffer();
        await maybeYieldLoadSlice();
        imageHashes = extractGlbImageHashes(buf);
        gltf = (await loader.parseAsync(buf, '')) as typeof gltf;
      } else {
        gltf = (await loader.loadAsync(url)) as typeof gltf;
      }

      await maybeYieldLoadSlice();

      if (imageHashes.length > 0 && gltf.parser?.associations && gltf.parser.json?.textures) {
        const assocMap = gltf.parser.associations;
        const texDefs = gltf.parser.json.textures;
        const texSlots = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap'] as const;

        gltf.scene.traverse(obj => {
          const mesh = obj as T.Mesh;
          if (!mesh.isMesh) return;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const mat of mats) {
            if (!mat) continue;
            const anyMat = mat as unknown as Record<string, unknown>;
            for (const slot of texSlots) {
              const tex = anyMat[slot] as T.Texture | undefined;
              if (!tex?.isTexture) continue;
              const assoc = assocMap.get(tex);
              const texIdx = assoc?.textures;
              if (texIdx === undefined) continue;
              const texDef = texDefs[texIdx];
              const imgIdx = texDef?.extensions?.EXT_texture_webp?.source ?? texDef?.source;
              if (imgIdx === undefined) continue;
              const rawHash = imageHashes[imgIdx];
              if (!rawHash) continue;

              const dedupKey = `${rawHash}|${tex.colorSpace}|${tex.flipY ? 1 : 0}|${tex.wrapS}|${tex.wrapT}|${tex.repeat.x},${tex.repeat.y}|${tex.offset.x},${tex.offset.y}`;
              const canon = canonicalTexturesByHash.get(dedupKey);
              if (canon && canon !== tex) {
                anyMat[slot] = canon;
                mat.needsUpdate = true;
                const dupImg = tex.image as { close?: () => void } | undefined;
                tex.dispose();
                if (dupImg && dupImg !== canon.image && typeof dupImg.close === 'function') {
                  try {
                    dupImg.close();
                  } catch {
                    // ignore already-closed ImageBitmap
                  }
                }
              } else if (!canon) {
                canonicalTexturesByHash.set(dedupKey, tex);
              }
            }
          }
        });
      }

      trackAssetHierarchy(gltf.scene);
      gltf.scene.updateMatrixWorld(true);
      return gltf;
    })();

    loadedGltfByUrl.set(url, task);
    return task;
  };

  const spawnV7Instanced = (
    url: string,
    placements: readonly Placement[],
    opts: {
      windAmp?: number;
      castShadow?: boolean;
      ring?: 'detail' | 'mid' | 'hlod';
      densityScale?: boolean;
      alignToSlope?: number;
      sinkY?: number;
      meshFilter?: (mesh: T.Mesh) => boolean;
    } = {},
  ) => {
    if (!placements.length) return;
    const cfg = ARENA_QUALITY_CONFIGS[currentTier];
    const effectiveList = opts.densityScale
      ? placements.filter((_, i) => (i * 37) % 100 < Math.round(cfg.foliageDensity * 100))
      : placements;
    if (!effectiveList.length) return;

    const p = loadDedupedGltf(url)
      .then(async gltf => {
        if (disposed) return;
        await maybeYieldLoadSlice();
        if (disposed) return;

        if (opts.windAmp && opts.windAmp > 0) {
          gltf.scene.traverse(o => {
            const mesh = o as T.Mesh;
            if (!mesh.isMesh) return;
            for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
              const std = m as T.MeshStandardMaterial;
              if (
                !swayedMaterials.has(std) &&
                (std.alphaTest > 0 || /leaf|frond|canopy|grass|fern|bush/i.test(std.name || mesh.name))
              ) {
                swayedMaterials.add(std);
                surfaces.applyWindSway(std, opts.windAmp!);
              }
            }
          });
        }

        // Partition placements by island so 3-ring spatial streaming controls visibility cleanly
        const byIsland = new Map<string, Placement[]>();
        for (const pl of effectiveList) {
          const isl = pl.islandId ?? arenaIslandAt(pl.x, pl.z);
          const arr = byIsland.get(isl) ?? [];
          arr.push(pl);
          byIsland.set(isl, arr);
        }

        const meshes: Array<{ mesh: T.Mesh; local: T.Matrix4 }> = [];
        gltf.scene.traverse(o => {
          const m = o as T.Mesh;
          if (m.isMesh && (!opts.meshFilter || opts.meshFilter(m))) {
            meshes.push({ mesh: m, local: m.matrixWorld.clone() });
          }
        });

        const m4 = new T.Matrix4();
        const q = new T.Quaternion();
        const yawQ = new T.Quaternion();
        const tiltQ = new T.Quaternion();
        const worldUp = new T.Vector3(0, 1, 0);
        const slopeNrm = new T.Vector3(0, 1, 0);
        const blendedUp = new T.Vector3(0, 1, 0);
        const eulerYaw = new T.Euler(0, 0, 0);
        const sc = new T.Vector3();
        const pos = new T.Vector3();
        const ringTarget = opts.ring ?? 'mid';
        const slopeAlign = opts.alignToSlope ?? 0;
        const sinkY = opts.sinkY ?? 0;

        for (const [islId, list] of byIsland) {
          const parentGroup = getIslandGroup(islId, ringTarget);
          for (const { mesh, local } of meshes) {
            const inst = new T.InstancedMesh(mesh.geometry, mesh.material, list.length);
            list.forEach((pl, idx) => {
              const s = pl.scale ?? 1;
              eulerYaw.set(0, pl.yaw ?? 0, 0);
              yawQ.setFromEuler(eulerYaw);
              if (slopeAlign > 0) {
                sampleGroundSurface(pl.x, pl.z, slopeNrm);
                blendedUp.copy(worldUp).lerp(slopeNrm, slopeAlign).normalize();
                tiltQ.setFromUnitVectors(worldUp, blendedUp);
                q.copy(tiltQ).multiply(yawQ);
              } else {
                q.copy(yawQ);
              }
              sc.set(s, s, s);
              pos.set(pl.x, pl.y + sinkY, pl.z);
              m4.compose(pos, q, sc).multiply(local);
              inst.setMatrixAt(idx, m4);
            });
            inst.instanceMatrix.needsUpdate = true;
            inst.computeBoundingSphere();
            inst.castShadow = (opts.castShadow ?? !low) && !low;
            inst.receiveShadow = true;
            parentGroup.add(inst);
            propObjects.push(inst);
          }
        }
      })
      .catch(() => {});

    pendingLoads.push(p);
  };

  // Build curated Archipelago v7 botanical & village placements across all 15 islands (aligned 1:1 with `tree_trunk` colliders)
  const {
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
  } = buildArchipelagoFloraPlacements((x, z, outN) => sampleGroundSurface(x, z, outN));

  // Spawn all 10 v7 tropical botanical species (`LOD1` used on BOTH `low` and `balanced` tiers!)
  // Trees with physical `tree_trunk` colliders NEVER set `densityScale: true` so every solid trunk stays visible on all tiers.
  const useVegLod1 = currentTier === 'low' || currentTier === 'balanced';
  const pickLod = (pair: { lod0: string; lod1: string }) => (useVegLod1 ? pair.lod1 : pair.lod0);

  spawnV7Instanced(pickLod(arenaV7Assets.vegetation.palmCoconutCurved), coconutPalms, {
    windAmp: 0.068,
    ring: 'mid',
  });
  spawnV7Instanced(pickLod(arenaV7Assets.vegetation.palmCoconutCurved), interactiveCoconutPalms, {
    windAmp: 0.068,
    ring: 'mid',
    meshFilter: mesh => {
      if (mesh.name === 'Coconut_0' || /coconut_0/i.test(mesh.name)) return false;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      return !mats.some(m => /PalmCocoCluster/i.test(m?.name || ''));
    },
  });
  spawnV7Instanced(pickLod(arenaV7Assets.vegetation.palmRoyalTall), royalPalms, {
    windAmp: 0.058,
    ring: 'mid',
  });
  spawnV7Instanced(pickLod(arenaV7Assets.vegetation.treeTropicalBanyan), banyanTrees, {
    windAmp: 0.042,
    ring: 'mid',
  });
  spawnV7Instanced(pickLod(arenaV7Assets.vegetation.treeTropicalCanopy), canopyTrees, {
    windAmp: 0.048,
    ring: 'mid',
  });
  spawnV7Instanced(pickLod(arenaV7Assets.vegetation.treeMangoFruiting), mangoTrees, {
    windAmp: 0.044,
    ring: 'detail',
  });
  spawnV7Instanced(pickLod(arenaV7Assets.vegetation.treeBananaFruiting), bananaTrees, {
    windAmp: 0.065,
    ring: 'detail',
  });
  spawnV7Instanced(pickLod(arenaV7Assets.vegetation.bushBougainvillea), bougainvilleaBushes, {
    windAmp: 0.036,
    castShadow: false,
    ring: 'detail',
    densityScale: true,
    alignToSlope: 0.35,
  });
  spawnV7Instanced(pickLod(arenaV7Assets.vegetation.bushHibiscus), hibiscusBushes, {
    windAmp: 0.036,
    castShadow: false,
    ring: 'detail',
    densityScale: true,
    alignToSlope: 0.35,
  });
  spawnV7Instanced(pickLod(arenaV7Assets.vegetation.fernTropicalCluster), fernClusters, {
    windAmp: 0.04,
    castShadow: false,
    ring: 'detail',
    densityScale: true,
    alignToSlope: 0.72,
    sinkY: -0.04,
  });
  spawnV7Instanced(pickLod(arenaV7Assets.vegetation.grassBeachDune), beachGrasses, {
    windAmp: 0.052,
    castShadow: false,
    ring: 'detail',
    densityScale: true,
    alignToSlope: 0.72,
    sinkY: -0.04,
  });
  spawnV7Instanced(pickLod(arenaV7Assets.landmarks.rockCoastalCluster), coastalRockClusters, {
    ring: 'mid',
  });

  // Landmark 1: Signature Echo Whale Bronze Monument at Pearl Harbor `(0, 0, -25)` (`6,399t/1p` zero-WASM)
  spawnV7Instanced(pickLod(arenaV7Assets.landmarks.harborWhaleMonument), [
    { x: 0, y: 0, z: -25, yaw: 0, scale: 1, islandId: 'commons' },
  ], { ring: 'hlod' });

  // Landmark 2: Ha Long Limestone Karst Spires & Sea Arch Cove (`karst_bay` & `islet_karst_arch`)
  const karstSpirePlacements: Placement[] = [
    ...arenaLayout.obstacles
      .filter(o => o.kind === 'karst_spire')
      .map((o, idx) => ({
        x: o.x,
        y: Math.max(ARENA_WATER_Y - 0.6, arenaBathymetry(o.x, o.z) - 0.4),
        z: o.z,
        yaw: idx * 1.35,
        scale: 0.92 + (idx % 3) * 0.18,
        islandId: 'karst_bay',
      })),
    { x: -308, y: ARENA_WATER_Y - 0.4, z: -218, yaw: 0.8, scale: 1.18, islandId: 'islet_karst_needle' },
    { x: -252, y: ARENA_WATER_Y - 0.5, z: -182, yaw: 2.1, scale: 1.06, islandId: 'karst_bay' },
  ];
  spawnV7Instanced(pickLod(arenaV7Assets.landmarks.karstSpireTall), karstSpirePlacements, { ring: 'hlod' });
  spawnV7Instanced(
    pickLod(arenaV7Assets.landmarks.karstArchCove),
    [{ x: -116, y: ARENA_WATER_Y - 0.35, z: -108, yaw: 0.62, scale: 1.12, islandId: 'islet_karst_arch' }],
    { ring: 'hlod' },
  );

  // Landmark 3: Outer Archipelago Lighthouse (`-305, -15`)
  const towerObs = arenaLayout.obstacles.find(o => o.kind === 'tower');
  const lx = towerObs?.x ?? -305;
  const lz = towerObs?.z ?? -15;
  spawnV7Instanced(
    pickLod(arenaV7Assets.landmarks.harborLighthouse),
    [{ x: lx, y: arenaBathymetry(lx, lz) - 0.1, z: lz, yaw: 0.45, scale: 1.05, islandId: 'lighthouse' }],
    { ring: 'hlod' },
  );

  // Landmark 4: Tropical Speaking Pavilions across destination islands (placed cleanly clear of kiosks & roads)
  const pavilionPlacements: Placement[] = [
    { x: 206, y: arenaBathymetry(206, 98), z: 98, yaw: -0.7, scale: 1.0, islandId: 'tropical_beach' },
    { x: 8, y: arenaBathymetry(8, 278), z: 278, yaw: Math.PI, scale: 0.95, islandId: 'coral_lagoon' },
    { x: -16, y: arenaBathymetry(-16, -228), z: -228, yaw: 0.35, scale: 1.0, islandId: 'green_mountain' },
    { x: 256, y: arenaBathymetry(256, -196), z: -196, yaw: 2.4, scale: 0.95, islandId: 'outer_archipelago' },
  ];
  spawnV7Instanced(pickLod(arenaV7Assets.landmarks.pavilionTropicalSpeaking), pavilionPlacements, {
    ring: 'mid',
  });

  // Landmark 5: Grounded Coastal Fishing Village Stilt Houses & Dry Market Stalls (`buildArchipelagoFloraPlacements`)
  spawnV7Instanced(pickLod(arenaV7Assets.landmarks.villageStiltHouse), stiltHousePlacements, { ring: 'mid' });
  spawnV7Instanced(pickLod(arenaV7Assets.landmarks.villageMarketStall), marketStallPlacements, { ring: 'detail' });

  // Load interactive Kiosks, Instanced Beacons, Telescopes, Signs & Mooring Bollards + Single 2048x1024 Plaque Atlas
  const propsLoad = loadDedupedGltf(arenaArchipelagoAssets.PROPS)
    .then(async gltf => {
      if (disposed) return;
      await maybeYieldLoadSlice();
      if (disposed) return;

      const spawnClassicProp = (propName: string, placements: readonly Placement[], castShadow = !low) => {
        const root = gltf.scene.getObjectByName(propName);
        if (!root || !placements.length) return;
        root.updateMatrixWorld(true);
        const rootInv = root.matrixWorld.clone().invert();
        root.traverse(obj => {
          const mesh = obj as T.Mesh;
          if (!mesh.isMesh) return;
          const localMat = rootInv.clone().multiply(mesh.matrixWorld);
          const inst = new T.InstancedMesh(mesh.geometry, mesh.material, placements.length);
          const m4 = new T.Matrix4();
          const q = new T.Quaternion();
          const sc = new T.Vector3();
          placements.forEach((pl, idx) => {
            const s = pl.scale ?? 1;
            q.setFromEuler(new T.Euler(0, pl.yaw ?? 0, 0));
            sc.set(s, s, s);
            m4.compose(new T.Vector3(pl.x, pl.y, pl.z), q, sc).multiply(localMat);
            inst.setMatrixAt(idx, m4);
          });
          inst.instanceMatrix.needsUpdate = true;
          inst.computeBoundingSphere();
          inst.castShadow = castShadow;
          inst.receiveShadow = true;
          scene.add(inst);
          propObjects.push(inst);
        });
      };

      // All 15 Distributed Speaking Kiosks with 1 shared `2048x1024` Quicksand UV Atlas + 1 `InstancedMesh` (`30` plaques)
      const kioskInteractables = arenaLayout.interactables.filter(i => i.kind === 'kiosk');
      spawnClassicProp(
        'Prop_SpeakingKiosk',
        kioskInteractables.map(i => ({ x: i.x, y: arenaHeight(i.x, i.z), z: i.z, yaw: i.yaw })),
      );

      if (typeof document !== 'undefined' && kioskInteractables.length > 0) {
        const ATLAS_W = 2048;
        const ATLAS_H = 1024;
        const COLS = 4;
        const ROWS = 4;
        const TILE_W = ATLAS_W / COLS; // 512
        const TILE_H = ATLAS_H / ROWS; // 256

        const atlasCanvas = document.createElement('canvas');
        atlasCanvas.width = ATLAS_W;
        atlasCanvas.height = ATLAS_H;
        plaqueAtlasCanvas = atlasCanvas;
        const ctx = atlasCanvas.getContext('2d');

        if (ctx) {
          ctx.fillStyle = '#0a252e';
          ctx.fillRect(0, 0, ATLAS_W, ATLAS_H);

          const validKiosks = kioskInteractables.slice(0, COLS * ROWS);
          const uvRects: number[] = [];
          const plaqueMatrices: T.Matrix4[] = [];
          const m4 = new T.Matrix4();
          const q = new T.Quaternion();
          const pos = new T.Vector3();
          const unitScale = new T.Vector3(1, 1, 1);

          const padU = 1.5 / ATLAS_W;
          const padV = 1.5 / ATLAS_H;
          const tileUSpan = 1 / COLS - 2 * padU;
          const tileVSpan = 1 / ROWS - 2 * padV;

          for (let kIdx = 0; kIdx < validKiosks.length; kIdx++) {
            const spec = validKiosks[kIdx];
            const station = arenaStations[spec.id];
            if (!station) continue;

            const col = kIdx % COLS;
            const row = Math.floor(kIdx / COLS);

            ctx.save();
            ctx.translate(col * TILE_W, row * TILE_H);
            ctx.scale(0.5, 0.5); // 1024x512 logical layout -> crisp 512x256 tile

            const glow = ctx.createLinearGradient(0, 0, 0, 512);
            glow.addColorStop(0, '#103b46');
            glow.addColorStop(1, '#0a252e');
            ctx.fillStyle = glow;
            ctx.fillRect(0, 0, 1024, 512);
            ctx.strokeStyle = '#6ee7d8';
            ctx.lineWidth = 5;
            ctx.strokeRect(16, 16, 992, 480);
            ctx.strokeStyle = 'rgba(110,231,216,0.35)';
            ctx.lineWidth = 2;
            ctx.strokeRect(30, 30, 964, 452);

            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = '#f4fbfb';
            ctx.font = '700 54px Quicksand, system-ui, sans-serif';
            ctx.fillText(station.titleEn.replace(/&/g, 'and'), 512, 114, 900);

            ctx.fillStyle = '#7dd3fc';
            ctx.font = '600 32px Quicksand, system-ui, sans-serif';
            ctx.fillText(`${station.cefr}  ·  ${station.badgeEn.replace(/&/g, 'and')}`, 512, 168, 860);

            ctx.fillStyle = 'rgba(125,211,252,0.45)';
            ctx.fillRect(280, 198, 464, 3);

            const topic = station.topics[0];
            ctx.fillStyle = '#e2f4f7';
            ctx.font = '600 38px Quicksand, system-ui, sans-serif';
            ctx.fillText(topic.headingEn.replace(/&/g, 'and'), 512, 274, 900);

            ctx.fillStyle = '#bae6fd';
            ctx.font = '500 30px Quicksand, system-ui, sans-serif';
            const phraseText = topic.phrases[0] ? `"${topic.phrases[0].replace(/&/g, 'and')}"` : '';
            ctx.fillText(phraseText, 512, 338, 900);

            ctx.beginPath();
            ctx.roundRect(262, 388, 500, 66, 33);
            ctx.fillStyle = '#2dd4bf';
            ctx.fill();
            ctx.fillStyle = '#06282d';
            ctx.font = '700 30px Quicksand, system-ui, sans-serif';
            ctx.fillText('Press E  ·  Open Speaking Station', 512, 431, 460);
            ctx.restore();

            const u0 = col / COLS + padU;
            const v0 = 1 - (row + 1) / ROWS + padV;
            const baseY = arenaHeight(spec.x, spec.z) + 1.29;

            for (const side of [-1, 1]) {
              q.setFromEuler(new T.Euler(0, spec.yaw + (side < 0 ? Math.PI : 0), 0));
              pos.set(
                spec.x + side * Math.sin(spec.yaw) * 0.068,
                baseY,
                spec.z + side * Math.cos(spec.yaw) * 0.068,
              );
              plaqueMatrices.push(m4.clone().compose(pos, q, unitScale));
              uvRects.push(u0, v0, tileUSpan, tileVSpan);
            }
          }

          const atlasTexture = new T.CanvasTexture(atlasCanvas);
          atlasTexture.colorSpace = T.SRGBColorSpace;
          atlasTexture.anisotropy = low ? 1 : 4;
          // Release the 8 MiB 2D canvas backing store immediately after GPU texture + mipmap upload!
          atlasTexture.onUpdate = () => {
            atlasCanvas.width = 0;
            atlasCanvas.height = 0;
            atlasTexture.onUpdate = null;
          };
          assetTextures.add(atlasTexture);

          const plaqueFaceGeo = new T.PlaneGeometry(1.12, 0.56);
          plaqueFaceGeo.setAttribute(
            'aPlaqueUvRect',
            new T.InstancedBufferAttribute(new Float32Array(uvRects), 4),
          );
          assetGeometries.add(plaqueFaceGeo);

          const plaqueAtlasMat = new T.MeshStandardMaterial({
            map: atlasTexture,
            roughness: 0.78,
          });
          plaqueAtlasMat.customProgramCacheKey = () => 'arena-kiosk-plaque-atlas-v1';
          plaqueAtlasMat.onBeforeCompile = shader => {
            shader.vertexShader =
              'attribute vec4 aPlaqueUvRect;\n' +
              shader.vertexShader.replace(
                '#include <uv_vertex>',
                `#include <uv_vertex>
                #ifdef USE_MAP
                  vMapUv = vMapUv * aPlaqueUvRect.zw + aPlaqueUvRect.xy;
                #endif`,
              );
          };
          assetMaterials.add(plaqueAtlasMat);

          if (plaqueMatrices.length > 0) {
            const plaqueInst = new T.InstancedMesh(plaqueFaceGeo, plaqueAtlasMat, plaqueMatrices.length);
            plaqueInst.name = 'SpeakingKioskPlaquesInstanced';
            for (let i = 0; i < plaqueMatrices.length; i++) {
              plaqueInst.setMatrixAt(i, plaqueMatrices[i]);
            }
            plaqueInst.instanceMatrix.needsUpdate = true;
            plaqueInst.computeBoundingSphere();
            plaqueInst.castShadow = false;
            plaqueInst.receiveShadow = true;
            scene.add(plaqueInst);
            propObjects.push(plaqueInst);
          }
        }
      }

      // Scenic Lookout Spyglasses
      for (const spec of arenaLayout.interactables.filter(i => i.kind === 'telescope')) {
        const first = propObjects.length;
        spawnClassicProp('Prop_ObservatoryAstrolabe', [
          { x: spec.x, y: arenaHeight(spec.x, spec.z), z: spec.z, yaw: spec.yaw },
        ]);
        instruments.set(spec.id, propObjects.slice(first));
      }

      // 10 Shared Multiplayer Toggleable Harbor Beacons — 100% GPU-Instanced (4 draw calls total vs 40 cloned meshes!)
      const beaconSpecs = arenaLayout.interactables.filter(i => i.kind === 'beacon');
      const beaconTemplate = gltf.scene.getObjectByName('Prop_HarborBeacon');
      if (beaconTemplate && beaconSpecs.length > 0) {
        beaconSpecs.forEach((b, idx) => beaconIndexById.set(b.id, idx));
        const litArray = new Float32Array(beaconSpecs.length);
        for (let i = 0; i < beaconSpecs.length; i++) {
          litArray[i] = currentLitBeacons.has(beaconSpecs[i].id) ? 1 : 0;
        }
        beaconLitAttr = new T.InstancedBufferAttribute(litArray, 1).setUsage(T.DynamicDrawUsage);

        beaconTemplate.updateMatrixWorld(true);
        const rootInv = beaconTemplate.matrixWorld.clone().invert();
        const m4 = new T.Matrix4();
        const q = new T.Quaternion();
        const unitSc = new T.Vector3(1, 1, 1);

        beaconTemplate.traverse(o => {
          const mesh = o as T.Mesh;
          if (!mesh.isMesh || Array.isArray(mesh.material)) return;
          const localMat = rootInv.clone().multiply(mesh.matrixWorld);
          const stdOrig = mesh.material as T.MeshStandardMaterial;
          const isGlass = stdOrig.name.includes('Beacon_Glass');

          let useGeo = mesh.geometry;
          let useMat: T.Material = stdOrig;
          if (isGlass) {
            useGeo = mesh.geometry.clone();
            useGeo.setAttribute('aBeaconLit', beaconLitAttr!);
            assetGeometries.add(useGeo);

            const glassMat = stdOrig.clone();
            glassMat.color.set('#ffffff');
            glassMat.emissive.set('#ffffff');
            glassMat.emissiveIntensity = 1.0;
            glassMat.customProgramCacheKey = () => 'arena-harbor-beacon-glass-inst-v1';
            glassMat.onBeforeCompile = shader => {
              shader.vertexShader =
                'attribute float aBeaconLit;\nvarying float vBeaconLit;\n' +
                shader.vertexShader.replace(
                  '#include <begin_vertex>',
                  '#include <begin_vertex>\nvBeaconLit = aBeaconLit;',
                );
              shader.fragmentShader =
                'varying float vBeaconLit;\n' +
                shader.fragmentShader
                  .replace(
                    '#include <color_fragment>',
                    `#include <color_fragment>
                    diffuseColor.rgb = mix(vec3(0.32, 0.40, 0.43), vec3(1.0, 0.88, 0.60), vBeaconLit);`,
                  )
                  .replace(
                    '#include <emissivemap_fragment>',
                    `#include <emissivemap_fragment>
                    totalEmissiveRadiance = mix(vec3(0.02, 0.03, 0.035), vec3(3.2, 2.35, 1.15), vBeaconLit);`,
                  );
            };
            assetMaterials.add(glassMat);
            useMat = glassMat;
          }

          const inst = new T.InstancedMesh(useGeo, useMat, beaconSpecs.length);
          inst.name = isGlass ? 'HarborBeaconsGlassInstanced' : `HarborBeacons_${mesh.name}`;
          for (let i = 0; i < beaconSpecs.length; i++) {
            const b = beaconSpecs[i];
            q.setFromEuler(new T.Euler(0, b.yaw, 0));
            m4.compose(new T.Vector3(b.x, arenaHeight(b.x, b.z), b.z), q, unitSc).multiply(localMat);
            inst.setMatrixAt(i, m4);
          }
          inst.instanceMatrix.needsUpdate = true;
          inst.computeBoundingSphere();
          inst.castShadow = !low && !isGlass;
          inst.receiveShadow = true;
          scene.add(inst);
          propObjects.push(inst);
        });
      }

      // Directional Fingerpost Signs & Pier Mooring Bollards
      spawnClassicProp(
        'Prop_DirectionalSign',
        arenaLayout.obstacles
          .filter(o => o.kind === 'sign')
          .map(o => ({ x: o.x, y: arenaHeight(o.x, o.z), z: o.z, yaw: o.yaw ?? 0 })),
      );

      const bollardPlacements: Placement[] = [];
      for (const d of arenaLayout.docks) {
        const dx = d.bx - d.ax;
        const dz = d.bz - d.az;
        const len = Math.hypot(dx, dz) || 1;
        const nx = -dz / len;
        const nz = dx / len;
        const yaw = Math.atan2(dx, dz);
        for (const [t, side] of [
          [0.82, 1],
          [0.95, -1],
        ] as const) {
          bollardPlacements.push({
            x: d.ax + dx * t + nx * side * (d.width / 2 - 0.32),
            y: d.bh,
            z: d.az + dz * t + nz * side * (d.width / 2 - 0.32),
            yaw,
          });
        }
      }
      spawnClassicProp('Prop_MooringBollard', bollardPlacements);

      spawnClassicProp(
        'Prop_HarborCargo',
        arenaLayout.obstacles
          .filter(o => o.kind === 'cargo')
          .map((o, idx) => ({ x: o.x, y: arenaHeight(o.x, o.z), z: o.z, yaw: idx * 0.9 })),
      );
    })
    .catch(() => {});
  pendingLoads.push(propsLoad);

  // =========================================================================
  // 6. Unified Ocean + Abyssal Garden Underwater World + Sky Lighting & IBL
  // =========================================================================
  const underwater = buildArenaUnderwaterWorld(scene, {
    quality: currentTier,
    timeOfDay: currentTod,
  });

  const sea = buildArenaSea(scene, {
    quality: currentTier,
    timeOfDay: currentTod,
    causticsTexture: underwater.causticsTexture,
    sunDirection: preset0.sunDirection,
  });
  seaRef = sea;

  surfaces.setUnderwaterUniforms({
    causticsTexture: underwater.causticsTexture,
    isFloatCaustics: true,
    sunDir: preset0.sunDirection,
  });

  const hemi = new T.HemisphereLight(preset0.hemiSkyColor, preset0.hemiGroundColor, preset0.hemiIntensity * 1.45);
  scene.add(hemi);

  const cfg0 = ARENA_QUALITY_CONFIGS[currentTier];
  const sun = new T.DirectionalLight(preset0.sunColor, preset0.sunIntensity * 1.15);
  const sunOffset = preset0.sunDirection.clone().multiplyScalar(82);
  sun.position.copy(sunOffset);
  sun.castShadow = cfg0.shadowEnabled;
  sun.shadow.mapSize.set(cfg0.shadowMapSize, cfg0.shadowMapSize);
  Object.assign(sun.shadow.camera, {
    left: -cfg0.shadowCameraExtent,
    right: cfg0.shadowCameraExtent,
    top: cfg0.shadowCameraExtent,
    bottom: -cfg0.shadowCameraExtent,
    near: 1,
    far: 210,
  });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.normalBias = 0.035;
  sun.shadow.bias = -0.00018;
  sun.shadow.radius = 2;
  scene.add(sun, sun.target);

  const rim = new T.DirectionalLight(preset0.fillColor, preset0.fillIntensity * 1.25);
  rim.position.set(28, 16, -38);
  scene.add(rim);

  // Pre-bake BOTH `'daylight'` & `'sunset'` procedural coastal sky PMREM environment maps at boot
  // so runtime Time-of-Day switches (`setTimeOfDay`) swap `scene.environment` in `0.0 ms` with ZERO
  // `USE_ENVMAP` shader recompiles!
  const envRTs: Record<ArenaTimeOfDay, T.WebGLRenderTarget | null> = {
    daylight: null,
    sunset: null,
  };
  let envInitialized = false;
  const ensureEnvironmentIBL = (renderer: T.WebGLRenderer) => {
    if (envInitialized || disposed) return;
    envInitialized = true;
    const prevAutoReset = renderer.info.autoReset;
    renderer.info.autoReset = false;
    try {
      const pmrem = new T.PMREMGenerator(renderer);
      const envScene = new T.Scene();
      const skyGeo = new T.SphereGeometry(20, 24, 16);
      const uTop = { value: new T.Color() };
      const uMid = { value: new T.Color() };
      const uHor = { value: new T.Color() };
      const uGround = { value: new T.Color('#1a6f7c') };
      const skyMat = new T.ShaderMaterial({
        side: T.BackSide,
        uniforms: { uTop, uMid, uHor, uGround },
        vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
          uniform vec3 uTop, uMid, uHor, uGround;
          varying vec3 vDir;
          void main() {
            float y = vDir.y;
            vec3 sky = y >= 0.0
              ? mix(uHor, mix(uMid, uTop, smoothstep(0.15, 0.85, y)), smoothstep(0.0, 0.35, y))
              : mix(uHor, uGround, smoothstep(0.0, -0.45, y));
            gl_FragColor = vec4(sky, 1.0);
          }
        `,
      });
      envScene.add(new T.Mesh(skyGeo, skyMat));

      for (const todKey of ['daylight', 'sunset'] as const) {
        const pAtm = ARENA_ATMOSPHERE_PRESETS[todKey];
        uTop.value.setHex(pAtm.skyZenith);
        uMid.value.setHex(pAtm.skyMid);
        uHor.value.setHex(pAtm.skyHorizon);
        uGround.value.set(todKey === 'sunset' ? '#2c4f5e' : '#1a6f7c');
        envRTs[todKey] = pmrem.fromScene(envScene, 0.03);
      }

      const activeEnv = envRTs[currentTod] ?? envRTs.daylight;
      if (activeEnv) {
        scene.environment = activeEnv.texture;
        scene.environmentIntensity = 0.65;
      }
      skyGeo.dispose();
      skyMat.dispose();
      pmrem.dispose();
    } catch {
      envRTs.daylight = null;
      envRTs.sunset = null;
    } finally {
      renderer.info.autoReset = prevAutoReset;
    }
  };

  const syncShadowForWarmup = (cam?: T.Camera) => {
    underwater.syncShadowLight(sun, cam ?? null);
  };
  (scene.userData as Record<string, unknown>).__ecArenaSyncShadow = syncShadowForWarmup;

  // Register per-island chunks with `ArenaResidencyManager` after async prop batches settle
  const readyPromise = Promise.allSettled(pendingLoads).then(() => {
    if (disposed || !residency) return;
    for (const isl of arenaLayout.islands) {
      const grp = islandGroups.get(isl.id);
      if (!grp) continue;
      residency.registerIslandChunk(
        isl.id,
        { detailGroup: grp.detail, midGroup: grp.mid, hlodGroup: grp.hlod },
        isl.id === 'commons',
      );
    }
  });

  const sunRight = new T.Vector3();
  const sunUp = new T.Vector3();
  const updateShadowBasis = () => {
    const n = sunOffset.clone().normalize();
    sunRight.set(0, 1, 0).cross(n).normalize();
    sunUp.copy(n).cross(sunRight).normalize();
  };
  updateShadowBasis();

  const applyBeaconLightIntensities = () => {
    for (const [id, pt] of harborBeaconLights) {
      pt.visible = true; // Invariant light count — never toggle visible!
      pt.intensity = !low && currentLitBeacons.has(id) ? 2.2 : 0;
    }
  };

  const setBeacons = (litIds: readonly string[]) => {
    currentLitBeacons = new Set(litIds);
    applyBeaconLightIntensities();
    if (beaconLitAttr) {
      for (const [id, idx] of beaconIndexById) {
        beaconLitAttr.setX(idx, currentLitBeacons.has(id) ? 1 : 0);
      }
      beaconLitAttr.needsUpdate = true;
    }
  };

  const setQuality = (tier: ArenaQualityTier) => {
    currentTier = tier;
    low = tier === 'low';
    const cfg = ARENA_QUALITY_CONFIGS[tier];
    sun.castShadow = cfg.shadowEnabled;
    Object.assign(sun.shadow.camera, {
      left: -cfg.shadowCameraExtent,
      right: cfg.shadowCameraExtent,
      top: cfg.shadowCameraExtent,
      bottom: -cfg.shadowCameraExtent,
    });
    sun.shadow.camera.updateProjectionMatrix();
    applyBeaconLightIntensities();
    surfaces.setQuality(tier);
    sea.setQuality(tier);
    underwater.setQuality(tier);
    waterfall.setQuality(tier);
    grass.setQuality(tier);
    skyBirds.setQuality(tier);
    sea.setCausticsTexture(underwater.causticsTexture, true);
    surfaces.setUnderwaterUniforms({ causticsTexture: underwater.causticsTexture, isFloatCaustics: true });
  };

  const setTimeOfDay = (tod: ArenaTimeOfDay) => {
    currentTod = tod;
    const pAtm = ARENA_ATMOSPHERE_PRESETS[tod];
    (scene.background as T.Color).setHex(pAtm.fogColor);
    if (scene.fog) (scene.fog as T.FogExp2).color.setHex(pAtm.fogColor);
    hemi.color.setHex(pAtm.hemiSkyColor);
    hemi.groundColor.setHex(pAtm.hemiGroundColor);
    hemi.intensity = pAtm.hemiIntensity * 1.45;
    sun.color.setHex(pAtm.sunColor);
    sun.intensity = pAtm.sunIntensity * 1.15;
    sunOffset.copy(pAtm.sunDirection).multiplyScalar(82);
    updateShadowBasis();
    rim.color.setHex(pAtm.fillColor);
    rim.intensity = pAtm.fillIntensity * 1.25;
    surfaces.setTimeOfDay(tod);
    surfaces.setUnderwaterUniforms({ sunDir: pAtm.sunDirection });
    sea.setTimeOfDay(tod);
    sea.setSunDirection(pAtm.sunDirection);
    underwater.setTimeOfDay(tod);
    waterfall.setTimeOfDay(tod);
    grass.setTimeOfDay(tod);
    skyBirds.setTimeOfDay(tod);
    const nextEnv = envRTs[tod];
    if (nextEnv) {
      scene.environment = nextEnv.texture;
    }
  };

  const warmupEnvironmentSystems = (renderer: T.WebGLRenderer, cam: T.Camera) => {
    waterfall.warmup(renderer, scene, cam);
    grass.warmup(renderer, scene, cam);
    skyBirds.warmup(renderer, scene, cam);
  };

  let prevUpdateTime = 0;
  let skyBirdsPrimed = false;

  return {
    cameraBlockers,
    tableItems,
    sun,
    sea,
    underwater,
    waterfall,
    grass,
    skyBirds,
    waterfallPos,
    oceanOutflowPos: waterfall.oceanOutflowPos,
    readyPromise,
    sampleGroundSurface,
    ensureEnvironmentIBL,
    syncShadowForWarmup,
    warmupEnvironmentSystems,
    observe(id?: string) {
      for (const [key, meshes] of instruments) {
        for (const mesh of meshes) mesh.visible = key !== id;
      }
    },
    setBeacons,
    setQuality,
    setTimeOfDay,
    update: (
      t: number,
      focus?: T.Vector3,
      wakes?: readonly SeaWakeSource[],
      surfaceSchools?: readonly SurfaceFishSchool[],
      renderer?: T.WebGLRenderer,
      camera?: T.PerspectiveCamera,
      repelPos?: T.Vector3,
      dt?: number,
    ) => {
      const stepDt =
        dt !== undefined
          ? dt
          : t > prevUpdateTime
            ? Math.min(0.05, t - prevUpdateTime)
            : 1 / 60;
      prevUpdateTime = t;

      surfaces.update(t);
      waterfall.update(t, stepDt, camera);
      grass.update(t, camera);
      if (stepDt > 0 || !skyBirdsPrimed) {
        skyBirds.update(stepDt > 0 ? stepDt : 1 / 60, t, camera);
        skyBirdsPrimed = true;
      }

      if (camera) {
        // Hide atmospheric sky dome below WATER_Y - 0.15 where AbyssalSubmergedBackdropDome & sea ceiling take over
        sea.skyDome.visible = camera.position.y >= ARENA_WATER_Y - 0.15;
      }

      if (renderer && camera) {
        ensureEnvironmentIBL(renderer);
        underwater.update(t, renderer, camera, {
          sunDir: ARENA_ATMOSPHERE_PRESETS[currentTod].sunDirection,
          sunLight: sun,
          repelPos,
          repelRadius: 4.8,
        });
        sea.setCausticsTexture(underwater.causticsTexture, true);
        surfaces.setUnderwaterUniforms({ causticsTexture: underwater.causticsTexture, isFloatCaustics: true });
      }

      const activeSchools = surfaceSchools && surfaceSchools.length > 0
        ? surfaceSchools
        : underwater.getSurfaceFishSchools(t);
      sea.update(t, wakes, focus, activeSchools);

      if (focus) {
        const baseLodDist = low ? 70 : 120;
        const onDistSq = baseLodDist * baseLodDist;
        const offDistSq = (baseLodDist + 14) * (baseLodDist + 14);
        for (const mesh of lod) {
          const d2 = mesh.userData.center.distanceToSquared(focus);
          mesh.visible = mesh.visible ? d2 < offDistSq : d2 < onDistSq;
        }
        const cfg = ARENA_QUALITY_CONFIGS[currentTier];
        const texel = (cfg.shadowCameraExtent * 2) / Math.max(1, sun.shadow.mapSize.x);
        const sx = sunRight.dot(focus);
        const sy = sunUp.dot(focus);
        sun.target.position
          .copy(focus)
          .addScaledVector(sunRight, Math.round(sx / texel) * texel - sx)
          .addScaledVector(sunUp, Math.round(sy / texel) * texel - sy);
        sun.position.copy(sun.target.position).add(sunOffset);
      }
    },
    renderScene: (renderer: T.WebGLRenderer, camera: T.PerspectiveCamera) => {
      const prevAutoReset = renderer.info.autoReset;
      renderer.info.reset();
      renderer.info.autoReset = false;
      try {
        if (currentTier === 'low') {
          renderer.render(scene, camera);
          return;
        }
        const shadowDepth = sun.shadow?.map?.depthTexture ?? null;
        const grotto = currentTod === 'sunset' ? 0.24 : 0.06;
        if (shadowDepth && sun.castShadow) {
          underwater.godRays.renderSceneWithGodRays(
            renderer,
            scene,
            camera,
            ARENA_ATMOSPHERE_PRESETS[currentTod].sunDirection,
            shadowDepth,
            sun.shadow.matrix,
            true,
            grotto,
          );
        } else {
          renderer.render(scene, camera);
        }
      } finally {
        renderer.info.autoReset = prevAutoReset;
      }
    },
    dispose: () => {
      disposed = true;
      seaRef = null;
      if ((scene.userData as Record<string, unknown>).__ecArenaSyncShadow === syncShadowForWarmup) {
        delete (scene.userData as Record<string, unknown>).__ecArenaSyncShadow;
      }
      waterfall.dispose();
      grass.dispose();
      skyBirds.dispose();
      tableItems.dispose();
      scene.environment = null;
      for (const todKey of ['daylight', 'sunset'] as const) {
        envRTs[todKey]?.dispose();
        envRTs[todKey] = null;
      }
      if (plaqueAtlasCanvas) {
        plaqueAtlasCanvas.width = 0;
        plaqueAtlasCanvas.height = 0;
        plaqueAtlasCanvas = null;
      }
      scene.remove(lightCarrierGroup);
      harborBeaconLights.forEach(pt => pt.dispose());
      harborBeaconLights.clear();
      beaconIndexById.clear();
      beaconLitAttr = null;
      loadedGltfByUrl.clear();
      canonicalTexturesByHash.clear();
      for (const o of cameraBlockers) {
        const geo = (o as T.Mesh).geometry;
        if (geo?.boundsTree) disposeBoundsTree.call(geo);
      }
      for (const p of propObjects) {
        p.parent?.remove(p);
      }
      for (const tex of assetTextures) tex.dispose();
      for (const mat of assetMaterials) mat.dispose();
      for (const geo of assetGeometries) geo.dispose();
      assetTextures.clear();
      assetMaterials.clear();
      assetGeometries.clear();
      tileGeo.dispose();
      surfaces.dispose();
      sea.dispose();
      underwater.dispose();
    },
  };
}
