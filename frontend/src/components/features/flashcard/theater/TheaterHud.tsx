"use client";

import React, { useId, useState } from "react";
import { BookOpen, Brain, ChevronRight, Lightbulb, X } from "lucide-react";
import { echoSrc } from "@/lib/brand/echoCharacters";
import { RATING_COPY, type RecallQuality } from "../RecallControls";
import { buildTimelineLayout, STRAND_PATH, TIMELINE_VIEW_H, TIMELINE_VIEW_W } from "./passTimeline";
import s from "./theater.module.css";

/* ───────────────────────────── Memory Current: the pass as a luminous strand ───────────────────────────── */

/**
 * The study pass drawn as one continuous current of light (reforged 2026-11-20).
 *
 * Uses exact horizontal percentage clipping (`--cur-t`) instead of SVG `stroke-dasharray` + `pathLength`
 * + `non-scaling-stroke`, eliminating Blink's non-uniform dash scaling and phantom end-segments.
 * The lit strand always terminates at the exact center of the active node at every viewport width.
 * Session progress only: deck mastery lives separately in `MasteryHalo`.
 */
export function MemoryCurrent({
  total,
  done,
  marks,
  vi,
}: {
  total: number;
  done: number;
  marks: Array<RecallQuality | null>;
  vi: boolean;
}) {
  const gradId = useId();
  const layout = buildTimelineLayout(total, done, marks);
  const { count, nodes, activeT } = layout;
  const safeDone = Math.min(layout.done, count);

  return (
    <div
      className={s.current}
      role="progressbar"
      aria-label={vi ? "Tiến độ lượt ôn" : "Review progress"}
      aria-valuemin={0}
      aria-valuemax={count}
      aria-valuenow={safeDone}
      aria-valuetext={
        vi
          ? `Đã ôn ${safeDone} trên ${count} thẻ của lượt này`
          : `${safeDone} of ${count} cards reviewed in this pass`
      }
      data-active-t={activeT.toFixed(4)}
      data-shown-nodes={layout.shown}
    >
      <svg
        className={s.strand}
        viewBox={`0 0 ${TIMELINE_VIEW_W} ${TIMELINE_VIEW_H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path className={s.strandBase} d={STRAND_PATH} vectorEffect="non-scaling-stroke" />
      </svg>

      <div
        className={s.strandLitClip}
        style={{ ["--cur-t" as string]: activeT.toFixed(5) }}
        aria-hidden="true"
      >
        <svg
          className={s.strand}
          viewBox={`0 0 ${TIMELINE_VIEW_W} ${TIMELINE_VIEW_H}`}
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="var(--th-strand-a)" />
              <stop offset="55%" stopColor="var(--th-strand-b)" />
              <stop offset="100%" stopColor="var(--th-strand-c)" />
            </linearGradient>
          </defs>
          <path
            className={s.strandLit}
            d={STRAND_PATH}
            stroke={`url(#${gradId})`}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>

      <ol className={s.nodes} aria-hidden="true">
        {nodes.map((n) => (
          <li
            key={n.slot}
            className={s.node}
            data-state={n.state}
            data-q={n.mark ?? undefined}
            data-fx-target={n.state === "active" ? "" : undefined}
            style={{
              left: `${(n.t * 100).toFixed(4)}%`,
              top: `${n.yPct.toFixed(4)}%`,
            }}
          />
        ))}
      </ol>
    </div>
  );
}

/* ───────────────────────────── Deck mastery halo (long-term, server numbers) ───────────────────────────── */

export function masteryPercent(mastered: number, total: number, vi: boolean): string {
  if (total <= 0) return "0%";
  const p = (Math.min(mastered, total) / total) * 100;
  if (p > 0 && p < 1) return `${p.toFixed(1).replace(".", vi ? "," : ".")}%`;
  return `${Math.round(p)}%`;
}

export function MasteryHalo({
  mastered,
  total,
  vi,
  compact = false,
}: {
  mastered: number;
  total: number;
  vi: boolean;
  compact?: boolean;
}) {
  const safeTotal = Math.max(0, total);
  const m = Math.min(Math.max(0, mastered), safeTotal);
  const ratio = safeTotal > 0 ? m / safeTotal : 0;
  const label = vi
    ? `Đã thuộc ${m.toLocaleString("vi-VN")} trên ${safeTotal.toLocaleString("vi-VN")} từ của bộ này`
    : `${m} of ${safeTotal} words of this deck mastered`;

  if (compact) {
    return (
      <span className={s.masteryChip} title={label}>
        <span
          className={s.masteryChipDot}
          style={{ ["--p" as string]: `${(ratio * 360).toFixed(1)}deg` }}
          aria-hidden="true"
        />
        <span className="sr-only">{label}</span>
        <span aria-hidden="true">
          {masteryPercent(m, safeTotal, vi)} · {vi ? "đã thuộc" : "mastered"}
        </span>
      </span>
    );
  }

  const r = 46;
  const c = 2 * Math.PI * r;
  return (
    <figure className={s.mastery} aria-label={label}>
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle className={s.masteryTrack} cx="60" cy="60" r={r} />
        <circle
          className={s.masteryArc}
          cx="60"
          cy="60"
          r={r}
          strokeDasharray={`${(ratio * c).toFixed(2)} ${c.toFixed(2)}`}
        />
        <circle
          className={s.masteryBead}
          cx="60"
          cy="14"
          r="4"
          style={{ rotate: `${(ratio * 360).toFixed(1)}deg` }}
        />
      </svg>
      <figcaption className={s.masteryText} aria-hidden="true">
        <strong>{masteryPercent(m, safeTotal, vi)}</strong>
        <span>{vi ? "Đã thuộc" : "Mastered"}</span>
        <small>
          {m.toLocaleString(vi ? "vi-VN" : "en-US")} / {safeTotal.toLocaleString(vi ? "vi-VN" : "en-US")}
        </small>
      </figcaption>
    </figure>
  );
}

/* ───────────────────────────── Orbit of memory tools (after the turn) ───────────────────────────── */

/**
 * Three real tools for the word on the card, arranged along a sculpted luminous arc.
 * Locked before the flip so they never spoil recall.
 */
export function OrbitTools({
  word,
  ready,
  weak,
  vi,
  onLookup,
  onForge,
  onAskEcho,
}: {
  word: string;
  ready: boolean;
  weak: boolean;
  vi: boolean;
  onLookup: () => void;
  onForge: () => void;
  onAskEcho: () => void;
}) {
  const locked = vi ? "Lật thẻ trước để mở công cụ" : "Turn the card first";
  const tools = [
    {
      id: "lookup",
      icon: <BookOpen className="h-5 w-5" aria-hidden="true" />,
      label: vi ? `Tra “${word}” trong Từ điển` : `Look up “${word}”`,
      short: vi ? "Từ điển" : "Dictionary",
      run: onLookup,
    },
    {
      id: "forge",
      icon: <Brain className="h-5 w-5" aria-hidden="true" />,
      label: vi ? "Thử cách ghi nhớ khác (Echo AI)" : "Try another way to remember (Echo AI)",
      short: vi ? "Ghi nhớ khác" : "Memory Forge",
      run: onForge,
    },
    {
      id: "echo",
      icon: <img src={echoSrc("scholar", 40)} alt="" aria-hidden="true" draggable={false} />,
      label: vi ? `Hỏi Echo về “${word}”` : `Ask Echo about “${word}”`,
      short: vi ? "Hỏi Echo" : "Ask Echo",
      run: onAskEcho,
    },
  ];
  return (
    <nav className={s.orbit} aria-label={vi ? "Công cụ ghi nhớ" : "Memory tools"} data-ready={ready ? "" : undefined}>
      <svg className={s.orbitArc} viewBox="0 0 60 300" preserveAspectRatio="none" aria-hidden="true">
        <path d="M52 4 C 4 80, 4 220, 52 296" vectorEffect="non-scaling-stroke" />
      </svg>
      {tools.map((t) => (
        <button
          key={t.id}
          type="button"
          className={s.orbitNode}
          data-tool={t.id}
          data-weak={t.id === "forge" && weak ? "" : undefined}
          disabled={!ready}
          aria-label={ready ? t.label : `${t.label}. ${locked}`}
          title={ready ? t.label : locked}
          onClick={t.run}
        >
          <span className={s.orbitGlyph}>{t.icon}</span>
          <span className={s.orbitLabel} aria-hidden="true">
            {t.short}
          </span>
        </button>
      ))}
    </nav>
  );
}

/* ───────────────────────────── Study tips (bottom right) ───────────────────────────── */

export function TheaterTips({
  back,
  vi,
  showIntro,
  onDismissIntro,
  onOpenGuide,
}: {
  back: boolean;
  vi: boolean;
  showIntro: boolean;
  onDismissIntro: () => void;
  onOpenGuide: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
    if (showIntro) onDismissIntro();
  };
  const tip = back
    ? vi
      ? "Chọn thật lòng: 3 Dễ · 2 Trung Bình · 1 Khó. Chỉ “Dễ” mới đánh dấu từ là đã thuộc."
      : "Rate honestly: 3 Easy · 2 Medium · 1 Hard. Only “Easy” marks the word mastered."
    : vi
      ? "Nhớ nghĩa trong đầu trước, rồi mới lật thẻ (phím Space)."
      : "Recall the meaning in your head first, then turn the card (Space).";
  return (
    <div className={s.tips} data-open={open ? "" : undefined} data-new={showIntro && !open ? "" : undefined}>
      {open && (
        <div
          id={`${id}-tips`}
          className={s.tipsPanel}
          role="region"
          aria-label={vi ? "Gợi ý học" : "Study tips"}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              close();
            }
          }}
        >
          <button
            type="button"
            className={s.tipsClose}
            onClick={close}
            aria-label={vi ? "Đóng gợi ý" : "Close tips"}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
          {showIntro && (
            <p className={s.tipsLead}>
              {vi ? "Mới học với Flashcard? Đây là cách ôn hiệu quả." : "New to flashcards? Here is how to review well."}
            </p>
          )}
          <p className={s.tipsNow}>{tip}</p>
          <ul className={s.tipsKeys}>
            <li>
              <kbd>Space</kbd>
              {vi ? "Lật thẻ" : "Turn"}
            </li>
            {(["easy", "good", "hard"] as const).map((q) => (
              <li key={q}>
                <kbd>{RATING_COPY[q].key}</kbd>
                {RATING_COPY[q][vi ? "vi" : "en"].name} · {RATING_COPY[q][vi ? "vi" : "en"].short}
              </li>
            ))}
          </ul>
          <div className={s.tipsActions}>
            <button
              type="button"
              className={s.tipsPrimary}
              onClick={() => {
                onOpenGuide();
                close();
              }}
            >
              {vi ? "Xem hướng dẫn đầy đủ" : "Open the full guide"}
            </button>
            {showIntro && (
              <button type="button" className={s.tipsQuiet} onClick={close}>
                {vi ? "Đã hiểu" : "Got it"}
              </button>
            )}
          </div>
        </div>
      )}
      <button
        type="button"
        className={s.tipsToggle}
        aria-expanded={open}
        aria-controls={open ? `${id}-tips` : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Lightbulb className="h-4 w-4" aria-hidden="true" />
        <span>
          {showIntro ? (vi ? "Mới học? Xem gợi ý" : "New here? Tips") : vi ? "Gợi ý học" : "Study tips"}
        </span>
        <ChevronRight className={s.tipsChevron} aria-hidden="true" />
      </button>
    </div>
  );
}

/** The share of each stored rating in this session, for the insights sheet (numbers only from the tally). */
export function ratingShares(tally: Record<RecallQuality, number>) {
  const total = tally.hard + tally.good + tally.easy;
  return (["easy", "good", "hard"] as const).map((q) => ({
    q,
    n: tally[q],
    share: total > 0 ? tally[q] / total : 0,
  }));
}
