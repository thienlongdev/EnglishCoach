"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gardenApi, newGardenKey } from "@/services/gardenApi";
import type {
  GardenActivityPage, GardenDiscoverPage, GardenIsland, GardenSocialMe, GardenTakeReceipt, GardenVisibility,
} from "@/types/garden";
import type { EstateVisuals } from "../EchoGardenCanvas";
import type { MonumentVisuals } from "../world/monumentLayer";
import type { LivingVisuals } from "../world/livingLayer";
import type { CosmeticVisuals } from "../world/cosmetics";
import type { AnimalVisuals } from "../world/animalLayer";
import { errorMessage, islandAnimalVisuals, plotVisuals, portionText, retryable, serverOffsetMs, type PlotVisual } from "./gardenModel";
import { gardenAudio } from "./gardenAudio";
import type { EchoGardenGame } from "./useEchoGarden";

/**
 * Client side of the social islands (Phase 3G). The server decides who is listed, what a visitor sees and whether —
 * and how much — may be taken from a ripe crop; this hook only asks, shows the answer and feeds the visited island's
 * picture to the SAME scene the player's own garden uses. A visited island is read-only here by construction: the only
 * command this hook can send about it is "take a little" (and one preset reaction), both named by the island's public
 * handle. While visiting, the picture is refreshed on focus and every 3 minutes — never faster.
 */

const VISIT_REFRESH_MS = 3 * 60 * 1000;

interface ApiError { status?: number; code?: string; details?: Record<string, unknown> }

function apiError(e: unknown): ApiError {
  const r = (e as { response?: { status?: number; data?: { code?: string; details?: Record<string, unknown> } } })?.response;
  if (!r) return { code: "NETWORK" };
  return { status: r.status, code: r.data?.code, details: r.data?.details };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The scene inputs of a visited island (the same shapes the player's own garden produces). */
export interface IslandVisuals {
  farm: PlotVisual[];
  living: LivingVisuals;
  monument: MonumentVisuals;
  estate: EstateVisuals;
  cosmetics: CosmeticVisuals | null;
  animals: AnimalVisuals | null;
}

export function useGardenSocial(game: EchoGardenGame) {
  const [me, setMe] = useState<GardenSocialMe | null>(null);
  const [island, setIsland] = useState<GardenIsland | null>(null);
  const [loadingHandle, setLoadingHandle] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true);
  const offset = useRef(0);
  const snapshot = useRef(0);
  const { notify, tick } = game;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fail = useCallback((e: unknown) => {
    const err = apiError(e);
    notify("error", errorMessage(err.code, err.details));
    return err;
  }, [notify]);

  /** One player action = one idempotency key, retried with the same key on network / 5xx failures. */
  const keyed = useCallback(async <T,>(label: string, call: (key: string) => Promise<T>): Promise<T | null> => {
    const key = newGardenKey();
    setBusy(label);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await call(key);
        } catch (e) {
          const err = apiError(e);
          if (retryable(err.status) && attempt < 2) {
            await sleep(700 * (attempt + 1));
            continue;
          }
          notify("error", errorMessage(err.code, err.details));
          return null;
        }
      }
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [notify]);

  const loadMe = useCallback(async () => {
    try {
      const m = await gardenApi.socialMe();
      if (alive.current) setMe(m);
      return m;
    } catch (e) {
      fail(e);
      return null;
    }
  }, [fail]);

  const setVisibility = useCallback(async (visibility: GardenVisibility) => {
    const m = await keyed("visibility", (key) => gardenApi.socialVisibility(visibility, key));
    if (!m) return null;
    setMe(m);
    notify("ok", visibility === "PUBLIC" ? "Đảo của bạn đã mở cửa đón khách" : "Đảo của bạn đã đóng cửa: không ai tìm thấy hay ghé thăm được");
    return m;
  }, [keyed, notify]);

  const discover = useCallback(async (cursor: string | null, q: string): Promise<GardenDiscoverPage | null> => {
    try {
      return await gardenApi.socialIslands(cursor, q);
    } catch (e) {
      fail(e);
      return null;
    }
  }, [fail]);

  const visited = useCallback(async (): Promise<GardenDiscoverPage | null> => {
    try {
      return await gardenApi.socialVisited();
    } catch (e) {
      fail(e);
      return null;
    }
  }, [fail]);

  const activity = useCallback(async (before: number | null): Promise<GardenActivityPage | null> => {
    try {
      return await gardenApi.socialActivity(before);
    } catch (e) {
      fail(e);
      return null;
    }
  }, [fail]);

  const { reload } = game;
  /** Opening the activity record marks it read on the server; the garden's own state then drops its unread mark. */
  const markSeen = useCallback(async () => {
    const ack = await keyed("seen", (key) => gardenApi.socialActivitySeen(key));
    if (ack) void reload();
  }, [keyed, reload]);

  const applyIsland = useCallback((i: GardenIsland, sentAt: number) => {
    offset.current = serverOffsetMs(i.serverNow, sentAt, Date.now());
    snapshot.current = Date.parse(i.serverNow);
    setIsland(i);
  }, []);

  /** Travel to an open island (the server records the visit and answers with its read-only picture). */
  const visit = useCallback(async (handle: string) => {
    setLoadingHandle(handle);
    const sent = Date.now();
    try {
      const i = await gardenApi.socialIsland(handle);
      if (!alive.current) return null;
      applyIsland(i, sent);
      gardenAudio.play("soft");
      return i;
    } catch (e) {
      fail(e);
      return null;
    } finally {
      if (alive.current) setLoadingHandle(null);
    }
  }, [applyIsland, fail]);

  const leave = useCallback(() => {
    setIsland(null);
    void reload();
  }, [reload]);

  const handle = island?.owner.handle ?? null;
  /** A quiet refresh of the island being visited; an island that closed meanwhile sends the visitor home. */
  const refresh = useCallback(async () => {
    if (!handle) return;
    const sent = Date.now();
    try {
      const i = await gardenApi.socialIsland(handle);
      if (alive.current) applyIsland(i, sent);
    } catch (e) {
      const err = apiError(e);
      if (err.status === 404 && alive.current) {
        notify("info", "Đảo này vừa đóng cửa. Bạn đã trở về đảo của mình.");
        setIsland(null);
      }
    }
  }, [handle, applyIsland, notify]);

  useEffect(() => {
    if (!handle) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const id = window.setInterval(onVisible, VISIT_REFRESH_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [handle, refresh]);

  /** Take a little from one ripe crop: the server validates, records, credits and tells the owner — or refuses. */
  const take = useCallback(async (plantingId: number): Promise<GardenTakeReceipt | null> => {
    if (!handle) return null;
    const r = await keyed("take", (key) => gardenApi.socialTake(handle, plantingId, key));
    // success or refusal, the island is read again: the crop, the limits and the protection are the server's facts
    await refresh();
    if (!r) return null;
    if (r.guarded) {
      // Phase 3H: the island's dog turned this visit away — nothing was taken, no limit was used
      gardenAudio.play("soft");
      notify("info", "Chó canh vườn sủa vang nên lần này bạn chưa lấy được gì. Bạn không mất lượt nào; đảo đang được canh gác một lúc.");
      return r;
    }
    gardenAudio.play("harvest");
    notify("ok", r.unitsMerged > 0
      ? `Bạn đã lấy ${portionText(r.portions, r.unitPortions)} ${r.nameVi} và gom đủ ${r.unitsMerged} nông sản vào Kho`
      : `Bạn đã lấy ${portionText(r.portions, r.unitPortions)} ${r.nameVi}. Hiện có ${r.sharesNow}/${r.unitPortions} phần`);
    return r;
  }, [handle, keyed, refresh, notify]);

  const react = useCallback(async (code: string) => {
    if (!handle) return false;
    const r = await keyed("react", (key) => gardenApi.socialReact(handle, code, key));
    if (!r) return false;
    setIsland((i) => (i ? { ...i, myReaction: r.code, reactionAvailableAt: r.nextAt } : i));
    notify("ok", "Đã gửi lời nhắn tới chủ đảo");
    return true;
  }, [handle, keyed, notify]);

  /** Every regional bed cell of the island map (from the reader's own garden: the map is the same for everyone). */
  const landSlots = useMemo(
    () => game.state?.estate?.land.regions.flatMap((r) => r.plots.map((p) => p.slot)) ?? [],
    [game.state],
  );

  /** The visited island as scene inputs: beds and crops as they stand, buildings, what it wears, monument, grove, forest. */
  const visuals: IslandVisuals | null = useMemo(() => {
    if (!island) return null;
    const now = Date.now() + offset.current;
    const owned = new Set(island.plots.map((p) => p.slot));
    const ornament = (k: string) => island.monument.ornaments[k] ?? 0;
    return {
      farm: plotVisuals(island, now, () => snapshot.current),
      living: {
        grove: [1, 2, 3].map((slot) => {
          const tree = island.grove.find((t) => t.slot === slot);
          return {
            slot,
            unlocked: !!tree,
            tree: tree ? { id: tree.id, species: tree.species, stage: tree.stage, health: "HEALTHY" as const, essenceReady: false } : null,
          };
        }),
        forest: island.forest,
        pests: [],
      },
      monument: {
        era: island.monument.era,
        ornaments: {
          vocabulary: ornament("vocabulary"), listening: ornament("listening"), speaking: ornament("speaking"),
          writing: ornament("writing"), exam: ornament("exam"), memory: ornament("memory"),
        },
      },
      estate: {
        buildings: { COTTAGE: island.buildings.COTTAGE ?? 0, WAREHOUSE: island.buildings.WAREHOUSE ?? 0, MARKET: island.buildings.MARKET ?? 0 },
        // a visitor never sees a "next to buy" cell: a regional cell is a bed or it is closed
        land: landSlots.map((slot) => ({ slot, state: owned.has(slot) ? "owned" as const : "locked" as const })),
      },
      cosmetics: island.cosmetics ? {
        equipped: island.cosmetics.equipped,
        decor: island.cosmetics.decor.map((d) => ({ id: d.id, art: d.artKey, gx: d.gx, gy: d.gy, footprint: d.footprint })),
        regions: island.cosmetics.regions,
        snap: island.cosmetics.snap,
      } : null,
      // Phase 3H: the island's houses and animals (seen, never opened)
      animals: islandAnimalVisuals(island.animals),
    };
    // the 1 Hz presentation clock of the garden also advances a visited island's growth projection
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [island, landSlots, tick]);

  const serverNow = useCallback(() => Date.now() + offset.current, []);

  return {
    me, island, visuals, loadingHandle, busy, serverNow,
    loadMe, setVisibility, discover, visited, activity, markSeen, visit, leave, refresh, take, react,
  };
}

export type GardenSocial = ReturnType<typeof useGardenSocial>;
