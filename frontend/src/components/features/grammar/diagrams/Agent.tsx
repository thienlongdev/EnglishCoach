'use client';

import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import type { DiagramSpec } from '@/types/grammar';
import { cx } from '@/lib/grammar/format';
import { En, Vi } from '../Inline';
import styles from '../grammar.module.css';
import { measureFlip, playFlip, type Box } from './flip';
import { usePrefersReducedMotion, useWidth } from './shared';

export type AgentSpec = Extract<DiagramSpec, { kind: 'agent' }>;

type Part = 'agent' | 'action' | 'patient';

/**
 * Who does what to whom, seen from two sides. The three boxes keep their meaning (agent, action, patient) and the arc always
 * runs from the one who acts to the one acted on; the Active / Passive switch changes only which box stands in subject position
 * and the sentence that results. The boxes glide to their new places (instantly under reduced motion).
 */
export function AgentDiagram({ spec }: { spec: AgentSpec }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const reduced = usePrefersReducedMotion();
  const head = `ag-head-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [passive, setPassive] = useState(false);
  const [rowRef, width] = useWidth<HTMLDivElement>();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const before = useRef<Map<string, Box> | null>(null);
  const [arc, setArc] = useState<string | null>(null);
  const wide = width >= 520;

  const order: Part[] = passive ? ['patient', 'action', 'agent'] : ['agent', 'action', 'patient'];
  const text: Record<Part, string> = { agent: spec.agent, action: spec.action, patient: spec.patient };
  const meaning: Record<Part, { vi: string; en: string }> = {
    agent: { vi: 'Người hoặc vật thực hiện', en: 'Does the action' },
    action: { vi: 'Hành động', en: 'The action' },
    patient: { vi: 'Người hoặc vật chịu tác động', en: 'Is acted on' },
  };
  const place: Record<Part, { vi: string; en: string }> = passive
    ? {
        patient: { vi: 'Đứng ở vị trí chủ ngữ', en: 'In subject position' },
        action: { vi: 'Động từ ở dạng bị động', en: 'Passive verb' },
        agent: { vi: 'Thường đứng sau by', en: 'Usually after by' },
      }
    : {
        agent: { vi: 'Đứng ở vị trí chủ ngữ', en: 'In subject position' },
        action: { vi: 'Động từ chủ động', en: 'Active verb' },
        patient: { vi: 'Đứng sau động từ', en: 'After the verb' },
      };

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const after = measureFlip(el);
    const was = before.current;
    before.current = after;
    if (was && !reduced) playFlip(el, was, after, 560);
    const a = after.get('agent');
    const p = after.get('patient');
    if (wide && a && p) {
      const y = Math.min(a.y, p.y);
      const x1 = a.x + a.w / 2;
      const x2 = p.x + p.w / 2;
      const lift = Math.min(54, 20 + Math.abs(x2 - x1) * 0.12);
      setArc(`M${x1},${y - 6} C${x1},${y - lift} ${x2},${y - lift} ${x2},${y - 8}`);
    } else {
      setArc(null);
    }
  }, [passive, reduced, wide, width]);

  return (
    <div className={styles.ag} ref={rowRef}>
      <div className={styles.agSwitch} role="group" aria-label={vi ? 'Chọn thể của câu' : 'Choose the voice'}>
        <button type="button" className={styles.agSwitchBtn} aria-pressed={!passive} onClick={() => setPassive(false)}>{vi ? 'Câu chủ động' : 'Active'}</button>
        <button type="button" className={styles.agSwitchBtn} aria-pressed={passive} onClick={() => setPassive(true)}>{vi ? 'Câu bị động' : 'Passive'}</button>
      </div>
      <div ref={boxRef} className={styles.agBoxes} data-wide={wide ? 'true' : 'false'}>
        {arc ? (
          <svg className={styles.agArcSvg} aria-hidden="true">
            <defs>
              <marker id={head} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className={styles.agHead} />
              </marker>
            </defs>
            <path key={passive ? 'p' : 'a'} className={styles.agArc} d={arc} markerEnd={`url(#${head})`} />
          </svg>
        ) : null}
        {arc ? <span className={styles.agArcLabel} style={{ left: '50%' }} aria-hidden="true">{vi ? 'ai làm gì cho ai' : 'who acts on whom'}</span> : null}
        {order.map((part, i) => (
          <React.Fragment key={part}>
            <div className={cx(styles.agBox, i === 0 && styles.agBoxSubject)} data-flip={part} data-part={part}>
              <span className={styles.agMeaning}>{vi ? meaning[part].vi : meaning[part].en}</span>
              <En text={text[part]} className={styles.agWord} />
              <span className={styles.agPlace}>{vi ? place[part].vi : place[part].en}</span>
            </div>
          </React.Fragment>
        ))}
      </div>
      <p className={styles.agSentence} key={passive ? 'p' : 'a'} aria-live="polite">
        <En text={passive ? spec.passive : spec.active} />
      </p>
      {spec.note ? <p className={styles.agNote}><Vi text={spec.note} /></p> : null}
    </div>
  );
}
