"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Lock, X } from "lucide-react";
import { useSWRConfig } from "swr";
import type { GardenEchoRewards, GardenFrame, GardenPremiumReward, GardenVoucherShop } from "@/types/garden";
import { gardenApi } from "@/services/gardenApi";
import { avatarFrameApi } from "@/services/avatarFrameApi";
import { AVATAR_FRAMES_CACHE_KEY_PREFIX } from "@/hooks/useAvatarFrames";
import { useCurrentUserAvatar } from "@/hooks/useCurrentUserAvatar";
import type { EchoGardenGame } from "./useEchoGarden";
import { ActionButton, Chip, CoinIcon, EASE, FOCUS_RING, GardenSheet } from "./gardenUi";
import { formatNumber } from "./gardenModel";

/**
 * Echo Garden Phase 3F — "Phần thưởng Echo": Premium 7 days, AI voucher packs and the Echo Garden profile frames,
 * all for Echo Coins earned in the garden.
 *
 * Every number, state and date here is a server fact (`GET /garden/rewards/echo`); each purchase is a server command
 * with its own idempotency key and two steps (choose → confirm). A reward that is closed or out of budget says so —
 * nothing on this screen pretends to succeed. A frame only changes the ring around the player's existing profile
 * photo: no avatar is created, replaced or sold here.
 */

type Tab = "PREMIUM" | "VOUCHER" | "FRAME";

const dateTime = (iso: string | null) => (iso
  ? new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "");

function Coins({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-1 font-black tabular-nums text-[#FFD978]" aria-label={`${formatNumber(value)} Đồng Echo`}>
      <CoinIcon className="h-3.5 w-3.5" />{formatNumber(value)}
    </span>
  );
}

function Fact({ label, value, ok }: { label: string; value: React.ReactNode; ok?: boolean }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-[12px] bg-white/[0.04] px-3 py-2 text-[12px]">
      <span className="text-[#EEF3FF]/70">{label}</span>
      <span className={`font-bold tabular-nums ${ok === undefined ? "text-[#EEF3FF]" : ok ? "text-[#a6e6b3]" : "text-[#ffd2b0]"}`}>{value}</span>
    </li>
  );
}

function Confirm({ text, busy, onYes, onNo, testId }: { text: React.ReactNode; busy: boolean; onYes: () => void; onNo: () => void; testId: string }) {
  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2 rounded-[14px] border border-[#FFD978]/30 bg-[#FFD978]/[0.07] px-3 py-2" role="group" aria-label="Xác nhận">
      <p className="text-[12px] text-[#EEF3FF]/90">{text}</p>
      <div className="flex gap-2">
        <ActionButton tone="quiet" onClick={onNo}>Thôi</ActionButton>
        <ActionButton tone="reward" disabled={busy} onClick={onYes} testId={testId}>Xác nhận</ActionButton>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Premium 7 days

function premiumStatusText(p: GardenPremiumReward): string {
  switch (p.status) {
    case "AVAILABLE": return "Bạn đủ điều kiện đổi ngay bây giờ.";
    case "CLOSED": return "Phần thưởng này chưa mở.";
    case "BUDGET_EXHAUSTED": return "Suất đổi của tháng này đã hết. Hãy quay lại vào tháng sau.";
    case "PREMIUM_ACTIVE": return p.activeUntil ? `Premium từ phần thưởng đang chạy đến ${dateTime(p.activeUntil)}.` : "Bạn đang có Premium; phần thưởng chỉ đổi được khi Premium hiện tại đã hết hạn.";
    case "COOLDOWN": return `Đổi lại được từ ${dateTime(p.nextEligibleAt)} (${p.cooldownDays} ngày sau khi phần thưởng trước hết hạn).`;
    case "WINDOW_LIMIT": return `Bạn đã đổi đủ ${p.maxPerWindow} lần trong ${p.windowDays} ngày gần nhất${p.nextEligibleAt ? `; đổi lại được từ ${dateTime(p.nextEligibleAt)}` : ""}.`;
    case "LEARNING_DAYS": return `Cần ${p.learningDaysNeeded} ngày học trong ${p.learningWindowDays} ngày gần nhất; bạn có ${p.learningDays}.`;
    default: return "Bạn chưa đủ Đồng Echo.";
  }
}

function PremiumTab({ p, coins, game, onChanged }: { p: GardenPremiumReward; coins: number; game: EchoGardenGame; onChanged: (r: GardenEchoRewards) => void }) {
  const [confirming, setConfirming] = useState(false);
  const busy = game.busy !== null;
  return (
    <div data-testid="garden-reward-premium">
      <div className="rounded-[18px_15px_18px_16px] border border-white/10 bg-black/20 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[15px] font-black text-[#EEF3FF]">English Coach Premium · 7 ngày</h3>
          <Coins value={p.coinsCost} />
        </div>
        <p className="mt-1 text-[12px] leading-snug text-[#EEF3FF]/70">
          Đúng {p.hours} giờ Premium thật của English Coach, tính từ lúc đổi. Không tự gia hạn, không trừ tiền ngân hàng, không ảnh hưởng gói Premium bạn mua.
        </p>
        <ul className="mt-2 flex flex-col gap-1.5">
          <Fact label={`Ngày học trong ${p.learningWindowDays} ngày gần nhất`} value={`${p.learningDays}/${p.learningDaysNeeded}`} ok={p.learningDays >= p.learningDaysNeeded} />
          <Fact label={`Đã đổi trong ${p.windowDays} ngày`} value={`${p.redeemedInWindow}/${p.maxPerWindow}`} ok={p.redeemedInWindow < p.maxPerWindow} />
          <Fact label="Đồng Echo của bạn" value={formatNumber(coins)} ok={coins >= p.coinsCost} />
          <Fact label="Thời gian chờ giữa hai lần" value={`${p.cooldownDays} ngày sau khi hết hạn`} />
          {p.activeUntil && <Fact label="Phần thưởng đang chạy đến" value={dateTime(p.activeUntil)} />}
          {p.nextEligibleAt && <Fact label="Đổi lại được từ" value={dateTime(p.nextEligibleAt)} />}
        </ul>
        <p className={`mt-2 text-[12px] font-semibold ${p.status === "AVAILABLE" ? "text-[#a6e6b3]" : "text-[#ffd2b0]"}`} aria-live="polite" data-testid="garden-reward-premium-status">
          {premiumStatusText(p)}
        </p>
        <div className="mt-2 flex justify-end">
          {!confirming && (
            <ActionButton tone="reward" disabled={busy || p.status !== "AVAILABLE"} onClick={() => setConfirming(true)} testId="garden-reward-premium-redeem">
              Đổi Premium 7 ngày
            </ActionButton>
          )}
          {confirming && (
            <Confirm busy={busy} testId="garden-reward-premium-confirm" onNo={() => setConfirming(false)}
              text={<>Đổi <b>Premium 7 ngày</b> với <Coins value={p.coinsCost} />?</>}
              onYes={() => void game.redeemPremiumReward().then((r) => { setConfirming(false); if (r) onChanged(r.rewards); })} />
          )}
        </div>
      </div>
      {p.history.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-[11px] text-[#EEF3FF]/65" aria-label="Các lần đã đổi">
          {p.history.map((h) => <li key={h.id}>Đã đổi {dateTime(h.startsAt)} → hết hạn {dateTime(h.expiresAt)} · {formatNumber(h.coinsSpent)} Đồng Echo</li>)}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ AI vouchers

const FEATURE_LABEL: Record<string, string> = {
  WRITING_AI_FEEDBACK: "Chữa bài viết", TRANSLATION_AI_GRADING: "Chấm dịch", READING_CONTEXT_EXPLANATION: "Giải nghĩa ngữ cảnh",
  SPEAKING_ROLEPLAY: "Hội thoại Role-play", SPEAKING_PRONUNCIATION: "Phân tích phát âm", SPEAKING_SHADOWING: "Shadowing",
  SPEAKING_QUICK_CHECK: "Kiểm tra phát âm nhanh",
};

const USE_LABEL: Record<string, string> = { RESERVED: "đang dùng", CONSUMED: "đã dùng", RELEASED: "đã trả lại" };

function VoucherTab({ v, game, onChanged }: { v: GardenVoucherShop; game: EchoGardenGame; onChanged: (r: GardenEchoRewards) => void }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const busy = game.busy !== null;
  const closedText = v.status === "CLOSED" ? "Quầy Phiếu AI chưa mở." : v.status === "BUDGET_EXHAUSTED" ? "Phiếu AI của tháng này đã phát hết." : v.status === "CAP_REACHED" ? `Bạn đã mua đủ ${v.capCredits} phiếu trong ${v.capWindowDays} ngày.` : null;
  return (
    <div data-testid="garden-reward-vouchers">
      <div className="rounded-[18px_15px_18px_16px] border border-white/10 bg-black/20 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[15px] font-black text-[#EEF3FF]">Ví Phiếu AI</h3>
          <Chip tone={v.balance > 0 ? "good" : "quiet"} testId="garden-voucher-balance">{v.balance} phiếu</Chip>
        </div>
        <p className="mt-1 text-[12px] leading-snug text-[#EEF3FF]/70">
          Một phiếu trả cho một lượt AI khi lượt miễn phí hoặc hạn mức Premium của tính năng đó đã hết. Lượt AI lỗi không mất phiếu. Phiếu dùng được trên toàn English Coach, hết hạn sau {v.validDays} ngày.
        </p>
        <p className="mt-1 text-[11px] text-[#EEF3FF]/60">Dùng được cho: {v.eligibleFeatures.map((f) => FEATURE_LABEL[f] ?? f).join(" · ")}</p>
        <ul className="mt-2 flex flex-col gap-1.5">
          <Fact label={`Đã mua trong ${v.capWindowDays} ngày`} value={`${v.boughtInWindow}/${v.capCredits} phiếu`} ok={v.boughtInWindow < v.capCredits} />
          {v.nextExpiry && <Fact label="Phiếu hết hạn sớm nhất" value={dateTime(v.nextExpiry)} />}
        </ul>
        {closedText && <p className="mt-2 text-[12px] font-semibold text-[#ffd2b0]" aria-live="polite" data-testid="garden-voucher-status">{closedText}</p>}
        <ul className="mt-2 flex flex-col gap-2">
          {v.packs.map((pack) => (
            <li key={pack.code} className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] bg-white/[0.04] px-3 py-2" data-testid={`garden-voucher-pack-${pack.code}`}>
              <span className="text-[13px] font-bold text-[#EEF3FF]">{pack.credits} Phiếu AI · <Coins value={pack.coins} /></span>
              {confirming !== pack.code && (
                <ActionButton tone="reward" disabled={busy || v.status !== "AVAILABLE" || !pack.coinsOk || !pack.withinCap} onClick={() => setConfirming(pack.code)} testId={`garden-voucher-buy-${pack.code}`}>
                  {!pack.withinCap ? "Vượt giới hạn" : !pack.coinsOk ? "Chưa đủ Đồng Echo" : "Mua"}
                </ActionButton>
              )}
              {confirming === pack.code && (
                <Confirm busy={busy} testId={`garden-voucher-confirm-${pack.code}`} onNo={() => setConfirming(null)}
                  text={<>Mua <b>{pack.credits} Phiếu AI</b> với <Coins value={pack.coins} />?</>}
                  onYes={() => void game.buyVouchers(pack.code).then((r) => { setConfirming(null); if (r) onChanged(r.rewards); })} />
              )}
            </li>
          ))}
        </ul>
      </div>
      {v.grants.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-[11px] text-[#EEF3FF]/65" aria-label="Phiếu đã mua">
          {v.grants.map((g, i) => <li key={i}>Còn {g.remaining}/{g.credits} phiếu · mua {dateTime(g.issuedAt)} · hết hạn {dateTime(g.expiresAt)}</li>)}
        </ul>
      )}
      {v.recent.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-[11px] text-[#EEF3FF]/55" aria-label="Lịch sử dùng phiếu">
          {v.recent.slice(0, 8).map((u, i) => <li key={i}>{FEATURE_LABEL[u.featureKey] ?? u.featureKey}: {USE_LABEL[u.status] ?? u.status} · {dateTime(u.at)}</li>)}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ profile frames

const METRIC_TEXT: Record<string, (n: number) => string> = {
  GARDEN_LEARNING_DAYS: (n) => `${formatNumber(n)} ngày học đã xác nhận`,
  GARDEN_HARVESTS: (n) => `${formatNumber(n)} lần thu hoạch`,
  GARDEN_GRADUATIONS: (n) => `${formatNumber(n)} cây ký ức tốt nghiệp`,
  GARDEN_MONUMENT_ERA: (n) => `Cây Tri Thức đạt kỷ nguyên ${n}`,
};

/** The frame around the player's EXISTING profile photo (or a neutral placeholder): the photo itself is never changed. */
function FramePreview({ frame, avatarUrl }: { frame: GardenFrame; avatarUrl: string | null }) {
  return (
    <span className="relative block h-28 w-28 shrink-0" aria-hidden>
      <span className="absolute left-1/4 top-1/4 flex h-1/2 w-1/2 items-center justify-center overflow-hidden rounded-full bg-gradient-to-b from-[#3d5a80] to-[#22344f]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {avatarUrl ? <img src={avatarUrl} alt="" className="h-full w-full object-cover" draggable={false} /> : <span className="h-1/2 w-1/2 rounded-full bg-white/25" />}
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={frame.asset} alt="" loading="lazy" decoding="async" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain" />
    </span>
  );
}

function FrameCard({ frame, avatarUrl, game, busyFrame, onBuy, onEquip, onClaim }: {
  frame: GardenFrame; avatarUrl: string | null; game: EchoGardenGame; busyFrame: boolean;
  onBuy: (f: GardenFrame) => Promise<void>; onEquip: (f: GardenFrame, on: boolean) => Promise<void>; onClaim: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const busy = game.busy !== null || busyFrame;
  return (
    <li className="flex gap-3 rounded-[18px_15px_18px_16px] border border-white/10 bg-black/20 p-2.5" data-testid={`garden-frame-${frame.slug}`}>
      <FramePreview frame={frame} avatarUrl={avatarUrl} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <h4 className="text-[13px] font-black leading-tight text-[#EEF3FF]">{frame.name}</h4>
          <Chip tone="quiet">Bậc {frame.tier}</Chip>
          {frame.equipped ? <Chip tone="magic">Đang dùng</Chip> : frame.owned ? <Chip tone="good">Đã có</Chip>
            : frame.status === "LOCKED" ? <Chip tone="quiet"><Lock className="h-3 w-3" aria-hidden />Chưa mở</Chip> : null}
        </div>
        {frame.unlockKind === "COIN"
          ? !frame.owned && <p className="mt-1 text-[11px] text-[#EEF3FF]/70">Mua một lần bằng <Coins value={frame.coinPrice} /></p>
          : (
            <ul className="mt-1 flex flex-col gap-0.5 text-[11px]">
              {frame.requirements.map((q) => (
                <li key={q.metric} className={q.ok ? "text-[#a6e6b3]" : "text-[#EEF3FF]/70"}>
                  Thành tựu: {(METRIC_TEXT[q.metric] ?? ((n: number) => `${q.metric} ${n}`))(q.target)} ({formatNumber(q.progress)}/{formatNumber(q.target)})
                </li>
              ))}
            </ul>
          )}
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          {frame.owned && (
            <ActionButton tone={frame.equipped ? "quiet" : "care"} disabled={busy} testId={`garden-frame-equip-${frame.slug}`} onClick={() => void onEquip(frame, !frame.equipped)}>
              {frame.equipped ? "Bỏ dùng" : "Dùng cho hồ sơ"}
            </ActionButton>
          )}
          {!frame.owned && frame.unlockKind === "EARNED" && frame.status === "AVAILABLE" && (
            <ActionButton tone="reward" disabled={busy} testId={`garden-frame-claim-${frame.slug}`} onClick={() => void onClaim()}>Nhận khung</ActionButton>
          )}
          {!frame.owned && frame.unlockKind === "COIN" && !confirming && (
            <ActionButton tone="reward" disabled={busy || !frame.coinsOk} testId={`garden-frame-buy-${frame.slug}`} onClick={() => setConfirming(true)}>
              {frame.coinsOk ? "Mua" : "Chưa đủ Đồng Echo"}
            </ActionButton>
          )}
          {confirming && (
            <Confirm busy={busy} testId={`garden-frame-confirm-${frame.slug}`} onNo={() => setConfirming(false)}
              text={<>Mua khung <b>{frame.name}</b> với <Coins value={frame.coinPrice} />?</>}
              onYes={() => void onBuy(frame).then(() => setConfirming(false))} />
          )}
        </div>
      </div>
    </li>
  );
}

function FrameTab({ rewards, game, onChanged, reload }: { rewards: GardenEchoRewards; game: EchoGardenGame; onChanged: (r: GardenEchoRewards) => void; reload: () => Promise<void> }) {
  const { avatarUrl } = useCurrentUserAvatar();
  const { mutate } = useSWRConfig();
  const [working, setWorking] = useState(false);
  const { notify } = game;
  const frames = rewards.frames;
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; frames: GardenFrame[] }>();
    frames.frames.forEach((f) => {
      if (!map.has(f.collection)) map.set(f.collection, { name: f.collectionName, frames: [] });
      map.get(f.collection)!.frames.push(f);
    });
    return [...map.entries()];
  }, [frames.frames]);
  /** The wardrobe, the header and the profile read the frame catalogue through SWR: tell them it changed. */
  const syncFrames = useCallback(async () => {
    await mutate((key) => Array.isArray(key) && key[0] === AVATAR_FRAMES_CACHE_KEY_PREFIX);
    await reload();
  }, [mutate, reload]);
  const act = useCallback(async (work: () => Promise<unknown>, done: string) => {
    setWorking(true);
    try {
      await work();
      await syncFrames();
      notify("ok", done);
    } catch {
      notify("error", "Chưa thực hiện được. Hãy thử lại.");
    } finally {
      setWorking(false);
    }
  }, [syncFrames, notify]);
  if (!frames.open) return <p className="mt-4 text-center text-[12px] text-[#EEF3FF]/60">Khung hồ sơ Echo Garden chưa mở.</p>;
  return (
    <div data-testid="garden-reward-frames">
      <p className="text-[12px] leading-snug text-[#EEF3FF]/70">
        Khung trang trí quanh ảnh hồ sơ sẵn có của bạn trên toàn English Coach; ảnh của bạn không đổi. Bạn có {frames.owned}/{frames.total} khung Echo Garden.
      </p>
      {groups.map(([code, group]) => (
        <section key={code} className="mt-3" aria-label={group.name}>
          <h3 className="text-[13px] font-black text-[#FFD978]">{group.name}</h3>
          <ul className="mt-1.5 flex flex-col gap-2">
            {group.frames.map((f) => (
              <FrameCard key={f.slug} frame={f} avatarUrl={avatarUrl} game={game} busyFrame={working}
                onBuy={async (frame) => {
                  const r = await game.buyFrame(frame.slug, frame.name);
                  if (r) {
                    onChanged(r.rewards);
                    await mutate((key) => Array.isArray(key) && key[0] === AVATAR_FRAMES_CACHE_KEY_PREFIX);
                  }
                }}
                onEquip={(frame, on) => act(() => (on ? avatarFrameApi.equipFrame(frame.slug) : avatarFrameApi.unequipFrame()), on ? `Đang dùng khung ${frame.name}` : "Đã bỏ khung")}
                onClaim={() => act(() => avatarFrameApi.reconcile(), "Đã nhận khung thành tựu")} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ the panel

export function EchoRewardsPanel({ game, onClose, onBackToMarket }: { game: EchoGardenGame; onClose: () => void; onBackToMarket: () => void }) {
  const [tab, setTab] = useState<Tab>("PREMIUM");
  const [rewards, setRewards] = useState<GardenEchoRewards | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      setRewards(await gardenApi.echoRewards());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const coins = rewards?.coins ?? game.state?.profile.coins ?? 0;
  const tabs: Array<{ id: Tab; label: string }> = [{ id: "PREMIUM", label: "Premium 7 ngày" }, { id: "VOUCHER", label: "Phiếu AI" }, { id: "FRAME", label: "Khung hồ sơ" }];
  return (
    <GardenSheet labelledBy="garden-echo-rewards-title" onClose={onClose} testId="garden-echo-rewards" wide>
      <div className="flex items-start justify-between gap-3">
        <div>
          <button type="button" onClick={onBackToMarket} className={`inline-flex min-h-[44px] items-center text-[11px] font-semibold text-[#FFD978]/90 underline-offset-2 hover:underline sm:min-h-0 ${FOCUS_RING} cursor-pointer`}>
            ‹ Quầy Chợ Echo
          </button>
          <h2 id="garden-echo-rewards-title" className="mt-0.5 text-lg font-black text-[#EEF3FF]">Phần thưởng Echo</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Đóng phần thưởng Echo"
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/80 transition-[background-color,transform] duration-200 ${EASE} hover:bg-white/20 active:scale-[0.94] ${FOCUS_RING} cursor-pointer sm:h-9 sm:w-9`}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[12px] text-[#EEF3FF]/70">
        <span>Đổi bằng Đồng Echo kiếm được trong vườn.</span>
        <span className="flex items-center gap-1 font-bold text-[#FFD978]" aria-label={`Bạn có ${formatNumber(coins)} Đồng Echo`} data-testid="garden-echo-rewards-coins">
          <CoinIcon className="h-3.5 w-3.5" />{formatNumber(coins)}
        </span>
      </div>
      <div role="tablist" aria-label="Loại phần thưởng" className="mt-3 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:thin]">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} data-testid={`garden-echo-rewards-tab-${t.id}`} onClick={() => setTab(t.id)}
            className={`min-h-[44px] shrink-0 whitespace-nowrap rounded-full border px-3 text-[12px] font-bold sm:min-h-[40px] transition-[background-color,color] duration-200 ${EASE} ${FOCUS_RING} cursor-pointer ${tab === t.id ? "border-[#FFD978]/60 bg-[#FFD978]/90 text-[#3a2a0a]" : "border-white/10 bg-white/[0.05] text-[#EEF3FF]/80 hover:bg-white/10"}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-3">
        {!rewards && !failed && <p className="mt-6 text-center text-[12px] text-[#EEF3FF]/60" aria-busy="true">Đang tải phần thưởng…</p>}
        {failed && <p className="mt-6 text-center text-[12px] text-[#ffd2b0]">Chưa mở được quầy phần thưởng. <button type="button" className={`underline ${FOCUS_RING} cursor-pointer`} onClick={() => void load()}>Thử lại</button></p>}
        {rewards && tab === "PREMIUM" && <PremiumTab p={rewards.premium} coins={coins} game={game} onChanged={setRewards} />}
        {rewards && tab === "VOUCHER" && <VoucherTab v={rewards.vouchers} game={game} onChanged={setRewards} />}
        {rewards && tab === "FRAME" && <FrameTab rewards={rewards} game={game} onChanged={setRewards} reload={load} />}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-[#EEF3FF]/55">
        Phần thưởng không đổi ra tiền, không chuyển cho người khác và không bán Đồng Echo. Premium và Phiếu AI có giới hạn theo tháng của hệ thống; khi hết suất, bạn không bị trừ Đồng Echo.
      </p>
    </GardenSheet>
  );
}
