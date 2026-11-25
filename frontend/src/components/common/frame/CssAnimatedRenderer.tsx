'use client';

import React, { useState, useEffect } from 'react';
import {
  AvatarFrameContext,
  AvatarFrameDto,
  AvatarFrameLineage,
  AvatarFrameTier,
  AvatarSize,
} from '@/types/avatarFrame';
import { getTierFootprintPercent } from './FrameLODPolicy';
import { getFramePresentationConfig } from './visualThemes';
import { getAssetFootprintPercent } from './frameGeometry';

export interface CssAnimatedRendererProps {
  frame: AvatarFrameDto;
  size: AvatarSize;
  context?: AvatarFrameContext;
  footprintPercent?: number;
  onError?: () => void;
  className?: string;
}

export function CssAnimatedRenderer({
  frame,
  size,
  context = 'profile',
  footprintPercent: propFootprint,
  onError,
  className = '',
}: CssAnimatedRendererProps) {
  const [loadFailed, setLoadFailed] = useState(false);
  const assetPath = frame.previewAsset || frame.posterAsset;
  useEffect(() => { setLoadFailed(false); }, [assetPath]);

  const handleError = () => {
    setLoadFailed(true);
    onError?.();
  };

  if (loadFailed) {
    return null;
  }

  const footprintPercent = propFootprint ?? getAssetFootprintPercent(assetPath, getTierFootprintPercent(frame.tier, context, size));
  const offset = -((footprintPercent - 100) / 2);

  const presentation = getFramePresentationConfig(frame);
  const isDense = context === 'leaderboard' || context === 'navbar' || size === 'xs' || size === 'sm';
  const animClass = (frame.tier === 'D' || frame.tier === 'C' || frame.tier === 'B')
    ? ''
    : isDense
    ? presentation.denseAnimation
    : presentation.showcaseAnimation;

  return (
    <div
      data-testid="css-animated-renderer"
      className={`absolute pointer-events-none select-none flex items-center justify-center ${className}`}
      style={{
        width: `${footprintPercent}%`,
        height: `${footprintPercent}%`,
        top: `${offset}%`,
        left: `${offset}%`,
      }}
    >
      {/* SSS Sovereign Aura Glow Enhancement */}
      {frame.tier === 'SSS' && (
        <div className={`absolute inset-0 ${presentation.auraClass || 'frame-anim-dragon-aura'} pointer-events-none opacity-60 motion-reduce:hidden flex items-center justify-center`}>
          <img
            src={assetPath}
            alt=""
            aria-hidden="true"
            className="w-full h-full object-contain filter blur-xs"
            loading="eager"
          />
        </div>
      )}

      {/* SS Celestial Radiance Halo Enhancement */}
      {frame.tier === 'SS' && (
        <div className={`absolute inset-0 ${presentation.auraClass || 'frame-anim-celestial-gleam'} pointer-events-none opacity-45 motion-reduce:hidden flex items-center justify-center`}>
          <img
            src={assetPath}
            alt=""
            aria-hidden="true"
            className="w-full h-full object-contain filter blur-xs"
            loading="eager"
          />
        </div>
      )}

      {/* Main Vector Frame with Sophisticated Living Motion */}
      <img
        src={assetPath}
        alt=""
        aria-hidden="true"
        onError={handleError}
        className={`w-full h-full object-contain ${animClass} motion-reduce:animate-none`}
        loading="eager"
      />
    </div>
  );
}

