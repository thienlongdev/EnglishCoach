/**
 * Echo Memory Pulse — the one timeline of a study card (owner brief 2026-11-12). Every visible step of a card (turning,
 * ratings appearing, a stored rating's effect, the card leaving, the next one arriving) is a phase of this machine, and
 * every delay is scheduled by ONE `Timeline` owned by FlashcardUI (cancelled on unmount, deck switch and account switch).
 * Pure module: no React, no request.
 *
 *   front ──FLIP──▶ flipping-back ──FLIP_DONE──▶ back ──FLIP──▶ flipping-front ──FLIP_DONE──▶ front
 *   back ──RATE──▶ pending ──FAIL──▶ back
 *                  pending ──CONFIRM──▶ effect ──EXIT──▶ exit ──SWAP──▶ enter ──ENTERED──▶ front
 *   any ──RESET──▶ front
 *
 * Ratings are interactive only in `back` (the back face has finished turning); keys and clicks in any other phase are
 * dropped, so a rating can never be sent twice or bypass a pending one.
 */

export type StudyPhase = "front" | "flipping-back" | "back" | "flipping-front" | "pending" | "effect" | "exit" | "enter";
export type StudyEvent = "FLIP" | "FLIP_DONE" | "RATE" | "FAIL" | "CONFIRM" | "EXIT" | "SWAP" | "ENTERED" | "RESET";

/** ms. `flip` = the CSS turn of `.card` (600 ms); the rest is the post-confirmation sequence (800 ms to ready). */
export const TIMELINE = {
  flip: 600,
  /** the rating's effect leads (ink / wave / pearl leaves the button); the card's tide motion follows */
  exitAt: 200,
  /** the tide motion of the rated card: Khó sinks below the waterline, Tốt drifts away, Dễ condenses into a pearl */
  exit: 340,
  /** the next card surfaces from the same waterline */
  enter: 260,
  /** how long an effect layer lives (it is outside the card, so the card swap never cuts it) */
  fxLife: 1250,
  /** reduced motion: a still confirmation, the card changes at once */
  reducedFx: 420,
} as const;

const TABLE: Record<StudyPhase, Partial<Record<StudyEvent, StudyPhase>>> = {
  front: { FLIP: "flipping-back" },
  "flipping-back": { FLIP_DONE: "back" },
  back: { FLIP: "flipping-front", RATE: "pending" },
  "flipping-front": { FLIP_DONE: "front" },
  pending: { FAIL: "back", CONFIRM: "effect" },
  effect: { EXIT: "exit", SWAP: "enter" },
  exit: { SWAP: "enter" },
  enter: { ENTERED: "front", FLIP: "flipping-back" },
};

/** The next phase, or null when the event does not apply now (the caller then does nothing). */
export function step(phase: StudyPhase, event: StudyEvent): StudyPhase | null {
  if (event === "RESET") return "front";
  return TABLE[phase][event] ?? null;
}

export const canRate = (p: StudyPhase) => p === "back";
/** The ratings are shown (not necessarily interactive) once the back has finished turning, until the card has left. */
export const ratingsShown = (p: StudyPhase) => p === "back" || p === "pending" || p === "effect" || p === "exit";

/** One owner for every delay of the study card: cancelling it stops the whole sequence at once. */
export class Timeline {
  private timers = new Set<ReturnType<typeof setTimeout>>();
  schedule(ms: number, fn: () => void) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, Math.max(0, ms));
    this.timers.add(t);
  }
  cancel() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
  }
  get size() { return this.timers.size; }
}

export interface FxPoint { x: number; y: number }
export interface FxGeometry {
  /** centre of the pressed rating button */
  origin: FxPoint;
  /** the card, in the same frame */
  card: { x: number; y: number; w: number; h: number };
  /** where Dễ's pearl travels: the progress indicator when visible, else the card's top edge */
  target: FxPoint;
  /** where Khó's trace meets the card's edge (straight below the button) */
  edge: FxPoint;
}

type Box = { left: number; top: number; width: number; height: number };

/**
 * Positions relative to the effect layer's own box (computed from live rects at confirmation): correct whatever the
 * window size, scroll position, panel width or layout (desktop / phone) is at that moment.
 */
export function fxGeometry(layer: Box, button: Box, card: Box, target?: Box | null): FxGeometry {
  const rel = (x: number, y: number) => ({ x: Math.round(x - layer.left), y: Math.round(y - layer.top) });
  const origin = rel(button.left + button.width / 2, button.top + button.height / 2);
  const c = { ...rel(card.left, card.top), w: Math.round(card.width), h: Math.round(card.height) };
  const usable = target && target.width > 0 && target.top < card.top + card.height;
  const t = usable ? rel(target!.left + target!.width * 0.5, target!.top + target!.height / 2) : { x: c.x + c.w / 2, y: c.y };
  return { origin, card: c, target: t, edge: { x: origin.x, y: c.y + c.h } };
}
