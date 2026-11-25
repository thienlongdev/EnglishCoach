/**
 * Visual profiles. Every profile shows the same knowledge: only resolution, decoration and effects change. Auto picks one
 * from the device (the shared VFX heuristics) and steps down after sustained slow frames; a learner's choice is kept on this
 * browser only (never a learning record).
 */
import { deviceVfxTier } from '@/lib/vfx/quality';

export type QualityLevel = 'lite' | 'balanced' | 'high' | 'ultra';
export type QualityChoice = QualityLevel | 'auto';
export const QUALITY_LEVELS: QualityLevel[] = ['lite', 'balanced', 'high', 'ultra'];
export const QUALITY: Record<QualityLevel, { dpr: number; antialias: boolean; backgroundStars: number; dustPerGalaxy: number; cosmicDust: number; nebula: boolean; nebulaOctaves: number; bloom: boolean; bloomIntensity: number; labels: number }> = {
  lite: { dpr: 1, antialias: false, backgroundStars: 1200, dustPerGalaxy: 0, cosmicDust: 3000, nebula: false, nebulaOctaves: 0, bloom: false, bloomIntensity: 0, labels: 28 },
  balanced: { dpr: 1.25, antialias: true, backgroundStars: 2500, dustPerGalaxy: 500, cosmicDust: 12000, nebula: true, nebulaOctaves: 3, bloom: false, bloomIntensity: 0, labels: 40 },
  high: { dpr: 1.5, antialias: true, backgroundStars: 4000, dustPerGalaxy: 1000, cosmicDust: 20000, nebula: true, nebulaOctaves: 4, bloom: true, bloomIntensity: 0.7, labels: 50 },
  ultra: { dpr: 2, antialias: true, backgroundStars: 6000, dustPerGalaxy: 1800, cosmicDust: 30000, nebula: true, nebulaOctaves: 5, bloom: true, bloomIntensity: 0.9, labels: 60 },
};
export const QUALITY_LABEL: Record<QualityChoice, { vi: string; en: string }> = {
  auto: { vi: 'Tự động', en: 'Auto' }, lite: { vi: 'Nhẹ', en: 'Lite' }, balanced: { vi: 'Cân bằng', en: 'Balanced' },
  high: { vi: 'Cao', en: 'High' }, ultra: { vi: 'Rất cao', en: 'Ultra' },
};

const KEY = 'ec_cosmos_quality:v1';
export function readQualityChoice(): QualityChoice {
  try { const v = localStorage.getItem(KEY); return v && (v === 'auto' || (QUALITY_LEVELS as string[]).includes(v)) ? v as QualityChoice : 'auto'; } catch { return 'auto'; }
}
export function writeQualityChoice(v: QualityChoice) { try { localStorage.setItem(KEY, v); } catch { /* optional */ } }
export function autoQuality(): QualityLevel {
  const t = deviceVfxTier();
  return t === 'low' ? 'lite' : t === 'medium' ? 'balanced' : 'high';
}
export function stepDown(q: QualityLevel): QualityLevel { return QUALITY_LEVELS[Math.max(0, QUALITY_LEVELS.indexOf(q) - 1)]; }

/** WebGL2 (or WebGL1) available and not a software rasteriser we would rather not load the GPU scene on. */
export function webglSupport(): 'ok' | 'none' {
  if (typeof document === 'undefined') return 'none';
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return 'none';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return 'ok';
  } catch { return 'none'; }
}
