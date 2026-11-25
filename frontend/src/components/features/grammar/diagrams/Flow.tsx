'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CornerDownRight, ListTree, RotateCcw, Undo2 } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { DiagramSpec, FlowNode } from '@/types/grammar';
import { cx } from '@/lib/grammar/format';
import { Rich, Vi } from '../Inline';
import styles from '../grammar.module.css';

export type FlowSpec = Extract<DiagramSpec, { kind: 'flow' }>;

interface Step { id: string; q: string; answer: string }

const isEnd = (n: FlowNode | undefined): n is Extract<FlowNode, { end: string }> => !!n && 'end' in n;

/** Every node reachable from the start, in reading order (depth first), with the number it is shown under in the full view. */
function reachable(spec: FlowSpec): { order: string[]; number: Map<string, number> } {
  const order: string[] = [];
  const number = new Map<string, number>();
  const visit = (id: string) => {
    if (number.has(id) || !spec.nodes[id]) return;
    number.set(id, order.length + 1);
    order.push(id);
    const n = spec.nodes[id];
    if ('yes' in n) { visit(n.yes); visit(n.no); }
    else if ('choices' in n) n.choices.forEach((c) => visit(c.to));
  };
  visit(spec.start);
  return { order, number };
}

/**
 * A decision path you walk: one question at a time, answered Yes / No or by a choice. The answers so far stay on screen as the
 * path, you can step back or start again, and "Full view" lists every node (the way a screen reader needs it).
 */
export function FlowDiagram({ spec }: { spec: FlowSpec }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const [path, setPath] = useState<Step[]>([]);
  const [current, setCurrent] = useState(spec.start);
  const [full, setFull] = useState(false);
  const acted = useRef(false);
  const card = useRef<HTMLDivElement | null>(null);
  const graph = useMemo(() => reachable(spec), [spec]);
  const node = spec.nodes[current];

  useEffect(() => {
    if (!acted.current) return;
    card.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }, [current]);

  if (!node) return null;
  const go = (label: string, to: string) => {
    if (!spec.nodes[to] || path.length > Object.keys(spec.nodes).length) return;
    acted.current = true;
    const here = spec.nodes[current];
    setPath((p) => [...p, { id: current, q: 'q' in here ? here.q : '', answer: label }]);
    setCurrent(to);
  };
  const back = () => {
    if (!path.length) return;
    acted.current = true;
    const last = path[path.length - 1];
    setPath(path.slice(0, -1));
    setCurrent(last.id);
  };
  const restart = () => { acted.current = true; setPath([]); setCurrent(spec.start); };
  const yes = vi ? 'Có' : 'Yes';
  const no = vi ? 'Không' : 'No';

  const describe = (id: string) => {
    const target = spec.nodes[id];
    if (!target) return null;
    if (isEnd(target)) return <><strong className={styles.flEndWord}>{vi ? 'Kết quả' : 'Result'}:</strong> <Rich text={target.end} /></>;
    return <>{vi ? 'đi tới câu hỏi' : 'go to question'} {graph.number.get(id)}</>;
  };

  return (
    <div className={styles.fl}>
      {path.length ? (
        <ol className={styles.flPath} aria-label={vi ? 'Đường đi của bạn' : 'Your path so far'}>
          {path.map((s, i) => (
            <li key={i} className={styles.flStep}>
              <span className={styles.flStepQ}><Vi text={s.q} /></span>
              <span className={styles.flStepA}><Check aria-hidden="true" /><Rich text={s.answer} /></span>
            </li>
          ))}
        </ol>
      ) : null}

      <div ref={card} className={styles.flCard} data-end={isEnd(node) ? 'true' : 'false'} aria-live="polite">
        {isEnd(node) ? (
          <>
            <span className={styles.flKicker}>{vi ? 'Kết quả' : 'Result'}</span>
            <p className={styles.flEnd}><Rich text={node.end} /></p>
            {node.note ? <p className={styles.flNote}><Rich text={node.note} /></p> : null}
            <div className={styles.flActions}>
              <button type="button" className={cx(styles.btn, styles.btnSoft, styles.btnSm)} onClick={restart}><RotateCcw aria-hidden="true" />{vi ? 'Làm lại từ đầu' : 'Start again'}</button>
              {path.length ? <button type="button" className={cx(styles.btn, styles.btnQuiet, styles.btnSm)} onClick={back}><Undo2 aria-hidden="true" />{vi ? 'Quay lại một bước' : 'Back one step'}</button> : null}
            </div>
          </>
        ) : (
          <>
            <span className={styles.flKicker}>{vi ? `Câu hỏi ${path.length + 1}` : `Question ${path.length + 1}`}</span>
            <p className={styles.flQuestion}><Vi text={node.q} /></p>
            <div className={styles.flAnswers}>
              {'choices' in node
                ? node.choices.map((c, i) => <button key={i} type="button" className={styles.flAnswer} onClick={() => go(c.t, c.to)}><Vi text={c.t} /></button>)
                : (
                  <>
                    <button type="button" className={styles.flAnswer} data-kind="yes" onClick={() => go(yes, node.yes)}>{yes}</button>
                    <button type="button" className={styles.flAnswer} data-kind="no" onClick={() => go(no, node.no)}>{no}</button>
                  </>
                )}
            </div>
            {path.length ? (
              <div className={styles.flActions}>
                <button type="button" className={cx(styles.btn, styles.btnQuiet, styles.btnSm)} onClick={back}><Undo2 aria-hidden="true" />{vi ? 'Quay lại' : 'Back'}</button>
                <button type="button" className={cx(styles.btn, styles.btnQuiet, styles.btnSm)} onClick={restart}><RotateCcw aria-hidden="true" />{vi ? 'Làm lại' : 'Restart'}</button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className={styles.flFoot}>
        <button type="button" className={cx(styles.btn, styles.btnQuiet, styles.btnSm)} aria-expanded={full} onClick={() => setFull((v) => !v)}>
          <ListTree aria-hidden="true" />{full ? (vi ? 'Ẩn toàn bộ' : 'Hide full view') : (vi ? 'Xem toàn bộ' : 'Full view')}
        </button>
      </div>
      {full ? (
        <ol className={styles.flAll}>
          {graph.order.map((id) => {
            const n = spec.nodes[id];
            return (
              <li key={id} className={styles.flAllItem} value={graph.number.get(id)}>
                {isEnd(n) ? (
                  <p><strong className={styles.flEndWord}>{vi ? 'Kết quả' : 'Result'}:</strong> <Rich text={n.end} />{n.note ? <> <span className={styles.flAllNote}><Rich text={n.note} /></span></> : null}</p>
                ) : (
                  <>
                    <p><Vi text={n.q} /></p>
                    <ul className={styles.flAllBranches}>
                      {'choices' in n
                        ? n.choices.map((c, i) => <li key={i}><CornerDownRight aria-hidden="true" /><strong><Vi text={c.t} />:</strong> {describe(c.to)}</li>)
                        : (
                          <>
                            <li><CornerDownRight aria-hidden="true" /><strong>{yes}:</strong> {describe(n.yes)}</li>
                            <li><CornerDownRight aria-hidden="true" /><strong>{no}:</strong> {describe(n.no)}</li>
                          </>
                        )}
                    </ul>
                  </>
                )}
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
