'use client';
import type { ReactNode } from 'react';
import { BookOpenText, Check, Clock3, Crown, Hourglass, Lightbulb, SkipForward, X } from 'lucide-react';
import styles from './king.module.css';

export type Verdict = 'correct' | 'wrong' | 'skipped' | 'timeout' | 'pending';

/**
 * One learning moment after an answer: the verdict, the learner's own answer beside the correct one (only when the server has
 * disclosed it), the source's own meaning / context, and an optional countdown that mirrors the server's resolution hold.
 * Nothing here is invented: every field is a server value or absent.
 */
export function KingFeedback({ vi, verdict, yours, truth, meaning, context, contextLabel, structure, points, note, countdownMs, compact = false, children, live = true }: {
  vi: boolean; verdict: Verdict; yours?: string | null; truth?: string | null; meaning?: string | null; context?: string | null; contextLabel?: string;
  structure?: string | null; points?: number | null; note?: ReactNode; countdownMs?: number; compact?: boolean; children?: ReactNode; live?: boolean;
}) {
  const title = verdict === 'correct' ? (vi ? 'Chính xác!' : 'Correct!') : verdict === 'wrong' ? (vi ? 'Chưa đúng' : 'Not quite')
    : verdict === 'skipped' ? (vi ? 'Đã bỏ qua' : 'Skipped') : verdict === 'timeout' ? (vi ? 'Hết giờ' : "Time's up") : (vi ? 'Lời giải' : 'The answer');
  const Icon = verdict === 'correct' ? Check : verdict === 'wrong' ? X : verdict === 'skipped' ? SkipForward : verdict === 'timeout' ? Clock3 : Hourglass;
  const showYours = yours != null && yours !== '' && !(verdict === 'correct' && truth && same(yours, truth));
  return <div className={styles.feedback} data-verdict={verdict} data-compact={compact} role={live ? 'status' : undefined} aria-live={live ? 'polite' : undefined}>
    <div className={styles.feedHead}>
      <span className={styles.verdictIcon} aria-hidden="true"><Icon /></span>
      <div className="min-w-0"><p className={styles.verdictTitle}>{title}</p>{note && <p className={styles.verdictNote}>{note}</p>}</div>
      {points != null && points > 0 && <span className={styles.feedPoints}><Crown aria-hidden="true" />+{points} {vi ? 'điểm' : 'pts'}</span>}
    </div>
    {(showYours || truth) && <div className={styles.compare}>
      {showYours && <div className={styles.compareCell} data-kind={verdict === 'correct' ? 'yours-good' : 'yours-bad'}>
        <span className={styles.compareLabel}>{vi ? 'Câu trả lời của bạn' : 'Your answer'}</span><span className={styles.compareValue}>{yours}</span></div>}
      {truth && <div className={styles.compareCell} data-kind="truth">
        <span className={styles.compareLabel}>{vi ? 'Đáp án đúng' : 'Correct answer'}</span><span className={styles.compareValue}>{truth}</span></div>}
    </div>}
    {!compact && structure && <div className={styles.explain}><span className={styles.explainLabel}><BookOpenText aria-hidden="true" />{vi ? 'Cấu trúc' : 'Structure'}</span><p className={styles.explainText}>{structure}</p></div>}
    {!compact && meaning && <div className={styles.explain}><span className={styles.explainLabel}><Lightbulb aria-hidden="true" />{vi ? 'Giải nghĩa' : 'Meaning'}</span><p className={styles.explainText} lang="en">{meaning}</p></div>}
    {!compact && context && context !== meaning && <div className={styles.explain}><span className={styles.explainLabel}><BookOpenText aria-hidden="true" />{contextLabel ?? (vi ? 'Ngữ cảnh' : 'Context')}</span><p className={styles.explainText} lang="en">{context}</p></div>}
    {children}
    {countdownMs ? <span className={styles.countdown} style={{ animationDuration: `${countdownMs}ms` }} aria-hidden="true" /> : null}
  </div>;
}

const same = (a: string, b: string) => a.trim().toLowerCase().replace(/[.,!?]/g, '').replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/[.,!?]/g, '').replace(/\s+/g, ' ');

/** Vietnamese / English names of the sentence structures the corpus labels (the family is source metadata). */
export const STRUCTURES: Record<string, [string, string]> = {
  ADVANCED_CHUNK: ['Cụm mở rộng', 'Extended chunks'], ADVERB_PLACEMENT: ['Vị trí trạng từ', 'Adverb placement'], COLLOCATION: ['Kết hợp từ', 'Collocation'],
  CONDITIONAL: ['Câu điều kiện', 'Conditional'], FUTURE: ['Thì tương lai', 'Future'], FUTURE_FORM: ['Cách diễn đạt tương lai', 'Future form'], MODAL: ['Động từ khuyết thiếu', 'Modal verb'],
  NEGATIVE: ['Câu phủ định', 'Negative'], PASSIVE: ['Câu bị động', 'Passive'], PAST_SIMPLE: ['Quá khứ đơn', 'Past simple'],
  PREPOSITIONAL_STRUCTURE: ['Cụm giới từ', 'Prepositional phrase'], PRESENT_CONTINUOUS: ['Hiện tại tiếp diễn', 'Present continuous'],
  PRESENT_PERFECT: ['Hiện tại hoàn thành', 'Present perfect'], PRESENT_SIMPLE: ['Hiện tại đơn', 'Present simple'], RELATIVE_CLAUSE: ['Mệnh đề quan hệ', 'Relative clause'],
  WH_QUESTION: ['Câu hỏi Wh-', 'Wh- question'], YES_NO_QUESTION: ['Câu hỏi Yes/No', 'Yes/No question'], SIMPLE_AFFIRMATIVE: ['Câu khẳng định', 'Affirmative'],
  PHRASAL_VERB: ['Cụm động từ', 'Phrasal verb'], IDIOM: ['Thành ngữ', 'Idiom'], FIXED_EXPRESSION: ['Cụm cố định', 'Fixed expression'], INVERSION: ['Đảo ngữ', 'Inversion'],
  REPEATED_WORDS: ['Từ lặp lại', 'Repeated words'], CONTRACTION: ['Dạng rút gọn', 'Contraction'],
};
export const FAMILY: Record<string, [string, string]> = {
  LETTER_SCRAMBLE: ['Ghép chữ', 'Letter scramble'], MISSING_LETTER: ['Chữ còn thiếu', 'Missing letter'],
  SPELLING_CORRECTION: ['Sửa chính tả', 'Spelling correction'], SPELLING_CHOICE: ['Chọn chính tả', 'Spelling choice'],
  WORD_FAMILY: ['Họ từ', 'Word family'], PART_OF_SPEECH: ['Từ loại trong câu', 'Part of speech'],
  SYNONYM: ['Đồng nghĩa', 'Synonym'], ANTONYM: ['Trái nghĩa', 'Antonym'], COLLOCATION: ['Kết hợp từ', 'Collocation'],
  PHRASAL_VERB: ['Cụm động từ', 'Phrasal verb'], IDIOM_FRAGMENT: ['Thành ngữ', 'Idiom'],
  GRAMMAR_TRAP: ['Ngữ pháp', 'Grammar'], FIXED_EXPRESSION: ['Cụm cố định', 'Fixed expression'],
};
