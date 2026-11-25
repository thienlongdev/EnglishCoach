import type { RecallQuality } from "../RecallControls";

/**
 * Pure mathematics for the Echo Memory Theater study pass and timeline (2026-11-20 reforge).
 *
 * Separates two distinct learner concepts:
 *   1. Session pass progress (cards in THIS study batch, locked in stable order so async due refetches
 *      on large decks never inflate 50 -> 56 or drop waiting cards when tied dates reshuffle).
 *   2. Total deck mastery (server-reported masteredCount / deckTotalWords, displayed in MasteryHalo).
 */

export const TIMELINE_MAX_NODES = 40;
export const TIMELINE_VIEW_W = 1000;
export const TIMELINE_VIEW_H = 40;

/** Smooth parametric wave for the Memory Current strand (y in [0, 40] for t in [0, 1]). */
export function waveY(t: number): number {
  return 20 - 9.5 * Math.sin(Math.PI * 2 * 1.25 * t + 0.6);
}

/** Precomputed SVG path string for the full horizontal strand (0..1000). */
export const STRAND_PATH: string = (() => {
  const pts: string[] = [];
  const steps = 120;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push(`${(t * TIMELINE_VIEW_W).toFixed(1)} ${waveY(t).toFixed(2)}`);
  }
  return "M" + pts.join(" L");
})();

export interface TimelineNode {
  slot: number;
  startIndex: number;
  endIndex: number;
  /** Exact horizontal fraction [0, 1] along the strand. */
  t: number;
  /** Exact vertical fraction [0, 1] matching waveY(t) / TIMELINE_VIEW_H. */
  yPct: number;
  state: "done" | "active" | "ahead";
  mark: RecallQuality | null;
}

export interface TimelineLayout {
  count: number;
  done: number;
  shown: number;
  /** Exact horizontal fraction [0, 1] of the lit strand termination — always equals the active node's t (or 1 when all done). */
  activeT: number;
  activeSlot: number;
  nodes: TimelineNode[];
}

/**
 * Computes mathematically synchronized node positions and exact lit-strand termination.
 * Guarantees:
 *   - For any done < count, there is ALWAYS exactly one `active` node.
 *   - `activeT` equals the exact `t` of that active node (0px disconnect at any viewport width).
 *   - `activeT` is monotonically non-decreasing as `done` increases.
 *   - When `count === 1`, the single node is centered (`t = 0.5`), lit strand is 0 until done, then 1.
 */
export function buildTimelineLayout(
  total: number,
  doneRaw: number,
  marks: ReadonlyArray<RecallQuality | null>,
  maxNodes = TIMELINE_MAX_NODES,
): TimelineLayout {
  const count = Math.max(1, Math.floor(total));
  const done = Math.max(0, Math.min(Math.floor(doneRaw), count));
  const cap = Math.max(2, Math.floor(maxNodes));
  const shown = Math.min(count, cap);

  if (shown === 1) {
    const finished = done >= 1;
    return {
      count,
      done,
      shown: 1,
      activeT: finished ? 1 : 0,
      activeSlot: finished ? -1 : 0,
      nodes: [
        {
          slot: 0,
          startIndex: 0,
          endIndex: 0,
          t: 0.5,
          yPct: (waveY(0.5) / TIMELINE_VIEW_H) * 100,
          state: finished ? "done" : "active",
          mark: finished ? marks[0] ?? null : null,
        },
      ],
    };
  }

  const allDone = done >= count;
  const activeSlot = allDone
    ? shown
    : shown === count
      ? done
      : Math.min(shown - 1, Math.floor((done * shown) / count));

  const nodes: TimelineNode[] = [];
  for (let i = 0; i < shown; i++) {
    const startIndex = shown === count ? i : Math.floor((i * count) / shown);
    const endIndex = shown === count ? i : Math.max(startIndex, Math.floor(((i + 1) * count) / shown) - 1);
    const t = i / (shown - 1);
    const yPct = (waveY(t) / TIMELINE_VIEW_H) * 100;
    const state: TimelineNode["state"] =
      i < activeSlot ? "done" : i === activeSlot ? "active" : "ahead";

    let mark: RecallQuality | null = null;
    if (state === "done") {
      // Pick the latest recorded rating within this slot's card range
      for (let idx = Math.min(endIndex, done - 1); idx >= startIndex; idx--) {
        const m = marks[idx];
        if (m) {
          mark = m;
          break;
        }
      }
    }
    nodes.push({ slot: i, startIndex, endIndex, t, yPct, state, mark });
  }

  const activeT = allDone ? 1 : nodes[activeSlot].t;
  return { count, done, shown, activeT, activeSlot: allDone ? -1 : activeSlot, nodes };
}

export interface PassCardLike {
  id: number;
  nextReviewDate?: string | null;
  status?: string;
}

/**
 * Merges an incoming server `GET /flashcards/due` page into the active study pass without destabilizing it.
 *
 * Why this exists:
 *   - The server queries `ORDER BY next_review_date ASC NULLS FIRST` with `size=50` and no id tie-breaker.
 *   - On a 1,320-word deck, rating card #1 causes `mutateDue()` to pull a 51st card (and/or reshuffle tied rows),
 *     which previously inflated `passTotal` (50 -> 51 -> 52 -> 56) and evicted still-waiting pass cards.
 *
 * Rules:
 *   - Before a pass has started (`passOrder.size === 0`), accept the full incoming batch as the pass snapshot.
 *   - Once a pass is underway (`passOrder.size > 0`):
 *     - Refresh any card already belonging to this pass with its latest server fields.
 *     - Keep waiting pass cards that were temporarily omitted by an unordered server `LIMIT 50` window.
 *     - Do NOT append unrelated extra cards (#51+) into the already-locked pass batch.
 */
export function mergeDueBatchForPass<T extends PassCardLike>(
  currentCards: readonly T[],
  incomingCards: readonly T[],
  passOrder: ReadonlyMap<number, number>,
): T[] {
  if (passOrder.size === 0 || currentCards.length === 0) {
    return [...incomingCards];
  }
  const byId = new Map<number, T>();
  for (const card of incomingCards) {
    byId.set(card.id, card);
  }
  return currentCards.map((existing) => byId.get(existing.id) ?? existing);
}

/**
 * Computes rock-solid session counts that never dip (`50 -> 49 -> 50`) during the 540ms exit animation
 * when a rated card is still held on screen (`heldCard`) before `passReviewedIds` appends it.
 */
export function computePassCounts(
  passReviewedIds: readonly number[],
  pendingQueueLength: number,
  heldCardId: number | null,
  pendingQueueHasHeld: boolean,
  isManualOverride: boolean,
): { passTotal: number; position: number; done: number } {
  const heldUncommitted =
    !isManualOverride &&
    heldCardId !== null &&
    !pendingQueueHasHeld &&
    !passReviewedIds.includes(heldCardId)
      ? 1
      : 0;
  const passTotal = Math.max(1, passReviewedIds.length + pendingQueueLength + heldUncommitted);
  const done = Math.min(passReviewedIds.length, passTotal);
  const position = Math.min(done + 1, passTotal);
  return { passTotal, position, done };
}
