'use client';
import { useSession } from 'next-auth/react';
import useSWR from 'swr';
import type { ListeningCategory } from '../types/listening';
import { entryKey, fetchModuleEntry, SYSTEM_CATEGORIES_PATH } from '../services/moduleEntryResources';
import { readSystemListeningSnapshot } from '../lib/listening-system-cache';

export function useModuleEntryScope() {
  const { data: session, status } = useSession();
  const id = (session?.user as { id?: string })?.id;
  return status === 'authenticated' && id ? String(id) : null;
}

export function useModuleEntryResource<T>(path: string, enabled = true) {
  const scope = useModuleEntryScope();
  return useSWR<T>(scope && enabled ? entryKey(path, scope) : null,
    () => fetchModuleEntry<T>(path, scope!), {
      keepPreviousData: false, revalidateOnFocus: false, dedupingInterval: 60000,
      shouldRetryOnError: false,
    });
}

export function useListeningSystemCategories() {
  const scope = useModuleEntryScope();
  const snapshot = readSystemListeningSnapshot();
  return useSWR<ListeningCategory[]>(scope ? entryKey(SYSTEM_CATEGORIES_PATH, scope) : null,
    () => fetchModuleEntry<ListeningCategory[]>(SYSTEM_CATEGORIES_PATH, scope!), {
      fallbackData: snapshot?.data, revalidateOnFocus: false, revalidateIfStale: true,
      refreshInterval: 60 * 60 * 1000, dedupingInterval: 5 * 60 * 1000,
      shouldRetryOnError: false,
    });
}
