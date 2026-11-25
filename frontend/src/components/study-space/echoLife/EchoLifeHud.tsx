'use client';
/**
 * Echo Life Wave 11 HUD — inZOI-Class Pearl Opal & Deep Slate live interface over the Study Space world:
 * bottom-left Character Status and 8-Needs + 3 Daily Urges card, bottom-center Time/Speed/Location/Embodied bar,
 * bottom-right Mode Dock (Character, Phone, Build, Photo, City, Map, Settings), top-right Compact Menu + Minimap,
 * Smart Zoi thought bubbles + peer quick-chat bubbles, multi-item Bistro/Home Cooking pickers, and all 5 Wave 11 Studios.
 * Strictly 100% English-only, zero backdrop-filter over WebGL, zero ampersands in display copy.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  Award,
  Backpack,
  BookOpen,
  Briefcase,
  Building2,
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  Hammer,
  Home,
  Map as MapIcon,
  Pause,
  RotateCcw,
  SlidersHorizontal,
  Smartphone,
  Store,
  User,
  Users,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { CourtAction, CourtControls } from '../world/echoLife/sharedCourt';
import { CinematicDialogue } from './CinematicDialogue';
import { Minimap, type MinimapBeacon } from './Minimap';
import { Workshop } from './Workshop';
import { CharacterCreatorStudio, type CreatorCameraPreset } from './CharacterCreatorStudio';
import { EchoPhone, type EchoPhoneAppId, type PhoneOwnedVehicle, type PhoneResidentMeta } from './EchoPhone';
import { BuildStudio, type BuildRoomPreset } from './BuildStudio';
import { PhotoStudio, type PhotoCapturePayload } from './PhotoStudio';
import { ManageCityModal, type ManageCityWeatherOption } from './ManageCityModal';
import type { GameHud, EchoLifeGameHost, WeatherOverride } from '../world/echoLife/gameHost';
import { SEASON_NAMES } from '../world/echoLife/gameHost';
import type { QualityTier } from '../world/echoLife/renderConfig';
import { DEFAULT_WORLD_AUDIO_MIXER, type ActivityFoleyKind, type EchoLifeWorldAudio, type WorldAudioMixer } from '../world/echoLife/worldAudio';
import type { BuildCameraOptions, CreatorStudioOptions, PhotoStudioOptions } from '../world/engine';
import type { PeerQuickChatBubble } from '../world/echoLife/sharedCity';
import { broadcastAudioMixer, getWorldAudio, shallowEqual, useHudSelector, type HudStore, type PerfTelemetry } from './hudStore';
import { cleanDisplayCopy, type ShiftQuality, type Target, type TimeScale } from '@/lib/echo-life/game/session';
import type { DailyScheduleSnapshot } from '@/lib/echo-life/game/dailyEvents';
import { BISTRO_MENU, INGREDIENT_LABELS, mergeCookingInventory, type IngredientId } from '@/lib/echo-life/game/cookingSim';
import type { PartTimeJobId } from '@/lib/echo-life/game/careerSim';
import type { ResidentId } from '@/lib/echo-life/game/npcMind';
import { savePhotoThumb } from '@/lib/echo-life/game/phoneSim';
import { createDefaultCreatorProfile, type CharacterCreatorProfile } from '@/lib/avatar/characterCreator';
import type { V3Option, V3Result } from '@/lib/echo-life/v3/game-core/index.mjs';
import { CATALOG, CHARACTERS, getStoreDiscountRate, isZoneOpen, zones as V3_ZONES } from '@/lib/echo-life/v3/game-core/index.mjs';
import s from './echoLife.module.css';
import type { Line } from '@/lib/study-space/stories';

export type LifePanel = 'map' | 'journal' | 'people' | 'bag' | 'shops' | 'settings' | 'workshop';
export type ActiveStudio = 'creator' | 'phone' | 'build' | 'photo' | 'city' | null;

const FEED_TTL_MS = 6500;
const TAG_SLOTS = 8;
const PEER_QC_SLOTS = 6;

const ROOM_PRESET_HOST_MAP: Readonly<Record<string, string>> = {
  preset_riverside_oak: 'warm_oak_library',
  preset_nordic_study: 'minimalist_studio',
  preset_botanical_emerald: 'botanical_loft',
  preset_grand_atelier: 'midnight_creator',
};

function makePhotoThumbnail(fullDataUrl: string | null): Promise<string | null> {
  if (!fullDataUrl || !fullDataUrl.startsWith('data:image/') || typeof document === 'undefined') {
    return Promise.resolve(null);
  }
  if (fullDataUrl.length <= 85_000) return Promise.resolve(fullDataUrl);
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try {
        const encode = (w: number, h: number, q: number): string | null => {
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;
          ctx.drawImage(img, 0, 0, w, h);
          return canvas.toDataURL('image/jpeg', q);
        };
        let thumb = encode(400, 225, 0.72);
        if (thumb && thumb.length > 85_000) thumb = encode(320, 180, 0.58);
        resolve(thumb && thumb.length <= 89_000 ? thumb : null);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = fullDataUrl;
  });
}

const QUALITY_OPTIONS: readonly {
  tier: QualityTier;
  label: string;
  tag?: string;
  summary: string;
}[] = [
  { tier: 'low', label: 'Low', summary: 'Lean iGPU floor, crisp base lighting, minimum shadows and foliage.' },
  { tier: 'balanced', label: 'Balanced', summary: 'Smooth everyday laptop preset with shadows and moderate foliage.' },
  { tier: 'high', label: 'High', summary: 'Discrete GPU preset with 2K shadows, SMAA, bloom, and rich foliage.' },
  { tier: 'ultra', label: 'Ultra', tag: 'RTX 5070', summary: 'Maximum fidelity: 4K shadows, SSAO, SMAA, bloom, dense grass, and full PBR.' },
];

const WEATHER_OPTIONS: { id: WeatherOverride; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'sunny', label: 'Sunny' },
  { id: 'cloudy', label: 'Partly Cloudy' },
  { id: 'overcast', label: 'Overcast' },
  { id: 'light_rain', label: 'Light Rain' },
  { id: 'heavy_rain', label: 'Heavy Rain' },
  { id: 'snowy', label: 'Snowy' },
];

const PANELS: { id: LifePanel; label: string; Icon: typeof MapIcon }[] = [
  { id: 'map', label: 'Map', Icon: MapIcon },
  { id: 'journal', label: 'Journal', Icon: BookOpen },
  { id: 'people', label: 'People', Icon: Users },
  { id: 'bag', label: 'Bag', Icon: Backpack },
  { id: 'shops', label: 'Shops', Icon: Store },
  { id: 'workshop', label: 'Build', Icon: Hammer },
  { id: 'settings', label: 'Settings', Icon: SlidersHorizontal },
];

const HOME_ZONE_SET = new Set(['study', 'hall', 'living', 'kitchen', 'bedroom', 'bath', 'gaming_room', 'balcony', 'garage']);

const DISTRICT_LABELS: readonly { id: string; label: string }[] = [
  { id: 'market', label: 'Sunrise Market' },
  { id: 'bistro', label: 'Willow Bistro' },
  { id: 'cafe', label: 'Pixel Café' },
  { id: 'library', label: 'University Library' },
  { id: 'park', label: 'Riverside Park' },
  { id: 'campus', label: 'University Campus' },
];

const HOST_HINT: Record<string, string> = {
  tut_movement: 'Move with W A S D, look around with the mouse, hold Shift to run and press Space to jump.',
  tut_interaction: 'Walk up to your desk, the lamp or the study door and press E.',
  tut_npc: 'Go out through the study door into the hallway and living room — Linh is on her way to say hello. Face her and press E.',
  tut_map: 'Press ` (or the Map button) to see the districts and where everyone is, then walk into another place.',
  tut_inventory: 'Open Bag in the Echo Life menu (` key) to see your Campus Credits, ingredients and owned items.',
  tut_economy: 'Choose groceries at Sunrise Market or visit a store counter to make a purchase.',
  tut_build: 'Open the room editor (Layout in the toolbar) and move or turn a piece of furniture.',
  tut_journal: 'Open Journal in the Echo Life menu to read your story, choices and side arcs.',
  tut_transport: 'Your bicycle is parked on the pavement by the front door: face it and press E, ride a little way, then press E to get off.',
  tut_explore: 'Discover a new landmark, pick up a keepsake or join a live event — the city is yours.',
};

const ARROWS = ['←', '↑', '→', '↓'];

const TUTORIAL_CAPTIONS: Record<string, string> = {
  tut_movement: 'Walk with WASD. Press Space to jump.',
  tut_interaction: 'Approach your desk or door and press E.',
  tut_npc: 'Find Linh in the hallway. Press E to say hello.',
  tut_map: 'Open the map, then visit another place.',
  tut_inventory: 'Open Bag to see your items and Campus Credits.',
  tut_economy: 'Choose an item and pay at Sunrise Market.',
  tut_build: 'Open Layout and move or rotate some furniture.',
  tut_journal: 'Open Journal to read your story.',
  tut_transport: 'Press E by the bicycle outside your front door.',
  tut_explore: 'Find a keepsake or join a local event.',
};

const TUTORIAL_STEP_ZONES: Readonly<Record<string, ReadonlySet<string>>> = {
  tut_movement: new Set(['study']),
  tut_interaction: new Set(['study']),
  tut_npc: new Set(['study', 'hall', 'living']),
};

function isTutorialStepAllowedInZone(stepId: string, zone: string): boolean {
  const allowed = TUTORIAL_STEP_ZONES[stepId];
  if (!allowed) return true;
  return Boolean(zone) && allowed.has(zone);
}

function resolveWorldAudio(host: EchoLifeGameHost | null): EchoLifeWorldAudio {
  const attached = (host as (EchoLifeGameHost & { audio?: EchoLifeWorldAudio | null }) | null)?.audio;
  return attached ?? getWorldAudio();
}

function dailySnapshotFor(game: NonNullable<EchoLifeGameHost['game']>, hud: GameHud): DailyScheduleSnapshot {
  return game.dailyEvents({
    seasonIndex: hud.seasonIndex,
    rain: hud.rain,
    snow: /snow/i.test(hud.weather),
    weatherLabel: hud.weather,
    bestBasketStreak: hud.basketball?.streak ?? 0,
  });
}

function CourtPanel({ court: c, act }: { court: CourtControls; act: (action: CourtAction) => void }) {
  const action = c.action;
  const label = action === 'join' ? 'Join court' : action === 'replay' ? 'Play again' :
    c.phase === 'SERVE' ? 'Serve' : 'Return shuttle';
  let note = '';
  if (c.phase === 'COMPLETE') note = 'Rally complete.';
  else if (c.phase === 'MISSED') note = 'The shuttle landed.';
  else if (c.phase === 'PAUSED') note = 'Waiting for your partner to reconnect.';
  else if (c.joined && c.phase === 'WAITING') note = 'Waiting for a partner across the net.';
  else if (!c.joined && (!action || !c.ready)) note = 'Stand on a free side near the net.';
  else if (c.joined && !c.turn) note = 'Your partner’s turn.';
  return (
    <section className={s.court} data-testid="shared-court" data-phase={c.phase}>
      <strong>Partner badminton{c.joined && <span> · {c.returns}/{c.goal}</span>}</strong>
      {note && <small>{note}</small>}
      {action && <button type="button" data-testid={'court-' + action} disabled={!c.ready} onClick={() => act(action)}>{label}</button>}
      {c.joined && <button type="button" data-testid="court-leave" onClick={() => act('leave')}>Leave court</button>}
    </section>
  );
}

/** Isolated F3 telemetry overlay: samples rolling FPS only while visible so zero cost when closed. */
function DebugPerfHud({
  qualityTier,
  getPerfTelemetry,
}: {
  qualityTier: QualityTier;
  getPerfTelemetry?: () => PerfTelemetry | null;
}) {
  const [snap, setSnap] = useState<PerfTelemetry>(() => ({
    fps: 0,
    frameMs: 0,
    drawCalls: 0,
    triangles: 0,
    textures: 0,
    geometries: 0,
    qualityTier,
  }));

  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let lastSample = performance.now();

    const tick = (now: number) => {
      if (document.visibilityState === 'visible') {
        frames++;
        const dt = now - lastSample;
        if (dt >= 300) {
          const fps = Math.round((frames * 1000) / dt);
          const frameMs = +(dt / Math.max(1, frames)).toFixed(1);
          const ext = getPerfTelemetry?.();
          setSnap({
            fps: ext && ext.fps > 0 ? Math.round(ext.fps) : fps,
            frameMs: ext && ext.frameMs > 0 ? +ext.frameMs.toFixed(1) : frameMs,
            drawCalls: ext?.drawCalls ?? 0,
            triangles: ext?.triangles ?? 0,
            textures: ext?.textures ?? 0,
            geometries: ext?.geometries ?? 0,
            qualityTier: ext?.qualityTier ?? qualityTier,
            gpuLabel: ext?.gpuLabel,
          });
          frames = 0;
          lastSample = now;
        }
      } else {
        frames = 0;
        lastSample = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getPerfTelemetry, qualityTier]);

  const tierLabel = QUALITY_OPTIONS.find(o => o.tier === snap.qualityTier)?.label ?? snap.qualityTier;

  return (
    <div className={s.perfHud} data-testid="echo-life-perf-hud" role="status" aria-label="Performance telemetry">
      <div className={s.perfHeader}>
        <span>Performance (F3)</span>
        <span className={s.perfTier}>{tierLabel}</span>
      </div>
      <div className={s.perfGrid}>
        <span>FPS <b>{snap.fps}</b></span>
        <span>Frame <b>{snap.frameMs} ms</b></span>
        <span>Calls <b>{snap.drawCalls}</b></span>
        <span>Tris <b>{snap.triangles >= 1000 ? `${(snap.triangles / 1000).toFixed(1)}k` : snap.triangles}</b></span>
        <span>Tex <b>{snap.textures}</b></span>
        <span>Geo <b>{snap.geometries}</b></span>
      </div>
      {snap.gpuLabel && <div className={s.perfGpu}>{snap.gpuLabel}</div>}
    </div>
  );
}

interface Props {
  store: HudStore;
  target: Target | null;
  setTarget: (t: Target | null) => void;
  panel: LifePanel | null;
  setPanel: (p: LifePanel | null) => void;
  exploring: boolean;
  locked: boolean;
  captionAvailable: boolean;
  captionVisible: boolean;
  vi: boolean;
  onTutorialCaption: (line: Line) => void;
  onClearTutorialCaption?: () => void;
  onNeedsExpandChange?: (expanded: boolean) => void;
  bottomDockOpen?: boolean;
  suppressSeatedStandPrompt?: boolean;
  qualityTier?: QualityTier;
  onQualityTier?: (tier: QualityTier) => void;
  getPerfTelemetry?: () => PerfTelemetry | null;
  photoMode?: boolean;
  onPhotoModeChange?: (on: boolean) => void;
  onCapturePhoto?: () => void;
  onLeaveBasketball?: () => void;
  activeStudio?: ActiveStudio;
  onActiveStudioChange?: (next: ActiveStudio, phoneApp?: EchoPhoneAppId) => void;
  phoneInitialApp?: EchoPhoneAppId;
  creatorProfile?: CharacterCreatorProfile;
  onPreviewAvatar?: (profile: CharacterCreatorProfile) => void;
  onSaveAvatar?: (profile: CharacterCreatorProfile) => void;
  onCreatorModeChange?: (active: boolean, opts?: CreatorStudioOptions) => void;
  onBuildCameraChange?: (active: boolean, opts?: BuildCameraOptions) => void;
  onPhotoStudioModeChange?: (active: boolean, opts?: PhotoStudioOptions) => void;
  onCapturePhotoDataUrl?: (filterCss?: string) => string | null;
  getPeerQuickChats?: () => PeerQuickChatBubble[];
  onRequestResetRoom?: () => void;
}

interface TagCache {
  visible: boolean;
  id: string;
  x: number;
  y: number;
  opacity: string;
  focus: string;
  name: string;
  scene: string;
  thought: string;
  thoughtTone: string;
  thoughtAt: number;
}

interface PeerQcCache {
  visible: boolean;
  x: number;
  y: number;
  name: string;
  text: string;
}

// Bounded string cache avoiding repeated regex `cleanDisplayCopy()` passes inside hot HUD/nameplate loops.
const CLEAN_COPY_CACHE = new Map<string, string>();
function cleanCopyCached(raw: string): string {
  if (!raw) return '';
  const hit = CLEAN_COPY_CACHE.get(raw);
  if (hit !== undefined) return hit;
  const cleaned = cleanDisplayCopy(raw);
  if (CLEAN_COPY_CACHE.size >= 256) CLEAN_COPY_CACHE.clear();
  CLEAN_COPY_CACHE.set(raw, cleaned);
  return cleaned;
}

type LabelItem = ReturnType<EchoLifeGameHost['labelsNow']>[number];

const NAMEPLATE_MOVING_MS = 50; // 20 Hz while player/camera moves
const NAMEPLATE_IDLE_MS = 100;  // 10 Hz when player/camera is stationary (still tracks walking NPCs smoothly)

/**
 * Isolated floating resident nameplate + Smart Zoi thought bubble + multiplayer peer quick-chat overlay.
 * Subscribes only to `host` identity (never re-renders on 5 Hz HUD telemetry) and throttles DOM projection
 * to 20 Hz moving / 10 Hz stationary with zero per-frame allocations or layout reads.
 */
const NameplateOverlayIsland = memo(function NameplateOverlayIsland({
  host,
  exploring,
  hidden,
  getPeerQuickChats,
}: {
  host: EchoLifeGameHost;
  exploring: boolean;
  hidden: boolean;
  getPeerQuickChats?: () => PeerQuickChatBubble[];
}) {
  const tags = useRef<(HTMLDivElement | null)[]>([]);
  const tagCache = useRef<TagCache[]>(
    Array.from({ length: TAG_SLOTS }, () => ({
      visible: false,
      id: '',
      x: -9999,
      y: -9999,
      opacity: '',
      focus: '',
      name: '',
      scene: '',
      thought: '',
      thoughtTone: '',
      thoughtAt: -Infinity,
    })),
  );
  const peerQcRefs = useRef<(HTMLDivElement | null)[]>([]);
  const peerQcCache = useRef<PeerQcCache[]>(
    Array.from({ length: PEER_QC_SLOTS }, () => ({ visible: false, x: -9999, y: -9999, name: '', text: '' })),
  );

  useEffect(() => {
    if (!host || !exploring) return;
    let raf = 0;
    let lastTickMs = -Infinity;
    let lastPx = Number.NaN;
    let lastPz = Number.NaN;
    let lastYaw = Number.NaN;
    let wasHidden = false;

    // Reusable scratch buffers: zero per-frame array/object churn.
    const rawBuf: LabelItem[] = [];
    const placedX = new Float32Array(TAG_SLOTS);
    const placedY = new Float32Array(TAG_SLOTS);

    const hideAll = () => {
      const tagEls = tags.current;
      const tCache = tagCache.current;
      for (let i = 0; i < TAG_SLOTS; i++) {
        const el = tagEls[i];
        const c = tCache[i];
        if (el && c.visible) {
          el.style.display = 'none';
          c.visible = false;
        }
      }
      const qcEls = peerQcRefs.current;
      const qCache = peerQcCache.current;
      for (let i = 0; i < PEER_QC_SLOTS; i++) {
        const el = qcEls[i];
        const c = qCache[i];
        if (el && c.visible) {
          el.style.display = 'none';
          c.visible = false;
        }
      }
    };

    if (hidden) {
      hideAll();
      return;
    }

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (document.visibilityState !== 'visible') return;

      const body = host.bodyNow();
      const px = body ? body.x : 0;
      const pz = body ? body.z : 0;
      const yaw = host.lookDirection;
      const camMoved =
        Number.isNaN(lastPx) ||
        Math.abs(px - lastPx) >= 0.02 ||
        Math.abs(pz - lastPz) >= 0.02 ||
        Math.abs(yaw - lastYaw) >= 0.005;
      const minInterval = camMoved ? NAMEPLATE_MOVING_MS : NAMEPLATE_IDLE_MS;

      if (!wasHidden && now - lastTickMs < minInterval) return;
      wasHidden = false;
      lastTickMs = now;
      lastPx = px;
      lastPz = pz;
      lastYaw = yaw;

      const src = host.labelsNow();
      rawBuf.length = 0;
      for (let i = 0; i < src.length; i++) {
        const l = src[i];
        if (l.dist <= 18 && l.y >= 44) rawBuf.push(l);
      }
      // Small insertion sort by distance (typically 0..16 nearby actors).
      for (let i = 1; i < rawBuf.length; i++) {
        const cur = rawBuf[i];
        let j = i - 1;
        while (j >= 0 && rawBuf[j].dist > cur.dist) {
          rawBuf[j + 1] = rawBuf[j];
          j--;
        }
        rawBuf[j + 1] = cur;
      }

      const curGame = host.game;
      const tagEls = tags.current;
      const tCache = tagCache.current;
      let placedCount = 0;

      for (let i = 0; i < TAG_SLOTS; i++) {
        const el = tagEls[i];
        if (!el) continue;
        const c = tCache[i];
        const l = i < rawBuf.length ? rawBuf[i] : undefined;
        if (!l) {
          if (c.visible) {
            el.style.display = 'none';
            c.visible = false;
          }
          continue;
        }

        // Smooth 10..18 m distance fade
        const alpha = l.dist <= 10 ? 1 : Math.max(0, 1 - (l.dist - 10) / 8);
        if (alpha <= 0.04) {
          if (c.visible) {
            el.style.display = 'none';
            c.visible = false;
          }
          continue;
        }

        // Screen-space de-overlap against closer nameplates (zero allocation)
        const x = l.x;
        let y = Math.max(72, l.y);
        for (let iter = 0; iter < 4; iter++) {
          let hitIdx = -1;
          for (let p = 0; p < placedCount; p++) {
            if (Math.abs(placedX[p] - x) < 108 && Math.abs(placedY[p] - y) < 34) {
              hitIdx = p;
              break;
            }
          }
          if (hitIdx < 0) break;
          y = placedY[hitIdx] - 36;
        }
        if (y < 52) {
          if (c.visible) {
            el.style.display = 'none';
            c.visible = false;
          }
          continue;
        }
        placedX[placedCount] = x;
        placedY[placedCount] = y;
        placedCount++;

        const opStr = (Math.round(alpha * 50) / 50).toFixed(2);
        const focusStr = l.focus ? '1' : '';
        if (!c.visible) {
          el.style.display = 'block';
          c.visible = true;
        }
        if (Math.abs(x - c.x) >= 0.5 || Math.abs(y - c.y) >= 0.5) {
          el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
          c.x = x;
          c.y = y;
        }
        if (opStr !== c.opacity) {
          el.style.opacity = opStr;
          c.opacity = opStr;
        }
        if (focusStr !== c.focus) {
          el.dataset.focus = focusStr;
          c.focus = focusStr;
        }

        const idChanged = l.id !== c.id;
        if (idChanged) c.id = l.id;

        // Child 0: Smart Zoi deterministic thought bubble (0 LLM calls), re-sampled at <= 2 Hz per actor
        if (idChanged || l.scene || now - c.thoughtAt >= 500) {
          c.thoughtAt = now;
          const thoughtObj = curGame && l.dist <= 12 && !l.scene ? curGame.getNpcThoughtBubble(l.id) : null;
          const thoughtText = thoughtObj ? cleanCopyCached(thoughtObj.text) : '';
          const thoughtTone = thoughtObj?.tone ?? '';
          if (thoughtText !== c.thought || thoughtTone !== c.thoughtTone) {
            const thoughtEl = el.children[0] as HTMLElement | undefined;
            if (thoughtEl) thoughtEl.textContent = thoughtText;
            el.dataset.thought = thoughtText ? '1' : '';
            el.dataset.thoughtTone = thoughtTone;
            c.thought = thoughtText;
            c.thoughtTone = thoughtTone;
          }
        }

        // Child 1: Resident or peer name
        if (l.name !== c.name) {
          const nameEl = el.children[1] as HTMLElement | undefined;
          if (nameEl) nameEl.textContent = cleanCopyCached(l.name);
          c.name = l.name;
        }

        // Child 2: Overheard banter or peer scene line
        const rawScene = l.scene ? cleanCopyCached(l.scene) : '';
        if (rawScene !== c.scene) {
          const banterEl = el.children[2] as HTMLElement | undefined;
          if (banterEl) banterEl.textContent = rawScene;
          el.dataset.banter = rawScene ? '1' : '';
          c.scene = rawScene;
        }
      }

      // Multiplayer peer quick-chat bubbles
      const peerChats = getPeerQuickChats ? getPeerQuickChats() : null;
      const peerCount = peerChats ? Math.min(PEER_QC_SLOTS, peerChats.length) : 0;
      const qcEls = peerQcRefs.current;
      const qCache = peerQcCache.current;
      for (let i = 0; i < PEER_QC_SLOTS; i++) {
        const el = qcEls[i];
        if (!el) continue;
        const c = qCache[i];
        const qc = i < peerCount && peerChats ? peerChats[i] : undefined;
        if (!qc) {
          if (c.visible) {
            el.style.display = 'none';
            c.visible = false;
          }
          continue;
        }
        const x = qc.x;
        const y = Math.max(64, qc.y - 34);
        if (!c.visible) {
          el.style.display = 'block';
          c.visible = true;
        }
        if (Math.abs(x - c.x) >= 0.5 || Math.abs(y - c.y) >= 0.5) {
          el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
          c.x = x;
          c.y = y;
        }
        const safeName = cleanCopyCached(qc.name);
        const safeText = cleanCopyCached(qc.text);
        if (safeName !== c.name) {
          const bEl = el.children[0] as HTMLElement | undefined;
          if (bEl) bEl.textContent = safeName;
          c.name = safeName;
        }
        if (safeText !== c.text) {
          const sEl = el.children[1] as HTMLElement | undefined;
          if (sEl) sEl.textContent = safeText;
          c.text = safeText;
        }
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        wasHidden = true;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(draw);
      }
    };

    raf = requestAnimationFrame(draw);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
      hideAll();
    };
  }, [host, exploring, hidden, getPeerQuickChats]);

  return (
    <>
      {Array.from({ length: TAG_SLOTS }, (_, i) => (
        <div key={i} ref={el => { tags.current[i] = el; }} className={s.tag} style={{ display: 'none' }}>
          <span className={s.tagThought} />
          <b />
          <span className={s.tagBanter} />
        </div>
      ))}
      {Array.from({ length: PEER_QC_SLOTS }, (_, i) => (
        <div
          key={i}
          ref={el => { peerQcRefs.current[i] = el; }}
          className={s.peerQuickChat}
          data-testid="hud-peer-quickchat"
          style={{ display: 'none' }}
        >
          <b />
          <span />
        </div>
      ))}
    </>
  );
});

/** Leaf island: subscribes ONLY to vehicle telemetry so 5 Hz driving `kmh` updates never touch the rest of the HUD. */
const VehicleSpeedoIsland = memo(function VehicleSpeedoIsland({
  store,
  hidden,
}: {
  store: HudStore;
  hidden: boolean;
}) {
  const slice = useHudSelector(
    store,
    h => {
      if (!h) return null;
      const v = h.vehicle;
      const g = h.host?.game;
      return {
        hasVehicle: Boolean(v),
        name: v?.name ?? '',
        kmh: v?.kmh ?? 0,
        gear: v?.gear ?? '',
        kind: v?.kind ?? 'car',
        hasDriven: Boolean(g?.drivenVehicle),
        hasChallenge: Boolean(h.challenge),
        host: h.host,
      };
    },
    shallowEqual,
  );
  if (hidden || !slice) return null;
  const game = slice.host?.game ?? null;
  return (
    <>
      {slice.hasVehicle && (
        <div className={s.speedo} data-testid="echo-life-speedo" aria-label="Vehicle telemetry">
          <strong className={s.speedNum}>{slice.kmh}</strong>
          <span className={s.speedUnit}>km/h</span>
          <span className={s.speedGear} data-gear={slice.gear}>{slice.gear}</span>
          <span className={s.speedName}>{cleanCopyCached(slice.name)}</span>
          <span className={s.speedHints}>
            {slice.kind === 'bike'
              ? <><kbd>H</kbd> Bell · <kbd>C</kbd> Cam · <kbd>Space</kbd> Brake · <kbd>E</kbd> Park</>
              : <><kbd>L</kbd> Lights · <kbd>H</kbd> Horn · <kbd>C</kbd> Cam · <kbd>Space</kbd> Brake · <kbd>E</kbd> Park</>}
          </span>
        </div>
      )}
      {slice.hasDriven && !slice.hasChallenge && game && (
        <div className={s.touchDriveBar}>
          <button type="button" onClick={() => game.drivenVehicle?.brakeToStop()}>Brake</button>
          <button type="button" onClick={() => slice.host?.interact()}>Dismount</button>
        </div>
      )}
    </>
  );
});

/** Leaf island: top-left stack (F3 Perf HUD, Shift Craft, self-expiring Feed with ZERO permanent 1 Hz timer, Banter, Scenes). */
const LeftFeedAndBanterIsland = memo(function LeftFeedAndBanterIsland({
  store,
  debugPerf,
  qualityTier,
  getPerfTelemetry,
  panelOpen,
  anyStudioOpen,
  shiftCraft,
  onLockShiftCraft,
  onJoinScene,
}: {
  store: HudStore;
  debugPerf: boolean;
  qualityTier: QualityTier;
  getPerfTelemetry?: () => PerfTelemetry | null;
  panelOpen: boolean;
  anyStudioOpen: boolean;
  shiftCraft: { job: string; quality: ShiftQuality | null };
  onLockShiftCraft: (job: string, quality: ShiftQuality, microKind?: string) => void;
  onJoinScene: (sceneId: string) => void;
}) {
  const slice = useHudSelector(
    store,
    h => {
      if (!h || !h.host?.game) return null;
      const g = h.host.game;
      const shift = g.activeShiftTarget();
      const overheard = h.overheardBanter ?? g.people.overheardBanter;
      const feedLen = h.feed.length;
      const lastFeed = feedLen > 0 ? h.feed[feedLen - 1] : null;
      const prevFeed = feedLen > 1 ? h.feed[feedLen - 2] : null;
      const prev2Feed = feedLen > 2 ? h.feed[feedLen - 3] : null;
      const scenesSig = h.stats.scenes.join(',');
      return {
        host: h.host,
        hasChallenge: Boolean(h.challenge),
        feedLen,
        f0Id: prev2Feed?.id ?? 0,
        f1Id: prevFeed?.id ?? 0,
        f2Id: lastFeed?.id ?? 0,
        f2Text: lastFeed?.text ?? '',
        overheardSpeakerId: overheard?.speakerId ?? '',
        overheardText: overheard?.text ?? '',
        scenesSig,
        shiftJob: shift?.job ?? '',
        shiftStep: shift?.step ?? 0,
        shiftTotal: shift?.total ?? 0,
        shiftTitle: shift?.title ?? '',
        shiftMicroPrompt: shift?.microPrompt ?? '',
        shiftMicroKind: shift?.microKind ?? '',
      };
    },
    shallowEqual,
  );

  // Self-stopping feed expiry timer: schedules ONE timeout to the exact next expiry and clears completely once settled.
  const feedSeenRef = useRef<Map<number, number>>(new Map());
  const [feedClock, setFeedClock] = useState(() => Date.now());
  const shiftMarkerRef = useRef<HTMLDivElement | null>(null);
  const shiftPhaseRef = useRef(0);

  const feedItems = store.get()?.feed;
  const f0Id = slice?.f0Id ?? 0;
  const f1Id = slice?.f1Id ?? 0;
  const f2Id = slice?.f2Id ?? 0;
  const feedLen = slice?.feedLen ?? 0;

  useEffect(() => {
    const items = store.get()?.feed;
    if (!items || items.length === 0) {
      feedSeenRef.current.clear();
      return;
    }
    const now = Date.now();
    const seen = feedSeenRef.current;
    for (let i = 0; i < items.length; i++) {
      const id = items[i].id;
      if (!seen.has(id)) seen.set(id, now);
    }
    if (seen.size > items.length + 8) {
      const activeIds = new Set(items.map(f => f.id));
      for (const id of seen.keys()) {
        if (!activeIds.has(id)) seen.delete(id);
      }
    }
    // Find earliest remaining expiry among the last 3 visible feed items.
    let minRemainMs = Infinity;
    const start = Math.max(0, items.length - 3);
    for (let i = start; i < items.length; i++) {
      const stamped = seen.get(items[i].id);
      if (stamped !== undefined) {
        const rem = FEED_TTL_MS - (now - stamped);
        if (rem > 0 && rem < minRemainMs) minRemainMs = rem;
      }
    }
    if (!Number.isFinite(minRemainMs)) return;
    const timer = window.setTimeout(() => {
      setFeedClock(Date.now());
    }, Math.max(60, Math.ceil(minRemainMs) + 25));
    return () => window.clearTimeout(timer);
  }, [store, f0Id, f1Id, f2Id, feedLen, feedClock]);

  const showShiftCraft = Boolean(
    slice?.shiftJob &&
    !panelOpen &&
    !anyStudioOpen &&
    !slice.hasChallenge &&
    (shiftCraft.job !== slice.shiftJob || shiftCraft.quality === null),
  );

  useEffect(() => {
    if (!showShiftCraft) return;
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      raf = requestAnimationFrame(step);
      if (document.visibilityState !== 'visible') return;
      const phase = ((now - t0) % 1800) / 1800;
      const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
      shiftPhaseRef.current = tri;
      if (shiftMarkerRef.current) shiftMarkerRef.current.style.left = `${(tri * 100).toFixed(1)}%`;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [showShiftCraft]);

  if (!slice || !slice.host?.game) return null;
  const game = slice.host.game;

  const recentFeed = feedItems ? feedItems.slice(-3) : [];
  const visibleFeed = recentFeed.filter(f => {
    const stamped = feedSeenRef.current.get(f.id);
    return stamped === undefined || feedClock - stamped < FEED_TTL_MS;
  });

  const body = slice.host.bodyNow();
  const near = !panelOpen && body && slice.scenesSig ? game.scenesNear(body) : [];
  const hasOverheard = !panelOpen && Boolean(slice.overheardText);
  const overheardSpeaker = slice.overheardSpeakerId
    ? (CHARACTERS[slice.overheardSpeakerId]?.name ?? slice.overheardSpeakerId)
    : '';

  if (!debugPerf && visibleFeed.length === 0 && !showShiftCraft && near.length === 0 && !hasOverheard) {
    return null;
  }

  return (
    <div className={s.leftStack}>
      {debugPerf && <DebugPerfHud qualityTier={qualityTier} getPerfTelemetry={getPerfTelemetry} />}
      {showShiftCraft && slice.shiftJob && (
        <div className={s.shiftCraftCard} data-testid="echo-life-shift-craft">
          <div className={s.shiftCraftHead}>
            <span>{cleanCopyCached(slice.shiftTitle || 'Shift Craft')}</span>
            <span>Step {slice.shiftStep}/{slice.shiftTotal}</span>
          </div>
          <div className={s.shiftCraftTrack} aria-label="Shift craft timing">
            <span className={s.shiftCraftGreat} />
            <span className={s.shiftCraftSweet} />
            <div ref={shiftMarkerRef} className={s.shiftCraftMarker} />
          </div>
          <div className={s.shiftCraftBtns}>
            <span>{cleanCopyCached(slice.shiftMicroPrompt || 'Tap in the green band for a craft bonus')}</span>
            <button
              type="button"
              onClick={() => {
                const p = shiftPhaseRef.current;
                const quality: ShiftQuality =
                  p >= 0.42 && p <= 0.64 ? 'perfect'
                  : p >= 0.28 && p <= 0.78 ? 'great'
                  : 'standard';
                onLockShiftCraft(slice.shiftJob, quality, slice.shiftMicroKind || undefined);
              }}
            >
              Craft Boost
            </button>
          </div>
        </div>
      )}
      {visibleFeed.length > 0 && (
        <div className={s.feed} aria-live="polite">
          {visibleFeed.map(f => <p key={f.id} data-tone={f.tone}>{cleanCopyCached(f.text)}</p>)}
        </div>
      )}
      {hasOverheard && (
        <div className={s.overheardCard} data-testid="echo-life-overheard-banter" role="status">
          <b>{cleanCopyCached(overheardSpeaker)}</b>
          <span>“{cleanCopyCached(slice.overheardText)}”</span>
        </div>
      )}
      {!panelOpen && near.length > 0 && (
        <div className={s.scenes}>
          {near.slice(0, 2).map(sc => (
            <button
              key={sc.id}
              data-scene={sc.id}
              type="button"
              className={s.sceneBtn}
              onClick={() => onJoinScene(sc.id)}
            >
              <span>{cleanCopyCached(sc.caption)}</span>
              <b>{cleanCopyCached(sc.joinPrompt)}</b>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

/** Leaf island: top-right audio mute button subscribed only to audio mixer state. */
const QuickMuteButton = memo(function QuickMuteButton({ audio }: { audio: EchoLifeWorldAudio }) {
  const mixer = useSyncExternalStore(audio.subscribe, audio.getMixer, () => DEFAULT_WORLD_AUDIO_MIXER);
  return (
    <button
      type="button"
      className={s.quickMuteBtn}
      data-testid="echo-life-quick-mute"
      aria-label="Toggle audio mute"
      aria-pressed={mixer.muted}
      title={mixer.muted ? 'Unmute spatial audio' : 'Mute spatial audio'}
      onClick={() => {
        audio.unlock();
        const next = audio.setMixer({ muted: !mixer.muted });
        broadcastAudioMixer(next);
        if (!next.muted) audio.triggerUiClick('tap');
      }}
    >
      {mixer.muted ? <VolumeX size={15} aria-hidden="true" /> : <Volume2 size={15} aria-hidden="true" />}
    </button>
  );
});

type CustomWaypoint = {
  x: number;
  z: number;
  zone: string;
  label: string;
  setFromZone: string;
};

/** Leaf island: Minimap + memoized beacons subscribed only to map-relevant HUD fields (never `kmh`, `needs`, `credits`, or minute clock ticks). */
const TopRightMinimapIsland = memo(function TopRightMinimapIsland({
  store,
  version,
  waypoint,
  onClearWaypoint,
  onExpand,
}: {
  store: HudStore;
  version: number;
  waypoint?: CustomWaypoint | null;
  onClearWaypoint?: () => void;
  onExpand: () => void;
}) {
  const slice = useHudSelector(
    store,
    h => {
      if (!h || !h.host?.game) return null;
      const shift = h.host.game.activeShiftTarget();
      return {
        host: h.host,
        zone: h.zone,
        playerZoneId: h.host.game.s.player.zone,
        hourSlot: h.time ? h.time.slice(0, -1) : '',
        weather: h.weather,
        rain: h.rain,
        seasonIndex: h.seasonIndex,
        hasChallenge: Boolean(h.challenge),
        shiftKey: shift ? `${shift.job}:${shift.step}:${Math.round(shift.at.x * 10)},${Math.round(shift.at.z * 10)}` : '',
      };
    },
    shallowEqual,
  );

  useEffect(() => {
    if (!waypoint || !slice || !onClearWaypoint) return;
    if (waypoint.setFromZone !== waypoint.zone && slice.playerZoneId === waypoint.zone) {
      onClearWaypoint();
    }
  }, [waypoint, slice, onClearWaypoint]);

  const prevBeaconsRef = useRef<{ sig: string; list: MinimapBeacon[] }>({ sig: '', list: [] });
  const beacons = useMemo<MinimapBeacon[]>(() => {
    const hud = store.get();
    const game = slice?.host?.game;
    if (!game || !hud || !slice) {
      return prevBeaconsRef.current.list.length === 0 ? prevBeaconsRef.current.list : [];
    }
    const list: MinimapBeacon[] = [];
    const city = game.nav.city;
    const objectives = game.map().objectives;
    const goalZoneId = objectives[0]?.zone;
    if (goalZoneId) {
      const z = city.zones.find(zn => zn.id === goalZoneId);
      if (z) list.push({ x: z.waypoint.x, z: z.waypoint.z, kind: 'objective', label: game.zoneName(z.id) });
    }
    const daily = dailySnapshotFor(game, hud);
    for (const b of daily.beacons) {
      list.push({ x: b.at.x, z: b.at.z, kind: 'event' });
    }
    const shift = game.activeShiftTarget();
    if (shift) {
      list.push({ x: shift.at.x, z: shift.at.z, kind: 'shift' });
    }
    if (waypoint) {
      list.push({ x: waypoint.x, z: waypoint.z, kind: 'waypoint', label: waypoint.label });
    }
    const sig = list.map(b => `${b.kind}:${Math.round(b.x * 10)},${Math.round(b.z * 10)}:${b.label ?? ''}`).join('|');
    if (sig === prevBeaconsRef.current.sig) return prevBeaconsRef.current.list;
    prevBeaconsRef.current = { sig, list };
    return list;
  }, [store, slice, version, waypoint]);

  if (!slice || slice.hasChallenge) return null;
  return (
    <Minimap
      host={slice.host}
      zone={cleanCopyCached(slice.zone)}
      beacons={beacons}
      onExpand={onExpand}
    />
  );
});

type DailyUrgeItem = ReturnType<NonNullable<EchoLifeGameHost['game']>['dailyUrges']>[number];
type ActiveMoodletItem = ReturnType<NonNullable<EchoLifeGameHost['game']>['activeMoodlets']>[number];

/** Leaf island: bottom-left Character Status, Emotion Pill, 4/8 Needs, Urges and Moodlets. */
const CharacterNeedsIsland = memo(function CharacterNeedsIsland({
  store,
  hero,
  heroDisplayName,
  heroInitial,
  audio,
  onOpenCreator,
  onNeedsExpandChange,
}: {
  store: HudStore;
  hero: string;
  heroDisplayName: string;
  heroInitial: string;
  audio: EchoLifeWorldAudio;
  onOpenCreator: () => void;
  onNeedsExpandChange?: (expanded: boolean) => void;
}) {
  const [needsExpanded, setNeedsExpanded] = useState(false);
  const urgesCacheRef = useRef<{ sig: string; list: readonly DailyUrgeItem[] }>({ sig: '', list: [] });
  const moodletsCacheRef = useRef<{ sig: string; list: readonly ActiveMoodletItem[] }>({ sig: '', list: [] });

  const slice = useHudSelector(
    store,
    h => {
      if (!h || !h.host?.game) return null;
      const g = h.host.game;
      const n = h.needs ?? g.needsSummary();
      const n8 = h.needs8 ?? g.needs8();
      const emo = h.emotion ?? g.playerEmotion();
      const urges = (h.urges ?? g.dailyUrges()).slice(0, 3);
      const moodlets = (n.moodlets ?? g.activeMoodlets()).slice(0, 3);
      const urgesSig = urges.map(u => `${u.id}:${u.progress}/${u.goalCount}:${u.completed ? 1 : 0}`).join(',');
      const moodletsSig = moodlets.map(m => `${m.id}:${Math.ceil(m.minutesRemaining / 60)}`).join(',');
      if (urgesSig !== urgesCacheRef.current.sig) {
        urgesCacheRef.current = { sig: urgesSig, list: urges };
      }
      if (moodletsSig !== moodletsCacheRef.current.sig) {
        moodletsCacheRef.current = { sig: moodletsSig, list: moodlets };
      }
      return {
        hasChallenge: Boolean(h.challenge),
        energy: Math.round(n.energy),
        hunger: Math.round(n.hunger),
        mood: Math.round(n.mood),
        focus: Math.round(n.focus),
        hygiene: Math.round(n.hygiene),
        n8Hunger: Math.round(n8.hunger),
        n8Hygiene: Math.round(n8.hygiene),
        n8Bathroom: Math.round(n8.bathroom),
        n8Fun: Math.round(n8.fun),
        n8Social: Math.round(n8.social),
        n8Energy: Math.round(n8.energy),
        n8Sleep: Math.round(n8.sleep),
        n8Recognition: Math.round(n8.recognition),
        emoLabel: emo.label,
        emoColor: emo.color,
        emoTitle: `${emo.dialogueBonus}. ${emo.copingHint}`,
        urgesSig,
        moodletsSig,
      };
    },
    shallowEqual,
  );

  useEffect(() => {
    onNeedsExpandChange?.(Boolean(slice && !slice.hasChallenge && needsExpanded));
  }, [needsExpanded, slice, onNeedsExpandChange]);

  if (!slice || slice.hasChallenge) return null;
  const urges = urgesCacheRef.current.list;
  const moodlets = moodletsCacheRef.current.list;
  const compactItems = [
    ['energy', 'Energy', slice.energy, false],
    ['hunger', 'Hunger', slice.hunger, false],
    ['mood', 'Mood', slice.mood, false],
    ['focus', 'Focus', slice.focus, false],
    ...(slice.hygiene < 35 ? ([['hygiene', 'Hygiene', slice.hygiene, true]] as const) : []),
  ] as const;

  return (
    <div className={s.bottomLeftCluster}>
      {moodlets.length > 0 && (
        <div className={s.moodletRow} data-testid="echo-life-moodlets" aria-label="Active lifestyle moodlets">
          {moodlets.map(m => (
            <span
              key={m.id}
              className={s.moodletPill}
              data-tone={m.tone}
              title={`${cleanCopyCached(m.effect)} (${Math.ceil(m.minutesRemaining / 60)}h remaining)`}
            >
              {cleanCopyCached(m.label)}
            </span>
          ))}
        </div>
      )}

      <section className={s.charCard} data-testid="hud-character-card" aria-label="Character status and needs">
        <div className={s.charCardHead}>
          <div className={s.charIdentity}>
            <button
              type="button"
              className={s.heroAvatarBadge}
              data-hero={hero}
              title={`Customize ${heroDisplayName} in Character Studio`}
              onClick={onOpenCreator}
            >
              {heroInitial}
            </button>
            <div className={s.charTitleWrap}>
              <span className={s.charName}>{heroDisplayName}</span>
              <span
                className={s.emotionPill}
                data-testid="hud-emotion-pill"
                title={cleanCopyCached(slice.emoTitle)}
              >
                <span className={s.emotionDot} style={{ backgroundColor: slice.emoColor }} aria-hidden="true" />
                <span>{cleanCopyCached(slice.emoLabel)}</span>
              </span>
            </div>
          </div>
          <button
            type="button"
            className={s.needsExpandBtn}
            data-testid="hud-needs-expand"
            aria-expanded={needsExpanded}
            aria-label={needsExpanded ? 'Collapse needs and urges' : 'Expand all 8 needs and daily urges'}
            onClick={() => {
              audio.unlock();
              audio.triggerUiClick('tap');
              setNeedsExpanded(v => !v);
            }}
          >
            <span>{needsExpanded ? 'Compact' : '8 Needs'}</span>
            {needsExpanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronUp size={13} aria-hidden="true" />}
          </button>
        </div>

        {!needsExpanded ? (
          <div className={s.vitalsStrip} data-testid="echo-life-vitals" aria-label="Primary vitals">
            {compactItems.map(([kind, label, val, fullRow]) => (
              <div
                key={kind}
                className={s.vitalPill}
                data-kind={kind}
                data-span={fullRow ? 'full' : undefined}
                data-low={val < 25 ? '1' : undefined}
              >
                <span className={s.vitalHead}>
                  <span>{label}</span>
                  <b>{val}%</b>
                </span>
                <span className={s.vitalBar}><i style={{ width: `${Math.max(4, Math.min(100, val))}%` }} /></span>
              </div>
            ))}
          </div>
        ) : (
          <div className={s.needsExpandedBlock} data-testid="echo-life-vitals">
            <div className={s.needs8Grid} data-testid="hud-needs-8-grid" aria-label="8 core life needs">
              {([
                ['hunger', 'Hunger', slice.n8Hunger],
                ['hygiene', 'Hygiene', slice.n8Hygiene],
                ['bathroom', 'Bathroom', slice.n8Bathroom],
                ['fun', 'Fun', slice.n8Fun],
                ['social', 'Social', slice.n8Social],
                ['energy', 'Energy', slice.n8Energy],
                ['sleep', 'Sleep', slice.n8Sleep],
                ['recognition', 'Recognition', slice.n8Recognition],
              ] as const).map(([kind, label, val]) => (
                <div key={kind} className={s.vitalPill} data-kind={kind} data-need={kind} data-low={val < 25 ? '1' : undefined}>
                  <span className={s.vitalHead}>
                    <span>{label}</span>
                    <b>{val}%</b>
                  </span>
                  <span className={s.vitalBar}><i style={{ width: `${Math.max(4, Math.min(100, val))}%` }} /></span>
                </div>
              ))}
            </div>

            {urges.length > 0 && (
              <div className={s.urgesSection} data-testid="hud-urges-list" aria-label="Daily urges">
                <span className={s.urgesHeading}>Daily Urges ({urges.filter(u => u.completed).length}/{urges.length})</span>
                <div className={s.urgesList}>
                  {urges.map(u => (
                    <div key={u.id} className={s.urgeChip} data-urge-id={u.id} data-done={u.completed ? '1' : undefined} title={cleanCopyCached(u.detail)}>
                      <span>{cleanCopyCached(u.title)}</span>
                      <em>
                        {u.completed ? <Check size={12} aria-hidden="true" /> : `${u.progress}/${u.goalCount}`}
                      </em>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
});

/** Leaf island: 7-phase embodied action progress bar (subscribes ONLY to `hud.embodied`). */
const EmbodiedBarIsland = memo(function EmbodiedBarIsland({ store }: { store: HudStore }) {
  const slice = useHudSelector(
    store,
    h => {
      const e = h?.embodied;
      if (!e || !h) return null;
      return {
        host: h.host,
        actionId: e.actionId,
        label: e.label,
        phase: e.phase,
        active: e.active,
        progressPct: Math.max(4, Math.min(100, Math.round(e.progress * 200) / 2)),
      };
    },
    shallowEqual,
  );
  if (!slice) return null;
  return (
    <div className={s.embodiedBar} data-testid="hud-embodied-bar" role="status" aria-live="polite">
      <div className={s.embodiedMeta}>
        <div className={s.embodiedHead}>
          <span>{cleanCopyCached(slice.label)}</span>
          <span className={s.embodiedPhase}>{cleanCopyCached(slice.phase)}</span>
        </div>
        <div className={s.embodiedTrack}>
          <div className={s.embodiedFill} style={{ width: `${slice.progressPct.toFixed(1)}%` }} />
        </div>
      </div>
      {slice.active && (
        <button
          type="button"
          className={s.embodiedCancel}
          data-testid="hud-embodied-cancel"
          onClick={() => slice.host?.cancelEmbodiedAction('Cancelled by player.')}
        >
          Cancel
        </button>
      )}
    </div>
  );
});

/** Leaf island: contextual crosshair E prompt + active build placement prompt. */
const FocusAndBuildPromptIsland = memo(function FocusAndBuildPromptIsland({
  store,
  anyStudioOpen,
  suppressSeatedStand,
  setTarget,
  onPlaceActiveBuild,
  onBumpVersion,
}: {
  store: HudStore;
  anyStudioOpen: boolean;
  suppressSeatedStand: boolean;
  setTarget: (t: Target | null) => void;
  onPlaceActiveBuild: () => void;
  onBumpVersion: () => void;
}) {
  const slice = useHudSelector(
    store,
    h => {
      if (!h || !h.host?.game) return null;
      const g = h.host.game;
      const f = h.focus;
      const spotAction = h.host.focus?.kind === 'spot' ? h.host.focus.hotspot.action : null;
      const isRedundantSeatStand =
        Boolean(g.people.playerSeat) && f?.kind === 'spot' && f?.label === 'Stand up (Space / WASD)';
      return {
        host: h.host,
        driving: Boolean(h.vehicle || g.drivenVehicle || g.riding),
        building: h.host.building ?? '',
        buildMessage: h.host.buildMessage ?? '',
        hasFocus: Boolean(f),
        focusLabel: f?.label ?? '',
        focusRole: f?.role ?? '',
        isRedundantSeatStand,
        spotAction,
      };
    },
    shallowEqual,
  );

  if (!slice) return null;
  const focusIsBistro = slice.spotAction === 'bistro_order' || slice.spotAction === 'bistro_snack';
  const focusIsStove = slice.spotAction === 'cook';
  const showFocusPrompt =
    slice.hasFocus &&
    !slice.driving &&
    !slice.building &&
    !anyStudioOpen &&
    !(suppressSeatedStand && slice.isRedundantSeatStand);

  return (
    <>
      {slice.building && (
        <div className={s.prompt} style={{ pointerEvents: 'auto' }}>
          <button type="button" onClick={() => { slice.host.buildYaw += Math.PI / 4; onBumpVersion(); }}>Rotate</button>
          <button type="button" onClick={onPlaceActiveBuild}>Place (E)</button>
          <button type="button" onClick={() => { slice.host.cancelBuild(); onBumpVersion(); }}>Cancel</button>
          <span role="status">{cleanCopyCached(slice.buildMessage)}</span>
        </div>
      )}

      {showFocusPrompt && (
        <div className={s.prompt} data-testid="echo-life-prompt">
          <kbd>E</kbd>
          <span>{cleanCopyCached(slice.focusLabel)}</span>
          {slice.focusRole && <em>{cleanCopyCached(slice.focusRole)}</em>}
          {(focusIsBistro || focusIsStove) && slice.host.focus && (
            <button
              type="button"
              className={s.promptActionBtn}
              data-testid={focusIsBistro ? 'hud-open-bistro-menu' : 'hud-open-recipe-picker'}
              onClick={() => setTarget(slice.host.focus)}
            >
              {focusIsBistro ? '5 Bistro Dishes' : '10 Home Recipes'}
            </button>
          )}
        </div>
      )}
    </>
  );
});

/** Leaf island: bottom-center Time, Speed, Season, Weather, Zone, Credits, Level, Comfort & Active Shift bar. */
const StatusClockBarIsland = memo(function StatusClockBarIsland({
  store,
  audio,
  onOpenBuild,
  onBumpVersion,
}: {
  store: HudStore;
  audio: EchoLifeWorldAudio;
  onOpenBuild: () => void;
  onBumpVersion: () => void;
}) {
  const slice = useHudSelector(
    store,
    h => {
      if (!h || !h.host?.game) return null;
      const g = h.host.game;
      const inHome = HOME_ZONE_SET.has(g.s.player.zone) || Boolean(h.host.worldRegion?.startsWith('prop_'));
      const needs = inHome ? g.needsSummary() : null;
      const comfort = inHome ? (needs?.comfort ?? g.computeHomeComfort()) : null;
      const shift = g.activeShiftTarget();
      return {
        host: h.host,
        day: g.s.day + 1,
        weekday: h.weekday,
        time: h.time,
        season: h.season,
        weather: h.weather,
        zone: h.zone,
        credits: h.credits,
        level: h.level,
        timeScale: (h.timeScale ?? g.timeScale ?? 1) as TimeScale,
        inHome,
        comfortScore: comfort?.score ?? 0,
        comfortTier: comfort?.tier ?? '',
        comfortRestPct: comfort ? Math.round((comfort.restMultiplier - 1) * 100) : 0,
        shiftStep: shift?.step ?? 0,
        shiftTotal: shift?.total ?? 0,
        shiftLabel: shift?.label ?? '',
      };
    },
    shallowEqual,
  );

  if (!slice) return null;

  return (
    <div className={s.status} data-testid="echo-life-status">
      <div className={s.speedGroup} role="group" aria-label="Simulation time speed">
        <button
          type="button"
          className={s.speedBtn}
          aria-label="Pause simulation"
          aria-pressed={slice.timeScale === 0}
          data-testid="hud-speed-0"
          onClick={() => { audio.unlock(); slice.host.setTimeScale(0); onBumpVersion(); }}
        >
          <Pause size={11} aria-hidden="true" />
        </button>
        {([1, 2, 3] as const).map(sp => (
          <button
            key={sp}
            type="button"
            className={s.speedBtn}
            aria-label={`${sp}x simulation speed`}
            aria-pressed={slice.timeScale === sp}
            data-testid={`hud-speed-${sp}`}
            onClick={() => { audio.unlock(); slice.host.setTimeScale(sp); onBumpVersion(); }}
          >
            {sp}x
          </button>
        ))}
      </div>
      <span className={s.clock}>Day {slice.day} · {slice.weekday} {slice.time}</span>
      <span>{slice.season}</span>
      <span>{cleanCopyCached(slice.weather)}</span>
      <span className={s.zone}>{cleanCopyCached(slice.zone)}</span>
      <span className={s.credits} data-testid="echo-life-credits">{slice.credits.toLocaleString('en-US')} CC</span>
      <span>Lv {slice.level}</span>
      {slice.inHome && (
        <button
          type="button"
          className={s.comfortPill}
          data-testid="echo-life-comfort-pill"
          title={`${slice.comfortTier} · +${slice.comfortRestPct}% rest recovery (open Build Studio)`}
          onClick={onOpenBuild}
        >
          <Home size={12} aria-hidden="true" />
          Comfort {slice.comfortScore}
        </button>
      )}
      {slice.shiftTotal > 0 && (
        <span className={s.shiftPill} title={cleanCopyCached(slice.shiftLabel)}>
          <Briefcase size={12} aria-hidden="true" />
          Shift {slice.shiftStep}/{slice.shiftTotal}: {cleanCopyCached(slice.shiftLabel)}
        </span>
      )}
    </div>
  );
});

/** Leaf island: tiny unread indicator for Echo Phone inside the Mode Dock. */
const PhoneUnreadBadgeIsland = memo(function PhoneUnreadBadgeIsland({ store }: { store: HudStore }) {
  const unreadCount = useHudSelector(store, h => {
    const g = h?.host?.game;
    if (!g) return 0;
    const threads = g.phoneStateSnapshot().threads;
    let count = 0;
    for (const msgs of Object.values(threads)) {
      if (msgs && msgs.length > 0 && msgs[msgs.length - 1].sender !== 'player') count++;
    }
    return count;
  });
  return unreadCount > 0 ? <i className={s.unreadDot} data-testid="hud-phone-unread" aria-hidden="true" /> : null;
});

/** Leaf island: shared badminton court panel subscribed ONLY to `hud.court`. */
const CourtPanelIsland = memo(function CourtPanelIsland({
  store,
  hidden,
}: {
  store: HudStore;
  hidden: boolean;
}) {
  const slice = useHudSelector(
    store,
    h => {
      if (!h || !h.court || h.challenge || h.host?.building) return null;
      return {
        host: h.host,
        phase: h.court.phase,
        joined: h.court.joined,
        ready: h.court.ready,
        turn: h.court.turn,
        action: h.court.action,
        returns: h.court.returns,
        goal: h.court.goal,
      };
    },
    shallowEqual,
  );
  if (hidden || !slice) return null;
  const court = store.get()?.court;
  if (!court) return null;
  return <CourtPanel court={court} act={action => slice.host?.courtAction(action)} />;
});

/** Leaf island: nearby interactables dropdown subscribed ONLY to nearby target signature. */
const NearbyTargetsIsland = memo(function NearbyTargetsIsland({
  store,
  hidden,
}: {
  store: HudStore;
  hidden: boolean;
}) {
  const [nearby, setNearby] = useState(false);
  const slice = useHudSelector(
    store,
    h => {
      if (!h || !h.host?.game) return null;
      const g = h.host.game;
      const driving = Boolean(h.vehicle || g.drivenVehicle || g.riding);
      if (driving || h.challenge || h.host.building || h.court?.joined || g.nearbyTargets.length === 0) {
        return null;
      }
      const mySeat = g.people.playerSeat;
      const filtered = mySeat
        ? g.nearbyTargets.filter(t => !(t.kind === 'seat' && t.id === mySeat))
        : g.nearbyTargets;
      if (filtered.length === 0) return null;
      const sig = filtered
        .map(t => (t.kind === 'npc' || t.kind === 'seat' || t.kind === 'workstation' ? t.id : t.kind === 'spot' ? t.hotspot.key : t.kind))
        .join(',');
      return { host: h.host, sig, zone: g.s.player.zone };
    },
    shallowEqual,
  );

  useEffect(() => {
    setNearby(false);
  }, [slice?.sig, slice?.zone, hidden]);

  if (hidden || !slice || !slice.host.game) return null;
  const g = slice.host.game;
  const mySeat = g.people.playerSeat;
  const list = mySeat
    ? g.nearbyTargets.filter(t => !(t.kind === 'seat' && t.id === mySeat))
    : g.nearbyTargets;
  if (!list.length) return null;

  return (
    <div className={s.nearby}>
      <button type="button" onClick={() => setNearby(v => !v)} aria-expanded={nearby}>Interact nearby</button>
      {nearby && (
        <div>
          {list.map(t => {
            const key = t.kind === 'npc' || t.kind === 'seat' || t.kind === 'workstation' ? t.id : t.kind === 'spot' ? t.hotspot.key : t.kind;
            return (
              <button key={key} type="button" data-nearby={key} onClick={() => { slice.host.interactNearby(t); setNearby(false); }}>
                {t.kind === 'npc' ? 'Talk to ' + cleanCopyCached(t.name) : cleanCopyCached(t.label)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});

/** Leaf island: Challenge / Basketball overlay subscribed ONLY when a challenge is active. */
const ChallengeIsland = memo(function ChallengeIsland({
  store,
  onLeaveBasketball,
}: {
  store: HudStore;
  onLeaveBasketball?: () => void;
}) {
  const hud = useHudSelector(
    store,
    h => (h?.challenge ? h : null),
    (a, b) => {
      if (a === b) return true;
      if (!a || !b) return false;
      return (
        a.challenge?.type === b.challenge?.type &&
        a.challenge?.index === b.challenge?.index &&
        a.challenge?.length === b.challenge?.length &&
        a.basketball?.score === b.basketball?.score &&
        a.basketball?.streak === b.basketball?.streak &&
        a.basketball?.holding === b.basketball?.holding &&
        a.basketball?.needsRetrieval === b.basketball?.needsRetrieval &&
        a.basketball?.bestStreak === b.basketball?.bestStreak &&
        a.basketball?.isThreePointRange === b.basketball?.isThreePointRange &&
        a.basketball?.lastShotPoints === b.basketball?.lastShotPoints &&
        a.basketball?.lastShotResult === b.basketball?.lastShotResult
      );
    },
  );
  if (!hud || !hud.challenge) return null;
  return <Challenge host={hud.host} hud={hud} onLeaveBasketball={onLeaveBasketball} />;
});

export const EchoLifeHud = memo(function EchoLifeHud({
  store,
  target,
  setTarget,
  panel,
  setPanel,
  exploring,
  locked,
  captionVisible,
  captionAvailable,
  onTutorialCaption,
  onClearTutorialCaption,
  onNeedsExpandChange,
  bottomDockOpen,
  suppressSeatedStandPrompt,
  qualityTier = 'high',
  onQualityTier,
  getPerfTelemetry,
  photoMode: controlledPhotoMode,
  onPhotoModeChange,
  onLeaveBasketball,
  activeStudio: controlledActiveStudio,
  onActiveStudioChange,
  phoneInitialApp: controlledPhoneApp,
  creatorProfile,
  onPreviewAvatar,
  onSaveAvatar,
  onCreatorModeChange,
  onBuildCameraChange,
  onPhotoStudioModeChange,
  onCapturePhotoDataUrl,
  getPeerQuickChats,
  onRequestResetRoom,
}: Props) {
  const [reply, setReply] = useState<V3Result | null>(null);
  const [selectedEquipment, setSelectedEquipment] = useState('');
  const [selectedShop, setSelectedShop] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [debugPerf, setDebugPerf] = useState(false);
  const [localPhotoMode, setLocalPhotoMode] = useState(false);
  const [localStudio, setLocalStudio] = useState<ActiveStudio>(null);
  const [localPhoneApp, setLocalPhoneApp] = useState<EchoPhoneAppId>('home');
  const [topDownCamera, setTopDownCamera] = useState(false);
  const [gridSnapMeters, setGridSnapMeters] = useState<0 | 0.25 | 0.5>(0.25);
  const [photoTimeFrozen, setPhotoTimeFrozen] = useState(true);
  const [shiftCraft, setShiftCraft] = useState<{ job: string; quality: ShiftQuality | null }>({ job: '', quality: null });
  const [customWaypoint, setCustomWaypoint] = useState<CustomWaypoint | null>(null);
  const handleClearWaypoint = useCallback(() => setCustomWaypoint(null), []);
  const creatorYawRef = useRef(0);
  const savedTimeScaleRef = useRef<TimeScale>(1);
  const prevStudioRef = useRef<ActiveStudio>(null);

  const studio: ActiveStudio = controlledActiveStudio !== undefined ? controlledActiveStudio : localStudio;
  const effectivePhoneApp: EchoPhoneAppId = controlledPhoneApp ?? localPhoneApp;
  const isBuildOpen = studio === 'build' || panel === 'workshop';
  const isPhotoOpen = studio === 'photo' || Boolean(controlledPhotoMode) || localPhotoMode;
  const isCreatorOpen = studio === 'creator';
  const isPhoneOpen = studio === 'phone';
  const isCityOpen = studio === 'city';
  const anyStudioOpen = isCreatorOpen || isPhoneOpen || isBuildOpen || isPhotoOpen || isCityOpen;
  const needsFullHud = Boolean(anyStudioOpen || panel);

  // Root shell subscribes ONLY to rare structural fields during live 3D gameplay (0 root reconciliations at 5 Hz!).
  // Full `modalHud` is subscribed lazily ONLY while a studio or menu panel is actually open.
  const shell = useHudSelector(
    store,
    h => {
      if (!h) return null;
      return {
        host: h.host,
        hasGame: Boolean(h.host?.game),
        hasChallenge: Boolean(h.challenge),
        tutorialId: h.tutorial?.id ?? null,
        playerZone: h.host?.game?.s.player.zone ?? '',
        ending: h.ending ?? null,
        modalHud: needsFullHud ? h : null,
      };
    },
    shallowEqual,
  );

  const host = shell?.host ?? null;
  const game = host?.game ?? null;
  const audio = resolveWorldAudio(host);

  const setStudio = useCallback(
    (next: ActiveStudio, phoneApp?: EchoPhoneAppId) => {
      setLocalStudio(next);
      if (phoneApp) setLocalPhoneApp(phoneApp);
      onActiveStudioChange?.(next, phoneApp);
      if (next === 'photo') {
        setLocalPhotoMode(true);
        onPhotoModeChange?.(true);
      } else {
        setLocalPhotoMode(false);
        if (controlledPhotoMode) onPhotoModeChange?.(false);
      }
      if (next && next !== 'build' && panel) {
        setPanel(null);
      }
    },
    [onActiveStudioChange, onPhotoModeChange, controlledPhotoMode, panel, setPanel],
  );

  const openBuildStudio = useCallback(
    (itemId = '') => {
      if (itemId) setSelectedEquipment(itemId);
      setTarget(null);
      setPanel('workshop');
      setStudio('build');
    },
    [setTarget, setPanel, setStudio],
  );

  const closeBuildStudio = useCallback(() => {
    host?.cancelBuild();
    setTopDownCamera(false);
    onBuildCameraChange?.(false);
    if (panel === 'workshop') setPanel(null);
    if (studio === 'build') setStudio(null);
  }, [host, onBuildCameraChange, panel, setPanel, studio, setStudio]);

  const setPhotoMode = useCallback(
    (next: boolean) => {
      setStudio(next ? 'photo' : null);
    },
    [setStudio],
  );

  const bumpVersion = useCallback(() => {
    setVersion(v => v + 1);
  }, []);

  // Sync studio camera and time-freeze transitions cleanly with StudyWorld engine
  useEffect(() => {
    const prev = prevStudioRef.current;
    const activeNow: ActiveStudio = isCreatorOpen
      ? 'creator'
      : isPhotoOpen
        ? 'photo'
        : isBuildOpen
          ? 'build'
          : isPhoneOpen
            ? 'phone'
            : isCityOpen
              ? 'city'
              : null;
    if (prev === activeNow) return;
    prevStudioRef.current = activeNow;

    if (prev === 'creator' && activeNow !== 'creator') {
      onCreatorModeChange?.(false);
    }
    if (prev === 'photo' && activeNow !== 'photo') {
      onPhotoStudioModeChange?.(false, { filterCss: 'none' } as PhotoStudioOptions);
      if (host) host.setTimeScale(savedTimeScaleRef.current || 1);
    }
    if (prev === 'build' && activeNow !== 'build') {
      setTopDownCamera(false);
      onBuildCameraChange?.(false);
    }

    if (activeNow === 'creator') {
      creatorYawRef.current = 0;
      onCreatorModeChange?.(true, {
        preset: 'full',
        lightPreset: 'studio',
        yawOffset: 0,
        snowPreview: false,
        expression: 'neutral',
      });
    } else if (activeNow === 'photo') {
      savedTimeScaleRef.current = (game?.timeScale ?? 1) as TimeScale;
      setPhotoTimeFrozen(true);
      if (host) host.setTimeScale(0);
      onPhotoStudioModeChange?.(true, {
        freezeTime: true,
        fov: 48,
        pose: 'stand',
        expression: 'smile',
        filterCss: 'none',
      } as PhotoStudioOptions);
    }
  }, [
    isCreatorOpen,
    isPhotoOpen,
    isBuildOpen,
    isPhoneOpen,
    isCityOpen,
    host,
    game,
    onCreatorModeChange,
    onPhotoStudioModeChange,
    onBuildCameraChange,
  ]);

  const stepId = shell?.tutorialId ?? undefined;
  const playerZone = shell?.playerZone ?? '';
  const activeTutStepRef = useRef<string | null>(null);
  useEffect(() => {
    if (!stepId || !isTutorialStepAllowedInZone(stepId, playerZone) || target || panel || !exploring || anyStudioOpen) {
      if (activeTutStepRef.current) {
        activeTutStepRef.current = null;
        onClearTutorialCaption?.();
      }
      return;
    }
    if (activeTutStepRef.current && activeTutStepRef.current !== stepId) {
      activeTutStepRef.current = null;
      onClearTutorialCaption?.();
    }
    if (!captionAvailable) return;
    const touch = window.matchMedia('(pointer: coarse)').matches;
    const text = touch && stepId === 'tut_movement' ? 'Use the movement pad, drag to look, then tap Jump.' :
      touch && stepId === 'tut_interaction' ? 'Approach your desk and tap the interaction button.' :
      TUTORIAL_CAPTIONS[stepId];
    if (text) {
      activeTutStepRef.current = stepId;
      onTutorialCaption({ id: 'echo-life-' + stepId, vi: text, en: text, hold: 3.4 });
    }
  }, [stepId, playerZone, captionAvailable, target, panel, exploring, anyStudioOpen, onTutorialCaption, onClearTutorialCaption]);

  // Unified HUD hotkeys: Tab Phone, B Build, P Photo Studio, M Map, ` Menu, F3 Perf HUD.
  // Note: KeyH is NEVER intercepted in capture phase here (dialogue history lives exclusively inside CinematicDialogue
  // when dialogue is open, and vehicle horn + NPC horn reactions flow cleanly through gameHost / exploration!).
  const keyMetaRef = useRef({
    store,
    exploring,
    host,
    game,
    panel,
    setPanel,
    target,
    setTarget,
    isPhotoOpen,
    isPhoneOpen,
    isBuildOpen,
    anyStudioOpen,
    setPhotoMode,
    setStudio,
    openBuildStudio,
    closeBuildStudio,
    audio,
  });
  useEffect(() => {
    keyMetaRef.current = {
      store,
      exploring,
      host,
      game,
      panel,
      setPanel,
      target,
      setTarget,
      isPhotoOpen,
      isPhoneOpen,
      isBuildOpen,
      anyStudioOpen,
      setPhotoMode,
      setStudio,
      openBuildStudio,
      closeBuildStudio,
      audio,
    };
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const m = keyMetaRef.current;
      if (!m.exploring || !m.game) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.code === 'Escape') {
        if (m.isPhotoOpen) {
          e.preventDefault();
          e.stopImmediatePropagation();
          m.setPhotoMode(false);
          return;
        }
        if (m.isBuildOpen) {
          e.preventDefault();
          e.stopImmediatePropagation();
          m.closeBuildStudio();
          return;
        }
        if (m.anyStudioOpen) {
          e.preventDefault();
          e.stopImmediatePropagation();
          m.setStudio(null);
          return;
        }
        if (m.panel) {
          e.preventDefault();
          e.stopImmediatePropagation();
          m.setPanel(null);
          return;
        }
        if (m.target) {
          e.preventDefault();
          e.stopImmediatePropagation();
          m.setTarget(null);
          return;
        }
      }

      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;

      if (e.code === 'F3') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setDebugPerf(v => !v);
        return;
      }

      if (e.code === 'Tab' && !m.target && !m.game.s.challenge && (!m.anyStudioOpen || m.isPhoneOpen) && !m.panel) {
        e.preventDefault();
        e.stopImmediatePropagation();
        m.audio.unlock();
        m.audio.triggerUiClick(m.isPhoneOpen ? 'close' : 'open');
        m.setStudio(m.isPhoneOpen ? null : 'phone', 'home');
        return;
      }

      if (e.code === 'KeyB' && !m.target && !m.game.s.challenge && (!m.anyStudioOpen || m.isBuildOpen) && (!m.panel || m.panel === 'workshop')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        m.audio.unlock();
        m.audio.triggerUiClick(m.isBuildOpen ? 'close' : 'open');
        if (m.isBuildOpen) m.closeBuildStudio();
        else m.openBuildStudio();
        return;
      }

      if (e.code === 'KeyP' && !m.target && !m.panel && !m.game.s.challenge && (!m.anyStudioOpen || m.isPhotoOpen)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        m.setPhotoMode(!m.isPhotoOpen);
        return;
      }

      // Unlock Web Audio on H while driving without swallowing propagation so gameHost.soundVehicleHorn()
      // and exploration.ts hornHeld both fire cleanly (triggering vehicle horn + NPC horn reactions).
      const vehicleKind = m.store.get()?.vehicle?.kind ?? null;
      if (e.code === 'KeyH' && vehicleKind && !m.target && !m.panel && !m.anyStudioOpen && !m.game.s.challenge && !e.repeat) {
        m.audio.unlock();
        return;
      }

      if (m.anyStudioOpen) return;

      if (e.code === 'Backquote') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (m.panel) m.setPanel(null);
        else { m.setPanel('map'); m.game.signal('openedMap'); }
      } else if (e.code === 'KeyM' && !m.target && !m.game.s.challenge) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (m.panel === 'map') m.setPanel(null);
        else { m.setPanel('map'); m.game.signal('openedMap'); }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // Talking holds the resident; closing lets them go on with their day.
  useEffect(() => {
    if (!game) return;
    game.people.talking = target?.kind === 'npc' ? target.id : null;
    setReply(null);
    return () => { game.people.talking = null; };
  }, [game, target]);

  const playShiftFoley = useCallback(
    (microKind: string | undefined, pos3?: { x: number; y?: number; z: number }) => {
      if (microKind === 'shelf_stock') {
        audio.triggerShopRegister(false, pos3);
        return;
      }
      const valid: Record<string, ActivityFoleyKind> = {
        espresso: 'espresso',
        tea_pour: 'tea_pour',
        book_page: 'book_page',
        garden_water: 'garden_water',
        guitar_chord: 'guitar_chord',
        shutter: 'shutter',
        shift_complete: 'shift_complete',
      };
      const mapped = microKind ? valid[microKind] : undefined;
      if (mapped) audio.triggerActivityFoley(mapped, pos3);
      else audio.triggerUiClick('confirm');
    },
    [audio],
  );

  const handleLockShiftCraft = useCallback(
    (job: string, quality: ShiftQuality, microKind?: string) => {
      setShiftCraft({ job, quality });
      audio.unlock();
      audio.triggerUiClick(quality === 'perfect' ? 'confirm' : 'tap');
      playShiftFoley(microKind);
    },
    [audio, playShiftFoley],
  );

  const handleJoinScene = useCallback(
    (sceneId: string) => {
      if (!game) return;
      game.joinScene(sceneId);
      setVersion(v => v + 1);
    },
    [game],
  );

  const handleOpenCreator = useCallback(() => {
    audio.unlock();
    audio.triggerUiClick('open');
    setStudio('creator');
  }, [audio, setStudio]);

  const handleOpenBuildFromStatus = useCallback(() => {
    audio.unlock();
    audio.triggerUiClick('open');
    openBuildStudio();
  }, [audio, openBuildStudio]);

  const handleExpandMinimap = useCallback(() => {
    setStudio(null);
    setPanel('map');
    game?.signal('openedMap');
  }, [setStudio, setPanel, game]);

  const handlePlaceActiveBuild = useCallback(async () => {
    if (!host?.building) return;
    if (!host.building.startsWith('ec_')) {
      const pos = host.bodyNow() ?? { x: 0, z: 0 };
      const yaw = host.buildYaw;
      const res = host.relocateStarterFurniture(host.building, { x: pos.x, y: 0, z: pos.z }, yaw);
      host.buildMessage = res.reason;
      if (res.ok) host.cancelBuild();
      setVersion(v => v + 1);
      return;
    }
    await host.placeBuild();
    setVersion(v => v + 1);
  }, [host]);

  const effectiveProfile = useMemo(
    () => creatorProfile ?? createDefaultCreatorProfile('LYRA'),
    [creatorProfile],
  );
  const heroDisplayName = cleanCopyCached(effectiveProfile.identity.displayName || 'Riverside Learner');
  const heroInitial = heroDisplayName.charAt(0).toUpperCase() || 'L';

  if (!shell || !host || !game) return null;

  const hud = shell.modalHud ?? store.get();
  if (!hud) return null;

  const close = () => { setTarget(null); setReply(null); };
  const act = async (t: Target, o: V3Option) => {
    const wasShift = game.activeShift;
    let craftQuality: 'ok' | 'great' | 'perfect' | undefined;
    if (t.kind === 'spot' && o.key.startsWith('job:')) {
      const jobId = o.key.slice(4);
      const moodletBoost = game.hasMoodlet('caffeinated') || game.hasMoodlet('inspired_space') || game.hasMoodlet('well_rested');
      craftQuality =
        shiftCraft.job === jobId && shiftCraft.quality === 'perfect'
          ? 'perfect'
          : shiftCraft.job === jobId && shiftCraft.quality === 'great'
            ? 'great'
            : moodletBoost
              ? 'great'
              : 'ok';
    }
    const r = await host.act(t, o.key, craftQuality ? { quality: craftQuality } : undefined);
    if (r.ok && t.kind === 'spot' && o.key.startsWith('job:')) {
      const jobId = o.key.slice(4);
      const meta = game.shiftMeta(jobId);
      const pos3 = { x: t.at.x, y: 1.0, z: t.at.z };
      playShiftFoley(meta?.microKind, pos3);
      if (wasShift && !game.activeShift) {
        setShiftCraft({ job: '', quality: null });
      }
    }
    const seatedSettled =
      Boolean(r.settled) ||
      Boolean(game.people.playerSeat) ||
      (r.ok &&
        !r.openPanel &&
        (t.kind === 'seat' ||
          (t.kind === 'spot' &&
            (['sit', 'rest', 'sleep'].includes(t.hotspot.action) ||
              /^(sit|seat|rest|sleep|relax)\b/i.test(o.key)))));
    if (seatedSettled || game.s.challenge) { close(); return; }
    setReply(r);
    setVersion(v => v + 1);
    if (r.openPanel && ['pc', 'properties', 'vehicles', 'build'].includes(r.openPanel)) {
      openBuildStudio(r.targetInstanceId ?? '');
    } else if (r.openPanel === 'explore') {
      setTarget(null);
      setPanel('journal');
    }
    if (r.openPanel === 'shop' && typeof r.storeId === 'string') {
      setTarget(null);
      setSelectedShop(r.storeId);
      setPanel('shops');
    }
  };

  const safeZone = cleanCopyCached(hud.zone);

  const handlePhotoCapture = async (payload: PhotoCapturePayload): Promise<boolean> => {
    audio.unlock();
    audio.triggerUiClick('confirm');
    const rawUrl = onCapturePhotoDataUrl?.(payload.cssFilter) ?? null;
    const thumb = await makePhotoThumbnail(rawUrl);
    const curHud = store.get() ?? hud;
    const curZone = cleanCopyCached(curHud.zone);
    const title = `${curZone} (${payload.filterLabel})`;
    const res = host.addPhotoAlbumEntry({
      title,
      zone: curZone,
      season: curHud.season,
      filter: payload.filterLabel,
      timestamp: Date.now(),
      dataUrlThumb: thumb ?? undefined,
    });
    if (res && !res.thumbSaved && thumb) {
      savePhotoThumb(game.owner, res.photo.thumbKey, thumb);
    }
    setVersion(v => v + 1);
    return true;
  };

  // Full-viewport Wave 11 Photo Studio
  if (isPhotoOpen) {
    return (
      <div className={s.hud} data-testid="echo-life-hud" data-photo-mode="true">
        <PhotoStudio
          open={true}
          zoneLabel={safeZone}
          seasonLabel={hud.season}
          initialFov={48}
          timeFrozen={photoTimeFrozen}
          onTimeFrozenChange={frozen => {
            setPhotoTimeFrozen(frozen);
            onPhotoStudioModeChange?.(true, { freezeTime: frozen });
            host.setTimeScale(frozen ? 0 : (savedTimeScaleRef.current || 1));
          }}
          onFovChange={fov => onPhotoStudioModeChange?.(true, { fov })}
          onPoseChange={pose => onPhotoStudioModeChange?.(true, { pose })}
          onExpressionChange={expression => onPhotoStudioModeChange?.(true, { expression })}
          onFilterChange={(_filterId, cssFilter) =>
            onPhotoStudioModeChange?.(true, { filterCss: cssFilter } as PhotoStudioOptions)
          }
          onCapture={handlePhotoCapture}
          onClose={() => {
            onPhotoStudioModeChange?.(false, { filterCss: 'none' } as PhotoStudioOptions);
            setPhotoMode(false);
          }}
        />
      </div>
    );
  }

  // Full-viewport Wave 11 Character Creator Studio
  if (isCreatorOpen) {
    const unlockedWardrobe = {
      ownedObjects: game.s.progression.ownedObjects,
      unlockedOutfits: (game.s.progression as { unlockedOutfits?: string[] }).unlockedOutfits,
      legacyOutfits: (game.s as { outfits?: string[] }).outfits,
    };
    return (
      <div className={s.hud} data-testid="echo-life-hud" data-studio="creator">
        <CharacterCreatorStudio
          open={true}
          initialProfile={effectiveProfile}
          unlockedGarments={unlockedWardrobe}
          onPreviewChange={p => onPreviewAvatar?.(p)}
          onCameraPreset={(preset: CreatorCameraPreset) =>
            onCreatorModeChange?.(true, { preset: preset === 'full_body' ? 'full' : preset })
          }
          onLightPreset={lightPreset => onCreatorModeChange?.(true, { lightPreset })}
          onExpressionChange={expression => onCreatorModeChange?.(true, { expression })}
          onSnowPreviewChange={snowPreview => onCreatorModeChange?.(true, { snowPreview })}
          onOrbitYaw={deltaRad => {
            creatorYawRef.current += deltaRad;
            onCreatorModeChange?.(true, { yawOffset: creatorYawRef.current });
          }}
          onSave={profile => {
            audio.unlock();
            audio.triggerUiClick('confirm');
            onSaveAvatar?.(profile);
            game.setProfileIdentity(profile.identity);
            onCreatorModeChange?.(false);
            setStudio(null);
            setVersion(v => v + 1);
          }}
          onClose={() => {
            onPreviewAvatar?.(effectiveProfile);
            onCreatorModeChange?.(false);
            setStudio(null);
          }}
        />
      </div>
    );
  }

  // Prepare Echo Phone / Manage City snapshot lazily ONLY while those studios are open
  const phoneSnap = (isPhoneOpen || isCityOpen) ? game.phoneStateSnapshot() : null;
  const phoneResidents: Partial<Record<ResidentId, PhoneResidentMeta>> = {};
  const phoneShiftCounts: Partial<Record<PartTimeJobId, number>> = {};
  const phoneOwnedVehicles: PhoneOwnedVehicle[] = [];
  if (isPhoneOpen) {
    for (const p of game.peopleList()) {
      phoneResidents[p.id as ResidentId] = {
        id: p.id as ResidentId,
        zone: p.zone,
        zoneLabel: cleanCopyCached(p.zone),
        mood: p.mood ?? undefined,
        friendship: p.rel?.friendship ?? 15,
        online: true,
      };
    }
    for (const st of game.partTimeCareers()) {
      phoneShiftCounts[st.jobId] = st.completedShifts;
    }
    for (const o of game.s.progression.ownedObjects) {
      if (!o.category.startsWith('vehicle')) continue;
      phoneOwnedVehicles.push({
        instanceId: o.instanceId,
        name: cleanCopyCached(o.selectedVariantId.replace(/_/g, ' ')),
        kind: o.category === 'vehicle_car'
          ? 'car'
          : o.selectedVariantId.includes('scooter') || o.selectedVariantId.includes('moto')
            ? 'motorbike'
            : 'bike',
        active: game.car.spec?.instanceId === o.instanceId || game.s.progression.activeVehicleId === o.instanceId,
        locationLabel: o.location.inStorage
          ? 'In Storage'
          : o.location.zoneId
            ? game.zoneName(o.location.zoneId)
            : 'Parked',
      });
    }
  }

  const showLiveChrome = !target && !panel && !isBuildOpen;

  return (
    <div
      className={s.hud}
      data-testid="echo-life-hud"
      data-tutorial-step={stepId}
      data-locked={locked}
      data-caption={captionVisible}
      data-bottom-dock={bottomDockOpen ? 'true' : undefined}
    >
      {/* Top-Left Unified Stack: F3 Perf HUD + Shift Craft + Auto-Pruning Feed + Overheard Banter + Social Scenes */}
      {!target && !isBuildOpen && (
        <LeftFeedAndBanterIsland
          store={store}
          debugPerf={debugPerf}
          qualityTier={qualityTier}
          getPerfTelemetry={getPerfTelemetry}
          panelOpen={Boolean(panel)}
          anyStudioOpen={anyStudioOpen}
          shiftCraft={shiftCraft}
          onLockShiftCraft={handleLockShiftCraft}
          onJoinScene={handleJoinScene}
        />
      )}

      {/* Top-Right Compact Menu & Minimap Cluster (Minimap stays mounted under Pointer Lock & NPC dialogue) */}
      {!panel && !isBuildOpen && !isPhoneOpen && !isCityOpen && !shell.hasChallenge && (
        <div className={s.topRightCluster}>
          {showLiveChrome && !locked && (
            <nav className={s.menu} aria-label="Echo Life">
              {PANELS.map(p => {
                const Icon = p.Icon;
                return (
                  <button
                    key={p.id}
                    type="button"
                    title={p.label}
                    className={p.id === 'map' || p.id === 'journal' ? undefined : s.extraMenuItem}
                    data-testid={`echo-life-open-${p.id}`}
                    aria-pressed={panel === p.id || (p.id === 'workshop' && isBuildOpen)}
                    onClick={() => {
                      audio.unlock();
                      audio.triggerUiClick('open');
                      if (p.id === 'workshop') {
                        if (isBuildOpen) closeBuildStudio();
                        else openBuildStudio();
                        return;
                      }
                      setStudio(null);
                      setPanel(panel === p.id ? null : p.id);
                      signalFor(game, p.id);
                    }}
                  >
                    <Icon size={15} aria-hidden="true" />
                    <span className={s.menuLabel}>{p.label}</span>
                  </button>
                );
              })}
              {onRequestResetRoom && (
                <button
                  type="button"
                  title="Reset Room to Default"
                  className={s.extraMenuItem}
                  data-testid="echo-life-reset-room"
                  onClick={() => {
                    audio.unlock();
                    audio.triggerUiClick('open');
                    setStudio(null);
                    setPanel(null);
                    onRequestResetRoom();
                  }}
                >
                  <RotateCcw size={15} aria-hidden="true" />
                  <span className={s.menuLabel}>Reset Room</span>
                </button>
              )}
              <QuickMuteButton audio={audio} />
            </nav>
          )}

          {exploring && (
            <TopRightMinimapIsland
              store={store}
              version={version}
              waypoint={customWaypoint}
              onClearWaypoint={handleClearWaypoint}
              onExpand={handleExpandMinimap}
            />
          )}
        </div>
      )}

      {/* Bottom-Left Character Status and Needs Card */}
      {exploring && showLiveChrome && (
        <CharacterNeedsIsland
          store={store}
          hero={effectiveProfile.hero}
          heroDisplayName={heroDisplayName}
          heroInitial={heroInitial}
          audio={audio}
          onOpenCreator={handleOpenCreator}
          onNeedsExpandChange={onNeedsExpandChange}
        />
      )}

      {/* Bottom-Center Cluster: Embodied Progress Bar + Contextual Prompt + Time, Speed and Location Bar */}
      {!target && !panel && !isBuildOpen && !isPhoneOpen && !isCityOpen && !shell.hasChallenge && (
        <div className={s.bottomCenterCluster}>
          <div className={s.bottomPromptSlot}>
            <EmbodiedBarIsland store={store} />
            <FocusAndBuildPromptIsland
              store={store}
              anyStudioOpen={anyStudioOpen}
              suppressSeatedStand={suppressSeatedStandPrompt ?? exploring}
              setTarget={setTarget}
              onPlaceActiveBuild={() => void handlePlaceActiveBuild()}
              onBumpVersion={bumpVersion}
            />
          </div>
          <StatusClockBarIsland
            store={store}
            audio={audio}
            onOpenBuild={handleOpenBuildFromStatus}
            onBumpVersion={bumpVersion}
          />
        </div>
      )}

      {/* Bottom-Right Mode Dock (7 inZOI Studio and World Modes) */}
      {showLiveChrome && !locked && !shell.hasChallenge && (
        <nav className={s.modeDock} data-testid="hud-mode-dock" aria-label="Echo Life studios and modes">
          <button
            type="button"
            className={s.modeBtn}
            title="Character Studio"
            aria-pressed={isCreatorOpen}
            data-testid="hud-open-creator"
            onClick={handleOpenCreator}
          >
            <User size={16} aria-hidden="true" />
            <span>Character</span>
          </button>
          <button
            type="button"
            className={s.modeBtn}
            title="Echo Phone (Tab)"
            aria-pressed={isPhoneOpen}
            data-testid="hud-open-phone"
            onClick={() => {
              audio.unlock();
              audio.triggerUiClick(isPhoneOpen ? 'close' : 'open');
              setStudio(isPhoneOpen ? null : 'phone', 'home');
            }}
          >
            <Smartphone size={16} aria-hidden="true" />
            <span>Phone</span>
            <PhoneUnreadBadgeIsland store={store} />
          </button>
          <button
            type="button"
            className={s.modeBtn}
            title="Build Studio (B)"
            aria-pressed={isBuildOpen}
            data-testid="hud-open-build"
            onClick={() => {
              audio.unlock();
              audio.triggerUiClick(isBuildOpen ? 'close' : 'open');
              if (isBuildOpen) closeBuildStudio();
              else openBuildStudio();
            }}
          >
            <Hammer size={16} aria-hidden="true" />
            <span>Build</span>
          </button>
          <button
            type="button"
            className={s.modeBtn}
            title="Photo Studio (P)"
            aria-pressed={isPhotoOpen}
            data-testid="hud-open-photo"
            onClick={() => {
              audio.unlock();
              audio.triggerUiClick('open');
              setPhotoMode(true);
            }}
          >
            <Camera size={16} aria-hidden="true" />
            <span>Photo</span>
          </button>
          <button
            type="button"
            className={s.modeBtn}
            title="Manage City"
            aria-pressed={isCityOpen}
            data-testid="hud-open-city"
            onClick={() => {
              audio.unlock();
              audio.triggerUiClick(isCityOpen ? 'close' : 'open');
              setStudio(isCityOpen ? null : 'city');
            }}
          >
            <Building2 size={16} aria-hidden="true" />
            <span>City</span>
          </button>
          <button
            type="button"
            className={s.modeBtn}
            title="City Map (M)"
            aria-pressed={panel === 'map'}
            data-testid="hud-open-map"
            onClick={() => {
              audio.unlock();
              audio.triggerUiClick('open');
              setStudio(null);
              setPanel(panel === 'map' ? null : 'map');
              game.signal('openedMap');
            }}
          >
            <MapIcon size={16} aria-hidden="true" />
            <span>Map</span>
          </button>
          <button
            type="button"
            className={s.modeBtn}
            title="Settings"
            aria-pressed={panel === 'settings'}
            data-testid="hud-open-settings"
            onClick={() => {
              audio.unlock();
              audio.triggerUiClick('open');
              setStudio(null);
              setPanel(panel === 'settings' ? null : 'settings');
            }}
          >
            <SlidersHorizontal size={16} aria-hidden="true" />
            <span>Settings</span>
          </button>
        </nav>
      )}

      {/* Isolated vehicle speedometer & touch drive bar */}
      <VehicleSpeedoIsland store={store} hidden={Boolean(target || panel || anyStudioOpen)} />

      {/* Isolated 20 Hz / 10 Hz throttled & zero-alloc resident nameplates + peer quick-chat overlay */}
      <NameplateOverlayIsland
        host={host}
        exploring={exploring}
        hidden={Boolean(target || panel || anyStudioOpen)}
        getPeerQuickChats={getPeerQuickChats}
      />

      {/* Shared badminton court panel */}
      <CourtPanelIsland store={store} hidden={Boolean(panel || target || anyStudioOpen)} />

      {/* Nearby targets quick selector */}
      <NearbyTargetsIsland store={store} hidden={Boolean(panel || target || anyStudioOpen)} />

      {/* Wave 11 Studio: Echo Phone (9 integrated apps) */}
      {isPhoneOpen && phoneSnap && (
        <EchoPhone
          open={true}
          initialApp={effectivePhoneApp}
          accountKey={game.owner}
          playerName={heroDisplayName}
          day={game.s.day}
          weekdayIndex={game.s.day % 7}
          seasonIndex={(hud.seasonIndex % 4) as 0 | 1 | 2 | 3}
          clock={((game.s.clock % 1440) + 1440) % 1440}
          timeLabel={hud.time}
          weatherLabel={cleanCopyCached(hud.weather)}
          rain={hud.rain}
          snow={/snow/i.test(hud.weather)}
          credits={hud.credits}
          ownedAssetValue={Math.max(0, game.bankSummary().estimatedNetWorth - hud.credits)}
          playerZone={game.s.player.zone}
          phoneState={phoneSnap}
          onPhoneStateChange={next => {
            game.phoneState = next;
            game.dirty = true;
            audio.unlock();
            audio.triggerUiClick('tap');
            setVersion(v => v + 1);
          }}
          mindState={game.mindState}
          onMindStateChange={next => {
            game.mindState = next;
            game.dirty = true;
            setVersion(v => v + 1);
          }}
          careerState={game.fullTimeCareerState()}
          onCareerStateChange={next => {
            game.fullTimeCareer = next;
            game.dirty = true;
            audio.unlock();
            audio.triggerUiClick('confirm');
            setVersion(v => v + 1);
          }}
          shiftCounts={phoneShiftCounts}
          activeShiftJobId={(game.activeShift?.job as PartTimeJobId | undefined) ?? null}
          residents={phoneResidents}
          cookingInventory={mergeCookingInventory(game.s.bag, game.s.pantry, game.s.progression.materials)}
          cookingLevel={Math.max(game.s.progression.skills.cooking?.level ?? 1, game.mindState.subSkills.cooking.level)}
          bistroOpen={isZoneOpen(V3_ZONES.bistro, game.s.clock).open}
          marketOpen={isZoneOpen(V3_ZONES.market, game.s.clock).open}
          flashSaleActive={dailySnapshotFor(game, hud).marketSaleLive}
          busStops={game.busStops()}
          ownedVehicles={phoneOwnedVehicles}
          onTrackShift={jobId => {
            const st = game.partTimeCareers().find(c => c.jobId === jobId);
            game.say(
              st ? `Head to ${game.zoneName(st.zone)} to start your ${st.title} shift.` : 'Head to the shift station to clock in.',
              'info',
            );
            setVersion(v => v + 1);
          }}
          onStartFullTimeWorkday={() => {
            game.dirty = true;
            setVersion(v => v + 1);
          }}
          onResolveDilemma={() => {
            game.dirty = true;
            setVersion(v => v + 1);
          }}
          onHangoutAccepted={plan => {
            game.people.notifyPlayerInteraction(game.s, plan.npcId, 'activity', 'hangout:' + plan.venue);
            game.dirty = true;
            setVersion(v => v + 1);
          }}
          onBoardShuttle={trip => {
            if (trip.to) {
              setStudio(null);
              void host.rideBusShuttle(trip.to.id);
            }
          }}
          onSetWaypoint={(zone, label) => {
            const safeLabel = cleanCopyCached(label);
            const wp =
              game.nav.city.zones.find(z => z.id === zone)?.waypoint ??
              game.nav.city.buildings.find(b => b.id === zone)?.outsidePoint ??
              null;
            if (wp) {
              setCustomWaypoint({
                x: wp.x,
                z: wp.z,
                zone,
                label: safeLabel,
                setFromZone: game.s.player.zone,
              });
            }
            game.say(`Destination noted: ${safeLabel} (${game.zoneName(zone)}).`, 'info');
            setStudio(null);
          }}
          onSummonVehicle={instanceId => {
            void host.saverNow?.configure({ type: 'select_vehicle', instanceId }).then(r => {
              if (r.ok) game.say(cleanCopyCached(r.msg), 'good');
              setVersion(v => v + 1);
            });
          }}
          onNotify={(message, tone) => {
            game.say(cleanCopyCached(message), tone === 'bad' ? 'bad' : tone === 'story' ? 'story' : 'good');
            setVersion(v => v + 1);
          }}
          onClose={() => setStudio(null)}
        />
      )}

      {/* Wave 11 Studio: Visual Build Studio (replaces legacy Workshop drawer) */}
      {isBuildOpen && (
        <>
          {host.building && (
            <div className={s.bottomCenterCluster} style={{ bottom: 268 }}>
              <div className={s.prompt} style={{ pointerEvents: 'auto' }}>
                <button type="button" onClick={() => { host.buildYaw += Math.PI / 4; setVersion(v => v + 1); }}>Rotate</button>
                <button type="button" onClick={() => void handlePlaceActiveBuild()}>
                  {host.building.startsWith('ec_') ? 'Place (E)' : 'Relocate Here'}
                </button>
                <button type="button" onClick={() => { host.cancelBuild(); setVersion(v => v + 1); }}>Cancel</button>
                {host.buildMessage && <span role="status">{cleanCopyCached(host.buildMessage)}</span>}
              </div>
            </div>
          )}
          <BuildStudio
            open={true}
            host={host}
            initialItemId={selectedEquipment}
            topDownCamera={topDownCamera}
            gridSnapMeters={gridSnapMeters}
            placementValid={
              host.building
                ? (host.buildMessage ? !/cannot|blocked|outside|invalid|no room/i.test(host.buildMessage) : true)
                : null
            }
            activePlacingLabel={
              host.building
                ? cleanCopyCached(host.building.replace(/^obj_starter_/, '').replace(/_/g, ' '))
                : null
            }
            onToggleTopDownCamera={() => {
              setTopDownCamera(prev => {
                const next = !prev;
                onBuildCameraChange?.(next, { zoom: 11, yaw: 0 });
                return next;
              });
            }}
            onCycleGridSnap={next => {
              setGridSnapMeters(next);
              audio.unlock();
              audio.triggerUiClick('tap');
            }}
            onRotateBuild={deltaDeg => {
              host.buildYaw += (deltaDeg * Math.PI) / 180;
              audio.unlock();
              audio.triggerUiClick('tap');
              setVersion(v => v + 1);
            }}
            onApplyCustomTint={(_instanceId, colorHex, patternId) => {
              game.say(`Updated finish preview to ${patternId} (${colorHex}).`, 'good');
              setVersion(v => v + 1);
            }}
            onApplyRoomPreset={(preset: BuildRoomPreset) => {
              const hostPresetId = ROOM_PRESET_HOST_MAP[preset.id] ?? preset.id;
              void host.applyRoomPreset(hostPresetId).then(() => setVersion(v => v + 1));
            }}
            onClose={closeBuildStudio}
          />
        </>
      )}

      {/* Wave 11 Studio: Manage City Modal */}
      {isCityOpen && phoneSnap && (
        <ManageCityModal
          open={true}
          seasonIndex={(hud.seasonIndex % 4) as 0 | 1 | 2 | 3}
          weather={(host.envControl.weather === 'overcast' ? 'cloudy' : host.envControl.weather) as ManageCityWeatherOption}
          clockMinutes={((game.s.clock % 1440) + 1440) % 1440}
          cityConfig={phoneSnap.cityConfig}
          personalKarma={game.mindState.karma.personal}
          onSeasonChange={idx => {
            host.setEnvironment({ season: idx });
            setVersion(v => v + 1);
          }}
          onWeatherChange={w => {
            host.setEnvironment({ weather: w });
            setVersion(v => v + 1);
          }}
          onClockChange={mins => {
            host.setTimeOfDay(mins / 60);
            setVersion(v => v + 1);
          }}
          onCityConfigChange={next => {
            host.updateManageCity(next);
            setVersion(v => v + 1);
          }}
          onClose={() => setStudio(null)}
        />
      )}

      <ChallengeIsland store={store} onLeaveBasketball={onLeaveBasketball} />
      {target && (
        <TargetPanel
          game={game}
          host={host}
          audio={audio}
          target={target}
          reply={reply}
          setReply={setReply}
          bump={bumpVersion}
          act={act}
          close={close}
          version={version}
        />
      )}
      {panel && panel !== 'workshop' && (
        <Menu
          equipment={selectedEquipment}
          initialShop={selectedShop}
          onShopConsumed={() => setSelectedShop(null)}
          game={game}
          host={host}
          hud={hud}
          panel={panel}
          setPanel={p => {
            if (p === 'workshop') {
              openBuildStudio();
              return;
            }
            setPanel(p);
          }}
          version={version}
          bump={bumpVersion}
          qualityTier={qualityTier}
          onQualityTier={onQualityTier}
          getPerfTelemetry={getPerfTelemetry}
          debugPerf={debugPerf}
          onToggleDebugPerf={() => setDebugPerf(v => !v)}
          onEnterPhotoMode={() => { setPanel(null); setPhotoMode(true); }}
          onRequestResetRoom={onRequestResetRoom ? () => { setPanel(null); onRequestResetRoom(); } : undefined}
          audio={audio}
        />
      )}
      {shell.ending && <EndingBadge id={shell.ending} />}
    </div>
  );
});

function signalFor(game: NonNullable<EchoLifeGameHost['game']>, p: LifePanel) {
  if (p === 'map') game.signal('openedMap');
  if (p === 'journal' || p === 'people') game.signal('openedJournal');
  if (p === 'bag') game.signal('openedBag');
}

function Bars({ rel }: { rel: { friendship: number; trust: number; familiarity: number; respect: number; rivalry: number } }) {
  return (
    <div className={s.bars}>
      {(['friendship', 'trust', 'familiarity', 'respect', 'rivalry'] as const).map(k => (
        <label key={k}>
          <span>{k}</span>
          <i style={{ width: `${Math.max(2, Math.min(100, rel[k]))}%` }} data-k={k} />
          <em>{Math.round(rel[k])}</em>
        </label>
      ))}
    </div>
  );
}

function TargetPanel({
  game,
  host,
  audio,
  target,
  reply,
  setReply,
  bump,
  act,
  close,
}: {
  game: NonNullable<EchoLifeGameHost['game']>;
  host: EchoLifeGameHost;
  audio: EchoLifeWorldAudio;
  target: Target;
  reply: V3Result | null;
  setReply: (r: V3Result | null) => void;
  bump: () => void;
  act: (t: Target, o: V3Option) => void;
  close: () => void;
  version: number;
}) {
  const [dishBusy, setDishBusy] = useState(false);
  const npc = target.kind === 'npc' ? game.s.npcs[target.id] : null;
  const person = target.kind === 'npc' ? game.peopleList().find(p => p.id === target.id) : null;
  const speaker = target.kind === 'npc' ? CHARACTERS[target.id]?.name : target.kind === 'spot' ? target.label : 'Interaction';
  const rawOptions = game.options(target);
  const residentId = target.kind === 'npc' ? target.id : undefined;
  const walker = residentId ? game.people.walkers.get(residentId) : undefined;
  const mood = person?.mood ?? walker?.mood ?? null;
  const diary = residentId ? game.getResidentDiary(residentId) : null;

  const isBistroCounter = target.kind === 'spot' && ['bistro_order', 'bistro_snack'].includes(target.hotspot.action);
  const isHomeStove = target.kind === 'spot' && target.hotspot.action === 'cook';

  // Avoid showing duplicate raw dish buttons below when the rich multi-item picker is rendered above
  const options = useMemo(() => {
    if (isBistroCounter) return rawOptions.filter(o => !o.key.startsWith('bistro_order:'));
    if (isHomeStove) return rawOptions.filter(o => !o.key.startsWith('cook:'));
    return rawOptions;
  }, [rawOptions, isBistroCounter, isHomeStove]);

  const onSpeechCue = useCallback((ch: string) => {
    if (!residentId) return;
    const pos = walker ? { x: walker.x, y: (walker.groundY ?? 0) + 1.5, z: walker.z } : undefined;
    audio.triggerSpeechSyllable(residentId, mood ?? undefined, ch, pos);
  }, [audio, residentId, mood, walker]);

  const credits = game.s.progression.economy.credits;
  const cookingInv = isHomeStove ? mergeCookingInventory(game.s.bag, game.s.pantry, game.s.progression.materials) : null;
  const cookableList = isHomeStove ? game.cookableRecipes() : [];

  const handleOrderBistro = async (sku: string) => {
    if (dishBusy) return;
    setDishBusy(true);
    try {
      const res = await host.orderBistroItem(sku);
      setReply(res);
      bump();
    } finally {
      setDishBusy(false);
    }
  };

  const handleCookRecipe = async (recipeId: string) => {
    if (dishBusy) return;
    setDishBusy(true);
    try {
      const res = await host.cookRecipe(recipeId);
      setReply(res);
      bump();
    } finally {
      setDishBusy(false);
    }
  };

  const extraContent = isBistroCounter ? (
    <div className={s.dishPicker} data-testid="bistro-menu-picker" aria-label="Willow Corner Bistro menu">
      <div className={s.dishPickerHead}>
        <span>Willow Corner Bistro Menu (5 Dishes)</span>
        <span>{credits.toLocaleString('en-US')} CC</span>
      </div>
      <div className={s.dishGrid}>
        {BISTRO_MENU.map(item => (
          <div key={item.id} className={s.dishCard} data-testid={`bistro-dish-${item.id}`}>
            <div>
              <div className={s.dishCardHead}>
                <strong>{cleanDisplayCopy(item.name)}</strong>
                <span>{item.price} CC</span>
              </div>
              <p className={s.dishDesc}>{cleanDisplayCopy(item.description)}</p>
              <div className={s.dishMeta}>
                <span>+{item.needsDelta.hunger} Hunger</span>
                <span>· {cleanDisplayCopy(item.buff.label)}</span>
              </div>
            </div>
            <button
              type="button"
              className={s.dishBtn}
              disabled={dishBusy || credits < item.price}
              data-testid={`bistro-order-btn-${item.id}`}
              onClick={() => void handleOrderBistro(item.id)}
            >
              Order ({item.price} CC)
            </button>
          </div>
        ))}
      </div>
    </div>
  ) : isHomeStove ? (
    <div className={s.dishPicker} data-testid="home-cooking-picker" aria-label="Home kitchen recipe book">
      <div className={s.dishPickerHead}>
        <span>Home Kitchen Recipes (10 Dishes)</span>
        <span>Cooking Lv.{Math.max(game.s.progression.skills.cooking?.level ?? 1, game.mindState.subSkills.cooking.level)}</span>
      </div>
      <div className={s.dishGrid}>
        {cookableList.map(({ recipe, eligibility }) => (
          <div key={recipe.id} className={s.dishCard} data-testid={`home-recipe-${recipe.id}`}>
            <div>
              <div className={s.dishCardHead}>
                <strong>{cleanDisplayCopy(recipe.name)}</strong>
                <span>Lv.{recipe.requiredCookingLevel}</span>
              </div>
              <p className={s.dishDesc}>{cleanDisplayCopy(recipe.description)}</p>
              <div className={s.dishMeta}>
                {(Object.entries(recipe.ingredients) as [IngredientId, number][]).map(([ing, qty]) => {
                  const have = Math.floor(Number(cookingInv?.[ing] ?? 0));
                  return (
                    <span key={ing}>
                      {INGREDIENT_LABELS[ing].label} {have}/{qty}
                    </span>
                  );
                })}
              </div>
            </div>
            <button
              type="button"
              className={s.dishBtn}
              disabled={dishBusy || !eligibility.ok}
              data-testid={`home-cook-btn-${recipe.id}`}
              onClick={() => void handleCookRecipe(recipe.id)}
            >
              {eligibility.ok ? `Cook (+${recipe.needsDelta.hunger} Hunger)` : cleanDisplayCopy(eligibility.reason)}
            </button>
          </div>
        ))}
      </div>
    </div>
  ) : null;

  return (
    <CinematicDialogue
      residentId={residentId}
      role={person?.role}
      badge={person?.badge ?? undefined}
      mood={mood}
      rel={person?.rel ?? null}
      perk={person?.perk ?? null}
      memory={person?.latestMemory ?? person?.rel?.memories.at(-1)?.detail}
      diary={diary}
      extraContent={extraContent}
      speaker={speaker ?? 'Resident'}
      text={reply?.msg ?? person?.quip ?? npc?.scheduleNote ?? ''}
      options={options}
      onSpeechCue={residentId ? onSpeechCue : undefined}
      onChoose={option => act(target, option)}
      onClose={close}
    />
  );
}

function Challenge({
  host,
  hud,
  onLeaveBasketball,
}: {
  host: EchoLifeGameHost;
  hud: GameHud;
  onLeaveBasketball?: () => void;
}) {
  const game = host.game!;
  const ch = hud.challenge!;
  const bar = useRef<HTMLDivElement | null>(null);
  const powerBar = useRef<HTMLDivElement | null>(null);
  const sport = ch.type === 'sport';
  const timing = !['arcade', 'music_jam'].includes(ch.type);
  const held = useRef<number | null>(null);

  function releaseShot() {
    if (held.current === null) return;
    host.shootBasketball(Math.min(1, (performance.now() - held.current) / 1000));
    host.setBasketballAimPower(0);
    held.current = null;
    if (powerBar.current) powerBar.current.style.width = '0%';
  }

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (document.visibilityState !== 'visible') return;
      if (sport) {
        const p = held.current === null ? 0 : Math.min(1, (performance.now() - held.current) / 1000);
        host.setBasketballAimPower(p);
        if (powerBar.current) {
          powerBar.current.style.width = `${(p * 100).toFixed(1)}%`;
        }
        return;
      }
      const c = game.s.challenge;
      if (!c || !bar.current) return;
      const phase = ((game.s.elapsed - c.start) % 1.4) / 1.4;
      bar.current.style.left = `${(phase * 100).toFixed(1)}%`;
    };
    raf = requestAnimationFrame(loop);
    const key = (e: KeyboardEvent) => {
      const map: Record<string, number> = { ArrowLeft: 0, ArrowUp: 1, ArrowRight: 2, ArrowDown: 3 };
      if (sport && (e.code === 'Space' || e.code === 'Enter')) {
        e.preventDefault(); e.stopImmediatePropagation(); held.current ??= performance.now(); return;
      }
      if (sport && e.code === 'KeyR' && !e.repeat) {
        e.preventDefault(); e.stopImmediatePropagation(); host.summonBasketball(); return;
      }
      if (timing && (e.code === 'Space' || e.code === 'Enter')) { e.preventDefault(); game.challenge(0); }
      else if (!timing && e.key in map) { e.preventDefault(); game.challenge(map[e.key]); }
    };
    window.addEventListener('keydown', key, true);
    const up = (e: KeyboardEvent) => { if (sport && (e.code === 'Space' || e.code === 'Enter')) { e.preventDefault(); releaseShot(); } };
    window.addEventListener('keyup', up, true);
    return () => {
      cancelAnimationFrame(raf);
      host.setBasketballAimPower(0);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('keyup', up, true);
    };
  }, [game, timing, sport, host]);

  if (sport) {
    const bb = hud.basketball;
    const shotBadge =
      bb?.lastShotResult === 'streak_bonus' ? 'HOT STREAK'
      : bb?.lastShotResult === 'score_3' ? '+3 SWISH'
      : bb?.lastShotResult === 'score_2' ? '+2 PT'
      : bb?.lastShotResult === 'miss' ? 'REBOUND'
      : null;
    const handleLeaveCourt = () => {
      host.setBasketballAimPower(0);
      if (onLeaveBasketball) onLeaveBasketball();
      else host.leaveBasketballCourt();
    };
    return (
      <section className={s.shotControls} aria-label="Basketball" data-testid="echo-life-basketball-hud">
        <div className={s.ballStats}>
          <strong>Basketball</strong>
          {bb?.isThreePointRange && <span className={s.ballRangePill}>3-PT RANGE</span>}
          {shotBadge && <span className={s.ballResultPill}>{shotBadge}</span>}
          <span>Score: <b>{bb?.score ?? 0}</b></span>
          <span>Streak: <b>{bb?.streak ?? 0}</b></span>
          {(bb?.bestStreak ?? 0) > 0 && <span>Best: <b>{bb?.bestStreak}</b></span>}
        </div>
        <div className={s.powerTrack} aria-label="Shot power meter">
          <span className={s.powerSweet} />
          <div ref={powerBar} className={s.powerFill} />
        </div>
        <div className={s.ballBtns}>
          <button
            type="button"
            onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); held.current = performance.now(); }}
            onPointerCancel={() => {
              held.current = null;
              host.setBasketballAimPower(0);
              if (powerBar.current) powerBar.current.style.width = '0%';
            }}
            onPointerUp={releaseShot}
          >
            Hold to shoot · Space
          </button>
          <button type="button" onClick={() => host.summonBasketball()}>Summon ball (R)</button>
          <button type="button" data-testid="echo-life-basketball-leave" onClick={handleLeaveCourt}>Leave court</button>
        </div>
      </section>
    );
  }
  return (
    <section className={s.challenge} role="dialog" aria-label="Challenge" data-testid="echo-life-challenge">
      <h2>{ch.type === 'music_jam' ? 'Strum the chords in order' : ch.type === 'arcade' ? 'Repeat the arrow sequence' : 'Press Space in the green band'}</h2>
      {timing ? (
        <div className={s.track}><span className={s.band} /><div ref={bar} className={s.marker} /></div>
      ) : (
        <>
          <div className={s.sequence}>{ch.sequence.map((d, i) => <b key={i} data-done={i < ch.index ? '1' : ''}>{ARROWS[d]}</b>)}</div>
          <div className={s.pad}>{ARROWS.map((a, i) => <button key={a} type="button" onClick={() => game.challenge(i)}>{a}</button>)}</div>
        </>
      )}
      {timing && <button type="button" className={s.primary} onClick={() => game.challenge(0)}>Now!</button>}
    </section>
  );
}

function EndingBadge({ id }: { id: string }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <section className={s.ending} data-testid="echo-life-ending">
      <p>Your semester is complete · Ending: <b>{id.replace(/_/g, ' ')}</b></p>
      <button type="button" className={s.linkBtn} onClick={() => setOpen(false)}>Keep living in Riverside</button>
    </section>
  );
}

function Menu({
  game,
  host,
  hud,
  panel,
  setPanel,
  bump,
  equipment,
  initialShop,
  onShopConsumed,
  qualityTier,
  onQualityTier,
  getPerfTelemetry,
  debugPerf,
  onToggleDebugPerf,
  onEnterPhotoMode,
  onRequestResetRoom,
  audio,
}: {
  equipment: string;
  initialShop: string | null;
  onShopConsumed: () => void;
  game: NonNullable<EchoLifeGameHost['game']>;
  host: EchoLifeGameHost;
  hud: GameHud;
  panel: LifePanel;
  setPanel: (p: LifePanel | null) => void;
  version: number;
  bump: () => void;
  qualityTier: QualityTier;
  onQualityTier?: (tier: QualityTier) => void;
  getPerfTelemetry?: () => PerfTelemetry | null;
  debugPerf: boolean;
  onToggleDebugPerf: () => void;
  onEnterPhotoMode: () => void;
  onRequestResetRoom?: () => void;
  audio: EchoLifeWorldAudio;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); setPanel(null); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [setPanel]);

  let body: ReactNode = null;
  if (panel === 'map') body = <MapView game={game} host={host} hud={hud} />;
  if (panel === 'journal') body = <Journal game={game} hud={hud} />;
  if (panel === 'people') body = <People game={game} />;
  if (panel === 'bag') body = <Bag game={game} host={host} bump={bump} />;
  if (panel === 'workshop') body = <Workshop initialId={equipment} host={host} close={() => setPanel(null)} />;
  if (panel === 'shops') body = <Shops game={game} host={host} hud={hud} initialShop={initialShop} onShopConsumed={onShopConsumed} bump={bump} />;
  if (panel === 'settings') {
    body = (
      <Settings
        game={game}
        host={host}
        bump={bump}
        qualityTier={qualityTier}
        onQualityTier={onQualityTier}
        getPerfTelemetry={getPerfTelemetry}
        debugPerf={debugPerf}
        onToggleDebugPerf={onToggleDebugPerf}
        onEnterPhotoMode={onEnterPhotoMode}
        onRequestResetRoom={onRequestResetRoom}
        audio={audio}
      />
    );
  }

  return (
    <section className={s.menuPanel} role="dialog" aria-label="Echo Life" data-testid={`echo-life-panel-${panel}`}>
      <header>
        <nav>
          {PANELS.map(p => (
            <button
              key={p.id}
              type="button"
              aria-pressed={panel === p.id}
              onClick={() => {
                audio.unlock();
                audio.triggerUiClick('tap');
                setPanel(p.id);
                signalFor(game, p.id);
              }}
            >
              {p.label}
            </button>
          ))}
        </nav>
        <button
          type="button"
          className={s.close}
          onClick={() => {
            audio.triggerUiClick('close');
            setPanel(null);
          }}
          aria-label="Close"
        >
          ×
        </button>
      </header>
      <div className={s.menuBody}>{body}</div>
    </section>
  );
}

function MapView({ game, host, hud }: { game: NonNullable<EchoLifeGameHost['game']>; host: EchoLifeGameHost; hud: GameHud }) {
  const me = host.bodyNow(), presence = host.cityPresence, gathering = presence?.gathering;
  const [inviting, setInviting] = useState(false), [failed, setFailed] = useState(false);
  const invite = async (id: string) => {
    setInviting(true); setFailed(false);
    try { await host.inviteToEvent(id); }
    catch { setFailed(true); }
    finally { setInviting(false); }
  };
  const city = game.nav.city;
  const b = city.bounds;
  const m = game.map();
  const daily = dailySnapshotFor(game, hud);
  const shift = game.activeShiftTarget();
  const [pick, setPick] = useState<string | null>(null);
  const W = 920, H = Math.round(W * (b.z1 - b.z0) / (b.x1 - b.x0));
  const X = (x: number) => (x - b.x0) / (b.x1 - b.x0) * W, Z = (z: number) => (z - b.z0) / (b.z1 - b.z0) * H;
  const objectives = new Set(m.objectives.map(o => o.zone));
  const events = new Set([...m.events.map(e => e.zone), ...daily.liveActivities.map(a => a.zone)]);
  const here = game.s.player.zone;
  const [zoom, setZoom] = useState(1);
  const [centre, setCentre] = useState({ x: W / 2, z: H / 2 });
  const drag = useRef<{ x: number; y: number; cx: number; cz: number; moved: boolean } | null>(null);
  const vw = W / zoom, vh = H / zoom;
  const left = Math.min(W - vw, Math.max(0, centre.x - vw / 2));
  const top = Math.min(H - vh, Math.max(0, centre.z - vh / 2));
  const who = pick ? game.peopleList().filter(p => p.zone === game.zoneName(pick)) : [];
  const venue = gathering && city.zones.find(z => z.id === gathering.zone)?.waypoint;

  return (
    <div className={s.map}>
      <div className={s.geography}>
        <div className={s.mapTools}>
          <button type="button" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom(z => Math.max(1, z / 1.5))}>−</button>
          <button type="button" aria-label="Zoom in" disabled={zoom >= 6} onClick={() => setZoom(z => Math.min(6, z * 1.5))}>+</button>
          <button type="button" disabled={!me} onClick={() => { if (me) { setCentre({ x: X(me.x), z: Z(me.z) }); setZoom(3); } }}>Find me</button>
          <button type="button" onClick={() => { setZoom(1); setCentre({ x: W / 2, z: H / 2 }); }}>Fit city</button>
        </div>
        <svg
          viewBox={`${left} ${top} ${vw} ${vh}`}
          role="group"
          aria-label="Map of Riverside"
          onPointerDown={e => { drag.current = { x: e.clientX, y: e.clientY, cx: left + vw / 2, cz: top + vh / 2, moved: false }; }}
          onPointerMove={e => {
            const d = drag.current;
            if (!d || !e.buttons || zoom === 1) return;
            const dx = e.clientX - d.x, dy = e.clientY - d.y;
            if (Math.hypot(dx, dy) < 4 && !d.moved) return;
            const scale = e.currentTarget.getScreenCTM()?.a;
            if (!scale) return;
            d.moved = true; e.currentTarget.setPointerCapture(e.pointerId);
            setCentre({ x: d.cx - dx / scale, z: d.cz - dy / scale });
          }}
          onClickCapture={e => { if (drag.current?.moved) e.stopPropagation(); drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}
        >
          {city.ground.map((g, i) => (
            <rect
              key={i}
              x={X(g.rect.x0)}
              y={Z(g.rect.z0)}
              width={X(g.rect.x1) - X(g.rect.x0)}
              height={Z(g.rect.z1) - Z(g.rect.z0)}
              fill={g.surface === 'road' || g.surface === 'crossing' ? '#7b8c92' : g.surface === 'park' || g.surface === 'garden' ? '#87ac8b' : '#bbbab0'}
            />
          ))}
          {city.residences.filter(r => (game.s.progression.properties.ownedIds as string[]).includes(r.property!.id)).map(r => (
            <g key={r.property!.id}>
              <title>{cleanDisplayCopy(r.name.en)}</title>
              <rect
                x={X(r.rect.x0)}
                y={Z(r.rect.z0)}
                width={X(r.rect.x1) - X(r.rect.x0)}
                height={Z(r.rect.z1) - Z(r.rect.z0)}
                className={s.mapZone}
                data-here={host.worldRegion === r.property!.id ? '1' : '0'}
              />
            </g>
          ))}
          {city.zones.map(z => {
            const hidden = V3_ZONES[z.id]?.hiddenUntilDiscovered && !m.discovered.has(z.id);
            if (hidden) return null;
            return (
              <g
                key={z.id}
                onClick={() => setPick(z.id)}
                data-zone={z.id}
                tabIndex={0}
                role="button"
                aria-label={cleanDisplayCopy(z.name.en)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPick(z.id); } }}
              >
                <title>{cleanDisplayCopy(z.name.en)}</title>
                <rect
                  x={X(z.rect.x0)}
                  y={Z(z.rect.z0)}
                  width={Math.max(2, X(z.rect.x1) - X(z.rect.x0))}
                  height={Math.max(2, Z(z.rect.z1) - Z(z.rect.z0))}
                  className={s.mapZone}
                  data-picked={z.id === pick}
                  data-here={z.id === here ? '1' : ''}
                  data-goal={objectives.has(z.id) ? '1' : ''}
                  data-event={events.has(z.id) ? '1' : ''}
                />
              </g>
            );
          })}
          {[...game.people.walkers.values()].map(w => (
            <circle key={w.id} cx={X(w.x)} cy={Z(w.z)} r={4} className={s.mapNpc}><title>{cleanDisplayCopy(CHARACTERS[w.id]?.name)}</title></circle>
          ))}
          {shift && <circle cx={X(shift.at.x)} cy={Z(shift.at.z)} r={6} className={s.mapShift}><title>{cleanDisplayCopy(shift.label)}</title></circle>}
          {me && <circle cx={X(me.x)} cy={Z(me.z)} r={6} className={s.mapMe}><title>You</title></circle>}
          {venue && gathering && (
            <circle cx={X(venue.x + gathering.x)} cy={Z(venue.z + gathering.z)} r={8} fill="none" stroke="currentColor" strokeWidth={3}>
              <title>{cleanDisplayCopy(gathering.title)}</title>
            </circle>
          )}
        </svg>
      </div>
      <aside>
        {gathering && (
          <section data-testid="city-gathering">
            <h4>{cleanDisplayCopy(gathering.title)}</h4>
            <p>{game.zoneName(gathering.zone)} · {gathering.present} present · {gathering.ready} ready</p>
            {gathering.celebrated ? <p role="status">The group cheered together!</p> :
              !gathering.nearby ? <p>Walk to the meeting point on the map.</p> :
              !gathering.joined ? <button type="button" onClick={() => presence?.respondToEvent(gathering.invitation, 'join')}>Join gathering</button> :
              <button type="button" disabled={gathering.readySelf} onClick={() => presence?.respondToEvent(gathering.invitation, 'ready')}>Ready to cheer</button>}
            {gathering.joined && (
              <button type="button" onClick={() => presence?.respondToEvent(gathering.invitation, gathering.organizer ? 'end' : 'leave')}>
                {gathering.organizer ? 'End gathering' : 'Leave gathering'}
              </button>
            )}
          </section>
        )}
        <h3>{pick ? game.zoneName(pick) : 'Riverside'}</h3>
        {pick ? (
          <>
            <p className={s.note}>{cleanDisplayCopy(V3_ZONES[pick]?.district)}</p>
            {who.length ? <ul>{who.map(p => <li key={p.id}><b>{cleanDisplayCopy(p.name)}</b> — {cleanDisplayCopy(p.note)}</li>)}</ul> : <p className={s.note}>Nobody you know is here right now.</p>}
          </>
        ) : (
          <p className={s.note}>Select a place. Gold: story objectives. Teal: live events. Amber: active shift. Dots: residents.</p>
        )}
        {shift && (
          <>
            <h4>Active shift</h4>
            <p className={s.note}><b>Step {shift.step}/{shift.total}:</b> {cleanDisplayCopy(shift.label)} ({game.zoneName(shift.zone)})</p>
          </>
        )}
        <h4>Objectives</h4>
        <ul>{m.objectives.map(o => <li key={o.id}>{cleanDisplayCopy(o.title)} — {game.zoneName(o.zone)}</li>)}</ul>
        {(m.events.length > 0 || daily.liveActivities.length > 0) && (
          <>
            <h4>Live now</h4>
            <ul>
              {m.events.map(e => (
                <li key={e.id}>
                  <span className={s.liveBadge}>Live</span> {cleanDisplayCopy(e.title)} — {game.zoneName(e.zone)}
                  {presence?.connected && !gathering && here === e.zone && game.s.worldV3.eventsAttended.includes(e.id + '@day' + game.s.day) && (
                    <button type="button" disabled={inviting} onClick={() => void invite(e.id)}>Invite study room</button>
                  )}
                </li>
              ))}
              {daily.liveActivities.map(a => (
                <li key={a.id}>
                  <span className={s.liveBadge}>Live</span> <b>{cleanDisplayCopy(a.title)}</b> — {cleanDisplayCopy(a.zoneName)} <em>{a.windowLabel}</em>
                </li>
              ))}
            </ul>
          </>
        )}
        {daily.upcomingActivities.length > 0 && (
          <>
            <h4>Coming up today</h4>
            <ul>
              {daily.upcomingActivities.slice(0, 3).map(a => (
                <li key={a.id}>
                  <span className={s.soonBadge}>Soon</span> {cleanDisplayCopy(a.title)} — {cleanDisplayCopy(a.zoneName)} <em>{a.windowLabel}</em>
                </li>
              ))}
            </ul>
          </>
        )}
        {failed && !gathering && <p role="alert">Could not send the invitation. Check the event and connection, then try again.</p>}
      </aside>
    </div>
  );
}

function Journal({ game, hud }: { game: NonNullable<EchoLifeGameHost['game']>; hud: GameHud }) {
  const j = useMemo(() => game.journal(), [game]);
  const daily = dailySnapshotFor(game, hud);
  const [tab, setTab] = useState<'today' | 'story' | 'side' | 'activities' | 'codex'>('story');

  return (
    <div className={s.journal} data-testid="echo-life-journal">
      {game.tutorialStep && (
        <section data-testid="echo-life-tutorial" data-step={game.tutorialStep.id}>
          <h3>{cleanDisplayCopy(game.tutorialStep.goalLabel)}</h3>
          <p>{cleanDisplayCopy(HOST_HINT[game.tutorialStep.id] ?? game.tutorialStep.desktopHint)}</p>
          <button type="button" className={s.linkBtn} onClick={() => game.skipTutorial()}>Skip the introduction</button>
        </section>
      )}
      <nav className={s.tabs}>
        {([
          ['today', 'Today'],
          ['story', 'Story'],
          ['side', 'Side arcs'],
          ['activities', 'Activities'],
          ['codex', 'Codex'],
        ] as const).map(([id, label]) => (
          <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>
      {tab === 'today' && (
        <div data-testid="echo-life-today">
          <h3>Today in Riverside · {daily.weekday} {daily.timeText}</h3>
          <p className={s.note}>{cleanDisplayCopy(daily.weatherSummary)}</p>
          <div className={s.badgeRow}>
            {daily.marketSaleLive && <span className={s.saleBadge}>Sunrise Market 20% SALE</span>}
            {daily.weatherPicks.map(p => <span key={p} className={s.openBadge}>{cleanDisplayCopy(p)}</span>)}
          </div>
          <ul>
            {daily.activities.map(a => (
              <li key={a.id} className={s.todayCard}>
                <div className={s.todayCardHead}>
                  <b>{cleanDisplayCopy(a.title)}</b>
                  <span className={a.status === 'live' ? s.liveBadge : a.status === 'upcoming' ? s.soonBadge : s.closedBadge}>
                    {a.status === 'live' ? 'Live' : a.status === 'upcoming' ? 'Soon' : a.status === 'weather_paused' ? 'Weather paused' : 'Later'}
                  </span>
                </div>
                <p>{cleanDisplayCopy(a.subtitle)} · {cleanDisplayCopy(a.zoneName)} ({a.windowLabel}, {a.daysLabel})</p>
                <small>{cleanDisplayCopy(a.statusNote)} · {cleanDisplayCopy(a.rewardSummary)}</small>
              </li>
            ))}
          </ul>
        </div>
      )}
      {tab === 'story' && (
        <div>
          {j.chapters.map(ch => (
            <section key={ch.index}>
              <h3>Chapter {ch.index + 1} · {cleanDisplayCopy(ch.title)}</h3>
              <ul>
                {ch.missions.map(q => (
                  <li key={q.id} data-state={q.state}>
                    <b>{cleanDisplayCopy(q.title)}</b> <em>{q.zone}</em>
                    <p>{cleanDisplayCopy(q.state === 'active' ? q.hint : q.state === 'done' ? q.note : 'Locked')}</p>
                    {q.state === 'active' && <small>Step {q.step}/{q.steps} · {q.reward} CC</small>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <section>
            <h3>Your choices</h3>
            <ul>{j.choices.map(c => <li key={c.id}><b>{cleanDisplayCopy(c.title)}</b> <p>{cleanDisplayCopy(c.label ?? 'Not decided yet')}</p></li>)}</ul>
          </section>
          <section>
            <h3>Endings</h3>
            <p>{j.ending ? `Reached: ${cleanDisplayCopy(j.ending.title)}` : `Three endings are possible (${j.endings.map(e => cleanDisplayCopy(e.title)).join(', ')}); yours follows your choices.`}</p>
          </section>
        </div>
      )}
      {tab === 'side' && (
        <ul>
          {j.side.map(q => (
            <li key={q.id} data-state={q.done ? 'done' : q.started ? 'active' : 'locked'}>
              <b>{cleanDisplayCopy(q.title)}</b> <em>{q.lead} · {cleanDisplayCopy(q.category)}</em>
              <p>{cleanDisplayCopy(q.summary)}</p>
              <small>{q.done ? 'Completed' : `Stage ${Math.min(q.stage + 1, q.stages.length)}/${q.stages.length}: ${cleanDisplayCopy(q.stages[Math.min(q.stage, q.stages.length - 1)])}`}</small>
            </li>
          ))}
        </ul>
      )}
      {tab === 'activities' && (
        <ul>
          {j.activities.map(a => (
            <li key={a.id}><b>{cleanDisplayCopy(a.title)}</b> <em>{cleanDisplayCopy(a.category)} · {a.zoneName}</em><p>{cleanDisplayCopy(a.mechanic)}</p></li>
          ))}
        </ul>
      )}
      {tab === 'codex' && (
        <div>
          <h3>Landmarks ({j.codex.landmarks.filter(l => l.found).length}/{j.codex.landmarks.length})</h3>
          <ul className={s.chips}>{j.codex.landmarks.map(l => <li key={l.id} data-found={l.found ? '1' : ''}>{l.found || !l.secret ? cleanDisplayCopy(l.name) : '???'}</li>)}</ul>
          <h3>Keepsakes ({j.codex.relics.filter(r => r.found).length}/{j.codex.relics.length})</h3>
          <ul className={s.chips}>{j.codex.relics.map(r => <li key={r.id} data-found={r.found ? '1' : ''}>{r.found ? cleanDisplayCopy(r.name) : `Somewhere in ${cleanDisplayCopy(r.zone)}`}</li>)}</ul>
          <h3>Lore</h3>
          <ul className={s.chips}>{j.codex.lore.map(l => <li key={l.id} data-found={l.read ? '1' : ''}>{l.read ? cleanDisplayCopy(l.title) : 'Unread'}</li>)}</ul>
          <h3>Photo album ({j.codex.photos.length})</h3>
          <ul>{j.codex.photos.map(p => <li key={p.id}>{cleanDisplayCopy(p.title)}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function People({ game }: { game: NonNullable<EchoLifeGameHost['game']> }) {
  const list = game.peopleList();
  return (
    <ul className={s.people} data-testid="echo-life-people">
      {list.map(p => (
        <li key={p.id}>
          <header>
            <div className={s.peopleTitleRow}>
              <b>{cleanDisplayCopy(p.name)}</b>
              {p.mood && <span className={s.personMood}>{p.mood.charAt(0).toUpperCase() + p.mood.slice(1)}</span>}
            </div>
            <em>{cleanDisplayCopy(p.role)}</em>
          </header>
          <p className={s.note}>{p.walking ? 'Walking · ' : ''}{cleanDisplayCopy(p.zone)} — {cleanDisplayCopy(p.note)}</p>
          {p.rel && <><small>{cleanDisplayCopy(p.rel.tier)}</small><Bars rel={p.rel} /></>}
          {p.latestMemory
            ? <p className={s.memory}>{cleanDisplayCopy(p.latestMemory)}</p>
            : <p className={s.note}>You have not met yet.</p>}
          {p.perk && (
            <div className={s.perkChip} data-unlocked={p.perk.unlocked ? '1' : ''}>
              <Award size={12} aria-hidden="true" />
              <span>{cleanDisplayCopy(p.perk.title)}: {p.perk.unlocked ? 'Active' : 'Unlock at Close Friend'}</span>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function Bag({ game, host, bump }: { game: NonNullable<EchoLifeGameHost['game']>; host: EchoLifeGameHost; bump: () => void }) {
  const b = game.bag();
  const needs = game.needsSummary();
  const comfort = needs.comfort ?? game.computeHomeComfort();
  const moodlets = needs.moodlets ?? game.activeMoodlets();
  const perks = game.residentPerks().filter(p => p.unlocked);
  const [msg, setMsg] = useState('');
  const sell = async (id: string) => {
    const saver = host.saverNow;
    if (!saver) return;
    const r = await saver.sell(id);
    if ('error' in r) { setMsg(`The server did not accept the sale (${r.error}).`); return; }
    game.applySale(id, r.wallet);
    setMsg(`Sold for ${r.refund} CC.`);
    bump();
  };
  const list = (o: Record<string, number>) => Object.entries(o).filter(([, n]) => n > 0).map(([k, n]) => <li key={k}>{cleanDisplayCopy(k.replace(/_/g, ' '))} ×{n}</li>);
  return (
    <div className={s.bag} data-testid="echo-life-bag">
      <p className={s.big}>{b.credits.toLocaleString('en-US')} Campus Credits · Level {b.level}</p>
      {msg && <p className={s.reply}>{cleanDisplayCopy(msg)}</p>}

      <div className={s.comfortCard} data-testid="echo-life-home-comfort">
        <div className={s.comfortHead}>
          <div>
            <b>Home Comfort · {comfort.tier}</b>
            <p className={s.note}>
              +{Math.round((comfort.restMultiplier - 1) * 100)}% rest recovery · +{Math.round(comfort.focusBonus * 100)}% home study focus
            </p>
          </div>
          <span className={s.comfortScore}>{comfort.score}/100</span>
        </div>
        <div className={s.comfortGrid}>
          <span>Base <b>+{comfort.breakdown.base}</b></span>
          <span>Furnishings <b>+{comfort.breakdown.furnishings}</b></span>
          <span>Room Styles <b>+{comfort.breakdown.styles}</b></span>
          <span>Residence <b>+{comfort.breakdown.property}</b></span>
          <span>Room Care <b>+{comfort.breakdown.cleanliness}</b></span>
        </div>
      </div>

      {moodlets.length > 0 && (
        <>
          <h3>Active moodlets</h3>
          <ul className={s.chips}>
            {moodlets.map(m => (
              <li key={m.id} data-found="1" title={m.effect}>
                {m.label} ({Math.ceil(m.minutesRemaining / 60)}h)
              </li>
            ))}
          </ul>
        </>
      )}

      {perks.length > 0 && (
        <>
          <h3>Resident perks</h3>
          <ul className={s.chips}>
            {perks.map(p => (
              <li key={p.npcId} data-found="1" title={p.effect}>
                {p.npcName}: {p.title}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Lifestyle vitals <span className={s.vitalsState}>{needs.state}</span></h3>
      <div className={s.bars} data-testid="echo-life-bag-vitals">
        {([
          ['energy', needs.energy],
          ['hunger', needs.hunger],
          ['hygiene', needs.hygiene],
          ['mood', needs.mood],
          ['focus', needs.focus],
          ['fitness', needs.fitness],
        ] as const).map(([label, val]) => (
          <label key={label}>
            <span>{label}</span>
            <i style={{ width: `${Math.max(2, Math.min(100, val))}%` }} data-k={val < 25 ? 'rivalry' : label} />
            <em>{val}%</em>
          </label>
        ))}
      </div>

      <h3>District standing</h3>
      <div className={s.repGrid} data-testid="echo-life-district-rep">
        {DISTRICT_LABELS.map(d => {
          const info = game.people.getDistrictReputation(d.id);
          return (
            <div key={d.id} className={s.repCard}>
              <div className={s.repCardHead}>
                <b>{d.label}</b>
                <span>{info.score}</span>
              </div>
              <small>{info.tier}{info.discountPct > 0 ? ` · ${info.discountPct}% regular perk` : ''}</small>
            </div>
          );
        })}
      </div>

      <h3>Skills</h3>
      <div className={s.bars}>
        {b.skills.map(k => (
          <label key={k.id}><span>{cleanDisplayCopy(k.name)}</span><i style={{ width: `${Math.min(100, k.level * 10)}%` }} /><em>Lv {k.level}</em></label>
        ))}
      </div>
      <h3>Bag</h3><ul className={s.chips}>{list(b.bag)}</ul>
      <h3>Pantry</h3><ul className={s.chips}>{list(b.pantry)}</ul>
      <h3>Materials</h3><ul className={s.chips}>{list(b.materials)}</ul>
      <h3>Owned items</h3>
      <ul>
        {b.owned.map(o => (
          <li key={o.id}>
            {cleanDisplayCopy(o.variant.replace(/_/g, ' '))} <em>{cleanDisplayCopy(o.category.replace(/_/g, ' '))}{o.zone ? ` · ${game.zoneName(o.zone)}` : ''}</em>
            {o.id.startsWith('ec_') && <button type="button" className={s.linkBtn} onClick={() => void sell(o.id)}>Sell</button>}
          </li>
        ))}
      </ul>
      {b.achievements.length > 0 && <><h3>Achievements</h3><ul className={s.chips}>{b.achievements.map(a => <li key={a}>{cleanDisplayCopy(a)}</li>)}</ul></>}
    </div>
  );
}

function Shops({
  game,
  host,
  hud,
  initialShop,
  onShopConsumed,
  bump,
}: {
  game: NonNullable<EchoLifeGameHost['game']>;
  host: EchoLifeGameHost;
  hud: GameHud;
  initialShop: string | null;
  onShopConsumed: () => void;
  bump: () => void;
}) {
  const stores = Object.values(CATALOG.shops);
  const [store, setStore] = useState(() => (initialShop && CATALOG.shops[initialShop] ? initialShop : stores[0]?.id));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!initialShop) return;
    if (CATALOG.shops[initialShop]) setStore(initialShop);
    onShopConsumed();
  }, [initialShop, onShopConsumed]);

  const shop = CATALOG.shops[store];
  const counter = game.storeAccess(store);
  const storeZone = game.hotspots.find(h => h.action === 'shop_' + store)?.zone ?? (store === 'market' ? 'market' : null);
  const openStatus = storeZone && V3_ZONES[storeZone] ? isZoneOpen(V3_ZONES[storeZone], game.s.clock) : { open: true, note: 'Open' };
  const daily = dailySnapshotFor(game, hud);
  const discountRate = getStoreDiscountRate(game.s);
  const saleLive = (store === 'market' && daily.marketSaleLive) || discountRate > 0;
  const salePct = store === 'market' && daily.marketSaleLive ? Math.max(20, Math.round(discountRate * 100)) : Math.round(discountRate * 100);

  const buy = async (sku: string) => {
    const saver = host.saverNow;
    if (!saver || busy || !game.storeAccess(store).canBuy) return;
    setBusy(true);
    const r = await saver.purchase(store, sku);
    setBusy(false);
    if ('error' in r) {
      setMsg(
        r.error === 'INSUFFICIENT_CREDITS' ? 'Not enough Campus Credits.' :
        r.error === 'REQUIREMENTS_NOT_MET' ? 'Your level or skills are not high enough yet.' :
        `The server did not accept the purchase (${r.error}).`,
      );
      return;
    }
    const res = game.applyPurchase(store, sku, r.instanceId, r.wallet);
    setMsg(res.ok ? `${res.msg}` : `Bought for ${r.price} CC.`);
    bump();
  };

  return (
    <div className={s.shops} data-testid="echo-life-shops">
      <nav className={s.tabs}>
        {stores.map(st => (
          <button key={st.id} type="button" aria-pressed={store === st.id} onClick={() => setStore(st.id)}>{cleanDisplayCopy(st.name)}</button>
        ))}
      </nav>
      <div className={s.badgeRow}>
        <span className={openStatus.open ? s.openBadge : s.closedBadge}>
          {openStatus.open ? 'OPEN' : 'AFTER HOURS'}
        </span>
        {saleLive && <span className={s.saleBadge}>{salePct}% SALE</span>}
      </div>
      {shop && <p className={s.note}>{cleanDisplayCopy(shop.description)} · {cleanDisplayCopy(shop.vendorName)}<br />{cleanDisplayCopy(counter.note)}</p>}
      {msg && <p className={s.reply} data-testid="echo-life-shop-msg">{cleanDisplayCopy(msg)}</p>}
      <ul className={s.items}>
        {shop?.items.map(i => (
          <li key={i.sku}>
            <b>{cleanDisplayCopy(i.name)}</b>
            <em>{i.itemType.replace(/_/g, ' ')}{i.reqLevel && i.reqLevel > 1 ? ` · Lv ${i.reqLevel}` : ''}</em>
            <button type="button" disabled={busy || !counter.canBuy} data-sku={i.sku} onClick={() => void buy(i.sku)}>
              {Math.max(1, Math.round(i.price * (1 - discountRate)))} CC
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Settings({
  game,
  host,
  bump,
  qualityTier,
  onQualityTier,
  getPerfTelemetry,
  debugPerf,
  onToggleDebugPerf,
  onEnterPhotoMode,
  onRequestResetRoom,
  audio,
}: {
  game: NonNullable<EchoLifeGameHost['game']>;
  host: EchoLifeGameHost;
  bump: () => void;
  qualityTier: QualityTier;
  onQualityTier?: (tier: QualityTier) => void;
  getPerfTelemetry?: () => PerfTelemetry | null;
  debugPerf: boolean;
  onToggleDebugPerf: () => void;
  onEnterPhotoMode: () => void;
  onRequestResetRoom?: () => void;
  audio: EchoLifeWorldAudio;
}) {
  const t = game.s.worldV3.tutorial;
  const env = host.envControl;
  const mixer = useSyncExternalStore(audio.subscribe, audio.getMixer, () => DEFAULT_WORLD_AUDIO_MIXER);
  const perf = getPerfTelemetry?.() ?? null;

  const setAudioPatch = (patch: Partial<WorldAudioMixer>, clickFeedback = false) => {
    audio.unlock();
    const next = audio.setMixer(patch);
    broadcastAudioMixer(next);
    if (clickFeedback && !next.muted) audio.triggerUiClick('tap');
  };

  return (
    <div className={s.settings} data-testid="echo-life-settings">
      <section className={s.settingsSection}>
        <h3>Graphics Quality</h3>
        <p className={s.note}>Choose your visual preset. Ultra is tuned for desktop discrete GPUs such as the RTX 5070 12 GB.</p>
        <div className={s.qualityGrid} role="group" aria-label="Graphics quality preset">
          {QUALITY_OPTIONS.map(opt => (
            <button
              key={opt.tier}
              type="button"
              className={s.qualityCard}
              data-testid={`echo-life-quality-${opt.tier}`}
              aria-pressed={qualityTier === opt.tier}
              onClick={() => {
                audio.unlock();
                audio.triggerUiClick('confirm');
                onQualityTier?.(opt.tier);
                bump();
              }}
            >
              <span className={s.qualityCardTitle}>
                <span>{opt.label}</span>
                {opt.tag && <span className={s.qualityTag}>{opt.tag}</span>}
              </span>
              <small>{opt.summary}</small>
            </button>
          ))}
        </div>
        <div className={s.qualityReadout}>
          <span>Active preset: <b>{QUALITY_OPTIONS.find(o => o.tier === qualityTier)?.label ?? qualityTier}</b></span>
          {perf && (
            <span>
              FPS: <b>{perf.fps > 0 ? Math.round(perf.fps) : 'Live'}</b> · Draw calls: <b>{perf.drawCalls}</b> · Triangles: <b>{perf.triangles >= 1000 ? `${(perf.triangles / 1000).toFixed(1)}k` : perf.triangles}</b>
            </span>
          )}
        </div>
        <div className={s.quickToggles}>
          <button
            type="button"
            className={s.envBtn}
            data-testid="echo-life-toggle-perf"
            aria-pressed={debugPerf}
            onClick={() => {
              audio.unlock();
              audio.triggerUiClick('tap');
              onToggleDebugPerf();
            }}
          >
            Performance Overlay (F3): {debugPerf ? 'On' : 'Off'}
          </button>
          <button
            type="button"
            className={s.envBtn}
            data-testid="echo-life-enter-photo"
            onClick={() => {
              audio.unlock();
              audio.triggerUiClick('open');
              onEnterPhotoMode();
            }}
          >
            Enter Photo Mode (P)
          </button>
          {onRequestResetRoom && (
            <button
              type="button"
              className={s.envBtn}
              data-testid="echo-life-settings-reset-room"
              onClick={() => {
                audio.unlock();
                audio.triggerUiClick('open');
                onRequestResetRoom();
              }}
            >
              Reset Room to Default
            </button>
          )}
        </div>
      </section>

      <section className={s.settingsSection} data-testid="echo-life-audio-mixer">
        <div className={s.audioHeader}>
          <h3>Spatial Audio Mixer</h3>
          <button
            type="button"
            className={s.envBtn}
            data-testid="echo-life-audio-mute"
            aria-pressed={mixer.muted}
            onClick={() => setAudioPatch({ muted: !mixer.muted }, true)}
          >
            {mixer.muted ? 'Unmute Audio' : 'Mute Audio'}
          </button>
        </div>
        <p className={s.note}>Synthesized Web Audio soundscape with surface footsteps, wind, river spatial audio, rain occlusion, and vehicle sound.</p>
        <div className={s.audioGrid}>
          {([
            ['master', 'Master Volume'],
            ['ambience', 'Environment and Ambience'],
            ['foley', 'Footsteps and Foley'],
            ['vehiclesUi', 'Vehicles and Interface'],
          ] as const).map(([key, label]) => {
            const pct = Math.round(mixer[key] * 100);
            return (
              <label key={key} className={s.audioRow}>
                <span>{label}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={pct}
                  disabled={mixer.muted}
                  className={s.audioSlider}
                  aria-label={label}
                  data-testid={`echo-life-audio-${key}`}
                  onChange={e => setAudioPatch({ [key]: Number(e.target.value) / 100 })}
                />
                <output>{mixer.muted ? 'Muted' : `${pct}%`}</output>
              </label>
            );
          })}
        </div>
      </section>

      <section className={s.settingsSection}>
        <h3>Living World Atmosphere</h3>
        <p className={s.note}>Preview Riverside across all four seasons, weather states, and times of day, or leave on Auto for natural progression.</p>
        <div className={s.envGrid}>
          <div className={s.envGroup}>
            <label>Season</label>
            <div className={s.envRow}>
              <button type="button" className={s.envBtn} aria-pressed={env.season === null} onClick={() => { host.setEnvironment({ season: null }); bump(); }}>Auto</button>
              {SEASON_NAMES.map((name, idx) => (
                <button key={name} type="button" className={s.envBtn} aria-pressed={env.season === idx} onClick={() => { host.setEnvironment({ season: idx }); bump(); }}>{name}</button>
              ))}
            </div>
          </div>
          <div className={s.envGroup}>
            <label>Weather</label>
            <div className={s.envRow}>
              {WEATHER_OPTIONS.map(w => (
                <button key={w.id} type="button" className={s.envBtn} aria-pressed={env.weather === w.id} onClick={() => { host.setEnvironment({ weather: w.id }); bump(); }}>{w.label}</button>
              ))}
            </div>
          </div>
          <div className={s.envGroup}>
            <label>Time of Day</label>
            <div className={s.envRow}>
              <button type="button" className={s.envBtn} onClick={() => { host.setTimeOfDay(6.25); bump(); }}>Sunrise (06:15)</button>
              <button type="button" className={s.envBtn} onClick={() => { host.setTimeOfDay(12.0); bump(); }}>Noon (12:00)</button>
              <button type="button" className={s.envBtn} onClick={() => { host.setTimeOfDay(18.0); bump(); }}>Sunset (18:00)</button>
              <button type="button" className={s.envBtn} onClick={() => { host.setTimeOfDay(22.5); bump(); }}>Night (22:30)</button>
            </div>
          </div>
          <div className={s.envGroup}>
            <label>Clock Speed</label>
            <div className={s.envRow}>
              {([0, 1, 2, 3] as const).map(sp => (
                <button key={sp} type="button" className={s.envBtn} aria-pressed={env.clockSpeed === sp} onClick={() => { host.setTimeScale(sp); bump(); }}>{sp === 0 ? 'Paused' : `${sp}x`}</button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <h3>Introduction</h3>
      <p className={s.note}>{t.completed ? 'Completed.' : t.skipped ? 'Skipped.' : `In progress: step ${t.stepIndex + 1} of 10.`}</p>
      <button type="button" className={s.primary} onClick={() => { game.replayTutorial(); bump(); }}>Replay the introduction</button>
      {!t.completed && !t.skipped && <button type="button" className={s.linkBtn} onClick={() => { game.skipTutorial(); bump(); }}>Skip it</button>}
      <h3>Controls</h3>
      <ul>
        <li><kbd>W A S D</kbd> walk · <kbd>Shift</kbd> sprint · <kbd>Space</kbd> jump</li>
        <li><kbd>E</kbd> talk, sit, open doors, ride vehicles, or interact · <kbd>I</kbd> action wheel</li>
        <li><kbd>Tab</kbd> Echo Phone · <kbd>B</kbd> Build Studio · <kbd>P</kbd> Photo Studio · <kbd>M</kbd> full map</li>
        <li><kbd>C</kbd> vehicle camera · <kbd>L</kbd> headlights · <kbd>H</kbd> dialogue log or vehicle horn · <kbd>F3</kbd> performance</li>
        <li><kbd>`</kbd> open or close this menu · <kbd>Esc</kbd> close a window</li>
      </ul>
      <p className={s.note}>Echo Life time runs only while you are in the world; nothing is lost while you are away. Campus Credits and skills are kept by the server and are separate from your English Coach study records.</p>
    </div>
  );
}
