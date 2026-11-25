'use client';

import React from 'react';
import { Flag } from 'lucide-react';
import { Rich } from '../Inline';
import { noneOf, pickedOf } from './answer';
import { Mark, ReviewRow, RvLine, type InputProps, type MarkState } from './shared';
import x from './exercises.module.css';

/**
 * error: the sentence is cut into parts; touch the part that is wrong, or say that the sentence has no error. After the answer
 * every part that matters is told: the wrong part with its fix and its reason, a "looks wrong but is fine" part, and a part that
 * is only style (never an error).
 */
export function ErrorInput({ exercise, value, onChange, locked, verdict, labelId, vi }: InputProps) {
  const segments = exercise.segments ?? [];
  const picked = new Set(pickedOf(value));
  const none = noneOf(value);
  const facts = verdict?.reveal.segments;
  const noError = verdict?.reveal.noError;

  const toggle = (i: number) => {
    if (locked) return;
    const next = new Set(picked);
    if (next.has(i)) next.delete(i); else next.add(i);
    onChange(next.size ? { picked: Array.from(next).sort((a, b) => a - b) } : null);
  };
  const toggleNone = () => {
    if (locked) return;
    onChange(none ? null : { picked: [], none: true });
  };

  const segState = (i: number): MarkState | null => {
    const f = facts?.find((s) => s.i === i);
    if (!f) return null;
    const on = picked.has(i);
    if (f.bad) return on ? 'right' : 'missed';
    if (f.style) return on ? 'style' : null;
    return on ? 'wrong' : null;
  };

  const details = (facts ?? []).filter((f) => f.bad || f.style || picked.has(f.i));

  return (
    <div className={x.errorBlock}>
      <ul className={x.sentence} aria-labelledby={labelId}>
        {segments.map((s, i) => {
          const on = picked.has(i);
          const state = segState(i);
          return (
            <li key={i}>
              <button
                type="button"
                className={x.seg}
                lang="en"
                aria-pressed={on}
                disabled={locked}
                data-on={on ? 'true' : 'false'}
                data-state={state ?? undefined}
                onClick={() => toggle(i)}
              >
                {on && !facts ? <Flag aria-hidden="true" /> : null}
                <span>{s.t}</span>
                {facts && state === 'missed' ? <span className={x.srOnly}>{vi ? ' (phần sai, bạn chưa chạm)' : ' (the wrong part, not touched)'}</span> : null}
                {facts && state === 'right' ? <span className={x.srOnly}>{vi ? ' (phần sai, bạn đã chạm đúng)' : ' (the wrong part, you found it)'}</span> : null}
                {facts && state === 'wrong' ? <span className={x.srOnly}>{vi ? ' (phần này không sai)' : ' (this part is fine)'}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      <div className={x.errorTools}>
        <button type="button" className={x.noErrBtn} aria-pressed={none} disabled={locked} onClick={toggleNone}>
          {vi ? 'Câu này đúng, không có lỗi' : 'This sentence is fine, no error'}
        </button>
        {!facts ? <p className={x.orderHow}>{vi ? 'Chạm lại vào một phần để bỏ chọn.' : 'Touch a part again to unselect it.'}</p> : null}
      </div>

      {facts ? (
        <ul className={x.rvList}>
          {noError ? (
            <ReviewRow state={none || !picked.size ? 'right' : 'wrong'} vi={vi} title={vi ? 'Câu này không có lỗi' : 'This sentence has no error'}>
              {!none && picked.size ? <RvLine label={vi ? 'Bạn đã chạm' : 'You touched'} tone="wrong">{Array.from(picked).map((i) => <span key={i} lang="en" className={x.alt}>{segments[i]?.t}</span>)}</RvLine> : null}
            </ReviewRow>
          ) : null}
          {details.map((f) => {
            const text = segments[f.i]?.t ?? '';
            const on = picked.has(f.i);
            const state: MarkState = f.bad ? (on ? 'right' : 'missed') : f.style ? 'style' : 'wrong';
            const title = f.bad
              ? (on ? (vi ? 'Bạn tìm đúng phần sai' : 'You found the wrong part') : (vi ? 'Đây là phần sai' : 'This is the wrong part'))
              : f.style
                ? (vi ? 'Không sai, chỉ là văn phong' : 'Not wrong, only style')
                : (vi ? 'Phần này không sai' : 'This part is fine');
            return (
              <ReviewRow key={f.i} state={state} vi={vi} title={title}>
                <RvLine label={vi ? 'Phần' : 'Part'} tone={f.bad ? 'wrong' : undefined}><span lang="en" className={f.bad ? x.struck : undefined}>{text}</span></RvLine>
                {f.bad && f.fix?.length ? <RvLine label={vi ? 'Sửa thành' : 'Fix'} tone="right"><span lang="en">{f.fix.join(vi ? '  hoặc  ' : '  or  ')}</span></RvLine> : null}
                {f.note ? <RvLine label={vi ? 'Vì sao' : 'Why'}><Rich text={f.note} /></RvLine> : null}
              </ReviewRow>
            );
          })}
        </ul>
      ) : null}
      {facts && !noError && none ? (
        <p className={x.afterNote}><Mark state="wrong" vi={vi} label={vi ? 'Câu này có lỗi' : 'This sentence has an error'} /></p>
      ) : null}
    </div>
  );
}
