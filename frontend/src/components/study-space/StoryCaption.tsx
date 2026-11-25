'use client';
import { useEffect, useRef, useState } from 'react';
import type { Line } from '@/lib/study-space/stories';
import { apiClient } from '@/services/api-client';
import s from './explorer.module.css';

/**
 * A line of the story, low on the screen and only for as long as it takes to read. Words without a box, nothing to dismiss before anything else can happen, nothing that
 * takes the mouse. Enter finishes it or lets it go. When the line has an English phrase in it, Y keeps the phrase as a flashcard, and only then does anything leave the page.
 */
const LETTER_MS = 26;
export default function StoryCaption({ line, vi, words, onGone }: { line: Line; vi: boolean; words: boolean; onGone: () => void }) {
  const text = vi ? line.vi : line.en;
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [shown, setShown] = useState(reduced ? text.length : 0);
  const [leaving, setLeaving] = useState(false);
  const [saved, setSaved] = useState<'' | 'saving' | 'saved' | 'failed'>('');
  const done = shown >= text.length;
  const gone = useRef(onGone); gone.current = onGone;
  useEffect(() => {
    if (done) return;
    const t = window.setInterval(() => setShown(n => Math.min(text.length, n + 1)), LETTER_MS);
    return () => window.clearInterval(t);
  }, [done, text.length]);
  const hold = (line.hold ?? Math.max(3.6, text.length * .062)) * 1000;
  useEffect(() => {
    if (!done || leaving) return;
    const t = window.setTimeout(() => setLeaving(true), hold);
    return () => window.clearTimeout(t);
  }, [done, leaving, hold]);
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => gone.current(), reduced ? 0 : 520);
    return () => window.clearTimeout(t);
  }, [leaving, reduced]);
  const phrase = words ? line.phrase : undefined;
  const save = () => {
    if (!phrase || saved) return;
    setSaved('saving');
    apiClient.post('/flashcards', { front: phrase.en, back: phrase.vi, example: '', ipa: '' }).then(() => setSaved('saved')).catch(() => setSaved('failed'));
  };
  const saveRef = useRef(save); saveRef.current = save;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.code === 'Enter') { const tag = (e.target as HTMLElement | null)?.tagName; if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return; if (shown < text.length) setShown(text.length); else setLeaving(true); }
      else if (e.code === 'KeyY' && (e.target as HTMLElement | null)?.tagName !== 'INPUT' && (e.target as HTMLElement | null)?.tagName !== 'TEXTAREA') saveRef.current();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [shown, text.length]);
  return <div className={s.caption} data-testid="story-caption" data-leaving={leaving || undefined} data-line={line.id} role="status" aria-live="polite">
    <p aria-label={text}><span aria-hidden="true">{text.slice(0, shown)}</span><span aria-hidden="true" className={s.captionRest}>{text.slice(shown)}</span></p>
    {phrase && done && <small data-testid="story-phrase"><i lang="en">{phrase.en}</i>{vi ? <> · {phrase.vi}</> : null}{saved === '' && <button type="button" tabIndex={-1} onClick={save} data-testid="story-save"><kbd>Y</kbd>{vi ? 'Lưu thẻ' : 'Save card'}</button>}{saved === 'saved' && <b>{vi ? 'Đã lưu vào Thẻ từ vựng' : 'Saved'}</b>}{saved === 'failed' && <b>{vi ? 'Chưa lưu được' : 'Could not save'}</b>}</small>}
  </div>;
}
