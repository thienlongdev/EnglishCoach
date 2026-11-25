'use client';

import React, { useState, useEffect } from 'react';
import { useCurrentUserAvatar } from '@/hooks/useCurrentUserAvatar';
import { useCurrentUserProfile } from '@/hooks/useCurrentUserProfile';
import { useAvatarFrames } from '@/hooks/useAvatarFrames';
import { AvatarWithFrame } from '@/components/common/frame/AvatarWithFrame';
import { AvatarFrameContext, AvatarFrameDto, AvatarSize } from '@/types/avatarFrame';

export interface UserAvatarProps {
  /**
   * Tailwind classes for width, height, border radius, rings, and shadows.
   * Examples:
   * - TopNavbar: "w-8 h-8 rounded-full"
   * - Sidebar: "h-9 w-9 rounded-xl"
   * - Profile header: "w-full h-full rounded-2xl"
   */
  className?: string;

  /**
   * Fallback name to derive initials if profile is not yet fetched.
   * e.g. session.user?.name
   */
  fallbackName?: string | null;

  /**
   * Alt attribute for the image. Defaults to effective displayName.
   */
  alt?: string;

  /**
   * Typography class for initials.
   * e.g. "text-xs", "text-sm", "text-2xl sm:text-3xl"
   */
  textClassName?: string;

  /**
   * Explicit frame to render. If not provided and showFrame is true,
   * falls back to the user's currently equipped frame.
   */
  frame?: AvatarFrameDto | null;

  /**
   * Whether to render the equipped avatar frame if present.
   * Defaults to false to preserve strict backward compatibility for non-frame surfaces.
   */
  showFrame?: boolean;

  /**
   * Avatar frame context for LOD policy (e.g. 'navbar', 'card', 'leaderboard', 'profile').
   */
  context?: AvatarFrameContext;

  /**
   * Size token for frame renderer. If omitted, inferred from className or defaults to 'sm'.
   */
  size?: AvatarSize;

  /**
   * Click handler for avatar interaction (e.g. opening wardrobe modal).
   */
  onClick?: () => void;
}

function inferAvatarSize(className: string): AvatarSize {
  if (className.includes('w-6') || className.includes('h-6') || className.includes('w-7') || className.includes('h-7') || className.includes('w-8') || className.includes('h-8')) {
    return 'xs';
  }
  if (className.includes('w-9') || className.includes('h-9') || className.includes('w-10') || className.includes('h-10') || className.includes('w-12') || className.includes('h-12')) {
    return 'sm';
  }
  if (className.includes('w-16') || className.includes('h-16')) {
    return 'md';
  }
  if (className.includes('w-20') || className.includes('h-20') || className.includes('w-24') || className.includes('h-24')) {
    return 'lg';
  }
  if (className.includes('120')) {
    return 'xl';
  }
  return 'sm';
}

function inferAvatarContext(className: string): AvatarFrameContext {
  if (className.includes('w-6') || className.includes('w-7') || className.includes('w-8')) {
    return 'navbar';
  }
  return 'card';
}

export function UserAvatar({
  className = 'w-8 h-8 rounded-full',
  fallbackName,
  alt,
  textClassName = 'text-xs',
  frame,
  showFrame = false,
  context,
  size,
  onClick,
}: UserAvatarProps) {
  const { avatarUrl, hasAvatar, isLoading } = useCurrentUserAvatar();
  const { effectiveDisplayName, initials: profileInitials } = useCurrentUserProfile();
  const { equippedFrame } = useAvatarFrames();
  const [imageError, setImageError] = useState(false);
  useEffect(() => { setImageError(false); }, [avatarUrl]);

  // Compute initials instantly from profile or session name fallback
  const candidateName = effectiveDisplayName || fallbackName || '';
  const initials = candidateName
    ? candidateName
        .split(' ')
        .map((n) => n[0])
        .filter(Boolean)
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : (profileInitials || 'EC');

  const displayName = candidateName || 'User';

  const effectiveFrame = frame !== undefined ? frame : (showFrame ? equippedFrame : null);
  if (isLoading) return <div role="status" aria-label="Loading avatar" className={`shrink-0 animate-pulse bg-slate-200 dark:bg-slate-700 ${className}`} />;

  // If a frame is active, render via the unified AvatarWithFrame renderer with LOD enforcement
  if (effectiveFrame) {
    const effectiveSize = size || inferAvatarSize(className);
    const effectiveContext = context || inferAvatarContext(className);
    return (
      <AvatarWithFrame
        avatarUrl={hasAvatar && !imageError ? avatarUrl : null}
        frame={effectiveFrame}
        size={effectiveSize}
        context={effectiveContext}
        fallbackName={candidateName}
        alt={alt || displayName}
        className={className}
        onClick={onClick}
      />
    );
  }

  return (
    <div
      onClick={onClick}
      className={`relative select-none overflow-hidden shrink-0 flex items-center justify-center font-bold text-white bg-gradient-to-tr from-indigo-500 to-purple-600 ${className} ${onClick ? 'cursor-pointer' : ''}`}
    >
      {hasAvatar && avatarUrl && !imageError ? (
        <img
          src={avatarUrl}
          alt={alt || displayName}
          onError={() => setImageError(true)}
          className="w-full h-full object-cover transition-opacity duration-200 motion-reduce:transition-none"
        />
      ) : (
        <span className={textClassName}>{initials}</span>
      )}
    </div>
  );
}
