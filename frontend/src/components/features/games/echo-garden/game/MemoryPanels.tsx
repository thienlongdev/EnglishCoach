"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Check, ChevronLeft, Lock, RotateCcw, Search, Sprout, Trees, X, X as XIcon } from "lucide-react";
import { gardenApi } from "@/services/gardenApi";
import type {
  GardenCandidate, GardenCandidates, GardenForestTree, GardenGraduationChallenge, GardenGraduationResult, GardenPest,
  GardenSlot, GardenState, GardenTree, GardenTreeCard,
} from "@/types/garden";
import type { EchoGardenGame } from "./useEchoGarden";
import { ActionButton, Chip, EASE, EssenceIcon, FOCUS_RING, GardenSheet, PANEL } from "./gardenUi";
import {
  BLOCKER_LABEL, HEALTH_LABEL, SPECIES_LABEL, TREE_STAGE_LABEL, clockTime, formatDuration, formatNumber, treeSpriteKey, PEST_STAGE_LABEL, pestStageNote
} from "./gardenModel";

/*
 * Phase 2 memory panels. Copy is honest: a tree's growth is "days you reviewed these words", graduation means the words
 * were cared for over at least 14 days — never "mastered forever". All numbers come from the server state.
 */

const dayMonth = new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", timeZone: "Asia/Ho_Chi_Minh" });
/** "dd/MM" (vi-VN prints day + month alone as "dd-MM", unlike the full "dd/MM/yyyy" date) */
const dateFmt = {
  format: (ms: number) => {
    const parts = dayMonth.formatToParts(ms);
    return `${parts.find((x) => x.type === "day")?.value}/${parts.find((x) => x.type === "month")?.value}`;
  },
};
const fullDate = new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" });
const treeIcon = (t: { species: GardenTree["species"]; stage: number }) => `/garden/world/${treeSpriteKey(t.species, t.stage)}.webp`;

function CloseButton({ onClose, label }: { onClose: () => void; label: string }) {
  return (
    <button type="button" onClick={onClose} aria-label={label}
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/80 transition-[background-color,color,transform] duration-200 ${EASE} hover:bg-white/20 hover:text-white active:scale-[0.94] ${FOCUS_RING} cursor-pointer sm:h-9 sm:w-9`}>
      <X className="h-4 w-4" />
    </button>
  );
}

function statusLabel(c: { present: boolean; status: string | null }) {
  if (!c.present) return "Đã xoá";
  return c.status === "MASTERED" ? "Đã thuộc" : c.status === "LEARNED" ? "Đã học" : "Mới";
}

/** Evidence dots: one per distinct review day after planting (capped). */
function Dots({ n, cap = 3 }: { n: number; cap?: number }) {
  return (
    <span className="inline-flex gap-0.5" role="img" aria-label={`${n} ngày ôn`}>
      {Array.from({ length: cap }, (_, i) => (
        <span key={i} className={`h-1.5 w-1.5 rounded-full ${i < n ? "bg-[#3fcfc0]" : "bg-white/15"}`} />
      ))}
    </span>
  );
}

// ======================================================================== review card (rescue + tree care)

/**
 * The existing Flashcard review, in the garden: the learner recalls the word, reveals the meaning and grades it with
 * the SAME three ratings as the Flashcards screen (Khó / Tốt / Dễ → PUT /flashcards/{id}/review). Garden never grades.
 */
export function ReviewCard({ word, meaning, ipa, busy, onRate, onCancel }: {
  word: string; meaning: string | null; ipa: string | null; busy: boolean;
  onRate: (q: "hard" | "good" | "easy") => void; onCancel: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  // the card opens below the word list: bring it into view (instantly under reduced motion)
  useEffect(() => {
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    cardRef.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [revealed]);
  return (
    <div ref={cardRef} className="mt-3 rounded-[18px_14px_18px_16px] border border-white/10 bg-black/25 p-3.5" data-testid="garden-review-card">
      <p className="text-[11px] font-semibold text-[#EEF3FF]/55">Nhớ lại nghĩa rồi lật thẻ</p>
      <p className="mt-1 text-center text-[26px] font-black text-[#EEF3FF]" lang="en">{word}</p>
      {ipa && <p className="text-center text-sm text-[#EEF3FF]/60">{ipa}</p>}
      {revealed ? (
        <>
          <p className="mt-2 text-center text-[15px] font-semibold text-[#FFE7A8]" lang="vi">{meaning ?? "—"}</p>
          <p className="mt-3 text-center text-[11px] text-[#EEF3FF]/60">Bạn nhớ từ này thế nào? (giống màn hình Thẻ từ vựng)</p>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {([["hard", "Khó"], ["good", "Tốt"], ["easy", "Dễ"]] as const).map(([q, label]) => (
              <ActionButton key={q} tone={q === "hard" ? "quiet" : "care"} disabled={busy} onClick={() => onRate(q)} testId={`garden-review-${q}`}>
                {label}
              </ActionButton>
            ))}
          </div>
        </>
      ) : (
        <div className="mt-3 flex gap-2">
          <ActionButton tone="reward" className="flex-1" onClick={() => setRevealed(true)} testId="garden-review-reveal">Lật thẻ</ActionButton>
          <ActionButton tone="quiet" onClick={onCancel}>Để sau</ActionButton>
        </div>
      )}
    </div>
  );
}

// ======================================================================== pest

export function PestPanel({ game, pest, onClose }: { game: EchoGardenGame; pest: GardenPest; onClose: () => void }) {
  const state = game.state!;
  const [reviewing, setReviewing] = useState(false);
  const host = pest.host === "CROP"
    ? `trên luống #${pest.plotSlot ?? "?"}`
    : `dưới Cây Ký Ức ở chỗ trồng #${state.knowledge.slots.find((s) => s.tree?.id === pest.treeId)?.slot ?? "?"}`;
  const planting = pest.plantingId ? state.plots.find((p) => p.planting?.id === pest.plantingId)?.planting : null;
  return (
    <GardenSheet labelledBy="garden-pest-title" onClose={onClose} testId="garden-pest-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/garden/world/forgotten_pest.webp" alt="" className="h-12 w-12 shrink-0 object-contain" />
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-[#c9b8ff]">Sâu Lãng Quên · {host}</p>
            <h2 id="garden-pest-title" className="mt-0.5 text-lg font-black leading-tight text-[#EEF3FF]" lang="en">{pest.word}</h2>
          </div>
        </div>
        <CloseButton onClose={onClose} label="Đóng bảng Sâu Lãng Quên" />
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-[#EEF3FF]/80">
        Từ này đã quá hạn ôn trong bộ thẻ của bạn. Sâu không bao giờ làm chết cây: ôn lại từ này một lần (chọn Khó, Tốt hay Dễ
        đều được tính) là sâu rời đi ngay.
      </p>
      {pest.host === "CROP" && !pest.reviewed && (
        <div className="mt-2 rounded-[14px] border border-white/10 bg-black/20 px-3 py-2" data-testid="garden-pest-stage">
          <ol className="flex items-center gap-1" aria-label={PEST_STAGE_LABEL[pest.stage]}>
            {[1, 2, 3].map((st) => (
              <li key={st} className="flex flex-1 flex-col gap-1">
                <span className={`h-1.5 rounded-full ${st <= pest.stage ? (pest.stage === 3 ? "bg-[#F2A36B]" : pest.stage === 2 ? "bg-[#f0cf6a]" : "bg-[#c9b8ff]") : "bg-white/12"}`} />
                <span className={`text-[10px] font-semibold ${st === pest.stage ? "text-[#EEF3FF]" : "text-[#EEF3FF]/45"}`}>{st === 1 ? "Xuất hiện" : st === 2 ? "Gặm lá" : "Cây héo"}</span>
              </li>
            ))}
          </ol>
          <p className="mt-1.5 text-[12px] leading-snug text-[#EEF3FF]/75">{pestStageNote(pest.stage, !!planting?.ready)}</p>
          {pest.nextStageAt && (
            <p className="mt-1 text-[11px] text-[#EEF3FF]/55">
              Nếu chưa ôn, {pest.stage === 1 ? "lá bắt đầu bị gặm" : "cây bắt đầu héo"} lúc {clockTime(Date.parse(pest.nextStageAt))}.
            </p>
          )}
          {pest.stage >= 2 && !planting?.ready && (
            <p className="mt-1 text-[11px] text-[#EEF3FF]/55">
              {pest.tended ? "Bạn đã tưới hoặc bón nên cây đỡ chậm hơn một nửa." : "Tưới hoặc bón phân giúp cây đỡ chậm trong lúc chờ, nhưng chỉ ôn từ mới làm sâu rời đi."}
            </p>
          )}
        </div>
      )}
      {reviewing ? (
        <>
          {/* the review is the whole cure: the server confirms it from the review log and the pest leaves; the sheet
              closes only then (a failed confirmation keeps it open with the reason shown as a toast) */}
          <ReviewCard word={pest.word} meaning={pest.meaningVi} ipa={pest.ipa} busy={game.busy !== null}
            onCancel={() => setReviewing(false)}
            onRate={(q) => void game.rescueReview(pest.flashcardId, q).then((gone) => (gone ? onClose() : setReviewing(false)))} />
          <p className="mt-1.5 text-[11px] leading-snug text-[#EEF3FF]/55" data-testid="garden-pest-hard-note">
            Chọn “Khó” thì sâu vẫn rời đi, nhưng từ này còn nằm trong hàng ôn: để quá hạn thêm một ngày nữa, sâu có thể quay lại.
          </p>
        </>
      ) : (
        <>
          <ActionButton tone="care" className="mt-3 w-full" onClick={() => setReviewing(true)} testId="garden-pest-review">
            <BookOpen className="h-4 w-4" aria-hidden /> Ôn từ này ngay
          </ActionButton>
          <p className="mt-1.5 text-center text-[11px] text-[#EEF3FF]/55" data-testid="garden-pest-reward">
            Thưởng {state.learning.pestCuresToday < state.learning.pestCureCap ? "+5 XP" : "(đã đủ thưởng hôm nay)"}
          </p>
        </>
      )}
    </GardenSheet>
  );
}

// ======================================================================== grove

export function KnowledgePanel({ game, initialSlot, onClose, onOpenForest }: {
  game: EchoGardenGame; initialSlot: number | null; onClose: () => void; onOpenForest: () => void;
}) {
  const state = game.state!;
  const k = state.knowledge;
  const [slot, setSlot] = useState<number | null>(initialSlot);
  const [mode, setMode] = useState<"view" | "plant" | "graduate">("view");
  // the tree being graduated is kept here: a passed graduation removes it from the grove state, and the result
  // (rewards, the Crystal Orchid seed) must stay on screen until the learner continues
  const [graduating, setGraduating] = useState<GardenTree | null>(null);
  useEffect(() => {
    setSlot(initialSlot);
    setMode("view");
  }, [initialSlot]);
  const selected = slot ? k.slots.find((s) => s.slot === slot) ?? null : null;

  if (mode === "graduate" && graduating) {
    return <GraduationFlow game={game} tree={graduating} onDone={() => { setGraduating(null); setMode("view"); }} />;
  }
  return (
    <GardenSheet labelledBy="garden-grove-title" onClose={onClose} testId="garden-grove-panel" wide>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-[#7fe0d0]">Cây Tri Thức · Vườn ký ức</p>
          <h2 id="garden-grove-title" className="mt-0.5 text-lg font-black leading-tight text-[#EEF3FF]">
            {selected ? (selected.tree ? SPECIES_LABEL[selected.tree.species] : `Chỗ trồng #${selected.slot}`) : "Ba chỗ trồng thiêng"}
          </h2>
        </div>
        <CloseButton onClose={onClose} label="Đóng vườn ký ức" />
      </div>
      {selected && (
        <button type="button" onClick={() => { setSlot(null); setMode("view"); }}
          className={`mt-1 inline-flex items-center gap-1 rounded-lg px-1 py-1 text-[12px] font-semibold text-[#EEF3FF]/60 hover:text-[#EEF3FF] ${FOCUS_RING} cursor-pointer`}>
          <ChevronLeft className="h-3.5 w-3.5" /> Cả vườn
        </button>
      )}
      {!selected && <GroveOverview slots={k.slots} forestCount={k.forestCount} onPick={setSlot} onOpenForest={onOpenForest} />}
      {selected && !selected.unlocked && (
        <p className="mt-3 flex items-center gap-1.5 text-[13px] text-[#EEF3FF]/75"><Lock className="h-4 w-4" />Chỗ trồng này mở ở Cấp {selected.unlockLevel}.</p>
      )}
      {selected && selected.unlocked && !selected.tree && mode !== "plant" && (
        <div className="mt-3 border-t border-white/10 pt-3">
          <p className="text-[13px] leading-relaxed text-[#EEF3FF]/80">
            Chọn 5 từ trong bộ thẻ của bạn để trồng một Cây Ký Ức. Cây lớn theo số ngày bạn thật sự ôn 5 từ này; sau ít nhất 14 ngày,
            nếu 5 từ đều được chăm, cây có thể tốt nghiệp vào Rừng Ký Ức.
          </p>
          <ActionButton tone="care" className="mt-3 w-full" onClick={() => setMode("plant")} testId="garden-tree-start-plant">
            <Sprout className="h-4 w-4" aria-hidden /> Chọn 5 từ để trồng
          </ActionButton>
        </div>
      )}
      {selected && selected.unlocked && !selected.tree && mode === "plant" && (
        <CardPicker game={game} slot={selected.slot} onCancel={() => setMode("view")} onPlanted={() => setMode("view")} />
      )}
      {selected?.tree && <TreeDetail game={game} tree={selected.tree} onGraduate={() => { setGraduating(selected.tree); setMode("graduate"); }} />}
    </GardenSheet>
  );
}

function GroveOverview({ slots, forestCount, onPick, onOpenForest }: {
  slots: GardenSlot[]; forestCount: number; onPick: (slot: number) => void; onOpenForest: () => void;
}) {
  return (
    <div className="mt-3 border-t border-white/10 pt-3">
      <p className="text-[12px] leading-relaxed text-[#EEF3FF]/70">
        Cây Tri Thức giữ ba chỗ trồng thiêng. Mỗi Cây Ký Ức mang 5 từ của bạn và dáng của mùa nó được gieo.
      </p>
      <ul className="mt-3 flex flex-col gap-2" data-testid="garden-grove-slots">
        {slots.map((s) => (
          <li key={s.slot}>
            <button type="button" onClick={() => onPick(s.slot)} data-testid={`garden-grove-slot-${s.slot}`}
              className={`flex w-full items-center gap-3 rounded-[16px_13px_16px_14px] border border-white/10 bg-black/20 px-2.5 py-2 text-left transition-colors duration-200 hover:bg-white/[0.08] ${FOCUS_RING} cursor-pointer`}>
              {s.tree ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={treeIcon(s.tree)} alt="" className="h-12 w-12 shrink-0 object-contain" />
              ) : (
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-dashed border-white/20 text-[#EEF3FF]/50">
                  {s.unlocked ? <Sprout className="h-5 w-5" /> : <Lock className="h-4 w-4" />}
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold text-[#EEF3FF]">
                  {s.tree ? SPECIES_LABEL[s.tree.species] : s.unlocked ? `Chỗ trồng #${s.slot} đang trống` : `Chỗ trồng #${s.slot}`}
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-1">
                  {s.tree ? (
                    <>
                      <Chip tone="magic">{TREE_STAGE_LABEL[s.tree.stage]}</Chip>
                      <Chip tone={s.tree.health === "HEALTHY" ? "good" : "warn"}>{HEALTH_LABEL[s.tree.health]}</Chip>
                      {s.tree.essence.claimable && <Chip tone="magic"><EssenceIcon className="h-3 w-3" />{s.tree.essence.available}</Chip>}
                      {s.tree.graduation.eligible && <Chip tone="good">Sẵn sàng tốt nghiệp</Chip>}
                    </>
                  ) : (
                    <span className="text-[11px] text-[#EEF3FF]/55">{s.unlocked ? "Chạm để trồng" : `Mở ở Cấp ${s.unlockLevel}`}</span>
                  )}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={onOpenForest} data-testid="garden-open-forest"
        className={`mt-3 flex w-full items-center justify-between rounded-[16px_13px_16px_14px] border border-[#9fd47e]/25 bg-[#9fd47e]/10 px-3 py-2.5 text-left text-[13px] font-bold text-[#cfeab6] hover:bg-[#9fd47e]/15 ${FOCUS_RING} cursor-pointer`}>
        <span className="flex items-center gap-2"><Trees className="h-4 w-4" />Rừng Ký Ức</span>
        <span className="tabular-nums">{formatNumber(forestCount)} cây đã tốt nghiệp</span>
      </button>
    </div>
  );
}

function TreeDetail({ game, tree, onGraduate }: { game: EchoGardenGame; tree: GardenTree; onGraduate: () => void }) {
  const state = game.state!;
  const now = game.serverNow();
  const [review, setReview] = useState<GardenTreeCard | null>(null);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const pct = Math.round((tree.evidence / Math.max(1, tree.maxEvidence)) * 100);
  const ageReached = Date.parse(tree.graduation.ageReachedAt);
  const pests = state.pests.filter((p) => tree.pestIds.includes(p.id));
  return (
    <div className="mt-2" data-testid="garden-tree-detail">
      <div className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={treeIcon(tree)} alt="" className="h-16 w-16 shrink-0 object-contain" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap gap-1">
            <Chip tone="magic">{TREE_STAGE_LABEL[tree.stage]}</Chip>
            <Chip tone={tree.health === "HEALTHY" ? "good" : "warn"} testId="garden-tree-health">{HEALTH_LABEL[tree.health]}</Chip>
            <Chip>{tree.ageDays} ngày tuổi</Chip>
          </div>
          <div className="mt-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Bằng chứng ôn tập">
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-gradient-to-r from-[#2bb3a6] to-[#9cefe0]" style={{ width: `${Math.max(3, pct)}%` }} />
            </div>
            <p className="mt-1 text-[11px] text-[#EEF3FF]/65">{tree.evidence}/{tree.maxEvidence} ngày ôn (mỗi từ tính tối đa 3 ngày khác nhau sau khi trồng)</p>
          </div>
        </div>
      </div>
      {tree.next && (
        <p className="mt-2 text-[12px] text-[#EEF3FF]/70" data-testid="garden-tree-next">
          Lên {TREE_STAGE_LABEL[tree.next.stage]}:
          {tree.next.evidenceMissing > 0 ? ` cần thêm ${tree.next.evidenceMissing} ngày ôn` : ""}
          {tree.next.cardsBelowMinimum > 0 ? `${tree.next.evidenceMissing > 0 ? "," : ""} ${tree.next.cardsBelowMinimum} từ cần được ôn thêm` : ""}
          {Date.parse(tree.next.reachableAt) > now ? `${tree.next.evidenceMissing > 0 || tree.next.cardsBelowMinimum > 0 ? "," : ""} sớm nhất ngày ${dateFmt.format(Date.parse(tree.next.reachableAt))}` : ""}.
        </p>
      )}
      <ul className="mt-3 flex flex-col gap-1.5" data-testid="garden-tree-words">
        {tree.cards.map((c) => (
          <li key={c.flashcardId} className={`flex items-center gap-2 rounded-[14px] border px-2.5 py-2 ${c.needsAttention ? "border-[#F2A36B]/35 bg-[#F2A36B]/10" : "border-white/10 bg-black/20"}`}>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-bold text-[#EEF3FF]"><span lang="en">{c.word}</span> <span className="font-normal text-[#EEF3FF]/60" lang="vi">· {c.meaningVi}</span></p>
              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-[#EEF3FF]/60">
                <Dots n={c.evidence} />
                <span>{statusLabel(c)}</span>
                {c.overdue && <span className="font-bold text-[#ffd2b0]">Quá hạn ôn</span>}
                {!c.overdue && c.due && c.present && <span>Đến hạn ôn</span>}
                {c.reviewedToday && <span className="text-[#a6e6b3]">Đã ôn hôm nay</span>}
              </p>
            </div>
            {c.present && !c.reviewedToday && (
              <ActionButton tone={c.needsAttention ? "care" : "quiet"} className="min-h-[34px] px-2.5 py-1 text-xs" onClick={() => setReview(c)} testId={`garden-tree-review-${c.flashcardId}`}>
                Ôn
              </ActionButton>
            )}
          </li>
        ))}
      </ul>
      {review && (
        <ReviewCard word={review.word} meaning={review.meaningVi} ipa={null} busy={game.busy !== null} onCancel={() => setReview(null)}
          onRate={(q) => void game.rescueReview(review.flashcardId, q).then(() => setReview(null))} />
      )}
      {pests.length > 0 && (
        <p className="mt-2 text-[12px] text-[#c9b8ff]">Một Sâu Lãng Quên đang chờ ở gốc cây: ôn từ “{pests[0].word}” là sâu rời đi ngay.</p>
      )}
      <div className="mt-3 rounded-[16px_13px_16px_14px] border border-[#3fcfc0]/25 bg-[#3fcfc0]/[0.08] p-3">
        <p className="flex items-center gap-1.5 text-[13px] font-bold text-[#9cefe0]">
          <EssenceIcon /> Tinh chất Ký Ức: {tree.essence.available}
          <span className="font-normal text-[#EEF3FF]/60">({String(tree.essence.accrued).replace(".", ",")}/{tree.essence.store} đang tích)</span>
        </p>
        <p className="mt-1 text-[11px] text-[#EEF3FF]/60">
          {tree.essence.perDay > 0 ? `Cây khỏe tích ${String(tree.essence.perDay).replace(".", ",")} mỗi ngày, giữ tối đa ${tree.essence.store}.` : "Cây non chưa tạo Tinh chất."}
          {" "}Tinh chất cùng Đồng Echo mua hạt Hoa Trăng và Huệ Băng.
        </p>
        <ActionButton tone="care" className="mt-2 w-full" disabled={!tree.essence.claimable || game.busy !== null}
          onClick={() => void game.claimEssence(tree.id)} testId="garden-tree-essence">
          Thu Tinh chất
        </ActionButton>
        {!tree.essence.claimable && tree.health !== "HEALTHY" && <p className="mt-1 text-[11px] text-[#ffd2b0]">Ôn các từ cần chú ý để cây khỏe lại, Tinh chất vẫn được giữ.</p>}
      </div>
      <div className="mt-3 rounded-[16px_13px_16px_14px] border border-white/10 bg-black/20 p-3" data-testid="garden-tree-graduation">
        <p className="text-[13px] font-bold text-[#EEF3FF]">Tốt nghiệp vào Rừng Ký Ức</p>
        {tree.graduation.eligible ? (
          <p className="mt-1 text-[12px] text-[#a6e6b3]">5 từ đã được chăm qua nhiều ngày. Trả lời đúng {tree.graduation.pass}/{tree.graduation.questions} để tốt nghiệp.</p>
        ) : (
          <ul className="mt-1 list-inside list-disc text-[12px] text-[#EEF3FF]/70">
            {tree.graduation.blockers.map((b) => (
              <li key={b}>{BLOCKER_LABEL[b] ?? b}{b === "AGE" ? ` (ngày ${fullDate.format(ageReached)})` : b === "RETRY_WAIT" && tree.graduation.retryAt ? ` (sau ${clockTime(Date.parse(tree.graduation.retryAt))})` : ""}</li>
            ))}
          </ul>
        )}
        <ActionButton tone="reward" className="mt-2 w-full" disabled={!tree.graduation.eligible || game.busy !== null} onClick={onGraduate} testId="garden-tree-graduate">
          Bắt đầu tốt nghiệp
        </ActionButton>
        <p className="mt-1.5 text-[11px] text-[#EEF3FF]/55">Phần thưởng: XP, Tinh chất và hạt Lan Pha Lê (chỉ có khi tốt nghiệp).</p>
      </div>
      <div className="mt-3 text-center">
        {confirmRelease ? (
          <div className="flex flex-wrap items-center justify-center gap-2 text-[12px] text-[#EEF3FF]/75">
            Nhổ cây? 5 từ được thả ra, không hoàn lại gì.
            <ActionButton tone="quiet" className="min-h-[34px] px-3 text-xs" onClick={() => void game.releaseTree(tree.id)} testId="garden-tree-release-confirm">Nhổ cây</ActionButton>
            <ActionButton tone="quiet" className="min-h-[34px] px-3 text-xs" onClick={() => setConfirmRelease(false)}>Giữ lại</ActionButton>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmRelease(true)} className={`rounded-lg px-2 py-1 text-[11px] font-semibold text-[#EEF3FF]/45 hover:text-[#EEF3FF]/80 ${FOCUS_RING} cursor-pointer`}>
            Nhổ cây này
          </button>
        )}
      </div>
    </div>
  );
}

function CardPicker({ game, slot, onCancel, onPlanted }: { game: EchoGardenGame; slot: number; onCancel: () => void; onPlanted: () => void }) {
  const [data, setData] = useState<GardenCandidates | null>(null);
  const [deck, setDeck] = useState<number | null | "all">("all");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<GardenCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);
  useEffect(() => {
    const id = ++reqId.current;
    const handle = window.setTimeout(() => {
      gardenApi.candidates(deck === "all" ? null : deck, q)
        .then((d) => id === reqId.current && setData(d))
        .catch(() => id === reqId.current && setError("Chưa tải được bộ thẻ, hãy thử lại."));
    }, q ? 300 : 0);
    return () => window.clearTimeout(handle);
  }, [deck, q]);
  const toggle = (c: GardenCandidate) => {
    setPicked((list) => list.some((x) => x.flashcardId === c.flashcardId)
      ? list.filter((x) => x.flashcardId !== c.flashcardId)
      : list.length >= 5 ? list : [...list, c]);
  };
  return (
    <div className="mt-3 border-t border-white/10 pt-3" data-testid="garden-card-picker">
      <p className="text-[12px] text-[#EEF3FF]/70">Chọn 5 từ có liên quan (cùng chủ đề sẽ dễ ôn hơn). Từ đang thuộc cây khác không chọn được.</p>
      {data && data.decks.length > 1 && (
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Bộ thẻ">
          {([{ deckId: "all" as const, title: "Tất cả", cards: 0 }, ...data.decks]).map((d) => (
            <button key={String(d.deckId)} type="button" role="tab" aria-selected={deck === d.deckId} onClick={() => setDeck(d.deckId)}
              className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-bold ${deck === d.deckId ? "border-[#3fcfc0]/50 bg-[#3fcfc0]/20 text-[#9cefe0]" : "border-white/10 bg-white/[0.05] text-[#EEF3FF]/70"} ${FOCUS_RING} cursor-pointer`}>
              {d.deckId === "all" ? "Tất cả" : d.title || "Thẻ riêng"}{d.deckId !== "all" ? ` (${d.cards})` : ""}
            </button>
          ))}
        </div>
      )}
      <label className="mt-2 flex items-center gap-2 rounded-[12px] border border-white/10 bg-black/25 px-2.5">
        <Search className="h-3.5 w-3.5 text-[#EEF3FF]/50" aria-hidden />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm từ…" aria-label="Tìm từ"
          className="h-9 w-full bg-transparent text-[13px] text-[#EEF3FF] placeholder:text-[#EEF3FF]/40 focus:outline-none" />
      </label>
      {error && <p className="mt-2 text-[12px] text-[#ffd3d4]">{error}</p>}
      {!data && !error && <p className="mt-3 text-center text-[12px] text-[#EEF3FF]/60">Đang mở bộ thẻ…</p>}
      {data && data.cards.length === 0 && <p className="mt-3 text-center text-[12px] text-[#EEF3FF]/60">Chưa có thẻ phù hợp. Hãy thêm từ trong Thẻ từ vựng.</p>}
      <ul className="mt-2 flex max-h-[38dvh] flex-col gap-1 overflow-y-auto pr-1">
        {data?.cards.map((c) => {
          const on = picked.some((x) => x.flashcardId === c.flashcardId);
          return (
            <li key={c.flashcardId}>
              <button type="button" disabled={c.bound} onClick={() => toggle(c)} aria-pressed={on} data-testid={`garden-candidate-${c.flashcardId}`}
                className={`flex w-full items-center gap-2 rounded-[12px] border px-2.5 py-1.5 text-left ${on ? "border-[#3fcfc0]/50 bg-[#3fcfc0]/15" : "border-white/10 bg-black/15"} disabled:opacity-40 ${FOCUS_RING} cursor-pointer disabled:cursor-default`}>
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? "border-[#3fcfc0] bg-[#3fcfc0]" : "border-white/30"}`}>{on && <Check className="h-3 w-3 text-[#0d2a26]" />}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-[#EEF3FF]"><b lang="en">{c.word}</b> <span className="text-[#EEF3FF]/60" lang="vi">· {c.meaningVi}</span></span>
                <span className="shrink-0 text-[10px] text-[#EEF3FF]/50">{c.bound ? "Đang ở cây khác" : statusLabel({ present: true, status: c.status })}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex gap-2">
        <ActionButton tone="care" className="flex-1" disabled={picked.length !== 5 || game.busy !== null}
          onClick={() => void game.plantTree(slot, picked.map((c) => c.flashcardId)).then((ok) => ok && onPlanted())} testId="garden-tree-plant">
          Trồng ({picked.length}/5)
        </ActionButton>
        <ActionButton tone="quiet" onClick={onCancel}>Huỷ</ActionButton>
      </div>
    </div>
  );
}

// ======================================================================== graduation

function GraduationFlow({ game, tree, onDone }: { game: EchoGardenGame; tree: GardenTree; onDone: () => void }) {
  const [challenge, setChallenge] = useState<GardenGraduationChallenge | null>(null);
  const [answers, setAnswers] = useState<Array<number | null>>([]);
  const [chosen, setChosen] = useState<number | null>(null);
  const [result, setResult] = useState<GardenGraduationResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const started = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void game.graduationStart(tree.id).then((c) => (c ? setChallenge(c) : onDone()));
  }, [game, tree.id, onDone]);
  useEffect(() => dialogRef.current?.focus(), [challenge, result]);
  const index = answers.length;
  const q = challenge?.questions[index];
  const choose = (i: number) => {
    if (!challenge || chosen !== null || submitting) return;
    setChosen(i);
    const next = [...answers, i];
    window.setTimeout(async () => {
      setAnswers(next);
      setChosen(null);
      if (next.length >= challenge.questions.length) {
        setSubmitting(true);
        const r = await game.graduationComplete(challenge, next);
        setSubmitting(false);
        if (r) setResult(r);
        else onDone();
      }
    }, 380);
  };
  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-end justify-center bg-[#070b1f]/55 backdrop-blur-[2px] sm:items-center" role="presentation">
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="garden-grad-title" data-testid="garden-graduation-dialog"
        className={`${PANEL} w-full max-w-[440px] rounded-t-[26px] p-5 outline-none max-sm:max-h-[86dvh] max-sm:overflow-y-auto sm:rounded-[28px_24px_30px_26px] motion-safe:animate-[eg-sheet-in_320ms_cubic-bezier(0.22,1,0.36,1)]`}>
        {!result && (
          <>
            <div className="flex items-center justify-between">
              <h2 id="garden-grad-title" className="text-base font-black text-[#EEF3FF]">Tốt nghiệp · {SPECIES_LABEL[tree.species]}</h2>
              <div className="flex gap-1.5" aria-label={`Câu ${Math.min(index + 1, 5)} trên 5`}>
                {(challenge?.questions ?? [0, 1, 2, 3, 4]).map((_, i) => (
                  <span key={i} className={`h-2.5 w-2.5 rounded-full ${i < answers.length ? "bg-[#3fcfc0]" : i === index ? "bg-[#EEF3FF]" : "bg-white/20"}`} />
                ))}
              </div>
            </div>
            {!challenge && <p className="mt-6 pb-6 text-center text-sm text-[#EEF3FF]/70">Đang chuẩn bị 5 câu hỏi từ 5 từ của cây…</p>}
            {q && (
              <div key={q.index}>
                <p className="mt-4 text-center text-[11px] font-semibold text-[#EEF3FF]/60">{q.direction === "EN_VI" ? "Chọn nghĩa đúng" : "Chọn từ tiếng Anh đúng"}</p>
                <p className="mt-1 text-center text-[28px] font-black leading-tight text-[#EEF3FF]" lang={q.direction === "EN_VI" ? "en" : "vi"}>{q.prompt}</p>
                <div className="mt-4 flex flex-col gap-2" role="radiogroup" aria-label="Các đáp án">
                  {q.options.map((opt, i) => (
                    <button key={i} type="button" role="radio" aria-checked={chosen === i} disabled={chosen !== null || submitting} onClick={() => choose(i)}
                      data-testid={`garden-grad-option-${i}`} lang={q.direction === "EN_VI" ? "vi" : "en"}
                      className={`min-h-[50px] rounded-[16px_13px_16px_14px] border px-4 text-left text-[15px] font-semibold ${FOCUS_RING} cursor-pointer disabled:cursor-default ${chosen === i ? "border-[#9cefe0]/70 bg-[#3fcfc0]/15 text-white" : "border-white/10 bg-black/20 text-[#EEF3FF] hover:bg-white/10"}`}>
                      {opt}
                    </button>
                  ))}
                </div>
                <p className="mt-3 text-center text-[11px] text-[#EEF3FF]/55">Cần đúng {challenge?.pass ?? 4}/5. Sai cũng không mất gì, cây nghỉ ngắn rồi thử lại.</p>
              </div>
            )}
            {submitting && <p className="mt-3 text-center text-xs text-[#EEF3FF]/60" aria-live="polite">Đang chấm…</p>}
          </>
        )}
        {result && (
          <div aria-live="polite" data-testid="garden-graduation-result">
            <h2 id="garden-grad-title" className="text-center text-lg font-black text-[#EEF3FF]">
              {result.passed ? "Cây đã tốt nghiệp vào Rừng Ký Ức" : "Chưa tốt nghiệp lần này"}
            </h2>
            <p className="mt-2 text-center text-[13px] text-[#EEF3FF]/75">
              Đúng {result.recall.correct}/{result.recall.total}
              <span className="ml-1.5 inline-flex gap-1 align-middle">
                {result.recall.answers.map((a) => (a.correct ? <Check key={a.index} className="h-3.5 w-3.5 text-[#74C98B]" aria-label="đúng" /> : <XIcon key={a.index} className="h-3.5 w-3.5 text-[#F2777A]" aria-label="sai" />))}
              </span>
            </p>
            {result.passed ? (
              <div className="mt-3 rounded-[16px_13px_16px_14px] border border-[#3fcfc0]/30 bg-[#3fcfc0]/10 p-3 text-center text-[13px] text-[#EEF3FF]">
                <p className="font-black text-[#9cefe0]">+{result.xpGained} XP · +{result.essenceGained} Tinh chất · 1 hạt Lan Pha Lê</p>
                <p className="mt-1 text-[12px] text-[#EEF3FF]/70">5 từ đã được chăm sóc qua ít nhất 14 ngày. Hãy tiếp tục ôn chúng trong Thẻ từ vựng.</p>
                {result.level.after > result.level.before && <p className="mt-1 font-bold text-[#a6e6b3]">Lên Cấp {result.level.after}</p>}
              </div>
            ) : (
              <p className="mt-3 text-center text-[12px] text-[#EEF3FF]/70">
                <RotateCcw className="mr-1 inline h-3.5 w-3.5" />Cây vẫn ở chỗ trồng. Thử lại sau {result.retryAt ? formatDuration((Date.parse(result.retryAt) - game.serverNow()) / 1000) : "ít phút"}.
              </p>
            )}
            <ActionButton tone="reward" className="mt-4 w-full" onClick={onDone} testId="garden-graduation-close">Tiếp tục</ActionButton>
          </div>
        )}
      </div>
    </div>
  );
}

// ======================================================================== forest

export function ForestPanel({ game, onClose }: { game: EchoGardenGame; onClose: () => void }) {
  const k = game.state!.knowledge;
  const [trees, setTrees] = useState<GardenForestTree[]>(k.forestRecent);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const loadPage = useCallback(async (before: number | null) => {
    setLoading(true);
    try {
      const page = await gardenApi.forest(before);
      setTrees((list) => (before == null ? page.trees : [...list, ...page.trees]));
      setNext(page.nextBefore);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadPage(null).catch(() => undefined);
  }, [loadPage]);
  const species = useMemo(() => Object.entries(k.forestSpecies ?? {}), [k.forestSpecies]);
  return (
    <GardenSheet labelledBy="garden-forest-title" onClose={onClose} testId="garden-forest-panel" wide>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-[#cfeab6]">Rừng Ký Ức</p>
          <h2 id="garden-forest-title" className="mt-0.5 text-lg font-black text-[#EEF3FF]">{formatNumber(k.forestCount)} cây đã tốt nghiệp</h2>
        </div>
        <CloseButton onClose={onClose} label="Đóng Rừng Ký Ức" />
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-[#EEF3FF]/70">
        Mỗi cây giữ 5 từ bạn đã chăm qua ít nhất 14 ngày, mang dáng của mùa nó được gieo. Những cây mới nhất đứng ở bìa rừng trên đảo.
      </p>
      {species.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {species.map(([sp, n]) => <Chip key={sp}>{SPECIES_LABEL[sp as GardenTree["species"]]}: {n}</Chip>)}
        </div>
      )}
      {trees.length === 0 && <p className="mt-4 text-center text-[13px] text-[#EEF3FF]/60">Chưa có cây nào. Trồng Cây Ký Ức ở Cây Tri Thức và chăm 5 từ của nó.</p>}
      <ul className="mt-3 flex flex-col gap-2" data-testid="garden-forest-list">
        {trees.map((t) => (
          <li key={t.id} className="flex items-center gap-3 rounded-[16px_13px_16px_14px] border border-white/10 bg-black/20 px-2.5 py-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={treeIcon({ species: t.species, stage: 4 })} alt="" className="h-12 w-12 shrink-0 object-contain" />
            <div className="min-w-0">
              <p className="text-[13px] font-bold text-[#EEF3FF]">{SPECIES_LABEL[t.species]}</p>
              <p className="text-[11px] text-[#EEF3FF]/60">Trồng {fullDate.format(Date.parse(t.plantedAt))} · tốt nghiệp {fullDate.format(Date.parse(t.graduatedAt))}</p>
              <p className="mt-0.5 truncate text-[12px] text-[#FFE7A8]" lang="en">{t.words.join(" · ")}</p>
            </div>
          </li>
        ))}
      </ul>
      {next && (
        <ActionButton tone="quiet" className="mt-3 w-full" disabled={loading} onClick={() => void loadPage(next)}>Xem thêm</ActionButton>
      )}
    </GardenSheet>
  );
}

export type { GardenState };
