"use client";

import React, { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Package, Users, Volume2, VolumeX, Wheat } from "lucide-react";
import { gardenAudio } from "./gardenAudio";
import type { GardenCrop, GardenHarvestResult, GardenSellLine } from "@/types/garden";
import type { FarmSceneApi } from "../EchoGardenCanvas";
import { BrandWhaleIcon } from "@/components/common/BrandWhaleIcon";
import type { EchoGardenGame } from "./useEchoGarden";
import { ActionButton, EASE, ECHO_COIN_ICON_2X, FOCUS_RING, PANEL } from "./gardenUi";
import { PlotPanel } from "./PlotPanel";
import { HarvestFlow } from "./HarvestFlow";
import { InventoryPanel } from "./InventoryPanel";
import { ForestPanel, KnowledgePanel, PestPanel } from "./MemoryPanels";
import { LearningPanel, SeasonPanel } from "./WorldPanels";
import { ExpansionPanel, MarketPanel, OrdersPanel, type LogisticsTab } from "./EconomyPanels";
import { CodexPanel, EchoHint, MilestoneCard, MonumentPanel } from "./LivingPanels";
import { BuildingPanel, LandPanel, RewardsPanel } from "./EstatePanels";
import { CosmeticShopPanel, DecorCard, PlacementBar, TryOnBar, type Placing, type TryOn } from "./CosmeticPanels";
import { EchoRewardsPanel } from "./RewardPanels";
import { AnimalsPanel } from "./AnimalPanels";
import type { PlacementCandidate } from "../EchoGardenCanvas";
import { ONBOARDING_DONE, cropIconUrl, echoLine, formatNumber, type EchoAction } from "./gardenModel";
import { HelpPanel } from "./guide/HelpPanel";
import type { GardenGuideApi } from "./guide/useGardenGuide";

/**
 * Panels opened from the HUD or a world object (selection-driven panels — bed, grove, pest, expansion cell — come from
 * the world). Phase 3A: "orders" (delivery board, signpost) and "market" (stall at the seed corner) share the Kho sheet.
 */
export type GardenPanel = "inventory" | "season" | "learning" | "forest" | "orders" | "market"
  /** Phase 3B: the monument (the Knowledge Tree), the grove overview, the codex (4th Kho tab) and Echo (the whale). */
  | "monument" | "grove" | "codex" | "echo"
  /** Phase 3C: the three buildings (cottage, storehouse, market stall) and the Echo Contribution / rewards sheet. */
  | "cottage" | "warehouse" | "stall" | "rewards"
  /** Phase 3E: the cosmetic shop (opened from the market stall). */
  | "cosmetics"
  /** Phase 3F: Premium 7 days, AI vouchers and profile frames for Echo Coins (opened from the market stall). */
  | "echoRewards"
  /** Phase 3G: the social islands sheet (rendered by the view: it also exists while visiting another island). */
  | "social"
  /** Phase 3H: the animal quarter (fifth Kho tab; also opened by an animal house or a guardian on the island). */
  | "animals"
  /** "Hướng dẫn": Echo's guides (the starter guide and the topics); opening it starts nothing. */
  | "help" | null;

/** Harvest challenges take at most this many beds (the server's limit); a larger farm harvests in rounds. */
const HARVEST_BATCH = 12;

/** A living-memory object selected in the world: a sacred spot (or the whole grove) or a Forgotten Pest. */
export type LivingSelection = { kind: "grove"; slot: number | null } | { kind: "pest"; id: number } | null;

interface GardenOverlayProps {
  game: EchoGardenGame;
  selectedSlot: number | null;
  selectedLiving: LivingSelection;
  /** Phase 3A: a purchasable bed cell selected in the world (slot 7–10), or null. */
  selectedExpansion: number | null;
  /** Phase 3C: a regional bed cell selected in the world (slot 11+), or null. */
  selectedLand: number | null;
  onSelectLiving: (sel: LivingSelection) => void;
  onCloseSelection: () => void;
  onFocusFarm: () => void;
  farmApi: FarmSceneApi | null;
  reducedMotion: boolean;
  panel: GardenPanel;
  onPanel: (panel: GardenPanel) => void;
  /** Phase 3E: a decoration selected in the world, the appearance being tried on and the decoration being placed. */
  selectedDecor?: number | null;
  tryOn?: TryOn | null;
  onTryOn?: (t: TryOn | null) => void;
  placing?: Placing | null;
  onPlacing?: (p: Placing | null) => void;
  placementCandidate?: PlacementCandidate | null;
  onConfirmPlacement?: () => void;
  /** Phase 3H: the animal house or guardian selected on the island (the animals sheet scrolls to it), or null. */
  animalFocus?: string | null;
  /** Echo's voluntary guide: the Help entry, and the server-confirmed actions a running step waits for. */
  guide: GardenGuideApi;
}

/** A small icon that arcs from a world point to a HUD control (harvest → Kho, sale → coins). */
function flyTo(layer: HTMLElement | null, from: { x: number; y: number }, target: Element | null, src: string, reduced: boolean) {
  if (!layer || !target || reduced || typeof document === "undefined") return;
  const to = target.getBoundingClientRect();
  const end = { x: to.left + to.width / 2, y: to.top + to.height / 2 };
  const mid = { x: (from.x + end.x) / 2, y: Math.min(from.y, end.y) - 90 };
  const img = document.createElement("img");
  img.src = src;
  img.alt = "";
  img.style.cssText = "position:fixed;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;pointer-events:none;object-fit:contain;z-index:60";
  layer.appendChild(img);
  const at = (p: { x: number; y: number }, s: number) => `translate(${p.x}px, ${p.y}px) scale(${s})`;
  const anim = img.animate(
    [
      { transform: at(from, 0.5), opacity: 0 },
      { transform: at(from, 1.1), opacity: 1, offset: 0.18 },
      { transform: at(mid, 0.95), opacity: 1, offset: 0.55 },
      { transform: at(end, 0.45), opacity: 0.35 },
    ],
    { duration: 780, easing: "cubic-bezier(0.22,1,0.36,1)" },
  );
  anim.onfinish = () => img.remove();
}

/** The Echo Coin that flies to the HUD counter (the same art as every coin icon). */
const COIN_SVG = ECHO_COIN_ICON_2X;

export function GardenOverlay({
  game, selectedSlot, selectedLiving, selectedExpansion, selectedLand, onSelectLiving, onCloseSelection, onFocusFarm, farmApi, reducedMotion,
  panel, onPanel, selectedDecor = null, tryOn = null, onTryOn, placing = null, onPlacing, placementCandidate = null, onConfirmPlacement,
  animalFocus = null, guide,
}: GardenOverlayProps) {
  const router = useRouter();
  const state = game.state!;
  // Phase 3E: the decoration selected in the world (a server fact; gone once it is stored)
  const selectedDecorView = selectedDecor !== null ? state.cosmetics?.decor.find((d) => d.id === selectedDecor) ?? null : null;
  const flyLayer = useRef<HTMLDivElement>(null);
  const [harvestIds, setHarvestIds] = useState<number[] | null>(null);
  const [muted, setMuted] = useState(() => gardenAudio.muted);
  // Phase 3B: the hint the player put aside (by its content) and the codex page to open
  const [echoDismissed, setEchoDismissed] = useState<string | null>(null);
  const [codexCrop, setCodexCrop] = useState<string | null>(null);
  const serverNow = game.serverNow();

  const plot = selectedSlot ? state.plots.find((p) => p.slot === selectedSlot) ?? null : null;
  const readyIds = useMemo(
    () => state.plots.filter((p) => p.planting?.ready && p.planting.id > 0).map((p) => p.planting!.id),
    [state.plots],
  );
  const produceCount = state.inventory.produce.reduce((a, p) => a + p.qty, 0);
  const step = state.onboardingStep;

  const advance = useCallback((from: number, to: number) => {
    if (step >= from && step < to) void game.advanceOnboarding(to);
  }, [step, game]);

  const onPlant = async (crop: GardenCrop) => {
    if (!plot) return;
    if (!(await game.plant(plot, crop))) return;
    advance(1, 2);
    // the server accepted the planting: a guide step that waits for it may go on
    guide.notify("planted");
  };
  const onBoost = async (code: string) => {
    if (!plot) return;
    if (!(await game.boost(plot, code))) return;
    advance(2, 3);
    if (code === "WATER") guide.notify("watered");
  };
  const onHarvestDone = (result: GardenHarvestResult | null) => {
    setHarvestIds(null);
    if (!result) return;
    onCloseSelection();
    advance(1, 4);
    const kho = document.querySelector("[data-testid='garden-inventory-btn']");
    result.harvests.forEach((h, i) => {
      const slot = state.plots.find((p) => p.id === h.plotId)?.slot;
      const from = slot ? farmApi?.bedClientPoint(slot) : null;
      if (from) window.setTimeout(() => flyTo(flyLayer.current, from, kho, cropIconUrl(h.cropCode), reducedMotion), i * 70);
      // Phase 3D: the small harvest bonus flies to the coin counter
      if (from && (h.coins ?? 0) > 0) {
        window.setTimeout(() => flyTo(flyLayer.current, from, document.querySelector("[data-testid='garden-coins']"), COIN_SVG, reducedMotion), 260 + i * 70);
      }
    });
  };
  const onTreat = async (code: string) => {
    if (plot) await game.treat(plot, code);
  };
  const onSell = async (lines: GardenSellLine[], from: HTMLElement | null) => {
    const origin = from?.getBoundingClientRect();
    const r = await game.sell(lines);
    if (!r) return;
    advance(4, 5);
    const coins = document.querySelector("[data-testid='garden-coins']");
    if (origin) {
      for (let i = 0; i < Math.min(5, Math.max(1, r.lines.length + 2)); i++) {
        window.setTimeout(() => flyTo(flyLayer.current, { x: origin.left + origin.width / 2 + (i - 2) * 14, y: origin.top }, coins, COIN_SVG, reducedMotion), i * 60);
      }
    }
  };
  /** Leave for a REAL English Coach module (it grades and records the learning; the garden only reads it later). */
  const goTo = async (route: string) => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      /* navigation must not depend on fullscreen */
    }
    router.push(route);
  };
  const goStudy = () => goTo("/flashcards");

  // Echo's voluntary guide owns the screen while it is offered or running: no other card competes with it
  const guiding = guide.invite || guide.run !== null;
  const showBasket = state.rewards.unseen && step >= ONBOARDING_DONE && !guiding && !harvestIds && !panel && !plot && !selectedLiving && !selectedExpansion && !selectedLand;
  const onTab = (tab: LogisticsTab) => {
    if (tab === "codex") setCodexCrop(null);
    onPanel(tab);
  };

  // Phase 3B: Echo's single hint and the milestone card (one thing at a time; never over a panel or the tutorial)
  const living = state.living;
  const skinName = (code: string) => living?.collection.crops.flatMap((c) => c.skins).find((s) => s.code === code)?.nameVi ?? code;
  const hint = echoLine(living?.echo, skinName);
  const hintKey = living ? `${living.echo.code}:${JSON.stringify(living.echo.params)}` : "";
  const unseen = living?.monument.unseen ?? [];
  const idle = step >= ONBOARDING_DONE && !guiding && !harvestIds && !panel && !plot && !selectedLiving && !selectedExpansion && !selectedLand && !showBasket;
  const showMilestones = idle && unseen.length > 0;
  // Phase 3H: a new island starts closed; its owner is asked once who may find it (never over the tutorial or a panel)
  const askVisibility = idle && !showMilestones && state.social?.visibilityChosen === false;
  const showEcho = idle && !showMilestones && !askVisibility && !!hint && hintKey !== echoDismissed && living?.echo.code !== "IDLE";
  const openCodex = (cropCode: string | null) => {
    setCodexCrop(cropCode);
    onPanel("codex");
  };
  const onEcho = (action: EchoAction) => {
    switch (action.kind) {
      case "grove": onSelectLiving({ kind: "grove", slot: action.slot }); break;
      case "pest": onSelectLiving({ kind: "pest", id: action.id }); break;
      case "harvest": if (readyIds.length) { onPanel(null); setHarvestIds(readyIds.slice(0, HARVEST_BATCH)); } break;
      case "orders": onPanel("orders"); break;
      case "milestones": onPanel(null); break;
      case "codex": openCodex(living?.collection.crops.find((c) => c.skins.some((s) => s.code === action.skinCode))?.cropCode ?? null); break;
      case "route": void goTo(action.route); break;
      case "monument": onPanel("monument"); break;
    }
  };
  const pest = selectedLiving?.kind === "pest" ? state.pests.find((p) => p.id === selectedLiving.id) ?? null : null;

  return (
    <div className="pointer-events-none absolute inset-0 z-30" data-testid="garden-overlay">
      <style>{`@keyframes eg-pop{0%{opacity:0;transform:scale(.4)}60%{opacity:1;transform:scale(1.12)}100%{transform:none}}
@keyframes eg-ribbon{0%{opacity:0;transform:scaleX(.2)}100%{opacity:1;transform:none}}
@keyframes eg-toast{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}`}</style>
      <div ref={flyLayer} aria-hidden />

      {/* toasts */}
      <div className="absolute inset-x-0 top-[calc(env(safe-area-inset-top,0px)+7.5rem)] flex flex-col items-center gap-2 px-4 sm:top-[calc(env(safe-area-inset-top,0px)+5.5rem)]" aria-live="polite" role="status">
        {game.toasts.map((t) => (
          <div key={t.id} data-testid={`garden-toast-${t.tone}`}
            className={`${PANEL} max-w-sm rounded-[16px_13px_16px_14px] px-3.5 py-2 text-[13px] font-semibold motion-safe:animate-[eg-toast_220ms_cubic-bezier(0.22,1,0.36,1)] ${t.tone === "error" ? "border-[#F2777A]/40 text-[#ffd3d4]" : "text-[#EEF3FF]"}`}>
            {t.text}
          </div>
        ))}
      </div>

      {/* Kho + harvest-all (clear of the centred dock) */}
      <div className="absolute bottom-[calc(env(safe-area-inset-bottom,0px)+4.75rem)] left-3 flex sm:bottom-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
        {/* Phase 3G: the one entry to the social islands. Phones: stacked above Kho so the bottom row keeps its width;
            larger screens: last in the row (the coach / Echo hint card owns the space above Kho there). */}
        {state.social && (
          <button
            type="button"
            data-testid="garden-social-btn"
            data-guide="social"
            onClick={() => onPanel(panel === "social" ? null : "social")}
            aria-pressed={panel === "social"}
            aria-label={state.social.unread > 0 ? `Quần đảo bạn bè, ${state.social.unread} hoạt động mới trên đảo của bạn` : "Quần đảo bạn bè"}
            className={`pointer-events-auto ${PANEL} flex h-12 items-center gap-2 rounded-[18px_14px_18px_16px] px-3.5 text-sm font-bold text-[#EEF3FF] transition-transform duration-200 ${EASE} active:scale-[0.96] ${FOCUS_RING} cursor-pointer max-sm:absolute max-sm:bottom-full max-sm:left-0 max-sm:mb-2 sm:order-last sm:ml-2`}
          >
            <Users className="h-4 w-4 text-[#9cefe0]" aria-hidden />
            <span className="max-sm:sr-only">Đảo bạn bè</span>
            {state.social.unread > 0 && (
              <span className="rounded-full bg-[#F2777A] px-1.5 py-0.5 text-[10px] font-black tabular-nums text-white" data-testid="garden-social-unread">{formatNumber(state.social.unread)}</span>
            )}
          </button>
        )}
        <button
          type="button"
          data-testid="garden-inventory-btn"
          data-guide="kho"
          onClick={() => onPanel(panel === "inventory" || panel === "orders" || panel === "market" || panel === "codex" || panel === "animals" ? null : "inventory")}
          aria-pressed={panel === "inventory" || panel === "orders" || panel === "market" || panel === "codex" || panel === "animals"}
          className={`pointer-events-auto ${PANEL} relative flex h-12 items-center gap-2 rounded-[18px_14px_18px_16px] px-3.5 text-sm font-bold text-[#EEF3FF] transition-transform duration-200 ${EASE} active:scale-[0.96] ${FOCUS_RING} cursor-pointer`}
        >
          <Package className="h-4 w-4 text-[#FFD978]" aria-hidden />
          Kho
          {produceCount > 0 && (
            <span className="rounded-full bg-[#F4B63F] px-1.5 py-0.5 text-[10px] font-black tabular-nums text-[#3a2a0a]">{formatNumber(produceCount)}</span>
          )}
        </button>
        <button
          type="button"
          data-testid="garden-sound-toggle"
          aria-pressed={!muted}
          aria-label={muted ? "Bật âm thanh khu vườn" : "Tắt âm thanh khu vườn"}
          title={muted ? "Bật âm thanh" : "Tắt âm thanh"}
          onClick={() => {
            gardenAudio.setMuted(!muted);
            setMuted(!muted);
            if (muted) gardenAudio.play("soft");
          }}
          className={`pointer-events-auto ${PANEL} ml-2 inline-flex h-12 w-12 items-center justify-center rounded-[18px_14px_18px_16px] text-[#EEF3FF]/80 transition-transform duration-200 ${EASE} active:scale-[0.96] ${FOCUS_RING} cursor-pointer`}
        >
          {muted ? <VolumeX className="h-4 w-4" aria-hidden /> : <Volume2 className="h-4 w-4" aria-hidden />}
        </button>
      </div>
      {readyIds.length >= 2 && !harvestIds && (
        <div className="absolute bottom-[calc(env(safe-area-inset-bottom,0px)+4.75rem)] right-3 sm:bottom-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
          <ActionButton tone="reward" className="pointer-events-auto h-12" onClick={() => setHarvestIds(readyIds.slice(0, HARVEST_BATCH))} testId="garden-harvest-all" disabled={game.busy !== null}>
            <Wheat className="h-4 w-4" aria-hidden /> {readyIds.length > HARVEST_BATCH ? `Thu ${HARVEST_BATCH} luống` : `Thu tất cả (${readyIds.length})`}
          </ActionButton>
        </div>
      )}

      {/* learning rewards basket (GDD 04 §6) */}
      {showBasket && (
        <div className="absolute left-3 right-[4.25rem] top-[calc(env(safe-area-inset-top,0px)+7.25rem)] flex justify-center sm:inset-x-3 sm:top-[calc(env(safe-area-inset-top,0px)+5.5rem)]" data-testid="garden-rewards-basket">
          <div className={`pointer-events-auto ${PANEL} w-full max-w-sm rounded-[24px_20px_24px_22px] p-4 motion-safe:animate-[eg-sheet-in_320ms_cubic-bezier(0.22,1,0.36,1)]`}>
            <div className="flex items-center gap-2.5">
              <BrandWhaleIcon variant="clean" size="sm" className="h-9 w-9" />
              <p className="text-sm font-black text-[#EEF3FF]">Echo mang quà học tập tới</p>
            </div>
            <p className="mt-2 text-[13px] text-[#EEF3FF]/85">
              {[state.rewards.reviews > 0 ? `Ôn ${formatNumber(state.rewards.reviews)} lượt thẻ` : null,
                state.rewards.lessons > 0 ? `${formatNumber(state.rewards.lessons)} bài học` : null].filter(Boolean).join(", ")}
              {state.rewards.reviews > 0 || state.rewards.lessons > 0 ? ": " : ""}
              {[state.rewards.water > 0 ? `+${formatNumber(state.rewards.water)} nước` : null,
                state.rewards.fertilizer > 0 ? `+${formatNumber(state.rewards.fertilizer)} phân bón` : null,
                state.rewards.xp > 0 ? `+${formatNumber(state.rewards.xp)} XP` : null].filter(Boolean).join(", ")}
            </p>
            {state.today.goal.done && <p className="mt-1 text-[12px] text-[#FFE7A8]">Bạn đã đạt mục tiêu hôm nay: Phúc Lành Echo đang bật, giá bán ×1,5.</p>}
            <ActionButton tone="care" className="mt-3 w-full" onClick={() => void game.rewardsSeen()} testId="garden-rewards-seen">Đi chăm vườn</ActionButton>
          </div>
        </div>
      )}

      {/* Phase 3B: a verified milestone, shown once (same place as the rewards basket) */}
      {showMilestones && (
        <div className="absolute left-3 right-[4.25rem] top-[calc(env(safe-area-inset-top,0px)+7.25rem)] flex justify-center sm:inset-x-3 sm:top-[calc(env(safe-area-inset-top,0px)+5.5rem)]">
          <MilestoneCard state={state} milestones={unseen} onDone={() => void game.celebrateMilestones(unseen.map((m) => m.id))} />
        </div>
      )}

      {/* Phase 3H: who may find the island — asked once, in plain words, before the island can be listed */}
      {askVisibility && (
        <div className="absolute left-3 right-[4.25rem] top-[calc(env(safe-area-inset-top,0px)+7.25rem)] flex justify-center sm:inset-x-3 sm:top-[calc(env(safe-area-inset-top,0px)+5.5rem)]" data-testid="garden-visibility-choice">
          <div className={`pointer-events-auto ${PANEL} w-full max-w-sm rounded-[24px_20px_24px_22px] p-4 motion-safe:animate-[eg-sheet-in_320ms_cubic-bezier(0.22,1,0.36,1)]`} role="group" aria-labelledby="garden-visibility-title">
            <div className="flex items-center gap-2.5">
              <Users className="h-5 w-5 shrink-0 text-[#9cefe0]" aria-hidden />
              <p id="garden-visibility-title" className="text-sm font-black text-[#EEF3FF]">Mở cửa đảo cho người chơi khác?</p>
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-[#EEF3FF]/85">
              Đảo của bạn đang đóng cửa. Nếu mở cửa, người chơi khác có thể tìm thấy đảo theo tên hiển thị của bạn, ghé thăm để ngắm,
              và lấy tối đa 1/10 một nông sản đã chín (bạn được báo ngay và vẫn thu 9/10 còn lại). Họ không bao giờ thấy email, việc học,
              Kho hay Đồng Echo của bạn.
            </p>
            <p className="mt-1 text-[11px] text-[#EEF3FF]/60">Bạn đổi lại bất cứ lúc nào trong Đảo bạn bè, mục Đảo của tôi.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <ActionButton tone="care" className="flex-1" disabled={game.busy !== null} testId="garden-visibility-open" onClick={() => void game.chooseVisibility("PUBLIC")}>Mở cửa đón khách</ActionButton>
              <ActionButton tone="quiet" className="flex-1" disabled={game.busy !== null} testId="garden-visibility-private" onClick={() => void game.chooseVisibility("PRIVATE")}>Giữ riêng tư</ActionButton>
            </div>
          </div>
        </div>
      )}

      {/* Phase 3B: Echo's one contextual hint (the tutorial coach's place; never together with it) */}
      {showEcho && hint && (
        <div className="absolute left-3 right-[4.25rem] top-[calc(env(safe-area-inset-top,0px)+7.25rem)] sm:right-auto sm:bottom-[calc(env(safe-area-inset-bottom,0px)+4.5rem)] sm:top-auto sm:w-[340px]">
          <EchoHint line={hint} onAct={onEcho} onDismiss={() => setEchoDismissed(hintKey)} />
        </div>
      )}
      {panel === "echo" && !harvestIds && hint && (
        <div className="absolute inset-x-3 bottom-[calc(env(safe-area-inset-bottom,0px)+8.5rem)] flex justify-center sm:bottom-[calc(env(safe-area-inset-bottom,0px)+4.5rem)]">
          <div className="w-full max-w-sm">
            <EchoHint line={hint} onAct={onEcho} onDismiss={() => onPanel(null)} expanded />
          </div>
        </div>
      )}

      {plot && !harvestIds && !panel && (
        <PlotPanel
          state={state}
          plot={plot}
          serverNowMs={serverNow}
          snapshotMs={game.snapshotFor(plot.id)}
          busy={game.busy}
          onClose={onCloseSelection}
          onPlant={(c) => void onPlant(c)}
          onOpenPest={(id) => onSelectLiving({ kind: "pest", id })}
          onBoost={(code) => void onBoost(code)}
          onTreat={(code) => void onTreat(code)}
          onShop={() => onPanel("market")}
          onHarvest={() => plot.planting && setHarvestIds([plot.planting.id])}
        />
      )}
      {panel === "inventory" && !harvestIds && (
        <InventoryPanel state={state} busy={game.busy} onClose={() => onPanel(null)} onSell={(l, f) => void onSell(l, f)} onStudy={() => void goStudy()} onTab={onTab}
          onSellShares={(lines) => void game.sellShares(lines)} />
      )}
      {panel === "animals" && !harvestIds && (
        <AnimalsPanel game={game} focus={animalFocus} onClose={() => onPanel(null)} onTab={onTab} onMarket={() => onPanel("market")} />
      )}
      {panel === "orders" && !harvestIds && <OrdersPanel game={game} onClose={() => onPanel(null)} onTab={onTab} />}
      {panel === "market" && !harvestIds && <MarketPanel game={game} onClose={() => onPanel(null)} onTab={onTab} onStall={() => onPanel("stall")} onCosmetics={() => onPanel("cosmetics")} onEchoRewards={() => onPanel("echoRewards")} />}
      {panel === "echoRewards" && !harvestIds && <EchoRewardsPanel game={game} onClose={() => onPanel(null)} onBackToMarket={() => onPanel("market")} />}
      {panel === "cosmetics" && !harvestIds && !placing && (
        <CosmeticShopPanel game={game} onClose={() => onPanel(null)} onBackToMarket={() => onPanel("market")}
          onTryOn={(t) => onTryOn?.(t)} onPlace={(p) => onPlacing?.(p)} hidden={tryOn !== null} />
      )}
      {tryOn && !harvestIds && <TryOnBar tryOn={tryOn} game={game} onBack={() => onTryOn?.(null)} />}
      {placing && !harvestIds && (
        <PlacementBar placing={placing} candidate={placementCandidate ?? null} busy={game.busy !== null}
          onConfirm={() => onConfirmPlacement?.()} onCancel={() => onPlacing?.(null)} />
      )}
      {selectedDecorView && !placing && !harvestIds && (
        <DecorCard decor={selectedDecorView} game={game} onClose={onCloseSelection} onMove={(p) => onPlacing?.(p)} />
      )}
      {panel === "cottage" && !harvestIds && <BuildingPanel game={game} code="COTTAGE" onClose={() => onPanel(null)} onOpenMarket={() => onPanel("market")} />}
      {panel === "warehouse" && !harvestIds && <BuildingPanel game={game} code="WAREHOUSE" onClose={() => onPanel(null)} onOpenMarket={() => onPanel("market")} />}
      {panel === "stall" && !harvestIds && <BuildingPanel game={game} code="MARKET" onClose={() => onPanel(null)} onOpenMarket={() => onPanel("market")} />}
      {panel === "rewards" && !harvestIds && <RewardsPanel game={game} onClose={() => onPanel(null)} />}
      {!panel && !plot && !harvestIds && selectedLand !== null && <LandPanel game={game} slot={selectedLand} onClose={onCloseSelection} />}
      {!panel && !plot && !harvestIds && selectedExpansion !== null && (
        <ExpansionPanel game={game} slot={selectedExpansion} onClose={onCloseSelection} />
      )}
      {panel === "help" && !harvestIds && <HelpPanel guide={guide} onClose={() => onPanel(null)} />}
      {panel === "season" && !harvestIds && <SeasonPanel state={state} serverNowMs={serverNow} onClose={() => onPanel(null)} />}
      {panel === "learning" && !harvestIds && <LearningPanel state={state} onClose={() => onPanel(null)} onStudy={() => void goStudy()} />}
      {panel === "forest" && !harvestIds && <ForestPanel game={game} onClose={() => onPanel(null)} />}
      {panel === "codex" && !harvestIds && <CodexPanel game={game} onClose={() => onPanel(null)} onTab={onTab} initialCrop={codexCrop} />}
      {panel === "monument" && !harvestIds && (
        <MonumentPanel game={game} onClose={() => onPanel(null)} onGrove={() => onPanel("grove")} onForest={() => onPanel("forest")}
          onCodex={() => openCodex(null)} onGo={(route) => void goTo(route)} onRewards={() => onPanel("rewards")} />
      )}
      {panel === "grove" && !harvestIds && (
        <KnowledgePanel game={game} initialSlot={null} onClose={() => onPanel(null)} onOpenForest={() => onPanel("forest")} />
      )}
      {!panel && !plot && !harvestIds && selectedLiving?.kind === "grove" && (
        <KnowledgePanel game={game} initialSlot={selectedLiving.slot} onClose={onCloseSelection} onOpenForest={() => onPanel("forest")} />
      )}
      {!panel && !plot && !harvestIds && pest && <PestPanel game={game} pest={pest} onClose={onCloseSelection} />}
      {harvestIds && (
        <HarvestFlow
          state={state}
          plantingIds={harvestIds}
          reducedMotion={reducedMotion}
          start={game.harvestStart}
          complete={game.harvestComplete}
          onDone={onHarvestDone}
        />
      )}
    </div>
  );
}
