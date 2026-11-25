"use client";

import React, { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { BrandWhaleIcon } from "@/components/common/BrandWhaleIcon";
import { checkFusion, fetchFusionCandidates, isCancelled, memoryAiError } from "@/services/flashcardMemoryApi";
import { useEchoAiAllowance } from "./useEchoAiAllowance";
import type { FusionCandidate, FusionResult } from "@/types/flashcardMemory";
import tides from "./memoryTides.module.css";
import styles from "./memoryVault.module.css";

/**
 * Card Fusion (Phase 2 core, owner brief 2026-11-12): a voluntary challenge. Pairs come from the server with real evidence
 * (both learned words occur in one stored example sentence); the learner writes ONE sentence using both, Echo checks it on
 * an explicit click, and only an accepted sentence links the pair (Synapse). An uncertain or failed check never counts
 * against the learner and never touches the review schedule. The stored example is shown only after the attempt.
 */
export function CardFusion({ onLinked }: { onLinked?: () => void }) {
  const [pairs, setPairs] = useState<FusionCandidate[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pick, setPick] = useState<FusionCandidate | null>(null);
  const [sentence, setSentence] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FusionResult | null>(null);
  const [error, setError] = useState<{ message: string; upgrade: boolean } | null>(null);
  // the site-wide AI allowance (shared free daily pool / Premium fair use); loading pairs costs nothing
  const ai = useEchoAiAllowance("FLASHCARD_FUSION_CHECK", "Card Fusion");
  const abort = useRef<AbortController | null>(null);

  const load = async () => {
    setLoadError(false);
    setPairs(null);
    try {
      const list = await fetchFusionCandidates(6);
      setPairs(list);
      setPick((p) => (p && list.some((c) => c.firstCardId === p.firstCardId && c.secondCardId === p.secondCardId) ? p : list[0] ?? null));
    } catch {
      setLoadError(true);
    }
  };

  useEffect(() => { void load(); return () => abort.current?.abort(); }, []);

  const choose = (c: FusionCandidate) => { setPick(c); setSentence(""); setResult(null); setError(null); };

  const check = async () => {
    if (!pick || busy || sentence.trim().length < 6 || !ai.allowed) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await checkFusion(pick.firstCardId, pick.secondCardId, sentence.trim(), ctrl.signal);
      setResult(r);
      if (r.newlyLinked) onLinked?.();
      ai.refresh();
    } catch (e) {
      if (!isCancelled(e)) {
        const err = memoryAiError(e);
        // a sentence refused before the AI (missing word, length) costs nothing; a quota refusal opens the upgrade flow
        if (err.upgrade) { ai.refresh(); ai.openUpgrade(); }
        setError(err);
      }
    } finally {
      if (abort.current === ctrl) abort.current = null;
      setBusy(false);
    }
  };

  return (
    <section className={styles.panel} aria-labelledby="fusion-title">
      <header className={styles.panelHead}>
        <div>
          <h2 id="fusion-title">Card Fusion</h2>
          <p>Viết một câu tự nhiên dùng cả hai từ bạn đã học. Không bắt buộc, không ảnh hưởng lịch ôn.</p>
          <div className={tides.allowance}><span>Mỗi lần kiểm tra dùng một lượt AI</span>{ai.badge}</div>
          {ai.exhaustedNote && <p className={tides.note} role="status">{ai.exhaustedNote}</p>}
        </div>
        {ai.upgradeModal}
        <button type="button" className={tides.secondary} onClick={() => void load()} disabled={busy}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />Cặp khác
        </button>
      </header>

      {pairs === null && !loadError && <p className={tides.note}>Đang tìm các cặp từ có liên hệ thật…</p>}
      {loadError && <p className={tides.error} role="alert">Không tải được cặp từ. <button type="button" className={tides.linkish} onClick={() => void load()}>Thử lại</button></p>}
      {pairs !== null && pairs.length === 0 && (
        <p className={tides.note}>
          Chưa có cặp từ nào. Echo chỉ ghép hai từ bạn đã học khi chúng thật sự xuất hiện cùng nhau trong một câu ví dụ đã lưu —
          hãy học thêm vài bộ từ rồi quay lại.
        </p>
      )}

      {pairs !== null && pairs.length > 0 && (
        <>
          <div className={styles.pairs} role="radiogroup" aria-label="Chọn cặp từ">
            {pairs.map((c) => {
              const on = pick?.firstCardId === c.firstCardId && pick?.secondCardId === c.secondCardId;
              return (
                <button key={`${c.firstCardId}-${c.secondCardId}`} type="button" role="radio" aria-checked={on} className={styles.pair} onClick={() => choose(c)} disabled={busy}>
                  <span lang="en">{c.firstWord}</span><span aria-hidden="true">+</span><span lang="en">{c.secondWord}</span>
                </button>
              );
            })}
          </div>

          {pick && (
            <div className={styles.fusionWork}>
              <label className={tides.field}>
                <span>Câu của bạn với “{pick.firstWord}” và “{pick.secondWord}”</span>
                <textarea rows={2} lang="en" maxLength={400} value={sentence} disabled={busy}
                  onChange={(e) => { setSentence(e.target.value); setResult(null); }} placeholder="Viết bằng tiếng Anh…" />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={tides.primary} onClick={() => void check()} disabled={busy || sentence.trim().length < 6 || !ai.allowed}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <BrandWhaleIcon size="xs" clean />}
                  {busy ? "Echo đang kiểm tra…" : "Kiểm tra với Echo"}
                </button>
                {busy && <button type="button" className={tides.secondary} onClick={() => abort.current?.abort()}>Hủy</button>}
              </div>
            </div>
          )}

          {error && (
            <p className={tides.error} role="alert">
              {error.message}{" "}{error.upgrade && <button type="button" className="font-bold underline" onClick={ai.openUpgrade}>Xem gói Premium</button>}
            </p>
          )}

          {result && pick && (
            <div className={styles.fusionResult} data-verdict={result.verdict} aria-live="polite">
              {result.accepted && (
                <div className={styles.fusionOrbs} aria-hidden="true">
                  <span className={styles.orbA}>{pick.firstWord}</span>
                  <span className={styles.orbB}>{pick.secondWord}</span>
                  <span className={styles.orbCore} />
                </div>
              )}
              <p className={styles.verdictTitle}>
                {result.accepted ? (result.newlyLinked ? "Câu được chấp nhận — hai từ đã nối vào Synapse của bạn." : "Câu được chấp nhận. Cặp từ này đã có trong Synapse.")
                  : result.verdict === "UNCERTAIN" ? "Echo chưa chắc chắn về câu này — không tính là sai."
                  : "Câu cần chỉnh thêm một chút."}
              </p>
              {result.feedbackVi && <p>{result.feedbackVi}</p>}
              {result.suggestionEn && <p className={styles.suggest} lang="en"><span>Gợi ý:</span> {result.suggestionEn}</p>}
              <p className={styles.reference} lang="en"><span>Câu ví dụ đã lưu có cả hai từ:</span> {pick.reference}</p>
              <span className={tides.aiBadge}>Nhận xét từ Echo AI</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
