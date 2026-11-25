import { useRef, useSyncExternalStore } from 'react';
import type { GameHud } from '../world/echoLife/gameHost';
import type { QualityTier } from '../world/echoLife/renderConfig';
import { EchoLifeWorldAudio, type WorldAudioMixer } from '../world/echoLife/worldAudio';

export const ECHO_LIFE_QUALITY_KEY = 'ec_echo_life_quality:v1';

export interface PerfTelemetry {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  textures: number;
  geometries: number;
  qualityTier: QualityTier;
  gpuLabel?: string;
}

const VALID_TIERS = new Set<QualityTier>(['low', 'balanced', 'high', 'ultra']);

export function normalizeQualityTier(raw: unknown, fallback: QualityTier = 'high'): QualityTier {
  if (typeof raw === 'string' && VALID_TIERS.has(raw as QualityTier)) return raw as QualityTier;
  return fallback;
}

export function readSavedQualityTier(fallback: QualityTier = 'high'): QualityTier {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(ECHO_LIFE_QUALITY_KEY);
    return normalizeQualityTier(raw, fallback);
  } catch {
    return fallback;
  }
}

export function writeSavedQualityTier(tier: QualityTier): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ECHO_LIFE_QUALITY_KEY, tier);
  } catch {
    /* storage denied or private browsing */
  }
}

let sharedHudAudio: EchoLifeWorldAudio | null = null;

/** Lazy singleton handle to the browser-native Echo Life Spatial Audio engine for HUD controls. */
export function getWorldAudio(): EchoLifeWorldAudio {
  if (!sharedHudAudio) sharedHudAudio = new EchoLifeWorldAudio();
  return sharedHudAudio;
}

/** Broadcasts mixer updates so any engine-owned audio controller stays synchronized immediately. */
export function broadcastAudioMixer(mixer: WorldAudioMixer): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('echo-life:audio-mixer', { detail: mixer }));
  } catch {
    /* headless fallback */
  }
}

/** Shallow structural equality across all HUD-rendered fields to prevent wasted 5 Hz React re-renders. */
export function hudSnapshotsEqual(a: GameHud | null, b: GameHud | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.host !== b.host ||
    a.ready !== b.ready ||
    a.navReady !== b.navReady ||
    a.time !== b.time ||
    a.weekday !== b.weekday ||
    a.phase !== b.phase ||
    a.weather !== b.weather ||
    a.rain !== b.rain ||
    a.season !== b.season ||
    a.seasonIndex !== b.seasonIndex ||
    a.credits !== b.credits ||
    a.level !== b.level ||
    a.zone !== b.zone ||
    a.ending !== b.ending ||
    a.timeScale !== b.timeScale
  ) {
    return false;
  }

  // Focus prompt
  if (a.focus !== b.focus) {
    if (!a.focus || !b.focus) return false;
    if (
      a.focus.kind !== b.focus.kind ||
      a.focus.label !== b.focus.label ||
      a.focus.name !== b.focus.name ||
      a.focus.role !== b.focus.role
    ) {
      return false;
    }
  }

  // Vehicle telemetry
  if (a.vehicle !== b.vehicle) {
    if (!a.vehicle || !b.vehicle) return false;
    if (
      a.vehicle.name !== b.vehicle.name ||
      a.vehicle.kmh !== b.vehicle.kmh ||
      a.vehicle.gear !== b.vehicle.gear ||
      a.vehicle.kind !== b.vehicle.kind ||
      a.vehicle.headlightsOn !== b.vehicle.headlightsOn ||
      a.vehicle.headlightMode !== b.vehicle.headlightMode ||
      a.vehicle.blinker !== b.vehicle.blinker ||
      a.vehicle.hornActive !== b.vehicle.hornActive ||
      a.vehicle.braking !== b.vehicle.braking
    ) {
      return false;
    }
  }

  // Basketball score & ball state
  if (a.basketball !== b.basketball) {
    if (!a.basketball || !b.basketball) return false;
    if (
      a.basketball.score !== b.basketball.score ||
      a.basketball.streak !== b.basketball.streak ||
      a.basketball.holding !== b.basketball.holding ||
      a.basketball.needsRetrieval !== b.basketball.needsRetrieval ||
      a.basketball.bestStreak !== b.basketball.bestStreak ||
      a.basketball.isThreePointRange !== b.basketball.isThreePointRange ||
      a.basketball.lastShotPoints !== b.basketball.lastShotPoints ||
      a.basketball.lastShotResult !== b.basketball.lastShotResult
    ) {
      return false;
    }
  }

  // Overheard NPC banter / reactive quip
  if (a.overheardBanter !== b.overheardBanter) {
    if (!a.overheardBanter || !b.overheardBanter) return false;
    if (
      a.overheardBanter.speakerId !== b.overheardBanter.speakerId ||
      a.overheardBanter.text !== b.overheardBanter.text
    ) {
      return false;
    }
  }

  // Tutorial step
  if (a.tutorial !== b.tutorial) {
    if (!a.tutorial || !b.tutorial) return false;
    if (a.tutorial.id !== b.tutorial.id || a.tutorial.index !== b.tutorial.index || a.tutorial.total !== b.tutorial.total) {
      return false;
    }
  }

  // Shared badminton court
  if (a.court !== b.court) {
    if (!a.court || !b.court) return false;
    if (
      a.court.phase !== b.court.phase ||
      a.court.joined !== b.court.joined ||
      a.court.ready !== b.court.ready ||
      a.court.turn !== b.court.turn ||
      a.court.action !== b.court.action ||
      a.court.returns !== b.court.returns ||
      a.court.goal !== b.court.goal
    ) {
      return false;
    }
  }

  // Active minigame challenge
  if (a.challenge !== b.challenge) {
    if (!a.challenge || !b.challenge) return false;
    if (a.challenge.type !== b.challenge.type || a.challenge.index !== b.challenge.index || a.challenge.length !== b.challenge.length) {
      return false;
    }
  }

  // Active 7-phase embodied city/home interaction
  if (a.embodied !== b.embodied) {
    if (!a.embodied || !b.embodied) return false;
    if (
      a.embodied.actionId !== b.embodied.actionId ||
      a.embodied.phase !== b.embodied.phase ||
      Math.round(a.embodied.progress * 20) !== Math.round(b.embodied.progress * 20)
    ) {
      return false;
    }
  }

  // Feed toast list (monotonic feed ids)
  if (a.feed.length !== b.feed.length) return false;
  const aLast = a.feed.at(-1);
  const bLast = b.feed.at(-1);
  if (aLast?.id !== bLast?.id || aLast?.text !== bLast?.text) return false;

  // Social scenes count & nearby targets count affect HUD visibility
  if (a.stats.scenes.length !== b.stats.scenes.length) return false;
  if (a.stats.scenes.some((id, idx) => id !== b.stats.scenes[idx])) return false;

  // Check game-level live values that render directly on the HUD (shift, vitals, nearby target count, Wave 11 state)
  const game = b.host.game;
  if (game) {
    const extA = a as GameHud & { _vSig?: string };
    const extB = b as GameHud & { _vSig?: string };
    if (extA._vSig !== extB._vSig) return false;
  }

  return true;
}

function buildDynamicSig(v: GameHud): string {
  const g = v.host.game;
  if (!g) return '';
  const n = g.needsSummary();
  const shift = g.activeShiftTarget();
  const nearbyCount = g.nearbyTargets.length;
  const first = g.nearbyTargets[0];
  const firstNearby = !first ? '' : first.kind === 'npc' ? first.name : first.label;
  const moodletSig = (n.moodlets ?? []).map(m => m.id).join(',');
  const comfortScore = n.comfort?.score ?? 0;
  const banter = g.people.overheardBanter;
  const banterSig = banter ? `${banter.speakerId}:${banter.text}` : '';
  const n8 = v.needs8;
  const needs8Sig = n8
    ? `${Math.round(n8.bathroom)}:${Math.round(n8.fun)}:${Math.round(n8.social)}:${Math.round(n8.sleep)}:${Math.round(n8.recognition)}`
    : '';
  const emoSig = v.emotion ? `${v.emotion.primary}:${Math.round(v.emotion.intensity * 10)}` : '';
  const urgeSig = (v.urges ?? []).map(u => `${u.id}:${u.progress}/${u.goalCount}:${u.completed ? 1 : 0}`).join(',');
  const karmaSig = v.karma ? `${Math.round(v.karma.personal)}:${Math.round(v.karma.city)}` : '';
  const careerSig = v.fullTimeCareer
    ? `${v.fullTimeCareer.activeCareerId ?? ''}:${v.fullTimeCareer.rank}:${v.fullTimeCareer.promotionProgress}`
    : '';
  const phoneSig = v.phone
    ? `${v.phone.seq}:${v.phone.feed.length}:${v.phone.ledger.length}:${v.phone.photos.length}:${v.phone.meetups.length}:${v.phone.cityConfig.pedestrianDensity}:${v.phone.cityConfig.trafficDensity}:${v.phone.cityConfig.billboardTheme}:${v.phone.cityConfig.billboardHeadline}`
    : '';
  return `${n.energy}|${n.hunger}|${n.hygiene < 35 ? n.hygiene : 99}|${n.mood}|${n.focus}|${n.state}|${comfortScore}|${moodletSig}|${shift?.job ?? ''}:${shift?.step ?? 0}|${nearbyCount}:${firstNearby}|${banterSig}|${v.host.building ?? ''}:${v.host.buildMessage}|${v.timeScale ?? 1}|${needs8Sig}|${emoSig}|${urgeSig}|${karmaSig}|${careerSig}|${phoneSig}`;
}

/** The game's HUD snapshot as a tiny external store: structural guard skips redundant 5 Hz React renders. */
export function createHudStore() {
  let value: (GameHud & { _vSig?: string }) | null = null;
  const subs = new Set<() => void>();
  return {
    get: (): GameHud | null => value,
    set: (next: GameHud | null) => {
      if (next) {
        const tagged: GameHud & { _vSig?: string } = { ...next, _vSig: buildDynamicSig(next) };
        if (hudSnapshotsEqual(value, tagged)) return;
        value = tagged;
      } else {
        if (value === null) return;
        value = null;
      }
      subs.forEach(f => f());
    },
    subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
  };
}
export type HudStore = ReturnType<typeof createHudStore>;

/** Fast shallow key-by-key equality for flat HUD selector slice objects. */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  const recA = a as Record<string, unknown>;
  const recB = b as Record<string, unknown>;
  for (let i = 0; i < keysA.length; i++) {
    const k = keysA[i];
    if (!Object.prototype.hasOwnProperty.call(recB, k) || !Object.is(recA[k], recB[k])) {
      return false;
    }
  }
  return true;
}

/**
 * Sliced external-store subscription hook for Echo Life HUD leaf islands.
 *
 * Returns a referentially stable slice whenever `isEqual(prevSlice, nextSlice)` holds so high-frequency
 * telemetry updates (e.g. 5 Hz vehicle `kmh`, embodied progress, clock ticks) reconcile ONLY the subscribed
 * leaf component and trigger 0 reconciliations on sibling HUD islands or the HUD root shell.
 */
export function useHudSelector<T>(
  store: HudStore,
  selector: (hud: GameHud | null) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const selectorRef = useRef(selector);
  const isEqualRef = useRef(isEqual);
  selectorRef.current = selector;
  isEqualRef.current = isEqual;

  const cacheRef = useRef<{ has: boolean; raw: GameHud | null; slice: T }>({
    has: false,
    raw: null,
    slice: undefined as unknown as T,
  });

  const getSnapshot = (): T => {
    const raw = store.get();
    const c = cacheRef.current;
    if (c.has && c.raw === raw) return c.slice;
    const next = selectorRef.current(raw);
    if (c.has && isEqualRef.current(c.slice, next)) {
      c.raw = raw;
      return c.slice;
    }
    c.has = true;
    c.raw = raw;
    c.slice = next;
    return next;
  };

  const getServerSnapshot = (): T => selectorRef.current(null);

  return useSyncExternalStore(store.subscribe, getSnapshot, getServerSnapshot);
}
