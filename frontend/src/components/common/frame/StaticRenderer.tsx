'use client';

import React, { useState, useEffect } from 'react';
import { AvatarFrameContext, AvatarFrameDto, AvatarSize } from '@/types/avatarFrame';
import { getTierFootprintPercent } from './FrameLODPolicy';
import { getAssetFootprintPercent } from './frameGeometry';

export interface StaticRendererProps {
  frame: AvatarFrameDto;
  size: AvatarSize;
  context?: AvatarFrameContext;
  footprintPercent?: number;
  onError?: () => void;
  className?: string;
}

export function StaticRenderer({
  frame,
  size,
  context = 'profile',
  footprintPercent: propFootprint,
  onError,
  className = '',
}: StaticRendererProps) {
  const [loadFailed, setLoadFailed] = useState(false);
  const assetPath = frame.posterAsset || frame.previewAsset;
  useEffect(() => { setLoadFailed(false); }, [assetPath]);

  const handleError = () => {
    setLoadFailed(true);
    onError?.();
  };

  if (loadFailed) {
    // Technical fallback: if asset fails to load, gracefully render nothing so avatar is never obscured
    return null;
  }

  const footprintPercent = propFootprint ?? getAssetFootprintPercent(assetPath, getTierFootprintPercent(frame.tier, context, size));
  const offset = -((footprintPercent - 100) / 2);

  return (
    <div
      data-testid="static-renderer"
      className={`absolute pointer-events-none select-none flex items-center justify-center ${className}`}
      style={{
        width: `${footprintPercent}%`,
        height: `${footprintPercent}%`,
        top: `${offset}%`,
        left: `${offset}%`,
      }}
    >
      <img
        src={assetPath}
        alt=""
        aria-hidden="true"
        onError={handleError}
        className="w-full h-full object-contain"
        loading="eager"
      />
    </div>
  );
}

