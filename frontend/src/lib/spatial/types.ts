import type { WorldEnv, WorldInstance } from '@/lib/wallpaper/worlds/types';

/** Echo Spatial: the contract between the engine, the DOM layer and the scenes. Everything runs in the visitor's browser. */

export type SpatialCategory = 'gallery' | 'material' | 'geometry' | 'cinematic' | 'transition' | 'type' | 'pointer' | 'surface' | 'immersive';
export type SurfaceMotion = 'none' | 'tilt' | 'float' | 'magnet' | 'skew' | 'press';
export type SurfaceSheen = 'none' | 'light' | 'holo' | 'crystal' | 'iridescent' | 'liquid' | 'frost';
export type TransitionKind = 'fade' | 'morph' | 'panel' | 'portal' | 'fluid' | 'flip' | 'zoom';
export type TypeEffect = 'none' | 'extrude' | 'elastic' | 'particle' | 'depth' | 'fluid' | 'morph';
export type OverlayKind = 'none' | 'liquid' | 'gravity' | 'motes';
export type GalleryLayout = 'curve' | 'orbit' | 'sphere' | 'spiral' | 'perspective' | 'grid';
export type PaletteId = 'ocean' | 'violet' | 'ember' | 'pearl' | 'aurora' | 'prism' | 'mono' | 'cobalt' | 'lagoon' | 'neon' | 'dusk' | 'teal';

export interface SpatialPreset {
  id: string;
  /** A01 … I08: the position in the owner's brief. */
  code: string;
  category: SpatialCategory;
  titleVi: string;
  titleEn: string;
  descVi: string;
  descEn: string;
  /** What the pointer or the scroll does. */
  touchVi: string;
  touchEn: string;
  scene: string;
  sceneOpts?: Record<string, number | string>;
  palette: PaletteId;
  surface: SurfaceMotion;
  sheen: SurfaceSheen;
  /** Solid panels become see-through glass over the scene (rich screens only). */
  glass?: boolean;
  /** Sidebar and top bar layers answer the pointer in depth. */
  nav?: boolean;
  /** Everything but the card under the pointer steps back a little. */
  spotlight?: boolean;
  transition: TransitionKind;
  type: TypeEffect;
  overlay: OverlayKind;
  lens?: GalleryLayout;
  weight: 'light' | 'medium' | 'rich';
  tech: string;
}

/** Live data the engine hands to a scene every frame. No React, no allocation per frame. */
export interface SpatialBridge {
  /** x, y, w, h in CSS px from the top-left of the stage, for `count` surfaces. */
  rects: Float32Array;
  /** radius, hover 0…1, lift 0…1, kind (0 card, 1 shell). */
  meta: Float32Array;
  count: number;
  /** The card under the pointer (CSS px centre) and how present it is, 0…1. */
  hoverX: number;
  hoverY: number;
  hoverAmount: number;
  /** Native scroll of the workspace: never hijacked, only read. */
  scrollProgress: number;
  scrollTop: number;
  /** Viewport heights per second, smoothed. */
  scrollVelocity: number;
  /** What a scene's interaction is doing right now: plain numbers for diagnostics and the QA journeys, never read back by anything. */
  probe?: Record<string, number>;
  /** Rises to 1 on a route change and decays; `routeSeq` counts them; `routeU/V` where it started. */
  routePulse: number;
  routeSeq: number;
  routeU: number;
  routeV: number;
  depth: number;
  material: number;
  /** A few real words of the current page (typography scenes). */
  words: string[];
}

export type SpatialSceneFactory = (env: WorldEnv, bridge: SpatialBridge, opts: Record<string, number | string>, palette: PaletteId) => WorldInstance | Promise<WorldInstance>;
