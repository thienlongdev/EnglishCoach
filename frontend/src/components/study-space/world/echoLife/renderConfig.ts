import * as T from 'three';

/**
 * Echo Life Total Rebirth — 4-Tier Graphics Quality Configuration & GPU Capability Probe.
 *
 * Calibrated for NVIDIA GeForce RTX 5070 12 GB VRAM (`ultra` = maximum justified visual fidelity)
 * while keeping `low` lean and smooth for AMD Radeon iGPUs and thin-and-light laptops.
 *
 * Pure module with zero side effects or runtime DOM mutations; safe to import across
 * StudyWorld, CityStreamer, CityView, PostFXController, and HUD selectors.
 */

export type QualityTier = 'low' | 'balanced' | 'high' | 'ultra';

export const QUALITY_TIERS: readonly QualityTier[] = ['low', 'balanced', 'high', 'ultra'] as const;

export type GpuClass = 'ultra-dgpu' | 'mid-dgpu' | '4gb-dgpu' | 'igpu' | 'software' | 'unknown';

export interface WebGpuAdapterSummary {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
  readonly isFallbackAdapter: boolean;
}

export interface GpuCapabilityReport {
  readonly webglRenderer: string;
  readonly webglVendor: string;
  readonly isWebGL2: boolean;
  readonly maxAnisotropy: number;
  readonly maxTextureSize: number;
  readonly hasColorBufferFloat: boolean;
  readonly hasColorBufferHalfFloat: boolean;
  readonly webgpuAvailable: boolean;
  readonly webgpuAdapter: WebGpuAdapterSummary | null;
  readonly gpuClass: GpuClass;
  readonly recommendedTier: QualityTier;
}

export interface PostFXSsaoConfig {
  readonly enabled: boolean;
  readonly resolutionScale: number;
  /** Must not be a multiple of `rings` (postprocessing spiral sampling rule). */
  readonly samples: number;
  /** Should be a prime number to prevent radial banding. */
  readonly rings: number;
  readonly radius: number;
  readonly minRadiusScale: number;
  readonly intensity: number;
  readonly luminanceInfluence: number;
  readonly bias: number;
  readonly fade: number;
  readonly worldDistanceThreshold: number;
  readonly worldDistanceFalloff: number;
  readonly worldProximityThreshold: number;
  readonly worldProximityFalloff: number;
}

export interface PostFXN8aoConfig {
  readonly enabled: boolean;
  readonly halfRes: boolean;
  readonly depthAwareUpsampling: boolean;
  readonly aoRadius: number;
  readonly distanceFalloff: number;
  readonly intensity: number;
  readonly aoSamples: number;
  readonly denoiseSamples: number;
  readonly denoiseRadius: number;
  readonly denoiseIterations: number;
  /** Flat-plane grazing depth bias offset (metres) preventing half-res depth-reconstruction AO streaks. */
  readonly biasOffset: number;
  /** Slope-scaled depth bias multiplier (`bias = biasOffset + biasMultiplier * rawBias`). */
  readonly biasMultiplier: number;
  /** Subtle dark sky-tinted AO color (sRGB hex). */
  readonly color: string;
}

export interface PostFXBloomConfig {
  readonly enabled: boolean;
  readonly mipmapBlur: boolean;
  readonly luminanceThreshold: number;
  readonly luminanceSmoothing: number;
  readonly intensity: number;
  readonly radius: number;
  readonly levels: number;
}

export interface PostFXColorGradingConfig {
  readonly enabled: boolean;
  readonly brightness: number;
  readonly contrast: number;
  readonly saturation: number;
  readonly vignetteOffset: number;
  readonly vignetteDarkness: number;
}

export interface PostFXTierConfig {
  readonly enabled: boolean;
  readonly halfFloat: boolean;
  readonly smaa: 'off' | 'high' | 'ultra';
  readonly n8ao: PostFXN8aoConfig;
  readonly ssao: PostFXSsaoConfig;
  readonly bloom: PostFXBloomConfig;
  readonly toneMapping: 'agx' | 'aces';
  readonly colorGrading: PostFXColorGradingConfig;
}

export interface ShadowTierConfig {
  readonly enabled: boolean;
  readonly mapSize: number;
  readonly frustumHalfExtent: number;
  /** 0 = disabled, 1 = every frame, 2 = every 2nd frame. */
  readonly cadence: number;
  /** Number of CSM cascades: 0 (Low), 1 (Balanced), 2 (High), 3 (Ultra). */
  readonly cascades: number;
  /** Primary (Cascade 0) resolution (e.g. 2048 Ultra, 1536 High, 1024 Balanced). */
  readonly cascadeMapSize: number;
  /** Per-cascade shadow map resolutions (e.g. [2048, 1536, 1024] Ultra, [1536, 1024] High, [1024] Balanced). */
  readonly cascadeMapSizes: readonly number[];
  /** World-space split distances (metres) for active cascades (e.g. [22, 60, 140]). */
  readonly cascadeSplits: readonly number[];
  /** Per-cascade update cadences in frames (e.g. [1, 2, 4] Ultra, [1, 2] High, [2] Balanced). */
  readonly cascadeCadences: readonly number[];
  /** Update cadence for the farthest cascade (4 Ultra, 2 High/Balanced). */
  readonly farCascadeCadence: number;
  /** Max distance (metres) at which NPCs cast real shadow-map shadows (Cascade 0 only). */
  readonly maxNpcShadowDist: number;
  /** Soft grounded contact shadow decals under characters/vehicles. */
  readonly contactShadows: boolean;
  readonly castHeroTrees: boolean;
  readonly castAllLots: boolean;
  readonly castNpcs: boolean;
}

export interface StreamingTierConfig {
  readonly hotEnter: number;
  readonly hotExit: number;
  readonly warmEnter: number;
  readonly warmExit: number;
  readonly maxResidentAssets: number;
  /** Legacy texture count cap (recalibrated above baseline HDRI/atlas/RT overhead to prevent thrashing). */
  readonly vramTextureCap: number;
  /** Tracked resident asset texture VRAM budget in megabytes (192 Low / 384 Balanced / 768 High / 1536 Ultra). */
  readonly vramBudgetMB: number;
  readonly pruneTarget: number;
  readonly useFullLotGlbs: 'none' | 'core-only' | 'all';
  readonly filterHalfLots: boolean;
  readonly prefetchPerChunk: number;
  /** Max main-thread milliseconds spent per frame promoting a chunk to HOT. */
  readonly hotBuildBudgetMs: number;
}

export interface WaterTierConfig {
  /** Enables 0.5x distance-gated planar reflection render pass for the river surface. */
  readonly planarReflection: boolean;
  /** Reflection render target scale relative to drawing buffer (0.5 on High/Ultra). */
  readonly reflectionScale: number;
  /** Max camera-to-river distance (metres) where planar reflection updates. */
  readonly reflectionMaxDist: number;
  /** Planar reflection update cadence (1 = every frame on Ultra, 2 = alternating frames on High). */
  readonly reflectionCadence: number;
  /** Number of Voronoi raindrop ripple layers on water surface (0..3). */
  readonly rainRippleLayers: number;
}

export interface VegetationTierConfig {
  readonly grassDensity: number;
  readonly treeFullDist: number;
  readonly treeImpostorDist: number;
}

export interface CrowdTierConfig {
  readonly maxNamedSkinned: number;
  readonly maxCrowdSkinned: number;
  readonly animFullDist: number;
  readonly animHalfDist: number;
  readonly animQuarterDist: number;
  readonly frustumCullMixers: boolean;
}

export interface AtmosphereTierConfig {
  readonly weatherParticles: number;
  readonly streetlampPool: number;
}

export interface RenderConfig {
  readonly tier: QualityTier;
  readonly dprCap: number;
  /** Internal resolution scale multiplier for integrated GPU fill-rate relief (`0.75` on `low`, `1.0` on Balanced/High/Ultra). */
  readonly igpuRenderScale: number;
  readonly nativeAntialias: boolean;
  readonly anisotropy: number;
  readonly toneMapping: T.ToneMapping;
  readonly outdoorIbl: boolean;
  /** When true, PBR surfaces load albedo-only maps (skipping normal & ORM maps for iGPU memory savings). */
  readonly pbrColorOnly: boolean;
  readonly shadow: ShadowTierConfig;
  readonly streaming: StreamingTierConfig;
  readonly water: WaterTierConfig;
  readonly vegetation: VegetationTierConfig;
  readonly crowd: CrowdTierConfig;
  readonly atmosphere: AtmosphereTierConfig;
  readonly postfx: PostFXTierConfig;
}

const N8AO_OFF: PostFXN8aoConfig = Object.freeze({
  enabled: false,
  halfRes: true,
  depthAwareUpsampling: true,
  aoRadius: 1.8,
  distanceFalloff: 1.0,
  intensity: 0,
  aoSamples: 8,
  denoiseSamples: 8,
  denoiseRadius: 10,
  denoiseIterations: 3,
  biasOffset: 0.035,
  biasMultiplier: 0.35,
  color: '#0d1522',
});

const SSAO_OFF: PostFXSsaoConfig = Object.freeze({
  enabled: false,
  resolutionScale: 0.5,
  samples: 9,
  rings: 7,
  radius: 0.35,
  minRadiusScale: 0.15,
  intensity: 0,
  luminanceInfluence: 0.35,
  bias: 0.024,
  fade: 0.015,
  worldDistanceThreshold: 55,
  worldDistanceFalloff: 18,
  worldProximityThreshold: 0.85,
  worldProximityFalloff: 0.25,
});

const BLOOM_OFF: PostFXBloomConfig = Object.freeze({
  enabled: false,
  mipmapBlur: true,
  luminanceThreshold: 1.40,
  luminanceSmoothing: 0.25,
  intensity: 0,
  radius: 0.50,
  levels: 5,
});

const GRADING_OFF: PostFXColorGradingConfig = Object.freeze({
  enabled: false,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  vignetteOffset: 0.4,
  vignetteDarkness: 0,
});

export const RENDER_CONFIGS: Readonly<Record<QualityTier, RenderConfig>> = Object.freeze({
  low: Object.freeze({
    tier: 'low',
    dprCap: 1.0,
    igpuRenderScale: 0.75,
    nativeAntialias: false,
    anisotropy: 1,
    toneMapping: T.AgXToneMapping,
    outdoorIbl: false,
    pbrColorOnly: true,
    shadow: Object.freeze({
      enabled: false,
      mapSize: 0,
      frustumHalfExtent: 0,
      cadence: 0,
      cascades: 0,
      cascadeMapSize: 0,
      cascadeMapSizes: Object.freeze([]),
      cascadeSplits: Object.freeze([]),
      cascadeCadences: Object.freeze([]),
      farCascadeCadence: 0,
      maxNpcShadowDist: 0,
      contactShadows: true,
      castHeroTrees: false,
      castAllLots: false,
      castNpcs: false,
    }),
    streaming: Object.freeze({
      hotEnter: 30,
      hotExit: 40,
      warmEnter: 80,
      warmExit: 100,
      maxResidentAssets: 36,
      vramTextureCap: 240,
      vramBudgetMB: 192,
      pruneTarget: 24,
      useFullLotGlbs: 'none',
      filterHalfLots: true,
      prefetchPerChunk: 0,
      hotBuildBudgetMs: 4,
    }),
    water: Object.freeze({
      planarReflection: false,
      reflectionScale: 0,
      reflectionMaxDist: 0,
      reflectionCadence: 0,
      rainRippleLayers: 0,
    }),
    vegetation: Object.freeze({
      grassDensity: 0,
      treeFullDist: 18,
      treeImpostorDist: 32,
    }),
    crowd: Object.freeze({
      maxNamedSkinned: 3,
      maxCrowdSkinned: 1,
      animFullDist: 9,
      animHalfDist: 18,
      animQuarterDist: 28,
      frustumCullMixers: true,
    }),
    atmosphere: Object.freeze({
      weatherParticles: 200,
      streetlampPool: 2,
    }),
    postfx: Object.freeze({
      enabled: false,
      halfFloat: false,
      smaa: 'off',
      n8ao: N8AO_OFF,
      ssao: SSAO_OFF,
      bloom: BLOOM_OFF,
      toneMapping: 'agx',
      colorGrading: GRADING_OFF,
    }),
  }),

  balanced: Object.freeze({
    tier: 'balanced',
    dprCap: 1.5,
    igpuRenderScale: 1.0,
    nativeAntialias: true,
    anisotropy: 4,
    toneMapping: T.AgXToneMapping,
    outdoorIbl: true,
    pbrColorOnly: false,
    shadow: Object.freeze({
      enabled: true,
      mapSize: 1024,
      frustumHalfExtent: 26,
      cadence: 2,
      cascades: 1,
      cascadeMapSize: 1024,
      cascadeMapSizes: Object.freeze([1024]),
      cascadeSplits: Object.freeze([26]),
      cascadeCadences: Object.freeze([2]),
      farCascadeCadence: 2,
      maxNpcShadowDist: 0,
      contactShadows: true,
      castHeroTrees: false,
      castAllLots: false,
      castNpcs: false,
    }),
    streaming: Object.freeze({
      hotEnter: 40,
      hotExit: 52,
      warmEnter: 105,
      warmExit: 128,
      maxResidentAssets: 56,
      vramTextureCap: 540,
      vramBudgetMB: 384,
      pruneTarget: 40,
      useFullLotGlbs: 'none',
      filterHalfLots: false,
      prefetchPerChunk: 8,
      hotBuildBudgetMs: 4,
    }),
    water: Object.freeze({
      planarReflection: false,
      reflectionScale: 0,
      reflectionMaxDist: 0,
      reflectionCadence: 0,
      rainRippleLayers: 1,
    }),
    vegetation: Object.freeze({
      grassDensity: 0.35,
      treeFullDist: 28,
      treeImpostorDist: 50,
    }),
    crowd: Object.freeze({
      maxNamedSkinned: 6,
      maxCrowdSkinned: 2,
      animFullDist: 12,
      animHalfDist: 24,
      animQuarterDist: 38,
      frustumCullMixers: true,
    }),
    atmosphere: Object.freeze({
      weatherParticles: 460,
      streetlampPool: 4,
    }),
    postfx: Object.freeze({
      enabled: false,
      halfFloat: false,
      smaa: 'off',
      n8ao: N8AO_OFF,
      ssao: SSAO_OFF,
      bloom: BLOOM_OFF,
      toneMapping: 'agx',
      colorGrading: GRADING_OFF,
    }),
  }),

  high: Object.freeze({
    tier: 'high',
    dprCap: 2.0,
    igpuRenderScale: 1.0,
    nativeAntialias: false,
    anisotropy: 8,
    toneMapping: T.AgXToneMapping,
    outdoorIbl: true,
    pbrColorOnly: false,
    shadow: Object.freeze({
      enabled: true,
      mapSize: 1536,
      frustumHalfExtent: 22,
      cadence: 1,
      cascades: 2,
      cascadeMapSize: 1536,
      cascadeMapSizes: Object.freeze([1536, 1024]),
      cascadeSplits: Object.freeze([22, 65]),
      cascadeCadences: Object.freeze([1, 2]),
      farCascadeCadence: 2,
      maxNpcShadowDist: 22,
      contactShadows: true,
      castHeroTrees: true,
      castAllLots: false,
      castNpcs: true,
    }),
    streaming: Object.freeze({
      hotEnter: 50,
      hotExit: 66,
      warmEnter: 120,
      warmExit: 145,
      maxResidentAssets: 84,
      vramTextureCap: 820,
      vramBudgetMB: 768,
      pruneTarget: 64,
      useFullLotGlbs: 'core-only',
      filterHalfLots: false,
      prefetchPerChunk: 10,
      hotBuildBudgetMs: 6,
    }),
    water: Object.freeze({
      planarReflection: true,
      reflectionScale: 0.5,
      reflectionMaxDist: 48,
      reflectionCadence: 3,
      rainRippleLayers: 2,
    }),
    vegetation: Object.freeze({
      grassDensity: 0.7,
      treeFullDist: 40,
      treeImpostorDist: 72,
    }),
    crowd: Object.freeze({
      maxNamedSkinned: 10,
      maxCrowdSkinned: 4,
      animFullDist: 20,
      animHalfDist: 38,
      animQuarterDist: 60,
      frustumCullMixers: true,
    }),
    atmosphere: Object.freeze({
      weatherParticles: 720,
      streetlampPool: 4,
    }),
    postfx: Object.freeze({
      enabled: true,
      halfFloat: true,
      smaa: 'high',
      n8ao: Object.freeze({
        enabled: true,
        halfRes: true,
        depthAwareUpsampling: true,
        aoRadius: 1.8,
        distanceFalloff: 1.0,
        intensity: 1.75,
        aoSamples: 12,
        denoiseSamples: 8,
        denoiseRadius: 13,
        denoiseIterations: 3,
        biasOffset: 0.035,
        biasMultiplier: 0.35,
        color: '#0d1522',
      }),
      ssao: Object.freeze({
        enabled: true,
        resolutionScale: 0.5,
        samples: 11,
        rings: 7,
        radius: 0.38,
        minRadiusScale: 0.16,
        intensity: 1.35,
        luminanceInfluence: 0.38,
        bias: 0.024,
        fade: 0.015,
        worldDistanceThreshold: 55,
        worldDistanceFalloff: 18,
        worldProximityThreshold: 0.85,
        worldProximityFalloff: 0.25,
      }),
      bloom: Object.freeze({
        enabled: true,
        mipmapBlur: true,
        luminanceThreshold: 1.40,
        luminanceSmoothing: 0.25,
        intensity: 0.16,
        radius: 0.50,
        levels: 5,
      }),
      toneMapping: 'agx',
      colorGrading: Object.freeze({
        enabled: true,
        brightness: 0.008,
        contrast: 0.04,
        saturation: 0.04,
        vignetteOffset: 0.40,
        vignetteDarkness: 0.16,
      }),
    }),
  }),

  ultra: Object.freeze({
    tier: 'ultra',
    dprCap: 2.0,
    igpuRenderScale: 1.0,
    nativeAntialias: false,
    anisotropy: 16,
    toneMapping: T.AgXToneMapping,
    outdoorIbl: true,
    pbrColorOnly: false,
    shadow: Object.freeze({
      enabled: true,
      mapSize: 2048,
      frustumHalfExtent: 22,
      cadence: 1,
      cascades: 3,
      cascadeMapSize: 2048,
      cascadeMapSizes: Object.freeze([2048, 1536, 1024]),
      cascadeSplits: Object.freeze([22, 60, 140]),
      cascadeCadences: Object.freeze([1, 2, 4]),
      farCascadeCadence: 4,
      maxNpcShadowDist: 22,
      contactShadows: true,
      castHeroTrees: true,
      castAllLots: true,
      castNpcs: true,
    }),
    streaming: Object.freeze({
      hotEnter: 64,
      hotExit: 82,
      warmEnter: 145,
      warmExit: 175,
      maxResidentAssets: 128,
      vramTextureCap: 1200,
      vramBudgetMB: 1536,
      pruneTarget: 96,
      useFullLotGlbs: 'all',
      filterHalfLots: false,
      prefetchPerChunk: 14,
      hotBuildBudgetMs: 8,
    }),
    water: Object.freeze({
      planarReflection: true,
      reflectionScale: 0.5,
      reflectionMaxDist: 52,
      reflectionCadence: 2,
      rainRippleLayers: 3,
    }),
    vegetation: Object.freeze({
      grassDensity: 1.0,
      treeFullDist: 55,
      treeImpostorDist: 95,
    }),
    crowd: Object.freeze({
      maxNamedSkinned: 14,
      maxCrowdSkinned: 6,
      animFullDist: 28,
      animHalfDist: 52,
      animQuarterDist: 80,
      frustumCullMixers: true,
    }),
    atmosphere: Object.freeze({
      weatherParticles: 1200,
      streetlampPool: 6,
    }),
    postfx: Object.freeze({
      enabled: true,
      halfFloat: true,
      smaa: 'ultra',
      n8ao: Object.freeze({
        enabled: true,
        halfRes: true,
        depthAwareUpsampling: true,
        aoRadius: 2.1,
        distanceFalloff: 0.95,
        intensity: 2.05,
        aoSamples: 12,
        denoiseSamples: 8,
        denoiseRadius: 12,
        denoiseIterations: 3,
        biasOffset: 0.032,
        biasMultiplier: 0.32,
        color: '#0d1522',
      }),
      ssao: Object.freeze({
        enabled: true,
        resolutionScale: 0.5,
        samples: 16,
        rings: 7,
        radius: 0.45,
        minRadiusScale: 0.16,
        intensity: 1.55,
        luminanceInfluence: 0.35,
        bias: 0.024,
        fade: 0.015,
        worldDistanceThreshold: 60,
        worldDistanceFalloff: 18,
        worldProximityThreshold: 0.85,
        worldProximityFalloff: 0.25,
      }),
      bloom: Object.freeze({
        enabled: true,
        mipmapBlur: true,
        luminanceThreshold: 1.38,
        luminanceSmoothing: 0.25,
        intensity: 0.18,
        radius: 0.54,
        levels: 6,
      }),
      toneMapping: 'agx',
      colorGrading: Object.freeze({
        enabled: true,
        brightness: 0.012,
        contrast: 0.055,
        saturation: 0.055,
        vignetteOffset: 0.38,
        vignetteDarkness: 0.22,
      }),
    }),
  }),
});

export function isQualityTier(value: unknown): value is QualityTier {
  return value === 'low' || value === 'balanced' || value === 'high' || value === 'ultra';
}

export function normalizeQualityTier(value: unknown, fallback: QualityTier = 'balanced'): QualityTier {
  return isQualityTier(value) ? value : fallback;
}

export function stepDownQualityTier(tier: QualityTier): QualityTier {
  if (tier === 'ultra') return 'high';
  if (tier === 'high') return 'balanced';
  return 'low';
}

/**
 * Returns the tier configuration with `anisotropy` clamped to the active GPU's
 * hardware `MAX_TEXTURE_MAX_ANISOTROPY_EXT` limit, plus the High-4G VRAM clamp
 * (`dprCap <= 1.25`, `nativeAntialias: false`, `[1024, 1024]` shadow cascades,
 * `grassDensity: 0.5`, `vramBudgetMB: 520`) when a 4 GB discrete GPU opts into `'high'`.
 */
export function getRenderConfig(
  tier: QualityTier,
  maxAnisotropy?: number,
  gpuClass?: GpuClass,
): RenderConfig {
  let cfg = RENDER_CONFIGS[tier];

  if (tier === 'high' && gpuClass === '4gb-dgpu') {
    cfg = {
      ...cfg,
      dprCap: Math.min(cfg.dprCap, 1.25),
      nativeAntialias: false,
      shadow: {
        ...cfg.shadow,
        mapSize: 1024,
        cascadeMapSize: 1024,
        cascadeMapSizes: Object.freeze([1024, 1024]),
      },
      streaming: {
        ...cfg.streaming,
        vramBudgetMB: Math.min(cfg.streaming.vramBudgetMB, 520),
        vramTextureCap: Math.min(cfg.streaming.vramTextureCap, 640),
      },
      water: {
        ...cfg.water,
        reflectionCadence: Math.max(cfg.water.reflectionCadence, 3),
      },
      vegetation: {
        ...cfg.vegetation,
        grassDensity: Math.min(cfg.vegetation.grassDensity, 0.5),
      },
    };
  }

  if (maxAnisotropy === undefined || !Number.isFinite(maxAnisotropy) || maxAnisotropy <= 0) {
    return cfg;
  }
  const clamped = Math.max(1, Math.min(cfg.anisotropy, Math.floor(maxAnisotropy)));
  if (clamped === cfg.anisotropy) return cfg;
  return { ...cfg, anisotropy: clamped };
}

// ── GPU Classification & Non-Blocking WebGL2 + WebGPU Probe ────────────────────────────────────────

interface WebGpuAdapterInfoLike {
  readonly vendor?: string;
  readonly architecture?: string;
  readonly device?: string;
  readonly description?: string;
}

interface WebGpuAdapterLike {
  readonly info?: WebGpuAdapterInfoLike;
  readonly isFallbackAdapter?: boolean;
  requestAdapterInfo?: () => Promise<WebGpuAdapterInfoLike>;
}

interface WebGpuLike {
  readonly requestAdapter?: (options?: {
    powerPreference?: 'high-performance' | 'low-power';
    forceFallbackAdapter?: boolean;
  }) => Promise<WebGpuAdapterLike | null>;
}

function getNavigatorGpu(): WebGpuLike | null {
  if (typeof navigator === 'undefined') return null;
  const gpu = (navigator as unknown as { gpu?: WebGpuLike }).gpu;
  return gpu ?? null;
}

const SOFTWARE_RE = /swiftshader|llvmpipe|softpipe|microsoft basic render|lavapipe|warp/i;
const ULTRA_DGPU_RE =
  /\b(?:rtx\s*(?:50[6789]0|40[789]0|30[89]0)|rx\s*(?:9070|7900|7800|69[05]0|6800)|radeon\s*pro\s*w[67]8|apple\s*m[34]\s*(?:pro|max|ultra)|blackwell|ada\s*lovelace)\b/i;
/**
 * 4 GB discrete laptop/entry GPUs that risk WDDM paging cliffs under default `high` (`dprCap: 2.0`,
 * `1536/1024` cascades, `768 MB` texture pool). Explicitly excludes `RTX 3050 6GB Laptop`!
 */
const RTX_3050_LAPTOP_RE = /\brtx\s*3050(?:\s*(?:ti|a|4\s*gb))?\s*laptop\b/i;
const RTX_3050_6GB_RE = /\brtx\s*3050\s*6\s*gb\b/i;
const FOUR_GB_DGPU_RE =
  /\b(?:rtx\s*2050|gtx\s*16[56]0(?:\s*(?:ti|super|max-q))?|gtx\s*10[56]0(?:\s*(?:ti|max-q))?|mx\s*\d{3})\b/i;
const MID_DGPU_RE =
  /\b(?:rtx\s*(?:5050|40[56]0|30[67]0|3050|20[678]0)|gtx\s*(?:10[78]0)|rx\s*(?:7700|7600|67[05]0|66[05]0|5700|5600)|arc\s*a[57]\d0|arc\s*b5\d0|apple\s*m[1234]\b)\b/i;
const GENERIC_NVIDIA_RE = /\b(?:nvidia|geforce)\b/i;
const IGPU_RE =
  /\b(?:amd\s*radeon\(tm\)\s*graphics|radeon\s*(?:vega|7[468]0m|6[68]0m)|intel.*(?:uhd|hd\s*graphics|iris|xe\s*graphics)|adreno|mali-|powervr|apple\s*gpu)\b/i;

function isMobileClient(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent ?? '');
}

/**
 * Pure GPU classifier exported for deterministic unit verification (e.g. RTX 3050 4 GB Laptop vs
 * RTX 3050 6 GB Laptop, MX450, Firefox sanitized "GeForce GTX 980, or similar", iGPUs, SwiftShader).
 */
export function classifyGpuName(
  adapterName: string,
  maxTextureSize = 16384,
  isFallbackAdapter = false,
  options?: { cores?: number; mobile?: boolean },
): { gpuClass: GpuClass; recommendedTier: QualityTier } {
  const cores =
    options?.cores ??
    (typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 8);
  const mobile = options?.mobile ?? isMobileClient();

  if (isFallbackAdapter || SOFTWARE_RE.test(adapterName)) {
    return { gpuClass: 'software', recommendedTier: 'low' };
  }
  if (mobile) {
    return { gpuClass: 'igpu', recommendedTier: 'low' };
  }
  if (ULTRA_DGPU_RE.test(adapterName) && maxTextureSize >= 8192) {
    return { gpuClass: 'ultra-dgpu', recommendedTier: cores >= 6 ? 'ultra' : 'high' };
  }
  // Check integrated AMD/Intel strings before discrete patterns so "AMD Radeon(TM) Graphics" never misclassifies.
  if (IGPU_RE.test(adapterName)) {
    return { gpuClass: 'igpu', recommendedTier: 'low' };
  }
  // 4 GB discrete laptop/entry GPUs: default to `balanced` (High is opt-in through High-4G clamp).
  // Explicitly exempt `RTX 3050 6GB Laptop` so 6 GB SKUs route to `mid-dgpu` -> `high`.
  if (
    !RTX_3050_6GB_RE.test(adapterName) &&
    (RTX_3050_LAPTOP_RE.test(adapterName) || FOUR_GB_DGPU_RE.test(adapterName))
  ) {
    return { gpuClass: '4gb-dgpu', recommendedTier: 'balanced' };
  }
  if (MID_DGPU_RE.test(adapterName) && maxTextureSize >= 8192) {
    return { gpuClass: 'mid-dgpu', recommendedTier: 'high' };
  }
  // Generic NVIDIA / GeForce strings (including Firefox sanitized "GeForce GTX 980, or similar" and GT/MX)
  // default safely to `balanced` rather than over-assigning `high`.
  if (GENERIC_NVIDIA_RE.test(adapterName)) {
    return { gpuClass: 'unknown', recommendedTier: 'balanced' };
  }
  if (cores <= 4) {
    return { gpuClass: 'unknown', recommendedTier: 'low' };
  }
  return { gpuClass: 'unknown', recommendedTier: 'balanced' };
}

function readWebGlInfo(gl: WebGLRenderingContext | WebGL2RenderingContext | null) {
  if (!gl) {
    return {
      webglRenderer: 'unavailable',
      webglVendor: 'unavailable',
      isWebGL2: false,
      maxAnisotropy: 1,
      maxTextureSize: 4096,
      hasColorBufferFloat: false,
      hasColorBufferHalfFloat: false,
    };
  }

  let webglRenderer = String(gl.getParameter(gl.RENDERER) ?? '');
  let webglVendor = String(gl.getParameter(gl.VENDOR) ?? '');
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      const unmaskedRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      const unmaskedVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
      if (typeof unmaskedRenderer === 'string' && unmaskedRenderer.length > 0) webglRenderer = unmaskedRenderer;
      if (typeof unmaskedVendor === 'string' && unmaskedVendor.length > 0) webglVendor = unmaskedVendor;
    }
  } catch {
    // Privacy-hardened browsers may reject WEBGL_debug_renderer_info; fall back to masked strings + WebGPU probe.
  }

  const isWebGL2 =
    typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

  let maxAnisotropy = 1;
  try {
    const anisoExt =
      gl.getExtension('EXT_texture_filter_anisotropic') ??
      gl.getExtension('MOZ_EXT_texture_filter_anisotropic') ??
      gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
    if (anisoExt) {
      const raw = Number(gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT));
      if (Number.isFinite(raw) && raw >= 1) maxAnisotropy = Math.floor(raw);
    }
  } catch {
    maxAnisotropy = 1;
  }

  let maxTextureSize = 4096;
  try {
    const raw = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    if (Number.isFinite(raw) && raw > 0) maxTextureSize = raw;
  } catch {
    maxTextureSize = 4096;
  }

  const hasColorBufferFloat = Boolean(gl.getExtension('EXT_color_buffer_float'));
  const hasColorBufferHalfFloat =
    hasColorBufferFloat || Boolean(gl.getExtension('EXT_color_buffer_half_float'));

  return {
    webglRenderer,
    webglVendor,
    isWebGL2,
    maxAnisotropy,
    maxTextureSize,
    hasColorBufferFloat,
    hasColorBufferHalfFloat,
  };
}

/**
 * Synchronous WebGL-only capability classification for zero-latency first-frame setup.
 * Always classifies the active WebGL adapter string first (the actual rendering GPU).
 */
export function probeWebGlCapabilitiesSync(
  gl: WebGLRenderingContext | WebGL2RenderingContext | null,
): GpuCapabilityReport {
  const info = readWebGlInfo(gl);
  const webglName = `${info.webglVendor} ${info.webglRenderer}`.trim();
  const { gpuClass, recommendedTier } = classifyGpuName(webglName, info.maxTextureSize, false);
  const webgpuAvailable = Boolean(getNavigatorGpu());

  return {
    ...info,
    webgpuAvailable,
    webgpuAdapter: null,
    gpuClass,
    recommendedTier,
  };
}

/**
 * Classifies a WebGL report + optional WebGPU adapter WITHOUT concatenating the two strings.
 * WebGL (the actual rendering adapter) always takes precedence whenever it resolves to a known GPU
 * class; WebGPU info is consulted ONLY when the WebGL renderer string was masked/generic (`'unknown'`).
 */
export function resolveGpuClassification(
  webglVendor: string,
  webglRenderer: string,
  maxTextureSize: number,
  webgpuAdapter: WebGpuAdapterSummary | null,
  options?: { cores?: number; mobile?: boolean },
): { gpuClass: GpuClass; recommendedTier: QualityTier } {
  const webglName = `${webglVendor} ${webglRenderer}`.trim();
  const fromWebGl = classifyGpuName(webglName, maxTextureSize, false, options);

  // WebGL string identified the actual rendering GPU: never override or pollute it with a
  // potentially different hybrid-laptop WebGPU adapter string!
  if (fromWebGl.gpuClass !== 'unknown' || !webgpuAdapter) {
    return fromWebGl;
  }

  const webgpuName = [
    webgpuAdapter.vendor,
    webgpuAdapter.architecture,
    webgpuAdapter.device,
    webgpuAdapter.description,
  ]
    .filter(Boolean)
    .join(' ');

  const fromWebGpu = classifyGpuName(
    webgpuName,
    maxTextureSize,
    webgpuAdapter.isFallbackAdapter,
    options,
  );
  // If WebGL was generic NVIDIA (unknown -> balanced) and WebGPU also stays unknown, keep WebGL's result.
  if (fromWebGpu.gpuClass === 'unknown') {
    return fromWebGl;
  }
  return fromWebGpu;
}

const WEBGPU_PROBE_TIMEOUT_MS = 400;

/**
 * Non-blocking GPU capability probe: classifies the WebGL string FIRST (the actual rendering GPU)
 * and only falls back to `navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })`
 * (bounded to <= 400 ms) when the WebGL string is redacted/generic (`gpuClass === 'unknown'`).
 * Never concatenates WebGL and WebGPU strings across hybrid-laptop adapters!
 */
export async function probeGpuCapabilities(
  gl: WebGLRenderingContext | WebGL2RenderingContext | null,
): Promise<GpuCapabilityReport> {
  const base = probeWebGlCapabilitiesSync(gl);
  const gpu = getNavigatorGpu();
  if (!gpu || typeof gpu.requestAdapter !== 'function') {
    return base;
  }

  let webgpuAdapter: WebGpuAdapterSummary | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const adapter = await Promise.race<WebGpuAdapterLike | null>([
      gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), WEBGPU_PROBE_TIMEOUT_MS);
      }),
    ]);
    if (adapter) {
      let rawInfo: WebGpuAdapterInfoLike | undefined = adapter.info;
      if (!rawInfo && typeof adapter.requestAdapterInfo === 'function') {
        rawInfo = await adapter.requestAdapterInfo().catch(() => undefined);
      }
      webgpuAdapter = {
        vendor: rawInfo?.vendor ?? '',
        architecture: rawInfo?.architecture ?? '',
        device: rawInfo?.device ?? '',
        description: rawInfo?.description ?? '',
        isFallbackAdapter: Boolean(adapter.isFallbackAdapter),
      };
    }
  } catch {
    webgpuAdapter = null;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  if (!webgpuAdapter) {
    return { ...base, webgpuAvailable: false, webgpuAdapter: null };
  }

  const { gpuClass, recommendedTier } = resolveGpuClassification(
    base.webglVendor,
    base.webglRenderer,
    base.maxTextureSize,
    webgpuAdapter,
  );

  return {
    ...base,
    webgpuAvailable: true,
    webgpuAdapter,
    gpuClass,
    recommendedTier,
  };
}

/**
 * Probes WebGL2 capabilities on a throwaway offscreen canvas BEFORE creating the real `WebGLRenderer`,
 * enabling callers to lock `tier`, `gpuClass`, and `nativeAntialias` before context creation so zero
 * mid-session re-tiering or wasted MSAA default-framebuffer allocations occur.
 */
export function probeThrowawayWebGlCapabilities(): GpuCapabilityReport {
  if (typeof document === 'undefined') {
    return probeWebGlCapabilitiesSync(null);
  }
  let canvas: HTMLCanvasElement | null = null;
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  try {
    canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    gl =
      (canvas.getContext('webgl2', { powerPreference: 'high-performance' }) as WebGL2RenderingContext | null) ??
      (canvas.getContext('webgl', { powerPreference: 'high-performance' }) as WebGLRenderingContext | null);
    return probeWebGlCapabilitiesSync(gl);
  } catch {
    return probeWebGlCapabilitiesSync(null);
  } finally {
    try {
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      // Ignore context release error on synthetic canvas
    }
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
