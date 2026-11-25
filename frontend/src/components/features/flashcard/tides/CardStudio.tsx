"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { BrandWhaleIcon } from "@/components/common/BrandWhaleIcon";
import { generateStudioDrafts, isCancelled, memoryAiError, saveStudioCard } from "@/services/flashcardMemoryApi";
import type { StudioCard, StudioLevel } from "@/types/flashcardMemory";
import { TidesDialog } from "./TidesDialog";
import { useEchoAiAllowance } from "./useEchoAiAllowance";
import styles from "./memoryTides.module.css";

/**
 * Echo AI Card Studio (owner brief 2026-11-12). Paste English → choose a level and a count → Echo PROPOSES drafts (one AI
 * request per click) → the learner edits, regenerates, removes and selects → only the approved drafts are saved, one by one,
 * through the existing POST /flashcards boundary (same validation, dedupe, ownership). Nothing is saved automatically.
 * IPA / CEFR appear only when the shared dictionary has them; the source sentence is always a sentence of the pasted text.
 */

const MAX = 6000;
const LEVELS: Array<{ id: StudioLevel; label: string }> = [
  { id: "ANY", label: "Tự động" },
  { id: "A2", label: "A2" },
  { id: "B1", label: "B1" },
  { id: "B2", label: "B2" },
  { id: "C1", label: "C1" },
];
const KIND_VI: Record<StudioCard["kind"], string> = {
  WORD: "Từ",
  COLLOCATION: "Cụm từ cố định",
  PHRASAL_VERB: "Cụm động từ",
  IDIOM: "Thành ngữ",
  PHRASE: "Cụm từ",
};

type SaveState = "saving" | "created" | "existing" | { error: string };
interface Draft extends StudioCard { selected: boolean; meaning: string; save?: SaveState; regenerating?: boolean }

/** One word of the term with its regular inflections (make → making, cope → coped, rain → rains). */
function wordPattern(word: string): string {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return word.length > 3 && /e$/i.test(word) ? `${esc.slice(0, -1)}[a-z]*` : `${esc}[a-z]*`;
}

/** Marks the whole term in its sentence (every word of a phrase, inflected); a separated phrasal verb marks its verb. */
function highlightTerm(sentence: string, term: string): React.ReactNode {
  const words = term.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return sentence;
  const whole = new RegExp(`\\b${words.map(wordPattern).join("\\s+")}\\b`, "i").exec(sentence);
  const m = whole ?? new RegExp(`\\b${wordPattern(words[0])}`, "i").exec(sentence);
  if (!m) return sentence;
  return <>{sentence.slice(0, m.index)}<mark>{m[0]}</mark>{sentence.slice(m.index + m[0].length)}</>;
}

export interface CardStudioProps {
  open: boolean;
  onClose: () => void;
  /** Text to start with (a Reading / My Books selection). The learner can still edit it. */
  initialText?: string;
  /** Where the text came from, shown to the learner (e.g. the article or book title). Never sent to AI as instructions. */
  sourceLabel?: string;
  /** Called after at least one card was stored (the library revalidates its counts). */
  onSaved?: (created: number) => void;
}

export function CardStudio({ open, onClose, initialText = "", sourceLabel, onSaved }: CardStudioProps) {
  const [text, setText] = useState(initialText);
  const [level, setLevel] = useState<StudioLevel>("ANY");
  const [count, setCount] = useState(8);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; upgrade: boolean } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  // the site-wide AI allowance (shared free daily pool / Premium fair use), never a Studio-only counter
  const ai = useEchoAiAllowance("FLASHCARD_AI_STUDIO", "Echo AI Card Studio");
  const aiFailed = (e: unknown) => {
    const err = memoryAiError(e);
    if (err.upgrade) { ai.refresh(); ai.openUpgrade(); }
    setError(err);
  };

  useEffect(() => {
    if (!open) return;
    setText(initialText.slice(0, MAX));
    setDrafts([]); setError(null); setNote(null);
    return () => { abort.current?.abort(); };
  }, [open, initialText]);

  const textReady = text.trim().length >= 20;
  const selected = drafts.filter((d) => d.selected && !d.save);
  const savedCount = drafts.filter((d) => d.save === "created").length;

  const toDraft = (c: StudioCard): Draft => ({ ...c, selected: !c.alreadySaved, meaning: c.meaningVi });

  const generate = async (more: boolean) => {
    if (busy || !textReady || !ai.allowed) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true); setError(null); setNote(null);
    try {
      const res = await generateStudioDrafts({ text, level, count, exclude: more ? drafts.map((d) => d.term) : undefined }, ctrl.signal);
      const fresh = res.cards.map(toDraft);
      setDrafts((prev) => (more ? [...prev, ...fresh.filter((f) => !prev.some((p) => p.term.toLowerCase() === f.term.toLowerCase()))] : fresh));
      if (!res.cards.length) setNote("Echo chưa tìm được từ nào đáng học trong đoạn này. Hãy thử đoạn dài hơn hoặc đổi trình độ.");
      else if (res.dropped > 0) setNote(`Đã bỏ ${res.dropped} gợi ý không khớp với đoạn văn của bạn.`);
      ai.refresh();
    } catch (e) {
      if (!isCancelled(e)) aiFailed(e);
    } finally {
      if (abort.current === ctrl) abort.current = null;
      setBusy(false);
    }
  };

  const regenerate = async (draft: Draft) => {
    if (busy || draft.regenerating || !ai.allowed) return;
    setDrafts((prev) => prev.map((d) => (d.draftId === draft.draftId ? { ...d, regenerating: true } : d)));
    setError(null);
    try {
      const res = await generateStudioDrafts({ text, level, count: 1, only: draft.term });
      const next = res.cards[0];
      setDrafts((prev) => prev.map((d) => (d.draftId === draft.draftId
        ? (next ? { ...toDraft(next), draftId: d.draftId, selected: d.selected } : { ...d, regenerating: false })
        : d)));
      if (!next) setNote(`Echo chưa tạo lại được thẻ “${draft.term}”; bản cũ vẫn giữ nguyên.`);
      ai.refresh();
    } catch (e) {
      setDrafts((prev) => prev.map((d) => (d.draftId === draft.draftId ? { ...d, regenerating: false } : d)));
      aiFailed(e);
    }
  };

  const update = (id: string, patch: Partial<Draft>) => setDrafts((prev) => prev.map((d) => (d.draftId === id ? { ...d, ...patch } : d)));

  const saveSelected = async () => {
    if (savingRef.current || !selected.length) return;
    savingRef.current = true;
    setSaving(true);
    let created = 0;
    for (const d of selected) {
      const term = d.term.trim();
      const meaning = d.meaning.trim();
      if (!term || !meaning) { update(d.draftId, { save: { error: "Cần có từ và nghĩa." } }); continue; }
      update(d.draftId, { save: "saving" });
      try {
        const same = term.toLowerCase() === d.term.toLowerCase();
        // the approved contextual sense travels with the card only while the term is the one Echo analysed
        const outcome = await saveStudioCard({ term, meaning, example: d.sourceSentence, ipa: same ? d.ipa : null, cefr: same ? d.cefr : null,
          definition: same ? d.definitionEn : null, partOfSpeech: same ? d.partOfSpeech : null, exampleVi: same ? d.sentenceVi : null });
        if (outcome === "created") created++;
        update(d.draftId, { save: outcome, selected: false });
      } catch (e) {
        const status = (e as { response?: { status?: number; data?: { message?: unknown } } })?.response;
        const msg = typeof status?.data?.message === "string" ? status.data.message : "Chưa lưu được thẻ này. Hãy thử lại.";
        update(d.draftId, { save: { error: msg } });
      }
    }
    savingRef.current = false;
    setSaving(false);
    if (created > 0) onSaved?.(created);
  };

  const footer = drafts.length > 0 ? (
    <div className="flex w-full flex-wrap items-center gap-2">
      <span className="mr-auto text-sm font-semibold text-slate-600 dark:text-slate-300">
        {savedCount > 0 ? `Đã lưu ${savedCount} thẻ mới · ` : ""}{selected.length} thẻ đang chọn
      </span>
      <button type="button" className={styles.secondary} onClick={() => void generate(true)} disabled={busy || saving || !ai.allowed}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <BrandWhaleIcon size="xs" clean />}
        Thêm gợi ý
      </button>
      <button type="button" className={styles.primary} onClick={() => void saveSelected()} disabled={saving || !selected.length}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
        {saving ? "Đang lưu…" : `Lưu ${selected.length} thẻ đã chọn`}
      </button>
    </div>
  ) : null;

  const textCount = useMemo(() => text.length, [text]);

  return (
    <TidesDialog
      open={open}
      onClose={() => { abort.current?.abort(); onClose(); }}
      busy={saving}
      wide
      title={<span className="inline-flex items-center gap-2"><BrandWhaleIcon size="sm" clean />Echo AI Card Studio</span>}
      subtitle={sourceLabel ? <>Từ: <strong>{sourceLabel}</strong></> : "Dán một đoạn tiếng Anh, Echo gợi ý thẻ — bạn duyệt trước khi lưu."}
      footer={footer}
    >
      {ai.upgradeModal}
      <div className={styles.allowance} data-testid="studio-allowance">
        <span>AI tạo Flashcard</span>
        {ai.badge}
        <small>Mỗi lần Echo phân tích hoặc tạo lại một thẻ dùng một lượt; mở, chỉnh, bỏ chọn và lưu thẻ thì không.</small>
      </div>
      {ai.exhaustedNote && (
        <p className={styles.note} role="status">
          {ai.exhaustedNote}{" "}
          {!ai.isPremium && <button type="button" className="font-bold underline" onClick={ai.openUpgrade}>Xem gói Premium</button>}
        </p>
      )}
      <div className={styles.studioInput}>
        <label className={styles.field}>
          <span className="flex items-baseline justify-between gap-2">
            <span>Đoạn văn tiếng Anh</span>
            <small className={textCount > MAX * 0.95 ? "text-rose-600" : undefined}>{textCount.toLocaleString("vi-VN")}/{MAX.toLocaleString("vi-VN")}</small>
          </span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, MAX))}
            rows={drafts.length ? 3 : 7}
            lang="en"
            placeholder="Dán bài báo, đoạn sách, lời thoại… (tối thiểu 20 ký tự)"
            disabled={busy}
          />
        </label>
        <div className={styles.studioControls}>
          <div className={styles.field}>
            <span id="studio-level">Trình độ từ vựng</span>
            <div className={styles.segment} role="radiogroup" aria-labelledby="studio-level">
              {LEVELS.map((l) => (
                <button key={l.id} type="button" role="radio" aria-checked={level === l.id} onClick={() => setLevel(l.id)} disabled={busy}>{l.label}</button>
              ))}
            </div>
          </div>
          <label className={styles.field}>
            <span>Số thẻ gợi ý: <strong>{count}</strong></span>
            <input type="range" min={3} max={15} value={count} onChange={(e) => setCount(Number(e.target.value))} disabled={busy} />
          </label>
          <div className="flex items-end gap-2">
            <button type="button" className={styles.primary} onClick={() => void generate(false)} disabled={busy || !textReady || !ai.allowed}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <BrandWhaleIcon size="xs" clean />}
              {busy ? "Echo đang đọc…" : drafts.length ? "Phân tích lại" : "Phân tích với Echo AI"}
            </button>
            {busy && <button type="button" className={styles.secondary} onClick={() => abort.current?.abort()}>Hủy</button>}
          </div>
        </div>
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {error.message}{" "}
          {error.upgrade && <button type="button" className="font-bold underline" onClick={ai.openUpgrade}>Xem gói Premium</button>}
        </p>
      )}
      {note && <p className={styles.note} role="status">{note}</p>}

      {drafts.length > 0 && (
        <>
          <p className={styles.aiBadge}>Gợi ý từ Echo AI — hãy kiểm tra nghĩa trước khi lưu. Phát âm và trình độ CEFR chỉ hiện khi từ điển có.</p>
          <ul className={styles.drafts}>
            {drafts.map((d) => {
              const done = d.save === "created" || d.save === "existing";
              const err = d.save && typeof d.save === "object" ? d.save.error : null;
              return (
                <li key={d.draftId} className={styles.draft} data-selected={d.selected ? "true" : "false"} data-done={done ? "true" : "false"}>
                  <div className={styles.draftHead}>
                    <label className={styles.check}>
                      <input type="checkbox" checked={d.selected} disabled={done || saving || !!d.regenerating}
                        onChange={(e) => update(d.draftId, { selected: e.target.checked })} />
                      <span className="sr-only">Chọn thẻ {d.term}</span>
                    </label>
                    <input className={styles.termInput} value={d.term} lang="en" maxLength={80} disabled={done || saving}
                      onChange={(e) => update(d.draftId, { term: e.target.value })} aria-label="Từ hoặc cụm từ" />
                    <span className={styles.kind}>{KIND_VI[d.kind]}{d.partOfSpeech ? ` · ${d.partOfSpeech}` : ""}</span>
                    {d.ipa && <span className={styles.meta} title="Từ từ điển">{d.ipa}</span>}
                    {d.cefr && <span className={styles.meta} title="Trình độ CEFR theo từ điển">{d.cefr}</span>}
                    {d.alreadySaved && !done && <span className={styles.dup}>Đã có trong Flashcards</span>}
                    <span className="ml-auto flex gap-1">
                      <button type="button" className={styles.iconBtn} onClick={() => void regenerate(d)} disabled={busy || saving || done || !!d.regenerating || !ai.allowed} aria-label={`Tạo lại thẻ ${d.term}`} title="Tạo lại thẻ này">
                        {d.regenerating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RotateCcw className="h-4 w-4" aria-hidden="true" />}
                      </button>
                      <button type="button" className={styles.iconBtn} onClick={() => setDrafts((prev) => prev.filter((x) => x.draftId !== d.draftId))} disabled={saving || d.save === "saving"} aria-label={`Bỏ thẻ ${d.term}`} title="Bỏ gợi ý này">
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </span>
                  </div>
                  <label className={styles.field}>
                    <span>Nghĩa trong ngữ cảnh</span>
                    <textarea rows={2} value={d.meaning} maxLength={2000} disabled={done || saving} lang="vi" onChange={(e) => update(d.draftId, { meaning: e.target.value })} />
                  </label>
                  {d.dictionaryMeaningVi && d.dictionaryMeaningVi !== d.meaning && !done && (
                    <p className={styles.dictLine}>
                      <span>Từ điển:</span> {d.dictionaryMeaningVi}
                      <button type="button" className={styles.linkish} onClick={() => update(d.draftId, { meaning: d.dictionaryMeaningVi || d.meaning })}>Dùng nghĩa từ điển</button>
                    </p>
                  )}
                  {d.definitionEn && <p className={styles.defLine} lang="en">{d.definitionEn}</p>}
                  <blockquote className={styles.source}>
                    <p lang="en">{highlightTerm(d.sourceSentence, d.term)}</p>
                    {d.sentenceVi && <p lang="vi" className={styles.sourceVi}>{d.sentenceVi}</p>}
                    <cite>Câu gốc trong đoạn của bạn{sourceLabel ? ` · ${sourceLabel}` : ""} — sẽ lưu làm ví dụ</cite>
                  </blockquote>
                  {d.save === "saving" && <p className={styles.note}>Đang lưu…</p>}
                  {d.save === "created" && <p className={styles.ok}>Đã lưu vào Flashcards.</p>}
                  {d.save === "existing" && <p className={styles.note}>Từ này đã có trong Flashcards của bạn — nghĩa cũ được giữ nguyên.</p>}
                  {err && <p className={styles.error} role="alert">{err}</p>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </TidesDialog>
  );
}

export default CardStudio;
