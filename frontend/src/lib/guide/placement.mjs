// Echo Guide: where things go (10 §BL). Pure geometry, no DOM, so the rules can be run in a test: the card never leaves the window, never covers
// the thing it explains unless nothing else fits, and Echo never sits on the target.

const MARGIN = 12;
const GAP = 16;

const clamp = (value, low, high) => (high < low ? low : Math.min(high, Math.max(low, value)));

export function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The card beside the hole. `prefer` is tried first, then the side with the most room. Phones (narrow windows) always use the top or bottom edge.
 * hole: {x, y, w, h} | null  card: {w, h}  view: {w, h, top?, left?} (top / left: what the page's own chrome already uses)
 */
export function placeCard(hole, card, view, prefer = 'auto') {
  const low = view.h - card.h - MARGIN;
  const high = view.w - card.w - MARGIN;
  if (!hole) return { x: clamp((view.w - card.w) / 2, MARGIN, high), y: clamp((view.h - card.h) / 2, MARGIN, low), side: 'center' };

  const room = {
    top: hole.y - GAP - MARGIN,
    bottom: view.h - (hole.y + hole.h) - GAP - MARGIN,
    left: hole.x - GAP - MARGIN,
    right: view.w - (hole.x + hole.w) - GAP - MARGIN,
  };
  const fits = (side) => (side === 'top' || side === 'bottom' ? room[side] >= card.h : room[side] >= card.w);
  const narrow = view.w < 640;
  const sides = narrow ? ['bottom', 'top'] : ['bottom', 'right', 'left', 'top'];
  const order = prefer !== 'auto' && !narrow ? [prefer, ...sides.filter((side) => side !== prefer)] : sides;
  const side = order.find(fits) ?? (narrow ? (room.bottom >= room.top ? 'bottom' : 'top') : Object.entries(room).sort((a, b) => b[1] - a[1])[0][0]);

  const midX = hole.x + hole.w / 2 - card.w / 2;
  const midY = hole.y + hole.h / 2 - card.h / 2;
  let x;
  let y;
  if (side === 'top') { x = midX; y = hole.y - GAP - card.h; }
  else if (side === 'bottom') { x = midX; y = hole.y + hole.h + GAP; }
  else if (side === 'left') { x = hole.x - GAP - card.w; y = midY; }
  else { x = hole.x + hole.w + GAP; y = midY; }
  return { x: clamp(x, MARGIN, high), y: clamp(y, MARGIN, low), side };
}

/**
 * Echo beside the card, on the corner nearest the target, half out of the card so it reads as one object with it. Falls back around the card; a position on
 * the target is the last resort and is reported, so a test can catch it.
 */
export function placeEcho(cardBox, hole, size, view) {
  const corners = [
    // Never over the card's own controls: it leans on a corner from outside.
    { x: cardBox.x - size * 0.72, y: cardBox.y - size * 0.56 },
    { x: cardBox.x + cardBox.w - size * 0.24, y: cardBox.y - size * 0.56 },
    { x: cardBox.x - size * 0.72, y: cardBox.y + cardBox.h - size * 0.44 },
    { x: cardBox.x + cardBox.w - size * 0.24, y: cardBox.y + cardBox.h - size * 0.44 },
  ];
  const focus = hole ? { x: hole.x + hole.w / 2, y: hole.y + hole.h / 2 } : { x: view.w / 2, y: view.h / 2 };
  const scored = corners
    .map((corner) => {
      const x = clamp(corner.x, 4, view.w - size - 4);
      const y = clamp(corner.y, 4, view.h - size - 4);
      const box = { x, y, w: size, h: size };
      const onTarget = hole ? overlapArea(box, hole) : 0;
      const distance = Math.hypot(x + size / 2 - focus.x, y + size / 2 - focus.y);
      return { x, y, onTarget, score: onTarget * 1000 + distance };
    })
    .sort((a, b) => a.score - b.score);
  const best = scored[0];
  return { x: best.x, y: best.y, onTarget: best.onTarget > 0, facesLeft: focus.x < best.x + size / 2 };
}

/** The hole around a target: padded, inside the window, and with the corners of the target itself. */
export function holeOf(rect, pad, radius, view) {
  const x = Math.max(2, rect.left - pad);
  const y = Math.max(2, rect.top - pad);
  const right = Math.min(view.w - 2, rect.right + pad);
  const bottom = Math.min(view.h - 2, rect.bottom + pad);
  const w = Math.max(8, right - x);
  const h = Math.max(8, bottom - y);
  return { x, y, w, h, r: Math.min(radius + pad * 0.8, w / 2, h / 2) };
}

/** A rounded rectangle whose straight edges bow with their own speed: this is what makes the hole read as liquid between two targets. */
export function liquidPath(l, t, r, b, radius, bow = { top: 0, right: 0, bottom: 0, left: 0 }) {
  const w = Math.max(0, r - l);
  const h = Math.max(0, b - t);
  const c = Math.min(radius, w / 2, h / 2);
  const k = c * 0.5523;
  const f = (n) => n.toFixed(1);
  const midX = (l + r) / 2;
  const midY = (t + b) / 2;
  return (
    `M${f(l + c)} ${f(t)}` +
    `Q${f(midX)} ${f(t + bow.top * 2)} ${f(r - c)} ${f(t)}` +
    `C${f(r - c + k)} ${f(t)} ${f(r)} ${f(t + c - k)} ${f(r)} ${f(t + c)}` +
    `Q${f(r + bow.right * 2)} ${f(midY)} ${f(r)} ${f(b - c)}` +
    `C${f(r)} ${f(b - c + k)} ${f(r - c + k)} ${f(b)} ${f(r - c)} ${f(b)}` +
    `Q${f(midX)} ${f(b + bow.bottom * 2)} ${f(l + c)} ${f(b)}` +
    `C${f(l + c - k)} ${f(b)} ${f(l)} ${f(b - c + k)} ${f(l)} ${f(b - c)}` +
    `Q${f(l + bow.left * 2)} ${f(midY)} ${f(l)} ${f(t + c)}` +
    `C${f(l)} ${f(t + c - k)} ${f(l + c - k)} ${f(t)} ${f(l + c)} ${f(t)}Z`
  );
}
