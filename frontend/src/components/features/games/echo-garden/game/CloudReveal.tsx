"use client";

import React, { useEffect, useRef, useState } from "react";
import type { TimeOfDay } from "../EchoGardenCanvas";
import { WORLD_BASE } from "../world/worldData";
import { REVEAL_GIVE_UP_MS, REVEAL_MS, REVEAL_SKIP_MS, REVEAL_SLOW_MS, type RevealPhase } from "./entryReveal";
import { EASE, FOCUS_RING, PANEL } from "./gardenUi";

/*
 * The cloud reveal of a game entry (state machine: game/entryReveal.ts). A screen-space layer ABOVE the real scene:
 * the island being loaded and drawn underneath is the player's own, so what the parting clouds uncover is never a
 * stand-in picture. It is made of the game's own cumulus billows (the same files the sky layers draw) moved by
 * compositor transforms only — no canvas work, no ticker, no texture of its own — and it is removed from the page
 * when it is over. It takes every tap that lands on it, so skipping can never reach a bed or a button below.
 */

interface CloudSpec {
  /** billow art (0–5), centre in % of the viewport, width in vmax, which side it leaves by, order of leaving */
  art: number;
  x: number;
  y: number;
  size: number;
  side: -1 | 1;
  rank: number;
  flip?: boolean;
}

/** Two banks meeting in the middle: the middle clouds leave first, so the island appears from its centre outward. */
const CLOUDS: CloudSpec[] = [
  { art: 4, x: 36, y: 50, size: 62, side: -1, rank: 0 },
  { art: 0, x: 64, y: 52, size: 60, side: 1, rank: 0, flip: true },
  { art: 2, x: 30, y: 24, size: 58, side: -1, rank: 1 },
  { art: 4, x: 70, y: 26, size: 56, side: 1, rank: 1, flip: true },
  { art: 1, x: 32, y: 78, size: 54, side: -1, rank: 1, flip: true },
  { art: 5, x: 69, y: 79, size: 58, side: 1, rank: 1 },
  { art: 3, x: 12, y: 40, size: 50, side: -1, rank: 2 },
  { art: 1, x: 88, y: 42, size: 50, side: 1, rank: 2 },
  { art: 0, x: 10, y: 8, size: 52, side: -1, rank: 2, flip: true },
  { art: 2, x: 90, y: 9, size: 54, side: 1, rank: 2 },
  { art: 5, x: 8, y: 92, size: 56, side: -1, rank: 2 },
  { art: 3, x: 92, y: 94, size: 52, side: 1, rank: 2, flip: true },
  { art: 4, x: 50, y: 6, size: 48, side: -1, rank: 1 },
  { art: 0, x: 50, y: 96, size: 50, side: 1, rank: 1 },
];

/** Sky behind the clouds and how the billows are lit, per time of day (the scene's own sky stops, world/lighting.ts). */
const LOOK: Record<TimeOfDay, { sky: string; glow: string; cloud: string }> = {
  day: { sky: "linear-gradient(180deg,#5c9fe3 0%,#8fc3ee 45%,#c6e2f2 100%)", glow: "rgba(255,246,214,0.9)", cloud: "none" },
  sunset: { sky: "linear-gradient(180deg,#584a8f 0%,#a8668f 50%,#e58a74 100%)", glow: "rgba(255,196,140,0.85)", cloud: "sepia(0.45) saturate(1.5) hue-rotate(-18deg) brightness(0.95)" },
  night: { sky: "linear-gradient(180deg,#0b1634 0%,#162755 55%,#25386c 100%)", glow: "rgba(150,176,255,0.55)", cloud: "brightness(0.5) saturate(0.7) hue-rotate(195deg)" },
};

const STYLE = `
@keyframes eg-reveal-in{from{opacity:0}to{opacity:1}}
@keyframes eg-reveal-drift{0%,100%{transform:translate3d(-0.6vmax,0,0)}50%{transform:translate3d(0.6vmax,-0.25vmax,0)}}
@keyframes eg-reveal-glow{0%{opacity:.35;transform:translate(-50%,-50%) scale(.7)}35%{opacity:.95}100%{opacity:0;transform:translate(-50%,-50%) scale(2.1)}}
.eg-reveal{animation:eg-reveal-in 220ms ease-out}
.eg-reveal-sky{transition:opacity 560ms ease-out 60ms}
.eg-reveal[data-phase="opening"] .eg-reveal-sky{opacity:0}
.eg-reveal-glow{opacity:.35;transform:translate(-50%,-50%) scale(.7)}
.eg-reveal[data-phase="opening"] .eg-reveal-glow{animation:eg-reveal-glow ${REVEAL_MS}ms ease-in-out both}
.eg-reveal-cloud{transition:transform ${REVEAL_MS - 180}ms cubic-bezier(.5,.04,.24,1) var(--eg-delay),opacity 460ms ease-in calc(var(--eg-delay) + ${REVEAL_MS - 700}ms);will-change:transform,opacity}
.eg-reveal[data-phase="opening"] .eg-reveal-cloud{transform:translate3d(var(--eg-travel),var(--eg-lift),0) scale(1.14);opacity:0}
.eg-reveal-cloud>img{animation:eg-reveal-drift var(--eg-drift) ease-in-out infinite}
.eg-reveal[data-fast="true"]{transition:opacity ${REVEAL_SKIP_MS}ms ease-out;opacity:0}
`;

export function CloudReveal({ phase, timeOfDay, onOpened, onSkip, onGiveUp }: {
  phase: RevealPhase;
  timeOfDay: TimeOfDay;
  onOpened: () => void;
  onSkip: () => void;
  /** the island is still not drawn after a long wait: the clouds step back for the scene's own loading picture */
  onGiveUp: () => void;
}) {
  const [slow, setSlow] = useState(false);
  const [fast, setFast] = useState(false);
  const opened = useRef(onOpened);
  opened.current = onOpened;
  const skipped = useRef(onSkip);
  skipped.current = onSkip;
  const gaveUp = useRef(onGiveUp);
  gaveUp.current = onGiveUp;

  // honest feedback: a long load says so (the clouds never pretend to be an animation that is still running)
  useEffect(() => {
    if (phase !== "covered") return;
    const id = window.setTimeout(() => setSlow(true), REVEAL_SLOW_MS);
    const end = window.setTimeout(() => gaveUp.current(), REVEAL_GIVE_UP_MS);
    return () => {
      window.clearTimeout(id);
      window.clearTimeout(end);
    };
  }, [phase]);

  // the parting ends by the clock of the transition itself; a skip fades what is left at once
  useEffect(() => {
    if (phase !== "opening") return;
    const id = window.setTimeout(() => (fast ? skipped.current() : opened.current()), fast ? REVEAL_SKIP_MS : REVEAL_MS + 60);
    return () => window.clearTimeout(id);
  }, [phase, fast]);

  // Enter, Space and Escape skip too (the layer is not focusable itself: the game keeps its focus)
  useEffect(() => {
    if (phase !== "opening") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") setFast(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase]);

  if (phase !== "covered" && phase !== "opening") return null;
  const look = LOOK[timeOfDay];
  const swallow = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  return (
    <div
      className="eg-reveal absolute inset-0 z-[60] touch-none select-none overflow-hidden"
      data-testid="garden-cloud-reveal"
      data-phase={phase}
      data-fast={fast}
      onPointerDown={(e) => {
        swallow(e);
        if (phase === "opening") setFast(true);
      }}
      onPointerUp={swallow}
      onClick={swallow}
      onWheel={(e) => e.stopPropagation()}
    >
      <style>{STYLE}</style>
      <div className="eg-reveal-sky absolute inset-0" style={{ background: look.sky }} aria-hidden />
      <div className="eg-reveal-glow pointer-events-none absolute left-1/2 top-[46%] h-[70vmax] w-[70vmax] rounded-full" aria-hidden
        style={{ background: `radial-gradient(closest-side, ${look.glow}, rgba(255,255,255,0) 72%)` }} />
      {CLOUDS.map((c, i) => (
        <div
          key={i}
          aria-hidden
          className="eg-reveal-cloud pointer-events-none absolute"
          style={{
            left: `${c.x}%`,
            top: `${c.y}%`,
            width: `${c.size}vmax`,
            marginLeft: `${-c.size / 2}vmax`,
            marginTop: `${-c.size * 0.22}vmax`,
            filter: look.cloud,
            ["--eg-travel" as string]: `${c.side * (62 + c.rank * 14)}vmax`,
            ["--eg-lift" as string]: `${(i % 3 - 1) * 2.2}vmax`,
            ["--eg-delay" as string]: `${c.rank * 70}ms`,
            ["--eg-drift" as string]: `${9 + (i % 5) * 1.7}s`,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${WORLD_BASE}billow_${c.art}.webp`} alt="" draggable={false} decoding="async"
            className="block h-auto w-full" style={c.flip ? { scale: "-1 1" } : undefined} />
        </div>
      ))}
      {phase === "covered" && (
        <p role="status" aria-live="polite" data-testid="garden-cloud-status"
          className="absolute inset-x-0 top-1/2 -translate-y-1/2 px-6 text-center text-sm font-bold text-[#1F2257] drop-shadow-[0_1px_0_rgba(255,255,255,0.7)]"
          style={timeOfDay === "night" ? { color: "#EEF3FF", filter: "none" } : undefined}>
          {slow ? "Mạng đang chậm, Đảo Ký Ức vẫn đang được tải…" : "Đang mở Đảo Ký Ức…"}
        </p>
      )}
      {phase === "opening" && !fast && (
        <button
          type="button"
          data-testid="garden-cloud-skip"
          onClick={(e) => {
            swallow(e);
            setFast(true);
          }}
          className={`${PANEL} pointer-events-auto absolute bottom-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] left-1/2 min-h-[44px] -translate-x-1/2 rounded-full px-5 text-xs font-bold text-[#EEF3FF] transition-transform duration-200 ${EASE} active:scale-[0.96] ${FOCUS_RING} cursor-pointer`}
        >
          Bỏ qua
        </button>
      )}
    </div>
  );
}
