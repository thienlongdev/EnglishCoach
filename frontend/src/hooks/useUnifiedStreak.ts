'use client';

import useSWR, { KeyedMutator } from 'swr';
import { useSession } from 'next-auth/react';
import { progressApi, UnifiedStreakDto } from '@/services/progressApi';

export const UNIFIED_STREAK_CACHE_KEY_PREFIX = '/progress/streak';

export interface UseUnifiedStreakReturn {
  streak: UnifiedStreakDto | undefined;
  isLoading: boolean;
  error: any;
  mutateStreak: KeyedMutator<UnifiedStreakDto>;
}

export function useUnifiedStreak(): UseUnifiedStreakReturn {
  const { data: session, status } = useSession();
  const userEmail = session?.user?.email;

  // Cache key is strictly user-scoped to prevent cross-account leakage (Section 21 AGENTS.md)
  const swrKey = status === 'authenticated' && userEmail
    ? [UNIFIED_STREAK_CACHE_KEY_PREFIX, userEmail]
    : null;

  const { data: streak, error, isLoading, mutate } = useSWR<UnifiedStreakDto>(
    swrKey,
    async () => {
      return await progressApi.getStreak();
    },
    {
      revalidateOnFocus: false,
      dedupingInterval: 30000,
      keepPreviousData: true,
    }
  );

  const mutateStreak: KeyedMutator<UnifiedStreakDto> = async (...args: any[]) => {
    const res = await (mutate as any)(...args);
    try {
      const { broadcastStreakUpdate } = await import('@/lib/cross-tab-sync');
      broadcastStreakUpdate();
    } catch {
      // ignore
    }
    return res;
  };

  return {
    streak,
    isLoading: status === 'loading' || (isLoading && !streak),
    error,
    mutateStreak,
  };
}
