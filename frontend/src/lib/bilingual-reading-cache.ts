import type { BilingualReadingCatalog } from '@/types/bilingualReading';

export const BILINGUAL_READING_CACHE_KEY = 'ec_system_bilingual_reading_catalog_v1';
export const BILINGUAL_READING_SWR_KEY = 'system:bilingual-reading-catalog:v1';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const cardKeys = new Set(['id', 'contentType', 'titleEn', 'titleVi', 'difficultyLevel', 'wordCount', 'estimatedMinutes']);
function exactCard(x: any) {
  return obj(x) && Object.keys(x).every(key => cardKeys.has(key));
}

export function validBilingualCatalog(v: unknown): v is BilingualReadingCatalog {
  return obj(v) && typeof v.catalogRevision === 'string' && /^[a-f0-9]{64}$/.test(v.catalogRevision)
    && Number.isSafeInteger(v.totalElements) && v.totalElements >= 0 && v.totalElements === v.content?.length
    && Number.isSafeInteger(v.articleCount) && v.articleCount >= 0 && Number.isSafeInteger(v.storyCount) && v.storyCount >= 0
    && v.articleCount + v.storyCount === v.totalElements
    && Array.isArray(v.content) && new Set(v.content.map((x: any) => x?.id)).size === v.content.length
    && v.content.every((x: any) => exactCard(x) && Number.isSafeInteger(x.id) && x.id > 0
      && (x.contentType === 'ARTICLE' || x.contentType === 'STORY') && typeof x.titleEn === 'string' && x.titleEn.trim().length > 0
      && (x.titleVi === null || typeof x.titleVi === 'string') && Number.isSafeInteger(x.wordCount) && x.wordCount >= 0
      && Number.isSafeInteger(x.estimatedMinutes) && x.estimatedMinutes >= 1
      && (x.difficultyLevel === null || typeof x.difficultyLevel === 'string'))
    && v.content.filter((x: any) => x.contentType === 'ARTICLE').length === v.articleCount
    && v.content.filter((x: any) => x.contentType === 'STORY').length === v.storyCount;
}

export function readBilingualSnapshot(storage?: Pick<Storage, 'getItem'>, now = Date.now()) {
  try {
    const raw = (storage ?? (typeof window === 'undefined' ? undefined : localStorage))?.getItem(BILINGUAL_READING_CACHE_KEY);
    if (!raw || raw.length > 300000) return undefined;
    const value = JSON.parse(raw);
    if (!obj(value) || value.version !== 1 || !Number.isFinite(value.cachedAt) || value.cachedAt > now || now - value.cachedAt > MAX_AGE || !validBilingualCatalog(value.data)) return undefined;
    return { version: 1, cachedAt: value.cachedAt as number, data: value.data };
  } catch { return undefined; }
}

export function saveBilingualSnapshot(data: unknown, storage?: Pick<Storage, 'setItem'>, now = Date.now()) {
  if (!validBilingualCatalog(data)) return;
  try {
    const raw = JSON.stringify({ version: 1, cachedAt: now, data });
    if (raw.length <= 300000) (storage ?? (typeof window === 'undefined' ? undefined : localStorage))?.setItem(BILINGUAL_READING_CACHE_KEY, raw);
  } catch { /* Storage denial must not block Reading. */ }
}
