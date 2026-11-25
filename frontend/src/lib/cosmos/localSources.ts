'use client';
/**
 * Sources that live only on this device: My Books (Sách của tôi). The book files and highlights are in the account's own
 * IndexedDB and never leave the browser; Cosmos reads them READ-ONLY here (no write, no upload, no request). A book becomes a
 * source only through the passages the learner highlighted: "a form of the word is in a passage you marked".
 * A browser without `indexedDB.databases()` (it cannot tell whether a library exists without creating one) is skipped.
 */
import { BookStore } from '@/components/features/reading/books/store/bookStore';
import { tokenize } from './tokenize';
import type { Overlay } from './types';

export async function myBooksSources(userId: string): Promise<Overlay['sources']> {
  if (!userId || typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return [];
  try {
    const dbs = await indexedDB.databases();
    if (!dbs.some(d => d.name === BookStore.dbName(userId))) return [];
    const store = await BookStore.open(userId);
    try {
      const out: Overlay['sources'] = [];
      for (const book of await store.listBooks()) {
        const marks = (await store.annotations(book.id)).filter(a => a.kind === 'highlight' && a.text?.trim());
        if (!marks.length) continue;
        out.push({ kind: 'MY_BOOKS', id: book.id, title: book.title || book.fileName, at: Math.min(...marks.map(a => a.createdAt)), system: false,
          tokens: tokenize(marks.map(a => a.text).join('\n')) });
      }
      return out;
    } finally { store.close(); }
  } catch { return []; }
}

/** The highlighted passages of the given books (this account, this device), read-only — for "Hỏi vũ trụ" quotations. */
export async function myBooksPassageTexts(userId: string, ids: string[]): Promise<{ id: string; title: string; at: number; texts: string[] }[]> {
  if (!userId || !ids.length || typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return [];
  try {
    const dbs = await indexedDB.databases();
    if (!dbs.some(d => d.name === BookStore.dbName(userId))) return [];
    const store = await BookStore.open(userId);
    try {
      const out: { id: string; title: string; at: number; texts: string[] }[] = [];
      for (const book of await store.listBooks()) {
        if (!ids.includes(String(book.id))) continue;
        const marks = (await store.annotations(book.id)).filter(a => a.kind === 'highlight' && a.text?.trim());
        if (marks.length) out.push({ id: String(book.id), title: book.title || book.fileName, at: Math.min(...marks.map(a => a.createdAt)), texts: marks.map(a => a.text) });
      }
      return out;
    } finally { store.close(); }
  } catch { return []; }
}
