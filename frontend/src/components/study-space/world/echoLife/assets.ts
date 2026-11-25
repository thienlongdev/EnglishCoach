import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { getInFlightCompileCount, patchMaterialWithEchoCsm } from './echoCsm';
import { patchHeightFog } from './atmosphere';
import type { QualityTier } from './renderConfig';
import { getEchoLifeLoadScheduler, getEchoLifeTextureUploadQueue, LoadPriority } from './loadScheduler';
import { getEchoLifeResidencyManager } from './residencyManager';
import { extractVehicleRig } from './vehicleRigExtractor';

/**
 * Echo Life world assets: Codex (Wave 01–03), Gemini (618-entry) and V3 world models staged by
 * `docs/echo-life/world-2026-11-20/art/stage-assets.sh` and `stage-city31.mjs` (provenance, source SHA-256 and licence
 * per file in `staged-manifest.tsv`). Content-hashed names: immutable caching (10 §BR), zero page-level WASM decoders.
 * Nothing here is fetched until the player explores; streaming chunks acquire and release assets by ref-count with an
 * LRU GPU budget so unreferenced distant assets release their geometries, materials and textures.
 */
import workshopModels from '@/lib/echo-life/game/workshop-models.json';

export const LIFE_ASSETS = {
  ...workshopModels,
  'court-racket': '/echo-life/court/racket-ac54c6ae261d.glb',
  'court-shuttle': '/echo-life/court/shuttle-fa7a04130a33.glb',
  sofa: '/echo-life/sofa-7c56be1322ac.glb',
  tv: '/echo-life/tv-9f9d3fcee8a3.glb',
  fridge: '/echo-life/fridge-c7cb11af3677.glb',
  sink: '/echo-life/sink-20a6eb38acb0.glb',
  stove: '/echo-life/stove-df90146a5a4d.glb',
  hood: '/echo-life/hood-ff96cd6680e1.glb',
  pendant: '/echo-life/pendant-c789c2f7534b.glb',
  floorlamp: '/echo-life/floorlamp-ea0576b68211.glb',
  plant: '/echo-life/plant-6a9b116464a7.glb',
  table: '/echo-life/table-5a5fff03a95e.glb',
  chair: '/echo-life/chair-d3a61f2ebc78.glb',
  basin: '/echo-life/basin-4c58024af2ca.glb',
  shower: '/echo-life/shower-1c7b2dd40a04.glb',
  toilet: '/echo-life/toilet-16123adadb2c.glb',
  mirror: '/echo-life/mirror-28a344987713.glb',
  mailbox: '/echo-life/mailbox-ae40f8786e6a.glb',
  bench: '/echo-life/bench-baf6d06330fc.glb',
  lamp: '/echo-life/lamp-4967163cfa66.glb',
  shelter: '/echo-life/aaa-v2/street/prop_bus_shelter_aaa-16ed1e762011.glb',
  bikerack: '/echo-life/bikerack-2b5d00fbd395.glb',
  bollard: '/echo-life/bollard-99b78917da5b.glb',
  trafficlight: '/echo-life/trafficlight-872060b575eb.glb',
  namepost: '/echo-life/namepost-d4ee6129a06c.glb',
  'tree-banyan': '/echo-life/tree-banyan-dccbc2455d29.glb',
  'tree-flame': '/echo-life/tree-flame-7a480e98cef2.glb',
  'tree-palm': '/echo-life/aaa-v2/botanical/veg_palm_royal_aaa-3c018eade865.glb',
  'cafe-front': '/echo-life/cafe-front-fac990a64b90.glb',
  'market-front': '/echo-life/market-front-7837980edd68.glb',
  'bld-tube': '/echo-life/bld-tube-da8fe9d94697.glb',
  'bld-shophouse': '/echo-life/bld-shophouse-e65c1582834d.glb',
  'bld-dorm': '/echo-life/bld-dorm-11e458c32e84.glb',
  'bld-shophouse-lod': '/echo-life/bld-shophouse-lod-ccea3fa25941.glb',
  'bld-tube-lod': '/echo-life/bld-tube-lod-7208913c23ad.glb',
  'bld-dorm-lod': '/echo-life/bld-dorm-lod-c2a04c5cec41.glb',
  'bld-sub-a': '/echo-life/bld-sub-a-30ab9d523ace.glb',
  'bld-sub-c': '/echo-life/bld-sub-c-570f98e68e40.glb',
  'bld-sub-e': '/echo-life/bld-sub-e-b9bece745b80.glb',
  'bld-sub-h': '/echo-life/bld-sub-h-79a395aa7ffb.glb',
  'bld-sub-k': '/echo-life/bld-sub-k-b5bea17de136.glb',
  'bld-sub-l': '/echo-life/bld-sub-l-9483a30fff87.glb',
  'bld-sub-p': '/echo-life/bld-sub-p-ba110fb827e3.glb',
  'bld-sub-r': '/echo-life/bld-sub-r-010e3cc5798d.glb',
  'bld-tower-a': '/echo-life/bld-tower-a-18e152f711e2.glb',
  'bld-tower-c': '/echo-life/bld-tower-c-4ecf008ded66.glb',
  'bld-tower-d': '/echo-life/bld-tower-d-dbae1540685b.glb',
  // Phase 2 — 31-Zone City Expansion curated assets (Gemini + Codex W01–03 + V3)
  wardrobe: '/echo-life/wardrobe-5d3b2562ed07.glb',
  'bed-single': '/echo-life/bed-single-d83351bc5c2a.glb',
  'gaming-monitor': '/echo-life/gaming-monitor-2b2bea08884d.glb',
  'gaming-desk': '/echo-life/gaming-desk-7f51655e4f10.glb',
  'gaming-pc': '/echo-life/gaming-pc-ed103bc730a4.glb',
  'gaming-chair': '/echo-life/gaming-chair-09eb431da886.glb',
  'arcade-lamp': '/echo-life/arcade-lamp-7dd4cbaad10e.glb',
  'balcony-table': '/echo-life/balcony-table-351592764320.glb',
  workbench: '/echo-life/workbench-6224bde2ed8b.glb',
  'planter-trough': '/echo-life/aaa-v2/botanical/prop_planter_lush_aaa-74a774127ef2.glb',
  bicycle: '/echo-life/bicycle-817f32877dda.glb',
  'art-easel': '/echo-life/art-easel-6cd487349780.glb',
  'bench-cushion': '/echo-life/bench-cushion-04aa46602eba.glb',
  'guitar-electric': '/echo-life/guitar-electric-92f44be98721.glb',
  'guitar-acoustic': '/echo-life/guitar-acoustic-a15816e64d10.glb',
  'cafe-booth': '/echo-life/cafe-booth-a19289963b6a.glb',
  espresso: '/echo-life/espresso-1465b7bc44df.glb',
  'crepe-kiosk': '/echo-life/crepe-kiosk-35ac15eafe86.glb',
  'map-kiosk': '/echo-life/map-kiosk-cef46122d314.glb',
  'tea-service': '/echo-life/tea-service-02db0c23889a.glb',
  'market-shelf': '/echo-life/market-shelf-e34834942882.glb',
  'market-checkout': '/echo-life/market-checkout-2cd5a8d2e870.glb',
  'patisserie-case': '/echo-life/patisserie-case-1bb4a62a81bf.glb',
  'display-cabinet': '/echo-life/display-cabinet-73931189849f.glb',
  'canopy-bed': '/echo-life/canopy-bed-70d0d51f62b1.glb',
  'garment-rack': '/echo-life/garment-rack-a56a2da22934.glb',
  'car-hatch': '/echo-life/car-hatch-5e445d1293da.glb',
  'moto-commuter': '/echo-life/moto-commuter-b7e2b193340d.glb',
  'scooter-ev': '/echo-life/scooter-ev-37c02b40b37f.glb',
  'car-spider': '/echo-life/car-spider-321cd1ad7da9.glb',
  'soaking-tub': '/echo-life/soaking-tub-e1298e611166.glb',
  'kitchen-island': '/echo-life/kitchen-island-800c0a79b6e6.glb',
  photocopier: '/echo-life/photocopier-53c9880dec7d.glb',
  'atm-kiosk': '/echo-life/atm-kiosk-913d50d75b4f.glb',
  'parcel-locker': '/echo-life/parcel-locker-641492701549.glb',
  'campus-gate': '/echo-life/campus-gate-7b8cb68a355e.glb',
  'campus-colonnade': '/echo-life/campus-colonnade-7c6893bddd05.glb',
  'campus-posterboard': '/echo-life/campus-posterboard-85585566a59e.glb',
  'campus-guardhouse': '/echo-life/campus-guardhouse-d1b7f4bb50d2.glb',
  'campus-facade': '/echo-life/campus-facade-703351de73ff.glb',
  'library-table': '/echo-life/library-table-db3f6e4d97c1.glb',
  'library-stack': '/echo-life/library-stack-3eb3ed4c4560.glb',
  'library-trolley': '/echo-life/library-trolley-0766f94a0492.glb',
  'library-desk': '/echo-life/library-desk-196fa0b217c6.glb',
  'fountain-tiered': '/echo-life/fountain-tiered-316758780b4d.glb',
  'whale-monument': '/echo-life/whale-monument-7d53117ca732.glb',
  'festival-stage': '/echo-life/festival-stage-9dc9c7f3d981.glb',
  'festival-truss': '/echo-life/festival-truss-c572cef4463c.glb',
  'statue-obelisk': '/echo-life/statue-obelisk-642a89036f05.glb',
  'festival-booth-en': '/echo-life/festival-booth-en-654b41a1f5ea.glb',
  'festival-lectern': '/echo-life/festival-lectern-2c304f60c9c2.glb',
  'park-gazebo': '/echo-life/aaa-v2/botanical/prop_pergola_vine_aaa-8b29dd32dafe.glb',
  basketball: '/echo-life/aaa-v2/court/basketball_aaa-76834f54cf9e.glb',
  'hoop-post': '/echo-life/aaa-v2/court/hoop_post_aaa-12e7ad6a2765.glb',
  'badminton-net': '/echo-life/badminton-net-c024cfff202b.glb',
  'fair-carousel': '/echo-life/fair-carousel-dc635ca94a02.glb',
  'fair-ferris': '/echo-life/fair-ferris-7bf0715a75b4.glb',
  'fair-arch': '/echo-life/fair-arch-60b2be1e4dda.glb',
  'fair-popcorn': '/echo-life/fair-popcorn-26e0606bdffd.glb',
  'fair-whale-arch': '/echo-life/fair-whale-arch-71389e350588.glb',
  'fair-ringtoss': '/echo-life/fair-ringtoss-31818b29c33a.glb',
  'street-lantern': '/echo-life/street-lantern-4967163cfa66.glb',
  'fair-wheel': '/echo-life/fair-wheel-2a2dde52cc10.glb',
  'paper-lantern': '/echo-life/paper-lantern-858811be235c.glb',
  'watering-can': '/echo-life/watering-can-4bf66e5ae847.glb',
  'patio-set': '/echo-life/patio-set-1473d1faa1a1.glb',
  'bld-minka': '/echo-life/bld-minka-ed4db469ecf2.glb',
  'bld-minka-lod': '/echo-life/bld-minka-lod-9dae339f0ab5.glb',
  'bld-teacourt': '/echo-life/bld-teacourt-626acfb4bff0.glb',
  'bld-teacourt-lod': '/echo-life/bld-teacourt-lod-565fcdb6c8dd.glb',
  'bld-courtyard': '/echo-life/bld-courtyard-68b03ded24ed.glb',
  'bld-courtyard-lod': '/echo-life/bld-courtyard-lod-0782ad1b599f.glb',
  'bld-lanternhouse': '/echo-life/bld-lanternhouse-9c377b6b0280.glb',
  'bld-lanternhouse-lod': '/echo-life/bld-lanternhouse-lod-11fa00503d9a.glb',
  'shop-bookshop': '/echo-life/shop-bookshop-ed84636e5550.glb',
  'shop-bakery': '/echo-life/shop-bakery-361803b495ef.glb',
  'shop-bistro': '/echo-life/shop-bistro-4a673c4a8ada.glb',
  // AAA Evolution v2 — Cycles OptiX WebP + KHR_mesh_quantization (0 WASM, 0 transmission)
  'bld-urban-facade': '/echo-life/aaa-v2/street/bld_urban_facade_aaa-40d19734503a.glb',
  'bld-urban-facade-lod': '/echo-life/aaa-v2/street/bld_urban_facade_aaa_lod1-ac64ab2dff5e.glb',
  'prop-bus-shelter-aaa': '/echo-life/aaa-v2/street/prop_bus_shelter_aaa-16ed1e762011.glb',
  'veg-palm-royal-aaa': '/echo-life/aaa-v2/botanical/veg_palm_royal_aaa-3c018eade865.glb',
  'veg-palm-royal-aaa-lod': '/echo-life/aaa-v2/botanical/veg_palm_royal_aaa_lod1-c16f20a786b7.glb',
  'prop-planter-lush-aaa': '/echo-life/aaa-v2/botanical/prop_planter_lush_aaa-74a774127ef2.glb',
  'prop-pergola-vine-aaa': '/echo-life/aaa-v2/botanical/prop_pergola_vine_aaa-8b29dd32dafe.glb',
  'prop-hedge-trimmed-aaa': '/echo-life/aaa-v2/botanical/prop_hedge_trimmed_aaa-d20026fecb5b.glb',
  'parked-sedan-aaa': '/echo-life/aaa-v2/vehicles/parked_sedan_aaa-406a1236dbd2.glb',
  'parked-hatch-aaa': '/echo-life/aaa-v2/vehicles/parked_hatch_aaa-9c73b7227eba.glb',
  'lib-bookstack-tall-aaa': '/echo-life/aaa-v2/interior/lib_bookstack_tall_aaa-7e74f994d5c9.glb',
} as const;
export type LifeAsset = keyof typeof LIFE_ASSETS;

/** Semantic material role tagged onto each reduced part so foliage/bark tinting & shading never cross-contaminate. */
export type PartRole = 'foliage' | 'blossom' | 'bark' | 'glass' | 'mirror-glass' | 'emissive' | 'textured' | 'painted';

export interface PreparedPart {
  geometry: T.BufferGeometry;
  material: T.Material;
  role: PartRole;
}

/** A model reduced to one geometry per material, in its own metres, with its measured box & estimated texture VRAM. */
export interface Prepared { id: LifeAsset; parts: PreparedPart[]; box: T.Box3; triangles: number; textureBytes: number }

const KEEP = ['position', 'normal', 'tangent', 'uv', 'uv1', 'color'] as const;
const TEXTURE_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap',
  'alphaMap', 'bumpMap', 'displacementMap', 'lightMap',
] as const;

const VEG_ASSET_RE = /^(?:tree-|veg-)|(?:^plant$)|planter|bush|shrub|hedge|fern|flower|grass/i;
const FOLIAGE_MAT_RE = /foliage|leaf|leaves|leaflets|canopy|frond|twig|shrub|bush|hedge|grass|fern|botany|calathea|anthurium/i;
const BLOSSOM_MAT_RE = /blossom|flower|petal|bloom|gazania|ursinia/i;
const BARK_MAT_RE = /bark|trunk|branch|crownshaft|stem/i;
const MIRROR_GLASS_RE = /mirror.*glass|bath_mirror|fitting.*mirror|reflective.*mirror/i;

/**
 * Identifies planar mirror glass surfaces (`Mirror_Glass` / `Bath_Mirror` in `mirror-*.glb`) so
 * `reduce()` and `batchPaint()` never bake them into `paletteMaterials` or fuse them into static
 * room-wide furniture batches (`house.ts` / `buildingsView.ts`).
 */
export function isMirrorGlassMaterial(id: string, material: T.Material, meshName = ''): boolean {
  const matName = material.name ?? '';
  if (MIRROR_GLASS_RE.test(matName) || MIRROR_GLASS_RE.test(meshName)) return true;
  if (
    id === 'mirror' &&
    material instanceof T.MeshStandardMaterial &&
    material.emissive.getHex() === 0 &&
    material.metalness >= 0.9
  ) {
    return true;
  }
  return false;
}

/**
 * Strips `KHR_materials_transmission` (`transmission > 0`) on outdoor/city/lot/vehicle/court GLB materials
 * and converts them into crisp physical Fresnel glass so Three.js NEVER triggers `renderTransmissionPass()`
 * (which double-renders all opaque city meshes every frame and causes shader-program ping-pong on direct tiers).
 */
export function stripTransmissionMaterial(material: T.Material): boolean {
  const phys = material as T.MeshPhysicalMaterial;
  if (!(material instanceof T.MeshPhysicalMaterial) || !(phys.transmission > 0 || phys.transmissionMap)) {
    return false;
  }
  phys.transmission = 0;
  phys.transmissionMap = null;
  phys.thickness = 0;
  phys.thicknessMap = null;
  phys.transparent = true;
  const baseOpacity = Number.isFinite(phys.opacity) && phys.opacity > 0.05 && phys.opacity < 0.99 ? phys.opacity : 0.36;
  phys.opacity = Math.min(0.42, baseOpacity);
  phys.roughness = Math.min(Number.isFinite(phys.roughness) ? phys.roughness : 0.06, 0.06);
  phys.clearcoat = 1.0;
  phys.clearcoatRoughness = Math.min(Number.isFinite(phys.clearcoatRoughness) ? phys.clearcoatRoughness : 0.06, 0.06);
  phys.envMapIntensity = Math.max(Number.isFinite(phys.envMapIntensity) ? phys.envMapIntensity : 1.0, 1.5);
  phys.depthWrite = false;
  phys.needsUpdate = true;
  return true;
}

/** Recursively strips `transmission > 0` across any loaded GLB or Object3D hierarchy. */
export function stripTransmissionFromHierarchy(root: T.Object3D): number {
  let stripped = 0;
  root.traverse((o) => {
    const m = o as T.Mesh;
    if (!m.isMesh || !m.material) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (let i = 0; i < mats.length; i++) {
      if (mats[i] && stripTransmissionMaterial(mats[i])) stripped++;
    }
  });
  return stripped;
}

export interface DemotePhysicalOptions {
  /** Retain `MeshPhysicalMaterial` clearcoat on hero vehicles on High/Ultra tiers. Default `false`. */
  allowClearcoat?: boolean;
}

/**
 * Demotes `MeshPhysicalMaterial`s emitted by Blender glTF export (`KHR_materials_ior`,
 * `KHR_materials_specular`, subtle sheen/clearcoat, or transmission-stripped glass) to lean
 * `MeshStandardMaterial` so static props & interiors do NOT spawn redundant heavy D3D11/FXC
 * `MeshPhysicalMaterial` shader variants. Only hero vehicles on High/Ultra retain `clearcoat`.
 */
export function demotePlainPhysicalMaterial(
  material: T.Material,
  opts: DemotePhysicalOptions = {},
): T.Material {
  if (!(material instanceof T.MeshPhysicalMaterial)) return material;
  const p = material;
  const keepClearcoat =
    Boolean(opts.allowClearcoat) &&
    (p.clearcoat > 0.25 || Boolean(p.clearcoatMap || p.clearcoatNormalMap || p.clearcoatRoughnessMap));
  if (keepClearcoat) return material;

  const adjustedRoughness =
    p.clearcoat > 0.35 ? Math.max(0.06, p.roughness - 0.05) : p.roughness;
  const adjustedMetalness =
    p.transparent && p.clearcoat > 0.5 ? Math.max(p.metalness, 0.12) : p.metalness;

  const std = new T.MeshStandardMaterial({
    name: p.name,
    color: p.color.clone(),
    map: p.map,
    normalMap: p.normalMap,
    normalScale: p.normalScale.clone(),
    normalMapType: p.normalMapType,
    roughness: adjustedRoughness,
    roughnessMap: p.roughnessMap,
    metalness: adjustedMetalness,
    metalnessMap: p.metalnessMap,
    aoMap: p.aoMap,
    aoMapIntensity: p.aoMapIntensity,
    emissive: p.emissive.clone(),
    emissiveIntensity: p.emissiveIntensity,
    emissiveMap: p.emissiveMap,
    alphaMap: p.alphaMap,
    alphaTest: p.alphaTest,
    bumpMap: p.bumpMap,
    bumpScale: p.bumpScale,
    side: p.side,
    flatShading: p.flatShading,
    vertexColors: p.vertexColors,
    envMapIntensity: p.envMapIntensity,
    opacity: p.opacity,
    transparent: p.transparent,
    depthWrite: p.depthWrite,
  });
  std.userData = { ...p.userData };
  return std;
}

// ── Shared GLTF Embedded Texture Deduplication, Tier Resolution Cap & Pre-Decode Skip ──

interface GltfTextureDefLike {
  name?: string;
  source?: number;
  sampler?: number;
  extensions?: { EXT_texture_webp?: { source?: number } };
}

interface GltfImageDefLike {
  bufferView?: number;
  mimeType?: string;
  uri?: string;
}

interface GltfSamplerDefLike {
  magFilter?: number;
  minFilter?: number;
  wrapS?: number;
  wrapT?: number;
}

interface GltfMaterialTexRefLike {
  index?: number;
}

export interface GltfMaterialDefLike {
  name?: string;
  alphaMode?: string;
  pbrMetallicRoughness?: {
    baseColorTexture?: GltfMaterialTexRefLike;
    metallicRoughnessTexture?: GltfMaterialTexRefLike;
  };
  normalTexture?: GltfMaterialTexRefLike;
  occlusionTexture?: GltfMaterialTexRefLike;
  emissiveTexture?: GltfMaterialTexRefLike;
}

export interface GltfParserLike {
  json: {
    textures?: GltfTextureDefLike[];
    images?: GltfImageDefLike[];
    samplers?: GltfSamplerDefLike[];
    materials?: GltfMaterialDefLike[];
  };
  associations: Map<unknown, unknown>;
  getDependency: (type: string, index: number) => Promise<unknown>;
}

export interface GltfTextureDedupPluginOptions {
  /** Hero/focal GLBs receive a higher resolution cap than ambient street props on 4 GB / Balanced tiers. */
  isHero?: boolean;
  /** Optional pre-decode skip predicate (returns `true` to return `Promise.resolve(null)` before decoding). */
  shouldSkipTexture?: (parser: GltfParserLike, textureIndex: number) => boolean;
}

interface SharedSourceEntry {
  readonly key: string;
  readonly source: T.Source<ImageBitmap>;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly activeTextures: Set<T.Texture>;
}

const GLTF_WEBGL_MAG_FILTERS: Record<number, T.MagnificationTextureFilter> = {
  9728: T.NearestFilter,
  9729: T.LinearFilter,
};

const GLTF_WEBGL_MIN_FILTERS: Record<number, T.MinificationTextureFilter> = {
  9728: T.NearestFilter,
  9729: T.LinearFilter,
  9984: T.NearestMipmapNearestFilter,
  9985: T.LinearMipmapNearestFilter,
  9986: T.NearestMipmapLinearFilter,
  9987: T.LinearMipmapLinearFilter,
};

const GLTF_WEBGL_WRAPPINGS: Record<number, T.Wrapping> = {
  33071: T.ClampToEdgeWrapping,
  33648: T.MirroredRepeatWrapping,
  10497: T.RepeatWrapping,
};

const sharedSourcePool = new Map<string, SharedSourceEntry>();
const inflightSourcePool = new Map<string, Promise<SharedSourceEntry | null>>();
let currentTextureTier: QualityTier = 'balanced';
let currentIs4GbGpu = false;
let dedupHits = 0;
let preDecodeSkipped = 0;
let downscaledCount = 0;
let estimatedSavedBytes = 0;

/** Updates tier-aware max GLTF embedded texture resolution (`low: 512`, `balanced/4gb: 512/1024`, `high: 1024`, `ultra: 2048`). */
export function setGltfTextureTier(tier: QualityTier, is4GbGpu?: boolean): void {
  currentTextureTier = tier;
  if (typeof is4GbGpu === 'boolean') currentIs4GbGpu = is4GbGpu;
}

/** Returns `true` when 4 GB VRAM clamping has been locked by the pre-renderer GPU capability probe. */
export function isGltf4GbGpuMode(): boolean {
  return currentIs4GbGpu;
}

/** Returns the effective maximum GLTF embedded texture edge (px) for the active quality tier & VRAM class. */
export function getGltfTextureMaxSize(isHero = false): number {
  if (currentTextureTier === 'low') return 512;
  if (currentTextureTier === 'balanced') {
    if (currentIs4GbGpu) return isHero ? 1024 : 512;
    return isHero ? 1024 : 512;
  }
  if (currentTextureTier === 'high') {
    if (currentIs4GbGpu) return isHero ? 1024 : 512;
    return 1024;
  }
  // ultra
  return currentIs4GbGpu ? 1024 : 2048;
}

/** Fast dual 32-bit FNV-1a content digest for embedded GLTF image bytes (zero crypto overhead). */
function hashBufferBytes(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  const len = bytes.length;
  for (let i = 0; i < len; i++) {
    const b = bytes[i];
    h1 ^= b;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= (b + i) & 0xff;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  h2 ^= h2 >>> 13;
  return `${len}:${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}`;
}

function releaseDedupTextureRef(tex: T.Texture, entry: SharedSourceEntry): void {
  if (!entry.activeTextures.delete(tex)) return;
  if (entry.activeTextures.size === 0) {
    if (sharedSourcePool.get(entry.key) === entry) {
      sharedSourcePool.delete(entry.key);
    }
    const img = entry.source.data as { close?: () => void } | null | undefined;
    if (img && typeof img.close === 'function') {
      try {
        img.close();
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * Registers a `Texture` (including clones made by `GLTFLoader` for `texCoord > 0` or `KHR_TEXTURE_TRANSFORM`)
 * against its shared `THREE.Source` pool entry so `ImageBitmap.close()` waits until the final consumer disposes.
 */
export function retainDedupTexture(tex: T.Texture, directEntry?: SharedSourceEntry): void {
  const key = directEntry?.key ?? (tex.userData?.__dedupSourceKey as string | undefined);
  if (!key) return;
  const entry = directEntry ?? sharedSourcePool.get(key);
  if (!entry || entry.activeTextures.has(tex)) return;
  tex.userData.__dedupSourceKey = key;
  entry.activeTextures.add(tex);
  const onDispose = () => {
    tex.removeEventListener('dispose', onDispose);
    releaseDedupTextureRef(tex, entry);
  };
  tex.addEventListener('dispose', onDispose);
}

/** Returns `true` when `tex` belongs to the ref-counted shared GLTF source pool (do not manually close its `ImageBitmap`). */
export function isDedupManagedTexture(tex: T.Texture): boolean {
  return typeof tex.userData?.__dedupSourceKey === 'string';
}

/** Clears the shared GLTF texture pool on full Study Space unmount. */
export function clearSharedGltfTexturePool(): void {
  inflightSourcePool.clear();
  for (const entry of sharedSourcePool.values()) {
    const img = entry.source.data as { close?: () => void } | null | undefined;
    if (img && typeof img.close === 'function') {
      try {
        img.close();
      } catch {
        /* already closed */
      }
    }
    entry.activeTextures.clear();
  }
  sharedSourcePool.clear();
}

export function getGltfTextureDedupStats() {
  let poolBytes = 0;
  for (const entry of sharedSourcePool.values()) poolBytes += entry.bytes;
  return {
    uniqueSources: sharedSourcePool.size,
    poolBytes,
    dedupHits,
    preDecodeSkipped,
    downscaledCount,
    estimatedSavedBytes,
  };
}

async function decodeAndCapImageBitmap(
  bufferView: ArrayBuffer,
  mimeType: string,
  maxSize: number,
): Promise<{ bitmap: ImageBitmap; width: number; height: number; downscaled: boolean; savedBytes: number }> {
  const blob = new Blob([bufferView], { type: mimeType || 'image/webp' });
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob, {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
      imageOrientation: 'none',
    });
  } catch {
    bmp = await createImageBitmap(blob);
  }
  const origW = bmp.width;
  const origH = bmp.height;
  const maxDim = Math.max(origW, origH);
  if (maxDim <= maxSize || maxSize <= 0) {
    return { bitmap: bmp, width: origW, height: origH, downscaled: false, savedBytes: 0 };
  }
  const scale = maxSize / maxDim;
  const targetW = Math.max(4, Math.round(origW * scale));
  const targetH = Math.max(4, Math.round(origH * scale));
  try {
    const resized = await createImageBitmap(bmp, {
      resizeWidth: targetW,
      resizeHeight: targetH,
      resizeQuality: 'medium',
    });
    try {
      bmp.close();
    } catch {
      /* ignore */
    }
    const saved = Math.max(0, Math.round((origW * origH - targetW * targetH) * 4 * 1.333));
    return { bitmap: resized, width: targetW, height: targetH, downscaled: true, savedBytes: saved };
  } catch {
    // Fallback if resize options unsupported on host runtime
    return { bitmap: bmp, width: origW, height: origH, downscaled: false, savedBytes: 0 };
  }
}

/**
 * Installs Echo Life's shared GLTF embedded-texture plugin at index 0 of `GLTFLoader.pluginCallbacks`
 * (ahead of built-in `EXT_texture_webp`), providing:
 * 1. Pre-decode skip for materials that `reduceProp()` discards (e.g. `prop_bus_shelter_aaa` 6 maps).
 * 2. Content-hashed `THREE.Source` sharing across GLBs (eliminates duplicate `WebGLTexture` GPU allocations).
 * 3. Tier-aware `maxTextureSize` downscaling via `createImageBitmap` before GPU upload.
 */
export function installGltfTextureDedupPlugin(
  targetLoader: GLTFLoader,
  opts: GltfTextureDedupPluginOptions = {},
): void {
  const loaderInternal = targetLoader as unknown as {
    pluginCallbacks?: ((parser: GltfParserLike) => { name: string; loadTexture?: (textureIndex: number) => Promise<T.Texture | null> | null })[];
  };
  if (!Array.isArray(loaderInternal.pluginCallbacks)) return;

  const callback = (parser: GltfParserLike) => ({
    name: 'ECHO_LIFE_TEXTURE_DEDUP',
    loadTexture(textureIndex: number): Promise<T.Texture | null> | null {
      // 1. Pre-decode skip for structural textures discarded during reduction
      if (opts.shouldSkipTexture && opts.shouldSkipTexture(parser, textureIndex)) {
        preDecodeSkipped++;
        return Promise.resolve(null);
      }

      // Only intercept embedded bufferView images when createImageBitmap & Blob are available
      if (typeof createImageBitmap !== 'function' || typeof Blob === 'undefined') {
        return null;
      }

      const json = parser.json;
      const textureDef = json.textures?.[textureIndex];
      if (!textureDef) return null;
      const sourceIndex = textureDef.extensions?.EXT_texture_webp?.source ?? textureDef.source;
      if (sourceIndex === undefined) return null;
      const imageDef = json.images?.[sourceIndex];
      if (!imageDef || imageDef.bufferView === undefined) return null;

      const maxSize = getGltfTextureMaxSize(Boolean(opts.isHero));
      const mimeType = imageDef.mimeType || 'image/webp';
      const sampler = textureDef.sampler !== undefined ? json.samplers?.[textureDef.sampler] ?? {} : {};

      return parser
        .getDependency('bufferView', imageDef.bufferView)
        .then(async (rawBuf): Promise<T.Texture | null> => {
          if (!(rawBuf instanceof ArrayBuffer)) return null;
          const poolKey = `${hashBufferBytes(rawBuf)}@${maxSize}`;

          let entry = sharedSourcePool.get(poolKey);
          if (entry) {
            dedupHits++;
            estimatedSavedBytes += entry.bytes;
          } else {
            let pending = inflightSourcePool.get(poolKey);
            if (!pending) {
              pending = decodeAndCapImageBitmap(rawBuf, mimeType, maxSize)
                .then(({ bitmap, width, height, downscaled, savedBytes }) => {
                  const bytes = Math.round(width * height * 4 * 1.333);
                  if (downscaled) {
                    downscaledCount++;
                    estimatedSavedBytes += savedBytes;
                  }
                  const created: SharedSourceEntry = {
                    key: poolKey,
                    source: new T.Source(bitmap),
                    width,
                    height,
                    bytes,
                    activeTextures: new Set<T.Texture>(),
                  };
                  sharedSourcePool.set(poolKey, created);
                  return created;
                })
                .catch(() => null)
                .finally(() => {
                  inflightSourcePool.delete(poolKey);
                });
              inflightSourcePool.set(poolKey, pending);
            } else {
              dedupHits++;
            }
            const resolved = await pending;
            if (!resolved) return null;
            entry = resolved;
          }

          const texture = new T.Texture();
          texture.source = entry.source;
          texture.flipY = false;
          if (textureDef.name) texture.name = textureDef.name;
          texture.magFilter = (sampler.magFilter !== undefined && GLTF_WEBGL_MAG_FILTERS[sampler.magFilter]) || T.LinearFilter;
          texture.minFilter =
            (sampler.minFilter !== undefined && GLTF_WEBGL_MIN_FILTERS[sampler.minFilter]) || T.LinearMipmapLinearFilter;
          texture.wrapS = (sampler.wrapS !== undefined && GLTF_WEBGL_WRAPPINGS[sampler.wrapS]) || T.RepeatWrapping;
          texture.wrapT = (sampler.wrapT !== undefined && GLTF_WEBGL_WRAPPINGS[sampler.wrapT]) || T.RepeatWrapping;
          texture.needsUpdate = true;
          parser.associations.set(texture, { textures: textureIndex });
          retainDedupTexture(texture, entry);
          return texture;
        });
    },
  });

  // Prepend ahead of built-in `EXT_texture_webp` so embedded WebPs also pass through dedup & tier cap!
  loaderInternal.pluginCallbacks.unshift(callback);
}

function estimateTextureBytes(tex: T.Texture): number {
  const img = tex.image as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number } | undefined;
  const w = Math.max(16, img?.width ?? img?.naturalWidth ?? 256);
  const h = Math.max(16, img?.height ?? img?.naturalHeight ?? 256);
  // RGBA8 uncompressed GPU footprint (+33% mipmap chain when enabled).
  return Math.round(w * h * 4 * (tex.generateMipmaps !== false ? 1.333 : 1));
}

function estimatePartsTextureBytes(parts: readonly PreparedPart[]): number {
  const seen = new Set<T.Texture>();
  let total = 0;
  for (const part of parts) {
    if (isPalettePaintMaterial(part.material)) continue;
    const rec = part.material as unknown as Record<string, unknown>;
    for (const slot of TEXTURE_SLOTS) {
      const tex = rec[slot];
      if (tex instanceof T.Texture && tex !== finishMap && !seen.has(tex)) {
        seen.add(tex);
        total += estimateTextureBytes(tex);
      }
    }
  }
  return total;
}

function isVegetationAsset(id: string): boolean {
  return VEG_ASSET_RE.test(id);
}

function hasAnyTexture(material: T.Material): boolean {
  const m = material as unknown as Record<string, unknown>;
  for (const slot of TEXTURE_SLOTS) {
    if (m[slot] instanceof T.Texture) return true;
  }
  return Object.values(m).some(v => v instanceof T.Texture);
}

function hasDetailPbrTextures(material: T.Material): boolean {
  const m = material as unknown as Record<string, unknown>;
  for (const slot of [
    'normalMap',
    'roughnessMap',
    'metalnessMap',
    'aoMap',
    'emissiveMap',
    'alphaMap',
    'bumpMap',
    'displacementMap',
    'lightMap',
  ] as const) {
    if (m[slot] instanceof T.Texture) return true;
  }
  return false;
}

function classifyPartRole(id: string, material: T.Material, meshName = ''): PartRole {
  if (isMirrorGlassMaterial(id, material, meshName)) return 'mirror-glass';
  const name = material.name ?? '';
  if (BLOSSOM_MAT_RE.test(name)) return 'blossom';
  if (BARK_MAT_RE.test(name)) return 'bark';
  if (FOLIAGE_MAT_RE.test(name)) return 'foliage';
  if (material instanceof T.MeshStandardMaterial) {
    if (material.transparent) return 'glass';
    if (material.emissive.getHex() !== 0 || material.emissiveMap) return 'emissive';
    if (material.alphaTest > 0 && isVegetationAsset(id)) return 'foliage';
    if (hasAnyTexture(material)) return 'textured';
  }
  return 'painted';
}

// The factory's solid-painted non-vegetation meshes often use a separate flat PBR material per piece.
// Encode albedo in vertex colors and (metalness, roughness) in `uv1` (`finishMap.channel = 1`) so
// authored `uv` (`uv0`), vegetation/bark/foliage materials, `alphaTest`, and textured PBR maps remain untouched.
const paletteMaterials = new Map<T.Side, T.MeshStandardMaterial>();
let lodGlassMaterial: T.MeshStandardMaterial | undefined;
let finishMap: T.DataTexture | undefined;
let currentAnisotropy = 4;

export function isPalettePaintMaterial(material: T.Material): boolean {
  return (
    Boolean(material.userData?.isPalettePaint) ||
    paletteMaterials.get(material.side) === material ||
    (lodGlassMaterial !== undefined && material === lodGlassMaterial)
  );
}

function applyMaterialAnisotropy(material: T.Material, aniso: number): void {
  if (isPalettePaintMaterial(material)) return;
  const m = material as unknown as Record<string, unknown>;
  for (const slot of TEXTURE_SLOTS) {
    const tex = m[slot];
    if (tex instanceof T.Texture && tex !== finishMap) {
      if (tex.anisotropy !== aniso) {
        tex.anisotropy = aniso;
        if (tex.image) tex.needsUpdate = true;
      }
    }
  }
}

/** Updates texture anisotropy across all cached and future Echo Life GLTF assets (1 / 4 / 8 / 16× per quality tier). */
export function setLifeAssetsAnisotropy(maxAniso: number): void {
  const next = Math.max(1, Math.min(16, Math.floor(Number.isFinite(maxAniso) ? maxAniso : 1)));
  if (next === currentAnisotropy) return;
  currentAnisotropy = next;
  for (const p of preparedById.values()) {
    for (const part of p.parts) applyMaterialAnisotropy(part.material, next);
  }
}

function getOrCreateFinishMap(): T.DataTexture {
  if (!finishMap) {
    const data = new Uint8Array(256 * 256 * 4);
    for (let i = 0; i < 65536; i++) {
      data[i * 4 + 1] = i >> 8;
      data[i * 4 + 2] = i & 255;
      data[i * 4 + 3] = 255;
    }
    finishMap = new T.DataTexture(data, 256, 256);
    finishMap.channel = 1;
    finishMap.minFilter = T.NearestFilter;
    finishMap.magFilter = T.NearestFilter;
    finishMap.generateMipmaps = false;
    finishMap.needsUpdate = true;
  }
  return finishMap;
}

function getOrCreateLodGlassMaterial(): T.MeshStandardMaterial {
  if (!lodGlassMaterial) {
    lodGlassMaterial = new T.MeshStandardMaterial({
      name: 'echo-life-lod-glass',
      color: '#4f858d',
      roughness: 0.18,
      metalness: 0.32,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
      side: T.DoubleSide,
    });
    lodGlassMaterial.userData.isPalettePaint = true;
  }
  return lodGlassMaterial;
}

function batchPaint(id: LifeAsset, geometry: T.BufferGeometry, material: T.Material): T.Material {
  const isLodShell = id.startsWith('bld-') && id.endsWith('-lod');

  // Share 1 pooled glass material across all untextured transparent `bld-*-lod` windows (`Optical_smoke`)
  // so every decorative LOD building collapses cleanly into just 2 draws (1 opaque + 1 glass)!
  if (
    isLodShell &&
    material instanceof T.MeshStandardMaterial &&
    material.transparent &&
    material.emissive.getHex() === 0 &&
    !hasAnyTexture(material)
  ) {
    return getOrCreateLodGlassMaterial();
  }

  // On legacy `bld-*-lod` shells, opaque materials with only tiny grayscale grain maps (no normal/roughness/metalness/ao/emissive maps)
  // bake cleanly into the single shared vertex-colored `paletteMaterials` (`7-8 -> 2` draws & 0 texture VRAM per shell!).
  const allowLodGrainBake =
    isLodShell &&
    material instanceof T.MeshStandardMaterial &&
    !hasDetailPbrTextures(material);

  if (
    !(material instanceof T.MeshStandardMaterial) ||
    material.type !== 'MeshStandardMaterial' ||
    material.userData?.partRole === 'mirror-glass' ||
    isMirrorGlassMaterial(id, material) ||
    material.transparent ||
    material.alphaTest > 0 ||
    material.flatShading ||
    material.emissive.getHex() !== 0 ||
    material.opacity !== 1 ||
    isVegetationAsset(id) ||
    FOLIAGE_MAT_RE.test(material.name) ||
    BLOSSOM_MAT_RE.test(material.name) ||
    BARK_MAT_RE.test(material.name) ||
    geometry.hasAttribute('color') ||
    geometry.hasAttribute('uv1') ||
    (!allowLodGrainBake && hasAnyTexture(material))
  ) {
    return material;
  }
  const targetSide = isLodShell ? T.FrontSide : material.side;
  let paint = paletteMaterials.get(targetSide);
  if (!paint) {
    const lookup = getOrCreateFinishMap();
    paint = new T.MeshStandardMaterial({
      vertexColors: true,
      side: targetSide,
      roughness: 1,
      metalness: 1,
      roughnessMap: lookup,
      metalnessMap: lookup,
    });
    paint.userData.isPalettePaint = true;
    paletteMaterials.set(targetSide, paint);
  }
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  const uv1 = new Float32Array(count * 2);
  // Quantize roughness slightly on LOD shells (±0.15 tolerance) while keeping exact metalness/roughness fidelity in `finishMap`.
  const effRough = isLodShell ? Math.round(T.MathUtils.clamp(material.roughness, 0, 1) * 10) / 10 : T.MathUtils.clamp(material.roughness, 0, 1);
  const u = (Math.round(255 * T.MathUtils.clamp(material.metalness, 0, 1)) + 0.5) / 256;
  const v = (Math.round(255 * effRough) + 0.5) / 256;
  const grainScale = allowLodGrainBake && material.map ? 0.94 : 1.0;
  const cr = material.color.r * grainScale;
  const cg = material.color.g * grainScale;
  const cb = material.color.b * grainScale;
  for (let i = 0; i < count; i++) {
    colors[i * 3] = cr;
    colors[i * 3 + 1] = cg;
    colors[i * 3 + 2] = cb;
    uv1[i * 2] = u;
    uv1[i * 2 + 1] = v;
  }
  geometry.setAttribute('color', new T.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv1', new T.Float32BufferAttribute(uv1, 2));
  return paint;
}

/**
 * Unpacks interleaved, quantized, normalized, or non-Float32 attributes into clean Float32BufferAttributes
 * with `gpuType = FloatType` so `BufferGeometryUtils.mergeAttributes()` never fails on mixed `gpuType` / array types.
 */
function normalizeAttributeToFloat32(
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
  if (itemSize === 1) {
    for (let i = 0; i < count; i++) out[i] = attr.getX(i);
  } else if (itemSize === 2) {
    for (let i = 0; i < count; i++) {
      out[i * 2] = attr.getX(i);
      out[i * 2 + 1] = attr.getY(i);
    }
  } else if (itemSize === 3) {
    for (let i = 0; i < count; i++) {
      out[i * 3] = attr.getX(i);
      out[i * 3 + 1] = attr.getY(i);
      out[i * 3 + 2] = attr.getZ(i);
    }
  } else if (itemSize === 4) {
    for (let i = 0; i < count; i++) {
      out[i * 4] = attr.getX(i);
      out[i * 4 + 1] = attr.getY(i);
      out[i * 4 + 2] = attr.getZ(i);
      out[i * 4 + 3] = attr.getW(i);
    }
  } else {
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < itemSize; c++) out[i * itemSize + c] = attr.getComponent(i, c);
    }
  }
  return new T.Float32BufferAttribute(out, itemSize);
}

function ensureTypedIndex(g: T.BufferGeometry): void {
  if (g.index) {
    const idx = g.index;
    const isInterleaved = Boolean((idx as unknown as T.InterleavedBufferAttribute).isInterleavedBufferAttribute);
    if (isInterleaved) {
      const count = idx.count;
      const maxVert = g.attributes.position.count;
      const arr = maxVert > 65535 ? new Uint32Array(count) : new Uint16Array(count);
      for (let i = 0; i < count; i++) arr[i] = idx.getX(i);
      g.setIndex(new T.BufferAttribute(arr, 1));
    }
    return;
  }
  const count = g.attributes.position.count;
  const arr = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
  for (let i = 0; i < count; i++) arr[i] = i;
  g.setIndex(new T.BufferAttribute(arr, 1));
}

function flipTriangleWinding(g: T.BufferGeometry): void {
  const index = g.index;
  if (index) {
    const arr = index.array;
    for (let i = 0; i + 2 < arr.length; i += 3) {
      const tmp = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = tmp;
    }
    index.needsUpdate = true;
  }
  const tangent = g.getAttribute('tangent');
  if (tangent && tangent.itemSize === 4) {
    for (let i = 0; i < tangent.count; i++) tangent.setW(i, -tangent.getW(i));
    tangent.needsUpdate = true;
  }
}

/**
 * Ensures all geometries in a material batch share an identical attribute schema, itemSize,
 * Float32Array backing, and `gpuType = FloatType` before `mergeGeometries()`.
 */
function harmonizeGeometryGroup(list: T.BufferGeometry[]): void {
  if (list.length <= 1) return;

  let anyUv1 = false;
  let anyColor = false;
  let colorSize = 3;
  let allHaveValidTangent = true;

  for (const g of list) {
    ensureTypedIndex(g);
    if (!g.hasAttribute('normal')) g.computeVertexNormals();
    if (!g.hasAttribute('uv')) {
      g.setAttribute('uv', new T.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    }
    if (g.hasAttribute('uv1')) anyUv1 = true;
    const col = g.getAttribute('color');
    if (col) {
      anyColor = true;
      if (col.itemSize === 4) colorSize = 4;
    }
    const tan = g.getAttribute('tangent');
    if (!tan || tan.itemSize !== 4) allHaveValidTangent = false;
  }

  for (const g of list) {
    const count = g.attributes.position.count;

    if (anyUv1 && !g.hasAttribute('uv1')) {
      const uv0 = g.getAttribute('uv');
      const copy = new Float32Array(count * 2);
      if (uv0 && uv0.itemSize === 2) {
        for (let i = 0; i < count; i++) {
          copy[i * 2] = uv0.getX(i);
          copy[i * 2 + 1] = uv0.getY(i);
        }
      }
      g.setAttribute('uv1', new T.Float32BufferAttribute(copy, 2));
    }

    if (anyColor) {
      const col = g.getAttribute('color');
      if (!col) {
        const white = new Float32Array(count * colorSize);
        white.fill(1);
        g.setAttribute('color', new T.Float32BufferAttribute(white, colorSize));
      } else if (col.itemSize !== colorSize) {
        const widened = new Float32Array(count * colorSize);
        for (let i = 0; i < count; i++) {
          widened[i * colorSize] = col.getX(i);
          widened[i * colorSize + 1] = col.getY(i);
          widened[i * colorSize + 2] = col.getZ(i);
          if (colorSize === 4) widened[i * colorSize + 3] = col.itemSize >= 4 ? col.getW(i) : 1;
        }
        g.setAttribute('color', new T.Float32BufferAttribute(widened, colorSize));
      }
    }

    if (!allHaveValidTangent && g.hasAttribute('tangent')) {
      g.deleteAttribute('tangent');
    }

    // Final pass: verify every attribute has Float32BufferAttribute + FloatType gpuType.
    for (const name of Object.keys(g.attributes)) {
      const a = g.getAttribute(name);
      if (a) g.setAttribute(name, normalizeAttributeToFloat32(a));
    }
  }
}

function disposeSceneResources(
  scene: T.Object3D,
  keepMaterials?: ReadonlySet<T.Material>,
  keepTextures?: ReadonlySet<T.Texture>,
): void {
  const geometries = new Set<T.BufferGeometry>();
  const materials = new Set<T.Material>();
  const textures = new Set<T.Texture>();

  scene.traverse(o => {
    const m = o as T.Mesh;
    if (!m.isMesh) return;
    if (m.geometry) geometries.add(m.geometry);
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      if (!mat) continue;
      if (!keepMaterials?.has(mat) && !isPalettePaintMaterial(mat)) {
        materials.add(mat);
      }
      const rec = mat as unknown as Record<string, unknown>;
      for (const slot of TEXTURE_SLOTS) {
        const tex = rec[slot];
        if (tex instanceof T.Texture && tex !== finishMap && !keepTextures?.has(tex)) {
          textures.add(tex);
        }
      }
    }
  });

  for (const g of geometries) g.dispose();
  for (const t of textures) t.dispose();
  for (const m of materials) m.dispose();
}
/** Idle retention window (ms) for unreferenced non-core assets before GPU LRU eviction. */
const PRUNE_IDLE_MS = 30_000;
const VEHICLE_ASSET_RE = /^(car-|moto-|scooter-|vespa)/i;

/**
 * Small 0-texture core `bld-*-lod` shells pinned across district loops so Park <-> Market <-> Library
 * traversal NEVER re-parses the same lightweight background building GLBs (0 MB texture VRAM!).
 */
const PINNED_CORE_LOD_ASSETS = new Set<LifeAsset>([
  'bld-shophouse-lod',
  'bld-tube-lod',
  'bld-dorm-lod',
  'bld-courtyard-lod',
  'bld-minka-lod',
  'bld-teacourt-lod',
  'bld-lanternhouse-lod',
]);

let loader: GLTFLoader | null = null;
const cache = new Map<LifeAsset, Promise<Prepared | null>>();
const preparedById = new Map<LifeAsset, Prepared>();
const refs = new Map<LifeAsset, number>();
const lastUsed = new Map<LifeAsset, number>();
const lastUsedTime = new Map<LifeAsset, number>();
let clock = 0;
let epoch = 0;

/** Fit open strings to the factory net panel. The posts and top tape retain their original meshes. */
function badmintonStrings(panel: T.BufferGeometry) {
  panel.computeBoundingBox();
  const {min, max} = panel.boundingBox!;
  const positions: number[] = [];
  const z = (min.z + max.z) / 2;
  const strip = (left: number, bottom: number, right: number, top: number) => {
    positions.push(left,bottom,z, right,bottom,z, right,top,z, left,bottom,z, right,top,z, left,top,z);
  };
  const halfCord = .0013;
  const columns = Math.ceil((max.x - min.x) / .025);
  const rows = Math.ceil((max.y - min.y) / .025);
  for (let i=0; i<=columns; i++) {
    const x = T.MathUtils.lerp(min.x, max.x, i / columns);
    strip(Math.max(min.x,x-halfCord),min.y,Math.min(max.x,x+halfCord),max.y);
  }
  for (let i=0; i<=rows; i++) {
    const y = T.MathUtils.lerp(min.y, max.y, i / rows);
    strip(min.x,Math.max(min.y,y-halfCord),max.x,Math.min(max.y,y+halfCord));
  }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  return geometry;
}

function reduce(id: LifeAsset, scene: T.Object3D): Prepared {
  scene.updateMatrixWorld(true);
  const groups = new Map<T.Material, { role: PartRole; geometries: T.BufferGeometry[] }>();
  const demotedByOrig = new Map<T.Material, T.Material>();
  const allowClearcoat = VEHICLE_ASSET_RE.test(id) && (currentTextureTier === 'high' || currentTextureTier === 'ultra');
  scene.traverse(o => {
    const m = o as T.Mesh;
    if (!m.isMesh || (m as unknown as T.SkinnedMesh).isSkinnedMesh) return;
    const materials = Array.isArray(m.material) ? m.material : [m.material];
    if (materials.length !== 1 || !materials[0]) return;
    const g = id === 'badminton-net' && m.name === 'Net_Mesh'
      ? badmintonStrings(m.geometry) : m.geometry.clone();

    // Strip unsupported attributes first, then unpack all interleaved/quantized/non-Float32 attributes
    // BEFORE baking world transforms so shared InterleavedBuffers cannot alias and `gpuType` stays FloatType.
    g.morphAttributes = {};
    for (const name of Object.keys(g.attributes)) {
      if (!(KEEP as readonly string[]).includes(name)) g.deleteAttribute(name);
    }
    if (!g.attributes.position) { g.dispose(); return; }
    for (const name of Object.keys(g.attributes)) {
      const a = g.getAttribute(name);
      if (a) g.setAttribute(name, normalizeAttributeToFloat32(a));
    }

    const det = m.matrixWorld.determinant();
    g.applyMatrix4(m.matrixWorld);
    ensureTypedIndex(g);
    if (det < 0) flipTriangleWinding(g);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) {
      g.setAttribute('uv', new T.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    }

    const rawMaterial = materials[0];
    stripTransmissionMaterial(rawMaterial);
    let originalMaterial = demotedByOrig.get(rawMaterial);
    if (!originalMaterial) {
      originalMaterial = demotePlainPhysicalMaterial(rawMaterial, { allowClearcoat });
      // Upgrade flat salmon-pink Kenney `bench-cushion` to warm upholstered linen & walnut PBR!
      if (id === 'bench-cushion' && originalMaterial instanceof T.MeshStandardMaterial) {
        const lowerName = (originalMaterial.name || '').toLowerCase();
        const isSalmonCushion =
          lowerName.includes('carpet') ||
          (originalMaterial.color.r > 0.78 && originalMaterial.color.g < 0.50 && originalMaterial.color.b < 0.45);
        if (isSalmonCushion) {
          originalMaterial.color.set('#b9a88e');
          originalMaterial.roughness = 0.90;
          originalMaterial.metalness = 0.0;
        } else if (lowerName.includes('wood')) {
          originalMaterial.color.set('#6f4c30');
          originalMaterial.roughness = 0.56;
          originalMaterial.metalness = 0.04;
        }
      }
      if (id.startsWith('bld-urban-facade') && !originalMaterial.transparent) {
        originalMaterial.side = T.DoubleSide;
      }
      demotedByOrig.set(rawMaterial, originalMaterial);
    }
    const role = classifyPartRole(id, originalMaterial, m.name);
    if (role === 'mirror-glass') {
      originalMaterial.userData.partRole = 'mirror-glass';
      originalMaterial.userData.isMirrorGlass = true;
    }
    const material = role === 'mirror-glass' ? originalMaterial : batchPaint(id, g, originalMaterial);
    const entry = groups.get(material);
    if (entry) {
      entry.geometries.push(g);
    } else {
      groups.set(material, { role, geometries: [g] });
    }
  });

  const uploadQueue = getEchoLifeTextureUploadQueue();
  const parts: PreparedPart[] = [];
  let triangles = 0;
  for (const [material, entry] of groups) {
    const list = entry.geometries;
    const mat = material as T.MeshStandardMaterial;
    if (mat.transparent) mat.depthWrite = false;
    applyMaterialAnisotropy(material, currentAnisotropy);
    material.userData.partRole = entry.role;
    patchMaterialWithEchoCsm(material);
    patchHeightFog(material);

    // Retain any cloned dedup textures & enqueue time-sliced GPU uploads before first draw!
    if (!isPalettePaintMaterial(material)) {
      const rec = material as unknown as Record<string, unknown>;
      for (const slot of TEXTURE_SLOTS) {
        const tex = rec[slot];
        if (tex instanceof T.Texture && tex !== finishMap) {
          retainDedupTexture(tex);
          uploadQueue.enqueue(tex);
        }
      }
    }

    if (list.length === 1) {
      const single = list[0];
      single.computeBoundingBox();
      single.computeBoundingSphere();
      triangles += (single.index?.count ?? single.attributes.position.count) / 3;
      parts.push({ geometry: single, material, role: entry.role });
      continue;
    }

    harmonizeGeometryGroup(list);
    const merged = mergeGeometries(list, false);
    if (merged) {
      for (const g of list) g.dispose();
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      triangles += (merged.index?.count ?? merged.attributes.position.count) / 3;
      parts.push({ geometry: merged, material, role: entry.role });
    } else {
      // Defensive fallback: never silently drop geometry if an unexpected attribute incompatibility occurs.
      for (const g of list) {
        g.computeBoundingBox();
        g.computeBoundingSphere();
        triangles += (g.index?.count ?? g.attributes.position.count) / 3;
        parts.push({ geometry: g, material, role: entry.role });
      }
    }
  }

  const box = new T.Box3();
  for (const p of parts) {
    if (p.geometry.boundingBox) box.union(p.geometry.boundingBox);
  }
  const textureBytes = estimatePartsTextureBytes(parts);
  return { id, parts, box, triangles, textureBytes };
}

function releasePrepared(p: Prepared) {
  const disposedMaterials = new Set<T.Material>();
  const disposedTextures = new Set<T.Texture>();
  const disposeTex = (tex: unknown) => {
    if (!(tex instanceof T.Texture) || tex === finishMap || disposedTextures.has(tex)) return;
    disposedTextures.add(tex);
    const managedByDedup = isDedupManagedTexture(tex);
    tex.dispose();
    if (!managedByDedup && !T.Cache.enabled && typeof ImageBitmap !== 'undefined' && tex.source?.data instanceof ImageBitmap) {
      try { tex.source.data.close(); } catch { /* already closed */ }
    }
  };
  for (const part of p.parts) {
    part.geometry.dispose();
    const m = part.material;
    if (isPalettePaintMaterial(m) || disposedMaterials.has(m)) continue;
    disposedMaterials.add(m);
    const rec = m as unknown as Record<string, unknown>;
    for (const slot of TEXTURE_SLOTS) disposeTex(rec[slot]);
    for (const val of Object.values(rec)) disposeTex(val);
    m.dispose();
  }
}

function evictLifeAssetById(id: LifeAsset): boolean {
  if ((refs.get(id) ?? 0) > 0 || PINNED_CORE_LOD_ASSETS.has(id)) return false;
  if (getInFlightCompileCount() > 0) return false;
  const p = preparedById.get(id);
  if (!p) return false;
  releasePrepared(p);
  preparedById.delete(id);
  cache.delete(id);
  lastUsed.delete(id);
  lastUsedTime.delete(id);
  return true;
}

function getOrCreateLifeLoader(): GLTFLoader {
  if (!loader) {
    loader = new GLTFLoader();
    installGltfTextureDedupPlugin(loader, { isHero: false });
  }
  return loader;
}

export function loadLifeAsset(id: LifeAsset): Promise<Prepared | null> {
  lastUsed.set(id, ++clock);
  lastUsedTime.set(id, Date.now());
  const hit = cache.get(id);
  if (hit) return hit;
  const at = epoch;
  const currentLoader = getOrCreateLifeLoader();
  const scheduler = getEchoLifeLoadScheduler();
  const priority = (refs.get(id) ?? 0) > 0 ? LoadPriority.P1_PREFETCH : LoadPriority.P3_BACKGROUND;
  const residencyKey = `life-asset:${id}`;

  const p = scheduler
    .scheduleLoad(
      residencyKey,
      priority,
      () => currentLoader.loadAsync(LIFE_ASSETS[id]),
      {
        onDiscardLateResult: (lateGltf) => {
          if (lateGltf?.scene) disposeSceneResources(lateGltf.scene);
        },
      },
    )
    .then(async (g) => {
      if (!g) return null;
      if (at !== epoch) {
        disposeSceneResources(g.scene);
        return null;
      }
      const out = await scheduler.scheduleCommit(
        `${residencyKey}:reduce`,
        priority,
        () => {
          if (id === 'bicycle') {
            extractVehicleRig(g.scene, 'bicycle');
          }
          const reduced = reduce(id, g.scene);
          const keepMaterials = new Set<T.Material>();
          const keepTextures = new Set<T.Texture>();
          for (const part of reduced.parts) {
            keepMaterials.add(part.material);
            const rec = part.material as unknown as Record<string, unknown>;
            for (const slot of TEXTURE_SLOTS) {
              const tex = rec[slot];
              if (tex instanceof T.Texture) keepTextures.add(tex);
            }
          }
          disposeSceneResources(g.scene, keepMaterials, keepTextures);
          return reduced;
        },
      );
      if (!out) return null;
      if (at !== epoch) {
        releasePrepared(out);
        return null;
      }
      preparedById.set(id, out);
      lastUsedTime.set(id, Date.now());
      const residency = getEchoLifeResidencyManager();
      const estimatedBytes = Math.max(16_384, out.textureBytes + Math.round(out.triangles * 48));
      residency.register({
        key: residencyKey,
        category: PINNED_CORE_LOD_ASSETS.has(id) ? 'core' : VEHICLE_ASSET_RE.test(id) ? 'vehicle' : 'prop',
        estimatedBytes,
        pinned: PINNED_CORE_LOD_ASSETS.has(id),
        minRetentionSec: 35,
        dispose: () => {
          evictLifeAssetById(id);
        },
      });
      if ((refs.get(id) ?? 0) > 0) {
        residency.acquire(residencyKey);
      }
      return out;
    })
    .catch(() => {
      if (at === epoch) cache.delete(id);
      return null;
    });
  cache.set(id, p);
  return p;
}

/** Acquires an asset with ref-counting for a mounted chunk or building. */
export function acquireLifeAsset(id: LifeAsset): Promise<Prepared | null> {
  const prev = refs.get(id) ?? 0;
  refs.set(id, prev + 1);
  lastUsedTime.set(id, Date.now());
  if (prev === 0 && preparedById.has(id)) {
    getEchoLifeResidencyManager().acquire(`life-asset:${id}`);
  }
  return loadLifeAsset(id);
}

/** Releases a chunk's hold on an asset; unreferenced assets remain warm until residency LRU evicts them. */
export function releaseLifeAsset(id: LifeAsset) {
  const next = (refs.get(id) ?? 0) - 1;
  if (next <= 0) {
    refs.delete(id);
    getEchoLifeResidencyManager().release(`life-asset:${id}`);
  } else {
    refs.set(id, next);
  }
  lastUsedTime.set(id, Date.now());
}

/** Background prefetch without holding a ref-count (warm chunk preparation). */
export function prefetchLifeAsset(id: LifeAsset) {
  if (!cache.has(id)) void loadLifeAsset(id);
}

export interface PruneLifeAssetsOptions {
  /** Target max cached asset count (default 64). */
  maxTotal?: number;
  /** When true, runs residency pressure eviction while still honoring `minRetentionSec` & compile guards. */
  aggressive?: boolean;
  /** Idle age threshold in ms before evicting an unreferenced non-pinned asset (floor `15_000 ms`). */
  maxIdleMs?: number;
}

/**
 * Evicts least-recently-used unreferenced GPU assets via `EchoLifeResidencyManager` while strictly
 * guarding against mid-compile disposal (`getInFlightCompileCount() > 0`) and `0 ms` thrashing.
 */
export function pruneLifeAssets(maxTotalOrOpts: number | PruneLifeAssetsOptions = 64): number {
  if (getInFlightCompileCount() > 0) return 0;

  const opts: PruneLifeAssetsOptions =
    typeof maxTotalOrOpts === 'number'
      ? { maxTotal: maxTotalOrOpts, aggressive: maxTotalOrOpts <= 8 }
      : maxTotalOrOpts;
  const aggressive = Boolean(opts.aggressive);
  const maxTotal = Math.max(16, opts.maxTotal ?? 64);
  const maxIdleMs = Math.max(15_000, opts.maxIdleMs ?? PRUNE_IDLE_MS);
  const now = Date.now();

  let evicted = getEchoLifeResidencyManager().evictIfNeeded();

  const idle = [...preparedById.keys()]
    .filter((id) => (refs.get(id) ?? 0) === 0 && !PINNED_CORE_LOD_ASSETS.has(id))
    .sort((a, b) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0));

  for (const id of idle) {
    if (getInFlightCompileCount() > 0) break;
    const p = preparedById.get(id);
    if (!p) continue;
    const idleAge = now - (lastUsedTime.get(id) ?? 0);
    if (idleAge < maxIdleMs) continue;
    const overCap = preparedById.size > maxTotal;
    const heavyUnderPressure = aggressive && p.textureBytes > 0 && idleAge >= maxIdleMs;
    if (!overCap && !heavyUnderPressure) continue;
    if (evictLifeAssetById(id)) {
      getEchoLifeResidencyManager().unregister(`life-asset:${id}`);
      evicted++;
    }
  }
  return evicted;
}

export function lifeAssetStats() {
  let textureBytes = 0;
  for (const p of preparedById.values()) textureBytes += p.textureBytes;
  return {
    cached: preparedById.size,
    referenced: refs.size,
    inflight: cache.size - preparedById.size,
    textureBytes,
    textureMB: Math.round((textureBytes / (1024 * 1024)) * 10) / 10,
  };
}

/** Estimated resident GPU texture footprint (MB) of cached Echo Life GLB assets alone (excludes PostFX/HDRI/atlas). */
export function lifeAssetTextureMB(): number {
  let bytes = 0;
  for (const p of preparedById.values()) bytes += p.textureBytes;
  return bytes / (1024 * 1024);
}

/** Every loaded model is released: the next world loads them again (a page that left the study space keeps nothing). */
export function disposeLifeAssets() {
  epoch++;
  const residency = getEchoLifeResidencyManager();
  for (const id of preparedById.keys()) {
    residency.unregister(`life-asset:${id}`);
  }
  for (const p of preparedById.values()) releasePrepared(p);
  preparedById.clear(); cache.clear(); refs.clear(); lastUsed.clear(); lastUsedTime.clear();
  for (const paint of paletteMaterials.values()) paint.dispose();
  paletteMaterials.clear();
  lodGlassMaterial?.dispose(); lodGlassMaterial = undefined;
  finishMap?.dispose(); finishMap = undefined;
  clearSharedGltfTexturePool();
}

/**
 * The matrix that stands a model on the floor at (x, y, z) facing `rotY`: its box's bottom on the floor, its centre over
 * the point; `scale` multiplies its own size.
 */
export function placeOn(p: Prepared, x: number, y: number, z: number, rotY: number, scale = 1, out = new T.Matrix4()) {
  const c = p.box.getCenter(new T.Vector3());
  const offset = new T.Matrix4().makeTranslation(-c.x, -p.box.min.y, -c.z);
  return out.compose(new T.Vector3(x, y, z), new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), rotY), new T.Vector3(scale, scale, scale)).multiply(offset);
}

export interface ConsolidatedBatchItem {
  readonly assetId: string;
  readonly geometry: T.BufferGeometry;
  readonly material: T.Material;
  readonly matrices: readonly T.Matrix4[];
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
  readonly role?: PartRole;
}

/**
 * Consolidates static city lot shells and street props sharing a material into `THREE.BatchedMesh`
 * (`WEBGL_multi_draw`) with `perObjectFrustumCulled = true` so every building & prop gets a tight
 * per-parcel bounding sphere (never sector-wide un-cullable spheres) while collapsing draw calls
 * across `palettePaint` and shared PBR materials.
 */
export function buildConsolidatedBatches(
  items: readonly ConsolidatedBatchItem[],
  groupName = 'life:batched',
): T.Group {
  const group = new T.Group();
  group.name = groupName;
  if (!items.length) return group;

  type Bucket = {
    material: T.Material;
    castShadow: boolean;
    receiveShadow: boolean;
    entries: ConsolidatedBatchItem[];
    totalInstances: number;
  };
  const buckets = new Map<string, Bucket>();
  const matIds = new WeakMap<T.Material, number>();
  let nextMatId = 1;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.matrices.length || !item.geometry.attributes.position) continue;
    stripTransmissionMaterial(item.material);
    let mid = matIds.get(item.material);
    if (mid === undefined) {
      mid = nextMatId++;
      matIds.set(item.material, mid);
    }
    const key = `${mid}|${item.castShadow ? 1 : 0}|${item.receiveShadow ? 1 : 0}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        material: item.material,
        castShadow: item.castShadow,
        receiveShadow: item.receiveShadow,
        entries: [],
        totalInstances: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.entries.push(item);
    bucket.totalInstances += item.matrices.length;
  }

  const canBatch = typeof T.BatchedMesh === 'function';

  for (const bucket of buckets.values()) {
    const { material, castShadow, receiveShadow, entries, totalInstances } = bucket;
    // Single unique placement: plain Mesh (no BatchedMesh overhead).
    if (entries.length === 1 && totalInstances === 1) {
      const e = entries[0];
      const mesh = new T.Mesh(e.geometry, material);
      mesh.applyMatrix4(e.matrices[0]);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      mesh.name = `life:${e.assetId}`;
      mesh.userData.lifeAsset = e.assetId;
      if (e.role) mesh.userData.partRole = e.role;
      group.add(mesh);
      continue;
    }

    if (canBatch) {
      // Clone unique geometries so harmonization never mutates shared cached `Prepared` geometries.
      const uniqueGeos: T.BufferGeometry[] = [];
      const geoIndexMap = new Map<T.BufferGeometry, number>();
      const entryGeoIdx: number[] = [];
      let maxVertices = 0;
      let maxIndices = 0;

      for (const e of entries) {
        let gIdx = geoIndexMap.get(e.geometry);
        if (gIdx === undefined) {
          const clone = e.geometry.clone();
          for (const attrName of Object.keys(clone.attributes)) {
            if (!(KEEP as readonly string[]).includes(attrName)) clone.deleteAttribute(attrName);
          }
          ensureTypedIndex(clone);
          for (const attrName of Object.keys(clone.attributes)) {
            const a = clone.getAttribute(attrName);
            if (a) clone.setAttribute(attrName, normalizeAttributeToFloat32(a));
          }
          gIdx = uniqueGeos.length;
          uniqueGeos.push(clone);
          geoIndexMap.set(e.geometry, gIdx);
        }
        entryGeoIdx.push(gIdx);
      }

      if (uniqueGeos.length > 1) harmonizeGeometryGroup(uniqueGeos);

      for (const g of uniqueGeos) {
        g.computeBoundingBox();
        g.computeBoundingSphere();
        maxVertices += g.attributes.position.count;
        maxIndices += g.index ? g.index.count : g.attributes.position.count;
      }

      try {
        const bm = new T.BatchedMesh(
          totalInstances,
          Math.max(1, maxVertices),
          Math.max(1, maxIndices),
          material,
        );
        bm.name = entries.length === 1 ? `life:${entries[0].assetId}` : `${groupName}:${entries[0].assetId}`;
        bm.perObjectFrustumCulled = true;
        bm.sortObjects = Boolean((material as T.MeshStandardMaterial).transparent);
        bm.castShadow = castShadow;
        bm.receiveShadow = receiveShadow;
        bm.userData.batchedAssets = entries.length;

        const batchGeoIds: number[] = [];
        for (const g of uniqueGeos) {
          batchGeoIds.push(bm.addGeometry(g));
        }
        for (let i = 0; i < entries.length; i++) {
          const gid = batchGeoIds[entryGeoIdx[i]];
          const mats = entries[i].matrices;
          for (let j = 0; j < mats.length; j++) {
            const iid = bm.addInstance(gid);
            bm.setMatrixAt(iid, mats[j]);
          }
        }
        bm.computeBoundingBox();
        bm.computeBoundingSphere();
        for (const g of uniqueGeos) g.dispose();
        group.add(bm);
        continue;
      } catch {
        for (const g of uniqueGeos) g.dispose();
      }
    }

    // Fallback: InstancedMesh per entry if BatchedMesh fails or is unavailable.
    for (const e of entries) {
      const mesh =
        e.matrices.length === 1
          ? new T.Mesh(e.geometry, material)
          : new T.InstancedMesh(e.geometry, material, e.matrices.length);
      if (mesh instanceof T.InstancedMesh) {
        for (let j = 0; j < e.matrices.length; j++) mesh.setMatrixAt(j, e.matrices[j]);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
      } else {
        mesh.applyMatrix4(e.matrices[0]);
      }
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      mesh.userData.lifeAsset = e.assetId;
      if (e.role) mesh.userData.partRole = e.role;
      group.add(mesh);
    }
  }

  return group;
}

/** One draw call per material for every placement of a model (per-instance frustum culled via BatchedMesh when >= 2). */
export function instance(p: Prepared, matrices: T.Matrix4[], shadows = false): T.Group {
  const group = new T.Group();
  group.name = `life:${p.id}`;
  if (!matrices.length) return group;
  const items: ConsolidatedBatchItem[] = p.parts.map((part) => ({
    assetId: p.id,
    geometry: part.geometry,
    material: part.material,
    matrices,
    castShadow: shadows,
    receiveShadow: shadows,
    role: part.role,
  }));
  const built = buildConsolidatedBatches(items, `life:${p.id}`);
  while (built.children.length > 0) group.add(built.children[0]);
  return group;
}

/** Normalize the shared and personally parked bicycles to the same 1.7 m wheel-to-wheel model. */
export function bicycleModel(p: Prepared) {
  const size = p.box.getSize(new T.Vector3());
  const group = instance(
    p,
    [placeOn(p, 0, 0, 0, size.x > size.z ? Math.PI / 2 : 0, 1.7 / Math.max(0.001, size.x, size.z))],
  );
  if (p.id === 'bicycle') {
    extractVehicleRig(group, 'bicycle');
  }
  return group;
}
