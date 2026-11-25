'use client';

import React, { useMemo, useRef, useState } from 'react';
import { RotateCw, X } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { LibraryBook } from '@/lib/study-space/library';
import { useDialogFocus } from '../useDialogFocus';
import s from './bookHud.module.css';

/** The shelf, looked through: everything the learner can read here, by name. Choosing one sends the hand to take it down. */
export default function LibraryPanel({ books, onTake, onClose, onRefresh, onImport }: { books: LibraryBook[] | null; onTake: (book: LibraryBook) => void; onClose: () => void; onRefresh: () => void; onImport: () => void }) {
  const { locale } = useLanguage(), vi = locale === 'vi';
  const [group, setGroup] = useState<'all' | LibraryBook['group']>('all'), [query, setQuery] = useState('');
  const root = useRef<HTMLElement | null>(null);
  useDialogFocus(root, onClose);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (books ?? []).filter(b => (group === 'all' || b.group === group) && (!q || b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q)));
  }, [books, group, query]);
  const tabs: ['all' | LibraryBook['group'], string, string][] = [['all', 'Tất cả', 'All'], ['mine', 'Của tôi', 'Mine'], ['recent', 'Đang đọc', 'Reading now'], ['library', 'Thư viện', 'Library'], ['bilingual', 'Song ngữ', 'Bilingual']];
  return <section ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={vi ? 'Tủ sách' : 'Bookshelf'} className={s.library} data-testid="library-panel">
    <header className={s.libraryHead}>
      <h2>{vi ? 'Tủ sách của tôi' : 'My bookshelf'}</h2>
      <button type="button" onClick={onRefresh} aria-label={vi ? 'Tải lại' : 'Refresh'}><RotateCw size={15} /></button>
      <button type="button" onClick={onClose} aria-label={vi ? 'Đóng' : 'Close'} data-testid="library-close"><X size={17} /></button>
    </header>
    <div className={s.librarySearch}>
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder={vi ? 'Tìm theo tên sách…' : 'Search by title…'} aria-label={vi ? 'Tìm sách' : 'Search books'} data-testid="library-search" />
      {tabs.map(([id, a, b]) => <button key={id} type="button" aria-pressed={group === id} onClick={() => setGroup(id)}>{vi ? a : b}</button>)}
    </div>
    <div className={s.libraryList}>
      {books === null && <p className={s.libraryState}>{vi ? 'Đang xem kệ sách…' : 'Looking through the shelf…'}</p>}
      {books !== null && !shown.length && <div className={s.libraryState}>
        <p style={{ margin: 0 }}>{query ? (vi ? 'Không có cuốn nào khớp.' : 'No book matches.') : (vi ? 'Kệ này chưa có sách. Thêm sách EPUB, PDF hoặc TXT trong mục Sách của tôi.' : 'Nothing here yet. Add an EPUB, PDF or TXT book under My Books.')}</p>
        {!query && <button type="button" onClick={onImport}>{vi ? 'Mở Sách của tôi' : 'Open My Books'}</button>}
      </div>}
      {shown.map(b => <button type="button" key={b.key} className={s.libraryItem} onClick={() => onTake(b)} data-testid="library-book" data-book={b.key}>
        <i style={{ background: b.color }} aria-hidden="true" />
        <span><b>{b.title}</b><em>{vi ? b.note.vi : b.note.en}{b.author ? ` · ${b.author}` : ''}</em>{b.progress != null && b.progress > 0 && <u>{vi ? `Đã đọc ${Math.round(b.progress * 100)}%` : `${Math.round(b.progress * 100)}% read`}</u>}</span>
      </button>)}
    </div>
  </section>;
}
