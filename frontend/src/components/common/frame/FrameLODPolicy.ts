import { AvatarFrameContext, AvatarFrameDto, AvatarFrameRenderType, AvatarFrameTier, AvatarSize } from '@/types/avatarFrame';
import { getAssetFootprintPercent } from './frameGeometry';

export interface FrameLODDecision {
  effectiveRenderType: AvatarFrameRenderType;
  isReducedMotion: boolean;
  isSmallSize: boolean;
  isStaticOnlyContext: boolean;
  assetUrl: string;
  footprintPercent: number;
}

/**
 * Calculates the visual footprint percentage based on frame tier, context, and size.
 * Tiers:
 * - D / C: restrained (~110-115%)
 * - B: balanced (~115-125%)
 * - A: refined (~125-135%)
 * - S: imposing aura (~140-150%)
 * - SS: celestial transcendence (~155-165%)
 * - SSS: imperial dragon dominance (~175-190% in showcase/profile)
 * Dense contexts (leaderboard, navbar, xs/sm) use restrained footprints to prevent overflow clipping.
 */
export function getTierFootprintPercent(
  tier: AvatarFrameTier,
  context: AvatarFrameContext = 'profile',
  size: AvatarSize = 'md'
): number {
  const isDense = context === 'leaderboard' || context === 'navbar' || size === 'xs' || size === 'sm';
  if (isDense) {
    switch (tier) {
      case 'SSS': return 138;
      case 'SS': return 130;
      case 'S': return 124;
      case 'A': return 118;
      case 'B': return 112;
      case 'C':
      case 'D':
      default:
        return 108;
    }
  }

  // Showcase / Normal contexts (profile, wardrobe, card, pvp)
  switch (tier) {
    case 'SSS': return 185;
    case 'SS': return 160;
    case 'S': return 145;
    case 'A': return 130;
    case 'B': return 120;
    case 'C': return 114;
    case 'D':
    default:
      return 112;
  }
}

/**
 * Centralized Level of Detail (LOD) policy for Avatar Frames.
 * Rules:
 * - If user prefers reduced motion -> Force STATIC_SVG (Rule 8)
 * - If size is small (xs, sm <= 40px) -> Force STATIC_SVG for performance
 * - If context is 'leaderboard' -> Force STATIC_SVG to avoid DOM/layout thrash in dense lists
 * - Otherwise -> use frame.renderType (STATIC_SVG or CSS_ANIMATED)
 */
export function resolveFrameLOD(
  frame: AvatarFrameDto | null | undefined,
  context: AvatarFrameContext = 'profile',
  size: AvatarSize = 'md',
  prefersReducedMotion = false
): FrameLODDecision {
  const isReducedMotion = prefersReducedMotion;
  const isSmallSize = size === 'xs' || size === 'sm';
  const isStaticOnlyContext = context === 'leaderboard';

  let effectiveRenderType: AvatarFrameRenderType = 'STATIC_SVG';

  if (!frame) {
    return {
      effectiveRenderType,
      isReducedMotion,
      isSmallSize,
      isStaticOnlyContext,
      assetUrl: '',
      footprintPercent: 100,
    };
  }

  if (isReducedMotion || isSmallSize || isStaticOnlyContext) {
    effectiveRenderType = 'STATIC_SVG';
  } else {
    effectiveRenderType = frame.renderType;
  }

  // Under reduced motion or static requirement, use posterAsset
  const assetUrl = effectiveRenderType === 'STATIC_SVG'
    ? (frame.posterAsset || frame.previewAsset)
    : (frame.previewAsset || frame.posterAsset);

  const footprintPercent = getAssetFootprintPercent(assetUrl, getTierFootprintPercent(frame.tier, context, size));

  return {
    effectiveRenderType,
    isReducedMotion,
    isSmallSize,
    isStaticOnlyContext,
    assetUrl,
    footprintPercent,
  };
}

export interface TierSafeAreaConfig {
  stageMinHeightPx: number;
  avatarPaddingTopPx: number;
  avatarPaddingBottomPx: number;
  titleSpacingPx: number;
}

/**
 * Calculates tier-proportional visual stage clearance and safe-area boundaries.
 * High-tier frames (SSS, SS, S) have expansive ornamental footprints (up to 185%)
 * with dragon claws, floating motes, and radiant celestial auras.
 * This policy guarantees that visual stage heights and bottom spacing expand to fully
 * contain all artwork overflow, completely preventing text and badge collisions without
 * shrinking the artwork.
 */
export function getTierSafeAreaConfig(
  tier: AvatarFrameTier = 'C',
  size: AvatarSize = 'md'
): TierSafeAreaConfig {
  if (size === 'xl') {
    switch (tier) {
      case 'SSS':
        return { stageMinHeightPx: 296, avatarPaddingTopPx: 58, avatarPaddingBottomPx: 68, titleSpacingPx: 14 };
      case 'SS':
        return { stageMinHeightPx: 260, avatarPaddingTopPx: 42, avatarPaddingBottomPx: 48, titleSpacingPx: 12 };
      case 'S':
        return { stageMinHeightPx: 240, avatarPaddingTopPx: 32, avatarPaddingBottomPx: 38, titleSpacingPx: 10 };
      case 'A':
        return { stageMinHeightPx: 220, avatarPaddingTopPx: 24, avatarPaddingBottomPx: 28, titleSpacingPx: 8 };
      case 'B':
        return { stageMinHeightPx: 210, avatarPaddingTopPx: 18, avatarPaddingBottomPx: 20, titleSpacingPx: 8 };
      case 'C':
      case 'D':
      default:
        return { stageMinHeightPx: 200, avatarPaddingTopPx: 14, avatarPaddingBottomPx: 16, titleSpacingPx: 8 };
    }
  }

  // Default 'md' (64px) sizing
  switch (tier) {
    case 'SSS':
      return { stageMinHeightPx: 156, avatarPaddingTopPx: 30, avatarPaddingBottomPx: 36, titleSpacingPx: 10 };
    case 'SS':
      return { stageMinHeightPx: 140, avatarPaddingTopPx: 22, avatarPaddingBottomPx: 26, titleSpacingPx: 8 };
    case 'S':
      return { stageMinHeightPx: 132, avatarPaddingTopPx: 18, avatarPaddingBottomPx: 20, titleSpacingPx: 8 };
    case 'A':
      return { stageMinHeightPx: 124, avatarPaddingTopPx: 14, avatarPaddingBottomPx: 16, titleSpacingPx: 6 };
    case 'B':
      return { stageMinHeightPx: 118, avatarPaddingTopPx: 12, avatarPaddingBottomPx: 12, titleSpacingPx: 6 };
    case 'C':
    case 'D':
    default:
      return { stageMinHeightPx: 116, avatarPaddingTopPx: 10, avatarPaddingBottomPx: 10, titleSpacingPx: 6 };
  }
}

