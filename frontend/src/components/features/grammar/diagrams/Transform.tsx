'use client';

import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { DiagramSpec } from '@/types/grammar';
import { cx } from '@/lib/grammar/format';
import { Vi } from '../Inline';
import styles from '../grammar.module.css';
import { useInView } from './shared';
import { WordMorph } from './WordMorph';

export type TransformSpec = Extract<DiagramSpec, { kind: 'transform' }>;

/**
 * One sentence turned into another, step by step. The words keep their identity from step to step, so you watch them move:
 * Previous and Next step, Play walks through all the steps (only while the diagram is on screen), and a step can be chosen
 * directly. Under reduced motion the sentence changes with no movement.
 */
export function TransformDiagram({ spec }: { spec: TransformSpec }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const steps = spec.steps;
  const last = steps.length - 1;
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ref, visible] = useInView<HTMLDivElement>();

  useEffect(() => {
    if (!playing || !visible) return;
    const timer = window.setTimeout(() => {
      if (at < last) setAt(at + 1);
      else setPlaying(false);
    }, 2300);
    return () => window.clearTimeout(timer);
  }, [playing, visible, at, last]);

  if (!steps.length) return null;
  const step = steps[Math.min(at, last)];
  const play = () => {
    if (playing) { setPlaying(false); return; }
    if (at >= last) setAt(0);
    setPlaying(true);
  };

  return (
    <div ref={ref} className={styles.tf}>
      <ol className={styles.tfSteps} aria-label={vi ? 'Các bước' : 'Steps'}>
        {steps.map((s, i) => (
          <li key={i}>
            <button
              type="button"
              className={styles.tfStep}
              aria-current={i === at ? 'step' : undefined}
              data-done={i < at ? 'true' : 'false'}
              onClick={() => { setPlaying(false); setAt(i); }}
            >
              <span className={styles.tfNum} aria-hidden="true">{i + 1}</span>
              <span className={styles.tfStepLabel}><Vi text={s.label} /></span>
            </button>
          </li>
        ))}
      </ol>
      <div className={styles.tfStage}>
        <p className={styles.tfNow}>
          {vi ? `Bước ${at + 1} trên ${steps.length}` : `Step ${at + 1} of ${steps.length}`}
          <span aria-hidden="true"> · </span>
          <Vi text={step.label} />
        </p>
        <WordMorph sentence={step.sentence} changed={at > 0 ? spec.changed : undefined} live className={styles.tfSentence} />
      </div>
      <div className={styles.tfControls}>
        <button type="button" className={cx(styles.btn, styles.btnQuiet, styles.btnSm)} onClick={() => { setPlaying(false); setAt(Math.max(0, at - 1)); }} disabled={at === 0}>
          <ChevronLeft aria-hidden="true" />{vi ? 'Bước trước' : 'Previous'}
        </button>
        <button type="button" className={cx(styles.btn, styles.btnQuiet, styles.btnSm)} onClick={play}>
          {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          {playing ? (vi ? 'Tạm dừng' : 'Pause') : (vi ? 'Chạy từng bước' : 'Play')}
        </button>
        <button type="button" className={cx(styles.btn, styles.btnSoft, styles.btnSm)} onClick={() => { setPlaying(false); setAt(Math.min(last, at + 1)); }} disabled={at === last}>
          {vi ? 'Bước sau' : 'Next'}<ChevronRight aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
