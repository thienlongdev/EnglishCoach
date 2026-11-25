import { wallpaperLibraryApi, type WallpaperBackgroundInput } from '@/services/wallpaperLibraryApi';
import type { WallpaperLibraryEntry } from '@/types/wallpaper';
import { isYouTubeId } from './media';
import { clearLegacySavedYouTube, readLegacySavedYouTube } from './youtubeSaved';

/**
 * Hình nền — "Video YouTube của tôi", kept with the account (server-authoritative; the list is the server's answer).
 * This module only holds the CURRENT account's last answer in memory, tagged with that account's key, so a list is
 * never shown to another account; `clearWallpaperLibrary()` (sign-out) drops it. Nothing is written to browser storage.
 * On the first load for an account, that account's former device-only list is moved into the account once, and the
 * device copy is removed only after the server answered.
 */
export type LibraryStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface LibraryState {
  /** Account preference key the state belongs to (`ec_wallpaper:v2:u<id>`); null = nothing loaded. */
  owner: string | null;
  status: LibraryStatus;
  items: WallpaperLibraryEntry[];
  limit: number;
  /** Ids moved from this device's former list on this load, and ids that did not fit. */
  moved?: { imported: number; overLimit: number };
}

const EMPTY: LibraryState = { owner: null, status: 'idle', items: [], limit: 50 };
let state: LibraryState = EMPTY;
let generation = 0;
const listeners = new Set<() => void>();

function set(next: LibraryState) {
  state = next;
  listeners.forEach((listener) => listener());
}

export function subscribeLibrary(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable snapshot for useSyncExternalStore (read it through `libraryFor` / an owner check). */
export function getLibraryState(): LibraryState {
  return state;
}

/** The state of `owner` only: another account's list is never returned. */
export function libraryFor(owner: string): LibraryState {
  return state.owner === owner ? state : { ...EMPTY, owner };
}

/** Sign-out / account switch: forget the list held in memory (the account keeps it on the server). */
export function clearWallpaperLibrary(): void {
  generation += 1;
  set(EMPTY);
}

function isAccount(owner: string): boolean {
  return /^ec_wallpaper:v2:u[\w-]+$/.test(owner);
}

/** Loads the account's list (and moves its former device list once). Answers for another account are discarded. */
export async function loadLibrary(owner: string): Promise<void> {
  if (!isAccount(owner)) return;
  const run = ++generation;
  set({ ...libraryFor(owner), owner, status: state.owner === owner && state.status === 'ready' ? 'ready' : 'loading' });
  try {
    let { items, limit } = await wallpaperLibraryApi.list();
    let moved: LibraryState['moved'];
    const legacy = readLegacySavedYouTube(owner).map((entry) => entry.id).filter(isYouTubeId);
    if (legacy.length) {
      const result = await wallpaperLibraryApi.importDeviceList(legacy);
      clearLegacySavedYouTube(owner);
      items = result.items;
      limit = result.limit;
      moved = { imported: result.imported, overLimit: result.overLimit };
    }
    if (run !== generation) return;
    set({ owner, status: 'ready', items, limit, moved });
  } catch {
    if (run !== generation) return;
    set({ ...libraryFor(owner), owner, status: 'error' });
  }
}

function replaceItems(owner: string, items: WallpaperLibraryEntry[]) {
  if (state.owner !== owner) return;
  set({ ...state, status: 'ready', items });
}

export async function saveToLibrary(owner: string, videoId: string): Promise<WallpaperLibraryEntry> {
  const { entry } = await wallpaperLibraryApi.save(videoId);
  const current = libraryFor(owner).items.filter((item) => item.id !== entry.id);
  replaceItems(owner, [entry, ...current]);
  return entry;
}

export async function removeFromLibrary(owner: string, entryId: string): Promise<void> {
  await wallpaperLibraryApi.remove(entryId);
  replaceItems(owner, libraryFor(owner).items.filter((item) => item.id !== entryId));
}

export async function setLibraryBackground(owner: string, entryId: string, input: WallpaperBackgroundInput): Promise<WallpaperLibraryEntry> {
  const entry = await wallpaperLibraryApi.setBackground(entryId, input);
  replaceItems(owner, libraryFor(owner).items.map((item) => (item.id === entry.id ? entry : item)));
  return entry;
}

/** The HTTP status of a failed library call (0 = no answer). */
export function libraryErrorStatus(error: unknown): number {
  return (error as { response?: { status?: number } })?.response?.status ?? 0;
}

/** The stable error code the server sent, if any. */
export function libraryErrorCode(error: unknown): string | null {
  const code = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return typeof code === 'string' ? code : null;
}
