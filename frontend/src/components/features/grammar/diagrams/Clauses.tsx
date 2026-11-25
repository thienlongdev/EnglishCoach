'use client';

import React from 'react';
import { useLanguage } from '@/context/LanguageContext';
import type { ClauseNode, DiagramSpec } from '@/types/grammar';
import { En } from '../Inline';
import styles from '../grammar.module.css';

export type ClausesSpec = Extract<DiagramSpec, { kind: 'clauses' }>;

const KIND = {
  main: { vi: 'Mệnh đề chính', en: 'Main clause' },
  sub: { vi: 'Mệnh đề phụ', en: 'Subordinate clause' },
  rel: { vi: 'Mệnh đề quan hệ', en: 'Relative clause' },
  noun: { vi: 'Mệnh đề danh từ', en: 'Noun clause' },
  cond: { vi: 'Mệnh đề điều kiện', en: 'Conditional clause' },
} as const;

function Region({ node, depth, vi }: { node: ClauseNode; depth: number; vi: boolean }) {
  const kind = KIND[node.kind] ?? KIND.main;
  const name = vi ? kind.vi : kind.en;
  const label = node.label && node.label !== name ? node.label : null;
  return (
    <div className={styles.clRegion} data-kind={node.kind} data-depth={Math.min(depth, 4)} role="group" aria-label={label ? `${name}: ${label}` : name}>
      <span className={styles.clTag}>
        <span className={styles.clKind}>{name}</span>
        {label ? <span className={styles.clLabel}>{label}</span> : null}
      </span>
      <div className={styles.clBody}>
        {node.t ? <En text={node.t} className={styles.clText} /> : null}
        {(node.children ?? []).map((child, i) => <Region key={i} node={child} depth={depth + 1} vi={vi} />)}
      </div>
    </div>
  );
}

/**
 * A sentence as nested rounded regions: the main clause holds the clauses that depend on it, each labelled by kind (the label
 * is a word, and every kind also has its own border style, so colour is never the only cue).
 */
export function ClausesDiagram({ spec }: { spec: ClausesSpec }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const used = new Set<string>();
  const walk = (n: ClauseNode) => { used.add(n.kind); (n.children ?? []).forEach(walk); };
  walk(spec.tree);
  return (
    <div className={styles.cl}>
      <Region node={spec.tree} depth={0} vi={vi} />
      <ul className={styles.clKey}>
        {(Object.keys(KIND) as (keyof typeof KIND)[]).filter((k) => used.has(k)).map((k) => (
          <li key={k} className={styles.clKeyItem}><span className={styles.clSwatch} data-kind={k} aria-hidden="true" />{vi ? KIND[k].vi : KIND[k].en}</li>
        ))}
      </ul>
    </div>
  );
}
