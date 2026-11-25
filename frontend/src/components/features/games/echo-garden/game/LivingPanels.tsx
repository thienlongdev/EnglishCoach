"use client";

import React, { useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Lock, X } from "lucide-react";
import type {
  GardenBranch, GardenCodexCrop, GardenMilestone, GardenNextStep, GardenSkin, GardenState, GardenTheme,
} from "@/types/garden";
import { BrandWhaleIcon } from "@/components/common/BrandWhaleIcon";
import { ActionButton, Chip, CoinIcon, EASE, FOCUS_RING, GardenSheet, PANEL } from "./gardenUi";
import {
  ERA_LABEL, ERA_NOTE, FAMILY_INFO, FORM_LABEL, MASTERY_LABEL, SEASON_LABEL, SEASON_OF_THEME, TIER_LABEL, cropIconUrl,
  formatNumber, milestoneText, requirementText, skinRequirement, type EchoAction, type EchoLine,
} from "./gardenModel";
import { LogisticsTabs, type LogisticsTab } from "./EconomyPanels";
import type { EchoGardenGame } from "./useEchoGarden";

/*
 * Phase 3B panels (blueprint §7): the monument's overview, the codex (crop mastery + skins), Echo's single hint and the
 * milestone card. Every number is a server fact from `state.living`; an action only names what the player chose and
 * the server decides (requirements, price, ownership). Nothing here calls an AI or invents a task.
 */

const SEASON_ORDER: GardenTheme[] = ["LU_HANH", "CONG_SO", "HOC_THUAT", "THANH_NGU"];

function CloseButton({ onClose, label }: { onClose: () => void; label: string }) {
  return (
    <button type="button" onClick={onClose} aria-label={label}
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/80 transition-[background-color,color,transform] duration-200 ${EASE} hover:bg-white/20 hover:text-white active:scale-[0.94] ${FOCUS_RING} cursor-pointer sm:h-9 sm:w-9`}>
      <X className="h-4 w-4" />
    </button>
  );
}

/** Tier pips: filled = reached. Always paired with a word (never colour-only). */
function Pips({ value, max, tone = "magic" }: { value: number; max: number; tone?: "magic" | "gold" }) {
  const on = tone === "gold" ? "bg-[#FFD978]" : "bg-[#5fe0cf]";
  return (
    <span className="inline-flex items-center gap-1" aria-hidden>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={`h-2 w-2 rounded-full ${i < value ? on : "bg-white/15"}`} />
      ))}
    </span>
  );
}

function ProgressRows({ next }: { next: GardenNextStep }) {
  return (
    <ul className="mt-2 flex flex-col gap-1.5">
      {next.requirements.map((r) => {
        const pct = r.need <= 0 ? 100 : Math.min(100, Math.round((Math.min(r.have, r.need) / r.need) * 100));
        return (
          <li key={r.code} data-testid={`garden-req-${r.code}`}>
            <div className="flex items-center justify-between gap-2 text-[12px]">
              <span className={r.met ? "text-[#a6e6b3]" : "text-[#EEF3FF]/85"}>{requirementText(r)}</span>
              {r.met ? <Check className="h-3.5 w-3.5 shrink-0 text-[#74C98B]" aria-label="Đã đạt" /> : <span className="shrink-0 text-[11px] tabular-nums text-[#EEF3FF]/50">{pct}%</span>}
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10" role="presentation">
              <div className={`h-full rounded-full ${r.met ? "bg-[#74C98B]" : "bg-gradient-to-r from-[#3fcfc0] to-[#9cefe0]"}`} style={{ width: `${Math.max(3, pct)}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const day = (iso: string) => new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" }).format(Date.parse(iso));

function useNames(state: GardenState) {
  const cropName = (code: string) => state.crops.find((c) => c.code === code)?.nameVi ?? state.living.collection.crops.find((c) => c.cropCode === code)?.nameVi ?? code;
  const skinName = (code: string) => state.living.collection.crops.flatMap((c) => c.skins).find((s) => s.code === code)?.nameVi ?? code;
  return { cropName, skinName };
}

// ------------------------------------------------------------------ monument

function BranchRow({ b, onGo }: { b: GardenBranch; onGo: (route: string) => void }) {
  const f = FAMILY_INFO[b.family];
  const left = b.nextAt === null ? null : Math.max(0, b.nextAt - b.days);
  return (
    <li className="rounded-[14px] border border-white/10 bg-black/20 px-3 py-2" data-testid={`garden-branch-${b.family}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-[13px] font-bold text-[#EEF3FF]">
          {f.label} <span className="font-semibold text-[#EEF3FF]/55">· {f.ornament}</span>
        </p>
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-[#EEF3FF]/70">
          <Pips value={b.tier} max={b.maxTier} /> Bậc {b.tier}/{b.maxTier}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <p className="min-w-0 text-[11px] leading-snug text-[#EEF3FF]/65">
          {!b.enabled ? "Phần học này chưa ghi lại lượt hoàn thành đáng tin, nên chưa tính."
            : <>{formatNumber(b.days)} ngày{left === null ? " · nhánh đã trọn vẹn" : ` · còn ${left} ngày tới bậc ${b.tier + 1}`}{b.today ? " · hôm nay đã tính" : ""}</>}
        </p>
        {b.enabled && (
          <button type="button" onClick={() => onGo(f.route)} data-testid={`garden-branch-go-${b.family}`}
            className={`inline-flex min-h-[44px] shrink-0 items-center gap-0.5 rounded-[12px] border border-white/15 bg-white/[0.06] px-2.5 text-[12px] font-bold text-[#EEF3FF] hover:bg-white/[0.12] ${FOCUS_RING} cursor-pointer sm:min-h-[36px]`}>
            {f.cta}<ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>
    </li>
  );
}

/** The monumental Knowledge Tree: era, verified learning, skill branches, memory lanterns, milestones. */
export function MonumentPanel({ game, onClose, onGrove, onForest, onCodex, onGo, onRewards }: {
  game: EchoGardenGame; onClose: () => void; onGrove: () => void; onForest: () => void; onCodex: () => void; onGo: (route: string) => void;
  /** Phase 3C: opens the Echo Contribution sheet (what verified learning has earned). */
  onRewards?: () => void;
}) {
  const state = game.state!;
  const m = state.living.monument;
  const { cropName, skinName } = useNames(state);
  return (
    <GardenSheet labelledBy="garden-monument-title" onClose={onClose} testId="garden-monument" wide>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold text-[#9cefe0]">Cây Tri Thức · Kỷ {m.era}/{m.maxEra}</p>
          <h2 id="garden-monument-title" className="mt-0.5 text-lg font-black text-[#EEF3FF]" data-testid="garden-monument-era">{ERA_LABEL[m.era] ?? `Kỷ ${m.era}`}</h2>
        </div>
        <CloseButton onClose={onClose} label="Đóng bảng Cây Tri Thức" />
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-[#EEF3FF]/70">{ERA_NOTE[m.era]} Cây lớn theo những gì bạn thật sự học, và không bao giờ nhỏ lại.</p>
      <ol className="mt-3 flex items-center gap-1" aria-label={`Kỷ ${m.era} trên ${m.maxEra}`}>
        {Array.from({ length: m.maxEra + 1 }, (_, e) => (
          <li key={e} className="flex flex-1 items-center gap-1">
            <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-black ${e <= m.era ? "bg-[#3fcfc0] text-[#0c2a27]" : "border border-white/15 text-[#EEF3FF]/45"}`}>{e}</span>
            {e < m.maxEra && <span className={`h-0.5 flex-1 rounded-full ${e < m.era ? "bg-[#3fcfc0]" : "bg-white/12"}`} />}
          </li>
        ))}
      </ol>

      <div className="mt-3 rounded-[16px_13px_16px_14px] border border-white/10 bg-black/20 p-3" data-testid="garden-monument-days">
        <p className="text-[13px] font-bold text-[#EEF3FF]">
          <span className="text-xl font-black tabular-nums text-[#9cefe0]">{formatNumber(m.learningDays)}</span> ngày học đã xác nhận
        </p>
        <p className="mt-0.5 text-[11px] leading-snug text-[#EEF3FF]/65">
          {m.learnedToday ? "Hôm nay đã được ghi nhận."
            : `Hôm nay: ${Math.min(m.cardsToday, m.minCardReviews)}/${m.minCardReviews} thẻ khác nhau đã ôn. Đủ ${m.minCardReviews} thẻ hoặc xong một bài kỹ năng là tính một ngày.`}
          {" "}Tính từ {day(m.since)}. Con số này ghi lại sự đều đặn, không phải trình độ.
        </p>
      </div>

      {m.next ? (
        <div className="mt-2 rounded-[16px_13px_16px_14px] border border-[#3fcfc0]/25 bg-[#3fcfc0]/[0.06] p-3" data-testid="garden-monument-next">
          <p className="text-[12px] font-bold text-[#EEF3FF]">Kỷ tiếp theo · {ERA_LABEL[m.next.tier]}</p>
          <ProgressRows next={m.next} />
        </div>
      ) : (
        <div className="mt-2 rounded-[16px_13px_16px_14px] border border-[#FFD978]/30 bg-[#FFD978]/[0.07] p-3" data-testid="garden-monument-rings">
          <p className="text-[12px] font-bold text-[#FFE7A8]">Cây đã ở kỷ cuối · {formatNumber(m.rings)} Vòng Ký Ức</p>
          <p className="mt-0.5 text-[11px] text-[#EEF3FF]/70">Hành trình vẫn tiếp tục: {m.daysToNextRing ?? 0} ngày học nữa khắc thêm một vòng vào thân cây.</p>
        </div>
      )}

      <p className="mt-3 text-[12px] font-bold text-[#EEF3FF]">Nhánh kỹ năng</p>
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {m.branches.map((b) => <BranchRow key={b.family} b={b} onGo={onGo} />)}
      </ul>

      <div className="mt-2 rounded-[14px] border border-white/10 bg-black/20 px-3 py-2" data-testid="garden-monument-memory">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[13px] font-bold text-[#EEF3FF]">Đèn Ký Ức</p>
          <span className="flex items-center gap-1.5 text-[11px] text-[#EEF3FF]/70"><Pips value={m.memoryTier} max={m.memoryMaxTier} tone="gold" /> Bậc {m.memoryTier}/{m.memoryMaxTier}</span>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-[#EEF3FF]/65">
          {formatNumber(m.graduations)} Cây Ký Ức tốt nghiệp đã thắp đèn{m.nextMemoryAt !== null ? ` · bậc sau ở ${m.nextMemoryAt} cây` : ""}. Rừng Ký Ức đang giữ {formatNumber(m.forestCount)} cây.
          {" "}Một cây thắp thêm đèn khi có ít nhất {m.minNewWords} từ mới; tốt nghiệp là một chương, không phải điểm kết thúc.
        </p>
      </div>

      {m.recent.length > 0 && (
        <div className="mt-3" data-testid="garden-monument-history">
          <p className="text-[12px] font-bold text-[#EEF3FF]">Cột mốc gần đây</p>
          <ul className="mt-1 flex flex-col gap-1">
            {m.recent.slice(0, 5).map((x) => (
              <li key={x.id} className="flex items-baseline justify-between gap-2 text-[11px] text-[#EEF3FF]/75">
                <span className="min-w-0">{milestoneText(x, cropName, skinName)}</span>
                <span className="shrink-0 tabular-nums text-[#EEF3FF]/45">{day(x.reachedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {onRewards && state.estate && (
        <button type="button" onClick={onRewards} data-testid="garden-monument-rewards"
          className={`mt-3 flex min-h-[48px] w-full items-center justify-between gap-2 rounded-[16px_13px_16px_14px] border border-[#3fcfc0]/25 bg-[#3fcfc0]/[0.06] px-3 text-left hover:bg-[#3fcfc0]/[0.1] ${FOCUS_RING} cursor-pointer`}>
          <span className="min-w-0">
            <span className="block text-[12px] font-bold text-[#EEF3FF]">Đóng góp Echo</span>
            <span className="block text-[11px] text-[#EEF3FF]/65">{formatNumber(state.estate.contribution.balance)} điểm từ việc học đã xác nhận</span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-[#9cefe0]" aria-hidden />
        </button>
      )}
      <div className="mt-3 grid grid-cols-3 gap-2">
        <ActionButton tone="quiet" className="px-2 text-xs" onClick={onGrove} testId="garden-monument-grove">Vườn Ký Ức</ActionButton>
        <ActionButton tone="quiet" className="px-2 text-xs" onClick={onForest} testId="garden-monument-forest">Rừng Ký Ức</ActionButton>
        <ActionButton tone="quiet" className="px-2 text-xs" onClick={onCodex} testId="garden-monument-codex">Sổ tay</ActionButton>
      </div>
    </GardenSheet>
  );
}

// ------------------------------------------------------------------ codex: mastery + skins

const FORM_HINT: Record<string, string> = {
  NORMAL: "Một lần thu chất lượng Normal",
  GOOD: "Trả lời đúng câu nhớ nhanh và chăm cây để đạt Good",
  PERFECT: "Đúng cả ba câu, có chăm sóc, thu khi còn tươi",
  GOLDEN: "Cây đúng mùa, đúng cả ba câu, có chăm sóc, thu khi còn tươi",
  MOONLIT: "Thu hoạch ban đêm, từ 19:00 đến 05:00",
  RAINBOW: "Thu hoạch khi có cầu vồng (ngay sau mưa)",
  MUTATED: "Dạng hiếm, dễ gặp hơn khi thu lúc cầu vồng",
};

function SkinCard({ skin, crop, game }: { skin: GardenSkin; crop: GardenCodexCrop; game: EchoGardenGame }) {
  const [confirming, setConfirming] = useState(false);
  const coins = game.state!.profile.coins;
  const busy = game.busy !== null;
  const owned = skin.status === "OWNED";
  return (
    <li className={`rounded-[16px] border px-3 py-2.5 ${owned ? "border-[#74C98B]/25 bg-[#74C98B]/[0.06]" : "border-white/10 bg-black/20"}`} data-testid={`garden-skin-${skin.code}`}>
      <div className="flex gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={cropIconUrl(crop.cropCode, skin.artKey)} alt="" width={64} height={64}
          className={`h-16 w-16 shrink-0 object-contain ${skin.status === "LOCKED" ? "opacity-55 saturate-50" : ""}`}
          onError={(e) => { (e.currentTarget as HTMLImageElement).src = cropIconUrl(crop.cropCode); }} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-[13px] font-black text-[#EEF3FF]">{skin.nameVi}</p>
            {skin.equipped && <Chip tone="good" testId={`garden-skin-equipped-${skin.code}`}>Đang dùng</Chip>}
            {owned && !skin.equipped && <Chip>Đã có</Chip>}
            {skin.status === "LOCKED" && <Chip><Lock className="h-2.5 w-2.5" aria-hidden />Chưa mở</Chip>}
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-[#EEF3FF]/65">{skin.descriptionVi}</p>
          {!owned && <p className="mt-1 text-[11px] font-semibold text-[#FFE7A8]/90">{skinRequirement(skin, crop.nameVi)}</p>}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {owned && !skin.equipped && (
          <ActionButton tone="care" className="min-h-[44px] px-3 text-xs" disabled={busy} onClick={() => void game.equipSkin(crop.cropCode, skin)} testId={`garden-skin-equip-${skin.code}`}>
            Dùng giống này
          </ActionButton>
        )}
        {owned && skin.equipped && (
          <ActionButton tone="quiet" className="min-h-[44px] px-3 text-xs" disabled={busy} onClick={() => void game.equipSkin(crop.cropCode, null)} testId={`garden-skin-unequip-${skin.code}`}>
            Về giống gốc
          </ActionButton>
        )}
        {skin.status === "AVAILABLE" && skin.unlockKind !== "COIN" && (
          <ActionButton tone="reward" className="min-h-[44px] px-3 text-xs" disabled={busy} onClick={() => void game.acquireSkin(skin)} testId={`garden-skin-claim-${skin.code}`}>
            Nhận giống
          </ActionButton>
        )}
        {skin.status === "AVAILABLE" && skin.unlockKind === "COIN" && !confirming && (
          <ActionButton tone="reward" className="min-h-[44px] px-3 text-xs" disabled={busy || !skin.coinsOk} onClick={() => setConfirming(true)} testId={`garden-skin-buy-${skin.code}`}>
            <CoinIcon className="h-3.5 w-3.5" /> Mua · {formatNumber(skin.coinPrice)} Đồng Echo
          </ActionButton>
        )}
        {skin.status === "AVAILABLE" && skin.unlockKind === "COIN" && !skin.coinsOk && (
          <span className="text-[11px] text-[#F2777A]">Thiếu {formatNumber(skin.coinPrice - coins)} Đồng Echo</span>
        )}
        {confirming && (
          <>
            <span className="w-full text-[11px] text-[#EEF3FF]/75">Mua {skin.nameVi} với {formatNumber(skin.coinPrice)} Đồng Echo? Giống chỉ đổi dáng vẻ của cây.</span>
            <ActionButton tone="reward" className="min-h-[44px] px-3 text-xs" disabled={busy}
              onClick={() => void game.acquireSkin(skin).then(() => setConfirming(false))} testId={`garden-skin-confirm-${skin.code}`}>
              Xác nhận mua
            </ActionButton>
            <ActionButton tone="quiet" className="min-h-[44px] px-3 text-xs" onClick={() => setConfirming(false)}>Thôi</ActionButton>
          </>
        )}
      </div>
    </li>
  );
}

function CropDetail({ crop, game, onBack }: { crop: GardenCodexCrop; game: EchoGardenGame; onBack: () => void }) {
  const ma = crop.mastery;
  const found = new Set(crop.forms.map((f) => f.form));
  const missingSeason = SEASON_ORDER.find((t) => !ma.seasons.includes(t));
  // the next form worth aiming for: better harvests first, the rare ones after (a poor harvest is never a goal)
  const firstMissing = ["GOOD", "PERFECT", "GOLDEN", "MOONLIT", "RAINBOW", "MUTATED"].find((f) => crop.possibleForms.includes(f) && !found.has(f));
  return (
    <div data-testid={`garden-codex-detail-${crop.cropCode}`}>
      <button type="button" onClick={onBack} data-testid="garden-codex-back"
        className={`mb-2 inline-flex min-h-[44px] items-center gap-1 rounded-[12px] px-2 text-[12px] font-bold text-[#EEF3FF]/80 hover:bg-white/10 ${FOCUS_RING} cursor-pointer sm:min-h-[36px]`}>
        <ChevronLeft className="h-4 w-4" aria-hidden /> Tất cả cây trồng
      </button>
      <div className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={cropIconUrl(crop.cropCode, crop.skins.find((s) => s.equipped)?.artKey)} alt="" width={64} height={64} className="h-16 w-16 shrink-0 object-contain"
          onError={(e) => { (e.currentTarget as HTMLImageElement).src = cropIconUrl(crop.cropCode); }} />
        <div className="min-w-0">
          <h3 className="text-base font-black text-[#EEF3FF]">{crop.nameVi}</h3>
          <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-[#EEF3FF]/75">
            <Pips value={ma.tier} max={ma.maxTier} tone="gold" /> {MASTERY_LABEL[ma.tier]}
          </p>
          <p className="mt-0.5 text-[11px] text-[#EEF3FF]/55">
            {ma.harvests > 0 ? `Đã thu ${formatNumber(ma.harvests)} lần${ma.bestTier ? ` · tốt nhất ${TIER_LABEL[ma.bestTier]}` : ""}` : "Chưa thu hoạch lần nào"}
          </p>
        </div>
      </div>

      {ma.next ? (
        <div className="mt-3 rounded-[16px_13px_16px_14px] border border-white/10 bg-black/20 p-3" data-testid="garden-mastery-next">
          <p className="text-[12px] font-bold text-[#EEF3FF]">Bậc tiếp theo · {MASTERY_LABEL[ma.next.tier]}</p>
          <ProgressRows next={ma.next} />
        </div>
      ) : (
        <p className="mt-3 rounded-[14px] border border-[#FFD978]/30 bg-[#FFD978]/[0.07] px-3 py-2 text-[12px] text-[#FFE7A8]">Bạn đã đạt bậc cao nhất của {crop.nameVi}.</p>
      )}

      <p className="mt-3 text-[12px] font-bold text-[#EEF3FF]">Mùa đã thu hoạch</p>
      <ul className="mt-1.5 flex flex-wrap gap-1.5" data-testid="garden-codex-seasons">
        {SEASON_ORDER.map((t) => {
          const ok = ma.seasons.includes(t);
          return (
            <li key={t} className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-bold ${ok ? "border-[#74C98B]/30 bg-[#74C98B]/15 text-[#a6e6b3]" : "border-white/10 bg-white/[0.04] text-[#EEF3FF]/45"}`}>
              {ok && <Check className="h-3 w-3" aria-hidden />}{SEASON_LABEL[SEASON_OF_THEME[t]]}{ok ? "" : " · chưa"}
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-[12px] font-bold text-[#EEF3FF]">Dạng đã khám phá · {crop.forms.filter((f) => crop.possibleForms.includes(f.form)).length}/{crop.possibleForms.length}</p>
      <ul className="mt-1.5 flex flex-wrap gap-1.5" data-testid="garden-codex-forms">
        {crop.possibleForms.map((f) => (
          <li key={f} title={FORM_HINT[f]} className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${found.has(f) ? "border-[#FFD978]/35 bg-[#FFD978]/12 text-[#FFE7A8]" : "border-dashed border-white/15 text-[#EEF3FF]/40"}`}>
            {found.has(f) ? FORM_LABEL[f] ?? f : "?"}
          </li>
        ))}
      </ul>
      {(firstMissing || missingSeason) && (
        <p className="mt-2 text-[11px] leading-snug text-[#EEF3FF]/60" data-testid="garden-codex-tip">
          Gợi ý: {firstMissing ? `${FORM_HINT[firstMissing] ?? ""}. ` : ""}
          {missingSeason ? `Chưa có vụ thu nào vào mùa ${SEASON_LABEL[SEASON_OF_THEME[missingSeason]]}.` : ""}
        </p>
      )}

      {crop.skins.length > 0 && (
        <>
          <p className="mt-3 text-[12px] font-bold text-[#EEF3FF]">Giống cây</p>
          <ul className="mt-1.5 flex flex-col gap-2">
            {crop.skins.map((s) => <SkinCard key={s.code} skin={s} crop={crop} game={game} />)}
          </ul>
          <p className="mt-2 text-[11px] leading-snug text-[#EEF3FF]/50">
            Giống chỉ đổi dáng vẻ: tốc độ lớn, chất lượng, giá bán và XP giữ nguyên. Luống đang trồng giữ giống cũ; lần gieo sau mới đổi.
          </p>
        </>
      )}
    </div>
  );
}

/** "Sổ tay nông trại": the collection of crops, their forms, mastery and skins (4th tab of the Kho sheet). */
export function CodexPanel({ game, onClose, onTab, initialCrop }: {
  game: EchoGardenGame; onClose: () => void; onTab: (t: LogisticsTab) => void; initialCrop?: string | null;
}) {
  const state = game.state!;
  const col = state.living.collection;
  const [selected, setSelected] = useState<string | null>(initialCrop ?? null);
  useEffect(() => setSelected(initialCrop ?? null), [initialCrop]);
  const crop = selected ? col.crops.find((c) => c.cropCode === selected) ?? null : null;
  return (
    <GardenSheet labelledBy="garden-codex-title" onClose={onClose} testId="garden-codex" wide>
      <LogisticsTabs active="codex" onTab={onTab} state={state} />
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold text-[#FFD978]/90">Sổ tay nông trại</p>
          <h2 id="garden-codex-title" className="mt-0.5 text-lg font-black text-[#EEF3FF]">Bộ sưu tập cây trồng</h2>
        </div>
        <CloseButton onClose={onClose} label="Đóng sổ tay" />
      </div>
      {crop ? <CropDetail crop={crop} game={game} onBack={() => setSelected(null)} /> : (
        <>
          <div className="mt-2 flex flex-wrap gap-1.5" data-testid="garden-codex-summary">
            <Chip tone="info">Dạng {col.formsFound}/{col.formsTotal}</Chip>
            <Chip tone="magic">Giống {col.skinsOwned}/{col.skinsTotal}</Chip>
            <Chip tone="good">Thành thạo {col.masteryTiers}/{col.masteryMax}</Chip>
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-[#EEF3FF]/70">Mỗi loại cây ghi lại những vụ bạn đã thật sự thu. Chọn một cây để xem còn gì chờ khám phá.</p>
          <ul className="mt-2 flex flex-col gap-1.5" data-testid="garden-codex-list">
            {col.crops.map((c) => {
              const formsFound = c.forms.filter((f) => c.possibleForms.includes(f.form)).length;
              const owned = c.skins.filter((s) => s.status === "OWNED").length;
              const waiting = c.skins.some((s) => s.status === "AVAILABLE" && s.unlockKind !== "COIN");
              return (
                <li key={c.cropCode}>
                  <button type="button" onClick={() => setSelected(c.cropCode)} data-testid={`garden-codex-crop-${c.cropCode}`}
                    className={`flex min-h-[56px] w-full items-center gap-3 rounded-[16px] border border-white/10 bg-black/20 px-3 py-1.5 text-left transition-[background-color] duration-200 ${EASE} hover:bg-white/[0.08] ${FOCUS_RING} cursor-pointer`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={cropIconUrl(c.cropCode, c.skins.find((s) => s.equipped)?.artKey)} alt="" width={40} height={40}
                      className={`h-10 w-10 shrink-0 object-contain ${c.discovered ? "" : "opacity-40 saturate-0"}`}
                      onError={(e) => { (e.currentTarget as HTMLImageElement).src = cropIconUrl(c.cropCode); }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-bold text-[#EEF3FF]">{c.nameVi}</span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[#EEF3FF]/60">
                        {c.unlocked ? <><Pips value={c.mastery.tier} max={c.mastery.maxTier} tone="gold" /> {MASTERY_LABEL[c.mastery.tier]}</> : <><Lock className="h-3 w-3" aria-hidden /> Mở ở Cấp {c.unlockLevel}</>}
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-[11px] text-[#EEF3FF]/55">
                      <span className="block tabular-nums">Dạng {formsFound}/{c.possibleForms.length}</span>
                      {c.skins.length > 0 && <span className={`block tabular-nums ${waiting ? "font-bold text-[#FFD978]" : ""}`}>{waiting ? "Có giống chờ nhận" : `Giống ${owned}/${c.skins.length}`}</span>}
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-[#EEF3FF]/40" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </GardenSheet>
  );
}

// ------------------------------------------------------------------ Echo: one hint, one celebration

/** Echo's single contextual hint: one sentence, one real action, dismissible. Never a quest list, never an AI call. */
export function EchoHint({ line, onAct, onDismiss, expanded = false }: {
  line: EchoLine; onAct: (action: EchoAction) => void; onDismiss: () => void; expanded?: boolean;
}) {
  return (
    <div className={`pointer-events-auto ${PANEL} flex gap-3 rounded-[22px_18px_22px_20px] p-3.5 motion-safe:animate-[eg-sheet-in_320ms_cubic-bezier(0.22,1,0.36,1)]`}
      role="status" data-testid="garden-echo-hint">
      <BrandWhaleIcon variant="clean" size="sm" className="mt-0.5 h-8 w-8 shrink-0" />
      <div className="min-w-0 flex-1">
        {expanded && <p className="text-[11px] font-semibold text-[#9cefe0]">Echo gợi ý</p>}
        <p className="text-[13px] leading-relaxed text-[#EEF3FF]" data-testid="garden-echo-text">{line.text}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {line.cta && line.action && (
            <ActionButton tone="care" className="min-h-[44px] px-3 text-xs sm:min-h-[36px]" onClick={() => onAct(line.action!)} testId="garden-echo-cta">{line.cta}</ActionButton>
          )}
          <button type="button" onClick={onDismiss} data-testid="garden-echo-dismiss"
            className={`ml-auto min-h-[44px] rounded-lg px-2 text-[11px] font-semibold text-[#EEF3FF]/55 hover:text-[#EEF3FF] ${FOCUS_RING} cursor-pointer sm:min-h-[36px]`}>
            {expanded ? "Đóng" : "Để sau"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A verified milestone, shown once: what happened, in plain words. "Tuyệt vời" marks it seen on the server. */
export function MilestoneCard({ state, milestones, onDone }: { state: GardenState; milestones: GardenMilestone[]; onDone: () => void }) {
  const { cropName, skinName } = useNames(state);
  const shown = milestones.slice(0, 4);
  return (
    <div className={`pointer-events-auto ${PANEL} w-full max-w-sm rounded-[24px_20px_24px_22px] p-4 motion-safe:animate-[eg-sheet-in_320ms_cubic-bezier(0.22,1,0.36,1)]`}
      role="status" data-testid="garden-milestone-card">
      <div className="flex items-center gap-2.5">
        <BrandWhaleIcon variant="clean" size="sm" className="h-9 w-9" />
        <p className="text-sm font-black text-[#EEF3FF]">{milestones.length > 1 ? "Echo mừng những cột mốc mới" : "Echo mừng một cột mốc mới"}</p>
      </div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {shown.map((m) => (
          <li key={m.id} className="flex items-start gap-2 text-[13px] leading-snug text-[#EEF3FF]/90" data-testid={`garden-milestone-${m.kind}`}>
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#5fe0cf]" aria-hidden />
            <span>{milestoneText(m, cropName, skinName)}</span>
          </li>
        ))}
        {milestones.length > shown.length && <li className="text-[11px] text-[#EEF3FF]/55">và {milestones.length - shown.length} cột mốc khác trong bảng Cây Tri Thức</li>}
      </ul>
      <ActionButton tone="reward" className="mt-3 w-full" onClick={onDone} testId="garden-milestone-done">Tuyệt vời</ActionButton>
    </div>
  );
}
