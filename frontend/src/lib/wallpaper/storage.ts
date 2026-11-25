import type { WallpaperPreference, WallpaperStatus } from '@/types/wallpaper';
import { scopedPreference, subscribeAppearanceScope, writeScopedPreference } from '@/lib/appearance/scope';
import { findPreset } from './catalog';
import { checkCustomLink, isYouTubeId } from './media';
import { isWorldId } from './worlds/catalog';

/**
 * Hình nền — device-local preference, one entry per signed-in account (`ec_wallpaper:v2:u<id>`, guests share
 * `…:guest`), so a shared browser never shows one learner's wallpaper to another. No server copy, no AI, no request.
 * Sign-out clears local storage as before (clearUserScopedCaches); the preference is then simply the default again.
 */
const PREFIX = 'ec_wallpaper:v2:';
/** The first release's key (2026-10-18); its presets no longer exist, so it is dropped on first read. */
const LEGACY_KEY = 'ec_live_wallpaper_preference';

export const DEFAULT_PREFERENCE: WallpaperPreference = {
  version: 2,
  source: 'none',
  clarity: 0.6,
  motion: 'live',
  quality: 'auto',
};

export function accountKey(userId: string | number | null | undefined): string {
  const id = String(userId ?? '').replace(/[^\w-]/g, '');
  return PREFIX + (id ? `u${id}` : 'guest');
}

function clamp01(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

/** Anything stored is re-validated: an unknown preset or a link that no longer passes the rules means "default". */
export function normalizePreference(raw: unknown): WallpaperPreference {
  if (!raw || typeof raw !== 'object') return DEFAULT_PREFERENCE;
  const value = raw as Partial<WallpaperPreference>;
  const base: WallpaperPreference = {
    version: 2,
    source: 'none',
    clarity: clamp01(value.clarity, DEFAULT_PREFERENCE.clarity),
    motion: value.motion === 'still' ? 'still' : 'live',
    quality: value.quality === 'saver' || value.quality === 'max' ? value.quality : 'auto',
  };
  // Living World tuning and memory survive a change of source; each field only exists when it was really set.
  if (typeof value.worldMotion === 'number') base.worldMotion = clamp01(value.worldMotion, 0.6);
  if (typeof value.worldPointer === 'number') base.worldPointer = clamp01(value.worldPointer, 0.8);
  if (value.worldInteractive === false) base.worldInteractive = false;
  if (value.worldFocus === 'on' || value.worldFocus === 'off') base.worldFocus = value.worldFocus;
  if (value.glass === 'neutral' || value.glass === 'ocean' || value.glass === 'dusk' || value.glass === 'forest') base.glass = value.glass;
  if (isWorldId(value.lastWorldId)) base.lastWorldId = value.lastWorldId;
  if (value.lastMedia && typeof value.lastMedia === 'object' && value.lastMedia.source !== 'world') {
    const restored = normalizePreference({ ...value.lastMedia, lastMedia: undefined });
    if (restored.source !== 'none' && restored.source !== 'world') base.lastMedia = mediaOf(restored);
  }
  if (value.source === 'world' && isWorldId(value.worldId)) {
    return { ...base, source: 'world', worldId: value.worldId };
  }
  if (value.source === 'preset' && findPreset(value.presetId)) {
    return { ...base, source: 'preset', presetId: value.presetId };
  }
  if (value.source === 'custom' && typeof value.customUrl === 'string') {
    const check = checkCustomLink(value.customUrl);
    if (check.ok && (value.customKind === 'video' || value.customKind === 'image')) {
      return { ...base, source: 'custom', customUrl: check.url, customKind: value.customKind };
    }
  }
  // YouTube's own player behind the workspace: only the validated 11-character id is kept (never a URL).
  if (value.source === 'youtube' && isYouTubeId(value.youtubeId)) {
    return { ...base, source: 'youtube', youtubeId: value.youtubeId };
  }
  // The learner's own video attached to an entry of their saved-video list: a proven direct video link (which the link
  // rules refuse for the video platform's own hosts), or a file kept in this browser (played from IndexedDB).
  if (value.source === 'library' && typeof value.entryId === 'string' && ENTRY_ID.test(value.entryId)) {
    if (value.media === 'file') {
      const stamp = typeof value.fileStamp === 'number' && Number.isFinite(value.fileStamp) ? Math.max(0, Math.floor(value.fileStamp)) : 0;
      return { ...base, source: 'library', entryId: value.entryId, media: 'file', fileStamp: stamp };
    }
    if (value.media === 'link' && typeof value.customUrl === 'string') {
      const check = checkCustomLink(value.customUrl);
      if (check.ok) return { ...base, source: 'library', entryId: value.entryId, media: 'link', customUrl: check.url, customKind: 'video' };
    }
  }
  return base;
}

/** The part of a preference that says which wallpaper is on (for "back to my wallpaper"). */
export function mediaOf(pref: WallpaperPreference): NonNullable<WallpaperPreference['lastMedia']> {
  const { source, presetId, customUrl, customKind, entryId, media, fileStamp, youtubeId } = pref;
  return JSON.parse(JSON.stringify({ source, presetId, customUrl, customKind, entryId, media, fileStamp, youtubeId }));
}

/** Server ids of saved entries (UUID). */
const ENTRY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readPreference(key: string): WallpaperPreference {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCE;
  try {
    localStorage.removeItem(LEGACY_KEY);
    const raw = localStorage.getItem(key);
    return raw ? normalizePreference(JSON.parse(raw)) : DEFAULT_PREFERENCE;
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

type Listener = () => void;
const preferenceListeners = new Set<Listener>();
/** Last written value per key, so a denied storage still keeps the choice until reload. */
const memory = new Map<string, WallpaperPreference>();

export function writePreference(key: string, pref: WallpaperPreference): void {
  // Moving between a wallpaper and a world remembers what was left, so neither choice is lost.
  const previous = currentPreference(key);
  const next = normalizePreference(pref);
  if ((next.source === 'world' || next.source === 'none') && previous.source !== 'world' && previous.source !== 'none') next.lastMedia = mediaOf(previous);
  if (next.source !== 'world' && previous.source === 'world' && previous.worldId) next.lastWorldId = previous.worldId;
  if (next.source === 'world' && next.worldId) next.lastWorldId = next.worldId;
  if (writeScopedPreference(key, next)) return;
  try {
    if (JSON.stringify(next) === JSON.stringify(DEFAULT_PREFERENCE)) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(next));
    }
  } catch {
    // Storage denied (private window, quota): the choice still applies for this page view.
  }
  memory.set(key, next);
  preferenceListeners.forEach((listener) => listener());
}

/** Stable snapshot for useSyncExternalStore: read once per key, then from memory until the next change. */
export function currentPreference(key: string): WallpaperPreference {
  const scoped = scopedPreference<WallpaperPreference>(key);
  if (scoped) return scoped;
  let value = memory.get(key);
  if (!value) {
    value = readPreference(key);
    memory.set(key, value);
  }
  return value;
}

/** Changes from this tab (write) and from other tabs (`storage` event). */
export function subscribePreference(key: string, listener: Listener): () => void {
  const unsubscribeScope = subscribeAppearanceScope(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) {
      memory.delete(key);
      listener();
    }
  };
  preferenceListeners.add(listener);
  window.addEventListener('storage', onStorage);
  return () => {
    preferenceListeners.delete(listener);
    unsubscribeScope();
    window.removeEventListener('storage', onStorage);
  };
}

/** Identity of what a preference shows (clarity / quality changes keep the same identity). */
export function sourceKey(pref: WallpaperPreference): string | null {
  if (pref.source === 'preset' && pref.presetId) return `preset:${pref.presetId}`;
  if (pref.source === 'custom' && pref.customUrl) return `custom:${pref.customUrl}`;
  if (pref.source === 'youtube' && pref.youtubeId) return `youtube:${pref.youtubeId}`;
  if (pref.source === 'world' && pref.worldId) return `world:${pref.worldId}`;
  if (pref.source === 'library' && pref.entryId) {
    return pref.media === 'file' ? `library:${pref.entryId}:file:${pref.fileStamp ?? 0}` : pref.customUrl ? `library:${pref.entryId}:link:${pref.customUrl}` : null;
  }
  return null;
}

// ─── Engine status (one background engine; the studio and the sidebar read it) ──────────────────────────────
let status: WallpaperStatus = { state: 'idle', key: null };
const statusListeners = new Set<Listener>();

export function getWallpaperStatus(): WallpaperStatus {
  return status;
}

export function setWallpaperStatus(next: WallpaperStatus): void {
  status = next;
  statusListeners.forEach((listener) => listener());
}

export function subscribeWallpaperStatus(listener: Listener): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

// ─── Studio open / background hold ──────────────────────────────────────────────────────────────────────────
export const OPEN_STUDIO_EVENT = 'ec:wallpaper-studio';

/** Opens the Hình nền studio (optionally directly on a room such as 'navigation'). */
export function openWallpaperStudio(room?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_STUDIO_EVENT, room ? { detail: { room } } : undefined));
}

let held = false;
const holdListeners = new Set<Listener>();

/** While the studio is open its preview is the one playing video: the background pauses (one decoder). */
export function setBackgroundHeld(next: boolean): void {
  if (held === next) return;
  held = next;
  holdListeners.forEach((listener) => listener());
}

export function isBackgroundHeld(): boolean {
  return held;
}

export function subscribeHold(listener: Listener): () => void {
  holdListeners.add(listener);
  return () => holdListeners.delete(listener);
}
