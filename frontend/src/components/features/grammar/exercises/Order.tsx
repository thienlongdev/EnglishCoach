'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Eraser } from 'lucide-react';
import { Rich } from '../Inline';
import { seqOf } from './answer';
import { ReviewRow, RvLine, type InputProps, type MarkState } from './shared';
import x from './exercises.module.css';

interface Drag { ti: number; dx: number; dy: number; overLine: boolean; overBank: boolean; at: number }
interface Press { ti: number; sx: number; sy: number; id: number; el: HTMLElement; moved: boolean }

const acceptedOrders = (accept: unknown): string[][] => {
  if (!Array.isArray(accept)) return [];
  return accept.filter((a): a is string[] => Array.isArray(a));
};

/**
 * order: word chips. Tap a word to put it at the end of the sentence, tap it again to take it back; drag it with the pointer to
 * any place; with the keyboard use the arrow keys to move between words, Alt and an arrow to move a word, Delete to take it back.
 * `end` (the final punctuation) is shown fixed after the line and is never part of the answer.
 */
export function OrderInput({ exercise, value, onChange, locked, verdict, labelId, vi }: InputProps) {
  const tokens = exercise.tokens ?? [];
  const seq = seqOf(value);
  const end = exercise.end ?? '';

  /* the answer as token indices (duplicates are interchangeable: the first unused equal token) */
  const lineIdx: number[] = [];
  {
    const used = new Set<number>();
    for (const word of seq) {
      const ti = tokens.findIndex((t, i) => t === word && !used.has(i));
      if (ti >= 0) { used.add(ti); lineIdx.push(ti); }
    }
  }
  const bankIdx = tokens.map((_, i) => i).filter((i) => !lineIdx.includes(i));

  const chips = useRef(new Map<number, HTMLElement>());
  const lineRef = useRef<HTMLUListElement>(null);
  const bankRef = useRef<HTMLUListElement>(null);
  const focusAfter = useRef<number | null>(null);
  const press = useRef<Press | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const swallow = useRef(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [said, setSaid] = useState('');

  useEffect(() => {
    if (focusAfter.current == null) return;
    chips.current.get(focusAfter.current)?.focus({ preventScroll: true });
    focusAfter.current = null;
  });

  const commit = (idxs: number[], message?: string) => {
    onChange(idxs.length ? { seq: idxs.map((i) => tokens[i]) } : null);
    if (message) setSaid(message);
  };
  const place = (ti: number, at: number) => {
    const base = lineIdx.filter((i) => i !== ti);
    const next = [...base.slice(0, at), ti, ...base.slice(at)];
    commit(next, vi ? `“${tokens[ti]}” ở vị trí ${at + 1} trên ${next.length}.` : `“${tokens[ti]}” is word ${at + 1} of ${next.length}.`);
  };
  const take = (ti: number) => commit(lineIdx.filter((i) => i !== ti), vi ? `Đã đưa “${tokens[ti]}” về các từ còn lại.` : `“${tokens[ti]}” went back to the words.`);

  /* ── pointer drag (the tap, the keys and the buttons are the same moves without it) ── */
  const whereIs = (cx: number, cy: number, ti: number): Pick<Drag, 'overLine' | 'overBank' | 'at'> => {
    const hit = (r: DOMRect | undefined, slack: number) => !!r && cx >= r.left - slack && cx <= r.right + slack && cy >= r.top - slack && cy <= r.bottom + slack;
    const lineRect = lineRef.current?.getBoundingClientRect();
    const bankRect = bankRef.current?.getBoundingClientRect();
    const inLine = hit(lineRect, 0) || (!hit(bankRect, 0) && hit(lineRect, 14));
    if (inLine) {
      const others = lineIdx.filter((i) => i !== ti);
      let at = others.length;
      for (let k = 0; k < others.length; k++) {
        const r = chips.current.get(others[k])?.getBoundingClientRect();
        if (!r) continue;
        if (cy < r.top || (cy <= r.bottom && cx < r.left + r.width / 2)) { at = k; break; }
      }
      return { overLine: true, overBank: false, at };
    }
    if (hit(bankRect, 14)) return { overLine: false, overBank: true, at: 0 };
    return { overLine: false, overBank: false, at: 0 };
  };
  const clearPress = () => { press.current = null; dragRef.current = null; setDrag(null); };
  const down = (e: React.PointerEvent<HTMLElement>, ti: number) => {
    if (locked || (e.pointerType === 'mouse' && e.button !== 0)) return;
    press.current = { ti, sx: e.clientX, sy: e.clientY, id: e.pointerId, el: e.currentTarget, moved: false };
  };
  const move = (e: React.PointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p || e.pointerId !== p.id) return;
    const dx = e.clientX - p.sx;
    const dy = e.clientY - p.sy;
    if (!p.moved) {
      if (Math.hypot(dx, dy) < 8) return;
      p.moved = true;
      try { p.el.setPointerCapture(p.id); } catch { /* the move still works without capture */ }
    }
    const next = { ti: p.ti, dx, dy, ...whereIs(e.clientX, e.clientY, p.ti) };
    dragRef.current = next;
    setDrag(next);
  };
  const up = (e: React.PointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p || e.pointerId !== p.id) return;
    const d = dragRef.current;
    try { p.el.releasePointerCapture(p.id); } catch { /* already released */ }
    clearPress();
    if (!p.moved || !d) return;
    swallow.current = true;
    window.setTimeout(() => { swallow.current = false; }, 80);
    focusAfter.current = d.ti;
    if (d.overLine) place(d.ti, d.at);
    else if (d.overBank && lineIdx.includes(d.ti)) take(d.ti);
  };

  const tap = (ti: number) => {
    if (swallow.current) { swallow.current = false; return; }
    if (locked) return;
    focusAfter.current = ti;
    if (lineIdx.includes(ti)) take(ti);
    else {
      commit([...lineIdx, ti], vi ? `Đã thêm “${tokens[ti]}”, từ thứ ${lineIdx.length + 1}.` : `Added “${tokens[ti]}” as word ${lineIdx.length + 1}.`);
    }
  };

  const keys = (e: React.KeyboardEvent<HTMLElement>, ti: number) => {
    if (locked) return;
    const inLine = lineIdx.includes(ti);
    const list = inLine ? lineIdx : bankIdx;
    const at = list.indexOf(ti);
    const go = (target: number | undefined) => { if (target != null) { e.preventDefault(); chips.current.get(target)?.focus(); } };
    if (e.altKey && inLine && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const to = e.key === 'ArrowLeft' ? at - 1 : at + 1;
      e.preventDefault();
      if (to < 0 || to >= lineIdx.length) return;
      focusAfter.current = ti;
      place(ti, to);
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') go(list[at - 1]);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') go(list[at + 1]);
    else if (e.key === 'Home') go(list[0]);
    else if (e.key === 'End') go(list[list.length - 1]);
    else if (inLine && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      focusAfter.current = list[at + 1] ?? list[at - 1] ?? bankIdx[0] ?? null;
      take(ti);
    }
  };

  /* ── review ── */
  const reveal = verdict?.reveal;
  if (reveal && verdict) {
    const orders = acceptedOrders(reveal.accept);
    const mine = seq.length ? `${seq.join(' ')}${end}` : '';
    const state: MarkState = verdict.outcome === 'CORRECT' || verdict.outcome === 'ACCEPTABLE' ? 'right' : 'wrong';
    const right = orders[0] ? `${orders[0].join(' ')}${end}` : '';
    const others = orders.slice(state === 'right' ? 0 : 1).map((o) => `${o.join(' ')}${end}`).filter((o) => o !== mine).slice(0, 4);
    return (
      <div className={x.orderBlock}>
        <ul className={x.line} aria-label={vi ? 'Câu bạn đã xếp' : 'The sentence you built'} data-review={state}>
          {lineIdx.map((ti) => <li key={ti}><span className={x.tok} data-where="line" lang="en">{tokens[ti]}</span></li>)}
          {end ? <li className={x.endMark} lang="en">{end}</li> : null}
          {!lineIdx.length ? <li className={x.linePlaceholder}>{vi ? 'Bạn chưa xếp từ nào.' : 'You did not place any word.'}</li> : null}
        </ul>
        <ul className={x.rvList}>
          <ReviewRow state={state} vi={vi} title={state === 'right' ? (vi ? 'Thứ tự của bạn dùng được' : 'Your order works') : (vi ? 'Thứ tự này chưa đúng' : 'This order does not work')}>
            {mine ? <RvLine label={vi ? 'Bạn xếp' : 'You built'} tone={state === 'wrong' ? 'wrong' : undefined}><span lang="en" className={state === 'wrong' ? x.struck : undefined}>{mine}</span></RvLine> : null}
            {state === 'wrong' && right ? <RvLine label={vi ? 'Thứ tự đúng' : 'A right order'} tone="right"><span lang="en">{right}</span></RvLine> : null}
            {others.length ? (
              <RvLine label={state === 'wrong' ? (vi ? 'Cũng đúng' : 'Also right') : (vi ? 'Các thứ tự khác cũng đúng' : 'Other right orders')}>
                {others.map((o, n) => <span key={n} lang="en" className={x.alt}>{o}</span>)}
              </RvLine>
            ) : null}
            {reveal.note ? <RvLine label={state === 'right' ? (vi ? 'Lưu ý' : 'Note') : (vi ? 'Vì sao' : 'Why')}><Rich text={reveal.note} /></RvLine> : null}
          </ReviewRow>
        </ul>
      </div>
    );
  }

  /* ── answering ── */
  const barAt = drag?.overLine ? drag.at : -1;
  const line: React.ReactNode[] = [];
  let seen = 0;
  lineIdx.forEach((ti, pos) => {
    if (drag && ti !== drag.ti && seen === barAt) line.push(<li key="bar" className={x.dropBar} aria-hidden="true" />);
    if (!drag || ti !== drag.ti) seen += 1;
    line.push(
      <li key={`t${ti}`}>
        <Token ti={ti} text={tokens[ti]} where="line" pos={pos} count={lineIdx.length} drag={drag} locked={locked} vi={vi}
          reg={(el) => { if (el) chips.current.set(ti, el); else chips.current.delete(ti); }}
          onTap={tap} onDown={down} onMove={move} onUp={up} onCancel={clearPress} onKeys={keys} />
      </li>,
    );
  });
  if (drag && seen === barAt) line.push(<li key="bar-end" className={x.dropBar} aria-hidden="true" />);

  return (
    <div className={x.orderBlock}>
      <p className={x.orderLabel} id={`${labelId}-line`}>{vi ? 'Câu của bạn' : 'Your sentence'}</p>
      <ul ref={lineRef} className={x.line} aria-labelledby={`${labelId}-line`} aria-describedby={`${labelId}-how`} data-over={drag?.overLine ? 'true' : 'false'} data-empty={lineIdx.length ? 'false' : 'true'}>
        {line}
        {end ? <li className={x.endMark} lang="en" aria-label={vi ? `Dấu cuối câu ${end}` : `Ends with ${end}`}>{end}</li> : null}
        {!lineIdx.length ? <li className={x.linePlaceholder}>{vi ? 'Chạm vào các từ bên dưới để ghép thành câu' : 'Tap the words below to build the sentence'}</li> : null}
      </ul>
      <p className={x.orderLabel} id={`${labelId}-bank`}>{vi ? 'Các từ' : 'Words'}</p>
      <ul ref={bankRef} className={x.bank} aria-labelledby={`${labelId}-bank`} data-over={drag?.overBank ? 'true' : 'false'}>
        {bankIdx.map((ti, pos) => (
          <li key={`t${ti}`}>
            <Token ti={ti} text={tokens[ti]} where="bank" pos={pos} count={bankIdx.length} drag={drag} locked={locked} vi={vi}
              reg={(el) => { if (el) chips.current.set(ti, el); else chips.current.delete(ti); }}
              onTap={tap} onDown={down} onMove={move} onUp={up} onCancel={clearPress} onKeys={keys} />
          </li>
        ))}
        {!bankIdx.length ? <li className={x.linePlaceholder}>{vi ? 'Bạn đã dùng hết các từ' : 'All the words are placed'}</li> : null}
      </ul>
      <div className={x.orderTools}>
        <button type="button" className={x.toolBtn} onClick={() => { commit([], vi ? 'Đã xóa hết.' : 'Cleared.'); }} disabled={locked || !lineIdx.length}>
          <Eraser aria-hidden="true" />{vi ? 'Xóa hết' : 'Clear'}
        </button>
        <p id={`${labelId}-how`} className={x.orderHow}>
          {vi
            ? 'Chạm vào từ để đặt vào câu hoặc đưa về. Hoặc kéo từ đến chỗ bạn muốn. Bàn phím: phím mũi tên để chuyển giữa các từ, Alt cùng mũi tên để dời từ, Delete để bỏ từ ra.'
            : 'Tap a word to place it or take it back, or drag it where you want it. Keyboard: arrows move between words, Alt with an arrow moves a word, Delete takes it out.'}
        </p>
      </div>
      <p className={x.srOnly} role="status" aria-live="polite">{said}</p>
    </div>
  );
}

interface TokenProps {
  ti: number; text: string; where: 'line' | 'bank'; pos: number; count: number; drag: Drag | null; locked: boolean; vi: boolean;
  reg: (el: HTMLElement | null) => void;
  onTap: (ti: number) => void;
  onDown: (e: React.PointerEvent<HTMLElement>, ti: number) => void;
  onMove: (e: React.PointerEvent<HTMLElement>) => void;
  onUp: (e: React.PointerEvent<HTMLElement>) => void;
  onCancel: () => void;
  onKeys: (e: React.KeyboardEvent<HTMLElement>, ti: number) => void;
}

function Token({ ti, text, where, pos, count, drag, locked, vi, reg, onTap, onDown, onMove, onUp, onCancel, onKeys }: TokenProps) {
  const dragging = drag?.ti === ti;
  const label = where === 'line'
    ? (vi ? `${text}, từ thứ ${pos + 1} trên ${count}. Chạm để đưa về.` : `${text}, word ${pos + 1} of ${count}. Activate to take it back.`)
    : (vi ? `${text}. Chạm để thêm vào câu.` : `${text}. Activate to add it to the sentence.`);
  return (
    <button
      ref={reg}
      type="button"
      className={x.tok}
      data-where={where}
      data-drag={dragging ? 'true' : undefined}
      lang="en"
      disabled={locked}
      aria-label={label}
      style={dragging && drag ? { transform: `translate(${drag.dx}px, ${drag.dy}px)` } : undefined}
      onClick={() => onTap(ti)}
      onPointerDown={(e) => onDown(e, ti)}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
      onLostPointerCapture={() => { if (dragging) onCancel(); }}
      onKeyDown={(e) => onKeys(e, ti)}
    >
      {text}
    </button>
  );
}
