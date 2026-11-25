/**
 * Swim lanes: regions of the landing page where Echo the whale may swim.
 *
 * A lane is any element carrying `data-whale-lane`. Its box (in document coordinates) is the water the whale's centre
 * travels through; the attributes describe how it swims there. The page layout therefore drives the choreography —
 * a new section only needs a lane element, never a coordinate in code.
 *
 *   data-whale-lane="hero"            identifier (also the bubble key)
 *   data-whale-path="orbit|flank|hover"
 *   data-whale-size="lg,md,sm"        whale length in CSS px at ≥1024 / ≥640 / <640 viewport width
 *   data-whale-v="near,far"           orbit only: vertical position (0..1 of the lane) of the near and far pass
 *   data-whale-amp="0.42"             orbit / hover: horizontal amplitude (0..0.5 of the lane width)
 *   data-whale-side="left|right"      flank only: which edge of the lane the whale keeps to
 *   data-whale-period="18"            seconds per lap
 *   data-whale-haze="0"               base depth haze 0..1 (more haze = further into the water)
 *   data-whale-say="…"                optional speech bubble for this lane
 *   data-whale-min="1024"             lane is ignored below this viewport width (the whale leaves instead)
 */

export type LanePath = 'orbit' | 'flank' | 'hover';

export interface Lane {
  el: HTMLElement;
  id: string;
  path: LanePath;
  sizes: [number, number, number];
  nearV: number;
  farV: number;
  amp: number;
  side: -1 | 1;
  period: number;
  haze: number;
  say: string | null;
  minWidth: number;
  /** Box in document coordinates (CSS px), refreshed by `measureLanes`. */
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface LaneSample {
  /** Target centre in viewport CSS px. */
  x: number;
  y: number;
  /** Target whale length in CSS px. */
  size: number;
  /** -1 = far pass, +1 = near pass. */
  depth: number;
  haze: number;
}

const num = (value: string | undefined, fallback: number) => {
  const parsed = value === undefined ? NaN : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const pair = (value: string | undefined, a: number, b: number): [number, number] => {
  if (!value) return [a, b];
  const [x, y] = value.split(',');
  return [num(x, a), num(y, b)];
};

export function readLanes(root: ParentNode): Lane[] {
  const lanes: Lane[] = [];
  root.querySelectorAll<HTMLElement>('[data-whale-lane]').forEach((el) => {
    const d = el.dataset;
    const path = (d.whalePath === 'flank' || d.whalePath === 'hover' ? d.whalePath : 'orbit') as LanePath;
    const sizeParts = (d.whaleSize || '').split(',');
    const lg = num(sizeParts[0], 300);
    const md = num(sizeParts[1], lg * 0.8);
    const sm = num(sizeParts[2], md * 0.75);
    const [nearV, farV] = pair(d.whaleV, 0.2, 0.6);
    lanes.push({
      el,
      id: d.whaleLane || 'lane',
      path,
      sizes: [lg, md, sm],
      nearV,
      farV,
      amp: num(d.whaleAmp, path === 'hover' ? 0.08 : 0.42),
      side: d.whaleSide === 'left' ? -1 : 1,
      period: Math.max(4, num(d.whalePeriod, path === 'orbit' ? 18 : 12)),
      haze: Math.min(1, Math.max(0, num(d.whaleHaze, 0))),
      say: d.whaleSay?.trim() || null,
      minWidth: num(d.whaleMin, 0),
      top: 0,
      left: 0,
      width: 0,
      height: 0,
    });
  });
  return lanes;
}

/** Refresh every lane box. Called on resize / layout change, never per frame. */
export function measureLanes(lanes: Lane[]) {
  const sx = window.scrollX;
  const sy = window.scrollY;
  for (const lane of lanes) {
    const rect = lane.el.getBoundingClientRect();
    lane.top = rect.top + sy;
    lane.left = rect.left + sx;
    lane.width = rect.width;
    lane.height = rect.height;
  }
}

export function laneEnabled(lane: Lane, viewportWidth: number) {
  return lane.width > 0 && lane.height > 0 && viewportWidth >= lane.minWidth;
}

export function laneBaseSize(lane: Lane, viewportWidth: number) {
  return viewportWidth >= 1024 ? lane.sizes[0] : viewportWidth >= 640 ? lane.sizes[1] : lane.sizes[2];
}

/**
 * The lane the visitor is looking at: the enabled lane whose centre is closest to the focus line (42 % of the
 * viewport height). `current` keeps its place unless another lane is clearly closer, so the whale never dithers
 * between two sections at a boundary.
 */
export function pickLane(lanes: Lane[], current: Lane | null, scrollY: number, vw: number, vh: number): Lane | null {
  const focus = scrollY + vh * 0.42;
  let best: Lane | null = null;
  let bestDistance = Infinity;
  let currentDistance = Infinity;
  for (const lane of lanes) {
    if (!laneEnabled(lane, vw)) continue;
    const top = lane.top;
    const bottom = lane.top + lane.height;
    const distance = focus < top ? top - focus : focus > bottom ? focus - bottom : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = lane;
    }
    if (lane === current) currentDistance = distance;
  }
  if (current && best !== current && currentDistance - bestDistance < vh * 0.08) return current;
  return best;
}

/**
 * Where the whale should be in `lane` at path time `t` (seconds). Paths are closed-form, so a lane resumes
 * seamlessly whenever the whale returns to it.
 */
export function sampleLane(lane: Lane, t: number, scrollX: number, scrollY: number, vw: number, out: LaneSample) {
  const theta = (t / lane.period) * Math.PI * 2;
  const base = laneBaseSize(lane, vw);
  let u: number;
  let v: number;
  let depth: number;

  if (lane.path === 'orbit') {
    // A horizontal circle seen from below: the near pass is high and large, the far pass low, small and hazy,
    // so the whale circles "around" whatever sits in the middle of the lane.
    depth = Math.cos(theta);
    u = 0.5 + lane.amp * Math.sin(theta);
    const mid = (lane.nearV + lane.farV) / 2;
    const span = (lane.farV - lane.nearV) / 2;
    v = mid - span * depth + 0.025 * Math.sin(theta * 2 + 1.3);
  } else if (lane.path === 'flank') {
    // A lazy loop just outside one edge of the lane (a section card), mostly in its shade.
    depth = 0.55 * Math.cos(theta) - 0.35;
    u = (lane.side > 0 ? 1.0 : 0.0) + lane.side * 0.02 + 0.05 * Math.sin(theta);
    v = 0.38 + 0.07 * Math.sin(theta * 2 + 0.6);
  } else {
    depth = 0.25 * Math.cos(theta);
    u = 0.5 + lane.amp * Math.sin(theta);
    v = 0.5 + 0.12 * Math.sin(theta * 2);
  }

  out.x = lane.left - scrollX + u * lane.width;
  out.y = lane.top - scrollY + v * lane.height;
  out.size = base * Math.pow(2, 0.55 * depth);
  out.depth = depth;
  out.haze = Math.min(0.85, lane.haze + Math.max(0, -depth) * 0.5);
  return out;
}
