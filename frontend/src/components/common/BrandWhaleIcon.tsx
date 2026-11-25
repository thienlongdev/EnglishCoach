'use client';

import React from 'react';
import { echoSrc, type EchoRole } from '@/lib/brand/echoCharacters';

export interface BrandWhaleIconProps {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  priority?: boolean;
  clean?: boolean;
  variant?: 'brand' | 'clean';
  /** Which Echo draws (lib/brand/echoCharacters). The product's own mark is the default. */
  character?: EchoRole;
}

const sizeConfig = {
  xs: {
    container: 'w-6 h-6 rounded-md p-0.5',
    innerRadius: 'rounded-[3px]',
    pixels: 16,
  },
  sm: {
    container: 'w-8 h-8 rounded-lg p-[3px]',
    innerRadius: 'rounded-[5px]',
    pixels: 32,
  },
  md: {
    container: 'w-10 h-10 rounded-xl p-1',
    innerRadius: 'rounded-[7px]',
    pixels: 40,
  },
  lg: {
    container: 'w-12 h-12 rounded-2xl p-1.5',
    innerRadius: 'rounded-xl',
    pixels: 48,
  },
  xl: {
    container: 'w-16 h-16 rounded-2xl p-2',
    innerRadius: 'rounded-xl',
    pixels: 64,
  },
};

export function BrandWhaleIcon({
  size = 'md',
  className = '',
  priority = false,
  clean = false,
  variant = 'brand',
  character = 'official',
}: BrandWhaleIconProps) {
  const isClean = clean || variant === 'clean';
  const config = sizeConfig[size] || sizeConfig.md;
  const src = echoSrc(character, config.pixels);

  if (isClean) {
    return (
      <img
        src={src}
        alt="Echo"
        aria-hidden="true"
        width={config.pixels}
        height={config.pixels}
        className={`object-contain pointer-events-none select-none shrink-0 ${className}`}
        loading={priority ? 'eager' : 'lazy'}
      />
    );
  }

  return (
    <div
      className={`relative flex items-center justify-center shrink-0 select-none overflow-hidden bg-gradient-to-br from-white to-sky-100 border border-sky-200/80 dark:from-slate-800 dark:to-slate-900 dark:border-sky-300/25 shadow-md shadow-sky-900/20 transition-all ${config.container} ${className}`}
      data-purpose="brand-whale-icon"
      data-size={size}
    >
      <img
        src={src}
        alt=""
        aria-hidden="true"
        width={config.pixels}
        height={config.pixels}
        className={`w-full h-full object-contain pointer-events-none select-none ${config.innerRadius}`}
        loading={priority ? 'eager' : 'lazy'}
      />
    </div>
  );
}
