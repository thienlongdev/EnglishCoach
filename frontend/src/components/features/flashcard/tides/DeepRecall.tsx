"use client";

import React, { useId, useState } from "react";
import { checkCloze, compareMeaning, type Cloze, type ClozeVerdict, type MeaningMatch } from "./recall";
import styles from "./memoryTides.module.css";

/**
 * Deep Recall on the FRONT of the card (optional, chosen in the session bar). The learner types before turning; checking
 * turns the card, and the back shows the comparison next to the stored answer. Nothing is sent anywhere and the rating
 * (Khó / Tốt / Dễ) stays the learner's own honest choice — the review schedule is unchanged.
 */

export type RecallAttempt =
  | { kind: "type"; typed: string; match: MeaningMatch }
  | { kind: "cloze"; typed: string; verdict: ClozeVerdict; answer: string; hintsUsed: number };

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

export function TypeRecall({ word, storedMeaning, vi, onReveal }: {
  word: string;
  storedMeaning: string | null;
  vi: boolean;
  onReveal: (attempt: RecallAttempt | null) => void;
}) {
  const id = useId();
  const [typed, setTyped] = useState("");
  const check = () => {
    const t = typed.trim();
    if (!t) { onReveal(null); return; }
    onReveal({ kind: "type", typed: t.slice(0, 200), match: storedMeaning ? compareMeaning(t, storedMeaning) : "none" });
  };
  return (
    <form className={styles.recall} onClick={stop} onSubmit={(e) => { e.preventDefault(); check(); }} data-no-flip>
      <label htmlFor={id} className={styles.recallLabel}>
        {vi ? `Nghĩa của “${word}” là gì?` : `What does “${word}” mean?`}
      </label>
      <div className={styles.recallRow}>
        <input
          id={id}
          className={styles.recallInput}
          value={typed}
          onChange={(e) => setTyped(e.target.value.slice(0, 200))}
          placeholder={vi ? "Gõ nghĩa bạn nhớ…" : "Type the meaning you recall…"}
          autoComplete="off"
          spellCheck={false}
          lang="vi"
        />
        <button type="submit" className={styles.recallCheck}>{typed.trim() ? (vi ? "Kiểm tra" : "Check") : (vi ? "Lật thẻ" : "Turn")}</button>
      </div>
    </form>
  );
}

export function ClozeRecall({ cloze, word, vi, hints, onReveal }: {
  cloze: Cloze;
  word: string;
  vi: boolean;
  /** Only hints that exist in the card's own data, in the order they are revealed. */
  hints: string[];
  onReveal: (attempt: RecallAttempt | null) => void;
}) {
  const id = useId();
  const [typed, setTyped] = useState("");
  const [shown, setShown] = useState(0);
  const check = () => {
    const t = typed.trim();
    if (!t) { onReveal(null); return; }
    onReveal({ kind: "cloze", typed: t.slice(0, 120), verdict: checkCloze(t, cloze, word), answer: cloze.answer, hintsUsed: shown });
  };
  return (
    <form className={styles.recall} onClick={stop} onSubmit={(e) => { e.preventDefault(); check(); }} data-no-flip>
      <span className={styles.recallLabel}>{vi ? "Điền từ còn thiếu" : "Fill in the missing word"}</span>
      <p className={styles.clozeSentence} lang="en">
        {cloze.before}
        <span className={styles.clozeGap} aria-label={vi ? "chỗ trống" : "blank"}>{" ".repeat(Math.min(14, Math.max(4, cloze.answer.length)))}</span>
        {cloze.after}
      </p>
      {shown > 0 && (
        <ul className={styles.hints} aria-live="polite">
          {hints.slice(0, shown).map((h, i) => <li key={i}>{h}</li>)}
        </ul>
      )}
      <div className={styles.recallRow}>
        <label htmlFor={id} className="sr-only">{vi ? "Từ còn thiếu" : "Missing word"}</label>
        <input
          id={id}
          className={styles.recallInput}
          value={typed}
          onChange={(e) => setTyped(e.target.value.slice(0, 120))}
          placeholder={vi ? "Gõ từ…" : "Type the word…"}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          lang="en"
        />
        <button type="submit" className={styles.recallCheck}>{typed.trim() ? (vi ? "Kiểm tra" : "Check") : (vi ? "Lật thẻ" : "Turn")}</button>
      </div>
      {hints.length > 0 && (
        <button type="button" className={styles.hintButton} disabled={shown >= hints.length} onClick={() => setShown((n) => Math.min(hints.length, n + 1))}>
          {shown >= hints.length ? (vi ? "Đã hết gợi ý" : "No more hints") : (vi ? `Gợi ý (${shown + 1}/${hints.length})` : `Hint (${shown + 1}/${hints.length})`)}
        </button>
      )}
    </form>
  );
}

/** On the back: what the learner typed, beside the stored answer. Honest wording, never a score. */
export function RecallVerdict({ attempt, vi }: { attempt: RecallAttempt; vi: boolean }) {
  let tone: "ok" | "near" | "miss";
  let text: string;
  if (attempt.kind === "type") {
    tone = attempt.match === "close" ? "ok" : attempt.match === "partial" ? "near" : "miss";
    text = attempt.match === "close"
      ? (vi ? "Nhiều từ khóa trùng với nghĩa đã lưu." : "Many keywords match the stored meaning.")
      : attempt.match === "partial"
        ? (vi ? "Có vài ý trùng — hãy so kỹ với nghĩa bên dưới." : "Some ideas match — compare carefully below.")
        : (vi ? "Chưa thấy từ khóa trùng — hãy đối chiếu nghĩa bên dưới." : "No matching keywords — check the meaning below.");
  } else {
    tone = attempt.verdict === "exact" ? "ok" : attempt.verdict === "base" ? "near" : "miss";
    text = attempt.verdict === "exact"
      ? (vi ? "Đúng từ trong câu." : "That is the word in the sentence.")
      : attempt.verdict === "base"
        ? (vi ? `Đúng từ gốc; trong câu dùng dạng “${attempt.answer}”.` : `Right word; the sentence uses “${attempt.answer}”.`)
        : (vi ? `Từ trong câu là “${attempt.answer}”.` : `The word in the sentence is “${attempt.answer}”.`);
    if (attempt.hintsUsed > 0) text += vi ? ` (đã xem ${attempt.hintsUsed} gợi ý)` : ` (${attempt.hintsUsed} hint${attempt.hintsUsed > 1 ? "s" : ""} used)`;
  }
  return (
    <div className={styles.verdict} data-tone={tone} role="status">
      <span className={styles.verdictTyped}>
        {vi ? "Bạn trả lời: " : "You answered: "}<strong lang={attempt.kind === "cloze" ? "en" : "vi"}>{attempt.typed}</strong>
      </span>
      <span>{text}</span>
      <span className={styles.verdictNote}>
        {attempt.kind === "type"
          ? (vi ? "Đây chỉ là so khớp từ khóa — bạn tự đánh giá Dễ · Trung Bình · Khó." : "Only a keyword comparison — you rate Easy · Medium · Hard yourself.")
          : (vi ? "Hãy chọn Dễ · Trung Bình · Khó thật lòng." : "Rate Easy · Medium · Hard honestly.")}
      </span>
    </div>
  );
}
