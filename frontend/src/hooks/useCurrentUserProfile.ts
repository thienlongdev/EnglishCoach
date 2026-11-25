'use client';

import useSWR, { KeyedMutator } from 'swr';
import { useSession } from 'next-auth/react';
import { UserProfileDto } from '@/services/userProfileApi';
import { fetchIdentityProfile } from '@/services/profileIdentityResource';

export const USER_PROFILE_CACHE_KEY_PREFIX = '/users/me/profile';

export interface UseCurrentUserProfileReturn {
  profile: UserProfileDto | undefined;
  isLoading: boolean;
  error: any;
  mutateProfile: KeyedMutator<UserProfileDto>;
  effectiveDisplayName: string;
  initials: string;
  avatarPresent: boolean;
  avatarUpdatedAt: string | null;
}

export function useCurrentUserProfile(): UseCurrentUserProfileReturn {
  const { data: session, status } = useSession();
  const userEmail = session?.user?.email;

  // Cache key is strictly user-scoped to prevent cross-account leakage (Section 21 AGENTS.md)
  const swrKey = status === 'authenticated' && userEmail
    ? [USER_PROFILE_CACHE_KEY_PREFIX, userEmail]
    : null;

  const { data: profile, error, isLoading, mutate } = useSWR<UserProfileDto>(
    swrKey,
    async () => {
      return await fetchIdentityProfile(userEmail!);
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 30000,
      keepPreviousData: false,
    }
  );

  const effectiveDisplayName = profile?.displayName || session?.user?.name || '';
  const initials = effectiveDisplayName
    ? effectiveDisplayName
        .split(' ')
        .map((n) => n[0])
        .filter(Boolean)
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : 'EC';

  return {
    profile,
    isLoading: status === 'loading' || (isLoading && !profile),
    error,
    mutateProfile: mutate,
    effectiveDisplayName,
    initials,
    avatarPresent: !!profile?.avatarPresent,
    avatarUpdatedAt: profile?.avatarUpdatedAt || null,
  };
}
