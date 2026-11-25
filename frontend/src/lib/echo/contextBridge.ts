/**
 * Typed Workspace Context Bridge for Echo JARVIS (`Contract D`, `10 §AB`).
 *
 * Lets active workspace modules (`InteractiveReader`, `BilingualReader`, `ReadingDashboard`,
 * `MyBooksTab`, `LessonWorkspace`, `Speaking`) publish strictly typed, bounded state
 * (active material/lesson IDs, settled viewport character offset, playback second, or
 * My Books reader open state) with ZERO DOM scraping and ZERO persistence of private book content.
 *
 * PRIVACY LAW (`10 §AB`):
 * - `bookMeta` and `clientVisibleExcerpt` are NEVER included on passive calls
 *   (`session.start`, `session.update`, `/warm`, default `getEchoWorkspaceContextSnapshot()`).
 * - They are attached ONLY when `includeOnDemandBook: true` is passed on an explicit learner
 *   turn, sanitized of control characters and `[ECHO_META]` markers.
 * - All in-memory context is wiped at 0 ms on logout via `registerUserScopedCleanup`.
 */

import { registerUserScopedCleanup } from '@/lib/auth-cache-cleanup';
import { authEnding, subscribeAuthLifecycle } from '@/lib/auth-lifecycle';
import { setOverBookReader as syncStoreOverBookReader } from '@/lib/echo-jarvis/intents/voiceSessionStore';
import {
  cleanSelection,
  pageContextFor,
  recentSelection,
  type EchoBookMetaDto,
  type EchoPageContext,
  type EchoPageKind,
} from './pageContext';

export interface EchoWorkspaceContextEntry {
  source: string;
  kind?: EchoPageKind;
  id?: number;
  slug?: string;
  module?: string;
  viewportAnchorChar?: number;
  playbackTimeSec?: number;
  bookMeta?: EchoBookMetaDto | null;
  clientVisibleExcerpt?: string | null;
  updatedAt: number;
}

export interface EchoWorkspaceContextInput {
  source: string;
  kind?: EchoPageKind;
  id?: number;
  slug?: string;
  module?: string;
  viewportAnchorChar?: number;
  playbackTimeSec?: number;
  bookMeta?: EchoBookMetaDto | null;
  clientVisibleExcerpt?: string | null;
  overBookReader?: boolean;
}

export interface EchoWorkspaceContextSnapshotOptions {
  pathname?: string;
  search?: { get(name: string): string | null } | URLSearchParams | null;
  selection?: string | null;
  /**
   * STRICT `10 §AB` opt-in gate: must be `false` (default) for `session.start`, `session.update`,
   * `/warm`, and all passive telemetry. Pass `true` ONLY when sending an explicit user turn!
   */
  includeOnDemandBook?: boolean;
}

const MAX_CLIENT_EXCERPT_CHARS = 2_400;
const MAX_HIGHLIGHTS = 5;
const MAX_HIGHLIGHT_CHARS = 240;

const SERVER_OWNED_KINDS = new Set<EchoPageKind>([
  'READING_MATERIAL',
  'BILINGUAL_READING',
  'LISTENING_LESSON',
  'GRAMMAR_TOPIC',
  'SPEAKING_SCENARIO',
  'SHADOWING_LESSON',
]);

const entriesBySource = new Map<string, EchoWorkspaceContextEntry>();
let overBookReaderFlag = false;

function sanitizeUntrustedText(raw: string | null | undefined, maxLen: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw
    .replace(/\[ECHO_META[^\]]*\]/gi, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function sanitizeBookMeta(meta: EchoBookMetaDto | null | undefined): EchoBookMetaDto | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const title = sanitizeUntrustedText(meta.title, 160);
  if (!title) return undefined;
  const author = sanitizeUntrustedText(meta.author, 120);
  const progressPct =
    typeof meta.progressPct === 'number' && Number.isFinite(meta.progressPct)
      ? Math.max(0, Math.min(100, Math.round(meta.progressPct)))
      : undefined;
  const recentHighlights = Array.isArray(meta.recentHighlights)
    ? meta.recentHighlights
        .map((item) => sanitizeUntrustedText(item, MAX_HIGHLIGHT_CHARS))
        .filter((item): item is string => Boolean(item))
        .slice(0, MAX_HIGHLIGHTS)
    : undefined;
  return {
    title,
    ...(author ? { author } : {}),
    ...(progressPct !== undefined ? { progressPct } : {}),
    ...(recentHighlights && recentHighlights.length > 0 ? { recentHighlights } : {}),
  };
}

function clampNonNegInt(value: number | undefined, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(max, Math.floor(value));
}

export function setOverBookReader(open: boolean): void {
  const next = Boolean(open);
  overBookReaderFlag = next;
  syncStoreOverBookReader(next);
}

export function isOverBookReader(): boolean {
  return overBookReaderFlag;
}

export function publishEchoWorkspaceContext(partial: EchoWorkspaceContextInput): void {
  const source = typeof partial?.source === 'string' ? partial.source.trim().slice(0, 64) : '';
  if (!source) return;

  if (partial.overBookReader !== undefined) {
    setOverBookReader(partial.overBookReader);
  }

  const prev = entriesBySource.get(source);
  const nextEntry: EchoWorkspaceContextEntry = {
    source,
    kind: partial.kind ?? prev?.kind,
    id:
      partial.id !== undefined
        ? Number.isSafeInteger(partial.id) && partial.id > 0
          ? partial.id
          : undefined
        : prev?.id,
    slug: partial.slug !== undefined ? partial.slug.trim().slice(0, 80) || undefined : prev?.slug,
    module: partial.module !== undefined ? partial.module.trim().slice(0, 48) || undefined : prev?.module,
    viewportAnchorChar:
      partial.viewportAnchorChar !== undefined
        ? clampNonNegInt(partial.viewportAnchorChar, 5_000_000)
        : prev?.viewportAnchorChar,
    playbackTimeSec:
      partial.playbackTimeSec !== undefined
        ? clampNonNegInt(partial.playbackTimeSec, 86_400)
        : prev?.playbackTimeSec,
    bookMeta:
      partial.bookMeta === null
        ? null
        : partial.bookMeta !== undefined
          ? sanitizeBookMeta(partial.bookMeta) ?? null
          : prev?.bookMeta,
    clientVisibleExcerpt:
      partial.clientVisibleExcerpt === null
        ? null
        : partial.clientVisibleExcerpt !== undefined
          ? sanitizeUntrustedText(partial.clientVisibleExcerpt, MAX_CLIENT_EXCERPT_CHARS) ?? null
          : prev?.clientVisibleExcerpt,
    updatedAt: Date.now(),
  };
  entriesBySource.set(source, nextEntry);
}

export function clearEchoWorkspaceContext(source?: string): void {
  if (!source) {
    entriesBySource.clear();
    setOverBookReader(false);
    return;
  }
  entriesBySource.delete(source);
  if (source === 'mybooks' || source === 'book-reader') {
    setOverBookReader(false);
  }
}

function resetContextBridgeOnLogout(): void {
  entriesBySource.clear();
  overBookReaderFlag = false;
  syncStoreOverBookReader(false);
}

registerUserScopedCleanup(resetContextBridgeOnLogout);
subscribeAuthLifecycle(() => {
  if (authEnding()) {
    resetContextBridgeOnLogout();
  }
});

/**
 * Returns the freshest entry whose kind/module fits the current pathname,
 * preventing stale reading/listening entries from bleeding onto unrelated routes.
 */
function pickRelevantEntry(pathname: string): EchoWorkspaceContextEntry | null {
  const path = (pathname || '/').split('?')[0];
  let best: EchoWorkspaceContextEntry | null = null;
  for (const entry of entriesBySource.values()) {
    const matchesRoute =
      (entry.kind === 'BOOK_ACTIVE' && overBookReaderFlag && path.startsWith('/reading')) ||
      ((entry.kind === 'READING_MATERIAL' || entry.kind === 'BILINGUAL_READING') && path.startsWith('/reading')) ||
      (entry.kind === 'LISTENING_LESSON' && path.startsWith('/listening')) ||
      ((entry.kind === 'SPEAKING_SCENARIO' || entry.kind === 'SHADOWING_LESSON') && path.startsWith('/speaking')) ||
      (entry.kind === 'GRAMMAR_TOPIC' && path.startsWith('/grammar')) ||
      (!entry.kind && entry.module && path.startsWith(`/${entry.module}`));
    if (!matchesRoute) continue;
    if (!best || entry.updatedAt >= best.updatedAt) {
      best = entry;
    }
  }
  return best;
}

/**
 * Builds the canonical `EchoPageContext` payload combining URL deep-links and active
 * workspace context bridge entries. Enforces strict `10 §AB` privacy: local My Books
 * metadata (`bookMeta`) and `clientVisibleExcerpt` are stripped UNLESS `includeOnDemandBook === true`.
 */
export function getEchoWorkspaceContextSnapshot(
  opts: EchoWorkspaceContextSnapshotOptions = {},
): EchoPageContext | null {
  const pathname =
    opts.pathname ?? (typeof window !== 'undefined' ? window.location.pathname || '/' : '/');
  const search =
    opts.search !== undefined
      ? opts.search
      : typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search)
        : null;
  const selection = cleanSelection(
    opts.selection !== undefined
      ? opts.selection
      : opts.includeOnDemandBook === false
        ? undefined
        : typeof window !== 'undefined'
          ? recentSelection()
          : undefined,
  );
  const includeOnDemandBook = opts.includeOnDemandBook === true || Boolean(selection);

  const base = pageContextFor(pathname, search, selection);
  const active = pickRelevantEntry(pathname);

  if (!active) {
    return base;
  }

  // Local My Books (`BOOK_ACTIVE` / `BOOK_EXCERPT`): strictly on-demand per `10 §AB`!
  if (active.kind === 'BOOK_ACTIVE' || active.kind === 'BOOK_EXCERPT') {
    if (!includeOnDemandBook) {
      // Passive session.start / session.update / warm MUST NEVER carry private book titles or excerpts.
      return base ?? { kind: 'MODULE', module: 'reading' };
    }
    const bookMeta = active.bookMeta ?? undefined;
    const excerpt = active.clientVisibleExcerpt ?? undefined;
    if (!bookMeta && !excerpt && !selection) {
      return base ?? { kind: 'MODULE', module: 'reading' };
    }
    return {
      kind: selection || excerpt ? 'BOOK_EXCERPT' : 'BOOK_ACTIVE',
      ...(selection ? { selection } : {}),
      ...(bookMeta ? { bookMeta } : {}),
      ...(excerpt ? { clientVisibleExcerpt: excerpt } : {}),
    };
  }

  // Server-owned content (`READING_MATERIAL`, `BILINGUAL_READING`, `LISTENING_LESSON`, etc.):
  // NEVER send `clientVisibleExcerpt` or `bookMeta` — only authoritative DB id + viewport/playback anchor!
  if (active.kind && SERVER_OWNED_KINDS.has(active.kind)) {
    const resolvedId = active.id ?? base?.id;
    const resolvedSlug = active.slug ?? base?.slug;
    if (resolvedId !== undefined || resolvedSlug !== undefined) {
      return {
        kind: active.kind,
        ...(resolvedId !== undefined ? { id: resolvedId } : {}),
        ...(resolvedSlug ? { slug: resolvedSlug } : {}),
        ...(selection ? { selection } : {}),
        ...(active.viewportAnchorChar !== undefined ? { viewportAnchorChar: active.viewportAnchorChar } : {}),
        ...(active.playbackTimeSec !== undefined ? { playbackTimeSec: active.playbackTimeSec } : {}),
      };
    }
  }

  if (!base) return null;
  return {
    ...base,
    ...(active.viewportAnchorChar !== undefined ? { viewportAnchorChar: active.viewportAnchorChar } : {}),
    ...(active.playbackTimeSec !== undefined ? { playbackTimeSec: active.playbackTimeSec } : {}),
  };
}

const ON_DEMAND_BOOK_OR_PASSAGE_RE =
  /\b(?:this|page|passage|book|chapter|paragraph|sentence|excerpt|highlighted|highlight|vocabulary in this|difficult words|trang nay|bai nay|bai doc nay|doan nay|doan van nay|cau nay|cuon sach|chuong nay|sach nay|cho dang doc|dang doc gi|tu kho trong bai|tu vung trong bai)\b/i;

/**
 * Helper to decide whether an explicit user turn is asking about the currently open local book
 * or excerpt so `includeOnDemandBook` is only enabled when truly requested by the learner (`10 §AB`).
 */
export function utteranceReferencesBookOrPassage(text: string): boolean {
  if (!text) return false;
  const folded = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd');
  return ON_DEMAND_BOOK_OR_PASSAGE_RE.test(folded);
}

/**
 * Emits the Contract D post-navigation module readiness handshake (`ec:module-ready`)
 * consumed by `dagExecutor.ts` before executing Phase-2 module intents.
 */
export function dispatchEchoModuleReady(module: string, detail?: Record<string, unknown>): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(
    new CustomEvent('ec:module-ready', {
      detail: { module, ...(detail ?? {}), timestamp: Date.now() },
    }),
  );
}
