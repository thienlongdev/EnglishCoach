'use client';

import React, { useId, useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import type { DiagramSpec } from '@/types/grammar';
import { cx } from '@/lib/grammar/format';
import { Vi } from '../Inline';
import styles from '../grammar.module.css';

export type SlotsSpec = Extract<DiagramSpec, { kind: 'slots' }>;

/**
 * A sentence built from slots. Each column holds the options for one place in the sentence; choose one in each column and the
 * sentence is composed live. With `fixedOrder` the columns are numbered, because the order itself is what the lesson teaches.
 */
export function SlotsDiagram({ spec }: { spec: SlotsSpec }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const uid = useId();
  const [picks, setPicks] = useState<number[]>(() => spec.slots.map(() => 0));
  const template = spec.sentence ?? spec.slots.map((_, i) => `{${i}}`).join(' ');
  const parts = template.split(/(\{\d+\})/g).filter((p) => p !== '');

  return (
    <div className={styles.sl}>
      <div className={styles.slCols} data-fixed={spec.fixedOrder ? 'true' : 'false'}>
        {spec.slots.map((slot, si) => (
          <div key={si} className={styles.slCol} data-slot={si % 6} role="group" aria-labelledby={`${uid}-h${si}`}>
            <p id={`${uid}-h${si}`} className={styles.slHead}>
              {spec.fixedOrder ? <span className={styles.slOrder} aria-label={vi ? `Vị trí ${si + 1}` : `Position ${si + 1}`}>{si + 1}</span> : null}
              <Vi text={slot.label} />
            </p>
            <ul className={styles.slOpts}>
              {slot.items.map((item, ii) => (
                <li key={ii}>
                  <button
                    type="button"
                    className={cx(styles.slOpt, picks[si] === ii && styles.slOptOn)}
                    aria-pressed={picks[si] === ii}
                    lang="en"
                    onClick={() => setPicks((p) => p.map((v, k) => (k === si ? ii : v)))}
                  >
                    {item === '' ? <span className={styles.slNone}>{vi ? '(bỏ trống)' : '(nothing)'}</span> : item}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className={styles.slSentence} lang="en" aria-live="polite">
        {parts.map((part, i) => {
          const m = /^\{(\d+)\}$/.exec(part);
          if (!m) return <React.Fragment key={i}>{part}</React.Fragment>;
          const si = Number(m[1]);
          const item = spec.slots[si]?.items[picks[si] ?? 0] ?? '';
          return <span key={`${si}-${picks[si]}`} className={styles.slPick} data-slot={si % 6}>{item}</span>;
        })}
      </p>
    </div>
  );
}
