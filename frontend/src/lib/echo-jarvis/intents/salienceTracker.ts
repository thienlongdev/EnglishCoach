/**
 * Cross-Modal Discourse Salience & Anaphora Tracker for Echo JARVIS (`Plane A` + `Plane B`).
 *
 * Tracks up to 12 allowlisted `EchoSalientResource` items (`{ index: 1..12, title, href, kind }`)
 * surfaced in recent `EchoCard` (`type === 'resources'`) or navigation chips across Text Chat
 * and Voice turns, persisted per session in `sessionStorage` and wiped in `0 ms` on logout.
 *
 * Enables sub-millisecond deterministic resolution of anaphoric & ordinal follow-ups:
 * - `"open it"` / `"open that one"` / `"mở bài đó"` (when unambiguous `length === 1`)
 * - `"open the second one"` / `"mở gợi ý số 2"` / `"mở cái cuối"` (`1..12` or `last`)
 * - `"take me back"` / `"go back to the previous page"` / `"quay về chỗ cũ"` (`history_back`)
 */

import { registerUserScopedCleanup } from '@/lib/auth-cache-cleanup';
import { authEnding, subscribeAuthLifecycle } from '@/lib/auth-lifecycle';
import { type EchoClientIntent, safeEchoJarvisHref } from './actionSchema';
import { getVoiceSessionSnapshot } from './voiceSessionStore';

export interface EchoSalientResource {
  readonly index: number;
  readonly title: string;
  readonly href: string;
  readonly kind: string;
}

export interface SalienceCardItemInput {
  readonly title?: unknown;
  readonly subtitle?: unknown;
  readonly meta?: unknown;
  readonly href?: unknown;
}

export interface SalienceCardInput {
  readonly type?: unknown;
  readonly items?: readonly SalienceCardItemInput[] | null;
}

export interface SalienceActionInput {
  readonly type?: unknown;
  readonly label?: unknown;
  readonly href?: unknown;
}

export interface ResolvedSalienceMatch {
  readonly intents: EchoClientIntent[];
  readonly ackEn: string;
  readonly ackVi: string;
}

export const MAX_SALIENT_RESOURCES = 12;
const SALIENCE_STORAGE_PREFIX = 'ec_echo_salience:';

const memorySalienceByKey = new Map<string, readonly EchoSalientResource[]>();

function sanitizeKeyToken(raw: string | number | null | undefined): string {
  return String(raw ?? '').replace(/[^\w-]/g, '');
}

function resolveUserKey(explicitUserId?: string | number | null): string {
  const uid = sanitizeKeyToken(explicitUserId ?? getVoiceSessionSnapshot().userId);
  return uid || 'anon';
}

function makeStorageKey(sessionId?: number | string | null, userId?: string | number | null): string {
  const uid = resolveUserKey(userId);
  const sid = sanitizeKeyToken(sessionId) || 'active';
  return `${SALIENCE_STORAGE_PREFIX}u${uid}:s${sid}`;
}

export function inferSalientResourceKind(href: string, rawKind?: unknown): string {
  if (typeof rawKind === 'string') {
    const cleaned = rawKind.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (cleaned && cleaned.length <= 32) return cleaned;
  }
  const path = (href || '').split('?')[0];
  if (path.startsWith('/reading')) return 'reading';
  if (path.startsWith('/listening')) return 'listening';
  if (path.startsWith('/speaking')) return 'speaking';
  if (path.startsWith('/grammar')) return 'grammar';
  if (path.startsWith('/writing')) return 'writing';
  if (path.startsWith('/flashcards')) return 'flashcards';
  if (path.startsWith('/exams')) return 'exams';
  if (path.startsWith('/knowledge-universe')) return 'vocabulary';
  if (path.startsWith('/study-space')) return 'study_space';
  if (path.startsWith('/learning-path')) return 'learning_path';
  return 'resource';
}

/**
 * Validates and normalizes an array of candidate salient resources (`index: 1..12`, allowlisted `href`).
 */
export function sanitizeSalientResources(rawList: unknown): EchoSalientResource[] {
  if (!Array.isArray(rawList) || rawList.length === 0) return [];
  const deduped: Array<{ title: string; href: string; kind: string }> = [];
  const seenHrefs = new Set<string>();

  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const safeHref = safeEchoJarvisHref(rec.href);
    if (!safeHref || seenHrefs.has(safeHref)) continue;
    const rawTitle = typeof rec.title === 'string' ? rec.title.trim() : '';
    const title = (rawTitle || safeHref).slice(0, 160);
    const kind = inferSalientResourceKind(safeHref, rec.kind);
    seenHrefs.add(safeHref);
    deduped.push({ title, href: safeHref, kind });
    if (deduped.length >= MAX_SALIENT_RESOURCES) break;
  }

  return deduped.map((entry, idx) =>
    Object.freeze({
      index: idx + 1,
      title: entry.title,
      href: entry.href,
      kind: entry.kind,
    }),
  );
}

const ITEM_DEEP_LINK_HREF_RE =
  /(?:[?&](?:materialId|id|word|deck)=|\/(?:listening|roleplay|shadowing)\/\d+|\/grammar\/topics\/[a-z0-9-]+)/i;

function isHubOnlySalienceHref(href: string): boolean {
  return !ITEM_DEEP_LINK_HREF_RE.test(href);
}

function hasConcreteSessionId(sessionId?: number | string | null): boolean {
  if (sessionId === undefined || sessionId === null) return false;
  const token = sanitizeKeyToken(sessionId);
  return Boolean(token) && token !== 'active';
}

/**
 * Extracts allowlisted `EchoSalientResource` items from `EchoCard[]` (`type === 'resources'`)
 * and `EchoAction[]` (`type === 'navigate'`) across Text Chat and Voice responses.
 * Skips hub-only shared URLs (e.g. `"/reading?section=bilingual"`) when multiple items in the
 * same card share the exact same `href` so 5 bilingual cards never collapse into a misleading
 * 1-item `"open it"` target!
 */
export function extractSalientResources(
  cards?: readonly SalienceCardInput[] | null,
  actions?: readonly SalienceActionInput[] | null,
): EchoSalientResource[] {
  const candidates: Array<{ title: string; href: string; kind: string }> = [];
  const skippedSharedHubHrefs = new Set<string>();

  if (Array.isArray(cards)) {
    for (const card of cards) {
      if (!card || card.type !== 'resources' || !Array.isArray(card.items)) continue;
      const hrefCounts = new Map<string, number>();
      for (const item of card.items) {
        if (!item) continue;
        const safeHref = safeEchoJarvisHref(item.href);
        if (!safeHref) continue;
        hrefCounts.set(safeHref, (hrefCounts.get(safeHref) ?? 0) + 1);
      }
      for (const item of card.items) {
        if (!item) continue;
        const safeHref = safeEchoJarvisHref(item.href);
        if (!safeHref) continue;
        if (((hrefCounts.get(safeHref) ?? 0) > 1 || card.items.length > 1) && isHubOnlySalienceHref(safeHref)) {
          skippedSharedHubHrefs.add(safeHref);
          continue;
        }
        const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : safeHref;
        candidates.push({
          title,
          href: safeHref,
          kind: inferSalientResourceKind(safeHref, item.meta),
        });
      }
    }
  }

  // Only fall back to navigation action chips when resource cards yielded zero item targets,
  // and never resurrect a shared hub URL that was just skipped from a multi-item card.
  if (candidates.length === 0 && Array.isArray(actions)) {
    for (const action of actions) {
      if (!action || (action.type !== undefined && action.type !== 'navigate')) continue;
      const safeHref = safeEchoJarvisHref(action.href);
      if (!safeHref || skippedSharedHubHrefs.has(safeHref)) continue;
      const label = typeof action.label === 'string' && action.label.trim() ? action.label.trim() : safeHref;
      candidates.push({
        title: label,
        href: safeHref,
        kind: inferSalientResourceKind(safeHref, 'action'),
      });
    }
  }

  return sanitizeSalientResources(candidates);
}

export function clearActiveSalientResources(userId?: string | number | null): void {
  const activeKey = makeStorageKey('active', userId);
  memorySalienceByKey.delete(activeKey);
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      window.sessionStorage.removeItem(activeKey);
    } catch {
      // Ignore storage error.
    }
  }
}

export function setSessionSalientResources(
  resources: readonly EchoSalientResource[],
  sessionId?: number | string | null,
  userId?: string | number | null,
): readonly EchoSalientResource[] {
  const clean = Object.freeze(sanitizeSalientResources(resources));
  const key = makeStorageKey(sessionId, userId);

  if (clean.length === 0) {
    memorySalienceByKey.delete(key);
    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        window.sessionStorage.removeItem(key);
      } catch {
        // Ignore storage error.
      }
    }
    if (!hasConcreteSessionId(sessionId)) {
      clearActiveSalientResources(userId);
    }
    return clean;
  }

  memorySalienceByKey.set(key, clean);

  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      const serialized = JSON.stringify(clean);
      window.sessionStorage.setItem(key, serialized);
    } catch {
      // Storage quota/unavailable: in-memory map remains authoritative for this tab.
    }
  }
  return clean;
}

export function getSessionSalientResources(
  sessionId?: number | string | null,
  userId?: string | number | null,
): readonly EchoSalientResource[] {
  const primaryKey = makeStorageKey(sessionId, userId);
  const memPrimary = memorySalienceByKey.get(primaryKey);
  if (memPrimary && memPrimary.length > 0) return memPrimary;

  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      const raw = window.sessionStorage.getItem(primaryKey);
      if (raw) {
        const parsed = Object.freeze(sanitizeSalientResources(JSON.parse(raw)));
        if (parsed.length > 0) {
          memorySalienceByKey.set(primaryKey, parsed);
          return parsed;
        }
      }
    } catch {
      // Ignore corrupt sessionStorage entry.
    }
  }

  if (hasConcreteSessionId(sessionId)) {
    const activeKey = makeStorageKey('active', userId);
    const memActive = memorySalienceByKey.get(activeKey);
    if (memActive && memActive.length > 0) return memActive;
    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        const rawActive = window.sessionStorage.getItem(activeKey);
        if (rawActive) {
          const parsed = Object.freeze(sanitizeSalientResources(JSON.parse(rawActive)));
          if (parsed.length > 0) {
            memorySalienceByKey.set(activeKey, parsed);
            return parsed;
          }
        }
      } catch {
        // Ignore storage error.
      }
    }
  }

  return [];
}

export function promoteActiveSalientResourcesToSession(
  sessionId: number | string,
  userId?: string | number | null,
): void {
  const existing = getSessionSalientResources(sessionId, userId);
  const active = getSessionSalientResources('active', userId);
  if (existing.length === 0 && active.length > 0) {
    setSessionSalientResources(active, sessionId, userId);
  }
  // Clear transient `'active'` slot once bound to a concrete sessionId so a subsequent `newChat()` starts clean!
  clearActiveSalientResources(userId);
}

export function clearAllSalientResources(): void {
  memorySalienceByKey.clear();
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      const keysToDelete: string[] = [];
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const k = window.sessionStorage.key(i);
        if (k && k.startsWith(SALIENCE_STORAGE_PREFIX)) {
          keysToDelete.push(k);
        }
      }
      for (const k of keysToDelete) {
        window.sessionStorage.removeItem(k);
      }
    } catch {
      // Ignore storage error.
    }
  }
}

registerUserScopedCleanup(clearAllSalientResources);
subscribeAuthLifecycle(() => {
  if (authEnding()) {
    clearAllSalientResources();
  }
});

// ---------------------------------------------------------------------------
// Deterministic Anaphora & Ordinal Resolution (`< 0.1 ms`)
// ---------------------------------------------------------------------------

const BACK_ANAPHORA_RE =
  /^(?:take me back(?: there)?|bring me back(?: there)?|go back there|go back to (?:the )?(?:previous|prior|last) (?:page|screen|module|place)|return to (?:the )?(?:previous|last) (?:page|screen)|quay lai trang truoc|quay ve trang truoc|tro lai trang truoc|tro ve trang truoc|quay ve cho cu|quay lai cho cu|tro ve cho cu|ve lai cho cu)$/;

const SINGULAR_ANAPHORA_RE =
  /^(?:(?:open|go to|start|try|launch|show|view|pick|choose|select)\s+(?:it|that|that one|this one|that lesson|that passage|that item|that card|that scenario)|(?:mo|vao|chon|xem|hoc|luyen|bat)\s+(?:no|cai do|cai nay|bai do|bai nay|muc do|goi y do|phan do))$/;

const EN_ORDINAL_MAP: Readonly<Record<string, number | 'last'>> = {
  first: 1,
  '1st': 1,
  one: 1,
  '1': 1,
  second: 2,
  '2nd': 2,
  two: 2,
  '2': 2,
  third: 3,
  '3rd': 3,
  three: 3,
  '3': 3,
  fourth: 4,
  '4th': 4,
  four: 4,
  '4': 4,
  fifth: 5,
  '5th': 5,
  five: 5,
  '5': 5,
  sixth: 6,
  '6th': 6,
  '6': 6,
  seventh: 7,
  '7th': 7,
  '7': 7,
  eighth: 8,
  '8th': 8,
  '8': 8,
  ninth: 9,
  '9th': 9,
  '9': 9,
  tenth: 10,
  '10th': 10,
  '10': 10,
  eleventh: 11,
  '11th': 11,
  '11': 11,
  twelfth: 12,
  '12th': 12,
  '12': 12,
  last: 'last',
  final: 'last',
};

const VI_ORDINAL_MAP: Readonly<Record<string, number | 'last'>> = {
  'dau tien': 1,
  'dau': 1,
  'thu nhat': 1,
  'thu 1': 1,
  'so 1': 1,
  'so mot': 1,
  '1': 1,
  'thu hai': 2,
  'thu 2': 2,
  'so 2': 2,
  'so hai': 2,
  '2': 2,
  'thu ba': 3,
  'thu 3': 3,
  'so 3': 3,
  'so ba': 3,
  '3': 3,
  'thu tu': 4,
  'thu bon': 4,
  'thu 4': 4,
  'so 4': 4,
  'so bon': 4,
  'so tu': 4,
  '4': 4,
  'thu nam': 5,
  'thu 5': 5,
  'so 5': 5,
  'so nam': 5,
  '5': 5,
  'so 6': 6,
  'thu 6': 6,
  '6': 6,
  'so 7': 7,
  'thu 7': 7,
  '7': 7,
  'so 8': 8,
  'thu 8': 8,
  '8': 8,
  'so 9': 9,
  'thu 9': 9,
  '9': 9,
  'so 10': 10,
  'thu 10': 10,
  '10': 10,
  'so 11': 11,
  'thu 11': 11,
  '11': 11,
  'so 12': 12,
  'thu 12': 12,
  '12': 12,
  cuoi: 'last',
  'cuoi cung': 'last',
};

const EN_ORDINAL_UTTERANCE_RE =
  /^(?:open|go to|start|try|launch|show|view|pick|choose|select|take me to)\s+(?:(?:the\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|ninth|9th|tenth|10th|eleventh|11th|twelfth|12th|last|final)(?:\s+(?:one|item|lesson|passage|article|card|option|choice|suggestion|recommendation|scenario|topic|exercise))?|(?:option|item|number|suggestion|recommendation|choice|lesson|passage)\s+#?(1[0-2]|[1-9]|one|two|three|four|five))$/;

const VI_ORDINAL_UTTERANCE_RE =
  /^(?:mo|vao|chon|xem|hoc|luyen|bat|di toi|chuyen sang|chuyen qua)\s+(?:(?:bai(?:\s+(?:hoc|doc|nghe|tap))?|cai|goi y|lua chon|muc|phan|ket qua|de xuat)\s+)?(dau tien|thu nhat|thu hai|thu ba|thu tu|thu bon|thu nam|cuoi cung|cuoi|(?:thu|so)\s+(?:1[0-2]|[1-9]|mot|hai|ba|bon|tu|nam))$/;

function buildResolvedSalienceNavigation(target: EchoSalientResource): ResolvedSalienceMatch {
  const safeHref = safeEchoJarvisHref(target.href);
  if (!safeHref) {
    throw new Error('salient_href_not_allowlisted');
  }
  const title = target.title || safeHref;
  return {
    intents: [{ kind: 'navigate', href: safeHref, label: title.slice(0, 80) }],
    ackEn: `Opening "${title}".`,
    ackVi: `Đang mở "${title}".`,
  };
}

/**
 * Resolves an ASCII-folded cleaned single clause against `history_back` anaphora or
 * session `salientResources` (`index: 1..12` or `last`).
 */
export function resolveSalienceUtterance(
  cleanedFoldedClause: string,
  salientResources?: readonly EchoSalientResource[] | null,
): ResolvedSalienceMatch | null {
  if (!cleanedFoldedClause) return null;

  if (BACK_ANAPHORA_RE.test(cleanedFoldedClause)) {
    return {
      intents: [{ kind: 'history_back' }],
      ackEn: 'Going back to the previous page.',
      ackVi: 'Đang quay lại trang trước.',
    };
  }

  const list = sanitizeSalientResources(salientResources ?? []);
  if (list.length === 0) return null;

  if (SINGULAR_ANAPHORA_RE.test(cleanedFoldedClause)) {
    if (list.length === 1) {
      return buildResolvedSalienceNavigation(list[0]);
    }
    return null;
  }

  let selector: number | 'last' | undefined;

  const enMatch = EN_ORDINAL_UTTERANCE_RE.exec(cleanedFoldedClause);
  if (enMatch) {
    const tok = (enMatch[1] || enMatch[2] || '').trim();
    selector = EN_ORDINAL_MAP[tok];
  } else {
    const viMatch = VI_ORDINAL_UTTERANCE_RE.exec(cleanedFoldedClause);
    if (viMatch) {
      const tok = (viMatch[1] || '').trim();
      selector = VI_ORDINAL_MAP[tok];
    }
  }

  if (selector === undefined) return null;

  const chosen =
    selector === 'last'
      ? list[list.length - 1]
      : list.find((r) => r.index === selector) ?? list[selector - 1];

  if (!chosen) return null;
  return buildResolvedSalienceNavigation(chosen);
}
