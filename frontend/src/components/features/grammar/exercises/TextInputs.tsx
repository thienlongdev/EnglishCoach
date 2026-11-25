'use client';

import React, { useState } from 'react';
import { Quote } from 'lucide-react';
import { Rich } from '../Inline';
import { textOf } from './answer';
import { ReviewRow, RvLine, type InputProps, type MarkState } from './shared';
import styles from '../grammar.module.css';
import x from './exercises.module.css';

const norm = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '').toLowerCase();

/**
 * transform: rewrite a sentence by an instruction. The system knows the sentences the author wrote down; a sentence it does not
 * know is never called wrong: the card then shows the model and the learner compares.
 */
export function TransformInput({ exercise, value, onChange, locked, verdict, labelId, vi, onEnter }: InputProps) {
  const text = textOf(value);
  const reveal = verdict?.reveal;
  const outcome = verdict?.outcome;
  const rawModel = reveal?.model;
  const model = typeof rawModel === 'string' ? rawModel : Array.isArray(rawModel) ? rawModel[0] : undefined;
  const rawAccept: unknown[] = Array.isArray(reveal?.accept) ? (reveal?.accept as unknown[]) : [];
  const accepted = rawAccept.filter((a): a is string => typeof a === 'string')
    .filter((a) => norm(a) !== norm(text) && norm(a) !== norm(model ?? ''));
  const state: MarkState | null = !outcome ? null
    : outcome === 'CORRECT' || outcome === 'ACCEPTABLE' ? 'right'
      : outcome === 'UNRECOGNIZED' ? 'unknown'
        : outcome === 'PARTIAL' ? 'partial' : 'wrong';

  return (
    <div className={x.textBlock}>
      {exercise.source ? (
        <blockquote className={x.source} lang="en">
          <Quote aria-hidden="true" />
          <span><Rich text={exercise.source} /></span>
        </blockquote>
      ) : null}
      {exercise.instruction ? <p className={x.instruction}><Rich text={exercise.instruction} /></p> : null}
      <label className={styles.fieldLabel} htmlFor={`${labelId}-answer`}>{vi ? 'Câu của bạn' : 'Your sentence'}</label>
      <textarea
        id={`${labelId}-answer`}
        className={styles.input}
        rows={3}
        maxLength={400}
        lang="en"
        value={text}
        disabled={locked}
        autoCapitalize="sentences"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        placeholder={vi ? 'Gõ câu viết lại ở đây' : 'Type your rewritten sentence here'}
        onChange={(e) => onChange(e.target.value ? { text: e.target.value } : null)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) { e.preventDefault(); onEnter?.(); } }}
      />
      {!locked ? <p className={x.orderHow}>{vi ? 'Nhấn Ctrl cùng Enter để kiểm tra.' : 'Press Ctrl with Enter to check.'}</p> : null}

      {state && reveal ? (
        <ul className={x.rvList}>
          <ReviewRow state={state} vi={vi}
            title={state === 'right' ? (vi ? 'Câu của bạn dùng được' : 'Your sentence works') : state === 'unknown' ? (vi ? 'Hãy so với đáp án mẫu' : 'Compare with the model') : (vi ? 'Chưa đáp ứng yêu cầu bài này' : 'This does not meet this task yet')}>
            {text.trim() ? <RvLine label={vi ? 'Bạn viết' : 'You wrote'} tone={state === 'wrong' ? 'wrong' : undefined}><span lang="en" className={state === 'wrong' ? x.struck : undefined}>{text.trim()}</span></RvLine> : null}
            {model && state !== 'right' ? <RvLine label={vi ? 'Đáp án mẫu' : 'Model answer'} tone="right"><span lang="en">{model}</span></RvLine> : null}
            {model && state === 'right' && norm(model) !== norm(text) ? <RvLine label={vi ? 'Đáp án mẫu' : 'Model answer'}><span lang="en">{model}</span></RvLine> : null}
            {accepted.length ? <RvLine label={vi ? 'Cũng được chấp nhận' : 'Also accepted'}>{accepted.slice(0, 4).map((a, n) => <span key={n} lang="en" className={x.alt}>{a}</span>)}</RvLine> : null}
            {reveal.note ? <RvLine label={state === 'right' ? (vi ? 'Lưu ý' : 'Note') : (vi ? 'Vì sao' : 'Why')}><Rich text={reveal.note} /></RvLine> : null}
          </ReviewRow>
        </ul>
      ) : null}
    </div>
  );
}

/**
 * open: written freely and never graded. "Đối chiếu" shows a model and a checklist; the learner ticks what their text did.
 * The ticks stay on this screen: nothing is sent, nothing becomes a score.
 */
export function OpenInput({ exercise, value, onChange, locked, verdict, labelId, vi }: InputProps) {
  const text = textOf(value);
  const reveal = verdict?.reveal;
  const rawModel = reveal?.model;
  const models: string[] = Array.isArray(rawModel) ? rawModel : typeof rawModel === 'string' ? [rawModel] : [];
  const checklist = reveal?.checklist ?? [];
  const [ticks, setTicks] = useState<Record<number, boolean>>({});

  return (
    <div className={x.textBlock}>
      {exercise.task ? <p className={x.task}><Rich text={exercise.task} /></p> : null}
      <label className={styles.fieldLabel} htmlFor={`${labelId}-answer`}>{vi ? 'Bài viết của bạn' : 'Your writing'}</label>
      <textarea
        id={`${labelId}-answer`}
        className={styles.input}
        rows={5}
        maxLength={400}
        lang="en"
        value={text}
        disabled={locked}
        autoCorrect="off"
        autoComplete="off"
        placeholder={vi ? 'Viết ở đây. Bài này không chấm điểm.' : 'Write here. This one is not graded.'}
        onChange={(e) => onChange(e.target.value ? { text: e.target.value } : null)}
      />
      {reveal ? (
        <div className={x.selfReview}>
          {models.length ? (
            <section className={x.modelBox} aria-labelledby={`${labelId}-model`}>
              <h4 id={`${labelId}-model`} className={x.miniTitle}>{vi ? 'Bài mẫu để so sánh' : 'A model to compare with'}</h4>
              <ul className={x.modelList}>
                {models.map((m, n) => <li key={n} lang="en">{m}</li>)}
              </ul>
              <p className={x.orderHow}>{vi ? 'Bài mẫu chỉ là một cách viết. Bài của bạn có thể khác mà vẫn đúng.' : 'A model is only one way to write it. Yours can differ and still be right.'}</p>
            </section>
          ) : null}
          {checklist.length ? (
            <section className={x.modelBox} aria-labelledby={`${labelId}-check`}>
              <h4 id={`${labelId}-check`} className={x.miniTitle}>{vi ? 'Tự kiểm tra bài của bạn' : 'Check your own writing'}</h4>
              <ul className={x.checkList}>
                {checklist.map((c, n) => (
                  <li key={n}>
                    <label className={x.tick}>
                      <input type="checkbox" checked={!!ticks[n]} onChange={(e) => setTicks((t) => ({ ...t, [n]: e.target.checked }))} />
                      <span><Rich text={c} /></span>
                    </label>
                  </li>
                ))}
              </ul>
              <p className={x.orderHow}>{vi ? 'Các ô chọn chỉ để bạn tự theo dõi trên màn hình này, không được gửi đi và không tính điểm.' : 'The ticks are for you on this screen only: nothing is sent and nothing is scored.'}</p>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
