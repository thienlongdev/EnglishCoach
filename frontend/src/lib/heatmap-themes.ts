export type HeatmapThemeKey = 'green' | 'blue' | 'purple' | 'orange' | 'pink' | 'cyan';

export interface HeatmapThemeConfig {
  key: HeatmapThemeKey;
  labelVi: string;
  labelEn: string;
  swatchBg: string;
  activeRing: string;
  // Intensity levels 0..4 classes
  cellClasses: [string, string, string, string, string];
}

export const HEATMAP_THEMES: Record<HeatmapThemeKey, HeatmapThemeConfig> = {
  purple: {
    key: 'purple',
    labelVi: 'Tím',
    labelEn: 'Purple',
    swatchBg: 'bg-indigo-500',
    activeRing: 'ring-indigo-500',
    cellClasses: [
      'bg-slate-100 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/50',
      'bg-indigo-200 dark:bg-indigo-950/80 border border-indigo-300/60 dark:border-indigo-800/60',
      'bg-indigo-400 dark:bg-indigo-700 border border-indigo-400/80 dark:border-indigo-600',
      'bg-indigo-500 dark:bg-indigo-600 border border-indigo-600/80 dark:border-indigo-500',
      'bg-indigo-600 dark:bg-indigo-400 border border-indigo-700 dark:border-indigo-300',
    ],
  },
  green: {
    key: 'green',
    labelVi: 'Xanh lá',
    labelEn: 'Green',
    swatchBg: 'bg-emerald-500',
    activeRing: 'ring-emerald-500',
    cellClasses: [
      'bg-slate-100 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/50',
      'bg-emerald-200 dark:bg-emerald-950/80 border border-emerald-300/60 dark:border-emerald-800/60',
      'bg-emerald-400 dark:bg-emerald-700 border border-emerald-400/80 dark:border-emerald-600',
      'bg-emerald-500 dark:bg-emerald-600 border border-emerald-600/80 dark:border-emerald-500',
      'bg-emerald-600 dark:bg-emerald-400 border border-emerald-700 dark:border-emerald-300',
    ],
  },
  blue: {
    key: 'blue',
    labelVi: 'Xanh dương',
    labelEn: 'Blue',
    swatchBg: 'bg-blue-500',
    activeRing: 'ring-blue-500',
    cellClasses: [
      'bg-slate-100 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/50',
      'bg-blue-200 dark:bg-blue-950/80 border border-blue-300/60 dark:border-blue-800/60',
      'bg-blue-400 dark:bg-blue-700 border border-blue-400/80 dark:border-blue-600',
      'bg-blue-500 dark:bg-blue-600 border border-blue-600/80 dark:border-blue-500',
      'bg-blue-600 dark:bg-blue-400 border border-blue-700 dark:border-blue-300',
    ],
  },
  orange: {
    key: 'orange',
    labelVi: 'Cam',
    labelEn: 'Orange',
    swatchBg: 'bg-orange-500',
    activeRing: 'ring-orange-500',
    cellClasses: [
      'bg-slate-100 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/50',
      'bg-orange-200 dark:bg-orange-950/80 border border-orange-300/60 dark:border-orange-800/60',
      'bg-orange-400 dark:bg-orange-700 border border-orange-400/80 dark:border-orange-600',
      'bg-orange-500 dark:bg-orange-600 border border-orange-600/80 dark:border-orange-500',
      'bg-orange-600 dark:bg-orange-400 border border-orange-700 dark:border-orange-300',
    ],
  },
  pink: {
    key: 'pink',
    labelVi: 'Hồng',
    labelEn: 'Pink',
    swatchBg: 'bg-pink-500',
    activeRing: 'ring-pink-500',
    cellClasses: [
      'bg-slate-100 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/50',
      'bg-pink-200 dark:bg-pink-950/80 border border-pink-300/60 dark:border-pink-800/60',
      'bg-pink-400 dark:bg-pink-700 border border-pink-400/80 dark:border-pink-600',
      'bg-pink-500 dark:bg-pink-600 border border-pink-600/80 dark:border-pink-500',
      'bg-pink-600 dark:bg-pink-400 border border-pink-700 dark:border-pink-300',
    ],
  },
  cyan: {
    key: 'cyan',
    labelVi: 'Lam',
    labelEn: 'Cyan',
    swatchBg: 'bg-cyan-500',
    activeRing: 'ring-cyan-500',
    cellClasses: [
      'bg-slate-100 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/50',
      'bg-cyan-200 dark:bg-cyan-950/80 border border-cyan-300/60 dark:border-cyan-800/60',
      'bg-cyan-400 dark:bg-cyan-700 border border-cyan-400/80 dark:border-cyan-600',
      'bg-cyan-500 dark:bg-cyan-600 border border-cyan-600/80 dark:border-cyan-500',
      'bg-cyan-600 dark:bg-cyan-400 border border-cyan-700 dark:border-cyan-300',
    ],
  },
};

export const DEFAULT_HEATMAP_THEME: HeatmapThemeKey = 'purple';

export function getHeatmapTheme(themeKey?: string | null): HeatmapThemeConfig {
  if (!themeKey) return HEATMAP_THEMES[DEFAULT_HEATMAP_THEME];
  const normalized = themeKey.trim().toLowerCase() as HeatmapThemeKey;
  return HEATMAP_THEMES[normalized] || HEATMAP_THEMES[DEFAULT_HEATMAP_THEME];
}
