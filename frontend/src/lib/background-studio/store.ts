/**
 * Echo Background Studio — reactive account-scoped preferences store, cross-tab
 * storage cache, debounced server persistence, live workspace preview state,
 * Study Space occlusion signal, and appearance mutual-exclusion adapter.
 *
 * All persisted payloads are defensively sanitized against `BG_BOUNDS` and
 * schema invariants matching backend `BackgroundPreferenceValidator` 1-to-1.
 */

import {
  BG_STUDIO_SCHEMA_VERSION,
  MAX_CUSTOM_THEMES,
  MAX_FAVORITE_PRESETS,
  MAX_THEME_NAME_LENGTH,
  THEME_ID_PATTERN,
  createEmptyPreferencesState,
  isBackgroundActiveSource,
  type BackgroundPreferencesState,
  type BackgroundThemeConfig,
  type SavedBackgroundTheme,
} from '@/lib/background-studio/types';
import { cloneThemeConfig, sanitizeThemeConfig } from '@/lib/background-studio/colorScience';
import {
  DEFAULT_STUDIO_CONFIG,
  findBackgroundPreset,
  isBackgroundPresetId,
} from '@/lib/background-studio/presets';
import {
  applyBackgroundAppearance,
  registerBackgroundAppearanceAdapter,
  restoreDefaultAppearance,
} from '@/lib/appearance/state';
import { scopedPreference, subscribeAppearanceScope } from '@/lib/appearance/scope';
import { accountKey, currentPreference } from '@/lib/wallpaper/storage';
import { spatialKey, storedSpatial } from '@/lib/spatial/preference';
import { registerUserScopedCleanup } from '@/lib/auth-cache-cleanup';
import { backgroundThemeApi } from '@/services/backgroundThemeApi';

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export type BackgroundStudioTab = 'presets' | 'color' | 'motion' | 'themes';

export interface BackgroundDraftSnapshot {
  config: BackgroundThemeConfig;
  activeTab: BackgroundStudioTab;
  selectedPresetId: string | null;
  editingThemeId: string | null;
  themeNameDraft: string;
}

export interface LiveWorkspacePreviewState {
  account: string;
  config: BackgroundThemeConfig;
  themeName: string;
  source: 'preset' | 'custom';
  themeId: string;
  hasUnsavedChanges: boolean;
  minimizedToWorkspace: boolean;
  draftSnapshot?: BackgroundDraftSnapshot;
}

export interface BgSyncStatus {
  state: 'idle' | 'saving' | 'saved' | 'error';
  message?: string;
}

export interface ResolvedActiveBackground {
  config: BackgroundThemeConfig;
  themeId: string;
  themeName: string;
  source: 'preset' | 'custom';
  isPreview: boolean;
}

export interface SaveCustomThemeInput {
  id?: string | null;
  name: string;
  config: BackgroundThemeConfig;
  basedOnPresetId?: string | null;
  favorite?: boolean;
  activate?: boolean;
}

export type BgThemeMutationError = 'INVALID_NAME' | 'THEME_LIMIT' | 'NOT_FOUND';

export type BgThemeMutationResult =
  | { ok: true; theme: SavedBackgroundTheme }
  | { ok: false; error: BgThemeMutationError; message: string };

// ---------------------------------------------------------------------------
// Constants & Frozen Defaults
// ---------------------------------------------------------------------------

export const BG_STORAGE_PREFIX = 'ec_bg_studio:v1:';
const DEBOUNCE_SAVE_MS = 350;
const MIN_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_TIMESTAMP_MS = Date.UTC(2100, 0, 1);

/** Matches ASCII control characters and Unicode bidi/invisible control characters. */
const CONTROL_AND_BIDI_RE = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Immutable empty state snapshot safe for `useSyncExternalStore` SSR fallback. */
export const EMPTY_BG_STATE: BackgroundPreferencesState = Object.freeze({
  schemaVersion: BG_STUDIO_SCHEMA_VERSION,
  activeSource: 'none',
  activeThemeId: null,
  activeConfig: null,
  favoritePresetIds: [],
  customThemes: [],
});

// ---------------------------------------------------------------------------
// Account Key & Defensive Sanitization
// ---------------------------------------------------------------------------

function normalizeAccount(account: string | number | null | undefined): string {
  return String(account ?? '').replace(/[^\w-]/g, '');
}

/** Account-scoped localStorage cache key (`ec_bg_studio:v1:u<id>` or `ec_bg_studio:v1:guest`). */
export function bgStorageKey(account: string): string {
  const id = normalizeAccount(account);
  return BG_STORAGE_PREFIX + (id ? `u${id}` : 'guest');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeIsoTimestamp(raw: unknown, fallbackIso: string): string {
  if (typeof raw !== 'string') return fallbackIso;
  const trimmed = raw.trim();
  if (trimmed.length < 10 || trimmed.length > 40) return fallbackIso;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms) || ms < MIN_TIMESTAMP_MS || ms > MAX_TIMESTAMP_MS) {
    return fallbackIso;
  }
  return new Date(ms).toISOString();
}

/** Validates and cleans a custom theme display name matching backend `BackgroundPreferenceValidator`. */
export function normalizeThemeName(
  raw: string,
): { ok: true; name: string } | { ok: false; reason: 'empty' | 'too-long' | 'invalid-chars'; message: string } {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'empty', message: 'Hãy nhập tên cho theme.' };
  }
  if (raw.includes('<') || raw.includes('>')) {
    return { ok: false, reason: 'invalid-chars', message: 'Tên theme không được chứa ký tự < hoặc >.' };
  }
  const cleaned = raw.replace(CONTROL_AND_BIDI_RE, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) {
    return { ok: false, reason: 'empty', message: 'Tên theme không được để trống.' };
  }
  if (cleaned.length > MAX_THEME_NAME_LENGTH) {
    return {
      ok: false,
      reason: 'too-long',
      message: `Tên theme tối đa ${MAX_THEME_NAME_LENGTH} ký tự.`,
    };
  }
  return { ok: true, name: cleaned };
}

function sanitizeStoredThemeName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const stripped = raw
    .replace(/[<>]/g, '')
    .replace(CONTROL_AND_BIDI_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_THEME_NAME_LENGTH);
  return stripped.length > 0 ? stripped : fallback;
}

function generateCustomThemeId(existingIds: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const stamp = Date.now().toString(36).toLowerCase();
    let rand = '';
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(4);
      crypto.getRandomValues(bytes);
      rand = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 6);
    } else {
      rand = Math.random().toString(36).slice(2, 8);
    }
    const candidate = `custom-${stamp}-${rand}`.replace(/[^a-z0-9_-]/g, '').slice(0, 60);
    if (THEME_ID_PATTERN.test(candidate) && !existingIds.has(candidate)) {
      return candidate;
    }
  }
  let index = 1;
  while (existingIds.has(`custom-theme-${index}`)) index += 1;
  return `custom-theme-${index}`;
}

/**
 * Defensively validates and normalizes any untrusted localStorage or API payload
 * into a schema-compliant `BackgroundPreferencesState`.
 */
export function sanitizePreferencesState(raw: unknown): BackgroundPreferencesState {
  if (!isRecord(raw)) return createEmptyPreferencesState();

  const nowIso = new Date().toISOString();

  // 1. Favorite preset IDs (allowlisted, deduped, bounded)
  const favoritePresetIds: string[] = [];
  if (Array.isArray(raw.favoritePresetIds)) {
    const seen = new Set<string>();
    for (const item of raw.favoritePresetIds) {
      if (isBackgroundPresetId(item) && !seen.has(item)) {
        seen.add(item);
        favoritePresetIds.push(item);
        if (favoritePresetIds.length >= MAX_FAVORITE_PRESETS) break;
      }
    }
  }

  // 2. Saved custom themes (valid unique IDs, sanitized configs, max 40)
  const customThemes: SavedBackgroundTheme[] = [];
  const customById = new Map<string, SavedBackgroundTheme>();
  if (Array.isArray(raw.customThemes)) {
    for (const item of raw.customThemes) {
      if (!isRecord(item)) continue;
      const rawId = typeof item.id === 'string' ? item.id.trim().toLowerCase() : '';
      if (!THEME_ID_PATTERN.test(rawId) || customById.has(rawId)) continue;
      const basedOn = isBackgroundPresetId(item.basedOnPresetId) ? item.basedOnPresetId : null;
      const fallbackConfig = (basedOn ? findBackgroundPreset(basedOn)?.config : undefined) ?? DEFAULT_STUDIO_CONFIG;
      const createdAt = sanitizeIsoTimestamp(item.createdAt, nowIso);
      const updatedAt = sanitizeIsoTimestamp(item.updatedAt, createdAt);
      const theme: SavedBackgroundTheme = {
        id: rawId,
        name: sanitizeStoredThemeName(item.name, 'Custom Theme'),
        favorite: item.favorite === true,
        basedOnPresetId: basedOn,
        config: sanitizeThemeConfig(item.config, fallbackConfig),
        createdAt,
        updatedAt,
      };
      customThemes.push(theme);
      customById.set(rawId, theme);
      if (customThemes.length >= MAX_CUSTOM_THEMES) break;
    }
  }

  // 3. Active source & theme reference
  let activeSource = isBackgroundActiveSource(raw.activeSource) ? raw.activeSource : 'none';
  let activeThemeId: string | null =
    typeof raw.activeThemeId === 'string' && THEME_ID_PATTERN.test(raw.activeThemeId)
      ? raw.activeThemeId
      : null;
  let activeConfig: BackgroundThemeConfig | null = null;

  if (activeSource === 'preset') {
    const preset = activeThemeId ? findBackgroundPreset(activeThemeId) : undefined;
    if (!preset) {
      activeSource = 'none';
      activeThemeId = null;
    } else if (isRecord(raw.activeConfig)) {
      activeConfig = sanitizeThemeConfig(raw.activeConfig, preset.config);
    }
  } else if (activeSource === 'custom') {
    const theme = activeThemeId ? customById.get(activeThemeId) : undefined;
    if (!theme) {
      activeSource = 'none';
      activeThemeId = null;
    } else if (isRecord(raw.activeConfig)) {
      activeConfig = sanitizeThemeConfig(raw.activeConfig, theme.config);
    }
  } else {
    activeThemeId = null;
  }

  return {
    schemaVersion: BG_STUDIO_SCHEMA_VERSION,
    activeSource,
    activeThemeId,
    activeConfig,
    favoritePresetIds,
    customThemes,
  };
}

// ---------------------------------------------------------------------------
// Module State (Memory Cache, Listeners, Preview, Occlusion, Sync)
// ---------------------------------------------------------------------------

type Listener = () => void;

let storeGeneration = 0;

/** Snapshot cache per `bgStorageKey(account)` for `useSyncExternalStore` stability. */
const memory = new Map<string, BackgroundPreferencesState>();
const stateListeners = new Set<Listener>();

interface StorageSubscriber {
  key: string;
  listener: Listener;
}
const storageSubscribers = new Set<StorageSubscriber>();
let sharedStorageHandler: ((event: StorageEvent) => void) | null = null;

function attachSharedStorageListener(): void {
  if (sharedStorageHandler || typeof window === 'undefined') return;
  sharedStorageHandler = (event: StorageEvent) => {
    const changedKey = event.key;
    if (changedKey === null) {
      memory.clear();
      resolvedCache.clear();
      storageSubscribers.forEach((entry) => entry.listener());
      return;
    }
    let invalidated = false;
    storageSubscribers.forEach((entry) => {
      if (entry.key === changedKey) {
        if (!invalidated) {
          memory.delete(changedKey);
          resolvedCache.delete(changedKey);
          invalidated = true;
        }
        entry.listener();
      }
    });
  };
  window.addEventListener('storage', sharedStorageHandler);
}

function detachSharedStorageListenerIfUnused(): void {
  if (!sharedStorageHandler || storageSubscribers.size > 0 || typeof window === 'undefined') return;
  window.removeEventListener('storage', sharedStorageHandler);
  sharedStorageHandler = null;
}

/** Memoized `resolveActiveBgConfig` snapshots to keep `useSyncExternalStore` referentially stable. */
interface ResolvedCacheEntry {
  stateRef: BackgroundPreferencesState | null;
  previewRef: LiveWorkspacePreviewState | null;
  scopedOverride: boolean;
  value: ResolvedActiveBackground | null;
}
const resolvedCache = new Map<string, ResolvedCacheEntry>();

/** Per-account hydration tracking (runs once per signed-in session). */
const hydratedAccounts = new Set<string>();
const inflightHydrations = new Map<string, Promise<void>>();
const hydrationControllers = new Map<string, AbortController>();

/** Monotonic per-account write counter so late hydration never overwrites a newer local edit. */
const localWriteSeq = new Map<string, number>();

/** Debounced per-account server persistence timers and sequence numbers. */
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const saveSeq = new Map<string, number>();

/** Ephemeral Live Workspace Preview state (never persisted until Apply / Save). */
let liveWorkspacePreview: LiveWorkspacePreviewState | null = null;
const previewListeners = new Set<Listener>();

/** Ephemeral Study Space 3D full-dome occlusion signal (pauses BackgroundThemeLayer without holding Study Space). */
let studyStageOccluded = false;
const occlusionListeners = new Set<Listener>();

/** Latest server persistence status for studio feedback pills. */
let syncStatus: BgSyncStatus = { state: 'idle' };
const syncListeners = new Set<Listener>();

function emitState(): void {
  stateListeners.forEach((listener) => listener());
}

function emitPreview(): void {
  previewListeners.forEach((listener) => listener());
}

function emitOcclusion(): void {
  occlusionListeners.forEach((listener) => listener());
}

function setSyncStatus(next: BgSyncStatus): void {
  if (syncStatus.state === next.state && syncStatus.message === next.message) return;
  syncStatus = next;
  syncListeners.forEach((listener) => listener());
}

// ---------------------------------------------------------------------------
// Local Storage Read / Write
// ---------------------------------------------------------------------------

function isEmptyState(state: BackgroundPreferencesState): boolean {
  return (
    state.activeSource === 'none' &&
    state.activeThemeId === null &&
    state.activeConfig === null &&
    state.favoritePresetIds.length === 0 &&
    state.customThemes.length === 0
  );
}

function readFromLocalStorage(key: string): BackgroundPreferencesState {
  if (typeof window === 'undefined') return EMPTY_BG_STATE;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return EMPTY_BG_STATE;
    return sanitizePreferencesState(JSON.parse(raw));
  } catch {
    return EMPTY_BG_STATE;
  }
}

function persistLocal(key: string, next: BackgroundPreferencesState): void {
  memory.set(key, next);
  resolvedCache.delete(key);
  if (typeof window !== 'undefined') {
    try {
      if (isEmptyState(next)) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, JSON.stringify(next));
      }
    } catch {
      // Storage denied or full: keep in-memory state for this session.
    }
  }
  emitState();
}

/** Reads and caches sanitized preferences for `account` (stable snapshot for `useSyncExternalStore`). */
export function currentBgState(account: string): BackgroundPreferencesState {
  if (typeof window === 'undefined') return EMPTY_BG_STATE;
  const key = bgStorageKey(account);
  let cached = memory.get(key);
  if (!cached) {
    cached = readFromLocalStorage(key);
    memory.set(key, cached);
  }
  return cached;
}

/** Subscribes to same-tab updates, cross-tab `storage` events, and appearance scope changes. */
export function subscribeBgState(account: string, listener: Listener): () => void {
  if (typeof window === 'undefined') return () => {};
  const key = bgStorageKey(account);
  const unsubscribeScope = subscribeAppearanceScope(() => {
    resolvedCache.delete(key);
    listener();
  });
  const entry: StorageSubscriber = { key, listener };
  stateListeners.add(listener);
  storageSubscribers.add(entry);
  attachSharedStorageListener();
  return () => {
    stateListeners.delete(listener);
    storageSubscribers.delete(entry);
    detachSharedStorageListenerIfUnused();
    unsubscribeScope();
  };
}

/**
 * Resolves the active Background Studio configuration for `account`:
 * 1. Minimized Live Workspace Preview takes top priority (even if saved mode is default).
 * 2. Yields cleanly when a Study Space per-space appearance override is active.
 * 3. Resolves saved `'preset'` or `'custom'` theme (with optional sanitized `activeConfig` override).
 */
export function resolveActiveBgConfig(account: string): ResolvedActiveBackground | null {
  if (typeof window === 'undefined') return null;
  const norm = normalizeAccount(account);
  const key = bgStorageKey(norm);

  const activePreview =
    liveWorkspacePreview &&
    normalizeAccount(liveWorkspacePreview.account) === norm &&
    liveWorkspacePreview.minimizedToWorkspace
      ? liveWorkspacePreview
      : null;

  const scopedOverride = scopedPreference(accountKey(norm)) !== undefined;
  const state = activePreview ? null : currentBgState(norm);

  const prev = resolvedCache.get(key);
  if (
    prev &&
    prev.stateRef === state &&
    prev.previewRef === activePreview &&
    prev.scopedOverride === scopedOverride
  ) {
    return prev.value;
  }

  let value: ResolvedActiveBackground | null = null;

  if (activePreview) {
    value = {
      config: activePreview.config,
      themeId: activePreview.themeId,
      themeName: activePreview.themeName,
      source: activePreview.source,
      isPreview: true,
    };
  } else if (!scopedOverride && state) {
    if (state.activeSource === 'preset' && state.activeThemeId) {
      const preset = findBackgroundPreset(state.activeThemeId);
      if (preset) {
        const config = state.activeConfig
          ? sanitizeThemeConfig(state.activeConfig, preset.config)
          : preset.config;
        value = {
          config,
          themeId: preset.id,
          themeName: preset.name,
          source: 'preset',
          isPreview: false,
        };
      }
    } else if (state.activeSource === 'custom' && state.activeThemeId) {
      const theme = state.customThemes.find((item) => item.id === state.activeThemeId);
      if (theme) {
        const config = state.activeConfig
          ? sanitizeThemeConfig(state.activeConfig, theme.config)
          : theme.config;
        value = {
          config,
          themeId: theme.id,
          themeName: theme.name,
          source: 'custom',
          isPreview: false,
        };
      }
    }
  }

  resolvedCache.set(key, {
    stateRef: state,
    previewRef: activePreview,
    scopedOverride,
    value,
  });

  return value;
}

// ---------------------------------------------------------------------------
// Debounced Server Persistence & Session Hydration
// ---------------------------------------------------------------------------

function cancelPendingSave(normAccount: string): void {
  const existing = saveTimers.get(normAccount);
  if (existing !== undefined) {
    clearTimeout(existing);
    saveTimers.delete(normAccount);
  }
}

function scheduleServerSave(normAccount: string): void {
  if (!normAccount) {
    setSyncStatus({ state: 'idle' });
    return;
  }
  cancelPendingSave(normAccount);
  const nextSeq = (saveSeq.get(normAccount) ?? 0) + 1;
  saveSeq.set(normAccount, nextSeq);
  const generation = storeGeneration;
  setSyncStatus({ state: 'saving' });

  const timer = setTimeout(() => {
    saveTimers.delete(normAccount);
    if (generation !== storeGeneration || saveSeq.get(normAccount) !== nextSeq) return;
    const latest = currentBgState(normAccount);
    void backgroundThemeApi
      .save(latest, { skipAuthRedirect: true })
      .then(() => {
        if (generation !== storeGeneration || saveSeq.get(normAccount) !== nextSeq) return;
        setSyncStatus({ state: 'saved' });
      })
      .catch(() => {
        if (generation !== storeGeneration || saveSeq.get(normAccount) !== nextSeq) return;
        setSyncStatus({
          state: 'error',
          message: 'Không thể đồng bộ lên tài khoản. Thay đổi vẫn được lưu trên thiết bị này.',
        });
      });
  }, DEBOUNCE_SAVE_MS);

  saveTimers.set(normAccount, timer);
}

function commitLocalAndSync(normAccount: string, next: BackgroundPreferencesState): void {
  const key = bgStorageKey(normAccount);
  localWriteSeq.set(normAccount, (localWriteSeq.get(normAccount) ?? 0) + 1);
  persistLocal(key, next);
  scheduleServerSave(normAccount);
}

function commitBackgroundFromHydration(
  normAccount: string,
  serverState: BackgroundPreferencesState,
): void {
  const key = bgStorageKey(normAccount);
  if (serverState.activeSource !== 'none') {
    const localWallpaper = currentPreference(accountKey(normAccount));
    const localSpatial = storedSpatial(spatialKey(normAccount));
    const otherLocalActive = localWallpaper.source !== 'none' || localSpatial.enabled;
    if (otherLocalActive) {
      // Preserve server favorites and custom themes without overriding an active local wallpaper or 3D preset.
      persistLocal(key, {
        ...serverState,
        activeSource: 'none',
        activeThemeId: null,
        activeConfig: null,
      });
      return;
    }
    persistLocal(key, serverState);
    applyBackgroundAppearance(normAccount);
    return;
  }
  persistLocal(key, serverState);
}

/**
 * Hydrates saved Background Studio preferences from the server ONCE per signed-in account session.
 * Guests make zero API calls. Late responses arriving after logout, account switch, or a newer
 * local mutation are safely discarded.
 */
export function hydrateBgPreferences(account: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  const norm = normalizeAccount(account);
  if (!norm) return Promise.resolve();
  if (hydratedAccounts.has(norm)) return Promise.resolve();
  const inflight = inflightHydrations.get(norm);
  if (inflight) return inflight;

  const generation = storeGeneration;
  const writeSeqAtStart = localWriteSeq.get(norm) ?? 0;
  const controller = new AbortController();
  hydrationControllers.set(norm, controller);

  const promise = backgroundThemeApi
    .get({ skipAuthRedirect: true, signal: controller.signal })
    .then((response) => {
      if (generation !== storeGeneration) return;
      hydratedAccounts.add(norm);
      if ((localWriteSeq.get(norm) ?? 0) !== writeSeqAtStart) return;
      const serverState = sanitizePreferencesState(response?.state);
      const serverHasData =
        (typeof response?.revision === 'number' && response.revision > 0) || !isEmptyState(serverState);
      if (serverHasData) {
        commitBackgroundFromHydration(norm, serverState);
      }
    })
    .catch(() => {
      // Passive hydration fails quietly: local cache remains intact and never redirects.
      if (generation === storeGeneration && !controller.signal.aborted) {
        hydratedAccounts.add(norm);
      }
    })
    .finally(() => {
      if (hydrationControllers.get(norm) === controller) {
        hydrationControllers.delete(norm);
      }
      if (inflightHydrations.get(norm) === promise) {
        inflightHydrations.delete(norm);
      }
    });

  inflightHydrations.set(norm, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Applies a built-in preset (with optional live custom tweak overlay) and activates mutual exclusion. */
export function applyPresetBackground(
  account: string,
  presetId: string,
  configOverride?: BackgroundThemeConfig | null,
): boolean {
  const preset = findBackgroundPreset(presetId);
  if (!preset) return false;
  const norm = normalizeAccount(account);
  const prev = currentBgState(norm);
  const sanitizedOverride = configOverride
    ? sanitizeThemeConfig(configOverride, preset.config)
    : null;
  const next: BackgroundPreferencesState = {
    ...prev,
    schemaVersion: BG_STUDIO_SCHEMA_VERSION,
    activeSource: 'preset',
    activeThemeId: preset.id,
    activeConfig: sanitizedOverride,
  };
  if (liveWorkspacePreview && normalizeAccount(liveWorkspacePreview.account) === norm) {
    setLiveWorkspacePreview(null);
  }
  commitLocalAndSync(norm, next);
  applyBackgroundAppearance(norm);
  return true;
}

/** Applies a saved custom theme (with optional live custom tweak overlay) and activates mutual exclusion. */
export function applyCustomBackground(
  account: string,
  themeId: string,
  configOverride?: BackgroundThemeConfig | null,
): boolean {
  const norm = normalizeAccount(account);
  const prev = currentBgState(norm);
  const target = prev.customThemes.find((item) => item.id === themeId);
  if (!target) return false;
  const sanitizedOverride = configOverride
    ? sanitizeThemeConfig(configOverride, target.config)
    : null;
  const next: BackgroundPreferencesState = {
    ...prev,
    schemaVersion: BG_STUDIO_SCHEMA_VERSION,
    activeSource: 'custom',
    activeThemeId: target.id,
    activeConfig: sanitizedOverride,
  };
  if (liveWorkspacePreview && normalizeAccount(liveWorkspacePreview.account) === norm) {
    setLiveWorkspacePreview(null);
  }
  commitLocalAndSync(norm, next);
  applyBackgroundAppearance(norm);
  return true;
}

/** Saves (creates or updates) a custom theme in `My Themes`, optionally activating it immediately. */
export function saveCustomTheme(
  account: string,
  input: SaveCustomThemeInput,
): BgThemeMutationResult {
  const nameCheck = normalizeThemeName(input.name);
  if (!nameCheck.ok) {
    return { ok: false, error: 'INVALID_NAME', message: nameCheck.message };
  }

  const norm = normalizeAccount(account);
  const prev = currentBgState(norm);
  const nowIso = new Date().toISOString();
  const existingIndex =
    typeof input.id === 'string' && input.id.length > 0
      ? prev.customThemes.findIndex((item) => item.id === input.id)
      : -1;

  let savedTheme: SavedBackgroundTheme;
  let customThemes: SavedBackgroundTheme[];

  if (existingIndex >= 0) {
    const existing = prev.customThemes[existingIndex];
    const basedOn =
      input.basedOnPresetId === undefined
        ? existing.basedOnPresetId ?? null
        : isBackgroundPresetId(input.basedOnPresetId)
          ? input.basedOnPresetId
          : null;
    savedTheme = {
      ...existing,
      name: nameCheck.name,
      favorite: input.favorite ?? existing.favorite,
      basedOnPresetId: basedOn,
      config: sanitizeThemeConfig(input.config, existing.config),
      updatedAt: nowIso,
    };
    customThemes = prev.customThemes.map((item, index) => (index === existingIndex ? savedTheme : item));
  } else {
    if (prev.customThemes.length >= MAX_CUSTOM_THEMES) {
      return {
        ok: false,
        error: 'THEME_LIMIT',
        message: `Bạn đã lưu tối đa ${MAX_CUSTOM_THEMES} theme. Hãy xóa bớt trước khi tạo mới.`,
      };
    }
    const existingIds = new Set(prev.customThemes.map((item) => item.id));
    const basedOn = isBackgroundPresetId(input.basedOnPresetId) ? input.basedOnPresetId : null;
    const fallbackConfig = (basedOn ? findBackgroundPreset(basedOn)?.config : undefined) ?? DEFAULT_STUDIO_CONFIG;
    savedTheme = {
      id: generateCustomThemeId(existingIds),
      name: nameCheck.name,
      favorite: input.favorite === true,
      basedOnPresetId: basedOn,
      config: sanitizeThemeConfig(input.config, fallbackConfig),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    customThemes = [savedTheme, ...prev.customThemes];
  }

  const shouldActivate = input.activate === true;
  const isAlreadyActive = prev.activeSource === 'custom' && prev.activeThemeId === savedTheme.id;

  const next: BackgroundPreferencesState = {
    ...prev,
    schemaVersion: BG_STUDIO_SCHEMA_VERSION,
    customThemes,
    activeSource: shouldActivate ? 'custom' : prev.activeSource,
    activeThemeId: shouldActivate ? savedTheme.id : prev.activeThemeId,
    activeConfig: shouldActivate || isAlreadyActive ? null : prev.activeConfig,
  };

  if (shouldActivate && liveWorkspacePreview && normalizeAccount(liveWorkspacePreview.account) === norm) {
    setLiveWorkspacePreview(null);
  }

  commitLocalAndSync(norm, next);

  if (shouldActivate) {
    applyBackgroundAppearance(norm);
  }

  return { ok: true, theme: savedTheme };
}

/** Renames an existing custom theme in place. */
export function renameCustomTheme(
  account: string,
  themeId: string,
  newName: string,
): BgThemeMutationResult {
  const nameCheck = normalizeThemeName(newName);
  if (!nameCheck.ok) {
    return { ok: false, error: 'INVALID_NAME', message: nameCheck.message };
  }
  const norm = normalizeAccount(account);
  const prev = currentBgState(norm);
  const existing = prev.customThemes.find((item) => item.id === themeId);
  if (!existing) {
    return { ok: false, error: 'NOT_FOUND', message: 'Không tìm thấy theme cần đổi tên.' };
  }
  const updated: SavedBackgroundTheme = {
    ...existing,
    name: nameCheck.name,
    updatedAt: new Date().toISOString(),
  };
  const next: BackgroundPreferencesState = {
    ...prev,
    schemaVersion: BG_STUDIO_SCHEMA_VERSION,
    customThemes: prev.customThemes.map((item) => (item.id === themeId ? updated : item)),
  };
  commitLocalAndSync(norm, next);
  return { ok: true, theme: updated };
}

/** Duplicates a saved custom theme, enforcing the 40-theme cap and 60-char name ceiling. */
export function duplicateCustomTheme(
  account: string,
  themeId: string,
): BgThemeMutationResult {
  const norm = normalizeAccount(account);
  const prev = currentBgState(norm);
  if (prev.customThemes.length >= MAX_CUSTOM_THEMES) {
    return {
      ok: false,
      error: 'THEME_LIMIT',
      message: `Bạn đã lưu tối đa ${MAX_CUSTOM_THEMES} theme. Hãy xóa bớt trước khi nhân bản.`,
    };
  }
  const source = prev.customThemes.find((item) => item.id === themeId);
  if (!source) {
    return { ok: false, error: 'NOT_FOUND', message: 'Không tìm thấy theme cần nhân bản.' };
  }
  const suffix = ' (Copy)';
  const baseName = source.name.slice(0, MAX_THEME_NAME_LENGTH - suffix.length).trimEnd();
  const copyName = `${baseName || 'Theme'}${suffix}`;
  const nowIso = new Date().toISOString();
  const existingIds = new Set(prev.customThemes.map((item) => item.id));
  const duplicated: SavedBackgroundTheme = {
    id: generateCustomThemeId(existingIds),
    name: copyName,
    favorite: false,
    basedOnPresetId: source.basedOnPresetId ?? null,
    config: cloneThemeConfig(source.config),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const next: BackgroundPreferencesState = {
    ...prev,
    schemaVersion: BG_STUDIO_SCHEMA_VERSION,
    customThemes: [duplicated, ...prev.customThemes],
  };
  commitLocalAndSync(norm, next);
  return { ok: true, theme: duplicated };
}

/** Deletes a saved custom theme; deactivates it cleanly if it was currently on screen. */
export function deleteCustomTheme(account: string, themeId: string): boolean {
  const norm = normalizeAccount(account);
  const prev = currentBgState(norm);
  const exists = prev.customThemes.some((item) => item.id === themeId);
  if (!exists) return false;
  const wasActive = prev.activeSource === 'custom' && prev.activeThemeId === themeId;
  const next: BackgroundPreferencesState = {
    ...prev,
    schemaVersion: BG_STUDIO_SCHEMA_VERSION,
    activeSource: wasActive ? 'none' : prev.activeSource,
    activeThemeId: wasActive ? null : prev.activeThemeId,
    activeConfig: wasActive ? null : prev.activeConfig,
    customThemes: prev.customThemes.filter((item) => item.id !== themeId),
  };
  commitLocalAndSync(norm, next);
  return true;
}

/** Toggles favorite status for a built-in preset ID. Returns the new favorite state. */
export function toggleFavoritePreset(account: string, presetId: string): boolean {
  if (!isBackgroundPresetId(presetId)) return false;
  const norm = normalizeAccount(account);
  const prev = currentBgState(norm);
  const already = prev.favoritePresetIds.includes(presetId);
  const favoritePresetIds = already
    ? prev.favoritePresetIds.filter((id) => id !== presetId)
    : [...prev.favoritePresetIds, presetId].slice(0, MAX_FAVORITE_PRESETS);
  const next: BackgroundPreferencesState = {
    ...prev,
    schemaVersion: BG_STUDIO_SCHEMA_VERSION,
    favoritePresetIds,
  };
  commitLocalAndSync(norm, next);
  return !already;
}

/** Toggles favorite status for a saved custom theme. Returns the new favorite state. */
export function toggleFavoriteCustomTheme(account: string, themeId: string): boolean {
  const norm = normalizeAccount(account);
  const prev = currentBgState(norm);
  const existing = prev.customThemes.find((item) => item.id === themeId);
  if (!existing) return false;
  const nextFavorite = !existing.favorite;
  const nowIso = new Date().toISOString();
  const next: BackgroundPreferencesState = {
    ...prev,
    schemaVersion: BG_STUDIO_SCHEMA_VERSION,
    customThemes: prev.customThemes.map((item) =>
      item.id === themeId ? { ...item, favorite: nextFavorite, updatedAt: nowIso } : item,
    ),
  };
  commitLocalAndSync(norm, next);
  return nextFavorite;
}

/**
 * Deactivates the active Background Studio theme while preserving all saved
 * `customThemes` and `favoritePresetIds`. Triggers server sync only if previously active.
 */
export function deactivateBackgroundStudio(account: string): void {
  const norm = normalizeAccount(account);
  if (liveWorkspacePreview && normalizeAccount(liveWorkspacePreview.account) === norm) {
    setLiveWorkspacePreview(null);
  }
  const prev = currentBgState(norm);
  if (prev.activeSource === 'none' && prev.activeThemeId === null && prev.activeConfig === null) {
    return;
  }
  const next: BackgroundPreferencesState = {
    ...prev,
    schemaVersion: BG_STUDIO_SCHEMA_VERSION,
    activeSource: 'none',
    activeThemeId: null,
    activeConfig: null,
  };
  commitLocalAndSync(norm, next);
}

/**
 * Restores the default Echo Ocean appearance. When `clearServer` is true for a
 * signed-in learner, also resets persisted server preferences via `DELETE`.
 */
export async function resetBackgroundPreferences(
  account: string,
  clearServer = false,
): Promise<void> {
  const norm = normalizeAccount(account);
  restoreDefaultAppearance(norm);
  if (!clearServer) return;

  cancelPendingSave(norm);
  const nextSeq = (saveSeq.get(norm) ?? 0) + 1;
  saveSeq.set(norm, nextSeq);
  localWriteSeq.set(norm, (localWriteSeq.get(norm) ?? 0) + 1);
  persistLocal(bgStorageKey(norm), createEmptyPreferencesState());

  if (!norm) {
    setSyncStatus({ state: 'idle' });
    return;
  }

  const generation = storeGeneration;
  setSyncStatus({ state: 'saving' });
  try {
    await backgroundThemeApi.reset({ skipAuthRedirect: true });
    if (generation === storeGeneration && saveSeq.get(norm) === nextSeq) {
      setSyncStatus({ state: 'saved' });
    }
  } catch {
    if (generation === storeGeneration && saveSeq.get(norm) === nextSeq) {
      setSyncStatus({
        state: 'error',
        message: 'Không thể đặt lại trên máy chủ. Đã khôi phục giao diện mặc định trên thiết bị này.',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Live Workspace Preview Store
// ---------------------------------------------------------------------------

export function getLiveWorkspacePreview(): LiveWorkspacePreviewState | null {
  return liveWorkspacePreview;
}

export function setLiveWorkspacePreview(next: LiveWorkspacePreviewState | null): void {
  if (liveWorkspacePreview === next) return;
  liveWorkspacePreview = next
    ? {
        ...next,
        account: normalizeAccount(next.account),
        config: sanitizeThemeConfig(next.config, DEFAULT_STUDIO_CONFIG),
        draftSnapshot: next.draftSnapshot
          ? {
              ...next.draftSnapshot,
              config: sanitizeThemeConfig(next.draftSnapshot.config, DEFAULT_STUDIO_CONFIG),
            }
          : undefined,
      }
    : null;
  resolvedCache.clear();
  emitPreview();
}

export function subscribeLiveWorkspacePreview(listener: Listener): () => void {
  previewListeners.add(listener);
  return () => {
    previewListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Study Space Occlusion Store (Finding 2B — separate from setBackgroundHeld)
// ---------------------------------------------------------------------------

export function isStudyStageOccluded(): boolean {
  return studyStageOccluded;
}

export function setStudyStageOccluded(occluded: boolean): void {
  if (studyStageOccluded === occluded) return;
  studyStageOccluded = occluded;
  emitOcclusion();
}

export function subscribeStudyStageOccluded(listener: Listener): () => void {
  occlusionListeners.add(listener);
  return () => {
    occlusionListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Sync Status Store
// ---------------------------------------------------------------------------

export function getBgSyncStatus(): BgSyncStatus {
  return syncStatus;
}

export function subscribeBgSyncStatus(listener: Listener): () => void {
  syncListeners.add(listener);
  return () => {
    syncListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Sign-Out / Account-Switch Cleanup & Appearance Adapter Registration
// ---------------------------------------------------------------------------

function clearBackgroundStudioMemory(): void {
  storeGeneration += 1;
  for (const timer of saveTimers.values()) {
    clearTimeout(timer);
  }
  saveTimers.clear();
  saveSeq.clear();
  for (const controller of hydrationControllers.values()) {
    controller.abort();
  }
  hydrationControllers.clear();
  inflightHydrations.clear();
  hydratedAccounts.clear();
  localWriteSeq.clear();
  memory.clear();
  resolvedCache.clear();
  if (liveWorkspacePreview !== null) {
    liveWorkspacePreview = null;
    emitPreview();
  }
  if (studyStageOccluded) {
    studyStageOccluded = false;
    emitOcclusion();
  }
  setSyncStatus({ state: 'idle' });
  emitState();
}

registerUserScopedCleanup(clearBackgroundStudioMemory);

registerBackgroundAppearanceAdapter({
  resolve(account: string) {
    const active = resolveActiveBgConfig(account);
    if (!active) return null;
    return active.isPreview
      ? { selectionId: active.themeId, preview: true }
      : { selectionId: active.themeId };
  },
  deactivate(account: string) {
    deactivateBackgroundStudio(account);
  },
  clearPreview() {
    setLiveWorkspacePreview(null);
  },
});
