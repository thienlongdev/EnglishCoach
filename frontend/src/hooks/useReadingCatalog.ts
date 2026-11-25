'use client';
import { useLayoutEffect, useState } from 'react';
import useSWR from 'swr';
import { useModuleEntryScope } from './useModuleEntryResource';
import { entryKey, fetchModuleEntry, READING_ENTRY_PATH } from '../services/moduleEntryResources';
import { readReadingSnapshot, type ReadingCatalog } from '../lib/reading-system-cache';
export function useReadingCatalog(library = 'SYSTEM', page = 0, search = '', topic = '', level = '', sort = 'recent') {
  const scope = useModuleEntryScope();
  const [snapshot, setSnapshot] = useState<ReadingCatalog>();
  useLayoutEffect(() => { setSnapshot(readReadingSnapshot()?.data); }, []);
  const first = library === 'SYSTEM' && page === 0 && !search && !topic && !level && sort === 'recent';
  const path = first ? READING_ENTRY_PATH : '/reading/catalog?' + new URLSearchParams({ library, page: String(page), size: '18', search, topic, level, sort });
  return useSWR<ReadingCatalog>(scope ? entryKey(path, scope) : null, () => fetchModuleEntry<ReadingCatalog>(path, scope!), {
    fallbackData: first ? snapshot : undefined, keepPreviousData: false, revalidateOnMount: true,
    revalidateOnFocus: false, dedupingInterval: 60000, refreshInterval: 300000, shouldRetryOnError: false,
  });
}
