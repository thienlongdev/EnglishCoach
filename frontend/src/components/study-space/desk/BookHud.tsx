'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import { Bookmark, BookmarkCheck, ChevronLeft, ChevronRight, Highlighter, Languages, Maximize2, Search, X } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { QuickDictionaryPopover } from '@/components/features/dictionary/QuickDictionaryPopover';
import { googleTranslate } from '@/services/readingBooksApi';
import { BookStore } from '@/components/features/reading/books/store/bookStore';
import type { OpenBook as OpenedBook } from '@/components/features/reading/books/MyBooksTab';
import FlashcardSave from '../FlashcardSave';
import type { PickedWord } from '../world/openBook';
import type { BookInfo } from '@/lib/study-space/types';
import s from './bookHud.module.css';

const BookReader = dynamic(() => import('@/components/features/reading/books/BookReader'), { ssr: false });

export interface BookControls {
  bookClick(ndc: { x: number; y: number }): PickedWord | 'turned' | null;
  bookNext(): void;
  bookPrev(): void;
  bookBilingual(on: boolean): Promise<void>;
  bookMark(): Promise<boolean | undefined>;
  bookHighlight(word: PickedWord): Promise<boolean | undefined>;
  closeReading(): void;
  reloadBook(): void;
}

/**
 * Around an open book: the pointer is for reading now. A word is clicked, and the ordinary dictionary, translation, highlight and Flashcard services answer. The outer edge of a page, the arrows or the
 * wheel turn it. "Trình đọc đầy đủ" opens the same book in the normal reader, at the same place, and when it closes the book in the hand follows.
 */
export default function BookHud({ controls, info, account, onOpenModule }: {
  controls: BookControls;
  info: { title: string; note: string; canBilingual: boolean; bilingual: boolean; marked: boolean; words: boolean; ref: BookInfo | null };
  account: string;
  onOpenModule: (href: string) => void;
}) {
  const { locale } = useLanguage(), vi = locale === 'vi';
  const [picked, setPicked] = useState<{ word: PickedWord; x: number; y: number } | null>(null);
  const [lookup, setLookup] = useState(false), [translated, setTranslated] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [full, setFull] = useState<{ book: OpenedBook; store: BookStore } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const clear = useCallback(() => { setPicked(null); setLookup(false); setTranslated(null); }, []);

  const click = (e: React.MouseEvent) => {
    const ndc = { x: e.clientX / window.innerWidth * 2 - 1, y: -(e.clientY / window.innerHeight * 2 - 1) };
    const r = controls.bookClick(ndc);
    clear();
    if (r && r !== 'turned') setPicked({ word: r, x: e.clientX, y: e.clientY });
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (full || (e.target as HTMLElement)?.closest?.('input,textarea,[contenteditable="true"]')) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); e.stopPropagation(); clear(); controls.bookNext(); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); e.stopPropagation(); clear(); controls.bookPrev(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (picked) clear(); else controls.closeReading(); }
    };
    window.addEventListener('keydown', key, { capture: true });
    return () => window.removeEventListener('keydown', key, { capture: true });
  }, [controls, clear, picked, full]);

  const translate = async () => {
    if (!picked) return;
    setBusy(true); setTranslated(null);
    try { setTranslated(await googleTranslate(picked.word.word)); } catch { setTranslated(vi ? 'Chưa dịch được.' : 'Could not translate.'); }
    finally { setBusy(false); }
  };
  const openFull = async () => {
    const ref = info.ref;
    if (!ref) return;
    if (ref.source === 'reading') { onOpenModule(`/reading?materialId=${ref.id}`); return; }
    if (ref.source === 'bilingual') { try { localStorage.setItem('readingActiveTab', 'bilingual'); } catch { /* opens on the library */ } onOpenModule('/reading'); return; }
    try {
      const store = await BookStore.open(account);
      const [meta, file] = await Promise.all([store.getBook(ref.id), store.getFile(ref.id)]);
      if (!meta || !file) { store.close(); setMessage(vi ? 'Cuốn sách này không còn trên thiết bị.' : 'This book is no longer on this device.'); return; }
      setFull({ book: { meta, file, persistent: true }, store });
    } catch { setMessage(vi ? 'Chưa mở được trình đọc.' : 'Could not open the reader.'); }
  };
  const closeFull = () => { full?.store.close(); setFull(null); controls.reloadBook(); };

  return <>
    {/* The pointer's surface over the book: nothing here covers the book, it only listens. */}
    <div className={s.surface} data-testid="book-surface" onClick={click} onWheel={e => { clear(); if (e.deltaY > 0) controls.bookNext(); else if (e.deltaY < 0) controls.bookPrev(); }} />
    <div className={s.bar} role="toolbar" aria-label={vi ? 'Công cụ đọc sách' : 'Reading tools'} data-testid="book-bar">
      <button type="button" onClick={() => { clear(); controls.bookPrev(); }} aria-label={vi ? 'Trang trước' : 'Previous page'} data-testid="book-prev"><ChevronLeft size={18} /></button>
      <span className={s.where}><b>{info.title}</b>{info.note && <em data-testid="book-page">{info.note}</em>}</span>
      <button type="button" onClick={() => { clear(); controls.bookNext(); }} aria-label={vi ? 'Trang sau' : 'Next page'} data-testid="book-next"><ChevronRight size={18} /></button>
      <span className={s.rule} aria-hidden="true" />
      {info.canBilingual && <button type="button" aria-pressed={info.bilingual} onClick={() => void controls.bookBilingual(!info.bilingual)} data-testid="book-bilingual"><Languages size={16} />{info.bilingual ? (vi ? 'Anh – Việt' : 'EN – VI') : (vi ? 'Chỉ tiếng Anh' : 'English')}</button>}
      {info.ref?.source === 'mybooks' && <button type="button" aria-pressed={info.marked} onClick={() => void controls.bookMark()} data-testid="book-mark" aria-label={vi ? 'Đánh dấu trang' : 'Bookmark this page'}>{info.marked ? <BookmarkCheck size={16} /> : <Bookmark size={16} />}</button>}
      {info.ref && <button type="button" onClick={() => void openFull()} data-testid="book-full"><Maximize2 size={15} />{vi ? 'Trình đọc đầy đủ' : 'Full reader'}</button>}
      <button type="button" onClick={() => controls.closeReading()} data-testid="book-close" aria-label={vi ? 'Gấp sách lại' : 'Close the book'}><X size={17} /><kbd>Esc</kbd></button>
    </div>
    {!info.words && !picked && <p className={s.hint}>{vi ? 'Sách PDF giữ nguyên trang gốc. Muốn tra từ hay tô sáng, mở Trình đọc đầy đủ.' : 'A PDF keeps its own pages. To look up or highlight, open the full reader.'}</p>}
    {message && <p className={s.hint} role="status">{message}</p>}
    {picked && !lookup && <div className={s.tools} style={{ left: Math.min(window.innerWidth - 330, Math.max(10, picked.x - 150)), top: Math.max(10, picked.y - 112) }} data-testid="book-tools" onClick={e => e.stopPropagation()}>
      <b lang="en">{picked.word.word}</b>
      {translated && <p data-testid="book-translation">{translated}</p>}
      <div>
        <button type="button" onClick={() => setLookup(true)} data-testid="book-lookup"><Search size={14} />{vi ? 'Tra từ' : 'Look up'}</button>
        <button type="button" disabled={busy} onClick={() => void translate()} data-testid="book-translate"><Languages size={14} />{vi ? 'Dịch' : 'Translate'}</button>
        {picked.word.start >= 0 && info.ref?.source === 'mybooks' && <button type="button" onClick={() => { void controls.bookHighlight(picked.word); clear(); }} data-testid="book-highlight"><Highlighter size={14} />{vi ? 'Tô sáng' : 'Highlight'}</button>}
        <FlashcardSave text={picked.word.word} context={picked.word.sentence} />
      </div>
    </div>}
    {picked && lookup && <QuickDictionaryPopover word={picked.word.word} anchor={{ x: picked.x, y: picked.y }} contextSentence={picked.word.sentence} onClose={clear} />}
    {full && createPortal(<BookReader key={full.book.meta.id} book={full.book} store={full.store} onClose={closeFull} onSaved={meta => setFull(f => f ? { ...f, book: { ...f.book, meta } } : f)} />, document.body)}
  </>;
}
