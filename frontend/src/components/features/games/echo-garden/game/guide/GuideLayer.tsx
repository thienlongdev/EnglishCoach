"use client";

import React, { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { BrandWhaleIcon } from "@/components/common/BrandWhaleIcon";
import { ActionButton, EASE, FOCUS_RING, PANEL } from "../gardenUi";
import { place, type Insets } from "./guideGeometry";
import { STARTER_STEPS } from "./guideScripts";
import type { GardenGuideApi } from "./useGardenGuide";

/*
 * Echo guide — the layer the player sees: the one-time invitation, and while a guide runs the spotlight (a dimmed
 * backdrop with an opening on the REAL target), the arrow and Echo's bubble.
 *
 * The opening is not an element: a tap inside it reaches the real control or the real scene. Around it four panes take
 * the taps that would land elsewhere (never on a "free" step, where the player pans and zooms as usual). Positions are
 * written straight to the elements from one animation-frame loop that exists only while a guide runs — no React state
 * per frame, nothing left behind when the guide ends, no request of any kind.
 */

const STYLE = `
@keyframes eg-guide-in{from{opacity:0}to{opacity:1}}
@keyframes eg-guide-pulse{0%,100%{opacity:.55;transform:scale(1)}50%{opacity:1;transform:scale(1.035)}}
@keyframes eg-guide-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(7px)}}
@keyframes eg-guide-float{0%,100%{transform:translateY(0) rotate(-2deg)}50%{transform:translateY(-3px) rotate(2deg)}}
.eg-guide{animation:eg-guide-in 220ms ease-out}
.eg-guide-halo{animation:eg-guide-pulse 1.9s ease-in-out infinite}
.eg-guide-arrow-in{animation:eg-guide-bob 1.1s ease-in-out infinite}
.eg-guide-whale{animation:eg-guide-float 3.4s ease-in-out infinite}
@media (prefers-reduced-motion: reduce){.eg-guide,.eg-guide-halo,.eg-guide-arrow-in,.eg-guide-whale{animation:none}}
`;

const DIM = "rgba(7,10,32,0.58)";

/** The device's safe-area insets, read once from a probe (CSS `env()` cannot be read from script directly). */
function readInsets(probe: HTMLElement | null): Insets {
  if (!probe) return { top: 0, right: 0, bottom: 0, left: 0 };
  const cs = window.getComputedStyle(probe);
  const px = (v: string) => Number.parseFloat(v) || 0;
  return { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
}

export function GuideLayer({ guide }: { guide: GardenGuideApi }) {
  if (guide.invite) return <GuideInvite guide={guide} />;
  if (!guide.run) return null;
  return <Spotlight guide={guide} />;
}

// ------------------------------------------------------------------ the one-time invitation

function GuideInvite({ guide }: { guide: GardenGuideApi }) {
  const card = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLDivElement>(null);
  const { inviteShown, declineInvite } = guide;
  // the invitation counts as offered only once it is really on a visible screen
  useEffect(() => {
    const report = () => {
      if (document.visibilityState === "visible" && card.current && card.current.getClientRects().length > 0) inviteShown();
    };
    report();
    document.addEventListener("visibilitychange", report);
    primary.current?.querySelector("button")?.focus({ preventScroll: true });
    return () => document.removeEventListener("visibilitychange", report);
  }, [inviteShown]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      declineInvite();
      return;
    }
    if (e.key !== "Tab") return;
    const buttons = card.current?.querySelectorAll<HTMLElement>("button");
    if (!buttons?.length) return;
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="eg-guide fixed inset-0 z-[45] flex items-center justify-center bg-[rgba(7,10,32,0.45)] px-4"
      style={{ paddingTop: "calc(env(safe-area-inset-top,0px) + 1rem)", paddingBottom: "calc(env(safe-area-inset-bottom,0px) + 1rem)" }}
      data-testid="garden-guide-invite" onKeyDown={onKey}>
      <style>{STYLE}</style>
      <div ref={card} role="dialog" aria-modal="true" aria-labelledby="garden-guide-invite-title" aria-describedby="garden-guide-invite-text"
        className={`${PANEL} w-full max-w-[340px] rounded-[26px_22px_28px_24px] p-5 text-center`}>
        <div className="eg-guide-whale mx-auto flex h-16 w-16 items-center justify-center">
          <BrandWhaleIcon variant="clean" size="xl" className="h-16 w-16" priority />
        </div>
        <h2 id="garden-guide-invite-title" className="mt-2 text-lg font-black leading-tight text-[#EEF3FF]">Chào mừng đến Đảo Ký Ức!</h2>
        <p id="garden-guide-invite-text" className="mt-2 text-[13px] leading-relaxed text-[#EEF3FF]/85">
          Xin chào! Mình là Echo. Trên hòn đảo này, bạn vừa có thể học tiếng Anh, vừa xây dựng nông trại của riêng mình. Bạn có muốn mình hướng dẫn một vòng không?
        </p>
        <div ref={primary} className="mt-4 flex flex-col gap-2">
          <ActionButton tone="reward" className="w-full" onClick={guide.acceptInvite} testId="garden-guide-accept">Bắt đầu hướng dẫn</ActionButton>
          <ActionButton tone="quiet" className="w-full" onClick={declineInvite} testId="garden-guide-decline">Để sau</ActionButton>
        </div>
        <p className="mt-3 text-[11px] text-[#EEF3FF]/55">Bạn mở lại bất cứ lúc nào ở nút Hướng dẫn.</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the spotlight

function Spotlight({ guide }: { guide: GardenGuideApi }) {
  const { run, step, text, target, expect, stepKey, resolveTarget, exit } = guide;
  const layer = useRef<HTMLDivElement>(null);
  const panes = useRef<Array<HTMLDivElement | null>>([null, null, null, null]);
  const stopper = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const arrow = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLDivElement>(null);
  /** the target named by the step is not on screen (moved away, covered, or not there yet) */
  const [lost, setLost] = useState(false);

  const free = !!step?.free;
  const dim = step?.dim !== false;
  const waits = expect !== "next" && !run?.farewell;
  // a step that waits for the player's action leaves its opening open; an explanation closes it
  const open = waits || free;
  const hasTarget = target !== null;

  useEffect(() => {
    setLost(false);
    let raf = 0;
    let last = "";
    let gone = 0;
    let flagged = false;
    const insets = readInsets(layer.current);
    const box = (el: HTMLElement | null, x: number, y: number, w: number, h: number) => {
      if (!el) return;
      el.style.transform = `translate3d(${x}px,${y}px,0)`;
      el.style.width = `${Math.max(0, w)}px`;
      el.style.height = `${Math.max(0, h)}px`;
    };
    const frame = (now: number) => {
      raf = window.requestAnimationFrame(frame);
      const b = bubble.current;
      if (!b) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const rect = resolveTarget();
      const p = place(rect, { w: b.offsetWidth, h: b.offsetHeight }, vw, vh, insets);
      // the step names a target that is not on screen: say so after a moment instead of pointing at nothing
      if (!p.hole && hasTarget) {
        if (!gone) gone = now;
        else if (!flagged && now - gone > 1600) {
          flagged = true;
          setLost(true);
        }
      } else {
        gone = 0;
        if (flagged) {
          flagged = false;
          setLost(false);
        }
      }
      // whole pixels: four panes that meet on fractional edges leave a hairline of undimmed scene between them
      const h = p.hole && { x: Math.floor(p.hole.x), y: Math.floor(p.hole.y), w: 0, h: 0 };
      if (h && p.hole) {
        h.w = Math.ceil(p.hole.x + p.hole.w) - h.x;
        h.h = Math.ceil(p.hole.y + p.hole.h) - h.y;
      }
      const key = `${vw}|${vh}|${h ? `${Math.round(h.x)},${Math.round(h.y)},${Math.round(h.w)},${Math.round(h.h)}` : "-"}|${Math.round(p.bubble.x)},${Math.round(p.bubble.y)}|${p.side}`;
      if (key === last) return;
      last = key;
      const [top, bottom, left, right] = panes.current;
      if (h) {
        box(top, 0, 0, vw, h.y);
        box(bottom, 0, h.y + h.h, vw, vh - h.y - h.h);
        box(left, 0, h.y, h.x, h.h);
        box(right, h.x + h.w, h.y, vw - h.x - h.w, h.h);
        box(stopper.current, h.x, h.y, h.w, h.h);
        box(ring.current, h.x, h.y, h.w, h.h);
      } else {
        box(top, 0, 0, vw, vh);
        box(bottom, 0, 0, 0, 0);
        box(left, 0, 0, 0, 0);
        box(right, 0, 0, 0, 0);
        box(stopper.current, 0, 0, 0, 0);
      }
      if (ring.current) ring.current.style.opacity = h ? "1" : "0";
      if (arrow.current) {
        arrow.current.style.opacity = p.arrow ? "1" : "0";
        if (p.arrow) arrow.current.style.transform = `translate3d(${p.arrow.x}px,${p.arrow.y}px,0) rotate(${p.arrow.rot}deg)`;
      }
      b.style.transform = `translate3d(${Math.round(p.bubble.x)}px,${Math.round(p.bubble.y)}px,0)`;
      b.style.visibility = "visible";
    };
    raf = window.requestAnimationFrame(frame);
    return () => window.cancelAnimationFrame(raf);
  }, [stepKey, hasTarget, resolveTarget]);

  // Escape leaves the guide; an explanation hands the keyboard its "Tiếp tục"
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exit]);
  useEffect(() => {
    if (!waits) primary.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }, [stepKey, waits]);

  if (!run) return null;
  const total = run.starter ? STARTER_STEPS : run.topic.steps.length;
  const last = run.index >= run.topic.steps.length - 1;
  const pane = `absolute left-0 top-0 ${free ? "pointer-events-none" : "pointer-events-auto"}`;
  const paneStyle: React.CSSProperties = { background: dim ? DIM : "transparent", willChange: "transform" };
  const swallow = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div ref={layer} className="eg-guide pointer-events-none fixed inset-0 z-[45] overflow-hidden" data-testid="garden-guide"
      data-guide-step={run.farewell ? "farewell" : step?.id} data-guide-topic={run.topic.id} data-guide-wait={waits ? expect : "next"}
      style={{ paddingTop: "env(safe-area-inset-top,0px)", paddingRight: "env(safe-area-inset-right,0px)", paddingBottom: "env(safe-area-inset-bottom,0px)", paddingLeft: "env(safe-area-inset-left,0px)" }}>
      <style>{STYLE}</style>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} ref={(el) => { panes.current[i] = el; }} className={pane} style={paneStyle} aria-hidden
          onPointerDown={swallow} onClick={swallow} onWheel={swallow} data-testid={i === 0 ? "garden-guide-dim" : undefined} />
      ))}
      {/* an explanation keeps its target closed: the player reads, then continues */}
      <div ref={stopper} className={`absolute left-0 top-0 ${open ? "pointer-events-none" : "pointer-events-auto"}`} aria-hidden
        onPointerDown={swallow} onClick={swallow} />
      <div ref={ring} className="pointer-events-none absolute left-0 top-0 rounded-[18px] opacity-0 transition-opacity duration-200" aria-hidden data-testid="garden-guide-ring"
        style={{ boxShadow: "0 0 0 2px #FFD978, 0 0 0 5px rgba(255,217,120,0.28)" }}>
        <div className="eg-guide-halo absolute -inset-1 rounded-[22px]" style={{ boxShadow: "0 0 26px 6px rgba(255,217,120,0.5)" }} />
      </div>
      <div ref={arrow} className="pointer-events-none absolute left-0 top-0 h-0 w-0 opacity-0 transition-opacity duration-200" aria-hidden data-testid="garden-guide-arrow">
        <div className="eg-guide-arrow-in absolute -left-[17px] top-0 h-[38px] w-[34px]">
          <svg viewBox="0 0 34 38" className="h-full w-full drop-shadow-[0_3px_6px_rgba(4,8,24,0.6)]">
            <path d="M17 1.5 31.5 19h-8.2v16.5H10.7V19H2.5z" fill="#FFD978" stroke="#3a2a0a" strokeWidth="2" strokeLinejoin="round" />
          </svg>
        </div>
      </div>
      <div ref={bubble} role="dialog" aria-modal="false" aria-label="Hướng dẫn của Echo" data-testid="garden-guide-bubble"
        className={`pointer-events-auto absolute left-0 top-0 w-[min(336px,calc(100vw-20px))] ${PANEL} rounded-[22px_18px_22px_20px] p-3.5`}
        style={{ visibility: "hidden" }} onPointerDown={swallow} onClick={swallow}>
        <div className="flex items-start gap-3">
          <div className="eg-guide-whale mt-0.5 shrink-0">
            <BrandWhaleIcon variant="clean" size="md" className="h-10 w-10" priority />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="rounded-full border border-[#F4C35A]/30 bg-[#F4C35A]/10 px-2 py-0.5 text-[10px] font-bold text-[#FFD978]" data-testid="garden-guide-progress">
                {run.farewell ? "Hoàn thành" : `Bước ${run.index + 1}/${total}`}
              </span>
              <button type="button" onClick={exit} aria-label="Kết thúc hướng dẫn" title="Kết thúc hướng dẫn" data-testid="garden-guide-close"
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/80 transition-[background-color,transform] duration-200 ${EASE} hover:bg-white/20 active:scale-[0.94] ${FOCUS_RING} cursor-pointer`}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="mt-1.5 text-[13px] leading-relaxed text-[#EEF3FF]" aria-live="polite" data-testid="garden-guide-text">{text}</p>
            {lost && !run.farewell && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-[#FFE7A8]" data-testid="garden-guide-lost">
                Echo chưa thấy mục này trên màn hình của bạn.
                {target?.startsWith("world:") && (
                  <button type="button" onClick={guide.bringIntoView} className={`ml-1 font-bold underline ${FOCUS_RING} cursor-pointer`} data-testid="garden-guide-bring">Đưa đến vị trí</button>
                )}
              </p>
            )}
          </div>
        </div>
        <div ref={primary} className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
          {run.farewell ? (
            <>
              <ActionButton tone="quiet" className="min-h-[38px] px-3 text-xs" onClick={() => guide.finish(true)} testId="garden-guide-more">Khám phá hướng dẫn khác</ActionButton>
              <ActionButton tone="reward" className="min-h-[38px] px-3.5 text-xs" onClick={() => guide.finish(false)} testId="garden-guide-play">Bắt đầu chơi</ActionButton>
            </>
          ) : (
            <>
              {run.index > 0 && <ActionButton tone="quiet" className="min-h-[38px] px-3 text-xs" onClick={guide.back} testId="garden-guide-back">Quay lại</ActionButton>}
              {waits ? (
                <ActionButton tone="quiet" className="min-h-[38px] px-3 text-xs" onClick={guide.advance} testId="garden-guide-skip">Bỏ qua bước này</ActionButton>
              ) : (
                <ActionButton tone="reward" className="min-h-[38px] px-3.5 text-xs" onClick={guide.advance} testId="garden-guide-next">
                  {!run.starter && last ? "Xong" : "Tiếp tục"}
                </ActionButton>
              )}
            </>
          )}
        </div>
        {!run.farewell && (
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="min-w-0 text-[10px] leading-tight text-[#EEF3FF]/50">{waits ? "Echo chờ bạn chạm vào mục đang sáng." : ""}</span>
            <button type="button" onClick={exit} data-testid="garden-guide-exit"
              className={`shrink-0 whitespace-nowrap rounded-lg px-1.5 py-1 text-[11px] font-semibold text-[#EEF3FF]/60 hover:text-[#EEF3FF] ${FOCUS_RING} cursor-pointer`}>
              Kết thúc hướng dẫn
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
