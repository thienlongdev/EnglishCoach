import React from 'react';
import type { CatalogFormDto } from '@/types/exams';
import styles from './examUniverse.module.css';

/*
 * Thi thử — "Echo Exam Universe" (2026-10-24): the shared world of every Exams screen OUTSIDE the active attempt.
 * `UniverseWorld` carries the token class (`.world` + `data-world`), so the existing interior screens take the palette;
 * the rest are decorative pieces (rendered stills, motes, the meridian orbit) — aria-hidden, pointer-free, no request.
 * The attempt route (preflight + runtime) never renders inside it. Art: docs/exams/echo-exam-universe-2026-10-24/art/.
 */

export const ux = styles;
export type UniverseKind = 'nexus' | 'toeic' | 'ielts';

const A = '/assets/exams/';
/** Content-hashed stills (a changed picture ships under a new name). */
const HERO_ART: Record<UniverseKind, [string, string]> = {
  nexus: ['exam-hero-overview-1920-23696227.webp', 'exam-hero-overview-3840-b4fe4c7a.webp'],
  toeic: ['exam-hero-toeic-1920-e3abb7f0.webp', 'exam-hero-toeic-3840-661ae988.webp'],
  ielts: ['exam-hero-ielts-1920-6d916a7e.webp', 'exam-hero-ielts-3840-af0ca9d2.webp'],
};
const CARD_ART: Record<string, [string, string]> = {
  'toeic-lr-night': ['exam-card-toeic-lr-night-640-88970b3b.webp', 'exam-card-toeic-lr-night-1280-df9b74f5.webp'],
  'toeic-lr-dawn': ['exam-card-toeic-lr-dawn-640-8c348acd.webp', 'exam-card-toeic-lr-dawn-1280-d6cc3948.webp'],
  'toeic-lr-dusk': ['exam-card-toeic-lr-dusk-640-a97240a1.webp', 'exam-card-toeic-lr-dusk-1280-d92049e1.webp'],
  'toeic-l': ['exam-card-toeic-l-640-850e73ad.webp', 'exam-card-toeic-l-1280-fe5b0e48.webp'],
  'toeic-r': ['exam-card-toeic-r-640-c172b9c0.webp', 'exam-card-toeic-r-1280-fc3c2796.webp'],
  'ielts-listening': ['exam-card-ielts-listening-640-f84fcf51.webp', 'exam-card-ielts-listening-1280-fc40b715.webp'],
  'ielts-listening-b': ['exam-card-ielts-listening-b-640-2a7c4a10.webp', 'exam-card-ielts-listening-b-1280-482a1f16.webp'],
  'ielts-reading': ['exam-card-ielts-reading-640-a6e52507.webp', 'exam-card-ielts-reading-1280-452f2322.webp'],
  'ielts-reading-b': ['exam-card-ielts-reading-b-640-bde00eb6.webp', 'exam-card-ielts-reading-b-1280-54c4fe13.webp'],
  'ielts-writing': ['exam-card-ielts-writing-640-073f0e6f.webp', 'exam-card-ielts-writing-1280-106b85e9.webp'],
  'ielts-speaking': ['exam-card-ielts-speaking-640-175064ee.webp', 'exam-card-ielts-speaking-1280-ce3aa2a5.webp'],
  'ielts-mixed': ['exam-card-ielts-mixed-640-4b570c9c.webp', 'exam-card-ielts-mixed-1280-d5d4ae4c.webp'],
};

function hashOf(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * The card's world, chosen from the form's OWN runnable skills (never from its source or title): a TOEIC Listening +
 * Reading form shows the whole Meridian, a one-band form only its band lit, an IELTS one-skill form that skill's island,
 * a several-skill form the archipelago. Same-kind forms vary only the time of day (stable per form id).
 */
export function cardArtKey(family: string, skills: string[], id: string): string {
  const s = new Set(skills.map((x) => x.toUpperCase()));
  if (String(family).toUpperCase() === 'TOEIC') {
    if (s.has('LISTENING') && !s.has('READING')) return 'toeic-l';
    if (s.has('READING') && !s.has('LISTENING')) return 'toeic-r';
    return ['toeic-lr-night', 'toeic-lr-dawn', 'toeic-lr-dusk'][hashOf(id) % 3];
  }
  if (s.size === 1) {
    const one = Array.from(s)[0].toLowerCase();
    const base = `ielts-${one}`;
    if (!CARD_ART[base]) return 'ielts-mixed';
    return CARD_ART[`${base}-b`] && hashOf(id) % 2 === 1 ? `${base}-b` : base;
  }
  return 'ielts-mixed';
}

export function CardArt({ artKey, className, eager = false }: { artKey: string; className?: string; eager?: boolean }) {
  const [small, large] = CARD_ART[artKey] || CARD_ART['ielts-mixed'];
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src={A + small}
      srcSet={`${A + small} 640w, ${A + large} 1280w`}
      sizes="(min-width: 1500px) 24vw, (min-width: 900px) 34vw, 100vw"
      alt=""
      aria-hidden
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      draggable={false}
    />
  );
}

export function formArtKey(form: Pick<CatalogFormDto, 'family' | 'id'>, skills: string[]): string {
  return cardArtKey(String(form.family), skills, form.id);
}

/** The world a page belongs to (data-world carries its accent tokens). */
export function UniverseWorld({ world, narrow = false, children }: { world: UniverseKind; narrow?: boolean; children: React.ReactNode }) {
  return (
    <div className={`${styles.world} ${styles.page}`} data-world={world}>
      <div className={`${styles.inner} ${narrow ? styles.narrow : ''}`}>{children}</div>
    </div>
  );
}

const MOTES = [
  { x: '52%', s: '5px', d: '17s', delay: '-2s' },
  { x: '61%', s: '3px', d: '21s', delay: '-9s' },
  { x: '68%', s: '6px', d: '19s', delay: '-5s' },
  { x: '74%', s: '4px', d: '23s', delay: '-14s' },
  { x: '81%', s: '3px', d: '18s', delay: '-11s' },
  { x: '87%', s: '5px', d: '25s', delay: '-3s' },
  { x: '93%', s: '4px', d: '20s', delay: '-16s' },
  { x: '57%', s: '3px', d: '27s', delay: '-20s' },
];

/** The hero's world: rendered panorama (covering the hero, anchored right), shade, water light, rising motes, orbit. */
export function HeroScene({ world }: { world: UniverseKind }) {
  const [small, large] = HERO_ART[world];
  return (
    <>
      <div className={styles.heroArt} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={A + small} srcSet={`${A + small} 1920w, ${A + large} 3840w`} sizes="100vw" alt="" decoding="async" draggable={false} />
      </div>
      <div className={styles.heroShade} aria-hidden />
      {world !== 'ielts' && <div className={styles.heroCaustics} aria-hidden />}
      <svg className={styles.heroOrbit} viewBox="0 0 400 400" fill="none" aria-hidden>
        {world === 'toeic' ? (
          <>
            <circle cx="200" cy="200" r="190" stroke="currentColor" strokeWidth="1" strokeDasharray="2 7" />
            <circle cx="200" cy="200" r="150" stroke="currentColor" strokeWidth="0.8" />
            <ellipse cx="200" cy="200" rx="190" ry="62" stroke="currentColor" strokeWidth="0.8" transform="rotate(-24 200 200)" />
            <ellipse cx="200" cy="200" rx="62" ry="190" stroke="currentColor" strokeWidth="0.8" transform="rotate(-24 200 200)" />
            {Array.from({ length: 7 }).map((_, i) => (
              <circle key={i} cx={200 + 150 * Math.cos((i / 7) * Math.PI * 2)} cy={200 + 150 * Math.sin((i / 7) * Math.PI * 2)} r="3" fill="currentColor" />
            ))}
          </>
        ) : (
          <>
            {[70, 110, 150, 190].map((r, i) => (
              <ellipse key={r} cx="200" cy="200" rx={r} ry={r * 0.42} stroke="currentColor" strokeWidth="0.8" strokeDasharray={i % 2 ? '3 6' : undefined} transform={`rotate(${-18 + i * 9} 200 200)`} />
            ))}
            {[0, 1, 2, 3].map((i) => (
              <circle key={i} cx={200 + (70 + i * 40) * Math.cos(i * 1.7)} cy={200 + (70 + i * 40) * 0.42 * Math.sin(i * 1.7)} r="3.2" fill="currentColor" />
            ))}
          </>
        )}
      </svg>
      <div className={styles.heroMotes} aria-hidden>
        {MOTES.map((m, i) => (
          <i key={i} style={{ '--x': m.x, '--s': m.s, '--d': m.d, '--delay': m.delay } as React.CSSProperties} />
        ))}
      </div>
    </>
  );
}

/**
 * A stage for the result / review / profile screens: the family's world fades in behind the top of the page (decoration
 * only — no number, no claim). No z-index anywhere, so the screen's own fixed dialogs still rise above the workspace.
 */
export function UniverseStage({ world, children }: { world: UniverseKind; children: React.ReactNode }) {
  const [small, large] = HERO_ART[world];
  return (
    <div className={styles.stage}>
      <div className={styles.stageArt} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={A + small} srcSet={`${A + small} 1920w, ${A + large} 3840w`} sizes="100vw" alt="" decoding="async" draggable={false} />
      </div>
      <div className={styles.stageBody}>{children}</div>
    </div>
  );
}

/** Mouse-only light that follows the pointer over a glass object (no state, no request). */
export function lightFollow(e: React.PointerEvent<HTMLElement>) {
  if (e.pointerType !== 'mouse') return;
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  el.style.setProperty('--mx', `${e.clientX - r.left}px`);
  el.style.setProperty('--my', `${e.clientY - r.top}px`);
  el.dataset.lit = '';
}
export function lightRest(e: React.PointerEvent<HTMLElement>) {
  delete e.currentTarget.dataset.lit;
}
