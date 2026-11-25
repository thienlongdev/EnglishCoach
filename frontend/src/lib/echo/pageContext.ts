/**
 * Echo's view of "where the learner is", by typed ids taken from the page's own deep-link contract (its URL), never by
 * scraping the DOM. The server resolves every id with the learner's visibility rules (features/echo-coach). The one
 * exception is text the learner selected themself on the page: it is offered as quoted, untrusted material, at most
 * 600 characters, and only while it is recent; selections inside Echo's own window are ignored.
 */
export type EchoPageKind =
  | 'GRAMMAR_TOPIC'
  | 'READING_MATERIAL'
  | 'BILINGUAL_READING'
  | 'BOOK_EXCERPT'
  | 'BOOK_ACTIVE'
  | 'LISTENING_LESSON'
  | 'SPEAKING_SCENARIO'
  | 'SHADOWING_LESSON'
  | 'COSMOS_WORD'
  | 'EXAM_FAMILY'
  | 'MODULE';

export interface EchoBookMetaDto {
  title: string;
  author?: string;
  progressPct?: number;
  recentHighlights?: string[];
}

export interface EchoPageContext {
  kind: EchoPageKind;
  slug?: string;
  id?: number;
  word?: string;
  family?: string;
  module?: string;
  selection?: string;
  viewportAnchorChar?: number;
  playbackTimeSec?: number;
  clientVisibleExcerpt?: string;
  bookMeta?: EchoBookMetaDto;
}

const MODULES = new Set(['dashboard', 'learning-path', 'flashcards', 'reading', 'listening', 'speaking', 'writing', 'grammar', 'exams',
  'leaderboard', 'community', 'progress', 'profile', 'games', 'music', 'study-space', 'premium', 'knowledge-universe']);
const SELECTION_TTL_MS = 120_000;
let lastSelection: { text: string; at: number; href: string } | null = null;

export function pageContextFor(pathname: string, search: { get(name: string): string | null } | null, selection?: string | null): EchoPageContext | null {
  const path = (pathname || '/').split('?')[0];
  const sel = cleanSelection(selection);
  const withSel = (c: EchoPageContext): EchoPageContext => (sel ? { ...c, selection: sel } : c);
  let m = path.match(/^\/grammar\/topics\/([a-z0-9-]{1,80})\/?$/);
  if (m) return withSel({ kind: 'GRAMMAR_TOPIC', slug: m[1] });
  m = path.match(/^\/listening\/(\d{1,12})(?:\/practice)?\/?$/);
  if (m) return withSel({ kind: 'LISTENING_LESSON', id: Number(m[1]) });
  m = path.match(/^\/speaking\/shadowing\/(\d{1,12})\/?$/);
  if (m) return withSel({ kind: 'SHADOWING_LESSON', id: Number(m[1]) });
  m = path.match(/^\/speaking\/roleplay\/(\d{1,12})\/?$/);
  if (m) return withSel({ kind: 'SPEAKING_SCENARIO', id: Number(m[1]) });
  if (path === '/reading' || (path === '/' && search?.get('tab') === 'reading')) {
    const id = Number(search?.get('materialId'));
    if (Number.isSafeInteger(id) && id > 0) return withSel({ kind: 'READING_MATERIAL', id });
  }
  if (path === '/knowledge-universe') {
    const word = search?.get('word')?.trim();
    if (word && /^[A-Za-z][A-Za-z' -]{0,39}$/.test(word)) return withSel({ kind: 'COSMOS_WORD', word: word.toLowerCase() });
  }
  m = path.match(/^\/exams\/(ielts|toeic)(?:\/|$)/);
  if (m) return withSel({ kind: 'EXAM_FAMILY', family: m[1] });
  const first = path.split('/')[1] || '';
  if (MODULES.has(first)) return withSel({ kind: 'MODULE', module: first });
  return null;
}

export function cleanSelection(text?: string | null): string | undefined {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length < 2) return undefined;
  return t.length > 600 ? t.slice(0, 600) : t;
}

/** The learner's most recent page selection (outside Echo), if it is still recent. */
export function recentSelection(now = Date.now()): string | undefined {
  return lastSelection && lastSelection.href === window.location.href && now - lastSelection.at < SELECTION_TTL_MS ? lastSelection.text : undefined;
}

export function clearRecentSelection() { lastSelection = null; }

/** Remembers selections made on the page (passive; no request, no AI). Returns the cleanup. */
export function watchPageSelection(root: () => Element | null, onSelection?: (text: string) => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const onChange = () => {
    const s = document.getSelection?.();
    if (!s || s.isCollapsed || s.rangeCount === 0) return;
    const node = s.anchorNode instanceof Element ? s.anchorNode : s.anchorNode?.parentElement;
    const echo = root();
    if (node && echo && echo.contains(node)) return;
    const area = node?.closest('[data-echo-excerpt]');
    const range = s.getRangeAt(0);
    if (!area || !area.contains(range.commonAncestorContainer)) return;
    if (node?.closest?.('input, textarea, [contenteditable="true"], [data-echo-private]')) return;
    const text = cleanSelection(s.toString());
    if (text) {
      lastSelection = { text, at: Date.now(), href: window.location.href };
      onSelection?.(text);
    }
  };
  document.addEventListener('selectionchange', onChange, { passive: true } as AddEventListenerOptions);
  return () => document.removeEventListener('selectionchange', onChange);
}
