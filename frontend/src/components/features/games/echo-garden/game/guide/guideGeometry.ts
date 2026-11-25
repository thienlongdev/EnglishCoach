/**
 * Echo guide — where the spotlight opening, the arrow and Echo's bubble go (pure math, no DOM).
 *
 * The opening is the target's real on-screen box, padded and clipped to the viewport. The bubble takes the side with
 * room for it (below, above, right, left), always inside the safe area and never over the opening; when the target fills
 * the screen (the whole island) the bubble sits inside it, at the edge farthest from its centre, without an arrow.
 */
export interface Box { x: number; y: number; w: number; h: number }
export interface Insets { top: number; right: number; bottom: number; left: number }
export type Side = "below" | "above" | "right" | "left" | "inside" | "none";

export interface Placement {
  hole: Box | null;
  side: Side;
  bubble: { x: number; y: number };
  /** tip of the arrow (it touches the opening) and its rotation in degrees (0 = pointing up) */
  arrow: { x: number; y: number; rot: number } | null;
}

export const HOLE_PAD = 8;
/** room kept between the opening and the bubble: the arrow lives there */
export const ARROW_GAP = 46;
const MARGIN = 10;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** The target's box, padded, clipped to the viewport; null when nothing of it is on screen. */
export function holeOf(rect: Box | null, vw: number, vh: number, pad = HOLE_PAD): Box | null {
  if (!rect) return null;
  const x0 = Math.max(0, rect.x - pad);
  const y0 = Math.max(0, rect.y - pad);
  const x1 = Math.min(vw, rect.x + rect.w + pad);
  const y1 = Math.min(vh, rect.y + rect.h + pad);
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function place(rect: Box | null, bubble: { w: number; h: number }, vw: number, vh: number,
  insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 }): Placement {
  const safe = { l: insets.left + MARGIN, t: insets.top + MARGIN, r: vw - insets.right - MARGIN, b: vh - insets.bottom - MARGIN };
  const bw = Math.min(bubble.w, safe.r - safe.l);
  const bh = Math.min(bubble.h, safe.b - safe.t);
  const hole = holeOf(rect, vw, vh);
  if (!hole) {
    // no target on screen: Echo speaks from the lower middle of the screen
    return { hole: null, side: "none", bubble: { x: clamp((vw - bw) / 2, safe.l, safe.r - bw), y: clamp(vh * 0.6 - bh / 2, safe.t, safe.b - bh) }, arrow: null };
  }
  const cx = hole.x + hole.w / 2;
  const cy = hole.y + hole.h / 2;
  const room = {
    below: safe.b - (hole.y + hole.h),
    above: hole.y - safe.t,
    right: safe.r - (hole.x + hole.w),
    left: hole.x - safe.l,
  };
  const tipX = clamp(cx, safe.l + 18, safe.r - 18);
  const tipY = clamp(cy, safe.t + 18, safe.b - 18);
  if (room.below >= bh + ARROW_GAP || room.above >= bh + ARROW_GAP) {
    // the roomier of the two when both fit a little; below first when both fit well
    const below = room.below >= bh + ARROW_GAP && (room.above < bh + ARROW_GAP || room.below >= room.above * 0.6);
    return {
      hole,
      side: below ? "below" : "above",
      bubble: { x: clamp(cx - bw / 2, safe.l, safe.r - bw), y: below ? hole.y + hole.h + ARROW_GAP : hole.y - ARROW_GAP - bh },
      arrow: { x: tipX, y: below ? hole.y + hole.h + 4 : hole.y - 4, rot: below ? 0 : 180 },
    };
  }
  if (room.right >= bw + ARROW_GAP || room.left >= bw + ARROW_GAP) {
    const right = room.right >= bw + ARROW_GAP && (room.left < bw + ARROW_GAP || room.right >= room.left);
    return {
      hole,
      side: right ? "right" : "left",
      bubble: { x: right ? hole.x + hole.w + ARROW_GAP : hole.x - ARROW_GAP - bw, y: clamp(cy - bh / 2, safe.t, safe.b - bh) },
      arrow: { x: right ? hole.x + hole.w + 4 : hole.x - 4, y: tipY, rot: right ? 270 : 90 },
    };
  }
  // no side has room for the bubble and its arrow (a target that fills the screen, or a tall one beside a narrow
  // phone screen): Echo speaks from the top or the bottom edge, whichever covers less of the target
  const x = clamp(cx - bw / 2, safe.l, safe.r - bw);
  const covered = (y: number) => Math.max(0, Math.min(y + bh, hole.y + hole.h) - Math.max(y, hole.y)) * Math.max(0, Math.min(x + bw, hole.x + hole.w) - Math.max(x, hole.x));
  const top = covered(safe.t);
  const bottom = covered(safe.b - bh);
  return { hole, side: "inside", bubble: { x, y: bottom <= top ? safe.b - bh : safe.t }, arrow: null };
}

export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
