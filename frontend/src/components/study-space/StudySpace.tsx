'use client';

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useMusic } from '@/components/music/MusicProvider';
import { WorldSaver } from '@/lib/echo-life/save';
import { echoLifeApi } from '@/lib/echo-life/api';
import { GameSaver, echoLifeGameApi } from '@/lib/echo-life/game/saver';
import type { Target as GameTarget } from '@/lib/echo-life/game/session';
import { EchoLifeHud, type ActiveStudio, type LifePanel } from './echoLife/EchoLifeHud';
import type { EchoPhoneAppId } from './echoLife/EchoPhone';
import { EchoLifeLoadingOverlay, markEchoLifeWarmed } from './echoLife/EchoLifeLoadingOverlay';
import { BOOT_STAGE_LABELS_VI, type EchoLifeBootStageId } from './echoLife/echoLifeBootStages';
import type { BootProgressSnapshot, EchoLifeBootOrchestrator } from './world/echoLife/preloadManifest';
import { createHudStore, normalizeQualityTier, readSavedQualityTier, writeSavedQualityTier, type PerfTelemetry } from './echoLife/hudStore';
import type { QualityTier } from './world/echoLife/renderConfig';
import type { RadialActionItem } from './world/echoLife/gameHost';
import { accountKey, currentPreference, DEFAULT_PREFERENCE, openWallpaperStudio, subscribePreference, subscribeHold, isBackgroundHeld } from '@/lib/wallpaper/storage';
import { NAMED_ROOM, studySpaceApi } from '@/lib/study-space/api';
import { getFocusEngine } from '@/lib/study-space/focus';
import { journeyGo } from '@/lib/journey/journey';
import FocusFloat from './FocusFloat';
import { ClearDialog, ResetRoomDialog, UndoClearBar } from './RoomSafety';
import { CATALOG_BY_ID, ROUTE_OF } from '@/lib/study-space/catalog';
import { buildDefaultRoomObjects, emptyLayout, readLayout, templateLayout, THEME_LABEL, uid } from '@/lib/study-space/layout';
import {
  normalizeSpaceObjectOrientation,
  quatFromSpaceObject,
  resetSpaceObjectUprightPatch,
} from '@/lib/study-space/orientation';
import { ops, useSpace } from '@/lib/study-space/store';
import type { ActionId, Activity, Layout, RoomTheme, SpaceObject, SpaceRecord, SpaceSummary } from '@/lib/study-space/types';
import { apiClient } from '@/services/api-client';
import { useAccount } from './data';
import { WidgetLayer } from './widgets';
import { Inspector, TopReveal, type Section, type ToolbarApi } from './Toolbar';
import { AmbientPanel, CharacterPanel, FocusPanel, NotebookPanel, PlannerPanel } from './panels';
import { ResearchPanel } from './ResearchPanel';
import ActionWheel from './ActionWheel';
import type { BuildCameraOptions, CreatorStudioOptions, PhotoStudioOptions, StudyWorld } from './world/engine';
import type { EmbodiedAction } from '@/lib/embodiment/actions';
import { loadKeymap } from '@/lib/study-space/keymap';
import s from './studySpace.module.css';
import { echoSrc } from '@/lib/brand/echoCharacters';
import AppearancePanel from './AppearancePanel';
import SharedStudy from './SharedStudy';
import type { SharedCityPresence, CityConnection } from './world/echoLife/sharedCity';
import { beginAppearanceScope, syncAppearanceScope } from '@/lib/appearance/scope';
import { currentSpatial, DEFAULT_SPATIAL, setSpatialDraft, spatialKey, subscribeSpatial } from '@/lib/spatial/preference';
import {
  resolveActiveBgConfig,
  setStudyStageOccluded,
  subscribeBgState,
  subscribeLiveWorkspacePreview,
} from '@/lib/background-studio/store';
import type { SpaceAppearance } from '@/lib/study-space/types';
import ExplorerControls from './ExplorerControls';
import StudyCompanion from './StudyCompanion';
import StoryCaption from './StoryCaption';
import type { Line } from '@/lib/study-space/stories';
import { DEFAULT_SETTINGS, freshLife, withoutLife } from '@/lib/study-space/life';
import { hasKit, kitObjects } from '@/lib/study-space/kit';
import { useMessenger } from '@/lib/messenger/store';
import { useEdgeReveal } from '@/lib/hud/edgeReveal';
import dynamic from 'next/dynamic';
import { loadLibrary, type LibraryBook } from '@/lib/study-space/library';
import { notesSession, openBookSession, type BookSession } from '@/lib/study-space/bookSession';
import { markWorldPassage } from '@/lib/morph/scene';
import type { CameraView, ExplorationState } from './world/exploration';
import type { InteractionState } from './world/manipulation';
import { readCreatorProfile, readIdentity, writeCreatorProfile, writeIdentity } from '@/lib/avatar/identity';
import { createDefaultCreatorProfile, profileToAvatarLook, type CharacterCreatorProfile } from '@/lib/avatar/characterCreator';
import { normalizeLook, type AvatarIdentity } from '@/lib/avatar/look';
import { markArrival, takeArrival, worldDestination, type WorldDestination } from '@/lib/study-space/exploration';
import { useLanguage } from '@/context/LanguageContext';

/**
 * Không gian học tập. Layers, bottom to top:
 *  0  the appearance background of Giao diện (WallpaperStage, mounted by the application frame; this page never paints
 *     its own background except a soft sky when Giao diện shows the normal look),
 *  1–2 the learner's room, objects, character and companion on a transparent canvas (unmounted when there is none),
 *  3  the learner's tools (widgets),
 *  4  temporary system controls: the toolbar that slides down from the top edge (Esc, a swipe down on touch), the
 *     inspector in edit mode, and full panels.
 * The current layout auto-saves; the learner's own default is a separate record written only by "Lưu làm mặc định".
 */

interface SpaceRef { id: string; revision: number; hasDefault: boolean; defaultLayout: unknown | null; name: string }

/** What a book in the room holds: the learner's notes in a notebook; a book of their library; or the reading it was given, the one last read, the library's first. */
async function bookSessionOf(obj: SpaceObject, vi: boolean, account: string): Promise<BookSession | null> {
  if (obj.kind === 'notebook') {
    const notes = await studySpaceApi.notes().catch(() => []);
    const title = vi ? 'Sổ ghi chú' : 'Notebook';
    if (!notes.length) return notesSession(title, vi ? 'Sổ còn trống. Viết ghi chú đầu tiên trong mục Ghi chú.' : 'Nothing written yet. Write your first note under Notes.');
    return notesSession(title, notes.map(n => [n.title, n.body].filter(Boolean).join(String.fromCharCode(10))).join(String.fromCharCode(10, 10)));
  }
  const b = obj.state?.book;
  if (b) return openBookSession(b.source === 'mybooks' ? { source: 'mybooks', id: b.id } : { source: b.source, id: b.id }, account);
  const reading = (id: number) => openBookSession({ source: 'reading', id }, account).catch(() => null);
  if (obj.state?.material) { const kept = await reading(obj.state.material); if (kept) return kept; }
  const last = await apiClient.get<{ materialId?: number }[]>('/reading/progress').then(r => r.data?.[0]?.materialId).catch(() => undefined);
  if (last) { const was = await reading(last); if (was) return was; }
  const first = await apiClient.get<{ content?: { id: number }[]; items?: { id: number }[] }>('/reading/catalog', { params: { library: 'SYSTEM', page: 0, size: 18 } }).then(r => (r.data.content ?? r.data.items ?? [])[0]?.id).catch(() => undefined);
  return first ? reading(first) : null;
}

// The computer's desktop loads with the first time a screen is used: the room itself pays nothing for it.
const EchoDesk = dynamic(() => import('./desk/EchoDesk'), { ssr: false });
const RoomWindow = dynamic(() => import('./desk/RoomWindow'), { ssr: false });
const BookHud = dynamic(() => import('./desk/BookHud'), { ssr: false });
const LibraryPanel = dynamic(() => import('./desk/LibraryPanel'), { ssr: false });
// The desk dictionary opens the dictionary itself (Echo Lexicon), the same dialog as everywhere else; it loads with the first use.
const GlobalDictionarySearch = dynamic(() => import('@/components/features/dictionary/GlobalDictionarySearch').then(m => m.GlobalDictionarySearch), { ssr: false });

const clearMark = (account: string, spaceId: string) => `ec_study_clear:v1:u${account}:${spaceId}`;

interface StudyBootUiState {
  readonly pct: number;
  readonly stageId: EchoLifeBootStageId;
  readonly stage: string;
  readonly detailVi: string | null;
  readonly slowNoticeVi: string | null;
  readonly slowState: boolean;
  readonly transitionMode: boolean;
  readonly errorVi: string | null;
  readonly done: boolean;
  readonly complete: boolean;
}

type StudyWorldWithPreEntry = StudyWorld & {
  runPreEntryWarmup?: (opts?: {
    onStage?: (stageId: EchoLifeBootStageId, pct: number) => void;
    signal?: AbortSignal;
    ensureWorld?: boolean;
  }) => Promise<{ baselinePrograms: number; warmupMs: number }>;
};

const INITIAL_BOOT_STATE: StudyBootUiState = {
  pct: 8,
  stageId: 'preparing',
  stage: BOOT_STAGE_LABELS_VI.preparing,
  detailVi: null,
  slowNoticeVi: null,
  slowState: false,
  transitionMode: false,
  errorVi: null,
  done: false,
  complete: false,
};

function hasWorld(l: Layout) {
  return l.room.visible || l.character.visible || l.pet.visible || l.objects.some((o) => !o.hidden);
}

function sanitizePhotoFilterCss(raw?: string): string {
  if (!raw || raw === 'none') return 'none';
  const trimmed = raw.trim();
  if (!trimmed || /backdrop-filter|url\s*\(/i.test(trimmed)) return 'none';
  return /^[a-z0-9().,%\s-]+$/i.test(trimmed) ? trimmed : 'none';
}

export default function StudySpace({lifeEnabled}:{lifeEnabled:boolean}) {
  const { locale } = useLanguage();
  // Echo Life is a 100% English immersive environment regardless of global site locale.
  const vi = !lifeEnabled && locale === 'vi';
  const account = useAccount();
  useLayoutEffect(() => {
    useSpace.setState({ layout: emptyLayout(), past: [], future: [], selection: [], clipboard: null, mode: 'use', version: 0, mergeKey: null });
    return () => { useSpace.setState({ layout: emptyLayout(), past: [], future: [], selection: [], clipboard: null }); };
  }, [account]);
  const router = useRouter();
  const layout = useSpace((st) => st.layout);
  const mode = useSpace((st) => st.mode);
  const selection = useSpace((st) => st.selection);
  const version = useSpace((st) => st.version);
  const [space, setSpace] = useState<SpaceRef | null>(null);
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [phase, setPhase] = useState<'loading' | 'choose' | 'ready' | 'error'>('loading');
  const [barOpen, setBarOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [section, setSection] = useState<Section | null>(null);
  const [panel, setPanel] = useState<string | null>(null);
  const [focusFloat, setFocusFloat] = useState(false);
  const [clearAsk, setClearAsk] = useState(false);
  const [resetRoomAsk, setResetRoomAsk] = useState(false);
  const [clearUndo, setClearUndo] = useState<{ snapshotId: string; spaceId: string } | null>(null);
  const [undoBar, setUndoBar] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [worldFailed, setWorldFailed] = useState(false);
  const [qualityTier, setQualityTierState] = useState<QualityTier>(() => readSavedQualityTier(useSpace.getState().layout.quality));
  const qualityTierRef = useRef<QualityTier>(qualityTier);
  const [activeStudio, setActiveStudioState] = useState<ActiveStudio>(null);
  const [phoneInitialApp, setPhoneInitialApp] = useState<EchoPhoneAppId>('home');
  const [creatorProfile, setCreatorProfile] = useState<CharacterCreatorProfile>(() =>
    createDefaultCreatorProfile(useSpace.getState().layout.character.model),
  );
  const creatorProfileRef = useRef<CharacterCreatorProfile>(creatorProfile);
  creatorProfileRef.current = creatorProfile;
  const photoMode = activeStudio === 'photo';
  const [photoFilterCss, setPhotoFilterCss] = useState<string>('none');
  const photoFilterCssRef = useRef<string>('none');
  photoFilterCssRef.current = photoFilterCss;
  const prevPlayerSeatRef = useRef<string | null>(null);
  const handleActiveStudioChange = useCallback((next: ActiveStudio, phoneApp?: EchoPhoneAppId) => {
    setActiveStudioState(next);
    if (next !== 'photo') setPhotoFilterCss('none');
    if (phoneApp) setPhoneInitialApp(phoneApp);
    if (next === null) canvasRef.current?.focus({ preventScroll: true });
  }, []);
  const setPhotoMode = useCallback((on: boolean) => {
    setActiveStudioState(prev => (on ? 'photo' : prev === 'photo' ? null : prev));
    if (!on) {
      setPhotoFilterCss('none');
      canvasRef.current?.focus({ preventScroll: true });
    }
  }, []);
  const [bootState, setBootState] = useState<StudyBootUiState>(INITIAL_BOOT_STATE);
  const bootOrchestratorRef = useRef<EchoLifeBootOrchestrator | null>(null);
  const outdoorWarmedRef = useRef(false);
  const [bootRetryTick, setBootRetryTick] = useState(0);
  const [exploration, setExploration] = useState<ExplorationState>({ view: 'overview', locked: false, target: null });
  const [interaction, setInteraction] = useState<InteractionState | null>(null);
  const [helpTick, setHelpTick] = useState(0);
  const [bottomDockOpen, setBottomDockOpen] = useState(false);
  const [caption, setCaption] = useState<Line | null>(null);
  const captionRef = useRef(false);
  const lastTutorialHint=useRef('');
  const tutorialCaption=useCallback((line:Line)=>{
    const key=account+'/'+line.id;
    if(captionRef.current || lastTutorialHint.current===key)return;
    lastTutorialHint.current=key;
    captionRef.current=true;
    setCaption(line);
  },[account]);
  const clearTutorialCaption = useCallback(() => {
    captionRef.current = false;
    setCaption(null);
  }, []);
  const dictionaryOpen = useRef<(() => void) | null>(null), dictionaryWanted = useRef(false);
  const [dictionaryMounted, setDictionaryMounted] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [wheelOpen, setWheelOpen] = useState(false), [wheelMotions,setWheelMotions] = useState<string[]>([]);
  const [lifeRadialActions, setLifeRadialActions] = useState<RadialActionItem[]>([]);
  const wheelCommand = useRef<(() => void) | null>(null);
  const openWheel = (open:boolean) => {
    if (open && (otherInputBlocked || phase !== 'ready' || !worldRef.current?.bodyReady || !worldRef.current.exploration.active || document.hidden)) return;
    wheelCommand.current=null;
    if(open){
      setQuickOpen(false);
      setWheelMotions(worldRef.current?.availableMotions()??[]);
      if (lifeEnabled) setLifeRadialActions(worldRef.current?.game.getContextualRadialActions() ?? []);
    }
    setWheelOpen(open);
  };
  /** A computer in the room is being used: its screen fills the view and the desktop lies exactly over it. */
  const [device, setDevice] = useState<{ id: string; rect: { left: number; top: number; width: number; height: number } } | null>(null);
  const deviceRef = useRef(device); deviceRef.current = device;
  const [chat, setChat] = useState<string | null>(null);
  const [deskRequest, setDeskRequest] = useState<{ conversation: string | null } | { arena: string } | null>(null);
  const [library, setLibrary] = useState<LibraryBook[] | null>(null);
  const libraryShelf = useRef<string | null>(null);
  const joinArenaRef = useRef<(code: string) => void>(() => {});
  const travelRef = useRef<(destination: WorldDestination, join?: string) => void>(() => {});
  const shortcutRef = useRef<(action: string) => void>(() => undefined);
  const [travelling, setTravelling] = useState(false);
  const travelLock = useRef(false);
  const actionRef = useRef<(action: ActionId, id?: string) => void>(() => undefined);
  const portalRef = useRef<(destination: WorldDestination) => void>(() => undefined);
  const [drag, setDrag] = useState<{ kind: string; x: number; y: number; src: string | null } | null>(null);
  const persistRef = useRef<(reason?: 'NONE') => Promise<boolean>>(() => Promise.resolve(false));
  const worldRef = useRef<StudyWorld | null>(null);
  const [sharedCityRoom, setSharedCityRoom] = useState<{room: string; learner: number; clockOffset:number} | null>(null);
  const [cityConnection, setCityConnection] = useState<CityConnection>('connecting');
  const sharedCityRef = useRef<SharedCityPresence | null>(null);
  const inputBlockedRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const keep = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedVersion = useRef(0);
  const activeSpace = useRef<SpaceRef | null>(null);
  const saveQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  const loadEpoch = useRef(0);
  const accountRef = useRef(account);
  accountRef.current = account;
  // Echo Life: one world save per signed-in account (server V129). The engine reads and writes it; the room's layout never holds it.
  // The effect owns it (a development double-mount disposes the first one and makes another; nothing reuses a disposed save).
  const [lifeSave, setLifeSaveState] = useState<WorldSaver | null>(null);
  const lifeSaveRef = useRef(lifeSave);
  lifeSaveRef.current = lifeSave;
  useEffect(() => {
    if (!account || !lifeEnabled) { setLifeSaveState(null); return; }
    const saver = new WorldSaver(echoLifeApi, account);
    setLifeSaveState(saver);
    void saver.load();
    const flush = () => { void saver.flush(); };
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); void saver.flush().finally(() => saver.dispose()); };
  }, [account,lifeEnabled]);
  // Echo Life game (Phase 3 + 4): one game save per account (server V130), separate from the world save and the layout.
  const [gameSave, setGameSaveState] = useState<GameSaver | null>(null);
  const gameSaveRef = useRef(gameSave);
  gameSaveRef.current = gameSave;
  useEffect(() => {
    if (!account || !lifeEnabled) { setGameSaveState(null); return; }
    const saver = new GameSaver(echoLifeGameApi, String(account));
    setGameSaveState(saver);
    void saver.load();
    const flush = () => { void saver.flush(); };
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); void saver.flush().finally(() => saver.dispose()); };
  }, [account,lifeEnabled]);
  const hudStore = useMemo(() => createHudStore(), []);
  // Only whether a minigame holds keyboard input matters to this page; EchoLifeHud subscribes to the full snapshot itself.
  const gameChallenge = useSyncExternalStore(hudStore.subscribe, () => !!hudStore.get()?.challenge, () => false);
  const awayFromStudy=useSyncExternalStore(hudStore.subscribe,()=>{
    const zone=hudStore.get()?.host.game?.s.player.zone;
    return !!zone && zone!=='study';
  },()=>false);
  const seatedInEchoLife = useSyncExternalStore(
    hudStore.subscribe,
    () => Boolean(hudStore.get()?.host.game?.people.playerSeat),
    () => false,
  );
  const [gameTarget, setGameTarget] = useState<GameTarget | null>(null);
  const [lifePanel, setLifePanel] = useState<LifePanel | null>(null);
  activeSpace.current = space;
  const thumbs = useRef(new Map<string, string>());
  const music = useMusic();
  const appearanceStudioOpen=useSyncExternalStore(subscribeHold,isBackgroundHeld,()=>false);
  useEffect(()=>{worldRef.current?.setHeld(appearanceStudioOpen);},[appearanceStudioOpen]);

  // The offer to undo leaves by itself: the clear view stays clear. It stays in “Bố cục” for as long as it can be used.
  useEffect(() => {
    if (!undoBar) return;
    const id = window.setTimeout(() => setUndoBar(false), 30_000);
    return () => clearTimeout(id);
  }, [undoBar]);

  const say = useCallback((t: string) => { setToast(t); window.setTimeout(() => setToast((x) => (x === t ? null : x)), 3200); }, []);
  useEffect(() => {
    qualityTierRef.current = qualityTier;
  }, [qualityTier]);

  const selectQualityTier = useCallback((tier: QualityTier) => {
    setQualityTierState(tier);
    qualityTierRef.current = tier;
    writeSavedQualityTier(tier);
    const layoutQuality = tier === 'ultra' ? 'high' : tier;
    useSpace.getState().apply(l => (l.quality === layoutQuality ? l : { ...l, quality: layoutQuality }), 'quality');
    const w = worldRef.current as (StudyWorld & { setQualityTier?: (t: QualityTier) => void }) | null;
    w?.setQualityTier?.(tier);
    try { window.dispatchEvent(new CustomEvent('echo-life:quality-tier', { detail: { tier } })); } catch { /* noop */ }
  }, []);

  const notifyQualityDowngrade = useCallback((nextTier: QualityTier) => {
    const order: Record<QualityTier, number> = { low: 0, balanced: 1, high: 2, ultra: 3 };
    if (order[nextTier] >= order[qualityTierRef.current]) return;
    setQualityTierState(nextTier);
    qualityTierRef.current = nextTier;
    const label = nextTier[0].toUpperCase() + nextTier.slice(1);
    say(vi
      ? `Chất lượng đồ họa đã tự động giảm xuống mức ${label} để giữ khung hình mượt mà. Bạn có thể chỉnh lại trong Cài đặt.`
      : `Graphics quality stepped down to ${label} to keep frame rate smooth. You can adjust this in Settings.`);
  }, [say, vi]);

  useEffect(() => {
    const onDowngrade = (e: Event) => {
      const detail = (e as CustomEvent<{ tier?: QualityTier }>).detail;
      if (detail?.tier) notifyQualityDowngrade(normalizeQualityTier(detail.tier, 'balanced'));
    };
    window.addEventListener('echo-life:quality-downgrade', onDowngrade);
    return () => window.removeEventListener('echo-life:quality-downgrade', onDowngrade);
  }, [notifyQualityDowngrade]);

  const getPerfTelemetry = useCallback((): PerfTelemetry | null => {
    const w = worldRef.current as (StudyWorld & { getPerfStats?: () => Partial<PerfTelemetry> }) | null;
    if (!w) return null;
    const ext = w.getPerfStats?.();
    const info = w.renderer.info;
    return {
      fps: ext?.fps ?? 0,
      frameMs: ext?.frameMs ?? 0,
      drawCalls: ext?.drawCalls ?? info.render.calls,
      triangles: ext?.triangles ?? info.render.triangles,
      textures: ext?.textures ?? info.memory.textures,
      geometries: ext?.geometries ?? info.memory.geometries,
      qualityTier: ext?.qualityTier ?? qualityTierRef.current,
      gpuLabel: ext?.gpuLabel,
    };
  }, []);

  const capturePhotoDataUrl = useCallback((filterCss?: string): string | null => {
    const w = worldRef.current;
    if (w && typeof w.capturePhotoDataUrl === 'function') {
      return w.capturePhotoDataUrl(filterCss);
    }
    const canvas = canvasRef.current;
    if (!canvas) return null;
    try {
      const activeCam = w?.exploration.active ? w.exploration.camera : w?.camera;
      if (w && activeCam) w.renderer.render(w.scene, activeCam);
      return canvas.toDataURL('image/png');
    } catch {
      return null;
    }
  }, []);

  const capturePhoto = useCallback(() => {
    const activeFilter = photoFilterCssRef.current !== 'none' ? photoFilterCssRef.current : undefined;
    const url = capturePhotoDataUrl(activeFilter);
    if (!url) {
      say('Could not capture photo from the 3D canvas.');
      return;
    }
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const link = document.createElement('a');
      link.href = url;
      link.download = `echo-life-riverside-${stamp}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      say('Photo saved to your downloads.');
    } catch {
      say('Could not capture photo from the 3D canvas.');
    }
  }, [capturePhotoDataUrl, say]);

  const handlePreviewAvatar = useCallback((profile: CharacterCreatorProfile) => {
    void worldRef.current?.applyCreatorProfile(profile);
  }, []);

  const handleSaveAvatar = useCallback((profile: CharacterCreatorProfile) => {
    const saved = writeCreatorProfile(accountRef.current, profile);
    creatorProfileRef.current = saved;
    setCreatorProfile(saved);
    void lifeSaveRef.current?.saveAvatarProfile(saved, 0);
    void worldRef.current?.applyCreatorProfile(saved);
    worldRef.current?.game.game?.setProfileIdentity(saved.identity);
    useSpace.getState().apply(
      l => ({
        ...l,
        character: {
          ...l.character,
          model: saved.hero,
          look: profileToAvatarLook(saved),
          lookAt: Date.now(),
        },
      }),
      'char-look',
    );
    say('Character saved.');
  }, [say]);

  const handleCreatorModeChange = useCallback((active: boolean, opts?: CreatorStudioOptions) => {
    worldRef.current?.setCreatorStudioMode(active, opts);
  }, []);

  const handleBuildCameraChange = useCallback((active: boolean, opts?: BuildCameraOptions) => {
    worldRef.current?.setBuildCameraMode(active, opts);
  }, []);

  const handlePhotoStudioModeChange = useCallback((active: boolean, opts?: PhotoStudioOptions) => {
    if (!active) {
      setPhotoFilterCss('none');
    } else if (opts?.filterCss !== undefined) {
      setPhotoFilterCss(sanitizePhotoFilterCss(opts.filterCss));
    }
    worldRef.current?.setPhotoStudioMode(active, opts);
  }, []);

  const getPeerQuickChats = useCallback(() => {
    return worldRef.current?.getPeerQuickChats() ?? [];
  }, []);

  const handleLifeRadialAction = useCallback((item: RadialActionItem) => {
    const w = worldRef.current;
    if (!w) return;
    if (item.target && item.actionKey) {
      void w.game.act(item.target, item.actionKey);
      return;
    }
    if (item.recipeId) {
      void w.game.cookRecipe(item.recipeId);
      return;
    }
    if (item.bistroSku) {
      void w.game.orderBistroItem(item.bistroSku);
      return;
    }
    if (item.stopId) {
      void w.game.rideBusShuttle(item.stopId);
      return;
    }
    if (item.emoteId) {
      w.game.sendMultiplayerEmote(item.emoteId);
      if (['wave', 'clap', 'cheer', 'dance'].includes(item.emoteId)) {
        void w.performAction(item.emoteId as EmbodiedAction);
      }
      return;
    }
    if (item.panel === 'phone') handleActiveStudioChange('phone', 'home');
    else if (item.panel === 'career') handleActiveStudioChange('phone', 'careers');
    else if (item.panel === 'photo') handleActiveStudioChange('photo');
    else if (item.panel === 'build') { setLifePanel('workshop'); handleActiveStudioChange('build'); }
    else if (item.panel === 'character') handleActiveStudioChange('creator');
    else if (item.panel === 'city') handleActiveStudioChange('city');
  }, [handleActiveStudioChange]);

  const handleQuickChat = useCallback((id: string) => {
    worldRef.current?.game.sendMultiplayerQuickChat(id);
  }, []);

  useEffect(() => {
    const blocked = () => say(vi ? 'Lối đi đang bị chặn. Hãy chừa khoảng trống quanh nội thất.' : 'The path is blocked. Leave a little space around furniture.');
    window.addEventListener('study:navigation-blocked', blocked);
    return () => window.removeEventListener('study:navigation-blocked', blocked);
  }, [say, vi]);

  // ── Background (layer 0) ────────────────────────────────────────────────────────────────────────────────
  const wpKey = accountKey(account);
  const wallpaper = useSyncExternalStore((cb) => subscribePreference(wpKey, cb), () => currentPreference(wpKey), () => DEFAULT_PREFERENCE);
  const spKey = spatialKey(account);
  const spatial = useSyncExternalStore((cb) => subscribeSpatial(spKey, cb), () => currentSpatial(spKey), () => DEFAULT_SPATIAL);
  const subscribeBg = useCallback(
    (cb: () => void) => {
      const offBg = subscribeBgState(account, cb);
      const offPreview = subscribeLiveWorkspacePreview(cb);
      return () => {
        offBg();
        offPreview();
      };
    },
    [account],
  );
  const bgThemeOn = useSyncExternalStore(subscribeBg, () => resolveActiveBgConfig(account) !== null, () => false);
  const ownBackground = wallpaper.source !== 'none' || spatial.enabled || bgThemeOn;
  const scopeId = `${account}:${space?.id ?? ''}`;
  const appearanceMode = layout.appearance?.mode;
  useLayoutEffect(() => {
    const a = useSpace.getState().layout.appearance;
    if (!account || !space || !a) return;
    const end = beginAppearanceScope(scopeId, { [wpKey]: a.wallpaper, [spKey]: a.spatial, theme: a.theme }, (values) => {
      useSpace.getState().apply(l => ({ ...l, appearance: { mode: 'override', wallpaper: values[wpKey], spatial: values[spKey], theme: values.theme } as SpaceAppearance }), 'appearance');
    });
    return () => { setSpatialDraft(spKey, null); end(); };
  }, [account, scopeId, appearanceMode, wpKey, spKey]); // selection changes update the existing scope below
  useLayoutEffect(() => {
    const a = layout.appearance;
    if (a) syncAppearanceScope(scopeId, { [wpKey]: a.wallpaper, [spKey]: a.spatial, theme: a.theme });
  }, [scopeId, layout.appearance, wpKey, spKey]);

  // ── Load ────────────────────────────────────────────────────────────────────────────────────────────────
  const adopt = useCallback((rec: SpaceRecord) => {
    loadEpoch.current++;
    activeSpace.current = { id: rec.id, revision: rec.revision, hasDefault: rec.defaultLayout !== null && rec.defaultLayout !== undefined, defaultLayout: rec.defaultLayout, name: rec.name };
    setSpace({ id: rec.id, revision: rec.revision, hasDefault: rec.defaultLayout !== null && rec.defaultLayout !== undefined, defaultLayout: rec.defaultLayout, name: rec.name });
    useSpace.getState().load(readLayout(rec.layout));
    savedVersion.current = useSpace.getState().version;
    // A room cleared before this load is still one press away while the space stays empty.
    let pending: { snapshotId: string; spaceId: string } | null = null;
    try {
      const raw = JSON.parse(localStorage.getItem(clearMark(accountRef.current, rec.id)) || 'null');
      if (raw?.snapshotId && raw.spaceId === rec.id) pending = { snapshotId: String(raw.snapshotId), spaceId: rec.id };
    } catch { /* The version history still has it. */ }
    setClearUndo(pending);
    setUndoBar(!!pending && !hasWorld(useSpace.getState().layout) && !useSpace.getState().layout.widgets.some((w) => !w.hidden));
  }, []);

  const refreshList = useCallback(async () => {
    const list = await studySpaceApi.list();
    setSpaces(list.items);
    return list;
  }, []);

  useEffect(() => {
    if (!account) return;
    let alive = true;
    refreshList().then(async (list) => {
      if (!alive) return;
      const requested = new URLSearchParams(location.search).get('space');
      try { sessionStorage.removeItem(`ec_study_journey:u${account}`); } catch { /* Optional route receipt. */ }
      if (requested && !list.items.some(s => s.id === requested)) say(vi ? 'Phòng trước không còn khả dụng. Đã mở không gian hiện tại của bạn.' : 'The previous room is unavailable. Your current space is open.');
      const record = requested && list.items.some(s => s.id === requested) && requested !== list.active?.id
        ? await studySpaceApi.activate(requested) : list.active;
      if (!alive) return;
      if (record) { adopt(record); setPhase('ready'); }
      else setPhase('choose');
    }).catch(() => alive && setPhase('error'));
    return () => { alive = false; };
  }, [account, adopt, refreshList]);

  // ── Persistence ─────────────────────────────────────────────────────────────────────────────────────────
  const persist = useCallback((reason: 'NONE' | 'CLEAR' | 'RESTORE' | 'TEMPLATE' = 'NONE'): Promise<boolean> => {
    const id=activeSpace.current?.id,epoch=loadEpoch.current;
    if (!id) return Promise.resolve(false);
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    const v = useSpace.getState().version, snapshot = useSpace.getState().layout;
    const work = async () => {
    const current=activeSpace.current;
    if(!current||current.id!==id||epoch!==loadEpoch.current)return false;
    try {
      const saved = await studySpaceApi.saveLayout(id, snapshot, current.revision, reason);
      savedVersion.current = v;
      if(activeSpace.current?.id===saved.id)activeSpace.current={...activeSpace.current,revision:saved.revision};
      setSpace((cur) => (cur && cur.id === saved.id ? { ...cur, revision: saved.revision } : cur));
      return true;
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      if (status === 409) {
        const fresh = await studySpaceApi.get(id);
        adopt(fresh);
        say(vi ? 'Bố cục vừa được đổi ở một tab khác — đã mở bản mới nhất.' : 'Your layout changed in another tab — loaded the latest version.');
      } else say(vi ? 'Chưa lưu được bố cục. Sẽ thử lại khi bạn thay đổi tiếp.' : 'Could not save the layout yet. Will retry on your next change.');
      return false;
    }
    };
    saveQueue.current=saveQueue.current.catch(()=>false).then(work);
    return saveQueue.current;
  }, [adopt, say, vi]);

  persistRef.current = persist;
  useEffect(() => {
    if (!space || version === savedVersion.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void persist('NONE'), 1200);
    return () => { if(saveTimer.current)clearTimeout(saveTimer.current); };
  }, [version, space, persist]);

  useEffect(() => {
    const flush = () => { if (space && version !== savedVersion.current) void studySpaceApi.saveLayout(space.id, useSpace.getState().layout, null, 'NONE').catch(() => undefined); };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [space, version]);

  // ── World (layers 1–2) ──────────────────────────────────────────────────────────────────────────────────
  const world3d = phase === 'ready' && hasWorld(layout) && !worldFailed;
  const stageOccluded = Boolean(
    world3d && (exploration.view !== 'overview' || activeStudio !== null || (lifeEnabled && !bootState.done)),
  );
  useEffect(() => {
    setStudyStageOccluded(stageOccluded);
    return () => setStudyStageOccluded(false);
  }, [stageOccluded]);
  useEffect(() => {
    if (!world3d || !sharedCityRoom || String(sharedCityRoom.learner) !== String(account)) return;
    let cancelled = false;
    setCityConnection('connecting');
    void import('./world/echoLife/sharedCity').then(({SharedCityPresence}) => {
      if (cancelled) return;
      const client = new SharedCityPresence(sharedCityRoom.room, sharedCityRoom.learner, setCityConnection, sharedCityRoom.clockOffset);
      sharedCityRef.current = client;
      if (worldRef.current) worldRef.current.sharedCity = client;
    }).catch(() => { if (!cancelled) setCityConnection('offline'); });
    return () => {
      cancelled = true;
      if (worldRef.current) worldRef.current.sharedCity = null;
      sharedCityRef.current?.dispose();
      sharedCityRef.current = null;
    };
  }, [world3d, sharedCityRoom, account]);
  // The room's bars step aside for the world and come back at the edge, on focus or on the HUD key (lib/hud): one system with Speaking Arena and Echo Quiz Rush.
  const hud = useEdgeReveal({ enabled: world3d && mode !== 'edit', locked: exploration.locked, hold: { bottom: quickOpen } });
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const activate = useCallback((id: string) => {
    const obj = useSpace.getState().layout.objects.find((o) => o.id === id);
    if (!obj) return;
    const item = CATALOG_BY_ID[obj.kind];
    if (obj.action == null && obj.kind.startsWith('lamp.')) {
      ops.object(id, { lightOn: obj.lightOn === false }, 'lamp');
      return;
    }
    if ((obj.kind === 'laptop' || obj.kind === 'monitor') &&
        (obj.action == null || obj.action.startsWith('route:') || obj.action.startsWith('open:'))) {
      const world = worldRef.current;
      if (world?.bodyReady) {
        if (!world.exploration.active) world.setView('first');
        world.manip.perform('use', id);
      }
      return;
    }
    if (obj.action == null && obj.kind.startsWith('desk.')) {
      worldRef.current?.focusDesk(id);
      setFocusFloat(true);
      return;
    }
    const action: ActionId = obj.action ?? item?.action ?? (item?.anchor ? 'character:sit' : 'none');
    actionRef.current(action, id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runAction = (action: ActionId, objectId?: string) => {
    if (action === 'none') return;
    if (action === 'open:focus') { setFocusFloat(true); return; }
    if (action.startsWith('open:')) { setPanel(action.slice(5)); return; }
    if (action === 'toggle:music') {
      const e = music.engine;
      if (!e) return;
      if (music.playing) e.pause(); else if (music.current) void e.play(); else { const first = e.tracks()[0]; if (first) void e.select(first.id); }
      return;
    }
    if (action.startsWith('character:')) {
      const w = worldRef.current;
      if (!w || !objectId) return;
      const target = useSpace.getState().layout.objects.find(o => o.id === objectId);
      const act: Activity = action === 'character:sleep' ? 'sleep' : action === 'character:read' ? 'read' : target?.kind.startsWith('bed.') ? 'sleep' : target?.kind === 'armchair' ? 'relax' : 'study';
      if (!w.useObject(objectId, act)) say(vi ? 'Nhân vật chưa thể dùng vật này.' : 'Your character cannot use this object right now.');
      else useSpace.getState().apply((l) => ({ ...l, character: { ...l.character, anchor: objectId, activity: act } }), 'char-anchor');
      return;
    }
    if (action === 'route:dictionary') { setPanel(null); if (dictionaryOpen.current) dictionaryOpen.current(); else { setDictionaryMounted(true); dictionaryWanted.current = true; } return; }
    const route = ROUTE_OF[action];
    if (route) {
      if (action === 'route:mybooks') { try { localStorage.setItem('readingActiveTab', 'mybooks'); } catch { /* storage denied */ } }
      // The thing in the room opens its module here, the room still behind it. A place that is a whole world of its own (an exam) is still a journey.
      if (['/reading', '/listening', '/speaking', '/writing', '/flashcards', '/grammar', '/learning-path', '/progress'].includes(route)) { void persistRef.current('NONE'); setPanel(`module:${route}`); }
      else void leaveTo(route);
    }
  };
  actionRef.current = runAction;

  const leaveTo = async (href: string, door?: WorldDestination) => {
    if (travelLock.current) return;
    travelLock.current = true; setTravelling(true);
    worldRef.current?.exploration.unlock();
    worldRef.current?.settlePhysics(); worldRef.current?.flushExploration();
    worldRef.current?.setTravelling(true);
    let leaving = false;
    try {
      if (await persist('NONE')) {
        leaving = true;
        markWorldPassage(href.split('?')[0]);
        if (door) {
          // Through the doorway, into the same ocean passage as Landing and sign-in: one transition engine. If it cannot run, the plain route still does.
          const ms = worldRef.current?.enterDoor(door) ?? 0;
          if (ms) await new Promise((resolve) => window.setTimeout(resolve, ms * .72));
          if (!journeyGo(href)) router.push(href);
        } else router.push(href);
      }
    }
    finally { if (!leaving) { worldRef.current?.cancelDoor(); worldRef.current?.setTravelling(false); travelLock.current = false; setTravelling(false); } }
  };
  /** On foot: the body gets up, walks to the door, opens it and goes through. The page changes once it has. */
  const travel = (destination: WorldDestination, join?: string) => {
    const id = activeSpace.current?.id, w = worldRef.current;
    if (!id || travelLock.current) return;
    const href = worldDestination(destination, id) + (join ? `&join=${encodeURIComponent(join)}` : '');
    const direct = () => void leaveTo(href, destination);
    if (!w) { direct(); return; }
    w.journey(destination, () => { markArrival(destination); void leaveTo(href); }, direct);
    canvasRef.current?.focus({ preventScroll: true });
  };
  portalRef.current = travel;
  // A friend's room: up from the chair or the screen, on foot to the Arena's door. Only ever after the person said yes.
  const joinArena = (code: string) => {
    setPanel(null);
    if (device) leaveDevice();
    window.setTimeout(() => travelRef.current('arena', code), 60);
  };
  joinArenaRef.current = joinArena;
  travelRef.current = travel;
  const runExploreTransitionGate = useCallback((w: StudyWorld) => {
    if (!lifeEnabled || outdoorWarmedRef.current) return;
    const worldEx = w as StudyWorldWithPreEntry;
    void import('./world/echoLife/preloadManifest').then(async ({ EchoLifeBootOrchestrator: OrchestratorCtor }) => {
      if (worldRef.current !== w) return;
      bootOrchestratorRef.current?.abort();
      const orch = new OrchestratorCtor(9.5);
      bootOrchestratorRef.current = orch;
      const unsub = orch.subscribe((snap: BootProgressSnapshot) => {
        setBootState({
          pct: snap.progress,
          stageId: snap.stageId,
          stage: snap.stageLabelVi,
          detailVi: snap.detailVi,
          slowNoticeVi: snap.slowNoticeVi,
          slowState: snap.status === 'slow',
          transitionMode: snap.transitionMode,
          errorVi: snap.errorVi,
          done: snap.done,
          complete: snap.complete,
        });
      });
      try {
        const waitPoll = (pred: () => boolean, signal: AbortSignal) =>
          new Promise<void>((resolve) => {
            if (pred() || signal.aborted) { resolve(); return; }
            const id = window.setInterval(() => {
              if (pred() || signal.aborted) { window.clearInterval(id); resolve(); }
            }, 60);
            signal.addEventListener('abort', () => { window.clearInterval(id); resolve(); }, { once: true });
          });
        const report = await orch.runGate({
          tier: qualityTierRef.current,
          mode: 'explore',
          gate: 'G1_world',
          transitionMode: true,
          characterVisible: useSpace.getState().layout.character.visible,
          isHeld: () => isBackgroundHeld(),
          prepareEnvironment: async (ctx) => {
            ctx.reportStageFraction(1, 'transition:prep');
          },
          loadCoreAssets: async (ctx) => {
            await waitPoll(() => (!useSpace.getState().layout.character.visible || w.bodyReady) && Boolean(hudStore.get()?.ready), ctx.signal);
            ctx.reportStageFraction(1, 'transition:world-built');
          },
          warmupGraphics: async (ctx) => {
            await ctx.waitUntilVisibleForGpu();
            if (ctx.signal.aborted) return;
            if (typeof worldEx.runPreEntryWarmup === 'function') {
              await worldEx.runPreEntryWarmup({
                ensureWorld: true,
                signal: ctx.signal,
                onStage: (stageId, pct) => {
                  ctx.reportStageFraction(Math.max(0.05, Math.min(1, pct / 100)), `warmup:${stageId}`);
                },
              });
            } else {
              await w.warmupOutdoorPipeline();
            }
            if (!ctx.signal.aborted) outdoorWarmedRef.current = true;
            ctx.reportStageFraction(1, 'transition:warmup-done');
          },
          syncWorldSimulation: async (ctx) => {
            await waitPoll(() => Boolean(hudStore.get()?.ready), ctx.signal);
            ctx.reportStageFraction(1, 'transition:sync-done');
          },
          finalizeReady: async (ctx) => {
            await ctx.slicer.yieldFrame(ctx.signal);
            await ctx.slicer.yieldFrame(ctx.signal);
            ctx.reportStageFraction(1, 'transition:ready');
          },
        });
        if (report.complete && !report.aborted && !report.bypassedByUser && w.warmupReady && outdoorWarmedRef.current) {
          markEchoLifeWarmed();
        }
      } finally {
        unsub();
        if (bootOrchestratorRef.current === orch) bootOrchestratorRef.current = null;
      }
    });
  }, [lifeEnabled, hudStore]);

  const changeView = (view: CameraView) => {
    const w = worldRef.current;
    if (!w) return;
    if (view !== 'overview' && !useSpace.getState().layout.character.visible) {
      say(vi ? 'Bật nhân vật trong thanh công cụ để khám phá căn phòng.' : 'Enable your character in the toolbar to explore.'); return;
    }
    useSpace.getState().setMode('use');
    setBarOpen(false); setSection(null);
    if (view === 'desk') {
      if (!w.focusDesk()) { say(vi ? 'Cần có bàn học và lối đi trống để vào bàn.' : 'Add a study desk and keep its approach clear.'); return; }
    } else {
      // Changing the camera is not getting up: the body stays seated until the owner stands.
      w.setView(view);
    }
    if (view !== 'overview') {
      canvasRef.current?.focus({ preventScroll: true });
      w.exploration.play();
      if (lifeEnabled && !outdoorWarmedRef.current) runExploreTransitionGate(w);
    }
  };

  useEffect(() => {
    if (!world3d || !canvasRef.current) {
      if (phase === 'ready') {
        setBootState({
          ...INITIAL_BOOT_STATE,
          pct: 100,
          stageId: 'ready',
          stage: BOOT_STAGE_LABELS_VI.ready,
          done: true,
          complete: true,
        });
      }
      return;
    }
    let disposed = false;
    let w: StudyWorld | null = null;
    let orch: EchoLifeBootOrchestrator | null = null;
    let unsubscribeBoot: (() => void) | null = null;
    const canvasEl = canvasRef.current;
    setBootState(INITIAL_BOOT_STATE);

    const onContextLost = () => {
      if (!disposed) orch?.abortForContextLoss();
    };
    canvasEl.addEventListener('webglcontextlost', onContextLost);

    const waitUntil = (pred: () => boolean, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (pred() || signal.aborted || disposed) { resolve(); return; }
        const id = window.setInterval(() => {
          if (pred() || signal.aborted || disposed) {
            window.clearInterval(id);
            resolve();
          }
        }, 60);
        signal.addEventListener('abort', () => {
          window.clearInterval(id);
          resolve();
        }, { once: true });
      });

    void (async () => {
      try {
        const [{ EchoLifeBootOrchestrator: OrchestratorCtor }, engineMod, assetsMod, gatewayMod] = await Promise.all([
          import('./world/echoLife/preloadManifest'),
          import('./world/engine'),
          import('./world/assets'),
          import('./world/gatewayAssets'),
        ]);
        if (disposed || !canvasRef.current) return;

        orch = new OrchestratorCtor(9.5);
        bootOrchestratorRef.current = orch;
        unsubscribeBoot = orch.subscribe((snap: BootProgressSnapshot) => {
          if (disposed) return;
          setBootState({
            pct: snap.progress,
            stageId: snap.stageId,
            stage: snap.stageLabelVi,
            detailVi: snap.detailVi,
            slowNoticeVi: snap.slowNoticeVi,
            slowState: snap.status === 'slow',
            transitionMode: snap.transitionMode,
            errorVi: snap.errorVi,
            done: snap.done,
            complete: snap.complete,
          });
        });

        const { StudyWorld } = engineMod;
        const { loadStudyAssets, loadCareAssets, CARE_IDS } = assetsMod;
        const { loadGatewayAssets } = gatewayMod;

        const initialView = useSpace.getState().layout.camera.view;
        const initialCharVisible = useSpace.getState().layout.character.visible;
        const startInExplore = lifeEnabled && initialView !== 'overview';

        const report = await orch.runGate({
          tier: qualityTierRef.current,
          mode: startInExplore ? 'explore' : 'overview',
          gate: startInExplore ? 'G1_world' : 'G0_room',
          transitionMode: false,
          characterVisible: initialCharVisible,
          isHeld: () => isBackgroundHeld(),
          prepareEnvironment: async (ctx) => {
            ctx.reportWorkProgress(1, 2, 'tệp khởi tạo', 'prep:modules');
            await ctx.slicer.yieldIfNeeded(ctx.signal);
            if (ctx.signal.aborted || disposed) return;
            ctx.reportWorkProgress(2, 2, 'tệp khởi tạo', 'prep:ready');
          },
          loadCoreAssets: async (ctx) => {
            const needCare = useSpace.getState().layout.objects.some((o) => CARE_IDS.has(o.kind));
            const totalUnits = needCare ? 5 : 4;
            let completedUnits = 0;
            const bump = (key: string) => {
              completedUnits++;
              ctx.reportWorkProgress(completedUnits, totalUnits, 'tệp môi trường', key);
            };
            // A room with cleaning things in it waits for them too: nothing stands in for them on the first frame.
            await Promise.all([
              loadStudyAssets().then(() => bump('assets:study')),
              loadGatewayAssets().then(() => bump('assets:gateway')),
              needCare ? loadCareAssets().then(() => bump('assets:care')) : Promise.resolve(),
            ]);
            if (ctx.signal.aborted || disposed || !canvasRef.current) return;

            w = new StudyWorld(canvasRef.current, {
              lifeEnabled,
              onSelect: (ids, additive) => useSpace.getState().select(ids, additive),
              onMove: (id, pos, rotY, merge) => {
                const cur = useSpace.getState().layout.objects.find((o) => o.id === id);
                if (cur?.quat) {
                  const norm = normalizeSpaceObjectOrientation(
                    quatFromSpaceObject({ rotY, quat: cur.quat, state: cur.state }),
                  );
                  ops.object(id, { pos, rotY: norm.quat ? rotY : norm.rotY, quat: norm.quat }, merge);
                } else {
                  ops.object(id, { pos, rotY, quat: undefined }, merge);
                }
              },
              onObjectState: (id, patch, merge) => ops.object(id, patch, merge),
              onMoveDone: () => undefined,
              onPlace: (kind, pos, rotY) => ops.addObject({ id: uid('o'), kind, pos, rotY, quat: undefined, scale: 1 }),
              onActivate: (id) => activate(id),
              onCamera: (camera) => useSpace.getState().apply((l) => ({ ...l, camera }), 'camera'),
              onCharacterMoved: (pos, rotY, floorPose) => useSpace.getState().apply((l) => ({ ...l, character: { ...l.character, pos, rotY, floorPose, anchor: null, activity: 'idle' } }), 'char-move'),
              onCharacterClick: () => worldRef.current?.characterActivity('wave'),
              onCharacterUse: (anchor, activity) => useSpace.getState().apply(l => ({ ...l, character: { ...l.character, floorPose: undefined, anchor, activity } }), 'char-anchor'),
              onFail: () => {
                setWorldFailed(true);
                if (orch && !orch.getSnapshot().done) {
                  orch.abortForContextLoss();
                } else {
                  setBootState((prev) => ({ ...prev, pct: 100, stageId: 'ready', stage: BOOT_STAGE_LABELS_VI.ready, done: true }));
                }
                say(vi ? 'Trình duyệt dừng đồ họa 3D. Công cụ học tập vẫn dùng được; bấm “Thử lại 3D” trong thanh công cụ.' : '3D graphics stopped in this browser. Study tools remain available; click “Retry 3D” in the toolbar.');
              },
              onQuality: q => notifyQualityDowngrade(q),
              onExplore: setExploration,
              onInteraction: setInteraction,
              onShortcut: action => shortcutRef.current(action),
              bookSession: obj => bookSessionOf(obj, vi, accountRef.current),
              onLibrary: shelf => { libraryShelf.current = shelf; setPanel('library'); },
              onDespawn: id => useSpace.getState().apply(l => ({ ...l, objects: l.objects.filter(o => o.id !== id) }), `book-back-${id}`),
              persistLayout: () => persistRef.current('NONE'),
              onDevice: (id, rect) => { setDevice({ id, rect }); void persistRef.current('NONE'); },
              onSpawn: obj => ops.addObject(obj),
              onCurtains: curtains => useSpace.getState().apply((l) => ({ ...l, room: { ...l.room, curtains: curtains || undefined } }), 'curtains'),
              onAccessory: (id, on) => useSpace.getState().apply((l) => {
                const look = normalizeLook(l.character.model, l.character.look);
                const accessories = on ? [...new Set([...look.accessories, id])] : look.accessories.filter(a => a !== id);
                return { ...l, character: { ...l.character, look: { ...look, accessories }, lookAt: Date.now() } };
              }, 'char-look'),
              wearing: id => normalizeLook(useSpace.getState().layout.character.model, useSpace.getState().layout.character.look).accessories.includes(id),
              say: (vn, en) => say(vi ? vn : en),
              language: () => (vi ? 'vi' : 'en'),
              onPortal: destination => portalRef.current(destination),
              onWindow: open => useSpace.getState().apply((l) => ({ ...l, room: { ...l.room, windowOpen: open } }), 'window'),
              onLife: life => useSpace.getState().apply(l => ({ ...l, life }), 'life'),
              onCaption: line => { captionRef.current = true; setCaption(line); },
              captionOn: () => captionRef.current,
              onToolState: (id, state, immediate) => {
                ops.object(id, { state: state ?? undefined }, 'tool-state');
                if (immediate) void persistRef.current('NONE');
              },
              social: () => { const m = useMessenger.getState(); return { unread: m.unread, invited: m.cards.some(c => c.kind === 'invite') }; },
              onGameHud: hud => {
                hudStore.set(hud);
                const playerSeatNow = hud?.host.game?.people.playerSeat ?? null;
                if (playerSeatNow && prevPlayerSeatRef.current !== playerSeatNow) {
                  setGameTarget(prev => (prev && prev.kind !== 'npc' ? null : prev));
                }
                prevPlayerSeatRef.current = playerSeatNow;
              },
              onGameInteract: target => {
                if (target.kind === 'seat') {
                  setGameTarget(null);
                  if (w) void w.game.act(target, 'sit');
                  return;
                }
                setGameTarget(target);
              },
            });
            w.setReduced(!!reduced);
            w.setHeld(isBackgroundHeld());
            w.sync(useSpace.getState().layout, activeSpace.current?.id || '');
            (w as StudyWorld & { setQualityTier?: (t: QualityTier) => void }).setQualityTier?.(qualityTierRef.current);
            w.setLifeSave(lifeSaveRef.current);
            w.setGameSave(gameSaveRef.current);
            w.sharedCity = sharedCityRef.current;
            w.setMode(useSpace.getState().mode, useSpace.getState().selection);
            w.exploration.setBlocked(inputBlockedRef.current);
            w.start();
            worldRef.current = w;
            outdoorWarmedRef.current = false;
            bump('assets:scene-built');

            // Wait truthfully for character rig (when visible) and Echo Life world build (when exploring).
            await waitUntil(() => {
              if (!w) return true;
              const needBody = useSpace.getState().layout.character.visible;
              const bodyOk = !needBody || w.bodyReady;
              const lifeOk = !lifeEnabled || !w.exploration.active || Boolean(hudStore.get()?.ready);
              return bodyOk && lifeOk;
            }, ctx.signal);

            // P5-Perf #3: Await Creator V2 profile hydration (hair/wardrobe/morphs) bounded & fault-isolated
            // BEFORE `runPreEntryWarmup` compiles shaders so late avatar GLBs never stall post-unlock!
            if (!ctx.signal.aborted && !disposed && w && useSpace.getState().layout.character.visible) {
              const profileWait = Promise.resolve(w.applyCreatorProfile(creatorProfileRef.current)).catch(() => undefined);
              await Promise.race([
                profileWait,
                new Promise<void>((resolve) => {
                  const timer = window.setTimeout(resolve, 4000);
                  ctx.signal.addEventListener('abort', () => {
                    window.clearTimeout(timer);
                    resolve();
                  }, { once: true });
                }),
              ]);
            }
            bump('assets:body-and-world');
          },
          warmupGraphics: async (ctx) => {
            if (!w || ctx.signal.aborted || disposed) return;
            await ctx.waitUntilVisibleForGpu();
            if (ctx.signal.aborted || disposed) return;
            const worldEx = w as StudyWorldWithPreEntry;
            const exploringNow = lifeEnabled && w.exploration.active;
            ctx.reportStageFraction(0.1, 'graphics:warmup-start');
            // P5-Perf #3: Execute `runPreEntryWarmup` on BOTH `G1_world` (`ensureWorld: true`) AND
            // `G0_room` Overview (`ensureWorld: false`) so Study Room CSM shadow maps & `PortalCapture` work from Frame 1!
            if (typeof worldEx.runPreEntryWarmup === 'function') {
              await worldEx.runPreEntryWarmup({
                ensureWorld: exploringNow,
                signal: ctx.signal,
                onStage: (stageId, pct) => {
                  ctx.reportStageFraction(Math.max(0.1, Math.min(1, pct / 100)), `graphics:${stageId}`);
                },
              });
              if (exploringNow && !ctx.signal.aborted) outdoorWarmedRef.current = true;
            } else if (exploringNow) {
              await w.warmupOutdoorPipeline();
              if (!ctx.signal.aborted) outdoorWarmedRef.current = true;
            }
            ctx.reportStageFraction(1, 'graphics:warmup-done');
          },
          syncWorldSimulation: async (ctx) => {
            if (!w || ctx.signal.aborted || disposed) return;
            await waitUntil(() => !w || !lifeEnabled || !w.exploration.active || Boolean(hudStore.get()?.ready), ctx.signal);
            ctx.reportStageFraction(1, 'sync:world-ready');
          },
          finalizeReady: async (ctx) => {
            await ctx.slicer.yieldFrame(ctx.signal);
            await ctx.slicer.yieldFrame(ctx.signal);
            ctx.reportStageFraction(1, 'ready:presented');
          },
        });

        // Write warm-cache cookie ONLY after a complete, non-bypassed outdoor world warmup!
        if (
          !disposed &&
          lifeEnabled &&
          outdoorWarmedRef.current &&
          report.complete &&
          !report.aborted &&
          !report.bypassedByUser &&
          w &&
          (w as StudyWorld).warmupReady
        ) {
          markEchoLifeWarmed();
        }
      } catch {
        if (!disposed) {
          setWorldFailed(true);
          setBootState((prev) => ({
            ...prev,
            done: false,
            complete: false,
            errorVi: 'Không thể khởi tạo Không gian học tập 3D. Vui lòng thử lại hoặc chuyển sang chế độ Đồ họa nhẹ.',
          }));
        }
      }
    })();

    let resizeRaf = 0;
    const onResize = () => {
      if (resizeRaf) return;
      resizeRaf = window.requestAnimationFrame(() => {
        resizeRaf = 0;
        if (!disposed) worldRef.current?.resize();
      });
    };
    window.addEventListener('resize', onResize);
    return () => {
      disposed = true;
      if (resizeRaf) {
        window.cancelAnimationFrame(resizeRaf);
        resizeRaf = 0;
      }
      canvasEl.removeEventListener('webglcontextlost', onContextLost);
      orch?.abort();
      unsubscribeBoot?.();
      if (bootOrchestratorRef.current === orch) bootOrchestratorRef.current = null;
      window.removeEventListener('resize', onResize);
      worldRef.current = null;
      w?.dispose();
      thumbs.current.clear();
    };
  }, [world3d, bootRetryTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Echo Life: the world around the room is this account's save (lib/echo-life/save.ts, server V129), never the room's layout.
  useEffect(() => { worldRef.current?.sync(layout, space?.id || ''); worldRef.current?.setLifeSave(lifeSave); }, [layout, space?.id, lifeSave]);
  useEffect(() => { worldRef.current?.setGameSave(gameSave); }, [gameSave]);
  // The room's own settings, from the bar: the world keeps its record, so it has to hear of them.
  const lifeSettings = JSON.stringify(layout.life?.settings ?? null);
  useEffect(() => { const w = worldRef.current; if (w && layout.life?.settings && JSON.stringify(w.life.life.settings) !== lifeSettings) w.life.useSettings(layout.life.settings); }, [lifeSettings]); // eslint-disable-line react-hooks/exhaustive-deps
  // Keyboard shortcuts that belong to the page rather than the world.
  shortcutRef.current = (action) => {
    if (action === 'focus') setFocusFloat(v => !v);
    else if (action === 'wardrobe') setPanel(p => p === 'character' ? null : 'character');
    else if (action === 'quick') setQuickOpen(v => !v);
    else if (action === 'actions') openWheel(!wheelOpen);
    else if (action === 'hud') hud.toggle();
    else if (action === 'settings') { if (barOpen) { setBarOpen(false); setSection(null); } else openBar(); }
    else if (action === 'help') setHelpTick(n => n + 1);
    else if (action === 'planner') setPanel('planner');
    else if (action === 'arena' || action === 'games') travel(action);
    else if (action === 'cancel') setQuickOpen(false);
    else if (action === 'undo') { useSpace.getState().undo(); say(vi ? 'Đã hoàn tác.' : 'Undone.'); }
  };
  // One player, one appearance: the newer of this space's record and the account's own goes on the body, and both learn of it.
  useEffect(() => {
    if (!account || phase !== 'ready') return;
    const ch = layout.character, local = readIdentity(account), mine = ch.lookAt ?? 0;
    if (local && local.at > mine) {
      useSpace.getState().apply((l) => ({ ...l, character: { ...l.character, model: local.hero, look: local.look, lookAt: local.at } }), 'char-look');
    } else if (mine > (local?.at ?? -1) || (!local && ch.look)) {
      const next: AvatarIdentity = { hero: ch.model, look: normalizeLook(ch.model, ch.look), at: mine };
      writeIdentity(account, next);
    }
  }, [account, phase, layout.character.model, layout.character.look, layout.character.lookAt]); // eslint-disable-line react-hooks/exhaustive-deps
  // Hydrate Wave 11 Character Creator V2 profile from WorldSaver (server) -> localStorage -> default and apply live on spawn.
  useEffect(() => {
    if (!account || phase !== 'ready') return;
    const hydrateCreator = () => {
      const fromServer = lifeSave?.loadAvatarProfile() ?? null;
      const fromLocal = readCreatorProfile(account);
      const heroFallback = useSpace.getState().layout.character.model;
      const resolved = fromServer ?? fromLocal ?? createDefaultCreatorProfile(heroFallback);
      creatorProfileRef.current = resolved;
      setCreatorProfile(resolved);
      if (worldRef.current) {
        void worldRef.current.applyCreatorProfile(resolved);
        worldRef.current.game.game?.setProfileIdentity(resolved.identity);
      }
    };
    hydrateCreator();
    return lifeSave ? lifeSave.onChange(hydrateCreator) : undefined;
  }, [account, lifeSave, phase]);

  // Back through the door it left by.
  useEffect(() => {
    if (phase !== 'ready' || !account) return;
    const from = takeArrival();
    if (!from) return;
    let tries = 0;
    const wait = window.setInterval(() => { const w = worldRef.current; if (w?.bodyReady || ++tries > 80) { window.clearInterval(wait); if (w?.bodyReady) w.arrive(from); } }, 150);
    return () => window.clearInterval(wait);
  }, [phase, account]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { worldRef.current?.setMode(mode, selection); }, [mode, selection]);
  useEffect(() => { worldRef.current?.setReduced(!!reduced); }, [reduced]);
  useEffect(() => { worldRef.current?.setMusic(music.playing); }, [music.playing]);
  const effectiveGameTarget = gameTarget && gameTarget.kind === 'seat' ? null : gameTarget;
  const lifeBlocked = !!effectiveGameTarget || !!lifePanel || gameChallenge || activeStudio !== null;
  const otherInputBlocked = !!panel || clearAsk || resetRoomAsk || barOpen || pinned || appearanceStudioOpen || travelling || !!device || mode==='edit' || lifeBlocked;
  const inputBlocked = otherInputBlocked || wheelOpen;
  inputBlockedRef.current = inputBlocked;
  useEffect(() => {
    if (!photoMode && photoFilterCss !== 'none') setPhotoFilterCss('none');
  }, [photoMode, photoFilterCss]);
  useEffect(()=>{if(otherInputBlocked){setWheelOpen(false);wheelCommand.current=null;}},[otherInputBlocked]);
  // The window changed size with the desktop open: it stays exactly over the screen.
  useEffect(() => {
    if (!device) return;
    let devRaf = 0;
    const place = () => {
      if (devRaf) return;
      devRaf = window.requestAnimationFrame(() => {
        devRaf = 0;
        const rect = worldRef.current?.deviceRect();
        if (rect) setDevice(d => d ? { ...d, rect } : d);
      });
    };
    window.addEventListener('resize', place);
    return () => {
      if (devRaf) window.cancelAnimationFrame(devRaf);
      window.removeEventListener('resize', place);
    };
  }, [!!device]); // eslint-disable-line react-hooks/exhaustive-deps
  // What the Messenger's cards ask for, wherever the person is in the room.
  useEffect(() => {
    const onJoin = (e: Event) => {
      e.preventDefault();
      const code = (e as CustomEvent<{ code: string }>).detail.code;
      if (deviceRef.current) { setPanel(null); setDeskRequest({ arena: code }); }
      else joinArenaRef.current(code);
    };
    const onOpen = (e: Event) => {
      e.preventDefault();
      const id = (e as CustomEvent<{ conversationId: string | null }>).detail.conversationId;
      setChat(id);
      if (deviceRef.current) { setPanel(null); setDeskRequest({ conversation: id }); }
      else setPanel('messenger');
    };
    window.addEventListener('ec:arena-join', onJoin);
    window.addEventListener('ec:messenger-open', onOpen);
    return () => { window.removeEventListener('ec:arena-join', onJoin); window.removeEventListener('ec:messenger-open', onOpen); };
  }, []);
  const refreshLibrary = useCallback(() => {
    const who = accountRef.current;
    if (!who) return;
    void loadLibrary(who).then(list => { setLibrary(list); worldRef.current?.setLibrary(list); }).catch(() => setLibrary([]));
  }, []);
  // The shelves fill once the room is standing. Nothing here holds the room up.
  useEffect(() => {
    if (phase !== 'ready' || !account) return;
    const id = window.setTimeout(refreshLibrary, 900);
    return () => clearTimeout(id);
  }, [phase, account, world3d, refreshLibrary]);
  const leaveDevice = useCallback(() => { setDeskRequest(null); setPanel(null); setDevice(null); worldRef.current?.leaveDevice(); canvasRef.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const w = worldRef.current;
    if (!w) return;
    w.exploration.setBlocked(inputBlocked);
    // After an overlay the keys belong to the room again, without a click.
    if (!inputBlocked && w.exploration.active) {
      canvasRef.current?.focus({ preventScroll: true });
      const raf = window.requestAnimationFrame(() => {
        if (!inputBlockedRef.current && worldRef.current?.exploration.active && document.activeElement === document.body) {
          canvasRef.current?.focus({ preventScroll: true });
        }
      });
      if (wheelCommand.current) { const run = wheelCommand.current; wheelCommand.current = null; run(); }
      return () => window.cancelAnimationFrame(raf);
    }
    if (!inputBlocked && wheelCommand.current) { const run=wheelCommand.current;wheelCommand.current=null;run(); }
  }, [inputBlocked, effectiveGameTarget, exploration.seated]);
  // The focus timer has real controls: while it is open the cursor is free, unless the player asks for mouse-look again.
  useEffect(() => { worldRef.current?.exploration.mouseLook.cursorNeeded('focus', focusFloat, true); }, [focusFloat]);
  useEffect(() => {
    const failed = () => say(vi ? 'Chưa tải được tương tác vật lý. Bạn có thể thử lại hoặc dùng Trình sửa phòng.' : 'Physical interaction could not load. Retry or use the Room Editor.');
    window.addEventListener('study:physics-unavailable', failed);
    return () => window.removeEventListener('study:physics-unavailable', failed);
  }, [vi]); // eslint-disable-line react-hooks/exhaustive-deps

  // The character follows the focus timer (optional, per layout). The timer may suggest what the character does while
  // the learner watches from the overview; it never moves the body the learner is in. Subscribed, not rendered: a tick
  // of the timer re-renders nothing here.
  useEffect(() => {
    if (!account) return;
    const engine = getFocusEngine(account);
    let last = '';
    const follow = () => {
      const focus = engine.snapshot(), key = `${focus.status}|${focus.phase}`;
      if (key === last) return;
      const prev = last;
      last = key;
      const w = worldRef.current, ch = useSpace.getState().layout.character;
      if (!prev || !w || !ch.visible || !ch.followFocus || w.exploration.active) return;
      if (focus.status === 'running' && focus.phase === 'focus') {
        if (ch.anchor) w.useObject(ch.anchor, 'study'); else w.characterActivity('study');
      } else if (prev === 'running|focus' && focus.phase !== 'focus') {
        w.characterActivity('stretch');
        window.setTimeout(() => { const now = worldRef.current; if (now && !now.exploration.active) now.restCharacter('relax'); }, 4500);
      }
    };
    follow();
    return engine.subscribe(follow);
  }, [account]);

  // ── Toolbar visibility (layer 4) ────────────────────────────────────────────────────────────────────────
  const openBar = useCallback(() => { if (closeTimer.current) clearTimeout(closeTimer.current); setBarOpen(true); }, []);
  const scheduleClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => { if (!keep.current && !pinned && !drag) { setBarOpen(false); setSection(null); } }, 700);
  }, [pinned, drag]);

  useEffect(() => {
    let startY = -1;
    const ts = (e: TouchEvent) => { startY = e.touches[0]?.clientY ?? -1; };
    const tm = (e: TouchEvent) => { if (startY >= 0 && startY < 32 && (e.touches[0]?.clientY ?? 0) - startY > 40) { openBar(); startY = -1; } };
    window.addEventListener('touchstart', ts, { passive: true });
    window.addEventListener('touchmove', tm, { passive: true });
    return () => { window.removeEventListener('touchstart', ts); window.removeEventListener('touchmove', tm); };
  }, [openBar]);

  const saveLayoutRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const seatedNow = !!exploration.seated;
  const keyStateRef = useRef({ device, panel, clearAsk, resetRoomAsk, barOpen, openBar, say, vi, activeStudio, lifeBlocked, seatedNow });
  useEffect(() => {
    keyStateRef.current = { device, panel, clearAsk, resetRoomAsk, barOpen, openBar, say, vi, activeStudio, lifeBlocked, seatedNow };
  }, [device, panel, clearAsk, resetRoomAsk, barOpen, openBar, say, vi, activeStudio, lifeBlocked, seatedNow]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const st = keyStateRef.current;
      // At the computer or inside any Wave 11 studio/modal, Study Space room hotkeys yield cleanly.
      if (st.device || st.activeStudio !== null || st.lifeBlocked) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (e.key === 'Escape') {
        if (st.panel || st.clearAsk || st.resetRoomAsk) return;
        if (useSpace.getState().selection.length) { useSpace.getState().select([]); return; }
        if (st.barOpen) { setBarOpen(false); setSection(null); return; }
        const w = worldRef.current;
        if (w?.isSeatedOrApproaching || st.seatedNow) {
          e.preventDefault();
          w?.standUp();
          canvasRef.current?.focus({ preventScroll: true });
          return;
        }
        st.openBar();
        return;
      }
      if (typing) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); if (useSpace.getState().past.length) { useSpace.getState().undo(); st.say(st.vi ? 'Đã hoàn tác.' : 'Undone.'); } }
      else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); useSpace.getState().redo(); }
      else if (mod && e.key.toLowerCase() === 'c') useSpace.getState().copy();
      else if (mod && e.key.toLowerCase() === 'v') useSpace.getState().paste();
      else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); ops.duplicateSelected(); }
      else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void saveLayoutRef.current(); }
      else if (!mod && e.key.toLowerCase() === 'e' && !worldRef.current?.exploration.active) useSpace.getState().setMode(useSpace.getState().mode === 'edit' ? 'use' : 'edit');
      else if ((e.key === 'Delete' || e.key === 'Backspace') && useSpace.getState().mode === 'edit') ops.removeSelected();
      else if (!mod && (e.key === 'r' || e.key === 'R') && useSpace.getState().mode === 'edit') {
        const sel = useSpace.getState().selection;
        const step = (e.shiftKey ? -1 : 1) * (Math.PI / 2);
        ops.objects(sel, (o) => {
          if (o.quat !== undefined || o.state?.tilt) {
            const up = resetSpaceObjectUprightPatch(o);
            return { ...o, ...up, rotY: up.rotY + step };
          }
          return { ...o, rotY: o.rotY + step, quat: undefined };
        });
        worldRef.current?.rotateGhost(step);
      } else if (!mod && e.key.toLowerCase() === 'l' && useSpace.getState().mode === 'edit') {
        const sel = useSpace.getState().selection;
        ops.objects(sel, (o) => ({ ...o, locked: !o.locked }));
      } else if (!mod && e.key.toLowerCase() === 'h' && useSpace.getState().mode === 'edit') {
        const sel = useSpace.getState().selection;
        ops.objects(sel, (o) => ({ ...o, hidden: true }));
        useSpace.getState().select([]);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  // ── Toolbar API ─────────────────────────────────────────────────────────────────────────────────────────
  const loadLayout = (l: Layout) => useSpace.getState().apply(() => l);

  const requestResetRoom = useCallback(() => {
    if (worldRef.current?.exploration.locked) {
      worldRef.current.exploration.unlock();
    }
    setBarOpen(false);
    setSection(null);
    setQuickOpen(false);
    setWheelOpen(false);
    setResetRoomAsk(true);
  }, []);

  const executeResetRoom = useCallback(async () => {
    const cur = useSpace.getState().layout;
    const w = worldRef.current;
    // Reuse existing `SpaceObject.id`s matched in order by `kind` so `engine.sync` updates transforms in-place
    // in `< 2 ms` (`0` GLB teardowns/re-clones and `programDelta === 0`) instead of rebuilding all 38 meshes!
    const existingIdsByKind = new Map<string, string[]>();
    for (const prevObj of cur.objects) {
      let bucket = existingIdsByKind.get(prevObj.kind);
      if (!bucket) {
        bucket = [];
        existingIdsByKind.set(prevObj.kind, bucket);
      }
      bucket.push(prevObj.id);
    }
    const takeIdForKind = (kind: string, fallbackId?: string): string => {
      const bucket = existingIdsByKind.get(kind);
      if (bucket && bucket.length > 0) return bucket.shift()!;
      return fallbackId || uid('o');
    };

    let restoredObjects: SpaceObject[];
    if (space?.hasDefault && space.defaultLayout) {
      const custom = readLayout(space.defaultLayout);
      if (custom.objects.length > 0) {
        restoredObjects = custom.objects.map((obj) => ({
          ...obj,
          id: takeIdForKind(obj.kind, obj.id),
          hidden: false,
          drawers: undefined,
          inside: undefined,
          ...(obj.quat !== undefined || obj.state?.tilt ? resetSpaceObjectUprightPatch(obj) : {}),
          state: obj.state?.book ? { book: obj.state.book } : undefined,
        }));
        if (!hasKit(restoredObjects)) {
          const extraKit = kitObjects(restoredObjects, cur.room.size, () => uid('o')).map((obj) => ({
            ...obj,
            id: takeIdForKind(obj.kind, obj.id),
          }));
          restoredObjects = [...restoredObjects, ...extraKit];
        }
      } else {
        const built = buildDefaultRoomObjects(cur.room.theme, cur.room.size);
        restoredObjects = built.objects.map((obj) => ({
          ...obj,
          id: takeIdForKind(obj.kind, obj.id),
        }));
      }
    } else {
      const built = buildDefaultRoomObjects(cur.room.theme, cur.room.size);
      restoredObjects = built.objects.map((obj) => ({
        ...obj,
        id: takeIdForKind(obj.kind, obj.id),
      }));
    }

    const cleanRoomLife = cur.life
      ? {
          ...freshLife(space?.id ?? 'room', Date.now()),
          settings: cur.life.settings ?? DEFAULT_SETTINGS,
          log: cur.life.log ?? [],
        }
      : undefined;

    const charAt = w?.characterAt();
    const half = cur.room.size / 2;
    const isOutsideStudy = Boolean(
      charAt && (Math.abs(charAt.pos[0]) > half + 0.16 || Math.abs(charAt.pos[2]) > half + 0.16),
    );

    const nextLayout: Layout = {
      ...cur,
      room: {
        ...cur.room,
        visible: true,
        wallLeft: true,
        wallRight: true,
        floor: true,
        base: true,
        curtains: undefined,
      },
      objects: restoredObjects,
      character: {
        ...cur.character,
        visible: true,
        pos: isOutsideStudy && charAt ? charAt.pos : [1.2, 0, 0.4],
        rotY: isOutsideStudy && charAt ? charAt.rotY : Math.PI * 0.8,
        anchor: null,
        activity: 'idle',
        floorPose: undefined,
      },
      ...(cleanRoomLife ? { life: cleanRoomLife } : {}),
    };

    useSpace.getState().select([]);
    useSpace.getState().setMode('use');
    loadLayout(nextLayout);
    setWorldFailed(false);
    w?.resetRoomRuntimeState(nextLayout);
    await persist('RESTORE');
    setResetRoomAsk(false);
    say(vi ? 'Đã đặt lại căn phòng về trạng thái ban đầu.' : 'Room reset to default state.');
    if (w?.exploration.active) {
      canvasRef.current?.focus({ preventScroll: true });
    }
  }, [space, persist, say, vi]);

  const api: ToolbarApi = {
    thumbnail: (kind) => {
      const hit = thumbs.current.get(kind);
      if (hit) return hit;
      const w = worldRef.current;
      if (!w) return null;
      try { const url = w.thumbnail(kind); thumbs.current.set(kind, url); return url; } catch { return null; }
    },
    beginDrag: (kind, e) => {
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY };
      let moved = false;
      const src = thumbs.current.get(kind) ?? null;
      const world = () => worldRef.current;
      const onMove = (ev: PointerEvent) => {
        if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 6) {
          moved = true;
          if (!world()) {
            // the 3D scene is off (empty foreground): placing an object brings it back, then the item lands in a free spot
            setDrag(null);
            return;
          }
          world()!.beginPlacement(kind);
          setSection(null);
        }
        if (moved) { setDrag({ kind, x: ev.clientX, y: ev.clientY, src }); world()?.moveGhost(ev.clientX, ev.clientY); }
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setDrag(null);
        if (!moved) { api.addObject(kind); return; }
        const placed = world()?.endPlacement(ev.clientX, ev.clientY);
        if (placed === false) say(vi ? 'Chỗ này không đặt được — thử chỗ khác hoặc bật đặt tự do trong chế độ chỉnh sửa.' : 'Cannot place here — try another spot or enable free placement in Edit mode.');
        if (placed === undefined) api.addObject(kind);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    addObject: (kind) => {
      const w = worldRef.current;
      const spot = w ? w.freeSpot(kind) : { pos: [0.5, 0, 0.5] as [number, number, number], rotY: 0 };
      ops.addObject({ id: uid('o'), kind, pos: spot.pos, rotY: spot.rotY, quat: undefined, scale: 1 });
      if (!useSpace.getState().layout.room.visible && !w) say(vi ? `Đã thêm ${CATALOG_BY_ID[kind]?.name ?? 'vật'} lên trên hình nền.` : `Added ${CATALOG_BY_ID[kind]?.nameEn ?? 'object'} onto your background.`);
    },
    openPanel: (p) => { if (p === 'music') router.push('/music'); else setPanel(p); },
    openAppearance: () => setPanel('appearance'),
    saveLayout: async () => {
      if(!await persist('NONE'))return;
      if (space) await studySpaceApi.createSnapshot(space.id, vi ? `Bản lưu ${new Date().toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : `Snapshot ${new Date().toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`, useSpace.getState().layout).catch(() => undefined);
      say(vi ? 'Đã lưu bố cục.' : 'Layout saved.');
    },
    saveDefault: async () => {
      if (!space) return;
      if (space.hasDefault && !window.confirm(vi ? 'Thay mặc định của bạn bằng bố cục hiện tại? Mặc định cũ vẫn được giữ trong “Phiên bản trước”.' : 'Replace your default with the current layout? Your previous default stays in Version History.')) return;
      const l = useSpace.getState().layout;
      const saved = await studySpaceApi.saveDefault(space.id, withoutLife(l));
      setSpace({ ...space, hasDefault: true, defaultLayout: saved.defaultLayout, revision: saved.revision });
      void refreshList();
      say(hasWorld(l) || l.widgets.some((w) => !w.hidden) ? (vi ? 'Đã lưu làm mặc định của bạn.' : 'Saved as your default layout.') : (vi ? 'Đã lưu khung cảnh trống làm mặc định của bạn.' : 'Saved blank view as your default.'));
    },
    restoreDefault: async () => {
      if (!space) return;
      if (!space.hasDefault) {
        say(vi ? 'Bạn chưa lưu mặc định riêng. Hãy sắp xếp rồi chọn “Lưu làm mặc định của tôi”, hoặc chọn một mẫu phòng trong “Không gian”.' : 'You have not saved a custom default yet. Arrange your room and choose “Save as my default”, or pick a template in “Space”.');
        setSection('space');
        return;
      }
      const fresh = await studySpaceApi.get(space.id);
      // The arrangement comes back. How clean the room is does not go back with it: that was not part of what was saved.
      loadLayout({ ...readLayout(fresh.defaultLayout), appearance: useSpace.getState().layout.appearance, life: useSpace.getState().layout.life });
      await persist('RESTORE');
      setWorldFailed(false);
      worldRef.current?.applyCamera(useSpace.getState().layout.camera);
      say(vi ? 'Đã trở về bố cục mặc định của bạn.' : 'Restored your default layout.');
    },
    askResetRoom: requestResetRoom,
    askClear: () => setClearAsk(true),
    clearAll: async () => {
      // What Hoàn tác brings back is what the server replaces: it has to be what was on the screen, the last few strokes of the broom included.
      worldRef.current?.life.save(true);
      if (useSpace.getState().version !== savedVersion.current) await persist('NONE');
      const before = useSpace.getState().layout, id = activeSpace.current?.id;
      loadLayout(emptyLayout(useSpace.getState().layout));
      useSpace.getState().select([]);
      useSpace.getState().setMode('use');
      // The server keeps what it replaces as a snapshot in the same transaction. Unsaved, nothing has happened: the room comes back.
      if (!await persist('CLEAR') || !id) {
        loadLayout(before);
        say(vi ? 'Chưa xóa được vì chưa lưu được lên máy chủ. Căn phòng của bạn vẫn nguyên vẹn.' : 'Could not clear because the server save failed. Your room is unchanged.');
        return;
      }
      const kept = await studySpaceApi.snapshots(id).catch(() => []);
      const snapshot = kept.find((x) => x.kind === 'BEFORE_CLEAR');
      if (snapshot) {
        const mark = { snapshotId: snapshot.id, spaceId: id };
        try { localStorage.setItem(clearMark(account, id), JSON.stringify(mark)); } catch { /* The version history still has it. */ }
        setClearUndo(mark);
        setUndoBar(true);
      }
      setBarOpen(false);
      setSection(null);
      say(vi ? 'Đưa chuột lên mép trên (hoặc nhấn Esc) để hiện lại công cụ.' : 'Move your pointer to the top edge (or press Esc) to bring back the toolbar.');
    },
    undoClear: async () => {
      if (!clearUndo || clearUndo.spaceId !== activeSpace.current?.id) return;
      setUndoBusy(true);
      try {
        const snap = await studySpaceApi.snapshot(clearUndo.spaceId, clearUndo.snapshotId);
        loadLayout({ ...readLayout(snap.layout), appearance: useSpace.getState().layout.appearance });
        setWorldFailed(false);
        if (!await persist('RESTORE')) return;
        worldRef.current?.applyCamera(useSpace.getState().layout.camera);
        try { localStorage.removeItem(clearMark(account, clearUndo.spaceId)); } catch { /* A leftover mark only offers a restore. */ }
        setClearUndo(null);
        setUndoBar(false);
        say(vi ? 'Đã khôi phục căn phòng của bạn.' : 'Restored your room.');
      } catch {
        say(vi ? 'Chưa khôi phục được. Bạn có thể thử lại trong “Khôi phục phiên bản trước”.' : 'Could not restore yet. Try again in “Restore previous version”.');
      } finally { setUndoBusy(false); }
    },
    canUndoClear: !!clearUndo && clearUndo.spaceId === space?.id,
    saveNamedRoom: async (name) => {
      if (!space) return false;
      const n = name.trim().slice(0, 40);
      try {
        await studySpaceApi.createSnapshot(space.id, `${NAMED_ROOM}${n}`, useSpace.getState().layout);
        say(vi ? `Đã lưu phòng “${n}”.` : `Saved room “${n}”.`);
        return true;
      } catch { say(vi ? 'Chưa lưu được phòng. Hãy thử lại.' : 'Could not save the room. Please try again.'); return false; }
    },
    openNamedRoom: async (id) => {
      if (!space) return;
      const snap = await studySpaceApi.snapshot(space.id, id);
      // The room comes back around the appearance in use; the room it replaces stays in the version history.
      loadLayout({ ...readLayout(snap.layout), appearance: useSpace.getState().layout.appearance });
      setWorldFailed(false);
      await persist('RESTORE');
      worldRef.current?.applyCamera(useSpace.getState().layout.camera);
      say(vi ? 'Đã mở phòng đã lưu.' : 'Opened saved room.');
    },
    removeNamedRoom: async (id) => {
      if (space) await studySpaceApi.removeSnapshot(space.id, id).catch(() => say(vi ? 'Chưa xóa được phòng đã lưu.' : 'Could not remove saved room.'));
    },
    applyTemplate: async (t) => {
      loadLayout({ ...templateLayout(t), appearance: useSpace.getState().layout.appearance });
      setWorldFailed(false);
      await persist('TEMPLATE');
      worldRef.current?.applyCamera(useSpace.getState().layout.camera);
      say(vi ? `Đã dùng mẫu ${THEME_LABEL[t]}.` : `Applied ${t[0].toUpperCase() + t.slice(1)} template.`);
    },
    snapshots: async () => (space ? studySpaceApi.snapshots(space.id) : []),
    restoreSnapshot: async (id) => {
      if (!space) return;
      const snap = await studySpaceApi.snapshot(space.id, id);
      loadLayout(readLayout(snap.layout));
      setWorldFailed(false);
      await persist('RESTORE');
      worldRef.current?.applyCamera(useSpace.getState().layout.camera);
      say(vi ? 'Đã khôi phục phiên bản trước.' : 'Restored previous version.');
    },
    spaces,
    activeSpaceId: space?.id ?? null,
    hasDefault: !!space?.hasDefault,
    switchSpace: async (id) => {
      if(!await persist('NONE'))return;
      const rec = await studySpaceApi.activate(id);
      adopt(rec);
      worldRef.current?.applyCamera(useSpace.getState().layout.camera);
      void refreshList();
    },
    createSpace: async (name, from) => {
      await persist('NONE');
      const rec = from === 'copy' && space
        ? await studySpaceApi.create(name, null, space.id)
        : await studySpaceApi.create(name, from === 'empty' || from === 'copy' ? emptyLayout() : templateLayout(from));
      adopt(rec);
      void refreshList();
      say(vi ? `Đã tạo “${rec.name}”.` : `Created “${rec.name}”.`);
    },
    renameSpace: async (id, name) => { await studySpaceApi.rename(id, name); void refreshList(); },
    deleteSpace: async (id) => {
      await studySpaceApi.remove(id);
      const list = await refreshList();
      if (id === space?.id && list.active) adopt(list.active);
    },
    resetCamera: () => worldRef.current?.resetCamera(),
    exit: () => { void leaveTo('/dashboard'); },
    world3d,
  };
  useEffect(() => { saveLayoutRef.current = api.saveLayout; });

  // ── First entry: choose a start ─────────────────────────────────────────────────────────────────────────
  const start = async (t: RoomTheme) => {
    setPhase('loading');
    try {
      const rec = await studySpaceApi.create(vi ? 'Không gian của tôi' : 'My Study Space', templateLayout(t));
      adopt(rec);
      await refreshList();
      setPhase('ready');
    } catch { setPhase('error'); }
  };

  const panelEl = useMemo(() => {
    const close = () => setPanel(null);
    switch (panel) {
      case 'appearance': return <AppearancePanel onClose={close} />;
      case 'focus': return <FocusPanel onClose={close} portable={!device} />;
      case 'planner': return <PlannerPanel onClose={close} />;
      case 'notebook': return <NotebookPanel onClose={close} />;
      case 'research': return <ResearchPanel onClose={close} />;
      case 'ambient': return <AmbientPanel onClose={close} />;
      case 'character':
        return (
          <CharacterPanel
            onClose={close}
            lifeEnabled={lifeEnabled}
            onOpenCreatorStudio={
              lifeEnabled
                ? () => {
                    setPanel(null);
                    if (worldRef.current && !worldRef.current.exploration.active) {
                      worldRef.current.setView('third');
                    }
                    handleActiveStudioChange('creator');
                  }
                : undefined
            }
            onActivity={(activity) => useSpace.getState().apply((l) => ({ ...l, character: { ...l.character, activity } }), 'char-activity')}
          />
        );
      default: return null;
    }
  }, [panel, device, lifeEnabled, handleActiveStudioChange]);

  return (
    <div className={s.space} data-spatial-owner="study-space" data-morph="off" data-testid="study-space" data-mode={mode} data-empty={!world3d && !layout.widgets.some((w) => !w.hidden) ? 'true' : 'false'}>
      {!ownBackground && <div className={s.sky} aria-hidden="true" />}
      {world3d && (
        <div
          data-testid="study-canvas-stage"
          data-photo-filter={photoMode ? photoFilterCss : 'none'}
          style={{ position: 'absolute', inset: 0, zIndex: 1 }}
        >
          <canvas
            ref={canvasRef}
            className={s.canvas}
            style={photoMode && photoFilterCss !== 'none' ? { filter: photoFilterCss } : undefined}
            aria-label={vi ? 'Căn phòng 3D. WASD di chuyển, phím mũi tên nhìn, E tương tác, Esc thả chuột.' : '3D room. WASD move, arrow keys look, E interact, Escape releases mouse.'}
            data-testid="study-canvas"
            tabIndex={0}
          />
        </div>
      )}
      {phase === 'ready' && (exploration.view === 'overview' || !world3d) && <WidgetLayer onOpen={(p) => api.openPanel(p)} />}
      {panel === 'library' && <LibraryPanel books={library} onClose={() => setPanel(null)} onRefresh={refreshLibrary} onImport={() => { try { localStorage.setItem('readingActiveTab', 'mybooks'); } catch { /* opens on the library */ } setPanel('module:/reading'); }}
        onTake={book => { const shelf = libraryShelf.current; setPanel(null); if (shelf) worldRef.current?.manip.takeBook(shelf, book); }} />}
      {dictionaryMounted && !device && <GlobalDictionarySearch customTrigger={open => { dictionaryOpen.current = open; if (dictionaryWanted.current) { dictionaryWanted.current = false; window.setTimeout(open, 0); } return null; }} />}
      {interaction?.book && <BookHud controls={worldRef.current!.manip} info={interaction.book} account={accountRef.current} onOpenModule={href => setPanel(`module:${href}`)} />}
      {panel?.startsWith('module:') && <RoomWindow href={panel.slice(7)} onClose={() => setPanel(null)} onOutside={href => { setPanel(null); void leaveTo(href); }} />}
      {caption && world3d && !barOpen && <div style={{ position: 'absolute', inset: 0, zIndex: 11, pointerEvents: 'none' }}><StoryCaption key={caption.id} line={caption} vi={vi} words={layout.life?.settings.words !== false} onGone={() => { captionRef.current = false; setCaption(null); }} /></div>}
      {panel === 'messenger' && <RoomWindow messenger conversation={chat} onEnterArena={code => joinArenaRef.current(code)} onClose={() => setPanel(null)} onOutside={href => setPanel(`module:${href}`)} />}
      {device && <EchoDesk rect={device.rect} name={layout.objects.find(o => o.id === device.id)?.kind === 'monitor' ? (vi ? 'máy tính' : 'computer') : 'laptop'} initialAction={layout.objects.find(o => o.id === device.id)?.action} request={deskRequest} onLeave={leaveDevice} onPanel={setPanel}>{panelEl}</EchoDesk>}
      {world3d && mode !== 'edit' && space && (
        <StudyCompanion
          spaceId={space.id}
          vi={vi}
          visible={!awayFromStudy && !panel && !lifeBlocked && !barOpen && !pinned && !device && !wheelOpen && !photoMode}
          locked={exploration.locked}
          seated={!!exploration.seated}
          atDeskAnchor={Boolean(layout.character.anchor && layout.objects.some((o) => o.id === layout.character.anchor && (o.kind.startsWith('chair.') || o.kind.startsWith('desk.'))))}
          lampLit={layout.objects.some((o) => !o.hidden && o.kind.startsWith('lamp.') && o.lightOn !== false)}
          windowFresh={Boolean(layout.room.windowOpen || (layout.room.curtains ?? 0) < 0.25)}
          careActivityCount={layout.life?.log?.length ?? 0}
          engagedLearning={Boolean(interaction?.book || device || panel === 'library' || panel?.startsWith('module:'))}
          onGoDesk={() => changeView('desk')}
          onOpenFocus={() => setFocusFloat(true)}
          onOpenReading={() => setPanel('module:/reading')}
          onOpenFlashcards={() => setPanel('module:/flashcards')}
          onEnterArena={() => travel('arena')}
          onOpenHelp={() => setHelpTick((t) => t + 1)}
          reducedMotion={!!reduced}
        />
      )}
      {world3d && mode !== 'edit' && !panel && !barOpen && !pinned && !device && !lifeBlocked && !photoMode && !(lifeEnabled && wheelOpen) && <ExplorerControls vi={vi} lifeEnabled={lifeEnabled} state={exploration} interaction={interaction} hud={hud} helpTick={helpTick} quickOpen={quickOpen} onQuick={setQuickOpen} onVerb={(verb) => { setQuickOpen(false); worldRef.current?.manip.perform(verb); canvasRef.current?.focus({ preventScroll: true }); }} onCancel={() => worldRef.current?.cancelJourney()} onWardrobe={() => setPanel('character')} busy={travelling} focusOpen={focusFloat} heldKind={interaction?.held[0] ? layout.objects.find(o => o.id === interaction.held[0])?.kind ?? null : null} onRetryPhysics={() => worldRef.current?.manip.retryPhysics()}
        suppressStandPrompt={Boolean(lifeEnabled && seatedInEchoLife)} onBottomDockChange={setBottomDockOpen}
        wheelOpen={lifeEnabled ? false : wheelOpen} onWheelOpen={openWheel} motions={wheelMotions} onMotion={name=>{worldRef.current?.performMotion(name);}}
        onWheelChoose={run=>{wheelCommand.current=run;setWheelOpen(false);}}
        onKit={hasKit(layout.objects) || !layout.room.visible ? undefined : () => { useSpace.getState().apply(l => ({ ...l, objects: [...l.objects, ...kitObjects(l.objects, l.room.size, () => uid('o'))] })); say(vi ? 'Bộ đồ dọn dẹp đã ở trong phòng.' : 'The cleaning things are in the room.'); }}
        onFocus={() => setFocusFloat((v) => !v)} onStand={() => { worldRef.current?.standUp(); canvasRef.current?.focus({ preventScroll: true }); }}
        target={exploration.target?.startsWith('portal:') ? (exploration.target === 'portal:arena' ? 'Speaking Arena' : vi ? 'Thư viện trò chơi' : 'Games Hub') : exploration.target === 'window:main' ? (vi ? 'Cửa sổ' : 'Window') : exploration.target === 'curtain:main' ? (vi ? 'Rèm cửa' : 'Curtain') : exploration.target?.startsWith('drawer:') ? (vi ? 'Ngăn kéo' : 'Drawer') : (() => { const o = layout.objects.find(o => o.id === exploration.target); const it = o && CATALOG_BY_ID[o.kind]; return it ? (vi ? it.name : it.nameEn) : null; })()}
        onAction={action=>{void worldRef.current?.performAction(action);canvasRef.current?.focus({preventScroll:true});}} onView={changeView} onLock={() => worldRef.current?.exploration.toggleLook()} onInteract={() => worldRef.current?.exploration.interact()}
        onOpenHeld={(() => { const o = layout.objects.find(x => x.id === interaction?.held[0]); const it = o && CATALOG_BY_ID[o.kind]; return o && (o.action ?? it?.action) ? () => { worldRef.current?.settlePhysics(); activate(o.id); } : undefined; })()}
        onMove={(x,y,id) => worldRef.current?.exploration.touchMove(x,y,id)} onPanel={setPanel} onTravel={travel} onTool={href => void leaveTo(href)} />}
      {world3d && lifeEnabled && wheelOpen && exploration.view !== 'overview' && (
        <ActionWheel
          open={wheelOpen}
          onOpen={openWheel}
          actions={[]}
          binding={loadKeymap().actions}
          vi={false}
          lifeEnabled={true}
          lifeActions={lifeRadialActions}
          onLifeAction={handleLifeRadialAction}
          onQuickChat={handleQuickChat}
          onChoose={run => {
            wheelCommand.current = run;
            setWheelOpen(false);
          }}
        />
      )}
      {world3d && mode !== 'edit' && !panel && (exploration.view !== 'overview' || activeStudio !== null) && (
        <EchoLifeHud store={hudStore} target={effectiveGameTarget}
          setTarget={t => { setGameTarget(t); if (!t) canvasRef.current?.focus({ preventScroll: true }); }}
          panel={lifePanel} setPanel={p => { setLifePanel(p); if (!p) canvasRef.current?.focus({ preventScroll: true }); }}
          locked={exploration.locked} vi={vi} captionVisible={!!caption && !barOpen} captionAvailable={!caption && !barOpen && !device && !wheelOpen}
          onTutorialCaption={tutorialCaption} onClearTutorialCaption={clearTutorialCaption}
          bottomDockOpen={Boolean(bottomDockOpen && !barOpen && !pinned && !device && !lifeBlocked && !photoMode && !(lifeEnabled && wheelOpen))}
          suppressSeatedStandPrompt={false}
          qualityTier={qualityTier} onQualityTier={selectQualityTier}
          getPerfTelemetry={getPerfTelemetry} photoMode={photoMode} onPhotoModeChange={setPhotoMode}
          onCapturePhoto={capturePhoto}
          activeStudio={activeStudio}
          onActiveStudioChange={handleActiveStudioChange}
          phoneInitialApp={phoneInitialApp}
          creatorProfile={creatorProfile}
          onPreviewAvatar={handlePreviewAvatar}
          onSaveAvatar={handleSaveAvatar}
          onCreatorModeChange={handleCreatorModeChange}
          onBuildCameraChange={handleBuildCameraChange}
          onPhotoStudioModeChange={handlePhotoStudioModeChange}
          onCapturePhotoDataUrl={capturePhotoDataUrl}
          getPeerQuickChats={getPeerQuickChats}
          onRequestResetRoom={requestResetRoom}
          onLeaveBasketball={() => { worldRef.current?.game.leaveBasketballCourt(); canvasRef.current?.focus({ preventScroll: true }); }}
          exploring={exploration.view !== 'overview'} />
      )}
      <SharedStudy key={account} vi={vi} open={panel==='shared'} onClose={()=>setPanel(null)} onInvite={()=>setPanel('shared')}
        world3d={world3d} cityRoom={sharedCityRoom} cityConnection={cityConnection} onCityRoom={setSharedCityRoom}/>
      {phase === 'ready' && <FocusFloat open={focusFloat && !lifeBlocked} onClose={() => setFocusFloat(false)} onExpand={() => { setFocusFloat(false); setPanel('focus'); }} />}
      {mode === 'edit' && phase === 'ready' && <div className={s.editBadge}>{vi ? 'Đang chỉnh sửa · kéo vật để dời · R xoay · Delete bỏ · Ctrl+Z hoàn tác' : 'Editing · drag to move · R rotate · Delete remove · Ctrl+Z undo'}</div>}
      {mode === 'edit' && <Inspector onCharacter={() => setPanel('character')} />}

      <div className={s.edgeZone} onPointerMove={openBar} onPointerLeave={scheduleClose} data-testid="study-edge" aria-hidden="true" />
      <TopReveal vi={vi} api={api} open={barOpen || pinned} pinned={pinned} onPin={() => setPinned(!pinned)} section={section} setSection={(x) => { setSection(x); openBar(); }}
        onKeep={(k) => { keep.current = k; if (k) openBar(); else scheduleClose(); }} />

      {lifeEnabled && (phase === 'loading' || (world3d && !bootState.done)) && (
        <EchoLifeLoadingOverlay
          progress={phase === 'loading' ? Math.min(14, bootState.pct) : bootState.pct}
          stageId={phase === 'loading' ? 'preparing' : bootState.stageId}
          stage={phase === 'loading' ? BOOT_STAGE_LABELS_VI.preparing : bootState.stage}
          detailVi={phase === 'loading' ? null : bootState.detailVi}
          slowNoticeVi={phase === 'loading' ? null : bootState.slowNoticeVi}
          slowState={phase !== 'loading' && bootState.slowState}
          transitionMode={bootState.transitionMode}
          errorVi={bootState.errorVi}
          quality={qualityTier}
          onLowSpec={() => selectQualityTier('low')}
          onContinueWaiting={() => bootOrchestratorRef.current?.continueWaiting()}
          onEnterNow={() => bootOrchestratorRef.current?.enterAnyway()}
          onRetry={() => {
            setWorldFailed(false);
            setBootState(INITIAL_BOOT_STATE);
            setBootRetryTick((n) => n + 1);
          }}
          onBackToDashboard={() => router.push('/?tab=dashboard')}
        />
      )}
      {!lifeEnabled && phase === 'loading' && <div className={s.loading}><div className={`${s.loadingCard} ${s.glass}`}><Loader2 className="animate-spin" size={18} /> {vi ? 'Đang mở không gian của bạn…' : 'Opening your study space…'}</div></div>}
      {phase === 'error' && (
        <div className={s.loading} style={{ pointerEvents: 'auto' }}>
          <div className={`${s.loadingCard} ${s.glass}`} style={{ flexDirection: 'column' }}>
            {vi ? 'Chưa mở được không gian học tập.' : 'Could not open your study space.'}
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className={s.btn} onClick={() => location.reload()}>{vi ? 'Thử lại' : 'Retry'}</button>
              <button type="button" className={s.btn} onClick={() => router.push('/?tab=dashboard')}>{vi ? 'Quay lại English Coach' : 'Back to English Coach'}</button>
            </div>
          </div>
        </div>
      )}
      {phase === 'choose' && (
        <div className={s.chooser}>
          <div className={`${s.glass}`} style={{ padding: 24, width: 'min(1100px, 100%)' }}>
            <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>{vi ? 'Không gian học tập' : 'Echo Life · Study Space'}</h1>
            <p className={s.hint} style={{ fontSize: 14, margin: '6px 0 16px' }}>
              {vi ? 'Chọn một khởi đầu. Mọi thứ sau đó là của bạn: dời, thêm, đổi hay xóa — kể cả xóa hết để chỉ ngắm hình nền.' : 'Choose a starting room. Everything can be rearranged, customized, or expanded anytime.'}
            </p>
            <div className={s.chooserGrid}>
              {([['ocean', 'linear-gradient(135deg,#9fb4ee,#7c8cf0 55%,#5b7be0)', 'Ocean Breeze', 'Phòng nhìn ra biển xanh, Echo bơi quanh.', 'Bright coastal room overlooking the bay with Echo swimming outside.'],
                ['rain', 'linear-gradient(135deg,#e8d9c8,#9a6a46 55%,#2c3561)', 'Rainy Wood', 'Góc gỗ ấm, mưa đêm ngoài cửa sổ.', 'Warm timber study corner with gentle evening rain outside.'],
                ['library', 'linear-gradient(135deg,#d9cdea,#8e78d4 55%,#c9a046)', 'Sunset Library', 'Kệ sách cao, ánh đèn vàng, bầu trời hoàng hôn.', 'Tall bookshelves, warm desk lamps, and golden sunset skies.'],
                ['station', 'linear-gradient(135deg,#dfe3f3,#7dd3fc 55%,#25283d)', 'Starlight Station', 'Bàn học tương lai giữa các vì sao.', 'Sleek minimalist study deck under clear starlight.'],
                ['plain', 'linear-gradient(135deg,#f4f2fb,#e9e5f7)', 'Blank Canvas', 'Không có gì: chỉ hình nền của bạn. Tự xây từ đầu.', 'A clean starting canvas—build your space from scratch.']] as const).map(([t, bg, enLabel, dVi, dEn]) => (
                <button key={t} type="button" className={s.choice} onClick={() => void start(t)} data-testid={`start-${t}`}>
                  <span className={s.choiceSwatch} style={{ background: bg }} />
                  <b style={{ fontSize: 16 }}>{vi ? THEME_LABEL[t] : enLabel}</b>
                  <span className={s.hint}>{vi ? dVi : dEn}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {worldFailed && hasWorld(layout) && barOpen && (
        <div className={`${s.toast} ${s.glass}`} style={{ bottom: 80 }}>{vi ? 'Đồ họa 3D đang tắt.' : '3D graphics are paused.'} <button type="button" className={s.btn} onClick={() => setWorldFailed(false)}>{vi ? 'Thử lại 3D' : 'Retry 3D'}</button></div>
      )}
      {drag && <img className={s.dragGhost} src={drag.src ?? echoSrc('official', 64)} alt="" style={{ left: drag.x, top: drag.y, opacity: 0.35 }} />}
      {!device && panelEl}
      {clearAsk && <ClearDialog suggestedName={space?.name ?? (vi ? 'Căn phòng của tôi' : 'My Study Room')} onCancel={() => setClearAsk(false)} onClear={async (saveAs) => {
        if (saveAs && !await api.saveNamedRoom(saveAs)) return;
        await api.clearAll();
        setClearAsk(false);
      }} />}
      {resetRoomAsk && (
        <ResetRoomDialog
          vi={vi}
          onCancel={() => {
            setResetRoomAsk(false);
            if (worldRef.current?.exploration.active) {
              canvasRef.current?.focus({ preventScroll: true });
            }
          }}
          onConfirm={executeResetRoom}
        />
      )}
      {undoBar && clearUndo && <UndoClearBar busy={undoBusy} onUndo={() => void api.undoClear()} onDismiss={() => setUndoBar(false)} />}
      {toast && <div className={`${s.toast} ${s.glass}`} role="status">{toast}</div>}
    </div>
  );
}
