import { AvatarFrameDto, AvatarFrameTier, AvatarFrameLineage } from '@/types/avatarFrame';

export type VisualTheme =
  | 'FIRE'
  | 'ICE'
  | 'SNOW'
  | 'WIND'
  | 'WATER'
  | 'EARTH'
  | 'NATURE'
  | 'SPRING'
  | 'SUMMER'
  | 'AUTUMN'
  | 'WINTER'
  | 'LIGHTNING'
  | 'CELESTIAL'
  | 'ARCANE'
  | 'PHOENIX'
  | 'DRAGON'
  | 'IMPERIAL';

export type MotionProfile =
  | 'breathing'
  | 'pulse'
  | 'orbit'
  | 'gleam'
  | 'shimmer'
  | 'sweep'
  | 'flame'
  | 'none';

export type AuraProfile =
  | 'dragon-radiance'
  | 'phoenix-fire'
  | 'celestial-halo'
  | 'arcane-rings'
  | 'frost-mist'
  | 'nature-glow'
  | 'solar-corona'
  | 'autumn-gust'
  | 'imperial-sovereign'
  | 'subtle-glow'
  | 'none';

export type FxProfile =
  | 'dragon-pearl-motes'
  | 'phoenix-flame-feathers'
  | 'celestial-starlight'
  | 'nature-petals'
  | 'frost-flakes'
  | 'solar-heat-motes'
  | 'autumn-leaf-motes'
  | 'imperial-gold-sparks'
  | 'arcane-runes'
  | 'ember-particles'
  | 'none';

export interface FramePresentationConfig {
  visualTheme: VisualTheme;
  motionProfile: MotionProfile;
  auraProfile: AuraProfile;
  fxProfile: FxProfile;
  showcaseAnimation: string;
  denseAnimation: string;
  auraClass: string;
  primaryColor: string;
  secondaryColor: string;
}

/**
 * Generic Visual Theme Definitions.
 * Each presentation theme defines coordinated visual behaviors across:
 * - Core SVG motion
 * - AuraLayer expansion & pulse
 * - FXLayer particle motes (for showcase sizes lg/xl)
 * - Harmonious color palettes
 */
export const VISUAL_THEME_CONFIGS: Record<VisualTheme, FramePresentationConfig> = {
  DRAGON: {
    visualTheme: 'DRAGON',
    motionProfile: 'breathing',
    auraProfile: 'dragon-radiance',
    fxProfile: 'dragon-pearl-motes',
    showcaseAnimation: 'frame-anim-dragon',
    denseAnimation: 'frame-anim-dragon',
    auraClass: 'frame-anim-dragon-aura',
    primaryColor: '#eab308',
    secondaryColor: '#dc2626',
  },
  PHOENIX: {
    visualTheme: 'PHOENIX',
    motionProfile: 'breathing',
    auraProfile: 'phoenix-fire',
    fxProfile: 'phoenix-flame-feathers',
    showcaseAnimation: 'frame-anim-phoenix',
    denseAnimation: 'frame-anim-phoenix',
    auraClass: 'frame-anim-phoenix-aura',
    primaryColor: '#f97316',
    secondaryColor: '#ef4444',
  },
  SPRING: {
    visualTheme: 'SPRING',
    motionProfile: 'pulse',
    auraProfile: 'nature-glow',
    fxProfile: 'nature-petals',
    showcaseAnimation: 'frame-anim-spring-breathe',
    denseAnimation: '',
    auraClass: 'frame-anim-spring-aura',
    primaryColor: '#10b981',
    secondaryColor: '#f472b6',
  },
  SUMMER: {
    visualTheme: 'SUMMER',
    motionProfile: 'pulse',
    auraProfile: 'solar-corona',
    fxProfile: 'solar-heat-motes',
    showcaseAnimation: 'frame-anim-summer-radiance',
    denseAnimation: '',
    auraClass: 'frame-anim-summer-aura',
    primaryColor: '#f59e0b',
    secondaryColor: '#ea580c',
  },
  AUTUMN: {
    visualTheme: 'AUTUMN',
    motionProfile: 'sweep',
    auraProfile: 'autumn-gust',
    fxProfile: 'autumn-leaf-motes',
    showcaseAnimation: 'frame-anim-autumn-vortex',
    denseAnimation: '',
    auraClass: 'frame-anim-autumn-aura',
    primaryColor: '#d97706',
    secondaryColor: '#dc2626',
  },
  WINTER: {
    visualTheme: 'WINTER',
    motionProfile: 'gleam',
    auraProfile: 'frost-mist',
    fxProfile: 'frost-flakes',
    showcaseAnimation: 'frame-anim-winter-frost',
    denseAnimation: '',
    auraClass: 'frame-anim-winter-aura',
    primaryColor: '#38bdf8',
    secondaryColor: '#e0f2fe',
  },
  IMPERIAL: {
    visualTheme: 'IMPERIAL',
    motionProfile: 'breathing',
    auraProfile: 'imperial-sovereign',
    fxProfile: 'imperial-gold-sparks',
    showcaseAnimation: 'frame-anim-imperial-sovereign',
    denseAnimation: 'frame-anim-knight',
    auraClass: 'frame-anim-imperial-aura',
    primaryColor: '#f59e0b',
    secondaryColor: '#991b1b',
  },
  CELESTIAL: {
    visualTheme: 'CELESTIAL',
    motionProfile: 'orbit',
    auraProfile: 'celestial-halo',
    fxProfile: 'celestial-starlight',
    showcaseAnimation: 'frame-anim-celestial-pulse',
    denseAnimation: '',
    auraClass: 'frame-anim-celestial-gleam',
    primaryColor: '#ffffff',
    secondaryColor: '#38bdf8',
  },
  ARCANE: {
    visualTheme: 'ARCANE',
    motionProfile: 'pulse',
    auraProfile: 'arcane-rings',
    fxProfile: 'arcane-runes',
    showcaseAnimation: 'frame-anim-arcane',
    denseAnimation: '',
    auraClass: 'frame-anim-arcane',
    primaryColor: '#c084fc',
    secondaryColor: '#7e22ce',
  },
  FIRE: {
    visualTheme: 'FIRE',
    motionProfile: 'flame',
    auraProfile: 'subtle-glow',
    fxProfile: 'ember-particles',
    showcaseAnimation: 'frame-anim-flame',
    denseAnimation: '',
    auraClass: 'frame-anim-flame',
    primaryColor: '#ea580c',
    secondaryColor: '#f97316',
  },
  ICE: {
    visualTheme: 'ICE',
    motionProfile: 'gleam',
    auraProfile: 'frost-mist',
    fxProfile: 'frost-flakes',
    showcaseAnimation: 'frame-anim-winter-frost',
    denseAnimation: '',
    auraClass: 'frame-anim-winter-aura',
    primaryColor: '#0284c7',
    secondaryColor: '#e0f2fe',
  },
  SNOW: {
    visualTheme: 'SNOW',
    motionProfile: 'shimmer',
    auraProfile: 'frost-mist',
    fxProfile: 'frost-flakes',
    showcaseAnimation: 'frame-anim-winter-frost',
    denseAnimation: '',
    auraClass: 'frame-anim-winter-aura',
    primaryColor: '#e0f2fe',
    secondaryColor: '#bae6fd',
  },
  WIND: {
    visualTheme: 'WIND',
    motionProfile: 'sweep',
    auraProfile: 'autumn-gust',
    fxProfile: 'autumn-leaf-motes',
    showcaseAnimation: 'frame-anim-autumn-vortex',
    denseAnimation: '',
    auraClass: 'frame-anim-autumn-aura',
    primaryColor: '#94a3b8',
    secondaryColor: '#64748b',
  },
  WATER: {
    visualTheme: 'WATER',
    motionProfile: 'pulse',
    auraProfile: 'celestial-halo',
    fxProfile: 'celestial-starlight',
    showcaseAnimation: 'frame-anim-storm-pulse',
    denseAnimation: '',
    auraClass: 'frame-anim-celestial-gleam',
    primaryColor: '#06b6d4',
    secondaryColor: '#0284c7',
  },
  EARTH: {
    visualTheme: 'EARTH',
    motionProfile: 'shimmer',
    auraProfile: 'subtle-glow',
    fxProfile: 'none',
    showcaseAnimation: 'frame-anim-ancient-pulse',
    denseAnimation: '',
    auraClass: 'frame-anim-ancient-pulse',
    primaryColor: '#d97706',
    secondaryColor: '#78350f',
  },
  NATURE: {
    visualTheme: 'NATURE',
    motionProfile: 'pulse',
    auraProfile: 'nature-glow',
    fxProfile: 'nature-petals',
    showcaseAnimation: 'frame-anim-nature-pulse',
    denseAnimation: '',
    auraClass: 'frame-anim-spring-aura',
    primaryColor: '#10b981',
    secondaryColor: '#059669',
  },
  LIGHTNING: {
    visualTheme: 'LIGHTNING',
    motionProfile: 'pulse',
    auraProfile: 'arcane-rings',
    fxProfile: 'celestial-starlight',
    showcaseAnimation: 'frame-anim-storm-pulse',
    denseAnimation: '',
    auraClass: 'frame-anim-storm-pulse',
    primaryColor: '#38bdf8',
    secondaryColor: '#eab308',
  },
};

/**
 * Known Catalogue Mapping.
 * Assigns presentation visual themes to known frame slugs.
 */
const FRAME_THEME_REGISTRY: Record<string, VisualTheme> = {
  // Flagships (SSS)
  sss_dragon_emperor: 'DRAGON',
  sss_phoenix_rebirth: 'PHOENIX',

  // Four Seasons
  season_spring: 'SPRING',
  season_summer: 'SUMMER',
  season_autumn: 'AUTUMN',
  season_winter: 'WINTER',

  // Premium Membership
  premium_ruby_crest: 'IMPERIAL',
  premium_sapphire_crown: 'CELESTIAL',
  premium_sovereign_aegis: 'IMPERIAL',

  // Special Events
  event_tet_festival: 'SPRING',

  // Achievement Lineage
  streak_flame_stage_1: 'FIRE',
  streak_flame_stage_2: 'FIRE',
  streak_flame_stage_3: 'FIRE',
  vocab_mastery_stage_1: 'NATURE',
  vocab_mastery_stage_2: 'ARCANE',
  vocab_mastery_stage_3: 'ARCANE',

  // Standard Lineage
  cefr_b2_scholar: 'CELESTIAL',
  cefr_c1_master: 'CELESTIAL',
  cefr_c2_sage: 'CELESTIAL',

  // Ranked Lineage
  ranked_gold: 'IMPERIAL',
  ranked_master: 'ARCANE',
  ranked_challenger: 'LIGHTNING',

  // Legacy Lineage
  legacy_founder_2026: 'EARTH',
};

/**
 * Resolves full presentation configuration for any frame without slug conditionals in renderers.
 * Priority:
 * 1. Explicit frame.visualTheme (if provided by backend DTO or manifest)
 * 2. Declarative catalogue mapping (FRAME_THEME_REGISTRY)
 * 3. Fallback derived by tier + lineage
 */
export function getFramePresentationConfig(
  frame: AvatarFrameDto | null | undefined
): FramePresentationConfig {
  if (!frame) {
    return VISUAL_THEME_CONFIGS.FIRE;
  }

  // 1. Check explicit visualTheme on DTO
  if (frame.visualTheme && frame.visualTheme.toUpperCase() in VISUAL_THEME_CONFIGS) {
    return VISUAL_THEME_CONFIGS[frame.visualTheme.toUpperCase() as VisualTheme];
  }

  // 2. Check declarative registry
  if (frame.slug && frame.slug in FRAME_THEME_REGISTRY) {
    const theme = FRAME_THEME_REGISTRY[frame.slug];
    return VISUAL_THEME_CONFIGS[theme];
  }

  // 3. Fallback derived by lineage and tier
  const tier = frame.tier;
  const lineage = frame.lineage;

  if (tier === 'SSS') {
    return VISUAL_THEME_CONFIGS.DRAGON;
  }
  if (tier === 'SS') {
    return lineage === 'PREMIUM' ? VISUAL_THEME_CONFIGS.IMPERIAL : VISUAL_THEME_CONFIGS.CELESTIAL;
  }
  if (lineage === 'SEASONAL') {
    return VISUAL_THEME_CONFIGS.SPRING;
  }
  if (lineage === 'PREMIUM') {
    return VISUAL_THEME_CONFIGS.IMPERIAL;
  }
  if (lineage === 'RANKED') {
    return VISUAL_THEME_CONFIGS.LIGHTNING;
  }
  if (lineage === 'STANDARD') {
    return VISUAL_THEME_CONFIGS.CELESTIAL;
  }
  if (lineage === 'LEGACY') {
    return VISUAL_THEME_CONFIGS.EARTH;
  }

  return VISUAL_THEME_CONFIGS.FIRE;
}
