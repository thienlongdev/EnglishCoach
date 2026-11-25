'use client';

import React from 'react';
import { ArrowRight, Globe, Languages, Lightbulb, MousePointerClick, Quote, TriangleAlert, X } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { plainInline } from '@/lib/grammar/inline';
import { ROLE_INFO, cx, exampleTagLabel, noteLabel } from '@/lib/grammar/format';
import type { Block, Exercise, Verdict } from '@/types/grammar';
import { Diagram } from './diagrams';
import { ExerciseCard } from './exercises/ExerciseCard';
import { En, Rich, Vi } from './Inline';
import styles from './grammar.module.css';

/** The ids a lesson's sub-headings get, so a table of contents can point at them. */
export function headingsOf(blocks: Block[], idPrefix: string): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  blocks.forEach((b, i) => { if (b.type === 'h') out.push({ id: `${idPrefix}-${i}`, text: plainInline(b.vi) }); });
  return out;
}

const NOTE_ICON = { tip: Lightbulb, warn: TriangleAlert, register: Quote, regional: Globe, vn: Languages } as const;
const WIDE: Block['type'][] = ['diagram', 'contrast', 'table', 'formula', 'try'];

export interface BlocksProps {
  blocks: Block[];
  /** The topic these blocks belong to (exercises are attempted against it). */
  topic?: string;
  /** The exercises a `try` block may pull in, by id. Without them a `try` block renders nothing. */
  exercises?: Exercise[];
  idPrefix?: string;
  onResult?: (verdict: Verdict) => void;
  className?: string;
}

/**
 * Renders a list of lesson blocks in order. Each block is as wide as it needs: prose keeps a reading measure (68 characters),
 * diagrams, tables, contrasts and formulas break out of it. The blocks share one rhythm, so a lesson built from different blocks
 * (a timeline-heavy one, a decision-flow one, a story-like one) looks different because its blocks differ, not because the
 * page does.
 */
export function Blocks({ blocks, topic, exercises, idPrefix = 'b', onResult, className }: BlocksProps) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const byId = React.useMemo(() => new Map((exercises ?? []).map((e) => [e.id, e])), [exercises]);

  return (
    <div className={cx(styles.blocks, className)}>
      {blocks.map((b, i) => {
        const key = `${idPrefix}-${i}`;
        const wide = WIDE.includes(b.type);
        switch (b.type) {
          case 'p':
            return <p key={key} className={cx(styles.block, styles.prose)} data-type="p"><Vi text={b.vi} /></p>;
          case 'h':
            return <h3 key={key} id={key} tabIndex={-1} className={cx(styles.block, styles.subhead)} data-type="h"><Vi text={b.vi} /></h3>;
          case 'formula': {
            const lines = b.lines ?? (b.parts ? [{ parts: b.parts }] : []);
            return (
              <div key={key} className={cx(styles.block, styles.formula)} data-type="formula" data-wide="true">
                {lines.map((line, li) => (
                  <div key={li} className={styles.fLine}>
                    {line.label ? <span className={styles.fLabel}><Vi text={line.label} /></span> : null}
                    <div className={styles.fParts} role="group" aria-label={vi ? 'Cấu trúc câu' : 'Sentence pattern'}>
                      {line.parts.map((p, pi) => (
                        <React.Fragment key={pi}>
                          {pi > 0 ? <span className={styles.fPlus} aria-hidden="true">+</span> : null}
                          <span className={styles.fPart} data-role={p.role ?? 'none'} title={p.role && ROLE_INFO[p.role] ? (vi ? ROLE_INFO[p.role].vi : ROLE_INFO[p.role].en) : undefined}>
                            <span className={styles.fText} lang="en">{p.t}</span>
                            {p.role ? <span className={styles.fTag}>{p.role}</span> : null}
                          </span>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                ))}
                {b.note ? <p className={styles.fNote}><Vi text={b.note} /></p> : null}
              </div>
            );
          }
          case 'examples':
            return (
              <ul key={key} className={cx(styles.block, styles.examples)} data-type="examples">
                {b.items.map((it, ii) => (
                  <li key={ii} className={styles.example}>
                    <div className={styles.exBody}>
                      <p className={styles.exEn}><En text={it.en} /></p>
                      <p className={styles.exVi}><Vi text={it.vi} /></p>
                      {it.note ? <p className={styles.exNote}><ArrowRight aria-hidden="true" /><Vi text={it.note} /></p> : null}
                    </div>
                    {it.tag ? <span className={styles.exTag} data-tag={it.tag}>{exampleTagLabel(it.tag, vi)}</span> : null}
                  </li>
                ))}
              </ul>
            );
          case 'contrast':
            return (
              <div key={key} className={cx(styles.block, styles.contrast)} data-type="contrast" data-wide="true">
                {b.items.map((it, ci) => (
                  <div key={ci} className={styles.cItem}>
                    <div className={styles.cCols}>
                      {([['a', it.a, b.labelA, it.aBad], ['b', it.b, b.labelB, it.bBad]] as const).map(([side, text, label, bad]) => (
                        <div key={side} className={styles.cSide} data-side={side} data-bad={bad ? 'true' : 'false'}>
                          <span className={styles.cLabel}>{label ?? (side === 'a' ? (vi ? 'Cách 1' : 'Version 1') : (vi ? 'Cách 2' : 'Version 2'))}</span>
                          <p className={styles.cEn}>
                            {bad ? <X className={styles.cCross} aria-hidden="true" /> : null}
                            <En text={text.en} className={styles.cEnText} />
                            {bad ? <span className={styles.srOnly}>{vi ? ' (câu này không đúng)' : ' (this one is not correct)'}</span> : null}
                          </p>
                          <p className={styles.cVi}><Vi text={text.vi} /></p>
                        </div>
                      ))}
                    </div>
                    <p className={styles.cDiff}><ArrowRight aria-hidden="true" /><Vi text={it.diff} /></p>
                  </div>
                ))}
              </div>
            );
          case 'table':
            return (
              <div key={key} className={cx(styles.block, styles.tableBlock)} data-type="table" data-wide="true">
                <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={b.caption ? plainInline(b.caption) : vi ? 'Bảng, cuộn ngang nếu cần' : 'Table, scroll sideways if needed'}>
                  <table className={styles.table}>
                    {b.caption ? <caption className={styles.tableCap}><Vi text={b.caption} /></caption> : null}
                    <thead>
                      <tr>{b.head.map((h, hi) => <th key={hi} scope="col"><Rich text={h} /></th>)}</tr>
                    </thead>
                    <tbody>
                      {b.rows.map((r, ri) => (
                        <tr key={ri}>{r.map((c, ci) => <td key={ci}><Rich text={c} /></td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          case 'note': {
            const Icon = NOTE_ICON[b.kind] ?? Lightbulb;
            return (
              <aside key={key} className={cx(styles.block, styles.note)} data-type="note" data-kind={b.kind}>
                <span className={styles.noteIcon} aria-hidden="true"><Icon /></span>
                <div className={styles.noteBody}>
                  <p className={styles.noteTitle}>{noteLabel(b.kind, vi)}</p>
                  <p className={styles.noteText}><Vi text={b.vi} /></p>
                </div>
              </aside>
            );
          }
          case 'diagram':
            return (
              <div key={key} className={cx(styles.block, styles.diagramBlock)} data-type="diagram" data-wide="true" data-kind={b.spec.kind}>
                <Diagram spec={b.spec} caption={b.caption} alt={b.alt} />
              </div>
            );
          case 'try': {
            const ex = byId.get(b.exercise);
            if (!ex) return null;
            return (
              <section key={key} className={cx(styles.block, styles.tryCard)} data-type="try" data-wide={wide ? 'true' : 'false'} aria-label={vi ? 'Thử ngay' : 'Try it'}>
                <p className={styles.tryHead}><MousePointerClick aria-hidden="true" />{vi ? 'Thử ngay' : 'Try it now'}</p>
                <ExerciseCard exercise={ex} topic={topic} onResult={onResult} />
              </section>
            );
          }
          default:
            return null;
        }
      })}
    </div>
  );
}
