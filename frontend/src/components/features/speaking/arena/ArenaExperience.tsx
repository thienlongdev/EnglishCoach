'use client';
import { useAccount } from '@/components/study-space/data';
import { useAvatarIdentity, writeIdentity } from '@/lib/avatar/identity';
import { encodeLook, normalizeLook } from '@/lib/avatar/look';
import { activeStudyCharacter } from '@/lib/study-space/api';
import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Users,
  Headphones,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Copy,
  Check,
  Flag,
  Hand,
  Settings2,
  X,
  ChevronDown,
  Radio,
  LogOut,
  Trophy,
  CircleHelp,
  Compass,
  BookOpen,
  Camera,
  Eye,
  Sun,
  Sunset,
} from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useArenaRoom } from './useArenaRoom';
import { useArenaVoice } from './useArenaVoice';
import { useArenaMicCheck } from './useArenaMicCheck';
import { getArenaConfig } from '@/services/speakingArenaApi';
import { arenaLayout } from './arenaTerrain';
import { arenaArtifacts, arenaError, arenaLookouts, arenaModes, arenaPrompts } from './arenaCopy';
import type {
  ArenaPhotoState,
  ArenaQualityTier,
  ArenaTimeOfDay,
  FishingHudState,
  FruitHarvestLog,
  MarineCollectionState,
  MinimapSnapshot,
  MinimapWaypoint,
} from './arenaContracts';
import {
  ARENA_QUALITY_CONFIGS,
  loadSavedArenaQuality,
  loadSavedArenaTimeOfDay,
  saveArenaQuality,
  saveArenaTimeOfDay,
} from './arenaQuality';
import { createEmptyMarineCollection, loadMarineLogbook } from './arenaFishing';
import { createEmptyFruitHarvestLog, loadFruitHarvestLog } from './arenaFruitTrees';
import type { ArenaConfig, ArenaMode, ArenaAudioSpace } from '@/types/speakingArena';
import type { ActiveWorldInspect, FishingControlBridge, PhotoControlBridge } from './ArenaScene';
import ActionWheel from '@/components/study-space/ActionWheel';
import pearl from '@/components/ui/pearl/pearlGlass.module.css';
import ArenaInvitations from './ArenaInvitations';
import ArenaMinimap from './ArenaMinimap';
import ArenaSpeakingStationModal from './ArenaSpeakingStationModal';
import ArenaFishingHud from './ArenaFishingHud';
import ArenaCollectionDrawer from './ArenaCollectionDrawer';
import ArenaPhotoStudio, { DEFAULT_ARENA_PHOTO_STATE } from './ArenaPhotoStudio';
import styles from './arena.module.css';
import { embodiedLabels, type EmbodiedAction } from '@/lib/embodiment/actions';
import type { ArenaView } from './ArenaCamera';
import { useStudyReturn } from '@/components/study-space/StudyReturn';
import { markWorldPassage } from '@/lib/morph/scene';
import { journeyGo } from '@/lib/journey/journey';
import { useCurrentUserProfile } from '@/hooks/useCurrentUserProfile';
import { useEdgeReveal } from '@/lib/hud/edgeReveal';
import { useSharedKeys } from '@/lib/hud/sharedKeys';
import hudStyles from '@/lib/hud/edge.module.css';

const Scene = dynamic(() => import('./ArenaScene'), { ssr: false });
const PersonCard = dynamic(() => import('@/components/messenger/PersonCard'), { ssr: false });
const RoomWindow = dynamic(() => import('@/components/study-space/desk/RoomWindow'), { ssr: false });
const phases = {
  LOBBY: ['Phòng chờ', 'Lobby'],
  PREPARE: ['Chuẩn bị', 'Prepare'],
  TALK: ['Lượt nói', 'Speaking turn'],
  REVIEW: ['Cùng nhận xét', 'Human review'],
  FREE: ['Trò chuyện tự do', 'Free conversation'],
  FINISHED: ['Kết quả', 'Results'],
};
const QUALITY_ORDER: readonly ArenaQualityTier[] = ['ultra', 'high', 'balanced', 'low'];
const VISITED_STATIONS_PREFIX = 'ec_arena_visited_stations:v1:';

export default function ArenaExperience() {
  const overlayRoot = useRef<HTMLDivElement>(null);
  const studyReturnHref = useStudyReturn();
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const room = useArenaRoom();
  const s = room.state;
  const [config, setConfig] = useState<ArenaConfig | null>(null);
  const [configError, setConfigError] = useState(false);
  const [configTry, setConfigTry] = useState(0);
  const account = useAccount();
  const identity = useAvatarIdentity(account, activeStudyCharacter);
  const hero = identity.hero;
  const lookCode = encodeLook(normalizeLook(hero, identity.look));
  const setHero = (next: 'LYRA' | 'KAI') => {
    if (account) writeIdentity(account, { hero: next, look: normalizeLook(next, identity.look), at: Date.now() });
  };

  const [mode, setMode] = useState<ArenaMode>('DUEL');
  const [nickname, setNickname] = useState('');
  const [code, setCode] = useState('');
  const [action, setAction] = useState<{ id: number; kind: EmbodiedAction } | null>(null);
  const nextGesture = useRef(0);
  const express = (kind: EmbodiedAction) => {
    if (kind === 'jump') {
      setAction(previous => ({ id: (previous?.id ?? 0) + 1, kind }));
      return;
    }
    if (performance.now() < nextGesture.current) return;
    if (s && ['wave', 'cheer', 'listen', 'clap', 'dance'].includes(kind) && !room.send(kind)) return;
    nextGesture.current = performance.now() + 2700;
    setAction(previous => ({ id: (previous?.id ?? 0) + 1, kind }));
  };

  const [view, setView] = useState<ArenaView>('third');
  const [gestures, setGestures] = useState(false);
  const [help, setHelp] = useState(false);
  const [helpTick, setHelpTick] = useState(0);
  const toggleHelp = () => {
    setHelp(v => {
      const next = !v;
      if (next) setHelpTick(n => n + 1);
      return next;
    });
    setGestures(false);
  };
  const [qualityTier, setQualityTier] = useState<ArenaQualityTier>('high');
  const [timeOfDay, setTimeOfDay] = useState<ArenaTimeOfDay>('daylight');
  const low = qualityTier === 'low';
  const [settings, setSettings] = useState(false);
  const [roster, setRoster] = useState(false);
  const [explore, setExplore] = useState(false);
  const [copied, setCopied] = useState(false);
  const [prompt, setPrompt] = useState(0);
  const [speaker, setSpeaker] = useState('');
  const [points, setPoints] = useState(1);
  const [reason, setReason] = useState('RESPONSE');
  const [stats, setStats] = useState({ fps: 0, draws: 0, triangles: 0 });
  const [clock, setClock] = useState(Date.now());
  const [confirmKick, setConfirmKick] = useState<string | null>(null);
  const [localInspect, setLocalInspect] = useState<ActiveWorldInspect | null>(null);
  const [artifactSpin, setArtifactSpin] = useState(0);
  const [studyItem, setStudyItem] = useState(false);
  const [placeTable, setPlaceTable] = useState<string | null>(null);

  // Echo Archipelago v7/Wave 9 HUD, Minimap, Fishing, Photo Studio, Fruit Harvest, and Collection Logbook state
  const minimapRef = useRef<MinimapSnapshot | null>(null);
  const fishingHudRef = useRef<FishingHudState | null>(null);
  const fishingControlRef = useRef<FishingControlBridge | null>(null);
  const photoControlRef = useRef<PhotoControlBridge | null>(null);
  const [fishingHud, setFishingHud] = useState<FishingHudState | null>(null);
  const [photoState, setPhotoState] = useState<ArenaPhotoState>(DEFAULT_ARENA_PHOTO_STATE);
  const [waypoint, setWaypoint] = useState<MinimapWaypoint | null>(null);
  const [worldMapOpen, setWorldMapOpen] = useState(false);
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [collectionTab, setCollectionTab] = useState<'marine' | 'fruits'>('marine');
  const [collectionSpeciesId, setCollectionSpeciesId] = useState<string | null>(null);
  const [marineCollection, setMarineCollection] = useState<MarineCollectionState>(createEmptyMarineCollection);
  const [fruitHarvest, setFruitHarvest] = useState<FruitHarvestLog>(createEmptyFruitHarvestLog);
  const [fruitToast, setFruitToast] = useState<{ en: string; vi: string } | null>(null);
  const fruitToastTimer = useRef<number | null>(null);
  const [visitedStationIds, setVisitedStationIds] = useState<Set<string>>(() => new Set());
  const queuedRoundStartRef = useRef<{ target: string; prompt: number } | null>(null);

  useEffect(() => {
    if (!room.pending && queuedRoundStartRef.current && s) {
      const nextRound = queuedRoundStartRef.current;
      queuedRoundStartRef.current = null;
      room.send('round', nextRound);
    }
  }, [room, room.pending, s]);

  const space = useRef<ArenaAudioSpace>({ listener: { x: 0, z: 0, yaw: Math.PI }, players: new Map() });
  const joystick = useRef({ x: 0, y: 0 });
  const receipt = useRef({ server: 0, local: 0 });
  const [environmentVolume, setEnvironmentVolume] = useState(0.35);
  const [diagnosticsEnabled, setDiagnosticsEnabled] = useState(false);
  const qualityChoice = useRef(false);
  const slowSamples = useRef(0);

  const selectQualityTier = useCallback((tier: ArenaQualityTier, userInitiated: boolean) => {
    if (userInitiated) {
      qualityChoice.current = true;
      saveArenaQuality(tier);
    }
    setQualityTier(tier);
  }, []);

  const toggleTimeOfDay = useCallback(() => {
    setTimeOfDay(prev => {
      const next: ArenaTimeOfDay = prev === 'daylight' ? 'sunset' : 'daylight';
      saveArenaTimeOfDay(next);
      return next;
    });
  }, []);

  const measuredStats = (value: { fps: number; draws: number; triangles: number }) => {
    setStats(value);
    if (!s && document.hasFocus() && !qualityChoice.current && qualityTier !== 'low') {
      slowSamples.current = value.fps < 28 ? slowSamples.current + 1 : 0;
      if (slowSamples.current >= 2) setQualityTier('low');
    }
  };

  useEffect(() => {
    const savedQuality = loadSavedArenaQuality();
    if (savedQuality) {
      qualityChoice.current = true;
      setQualityTier(savedQuality);
    } else if (matchMedia('(max-width:760px), (pointer:coarse)').matches) {
      setQualityTier('low');
    }
    setTimeOfDay(loadSavedArenaTimeOfDay());
  }, []);

  useEffect(() => {
    setMarineCollection(loadMarineLogbook(account));
    setFruitHarvest(loadFruitHarvestLog(account));
    if (typeof window !== 'undefined') {
      try {
        const key = `${VISITED_STATIONS_PREFIX}${account || 'guest'}`;
        const raw = window.localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) setVisitedStationIds(new Set(parsed.filter(v => typeof v === 'string')));
        } else {
          setVisitedStationIds(new Set());
        }
      } catch {
        setVisitedStationIds(new Set());
      }
    }
  }, [account]);

  const markStationVisited = useCallback(
    (stationId: string) => {
      setVisitedStationIds(prev => {
        if (prev.has(stationId)) return prev;
        const next = new Set(prev);
        next.add(stationId);
        try {
          window.localStorage.setItem(`${VISITED_STATIONS_PREFIX}${account || 'guest'}`, JSON.stringify([...next]));
        } catch {
          // Ignore quota errors
        }
        return next;
      });
    },
    [account],
  );

  useEffect(() => {
    setDiagnosticsEnabled(
      ['localhost', '127.0.0.1', 'arena-a.localhost'].includes(location.hostname) &&
        new URLSearchParams(location.search).has('arenaDiagnostics'),
    );
  }, []);

  useEffect(() => {
    return () => {
      if (fruitToastTimer.current !== null) window.clearTimeout(fruitToastTimer.current);
    };
  }, []);

  const kickDialog = useRef<HTMLDialogElement>(null);
  if (s && s.serverTime !== receipt.current.server) receipt.current = { server: s.serverTime, local: Date.now() };
  const voice = useArenaVoice(s, room.connected, space, diagnosticsEnabled, room.motion);
  const me = s?.players.find(p => p.id === s.self);
  const host = s?.host === s?.self && !!s;
  const held = me?.artifact && arenaLayout.interactables.find(i => i.id === me.artifact);
  const activeInspect: ActiveWorldInspect | null = held
    ? { kind: 'artifact', id: held.id, x: held.x, z: held.z }
    : localInspect;

  function setActiveInspect(item: ActiveWorldInspect | null) {
    if (s && item?.kind === 'artifact') {
      room.send('take-item', { item: item.id });
      return;
    }
    if (!item && activeInspect?.kind === 'artifact') {
      placeHeld();
      return;
    }
    if (s && (item?.kind === 'telescope' || activeInspect?.kind === 'telescope')) {
      room.send('observe', { item: item?.id });
    }
    if (item?.kind === 'kiosk') markStationVisited(item.id);
    setLocalInspect(item);
  }

  function placeHeld() {
    if (!placeTable) return;
    if (s && me?.artifact) room.send('put-item', { item: me.artifact, place: placeTable });
    else placeRequest.current?.(placeTable);
  }

  const placeRequest = useRef<((table: string) => void) | null>(null);
  useEffect(() => {
    setLocalInspect(null);
  }, [s?.roomId]);

  const micCheck = useArenaMicCheck();
  const canCheckMic = voice.status === 'off' || voice.status === 'failed' || voice.status === 'blocked';
  const [kioskAudioActive, setKioskAudioActive] = useState(false);
  const kioskAudioActiveRef = useRef(false);
  const priorVoiceMicRef = useRef(false);
  const voiceMicRef = useRef(voice.mic);
  voiceMicRef.current = voice.mic;

  const handleKioskRecordingChange = useCallback(
    (active: boolean) => {
      if (active === kioskAudioActiveRef.current) return;
      kioskAudioActiveRef.current = active;
      setKioskAudioActive(active);
      if (active) {
        priorVoiceMicRef.current = voiceMicRef.current;
        if (voiceMicRef.current) {
          voice.setMicEnabled(false);
        }
        voice.setRemoteDuck(true);
      } else {
        voice.setRemoteDuck(false);
        if (priorVoiceMicRef.current) {
          priorVoiceMicRef.current = false;
          voice.setMicEnabled(true);
        }
      }
    },
    [voice.setMicEnabled, voice.setRemoteDuck],
  );

  useEffect(() => {
    if (activeInspect?.kind !== 'kiosk' || photoState.open) {
      handleKioskRecordingChange(false);
    }
  }, [activeInspect?.kind, photoState.open, handleKioskRecordingChange]);

  useEffect(() => {
    return () => {
      handleKioskRecordingChange(false);
    };
  }, [handleKioskRecordingChange]);

  const speaking = s?.players.find(p => p.id === s.speaker);
  const remaining = s?.deadline
    ? Math.max(0, Math.ceil((s.deadline - receipt.current.server - (clock - receipt.current.local)) / 1000))
    : 0;
  const currentPrompt = arenaPrompts[s?.prompt ?? prompt];
  const busy = room.pending || !room.connected;

  useEffect(() => {
    const abort = new AbortController();
    setConfigError(false);
    void getArenaConfig(abort.signal)
      .then(setConfig)
      .catch(() => {
        if (!abort.signal.aborted) setConfigError(true);
      });
    return () => abort.abort();
  }, [configTry]);

  useEffect(() => {
    if (!s?.deadline) return;
    const id = setInterval(() => setClock(Date.now()), 500);
    return () => clearInterval(id);
  }, [s?.deadline]);

  useEffect(() => {
    if (confirmKick) kickDialog.current?.showModal();
    else kickDialog.current?.close();
  }, [confirmKick]);

  useEffect(() => {
    if (window.matchMedia('(max-width:760px)').matches) setRoster(false);
  }, []);

  useEffect(() => {
    if (!settings || !canCheckMic) micCheck.stop();
  }, [settings, canCheckMic, micCheck.stop]);

  useEffect(() => {
    if (s && !s.players.some(p => p.id === speaker)) setSpeaker(s.players[0]?.id ?? '');
  }, [s, speaker]);

  useEffect(() => {
    setArtifactSpin(0);
    setStudyItem(false);
  }, [activeInspect?.id]);

  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  const [capacity, setCapacity] = useState(8);
  const [publicPair, setPublicPair] = useState(false);
  const [inviting, setInviting] = useState(false);
  const seats = mode === 'DUEL' ? 2 : mode === 'TEAM' ? 4 : capacity;
  const enter = (act: 'create' | 'quick' | 'join') =>
    room.send(act, {
      mode,
      nickname: nickname.trim(),
      hero,
      look: lookCode,
      code: code.trim(),
      ...(act === 'create' ? { title: title.trim(), topic: topic.trim(), capacity: seats } : {}),
    });

  const { effectiveDisplayName, isLoading: nameLoading } = useCurrentUserProfile();
  const nameTouched = useRef(false);
  useEffect(() => {
    if (!nameTouched.current && effectiveDisplayName) {
      setNickname(effectiveDisplayName.replace(/[^\p{L}\p{M}\p{N} _.'-]+/gu, ' ').trim().slice(0, 24));
    }
  }, [effectiveDisplayName]);

  const [joinCode, setJoinCode] = useState<string | null>(null);
  useEffect(() => {
    const url = new URL(location.href);
    const join = url.searchParams.get('join');
    if (join) setJoinCode(join.toUpperCase());
    const onJoin = (e: Event) => {
      e.preventDefault();
      setJoinCode((e as CustomEvent<{ code: string }>).detail.code.toUpperCase());
    };
    window.addEventListener('ec:arena-join', onJoin);
    return () => window.removeEventListener('ec:arena-join', onJoin);
  }, []);

  useEffect(() => {
    if (!joinCode || !room.connected || room.pending || !config?.available || nameLoading) return;
    if (s) {
      if (s.code.replace('-', '') === joinCode.replace('-', '')) {
        setJoinCode(null);
        return;
      }
      return;
    }
    const name = (effectiveDisplayName || '')
      .replace(/[^\p{L}\p{M}\p{N} _.'-]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 24)
      .trim();
    setCode(joinCode);
    if (name.length < 2) {
      setJoinCode(null);
      return;
    }
    setNickname(name);
    if (room.send('join', { mode, nickname: name, hero, look: lookCode, code: joinCode })) setJoinCode(null);
  }, [joinCode, s?.code, room.connected, room.pending, config?.available, nameLoading, effectiveDisplayName]); // eslint-disable-line react-hooks/exhaustive-deps

  const [person, setPerson] = useState<number | null>(null);
  const [chat, setChat] = useState<{ id: string | null } | null>(null);
  useEffect(() => {
    const onOpen = (e: Event) => {
      e.preventDefault();
      setChat({ id: (e as CustomEvent<{ conversationId: string | null }>).detail.conversationId });
    };
    window.addEventListener('ec:messenger-open', onOpen);
    return () => window.removeEventListener('ec:messenger-open', onOpen);
  }, []);

  // `[B]` shortcut opens/closes Logbook and `[P]` opens/closes Photo Studio when exploring or in a room
  useEffect(() => {
    if (!s && !explore) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        return;
      }
      if (e.code === 'KeyP') {
        if (
          activeInspect?.kind === 'kiosk' ||
          worldMapOpen ||
          collectionOpen ||
          inviting ||
          settings ||
          confirmKick ||
          chat ||
          person !== null
        ) {
          return;
        }
        e.preventDefault();
        setGestures(false);
        setHelp(false);
        setPhotoState(prev => ({
          ...prev,
          open: !prev.open,
          controlsHidden: false,
        }));
        return;
      }
      if (e.code !== 'KeyB') return;
      if (
        photoState.open ||
        activeInspect?.kind === 'kiosk' ||
        worldMapOpen ||
        inviting ||
        settings ||
        confirmKick ||
        chat ||
        person !== null
      ) {
        return;
      }
      e.preventDefault();
      setCollectionOpen(prev => !prev);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    s,
    explore,
    photoState.open,
    activeInspect?.kind,
    worldMapOpen,
    collectionOpen,
    inviting,
    settings,
    confirmKick,
    chat,
    person,
  ]);

  useEffect(() => {
    if (s && new URLSearchParams(location.search).get('join')?.replace('-', '').toUpperCase() === s.code) {
      const u = new URL(location.href);
      u.searchParams.delete('join');
      history.replaceState(history.state, '', u.pathname + u.search);
    }
  }, [s?.code]);

  useEffect(() => {
    if (!s) setInviting(false);
  }, [s?.roomId]);

  const leave = () => {
    setLocalInspect(null);
    voice.stop();
    room.send('leave');
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(s?.code ?? '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const connectedVoice = voice.status === 'connected';
  const displayError = room.error || voice.error;
  const [locked, setLocked] = useState(false);
  const [mouseTick, setMouseTick] = useState(0);
  const hud = useEdgeReveal({
    hideExpandedPanels: true,
    enabled: !!s || explore,
    locked,
    hold: {
      top: settings || inviting || worldMapOpen || collectionOpen,
      bottom: gestures || help || worldMapOpen || collectionOpen,
    },
  });
  const cycleView = () => setView(v => (v === 'first' ? 'third' : v === 'third' ? 'first' : 'third'));
  const shortcutOverlayOpen =
    photoState.open ||
    inviting ||
    gestures ||
    !!chat ||
    person !== null ||
    !!confirmKick ||
    settings ||
    worldMapOpen ||
    collectionOpen;
  const keys = useSharedKeys(
    {
      actions: () => {
        setGestures(true);
        setHelp(false);
      },
      camera: cycleView,
      hud: hud.toggle,
      settings: () => setSettings(v => !v),
      help: toggleHelp,
      mouse: () => setMouseTick(n => n + 1),
    },
    {
      enabled: (!!s || explore) && !shortcutOverlayOpen && activeInspect?.kind !== 'kiosk',
      taken: [
        'KeyE',
        'KeyG',
        'KeyH',
        'KeyM',
        'KeyF',
        'KeyC',
        'KeyR',
        'KeyB',
        'KeyP',
        'Digit1',
        'Digit2',
        'Digit3',
        'Digit4',
        'Digit5',
        'KeyW',
        'KeyA',
        'KeyS',
        'KeyD',
        'Space',
        'ShiftLeft',
        'ShiftRight',
      ],
    },
  );
  const top = hud.bind('top');
  const chip = hud.bind('top', 'chip');
  const dock = hud.bind('bottom');
  const modes = hud.bind('bottom', 'modes');
  const cluster = hud.bind('bottom', 'cluster');
  const look = hud.bind('bottom', 'look');
  const roundPanel = hud.bind('top', 'round');
  const people = hud.bind('top', 'people');

  const artifact = activeInspect?.kind === 'artifact' ? arenaArtifacts[activeInspect.id] : undefined;
  const lookout = activeInspect?.kind === 'telescope' ? arenaLookouts[activeInspect.id] : undefined;

  return (
    <div
      ref={overlayRoot}
      className={[styles.root, pearl.tokens].join(' ')}
      data-spatial-owner="speaking-arena"
      data-morph="off"
    >
      <Scene
        onSeat={(act, item) => room.send(act, { item })}
        onBoat={(act, item, value, aux) =>
          room.send(act, { item, value, ...(aux !== undefined ? { aux } : {}) })
        }
        onBeacon={beaconId => room.send('beacon', { item: beaconId })}
        activeInspect={activeInspect}
        artifactTurn={me?.artifactTurn ?? artifactSpin}
        onInspect={setActiveInspect}
        inspectItem={studyItem}
        onPlaceable={setPlaceTable}
        onPlace={table => {
          if (me?.artifact) room.send('put-item', { item: me.artifact, place: table });
        }}
        placeRequest={placeRequest}
        onReleased={() => setLocalInspect(null)}
        environmentVolume={environmentVolume}
        inspect={diagnosticsEnabled}
        action={action}
        onAction={kind => {
          express(kind);
          setGestures(false);
        }}
        cursor={
          photoState.open ||
          gestures ||
          help ||
          worldMapOpen ||
          collectionOpen ||
          person !== null ||
          !!chat ||
          (!!activeInspect && activeInspect.kind !== 'telescope')
        }
        onPlayer={setPerson}
        mouseTick={mouseTick}
        helpTick={helpTick}
        onLock={setLocked}
        edge={look}
        view={view}
        photoState={photoState}
        photoControlRef={photoControlRef}
        blocked={
          gestures ||
          inviting ||
          help ||
          settings ||
          worldMapOpen ||
          collectionOpen ||
          activeInspect?.kind === 'kiosk' ||
          !!confirmKick ||
          (!s && !explore) ||
          person !== null ||
          !!chat
        }
        state={s}
        hero={hero}
        look={lookCode}
        speakers={voice.speakers}
        space={space}
        move={room.move}
        row={room.row}
        motion={room.motion}
        connected={room.connected}
        joystick={joystick}
        low={low}
        qualityTier={qualityTier}
        timeOfDay={timeOfDay}
        accountScope={account}
        voiceActive={(connectedVoice && voice.mic && Boolean(me?.canSpeak)) || kioskAudioActive}
        waypoint={waypoint}
        minimapRef={minimapRef}
        fishingHudRef={fishingHudRef}
        fishingControlRef={fishingControlRef}
        onFishingStateChange={setFishingHud}
        onMarineCatch={(_record, _species, collection) => {
          setMarineCollection(collection);
        }}
        onFruitHarvestChange={(log, toast) => {
          setFruitHarvest(log);
          if (toast) {
            setFruitToast(toast);
            if (fruitToastTimer.current !== null) window.clearTimeout(fruitToastTimer.current);
            fruitToastTimer.current = window.setTimeout(() => setFruitToast(null), 4200);
          }
        }}
        onQualityAutoDetected={tier => {
          if (!qualityChoice.current) setQualityTier(tier);
        }}
        vi={vi}
        onStats={measuredStats}
      />
      <div className={styles.vignette} />

      {/* Fruit Harvest Bilingual Vocabulary Toast */}
      {fruitToast && (
        <div className={styles.fruitToast} role="status" aria-live="polite" data-testid="arena-fruit-toast">
          <i aria-hidden="true" />
          <span>{vi ? fruitToast.vi : fruitToast.en}</span>
        </div>
      )}

      <header {...top} className={`${styles.topbar} ${top.className}`}>
        <Link
          href={studyReturnHref || '/speaking'}
          className={styles.back}
          onClick={e => {
            if (studyReturnHref) {
              markWorldPassage('/study-space');
              if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && journeyGo(studyReturnHref)) {
                e.preventDefault();
              }
            }
            if (s) leave();
          }}
        >
          <ArrowLeft size={17} />
          <span>{studyReturnHref ? (vi ? 'Về phòng học' : 'My study room') : (vi ? 'Luyện nói' : 'Speaking')}</span>
        </Link>
        <div className={styles.topActions}>
          {s && (
            <button className={styles.code} onClick={copy} title={vi ? 'Sao chép mã phòng' : 'Copy room code'}>
              {s.code}
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          )}
          <button
            className={styles.iconButton}
            onClick={() => setSettings(v => !v)}
            aria-label={vi ? 'Cài đặt' : 'Settings'}
            title={`${vi ? 'Cài đặt' : 'Settings'} (${keys.settings})`}
            aria-pressed={settings}
            aria-keyshortcuts={keys.settings}
          >
            <Settings2 size={19} />
          </button>
        </div>
      </header>

      {settings && (
        <aside className={`${styles.glass} ${styles.settings}`} aria-label={vi ? 'Cài đặt phòng' : 'Room settings'}>
          <div className={styles.row}>
            <b>{vi ? 'Trải nghiệm của bạn' : 'Your experience'}</b>
            <button
              className={styles.iconButton}
              onClick={() => setSettings(false)}
              aria-label={vi ? 'Đóng cài đặt' : 'Close settings'}
            >
              <X size={16} />
            </button>
          </div>
          <div className={styles.field}>
            <span>{vi ? 'Chất lượng đồ họa 3D' : '3D graphics quality'}</span>
            <div className={styles.qualityGrid} role="group" aria-label={vi ? 'Chất lượng đồ họa' : 'Graphics quality'}>
              {QUALITY_ORDER.map(tier => {
                const cfg = ARENA_QUALITY_CONFIGS[tier];
                return (
                  <button
                    key={tier}
                    type="button"
                    aria-pressed={qualityTier === tier}
                    data-testid={`arena-quality-${tier}`}
                    onClick={() => selectQualityTier(tier, true)}
                  >
                    {vi ? cfg.labelVi : cfg.labelEn}
                  </button>
                );
              })}
            </div>
          </div>
          <div className={styles.field}>
            <span>{vi ? 'Ánh sáng quần đảo' : 'Archipelago atmosphere'}</span>
            <div className={styles.qualityGrid} role="group" aria-label={vi ? 'Thời điểm ánh sáng' : 'Atmosphere'}>
              <button
                type="button"
                aria-pressed={timeOfDay === 'daylight'}
                data-testid="arena-tod-daylight"
                onClick={() => {
                  saveArenaTimeOfDay('daylight');
                  setTimeOfDay('daylight');
                }}
              >
                <Sun size={14} /> {vi ? 'Ban ngày' : 'Daylight'}
              </button>
              <button
                type="button"
                aria-pressed={timeOfDay === 'sunset'}
                data-testid="arena-tod-sunset"
                onClick={() => {
                  saveArenaTimeOfDay('sunset');
                  setTimeOfDay('sunset');
                }}
              >
                <Sunset size={14} /> {vi ? 'Hoàng hôn' : 'Sunset'}
              </button>
            </div>
          </div>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={low}
              onChange={e => selectQualityTier(e.target.checked ? 'low' : 'balanced', true)}
            />
            {vi ? 'Đồ họa nhẹ · tiết kiệm pin' : 'Light graphics · save battery'}
          </label>
          <p>
            {vi
              ? 'Tai nghe giúp nghe hướng rõ hơn và giảm tiếng vọng. Trình duyệt có thể tạm dừng voice khi chuyển ứng dụng.'
              : 'Headphones improve direction cues and reduce echo. Your browser may suspend voice when you switch apps.'}
          </p>
          <button
            className={styles.secondary}
            disabled={!canCheckMic}
            onClick={() => (micCheck.active ? micCheck.stop() : void micCheck.start())}
          >
            {micCheck.active
              ? vi
                ? 'Dừng thử micro'
                : 'Stop microphone check'
              : vi
                ? 'Thử micro · 8 giây'
                : 'Check microphone · 8 seconds'}
          </button>
          {micCheck.active && (
            <label className={styles.field}>
              {vi ? 'Mức âm thanh từ micro' : 'Microphone input level'}
              <meter min={0} max={1} value={micCheck.level} />
            </label>
          )}
          {micCheck.error && <p role="alert">{arenaError(micCheck.error, vi)}</p>}
          <p>
            {vi
              ? 'Thử micro chỉ diễn ra trên thiết bị này; không phát tiếng, không lưu hay gửi âm thanh.'
              : 'The microphone check stays on this device; it does not play, save or send audio.'}
          </p>
          <small>
            {stats.fps} FPS · {stats.draws} {vi ? 'lượt vẽ' : 'draws'} · {Math.round(stats.triangles / 1000)}k{' '}
            {vi ? 'tam giác' : 'triangles'}
          </small>
          <label className={styles.checkRow}>
            {vi ? 'Âm lượng hội thoại' : 'Voice volume'}{' '}
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round(voice.volume * 100)}
              onChange={e => voice.setVolume(Number(e.target.value) / 100)}
            />
            {Math.round(voice.volume * 100)}%
          </label>
          <label className={styles.checkRow}>
            {vi ? 'Âm thanh môi trường' : 'Environment volume'}{' '}
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round(environmentVolume * 100)}
              onChange={e => setEnvironmentVolume(Number(e.target.value) / 100)}
            />
            {Math.round(environmentVolume * 100)}%
          </label>
          {connectedVoice &&
            (['audioinput', 'audiooutput'] as const).map(kind => {
              if (kind === 'audiooutput' && !('setSinkId' in AudioContext.prototype)) return null;
              const list = voice.devices.filter(d => d.kind === kind && d.deviceId && d.deviceId !== 'default');
              return (
                <label key={kind} className={styles.checkRow}>
                  {kind === 'audioinput' ? 'Micro' : vi ? 'Đầu ra voice' : 'Voice output'}
                  <select
                    value={kind === 'audioinput' ? voice.input : voice.output}
                    onFocus={() => void voice.refreshDevices()}
                    onChange={e => void voice.selectDevice(kind, e.target.value)}
                  >
                    <option value="default">
                      {kind === 'audioinput'
                        ? vi
                          ? 'Theo trình duyệt'
                          : 'Browser default'
                        : vi
                          ? 'Mặc định hệ thống'
                          : 'System default'}
                    </option>
                    {list.map((d, i) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || String(i + 1)}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={diagnosticsEnabled}
              onChange={e => setDiagnosticsEnabled(e.target.checked)}
            />
            {vi ? 'Chẩn đoán chuyển động và voice' : 'Movement and voice diagnostics'}
          </label>
          {diagnosticsEnabled && (
            <details>
              <summary>{vi ? 'Đường phát và thống kê WebRTC' : 'Playback and WebRTC statistics'}</summary>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11 }} data-testid="arena-media-diagnostics">
                {JSON.stringify({ status: voice.status, mic: voice.mic, ...voice.diagnostics }, null, 2)}
              </pre>
            </details>
          )}
        </aside>
      )}

      {/* Tropical Pearl and Deep Lagoon Abyss HUD Suite (Minimap, World Map, Speaking Station, Fishing, Photo Studio, Logbook) */}
      <div data-hud-scope data-in-room={Boolean(s)}>
        {(s || explore) && !photoState.open && (
          <ArenaMinimap
            snapshotRef={minimapRef}
            timeOfDay={timeOfDay}
            onToggleTimeOfDay={toggleTimeOfDay}
            vi={vi}
            worldMapOpen={worldMapOpen}
            onWorldMapOpenChange={setWorldMapOpen}
            onSelectWaypoint={setWaypoint}
            onOpenCollection={() => {
              setCollectionTab('marine');
              setCollectionOpen(true);
            }}
            visitedStationIds={visitedStationIds}
            shortcutEnabled={
              !photoState.open &&
              !inviting &&
              !gestures &&
              !chat &&
              person === null &&
              !confirmKick &&
              !settings &&
              !collectionOpen &&
              activeInspect?.kind !== 'kiosk'
            }
          />
        )}

        {activeInspect?.kind === 'kiosk' && !photoState.open && (
          <ArenaSpeakingStationModal
            stationId={activeInspect.id}
            vi={vi}
            onClose={() => setActiveInspect(null)}
            isHost={host}
            roomPhase={s?.phase ?? null}
            roomRound={s?.round ?? 0}
            roomBusy={busy}
            canTriggerRoomTurn={Boolean(speaker || s?.self)}
            onSetRoomTopic={(headingEn, promptIndex) => {
              setPrompt(promptIndex);
              room.send('topic', { topic: headingEn, prompt: promptIndex });
              setActiveInspect(null);
            }}
            onStartRoomTurn={(headingEn, promptIndex) => {
              if (!s) return;
              setPrompt(promptIndex);
              const target = speaker || s.self;
              const sentTopic = room.send('topic', { topic: headingEn, prompt: promptIndex });
              if (sentTopic) {
                queuedRoundStartRef.current = { target, prompt: promptIndex };
              } else {
                room.send('round', { target, prompt: promptIndex });
              }
              setActiveInspect(null);
            }}
            onStationPracticed={markStationVisited}
            onRecordingChange={handleKioskRecordingChange}
          />
        )}

        {(s || explore) && !photoState.open && (
          <ArenaFishingHud
            state={fishingHud}
            hudRef={fishingHudRef}
            vi={vi}
            onCast={() => fishingControlRef.current?.castOrStrike()}
            onCastChargeStart={() => fishingControlRef.current?.beginCastCharge?.()}
            onCastChargeRelease={() => fishingControlRef.current?.releaseCastCharge?.()}
            onStrike={() => fishingControlRef.current?.castOrStrike()}
            onReelStart={() => fishingControlRef.current?.setReeling(true)}
            onReelStop={() => fishingControlRef.current?.setReeling(false)}
            onUnequip={() => fishingControlRef.current?.unequip()}
            onDismissCatch={() => fishingControlRef.current?.dismissCatch?.()}
            onOpenLogbook={speciesId => {
              setCollectionTab('marine');
              if (speciesId) setCollectionSpeciesId(speciesId);
              setCollectionOpen(true);
            }}
            onPracticeFishPrompt={species => {
              setCollectionTab('marine');
              setCollectionSpeciesId(species.id);
              setCollectionOpen(true);
            }}
          />
        )}

        {(s || explore) && (
          <ArenaPhotoStudio
            state={photoState}
            onStateChange={setPhotoState}
            vi={vi}
            onResetCamera={() => photoControlRef.current?.resetCamera()}
            onCapture={payload => photoControlRef.current?.capture(payload.cssFilter)}
            onClose={() =>
              setPhotoState(prev => ({
                ...prev,
                open: false,
                controlsHidden: false,
              }))
            }
          />
        )}

        <ArenaCollectionDrawer
          open={collectionOpen}
          onClose={() => setCollectionOpen(false)}
          vi={vi}
          marineCollection={marineCollection}
          fruitHarvest={fruitHarvest}
          initialTab={collectionTab}
          initialSpeciesId={collectionSpeciesId}
          onLaunchSpeakingPrompt={payload => {
            setCollectionOpen(false);
            const isMarine = payload.vocabWords.some(w =>
              /reef|coral|ocean|current|species|fin|dive|lagoon/i.test(w),
            );
            const targetStationId = isMarine ? 'kiosk-lagoon-reef' : 'kiosk-beach';
            const found = arenaLayout.interactables.find(i => i.id === targetStationId);
            setActiveInspect({
              kind: 'kiosk',
              id: targetStationId,
              x: found?.x ?? 0,
              z: found?.z ?? 0,
            });
          }}
        />
      </div>

      {/* Contextual Table Artefact Inspection Card */}
      {artifact && (
        <section
          className={`${styles.glass} ${styles.interactCard} ${styles.artifactCard}`}
          data-testid="arena-artifact-card"
          aria-label={vi ? artifact.titleVi : artifact.titleEn}
        >
          <div className={styles.row}>
            <span className={styles.eyebrow}>
              <Compass size={13} /> {vi ? 'Vật phẩm bàn hội thoại' : 'Table artefact'}
            </span>
          </div>
          <h3>{vi ? artifact.titleVi : artifact.titleEn}</h3>
          {studyItem && <p>{vi ? artifact.detailVi : artifact.detailEn}</p>}
          <p className={styles.artifactPrompt}>{vi ? artifact.questionVi : artifact.questionEn}</p>
          <div className={styles.row}>
            <button
              type="button"
              className={styles.secondary}
              aria-pressed={studyItem}
              data-testid="arena-artifact-study"
              onClick={() => setStudyItem(v => !v)}
            >
              {studyItem ? (vi ? 'Hạ xuống' : 'Lower it') : (vi ? 'Xem kỹ' : 'Look closely')}
            </button>
            <button
              type="button"
              className={styles.secondary}
              disabled={!!s && busy}
              data-testid="arena-artifact-turn"
              onClick={() =>
                s ? room.send('turn-item', { item: me?.artifact ?? undefined }) : setArtifactSpin(a => (a + 1) % 8)
              }
            >
              {vi ? 'Xoay' : 'Turn'}
            </button>
            <button
              type="button"
              className={styles.primary}
              disabled={!placeTable || (!!s && busy)}
              data-testid="arena-artifact-place"
              onClick={placeHeld}
            >
              {vi ? 'Đặt lên bàn' : 'Set on table'}
            </button>
          </div>
          {!placeTable && (
            <small className={styles.artifactHint}>
              {vi ? 'Mang tới cạnh một chiếc bàn để đặt xuống.' : 'Carry it to a table to set it down.'}
            </small>
          )}
        </section>
      )}

      {/* Scenic Horizon Spyglass Banner */}
      {lookout && (
        <div className={`${styles.glass} ${styles.lookoutBanner}`} data-testid="arena-lookout-banner" role="status">
          <div>
            <span className={styles.eyebrow}>
              <Eye size={13} /> {vi ? lookout.titleVi : lookout.titleEn}
            </span>
            <p>{vi ? 'Kéo để ngắm · Cuộn để thu phóng · E để rời kính' : 'Drag to aim · Scroll to zoom · E to exit'}</p>
          </div>
          <button type="button" className={styles.secondary} onClick={() => setActiveInspect(null)}>
            {vi ? 'Rời kính · E' : 'Step back · E'}
          </button>
        </div>
      )}

      {!s && (
        <>
          {!explore ? (
            <section className={`${styles.glass} ${styles.entry}`} aria-labelledby="arena-title">
              <span className={styles.eyebrow}>{vi ? 'GẶP NHAU. MỞ LỜI. TIẾN BỘ.' : 'MEET. SPEAK. GROW.'}</span>
              <h1 id="arena-title">
                {vi ? (
                  <>
                    Một quần đảo.
                    <br />
                    <em>Nhiều câu chuyện.</em>
                  </>
                ) : (
                  <>
                    One archipelago.
                    <br />
                    <em>Many stories.</em>
                  </>
                )}
              </h1>
              <p className={styles.intro}>
                {vi
                  ? 'Bước vào cuộc trò chuyện tiếng Anh cùng người thật. Dạo bước qua cầu cảng, căng buồm và lặn biển giữa bảy quần đảo lớn, mở micro và lắng nghe nhau.'
                  : 'Step into an English conversation with real people. Stroll the harbors, sail and free-dive across seven major islands, open your mic and listen to each other.'}
              </p>
              <div className={styles.heroPicker} aria-label={vi ? 'Chọn nhân vật' : 'Choose character'}>
                {(['LYRA', 'KAI'] as const).map(h => (
                  <button
                    key={h}
                    onClick={() => setHero(h)}
                    className={hero === h ? styles.heroSelected : ''}
                    aria-pressed={hero === h}
                  >
                    <span>{h === 'LYRA' ? 'L' : 'K'}</span>
                    <div>
                      <b>{h === 'LYRA' ? 'Lyra' : 'Kai'}</b>
                      <small>
                        {h === 'LYRA'
                          ? vi
                            ? 'Người kể chuyện'
                            : 'Story keeper'
                          : vi
                            ? 'Người khám phá'
                            : 'Wayfinder'}
                      </small>
                    </div>
                    {hero === h && <Check size={16} />}
                  </button>
                ))}
              </div>
              <label className={styles.field}>
                {vi ? 'Tên trong phòng' : 'Room display name'}
                <input
                  value={nickname}
                  onChange={e => {
                    nameTouched.current = true;
                    setNickname(e.target.value);
                  }}
                  maxLength={24}
                  autoComplete="off"
                  placeholder={vi ? 'Bạn muốn được gọi là gì?' : 'What should we call you?'}
                />
              </label>
              <div className={styles.modes}>
                {arenaModes.map(m => (
                  <button
                    key={m.id}
                    onClick={() => {
                      setMode(m.id);
                      if (m.id === 'FREE' || m.id === 'GUIDED') setPublicPair(false);
                    }}
                    aria-pressed={mode === m.id}
                    className={mode === m.id ? styles.modeSelected : ''}
                  >
                    <span>{m.title}</span>
                    <b>{vi ? m.vi : m.en}</b>
                    <small>{vi ? m.hintVi : m.hintEn}</small>
                  </button>
                ))}
              </div>
              {configError ? (
                <div className={styles.notice} role="status">
                  {vi ? 'Chưa kiểm tra được dịch vụ.' : 'Service check failed.'}
                  <button onClick={() => setConfigTry(v => v + 1)}>{vi ? 'Thử lại' : 'Retry'}</button>
                </div>
              ) : config && !config.available ? (
                <p className={styles.notice} role="status">
                  {vi
                    ? 'Voice đang chờ mở. Bạn vẫn có thể khám phá quần đảo bên dưới.'
                    : 'Voice is awaiting availability. You can still explore the archipelago below.'}
                </p>
              ) : !config ? (
                <p className={styles.notice} role="status">
                  {vi ? 'Đang kiểm tra dịch vụ…' : 'Checking service…'}
                </p>
              ) : null}
              <div className={styles.setupRow}>
                <label className={styles.field}>
                  {vi ? 'Quyền vào phòng' : 'Access'}
                  <select value={publicPair ? 'public' : 'private'} onChange={e => setPublicPair(e.target.value === 'public')}>
                    <option value="private">{vi ? 'Riêng tư · mã hoặc lời mời' : 'Private · code or invitation'}</option>
                    {(mode === 'DUEL' || mode === 'TEAM') && (
                      <option value="public">{vi ? 'Ghép công khai' : 'Public matchmaking'}</option>
                    )}
                  </select>
                </label>
                <label className={styles.field}>
                  {vi ? 'Số chỗ' : 'Seats'}
                  <select
                    value={seats}
                    disabled={mode === 'DUEL' || mode === 'TEAM'}
                    onChange={e => setCapacity(Number(e.target.value))}
                  >
                    {(mode === 'DUEL' || mode === 'TEAM' ? [seats] : [2, 3, 4, 5, 6, 7, 8]).map(n => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
              </div>
              {!publicPair && (
                <details>
                  <summary>{vi ? 'Tên và chủ đề (tùy chọn)' : 'Room name and topic (optional)'}</summary>
                  <label className={styles.field}>
                    {vi ? 'Tên phòng' : 'Room name'}
                    <input maxLength={48} value={title} onChange={e => setTitle(e.target.value)} />
                  </label>
                  <label className={styles.field}>
                    {vi ? 'Chủ đề' : 'Topic'}
                    <input maxLength={120} value={topic} onChange={e => setTopic(e.target.value)} />
                  </label>
                </details>
              )}
              <div className={styles.entryActions}>
                <button
                  className={styles.primary}
                  disabled={busy || !config?.available || nickname.trim().length < 2}
                  onClick={() => enter(publicPair ? 'quick' : 'create')}
                >
                  <Users size={17} />
                  {publicPair ? (vi ? 'Ghép công khai' : 'Find public match') : (vi ? 'Tạo phòng riêng' : 'Create private room')}
                  <ArrowRight size={17} />
                </button>
              </div>
              <label htmlFor="arena-join-code">{vi ? 'Đã có mã phòng?' : 'Have a room code?'}</label>
              <form
                className={styles.join}
                onSubmit={e => {
                  e.preventDefault();
                  enter('join');
                }}
              >
                <input
                  id="arena-join-code"
                  aria-label={vi ? 'Mã phòng' : 'Room code'}
                  value={code}
                  onChange={e => setCode(e.target.value.toUpperCase())}
                  placeholder={vi ? 'Mã phòng 8 ký tự' : '8-character room code'}
                  maxLength={9}
                />
                <button
                  disabled={busy || !config?.available || nickname.trim().length < 2 || code.replace('-', '').length !== 8}
                >
                  {vi ? 'Tham gia' : 'Join'}
                  <ArrowRight size={16} />
                </button>
              </form>
              <button className={styles.textButton} onClick={() => setExplore(true)}>
                {vi ? 'Khám phá quần đảo trước' : 'Explore the archipelago first'}
                <ArrowRight size={14} />
              </button>
              <p className={styles.privacy}>
                {vi
                  ? 'Voice trực tiếp · Không ghi âm · Điểm do người chấm. Kết quả chỉ giữ trong phòng hiện tại.'
                  : 'Live voice · No recording · Human-awarded points. Results last for this room only.'}
              </p>
            </section>
          ) : (
            <button
              type="button"
              {...chip}
              className={`${styles.previewChip} ${chip.className}`}
              onClick={() => {
                setActiveInspect(null);
                setExplore(false);
              }}
              title={vi ? 'Chưa tham gia phòng. Micro đang tắt.' : 'You have not joined a room. Microphone is off.'}
            >
              <i aria-hidden="true" />
              {vi ? 'Đang khám phá · Micro tắt' : 'Exploring · Mic off'}
              <b>{vi ? 'Vào phòng' : 'Join'}</b>
            </button>
          )}
        </>
      )}

      {s && (
        <>
          <div className={styles.roomPanels} data-open={hud.shown.top}>
            <section
              {...roundPanel}
              className={`${styles.glass} ${styles.round} ${roundPanel.className}`}
              aria-label={vi ? 'Trạng thái lượt nói' : 'Round state'}
            >
              <div className={styles.row}>
                <span className={styles.eyebrow}>
                  {phases[s.phase][vi ? 0 : 1]} {s.round > 0 && `· ${s.round}/6`}
                </span>
                <span className={styles.timer}>
                  {s.deadline > 0 ? `${remaining}s` : s.mode === 'TEAM' ? '2v2' : s.mode === 'DUEL' ? '1v1' : 'SOCIAL'}
                </span>
              </div>
              {joinCode && joinCode.replace('-', '') !== s.code && (
                <div role="status">
                  {vi ? 'Bạn đang ở phòng khác.' : 'You are in another room.'}{' '}
                  <button onClick={leave}>{vi ? 'Rời phòng để nhận lời mời' : 'Leave to accept invitation'}</button>{' '}
                  <button onClick={() => setJoinCode(null)}>{vi ? 'Ở lại' : 'Stay'}</button>
                </div>
              )}
              {s.title && <b>{s.title}</b>}
              {s.topic && <p>{s.topic}</p>}
              <ArenaInvitations key={s.roomId} room={s} vi={vi} open={inviting} setOpen={setInviting} />
              {s.phase === 'LOBBY' ? (
                <>
                  <h2>{vi ? 'Phòng đã sẵn sàng' : 'Your room is ready'}</h2>
                  <p>
                    {s.publicMatch
                      ? vi
                        ? 'Đang chờ người cùng ghép. Bạn cũng có thể gửi mã phòng cho bạn bè.'
                        : 'Waiting for a match. You can also invite friends with the room code.'
                      : vi
                        ? 'Chia sẻ mã phòng, kết nối voice rồi bấm Sẵn sàng.'
                        : 'Share the room code, connect voice and select Ready.'}
                  </p>
                  <button
                    className={me?.ready ? styles.secondary : styles.primary}
                    disabled={busy}
                    onClick={() => room.send('ready', { value: !me?.ready })}
                  >
                    <Check size={16} />
                    {me?.ready ? (vi ? 'Đã sẵn sàng' : 'Ready') : (vi ? 'Sẵn sàng' : 'Ready up')}
                  </button>
                </>
              ) : s.phase === 'FREE' ? (
                <>
                  <h2>{vi ? 'Trò chuyện trên quần đảo' : 'Archipelago conversation'}</h2>
                  <p>
                    {vi
                      ? 'Đứng gần nhau hoặc ngồi chung thuyền để nghe rõ. Từ 6 m trở đi, mỗi nhóm có thể trò chuyện riêng.'
                      : 'Stand close or share a boat to hear clearly. Voices fade to silence at 6 m so groups can speak separately.'}
                  </p>
                </>
              ) : s.phase === 'FINISHED' ? (
                <>
                  <div className={styles.resultIcon}>
                    <Trophy />
                  </div>
                  <h2>
                    {s.coral === s.lagoon
                      ? vi
                        ? 'Một trận hòa đáng nhớ'
                        : 'A conversation to share'
                      : s.coral > s.lagoon
                        ? vi
                          ? 'Đội San hô dẫn điểm'
                          : 'Coral takes the lead'
                        : vi
                          ? 'Đội Đầm xanh dẫn điểm'
                          : 'Lagoon takes the lead'}
                  </h2>
                  <p>
                    {vi
                      ? 'Điểm ghi nhận nhận xét của chủ phòng, không phải đánh giá trình độ tiếng Anh.'
                      : 'Points reflect the host’s review, not an English proficiency assessment.'}
                  </p>
                </>
              ) : (
                <>
                  <small>{vi ? currentPrompt.vi : currentPrompt.kind}</small>
                  <h2>{currentPrompt.title}</h2>
                  <p>{vi ? currentPrompt.vn : currentPrompt.hint}</p>
                  {speaking && (
                    <div className={styles.speaker}>
                      <Radio size={16} />
                      {s.phase === 'PREPARE' ? (vi ? 'Chuẩn bị: ' : 'Up next: ') : vi ? 'Lượt của: ' : 'Speaking: '}
                      <b>{speaking.name}</b>
                    </div>
                  )}
                </>
              )}
              {(s.mode === 'DUEL' || s.mode === 'TEAM') && (
                <div className={styles.score}>
                  <span>
                    <i />
                    {vi ? 'San hô' : 'Coral'}
                    <b>{s.coral}</b>
                  </span>
                  <span>
                    <i />
                    {vi ? 'Đầm xanh' : 'Lagoon'}
                    <b>{s.lagoon}</b>
                  </span>
                </div>
              )}
            </section>
            <aside {...people} className={`${styles.glass} ${styles.roster} ${people.className}`}>
              <button className={styles.rosterTitle} onClick={() => setRoster(v => !v)} aria-expanded={roster}>
                <Users size={17} />
                <b>
                  {vi ? 'Trong phòng' : 'In this room'} · {s.players.length}/{s.capacity}
                </b>
                <ChevronDown size={16} />
              </button>
              {roster && (
                <div className={styles.rosterBody}>
                  {s.players.map(p => (
                    <div key={p.id} className={styles.member}>
                      <span className={styles.memberAvatar} data-team={p.team}>
                        {p.name.slice(0, 1)}
                      </span>
                      <div className={styles.memberName}>
                        {p.id !== s.self && p.userId ? (
                          <button
                            type="button"
                            className={styles.memberOpen}
                            onClick={() => setPerson(p.userId as number)}
                            aria-label={vi ? `Xem hồ sơ của ${p.name}` : `See ${p.name}'s profile`}
                            data-testid={`arena-person-${p.userId}`}
                          >
                            <b>{p.name}</b>
                          </button>
                        ) : (
                          <b>
                            {p.name}
                            {p.id === s.self ? (vi ? ' (bạn)' : ' (you)') : ''}
                          </b>
                        )}
                        <small>
                          {p.id === s.host ? (vi ? 'Chủ phòng · ' : 'Host · ') : ''}
                          {!p.online
                            ? vi
                              ? 'Nối lại…'
                              : 'Reconnecting…'
                            : p.moderated
                              ? vi
                                ? 'Micro bị khóa'
                                : 'Mic restricted'
                              : p.boat
                                ? p.boatRole === 'ROWER'
                                  ? vi
                                    ? 'Đang lái thuyền'
                                    : 'At the helm'
                                  : vi
                                    ? 'Trên thuyền'
                                    : 'Boat passenger'
                                : p.ready
                                  ? vi
                                    ? 'Sẵn sàng'
                                    : 'Ready'
                                  : vi
                                    ? 'Đang chuẩn bị'
                                    : 'Preparing'}
                        </small>
                        <small>
                          {voice.speakers.includes(p.voiceIdentity)
                            ? vi
                              ? 'Đang nói'
                              : 'Speaking'
                            : !connectedVoice
                              ? vi
                                ? 'Chưa kết nối voice của bạn'
                                : 'Voice not connected here'
                              : p.id !== s.self && !(p.voiceIdentity in voice.remoteMics)
                                ? vi
                                  ? 'Chưa vào voice'
                                  : 'Not in voice'
                                : (p.id === s.self ? voice.published && p.canSpeak : voice.remoteMics[p.voiceIdentity])
                                  ? vi
                                    ? 'Đã bật micro'
                                    : 'Mic on'
                                  : vi
                                    ? 'Micro tắt'
                                    : 'Mic off'}
                        </small>
                      </div>
                      {p.id !== s.self && (
                        <button
                          className={styles.iconButton}
                          onClick={() => voice.toggleMute(p.id)}
                          aria-label={
                            voice.muted.has(p.id)
                              ? vi
                                ? `Nghe lại ${p.name}`
                                : `Unmute ${p.name}`
                              : vi
                                ? `Tắt tiếng ${p.name} riêng cho bạn`
                                : `Mute ${p.name} for you`
                          }
                        >
                          {voice.muted.has(p.id) ? <VolumeX size={16} /> : <Volume2 size={16} />}
                        </button>
                      )}
                      {host && (
                        <details className={styles.memberMenu}>
                          <summary aria-label={vi ? `Điều phối ${p.name}` : `Manage ${p.name}`}>···</summary>
                          <div>
                            {s.phase === 'LOBBY' && (
                              <button
                                disabled={busy}
                                onClick={() => room.send('team', { target: p.id, team: p.team === 0 ? 1 : 0 })}
                              >
                                {vi ? 'Đổi đội' : 'Switch team'}
                              </button>
                            )}
                            <button disabled={busy} onClick={() => room.send('mute', { target: p.id, value: !p.moderated })}>
                              {p.moderated
                                ? vi
                                  ? 'Cho phép micro'
                                  : 'Allow microphone'
                                : vi
                                  ? 'Khóa micro'
                                  : 'Restrict microphone'}
                            </button>
                            {p.id !== s.host && (
                              <button onClick={() => setConfirmKick(p.id)}>
                                {vi ? 'Mời ra khỏi phòng' : 'Remove from room'}
                              </button>
                            )}
                          </div>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {host && roster && (
                <details className={styles.hostTools}>
                  <summary>
                    <Flag size={15} />
                    {vi ? 'Điều phối cuộc trò chuyện' : 'Host the conversation'}
                  </summary>
                  {s.phase === 'LOBBY' || s.phase === 'FREE' || s.phase === 'REVIEW' ? (
                    <>
                      <label className={styles.field}>
                        {vi ? 'Thử thách' : 'Conversation prompt'}
                        <select value={prompt} onChange={e => setPrompt(Number(e.target.value))}>
                          {arenaPrompts.map((p, i) => (
                            <option key={p.title} value={i}>
                              {p.title}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className={styles.field}>
                        {vi ? 'Người nói tiếp theo' : 'Next speaker'}
                        <select value={speaker} onChange={e => setSpeaker(e.target.value)}>
                          {s.players
                            .filter(p => p.online && !p.moderated)
                            .map(p => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                        </select>
                      </label>
                      <button
                        className={styles.primary}
                        disabled={busy || s.round >= 6 || !speaker}
                        onClick={() => room.send('round', { target: speaker, prompt })}
                      >
                        {vi ? 'Bắt đầu lượt · 20s + 60s' : 'Start turn · 20s + 60s'}
                      </button>
                    </>
                  ) : null}
                  {(s.phase === 'PREPARE' || s.phase === 'TALK') && (
                    <button className={styles.secondary} disabled={busy} onClick={() => room.send('stop')}>
                      {vi ? 'Kết thúc lượt nói' : 'End speaking turn'}
                    </button>
                  )}
                  {s.phase === 'REVIEW' && (
                    <div className={styles.award}>
                      <b>
                        {vi
                          ? 'Chấm thủ công · mỗi đội một lần mỗi lượt'
                          : 'Human scoring · once per team per round'}
                      </b>
                      <label className={styles.field}>
                        {vi ? 'Tiêu chí' : 'Criterion'}
                        <select value={reason} onChange={e => setReason(e.target.value)}>
                          <option value="RESPONSE">{vi ? 'Lắng nghe và phản hồi' : 'Listening and response'}</option>
                          <option value="CLARITY">{vi ? 'Ý tưởng rõ ràng' : 'Clarity of ideas'}</option>
                          <option value="TEAMWORK">{vi ? 'Hợp tác' : 'Teamwork'}</option>
                        </select>
                      </label>
                      <label className={styles.field}>
                        {vi ? 'Điểm' : 'Points'}
                        <select value={points} onChange={e => setPoints(Number(e.target.value))}>
                          {[0, 1, 2, 3].map(n => (
                            <option key={n}>{n}</option>
                          ))}
                        </select>
                      </label>
                      <div className={styles.row}>
                        {[0, 1].map(team => (
                          <button
                            className={styles.secondary}
                            key={team}
                            disabled={busy || s.awards.some(a => a.round === s.round && a.team === team)}
                            onClick={() => room.send('award', { team, points, reason })}
                          >
                            {team === 0 ? (vi ? 'San hô' : 'Coral') : (vi ? 'Đầm xanh' : 'Lagoon')} +{points}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {s.phase !== 'FINISHED' ? (
                    <div className={styles.row}>
                      <button className={styles.textButton} disabled={busy || s.phase === 'FREE'} onClick={() => room.send('free')}>
                        {vi ? 'Nói tự do' : 'Free talk'}
                      </button>
                      <button className={styles.textButton} disabled={busy} onClick={() => room.send('end')}>
                        {vi ? 'Kết thúc trận' : 'Finish match'}
                      </button>
                    </div>
                  ) : (
                    <button className={styles.primary} disabled={busy} onClick={() => room.send('rematch')}>
                      {vi ? 'Chơi lại cùng nhau' : 'Play together again'}
                    </button>
                  )}
                </details>
              )}
            </aside>
          </div>
          <div {...dock} className={`${styles.glass} ${styles.dock} ${dock.className}`}>
            {!connectedVoice && me?.canSpeak && (
              <button
                className={styles.secondary}
                disabled={busy || voice.status === 'connecting' || voice.status === 'reconnecting'}
                onClick={() => void voice.start(true)}
              >
                <Mic size={18} />
                {vi ? 'Tham gia bằng micro' : 'Join with microphone'}
              </button>
            )}
            {!connectedVoice ? (
              <button
                className={styles.primary}
                onClick={() => void voice.start()}
                disabled={busy || voice.status === 'connecting' || voice.status === 'reconnecting'}
              >
                <Headphones size={19} />
                {voice.status === 'connecting'
                  ? vi
                    ? 'Đang kết nối…'
                    : 'Connecting…'
                  : voice.status === 'reconnecting'
                    ? vi
                      ? 'Nối lại voice…'
                      : 'Reconnecting voice…'
                    : vi
                      ? 'Kết nối voice'
                      : 'Connect voice'}
              </button>
            ) : (
              <button
                className={voice.mic && me?.canSpeak ? styles.micActive : styles.secondary}
                onClick={voice.toggleMic}
                disabled={!me?.canSpeak}
                aria-pressed={voice.mic}
              >
                {voice.mic && me?.canSpeak ? <Mic size={20} /> : <MicOff size={20} />}
                <span>
                  {!me?.canSpeak
                    ? me?.moderated
                      ? vi
                        ? 'Micro bị khóa'
                        : 'Mic restricted'
                      : s.phase === 'REVIEW'
                        ? vi
                          ? 'Micro tắt trong pha nhận xét'
                          : 'Mic off during review'
                        : vi
                          ? 'Đang lắng nghe'
                          : 'Listening'
                    : voice.mic
                      ? vi
                        ? 'Tắt micro'
                        : 'Mute mic'
                      : vi
                        ? 'Bật micro'
                        : 'Unmute mic'}
                </span>
              </button>
            )}
            <button
              className={styles.iconButton}
              disabled={busy}
              onClick={() => express('wave')}
              aria-label={vi ? 'Vẫy chào' : 'Wave'}
            >
              <Hand size={20} />
            </button>
            <button
              className={styles.iconButton}
              disabled={busy}
              onClick={() => express('listen')}
              aria-label={vi ? 'Gật đầu lắng nghe' : 'Listening nod'}
            >
              <Headphones size={20} />
            </button>
            <button
              className={styles.iconButton}
              disabled={busy}
              onClick={() => express('cheer')}
              aria-label={vi ? 'Cổ vũ' : 'Cheer'}
            >
              <Flag size={20} />
            </button>
            {connectedVoice && !voice.playable && (
              <button className={styles.primary} onClick={() => void voice.resumeAudio()}>
                {vi ? 'Bật âm thanh' : 'Enable audio'}
              </button>
            )}
            <span className={styles.connection} data-connected={room.connected && connectedVoice && voice.playable}>
              <i />
              {!room.connected
                ? vi
                  ? 'Nối lại phòng'
                  : 'Reconnecting room'
                : connectedVoice && !voice.playable
                  ? vi
                    ? 'Đầu ra đang dừng'
                    : 'Playback paused'
                  : connectedVoice
                    ? voice.quality === 'poor'
                      ? vi
                        ? 'Mạng yếu'
                        : 'Weak connection'
                      : 'Voice'
                    : vi
                      ? 'Micro đang tắt'
                      : 'Mic is off'}
            </span>
            <button
              className={`${styles.iconButton} ${styles.leave}`}
              onClick={leave}
              disabled={busy}
              aria-label={vi ? 'Rời phòng' : 'Leave room'}
            >
              <LogOut size={20} />
            </button>
          </div>
        </>
      )}

      {(s || explore) && !photoState.open && (
        <>
          <div {...cluster} className={`${styles.hudCluster} ${cluster.className}`}>
            <button
              type="button"
              className={styles.hudButton}
              data-testid="arena-photo-open"
              aria-expanded={photoState.open}
              onClick={() => {
                setPhotoState(prev => ({ ...prev, open: true, controlsHidden: false }));
                setCollectionOpen(false);
                setGestures(false);
                setHelp(false);
              }}
            >
              <Camera size={16} />
              <span>{vi ? 'Chụp ảnh' : 'Photo'}</span>
              <kbd>P</kbd>
            </button>
            <button
              type="button"
              className={styles.hudButton}
              data-testid="arena-collection-open"
              aria-expanded={collectionOpen}
              onClick={() => {
                setCollectionOpen(v => !v);
                setGestures(false);
                setHelp(false);
              }}
            >
              <BookOpen size={16} />
              <span>{vi ? 'Sổ biển' : 'Logbook'}</span>
              <kbd>B</kbd>
            </button>
            <button
              type="button"
              className={styles.hudButton}
              data-testid="arena-gestures"
              aria-expanded={gestures}
              onClick={() => {
                setGestures(v => !v);
                setHelp(false);
              }}
            >
              <Hand size={16} />
              <span>{vi ? 'Cử chỉ' : 'Gestures'}</span>
              <kbd>{keys.actions}</kbd>
            </button>
            <button
              type="button"
              className={styles.hudButton}
              data-testid="arena-help"
              aria-expanded={help}
              aria-label={vi ? 'Cách di chuyển' : 'How to move'}
              title={`${vi ? 'Cách điều khiển' : 'Controls'} (${keys.help})`}
              aria-keyshortcuts={keys.help}
              onClick={toggleHelp}
            >
              <CircleHelp size={16} />
            </button>

            {help && (
              <ul className={styles.helpCard} data-testid="arena-help-card">
                <li>
                  <kbd>W A S D</kbd>
                  {vi ? 'Đi bộ, bơi hoặc lái thuyền' : 'Walk, swim, or steer a boat'}
                </li>
                <li>
                  <kbd>Shift</kbd>
                  {vi ? 'Giữ để chạy bộ hoặc bơi nhanh' : 'Hold to run or swim faster'}
                </li>
                <li>
                  <kbd>C</kbd>
                  {vi ? 'Ngồi ghế, ngồi bãi cát hoặc lặn biển' : 'Sit down or free-dive underwater'}
                </li>
                <li>
                  <kbd>E</kbd>
                  {vi ? 'Lên thuyền, mở trạm nói, rung cây hoặc tương tác' : 'Board boat, open station, shake fruit tree, or interact'}
                </li>
                <li>
                  <kbd>F</kbd>
                  {vi ? 'Cầm cần câu cá; giữ chuột trái để quăng dây' : 'Equip fishing rod; hold click to cast'}
                </li>
                <li>
                  <kbd>P</kbd>
                  {vi ? 'Mở chế độ chụp ảnh và tạo dáng' : 'Open Photo Studio and poses'}
                </li>
                <li>
                  <kbd>M</kbd>
                  {vi ? 'Mở bản đồ toàn quần đảo' : 'Open full archipelago map'}
                </li>
                <li>
                  <kbd>B</kbd>
                  {vi ? 'Mở sổ tay sinh vật biển và trái cây' : 'Open marine and fruit logbook'}
                </li>
                <li>
                  <kbd>{vi ? 'Chuột' : 'Mouse'}</kbd>
                  {vi ? 'Kéo để nhìn; bấm vào cảnh để dùng chuột' : 'Drag to look; click the scene for mouse look'}
                </li>
                <li>
                  <kbd>{keys.actions}</kbd>
                  {vi ? 'Mở cử chỉ; 1 đến 5 làm ngay' : 'Gesture menu; 1 to 5 at once'}
                </li>
                <li>
                  <kbd>Space</kbd>
                  {vi ? 'Nhảy, phóng khỏi thuyền xuống nước, trồi lên hoặc đứng dậy' : 'Jump, leap off boat into water, surface, or stand up'}
                </li>
                <li>
                  <kbd>Esc</kbd>
                  {vi ? 'Thả chuột hoặc đóng bảng' : 'Release mouse or close card'}
                </li>
                <li>
                  <kbd>{keys.camera}</kbd>
                  {vi ? 'Đổi góc nhìn' : 'Switch camera'}
                </li>
                <li>
                  <kbd>{keys.hud}</kbd>
                  {vi ? 'Ẩn hoặc hiện thanh công cụ' : 'Hide or show the bars'}
                </li>
                <li>
                  <kbd>{keys.settings}</kbd>
                  {vi ? 'Cài đặt đồ họa và âm thanh' : 'Graphics and audio settings'}
                </li>
              </ul>
            )}
          </div>
          {gestures && (
            <ActionWheel
              open
              onOpen={setGestures}
              binding={
                keys.actions.length === 1
                  ? ('0123456789'.includes(keys.actions) ? 'Digit' : 'Key') + keys.actions
                  : keys.actions
              }
              title={vi ? 'Cử chỉ' : 'Gestures'}
              vi={vi}
              actions={embodiedLabels.map(([kind, , vn, en]) => ({
                id: kind,
                label: vi ? vn : en,
                run: () => express(kind),
              }))}
              onChoose={run => {
                setGestures(false);
                run();
              }}
            />
          )}
          <nav
            {...modes}
            className={`${styles.cameraModes} ${modes.className}`}
            aria-label={vi ? 'Góc nhìn Arena' : 'Arena camera'}
          >
            {(['overview', 'third', 'first'] as const).map((m, i) => (
              <button type="button" key={m} data-testid={`arena-view-${m}`} aria-pressed={view === m} onClick={() => setView(m)}>
                {(vi ? ['Toàn cảnh', 'Theo nhân vật', 'Góc nhìn thứ nhất'] : ['Overview', 'Third person', 'First person'])[i]}
              </button>
            ))}
          </nav>
          <div className={styles.touchPad} aria-label={vi ? 'Di chuyển' : 'Move'}>
            {[
              ['↑', 0, -1],
              ['←', -1, 0],
              ['↓', 0, 1],
              ['→', 1, 0],
            ].map(([label, x, y]) => (
              <button
                key={String(label)}
                aria-label={`${vi ? 'Di chuyển' : 'Move'} ${label}`}
                onPointerDown={e => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  joystick.current = { x: Number(x), y: Number(y) };
                }}
                onPointerUp={() => {
                  joystick.current = { x: 0, y: 0 };
                }}
                onPointerCancel={() => {
                  joystick.current = { x: 0, y: 0 };
                }}
                onLostPointerCapture={() => {
                  joystick.current = { x: 0, y: 0 };
                }}
              >
                {label === '↑' ? <ChevronUp /> : label === '←' ? <ChevronLeft /> : label === '↓' ? <ChevronDown /> : <ChevronRight />}
              </button>
            ))}
          </div>
        </>
      )}

      {s && connectedVoice && voice.published && me?.canSpeak && !hud.shown.bottom && (
        <div className={styles.micLive} role="status" data-testid="arena-mic-live">
          <Mic size={14} />
          {vi ? 'Micro đang bật' : 'Mic is on'}
        </div>
      )}
      {hud.hint && !hud.shown.bottom && (
        <div className={[hudStyles.hint, styles.edgeHint].join(' ')} role="status" data-testid="hud-hint">
          {vi ? (
            <>
              Đưa chuột xuống mép dưới hoặc nhấn <kbd>{keys.hud}</kbd> để hiện thanh công cụ
            </>
          ) : (
            <>
              Move to the bottom edge or press <kbd>{keys.hud}</kbd> for the bars
            </>
          )}
        </div>
      )}
      {displayError && (
        <div className={styles.error} role="alert">
          <span>{arenaError(displayError, vi)}</span>
          {voice.error === 'AUDIO_BLOCKED' && (
            <button onClick={() => void voice.resumeAudio()}>{vi ? 'Bật âm thanh' : 'Enable audio'}</button>
          )}
          <button
            aria-label={vi ? 'Đóng thông báo' : 'Dismiss'}
            onClick={() => {
              room.dismissError();
              voice.dismissError();
            }}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <dialog ref={kickDialog} className={styles.dialog} onClose={() => setConfirmKick(null)} aria-labelledby="kick-title">
        <h2 id="kick-title">{vi ? 'Mời người này ra khỏi phòng?' : 'Remove this person from the room?'}</h2>
        <p>
          {vi
            ? 'Họ sẽ bị ngắt voice và không thể tham gia lại phòng này.'
            : 'Their voice will disconnect and they cannot rejoin this room.'}
        </p>
        <div className={styles.row}>
          <button autoFocus className={styles.secondary} onClick={() => setConfirmKick(null)}>
            {vi ? 'Hủy' : 'Cancel'}
          </button>
          <button
            className={styles.primary}
            onClick={() => {
              if (confirmKick) room.send('kick', { target: confirmKick });
              setConfirmKick(null);
            }}
          >
            {vi ? 'Mời ra' : 'Remove'}
          </button>
        </div>
      </dialog>
      {person !== null && <PersonCard portalHost={overlayRoot.current} userId={person} onClose={() => setPerson(null)} />}
      {chat && (
        <RoomWindow
          messenger
          conversation={chat.id}
          onClose={() => setChat(null)}
          onOutside={href => {
            location.href = href;
          }}
          onEnterArena={c => {
            setChat(null);
            setJoinCode(c.toUpperCase());
          }}
        />
      )}
    </div>
  );
}
