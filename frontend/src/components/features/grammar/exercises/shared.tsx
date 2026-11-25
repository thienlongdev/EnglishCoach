'use client';

import React from 'react';
import { Check, CircleHelp, Info, Minus, X } from 'lucide-react';
import type { Answer, Exercise, Outcome, Verdict } from '@/types/grammar';
import { cx } from '@/lib/grammar/format';
import x from './exercises.module.css';

/** What every input receives. `locked` = answered (or being judged): the answer can no longer change. */
export interface InputProps {
  exercise: Exercise;
  value: Answer | null;
  onChange: (answer: Answer | null) => void;
  locked: boolean;
  verdict: Verdict | null;
  /** id of the element that holds the prompt: groups are labelled by it */
  labelId: string;
  vi: boolean;
  /** Enter in the last field asks for the check (practice mode only) */
  onEnter?: () => void;
}

/** One state vocabulary for every review mark: always an icon AND a word, never colour alone. */
export type MarkState = 'right' | 'wrong' | 'partial' | 'unknown' | 'style' | 'missed' | 'neutral';

const WORD: Record<MarkState, { vi: string; en: string }> = {
  right: { vi: 'Đúng', en: 'Right' },
  wrong: { vi: 'Chưa đúng', en: 'Not right' },
  partial: { vi: 'Đúng một phần', en: 'Partly right' },
  unknown: { vi: 'Hệ thống chưa nhận ra', en: 'Not recognised' },
  style: { vi: 'Không sai, chỉ là văn phong', en: 'Not wrong, only style' },
  missed: { vi: 'Đáp án đúng', en: 'The right answer' },
  neutral: { vi: '', en: '' },
};
export const markWord = (state: MarkState, vi: boolean): string => (vi ? WORD[state].vi : WORD[state].en);

export function MarkIcon({ state }: { state: MarkState }) {
  if (state === 'right' || state === 'missed') return <Check aria-hidden="true" />;
  if (state === 'wrong') return <X aria-hidden="true" />;
  if (state === 'unknown') return <CircleHelp aria-hidden="true" />;
  if (state === 'style') return <Info aria-hidden="true" />;
  return <Minus aria-hidden="true" />;
}

/** A small "icon + word" mark. */
export function Mark({ state, vi, label, className }: { state: MarkState; vi: boolean; label?: string; className?: string }) {
  const word = label ?? markWord(state, vi);
  if (!word) return null;
  return (
    <span className={cx(x.mark, className)} data-state={state}>
      <MarkIcon state={state} />
      <span>{word}</span>
    </span>
  );
}

/** One row of a review list: a state icon, a title line, the learner's text, the right text and the reason. */
export function ReviewRow({ state, vi, title, children }: { state: MarkState; vi: boolean; title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li className={x.rv} data-state={state}>
      <span className={x.rvIcon}><MarkIcon state={state} /><span className={x.srOnly}>{markWord(state, vi)}</span></span>
      <div className={x.rvBody}>
        <p className={x.rvTitle}>{title}</p>
        {children}
      </div>
    </li>
  );
}

/** A labelled line inside a review row: "Bạn chọn", "Đáp án", "Vì sao". */
export function RvLine({ label, children, tone }: { label: string; children: React.ReactNode; tone?: 'right' | 'wrong' }) {
  return (
    <p className={x.rvLine} data-tone={tone}>
      <span className={x.rvLabel}>{label}</span>
      <span className={x.rvText}>{children}</span>
    </p>
  );
}

export const OUTCOME_STATE: Record<Outcome, MarkState> = {
  CORRECT: 'right',
  ACCEPTABLE: 'right',
  PARTIAL: 'partial',
  WRONG: 'wrong',
  UNRECOGNIZED: 'unknown',
  SELF_REVIEW: 'neutral',
};
