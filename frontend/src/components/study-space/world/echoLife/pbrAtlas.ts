import * as T from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import type { QualityTier } from './renderConfig';

/**
 * Echo Life Total Rebirth — Staged Poly Haven CC0 PBR Surface Atlas & 1K HDRI Environment Registry.
 *
 * All 23 PBR surface sets (69 WebP maps: sRGB albedo, OpenGL tangent-space normal, and packed
 * AO[R] + Roughness[G] + Metalness[B] ORM) and 5 Radiance 1K HDRI environments are staged under
 * `/echo-life/pbr/` and `/echo-life/hdri/` with 12-hex SHA-256 content-hashed filenames for
 * immutable browser caching, zero page-level WASM decoders, and full CC0-1.0 provenance
 * (`docs/echo-life/total-rebuild/ASSET_PROVENANCE.tsv`).
 *
 * Nothing is fetched until a surface or environment is acquired. Base WebP textures are cached
 * by URL so every material sharing a surface/repeat reuses the exact same GPU texture handle,
 * and `disposePbrAtlas()` releases every texture and PMREM render target cleanly on unmount.
 */

export interface PbrSurfaceDef {
  readonly colorUrl: string;
  readonly normalUrl?: string;
  readonly ormUrl?: string;
  readonly defaultRepeat: readonly [number, number];
  readonly roughness: number;
  readonly metalness: number;
  readonly normalScale: number;
  /** Ambient occlusion strength when `ormMap` (R channel) is bound to `aoMap` on UV channel 0. */
  readonly aoMapIntensity: number;
}

export const PBR_SURFACES = {
  // 15 Core Hero Surfaces (1024x1024 WebP)
  asphalt: {
    colorUrl: '/echo-life/pbr/asphalt-color-f04b0c1f609a.webp',
    normalUrl: '/echo-life/pbr/asphalt-normal-b2a4db5513a5.webp',
    ormUrl: '/echo-life/pbr/asphalt-orm-5b77775ff73a.webp',
    defaultRepeat: [1, 1],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 0.9,
    aoMapIntensity: 0.85,
  },
  asphalt_clean: {
    colorUrl: '/echo-life/pbr/asphalt_clean-color-b3f8829baeb1.webp',
    normalUrl: '/echo-life/pbr/asphalt_clean-normal-900bd84e143f.webp',
    ormUrl: '/echo-life/pbr/asphalt_clean-orm-c0582b47a355.webp',
    defaultRepeat: [1, 1],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 0.8,
    aoMapIntensity: 0.75,
  },
  pavers: {
    colorUrl: '/echo-life/pbr/pavers-color-024830905d72.webp',
    normalUrl: '/echo-life/pbr/pavers-normal-4ca4869435b9.webp',
    ormUrl: '/echo-life/pbr/pavers-orm-50738011d30b.webp',
    defaultRepeat: [1.5, 1.5],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 0.95,
    aoMapIntensity: 0.9,
  },
  concrete: {
    colorUrl: '/echo-life/pbr/concrete-color-b354f9192f8f.webp',
    normalUrl: '/echo-life/pbr/concrete-normal-ad2bfe198c9b.webp',
    ormUrl: '/echo-life/pbr/concrete-orm-bfaf4c8cc73a.webp',
    defaultRepeat: [1, 1],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 0.85,
    aoMapIntensity: 0.8,
  },
  grass_ground: {
    colorUrl: '/echo-life/pbr/grass_ground-color-f7ea59b0bf60.webp',
    normalUrl: '/echo-life/pbr/grass_ground-normal-7231f3872549.webp',
    ormUrl: '/echo-life/pbr/grass_ground-orm-e6cd0697ea25.webp',
    defaultRepeat: [1, 1],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 0.9,
    aoMapIntensity: 0.8,
  },
  park_dirt: {
    colorUrl: '/echo-life/pbr/park_dirt-color-b85e15088fbf.webp',
    normalUrl: '/echo-life/pbr/park_dirt-normal-8202a01790eb.webp',
    ormUrl: '/echo-life/pbr/park_dirt-orm-20292080cf2d.webp',
    defaultRepeat: [1, 1],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 0.95,
    aoMapIntensity: 0.85,
  },
  stucco_white: {
    colorUrl: '/echo-life/pbr/stucco_white-color-57eecf39b6a9.webp',
    normalUrl: '/echo-life/pbr/stucco_white-normal-421a0f6f12ca.webp',
    ormUrl: '/echo-life/pbr/stucco_white-orm-e4d50b436e02.webp',
    defaultRepeat: [1, 1],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 0.75,
    aoMapIntensity: 0.7,
  },
  wall_beige: {
    colorUrl: '/echo-life/pbr/wall_beige-color-3623a76ffbf9.webp',
    normalUrl: '/echo-life/pbr/wall_beige-normal-6803d9dfe292.webp',
    ormUrl: '/echo-life/pbr/wall_beige-orm-356d5e0bff49.webp',
    defaultRepeat: [1, 1],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 0.65,
    aoMapIntensity: 0.65,
  },
  red_brick: {
    colorUrl: '/echo-life/pbr/red_brick-color-1dfce374beae.webp',
    normalUrl: '/echo-life/pbr/red_brick-normal-2825cb3367c1.webp',
    ormUrl: '/echo-life/pbr/red_brick-orm-c07f0a94c219.webp',
    defaultRepeat: [1.25, 1.25],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 1.0,
    aoMapIntensity: 0.9,
  },
  roof_tiles: {
    colorUrl: '/echo-life/pbr/roof_tiles-color-aeadbe7038d3.webp',
    normalUrl: '/echo-life/pbr/roof_tiles-normal-2baf527da1b1.webp',
    ormUrl: '/echo-life/pbr/roof_tiles-orm-416773a301ae.webp',
    defaultRepeat: [1.25, 1.25],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 1.05,
    aoMapIntensity: 0.9,
  },
  oak_wood: {
    colorUrl: '/echo-life/pbr/oak_wood-color-f834f2b30095.webp',
    normalUrl: '/echo-life/pbr/oak_wood-normal-33724a22cdb8.webp',
    ormUrl: '/echo-life/pbr/oak_wood-orm-cbf31daefc91.webp',
    defaultRepeat: [1.5, 1.5],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 0.75,
    aoMapIntensity: 0.7,
  },
  walnut_wood: {
    colorUrl: '/echo-life/pbr/walnut_wood-color-ca65721ef45d.webp',
    normalUrl: '/echo-life/pbr/walnut_wood-normal-f5b1c9f0e2bc.webp',
    ormUrl: '/echo-life/pbr/walnut_wood-orm-1994efc4b47f.webp',
    defaultRepeat: [1.5, 1.5],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 0.75,
    aoMapIntensity: 0.7,
  },
  parquet: {
    colorUrl: '/echo-life/pbr/parquet-color-f0fe3e76083c.webp',
    normalUrl: '/echo-life/pbr/parquet-normal-80994268ed05.webp',
    ormUrl: '/echo-life/pbr/parquet-orm-3c22a5d41994.webp',
    defaultRepeat: [1.5, 1.5],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 0.7,
    aoMapIntensity: 0.75,
  },
  terrazzo: {
    colorUrl: '/echo-life/pbr/terrazzo-color-d822311a95ff.webp',
    normalUrl: '/echo-life/pbr/terrazzo-normal-015eb0750099.webp',
    ormUrl: '/echo-life/pbr/terrazzo-orm-d3b4878efd80.webp',
    defaultRepeat: [1.5, 1.5],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 0.55,
    aoMapIntensity: 0.6,
  },
  tiles_floor: {
    colorUrl: '/echo-life/pbr/tiles_floor-color-93001206d3e1.webp',
    normalUrl: '/echo-life/pbr/tiles_floor-normal-bd5261003cd3.webp',
    ormUrl: '/echo-life/pbr/tiles_floor-orm-51180ba96f38.webp',
    defaultRepeat: [1.5, 1.5],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 0.85,
    aoMapIntensity: 0.8,
  },

  // 3 Curated Outdoor Environment Hero Surfaces (1024x1024 WebP, Poly Haven CC0)
  tree_bark: {
    colorUrl: '/echo-life/pbr/tree_bark-color-d4e96707bfd4.webp',
    normalUrl: '/echo-life/pbr/tree_bark-normal-3517b80027c4.webp',
    ormUrl: '/echo-life/pbr/tree_bark-orm-a13224a1847f.webp',
    defaultRepeat: [1, 2],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 1.1,
    aoMapIntensity: 0.9,
  },
  cobblestone: {
    colorUrl: '/echo-life/pbr/cobblestone-color-40f460b7e954.webp',
    normalUrl: '/echo-life/pbr/cobblestone-normal-389ee8f2e611.webp',
    ormUrl: '/echo-life/pbr/cobblestone-orm-f85b55d97604.webp',
    defaultRepeat: [1.5, 1.5],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 1.05,
    aoMapIntensity: 0.9,
  },
  stone_wall: {
    colorUrl: '/echo-life/pbr/stone_wall-color-0dea38a10806.webp',
    normalUrl: '/echo-life/pbr/stone_wall-normal-4b27d242d266.webp',
    ormUrl: '/echo-life/pbr/stone_wall-orm-b21ceb88bab4.webp',
    defaultRepeat: [1, 1],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 0.95,
    aoMapIntensity: 0.85,
  },

  // 5 Secondary Interior & Soft-Furnishing Surfaces (512x512 WebP)
  parquet_rect: {
    colorUrl: '/echo-life/pbr/parquet_rect-color-53ecdd074a52.webp',
    normalUrl: '/echo-life/pbr/parquet_rect-normal-4a97051fb909.webp',
    ormUrl: '/echo-life/pbr/parquet_rect-orm-395aa6db925d.webp',
    defaultRepeat: [1.5, 1.5],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 0.7,
    aoMapIntensity: 0.75,
  },
  leather: {
    colorUrl: '/echo-life/pbr/leather-color-07c8e4a2648d.webp',
    normalUrl: '/echo-life/pbr/leather-normal-4647aeae84e6.webp',
    ormUrl: '/echo-life/pbr/leather-orm-d98d6c85a96a.webp',
    defaultRepeat: [2, 2],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 0.7,
    aoMapIntensity: 0.65,
  },
  linen: {
    colorUrl: '/echo-life/pbr/linen-color-f8d9dfd3f6d5.webp',
    normalUrl: '/echo-life/pbr/linen-normal-6d08ee44c301.webp',
    ormUrl: '/echo-life/pbr/linen-orm-a4bcd679226e.webp',
    defaultRepeat: [2, 2],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 0.75,
    aoMapIntensity: 0.7,
  },
  denim: {
    colorUrl: '/echo-life/pbr/denim-color-458fc059ae43.webp',
    normalUrl: '/echo-life/pbr/denim-normal-3eac85ca698e.webp',
    ormUrl: '/echo-life/pbr/denim-orm-08f898104dec.webp',
    defaultRepeat: [2, 2],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 0.7,
    aoMapIntensity: 0.65,
  },
  cotton: {
    colorUrl: '/echo-life/pbr/cotton-color-9a86915fcef2.webp',
    normalUrl: '/echo-life/pbr/cotton-normal-bf23e27b7e2e.webp',
    ormUrl: '/echo-life/pbr/cotton-orm-86cbb4912028.webp',
    defaultRepeat: [2, 2],
    roughness: 1.0,
    metalness: 0.0,
    normalScale: 0.65,
    aoMapIntensity: 0.65,
  },
} as const satisfies Record<string, PbrSurfaceDef>;

export type PbrSurfaceKey = keyof typeof PBR_SURFACES;

export type HdriEnvKey = 'morning' | 'midday' | 'sunset' | 'night' | 'interior';

export const HDRI_ENVS: Readonly<Record<HdriEnvKey, string>> = {
  morning: '/echo-life/hdri/autumn_field_puresky_1k-e60470d3a0f2.hdr',
  midday: '/echo-life/hdri/clarens_midday_1k-0b73f9b71d16.hdr',
  sunset: '/echo-life/hdri/belfast_sunset_puresky_1k-cec532d8dd38.hdr',
  night: '/echo-life/hdri/blaubeuren_night_1k-1df5631d19df.hdr',
  interior: '/echo-life/hdri/brown_photostudio_02_1k-469abc5e6035.hdr',
} as const;

export interface AcquiredPbrSurface {
  readonly key: PbrSurfaceKey;
  readonly def: PbrSurfaceDef;
  readonly colorMap: T.Texture;
  readonly normalMap?: T.Texture;
  readonly ormMap?: T.Texture;
  readonly repeat: readonly [number, number];
  readonly roughness: number;
  readonly metalness: number;
  readonly normalScale: number;
  readonly aoMapIntensity: number;
}

export interface PbrMaterialOptions {
  /** Optional multiplicative albedo tint (default `#ffffff`). */
  color?: T.ColorRepresentation;
  repeatX?: number;
  repeatY?: number;
  /** Anisotropic filtering level (1..16; recommend 8–16 on High/Ultra, 4 on Balanced, 1 on Low). */
  maxAnisotropy?: number;
  roughness?: number;
  metalness?: number;
  normalScale?: number;
  aoMapIntensity?: number;
  envMapIntensity?: number;
  side?: T.Side;
  /** Skip loading normal & ORM maps (e.g. Low quality preset or distant LOD). */
  colorOnly?: boolean;
}

type TextureSlotKind = 'color' | 'normal' | 'orm';

export interface AcquireHdriOptions {
  /** `'immediate'` jumps ahead of deferred `'background'` time-of-day HDRI prewarm slots. */
  readonly priority?: 'immediate' | 'background';
  /** Minimum animation frames between consecutive PMREM bakes (clamped >= 6 to prevent main-thread stalls). */
  readonly frameSpacing?: number;
}

interface PmremBakeJob {
  readonly key: HdriEnvKey;
  readonly renderer: T.WebGLRenderer;
  readonly equirect: T.DataTexture;
  readonly atEpoch: number;
  priority: 'immediate' | 'background';
  frameSpacing: number;
  readonly resolve: (tex: T.Texture | null) => void;
}

const MIN_PMREM_FRAME_SPACING = 6;

/** Core exterior/city PBR surfaces preloaded before boot unlock on Exploration entry. */
export const CORE_PBR_SURFACE_KEYS: readonly PbrSurfaceKey[] = [
  'asphalt',
  'asphalt_clean',
  'pavers',
  'concrete',
  'grass_ground',
  'park_dirt',
  'stucco_white',
  'wall_beige',
  'red_brick',
  'roof_tiles',
  'oak_wood',
  'walnut_wood',
  'stone_wall',
  'cobblestone',
  'tree_bark',
] as const;

let textureLoader: T.TextureLoader | null = null;
let hdrLoader: HDRLoader | null = null;
let pmremGen: T.PMREMGenerator | null = null;
let pmremRenderer: T.WebGLRenderer | null = null;
let pmremShaderCompiledFor: T.WebGLRenderer | null = null;
let pmremPumpRafId: number | null = null;
let pmremCooldownFrames = 0;
let epoch = 0;
/**
 * Maximum decode dimension for `createImageBitmap` off-thread PBR resizing:
 * - `512` on `low` / `balanced` (cuts 1024^2 PBR atlas VRAM by 4x: ~256 MiB -> ~64 MiB, saving ~192 MiB!)
 * - `1024` on `high` / `ultra` (full native resolution).
 */
let pbrMaxDecodeDim = 1024;
let cachedImageBitmapSupport: boolean | null = null;

/** Canonical loaded textures keyed by URL (1 network fetch + 1 image decode per URL). */
const baseTextures = new Map<string, T.Texture>();
/** Cached repeat-parameterized variants keyed by `${url}@${rx}x${ry}`. */
const variantTextures = new Map<string, T.Texture>();
/** Tracks repeat clones derived from a base URL so async load completion & anisotropy stay 100% uniform. */
const clonesByUrl = new Map<string, Set<T.Texture>>();
/** Uniform anisotropy per URL so base + all repeat clones share ONE WebGLTexture handle in Three.js! */
const anisoByUrl = new Map<string, number>();
/** Owned `ImageBitmap` instances closed strictly inside `disposePbrAtlas()` (or stale-epoch discard). */
const ownedBitmaps = new Map<string, ImageBitmap>();
/** In-flight base texture decode promises keyed by URL for `awaitCorePbrReady()`. */
const pendingBaseLoads = new Map<string, Promise<boolean>>();
/** Cached GPU PMREM render targets keyed by HDRI environment slot. */
const hdriTargets = new Map<HdriEnvKey, T.WebGLRenderTarget>();
/** In-flight HDRI load promises keyed by HDRI environment slot. */
const hdriPending = new Map<HdriEnvKey, Promise<T.Texture | null>>();
/** Frame-paced PMREM bake queue ensuring at most 1 HDRI is baked every >= 6 frames (0 boot Long Tasks!). */
const pmremBakeQueue: PmremBakeJob[] = [];

/**
 * Sets the PBR atlas decode cap (`512` on `'low'` / `'balanced'` saving ~192 MiB VRAM; `1024` on `'high'` / `'ultra'`).
 * Call before acquiring city PBR surfaces during boot setup.
 */
export function setPbrAtlasQuality(tier: QualityTier): void {
  pbrMaxDecodeDim = tier === 'low' || tier === 'balanced' ? 512 : 1024;
}

export function getPbrAtlasMaxDecodeDim(): number {
  return pbrMaxDecodeDim;
}

/**
 * Safari < 17 / Firefox < 98 safe capability gate matching Three.js `GLTFLoader` so
 * `createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })`
 * never throws or produces inverted normals on older browsers.
 */
function supportsCreateImageBitmapOptions(): boolean {
  if (cachedImageBitmapSupport !== null) return cachedImageBitmapSupport;
  if (typeof createImageBitmap !== 'function' || typeof fetch !== 'function') {
    cachedImageBitmapSupport = false;
    return false;
  }
  if (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string') {
    const ua = navigator.userAgent;
    const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
    const safariMatch = ua.match(/Version\/(\d+)/i);
    if (isSafari && (!safariMatch || Number(safariMatch[1]) < 17)) {
      cachedImageBitmapSupport = false;
      return false;
    }
    const ffMatch = ua.match(/Firefox\/(\d+)/i);
    if (ffMatch && Number(ffMatch[1]) < 98) {
      cachedImageBitmapSupport = false;
      return false;
    }
  }
  cachedImageBitmapSupport = true;
  return true;
}

function clampAnisotropy(value: number): number {
  if (!Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(16, Math.round(value)));
}

function formatRepeatKey(rx: number, ry: number): string {
  return `${Math.round(rx * 1000) / 1000}x${Math.round(ry * 1000) / 1000}`;
}

function configureTexture(
  tex: T.Texture,
  kind: TextureSlotKind,
  rx: number,
  ry: number,
  anisotropy: number,
): T.Texture {
  tex.colorSpace = kind === 'color' ? T.SRGBColorSpace : T.NoColorSpace;
  tex.wrapS = T.RepeatWrapping;
  tex.wrapT = T.RepeatWrapping;
  tex.repeat.set(rx, ry);
  tex.anisotropy = anisotropy;
  tex.generateMipmaps = true;
  tex.minFilter = T.LinearMipmapLinearFilter;
  tex.magFilter = T.LinearFilter;
  if (kind === 'orm') {
    // Bind AO (red channel) to UV0 so standard BoxGeometry/PlaneGeometry/meteredBox meshes work without uv1.
    tex.channel = 0;
  }
  return tex;
}

function isTextureReady(tex: T.Texture): boolean {
  const img = tex.image as { complete?: boolean; width?: number } | null | undefined;
  if (!img) return false;
  if (img.complete === false) return false;
  if (typeof img.width === 'number' && img.width <= 0) return false;
  return true;
}

function markNeedsUpdateIfReady(tex: T.Texture): void {
  if (isTextureReady(tex)) {
    tex.needsUpdate = true;
  }
}

/**
 * Synchronizes `anisotropy` across the base texture AND every repeat clone sharing the same URL
 * so Three.js's `WebGLTextures.getTextureCacheKey()` produces 1 identical GPU `WebGLTexture` handle!
 */
function syncUniformAnisotropy(url: string, requestedAniso: number): number {
  const current = anisoByUrl.get(url) ?? 0;
  const target = Math.max(current, requestedAniso);
  if (target === current) return current;
  anisoByUrl.set(url, target);

  const base = baseTextures.get(url);
  if (base && base.anisotropy !== target) {
    base.anisotropy = target;
    markNeedsUpdateIfReady(base);
  }
  const clones = clonesByUrl.get(url);
  if (clones) {
    for (const clone of clones) {
      if (clone.anisotropy !== target) {
        clone.anisotropy = target;
        markNeedsUpdateIfReady(clone);
      }
    }
  }
  return target;
}

/** Updates uniform anisotropy across ALL cached PBR textures (zero duplicate WebGLTextures). */
export function setPbrAtlasAnisotropy(maxAnisotropy: number): void {
  const target = clampAnisotropy(maxAnisotropy);
  for (const [url, base] of baseTextures) {
    anisoByUrl.set(url, target);
    if (base.anisotropy !== target) {
      base.anisotropy = target;
      markNeedsUpdateIfReady(base);
    }
    const clones = clonesByUrl.get(url);
    if (clones) {
      for (const clone of clones) {
        if (clone.anisotropy !== target) {
          clone.anisotropy = target;
          markNeedsUpdateIfReady(clone);
        }
      }
    }
  }
}

function applyDecodedSourceToFamily(
  url: string,
  base: T.Texture,
  source: T.Texture['source'],
  flipY: boolean,
): void {
  base.source = source;
  base.flipY = flipY;
  markNeedsUpdateIfReady(base);
  const clones = clonesByUrl.get(url);
  if (clones) {
    const uniformAniso = anisoByUrl.get(url) ?? base.anisotropy;
    for (const clone of clones) {
      clone.source = source;
      clone.flipY = flipY;
      clone.anisotropy = uniformAniso;
      markNeedsUpdateIfReady(clone);
    }
  }
}

function loadViaTextureLoaderFallback(
  url: string,
  base: T.Texture,
  atEpoch: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    textureLoader ??= new T.TextureLoader();
    textureLoader.load(
      url,
      (loaded) => {
        if (atEpoch !== epoch) {
          loaded.dispose();
          resolve(false);
          return;
        }
        applyDecodedSourceToFamily(url, base, loaded.source, true);
        resolve(true);
      },
      undefined,
      () => {
        if (atEpoch === epoch && baseTextures.get(url) === base) {
          baseTextures.delete(url);
          anisoByUrl.delete(url);
        }
        resolve(false);
      },
    );
  });
}

function startOffThreadBitmapLoad(
  url: string,
  base: T.Texture,
  atEpoch: number,
  maxDim: number,
): Promise<boolean> {
  if (!supportsCreateImageBitmapOptions()) {
    return loadViaTextureLoaderFallback(url, base, atEpoch);
  }

  return fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.blob();
    })
    .then((blob) => {
      if (atEpoch !== epoch) return null;
      const opts: ImageBitmapOptions = {
        imageOrientation: 'flipY',
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      };
      // All staged PBR WebPs are strictly square 1024x1024 or 512x512; downscaling off-thread to 512x512
      // on low/balanced avoids ever allocating full 1024x1024 bitmaps and saves ~192 MiB GPU VRAM!
      if (maxDim < 1024) {
        opts.resizeWidth = maxDim;
        opts.resizeHeight = maxDim;
        opts.resizeQuality = 'medium';
      }
      return createImageBitmap(blob, opts);
    })
    .then((bitmap) => {
      if (!bitmap) return false;
      if (atEpoch !== epoch) {
        // Stale load from a disposed epoch: close immediately so zero off-thread bitmap leaks.
        try {
          bitmap.close();
        } catch {
          // Ignore already-closed bitmap
        }
        return false;
      }
      const prevBitmap = ownedBitmaps.get(url);
      if (prevBitmap && prevBitmap !== bitmap) {
        try {
          prevBitmap.close();
        } catch {
          // Ignore
        }
      }
      ownedBitmaps.set(url, bitmap);
      // CRITICAL: `imageOrientation: 'flipY'` already flipped pixels off-thread; set `flipY = false`!
      const source = new T.TextureSource(bitmap);
      applyDecodedSourceToFamily(url, base, source, false);
      return true;
    })
    .catch(() => {
      if (atEpoch !== epoch) return false;
      // Fallback to standard TextureLoader if ImageBitmap options fail on an unusual UA/test environment.
      return loadViaTextureLoaderFallback(url, base, atEpoch);
    });
}

function acquireTexture(
  url: string,
  kind: TextureSlotKind,
  rx: number,
  ry: number,
  defaultRx: number,
  defaultRy: number,
  anisotropy: number,
): T.Texture {
  const uniformAniso = syncUniformAnisotropy(url, anisotropy);
  const variantKey = `${url}@${formatRepeatKey(rx, ry)}`;
  const hit = variantTextures.get(variantKey);
  if (hit) {
    if (hit.anisotropy !== uniformAniso) {
      hit.anisotropy = uniformAniso;
      markNeedsUpdateIfReady(hit);
    }
    return hit;
  }

  let base = baseTextures.get(url);
  if (!base) {
    const at = epoch;
    const targetDim = pbrMaxDecodeDim;
    base = new T.Texture();
    base.name = url;
    // Set expected flipY before decode resolves (off-thread ImageBitmap uses flipY=false + imageOrientation:'flipY').
    base.flipY = !supportsCreateImageBitmapOptions();
    configureTexture(base, kind, defaultRx, defaultRy, uniformAniso);
    baseTextures.set(url, base);
    variantTextures.set(`${url}@${formatRepeatKey(defaultRx, defaultRy)}`, base);

    const loadPromise = startOffThreadBitmapLoad(url, base, at, targetDim).finally(() => {
      if (pendingBaseLoads.get(url) === loadPromise) {
        pendingBaseLoads.delete(url);
      }
    });
    pendingBaseLoads.set(url, loadPromise);
  }

  const defaultKey = `${url}@${formatRepeatKey(defaultRx, defaultRy)}`;
  if (variantKey === defaultKey) {
    if (base.anisotropy !== uniformAniso) {
      base.anisotropy = uniformAniso;
      markNeedsUpdateIfReady(base);
    }
    return base;
  }

  // Share the underlying decoded Image/TextureSource while giving this repeat factor its own UV matrix.
  // Construct directly instead of `base.clone()` (`Texture.copy()` unconditionally sets `needsUpdate = true`,
  // which triggers `WebGLRenderer: Texture marked for update but no image data found` while async fetch is in flight).
  const clone = new T.Texture();
  clone.name = base.name;
  clone.source = base.source;
  clone.format = base.format;
  clone.type = base.type;
  clone.flipY = base.flipY;
  configureTexture(clone, kind, rx, ry, uniformAniso);
  markNeedsUpdateIfReady(clone);
  variantTextures.set(variantKey, clone);
  let set = clonesByUrl.get(url);
  if (!set) {
    set = new Set();
    clonesByUrl.set(url, set);
  }
  set.add(clone);
  return clone;
}

/**
 * Explicit Promise barrier that ensures core (or caller-specified) PBR surface textures have completed
 * off-thread fetch + `createImageBitmap` decode before GPU upload (`initTexture`) and shader warmup!
 */
export async function awaitCorePbrReady(options?: {
  readonly keys?: readonly PbrSurfaceKey[];
  readonly colorOnly?: boolean;
  readonly maxAnisotropy?: number;
  readonly timeoutMs?: number;
}): Promise<{ loaded: number; failed: number; total: number }> {
  const keys = options?.keys ?? CORE_PBR_SURFACE_KEYS;
  const colorOnly = options?.colorOnly ?? false;
  const maxAnisotropy = options?.maxAnisotropy ?? 8;
  const urls: string[] = [];

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const def = PBR_SURFACES[key];
    if (!def) continue;
    acquirePbrSurface(key, undefined, undefined, maxAnisotropy, colorOnly);
    urls.push(def.colorUrl);
    if (!colorOnly && def.normalUrl) urls.push(def.normalUrl);
    if (!colorOnly && def.ormUrl) urls.push(def.ormUrl);
  }

  const tasks: Promise<boolean>[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const pending = pendingBaseLoads.get(url);
    if (pending) {
      tasks.push(pending);
    } else {
      const tex = baseTextures.get(url);
      tasks.push(Promise.resolve(Boolean(tex && isTextureReady(tex))));
    }
  }

  const allPromise = Promise.all(tasks);
  let results: boolean[];
  if (options?.timeoutMs && options.timeoutMs > 0) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      results = await Promise.race([
        allPromise,
        new Promise<boolean[]>((resolve) => {
          timer = setTimeout(() => {
            resolve(urls.map((u) => {
              const t = baseTextures.get(u);
              return Boolean(t && isTextureReady(t));
            }));
          }, options.timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  } else {
    results = await allPromise;
  }

  let loaded = 0;
  let failed = 0;
  for (let i = 0; i < results.length; i++) {
    if (results[i]) loaded++;
    else failed++;
  }
  return { loaded, failed, total: results.length };
}

/** Returns all currently decoded PBR base textures ready for staggered `renderer.initTexture()`. */
export function getLoadedPbrBaseTextures(): T.Texture[] {
  const out: T.Texture[] = [];
  for (const tex of baseTextures.values()) {
    if (isTextureReady(tex)) out.push(tex);
  }
  return out;
}

/**
 * Lazily acquires a cached PBR texture bundle (sRGB baseColor + linear OpenGL normal + linear ORM)
 * configured with `RepeatWrapping` and anisotropic filtering. Repeated calls with the same
 * `(key, repeatX, repeatY)` return the exact same cached `THREE.Texture` handles (zero duplicate uploads).
 */
export function acquirePbrSurface(
  key: PbrSurfaceKey,
  repeatX?: number,
  repeatY?: number,
  maxAnisotropy = 8,
  colorOnly = false,
): AcquiredPbrSurface {
  const def = PBR_SURFACES[key];
  const [defRx, defRy] = def.defaultRepeat;
  const rx = repeatX ?? defRx;
  const ry = repeatY ?? defRy;
  const aniso = clampAnisotropy(maxAnisotropy);

  const colorMap = acquireTexture(def.colorUrl, 'color', rx, ry, defRx, defRy, aniso);
  const normalMap = !colorOnly && def.normalUrl
    ? acquireTexture(def.normalUrl, 'normal', rx, ry, defRx, defRy, aniso)
    : undefined;
  const ormMap = !colorOnly && def.ormUrl
    ? acquireTexture(def.ormUrl, 'orm', rx, ry, defRx, defRy, aniso)
    : undefined;

  return {
    key,
    def,
    colorMap,
    normalMap,
    ormMap,
    repeat: [rx, ry],
    roughness: def.roughness,
    metalness: def.metalness,
    normalScale: def.normalScale,
    aoMapIntensity: def.aoMapIntensity,
  };
}

/**
 * Convenience builder that creates a physically calibrated `THREE.MeshStandardMaterial` backed by
 * cached `pbrAtlas` textures. Callers own and dispose the returned `MeshStandardMaterial` (do NOT
 * dispose its shared `map` / `normalMap` / `roughnessMap` / `aoMap` textures; `disposePbrAtlas()`
 * manages shared texture lifetime).
 */
export function createPbrMaterial(
  key: PbrSurfaceKey,
  options: PbrMaterialOptions = {},
): T.MeshStandardMaterial {
  const surf = acquirePbrSurface(
    key,
    options.repeatX,
    options.repeatY,
    options.maxAnisotropy ?? 8,
    options.colorOnly ?? false,
  );
  const nScale = options.normalScale ?? surf.normalScale;
  const mat = new T.MeshStandardMaterial({
    color: options.color ?? '#ffffff',
    map: surf.colorMap,
    normalMap: surf.normalMap ?? null,
    normalScale: new T.Vector2(nScale, nScale),
    roughnessMap: surf.ormMap ?? null,
    aoMap: surf.ormMap ?? null,
    aoMapIntensity: options.aoMapIntensity ?? surf.aoMapIntensity,
    roughness: options.roughness ?? surf.roughness,
    metalness: options.metalness ?? surf.metalness,
    envMapIntensity: options.envMapIntensity ?? 1.0,
    side: options.side ?? T.FrontSide,
  });
  mat.name = `pbr:${key}`;
  return mat;
}

function disposeEquirectDataTexture(equirect: T.DataTexture): void {
  equirect.dispose();
  // Explicitly clear backing Float32/Uint16 typed array reference so V8 GC immediately reclaims raw 4–8 MB HDR RAM.
  const img = equirect.image as { data?: unknown } | null | undefined;
  if (img && 'data' in img) {
    img.data = null;
  }
  (equirect.source as unknown as { data: unknown }).data = null;
}

function bakePmremJobNow(job: PmremBakeJob): T.Texture | null {
  if (job.atEpoch !== epoch) {
    disposeEquirectDataTexture(job.equirect);
    return null;
  }
  const existing = hdriTargets.get(job.key);
  if (existing) {
    disposeEquirectDataTexture(job.equirect);
    return existing.texture;
  }
  try {
    if (!pmremGen || pmremRenderer !== job.renderer) {
      pmremGen?.dispose();
      pmremGen = new T.PMREMGenerator(job.renderer);
      pmremGen.compileEquirectangularShader();
      pmremRenderer = job.renderer;
      pmremShaderCompiledFor = job.renderer;
    }
    const rt = pmremGen.fromEquirectangular(job.equirect);
    disposeEquirectDataTexture(job.equirect);
    if (job.atEpoch !== epoch) {
      rt.dispose();
      return null;
    }
    hdriTargets.set(job.key, rt);
    return rt.texture;
  } catch {
    disposeEquirectDataTexture(job.equirect);
    return null;
  }
}

function schedulePmremPump(): void {
  if (pmremPumpRafId !== null || pmremBakeQueue.length === 0) return;
  if (typeof requestAnimationFrame !== 'function') {
    while (pmremBakeQueue.length > 0) {
      const job = pmremBakeQueue.shift()!;
      job.resolve(bakePmremJobNow(job));
    }
    return;
  }
  pmremPumpRafId = requestAnimationFrame(stepPmremPump);
}

function stepPmremPump(): void {
  pmremPumpRafId = null;
  if (pmremBakeQueue.length === 0) return;

  if (pmremCooldownFrames > 0) {
    pmremCooldownFrames--;
    schedulePmremPump();
    return;
  }

  const head = pmremBakeQueue[0];
  if (!head) return;

  if (head.atEpoch !== epoch) {
    pmremBakeQueue.shift();
    disposeEquirectDataTexture(head.equirect);
    head.resolve(null);
    schedulePmremPump();
    return;
  }

  // Split PMREM equirectangular shader compilation from the 18-pass PMREM render across separate frames
  // so neither step stacks into a Long Task even on 4x CPU throttle!
  if (!pmremGen || pmremRenderer !== head.renderer || pmremShaderCompiledFor !== head.renderer) {
    try {
      pmremGen?.dispose();
      pmremGen = new T.PMREMGenerator(head.renderer);
      pmremGen.compileEquirectangularShader();
      pmremRenderer = head.renderer;
      pmremShaderCompiledFor = head.renderer;
    } catch {
      pmremBakeQueue.shift();
      disposeEquirectDataTexture(head.equirect);
      head.resolve(null);
    }
    pmremCooldownFrames = 2;
    schedulePmremPump();
    return;
  }

  const job = pmremBakeQueue.shift()!;
  const tex = bakePmremJobNow(job);
  job.resolve(tex);
  // Enforce >= 6 frames between consecutive HDRI PMREM bakes so main thread stays butter-smooth!
  pmremCooldownFrames = Math.max(MIN_PMREM_FRAME_SPACING, job.frameSpacing);
  if (pmremBakeQueue.length > 0) {
    schedulePmremPump();
  }
}

function enqueuePmremBake(job: PmremBakeJob): void {
  if (typeof requestAnimationFrame !== 'function') {
    job.resolve(bakePmremJobNow(job));
    return;
  }
  if (job.priority === 'immediate') {
    // Insert ahead of all deferred background jobs while preserving FIFO among immediate requests.
    let insertAt = pmremBakeQueue.length;
    for (let i = 0; i < pmremBakeQueue.length; i++) {
      if (pmremBakeQueue[i].priority === 'background') {
        insertAt = i;
        break;
      }
    }
    pmremBakeQueue.splice(insertAt, 0, job);
  } else {
    pmremBakeQueue.push(job);
  }
  schedulePmremPump();
}

/**
 * Lazily loads a staged Poly Haven CC0 1K Radiance `.hdr` sky/studio file, pre-filters it into a
 * GPU-ready PMREM cubemap for `scene.environment` through a frame-paced queue (at most 1 HDRI baked
 * every >= 6 frames, active slot prioritized first), disposes the raw equirectangular source immediately,
 * and caches the PMREM texture per `HdriEnvKey`.
 */
export function acquireHdriEnv(
  key: HdriEnvKey,
  renderer: T.WebGLRenderer,
  options: AcquireHdriOptions = {},
): Promise<T.Texture | null> {
  if (pmremRenderer && pmremRenderer !== renderer) {
    // Renderer instance changed (e.g. WebGL context rebuild); invalidate stale PMREM targets.
    disposeHdriCache();
  }
  const cached = hdriTargets.get(key);
  if (cached) return Promise.resolve(cached.texture);

  const priority = options.priority ?? 'immediate';
  const frameSpacing = Math.max(
    MIN_PMREM_FRAME_SPACING,
    Math.floor(options.frameSpacing ?? (priority === 'background' ? 10 : MIN_PMREM_FRAME_SPACING)),
  );

  const pending = hdriPending.get(key);
  if (pending) {
    // Promote a queued background bake to immediate if the active time-of-day now needs it!
    if (priority === 'immediate') {
      const idx = pmremBakeQueue.findIndex((j) => j.key === key);
      if (idx > 0 && pmremBakeQueue[idx].priority === 'background') {
        const [job] = pmremBakeQueue.splice(idx, 1);
        job.priority = 'immediate';
        job.frameSpacing = Math.min(job.frameSpacing, frameSpacing);
        pmremBakeQueue.unshift(job);
      }
    }
    return pending;
  }

  const at = epoch;
  hdrLoader ??= new HDRLoader();
  const currentLoader = hdrLoader;

  const promise = currentLoader
    .loadAsync(HDRI_ENVS[key])
    .then((equirect) => {
      if (at !== epoch) {
        disposeEquirectDataTexture(equirect);
        return null;
      }
      equirect.mapping = T.EquirectangularReflectionMapping;
      return new Promise<T.Texture | null>((resolve) => {
        enqueuePmremBake({
          key,
          renderer,
          equirect,
          atEpoch: at,
          priority,
          frameSpacing,
          resolve,
        });
      });
    })
    .catch(() => null)
    .finally(() => {
      if (hdriPending.get(key) === promise) hdriPending.delete(key);
    });

  hdriPending.set(key, promise);
  return promise;
}

/** Maps normalized daylight factor [0..1] and indoor state to the matching staged HDRI environment slot. */
export function selectHdriEnvKey(day: number, indoors = false): HdriEnvKey {
  if (indoors) return 'interior';
  if (day < 0.22) return 'night';
  if (day < 0.52) return 'sunset';
  if (day < 0.78) return 'morning';
  return 'midday';
}

function disposeHdriCache() {
  if (pmremPumpRafId !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(pmremPumpRafId);
  }
  pmremPumpRafId = null;
  pmremCooldownFrames = 0;
  while (pmremBakeQueue.length > 0) {
    const job = pmremBakeQueue.shift()!;
    disposeEquirectDataTexture(job.equirect);
    job.resolve(null);
  }
  for (const rt of hdriTargets.values()) rt.dispose();
  hdriTargets.clear();
  hdriPending.clear();
  pmremGen?.dispose();
  pmremGen = null;
  pmremRenderer = null;
  pmremShaderCompiledFor = null;
}

/** Estimates resident GPU VRAM bytes for a Three.js texture (including mipmap pyramid). */
export function estimateTextureBytes(tex: T.Texture | null | undefined): number {
  if (!tex) return 0;
  const img = tex.image as { width?: number; height?: number } | null | undefined;
  const w = img?.width ?? 0;
  const h = img?.height ?? 0;
  if (w <= 0 || h <= 0) return 0;
  const bpp = tex.type === T.HalfFloatType ? 8 : tex.type === T.FloatType ? 16 : 4;
  const mipFactor = tex.generateMipmaps ? 1.3334 : 1.0;
  return Math.round(w * h * bpp * mipFactor);
}

/** Diagnostic snapshot for QA/HUD telemetry (includes tracked byte-estimated VRAM). */
export function pbrAtlasStats() {
  let baseBytes = 0;
  for (const tex of baseTextures.values()) baseBytes += estimateTextureBytes(tex);
  let hdriBytes = 0;
  for (const rt of hdriTargets.values()) {
    hdriBytes += Math.round(rt.width * rt.height * 8); // HalfFloat RGBA CubeUV
  }
  const estimatedVramBytes = baseBytes + hdriBytes;
  return {
    definedSurfaces: Object.keys(PBR_SURFACES).length,
    loadedBaseTextures: baseTextures.size,
    cachedVariants: variantTextures.size,
    cachedHdris: hdriTargets.size,
    pendingHdriBakes: pmremBakeQueue.length,
    estimatedVramBytes,
    estimatedVramMB: Math.round((estimatedVramBytes / (1024 * 1024)) * 100) / 100,
  };
}

/**
 * Releases every cached PBR texture, repeat variant, PMREM render target, and PMREM generator.
 * Call when leaving Echo Life so the study space / other routes retain zero idle VRAM.
 */
export function disposePbrAtlas() {
  epoch++;
  const disposed = new Set<T.Texture>();
  for (const tex of variantTextures.values()) {
    if (!disposed.has(tex)) {
      tex.dispose();
      disposed.add(tex);
    }
  }
  for (const tex of baseTextures.values()) {
    if (!disposed.has(tex)) {
      tex.dispose();
      disposed.add(tex);
    }
  }
  // Close owned ImageBitmaps strictly inside dispose (never post-upload, so anisotropy/context restore stays safe!).
  for (const bitmap of ownedBitmaps.values()) {
    try {
      bitmap.close();
    } catch {
      // Ignore already-closed bitmap
    }
  }
  ownedBitmaps.clear();
  variantTextures.clear();
  baseTextures.clear();
  clonesByUrl.clear();
  anisoByUrl.clear();
  pendingBaseLoads.clear();
  disposeHdriCache();
}
