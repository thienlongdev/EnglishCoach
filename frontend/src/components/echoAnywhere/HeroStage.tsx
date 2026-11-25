'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { echoSrc } from '@/lib/brand/echoCharacters';
import { ECHO_SWIM } from '@/components/dashboard/echoSwimArt';
import styles from './echoAnywherePage.module.css';

/**
 * The /echo-anywhere hero stage: a browser page you can really use (click a word → the real English Coach dictionary
 * answers), Echo swimming past (the pre-rendered loop of the real model already used on the Dashboard — no second WebGL
 * renderer), glass objects in depth that follow the pointer. One rAF-throttled pointer handler; nothing runs while the
 * stage is off screen, the tab is hidden or motion is reduced.
 */

const PARAGRAPH = 'The legacy endpoint is now deprecated and will be removed in the next major version. Please migrate before the deadline so your integration keeps working.';
const TAPPABLE = new Set(['legacy', 'endpoint', 'deprecated', 'removed', 'major', 'migrate', 'deadline', 'integration']);

interface Entry { word: string; ipa?: string; meaning?: string; detail?: string; cefr?: string }
const INITIAL: Entry = { word: 'deprecated', ipa: '/ˈdeprəkeɪtɪd/', meaning: 'không còn được khuyến khích dùng (sắp bị loại bỏ)', detail: 'Bấm một từ có gạch chân để tra thật.' };

export function HeroStage() {
  const stage = useRef<HTMLDivElement>(null);
  const [entry, setEntry] = useState<Entry>(INITIAL);
  const [active, setActive] = useState('deprecated');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [swim, setSwim] = useState<'video' | 'still'>('still');
  const videoRef = useRef<HTMLVideoElement>(null);

  // Echo's swim loop: only where VP9 with alpha plays (not WebKit), never under reduced motion or Save-Data.
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
    const webkit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent);
    const v = document.createElement('video');
    if (!reduced && !saveData && !webkit && v.canPlayType('video/webm; codecs="vp9"')) setSwim('video');
  }, []);

  // play only while the stage is visible and the tab is shown
  useEffect(() => {
    const el = stage.current, video = videoRef.current;
    if (!el || !video) return;
    let visible = false;
    const sync = () => { if (visible && !document.hidden) video.play().catch(() => setSwim('still')); else video.pause(); };
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; sync(); }, { threshold: 0.05 });
    io.observe(el);
    document.addEventListener('visibilitychange', sync);
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', sync); video.pause(); };
  }, [swim]);

  // depth: the pointer tilts the page and moves the floating glass (fine pointers only)
  useEffect(() => {
    const el = stage.current;
    if (!el || !matchMedia('(pointer: fine)').matches || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    const onMove = (e: PointerEvent) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const r = el.getBoundingClientRect();
        const x = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
        const y = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
        el.style.setProperty('--tx', x.toFixed(3));
        el.style.setProperty('--ty', y.toFixed(3));
      });
    };
    const reset = () => { el.style.setProperty('--tx', '0'); el.style.setProperty('--ty', '0'); };
    window.addEventListener('pointermove', onMove, { passive: true });
    el.addEventListener('pointerleave', reset);
    return () => { window.removeEventListener('pointermove', onMove); el.removeEventListener('pointerleave', reset); cancelAnimationFrame(frame); };
  }, []);

  const lookup = useCallback(async (word: string) => {
    setActive(word);
    setSaved(false);
    setBusy(true);
    try {
      const r = await fetch(`/api/v1/dictionary/v2/lookup?word=${encodeURIComponent(word)}&mode=en-vi`, { credentials: 'omit' });
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json() as { headword?: string; cefr?: string; generalTranslationVi?: string; pronunciations?: { ipa?: string }[]; vietnameseSenses?: { meanings?: string[] }[] };
      setEntry({ word: d.headword || word, ipa: d.pronunciations?.find((p) => p.ipa)?.ipa, cefr: d.cefr || undefined,
        meaning: d.generalTranslationVi || d.vietnameseSenses?.[0]?.meanings?.[0], detail: d.vietnameseSenses?.[0]?.meanings?.slice(0, 2).join(' · ') });
    } catch {
      setEntry({ word, detail: 'Không tra được lúc này. Hãy thử lại.' });
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div ref={stage} className={styles.stage}>
      <div className={styles.floaters} aria-hidden="true">
        <span className={`${styles.floater} ${styles.fCard}`}><b>break the ice</b><i>phá vỡ sự ngượng ngùng</i></span>
        <span className={`${styles.floater} ${styles.fPearl}`} />
        <span className={`${styles.floater} ${styles.fStar}`} />
        <span className={`${styles.floater} ${styles.fChip}`}>B2 · collocation</span>
      </div>

      <div className={styles.swimLane} aria-hidden="true">
        {swim === 'video'
          ? <video ref={videoRef} className={styles.swimmer} src={ECHO_SWIM.webm} width={ECHO_SWIM.width} height={ECHO_SWIM.height} muted loop playsInline preload="metadata" />
          // eslint-disable-next-line @next/next/no-img-element
          : <img className={styles.swimStill} src={echoSrc('official', 256)} alt="" width={128} height={128} />}
      </div>

      <figure className={styles.demo}>
        <div className={styles.browser}>
          <div className={styles.browserBar} aria-hidden="true"><span /><span /><span /><i>docs.example.dev/release-notes</i></div>
          <div className={styles.browserBody}>
            <p className={styles.fakeHeading}>Release notes</p>
            <p className={styles.demoText}>
              {PARAGRAPH.split(/(\s+)/).map((tok, i) => {
                const bare = tok.replace(/[^A-Za-z]/g, '').toLowerCase();
                if (!TAPPABLE.has(bare)) return <React.Fragment key={i}>{tok}</React.Fragment>;
                const punct = tok.slice(bare.length);
                return (
                  <React.Fragment key={i}>
                    <button type="button" className={`${styles.tapWord} ${active === bare ? styles.tapOn : ''}`} onClick={() => lookup(bare)}
                      aria-pressed={active === bare} aria-label={`Tra “${bare}”`}>{tok.slice(0, bare.length)}</button>{punct}
                  </React.Fragment>
                );
              })}
            </p>
            <div className={styles.toolbar} aria-hidden="true">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={echoSrc('official', 40)} alt="" width={20} height={20} />
              <span className={styles.toolOn}>Tra nghĩa</span><span>Dịch</span><span>Nghe</span><span>Lưu</span><span className={styles.toolPro}>AI</span>
            </div>
            <div className={`${styles.echoCard} ${busy ? styles.cardBusy : ''}`} aria-live="polite" key={entry.word}>
              <b className={styles.cardWord}>{entry.word}</b>
              <span className={styles.ipa}>{entry.ipa || ' '}{entry.cefr ? <em className={styles.cefr}>{entry.cefr}</em> : null}</span>
              {entry.meaning && <span className={styles.meaning}>{entry.meaning}</span>}
              {entry.detail && <span className={styles.ctxLine}>{entry.detail}</span>}
              <button type="button" className={`${styles.saveChip} ${saved ? styles.saved : ''}`} onClick={() => setSaved(true)}>
                {saved ? 'Trong tiện ích, thẻ này vào Thẻ từ vựng của bạn' : 'Lưu Flashcard'}
              </button>
            </div>
          </div>
        </div>
        <figcaption className={styles.caption}>Bản minh họa dùng từ điển thật của English Coach. Văn bản mẫu do English Coach viết.</figcaption>
      </figure>
    </div>
  );
}
