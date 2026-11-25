/**
 * User-Scoped Persistent Cache Engine for Listening.
 * 
 * Invariants:
 * 1. Strictly user-scoped by authenticated user identity (id or email).
 * 2. Survives F5, hard reloads, and tab closure across sessions.
 * 3. Never caches secrets, auth tokens, or cross-user private data.
 * 4. Cleared on logout / account switch via clearUserScopedCaches().
 * 5. Provides instant synchronous hydration to eliminate cold-load blank spinners.
 */

import type { ListeningCategory, ListeningMaterialSummary, ListeningMaterialDetail, ErrorDNADto } from '@/types/listening';

const ACTIVE_USER_KEY = 'ec_listening_active_user';
const CACHE_PREFIX = 'ec_list_v1';

// Safe localStorage access wrapper
function safeGetItem(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.warn('[ListeningCache] Storage quota exceeded or disabled', e);
  }
}

function safeRemoveItem(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch {}
}

export function saveActiveListeningUser(userScope: string | number | null | undefined): void {
  if (!userScope) {
    safeRemoveItem(ACTIVE_USER_KEY);
    return;
  }
  safeSetItem(ACTIVE_USER_KEY, String(userScope));
}

export function getActiveListeningUser(): string | null {
  return safeGetItem(ACTIVE_USER_KEY);
}

function buildCacheKey(userScope: string | number, subKey: string): string {
  return `${CACHE_PREFIX}_u${userScope}_${subKey}`;
}

// ─── 1. System Categories Cache ─────────────────────────────────────────────

export function getCachedListeningCategories(userScope: string | number): ListeningCategory[] | undefined {
  const raw = safeGetItem(buildCacheKey(userScope, 'categories'));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.data) && parsed.data.length > 0) {
      return parsed.data as ListeningCategory[];
    }
  } catch {}
  return undefined;
}

export function saveCachedListeningCategories(userScope: string | number, categories: ListeningCategory[]): void {
  if (!userScope || !Array.isArray(categories) || categories.length === 0) return;
  safeSetItem(
    buildCacheKey(userScope, 'categories'),
    JSON.stringify({ timestamp: Date.now(), data: categories })
  );
  saveActiveListeningUser(userScope);
}

// ─── 2. Personal Materials Cache ────────────────────────────────────────────

function hashPath(path: string): string {
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    hash = (hash << 5) - hash + path.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export function getCachedPersonalListening(
  userScope: string | number,
  path: string
): ListeningMaterialSummary[] | undefined {
  const key = buildCacheKey(userScope, `personal_${hashPath(path)}`);
  const raw = safeGetItem(key);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.data)) {
      return parsed.data as ListeningMaterialSummary[];
    }
  } catch {}
  return undefined;
}

export function saveCachedPersonalListening(
  userScope: string | number,
  path: string,
  materials: ListeningMaterialSummary[]
): void {
  if (!userScope || !Array.isArray(materials)) return;
  const key = buildCacheKey(userScope, `personal_${hashPath(path)}`);
  safeSetItem(
    key,
    JSON.stringify({ timestamp: Date.now(), data: materials })
  );
  saveActiveListeningUser(userScope);
}

/** Updates personal cache upon new import (newest first). */
export function addPersonalListeningMaterial(
  userScope: string | number,
  newItem: ListeningMaterialSummary
): void {
  if (typeof window === 'undefined' || !userScope || !newItem) return;
  try {
    // Iterate all personal keys for this user and prepend if not already present
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(`${CACHE_PREFIX}_u${userScope}_personal_`)) {
        const raw = localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed?.data)) {
            const exists = parsed.data.some((m: ListeningMaterialSummary) => m.id === newItem.id);
            if (!exists) {
              parsed.data = [newItem, ...parsed.data];
              localStorage.setItem(key, JSON.stringify(parsed));
            }
          }
        }
      }
    }
  } catch {}
}

/** Removes personal material from cache upon deletion. */
export function removePersonalListeningMaterial(
  userScope: string | number,
  id: number
): void {
  if (typeof window === 'undefined' || !userScope || !id) return;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(`${CACHE_PREFIX}_u${userScope}_personal_`)) {
        const raw = localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed?.data)) {
            parsed.data = parsed.data.filter((m: ListeningMaterialSummary) => m.id !== id);
            localStorage.setItem(key, JSON.stringify(parsed));
          }
        }
      }
    }
  } catch {}
}

// ─── 3. Material Detail Cache ───────────────────────────────────────────────

export function getCachedListeningDetail(
  userScope: string | number,
  id: number
): ListeningMaterialDetail | undefined {
  const raw = safeGetItem(buildCacheKey(userScope, `mat_${id}`));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.data && parsed.data.id === id) {
      return parsed.data as ListeningMaterialDetail;
    }
  } catch {}
  return undefined;
}

export function saveCachedListeningDetail(
  userScope: string | number,
  id: number,
  detail: ListeningMaterialDetail
): void {
  if (!userScope || !detail || detail.id !== id) return;
  safeSetItem(
    buildCacheKey(userScope, `mat_${id}`),
    JSON.stringify({ timestamp: Date.now(), data: detail })
  );
}

// ─── 4. DNA Analytics Cache ─────────────────────────────────────────────────

export function getCachedListeningDNA(userScope: string | number): ErrorDNADto | undefined {
  const raw = safeGetItem(buildCacheKey(userScope, 'dna'));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.data) {
      return parsed.data as ErrorDNADto;
    }
  } catch {}
  return undefined;
}

export function saveCachedListeningDNA(userScope: string | number, dna: ErrorDNADto): void {
  if (!userScope || !dna) return;
  safeSetItem(
    buildCacheKey(userScope, 'dna'),
    JSON.stringify({ timestamp: Date.now(), data: dna })
  );
}

// ─── 5. Cache Invalidation & Logout Purge ───────────────────────────────────

export function clearListeningUserCache(targetUserScope?: string | number): void {
  if (typeof window === 'undefined') return;
  try {
    safeRemoveItem(ACTIVE_USER_KEY);
    const keysToRemove: string[] = [];
    const prefix = targetUserScope ? `${CACHE_PREFIX}_u${targetUserScope}_` : CACHE_PREFIX;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  } catch {}
}
