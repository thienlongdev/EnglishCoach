import type { VocabDeckSummary } from '../components/features/flashcard/DeckCatalogView';

export const FLASHCARD_SYSTEM_CACHE_KEY = 'ec_system_flashcard_catalog_v1';
export const FLASHCARD_SYSTEM_SWR_KEY = 'system:flashcard-catalog:v1';
export const FLASHCARD_FRESH_MS = 5 * 60 * 1000;
export const FLASHCARD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export type SystemDeck = Omit<VocabDeckSummary, 'masteredCount' | 'reviewedCount' | 'learningCount' | 'dueCount' | 'progressPercentage' | 'isEnrolled' | 'latestRatings'>;
export interface FlashcardCatalog { catalogRevision: string; totalDecks: number; totalWords: number; decks: SystemDeck[] }
export interface DeckProgress { deckId: number | null; totalCards: number; masteredCount: number; reviewedCount: number; learningCount: number; dueCount: number; latestRatings?: string[] }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v: Record<string, any>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const fields = ['id','slug','title','description','category','themeColor','icon','totalWords','isSystem','sortOrder'];
export function validFlashcardCatalog(v: unknown): v is FlashcardCatalog {
  return object(v) && only(v, ['catalogRevision','totalDecks','totalWords','decks'])
    && typeof v.catalogRevision === 'string' && /^[a-f0-9]{64}$/.test(v.catalogRevision)
    && count(v.totalDecks) && count(v.totalWords) && Array.isArray(v.decks) && v.decks.length <= 500
    && v.totalDecks === v.decks.length && new Set(v.decks.map((d: any) => d?.id)).size === v.decks.length
    && v.decks.every((d: unknown) => object(d) && only(d, fields) && count(d.id) && d.id > 0
      && d.isSystem === true && count(d.totalWords) && Number.isSafeInteger(d.sortOrder)
      && ['slug','title','category','themeColor','icon'].every(k => typeof d[k] === 'string' && d[k].length > 0 && d[k].length <= 255)
      && (d.description === null || (typeof d.description === 'string' && d.description.length <= 10000)))
    && v.totalWords === v.decks.reduce((sum: number, d: SystemDeck) => sum + d.totalWords, 0);
}
export function readFlashcardSnapshot(storage?: Pick<Storage, 'getItem'>, now = Date.now()) {
  try {
    const raw = (storage ?? (typeof window === 'undefined' ? undefined : window.localStorage))?.getItem(FLASHCARD_SYSTEM_CACHE_KEY);
    if (!raw || raw.length > 200000) return undefined;
    const v = JSON.parse(raw);
    if (!object(v) || !only(v, ['version','cachedAt','data']) || v.version !== 1
      || !Number.isFinite(v.cachedAt) || v.cachedAt > now || now - v.cachedAt > FLASHCARD_MAX_AGE_MS
      || !validFlashcardCatalog(v.data)) return undefined;
    return { version: 1, cachedAt: v.cachedAt as number, data: v.data, stale: now - v.cachedAt >= FLASHCARD_FRESH_MS };
  } catch { return undefined; }
}
export function saveFlashcardSnapshot(data: unknown, storage?: Pick<Storage, 'setItem'>, now = Date.now()) {
  if (!validFlashcardCatalog(data)) return;
  try {
    const raw = JSON.stringify({ version: 1, cachedAt: now, data });
    if (raw.length <= 200000) (storage ?? (typeof window === 'undefined' ? undefined : window.localStorage))?.setItem(FLASHCARD_SYSTEM_CACHE_KEY, raw);
  } catch { /* Storage denial must not block the catalog. */ }
}
export function mergeFlashcardDecks(catalog: FlashcardCatalog | undefined, progress: DeckProgress[] | undefined): VocabDeckSummary[] {
  const overlay = new Map(progress?.map(p => [p.deckId, p]));
  const decks = (catalog?.decks ?? []).map(d => {
    const p = overlay.get(d.id), total = d.totalWords;
    const masteredCount = total > 0 ? Math.min(p?.masteredCount ?? 0, total) : p?.masteredCount ?? 0;
    return { ...d, latestRatings: p?.latestRatings ?? [], masteredCount, reviewedCount: total > 0 ? Math.min(p?.reviewedCount ?? 0, total) : p?.reviewedCount ?? 0,
      learningCount: total > 0 ? Math.min(p?.learningCount ?? 0, total) : p?.learningCount ?? 0,
      dueCount: total > 0 ? Math.min(p?.dueCount ?? 0, total) : p?.dueCount ?? 0,
      progressPercentage: total > 0 ? Math.round(masteredCount * 100 / total) : 0, isEnrolled: (p?.totalCards ?? 0) > 0 };
  });
  if (progress !== undefined) {
    const p = overlay.get(null);
    decks.unshift({ id: null, slug: 'personal', title: 'Bộ từ của bản thân', description: 'Tự thêm và ôn tập từ vựng của riêng bạn.',
      category: 'PERSONAL', themeColor: 'emerald', icon: 'user', totalWords: p?.totalCards ?? 0, isSystem: false, sortOrder: 0,
      masteredCount: p?.masteredCount ?? 0, reviewedCount: p?.reviewedCount ?? 0, learningCount: p?.learningCount ?? 0,
      latestRatings: p?.latestRatings ?? [], dueCount: p?.dueCount ?? 0, progressPercentage: p?.totalCards ? Math.round(p.masteredCount * 100 / p.totalCards) : 0, isEnrolled: true });
  }
  return decks;
}
