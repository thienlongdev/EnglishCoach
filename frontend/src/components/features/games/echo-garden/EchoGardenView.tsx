"use client";

import React, { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import dynamic from "next/dynamic";
import { EchoGardenHUD } from "./EchoGardenHUD";
import type { TimeOfDay, InspectableTarget, FarmSceneApi, GardenSceneApi, PlacementCandidate } from "./EchoGardenCanvas";
import type { Placing, TryOn } from "./game/CosmeticPanels";
import { COSMETIC_FOCUS } from "./game/gardenModel";
import { TARGETS } from "./world/echoGardenTargets";
import { useEchoGarden } from "./game/useEchoGarden";
import { GardenStatus } from "./game/GardenStatus";
import { GardenOverlay, type GardenPanel, type LivingSelection } from "./game/GardenOverlay";
import { gardenAudio } from "./game/gardenAudio";
import { ActionButton, PANEL } from "./game/gardenUi";
import { useEchoGardenGame } from "./EchoGardenGameShell";
import { useGardenSocial } from "./game/useGardenSocial";
import { SocialPanel, VisitOverlay, VisitStatus, type SocialTab } from "./game/SocialPanels";
import { CloudReveal } from "./game/CloudReveal";
import { readRevealPref, revealCovers, revealFinished, revealInitial, revealNext, type RevealEvent, type RevealPhase } from "./game/entryReveal";
import { useGardenGuide } from "./game/guide/useGardenGuide";
import { GuideLayer } from "./game/guide/GuideLayer";

// Lazy-load PixiJS canvas only inside Echo Garden route, no SSR
const DynamicEchoGardenCanvas = dynamic(
  () => import("./EchoGardenCanvas").then((mod) => mod.EchoGardenCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full min-h-[500px] flex-col items-center justify-center bg-[#0c142b] text-[#EEF3FF]">
        <p className="text-sm font-semibold text-[#EEF3FF]/90">Đang khởi tạo Đảo Ký Ức…</p>
        <p className="mt-1 text-xs text-[#EEF3FF]/60">Nạp cảnh quan 2.5D và linh vật Echo</p>
      </div>
    ),
  }
);

const ZOOM_STEP = 1.3;

/**
 * Echo Garden view. `GET /api/v1/garden/access` decides the mode: without access the approved visual preview renders
 * unchanged; with access the same world becomes the playable farm (the server state drives the beds, the HUD shows
 * the player's status and the gameplay overlay owns plot actions, harvest, Kho and the tutorial).
 */
export function EchoGardenView() {
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDay>("day");
  const [selectedTarget, setSelectedTarget] = useState<InspectableTarget | null>(null);
  // zoom relative to the whole-island framing (1 = fit); the canvas reports the live value
  const [cameraZoom, setCameraZoom] = useState(1);
  const [resetSignal, setResetSignal] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [panel, setPanel] = useState<GardenPanel>(null);
  const [farmApi, setFarmApi] = useState<FarmSceneApi | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ id: string; n: number } | null>(null);
  // Phase 3E: an appearance tried on (shown on the island, never saved), a decoration being placed or moved and the
  // point the player chose for it (judged by the scene with the server's rule; the server decides on confirm)
  const [tryOn, setTryOn] = useState<TryOn | null>(null);
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [candidate, setCandidate] = useState<PlacementCandidate | null>(null);
  const game = useEchoGarden();
  const playing = game.phase === "ready" && game.state !== null;
  // Phase 3G: the social islands. While `social.island` is set the same scene shows ANOTHER player's island, read-only:
  // none of the owner's panels exist in that mode — only the visitor layer (the way home and "Lấy một ít").
  const social = useGardenSocial(game);
  const visiting = playing && social.island !== null;
  /** the player's own garden is on screen and playable */
  const home = playing && !visiting;
  const [socialTab, setSocialTab] = useState<SocialTab>("discover");

  /*
   * The cloud reveal of THIS entry into the game. This view is mounted once per entry (Games Hub → Echo Garden, or a
   * direct visit) and stays mounted through every panel, island visit, state refresh and tab switch, so the reveal can
   * play once per entry and never again inside it. Decided before the first paint on the device (never on the server).
   */
  const [reveal, setReveal] = useState<RevealPhase | null>(null);
  useLayoutEffect(() => {
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setReveal(revealInitial({ enabled: readRevealPref(), reducedMotion: reduced }));
  }, []);
  const revealEvent = useCallback((event: RevealEvent) => setReveal((p) => (p ? revealNext(p, event) : p)), []);
  /** the real island has drawn its first frame (reported by the scene); the clouds part only then */
  const [sceneDrawn, setSceneDrawn] = useState(false);
  const [sceneApi, setSceneApi] = useState<GardenSceneApi | null>(null);
  const handleSceneStatus = useCallback((status: "ready" | "failed") => {
    if (status === "ready") setSceneDrawn(true);
    else revealEvent("failed");
  }, [revealEvent]);
  useEffect(() => {
    if (game.phase === "error") revealEvent("failed");
  }, [game.phase, revealEvent]);
  useEffect(() => {
    if (!sceneDrawn || reveal !== "covered") return;
    let raf = 0;
    // two frames after the scene reported: the island is on the glass before the first cloud moves; a tab in the
    // background waits (nothing plays behind the player's back)
    const open = () => {
      if (document.visibilityState !== "visible") return;
      raf = window.requestAnimationFrame(() => {
        raf = window.requestAnimationFrame(() => revealEvent("ready"));
      });
    };
    open();
    document.addEventListener("visibilitychange", open);
    return () => {
      window.cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", open);
    };
  }, [sceneDrawn, reveal, revealEvent]);
  useEffect(() => {
    if (reveal !== "opening") return;
    const onHide = () => {
      if (document.visibilityState !== "visible") revealEvent("hidden");
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [reveal, revealEvent]);

  useEffect(() => () => gardenAudio.close(), []);

  // a notification about island activity links here with ?social=activity: open the record once the garden is ready
  const deepLinked = useRef(false);
  useEffect(() => {
    if (!playing || deepLinked.current || typeof window === "undefined") return;
    deepLinked.current = true;
    if (new URLSearchParams(window.location.search).get("social") === "activity" && game.state?.social) {
      setSocialTab("activity");
      setPanel("social");
    }
  }, [playing, game.state]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);

  const handleResetCamera = useCallback(() => {
    setSelectedTarget(null);
    setResetSignal((n) => n + 1);
  }, []);

  const handleCloseInspect = useCallback(() => {
    setSelectedTarget(null);
  }, []);

  const handleQuickFocus = useCallback((targetId: string) => {
    const target = TARGETS[targetId];
    if (target) setSelectedTarget(target);
  }, []);

  const handleZoom = useCallback((direction: "in" | "out") => {
    setCameraZoom((z) => (direction === "in" ? z * ZOOM_STEP : z / ZOOM_STEP));
  }, []);

  const handleSelect = useCallback((target: InspectableTarget | null) => {
    setSelectedTarget(target);
    if (target) setPanel(null);
  }, []);

  const handlePanel = useCallback((next: GardenPanel) => {
    setPanel(next);
    setSelectedTarget(null);
    // a try-on belongs to the open shop: leaving the shop takes the island back to what the server says it wears
    if (next !== "cosmetics") setTryOn(null);
  }, []);

  const handleTryOn = useCallback((t: TryOn | null) => {
    setTryOn(t);
    if (t) {
      setSelectedTarget(null);
      const id = COSMETIC_FOCUS[t.item.category];
      if (id) setFocusRequest((r) => ({ id, n: (r?.n ?? 0) + 1 }));
    }
  }, []);

  const handlePlacing = useCallback((p: Placing | null) => {
    setPlacing(p);
    setCandidate(null);
    if (p) {
      setPanel(null);
      setSelectedTarget(null);
    }
  }, []);

  // one object per placement (the scene re-enters placement mode only when the decoration changes)
  const placement = useMemo(
    () => (placing ? { art: placing.artKey, footprint: placing.footprint, movingId: placing.moving?.id ?? null } : null),
    [placing],
  );
  const { placeDecor, moveDecor } = game;
  const handleConfirmPlacement = useCallback(async () => {
    if (!placing || !candidate?.ok) return;
    const done = placing.moving ? await moveDecor(placing.moving, candidate.gx, candidate.gy) : await placeDecor(placing.code, candidate.gx, candidate.gy);
    if (done) {
      setPlacing(null);
      setCandidate(null);
    }
  }, [placing, candidate, placeDecor, moveDecor]);

  const { visit: visitIsland, leave: leaveIsland } = social;
  /** Travel to an open island: every panel, try-on and placement of the player's own garden is put away first. */
  const handleVisit = useCallback(async (handle: string) => {
    const island = await visitIsland(handle);
    if (!island) return;
    setPanel(null);
    setSelectedTarget(null);
    setTryOn(null);
    setPlacing(null);
    setCandidate(null);
    setResetSignal((n) => n + 1);
  }, [visitIsland]);

  const handleHome = useCallback(() => {
    leaveIsland();
    setPanel(null);
    setSelectedTarget(null);
    setResetSignal((n) => n + 1);
  }, [leaveIsland]);

  const handleSelectLiving = useCallback((sel: LivingSelection) => {
    if (!sel) return;
    setPanel(null);
    setSelectedTarget(sel.kind === "pest"
      ? { id: `pest_${sel.id}`, type: "pest", title: "Sâu Lãng Quên", subtitle: "", description: "" }
      : { id: `grove_${sel.slot ?? 1}`, type: "tree", title: "Cây Ký Ức", subtitle: "", description: "" });
  }, []);

  const plotSlot = home && selectedTarget?.id.startsWith("plot_") ? Number(selectedTarget.id.slice(5)) : null;
  // Phase 3G: on a visited island a bed opens the visitor's card; every other selection only moves the camera
  const visitSlot = visiting && selectedTarget?.id.startsWith("plot_") ? Number(selectedTarget.id.slice(5)) : null;
  // Phase 2: in gameplay the grove spots, the Knowledge Tree, pests and the forest open gameplay panels (the camera
  // still focuses on them); the preview keeps its inspect cards
  const sid = selectedTarget?.id ?? "";
  const livingSel: LivingSelection = !home ? null
    : sid.startsWith("grove_") ? { kind: "grove", slot: Number(sid.slice(6)) }
      : sid.startsWith("pest_") ? { kind: "pest", id: Number(sid.slice(5)) }
        : null;
  // Phase 3A: the seed-corner stall opens the market, the signpost the delivery board, a locked bed cell its card
  const expansionSlot = home && sid.startsWith("expand_") ? Number(sid.slice(7)) : null;
  // Phase 3C: a regional bed cell opens its land card; the cottage, the storehouse (shed) and the stall open their building
  const landSlot = home && sid.startsWith("land_") ? Number(sid.slice(5)) : null;
  // Phase 3E: a decoration standing on the island opens its card (move / store)
  const decorId = home && sid.startsWith("decor_") ? Number(sid.slice(6)) : null;
  // what the island wears: the server's facts, plus the appearance being tried on (a presentation override only)
  const serverLook = game.cosmetics;
  const worn = useMemo(
    () => (!home || !serverLook ? null
      : tryOn ? { ...serverLook, equipped: { ...serverLook.equipped, [tryOn.item.category]: tryOn.item.artKey } } : serverLook),
    [home, serverLook, tryOn],
  );
  // Phase 3B: the Knowledge Tree opens its own overview (era, branches, gateway to the grove / forest / codex) and the
  // whale opens Echo's hint
  const worldPanel: GardenPanel = !home ? null
    : sid === "forest_zone" ? "forest" : sid === "market_stall" ? "market" : sid === "prop_signpost" ? "orders"
      : sid === "knowledge_tree" ? "monument" : sid === "echo_whale" ? "echo"
        : sid === "farmhouse" ? "cottage" : sid === "shed" ? "warehouse"
          // Phase 3H: an animal house, its yard or a guardian's post opens the animals sheet
          : sid.startsWith("ahouse_") || sid.startsWith("guardian_") ? "animals" : null;
  const animalFocus = sid.startsWith("ahouse_") ? sid.slice(7) : sid.startsWith("guardian_") ? sid.slice(9) : null;
  const overlayPanel: GardenPanel = panel ?? worldPanel;
  const visit = visiting ? social.visuals : null;

  // Echo's voluntary guide (the server holds its record; the layer points at real controls and real world objects)
  const closePanels = useCallback(() => {
    setPanel(null);
    setSelectedTarget(null);
    setTryOn(null);
  }, []);
  const focusPlace = useCallback((id: string) => setFocusRequest((r) => ({ id, n: (r?.n ?? 0) + 1 })), []);
  const openHelp = useCallback(() => handlePanel("help"), [handlePanel]);
  const guide = useGardenGuide({
    game,
    home,
    ready: reveal !== null && revealFinished(reveal),
    scene: sceneApi,
    panelOpen: panel !== null || selectedTarget !== null,
    openSlot: plotSlot,
    timeOfDay,
    // a shop with real-money checkout, the rewards sheet, a try-on or a placement: the guide never covers them
    sensitive: overlayPanel === "cosmetics" || overlayPanel === "echoRewards" || tryOn !== null || placing !== null,
    closePanels,
    focus: focusPlace,
    goHome: handleResetCamera,
    openHelp,
  });
  // in gameplay the farm district is no longer a preview: describe it with live server facts
  let hudTarget = selectedTarget;
  if (home && selectedTarget?.id === "farm_zone") {
    const plots = game.state!.plots;
    const growing = plots.filter((p) => p.planting && !p.planting.ready).length;
    const ripe = plots.filter((p) => p.planting?.ready).length;
    hudTarget = {
      ...selectedTarget,
      description: `${plots.length}/${game.state!.estate.land.maxPlots} luống gỗ đang canh tác. Chạm vào từng luống để gieo hạt, tưới, bón phân và thu hoạch. Chạm vào ô đất có cọc dây để xem điều kiện mở luống mới; góc hạt giống cạnh cổng là Quầy Chợ Echo, cột chỉ đường giữ bảng giao hàng.`,
      stats: [
        { label: "Đang lớn", value: `${growing} ô` },
        { label: "Đã chín", value: `${ripe} ô` },
        { label: "Còn trống", value: `${plots.length - growing - ripe} ô` },
      ],
    };
  }

  // the clouds of this entry: ONE instance beside whatever the garden shows (loading, error or the island), so no
  // change underneath can restart them
  const clouds = reveal && revealCovers(reveal)
    ? <CloudReveal key="clouds" phase={reveal} timeOfDay={timeOfDay} onOpened={() => revealEvent("opened")} onSkip={() => revealEvent("skip")}
      onGiveUp={() => revealEvent("failed")} />
    : null;

  // gameplay waits for its first authoritative state so the beds never flash the preview fixture
  if (game.phase === "checking" || game.phase === "loading") {
    return <><GardenLoading key="body" text={game.phase === "checking" ? "Đang mở Đảo Ký Ức…" : "Đang tải khu vườn của bạn…"} />{clouds}</>;
  }
  if (game.phase === "error") {
    return <><GardenLoadError key="body" message={game.loadError} onRetry={() => void game.reload()} />{clouds}</>;
  }

  return (
    <>
    <div key="body" id="echo-garden-viewport" className="relative h-[100dvh] w-[100dvw] overflow-hidden bg-[#0c142b]" data-garden-mode={playing ? "play" : "preview"}
      data-garden-reveal={reveal ?? "pending"}>
      {/* PixiJS Interactive Canvas Viewport */}
      {/* Phase 3G: one scene, one renderer. A visit feeds the SAME canvas the other island's picture; the key gives each
          island a fresh world (no bed, building or decoration of one island can linger on another). Season and weather
          are the archipelago's (global, server time). */}
      <DynamicEchoGardenCanvas
        key={visit ? `island-${social.island!.owner.handle}` : "home"}
        timeOfDay={timeOfDay}
        onSelectTarget={handleSelect}
        selectedTargetId={selectedTarget?.id ?? null}
        cameraZoom={cameraZoom}
        onCameraZoomChange={setCameraZoom}
        resetSignal={resetSignal}
        reducedMotion={reducedMotion}
        farm={visit ? visit.farm : playing ? game.visuals : null}
        farmFx={home ? game.fx : undefined}
        onFarmReady={setFarmApi}
        focusRequest={focusRequest}
        season={playing ? game.season : undefined}
        weather={playing ? game.weather : null}
        living={visit ? visit.living : playing ? game.living : null}
        expansionHint={home ? game.expansionHint : null}
        monument={visit ? visit.monument : playing ? game.monument : null}
        estate={visit ? visit.estate : playing ? game.estate : null}
        cosmetics={visit ? visit.cosmetics : worn}
        placement={home ? placement : null}
        onPlacementCandidate={setCandidate}
        animals={visit ? visit.animals : playing ? game.animals : null}
        animalsInteractive={!visit}
        animalCheer={home ? game.animalCheer : null}
        celebration={home ? game.celebration : 0}
        echoAttention={home && !!game.state?.living && game.state.living.echo.code !== "IDLE" && game.state.onboardingStep >= 8}
        onSceneReady={setSceneApi}
        onStatus={handleSceneStatus}
        entryVeil={!(reveal && revealCovers(reveal))}
      />

      {/* Floating HUD & Overlays */}
      <EchoGardenHUD
        timeOfDay={timeOfDay}
        onTimeOfDayChange={setTimeOfDay}
        cameraZoom={cameraZoom}
        onZoom={handleZoom}
        onResetCamera={handleResetCamera}
        selectedTarget={hudTarget}
        onCloseInspect={handleCloseInspect}
        onQuickFocus={handleQuickFocus}
        status={visiting ? <VisitStatus island={social.island!} /> : playing ? (
          <GardenStatus state={game.state!} serverNowMs={game.serverNow()} onSeason={() => handlePanel("season")} onLearning={() => handlePanel("learning")} />
        ) : undefined}
        suppressInspect={visiting || plotSlot !== null || livingSel !== null || expansionSlot !== null || landSlot !== null || worldPanel !== null
          || decorId !== null || placing !== null || tryOn !== null || panel === "social"}
        onHelp={home ? () => handlePanel(panel === "help" ? null : "help") : undefined}
        helpOpen={panel === "help"}
      />
      {/* Phase 3G: the visitor layer replaces the owner's overlay — no owner control is mounted on another island */}
      {visiting && (
        <VisitOverlay
          game={game}
          social={social}
          island={social.island!}
          selectedSlot={panel === "social" ? null : visitSlot}
          onCloseSelection={handleCloseInspect}
          onHome={handleHome}
          onOpenSocial={() => { setSocialTab("discover"); handlePanel(panel === "social" ? null : "social"); }}
        />
      )}
      {playing && panel === "social" && (
        <div className="pointer-events-none absolute inset-0 z-30">
          <SocialPanel game={game} social={social} initialTab={socialTab} onClose={() => { handlePanel(null); setSocialTab("discover"); }}
            onVisit={(h) => void handleVisit(h)} />
        </div>
      )}
      {home && (
        <GardenOverlay
          game={game}
          selectedSlot={plotSlot}
          selectedLiving={livingSel}
          selectedExpansion={expansionSlot}
          selectedLand={landSlot}
          onSelectLiving={handleSelectLiving}
          onCloseSelection={handleCloseInspect}
          onFocusFarm={() => setFocusRequest((r) => ({ id: "farm_zone", n: (r?.n ?? 0) + 1 }))}
          farmApi={farmApi}
          reducedMotion={reducedMotion}
          panel={overlayPanel}
          onPanel={(next) => {
            // unread island activity opens the record first; otherwise discovery
            if (next === "social") setSocialTab((game.state?.social?.unread ?? 0) > 0 ? "activity" : "discover");
            handlePanel(next);
          }}
          selectedDecor={decorId}
          tryOn={tryOn}
          onTryOn={handleTryOn}
          placing={placing}
          onPlacing={handlePlacing}
          placementCandidate={candidate}
          onConfirmPlacement={() => void handleConfirmPlacement()}
          animalFocus={animalFocus}
          guide={guide}
        />
      )}
      {home && <GuideLayer guide={guide} />}
    </div>
    {clouds}
    </>
  );
}

function GardenLoading({ text }: { text: string }) {
  return (
    <div className="flex h-[100dvh] w-[100dvw] flex-col items-center justify-center bg-[#0c142b] text-[#EEF3FF]" aria-busy="true" data-testid="garden-loading">
      <p className="text-sm font-semibold text-[#EEF3FF]/90">{text}</p>
      <div className="mt-3 h-1.5 w-48 overflow-hidden rounded-full bg-white/10">
        <div className="h-full w-1/3 rounded-full bg-gradient-to-r from-[#74C98B] to-[#F4B63F] motion-safe:animate-pulse" />
      </div>
    </div>
  );
}

function GardenLoadError({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  const { requestExit } = useEchoGardenGame();
  return (
    <div className="flex h-[100dvh] w-[100dvw] items-center justify-center bg-[#0c142b] px-5" data-testid="garden-load-error">
      <div className={`${PANEL} w-full max-w-sm rounded-[26px_22px_28px_24px] p-5 text-center`} role="alert">
        <p className="text-base font-black text-[#EEF3FF]">Chưa mở được khu vườn</p>
        <p className="mt-2 text-[13px] leading-relaxed text-[#EEF3FF]/75">{message ?? "Máy chủ đang bận, hãy thử lại sau ít phút."} Khu vườn của bạn vẫn được lưu an toàn trên máy chủ.</p>
        <div className="mt-4 flex justify-center gap-2">
          <ActionButton tone="care" onClick={onRetry} testId="garden-retry">Thử lại</ActionButton>
          <ActionButton tone="quiet" onClick={requestExit}>Thoát</ActionButton>
        </div>
      </div>
    </div>
  );
}
