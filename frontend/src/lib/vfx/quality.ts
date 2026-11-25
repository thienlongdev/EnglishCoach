/** Device-only visual preference. No learning state or renderer is owned here. */
export type VfxPreset = 'auto' | 'ultra' | 'high' | 'medium' | 'low';
export type VfxTier = Exclude<VfxPreset, 'auto'>;
export type GraphicsQualityTier = 'low' | 'balanced' | 'high' | 'ultra';
export const VFX_PRESETS: VfxPreset[] = ['auto', 'ultra', 'high', 'medium', 'low'];

/** Maps the 4-tier Study Space / Echo Life graphics preset to the corresponding VFX budget tier. */
export function graphicsTierToVfxTier(tier: GraphicsQualityTier): VfxTier {
  if (tier === 'ultra') return 'ultra';
  if (tier === 'high') return 'high';
  if (tier === 'balanced') return 'medium';
  return 'low';
}
export const VFX_BUDGET = {
  ultra: { particles: 1536, fluid: 192, refraction: .75, dpr: 2 },
  high: { particles: 768, fluid: 128, refraction: .5, dpr: 1.5 },
  medium: { particles: 384, fluid: 64, refraction: 0, dpr: 1.25 },
  low: { particles: 128, fluid: 0, refraction: 0, dpr: 1 },
} as const;
const key = 'ec-vfx-quality:v1';
let preference: VfxPreset | null = null;
const listeners = new Set<() => void>();
export function vfxPreference(): VfxPreset {
  if (preference) return preference;
  try { const p = localStorage.getItem(key); preference = VFX_PRESETS.includes(p as VfxPreset) ? p as VfxPreset : 'auto'; } catch { preference = 'auto'; }
  return preference;
}
export function setVfxPreference(value: VfxPreset) {
  if (!VFX_PRESETS.includes(value)) return;
  preference = value; try { localStorage.setItem(key, value); } catch { /* Optional preference. */ }
  listeners.forEach(fn => fn());
}
const onStorage = (event: StorageEvent) => { if(event.key !== key && event.key !== null)return;preference=null;listeners.forEach(fn=>fn()); };
export const subscribeVfx = (fn: () => void) => {
  if(!listeners.size)window.addEventListener('storage',onStorage);
  listeners.add(fn);
  return () => { listeners.delete(fn);if(!listeners.size)window.removeEventListener('storage',onStorage); };
};
export const vfxReduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export function deviceVfxTier(): VfxTier {
  if (typeof navigator === 'undefined') return 'low';
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  if (matchMedia('(pointer: coarse)').matches || innerWidth < 700 || memory <= 2 || navigator.hardwareConcurrency <= 2 || saveData) return 'low';
  return navigator.hardwareConcurrency >= 8 && memory >= 8 ? 'high' : 'medium';
}
/** Timed degradation, independent of refresh rate; explicit Ultra is still bounded by slow frames. */
export class VfxQuality {
  private preference: VfxPreset | null = null;
  tier: VfxTier = 'low';
  private slow = 0;
  update(dt: number, capable = true): VfxTier {
    const p = vfxPreference();
    if (p !== this.preference) { this.preference = p; this.tier = p === 'auto' ? deviceVfxTier() : p; this.slow = 0; }
    if (!capable || vfxReduced()) return 'low';
    if (dt > 0 && dt < .2) this.slow = Math.max(0, this.slow + (dt > .034 ? dt : -dt * .4));
    if (this.slow > 3) { const tiers: VfxTier[] = ['ultra', 'high', 'medium', 'low']; this.tier = tiers[Math.min(3, tiers.indexOf(this.tier) + 1)]; this.slow = 0; }
    return this.tier;
  }
}
