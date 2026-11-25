"use client";

import React, { useState } from "react";
import { Droplets, Lock } from "lucide-react";
import type {
  GardenOffer, GardenPlot, GardenRecords, GardenShopCategory, GardenState, GardenSupplyItem, GardenTier,
} from "@/types/garden";
import { gardenApi } from "@/services/gardenApi";
import { ActionButton, Chip, CoinIcon, EASE, FOCUS_RING } from "./gardenUi";
import {
  MASTERY_LABEL, SHOP_CATEGORIES, SHOP_UPCOMING, SOIL_LABEL, SUPPLY_INFO, TIER_LABEL, activeProtections, cropIconUrl, formatNumber,
  protectionText, soilNote, soilQualityNote, supplyArtUrl, supplyEffectText, thirstLabel,
} from "./gardenModel";
import type { EchoGardenGame } from "./useEchoGarden";

/*
 * Phase 3D farming UI: the soil of one bed and the supplies that act on it (plot card), the categorised Echo market
 * shelves, the supply stock and the lifetime farm records (storehouse). Every number is a server fact; every purchase is
 * choose → confirm; applying a supply is one tap like watering (the server re-checks everything).
 */

const tierLabel = (code: string) => TIER_LABEL[code as GardenTier] ?? code;

// ------------------------------------------------------------------ plot card: soil + supplies

/** Soil moisture of a growing crop: a meter with the dry and waterlogged zones, one diagnosis, what it costs, what is on. */
export function SoilCard({ state, plot, serverNowMs }: { state: GardenState; plot: GardenPlot; serverNowMs: number }) {
  const p = plot.planting;
  const s = p?.soil;
  const rules = state.farming?.soil;
  if (!p || !s || !rules) return null;
  const note = soilNote(p, serverNowMs, tierLabel);
  const quality = p.ready ? null : soilQualityNote(s, tierLabel);
  const active = activeProtections(p, serverNowMs);
  const pct = Math.max(0, Math.min(100, s.moisture));
  const tone = s.status === "DRY" ? "text-[#ffd2b0]" : s.status === "WET" ? "text-[#c6ecfb]" : "text-[#a6e6b3]";
  return (
    <section className="mt-3 rounded-[16px_13px_16px_14px] border border-white/10 bg-black/20 px-3 py-2.5" data-testid="garden-soil" aria-label="Tình trạng đất">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[12px] font-bold text-[#EEF3FF]">
          <Droplets className="h-3.5 w-3.5 text-[#7FD3F5]" aria-hidden />
          Độ ẩm đất
        </p>
        <span className={`text-[12px] font-black ${tone}`} data-testid="garden-soil-status">{SOIL_LABEL[s.status]} · {Math.round(pct)}%</span>
      </div>
      <div className="relative mt-2 h-2.5 overflow-hidden rounded-full bg-white/10" role="meter" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={Math.round(pct)} aria-label={`Độ ẩm ${Math.round(pct)} phần trăm, ${SOIL_LABEL[s.status]}`}>
        <span className="absolute inset-y-0 left-0 bg-[#F2A36B]/35" style={{ width: `${rules.dryBelow}%` }} />
        <span className="absolute inset-y-0 right-0 bg-[#7FD3F5]/35" style={{ width: `${100 - rules.wetAbove}%` }} />
        <span className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ${s.status === "DRY" ? "bg-[#F2A36B]" : s.status === "WET" ? "bg-[#5fb6dd]" : "bg-gradient-to-r from-[#5fb97a] to-[#8fd6c0]"}`}
          style={{ width: `${Math.max(3, pct)}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-[#EEF3FF]/45">
        <span>Khô hạn dưới {rules.dryBelow}</span>
        <span>{thirstLabel(s.thirst)}</span>
        <span>Úng trên {rules.wetAbove}</span>
      </div>
      {note && (
        <p className={`mt-2 text-[12px] leading-snug ${note.tone === "warn" ? "text-[#ffd2b0]" : note.tone === "info" ? "text-[#c6ecfb]" : "text-[#EEF3FF]/75"}`} data-testid="garden-soil-note">
          {note.text}
        </p>
      )}
      {quality && <p className="mt-1.5 text-[11px] leading-snug text-[#ffd2b0]/90" data-testid="garden-soil-quality">{quality}</p>}
      {active.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5" data-testid="garden-protections" aria-label="Vật tư đang có tác dụng">
          {active.map((x) => (
            <li key={`${x.itemCode}-${x.appliedAt}`} className="flex items-center gap-1.5 rounded-full border border-[#3fcfc0]/30 bg-[#3fcfc0]/10 py-0.5 pl-1 pr-2.5 text-[11px] font-semibold text-[#9cefe0]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={supplyArtUrl(x.itemCode)} alt="" className="h-5 w-5 object-contain" />
              {protectionText(x, serverNowMs)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Protections on a crop that has no soil card (a ripe crop or one planted under the earlier rules). */
export function ProtectionChips({ plot, serverNowMs }: { plot: GardenPlot; serverNowMs: number }) {
  const p = plot.planting;
  const active = p ? activeProtections(p, serverNowMs) : [];
  if (active.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5" data-testid="garden-protections" aria-label="Vật tư đang có tác dụng">
      {active.map((x) => (
        <li key={`${x.itemCode}-${x.appliedAt}`} className="flex items-center gap-1.5 rounded-full border border-[#3fcfc0]/30 bg-[#3fcfc0]/10 py-0.5 pl-1 pr-2.5 text-[11px] font-semibold text-[#9cefe0]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={supplyArtUrl(x.itemCode)} alt="" className="h-5 w-5 object-contain" />
          {protectionText(x, serverNowMs)}
        </li>
      ))}
    </ul>
  );
}

/** Why a supply cannot be used on this crop right now (null = it can). The server re-checks every one of these. */
function blocked(item: GardenSupplyItem, plot: GardenPlot, state: GardenState, serverNowMs: number): string | null {
  const p = plot.planting!;
  const active = activeProtections(p, serverNowMs);
  const pestItem = item.effect === "PEST_SPRAY" || item.effect === "PEST_NET";
  if (!pestItem && (!p.soil || p.ready)) return "Cây không cần";
  if (item.effect === "PEST_SPRAY" && !(p.pestId && (p.pestStage ?? 0) > 0)) return "Không có sâu";
  if (item.effect === "MOISTURE" && p.soil && state.farming && p.soil.moisture >= state.farming.soil.wetAbove) return "Đất đủ ẩm";
  if (item.effect === "TONIC" && p.soil?.toned) return "Đã dùng vụ này";
  if (active.some((x) => x.effect === item.effect)) return "Đang có tác dụng";
  return null;
}

/** Supplies in the storehouse that fit this crop: one tap applies one (like watering). */
export function SupplyShelf({ state, plot, serverNowMs, busy, onTreat, onShop }: {
  state: GardenState; plot: GardenPlot; serverNowMs: number; busy: string | null; onTreat: (itemCode: string) => void; onShop: () => void;
}) {
  const farming = state.farming;
  const p = plot.planting;
  if (!farming || !p || p.id < 0) return null;
  const mine = farming.items.filter((i) => i.effect !== "BOOST" && i.owned > 0);
  const pestOnly = !p.soil || p.ready;
  const shown = mine.filter((i) => !pestOnly || i.effect === "PEST_SPRAY" || i.effect === "PEST_NET");
  if (pestOnly && shown.length === 0) return null;
  return (
    <section className="mt-3" data-testid="garden-supply-shelf" aria-label="Vật tư chăm cây">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[12px] font-bold text-[#EEF3FF]/70">Vật tư của bạn</h3>
        <button type="button" onClick={onShop} data-testid="garden-supply-shop"
          className={`min-h-[44px] rounded-full px-2.5 text-[11px] font-bold text-[#FFD978] hover:bg-white/10 ${FOCUS_RING} cursor-pointer`}>
          Quầy Chợ Echo ›
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="mt-1 text-[12px] leading-snug text-[#EEF3FF]/60">
          Bạn chưa có vật tư nào. Quầy Chợ Echo bán nước giếng, rơm phủ, bạt che và thuốc xịt bằng Đồng Echo.
        </p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {shown.map((i) => {
            const why = blocked(i, plot, state, serverNowMs);
            return (
              <li key={i.code} className="flex items-center gap-2.5 rounded-[14px] border border-white/10 bg-black/20 px-2.5 py-1.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={supplyArtUrl(i.code)} alt="" className="h-10 w-10 shrink-0 object-contain" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-bold text-[#EEF3FF]">{SUPPLY_INFO[i.code]?.title ?? i.nameVi} <span className="font-semibold text-[#EEF3FF]/55">×{i.owned}</span></p>
                  <p className="text-[11px] leading-snug text-[#EEF3FF]/60">{supplyEffectText(i, state.boosts)}</p>
                </div>
                <ActionButton tone="care" className="min-h-[44px] shrink-0 px-3 text-xs" disabled={why !== null || busy !== null}
                  onClick={() => onTreat(i.code)} testId={`garden-treat-${i.code}`} ariaLabel={`Dùng ${SUPPLY_INFO[i.code]?.title ?? i.nameVi}`}>
                  {why ?? "Dùng"}
                </ActionButton>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ Echo market: categorised shelves

export function categoryOf(o: GardenOffer): GardenShopCategory {
  return o.category ?? (o.kind === "PACK" ? "SEEDS" : "CARE");
}

/** The market's shelves: one tab per category that has goods today, plus the shelves that open in later phases. */
export function ShopShelves({ offers, active, onPick }: { offers: GardenOffer[]; active: GardenShopCategory; onPick: (c: GardenShopCategory) => void }) {
  const counts = new Map<GardenShopCategory, number>();
  offers.forEach((o) => counts.set(categoryOf(o), (counts.get(categoryOf(o)) ?? 0) + 1));
  return (
    <div role="tablist" aria-label="Kệ hàng của Quầy Chợ Echo" className="mt-3 flex flex-wrap gap-1.5" data-testid="garden-shop-shelves">
      {SHOP_CATEGORIES.filter((c) => (counts.get(c.id) ?? 0) > 0).map((c) => (
        <button key={c.id} type="button" role="tab" aria-selected={active === c.id} data-testid={`garden-shop-tab-${c.id}`} onClick={() => onPick(c.id)}
          className={`flex min-h-[44px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-[12px] font-bold transition-[background-color,color] duration-200 ${EASE} ${FOCUS_RING} cursor-pointer ${active === c.id ? "border-[#FFD978]/60 bg-[#FFD978]/90 text-[#3a2a0a]" : "border-white/10 bg-black/20 text-[#EEF3FF]/80 hover:bg-white/10"}`}>
          {c.label}
          <span className={`rounded-full px-1.5 text-[10px] font-black tabular-nums ${active === c.id ? "bg-[#3a2a0a]/15" : "bg-white/10"}`}>{counts.get(c.id)}</span>
        </button>
      ))}
    </div>
  );
}

/** Shelves of later phases: named, clearly closed, never a button. */
export function UpcomingShelves() {
  return (
    <div className="mt-4 rounded-[14px] border border-dashed border-white/15 px-3 py-2.5" data-testid="garden-shop-upcoming">
      <p className="text-[11px] font-bold text-[#EEF3FF]/60">Kệ hàng sẽ mở sau</p>
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {SHOP_UPCOMING.map((label) => (
          <li key={label} className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-[#EEF3FF]/50">
            <Lock className="h-3 w-3" aria-hidden />
            {label}
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[10px] leading-snug text-[#EEF3FF]/45">Chưa có món nào ở các kệ này được bán. Đồng Echo của bạn vẫn giữ nguyên.</p>
    </div>
  );
}

/** One product of the market: art, what it does (server numbers), price, stock, daily turns; buying is choose → confirm. */
export function ShopOffer({ offer, game }: { offer: GardenOffer; game: EchoGardenGame }) {
  const state = game.state!;
  const [confirming, setConfirming] = useState(false);
  const crop = offer.cropCode ? state.crops.find((c) => c.code === offer.cropCode) : undefined;
  const item = state.farming?.items.find((i) => i.code === offer.item);
  const boost = state.boosts.find((b) => b.code === offer.item);
  const title = offer.kind === "PACK" ? `Gói ${offer.unitQty} hạt ${offer.nameVi}` : SUPPLY_INFO[offer.item]?.title ?? offer.nameVi;
  const effect = item ? supplyEffectText(item, state.boosts)
    : boost ? `Rút ngắn ${Math.round(boost.fraction * 100)}% thời gian lớn của một vụ (mỗi vụ một lần phân bón).`
    : crop ? `Rẻ hơn ${formatNumber(offer.unitQty * crop.seedPrice - offer.price)} Đồng Echo so với mua lẻ khi gieo.` : "";
  const owned = offer.kind === "PACK"
    ? state.inventory.seeds.find((s) => s.cropCode === offer.cropCode)?.qty ?? 0
    : item?.owned ?? (offer.item === "FERTILIZER" ? state.inventory.fertilizer : offer.item === "FERTILIZER_PREMIUM" ? state.inventory.fertilizerPremium : 0);
  const soldOut = offer.remaining <= 0;
  const poor = state.profile.coins < offer.price;
  return (
    <li className="rounded-[18px_14px_18px_16px] border border-white/10 bg-black/20 px-3 py-2.5" data-testid={`garden-offer-${offer.code}`}>
      <div className="flex items-start gap-3">
        {/* a parchment shelf tile: the product art (clear film, white mesh, glass) reads on it at a glance */}
        <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[16px_13px_16px_14px] bg-gradient-to-b from-[#f6eed8] to-[#dccb9f] shadow-[inset_0_1px_0_rgba(255,255,255,0.75),0_6px_12px_-8px_rgba(0,0,0,0.7)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={crop ? cropIconUrl(crop.code) : supplyArtUrl(offer.item)} alt="" className={`h-14 w-14 object-contain drop-shadow-[0_2px_2px_rgba(60,40,10,0.35)] ${offer.locked ? "opacity-60 grayscale" : ""}`} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold leading-tight text-[#EEF3FF]">{title}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-[#EEF3FF]/70">{effect}</p>
          {SUPPLY_INFO[offer.item] && <p className="mt-0.5 text-[11px] leading-snug text-[#c6ecfb]/80">{SUPPLY_INFO[offer.item].when}</p>}
        </div>
        <span className="flex shrink-0 items-center gap-1 text-[14px] font-black tabular-nums text-[#FFD978]" aria-label={`Giá ${formatNumber(offer.price)} Đồng Echo`}>
          <CoinIcon className="h-4 w-4" />{formatNumber(offer.price)}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {offer.kind === "PACK" && crop && crop.season !== "ALL" && <Chip tone="good">Hạt đúng mùa</Chip>}
        {offer.locked ? <Chip tone="warn">Mở ở Cấp {offer.unlockLevel}</Chip> : <Chip>Còn {offer.remaining}/{offer.dailyCap} lượt hôm nay</Chip>}
        <Chip tone={owned > 0 ? "info" : "quiet"} testId={`garden-offer-owned-${offer.code}`}>Đang có {owned}</Chip>
      </div>
      {!offer.locked && (
        confirming ? (
          <div className="mt-2 flex items-center gap-2" data-testid={`garden-offer-confirm-${offer.code}`}>
            <p className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-[12px] text-[#EEF3FF]">
              Mua 1 {offer.kind === "PACK" ? "gói" : "món"} với <CoinIcon className="h-3.5 w-3.5" /><b>{formatNumber(offer.price)}</b> Đồng Echo?
            </p>
            <ActionButton tone="reward" className="min-h-[44px] text-xs" disabled={game.busy !== null} testId={`garden-offer-buy-${offer.code}`}
              onClick={async () => {
                const r = await game.marketBuy(offer, 1);
                if (r) setConfirming(false);
              }}>
              Xác nhận
            </ActionButton>
            <ActionButton tone="quiet" className="min-h-[44px] text-xs" onClick={() => setConfirming(false)}>Huỷ</ActionButton>
          </div>
        ) : (
          <ActionButton tone="quiet" className="mt-2 w-full min-h-[44px] text-xs" disabled={soldOut || poor || game.busy !== null}
            testId={`garden-offer-start-${offer.code}`} onClick={() => setConfirming(true)}>
            {soldOut ? "Đã hết lượt hôm nay" : poor ? `Cần ${formatNumber(offer.price)} Đồng Echo` : "Mua"}
          </ActionButton>
        )
      )}
    </li>
  );
}

// ------------------------------------------------------------------ storehouse: supply stock + lifetime records

export function SupplyStock({ state }: { state: GardenState }) {
  const mine = (state.farming?.items ?? []).filter((i) => i.effect !== "BOOST" && i.owned > 0);
  if (mine.length === 0) return null;
  return (
    <ul className="mt-1.5 flex flex-wrap gap-1.5 text-[12px]" data-testid="garden-supply-stock">
      {mine.map((i) => (
        <li key={i.code} className="flex items-center gap-1.5 rounded-full border border-white/10 bg-black/20 py-0.5 pl-1 pr-2.5 text-[#EEF3FF]/85">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={supplyArtUrl(i.code)} alt="" className="h-6 w-6 object-contain" />
          {SUPPLY_INFO[i.code]?.title ?? i.nameVi} ×{i.owned}
        </li>
      ))}
    </ul>
  );
}

/** "Sổ nông trại": what the farm has grown over its whole life (never lowered by a sale) and where the produce went. */
export function FarmRecords() {
  const [records, setRecords] = useState<GardenRecords | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const open = async () => {
    setState("loading");
    try {
      setRecords(await gardenApi.records());
      setState("idle");
    } catch {
      setState("error");
    }
  };
  if (!records) {
    return (
      <div className="mt-4">
        <ActionButton tone="quiet" className="w-full text-xs" disabled={state === "loading"} onClick={() => void open()} testId="garden-records-open">
          {state === "loading" ? "Đang mở sổ…" : "Xem Sổ nông trại (thành tích trọn đời)"}
        </ActionButton>
        {state === "error" && <p className="mt-1.5 text-[11px] text-[#F2777A]" role="alert">Chưa mở được sổ, hãy thử lại sau ít phút.</p>}
      </div>
    );
  }
  return (
    <section className="mt-4 rounded-[18px_14px_18px_16px] border border-[#FFD978]/20 bg-[#FFD978]/[0.06] px-3 py-3" data-testid="garden-records" aria-label="Sổ nông trại">
      <h3 className="text-[13px] font-black text-[#FFE7A8]">Sổ nông trại</h3>
      <p className="mt-0.5 text-[11px] leading-snug text-[#EEF3FF]/60">Số đã thu hoạch là thành tích trọn đời: bán, giao hay ủ nông sản không làm con số này giảm.</p>
      <div className="mt-2 grid grid-cols-3 gap-1.5 text-center">
        {[
          ["Đã thu hoạch", formatNumber(records.harvestedTotal), false],
          ["Đồng Echo từ bán", formatNumber(records.saleCoins), true],
          ["Thưởng thu hoạch", formatNumber(records.harvestBonusCoins), true],
        ].map(([label, value, coin]) => (
          <div key={String(label)} className="rounded-[12px] border border-white/10 bg-black/20 px-1.5 py-1.5">
            <p className="flex items-center justify-center gap-1 text-[13px] font-black tabular-nums text-[#EEF3FF]">{coin && <CoinIcon className="h-3.5 w-3.5" />}{value}</p>
            <p className="text-[10px] leading-tight text-[#EEF3FF]/55">{label}</p>
          </div>
        ))}
      </div>
      {records.crops.length === 0 ? (
        <p className="mt-2 text-[12px] text-[#EEF3FF]/70">Chưa có vụ thu hoạch nào được ghi lại.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[300px] text-left text-[11px]" data-testid="garden-records-table">
            <caption className="sr-only">Thành tích từng loại cây</caption>
            <thead className="text-[#EEF3FF]/50">
              <tr>
                <th scope="col" className="py-1 pr-2 font-semibold">Loại cây</th>
                <th scope="col" className="px-1 py-1 text-right font-semibold">Đã thu</th>
                <th scope="col" className="px-1 py-1 text-right font-semibold">Trong kho</th>
                <th scope="col" className="px-1 py-1 text-right font-semibold">Đã bán</th>
                <th scope="col" className="px-1 py-1 text-right font-semibold">Giao đơn</th>
                <th scope="col" className="py-1 pl-1 text-right font-semibold">Ủ / góp</th>
              </tr>
            </thead>
            <tbody className="tabular-nums text-[#EEF3FF]/85">
              {records.crops.map((c) => (
                <tr key={c.cropCode} className="border-t border-white/[0.07]">
                  <th scope="row" className="py-1 pr-2 text-left font-bold text-[#EEF3FF]">
                    <span className="flex items-center gap-1.5">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={cropIconUrl(c.cropCode)} alt="" className="h-5 w-5 object-contain" />
                      {c.nameVi}
                      {c.masteryTier > 0 && <span className="font-semibold text-[#9cefe0]">· {MASTERY_LABEL[c.masteryTier] ?? ""}</span>}
                    </span>
                  </th>
                  <td className="px-1 py-1 text-right font-black text-[#FFE7A8]">{formatNumber(c.harvested)}</td>
                  <td className="px-1 py-1 text-right">{formatNumber(c.inStock)}</td>
                  <td className="px-1 py-1 text-right">{formatNumber(c.sold)}</td>
                  <td className="px-1 py-1 text-right">{formatNumber(c.delivered)}</td>
                  <td className="py-1 pl-1 text-right">{formatNumber(c.composted + c.used)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-[#EEF3FF]/60">
        Giao đơn hàng đã mang về <CoinIcon className="h-3.5 w-3.5" /><b className="text-[#EEF3FF]/85">{formatNumber(records.orderCoins)}</b> Đồng Echo.
      </p>
    </section>
  );
}
