import type { ListeningCategory } from '../types/listening';

/** SYSTEM only. Never promote the old account-scoped snapshot into this namespace. */
export const LISTENING_SYSTEM_CACHE_KEY = 'ec_system_listening_categories_v2';
export const LISTENING_SYSTEM_SWR_KEY = 'system:listening-categories:v2';
export const SYSTEM_FRESH_MS = 60 * 60 * 1000;
export const SYSTEM_MAX_AGE_MS = 7 * 24 * SYSTEM_FRESH_MS;
const categoryFields = ['topic', 'count', 'items'];
const itemFields = ['id', 'title', 'channel', 'topic', 'level', 'accent', 'durationSeconds', 'thumbnail', 'youtubeVideoId', 'hasTranscript', 'practiceAvailable'];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v: Record<string, unknown>, fields: string[]) => Object.keys(v).every(k => fields.includes(k));

export function validSystemCategories(value: unknown): value is ListeningCategory[] {
  return Array.isArray(value) && value.every(c => object(c) && only(c, categoryFields)
    && typeof c.topic === 'string' && Number.isInteger(c.count) && Array.isArray(c.items)
    && c.count === c.items.length && c.items.every((i: unknown) => object(i) && only(i, itemFields)
      && Number.isSafeInteger(i.id) && Number(i.id) > 0
      && ['title', 'channel', 'topic', 'level', 'accent'].every(k => typeof i[k] === 'string')
      && ['thumbnail', 'youtubeVideoId'].every(k => i[k] == null || typeof i[k] === 'string')
      && (i.durationSeconds == null || (typeof i.durationSeconds === 'number' && Number.isFinite(i.durationSeconds)))
      && typeof i.hasTranscript === 'boolean' && typeof i.practiceAvailable === 'boolean'));
}

export function readSystemListeningSnapshot(storage?: Pick<Storage, 'getItem'>, now = Date.now()) {
  try {
    const target = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
    const raw = target?.getItem(LISTENING_SYSTEM_CACHE_KEY);
    if (!raw) return undefined;
    const envelope = JSON.parse(raw);
    if (!object(envelope) || !only(envelope, ['version', 'cachedAt', 'data']) || envelope.version !== 2
      || typeof envelope.cachedAt !== 'number' || !Number.isFinite(envelope.cachedAt)
      || envelope.cachedAt > now || now - envelope.cachedAt > SYSTEM_MAX_AGE_MS
      || !validSystemCategories(envelope.data)) return undefined;
    return { data: envelope.data, cachedAt: envelope.cachedAt, stale: now - envelope.cachedAt >= SYSTEM_FRESH_MS };
  } catch { return undefined; }
}

export function saveSystemListeningSnapshot(data: unknown, storage?: Pick<Storage, 'setItem'>, now = Date.now()) {
  if (!validSystemCategories(data)) return;
  try {
    const target = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
    target?.setItem(LISTENING_SYSTEM_CACHE_KEY, JSON.stringify({ version: 2, cachedAt: now, data }));
  } catch { /* Storage denial/quota never prevents network-backed use. */ }
}

/** Explicit allowlist preservation; unknown/private keys still undergo broad logout cleanup. */
export function preserveSystemListeningSnapshot() {
  const snapshot = readSystemListeningSnapshot();
  return snapshot ? JSON.stringify({ version: 2, cachedAt: snapshot.cachedAt, data: snapshot.data }) : undefined;
}
