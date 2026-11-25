'use client';

import useSWR, { KeyedMutator } from 'swr';
import { useSession } from 'next-auth/react';
import { fetchIdentityAvatar } from '@/services/profileIdentityResource';
import { useCurrentUserProfile } from './useCurrentUserProfile';

export const USER_AVATAR_CACHE_KEY_PREFIX = '/users/me/avatar';

let currentAvatarKey: string | null = null;
let currentObjectUrl: string | null = null;

/**
 * Creates or retrieves the shared object URL for the current active avatar key and blob.
 * Automatically revokes any previous object URL when the key changes.
 */
export function getOrCreateAvatarObjectUrl(key: string, blob: Blob): string {
  if (typeof window === 'undefined') return '';
  if (currentAvatarKey === key && currentObjectUrl) {
    return currentObjectUrl;
  }
  if (currentObjectUrl) {
    try {
      URL.revokeObjectURL(currentObjectUrl);
    } catch {
      // ignore
    }
    currentObjectUrl = null;
  }
  currentAvatarKey = key;
  try {
    currentObjectUrl = URL.createObjectURL(blob);
  } catch (err) {
    console.warn('[useCurrentUserAvatar] Failed to create object URL', err);
    currentObjectUrl = null;
  }
  return currentObjectUrl || '';
}

/**
 * Revokes the current avatar object URL immediately and resets cache tracking.
 * Used upon avatar deletion and account logout.
 */
export function revokeCurrentAvatarObjectUrl(): void {
  if (typeof window === 'undefined') return;
  if (currentObjectUrl) {
    try {
      URL.revokeObjectURL(currentObjectUrl);
    } catch {
      // ignore
    }
    currentObjectUrl = null;
    currentAvatarKey = null;
  }
}

export interface UseCurrentUserAvatarReturn {
  avatarUrl: string | null;
  hasAvatar: boolean;
  isLoading: boolean;
  error: any;
  mutateAvatar: KeyedMutator<Blob | null>;
}

export function useCurrentUserAvatar(): UseCurrentUserAvatarReturn {
  const { data: session } = useSession();
  const { profile, avatarPresent, avatarUpdatedAt, isLoading: profileLoading } = useCurrentUserProfile();
  const userEmail = session?.user?.email;

  // Key is non-null ONLY when authenticated AND avatarPresent is true
  const avatarKey = avatarPresent && userEmail
    ? [USER_AVATAR_CACHE_KEY_PREFIX, userEmail, avatarUpdatedAt || 'default']
    : null;

  const keyString = avatarKey ? avatarKey.join(':') : null;

  const { data: blob, error, isLoading, mutate } = useSWR<Blob | null>(
    avatarKey,
    async () => {
      try {
        return await fetchIdentityAvatar(userEmail!, avatarUpdatedAt);
      } catch (err) {
        console.warn('[useCurrentUserAvatar] Failed to load avatar blob', err);
        return null;
      }
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 60000,
      shouldRetryOnError: false,
    }
  );

  // Resolve the cached blob during this render; no post-mount effect/default-avatar frame.
  const avatarUrl = keyString && blob ? getOrCreateAvatarObjectUrl(keyString, blob) : null;


  return {
    avatarUrl,
    hasAvatar: avatarPresent && !!avatarUrl,
    isLoading: profileLoading || !profile || (avatarPresent && !avatarUrl),
    error,
    mutateAvatar: mutate,
  };
}
