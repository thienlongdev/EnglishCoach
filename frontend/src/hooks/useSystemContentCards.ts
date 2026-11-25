'use client';
import useSWR from 'swr';
import { contentKey, contentSnapshot, fetchContentCards } from '../services/contentSystemResources';
export function useSystemContentCards<T>(path: string) {
  const resource = useSWR<T>(contentKey(path), () => fetchContentCards<T>(path), {
    fallbackData: contentSnapshot(path), revalidateOnFocus: false,
    dedupingInterval: 60000, keepPreviousData: false, shouldRetryOnError: false,
  });
  return { ...resource, isLoading: resource.data === undefined && resource.isLoading };
}
