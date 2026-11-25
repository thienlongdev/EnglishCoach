"use client";

import React, { useState } from "react";
import { Check, ChevronRight, Lock, X } from "lucide-react";
import type {
  GardenBuilding, GardenBuildingCode, GardenBuildingLevel, GardenCompostLine, GardenLandPlot, GardenRecipe, GardenRegion,
  GardenRequirement, GardenReward, GardenState, GardenSupply,
} from "@/types/garden";
import { BrandWhaleIcon } from "@/components/common/BrandWhaleIcon";
import { ActionButton, Chip, CoinIcon, EASE, FOCUS_RING, FertilizerIcon, GardenSheet } from "./gardenUi";
import {
  BUILDING_INFO, REGION_NOTE, REWARD_STATUS_LABEL, TIER_LABEL, contributionText, cropIconUrl, effectText, formatNumber,
  gateText, itemLabel,
} from "./gardenModel";
import type { EchoGardenGame } from "./useEchoGarden";

/*
 * Phase 3C panels (blueprint §8): building upgrades (cottage, storehouse with its compost bin, market stall), farmland
 * regions and Echo Contribution with its reward counter. Every number is a server fact from `state.estate`; every
 * action is two-step (choose, then confirm) and the server re-checks level, coins, produce, caps and eligibility.
 * A reward without a real delivery is shown as planned and has no button at all.
 */

const TIER_RANK: Record<string, number> = { NORMAL: 0, GOOD: 1, PERFECT: 2, GOLDEN: 3 };

function CloseButton({ onClose, label }: { onClose: () => void; label: string }) {
  return (
    <button type="button" onClick={onClose} aria-label={label}
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/80 transition-[background-color,transform] duration-200 ${EASE} hover:bg-white/20 active:scale-[0.94] ${FOCUS_RING} cursor-pointer sm:h-9 sm:w-9`}>
      <X className="h-4 w-4" />
    </button>
  );
}

function Header({ id, kicker, title, onClose, closeLabel }: { id: string; kicker: string; title: string; onClose: () => void; closeLabel: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[11px] font-semibold text-[#FFD978]/90">{kicker}</p>
        <h2 id={id} className="mt-0.5 text-lg font-black leading-tight text-[#EEF3FF]">{title}</h2>
      </div>
      <CloseButton onClose={onClose} label={closeLabel} />
    </div>
  );
}

/** One requirement row: a check or a dot (never colour-only), the requirement and what the player has. */
function Row({ ok, label, have, testId }: { ok: boolean; label: React.ReactNode; have: string; testId?: string }) {
  return (
    <li className="flex items-center gap-2 text-[13px]" data-testid={testId}>
      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${ok ? "bg-[#74C98B]/25 text-[#a6e6b3]" : "bg-white/10 text-[#EEF3FF]/50"}`} aria-hidden>
        {ok ? <Check className="h-3 w-3" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      </span>
      <span className="min-w-0 flex-1 text-[#EEF3FF]">{label}</span>
      <span className={`shrink-0 text-[11px] font-semibold tabular-nums ${ok ? "text-[#a6e6b3]" : "text-[#EEF3FF]/55"}`}>{ok ? "Đủ" : "Chưa đủ"} · {have}</span>
    </li>
  );
}

const supplyText = (lines: GardenSupply[], name: (code: string) => string) =>
  [...lines].sort((a, b) => a.cropCode.localeCompare(b.cropCode) || TIER_RANK[a.tier] - TIER_RANK[b.tier])
    .map((l) => `${l.qty} ${name(l.cropCode)} ${TIER_LABEL[l.tier]}`).join(", ");

function MaterialRows({ materials, prefix }: { materials: GardenCompostLine[]; prefix: string }) {
  return (
    <>
      {materials.map((c) => (
        <Row key={c.cropCode} ok={c.held >= c.qty} testId={`${prefix}-${c.cropCode}`} have={`Kho ${formatNumber(Math.min(c.held, c.qty))}/${c.qty}`}
          label={<span className="flex items-center gap-1.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={cropIconUrl(c.cropCode)} alt="" className="h-6 w-6 shrink-0 object-contain" />{c.qty} {c.nameVi}
          </span>} />
      ))}
    </>
  );
}

// ------------------------------------------------------------------ buildings

function LevelStrip({ b }: { b: GardenBuilding }) {
  return (
    <ol className="mt-3 flex items-center gap-1" aria-label={`Cấp ${b.level} trên ${b.maxLevel}`}>
      {Array.from({ length: b.maxLevel + 1 }, (_, l) => (
        <li key={l} className="flex flex-1 items-center gap-1">
          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-black ${l <= b.level ? "bg-[#FFD978] text-[#3a2a0a]" : "border border-white/15 text-[#EEF3FF]/45"}`}>{l}</span>
          {l < b.maxLevel && <span className={`h-0.5 flex-1 rounded-full ${l < b.level ? "bg-[#FFD978]" : "bg-white/12"}`} />}
        </li>
      ))}
    </ol>
  );
}

function UpgradeCard({ game, b, next }: { game: EchoGardenGame; b: GardenBuilding; next: GardenBuildingLevel }) {
  const state = game.state!;
  const [confirming, setConfirming] = useState(false);
  const name = (code: string) => state.crops.find((c) => c.code === code)?.nameVi ?? code;
  const ready = b.levelOk && b.coinsOk && b.materialsOk && !!b.preview;
  const info = BUILDING_INFO[b.code];
  return (
    <div className="mt-3 rounded-[16px_13px_16px_14px] border border-[#F4B63F]/25 bg-[#F4B63F]/[0.06] p-3" data-testid="garden-building-next">
      <p className="text-[12px] font-bold text-[#FFE7A8]">Cấp {next.level} · {info?.levelNames[next.level] ?? ""}</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {next.effects.map((e) => <li key={e.code} className="text-[12px] leading-snug text-[#EEF3FF]/85">• {effectText(e)}</li>)}
      </ul>
      <ul className="mt-2.5 flex flex-col gap-1.5" aria-label="Điều kiện nâng cấp">
        <Row ok={b.levelOk} label={`Nông trại Cấp ${next.minLevel}`} have={`bạn: Cấp ${state.profile.level}`} testId="garden-building-level" />
        <Row ok={b.coinsOk} label={<span className="flex items-center gap-1"><CoinIcon className="h-3.5 w-3.5" />{formatNumber(next.coins)} Đồng Echo</span>}
          have={`bạn có ${formatNumber(state.profile.coins)}`} testId="garden-building-coins" />
        <MaterialRows materials={next.materials} prefix="garden-building-material" />
      </ul>
      {confirming && b.preview ? (
        <div className="mt-3 rounded-[14px] border border-[#F4B63F]/30 bg-[#F4B63F]/[0.08] p-2.5" data-testid="garden-building-confirm">
          <p className="text-[12px] text-[#EEF3FF]">Sẽ dùng {formatNumber(next.coins)} Đồng Echo và góp: {supplyText(b.preview, name)}. Không hoàn lại.</p>
          <div className="mt-2 flex gap-2">
            <ActionButton tone="reward" className="min-h-[44px] flex-1 text-xs" disabled={game.busy !== null} testId="garden-building-buy"
              onClick={async () => {
                const r = await game.upgradeBuilding(b);
                if (r) setConfirming(false);
              }}>
              Xác nhận nâng cấp
            </ActionButton>
            <ActionButton tone="quiet" className="min-h-[44px] text-xs" onClick={() => setConfirming(false)}>Huỷ</ActionButton>
          </div>
        </div>
      ) : (
        <ActionButton tone={ready ? "reward" : "quiet"} className="mt-3 w-full" disabled={!ready || game.busy !== null}
          testId="garden-building-start" onClick={() => setConfirming(true)}>
          {ready ? <>Nâng lên Cấp {next.level} · <CoinIcon className="h-4 w-4" /> {formatNumber(next.coins)} Đồng Echo</> : "Chưa đủ điều kiện"}
        </ActionButton>
      )}
    </div>
  );
}

function CompostRow({ game, recipe }: { game: EchoGardenGame; recipe: GardenRecipe }) {
  const state = game.state!;
  const [confirming, setConfirming] = useState(false);
  const name = (code: string) => state.crops.find((c) => c.code === code)?.nameVi ?? code;
  const premium = recipe.code === "PREMIUM";
  const locked = recipe.dailyCap <= 0;
  const full = !locked && recipe.remaining <= 0;
  const can = !locked && !full && !!recipe.preview;
  return (
    <li className="rounded-[14px] border border-white/10 bg-black/20 px-3 py-2.5" data-testid={`garden-compost-${recipe.code}`}>
      <div className="flex items-center gap-2.5">
        <FertilizerIcon className="h-8 w-8 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold text-[#EEF3FF]">{itemLabel(recipe.gives, state.crops)}</p>
          <p className="text-[11px] leading-snug text-[#EEF3FF]/60">
            {recipe.units} nông sản{premium ? ` hạng ${TIER_LABEL[recipe.minTier]} trở lên` : " bất kỳ"} đổi 1 túi.
          </p>
        </div>
        {locked ? <Chip tone="warn">{premium ? "Kho Cấp 2" : "Kho Cấp 1"}</Chip> : <Chip>Còn {recipe.remaining}/{recipe.dailyCap} mẻ</Chip>}
      </div>
      {!locked && (confirming && recipe.preview ? (
        <div className="mt-2 rounded-[12px] border border-[#74C98B]/25 bg-[#74C98B]/[0.07] p-2.5" data-testid={`garden-compost-confirm-${recipe.code}`}>
          <p className="text-[12px] text-[#EEF3FF]">Sẽ ủ: {supplyText(recipe.preview, name)}. Nông sản rẻ nhất được chọn trước.</p>
          <div className="mt-2 flex gap-2">
            <ActionButton tone="care" className="min-h-[44px] flex-1 text-xs" disabled={game.busy !== null} testId={`garden-compost-run-${recipe.code}`}
              onClick={async () => {
                const r = await game.compost(recipe);
                if (r) setConfirming(false);
              }}>
              Xác nhận ủ
            </ActionButton>
            <ActionButton tone="quiet" className="min-h-[44px] text-xs" onClick={() => setConfirming(false)}>Huỷ</ActionButton>
          </div>
        </div>
      ) : (
        <ActionButton tone="quiet" className="mt-2 w-full min-h-[44px] text-xs" disabled={!can || game.busy !== null}
          testId={`garden-compost-start-${recipe.code}`} onClick={() => setConfirming(true)}>
          {full ? "Hôm nay đã ủ đủ mẻ" : recipe.preview ? "Ủ một mẻ" : `Cần ${recipe.units} nông sản${premium ? ` ${TIER_LABEL[recipe.minTier]}+` : ""} (Kho có ${formatNumber(recipe.held)})`}
        </ActionButton>
      ))}
    </li>
  );
}

/** A building of the farm: what its level does, the next level with its exact requirements, and (storehouse) the compost bin. */
export function BuildingPanel({ game, code, onClose, onOpenMarket }: {
  game: EchoGardenGame; code: GardenBuildingCode; onClose: () => void; onOpenMarket: () => void;
}) {
  const state = game.state!;
  const b = state.estate.buildings.find((x) => x.code === code);
  if (!b) return null;
  const info = BUILDING_INFO[b.code];
  return (
    <GardenSheet labelledBy="garden-building-title" onClose={onClose} testId={`garden-building-${b.code}`} wide>
      <Header id="garden-building-title" kicker={`${info.kicker} · Cấp ${b.level}/${b.maxLevel}`} title={info.title} onClose={onClose} closeLabel={`Đóng bảng ${info.title}`} />
      <p className="mt-1 text-[12px] leading-relaxed text-[#EEF3FF]/70">{info.note}</p>
      <LevelStrip b={b} />
      <div className="mt-3 rounded-[16px_13px_16px_14px] border border-white/10 bg-black/20 p-3" data-testid="garden-building-current">
        <p className="text-[12px] font-bold text-[#EEF3FF]">Hiện tại · {info.levelNames[b.level]}</p>
        {b.effects.length ? (
          <ul className="mt-1 flex flex-col gap-0.5">
            {b.effects.map((e) => <li key={e.code} className="text-[12px] leading-snug text-[#EEF3FF]/80">• {effectText(e)}</li>)}
          </ul>
        ) : (
          <p className="mt-0.5 text-[12px] text-[#EEF3FF]/60">Chưa nâng cấp. Mọi việc trồng trọt vẫn như bình thường.</p>
        )}
      </div>
      {b.next ? <UpgradeCard game={game} b={b} next={b.next} /> : (
        <p className="mt-3 rounded-[14px] border border-[#74C98B]/25 bg-[#74C98B]/[0.07] px-3 py-2 text-[12px] font-semibold text-[#a6e6b3]" data-testid="garden-building-max">
          Công trình đã ở cấp cao nhất.
        </p>
      )}
      {b.code === "WAREHOUSE" && (
        <div className="mt-3" data-testid="garden-compost">
          <p className="text-[12px] font-bold text-[#EEF3FF]">Thùng ủ phân</p>
          <p className="mt-0.5 text-[11px] leading-snug text-[#EEF3FF]/60">Kho không giới hạn số nông sản. Thùng ủ chỉ là một cách dùng nông sản dư.</p>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {state.estate.compost.map((r) => <CompostRow key={r.code} game={game} recipe={r} />)}
          </ul>
        </div>
      )}
      {b.code === "MARKET" && (
        <ActionButton tone="quiet" className="mt-3 w-full text-xs" onClick={onOpenMarket} testId="garden-building-open-market">
          Xem hàng hôm nay <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </ActionButton>
      )}
    </GardenSheet>
  );
}

// ------------------------------------------------------------------ land

function regionOf(state: GardenState, slot: number): { region: GardenRegion; plot: GardenLandPlot } | null {
  for (const region of state.estate.land.regions) {
    const plot = region.plots.find((p) => p.slot === slot);
    if (plot) return { region, plot };
  }
  return null;
}

/** A locked bed of a farmland region: the region's gate, then the bed's exact price and produce. */
export function LandPanel({ game, slot, onClose }: { game: EchoGardenGame; slot: number; onClose: () => void }) {
  const state = game.state!;
  const [confirming, setConfirming] = useState(false);
  const found = regionOf(state, slot);
  const name = (code: string) => state.crops.find((c) => c.code === code)?.nameVi ?? code;
  if (!found) return null;
  const { region, plot } = found;
  const land = state.estate.land;
  const next = region.plots.find((p) => p.status === "NEXT");
  const ready = region.open && plot.status === "NEXT" && plot.coinsOk && plot.materialsOk && !!plot.preview;
  const discounted = plot.coins < plot.basePrice;
  return (
    <GardenSheet labelledBy="garden-land-title" onClose={onClose} testId="garden-land">
      <Header id="garden-land-title" kicker={`${region.nameVi} · ${region.owned}/${region.total} luống`}
        title={plot.status === "OWNED" ? `Luống #${plot.slot} đã mở` : `Mở luống mới #${plot.slot}`} onClose={onClose} closeLabel="Đóng thẻ khu đất" />
      <p className="mt-1 text-[12px] leading-relaxed text-[#EEF3FF]/70">
        {REGION_NOTE[region.code] ?? ""} Luống mới trồng, chăm và thu hoạch như mọi luống khác. Nông trại đang có {land.plotsOwned}/{land.maxPlots} luống.
      </p>
      {!region.open && (
        <div className="mt-3 rounded-[16px_13px_16px_14px] border border-white/10 bg-black/20 p-3" data-testid="garden-land-gate">
          <p className="flex items-center gap-1.5 text-[12px] font-bold text-[#EEF3FF]"><Lock className="h-3.5 w-3.5" aria-hidden />Khu đất mở khi nông trại đạt</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {region.gate.map((r: GardenRequirement) => (
              <Row key={r.code} ok={r.met} label={gateText(r)} have={r.met ? "đạt" : `còn ${formatNumber(r.need - Math.min(r.have, r.need))}`} testId={`garden-land-gate-${r.code}`} />
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-snug text-[#EEF3FF]/55">Chỉ cần làm vườn là mở được khu đất này. Việc học không phải điều kiện, chỉ giúp giá đất rẻ hơn.</p>
        </div>
      )}
      {region.open && plot.status === "LATER" && next && (
        <p className="mt-2 rounded-[14px] border border-white/10 bg-black/20 px-3 py-1.5 text-[12px] text-[#EEF3FF]/80" data-testid="garden-land-order">
          Các luống trong khu mở lần lượt: hãy mở luống #{next.slot} trước.
        </p>
      )}
      {plot.status !== "OWNED" && (
        <>
          <ul className="mt-3 flex flex-col gap-1.5" aria-label="Chi phí mở luống">
            <Row ok={plot.coinsOk} testId="garden-land-coins" have={`bạn có ${formatNumber(state.profile.coins)}`}
              label={<span className="flex flex-wrap items-center gap-x-1.5">
                <span className="flex items-center gap-1"><CoinIcon className="h-3.5 w-3.5" />{formatNumber(plot.coins)} Đồng Echo</span>
                {discounted && <span className="text-[11px] text-[#EEF3FF]/50 line-through">{formatNumber(plot.basePrice)}</span>}
              </span>} />
            <MaterialRows materials={plot.materials} prefix="garden-land-material" />
          </ul>
          <p className="mt-2 text-[11px] leading-snug text-[#EEF3FF]/60" data-testid="garden-land-discount">
            {land.discount > 0
              ? `Giá đã giảm ${Math.round(land.discount * 100)}% nhờ ${formatNumber(land.learningDays)} ngày học đã xác nhận.`
              : "Giá niêm yết, chưa có ưu đãi học tập."}
            {land.nextDiscountAt !== null && land.nextDiscount !== null
              ? ` Đủ ${land.nextDiscountAt} ngày học sẽ giảm ${Math.round(land.nextDiscount * 100)}%.` : ""}
          </p>
        </>
      )}
      {region.open && plot.status === "NEXT" && (
        confirming && plot.preview ? (
          <div className="mt-3 rounded-[14px] border border-[#F4B63F]/30 bg-[#F4B63F]/[0.08] p-2.5" data-testid="garden-land-confirm">
            <p className="text-[12px] text-[#EEF3FF]">Sẽ dùng {formatNumber(plot.coins)} Đồng Echo và ủ đất: {supplyText(plot.preview, name)}. Không hoàn lại.</p>
            <div className="mt-2 flex gap-2">
              <ActionButton tone="reward" className="min-h-[44px] flex-1 text-xs" disabled={game.busy !== null} testId="garden-land-buy"
                onClick={async () => {
                  const r = await game.buyLand(plot);
                  if (r) onClose();
                }}>
                Xác nhận mở luống
              </ActionButton>
              <ActionButton tone="quiet" className="min-h-[44px] text-xs" onClick={() => setConfirming(false)}>Huỷ</ActionButton>
            </div>
          </div>
        ) : (
          <ActionButton tone={ready ? "reward" : "quiet"} className="mt-3 w-full" disabled={!ready || game.busy !== null}
            testId="garden-land-start" onClick={() => setConfirming(true)}>
            {ready ? <>Mở luống · <CoinIcon className="h-4 w-4" /> {formatNumber(plot.coins)} Đồng Echo</> : "Chưa đủ điều kiện"}
          </ActionButton>
        )
      )}
    </GardenSheet>
  );
}

// ------------------------------------------------------------------ Echo Contribution + rewards

function CapBar({ label, used, cap }: { label: string; used: number; cap: number }) {
  const pct = cap <= 0 ? 0 : Math.min(100, Math.round((used / cap) * 100));
  return (
    <li>
      <div className="flex items-center justify-between gap-2 text-[11px] text-[#EEF3FF]/70">
        <span>{label}</span><span className="tabular-nums">{formatNumber(used)}/{formatNumber(cap)}</span>
      </div>
      <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-white/10" role="presentation">
        <div className="h-full rounded-full bg-gradient-to-r from-[#3fcfc0] to-[#9cefe0]" style={{ width: `${Math.max(used > 0 ? 3 : 0, pct)}%` }} />
      </div>
    </li>
  );
}

function RewardCard({ game, reward }: { game: EchoGardenGame; reward: GardenReward }) {
  const [confirming, setConfirming] = useState(false);
  const planned = reward.status === "UNAVAILABLE";
  const tone = reward.status === "OPEN" ? "good" : reward.status === "OWNED" ? "magic" : planned ? "quiet" : "warn";
  return (
    <li className={`rounded-[16px] border px-3 py-2.5 ${planned ? "border-white/[0.07] bg-black/10" : "border-white/10 bg-black/20"}`} data-testid={`garden-reward-${reward.code}`}>
      <div className="flex items-start justify-between gap-2">
        <p className={`min-w-0 text-[13px] font-bold ${planned ? "text-[#EEF3FF]/65" : "text-[#EEF3FF]"}`}>{reward.nameVi}</p>
        <Chip tone={tone} testId={`garden-reward-status-${reward.code}`}>{REWARD_STATUS_LABEL[reward.status]}</Chip>
      </div>
      <p className="mt-0.5 text-[11px] leading-snug text-[#EEF3FF]/60">{reward.descriptionVi}</p>
      {!planned && reward.cost !== null && (
        <>
          <ul className="mt-2 flex flex-col gap-1">
            {reward.requirements.map((r) => (
              <li key={r.code} className="flex items-center gap-1.5 text-[12px]">
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${r.met ? "bg-[#74C98B]/25 text-[#a6e6b3]" : "bg-white/10 text-[#EEF3FF]/50"}`} aria-hidden>
                  {r.met ? <Check className="h-2.5 w-2.5" /> : <span className="h-1 w-1 rounded-full bg-current" />}
                </span>
                <span className={r.met ? "text-[#a6e6b3]" : "text-[#EEF3FF]/85"}>{gateText(r)}</span>
              </li>
            ))}
          </ul>
          {reward.status === "OPEN" && (confirming ? (
            <div className="mt-2 rounded-[14px] border border-[#3fcfc0]/30 bg-[#3fcfc0]/[0.08] p-2.5" data-testid={`garden-reward-confirm-${reward.code}`}>
              <p className="text-[12px] text-[#EEF3FF]">Dùng {formatNumber(reward.cost)} điểm đóng góp để nhận {reward.nameVi}? Điểm đã dùng không hoàn lại.</p>
              <div className="mt-2 flex gap-2">
                <ActionButton tone="care" className="min-h-[44px] flex-1 text-xs" disabled={game.busy !== null} testId={`garden-reward-redeem-${reward.code}`}
                  onClick={async () => {
                    const r = await game.redeemReward(reward);
                    if (r) setConfirming(false);
                  }}>
                  Xác nhận nhận quà
                </ActionButton>
                <ActionButton tone="quiet" className="min-h-[44px] text-xs" onClick={() => setConfirming(false)}>Huỷ</ActionButton>
              </div>
            </div>
          ) : (
            <ActionButton tone="care" className="mt-2 w-full min-h-[44px] text-xs" disabled={game.busy !== null}
              testId={`garden-reward-start-${reward.code}`} onClick={() => setConfirming(true)}>
              Nhận quà · {formatNumber(reward.cost)} điểm
            </ActionButton>
          ))}
          {reward.status === "CLOSED" && <p className="mt-2 text-[11px] text-[#EEF3FF]/55">Quầy quà chưa mở. Điểm của bạn vẫn được giữ nguyên.</p>}
        </>
      )}
    </li>
  );
}

/**
 * Echo Contribution: what the player earned from verified learning and real farm achievements, the caps, the reward
 * catalogue and the history. Contribution is a record, not a currency: it is never bought and buys nothing in the farm.
 */
export function RewardsPanel({ game, onClose }: { game: EchoGardenGame; onClose: () => void }) {
  const state = game.state!;
  const c = state.estate.contribution;
  const shop = state.estate.rewards;
  const cropName = (code: string) => state.crops.find((x) => x.code === code)?.nameVi ?? code;
  const day = (iso: string) => new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", timeZone: "Asia/Ho_Chi_Minh" }).format(Date.parse(iso));
  return (
    <GardenSheet labelledBy="garden-rewards-title" onClose={onClose} testId="garden-rewards" wide>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <BrandWhaleIcon variant="clean" size="sm" className="h-9 w-9 shrink-0" />
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-[#9cefe0]">Đóng góp Echo</p>
            <h2 id="garden-rewards-title" className="mt-0.5 text-lg font-black leading-tight text-[#EEF3FF]">
              <span className="tabular-nums text-[#9cefe0]" data-testid="garden-contribution-balance">{formatNumber(c.balance)}</span> điểm
            </h2>
          </div>
        </div>
        <CloseButton onClose={onClose} label="Đóng bảng Đóng góp Echo" />
      </div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-[#EEF3FF]/70">
        Điểm đến từ việc học đã được xác nhận và những cột mốc thật của khu vườn. Điểm không mua được bằng Đồng Echo, không đổi ra Đồng Echo
        và không ảnh hưởng tới việc trồng trọt.
      </p>
      <div className="mt-3 rounded-[16px_13px_16px_14px] border border-white/10 bg-black/20 p-3" data-testid="garden-contribution-caps">
        <p className="text-[12px] font-bold text-[#EEF3FF]">Điểm học tập kỳ này</p>
        <ul className="mt-1.5 flex flex-col gap-1.5">
          <CapBar label="Hôm nay" used={c.dayPoints} cap={c.dayCap} />
          <CapBar label="Tuần này" used={c.weekPoints} cap={c.weekCap} />
          <CapBar label="Tháng này" used={c.monthPoints} cap={c.monthCap} />
        </ul>
        <p className="mt-2 text-[11px] leading-snug text-[#EEF3FF]/55">
          Ngày học, học nhiều kỹ năng, Cây Ký Ức tốt nghiệp và đơn cả tuần có giới hạn theo ngày, tuần, tháng. Cột mốc lớn (kỷ của
          Cây Tri Thức, nhánh kỹ năng, bậc thành thạo) chỉ tính một lần.
        </p>
      </div>

      <p className="mt-3 text-[12px] font-bold text-[#EEF3FF]">Quầy Quà Echo</p>
      {!shop.open && (
        <p className="mt-1 rounded-[14px] border border-white/10 bg-black/20 px-3 py-1.5 text-[12px] text-[#EEF3FF]/75" data-testid="garden-rewards-closed">
          Quầy quà chưa mở đổi. Điểm đóng góp của bạn vẫn tiếp tục được ghi lại.
        </p>
      )}
      <ul className="mt-1.5 flex flex-col gap-2" data-testid="garden-reward-list">
        {shop.rewards.map((r) => <RewardCard key={r.code} game={game} reward={r} />)}
      </ul>

      {shop.history.length > 0 && (
        <div className="mt-3" data-testid="garden-redemption-history">
          <p className="text-[12px] font-bold text-[#EEF3FF]">Quà đã nhận</p>
          <ul className="mt-1 flex flex-col gap-1">
            {shop.history.map((h) => (
              <li key={h.id} className="flex items-baseline justify-between gap-2 text-[11px] text-[#EEF3FF]/75">
                <span className="min-w-0">{h.nameVi}{h.status === "REVERSED" ? " (đã hoàn điểm)" : ""}</span>
                <span className="shrink-0 tabular-nums text-[#EEF3FF]/50">−{formatNumber(h.cost)} · {day(h.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-3" data-testid="garden-contribution-history">
        <p className="text-[12px] font-bold text-[#EEF3FF]">Điểm gần đây</p>
        {c.recent.length ? (
          <ul className="mt-1 flex flex-col gap-1">
            {c.recent.slice(0, 8).map((e) => (
              <li key={e.id} className="flex items-baseline justify-between gap-2 text-[11px] text-[#EEF3FF]/75">
                <span className="min-w-0">{contributionText(e, cropName)}{e.points >= 0 && e.points < e.nominal ? " (đã chạm giới hạn kỳ)" : ""}</span>
                <span className={`shrink-0 tabular-nums ${e.points < 0 ? "text-[#ffd2b0]" : "text-[#a6e6b3]"}`}>{e.points > 0 ? "+" : ""}{formatNumber(e.points)} · {day(e.at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-[11px] text-[#EEF3FF]/60">Chưa có điểm nào. Một ngày học được xác nhận sẽ ghi điểm đầu tiên.</p>
        )}
      </div>
    </GardenSheet>
  );
}
