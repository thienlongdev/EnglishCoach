import { apiClient } from '@/services/api-client';
import { completeReading, openReadingSession } from '@/services/readingApi';
import { BookStore, newId } from '@/components/features/reading/books/store/bookStore';
import type { Annotation, FlowSource, Locator } from '@/components/features/reading/books/engine/types';
import type { BilingualReadingDetail } from '@/types/bilingualReading';
import type { BookRef } from './types';

/**
 * What a book in the room really holds, from where it really lives: My Books on this device, a reading or a bilingual passage on the server. Reading it here moves the same position,
 * the same bookmarks and the same highlights the normal readers use, so the two never disagree about where the learner is. No text is made up: a book with nothing readable says so.
 */
export interface Para { text: string; offset: number; vi?: string }
export interface Mark { kind: 'highlight' | 'bookmark'; chapter: number; start: number; end: number; id: string }
export interface BookSession {
  title: string;
  author: string;
  ref: BookRef | null;
  /** A book of pictures of pages (a PDF) rather than text this page lays out. */
  fixedPages: number | null;
  /** It has Vietnamese beside its English. */
  bilingual: boolean;
  chapters: number;
  start: { chapter: number; offset: number };
  paragraphs(chapter: number): Promise<Para[]>;
  label(chapter: number): string;
  /** Draws one fixed page into a canvas, sized to it. */
  drawPage?(index: number, canvas: HTMLCanvasElement): Promise<void>;
  save(chapter: number, offset: number, snippet: string, progress: number): void;
  marks(): Promise<Mark[]>;
  bookmark(chapter: number, offset: number, snippet: string): Promise<boolean>;
  highlight(chapter: number, start: number, end: number, text: string): Promise<Mark | null>;
  /** The last page was reached: the server may record a reading as finished, by its own rules. */
  reachedEnd(): void;
  close(): void;
}

const paragraphsOf = (text: string): Para[] => {
  const out: Para[] = [];
  const re = /[^\n]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) { const t = m[0]; if (t.trim()) out.push({ text: t, offset: m.index }); }
  return out;
};

const ignore = () => { /* Nothing to keep here. */ };
const plain = (title: string, author: string, ref: BookRef | null, chapters: Para[][], start: { chapter: number; offset: number }, more: Partial<BookSession> = {}): BookSession => ({
  title, author, ref, fixedPages: null, bilingual: false, chapters: chapters.length, start,
  paragraphs: async i => chapters[i] ?? [], label: () => '', save: ignore, marks: async () => [], bookmark: async () => false, highlight: async () => null, reachedEnd: ignore, close: ignore, ...more,
});

/** The learner's own notes, for a notebook. */
export const notesSession = (title: string, text: string) => plain(title, '', null, [paragraphsOf(text)], { chapter: 0, offset: 0 });
/** What a plain book with no chosen content says. */
export const emptySession = (title: string) => plain(title, '', null, [[]], { chapter: 0, offset: 0 });

async function myBook(account: string, id: string): Promise<BookSession | null> {
  const store = await BookStore.open(account);
  let source: FlowSource | null = null, pdfDoc: { numPages: number; getPage(n: number): Promise<unknown>; loadingTask: { destroy(): Promise<void> } } | null = null;
  try {
    const meta = await store.getBook(id), file = await store.getFile(id);
    if (!meta || !file) { store.close(); return null; }
    const position = await store.getPosition(id).catch(() => undefined);
    let annotations = await store.annotations(id).catch(() => [] as Annotation[]);
    const toMark = (a: Annotation): Mark | null => a.kind === 'bookmark' ? { kind: 'bookmark', chapter: a.loc?.s ?? a.page ?? 0, start: a.loc?.o ?? 0, end: a.loc?.o ?? 0, id: a.id }
      : a.range ? { kind: 'highlight', chapter: a.range.s, start: a.range.start, end: a.range.end, id: a.id } : null;
    const close = () => { source?.dispose(); if (pdfDoc) void pdfDoc.loadingTask.destroy(); store.close(); };
    const common = {
      marks: async () => annotations.map(toMark).filter((m): m is Mark => !!m),
      bookmark: async (chapter: number, offset: number, snippet: string) => {
        const had = annotations.find(a => a.kind === 'bookmark' && (a.loc?.s ?? a.page) === chapter && Math.abs((a.loc?.o ?? 0) - offset) < 400);
        if (had) { await store.deleteAnnotation(had.id); annotations = annotations.filter(a => a !== had); return false; }
        const now = Date.now();
        const a: Annotation = meta.format === 'pdf' ? { id: newId(), bookId: id, kind: 'bookmark', createdAt: now, updatedAt: now, page: chapter, loc: { s: chapter, o: 0 }, text: snippet.slice(0, 120) } : { id: newId(), bookId: id, kind: 'bookmark', createdAt: now, updatedAt: now, loc: { s: chapter, o: offset, t: snippet.slice(0, 80) }, text: snippet.slice(0, 120) };
        await store.putAnnotation(a); annotations = [...annotations, a];
        return true;
      },
      highlight: async (chapter: number, start: number, end: number, text: string) => {
        const now = Date.now();
        const a: Annotation = { id: newId(), bookId: id, kind: 'highlight', createdAt: now, updatedAt: now, range: { s: chapter, start, end }, text, color: 'yellow' };
        await store.putAnnotation(a); annotations = [...annotations, a];
        return toMark(a);
      },
      save: (chapter: number, offset: number, snippet: string, progress: number) => {
        const loc: Locator = meta.format === 'pdf' ? { s: chapter, o: 0 } : { s: chapter, o: offset, t: snippet.slice(0, 80) };
        void store.savePosition({ bookId: id, loc, progress, updatedAt: Date.now() }).catch(ignore);
      },
    };
    const start = { chapter: position?.loc.s ?? 0, offset: position?.loc.o ?? 0 };
    if (meta.format === 'pdf') {
      const mod = await import('@/components/features/reading/books/engine/pdf');
      const doc = await mod.openPdfDocument(file);
      pdfDoc = doc as unknown as typeof pdfDoc;
      return {
        title: meta.title, author: meta.author, ref: { source: 'mybooks', id }, fixedPages: doc.numPages, bilingual: false, chapters: doc.numPages, start, label: () => '', reachedEnd: ignore, close,
        paragraphs: async () => [],
        drawPage: async (index, canvas) => {
          const page = await doc.getPage(index + 1);
          const base = page.getViewport({ scale: 1 }), scale = Math.min(canvas.width / base.width, canvas.height / base.height), vp = page.getViewport({ scale });
          const off = document.createElement('canvas'); off.width = Math.ceil(vp.width); off.height = Math.ceil(vp.height);
          await page.render({ canvas: off, canvasContext: off.getContext('2d')!, viewport: vp }).promise;
          const c = canvas.getContext('2d')!;
          c.fillStyle = '#fbf8f0'; c.fillRect(0, 0, canvas.width, canvas.height);
          c.drawImage(off, (canvas.width - off.width) / 2, (canvas.height - off.height) / 2);
        },
        ...common,
      };
    }
    if (meta.format === 'epub') {
      const { openEpubPackage, EpubSource } = await import('@/components/features/reading/books/engine/epub');
      source = new EpubSource(await openEpubPackage(file));
    } else {
      const { TxtSource, decodeText } = await import('@/components/features/reading/books/engine/txt');
      source = new TxtSource(meta.title, meta.author, decodeText(new Uint8Array(await file.arrayBuffer())));
    }
    const flow = source;
    const totalWeight = flow.spine.reduce((n, s) => n + (s.weight || 1), 0) || 1;
    const labels = new Map<number, string>();
    const walk = (items: FlowSource['toc']) => { for (const t of items) { if (!labels.has(t.target.s)) labels.set(t.target.s, t.label); walk(t.children); } };
    walk(flow.toc);
    return {
      title: meta.title, author: meta.author, ref: { source: 'mybooks', id }, fixedPages: null, bilingual: false, chapters: flow.spine.length, start,
      paragraphs: async i => paragraphsOf(await flow.chapterText(i)),
      label: i => labels.get(i) ?? '',
      reachedEnd: ignore, close, ...common,
      save: (chapter, offset, snippet, within) => {
        // Where in the whole book: the chapters before it by their weight, and how far into this one.
        let before = 0;
        for (let i = 0; i < chapter; i++) before += flow.spine[i]?.weight || 1;
        common.save(chapter, offset, snippet, Math.min(1, (before + (flow.spine[chapter]?.weight || 1) * within) / totalWeight));
      },
    };
  } catch (e) {
    source?.dispose(); store.close();
    throw e;
  }
}

async function readingMaterial(id: number): Promise<BookSession | null> {
  const { data } = await apiClient.get<{ id: number; title?: string; contentText?: string }>(`/reading/materials/${id}`);
  if (!data.contentText?.trim()) return null;
  const key = `ec_reading_progress_${id}`, paras = paragraphsOf(data.contentText), total = data.contentText.length || 1;
  let saved = 0;
  try { saved = Number(localStorage.getItem(key) ?? 0) || 0; } catch { /* Starts at the beginning. */ }
  // The server's own clock for this reading: what it records as finished is its decision, as in the normal reader.
  void openReadingSession(id).catch(ignore);
  return plain(data.title ?? '', '', { source: 'reading', id }, [paras], { chapter: 0, offset: Math.floor(total * Math.min(100, Math.max(0, saved)) / 100) }, {
    save: (_c, _o, _s, progress) => { try { localStorage.setItem(key, String(Math.round(progress * 100))); } catch { /* Stays for this visit. */ } },
    reachedEnd: () => { void completeReading(id).catch(ignore); },
  });
}

async function bilingualPassage(id: number): Promise<BookSession | null> {
  const { data } = await apiClient.get<BilingualReadingDetail>(`/reading/bilingual/materials/${id}`);
  if (!data.segments?.length) return null;
  const key = `ec_bilingual_position_${id}`;
  let start = 0, joined = 0;
  try { start = Number(localStorage.getItem(key) ?? 0) || 0; } catch { /* Starts at the beginning. */ }
  // Each English segment with its own Vietnamese pair, in position order: nothing merged, nothing translated here.
  const paras: Para[] = data.segments.map(s => { const p: Para = { text: s.en, offset: joined, vi: s.vi || undefined }; joined += s.en.length + 1; return p; });
  return plain(data.titleEn, data.titleVi ?? '', { source: 'bilingual', id }, [paras], { chapter: 0, offset: start }, {
    bilingual: paras.some(p => p.vi),
    save: (_c, offset) => { try { localStorage.setItem(key, String(offset)); } catch { /* Stays for this visit. */ } },
  });
}

export async function openBookSession(ref: BookRef, account: string): Promise<BookSession | null> {
  if (ref.source === 'mybooks') return account ? myBook(account, ref.id) : null;
  if (ref.source === 'reading') return readingMaterial(ref.id);
  return bilingualPassage(ref.id);
}
