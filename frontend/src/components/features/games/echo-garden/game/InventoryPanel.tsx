"use client";

import React from "react";
import { X } from "lucide-react";
import type { GardenProduce, GardenSellLine, GardenState, GardenTier } from "@/types/garden";
import { ActionButton, CoinIcon, EASE, FOCUS_RING, FertilizerIcon, GardenSheet, WaterIcon } from "./gardenUi";
import { TIER_LABEL, cropIconUrl, formatNumber } from "./gardenModel";
import { LogisticsTabs, orderReserve, type LogisticsTab } from "./EconomyPanels";
import { FarmRecords, SupplyStock } from "./FarmingPanels";

interface InventoryPanelProps {
  state: GardenState;
  busy: string | null;
  onClose: () => void;
  onSell: (lines: GardenSellLine[], from: HTMLElement | null) => void;
  onStudy: () => void;
  /** Phase 3A: switch to the delivery board / market tabs of the same sheet. */
  onTab?: (tab: LogisticsTab) => void;
  /** Phase 3H: sell harvest portions at their proportional value (the server prices them). */
  onSellShares?: (lines: Array<{ cropCode: string; tier: GardenTier; portions: number }>) => void;
}

/**
 * Kho + SellSheet (GDD 04 §6): server unit prices (blessing included), one-tap "Bán hết". Phase 3A: produce an open order
 * needs is marked, and "Bán hết, giữ hàng cho đơn" sells everything else (the order itself never reserves stock).
 */
export function InventoryPanel({ state, busy, onClose, onSell, onStudy, onTab, onSellShares }: InventoryPanelProps) {
  const shares = [...(state.inventory.shares ?? [])].sort((a, b) => a.cropCode.localeCompare(b.cropCode) || a.tier.localeCompare(b.tier));
  const sharesTotal = shares.reduce((sum, s) => sum + s.value, 0);
  const name = (code: string) => state.crops.find((c) => c.code === code)?.nameVi ?? code;
  const produce = [...state.inventory.produce].sort((a, b) => a.cropCode.localeCompare(b.cropCode) || a.tier.localeCompare(b.tier));
  const total = produce.reduce((sum, p) => sum + p.unitPrice * p.qty, 0);
  const g = state.today.goal;
  const missing = Math.max(0, Math.ceil(g.targetUnits - g.effectiveUnits));
  const line = (p: GardenProduce): GardenSellLine => ({ cropCode: p.cropCode, tier: p.tier, qty: p.qty });
  const mult = String(state.today.blessingMultiplier).replace(".", ",");
  const keep = state.economy ? orderReserve(state) : new Map<string, number>();
  const kept = (p: GardenProduce) => keep.get(`${p.cropCode}|${p.tier}`) ?? 0;
  const sellable = produce.map((p) => ({ ...line(p), qty: p.qty - kept(p) })).filter((l) => l.qty > 0);
  const keptUnits = [...keep.values()].reduce((a, b) => a + b, 0);
  const sellableTotal = produce.reduce((sum, p) => sum + p.unitPrice * Math.max(0, p.qty - kept(p)), 0);
  return (
    <GardenSheet labelledBy="garden-inventory-title" onClose={onClose} testId="garden-inventory" wide>
      {onTab && <LogisticsTabs active="inventory" onTab={onTab} state={state} />}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold text-[#FFD978]/90">Nông sản, hạt giống, vật tư</p>
          <h2 id="garden-inventory-title" className="mt-0.5 text-lg font-black text-[#EEF3FF]">Kho</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/80 transition-[background-color,transform] duration-200 ${EASE} hover:bg-white/20 active:scale-[0.94] ${FOCUS_RING} cursor-pointer sm:h-9 sm:w-9`}
          aria-label="Đóng Kho"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div
        className={`mt-3 rounded-[16px_13px_16px_14px] border px-3 py-2 text-[12px] ${state.today.blessing ? "border-[#F4B63F]/40 bg-[#F4B63F]/10 text-[#FFE7A8]" : "border-white/10 bg-black/20 text-[#EEF3FF]/80"}`}
        data-testid="garden-blessing"
      >
        {state.today.blessing ? (
          <p className="font-bold">Phúc Lành Echo đang bật: giá bán ×{mult} cả ngày.</p>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <p>Ôn thêm {missing} thẻ hôm nay để có Phúc Lành Echo: giá bán ×{mult}.</p>
            <ActionButton tone="quiet" className="min-h-[36px] shrink-0 px-3 text-xs" onClick={onStudy}>Đi học</ActionButton>
          </div>
        )}
      </div>

      <h3 className="mt-4 text-[12px] font-bold text-[#EEF3FF]/70">Nông sản</h3>
      {produce.length === 0 ? (
        <p className="mt-1.5 text-[13px] text-[#EEF3FF]/70" data-testid="garden-inventory-empty">Kho đang trống. Thu hoạch ô đã chín để có nông sản.</p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1.5" data-testid="garden-produce-list">
          {produce.map((p) => (
            <li key={`${p.cropCode}-${p.tier}`} className="flex items-center gap-2.5 rounded-[14px] border border-white/10 bg-black/20 px-2.5 py-1.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={cropIconUrl(p.cropCode)} alt="" className="h-9 w-9 shrink-0 object-contain" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-bold text-[#EEF3FF]">{name(p.cropCode)} <span className="font-semibold text-[#EEF3FF]/60">×{p.qty}</span></p>
                <p className="text-[11px] text-[#EEF3FF]/60">{TIER_LABEL[p.tier]} · {formatNumber(p.unitPrice)} Đồng Echo mỗi cái</p>
                {kept(p) > 0 && (
                  <p className="text-[11px] font-semibold text-[#c6ecfb]" data-testid="garden-produce-kept">Đơn hàng cần {kept(p)}</p>
                )}
              </div>
              <ActionButton tone="quiet" className="min-h-[36px] px-3 text-xs" disabled={busy !== null}
                onClick={() => onSell([line(p)], null)} ariaLabel={`Bán ${p.qty} ${name(p.cropCode)} ${TIER_LABEL[p.tier]}`}>
                Bán
              </ActionButton>
            </li>
          ))}
        </ul>
      )}
      {keptUnits > 0 && sellable.length > 0 && (
        <ActionButton
          tone="care"
          className="mt-3 w-full"
          disabled={busy !== null}
          testId="garden-sell-keep-orders"
          onClick={() => onSell(sellable, document.querySelector<HTMLElement>("[data-testid='garden-sell-keep-orders']"))}
        >
          Bán hết, giữ {keptUnits} cho đơn · <CoinIcon className="h-4 w-4" /> {formatNumber(sellableTotal)} Đồng Echo
        </ActionButton>
      )}
      {produce.length > 0 && (
        <ActionButton
          tone={keptUnits > 0 ? "quiet" : "reward"}
          className={keptUnits > 0 ? "mt-2 w-full" : "mt-3 w-full"}
          disabled={busy !== null}
          testId="garden-sell-all"
          onClick={() => onSell(produce.map(line), document.querySelector<HTMLElement>("[data-testid='garden-sell-all']"))}
        >
          Bán hết, nhận <CoinIcon className="h-4 w-4" /> {formatNumber(total)} Đồng Echo
        </ActionButton>
      )}

      {shares.length > 0 && (
        <div className="mt-4" data-testid="garden-shares">
          <h3 className="text-[12px] font-bold text-[#EEF3FF]/70">Nông sản lẻ (phần)</h3>
          <p className="mt-0.5 text-[11px] leading-snug text-[#EEF3FF]/60">
            Khi khách lấy một ít từ cây chín, nông sản được chia thành {shares[0].unitPortions} phần: bạn giữ phần còn lại. Đủ {shares[0].unitPortions} phần
            cùng loại và cùng hạng sẽ tự gộp thành 1 nông sản. Bạn cũng có thể bán ngay các phần lẻ theo đúng tỉ lệ giá của một nông sản (làm tròn xuống).
          </p>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {shares.map((s) => (
              <li key={`${s.cropCode}-${s.tier}`} className="flex items-center gap-2.5 rounded-[14px] border border-white/10 bg-black/20 px-2.5 py-1.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={cropIconUrl(s.cropCode)} alt="" className="h-9 w-9 shrink-0 object-contain opacity-90" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-bold text-[#EEF3FF]">{s.nameVi} <span className="font-semibold text-[#EEF3FF]/60">{s.portions}/{s.unitPortions} phần</span></p>
                  <p className="text-[11px] text-[#EEF3FF]/60">{TIER_LABEL[s.tier]} · cả cái {formatNumber(s.unitPrice)}, {s.portions} phần bán được {formatNumber(s.value)} Đồng Echo</p>
                </div>
                <ActionButton tone="quiet" className="min-h-[36px] px-3 text-xs" disabled={busy !== null || !onSellShares || s.value <= 0}
                  testId={`garden-share-sell-${s.cropCode}-${s.tier}`}
                  onClick={() => onSellShares?.([{ cropCode: s.cropCode, tier: s.tier, portions: s.portions }])}
                  ariaLabel={`Bán ${s.portions} phần ${s.nameVi} ${TIER_LABEL[s.tier]}, nhận ${s.value} Đồng Echo`}>
                  Bán
                </ActionButton>
              </li>
            ))}
          </ul>
          {shares.length > 1 && sharesTotal > 0 && (
            <ActionButton tone="quiet" className="mt-2 w-full" disabled={busy !== null || !onSellShares} testId="garden-shares-sell-all"
              onClick={() => onSellShares?.(shares.filter((s) => s.value > 0).map((s) => ({ cropCode: s.cropCode, tier: s.tier, portions: s.portions })))}>
              Bán hết phần lẻ, nhận <CoinIcon className="h-4 w-4" /> {formatNumber(sharesTotal)} Đồng Echo
            </ActionButton>
          )}
        </div>
      )}

      <h3 className="mt-4 text-[12px] font-bold text-[#EEF3FF]/70">Hạt giống và vật tư</h3>
      <div className="mt-1.5 flex flex-wrap gap-1.5 text-[12px]">
        {state.inventory.seeds.map((s) => (
          <span key={s.cropCode} className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[#EEF3FF]/85">Hạt {name(s.cropCode)} ×{s.qty}</span>
        ))}
        <span className="flex items-center gap-1 rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[#EEF3FF]/85"><WaterIcon className="h-3.5 w-3.5" />Nước ×{state.inventory.water}</span>
        <span className="flex items-center gap-1 rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[#EEF3FF]/85"><FertilizerIcon className="h-3.5 w-3.5" />Phân bón ×{state.inventory.fertilizer}</span>
        {state.inventory.fertilizerPremium > 0 && (
          <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[#EEF3FF]/85">Thượng hạng ×{state.inventory.fertilizerPremium}</span>
        )}
      </div>
      <SupplyStock state={state} />
      {state.farming && <FarmRecords />}
      <p className="mt-3 text-[11px] leading-relaxed text-[#EEF3FF]/55">
        Hết hạt thì bấm Gieo ở ô trống để mua đúng giá niêm yết. Nước đến từ việc ôn thẻ, phân bón từ bài học kỹ năng; Quầy Chợ Echo bán thêm phân bón và gói hạt đúng mùa.
      </p>
    </GardenSheet>
  );
}
