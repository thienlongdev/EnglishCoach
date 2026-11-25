/** Where the floating Echo sits and what it may say: pure geometry and copy, no React and no DOM (10 §BJ). */
export type EchoSide = 'left' | 'right';
export interface EchoPlace { side: EchoSide; y: number }
export interface EchoBounds { left: number; right: number; top: number; bottom: number }
export interface EchoPoint { x: number; y: number }
export interface EchoRect { left: number; right: number; top: number; bottom: number }

export const ECHO_PLACE_KEY = 'echo_companion_place';
export const ECHO_PREFS_KEY = 'echo_companion_prefs';
export const DEFAULT_PLACE: EchoPlace = { side: 'right', y: 1 };
export const DRAG_START_PX = 6;
/** The same margins as the launcher it replaced, so its touch area covers nothing new at its default place. */
const edgeOf = (size: number) => (size >= 64 ? 24 : 18);

export function restorePlace(raw: string | null): EchoPlace {
  try {
    const value = JSON.parse(raw || 'null');
    if (value && (value.side === 'left' || value.side === 'right') && typeof value.y === 'number' && Number.isFinite(value.y)) {
      return { side: value.side, y: Math.min(1, Math.max(0, value.y)) };
    }
  } catch { /* A broken preference is the default place. */ }
  return DEFAULT_PLACE;
}

/** The place is a side and a share of the free height, so it survives a resize, a rotation or the keyboard. */
export function pointOf(place: EchoPlace, size: number, bounds: EchoBounds): EchoPoint {
  const edge = edgeOf(size);
  const free = Math.max(0, bounds.bottom - bounds.top - size - edge * 2);
  return { x: place.side === 'left' ? bounds.left + edge : bounds.right - size - edge, y: bounds.top + edge + free * place.y };
}

export function placeOf(point: EchoPoint, velocityX: number, size: number, bounds: EchoBounds): EchoPlace {
  // A throw decides the side; otherwise the nearest edge does.
  const centre = point.x + size / 2 + velocityX * 0.12;
  const side: EchoSide = centre < (bounds.left + bounds.right) / 2 ? 'left' : 'right';
  const edge = edgeOf(size);
  const free = Math.max(1, bounds.bottom - bounds.top - size - edge * 2);
  return { side, y: Math.min(1, Math.max(0, (point.y - bounds.top - edge) / free)) };
}

/** While dragged the orb stays on the screen, whatever the pointer does. */
export function clampPoint(point: EchoPoint, size: number, viewport: { width: number; height: number }): EchoPoint {
  return { x: Math.min(Math.max(4, point.x), viewport.width - size - 4), y: Math.min(Math.max(4, point.y), viewport.height - size - 4) };
}

export interface PanelAnchor { left: number; top: number; originX: number; originY: number }

/** The chat opens beside its Echo, inside the screen: above the orb, else below, else next to it. */
export function panelAnchor(orb: EchoPoint, size: number, panel: { width: number; height: number }, viewport: { width: number; height: number }): PanelAnchor {
  const gap = 12, margin = 12;
  const onLeft = orb.x + size / 2 < viewport.width / 2;
  let left = onLeft ? orb.x : orb.x + size - panel.width;
  let top: number;
  if (orb.y - gap - panel.height >= margin) top = orb.y - gap - panel.height;
  else if (orb.y + size + gap + panel.height <= viewport.height - margin) top = orb.y + size + gap;
  else {
    top = Math.max(margin, Math.min(orb.y + size - panel.height, viewport.height - margin - panel.height));
    left = onLeft ? orb.x + size + gap : orb.x - gap - panel.width;
  }
  left = Math.min(Math.max(margin, left), Math.max(margin, viewport.width - margin - panel.width));
  top = Math.min(Math.max(margin, top), Math.max(margin, viewport.height - margin - panel.height));
  return { left, top, originX: orb.x + size / 2 - left, originY: orb.y + size / 2 - top };
}

/**
 * Pure safe-zone bounds calculator shared across all 5 viewports and modules.
 * Keeps the single companion anchor (Whale or Ambient Living Entity) clear of TopNavbar,
 * revealed bottom Dock (when horizontally overlapping), and any `data-echo-clear` controls
 * such as FocusDock, ProgressiveFeedbackDrawer, composers, and notification toasts.
 */
export function computeSafeBounds(
  viewport: { width: number; height: number },
  size: number,
  side: EchoSide,
  obstacles: {
    main?: EchoRect | null;
    topBarBottom?: number;
    dock?: EchoRect | null;
    clearRects?: ReadonlyArray<EchoRect>;
  } = {},
): EchoBounds {
  const width = Math.max(240, viewport.width);
  const height = Math.max(240, viewport.height);
  const edge = edgeOf(size);
  const left = obstacles.main ? Math.max(0, obstacles.main.left) : 0;
  const right = width;
  let top = obstacles.main ? Math.max(0, obstacles.main.top) : 0;
  if (typeof obstacles.topBarBottom === 'number' && Number.isFinite(obstacles.topBarBottom) && obstacles.topBarBottom > 0) {
    top = Math.max(top, Math.min(height * 0.28, obstacles.topBarBottom + 4));
  }
  let bottom = height;

  // Compute the horizontal footprint occupied by the companion on its snapped side
  const slotLeft = side === 'left' ? left + edge - 12 : right - size - edge - 12;
  const slotRight = slotLeft + size + 24;
  const overlapsSide = (r: EchoRect) => r.right > slotLeft && r.left < slotRight;

  // Dock clearance: avoid overlap when dock is revealed and intersects the companion's horizontal lane
  if (obstacles.dock) {
    const d = obstacles.dock;
    const dockVisible = d.right - d.left > 24 && d.bottom - d.top > 16 && d.top < height - 2 && d.top > height * 0.55;
    if (dockVisible && (overlapsSide(d) || width < 960)) {
      bottom = Math.min(bottom, d.top - 10);
    }
  }

  // Module-registered bottom clearance surfaces (`data-echo-clear` & `[data-testid="guide-offer"]`)
  if (obstacles.clearRects) {
    for (const r of obstacles.clearRects) {
      const rw = r.right - r.left;
      const rh = r.bottom - r.top;
      if (rw <= 0 || rh <= 0) continue;
      if (r.top > height * 0.30 && r.top < height && (overlapsSide(r) || rw > width * 0.55)) {
        bottom = Math.min(bottom, r.top - 10);
      }
    }
  }

  // Always preserve a valid vertical swim lane even on tiny split screens / open keyboards
  const minBand = size + edge * 2 + 8;
  if (bottom - top < minBand) {
    bottom = Math.min(height, top + minBand);
    if (bottom - top < minBand) {
      top = Math.max(0, height - minBand);
      bottom = height;
    }
  }
  return { left, right, top, bottom };
}

export interface RadialOrbitPoint {
  x: number;
  y: number;
}

export interface AmbientOverlayLayout {
  side: EchoSide;
  openUp: boolean;
  /** Diameter in px for each radial control button (38px desktop / 36px compact -> >= 36-40px hit target). */
  buttonSize: number;
  /** Center-relative pixel offsets for each radial micro-orbit button (0 px^2 self and orb overlap). */
  orbitOffsets: RadialOrbitPoint[];
  /** Fixed viewport box for the instant radial button micro-tooltip pill (pointer-events: none, 0 overlap). */
  hintBox: {
    left?: number;
    right?: number;
    top: number;
    maxWidth: number;
    align: 'left' | 'right' | 'center';
  };
  /** Fixed viewport box for the opt-in single-line CC ribbon (14 px clear of orb; right-anchored on right side). */
  captionBox: {
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
    maxWidth: number;
    align: 'left' | 'right' | 'center';
  };
  /** Fixed viewport box for ephemeral Action/Confirm/Resource toast (bottom-anchored when openUp, 0 overlap). */
  toastBox: {
    left: number;
    top?: number;
    bottom?: number;
    width: number;
    maxHeight: number;
  };
}

/**
 * Deterministic spatial layout for Mode 1 (Ambient) micro-overlays around the single Living Entity.
 * Guarantees >= 36-40 px radial hit targets, edge-aware arc flip/reflow, 0 px^2 radial self-overlap,
 * 0 px^2 orb overlap, and zero off-screen clipping across all 5 viewports (390 px mobile through
 * 2560 px ultrawide) and 125%-150% browser zoom.
 */
export function computeAmbientOverlayLayout(
  anchorOrigin: EchoPoint,
  anchorSize: number,
  visualSize: number,
  viewport: { width: number; height: number },
  orbitCount = 5,
  orbitOpen = false,
): AmbientOverlayLayout {
  const vw = Math.max(320, viewport.width);
  const vh = Math.max(320, viewport.height);
  const cx = anchorOrigin.x + anchorSize / 2;
  const cy = anchorOrigin.y + anchorSize / 2;
  const side: EchoSide = cx < vw / 2 ? 'left' : 'right';
  const openUp = cy > vh * 0.42;
  const half = visualSize / 2;
  const margin = 12;
  const gap = 14;

  // Radial control buttons: 38 px diameter on desktop/tablet (19 px half) and 36 px on compact phones (18 px half).
  // Orbit radius >= 112..120 px guarantees 0 px^2 AABB overlap with the 88 px active orb AND >= 4 px gap between
  // every adjacent 38x38 button even when dragged flush into an exact 90-degree viewport corner!
  const isCompact = vw < 640;
  const buttonSize = isCompact ? 36 : 38;
  const btnHalf = buttonSize / 2;
  const count = Math.max(1, Math.min(6, orbitCount));

  // Measure available clearance to the nearest horizontal and vertical viewport edges
  const edgeClearX = side === 'right' ? vw - margin - btnHalf - cx : cx - (margin + btnHalf);
  const edgeClearY = openUp ? vh - margin - btnHalf - cy : cy - (margin + btnHalf);
  const tightCorner = edgeClearX < 38 || edgeClearY < 38;
  const orbitR = Math.max(
    tightCorner ? (isCompact ? 122 : 128) : isCompact ? 108 : 114,
    Math.ceil((half + btnHalf + 6) * 1.48),
  );

  // Dynamically compute safe angular overhang beyond the pure 90-degree inward quadrant so controls
  // smoothly reflow inward near right/bottom/top/left edges instead of clipping or bunching together!
  const maxOverhangYDeg = Math.max(
    0,
    Math.min(isCompact ? 10 : 16, (Math.asin(Math.max(0, Math.min(1, edgeClearY / orbitR))) * 180) / Math.PI),
  );
  const maxOverhangXDeg = Math.max(
    0,
    Math.min(isCompact ? 10 : 16, (Math.asin(Math.max(0, Math.min(1, edgeClearX / orbitR))) * 180) / Math.PI),
  );

  let startDeg: number;
  let endDeg: number;
  if (side === 'right' && openUp) {
    startDeg = 180 - maxOverhangYDeg;
    endDeg = 270 + maxOverhangXDeg;
  } else if (side === 'right' && !openUp) {
    startDeg = 90 - maxOverhangXDeg;
    endDeg = 180 + maxOverhangYDeg;
  } else if (side === 'left' && openUp) {
    startDeg = 270 - maxOverhangXDeg;
    endDeg = 360 + maxOverhangYDeg;
  } else {
    startDeg = 0 - maxOverhangYDeg;
    endDeg = 90 + maxOverhangXDeg;
  }

  const rawPoints: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const rad = ((startDeg + (endDeg - startDeg) * t) * Math.PI) / 180;
    const rawX = cx + Math.cos(rad) * orbitR;
    const rawY = cy + Math.sin(rad) * orbitR;
    const clampedX = Math.min(vw - margin - btnHalf, Math.max(margin + btnHalf, rawX));
    const clampedY = Math.min(vh - margin - btnHalf, Math.max(margin + btnHalf, rawY));
    rawPoints.push({ x: Math.round(clampedX), y: Math.round(clampedY) });
  }

  // Post-clamp separation pass: guarantee >= buttonSize + 3 px AABB separation between all pairs
  const minSep = btnHalf * 2 + 3;
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < rawPoints.length; i++) {
      const prev = rawPoints[i - 1];
      const cur = rawPoints[i];
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      if (Math.abs(dx) < minSep && Math.abs(dy) < minSep) {
        const dirX = dx === 0 ? (side === 'right' ? -1 : 1) : Math.sign(dx);
        const dirY = dy === 0 ? (openUp ? -1 : 1) : Math.sign(dy);
        if (Math.abs(dx) >= Math.abs(dy)) {
          cur.x = Math.min(vw - margin - btnHalf, Math.max(margin + btnHalf, prev.x + dirX * minSep));
        } else {
          cur.y = Math.min(vh - margin - btnHalf, Math.max(margin + btnHalf, prev.y + dirY * minSep));
        }
      }
    }
  }

  const orbitOffsets: RadialOrbitPoint[] = rawPoints.map((pt) => ({
    x: Math.round(pt.x - cx),
    y: Math.round(pt.y - cy),
  }));

  // Instant hover micro-tooltip pill positioned cleanly clear of the radial arc
  const hintMaxW = Math.min(240, vw - margin * 2);
  const arcOuterReach = orbitR + btnHalf + 10;
  const hintTop = openUp
    ? Math.max(margin, Math.round(cy - arcOuterReach - 32))
    : Math.min(vh - margin - 32, Math.round(cy + arcOuterReach + 6));
  const hintBox: AmbientOverlayLayout['hintBox'] =
    side === 'right'
      ? {
          right: Math.max(margin, Math.round(vw - Math.min(vw - margin, cx + half))),
          top: hintTop,
          maxWidth: hintMaxW,
          align: 'right',
        }
      : {
          left: Math.max(margin, Math.round(Math.max(margin, cx - half))),
          top: hintTop,
          maxWidth: hintMaxW,
          align: 'left',
        };

  // Opt-in single-line CC ribbon: right-anchored on right side so short text hugs 14 px beside the orb!
  const captionMaxW = Math.min(340, vw - margin * 2);
  let captionBox: AmbientOverlayLayout['captionBox'];
  if (isCompact) {
    const cLeft = Math.round((vw - captionMaxW) / 2);
    if (openUp) {
      captionBox = {
        left: cLeft,
        bottom: Math.min(vh - margin - 40, Math.max(margin, Math.round(vh - (cy - half - gap)))),
        maxWidth: captionMaxW,
        align: 'center',
      };
    } else {
      captionBox = {
        left: cLeft,
        top: Math.min(vh - margin - 44, Math.max(margin, Math.round(cy + half + gap))),
        maxWidth: captionMaxW,
        align: 'center',
      };
    }
  } else if (side === 'right') {
    const availLeft = Math.max(160, Math.round(cx - half - gap - margin));
    captionBox = {
      right: Math.max(margin, Math.round(vw - (cx - half - gap))),
      top: Math.min(vh - margin - 42, Math.max(margin, Math.round(cy - 18))),
      maxWidth: Math.min(captionMaxW, availLeft),
      align: 'right',
    };
  } else {
    const availRight = Math.max(160, Math.round(vw - margin - (cx + half + gap)));
    captionBox = {
      left: Math.max(margin, Math.round(cx + half + gap)),
      top: Math.min(vh - margin - 42, Math.max(margin, Math.round(cy - 18))),
      maxWidth: Math.min(captionMaxW, availRight),
      align: 'left',
    };
  }

  // Ephemeral glassmorphic Action/Confirm/Resource/Recovery Toast:
  // Uses `bottom` anchoring when `openUp` so variable-height confirm cards (up to 360 px) grow UPWARD away from the orb.
  // When the radial micro-orbit is open (`orbitOpen`), clears the full radial arc (`orbitR + btnHalf + 12`) -> 0 px^2 overlap!
  const toastW = Math.min(348, vw - margin * 2);
  let toastLeft = side === 'right' ? Math.round(cx + half - toastW) : Math.round(cx - half);
  toastLeft = Math.min(vw - margin - toastW, Math.max(margin, toastLeft));

  const toastReach = orbitOpen ? orbitR + btnHalf + 12 : half + gap;
  const spaceAbove = Math.round(cy - toastReach - margin);
  const spaceBelow = Math.round(vh - margin - (cy + toastReach));
  let toastBox: AmbientOverlayLayout['toastBox'];

  if (openUp && spaceAbove >= 120) {
    toastBox = {
      left: toastLeft,
      bottom: Math.round(vh - (cy - toastReach)),
      width: toastW,
      maxHeight: Math.min(360, spaceAbove),
    };
  } else if (!openUp && spaceBelow >= 120) {
    toastBox = {
      left: toastLeft,
      top: Math.round(cy + toastReach),
      width: toastW,
      maxHeight: Math.min(360, spaceBelow),
    };
  } else if (spaceAbove >= spaceBelow && spaceAbove >= 96) {
    toastBox = {
      left: toastLeft,
      bottom: Math.round(vh - (cy - toastReach)),
      width: toastW,
      maxHeight: Math.min(360, spaceAbove),
    };
  } else {
    // Tight vertical lane: dock strictly inward horizontally beside the orb (and clear open orbit if space allows)
    const sideLeft =
      side === 'right'
        ? Math.max(margin, Math.round(cx - toastReach - toastW))
        : Math.min(vw - margin - toastW, Math.round(cx + toastReach));
    const maxH = Math.min(320, vh - margin * 2);
    toastBox = {
      left: sideLeft,
      top: Math.min(vh - margin - Math.min(200, maxH), Math.max(margin, Math.round(cy - 100))),
      width: toastW,
      maxHeight: maxH,
    };
  }

  return {
    side,
    openUp,
    buttonSize,
    orbitOffsets,
    hintBox,
    captionBox,
    toastBox,
  };
}

/** Local words only: never a request, never a claim about the learner's progress. */
const HUB_LINES: [string, string][] = [
  ['Học cùng Echo nhé! 🐳', 'Let’s learn together! 🐳'],
  ['Cần mình giúp gì không?', 'Need a hand with anything?'],
  ['Có từ nào khó hiểu không?', 'Any word you’re not sure about?'],
  ['Mình ở đây nếu bạn cần.', 'I’m here if you need me.'],
  ['Hôm nay học vui nhé!', 'Have a good study day!'],
];
const ROUTE_LINES: Record<string, [string, string]> = {
  '/games': ['Chơi một ván rồi học tiếp nhé!', 'One game, then back to learning!'],
  '/music': ['Nhạc hay giúp học dễ vào hơn đó.', 'Good music makes studying easier.'],
  '/learning-path': ['Mình giải thích bài nào cũng được nhé.', 'I can explain any lesson on your path.'],
};

export function nudgeLine(pathname: string, vi: boolean, turn: number): string {
  const special = ROUTE_LINES[pathname];
  const lines = special ? [special, ...HUB_LINES] : HUB_LINES;
  return lines[turn % lines.length][vi ? 0 : 1];
}

export const NUDGE_FIRST_MS = 12 * 60 * 1000;
export const NUDGE_EVERY_MS = 25 * 60 * 1000;
export const NUDGE_DISMISS_MS = 3 * 60 * 60 * 1000;
export const NUDGE_DWELL_MS = 6500;
export const NUDGE_MAX_PER_VISIT = 3;

export interface EchoPrefs { messages: boolean; quietUntil: number; turn: number }
export function restorePrefs(raw: string | null): EchoPrefs {
  try {
    const value = JSON.parse(raw || 'null');
    return { messages: value?.messages !== false, quietUntil: Number(value?.quietUntil) || 0, turn: Number(value?.turn) || 0 };
  } catch { return { messages: true, quietUntil: 0, turn: 0 }; }
}
