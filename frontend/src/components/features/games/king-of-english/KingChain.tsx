'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { RotateCcw, Send, Undo2 } from 'lucide-react';
import styles from './king.module.css';

type Tile = { id: number; text: string };
type Drag = { id: number; from: 'rail' | 'tray'; x: number; y: number; offX: number; offY: number; w: number; h: number; index: number | null; overTray: boolean; accent: string };

/**
 * Sentence Chain / letter scramble builder. Tap a piece to place it (or to send it back), drag any piece — from the tray or
 * inside the answer — to exactly where it belongs: the others glide aside and reflow. Keyboard: Enter / Space places or
 * removes, ← → move focus, Alt + ← → moves the focused piece, Delete removes it. The order is only ever the learner's own:
 * nothing is reordered for them and no piece is duplicated or lost (ids are unique; every change is a permutation).
 */
export function KingChain({ tiles, selected, setSelected, disabled, vi, letters = false, onSubmit }: {
  tiles: Tile[]; selected: number[]; setSelected: (s: number[]) => void; disabled: boolean; vi: boolean; letters?: boolean; onSubmit: () => void;
}) {
  const reduced = useReducedMotion();
  const placed = selected.filter((id, i) => tiles.some(t => t.id === id) && selected.indexOf(id) === i);
  const tray = tiles.filter(t => !placed.includes(t.id));
  const signature = tiles.map(t => t.id + ':' + t.text).join('|');
  const [history, setHistory] = useState<{ key: string; stack: number[][] }>({ key: signature, stack: [] });
  const stack = history.key === signature ? history.stack : [];
  const [drag, setDrag] = useState<Drag | null>(null);
  const press = useRef<{ id: number; from: 'rail' | 'tray'; x: number; y: number; el: HTMLElement; pointer: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);
  const rail = useRef<HTMLDivElement>(null), trayRef = useRef<HTMLDivElement>(null), refs = useRef(new Map<number, HTMLButtonElement>());
  const focusAfter = useRef<number | null>(null);
  const text = (id: number) => tiles.find(t => t.id === id)?.text ?? '';
  const commit = (next: number[]) => {
    if (next.join(',') === placed.join(',')) return;
    setHistory({ key: signature, stack: [...stack.slice(-40), placed] });
    setSelected(next);
  };
  useEffect(() => { if (focusAfter.current != null) { refs.current.get(focusAfter.current)?.focus(); focusAfter.current = null; } });
  useEffect(() => { if (disabled) { press.current = null; setDrag(null); } }, [disabled]);

  const insertionIndex = (x: number, y: number, dragged: number) => {
    const box = rail.current?.getBoundingClientRect();
    if (!box || x < box.left - 24 || x > box.right + 24 || y < box.top - 24 || y > box.bottom + 24) return null;
    const items = placed.filter(id => id !== dragged).map(id => refs.current.get(id)?.getBoundingClientRect()).filter((r): r is DOMRect => !!r);
    for (let i = 0; i < items.length; i++) {
      const r = items[i];
      if (y < r.top) return i;
      if (y <= r.bottom && x < r.left + r.width / 2) return i;
    }
    return items.length;
  };
  const down = (event: ReactPointerEvent<HTMLButtonElement>, id: number, from: 'rail' | 'tray') => {
    if (disabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
    press.current = { id, from, x: event.clientX, y: event.clientY, el: event.currentTarget, pointer: event.pointerId };
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current; if (!p || p.pointer !== event.pointerId) return;
    if (!drag) {
      if (Math.hypot(event.clientX - p.x, event.clientY - p.y) < 6) return;
      // Capture only once it is a drag (a tap must still click its piece), on the board, which outlives the piece
      // (a dragged answer piece leaves the rail while it moves).
      try { root.current?.setPointerCapture(event.pointerId); } catch { /* capture is a convenience */ }
      const r = p.el.getBoundingClientRect();
      setDrag({ id: p.id, from: p.from, x: event.clientX, y: event.clientY, offX: p.x - r.left, offY: p.y - r.top, w: r.width, h: r.height,
        index: insertionIndex(event.clientX, event.clientY, p.id), overTray: false, accent: root.current ? getComputedStyle(root.current).getPropertyValue('--k-a-rgb') : '' });
      return;
    }
    const t = trayRef.current?.getBoundingClientRect();
    const overTray = !!t && event.clientX >= t.left && event.clientX <= t.right && event.clientY >= t.top && event.clientY <= t.bottom;
    setDrag({ ...drag, x: event.clientX, y: event.clientY, index: overTray ? null : insertionIndex(event.clientX, event.clientY, drag.id), overTray });
  };
  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current; if (!p || p.pointer !== event.pointerId) return;
    press.current = null;
    try { root.current?.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    if (!drag) return;
    // A drop may be followed by a click on the piece under the pointer: ignore that one, and only that one.
    suppressClick.current = true;
    setTimeout(() => { suppressClick.current = false; }, 0);
    const rest = placed.filter(id => id !== drag.id);
    if (drag.index != null) { rest.splice(drag.index, 0, drag.id); commit(rest); }
    else if (drag.overTray && drag.from === 'rail') commit(rest);
    setDrag(null);
  };
  const cancel = () => { press.current = null; setDrag(null); };
  const tap = (id: number, from: 'rail' | 'tray') => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    if (disabled) return;
    commit(from === 'tray' ? [...placed, id] : placed.filter(x => x !== id));
  };
  const keys = (event: ReactKeyboardEvent<HTMLButtonElement>, id: number) => {
    const i = placed.indexOf(id);
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); const next = placed[i + 1] ?? placed[i - 1]; commit(placed.filter(x => x !== id)); if (next != null) focusAfter.current = next; return; }
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (!step) return;
    event.preventDefault();
    const j = i + step;
    if (j < 0 || j >= placed.length) return;
    if (event.altKey || event.ctrlKey || event.metaKey) { const next = [...placed]; [next[i], next[j]] = [next[j], next[i]]; commit(next); focusAfter.current = id; }
    else refs.current.get(placed[j])?.focus();
  };
  const piece = (id: number, from: 'rail' | 'tray') => <motion.button type="button" key={id} layout={!reduced} transition={{ type: 'spring', stiffness: 520, damping: 34 }}
    ref={(el: HTMLButtonElement | null) => { if (el) refs.current.set(id, el); else refs.current.delete(id); }}
    data-chunk-id={id} data-placed={from === 'rail'} data-letters={letters} data-ghost={drag?.id === id} disabled={disabled}
    onPointerDown={event => down(event, id, from)}
    onClick={() => tap(id, from)} onKeyDown={from === 'rail' ? event => keys(event, id) : undefined}
    aria-label={`${from === 'rail' ? (vi ? 'Bỏ' : 'Remove') : (vi ? 'Đặt' : 'Place')} ${text(id)}`}
    className={`${styles.chunk} min-h-12`}>{text(id)}</motion.button>;

  // While dragging, the dragged piece leaves its place and a gap of its width opens where it would land.
  const railItems = drag ? placed.filter(id => id !== drag.id) : placed;
  const gapAt = drag?.index ?? null;
  return <div ref={root} className={styles.chain} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}>
    <div ref={rail} role="group" aria-label={vi ? 'Câu của bạn' : 'Your answer'} className={styles.rail} data-hot={gapAt != null}>
      {railItems.length || gapAt != null ? railItems.flatMap((id, i) => {
        const node = piece(id, 'rail');
        return gapAt === i ? [<span key="gap" className={styles.gap} style={{ width: drag!.w }} aria-hidden="true" />, node] : [node];
      }).concat(gapAt != null && gapAt >= railItems.length ? [<span key="gap" className={styles.gap} style={{ width: drag!.w }} aria-hidden="true" />] : [])
        : <p className={styles.railEmpty}>{letters ? (vi ? 'Chạm hoặc kéo các chữ cái vào đây để ghép từ' : 'Tap or drag the letters here to build the word') : (vi ? 'Chạm hoặc kéo các cụm từ vào đây để ghép câu' : 'Tap or drag the chunks here to build your sentence')}</p>}
    </div>
    <div>
      <p className={styles.trayLabel}>{vi ? 'Mảnh có sẵn' : 'Available pieces'}</p>
      <div ref={trayRef} role="group" aria-label={vi ? 'Mảnh có sẵn' : 'Available tiles'} className={styles.tray} data-hot={!!drag?.overTray && drag.from === 'rail'}>
        {tray.map(t => piece(t.id, 'tray'))}
      </div>
    </div>
    <div className={styles.actions}>
      <div className={styles.chainTools}>
        <button type="button" className={styles.ghost} disabled={disabled || !stack.length} onClick={() => { const prev = stack[stack.length - 1]; if (prev) { setHistory({ key: signature, stack: stack.slice(0, -1) }); setSelected(prev); } }}><Undo2 aria-hidden="true" />{vi ? 'Hoàn tác' : 'Undo'}</button>
        <button type="button" className={styles.ghost} disabled={disabled || !placed.length} onClick={() => commit([])}><RotateCcw aria-hidden="true" />{vi ? 'Xóa' : 'Clear'}</button>
      </div>
      <button type="button" className={`${styles.cta} ${styles.ctaSmall}`} disabled={disabled || placed.length !== tiles.length} onClick={onSubmit}><Send aria-hidden="true" />{vi ? 'Kiểm tra' : 'Submit'}</button>
    </div>
    <p className={styles.hint}>{vi ? <>Kéo để chèn vào giữa · <kbd>Alt</kbd>+<kbd>←</kbd>/<kbd>→</kbd> để dời mảnh · <kbd>Delete</kbd> để bỏ</> : <>Drag to insert anywhere · <kbd>Alt</kbd>+<kbd>←</kbd>/<kbd>→</kbd> to move a piece · <kbd>Delete</kbd> to remove</>}</p>
    {drag && typeof document !== 'undefined' && createPortal(<span aria-hidden="true" className={`${styles.chunk} ${styles.dragging}`} data-placed="true" data-letters={letters}
      style={{ minWidth: drag.w, height: drag.h, ['--k-a-rgb' as string]: drag.accent || '255 210 122', transform: `translate3d(${drag.x - drag.offX}px, ${drag.y - drag.offY}px, 0) rotate(-2deg) scale(1.06)` }}>{text(drag.id)}</span>, document.body)}
  </div>;
}
