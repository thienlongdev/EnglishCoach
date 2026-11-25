import { ROAD, gateCenter } from '../rushModel';

/**
 * The one mapping from authoritative race coordinates to the 3D scene. Lateral x (50–950) maps at 1/100 of a unit,
 * forward y at 1/50: the forward axis is stretched so running reads as fast while every collision stays exact —
 * walls are drawn at their plane, doorways at their opening, runners at their own (x, y).
 */
export const SCENE = { kx: .01, kz: .02, roadHalf: (ROAD.right - ROAD.left) / 2 * .01 };
export const toX = (x: number) => (x - 500) * SCENE.kx;
export const toZ = (y: number) => -y * SCENE.kz;
export const laneX = (index: number, count: number) => toX(gateCenter(index, count));
/** Visual half-width of a doorway = collision opening + the runner's radius (the body edge meets the jamb). */
export const doorHalfWidth = (count: number, spacing = ROAD.spacing) =>
  ((ROAD.right - ROAD.left) / count * (spacing > 1100 ? .22 : .38)) * SCENE.kx;
/** Wall centre in scene z: the runner's contact position puts its chest on the door face. */
export const wallZ = (barrier: number) => toZ(barrier) + .065;
/** Lane colours shared by the doors and the HUD choices (sky, gold, jade, violet). Red is reserved for a refused door. */
export const LANE_COLORS = [0x5cc8ff, 0xf6c453, 0x46d6a8, 0xb18cff];
export const LANE_CSS = ['#5cc8ff', '#f6c453', '#46d6a8', '#b18cff'];
