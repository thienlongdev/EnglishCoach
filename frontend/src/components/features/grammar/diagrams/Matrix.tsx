'use client';

import React, { useId, useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import type { DiagramSpec } from '@/types/grammar';
import { En, Rich, Vi } from '../Inline';
import styles from '../grammar.module.css';

export type MatrixSpec = Extract<DiagramSpec, { kind: 'matrix' }>;

/**
 * A grid of forms. A cell that cannot occur (`off`) is muted and hatched, and says so in words for a screen reader. A cell with
 * a note is a button: choose it to read the note under the grid. The grid scrolls inside itself on a narrow screen.
 */
export function MatrixDiagram({ spec }: { spec: MatrixSpec }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const uid = useId();
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const cell = sel ? spec.cells[sel.r]?.[sel.c] : null;
  const hasNotes = spec.cells.some((row) => row.some((c) => !!c?.note));

  return (
    <div className={styles.mx}>
      <div className={styles.mxScroll} tabIndex={0} role="region" aria-label={vi ? 'Bảng so sánh, cuộn ngang nếu cần' : 'Comparison grid, scroll sideways if needed'}>
        <table className={styles.mxTable}>
          <thead>
            <tr>
              <td className={styles.mxCorner} aria-hidden="true" />
              {spec.cols.map((c, i) => <th key={i} scope="col" className={styles.mxCol}><Rich text={c} /></th>)}
            </tr>
          </thead>
          <tbody>
            {spec.rows.map((r, ri) => (
              <tr key={ri}>
                <th scope="row" className={styles.mxRow}><Rich text={r} /></th>
                {spec.cols.map((_, ci) => {
                  const c = spec.cells[ri]?.[ci];
                  if (!c) return <td key={ci} className={styles.mxCell} data-off="true" />;
                  const on = sel?.r === ri && sel?.c === ci;
                  return (
                    <td key={ci} className={styles.mxCell} data-off={c.off ? 'true' : 'false'} data-on={on ? 'true' : 'false'}>
                      {c.note ? (
                        <button type="button" className={styles.mxBtn} aria-pressed={on} aria-describedby={on ? `${uid}-note` : undefined} onClick={() => setSel(on ? null : { r: ri, c: ci })}>
                          <En text={c.t} />
                          {c.off ? <span className={styles.srOnly}>{vi ? ' (không dùng được)' : ' (not possible)'}</span> : null}
                        </button>
                      ) : (
                        <span className={styles.mxText}>
                          <En text={c.t} />
                          {c.off ? <span className={styles.srOnly}>{vi ? ' (không dùng được)' : ' (not possible)'}</span> : null}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasNotes ? (
        <div className={styles.mxNote} id={`${uid}-note`} aria-live="polite">
          {cell?.note ? <Vi text={cell.note} /> : <span className={styles.scHint}>{vi ? 'Chọn một ô có viền để đọc ghi chú.' : 'Choose an outlined cell to read its note.'}</span>}
        </div>
      ) : null}
    </div>
  );
}
