'use client';

import React from 'react';
import { AvatarFrameContext, AvatarFrameDto, AvatarSize } from '@/types/avatarFrame';
import { resolveFrameLOD } from './FrameLODPolicy';
import { StaticRenderer } from './StaticRenderer';
import { CssAnimatedRenderer } from './CssAnimatedRenderer';

export interface FrameRendererProps {
  frame: AvatarFrameDto | null | undefined;
  size: AvatarSize;
  context: AvatarFrameContext;
  prefersReducedMotion?: boolean;
  onError?: () => void;
  className?: string;
}

export function FrameRenderer({
  frame,
  size,
  context,
  prefersReducedMotion = false,
  onError,
  className = '',
}: FrameRendererProps) {
  if (!frame) return null;

  const lod = resolveFrameLOD(frame, context, size, prefersReducedMotion);

  if (lod.effectiveRenderType === 'CSS_ANIMATED') {
    return (
      <CssAnimatedRenderer
        frame={frame}
        size={size}
        context={context}
        footprintPercent={lod.footprintPercent}
        onError={onError}
        className={className}
      />
    );
  }

  return (
    <StaticRenderer
      frame={frame}
      size={size}
      context={context}
      footprintPercent={lod.footprintPercent}
      onError={onError}
      className={className}
    />
  );
}

