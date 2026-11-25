import { DEFAULT_DOCK_PINNED, NAV_IDS, isKnownNavId } from './registry';

export type NavigationLayout = 'sidebar' | 'dock';
export type NavigationVisibility = 'pinned' | 'autohide';

export interface NavigationPreferences {
  version: 1;
  layout: NavigationLayout;
  visibility: NavigationVisibility;
  dockOrder: string[];
  dockPinned: string[];
}

interface LegacyNavigationPreferences {
  layout?: unknown;
  visibility?: unknown;
  mainVisibility?: unknown;
  topBarVisibility?: unknown;
  dockOrder?: unknown;
  dockPinned?: unknown;
}

export const NAV_PREF_PREFIX = 'ec_nav:v1:';

export const DEFAULT_NAV_PREFERENCES: NavigationPreferences = {
  version: 1,
  layout: 'sidebar',
  visibility: 'pinned',
  dockOrder: [...NAV_IDS],
  dockPinned: [...DEFAULT_DOCK_PINNED],
};

export function navStorageKey(userId: string | number | null | undefined): string {
  const clean = String(userId ?? '').replace(/[^\w-]/g, '');
  return NAV_PREF_PREFIX + (clean ? `u${clean}` : 'guest');
}

function normalizeOrder(rawOrder: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  if (Array.isArray(rawOrder)) {
    for (const id of rawOrder) {
      if (isKnownNavId(id) && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  for (const id of NAV_IDS) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function normalizePinned(rawPinned: unknown): string[] {
  if (!Array.isArray(rawPinned)) return [...DEFAULT_DOCK_PINNED];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of rawPinned) {
    if (isKnownNavId(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function normalizeVisibility(value: LegacyNavigationPreferences): NavigationVisibility {
  if (value.visibility === 'autohide' || value.visibility === 'pinned') {
    return value.visibility;
  }
  if (value.mainVisibility === 'autohide' || value.topBarVisibility === 'autohide') {
    return 'autohide';
  }
  return 'pinned';
}

export function normalizeNavPreferences(raw: unknown): NavigationPreferences {
  if (!raw || typeof raw !== 'object') {
    return {
      ...DEFAULT_NAV_PREFERENCES,
      dockOrder: [...DEFAULT_NAV_PREFERENCES.dockOrder],
      dockPinned: [...DEFAULT_NAV_PREFERENCES.dockPinned],
    };
  }
  const value = raw as LegacyNavigationPreferences;
  return {
    version: 1,
    layout: value.layout === 'dock' ? 'dock' : 'sidebar',
    visibility: normalizeVisibility(value),
    dockOrder: normalizeOrder(value.dockOrder),
    dockPinned: normalizePinned(value.dockPinned),
  };
}

function isDefaultPreferences(pref: NavigationPreferences): boolean {
  if (pref.layout !== 'sidebar' || pref.visibility !== 'pinned') return false;
  if (pref.dockOrder.length !== NAV_IDS.length || pref.dockOrder.some((id, idx) => id !== NAV_IDS[idx])) return false;
  if (pref.dockPinned.length !== DEFAULT_DOCK_PINNED.length || pref.dockPinned.some((id, idx) => id !== DEFAULT_DOCK_PINNED[idx])) return false;
  return true;
}

export function readNavPreferences(key: string): NavigationPreferences {
  if (typeof window === 'undefined') return DEFAULT_NAV_PREFERENCES;
  try {
    const raw = localStorage.getItem(key);
    return raw ? normalizeNavPreferences(JSON.parse(raw)) : DEFAULT_NAV_PREFERENCES;
  } catch {
    return DEFAULT_NAV_PREFERENCES;
  }
}

type Listener = () => void;
type BeforeLayoutSwitchHook = (from: NavigationLayout, to: NavigationLayout) => (() => void) | void;

const listeners = new Set<Listener>();
const memory = new Map<string, NavigationPreferences>();
let beforeLayoutSwitch: BeforeLayoutSwitchHook | null = null;

export function registerBeforeLayoutSwitch(hook: BeforeLayoutSwitchHook | null): void {
  beforeLayoutSwitch = hook;
}

export function currentNavPreferences(key: string): NavigationPreferences {
  let cached = memory.get(key);
  if (!cached) {
    cached = readNavPreferences(key);
    memory.set(key, cached);
  }
  return cached;
}

export function writeNavPreferences(key: string, nextRaw: NavigationPreferences): NavigationPreferences {
  const prev = currentNavPreferences(key);
  const next = normalizeNavPreferences(nextRaw);
  const afterSwitch =
    prev.layout !== next.layout && typeof window !== 'undefined'
      ? beforeLayoutSwitch?.(prev.layout, next.layout)
      : undefined;
  memory.set(key, next);
  if (typeof window !== 'undefined') {
    try {
      if (isDefaultPreferences(next)) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, JSON.stringify(next));
      }
    } catch {
      // Storage denied or quota full: keep in-memory preference for this session.
    }
  }
  listeners.forEach((fn) => fn());
  afterSwitch?.();
  return next;
}

export function subscribeNavPreferences(key: string, listener: Listener): () => void {
  listeners.add(listener);
  if (typeof window === 'undefined') {
    return () => {
      listeners.delete(listener);
    };
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) {
      memory.delete(key);
      listener();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function setNavigationLayout(key: string, layout: NavigationLayout): void {
  const current = currentNavPreferences(key);
  if (current.layout === layout) return;
  writeNavPreferences(key, { ...current, layout });
}

export function setNavigationVisibility(key: string, visibility: NavigationVisibility): void {
  const current = currentNavPreferences(key);
  if (current.visibility === visibility) return;
  writeNavPreferences(key, { ...current, visibility });
}

export function toggleDockPinned(key: string, id: string): void {
  if (!isKnownNavId(id)) return;
  const current = currentNavPreferences(key);
  const pinnedSet = new Set(current.dockPinned);
  if (pinnedSet.has(id)) {
    pinnedSet.delete(id);
  } else {
    pinnedSet.add(id);
  }
  // Keep dockPinned ordered consistently with dockOrder.
  const dockPinned = current.dockOrder.filter((item) => pinnedSet.has(item));
  writeNavPreferences(key, { ...current, dockPinned });
}

export function reorderDockItems(key: string, draggedId: string, targetId: string): void {
  if (!isKnownNavId(draggedId) || !isKnownNavId(targetId) || draggedId === targetId) return;
  const current = currentNavPreferences(key);
  const order = [...current.dockOrder];
  const fromIdx = order.indexOf(draggedId);
  const toIdx = order.indexOf(targetId);
  if (fromIdx < 0 || toIdx < 0) return;
  order.splice(fromIdx, 1);
  order.splice(toIdx, 0, draggedId);
  const pinnedSet = new Set(current.dockPinned);
  const dockPinned = order.filter((item) => pinnedSet.has(item));
  writeNavPreferences(key, { ...current, dockOrder: order, dockPinned });
}

export function moveDockItemByOffset(key: string, id: string, delta: -1 | 1, visibleSubset?: readonly string[]): void {
  if (!isKnownNavId(id)) return;
  const current = currentNavPreferences(key);
  const pool = visibleSubset && visibleSubset.length > 1 ? [...visibleSubset] : current.dockPinned;
  const pos = pool.indexOf(id);
  const nextPos = pos + delta;
  if (pos < 0 || nextPos < 0 || nextPos >= pool.length) return;
  reorderDockItems(key, id, pool[nextPos]);
}

export function resetDockPreferences(key: string): void {
  const current = currentNavPreferences(key);
  writeNavPreferences(key, {
    ...current,
    dockOrder: [...NAV_IDS],
    dockPinned: [...DEFAULT_DOCK_PINNED],
  });
}
