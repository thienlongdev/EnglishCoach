'use client';

import React, { useRef, useState } from 'react';
import { Lightbulb } from 'lucide-react';
import { Rich } from '../Inline';
import { blankKeys, blanksOf, langOf, stemParts } from './answer';
import { MarkIcon, ReviewRow, RvLine, markWord, type InputProps, type MarkState } from './shared';
import x from './exercises.module.css';

const partState = (outcome: string): MarkState => {
  if (outcome === 'CORRECT' || outcome === 'ACCEPTABLE') return 'right';
  if (outcome === 'UNRECOGNIZED') return 'unknown';
  if (outcome === 'PARTIAL') return 'partial';
  return 'wrong';
};

/**
 * cloze: the blanks sit inside the stem as real text fields. `hint` is shown only when asked for. After the answer every blank
 * says what it was judged to be, what was expected, and the reason the author wrote for that exact wrong form.
 */
export function ClozeInput({ exercise, value, onChange, locked, verdict, labelId, vi, onEnter }: InputProps) {
  const keys = blankKeys(exercise);
  const blanks = blanksOf(value);
  const parts = stemParts(exercise.stem ?? '');
  const refs = useRef<Record<string, HTMLInputElement | null>>({});
  const [hints, setHints] = useState<Record<string, boolean>>({});
  const reveal = verdict?.reveal.parts;
  const single = keys.length === 1;
  const hinted = keys.filter((k) => exercise.blanks?.[k]?.hint);
  const stem = exercise.stem ?? '';

  const set = (key: string, text: string) => {
    const next = { ...blanks, [key]: text };
    const any = keys.some((k) => (next[k] ?? '').length > 0);
    onChange(any ? { blanks: next } : null);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>, key: string) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const next = keys[keys.indexOf(key) + 1];
    if (next && refs.current[next]) refs.current[next]?.focus();
    else onEnter?.();
  };

  return (
    <div className={x.clozeBlock}>
      <div className={x.cloze} lang={langOf(stem)} role="group" aria-labelledby={labelId}>
        {parts.map((p, n) => {
          if ('text' in p) return <Rich key={n} text={p.text} />;
          const key = p.blank;
          if (!keys.includes(key)) return <span key={n}>___</span>;
          const text = blanks[key] ?? '';
          const fact = reveal?.find((r) => r.key === key);
          const state = fact ? partState(fact.outcome) : null;
          return (
            <span key={n} className={x.blankWrap} data-state={state ?? undefined}>
              <input
                ref={(el) => { refs.current[key] = el; }}
                className={x.blank}
                type="text"
                value={text}
                disabled={locked}
                maxLength={120}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                inputMode="text"
                lang="en"
                size={Math.min(28, Math.max(6, text.length + 2))}
                aria-label={single ? (vi ? 'Chỗ trống' : 'The blank') : (vi ? `Chỗ trống ${key}` : `Blank ${key}`)}
                aria-describedby={exercise.blanks?.[key]?.hint && hints[key] ? `${labelId}-h${key}` : undefined}
                onChange={(e) => set(key, e.target.value)}
                onKeyDown={(e) => onKey(e, key)}
              />
              {state ? <span className={x.blankMark}><MarkIcon state={state} /></span> : null}
            </span>
          );
        })}
      </div>

      {!locked && hinted.length ? (
        <div className={x.hints}>
          {hinted.map((k) => (
            <div key={k} className={x.hintItem}>
              <button
                type="button"
                className={x.hintBtn}
                aria-expanded={!!hints[k]}
                onClick={() => setHints((h) => ({ ...h, [k]: !h[k] }))}
              >
                <Lightbulb aria-hidden="true" />
                {single || hinted.length === 1
                  ? (hints[k] ? (vi ? 'Ẩn gợi ý' : 'Hide the hint') : (vi ? 'Cho mình một gợi ý' : 'Give me a hint'))
                  : (hints[k] ? (vi ? `Ẩn gợi ý ${k}` : `Hide hint ${k}`) : (vi ? `Gợi ý cho chỗ trống ${k}` : `Hint for blank ${k}`))}
              </button>
              {hints[k] ? <p id={`${labelId}-h${k}`} className={x.hintText}><Rich text={exercise.blanks?.[k]?.hint ?? ''} /></p> : null}
            </div>
          ))}
        </div>
      ) : null}

      {reveal?.length ? (
        <ul className={x.rvList} aria-label={vi ? 'Từng chỗ trống' : 'Each blank'}>
          {reveal.map((r) => {
            const state = partState(r.outcome);
            const typed = (blanks[r.key] ?? '').trim();
            const expected = r.expected ?? [];
            const label = single ? (vi ? 'Chỗ trống' : 'The blank') : (vi ? `Chỗ trống ${r.key}` : `Blank ${r.key}`);
            return (
              <ReviewRow key={r.key} state={state} vi={vi} title={<>{label}{': '}<span className={x.rvStrong}>{markWord(state, vi)}</span></>}>
                <RvLine label={vi ? 'Bạn điền' : 'You wrote'} tone={state === 'wrong' ? 'wrong' : undefined}>
                  {typed ? <span lang="en" className={state === 'wrong' ? x.struck : undefined}>{typed}</span> : <em>{vi ? '(để trống)' : '(left empty)'}</em>}
                </RvLine>
                {state !== 'right' && expected.length ? (
                  <RvLine label={state === 'unknown' ? (vi ? 'Đáp án mẫu' : 'Model answer') : (vi ? 'Đáp án' : 'Answer')} tone="right">
                    <span lang="en">{expected.slice(0, 3).join(vi ? '  hoặc  ' : '  or  ')}</span>
                  </RvLine>
                ) : null}
                {state === 'right' && expected.length > 1 ? (
                  <RvLine label={vi ? 'Cũng đúng' : 'Also right'}>
                    <span lang="en">{expected.filter((e) => e.trim().toLowerCase() !== typed.toLowerCase()).slice(0, 3).join(vi ? '  hoặc  ' : '  or  ')}</span>
                  </RvLine>
                ) : null}
                {r.note ? <RvLine label={state === 'right' ? (vi ? 'Lưu ý' : 'Note') : (vi ? 'Vì sao' : 'Why')}><Rich text={r.note} /></RvLine> : null}
              </ReviewRow>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
