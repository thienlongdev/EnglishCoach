"use client";

import React, { useMemo } from "react";
import type { RecallQuality } from "../RecallControls";
import { deviceVfxTier, vfxPreference } from "@/lib/vfx/quality";
import type { FxGeometry } from "./studyTimeline";
import styles from "./memoryPulse.module.css";

/**
 * Echo Memory Tides — the effect of a STORED rating (owner brief 2026-11-12, art direction revised in the release-candidate
 * pass). The study stage has a waterline at the card's lower edge; every rating starts at the real pressed button, reaches
 * the card, and leaves the way the schedule really treats the card (the card's own motion is in flashcardStudy.module.css):
 *   Khó — Undertow: coral ink blooms from the button and is drawn down to the waterline; the card sinks through it, the
 *         waterline ripples and a few bubbles rise — the memory will resurface this session. Never a shake or a red flash.
 *   Tốt — Drift: a ring at the button, an indigo current drawn across the card, two afterimages of the card carried away
 *         on it with fast streaks of water — back in three days.
 *   Dễ  — Pearl: motes spiral from the button into the card's centre, a nacre halo closes with the card, one pearl forms
 *         where it closed and rises to the progress line, which answers with a soft flare — mastered.
 * DOM + SVG + CSS (transform / opacity / stroke-dashoffset), no canvas, no loop, no own timer; FlashcardUI's timeline
 * removes it (`TIMELINE.fxLife`). The "Nhẹ" VFX tier draws fewer pieces; reduced motion draws one still confirmation.
 */
export interface RatingFxEvent {
  id: number;
  quality: RecallQuality;
  geometry: FxGeometry;
  reduced: boolean;
}

function lightTier(): boolean {
  if (typeof window === "undefined") return true;
  const pref = vfxPreference();
  return (pref === "auto" ? deviceVfxTier() : pref) === "low";
}

const px = (n: number) => `${n}px`;

/** A travelling-wave path across the card (Tốt's current): a few soft periods, wider than the card on both sides. */
function currentPath(x0: number, x1: number, y: number, amp: number, periods: number): string {
  const w = x1 - x0;
  const seg = w / (periods * 2);
  let d = `M${Math.round(x0)} ${Math.round(y)}`;
  for (let i = 0; i < periods * 2; i++) {
    const xs = x0 + i * seg;
    const dir = i % 2 === 0 ? -1 : 1;
    d += ` Q ${Math.round(xs + seg / 2)} ${Math.round(y + dir * amp)} ${Math.round(xs + seg)} ${Math.round(y)}`;
  }
  return d;
}

export function RatingFx({ event }: { event: RatingFxEvent }) {
  const light = useMemo(lightTier, []);
  const { quality, geometry: g, reduced } = event;
  const centre = { x: Math.round(g.card.x + g.card.w / 2), y: Math.round(g.card.y + g.card.h * 0.45) };
  const water = g.card.y + g.card.h;
  const vars = {
    "--ox": px(g.origin.x), "--oy": px(g.origin.y),
    "--cx": px(g.card.x), "--cy": px(g.card.y), "--cw": px(g.card.w), "--ch": px(g.card.h),
    "--mx": px(centre.x), "--my": px(centre.y), "--wl": px(water),
    // origin → card centre (Tốt's ring echo, Dễ's motes) and card centre → progress line (Dễ's pearl)
    "--wx": px(centre.x - g.origin.x), "--wy": px(centre.y - g.origin.y),
    "--tx": px(g.target.x - centre.x), "--ty": px(g.target.y - centre.y),
    "--gx": px(g.target.x), "--gy": px(g.target.y),
  } as React.CSSProperties;

  if (reduced) {
    return (
      <div className={styles.fx} data-quality={quality} data-reduced="true" style={vars} aria-hidden="true">
        <span className={styles.edge} />
        <span className={styles.still} />
      </div>
    );
  }

  const count = quality === "hard" ? (light ? 3 : 5) : quality === "easy" ? (light ? 5 : 10) : (light ? 2 : 4);
  // Khó: bubbles rise from the waterline across the card's width; Tốt: streaks at different heights; Dễ: motes start
  // on a small ring around the pressed button and spiral into the card's centre
  const pieces = Array.from({ length: count }, (_, i) => {
    const f = (i + 0.5) / count;
    if (quality === "hard") {
      return { "--i": i, "--bx": px(Math.round(g.card.x + g.card.w * (0.18 + f * 0.64) + ((i * 37) % 11) - 5)), "--rise": px(-(38 + ((i * 53) % 34))) } as React.CSSProperties;
    }
    if (quality === "good") {
      return { "--i": i, "--sy": px(Math.round(g.card.y + g.card.h * (0.22 + f * 0.6))), "--sl": px(Math.round(g.card.w * (0.28 + ((i * 29) % 20) / 100))) } as React.CSSProperties;
    }
    const a = (i / count) * Math.PI * 2;
    return { "--i": i, "--sx": px(Math.round(Math.cos(a) * 34)), "--sy": px(Math.round(Math.sin(a) * 34)) } as React.CSSProperties;
  });

  return (
    <div className={styles.fx} data-quality={quality} data-light={light ? "true" : "false"} style={vars} aria-hidden="true">
      <svg className={styles.svg} width="100%" height="100%">
        {quality === "hard" && (
          <line className={styles.trace} x1={g.origin.x} y1={g.origin.y} x2={g.edge.x} y2={water} pathLength={1} />
        )}
        {quality === "good" && (
          <path className={styles.current} pathLength={1}
            d={currentPath(g.card.x - 24, g.card.x + g.card.w + 72, centre.y + g.card.h * 0.08, Math.max(6, g.card.h * 0.025), 3)} />
        )}
        {quality === "easy" && (
          <path className={styles.path} pathLength={1}
            d={`M${Math.round(centre.x)} ${Math.round(centre.y)} Q ${Math.round(centre.x + (g.target.x - centre.x) * 0.2 + 36)} ${Math.round((centre.y + g.target.y) / 2)} ${g.target.x} ${g.target.y}`} />
        )}
      </svg>
      <span className={styles.edge} />
      {quality === "hard" && (
        <>
          <span className={styles.ink} />
          <span className={`${styles.ink} ${styles.ink2}`} />
          <span className={styles.waterline} />
          <span className={styles.ripple} />
          <span className={`${styles.ripple} ${styles.ripple2}`} />
          {pieces.map((s, i) => <span key={i} className={styles.bubble} style={s} />)}
        </>
      )}
      {quality === "good" && (
        <>
          <span className={styles.ring} />
          <span className={`${styles.ring} ${styles.ring2}`} />
          <span className={styles.ghost} />
          <span className={`${styles.ghost} ${styles.ghost2}`} />
          {pieces.map((s, i) => <span key={i} className={styles.streak} style={s} />)}
        </>
      )}
      {quality === "easy" && (
        <>
          <span className={styles.ring} />
          {pieces.map((s, i) => <span key={i} className={styles.mote} style={s} />)}
          <span className={styles.nacre} />
          <span className={styles.pearl} />
          <span className={styles.flare} />
        </>
      )}
    </div>
  );
}
