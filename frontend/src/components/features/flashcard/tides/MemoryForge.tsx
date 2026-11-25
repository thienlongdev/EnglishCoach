"use client";

import React, { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { BrandWhaleIcon } from "@/components/common/BrandWhaleIcon";
import { forgeMemory, isCancelled, memoryAiError } from "@/services/flashcardMemoryApi";
import { useEchoAiAllowance } from "./useEchoAiAllowance";
import type { ForgeMode, ForgeResult } from "@/types/flashcardMemory";
import { TidesDialog } from "./TidesDialog";
import styles from "./memoryTides.module.css";

const MODES: Array<{ id: ForgeMode; vi: string; en: string; hint: [string, string] }> = [
  { id: "EXPLAIN", vi: "Giải thích lại", en: "Explain again", hint: ["Nhìn nghĩa đã lưu từ một góc khác", "See the stored meaning from another angle"] },
  { id: "EXAMPLE", vi: "Ví dụ của riêng bạn", en: "Your own examples", hint: ["Câu ví dụ gần với điều bạn quan tâm", "Examples close to what you care about"] },
  { id: "MNEMONIC", vi: "Mẹo nhớ", en: "Memory hook", hint: ["Một hình ảnh hay câu chuyện ngắn để nhớ", "A short image or story to remember it"] },
  { id: "BREAKDOWN", vi: "Chia nhỏ", en: "Break it down", hint: ["Vài câu hỏi nhỏ để tự kiểm tra", "Small questions to test yourself"] },
];

/**
 * Memory Forge (owner brief 2026-11-12): another way to remember a word the learner keeps finding hard. One AI request per
 * explicit click; the answer is shown beside the card's STORED meaning (authoritative) and labelled as an AI suggestion.
 * Nothing is saved and the review schedule is untouched.
 */
export function MemoryForge({ card, open, onClose, vi = true }: {
  card: { id: number; word: string } | null;
  open: boolean;
  onClose: () => void;
  vi?: boolean;
}) {
  const [mode, setMode] = useState<ForgeMode>("EXPLAIN");
  const [interest, setInterest] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ForgeResult | null>(null);
  const [error, setError] = useState<{ message: string; upgrade: boolean } | null>(null);
  const [shownAnswers, setShownAnswers] = useState<Set<number>>(new Set());
  const abort = useRef<AbortController | null>(null);
  // the site-wide AI allowance (shared free daily pool / Premium fair use), exactly as other AI modules use it
  const ai = useEchoAiAllowance("FLASHCARD_MEMORY_FORGE", "Memory Forge");

  useEffect(() => {
    // a new card (or reopening) starts clean; leaving cancels a request in flight
    setResult(null); setError(null); setShownAnswers(new Set());
    return () => { abort.current?.abort(); };
  }, [card?.id, open]);

  const run = async () => {
    if (!card || busy || !ai.allowed) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true); setError(null); setResult(null); setShownAnswers(new Set());
    try {
      setResult(await forgeMemory(card.id, mode, mode === "EXAMPLE" ? interest.trim() : undefined, ctrl.signal));
      ai.refresh();
    } catch (e) {
      if (!isCancelled(e)) {
        const err = memoryAiError(e, vi);
        if (err.upgrade) { ai.refresh(); ai.openUpgrade(); }
        setError(err);
      }
    } finally {
      if (abort.current === ctrl) abort.current = null;
      setBusy(false);
    }
  };

  return (
    <TidesDialog
      open={open && !!card}
      onClose={() => { abort.current?.abort(); onClose(); }}
      title={<span className="inline-flex items-center gap-2"><BrandWhaleIcon size="sm" clean />Memory Forge</span>}
      subtitle={card ? (vi ? <>Cách ghi nhớ khác cho <strong lang="en">{card.word}</strong></> : <>Another way to remember <strong lang="en">{card.word}</strong></>) : null}
    >
      {ai.upgradeModal}
      <div className={styles.allowance}><span>{vi ? "Lượt AI" : "AI uses"}</span>{ai.badge}</div>
      {ai.exhaustedNote && <p className={styles.note} role="status">{ai.exhaustedNote}</p>}
      <div className={styles.forgeModes} role="radiogroup" aria-label={vi ? "Cách ghi nhớ" : "Way to remember"}>
        {MODES.map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={styles.choice} onClick={() => setMode(m.id)} disabled={busy}>
            <strong>{vi ? m.vi : m.en}</strong>
            <span>{m.hint[vi ? 0 : 1]}</span>
          </button>
        ))}
      </div>
      {mode === "EXAMPLE" && (
        <label className={styles.field}>
          <span>{vi ? "Bạn quan tâm điều gì? (không bắt buộc)" : "What are you interested in? (optional)"}</span>
          <input value={interest} maxLength={120} onChange={(e) => setInterest(e.target.value)} placeholder={vi ? "Ví dụ: bóng đá, nấu ăn, công việc văn phòng" : "e.g. football, cooking, office work"} />
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={styles.primary} onClick={() => void run()} disabled={busy || !card || !ai.allowed}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <BrandWhaleIcon size="xs" clean />}
          {busy ? (vi ? "Echo đang soạn…" : "Echo is writing…") : (vi ? "Tạo với Echo" : "Create with Echo")}
        </button>
        {busy && <button type="button" className={styles.secondary} onClick={() => abort.current?.abort()}>{vi ? "Hủy" : "Cancel"}</button>}
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {error.message}{" "}
          {error.upgrade && <button type="button" className="font-bold underline" onClick={ai.openUpgrade}>{vi ? "Xem gói Premium" : "See Premium"}</button>}
        </p>
      )}

      {result && (
        <section className={styles.forgeResult} aria-live="polite">
          <p className={styles.authoritative}>
            <span>{vi ? "Nghĩa đã lưu" : "Stored meaning"}</span>
            {result.storedMeaning}
          </p>
          <div className={styles.aiBlock}>
            <span className={styles.aiBadge}>{vi ? "Gợi ý từ Echo AI — không thay nghĩa đã lưu" : "Echo AI suggestion — not the stored meaning"}</span>
            {result.title && <h3>{result.title}</h3>}
            {result.paragraphs.map((p, i) => <p key={i}>{p}</p>)}
            {result.prompts.length > 0 && (
              <ol className={styles.prompts}>
                {result.prompts.map((q, i) => (
                  <li key={i}>
                    <span>{q.q}</span>
                    {shownAnswers.has(i)
                      ? <em>{q.a}</em>
                      : <button type="button" className={styles.linkish} onClick={() => setShownAnswers((s) => new Set(s).add(i))}>{vi ? "Xem đáp án" : "Show answer"}</button>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      )}
    </TidesDialog>
  );
}
