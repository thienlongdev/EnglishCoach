'use client';

import React, { useState, useEffect } from 'react';
import { AvatarFrameContext, AvatarFrameDto, AvatarSize, TIER_COLORS } from '@/types/avatarFrame';
import { FrameRenderer } from './FrameRenderer';
import { getFramePresentationConfig } from './visualThemes';
import { cn } from '@/lib/utils';

export interface AvatarWithFrameProps {
  avatarUrl?: string | null;
  frame?: AvatarFrameDto | null;
  size?: AvatarSize;
  context?: AvatarFrameContext;
  fallbackName?: string | null;
  alt?: string;
  className?: string;
  onClick?: () => void;
}

const SIZE_CONFIGS: Record<AvatarSize, { root: string; initialsText: string; px: number }> = {
  xs: { root: 'w-6 h-6', initialsText: 'text-[10px]', px: 24 },
  sm: { root: 'w-10 h-10', initialsText: 'text-xs', px: 40 },
  md: { root: 'w-16 h-16', initialsText: 'text-lg', px: 64 },
  lg: { root: 'w-20 h-20', initialsText: 'text-2xl', px: 80 },
  xl: { root: 'w-[120px] h-[120px]', initialsText: 'text-3xl', px: 120 },
};

export function AvatarWithFrame({
  avatarUrl,
  frame,
  size = 'md',
  context = 'profile',
  fallbackName,
  alt,
  className = '',
  onClick,
}: AvatarWithFrameProps) {
  const [imageError, setImageError] = useState(false);
  const [frameError, setFrameError] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  useEffect(() => { setImageError(false); }, [avatarUrl]);
  useEffect(() => { setFrameError(false); }, [frame?.posterAsset, frame?.previewAsset]);

  // Monitor prefers-reduced-motion accessibility setting
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mediaQuery.matches);

    const listener = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
    mediaQuery.addEventListener('change', listener);
    return () => mediaQuery.removeEventListener('change', listener);
  }, []);

  const config = SIZE_CONFIGS[size] || SIZE_CONFIGS.md;

  const initials = fallbackName
    ? fallbackName
        .split(' ')
        .map((n) => n[0])
        .filter(Boolean)
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : 'EC';

  const tierGlow = frame ? TIER_COLORS[frame.tier]?.glow : null;
  const isOverflow = frame?.tier === 'SSS' || frame?.tier === 'SS';
  const sanitizedClassName = className.replace(/\boverflow-hidden\b/g, '').trim();
  const presentation = getFramePresentationConfig(frame);

  // ── 0. FrameRoot: sizing, ratio, bounding box ──
  return (
    <div
      data-testid="frame-root"
      onClick={onClick}
      className={cn('relative shrink-0 select-none overflow-visible', config.root, onClick && 'cursor-pointer', sanitizedClassName)}
      style={{
        // Maintain exact bounding box; overflow geometry is drawn without shifting layout
        filter: tierGlow && !prefersReducedMotion && context !== 'navbar' ? `drop-shadow(0 0 6px ${tierGlow})` : undefined,
      }}
    >
      {/* ── 1. AuraLayer: subtle background glow ── */}
      {frame && !prefersReducedMotion && context !== 'navbar' && (
        <div
          data-testid="aura-layer"
          className={`absolute inset-0 rounded-full pointer-events-none transition-opacity ${
            presentation.auraClass
          } ${
            frame.tier === 'SSS'
              ? 'scale-160 opacity-60 blur-md'
              : frame.tier === 'SS'
              ? 'scale-140 opacity-50 blur-sm'
              : frame.tier === 'S'
              ? 'scale-125 opacity-40 blur-xs'
              : frame.tier === 'A'
              ? 'scale-110 opacity-30 blur-xs'
              : 'opacity-25 blur-xs'
          }`}
          style={{
            backgroundColor: presentation.primaryColor || tierGlow || undefined,
            transformOrigin: 'center center',
          }}
        />
      )}

      {/* ── 2. AvatarLayer: clipped circular avatar or initials fallback ── */}
      <div
        data-testid="avatar-layer"
        className="absolute inset-0 rounded-full overflow-hidden flex items-center justify-center font-bold text-white bg-gradient-to-tr from-indigo-500 to-purple-600 shadow-inner z-10"
      >
        {avatarUrl && !imageError ? (
          <img
            src={avatarUrl}
            alt={alt || fallbackName || 'User Avatar'}
            onError={() => setImageError(true)}
            className="w-full h-full object-cover transition-opacity duration-200 motion-reduce:transition-none"
          />
        ) : (
          <span className={config.initialsText}>{initials}</span>
        )}
      </div>

      {/* ── 3. FrameCoreLayer & 4. OverflowLayer rendered via FrameRenderer ── */}
      {frame && !frameError && (
        <div
          data-testid={isOverflow ? 'overflow-layer' : 'frame-core-layer'}
          className="absolute inset-0 pointer-events-none z-20 flex items-center justify-center overflow-visible"
        >
          <FrameRenderer
            frame={frame}
            size={size}
            context={context}
            prefersReducedMotion={prefersReducedMotion}
            onError={() => setFrameError(true)}
          />
        </div>
      )}

      {/* ── 5. FXLayer: reserved for future SSS particles/shimmer ── */}
      <div data-testid="fx-layer" className="absolute inset-0 pointer-events-none z-30 overflow-visible">
        {frame && !prefersReducedMotion && (size === 'lg' || size === 'xl') && (
          <>
            {presentation.fxProfile === 'phoenix-flame-feathers' && (
              <div className="absolute inset-0 overflow-visible pointer-events-none motion-reduce:hidden">
                {/* Phoenix Flame Feathers & Embers */}
                <span className="absolute -top-3 left-2 w-2 h-2 rounded-full bg-amber-400 opacity-85 blur-[0.5px] frame-feather-mote-1" />
                <span className="absolute top-1 -right-3 w-1.5 h-1.5 rounded-full bg-red-500 opacity-80 blur-[0.5px] frame-feather-mote-2" />
                <span className="absolute -bottom-2 left-4 w-2 h-2 rounded-full bg-orange-400 opacity-85 blur-[0.5px] frame-feather-mote-3" />
                <span className="absolute bottom-2 -right-2 w-1.5 h-1.5 rounded-full bg-amber-300 opacity-90 blur-[0.5px] frame-feather-mote-1" />
              </div>
            )}
            {presentation.fxProfile === 'dragon-pearl-motes' && (
              <div className="absolute inset-0 overflow-visible pointer-events-none motion-reduce:hidden">
                {/* Imperial Dragon Energy Motes & Pearl Embers */}
                <span className="absolute -top-3 left-2 w-2 h-2 rounded-full bg-amber-300 opacity-80 blur-[0.5px] frame-mote-1" />
                <span className="absolute top-2 -right-2 w-1.5 h-1.5 rounded-full bg-rose-500 opacity-75 blur-[0.5px] frame-mote-2" />
                <span className="absolute -bottom-1 -left-2 w-2 h-2 rounded-full bg-amber-400 opacity-85 blur-[0.5px] frame-mote-3" />
                <span className="absolute bottom-4 right-1 w-1.5 h-1.5 rounded-full bg-orange-400 opacity-70 blur-[0.5px] frame-mote-1" />
              </div>
            )}
            {presentation.fxProfile === 'nature-petals' && (
              <div className="absolute inset-0 overflow-visible pointer-events-none motion-reduce:hidden">
                {/* Spring Blossom Petals */}
                <span className="absolute -top-2 right-2 w-1.5 h-1.5 rounded-full bg-pink-300 opacity-80 blur-[0.5px] frame-petal-mote-1" />
                <span className="absolute bottom-1 -left-2 w-1.5 h-1.5 rounded-full bg-emerald-400 opacity-75 blur-[0.5px] frame-petal-mote-2" />
                <span className="absolute top-3 -left-1 w-1 h-1 rounded-full bg-pink-200 opacity-85 blur-[0.5px] frame-petal-mote-3" />
              </div>
            )}
            {presentation.fxProfile === 'solar-heat-motes' && (
              <div className="absolute inset-0 overflow-visible pointer-events-none motion-reduce:hidden">
                {/* Summer Radiant Solar Motes */}
                <span className="absolute -top-3 left-3 w-2 h-2 rounded-full bg-amber-400 opacity-85 blur-[0.5px] frame-mote-1" />
                <span className="absolute bottom-2 -right-2 w-1.5 h-1.5 rounded-full bg-orange-500 opacity-80 blur-[0.5px] frame-mote-2" />
                <span className="absolute top-4 -left-2 w-1 h-1 rounded-full bg-yellow-200 opacity-90 blur-[0.5px] frame-mote-3" />
              </div>
            )}
            {presentation.fxProfile === 'autumn-leaf-motes' && (
              <div className="absolute inset-0 overflow-visible pointer-events-none motion-reduce:hidden">
                {/* Autumn Falling Leaf / Wind Motes */}
                <span className="absolute -top-2 -left-2 w-2 h-2 rounded-full bg-amber-500 opacity-80 blur-[0.5px] frame-petal-mote-1" />
                <span className="absolute bottom-1 right-2 w-1.5 h-1.5 rounded-full bg-red-600 opacity-85 blur-[0.5px] frame-petal-mote-2" />
                <span className="absolute top-4 right-1 w-1.5 h-1.5 rounded-full bg-orange-400 opacity-75 blur-[0.5px] frame-petal-mote-3" />
              </div>
            )}
            {presentation.fxProfile === 'frost-flakes' && (
              <div className="absolute inset-0 overflow-visible pointer-events-none motion-reduce:hidden">
                {/* Winter Frost & Ice Flakes */}
                <span className="absolute -top-2 left-2 w-1.5 h-1.5 rounded-full bg-cyan-200 opacity-85 blur-[0.5px] frame-flake-mote-1" />
                <span className="absolute bottom-2 -right-1 w-1.5 h-1.5 rounded-full bg-white opacity-90 blur-[0.5px] frame-flake-mote-2" />
                <span className="absolute top-3 -left-2 w-1 h-1 rounded-full bg-sky-300 opacity-80 blur-[0.5px] frame-flake-mote-3" />
              </div>
            )}
            {presentation.fxProfile === 'imperial-gold-sparks' && (
              <div className="absolute inset-0 overflow-visible pointer-events-none motion-reduce:hidden">
                {/* Imperial Sovereign Gold Sparks */}
                <span className="absolute -top-2 right-2 w-2 h-2 rounded-full bg-amber-300 opacity-85 blur-[0.5px] frame-spark-mote-1" />
                <span className="absolute bottom-1 -left-2 w-1.5 h-1.5 rounded-full bg-red-600 opacity-80 blur-[0.5px] frame-spark-mote-2" />
                <span className="absolute top-4 -right-1 w-1 h-1 rounded-full bg-yellow-200 opacity-90 blur-[0.5px] frame-spark-mote-3" />
              </div>
            )}
            {presentation.fxProfile === 'celestial-starlight' && (
              <div className="absolute inset-0 overflow-visible pointer-events-none motion-reduce:hidden">
                {/* Celestial Starlight Gleam Motes */}
                <span className="absolute -top-2 right-3 w-1.5 h-1.5 rounded-full bg-cyan-200 opacity-80 blur-[0.5px] frame-mote-1" />
                <span className="absolute bottom-0 -left-1 w-1.5 h-1.5 rounded-full bg-amber-200 opacity-70 blur-[0.5px] frame-mote-2" />
                <span className="absolute top-4 -right-1 w-1 h-1 rounded-full bg-white opacity-90 blur-[0.5px] frame-mote-3" />
              </div>
            )}
            {presentation.fxProfile === 'arcane-runes' && (
              <div className="absolute inset-0 overflow-visible pointer-events-none motion-reduce:hidden">
                {/* Arcane Energy Resonance Motes */}
                <span className="absolute -top-1 left-3 w-1.5 h-1.5 rounded-full bg-purple-300 opacity-75 blur-[0.5px] frame-mote-1" />
                <span className="absolute bottom-1 right-2 w-1.5 h-1.5 rounded-full bg-violet-400 opacity-70 blur-[0.5px] frame-mote-2" />
              </div>
            )}
            {presentation.fxProfile === 'ember-particles' && (
              <div className="absolute inset-0 overflow-visible pointer-events-none motion-reduce:hidden">
                {/* Fire Ember Motes */}
                <span className="absolute -top-2 left-2 w-1.5 h-1.5 rounded-full bg-orange-400 opacity-80 blur-[0.5px] frame-mote-1" />
                <span className="absolute bottom-2 right-2 w-1 h-1 rounded-full bg-red-500 opacity-80 blur-[0.5px] frame-mote-2" />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
