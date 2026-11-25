"use client";

import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import { RATING_COPY } from "./RecallControls";
import { MasteryHalo, ratingShares } from "./theater/TheaterHud";
import th from "./theater/theater.module.css";
import tides from "./tides/memoryTides.module.css";

export interface SessionTally {
  hard: number;
  good: number;
  easy: number;
}

interface StudyCompanionProps {
  /** The sheet is a quiet side layer of the theater: it opens on demand and never covers the card's controls by itself. */
  open: boolean;
  onClose: () => void;
  /** Ratings saved in this study session (counted on this screen only after the server accepted them). */
  tally: SessionTally;
  /** Due cards still waiting in this pass, or null when a single library card is being reviewed. */
  dueRemaining: number | null;
  totalCards: number;
  masteredCount: number;
  onOpenGuide: () => void;
}

/**
 * "Bộ nhớ lượt này" — the Memory Theater's insights sheet (owner brief 2026-11-20). Everything that used to stand as four
 * permanent boxes beside the card lives here, on demand: this session's stored ratings (counts and their share), what is
 * left in the pass, and the deck's long-term mastery from the server. Session progress and mastery are told apart on
 * purpose: rating a card is not memorising it (only Dễ marks a word mastered). No invented metric, no percentage of effort.
 */
export function StudyCompanion({ open, onClose, tally, dueRemaining, totalCards, masteredCount, onOpenGuide }: StudyCompanionProps) {
  const { locale } = useLanguage();
  const vi = locale === "vi";
  const reviewed = tally.hard + tally.good + tally.easy;
  const shares = ratingShares(tally);
  const closeRef = useRef<HTMLButtonElement>(null);

  // opening moves focus into the sheet (keyboard users land on its close button); the caller returns it on close
  useEffect(() => { if (open) closeRef.current?.focus({ preventScroll: true }); }, [open]);

  return (
    <aside className={th.sheet} data-open={open ? "true" : "false"} aria-hidden={!open} inert={!open}
      aria-label={vi ? "Bộ nhớ lượt này" : "This session's memory"}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
      <header className={th.sheetHead}>
        <h2>{vi ? "Bộ nhớ lượt này" : "This session"}</h2>
        <button ref={closeRef} type="button" className={th.sheetClose} onClick={onClose} aria-label={vi ? "Đóng bảng thống kê" : "Close insights"}>
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </header>
      <div className={th.sheetBody}>
        <section className={th.sheetSection}>
          <h3>{vi ? "Lượt ôn" : "Review pass"}</h3>
          <p className={th.sheetLine}>
            {reviewed === 0
              ? (vi ? "Chưa đánh giá thẻ nào" : "No card rated yet")
              : (vi ? <>Đã đánh giá <strong key={reviewed} className={tides.pop}>{reviewed}</strong> thẻ</> : <>Rated <strong key={reviewed} className={tides.pop}>{reviewed}</strong> card{reviewed > 1 ? "s" : ""}</>)}
            {dueRemaining !== null && (vi ? <> · còn <strong>{dueRemaining}</strong> thẻ trong lượt</> : <> · <strong>{dueRemaining}</strong> left in the pass</>)}
          </p>
          <div className={th.distribution} role="img" aria-label={vi
            ? `Dễ ${tally.easy}, Trung Bình ${tally.good}, Khó ${tally.hard}`
            : `Easy ${tally.easy}, Medium ${tally.good}, Hard ${tally.hard}`}>
            {shares.map(({ q, share }) => share > 0 && <i key={q} data-q={q} style={{ width: `${(share * 100).toFixed(2)}%` }} />)}
          </div>
          <ul className={th.legend}>
            {shares.map(({ q, n }) => {
              const copy = RATING_COPY[q][vi ? "vi" : "en"];
              return (
                <li key={q} data-q={q}>
                  <i aria-hidden="true" />
                  <b>{copy.name}</b>
                  <small>{copy.effect}</small>
                  <strong key={n} className={n > 0 ? tides.pop : undefined}>{n}</strong>
                </li>
              );
            })}
          </ul>
        </section>

        <section className={th.sheetSection}>
          <h3>{vi ? "Mức độ thuộc bộ từ" : "Deck mastery"}</h3>
          <div className={th.sheetMastery}>
            <MasteryHalo mastered={masteredCount} total={totalCards} vi={vi} />
            <p className={th.sheetLine}>
              {vi ? <>Đã thuộc <strong>{Math.min(masteredCount, totalCards).toLocaleString("vi-VN")}/{totalCards.toLocaleString("vi-VN")}</strong> từ trong bộ này.</>
                : <>Mastered <strong>{Math.min(masteredCount, totalCards)}/{totalCards}</strong> words in this deck.</>}
            </p>
          </div>
        </section>

        <p className={th.sheetNote}>
          {vi
            ? "Đánh giá một thẻ không có nghĩa là đã thuộc nó: Khó đưa thẻ trở lại hôm nay, Trung Bình hẹn 3 ngày nữa, chỉ Dễ mới đánh dấu từ là đã thuộc."
            : "Rating a card is not memorising it: Hard brings it back today, Medium schedules it in 3 days, only Easy marks the word mastered."}
        </p>
        <button type="button" className={th.sheetGuide} onClick={onOpenGuide}>{vi ? "Cách học Flashcard" : "How to study with flashcards"}</button>
      </div>
    </aside>
  );
}
