'use client';

import { useEffect, useRef, useState } from 'react';
import { Volume2 } from 'lucide-react';
import { POS_LABEL, t } from './copy';
import type { ChainPlayer, WordMetadata } from './types';
import styles from './wordChain.module.css';
import { echoSrc } from '@/lib/brand/echoCharacters';

const HUES: [string, string][] = [['#3a7bff', '#0aa6c9'], ['#8a5cff', '#e8445e'], ['#10b27c', '#0a8f9c'], ['#f08a1c', '#e8445e']];

/** A player's own profile picture; otherwise their initials. Echo is always the official whale. */
export function Avatar({ player, small = false }: { player: Pick<ChainPlayer, 'id' | 'name' | 'avatarUrl' | 'bot'> | undefined; small?: boolean }) {
  const [broken, setBroken] = useState(false);
  const cls = `${styles.avatar} ${small ? styles.avatarSm : ''}`;
  if (!player) return <span className={cls} aria-hidden="true" />;
  if (player.bot || player.id === 0) {
    // eslint-disable-next-line @next/next/no-img-element
    return <span className={cls} data-bot="true" aria-hidden="true"><img src={echoSrc('tech', 40)} alt="" /></span>;
  }
  const [a, b] = HUES[Math.abs(player.id) % HUES.length];
  const initials = player.name.replace(/[#\d]+$/, '').trim().split(/\s+/).filter(Boolean).slice(-2).map(w => w[0]).join('').toUpperCase() || '#';
  return (
    <span className={cls} style={{ ['--av-a' as string]: a, ['--av-b' as string]: b }} aria-hidden="true">
      {player.avatarUrl && !broken
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={player.avatarUrl} alt="" loading="lazy" onError={() => setBroken(true)} />
        : initials}
    </span>
  );
}

/** The word with its last letter (the next starting letter) marked. */
export function Linked({ word }: { word: string }) {
  return <>{word.slice(0, -1)}<span className={styles.last}>{word.slice(-1)}</span></>;
}

export function posLabel(vi: boolean, pos: string | null | undefined) {
  if (!pos) return null;
  return t(vi, POS_LABEL[pos]) || pos;
}

/** A small learning object: word → word class → the dictionary's primary Vietnamese sense; other senses one tap away. */
export function WordCard({ word, vi, mine = false, fresh = false }: { word: WordMetadata; vi: boolean; mine?: boolean; fresh?: boolean }) {
  const [audioError, setAudioError] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => { audio.current?.pause(); }, []);
  const pronounce = () => {
    window.dispatchEvent(new Event('ec:music-pause'));
    audio.current?.pause();
    setAudioError(false);
    audio.current = new Audio(`/api/tts?text=${encodeURIComponent(word.displayWord)}&lang=en-US`);
    audio.current.onerror = () => setAudioError(true);
    void audio.current.play().catch(() => setAudioError(true));
  };
  const others = (word.senses || []).filter(s => !(s.meaning === word.meaningVi && s.pos === word.partOfSpeech));
  const label = posLabel(vi, word.partOfSpeech);
  return (
    <article className={styles.card} data-mine={mine} data-fresh={fresh}>
      <div className={styles.cardTop}>
        <strong className={styles.cardWord} lang="en"><Linked word={word.displayWord} /></strong>
        {label && <span className={styles.cardTag}>{label}</span>}
        {word.cefr && <span className={styles.cardCefr} title={vi ? 'Cấp độ CEFR-J của từ' : 'CEFR-J level of the word'}>{word.cefr}</span>}
        <button type="button" className={styles.speak} onClick={pronounce} aria-label={`${vi ? 'Nghe phát âm' : 'Pronounce'} ${word.displayWord}`}>
          <Volume2 className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {word.ipa && <span className={styles.ipa}>{word.ipa}</span>}
      {word.meaningVi
        ? <p className={styles.cardMeaning}>{word.meaningVi}</p>
        : <p className={styles.cardMeaning}>{vi ? 'Từ điển chưa có nghĩa tiếng Việt cho từ này.' : 'No Vietnamese meaning in the dictionary yet.'}</p>}
      {others.length > 0 && (
        <details className={styles.more}>
          <summary>{vi ? `Nghĩa khác (${others.length})` : `Other senses (${others.length})`}</summary>
          <ol>{others.map((s, i) => <li key={i}><em>{posLabel(vi, s.pos)}</em>{s.meaning}</li>)}</ol>
        </details>
      )}
      {audioError && <p role="status" className={styles.audioError}>{vi ? 'Chưa phát được âm thanh. Thử lại sau.' : 'Audio unavailable. Try again later.'}</p>}
    </article>
  );
}

/** The turn clock around the required letter. Time always comes from the server deadline. */
export function LetterOrb({ letter, seconds, total }: { letter: string; seconds: number; total: number }) {
  const r = 90, c = 2 * Math.PI * r;
  const fraction = total > 0 ? Math.max(0, Math.min(1, seconds / total)) : 0;
  return (
    <div className={styles.orbWrap} data-urgent={seconds <= 5}>
      <svg className={styles.ring} viewBox="0 0 196 196" aria-hidden="true">
        <circle className={styles.ringTrack} cx="98" cy="98" r={r} fill="none" strokeWidth="10" />
        <circle className={styles.ringBar} cx="98" cy="98" r={r} fill="none" strokeWidth="10" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - fraction)} />
      </svg>
      <div className={styles.orb}><span key={letter} className={styles.orbLetter}>{letter.toUpperCase()}</span></div>
      <span className={styles.seconds} aria-hidden="true">{seconds}s</span>
    </div>
  );
}
