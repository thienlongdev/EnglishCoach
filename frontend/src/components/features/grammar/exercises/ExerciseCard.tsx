'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  ArrowLeftRight, CircleDot, FolderTree, Link2, ListChecks, Loader2, Pencil, PenLine, ScanSearch, TextCursorInput,
} from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { grammarApi } from '@/services/grammarApi';
import { apiFailure, cx } from '@/lib/grammar/format';
import type { Answer, Exercise, Verdict } from '@/types/grammar';
import { Rich } from '../Inline';
import styles from '../grammar.module.css';
import { answerText, completeness, langOf, newRequestId } from './answer';
import { ChoiceInput } from './Choice';
import { ClozeInput } from './Cloze';
import { ErrorInput } from './ErrorHunt';
import { Aftermath, VerdictBanner } from './Feedback';
import { OrderInput } from './Order';
import { ClassifyInput, MatchInput } from './Pairing';
import type { InputProps } from './shared';
import { OpenInput, TransformInput } from './TextInputs';
import x from './exercises.module.css';

export interface ExerciseCardProps {
  exercise: Exercise;
  /** the topic this exercise belongs to (used by the "my answer is also right" report) */
  topic?: string;
  /**
   * practice: the learner answers, presses "Kiểm tra", the verdict appears in place.
   * check: the card only collects the answer (controlled) and shows feedback once a `verdict` is handed in after the whole check.
   */
  mode?: 'practice' | 'check';
  /** controlled answer (check mode, or a parent that keeps answers) */
  value?: Answer | null;
  onChange?: (answer: Answer | null) => void;
  /** a verdict decided elsewhere (the result of a submitted check); locks the card and shows the feedback */
  verdict?: Verdict | null;
  /** practice: called with the server's verdict of every attempt */
  onResult?: (verdict: Verdict) => void;
  /** a number shown before the prompt (position in a check) */
  number?: number;
  className?: string;
}

const KIND: Record<Exercise['type'], { vi: string; en: string; Icon: React.ElementType }> = {
  choice: { vi: 'Chọn một đáp án', en: 'Choose one', Icon: CircleDot },
  multi: { vi: 'Chọn tất cả đáp án đúng', en: 'Choose every right one', Icon: ListChecks },
  cloze: { vi: 'Điền vào chỗ trống', en: 'Fill the blank', Icon: TextCursorInput },
  order: { vi: 'Sắp xếp các từ', en: 'Put the words in order', Icon: ArrowLeftRight },
  transform: { vi: 'Viết lại câu', en: 'Rewrite the sentence', Icon: Pencil },
  error: { vi: 'Tìm chỗ sai', en: 'Find the mistake', Icon: ScanSearch },
  match: { vi: 'Nối từng cặp', en: 'Match the pairs', Icon: Link2 },
  classify: { vi: 'Xếp vào nhóm', en: 'Sort into groups', Icon: FolderTree },
  open: { vi: 'Tự viết', en: 'Write it yourself', Icon: PenLine },
};

function inputFor(type: Exercise['type']): React.ComponentType<InputProps> {
  switch (type) {
    case 'choice': return (p) => <ChoiceInput {...p} multi={false} />;
    case 'multi': return (p) => <ChoiceInput {...p} multi />;
    case 'cloze': return ClozeInput;
    case 'order': return OrderInput;
    case 'transform': return TransformInput;
    case 'error': return ErrorInput;
    case 'match': return MatchInput;
    case 'classify': return ClassifyInput;
    default: return OpenInput;
  }
}

/* the input components for each type, created once (never inside a render: that would remount the field on every key) */
const INPUTS: Record<Exercise['type'], React.ComponentType<InputProps>> = {
  choice: inputFor('choice'),
  multi: inputFor('multi'),
  cloze: inputFor('cloze'),
  order: inputFor('order'),
  transform: inputFor('transform'),
  error: inputFor('error'),
  match: inputFor('match'),
  classify: inputFor('classify'),
  open: inputFor('open'),
};

const failureText = (err: unknown, vi: boolean): string => {
  const { status } = apiFailure(err);
  if (status === 429) return vi ? 'Bạn gửi hơi nhanh. Đợi một chút rồi bấm lại nhé, câu trả lời của bạn vẫn còn đó.' : 'You are sending a little fast. Wait a moment and press again; your answer is still here.';
  if (status === 401 || status === 403) return vi ? 'Phiên đăng nhập có vấn đề. Hãy đăng nhập lại rồi thử tiếp.' : 'There is a problem with your sign-in. Please sign in again and continue.';
  if (status === 404) return vi ? 'Không tìm thấy câu hỏi này nữa. Hãy tải lại trang.' : 'This question is no longer there. Please reload the page.';
  return vi ? 'Chưa kiểm tra được. Câu trả lời của bạn vẫn còn đó, hãy bấm lại.' : 'The check did not go through. Your answer is still here; press again.';
};

/**
 * One grammar exercise. The nine types share one frame: the prompt (the instruction), an optional context or dialogue, the input
 * of that type, and, after an answer, the verdict in words and an icon, the reason for every part, and the explanation.
 */
export function ExerciseCard({ exercise, topic, mode = 'practice', value, onChange, verdict: verdictProp, onResult, number, className }: ExerciseCardProps) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const base = useId();
  const labelId = `${base}-p`;

  const [inner, setInner] = useState<Answer | null>(null);
  const [innerVerdict, setInnerVerdict] = useState<Verdict | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const prevId = useRef(exercise.id);

  /* a card handed a different exercise starts clean */
  useEffect(() => {
    if (prevId.current === exercise.id) return;
    prevId.current = exercise.id;
    setInner(null);
    setInnerVerdict(null);
    setBusy(false);
    setFailure(null);
    pending.current = null;
  }, [exercise.id]);

  const answer = value !== undefined ? value : inner;
  const verdict = verdictProp !== undefined ? verdictProp : innerVerdict;
  const locked = busy || !!verdict;
  const full = completeness(exercise, answer) === 'full';

  const change = useCallback((next: Answer | null) => {
    if (value === undefined) setInner(next);
    onChange?.(next);
    setFailure(null);
  }, [value, onChange]);

  const submit = useCallback(async () => {
    if (mode !== 'practice' || busy || verdict || !answer || completeness(exercise, answer) !== 'full') return;
    const key = `${exercise.id}:${JSON.stringify(answer)}`;
    if (!pending.current || pending.current.key !== key) pending.current = { key, id: newRequestId() };
    setBusy(true);
    setFailure(null);
    try {
      const v = await grammarApi.attempt(exercise.id, answer, pending.current.id);
      pending.current = null;
      setInnerVerdict(v);
      onResult?.(v);
    } catch (err) {
      setFailure(failureText(err, vi));
    } finally {
      setBusy(false);
    }
  }, [mode, busy, verdict, answer, exercise, onResult, vi]);

  /* try again: a wrong answer starts from a clean card; an unrecognised sentence is edited, so it stays */
  const retry = useCallback(() => {
    pending.current = null;
    setInnerVerdict(null);
    setFailure(null);
    if (verdict?.outcome !== 'UNRECOGNIZED') change(null);
  }, [verdict, change]);

  /* an unanswered item of a finished check carries no per-part facts (the server reveals nothing for it): the input stays plain */
  const inputVerdict = verdict && !verdict.reveal.unanswered ? verdict : null;
  const Input = INPUTS[exercise.type] ?? OpenInput;
  const kind = KIND[exercise.type] ?? KIND.open;
  const Icon = kind.Icon;
  const canRetry = mode === 'practice' && verdictProp === undefined;
  const openType = exercise.type === 'open';
  const buttonLabel = openType ? (vi ? 'Đối chiếu' : 'Compare') : (vi ? 'Kiểm tra' : 'Check');
  const waiting = vi
    ? (exercise.type === 'order' ? 'Xếp hết các từ để kiểm tra.' : exercise.type === 'cloze' ? 'Điền hết các chỗ trống để kiểm tra.' : exercise.type === 'match' ? 'Nối hết các cặp để kiểm tra.' : exercise.type === 'classify' ? 'Xếp hết các mục vào nhóm để kiểm tra.' : 'Hãy trả lời để kiểm tra.')
    : (exercise.type === 'order' ? 'Place every word to check.' : exercise.type === 'cloze' ? 'Fill every blank to check.' : exercise.type === 'match' ? 'Pair every item to check.' : exercise.type === 'classify' ? 'Put every item in a group to check.' : 'Answer to check.');

  return (
    <article className={cx(x.card, className)} data-type={exercise.type} data-mode={mode} data-outcome={verdict?.outcome}>
      <header className={x.head}>
        <p className={x.kind}>
          <Icon aria-hidden="true" />
          <span>{vi ? kind.vi : kind.en}</span>
          {number != null ? <span className={x.number}>{vi ? `Câu ${number}` : `Question ${number}`}</span> : null}
        </p>
        <p id={labelId} className={x.prompt}><Rich text={exercise.prompt} /></p>
        {exercise.context ? <p className={x.context} lang={langOf(exercise.context)}><Rich text={exercise.context} /></p> : null}
        {exercise.turns?.length ? (
          <ol className={x.turns} aria-label={vi ? 'Đoạn hội thoại' : 'The dialogue'}>
            {exercise.turns.map((turn, i) => (
              <li key={i} className={x.turn} data-alt={turn.who !== exercise.turns?.[0]?.who ? 'true' : 'false'}>
                <span className={x.who} aria-hidden="true">{turn.who}</span>
                <p className={x.say} lang={langOf(turn.t)}><span className={x.srOnly}>{turn.who}: </span><Rich text={turn.t} /></p>
              </li>
            ))}
          </ol>
        ) : null}
      </header>

      {verdict ? <VerdictBanner verdict={verdict} vi={vi} /> : null}

      <div className={x.body}>
        <Input
          exercise={exercise}
          value={answer}
          onChange={change}
          locked={locked}
          verdict={inputVerdict}
          labelId={labelId}
          vi={vi}
          onEnter={mode === 'practice' ? submit : undefined}
        />
      </div>

      {mode === 'practice' && !verdict ? (
        <div className={x.actions}>
          <button type="button" className={cx(styles.btn, styles.btnPrimary)} onClick={submit} disabled={!full || busy} aria-describedby={!full ? `${base}-wait` : undefined}>
            {busy ? <Loader2 className={styles.spin} aria-hidden="true" /> : null}
            {buttonLabel}
          </button>
          {!full && !busy ? <span id={`${base}-wait`} className={x.actionHint}>{waiting}</span> : null}
        </div>
      ) : null}
      {failure ? <p className={x.failLine} role="alert">{failure}</p> : null}

      {verdict ? (
        <Aftermath
          verdict={verdict}
          vi={vi}
          topic={topic}
          answerText={answerText(exercise, answer)}
          onRetry={canRetry ? retry : undefined}
        />
      ) : null}
    </article>
  );
}

export default ExerciseCard;
