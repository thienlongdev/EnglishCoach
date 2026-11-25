'use client';

import React, { useMemo, useRef, useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import type { DiagramSpec } from '@/types/grammar';
import { cx } from '@/lib/grammar/format';
import { En, Vi } from '../Inline';
import styles from '../grammar.module.css';
import { useWidth } from './shared';

export type ScaleSpec = Extract<DiagramSpec, { kind: 'scale' }>;
type Item = ScaleSpec['items'][number];

const TIER_REM = [0.2, 1.75, 3.3, 4.85, 6.4];

/**
 * A gauge from one meaning to its opposite with the words placed along it. Neighbours that would collide on one line hang at
 * different depths. Choose a word (or step with the arrow keys) to read its example and note.
 */
export function ScaleDiagram({ spec }: { spec: ScaleSpec }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const [sel, setSel] = useState<number | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const items = useMemo(() => [...spec.items].sort((a, b) => a.pos - b.pos), [spec.items]);
  const tiers = useMemo(() => {
    const w = width || 560;
    const right: number[] = [];
    return items.map((it) => {
      const half = ((it.t.length * 8.4 + 22) / w) * 50;
      const left = it.pos - half;
      let tier = right.findIndex((r) => r + 0.8 < left);
      if (tier < 0) tier = right.length < TIER_REM.length ? right.length : right.indexOf(Math.min(...right));
      right[tier] = it.pos + half;
      return tier;
    });
  }, [items, width]);
  const depth = Math.max(0, ...tiers);
  const picked: Item | null = sel === null ? null : items[sel] ?? null;

  const move = (to: number) => {
    const next = Math.max(0, Math.min(items.length - 1, to));
    setSel(next);
    buttons.current[next]?.focus();
  };

  return (
    <div className={styles.sc}>
      <div className={styles.scEnds} aria-hidden="true">
        <span>{spec.from}</span>
        <span>{spec.to}</span>
      </div>
      <div
        ref={boxRef}
        className={styles.scStage}
        role="group"
        aria-label={vi ? `Thang từ “${spec.from}” đến “${spec.to}”` : `Scale from “${spec.from}” to “${spec.to}”`}
        style={{ height: `${TIER_REM[depth] + 3.2}rem` }}
      >
        <div className={styles.scTrack} aria-hidden="true" />
        {items.map((it, i) => (
          <button
            key={`${it.t}-${i}`}
            ref={(el) => { buttons.current[i] = el; }}
            type="button"
            className={cx(styles.scItem, sel === i && styles.scItemOn)}
            style={{ left: `${Math.max(0, Math.min(100, it.pos))}%`, '--leader': `${TIER_REM[tiers[i]]}rem` } as React.CSSProperties}
            aria-pressed={sel === i}
            tabIndex={sel === i || (sel === null && i === 0) ? 0 : -1}
            onClick={() => setSel(sel === i ? null : i)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(i + 1); }
              else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(i - 1); }
              else if (e.key === 'Home') { e.preventDefault(); move(0); }
              else if (e.key === 'End') { e.preventDefault(); move(items.length - 1); }
            }}
          >
            <span className={styles.scDot} aria-hidden="true" />
            <span className={styles.scLeader} aria-hidden="true" />
            <span className={styles.scName} lang="en">{it.t}</span>
          </button>
        ))}
      </div>
      <div className={styles.scPanel} aria-live="polite">
        {picked ? (
          <>
            <span className={styles.scPanelWord} lang="en">{picked.t}</span>
            {picked.en ? <p className={styles.scPanelEn}><En text={picked.en} /></p> : null}
            {picked.vi ? <p className={styles.scPanelVi}><Vi text={picked.vi} /></p> : null}
            {!picked.en && !picked.vi ? <p className={styles.scPanelVi}>{vi ? 'Mốc này chưa có ví dụ.' : 'No example for this one yet.'}</p> : null}
          </>
        ) : (
          <p className={styles.scHint}>{vi ? 'Chọn một từ trên thang để xem ví dụ.' : 'Choose a word on the scale to see an example.'}</p>
        )}
      </div>
    </div>
  );
}
