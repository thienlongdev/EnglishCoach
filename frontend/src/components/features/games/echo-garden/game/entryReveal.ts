/**
 * Echo Garden — the cloud reveal of a game entry (pure state, no rendering).
 *
 * One reveal belongs to one entry into the game: the view that hosts it is mounted once per entry (Games Hub → Echo
 * Garden, or a direct visit) and stays mounted through every panel, visit to another island, refresh of the state and
 * change of tab focus, so none of those can replay it. The clouds are the loading picture while the REAL island is
 * prepared beneath them; they part only when that island is drawn, never on a timer, and never hide a failure.
 *
 *   off      the effect is switched off (the player's choice, or reduced motion): the island simply appears
 *   covered  clouds cover the island while it loads
 *   opening  the island is drawn: the clouds part (about 1.3 s; a tap or "Bỏ qua" ends it at once)
 *   done     no clouds for the rest of this entry
 */
export type RevealPhase = "off" | "covered" | "opening" | "done";

/**
 * ready = the first frame of the real island is drawn and the tab is visible; skip = the player tapped; opened = the
 * parting finished; failed = the garden or its scene could not be loaded (the error must be seen); hidden = the tab
 * went to the background while the clouds were parting (nothing plays behind the player's back).
 */
export type RevealEvent = "ready" | "skip" | "opened" | "failed" | "hidden";

export const REVEAL_MS = 1300;
export const REVEAL_SKIP_MS = 180;
/** After this long under the clouds the caption says honestly that loading is slow. */
export const REVEAL_SLOW_MS = 6000;
/** After this long the clouds give way to the scene's own loading picture with its progress bar: they never wait for ever. */
export const REVEAL_GIVE_UP_MS = 20000;

const PREF_KEY = "echo-garden:entry-reveal";

export function revealInitial(opts: { enabled: boolean; reducedMotion: boolean }): RevealPhase {
  return opts.enabled && !opts.reducedMotion ? "covered" : "off";
}

export function revealNext(phase: RevealPhase, event: RevealEvent): RevealPhase {
  if (phase === "off" || phase === "done") return phase;
  if (event === "failed") return "done";
  if (phase === "covered") return event === "ready" ? "opening" : "covered";
  // opening
  return event === "opened" || event === "skip" || event === "hidden" ? "done" : "opening";
}

/** True while the clouds are on screen: the scene's own dark loading veil is not shown beneath them. */
export function revealCovers(phase: RevealPhase): boolean {
  return phase === "covered" || phase === "opening";
}

/** The island is the player's to touch: no clouds in the way (the guide's invitation waits for this). */
export function revealFinished(phase: RevealPhase): boolean {
  return phase === "off" || phase === "done";
}

/** A device preference (like the sound switch): "Hiệu ứng mở đảo" on unless the player turned it off here. */
export function readRevealPref(): boolean {
  try {
    return typeof window === "undefined" || window.localStorage.getItem(PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeRevealPref(on: boolean) {
  try {
    window.localStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {
    /* storage unavailable: the choice lasts for this visit only */
  }
}
