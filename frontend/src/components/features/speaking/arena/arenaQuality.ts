import * as T from 'three';
import type { ArenaQualityTier, ArenaTimeOfDay } from './arenaContracts';

export interface ArenaQualityConfig {
  tier: ArenaQualityTier;
  labelEn: string;
  labelVi: string;
  maxPixelRatio: number;
  antialias: boolean;
  shadowEnabled: boolean;
  shadowMapSize: number;
  shadowCameraExtent: number;
  anisotropy: number;
  waterGridDetailScale: number;
  waterCausticRes: number;
  waterCausticUpdateHz: number;
  underwaterRaySteps: number;
  underwaterRayScale: number;
  foliageDensity: number;
  foliageLod0DistM: number;
  foliageMaxDistM: number;
  marineScale: number;
  activeRingRadiusM: number;
  warmRingRadiusM: number;
  evictRingRadiusM: number;
  vramTextureBudgetMb: number;
  maxTextureUploadsPerFrame: number;
  enableAmbientVessels: boolean;
  enableUnderwaterConvolver: boolean;
}

export const ARENA_QUALITY_CONFIGS: Record<ArenaQualityTier, ArenaQualityConfig> = {
  ultra: {
    tier: 'ultra',
    labelEn: 'Ultra',
    labelVi: 'Siêu cao',
    maxPixelRatio: 2.0,
    antialias: true,
    shadowEnabled: true,
    shadowMapSize: 2048,
    shadowCameraExtent: 124,
    anisotropy: 8,
    waterGridDetailScale: 1.0,
    waterCausticRes: 512,
    waterCausticUpdateHz: 60,
    underwaterRaySteps: 34,
    underwaterRayScale: 0.5,
    foliageDensity: 1.0,
    foliageLod0DistM: 125,
    foliageMaxDistM: 460,
    marineScale: 1.0,
    activeRingRadiusM: 155,
    warmRingRadiusM: 310,
    evictRingRadiusM: 385,
    vramTextureBudgetMb: 320,
    maxTextureUploadsPerFrame: 3,
    enableAmbientVessels: true,
    enableUnderwaterConvolver: true,
  },
  high: {
    tier: 'high',
    labelEn: 'High',
    labelVi: 'Cao',
    maxPixelRatio: 1.75,
    antialias: true,
    shadowEnabled: true,
    shadowMapSize: 2048,
    shadowCameraExtent: 102,
    anisotropy: 4,
    waterGridDetailScale: 1.0,
    waterCausticRes: 512,
    waterCausticUpdateHz: 60,
    underwaterRaySteps: 26,
    underwaterRayScale: 0.5,
    foliageDensity: 0.85,
    foliageLod0DistM: 105,
    foliageMaxDistM: 400,
    marineScale: 0.8,
    activeRingRadiusM: 135,
    warmRingRadiusM: 275,
    evictRingRadiusM: 345,
    vramTextureBudgetMb: 220,
    maxTextureUploadsPerFrame: 2,
    enableAmbientVessels: true,
    enableUnderwaterConvolver: true,
  },
  balanced: {
    tier: 'balanced',
    labelEn: 'Balanced',
    labelVi: 'Cân bằng',
    maxPixelRatio: 1.35,
    antialias: true,
    shadowEnabled: true,
    shadowMapSize: 1024,
    shadowCameraExtent: 80,
    anisotropy: 2,
    waterGridDetailScale: 0.85,
    waterCausticRes: 512,
    waterCausticUpdateHz: 30,
    underwaterRaySteps: 18,
    underwaterRayScale: 0.38,
    foliageDensity: 0.65,
    foliageLod0DistM: 85,
    foliageMaxDistM: 330,
    marineScale: 0.55,
    activeRingRadiusM: 115,
    warmRingRadiusM: 235,
    evictRingRadiusM: 295,
    vramTextureBudgetMb: 145,
    maxTextureUploadsPerFrame: 2,
    enableAmbientVessels: true,
    enableUnderwaterConvolver: false,
  },
  low: {
    tier: 'low',
    labelEn: 'Battery Saver',
    labelVi: 'Tiết kiệm pin',
    maxPixelRatio: 1.0,
    antialias: false,
    shadowEnabled: false,
    shadowMapSize: 512,
    shadowCameraExtent: 56,
    anisotropy: 1,
    waterGridDetailScale: 0.65,
    waterCausticRes: 256,
    waterCausticUpdateHz: 20,
    underwaterRaySteps: 0,
    underwaterRayScale: 0.25,
    foliageDensity: 0.42,
    foliageLod0DistM: 60,
    foliageMaxDistM: 250,
    marineScale: 0.3,
    activeRingRadiusM: 92,
    warmRingRadiusM: 185,
    evictRingRadiusM: 235,
    vramTextureBudgetMb: 85,
    maxTextureUploadsPerFrame: 1,
    enableAmbientVessels: false,
    enableUnderwaterConvolver: false,
  },
};

export interface ArenaAtmospherePreset {
  id: ArenaTimeOfDay;
  sunDirection: T.Vector3;
  sunColor: number;
  sunIntensity: number;
  fillColor: number;
  fillIntensity: number;
  hemiSkyColor: number;
  hemiGroundColor: number;
  hemiIntensity: number;
  skyZenith: number;
  skyMid: number;
  skyHorizon: number;
  fogColor: number;
  exposure: number;
}

export const ARENA_ATMOSPHERE_PRESETS: Record<ArenaTimeOfDay, ArenaAtmospherePreset> = {
  daylight: {
    id: 'daylight',
    sunDirection: new T.Vector3(-0.52, 0.74, 0.42).normalize(),
    sunColor: 0xfff5e0,
    sunIntensity: 2.35,
    fillColor: 0x9bd7f2,
    fillIntensity: 0.52,
    hemiSkyColor: 0xbce6ff,
    hemiGroundColor: 0xc2ab82,
    hemiIntensity: 0.88,
    skyZenith: 0x2f7dc4,
    skyMid: 0x74bbe6,
    skyHorizon: 0xdff1f9,
    fogColor: 0xcfe9f5,
    exposure: 1.02,
  },
  sunset: {
    id: 'sunset',
    sunDirection: new T.Vector3(-0.74, 0.34, 0.58).normalize(),
    sunColor: 0xffad66,
    sunIntensity: 2.15,
    fillColor: 0x7d95d6,
    fillIntensity: 0.46,
    hemiSkyColor: 0xf6b98e,
    hemiGroundColor: 0x6f5a52,
    hemiIntensity: 0.78,
    skyZenith: 0x273d78,
    skyMid: 0x9b6b93,
    skyHorizon: 0xf7b277,
    fogColor: 0xe6b493,
    exposure: 1.06,
  },
};

const QUALITY_STORAGE_KEY = 'ec.speaking.arena.quality.v7';
const TIME_STORAGE_KEY = 'ec.speaking.arena.timeOfDay.v7';

export function isArenaQualityTier(v: unknown): v is ArenaQualityTier {
  return v === 'ultra' || v === 'high' || v === 'balanced' || v === 'low';
}

export function detectHardwareQualityTier(gl?: WebGLRenderingContext | WebGL2RenderingContext | null): ArenaQualityTier {
  if (typeof window === 'undefined') return 'balanced';
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return 'low';
    }
  } catch {
    // Ignore matchMedia failures in restricted environments.
  }

  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  const memoryGb =
    typeof navigator !== 'undefined' && 'deviceMemory' in navigator
      ? Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory || 8)
      : 8;
  const isCoarsePointer =
    typeof window !== 'undefined' && Boolean(window.matchMedia?.('(pointer: coarse)').matches);

  let rendererName = '';
  if (gl) {
    try {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        rendererName = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '').toLowerCase();
      }
    } catch {
      rendererName = '';
    }
  }

  if (
    rendererName.includes('swiftshader') ||
    rendererName.includes('llvmpipe') ||
    rendererName.includes('basic render') ||
    memoryGb <= 4 ||
    cores <= 2
  ) {
    return 'low';
  }

  if (isCoarsePointer) {
    return memoryGb >= 8 ? 'balanced' : 'low';
  }

  if (
    rendererName.includes('rtx 40') ||
    rendererName.includes('rtx 50') ||
    rendererName.includes('rx 78') ||
    rendererName.includes('rx 79') ||
    rendererName.includes('apple m3 max') ||
    rendererName.includes('apple m4')
  ) {
    return 'ultra';
  }

  if (
    rendererName.includes('rtx ') ||
    rendererName.includes('gtx 16') ||
    rendererName.includes('radeon rx 6') ||
    rendererName.includes('radeon rx 7') ||
    rendererName.includes('apple m1') ||
    rendererName.includes('apple m2') ||
    rendererName.includes('apple m3')
  ) {
    return 'high';
  }

  if (
    rendererName.includes('uhd graphics') ||
    rendererName.includes('iris') ||
    rendererName.includes('radeon(tm) graphics') ||
    rendererName.includes('vega')
  ) {
    return cores >= 6 && memoryGb >= 8 ? 'balanced' : 'low';
  }

  return cores >= 8 && memoryGb >= 8 ? 'high' : 'balanced';
}

export function loadSavedArenaQuality(): ArenaQualityTier | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(QUALITY_STORAGE_KEY);
    return isArenaQualityTier(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function saveArenaQuality(tier: ArenaQualityTier): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(QUALITY_STORAGE_KEY, tier);
  } catch {
    // Ignore storage quota errors.
  }
}

export function loadSavedArenaTimeOfDay(): ArenaTimeOfDay {
  if (typeof window === 'undefined') return 'daylight';
  try {
    const raw = window.localStorage.getItem(TIME_STORAGE_KEY);
    return raw === 'sunset' ? 'sunset' : 'daylight';
  } catch {
    return 'daylight';
  }
}

export function saveArenaTimeOfDay(tod: ArenaTimeOfDay): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TIME_STORAGE_KEY, tod);
  } catch {
    // Ignore storage quota errors.
  }
}

/**
 * Applies a quality tier in-place to an existing WebGLRenderer and DirectionalLight
 * WITHOUT destroying or recreating the WebGL context.
 */
export function applyQualityToRendererInPlace(
  renderer: T.WebGLRenderer,
  sunLight: T.DirectionalLight | null,
  tier: ArenaQualityTier,
  viewportWidth: number,
  viewportHeight: number,
): ArenaQualityConfig {
  const cfg = ARENA_QUALITY_CONFIGS[tier];
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, cfg.maxPixelRatio) : 1;
  renderer.setPixelRatio(dpr);
  renderer.setSize(Math.max(1, viewportWidth), Math.max(1, viewportHeight), false);

  if (renderer.shadowMap.enabled !== cfg.shadowEnabled) {
    renderer.shadowMap.enabled = cfg.shadowEnabled;
    renderer.shadowMap.needsUpdate = true;
  }

  if (sunLight) {
    sunLight.castShadow = cfg.shadowEnabled;
    if (cfg.shadowEnabled) {
      const ext = cfg.shadowCameraExtent;
      sunLight.shadow.camera.left = -ext;
      sunLight.shadow.camera.right = ext;
      sunLight.shadow.camera.top = ext;
      sunLight.shadow.camera.bottom = -ext;
      sunLight.shadow.camera.updateProjectionMatrix();

      if (
        sunLight.shadow.mapSize.x !== cfg.shadowMapSize ||
        sunLight.shadow.mapSize.y !== cfg.shadowMapSize
      ) {
        sunLight.shadow.mapSize.set(cfg.shadowMapSize, cfg.shadowMapSize);
        if (sunLight.shadow.map) {
          sunLight.shadow.map.dispose();
          sunLight.shadow.map = null;
        }
      }
      renderer.shadowMap.needsUpdate = true;
    }
  }

  return cfg;
}
