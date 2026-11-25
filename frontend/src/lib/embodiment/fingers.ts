/**
 * What the fingers do. Joint ranges come from human hands (flexion in radians: MCP up to about 1.57, PIP 1.75, DIP 1.2;
 * spread about 0.26 at most; the thumb has less and works across the palm). The bind pose is the source hand at rest,
 * already a little curved, so 0 is a relaxed open hand. A grip is one set of targets; the runtime eases between them.
 */
export type Grip = 'relaxed' | 'ready' | 'open' | 'flat' | 'loose' | 'fist' | 'handle' | 'cylinder' | 'pinch' | 'press' | 'book' | 'type';
export const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'little'] as const;

/** [joint 1, joint 2, joint 3, spread] per finger, thumb first. */
export type FingerPose = number[][];
export const GRIPS: Record<Grip, FingerPose> = {
  // Anatomical resting cascade: closes Lyra/Kai's 29.3° splayed bind fan to a soft natural ~8° fall with tucked thumb.
  relaxed: [[.20, .22, .14, .04], [.18, .28, .18, -.08], [.26, .38, .22, -.02], [.34, .46, .26, .05], [.42, .52, .30, .10]],
  // Carried up in front, about to do something: loosely curled, the index a little ahead of the others.
  ready: [[.12, .16, .14, .1], [.14, .22, .14, .03], [.22, .32, .2, .005], [.3, .38, .24, -.015], [.38, .44, .26, -.04]],
  open: [[.0, .02, .02, .22], [.02, .03, .02, .10], [.0, .03, .02, .02], [.02, .03, .02, -.05], [.03, .04, .03, -.12]],
  flat: [[-.5, .02, .02, .12], [.0, .02, .01, .0], [.0, .02, .01, .0], [.0, .02, .01, .0], [.0, .02, .01, .0]],
  loose: [[.16, .22, .18, .04], [.42, .62, .34, .03], [.50, .68, .36, 0], [.56, .72, .38, -.02], [.60, .76, .40, -.04]],
  fist: [[.34, .60, .62, -.14], [1.25, 1.55, .95, .02], [1.30, 1.60, 1.0, 0], [1.34, 1.62, 1.0, -.02], [1.38, 1.62, 1.0, -.04]],
  handle: [[.55, .75, .80, -.08], [.88, 1.08, .72, .02], [.96, 1.16, .78, 0], [1.02, 1.20, .80, -.02], [1.06, 1.24, .82, -.04]],
  cylinder: [[.10, .16, .20, .30], [.66, .84, .58, .05], [.72, .90, .62, .01], [.78, .92, .64, -.03], [.84, .96, .66, -.08]],
  pinch: [[.58, .46, .56, .16], [.78, .98, .70, .03], [.46, .62, .42, 0], [.52, .66, .44, -.02], [.58, .70, .46, -.05]],
  press: [[.26, .44, .40, -.04], [.08, .10, .06, .03], [.92, 1.24, .84, 0], [1.02, 1.30, .88, -.02], [1.08, 1.32, .90, -.04]],
  book: [[.28, .10, .08, .36], [.20, .26, .14, .05], [.22, .28, .16, .01], [.26, .30, .18, -.03], [.30, .32, .20, -.08]],
  type: [[.20, .24, .20, .10], [.46, .52, .32, .05], [.48, .54, .34, .01], [.50, .56, .34, -.03], [.54, .58, .36, -.08]],
};

const OUT: FingerPose = GRIPS.relaxed.map(f => [...f]);

/** Anatomical flexion bounds `[minFlex, maxFlex]` per joint `[0, 1, 2]` so digits never hyper-extend backwards or fold through the palm. */
export const THUMB_FLEX_LIMITS: readonly [readonly [number, number], readonly [number, number], readonly [number, number]] = [
  [-0.55, 1.15],
  [-0.06, 1.25],
  [-0.06, 1.45],
];
export const DIGIT_FLEX_LIMITS: readonly [readonly [number, number], readonly [number, number], readonly [number, number]] = [
  [-0.12, 1.60],
  [-0.06, 1.76],
  [-0.06, 1.22],
];
export const THUMB_SPREAD_LIMITS: readonly [number, number] = [-0.25, 1.15];
export const DIGIT_SPREAD_LIMITS: readonly [number, number] = [-0.28, 0.28];
export const THUMB_OPPOSITION_LIMITS: readonly [number, number] = [-0.45, 0.85];

export function clampFingerBend(finger: number, joint: number, rad: number, minOverride?: number): number {
  const bounds = (finger === 0 ? THUMB_FLEX_LIMITS : DIGIT_FLEX_LIMITS)[joint] ?? DIGIT_FLEX_LIMITS[0];
  const lo = minOverride !== undefined ? Math.min(bounds[0], minOverride) : bounds[0];
  return Math.max(lo, Math.min(bounds[1], Number.isFinite(rad) ? rad : 0));
}

export function clampFingerSpread(finger: number, rad: number): number {
  const bounds = finger === 0 ? THUMB_SPREAD_LIMITS : DIGIT_SPREAD_LIMITS;
  return Math.max(bounds[0], Math.min(bounds[1], Number.isFinite(rad) ? rad : 0));
}

export function clampFingerOpposition(finger: number, rad: number): number {
  if (finger !== 0) return 0;
  return Math.max(THUMB_OPPOSITION_LIMITS[0], Math.min(THUMB_OPPOSITION_LIMITS[1], Number.isFinite(rad) ? rad : 0));
}

/** Blend a grip with a weight; a gesture's single `curl` (0 open, 1 fist) maps onto the same joints. */
export function curlPose(curl: number, thumbOut = 0): FingerPose {
  const c = Math.max(0, Math.min(1.05, Number.isFinite(curl) ? curl : 0));
  for (let i = 0; i < 5; i++) {
    const from = GRIPS.open[i], to = GRIPS.fist[i];
    for (let j = 0; j < 3; j++) OUT[i][j] = clampFingerBend(i, j, from[j] + (to[j] - from[j]) * c);
    OUT[i][3] = clampFingerSpread(i, from[3] + (to[3] - from[3]) * c);
  }
  if (thumbOut) {
    OUT[0][0] = clampFingerBend(0, 0, OUT[0][0] - thumbOut * .5);
    OUT[0][3] = clampFingerSpread(0, thumbOut * .35);
  }
  return OUT;
}
