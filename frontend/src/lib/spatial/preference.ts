/**
 * Không gian 3D (Echo Spatial) — the learner's choice. Default OFF: a learner who never opens the room loads none of the
 * graphics code. Browser-local, one entry per account (same rule as the wallpaper preference, cleared at sign-out with the
 * rest of local storage), no server copy, no request. This file stays tiny: it is the only part of the feature in the
 * main bundle (the sidebar shell reads it). Presets, scenes and the engine are lazy chunks.
 */

import { scopedPreference, subscribeAppearanceScope, writeScopedPreference } from '@/lib/appearance/scope';

export type SpatialQuality = 'auto' | 'high' | 'balanced' | 'low';
export type SpatialFocus = 'auto' | 'on' | 'off';
/** keep = the learner's wallpaper or Living World stays the background; spatial = the preset's own scene replaces it for now. */
export type SpatialBackdrop = 'keep' | 'spatial';

export interface SpatialPreference {
  version: 1;
  enabled: boolean;
  presetId: string;
  quality: SpatialQuality;
  /** All 0…1, read live. */
  motion: number;
  pointer: number;
  depth: number;
  material: number;
  focus: SpatialFocus;
  backdrop: SpatialBackdrop;
}

export const DEFAULT_SPATIAL: SpatialPreference = {
  version: 1,
  enabled: false,
  presetId: 'echo-immersive-signature',
  quality: 'auto',
  motion: 0.6,
  pointer: 0.8,
  depth: 0.6,
  material: 0.6,
  focus: 'auto',
  backdrop: 'keep',
};

const PREFIX = 'ec_spatial:v1:';

export function spatialKey(userId: string | number | null | undefined): string {
  const id = String(userId ?? '').replace(/[^\w-]/g, '');
  return PREFIX + (id ? `u${id}` : 'guest');
}

const unit = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback);

export function normalizeSpatial(raw: unknown): SpatialPreference {
  if (!raw || typeof raw !== 'object') return DEFAULT_SPATIAL;
  const value = raw as Partial<SpatialPreference>;
  return {
    version: 1,
    enabled: value.enabled === true,
    presetId: typeof value.presetId === 'string' && /^[a-z0-9-]{2,48}$/.test(value.presetId) ? value.presetId : DEFAULT_SPATIAL.presetId,
    quality: value.quality === 'high' || value.quality === 'balanced' || value.quality === 'low' ? value.quality : 'auto',
    motion: unit(value.motion, DEFAULT_SPATIAL.motion),
    pointer: unit(value.pointer, DEFAULT_SPATIAL.pointer),
    depth: unit(value.depth, DEFAULT_SPATIAL.depth),
    material: unit(value.material, DEFAULT_SPATIAL.material),
    focus: value.focus === 'on' || value.focus === 'off' ? value.focus : 'auto',
    backdrop: value.backdrop === 'spatial' ? 'spatial' : 'keep',
  };
}

type Listener = () => void;
const listeners = new Set<Listener>();
const memory = new Map<string, SpatialPreference>();
/** "Thử trên trang": a preset tried on the real pages. In memory only, a reload forgets it. */
let draft: { key: string; pref: SpatialPreference } | null = null;

function read(key: string): SpatialPreference {
  try {
    const raw = localStorage.getItem(key);
    return raw ? normalizeSpatial(JSON.parse(raw)) : DEFAULT_SPATIAL;
  } catch {
    return DEFAULT_SPATIAL;
  }
}

export function storedSpatial(key: string): SpatialPreference {
  const scoped = scopedPreference<SpatialPreference>(key);
  if (scoped) return scoped;
  let value = memory.get(key);
  if (!value) {
    value = read(key);
    memory.set(key, value);
  }
  return value;
}

/** What the engine shows right now: the draft being tried, else the stored choice. */
export function currentSpatial(key: string): SpatialPreference {
  return draft && draft.key === key ? draft.pref : storedSpatial(key);
}

export function writeSpatial(key: string, pref: SpatialPreference): void {
  const next = normalizeSpatial(pref);
  draft = null;
  if (writeScopedPreference(key, next)) return;
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Storage denied (private window, quota): the choice still applies for this page view.
  }
  memory.set(key, next);
  draft = null;
  listeners.forEach((listener) => listener());
}

export function setSpatialDraft(key: string, pref: SpatialPreference | null): void {
  draft = pref ? { key, pref: normalizeSpatial(pref) } : null;
  listeners.forEach((listener) => listener());
}

export function isSpatialDraft(key: string): boolean {
  return !!draft && draft.key === key;
}

export function subscribeSpatial(key: string, listener: Listener): () => void {
  const unsubscribeScope = subscribeAppearanceScope(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) {
      memory.delete(key);
      listener();
    }
  };
  listeners.add(listener);
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    unsubscribeScope();
    window.removeEventListener('storage', onStorage);
  };
}

// ─── What the background engine needs to know ───────────────────────────────────────────────────────────────
let ownsBackdrop = false;
const backdropListeners = new Set<Listener>();

/** True while a preset's scene is the background by the learner's explicit choice: the wallpaper rests (never overwritten). */
export function setSpatialOwnsBackdrop(next: boolean): void {
  if (ownsBackdrop === next) return;
  ownsBackdrop = next;
  backdropListeners.forEach((listener) => listener());
}

export function spatialOwnsBackdrop(): boolean {
  return ownsBackdrop;
}

export function subscribeSpatialBackdrop(listener: Listener): () => void {
  backdropListeners.add(listener);
  return () => backdropListeners.delete(listener);
}

/** Surfaces turn transparent while EITHER engine shows a background; each only removes its own mark. */
export const SPATIAL_SURFACE_MARK = 'spatial';
