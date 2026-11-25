"use client";

import React, { useEffect, useRef, useState } from "react";
import { Heart, X } from "lucide-react";
import type { GardenAnimal, GardenAnimalHouse, GardenAnimals, GardenGuardian } from "@/types/garden";
import type { EchoGardenGame } from "./useEchoGarden";
import { ActionButton, Chip, CoinIcon, EASE, FOCUS_RING, GardenSheet } from "./gardenUi";
import { LogisticsTabs, type LogisticsTab } from "./EconomyPanels";
import { AdminQaAnimalsBar } from "./AdminQaPanels";
import {
  ANIMAL_STAGE_LABEL, FEED_ICON, TIER_LABEL, animalHouseIconUrl, animalIconUrl, cropIconUrl, formatNumber, guardianEffectText,
  guardianStatusText, productIconUrl, untilText,
} from "./gardenModel";

/**
 * Phase 3H — "Chuồng trại": the animal houses, the livestock in them, the three guardian pets, the feed bin and the
 * products. Every number, timer and permission is a server fact from `state.animals`; a button only names an action
 * (the server decides, charges once and answers with the new picture). Buying is always choose → confirm.
 */

const CARD = "rounded-[16px_13px_16px_14px] border border-white/10 bg-black/20 p-3";

/** One thing to confirm at a time in the whole sheet (a second tap on the same button runs it). */
type Pending = string | null;

function Confirm({ id, pending, setPending, label, confirmLabel, run, disabled, tone = "reward", testId }: {
  id: string; pending: Pending; setPending: (p: Pending) => void; label: React.ReactNode; confirmLabel: React.ReactNode;
  run: () => void; disabled?: boolean; tone?: "care" | "reward" | "quiet"; testId?: string;
}) {
  const armed = pending === id;
  return (
    <ActionButton
      tone={armed ? "reward" : tone}
      className="min-h-[40px] px-3 text-xs"
      disabled={disabled}
      testId={testId}
      onClick={() => {
        if (!armed) {
          setPending(id);
          return;
        }
        setPending(null);
        run();
      }}
    >
      {armed ? confirmLabel : label}
    </ActionButton>
  );
}

/** A portrait that can be petted: a small heart rises (pure presentation — petting earns nothing and stores nothing). */
function Portrait({ src, label, dim, size = "h-12 w-12" }: { src: string; label: string; dim?: boolean; size?: string }) {
  const [pet, setPet] = useState(0);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);
  return (
    <button
      type="button"
      aria-label={`Vuốt ve ${label}`}
      onClick={() => {
        setPet((n) => n + 1);
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setPet(0), 900);
      }}
      className={`relative shrink-0 rounded-[14px] ${FOCUS_RING} cursor-pointer transition-transform duration-200 ${EASE} active:scale-[0.92]`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" className={`${size} object-contain ${dim ? "opacity-70 saturate-[0.7]" : ""}`} />
      {pet > 0 && (
        <Heart key={pet} aria-hidden className="pointer-events-none absolute -top-1 left-1/2 h-4 w-4 -translate-x-1/2 fill-[#F2777A] text-[#F2777A] motion-safe:animate-[eg-pet_850ms_ease-out_forwards]" />
      )}
    </button>
  );
}

function animalLine(a: GardenAnimal, house: GardenAnimalHouse, nowMs: number): string {
  if (a.stage !== "ADULT") {
    const eta = untilText(a.adultAt, nowMs);
    return a.cared ? (eta ? `Đang lớn, trưởng thành ${eta}` : "Đang lớn") : "Thiếu ăn hoặc nước: vẫn lớn nhưng chậm hơn";
  }
  if (a.ready >= a.storeCap) return `Đã đầy ${a.storeCap} ${house.productNameVi}: thu để bạn ấy làm tiếp`;
  if (!a.cared) return a.ready > 0 ? `Có ${a.ready} ${house.productNameVi}. Đang nghỉ vì thiếu ăn hoặc nước` : "Đang nghỉ vì thiếu ăn hoặc nước";
  const eta = untilText(a.nextProductAt, nowMs);
  return `${a.ready > 0 ? `Có ${a.ready} ${house.productNameVi}. ` : ""}${eta ? `${house.productNameVi} tiếp theo ${eta}` : "Đang làm việc"}`;
}

function HouseCard({ game, house, animals, nowMs, pending, setPending, focused }: {
  game: EchoGardenGame; house: GardenAnimalHouse; animals: GardenAnimals; nowMs: number; pending: Pending;
  setPending: (p: Pending) => void; focused: boolean;
}) {
  const busy = game.busy !== null;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);
  if (!house.built) {
    return (
      <div ref={ref} className={`${CARD} ${focused ? "border-[#FFD978]/50" : ""}`} data-testid={`animal-house-${house.code}`}>
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={animalHouseIconUrl(house.code)} alt="" className="h-14 w-14 shrink-0 object-contain opacity-80" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-black text-[#EEF3FF]">{house.nameVi}</p>
            <p className="text-[11px] leading-snug text-[#EEF3FF]/65">
              Nuôi tối đa {house.capacity} {house.animalNameVi.toLowerCase()}. Mỗi con trưởng thành cho 1 {house.productNameVi.toLowerCase()} sau {house.productHours} giờ được chăm.
            </p>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          {house.levelOk
            ? <Chip tone={house.coinsOk ? "good" : "warn"}>{house.coinsOk ? "Đủ điều kiện" : "Chưa đủ Đồng Echo"}</Chip>
            : <Chip tone="quiet">Mở ở Cấp {house.minLevel}</Chip>}
          <Confirm id={`build-${house.code}`} pending={pending} setPending={setPending} disabled={busy || !house.levelOk || !house.coinsOk}
            testId={`animal-build-${house.code}`}
            label={<>Dựng chuồng · <CoinIcon className="h-3.5 w-3.5" /> {formatNumber(house.coins)}</>}
            confirmLabel={<>Xác nhận dựng, −{formatNumber(house.coins)}</>}
            run={() => void game.buildAnimalHouse(house.code, house.nameVi)} />
        </div>
      </div>
    );
  }
  const water = untilText(house.wateredUntil, nowMs);
  const room = house.capacity - house.animals.length;
  return (
    <div ref={ref} className={`${CARD} ${focused ? "border-[#FFD978]/50" : ""}`} data-testid={`animal-house-${house.code}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-black text-[#EEF3FF]">{house.nameVi} <span className="font-semibold text-[#EEF3FF]/60">{house.animals.length}/{house.capacity}</span></p>
        <Chip tone={house.watered ? "info" : "warn"} testId={`animal-water-${house.code}`}>{house.watered ? `Máng nước ${water ?? "đầy"}` : "Máng nước cạn"}</Chip>
      </div>
      {house.animals.length === 0 ? (
        <p className="mt-1.5 text-[12px] text-[#EEF3FF]/65">Chuồng còn trống. Đón một {house.babyNameVi.toLowerCase()} về nuôi: sau {house.growHours} giờ được chăm, bạn ấy trưởng thành.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {house.animals.map((a) => (
            <li key={a.id} className="flex items-center gap-2.5" data-testid={`animal-${a.id}`}>
              <Portrait src={animalIconUrl(a.species, a.stage !== "ADULT")} label={a.stage === "ADULT" ? house.animalNameVi : house.babyNameVi} dim={!a.cared} size="h-11 w-11" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-[12px] font-bold text-[#EEF3FF]">
                  {a.stage === "ADULT" ? house.animalNameVi : house.babyNameVi}
                  <Chip tone={a.stage === "ADULT" ? "good" : "quiet"}>{ANIMAL_STAGE_LABEL[a.stage]}</Chip>
                  {!a.cared && <Chip tone="warn">Đang nghỉ</Chip>}
                </p>
                <p className="text-[11px] leading-snug text-[#EEF3FF]/65">{animalLine(a, house, nowMs)}</p>
                {a.stage !== "ADULT" && (
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label="Tiến độ lớn" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(a.growth * 100)}>
                    <div className="h-full rounded-full bg-[#74C98B]" style={{ width: `${Math.round(a.growth * 100)}%` }} />
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {house.ready > 0 && (
          <ActionButton tone="reward" className="min-h-[40px] px-3 text-xs" disabled={busy} testId={`animal-collect-${house.code}`}
            onClick={() => void game.collectAnimalHouse(house.code, house.productNameVi)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={productIconUrl(house.product)} alt="" className="h-5 w-5 object-contain" /> Thu {house.ready} {house.productNameVi}
          </ActionButton>
        )}
        {house.animals.length > 0 && (
          <ActionButton tone="care" className="min-h-[40px] px-3 text-xs" disabled={busy || house.feedNeeded === 0 || animals.feed < house.feedNeeded}
            testId={`animal-feed-${house.code}`} onClick={() => void game.feedAnimalHouse(house.code)}
            ariaLabel={house.feedNeeded === 0 ? `${house.nameVi}: các con vật đang no` : `Cho ${house.nameVi} ăn, dùng ${house.feedNeeded} cám`}>
            {house.feedNeeded === 0 ? "Đang no" : `Cho ăn · ${house.feedNeeded} cám`}
          </ActionButton>
        )}
        {house.animals.length > 0 && (
          <ActionButton tone="quiet" className="min-h-[40px] px-3 text-xs" disabled={busy || !house.canRefill || animals.water < 1}
            testId={`animal-refill-${house.code}`} onClick={() => void game.waterAnimalHouse(house.code)}>
            {house.canRefill ? "Đổ nước · 1 Nước giếng" : "Máng còn đầy"}
          </ActionButton>
        )}
        {room > 0 && (
          <Confirm id={`buy-${house.species}`} pending={pending} setPending={setPending} disabled={busy || !house.animalCoinsOk} tone="quiet"
            testId={`animal-buy-${house.species}`}
            label={<>Đón {house.babyNameVi.toLowerCase()} · <CoinIcon className="h-3.5 w-3.5" /> {formatNumber(house.animalCoins)}</>}
            confirmLabel={<>Xác nhận, −{formatNumber(house.animalCoins)}</>}
            run={() => void game.buyAnimal(house.species, house.babyNameVi, house.code)} />
        )}
      </div>
      {house.animals.length > 0 && house.feedNeeded > animals.feed && (
        <p className="mt-1.5 text-[11px] text-[#ffd2b0]">Cần {house.feedNeeded} cám, bạn có {animals.feed}. Xay nông sản thành cám ở mục Thùng cám bên dưới.</p>
      )}
      {house.animals.length > 0 && house.canRefill && animals.water < 1 && (
        <p className="mt-1 text-[11px] text-[#ffd2b0]">Hết Nước giếng: mua ở Quầy Chợ Echo, kệ Chăm cây.</p>
      )}
    </div>
  );
}

function GuardianCard({ game, g, animals, nowMs, pending, setPending }: {
  game: EchoGardenGame; g: GardenGuardian; animals: GardenAnimals; nowMs: number; pending: Pending; setPending: (p: Pending) => void;
}) {
  const busy = game.busy !== null;
  const fed = untilText(g.fedUntil, nowMs);
  return (
    <li className={CARD} data-testid={`guardian-${g.species}`}>
      <div className="flex items-start gap-3">
        <Portrait src={animalIconUrl(g.species)} label={g.nameVi} dim={!g.owned || g.status === "HUNGRY"} />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-black text-[#EEF3FF]">{g.nameVi}</p>
          <p className="text-[11px] leading-snug text-[#EEF3FF]/70">{guardianEffectText(g)}</p>
          <p className="mt-1 text-[11px] font-semibold text-[#c6ecfb]" data-testid={`guardian-status-${g.species}`}>
            {guardianStatusText(g)}{g.owned && fed ? ` · thức ăn ${fed}` : ""}
          </p>
        </div>
      </div>
      <div className="mt-2 flex justify-end">
        {g.owned ? (
          <ActionButton tone="care" className="min-h-[40px] px-3 text-xs" disabled={busy || !g.canFeed || animals.feed < g.rationFeed}
            testId={`guardian-feed-${g.species}`} onClick={() => void game.feedGuardian(g.species, g.nameVi)}>
            {g.canFeed ? `Cho ăn · ${g.rationFeed} cám` : "Đang no"}
          </ActionButton>
        ) : (
          <Confirm id={`adopt-${g.species}`} pending={pending} setPending={setPending} disabled={busy || !g.levelOk || !g.coinsOk}
            testId={`guardian-adopt-${g.species}`}
            label={g.levelOk ? <>Nhận nuôi · <CoinIcon className="h-3.5 w-3.5" /> {formatNumber(g.coins)}</> : <>Mở ở Cấp {g.minLevel}</>}
            confirmLabel={<>Xác nhận, −{formatNumber(g.coins)}</>}
            run={() => void game.buyAnimal(g.species, g.nameVi, g.species)} />
        )}
      </div>
    </li>
  );
}

export function AnimalsPanel({ game, focus, onClose, onTab, onMarket }: {
  game: EchoGardenGame;
  /** a house code or a guardian species selected on the island (scrolled into view), or null */
  focus: string | null;
  onClose: () => void;
  onTab: (tab: LogisticsTab) => void;
  onMarket: () => void;
}) {
  const state = game.state!;
  const animals = state.animals;
  const [pending, setPending] = useState<Pending>(null);
  const guardiansRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus && animals?.guardians.some((g) => g.species === focus)) guardiansRef.current?.scrollIntoView({ block: "nearest" });
  }, [focus, animals]);
  if (!animals) return null;
  const nowMs = game.serverNow();
  const busy = game.busy !== null;
  const c = animals.compost;
  const batches = Math.min(c.dailyCap - c.usedToday, Math.floor(c.held / c.manure));
  return (
    <GardenSheet labelledBy="garden-animals-title" onClose={onClose} testId="garden-animals" wide>
      <style>{"@keyframes eg-pet{0%{opacity:0;transform:translate(-50%,6px) scale(.6)}25%{opacity:1}100%{opacity:0;transform:translate(-50%,-18px) scale(1.1)}}"}</style>
      <LogisticsTabs active="animals" onTab={onTab} state={state} />
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold text-[#FFD978]/90">Vật nuôi và bạn canh vườn</p>
          <h2 id="garden-animals-title" className="mt-0.5 text-lg font-black text-[#EEF3FF]">Chuồng trại</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Đóng Chuồng trại"
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/80 transition-[background-color,transform] duration-200 ${EASE} hover:bg-white/20 active:scale-[0.94] ${FOCUS_RING} cursor-pointer sm:h-9 sm:w-9`}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-[#EEF3FF]/70">
        Các bạn nhỏ lớn lên và làm việc theo giờ thật khi có đủ cám và nước. Quên chăm thì các bạn chỉ nghỉ ngơi: không con nào bị ốm hay mất đi, sản phẩm đã có vẫn chờ bạn.
      </p>

      <AdminQaAnimalsBar game={game} />

      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12px]" data-testid="animal-supplies">
        <span className="flex items-center gap-1 rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[#EEF3FF]/85">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={FEED_ICON} alt="" className="h-4 w-4 object-contain" />Cám ×{formatNumber(animals.feed)}
        </span>
        <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[#EEF3FF]/85">Nước giếng ×{formatNumber(animals.water)}</span>
        <ActionButton tone="quiet" className="min-h-[36px] px-3 text-xs" onClick={onMarket} testId="animal-open-market">Mua Nước giếng</ActionButton>
      </div>
      {animals.learnedToday && (
        <p className="mt-2 rounded-[14px] border border-[#F4B63F]/35 bg-[#F4B63F]/10 px-3 py-1.5 text-[12px] font-semibold text-[#FFE7A8]" data-testid="animal-learning-bonus">
          Hôm nay bạn đã đạt mục tiêu học: mỗi khẩu phần kéo dài thêm {animals.learningBonusPercent}%.
        </p>
      )}

      <h3 className="mt-4 text-[12px] font-bold text-[#EEF3FF]/70">Chuồng nuôi · {animals.livestock}/{Math.max(animals.livestockCapacity, 0)} con</h3>
      <div className="mt-1.5 flex flex-col gap-2">
        {animals.houses.map((h) => (
          <HouseCard key={h.code} game={game} house={h} animals={animals} nowMs={nowMs} pending={pending} setPending={setPending} focused={focus === h.code} />
        ))}
      </div>

      <div ref={guardiansRef}>
        <h3 className="mt-4 text-[12px] font-bold text-[#EEF3FF]/70">Bạn canh vườn</h3>
        <p className="mt-0.5 text-[11px] leading-snug text-[#EEF3FF]/60">
          Mỗi loài một bạn, nhận nuôi bằng Đồng Echo. Các bạn chỉ làm việc khi được cho ăn. Bảo vệ tân thủ và các giới hạn ghé thăm vẫn miễn phí cho mọi đảo.
        </p>
        <ul className="mt-1.5 flex flex-col gap-2">
          {animals.guardians.map((g) => <GuardianCard key={g.species} game={game} g={g} animals={animals} nowMs={nowMs} pending={pending} setPending={setPending} />)}
        </ul>
      </div>

      <h3 className="mt-4 text-[12px] font-bold text-[#EEF3FF]/70">Sản phẩm chăn nuôi</h3>
      <ul className="mt-1.5 flex flex-col gap-1.5" data-testid="animal-products">
        {animals.products.map((p) => (
          <li key={p.code} className="flex items-center gap-2.5 rounded-[14px] border border-white/10 bg-black/20 px-2.5 py-1.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={productIconUrl(p.code)} alt="" className="h-9 w-9 shrink-0 object-contain" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-bold text-[#EEF3FF]">{p.nameVi} <span className="font-semibold text-[#EEF3FF]/60">×{formatNumber(p.qty)}</span></p>
              <p className="text-[11px] text-[#EEF3FF]/60">{formatNumber(p.unitPrice)} Đồng Echo mỗi cái</p>
            </div>
            <ActionButton tone="quiet" className="min-h-[36px] px-3 text-xs" disabled={busy || p.qty === 0} testId={`animal-sell-${p.code}`}
              onClick={() => void game.sellAnimalProduct(p.code, p.qty, p.nameVi)} ariaLabel={`Bán ${p.qty} ${p.nameVi}`}>
              {p.qty > 0 ? `Bán · +${formatNumber(p.qty * p.unitPrice)}` : "Bán"}
            </ActionButton>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-[14px] border border-white/10 bg-black/20 px-3 py-2" data-testid="animal-compost">
        <p className="min-w-0 flex-1 text-[11px] leading-snug text-[#EEF3FF]/75">
          Ủ {c.manure} Phân chuồng thành 1 Phân bón cho luống cây. Hôm nay đã ủ {c.usedToday}/{c.dailyCap} mẻ.
        </p>
        <ActionButton tone="care" className="min-h-[36px] px-3 text-xs" disabled={busy || batches < 1} testId="animal-compost-btn"
          onClick={() => void game.compostManure(1)}>
          Ủ 1 mẻ
        </ActionButton>
      </div>

      <h3 className="mt-4 text-[12px] font-bold text-[#EEF3FF]/70">Thùng cám</h3>
      <p className="mt-0.5 text-[11px] leading-snug text-[#EEF3FF]/60">
        Xay nông sản trong Kho thành cám. Thức ăn chỉ trữ được trước tối đa {animals.feedMaxHours} giờ, nên các bạn nhỏ luôn cần bạn ghé thăm.
      </p>
      {animals.mill.length === 0 ? (
        <p className="mt-1.5 text-[12px] text-[#EEF3FF]/65" data-testid="animal-mill-empty">Kho chưa có nông sản xay được. Lúa mì là lựa chọn tiết kiệm nhất: 1 Lúa mì thành 1 cám.</p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1.5" data-testid="animal-mill">
          {animals.mill.map((m) => (
            <li key={`${m.cropCode}-${m.tier}`} className="flex items-center gap-2.5 rounded-[14px] border border-white/10 bg-black/20 px-2.5 py-1.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={cropIconUrl(m.cropCode)} alt="" className="h-8 w-8 shrink-0 object-contain" />
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-bold text-[#EEF3FF]">{m.nameVi} {TIER_LABEL[m.tier]} <span className="font-semibold text-[#EEF3FF]/60">×{formatNumber(m.held)}</span></p>
                <p className="text-[11px] text-[#EEF3FF]/60">1 cái thành {m.feedPerUnit} cám</p>
              </div>
              <ActionButton tone="quiet" className="min-h-[36px] px-2.5 text-xs" disabled={busy} testId={`animal-mill-one-${m.cropCode}-${m.tier}`}
                onClick={() => void game.millFeed(m.cropCode, m.tier, 1)} ariaLabel={`Xay 1 ${m.nameVi} ${TIER_LABEL[m.tier]}`}>
                Xay 1
              </ActionButton>
              {m.held > 1 && (
                <Confirm id={`mill-${m.cropCode}-${m.tier}`} pending={pending} setPending={setPending} disabled={busy} tone="quiet"
                  testId={`animal-mill-all-${m.cropCode}-${m.tier}`} label="Xay hết" confirmLabel={`Xay cả ${m.held}?`}
                  run={() => void game.millFeed(m.cropCode, m.tier, m.held)} />
              )}
            </li>
          ))}
        </ul>
      )}
    </GardenSheet>
  );
}
