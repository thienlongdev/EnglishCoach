'use client';

import { BookOpen, Mic, PenLine } from 'lucide-react';
import styles from './premiumGlass.module.css';
import { echoSrc } from '@/lib/brand/echoCharacters';

// Deterministic star field (same sky on server and client, no randomness at render).
const STARS = (() => {
  let seed = 29;
  const next = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: 110 }, () => ({ x: next() * 1600, y: next() * 520, r: 0.5 + next() * 1.4, o: 0.3 + next() * 0.65, t: next() < 0.22 }));
})();

const CRYSTALS = [
  { l: '3%', t: '30%', s: 64, r: -18, d: 0 },
  { l: '9%', t: '58%', s: 38, r: 22, d: -4 },
  { l: '91%', t: '62%', s: 54, r: 14, d: -2 },
  { l: '95%', t: '24%', s: 30, r: -30, d: -6 },
];

/**
 * Gói Premium backdrop (decorative, `aria-hidden`, never catches the pointer): the page's own scene — a night sky over a
 * far ridge with silk ribbons of light in the dark theme, a pearl dawn in the light one, a few floating crystal shards.
 * The wallpaper rests on this route (WallpaperStage), so the page paints this instead. Transform / opacity motion only,
 * all of it still under reduced motion.
 */
export function PremiumBackdrop() {
  return (
    <div className={styles.backdrop} aria-hidden="true">
      <div className={styles.sky} />
      <svg className={styles.stars} viewBox="0 0 1600 520" preserveAspectRatio="xMidYMin slice">
        {STARS.map((s, i) => (
          <circle key={i} cx={s.x.toFixed(1)} cy={s.y.toFixed(1)} r={s.r.toFixed(2)} opacity={s.o.toFixed(2)} className={s.t ? styles.twinkle : undefined} />
        ))}
      </svg>
      <div className={styles.aurora}><i /><i /><i /></div>
      <svg className={styles.ribbons} viewBox="0 0 1600 700" preserveAspectRatio="xMidYMin slice">
        <defs>
          <linearGradient id="pm-ribbon-a" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" className={styles.ribbonStop0} />
            <stop offset="0.5" className={styles.ribbonStop1} />
            <stop offset="1" className={styles.ribbonStop2} />
          </linearGradient>
        </defs>
        <path className={styles.ribbon} d="M-60 420 C 260 300, 520 520, 820 400 S 1340 220, 1680 330" stroke="url(#pm-ribbon-a)" />
        <path className={`${styles.ribbon} ${styles.ribbonThin}`} d="M-60 470 C 300 360, 560 560, 860 450 S 1360 280, 1680 380" stroke="url(#pm-ribbon-a)" />
        <path className={`${styles.ribbon} ${styles.ribbonFaint}`} d="M-60 250 C 240 330, 600 160, 900 250 S 1380 380, 1680 220" stroke="url(#pm-ribbon-a)" />
      </svg>
      <svg className={styles.ridge} viewBox="0 0 1600 200" preserveAspectRatio="none">
        <path className={styles.ridgeFar} d="M0 200V120L110 96L220 116L340 70L450 104L560 82L680 112L800 64L930 106L1040 80L1160 110L1280 58L1400 98L1500 84L1600 104V200Z" />
        <path className={styles.ridgeNear} d="M0 200V160L140 136L280 156L420 128L560 158L700 140L860 164L1000 132L1150 158L1300 138L1450 160L1600 142V200Z" />
      </svg>
      {CRYSTALS.map((c, i) => (
        <svg key={i} className={styles.crystal} viewBox="0 0 40 64" style={{ left: c.l, top: c.t, width: c.s, rotate: `${c.r}deg`, animationDelay: `${c.d}s` }}>
          <path className={styles.crystalBody} d="M20 0L38 22L28 64H12L2 22Z" />
          <path className={styles.crystalFacet} d="M20 0L28 22L20 64L12 22Z" />
          <path className={styles.crystalEdge} d="M20 0L38 22M20 0L2 22M2 22H38" />
        </svg>
      ))}
    </div>
  );
}

/**
 * The hero artwork (decorative, `aria-hidden`): a gold crown floating in a glass orb over a lit pedestal and a turning
 * halo, with glass capsules for the areas Premium's AI feedback serves — Speaking, Writing, Reading — and Echo Coach.
 * The hero's pointer light (`--tx` / `--ty`) leans the layers for depth.
 */
export function PremiumCrownArt() {
  return (
    <div className={styles.art} aria-hidden="true">
      <div className={styles.orb} />
      <div className={styles.beam} />
      <svg className={styles.pedestal} viewBox="0 0 320 120">
        <defs>
          <linearGradient id="pm-disc" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className={styles.discStop0} />
            <stop offset="1" className={styles.discStop1} />
          </linearGradient>
          <linearGradient id="pm-halo" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#fbbf24" stopOpacity="0" />
            <stop offset="0.3" stopColor="#fde68a" />
            <stop offset="0.6" stopColor="#a5b4fc" />
            <stop offset="1" stopColor="#67e8f9" stopOpacity="0" />
          </linearGradient>
        </defs>
        <ellipse cx="160" cy="70" rx="140" ry="34" fill="url(#pm-disc)" className={styles.disc} />
        <ellipse cx="160" cy="64" rx="140" ry="34" className={styles.discTop} />
        <ellipse cx="160" cy="58" rx="118" ry="26" className={styles.halo} stroke="url(#pm-halo)" pathLength="100" />
        <ellipse cx="160" cy="58" rx="98" ry="20" className={`${styles.halo} ${styles.haloInner}`} stroke="url(#pm-halo)" pathLength="100" />
      </svg>
      <svg className={styles.crown} viewBox="0 0 240 190">
        <defs>
          <linearGradient id="pm-gold" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fff4c2" />
            <stop offset="0.28" stopColor="#fcd34d" />
            <stop offset="0.62" stopColor="#f59e0b" />
            <stop offset="1" stopColor="#a16207" />
          </linearGradient>
          <linearGradient id="pm-gold-band" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fde68a" />
            <stop offset="0.5" stopColor="#f59e0b" />
            <stop offset="1" stopColor="#92400e" />
          </linearGradient>
          <linearGradient id="pm-velvet" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#7c3aed" />
            <stop offset="1" stopColor="#312e81" />
          </linearGradient>
          <radialGradient id="pm-ruby" cx="0.35" cy="0.3" r="0.8">
            <stop offset="0" stopColor="#ffe4e6" />
            <stop offset="0.35" stopColor="#f43f5e" />
            <stop offset="1" stopColor="#881337" />
          </radialGradient>
          <radialGradient id="pm-sapphire" cx="0.35" cy="0.3" r="0.8">
            <stop offset="0" stopColor="#e0f2fe" />
            <stop offset="0.35" stopColor="#3b82f6" />
            <stop offset="1" stopColor="#1e3a8a" />
          </radialGradient>
          <radialGradient id="pm-pearl" cx="0.35" cy="0.3" r="0.8">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="0.6" stopColor="#fef3c7" />
            <stop offset="1" stopColor="#d97706" />
          </radialGradient>
          <radialGradient id="pm-flare">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="0.4" stopColor="#fffbeb" stopOpacity="0.8" />
            <stop offset="1" stopColor="#fde68a" stopOpacity="0" />
          </radialGradient>
          <clipPath id="pm-crown-clip">
            <path d="M30 140L16 56L56 100L74 38L102 88L120 14L138 88L166 38L184 100L224 56L210 140Z" />
            <rect x="26" y="134" width="188" height="34" rx="8" />
          </clipPath>
        </defs>
        <path d="M44 132C70 84 170 84 196 132Z" fill="url(#pm-velvet)" />
        <path d="M30 140L16 56L56 100L74 38L102 88L120 14L138 88L166 38L184 100L224 56L210 140Z" fill="url(#pm-gold)" />
        <path d="M120 14L138 88L166 38L184 100L224 56L210 140H120Z" fill="#7c2d12" opacity="0.16" />
        <path className={styles.crownLine} d="M30 140L16 56L56 100L74 38L102 88L120 14L138 88L166 38L184 100L224 56L210 140" />
        <rect x="26" y="134" width="188" height="34" rx="8" fill="url(#pm-gold-band)" />
        <rect x="30" y="137" width="180" height="5" rx="2.5" fill="#fff7d6" opacity="0.65" />
        <circle cx="16" cy="54" r="8" fill="url(#pm-pearl)" />
        <circle cx="74" cy="36" r="8" fill="url(#pm-pearl)" />
        <circle cx="120" cy="12" r="9" fill="url(#pm-pearl)" />
        <circle cx="166" cy="36" r="8" fill="url(#pm-pearl)" />
        <circle cx="224" cy="54" r="8" fill="url(#pm-pearl)" />
        <path d="M120 92L134 110L120 128L106 110Z" fill="url(#pm-ruby)" />
        <ellipse cx="74" cy="114" rx="9" ry="11" fill="url(#pm-sapphire)" />
        <ellipse cx="166" cy="114" rx="9" ry="11" fill="url(#pm-sapphire)" />
        <circle cx="52" cy="151" r="5" fill="url(#pm-ruby)" />
        <circle cx="86" cy="151" r="5" fill="url(#pm-sapphire)" />
        <circle cx="120" cy="151" r="6" fill="url(#pm-ruby)" />
        <circle cx="154" cy="151" r="5" fill="url(#pm-sapphire)" />
        <circle cx="188" cy="151" r="5" fill="url(#pm-ruby)" />
        <g clipPath="url(#pm-crown-clip)">
          <rect className={styles.crownShine} x="-40" y="0" width="36" height="190" fill="#fffbeb" />
        </g>
        <g className={styles.glints}>
          <circle cx="116" cy="8" r="7" fill="url(#pm-flare)" />
          <circle cx="220" cy="50" r="6" fill="url(#pm-flare)" />
        </g>
      </svg>
      <span className={`${styles.capsule} ${styles.capSpeak}`}><Mic /><span>Speaking</span></span>
      <span className={`${styles.capsule} ${styles.capWrite}`}><PenLine /><span>Writing</span></span>
      <span className={`${styles.capsule} ${styles.capRead}`}><BookOpen /><span>Reading</span></span>
      <span className={`${styles.capsule} ${styles.capCoach}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={echoSrc('official', 24)} alt="" width={18} height={18} />
        <span>Echo Coach</span>
      </span>
    </div>
  );
}

/** A plan card's calendar (decorative): its real duration in months on a glass desk calendar. */
export function PlanCalendar({ months }: { months: number }) {
  return (
    <div className={styles.calendar} aria-hidden="true">
      <span className={styles.calRings}><i /><i /></span>
      <span className={styles.calHead} />
      <span className={styles.calNum}>{months}</span>
      <span className={styles.calUnit}>tháng</span>
    </div>
  );
}
