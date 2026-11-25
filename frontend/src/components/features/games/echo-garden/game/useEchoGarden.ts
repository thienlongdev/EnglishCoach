"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gardenApi, newGardenKey, reviewFlashcard } from "@/services/gardenApi";
import type {
  GardenCosmeticItem, GardenCosmeticShop, GardenCosmeticSlot, GardenCosmeticState, GardenDecor,
  GardenBuilding, GardenCollection, GardenCrop, GardenExpansionPlot, GardenGraduationChallenge, GardenGraduationResult,
  GardenHarvestChallenge, GardenHarvestResult, GardenKnowledge, GardenLandPlot, GardenOffer, GardenOrder, GardenPest, GardenPlanting,
  GardenPlot, GardenRecipe, GardenReward, GardenSellLine, GardenSkin, GardenState, GardenSupply,
  GardenAnimalReceipt, GardenTier, GardenVisibility, GardenAdminQaStatus, GardenGuide, GardenGuideAction,
} from "@/types/garden";
import type { AnimalVisuals } from "../world/animalLayer";
import type { EstateVisuals } from "../EchoGardenCanvas";
import type { MonumentVisuals } from "../world/monumentLayer";
import type { FarmFxEvent } from "../EchoGardenCanvas";
import type { FarmFxKind } from "../world/farmLayer";
import type { LivingVisuals } from "../world/livingLayer";
import type { CosmeticVisuals } from "../world/cosmetics";
import { BUILDING_INFO, SEASON_OF_THEME, animalVisuals, errorMessage, formatNumber, itemLabel, plotVisuals, retryable, serverOffsetMs, type PlotVisual } from "./gardenModel";
import { gardenAudio } from "./gardenAudio";

/**
 * Client side of the farming loop. The server owns every number; this hook only (1) keeps a time offset to the
 * server clock, (2) refreshes the state on entry, on focus, every 3 minutes while visible and when a countdown ends
 * (never declaring a crop ripe by itself), (3) sends commands with ONE idempotency key per player action, retried
 * with that same key on network / 5xx failures, and (4) shows plant / care optimistically, rolling back on rejection.
 * A response older than a later mutation is ignored ("latest wins"), so the world never keeps a stale state.
 */

export type GardenPhase = "checking" | "preview" | "loading" | "ready" | "error";

export interface GardenToast {
  id: number;
  tone: "ok" | "error" | "info";
  text: string;
}

interface CommandError {
  status?: number;
  code?: string;
  details?: Record<string, unknown>;
}

const POLL_MS = 3 * 60 * 1000;

function asCommandError(e: unknown): CommandError {
  const r = (e as { response?: { status?: number; data?: { code?: string; details?: Record<string, unknown> } } })?.response;
  if (!r) return { code: "NETWORK" };
  return { status: r.status, code: r.data?.code, details: r.data?.details };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Where a pest sits, for a sentence ("luống #3" / "gốc Cây Ký Ức"). */
const pestPlace = (p: GardenPest) => (p.host === "CROP" ? `luống #${p.plotSlot ?? "?"}` : "gốc Cây Ký Ức");

/** The skin a new planting of this crop will take (the equipped one), from the server's collection. */
function equippedSkin(state: GardenState, cropCode: string): GardenSkin | null {
  return state.living?.collection.crops.find((c) => c.cropCode === cropCode)?.skins.find((s) => s.equipped) ?? null;
}

export function useEchoGarden() {
  const [phase, setPhase] = useState<GardenPhase>("checking");
  const [state, setState] = useState<GardenState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toasts, setToasts] = useState<GardenToast[]>([]);
  const [fx, setFx] = useState<FarmFxEvent[]>([]);
  const [tick, setTick] = useState(0);
  /** Phase 3B: each increment plays one milestone celebration in the scene (tree motes + Echo's cheer) */
  const [celebration, setCelebration] = useState(0);
  /** Phase 3E: the cosmetic shop (catalogue + this player's ownership), fetched when the shop is opened */
  const [shop, setShop] = useState<GardenCosmeticShop | null>(null);
  /** Phase 4: the official administrator's QA access (null for every other account: nothing is fetched or shown) */
  const [adminQa, setAdminQa] = useState<GardenAdminQaStatus | null>(null);

  const offset = useRef(0);
  const stateSnap = useRef(0);
  const plotSnap = useRef(new Map<number, number>());
  const seq = useRef(0);
  const ids = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const serverNow = useCallback(() => Date.now() + offset.current, []);

  const toast = useCallback((tone: GardenToast["tone"], text: string) => {
    const id = ++ids.current;
    // the same sentence twice in a row (e.g. a failed command and its follow-up refresh) is shown once
    setToasts((t) => (t.some((x) => x.text === text) ? t : [...t.slice(-2), { id, tone, text }]));
    window.setTimeout(() => alive.current && setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 4500 : 3200);
  }, []);

  const playFx = useCallback((kind: FarmFxKind, slot: number) => {
    const id = ++ids.current;
    setFx((list) => [...list.slice(-8), { id, kind, slot }]);
  }, []);

  /** Full authoritative state; a load overtaken by a later mutation is dropped. */
  const fetchState = useCallback(async (initial = false) => {
    const mine = ++seq.current;
    const sent = Date.now();
    try {
      const s = await gardenApi.state();
      if (!alive.current || mine !== seq.current) return;
      offset.current = serverOffsetMs(s.serverNow, sent, Date.now());
      stateSnap.current = Date.parse(s.serverNow);
      plotSnap.current.clear();
      setState(s);
      setPhase("ready");
      setLoadError(null);
    } catch (e) {
      if (!alive.current) return;
      const err = asCommandError(e);
      if (err.status === 404) {
        setPhase("preview");
        return;
      }
      if (initial) {
        // the access check answered first and already chose the preview (signed out, garden closed)
        if (previewOnly.current) return;
        setLoadError(errorMessage(err.code));
        setPhase("error");
      } else {
        toast("error", errorMessage(err.code));
      }
    }
  }, [toast]);

  /**
   * At most ONE state request in flight per client, plus at most one waiting behind it (Phase 4). A state read is the
   * garden's heaviest request, and a tab that regains focus fires `focus` AND `visibilitychange`, a burst of commands
   * each asks for a refresh: those used to run side by side on the server, each holding a database connection (the
   * second one merely waiting for the first one's lock). A caller that arrives while a read is in flight gets the
   * promise of the NEXT read, i.e. one that started after its own change.
   */
  const loading = useRef(false);
  const waiting = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  const loadRef = useRef<(initial?: boolean) => Promise<void>>(async () => undefined);
  const load = useCallback((initial = false): Promise<void> => {
    if (loading.current) {
      if (!waiting.current) {
        let resolve: () => void = () => undefined;
        const promise = new Promise<void>((r) => (resolve = r));
        waiting.current = { promise, resolve };
      }
      return waiting.current.promise;
    }
    loading.current = true;
    return fetchState(initial).finally(() => {
      loading.current = false;
      const next = waiting.current;
      if (!next) return;
      waiting.current = null;
      if (alive.current) void loadRef.current().then(next.resolve);
      else next.resolve();
    });
  }, [fetchState]);
  loadRef.current = load;

  // access and the first state are asked for together (Phase 5): the state no longer waits a whole request for the
  // access answer. A closed garden answers the state with 404 and a signed-out visitor with 401; both end in the preview.
  const previewOnly = useRef(false);
  useEffect(() => {
    let cancelled = false;
    previewOnly.current = false;
    void load(true);
    gardenApi.access()
      .then((a) => {
        if (cancelled) return;
        if (a.enabled) {
          setPhase((p) => (p === "checking" ? "loading" : p));
          // the server says who the administrator is; the QA status is read only then
          if (a.adminQa) gardenApi.adminQaStatus().then((s) => !cancelled && setAdminQa(s)).catch(() => undefined);
        } else {
          previewOnly.current = true;
          setPhase("preview");
        }
      })
      .catch(() => {
        if (cancelled) return;
        previewOnly.current = true;
        setPhase((p) => (p === "ready" ? p : "preview"));
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  // 1 Hz presentation clock (countdowns, stage projection) — only while playing
  useEffect(() => {
    if (phase !== "ready") return;
    // a hidden tab shows no countdown: no re-render of the garden once a second behind the player's back
    const id = window.setInterval(() => document.visibilityState === "visible" && setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  // refresh on focus / visibility and every 3 minutes while the tab is visible
  useEffect(() => {
    if (phase !== "ready") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [phase, load]);

  const snapshotFor = useCallback((plotId: number) => plotSnap.current.get(plotId) ?? stateSnap.current, []);

  // when the nearest countdown ends, ask the server once (the client never ripens a crop by itself)
  useEffect(() => {
    if (!state) return;
    let due = Infinity;
    for (const p of state.plots) {
      if (!p.planting || p.planting.ready) continue;
      due = Math.min(due, snapshotFor(p.id) + p.planting.remainingSeconds * 1000);
    }
    if (!Number.isFinite(due)) return;
    const wait = Math.max(500, due - serverNow() + 400);
    if (wait > 2 ** 31 - 1) return;
    const id = window.setTimeout(() => void load(), wait);
    return () => window.clearTimeout(id);
  }, [state, load, serverNow, snapshotFor]);

  const visuals: PlotVisual[] | null = useMemo(
    () => (state ? plotVisuals(state, serverNow(), snapshotFor) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, tick],
  );

  /** Phase 2 scene visuals (server facts only): grove, forest, pests; season + weather of the island. */
  const living: LivingVisuals | null = useMemo(() => {
    if (!state?.knowledge) return null;
    const treeSlot = new Map<number, number>();
    state.knowledge.slots.forEach((s) => s.tree && treeSlot.set(s.tree.id, s.slot));
    return {
      grove: state.knowledge.slots.map((s) => ({
        slot: s.slot,
        unlocked: s.unlocked,
        tree: s.tree ? {
          id: s.tree.id, species: s.tree.species, stage: s.tree.stage, health: s.tree.health,
          essenceReady: s.tree.essence.claimable,
        } : null,
      })),
      forest: state.knowledge.forestRecent.map((t) => ({ id: t.id, species: t.species })),
      pests: state.pests.map((p) => ({
        id: p.id, host: p.host, plotSlot: p.plotSlot, treeSlot: p.treeId != null ? treeSlot.get(p.treeId) ?? null : null,
        reviewed: p.reviewed, stage: p.stage ?? 1,
      })),
    };
  }, [state]);
  const season = state ? SEASON_OF_THEME[state.world.theme] : "summer";
  /** Phase 3A: the bed the player can buy right now (level reached), shown as a soft ring on its cell. */
  const expansionHint = useMemo(() => {
    const next = state?.economy?.expansion.plots.find((p) => p.status === "NEXT");
    return next && next.levelOk ? next.slot : null;
  }, [state]);
  const weather = state ? { kind: state.world.weather.kind } : null;
  /**
   * Phase 3C scene facts (server only): the level of each building and every regional bed cell with its state — owned
   * (a bed), next (buyable now: its region is open and it is the next in order) or locked.
   */
  const estate: EstateVisuals | null = useMemo(() => {
    const e = state?.estate;
    if (!e) return null;
    const level = (code: string) => e.buildings.find((b) => b.code === code)?.level ?? 0;
    return {
      buildings: { COTTAGE: level("COTTAGE"), WAREHOUSE: level("WAREHOUSE"), MARKET: level("MARKET") },
      land: e.land.regions.flatMap((r) => r.plots.map((p) => ({
        slot: p.slot,
        state: p.status === "OWNED" ? "owned" as const : r.open && p.status === "NEXT" ? "next" as const : "locked" as const,
      }))),
    };
  }, [state]);

  /** Phase 3H: the animal quarter as scene inputs, and the house / guardian whose animals should hop once. */
  const animals: AnimalVisuals | null = useMemo(() => animalVisuals(state?.animals), [state]);
  const [animalCheer, setAnimalCheer] = useState<{ n: number; target: string } | null>(null);

  // Phase 3C: when a crop's pest is resolved by a real review (or sent away), the bed plays its recovery once
  const pestStages = useRef(new Map<number, number>());
  useEffect(() => {
    if (!state) return;
    const now = new Map<number, number>();
    for (const p of state.plots) if (p.planting?.pestStage != null) now.set(p.slot, p.planting.pestStage);
    for (const [slot, before] of pestStages.current) {
      const after = now.get(slot);
      const stillPlanted = state.plots.some((p) => p.slot === slot && p.planting);
      if (before > 0 && stillPlanted && (after === 0 || after === undefined)) playFx("recover", slot);
    }
    pestStages.current = now;
  }, [state, playFx]);

  // Phase 4: a pest that left while its crop / tree is still there was cured by a review (here or on the Flashcards
  // screen, found by this read): say so once, naming the place and the word, so it is never mistaken for a new pest
  const announcedPests = useRef(new Set<number>());
  const knownPests = useRef(new Map<number, GardenPest>());
  useEffect(() => {
    if (!state) return;
    const live = new Set(state.pests.map((p) => p.id));
    for (const [id, p] of knownPests.current) {
      if (live.has(id)) continue;
      if (announcedPests.current.delete(id)) continue; // the rescue review already said it
      const hostStays = p.host === "CROP"
        ? state.plots.some((x) => x.planting?.id === p.plantingId)
        : state.knowledge.slots.some((s) => s.tree?.id === p.treeId);
      if (hostStays) toast("ok", `Sâu Lãng Quên (từ “${p.word}”) đã rời ${pestPlace(p)}`);
    }
    knownPests.current = new Map(state.pests.map((p) => [p.id, p]));
  }, [state, toast]);
  /** Phase 3E: what the island wears (server facts only): equipped appearances and the decorations that stand. */
  const cosmetics: CosmeticVisuals | null = useMemo(() => {
    const c = state?.cosmetics;
    if (!c) return null;
    return {
      equipped: c.equipped,
      decor: c.decor.map((d) => ({ id: d.id, art: d.artKey, gx: d.gx, gy: d.gy, footprint: d.footprint })),
      regions: c.regions,
      snap: c.snap,
    };
  }, [state]);

  /** Phase 3B: what the monument shows (server facts only): its era and the ornament tier of every family. */
  const monument: MonumentVisuals | null = useMemo(() => {
    const m = state?.living?.monument;
    if (!m) return null;
    const tier = (family: string) => m.branches.find((b) => b.family === family)?.tier ?? 0;
    return {
      era: m.era,
      ornaments: {
        vocabulary: tier("VOCABULARY"), listening: tier("LISTENING"), speaking: tier("SPEAKING"), writing: tier("WRITING"),
        exam: tier("EXAM"), memory: m.memoryTier,
      },
    };
  }, [state]);

  /**
   * One player action: ONE idempotency key, retried with the same key on network / 5xx failures (the server either
   * replays the stored result or executes once). Rejections roll the optimistic change back and explain why.
   */
  const command = useCallback(async <T,>(label: string, call: (key: string) => Promise<T>, rollback?: () => void): Promise<T | null> => {
    const key = newGardenKey();
    setBusy(label);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await call(key);
          seq.current++; // any load started before this mutation is stale now
          return result;
        } catch (e) {
          const err = asCommandError(e);
          if (retryable(err.status) && attempt < 2) {
            await sleep(700 * (attempt + 1));
            continue;
          }
          rollback?.();
          if (err.status === 404 && err.code === "GARDEN_NOT_FOUND") setPhase("preview");
          toast("error", errorMessage(err.code, err.details));
          void load();
          return null;
        }
      }
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [load, toast]);

  const mergePlot = useCallback((plot: GardenPlot, patch?: (s: GardenState) => GardenState) => {
    seq.current++;
    plotSnap.current.set(plot.id, serverNow());
    setState((s) => {
      if (!s) return s;
      const next = { ...s, plots: s.plots.map((p) => (p.id === plot.id ? plot : p)) };
      return patch ? patch(next) : next;
    });
  }, [serverNow]);

  const setSeedQty = (s: GardenState, cropCode: string, qty: number): GardenState => {
    const others = s.inventory.seeds.filter((x) => x.cropCode !== cropCode);
    return { ...s, inventory: { ...s.inventory, seeds: qty > 0 ? [...others, { cropCode, qty }] : others } };
  };

  const plant = useCallback(async (plot: GardenPlot, crop: GardenCrop) => {
    if (!state) return false;
    const before = state;
    const held = state.inventory.seeds.find((x) => x.cropCode === crop.code)?.qty ?? 0;
    const optimistic: GardenPlanting = {
      id: -1, cropCode: crop.code, nameVi: crop.nameVi, plantedAt: new Date(serverNow()).toISOString(), stage: 1, progress: 0,
      ready: false, readyAt: null, requiredSeconds: Math.max(1, crop.growSecondsNow), remainingSeconds: Math.max(1, crop.growSecondsNow),
      speed: 0, waterCount: 0, waterLimit: 3, fertilizer: null, boostFraction: 0, maxBoost: 0.4, seasonFit: crop.seasonFitNow,
      tutorial: false, freshUntil: null, pestId: null,
      // the server snapshots the equipped skin; the optimistic crop already shows it
      skinCode: equippedSkin(state, crop.code)?.code ?? null, skinArt: equippedSkin(state, crop.code)?.artKey ?? null,
    };
    seq.current++;
    setState((s) => {
      if (!s) return s;
      let next: GardenState = { ...s, plots: s.plots.map((p) => (p.id === plot.id ? { ...p, planting: optimistic } : p)) };
      next = held > 0 ? setSeedQty(next, crop.code, held - 1)
        : { ...next, profile: { ...next.profile, coins: Math.max(0, next.profile.coins - crop.seedPrice) } };
      return next;
    });
    playFx("plant", plot.slot);
    gardenAudio.play("plant");
    const r = await command("plant", (key) => gardenApi.plant(plot.id, crop.code, key), () => {
      seq.current++;
      setState(before);
    });
    if (!r) return false;
    mergePlot(r.plot, (s) => setSeedQty({ ...s, profile: { ...s.profile, coins: r.coins } }, crop.code, r.seedsLeft));
    toast("ok", r.coinsPaid > 0 ? `Đã gieo ${crop.nameVi}, −${r.coinsPaid} Đồng Echo` : `Đã gieo ${crop.nameVi}`);
    return true;
  }, [state, command, mergePlot, playFx, serverNow, toast]);

  const boost = useCallback(async (plot: GardenPlot, itemCode: string) => {
    if (!state || !plot.planting) return false;
    const before = state;
    const water = itemCode === "WATER";
    seq.current++;
    setState((s) => {
      if (!s) return s;
      const inv = { ...s.inventory };
      if (itemCode === "WATER") inv.water = Math.max(0, inv.water - 1);
      else if (itemCode === "FERTILIZER") inv.fertilizer = Math.max(0, inv.fertilizer - 1);
      else inv.fertilizerPremium = Math.max(0, inv.fertilizerPremium - 1);
      return {
        ...s,
        inventory: inv,
        plots: s.plots.map((p) => (p.id === plot.id && p.planting
          ? { ...p, planting: { ...p.planting, waterCount: p.planting.waterCount + (water ? 1 : 0), fertilizer: water ? p.planting.fertilizer : itemCode } }
          : p)),
      };
    });
    const r = await command(water ? "water" : "fertilize", (key) => gardenApi.boost(plot.planting!.id, itemCode, key), () => {
      seq.current++;
      setState(before);
    });
    if (!r) return false;
    playFx(water ? "water" : "fertilize", plot.slot);
    gardenAudio.play(water ? "water" : "soft");
    mergePlot(r.plot, (s) => {
      const inv = { ...s.inventory };
      if (r.itemCode === "WATER") inv.water = r.itemLeft;
      else if (r.itemCode === "FERTILIZER") inv.fertilizer = r.itemLeft;
      else inv.fertilizerPremium = r.itemLeft;
      return { ...s, inventory: inv };
    });
    return true;
  }, [state, command, mergePlot, playFx]);

  const harvestStart = useCallback(
    (plantingIds: number[]): Promise<GardenHarvestChallenge | null> =>
      command("harvest", (key) => gardenApi.harvestStart(plantingIds, key)),
    [command],
  );

  const harvestComplete = useCallback(async (challenge: GardenHarvestChallenge, answers: Array<number | null>, skip: boolean): Promise<GardenHarvestResult | null> => {
    const r = await command("harvest", (key) => gardenApi.harvestComplete(challenge.challengeId, answers, skip, key));
    if (!r) return null;
    const slots = new Map((state?.plots ?? []).map((p) => [p.id, p.slot]));
    r.harvests.forEach((h) => {
      const slot = slots.get(h.plotId);
      if (slot) playFx("harvest", slot);
    });
    gardenAudio.play("harvest");
    // let the pop-and-fade play before the authoritative state empties the beds
    window.setTimeout(() => void load(), 450);
    return r;
  }, [command, state, playFx, load]);

  const sell = useCallback(async (lines: GardenSellLine[]) => {
    const r = await command("sell", (key) => gardenApi.sell(lines, key));
    if (!r) return null;
    const count = r.lines.reduce((a, l) => a + l.qty, 0);
    gardenAudio.play("coins");
    toast("ok", `Đã bán ${count} nông sản, +${new Intl.NumberFormat("vi-VN").format(r.coinsGained)} Đồng Echo`);
    await load();
    return r;
  }, [command, toast, load]);

  // ------------------------------------------------------------------ Phase 2: memory, pests

  const setKnowledge = useCallback((k: GardenKnowledge, essence?: number) => {
    seq.current++;
    setState((s) => (s ? { ...s, knowledge: k, profile: essence === undefined ? s.profile : { ...s.profile, essence } } : s));
  }, []);

  const plantTree = useCallback(async (slot: number, flashcardIds: number[]) => {
    const r = await command("tree", (key) => gardenApi.plantTree(slot, flashcardIds, key));
    if (!r) return false;
    setKnowledge(r.knowledge, r.essence);
    gardenAudio.play("plant");
    toast("ok", "Đã trồng Cây Ký Ức. Ôn 5 từ này vào những ngày khác nhau để cây lớn.");
    return true;
  }, [command, setKnowledge, toast]);

  const claimEssence = useCallback(async (treeId: number) => {
    const r = await command("essence", (key) => gardenApi.claimEssence(treeId, key));
    if (!r) return false;
    setKnowledge(r.knowledge, r.essence);
    gardenAudio.play("essence");
    toast("ok", `+${formatNumber(r.claimed)} Tinh chất Ký Ức`);
    return true;
  }, [command, setKnowledge, toast]);

  const releaseTree = useCallback(async (treeId: number) => {
    const r = await command("tree", (key) => gardenApi.releaseTree(treeId, key));
    if (!r) return false;
    setKnowledge(r.knowledge, r.essence);
    toast("info", "Chỗ trồng đã trống, 5 từ đã được thả ra.");
    await load();
    return true;
  }, [command, setKnowledge, toast, load]);

  const graduationStart = useCallback(
    (treeId: number): Promise<GardenGraduationChallenge | null> => command("graduation", (key) => gardenApi.graduationStart(treeId, key)),
    [command],
  );

  const graduationComplete = useCallback(async (challenge: GardenGraduationChallenge, answers: Array<number | null>): Promise<GardenGraduationResult | null> => {
    const r = await command("graduation", (key) => gardenApi.graduationComplete(challenge.challengeId, answers, key));
    if (!r) return null;
    gardenAudio.play(r.passed ? "graduate" : "soft");
    window.setTimeout(() => void load(), 400);
    return r;
  }, [command, load]);

  /**
   * The review is the whole cure: after the Flashcard module recorded it, the server is asked ONCE (one key, retried
   * on network / 5xx) to confirm that this word's pest has left. The server reads its own review log; the client never
   * decides. Returns true when the pest is gone.
   */
  const confirmCure = useCallback(async (pest: GardenPest): Promise<boolean> => {
    const key = newGardenKey();
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await gardenApi.spray(pest.id, key);
        seq.current++; // any load started before the cure is stale now
        announcedPests.current.add(pest.id);
        gardenAudio.play("shoo");
        toast("ok", `Sâu Lãng Quên đã rời ${pestPlace(pest)}${r.rewarded ? `, +${r.xp} XP` : ""}`);
        return true;
      } catch (e) {
        const err = asCommandError(e);
        if (retryable(err.status) && attempt < 2) {
          await sleep(700 * (attempt + 1));
          continue;
        }
        if (err.code === "PEST_GONE") return true; // an earlier read already saw the review: the pest has left
        toast("error", err.code === "PEST_NEEDS_REVIEW"
          ? "Lần ôn vừa rồi chưa được ghi nhận nên Sâu Lãng Quên chưa rời đi. Hãy ôn lại từ này sau ít phút."
          : errorMessage(err.code, err.details));
        return false;
      }
    }
  }, [toast]);

  /**
   * Rescue review: the learner grades the word with the EXISTING Flashcard review (Khó / Tốt / Dễ — each one is a
   * genuine review); the Flashcard module records it and the pest waiting for this word leaves at once. Garden never
   * grades a card itself. Returns true when the review was recorded and no pest of this word is left waiting.
   */
  const rescueReview = useCallback(async (flashcardId: number, quality: "hard" | "good" | "easy") => {
    const pest = state?.pests.find((p) => p.flashcardId === flashcardId) ?? null;
    setBusy("review");
    let cured = true;
    try {
      await reviewFlashcard(flashcardId, quality);
      gardenAudio.play("water");
      if (pest) cured = await confirmCure(pest);
    } catch (e) {
      toast("error", errorMessage(asCommandError(e).code));
      return false;
    } finally {
      if (alive.current) setBusy(null);
    }
    await load();
    return cured;
  }, [state, confirmCure, load, toast]);

  // ------------------------------------------------------------------ Phase 3A: market, delivery board, expansion

  /** Buy `units` of one of today's offers. The server checks the rotation, level, daily cap and coins. */
  const marketBuy = useCallback(async (offer: GardenOffer, units: number) => {
    const r = await command("market", (key) => gardenApi.marketBuy(offer.code, units, key));
    if (!r) return null;
    gardenAudio.play("coins");
    toast("ok", `Đã mua ${offer.kind === "PACK" ? `gói hạt ${offer.nameVi}` : offer.nameVi} ×${units}, −${formatNumber(r.coinsPaid)} Đồng Echo`);
    await load();
    return r;
  }, [command, toast, load]);

  /** Deliver exactly the previewed produce to an order (the server re-checks the frozen requirement). */
  const fillOrder = useCallback(async (order: GardenOrder, lines: GardenSupply[]) => {
    const r = await command("order", (key) => gardenApi.fillOrder(order.id, lines, key));
    if (!r) return null;
    gardenAudio.play("coins");
    toast("ok", `Đã giao đơn, +${formatNumber(r.coinsPaid)} Đồng Echo${r.blessing ? " (Phúc Lành ×1,5)" : ""}`);
    await load();
    return r;
  }, [command, toast, load]);

  /** Open the next bed with the previewed compost; the new bed appears with a sprout puff. */
  const expand = useCallback(async (plot: GardenExpansionPlot) => {
    if (!plot.preview) return null;
    const compost = plot.preview;
    const r = await command("expand", (key) => gardenApi.expand(plot.slot, compost, key));
    if (!r) return null;
    gardenAudio.play("plant");
    toast("ok", `Đã mở luống mới #${r.slot}, −${formatNumber(r.coinsPaid)} Đồng Echo`);
    await load();
    playFx("plant", r.slot);
    return r;
  }, [command, toast, load, playFx]);

  // ------------------------------------------------------------------ Phase 3B: skins, milestones

  const setCollection = useCallback((collection: GardenCollection, coins?: number) => {
    seq.current++;
    setState((s) => (s ? { ...s, living: { ...s.living, collection }, profile: coins === undefined ? s.profile : { ...s.profile, coins } } : s));
  }, []);

  /** Collect an earned skin or buy a coin skin: the server decides which, checks the requirement and charges once. */
  const acquireSkin = useCallback(async (skin: GardenSkin) => {
    const r = await command("skin", (key) => gardenApi.acquireSkin(skin.code, key));
    if (!r) return null;
    gardenAudio.play(r.coinsPaid > 0 ? "coins" : "essence");
    toast("ok", r.coinsPaid > 0 ? `Đã mua giống ${skin.nameVi}, −${formatNumber(r.coinsPaid)} Đồng Echo` : `Đã nhận giống ${skin.nameVi}`);
    setCollection(r.collection, r.coins);
    setCelebration((n) => n + 1);
    await load();
    return r;
  }, [command, toast, setCollection, load]);

  /** Choose the skin future plantings of a crop take (null = the base crop); growing crops keep theirs. */
  const equipSkin = useCallback(async (cropCode: string, skin: GardenSkin | null) => {
    const r = await command("skin", (key) => gardenApi.equipSkin(cropCode, skin?.code ?? null, key));
    if (!r) return false;
    gardenAudio.play("soft");
    toast("ok", skin ? `Từ lần gieo sau, cây sẽ mang giống ${skin.nameVi}` : "Từ lần gieo sau, cây trở về giống gốc");
    setCollection(r.collection);
    return true;
  }, [command, toast, setCollection]);

  /** "Tuyệt vời": the celebration plays once and the milestones are marked seen on the server. */
  const celebrateMilestones = useCallback(async (ids: number[]) => {
    if (!ids.length) return;
    seq.current++;
    setState((s) => (s ? { ...s, living: { ...s.living, monument: { ...s.living.monument, unseen: s.living.monument.unseen.filter((m) => !ids.includes(m.id)) } } } : s));
    setCelebration((n) => n + 1);
    gardenAudio.play("graduate");
    await command("milestones", (key) => gardenApi.milestonesSeen(ids, key));
    await load();
  }, [command, load]);

  // ------------------------------------------------------------------ Phase 3D: farming supplies

  /**
   * Apply one supply from the storehouse to a growing crop. Nothing is optimistic: the server decides whether the item
   * fits (soil, pest, already working) and answers with the plot's new facts.
   */
  const treat = useCallback(async (plot: GardenPlot, itemCode: string) => {
    if (!state || !plot.planting) return false;
    const r = await command("treat", (key) => gardenApi.treat(plot.planting!.id, itemCode, key));
    if (!r) return false;
    const item = state.farming?.items.find((i) => i.code === itemCode);
    playFx(item?.effect === "MOISTURE" ? "water" : item?.effect === "PEST_SPRAY" ? "spray" : "treat", plot.slot);
    gardenAudio.play(item?.effect === "MOISTURE" ? "water" : "soft");
    mergePlot(r.plot, (s) => (s.farming
      ? { ...s, farming: { ...s.farming, items: s.farming.items.map((i) => (i.code === r.itemCode ? { ...i, owned: r.itemQty } : i)) } }
      : s));
    toast("ok", `Đã dùng ${itemLabel(itemCode, state.crops)}`);
    return true;
  }, [state, command, mergePlot, playFx, toast]);

  // ------------------------------------------------------------------ Phase 4: the administrator's QA access

  /** QA on (every cosmetic and cultivar as QA ownership) or off (exactly that ownership goes). The server decides. */
  const qaCosmetics = useCallback(async (on: boolean) => {
    const r = await command("admin-qa", (key) => (on ? gardenApi.adminQaUnlock(key) : gardenApi.adminQaRevoke(key)));
    if (!r) return null;
    setShop(r.shop);
    setAdminQa(r.status);
    toast("ok", on
      ? `Admin QA: đã mở ${formatNumber(r.units)} món và ${formatNumber(r.skins)} giống cây để thử (không trừ Đồng Echo)`
      : `Admin QA: đã thu lại ${formatNumber(r.units)} món và ${formatNumber(r.skins)} giống cây mở thử`);
    await load();
    return r;
  }, [command, toast, load]);

  /** QA animals: `hours` null = build / fill / adopt whatever is missing; a number = that many hours of cared-for time. */
  const qaAnimals = useCallback(async (hours: number | null) => {
    const r = await command("admin-qa", (key) => (hours === null ? gardenApi.adminQaProvision(key) : gardenApi.adminQaAdvance(hours, key)));
    if (!r) return null;
    setState((s) => (s ? { ...s, animals: r.animals } : s));
    toast("ok", r.action === "PROVISION"
      ? `Admin QA: thêm ${r.houses} chuồng, ${r.livestock} vật nuôi, ${r.guardians} bạn canh vườn`
      : `Admin QA: ${r.livestock} vật nuôi đã được chăm thêm ${r.hours} giờ`);
    await load();
    return r;
  }, [command, toast, load]);

  // ------------------------------------------------------------------ Phase 3E: cosmetics

  /** The shop catalogue with this player's ownership and eligibility (read only; called when the shop opens). */
  const loadShop = useCallback(async () => {
    try {
      const s = await gardenApi.cosmetics();
      if (alive.current) setShop(s);
      return s;
    } catch (e) {
      const err = asCommandError(e);
      toast("error", err.code ? errorMessage(err.code, err.details) : "Chưa mở được cửa hàng trang trí. Hãy thử lại.");
      return null;
    }
  }, [toast]);

  const setCosmeticState = useCallback((cs: GardenCosmeticState, coins?: number) => {
    seq.current++;
    setState((s) => (s ? { ...s, cosmetics: cs, profile: coins === undefined ? s.profile : { ...s.profile, coins } } : s));
  }, []);

  /** Buy (coin item) or claim (earned item) one unit: the server decides which, checks the requirement, charges once. */
  const buyCosmetic = useCallback(async (item: GardenCosmeticItem) => {
    const r = await command("cosmetic", (key) => gardenApi.buyCosmetic(item.code, key));
    if (!r) return null;
    gardenAudio.play(r.coinsPaid > 0 ? "coins" : "essence");
    toast("ok", r.coinsPaid > 0 ? `Đã mua ${item.nameVi}, −${formatNumber(r.coinsPaid)} Đồng Echo` : `Đã nhận ${item.nameVi}`);
    setShop(r.shop);
    setCosmeticState(r.shop.state, r.coins);
    setCelebration((n) => n + 1);
    return r;
  }, [command, toast, setCosmeticState]);

  /** Wear an owned appearance in its slot (null = the island's own look). Nothing is consumed. */
  const equipCosmetic = useCallback(async (slot: GardenCosmeticSlot, item: GardenCosmeticItem | null) => {
    const r = await command("cosmetic", (key) => gardenApi.equipCosmetic(slot, item?.code ?? null, key));
    if (!r) return false;
    gardenAudio.play("soft");
    toast("ok", item ? `Đảo đã khoác ${item.nameVi}` : "Đã trở về dáng vẻ gốc của đảo");
    setCosmeticState(r.state);
    setShop((s) => (s ? { ...s, state: r.state, items: s.items.map((i) => (i.category === slot ? { ...i, equipped: i.code === r.code } : i)) } : s));
    return true;
  }, [command, toast, setCosmeticState]);

  const syncShopPlaced = useCallback((cs: GardenCosmeticState) => {
    const placed = new Map<string, number>();
    cs.decor.forEach((d) => placed.set(d.code, (placed.get(d.code) ?? 0) + 1));
    setShop((s) => (s ? { ...s, state: cs, items: s.items.map((i) => (i.category === "DECOR" ? { ...i, placed: placed.get(i.code) ?? 0 } : i)) } : s));
  }, []);

  /** Stand a stored decoration at the chosen point; the server checks the region, the grid and the neighbours. */
  const placeDecor = useCallback(async (code: string, gx: number, gy: number) => {
    const r = await command("decor", (key) => gardenApi.placeDecor(code, gx, gy, key));
    if (!r) return null;
    gardenAudio.play("plant");
    setCosmeticState(r.state);
    syncShopPlaced(r.state);
    return r.decor;
  }, [command, setCosmeticState, syncShopPlaced]);

  const moveDecor = useCallback(async (decor: GardenDecor, gx: number, gy: number) => {
    const r = await command("decor", (key) => gardenApi.moveDecor(decor.id, gx, gy, key));
    if (!r) return null;
    gardenAudio.play("soft");
    setCosmeticState(r.state);
    syncShopPlaced(r.state);
    return r.decor;
  }, [command, setCosmeticState, syncShopPlaced]);

  /** Put a decoration back into storage: it stays owned and can be placed again. */
  const storeDecor = useCallback(async (decor: GardenDecor) => {
    const r = await command("decor", (key) => gardenApi.storeDecor(decor.id, key));
    if (!r) return false;
    gardenAudio.play("soft");
    toast("ok", "Đã cất vật trang trí vào kho");
    setCosmeticState(r.state);
    syncShopPlaced(r.state);
    return true;
  }, [command, toast, setCosmeticState, syncShopPlaced]);

  // ------------------------------------------------------------------ Phase 3F: VND checkout and Echo Rewards

  /** Starts (or returns the open) bank-transfer order of a cosmetic. Nothing is granted here: the server delivers. */
  const startCheckout = useCallback(async (kind: "COSMETIC" | "SKIN", code: string) => {
    return command("checkout", (key) => gardenApi.checkoutCosmetic(kind, code, key));
  }, [command]);

  /** After a verified payment (or a refund) the shop and the island are read again from the server. */
  const refreshAfterPayment = useCallback(async () => {
    await loadShop();
    void load();
  }, [loadShop, load]);

  const cancelCheckout = useCallback(async (orderId: number) => {
    return command("checkout", (key) => gardenApi.cancelCosmeticOrder(orderId, key));
  }, [command]);

  const requestCosmeticRefund = useCallback(async (orderId: number, reason: string) => {
    const r = await command("checkout", (key) => gardenApi.refundCosmeticOrder(orderId, reason, key));
    if (r) toast("ok", "Đã gửi yêu cầu hoàn tiền. Quản trị viên sẽ xử lý và chuyển khoản lại cho bạn.");
    return r;
  }, [command, toast]);

  const setCoins = useCallback((coins: number) => {
    seq.current++;
    setState((s) => (s ? { ...s, profile: { ...s.profile, coins } } : s));
  }, []);

  /** Premium 7 days for Echo Coins: every rule, the budget and the entitlement are the server's. */
  const redeemPremiumReward = useCallback(async () => {
    const r = await command("reward", (key) => gardenApi.redeemPremiumReward(key));
    if (!r) return null;
    gardenAudio.play("essence");
    toast("ok", `Đã đổi Premium 7 ngày, −${formatNumber(r.coinsPaid)} Đồng Echo`);
    setCoins(r.coins);
    setCelebration((n) => n + 1);
    return r;
  }, [command, toast, setCoins]);

  const buyVouchers = useCallback(async (pack: string) => {
    const r = await command("reward", (key) => gardenApi.buyVouchers(pack, key));
    if (!r) return null;
    gardenAudio.play("coins");
    toast("ok", `Đã mua ${r.credits} Phiếu AI, −${formatNumber(r.coinsPaid)} Đồng Echo`);
    setCoins(r.coins);
    return r;
  }, [command, toast, setCoins]);

  const buyFrame = useCallback(async (slug: string, name: string) => {
    const r = await command("reward", (key) => gardenApi.buyFrame(slug, key));
    if (!r) return null;
    gardenAudio.play("coins");
    toast("ok", `Đã mua khung ${name}, −${formatNumber(r.coinsPaid)} Đồng Echo`);
    setCoins(r.coins);
    setCelebration((n) => n + 1);
    return r;
  }, [command, toast, setCoins]);

  // ------------------------------------------------------------------ Phase 3C: buildings, land, compost, rewards

  /** Raise a building one level with the previewed produce (the server re-checks level, coins and produce). */
  const upgradeBuilding = useCallback(async (b: GardenBuilding) => {
    if (!b.next || !b.preview) return null;
    const materials = b.preview;
    const r = await command("building", (key) => gardenApi.upgradeBuilding(b.code, b.next!.level, materials, key));
    if (!r) return null;
    gardenAudio.play("graduate");
    toast("ok", `${BUILDING_INFO[b.code]?.title ?? b.nameVi} lên Cấp ${r.level}, −${formatNumber(r.coinsPaid)} Đồng Echo`);
    setCelebration((n) => n + 1);
    await load();
    return r;
  }, [command, toast, load]);

  /** Open the next bed of a farmland region with the previewed produce; the new bed appears with a sprout puff. */
  const buyLand = useCallback(async (plot: GardenLandPlot) => {
    if (!plot.preview) return null;
    const materials = plot.preview;
    const r = await command("land", (key) => gardenApi.buyLand(plot.slot, materials, key));
    if (!r) return null;
    gardenAudio.play("plant");
    toast("ok", `Đã mở luống mới #${r.slot}, −${formatNumber(r.coinsPaid)} Đồng Echo`);
    await load();
    playFx("plant", r.slot);
    return r;
  }, [command, toast, load, playFx]);

  /** One compost batch at the storehouse: exactly the previewed (cheapest) produce becomes one fertilizer. */
  const compost = useCallback(async (recipe: GardenRecipe) => {
    if (!recipe.preview) return null;
    const lines: GardenSupply[] = recipe.preview;
    const r = await command("compost", (key) => gardenApi.compost(recipe.code, lines, key));
    if (!r) return null;
    gardenAudio.play("soft");
    toast("ok", `Đã ủ xong: +1 ${itemLabel(r.item, state?.crops ?? [])}`);
    await load();
    return r;
  }, [command, toast, load, state]);

  /** Redeem a reward with contribution points: the server checks the counter, eligibility, limits and balance. */
  const redeemReward = useCallback(async (reward: GardenReward) => {
    const r = await command("reward", (key) => gardenApi.redeemReward(reward.code, key));
    if (!r) return null;
    gardenAudio.play("essence");
    toast("ok", `Đã nhận ${reward.nameVi}, −${formatNumber(r.cost)} điểm đóng góp`);
    setCelebration((n) => n + 1);
    await load();
    return r;
  }, [command, toast, load]);

  // ------------------------------------------------------------------ Phase 3H: livestock, guardians, portions

  /**
   * One animal command. The server brings every animal up to its own clock, decides and answers with the whole
   * animals view: the client shows that answer and then reads the garden again (stock and coins are the server's).
   */
  const animalCommand = useCallback(async (label: string, call: (key: string) => Promise<GardenAnimalReceipt>,
    done: (r: GardenAnimalReceipt) => string, cheer?: string, sound: "soft" | "coins" | "harvest" | "water" = "soft") => {
    const r = await command(label, call);
    if (!r) return null;
    setState((s) => (s ? { ...s, animals: r.animals, profile: { ...s.profile, coins: r.coins } } : s));
    if (cheer) setAnimalCheer((c) => ({ n: (c?.n ?? 0) + 1, target: cheer }));
    gardenAudio.play(sound);
    toast("ok", done(r));
    void load();
    return r;
  }, [command, toast, load]);

  const gainText = (r: GardenAnimalReceipt, label: string) => {
    const n = Object.values(r.gained)[0] ?? 0;
    return `+${formatNumber(n)} ${label}`;
  };
  const buildAnimalHouse = useCallback((code: string, name: string) => animalCommand("animal-house",
    (key) => gardenApi.animalBuildHouse(code, key), (r) => `Đã dựng ${name}, −${formatNumber(-r.coinsDelta)} Đồng Echo`, code, "coins"), [animalCommand]);
  const buyAnimal = useCallback((species: string, name: string, cheer: string) => animalCommand("animal-buy",
    (key) => gardenApi.animalBuy(species, key), (r) => `${name} đã về trang trại, −${formatNumber(-r.coinsDelta)} Đồng Echo`, cheer, "coins"), [animalCommand]);
  const feedAnimalHouse = useCallback((code: string) => animalCommand("animal-feed",
    (key) => gardenApi.animalFeedHouse(code, key), () => "Đã cho ăn, các bạn nhỏ đang no bụng", code), [animalCommand]);
  const waterAnimalHouse = useCallback((code: string) => animalCommand("animal-water",
    (key) => gardenApi.animalWaterHouse(code, key), () => "Đã đổ đầy máng nước", code, "water"), [animalCommand]);
  const collectAnimalHouse = useCallback((code: string, productName: string) => animalCommand("animal-collect",
    (key) => gardenApi.animalCollect(code, key), (r) => `Đã thu ${gainText(r, productName)} vào Kho`, code, "harvest"), [animalCommand]);
  const feedGuardian = useCallback((species: string, name: string) => animalCommand("guardian-feed",
    (key) => gardenApi.animalFeedGuardian(species, key), () => `${name} đã no và sẵn sàng làm việc`, species), [animalCommand]);
  const millFeed = useCallback((cropCode: string, tier: GardenTier, qty: number) => animalCommand("feed-mill",
    (key) => gardenApi.animalMill(cropCode, tier, qty, key), (r) => `Đã xay ${gainText(r, "cám")}`), [animalCommand]);
  const sellAnimalProduct = useCallback((code: string, qty: number, name: string) => animalCommand("product-sell",
    (key) => gardenApi.animalSellProduct(code, qty, key), (r) => `Đã bán ${formatNumber(qty)} ${name}, +${formatNumber(r.coinsDelta)} Đồng Echo`, undefined, "coins"), [animalCommand]);
  const compostManure = useCallback((batches: number) => animalCommand("manure-compost",
    (key) => gardenApi.animalCompost(batches, key), (r) => `Đã ủ phân chuồng: ${gainText(r, "Phân bón")}`), [animalCommand]);

  /** Sell harvest portions at their proportional value (the server prices them; never more than the unit). */
  const sellShares = useCallback(async (lines: Array<{ cropCode: string; tier: GardenTier; portions: number }>) => {
    const r = await command("sell-shares", (key) => gardenApi.sellShares(lines, key));
    if (!r) return null;
    gardenAudio.play("coins");
    const portions = r.lines.reduce((a, l) => a + l.qty, 0);
    toast("ok", `Đã bán ${formatNumber(portions)} phần nông sản lẻ, +${formatNumber(r.coinsGained)} Đồng Echo`);
    await load();
    return r;
  }, [command, toast, load]);

  /** The owner's first decision about who may find the island (asked once; changeable later in "Đảo của tôi"). */
  const chooseVisibility = useCallback(async (visibility: GardenVisibility) => {
    const r = await command("visibility", (key) => gardenApi.socialVisibility(visibility, key));
    if (!r) return false;
    setState((s) => (s && s.social ? { ...s, social: { ...s.social, visibility: r.visibility, visibilityChosen: true } } : s));
    toast("ok", visibility === "PUBLIC" ? "Đảo của bạn đã mở cửa đón khách" : "Đảo của bạn được giữ riêng tư");
    return true;
  }, [command, toast]);

  const advanceOnboarding = useCallback(async (step: number) => {
    if (!state || state.onboardingStep >= step) return;
    seq.current++; // a refresh already in flight must not undo this step
    setState((s) => (s ? { ...s, onboardingStep: Math.max(s.onboardingStep, step) } : s));
    const ack = await command("onboarding", (key) => gardenApi.onboarding(step, key));
    if (ack) setState((s) => (s ? { ...s, onboardingStep: Math.max(s.onboardingStep, ack.onboardingStep) } : s));
  }, [state, command]);

  /**
   * The voluntary Echo guide: one decision or step, saved quietly. It never blocks play (no busy flag), is sent in the
   * order it happened (one request at a time) and is retried with the same key; a save that cannot reach the server is
   * dropped without a word, because a guide must never be the reason a player cannot play.
   */
  const guideChain = useRef<Promise<unknown>>(Promise.resolve());
  const guideAction = useCallback((action: GardenGuideAction, step = 0): Promise<GardenGuide | null> => {
    const send = async (): Promise<GardenGuide | null> => {
      const key = newGardenKey();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const ack = await gardenApi.guide(action, step, key);
          if (!alive.current) return ack.guide;
          seq.current++; // a refresh already in flight must not bring the old record back
          setState((s) => (s ? { ...s, guide: ack.guide, onboardingStep: Math.max(s.onboardingStep, ack.onboardingStep) } : s));
          return ack.guide;
        } catch (e) {
          if (!retryable(asCommandError(e).status)) return null;
          await sleep(700 * (attempt + 1));
        }
      }
      return null;
    };
    const next = guideChain.current.then(send, send);
    guideChain.current = next;
    return next;
  }, []);

  const rewardsSeen = useCallback(async () => {
    seq.current++;
    setState((s) => (s ? { ...s, rewards: { ...s.rewards, unseen: false } } : s));
    await command("rewards", (key) => gardenApi.rewardsSeen(key));
  }, [command]);

  return {
    phase, state, loadError, busy, toasts, fx, visuals, tick, living, season, weather, expansionHint, monument, celebration, estate,
    serverNow, snapshotFor, reload: () => load(phase !== "ready"),
    plant, boost, harvestStart, harvestComplete, sell, advanceOnboarding, rewardsSeen, guideAction,
    plantTree, claimEssence, releaseTree, graduationStart, graduationComplete, rescueReview,
    marketBuy, fillOrder, expand, acquireSkin, equipSkin, celebrateMilestones,
    upgradeBuilding, buyLand, compost, redeemReward, treat,
    adminQa, qaCosmetics, qaAnimals,
    cosmetics, shop, loadShop, buyCosmetic, equipCosmetic, placeDecor, moveDecor, storeDecor,
    startCheckout, refreshAfterPayment, cancelCheckout, requestCosmeticRefund, redeemPremiumReward, buyVouchers, buyFrame, notify: toast,
    animals, animalCheer, buildAnimalHouse, buyAnimal, feedAnimalHouse, waterAnimalHouse, collectAnimalHouse, feedGuardian, millFeed,
    sellAnimalProduct, compostManure, sellShares, chooseVisibility,
  };
}

export type EchoGardenGame = ReturnType<typeof useEchoGarden>;
