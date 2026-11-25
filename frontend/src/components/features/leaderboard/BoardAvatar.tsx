'use client';

import React, { useState } from 'react';
import { AvatarWithFrame } from '@/components/common/frame/AvatarWithFrame';
import { getBaseUrl } from '@/services/api-client';
import { initialOf, letterAvatarHue } from '@/lib/leaderboard/format';
import type { AvatarFrameDto, AvatarFrameRenderType, AvatarFrameTier, AvatarSize } from '@/types/avatarFrame';
import type { BoardAvatarFrame } from '@/types/leaderboard';

/**
 * Board API frame (slug, tier, renderType, posterAsset) → the renderer's frame shape. Null-safe: the
 * board returns avatarFrame = null wherever V51 (avatar frames) is absent; then only the avatar shows.
 */
export function toFrameDto(f: BoardAvatarFrame | null | undefined): AvatarFrameDto | null {
  if (!f || !f.slug || !f.tier) return null;
  return {
    id: 0,
    slug: f.slug,
    series: { id: 0, slug: f.slug, name: f.slug },
    name: f.slug,
    tier: f.tier as AvatarFrameTier,
    lineage: 'ACHIEVEMENT',
    renderType: (f.renderType || 'STATIC_SVG') as AvatarFrameRenderType,
    posterAsset: f.posterAsset,
    previewAsset: f.posterAsset,
    ownership: { owned: true, equipped: true, expiresAt: null },
    progress: null,
  };
}

/** Board avatarUrl is relative to the API ("/api/v1/users/{id}/avatar?v=…"); resolve it like apiClient. */
export function resolveAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//.test(url)) return url;
  if (url.startsWith('/api/v1')) {
    const base = getBaseUrl().replace(/\/$/, '');
    return base.endsWith('/api/v1') ? base + url.slice('/api/v1'.length) : url;
  }
  return url;
}

const PX: Record<AvatarSize, number> = { xs: 24, sm: 40, md: 64, lg: 80, xl: 120 };

interface BoardAvatarProps {
  userId: number;
  name: string;
  avatarUrl: string | null;
  frame: BoardAvatarFrame | null;
  size?: AvatarSize;
  muted?: boolean;
  /**
   * Podium showcase (top 3 only): exact pixel size (e.g. 96 / 72) and the 'profile' context, so premium /
   * seasonal / prestige frames keep their own animation (reduced motion still forces the static poster inside
   * AvatarWithFrame). Dense rows never pass it and stay static (LOD Rule 9).
   */
  showcasePx?: number;
}

/**
 * Avatar with frame when equipped (the 'leaderboard' context forces the static renderer, LOD Rule 9);
 * otherwise the photo or a letter avatar coloured from the user id.
 */
export function BoardAvatar({ userId, name, avatarUrl, frame, size = 'sm', muted = false, showcasePx }: BoardAvatarProps) {
  const [broken, setBroken] = useState(false);
  const dto = toFrameDto(frame);
  const url = resolveAvatarUrl(avatarUrl);
  if (dto && showcasePx) {
    // Reuse the frame renderer at its nearest native size and scale the whole stack (no new renderer).
    const base: AvatarSize = showcasePx >= PX.lg ? 'lg' : 'md';
    const scale = showcasePx / PX[base];
    return (
      <span className="relative inline-block shrink-0" style={{ width: showcasePx, height: showcasePx }}>
        <span className="absolute left-1/2 top-1/2" style={{ width: PX[base], height: PX[base], transform: `translate(-50%, -50%) scale(${scale})` }}>
          <AvatarWithFrame avatarUrl={url} frame={dto} size={base} context="profile" fallbackName={name} alt={name} />
        </span>
      </span>
    );
  }
  if (dto) {
    return <AvatarWithFrame avatarUrl={url} frame={dto} size={size} context="leaderboard" fallbackName={name} alt={name} />;
  }
  const px = showcasePx ?? PX[size];
  const hue = letterAvatarHue(userId);
  return (
    <span
      className={`relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-bold text-white ${muted ? 'opacity-60 grayscale-[40%]' : ''}`}
      style={{ width: px, height: px, fontSize: Math.round(px * 0.42), background: `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 40) % 360} 70% 40%))` }}
      aria-label={name}
    >
      {url && !broken ? (
        <img src={url} alt={name} onError={() => setBroken(true)} className="h-full w-full object-cover" />
      ) : (
        <span aria-hidden="true">{initialOf(name)}</span>
      )}
    </span>
  );
}
