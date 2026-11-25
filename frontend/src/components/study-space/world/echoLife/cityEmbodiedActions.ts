/**
 * Echo Life Wave 11 — Unified 7-Phase Embodied Open-City Interaction Sequencer.
 *
 * Transforms formerly notification-only city and home actions into physically grounded,
 * interruptible 7-phase embodied sequences:
 *   idle -> approach -> position -> reach -> operate (timed gesture + VFX + spatial audio) -> release -> recover
 *
 * Guarantees zero infinite locks: any player movement input (WASD/Arrows), Escape key, explicit `cancel()`,
 * or safety wall-clock deadline cleanly aborts and restores normal standing/seated locomotion.
 * Zero per-frame heap allocations in steady state, 100% clean English copy, zero passive AI/LLM calls.
 */
import * as T from 'three';
import type { Target } from '@/lib/echo-life/game/session';
import type { V3Result } from '@/lib/echo-life/v3/game-core/index.mjs';
import type { ActivityFoleyKind, EchoLifeWorldAudio } from './worldAudio';

export type EmbodiedPhase =
  | 'idle'
  | 'approach'
  | 'position'
  | 'reach'
  | 'operate'
  | 'release'
  | 'recover';

export type EmbodiedGesture =
  | 'stir'
  | 'pour'
  | 'eat'
  | 'self_care'
  | 'shower_rinse'
  | 'watch_tv'
  | 'reach'
  | 'kneel_tend'
  | 'strum'
  | 'type'
  | 'stock'
  | 'shelve'
  | 'timetable';

export type EmbodiedVfxKind = 'none' | 'steam' | 'water' | 'notes' | 'warm_glow';

export type EmbodiedHandGrip = 'handle' | 'pinch' | 'support' | 'book' | 'rest';
export type EmbodiedHandSide = 'right' | 'left' | 'both';

export interface EmbodiedHandTarget {
  x: number;
  y: number;
  z: number;
  grip: EmbodiedHandGrip;
  side: EmbodiedHandSide;
}

export interface EmbodiedSeatTarget {
  readonly id?: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly top?: number;
}

/**
 * Structured embodied alignment & HumanRig IK target consumed by `gameHost.ts` / `engine.ts` / `character.ts`.
 */
export interface EmbodiedActionTarget {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly handTarget?: EmbodiedHandTarget | null;
  readonly seat?: EmbodiedSeatTarget | null;
  readonly clip?: string | null;
  readonly durationSec: number;
}

export interface EmbodiedActionSpec {
  readonly actionId: string;
  readonly label: string;
  readonly gesture: EmbodiedGesture;
  readonly clip?: string | null;
  readonly operateSeconds: number;
  readonly targetPos: { x: number; y: number; z: number };
  readonly standPos: { x: number; y?: number; z: number };
  readonly preferredFacingYaw?: number | null;
  readonly commitOnOperateStart?: boolean;
  readonly audioCue: ActivityFoleyKind | 'tap' | 'register' | 'sizzle' | 'water_care' | null;
  readonly vfx: EmbodiedVfxKind;
  readonly preferSeat: boolean;
  readonly crouchWeight: number;
}

export interface EmbodiedActionSnapshot {
  readonly active: boolean;
  readonly actionId: string;
  readonly label: string;
  readonly phase: EmbodiedPhase;
  readonly gesture: EmbodiedGesture;
  readonly clip: string | null;
  readonly progress: number;
  readonly phaseProgress: number;
  readonly facingYaw: number;
  readonly armWeight: number;
  readonly crouchWeight: number;
  readonly gesturePulse: number;
  readonly pulsePhase: number;
  readonly standPos: { x: number; y: number; z: number };
  readonly targetPos: { x: number; y: number; z: number };
  readonly target: EmbodiedActionTarget;
  readonly seatedUsed: boolean;
  readonly needsWalk: boolean;
  readonly autoApproaching: boolean;
}

export interface EmbodiedStartOptions {
  bodyPos?: { x: number; y?: number; z: number } | null;
  bodyYaw?: number;
  immediate?: boolean;
  onSeatRequest?: (near: { x: number; z: number }) => boolean | EmbodiedSeatTarget | null | undefined;
  onOperateStart?: (spec: EmbodiedActionSpec) => void;
  onCancel?: (reason: string, spec: EmbodiedActionSpec) => void;
}

const MIN_APPROACH_SECONDS = 0.12;
const MAX_APPROACH_SECONDS = 1.85;
const SEATED_APPROACH_SECONDS = 0.30;
const APPROACH_WALK_SPEED = 1.32;
const STAND_ARRIVE_DIST = 0.14;
const POSITION_SECONDS = 0.10;
const REACH_SECONDS = 0.16;
const RELEASE_SECONDS = 0.14;
const RECOVER_SECONDS = 0.12;
const MOVE_CANCEL_DIST = 0.42;
const MANUAL_CANCEL_GRACE_SEC = 0.15;

const CANCEL_KEY_CODES = new Set([
  'Escape',
  'Space',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

/**
 * Maps an Echo Life target and action key into a physical 7-phase embodied sequence spec.
 * Returns `null` for instant panel/menu actions (`open_market_shop`, `pc_configure`, `open_build`, `step_out_shower`),
 * direct NPC dialogue, basketball, vehicles, seats, and beds (which own their dedicated physical controllers).
 */
export function classifyEmbodiedAction(
  target: Target | null,
  key: string,
  fallbackPos?: { x: number; y?: number; z: number } | null,
): EmbodiedActionSpec | null {
  const cleanKey = (key || '').trim();
  if (
    !cleanKey ||
    cleanKey === 'open_market_shop' ||
    cleanKey === 'pc_configure' ||
    cleanKey === 'open_build' ||
    cleanKey === 'step_out_shower' ||
    cleanKey === 'sit' ||
    cleanKey === 'ride'
  ) {
    return null;
  }

  const spot = target?.kind === 'spot' ? target.hotspot : null;
  const spotAction = spot?.action ?? '';

  if (target && (target.kind === 'npc' || target.kind === 'seat' || target.kind === 'car' || target.kind === 'twoWheeler' || target.kind === 'bike')) {
    return null;
  }
  if (spotAction === 'sleep' || spotAction === 'sit' || spotAction === 'rest' || spotAction === 'sport') {
    return null;
  }

  const floorY =
    typeof fallbackPos?.y === 'number' && Number.isFinite(fallbackPos.y)
      ? fallbackPos.y
      : spot && 'y' in spot && typeof (spot as { y?: number }).y === 'number' && Number.isFinite((spot as { y: number }).y)
        ? (spot as { y: number }).y
        : 0;

  const at = target
    ? { x: target.at.x, y: floorY, z: target.at.z }
    : { x: fallbackPos?.x ?? 0, y: floorY, z: fallbackPos?.z ?? 0 };
  const stand = spot
    ? { x: spot.stand.x, y: floorY, z: spot.stand.z }
    : { x: at.x, y: floorY, z: at.z };

  // 1. All 7 Part-Time Job Shift Stations (`job:<jobId>`)
  if (cleanKey.startsWith('job:')) {
    const jobId = cleanKey.slice(4);
    switch (jobId) {
      case 'market':
        return {
          actionId: cleanKey,
          label: spot?.id === 'till' ? 'Counting the register till' : 'Stocking the market shelf',
          gesture: spot?.id === 'till' ? 'reach' : 'stock',
          operateSeconds: 0.9,
          targetPos: at,
          standPos: stand,
          audioCue: spot?.id === 'till' ? 'register' : 'tap',
          vfx: 'none',
          preferSeat: false,
          crouchWeight: 0,
        };
      case 'barista':
        return {
          actionId: cleanKey,
          label: 'Pulling a balanced double espresso',
          gesture: 'pour',
          operateSeconds: 1.2,
          targetPos: at,
          standPos: stand,
          audioCue: 'espresso',
          vfx: 'steam',
          preferSeat: false,
          crouchWeight: 0,
        };
      case 'delivery':
        return {
          actionId: cleanKey,
          label: 'Securing the express courier parcel',
          gesture: 'reach',
          operateSeconds: 0.8,
          targetPos: at,
          standPos: stand,
          audioCue: 'tap',
          vfx: 'none',
          preferSeat: false,
          crouchWeight: 0,
        };
      case 'library':
        return {
          actionId: cleanKey,
          label: 'Shelving archive folios neatly',
          gesture: 'shelve',
          operateSeconds: 1.1,
          targetPos: at,
          standPos: stand,
          audioCue: 'book_page',
          vfx: 'none',
          preferSeat: false,
          crouchWeight: 0,
        };
      case 'cafe':
        return {
          actionId: cleanKey,
          label: 'Running hardware diagnostics at Pixel Cafe',
          gesture: 'type',
          operateSeconds: 1.1,
          targetPos: at,
          standPos: stand,
          audioCue: 'tap',
          vfx: 'warm_glow',
          preferSeat: false,
          crouchWeight: 0,
        };
      case 'gardener':
        return {
          actionId: cleanKey,
          label: 'Watering the botanical herb beds',
          gesture: 'kneel_tend',
          operateSeconds: 1.2,
          targetPos: at,
          standPos: stand,
          audioCue: 'garden_water',
          vfx: 'water',
          preferSeat: false,
          crouchWeight: 0.48,
        };
      case 'busker':
        return {
          actionId: cleanKey,
          label: 'Playing an acoustic plaza set',
          gesture: 'strum',
          operateSeconds: 1.4,
          targetPos: at,
          standPos: stand,
          audioCue: 'guitar_chord',
          vfx: 'notes',
          preferSeat: false,
          crouchWeight: 0,
        };
      default:
        return {
          actionId: cleanKey,
          label: 'Working your shift station',
          gesture: 'reach',
          operateSeconds: 0.9,
          targetPos: at,
          standPos: stand,
          audioCue: 'tap',
          vfx: 'none',
          preferSeat: false,
          crouchWeight: 0,
        };
    }
  }

  // 2. Home Cooking (`cook` / `cook:<recipeId>`)
  if (cleanKey === 'cook' || cleanKey.startsWith('cook:') || (spotAction === 'cook' && cleanKey !== 'brew_home_tea')) {
    return {
      actionId: cleanKey,
      label: 'Cooking a warm home meal',
      gesture: 'stir',
      operateSeconds: 1.4,
      targetPos: at,
      standPos: stand,
      audioCue: 'sizzle',
      vfx: 'steam',
      preferSeat: false,
      crouchWeight: 0,
    };
  }

  // 3. Kettle Tea / Home Espresso / Buy Coffee (`brew_home_tea` / `brew_use` / `buy_coffee` / `tea_ceremony`)
  if (
    cleanKey === 'brew_home_tea' ||
    cleanKey === 'brew_use' ||
    cleanKey === 'buy_coffee' ||
    cleanKey === 'coffee' ||
    cleanKey === 'cafe_order' ||
    cleanKey.startsWith('buy_coffee:') ||
    cleanKey.startsWith('cafe_order:') ||
    spotAction === 'use_appliance' ||
    spotAction === 'tea_ceremony' ||
    spotAction === 'tea' ||
    spotAction === 'coffee' ||
    spotAction === 'espresso'
  ) {
    const isCoffee =
      cleanKey.includes('coffee') ||
      cleanKey.startsWith('cafe_order') ||
      spotAction === 'use_appliance' ||
      spotAction === 'coffee' ||
      spotAction === 'espresso';
    return {
      actionId: cleanKey,
      label: isCoffee ? 'Brewing fresh espresso' : 'Steeping warm kettle tea',
      gesture: 'pour',
      operateSeconds: 1.1,
      targetPos: at,
      standPos: stand,
      audioCue: isCoffee ? 'espresso' : 'tea_pour',
      vfx: 'steam',
      preferSeat: false,
      crouchWeight: 0,
    };
  }

  // 4. Eating and Willow Bistro Orders (`eat` / `bistro_order` / `bistro_order:<sku>`)
  if (
    cleanKey === 'eat' ||
    cleanKey === 'bistro_order' ||
    cleanKey.startsWith('bistro_order:') ||
    spotAction === 'bistro_order' ||
    spotAction === 'bistro_snack' ||
    spotAction === 'eat'
  ) {
    return {
      actionId: cleanKey,
      label: 'Enjoying a fresh meal',
      gesture: 'eat',
      operateSeconds: 1.4,
      targetPos: at,
      standPos: stand,
      audioCue: 'tea_pour',
      vfx: 'warm_glow',
      preferSeat: true,
      crouchWeight: 0,
    };
  }

  // 5. Walk-In Shower & Bathroom Self-Care (`take_shower` / `toggle_shower` / `bath` / `bath_soak` / `wash_hands` / `toilet` / `mirror`)
  if (cleanKey === 'toggle_shower') {
    const stayStand = fallbackPos
      ? { x: fallbackPos.x, y: floorY, z: fallbackPos.z }
      : stand;
    return {
      actionId: cleanKey,
      label: 'Adjusting the shower valve',
      gesture: 'reach',
      clip: null,
      operateSeconds: 0.45,
      targetPos: at,
      standPos: stayStand,
      commitOnOperateStart: true,
      audioCue: 'water_care',
      vfx: 'water',
      preferSeat: false,
      crouchWeight: 0,
    };
  }

  const isShowerSpot = spot?.id === 'shower' || spot?.id === 'residence_shower' || spotAction === 'shower';
  if (
    cleanKey === 'take_shower' ||
    (isShowerSpot && (cleanKey === 'bath' || cleanKey === 'shower'))
  ) {
    return {
      actionId: cleanKey,
      label: 'Taking a warm shower',
      gesture: 'shower_rinse',
      clip: 'shower_rinse',
      operateSeconds: 3.6,
      targetPos: at,
      standPos: stand,
      preferredFacingYaw: spot?.zone === 'bath' && spot?.id === 'shower' ? Math.atan2(-0.85, -0.52) : null,
      commitOnOperateStart: true,
      audioCue: 'water_care',
      vfx: 'steam',
      preferSeat: false,
      crouchWeight: 0,
    };
  }

  if (
    cleanKey === 'bath' ||
    cleanKey === 'bath_soak' ||
    cleanKey === 'wash_hands' ||
    cleanKey === 'toilet' ||
    cleanKey === 'mirror' ||
    spotAction === 'bath' ||
    spotAction === 'bath_soak' ||
    spotAction === 'wash' ||
    spotAction === 'hygiene' ||
    spotAction === 'toilet' ||
    spotAction === 'mirror'
  ) {
    const isMirror = cleanKey === 'mirror' || spotAction === 'mirror';
    const isToilet = cleanKey === 'toilet' || spotAction === 'toilet';
    const isBasinWash =
      cleanKey === 'wash_hands' ||
      spotAction === 'wash' ||
      spot?.id === 'basin' ||
      (cleanKey === 'bath' && !isShowerSpot);
    const label = isToilet
      ? 'Using the restroom'
      : isMirror
        ? 'Pep talk in the mirror'
        : isBasinWash
          ? 'Washing hands at the basin'
          : 'Taking a refreshing soak';
    return {
      actionId: cleanKey,
      label,
      gesture: 'self_care',
      clip: null,
      operateSeconds: isMirror ? 1.35 : 1.2,
      targetPos: at,
      standPos: stand,
      audioCue: isMirror ? 'tap' : 'water_care',
      vfx: isMirror ? 'warm_glow' : (cleanKey === 'bath_soak' || spotAction === 'bath_soak' ? 'steam' : 'water'),
      preferSeat: false,
      crouchWeight: 0,
    };
  }

  // 5b. Living Room Watch TV / Turn Off TV (`watch_tv` / `tv_off` / `tv`)
  if (
    cleanKey === 'watch_tv' ||
    cleanKey === 'tv_off' ||
    cleanKey === 'tv' ||
    spotAction === 'tv'
  ) {
    if (cleanKey === 'tv_off') {
      return {
        actionId: cleanKey,
        label: 'Turning off the television',
        gesture: 'reach',
        clip: null,
        operateSeconds: 0.45,
        targetPos: at,
        standPos: stand,
        commitOnOperateStart: true,
        audioCue: 'tap',
        vfx: 'none',
        preferSeat: false,
        crouchWeight: 0,
      };
    }
    return {
      actionId: cleanKey,
      label: 'Watching television',
      gesture: 'watch_tv',
      clip: null,
      operateSeconds: 2.2,
      targetPos: at,
      standPos: stand,
      commitOnOperateStart: true,
      audioCue: 'tap',
      vfx: 'warm_glow',
      preferSeat: true,
      crouchWeight: 0,
    };
  }

  // 6. Sunrise Market Basket / Checkout (`basket` / `checkout`)
  if (cleanKey === 'basket' || cleanKey === 'checkout' || spotAction === 'basket' || spotAction === 'checkout') {
    const isCheckout = cleanKey === 'checkout' || spotAction === 'checkout';
    return {
      actionId: cleanKey,
      label: isCheckout ? 'Completing market checkout' : 'Adding groceries to your basket',
      gesture: 'reach',
      operateSeconds: 0.7,
      targetPos: at,
      standPos: stand,
      audioCue: isCheckout ? 'register' : 'tap',
      vfx: 'none',
      preferSeat: false,
      crouchWeight: 0,
    };
  }

  // 7. Gardening (`garden_tend` / `garden_harvest`)
  if (
    cleanKey === 'garden_tend' ||
    cleanKey === 'garden_harvest' ||
    spotAction === 'garden_tend' ||
    spotAction === 'garden_harvest' ||
    spotAction === 'garden' ||
    spotAction === 'water'
  ) {
    return {
      actionId: cleanKey,
      label: cleanKey === 'garden_harvest' || spotAction === 'garden_harvest'
        ? 'Harvesting fresh herbs'
        : 'Tending the garden bed',
      gesture: 'kneel_tend',
      operateSeconds: 1.2,
      targetPos: at,
      standPos: stand,
      audioCue: 'garden_water',
      vfx: 'water',
      preferSeat: false,
      crouchWeight: 0.45,
    };
  }

  // 8. Acoustic Music Jam (`music_jam`)
  if (
    cleanKey === 'music_jam' ||
    spotAction === 'music_jam' ||
    spotAction === 'music' ||
    spotAction === 'busk' ||
    spotAction === 'guitar'
  ) {
    return {
      actionId: cleanKey,
      label: 'Strumming acoustic chords',
      gesture: 'strum',
      operateSeconds: 1.5,
      targetPos: at,
      standPos: stand,
      audioCue: 'guitar_chord',
      vfx: 'notes',
      preferSeat: false,
      crouchWeight: 0,
    };
  }

  // 9. Study / Desk Typing (`pc_study` / `residence_study` / `library_study` / `archive_research` / `learn`)
  if (
    cleanKey === 'pc_study' ||
    cleanKey === 'residence_study' ||
    spotAction === 'residence_study' ||
    spotAction === 'library_study' ||
    spotAction === 'archive_research' ||
    spotAction === 'learn' ||
    spotAction === 'study' ||
    spotAction === 'read'
  ) {
    return {
      actionId: cleanKey,
      label: cleanKey === 'pc_study' ? 'Working at your desktop rig' : 'Studying with quiet focus',
      gesture: 'type',
      operateSeconds: 1.1,
      targetPos: at,
      standPos: stand,
      audioCue: 'book_page',
      vfx: 'none',
      preferSeat: true,
      crouchWeight: 0,
    };
  }

  // 10. Riverside Shuttle Bus Stop (`bus_stop:<stopId>`)
  if (cleanKey === 'bus_stop' || cleanKey.startsWith('bus_stop:') || spotAction === 'bus_stop' || spotAction === 'transit') {
    return {
      actionId: cleanKey,
      label: 'Checking the Riverside Shuttle timetable',
      gesture: 'timetable',
      operateSeconds: 0.85,
      targetPos: at,
      standPos: stand,
      audioCue: 'tap',
      vfx: 'warm_glow',
      preferSeat: false,
      crouchWeight: 0,
    };
  }

  // 11. Bookshelf / Archive Browsing (`read_shelf` / `books` / `browse_shelf` / `shelf`)
  if (
    cleanKey === 'read_shelf' ||
    cleanKey === 'books' ||
    cleanKey === 'browse_shelf' ||
    cleanKey.startsWith('read_shelf:') ||
    spotAction === 'books' ||
    spotAction === 'read_shelf' ||
    spotAction === 'shelf'
  ) {
    return {
      actionId: cleanKey,
      label: 'Browsing the bookshelf carefully',
      gesture: 'shelve',
      operateSeconds: 0.95,
      targetPos: at,
      standPos: stand,
      audioCue: 'book_page',
      vfx: 'none',
      preferSeat: false,
      crouchWeight: 0,
    };
  }

  // 12. ATM, Parcel Locker, Vending, Noticeboard, Map Kiosk, Keepsake Inspection (`atm` / `inspect` / `notice` / `parcel`)
  if (
    cleanKey === 'atm' ||
    cleanKey.startsWith('atm:') ||
    cleanKey === 'parcel' ||
    cleanKey === 'parcel_locker' ||
    cleanKey === 'inspect' ||
    cleanKey.startsWith('inspect:') ||
    cleanKey === 'notice' ||
    cleanKey === 'map_kiosk' ||
    cleanKey === 'collect_relic' ||
    spotAction === 'atm' ||
    spotAction === 'parcel' ||
    spotAction === 'inspect' ||
    spotAction === 'notice' ||
    spotAction === 'map_kiosk' ||
    spotAction === 'vending' ||
    spotAction === 'collect_relic'
  ) {
    const isAtmOrLocker =
      cleanKey.startsWith('atm') ||
      cleanKey.includes('parcel') ||
      spotAction === 'atm' ||
      spotAction === 'parcel' ||
      spotAction === 'vending';
    const isBoard =
      cleanKey === 'notice' ||
      cleanKey === 'map_kiosk' ||
      spotAction === 'notice' ||
      spotAction === 'map_kiosk';
    return {
      actionId: cleanKey,
      label: isAtmOrLocker
        ? 'Using the street kiosk terminal'
        : isBoard
          ? 'Reading the campus notice board'
          : 'Inspecting closely',
      gesture: isBoard ? 'timetable' : 'reach',
      operateSeconds: isAtmOrLocker ? 0.85 : 0.75,
      targetPos: at,
      standPos: stand,
      audioCue: isAtmOrLocker ? 'register' : 'tap',
      vfx: isAtmOrLocker || isBoard ? 'warm_glow' : 'none',
      preferSeat: false,
      crouchWeight: 0,
    };
  }

  return null;
}

interface ActiveSequence {
  spec: EmbodiedActionSpec;
  phase: EmbodiedPhase;
  phaseElapsed: number;
  totalElapsed: number;
  totalDuration: number;
  approachDuration: number;
  floorY: number;
  startPos: { x: number; z: number } | null;
  lastBodyPos: { x: number; z: number } | null;
  facingYaw: number;
  seatedUsed: boolean;
  claimedSeat: EmbodiedSeatTarget | null;
  committed: boolean;
  cuePlayed: boolean;
  commitFn: () => Promise<V3Result>;
  commitPromise: Promise<V3Result> | null;
  commitResult: V3Result | null;
  onOperateStart?: (spec: EmbodiedActionSpec) => void;
  onCancel?: (reason: string, spec: EmbodiedActionSpec) => void;
  resolve: (result: V3Result) => void;
  safetyTimer: ReturnType<typeof setTimeout> | null;
}

function buildHandTargetInto(
  spec: EmbodiedActionSpec,
  floorY: number,
  facingYaw: number,
  pulsePhase: number,
  out: EmbodiedHandTarget,
): EmbodiedHandTarget | null {
  const sinP = Math.sin(pulsePhase);
  const cosP = Math.cos(pulsePhase);
  const rightX = Math.cos(facingYaw);
  const rightZ = -Math.sin(facingYaw);
  const tx = spec.targetPos.x;
  const tz = spec.targetPos.z;

  switch (spec.gesture) {
    case 'strum':
    case 'shower_rinse':
    case 'watch_tv':
      // Base skeletal clip (`guitar`, `shower_rinse`, or seated sofa posture) owns both hands in body space
      return null;
    case 'pour':
      out.x = tx + rightX * 0.06;
      out.y = floorY + 0.98 + sinP * 0.03;
      out.z = tz + rightZ * 0.06;
      out.grip = 'handle';
      out.side = 'right';
      return out;
    case 'stir':
      out.x = tx + cosP * 0.085;
      out.y = floorY + 0.93;
      out.z = tz + sinP * 0.085;
      out.grip = 'handle';
      out.side = 'right';
      return out;
    case 'stock':
      out.x = tx;
      out.y = floorY + 1.06 + sinP * 0.08;
      out.z = tz;
      out.grip = 'support';
      out.side = 'both';
      return out;
    case 'shelve':
      out.x = tx;
      out.y = floorY + 1.34 + sinP * 0.08;
      out.z = tz;
      out.grip = 'book';
      out.side = 'right';
      return out;
    case 'kneel_tend':
      out.x = tx + rightX * (sinP * 0.06);
      out.y = floorY + 0.38;
      out.z = tz + rightZ * (sinP * 0.06);
      out.grip = 'pinch';
      out.side = 'right';
      return out;
    case 'type':
      out.x = tx;
      out.y = floorY + 0.90 + sinP * 0.012;
      out.z = tz;
      out.grip = 'rest';
      out.side = 'both';
      return out;
    case 'eat':
      out.x = tx;
      out.y = floorY + 0.80;
      out.z = tz;
      out.grip = 'handle';
      out.side = 'right';
      return out;
    case 'self_care':
      out.x = tx;
      out.y = floorY + 0.88;
      out.z = tz;
      out.grip = 'rest';
      out.side = 'both';
      return out;
    case 'timetable':
      out.x = tx;
      out.y = floorY + 1.48;
      out.z = tz;
      out.grip = 'pinch';
      out.side = 'right';
      return out;
    case 'reach':
    default:
      out.x = tx;
      out.y = floorY + 1.02;
      out.z = tz;
      out.grip = 'pinch';
      out.side = 'right';
      return out;
  }
}

/**
 * Lightweight 7-phase physical interaction runner attached to `EchoLifeGameHost`.
 * Drives structured alignment & HumanRig hand-IK targets (`getActionTarget()` / `snapshot()`),
 * subtle pooled 3D VFX cues, and spatial Web Audio foley before committing the underlying V3/server action cleanly.
 */
export class CityEmbodiedActions {
  private active: ActiveSequence | null = null;
  private keysBound = false;
  private readonly vfxGroup = new T.Group();
  private readonly vfxPuffs: T.Mesh[] = [];
  private readonly vfxGeo: T.SphereGeometry;
  private readonly vfxMats: Record<Exclude<EmbodiedVfxKind, 'none'>, T.MeshBasicMaterial>;
  private disposed = false;

  // Zero-alloc reusable snapshot & structured target scratch buffers
  private readonly standPosScratch = { x: 0, y: 0, z: 0 };
  private readonly targetPosScratch = { x: 0, y: 0, z: 0 };
  private readonly handTargetScratch: EmbodiedHandTarget = { x: 0, y: 0, z: 0, grip: 'pinch', side: 'right' };
  private readonly targetScratch: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    handTarget: EmbodiedHandTarget | null;
    seat: EmbodiedSeatTarget | null;
    clip: string | null;
    durationSec: number;
  } = {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    handTarget: null,
    seat: null,
    clip: null,
    durationSec: 0,
  };
  private readonly snapScratch: {
    active: boolean;
    actionId: string;
    label: string;
    phase: EmbodiedPhase;
    gesture: EmbodiedGesture;
    clip: string | null;
    progress: number;
    phaseProgress: number;
    facingYaw: number;
    armWeight: number;
    crouchWeight: number;
    gesturePulse: number;
    pulsePhase: number;
    standPos: { x: number; y: number; z: number };
    targetPos: { x: number; y: number; z: number };
    target: EmbodiedActionTarget;
    seatedUsed: boolean;
    needsWalk: boolean;
    autoApproaching: boolean;
  };

  constructor(
    private readonly stage: T.Object3D | null,
    private readonly audio: EchoLifeWorldAudio | null,
  ) {
    this.snapScratch = {
      active: false,
      actionId: '',
      label: '',
      phase: 'idle',
      gesture: 'reach',
      clip: null,
      progress: 0,
      phaseProgress: 0,
      facingYaw: 0,
      armWeight: 0,
      crouchWeight: 0,
      gesturePulse: 0,
      pulsePhase: 0,
      standPos: this.standPosScratch,
      targetPos: this.targetPosScratch,
      target: this.targetScratch,
      seatedUsed: false,
      needsWalk: false,
      autoApproaching: false,
    };
    this.vfxGroup.name = 'echo-life-embodied-vfx';
    this.vfxGroup.visible = false;
    this.vfxGeo = new T.SphereGeometry(0.045, 7, 6);
    this.vfxMats = {
      steam: new T.MeshBasicMaterial({ color: '#f3f5f8', transparent: true, opacity: 0.42, depthWrite: false }),
      water: new T.MeshBasicMaterial({ color: '#7dd3fc', transparent: true, opacity: 0.52, depthWrite: false }),
      notes: new T.MeshBasicMaterial({ color: '#fbbf24', transparent: true, opacity: 0.65, depthWrite: false }),
      warm_glow: new T.MeshBasicMaterial({ color: '#fde68a', transparent: true, opacity: 0.36, depthWrite: false }),
    };
    for (let i = 0; i < 6; i++) {
      const m = new T.Mesh(this.vfxGeo, this.vfxMats.steam);
      m.castShadow = false;
      m.receiveShadow = false;
      m.visible = false;
      this.vfxGroup.add(m);
      this.vfxPuffs.push(m);
    }
    this.stage?.add(this.vfxGroup);
  }

  get isActive(): boolean {
    return this.active !== null;
  }

  /**
   * Returns the structured physical alignment & HumanRig target `{ x, y, z, yaw, handTarget?, seat?, clip?, durationSec }`
   * for the active embodied action (`null` when idle). Zero allocations per call.
   */
  getActionTarget(): EmbodiedActionTarget | null {
    const snap = this.snapshot();
    return snap ? snap.target : null;
  }

  /**
   * Keeps `startPos` (and `floorY`) synchronized while `gameHost.ts`/`engine.ts` auto-walks the player to `standPos`,
   * preventing `MOVE_CANCEL_DIST` from self-cancelling automated physical approach!
   */
  syncAutoApproachPos(pos: { x: number; y?: number; z: number }): void {
    const cur = this.active;
    if (!cur) return;
    if (typeof pos.y === 'number' && Number.isFinite(pos.y)) {
      cur.floorY = pos.y;
    }
    if (cur.phase === 'approach' || cur.phase === 'position') {
      if (cur.startPos) {
        cur.startPos.x = pos.x;
        cur.startPos.z = pos.z;
      } else {
        cur.startPos = { x: pos.x, z: pos.z };
      }
    }
  }

  /** Cancels the active embodied sequence cleanly when manual WASD/Arrow/Jump input is detected. */
  notifyManualMoveInput(): void {
    const cur = this.active;
    if (!cur || cur.totalElapsed < MANUAL_CANCEL_GRACE_SEC) return;
    this.cancel('Action interrupted by movement.');
  }

  /** Active seat ID claimed by the running embodied interaction, or `null` when standing/idle. */
  get claimedSeatId(): string | null {
    return this.active?.claimedSeat?.id ?? null;
  }

  /** Returns a zero-allocation live pose, target, and HUD snapshot when active, or `null` when idle. */
  snapshot(): EmbodiedActionSnapshot | null {
    const cur = this.active;
    if (!cur) return null;
    const phaseDur = this.phaseDuration(cur.phase, cur);
    const phaseProgress = phaseDur > 0 ? Math.min(1, cur.phaseElapsed / phaseDur) : 1;
    const progress = cur.totalDuration > 0 ? Math.min(1, cur.totalElapsed / cur.totalDuration) : 1;

    let armWeight = 0;
    let crouchWeight = 0;
    if (cur.phase === 'reach') {
      armWeight = phaseProgress;
      crouchWeight = cur.spec.crouchWeight * phaseProgress;
    } else if (cur.phase === 'operate') {
      armWeight = 1;
      crouchWeight = cur.spec.crouchWeight;
    } else if (cur.phase === 'release') {
      armWeight = 1 - phaseProgress * 0.65;
      crouchWeight = cur.spec.crouchWeight * (1 - phaseProgress * 0.65);
    } else if (cur.phase === 'recover') {
      armWeight = (1 - phaseProgress) * 0.35;
      crouchWeight = cur.spec.crouchWeight * (1 - phaseProgress) * 0.35;
    }

    const pulseFreq = cur.spec.gesture === 'strum' ? 9.5 : cur.spec.gesture === 'type' ? 12.0 : 5.2;
    const pulsePhase = cur.phase === 'operate' ? cur.phaseElapsed * pulseFreq : 0;
    const gesturePulse = cur.phase === 'operate' ? 0.5 + 0.5 * Math.sin(pulsePhase) : 0;

    const floorY = cur.floorY;
    this.standPosScratch.x = cur.spec.standPos.x;
    this.standPosScratch.y = floorY;
    this.standPosScratch.z = cur.spec.standPos.z;
    this.targetPosScratch.x = cur.spec.targetPos.x;
    this.targetPosScratch.y = floorY;
    this.targetPosScratch.z = cur.spec.targetPos.z;

    const activeClip =
      cur.spec.clip && (cur.phase === 'operate' || cur.phase === 'release')
        ? cur.spec.clip
        : null;
    const hand = buildHandTargetInto(cur.spec, floorY, cur.facingYaw, pulsePhase, this.handTargetScratch);
    this.targetScratch.x = cur.claimedSeat ? cur.claimedSeat.x : cur.spec.standPos.x;
    this.targetScratch.y = cur.claimedSeat ? cur.claimedSeat.y : floorY;
    this.targetScratch.z = cur.claimedSeat ? cur.claimedSeat.z : cur.spec.standPos.z;
    this.targetScratch.yaw = cur.claimedSeat ? cur.claimedSeat.yaw : cur.facingYaw;
    this.targetScratch.handTarget = hand;
    this.targetScratch.seat = cur.claimedSeat;
    this.targetScratch.clip = activeClip;
    this.targetScratch.durationSec = cur.totalDuration;

    const distToStand = cur.lastBodyPos
      ? Math.hypot(cur.spec.standPos.x - cur.lastBodyPos.x, cur.spec.standPos.z - cur.lastBodyPos.z)
      : 0;
    const autoApproaching = cur.phase === 'approach' || cur.phase === 'position';
    const needsWalk = cur.phase === 'approach' && !cur.seatedUsed && distToStand > STAND_ARRIVE_DIST;

    const s = this.snapScratch;
    s.active = true;
    s.actionId = cur.spec.actionId;
    s.label = cur.spec.label;
    s.phase = cur.phase;
    s.gesture = cur.spec.gesture;
    s.clip = activeClip;
    s.progress = progress;
    s.phaseProgress = phaseProgress;
    s.facingYaw = cur.facingYaw;
    s.armWeight = armWeight;
    s.crouchWeight = crouchWeight;
    s.gesturePulse = gesturePulse;
    s.pulsePhase = pulsePhase;
    s.seatedUsed = cur.seatedUsed;
    s.needsWalk = needsWalk;
    s.autoApproaching = autoApproaching;
    return s;
  }

  /**
   * Starts a 7-phase embodied sequence and resolves when the action commits on `release` (or cleanly cancels).
   * Never locks the player: movement, Space, Escape, or `cancel()` aborts immediately and resolves cleanly.
   */
  start(
    spec: EmbodiedActionSpec,
    commitFn: () => Promise<V3Result>,
    opts: EmbodiedStartOptions = {},
  ): Promise<V3Result> {
    if (this.disposed) {
      return Promise.resolve({ ok: false, msg: 'Session ended.' });
    }
    if (this.active) {
      this.cancel('Replaced by a new action.');
    }

    if (opts.immediate) {
      this.playCue(spec);
      return commitFn();
    }

    const body = opts.bodyPos ?? null;
    const resolvedFloorY =
      typeof body?.y === 'number' && Number.isFinite(body.y)
        ? body.y
        : typeof spec.standPos.y === 'number' && Number.isFinite(spec.standPos.y)
          ? spec.standPos.y
          : spec.targetPos.y;
    const refX = spec.standPos.x;
    const refZ = spec.standPos.z;
    const dx = spec.targetPos.x - refX;
    const dz = spec.targetPos.z - refZ;
    const fallbackDx = body ? spec.targetPos.x - body.x : 0;
    const fallbackDz = body ? spec.targetPos.z - body.z : 0;
    const facingYaw =
      typeof spec.preferredFacingYaw === 'number' && Number.isFinite(spec.preferredFacingYaw)
        ? spec.preferredFacingYaw
        : Math.hypot(dx, dz) > 0.05
          ? Math.atan2(dx, dz)
          : Math.hypot(fallbackDx, fallbackDz) > 0.05
            ? Math.atan2(fallbackDx, fallbackDz)
            : (opts.bodyYaw ?? 0);

    let seatedUsed = false;
    let claimedSeat: EmbodiedSeatTarget | null = null;
    if (spec.preferSeat && opts.onSeatRequest) {
      try {
        const seatRes = opts.onSeatRequest({ x: spec.targetPos.x, z: spec.targetPos.z });
        if (seatRes && typeof seatRes === 'object') {
          seatedUsed = true;
          claimedSeat = seatRes;
        } else if (seatRes === true) {
          seatedUsed = true;
        }
      } catch {
        // Optional seat claim failure falls back cleanly to standing posture
      }
    }

    const dStand = body ? Math.hypot(spec.standPos.x - body.x, spec.standPos.z - body.z) : 0;
    const approachDuration = seatedUsed
      ? SEATED_APPROACH_SECONDS
      : Math.max(MIN_APPROACH_SECONDS, Math.min(MAX_APPROACH_SECONDS, dStand / APPROACH_WALK_SPEED));

    const totalDuration =
      approachDuration + POSITION_SECONDS + REACH_SECONDS + spec.operateSeconds + RELEASE_SECONDS + RECOVER_SECONDS;

    return new Promise<V3Result>((resolve) => {
      const seq: ActiveSequence = {
        spec,
        phase: 'approach',
        phaseElapsed: 0,
        totalElapsed: 0,
        totalDuration,
        approachDuration,
        floorY: resolvedFloorY,
        startPos: body ? { x: body.x, z: body.z } : null,
        lastBodyPos: body ? { x: body.x, z: body.z } : null,
        facingYaw,
        seatedUsed,
        claimedSeat,
        committed: false,
        cuePlayed: false,
        commitFn,
        commitPromise: null,
        commitResult: null,
        onOperateStart: opts.onOperateStart,
        onCancel: opts.onCancel,
        resolve,
        safetyTimer: null,
      };
      // Zero-infinite-lock guarantee: if RAF pauses (e.g. backgrounded tab), auto-commit cleanly on wall clock.
      seq.safetyTimer = setTimeout(() => {
        if (this.active !== seq) return;
        this.finishCommitNow(seq);
      }, Math.round((totalDuration + 1.5) * 1000));

      this.active = seq;
      this.bindCancelKeys();
    });
  }

  /** Advances the active 7-phase state machine and updates pooled subtle 3D VFX puffs. */
  update(dt: number, bodyPos?: { x: number; y?: number; z: number } | null): void {
    const cur = this.active;
    if (!cur) {
      if (this.vfxGroup.visible) this.vfxGroup.visible = false;
      return;
    }

    if (bodyPos) {
      if (typeof bodyPos.y === 'number' && Number.isFinite(bodyPos.y)) {
        cur.floorY = bodyPos.y;
      }
      if (cur.lastBodyPos) {
        cur.lastBodyPos.x = bodyPos.x;
        cur.lastBodyPos.z = bodyPos.z;
      } else {
        cur.lastBodyPos = { x: bodyPos.x, z: bodyPos.z };
      }
    }

    // Player walked away during reach/operate -> cleanly interrupt before release so locomotion is never trapped
    // (During automated `approach`/`position` or seat walk-in via `Character.sitAt`, keep `startPos` synced!)
    if (bodyPos && cur.seatedUsed && cur.claimedSeat) {
      if (Math.hypot(bodyPos.x - cur.claimedSeat.x, bodyPos.z - cur.claimedSeat.z) <= 2.4) {
        if (cur.startPos) {
          cur.startPos.x = bodyPos.x;
          cur.startPos.z = bodyPos.z;
        } else {
          cur.startPos = { x: bodyPos.x, z: bodyPos.z };
        }
      }
    }
    if (
      bodyPos &&
      cur.startPos &&
      (!cur.committed || Boolean(cur.spec.commitOnOperateStart)) &&
      !cur.seatedUsed &&
      cur.phase !== 'approach' &&
      Math.hypot(bodyPos.x - cur.startPos.x, bodyPos.z - cur.startPos.z) > MOVE_CANCEL_DIST
    ) {
      this.cancel('Action interrupted by movement.');
      return;
    }

    const stepDt = Math.min(0.1, Math.max(0, dt));
    cur.phaseElapsed += stepDt;
    cur.totalElapsed += stepDt;

    this.updateVfx(cur);

    // Advance out of `approach` early as soon as body reaches `standPos` (<= 0.14 m)
    const arrivedAtStand =
      cur.phase === 'approach' &&
      !cur.seatedUsed &&
      cur.phaseElapsed >= MIN_APPROACH_SECONDS &&
      bodyPos != null &&
      Math.hypot(cur.spec.standPos.x - bodyPos.x, cur.spec.standPos.z - bodyPos.z) <= STAND_ARRIVE_DIST;

    const dur = this.phaseDuration(cur.phase, cur);
    if (!arrivedAtStand && cur.phaseElapsed < dur) return;

    cur.phaseElapsed = 0;
    switch (cur.phase) {
      case 'approach':
        if (bodyPos) {
          if (cur.startPos) {
            cur.startPos.x = bodyPos.x;
            cur.startPos.z = bodyPos.z;
          } else {
            cur.startPos = { x: bodyPos.x, z: bodyPos.z };
          }
        }
        cur.phase = 'position';
        break;
      case 'position':
        if (bodyPos) {
          if (cur.startPos) {
            cur.startPos.x = bodyPos.x;
            cur.startPos.z = bodyPos.z;
          } else {
            cur.startPos = { x: bodyPos.x, z: bodyPos.z };
          }
        }
        cur.phase = 'reach';
        break;
      case 'reach':
        cur.phase = 'operate';
        if (!cur.cuePlayed) {
          cur.cuePlayed = true;
          this.playCue(cur.spec);
        }
        cur.onOperateStart?.(cur.spec);
        if (cur.spec.commitOnOperateStart) {
          this.triggerCommit(cur);
        }
        break;
      case 'operate':
        cur.phase = 'release';
        this.triggerCommit(cur);
        break;
      case 'release':
        cur.phase = 'recover';
        break;
      case 'recover':
      case 'idle':
        this.completeSequence(cur);
        break;
    }
  }

  /** Cleanly cancels any active sequence, clears VFX, unbinds keys, and resolves pending promise without throwing. */
  cancel(reason = 'Action cancelled.'): void {
    const cur = this.active;
    if (!cur) return;
    this.active = null;
    if (cur.safetyTimer) clearTimeout(cur.safetyTimer);
    this.unbindCancelKeys();
    this.hideVfx();
    try {
      cur.onCancel?.(reason, cur.spec);
    } catch {
      // Never let a cancel hook throw or stall cleanup
    }
    cur.resolve(cur.commitResult ?? { ok: false, msg: reason });
  }

  dispose(): void {
    this.disposed = true;
    this.cancel('Session closed.');
    this.vfxGroup.removeFromParent();
    this.vfxGeo.dispose();
    for (const mat of Object.values(this.vfxMats)) mat.dispose();
  }

  private phaseDuration(phase: EmbodiedPhase, seq: ActiveSequence): number {
    switch (phase) {
      case 'approach':
        return seq.approachDuration;
      case 'position':
        return POSITION_SECONDS;
      case 'reach':
        return REACH_SECONDS;
      case 'operate':
        return seq.spec.operateSeconds;
      case 'release':
        return RELEASE_SECONDS;
      case 'recover':
        return RECOVER_SECONDS;
      default:
        return 0;
    }
  }

  private triggerCommit(seq: ActiveSequence): void {
    if (seq.committed) return;
    seq.committed = true;
    seq.commitPromise = seq
      .commitFn()
      .then((res) => {
        seq.commitResult = res;
        return res;
      })
      .catch((err) => {
        const res: V3Result = {
          ok: false,
          msg: err instanceof Error ? err.message : 'Could not complete action.',
        };
        seq.commitResult = res;
        return res;
      });
  }

  private decorateSettledResult(seq: ActiveSequence, res: V3Result): V3Result {
    if (seq.seatedUsed && res.ok && !res.openPanel && !res.settled) {
      return { ...res, settled: true };
    }
    return res;
  }

  private finishCommitNow(seq: ActiveSequence): void {
    if (this.active !== seq) return;
    if (!seq.cuePlayed) {
      seq.cuePlayed = true;
      this.playCue(seq.spec);
    }
    this.active = null;
    if (seq.safetyTimer) clearTimeout(seq.safetyTimer);
    this.unbindCancelKeys();
    this.hideVfx();
    if (seq.commitResult) {
      seq.resolve(this.decorateSettledResult(seq, seq.commitResult));
      return;
    }
    if (!seq.committed) {
      this.triggerCommit(seq);
    }
    if (seq.commitPromise) {
      void seq.commitPromise.then(res => seq.resolve(this.decorateSettledResult(seq, res)));
    } else {
      seq.resolve(this.decorateSettledResult(seq, { ok: true, msg: seq.spec.label }));
    }
  }

  private completeSequence(seq: ActiveSequence): void {
    if (this.active !== seq) return;
    this.active = null;
    if (seq.safetyTimer) clearTimeout(seq.safetyTimer);
    this.unbindCancelKeys();
    this.hideVfx();
    if (seq.commitResult) {
      seq.resolve(this.decorateSettledResult(seq, seq.commitResult));
      return;
    }
    if (!seq.committed) {
      this.triggerCommit(seq);
    }
    if (seq.commitPromise) {
      void seq.commitPromise.then(res => seq.resolve(this.decorateSettledResult(seq, res)));
    } else {
      seq.resolve(this.decorateSettledResult(seq, { ok: true, msg: seq.spec.label }));
    }
  }

  private playCue(spec: EmbodiedActionSpec): void {
    if (!this.audio || !spec.audioCue) return;
    const pos = spec.targetPos;
    switch (spec.audioCue) {
      case 'tap':
        this.audio.triggerUiClick('tap');
        break;
      case 'register':
        this.audio.triggerShopRegister(true, pos);
        break;
      case 'sizzle':
        // Warm skillet/espresso hiss proxy through unified spatial foley bus
        this.audio.triggerActivityFoley('espresso', pos);
        break;
      case 'water_care':
        this.audio.triggerActivityFoley('garden_water', pos);
        break;
      default:
        this.audio.triggerActivityFoley(spec.audioCue, pos);
        break;
    }
  }

  private updateVfx(seq: ActiveSequence): void {
    const kind = seq.spec.vfx;
    if (kind === 'none' || seq.phase !== 'operate') {
      if (this.vfxGroup.visible) this.hideVfx();
      return;
    }
    this.vfxGroup.visible = true;
    const mat = this.vfxMats[kind];
    const base = seq.spec.targetPos;
    const t = seq.phaseElapsed;
    for (let i = 0; i < this.vfxPuffs.length; i++) {
      const puff = this.vfxPuffs[i];
      puff.visible = true;
      if (puff.material !== mat) puff.material = mat;
      const phase = ((t * 1.15 + i * 0.17) % 1);
      const ang = i * 1.047 + t * 1.6;
      const rad = kind === 'notes' ? 0.24 + phase * 0.16 : 0.08 + phase * 0.14;
      const yLift = kind === 'water'
        ? 0.65 + Math.sin(phase * Math.PI) * 0.28
        : 0.85 + phase * 0.55;
      puff.position.set(
        base.x + Math.cos(ang) * rad,
        base.y + yLift,
        base.z + Math.sin(ang) * rad,
      );
      const scale = Math.sin(phase * Math.PI) * (kind === 'warm_glow' ? 1.45 : 1.0);
      puff.scale.setScalar(Math.max(0.05, scale));
    }
  }

  private hideVfx(): void {
    this.vfxGroup.visible = false;
    for (let i = 0; i < this.vfxPuffs.length; i++) {
      this.vfxPuffs[i].visible = false;
    }
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (!this.active) return;
    if (!CANCEL_KEY_CODES.has(e.code)) return;
    if (e.code === 'Escape') {
      e.preventDefault();
    }
    this.cancel(e.code === 'Escape' ? 'Action cancelled.' : 'Moved away from action.');
  };

  private bindCancelKeys(): void {
    if (this.keysBound || typeof window === 'undefined') return;
    this.keysBound = true;
    window.addEventListener('keydown', this.onKeyDown);
  }

  private unbindCancelKeys(): void {
    if (!this.keysBound || typeof window === 'undefined') return;
    this.keysBound = false;
    window.removeEventListener('keydown', this.onKeyDown);
  }
}
