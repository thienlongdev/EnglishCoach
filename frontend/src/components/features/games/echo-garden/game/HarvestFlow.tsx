"use client";

import React, { useEffect, useRef, useState } from "react";
import { Check, X as XIcon, Moon } from "lucide-react";
import type { GardenHarvestChallenge, GardenHarvestResult, GardenState } from "@/types/garden";
import { ActionButton, CoinIcon, EASE, FOCUS_RING, PANEL } from "./gardenUi";
import { FORM_LABEL, TIER_LABEL, cropIconUrl } from "./gardenModel";

/*
 * Harvest moment (GDD 04 §6 HarvestQuiz + "Kết quả thu hoạch"). The server keeps the answers, so the quiz records
 * choices calmly and the result reveals each answer: no fake instant right/wrong, no hard timer. Then the staged
 * result: the quality ribbon, the five component scores, new codex forms, XP and, when it happens, the level-up card.
 */

const TIER_STYLE: Record<string, { ribbon: string; text: string }> = {
  NORMAL: { ribbon: "from-[#c9d1e6] to-[#9aa6c4]", text: "text-[#1d2340]" },
  GOOD: { ribbon: "from-[#8fdca2] to-[#5fb97a]", text: "text-[#0f2a18]" },
  PERFECT: { ribbon: "from-[#9fd8ff] to-[#5ea9e8]", text: "text-[#0b2440]" },
  GOLDEN: { ribbon: "from-[#FFE08A] to-[#F4B63F]", text: "text-[#3a2a0a]" },
};

interface HarvestFlowProps {
  state: GardenState;
  plantingIds: number[];
  reducedMotion: boolean;
  start: (ids: number[]) => Promise<GardenHarvestChallenge | null>;
  complete: (c: GardenHarvestChallenge, answers: Array<number | null>, skip: boolean) => Promise<GardenHarvestResult | null>;
  onDone: (result: GardenHarvestResult | null) => void;
}

export function HarvestFlow({ state, plantingIds, reducedMotion, start, complete, onDone }: HarvestFlowProps) {
  const [challenge, setChallenge] = useState<GardenHarvestChallenge | null>(null);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Array<number | null>>([]);
  const [chosen, setChosen] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<GardenHarvestResult | null>(null);
  const started = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start(plantingIds).then((c) => {
      if (!c) onDone(null);
      else setChallenge(c);
    });
  }, [start, plantingIds, onDone]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, [challenge, result]);

  const submit = async (list: Array<number | null>, skip: boolean) => {
    if (!challenge || submitting) return;
    setSubmitting(true);
    const r = await complete(challenge, list, skip);
    setSubmitting(false);
    if (!r) {
      onDone(null);
      return;
    }
    setResult(r);
  };

  const choose = (option: number) => {
    if (!challenge || chosen !== null || submitting) return;
    setChosen(option);
    const next = [...answers, option];
    window.setTimeout(() => {
      setAnswers(next);
      setChosen(null);
      if (next.length >= challenge.questions.length) void submit(next, false);
      else setIndex((i) => i + 1);
    }, reducedMotion ? 120 : 420);
  };

  const cropName = (code: string) => state.crops.find((c) => c.code === code)?.nameVi ?? code;
  const q = challenge?.questions[index];

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-end justify-center bg-[#070b1f]/55 backdrop-blur-[2px] sm:items-center" role="presentation">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="garden-harvest-title"
        data-testid="garden-harvest-dialog"
        className={`${PANEL} w-full max-w-[440px] rounded-t-[26px] p-5 outline-none max-sm:max-h-[86dvh] max-sm:overflow-y-auto max-sm:pb-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] sm:rounded-[28px_24px_30px_26px] motion-safe:animate-[eg-sheet-in_320ms_cubic-bezier(0.22,1,0.36,1)]`}
      >
        {!result && (
          <>
            <div className="flex items-center justify-between">
              <h2 id="garden-harvest-title" className="text-base font-black text-[#EEF3FF]">
                Thu hoạch {plantingIds.length > 1 ? `${plantingIds.length} ô` : cropName(state.plots.find((p) => p.planting && plantingIds.includes(p.planting.id))?.planting?.cropCode ?? "")}
              </h2>
              <div className="flex gap-1.5" aria-label={`Câu ${Math.min(index + 1, challenge?.questions.length ?? 3)} trên ${challenge?.questions.length ?? 3}`}>
                {(challenge?.questions ?? [0, 1, 2]).map((_, i) => (
                  <span key={i} className={`h-2.5 w-2.5 rounded-full ${i < answers.length ? "bg-[#74C98B]" : i === index ? "bg-[#EEF3FF]" : "bg-white/20"}`} />
                ))}
              </div>
            </div>
            {!challenge && <p className="mt-6 pb-6 text-center text-sm text-[#EEF3FF]/70">Echo đang chuẩn bị câu hỏi từ thẻ của bạn…</p>}
            {challenge && q && (
              <div key={q.index} className="motion-safe:animate-[eg-sheet-in_260ms_cubic-bezier(0.22,1,0.36,1)]">
                <p className="mt-4 text-center text-[11px] font-semibold text-[#EEF3FF]/60">
                  {q.direction === "EN_VI" ? "Chọn nghĩa đúng" : "Chọn từ tiếng Anh đúng"}
                </p>
                <p className="mt-1 text-center text-[30px] font-black leading-tight text-[#EEF3FF]" lang={q.direction === "EN_VI" ? "en" : "vi"}>{q.prompt}</p>
                {q.ipa && <p className="mt-0.5 text-center text-sm text-[#EEF3FF]/60">{q.ipa}</p>}
                <div className="mt-4 flex flex-col gap-2" role="radiogroup" aria-label="Các đáp án">
                  {q.options.map((opt, i) => (
                    <button
                      key={i}
                      type="button"
                      role="radio"
                      aria-checked={chosen === i}
                      data-testid={`garden-quiz-option-${i}`}
                      disabled={chosen !== null || submitting}
                      onClick={() => choose(i)}
                      lang={q.direction === "EN_VI" ? "vi" : "en"}
                      className={`min-h-[52px] rounded-[16px_13px_16px_14px] border px-4 text-left text-[15px] font-semibold transition-[background-color,border-color,transform] duration-200 ${EASE} active:scale-[0.98] ${FOCUS_RING} cursor-pointer disabled:cursor-default ${
                        chosen === i ? "border-[#FFE2A0]/70 bg-[#FFE2A0]/15 text-white" : "border-white/10 bg-black/20 text-[#EEF3FF] hover:bg-white/10"
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void submit([], true)}
                  data-testid="garden-quiz-skip"
                  className={`mt-3 w-full rounded-xl py-2 text-center text-[12px] font-semibold text-[#EEF3FF]/60 underline-offset-4 hover:text-[#EEF3FF] hover:underline ${FOCUS_RING} cursor-pointer`}
                >
                  Thu nhanh, bỏ qua câu hỏi (điểm Nhớ lại = 0)
                </button>
              </div>
            )}
            {submitting && <p className="mt-3 text-center text-xs text-[#EEF3FF]/60" aria-live="polite">Đang thu hoạch…</p>}
          </>
        )}
        {result && <HarvestResultView result={result} cropName={cropName} onClose={() => onDone(result)} />}
      </div>
    </div>
  );
}

function HarvestResultView({ result, cropName, onClose }: { result: GardenHarvestResult; cropName: (c: string) => string; onClose: () => void }) {
  const best = [...result.harvests].sort((a, b) => b.score - a.score)[0];
  const style = TIER_STYLE[best?.tier ?? "NORMAL"];
  const levelUp = result.level.after > result.level.before;
  const c = best?.components;
  const seasonLabel = (v: number) => (v >= 20 ? "Đúng mùa" : v >= 10 ? "Mọi mùa" : "Sai mùa");
  return (
    <div data-testid="garden-harvest-result" aria-live="polite">
      <h2 id="garden-harvest-title" className="sr-only">Kết quả thu hoạch</h2>
      <div className="flex items-center justify-center gap-2">
        {result.harvests.slice(0, 6).map((h, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={h.plantingId} src={cropIconUrl(h.cropCode)} alt="" className="h-14 w-14 object-contain motion-safe:animate-[eg-pop_420ms_cubic-bezier(0.22,1,0.36,1)_both]" style={{ animationDelay: `${i * 60}ms` }} />
        ))}
      </div>
      <div className={`mx-auto mt-3 w-fit rounded-[14px_10px_14px_12px] bg-gradient-to-b px-5 py-1.5 text-center shadow-[0_10px_22px_-12px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.5)] motion-safe:animate-[eg-ribbon_520ms_cubic-bezier(0.22,1,0.36,1)_220ms_both] ${style.ribbon}`}>
        <p className={`text-xl font-black tracking-wide ${style.text}`} data-testid="garden-result-tier">{TIER_LABEL[best?.tier ?? "NORMAL"]}</p>
        <p className={`text-[11px] font-bold ${style.text} opacity-80`}>{best?.score ?? 0}/100 điểm chất lượng</p>
      </div>
      {result.harvests.length > 1 && (
        <p className="mt-2 text-center text-[12px] text-[#EEF3FF]/70">
          {result.harvests.map((h) => `${cropName(h.cropCode)} ${TIER_LABEL[h.tier]}`).join(", ")}
        </p>
      )}
      {c && (
        <ul className="mt-4 grid grid-cols-2 gap-1.5 text-[12px] sm:grid-cols-3">
          {[
            ["Nhớ lại", `${c.recall}/30`],
            ["Không sâu", `${c.pest}`],
            [seasonLabel(c.season), `${c.season}`],
            ["Có chăm", `${c.care}`],
            ["Tươi", `${c.fresh}`],
          ].map(([label, value], i) => (
            <li key={label} className="flex items-center justify-between rounded-[12px] border border-white/10 bg-black/20 px-2.5 py-1.5 motion-safe:animate-[eg-sheet-in_320ms_cubic-bezier(0.22,1,0.36,1)_both]" style={{ animationDelay: `${420 + i * 70}ms` }}>
              <span className="text-[#EEF3FF]/70">{label}</span>
              <b className="tabular-nums text-[#EEF3FF]">{value}</b>
            </li>
          ))}
        </ul>
      )}
      {!result.recall.skipped && result.recall.total > 0 && (
        <p className="mt-3 text-center text-[12px] text-[#EEF3FF]/75">
          Trả lời đúng {result.recall.correct}/{result.recall.total} câu
          <span className="ml-1.5 inline-flex gap-1 align-middle">
            {result.recall.answers.map((a) => (a.correct
              ? <Check key={a.index} className="h-3.5 w-3.5 text-[#74C98B]" aria-label="đúng" />
              : <XIcon key={a.index} className="h-3.5 w-3.5 text-[#F2777A]" aria-label="sai" />))}
          </span>
        </p>
      )}
      {/* Phase 3G: a crop a visitor took a little from pays its remaining portions instead of the whole unit */}
      {result.harvests.filter((h) => (h.sharePortions ?? 0) > 0).map((h) => (
        <p key={`share-${h.plantingId}`} className="mt-3 rounded-[14px] border border-[#F2A36B]/30 bg-[#F2A36B]/10 px-3 py-2 text-[12px] leading-relaxed text-[#ffd2b0]" data-testid="garden-harvest-share">
          {cropName(h.cropCode)}: một vị khách đã lấy một ít, bạn nhận {h.sharePortions}/{h.shareUnit} phần. Đủ {h.shareUnit} phần cùng loại và cùng hạng sẽ tự gộp thành 1 nông sản trong Kho.
        </p>
      ))}
      {result.harvests.some((h) => h.newForms.length > 0) && (
        <div className="mt-3 rounded-[14px] border border-[#F4B63F]/25 bg-[#F4B63F]/10 px-3 py-2 text-[12px] text-[#FFE7A8]">
          {result.harvests.flatMap((h) => h.newForms.map((f) => (
            <p key={`${h.plantingId}-${f}`} className="flex items-center gap-1.5">
              {f === "MOONLIT" && <Moon className="h-3.5 w-3.5" aria-hidden />}
              Dạng mới trong Sổ Hạt Giống: {cropName(h.cropCode)} {FORM_LABEL[f] ?? f}
            </p>
          )))}
        </div>
      )}
      <p className="mt-3 flex items-center justify-center gap-3 text-center text-sm font-black text-[#a6e6b3]">
        <span>+{result.xpGained} XP</span>
        {!!result.coinsGained && (
          <span className="flex items-center gap-1 text-[#FFD978]" data-testid="garden-harvest-coins" aria-label={`Thưởng thu hoạch ${result.coinsGained} Đồng Echo`}>
            <CoinIcon className="h-4 w-4" />+{result.coinsGained}
          </span>
        )}
      </p>
      {levelUp && (
        <div className="mt-3 rounded-[18px_14px_18px_16px] border border-[#74C98B]/30 bg-[#74C98B]/10 px-3 py-2.5 text-center motion-safe:animate-[eg-ribbon_520ms_cubic-bezier(0.22,1,0.36,1)_700ms_both]" data-testid="garden-level-up">
          <p className="text-base font-black text-[#EEF3FF]">Lên Cấp {result.level.after}</p>
          {result.level.unlocked.length > 0 && (
            <p className="mt-0.5 text-[12px] text-[#EEF3FF]/80">Mở khóa: {result.level.unlocked.map((u) => u.nameVi).join(", ")}</p>
          )}
        </div>
      )}
      <p className="mt-2 text-center text-[11px] leading-snug text-[#EEF3FF]/60">
        {result.coinsGained ? "Thưởng thu hoạch đã vào ví. " : ""}Nông sản đã vào Kho: bán, giao đơn hoặc ủ phân tuỳ bạn.
      </p>
      <ActionButton tone="reward" className="mt-4 w-full" onClick={onClose} testId="garden-result-close">
        Tuyệt, tiếp tục
      </ActionButton>
    </div>
  );
}
