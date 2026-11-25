"use client";

import React, { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { createPortal } from "react-dom";
import { useLanguage } from "@/context/LanguageContext";
import { vfxReduced } from "@/lib/vfx/quality";
import { celebrateInWorld } from "@/lib/vfx/events";
import pulse from "./tides/memoryPulse.module.css";

// the existing ephemeral VFX burst (disposed after ~4 s); loaded only when a session really ended with stored ratings
const Burst = dynamic(() => import("@/components/vfx/BurstCanvas"), { ssr: false });
import { RATING_COPY, type RecallQuality } from "./RecallControls";
import type { SessionTally } from "./StudyCompanion";

interface CaughtUpViewProps {
  /** Ratings saved in this study session. */
  tally: SessionTally;
  /** Cards of this deck that are still due (cards rated Khó stay due today). */
  remainingDue: number;
  onBackToLibrary: () => void;
  /** Start another pass over the cards that are still due. */
  onReviewRemaining?: () => void;
  onCramMode?: () => void;
  /** Cards that became "Đã thuộc" in this session (status read from the server's answers). */
  newlyMastered?: number;
  /** The stored ratings of this session, in order (drawn as the tide line). */
  trail?: RecallQuality[];
}

const TIDE_MAX = 60;
const TIDE_Y: Record<RecallQuality, number> = { hard: 96, good: 62, easy: 26 };

/**
 * The tide line of a pass: one point per STORED rating, in order (Khó a trough, Tốt a swell, Dễ a crest carrying a pearl),
 * joined by a smooth curve that draws itself once. Only this session's real ratings; nothing is sent or stored.
 */
function TideLine({ trail, vi }: { trail: RecallQuality[]; vi: boolean }) {
  const shown = trail.slice(-TIDE_MAX);
  const n = shown.length;
  const W = 600, pad = 22;
  const pts = shown.map((q, i) => ({ q, x: n === 1 ? W / 2 : pad + (i * (W - pad * 2)) / (n - 1), y: TIDE_Y[q] }));
  // Catmull-Rom through the points (a single point is a short flat swell)
  let d = n === 1 ? `M${pts[0].x - 40} ${pts[0].y} L${pts[0].x + 40} ${pts[0].y}` : `M${pts[0].x} ${pts[0].y}`;
  for (let i = 0; n > 1 && i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  const count = (q: RecallQuality) => shown.filter((x) => x === q).length;
  const label = vi
    ? `Đường thủy triều của lượt này: ${count("easy")} Dễ, ${count("good")} Trung Bình, ${count("hard")} Khó, theo thứ tự bạn đánh giá.`
    : `This pass as a tide line: ${count("easy")} Easy, ${count("good")} Medium, ${count("hard")} Hard, in the order you rated.`;
  return (
    <figure className={pulse.tide}>
      <svg viewBox={`0 0 ${W} 122`} role="img" aria-label={label} className={pulse.tideSvg}>
        <defs>
          <linearGradient id="ec-tide-stroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#38bdf8" />
            <stop offset="0.55" stopColor="#6366f1" />
            <stop offset="1" stopColor="#2dd4bf" />
          </linearGradient>
          <linearGradient id="ec-tide-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#6366f1" stopOpacity="0.22" />
            <stop offset="1" stopColor="#38bdf8" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1={pad} x2={W - pad} y1={TIDE_Y.good} y2={TIDE_Y.good} className={pulse.tideMean} />
        <path d={`${d} L${pts[n - 1].x + (n === 1 ? 40 : 0)} 122 L${pts[0].x - (n === 1 ? 40 : 0)} 122 Z`} fill="url(#ec-tide-fill)" className={pulse.tideFill} />
        <path d={d} className={pulse.tideLine} pathLength={1} />
        {pts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={p.q === "easy" ? 5.5 : p.q === "hard" ? 3.4 : 2.6}
            className={pulse.tidePoint} data-q={p.q} style={{ "--t": `${n === 1 ? 0.5 : i / (n - 1)}` } as React.CSSProperties} />
        ))}
      </svg>
      <figcaption className={pulse.tideCaption}>
        {vi ? "Đường thủy triều của lượt này" : "This pass as a tide line"}
        {trail.length > TIDE_MAX ? (vi ? ` · ${TIDE_MAX} lượt gần nhất` : ` · last ${TIDE_MAX} ratings`) : ""}
        <span className={pulse.tideKey} aria-hidden="true">
          <i data-q="easy" />{vi ? "Dễ" : "Easy"}<i data-q="good" />{vi ? "Trung Bình" : "Medium"}<i data-q="hard" />{vi ? "Khó" : "Hard"}
        </span>
      </figcaption>
    </figure>
  );
}

/** End of a pass. Shows only what happened on this screen and what the server still lists as due — no invented scores. */
export function CaughtUpView({ tally, remainingDue, onBackToLibrary, onReviewRemaining, onCramMode, newlyMastered = 0, trail = [] }: CaughtUpViewProps) {
  const { t, locale } = useLanguage();
  const vi = locale === "vi";
  const reviewed = tally.hard + tally.good + tally.easy;
  const allDone = remainingDue === 0;
  // Echo Ocean completion: only after a session with stored ratings; a visible living world takes it first, else one
  // short burst; never under reduced motion or in a hidden tab. Nothing here is a learning event.
  const [burst, setBurst] = useState(0);
  useEffect(() => {
    if (reviewed === 0 || vfxReduced() || document.hidden) return;
    if (!celebrateInWorld()) setBurst(Date.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!burst) return;
    const timer = window.setTimeout(() => setBurst(0), 4200);
    return () => window.clearTimeout(timer);
  }, [burst]);

  return (
    <div className={`mx-auto w-full max-w-3xl ${pulse.completion}`}>
      <div className="relative overflow-hidden rounded-[28px] border border-slate-200 bg-gradient-to-br from-white via-indigo-50/60 to-cyan-50/70 p-7 shadow-xl dark:border-slate-800 dark:from-slate-900 dark:via-indigo-950/40 dark:to-slate-900 sm:p-10">
        <div className="absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-indigo-600 via-blue-500 to-cyan-500" aria-hidden="true" />
        {reviewed > 0 && (
          // Echo Memory Tides completion of a pass with stored ratings: a slow water resonance behind the tide line
          <div className={pulse.resonance} aria-hidden="true">
            {[0, 1, 2].map((i) => <span key={`w${i}`} className={pulse.wave2} style={{ "--i": i } as React.CSSProperties} />)}
          </div>
        )}
        {/* the burst is a full-window layer: rendered into <body>, never inside this (animated, so transformed) card */}
        {burst ? createPortal(<Burst key={burst} />, document.body) : null}
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-4xl">
          {allDone ? t.caughtUpTitle : (vi ? "Bạn đã đi hết một lượt" : "You finished a pass")}
        </h1>
        <p className="mt-2 max-w-xl text-base leading-relaxed text-slate-600 dark:text-slate-300">
          {allDone
            ? t.caughtUpDesc
            : (vi
              ? `Còn ${remainingDue} thẻ vẫn đến hạn hôm nay (những thẻ bạn chọn Khó). Ôn lại ngay để nhớ chắc hơn.`
              : `${remainingDue} card${remainingDue > 1 ? "s are" : " is"} still due today (the ones rated Hard). Go over them again to make them stick.`)}
        </p>

        {reviewed > 0 && (
          <p className="mt-5 text-sm font-semibold text-slate-600 dark:text-slate-300">
            {vi ? `Bạn đã đánh giá ${reviewed} thẻ trong lượt này` : `You rated ${reviewed} card${reviewed > 1 ? "s" : ""} in this session`}
            {newlyMastered > 0 ? (vi ? ` · ${newlyMastered} thẻ vừa chuyển sang “Đã thuộc”.` : ` · ${newlyMastered} newly mastered.`) : "."}
          </p>
        )}
        {trail.length > 0 && <TideLine trail={trail} vi={vi} />}
        {reviewed > 0 && (
          <div className="mt-4 grid grid-cols-3 gap-3">
            {(["easy", "good", "hard"] as const).map((q) => (
              <div key={q} className="rounded-2xl border border-slate-200/80 bg-white/80 p-4 dark:border-slate-700/60 dark:bg-slate-800/50">
                <div className="text-2xl font-bold tabular-nums text-slate-900 dark:text-white">{tally[q]}</div>
                <div className="text-sm font-bold text-slate-600 dark:text-slate-300">{RATING_COPY[q][vi ? "vi" : "en"].name}</div>
                <div className="mt-0.5 text-xs font-semibold text-slate-500 dark:text-slate-400">{RATING_COPY[q][vi ? "vi" : "en"].effect}</div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-8 flex flex-col gap-3 border-t border-slate-200/80 pt-6 dark:border-slate-700/60 sm:flex-row sm:flex-wrap sm:items-center">
          {!allDone && onReviewRemaining && (
            <button
              type="button"
              onClick={onReviewRemaining}
              className="min-h-[2.75rem] rounded-xl bg-indigo-600 px-6 text-sm font-bold text-white shadow-md transition hover:bg-indigo-700"
            >
              {vi ? `Ôn lại ${remainingDue} thẻ còn đến hạn` : `Review the ${remainingDue} due card${remainingDue > 1 ? "s" : ""}`}
            </button>
          )}
          <button
            type="button"
            onClick={onBackToLibrary}
            className={`min-h-[2.75rem] rounded-xl px-6 text-sm font-bold transition ${allDone ? "bg-indigo-600 text-white shadow-md hover:bg-indigo-700" : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"}`}
          >
            {t.backToLibrary}
          </button>
          {onCramMode && (
            <button
              type="button"
              onClick={onCramMode}
              className="min-h-[2.75rem] rounded-xl px-4 text-sm font-bold text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 sm:ml-auto"
            >
              {t.cramMode}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
