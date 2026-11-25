'use client';

import styles from './learningPath.module.css';

export type RingState = 'ready' | 'editing' | 'empty' | 'loading';

// Fixed glints on the ring's orbit (angle in degrees, radius as a share of the ring's half-size, size in px).
const SPARKS = [
  { a: 18, r: 1.06, s: 3 }, { a: 74, r: 0.98, s: 2 }, { a: 131, r: 1.1, s: 2.5 },
  { a: 197, r: 1.03, s: 3.5 }, { a: 246, r: 1.12, s: 2 }, { a: 309, r: 1.0, s: 2.5 },
];

/**
 * The Learning Path's signature object: an energy ring around the learner's GOAL. It shows the goal the learner set —
 * never a progress fraction: the rim is a closed loop (no filled arc, no percentage), so it can never read as "75 %
 * achieved". The motion is decoration only (`aria-hidden`): a slowly turning rim, a counter-turning inner arc set, two
 * light pulses travelling the circumference, a breathing halo and orbiting glints — transform / opacity only, paused off
 * screen by the page, all of it still under reduced motion. `surgeKey` changes when the saved goal changes: the ring
 * flares once and the value settles in; `editing` charges the rim while the goal editor is open.
 */
export function GoalEnergyRing({ label, value, caption, state, surgeKey, long }: {
  label: string | null;
  value: string;
  caption: string;
  state: RingState;
  surgeKey: string;
  long?: boolean;
}) {
  return (
    <div className={styles.ring} data-state={state}>
      <div className={styles.ringArt} aria-hidden="true">
        <i className={styles.ringHalo} />
        <i className={styles.ringGlow} />
        <svg className={styles.ringTicks} viewBox="0 0 200 200">
          <circle cx="100" cy="100" r="98" pathLength="360" />
        </svg>
        <i className={styles.ringRim} />
        <svg className={styles.ringArcs} viewBox="0 0 200 200">
          <circle cx="100" cy="100" r="84" pathLength="360" className={styles.arcA} />
          <circle cx="100" cy="100" r="79" pathLength="360" className={styles.arcB} />
        </svg>
        <i className={styles.ringComet} />
        <i className={`${styles.ringComet} ${styles.ringComet2}`} />
        <i className={styles.ringCharge} />
        <span className={styles.ringSparks}>
          {SPARKS.map((p, i) => (
            <i key={i} style={{ '--a': `${p.a}deg`, '--r': p.r, '--s': `${p.s}px`, animationDelay: `${-i * 0.9}s` } as React.CSSProperties} />
          ))}
        </span>
        <i className={styles.ringCore} />
        <i key={surgeKey} className={styles.ringSurge} />
        <svg className={styles.ringPeak} viewBox="0 0 64 40">
          <path className={styles.peakBack} d="M2 38 L20 16 L27 22 L36 8 L62 38 Z" />
          <path className={styles.peakFront} d="M36 8 L44 18 L40 19 L47 27 L42 27 L62 38 L36 38 Z" />
          <path className={styles.peakRidge} d="M20 16 L27 22 L36 8 L44 18" />
        </svg>
      </div>
      <div key={surgeKey} className={styles.ringText}>
        {label && <span className={styles.ringLabel}>{label}</span>}
        <span className={styles.ringValue} data-long={long || undefined}>{value}</span>
        <span className={styles.ringCaption}>{caption}</span>
      </div>
    </div>
  );
}
