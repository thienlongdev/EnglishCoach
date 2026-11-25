'use client';

import React, { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Crown, GraduationCap, Swords } from 'lucide-react';
import { HallAtmosphere } from './hall/HallAtmosphere';
import { HallTrophy } from './hall/HallTrophy';
import { HALL_BACKDROP_VARS } from './hall/hallArt';
import type { TrophyHandle } from './hall/trophyScene';
import { HALL_TEXT, seasonLabel, TEXT, type Locale } from '@/lib/leaderboard/format';
import styles from './hall/hall.module.css';

export type BoardTab = 'activity' | 'proficiency';

/** Where the active board places its own parts inside the hall (React portals; the hall itself never reloads). */
export interface HallSlots {
  meta: HTMLDivElement | null;
  podium: HTMLDivElement | null;
  aside: HTMLDivElement | null;
}

/**
 * "Echo Hall of Champions" — the stage of "Bảng xếp hạng": the Blender hall (sapphire dawn in the light theme, indigo night
 * in the dark one), light shafts, swaying banners, rising motes, the real-time trophy, and three slots the active board
 * fills (meta chips, podium, "Thành tích của bạn"). The hall makes no request of its own. It is "live" only while on
 * screen and the tab is visible (animations and the trophy pause otherwise); pointer parallax only for a mouse; reduced
 * motion stills everything.
 */
export function LeaderboardHero({
  locale,
  tab,
  onTabChange,
  onSlots,
}: {
  locale: Locale;
  tab: BoardTab;
  onTabChange: (tab: BoardTab) => void;
  onSlots: (slots: HallSlots) => void;
}) {
  const t = TEXT[locale];
  const h = HALL_TEXT[locale];
  const reduceMotion = useReducedMotion();
  const stageRef = useRef<HTMLElement>(null);
  const trophyRef = useRef<TrophyHandle | null>(null);
  const [season, setSeason] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const metaRef = useRef<HTMLDivElement>(null);
  const podiumRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLDivElement>(null);

  useEffect(() => setSeason(seasonLabel(new Date(), locale)), [locale]); // client clock only (no hydration drift)
  useEffect(() => {
    onSlots({ meta: metaRef.current, podium: podiumRef.current, aside: asideRef.current });
  }, [onSlots]);

  // live = on screen AND the tab visible: CSS animations and the trophy loop run only then
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let onScreen = false;
    const update = () => setLive(onScreen && document.visibilityState === 'visible');
    const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; update(); }, { threshold: 0.04 });
    io.observe(el);
    document.addEventListener('visibilitychange', update);
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, []);

  // pointer parallax (mouse only, one write per frame, nothing under reduced motion)
  const frame = useRef(0);
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (reduceMotion || e.pointerType !== 'mouse' || frame.current) return;
    const el = e.currentTarget;
    const { clientX, clientY } = e;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const r = el.getBoundingClientRect();
      const x = ((clientX - r.left) / r.width) * 2 - 1;
      const y = ((clientY - r.top) / r.height) * 2 - 1;
      el.style.setProperty('--px', x.toFixed(3));
      el.style.setProperty('--py', y.toFixed(3));
      trophyRef.current?.setPointer(x, y);
    });
  };
  const onPointerLeave = (e: React.PointerEvent<HTMLElement>) => {
    e.currentTarget.style.setProperty('--px', '0');
    e.currentTarget.style.setProperty('--py', '0');
    trophyRef.current?.setPointer(0, 0);
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const modes: { id: BoardTab; label: string; icon: React.ReactNode }[] = [
    { id: 'activity', label: t.tabActivity, icon: <Swords className="h-4 w-4" aria-hidden="true" /> },
    { id: 'proficiency', label: t.tabProficiency, icon: <GraduationCap className="h-4 w-4" aria-hidden="true" /> },
  ];

  return (
    <section
      ref={stageRef}
      data-testid="leaderboard-hero"
      data-live={live ? 'true' : 'false'}
      data-reduced-motion={reduceMotion ? 'true' : 'false'}
      className={styles.stage}
      style={HALL_BACKDROP_VARS as React.CSSProperties}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      aria-labelledby="hall-title"
    >
      <div className={styles.backdrop} aria-hidden="true" />
      <div className={styles.veil} aria-hidden="true" />
      <HallAtmosphere />

      <div className={styles.hallGrid}>
        <motion.div
          className={styles.intro}
          initial={reduceMotion ? false : { opacity: 0, y: 14 }}
          animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
          transition={reduceMotion ? undefined : { duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
        >
          <span className={styles.season} data-testid="hero-season">
            <Crown className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{season ?? ' '}</span>
          </span>
          <div>
            <h1 id="hall-title" className={styles.title}><span className={styles.titleGold}>{t.title}</span></h1>
            <p className={styles.hallName}>{h.hallName}</p>
          </div>
          <p className={styles.lead}>{h.lead}</p>
          <div ref={metaRef} className={styles.meta} data-testid="hall-meta" />
          <div role="tablist" aria-label={h.modeLabel} className={styles.modeSwitch} data-testid="hall-modes">
            {modes.map((m) => {
              const selected = tab === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={styles.modeBtn}
                  onClick={() => onTabChange(m.id)}
                >
                  {selected && (reduceMotion
                    ? <span aria-hidden="true" className={styles.modePill} />
                    : <motion.span aria-hidden="true" layoutId="hall-mode-pill" className={styles.modePill} transition={{ type: 'spring', stiffness: 420, damping: 34 }} />)}
                  {m.icon}
                  {m.label}
                </button>
              );
            })}
          </div>
        </motion.div>

        <div className={styles.centre}>
          <HallTrophy live={live} handleRef={trophyRef} />
          <div ref={podiumRef} className={styles.podiumSlot} />
        </div>

        <div ref={asideRef} className={styles.asideSlot} />
      </div>
    </section>
  );
}
