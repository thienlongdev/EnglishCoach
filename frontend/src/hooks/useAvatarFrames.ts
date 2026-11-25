'use client';

import useSWR from 'swr';
import { useSession } from 'next-auth/react';
import { avatarFrameApi } from '@/services/avatarFrameApi';
import { AvatarFrameDto } from '@/types/avatarFrame';

export const AVATAR_FRAMES_CACHE_KEY_PREFIX = '/frames/catalogue';

export interface UseAvatarFramesReturn {
  catalogue: AvatarFrameDto[];
  inventory: AvatarFrameDto[];
  equippedFrame: AvatarFrameDto | null;
  isLoading: boolean;
  error: any;
  equip: (slug: string) => Promise<AvatarFrameDto>;
  unequip: () => Promise<void>;
  reconcile: () => Promise<AvatarFrameDto[]>;
  mutateCatalogue: () => Promise<any>;
}

export function useAvatarFrames(): UseAvatarFramesReturn {
  const { data: session } = useSession();
  const userEmail = session?.user?.email;

  // Cache key is user-scoped to prevent cross-account cache pollution (AGENTS §21)
  const cacheKey = userEmail ? [AVATAR_FRAMES_CACHE_KEY_PREFIX, userEmail] : null;

  const { data: catalogue = [], error, isLoading, mutate } = useSWR<AvatarFrameDto[]>(
    cacheKey,
    async () => {
      try {
        return await avatarFrameApi.getCatalogue();
      } catch (err) {
        console.warn('[useAvatarFrames] Failed to fetch frame catalogue', err);
        return [];
      }
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 30000,
      keepPreviousData: false,
    }
  );

  const inventory = catalogue.filter((f) => f.ownership?.owned);
  const equippedFrame = catalogue.find((f) => f.ownership?.equipped) || null;

  const equip = async (slug: string): Promise<AvatarFrameDto> => {
    const updated = await avatarFrameApi.equipFrame(slug);
    // Optimistically update the catalogue cache
    await mutate(
      catalogue.map((f) => {
        if (f.slug === slug) {
          return {
            ...f,
            ownership: { ...f.ownership, equipped: true },
          };
        }
        if (f.ownership?.equipped) {
          return {
            ...f,
            ownership: { ...f.ownership, equipped: false },
          };
        }
        return f;
      }),
      { revalidate: true }
    );
    return updated;
  };

  const unequip = async (): Promise<void> => {
    await avatarFrameApi.unequipFrame();
    await mutate(
      catalogue.map((f) => ({
        ...f,
        ownership: { ...f.ownership, equipped: false },
      })),
      { revalidate: true }
    );
  };

  const reconcile = async (): Promise<AvatarFrameDto[]> => {
    try {
      const newlyUnlocked = await avatarFrameApi.reconcile();
      if (newlyUnlocked && newlyUnlocked.length > 0) {
        await mutate();
      }
      return newlyUnlocked;
    } catch (err) {
      console.warn('[useAvatarFrames] Reconcile call failed', err);
      return [];
    }
  };

  return {
    catalogue,
    inventory,
    equippedFrame,
    isLoading,
    error,
    equip,
    unequip,
    reconcile,
    mutateCatalogue: mutate,
  };
}
