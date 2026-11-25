export type AvatarFrameTier = 'D' | 'C' | 'B' | 'A' | 'S' | 'SS' | 'SSS';

export type AvatarFrameLineage = 'ACHIEVEMENT' | 'RANKED' | 'STANDARD' | 'LEGACY' | 'SEASONAL' | 'EVENT' | 'PREMIUM' | 'GARDEN';

export type AvatarFrameRenderType = 'STATIC_SVG' | 'CSS_ANIMATED';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export type AvatarFrameContext = 'profile' | 'navbar' | 'leaderboard' | 'chat' | 'pvp' | 'card';

export type FrameEligibilityStatus = 'LOCKED' | 'PROGRESSING' | 'ELIGIBLE' | 'OWNED' | 'EQUIPPED' | 'EXPIRED';

export interface AvatarFrameSeries {
  id: number;
  slug: string;
  name: string;
}

export interface AvatarFrameOwnership {
  owned: boolean;
  equipped: boolean;
  expiresAt: string | null;
  source?: string | null;
  unlockedAt?: string | null;
  ownerCount?: number | null;
}

export interface AvatarFrameCondition {
  metric: string;
  current: number;
  target: number;
  percent: number;
  displayCurrent?: string;
  displayTarget?: string;
}

export interface AvatarFrameProgress {
  current: number;
  target: number;
  percent: number;
  metric: string;
  status: FrameEligibilityStatus;
  displayCurrent?: string;
  displayTarget?: string;
  conditions?: AvatarFrameCondition[] | null;
}

export interface AvatarFrameDto {
  id: number;
  slug: string;
  series: AvatarFrameSeries;
  name: string;
  tier: AvatarFrameTier;
  lineage: AvatarFrameLineage;
  renderType: AvatarFrameRenderType;
  posterAsset: string;
  previewAsset: string;
  ownership: AvatarFrameOwnership;
  progress: AvatarFrameProgress | null;
  visualTheme?: string;
}

export const TIER_DISPLAY_NAMES: Record<AvatarFrameTier, string> = {
  D: 'Người Mới',
  C: 'Học Viên',
  B: 'Học Giả',
  A: 'Hiệp Sĩ Ngôn Ngữ',
  S: 'Đại Pháp Sư',
  SS: 'Thiên Sứ Tri Thức',
  SSS: 'Long Đế Anh Ngữ',
};

export const LINEAGE_DISPLAY_NAMES: Record<AvatarFrameLineage, string> = {
  ACHIEVEMENT: 'Thành tựu',
  RANKED: 'Xếp hạng',
  STANDARD: 'Chuẩn hóa',
  LEGACY: 'Di sản',
  SEASONAL: 'Bốn mùa',
  EVENT: 'Sự kiện',
  PREMIUM: 'Hội viên',
  GARDEN: 'Echo Garden',
};

export const TIER_COLORS: Record<AvatarFrameTier, { text: string; bg: string; border: string; glow: string }> = {
  D: {
    text: 'text-amber-700 dark:text-amber-300',
    bg: 'bg-amber-100 dark:bg-amber-950/60',
    border: 'border-amber-300 dark:border-amber-700',
    glow: 'rgba(217, 119, 6, 0.2)',
  },
  C: {
    text: 'text-emerald-700 dark:text-emerald-300',
    bg: 'bg-emerald-100 dark:bg-emerald-950/60',
    border: 'border-emerald-300 dark:border-emerald-700',
    glow: 'rgba(16, 185, 129, 0.25)',
  },
  B: {
    text: 'text-blue-700 dark:text-blue-300',
    bg: 'bg-blue-100 dark:bg-blue-950/60',
    border: 'border-blue-300 dark:border-blue-700',
    glow: 'rgba(59, 130, 246, 0.3)',
  },
  A: {
    text: 'text-indigo-700 dark:text-indigo-300',
    bg: 'bg-indigo-100 dark:bg-indigo-950/60',
    border: 'border-indigo-300 dark:border-indigo-700',
    glow: 'rgba(99, 102, 241, 0.35)',
  },
  S: {
    text: 'text-purple-700 dark:text-purple-300',
    bg: 'bg-purple-100 dark:bg-purple-950/60',
    border: 'border-purple-300 dark:border-purple-700',
    glow: 'rgba(168, 85, 247, 0.4)',
  },
  SS: {
    text: 'text-cyan-700 dark:text-cyan-300',
    bg: 'bg-cyan-100 dark:bg-cyan-950/60',
    border: 'border-cyan-300 dark:border-cyan-700',
    glow: 'rgba(6, 182, 212, 0.45)',
  },
  SSS: {
    text: 'text-rose-700 dark:text-rose-300',
    bg: 'bg-rose-100 dark:bg-rose-950/60',
    border: 'border-rose-300 dark:border-rose-700',
    glow: 'rgba(225, 29, 72, 0.55)',
  },
};
