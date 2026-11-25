'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowLeftRight, BookOpen, Clock3, Languages, Loader2, RotateCw, Search, Type, Volume2, MousePointerClick } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { getBilingualReadingDetail } from '@/hooks/useBilingualReading';
import { lookupDictionary, type DictionaryLookupResult } from '@/services/dictionaryService';
import type { BilingualReadingCard, BilingualReadingDetail } from '@/types/bilingualReading';
import styles from './glass/readingGlass.module.css';
import { ReadingCover } from './glass/ReadingCover';
import {
  clearEchoWorkspaceContext,
  dispatchEchoModuleReady,
  publishEchoWorkspaceContext,
} from '@/lib/echo/contextBridge';

type Mode = 'en' | 'bi' | 'vi';
/*
 * Bilingual reader (Echo Glass 2026-10-23). The server's ordered segments are shown exactly as paired: in "Song ngữ" each
 * English segment sits beside (phones: above) its own Vietnamese pair, numbered by its position; nothing is dropped, merged
 * or translated here. Mode, Aa and selection stay passive (no contextual AI); Tra từ / Đọc tiếng Anh run only on click.
 */
export function BilingualReader({ card, onBack }: { card: BilingualReadingCard; onBack: () => void }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const [detail, setDetail] = useState<BilingualReadingDetail | null>(null);
  const [mode, setMode] = useState<Mode>('bi');
  const [fontSize, setFontSize] = useState(18);
  const [appearanceLoaded, setAppearanceLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [dictionaryResult, setDictionaryResult] = useState<DictionaryLookupResult | null>(null);
  const [dictionaryBusy, setDictionaryBusy] = useState(false);
  const [showAa, setShowAa] = useState(false);
  const appearanceRef = useRef<HTMLDivElement>(null);
  const loadAppearance = () => { try { const saved = JSON.parse(localStorage.getItem('reading.appearance.v1') || 'null'); if (Number.isFinite(saved?.fontSize)) setFontSize(Math.max(15, Math.min(28, saved.fontSize))); } catch {} finally { setAppearanceLoaded(true); } };
  useEffect(() => { loadAppearance(); }, []);
  useEffect(() => { if (!appearanceLoaded) return; try { const saved = JSON.parse(localStorage.getItem('reading.appearance.v1') || '{}'); localStorage.setItem('reading.appearance.v1', JSON.stringify({ ...saved, fontSize })); } catch {} }, [fontSize, appearanceLoaded]);
  useEffect(() => { let active = true; setDetail(null); setError(false); void getBilingualReadingDetail(card.id).then(value => { if (active) setDetail(value); }).catch(() => { if (active) setError(true); }); return () => { active = false; }; }, [card.id]);
  useEffect(() => {
    publishEchoWorkspaceContext({ source: 'bilingual-reader', kind: 'BILINGUAL_READING', id: card.id });
    dispatchEchoModuleReady('reading', { bilingualId: card.id });
    const onReadingIntent = (event: Event) => {
      const d = (event as CustomEvent<{ fontSize?: number; fontDelta?: number }>).detail;
      if (!d) return;
      if (typeof d.fontSize === 'number' && Number.isFinite(d.fontSize)) {
        setFontSize(Math.max(15, Math.min(28, Math.round(d.fontSize))));
      } else if (typeof d.fontDelta === 'number' && Number.isFinite(d.fontDelta)) {
        setFontSize((prev) => Math.max(15, Math.min(28, prev + Math.round(d.fontDelta!))));
      }
    };
    window.addEventListener('ec:reading:intent', onReadingIntent);
    return () => {
      window.removeEventListener('ec:reading:intent', onReadingIntent);
      clearEchoWorkspaceContext('bilingual-reader');
    };
  }, [card.id]);
  useEffect(() => {
    if (!showAa) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowAa(false); };
    const onDown = (e: PointerEvent) => { if (!appearanceRef.current?.contains(e.target as Node)) setShowAa(false); };
    document.addEventListener('keydown', onKey); document.addEventListener('pointerdown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown); };
  }, [showAa]);
  const title = detail?.titleEn ?? card.titleEn;
  const displayTitleVi = detail?.titleVi ?? card.titleVi;
  const segments = useMemo(() => detail?.segments ?? [], [detail]);
  const lookupSelected = async () => { const text = selectedText.trim(); if (!text || text.split(/\s+/).length > 5) return; setDictionaryBusy(true); try { setDictionaryResult(await lookupDictionary(text)); } finally { setDictionaryBusy(false); } };
  const speakSelected = () => { if (selectedText.trim() && typeof window !== 'undefined') window.speechSynthesis.speak(new SpeechSynthesisUtterance(selectedText.trim())); };
  const story = card.contentType !== 'ARTICLE';
  const modes = [['en', 'English'], ['bi', 'Song ngữ'], ['vi', 'Tiếng Việt']] as const;
  return <div className="flex flex-col gap-5">
    <div className={`${styles.panel} ${styles.biBar}`}>
      <button type="button" onClick={onBack} className={styles.backBtn}><ArrowLeft className="h-4 w-4" />{vi ? 'Quay lại Song ngữ' : 'Back to Bilingual'}</button>
      <div className={styles.biBarModes}>
        <div className={`${styles.well} ${styles.segment}`} role="group" aria-label={vi ? 'Chế độ hiển thị' : 'Display mode'}>
          {modes.map(([value, label]) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)} className={styles.segBtn}>{locale === 'en' ? label : value === 'en' ? 'English' : value === 'bi' ? 'Song ngữ' : 'Tiếng Việt'}</button>)}
        </div>
        <div className="relative" ref={appearanceRef}>
          <button type="button" aria-expanded={showAa} onClick={() => setShowAa(v => !v)} className={styles.softBtn}><Type className="h-4 w-4" />Aa</button>
          {showAa && <div className={`${styles.panel} ${styles.aaPop}`} role="dialog" aria-label={vi ? 'Giao diện đọc' : 'Reading appearance'}>
            <label className="block text-xs font-semibold" style={{ color: 'var(--ink-2)' }}>{vi ? 'Cỡ chữ' : 'Font size'} <span className="tabular-nums" style={{ color: 'var(--ink-3)' }}>{fontSize}px</span>
              <input className={`${styles.range} mt-2 block`} type="range" min="15" max="28" value={fontSize} onChange={e => setFontSize(Number(e.target.value))} />
            </label>
            <button type="button" className={`${styles.ghostBtn} mt-2 -ml-2`} onClick={() => setFontSize(18)}>{vi ? 'Đặt lại' : 'Reset'}</button>
          </div>}
        </div>
      </div>
    </div>

    <header className={styles.biMast}>
      <ReadingCover family={story ? 'story' : 'bilingual'} seed={card.id} size="lg" />
      <div className={styles.biMastBody}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={styles.biTag}><Languages className="h-3.5 w-3.5" aria-hidden="true" />{story ? (vi ? 'Truyện ngắn' : 'Short story') : (vi ? 'Bài báo' : 'Article')}</span>
          <span className={styles.biTag}><BookOpen className="h-3.5 w-3.5" aria-hidden="true" />{card.wordCount.toLocaleString(vi ? 'vi-VN' : 'en-US')} {vi ? 'từ' : 'words'}</span>
          <span className={styles.biTag}><Clock3 className="h-3.5 w-3.5" aria-hidden="true" />{vi ? `${card.estimatedMinutes} phút đọc` : `${card.estimatedMinutes} min read`}</span>
          <span className={styles.langPair} aria-hidden="true"><b>EN</b><ArrowLeftRight /><b>VI</b></span>
        </div>
        <h1 lang="en" className={styles.biMastTitle}>{title}</h1>
        {displayTitleVi && <p lang="vi" className={styles.biMastVi}>{displayTitleVi}</p>}
      </div>
    </header>

    {error ? <div role="alert" className={styles.alert}><p className="m-0">{vi ? 'Không thể mở bài đọc.' : 'Could not open this reading.'}</p><button type="button" className={styles.softBtn} onClick={() => { setError(false); void getBilingualReadingDetail(card.id).then(setDetail).catch(() => setError(true)); }}><RotateCw className="h-3.5 w-3.5" aria-hidden="true" />{vi ? 'Thử lại' : 'Retry'}</button></div>
      : !detail ? <div role="status" className={`${styles.panel} flex items-center gap-2 px-5 py-10 text-sm`} style={{ color: 'var(--ink-3)' }}><Loader2 className="h-4 w-4 animate-spin" />{vi ? 'Đang mở bài đọc…' : 'Loading reading…'}</div>
      : <>
        <div className={`${styles.panel} ${styles.biTools}`}>
          <span className={styles.biToolLabel}><Languages className="h-4 w-4" aria-hidden="true" style={{ color: 'var(--wink)' }} />{vi ? 'Công cụ tiếng Anh' : 'English tools'}</span>
          <button type="button" className={styles.miniBtn} onClick={() => setSelectedText(window.getSelection()?.toString() ?? '')}><MousePointerClick className="h-3.5 w-3.5" aria-hidden="true" />{vi ? 'Lấy phần chọn' : 'Use selection'}</button>
          <button type="button" disabled={!selectedText || dictionaryBusy} className={styles.miniBtn} onClick={() => void lookupSelected()}><Search className="h-3.5 w-3.5" aria-hidden="true" />{dictionaryBusy ? '…' : vi ? 'Tra từ' : 'Dictionary'}</button>
          <button type="button" disabled={!selectedText} className={styles.miniBtn} onClick={speakSelected}><Volume2 className="h-3.5 w-3.5" aria-hidden="true" />{vi ? 'Đọc tiếng Anh' : 'Speak English'}</button>
          {selectedText && <p className={styles.biSelection}>{selectedText}</p>}
          {dictionaryResult && <p className={styles.biSelection}><strong>{dictionaryResult.word}</strong>: {dictionaryResult.vietnameseMeaning}</p>}
        </div>
        <div className={styles.segments}>
          {segments.map((segment, i) => <section key={segment.position} className={styles.segmentRow} data-mode={mode === 'bi' ? 'bi' : 'single'} aria-label={`${vi ? 'Đoạn' : 'Segment'} ${i + 1}`}>
            <span className={styles.segNum} aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
            {(mode === 'en' || mode === 'bi') && <p lang="en" onMouseUp={() => setSelectedText(window.getSelection()?.toString() ?? '')} className={styles.langBlock} style={{ fontSize }}><span className={styles.langLabel} aria-hidden="true">English</span>{segment.en}</p>}
            {(mode === 'vi' || mode === 'bi') && <p lang="vi" className={styles.langBlock} style={{ fontSize }}><span className={styles.langLabel} aria-hidden="true">Tiếng Việt</span>{segment.vi}</p>}
          </section>)}
        </div>
      </>}
  </div>;
}
