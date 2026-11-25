/**
 * Echo Cinematic Journey (owner brief 2026-10-31, 10 §BK): one coordinator for the trip between the three places of the ocean:
 * Landing, the sign-in sea and the Workspace. No React and no three.js here: this module is in the main bundle.
 *
 * The whale that leaves is the whale that arrives: it swims out of the source's own scene (`Stage.depart`), its momentum, height, size and
 * tail phase travel in `EchoCarry`, and the destination's own scene brings it in on the opposite edge (`Stage.arrive`). Between the two it is off
 * screen, so no two renderers ever have to agree on the same pixels. The Workspace has no scene: the bridge carries Echo itself to the companion.
 */
export type JourneyScene = 'landing' | 'auth' | 'workspace';
export type JourneyPhase = 'idle' | 'departing' | 'covered' | 'revealing';

/** What of Echo crosses the passage: where it leaves, how fast, how large, and where the tail is in its beat. */
export interface EchoCarry {
  /** +1 swims out to the right and in from the left; -1 the other way (back toward the Landing). */
  dir: 1 | -1;
  /** Height on the screen, 0..1. */
  y: number;
  /** Apparent body length in CSS px. */
  size: number;
  /** Speed across the edge, CSS px / s. */
  speed: number;
  /** The swim clip's time, s. */
  tail: number;
}

/** A scene that holds Echo. Landing and sign-in register theirs from their own engines. */
export interface JourneyStage {
  /** Echo swims off the given edge; resolves when it is off screen (or at once if there is no whale to send). */
  depart(plan: { dir: 1 | -1; y: number; size: number; ms: number }): Promise<EchoCarry | null>;
  /** Echo comes in on the opposite edge, carrying on from `carry`. */
  arrive(carry: EchoCarry): void;
  /** Keep Echo out of sight until `arrive` (called before the first frame of a scene entered by a journey). */
  awaitArrival(): void;
  /** The scene has drawn. */
  isLive(): boolean;
}

export interface JourneyRequest {
  to: string;
  from: JourneyScene;
  dest: JourneyScene;
  dir: 1 | -1;
  /** The route was already changed by the browser (Back / Forward) or the page was reloaded into it: nothing to leave. */
  arrivalOnly: boolean;
  replace: boolean;
  /** The browser is about to leave for another site (Google sign-in): cover, and do not navigate. */
  external: boolean;
  /** Sign-out: the window covers first, the session is ended behind it, and only then does the route change. */
  signOut?: { covered: () => void; done: Promise<void> };
}

const RANK: Record<JourneyScene, number> = { landing: 0, auth: 1, workspace: 2 };
const AUTH_ROUTES = ['/login', '/register', '/forgot-password', '/reset-password', '/verify-email'];

/** Which place of the ocean a URL belongs to. */
export function sceneOf(path: string, tab: string | null): JourneyScene {
  if (path === '/' && (!tab || tab === 'landing')) return 'landing';
  if (AUTH_ROUTES.some((route) => path === route || path.startsWith(`${route}/`))) return 'auth';
  return 'workspace';
}

export function sceneOfUrl(url: string): JourneyScene {
  const parsed = new URL(url, 'https://ec.local');
  return sceneOf(parsed.pathname, parsed.searchParams.get('tab'));
}

/** Toward the Workspace Echo swims right; back toward the Landing it swims left. Never derived from history: a Back to a deeper place still goes the right way. */
export const directionOf = (from: JourneyScene, dest: JourneyScene): 1 | -1 => (RANK[dest] >= RANK[from] ? 1 : -1);

/** Where Echo crosses the edge: the height of the sea it arrives in, so the whale that leaves at this height arrives at this height. */
export function crossingOf(vw: number, vh: number) {
  const portrait = vw / Math.max(1, vh) < 0.95 || vw < 900;
  return { y: portrait ? 0.34 : 0.7, size: Math.round(Math.min(300, Math.max(130, vw * 0.19))) };
}

// ── State ────────────────────────────────────────────────────────────────────
let phase: JourneyPhase = 'idle';
let holdGuest = false;
let holdAccount = false;
let heapDirty = false;
let warmer: (() => void) | null = null;
let pendingDest: JourneyScene | null = null;
let carried: EchoCarry | null = null;
let starter: ((request: Omit<JourneyRequest, 'from' | 'dest' | 'dir'>) => boolean) | null = null;
let canceller: (() => void) | null = null;
const stages = new Map<JourneyScene, JourneyStage>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export const journeyPhase = () => phase;
export const journeyActive = () => phase !== 'idle';
export const subscribeJourney = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function setJourneyPhase(next: JourneyPhase) {
  if (next === phase) return;
  phase = next;
  if (typeof document !== 'undefined') {
    if (next === 'idle') delete document.documentElement.dataset.journey;
    else document.documentElement.dataset.journey = next;
  }
  emit();
}

/**
 * A sign-in that succeeded changes the session while Echo is still swimming out. Everything under the account key would remount and tear the sea
 * down, so that remount waits until the passage covers the page. Only ever the guest's own sign-in page: another account's view is never held.
 */
export const journeyHoldsGuest = () => holdGuest;
export function setJourneyHoldsGuest(value: boolean) {
  if (holdGuest === value) return;
  holdGuest = value;
  emit();
}

/**
 * Sign-out stops every request at the press, but the page stays drawn until the current covers it, so nothing on the page falls apart behind the opening. It holds the
 * account's own view for the signed-in account itself, for the second or so the opening takes, and never after the window is covered.
 */
export const journeyHoldsAccount = () => holdAccount;
export function setJourneyHoldsAccount(value: boolean) {
  if (holdAccount === value) return;
  holdAccount = value;
  emit();
}

/**
 * This page has held a signed-in account and signed out without a page load. Its module memory is not trusted for the next account or for a protected page: entering the
 * Workspace from here is always a real page load. The Landing and the sign-in pages hold no account data, so the sea may stay continuous between them.
 */
export const journeyHeapDirty = () => heapDirty;
export const markJourneyHeapDirty = () => {
  heapDirty = true;
};

/** Intent to sign out (the account menu opened, the pointer on the button): the passage's chunk and the model load before the press. */
export const registerJourneyWarm = (warm: () => void) => {
  warmer = warm;
  return () => {
    if (warmer === warm) warmer = null;
  };
};
export const journeyWarmSignOut = () => warmer?.();

export function registerJourneyStage(scene: JourneyScene, stage: JourneyStage) {
  stages.set(scene, stage);
  // A scene that mounts while a journey is on its way in keeps Echo out of sight: it enters only through `arrive`. One that mounts after the opening began enters at once.
  if (pendingDest === scene) {
    stage.awaitArrival();
    if (phase === 'revealing' && carried) stage.arrive(carried);
  }
  emit();
  return () => {
    if (stages.get(scene) === stage) stages.delete(scene);
    emit();
  };
}
export const journeyStage = (scene: JourneyScene) => stages.get(scene) ?? null;

export const setJourneyPendingDest = (scene: JourneyScene | null) => {
  pendingDest = scene;
};
/** Asked by a scene before it places Echo for the first time. */
export const journeyArrivingAt = (scene: JourneyScene) => pendingDest === scene;

export const setJourneyCarry = (carry: EchoCarry | null) => {
  carried = carry;
};
export const journeyCarry = () => carried;

export const registerJourneyStarter = (start: typeof starter) => {
  starter = start;
  return () => {
    if (starter === start) starter = null;
  };
};

export const registerJourneyCancel = (cancel: () => void) => {
  canceller = cancel;
  return () => {
    if (canceller === cancel) canceller = null;
  };
};
/** The thing the journey was for did not happen (a redirect failed): the page comes back. */
export const cancelJourney = () => canceller?.();

/**
 * Go to `to` through the passage. False when nothing was started (the host is not there, or a journey is already on its way: a second press is not a
 * second navigation): the caller navigates the plain way only if `journeyActive()` is false.
 */
export function journeyGo(to: string, options: { replace?: boolean } = {}) {
  if (!starter || journeyActive()) return false;
  return starter({ to, arrivalOnly: false, replace: !!options.replace, external: false });
}

/** Leaving for another site (Google sign-in): Echo swims out and the current covers the page; the arrival is restored from a token when the browser comes back. */
export function journeyLeaveForExternal(to: string) {
  if (!starter || journeyActive()) return false;
  writeJourneyToken('oauth');
  return starter({ to, arrivalOnly: false, replace: false, external: true });
}

/**
 * Sign-out through the passage: Echo swims out at the press and the window covers. `covered` says the page may go, `finish` says the session work is over.
 * Null when no passage can start: the caller signs out the plain way.
 */
export function journeySignOut(to: string) {
  if (!starter || journeyActive()) return null;
  let covered!: () => void;
  let finish!: () => void;
  const coveredPromise = new Promise<void>((resolve) => {
    covered = resolve;
  });
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  holdAccount = true;
  if (!starter({ to, arrivalOnly: false, replace: true, external: false, signOut: { covered, done } })) {
    holdAccount = false;
    return null;
  }
  return { covered: coveredPromise, finish };
}

// ── Crossing a full page load (Google sign-in, sign-out, a page reloaded after sign-out) ─────────────────────
const TOKEN_KEY = 'ec_journey';
export type JourneyTokenKind = 'oauth' | 'signout' | 'fresh';
/** Only what the arrival needs: where it came from. Never a credential, an address, a token or a URL with parameters. */
export function writeJourneyToken(kind: JourneyTokenKind) {
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ kind, at: Date.now() }));
  } catch {
    // no storage: the next page simply opens on its own first frame
  }
}
export function takeJourneyToken(): JourneyTokenKind | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { kind?: JourneyTokenKind; at?: number };
    const age = Date.now() - Number(parsed.at);
    if (parsed.kind === 'oauth' && age < 600_000) return 'oauth';
    if ((parsed.kind === 'signout' || parsed.kind === 'fresh') && age < 30_000) return parsed.kind;
    return null;
  } catch {
    return null;
  }
}
