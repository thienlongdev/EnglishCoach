import type { ReadingMaterial } from '../components/features/reading/ReadingCard';
export const READING_SYSTEM_CACHE_KEY = 'ec_system_reading_catalog_v1';
export const READING_SYSTEM_SWR_KEY = 'system:reading-catalog:v1';
export interface ReadingCatalog { catalogRevision: string; totalElements: number; page: number; size: number; totalPages: number; topics: string[]; content: ReadingMaterial[] }
const obj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const only = (x: Record<string, any>, keys: string[]) => Object.keys(x).every(k => keys.includes(k));
const count = (x: unknown) => Number.isSafeInteger(x) && Number(x) >= 0;
export function validReadingSnapshot(x: unknown): x is ReadingCatalog {
  return obj(x) && only(x, ['catalogRevision','totalElements','page','size','totalPages','topics','content'])
    && typeof x.catalogRevision === 'string' && /^[a-f0-9]{64}$/.test(x.catalogRevision)
    && count(x.totalElements) && x.page === 0 && x.size === 18 && count(x.totalPages)
    && x.totalPages === Math.ceil(x.totalElements / 18) && Array.isArray(x.topics) && x.topics.length <= 50
    && x.topics.every((t: unknown) => typeof t === 'string' && t.length <= 80)
    && Array.isArray(x.content) && x.content.length === Math.min(18, x.totalElements)
    && new Set(x.content.map((c: any) => c?.id)).size === x.content.length
    && x.content.every((c: unknown) => obj(c) && only(c, ['id','title','sourceUrl','sourceName','materialType','wordCount','difficultyLevel','isSystem','topic','readMinutes','description','licenseCode','attribution'])
      && count(c.id) && c.id > 0 && c.isSystem === true && count(c.wordCount) && count(c.readMinutes)
      && ['title','materialType','topic','description','licenseCode','attribution'].every(k => typeof c[k] === 'string' && c[k].length <= 2000)
      && ['sourceUrl','sourceName','difficultyLevel'].every(k => c[k] === null || (typeof c[k] === 'string' && c[k].length <= 1000)));
}
export function readReadingSnapshot(storage?: Pick<Storage, 'getItem'>, now = Date.now()) {
  try {
    const raw = (storage ?? (typeof window === 'undefined' ? undefined : localStorage))?.getItem(READING_SYSTEM_CACHE_KEY);
    if (!raw || raw.length > 100000) return;
    const x = JSON.parse(raw);
    if (!obj(x) || !only(x, ['version','cachedAt','data']) || x.version !== 1 || !Number.isFinite(x.cachedAt)
      || x.cachedAt > now || now - x.cachedAt > 7 * 86400000 || !validReadingSnapshot(x.data)) return;
    return { version: 1, cachedAt: x.cachedAt as number, data: x.data };
  } catch { return; }
}
export function saveReadingSnapshot(data: unknown) {
  if (!validReadingSnapshot(data)) return;
  try { const raw = JSON.stringify({ version: 1, cachedAt: Date.now(), data }); if (raw.length <= 100000 && typeof window !== 'undefined') localStorage.setItem(READING_SYSTEM_CACHE_KEY, raw); } catch {}
}
