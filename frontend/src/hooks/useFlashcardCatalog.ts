'use client';
import { useLayoutEffect, useState } from 'react';
import useSWR from 'swr';
import { useModuleEntryScope, useModuleEntryResource } from './useModuleEntryResource';
import { entryKey, fetchModuleEntry, FLASHCARD_CATALOG_PATH, FLASHCARD_PROGRESS_PATH } from '../services/moduleEntryResources';
import { readFlashcardSnapshot, mergeFlashcardDecks, FLASHCARD_FRESH_MS, type FlashcardCatalog, type DeckProgress } from '../lib/flashcard-system-cache';

export function useFlashcardCatalog() {
  const scope = useModuleEntryScope();
  const [snapshot, setSnapshot] = useState<FlashcardCatalog>();
  useLayoutEffect(() => { setSnapshot(readFlashcardSnapshot()?.data); }, []);
  const catalog = useSWR<FlashcardCatalog>(scope ? entryKey(FLASHCARD_CATALOG_PATH, scope) : null,
    () => fetchModuleEntry<FlashcardCatalog>(FLASHCARD_CATALOG_PATH, scope!), {
      fallbackData: snapshot, revalidateOnMount: true, revalidateOnFocus: false,
      dedupingInterval: 60000, refreshInterval: FLASHCARD_FRESH_MS, shouldRetryOnError: false,
    });
  const progress = useModuleEntryResource<DeckProgress[]>(FLASHCARD_PROGRESS_PATH);
  return { decks: mergeFlashcardDecks(catalog.data, progress.data), catalogKnown: catalog.data !== undefined,
    progressKnown: progress.data !== undefined, error: catalog.error,
    mutateDecks: () => progress.mutate(),
    mutateAllDecks: () => Promise.all([catalog.mutate(), progress.mutate()]) };
}
