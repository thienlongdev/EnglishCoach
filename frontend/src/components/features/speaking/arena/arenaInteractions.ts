import type { ArenaBoatRole, ArenaPlayer } from '@/types/speakingArena';
import type { ArenaWaterMode } from './arenaContracts';
import type { ArenaBoatFleet } from './arenaBoats';
import { arenaIslandNames, arenaStations } from './arenaCopy';
import type { FishingPromptHint } from './arenaFishing';
import type { FruitPromptAction } from './arenaFruitTrees';
import type { DockClimbTarget } from './arenaSwimming';
import {
  ARENA_BOARD_HULL_GAP,
  arenaBeachFactor,
  arenaBoatClear,
  arenaBoatWedged,
  arenaCanBoardBoat,
  arenaDisembarkPoint,
  arenaHullGap,
  arenaInReach,
  arenaLayout,
  arenaNearestDock,
  arenaOnWood,
  arenaSeats,
  arenaShoreRadius,
} from './arenaTerrain';

/** Sentinel seat ID used when sitting directly on dry sand, grass, or plaza ground via `KeyC`. */
export const GROUND_SEAT_ID = '__ground__';

/** Total duration (ms) the underwater control guide pill stays mounted per dive (`5.0 s`). */
export const UNDERWATER_GUIDE_VISIBLE_MS = 5000;
/** Smooth GPU-composited fade-out window (ms) at the tail of the underwater guide (`4,400..5,000 ms`). */
export const UNDERWATER_GUIDE_FADE_MS = 600;
/** Total duration (ms) the surface swim control guide pill stays mounted (`6.0 s`). */
export const SURFACE_SWIM_GUIDE_VISIBLE_MS = 6000;
/** Smooth GPU-composited fade-out window (ms) at the tail of the surface swim guide (`5,400..6,000 ms`). */
export const SURFACE_SWIM_GUIDE_FADE_MS = 600;

export interface SwimGuideState {
  showUnderwaterHint: boolean;
  underwaterFading: boolean;
  showSurfaceHint: boolean;
  surfaceFading: boolean;
  elapsedUnderwaterMs: number;
}

/**
 * Pure, zero-GC stateful timer governing the 5.0-second underwater reef guide (`4,400..5,000 ms` fade)
 * and 6.0-second surface swim guide (`5,400..6,000 ms` fade).
 * - Entering `'underwater_dive'` starts/resets the 5,000 ms underwater timer (`0..4,400 ms` solid,
 *   `4,400..5,000 ms` fading, `>= 5,000 ms` hidden & unmounted).
 * - Leaving `'underwater_dive'` (resurfacing or stepping onto land/boat) resets the underwater timer
 *   so diving again later cleanly displays the 5-second guide again.
 * - Continuous `'surface_swim'` auto-hides after `6,000 ms` (`5,400..6,000 ms` fade) and resets when
 *   returning to `'land'`, `'wading'`, or `'boat'`.
 * - `revealNow()` re-arms both guides on demand (e.g., when opening/closing Help `?`).
 */
export class ArenaSwimGuideTimer {
  private currentMode: ArenaWaterMode = 'land';
  private elapsedUnderwaterMs = 0;
  private elapsedSurfaceMs = 0;
  private readonly state: SwimGuideState = {
    showUnderwaterHint: true,
    underwaterFading: false,
    showSurfaceHint: true,
    surfaceFading: false,
    elapsedUnderwaterMs: 0,
  };

  step(swimMode: ArenaWaterMode, dtMs: number): Readonly<SwimGuideState> {
    const safeDtMs = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
    const prevMode = this.currentMode;
    this.currentMode = swimMode;

    if (swimMode === 'underwater_dive') {
      if (prevMode !== 'underwater_dive') {
        this.elapsedUnderwaterMs = 0;
      }
      this.elapsedUnderwaterMs += safeDtMs;
    } else {
      this.elapsedUnderwaterMs = 0;
      if (swimMode === 'surface_swim') {
        if (prevMode !== 'surface_swim' && prevMode !== 'underwater_dive') {
          this.elapsedSurfaceMs = 0;
        }
        this.elapsedSurfaceMs += safeDtMs;
      } else {
        this.elapsedSurfaceMs = 0;
      }
    }

    return this.syncState();
  }

  stepSeconds(swimMode: ArenaWaterMode, dtSec: number): Readonly<SwimGuideState> {
    const safeDtMs = Number.isFinite(dtSec) && dtSec > 0 ? dtSec * 1000 : 0;
    return this.step(swimMode, safeDtMs);
  }

  revealNow(): Readonly<SwimGuideState> {
    this.elapsedUnderwaterMs = 0;
    this.elapsedSurfaceMs = 0;
    return this.syncState();
  }

  reset(): Readonly<SwimGuideState> {
    this.currentMode = 'land';
    this.elapsedUnderwaterMs = 0;
    this.elapsedSurfaceMs = 0;
    return this.syncState();
  }

  getState(): Readonly<SwimGuideState> {
    return this.state;
  }

  private syncState(): Readonly<SwimGuideState> {
    const uwFadeStart = UNDERWATER_GUIDE_VISIBLE_MS - UNDERWATER_GUIDE_FADE_MS;
    const surfFadeStart = SURFACE_SWIM_GUIDE_VISIBLE_MS - SURFACE_SWIM_GUIDE_FADE_MS;

    const showUnderwater = this.elapsedUnderwaterMs < UNDERWATER_GUIDE_VISIBLE_MS;
    const uwFading =
      this.currentMode === 'underwater_dive' &&
      showUnderwater &&
      this.elapsedUnderwaterMs >= uwFadeStart;

    const showSurface = this.elapsedSurfaceMs < SURFACE_SWIM_GUIDE_VISIBLE_MS;
    const surfFading =
      this.currentMode === 'surface_swim' &&
      showSurface &&
      this.elapsedSurfaceMs >= surfFadeStart;

    this.state.showUnderwaterHint = showUnderwater;
    this.state.underwaterFading = uwFading;
    this.state.showSurfaceHint = showSurface;
    this.state.surfaceFading = surfFading;
    this.state.elapsedUnderwaterMs = this.elapsedUnderwaterMs;
    return this.state;
  }
}

export type ContextualActionKind =
  | 'board'
  | 'disembark'
  | 'jump-overboard'
  | 'boat-free'
  | 'boating-hint'
  | 'climb-dock'
  | 'swim-hint'
  | 'fishing-equip'
  | 'fishing-action'
  | 'shake-tree'
  | 'collect-fruit'
  | 'sit'
  | 'stand'
  | 'kiosk'
  | 'beacon'
  | 'telescope'
  | 'artifact'
  | 'place';

export function findNearestFreeSeat(
  px: number,
  py: number,
  pz: number,
  lookYaw: number,
  players: readonly ArenaPlayer[],
  occupiedSeats?: ReadonlySet<string>,
  maxRange = 2.2,
): (typeof arenaSeats)[number] | null {
  const fwdX = Math.sin(lookYaw);
  const fwdZ = Math.cos(lookYaw);
  let bestSeat: (typeof arenaSeats)[number] | null = null;
  let bestScore = -Infinity;
  for (const s of arenaSeats) {
    const dist = Math.hypot(px - s.x, pz - s.z);
    if (dist > maxRange || Math.abs(s.y - py) > 1.1) continue;
    if (!arenaInReach(px, pz, s.x, s.z)) continue;
    if (occupiedSeats?.has(s.id) || players.some(other => other.seat === s.id)) continue;
    const dx = s.x - px;
    const dz = s.z - pz;
    const d = Math.max(0.001, Math.hypot(dx, dz));
    const facingDot = (dx / d) * fwdX + (dz / d) * fwdZ;
    const score = (1 - dist / maxRange) * 1.4 + Math.max(-0.2, facingDot) * 0.65;
    if (score > bestScore) {
      bestScore = score;
      bestSeat = s;
    }
  }
  return bestSeat;
}

export interface ContextualAction {
  key: string;
  kind: ContextualActionKind;
  id: string;
  role?: ArenaBoatRole;
  canTrigger: boolean;
  fading?: boolean;
  keyHint?: string;
  labelVi: string;
  labelEn: string;
  x: number;
  z: number;
}

export function selectContextualAction(params: {
  px: number;
  py: number;
  pz: number;
  lookYaw: number;
  grounded: boolean;
  swimMode?: ArenaWaterMode;
  waterDepth?: number;
  dockClimb?: DockClimbTarget | null;
  fishingHint?: FishingPromptHint | null;
  fruitAction?: FruitPromptAction | null;
  seat: string | null;
  boatId: string | null;
  hasRoom: boolean;
  players: readonly ArenaPlayer[];
  occupiedSeats?: ReadonlySet<string>;
  fleet: ArenaBoatFleet;
  litBeacons: ReadonlySet<string>;
  showBoatControlsHint: boolean;
  showUnderwaterControlsHint?: boolean;
  underwaterHintFading?: boolean;
  showSwimControlsHint?: boolean;
  swimHintFading?: boolean;
  holding?: string | null;
  placeTable?: string | null;
  rests?: ReadonlyMap<string, { x: number; z: number }>;
}): ContextualAction | null {
  const {
    px,
    py,
    pz,
    lookYaw,
    grounded,
    swimMode = 'land',
    waterDepth = 0,
    dockClimb,
    fishingHint,
    fruitAction,
    seat,
    boatId,
    hasRoom,
    players,
    occupiedSeats,
    fleet,
    litBeacons,
    showBoatControlsHint,
    showUnderwaterControlsHint = true,
    underwaterHintFading = false,
    showSwimControlsHint = true,
    swimHintFading = false,
    holding,
    placeTable,
    rests,
  } = params;

  // 1. Active fishing line / rod takes precedence while angling
  if (fishingHint && fishingHint.keyHint !== 'F') {
    return {
      key: `fishing-action:${fishingHint.labelEn}`,
      kind: 'fishing-action',
      id: 'fishing',
      canTrigger: fishingHint.canTrigger,
      keyHint: fishingHint.keyHint,
      labelVi: fishingHint.labelVi,
      labelEn: fishingHint.labelEn,
      x: px,
      z: pz,
    };
  }

  // 2. Hands full with a table artefact
  if (holding && !boatId && !seat) {
    return placeTable
      ? {
          key: `place:${placeTable}`,
          kind: 'place',
          id: placeTable,
          canTrigger: true,
          keyHint: 'E',
          labelVi: 'Đặt lên bàn',
          labelEn: 'Set it on the table',
          x: px,
          z: pz,
        }
      : {
          key: 'place-hint',
          kind: 'boating-hint',
          id: holding,
          canTrigger: false,
          labelVi: 'Đang cầm đồ · mang tới cạnh một chiếc bàn để đặt xuống',
          labelEn: 'Holding it · carry it to a table to set it down',
          x: px,
          z: pz,
        };
  }

  // 3. Aboard a vessel
  if (boatId) {
    const boat = fleet.boats.get(boatId);
    if (!boat) return null;
    const land = arenaDisembarkPoint(boat.x, boat.z, boat.yaw, boat.footprint);
    if (land && (!boat.motor || boat.speed < 1.1)) {
      const onPier = arenaOnWood(land.x, land.z);
      return {
        key: `disembark:${boatId}:${onPier ? 'pier' : 'beach'}`,
        kind: 'disembark',
        id: boatId,
        canTrigger: true,
        keyHint: 'E',
        labelVi: onPier ? 'Bước lên cầu tàu' : 'Bước lên bờ biển',
        labelEn: onPier ? 'Step onto the pier' : 'Step ashore onto the beach',
        x: land.x,
        z: land.z,
      };
    }
    if (
      boat.stuckFor > 1.2 &&
      arenaBoatWedged(
        boat.x,
        boat.z,
        boat.yaw,
        (x, z, yaw) => arenaBoatClear(x, z, yaw, boat.footprint) && fleet.clearOfBoats(boat, x, z, yaw),
      )
    ) {
      return {
        key: `boat-free:${boatId}`,
        kind: 'boat-free',
        id: boatId,
        canTrigger: true,
        keyHint: 'E',
        labelVi: 'Đẩy thuyền ra chỗ nước thoáng',
        labelEn: 'Push the boat into clear water',
        x: boat.x,
        z: boat.z,
      };
    }
    const dock = arenaNearestDock(boat.x, boat.z);
    if (dock && dock.distance < 13) {
      return {
        key: `dock-hint:${dock.id}`,
        kind: 'boating-hint',
        id: boatId,
        canTrigger: false,
        labelVi: 'Áp mạn thuyền sát cầu tàu để lên bờ · Space nhảy xuống nước',
        labelEn: 'Bring the boat alongside the pier to step ashore · Space jumps into water',
        x: dock.x,
        z: dock.z,
      };
    }
    const shore = arenaLayout.islands.find(i => {
      const a = Math.atan2(boat.z - i.z, boat.x - i.x);
      return (
        arenaHullGap(
          boat.x,
          boat.z,
          boat.yaw,
          i.x + Math.cos(a) * arenaShoreRadius(i, a),
          i.z + Math.sin(a) * arenaShoreRadius(i, a),
          boat.footprint,
        ) < 5.5
      );
    });
    if (shore) {
      const shoreBearing = Math.atan2(boat.z - shore.z, boat.x - shore.x);
      const isSandy = arenaBeachFactor(shore, shoreBearing) > 0.25;
      if (isSandy) {
        return {
          key: `shore-beach-hint:${shore.id}`,
          kind: 'boating-hint',
          id: boatId,
          canTrigger: false,
          labelVi: 'Tiến sát bãi cát để lên bờ · hoặc nhấn Space nhảy xuống nước nông',
          labelEn: 'Glide closer to the beach to step ashore · or press Space to jump into the shallows',
          x: shore.x + Math.cos(shoreBearing) * arenaShoreRadius(shore, shoreBearing),
          z: shore.z + Math.sin(shoreBearing) * arenaShoreRadius(shore, shoreBearing),
        };
      }
      const place = dock ? arenaIslandNames[dock.island] : undefined;
      return {
        key: `shore-hint:${shore.id}:${dock?.id ?? 'sea'}`,
        kind: 'boating-hint',
        id: boatId,
        canTrigger: false,
        labelVi: place
          ? `Bờ đá dốc · nhấn Space nhảy xuống biển hoặc ghé cầu tàu ${place.vi}`
          : 'Bờ đá dốc · nhấn Space nhảy xuống biển hoặc tìm bãi cát gần đó',
        labelEn: place
          ? `Steep rocky shore · press Space to jump into the sea or try ${place.en} pier`
          : 'Steep rocky shore · press Space to jump into the sea or find a nearby beach',
        x: dock?.x ?? boat.x,
        z: dock?.z ?? boat.z,
      };
    }
    if (showBoatControlsHint) {
      return {
        key: `hint:${boatId}`,
        kind: 'boating-hint',
        id: boatId,
        canTrigger: false,
        labelVi: boat.motor
          ? 'R bật hoặc tắt máy · W/S ga và lùi · A/D lái · Space nhảy xuống nước'
          : 'W/S chèo · A/D lái · Space nhảy xuống nước · Cập cầu tàu hoặc bãi cát để lên bờ',
        labelEn: boat.motor
          ? 'R engine · W/S throttle and reverse · A/D steer · Space jumps into water'
          : 'W/S row · A/D steer · Space jumps into water · Land at a pier or beach',
        x: boat.x,
        z: boat.z,
      };
    }
    return null;
  }

  // 4. Seated on bench or amphitheatre tier
  if (seat) {
    return {
      key: `stand:${seat}`,
      kind: 'stand',
      id: seat,
      canTrigger: true,
      keyHint: 'E',
      labelVi: 'Đứng dậy',
      labelEn: 'Stand up',
      x: px,
      z: pz,
    };
  }

  // 5. Swimming or Underwater Diving
  if (swimMode === 'surface_swim' || swimMode === 'underwater_dive') {
    if (dockClimb && swimMode === 'surface_swim') {
      return {
        key: `climb-dock:${dockClimb.dockId}`,
        kind: 'climb-dock',
        id: dockClimb.dockId,
        canTrigger: true,
        keyHint: 'E',
        labelVi: 'Leo lên cầu tàu',
        labelEn: 'Climb onto pier',
        x: dockClimb.x,
        z: dockClimb.z,
      };
    }

    // Swimmer alongside an available moored or drifting boat can climb aboard across full hull length!
    if (swimMode === 'surface_swim') {
      let bestSwimBoat: { gap: number; action: ContextualAction } | null = null;
      for (const boat of fleet.boats.values()) {
        if (!arenaCanBoardBoat(boat.x, boat.z, boat.yaw, px, pz, boat.footprint, ARENA_BOARD_HULL_GAP)) continue;
        const role: ArenaBoatRole | null = !boat.rower ? 'ROWER' : hasRoom && !boat.passenger ? 'PASSENGER' : null;
        if (!role) continue;
        const gap = arenaHullGap(boat.x, boat.z, boat.yaw, px, pz, boat.footprint);
        if (bestSwimBoat && gap >= bestSwimBoat.gap) continue;
        bestSwimBoat = {
          gap,
          action: {
            key: `board-swim:${boat.id}:${role}`,
            kind: 'board',
            id: boat.id,
            role,
            canTrigger: true,
            keyHint: 'E',
            labelVi: boat.motor ? 'Trèo lên ca nô' : 'Trèo lên thuyền',
            labelEn: boat.motor ? 'Climb aboard launch' : 'Climb aboard boat',
            x: boat.x,
            z: boat.z,
          },
        };
      }
      if (bestSwimBoat) return bestSwimBoat.action;
    }

    if (swimMode === 'underwater_dive') {
      if (showUnderwaterControlsHint === false) return null;
      return {
        key: underwaterHintFading ? 'swim-hint:dive:fading' : 'swim-hint:dive',
        kind: 'swim-hint',
        id: 'dive',
        canTrigger: false,
        ...(underwaterHintFading ? { fading: true } : {}),
        labelVi: 'Space để bơi nổi lên mặt nước · W/S bơi lặn ngắm rạn san hô',
        labelEn: 'Space to ascend to surface · W/S to explore the reef',
        x: px,
        z: pz,
      };
    }

    if (waterDepth > 2.2 && showSwimControlsHint !== false) {
      return {
        key: swimHintFading ? 'swim-hint:surface:fading' : 'swim-hint:surface',
        kind: 'swim-hint',
        id: 'surface',
        canTrigger: false,
        ...(swimHintFading ? { fading: true } : {}),
        labelVi: 'Nhấn C để lặn xuống rạn san hô · Shift để bơi sải nhanh',
        labelEn: 'Press C to dive beneath the waves · Shift for freestyle sprint',
        x: px,
        z: pz,
      };
    }
    return null;
  }

  if (!grounded && swimMode === 'land') return null;

  // Dock climb-out while wading right beside a pier
  if (dockClimb && swimMode === 'wading') {
    return {
      key: `climb-dock:${dockClimb.dockId}`,
      kind: 'climb-dock',
      id: dockClimb.dockId,
      canTrigger: true,
      keyHint: 'E',
      labelVi: 'Bước lên cầu tàu',
      labelEn: 'Step onto pier',
      x: dockClimb.x,
      z: dockClimb.z,
    };
  }

  const fwdX = Math.sin(lookYaw);
  const fwdZ = Math.cos(lookYaw);
  let best: { score: number; action: ContextualAction } | null = null;

  const consider = (
    dist: number,
    range: number,
    tx: number,
    tz: number,
    priorityBoost: number,
    action: ContextualAction,
    skipReachCheck = false,
  ) => {
    if (dist > range || (!skipReachCheck && !arenaInReach(px, pz, tx, tz))) return;
    const dx = tx - px;
    const dz = tz - pz;
    const d = Math.max(0.001, Math.hypot(dx, dz));
    const dot = d < 0.55 ? 1 : (dx / d) * fwdX + (dz / d) * fwdZ;
    if (dot < -0.35 && dist > 1.35) return;
    const score = (1 - dist / range) * 1.4 + Math.max(0, dot) * 0.85 + priorityBoost;
    if (!best || score > best.score) best = { score, action };
  };

  // 6. Playable Vessels moored or beached nearby (Skiff, Sampan, Pelagic, Tern, Cruiser)
  for (const boat of fleet.boats.values()) {
    if (!arenaCanBoardBoat(boat.x, boat.z, boat.yaw, px, pz, boat.footprint, ARENA_BOARD_HULL_GAP)) continue;
    const gap = Math.max(0, arenaHullGap(boat.x, boat.z, boat.yaw, px, pz, boat.footprint));
    const role: ArenaBoatRole | null = !boat.rower ? 'ROWER' : hasRoom && !boat.passenger ? 'PASSENGER' : null;
    if (!role) continue;

    let labelVi: string;
    let labelEn: string;
    if (boat.kind === 'cruiser') {
      labelVi = role === 'ROWER' ? 'Cầm lái tàu du lịch · R bật máy' : 'Lên tàu du lịch · Hành khách';
      labelEn = role === 'ROWER' ? 'Take cruiser helm · R starts engine' : 'Board cruiser · Passenger';
    } else if (boat.motor) {
      labelVi = role === 'ROWER' ? 'Cầm lái ca nô · R bật máy' : 'Lên ca nô · Hành khách';
      labelEn = role === 'ROWER' ? 'Take launch helm · R starts engine' : 'Board launch · Passenger';
    } else if (boat.kind === 'sampan') {
      labelVi = role === 'ROWER' ? 'Lên thuyền tam bản · Cầm chèo' : 'Đi cùng thuyền tam bản';
      labelEn = role === 'ROWER' ? 'Board bamboo sampan · Rower' : 'Join bamboo sampan · Passenger';
    } else {
      labelVi = role === 'ROWER' ? 'Lên thuyền gỗ · Cầm mái chèo' : 'Lên thuyền gỗ · Ngồi mũi thuyền';
      labelEn = role === 'ROWER' ? 'Board wooden skiff · Rower' : 'Join wooden skiff · Passenger';
    }

    consider(
      gap,
      ARENA_BOARD_HULL_GAP,
      boat.x,
      boat.z,
      0.35,
      {
        key: `board:${boat.id}:${role}`,
        kind: 'board',
        id: boat.id,
        role,
        canTrigger: true,
        keyHint: 'E',
        labelVi,
        labelEn,
        x: boat.x,
        z: boat.z,
      },
      true,
    );
  }

  // 7. World Interactables (15 Speaking Kiosks, Beacons, Telescopes, Table Artefacts)
  for (const spec of arenaLayout.interactables) {
    const at = rests?.get(spec.id);
    const inter = at ? { ...spec, x: at.x, z: at.z } : spec;
    const dist = Math.hypot(px - inter.x, pz - inter.z);
    if (dist > inter.range) continue;
    if (inter.kind === 'kiosk') {
      const stationMeta = arenaStations[inter.id];
      consider(dist, inter.range, inter.x, inter.z, 0.3, {
        key: `kiosk:${inter.id}`,
        kind: 'kiosk',
        id: inter.id,
        canTrigger: true,
        keyHint: 'E',
        labelVi: stationMeta ? `Trạm luyện nói · ${stationMeta.titleVi}` : 'Mở trạm luyện nói tiếng Anh',
        labelEn: stationMeta ? `Speaking station · ${stationMeta.titleEn}` : 'Open speaking station',
        x: inter.x,
        z: inter.z,
      });
    } else if (inter.kind === 'beacon') {
      const lit = litBeacons.has(inter.id);
      consider(dist, inter.range, inter.x, inter.z, 0.18, {
        key: `beacon:${inter.id}:${lit ? '1' : '0'}`,
        kind: 'beacon',
        id: inter.id,
        canTrigger: true,
        keyHint: 'E',
        labelVi: lit ? 'Dịu đèn hiệu cảng' : 'Thắp sáng đèn hiệu cảng',
        labelEn: lit ? 'Dim harbor beacon' : 'Light harbor beacon',
        x: inter.x,
        z: inter.z,
      });
    } else if (inter.kind === 'telescope') {
      consider(dist, inter.range, inter.x, inter.z, 0.28, {
        key: `telescope:${inter.id}`,
        kind: 'telescope',
        id: inter.id,
        canTrigger: true,
        keyHint: 'E',
        labelVi: 'Ngắm cảnh qua kính viễn vọng',
        labelEn: 'Look through brass spyglass',
        x: inter.x,
        z: inter.z,
      });
    } else if (inter.kind === 'artifact' && !players.some(other => other.artifact === inter.id)) {
      consider(dist, inter.range, inter.x, inter.z, 0.16, {
        key: `artifact:${inter.id}`,
        kind: 'artifact',
        id: inter.id,
        canTrigger: true,
        keyHint: 'E',
        labelVi: 'Khám phá vật phẩm trên bàn',
        labelEn: 'Inspect table artefact',
        x: inter.x,
        z: inter.z,
      });
    }
  }

  // 8. Tropical Fruit Trees & Dropped Fruits (`coconut`, `mango`, `banana`, `papaya`)
  if (fruitAction) {
    const dist = Math.hypot(px - fruitAction.x, pz - fruitAction.z);
    consider(
      dist,
      3.25,
      fruitAction.x,
      fruitAction.z,
      fruitAction.kind === 'collect_fruit' ? 0.34 : 0.22,
      {
        key: `${fruitAction.kind}:${fruitAction.targetId}`,
        kind: fruitAction.kind === 'collect_fruit' ? 'collect-fruit' : 'shake-tree',
        id: fruitAction.targetId,
        canTrigger: true,
        keyHint: 'E',
        labelVi: fruitAction.labelVi,
        labelEn: fruitAction.labelEn,
        x: fruitAction.x,
        z: fruitAction.z,
      },
      true,
    );
  }

  // 9. Pier Fishing Spot Prompt (`KeyF`)
  if (fishingHint && fishingHint.keyHint === 'F') {
    consider(
      0.5,
      3.5,
      px,
      pz,
      0.2,
      {
        key: 'fishing-equip:spot',
        kind: 'fishing-equip',
        id: 'fishing-spot',
        canTrigger: true,
        keyHint: 'F',
        labelVi: fishingHint.labelVi,
        labelEn: fishingHint.labelEn,
        x: px,
        z: pz,
      },
      true,
    );
  }

  // 10. Benches and Amphitheatre Tiers (`2.15 m` reach, `0.24` facing boost so `bench-se` / `bench-sw` win cleanly when facing the bench)
  for (const s of arenaSeats) {
    const dist = Math.hypot(px - s.x, pz - s.z);
    if (dist > 2.15 || Math.abs(s.y - py) > 1.1) continue;
    if (occupiedSeats?.has(s.id) || players.some(other => other.seat === s.id)) continue;
    const dx = s.x - px;
    const dz = s.z - pz;
    const d = Math.max(0.001, Math.hypot(dx, dz));
    const facingDot = (dx / d) * fwdX + (dz / d) * fwdZ;
    const priorityBoost = facingDot > 0.30 ? 0.24 : 0.12;
    consider(dist, 2.15, s.x, s.z, priorityBoost, {
      key: `sit:${s.id}`,
      kind: 'sit',
      id: s.id,
      canTrigger: true,
      keyHint: 'E',
      labelVi: 'Ngồi xuống ghế',
      labelEn: 'Sit down',
      x: s.x,
      z: s.z,
    });
  }

  return best ? (best as { score: number; action: ContextualAction }).action : null;
}
