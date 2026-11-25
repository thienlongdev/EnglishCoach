"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Lock, X } from "lucide-react";
import type { GardenCosmeticItem, GardenCosmeticOrder, GardenCosmeticShop, GardenCosmeticSkin, GardenCosmeticSlot, GardenDecor, GardenSkin } from "@/types/garden";
import { gardenApi } from "@/services/gardenApi";
import { GardenCheckout, GardenOrderList } from "./GardenCheckout";
import { AdminQaCosmeticsBar } from "./AdminQaPanels";
import type { PlacementCandidate } from "../EchoGardenCanvas";
import type { EchoGardenGame } from "./useEchoGarden";
import { ActionButton, Chip, CoinIcon, EASE, FOCUS_RING, GardenSheet, PANEL } from "./gardenUi";
import {
  COSMETIC_SHELVES, COSMETIC_SLOT_LABEL, DECOR_FAMILY_LABEL, MASTERY_LABEL, cosmeticArtUrl, cosmeticRequirementText, formatNumber,
  type CosmeticShelf,
} from "./gardenModel";

/**
 * Echo Garden Phase 3E — the cosmetic shop "Tiệm Trang Trí Echo", the try-on bar, the placement bar and the card of a
 * decoration standing on the island.
 *
 * Every number, state and requirement on screen is a server fact (`GET /garden/cosmetics`); buying, claiming, wearing,
 * placing, moving and storing are server commands, each with its own idempotency key (the hook retries with the same
 * key). A purchase is always two steps (choose → confirm). Previews show the island's own sprites, never a mock-up.
 * Cosmetics change art only; nothing here offers a random draw or a pressure timer.
 *
 * Phase 3F: an item sold for Echo Coins may also be bought by bank transfer at the owner's fixed VND price, when the
 * server reports checkout open and returns a price for that item (earned items never get one). The button only asks the
 * server for an order and opens the existing Premium SePay sheet; the item appears when the server has verified the
 * transfer — never because a QR was scanned or this screen was told so.
 */

/** Opens the bank-transfer sheet for an item: asks the server for the order (or the open one) first. */
type PayHandler = (kind: "COSMETIC" | "SKIN", code: string, pendingOrderId?: number | null) => void;

function VndPrice({ value }: { value: number }) {
  return <span className="font-black tabular-nums text-[#9fd8ff]">{formatNumber(value)}đ</span>;
}

/** The second way to get a coin item: its fixed VND price and the two-step start of a bank transfer. */
function VndBuy({ name, price, pendingOrderId, busy, onPay, testId }: {
  name: string; price: number; pendingOrderId?: number | null; busy: boolean; onPay: () => void; testId: string;
}) {
  const [confirming, setConfirming] = useState(false);
  if (pendingOrderId) {
    return <ActionButton tone="care" disabled={busy} onClick={onPay} testId={`${testId}-continue`}>Tiếp tục thanh toán {formatNumber(price)}đ</ActionButton>;
  }
  if (!confirming) {
    return <ActionButton tone="care" disabled={busy} onClick={() => setConfirming(true)} testId={testId}>Mua {formatNumber(price)}đ</ActionButton>;
  }
  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2 rounded-[14px] border border-[#9fd8ff]/30 bg-[#9fd8ff]/[0.07] px-3 py-2" role="group" aria-label="Xác nhận thanh toán chuyển khoản">
      <p className="text-[12px] text-[#EEF3FF]/90">Mua <b>{name}</b> bằng chuyển khoản <VndPrice value={price} />? Giá cố định, không phụ thu.</p>
      <div className="flex gap-2">
        <ActionButton tone="quiet" onClick={() => setConfirming(false)}>Thôi</ActionButton>
        <ActionButton tone="care" disabled={busy} testId={`${testId}-confirm`} onClick={() => { setConfirming(false); onPay(); }}>Mở mã QR</ActionButton>
      </div>
    </div>
  );
}

/** An appearance the player is trying on (not bought, not saved): the island shows it until they decide. */
export interface TryOn { item: GardenCosmeticItem }
/** A decoration being placed (a stored unit) or moved (`moving` = the one that stands). */
export interface Placing { code: string; artKey: string; nameVi: string; footprint: number; moving: GardenDecor | null }

function Price({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-1 font-black tabular-nums text-[#FFD978]" aria-label={`${formatNumber(value)} Đồng Echo`}>
      <CoinIcon className="h-3.5 w-3.5" />{formatNumber(value)}
    </span>
  );
}

function Art({ src, alt, className = "h-20 w-20" }: { src: string; alt: string; className?: string }) {
  return (
    <span className={`flex shrink-0 items-end justify-center overflow-hidden rounded-[14px] border border-white/10 bg-gradient-to-b from-[#3a5d49]/60 to-[#243a3a]/70 ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} loading="lazy" decoding="async" draggable={false} className="max-h-full max-w-full select-none object-contain p-1" />
    </span>
  );
}

function StatusChip({ status, owned, max }: { status: string; owned: number; max: number }) {
  if (status === "OWNED") return <Chip tone="good">{max > 1 ? `Đã có ${owned}/${max}` : "Đã có"}</Chip>;
  if (status === "LOCKED") return <Chip tone="quiet"><Lock className="h-3 w-3" aria-hidden />Chưa mở</Chip>;
  return owned > 0 ? <Chip tone="info">Đã có {owned}/{max}</Chip> : null;
}

// ------------------------------------------------------------------ one cosmetic

function ItemCard({ item, game, houseLevel, onTryOn, onPlace, onPay }: {
  item: GardenCosmeticItem; game: EchoGardenGame; houseLevel: number; onTryOn: (t: TryOn) => void; onPlace: (p: Placing) => void; onPay?: PayHandler;
}) {
  const [confirming, setConfirming] = useState(false);
  const busy = game.busy !== null;
  const earned = item.unlockKind !== "COIN";
  const canGet = item.status === "AVAILABLE" && (earned || item.coinsOk);
  const stored = item.owned - item.placed;
  const slot = item.category as GardenCosmeticSlot;
  return (
    <li className="rounded-[18px_15px_18px_16px] border border-white/10 bg-black/20 p-2.5" data-testid={`garden-cosmetic-${item.code}`}>
      <div className="flex gap-3">
        <Art src={cosmeticArtUrl(item.category, item.artKey, houseLevel)} alt="" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-[13px] font-black leading-tight text-[#EEF3FF]">{item.nameVi}</h3>
            <StatusChip status={item.status} owned={item.owned} max={item.maxOwned} />
            {item.equipped && <Chip tone="magic">Đang dùng</Chip>}
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-[#EEF3FF]/65">{item.descriptionVi}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[#EEF3FF]/70">
            <span>{item.category === "DECOR" ? DECOR_FAMILY_LABEL[item.family] ?? "Trang trí" : COSMETIC_SLOT_LABEL[item.category]}</span>
            {earned
              ? <span className={item.requirementOk ? "text-[#a6e6b3]" : ""}>Thành tựu: {cosmeticRequirementText(item.unlockKind, item.requirement)} ({formatNumber(Math.min(item.progress, item.requirement))}/{formatNumber(item.requirement)})</span>
              : item.status !== "OWNED" && <Price value={item.coinPrice} />}
            {onPay && item.priceVnd != null && <span>hoặc <VndPrice value={item.priceVnd} /></span>}
            {item.category === "DECOR" && item.owned > 0 && <span>Đang bày {item.placed} · trong kho {stored}</span>}
          </p>
        </div>
      </div>
      {item.category === "HOUSE" && (
        <div className="mt-2 flex items-end gap-1.5" aria-label="Dáng nhà qua bốn cấp">
          {[0, 1, 2, 3].map((lv) => (
            <span key={lv} className="flex min-w-0 flex-1 flex-col items-center gap-0.5">
              <Art src={cosmeticArtUrl("HOUSE", item.artKey, lv)} alt={`${item.nameVi} ở cấp ${lv}`} className={`h-14 w-full ${lv === houseLevel ? "ring-2 ring-[#FFD978]/80" : ""}`} />
              <span className="text-[9px] font-bold text-[#EEF3FF]/60">Cấp {lv}{lv === houseLevel ? " · nhà bạn" : ""}</span>
            </span>
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        {!confirming && item.category !== "DECOR" && item.owned === 0 && (
          <ActionButton tone="quiet" disabled={busy} onClick={() => onTryOn({ item })} testId={`garden-cosmetic-try-${item.code}`}>Xem thử trên đảo</ActionButton>
        )}
        {!confirming && item.category !== "DECOR" && item.owned > 0 && (
          <ActionButton tone={item.equipped ? "quiet" : "care"} disabled={busy} testId={`garden-cosmetic-equip-${item.code}`}
            onClick={() => void game.equipCosmetic(slot, item.equipped ? null : item)}>
            {item.equipped ? "Bỏ dùng" : "Dùng"}
          </ActionButton>
        )}
        {!confirming && item.category === "DECOR" && stored > 0 && (
          <ActionButton tone="care" disabled={busy} testId={`garden-cosmetic-place-${item.code}`}
            onClick={() => onPlace({ code: item.code, artKey: item.artKey, nameVi: item.nameVi, footprint: item.footprint, moving: null })}>
            Đặt lên đảo
          </ActionButton>
        )}
        {!confirming && item.status === "AVAILABLE" && (
          earned
            ? <ActionButton tone="reward" disabled={busy} onClick={() => void game.buyCosmetic(item)} testId={`garden-cosmetic-claim-${item.code}`}>Nhận</ActionButton>
            : <ActionButton tone="reward" disabled={busy || !canGet} onClick={() => setConfirming(true)} testId={`garden-cosmetic-buy-${item.code}`}>
              {item.coinsOk ? (item.owned > 0 ? "Mua thêm" : "Mua") : `Còn thiếu ${formatNumber(item.coinPrice - (game.state?.profile.coins ?? 0))}`}
            </ActionButton>
        )}
        {!confirming && onPay && item.priceVnd != null && item.status === "AVAILABLE" && item.owned === 0 && (
          <VndBuy name={item.nameVi} price={item.priceVnd} pendingOrderId={item.pendingOrderId} busy={busy}
            testId={`garden-cosmetic-vnd-${item.code}`} onPay={() => onPay("COSMETIC", item.code, item.pendingOrderId)} />
        )}
        {confirming && (
          <div className="flex w-full flex-wrap items-center justify-between gap-2 rounded-[14px] border border-[#FFD978]/30 bg-[#FFD978]/[0.07] px-3 py-2" role="group" aria-label="Xác nhận mua">
            <p className="text-[12px] text-[#EEF3FF]/90">Mua <b>{item.nameVi}</b> với <Price value={item.coinPrice} />?</p>
            <div className="flex gap-2">
              <ActionButton tone="quiet" onClick={() => setConfirming(false)}>Thôi</ActionButton>
              <ActionButton tone="reward" disabled={busy} testId={`garden-cosmetic-confirm-${item.code}`}
                onClick={() => void game.buyCosmetic(item).then(() => setConfirming(false))}>
                Xác nhận
              </ActionButton>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ one cultivar

function SkinCard({ skin, game, onChanged, onPay }: { skin: GardenCosmeticSkin; game: EchoGardenGame; onChanged: () => void; onPay?: PayHandler }) {
  const [confirming, setConfirming] = useState(false);
  const busy = game.busy !== null;
  // the codex entry carries the full object the existing skin commands take
  const full: GardenSkin | undefined = game.state?.living.collection.crops.find((c) => c.cropCode === skin.cropCode)?.skins.find((s) => s.code === skin.code);
  const coin = skin.unlockKind === "COIN";
  const how = skin.unlockKind === "MASTERY" ? `Thành tựu: thành thạo ${skin.cropNameVi} bậc ${MASTERY_LABEL[skin.masteryTier] ?? skin.masteryTier}`
    : skin.unlockKind === "LEARNING" ? `Thành tựu: ${skin.learningDays} ngày học đã xác nhận`
      : !skin.masteryOk ? `Cần thu hoạch ${skin.cropNameVi} ít nhất một lần` : null;
  const acquire = async () => {
    if (!full) return;
    const r = await game.acquireSkin(full);
    setConfirming(false);
    if (r) onChanged();
  };
  return (
    <li className="rounded-[18px_15px_18px_16px] border border-white/10 bg-black/20 p-2.5" data-testid={`garden-cosmetic-skin-${skin.code}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <h3 className="text-[13px] font-black leading-tight text-[#EEF3FF]">{skin.nameVi}</h3>
        <Chip tone="quiet">{skin.cropNameVi}</Chip>
        <StatusChip status={skin.status} owned={skin.status === "OWNED" ? 1 : 0} max={1} />
        {skin.equipped && <Chip tone="magic">Đang dùng</Chip>}
      </div>
      <p className="mt-0.5 text-[11px] leading-snug text-[#EEF3FF]/65">{skin.descriptionVi}</p>
      <div className="mt-2 flex items-end gap-1.5" aria-label="Bốn giai đoạn lớn của giống này">
        {[1, 2, 3, 4].map((st) => (
          <span key={st} className="flex min-w-0 flex-1 flex-col items-center gap-0.5">
            <Art src={`/garden/world/cskin_${skin.artKey}_s${st}.webp`} alt={`${skin.nameVi}, giai đoạn ${st}`} className="h-16 w-full" />
            <span className="text-[9px] font-bold text-[#EEF3FF]/60">{["Mầm", "Cây non", "Ra hoa", "Chín"][st - 1]}</span>
          </span>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-1 text-[11px] text-[#EEF3FF]/70">
          {how ?? "Chỉ đổi dáng vẻ của cây."}{coin && skin.status !== "OWNED" && <> · <Price value={skin.coinPrice} /></>}
          {onPay && skin.priceVnd != null && <> hoặc <VndPrice value={skin.priceVnd} /></>}
        </p>
        {!confirming && onPay && skin.priceVnd != null && skin.status === "AVAILABLE" && (
          <VndBuy name={skin.nameVi} price={skin.priceVnd} pendingOrderId={skin.pendingOrderId} busy={busy}
            testId={`garden-cosmetic-skin-vnd-${skin.code}`} onPay={() => onPay("SKIN", skin.code, skin.pendingOrderId)} />
        )}
        {!confirming && skin.status === "OWNED" && full && (
          <ActionButton tone={skin.equipped ? "quiet" : "care"} disabled={busy} testId={`garden-cosmetic-skin-equip-${skin.code}`}
            onClick={() => void game.equipSkin(skin.cropCode, skin.equipped ? null : full).then((ok) => ok && onChanged())}>
            {skin.equipped ? "Bỏ dùng" : "Dùng khi gieo"}
          </ActionButton>
        )}
        {!confirming && skin.status === "AVAILABLE" && full && (
          coin
            ? <ActionButton tone="reward" disabled={busy || !skin.coinsOk} onClick={() => setConfirming(true)} testId={`garden-cosmetic-skin-buy-${skin.code}`}>
              {skin.coinsOk ? "Mua" : "Chưa đủ Đồng Echo"}
            </ActionButton>
            : <ActionButton tone="reward" disabled={busy} onClick={() => void acquire()} testId={`garden-cosmetic-skin-claim-${skin.code}`}>Nhận</ActionButton>
        )}
        {confirming && (
          <div className="flex w-full flex-wrap items-center justify-between gap-2 rounded-[14px] border border-[#FFD978]/30 bg-[#FFD978]/[0.07] px-3 py-2" role="group" aria-label="Xác nhận mua">
            <p className="text-[12px] text-[#EEF3FF]/90">Mua giống <b>{skin.nameVi}</b> với <Price value={skin.coinPrice} />?</p>
            <div className="flex gap-2">
              <ActionButton tone="quiet" onClick={() => setConfirming(false)}>Thôi</ActionButton>
              <ActionButton tone="reward" disabled={busy} onClick={() => void acquire()} testId={`garden-cosmetic-skin-confirm-${skin.code}`}>Xác nhận</ActionButton>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ the shop

const SHELF_CATEGORIES: Partial<Record<CosmeticShelf, string[]>> = {
  HOUSE: ["HOUSE"], VEGETATION: ["TREE", "SHRUB", "FLOWER"], MONUMENT: ["MONUMENT"], DECOR: ["DECOR"], FENCE_PATH: ["FENCE", "PATH"], BED: ["BED"],
};

export function CosmeticShopPanel({ game, onClose, onBackToMarket, onTryOn, onPlace, hidden = false }: {
  game: EchoGardenGame; onClose: () => void; onBackToMarket: () => void; onTryOn: (t: TryOn) => void; onPlace: (p: Placing) => void;
  /** While an appearance is tried on the shop steps aside but stays mounted, so the player returns to the same shelf. */
  hidden?: boolean;
}) {
  const [shelf, setShelf] = useState<CosmeticShelf>("FEATURED");
  const [collection, setCollection] = useState<string | null>(null);
  const [crop, setCrop] = useState<string | null>(null);
  const { loadShop, startCheckout, notify } = game;
  const shop: GardenCosmeticShop | null = game.shop;
  useEffect(() => {
    void loadShop();
  }, [loadShop]);
  // Phase 3F: the bank-transfer sheet of one order, and a counter that makes the order list read again
  const [payOrder, setPayOrder] = useState<GardenCosmeticOrder | null>(null);
  const [ordersVersion, setOrdersVersion] = useState(0);
  const pay: PayHandler = async (kind, code, pendingOrderId) => {
    try {
      const order = pendingOrderId ? await gardenApi.cosmeticOrder(pendingOrderId) : await startCheckout(kind, code);
      if (!order) return;
      if (order.status === "PENDING") setPayOrder(order);
      else {
        notify("info", "Đơn trước đã đóng. Hãy bấm mua lại để nhận mã thanh toán mới.");
        void loadShop();
      }
      setOrdersVersion((n) => n + 1);
    } catch {
      notify("error", "Chưa mở được đơn thanh toán. Hãy thử lại.");
    }
  };
  const onPay = shop?.checkoutEnabled ? pay : undefined;
  const houseLevel = game.state?.estate.buildings.find((b) => b.code === "COTTAGE")?.level ?? 0;
  const shelfInfo = COSMETIC_SHELVES.find((s) => s.id === shelf);
  const crops = useMemo(() => {
    const seen = new Map<string, string>();
    shop?.skins.forEach((s) => seen.set(s.cropCode, s.cropNameVi));
    return [...seen.entries()];
  }, [shop]);

  let items: GardenCosmeticItem[] = [];
  let skins: GardenCosmeticSkin[] = [];
  if (shop) {
    if (shelf === "FEATURED" && collection) {
      items = shop.items.filter((i) => i.collection === collection);
      skins = shop.skins.filter((s) => s.collection === collection);
    } else if (shelf === "SKINS") {
      skins = shop.skins.filter((s) => s.cropCode === (crop ?? crops[0]?.[0]));
    } else if (shelf === "OWNED") {
      items = shop.items.filter((i) => i.owned > 0);
      skins = shop.skins.filter((s) => s.status === "OWNED");
    } else if (shelf === "EARNED") {
      items = shop.items.filter((i) => i.unlockKind !== "COIN");
      skins = shop.skins.filter((s) => s.unlockKind !== "COIN");
    } else if (SHELF_CATEGORIES[shelf]) {
      items = shop.items.filter((i) => SHELF_CATEGORIES[shelf]!.includes(i.category));
    }
  }
  const activeCollection = shop?.collections.find((c) => c.code === collection);
  if (hidden) return null;
  if (payOrder) {
    return <GardenCheckout order={payOrder} game={game} onClose={() => { setPayOrder(null); setOrdersVersion((n) => n + 1); }} />;
  }

  return (
    <GardenSheet labelledBy="garden-cosmetics-title" onClose={onClose} testId="garden-cosmetics" wide>
      <div className="flex items-start justify-between gap-3">
        <div>
          <button type="button" onClick={onBackToMarket} className={`inline-flex min-h-[44px] items-center text-[11px] font-semibold text-[#FFD978]/90 underline-offset-2 hover:underline sm:min-h-0 ${FOCUS_RING} cursor-pointer`}>
            ‹ Quầy Chợ Echo
          </button>
          <h2 id="garden-cosmetics-title" className="mt-0.5 text-lg font-black text-[#EEF3FF]">Tiệm Trang Trí Echo</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Đóng tiệm trang trí"
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/80 transition-[background-color,transform] duration-200 ${EASE} hover:bg-white/20 active:scale-[0.94] ${FOCUS_RING} cursor-pointer sm:h-9 sm:w-9`}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[12px] text-[#EEF3FF]/70">
        <span data-testid="garden-cosmetics-progress">{shop ? `Bộ sưu tập của bạn: ${shop.itemsOwned}/${shop.itemsTotal} món` : "Đang mở tiệm…"}</span>
        <span className="flex items-center gap-1 font-bold text-[#FFD978]" aria-label={`Bạn có ${formatNumber(game.state?.profile.coins ?? 0)} Đồng Echo`}>
          <CoinIcon className="h-3.5 w-3.5" />{formatNumber(game.state?.profile.coins ?? 0)}
        </span>
      </div>

      <AdminQaCosmeticsBar game={game} />

      <div role="tablist" aria-label="Kệ hàng của tiệm trang trí" className="mt-3 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:thin]" data-testid="garden-cosmetic-shelves">
        {COSMETIC_SHELVES.map((s) => (
          <button key={s.id} type="button" role="tab" aria-selected={shelf === s.id} data-testid={`garden-cosmetic-shelf-${s.id}`}
            onClick={() => {
              setShelf(s.id);
              setCollection(null);
            }}
            className={`min-h-[44px] shrink-0 whitespace-nowrap rounded-full border px-3 text-[12px] font-bold sm:min-h-[40px] transition-[background-color,color] duration-200 ${EASE} ${FOCUS_RING} cursor-pointer ${shelf === s.id ? "border-[#FFD978]/60 bg-[#FFD978]/90 text-[#3a2a0a]" : "border-white/10 bg-white/[0.05] text-[#EEF3FF]/80 hover:bg-white/10"}`}>
            {s.label}
          </button>
        ))}
      </div>
      {shelfInfo && !collection && <p className="mt-2 text-[12px] leading-snug text-[#EEF3FF]/70">{shelfInfo.note}</p>}

      {!shop && <p className="mt-6 text-center text-[12px] text-[#EEF3FF]/60" aria-busy="true">Đang tải danh mục…</p>}

      {shop && shelf === "FEATURED" && !collection && (
        <ul className="mt-2 grid grid-cols-1 gap-2" data-testid="garden-cosmetic-collections">
          {shop.collections.map((c) => {
            const sample = [...shop.items.filter((i) => i.collection === c.code).slice(0, 3).map((i) => cosmeticArtUrl(i.category, i.artKey, houseLevel)),
              ...shop.skins.filter((s) => s.collection === c.code).slice(0, 2).map((s) => `/garden/world/cskin_${s.artKey}_s4.webp`)].slice(0, 4);
            return (
              <li key={c.code}>
                <button type="button" onClick={() => setCollection(c.code)} data-testid={`garden-cosmetic-collection-${c.code}`}
                  className={`flex w-full flex-col gap-2 rounded-[18px_15px_18px_16px] border border-white/10 bg-black/20 p-3 text-left transition-[background-color,transform] duration-200 ${EASE} hover:bg-white/[0.07] active:scale-[0.99] ${FOCUS_RING} cursor-pointer`}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-[14px] font-black text-[#EEF3FF]">{c.nameVi}</span>
                    <Chip tone={c.owned === c.items ? "good" : "quiet"}>{c.owned}/{c.items} món</Chip>
                  </span>
                  <span className="text-[11px] leading-snug text-[#EEF3FF]/65">{c.descriptionVi}</span>
                  <span className="flex gap-1.5">{sample.map((src) => <Art key={src} src={src} alt="" className="h-14 min-w-0 flex-1" />)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {shop && shelf === "FEATURED" && activeCollection && (
        <div className="mt-2">
          <button type="button" onClick={() => setCollection(null)} className={`inline-flex min-h-[44px] items-center text-[12px] font-bold text-[#FFD978] underline-offset-2 hover:underline sm:min-h-0 ${FOCUS_RING} cursor-pointer`}>‹ Tất cả bộ sưu tập</button>
          <p className="mt-1 text-[14px] font-black text-[#EEF3FF]">{activeCollection.nameVi} <span className="text-[11px] font-bold text-[#EEF3FF]/60">· {activeCollection.owned}/{activeCollection.items} món</span></p>
          <p className="text-[11px] text-[#EEF3FF]/65">{activeCollection.descriptionVi} Mỗi món mua riêng; không cần mua cả bộ.</p>
        </div>
      )}

      {shop && shelf === "SKINS" && (
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:thin]" role="tablist" aria-label="Loại cây">
          {crops.map(([code, name]) => (
            <button key={code} type="button" role="tab" aria-selected={(crop ?? crops[0]?.[0]) === code} onClick={() => setCrop(code)} data-testid={`garden-cosmetic-crop-${code}`}
              className={`min-h-[44px] shrink-0 whitespace-nowrap rounded-full border px-2.5 text-[11px] font-bold sm:min-h-[36px] ${FOCUS_RING} cursor-pointer ${(crop ?? crops[0]?.[0]) === code ? "border-[#74C98B]/60 bg-[#74C98B]/25 text-[#c9f2d2]" : "border-white/10 bg-white/[0.05] text-[#EEF3FF]/75"}`}>
              {name}
            </button>
          ))}
        </div>
      )}

      {shop && (items.length > 0 || skins.length > 0) && (
        <ul className="mt-2 flex flex-col gap-2" data-testid="garden-cosmetic-list">
          {items.map((i) => <ItemCard key={i.code} item={i} game={game} houseLevel={houseLevel} onTryOn={onTryOn} onPlace={onPlace} onPay={onPay} />)}
          {skins.map((s) => <SkinCard key={s.code} skin={s} game={game} onChanged={() => void loadShop()} onPay={onPay} />)}
        </ul>
      )}
      {shop && shelf === "OWNED" && items.length === 0 && skins.length === 0 && (
        <p className="mt-6 text-center text-[12px] text-[#EEF3FF]/60">Bạn chưa có món trang trí nào. Hãy dạo qua các kệ hàng.</p>
      )}

      {shop && <GardenOrderList game={game} version={ordersVersion} onPay={(o) => setPayOrder(o)} />}

      <p className="mt-3 text-[11px] leading-relaxed text-[#EEF3FF]/55" data-testid="garden-cosmetics-note">
        Đồ trang trí chỉ đổi dáng vẻ của đảo: không làm cây lớn nhanh hơn, không đổi giá bán, điểm kinh nghiệm hay việc học. Mọi món bán đều mua được bằng Đồng Echo kiếm trong vườn; món thành tựu chỉ nhận bằng thành tựu thật và không bán. Không có vòng quay may rủi.
        {shop?.checkoutEnabled
          ? " Món bán bằng Đồng Echo cũng có thể mua bằng chuyển khoản với giá cố định, không phụ thu; món chỉ được giao khi hệ thống xác nhận giao dịch. Đồng Echo không bán và không đổi ra tiền."
          : " Hiện chưa mở thanh toán bằng chuyển khoản."}
      </p>
    </GardenSheet>
  );
}

// ------------------------------------------------------------------ try-on and placement bars, decoration card

/** Shown instead of the shop while an appearance is tried on: the island wears it; nothing is bought or saved yet. */
export function TryOnBar({ tryOn, game, onBack }: { tryOn: TryOn; game: EchoGardenGame; onBack: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const { item } = tryOn;
  const earned = item.unlockKind !== "COIN";
  const busy = game.busy !== null;
  const buy = async () => {
    const r = await game.buyCosmetic(item);
    if (!r) return;
    await game.equipCosmetic(item.category as GardenCosmeticSlot, item);
    onBack();
  };
  return (
    <div role="region" aria-label="Xem thử trang trí" data-testid="garden-tryon"
      className={`pointer-events-auto ${PANEL} absolute inset-x-3 bottom-[calc(env(safe-area-inset-bottom,0px)+4.75rem)] mx-auto max-w-md rounded-[22px_18px_22px_20px] p-3 sm:bottom-[calc(env(safe-area-inset-bottom,0px)+1rem)]`}>
      <p className="text-[11px] font-bold text-[#FFD978]/90">Đang xem thử · chưa mua, chưa lưu</p>
      <p className="mt-0.5 text-[14px] font-black text-[#EEF3FF]">{item.nameVi}</p>
      <p className="text-[11px] leading-snug text-[#EEF3FF]/65">
        {earned ? `Thành tựu: ${cosmeticRequirementText(item.unlockKind, item.requirement)} (${Math.min(item.progress, item.requirement)}/${item.requirement}).`
          : <>Giá <Price value={item.coinPrice} />{!item.coinsOk && " · bạn chưa đủ Đồng Echo"}</>}
      </p>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <ActionButton tone="quiet" onClick={onBack} testId="garden-tryon-back">Quay lại tiệm</ActionButton>
        {!confirming && item.status === "AVAILABLE" && (earned
          ? <ActionButton tone="reward" disabled={busy} onClick={() => void buy()} testId="garden-tryon-claim">Nhận và dùng</ActionButton>
          : <ActionButton tone="reward" disabled={busy || !item.coinsOk} onClick={() => setConfirming(true)} testId="garden-tryon-buy">Mua và dùng</ActionButton>)}
        {confirming && <ActionButton tone="reward" disabled={busy} onClick={() => void buy()} testId="garden-tryon-confirm">Xác nhận mua {formatNumber(item.coinPrice)}</ActionButton>}
      </div>
    </div>
  );
}

/** Shown while a decoration is being placed or moved: the scene draws the regions and a ghost at the chosen point. */
export function PlacementBar({ placing, candidate, busy, onConfirm, onCancel }: {
  placing: Placing; candidate: PlacementCandidate | null; busy: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const text = !candidate ? "Chạm vào một điểm trong vùng sáng trên đảo để chọn chỗ."
    : candidate.ok ? "Có thể đặt ở đây."
      : candidate.reason === "OVERLAP" ? "Chỗ này sát một vật trang trí khác quá." : "Chỗ này nằm ngoài vùng bày trí.";
  return (
    <div role="region" aria-label="Đặt vật trang trí" data-testid="garden-placement"
      className={`pointer-events-auto ${PANEL} absolute inset-x-3 bottom-[calc(env(safe-area-inset-bottom,0px)+4.75rem)] mx-auto max-w-md rounded-[22px_18px_22px_20px] p-3 sm:bottom-[calc(env(safe-area-inset-bottom,0px)+1rem)]`}>
      <div className="flex items-center gap-3">
        <Art src={cosmeticArtUrl("DECOR", placing.artKey)} alt="" className="h-14 w-14" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold text-[#FFD978]/90">{placing.moving ? "Di chuyển" : "Đặt lên đảo"}</p>
          <p className="text-[14px] font-black leading-tight text-[#EEF3FF]">{placing.nameVi}</p>
          <p className={`text-[11px] leading-snug ${candidate && !candidate.ok ? "text-[#ffd2b0]" : "text-[#EEF3FF]/70"}`} aria-live="polite" data-testid="garden-placement-hint">{text}</p>
        </div>
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <ActionButton tone="quiet" onClick={onCancel} testId="garden-placement-cancel">Thôi</ActionButton>
        <ActionButton tone="care" disabled={busy || !candidate?.ok} onClick={onConfirm} testId="garden-placement-confirm">Đặt ở đây</ActionButton>
      </div>
    </div>
  );
}

/** The card of a decoration standing on the island: move it or put it back into storage (it stays owned). */
export function DecorCard({ decor, game, onClose, onMove }: { decor: GardenDecor; game: EchoGardenGame; onClose: () => void; onMove: (p: Placing) => void }) {
  const item = game.shop?.items.find((i) => i.code === decor.code);
  const region = game.state?.cosmetics?.regions.find((r) => r.code === decor.region);
  const { loadShop, shop } = game;
  useEffect(() => {
    if (!shop) void loadShop();
  }, [shop, loadShop]);
  const name = item?.nameVi ?? "Vật trang trí";
  return (
    <GardenSheet labelledBy="garden-decor-title" onClose={onClose} testId="garden-decor">
      <div className="flex items-start gap-3">
        <Art src={cosmeticArtUrl("DECOR", decor.artKey)} alt="" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-[#FFD978]/90">{region?.nameVi ?? "Trên đảo"}</p>
          <h2 id="garden-decor-title" className="text-lg font-black leading-tight text-[#EEF3FF]">{name}</h2>
          {item && <p className="mt-0.5 text-[11px] leading-snug text-[#EEF3FF]/65">{item.descriptionVi}</p>}
        </div>
        <button type="button" onClick={onClose} aria-label="Đóng"
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/80 hover:bg-white/20 ${FOCUS_RING} cursor-pointer sm:h-9 sm:w-9`}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <ActionButton tone="quiet" disabled={game.busy !== null} testId="garden-decor-store" onClick={() => void game.storeDecor(decor).then((ok) => ok && onClose())}>Cất vào kho</ActionButton>
        <ActionButton tone="care" disabled={game.busy !== null} testId="garden-decor-move"
          onClick={() => onMove({ code: decor.code, artKey: decor.artKey, nameVi: name, footprint: decor.footprint, moving: decor })}>
          Di chuyển
        </ActionButton>
      </div>
      <p className="mt-2 text-[11px] text-[#EEF3FF]/55">Cất vào kho không làm mất món này: bạn có thể bày lại bất cứ lúc nào.</p>
    </GardenSheet>
  );
}
