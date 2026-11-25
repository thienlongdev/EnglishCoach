"use client";

import React from "react";
import { X, Lock, Leaf } from "lucide-react";
import type { GardenCrop, GardenPlot, GardenState } from "@/types/garden";
import { ActionButton, CoinIcon, EASE, EssenceIcon, FOCUS_RING, FertilizerIcon, GardenSheet, WaterIcon } from "./gardenUi";
import {
  SEASON_FIT_LABEL, STAGE_LABEL, clockTime, cropIconUrl, formatDuration, formatNumber, projectGrowth, seedAdvice, thirstLabel,
} from "./gardenModel";
import { ProtectionChips, SoilCard, SupplyShelf } from "./FarmingPanels";

interface PlotPanelProps {
  state: GardenState;
  plot: GardenPlot;
  serverNowMs: number;
  snapshotMs: number;
  busy: string | null;
  onClose: () => void;
  onPlant: (crop: GardenCrop) => void;
  onBoost: (itemCode: string) => void;
  onHarvest: () => void;
  /** Phase 2: open the Forgotten Pest sitting on this bed */
  onOpenPest: (pestId: number) => void;
  /** Phase 3D: apply one supply from the storehouse to this crop; open the Echo market */
  onTreat: (itemCode: string) => void;
  onShop: () => void;
}

function SeasonChip({ fit }: { fit: keyof typeof SEASON_FIT_LABEL }) {
  const label = SEASON_FIT_LABEL[fit];
  if (!label) return null;
  const on = fit === "IN_SEASON";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${on ? "bg-[#74C98B]/20 text-[#a6e6b3]" : "bg-white/10 text-[#EEF3FF]/60"}`}>
      <Leaf className="h-3 w-3" aria-hidden />
      {label}
    </span>
  );
}

/** The contextual card for one bed (GDD 04 §6 PlotSheet + PlantPicker). */
export function PlotPanel({ state, plot, serverNowMs, snapshotMs, busy, onClose, onPlant, onBoost, onHarvest, onOpenPest, onTreat, onShop }: PlotPanelProps) {
  const p = plot.planting;
  const titleId = `plot-panel-title-${plot.slot}`;
  const pest = p?.pestId ? state.pests.find((x) => x.id === p.pestId) ?? null : null;
  return (
    <GardenSheet labelledBy={titleId} onClose={onClose} testId="garden-plot-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-[#FFD978]/90">Ô đất #{plot.slot} · Nông trại</p>
          <h2 id={titleId} className="mt-0.5 text-lg font-black leading-tight text-[#EEF3FF]">
            {p ? p.nameVi : "Luống đất trống"}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/80 transition-[background-color,color,transform] duration-200 ${EASE} hover:bg-white/20 hover:text-white active:scale-[0.94] ${FOCUS_RING} cursor-pointer sm:h-9 sm:w-9`}
          aria-label="Đóng bảng ô đất"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {pest && (
        <button type="button" onClick={() => onOpenPest(pest.id)} data-testid="garden-plot-pest"
          className={`mt-3 flex w-full items-center gap-2.5 rounded-[16px_13px_16px_14px] border border-[#a98bff]/35 bg-[#a98bff]/12 px-3 py-2 text-left ${FOCUS_RING} cursor-pointer`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/garden/world/forgotten_pest.webp" alt="" className="h-9 w-9 shrink-0 object-contain" />
          <span className="min-w-0 text-[12px] leading-snug text-[#e5dcff]">
            {pest.reviewed
              ? <>Bạn đã ôn “<b lang="en">{pest.word}</b>”. Chạm để xua sâu.</>
              : pest.stage >= 3 ? <>Cây đang héo vì Sâu Lãng Quên mang từ “<b lang="en">{pest.word}</b>”. Ôn từ này là cây tươi lại ngay.</>
                : pest.stage === 2 ? <>Sâu Lãng Quên đang gặm lá, mang từ “<b lang="en">{pest.word}</b>”. Ôn từ này để cây lớn bình thường trở lại.</>
                  : <>Sâu Lãng Quên mang từ “<b lang="en">{pest.word}</b>” (quá hạn ôn). Cây chưa sao cả: ôn từ này trước khi lá bị gặm.</>}
          </span>
        </button>
      )}
      {!p && <SeedPicker state={state} serverNowMs={serverNowMs} busy={busy} onPlant={onPlant} />}
      {p && !p.ready && (
        <Growing state={state} plot={plot} serverNowMs={serverNowMs} snapshotMs={snapshotMs} busy={busy} onBoost={onBoost} onTreat={onTreat} onShop={onShop} />
      )}
      {p && p.ready && <Ready state={state} plot={plot} serverNowMs={serverNowMs} busy={busy} onHarvest={onHarvest} onTreat={onTreat} onShop={onShop} />}
    </GardenSheet>
  );
}

function SeedPicker({ state, serverNowMs, busy, onPlant }: { state: GardenState; serverNowMs: number; busy: string | null; onPlant: (c: GardenCrop) => void }) {
  const seeds = new Map(state.inventory.seeds.map((s) => [s.cropCode, s.qty]));
  const crops = [...state.crops].sort((a, b) => Number(b.unlocked) - Number(a.unlocked));
  const firstPlanting = state.plots.every((pl) => !pl.planting) && state.onboardingStep < 2;
  return (
    <div className="mt-3 border-t border-white/10 pt-3">
      <p className="text-[13px] text-[#EEF3FF]/80">Chọn hạt để gieo. Cây lớn theo thời gian thật của máy chủ, kể cả khi bạn rời đảo.</p>
      <ul className="mt-3 flex flex-col gap-2" data-testid="garden-seed-list" data-guide="seed-list">
        {crops.map((c) => {
          const held = seeds.get(c.code) ?? 0;
          const affordable = held > 0 || (c.purchasable && state.profile.coins >= c.seedPrice && state.profile.essence >= c.seedEssence);
          const can = c.unlocked && (held > 0 || c.purchasable) && affordable;
          const readyAt = c.growSecondsNow > 0 ? serverNowMs + c.growSecondsNow * 1000 : null;
          const tutorialCrop = firstPlanting && c.code === "WHEAT" && held > 0;
          return (
            <li
              key={c.code}
              className={`flex items-center gap-3 rounded-[16px_13px_16px_14px] border px-2.5 py-2 ${c.unlocked ? "border-white/10 bg-black/20" : "border-white/[0.06] bg-black/10 opacity-60"}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={cropIconUrl(c.code)} alt="" className={`h-11 w-11 shrink-0 object-contain ${c.unlocked ? "" : "grayscale"}`} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-bold text-[#EEF3FF]">{c.nameVi}</span>
                  {c.unlocked && <SeasonChip fit={c.seasonFitNow} />}
                  {tutorialCrop && <span className="rounded-full bg-[#F4B63F]/20 px-2 py-0.5 text-[10px] font-bold text-[#FFD978]">Hướng dẫn: 1 phút</span>}
                </div>
                <p className="mt-0.5 text-[11px] text-[#EEF3FF]/65">
                  {!c.unlocked ? (
                    <span className="inline-flex items-center gap-1"><Lock className="h-3 w-3" aria-hidden />Mở ở Cấp {c.unlockLevel}</span>
                  ) : !c.purchasable && held === 0 ? (
                    "Hạt huyền thoại: chỉ có khi một Cây Ký Ức tốt nghiệp"
                  ) : (
                    <>
                      Chín sau {formatDuration(c.growSecondsNow)}
                      {readyAt && c.growSecondsNow >= 600 ? ` · lúc ${clockTime(readyAt)}` : ""}
                      {` · bán ${formatNumber(c.sellPrice)} Đồng Echo`}
                    </>
                  )}
                </p>
                {c.unlocked && (held > 0 || c.purchasable) && c.thirst !== undefined && state.farming && (
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-[#EEF3FF]/55" data-testid={`garden-seed-care-${c.code}`}>
                    <span className={c.thirst >= 1.25 ? "text-[#c6ecfb]" : c.thirst <= 0.85 ? "text-[#a6e6b3]" : ""}>{thirstLabel(c.thirst)}</span>
                    {!!c.harvestBonus && <span className="inline-flex items-center gap-0.5">Thu hoạch thưởng <CoinIcon className="h-3 w-3" />{c.harvestBonus}</span>}
                  </p>
                )}
                {c.unlocked && (held > 0 || c.purchasable) && (
                  <p className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px]" data-testid={`garden-seed-advice-${c.code}`}>
                    {seedAdvice(c, state, serverNowMs).map((a) => (
                      <span key={a.text} className={a.tone === "good" ? "text-[#a6e6b3]" : a.tone === "warn" ? "text-[#ffd2b0]" : "text-[#c6ecfb]"}>{a.text}</span>
                    ))}
                  </p>
                )}
              </div>
              {c.unlocked && (held > 0 || c.purchasable) && (
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="flex items-center gap-1 text-[11px] font-bold tabular-nums text-[#EEF3FF]/75">
                    {held > 0 ? `Có ${held} hạt` : (
                      <>
                        <CoinIcon className="h-3.5 w-3.5" />{formatNumber(c.seedPrice)}
                        {c.seedEssence > 0 && <><EssenceIcon className="ml-1 h-3.5 w-3.5" />{c.seedEssence}</>}
                      </>
                    )}
                  </span>
                  <ActionButton
                    tone="care"
                    className="min-h-[36px] px-3 py-1 text-xs"
                    disabled={!can || busy !== null}
                    onClick={() => onPlant(c)}
                    testId={`garden-plant-${c.code}`}
                    ariaLabel={`Gieo ${c.nameVi}`}
                  >
                    Gieo
                  </ActionButton>
                  {!affordable && (
                    <span className="text-[10px] text-[#F2777A]">
                      {state.profile.coins < c.seedPrice ? `Thiếu ${formatNumber(c.seedPrice - state.profile.coins)} Đồng Echo` : `Thiếu ${c.seedEssence - state.profile.essence} Tinh chất`}
                    </span>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Growing({ state, plot, serverNowMs, snapshotMs, busy, onBoost, onTreat, onShop }: {
  state: GardenState; plot: GardenPlot; serverNowMs: number; snapshotMs: number; busy: string | null; onBoost: (code: string) => void;
  onTreat: (code: string) => void; onShop: () => void;
}) {
  const p = plot.planting!;
  const g = projectGrowth(p, state.stageThresholds, serverNowMs, snapshotMs);
  const pct = Math.round(g.progress * 100);
  const water = state.boosts.find((b) => b.code === "WATER");
  const roomFor = (fraction: number) => p.boostFraction + fraction <= p.maxBoost + 1e-9;
  const canWater = p.id > 0 && !!water && p.waterCount < p.waterLimit && state.inventory.water > 0 && roomFor(water.fraction);
  const fert = state.boosts.find((b) => b.code === "FERTILIZER");
  const premium = state.boosts.find((b) => b.code === "FERTILIZER_PREMIUM");
  const canFert = (b: typeof fert, qty: number) => p.id > 0 && !!b && !p.fertilizer && qty > 0 && roomFor(b.fraction);
  const readyAtMs = serverNowMs + g.remainingSeconds * 1000;
  return (
    <div className="mt-3 border-t border-white/10 pt-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-full border border-[#74C98B]/25 bg-[#74C98B]/15 px-2.5 py-0.5 text-[11px] font-bold text-[#a6e6b3]">{STAGE_LABEL[g.stage]}</span>
        <SeasonChip fit={p.seasonFit} />
        {p.tutorial && <span className="rounded-full bg-[#F4B63F]/20 px-2 py-0.5 text-[10px] font-bold text-[#FFD978]">Cây hướng dẫn</span>}
        {p.skinCode && (
          <span className="rounded-full border border-[#3fcfc0]/35 bg-[#3fcfc0]/15 px-2 py-0.5 text-[10px] font-bold text-[#9cefe0]" data-testid="garden-planting-skin">
            Giống {state.living?.collection.crops.flatMap((c) => c.skins).find((s) => s.code === p.skinCode)?.nameVi ?? "đặc biệt"}
          </span>
        )}
      </div>
      <div className="mt-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Tiến độ lớn">
        <div className="h-2.5 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-gradient-to-r from-[#5fb97a] to-[#b9e48a] transition-[width] duration-700" style={{ width: `${Math.max(3, pct)}%` }} />
        </div>
        <p className="mt-1.5 text-[13px] font-semibold text-[#EEF3FF]" data-testid="garden-countdown">
          {p.id < 0 ? "Đang gieo…" : g.remainingSeconds <= 0 ? "Sắp chín…" : <>Chín sau {formatDuration(g.remainingSeconds)}{g.remainingSeconds >= 600 ? <span className="text-[#EEF3FF]/60"> · lúc {clockTime(readyAtMs)}</span> : null}</>}
        </p>
      </div>
      <SoilCard state={state} plot={plot} serverNowMs={serverNowMs} />
      {!p.soil && <ProtectionChips plot={plot} serverNowMs={serverNowMs} />}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-[14px] border border-white/10 bg-black/20 px-2.5 py-2">
          <p className="flex items-center gap-1 text-[10px] text-[#EEF3FF]/55"><WaterIcon className="h-3.5 w-3.5" />Nước</p>
          <p className="mt-0.5 text-xs font-bold text-[#EEF3FF]">{p.waterCount}/{p.waterLimit} lần</p>
        </div>
        <div className="rounded-[14px] border border-white/10 bg-black/20 px-2.5 py-2">
          <p className="flex items-center gap-1 text-[10px] text-[#EEF3FF]/55"><FertilizerIcon className="h-3.5 w-3.5" />Phân bón</p>
          <p className="mt-0.5 text-xs font-bold text-[#EEF3FF]">{p.fertilizer ? (p.fertilizer === "FERTILIZER_PREMIUM" ? "Thượng hạng" : "Đã bón") : "Chưa bón"}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <ActionButton tone="care" disabled={!canWater || busy !== null} onClick={() => onBoost("WATER")} testId="garden-water-btn" guideId="water">
          <WaterIcon /> Tưới <span className="font-semibold opacity-75">(còn {state.inventory.water})</span>
        </ActionButton>
        <ActionButton tone="quiet" disabled={!canFert(fert, state.inventory.fertilizer) || busy !== null} onClick={() => onBoost("FERTILIZER")} testId="garden-fertilize-btn">
          <FertilizerIcon /> Bón phân <span className="font-semibold opacity-70">({state.inventory.fertilizer})</span>
        </ActionButton>
        {state.inventory.fertilizerPremium > 0 && (
          <ActionButton tone="quiet" disabled={!canFert(premium, state.inventory.fertilizerPremium) || busy !== null} onClick={() => onBoost("FERTILIZER_PREMIUM")}>
            <FertilizerIcon /> Thượng hạng ({state.inventory.fertilizerPremium})
          </ActionButton>
        )}
      </div>
      <p className="mt-2.5 text-[11px] leading-relaxed text-[#EEF3FF]/60">
        Mỗi lần tưới bớt {Math.round((water?.fraction ?? 0.04) * 100)}% công cần thiết (tối đa {p.waterLimit} lần){p.soil && state.farming ? ` và thêm ${state.farming.soil.waterGain} độ ẩm cho đất (tưới không bao giờ làm úng)` : ""}, phân bón bớt {Math.round((fert?.fraction ?? 0.1) * 100)}%. Có chăm sóc và đất ẩm tốt thì nông sản được trọn điểm Chăm sóc. Nước đến từ việc ôn thẻ.
      </p>
      <SupplyShelf state={state} plot={plot} serverNowMs={serverNowMs} busy={busy} onTreat={onTreat} onShop={onShop} />
    </div>
  );
}

function Ready({ state, plot, serverNowMs, busy, onHarvest, onTreat, onShop }: {
  state: GardenState; plot: GardenPlot; serverNowMs: number; busy: string | null; onHarvest: () => void;
  onTreat: (code: string) => void; onShop: () => void;
}) {
  const p = plot.planting!;
  const freshLeft = p.freshUntil ? (Date.parse(p.freshUntil) - serverNowMs) / 1000 : 0;
  const bonus = state.crops.find((c) => c.code === p.cropCode)?.harvestBonus ?? 0;
  const bonusLeft = state.farming ? Math.max(0, state.farming.harvestBonusCap - state.farming.harvestBonusPaid) : 0;
  const taken = state.social?.taken?.[String(p.id)] ?? 0;
  return (
    <div className="mt-3 border-t border-white/10 pt-3">
      <span className="inline-block rounded-full border border-[#F4B63F]/40 bg-[#F4B63F]/15 px-2.5 py-0.5 text-[11px] font-bold text-[#FFD978]">Đã chín</span>
      <p className="mt-2 text-[13px] leading-relaxed text-[#EEF3FF]/85">
        {freshLeft > 0 ? <>Còn tươi thêm <b>{formatDuration(freshLeft)}</b>: thu ngay để được cộng điểm Tươi.</> : "Đã qua thời điểm tươi nhất, nhưng vẫn thu hoạch được."}
      </p>
      <p className="mt-1 text-[12px] text-[#EEF3FF]/65">Thu hoạch qua 3 câu nhớ nhanh từ thẻ của bạn. Trả lời đúng để nông sản đạt chất lượng cao hơn.</p>
      {state.farming && bonus > 0 && (
        <p className="mt-1.5 flex flex-wrap items-center gap-1 text-[12px] text-[#FFE7A8]" data-testid="garden-harvest-bonus-hint">
          {bonusLeft > 0
            ? <>Thu hoạch nhận nông sản vào Kho và thưởng <CoinIcon className="h-3.5 w-3.5" /><b>{Math.min(bonus, bonusLeft)}</b> Đồng Echo.</>
            : <>Hôm nay bạn đã nhận đủ thưởng thu hoạch ({formatNumber(state.farming.harvestBonusCap)} Đồng Echo); nông sản vẫn vào Kho như thường.</>}
        </p>
      )}
      {/* Phase 3G: a visitor took a little from this ripe crop (a server fact); the rest is still the owner's */}
      {taken > 0 && state.social && (
        <p className="mt-1.5 rounded-[12px] border border-[#F2A36B]/35 bg-[#F2A36B]/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-[#ffd2b0]" data-testid="garden-plot-taken">
          Một vị khách đã lấy {taken}/{state.social.unitPortions} phần của cây này. Thu hoạch bạn vẫn nhận {state.social.unitPortions - taken} phần còn lại.
          Xem ai đã lấy trong Quần đảo bạn bè › Hoạt động trên đảo.
        </p>
      )}
      <SoilCard state={state} plot={plot} serverNowMs={serverNowMs} />
      {!p.soil && <ProtectionChips plot={plot} serverNowMs={serverNowMs} />}
      <SupplyShelf state={state} plot={plot} serverNowMs={serverNowMs} busy={busy} onTreat={onTreat} onShop={onShop} />
      <ActionButton tone="reward" className="mt-3 w-full" disabled={busy !== null} onClick={onHarvest} testId="garden-harvest-btn">
        Thu hoạch
      </ActionButton>
    </div>
  );
}
