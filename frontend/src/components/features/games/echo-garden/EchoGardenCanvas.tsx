"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  Application,
  Assets,
  Container,
  Ellipse,
  Graphics,
  Polygon,
  RendererType,
  Sprite,
  Texture,
  type FederatedPointerEvent,
} from "pixi.js";
// Pixi 8 normally generates shader and uniform code with `new Function`. This module swaps in its prebuilt,
// eval-free implementations, so the game runs under the site's Content-Security-Policy without 'unsafe-eval'.
import "pixi.js/unsafe-eval";
import { ShadowLayer, type ShadowSpec } from "./world/shadowLayer";
import { CameraController } from "./world/cameraController";
import { EchoWhale } from "./world/echoWhale";
import { EchoWhale3D } from "./world/echoWhale3D";
import { PondLife } from "./world/pondLife";
import { AmbientFx } from "./world/ambientFx";
import { EnvironmentClock, Wind } from "./world/environment";
import { CloudLayer, applyDepth, type DepthView } from "./world/atmosphere";
import { SatelliteController } from "./world/satellites";
import { GradeFilter, LightMap, SkyDome, lightFalloffTexture, type LocalLight } from "./world/lighting";
import { featherGlow } from "./world/glowFeather";
import { Fade, TimeOfDayBlend, applyAtmosphere, blendLook, celestial, type Look, type SeasonName } from "./world/lightRig";
import { SeasonFx, type FxKind } from "./world/seasonFx";
import { LivingLayer, setEntityVisible, type LivingVisuals } from "./world/livingLayer";
import { FOCUS, TARGETS, cropTarget, expansionTarget, landTarget } from "./world/echoGardenTargets";
import { EstateLayer, type EstateVisuals } from "./world/estateLayer";
import { AnimalLayer, type AnimalVisuals } from "./world/animalLayer";
import { FarmLayer, type FarmEntity, type FarmFxKind } from "./world/farmLayer";
import { MonumentLayer, eraSpriteKey, type MonumentVisuals } from "./world/monumentLayer";
import { CosmeticLayer, type CosmeticEntity, type PlacementCandidate, type PlacementPreview } from "./world/cosmeticLayer";
import { isLazyCosmeticSprite, vegetationFamily, type CosmeticVisuals } from "./world/cosmetics";
import { cropSpriteKey, type PlotVisual } from "./game/gardenModel";
import {
  LAYOUT,
  WORLD_BASE,
  fenceBays,
  gridToScreen,
  groundHeight,
  groundToScreen,
  type HeightMap,
  type SpriteEntry,
  type WorldManifest,
} from "./world/worldData";

export type TimeOfDay = "day" | "sunset" | "night";
export type { EstateVisuals } from "./world/estateLayer";
export type { AnimalVisuals } from "./world/animalLayer";
export type { CosmeticVisuals } from "./world/cosmetics";
export type { PlacementCandidate, PlacementPreview } from "./world/cosmeticLayer";

/** A one-shot farm reaction requested by the gameplay layer (ids increase; each is played once). */
export interface FarmFxEvent {
  id: number;
  kind: FarmFxKind;
  slot: number;
}

/** What the gameplay HUD may ask the scene (screen positions for fly-to-HUD feedback). */
export interface FarmSceneApi {
  bedClientPoint: (slot: number) => { x: number; y: number } | null;
}

/**
 * What the guide may ask the scene: where a world object is on screen right now. The answer is the object's real
 * drawn bounds under the current camera (client px, clipped to the canvas), or null while it is not in view.
 * `id` is a selection id (`plot_3`, `farmhouse`, `knowledge_tree`, ...), `farm_zone` (all beds) or `island`.
 */
export interface GardenSceneApi {
  targetClientRect: (id: string) => { x: number; y: number; w: number; h: number } | null;
}

export interface InspectableTarget {
  id: string;
  type: "crop" | "tree" | "whale" | "house" | "pest" | "plot" | "prop";
  title: string;
  subtitle: string;
  stage?: string;
  description: string;
  stats?: Array<{ label: string; value: string }>;
}

interface EchoGardenCanvasProps {
  timeOfDay: TimeOfDay;
  onSelectTarget: (target: InspectableTarget | null) => void;
  selectedTargetId: string | null;
  /** zoom relative to the "whole island" framing (1 = fit) */
  cameraZoom: number;
  onCameraZoomChange: (zoom: number) => void;
  /** increments when the HUD asks for the home framing */
  resetSignal?: number;
  reducedMotion?: boolean;
  /**
   * Gameplay mode: live bed visuals from the authoritative server state (slot 1–6 = layout plot_1–plot_6). Absent
   * (visual preview), the beds keep the approved layout fixture. Known at mount; later values update in place.
   */
  farm?: PlotVisual[] | null;
  farmFx?: FarmFxEvent[];
  onFarmReady?: (api: FarmSceneApi | null) => void;
  /** Camera-only focus (no selection / inspect card), e.g. the tutorial pointing at the farm. */
  focusRequest?: { id: string; n: number } | null;
  /**
   * Phase 2 (gameplay only; the preview stays the approved summer world): the island season (= theme week, from the
   * server), the current weather window and the living memory (grove, forest, pests). Known at mount; later values
   * transition in place.
   */
  season?: SeasonName;
  weather?: { kind: "SUNNY" | "RAIN" | "RAINBOW" } | null;
  living?: LivingVisuals | null;
  /** Phase 3A (gameplay only): the expansion bed the player can buy right now (a soft ring marks its cell), or null. */
  expansionHint?: number | null;
  /**
   * Phase 3B (gameplay only): the monument's era and ornament tiers (server facts; the preview keeps the approved
   * tree), a counter that plays one milestone celebration per increment, and whether Echo holds a hint (halo).
   */
  monument?: MonumentVisuals | null;
  celebration?: number;
  echoAttention?: boolean;
  /**
   * Phase 3C (gameplay only): the level of each building and the state of every regional bed cell (server facts; the
   * preview keeps the approved buildings and shows no claim).
   */
  estate?: EstateVisuals | null;
  /**
   * Phase 3E (gameplay only): what the island wears — the equipped appearance of each slot and the decorations that
   * stand (server facts; the preview keeps the approved island) — and the placement preview: while set, the decoration
   * regions are drawn and a tap chooses a point, reported through `onPlacementCandidate` (the server still decides).
   */
  cosmetics?: CosmeticVisuals | null;
  placement?: PlacementPreview | null;
  onPlacementCandidate?: (c: PlacementCandidate | null) => void;
  /**
   * Phase 3H (gameplay only): the animal houses, livestock and guardian pets that stand on the island (server facts;
   * the preview shows none). `animalsInteractive` false = a visited island: they are seen, never opened. `animalCheer`
   * makes the animals of one house (or one guardian) hop once per increment of `n`.
   */
  animals?: AnimalVisuals | null;
  animalsInteractive?: boolean;
  animalCheer?: { n: number; target: string } | null;
  /** The scene's answers for the guide (null when the scene is gone). */
  onSceneReady?: (api: GardenSceneApi | null) => void;
  /** Reported once: the first frame of the real island is drawn ("ready"), or the scene could not be loaded. */
  onStatus?: (status: "ready" | "failed") => void;
  /**
   * The scene's own dark loading veil. False while the cloud reveal of a game entry covers the scene: the clouds are
   * the loading picture then, and the island must already be drawn beneath them when they part.
   */
  entryVeil?: boolean;
}

/** Selection target of an animal house or a guardian's post (the gameplay overlay opens the animals sheet). */
function animalTarget(id: string): InspectableTarget {
  return { id, type: "prop", title: "Chuồng trại", subtitle: "", description: "" };
}

/** Selection target of a decoration standing on the island (the gameplay overlay opens its own card). */
function decorTarget(id: string): InspectableTarget {
  return { id, type: "prop", title: "Vật trang trí", subtitle: "", description: "" };
}

/** Weather presentation weights for a season + weather window (snow = rain in winter, same rule). */
function weatherWeights(season: SeasonName, kind: "SUNNY" | "RAIN" | "RAINBOW" | undefined) {
  const rain = kind === "RAIN" ? 1 : 0;
  return { rain, rainbow: kind === "RAINBOW" ? 1 : 0, snowfall: season === "winter" ? rain : 0, drops: season === "winter" ? 0 : rain };
}

/* ------------------------------------------------------------------------------------------
 * Art direction constants (see docs/echo-garden/ART_BIBLE.md)
 * ---------------------------------------------------------------------------------------- */

/** Fallback look (non-WebGL renderers only): flat tints. WebGL uses the full light rig + grade. */
const FALLBACK_TINT: Record<TimeOfDay, { world: number; cloud: number }> = {
  day: { world: 0xffffff, cloud: 0xffffff },
  sunset: { world: 0xffe0c6, cloud: 0xffc7a0 },
  night: { world: 0x8494c8, cloud: 0x5d6c9e },
};

const NORTH_FOREST_MAX_GY = 9;

/** Wind response per plant family: tall, thin stems move most; heavy crowns least. */
function swayFor(key: string): number {
  // a crop skin moves like the crop it is a cultivar of (`cskin_<crop>_<name>_s<stage>`)
  if (key.startsWith("cskin_")) return swayFor(`crop_${key.slice(6).split("_")[0]}${key.slice(-3)}`);
  if (key === "crop_wheat_s4" || key === "crop_wheat_s3") return 0.034;
  if (key.startsWith("crop_wheat") || key.startsWith("crop_corn")) return 0.026;
  if (key.startsWith("crop_tomato")) return 0.014;
  if (key.startsWith("crop_")) return 0.011;
  if (key.startsWith("edge_weeds")) return 0.03;
  if (key.startsWith("pine")) return 0.006;
  if (key.startsWith("oak") || key === "orchard") return 0.009;
  if (key.startsWith("mtree_") && !key.endsWith("_s1") && key !== "mtree_spot") return 0.01;
  if (key.startsWith("bush") || key.startsWith("fern")) return 0.01;
  return 0;
}

/** Selection target of a living-memory object (the gameplay overlay opens its own panel for these ids). */
function livingTarget(id: string): InspectableTarget {
  if (id.startsWith("pest_")) {
    return { id, type: "pest", title: "Sâu Lãng Quên", subtitle: "Một từ đang cần ôn lại", description: "" };
  }
  return { id, type: "tree", title: "Cây Ký Ức", subtitle: "Chỗ trồng thiêng", description: "" };
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return (
    (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t)
  );
}

function softTexture(size = 64, ring = false): Texture {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    if (ring) {
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(0.72, "rgba(255,255,255,0)");
      g.addColorStop(0.86, "rgba(255,255,255,1)");
      g.addColorStop(1, "rgba(255,255,255,0)");
    } else {
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.45, "rgba(255,255,255,0.55)");
      g.addColorStop(1, "rgba(255,255,255,0)");
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return Texture.from(c);
}

/**
 * Tear down a Pixi application without ever throwing during React unmount.
 * Pixi's ResizePlugin.destroy nulls its own callback; if the plugin list was registered twice
 * (module re-evaluation in dev / HMR) a second pass throws. Fall back to releasing the stage,
 * ticker, renderer and canvas manually so nothing leaks and navigation is never broken.
 */
function destroyApp(a: Application) {
  try {
    a.destroy(true, { children: true, texture: false });
  } catch {
    try {
      a.ticker?.stop();
      a.stage?.destroy({ children: true });
      a.renderer?.destroy(true);
    } catch {
      /* already released */
    }
    a.canvas?.remove?.();
  }
}

interface Entity {
  key: string;
  sprite: Sprite;
  glow?: Sprite;
  shadow?: Sprite;
  instanceScale: number;
  baseX: number;
  baseY: number;
  sway: number;
  seed: number;
  footprint: number;
  target?: InspectableTarget;
  focusId?: string;
  /** art key currently shown (a seasonal variant `<key>__<season>` or the key itself) */
  art: string;
}

export function EchoGardenCanvas({
  timeOfDay,
  onSelectTarget,
  selectedTargetId,
  cameraZoom,
  onCameraZoomChange,
  resetSignal = 0,
  reducedMotion = false,
  farm,
  farmFx,
  onFarmReady,
  focusRequest,
  season = "summer",
  weather = null,
  living = null,
  expansionHint = null,
  monument = null,
  celebration = 0,
  echoAttention = false,
  estate = null,
  cosmetics = null,
  placement = null,
  onPlacementCandidate,
  animals = null,
  animalsInteractive = true,
  animalCheer = null,
  onSceneReady,
  onStatus,
  entryVeil = true,
}: EchoGardenCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  // the loading veil fades out over the first rendered frames instead of popping away
  const [veilGone, setVeilGone] = useState(false);
  useEffect(() => {
    if (!ready) return;
    const id = window.setTimeout(() => setVeilGone(true), reducedMotion ? 0 : 700);
    return () => window.clearTimeout(id);
  }, [ready, reducedMotion]);
  useEffect(() => {
    if (ready) statusRef.current?.("ready");
  }, [ready]);
  useEffect(() => {
    if (failed) statusRef.current?.("failed");
  }, [failed]);

  // live props for the ticker / handlers (no stale closures)
  const timeRef = useRef(timeOfDay);
  const selectRef = useRef(onSelectTarget);
  const zoomCbRef = useRef(onCameraZoomChange);
  const reducedRef = useRef(reducedMotion);
  const selectedRef = useRef(selectedTargetId);
  const farmRef = useRef(farm);
  const farmReadyRef = useRef(onFarmReady);
  const sceneReadyRef = useRef(onSceneReady);
  sceneReadyRef.current = onSceneReady;
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const expansionHintRef = useRef(expansionHint);
  const monumentRef = useRef(monument);
  const echoAttentionRef = useRef(echoAttention);
  /** QA-only presentation override of the monument (dev hook); never set by gameplay */
  const qaMonumentRef = useRef<MonumentVisuals | null>(null);
  const qaEstateRef = useRef<EstateVisuals | null>(null);
  const estateRef = useRef(estate);
  estateRef.current = qaEstateRef.current ?? estate;
  /** QA-only presentation override of the cosmetics (dev hook); never set by gameplay */
  const qaCosmeticsRef = useRef<CosmeticVisuals | null>(null);
  const cosmeticsRef = useRef(cosmetics);
  cosmeticsRef.current = qaCosmeticsRef.current ?? cosmetics;
  /** QA-only presentation override of the animals (dev hook); never set by gameplay */
  const qaAnimalsRef = useRef<AnimalVisuals | null>(null);
  const animalsRef = useRef(animals);
  animalsRef.current = qaAnimalsRef.current ?? animals;
  const animalsInteractiveRef = useRef(animalsInteractive);
  const placementRef = useRef(placement);
  placementRef.current = placement;
  const candidateRef = useRef(onPlacementCandidate);
  candidateRef.current = onPlacementCandidate;
  monumentRef.current = qaMonumentRef.current ?? monument;
  echoAttentionRef.current = echoAttention;
  const seasonRef = useRef<SeasonName>(season);
  const weatherRef = useRef(weather);
  /** QA-only presentation overrides (setSeason / setWeather hooks); never set by gameplay */
  const qaWeatherRef = useRef<{ kind: "SUNNY" | "RAIN" | "RAINBOW" } | null>(null);
  const qaSeasonRef = useRef<SeasonName | null>(null);
  seasonRef.current = qaSeasonRef.current ?? season;
  weatherRef.current = qaWeatherRef.current ?? weather;
  farmRef.current = farm;
  farmReadyRef.current = onFarmReady;
  expansionHintRef.current = expansionHint;
  timeRef.current = timeOfDay;
  selectRef.current = onSelectTarget;
  zoomCbRef.current = onCameraZoomChange;
  reducedRef.current = reducedMotion;
  selectedRef.current = selectedTargetId;

  const sceneRef = useRef<{
    camera: CameraController;
    focusTarget: (id: string | null) => void;
    goHome: () => void;
    reportZoom: () => void;
    setSelectedRing: (id: string | null) => void;
    applyFarm: (visuals: PlotVisual[]) => void;
    playFarmFx: (kind: FarmFxKind, slot: number) => void;
    applySeason: (season: SeasonName) => void;
    applyLiving: (v: LivingVisuals) => void;
    setExpansionHint: (slot: number | null) => void;
    applyMonument: (v: MonumentVisuals) => void;
    celebrate: () => void;
    applyEstate: (v: EstateVisuals) => void;
    applyCosmetics: (v: CosmeticVisuals) => void;
    setPlacement: (p: PlacementPreview | null) => void;
    applyAnimals: (v: AnimalVisuals) => void;
    cheerAnimals: (target: string) => void;
  } | null>(null);
  const lastCheer = useRef(0);
  const lastFxId = useRef(0);
  const lastCelebration = useRef(celebration);
  const lastReportedZoom = useRef(1);

  /* ---------------------------------------------------------------------------------------- */
  useEffect(() => {
    let destroyed = false;
    let app: Application | null = null;
    let appInitialized = false;
    const cleanups: Array<() => void> = [];
    // GPU resources referenced by batches / filters: released only AFTER the renderer is gone, so no
    // texture is ever destroyed while a bind group still holds it
    const releases: Array<() => void> = [];
    const generated: Texture[] = [];
    const feathered = new Map<string, Texture>();
    let loadedUrls: string[] = [];

    async function init() {
      const host = hostRef.current;
      if (!host) return;
      const narrow = window.innerWidth < 760;
      const lowMem = typeof navigator !== "undefined" && (navigator as Navigator & { deviceMemory?: number }).deviceMemory !== undefined
        && ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) < 4;
      const useMobileTerrain = narrow || lowMem;

      app = new Application();
      await app.init({
        resizeTo: host,
        backgroundColor: 0x0c142b,
        antialias: true,
        autoDensity: true,
        resolution: Math.min(window.devicePixelRatio || 1, narrow ? 1.5 : 2),
        preference: "webgl",
      });
      appInitialized = true;
      if (destroyed) {
        destroyApp(app);
        app = null;
        return;
      }
      host.appendChild(app.canvas);
      app.canvas.style.display = "block";
      app.canvas.style.touchAction = "none";

      /* ---------------- data + textures ---------------- */
      let manifest: WorldManifest;
      try {
        manifest = (await (await fetch(`${WORLD_BASE}world_manifest.json`)).json()) as WorldManifest;
      } catch {
        if (!destroyed) setFailed(true);
        return;
      }
      if (destroyed) return;
      const hm: HeightMap = manifest.heightmap;
      // seasons (Phase 2): the island keeps one geometry; the season swaps the ground and the vegetation art.
      // The preview always shows the approved summer world. Only the CURRENT season's variants are downloaded.
      const farm0Early = farmRef.current ?? null;
      let currentSeason: SeasonName = farm0Early !== null ? seasonRef.current : "summer";
      const terrainFor = (sn: SeasonName) => {
        const t = sn !== "summer" ? manifest.terrainSeasons?.[sn] : undefined;
        return t ? (useMobileTerrain ? t.mobile : t) : useMobileTerrain ? manifest.terrain.mobile : manifest.terrain;
      };
      /** the art key a vegetation key shows in a season (its seasonal variant when one exists) */
      const artFor = (key: string, sn: SeasonName) => (sn !== "summer" && manifest.sprites[`${key}__${sn}`] ? `${key}__${sn}` : key);
      const terrainEntry = terrainFor(currentSeason);
      const urls = new Set<string>();
      urls.add(WORLD_BASE + terrainEntry.file);
      if (manifest.terrain.shadowMask) urls.add(WORLD_BASE + manifest.terrain.shadowMask.file);
      // gameplay: only the crops the server says are growing; preview: the approved layout fixture
      const farm0 = farmRef.current ?? null;
      const gameplay = farm0 !== null;
      /** the crop art a visual shows: its skin sprite when the manifest ships it, the base crop otherwise */
      const cropArt = (code: string, stage: number, skinArt?: string | null) => {
        const want = cropSpriteKey(code, stage, skinArt);
        return manifest.sprites[want] ? want : cropSpriteKey(code, stage);
      };
      const shownCrops = new Set(gameplay
        ? farm0.filter((v) => v.cropCode).map((v) => cropArt(v.cropCode as string, v.stage, v.skinArt))
        : LAYOUT.starterPlots.map((p) => `crop_${p.crop}_s${p.stage ?? 4}`));
      // Phase 3B: the monument shows the era the server reports (known at mount); the preview keeps the approved tree
      const treeArt = gameplay ? eraSpriteKey(manifest, monumentRef.current?.era ?? 0) : "knowledge_tree";
      const shownMarkers = new Set(LAYOUT.futureFields.filter((f) => f.state !== "resting").map((f) => `field_marker_${f.id}`));
      Object.entries(manifest.sprites).forEach(([key, s]) => {
        // Phase 3E: house families, vegetation appearances, monument sets, decorations, fence / path styles load only
        // when they are worn or previewed (the catalogue is large; the scene only ever holds what is on screen)
        if (isLazyCosmeticSprite(key)) return;
        // growth stages / markers that are not on screen load on demand (memory budget)
        if (key.startsWith("crop_") && !shownCrops.has(key)) return;
        // Phase 3B: crop skins load only when a growing crop wears one; of the monument's eras only the one on
        // screen is loaded; ornaments load with the monument layer
        if (key.startsWith("cskin_")) {
          if (!shownCrops.has(key)) return;
        } else if (key.startsWith("kt_orn_")) {
          return;
        } else if (key === "knowledge_tree" || key.startsWith("knowledge_tree_e")) {
          if (key !== treeArt) return;
        }
        if (key.startsWith("field_marker_") && !shownMarkers.has(key)) return;
        // retired cone islets are never part of the world (exactly two satellites, see layout)
        if (key.startsWith("islet_")) return;
        // Phase 3C: building levels, the stall, land claims and pest damage overlays load with the estate / farm layers
        if (/^(cottage|shed|market_stall)_l\d$/.test(key) || key === "land_claim" || key.startsWith("pest_")) return;
        // memory trees, the sacred spot and pests load with the living layer (gameplay only)
        if (key.startsWith("mtree_") || key === "forgotten_pest") return;
        // seasonal variants: only the current season's; a vegetation key replaced by its variant keeps only its shadow
        if (key.startsWith("cskin_") || key.startsWith("knowledge_tree")) {
          // selected above; these are never seasonal variants
        } else if (key.includes("__")) {
          if (!key.endsWith(`__${currentSeason}`)) return;
        } else if (artFor(key, currentSeason) !== key) {
          if (s.shadow) urls.add(WORLD_BASE + s.shadow.file);
          return;
        }
        urls.add(WORLD_BASE + s.file);
        if (s.glow) urls.add(WORLD_BASE + s.glow);
        if (s.shadow) urls.add(WORLD_BASE + s.shadow.file);
      });
      Object.values(manifest.fish).forEach((f) => urls.add(WORLD_BASE + f.file));
      // the Echo Whale is rendered as real-time 3D on WebGL; the pre-rendered atlas is only a fallback
      const webgl = app.renderer.type === RendererType.WEBGL;
      const whale3D = webgl;
      // WebGL: the full light rig (grade filter, local light map). Other renderers: flat fallback tints.
      const graded = webgl;
      const whaleAtlas = !whale3D && manifest.whale ? (useMobileTerrain ? manifest.whale.atlasMobile : manifest.whale.atlas) : null;
      if (whaleAtlas) urls.add(WORLD_BASE + whaleAtlas.file);
      loadedUrls = [...urls];
      let textures: Record<string, Texture>;
      try {
        textures = (await Assets.load(loadedUrls, (p) => {
          if (!destroyed) setProgress(Math.round(p * 100));
        })) as Record<string, Texture>;
      } catch {
        if (!destroyed) setFailed(true);
        return;
      }
      if (destroyed || !app) return;
      // mipmaps for sprites minified at the overview zoom; not for textures that are only ever drawn
      // magnified or near 1:1 (shadow factors, cap mask -> shadow composition; whale atlas) — GPU budget
      const noMip = (u: string) => u.includes("_shadow") || u.includes("shadowmask") || u.includes("whale_atlas");
      const mip = (t: Texture) => {
        t.source.autoGenerateMipmaps = true;
        t.source.scaleMode = "linear";
        t.source.mipmapFilter = "linear";
        t.source.updateMipmaps();
      };
      /**
       * A night glow that is cut at the edge of its own image shows a lit rectangle behind its sprite: such a glow is
       * replaced, once, by a copy whose haze fades out before the edge (world/glowFeather.ts). The copy belongs to this
       * scene (`feathered`) and is released with the texture it stands for.
       */
      const softGlow = (u: string, t: Texture): Texture => {
        if (!u.includes("_glow")) return t;
        const soft = featherGlow(t);
        if (!soft) return t;
        mip(soft);
        feathered.set(u, soft);
        return soft;
      };
      Object.entries(textures).forEach(([u, t]) => {
        if (!t?.source) return;
        if (noMip(u)) {
          t.source.scaleMode = "linear";
          return;
        }
        mip(t);
        textures[u] = softGlow(u, t);
      });
      const tex = (u: string): Texture | null => textures[u] ?? null;
      const wtex = (f: string) => tex(WORLD_BASE + f);
      /** load a world texture that was not part of the initial set (e.g. another crop stage) */
      const loadWorldTexture = async (f: string): Promise<Texture | null> => {
        const u = WORLD_BASE + f;
        if (textures[u]) return textures[u];
        try {
          const t = (await Assets.load(u)) as Texture;
          if (destroyed) return null;
          // a second caller may have finished loading the same file meanwhile
          if (textures[u]) return textures[u];
          textures[u] = softGlow(u, t);
          loadedUrls.push(u);
          return textures[u];
        } catch {
          return null;
        }
      };

      const soft = softTexture(64);
      const ring = softTexture(128, true);
      generated.push(soft, ring);

      /* ---------------- geometry of the main island ---------------- */
      const terrainScale = terrainEntry.scale;
      const terrainX = -terrainEntry.originPx[0] * terrainScale;
      const terrainY = -terrainEntry.originPx[1] * terrainScale;
      const terrainW = terrainEntry.w * terrainScale;
      const terrainH = terrainEntry.h * terrainScale;
      /** the home framing centre: every depth layer coincides with the authored composition here */
      const islandCentre = { x: terrainX + terrainW * 0.5, y: terrainY + terrainH * 0.47 };

      /* ---------------- scene graph ----------------
       * stage
       *  ├ sky (screen space: gradient domes, sun / moon, stars)
       *  ├ scene  [grade filter]  — depth-ordered layers, each with its OWN transform:
       *  │    far clouds · mid clouds · satellite B · satellite A · cloud sea · MAIN ISLAND (world) · near clouds
       *  ├ emissive (world transform): window / lamp / heartwood light, memory motes, fireflies
       *  └ vignette (screen space)
       */
      const stage = app.stage;
      const sky = new SkyDome(soft);
      stage.addChild(sky.root);
      // Phase 2 overcast: a soft grey-blue cloud cover painted over the sky (behind the island) while it rains / snows
      const overcastTex = (() => {
        const c = document.createElement("canvas");
        c.width = 4;
        c.height = 256;
        const ctx = c.getContext("2d");
        if (ctx) {
          const g = ctx.createLinearGradient(0, 0, 0, 256);
          g.addColorStop(0, "rgba(104,112,128,1)");
          g.addColorStop(0.55, "rgba(150,158,172,0.96)");
          g.addColorStop(1, "rgba(188,194,204,0.9)");
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, 4, 256);
        }
        return Texture.from(c);
      })();
      generated.push(overcastTex);
      const overcast = new Sprite(overcastTex);
      overcast.eventMode = "none";
      overcast.alpha = 0;
      stage.addChild(overcast);
      const scene = new Container();
      scene.label = "scene";
      stage.addChild(scene);

      const world = new Container();
      world.label = "main-island";
      const backLayer = new Container(); // whale far arc
      const terrainLayer = new Container();
      const groundObjects = new Container(); // raised beds: low ground objects below every shadow
      groundObjects.sortableChildren = true;
      const groundFx = new Container(); // pond life + selection rings + hit polygons
      const entities = new Container();
      entities.sortableChildren = true;
      const fxLayer = new Container();
      const frontLayer = new Container(); // whale near arc
      world.addChild(backLayer, terrainLayer, groundObjects);
      const emissive = new Container();
      emissive.label = "emissive";
      emissive.eventMode = "none";

      const tintables: Array<{ tint: number }> = [];

      // atmosphere: cloud layers + the two satellite islands, ordered by depth around the main island
      const billows = Object.keys(manifest.sprites).filter((k) => /^billow_\d+$/.test(k)).map((k) => wtex(manifest.sprites[k].file)).filter((t): t is Texture => !!t);
      const seaBillows = Object.keys(manifest.sprites).filter((k) => k.startsWith("billow_sea_")).map((k) => wtex(manifest.sprites[k].file)).filter((t): t is Texture => !!t);
      const cloudLayers = LAYOUT.atmosphere.layers.map((cfg, i) =>
        new CloudLayer(cfg, cfg.sea && seaBillows.length ? [...seaBillows, ...billows.slice(0, 2)] : billows, islandCentre, 11 + i * 17));
      // the satellites show the current season too (summer = the approved art)
      const satTextures: Record<string, Texture | null> = {};
      const satMeta: Record<string, SpriteEntry | undefined> = {};
      const satArt: Record<string, string> = {};
      LAYOUT.satellites.forEach((s) => {
        const art = artFor(s.key, currentSeason);
        satArt[s.key] = art;
        satMeta[s.key] = manifest.sprites[art];
        satTextures[s.key] = manifest.sprites[art] ? wtex(manifest.sprites[art].file) : null;
      });
      const satellites = new SatelliteController(LAYOUT.satellites, satTextures, satMeta, islandCentre, billows, satArt);
      const depthLayers: Array<{ k: number; c: Container }> = [
        ...cloudLayers.map((l) => ({ k: l.cfg.depth, c: l.root })),
        ...satellites.items.map((s) => ({ k: s.cfg.depth, c: s.root })),
        { k: 1, c: world },
      ].sort((a, b) => a.k - b.k);
      depthLayers.forEach((d) => scene.addChild(d.c));
      // the rainbow arcs far behind the island, in front of the far clouds (own parallax depth)
      const RAINBOW_DEPTH = 0.3;
      const rainbowRoot = new Container();
      rainbowRoot.label = "rainbow-depth";
      rainbowRoot.eventMode = "none";
      const rainbowAt = depthLayers.findIndex((d) => d.k > RAINBOW_DEPTH);
      scene.addChildAt(rainbowRoot, rainbowAt < 0 ? scene.children.length : rainbowAt);
      stage.addChild(emissive);

      // terrain
      const terrainTex = wtex(terrainEntry.file);
      let terrainSprite: Sprite | null = null;
      if (terrainTex) {
        const t = new Sprite(terrainTex);
        t.position.set(terrainX, terrainY);
        t.scale.set(terrainScale);
        terrainLayer.addChild(t);
        tintables.push(t);
        terrainSprite = t;
      }
      // dynamic cast shadows: composed from per-object shadow sprites, multiplied over the ground
      const shadows = new ShadowLayer(app.renderer, { x: terrainX, y: terrainY, w: terrainW, h: terrainH }, useMobileTerrain ? 0.3 : 0.45);
      shadows.sprite.eventMode = "none";
      // non-interactive layers never take part in hit testing
      [sky.root, terrainLayer, groundObjects, fxLayer].forEach((c) => (c.eventMode = "none"));
      world.addChild(shadows.sprite, groundFx, entities, fxLayer, frontLayer);
      const capMask = manifest.terrain.shadowMask;
      const capMaskTex = capMask ? wtex(capMask.file) : null;
      if (capMask && capMaskTex) shadows.setCapMask(capMaskTex, capMask.scale);
      const shadowSpec = (entry: SpriteEntry | undefined): ShadowSpec | null => {
        const sh = entry?.shadow;
        const t = sh ? wtex(sh.file) : null;
        return sh && t ? { texture: t, ax: sh.ax, ay: sh.ay, scale: sh.scale } : null;
      };

      /* ---------------- entities ---------------- */
      const entityList: Entity[] = [];
      const entityById = new Map<string, Entity>();
      let hovered: Entity | null = null;
      let dragMoved = false;

      const hoverRing = new Sprite(ring);
      const selectRing = new Sprite(ring);
      [hoverRing, selectRing].forEach((r) => {
        r.anchor.set(0.5);
        r.blendMode = "add";
        r.tint = 0xffe2a0;
        r.alpha = 0;
        groundFx.addChild(r);
      });

      const placeRing = (r: Sprite, e: Entity | null, alpha: number) => {
        if (!e) {
          r.alpha = 0;
          return;
        }
        const w = e.footprint * 128 * 1.15;
        r.position.set(e.baseX, e.baseY);
        r.scale.set(w / ring.width, (w * 0.5) / ring.height);
        r.alpha = alpha;
      };

      const addEntity = (
        key: string,
        gx: number,
        gy: number,
        opts: {
          scale?: number; sway?: number; footprint?: number; target?: InspectableTarget; focusId?: string;
          hit?: "canopy" | "body"; layer?: Container; art?: string;
        } = {},
      ): Entity | null => {
        const art = opts.art ?? key;
        const entry: SpriteEntry | undefined = manifest.sprites[art];
        const t = entry ? wtex(entry.file) : null;
        if (!entry || !t) return null;
        const p = groundToScreen(hm, gx, gy);
        const s = new Sprite(t);
        const k = entry.scale * (opts.scale ?? 1);
        s.anchor.set(entry.ax / entry.w, entry.ay / entry.h);
        s.position.set(p.x, p.y);
        s.scale.set(k);
        s.zIndex = p.y;
        s.eventMode = "none"; // decorative unless it carries an inspect target (below)
        (opts.layer ?? entities).addChild(s);
        tintables.push(s);
        const e: Entity = {
          key, sprite: s, baseX: p.x, baseY: p.y, sway: opts.sway ?? swayFor(key), seed: (gx * 13.1 + gy * 7.3) % 6.28,
          footprint: opts.footprint ?? 1, target: opts.target, focusId: opts.focusId, instanceScale: opts.scale ?? 1, art,
        };
        // a seasonal variant has the base geometry: it re-uses the base sprite's shadow
        const sh = shadowSpec(entry.shadow ? entry : manifest.sprites[key]);
        if (sh) e.shadow = shadows.add(sh, p.x, p.y, opts.scale ?? 1);
        if (entry.glow) {
          const gt = wtex(entry.glow);
          if (gt) {
            // emissive light lives OUTSIDE the graded scene so night grading never dims a lit window
            const g = new Sprite(gt);
            g.anchor.copyFrom(s.anchor);
            g.position.copyFrom(s.position);
            g.scale.set(k);
            g.blendMode = "add";
            g.alpha = 0;
            g.eventMode = "none";
            emissive.addChild(g);
            e.glow = g;
          }
        }
        if (opts.target) {
          s.eventMode = "static";
          s.cursor = "pointer";
          s.label = `target-${opts.target.id}`;
          // hit area hugging the visible mass (canopy for trees, body otherwise)
          const lw = entry.w;
          const lh = entry.h;
          const ox = -entry.ax;
          const oy = -entry.ay;
          s.hitArea = opts.hit === "canopy"
            ? new Ellipse(ox + lw * 0.5, oy + lh * 0.42, lw * 0.42, lh * 0.42)
            : new Ellipse(ox + lw * 0.5, oy + lh * 0.55, lw * 0.46, lh * 0.45);
          s.on("pointerover", () => {
            hovered = e;
            placeRing(hoverRing, e, 0.45);
          });
          s.on("pointerout", () => {
            if (hovered === e) hovered = null;
            placeRing(hoverRing, null, 0);
          });
          s.on("pointertap", (ev: FederatedPointerEvent) => {
            ev.stopPropagation();
            if (dragMoved) return;
            // Phase 3E: while a decoration is being placed a tap chooses the ground point under the pointer, whatever
            // stands there (the layer judges it; a sprite never opens its card in the middle of a placement)
            if (placementRef.current) {
              const w = world.toLocal(ev.global);
              cosmeticLayerRef.current?.choose(w.x, w.y);
              return;
            }
            if (e.target) selectRef.current(e.target);
          });
          entityById.set(opts.target.id, e);
        }
        entityList.push(e);
        return e;
      };

      /** Phase 3E: an entity leaves the island (a stored decoration, a path stamp): sprite, glow and shadow go. */
      const removeEntity = (e: Entity) => {
        const i = entityList.indexOf(e);
        if (i >= 0) entityList.splice(i, 1);
        if (e.target && entityById.get(e.target.id) === e) entityById.delete(e.target.id);
        const ti = tintables.indexOf(e.sprite);
        if (ti >= 0) tintables.splice(ti, 1);
        if (hovered === e) hovered = null;
        if (e.shadow) shadows.remove(e.shadow);
        if (e.glow && !e.glow.destroyed) e.glow.destroy();
        if (!e.sprite.destroyed) e.sprite.destroy();
      };
      /**
       * Phase 3E: swap an entity's art in place (same anchor point and instance scale): texture, glow and shadow
       * follow. Art that has no shadow of its own keeps the shadow of the entity's base sprite (seasonal variants).
       */
      const artWanted = new WeakMap<Entity, string>();
      const retexture = async (e: Entity, art: string): Promise<boolean> => {
        const entry: SpriteEntry | undefined = manifest.sprites[art];
        if (!entry) return false;
        artWanted.set(e, art);
        const t = await loadWorldTexture(entry.file);
        const shEntry = entry.shadow ? entry : manifest.sprites[e.key];
        const shTex = shEntry?.shadow ? await loadWorldTexture(shEntry.shadow.file) : null;
        const gTex = entry.glow ? await loadWorldTexture(entry.glow) : null;
        if (!t || destroyed || e.sprite.destroyed || artWanted.get(e) !== art) return false;
        const k = entry.scale * e.instanceScale;
        e.sprite.texture = t;
        e.sprite.anchor.set(entry.ax / entry.w, entry.ay / entry.h);
        e.sprite.scale.set(k);
        e.art = art;
        if (shEntry?.shadow && shTex) {
          const spec: ShadowSpec = { texture: shTex, ax: shEntry.shadow.ax, ay: shEntry.shadow.ay, scale: shEntry.shadow.scale };
          if (e.shadow) shadows.replace(e.shadow, spec, e.instanceScale);
          else e.shadow = shadows.add(spec, e.baseX, e.baseY, e.instanceScale);
        }
        if (gTex) {
          if (!e.glow) {
            const g = new Sprite(gTex);
            g.position.copyFrom(e.sprite.position);
            g.blendMode = "add";
            g.alpha = 0;
            g.eventMode = "none";
            emissive.addChild(g);
            e.glow = g;
          }
          e.glow.texture = gTex;
          e.glow.anchor.copyFrom(e.sprite.anchor);
          e.glow.scale.set(k);
          e.glow.visible = true;
        } else if (e.glow) {
          e.glow.visible = false;
        }
        return true;
      };

      // trees (seasonal art when the island is in another season than the approved summer)
      const seasonal: Entity[] = [];
      // Phase 3E: the layout plants a vegetation appearance re-dresses (orchard / round trees, bushes, flowering bushes)
      const dressable: Entity[] = [];
      LAYOUT.trees.forEach((t) => {
        const north = t.gy < NORTH_FOREST_MAX_GY && t.key !== "orchard";
        const target = t.key === "orchard" ? TARGETS.orchard_zone : north ? TARGETS.forest_zone : undefined;
        const e = addEntity(t.key, t.gx, t.gy, {
          scale: t.s, footprint: 1.6 * (t.s ?? 1), target,
          focusId: t.key === "orchard" ? "orchard_zone" : "forest_zone", hit: "canopy", art: artFor(t.key, currentSeason),
        });
        if (e) seasonal.push(e);
        if (e && vegetationFamily(t.key)) dressable.push(e);
      });
      LAYOUT.bushes.forEach((b) => {
        const e = addEntity(b.key, b.gx, b.gy, { scale: b.s, footprint: 0.8, art: artFor(b.key, currentSeason) });
        if (e) seasonal.push(e);
        if (e && vegetationFamily(b.key)) dressable.push(e);
      });
      // named sprites
      LAYOUT.sprites.forEach((sp) => {
        const target = TARGETS[sp.id];
        const sc = sp.s ?? 1;
        const footprint = (sp.key === "cottage" ? 2.8 : sp.key === "knowledge_tree" ? 4.4 : sp.key === "shed" ? 1.6 : 1) * sc;
        addEntity(sp.key, sp.gx, sp.gy, {
          scale: sc, target, footprint, focusId: sp.id, sway: sp.key === "knowledge_tree" ? 0.004 : sp.key === "scarecrow" ? 0.01 : 0,
          hit: sp.key === "knowledge_tree" ? "canopy" : "body", art: sp.key === "knowledge_tree" ? treeArt : undefined,
        });
      });
      // the six starter plots: a raised bed (ground object) + its crop at a visual growth stage.
      // The whole cell diamond is the touch target (GDD 04 §11.3), independent of the crop art.
      const plotById = new Map<string, { bed: Entity | null; crop: Entity | null; crop_: string; stage: number }>();
      // Phase 3E: every raised bed on the island (starter, expansion, regional) wears the equipped bed frame
      const bedEntities: Entity[] = [];
      const plotDiamond = (gx: number, gy: number) => {
        const c = groundToScreen(hm, gx, gy);
        return [c.x, c.y - 32, c.x + 64, c.y, c.x, c.y + 32, c.x - 64, c.y];
      };
      LAYOUT.starterPlots.forEach((p, i) => {
        const stage = p.stage ?? 4;
        const bed = addEntity("plot_bed", p.gx, p.gy, { layer: groundObjects, footprint: 0.9 });
        if (bed) bedEntities.push(bed);
        const live = gameplay ? farm0.find((v) => v.slot === i + 1) : undefined;
        const cropKey = gameplay ? (live?.cropCode ? cropArt(live.cropCode, live.stage, live.skinArt) : null) : `crop_${p.crop}_s${stage}`;
        const crop = cropKey ? addEntity(cropKey, p.gx, p.gy, { footprint: 0.9 }) : null;
        const target = cropTarget(p.id, i, p.crop, stage);
        const poly = plotDiamond(p.gx, p.gy);
        const hit = new Graphics();
        hit.poly(poly).fill({ color: 0xffffff, alpha: 0.001 });
        hit.hitArea = new Polygon(poly);
        hit.eventMode = "static";
        hit.cursor = "pointer";
        hit.label = `plot-hit-${p.id}`;
        hit.on("pointertap", (ev: FederatedPointerEvent) => {
          ev.stopPropagation();
          if (!dragMoved) selectRef.current(cropTarget(p.id, i, p.crop, plotById.get(p.id)?.stage ?? stage));
        });
        groundFx.addChild(hit);
        // gameplay rings the bed (always present); the preview rings the crop art
        const ring = gameplay ? bed ?? crop : crop ?? bed;
        if (ring) {
          ring.target = target;
          ring.focusId = p.id;
          entityById.set(p.id, ring);
        }
        plotById.set(p.id, { bed, crop, crop_: p.crop, stage });
      });
      // Phase 3A: slots 7–10 are the purchasable beds of `LAYOUT.expansionPlots` (owner-approved cells). The map holds
      // each bed's art anchor (cell + `dy`): the north strip's raised beds sit clear of the fence behind them
      const expansionCells = new Map((LAYOUT.expansionPlots ?? []).map((x) => [x.slot, { ...x, gy: x.gy + (x.dy ?? 0) }]));
      // Phase 3C: farmland regions (slots 11+) — reserved future-field cells that become ordinary beds once bought
      const landCells = new Map((LAYOUT.landRegions ?? []).flatMap((r) => r.plots.map((p) => [p.slot, { ...p, field: r.field }] as const)));
      const cellOfSlot = (slot: number): { gx: number; gy: number } | undefined =>
        slot <= LAYOUT.starterPlots.length ? LAYOUT.starterPlots[slot - 1] : expansionCells.get(slot) ?? landCells.get(slot);
      // gameplay: the beds follow the authoritative server state (crop, stage, ready, watered) + action feedback
      const farmLayer = gameplay
        ? new FarmLayer(
          {
            manifest, shadows, soft, ring, groundObjects, groundFx, fxLayer, loadTexture: loadWorldTexture, swayFor,
            createCrop: (key, slot) => {
              const p = cellOfSlot(slot);
              return p ? (addEntity(key, p.gx, p.gy, { footprint: 0.9 }) as FarmEntity | null) : null;
            },
          },
          LAYOUT.starterPlots.map((p, i) => {
            const c = groundToScreen(hm, p.gx, p.gy);
            const plot = plotById.get(p.id);
            return { slot: i + 1, bed: plot?.bed ?? null, crop: plot?.crop ?? null, x: c.x, y: c.y };
          }),
        )
        : null;
      if (farmLayer) farmLayer.reduced = reducedRef.current;

      // Phase 2 living memory (gameplay only): sacred grove around the Knowledge Tree, Memory Forest anchors, pests
      const hitLayer = new Container();
      hitLayer.label = "living-hits";
      const living = gameplay
        ? new LivingLayer({
          manifest, shadows, soft, ring, groundFx, fxLayer, hitLayer, loadTexture: loadWorldTexture,
          createEntity: (key, gx, gy, o) => addEntity(key, gx, gy, {
            layer: o.ground ? groundObjects : undefined, scale: o.scale, footprint: o.footprint,
          }) as FarmEntity | null,
          removeEntity: (e) => removeEntity(e as Entity),
          onSelect: (id) => selectRef.current(livingTarget(id)),
          isDragging: () => dragMoved,
          spots: (LAYOUT.memoryGrove ?? []).map((g) => ({ ...g, ...groundToScreen(hm, g.gx, g.gy) })),
          forest: (LAYOUT.memoryForest ?? []).map((f) => ({ ...f, ...groundToScreen(hm, f.gx, f.gy) })),
          beds: new Map([
            ...LAYOUT.starterPlots.map((pl, i) => [i + 1, { gx: pl.gx, gy: pl.gy, ...groundToScreen(hm, pl.gx, pl.gy) }] as const),
            ...[...expansionCells.values()].map((x) => [x.slot, { gx: x.gx, gy: x.gy, ...groundToScreen(hm, x.gx, x.gy) }] as const),
            ...[...landCells.values()].map((x) => [x.slot, { gx: x.gx, gy: x.gy, ...groundToScreen(hm, x.gx, x.gy) }] as const),
          ]),
        })
        : null;
      if (living) living.reduced = reducedRef.current;

      // farm storytelling props (seed-storage corner, tools, hay, bench): sprites with their own shadows
      const farmPropEntities = new Map<string, Entity | null>();
      (LAYOUT.farmProps ?? []).forEach((fp) => farmPropEntities.set(fp.key, addEntity(fp.key, fp.gx, fp.gy, { scale: fp.s, footprint: 0.6 })));
      // growth gathering along the fence foot (outside the fence; decorative, never a hit target)
      (LAYOUT.farmEdges ?? []).forEach((fe) => addEntity(fe.key, fe.gx, fe.gy, { scale: fe.s, footprint: 0.4 }));
      // farm fences + gate: one sprite per bay (separate shadows), so expansion can move or remove them
      const fenceEntities = fenceBays(LAYOUT).map((b) => addEntity(b.key, b.gx, b.gy, { footprint: 0.5 })).filter((e): e is Entity => !!e);
      // future-plot markers (stakes, twine, blank sign): low ground objects on the worked expansion fields
      // (resting cover-crop strips stay unmarked so the farm never reads as a grid of unlocked plots)
      const fieldMarkers = new Map<string, Entity | null>();
      LAYOUT.futureFields.filter((f) => f.state !== "resting").forEach((f) => {
        const [x0, y0, x1, y1] = f.rect;
        fieldMarkers.set(f.id, addEntity(`field_marker_${f.id}`, (x0 + x1) / 2, (y0 + y1) / 2, { layer: groundObjects, footprint: 0.5 }));
      });

      // Phase 3A (gameplay only): the four purchasable beds. An owned bed gets the starter beds' raised-bed sprite +
      // shadow and joins the farm layer (crops, care, harvest feedback); its field's stake-and-twine marker is hidden
      // (the twine would cross the bed). A locked cell is a whole-cell touch target for the expansion card and the
      // cell the player can buy now breathes a soft ring. The preview shows none of this.
      const expansionBeds = new Map<number, Entity | null>();
      const cosmeticLayerRef: { current: CosmeticLayer | null } = { current: null };
      const hideMarkerOf = (field: string) => {
        const m = fieldMarkers.get(field);
        if (!m) return;
        m.sprite.visible = false;
        if (m.shadow) shadows.setVisible(m.shadow, false);
      };
      const ownBed = (slot: number) => {
        const c = expansionCells.get(slot) ?? landCells.get(slot);
        if (!c || !farmLayer || farmLayer.hasBed(slot)) return;
        const bed = addEntity("plot_bed", c.gx, c.gy, { layer: groundObjects, footprint: 0.9 });
        if (bed) {
          bedEntities.push(bed);
          void cosmeticLayerRef.current?.dressBeds();
        }
        expansionBeds.set(slot, bed);
        const p = groundToScreen(hm, c.gx, c.gy);
        farmLayer.addBed({ slot, bed: bed as FarmEntity | null, crop: null, x: p.x, y: p.y });
        if (bed) {
          bed.target = cropTarget(`plot_${slot}`, slot - 1, "wheat", 4);
          bed.focusId = `plot_${slot}`;
          entityById.set(`plot_${slot}`, bed);
        }
        hideMarkerOf(c.field);
      };
      const expansionHint = new Sprite(ring);
      expansionHint.anchor.set(0.5);
      expansionHint.tint = 0xffe2a0;
      expansionHint.alpha = 0;
      expansionHint.eventMode = "none";
      expansionHint.label = "expansion-hint";
      let hintSlot: number | null = null;
      const setExpansionHint = (slot: number | null) => {
        const c = slot !== null && !(farmLayer?.hasBed(slot) ?? false) ? expansionCells.get(slot) : undefined;
        hintSlot = c ? slot : null;
        if (!c) return;
        const p = groundToScreen(hm, c.gx, c.gy);
        expansionHint.position.set(p.x, p.y);
        expansionHint.scale.set(122 / ring.width, 61 / ring.height);
      };
      if (gameplay) {
        groundFx.addChild(expansionHint);
        for (const v of farm0 ?? []) if (expansionCells.has(v.slot)) ownBed(v.slot);
        for (const v of farm0 ?? []) if (landCells.has(v.slot)) ownBed(v.slot);
        expansionCells.forEach((c) => {
          const poly = plotDiamond(c.gx, c.gy);
          const hit = new Graphics();
          hit.poly(poly).fill({ color: 0xffffff, alpha: 0.001 });
          hit.hitArea = new Polygon(poly);
          hit.eventMode = "static";
          hit.cursor = "pointer";
          hit.label = `expand-hit-${c.slot}`;
          hit.on("pointertap", (ev: FederatedPointerEvent) => {
            ev.stopPropagation();
            if (dragMoved) return;
            selectRef.current(farmLayer?.hasBed(c.slot) ? cropTarget(`plot_${c.slot}`, c.slot - 1, "wheat", 4) : expansionTarget(c.slot));
          });
          groundFx.addChild(hit);
        });
        setExpansionHint(expansionHintRef.current);
        // the market stall: the seed-storage corner by the gate (crates, seed sacks, barrel) is one touch target
        const st = LAYOUT.marketStall;
        if (st) {
          const c = groundToScreen(hm, st.gx, st.gy);
          const rx = st.radius * 128;
          const ry = st.radius * 64;
          const poly = [c.x, c.y - ry - 26, c.x + rx, c.y - 26, c.x + rx, c.y, c.x, c.y + ry, c.x - rx, c.y, c.x - rx, c.y - 26];
          const hit = new Graphics();
          hit.poly(poly).fill({ color: 0xffffff, alpha: 0.001 });
          hit.hitArea = new Polygon(poly);
          hit.eventMode = "static";
          hit.cursor = "pointer";
          hit.label = "market-stall-hit";
          hit.on("pointertap", (ev: FederatedPointerEvent) => {
            ev.stopPropagation();
            if (!dragMoved) selectRef.current(TARGETS.market_stall);
          });
          groundFx.addChild(hit);
        }
      }

      // Phase 3C (gameplay only): building levels (cottage, storehouse, market stall) and the farmland regions
      const stallAt = LAYOUT.buildings?.MARKET;
      const estateLayer = gameplay
        ? new EstateLayer({
          manifest, shadows, ring, groundFx, emissive, loadTexture: loadWorldTexture,
          cottage: (entityById.get("farmhouse") ?? null) as FarmEntity | null,
          shed: (entityById.get("shed") ?? null) as FarmEntity | null,
          stallProps: (stallAt?.replaces ?? []).map((k) => farmPropEntities.get(k)).filter((e): e is Entity => !!e) as FarmEntity[],
          stall: stallAt && stallAt.gx !== undefined && stallAt.gy !== undefined ? { gx: stallAt.gx, gy: stallAt.gy } : null,
          createEntity: (key, gx, gy, o) => addEntity(key, gx, gy, {
            layer: o.ground ? groundObjects : undefined, footprint: o.footprint,
            target: key.startsWith("market_stall") ? TARGETS.market_stall : undefined,
          }) as FarmEntity | null,
          cells: [...landCells.values()].map((c) => ({ ...c, ...groundToScreen(hm, c.gx, c.gy) })),
          diamond: plotDiamond,
          onSelect: (id) => selectRef.current(id.startsWith("plot_")
            ? cropTarget(id, Number(id.slice(5)) - 1, "wheat", 4) : landTarget(Number(id.slice(5)))),
          isDragging: () => dragMoved,
          ownBed,
          hasBed: (slot) => farmLayer?.hasBed(slot) ?? false,
          onRetexture: (e, entry, key) => {
            // the touch target follows the building's new silhouette
            e.sprite.hitArea = EstateLayer.bodyHit(entry);
            // Phase 3E: the smoke rises from the chimney of the house that stands there now
            const house = manifest.houses?.[key]?.chimney;
            if (house && e === entityById.get("farmhouse")) {
              chimney.x = e.baseX + house.dx * e.instanceScale;
              chimney.y = e.baseY + house.dy * e.instanceScale;
            } else if (e === entityById.get("farmhouse") && (key === "cottage" || key.startsWith("cottage_l"))) {
              chimney.x = e.baseX + 86 * e.instanceScale;
              chimney.y = e.baseY - 236 * e.instanceScale;
            }
          },
        })
        : null;
      if (estateLayer) {
        estateLayer.reduced = reducedRef.current;
        if (estateRef.current) estateLayer.apply(estateRef.current);
      }

      // Phase 3H (gameplay only): animal houses, livestock and guardian pets of the animal quarter
      const quarter = LAYOUT.animalQuarter;
      const animalLayer = gameplay && quarter
        ? new AnimalLayer({
          manifest, quarter, entities, groundFx, marks: fxLayer, loadTexture: loadWorldTexture,
          toScreen: (gx, gy) => groundToScreen(hm, gx, gy),
          createEntity: (key, gx, gy, o) => addEntity(key, gx, gy, {
            footprint: o.footprint, target: o.targetId ? animalTarget(o.targetId) : undefined,
          }) as FarmEntity | null,
          setEntityVisible: (e, visible) => {
            e.sprite.visible = visible;
            if (e.shadow) shadows.setVisible(e.shadow, visible);
            if (e.glow) e.glow.visible = visible;
          },
          onSelect: animalsInteractiveRef.current ? (id) => selectRef.current(animalTarget(id)) : null,
          isDragging: () => dragMoved,
        })
        : null;
      if (animalLayer) {
        animalLayer.reduced = reducedRef.current;
        if (animalsRef.current) animalLayer.apply(animalsRef.current);
      }

      // seasonal + weather particles over the island (world space) and the rainbow behind it
      const seasonFx = new SeasonFx({ x0: terrainX + terrainW * 0.04, y0: terrainY - terrainH * 0.08, x1: terrainX + terrainW * 0.96, y1: terrainY + terrainH * 0.62 }, narrow);
      const ww0 = weatherWeights(currentSeason, gameplay ? weatherRef.current?.kind : undefined);
      const fxFade: Record<FxKind, Fade> = {
        petal: new Fade(currentSeason === "spring" ? 1 : 0), fluff: new Fade(currentSeason === "summer" ? 1 : 0),
        leaf: new Fade(currentSeason === "autumn" ? 1 : 0), snow: new Fade(currentSeason === "winter" ? 0.45 + 0.55 * ww0.snowfall : 0),
        rain: new Fade(ww0.drops),
      };
      const rainFade = new Fade(ww0.rain);
      const rainbowFade = new Fade(ww0.rainbow, 3.2);
      const seasonW: Record<SeasonName, Fade> = {
        spring: new Fade(currentSeason === "spring" ? 1 : 0), summer: new Fade(currentSeason === "summer" ? 1 : 0),
        autumn: new Fade(currentSeason === "autumn" ? 1 : 0), winter: new Fade(currentSeason === "winter" ? 1 : 0),
      };
      if (!gameplay) Object.values(fxFade).forEach((f) => (f.value = 0)); // the approved preview has no particles
      const rainbowLayer = new Container();
      rainbowLayer.label = "rainbow";
      rainbowLayer.eventMode = "none";
      seasonFx.rainbow.position.set(islandCentre.x + terrainW * 0.38, islandCentre.y - terrainH * 0.08);
      seasonFx.rainbow.scale.set((terrainW * 1.1) / 1024);
      rainbowLayer.addChild(seasonFx.rainbow);

      // pond (invisible hit area over the water) + pond life
      const water = (LAYOUT.pond as unknown as { water: Array<[number, number]> }).water;
      const pondZ = groundHeight(hm, LAYOUT.pond.center[0], LAYOUT.pond.center[1]);
      const pondHit = new Graphics();
      const waterScreen = water.flatMap(([gx, gy]) => {
        const p = gridToScreen(gx, gy);
        return [p.x, p.y + 10];
      });
      pondHit.poly(waterScreen);
      pondHit.fill({ color: 0xffffff, alpha: 0.001 });
      pondHit.eventMode = "static";
      pondHit.cursor = "pointer";
      pondHit.hitArea = new Polygon(waterScreen);
      pondHit.on("pointertap", (ev: FederatedPointerEvent) => {
        ev.stopPropagation();
        if (!dragMoved) selectRef.current(TARGETS.pond);
      });
      groundFx.addChild(pondHit);
      const fishTex = Object.values(manifest.fish).map((f) => wtex(f.file)).filter((t): t is Texture => !!t);
      const pxPerBU = Object.values(manifest.fish)[0]?.pxPerBU ?? 80;
      const pond = new PondLife(water, (0.13 - pondZ) * 78.38 + 4, fishTex, pxPerBU, soft, ring);
      groundFx.addChildAt(pond.root, 0);

      // ambient fx anchor points derived from the rendered assets
      const cottage = entityById.get("farmhouse");
      const kt = entityById.get("knowledge_tree");
      const lamp = entityById.get("prop_lantern");
      // offsets measured from the Blender models (chimney top, heartwood hollow), times instance scale
      const cs = cottage ? cottage.sprite.scale.x / (manifest.sprites.cottage?.scale ?? 1) : 1;
      const ks = kt ? kt.sprite.scale.x / (manifest.sprites.knowledge_tree?.scale ?? 1) : 1;
      const chimney = cottage ? { x: cottage.baseX + 86 * cs, y: cottage.baseY - 236 * cs } : { x: 0, y: 0 };
      const runeOrigin = kt ? { x: kt.baseX + 2 * ks, y: kt.baseY - 88 * ks } : { x: 0, y: 0 };

      // local light sources (rendered into the light map; the grade lights albedo with them):
      // 1 sun / moon (grade) · 2 cottage + lantern (warm, human scale) · 4 heartwood (cyan, restrained)
      const lights: LocalLight[] = [];
      // one smooth falloff for every local light and lamp halo (baked once, released with the generated textures)
      const falloff = lightFalloffTexture(128);
      generated.push(falloff);
      // the lantern hangs from the arm, left of the pole: its box sits 24 px left of and 98 px above the pole's foot
      // (measured on the sprite at instance scale 1). Light belongs to the lantern, not to the pole.
      const ls = lamp ? lamp.sprite.scale.x / (manifest.sprites.lamppost?.scale ?? 1) : 1;
      const lantern = lamp ? { x: lamp.baseX - 24 * ls, y: lamp.baseY - 98 * ls } : null;
      const lampHalos: Array<{ s: Sprite; alpha: number; r: number }> = [];
      if (lamp && lantern) {
        // a warm pool on the ground straight below the lantern and a small spill on the pole / grass around its head.
        // Their sum stays below 1 in the 8-bit light map: nothing saturates into a plateau (the old 1.0 + 0.8 did).
        lights.push({ x: lantern.x, y: lamp.baseY + 8 * ls, r: 250 * ls, color: 0xffbd70, intensity: 0.74 });
        lights.push({ x: lantern.x, y: lantern.y, r: 100 * ls, color: 0xffc784, intensity: 0.4, round: true });
        // the lantern's own halo: two additive sprites of the shared falloff (a close warm bloom and a faint wide
        // corona). They are not bound to the lamp sprite's box, so nothing can cut them into a lit rectangle; no filter,
        // no render target, no per-frame allocation.
        ([[30, 0.42, 0xffd7a0], [104, 0.13, 0xffb565]] as const).forEach(([r, alpha, tint]) => {
          const s = new Sprite(falloff);
          s.anchor.set(0.5);
          s.position.set(lantern.x, lantern.y);
          s.scale.set((2 * r * ls) / falloff.width);
          s.tint = tint;
          s.blendMode = "add";
          s.alpha = 0;
          s.eventMode = "none";
          emissive.addChild(s);
          lampHalos.push({ s, alpha, r: r * ls });
        });
      }
      if (cottage) {
        lights.push({ x: cottage.baseX + 70 * cs, y: cottage.baseY + 70 * cs, r: 230, color: 0xffad55, intensity: 0.9 });
        lights.push({ x: cottage.baseX - 95 * cs, y: cottage.baseY + 62 * cs, r: 190, color: 0xffad55, intensity: 0.75 });
        lights.push({ x: cottage.baseX - 10 * cs, y: cottage.baseY - 70 * cs, r: 200, color: 0xffb666, intensity: 0.45, round: true });
      }
      if (kt) {
        // deep-teal heartwood light: a soft pool on the roots / ground and a small spill on the bark around
        // the opening (albedo x light, so the wood itself is lit, never covered by a glow)
        lights.push({ x: kt.baseX - 8, y: kt.baseY + 14, r: 300, color: 0x3fcfc0, intensity: 0.5, key: "heart" });
        lights.push({ x: runeOrigin.x, y: runeOrigin.y + 10, r: 120, color: 0x5fe0cf, intensity: 0.42, round: true, key: "heart" });
      }
      // 5 the pond catches a faint cool glint of the moon (night only; keyed so sunset leaves it dark)
      const pondC = groundToScreen(hm, LAYOUT.pond.center[0], LAYOUT.pond.center[1]);
      lights.push({ x: pondC.x - 40, y: pondC.y - 6, r: 210, color: 0x9fb8ff, intensity: 0.42, key: "moon" });
      const lightMap = graded ? new LightMap(app.renderer, falloff, lights) : null;
      const grade = graded && lightMap ? new GradeFilter(lightMap.texture) : null;
      if (grade) scene.filters = [grade.filter];

      // screen-space sky light: a soft cool vignette at night, warm at sunset (atmosphere, not a recolour)
      const vignetteTex = (() => {
        const c = document.createElement("canvas");
        c.width = c.height = 256;
        const ctx = c.getContext("2d");
        if (ctx) {
          const g = ctx.createRadialGradient(128, 118, 40, 128, 128, 182);
          g.addColorStop(0, "rgba(0,0,0,0)");
          g.addColorStop(1, "rgba(0,0,0,1)");
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, 256, 256);
        }
        return Texture.from(c);
      })();
      generated.push(vignetteTex);
      const vignette = new Sprite(vignetteTex);
      vignette.eventMode = "none";
      vignette.alpha = 0;
      stage.addChild(vignette);

      // Knowledge Tree: one seamless glow layer that breathes slowly (no sliced bands: a slice edge
      // crossing the heartwood hollow read as a hard seam)
      const ktGlow = kt?.glow ?? null;
      // Phase 3B: the monument follows the server's era and ornament tiers (gameplay only)
      const monumentLayer = gameplay && kt
        ? new MonumentLayer({
          manifest, shadows, soft, entities, emissive, tree: kt, loadTexture: loadWorldTexture,
          trackTint: (s) => tintables.push(s),
          onRetexture: (entry) => {
            // the canopy touch target follows the era's silhouette
            kt.sprite.hitArea = new Ellipse(-entry.ax + entry.w * 0.5, -entry.ay + entry.h * 0.42, entry.w * 0.42, entry.h * 0.42);
          },
        })
        : null;
      if (monumentLayer) {
        monumentLayer.reduced = reducedRef.current;
        if (monumentRef.current) monumentLayer.apply(monumentRef.current);
      }

      // Phase 3E (gameplay only): what the island wears — vegetation / fence / bed / path appearances, the monument
      // set, the decorations that stand — and the placement preview
      const toGrid = (x: number, y: number) => {
        let gx = 0;
        let gy = 0;
        let z = 0;
        for (let i = 0; i < 3; i++) {
          const yy = y + z * hm.pxPerUnitZ;
          gx = (x / 64 + yy / 32) / 2;
          gy = (yy / 32 - x / 64) / 2;
          z = groundHeight(hm, gx, gy);
        }
        return { gx, gy };
      };
      const ktPlace = LAYOUT.sprites.find((sp) => sp.id === "knowledge_tree");
      const cosmeticLayer = gameplay
        ? new CosmeticLayer({
          manifest, groundFx, entities, emissive, loadTexture: loadWorldTexture,
          createEntity: (key, gx, gy, o) => {
            const e = addEntity(key, gx, gy, {
              layer: o.ground ? groundObjects : undefined, scale: o.scale, footprint: o.footprint,
              target: o.targetId ? decorTarget(o.targetId) : undefined, focusId: o.targetId,
            });
            if (e && o.z !== undefined) e.sprite.zIndex = o.z;
            return e as CosmeticEntity | null;
          },
          removeEntity: (e) => removeEntity(e as Entity),
          retexture: (e, art) => retexture(e as Entity, art),
          ownArt: (baseKey) => artFor(baseKey, currentSeason),
          vegetation: dressable as CosmeticEntity[],
          fences: fenceEntities as CosmeticEntity[],
          beds: () => bedEntities as CosmeticEntity[],
          paths: LAYOUT.paths,
          tree: (kt ?? null) as CosmeticEntity | null,
          treeGrid: ktPlace ? { gx: ktPlace.gx, gy: ktPlace.gy } : null,
          groundToScreen: (gx, gy) => groundToScreen(hm, gx, gy),
          toGrid,
          worldPoint: (ev) => world.toLocal(ev.global),
          isDragging: () => dragMoved,
          setHouseTheme: (theme) => estateLayer?.setHouseTheme(theme),
          onCandidate: (cand) => candidateRef.current?.(cand),
          onChanged: () => applyLook(),
          trackTint: (sp) => tintables.push(sp),
        })
        : null;
      cosmeticLayerRef.current = cosmeticLayer;
      if (cosmeticLayer) {
        cosmeticLayer.reduced = reducedRef.current;
        if (cosmeticsRef.current) cosmeticLayer.apply(cosmeticsRef.current);
        if (placementRef.current) cosmeticLayer.setPreview(placementRef.current);
      }

      const meadowA = gridToScreen(16, 18);
      const fx = new AmbientFx(
        soft,
        chimney,
        runeOrigin,
        { x0: meadowA.x - 900, y0: meadowA.y - 700, x1: meadowA.x + 600, y1: meadowA.y + 100 },
        [gridToScreen(5.5, 10.5), gridToScreen(9, 5), gridToScreen(17, 20), gridToScreen(20, 12), gridToScreen(14, 15)],
      );
      // smoke is lit like the world; motes, heartwood letters and fireflies are light themselves
      fxLayer.addChild(fx.front);
      emissive.addChild(fx.glowLayer, fx.runeLayer);
      // smoke must sit above the roof but tint with the world (fallback renderer)
      tintables.push(fx.front as unknown as { tint: number });

      // whale
      const orbitCentre = { x: terrainX + terrainW * 0.5, y: terrainY + terrainH * 0.37 };
      const orbitRadii = { a: terrainW * 0.6, b: terrainH * 0.46 };
      const whale: EchoWhale3D | EchoWhale = whale3D
        ? new EchoWhale3D(orbitCentre, orbitRadii, soft, 1.0, narrow ? "low" : "high")
        : new EchoWhale(
          whaleAtlas ? wtex(whaleAtlas.file) : null,
          manifest.whale && whaleAtlas
            ? { yaws: manifest.whale.yaws, frames: manifest.whale.frames, lengthBU: manifest.whale.lengthBU, scale: whaleAtlas.scale, rects: whaleAtlas.rects }
            : null,
          orbitCentre,
          orbitRadii,
          soft,
          1.0,
        );
      frontLayer.addChild(whale.root);
      whale.root.on("pointertap", (ev: FederatedPointerEvent) => {
        ev.stopPropagation();
        if (!dragMoved) selectRef.current(TARGETS.echo_whale);
      });

      // debug overlay (QA only, hidden): plots green, walkways yellow, future fields blue
      const debug = new Graphics();
      const diamond = (gx: number, gy: number) => {
        const c = gridToScreen(gx, gy);
        return [c.x, c.y - 32, c.x + 64, c.y, c.x, c.y + 32, c.x - 64, c.y];
      };
      LAYOUT.starterPlots.forEach((p) => debug.poly(diamond(p.gx, p.gy)).fill({ color: 0x22c55e, alpha: 0.25 }).stroke({ width: 2, color: 0x22c55e }));
      LAYOUT.farmWalkways.forEach(([gx, gy]) => debug.poly(diamond(gx, gy)).stroke({ width: 1.5, color: 0xeab308 }));
      LAYOUT.futureFields.forEach((f) => {
        const [x0, y0, x1, y1] = f.rect;
        const pts = [gridToScreen(x0, y0), gridToScreen(x1, y0), gridToScreen(x1, y1), gridToScreen(x0, y1)];
        debug.poly(pts.flatMap((q) => [q.x, q.y])).fill({ color: 0x3b82f6, alpha: 0.18 }).stroke({ width: 1.5, color: 0x3b82f6 });
      });
      debug.visible = false;
      fxLayer.addChild(debug);
      fxLayer.addChild(seasonFx.root);
      rainbowRoot.addChild(rainbowLayer);
      world.addChild(hitLayer);

      /* ---------------- camera ---------------- */
      const cam = new CameraController();
      cam.bounds = {
        minX: terrainX + terrainW * 0.08,
        maxX: terrainX + terrainW * 0.92,
        minY: terrainY + terrainH * 0.05,
        maxY: terrainY + terrainH * 0.88,
      };
      const view: DepthView = { cx: 0, cy: 0, zoom: 1, fitZoom: 1, minRel: 0.85, W: 1, H: 1, home: islandCentre };
      const layoutCamera = (first: boolean) => {
        if (!app) return;
        const W = app.screen.width;
        const H = app.screen.height;
        const prevRel = cam.rel;
        cam.setViewport(W, H);
        cam.fitZoom = Math.min((W * 0.94) / terrainW, (H * 0.95) / terrainH);
        cam.maxRel = W < 760 ? 7 : 4.6;
        cam.minRel = W < 760 ? 0.9 : 0.85;
        if (first) {
          const home = homeView();
          cam.jump(home.x, home.y, cam.fitZoom * home.rel);
        } else {
          cam.target.zoom = cam.fitZoom * prevRel;
          cam.cur.zoom = cam.target.zoom;
        }
        sky.layout(W, H);
        overcast.width = W;
        overcast.height = H;
        vignette.width = W;
        vignette.height = H;
        view.W = W;
        view.H = H;
        view.fitZoom = cam.fitZoom;
        view.minRel = cam.minRel;
        cloudLayers.forEach((l) => l.layout(view));
        lightMap?.resize(W, H);
        if (grade) scene.filterArea = GradeFilter.area(W, H);
        cam.frameOffset = W < 640 ? { x: 0, y: -H * 0.2 } : { x: -170, y: 0 };
      };
      const homeView = () => {
        const W = app ? app.screen.width : 1200;
        if (W < 760) {
          const p = gridToScreen(11.8, 13.2);
          return { x: p.x, y: p.y + 40, rel: 1.9 };
        }
        return { x: islandCentre.x, y: islandCentre.y, rel: 1.0 };
      };
      layoutCamera(true);
      cam.snap = reducedRef.current;

      const reportZoom = () => {
        const rel = Math.round(cam.rel * 100) / 100;
        if (Math.abs(rel - lastReportedZoom.current) > 0.001) {
          lastReportedZoom.current = rel;
          zoomCbRef.current(rel);
        }
      };
      reportZoom();

      const focusTarget = (id: string | null) => {
        if (!id) {
          placeRing(selectRing, null, 0);
          return;
        }
        const f = FOCUS[id];
        const e = entityById.get(id);
        const cell = id.startsWith("expand_") ? expansionCells.get(Number(id.slice(7)))
          : id.startsWith("land_") ? landCells.get(Number(id.slice(5))) : undefined;
        if (id.startsWith("plot_") && e) {
          const z = Math.max(cam.rel, 2.6);
          cam.focus(e.baseX, e.baseY - 30, cam.fitZoom * z);
        } else if (cell) {
          const p = groundToScreen(hm, cell.gx, cell.gy);
          cam.focus(p.x, p.y - 30, cam.fitZoom * Math.max(cam.rel, 2.6));
        } else if (id === "echo_whale") {
          // keep the whale in view without chasing it
          return;
        } else if (f) {
          const p = groundToScreen(hm, f.gx, f.gy);
          const z = Math.max(cam.rel, f.zoom);
          cam.focus(p.x, p.y - (id === "knowledge_tree" ? 180 : 40), cam.fitZoom * z);
        } else if (e) {
          cam.focus(e.baseX, e.baseY - 60);
        }
      };
      const setSelectedRing = (id: string | null) => {
        const e = id ? entityById.get(id) ?? null : null;
        placeRing(selectRing, e, e ? 0.9 : 0);
      };
      /**
       * Season change: the new ground and vegetation art fade in over the old (≈1.6 s, smootherstep), then replace it.
       * Geometry, anchors of the base sprites and shadows are unchanged; only the current season's files are loaded.
       */
      const crossfades: Array<{ over: Sprite; base: Sprite; start: number; done: () => void }> = [];
      const fadeIn = (base: Sprite, tex: Texture, anchor: [number, number], scale: number, parent: Container, done: () => void) => {
        const over = new Sprite(tex);
        over.anchor.set(anchor[0], anchor[1]);
        over.position.copyFrom(base.position);
        over.scale.set(scale);
        over.zIndex = base.zIndex + 0.01;
        over.alpha = 0;
        over.eventMode = "none";
        // directly above the art it replaces (a satellite keeps its front cloud wisp in front)
        if (base.parent === parent) parent.addChildAt(over, parent.getChildIndex(base) + 1);
        else parent.addChild(over);
        crossfades.push({ over, base, start: performance.now() / 1000, done });
      };
      const applySeason = async (sn: SeasonName) => {
        if (sn === currentSeason || !gameplay) return;
        const prevSeason = currentSeason;
        currentSeason = sn;
        const tEntry = terrainFor(sn);
        const tTex = await loadWorldTexture(tEntry.file);
        if (destroyed || currentSeason !== sn) return;
        if (tTex && terrainSprite) {
          const base = terrainSprite;
          if (reducedRef.current) base.texture = tTex;
          else fadeIn(base, tTex, [0, 0], base.scale.x, terrainLayer, () => (base.texture = tTex));
        }
        for (const e of seasonal) {
          // Phase 3E: a plant wearing an equipped appearance keeps it through the seasons
          const art = cosmeticLayer && dressable.includes(e) ? cosmeticLayer.vegetationArt(e.key) : artFor(e.key, sn);
          if (art === e.art) continue;
          const entry = manifest.sprites[art];
          const tex = entry ? await loadWorldTexture(entry.file) : null;
          if (destroyed || currentSeason !== sn || !entry || !tex) continue;
          const anchor: [number, number] = [entry.ax / entry.w, entry.ay / entry.h];
          const k = entry.scale * e.instanceScale;
          const swapNow = () => {
            e.sprite.texture = tex;
            e.sprite.anchor.set(anchor[0], anchor[1]);
            e.sprite.scale.set(k);
            e.art = art;
          };
          if (reducedRef.current) swapNow();
          else fadeIn(e.sprite, tex, anchor, k, e.sprite.parent ?? entities, swapNow);
        }
        for (const it of satellites.items) {
          const art = artFor(it.cfg.key, sn);
          if (art === it.art) continue;
          const entry = manifest.sprites[art];
          const tex = entry ? await loadWorldTexture(entry.file) : null;
          if (destroyed || currentSeason !== sn || !entry || !tex) continue;
          const anchor: [number, number] = [entry.ax / entry.w, entry.ay / entry.h];
          const k = entry.scale * it.cfg.scale;
          const swapNow = () => {
            it.sprite.texture = tex;
            it.sprite.anchor.set(anchor[0], anchor[1]);
            it.sprite.scale.set(k);
            it.art = art;
          };
          if (reducedRef.current) swapNow();
          else fadeIn(it.sprite, tex, anchor, k, it.body, swapNow);
        }
        (Object.keys(seasonW) as SeasonName[]).forEach((x) => seasonW[x].set(x === sn ? 1 : 0, performance.now() / 1000));
        // only the current season stays resident: once the crossfades finished, release the previous season's terrain
        // and vegetation art that the new season does not use (shadows are shared and stay)
        const release = () => {
          if (destroyed || currentSeason !== sn) return;
          if (crossfades.length) {
            window.setTimeout(release, 400);
            return;
          }
          const fileOf = (key: string) => manifest.sprites[key]?.file;
          const keep = new Set([terrainFor(sn).file, ...seasonal.map((e) => fileOf(e.art)), ...satellites.items.map((it) => fileOf(it.art))]);
          const drop = new Set([terrainFor(prevSeason).file, ...seasonal.map((e) => fileOf(artFor(e.key, prevSeason))),
            ...satellites.items.map((it) => fileOf(artFor(it.cfg.key, prevSeason)))]);
          drop.forEach((f) => {
            if (!f || keep.has(f)) return;
            const u = WORLD_BASE + f;
            if (!textures[u]) return;
            delete textures[u];
            loadedUrls = loadedUrls.filter((x) => x !== u);
            feathered.get(u)?.destroy(true);
            feathered.delete(u);
            Assets.unload(u).catch(() => undefined);
          });
        };
        window.setTimeout(release, 1800);
      };

      sceneRef.current = {
        camera: cam,
        focusTarget,
        goHome: () => {
          const h = homeView();
          cam.focus(h.x, h.y, cam.fitZoom * h.rel);
          // home framing ignores the inspect-card offset
          cam.target.x = h.x;
          cam.target.y = h.y;
        },
        reportZoom,
        setSelectedRing,
        applyFarm: (visuals) => {
          // a bed bought during play appears before its first crop (exactly once per slot)
          for (const v of visuals) if (expansionCells.has(v.slot)) ownBed(v.slot);
          for (const v of visuals) if (landCells.has(v.slot)) ownBed(v.slot);
          if (hintSlot !== null && farmLayer?.hasBed(hintSlot)) setExpansionHint(null);
          farmLayer?.apply(visuals);
        },
        playFarmFx: (kind, slot) => farmLayer?.fx(kind, slot),
        applySeason: (sn) => void applySeason(sn),
        applyLiving: (v) => living?.apply(v),
        setExpansionHint,
        applyMonument: (v) => monumentLayer?.apply(v),
        celebrate: () => {
          monumentLayer?.celebrate();
          whale.cheer();
        },
        applyEstate: (v) => estateLayer?.apply(v),
        applyCosmetics: (v) => cosmeticLayer?.apply(v),
        setPlacement: (p) => cosmeticLayer?.setPreview(p),
        applyAnimals: (v) => animalLayer?.apply(v),
        cheerAnimals: (target) => animalLayer?.celebrate(target),
      };
      /** The drawn bounds of a world object under the current camera, in client px (see {@link GardenSceneApi}). */
      const targetClientRect = (id: string) => {
        if (!app || destroyed) return null;
        const r = app.canvas.getBoundingClientRect();
        const SW = app.screen.width;
        const SH = app.screen.height;
        const k = SW > 0 ? r.width / SW : 1;
        // `area`: a wide place (the farm) counts with whatever part of it is in view; a single object must be mostly in
        // view, else the guide asks the camera to go there instead of pointing at a sliver
        const box = (x0: number, y0: number, x1: number, y1: number, area = false) => {
          const ax = Math.max(0, x0), ay = Math.max(0, y0), bx = Math.min(SW, x1), by = Math.min(SH, y1);
          if (bx - ax < 12 || by - ay < 12 || (!area && (bx - ax) * (by - ay) < 0.45 * (x1 - x0) * (y1 - y0))) return null;
          return { x: r.left + ax * k, y: r.top + ay * k, w: (bx - ax) * k, h: (by - ay) * k };
        };
        const of = (ids: string[], area = false) => {
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const one of ids) {
            const e = entityById.get(one);
            if (!e || !e.sprite.visible || e.sprite.destroyed) continue;
            const b = e.sprite.getBounds();
            x0 = Math.min(x0, b.minX); y0 = Math.min(y0, b.minY); x1 = Math.max(x1, b.maxX); y1 = Math.max(y1, b.maxY);
          }
          return x1 > x0 ? box(x0, y0, x1, y1, area) : null;
        };
        if (id === "island") {
          const a = world.toGlobal({ x: terrainX + terrainW * 0.14, y: terrainY + terrainH * 0.12 });
          const b = world.toGlobal({ x: terrainX + terrainW * 0.86, y: terrainY + terrainH * 0.78 });
          const ax = Math.max(0, a.x), ay = Math.max(0, a.y), bx = Math.min(SW, b.x), by = Math.min(SH, b.y);
          return bx - ax < 40 || by - ay < 40 ? null : { x: r.left + ax * k, y: r.top + ay * k, w: (bx - ax) * k, h: (by - ay) * k };
        }
        if (id === "farm_zone") return of([...entityById.keys()].filter((x) => x.startsWith("plot_")), true);
        const hit = of([id]);
        if (hit) return hit;
        const f = FOCUS[id];
        if (!f) return null;
        const g = world.toGlobal(groundToScreen(hm, f.gx, f.gy));
        const half = 90 * world.scale.x;
        return box(g.x - half, g.y - half * 1.3, g.x + half, g.y + half * 0.6);
      };
      sceneReadyRef.current?.({ targetClientRect });
      cleanups.push(() => sceneReadyRef.current?.(null));
      if (farmLayer) {
        farmReadyRef.current?.({
          bedClientPoint: (slot) => {
            const p = farmLayer.bedPoint(slot);
            if (!p || !app) return null;
            const g = world.toGlobal(p);
            const r = app.canvas.getBoundingClientRect();
            return { x: r.left + g.x, y: r.top + g.y };
          },
        });
        cleanups.push(() => farmReadyRef.current?.(null));
      }

      /* ---------------- input: drag / inertia / wheel / pinch ---------------- */
      const canvas = app.canvas;
      const pointers = new Map<number, { x: number; y: number }>();
      let lastMove = performance.now();
      let downPos = { x: 0, y: 0 };
      let pinchDist = 0;
      const local = (ev: PointerEvent | WheelEvent) => {
        const r = canvas.getBoundingClientRect();
        return { x: ev.clientX - r.left, y: ev.clientY - r.top };
      };
      const onDown = (ev: PointerEvent) => {
        const p = local(ev);
        pointers.set(ev.pointerId, p);
        if (pointers.size === 1) {
          dragMoved = false;
          downPos = p;
          cam.beginDrag();
          lastMove = performance.now();
        } else if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        }
      };
      const onMove = (ev: PointerEvent) => {
        const prev = pointers.get(ev.pointerId);
        if (!prev) return;
        const p = local(ev);
        const now = performance.now();
        if (pointers.size === 1) {
          if (Math.hypot(p.x - downPos.x, p.y - downPos.y) > 6) dragMoved = true;
          if (dragMoved) {
            cam.dragBy(p.x - prev.x, p.y - prev.y, (now - lastMove) / 1000);
            canvas.style.cursor = "grabbing";
          }
        } else if (pointers.size === 2) {
          dragMoved = true;
          pointers.set(ev.pointerId, p);
          const [a, b] = [...pointers.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (pinchDist > 0 && d > 0) {
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            cam.zoomTo(cam.target.zoom * (d / pinchDist), mid);
            cam.cur.zoom = cam.target.zoom;
            reportZoom();
          }
          pinchDist = d;
        }
        pointers.set(ev.pointerId, p);
        lastMove = now;
      };
      const onUp = (ev: PointerEvent) => {
        pointers.delete(ev.pointerId);
        if (pointers.size === 0) {
          cam.endDrag();
          canvas.style.cursor = "";
        }
        if (pointers.size < 2) pinchDist = 0;
      };
      const onWheel = (ev: WheelEvent) => {
        ev.preventDefault();
        const p = local(ev);
        const factor = Math.exp(-ev.deltaY * 0.0016);
        cam.zoomTo(cam.target.zoom * factor, p);
        reportZoom();
      };
      canvas.addEventListener("pointerdown", onDown);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      canvas.addEventListener("wheel", onWheel, { passive: false });
      cleanups.push(() => {
        canvas.removeEventListener("pointerdown", onDown);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        canvas.removeEventListener("wheel", onWheel);
      });
      stage.eventMode = "static";
      stage.hitArea = app.screen;
      stage.on("pointertap", () => {
        if (!dragMoved && selectedRef.current) selectRef.current(null);
      });

      /* ---------------- environment: clock, wind, light rig ---------------- */
      const clock = new EnvironmentClock();
      clock.reduced = reducedRef.current;
      const onVisibility = () => {
        clock.paused = document.hidden;
      };
      document.addEventListener("visibilitychange", onVisibility);
      cleanups.push(() => document.removeEventListener("visibilitychange", onVisibility));
      const tod = new TimeOfDayBlend(timeRef.current);
      let look: Look = blendLook(tod.w);
      let ktGlowBase = 0.12;

      /** Apply everything that depends only on the time-of-day weights (not on animation time). */
      const atmos = () => ({
        season: { spring: seasonW.spring.value, summer: seasonW.summer.value, autumn: seasonW.autumn.value, winter: seasonW.winter.value },
        weather: { rain: rainFade.value, rainbow: rainbowFade.value },
      });
      const applyLook = () => {
        const a = atmos();
        look = applyAtmosphere(blendLook(tod.w), a.season, a.weather);
        const w = tod.w;
        const sum = w.day + w.sunset + w.night || 1;
        const ws = w.sunset / sum;
        const wn = w.night / sum;
        if (!graded) {
          const blend3 = (k: "world" | "cloud") =>
            lerpColor(lerpColor(FALLBACK_TINT.day[k], FALLBACK_TINT.sunset[k], ws / Math.max(0.001, 1 - wn)), FALLBACK_TINT.night[k], wn);
          const worldTint = blend3("world");
          tintables.forEach((o) => (o.tint = worldTint));
          whale.root.tint = worldTint;
          cloudLayers.forEach((l) => l.setTint(blend3("cloud")));
          satellites.setTint(worldTint);
        }
        // the Knowledge Tree's heart keeps a faint glow even by day
        ktGlowBase = 0.12 + 0.6 * look.glow;
        entityList.forEach((e) => {
          if (!e.glow || e === kt) return;
          e.glow.alpha = look.glow;
        });
        // the lamp's halo follows the emissive level (0 by day); wet air scatters it a little wider under rain
        lampHalos.forEach((h, i) => {
          h.s.alpha = h.alpha * look.glow * (1 + 0.3 * a.weather.rain * i);
          h.s.scale.set((2 * h.r * (1 + 0.14 * a.weather.rain * i)) / falloff.width);
        });
        vignette.tint = lerpColor(0x4a2418, 0x050a24, wn / Math.max(0.001, ws + wn));
        vignette.alpha = look.vignette;
        // sun shadows by day, long soft warm ones at sunset, faint moon shadows at night
        shadows.sprite.alpha = look.shadowAlpha;
        shadows.setStretch(look.shadowStretch);
        fx.nightMix = wn + ws * 0.2;
        lightMap?.setModulation("moon", wn);
      };
      applyLook();

      /* ---------------- ticker ---------------- */
      const frameTimes: number[] = [];
      const onTick = () => {
        if (!app) return;
        frameTimes.push(app.ticker.deltaMS);
        if (frameTimes.length > 240) frameTimes.shift();
        const still = reducedRef.current;
        cam.snap = still;
        clock.reduced = still;
        const dt = clock.advance(app.ticker.deltaMS / 1000);
        const t = clock.t;

        // time of day: one eased, deterministic transition of the whole light rig
        const nowS = performance.now() / 1000;
        tod.request(timeRef.current, nowS);
        let relook = tod.update(nowS, still);
        // season + weather: smooth weights (light, particles, rainbow); the season art itself crossfades separately
        if (gameplay) {
          const ww = weatherWeights(currentSeason, weatherRef.current?.kind);
          rainFade.set(ww.rain, nowS);
          rainbowFade.set(ww.rainbow, nowS);
          fxFade.petal.set(currentSeason === "spring" ? 1 : 0, nowS);
          fxFade.fluff.set(currentSeason === "summer" ? 1 : 0, nowS);
          fxFade.leaf.set(currentSeason === "autumn" ? 1 : 0, nowS);
          fxFade.snow.set(currentSeason === "winter" ? 0.45 + 0.55 * ww.snowfall : 0, nowS);
          fxFade.rain.set(ww.drops, nowS);
          const before = rainFade.value + rainbowFade.value + seasonW.winter.value + seasonW.autumn.value + seasonW.spring.value;
          rainFade.update(nowS, still);
          rainbowFade.update(nowS, still);
          (Object.keys(seasonW) as SeasonName[]).forEach((x) => seasonW[x].update(nowS, still));
          const after = rainFade.value + rainbowFade.value + seasonW.winter.value + seasonW.autumn.value + seasonW.spring.value;
          if (Math.abs(after - before) > 1e-6) relook = true;
          (Object.keys(fxFade) as FxKind[]).forEach((k) => (seasonFx.weights[k] = still ? 0 : fxFade[k].update(nowS, still)));
          seasonFx.rainbow.alpha = rainbowFade.value * (1 - 0.6 * (tod.w.night ?? 0));
          overcast.alpha = 0.86 * rainFade.value * (1 - 0.5 * (tod.w.night ?? 0));
        }
        if (relook) applyLook();
        for (let i = crossfades.length - 1; i >= 0; i--) {
          const c = crossfades[i];
          const u = Math.min(1, (nowS - c.start) / 1.6);
          c.over.alpha = u * u * (3 - 2 * u);
          c.over.skew.x = c.base.skew.x;
          c.over.position.copyFrom(c.base.position);
          if (u >= 1) {
            c.done();
            c.over.destroy();
            crossfades.splice(i, 1);
          }
        }

        // dynamic shadow composition (no-op unless an object or the sun height changed)
        shadows.update();

        // camera + depth layers (each layer computes its own transform; none follows the island's)
        cam.update(still ? 1 : Math.min(0.05, app.ticker.deltaMS / 1000));
        const W = app.screen.width;
        const H = app.screen.height;
        view.cx = cam.cur.x;
        view.cy = cam.cur.y;
        view.zoom = cam.cur.zoom;
        applyDepth(world, view, 1);
        emissive.position.copyFrom(world.position);
        emissive.scale.copyFrom(world.scale);
        cloudLayers.forEach((l) => l.update(t, view));
        satellites.update(t, view);
        applyDepth(rainbowRoot, view, RAINBOW_DEPTH);

        // sky + light (sun position also drives the scattering veil)
        sky.update(tod.w, look, t);
        if (grade && lightMap) {
          if (look.lights > 0.01) lightMap.render(world);
          grade.apply(look, sky.sunPx, W, H);
        }

        // vegetation: one wind field, gusts travelling across the island (skew keeps the base planted)
        for (const e of entityList) {
          if (!e.sway) continue;
          e.sprite.skew.x = Wind.sway(t, e.baseX, e.seed) * e.sway;
          if (e.glow) e.glow.skew.x = e.sprite.skew.x;
        }
        // Knowledge Tree: the heartwood light breathes organically (incommensurate slow pulses)
        const breath = 0.86 + 0.07 * Math.sin(t * 1.13) + 0.05 * Math.sin(t * 0.53 + 1.2)
          + 0.2 * Math.pow(Math.max(0, Math.sin(t * 0.21 + 0.6 * Math.sin(t * 0.07))), 4);
        if (farmLayer) {
          farmLayer.reduced = still;
          farmLayer.update(performance.now() / 1000, t);
        }
        expansionHint.alpha = hintSlot === null ? 0 : still ? 0.55 : 0.42 + 0.18 * Math.sin(t * 1.6);
        if (estateLayer) {
          estateLayer.reduced = still;
          estateLayer.update(t);
        }
        if (animalLayer) {
          animalLayer.reduced = still;
          animalLayer.update(t);
        }
        if (living) {
          living.reduced = still;
          living.update(t);
        }
        if (gameplay) seasonFx.update(t);
        if (cosmeticLayer) {
          cosmeticLayer.reduced = still;
          cosmeticLayer.update(t, look.glow);
        }
        if (monumentLayer) {
          monumentLayer.reduced = still;
          monumentLayer.update(nowS, t, look.glow);
        }
        whale.attention = gameplay && echoAttentionRef.current;
        if (ktGlow) ktGlow.alpha = Math.min(1, ktGlowBase * breath);
        lightMap?.setModulation("heart", breath);
        if (dt > 0) {
          pond.update(dt);
          fx.update(dt);
          whale.update(dt);
          const wantLayer = whale.layer === "front" ? frontLayer : backLayer;
          if (whale.root.parent !== wantLayer) wantLayer.addChild(whale.root);
          if (selectRing.alpha > 0) selectRing.alpha = 0.7 + 0.25 * Math.sin(t * 3);
        }
      };
      app.ticker.add(onTick);
      cleanups.push(() => app?.ticker.remove(onTick));

      /* ---------------- resize ---------------- */
      const ro = new ResizeObserver(() => {
        if (!app || destroyed) return;
        app.resize();
        layoutCamera(false);
        applyLook();
      });
      ro.observe(host);
      cleanups.push(() => ro.disconnect());
      cleanups.push(() => {
        pond.destroy();
        fx.destroy();
        whale.destroy();
      });
      releases.push(() => {
        farmLayer?.destroy();
        living?.destroy();
        monumentLayer?.destroy();
        cosmeticLayer?.destroy();
        animalLayer?.destroy();
        seasonFx.destroy();
        shadows.destroy();
        cloudLayers.forEach((l) => l.destroy());
        satellites.destroy();
        sky.destroy();
        // the grade filter references the light map: release the filter first
        grade?.destroy();
        lightMap?.destroy();
      });

      /* ---------------- QA hooks (development builds only; never in production) ---------------- */
      if (process.env.NODE_ENV !== "production") {
        const plotStageKey = (id: string, stage: number) => `crop_${plotById.get(id)?.crop_}_s${stage}`;
        /** Replace one plot's crop art + its shadow (frontend-only art validation, no game state). */
        const setPlotStage = async (id: string, stage: number) => {
          const plot = plotById.get(id);
          if (!plot?.crop) return false;
          const key = plotStageKey(id, stage);
          const entry = manifest.sprites[key];
          if (!entry) return false;
          const t = await loadWorldTexture(entry.file);
          const st = entry.shadow ? await loadWorldTexture(entry.shadow.file) : null;
          if (!t || destroyed) return false;
          const e = plot.crop;
          e.key = key;
          e.sway = swayFor(key);
          e.sprite.texture = t;
          e.sprite.anchor.set(entry.ax / entry.w, entry.ay / entry.h);
          e.sprite.scale.set(entry.scale * e.instanceScale);
          if (entry.shadow && st) {
            const spec = { texture: st, ax: entry.shadow.ax, ay: entry.shadow.ay, scale: entry.shadow.scale };
            if (e.shadow) shadows.replace(e.shadow, spec, e.instanceScale);
            else e.shadow = shadows.add(spec, e.baseX, e.baseY, e.instanceScale);
          }
          plot.stage = stage;
          return true;
        };
        let magicOff = false;
        /** QA: switch every magical light of the Knowledge Tree off (heartwood glow, motes, letters, light
         *  pool) to judge the tree on its form alone. Development only; the tree sprite itself has no emission. */
        const setMagicVisible = (visible: boolean) => {
          magicOff = !visible;
          if (ktGlow) ktGlow.visible = visible;
          fx.setHeartVisible(visible);
          lightMap?.setModulation("heart", visible ? 1 : 0);
          return true;
        };
        app.ticker.add(() => {
          if (magicOff) lightMap?.setModulation("heart", 0);
        });
        /** Hide / show an object together with its shadow (no ghost may remain). */
        const setObjectVisible = (what: "crop" | "bed" | "fence" | "marker", id: string, visible: boolean) => {
          const plot = plotById.get(id);
          const e = what === "crop" ? plot?.crop
            : what === "bed" ? plot?.bed
              : what === "fence" ? fenceEntities[Number(id)] ?? null
                : fieldMarkers.get(id) ?? null;
          if (!e) return false;
          e.sprite.visible = visible;
          if (e.shadow) shadows.setVisible(e.shadow, visible);
          return true;
        };
        (window as unknown as { __echoGarden?: unknown }).__echoGarden = {
          ready: true,
          app,
          setDebugOverlay: (v: boolean) => (debug.visible = v),
          setView: (gx: number, gy: number, rel: number) => {
            const p = groundToScreen(hm, gx, gy);
            cam.jump(p.x, p.y, cam.fitZoom * rel);
            reportZoom();
          },
          /** centre the camera on a world point (zoom-1 px), e.g. the whale's current position */
          setViewWorld: (x: number, y: number, rel: number) => {
            cam.jump(x, y, cam.fitZoom * rel);
            reportZoom();
          },
          /** pin the environment clock (clouds, satellites, wind, magic) to an exact time; null releases */
          setEnvironmentTime: (sec: number | null) => clock.setFixed(sec),
          environmentTime: () => clock.t,
          /** the floating islands: one stable main island + the satellites (independent transforms) */
          islands: () => {
            const g = world.toGlobal({ x: islandCentre.x, y: islandCentre.y });
            return {
              total: 1 + satellites.items.length,
              main: { label: world.label, parentLabel: world.parent?.label ?? null, centreScreen: { x: Math.round(g.x * 10) / 10, y: Math.round(g.y * 10) / 10 }, worldX: world.x, worldY: world.y, scale: world.scale.x },
              satellites: satellites.debugState(),
            };
          },
          clouds: () => cloudLayers.map((l) => ({ id: l.cfg.id, depth: l.cfg.depth, parentLabel: l.root.parent?.label ?? null, x: l.root.x, y: l.root.y, scale: l.root.scale.x, clouds: l.debugClouds() })),
          lighting: () => ({
            weights: { ...tod.w },
            transitioning: tod.transitioning,
            graded,
            sun: sky.sunPx,
            celestial: celestial(tod.w),
            domes: sky.debugDomes(),
            tickerCount: app!.ticker.count,
            look,
            shadowStretch: shadows.currentStretch,
            shadowAlpha: shadows.sprite.alpha,
          }),
          /** where the guide would point for a world target right now (client px), or null */
          targetRect: (id: string) => targetClientRect(id),
          whaleWorld: () => ({ x: whale.root.x, y: whale.root.y }),
          setWhalePhase: (phi: number) => {
            (whale as unknown as { phi: number }).phi = phi;
            whale.update(0, true);
          },
          setPlotStage,
          setObjectVisible,
          setMagicVisible,
          whaleScreen: () => {
            const g = whale.root.getGlobalPosition();
            return { x: g.x, y: g.y, layer: whale.layer, ...whale.debugState() };
          },
          /** GPU texture memory estimate (RGBA8, +1/3 for mipmapped sources) */
          textureMemoryMB: () => {
            const managed = (app!.renderer.texture as unknown as { managedTextures: Array<{ pixelWidth: number; pixelHeight: number; autoGenerateMipmaps?: boolean } | null> }).managedTextures ?? [];
            const sources = managed.filter((x): x is NonNullable<typeof x> => !!x);
            const bytes = sources.reduce((a, s) => a + s.pixelWidth * s.pixelHeight * 4 * (s.autoGenerateMipmaps ? 4 / 3 : 1), 0);
            return { sources: sources.length, mb: Math.round((bytes / 1048576) * 10) / 10 };
          },
          /** composed shadow factor (255 = unshadowed) at the strongest point of a caster's shadow */
          shadowAt: (gx: number, gy: number, dxPx = 0, dyPx = 0) => {
            const p = groundToScreen(hm, gx, gy);
            return shadows.sample(p.x + dxPx, p.y + dyPx);
          },
          /** world -> client px (for click-target checks at any zoom) */
          gridToClient: (gx: number, gy: number) => {
            const p = groundToScreen(hm, gx, gy);
            const g = world.toGlobal({ x: p.x, y: p.y });
            const r = app!.canvas.getBoundingClientRect();
            return { x: r.left + g.x, y: r.top + g.y };
          },
          hitTestClient: (x: number, y: number) => {
            const r = app!.canvas.getBoundingClientRect();
            const boundary = app!.renderer.events.rootBoundary;
            if (!boundary.rootTarget) boundary.rootTarget = app!.stage;
            const hitObj = boundary.hitTest(x - r.left, y - r.top);
            return hitObj?.label ?? null;
          },
          frameStats: () => {
            const n = frameTimes.length || 1;
            const avg = frameTimes.reduce((a, b) => a + b, 0) / n;
            const sorted = [...frameTimes].sort((a, b) => a - b);
            return { avgMs: avg, fps: 1000 / avg, p95Ms: sorted[Math.floor(n * 0.95)] ?? avg, samples: n };
          },
          /** gameplay feedback in flight (pooled particles + rings); null in the visual preview */
          farmStats: () => (farmLayer ? { activeFx: farmLayer.activeParticles() } : null),
          /** Phase 2 QA: grove / forest / pest art at any stage (frontend-only art validation, no game state) */
          previewLiving: (v: LivingVisuals) => living?.apply(v),
          /** Phase 2 QA: season art / weather presentation without changing any game state */
          setSeason: (sn: SeasonName) => {
            qaSeasonRef.current = sn;
            void applySeason(sn);
          },
          setWeather: (kind: "SUNNY" | "RAIN" | "RAINBOW") => {
            qaWeatherRef.current = { kind };
            weatherRef.current = { kind };
          },
          livingStats: () => ({
            season: currentSeason,
            ...(living ? living.stats() : { trees: 0, forest: 0, pests: 0 }),
            particles: seasonFx.visibleCount(),
            rainbow: seasonFx.rainbow.alpha,
            weather: weatherRef.current?.kind ?? null,
            rain: rainFade.value,
            overcast: overcast.alpha,
            gameplay,
            crossfades: crossfades.length,
          }),
          /** Phase 3B QA: the monument's era / ornaments and a celebration without changing any game state */
          setMonument: (v: MonumentVisuals | null) => {
            qaMonumentRef.current = v;
            if (v) monumentLayer?.apply(v);
            return true;
          },
          celebrate: () => {
            monumentLayer?.celebrate();
            whale.cheer();
          },
          monumentStats: () => (monumentLayer ? monumentLayer.stats() : null),
          /** Phase 3C QA: building levels / farmland states without changing any game state, and what the scene shows */
          setEstate: (v: EstateVisuals | null) => {
            qaEstateRef.current = v;
            if (v) estateLayer?.apply(v);
            return true;
          },
          estateStats: () => (estateLayer ? { ...estateLayer.stats(), damage: farmLayer?.damageStats() ?? [] } : null),
          // Phase 3H: QA presentation of the animal quarter (art only; nothing is granted or stored)
          setAnimals: (v: AnimalVisuals | null) => {
            qaAnimalsRef.current = v;
            if (v) animalLayer?.apply(v);
          },
          animalStats: () => (animalLayer ? animalLayer.stats() : null),
          /** Phase 3E QA: what the island wears (presentation only: no game state is touched) and the placement preview */
          setCosmetics: (v: CosmeticVisuals | null) => {
            qaCosmeticsRef.current = v;
            if (v) cosmeticLayer?.apply(v);
            return true;
          },
          cosmeticStats: () => (cosmeticLayer ? cosmeticLayer.stats() : null),
          previewDecor: (p: PlacementPreview | null) => {
            cosmeticLayer?.setPreview(p);
            return true;
          },
          chooseDecorSpot: (gx: number, gy: number) => {
            cosmeticLayer?.chooseGrid(gx, gy);
            return cosmeticLayer?.stats().candidate ?? null;
          },
          farmingStats: () => farmLayer?.extraStats() ?? [],
          /** Phase 3A QA: expansion beds shown, the hinted cell and hidden field markers (no game state) */
          expansionStats: () => ({
            beds: [...expansionBeds.keys()].sort((a, b) => a - b),
            hint: hintSlot,
            hiddenMarkers: [...fieldMarkers.entries()].filter(([, m]) => m && !m.sprite.visible).map(([k]) => k),
          }),
          getFarmStats: () => ({
            activeStarterPlotCount: LAYOUT.starterPlots.length,
            expansionPlotCount: (LAYOUT.expansionPlots ?? []).length,
            walkwayCellCount: LAYOUT.farmWalkways.length,
            futureFieldCount: LAYOUT.futureFields.length,
            knowledgeTreeCount: LAYOUT.sprites.filter((sp) => sp.id === "knowledge_tree").length,
            spriteCount: entityList.length,
            textureCount: loadedUrls.length,
          }),
        };
      }
      if (!destroyed) setReady(true);
    }

    init();

    return () => {
      destroyed = true;
      sceneRef.current = null;
      cleanups.forEach((c) => c());
      delete (window as unknown as { __echoGarden?: unknown }).__echoGarden;
      // an app still inside init() is destroyed by init itself once it resolves
      if (app && appInitialized) {
        destroyApp(app);
        app = null;
      }
      releases.forEach((r) => {
        try {
          r();
        } catch {
          /* already released with the stage */
        }
      });
      generated.forEach((g) => g.destroy(true));
      feathered.forEach((g) => g.destroy(true));
      feathered.clear();
      if (loadedUrls.length) Assets.unload(loadedUrls).catch(() => undefined);
    };
  }, []);

  /* ---------------- prop-driven camera / selection ---------------- */
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    if (Math.abs(cameraZoom - s.camera.rel) > 0.02 && Math.abs(cameraZoom - lastReportedZoom.current) > 0.001) {
      s.camera.setRelZoom(cameraZoom);
      lastReportedZoom.current = cameraZoom;
      s.reportZoom();
    }
  }, [cameraZoom, ready]);

  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    s.focusTarget(selectedTargetId);
    s.setSelectedRing(selectedTargetId);
    s.reportZoom();
  }, [selectedTargetId, ready]);

  useEffect(() => {
    const s = sceneRef.current;
    if (!s || !focusRequest) return;
    s.focusTarget(focusRequest.id);
    s.reportZoom();
  }, [focusRequest, ready]);

  // gameplay: server state → beds; queued one-shot reactions → played once each
  useEffect(() => {
    if (farm) sceneRef.current?.applyFarm(farm);
  }, [farm, ready]);

  // Phase 2: season and living memory follow the server state (gameplay only)
  useEffect(() => {
    if (farm) sceneRef.current?.applySeason(qaSeasonRef.current ?? season);
  }, [season, farm, ready]);

  useEffect(() => {
    if (living) sceneRef.current?.applyLiving(living);
  }, [living, ready]);

  useEffect(() => {
    if (farm) sceneRef.current?.setExpansionHint(expansionHint);
  }, [expansionHint, farm, ready]);

  // Phase 3B: the monument follows the server state; each new celebration plays once
  useEffect(() => {
    const v = qaMonumentRef.current ?? monument;
    if (v) sceneRef.current?.applyMonument(v);
  }, [monument, ready]);

  // Phase 3C: buildings and farmland follow the server state
  useEffect(() => {
    const v = qaEstateRef.current ?? estate;
    if (v) sceneRef.current?.applyEstate(v);
  }, [estate, ready]);

  useEffect(() => {
    const v = qaCosmeticsRef.current ?? cosmetics;
    if (v) sceneRef.current?.applyCosmetics(v);
  }, [cosmetics, ready]);

  useEffect(() => {
    sceneRef.current?.setPlacement(placement);
  }, [placement, ready]);

  // Phase 3H: the animal quarter follows the server state; a care action makes its animals hop once
  useEffect(() => {
    const v = qaAnimalsRef.current ?? animals;
    if (v) sceneRef.current?.applyAnimals(v);
  }, [animals, ready]);

  useEffect(() => {
    if (!sceneRef.current || !animalCheer || animalCheer.n <= lastCheer.current) return;
    lastCheer.current = animalCheer.n;
    sceneRef.current.cheerAnimals(animalCheer.target);
  }, [animalCheer, ready]);

  useEffect(() => {
    if (!sceneRef.current || celebration <= lastCelebration.current) return;
    lastCelebration.current = celebration;
    sceneRef.current.celebrate();
  }, [celebration, ready]);

  useEffect(() => {
    const s = sceneRef.current;
    if (!s || !farmFx) return;
    for (const ev of farmFx) {
      if (ev.id <= lastFxId.current) continue;
      lastFxId.current = ev.id;
      s.playFarmFx(ev.kind, ev.slot);
    }
  }, [farmFx, ready]);

  useEffect(() => {
    const s = sceneRef.current;
    if (!s || resetSignal === 0) return;
    s.goHome();
    s.reportZoom();
  }, [resetSignal]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#0c142b]">
      <div
        ref={hostRef}
        className="absolute inset-0 cursor-grab active:cursor-grabbing"
        tabIndex={0}
        aria-label="Cảnh quan tương tác Đảo Ký Ức Echo Garden"
        role="application"
      />
      {entryVeil && !veilGone && !failed && (
        <div
          className={`pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-[#0c142b] text-[#EEF3FF] transition-opacity duration-700 ${ready ? "opacity-0" : "opacity-100"}`}
          aria-hidden={ready}
        >
          <p className="text-sm font-semibold text-[#EEF3FF]/90">Đang dựng Đảo Ký Ức…</p>
          <div className="mt-3 h-1.5 w-48 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-gradient-to-r from-[#74C98B] to-[#F4B63F] transition-all duration-300" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0c142b] px-6 text-center text-sm text-[#EEF3FF]/85">
          Không tải được cảnh quan hòn đảo. Vui lòng thử tải lại trang.
        </div>
      )}
    </div>
  );
}
