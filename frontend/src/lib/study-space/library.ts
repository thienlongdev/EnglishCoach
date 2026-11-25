import { apiClient } from '@/services/api-client';
import { BookStore } from '@/components/features/reading/books/store/bookStore';
import type { BilingualReadingCatalog } from '@/types/bilingualReading';
import type { BookRef } from './types';

// The shelf displays up to 36 library titles. The catalogue serves at most 24 per page.
async function systemShelf() {
  type Entry = { id: number; title: string; difficultyLevel?: string };
  const page = (n: number) => apiClient.get<{ content: Entry[]; totalPages: number }>('/reading/catalog', {
    params: { library: 'SYSTEM', page: n, size: 18 },
  }).then(r => r.data);
  const first = await page(0);
  if (first.totalPages <= 1) return first.content;
  const next = await page(1).catch(() => null);
  return first.content.concat(next?.content ?? []);
}

/**
 * The learner's own library, as the shelf in the room shows it: the books on this device (My Books), the readings they have opened, the readings of the library, the bilingual
 * passages. Nothing is copied: a book in the room is a reference to one of these, and opens through the same stores and the same permissions as everywhere else.
 */
export interface LibraryBook {
  key: string;
  ref: BookRef;
  title: string;
  author: string;
  /** What kind of thing it is, in the learner's words. */
  note: { vi: string; en: string };
  group: 'mine' | 'recent' | 'library' | 'bilingual';
  /** 0..1, where it is known. */
  progress: number | null;
  color: string;
}

const COVERS = ['#3e5f9e', '#8d4b6b', '#2f7d73', '#a9772c', '#6a4f9c', '#27607f', '#99503f', '#4f6f3e', '#7a3f55', '#35566e'];
export const bookKey = (ref: BookRef) => `${ref.source}:${ref.id}`;
const colorOf = (key: string) => { let h = 7; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0; return COVERS[h % COVERS.length]; };

/** Real covers of the books on this device, for the faces of the books in the room. */
const covers = new Map<string, Blob>();
export const coverOf = (key: string) => covers.get(key) ?? null;

export async function loadLibrary(account: string): Promise<LibraryBook[]> {
  const out: LibraryBook[] = [];
  const seen = new Set<string>();
  const add = (book: Omit<LibraryBook, 'key' | 'color'> & { color?: string }) => {
    const key = bookKey(book.ref);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...book, key, color: book.color ?? colorOf(key) });
  };
  if (account) {
    try {
      const store = await BookStore.open(account);
      try {
        const books = (await store.listBooks()).sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt));
        for (const b of books) {
          add({ ref: { source: 'mybooks', id: b.id }, title: b.title, author: b.author, note: { vi: `Sách của tôi · ${b.format.toUpperCase()}`, en: `My Books · ${b.format.toUpperCase()}` }, group: 'mine', progress: b.progress ?? null });
          if (b.hasCover && !covers.has(`mybooks:${b.id}`)) { const c = await store.getCover(b.id).catch(() => undefined); if (c) covers.set(`mybooks:${b.id}`, c); }
        }
      } finally { store.close(); }
    } catch { /* No local library on this browser: the server's readings still are. */ }
  }
  const [progress, own, system, bilingual] = await Promise.all([
    apiClient.get<{ materialId: number; scrollPercentage: number; material?: { id: number; title: string; difficultyLevel?: string } }[]>('/reading/progress').then(r => r.data ?? []).catch(() => []),
    apiClient.get<{ content?: { id: number; title: string; difficultyLevel?: string }[] }>('/reading/catalog', { params: { library: 'USER', page: 0, size: 24 } }).then(r => r.data?.content ?? []).catch(() => []),
    systemShelf().catch(() => []),
    apiClient.get<BilingualReadingCatalog>('/reading/bilingual/catalog').then(r => r.data?.content ?? []).catch(() => []),
  ]);
  const reading = { vi: 'Bài đọc', en: 'Reading' };
  for (const p of progress) if (p.material) add({ ref: { source: 'reading', id: p.material.id }, title: p.material.title, author: p.material.difficultyLevel ?? '', note: reading, group: 'recent', progress: Math.min(1, (p.scrollPercentage ?? 0) / 100) });
  for (const m of own) add({ ref: { source: 'reading', id: m.id }, title: m.title, author: '', note: { vi: 'Bài đọc của tôi', en: 'My reading' }, group: 'mine', progress: null });
  for (const m of system) add({ ref: { source: 'reading', id: m.id }, title: m.title, author: m.difficultyLevel ?? '', note: reading, group: 'library', progress: null });
  for (const b of bilingual.slice(0, 36)) add({ ref: { source: 'bilingual', id: b.id }, title: b.titleEn, author: b.difficultyLevel ?? '', note: { vi: 'Song ngữ', en: 'Bilingual' }, group: 'bilingual', progress: null });
  return out;
}
