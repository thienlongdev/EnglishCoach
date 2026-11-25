"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import { RATING_COPY, type RecallQuality } from "./RecallControls";
import styles from "./flashcardStudy.module.css";

/** Per-browser convenience only: whether this learner already closed the first-visit study tip. */
const INTRO_KEY = "ec.flashcard.guide-intro.v1";

export function useFlashcardGuideIntro() {
  const [showIntro, setShowIntro] = useState(false);
  useEffect(() => {
    try {
      setShowIntro(window.localStorage.getItem(INTRO_KEY) !== "dismissed");
    } catch {
      setShowIntro(false);
    }
  }, []);
  const dismissIntro = useCallback(() => {
    setShowIntro(false);
    try {
      window.localStorage.setItem(INTRO_KEY, "dismissed");
    } catch {
      /* storage blocked: the tip simply shows again next visit */
    }
  }, []);
  return { showIntro, dismissIntro };
}

interface FlashcardGuideProps {
  open: boolean;
  onClose: () => void;
}

const STEPS = {
  vi: [
    ["Nhìn từ", " ở mặt trước và đọc to nếu bạn muốn (nút loa phát âm mẫu)."],
    ["Tự nhớ nghĩa", " trong đầu trước khi lật — đây là bước giúp bạn nhớ lâu nhất."],
    ["Lật thẻ", " (bấm vào thẻ hoặc phím Space) để xem đáp án."],
    ["Đọc nghĩa và ví dụ", ", so sánh với điều bạn vừa nhớ ra."],
    ["Tự đánh giá thật lòng", " bằng Dễ, Trung Bình hoặc Khó."],
    ["Tiếp tục", " — hệ thống xếp lịch ôn cho từng thẻ theo lựa chọn của bạn."],
  ],
  en: [
    ["Look at the word", " on the front; say it aloud if you like (the speaker plays a model)."],
    ["Recall the meaning", " in your head before turning — this is the step that builds memory."],
    ["Turn the card", " (click it or press Space) to see the answer."],
    ["Read the meaning and examples", " and compare them with what you recalled."],
    ["Rate yourself honestly", " with Easy, Medium or Hard."],
    ["Carry on", " — each card is scheduled from your choice."],
  ],
} as const;

const ORDER: RecallQuality[] = ["easy", "good", "hard"];

export function FlashcardGuide({ open, onClose }: FlashcardGuideProps) {
  const { locale } = useLanguage();
  const vi = locale === "vi";
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="flashcard-guide-title"
      onClose={onClose}
      onClick={(e) => {
        // A click on the dimmed backdrop (the dialog element itself, outside the body) closes it.
        if (e.target === ref.current) onClose();
      }}
    >
      <div className={styles.dialogBody}>
        <button type="button" className={styles.closeX} onClick={onClose} aria-label={vi ? "Đóng hướng dẫn" : "Close the guide"}>
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
        <h2 id="flashcard-guide-title" className={styles.dialogTitle}>
          {vi ? "Cách học Flashcard" : "How to study with flashcards"}
        </h2>
        <p className={styles.dialogLead}>
          {vi
            ? "Mỗi lượt chỉ mất vài giây. Điều quan trọng là cố nhớ trước khi xem đáp án và đánh giá đúng mức bạn nhớ."
            : "Each card takes a few seconds. What matters is trying to recall before you look, and rating how well you really remembered."}
        </p>

        <ol className={styles.steps}>
          {STEPS[vi ? "vi" : "en"].map(([strong, rest], i) => (
            <li key={i}>
              <span>
                <strong>{strong}</strong>
                {rest}
              </span>
            </li>
          ))}
        </ol>

        <span className={styles.label}>{vi ? "Ý nghĩa của Dễ · Trung Bình · Khó" : "What Easy · Medium · Hard do"}</span>
        <div className={styles.legend}>
          {ORDER.map((q) => {
            const c = RATING_COPY[q][vi ? "vi" : "en"];
            return (
              <div key={q} className={`${styles.legendRow} ${styles[q]}`}>
                <span className={styles.legendName}>{c.name}</span>
                <span className={styles.legendText}>
                  {c.when}
                  <small>{c.detail}</small>
                </span>
              </div>
            );
          })}
        </div>

        <span className={styles.label}>{vi ? "Phím tắt" : "Shortcuts"}</span>
        <div className={styles.shortcuts}>
          <span><span className={styles.kbd}>Space</span>{vi ? "Lật thẻ" : "Turn the card"}</span>
          <span><span className={styles.kbd}>3</span>{RATING_COPY.easy[vi ? "vi" : "en"].name}</span>
          <span><span className={styles.kbd}>2</span>{RATING_COPY.good[vi ? "vi" : "en"].name}</span>
          <span><span className={styles.kbd}>1</span>{RATING_COPY.hard[vi ? "vi" : "en"].name}</span>
        </div>

        <div className={styles.dialogFoot}>
          <button type="button" className={styles.primary} onClick={onClose} autoFocus>
            {vi ? "Bắt đầu ôn" : "Start reviewing"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
