'use client';

import useSWR from 'swr';
import { useSession } from 'next-auth/react';
import { apiClient } from '@/services/api-client';

/**
 * Live role of the signed-in account, read from the backend (`GET /api/v1/auth/me` → `users.role`), never from the
 * NextAuth session: `session.user.role` is copied once at login and goes stale when a role changes (e.g. the V68
 * single-admin demotion). The backend authorizes every request from the DB row, so UI and API now agree.
 *
 * Cache key is user-scoped (AGENTS §21.5) and wiped by `clearUserScopedCaches()` on account switch. Revalidates on
 * focus and once a minute; while loading `isAdmin` is false (admin UI never flashes for a learner).
 */
export const CURRENT_ROLE_CACHE_KEY_PREFIX = '/auth/me';
export const CURRENT_ROLE_REFRESH_MS = 60_000;

export interface AuthMe {
  id: number;
  email: string;
  name: string;
  role: 'ROLE_USER' | 'ROLE_ADMIN' | string;
  emailVerified: boolean | null;
  authenticationMethods: string[];
}

export function useCurrentRole() {
  const { data: session, status } = useSession();
  const email = session?.user?.email;
  const key = status === 'authenticated' && email ? [CURRENT_ROLE_CACHE_KEY_PREFIX, email] : null;
  const { data, error, isLoading, mutate } = useSWR<AuthMe>(
    key,
    async () => (await apiClient.get<AuthMe>('/auth/me')).data,
    {
      revalidateOnFocus: true,
      revalidateOnMount: true,
      refreshInterval: CURRENT_ROLE_REFRESH_MS,
      dedupingInterval: 10_000,
      keepPreviousData: false,
      shouldRetryOnError: false,
    },
  );
  const role = data?.role ?? null;
  return {
    role,
    isAdmin: role === 'ROLE_ADMIN',
    /** true until the live role is known for a signed-in user (admin pages wait instead of showing "no access"). */
    isLoading: key != null && !data && !error && (isLoading || data === undefined),
    error,
    mutate,
  };
}

/** Convenience: live admin flag (false while unknown / signed out). */
export function useIsAdmin(): boolean {
  return useCurrentRole().isAdmin;
}
