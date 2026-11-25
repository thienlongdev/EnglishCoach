'use client';
import { ArrowLeftRight, ArrowRight, BookOpen, Clock3 } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { BilingualReadingCard as Card } from '@/types/bilingualReading';
import styles from './glass/readingGlass.module.css';
import { ReadingCover } from './glass/ReadingCover';
/**
 * Bilingual library card (Echo Glass 2026-10-23): the whole card is ONE button. The cover is typographic art of the content
 * type (article / story; the corpus has no pictures); a missing Vietnamese title is simply not shown — never invented.
 */
export function BilingualReadingCard({ card, onClick }: { card: Card; onClick: () => void }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const story = card.contentType !== 'ARTICLE';
  return <button type="button" onClick={onClick} className={`${styles.card} text-left cursor-pointer`} data-tone="bilingual">
    <span className={styles.cardCover}>
      <ReadingCover family={story ? 'story' : 'bilingual'} seed={card.id} word={story ? (vi ? 'Truyện ngắn' : 'Short story') : (vi ? 'Bài báo' : 'Article')} />
      <span className={styles.coverBadges}>
        <span className={styles.coverTopic}><span aria-hidden="true" className={styles.coverDot} style={{ background: story ? '#db2777' : '#2563eb' }} /><span>{story ? (vi ? 'Truyện ngắn' : 'Short story') : (vi ? 'Bài báo' : 'Article')}</span></span>
        <span className={styles.langPair} aria-label={vi ? 'Tiếng Anh và tiếng Việt' : 'English and Vietnamese'}><b>EN</b><ArrowLeftRight aria-hidden="true" /><b>VI</b></span>
      </span>
    </span>
    <span className={styles.cardBody}>
      <span className={`${styles.cardTitle} line-clamp-2`}>{card.titleEn}</span>
      {card.titleVi && <span className={styles.biTitleVi}>{card.titleVi}</span>}
      <span className={styles.cardFoot}>
        <span className={styles.cardFacts}>
          <span><Clock3 aria-hidden="true" />{vi ? `${card.estimatedMinutes} phút đọc` : `${card.estimatedMinutes} min read`}</span>
          <span><BookOpen aria-hidden="true" />{card.wordCount.toLocaleString(vi ? 'vi-VN' : 'en-US')} {vi ? 'từ' : 'words'}</span>
        </span>
        <span className={styles.openCue} aria-hidden="true">{vi ? 'Đọc song ngữ' : 'Read'}<ArrowRight className="h-3.5 w-3.5" /></span>
      </span>
    </span>
  </button>;
}
