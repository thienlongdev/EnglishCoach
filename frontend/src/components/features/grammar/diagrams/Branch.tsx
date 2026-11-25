'use client';

import React, { useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, History } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { DiagramSpec } from '@/types/grammar';
import { cx } from '@/lib/grammar/format';
import { En, Vi } from '../Inline';
import styles from '../grammar.module.css';
import { useWidth } from './shared';

export type BranchSpec = Extract<DiagramSpec, { kind: 'branch' }>;

const WORLD = {
  real: { vi: 'Có thật hoặc có thể xảy ra', en: 'Real or possible' },
  unreal: { vi: 'Không có thật ở hiện tại', en: 'Not real now' },
  'past-unreal': { vi: 'Đã không xảy ra trong quá khứ', en: 'Did not happen in the past' },
  mixed: { vi: 'Quá khứ và hiện tại pha nhau', en: 'Past and present mixed' },
} as const;

/**
 * A condition fanning out into its possible worlds. Real worlds are drawn with a solid line, unreal ones dashed, past-unreal
 * ones dotted with a clock, mixed ones dash-dot, so the kind is never carried by colour alone. Choose a branch to focus it and
 * read its note; the others step back. On a narrow screen the branches stack under the root.
 */
export function BranchDiagram({ spec }: { spec: BranchSpec }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [focus, setFocus] = useState<number | null>(null);
  const [paths, setPaths] = useState<{ d: string; world: string }[]>([]);
  const wide = width >= 600;

  useLayoutEffect(() => {
    const box = boxRef.current;
    const root = rootRef.current;
    if (!wide || !box || !root) { setPaths([]); return; }
    const b = box.getBoundingClientRect();
    const r = root.getBoundingClientRect();
    const x0 = r.right - b.left;
    const y0 = r.top + r.height / 2 - b.top;
    const next: { d: string; world: string }[] = [];
    spec.branches.forEach((br, i) => {
      const row = rowRefs.current[i];
      if (!row) return;
      const q = row.getBoundingClientRect();
      const x1 = q.left - b.left;
      const y1 = q.top + 28 - b.top;
      const mx = (x0 + x1) / 2;
      next.push({ d: `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}`, world: br.world });
    });
    setPaths(next);
  }, [wide, width, focus, spec.branches, boxRef]);

  return (
    <div ref={boxRef} className={styles.br} data-wide={wide ? 'true' : 'false'}>
      {wide ? (
        <svg className={styles.brLinks} aria-hidden="true">
          {paths.map((p, i) => <path key={i} className={styles.brLink} data-world={p.world} d={p.d} />)}
        </svg>
      ) : null}
      <div ref={rootRef} className={styles.brRoot}>
        <span className={styles.brRootLabel}>{vi ? 'Xuất phát' : 'Start'}</span>
        <Vi text={spec.root} className={styles.brRootText} />
      </div>
      <ul className={styles.brList}>
        {spec.branches.map((br, i) => {
          const world = WORLD[br.world] ?? WORLD.real;
          const on = focus === i;
          return (
            <li key={i} className={styles.brItem}>
              <button
                type="button"
                ref={(el) => { rowRefs.current[i] = el; }}
                className={cx(styles.brCard, on && styles.brCardOn)}
                data-world={br.world}
                data-dim={focus !== null && !on ? 'true' : 'false'}
                aria-pressed={on}
                onClick={() => setFocus(on ? null : i)}
              >
                <span className={styles.brWorld}>
                  {br.world === 'past-unreal' ? <History aria-hidden="true" /> : <span className={styles.brSwatch} aria-hidden="true" />}
                  {vi ? world.vi : world.en}
                </span>
                <span className={styles.brLine}>
                  <En text={br.cond} className={styles.brCond} />
                  <ArrowRight aria-hidden="true" className={styles.brArrow} />
                  <En text={br.result} className={styles.brResult} />
                </span>
                {on && br.note ? <Vi text={br.note} as="span" className={styles.brNote} /> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
