'use client';
import Link from 'next/link';
import { useEffect, useId, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { Play, Pause, SkipBack, SkipForward, LoaderCircle, ChevronRight, X } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useMusic } from './MusicProvider';
import { MusicArtwork } from './MusicArtwork';
import styles from './CompactMusicPlayer.module.css';

type Mode = 'strip' | 'pill';
const MODE_KEY = 'ec_music_bar:v1';
const PHONE = '(max-width: 699px)';
const subscribePhone = (callback: () => void) => { const query = matchMedia(PHONE); query.addEventListener('change', callback); return () => query.removeEventListener('change', callback); };
const RING = 2 * Math.PI * 17;

/**
 * The header player. Invisible until the learner starts music in this tab; then a raised glass capsule beside the dictionary
 * search. The round cover on the left is the ONE expand / collapse control (the same button opens and closes it); folding
 * is presentation only and never touches the engine, so the track, its position and play / pause go on unchanged.
 * Always a flex child of the 64px top bar: never fixed, never over the page.
 */
export default function CompactMusicPlayer() {
  const { engine, current, playing, loading, time, duration, focus, engaged } = useMusic();
  const { locale } = useLanguage(); const vi = locale === 'vi';
  const partsId = useId();
  const [mode, setMode] = useState<Mode>('strip');
  // Phones always start folded (the bar has little room); their choice is not remembered.
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const phone = useSyncExternalStore(subscribePhone, () => matchMedia(PHONE).matches, () => false);
  useEffect(() => { try { if (localStorage.getItem(MODE_KEY) === 'pill') setMode('pill'); } catch { /* Storage blocked. */ } }, []);
  useEffect(() => { if (engaged) setLeaving(false); }, [engaged]);
  if (!engaged || !current) return null;

  const expanded = phone ? phoneOpen : mode === 'strip';
  const toggle = () => {
    if (phone) { setPhoneOpen(open => !open); return; }
    const next: Mode = mode === 'strip' ? 'pill' : 'strip';
    setMode(next);
    try { localStorage.setItem(MODE_KEY, next); } catch { /* Storage blocked. */ }
  };
  const close = () => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) engine?.dismiss(); else setLeaving(true);
  };
  const progress = duration ? Math.min(1, time / duration) : 0;
  const status = focus ? (vi ? 'Tạm dừng để học' : 'Paused for learning') : current.artist || (vi ? 'Nhạc của tôi' : 'My Music');
  const toggleLabel = expanded
    ? (vi ? 'Thu gọn trình phát' : 'Collapse player')
    : `${vi ? 'Mở rộng trình phát' : 'Expand player'}: ${current.title}`;

  return <div role="region" aria-label={vi ? 'Trình phát Echo Music' : 'Echo Music player'} className={styles.player} data-testid="music-compact"
    data-mode={expanded ? 'strip' : 'pill'} data-phone={phone || undefined} data-playing={playing} data-leaving={leaving || undefined}
    onAnimationEnd={event => { if (leaving && event.target === event.currentTarget) engine?.dismiss(); }}
    style={{ '--music-accent': current.accent } as CSSProperties}>
    <span className={styles.light} aria-hidden="true"><MusicArtwork track={current} decorative className={styles.lightArt} /></span>
    <span className={styles.rim} aria-hidden="true" />
    <div className={styles.content} id={partsId}>
      <button type="button" className={styles.disc} onClick={toggle} aria-expanded={expanded} aria-controls={partsId}
        aria-label={toggleLabel} title={`${current.title} · ${status}`} data-testid="music-compact-toggle">
        <MusicArtwork track={current} className={styles.discArt} decorative />
        <svg className={styles.ring} viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" /><circle cx="20" cy="20" r="17" className={styles.ringValue} style={{ strokeDasharray: RING, strokeDashoffset: RING * (1 - progress) }} /></svg>
        <span className={styles.gloss} aria-hidden="true" />
        <span className={styles.nub} aria-hidden="true"><ChevronRight size={9} strokeWidth={3} /></span>
      </button>
      <div className={`${styles.fold} ${styles.foldTitle}`} inert={!expanded}>
        <div className={styles.foldInner}>
          <Link href="/music" prefetch={false} className={styles.identity} aria-label={`${vi ? 'Mở phòng nhạc' : 'Open music room'}: ${current.title}`} title={`${current.title} · ${status}`}>
            <span className={styles.text}><strong>{current.title}</strong><small>{status}</small></span>
          </Link>
        </div>
      </div>
      <Bars />
      <div className={styles.fold} data-part="prev" inert={!expanded}>
        <div className={styles.foldInner}>
          <button type="button" className={styles.skip} data-role="prev" onClick={() => void engine?.next(-1)} aria-label={vi ? 'Bài trước' : 'Previous track'}><SkipBack size={14} fill="currentColor" /></button>
        </div>
      </div>
      <button type="button" className={styles.play} onClick={() => engine?.toggle()} disabled={!engine || !!focus}
        aria-label={playing ? (vi ? 'Tạm dừng nhạc' : 'Pause music') : (vi ? 'Phát nhạc' : 'Play music')}
        title={focus ? (vi ? 'Nhạc tạm dừng trong hoạt động nghe, nói, thi và trò chơi' : 'Music pauses during listening, speaking, exams and games') : undefined}>
        {loading ? <LoaderCircle size={15} className={styles.spin} /> : playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className={styles.playGlyph} />}
      </button>
      <div className={styles.fold} data-part="tail" inert={!expanded}>
        <div className={styles.foldInner}>
          <button type="button" className={styles.skip} data-role="next" onClick={() => void engine?.next()} aria-label={vi ? 'Bài tiếp theo' : 'Next track'}><SkipForward size={14} fill="currentColor" /></button>
          <span className={styles.divider} aria-hidden="true" />
          <button type="button" className={styles.tool} onClick={close} aria-label={vi ? 'Tắt nhạc và ẩn trình phát' : 'Stop music and hide player'} title={vi ? 'Tắt trình phát' : 'Close player'} data-testid="music-compact-close"><X size={14} /></button>
        </div>
      </div>
      <span className={styles.progress} aria-hidden="true"><i style={{ transform: `scaleX(${progress})` }} /></span>
    </div>
  </div>;
}

/** A small playing indicator (not a spectrum): bars that move only while music plays. */
function Bars() { return <span className={styles.bars} aria-hidden="true"><i /><i /><i /><i /></span>; }
