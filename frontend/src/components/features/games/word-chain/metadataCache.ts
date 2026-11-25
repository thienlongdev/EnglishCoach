import type { WordMetadata } from './types';

// Public canonical word metadata only. Never stores identities, histories or game authority.
// v2 (2026-10-29): meanings now follow the entry's own sense order; v1 entries held the old rare senses.
const KEY = 'ec.word-chain.metadata.v2';
const CAPACITY = 200;
const MAX_AGE = 7 * 86400000;
type Cached = { word: WordMetadata; at: number };
const memory = new Map<string, Cached>();
let loaded = false;
export function hydrateMetadataCache() {
  if (loaded || typeof window === 'undefined') return;
  loaded = true;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw || raw.length > 200000) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed.slice(-CAPACITY) as Cached[]) {
      const w = entry?.word;
      if (w && typeof w.normalizedWord === 'string' && w.normalizedWord.length <= 40 &&
          typeof w.displayWord === 'string' && Date.now() - entry.at < MAX_AGE &&
          [w.ipa, w.partOfSpeech, w.meaningVi, w.cefr].every(v => v == null || (typeof v === 'string' && v.length <= 2000)))
        memory.set(w.normalizedWord, entry);
    }
  } catch { /* Storage can be disabled or full. Gameplay uses server snapshots. */ }
}
export function rememberMetadata(words: WordMetadata[]) {
  hydrateMetadataCache();
  for (const word of words) {
    memory.delete(word.normalizedWord);
    memory.set(word.normalizedWord, { word, at: Date.now() });
  }
  while (memory.size > CAPACITY) memory.delete(memory.keys().next().value!);
  try { localStorage.setItem(KEY, JSON.stringify([...memory.values()])); } catch { /* optional cache */ }
}
export function cachedMetadata(word: string) {
  const entry = memory.get(word);
  return entry && Date.now() - entry.at < MAX_AGE ? entry.word : undefined;
}
