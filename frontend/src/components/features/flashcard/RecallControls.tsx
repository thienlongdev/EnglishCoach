"use client";

import React, { useEffect } from "react";
import { useLanguage } from "@/context/LanguageContext";
import { Frown, Laugh, Smile } from "lucide-react";
import styles from "./flashcardStudy.module.css";

export type RecallQuality = "hard" | "good" | "easy";

interface RecallControlsProps {
  onRate: (quality: RecallQuality) => void;
  /** The rating being saved, or null. While a rating is saved no other rating is accepted. */
  savingQuality?: RecallQuality | null;
  /** Keys 1–3 are live only while the back of the card is showing and nothing else owns the keyboard. */
  enabled?: boolean;
}

/**
 * The three memory ratings, sent unchanged to `PUT /flashcards/{id}/review?quality=hard|good|easy`.
 * Their effect is the backend's (FlashcardService#reviewFlashcard), stated here in learner words:
 *   hard → due again at once (stays in today's review), status LEARNED
 *   good → next review in 3 days, status LEARNED (a mastered card stays mastered)
 *   easy → status MASTERED: the card leaves the due-review queue (next date +7 days is not used for mastered cards)
 * Keep these words in step with FlashcardGuide and with the backend if the scheduling ever changes.
 */
interface RatingText { name: string; effect: string; short: string; when: string; detail: string }

export const RATING_COPY: Record<RecallQuality, { vi: RatingText; en: RatingText; key: string }> = {
  hard: {
    key: "1",
    vi: { name: "Khó", effect: "Ôn lại hôm nay", short: "Hôm nay", when: "Chưa nhớ ra, hoặc phải đoán, nhớ rất chật vật.", detail: "Thẻ vẫn nằm trong danh sách cần ôn hôm nay." },
    en: { name: "Hard", effect: "Again today", short: "Today", when: "You could not recall it, guessed, or struggled a lot.", detail: "The card stays in today's review list." },
  },
  good: {
    key: "2",
    vi: { name: "Trung Bình", effect: "Ôn lại sau 3 ngày", short: "Sau 3 ngày", when: "Nhớ ra đúng nghĩa sau một chút suy nghĩ.", detail: "Lần ôn tiếp theo: sau 3 ngày." },
    en: { name: "Medium", effect: "Again in 3 days", short: "In 3 days", when: "You recalled the right meaning after a moment's thought.", detail: "Next review: in 3 days." },
  },
  easy: {
    key: "3",
    vi: { name: "Dễ", effect: "Đánh dấu đã thuộc", short: "Đã thuộc", when: "Nhớ ngay lập tức và chắc chắn.", detail: "Thẻ được đánh dấu “Đã thuộc” và rời khỏi lượt ôn đến hạn; bạn có thể đặt lại trong Thư viện thẻ." },
    en: { name: "Easy", effect: "Mark as mastered", short: "Mastered", when: "You recalled it instantly and surely.", detail: "The card is marked Mastered and leaves the due reviews; you can reset it in the card library." },
  },
};

const ORDER: RecallQuality[] = ["easy", "good", "hard"];
// a semantic face per rating (how the recall felt), never decoration
const FACE = { hard: Frown, good: Smile, easy: Laugh } as const;

export function RecallControls({ onRate, savingQuality = null, enabled = true }: RecallControlsProps) {
  const { locale } = useLanguage();
  const vi = locale === "vi";
  const saving = savingQuality !== null;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
      const quality = ORDER.find((q) => RATING_COPY[q].key === e.key);
      if (!quality) return;
      e.preventDefault();
      onRate(quality);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onRate, enabled]);

  return (
    <div>
      <p className={styles.ratingAsk}>
        <span id="recall-ask">{vi ? "Bạn nhớ từ này thế nào?" : "How well did you remember it?"}</span>
        <span className={styles.ratingHint}>{vi ? "Hãy chọn thật lòng — phím 1, 2, 3" : "Be honest — keys 1, 2, 3"}</span>
      </p>
      <div className={styles.ratingGrid} role="group" aria-labelledby="recall-ask" data-guide="fc-rate">
        {ORDER.map((q) => {
          const copy = RATING_COPY[q][vi ? "vi" : "en"];
          const pending = savingQuality === q;
          return (
            <button
              key={q}
              type="button"
              id={`btn-recall-${q}`}
              className={`${styles.rate} ${styles[q]}`}
              disabled={saving}
              data-pending={pending ? "true" : "false"}
              aria-busy={pending}
              aria-keyshortcuts={RATING_COPY[q].key}
              title={`${copy.when} ${copy.detail}`}
              onClick={(e) => {
                e.stopPropagation();
                onRate(q);
              }}
            >
              <span className={styles.rateFace} aria-hidden="true">{React.createElement(FACE[q])}</span>
              <span className={styles.rateTop}>
                <span className={styles.rateName}>{copy.name}</span>
                {pending ? (
                  <span className={styles.spinner} aria-hidden="true" />
                ) : (
                  <span className={`${styles.kbd} ${styles.rateKey}`} aria-hidden="true">{RATING_COPY[q].key}</span>
                )}
              </span>
              <span className={styles.rateEffect}>
                {pending ? (vi ? "Đang lưu…" : "Saving…") : (
                  <>
                    <span className={styles.effectLong}>{copy.effect}</span>
                    <span className={styles.effectShort}>{copy.short}</span>
                  </>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
