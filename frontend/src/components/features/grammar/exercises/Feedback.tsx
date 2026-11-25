'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Check, Info, Lightbulb, Loader2, Minus, RotateCcw, X } from 'lucide-react';
import { grammarApi } from '@/services/grammarApi';
import { apiFailure, cx } from '@/lib/grammar/format';
import { labelOf } from '@/lib/grammar/misconceptions';
import type { Outcome, Verdict } from '@/types/grammar';
import { Rich } from '../Inline';
import styles from '../grammar.module.css';
import x from './exercises.module.css';

type Pair = { vi: string; en: string };
interface Copy { title: Pair; body?: Pair }

/* Warm and precise: what happened, in plain words, never a scolding and never a verdict the system cannot stand behind. */
const COPY: Record<Outcome, Copy> = {
  CORRECT: { title: { vi: 'Đúng rồi', en: 'Correct' } },
  ACCEPTABLE: {
    title: { vi: 'Chấp nhận được', en: 'Acceptable' },
    body: { vi: 'Câu của bạn dùng được.', en: 'Your answer works.' },
  },
  PARTIAL: {
    title: { vi: 'Đúng một phần', en: 'Partly right' },
    body: { vi: 'Bạn đã làm đúng một phần. Từng chỗ được chỉ ra bên dưới, kèm lý do.', en: 'Part of it is right. Each part is shown below, with the reason.' },
  },
  WRONG: {
    title: { vi: 'Chưa đúng', en: 'Not right yet' },
    body: { vi: 'Không sao, cùng xem chỗ vướng ở đâu. Lý do và đáp án đúng nằm ngay bên dưới.', en: 'No problem, let us see where it went wrong. The reason and the right answer are just below.' },
  },
  UNRECOGNIZED: {
    title: { vi: 'Hệ thống chưa nhận ra câu này', en: 'The system does not recognise this sentence' },
    body: { vi: 'Câu của bạn có thể vẫn đúng: hãy so với đáp án mẫu.', en: 'Your sentence may still be right: compare it with the model answer.' },
  },
  SELF_REVIEW: {
    title: { vi: 'Tự đối chiếu', en: 'Compare it yourself' },
    body: { vi: 'Câu mở không chấm điểm. Hãy so bài của bạn với bài mẫu và danh sách bên dưới.', en: 'An open task is not graded. Compare your writing with the model and the list below.' },
  },
};

const pick = (p: Pair, vi: boolean) => (vi ? p.vi : p.en);

function Glyph({ outcome, unanswered }: { outcome: Outcome; unanswered: boolean }) {
  if (unanswered) return <Minus aria-hidden="true" />;
  if (outcome === 'CORRECT' || outcome === 'ACCEPTABLE') return <Check aria-hidden="true" />;
  if (outcome === 'WRONG') return <X aria-hidden="true" />;
  if (outcome === 'PARTIAL') return <Minus aria-hidden="true" />;
  if (outcome === 'UNRECOGNIZED') return <span className={x.glyphText} aria-hidden="true">?</span>;
  return <Info aria-hidden="true" />;
}

/** The first thing under the question after an answer: what the verdict is, in words and an icon. */
export function VerdictBanner({ verdict, vi }: { verdict: Verdict; vi: boolean }) {
  const unanswered = !!verdict.reveal.unanswered;
  const copy = COPY[verdict.outcome];
  const title = unanswered ? (vi ? 'Câu này chưa được trả lời' : 'This question was not answered') : pick(copy.title, vi);
  const body = unanswered
    ? (vi ? 'Bạn chưa trả lời câu này trong bài kiểm tra, nên câu này được tính là chưa đúng. Phần giải thích nằm bên dưới.' : 'You did not answer this one in the check, so it counts as not right. The explanation is below.')
    : copy.body ? pick(copy.body, vi) : null;
  const hasNote = verdict.outcome === 'ACCEPTABLE' && (!!verdict.reveal.note || (verdict.reveal.parts ?? []).some((p) => p.outcome === 'ACCEPTABLE' && p.note));
  return (
    <div className={x.banner} data-outcome={unanswered ? 'SELF_REVIEW' : verdict.outcome} role="status" aria-live="polite">
      <span className={x.bannerIcon}><Glyph outcome={verdict.outcome} unanswered={unanswered} /></span>
      <div className={x.bannerBody}>
        <p className={x.bannerTitle}>{title}</p>
        {body ? <p className={x.bannerText}>{body}{hasNote ? (vi ? ' Lưu ý nhỏ bên dưới cho biết khi nào nên chọn cách nào.' : ' The small note below tells you when to choose which.') : ''}</p> : null}
        {verdict.outcome === 'UNRECOGNIZED' ? (
          <p className={x.bannerText}>{vi ? 'Câu này không bị tính là sai và không làm giảm kết quả của bạn.' : 'This one is not counted as wrong and does not lower your result.'}</p>
        ) : null}
      </div>
    </div>
  );
}

type ReportState = 'idle' | 'sending' | 'sent' | 'failed';

interface AftermathProps {
  verdict: Verdict;
  vi: boolean;
  topic?: string;
  /** a short text of the learner's answer, for the "my answer is also right" report */
  answerText: string;
  /** "try again" is offered only while the card can still be answered (practice) */
  onRetry?: () => void;
}

/** Under the answer: the reason, the pattern behind a mistake, and what the learner can do next. */
export function Aftermath({ verdict, vi, topic, answerText, onRetry }: AftermathProps) {
  const [report, setReport] = useState<ReportState>('idle');
  const [limited, setLimited] = useState(false);
  const outcome = verdict.outcome;
  const unanswered = !!verdict.reveal.unanswered;
  const tags = Array.from(new Set(verdict.tags)).map((t) => labelOf(t, vi)).filter((t): t is string => !!t);
  const miss = (outcome === 'WRONG' || outcome === 'PARTIAL') && !unanswered;

  const sendReport = async () => {
    if (report === 'sending' || report === 'sent') return;
    setReport('sending');
    try {
      await grammarApi.report({ kind: 'ANSWER', topic, exerciseId: verdict.exerciseId, answer: answerText || undefined });
      setReport('sent');
    } catch (err) {
      setLimited(apiFailure(err).status === 429);
      setReport('failed');
    }
  };

  return (
    <div className={x.after}>
      {verdict.explain ? (
        <section className={x.explain} aria-labelledby={`${verdict.exerciseId}-why`}>
          <Lightbulb className={x.explainIcon} aria-hidden="true" />
          <div>
            <h4 id={`${verdict.exerciseId}-why`} className={x.explainTitle}>{vi ? 'Vì sao' : 'Why'}</h4>
            <p className={x.explainText}><Rich text={verdict.explain} /></p>
          </div>
        </section>
      ) : null}

      {miss && tags.length ? (
        <p className={x.pattern}>
          <span className={x.patternLabel}>{vi ? 'Kiểu nhầm này:' : 'The pattern behind it:'}</span>
          {tags.map((t) => <span key={t} className={styles.chip}>{t}</span>)}
          <Link href="/grammar/mistakes" className={styles.inlineLink}>{vi ? 'Xem Lỗi của tôi' : 'See My mistakes'}</Link>
        </p>
      ) : null}

      {outcome === 'UNRECOGNIZED' ? (
        <div className={x.unknownBox}>
          {report === 'sent' ? (
            <p className={x.thanks} role="status"><Check aria-hidden="true" />{vi ? 'Cảm ơn bạn. Báo cáo về câu này đã được ghi lại.' : 'Thank you. Your report about this sentence was recorded.'}</p>
          ) : (
            <div className={x.actionRow}>
              <button type="button" className={cx(styles.btn, styles.btnSoft)} onClick={sendReport} disabled={report === 'sending'}>
                {report === 'sending' ? <Loader2 className={styles.spin} aria-hidden="true" /> : null}
                {vi ? 'Mình thấy câu mình cũng đúng' : 'I think my sentence is right too'}
              </button>
              {onRetry ? (
                <button type="button" className={cx(styles.btn, styles.btnQuiet)} onClick={onRetry}>
                  <RotateCcw aria-hidden="true" />{vi ? 'Mình sẽ sửa lại' : 'I will fix it'}
                </button>
              ) : null}
            </div>
          )}
          {report === 'failed' ? (
            <p className={x.failLine} role="alert">
              {limited
                ? (vi ? 'Bạn đã gửi khá nhiều báo cáo hôm nay. Hãy thử lại vào ngày mai.' : 'You have sent many reports today. Please try again tomorrow.')
                : (vi ? 'Chưa gửi được báo cáo. Hãy thử lại sau ít phút.' : 'The report was not sent. Please try again in a moment.')}
            </p>
          ) : null}
        </div>
      ) : null}

      {onRetry && (outcome === 'WRONG' || outcome === 'PARTIAL') && !unanswered ? (
        <div className={x.actionRow}>
          <button type="button" className={cx(styles.btn, styles.btnQuiet)} onClick={onRetry}>
            <RotateCcw aria-hidden="true" />{vi ? 'Thử lại câu này' : 'Try this one again'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
