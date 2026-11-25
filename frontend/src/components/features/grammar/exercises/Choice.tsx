'use client';

import React, { useId } from 'react';
import { Check } from 'lucide-react';
import { Rich } from '../Inline';
import { DiagramBody } from '../diagrams';
import { choiceOf, choicesOf, langOf } from './answer';
import { Mark, type InputProps, type MarkState } from './shared';
import x from './exercises.module.css';

/**
 * choice (one right answer, radio group) and multi (every right answer, checkbox group).
 * Before the answer the options are plain choices. After it EVERY option shows the reason for it (the note the author wrote for
 * that exact option), the learner's pick is marked, and the right ones are marked even when they were not picked.
 */
export function ChoiceInput({ exercise, value, onChange, locked, verdict, labelId, vi, multi }: InputProps & { multi: boolean }) {
  const group = useId();
  const options = exercise.options ?? [];
  const picked = multi ? new Set(choicesOf(value)) : new Set(choiceOf(value) == null ? [] : [choiceOf(value) as number]);
  const reveal = verdict?.reveal.options;
  const review = !!reveal;
  const stem = exercise.stem;

  const toggle = (i: number) => {
    if (locked) return;
    if (!multi) { onChange({ choice: i }); return; }
    const next = new Set(picked);
    if (next.has(i)) next.delete(i); else next.add(i);
    onChange(next.size ? { choices: Array.from(next).sort((a, b) => a - b) } : null);
  };

  return (
    <div className={x.choiceBlock}>
      {stem ? <p className={x.stem} lang={langOf(stem)}><Rich text={stem} /></p> : null}
      <div className={x.options} role={multi ? 'group' : 'radiogroup'} aria-labelledby={labelId}>
        {options.map((o) => {
          const on = picked.has(o.i);
          const fact = reveal?.find((r) => r.i === o.i);
          let state: MarkState = 'neutral';
          let word: string | undefined;
          if (fact) {
            if (fact.ok && on) { state = 'right'; word = multi ? (vi ? 'Bạn chọn, đúng' : 'You chose it, right') : (vi ? 'Bạn chọn, đúng' : 'Your answer, right'); }
            else if (!fact.ok && on) { state = 'wrong'; word = vi ? 'Bạn chọn, chưa đúng' : 'You chose it, not right'; }
            else if (fact.ok && !on) { state = 'missed'; word = multi ? (vi ? 'Đúng, bạn chưa chọn' : 'Right, you did not choose it') : (vi ? 'Đáp án đúng' : 'The right answer'); }
            else { state = 'neutral'; word = multi ? (vi ? 'Không chọn là đúng' : 'Rightly left out') : (vi ? 'Không phải đáp án' : 'Not the answer'); }
          }
          const id = `${group}-${o.i}`;
          const text = o.t ?? '';
          return (
            <div key={o.i} className={x.opt} data-on={on ? 'true' : 'false'} data-state={review ? state : undefined} data-locked={locked ? 'true' : undefined}>
              <label className={x.optLabel} htmlFor={id}>
                <input
                  id={id}
                  className={x.optInput}
                  type={multi ? 'checkbox' : 'radio'}
                  name={group}
                  checked={on}
                  disabled={locked}
                  onChange={() => toggle(o.i)}
                />
                <span className={x.optMark} data-kind={multi ? 'multi' : 'single'} aria-hidden="true">{multi ? <Check /> : null}</span>
                <span className={x.optBody}>
                  {text ? <span className={x.optText} lang={langOf(text)}><Rich text={text} /></span> : null}
                  {review && word ? <Mark state={state} vi={vi} label={word} className={x.optMarkWord} /> : null}
                </span>
              </label>
              {o.diagram ? <div className={x.optDiagram}><DiagramBody spec={o.diagram} /></div> : null}
              {review && fact?.note ? <p className={x.optNote}><Rich text={fact.note} /></p> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
