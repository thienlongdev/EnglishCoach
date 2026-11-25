/* Echo Odyssey — graphics tiers. ONE control decides how much of the planet is built and drawn on this device.
   Every tier keeps the same world, regions and learning layer; lower tiers draw less of it. The choice is a device
   convenience (localStorage, per browser), never learning data; reading or writing it can fail without harm. */

export type PlanetTier = 'light' | 'balanced' | 'high' | 'ultra';
export type GraphicsChoice = 'auto' | PlanetTier;
export const TIERS: PlanetTier[] = ['light', 'balanced', 'high', 'ultra'];
export const CHOICES: GraphicsChoice[] = ['auto', 'ultra', 'high', 'balanced', 'light'];

export const TIER_LABEL: Record<PlanetTier, { vi: string; en: string }> = {
  ultra: { vi: 'Cực cao', en: 'Ultra' }, high: { vi: 'Cao', en: 'High' },
  balanced: { vi: 'Cân bằng', en: 'Balanced' }, light: { vi: 'Nhẹ', en: 'Light' },
};
export const CHOICE_LABEL: Record<GraphicsChoice, { vi: string; en: string }> = { auto: { vi: 'Tự động', en: 'Auto' }, ...TIER_LABEL };

/** What a tier builds (worker) and draws (renderer). Changing between tiers that share a build is instant. */
export interface TierSpec {
  build: { level: 6 | 7 | 8; trees: number; grass: number };
  dpr: [number, number];
  /** Fraction of the build's trees / grass drawn. */
  trees: number; grass: number;
  shadows: number;            // shadow map size, 0 = none
  detail: number;             // shader detail 0..3 (micro relief octaves, wave layers, sky detail)
  clouds: number; smoke: number; embers: number;
  lodDistance: number;        // camera distance for the detailed models of props
}
export const TIER_SPEC: Record<PlanetTier, TierSpec> = {
  light:    { build: { level: 6, trees: 1.6, grass: 0 }, dpr: [0.7, 1], trees: 0.62, grass: 0, shadows: 0, detail: 0, clouds: 14, smoke: 24, embers: 0, lodDistance: 45 },
  balanced: { build: { level: 7, trees: 2.6, grass: 0 }, dpr: [0.85, 1.35], trees: 1, grass: 0, shadows: 1024, detail: 1, clouds: 28, smoke: 48, embers: 40, lodDistance: 80 },
  high:     { build: { level: 8, trees: 4.0, grass: 1 }, dpr: [1, 1.6], trees: 0.8, grass: 0.55, shadows: 2048, detail: 2, clouds: 42, smoke: 72, embers: 90, lodDistance: 115 },
  ultra:    { build: { level: 8, trees: 4.0, grass: 1 }, dpr: [1.2, 2], trees: 1, grass: 1, shadows: 4096, detail: 3, clouds: 60, smoke: 110, embers: 170, lodDistance: 170 },
};

const KEY = 'ec-odyssey-graphics:v2';
export function readGraphicsChoice(): GraphicsChoice {
  try { const v = localStorage.getItem(KEY); if (v && (CHOICES as string[]).includes(v)) return v as GraphicsChoice; } catch { /* optional preference */ }
  return 'auto';
}
export function saveGraphicsChoice(choice: GraphicsChoice) { try { localStorage.setItem(KEY, choice); } catch { /* optional preference */ } }

export interface DeviceProfile { start: PlanetTier; ceiling: PlanetTier; phone: boolean; gpu: string }
const rank = (t: PlanetTier) => TIERS.indexOf(t);
export const lowerTier = (t: PlanetTier): PlanetTier => TIERS[Math.max(0, rank(t) - 1)];
export const higherTier = (t: PlanetTier, ceiling: PlanetTier): PlanetTier => TIERS[Math.min(rank(ceiling), rank(t) + 1)];
export const tierAtMost = (t: PlanetTier, ceiling: PlanetTier): PlanetTier => rank(t) > rank(ceiling) ? ceiling : t;

/** The GPU's own name, read once from a throw-away context (released at once). */
export function gpuName(): string {
  if (typeof document === 'undefined') return '';
  try {
    const c = document.createElement('canvas'), gl = c.getContext('webgl2') as WebGL2RenderingContext | null;
    if (!gl) return 'none';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch { return ''; }
}

/** Where Auto starts and how high it may climb on this device. The frame-time governor then decides. */
export function deviceProfile(gpu = gpuName()): DeviceProfile {
  const nav = typeof navigator === 'undefined' ? null : navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  const narrow = typeof matchMedia !== 'undefined' && (matchMedia('(max-width: 760px)').matches || (matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820));
  const memory = nav?.deviceMemory ?? 8, cores = nav?.hardwareConcurrency ?? 4, saveData = !!nav?.connection?.saveData;
  const g = gpu.toLowerCase();
  let start: PlanetTier = 'balanced', ceiling: PlanetTier = 'high';
  if (!g || g === 'none' || /swiftshader|llvmpipe|software|basic render|microsoft basic/.test(g)) { start = 'light'; ceiling = 'light'; }
  else if (/rtx\s*(30|40|50)|rx\s*(6[6-9]|7[6-9]|9\d)\d{2}|radeon pro w|apple m\d (pro|max|ultra)|arc a7/.test(g)) { start = 'high'; ceiling = 'ultra'; }
  else if (/nvidia|geforce|rtx|gtx|radeon rx|apple m\d|arc/.test(g)) { start = 'high'; ceiling = 'high'; }
  else if (/intel.*(iris|xe)|radeon(\(tm\))? graphics|780m|680m/.test(g)) { start = 'balanced'; ceiling = 'high'; }
  else if (/intel.*(uhd|hd)|mali|adreno|powervr|apple gpu/.test(g)) { start = 'light'; ceiling = 'balanced'; }
  if (memory <= 4 || cores <= 4 || saveData) { ceiling = tierAtMost(ceiling, 'balanced'); start = tierAtMost(start, 'balanced'); }
  if (narrow) { ceiling = tierAtMost(ceiling, 'balanced'); start = 'light'; }
  return { start: tierAtMost(start, ceiling), ceiling, phone: narrow, gpu };
}
