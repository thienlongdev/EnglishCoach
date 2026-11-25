/**
 * The Echo Hall trophy, as numbers: lathe profiles (radius, height) and the handle curve. The real-time scene
 * (`trophyScene.ts`) and the still for no-WebGL / Save-Data visitors (`docs/leaderboard/hall-of-champions-2026-10-30/art/
 * scene_trophy.py`) are built from these same numbers — change both together.
 */
export type P2 = readonly [number, number];

/** Lapis plinth (navy), y 0 … 0.34. */
export const PLINTH: P2[] = [
  [0, 0], [0.62, 0], [0.64, 0.03], [0.64, 0.27], [0.6, 0.31], [0.5, 0.34], [0, 0.34],
];

/** Gold body: foot, stem, knot, bowl with its rolled lip and inner wall (closed at the inner bottom). */
export const BODY: P2[] = [
  [0, 0.34], [0.46, 0.34], [0.44, 0.39], [0.36, 0.44], [0.24, 0.5], [0.15, 0.58], [0.11, 0.68], [0.105, 0.8],
  [0.15, 0.85], [0.2, 0.9], [0.2, 0.95], [0.15, 1.0], [0.1, 1.05], [0.12, 1.1], [0.24, 1.15], [0.4, 1.22],
  [0.53, 1.33], [0.62, 1.48], [0.67, 1.66], [0.69, 1.84], [0.72, 1.98], [0.78, 2.06], [0.8, 2.1], [0.76, 2.12],
  [0.7, 2.08], [0.65, 1.96], [0.62, 1.78], [0.56, 1.58], [0.44, 1.42], [0.24, 1.32], [0, 1.3],
];

/** Right handle (x > 0) in the x / y plane; the left one is its mirror. */
export const HANDLE: P2[] = [[0.66, 1.9], [0.98, 1.98], [1.12, 1.78], [1.02, 1.5], [0.74, 1.32], [0.5, 1.25]];

/** Height of the whole piece (for framing). */
export const TROPHY_HEIGHT = 2.14;
