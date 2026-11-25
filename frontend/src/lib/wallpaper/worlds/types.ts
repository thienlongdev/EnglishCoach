/**
 * Echo Universe — Living Worlds: the contract between the shared runtime and a world's scene.
 * Everything runs in the learner's browser (their CPU / GPU). Nothing here talks to a server.
 */

export type WorldTier = 'high' | 'balanced' | 'low';

/** The learner's tuning, applied live (never remounts a scene). All 0…1. */
export interface WorldParams {
  /** Motion intensity: scales the scene's clock. */
  motion: number;
  /** Pointer / touch interaction strength; 0 = the scene ignores the pointer completely. */
  pointer: number;
  /** Quietness of the current activity (0 = free roaming, 1 = deep focus): slows the scene and calms interaction. */
  calm: number;
  /** The app's appearance (explicit `.dark` class). Worlds with a day and a night variant follow it. */
  dark: boolean;
}

/** One live pointer, read by scenes every frame. High-frequency: never goes through React state. */
export interface WorldPointer {
  /** Latest position, 0…1, v goes UP (GL convention). */
  u: number;
  v: number;
  /** Follows the pointer softly: use for parallax and lights. */
  su: number;
  sv: number;
  /** Velocity in screen heights per second (smoothed), v up. */
  vx: number;
  vy: number;
  /** 0…1: how much the pointer has been moving lately; decays to 0 when it rests. Already scaled by `strength`. */
  energy: number;
  /** Effective interaction strength (params.pointer × calm). */
  strength: number;
  /** A device with a real hovering pointer. */
  fine: boolean;
  /** Presses since the last call (u, v up), each one consumed once. Empty while interaction is off. */
  drainPulses(): { u: number; v: number }[];
}

export interface WorldEnv {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  /** Drawing-buffer size in device pixels. */
  width: number;
  height: number;
  /** Size of the area on screen, in CSS pixels. */
  cssWidth: number;
  cssHeight: number;
  /** Device pixels per CSS pixel of the drawing buffer (adaptive). */
  pixelRatio: number;
  tier: WorldTier;
  params: WorldParams;
  pointer: WorldPointer;
}

export interface WorldInstance {
  /** t = the scene clock (seconds, already scaled by motion and calm); dt = its step. */
  frame(t: number, dt: number): void;
  /** The drawing buffer changed (env.width / height are current). */
  resize(): void;
  dispose(): void;
  /** Simulated scenes: advance `seconds` of life without drawing, so a world opens already alive. */
  warm?(seconds: number): void;
  /** Frames per second the scene needs (ASCII worlds step at a lower, characterful rate). */
  fps?: number;
  /** Share of the device's pixel budget (soft scenes such as clouds look the same with fewer pixels). */
  pixels?: number;
  /** Keeps its full resolution (character worlds: glyphs must stay crisp and are cheap to draw). */
  crisp?: boolean;
}

export type WorldFactory = (env: WorldEnv) => WorldInstance | Promise<WorldInstance>;

export type WorldCategory = 'ocean' | 'nature' | 'cosmos' | 'ascii' | 'd2' | 'd3' | 'interactive' | 'focus';

export type WorldTech = '3D' | '2D' | 'ASCII' | 'Shader';
