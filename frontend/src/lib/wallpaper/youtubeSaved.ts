import { isYouTubeId } from './media';

/**
 * Hình nền — the FORMER device-only "Video YouTube của tôi" list (2026-10-19, frontend `bda0f11d…`), kept only so the
 * signed-in learner's still-existing entries can be moved into their account once (youtubeLibrary.ts). Nothing writes
 * this list any more. Key: `<account preference key>:youtube`; only the CURRENT account's key is ever read, so a
 * guest's or another account's list never enters an account. Ids are re-validated on read.
 */
export interface SavedYouTube {
  id: string;
  savedAt: number;
}

export const MAX_SAVED_YOUTUBE = 12;

export function savedYouTubeKey(preferenceKey: string): string {
  return `${preferenceKey}:youtube`;
}

/** Anything stored is re-validated: unknown shapes, bad ids and duplicates are dropped, newest first, capped. */
export function normalizeSavedYouTube(raw: unknown): SavedYouTube[] {
  const items = raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : [];
  const seen = new Set<string>();
  const out: SavedYouTube[] = [];
  for (const item of items) {
    const id = (item as { id?: unknown })?.id;
    const savedAt = (item as { savedAt?: unknown })?.savedAt;
    if (!isYouTubeId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, savedAt: typeof savedAt === 'number' && Number.isFinite(savedAt) ? savedAt : 0 });
  }
  return out.sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_SAVED_YOUTUBE);
}

/** The former list of this account on this device (empty for guests: a guest list never moves into an account). */
export function readLegacySavedYouTube(preferenceKey: string): SavedYouTube[] {
  if (typeof window === 'undefined' || preferenceKey.endsWith(':guest')) return [];
  try {
    const raw = localStorage.getItem(savedYouTubeKey(preferenceKey));
    return raw ? normalizeSavedYouTube(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** Removed only after the server confirmed it holds every id (or refused them for good). */
export function clearLegacySavedYouTube(preferenceKey: string): void {
  try {
    localStorage.removeItem(savedYouTubeKey(preferenceKey));
  } catch {
    // Storage denied: nothing was kept anyway.
  }
}
