'use client';

import React from 'react';
import { useLanguage } from '@/context/LanguageContext';
import type { DiagramSpec } from '@/types/grammar';
import { En } from '../Inline';
import styles from '../grammar.module.css';
import { useInView } from './shared';

export type TimelineSpec = Extract<DiagramSpec, { kind: 'timeline' }>;
type TlEvent = TimelineSpec['events'][number];

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/** Where an event sits on the 0 to 100 axis. */
function extent(e: TlEvent, now: number): { start: number; end: number } {
  const at = e.at ?? e.from ?? 0;
  if (e.kind === 'point') return { start: clamp(at), end: clamp(at) };
  if (e.kind === 'repeat') {
    if (e.from != null && e.to != null) return { start: clamp(Math.min(e.from, e.to)), end: clamp(Math.max(e.from, e.to)) };
    return { start: clamp(at - 12), end: clamp(at + 12) };
  }
  const from = clamp(e.from ?? at);
  const to = clamp(e.to ?? now);
  return { start: Math.min(from, to), end: Math.max(from, to) };
}

function labelPlace(start: number, end: number): { style: React.CSSProperties; align: 'start' | 'center' | 'end' } {
  const mid = (start + end) / 2;
  if (mid <= 38) return { style: { left: `${Math.min(start, 34)}%` }, align: 'start' };
  if (mid >= 62) return { style: { right: `${Math.min(100 - end, 34)}%` }, align: 'end' };
  return { style: { left: `${mid}%`, translate: '-50% 0' }, align: 'center' };
}

const KIND_WORD = {
  point: { vi: 'một thời điểm', en: 'a moment' },
  span: { vi: 'một khoảng thời gian', en: 'a stretch of time' },
  repeat: { vi: 'lặp lại nhiều lần', en: 'repeated' },
  open: { vi: 'một khoảng còn có thể tiếp tục', en: 'a stretch that may continue' },
} as const;

/**
 * Past to future on one axis with a labelled NOW. point = dot, span = bar, repeat = several ticks, open = bar with an arrow past
 * its end, role `ref` = hollow marker, `ghost` = dashed faded mark. It draws itself once when it first scrolls into view; hover
 * or focus an event to light it. Positions are schematic (0 to 100), never a scale: no numbers are drawn.
 */
export function TimelineDiagram({ spec }: { spec: TimelineSpec }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const now = clamp(spec.now ?? 70);
  const [ref, seen] = useInView<HTMLDivElement>({ once: true });
  const [lit, setLit] = React.useState<number | null>(null);

  return (
    <div ref={ref} className={styles.tl} data-drawn={seen ? 'true' : 'false'} style={{ '--now': `${now}%` } as React.CSSProperties}>
      {spec.sentence ? (
        <p className={styles.tlSentence}><En text={spec.sentence} /></p>
      ) : null}
      <div className={styles.tlPlot}>
        <div className={styles.tlFuture} aria-hidden="true" />
        <div className={styles.tlNow} aria-hidden="true"><span>{vi ? 'BÂY GIỜ' : 'NOW'}</span></div>
        <div className={styles.tlLanes} role="list" data-lit={lit === null ? 'false' : 'true'}>
          {spec.events.map((e, i) => {
            const { start, end } = extent(e, now);
            const role = e.role ?? 'main';
            const place = labelPlace(start, e.kind === 'open' ? Math.min(100, end + 5) : end);
            const side = (start + end) / 2 < now ? (vi ? 'trước bây giờ' : 'before now') : (vi ? 'sau bây giờ' : 'after now');
            return (
              <div
                key={i}
                role="listitem"
                tabIndex={0}
                className={styles.tlLane}
                data-kind={e.kind}
                data-role={role}
                data-on={lit === i ? 'true' : 'false'}
                style={{ '--i': i } as React.CSSProperties}
                aria-label={`${e.label} (${vi ? KIND_WORD[e.kind].vi : KIND_WORD[e.kind].en}, ${side})`}
                onMouseEnter={() => setLit(i)}
                onMouseLeave={() => setLit(null)}
                onFocus={() => setLit(i)}
                onBlur={() => setLit(null)}
              >
                <span className={styles.tlLabel} data-align={place.align} style={place.style}>{e.label}</span>
                <div className={styles.tlTrack} aria-hidden="true">
                  {e.kind === 'point' ? <span className={styles.tlDot} style={{ left: `${start}%` }} /> : null}
                  {e.kind === 'span' || e.kind === 'open' ? (
                    <span className={styles.tlBar} style={{ left: `${start}%`, width: `${Math.max(end - start, 0.8)}%` }} />
                  ) : null}
                  {e.kind === 'open' ? <span className={styles.tlArrow} style={{ left: `${end}%` }} /> : null}
                  {e.kind === 'repeat' ? (
                    <>
                      <span className={styles.tlHair} style={{ left: `${start}%`, width: `${Math.max(end - start, 0.8)}%` }} />
                      {[0, 1, 2, 3, 4].map((t) => (
                        <span key={t} className={styles.tlTick} style={{ left: `${start + ((end - start) * t) / 4}%`, '--t': t } as React.CSSProperties} />
                      ))}
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        <div className={styles.tlAxis} aria-hidden="true">
          <span className={styles.tlAxisLine} />
          <span className={styles.tlAxisPast}>{vi ? 'Quá khứ' : 'Past'}</span>
          <span className={styles.tlAxisFuture}>{vi ? 'Tương lai' : 'Future'}</span>
        </div>
      </div>
    </div>
  );
}
