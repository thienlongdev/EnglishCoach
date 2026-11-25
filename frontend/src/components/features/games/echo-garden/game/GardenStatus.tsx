"use client";

import React from "react";
import type { GardenState } from "@/types/garden";
import { CoinIcon, EssenceIcon, FOCUS_RING, PANEL, WaterIcon } from "./gardenUi";
import { formatNumber, seasonTitle, weatherLabel } from "./gardenModel";
import { WeatherIcon } from "./WorldPanels";

/**
 * Live player status in the HUD header (replaces the preview badge in gameplay): level + XP progress, coins, water,
 * essence, the season (theme week) with the current weather — a tap opens the forecast — and the daily goal that
 * unlocks the Echo Blessing — a tap opens what learning gives the garden today. Server numbers only.
 */
export function GardenStatus({ state, serverNowMs, onSeason, onLearning }: {
  state: GardenState; serverNowMs: number; onSeason?: () => void; onLearning?: () => void;
}) {
  const p = state.profile;
  const xpPct = Math.min(100, Math.round((p.xpIntoLevel / Math.max(1, p.xpToNext)) * 100));
  const g = state.today.goal;
  const goalPct = Math.min(100, Math.round((g.effectiveUnits / Math.max(1, g.targetUnits)) * 100));
  const daysLeft = Math.max(1, Math.ceil((Date.parse(state.world.themeEndsAt) - serverNowMs) / 86_400_000));
  const chip = `flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold backdrop-blur ${FOCUS_RING} cursor-pointer`;
  return (
    <div className="flex max-w-full flex-col items-start gap-1.5" data-testid="garden-status">
      <div className={`${PANEL} flex h-11 max-w-full items-center gap-2 rounded-[16px_20px_16px_18px] px-2.5 sm:h-10 sm:gap-2.5 sm:px-3`}>
        <span className="hidden text-sm font-black tracking-tight text-[#EEF3FF] lg:inline">Đảo Ký Ức</span>
        <div className="flex items-center gap-1.5" title={`${formatNumber(p.xpIntoLevel)} / ${formatNumber(p.xpToNext)} XP`}>
          <span className="whitespace-nowrap rounded-full bg-[#74C98B]/20 px-2 py-0.5 text-[11px] font-black text-[#a6e6b3]" data-testid="garden-level">Cấp {p.level}</span>
          <span className="relative h-1.5 w-12 overflow-hidden rounded-full bg-white/10 max-[359px]:hidden sm:w-16" aria-label={`Kinh nghiệm ${xpPct}%`} role="img">
            <span className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#74C98B] to-[#b9e48a] transition-[width] duration-500" style={{ width: `${xpPct}%` }} />
          </span>
        </div>
        <span className="h-5 w-px bg-white/10" />
        <span className="flex items-center gap-1 text-sm font-black tabular-nums text-[#FFD978]" data-testid="garden-coins" data-guide="coins" aria-label={`${formatNumber(p.coins)} Đồng Echo`}>
          <CoinIcon />
          {formatNumber(p.coins)}
        </span>
        <span className="flex items-center gap-1 text-sm font-bold tabular-nums text-[#bfe9fb]" data-testid="garden-water" aria-label={`${state.inventory.water} nước`}>
          <WaterIcon />
          {state.inventory.water}
        </span>
        <span className="flex items-center gap-1 text-sm font-bold tabular-nums text-[#9cefe0]" data-testid="garden-essence" aria-label={`${p.essence} Tinh chất Ký Ức`}>
          <EssenceIcon />
          {p.essence}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={onSeason} data-testid="garden-season-chip" aria-label={`${seasonTitle(state.world.theme)}, còn ${daysLeft} ngày, ${weatherLabel(state.world.weather)}. Mở dự báo`}
          className={`${chip} border-white/10 bg-[#1F2257]/85 text-[#EEF3FF]/85 hover:bg-[#2a2f6c]`}>
          <WeatherIcon w={state.world.weather} className="h-3.5 w-3.5 text-[#FFE2A0]" />
          <span className="hidden sm:inline">{seasonTitle(state.world.theme)} · còn {daysLeft} ngày</span>
          <span className="sm:hidden">{weatherLabel(state.world.weather)}</span>
        </button>
        <button type="button" onClick={onLearning} data-testid="garden-goal" data-guide="learning"
          className={`${chip} ${g.done ? "border-[#F4B63F]/40 bg-[#F4B63F]/15 text-[#FFD978]" : "border-white/10 bg-[#1F2257]/85 text-[#EEF3FF]/85 hover:bg-[#2a2f6c]"}`}>
          {g.done ? (
            <>Phúc Lành Echo: giá bán ×{String(state.today.blessingMultiplier).replace(".", ",")}</>
          ) : (
            <>
              Mục tiêu hôm nay {Math.floor(g.effectiveUnits)}/{g.targetUnits}
              <span className="relative h-1 w-10 overflow-hidden rounded-full bg-white/10">
                <span className="absolute inset-y-0 left-0 rounded-full bg-[#F4B63F]" style={{ width: `${goalPct}%` }} />
              </span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
