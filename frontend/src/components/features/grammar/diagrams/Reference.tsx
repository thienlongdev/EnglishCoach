'use client';

import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link2, TriangleAlert } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { DiagramSpec } from '@/types/grammar';
import { plainRoles } from '@/lib/grammar/inline';
import { cx } from '@/lib/grammar/format';
import { Vi } from '../Inline';
import styles from '../grammar.module.css';
import { useWidth } from './shared';

export type ReferenceSpec = Extract<DiagramSpec, { kind: 'reference' }>;

type Seg = { k: 'text'; t: string } | { k: 'ante'; id: string; t: string; n: number } | { k: 'ptr'; id: string; t: string; n: number };

/** `{a:the report}` is an antecedent, `{a<:it}` a pointer back to it. Anything else is plain text. */
export function parseReference(text: string): Seg[] {
  const out: Seg[] = [];
  const re = /\{([A-Za-z0-9_-]+)(<)?:([^}]*)\}/g;
  let last = 0;
  let n = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ k: 'text', t: text.slice(last, m.index) });
    out.push(m[2] ? { k: 'ptr', id: m[1], t: m[3], n } : { k: 'ante', id: m[1], t: m[3], n });
    n++;
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ k: 'text', t: text.slice(last) });
  return out;
}

interface Arc { key: string; d: string; id: string; ambiguous: boolean }

/**
 * Which word points back to which. Antecedents are underlined, pointers are chips; hover or focus either to see its arc over
 * the line, or press "Show links" for all of them. A `wrong` sentence is the ambiguous version: a pointer is then joined to
 * every earlier antecedent it could mean, with dashes, and the note says why that is a problem.
 */
export function ReferenceDiagram({ spec }: { spec: ReferenceSpec }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const segs = useMemo(() => parseReference(spec.text), [spec.text]);
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const nodes = useRef(new Map<number, HTMLElement>());
  const [all, setAll] = useState(false);
  const [hot, setHot] = useState<string | null>(null);
  const [arcs, setArcs] = useState<Arc[]>([]);
  const ambiguous = !!spec.wrong;

  const antes = segs.filter((s): s is Extract<Seg, { k: 'ante' }> => s.k === 'ante');
  const ptrs = segs.filter((s): s is Extract<Seg, { k: 'ptr' }> => s.k === 'ptr');

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const b = box.getBoundingClientRect();
    const point = (n: number) => {
      const el = nodes.current.get(n);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2 - b.left, y: r.top - b.top };
    };
    const next: Arc[] = [];
    for (const p of ptrs) {
      if (!all && hot !== p.id) continue;
      const from = point(p.n);
      if (!from) continue;
      const targets = ambiguous ? antes.filter((a) => a.n < p.n) : antes.filter((a) => a.id === p.id);
      for (const a of targets) {
        const to = point(a.n);
        if (!to) continue;
        const dx = Math.abs(to.x - from.x);
        const top = Math.min(from.y, to.y);
        const lift = 18 + Math.min(34, dx * 0.14) + (from.y !== to.y ? 10 : 0);
        next.push({
          key: `${p.n}-${a.n}`,
          id: p.id,
          ambiguous,
          d: `M${from.x},${from.y - 2} C${from.x},${top - lift} ${to.x},${top - lift} ${to.x},${to.y - 3}`,
        });
      }
    }
    setArcs(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, hot, width, spec.text, ambiguous]);

  const bind = (n: number, id: string) => ({
    ref: (el: HTMLElement | null) => { if (el) nodes.current.set(n, el); else nodes.current.delete(n); },
    onMouseEnter: () => setHot(id),
    onMouseLeave: () => setHot((h) => (h === id ? null : h)),
    onFocus: () => setHot(id),
    onBlur: () => setHot((h) => (h === id ? null : h)),
  });
  const textOf = (id: string) => antes.filter((a) => a.id === id).map((a) => plainRoles(a.t)).join(' / ');

  return (
    <div className={styles.rf}>
      <div className={styles.rfBar}>
        <button type="button" className={cx(styles.btn, styles.btnQuiet, styles.btnSm)} aria-pressed={all} onClick={() => setAll((v) => !v)}>
          <Link2 aria-hidden="true" />{all ? (vi ? 'Ẩn liên kết' : 'Hide links') : (vi ? 'Hiện liên kết' : 'Show links')}
        </button>
        <span className={styles.rfLegend}>
          <span className={styles.rfAnte} data-static="true">{vi ? 'vật được nhắc' : 'antecedent'}</span>
          <span className={styles.rfPtr} data-static="true">{vi ? 'từ chỉ lại' : 'pointer'}</span>
        </span>
      </div>
      <div ref={boxRef} className={styles.rfText} lang="en" data-ambiguous={ambiguous ? 'true' : 'false'}>
        <svg className={styles.rfArcs} aria-hidden="true">
          {arcs.map((a) => <path key={a.key} className={styles.rfArc} data-ambiguous={a.ambiguous ? 'true' : 'false'} d={a.d} />)}
        </svg>
        {segs.map((s, i) => {
          if (s.k === 'text') return <React.Fragment key={i}>{plainRoles(s.t)}</React.Fragment>;
          if (s.k === 'ante') {
            return (
              <button key={i} type="button" className={styles.rfAnte} data-hot={hot === s.id ? 'true' : 'false'} {...bind(s.n, s.id)} aria-label={`${plainRoles(s.t)} (${vi ? 'vật được nhắc tới' : 'antecedent'})`}>
                {plainRoles(s.t)}
              </button>
            );
          }
          return (
            <button
              key={i}
              type="button"
              className={styles.rfPtr}
              data-hot={hot === s.id ? 'true' : 'false'}
              {...bind(s.n, s.id)}
              aria-label={`${plainRoles(s.t)} (${ambiguous ? (vi ? 'chưa rõ chỉ lại từ nào' : 'unclear which word it points back to') : `${vi ? 'chỉ lại' : 'points back to'} ${textOf(s.id)}`})`}
            >
              {plainRoles(s.t)}
            </button>
          );
        })}
      </div>
      {ambiguous ? (
        <p className={styles.rfWarn} role="note">
          <TriangleAlert aria-hidden="true" />
          <span>{vi ? 'Câu này mơ hồ: người đọc không chắc từ chỉ lại này nói về cái nào.' : 'This sentence is ambiguous: the reader cannot tell which word the pointer means.'}</span>
        </p>
      ) : null}
      {spec.note ? <p className={styles.rfNote}><Vi text={spec.note} /></p> : null}
      <ul className={styles.srOnly}>
        {ptrs.map((p) => <li key={p.n}>{plainRoles(p.t)}: {ambiguous ? (vi ? 'có thể là ' : 'could be ') + antes.filter((a) => a.n < p.n).map((a) => plainRoles(a.t)).join(' / ') : textOf(p.id)}</li>)}
      </ul>
    </div>
  );
}
