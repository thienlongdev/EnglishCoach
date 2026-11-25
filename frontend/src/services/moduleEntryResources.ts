import { READING_SYSTEM_SWR_KEY, saveReadingSnapshot, validReadingSnapshot } from '../lib/reading-system-cache';
import { mutate } from 'swr';
import { apiClient } from './api-client';
import { createEntryRequestStore, moduleEntryKey } from '../lib/module-entry-core';
import { LISTENING_SYSTEM_SWR_KEY, saveSystemListeningSnapshot, validSystemCategories } from '../lib/listening-system-cache';
import { FLASHCARD_SYSTEM_SWR_KEY, saveFlashcardSnapshot, validFlashcardCatalog } from '../lib/flashcard-system-cache';

export const READING_ENTRY_PATH = '/reading/catalog?library=SYSTEM&page=0&size=18';
export const READING_PROGRESS_PATH = '/reading/progress';
export const FLASHCARD_CATALOG_PATH = '/flashcards/decks/catalog';
export const FLASHCARD_PROGRESS_PATH = '/flashcards/decks/progress';
export const LISTENING_MATERIALS_ENTRY_PATH = '/listening/materials';
export const WRITING_CAPABILITIES_PATH = '/writing/capabilities';
export const WRITING_PROFILE_PATH = '/writing/profile';
export const TRANSLATION_CATALOG_PATH = '/writing/translation/catalog';
export const SPEAKING_METADATA_PATH = '/speaking/scenarios/metadata';
export const SYSTEM_CATEGORIES_PATH = '/listening/library/categories';
const requests = createEntryRequestStore();
let generation = 0;
export const clearModuleEntryRequests = () => { generation++; requests.clear(); };

export function entryKey(path: string, scope: string) {
  if (path === READING_ENTRY_PATH) return READING_SYSTEM_SWR_KEY;
  if (path === FLASHCARD_CATALOG_PATH) return FLASHCARD_SYSTEM_SWR_KEY;
  return path === SYSTEM_CATEGORIES_PATH ? LISTENING_SYSTEM_SWR_KEY : moduleEntryKey(path, scope);
}

export function fetchModuleEntry<T>(path: string, scope: string): Promise<T> {
  return requests.run(JSON.stringify(entryKey(path, scope)), async signal => {
    const { data } = await apiClient.get<T>(path, { signal, timeout: 15000 });
    if (signal.aborted) throw new Error('Module request cancelled');
    if (path === READING_ENTRY_PATH) {
      if (!validReadingSnapshot(data)) throw new Error("Invalid SYSTEM Reading catalog");
      saveReadingSnapshot(data);
    }
    if (path === FLASHCARD_CATALOG_PATH) {
      if (!validFlashcardCatalog(data)) throw new Error('Invalid SYSTEM Flashcard catalog');
      saveFlashcardSnapshot(data);
    }
    if (path === SYSTEM_CATEGORIES_PATH) {
      if (!validSystemCategories(data)) throw new Error('Invalid SYSTEM catalog');
      saveSystemListeningSnapshot(data);
    }
    return data;
  });
}

export async function prepareModuleEntry(path: string, scope: string, cancelled: () => boolean = () => false) {
  const startedGeneration = generation;
  const data = await fetchModuleEntry(path, scope);
  if (cancelled() || startedGeneration !== generation) return;
  await mutate(entryKey(path, scope), data, { revalidate: false });
}

export function revalidateListeningSystemCatalog() {
  if (typeof window !== 'undefined') {
    try { localStorage.removeItem('ec_system_listening_categories_v2'); } catch {}
  }
  return mutate(LISTENING_SYSTEM_SWR_KEY);
}

export function revalidateListeningMaterialResource() {
  return mutate(key => Array.isArray(key) && key[0] === 'module-entry' && key[1] === LISTENING_MATERIALS_ENTRY_PATH);
}

export function revalidateReadingUserCatalog() {
  return mutate(key => Array.isArray(key) && key[0] === 'module-entry'
    && typeof key[1] === 'string' && key[1].startsWith('/reading/catalog?library=USER'), undefined, { revalidate: true });
}
