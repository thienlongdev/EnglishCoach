/**
 * Echo Anywhere (browser extension) on the website: where it can be installed, whether THIS browser has it, and the
 * hand-over of a pairing code. Detection is the extension's own answer to a runtime message, sent only to the ids the
 * backend allows (`GET /api/v1/extension/config`) — never a guess from the user agent or a DOM marker. Until the store
 * listings exist their links stay null and the site says so (features/echo-anywhere).
 */

/** Official listing links. Fill ONLY with the real, approved store URLs (never a guessed one). */
export const ECHO_ANYWHERE_STORES: { chrome: string | null; edge: string | null } = {
  chrome: 'https://chromewebstore.google.com/detail/echo-anywhere-%E2%80%94-english-c/gohhmbiobjnfnkagkklffajggkmgegod',
  edge: null,
};

export type InstallState =
  | { kind: 'checking' }
  | { kind: 'installed'; version: string; connected: boolean }
  | { kind: 'not-detected' }
  | { kind: 'unsupported' };

interface ExtensionRuntime {
  sendMessage: (id: string, message: unknown, callback: (response: unknown) => void) => void;
  lastError?: { message?: string };
}

function runtime(): ExtensionRuntime | null {
  const w = typeof window === 'undefined' ? null : (window as unknown as { chrome?: { runtime?: ExtensionRuntime } });
  return w?.chrome?.runtime?.sendMessage ? w.chrome.runtime : null;
}

export function browserKind(userAgent?: string): 'chrome' | 'edge' | 'other' | 'mobile' {
  const ua = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return 'mobile';
  const chromium = /Chrome\/(\d+)/.exec(ua);
  if (!chromium || Number(chromium[1]) < 116) return 'other';
  if (/Edg\//.test(ua)) return 'edge';
  if (/Chrome\//.test(ua) && !/OPR\/|Opera|SamsungBrowser/.test(ua)) return 'chrome';
  return 'other';
}

/** Chrome Web Store also serves compatible Brave/Cốc Cốc builds; Edge prefers its own store. */
export function installDestination(kind: ReturnType<typeof browserKind>, stores = ECHO_ANYWHERE_STORES): { url: string; store: 'chrome' | 'edge' } | null {
  if (kind === 'edge' && stores.edge) return { url: stores.edge, store: 'edge' };
  if ((kind === 'edge' || kind === 'chrome') && stores.chrome) return { url: stores.chrome, store: 'chrome' };
  return null;
}

/** Skip only local anchors on this page, never jump across an external/unknown predecessor. */
export function internalReturnDelta(entries: { index: number; url?: string }[], currentIndex: number, origin: string): number | null {
  for (let i = currentIndex - 1; i >= 0; i--) {
    const entry = entries.find((e) => e.index === i);
    if (!entry?.url) return null;
    try {
      const url = new URL(entry.url);
      if (url.origin !== origin) return null;
      if (url.pathname === '/echo-anywhere') continue;
      return i - currentIndex;
    } catch { return null; }
  }
  return null;
}

let idsPromise: Promise<string[]> | null = null;
export function allowedExtensionIds(): Promise<string[]> {
  if (!idsPromise) {
    idsPromise = fetch('/api/v1/extension/config', { credentials: 'omit' })
      .then((r) => (r.ok ? r.json() : { extensionIds: [] }))
      .then((b: { extensionIds?: unknown }) => (Array.isArray(b.extensionIds) ? b.extensionIds.filter((x): x is string => typeof x === 'string' && /^[a-p]{32}$/.test(x)) : []))
      .catch(() => {
        idsPromise = null;
        return [];
      });
  }
  return idsPromise;
}

function ask<T>(id: string, message: unknown, timeoutMs: number): Promise<T | null> {
  const rt = runtime();
  if (!rt) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    try {
      rt.sendMessage(id, message, (response) => {
        clearTimeout(timer);
        void rt.lastError; // reading it clears "receiving end does not exist" for an id that is not installed
        resolve((response as T) ?? null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/** Asks each allowed id whether it is installed here. */
export async function detectEchoAnywhere(): Promise<InstallState> {
  const kind = browserKind();
  if (kind === 'mobile' || kind === 'other') return { kind: 'unsupported' };
  if (!runtime()) return { kind: 'not-detected' };
  for (const id of await allowedExtensionIds()) {
    const r = await ask<{ installed?: boolean; version?: string; connected?: boolean }>(id, { t: 'echo-anywhere:ping' }, 900);
    if (r?.installed === true && typeof r.connected === 'boolean') return { kind: 'installed', version: typeof r.version === 'string' ? r.version : '', connected: r.connected };
  }
  return { kind: 'not-detected' };
}

/** Gives the one-time pairing code to the extension that asked for it. */
export function handOverPairing(extensionId: string, code: string, state: string): Promise<{ ok?: boolean; message?: string; name?: string } | null> {
  return ask(extensionId, { t: 'echo-anywhere:pair', code, state }, 15000);
}

// Reuse the existing browser preference preserved through sign-out. No identity, token or learning data.
export const HINT_KEY = 'ec_echo_anywhere_hint:v1';
type NoticePreference = { tipSeen: boolean; releases: Record<string, 'seen' | 'dismissed'> };
function noticePreference(): NoticePreference {
  const raw = localStorage.getItem(HINT_KEY);
  if (raw === '1') return { tipSeen: true, releases: {} }; // legacy tip dismissal
  if (!raw) return { tipSeen: false, releases: {} };
  const parsed = JSON.parse(raw);
  return { tipSeen: parsed.tipSeen === true, releases: parsed.releases && typeof parsed.releases === 'object' ? parsed.releases : {} };
}
export function hintSeen(): boolean {
  try {
    return noticePreference().tipSeen;
  } catch {
    return true; // no storage: never risk showing it on every load
  }
}
export function markHintSeen(): void {
  try {
    localStorage.setItem(HINT_KEY, JSON.stringify({ ...noticePreference(), tipSeen: true }));
  } catch {
    /* nothing to remember with */
  }
}

/** Claim once at display time, so refresh/navigation never repeats an undismissed notice either.
 * No persistent storage => no automatic announcement; the public changelog stays available.
 */
export function claimReleaseNotice(version: string): boolean {
  try {
    const pref = noticePreference();
    if (pref.releases[version]) return false;
    pref.tipSeen = true;
    pref.releases[version] = 'seen';
    localStorage.setItem(HINT_KEY, JSON.stringify(pref));
    return true;
  } catch { return false; }
}
export function dismissReleaseNotice(version: string): void {
  try {
    const pref = noticePreference();
    pref.releases[version] = 'dismissed';
    localStorage.setItem(HINT_KEY, JSON.stringify(pref));
  } catch { /* still dismissed in this mounted view */ }
}
