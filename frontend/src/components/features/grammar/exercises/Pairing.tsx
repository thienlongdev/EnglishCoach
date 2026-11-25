'use client';

import React, { useId, useState } from 'react';
import { catsOf, langOf, pairsOf } from './answer';
import { ReviewRow, RvLine, type InputProps } from './shared';
import x from './exercises.module.css';

type Side = 'L' | 'R';

/**
 * match: touch an item on one side, then its partner on the other. A pair carries the same number on both sides. Touch a paired
 * item to undo the pair. Everything is a button, so the keyboard is the same as the pointer: Tab, Enter.
 */
export function MatchInput({ exercise, value, onChange, locked, verdict, labelId, vi }: InputProps) {
  const left = exercise.left ?? [];
  const right = exercise.right ?? [];
  const pairs = pairsOf(value);
  const [sel, setSel] = useState<{ side: Side; i: number } | null>(null);
  const [said, setSaid] = useState('');

  /* left index → right index (equal right texts are interchangeable: the first unused one) */
  const rightOf: Record<number, number> = {};
  const used = new Set<number>();
  left.forEach((_, li) => {
    const text = pairs[String(li)];
    if (text == null) return;
    const ri = right.findIndex((r, i) => r === text && !used.has(i));
    if (ri >= 0) { used.add(ri); rightOf[li] = ri; }
  });
  const leftOf: Record<number, number> = {};
  Object.entries(rightOf).forEach(([li, ri]) => { leftOf[ri] = Number(li); });

  const commit = (map: Record<number, number>, message?: string) => {
    const next: Record<string, string> = {};
    Object.entries(map).forEach(([li, ri]) => { next[li] = right[ri]; });
    onChange(Object.keys(next).length ? { pairs: next } : null);
    if (message) setSaid(message);
  };

  const press = (side: Side, i: number) => {
    if (locked) return;
    const paired = side === 'L' ? rightOf[i] !== undefined : leftOf[i] !== undefined;
    if (sel && sel.side !== side) {
      const l = side === 'L' ? i : sel.i;
      const r = side === 'R' ? i : sel.i;
      const map = { ...rightOf };
      delete map[l];
      Object.keys(map).forEach((k) => { if (map[Number(k)] === r) delete map[Number(k)]; });
      map[l] = r;
      commit(map, vi ? `Đã nối ${l + 1} với “${right[r]}”.` : `Paired ${l + 1} with “${right[r]}”.`);
      setSel(null);
      return;
    }
    if (sel && sel.side === side && sel.i === i) { setSel(null); return; }
    if (paired && !sel) {
      const map = { ...rightOf };
      if (side === 'L') delete map[i]; else delete map[leftOf[i]];
      commit(map, vi ? 'Đã gỡ một cặp.' : 'A pair was undone.');
    }
    setSel({ side, i });
  };

  const reveal = verdict?.reveal.pairs;
  if (reveal) {
    return (
      <ul className={x.rvList} aria-labelledby={labelId}>
        {reveal.map((r) => {
          const mine = pairs[String(r.i)];
          return (
            <ReviewRow key={r.i} state={r.ok ? 'right' : 'wrong'} vi={vi} title={<><span className={x.rvNum}>{r.i + 1}</span><span lang={langOf(left[r.i] ?? '')}>{left[r.i]}</span></>}>
              {r.ok ? (
                <RvLine label={vi ? 'Nối đúng với' : 'Rightly paired with'} tone="right"><span lang={langOf(r.b)}>{r.b}</span></RvLine>
              ) : (
                <>
                  <RvLine label={vi ? 'Bạn nối' : 'You paired'} tone="wrong">{mine ? <span lang={langOf(mine)} className={x.struck}>{mine}</span> : <em>{vi ? '(chưa nối)' : '(not paired)'}</em>}</RvLine>
                  <RvLine label={vi ? 'Đáp án' : 'Answer'} tone="right"><span lang={langOf(r.b)}>{r.b}</span></RvLine>
                </>
              )}
            </ReviewRow>
          );
        })}
      </ul>
    );
  }

  const status = (side: Side, i: number) => {
    if (side === 'L') {
      const ri = rightOf[i];
      return ri === undefined ? (vi ? 'chưa nối' : 'not paired') : (vi ? `đã nối với “${right[ri]}”` : `paired with “${right[ri]}”`);
    }
    const li = leftOf[i];
    return li === undefined ? (vi ? 'chưa nối' : 'not paired') : (vi ? `đã nối với mục ${li + 1}` : `paired with item ${li + 1}`);
  };

  return (
    <div className={x.matchBlock}>
      <div className={x.matchGrid} role="group" aria-labelledby={labelId}>
        <ol className={x.matchList}>
          {left.map((t, i) => (
            <li key={i}>
              <button type="button" className={x.mItem} aria-pressed={sel?.side === 'L' && sel.i === i} data-paired={rightOf[i] !== undefined ? 'true' : 'false'} disabled={locked}
                aria-label={`${i + 1}. ${t}, ${status('L', i)}`} onClick={() => press('L', i)}>
                <span className={x.mNum} aria-hidden="true">{i + 1}</span>
                <span className={x.mText} lang={langOf(t)}>{t}</span>
              </button>
            </li>
          ))}
        </ol>
        <ul className={x.matchList}>
          {right.map((t, i) => (
            <li key={i}>
              <button type="button" className={x.mItem} aria-pressed={sel?.side === 'R' && sel.i === i} data-paired={leftOf[i] !== undefined ? 'true' : 'false'} disabled={locked}
                aria-label={`${t}, ${status('R', i)}`} onClick={() => press('R', i)}>
                <span className={x.mNum} data-empty={leftOf[i] === undefined ? 'true' : 'false'} aria-hidden="true">{leftOf[i] !== undefined ? leftOf[i] + 1 : ''}</span>
                <span className={x.mText} lang={langOf(t)}>{t}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <p className={x.orderHow}>
        {vi
          ? 'Chạm một mục, rồi chạm mục đi cùng nó ở phía bên kia. Chạm một mục đã nối để gỡ cặp.'
          : 'Touch an item, then the one that goes with it on the other side. Touch a paired item to undo the pair.'}
      </p>
      <p className={x.srOnly} role="status" aria-live="polite">{said}</p>
    </div>
  );
}

/**
 * classify: every item goes in one group. Two ways, both always there: a select on every row (the plain, accessible way), and
 * "touch an item, then touch its group" for speed. After a group is chosen the next unplaced item is selected.
 */
export function ClassifyInput({ exercise, value, onChange, locked, verdict, labelId, vi }: InputProps) {
  const base = useId();
  const items = exercise.items ?? [];
  const cats = exercise.cats ?? [];
  const cur = catsOf(value);
  const [sel, setSel] = useState<number | null>(null);
  const [said, setSaid] = useState('');

  const assign = (itemI: number, cat: string) => {
    const next = { ...cur };
    if (cat) next[String(itemI)] = cat; else delete next[String(itemI)];
    onChange(Object.keys(next).length ? { cats: next } : null);
    const text = items.find((it) => it.i === itemI)?.t ?? '';
    setSaid(cat ? (vi ? `Đã xếp “${text}” vào nhóm ${cat}.` : `Put “${text}” in ${cat}.`) : (vi ? `Đã bỏ nhóm của “${text}”.` : `Removed the group of “${text}”.`));
  };
  const tapCat = (cat: string) => {
    if (locked || sel == null) return;
    assign(sel, cat);
    const at = items.findIndex((it) => it.i === sel);
    const following = [...items.slice(at + 1), ...items.slice(0, at)].find((it) => cur[String(it.i)] === undefined && it.i !== sel);
    setSel(following ? following.i : null);
  };

  const reveal = verdict?.reveal.items;
  if (reveal) {
    return (
      <ul className={x.rvList} aria-labelledby={labelId}>
        {reveal.map((r) => {
          const text = items.find((it) => it.i === r.i)?.t ?? '';
          const mine = cur[String(r.i)];
          return (
            <ReviewRow key={r.i} state={r.ok ? 'right' : 'wrong'} vi={vi} title={<span lang={langOf(text)}>{text}</span>}>
              {r.ok ? (
                <RvLine label={vi ? 'Nhóm' : 'Group'} tone="right"><span lang={langOf(r.cat)}>{r.cat}</span></RvLine>
              ) : (
                <>
                  <RvLine label={vi ? 'Bạn xếp vào' : 'You put it in'} tone="wrong">{mine ? <span lang={langOf(mine)} className={x.struck}>{mine}</span> : <em>{vi ? '(chưa xếp)' : '(not placed)'}</em>}</RvLine>
                  <RvLine label={vi ? 'Nhóm đúng' : 'Right group'} tone="right"><span lang={langOf(r.cat)}>{r.cat}</span></RvLine>
                </>
              )}
            </ReviewRow>
          );
        })}
      </ul>
    );
  }

  const selText = sel == null ? '' : items.find((it) => it.i === sel)?.t ?? '';
  return (
    <div className={x.classifyBlock}>
      <p className={x.orderHow} id={`${base}-how`}>
        {sel == null
          ? (vi ? 'Chạm một mục, rồi chạm nhóm của nó. Hoặc chọn nhóm ngay trên từng dòng.' : 'Touch an item, then its group. Or choose the group on each row.')
          : (vi ? `Đang chọn “${selText}”: chạm nhóm của nó.` : `Selected “${selText}”: touch its group.`)}
      </p>
      <div className={x.catBar} role="group" aria-label={vi ? 'Nhóm' : 'Groups'}>
        {cats.map((c) => (
          <button key={c} type="button" className={x.catBtn} disabled={locked || sel == null} onClick={() => tapCat(c)}
            aria-label={vi ? `Xếp mục đang chọn vào nhóm ${c}` : `Put the selected item in ${c}`}>
            <span lang={langOf(c)}>{c}</span>
          </button>
        ))}
      </div>
      <ul className={x.cRows} aria-labelledby={labelId}>
        {items.map((it) => {
          const chosen = cur[String(it.i)];
          return (
            <li key={it.i} className={x.cRow} data-sel={sel === it.i ? 'true' : 'false'} data-done={chosen ? 'true' : 'false'}>
              <button type="button" className={x.cItem} aria-pressed={sel === it.i} disabled={locked} onClick={() => setSel(sel === it.i ? null : it.i)}>
                <span lang={langOf(it.t)}>{it.t}</span>
              </button>
              <label className={x.srOnly} htmlFor={`${base}-s${it.i}`}>{vi ? `Nhóm của “${it.t}”` : `Group of “${it.t}”`}</label>
              <select id={`${base}-s${it.i}`} className={x.cSelect} value={chosen ?? ''} disabled={locked} onChange={(e) => assign(it.i, e.target.value)}>
                <option value="">{vi ? 'Chọn nhóm' : 'Choose a group'}</option>
                {cats.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </li>
          );
        })}
      </ul>
      <p className={x.srOnly} role="status" aria-live="polite">{said}</p>
    </div>
  );
}
