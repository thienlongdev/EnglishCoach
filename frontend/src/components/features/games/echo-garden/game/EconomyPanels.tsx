"use client";

import React, { useState } from "react";
import { Check, X } from "lucide-react";
import type {
  GardenBoardSlot, GardenExpansionPlot, GardenOrder, GardenShopCategory, GardenState, GardenSupply,
} from "@/types/garden";
import { ActionButton, Chip, CoinIcon, EASE, FOCUS_RING, GardenSheet } from "./gardenUi";
import { TIER_LABEL, clockTime, cropIconUrl, formatNumber, itemLabel, timeLeft } from "./gardenModel";
import type { EchoGardenGame } from "./useEchoGarden";
import { ShopOffer, ShopShelves, UpcomingShelves, categoryOf } from "./FarmingPanels";
import { SHOP_CATEGORIES } from "./gardenModel";

/*
 * Phase 3A farm logistics (blueprint §6): the delivery board, the market stall and the expansion card. Every number is a
 * server fact from `state.economy`; actions are two-step (choose → confirm) and the server re-checks everything.
 */

export type LogisticsTab = "inventory" | "orders" | "market" | "codex" | "animals";

/** The Kho sheet's tabs: stock, delivery board, market stall and (Phase 3B) the codex — no new permanent HUD button. */
export function LogisticsTabs({ active, onTab, state }: { active: LogisticsTab; onTab: (t: LogisticsTab) => void; state: GardenState }) {
  const fillable = state.economy.board.slots.filter((s) => s.order?.status === "OPEN" && s.order.fillable).length;
  const tabs: Array<{ id: LogisticsTab; label: string; badge?: number }> = [
    { id: "inventory", label: "Kho" },
    { id: "orders", label: "Đơn hàng", badge: fillable },
    { id: "market", label: "Chợ" },
    { id: "codex", label: "Sổ tay" },
    // Phase 3H: the animal quarter (shown once the garden has the animals rules); the badge counts houses with products
    ...(state.animals ? [{ id: "animals" as const, label: "Trại", badge: state.animals.houses.filter((h) => h.ready > 0).length }] : []),
  ];
  return (
    <div role="tablist" aria-label="Kho, đơn hàng, chợ, sổ tay và chuồng trại" className="mb-3 flex gap-1 rounded-[16px] border border-white/10 bg-black/25 p-1" data-testid="garden-logistics-tabs">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          data-testid={`garden-tab-${t.id}`}
          onClick={() => onTab(t.id)}
          className={`relative flex min-h-[44px] min-w-0 flex-1 items-center justify-center whitespace-nowrap rounded-[12px] px-1 text-[12px] font-bold transition-[background-color,color] duration-200 sm:text-[13px] ${EASE} ${FOCUS_RING} cursor-pointer ${active === t.id ? "bg-[#FFD978]/90 text-[#3a2a0a]" : "text-[#EEF3FF]/75 hover:bg-white/10"}`}
        >
          {t.label}
          {!!t.badge && (
            <span className={`absolute right-0.5 top-0.5 rounded-full px-1 text-[9px] font-black leading-[14px] tabular-nums ${active === t.id ? "bg-[#3a2a0a]/80 text-[#FFD978]" : "bg-[#74C98B] text-[#0f2a18]"}`} aria-label={t.id === "animals" ? `${t.badge} chuồng có sản phẩm` : `${t.badge} đơn có thể giao`}>
              {t.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function SheetHeader({ id, kicker, title, onClose, closeLabel }: { id: string; kicker: string; title: string; onClose: () => void; closeLabel: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="text-[11px] font-semibold text-[#FFD978]/90">{kicker}</p>
        <h2 id={id} className="mt-0.5 text-lg font-black text-[#EEF3FF]">{title}</h2>
      </div>
      <button
        type="button"
        onClick={onClose}
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/80 transition-[background-color,transform] duration-200 ${EASE} hover:bg-white/20 active:scale-[0.94] ${FOCUS_RING} cursor-pointer sm:h-9 sm:w-9`}
        aria-label={closeLabel}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

const TIER_RANK: Record<string, number> = { NORMAL: 0, GOOD: 1, PERFECT: 2, GOLDEN: 3 };

/** "2 Hoa hồng Normal, 4 Hoa hồng Good" — grouped by crop, lowest tier first (the order the server consumes). */
const supplyText = (lines: GardenSupply[], name: (code: string) => string) =>
  [...lines].sort((a, b) => a.cropCode.localeCompare(b.cropCode) || TIER_RANK[a.tier] - TIER_RANK[b.tier])
    .map((l) => `${l.qty} ${name(l.cropCode)} ${TIER_LABEL[l.tier]}`).join(", ");

/** Coins the same units would fetch if sold now (inventory unit prices already include today's blessing). */
function saleValue(state: GardenState, lines: GardenSupply[]): number {
  return lines.reduce((sum, l) => {
    const unit = state.inventory.produce.find((p) => p.cropCode === l.cropCode && p.tier === l.tier)?.unitPrice ?? 0;
    return sum + unit * l.qty;
  }, 0);
}

// ------------------------------------------------------------------ delivery board

export function OrdersPanel({ game, onClose, onTab }: { game: EchoGardenGame; onClose: () => void; onTab: (t: LogisticsTab) => void }) {
  const state = game.state!;
  const board = state.economy.board;
  const serverNow = game.serverNow();
  const name = (code: string) => state.crops.find((c) => c.code === code)?.nameVi ?? code;
  const record = Object.entries(board.deliveryRecord).filter(([, n]) => n > 0);
  const mult = String(board.blessingMultiplier).replace(".", ",");
  return (
    <GardenSheet labelledBy="garden-orders-title" onClose={onClose} testId="garden-orders" wide>
      <LogisticsTabs active="orders" onTab={onTab} state={state} />
      <SheetHeader id="garden-orders-title" kicker="Bảng giao hàng cạnh cột chỉ đường" title="Đơn hàng" onClose={onClose} closeLabel="Đóng bảng đơn hàng" />
      <p className="mt-1 text-[12px] leading-relaxed text-[#EEF3FF]/70">
        Giao đúng nông sản để nhận Đồng Echo và quà. Không giao cũng không sao: đơn hết hạn tự đổi, nông sản vẫn nằm nguyên trong Kho.
      </p>
      <p className={`mt-2 rounded-[14px] border px-3 py-1.5 text-[12px] ${board.blessing ? "border-[#F4B63F]/40 bg-[#F4B63F]/10 text-[#FFE7A8]" : "border-white/10 bg-black/20 text-[#EEF3FF]/75"}`} data-testid="garden-orders-blessing">
        {board.blessing ? `Phúc Lành Echo đang bật: tiền đơn ×${mult}, như khi bán.` : `Đạt mục tiêu học hôm nay để tiền đơn và giá bán cùng ×${mult}.`}
      </p>
      <ul className="mt-3 flex flex-col gap-2" data-testid="garden-order-list">
        {board.slots.map((slot) => (
          <OrderCard key={slot.slot} slot={slot} game={game} name={name} serverNow={serverNow} />
        ))}
      </ul>
      <div className="mt-3 rounded-[14px] border border-white/10 bg-black/20 px-3 py-2" data-testid="garden-delivery-record">
        <p className="text-[12px] font-bold text-[#EEF3FF]/80">Sổ giao hàng · {formatNumber(board.filledTotal)} đơn</p>
        <p className="mt-0.5 text-[11px] text-[#EEF3FF]/60">
          {record.length ? record.map(([c, n]) => `${name(c)} ${formatNumber(n)}`).join(" · ") : "Chưa giao đơn nào. Đơn đầu tiên sẽ ghi vào đây."}
        </p>
      </div>
    </GardenSheet>
  );
}

function OrderCard({ slot, game, name, serverNow }: { slot: GardenBoardSlot; game: EchoGardenGame; name: (c: string) => string; serverNow: number }) {
  const state = game.state!;
  const [confirming, setConfirming] = useState(false);
  const order = slot.order;
  const kindLabel = slot.kind === "WEEKLY" ? "Đơn cả tuần" : "Đơn trong ngày";
  if (slot.locked) {
    return (
      <li className="rounded-[16px] border border-white/10 bg-black/15 px-3 py-2.5" data-testid={`garden-order-slot-${slot.slot}`}>
        <div className="flex items-center justify-between gap-2"><Chip>{kindLabel}</Chip><span className="text-[11px] text-[#EEF3FF]/60">Mở ở Cấp {slot.minLevel}</span></div>
      </li>
    );
  }
  if (!order) {
    return (
      <li className="rounded-[16px] border border-white/10 bg-black/15 px-3 py-2.5" data-testid={`garden-order-slot-${slot.slot}`}>
        <div className="flex items-center justify-between gap-2">
          <Chip>{kindLabel}</Chip>
          <span className="text-[11px] text-[#EEF3FF]/60">Đơn mới lúc {clockTime(Date.parse(slot.nextAt))} (còn {timeLeft(slot.nextAt, serverNow)})</span>
        </div>
      </li>
    );
  }
  const filled = order.status === "FILLED";
  const preview = order.preview;
  return (
    <li className={`rounded-[16px] border px-3 py-2.5 ${filled ? "border-[#74C98B]/25 bg-[#74C98B]/[0.07]" : "border-white/10 bg-black/20"}`} data-testid={`garden-order-slot-${slot.slot}`}>
      <div className="flex items-center justify-between gap-2">
        <Chip tone={slot.kind === "WEEKLY" ? "magic" : "quiet"}>{kindLabel}</Chip>
        <span className="text-[11px] text-[#EEF3FF]/60">
          {filled ? `Đã giao lúc ${clockTime(Date.parse(order.filledAt!))} · đơn mới sau ${timeLeft(slot.nextAt, serverNow)}`
            : order.status === "EXPIRED" ? "Đã hết hạn" : `Còn ${timeLeft(order.expiresAt, serverNow)}`}
        </span>
      </div>
      <ul className="mt-2 flex flex-col gap-1">
        {order.lines.map((l) => {
          const enough = l.held >= l.qty;
          return (
            <li key={l.cropCode} className="flex items-center gap-2 text-[13px] text-[#EEF3FF]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={cropIconUrl(l.cropCode)} alt="" className="h-8 w-8 shrink-0 object-contain" />
              <span className="min-w-0 flex-1 font-bold">{l.qty} {name(l.cropCode)}</span>
              {l.minTier !== "NORMAL" && <Chip tone="info">{TIER_LABEL[l.minTier]} trở lên</Chip>}
              {!filled && (
                <span className={`flex items-center gap-0.5 text-[11px] font-semibold tabular-nums ${enough ? "text-[#a6e6b3]" : "text-[#EEF3FF]/55"}`}>
                  {enough && <Check className="h-3 w-3" aria-hidden />}Kho {Math.min(l.held, l.qty)}/{l.qty}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-[#FFE7A8]">
        <span className="flex items-center gap-1 font-bold"><CoinIcon className="h-3.5 w-3.5" />{formatNumber(filled ? order.paidCoins ?? 0 : order.payoutNow)} Đồng Echo</span>
        {Object.entries(order.bonus).map(([code, q]) => (
          <span key={code} className="text-[#EEF3FF]/80">+ {q} {itemLabel(code, state.crops)}</span>
        ))}
      </p>
      {!filled && order.status === "OPEN" && (
        confirming && preview ? (
          <div className="mt-2 rounded-[14px] border border-[#F4B63F]/30 bg-[#F4B63F]/[0.08] p-2.5" data-testid={`garden-order-confirm-${slot.slot}`}>
            <p className="text-[12px] text-[#EEF3FF]">Sẽ giao: {supplyText(preview, name)}.</p>
            <p className="mt-0.5 text-[11px] text-[#EEF3FF]/65">Nếu bán ngay số này: {formatNumber(saleValue(state, preview))} Đồng Echo. Giao đơn: {formatNumber(order.payoutNow)} Đồng Echo và quà.</p>
            <div className="mt-2 flex gap-2">
              <ActionButton tone="reward" className="min-h-[44px] flex-1 text-xs" disabled={game.busy !== null} testId={`garden-order-fill-${slot.slot}`}
                onClick={async () => {
                  const r = await game.fillOrder(order, preview);
                  if (r) setConfirming(false);
                }}>
                Xác nhận giao
              </ActionButton>
              <ActionButton tone="quiet" className="min-h-[44px] text-xs" onClick={() => setConfirming(false)}>Huỷ</ActionButton>
            </div>
          </div>
        ) : (
          <ActionButton tone={preview ? "reward" : "quiet"} className="mt-2 w-full min-h-[44px] text-xs" disabled={!preview || game.busy !== null}
            testId={`garden-order-start-${slot.slot}`} onClick={() => setConfirming(true)}
            ariaLabel={preview ? "Giao đơn này" : "Chưa đủ nông sản để giao"}>
            {preview ? "Giao hàng" : "Chưa đủ nông sản: thu hoạch thêm rồi quay lại"}
          </ActionButton>
        )
      )}
    </li>
  );
}

// ------------------------------------------------------------------ market stall

export function MarketPanel({ game, onClose, onTab, onStall, onCosmetics, onEchoRewards }: {
  game: EchoGardenGame; onClose: () => void; onTab: (t: LogisticsTab) => void; onStall?: () => void; onCosmetics?: () => void; onEchoRewards?: () => void;
}) {
  const state = game.state!;
  const market = state.economy.market;
  const serverNow = game.serverNow();
  // Phase 3C: the stall is a building; its level only adds packs and daily turns (prices never change)
  const stall = state.estate?.buildings.find((b) => b.code === "MARKET");
  // Phase 3D: the stall's goods on categorised shelves (the category of every offer is a server fact)
  const first = SHOP_CATEGORIES.find((c) => market.offers.some((o) => categoryOf(o) === c.id))?.id ?? "SEEDS";
  const [shelf, setShelf] = useState<GardenShopCategory>(first);
  const active = market.offers.some((o) => categoryOf(o) === shelf) ? shelf : first;
  const shelfInfo = SHOP_CATEGORIES.find((c) => c.id === active);
  return (
    <GardenSheet labelledBy="garden-market-title" onClose={onClose} testId="garden-market" wide>
      <LogisticsTabs active="market" onTab={onTab} state={state} />
      <SheetHeader id="garden-market-title" kicker="Góc hạt giống cạnh cổng nông trại" title="Quầy Chợ Echo" onClose={onClose} closeLabel="Đóng quầy chợ" />
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[12px] text-[#EEF3FF]/70">
        <span>Hàng đổi lúc 0 giờ (còn {timeLeft(market.restockAt, serverNow)}).</span>
        <span className="flex items-center gap-1 font-bold text-[#FFD978]" aria-label={`Bạn có ${formatNumber(state.profile.coins)} Đồng Echo`}><CoinIcon className="h-3.5 w-3.5" />{formatNumber(state.profile.coins)}</span>
      </div>
      {stall && onStall && (
        <button type="button" onClick={onStall} data-testid="garden-market-stall"
          className={`mt-2 flex min-h-[44px] w-full items-center justify-between gap-2 rounded-[14px] border border-white/10 bg-black/20 px-3 text-left text-[12px] text-[#EEF3FF]/85 hover:bg-white/[0.08] ${FOCUS_RING} cursor-pointer`}>
          <span>Quầy đang ở Cấp {stall.level}/{stall.maxLevel}{stall.next ? " · xem nâng cấp" : " · cấp cao nhất"}</span>
          <span aria-hidden className="text-[#FFD978]">›</span>
        </button>
      )}
      {onCosmetics && state.cosmetics && (
        <button type="button" onClick={onCosmetics} data-testid="garden-market-cosmetics"
          className={`mt-2 flex min-h-[52px] w-full items-center justify-between gap-2 rounded-[16px_13px_16px_14px] border border-[#FFD978]/35 bg-gradient-to-r from-[#FFD978]/[0.16] to-[#74C98B]/[0.12] px-3 text-left hover:from-[#FFD978]/[0.24] ${FOCUS_RING} cursor-pointer`}>
          <span>
            <span className="block text-[13px] font-black text-[#EEF3FF]">Tiệm Trang Trí Echo</span>
            <span className="block text-[11px] text-[#EEF3FF]/70">Giống cây đẹp, kiểu nhà, cây cảnh, vật trang trí, rào và lối đi</span>
          </span>
          <span aria-hidden className="text-lg text-[#FFD978]">›</span>
        </button>
      )}
      {onEchoRewards && (
        <button type="button" onClick={onEchoRewards} data-testid="garden-market-echo-rewards"
          className={`mt-2 flex min-h-[52px] w-full items-center justify-between gap-2 rounded-[16px_13px_16px_14px] border border-[#9fd8ff]/35 bg-gradient-to-r from-[#9fd8ff]/[0.14] to-[#FFD978]/[0.10] px-3 text-left hover:from-[#9fd8ff]/[0.22] ${FOCUS_RING} cursor-pointer`}>
          <span>
            <span className="block text-[13px] font-black text-[#EEF3FF]">Phần thưởng Echo</span>
            <span className="block text-[11px] text-[#EEF3FF]/70">Premium 7 ngày, Phiếu AI và khung hồ sơ Echo Garden</span>
          </span>
          <span aria-hidden className="text-lg text-[#FFD978]">›</span>
        </button>
      )}
      <ShopShelves offers={market.offers} active={active} onPick={setShelf} />
      {shelfInfo && <p className="mt-2 text-[12px] text-[#EEF3FF]/70">{shelfInfo.note}</p>}
      <ul className="mt-2 flex flex-col gap-2" data-testid="garden-offer-list">
        {market.offers.filter((o) => categoryOf(o) === active).map((o) => <ShopOffer key={o.code} offer={o} game={game} />)}
      </ul>
      <UpcomingShelves />
      <p className="mt-3 text-[11px] leading-relaxed text-[#EEF3FF]/55">
        Nước tưới thúc cây lớn không bán ở chợ: nó chỉ đến từ việc ôn thẻ (Nước Giếng chỉ làm ẩm đất). Hàng mua ở đây vào Kho; hạt được dùng trước khi gieo, không bị tính tiền lần nữa. Đồng Echo là tiền trong trò chơi, không đổi ra tiền thật.
      </p>
    </GardenSheet>
  );
}

// ------------------------------------------------------------------ expansion

const FIELD_LABEL: Record<string, string> = {
  north_strip: "Dải đất cày phía Bắc",
  west_tilled: "Thửa đã cày phía Tây",
};

export function ExpansionPanel({ game, slot, onClose }: { game: EchoGardenGame; slot: number; onClose: () => void }) {
  const state = game.state!;
  const [confirming, setConfirming] = useState(false);
  const plot: GardenExpansionPlot | undefined = state.economy.expansion.plots.find((p) => p.slot === slot);
  const name = (code: string) => state.crops.find((c) => c.code === code)?.nameVi ?? code;
  if (!plot) return null;
  const next = state.economy.expansion.plots.find((p) => p.status === "NEXT");
  const ready = plot.status === "NEXT" && plot.levelOk && plot.coinsOk && plot.compostOk && !!plot.preview;
  const row = (ok: boolean, label: string, have: string, testId: string) => (
    <li key={testId} className="flex items-center gap-2 text-[13px]" data-testid={testId}>
      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${ok ? "bg-[#74C98B]/25 text-[#a6e6b3]" : "bg-white/10 text-[#EEF3FF]/50"}`} aria-hidden>
        {ok ? <Check className="h-3 w-3" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      </span>
      <span className="min-w-0 flex-1 text-[#EEF3FF]">{label}</span>
      <span className={`text-[11px] font-semibold tabular-nums ${ok ? "text-[#a6e6b3]" : "text-[#EEF3FF]/55"}`}>{ok ? "Đủ" : "Chưa đủ"} · {have}</span>
    </li>
  );
  return (
    <GardenSheet labelledBy="garden-expansion-title" onClose={onClose} testId="garden-expansion">
      <SheetHeader id="garden-expansion-title" kicker={FIELD_LABEL[plot.field] ?? "Đất mở rộng"} title={plot.status === "OWNED" ? `Luống #${plot.slot} đã mở` : `Mở luống mới #${plot.slot}`}
        onClose={onClose} closeLabel="Đóng thẻ mở luống" />
      <p className="mt-1 text-[12px] leading-relaxed text-[#EEF3FF]/70">
        Luống mới trồng, chăm, thu hoạch như các luống khởi đầu. Nông sản ủ đất được dùng hết để làm đất, không hoàn lại.{" "}
        {state.economy.expansion.owned}/{state.economy.expansion.total} luống mở rộng đã mở.
      </p>
      {plot.status === "LATER" && next && (
        <p className="mt-2 rounded-[14px] border border-white/10 bg-black/20 px-3 py-1.5 text-[12px] text-[#EEF3FF]/80" data-testid="garden-expansion-order">
          Các luống mở lần lượt: hãy mở luống #{next.slot} trước.
        </p>
      )}
      <ul className="mt-3 flex flex-col gap-1.5" aria-label="Điều kiện mở luống">
        {row(plot.levelOk, `Cấp ${plot.level}`, `bạn: Cấp ${state.profile.level}`, "garden-expansion-level")}
        {row(plot.coinsOk, `${formatNumber(plot.coins)} Đồng Echo`, `bạn có ${formatNumber(state.profile.coins)}`, "garden-expansion-coins")}
        {plot.compost.map((c) => row(c.held >= c.qty, `Ủ đất: ${c.qty} ${c.nameVi}`, `Kho ${Math.min(c.held, c.qty)}/${c.qty}`, `garden-expansion-compost-${c.cropCode}`))}
      </ul>
      {plot.status !== "OWNED" && !plot.compostOk && (
        <p className="mt-2 text-[11px] text-[#EEF3FF]/60">
          Gieo {plot.compost.filter((c) => c.held < c.qty).map((c) => c.nameVi).join(", ")} ở luống trống, rồi giữ lại khi bán để đủ nông sản ủ đất.
        </p>
      )}
      {plot.status === "NEXT" && (
        confirming && plot.preview ? (
          <div className="mt-3 rounded-[14px] border border-[#F4B63F]/30 bg-[#F4B63F]/[0.08] p-2.5" data-testid="garden-expansion-confirm">
            <p className="text-[12px] text-[#EEF3FF]">Sẽ dùng {formatNumber(plot.coins)} Đồng Echo và ủ: {supplyText(plot.preview, name)}.</p>
            <div className="mt-2 flex gap-2">
              <ActionButton tone="reward" className="min-h-[44px] flex-1 text-xs" disabled={game.busy !== null} testId="garden-expansion-buy"
                onClick={async () => {
                  const r = await game.expand(plot);
                  if (r) onClose();
                }}>
                Xác nhận mở luống
              </ActionButton>
              <ActionButton tone="quiet" className="min-h-[44px] text-xs" onClick={() => setConfirming(false)}>Huỷ</ActionButton>
            </div>
          </div>
        ) : (
          <ActionButton tone={ready ? "reward" : "quiet"} className="mt-3 w-full" disabled={!ready || game.busy !== null}
            testId="garden-expansion-start" onClick={() => setConfirming(true)}>
            {ready ? <>Mở luống · <CoinIcon className="h-4 w-4" /> {formatNumber(plot.coins)} Đồng Echo</> : "Chưa đủ điều kiện"}
          </ActionButton>
        )
      )}
    </GardenSheet>
  );
}

/**
 * Produce units held back for open orders, lowest accepted tiers first (the same order the server preview uses), so
 * "Bán hết, giữ hàng cho đơn" never sells what an order needs.
 */
export function orderReserve(state: GardenState): Map<string, number> {
  const rank: Record<string, number> = { NORMAL: 0, GOOD: 1, PERFECT: 2, GOLDEN: 3 };
  const left = new Map(state.inventory.produce.map((p) => [`${p.cropCode}|${p.tier}`, p.qty]));
  const keep = new Map<string, number>();
  const tiers = ["NORMAL", "GOOD", "PERFECT", "GOLDEN"];
  for (const slot of state.economy.board.slots) {
    const order: GardenOrder | null = slot.order;
    if (!order || order.status !== "OPEN") continue;
    for (const l of order.lines) {
      let need = l.qty;
      for (const t of tiers) {
        if (need <= 0) break;
        if (rank[t] < rank[l.minTier]) continue;
        const k = `${l.cropCode}|${t}`;
        const take = Math.min(left.get(k) ?? 0, need);
        if (take > 0) {
          left.set(k, (left.get(k) ?? 0) - take);
          keep.set(k, (keep.get(k) ?? 0) + take);
          need -= take;
        }
      }
    }
  }
  return keep;
}
