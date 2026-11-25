import { currentPreference, accountKey, normalizePreference, writePreference } from '@/lib/wallpaper/storage';
import type { WallpaperPreference } from '@/types/wallpaper';
import { currentSpatial, isSpatialDraft, setSpatialDraft, spatialKey, storedSpatial, writeSpatial, type SpatialPreference } from '@/lib/spatial/preference';

/**
 * Giao diện: exactly ONE appearance system is active at a time (10 §BI). The rooms keep their own stored choices, but what is on screen is decided here and only here:
 * a 3D preset being tried > a Background Studio live preview > a wallpaper or world > a stored Background Studio theme > a stored 3D preset > the original look. Every switch goes through these functions, so a choice that was left stays remembered but dormant,
 * and an inactive system has no canvas, no loop and no decoder. Opening or browsing a room never calls any of them. This file stays small: it is in the main bundle.
 */

export type ActiveAppearance =
  | { mode: 'default' }
  | { mode: 'wallpaper'; selectionId: string }
  | { mode: 'world'; selectionId: string }
  | { mode: 'spatial'; selectionId: string; trying: boolean }
  | { mode: 'background'; selectionId: string; preview?: boolean };

export interface BackgroundAppearanceSelection {
  selectionId: string;
  preview?: boolean;
}

export interface BackgroundAppearanceAdapter {
  resolve: (account: string) => BackgroundAppearanceSelection | null;
  deactivate: (account: string) => void;
  clearPreview: () => void;
}

let bgAdapter: BackgroundAppearanceAdapter | null = null;

/** Zero-import registration hook used by Echo Background Studio's store at module evaluation time. */
export function registerBackgroundAppearanceAdapter(adapter: BackgroundAppearanceAdapter | null): void {
  bgAdapter = adapter;
}

export function resolveAppearance(
  wallpaper: WallpaperPreference,
  spatial: SpatialPreference,
  trying: boolean,
  background?: BackgroundAppearanceSelection | null,
): ActiveAppearance {
  if (trying && spatial.enabled) return { mode: 'spatial', selectionId: spatial.presetId, trying: true };
  if (background?.preview) return { mode: 'background', selectionId: background.selectionId, preview: true };
  if (wallpaper.source === 'world' && wallpaper.worldId) return { mode: 'world', selectionId: wallpaper.worldId };
  if (wallpaper.source !== 'none' && wallpaper.source !== 'world') return { mode: 'wallpaper', selectionId: wallpaper.presetId ?? wallpaper.youtubeId ?? wallpaper.entryId ?? wallpaper.customUrl ?? wallpaper.source };
  if (background) return { mode: 'background', selectionId: background.selectionId };
  if (spatial.enabled) return { mode: 'spatial', selectionId: spatial.presetId, trying: false };
  return { mode: 'default' };
}

/** `userId` of a storage key (`ec_wallpaper:v2:u42`, `ec_spatial:v1:guest`): the account part they share. */
export function accountOfKey(key: string): string {
  const suffix = key.split(':').pop() ?? '';
  return suffix === 'guest' ? '' : suffix.replace(/^u/, '');
}

export function currentAppearance(account: string): ActiveAppearance {
  const key = spatialKey(account);
  const background = bgAdapter ? bgAdapter.resolve(account) : null;
  return resolveAppearance(currentPreference(accountKey(account)), currentSpatial(key), isSpatialDraft(key), background);
}

const dormantMedia = (pref: WallpaperPreference): WallpaperPreference => normalizePreference({ ...pref, source: 'none', worldId: undefined, presetId: undefined, customUrl: undefined, customKind: undefined, entryId: undefined, media: undefined, fileStamp: undefined, youtubeId: undefined });

/** Applies an Echo Background Studio theme: clears any 3D draft, disables stored 3D spatial, and puts media/world wallpaper dormant (remembered, not lost). */
export function applyBackgroundAppearance(account: string): void {
  const key = spatialKey(account);
  setSpatialDraft(key, null);
  const spatial = storedSpatial(key);
  if (spatial.enabled) writeSpatial(key, { ...spatial, enabled: false });
  const wallpaperKey = accountKey(account);
  const wallpaper = currentPreference(wallpaperKey);
  if (wallpaper.source !== 'none') writePreference(wallpaperKey, dormantMedia(wallpaper));
}

/** Applies a 3D preset: the wallpaper, world or background goes dormant (remembered, not lost) after the preset is stored, so the moment of change never has two owners. */
export function applySpatialAppearance(account: string, pref: SpatialPreference): void {
  writeSpatial(spatialKey(account), { ...pref, enabled: true, backdrop: 'keep' });
  const wallpaperKey = accountKey(account);
  const wallpaper = currentPreference(wallpaperKey);
  if (wallpaper.source !== 'none') writePreference(wallpaperKey, dormantMedia(wallpaper));
  bgAdapter?.clearPreview();
  bgAdapter?.deactivate(account);
}

/** A wallpaper or world has proved itself on screen: the 3D preset and background studio go dormant for good. Until this runs the wallpaper already outranks them (see resolveAppearance). */
export function commitMediaAppearance(account: string): void {
  const key = spatialKey(account);
  setSpatialDraft(key, null);
  const spatial = storedSpatial(key);
  if (spatial.enabled) writeSpatial(key, { ...spatial, enabled: false });
  bgAdapter?.clearPreview();
  bgAdapter?.deactivate(account);
}

/** The original look: nothing special is active. */
export function restoreDefaultAppearance(account: string): void {
  const key = spatialKey(account);
  setSpatialDraft(key, null);
  const spatial = storedSpatial(key);
  if (spatial.enabled) writeSpatial(key, { ...spatial, enabled: false });
  const wallpaperKey = accountKey(account);
  const wallpaper = currentPreference(wallpaperKey);
  if (wallpaper.source !== 'none') writePreference(wallpaperKey, dormantMedia(wallpaper));
  bgAdapter?.clearPreview();
  bgAdapter?.deactivate(account);
}

const MIGRATED_PREFIX = 'ec_appearance:v1:';
const reconciled = new Set<string>();

/**
 * Before V2 a wallpaper and a 3D preset could both be stored as on. Once per account the newer system wins: Không gian 3D only exists since 2026-10-31 and is off by default, so a learner with both
 * turned it on after their wallpaper. After that, the only way to find both on is an interrupted apply or another tab: the wallpaper already outranks the preset, so the preset is the stale one.
 */
export function reconcileAppearance(account: string): void {
  if (reconciled.has(account)) return;
  reconciled.add(account);
  const flag = MIGRATED_PREFIX + (account ? `u${account}` : 'guest');
  const spatial = storedSpatial(spatialKey(account));
  const wallpaperKey = accountKey(account);
  const wallpaper = currentPreference(wallpaperKey);
  let migrated = false;
  try {
    migrated = localStorage.getItem(flag) === '1';
    localStorage.setItem(flag, '1');
  } catch {
    // Storage denied: nothing was stored either, so there is nothing to migrate.
    return;
  }
  if (!spatial.enabled || wallpaper.source === 'none') return;
  if (migrated) writeSpatial(spatialKey(account), { ...spatial, enabled: false });
  else writePreference(wallpaperKey, dormantMedia(wallpaper));
}

export function appearanceLabel(active: ActiveAppearance, vi: boolean): string {
  if (active.mode === 'wallpaper') return vi ? 'Hình nền' : 'Wallpaper';
  if (active.mode === 'world') return vi ? 'Thế giới sống' : 'Living world';
  if (active.mode === 'spatial') return vi ? 'Không gian 3D' : '3D space';
  if (active.mode === 'background') return 'Background';
  return vi ? 'Giao diện thường' : 'Normal look';
}
