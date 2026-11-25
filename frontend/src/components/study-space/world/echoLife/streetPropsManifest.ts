import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  demotePlainPhysicalMaterial,
  installGltfTextureDedupPlugin,
  retainDedupTexture,
  type GltfMaterialDefLike,
  type GltfParserLike,
} from './assets';
import { patchHeightFog } from './atmosphere';
import { getInFlightCompileCount, patchMaterialWithEchoCsm } from './echoCsm';
import { getEchoLifeLoadScheduler, getEchoLifeTextureUploadQueue, LoadPriority } from './loadScheduler';
import { getEchoLifeResidencyManager } from './residencyManager';

/**
 * Echo Life AAA Evolution — Staged Poly Haven CC0 & Blender 4.2 Cycles OptiX Streetscape & Interior Prop Registry.
 *
 * All GLBs under `/echo-life/props/` and `/echo-life/aaa-v2/` are standard glTF 2.0 + `EXT_texture_webp` +
 * `KHR_mesh_quantization` (ZERO WASM decoders), grounded flush at `Y = 0` (`minY ≈ 0`), centered at `X = 0, Z = 0`,
 * scaled to real-world metric proportions, and recorded with full CC0-1.0 / Project-Owned SHA-256 provenance.
 *
 * Every loaded prop automatically:
 * - Unpacks `KHR_mesh_quantization` / `InterleavedBufferAttribute` attributes to Float32 before transforms/merging.
 * - Strips `KHR_materials_transmission` (`transmission = 0`) into physical Fresnel glass so `renderTransmissionPass()`
 *   is NEVER triggered outdoors or indoors.
 * - Computes tight per-batch `InstancedMesh` bounding spheres from actual transformed instance bounds for crisp frustum
 *   and CSM shadow culling.
 */

export interface StreetPropSpec {
  readonly url: string;
  /** Optional manifest key under `/echo-life/aaa-v2/manifest.json` for dynamic hot-resolution if url is empty/fallback. */
  readonly manifestKey?: string;
  /** Exact real-world bounding dimensions in metres `[widthX, heightY, depthZ]`. */
  readonly dimensions: readonly [number, number, number];
  /** Natural upright height in metres (pivot sits at exact `Y = 0`). */
  readonly naturalHeight: number;
  /** Target real-world upright height in metres; clamps oversized caller scales (e.g. `bench` at 1.32x). */
  readonly targetHeight?: number;
  /** Local Y-axis rotation offset (radians) aligning the GLB's open front (`+Z`) with world placement yaw. */
  readonly yawOffset?: number;
  /** Default local uniform scale factor applied when `targetHeight` does not require further clamping. */
  readonly scale?: number;
  /** Optional non-uniform local scale calibration `[sx, sy, sz]` around the `Y = 0` pivot (e.g. `bench`). */
  readonly scaleVec?: readonly [number, number, number];
  readonly groundPivotY: 0;
  readonly triangles: number;
  readonly bytes: number;
  readonly polyHavenId: string;
  readonly license: 'CC0-1.0' | 'Project-Owned';
  /** Legacy asset key or broken stand-in that this prop replaces. */
  readonly replaces: string;
}

export const STREET_PROPS = {
  streetlamp: {
    url: '/echo-life/props/prop-streetlamp-7d976ab64708.glb',
    dimensions: [0.705, 3.87, 0.384],
    naturalHeight: 3.87,
    groundPivotY: 0,
    triangles: 3400,
    bytes: 424988,
    polyHavenId: 'street_lamp_01',
    license: 'CC0-1.0',
    replaces: 'lamp / street-lantern (158-tri 1.56m stub scaled 2.2x)',
  },
  trashbin: {
    url: '/echo-life/props/prop-trashbin-8cbac49242c7.glb',
    dimensions: [0.676, 0.94, 0.574],
    naturalHeight: 0.94,
    groundPivotY: 0,
    triangles: 906,
    bytes: 187676,
    polyHavenId: 'metal_trash_can',
    license: 'CC0-1.0',
    replaces: 'bin -> bollard stand-in bug in streaming.ts',
  },
  hydrant: {
    url: '/echo-life/props/prop-hydrant-96cc68716ead.glb',
    dimensions: [0.267, 0.78, 0.309],
    naturalHeight: 0.78,
    groundPivotY: 0,
    triangles: 3450,
    bytes: 247536,
    polyHavenId: 'fire_hydrant',
    license: 'CC0-1.0',
    replaces: 'hydrant -> 3.3m trafficlight stand-in bug in streaming.ts',
  },
  bench: {
    url: '/echo-life/props/prop-bench-7e551133a507.glb',
    dimensions: [1.166, 0.89, 0.497],
    naturalHeight: 0.89,
    yawOffset: 0,
    scaleVec: [1.32, 0.92, 0.95],
    groundPivotY: 0,
    triangles: 630,
    bytes: 463176,
    polyHavenId: 'painted_wooden_bench',
    license: 'CC0-1.0',
    replaces: 'bench (flat untextured 1KB-atlas legacy bench)',
  },
  pottedPlant: {
    url: '/echo-life/props/prop-potted-plant-5dfd416d1765.glb',
    dimensions: [0.696, 0.84, 0.656],
    naturalHeight: 0.84,
    groundPivotY: 0,
    triangles: 5582,
    bytes: 596580,
    polyHavenId: 'potted_plant_02',
    license: 'CC0-1.0',
    replaces: 'plant (102-tri untextured toy cone)',
  },

  // ── AAA-v2 Batch 3: Modular Street Architecture & Shopfront Kit ──
  awningStriped: {
    url: '/echo-life/aaa-v2/street/prop_awning_striped_aaa-af873eaf7f86.glb',
    manifestKey: 'prop_awning_striped_aaa',
    dimensions: [2.66, 0.782, 0.975],
    naturalHeight: 0.782,
    groundPivotY: 0,
    triangles: 1488,
    bytes: 64424,
    polyHavenId: 'prop_awning_striped_aaa',
    license: 'Project-Owned',
    replaces: 'flat 0.12 m storefront bar awning',
  },
  airconUnit: {
    url: '/echo-life/aaa-v2/street/prop_aircon_unit_aaa-4848956d6d1c.glb',
    manifestKey: 'prop_aircon_unit_aaa',
    dimensions: [1.394, 0.716, 0.29],
    naturalHeight: 0.716,
    groundPivotY: 0,
    triangles: 4774,
    bytes: 637156,
    polyHavenId: 'exterior_aircon_unit',
    license: 'CC0-1.0',
    replaces: 'bare building sidewalls and roofs',
  },
  cafePatio: {
    url: '/echo-life/aaa-v2/street/prop_cafe_patio_aaa-f66a7f00363e.glb',
    manifestKey: 'prop_cafe_patio_aaa',
    dimensions: [2.494, 2.41, 2.494],
    naturalHeight: 2.41,
    groundPivotY: 0,
    triangles: 628,
    bytes: 280560,
    polyHavenId: 'street_cafe_umbrella_table',
    license: 'Project-Owned',
    replaces: 'patio-set / outdoor umbrella cafe table',
  },
  cafeBistroSet: {
    url: '/echo-life/aaa-v2/street/prop_cafe_bistro_set_aaa-c55d3be288fb.glb',
    manifestKey: 'prop_cafe_bistro_set_aaa',
    dimensions: [0.74, 0.855, 1.716],
    naturalHeight: 0.855,
    groundPivotY: 0,
    triangles: 5564,
    bytes: 386840,
    polyHavenId: 'outdoor_table_chair_set_01',
    license: 'CC0-1.0',
    replaces: 'compact sidewalk cafe bistro table and chairs',
  },
  chalkboard: {
    url: '/echo-life/aaa-v2/street/prop_chalkboard_aaa-c25856cc9042.glb',
    manifestKey: 'prop_chalkboard_aaa',
    dimensions: [0.719, 1.18, 0.593],
    naturalHeight: 1.18,
    groundPivotY: 0,
    triangles: 2372,
    bytes: 205184,
    polyHavenId: 'standing_chalkboard_01',
    license: 'CC0-1.0',
    replaces: 'sidewalk menu A-frame chalkboard',
  },
  busShelter: {
    url: '/echo-life/aaa-v2/street/prop_bus_shelter_aaa-16ed1e762011.glb',
    manifestKey: 'prop_bus_shelter_aaa',
    dimensions: [3.8, 2.525, 1.875],
    naturalHeight: 2.525,
    groundPivotY: 0,
    triangles: 756,
    bytes: 850184,
    polyHavenId: 'bus_stop_shelter_glass',
    license: 'Project-Owned',
    replaces: 'shelter (flat cyan legacy bus shelter)',
  },
  utilityBox: {
    url: '/echo-life/aaa-v2/street/prop_utility_box_aaa-4cd1c2625560.glb',
    manifestKey: 'prop_utility_box_aaa',
    dimensions: [0.52, 1.119, 0.431],
    naturalHeight: 1.119,
    groundPivotY: 0,
    triangles: 1800,
    bytes: 156008,
    polyHavenId: 'utility_box_01',
    license: 'CC0-1.0',
    replaces: 'urban sidewalk utility cabinet',
  },
  manhole: {
    url: '/echo-life/aaa-v2/street/prop_manhole_aaa-e6bb13ce84bc.glb',
    manifestKey: 'prop_manhole_aaa',
    dimensions: [0.691, 0.068, 0.691],
    naturalHeight: 0.068,
    groundPivotY: 0,
    triangles: 1421,
    bytes: 208680,
    polyHavenId: 'water_manhole_cover',
    license: 'CC0-1.0',
    replaces: 'cast-iron road manhole cover',
  },

  // ── AAA-v2 Batch 2: Botanical & Park Hero Upgrades (Cycles OptiX baked, exact content hashes) ──
  planterLush: {
    url: '/echo-life/aaa-v2/botanical/prop_planter_lush_aaa-74a774127ef2.glb',
    manifestKey: 'prop_planter_lush_aaa',
    dimensions: [1.72, 0.89, 1.10],
    naturalHeight: 0.89,
    groundPivotY: 0,
    triangles: 1080,
    bytes: 253952,
    polyHavenId: 'prop_planter_lush_aaa',
    license: 'Project-Owned',
    replaces: 'planter-trough (empty terracotta rectangle in Scene 11)',
  },
  pergolaVine: {
    url: '/echo-life/aaa-v2/botanical/prop_pergola_vine_aaa-8b29dd32dafe.glb',
    manifestKey: 'prop_pergola_vine_aaa',
    dimensions: [5.08, 2.98, 5.15],
    naturalHeight: 2.98,
    groundPivotY: 0,
    triangles: 7125,
    bytes: 347136,
    polyHavenId: 'prop_pergola_vine_aaa',
    license: 'Project-Owned',
    replaces: 'park-gazebo (bare timber beams in Botanical Garden)',
  },
  hedgeTrimmed: {
    url: '/echo-life/aaa-v2/botanical/prop_hedge_trimmed_aaa-3e4b27a371a8.glb',
    manifestKey: 'prop_hedge_trimmed_aaa',
    dimensions: [2.37, 1.04, 0.89],
    naturalHeight: 1.04,
    groundPivotY: 0,
    triangles: 11548,
    bytes: 819820,
    polyHavenId: 'prop_hedge_trimmed_aaa',
    license: 'Project-Owned',
    replaces: 'manicured park and residential boxwood hedge border',
  },

  // ── AAA-v2 Batch 4: Rich University Library & Cafe/Bistro Interior Pack ──
  libBookstackTall: {
    url: '/echo-life/aaa-v2/interior/lib_bookstack_tall_aaa-7e74f994d5c9.glb',
    manifestKey: 'lib_bookstack_tall_aaa',
    dimensions: [2.092, 2.55, 0.672],
    naturalHeight: 2.55,
    groundPivotY: 0,
    triangles: 4212,
    bytes: 236544,
    polyHavenId: 'library_bookstack_double_tall',
    license: 'Project-Owned',
    replaces: 'empty Library perimeter and mezzanine walls',
  },
  libReadingChair: {
    url: '/echo-life/aaa-v2/interior/lib_reading_chair_aaa-f3be4c85aefa.glb',
    manifestKey: 'lib_reading_chair_aaa',
    dimensions: [0.40, 0.90, 0.53],
    naturalHeight: 0.90,
    groundPivotY: 0,
    triangles: 2800,
    bytes: 163840,
    polyHavenId: 'WoodenChair_01',
    license: 'CC0-1.0',
    replaces: 'missing Library reading table chairs',
  },
  libArmchair: {
    url: '/echo-life/aaa-v2/interior/lib_armchair_aaa-4801f5011499.glb',
    manifestKey: 'lib_armchair_aaa',
    dimensions: [0.765, 0.96, 0.69],
    naturalHeight: 0.96,
    groundPivotY: 0,
    triangles: 3199,
    bytes: 227884,
    polyHavenId: 'ArmChair_01',
    license: 'CC0-1.0',
    replaces: 'Library reading lounge seating',
  },
  libRugWoven: {
    url: '/echo-life/aaa-v2/interior/lib_rug_woven_aaa-05cd9a00824b.glb',
    manifestKey: 'lib_rug_woven_aaa',
    dimensions: [2.8, 0.017, 2.0],
    naturalHeight: 0.017,
    groundPivotY: 0,
    triangles: 324,
    bytes: 168960,
    polyHavenId: 'rug_living_woven_280x200',
    license: 'Project-Owned',
    replaces: 'bare Library and Starter House floor slabs',
  },
  libBankerLamp: {
    url: '/echo-life/aaa-v2/interior/lib_banker_lamp_aaa-f1f5b7f27ccb.glb',
    manifestKey: 'lib_banker_lamp_aaa',
    dimensions: [0.109, 0.48, 0.33],
    naturalHeight: 0.48,
    groundPivotY: 0,
    triangles: 3244,
    bytes: 260544,
    polyHavenId: 'desk_lamp_arm_01',
    license: 'CC0-1.0',
    replaces: 'warm reading table emerald banker lamps',
  },
  libCeilingPendant: {
    url: '/echo-life/aaa-v2/interior/lib_ceiling_pendant_aaa-a508d0b8e41f.glb',
    manifestKey: 'lib_ceiling_pendant_aaa',
    dimensions: [0.432, 0.951, 0.432],
    naturalHeight: 0.951,
    groundPivotY: 0,
    triangles: 2558,
    bytes: 119008,
    polyHavenId: 'modern_ceiling_lamp_01',
    license: 'CC0-1.0',
    replaces: 'flat glowing ceiling cylinders',
  },
  libPottedPlant: {
    url: '/echo-life/aaa-v2/interior/lib_potted_plant_aaa-5c3d8705971d.glb',
    manifestKey: 'lib_potted_plant_aaa',
    dimensions: [0.587, 1.335, 0.634],
    naturalHeight: 1.335,
    groundPivotY: 0,
    triangles: 9000,
    bytes: 517120,
    polyHavenId: 'pachira_aquatica_01',
    license: 'CC0-1.0',
    replaces: 'lush indoor botanical potted plants',
  },
  cafeCoffeeCart: {
    url: '/echo-life/aaa-v2/interior/cafe_coffee_cart_aaa-dabb3148b7c8.glb',
    manifestKey: 'cafe_coffee_cart_aaa',
    dimensions: [2.167, 1.718, 1.069],
    naturalHeight: 1.718,
    groundPivotY: 0,
    triangles: 6923,
    bytes: 846760,
    polyHavenId: 'CoffeeCart_01',
    license: 'CC0-1.0',
    replaces: 'Cafe and Bistro specialty espresso bar cart',
  },
  shopCashRegister: {
    url: '/echo-life/aaa-v2/interior/shop_cash_register_aaa-f6400a8756b5.glb',
    manifestKey: 'shop_cash_register_aaa',
    dimensions: [0.367, 0.379, 0.381],
    naturalHeight: 0.379,
    groundPivotY: 0,
    triangles: 3885,
    bytes: 305576,
    polyHavenId: 'CashRegister_01',
    license: 'CC0-1.0',
    replaces: 'Sunrise Market and Bistro checkout till',
  },
} as const satisfies Record<string, StreetPropSpec>;

export type StreetPropKey = keyof typeof STREET_PROPS;

export const STREET_PROP_URLS: Readonly<Record<StreetPropKey, string>> = Object.fromEntries(
  (Object.keys(STREET_PROPS) as StreetPropKey[]).map((k) => [k, STREET_PROPS[k].url]),
) as Record<StreetPropKey, string>;

/**
 * Legacy `city.props` asset/kind replacement map so `CityStreamer` (`streaming.ts`) can route
 * broken empty planters, bare gazebos, and flat bus shelters directly to AAA-v2 Cycles-baked props.
 */
export const AAA_V2_LEGACY_PROP_MAP: Readonly<Record<string, StreetPropKey>> = {
  'planter-trough': 'planterLush',
  'park-gazebo': 'pergolaVine',
  shelter: 'busShelter',
  'patio-set': 'cafeBistroSet',
};

export interface PreparedStreetProp {
  readonly key: StreetPropKey;
  readonly spec: StreetPropSpec;
  readonly parts: { geometry: T.BufferGeometry; material: T.Material }[];
  readonly box: T.Box3;
  readonly triangles: number;
}

const KEEP_ATTRS = new Set(['position', 'normal', 'uv', 'uv1', 'color']);
/** Core outdoor street props pinned permanently while Echo Life is mounted (zero churn on street walks). */
const PINNED_STREET_PROPS = new Set<StreetPropKey>(['streetlamp', 'bench', 'trashbin', 'hydrant']);

let propLoader: GLTFLoader | null = null;
let propEpoch = 0;
const propCache = new Map<StreetPropKey, Promise<PreparedStreetProp | null>>();
const propPrepared = new Map<StreetPropKey, PreparedStreetProp>();
const propRefs = new Map<StreetPropKey, number>();
const propLastUsed = new Map<StreetPropKey, number>();

// Optional lazy manifest lookup for dynamically staged aaa-v2 assets (e.g., Batch 1/2/6).
let aaaManifestPromise: Promise<Record<string, { url?: string }> | null> | null = null;

export function loadAaaV2Manifest(): Promise<Record<string, { url?: string }> | null> {
  if (aaaManifestPromise) return aaaManifestPromise;
  if (typeof fetch !== 'function') {
    aaaManifestPromise = Promise.resolve(null);
    return aaaManifestPromise;
  }
  aaaManifestPromise = fetch('/echo-life/aaa-v2/manifest.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => (data && typeof data === 'object' && data.assets ? data.assets : null))
    .catch(() => null);
  return aaaManifestPromise;
}

/**
 * Unpacks `KHR_mesh_quantization` (`Int16Array`/`Uint16Array` normalized) or `InterleavedBufferAttribute`
 * attributes into clean Float32BufferAttributes BEFORE `applyMatrix4` / `mergeGeometries` so transforms never
 * overflow quantized integer ranges and `mergeGeometries` never returns null.
 */
function normalizeAttrFloat32(
  attr: T.BufferAttribute | T.InterleavedBufferAttribute,
): T.Float32BufferAttribute {
  const isInterleaved = Boolean((attr as T.InterleavedBufferAttribute).isInterleavedBufferAttribute);
  if (
    !isInterleaved &&
    attr instanceof T.BufferAttribute &&
    attr.array instanceof Float32Array &&
    !attr.normalized &&
    attr.gpuType === T.FloatType
  ) {
    return attr as T.Float32BufferAttribute;
  }
  const itemSize = attr.itemSize;
  const count = attr.count;
  const out = new Float32Array(count * itemSize);
  for (let i = 0; i < count; i++) {
    if (itemSize === 2) {
      out[i * 2] = attr.getX(i);
      out[i * 2 + 1] = attr.getY(i);
    } else if (itemSize === 3) {
      out[i * 3] = attr.getX(i);
      out[i * 3 + 1] = attr.getY(i);
      out[i * 3 + 2] = attr.getZ(i);
    } else {
      for (let c = 0; c < itemSize; c++) out[i * itemSize + c] = attr.getComponent(i, c);
    }
  }
  return new T.Float32BufferAttribute(out, itemSize);
}

interface NightEmissiveEntry {
  mat: T.MeshStandardMaterial;
  readonly dayIntensity: number;
  readonly nightIntensity: number;
  readonly isLanternGlass?: boolean;
}

const nightEmissiveEntries: NightEmissiveEntry[] = [];
let currentStreetPropNight = 0;

/**
 * Updates night-time warm emissive glow across all loaded streetscape lanterns (`street_lamp_01_glass` &
 * `street_lamp_01_bulb`), pergola Edison string lights, and bus shelter lightboxes (`P1-VIS-5C`).
 */
export function updateStreetProps(nightFactor: number): void {
  const n = Math.max(0, Math.min(1, Number.isFinite(nightFactor) ? nightFactor : 0));
  currentStreetPropNight = n;
  // Smooth dusk turn-on curve so lamps ignite warmly at sunset/twilight and shine brightly at 22:00 night.
  const glow = n <= 0.15 ? 0 : Math.min(1, (n - 0.15) / 0.55);
  for (let i = 0; i < nightEmissiveEntries.length; i++) {
    const e = nightEmissiveEntries[i];
    e.mat.emissiveIntensity = e.dayIntensity + (e.nightIntensity - e.dayIntensity) * glow;
    if (e.isLanternGlass) {
      e.mat.opacity = 0.58 + 0.32 * glow;
    }
  }
}

export const updateStreetPropsNight = updateStreetProps;

/**
 * Sanitizes loaded street/interior prop materials:
 * - Strips `KHR_materials_transmission` (`transmission = 0`) so NO prop triggers `renderTransmissionPass()`.
 * - Forces crisp matte botanical PBR on trimmed hedges & foliage (`P1-VIS-5A`, zero plastic shine!).
 * - Wires warm golden night-glow emissives on wrought-iron streetlamp glass/bulbs & pergola Edison bulbs (`P1-VIS-5C`).
 */
function sanitizePropMaterial(mat: T.Material, key: StreetPropKey): void {
  const phys = mat as T.MeshPhysicalMaterial;
  if (typeof phys.transmission === 'number' && phys.transmission > 0) {
    phys.transmission = 0;
    phys.thickness = 0;
    phys.transparent = true;
    phys.opacity = Math.min(0.42, phys.opacity > 0.05 && phys.opacity < 1 ? phys.opacity : 0.36);
    phys.roughness = Math.min(phys.roughness ?? 0.08, 0.08);
    phys.clearcoat = 1.0;
    phys.clearcoatRoughness = 0.05;
    phys.envMapIntensity = 1.5;
    phys.depthWrite = false;
  }
  const std = mat as T.MeshStandardMaterial;
  const matName = std.name || '';

  // P1-VIS-5A: Force realistic matte botanical PBR on `prop_hedge_trimmed_aaa` & foliage props (eliminates glossy green cube look!).
  const isHedgeFoliage =
    key === 'hedgeTrimmed' && /hedge|boxwood|foliage|leaf|blossom/i.test(matName);
  const isBotanicalLeaf =
    (key === 'planterLush' || key === 'pergolaVine' || key === 'pottedPlant' || key === 'libPottedPlant') &&
    /foliage|leaf|leaves|fern|vine|ivy|shrub/i.test(matName);
  if (isHedgeFoliage) {
    std.roughness = 0.93;
    std.metalness = 0.0;
    std.envMapIntensity = 0.25;
    // Drop packed specular/roughness map on hedge boxwood if present so matte 0.93 roughness cannot be overridden.
    if (/boxwood|foliage/i.test(matName)) {
      std.roughnessMap = null;
      std.metalnessMap = null;
    }
    if ('clearcoat' in phys) phys.clearcoat = 0;
    if ('specularIntensity' in phys) phys.specularIntensity = 0.14;
    std.needsUpdate = true;
  } else if (isBotanicalLeaf) {
    std.roughness = Math.max(std.roughness ?? 0.84, 0.84);
    std.metalness = 0.0;
    std.envMapIntensity = Math.min(std.envMapIntensity ?? 0.35, 0.35);
    if ('clearcoat' in phys) phys.clearcoat = 0;
  }

  // P1-VIS-5C: Warm golden glowing streetlamp glass panes & bulbs at dusk/night!
  if (key === 'streetlamp' && /bulb/i.test(matName)) {
    std.color.setHex(0xfff4d8);
    std.emissive.setHex(0xffcf7a);
    std.roughness = 0.2;
    std.metalness = 0.0;
    const glow = currentStreetPropNight <= 0.15 ? 0 : Math.min(1, (currentStreetPropNight - 0.15) / 0.55);
    std.emissiveIntensity = 0.15 + (3.0 - 0.15) * glow;
    nightEmissiveEntries.push({ mat: std, dayIntensity: 0.15, nightIntensity: 3.0 });
    std.needsUpdate = true;
  } else if (key === 'streetlamp' && /glass/i.test(matName)) {
    std.color.setHex(0xfff1cf);
    std.emissive.setHex(0xffcf7a);
    std.transparent = true;
    std.roughness = 0.22;
    std.metalness = 0.0;
    std.depthWrite = false;
    const glow = currentStreetPropNight <= 0.15 ? 0 : Math.min(1, (currentStreetPropNight - 0.15) / 0.55);
    std.emissiveIntensity = 0.04 + (1.75 - 0.04) * glow;
    std.opacity = 0.58 + 0.32 * glow;
    nightEmissiveEntries.push({ mat: std, dayIntensity: 0.04, nightIntensity: 1.75, isLanternGlass: true });
    std.needsUpdate = true;
  } else if (key === 'pergolaVine' && /bulb|edison|lamp|glow/i.test(matName)) {
    std.emissive.setHex(0xffcf7a);
    const glow = currentStreetPropNight <= 0.15 ? 0 : Math.min(1, (currentStreetPropNight - 0.15) / 0.55);
    std.emissiveIntensity = 0.55 + (2.4 - 0.55) * glow;
    nightEmissiveEntries.push({ mat: std, dayIntensity: 0.55, nightIntensity: 2.4 });
    std.needsUpdate = true;
  } else if (key === 'busShelter' && /lightbox|map/i.test(matName)) {
    std.emissive.setHex(0xffe6bd);
    const glow = currentStreetPropNight <= 0.15 ? 0 : Math.min(1, (currentStreetPropNight - 0.15) / 0.55);
    std.emissiveIntensity = 0.08 + (0.85 - 0.08) * glow;
    nightEmissiveEntries.push({ mat: std, dayIntensity: 0.08, nightIntensity: 0.85 });
    std.needsUpdate = true;
  } else if (key === 'libCeilingPendant' && /glass|globe|bulb|shade/i.test(matName)) {
    // Warm frosted-glass glowing Pixel Café & University Library pendants (fixes dark unlit ceiling pendants!).
    const isCoreGlobe = /globe|bulb/i.test(matName);
    std.color.setHex(0xfff4df);
    std.emissive.setHex(0xffe3b0);
    std.emissiveIntensity = isCoreGlobe ? 1.85 : 1.55;
    std.roughness = 0.24;
    std.metalness = 0.0;
    if (/glass/i.test(matName)) {
      std.transparent = true;
      std.opacity = Math.max(std.opacity || 0.72, 0.78);
      std.depthWrite = false;
    }
    std.needsUpdate = true;
  } else if (key === 'libBankerLamp' && /light|bulb|shade|glow/i.test(matName)) {
    // Warm glowing emerald-amber/cream Library banker lamps across reading tables & reception counter.
    std.color.setHex(0xfff6dc);
    std.emissive.setHex(0xffdfa0);
    std.emissiveIntensity = 1.95;
    std.roughness = 0.22;
    std.metalness = 0.0;
    std.needsUpdate = true;
  }

  if (std.transparent) std.depthWrite = false;
  if (std.aoMap) {
    std.aoMap.channel = 0;
    if (std.aoMap.image) std.aoMap.needsUpdate = true;
  }
}

function disposeMaterialTextures(mat: T.Material, keepTextures?: ReadonlySet<T.Texture>) {
  const std = mat as T.MeshStandardMaterial;
  const seen = new Set<T.Texture>();
  for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'] as const) {
    const tex = std[slot];
    if (tex && !seen.has(tex) && !keepTextures?.has(tex) && typeof tex.dispose === 'function') {
      seen.add(tex);
      tex.dispose();
    }
  }
}

function propMatHasTexture(mat: T.Material): boolean {
  const std = mat as T.MeshStandardMaterial;
  return Boolean(std.map || std.normalMap || std.roughnessMap || std.metalnessMap || std.aoMap || std.emissiveMap);
}

function bakeVertexTint(geo: T.BufferGeometry, r: number, g: number, b: number): void {
  const count = geo.attributes.position.count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = r;
    arr[i * 3 + 1] = g;
    arr[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new T.Float32BufferAttribute(arr, 3));
}

function reduceProp(key: StreetPropKey, scene: T.Object3D): PreparedStreetProp {
  scene.updateMatrixWorld(true);
  const byMat = new Map<T.Material, T.BufferGeometry[]>();
  const demotedByOrig = new Map<T.Material, T.Material>();
  const discardedMats: T.Material[] = [];

  scene.traverse((obj) => {
    const mesh = obj as T.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (materials.length !== 1 || !materials[0]) return;

    const geo = mesh.geometry.clone();
    // Unpack quantized/interleaved attributes BEFORE applyMatrix4 so Int16/Uint16 buffers never overflow!
    for (const attr of Object.keys(geo.attributes)) {
      if (!KEEP_ATTRS.has(attr)) {
        geo.deleteAttribute(attr);
        continue;
      }
      geo.setAttribute(attr, normalizeAttrFloat32(geo.attributes[attr] as T.BufferAttribute));
    }
    geo.applyMatrix4(mesh.matrixWorld);

    if (geo.index) {
      const idx = geo.index;
      if (Boolean((idx as unknown as T.InterleavedBufferAttribute).isInterleavedBufferAttribute)) {
        const count = idx.count;
        const arr = geo.attributes.position.count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
        for (let i = 0; i < count; i++) arr[i] = idx.getX(i);
        geo.setIndex(new T.BufferAttribute(arr, 1));
      }
    } else {
      const count = geo.getAttribute('position').count;
      const arr = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
      for (let i = 0; i < count; i++) arr[i] = i;
      geo.setIndex(new T.BufferAttribute(arr, 1));
    }
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (!geo.attributes.uv) {
      geo.setAttribute('uv', new T.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    }
    geo.morphAttributes = {};

    const rawMat = materials[0];
    let mat = demotedByOrig.get(rawMat);
    if (!mat) {
      // Strip transmission & demote static `MeshPhysicalMaterial` -> lean `MeshStandardMaterial` at creation time
      // so street/interior props never spawn redundant D3D11/FXC `MeshPhysicalMaterial` shader permutations.
      sanitizePropMaterial(rawMat, key);
      mat = demotePlainPhysicalMaterial(rawMat, { allowClearcoat: false });
      if (mat !== rawMat) {
        // Re-bind night emissive entry to the demoted `MeshStandardMaterial` and dispose original wrapper.
        for (const entry of nightEmissiveEntries) {
          if (entry.mat === rawMat) entry.mat = mat as T.MeshStandardMaterial;
        }
        discardedMats.push(rawMat);
      }
      demotedByOrig.set(rawMat, mat);
    }
    const list = byMat.get(mat) ?? [];
    list.push(geo);
    byMat.set(mat, list);
  });

  // Consolidate `airconUnit` duplicate rusted twin texture sets (`4 draws / 12 tex -> 2 draws / 6 tex`)!
  if (key === 'airconUnit' && byMat.size > 2) {
    let baseOpaque: T.Material | null = null;
    let baseGrille: T.Material | null = null;
    for (const mat of byMat.keys()) {
      const n = (mat.name || '').toLowerCase();
      if (!n.includes('rusted') && !mat.transparent) baseOpaque = mat;
      else if (!n.includes('rusted') && mat.transparent) baseGrille = mat;
    }
    if (baseOpaque || baseGrille) {
      for (const [mat, list] of [...byMat.entries()]) {
        const n = (mat.name || '').toLowerCase();
        if (!n.includes('rusted')) continue;
        const target = mat.transparent ? baseGrille : baseOpaque;
        if (!target || target === mat) continue;
        const tgtList = byMat.get(target)!;
        // Subtle warm weathered tint via vertex color on the rusted unit while reusing the base unit's PBR textures!
        (target as T.MeshStandardMaterial).vertexColors = true;
        for (const g of tgtList) {
          if (!g.attributes.color) bakeVertexTint(g, 1, 1, 1);
        }
        for (const g of list) {
          bakeVertexTint(g, 0.88, 0.83, 0.78);
          tgtList.push(g);
        }
        byMat.delete(mat);
        discardedMats.push(mat);
      }
    }
  }

  // Consolidate `busShelter` opaque structural sub-parts (`Powder_Iron`, `Cedar_Slats`, `Sidewalk_Paver`)
  // into ONE vertex-colored architectural structure mesh (slashes `5 draws / 7 tex -> 3 draws / 1 tex` while
  // keeping backlit `Transit_Map` & `Clear_Glass` intact!).
  if (key === 'busShelter' && byMat.size > 2) {
    const structParts: { mat: T.Material; geos: T.BufferGeometry[]; col: [number, number, number] }[] = [];
    for (const [mat, list] of byMat.entries()) {
      const n = (mat.name || '').toLowerCase();
      if (mat.transparent || /lightbox|map/i.test(n)) continue;
      const std = mat as T.MeshStandardMaterial;
      let col: [number, number, number] = [std.color.r, std.color.g, std.color.b];
      if (/cedar|wood|slat/i.test(n)) col = [0.46, 0.28, 0.16];
      else if (/paver|concrete|base/i.test(n)) col = [0.48, 0.46, 0.42];
      else if (/iron|metal|frame/i.test(n)) col = [0.09, 0.11, 0.13];
      structParts.push({ mat, geos: list, col });
    }
    if (structParts.length >= 2) {
      const mergedStructMat = new T.MeshStandardMaterial({
        name: 'bus_shelter_vc_structure',
        color: '#ffffff',
        vertexColors: true,
        roughness: 0.56,
        metalness: 0.28,
        side: T.DoubleSide,
      });
      const mergedGeos: T.BufferGeometry[] = [];
      for (const sp of structParts) {
        for (const g of sp.geos) {
          bakeVertexTint(g, sp.col[0], sp.col[1], sp.col[2]);
          mergedGeos.push(g);
        }
        byMat.delete(sp.mat);
        discardedMats.push(sp.mat);
      }
      byMat.set(mergedStructMat, mergedGeos);
    }
  }

  // Generic untextured opaque sub-part merger: collapse multiple untextured opaque non-emissive materials on any prop.
  const untexOpaque: [T.MeshStandardMaterial, T.BufferGeometry[]][] = [];
  for (const [mat, list] of byMat.entries()) {
    const std = mat as T.MeshStandardMaterial;
    if (
      std instanceof T.MeshStandardMaterial &&
      !std.transparent &&
      std.alphaTest === 0 &&
      std.emissive.getHex() === 0 &&
      !propMatHasTexture(std)
    ) {
      untexOpaque.push([std, list]);
    }
  }
  if (untexOpaque.length >= 2) {
    const avgRough = untexOpaque.reduce((acc, [m]) => acc + m.roughness, 0) / untexOpaque.length;
    const avgMetal = untexOpaque.reduce((acc, [m]) => acc + m.metalness, 0) / untexOpaque.length;
    const vcMat = new T.MeshStandardMaterial({
      name: `${key}_vc_merged`,
      color: '#ffffff',
      vertexColors: true,
      roughness: avgRough,
      metalness: avgMetal,
      side: untexOpaque.some(([m]) => m.side === T.DoubleSide) ? T.DoubleSide : T.FrontSide,
    });
    const mergedGeos: T.BufferGeometry[] = [];
    for (const [m, list] of untexOpaque) {
      for (const g of list) {
        if (!g.attributes.color) bakeVertexTint(g, m.color.r, m.color.g, m.color.b);
        mergedGeos.push(g);
      }
      byMat.delete(m);
      discardedMats.push(m);
    }
    byMat.set(vcMat, mergedGeos);
  }

  // Dispose discarded duplicate materials & their unreferenced textures cleanly right away!
  if (discardedMats.length > 0) {
    const keepTex = new Set<T.Texture>();
    for (const mat of byMat.keys()) {
      const std = mat as T.MeshStandardMaterial;
      for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'] as const) {
        const tex = std[slot];
        if (tex) keepTex.add(tex);
      }
    }
    const discSet = new Set(discardedMats);
    for (let i = nightEmissiveEntries.length - 1; i >= 0; i--) {
      if (discSet.has(nightEmissiveEntries[i].mat)) nightEmissiveEntries.splice(i, 1);
    }
    for (const m of discardedMats) {
      disposeMaterialTextures(m, keepTex);
      m.dispose();
    }
  }

  const uploadQueue = getEchoLifeTextureUploadQueue();
  const parts: PreparedStreetProp['parts'] = [];
  let triangles = 0;
  for (const [material, list] of byMat) {
    // Creation-time CSM + height-fog patching (invariant across all passes; 0 post-unlock recompiles!).
    patchMaterialWithEchoCsm(material);
    patchHeightFog(material);
    const std = material as T.MeshStandardMaterial;
    for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'] as const) {
      const tex = std[slot];
      if (tex instanceof T.Texture) {
        retainDedupTexture(tex);
        uploadQueue.enqueue(tex);
      }
    }

    // Harmonize optional attributes (`uv1`, `color`) across chunks in the same material bucket.
    const hasUv1 = list.every((g) => Boolean(g.attributes.uv1));
    const hasColor = list.every((g) => Boolean(g.attributes.color));
    for (const g of list) {
      if (!hasUv1 && g.attributes.uv1) g.deleteAttribute('uv1');
      if (!hasColor && g.attributes.color) g.deleteAttribute('color');
    }
    const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (list.length > 1) list.forEach((g) => g.dispose());
    if (!merged) continue;
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    triangles += (merged.index?.count ?? merged.attributes.position.count) / 3;
    parts.push({ geometry: merged, material });
  }

  const box = new T.Box3();
  for (const p of parts) {
    if (p.geometry.boundingBox) box.union(p.geometry.boundingBox);
  }
  return { key, spec: STREET_PROPS[key], parts, box, triangles };
}

function estimatePropGpuBytes(p: PreparedStreetProp): number {
  const seen = new Set<T.Texture>();
  let bytes = Math.max(16_384, Math.round(p.triangles * 48));
  for (const part of p.parts) {
    const std = part.material as T.MeshStandardMaterial;
    for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'] as const) {
      const tex = std[slot];
      if (tex instanceof T.Texture && !seen.has(tex)) {
        seen.add(tex);
        const img = tex.image as { width?: number; height?: number } | undefined;
        const w = Math.max(16, img?.width ?? 256);
        const h = Math.max(16, img?.height ?? 256);
        bytes += Math.round(w * h * 4 * 1.333);
      }
    }
  }
  return bytes;
}

function disposePreparedProp(p: PreparedStreetProp) {
  const disposedMats = new Set<T.Material>();
  for (const part of p.parts) {
    part.geometry.dispose();
    disposedMats.add(part.material);
    disposeMaterialTextures(part.material);
    part.material.dispose();
  }
  // Remove evicted materials from `nightEmissiveEntries` so pruned props never leak references!
  for (let i = nightEmissiveEntries.length - 1; i >= 0; i--) {
    if (disposedMats.has(nightEmissiveEntries[i].mat)) {
      nightEmissiveEntries.splice(i, 1);
    }
  }
}

function materialUsesTexture(mat: GltfMaterialDefLike, textureIndex: number): boolean {
  return (
    mat.pbrMetallicRoughness?.baseColorTexture?.index === textureIndex ||
    mat.pbrMetallicRoughness?.metallicRoughnessTexture?.index === textureIndex ||
    mat.normalTexture?.index === textureIndex ||
    mat.occlusionTexture?.index === textureIndex ||
    mat.emissiveTexture?.index === textureIndex
  );
}

/**
 * Pre-decode skip predicate for `streetPropsManifest`: avoids decoding textures that `reduceProp()`
 * immediately discards (`prop_bus_shelter_aaa` 6 structural maps: `Cedar_Slats`, `Sidewalk_Paver`,
 * `Powder_Iron`; and `prop_aircon_unit_aaa` duplicate `rusted` twin maps).
 */
function shouldSkipStreetPropTexture(parser: GltfParserLike, textureIndex: number): boolean {
  const materials = parser.json.materials;
  if (!Array.isArray(materials) || materials.length === 0) return false;

  const users = materials.filter((m) => materialUsesTexture(m, textureIndex));
  if (users.length === 0) return false;

  // 1. `prop_bus_shelter_aaa`: keep only `Transit_Map` / `Clear_Glass`; skip all 6 structural maps before decode!
  const isBusShelter =
    materials.some((m) => /powder_iron|cedar_slat|sidewalk_paver/i.test(m.name || '')) &&
    materials.some((m) => /lightbox|transit_map|map/i.test(m.name || ''));
  if (isBusShelter) {
    return users.every((m) => m.alphaMode !== 'BLEND' && !/lightbox|map/i.test(m.name || ''));
  }

  // 2. `prop_aircon_unit_aaa`: skip duplicate `rusted` twin textures when base unit material exists!
  const hasNonRustedTwin = materials.some((m) => !/rusted/i.test(m.name || ''));
  if (hasNonRustedTwin && users.every((m) => /rusted/i.test(m.name || ''))) {
    return true;
  }

  return false;
}

function getOrCreatePropLoader(): GLTFLoader {
  if (!propLoader) {
    propLoader = new GLTFLoader();
    installGltfTextureDedupPlugin(propLoader, {
      isHero: false,
      shouldSkipTexture: shouldSkipStreetPropTexture,
    });
  }
  return propLoader;
}

function evictStreetPropById(key: StreetPropKey): boolean {
  if (PINNED_STREET_PROPS.has(key) || (propRefs.get(key) ?? 0) > 0) return false;
  if (getInFlightCompileCount() > 0) return false;
  const p = propPrepared.get(key);
  if (!p) return false;
  disposePreparedProp(p);
  propPrepared.delete(key);
  propCache.delete(key);
  propLastUsed.delete(key);
  return true;
}

function disposeRawGltfScene(scene: T.Object3D): void {
  scene.traverse((o) => {
    const m = o as T.Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mt of mats) {
      if (!mt) continue;
      disposeMaterialTextures(mt);
      mt.dispose();
    }
  });
}

/** Lazily loads and caches a staged zero-WASM streetscape or interior prop GLB (deduplicated & time-sliced). */
export function loadStreetProp(key: StreetPropKey): Promise<PreparedStreetProp | null> {
  propLastUsed.set(key, Date.now());
  const hit = propCache.get(key);
  if (hit) return hit;

  const at = propEpoch;
  const currentLoader = getOrCreatePropLoader();
  const spec = STREET_PROPS[key] as StreetPropSpec;
  const scheduler = getEchoLifeLoadScheduler();
  const priority = (propRefs.get(key) ?? 0) > 0 ? LoadPriority.P1_PREFETCH : LoadPriority.P2_NEAR_CHUNK;
  const residencyKey = `street-prop:${key}`;

  const resolveUrl = async (): Promise<string> => {
    if (spec.manifestKey && !spec.url.includes('/aaa-v2/')) {
      const manifest = await loadAaaV2Manifest();
      const entryUrl = manifest?.[spec.manifestKey]?.url;
      if (typeof entryUrl === 'string' && entryUrl.length > 0) return entryUrl;
    }
    return spec.url;
  };

  const promise = scheduler
    .scheduleLoad(
      residencyKey,
      priority,
      async () => {
        const url = await resolveUrl();
        return currentLoader.loadAsync(url);
      },
      {
        onDiscardLateResult: (lateGltf) => {
          if (lateGltf?.scene) disposeRawGltfScene(lateGltf.scene);
        },
      },
    )
    .then(async (gltf) => {
      if (!gltf) return null;
      if (at !== propEpoch) {
        disposeRawGltfScene(gltf.scene);
        return null;
      }
      const prepared = await scheduler.scheduleCommit(
        `${residencyKey}:reduce`,
        priority,
        () => {
          const out = reduceProp(key, gltf.scene);
          gltf.scene.traverse((o) => {
            const m = o as T.Mesh;
            if (m.isMesh) m.geometry.dispose();
          });
          return out;
        },
      );
      if (!prepared) return null;
      if (at !== propEpoch) {
        disposePreparedProp(prepared);
        return null;
      }
      propPrepared.set(key, prepared);
      propLastUsed.set(key, Date.now());
      const residency = getEchoLifeResidencyManager();
      residency.register({
        key: residencyKey,
        category: PINNED_STREET_PROPS.has(key) ? 'core' : 'prop',
        estimatedBytes: estimatePropGpuBytes(prepared),
        pinned: PINNED_STREET_PROPS.has(key),
        minRetentionSec: 45,
        dispose: () => {
          evictStreetPropById(key);
        },
      });
      if ((propRefs.get(key) ?? 0) > 0) {
        residency.acquire(residencyKey);
      }
      return prepared;
    })
    .catch(() => {
      if (at === propEpoch) propCache.delete(key);
      return null;
    });

  propCache.set(key, promise);
  return promise;
}

const propEverAcquired = new Set<StreetPropKey>();

/**
 * Ref-counted acquisition of a streetscape or interior prop (`buildingsView`, `streaming`, `marketStock`,
 * `vegetationSystem`). Pair every `acquireStreetProp(key)` call with `releaseStreetProp(key)` on unmount so
 * interior & building-specific props evict cleanly via `EchoLifeResidencyManager`.
 */
export function acquireStreetProp(key: StreetPropKey): Promise<PreparedStreetProp | null> {
  propEverAcquired.add(key);
  const prev = propRefs.get(key) ?? 0;
  propRefs.set(key, prev + 1);
  propLastUsed.set(key, Date.now());
  if (prev === 0 && propPrepared.has(key)) {
    getEchoLifeResidencyManager().acquire(`street-prop:${key}`);
  }
  return loadStreetProp(key);
}

/** Releases one active hold on a street/interior prop; unreferenced non-pinned props stay warm for `minRetentionSec`. */
export function releaseStreetProp(key: StreetPropKey): void {
  const next = (propRefs.get(key) ?? 0) - 1;
  if (next <= 0) {
    propRefs.delete(key);
    getEchoLifeResidencyManager().release(`street-prop:${key}`);
  } else {
    propRefs.set(key, next);
  }
  propLastUsed.set(key, Date.now());
}

/**
 * Ref-counted LRU pruner backed by `EchoLifeResidencyManager` with strict mid-compile guard
 * (`getInFlightCompileCount() > 0`) and `>= 20 s` retention floor (eliminates `0 ms` doorway thrashing!).
 */
export function pruneStreetProps(maxCached = 24, maxIdleMs = 45_000): number {
  if (getInFlightCompileCount() > 0) return 0;

  let evicted = getEchoLifeResidencyManager().evictIfNeeded();
  const effectiveCap = Math.max(16, maxCached);
  const effectiveIdleMs = Math.max(20_000, maxIdleMs);
  const now = Date.now();
  const candidates = [...propPrepared.keys()]
    .filter((k) => !PINNED_STREET_PROPS.has(k) && (propRefs.get(k) ?? 0) === 0)
    .sort((a, b) => (propLastUsed.get(a) ?? 0) - (propLastUsed.get(b) ?? 0));

  for (const key of candidates) {
    if (getInFlightCompileCount() > 0) break;
    const idleMs = now - (propLastUsed.get(key) ?? 0);
    if (idleMs < effectiveIdleMs) continue;
    const overCap = propPrepared.size > effectiveCap;
    if (!overCap && idleMs < 45_000) continue;
    if (evictStreetPropById(key)) {
      getEchoLifeResidencyManager().unregister(`street-prop:${key}`);
      evicted++;
    }
  }
  return evicted;
}

const Y_AXIS = new T.Vector3(0, 1, 0);
const ZERO_POS = new T.Vector3(0, 0, 0);
const TMP_BOX = new T.Box3();
const TMP_UNION = new T.Box3();
/** Tracks matrices already calibrated by `placeStreetPropOn(..., key)` so `instanceStreetProp` never double-applies offsets. */
const calibratedMatrices = new WeakSet<T.Matrix4>();

function hasSpecCalibration(spec: StreetPropSpec): boolean {
  return (
    (spec.yawOffset !== undefined && spec.yawOffset !== 0) ||
    spec.targetHeight !== undefined ||
    (spec.scale !== undefined && spec.scale !== 1) ||
    spec.scaleVec !== undefined
  );
}

/**
 * Computes the local uniform scale factor for a street prop given the caller's matrix Y-scale.
 * When `spec.targetHeight` is set, oversized caller scales are clamped so final world height stays authentic.
 */
function localCalibrationScale(spec: StreetPropSpec, callerScale: number): number {
  const baseScale = spec.scale ?? 1;
  if (spec.targetHeight !== undefined && spec.naturalHeight > 0 && callerScale > 0) {
    const heightCapped = spec.targetHeight / (spec.naturalHeight * callerScale);
    return Math.min(baseScale, heightCapped);
  }
  return baseScale;
}

/** Builds the local-space calibration matrix (Y yaw alignment + optional non-uniform `scaleVec` / uniform scale around Y=0 pivot). */
export function buildStreetPropLocalOffset(
  spec: StreetPropSpec,
  callerScale = 1,
  out = new T.Matrix4(),
): T.Matrix4 {
  const yaw = spec.yawOffset ?? 0;
  const k = localCalibrationScale(spec, callerScale);
  const sx = (spec.scaleVec ? spec.scaleVec[0] : 1) * k;
  const sy = (spec.scaleVec ? spec.scaleVec[1] : 1) * k;
  const sz = (spec.scaleVec ? spec.scaleVec[2] : 1) * k;
  return out.compose(
    ZERO_POS,
    new T.Quaternion().setFromAxisAngle(Y_AXIS, yaw),
    new T.Vector3(sx, sy, sz),
  );
}

/**
 * Placement matrix for a Y=0 grounded, X/Z-centered street or interior prop.
 * Pass optional `key` to bake `spec.yawOffset` and `spec.scale`/`spec.targetHeight` directly into `out`;
 * callers omitting `key` (such as `streaming.ts`) receive the exact same local calibration automatically inside
 * `instanceStreetProp()` with zero double-application.
 */
export function placeStreetPropOn(
  x: number,
  y: number,
  z: number,
  rotY = 0,
  scale: number | readonly [number, number, number] = 1,
  out = new T.Matrix4(),
  key?: StreetPropKey,
): T.Matrix4 {
  const sx = Array.isArray(scale) ? scale[0] : scale;
  const sy = Array.isArray(scale) ? scale[1] : scale;
  const sz = Array.isArray(scale) ? scale[2] : scale;
  out.compose(
    new T.Vector3(x, y, z),
    new T.Quaternion().setFromAxisAngle(Y_AXIS, rotY),
    new T.Vector3(sx, sy, sz),
  );
  if (key) {
    const spec = STREET_PROPS[key];
    if (hasSpecCalibration(spec)) {
      const localOffset = buildStreetPropLocalOffset(spec, sy);
      out.multiply(localOffset);
      calibratedMatrices.add(out);
    }
  }
  return out;
}

/** Computes a tight world-space bounding box & sphere for an InstancedMesh from its exact instance matrices. */
function setTightInstanceBounds(mesh: T.InstancedMesh, partBox: T.Box3 | null, matrices: readonly T.Matrix4[]) {
  if (!partBox || partBox.isEmpty() || matrices.length === 0) {
    mesh.computeBoundingSphere();
    return;
  }
  TMP_UNION.makeEmpty();
  for (let i = 0; i < matrices.length; i++) {
    TMP_BOX.copy(partBox).applyMatrix4(matrices[i]);
    TMP_UNION.union(TMP_BOX);
  }
  mesh.boundingBox = TMP_UNION.clone();
  mesh.boundingSphere = new T.Sphere();
  mesh.boundingBox.getBoundingSphere(mesh.boundingSphere);
}

/** Instanced batch builder: 1 draw call per material across all instances of a streetscape/interior prop with tight bounds. */
export function instanceStreetProp(
  prepared: PreparedStreetProp,
  matrices: readonly T.Matrix4[],
  shadows = true,
): T.Group {
  const group = new T.Group();
  group.name = `street-prop:${prepared.key}`;
  if (!matrices.length) return group;

  const needsCal = hasSpecCalibration(prepared.spec);
  const resolved: readonly T.Matrix4[] = needsCal
    ? matrices.map((m) => {
        if (calibratedMatrices.has(m)) return m;
        const e = m.elements;
        const callerScaleY = Math.hypot(e[4], e[5], e[6]) || 1;
        const localOffset = buildStreetPropLocalOffset(prepared.spec, callerScaleY);
        return new T.Matrix4().multiplyMatrices(m, localOffset);
      })
    : matrices;

  for (const part of prepared.parts) {
    const mesh =
      resolved.length === 1
        ? new T.Mesh(part.geometry, part.material)
        : new T.InstancedMesh(part.geometry, part.material, resolved.length);
    if (mesh instanceof T.InstancedMesh) {
      resolved.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      setTightInstanceBounds(mesh, part.geometry.boundingBox, resolved);
    } else {
      mesh.applyMatrix4(resolved[0]);
    }
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.userData.streetProp = prepared.key;
    group.add(mesh);
  }
  return group;
}

export function streetPropsStats() {
  return {
    defined: Object.keys(STREET_PROPS).length,
    loaded: propPrepared.size,
    inflight: propCache.size - propPrepared.size,
    referenced: propRefs.size,
  };
}

/** Disposes every cached streetscape & interior prop geometry, material, and WebP texture cleanly on unmount. */
export function disposeStreetProps() {
  propEpoch++;
  const residency = getEchoLifeResidencyManager();
  for (const key of propPrepared.keys()) {
    residency.unregister(`street-prop:${key}`);
  }
  for (const p of propPrepared.values()) disposePreparedProp(p);
  propPrepared.clear();
  propCache.clear();
  propRefs.clear();
  propEverAcquired.clear();
  propLastUsed.clear();
  nightEmissiveEntries.length = 0;
  aaaManifestPromise = null;
}
