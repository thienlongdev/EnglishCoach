'use client';
import { useEffect, useRef, useState, type RefObject } from 'react';
import * as T from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ArenaAmbience } from './arenaAmbience';
import { ArenaBoatFleet } from './arenaBoats';
import type {
  ArenaPhotoState,
  ArenaQualityTier,
  ArenaSwimFrame,
  ArenaTimeOfDay,
  CaughtFishRecord,
  FishingHudState,
  FruitHarvestLog,
  MarineCollectionState,
  MarineSpeciesSpec,
  MinimapPeerMarker,
  MinimapSnapshot,
  MinimapWaypoint,
} from './arenaContracts';
import { arenaCast } from './arenaAssets';
import { ArenaCamera, type ArenaView } from './ArenaCamera';
import { ArenaCharacter, type ArenaCharacterArchipelagoState } from './ArenaCharacter';
import { arenaLookouts } from './arenaCopy';
import { ArenaFishingController } from './arenaFishing';
import { ArenaFruitTrees } from './arenaFruitTrees';
import {
  ArenaSwimGuideTimer,
  GROUND_SEAT_ID,
  findNearestFreeSeat,
  selectContextualAction,
  type ContextualAction,
} from './arenaInteractions';
import { ArenaMarineEcosystem } from './arenaMarineLife';
import { ArenaMotor, STEP, type ArenaMotion } from './arenaMotion';
import {
  captureArenaCanvasToPng,
  sanitizeArenaPhotoCssFilter,
} from './ArenaPhotoStudio';
import {
  ARENA_QUALITY_CONFIGS,
  applyQualityToRendererInPlace,
  detectHardwareQualityTier,
} from './arenaQuality';
import { type SeaWakeSource } from './arenaSea';
import {
  ArenaIslandStreamer,
  ArenaResidencyManager,
  ArenaRuntimeProfiler,
  ArenaTimeSlicer,
  bindArenaWindowProfiler,
  warmupArenaShadersAndTextures,
  type ArenaPreparationProgress,
} from './arenaStreaming';
import {
  ArenaSwimmingController,
  SwimVisualEffects,
  evaluatePeerSwimFrame,
} from './arenaSwimming';
import {
  ARENA_WATER_Y,
  arenaBathymetry,
  arenaFloor,
  arenaHeight,
  arenaIslandAt,
  arenaLayout,
  arenaOnWood,
  arenaSeats,
  arenaStep,
  arenaSupportY,
  arenaWaterDepth,
} from './arenaTerrain';
import { buildArenaWorld } from './arenaWorld';
import { ScenePassage, takeWorldPassage } from '@/lib/morph/scene';
import { embodiedKeys, type EmbodiedAction } from '@/lib/embodiment/actions';
import type { HandContact } from '@/lib/embodiment/human';
import { MouseLook, prefersFreePointer, rememberFreePointer, type MouseLookState } from '@/lib/embodiment/mouseLook';
import type { ArenaState, ArenaAudioSpace, ArenaBoatRole } from '@/types/speakingArena';
import styles from './arena.module.css';
import type { EdgeBinding } from '@/lib/hud/edgeReveal';

export interface ActiveWorldInspect {
  kind: 'kiosk' | 'artifact' | 'telescope';
  id: string;
  x: number;
  z: number;
}

export interface FishingControlBridge {
  castOrStrike: () => void;
  beginCastCharge?: () => void;
  releaseCastCharge?: () => void;
  dismissCatch?: () => void;
  setReeling: (held: boolean) => void;
  unequip: () => void;
  toggleEquip: () => void;
}

export interface PhotoControlBridge {
  resetCamera: () => void;
  capture: (cssFilter: string) => Promise<{ dataUrl: string; downloaded: boolean; width: number; height: number } | null>;
}

export interface ArenaSceneProps {
  onSeat: (action: 'sit' | 'stand', seatId?: string) => void;
  onBoat?: (
    action: 'board' | 'disembark' | 'jump-overboard' | 'boat-free' | 'engine' | 'climb-dock',
    boatId?: string,
    value?: boolean,
    aux?: number,
  ) => void;
  onBeacon?: (beaconId: string) => void;
  activeInspect?: ActiveWorldInspect | null;
  artifactTurn?: number;
  onInspect?: (target: ActiveWorldInspect | null) => void;
  inspect?: boolean;
  inspectItem?: boolean;
  onPlaceable?: (tableId: string | null) => void;
  onPlace?: (tableId: string) => void;
  placeRequest?: { current: ((tableId: string) => void) | null };
  onReleased?: () => void;
  environmentVolume: number;
  view: ArenaView;
  blocked: boolean;
  photoState?: ArenaPhotoState;
  photoControlRef?: { current: PhotoControlBridge | null };
  action: { id: number; kind: EmbodiedAction } | null;
  onAction: (action: EmbodiedAction) => void;
  state: ArenaState | null;
  hero: 'LYRA' | 'KAI';
  look?: string;
  speakers: string[];
  low: boolean;
  qualityTier?: ArenaQualityTier;
  timeOfDay?: ArenaTimeOfDay;
  accountScope?: string | number | null;
  voiceActive?: boolean;
  waypoint?: MinimapWaypoint | null;
  minimapRef?: { current: MinimapSnapshot | null };
  fishingHudRef?: { current: FishingHudState | null };
  fishingControlRef?: { current: FishingControlBridge | null };
  onFishingStateChange?: (hud: FishingHudState) => void;
  onMarineCatch?: (record: CaughtFishRecord, species: MarineSpeciesSpec, collection: MarineCollectionState) => void;
  onFruitHarvestChange?: (log: FruitHarvestLog, toast?: { en: string; vi: string }) => void;
  onQualityAutoDetected?: (tier: ArenaQualityTier) => void;
  vi: boolean;
  space: RefObject<ArenaAudioSpace>;
  connected: boolean;
  motion: ArenaMotion;
  move: (x: number, z: number, yaw: number, jump: boolean, diveDepth?: number) => boolean;
  row?: (x: number, z: number, yaw: number, rowPhase: number, throttle?: number, steering?: number) => boolean;
  joystick: RefObject<{ x: number; y: number }>;
  onStats: (value: { fps: number; draws: number; triangles: number }) => void;
  cursor: boolean;
  mouseTick?: number;
  helpTick?: number;
  revealSwimHintsTick?: number;
  onLock?: (locked: boolean) => void;
  onPlayer?: (userId: number) => void;
  edge?: EdgeBinding;
}

const WALK_SPEED = 1.55;
const JOG_SPEED = 2.45;
const RUN_SPEED = 3.35;
const SPRINT_SPEED = 4.45;

export default function ArenaScene(props: ArenaSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  live.current = props;
  const retained = useRef({ pose: { x: 0, z: 2, yaw: 0 }, yaw: Math.PI + 0.16, pitch: -0.06, zoom: 12 });
  const lock = useRef<MouseLook | null>(null);
  const [look, setLook] = useState<MouseLookState>({
    desired: false,
    locked: false,
    needsResume: false,
    cursorRequired: false,
  });
  const toggleMouse = () => {
    if (lock.current) {
      lock.current.toggle();
      rememberFreePointer(!lock.current.desired);
    }
  };

  const [promptPill, setPromptPill] = useState<ContextualAction | null>(null);
  const currentPromptRef = useRef<ContextualAction | null>(null);
  const triggerRef = useRef<() => void>(() => {});

  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [prepProgress, setPrepProgress] = useState<ArenaPreparationProgress>({
    stage: 'terrain',
    fraction: 0.12,
    detailEn: 'Sculpting tropical archipelago',
    detailVi: 'Đang kiến tạo địa hình quần đảo',
  });

  // Live imperative handles so quality, atmosphere, and account changes mutate in place without tearing down WebGL!
  const sceneHandlesRef = useRef<{
    renderer: T.WebGLRenderer;
    world: ReturnType<typeof buildArenaWorld>;
    fleet: ArenaBoatFleet;
    marine: ArenaMarineEcosystem;
    fishing: ArenaFishingController;
    fruitTrees: ArenaFruitTrees;
    streamer: ArenaIslandStreamer;
    profiler: ArenaRuntimeProfiler;
    ambience: ArenaAmbience;
    setActiveTier: (tier: ArenaQualityTier) => void;
    setActiveTimeOfDay: (tod: ArenaTimeOfDay) => void;
    revealSwimHints: () => void;
  } | null>(null);

  useEffect(() => {
    lock.current?.cursorNeeded('menu', props.cursor);
  }, [props.cursor]);

  const opticalLabel = useRef<HTMLOutputElement>(null);
  const firstTick = useRef(props.mouseTick ?? 0);
  useEffect(() => {
    if ((props.mouseTick ?? 0) === firstTick.current) return;
    firstTick.current = props.mouseTick ?? 0;
    if (live.current.view !== 'overview' && !live.current.blocked) toggleMouse();
  }, [props.mouseTick]);

  const firstHelpTick = useRef((props.helpTick ?? 0) + (props.revealSwimHintsTick ?? 0));
  useEffect(() => {
    const combined = (props.helpTick ?? 0) + (props.revealSwimHintsTick ?? 0);
    if (combined === firstHelpTick.current) return;
    firstHelpTick.current = combined;
    sceneHandlesRef.current?.revealSwimHints();
  }, [props.helpTick, props.revealSwimHintsTick]);

  // Live in-place Quality Tier & Time-of-Day synchronization (ZERO WebGLRenderer recreation!)
  const resolvedTier: ArenaQualityTier = props.qualityTier ?? (props.low ? 'low' : 'high');
  const resolvedTod: ArenaTimeOfDay = props.timeOfDay ?? 'daylight';

  useEffect(() => {
    sceneHandlesRef.current?.setActiveTier(resolvedTier);
  }, [resolvedTier]);

  useEffect(() => {
    sceneHandlesRef.current?.setActiveTimeOfDay(resolvedTod);
  }, [resolvedTod]);

  useEffect(() => {
    const h = sceneHandlesRef.current;
    if (!h) return;
    h.fishing.setAccount(props.accountScope);
    h.fruitTrees.setAccount(props.accountScope);
    props.onFruitHarvestChange?.({ ...h.fruitTrees.getHarvestLog() });
  }, [props.accountScope]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    setFailed(false);
    setLoaded(false);

    let renderer: T.WebGLRenderer;
    try {
      renderer = new T.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch {
      setFailed(true);
      return;
    }

    const hwTier = detectHardwareQualityTier(renderer.getContext());
    if (!live.current.qualityTier) {
      live.current.onQualityAutoDetected?.(hwTier);
    }
    let activeTier: ArenaQualityTier = live.current.qualityTier ?? (live.current.low ? 'low' : hwTier);
    let activeTod: ArenaTimeOfDay = live.current.timeOfDay ?? 'daylight';
    const initCfg = ARENA_QUALITY_CONFIGS[activeTier];

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, initCfg.maxPixelRatio));
    renderer.shadowMap.enabled = initCfg.shadowEnabled;
    renderer.shadowMap.type = T.PCFShadowMap;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.03;
    renderer.outputColorSpace = T.SRGBColorSpace;
    element.append(renderer.domElement);
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute(
      'aria-label',
      live.current.vi
        ? 'Quần đảo hội thoại 3D. Dùng WASD để đi bộ, bơi lặn, chèo thuyền và tương tác.'
        : '3D conversation archipelago. Use WASD to walk, swim, sail and interact.',
    );

    const residency = new ArenaResidencyManager();
    const profiler = new ArenaRuntimeProfiler(activeTier);
    const unbindProfiler = bindArenaWindowProfiler(profiler, residency);

    const scene = new T.Scene();
    const rig = new ArenaCamera();
    const camera = rig.camera;
    const world = buildArenaWorld(scene, {
      quality: activeTier,
      timeOfDay: activeTod,
      residency,
    });
    const fleet = new ArenaBoatFleet(scene, activeTier === 'low');
    const marine = new ArenaMarineEcosystem(scene, activeTier);
    if (typeof world.underwater.getSharedOpticsUniforms === 'function') {
      marine.bindUnderwaterOptics(world.underwater.getSharedOpticsUniforms());
    }
    const swimFx = new SwimVisualEffects(scene, activeTier);
    const streamer = new ArenaIslandStreamer({
      islands: arenaLayout.islands,
      residency,
      qualityTier: activeTier,
      startingIslandId: 'commons',
    });

    const ambience = new ArenaAmbience();
    ambience.setWaterfallPos(world.waterfallPos.x, world.waterfallPos.y, world.waterfallPos.z, true);
    ambience.setBrookMouthPos(world.oceanOutflowPos.x, world.oceanOutflowPos.y, world.oceanOutflowPos.z, true);

    const fishing = new ArenaFishingController(scene, live.current.accountScope, {
      onCatch: (record, species, collection) => {
        live.current.onMarineCatch?.(record, species, collection);
      },
    });
    const fruitTrees = new ArenaFruitTrees(scene, live.current.accountScope, {
      low: activeTier === 'low',
      onCollect: ev => {
        live.current.onFruitHarvestChange?.(
          { ...fruitTrees.getHarvestLog() },
          { en: ev.toastEn, vi: ev.toastVi },
        );
      },
    });

    rig.yaw = retained.current.yaw;
    rig.pitch = retained.current.pitch;
    rig.zoom = retained.current.zoom;
    const passage = new ScenePassage(takeWorldPassage('/speaking/arena'));
    scene.add(camera);

    let lastAction = 0;
    const footPhase = new Map<string, number>();
    const characters = new Map<string, ArenaCharacter>();
    const labels = new Map<string, HTMLDivElement>();
    const templates = new Map<string, GLTF>();
    const loader = new GLTFLoader();
    const keys = new Set<string>();
    const focus = new T.Vector3();
    const desired = new T.Vector3();
    const plane = new T.Plane(new T.Vector3(0, 1, 0), 0);
    const ray = new T.Raycaster();
    const camFwdVec = new T.Vector3();
    const repelVec = new T.Vector3();
    const bobberWorldVec = new T.Vector3();
    const peerSwimScratch: ArenaSwimFrame = {
      mode: 'land',
      waterDepth: 0,
      submersion: 0,
      diveDepth: 0,
      strokeSpeed: 0,
      pitch: 0,
    };

    let disposed = false;
    let gameplayReady = false;
    let raf = 0;
    let last = performance.now();
    let time = 0;
    let frames = 0;
    let statAt = last;
    let drag: { id: number; x: number; y: number } | null = null;
    let photoDrag: { id: number; x: number; y: number; pan: boolean } | null = null;
    let wasPhotoOpen = false;
    let savedPrePhotoCam: { yaw: number; pitch: number; zoom: number } | null = null;
    let pendingOverboardLaunch: { vx: number; vz: number; until: number } | null = null;
    let prevFocusX = 0;
    let prevFocusZ = 2;
    let hasPrevFocus = false;
    let lastView = live.current.view;
    let walkTo: T.Vector3 | null = null;
    let room = '';
    let moveYaw = 0;
    let bobWeight = 0;
    let sprintHoldSec = 0;
    let diveTogglePending = false;
    let reelMouseHeld = false;
    let uiReelHeld = false;
    let lastFishingPhase = '';
    let lastCatchTimestamp = 0;

    const velocity = new T.Vector2();
    const swimController = new ArenaSwimmingController(0, 2);
    const swimGuideTimer = new ArenaSwimGuideTimer();
    const combinedWakes: SeaWakeSource[] = [];
    const peerMarkersPool: MinimapPeerMarker[] = [];

    let seat: string | null = null;
    let soloSeat: string | null = null;
    let seatMoveHoldSec = 0;
    let lastStandReqAt = 0;
    let boatId: string | null = null;
    let boatRole: ArenaBoatRole | null = null;
    let binding = -1;
    let motor: ArenaMotor | null = null;
    let accumulator = 0;
    let lastAck = -1;
    let settleUntil = 0;
    let jumpUntil = 0;
    let boatHintUntil = 0;
    let sentPose = { x: Infinity, z: Infinity, yaw: Infinity, dive: 0 };
    let sentBoatPose = { x: Infinity, z: Infinity, yaw: Infinity, phase: Infinity };
    let correction = { x: 0, z: 0 };

    const heldItems = new Set<string>();
    const occupiedSeatsPool = new Set<string>();
    const litBeaconsPool = new Set<string>();
    const peerKinematics = new Map<string, { x: number; z: number; speed: number }>();
    const seatTopById = new Map<string, number>();
    for (const f of arenaLayout.furniture) {
      if (!f.seats) continue;
      for (let i = 0; i < f.seats; i++) {
        seatTopById.set(`${f.id}-${i}`, f.top);
      }
    }
    const seatFloorElevation = (st: { id: string; x: number; z: number; y: number; yaw: number }): number => {
      const baseFloor = st.y - (seatTopById.get(st.id) ?? (st.id.startsWith('tier') ? 0.45 : 0.5275));
      if (!st.id.startsWith('tier')) return baseFloor;
      const footFloor = arenaFloor(st.x + Math.sin(st.yaw) * 0.55, st.z + Math.cos(st.yaw) * 0.55);
      return Math.max(baseFloor, Math.min(st.y - 0.36, footFloor));
    };
    const seatTopForId = (seatId: string): number => {
      const st = arenaSeats.find(s => s.id === seatId);
      if (!st) return seatTopById.get(seatId) ?? (seatId.startsWith('tier') ? 0.45 : 0.5275);
      return st.y - seatFloorElevation(st);
    };

    const groundTerrainAt = (x: number, z: number): number =>
      Math.max(world.sampleGroundSurface(x, z), ARENA_WATER_Y - 0.95);

    const surfaceAtArena = (probe: T.Vector3, outNormal: T.Vector3): number =>
      world.sampleGroundSurface(probe.x, probe.z, outNormal, probe.y);

    const computeSeatStandPose = (seatId: string | null) => {
      if (seatId === GROUND_SEAT_ID) {
        const fx = motor?.x ?? previewPose.x;
        const fz = motor?.z ?? previewPose.z;
        const own = characters.get(live.current.state?.self ?? 'preview');
        return {
          x: fx,
          z: fz,
          y: arenaSupportY(fx, fz),
          yaw: own?.root.rotation.y ?? previewPose.yaw,
        };
      }
      const st = seatId ? arenaSeats.find(x => x.id === seatId) : null;
      if (!st) {
        const fx = motor?.x ?? previewPose.x;
        const fz = motor?.z ?? previewPose.z;
        return { x: fx, z: fz, y: arenaSupportY(fx, fz), yaw: previewPose.yaw };
      }
      const fx = Math.sin(st.yaw);
      const fz = Math.cos(st.yaw);
      const rx = Math.cos(st.yaw);
      const rz = -Math.sin(st.yaw);
      const offsets: readonly [number, number][] = [
        [0.82, 0],
        [0.82, -0.45],
        [0.82, 0.45],
        [0.98, 0],
        [-0.82, 0],
      ];
      for (const [fwdOff, sideOff] of offsets) {
        const cx = st.x + fx * fwdOff + rx * sideOff;
        const cz = st.z + fz * fwdOff + rz * sideOff;
        const stepped = arenaStep(st.x, st.z, cx, cz, st.y);
        const supY = arenaSupportY(stepped.x, stepped.z);
        if (supY < st.y - 0.18) {
          return { x: stepped.x, z: stepped.z, y: supY, yaw: st.yaw };
        }
      }
      const fallbackX = st.x + fx * 0.82;
      const fallbackZ = st.z + fz * 0.82;
      return { x: fallbackX, z: fallbackZ, y: arenaSupportY(fallbackX, fallbackZ), yaw: st.yaw };
    };

    const standFromSeat = (nowMs: number, immediate = false) => {
      const pNow = live.current;
      if (seat === GROUND_SEAT_ID || soloSeat === GROUND_SEAT_ID) {
        const dismount = computeSeatStandPose(GROUND_SEAT_ID);
        soloSeat = null;
        seat = null;
        previewPose = { x: dismount.x, z: dismount.z, yaw: dismount.yaw };
        if (motor) {
          motor.x = motor.previous.x = dismount.x;
          motor.z = motor.previous.z = dismount.z;
          motor.y = motor.previous.y = dismount.y;
          motor.vy = 0;
          motor.grounded = true;
        }
        swimController.syncPose(dismount.x, dismount.y, dismount.z, dismount.yaw);
        seatMoveHoldSec = 0;
        return;
      }
      if (pNow.state) {
        if (nowMs - lastStandReqAt > (immediate ? 80 : 450)) {
          lastStandReqAt = nowMs;
          pNow.onSeat('stand');
        }
      } else if (soloSeat) {
        const dismount = computeSeatStandPose(soloSeat);
        soloSeat = null;
        seat = null;
        previewPose = { x: dismount.x, z: dismount.z, yaw: dismount.yaw };
        if (motor) {
          motor.x = motor.previous.x = dismount.x;
          motor.z = motor.previous.z = dismount.z;
          motor.y = motor.previous.y = dismount.y;
          motor.vy = 0;
          motor.grounded = true;
        }
        swimController.syncPose(dismount.x, dismount.y, dismount.z, dismount.yaw);
      }
      seatMoveHoldSec = 0;
    };
    const inspectEye = new T.Vector3();
    const inspectAim = new T.Vector3();
    const inspectUp = new T.Vector3(0, 1, 0);
    const seatedEye = new T.Vector3();
    const holdEye = new T.Vector3();
    const holdLook = new T.Vector3();
    const eyeCheckVec = new T.Vector3();
    let placeable: string | null = null;

    const localPlace = (table: string) => {
      const p = live.current;
      const held = p.activeInspect as ActiveWorldInspect | null | undefined;
      const own = characters.get('preview');
      if (
        held?.kind === 'artifact' &&
        motor &&
        own &&
        world.tableItems.placeLocal(held.id, table, motor.x, motor.z, own.root.rotation.y)
      ) {
        p.onReleased?.();
      }
    };
    if (live.current.placeRequest) live.current.placeRequest.current = localPlace;

    const restView = new Map<string, { x: number; z: number }>();
    const itemRests = () => {
      for (const [id, item] of world.tableItems.items) restView.set(id, item.rest);
      return restView;
    };
    const inspectRotation = new T.Quaternion();
    const inspectMatrix = new T.Matrix4();
    let inspectBlend = 0;
    const transitionTargetVec = new T.Vector3();
    const seatTransitions = new Map<
      string,
      { boat: string | null; seat: string | null; boatChanged: boolean; from: T.Vector3; fromYaw: number; age: number }
    >();
    let beaconKey = '';
    const soloBeacons = new Set<string>(
      arenaLayout.interactables.filter(i => i.kind === 'beacon').map(i => i.id),
    );
    let savedLook: { yaw: number; pitch: number } | null = null;
    const opticalEye = new T.Vector3();
    let zoomedFov = ArenaCamera.FOV[live.current.view];
    let sceneReadyUnlocked = false;
    let tierWarmupPending = false;
    let tierWarmupSeq = 0;

    const setActiveTier = (tier: ArenaQualityTier) => {
      if (tier === activeTier) return;
      activeTier = tier;
      applyQualityToRendererInPlace(
        renderer,
        world.sun,
        tier,
        element.clientWidth,
        element.clientHeight,
      );
      world.setQuality(tier);
      fleet.setQuality(tier);
      marine.setQuality(tier);
      fruitTrees.setQuality(tier === 'low');
      streamer.setQualityTier(tier);
      profiler.setTier(tier);

      if (sceneReadyUnlocked && !disposed) {
        const mySeq = ++tierWarmupSeq;
        tierWarmupPending = true;
        const maybeAsync = renderer as T.WebGLRenderer & {
          compileAsync?: (s: T.Object3D, c: T.Camera, targetScene?: T.Scene) => Promise<unknown>;
        };
        const safetyTimer = window.setTimeout(() => {
          if (tierWarmupSeq === mySeq) tierWarmupPending = false;
        }, 750);
        void (async () => {
          try {
            world.warmupEnvironmentSystems(renderer, camera);
            marine.warmup(renderer, scene, camera);
            if (typeof maybeAsync.compileAsync === 'function') {
              await maybeAsync.compileAsync(scene, camera, scene);
            }
            if (tier !== 'low' && world.underwater?.godRays?.warmupSubmergedPipeline) {
              await world.underwater.godRays.warmupSubmergedPipeline(
                renderer,
                scene,
                camera,
                undefined,
                () => disposed || tierWarmupSeq !== mySeq,
              );
            }
          } catch {
            // Fall through safely on context loss
          } finally {
            window.clearTimeout(safetyTimer);
            if (tierWarmupSeq === mySeq) tierWarmupPending = false;
          }
        })();
      }
    };

    const setActiveTimeOfDay = (tod: ArenaTimeOfDay) => {
      activeTod = tod;
      world.setTimeOfDay(tod);
    };

    sceneHandlesRef.current = {
      renderer,
      world,
      fleet,
      marine,
      fishing,
      fruitTrees,
      streamer,
      profiler,
      ambience,
      setActiveTier,
      setActiveTimeOfDay,
      revealSwimHints: () => swimGuideTimer.revealNow(),
    };

    if (live.current.fishingControlRef) {
      live.current.fishingControlRef.current = {
        castOrStrike: () => {
          const selfId = live.current.state?.self ?? 'preview';
          const ownChar = characters.get(selfId);
          const px = ownChar ? ownChar.root.position.x : motor?.x ?? 0;
          const py = ownChar ? ownChar.root.position.y : motor?.y ?? 0;
          const pz = ownChar ? ownChar.root.position.z : motor?.z ?? 0;
          fishing.triggerPrimaryAction(px, py, pz, rig.yaw, ambience, marine);
        },
        beginCastCharge: () => {
          const canFish = swimController.frame.mode === 'land' || (Boolean(boatId) && boatRole === 'PASSENGER');
          const selfId = live.current.state?.self ?? 'preview';
          const ownChar = characters.get(selfId);
          const px = ownChar ? ownChar.root.position.x : motor?.x ?? 0;
          const py = ownChar ? ownChar.root.position.y : motor?.y ?? 0;
          const pz = ownChar ? ownChar.root.position.z : motor?.z ?? 0;
          fishing.beginCastCharge(px, py, pz, rig.yaw, canFish);
        },
        releaseCastCharge: () => {
          const selfId = live.current.state?.self ?? 'preview';
          const ownChar = characters.get(selfId);
          const px = ownChar ? ownChar.root.position.x : motor?.x ?? 0;
          const py = ownChar ? ownChar.root.position.y : motor?.y ?? 0;
          const pz = ownChar ? ownChar.root.position.z : motor?.z ?? 0;
          fishing.releaseCastCharge(px, py, pz, rig.yaw, ambience, marine);
        },
        dismissCatch: () => {
          fishing.cancelCastCharge();
        },
        setReeling: (held: boolean) => {
          uiReelHeld = held;
        },
        unequip: () => {
          fishing.stowRod();
        },
        toggleEquip: () => {
          const canFish = swimController.frame.mode === 'land' || (Boolean(boatId) && boatRole === 'PASSENGER');
          fishing.toggleEquip(canFish);
        },
      };
    }

    if (live.current.photoControlRef) {
      live.current.photoControlRef.current = {
        resetCamera: () => {
          const selfId = live.current.state?.self ?? 'preview';
          const ownChar = characters.get(selfId);
          rig.resetPhotoOrbit(ownChar?.root.rotation.y ?? rig.yaw, live.current.photoState?.fov ?? 48);
        },
        capture: async (cssFilter: string) => {
          renderer.domElement.style.filter = '';
          world.renderScene(renderer, camera);
          const res = await captureArenaCanvasToPng(
            renderer.domElement,
            sanitizeArenaPhotoCssFilter(cssFilter),
          );
          const activeCss = live.current.photoState?.open
            ? sanitizeArenaPhotoCssFilter(live.current.photoState.cssFilter)
            : 'none';
          renderer.domElement.style.filter = activeCss === 'none' ? '' : activeCss;
          return res;
        },
      };
    }

    const motionMedia = matchMedia('(prefers-reduced-motion: reduce)');
    const qa =
      ['localhost', '127.0.0.1', 'arena-a.localhost'].includes(location.hostname) &&
      location.search.includes('arenaDiagnostics');
    let previewPose = { ...retained.current.pose };

    const setDiveForQa = (enable: boolean): boolean => {
      const px = motor?.x ?? previewPose.x;
      const pz = motor?.z ?? previewPose.z;
      if (enable) {
        if (swimController.frame.mode === 'underwater_dive') return true;
        if (swimController.frame.mode !== 'surface_swim') {
          if (arenaWaterDepth(px, pz) < 2.2 || arenaOnWood(px, pz)) return false;
          const surfaceY = ARENA_WATER_Y - 1.26;
          if (motor) {
            motor.x = motor.previous.x = px;
            motor.z = motor.previous.z = pz;
            motor.y = motor.previous.y = surfaceY;
            motor.vy = 0;
            motor.grounded = false;
          }
          swimController.syncPose(px, surfaceY, pz, rig.yaw);
          swimController.step({
            dt: 1 / 60,
            time,
            forward: 0,
            right: 0,
            cameraYaw: rig.yaw,
            cameraPitch: rig.pitch,
            sprint: false,
            ascend: false,
            diveHeld: false,
            diveTogglePressed: false,
          });
        }
        diveTogglePending = true;
        return true;
      }
      if (swimController.frame.mode === 'underwater_dive') {
        diveTogglePending = true;
      }
      return true;
    };

    const envTelemetry = {
      waterfallStations: () => world.waterfall.stations.length,
      waterfallStages: () => world.waterfall.stations,
      waterfallPos: () => world.waterfallPos.toArray(),
      oceanOutflowPos: () => world.oceanOutflowPos.toArray(),
      grassTufts: () => world.grass.totalTufts,
      grassPlacementsByIsland: () => Object.fromEntries(world.grass.placementsByIsland),
      activeBirds: () => world.skyBirds.getActiveBirdCount(),
      leapingFish: () => marine.getActiveLeapingFishCount(),
      triggerDemoLeap: () => marine.triggerDemoLeapNear(motor?.x ?? previewPose.x, motor?.z ?? previewPose.z),
      swimGuideState: () => swimGuideTimer.getState(),
      revealSwimGuide: () => swimGuideTimer.revealNow(),
      swimMode: () => swimController.frame.mode,
      setDiveForQa,
    };
    if (typeof window !== 'undefined') {
      (window as unknown as { __EC_ARENA_ENV__?: unknown }).__EC_ARENA_ENV__ = envTelemetry;
    }

    if (qa) {
      (window as unknown as { __arenaQA?: unknown }).__arenaQA = {
        ...envTelemetry,
        place: (x: number, z: number, yaw = rig.yaw, yOverride?: number) => {
          previewPose = { x, z, yaw };
          fleet.clearSolo();
          soloSeat = null;
          seatMoveHoldSec = 0;
          boatId = null;
          boatRole = null;
          const floorY = yOverride ?? arenaSupportY(x, z);
          if (motor) {
            motor.x = motor.previous.x = x;
            motor.z = motor.previous.z = z;
            motor.y = motor.previous.y = floorY;
            motor.vy = 0;
            motor.grounded = true;
          }
          swimController.syncPose(x, floorY, z, yaw);
          const own = characters.get(live.current.state?.self ?? 'preview');
          if (own) {
            own.root.position.set(x, floorY, z);
            own.root.rotation.y = yaw;
            own.resetPosition();
          }
          rig.yaw = yaw;
        },
        look: (yaw: number, pitch: number, zoom?: number) => {
          rig.yaw = yaw;
          rig.pitch = pitch;
          if (zoom != null) rig.zoom = zoom;
        },
        boat: (id: string, x: number, z: number, yaw: number) => {
          const b = fleet.boats.get(id);
          if (!b) return false;
          b.x = b.prevX = x;
          b.z = b.prevZ = z;
          b.yaw = b.prevYaw = yaw;
          b.vx = b.vz = b.surge = b.speed = b.yawVel = 0;
          return true;
        },
        board: (id: string) => {
          fleet.boardSolo(id, 'preview');
          boatHintUntil = 0;
        },
        boats: () =>
          [...fleet.boats.values()].map(b => ({
            id: b.id,
            kind: b.kind,
            x: b.x,
            z: b.z,
            yaw: b.yaw,
            rower: b.rower,
            speed: b.speed,
          })),
        dive: (enable: boolean) => setDiveForQa(enable),
        equipRod: () => fishing.toggleEquip(true),
        castRod: () => {
          const own = characters.get(live.current.state?.self ?? 'preview');
          const px = own?.root.position.x ?? previewPose.x;
          const py = own?.root.position.y ?? 0;
          const pz = own?.root.position.z ?? previewPose.z;
          return fishing.triggerPrimaryAction(px, py, pz, rig.yaw, ambience, marine);
        },
        shakeNearestTree: () => {
          const own = characters.get(live.current.state?.self ?? 'preview');
          const px = own?.root.position.x ?? previewPose.x;
          const py = own?.root.position.y ?? 0;
          const pz = own?.root.position.z ?? previewPose.z;
          return fruitTrees.triggerInteraction(px, py, pz, rig.yaw, ambience);
        },
        setQuality: (tier: ArenaQualityTier) => setActiveTier(tier),
        setTimeOfDay: (tod: ArenaTimeOfDay) => setActiveTimeOfDay(tod),
        surfaceSchools: () =>
          marine.update({
            dt: 0.001,
            time,
            playerX: focus.x,
            playerY: focus.y,
            playerZ: focus.z,
          }),
        profile: () => profiler.snapshot(),
        skeletonAudit: () => {
          const own = characters.get(live.current.state?.self ?? 'preview');
          if (!own || !own.rig.ready) return null;
          own.root.updateMatrixWorld(true);
          const legs: Record<string, { signedKneeFlexDeg: number; ankleY: number }> = {};
          for (const leg of own.rig.legs) {
            const H = leg.thigh.getWorldPosition(new T.Vector3());
            const K = leg.shin.getWorldPosition(new T.Vector3());
            const A = leg.foot.getWorldPosition(new T.Vector3());
            const tq = leg.thigh.getWorldQuaternion(new T.Quaternion());
            const thighDir = K.clone().sub(H).normalize();
            const shinDir = A.clone().sub(K).normalize();
            const femurLeft = new T.Vector3(-1, 0, 0).applyQuaternion(tq).normalize();
            const flexMag = Math.acos(T.MathUtils.clamp(thighDir.dot(shinDir), -1, 1));
            const sign =
              flexMag < 0.01 ? 1 : new T.Vector3().crossVectors(thighDir, shinDir).dot(femurLeft) >= 0 ? 1 : -1;
            legs[leg.side < 0 ? 'L' : 'R'] = {
              signedKneeFlexDeg: +((flexMag * sign * 180) / Math.PI).toFixed(2),
              ankleY: +A.y.toFixed(3),
            };
          }
          const eyeW = own.eyeWorld(new T.Vector3());
          return {
            clip: own.locomotion,
            rootY: +own.root.position.y.toFixed(3),
            camToEyeMm: +(camera.position.distanceTo(eyeW) * 1000).toFixed(1),
            legs,
          };
        },
      };
    }

    const resize = () => {
      const w = Math.max(1, element.clientWidth);
      const h = Math.max(1, element.clientHeight);
      const cfg = ARENA_QUALITY_CONFIGS[activeTier];
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cfg.maxPixelRatio));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();

    const remove = (id: string) => {
      footPhase.delete(id);
      seatTransitions.delete(id);
      peerKinematics.delete(id);
      const c = characters.get(id);
      if (c) {
        scene.remove(c.root);
        c.dispose();
        characters.delete(id);
      }
      labels.get(id)?.remove();
      labels.delete(id);
    };

    const mouseLook = new MouseLook(renderer.domElement, state => {
      setLook(state);
      live.current.onLock?.(state.locked);
      if (!state.locked) keys.clear();
    });
    lock.current = mouseLook;

    const requested = new Set<string>();
    const loadHero = async (hero: 'LYRA' | 'KAI') => {
      if (requested.has(hero)) return;
      requested.add(hero);
      const gltf = await loader.loadAsync(arenaCast[hero]);
      if (disposed) {
        disposeTemplate(gltf);
        return;
      }
      templates.set(hero, gltf);
    };

    // Pre-Gameplay Cooperative Preparation + 360° `compileAsync` Shader Warmup Pipeline
    const slicer = new ArenaTimeSlicer(9.5);
    void (async () => {
      try {
        setPrepProgress({
          stage: 'islands',
          fraction: 0.34,
          detailEn: 'Loading archipelago islands and cast',
          detailVi: 'Đang tải quần đảo và nhân vật',
        });
        await Promise.all([
          loadHero('LYRA'),
          loadHero('KAI'),
          world.readyPromise,
          fleet.readyPromise,
          fishing.readyPromise,
          fruitTrees.readyPromise,
        ]);
        if (disposed) return;

        // Spawn initial character (and await custom wardrobe + fabric textures) BEFORE shader warmup so both dry & submerged skin/wardrobe shaders compile!
        const initHero = live.current.hero;
        const initTemplate = templates.get(initHero);
        let tempWarmupChar: ArenaCharacter | null = null;
        if (initTemplate && !characters.has('preview') && !live.current.state) {
          const previewChar = new ArenaCharacter(initTemplate, 0, initHero);
          previewChar.root.position.set(previewPose.x, world.sampleGroundSurface(previewPose.x, previewPose.z), previewPose.z);
          previewChar.root.rotation.y = previewPose.yaw;
          previewChar.resetPosition();
          await previewChar.dress(initHero, live.current.look);
          if (disposed) {
            previewChar.dispose();
            return;
          }
          scene.add(previewChar.root);
          characters.set('preview', previewChar);
          const label = document.createElement('div');
          label.className = styles.nameplate;
          label.hidden = true;
          element.append(label);
          labels.set('preview', label);
        } else if (initTemplate && characters.size === 0) {
          tempWarmupChar = new ArenaCharacter(initTemplate, 0, initHero);
          tempWarmupChar.root.position.set(previewPose.x, world.sampleGroundSurface(previewPose.x, previewPose.z), previewPose.z);
          await tempWarmupChar.dress(initHero, live.current.look);
          if (disposed) {
            tempWarmupChar.dispose();
            return;
          }
          scene.add(tempWarmupChar.root);
        }

        const initBeacons = [...soloBeacons];
        beaconKey = initBeacons.join(',');
        world.setBeacons(initBeacons);

        // Pre-bake environment IBL (`scene.environment`), underwater rock detail + first caustics pass
        // BEFORE `warmupArenaShadersAndTextures` so all 360° PBR & sea shaders compile with final `USE_ENVMAP` defines!
        world.underwater.attachRenderer(renderer);
        fishing.setWarmupVisible(true);
        focus.set(previewPose.x, world.sampleGroundSurface(previewPose.x, previewPose.z), previewPose.z);
        const initSurfaceSchools = marine.update({
          dt: 0.016,
          time: 0,
          playerX: focus.x,
          playerY: focus.y,
          playerZ: focus.z,
          camera,
        });
        world.update(0, focus, undefined, initSurfaceSchools, renderer, camera, undefined, 0.016);
        world.warmupEnvironmentSystems(renderer, camera);
        marine.warmup(renderer, scene, camera);

        const warmupMs = await warmupArenaShadersAndTextures({
          renderer,
          scene,
          camera,
          quality: ARENA_QUALITY_CONFIGS[activeTier],
          slicer,
          residency,
          underwaterGodRays: world.underwater.godRays,
          syncShadow: world.syncShadowForWarmup,
          aborted: () => disposed,
          onProgress: p => {
            if (!disposed) setPrepProgress(p);
          },
        });
        fishing.setWarmupVisible(false);
        if (tempWarmupChar) {
          scene.remove(tempWarmupChar.root);
          tempWarmupChar.dispose();
          tempWarmupChar = null;
        }
        if (disposed) return;

        profiler.setShaderWarmupMs(warmupMs);
        sceneReadyUnlocked = true;
        streamer.update(
          {
            playerX: previewPose.x,
            playerZ: previewPose.z,
            playerY: focus.y,
            velX: 0,
            velZ: 0,
            camForwardX: Math.sin(rig.yaw),
            camForwardZ: Math.cos(rig.yaw),
            elapsedSec: 0,
            renderer,
          },
          true,
        );
        profiler.resetWindow();
        gameplayReady = true;
        setLoaded(true);
      } catch {
        if (!disposed) setFailed(true);
      }
    })();

    const triggerOverboardJump = (): boolean => {
      if (!boatId) return false;
      const pNow = live.current;
      const b = fleet.boats.get(boatId);
      const preferSide = b
        ? Math.sin(rig.yaw - b.yaw) < -0.15
          ? -1
          : Math.sin(rig.yaw - b.yaw) > 0.15
            ? 1
            : 0
        : 0;
      fishing.stowRod();
      walkTo = null;
      if (pNow.state) {
        const launch = fleet.computeOverboardLaunch(boatId, boatRole ?? 'ROWER', preferSide);
        if (!launch) return false;
        pendingOverboardLaunch = {
          vx: launch.exitVx,
          vz: launch.exitVz,
          until: performance.now() + 1400,
        };
        fleet.spawnWaterSplash(launch.x, launch.z);
        if (pNow.environmentVolume > 0) ambience.interactCue(true);
        pNow.onBoat?.('jump-overboard', boatId, undefined, preferSide);
        return true;
      }
      const launch = fleet.jumpOverboardSolo(preferSide);
      if (!launch) return false;
      boatId = null;
      boatRole = null;
      const exitYaw = Math.atan2(launch.outboardX, launch.outboardZ);
      const swimY = ARENA_WATER_Y - 1.12;
      if (motor) {
        motor.x = motor.previous.x = launch.x;
        motor.z = motor.previous.z = launch.z;
        motor.y = motor.previous.y = swimY;
        motor.vy = 0;
        motor.grounded = false;
      }
      swimController.syncPose(launch.x, swimY, launch.z, exitYaw);
      swimController.vx = launch.exitVx;
      swimController.vz = launch.exitVz;
      swimController.step({
        dt: 1 / 60,
        time,
        forward: 0,
        right: 0,
        cameraYaw: rig.yaw,
        cameraPitch: rig.pitch,
        sprint: false,
        ascend: false,
        diveHeld: false,
        diveTogglePressed: false,
      });
      velocity.set(swimController.vx, swimController.vz);
      previewPose = { x: launch.x, z: launch.z, yaw: exitYaw };
      const own = characters.get('preview');
      if (own) {
        own.root.position.set(launch.x, swimController.y, launch.z);
        own.root.rotation.y = exitYaw;
      }
      if (pNow.environmentVolume > 0) ambience.interactCue(true);
      return true;
    };

    const executeContextual = () => {
      const p = live.current;
      if (p.environmentVolume > 0) ambience.unlock();

      const act = currentPromptRef.current;
      if (p.activeInspect && p.activeInspect.kind !== 'artifact') {
        p.onInspect?.(null);
        return;
      }
      if (!act || !act.canTrigger) return;

      const selfId = p.state?.self ?? 'preview';
      const ownChar = characters.get(selfId);

      if (act.kind === 'fishing-equip') {
        const canFish = swimController.frame.mode === 'land' || (Boolean(boatId) && boatRole === 'PASSENGER');
        fishing.toggleEquip(canFish);
        return;
      }
      if (act.kind === 'fishing-action') {
        const px = ownChar ? ownChar.root.position.x : motor?.x ?? 0;
        const py = ownChar ? ownChar.root.position.y : motor?.y ?? 0;
        const pz = ownChar ? ownChar.root.position.z : motor?.z ?? 0;
        fishing.triggerPrimaryAction(px, py, pz, rig.yaw, ambience, marine);
        return;
      }
      if (act.kind === 'shake-tree' || act.kind === 'collect-fruit') {
        const px = ownChar ? ownChar.root.position.x : motor?.x ?? 0;
        const py = ownChar ? ownChar.root.position.y : motor?.y ?? 0;
        const pz = ownChar ? ownChar.root.position.z : motor?.z ?? 0;
        if (fruitTrees.triggerInteraction(px, py, pz, rig.yaw, ambience)) {
          if (act.kind === 'shake-tree') ownChar?.triggerTreeShake();
          else ownChar?.triggerPickup();
        }
        return;
      }
      if (act.kind === 'climb-dock') {
        const dest = swimController.climbOutToDock();
        if (dest) {
          if (motor) {
            motor.x = motor.previous.x = dest.x;
            motor.z = motor.previous.z = dest.z;
            motor.y = motor.previous.y = dest.y;
            motor.vy = 0;
            motor.grounded = true;
          }
          previewPose = { x: dest.x, z: dest.z, yaw: dest.yaw };
          ownChar?.triggerWaterClimb();
          if (p.environmentVolume > 0) ambience.interactCue(true);
          if (p.state) {
            p.onBoat?.('climb-dock', dest.dockId);
            p.move(dest.x, dest.z, dest.yaw, false, 0);
          }
        }
        return;
      }
      if (act.kind === 'jump-overboard') {
        triggerOverboardJump();
        return;
      }

      if (act.kind === 'board') {
        walkTo = null;
        fishing.stowRod();
        const targetBoat = fleet.boats.get(act.id);
        if (targetBoat) rig.yaw = targetBoat.yaw;
        boatHintUntil = performance.now() + 6000;
        if (p.state) p.onBoat?.('board', act.id);
        else fleet.boardSolo(act.id, 'preview');
      } else if (act.kind === 'place') {
        const inspecting = p.activeInspect as ActiveWorldInspect | null | undefined;
        const id = p.state
          ? p.state.players.find(x => x.id === p.state!.self)?.artifact
          : inspecting?.kind === 'artifact'
            ? inspecting.id
            : null;
        if (id) {
          if (p.state) p.onPlace?.(act.id);
          else localPlace(act.id);
        }
      } else if (act.kind === 'boat-free') {
        if (p.state) p.onBoat?.('boat-free', act.id);
        else fleet.rescueSolo();
      } else if (act.kind === 'disembark') {
        fishing.stowRod();
        if (p.state) p.onBoat?.('disembark', act.id);
        else {
          const land = fleet.disembarkSolo();
          if (land && motor) {
            motor.x = motor.previous.x = land.x;
            motor.z = motor.previous.z = land.z;
            motor.y = motor.previous.y = land.y;
            motor.vy = 0;
            motor.grounded = true;
            swimController.syncPose(land.x, land.y, land.z, rig.yaw);
            previewPose = { x: land.x, z: land.z, yaw: rig.yaw };
          }
        }
      } else if (act.kind === 'sit') {
        walkTo = null;
        seatMoveHoldSec = 0;
        fishing.stowRod();
        if (p.state) p.onSeat('sit', act.id);
        else soloSeat = act.id;
      } else if (act.kind === 'stand') {
        standFromSeat(performance.now(), true);
      } else if (act.kind === 'beacon') {
        if (p.state) p.onBeacon?.(act.id);
        else {
          if (!soloBeacons.delete(act.id)) soloBeacons.add(act.id);
          world.setBeacons([...soloBeacons]);
        }
        if (p.environmentVolume > 0) ambience.interactCue(true);
      } else if (act.kind === 'kiosk' || act.kind === 'artifact' || act.kind === 'telescope') {
        fishing.stowRod();
        if (act.kind === 'artifact') ownChar?.express('inspect');
        if (act.kind === 'telescope') {
          savedLook = { yaw: rig.yaw, pitch: rig.pitch };
          rig.opticalZoom = 2;
          const spec = arenaLookouts[act.id];
          if (spec) {
            rig.yaw = Math.atan2(spec.targetX - act.x, spec.targetZ - act.z);
            rig.pitch = -0.04;
          }
        }
        if (p.environmentVolume > 0) ambience.interactCue(true);
        p.onInspect?.({ kind: act.kind, id: act.id, x: act.x, z: act.z });
      }
    };
    triggerRef.current = executeContextual;

    const active = () =>
      gameplayReady &&
      !live.current.blocked &&
      !live.current.photoState?.open &&
      (document.activeElement === renderer.domElement ||
        document.pointerLockElement === renderer.domElement ||
        document.activeElement === document.body ||
        document.activeElement === document.documentElement);

    const down = (e: KeyboardEvent) => {
      if (e.code === 'Escape' && live.current.activeInspect) {
        live.current.onInspect?.(null);
        return;
      }
      if (!active()) return;

      if (e.code === 'KeyR' && boatId && boatRole === 'ROWER') {
        const boat = fleet.boats.get(boatId);
        if (boat?.motor && !e.repeat) {
          e.preventDefault();
          if (live.current.state) live.current.onBoat?.('engine', boat.id, !boat.engine);
          else boat.engine = !boat.engine;
          if (live.current.environmentVolume > 0) ambience.unlock();
          return;
        }
      }

      if (e.code === 'KeyF' && !e.repeat) {
        const canFish = swimController.frame.mode === 'land' || (Boolean(boatId) && boatRole === 'PASSENGER');
        e.preventDefault();
        if (live.current.environmentVolume > 0) ambience.unlock();
        fishing.toggleEquip(canFish);
        return;
      }

      if (e.code === 'KeyC' && !e.repeat) {
        if (swimController.frame.mode === 'surface_swim' || swimController.frame.mode === 'underwater_dive') {
          e.preventDefault();
          diveTogglePending = true;
          return;
        }
        if (boatId) {
          return;
        }
        if (seat) {
          e.preventDefault();
          standFromSeat(performance.now(), true);
          return;
        }
        if (swimController.frame.mode === 'land' && (!motor || motor.grounded)) {
          const pNow = live.current;
          const selfId = pNow.state?.self ?? 'preview';
          const ownChar = characters.get(selfId);
          const holdingArtifact = pNow.state
            ? pNow.state.players.find(x => x.id === selfId)?.artifact
            : pNow.activeInspect?.kind === 'artifact'
              ? pNow.activeInspect.id
              : null;
          if (!holdingArtifact) {
            const px = motor?.x ?? ownChar?.root.position.x ?? previewPose.x;
            const py = motor?.y ?? ownChar?.root.position.y ?? 0;
            const pz = motor?.z ?? ownChar?.root.position.z ?? previewPose.z;
            const playersNow = pNow.state?.players ?? [];
            occupiedSeatsPool.clear();
            for (let i = 0; i < playersNow.length; i++) {
              const ps = playersNow[i].id === selfId ? seat : playersNow[i].seat;
              if (ps) occupiedSeatsPool.add(ps);
            }
            const freeSeat = findNearestFreeSeat(
              px,
              py,
              pz,
              pNow.view === 'overview' ? (ownChar?.root.rotation.y ?? rig.yaw) : rig.yaw,
              playersNow,
              occupiedSeatsPool,
              2.35,
            );
            if (freeSeat) {
              e.preventDefault();
              walkTo = null;
              seatMoveHoldSec = 0;
              fishing.stowRod();
              if (pNow.state) pNow.onSeat('sit', freeSeat.id);
              else soloSeat = freeSeat.id;
              return;
            }
            if (arenaHeight(px, pz) > ARENA_WATER_Y + 0.12 || arenaOnWood(px, pz)) {
              e.preventDefault();
              walkTo = null;
              seatMoveHoldSec = 0;
              fishing.stowRod();
              soloSeat = GROUND_SEAT_ID;
              return;
            }
          }
        }
      }

      if (e.code === 'KeyE') {
        if (!e.repeat && (currentPromptRef.current?.canTrigger || live.current.activeInspect)) {
          e.preventDefault();
          executeContextual();
          return;
        }
      }

      if (e.code === 'Space') {
        if (boatId) {
          e.preventDefault();
          if (!e.repeat) {
            if (!triggerOverboardJump() && currentPromptRef.current?.kind === 'disembark') {
              executeContextual();
            }
          }
          return;
        }
        if (seat) {
          e.preventDefault();
          if (!e.repeat) standFromSeat(performance.now(), true);
          return;
        }
        const fHud = fishing.getHudState();
        if (fHud.phase === 'equipped' || fHud.phase === 'caught' || fHud.phase === 'escaped') {
          e.preventDefault();
          if (!e.repeat) {
            const canFish = swimController.frame.mode === 'land' || (Boolean(boatId) && boatRole === 'PASSENGER');
            const selfId = live.current.state?.self ?? 'preview';
            const ownChar = characters.get(selfId);
            fishing.beginCastCharge(
              ownChar?.root.position.x ?? motor?.x ?? 0,
              ownChar?.root.position.y ?? motor?.y ?? 0,
              ownChar?.root.position.z ?? motor?.z ?? 0,
              rig.yaw,
              canFish,
            );
          }
          keys.add('Space');
          return;
        }
        if (fHud.phase === 'charging') {
          e.preventDefault();
          keys.add('Space');
          return;
        }
        if (fHud.phase !== 'idle' && fHud.phase !== 'reeling') {
          if (!e.repeat) {
            e.preventDefault();
            const selfId = live.current.state?.self ?? 'preview';
            const ownChar = characters.get(selfId);
            fishing.triggerPrimaryAction(
              ownChar?.root.position.x ?? motor?.x ?? 0,
              ownChar?.root.position.y ?? motor?.y ?? 0,
              ownChar?.root.position.z ?? motor?.z ?? 0,
              rig.yaw,
              ambience,
              marine,
            );
          }
          keys.add('Space');
          return;
        }
        if (fHud.phase === 'reeling') {
          e.preventDefault();
          keys.add('Space');
          return;
        }
        if (swimController.frame.mode === 'surface_swim' || swimController.frame.mode === 'underwater_dive') {
          e.preventDefault();
          if (!e.repeat && swimController.frame.mode === 'surface_swim' && swimController.canClimbDock()) {
            executeContextual();
            return;
          }
          keys.add('Space');
          return;
        }
      }

      if (!e.repeat && live.current.environmentVolume > 0) ambience.unlock();
      const action = embodiedKeys[e.code];
      if (action && action !== 'grab') {
        e.preventDefault();
        if (!e.repeat) live.current.onAction(action);
        return;
      }

      if (
        [
          'KeyW',
          'KeyA',
          'KeyS',
          'KeyD',
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'ShiftLeft',
          'ShiftRight',
          'ControlLeft',
          'ControlRight',
        ].includes(e.code)
      ) {
        e.preventDefault();
        if (live.current.activeInspect?.kind === 'telescope' && !e.code.startsWith('Shift')) {
          live.current.onInspect?.(null);
        }
        keys.add(e.code);
        if (!e.code.startsWith('Shift') && !e.code.startsWith('Control')) walkTo = null;
      }
    };

    const up = (e: KeyboardEvent) => {
      keys.delete(e.code);
      if (e.code === 'Space' && fishing.getHudState().phase === 'charging') {
        const selfId = live.current.state?.self ?? 'preview';
        const ownChar = characters.get(selfId);
        fishing.releaseCastCharge(
          ownChar?.root.position.x ?? motor?.x ?? 0,
          ownChar?.root.position.y ?? motor?.y ?? 0,
          ownChar?.root.position.z ?? motor?.z ?? 0,
          rig.yaw,
          ambience,
          marine,
        );
      }
    };
    const blur = () => {
      keys.clear();
      drag = null;
      photoDrag = null;
      reelMouseHeld = false;
      fishing.cancelCastCharge();
      walkTo = null;
      live.current.joystick.current = { x: 0, y: 0 };
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') {
        blur();
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
      } else if (!disposed && !raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };

    const pick = (nx: number, ny: number) => {
      ray.setFromCamera(new T.Vector2(nx, ny), camera);
      const self = live.current.state?.self;
      const p = new T.Vector3();
      let best: number | null = null;
      let bestD = 0.22;
      for (const player of live.current.state?.players ?? []) {
        if (player.id === self || !player.userId) continue;
        const c = characters.get(player.id);
        if (!c) continue;
        for (const h of [0.45, 1, 1.5]) {
          p.copy(c.root.position);
          p.y += h;
          const d = ray.ray.distanceSqToPoint(p);
          if (d < bestD) {
            bestD = d;
            best = player.userId;
          }
        }
      }
      return best;
    };

    let press: { x: number; y: number; at: number } | null = null;
    const pointer = (e: PointerEvent) => {
      if (!gameplayReady) return;
      if (live.current.photoState?.open) {
        renderer.domElement.focus({ preventScroll: true });
        photoDrag = {
          id: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          pan: e.button === 2 || e.button === 1 || e.shiftKey,
        };
        try {
          renderer.domElement.setPointerCapture(e.pointerId);
        } catch {
          // Synthetic mouse events may lack active pointerId capture
        }
        return;
      }
      if (live.current.blocked) return;
      if (live.current.environmentVolume > 0) ambience.unlock();
      renderer.domElement.focus({ preventScroll: true });

      const fPhase = fishing.getHudState().phase;
      if (e.button === 0 && fPhase !== 'idle') {
        const selfId = live.current.state?.self ?? 'preview';
        const ownChar = characters.get(selfId);
        const px = ownChar?.root.position.x ?? motor?.x ?? 0;
        const py = ownChar?.root.position.y ?? motor?.y ?? 0;
        const pz = ownChar?.root.position.z ?? motor?.z ?? 0;
        const canFish = swimController.frame.mode === 'land' || (Boolean(boatId) && boatRole === 'PASSENGER');

        if (fPhase === 'equipped' || fPhase === 'caught' || fPhase === 'escaped') {
          fishing.beginCastCharge(px, py, pz, rig.yaw, canFish);
          try {
            renderer.domElement.setPointerCapture(e.pointerId);
          } catch {
            // Synthetic Playwright mouse events work via window/canvas pointerup without capture
          }
          return;
        }
        if (fPhase === 'charging') {
          return;
        }
        if (fPhase === 'bite_alert' || fPhase === 'waiting_bite') {
          reelMouseHeld = true;
          fishing.triggerPrimaryAction(px, py, pz, rig.yaw, ambience, marine);
          return;
        }
        if (fPhase === 'reeling') {
          reelMouseHeld = true;
          return;
        }
      }

      if (document.pointerLockElement === renderer.domElement) {
        if (e.button === 0 && fishing.getHudState().phase === 'idle') {
          const who = pick(0, 0);
          if (who) live.current.onPlayer?.(who);
        }
        return;
      }
      press = e.button === 0 ? { x: e.clientX, y: e.clientY, at: performance.now() } : null;
      if (mouseLook.needsResume && live.current.view !== 'overview' && e.button === 0) {
        mouseLook.resume();
        return;
      }
      if (
        e.button === 2 ||
        live.current.activeInspect?.kind === 'telescope' ||
        live.current.view !== 'overview' ||
        e.pointerType === 'touch'
      ) {
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
        try {
          renderer.domElement.setPointerCapture(e.pointerId);
        } catch {
          // Ignore synthetic pointer capture error
        }
        return;
      }
      if (e.button !== 0 || boatId || seat) return;
      const b = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(
        new T.Vector2(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1),
        camera,
      );
      const point = new T.Vector3();
      plane.constant = -focus.y;
      if (ray.ray.intersectPlane(plane, point)) walkTo = point;
    };

    const pointerMove = (e: PointerEvent) => {
      if (photoDrag && photoDrag.id === e.pointerId) {
        const dx = e.clientX - photoDrag.x;
        const dy = e.clientY - photoDrag.y;
        photoDrag.x = e.clientX;
        photoDrag.y = e.clientY;
        if (photoDrag.pan) rig.panPhoto(dx, dy);
        else rig.orbitPhoto(dx, dy);
        return;
      }
      if (drag && drag.id === e.pointerId) {
        rig.look(e.clientX - drag.x, e.clientY - drag.y);
        drag.x = e.clientX;
        drag.y = e.clientY;
      }
    };

    const pointerUp = (e: Event) => {
      photoDrag = null;
      drag = null;
      reelMouseHeld = false;
      if (fishing.getHudState().phase === 'charging') {
        const selfId = live.current.state?.self ?? 'preview';
        const ownChar = characters.get(selfId);
        fishing.releaseCastCharge(
          ownChar?.root.position.x ?? motor?.x ?? 0,
          ownChar?.root.position.y ?? motor?.y ?? 0,
          ownChar?.root.position.z ?? motor?.z ?? 0,
          rig.yaw,
          ambience,
          marine,
        );
        press = null;
        return;
      }
      const was = press;
      press = null;
      if (e.type !== 'pointerup' || !was || live.current.blocked || live.current.photoState?.open) return;
      const u = e as PointerEvent;
      if (Math.hypot(u.clientX - was.x, u.clientY - was.y) > 6 || performance.now() - was.at > 450) return;
      const b = renderer.domElement.getBoundingClientRect();
      const who = pick(((u.clientX - b.left) / b.width) * 2 - 1, -((u.clientY - b.top) / b.height) * 2 + 1);
      if (who) {
        walkTo = null;
        live.current.onPlayer?.(who);
        return;
      }
      if (live.current.view !== 'overview' && u.pointerType === 'mouse' && !prefersFreePointer()) {
        mouseLook.enable();
      }
    };

    const mouse = (e: MouseEvent) => {
      if (document.pointerLockElement === renderer.domElement && !live.current.photoState?.open) {
        rig.look(e.movementX, e.movementY);
      }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (live.current.photoState?.open) {
        rig.zoomPhoto(e.deltaY);
      } else if (live.current.activeInspect?.kind === 'telescope') {
        rig.opticalZoom = T.MathUtils.clamp(rig.opticalZoom * Math.exp(-e.deltaY * 0.0018), 2, 12);
        if (opticalLabel.current) opticalLabel.current.value = rig.opticalZoom.toFixed(1) + '×';
      } else {
        rig.zoom = T.MathUtils.clamp(rig.zoom + e.deltaY * 0.01, 4, 28);
      }
    };

    renderer.domElement.addEventListener('pointerdown', pointer);
    renderer.domElement.addEventListener('pointermove', pointerMove);
    renderer.domElement.addEventListener('pointerup', pointerUp);
    renderer.domElement.addEventListener('pointercancel', pointerUp);
    renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
    renderer.domElement.addEventListener('wheel', wheel, { passive: false });
    document.addEventListener('mousemove', mouse);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    const lost = (e: Event) => {
      e.preventDefault();
      setFailed(true);
    };
    renderer.domElement.addEventListener('webglcontextlost', lost);

    const frame = (now: number) => {
      if (disposed || document.visibilityState === 'hidden') {
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(frame);
      const rawDtMs = now - last;
      const dt = Math.min(0.05, Math.max(0.0005, rawDtMs / 1000));
      last = now;

      if (!gameplayReady) return;

      const p = live.current;
      const s = p.state;
      const reduced = motionMedia.matches || activeTier === 'low';
      const photoOpen = Boolean(p.photoState?.open);
      if (photoOpen !== wasPhotoOpen) {
        wasPhotoOpen = photoOpen;
        if (photoOpen) {
          mouseLook.disable();
          keys.clear();
          drag = null;
          photoDrag = null;
          walkTo = null;
          reelMouseHeld = false;
          fishing.cancelCastCharge();
          savedPrePhotoCam = { yaw: rig.yaw, pitch: rig.pitch, zoom: rig.zoom };
          rig.photoMode = true;
          const ownNow = characters.get(s?.self ?? 'preview');
          rig.resetPhotoOrbit(ownNow?.root.rotation.y ?? rig.yaw, p.photoState?.fov ?? 48);
        } else {
          rig.photoMode = false;
          photoDrag = null;
          if (savedPrePhotoCam) {
            rig.yaw = savedPrePhotoCam.yaw;
            rig.pitch = savedPrePhotoCam.pitch;
            rig.zoom = savedPrePhotoCam.zoom;
            savedPrePhotoCam = null;
          }
          renderer.domElement.style.filter = '';
        }
      }
      if (photoOpen && p.photoState) {
        rig.setPhotoFov(p.photoState.fov);
        const safeCss = sanitizeArenaPhotoCssFilter(p.photoState.cssFilter);
        const nextCss = safeCss === 'none' ? '' : safeCss;
        if (renderer.domElement.style.filter !== nextCss) {
          renderer.domElement.style.filter = nextCss;
        }
      }
      const simDt = photoOpen && p.photoState?.timeFrozen ? 0 : dt;
      time += simDt;
      frames++;

      if (p.view !== lastView) {
        if (p.view === 'overview') {
          rig.pitch = -0.06;
          rig.zoom = Math.max(rig.zoom, 11);
          mouseLook.disable();
        }
        lastView = p.view;
      }
      rig.view = p.view;

      world.tableItems.syncRests(s?.items);

      const activeBeacons = s?.beacons ?? [...soloBeacons];
      const nextBeaconKey = activeBeacons.join(',');
      if (nextBeaconKey !== beaconKey) {
        beaconKey = nextBeaconKey;
        world.setBeacons(activeBeacons);
      }

      if ((s?.roomId ?? '') !== room) {
        const prevRoom = room;
        room = s?.roomId ?? '';
        walkTo = null;
        seat = null;
        soloSeat = null;
        seatMoveHoldSec = 0;
        boatId = null;
        boatRole = null;
        pendingOverboardLaunch = null;
        peerKinematics.clear();
        swimGuideTimer.reset();
        fishing.stowRod();
        fleet.clearSolo();
        fleet.resetReconciliation();
        motor = null;
        accumulator = 0;
        lastAck = -1;
        jumpUntil = 0;
        sentPose = { x: Infinity, z: Infinity, yaw: Infinity, dive: 0 };
        sentBoatPose = { x: Infinity, z: Infinity, yaw: Infinity, phase: Infinity };
        correction = { x: 0, z: 0 };
        velocity.set(0, 0);
        // Re-key pre-spawned `'preview'` character when entering a room with matching hero to avoid GPU skinning/material churn!
        const selfJoinPlayer = !prevRoom && s?.self ? s.players.find(x => x.id === s.self) : undefined;
        const previewChar = selfJoinPlayer ? characters.get('preview') : undefined;
        if (selfJoinPlayer && previewChar && previewChar.hero === selfJoinPlayer.hero) {
          characters.delete('preview');
          characters.set(selfJoinPlayer.id, previewChar);
          const previewLabel = labels.get('preview');
          if (previewLabel) {
            labels.delete('preview');
            labels.set(selfJoinPlayer.id, previewLabel);
          }
          for (const id of [...characters.keys()]) {
            if (id !== selfJoinPlayer.id) remove(id);
          }
        } else {
          for (const id of [...characters.keys()]) remove(id);
        }
      }

      const self = s?.self ?? 'preview';
      const players = s
        ? s.players
        : [
            {
              id: 'preview',
              name: 'You',
              hero: p.hero,
              look: p.look,
              team: 0,
              ready: false,
              online: true,
              moderated: false,
              canSpeak: false,
              voiceIdentity: 'preview',
              x: previewPose.x,
              z: previewPose.z,
              yaw: previewPose.yaw,
              gesture: 'IDLE',
              seat: soloSeat,
              boat: fleet.soloActiveBoatId,
              artifact: null,
              artifactTurn: 0,
              boatRole: fleet.soloActiveBoatId ? ('ROWER' as const) : null,
            },
          ];

      for (const id of [...characters.keys()]) {
        if (!players.some(x => x.id === id)) remove(id);
      }

      const angle = rig.yaw;
      const selfPlayer = players.find(x => x.id === self);

      fleet.syncOwnership(s?.boats, self, p.motion);
      if (selfPlayer) {
        if (s && selfPlayer.seat) soloSeat = null;
        const nextSeat = s ? (selfPlayer.seat ?? soloSeat) : soloSeat;
        const nextBoat = s ? (selfPlayer.boat ?? null) : fleet.soloActiveBoatId;
        const nextBoatRole = s ? (selfPlayer.boatRole ?? null) : nextBoat ? 'ROWER' : null;

        if (!motor || nextSeat !== seat || nextBoat !== boatId || p.motion.binding !== binding) {
          const leftBoat = boatId !== null && nextBoat === null;
          seat = nextSeat;
          seatMoveHoldSec = 0;
          boatId = nextBoat;
          boatRole = nextBoatRole;
          binding = p.motion.binding;
          const seatObj = seat && seat !== GROUND_SEAT_ID ? arenaSeats.find(st => st.id === seat) : null;
          const mx = seatObj ? seatObj.x : seat === GROUND_SEAT_ID && motor ? motor.x : selfPlayer.x;
          const mz = seatObj ? seatObj.z : seat === GROUND_SEAT_ID && motor ? motor.z : selfPlayer.z;
          const my = seatObj
            ? seatFloorElevation(seatObj)
            : seat === GROUND_SEAT_ID
              ? world.sampleGroundSurface(mx, mz)
              : (selfPlayer.supportY ?? arenaSupportY(mx, mz));
          motor = new ArenaMotor(mx, mz, my);
          swimController.syncPose(mx, my, mz, selfPlayer.yaw ?? 0);
          if (leftBoat && pendingOverboardLaunch && now < pendingOverboardLaunch.until) {
            swimController.vx = pendingOverboardLaunch.vx;
            swimController.vz = pendingOverboardLaunch.vz;
            swimController.step({
              dt: 1 / 60,
              time,
              forward: 0,
              right: 0,
              cameraYaw: angle,
              cameraPitch: rig.pitch,
              sprint: false,
              ascend: false,
              diveHeld: false,
              diveTogglePressed: false,
            });
            motor.x = motor.previous.x = swimController.x;
            motor.y = motor.previous.y = swimController.y;
            motor.z = motor.previous.z = swimController.z;
            motor.grounded = false;
            velocity.set(swimController.vx, swimController.vz);
            pendingOverboardLaunch = null;
          } else {
            velocity.set(0, 0);
          }
          lastAck = -1;
          accumulator = 0;
          jumpUntil = 0;
          sentPose.x = Infinity;
          sentBoatPose.x = Infinity;
          correction = { x: 0, z: 0 };
        } else {
          boatRole = nextBoatRole;
        }

        if (p.action && p.action.id !== lastAction) {
          lastAction = p.action.id;
          if (p.action.kind === 'jump' && boatId) {
            if (!triggerOverboardJump()) {
              const c = currentPromptRef.current;
              if (c?.kind === 'disembark') executeContextual();
            }
          } else if (p.action.kind === 'jump' && seat) {
            standFromSeat(now, true);
          } else if (p.action.kind === 'jump' && !boatId && swimController.frame.mode === 'land') {
            motor.requestJump();
          } else if (p.action.kind !== 'jump') {
            characters.get(self)?.express(p.action.kind);
          }
        }

        let forward =
          (keys.has('KeyW') || (p.view === 'overview' && keys.has('ArrowUp')) ? 1 : 0) -
          (keys.has('KeyS') || (p.view === 'overview' && keys.has('ArrowDown')) ? 1 : 0) -
          p.joystick.current.y;
        let right =
          (keys.has('KeyD') || (p.view === 'overview' && keys.has('ArrowRight')) ? 1 : 0) -
          (keys.has('KeyA') || (p.view === 'overview' && keys.has('ArrowLeft')) ? 1 : 0) +
          p.joystick.current.x;
        const telescopeActive = p.activeInspect?.kind === 'telescope';
        const fPhaseNow = fishing.getHudState().phase;
        const isReelingFish = fPhaseNow === 'reeling' || fPhaseNow === 'casting' || fPhaseNow === 'charging';
        const rawMoveWish = Math.hypot(forward, right);
        if (seat && !p.blocked && !photoOpen && !telescopeActive && (!s || p.connected)) {
          if (rawMoveWish > 0.25) {
            seatMoveHoldSec += dt;
            if (seatMoveHoldSec > 0.22) {
              standFromSeat(now);
            }
          } else {
            seatMoveHoldSec = 0;
          }
        } else {
          seatMoveHoldSec = 0;
        }
        if (seat || p.blocked || photoOpen || telescopeActive || isReelingFish || (s && !p.connected)) {
          forward = right = 0;
          walkTo = null;
        }

        if (simDt > 0 && boatId && boatRole === 'ROWER') {
          const driverBoat = fleet.boats.get(boatId);
          if (driverBoat) {
            const prevBoatYaw = driverBoat.yaw;
            accumulator += simDt;
            while (accumulator >= STEP) {
              fleet.stepDriverBoat(driverBoat, forward, right);
              accumulator -= STEP;
            }
            const yawDiff = Math.atan2(
              Math.sin(driverBoat.yaw - prevBoatYaw),
              Math.cos(driverBoat.yaw - prevBoatYaw),
            );
            if (p.view !== 'overview' && !drag && document.pointerLockElement !== renderer.domElement) {
              rig.yaw += yawDiff;
            } else if (p.view === 'first') {
              rig.yaw += yawDiff;
            }
            motor.x = motor.previous.x = driverBoat.x;
            motor.z = motor.previous.z = driverBoat.z;
            swimController.syncPose(driverBoat.x, ARENA_WATER_Y + 0.36, driverBoat.z, driverBoat.yaw);
            if (s && p.row) {
              const changed =
                Math.abs(driverBoat.x - sentBoatPose.x) +
                  Math.abs(driverBoat.z - sentBoatPose.z) +
                  Math.abs(driverBoat.yaw - sentBoatPose.yaw) >
                  0.003 || Math.abs(driverBoat.rowPhase - sentBoatPose.phase) > 0.04;
              if (changed) settleUntil = now + 350;
              if (
                (changed || now < settleUntil || (driverBoat.motor && driverBoat.engine)) &&
                p.row(
                  driverBoat.x,
                  driverBoat.z,
                  driverBoat.yaw,
                  driverBoat.rowPhase,
                  driverBoat.motor ? driverBoat.throttle : undefined,
                  driverBoat.motor ? driverBoat.steering : undefined,
                )
              ) {
                sentBoatPose = {
                  x: driverBoat.x,
                  z: driverBoat.z,
                  yaw: driverBoat.yaw,
                  phase: driverBoat.rowPhase,
                };
              }
            }
            velocity.set(0, driverBoat.speed);
          }
        } else if (simDt > 0 && !boatId) {
          const shiftHeld = keys.has('ShiftLeft') || keys.has('ShiftRight');
          const wish = Math.min(1, Math.hypot(forward, right));

          // Check whether player is in amphibious swimming/diving water (`waterDepth >= 0.80 m` or currently swimming)
          const waterDepthHere = arenaWaterDepth(motor.x, motor.z);
          const alreadySwimming =
            swimController.frame.mode === 'surface_swim' || swimController.frame.mode === 'underwater_dive';
          const shouldUseSwim =
            !seat &&
            !arenaOnWood(motor.x, motor.z) &&
            (alreadySwimming ? waterDepthHere >= 0.32 : waterDepthHere >= 0.85 && motor.y <= ARENA_WATER_Y + 0.15);

          if (shouldUseSwim) {
            if (!alreadySwimming) {
              fishing.stowRod();
              swimController.syncPose(motor.x, motor.y, motor.z, characters.get(self)?.root.rotation.y ?? angle);
            }
            const diveToggle = diveTogglePending;
            diveTogglePending = false;
            swimController.step({
              dt: simDt,
              time,
              forward,
              right,
              cameraYaw: angle,
              cameraPitch: rig.pitch,
              sprint: shiftHeld,
              ascend: keys.has('Space'),
              diveHeld: keys.has('ControlLeft') || keys.has('ControlRight'),
              diveTogglePressed: diveToggle,
            });
            const swimEvents = swimController.getEvents();
            for (let i = 0; i < swimEvents.length; i++) {
              const ev = swimEvents[i];
              if (ev.kind === 'water_entry' || ev.kind === 'dive_submerge' || ev.kind === 'resurface') {
                world.sea.triggerSurfaceSplash(ev.x, ev.z, ev.strength, 2.6);
              }
            }
            swimFx.ingestEvents(swimEvents);
            if (p.environmentVolume > 0) {
              swimController.flushAudioEvents(ambience, swimController.x, swimController.z, angle);
            }

            motor.x = motor.previous.x = swimController.x;
            motor.y = motor.previous.y = swimController.y;
            motor.z = motor.previous.z = swimController.z;
            motor.vy = 0;
            motor.grounded = false;
            velocity.set(swimController.vx, swimController.vz);

            const ownChar = characters.get(self);
            if (ownChar && swimController.frame.strokeSpeed > 0.06) {
              ownChar.root.rotation.y = swimController.yaw;
            }
          } else {
            // Land or shallow beach wading (`< 0.85 m`)
            if (alreadySwimming) {
              motor.y = motor.previous.y = arenaSupportY(motor.x, motor.z);
              motor.grounded = true;
            }
            diveTogglePending = false;
            swimController.syncPose(motor.x, motor.y, motor.z, characters.get(self)?.root.rotation.y ?? angle);

            if (shiftHeld && wish > 0.2) sprintHoldSec = Math.min(2, sprintHoldSec + simDt);
            else sprintHoldSec = Math.max(0, sprintHoldSec - simDt * 3);

            const wadeDrag =
              waterDepthHere > 0.25 ? T.MathUtils.lerp(1.0, 0.72, Math.min(1, (waterDepthHere - 0.25) / 0.6)) : 1.0;
            const sprintRampSpeed = shiftHeld
              ? sprintHoldSec < 0.22
                ? T.MathUtils.lerp(JOG_SPEED, RUN_SPEED, sprintHoldSec / 0.22)
                : sprintHoldSec > 0.55
                  ? T.MathUtils.lerp(RUN_SPEED, SPRINT_SPEED, Math.min(1, (sprintHoldSec - 0.55) / 0.3))
                  : RUN_SPEED
              : WALK_SPEED;
            const targetTopSpeed = sprintRampSpeed * wadeDrag;
            const pace = targetTopSpeed * (wish > 0 ? wish / Math.hypot(forward, right) : 0);
            const wishF = forward * pace;
            const wishR = right * pace;
            const pressing = wishF * wishF + wishR * wishR > velocity.lengthSq();
            velocity.x += (wishR - velocity.x) * (1 - Math.exp(-(pressing ? 8.5 : 13) * simDt));
            velocity.y += (wishF - velocity.y) * (1 - Math.exp(-(pressing ? 8.5 : 13) * simDt));

            let dx = Math.sin(angle) * velocity.y - Math.cos(angle) * velocity.x;
            let dz = Math.cos(angle) * velocity.y + Math.sin(angle) * velocity.x;
            const ownChar = characters.get(self);
            if (walkTo && ownChar) {
              dx = walkTo.x - ownChar.root.position.x;
              dz = walkTo.z - ownChar.root.position.z;
              const away = Math.hypot(dx, dz);
              if (away < 0.12) {
                walkTo = null;
                dx = dz = 0;
              } else {
                const go = Math.min(away * 3, away > 2.4 ? RUN_SPEED : WALK_SPEED);
                dx = (dx / away) * go;
                dz = (dz / away) * go;
              }
            }
            const length = Math.hypot(dx, dz);
            if (length <= 0.015) {
              dx = dz = 0;
              velocity.set(0, 0);
            }
            if (p.view !== 'first') {
              moveYaw *= Math.exp(-14 * simDt);
            } else if (length <= 0.04) {
              moveYaw *= Math.exp(-10 * simDt);
            }
            if (length > 0.04 && ownChar) {
              const yaw = p.view === 'first' ? angle : Math.atan2(dx, dz);
              const rawDelta = Math.atan2(
                Math.sin(yaw - ownChar.root.rotation.y),
                Math.cos(yaw - ownChar.root.rotation.y),
              );
              if (p.view === 'first') {
                ownChar.root.rotation.y += rawDelta * (1 - Math.exp(-simDt * 12));
                const off = Math.atan2(
                  Math.sin(Math.atan2(dx, dz) - ownChar.root.rotation.y),
                  Math.cos(Math.atan2(dx, dz) - ownChar.root.rotation.y),
                );
                const hips =
                  Math.abs(off) > 1.95 ? Math.atan2(Math.sin(off + Math.PI), Math.cos(off + Math.PI)) : off;
                moveYaw += (T.MathUtils.clamp(hips, -1.15, 1.15) - moveYaw) * (1 - Math.exp(-10 * simDt));
              } else {
                const maxTurnRate = T.MathUtils.lerp(9.5, 4.8, T.MathUtils.smoothstep(length, 1.2, SPRINT_SPEED));
                const smoothStep = rawDelta * (1 - Math.exp(-simDt * 10.5));
                ownChar.root.rotation.y += T.MathUtils.clamp(
                  smoothStep,
                  -maxTurnRate * simDt,
                  maxTurnRate * simDt,
                );
              }
            } else if (p.view === 'first' && !seat && ownChar) {
              const off = Math.atan2(
                Math.sin(angle - ownChar.root.rotation.y),
                Math.cos(angle - ownChar.root.rotation.y),
              );
              if (Math.abs(off) > 0.85) ownChar.root.rotation.y += off * (1 - Math.exp(-simDt * 5.5));
            }

            const ack = p.motion.history.get(self)?.at(-1);
            if (!seat && ack && (ack.seat ?? null) === seat && !ack.boat && ack.sequence !== lastAck) {
              lastAck = ack.sequence;
              const predicted = p.motion.sent.get(ack.sequence);
              if (predicted) {
                const ex = ack.x - predicted.x;
                const ez = ack.z - predicted.z;
                correction = Math.hypot(ex, ez) > 0.035 ? { x: ex, z: ez } : { x: 0, z: 0 };
                for (const sequence of p.motion.sent.keys()) {
                  if (sequence <= ack.sequence) p.motion.sent.delete(sequence);
                }
              }
            }

            accumulator += simDt;
            while (accumulator >= STEP) {
              const cx = correction.x * 0.18;
              const cz = correction.z * 0.18;
              correction.x -= cx;
              correction.z -= cz;
              if (seat) {
                const seatObj = seat !== GROUND_SEAT_ID ? arenaSeats.find(st => st.id === seat) : null;
                if (seatObj) {
                  motor.x = motor.previous.x = seatObj.x;
                  motor.z = motor.previous.z = seatObj.z;
                  motor.y = motor.previous.y = seatFloorElevation(seatObj);
                  motor.grounded = true;
                } else {
                  motor.previous.x = motor.x;
                  motor.previous.z = motor.z;
                  motor.y = motor.previous.y = world.sampleGroundSurface(motor.x, motor.z);
                  motor.grounded = true;
                }
              } else {
                motor.step(dx + cx / STEP, dz + cz / STEP);
              }
              accumulator -= STEP;
            }
          }
        } else if (!boatId) {
          velocity.set(0, 0);
        } else if (simDt > 0) {
          velocity.set(0, 0);
        }
      }

      const alpha = accumulator / STEP;
      const boatWakes = fleet.update(
        simDt,
        time,
        now,
        alpha,
        self,
        s?.boats,
        p.motion,
        focus,
        angle,
        ambience,
        p.environmentVolume,
        reduced,
      );

      // Assemble unified boat + swimmer + bobber wake sources (zero allocations)
      combinedWakes.length = 0;
      for (let i = 0; i < boatWakes.length; i++) combinedWakes.push(boatWakes[i]);
      if (swimController.frame.mode === 'surface_swim' || swimController.frame.mode === 'wading') {
        const sw = swimController.wakeSource;
        if (sw.speed > 0.12) combinedWakes.push(sw);
      }

      heldItems.clear();
      peerMarkersPool.length = 0;

      for (const player of players) {
        let c = characters.get(player.id);
        if (!c) {
          const template = templates.get(player.hero);
          if (!template) {
            if (!requested.has(player.hero)) {
              void loadHero(player.hero).catch(() => {
                if (!disposed) setFailed(true);
              });
            }
            continue;
          }
          c = new ArenaCharacter(template, player.team, player.hero);
          c.root.position.set(player.x, arenaSupportY(player.x, player.z), player.z);
          c.root.rotation.y = player.yaw;
          c.resetPosition();
          scene.add(c.root);
          characters.set(player.id, c);
          const label = document.createElement('div');
          label.className = styles.nameplate;
          element.append(label);
          labels.set(player.id, label);
        }
        void c.dress(player.hero, player.id === self ? p.look : player.look);

        const pBoat = player.id === self ? boatId : (player.boat ?? null);
        const pSeat = player.id === self ? seat : (player.seat ?? null);
        const pBoatRole: ArenaBoatRole = (player.id === self ? boatRole : player.boatRole) ?? 'ROWER';
        let rigBoatPose = undefined;

        let transition = seatTransitions.get(player.id);
        if (!transition) {
          transition = {
            boat: pBoat,
            seat: pSeat,
            boatChanged: false,
            from: c.root.position.clone(),
            fromYaw: c.root.rotation.y,
            age: 1,
          };
          seatTransitions.set(player.id, transition);
        } else if (transition.boat !== pBoat || transition.seat !== pSeat) {
          transition.boatChanged = transition.boat !== pBoat;
          transition.boat = pBoat;
          transition.seat = pSeat;
          transition.from.copy(c.root.position);
          transition.fromYaw = c.root.rotation.y;
          transition.age = 0;
        }

        if (pBoat) {
          rigBoatPose = fleet.attachAvatar(pBoat, pBoatRole, c);
          if (player.id === self && p.view === 'first') {
            const rel = Math.atan2(
              Math.sin(rig.yaw - c.root.rotation.y),
              Math.cos(rig.yaw - c.root.rotation.y),
            );
            if (Math.abs(rel) > 1.92) rig.yaw = c.root.rotation.y + Math.sign(rel) * 1.92;
            rig.pitch = Math.max(rig.pitch, -1.05);
          }
          if (player.id === self) {
            focus.copy(c.root.position);
            p.space.current.listener = {
              x: c.root.position.x,
              y: c.root.position.y,
              z: c.root.position.z,
              yaw: angle,
              boat: pBoat,
            };
          }
        } else if (player.id === self && motor) {
          const seatObj = seat && seat !== GROUND_SEAT_ID ? arenaSeats.find(st => st.id === seat) : null;
          if (seatObj) {
            c.root.position.set(seatObj.x, seatFloorElevation(seatObj), seatObj.z);
            c.root.rotation.y = seatObj.yaw;
            if (p.view === 'first') {
              const rel = Math.atan2(
                Math.sin(rig.yaw - c.root.rotation.y),
                Math.cos(rig.yaw - c.root.rotation.y),
              );
              if (Math.abs(rel) > 1.85) rig.yaw = c.root.rotation.y + Math.sign(rel) * 1.85;
              rig.pitch = Math.max(rig.pitch, -1.05);
            }
          } else if (seat === GROUND_SEAT_ID) {
            c.root.position.set(motor.x, world.sampleGroundSurface(motor.x, motor.z), motor.z);
          } else if (swimController.frame.mode === 'surface_swim' || swimController.frame.mode === 'underwater_dive') {
            c.root.position.set(swimController.x, swimController.y, swimController.z);
          } else {
            const prev = motor.previous;
            const ix = T.MathUtils.lerp(prev.x, motor.x, alpha);
            const iy = T.MathUtils.lerp(prev.y, motor.y, alpha);
            const iz = T.MathUtils.lerp(prev.z, motor.z, alpha);
            const groundedSurfaceY = motor.grounded ? world.sampleGroundSurface(ix, iz, undefined, iy) : iy;
            c.root.position.set(ix, groundedSurfaceY, iz);
          }
          const diveVal =
            swimController.frame.mode === 'underwater_dive'
              ? Number(swimController.frame.diveDepth.toFixed(2))
              : 0;
          const pose = { x: motor.x, z: motor.z, yaw: c.root.rotation.y, dive: diveVal };
          if (s && !seat) {
            const changed =
              Math.abs(pose.x - sentPose.x) +
                Math.abs(pose.z - sentPose.z) +
                Math.abs(pose.yaw - sentPose.yaw) +
                Math.abs(pose.dive - sentPose.dive) >
              0.002;
            if (changed || motor.jumped) settleUntil = now + 320;
            if (motor.jumped) {
              jumpUntil = now + 350;
              motor.jumped = false;
            }
            if (
              (changed || now < jumpUntil || now < settleUntil) &&
              p.move(pose.x, pose.z, pose.yaw, now < jumpUntil, diveVal > 0 ? diveVal : undefined)
            ) {
              sentPose = pose;
              motor.jumped = false;
            }
          } else {
            previewPose = { x: pose.x, z: pose.z, yaw: pose.yaw };
            motor.jumped = false;
          }
          focus.copy(c.root.position);
          p.space.current.listener = {
            x: c.root.position.x,
            y: c.root.position.y,
            z: c.root.position.z,
            yaw: angle,
            boat: null,
          };
        } else if (player.seat) {
          const rSeat = arenaSeats.find(st => st.id === player.seat);
          if (rSeat) {
            c.root.position.set(rSeat.x, seatFloorElevation(rSeat), rSeat.z);
            c.root.rotation.y = rSeat.yaw;
          } else {
            c.root.position.set(player.x, arenaHeight(player.x, player.z), player.z);
            c.root.rotation.y = player.yaw;
          }
        } else {
          const pose = p.motion.sample(player.id, now);
          c.root.position.set(
            pose?.x ?? player.x,
            pose?.y ?? (player.supportY ?? arenaSupportY(player.x, player.z)),
            pose?.z ?? player.z,
          );
          c.root.rotation.y = pose?.yaw ?? player.yaw;
        }

        if (transition.age < 0.32) {
          transition.age += dt;
          const u = Math.min(1, transition.age / 0.32);
          const t = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
          transitionTargetVec.copy(c.root.position);
          c.root.position.lerpVectors(transition.from, transitionTargetVec, t);
          if (transition.boatChanged) {
            c.root.position.y += Math.sin(u * Math.PI) * 0.14;
          }
          const targetYaw = c.root.rotation.y;
          const yawDelta = Math.atan2(
            Math.sin(targetYaw - transition.fromYaw),
            Math.cos(targetYaw - transition.fromYaw),
          );
          c.root.rotation.y = transition.fromYaw + yawDelta * t;
          if (player.id === self) {
            focus.copy(c.root.position);
            p.space.current.listener.x = focus.x;
            p.space.current.listener.y = focus.y;
            p.space.current.listener.z = focus.z;
            p.space.current.listener.boat = pBoat ?? null;
          }
        }

        p.space.current.players.set(player.voiceIdentity, {
          x: c.root.position.x,
          y: c.root.position.y,
          z: c.root.position.z,
          yaw: c.root.rotation.y,
          boat: pBoat ?? null,
        });
        const speaking = p.speakers.includes(player.voiceIdentity);

        let peerSpeed = 0;
        if (player.id !== self) {
          let pk = peerKinematics.get(player.id);
          if (!pk) {
            pk = { x: c.root.position.x, z: c.root.position.z, speed: 0 };
            peerKinematics.set(player.id, pk);
          } else {
            const inst = Math.min(
              6.5,
              Math.hypot(c.root.position.x - pk.x, c.root.position.z - pk.z) / Math.max(dt, 1e-4),
            );
            pk.x = c.root.position.x;
            pk.z = c.root.position.z;
            pk.speed += (inst - pk.speed) * (1 - Math.exp(-10 * dt));
          }
          peerSpeed = pk.speed;
          peerMarkersPool.push({
            id: player.id,
            name: player.name,
            x: c.root.position.x,
            z: c.root.position.z,
            yaw: c.root.rotation.y,
            speaking,
          });
        }

        const finished = s?.phase === 'FINISHED';
        const won = !!s && (player.team === 0 ? s.coral >= s.lagoon : s.lagoon >= s.coral);
        const studying = player.id === self && !photoOpen && p.activeInspect?.kind === 'artifact' && !!p.inspectItem;
        const own =
          player.id === self &&
          !photoOpen &&
          (p.view === 'first' || studying) &&
          p.activeInspect?.kind !== 'telescope';
        const lookYaw =
          player.id === self && !photoOpen && p.view !== 'overview'
            ? Math.atan2(Math.sin(rig.yaw - c.root.rotation.y), Math.cos(rig.yaw - c.root.rotation.y))
            : 0;
        const previousClip = c.locomotion;
        const playerForAnim = player.id === self && pSeat ? { ...player, seat: pSeat } : player;

        // Evaluate swim/fishing/slope state for character animation
        let charSwim: ArenaSwimFrame | undefined;
        if (!pBoat && !playerForAnim.seat) {
          if (player.id === self) {
            charSwim = swimController.frame;
          } else {
            charSwim = evaluatePeerSwimFrame(
              c.root.position.x,
              c.root.position.y,
              c.root.position.z,
              peerSpeed,
              time,
              peerSwimScratch,
            );
          }
        }

        const isSwimActive =
          charSwim?.mode === 'surface_swim' || charSwim?.mode === 'underwater_dive';
        const isAirborne =
          pBoat || isSwimActive || Boolean(pSeat)
            ? false
            : player.id === self && motor
              ? !motor.grounded
              : c.root.position.y > arenaSupportY(c.root.position.x, c.root.position.z) + 0.025;

        const heldItem = s ? player.artifact : p.activeInspect?.kind === 'artifact' ? p.activeInspect.id : null;
        let holding: { left?: HandContact | null; right?: HandContact | null } | null = null;
        if (heldItem && !photoOpen) {
          heldItems.add(heldItem);
          if (player.id === self) {
            holdLook.set(
              Math.sin(rig.yaw) * Math.cos(rig.pitch),
              Math.sin(rig.pitch),
              Math.cos(rig.yaw) * Math.cos(rig.pitch),
            );
          } else {
            holdLook.set(Math.sin(c.root.rotation.y) * 0.94, -0.34, Math.cos(c.root.rotation.y) * 0.94);
          }
          if (player.id === self && studying) holdLook.y = T.MathUtils.clamp(holdLook.y, -0.35, -0.05);
          world.tableItems.hold(
            heldItem,
            { root: c.root, eye: c.stableEye(holdEye), look: holdLook.normalize() },
            studying,
            s ? (player.artifactTurn ?? 0) : (p.artifactTurn ?? 0),
            simDt > 0 ? simDt : dt,
          );
          holding = world.tableItems.contacts(heldItem, c);
        }

        // Step local angler fishing rig right before character rig solve so two-hand IK & tension drive `HumanRig` (`F02`)!
        let charFishing: ArenaCharacterArchipelagoState['fishing'] = null;
        if (player.id === self) {
          const canFishHere =
            (!pBoat && swimController.frame.mode === 'land') || (Boolean(pBoat) && pBoatRole === 'PASSENGER');
          const fHud =
            !photoOpen && simDt > 0
              ? fishing.update({
                  dt: simDt,
                  time,
                  anglerX: c.root.position.x,
                  anglerY: c.root.position.y,
                  anglerZ: c.root.position.z,
                  anglerYaw: c.root.rotation.y,
                  lookYaw: rig.yaw,
                  canFishHere,
                  reelHeld: reelMouseHeld || uiReelHeld || keys.has('Space'),
                  listenerX: focus.x,
                  listenerZ: focus.z,
                  listenerYaw: angle,
                  ambience,
                  ecosystem: marine,
                })
              : fishing.getHudState();
          if (p.fishingHudRef) p.fishingHudRef.current = fHud;
          const catchAt = fHud.lastCatch?.caughtAt ?? 0;
          if (fHud.phase !== lastFishingPhase || catchAt !== lastCatchTimestamp) {
            lastFishingPhase = fHud.phase;
            lastCatchTimestamp = catchAt;
            p.onFishingStateChange?.({ ...fHud });
          }
          if (!photoOpen && fHud.phase !== 'idle') {
            const moveSpd = pBoat ? 0 : velocity.length();
            const isAnglerSeated = Boolean(pSeat || pBoat);
            if (!holding) {
              holding = fishing.getHandContacts(moveSpd, isAnglerSeated);
            }
            charFishing = {
              phase: fHud.phase,
              tension: fHud.tension,
              chargePower: fHud.chargePower,
              resolveContacts: () =>
                fishing.resolveRigContacts(c.rig, {
                  moveSpeed: moveSpd,
                  isSeated: isAnglerSeated,
                  aimYaw: rig.yaw,
                  aimPitch: rig.pitch,
                }),
            };
          }
          const bob = fishing.getActiveBobber();
          if (bob.active) {
            combinedWakes.push({
              id: 'fishing-bobber',
              bobber: true,
              x: bob.x,
              z: bob.z,
              speed: fHud.fishPulling ? 1.8 : 0.35,
              yaw: 0,
            });
          }
        }

        const fdx = Math.sin(c.root.rotation.y);
        const fdz = Math.cos(c.root.rotation.y);
        const slopeAhead = !pBoat && !isSwimActive
          ? arenaSupportY(c.root.position.x + fdx * 0.5, c.root.position.z + fdz * 0.5) -
            arenaSupportY(c.root.position.x - fdx * 0.5, c.root.position.z - fdz * 0.5)
          : 0;

        const archState: ArenaCharacterArchipelagoState = {
          swim: charSwim,
          fishing: charFishing,
          sprinting: player.id === self && sprintHoldSec > 0.55 && velocity.length() > 3.6,
          helmSteer: Boolean(pBoat) && pBoatRole === 'ROWER' && Boolean(fleet.boats.get(pBoat!)?.motor),
          groundSlope: T.MathUtils.clamp(slopeAhead, -0.6, 0.6),
          distanceToCamera: camera.position.distanceTo(c.root.position),
          photoPose: player.id === self && photoOpen ? (p.photoState?.pose ?? 'stand') : null,
          photoExpression: player.id === self && photoOpen ? (p.photoState?.expression ?? 'smile') : null,
          photoLiveDt: dt,
          groundAt: groundTerrainAt,
          surfaceAt: surfaceAtArena,
          seatHeightAboveGround:
            pSeat && pSeat !== GROUND_SEAT_ID ? seatTopForId(pSeat) : rigBoatPose?.seatHeightAboveDeck,
        };
        c.update(
          player.id === self ? simDt : dt,
          playerForAnim,
          speaking,
          finished,
          won,
          reduced,
          player.id === self
            ? {
                own,
                yaw: own
                  ? lookYaw
                  : T.MathUtils.clamp(lookYaw, -1, 1) * (1 - T.MathUtils.smoothstep(Math.abs(lookYaw), 1.6, 2.3)),
                pitch: photoOpen || p.view === 'overview' ? 0 : own ? rig.pitch : rig.pitch * 0.6,
              }
            : undefined,
          player.id === self ? moveYaw : 0,
          isAirborne,
          rigBoatPose,
          holding,
          archState,
        );
        if (player.id === self && !photoOpen && fishing.getHudState().phase !== 'idle') {
          fishing.syncVisualsToSolvedHands(c.rig, simDt > 0 ? simDt : dt, time);
        }
        if (player.id === self) {
          rig.eyeWorld = p.view === 'first' && !photoOpen ? c.eyeWorld(seatedEye) : null;
        }

        const phase = Math.floor(c.stridePhase / (2 * Math.PI));
        const stride =
          !pBoat &&
          !isSwimActive &&
          (c.locomotion === 'Walk' ||
            c.locomotion === 'Jog' ||
            c.locomotion === 'Run' ||
            c.locomotion === 'Sprint') &&
          phase !== footPhase.get(player.id) &&
          footPhase.has(player.id);
        const impact =
          !pBoat &&
          !isSwimActive &&
          c.locomotion !== previousClip &&
          (c.locomotion === 'JumpUp' || c.locomotion === 'Land');
        if ((stride || impact) && p.environmentVolume > 0) {
          const { x, z } = c.root.position;
          ambience.step(
            x,
            z,
            focus.x,
            focus.z,
            angle,
            c.locomotion === 'Land' ? 1 : c.locomotion === 'Run' || c.locomotion === 'Sprint' ? 0.8 : 0.55,
            arenaOnWood(x, z) || (x * x + z * z < 960 && Math.abs(arenaHeight(x, z)) < 0.08),
          );
        }
        footPhase.set(player.id, phase);

        if (player.id === self) {
          focus.y = c.root.position.y;
          rig.eyeHeight = c.cameraHeight;
          rig.inBoat = !!pBoat;
          rig.motorboat = !!pBoat && !!fleet.boats.get(pBoat)?.motor;
          const pace = pBoat || isSwimActive ? 0 : velocity.length();
          bobWeight +=
            ((own && !reduced && !pBoat && !isSwimActive ? Math.min(1, pace / 1.3) : 0) - bobWeight) *
            (1 - Math.exp(-8 * dt));
          rig.bob = Math.cos(c.stridePhase) * (pace > 2.2 ? 0.012 : 0.006) * bobWeight;

          if (
            p.activeInspect &&
            p.activeInspect.kind !== 'artifact' &&
            Math.hypot(c.root.position.x - p.activeInspect.x, c.root.position.z - p.activeInspect.z) > 4.6
          ) {
            p.onInspect?.(null);
          }
          const table = heldItem
            ? world.tableItems.tableNear(
                motor ? motor.x : c.root.position.x,
                motor ? motor.z : c.root.position.z,
              )
            : null;
          if (table !== placeable) {
            placeable = table;
            p.onPlaceable?.(table);
          }

          // Step tropical fruit trees & evaluate contextual prompt
          if (simDt > 0) {
            fruitTrees.update({
              dt: simDt,
              time,
              playerX: c.root.position.x,
              playerY: c.root.position.y,
              playerZ: c.root.position.z,
              lookYaw: p.view === 'overview' ? c.root.rotation.y : rig.yaw,
              listenerX: focus.x,
              listenerZ: focus.z,
              listenerYaw: angle,
              ambience: p.environmentVolume > 0 ? ambience : undefined,
            });
          }

          const dockClimb = swimController.canClimbDock(
            c.root.position.x,
            c.root.position.z,
            c.root.position.y,
            rig.yaw,
          );
          const fishingHint = fishing.getContextualPrompt(c.root.position.x, c.root.position.z);
          const fruitAct =
            swimController.frame.mode === 'land' && !pBoat
              ? fruitTrees.getContextualAction(
                  c.root.position.x,
                  c.root.position.y,
                  c.root.position.z,
                  p.view === 'overview' ? c.root.rotation.y : rig.yaw,
                )
              : null;

          occupiedSeatsPool.clear();
          for (let i = 0; i < players.length; i++) {
            const ps = players[i].id === self ? seat : players[i].seat;
            if (ps) occupiedSeatsPool.add(ps);
          }
          litBeaconsPool.clear();
          for (let i = 0; i < activeBeacons.length; i++) {
            litBeaconsPool.add(activeBeacons[i]);
          }

          const swimGuide = swimGuideTimer.stepSeconds(swimController.frame.mode, dt);

          const ctxAct =
            !p.blocked &&
            !photoOpen &&
            fishing.getHudState().phase === 'idle' &&
            (!s || p.connected) &&
            (!p.activeInspect || p.activeInspect.kind === 'artifact')
              ? selectContextualAction({
                  px: motor ? motor.x : c.root.position.x,
                  py: motor ? motor.y : c.root.position.y,
                  pz: motor ? motor.z : c.root.position.z,
                  lookYaw: p.view === 'overview' ? c.root.rotation.y : rig.yaw,
                  grounded: motor ? motor.grounded : true,
                  swimMode: swimController.frame.mode,
                  waterDepth: swimController.frame.waterDepth,
                  dockClimb,
                  fishingHint,
                  fruitAction: fruitAct,
                  seat,
                  boatId,
                  hasRoom: !!s,
                  players,
                  occupiedSeats: occupiedSeatsPool,
                  fleet,
                  litBeacons: litBeaconsPool,
                  showBoatControlsHint: now < boatHintUntil,
                  showUnderwaterControlsHint: swimGuide.showUnderwaterHint,
                  underwaterHintFading: swimGuide.underwaterFading,
                  showSwimControlsHint: swimGuide.showSurfaceHint,
                  swimHintFading: swimGuide.surfaceFading,
                  holding: heldItem,
                  placeTable: table,
                  rests: itemRests(),
                })
              : null;
          if (
            (ctxAct?.key ?? '') !== (currentPromptRef.current?.key ?? '') ||
            Boolean(ctxAct?.fading) !== Boolean(currentPromptRef.current?.fading)
          ) {
            currentPromptRef.current = ctxAct;
            setPromptPill(ctxAct);
          }

          // Update zero-rerender MinimapSnapshot ref
          if (p.minimapRef) {
            p.minimapRef.current = {
              selfX: c.root.position.x,
              selfZ: c.root.position.z,
              selfYaw: c.root.rotation.y,
              cameraYaw: rig.yaw,
              swimMode: swimController.frame.mode,
              activeIslandId: arenaIslandAt(c.root.position.x, c.root.position.z),
              waypoint: p.waypoint ?? null,
              peers: peerMarkersPool,
              boats: fleet.getMinimapMarkers(),
            };
          }
        }

        const label = labels.get(player.id)!;
        const caption = `${player.name}${speaking ? ' · ◉' : ''}`;
        if (label.textContent !== caption) label.textContent = caption;
        label.dataset.self = String(player.id === self);
        label.dataset.team = String(player.team);
        const screen = desired.copy(c.root.position).setY(c.root.position.y + (pSeat ? 1.92 : 2.3)).project(camera);
        label.style.transform = `translate(-50%,-100%) translate(${(screen.x * 0.5 + 0.5) * element.clientWidth}px,${(-screen.y * 0.5 + 0.5) * element.clientHeight}px)`;
        label.hidden =
          !s ||
          photoOpen ||
          (player.id === self && p.view === 'first') ||
          p.activeInspect?.kind === 'telescope' ||
          Math.abs(screen.x) > 1 ||
          Math.abs(screen.y) > 1 ||
          screen.z > 1;
      }

      if (simDt > 0) {
        for (const id of world.tableItems.items.keys()) {
          if (!heldItems.has(id)) world.tableItems.settle(id, simDt);
        }
      }
      for (const id of p.space.current.players.keys()) {
        if (!players.some(x => x.voiceIdentity === id)) p.space.current.players.delete(id);
      }
      p.space.current.updatedAt = performance.now();

      if (p.activeInspect?.kind === 'telescope' && !photoOpen) {
        const iy = arenaHeight(p.activeInspect.x, p.activeInspect.z) + 1.56;
        rig.lookoutOrigin = opticalEye.set(p.activeInspect.x, iy, p.activeInspect.z);
        world.observe(p.activeInspect.id);
      } else {
        if (rig.lookoutOrigin || savedLook) {
          world.observe();
          if (savedLook) {
            rig.yaw = savedLook.yaw;
            rig.pitch = savedLook.pitch;
            savedLook = null;
          }
        }
        rig.lookoutOrigin = null;
      }

      const activeBoat = boatId ? fleet.boats.get(boatId) : undefined;
      const activeBoatSpeed = activeBoat?.speed ?? 0;
      const bobState = fishing.getActiveBobber();
      const fPhase = fishing.getHudState().phase;
      rig.update(dt, focus, world.cameraBlockers, reduced, {
        waterMode: swimController.frame.mode,
        submersion: swimController.frame.submersion,
        waveSurfaceY: ARENA_WATER_Y,
        boatSpeed: activeBoatSpeed,
        inFishing: !photoOpen && fPhase !== 'idle',
        fishingBobber: bobState.active ? bobberWorldVec.set(bobState.x, ARENA_WATER_Y, bobState.z) : null,
        inSpeaking: p.activeInspect?.kind === 'kiosk',
        inSeated: Boolean(seat),
      });

      const inspected =
        !photoOpen && p.activeInspect?.kind === 'artifact' && p.inspectItem
          ? world.tableItems.items.get(p.activeInspect.id)
          : undefined;
      const viewer = characters.get(self);
      inspectBlend += ((inspected && viewer ? 1 : 0) - inspectBlend) * (reduced ? 1 : 1 - Math.exp(-9 * dt));
      if (inspected && viewer) {
        viewer.stableEye(inspectEye);
        inspectAim.copy(inspected.group.position);
        inspectMatrix.lookAt(inspectEye, inspectAim, inspectUp);
        inspectRotation.setFromRotationMatrix(inspectMatrix);
      }
      if (inspectBlend > 0.002) {
        camera.position.lerp(inspectEye, inspectBlend);
        camera.quaternion.slerp(inspectRotation, inspectBlend);
        camera.updateMatrixWorld();
      }

      const sprintAmount =
        p.view === 'first' && !boatId && !photoOpen ? Math.min(1, Math.max(0, (velocity.length() - 1.8) / 1.5)) : 0;
      const targetFov = rig.recommendedFov(sprintAmount, passage.update(dt, reduced) * 4);
      zoomedFov += (targetFov - zoomedFov) * (reduced || photoOpen ? 1 : 1 - Math.exp(-9 * dt));
      camera.fov = zoomedFov;
      camera.updateProjectionMatrix();

      const own = characters.get(self);
      if (own) {
        eyeCheckVec.copy(focus).setY(focus.y + own.cameraHeight);
        own.root.visible =
          p.activeInspect?.kind !== 'telescope' &&
          (photoOpen || p.view === 'first' || camera.position.distanceTo(eyeCheckVec) > 0.55);
      }

      // Step 36-school 3D Boids marine ecosystem + swimmer FX + predictive 3-ring island streamer
      const surfaceSchools = marine.update({
        dt: simDt,
        time: reduced ? 0 : time,
        playerX: focus.x,
        playerY: focus.y,
        playerZ: focus.z,
        camera,
        boats: combinedWakes,
        bobber: bobState,
        activeBobber: bobState,
        bait: fishing.getActiveBait(),
      });
      const leapSplashes = marine.consumeLeapSplashes();
      const listenerX = motor ? motor.x : focus.x;
      const listenerZ = motor ? motor.z : focus.z;
      for (let i = 0; i < leapSplashes.length; i++) {
        const sp = leapSplashes[i];
        world.sea.triggerSurfaceSplash(sp.x, sp.z, sp.strength, sp.radius);
        if (p.environmentVolume > 0) {
          ambience.triggerFishLeapSplash(sp.x, sp.z, listenerX, listenerZ, rig.yaw, sp.kind, sp.strength);
        }
      }
      if (p.minimapRef?.current) {
        p.minimapRef.current.fishSchools = surfaceSchools;
      }
      if (simDt > 0) {
        swimFx.update(simDt, time, swimController.frame, focus.x, focus.y, focus.z);
      }

      let worldVelX = 0;
      let worldVelZ = 0;
      if (hasPrevFocus && dt > 1e-4) {
        const jumpDist = Math.hypot(focus.x - prevFocusX, focus.z - prevFocusZ);
        if (jumpDist < 6.0) {
          worldVelX = T.MathUtils.clamp((focus.x - prevFocusX) / dt, -16, 16);
          worldVelZ = T.MathUtils.clamp((focus.z - prevFocusZ) / dt, -16, 16);
        }
      }
      prevFocusX = focus.x;
      prevFocusZ = focus.z;
      hasPrevFocus = true;

      camera.getWorldDirection(camFwdVec);
      const chunkChanged = streamer.update({
        playerX: focus.x,
        playerZ: focus.z,
        playerY: focus.y,
        velX: worldVelX,
        velZ: worldVelZ,
        camForwardX: camFwdVec.x,
        camForwardZ: camFwdVec.z,
        inBoat: Boolean(boatId),
        boatYawVel: activeBoat?.yawVel ?? 0,
        waterDepth: swimController.frame.waterDepth,
        submersion: swimController.frame.submersion,
        elapsedSec: time,
        renderer,
      });

      const voiceOrMicActive = Boolean(p.voiceActive) || p.speakers.length > 0;
      ambience.setVoiceActive(voiceOrMicActive);
      ambience.setSubmersion(
        rig.isSubmerged ? 1.0 : swimController.frame.submersion * 0.45,
        camera.position.y,
        swimController.frame.strokeSpeed,
      );
      ambience.update(
        focus.x,
        focus.z,
        angle,
        time,
        p.environmentVolume,
        voiceOrMicActive,
        activeBoatSpeed,
      );

      repelVec.set(focus.x, focus.y, focus.z);
      if (!tierWarmupPending) {
        world.update(
          reduced ? 0 : time,
          focus,
          combinedWakes,
          surfaceSchools,
          renderer,
          camera,
          repelVec,
          simDt,
        );
        world.renderScene(renderer, camera);
      }

      const streamCounts = streamer.getCounts();
      profiler.recordFrame(
        rawDtMs,
        renderer,
        streamCounts.activeChunks,
        streamCounts.warmChunks,
        chunkChanged,
      );

      if ((qa || p.inspect) && frames % 5 === 0) {
        const myBoat = boatId ? fleet.boats.get(boatId) : undefined;
        renderer.domElement.dataset.arenaQa = JSON.stringify({
          qualityTier: activeTier,
          timeOfDay: activeTod,
          opticalZoom: rig.lookoutOrigin ? rig.opticalZoom : null,
          cameraFov: camera.fov,
          engine: myBoat?.engine,
          clip: own?.locomotion,
          swimMode: swimController.frame.mode,
          diveDepth: +swimController.frame.diveDepth.toFixed(2),
          fishingPhase: fishing.getHudState().phase,
          gaitPhase: own ? +own.gaitPhase.toFixed(3) : undefined,
          stridePhase: own ? +own.stridePhase.toFixed(3) : undefined,
          weights: own ? Object.fromEntries([...own.weights].filter(([, v]) => v > 0.01)) : undefined,
          hands: qa ? own?.rig.state : undefined,
          view: p.view,
          photoOpen,
          position: focus.toArray().map(v => +v.toFixed(3)),
          island: arenaIslandAt(focus.x, focus.z),
          boat: boatId,
          boatKind: myBoat?.kind ?? null,
          boatRole,
          boatSpeed: myBoat ? +myBoat.speed.toFixed(2) : 0,
          rowPhase: myBoat ? +myBoat.rowPhase.toFixed(2) : 0,
          contextAction: currentPromptRef.current?.key ?? null,
          promptFading: Boolean(currentPromptRef.current?.fading),
          waterfallStations: world.waterfall.stations.length,
          grassTufts: world.grass.totalTufts,
          activeBirds: world.skyBirds.getActiveBirdCount(),
          leapingFish: marine.getActiveLeapingFishCount(),
          held: [...heldItems],
          artifactTurn: p.artifactTurn,
          beaconsLit: activeBeacons.length,
          peers: players
            .filter(x => x.id !== self)
            .map(x => ({
              id: x.id,
              pos: characters.get(x.id)?.root.position.toArray().map(v => +v.toFixed(3)),
              boat: x.boat ?? null,
              role: x.boatRole ?? null,
              clip: characters.get(x.id)?.locomotion,
            })),
          jitter: p.motion.jitter,
          grounded: motor?.grounded,
          submerged: rig.isSubmerged,
          camera: camera.position.toArray().map(v => +v.toFixed(3)),
          yaw: rig.yaw,
          pitch: rig.pitch,
          visible: own?.root.visible,
          locked: document.pointerLockElement === renderer.domElement,
          desired: mouseLook.desired,
          speed: boatId
            ? activeBoatSpeed
            : swimController.frame.mode !== 'land'
              ? swimController.frame.strokeSpeed
              : velocity.length(),
          fov: +camera.fov.toFixed(1),
          eyeHeight: own?.eyeHeight,
          dt,
          draws: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
        });
      }

      if (now - statAt > 2000) {
        p.onStats({
          fps: Math.round((frames * 1000) / (now - statAt)),
          draws: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
        });
        frames = 0;
        statAt = now;
      }
    };

    camera.position.set(0, 9, 14);
    camera.lookAt(0, 0.7, 0);
    if (document.visibilityState !== 'hidden') raf = requestAnimationFrame(frame);

    return () => {
      retained.current = { pose: previewPose, yaw: rig.yaw, pitch: rig.pitch, zoom: rig.zoom };
      sceneHandlesRef.current = null;
      if (live.current.fishingControlRef) live.current.fishingControlRef.current = null;
      if (live.current.photoControlRef) live.current.photoControlRef.current = null;
      if (qa) delete (window as unknown as { __arenaQA?: unknown }).__arenaQA;
      if ((window as unknown as { __EC_ARENA_ENV__?: unknown }).__EC_ARENA_ENV__ === envTelemetry) {
        delete (window as unknown as { __EC_ARENA_ENV__?: unknown }).__EC_ARENA_ENV__;
      }
      unbindProfiler();
      profiler.dispose();
      disposed = true;
      blur();
      mouseLook.dispose();
      lock.current = null;
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('mousemove', mouse);
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      for (const id of [...characters.keys()]) remove(id);
      for (const gltf of templates.values()) disposeTemplate(gltf);
      fishing.dispose();
      fruitTrees.dispose();
      marine.dispose();
      swimFx.dispose();
      fleet.dispose();
      world.dispose();
      residency.disposeAll();
      scene.traverse(o => {
        const mesh = o as T.Mesh;
        if (mesh.isMesh) {
          mesh.geometry.dispose();
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach(m => m.dispose());
        }
      });
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      ambience.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      pClear(live.current.space.current);
    };
  }, []); // Single unified WebGLRenderer lifecycle — quality & atmosphere mutate in place!

  return (
    <div className={styles.scene} ref={host} data-testid="arena-scene">
      {props.activeInspect?.kind === 'telescope' && !props.photoState?.open && (
        <div className={styles.optics}>
          <i />
          <output ref={opticalLabel}>2.0×</output>
        </div>
      )}
      {promptPill &&
        !props.blocked &&
        !props.photoState?.open &&
        (!props.activeInspect || props.activeInspect.kind === 'artifact') &&
        (promptPill.canTrigger ? (
          <button
            type="button"
            className={styles.seatAction}
            data-testid="arena-context-action"
            data-action-kind={promptPill.kind}
            onClick={() => triggerRef.current()}
          >
            <span>{props.vi ? promptPill.labelVi : promptPill.labelEn}</span>
            <kbd>{promptPill.keyHint ?? 'E'}</kbd>
          </button>
        ) : (
          <div
            className={promptPill.fading ? `${styles.boatHint} ${styles.boatHintFading}` : styles.boatHint}
            data-fading={promptPill.fading ? 'true' : undefined}
            role="status"
            data-testid="arena-boat-hint"
          >
            {props.vi ? promptPill.labelVi : promptPill.labelEn}
          </div>
        ))}
      {props.view !== 'overview' && !props.blocked && !props.photoState?.open && !props.activeInspect && (
        <button
          type="button"
          {...props.edge}
          className={`${styles.mouseLook} ${props.edge?.className ?? ''}`}
          data-testid="arena-mouse-look"
          data-resume={look.needsResume || undefined}
          onClick={toggleMouse}
          aria-pressed={look.locked}
        >
          {look.needsResume
            ? props.vi
              ? 'Bấm để nhìn tiếp bằng chuột'
              : 'Click to resume mouse look'
            : look.locked
              ? props.vi
                ? 'Esc để thả chuột'
                : 'Esc releases mouse'
              : props.vi
                ? 'Nhìn bằng chuột'
                : 'Mouse look'}
        </button>
      )}
      {!loaded && !failed && (
        <div className={styles.sceneMessage} role="status" data-testid="arena-loading-banner">
          <span>{props.vi ? prepProgress.detailVi : prepProgress.detailEn}</span>
          <small>{Math.round(prepProgress.fraction * 100)}%</small>
        </div>
      )}
      {failed && (
        <div className={styles.sceneMessage} role="alert">
          {props.vi
            ? 'Không thể dựng cảnh 3D trên thiết bị này. Bạn vẫn có thể dùng bảng phòng và voice.'
            : '3D is unavailable on this device. Room controls and voice remain available.'}
        </div>
      )}
    </div>
  );
}

function pClear(space: ArenaAudioSpace) {
  space.players.clear();
  space.updatedAt = undefined;
}

function disposeTemplate(gltf: GLTF) {
  gltf.scene.traverse(o => {
    const mesh = o as T.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const value of Object.values(m)) {
        if (value instanceof T.Texture) value.dispose();
      }
      m.dispose();
    }
  });
}
