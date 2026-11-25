import type { SpatialSceneFactory } from '../types';

/** One lazy chunk per scene: applying a preset downloads only what it uses. */
const LOADERS: Record<string, () => Promise<{ default: SpatialSceneFactory }>> = {
  gallery: () => import('./gallery'),
  liquidGlass: () => import('./liquidGlass'),
  crystal: () => import('./crystal'),
  fluid: () => import('./fluid'),
  lens: () => import('./lens'),
  iridescent: () => import('./iridescent'),
  frostedBars: () => import('./frostedBars'),
  wavyCubes: () => import('./wavyCubes'),
  droplets: () => import('./droplets'),
  zenSand: () => import('./zenSand'),
  elastic: () => import('./elastic'),
  magnetic: () => import('./magnetic'),
  kinetic: () => import('./kinetic'),
  floating: () => import('./floating'),
  deform: () => import('./deform'),
  cameraPath: () => import('./cameraPath'),
  parallax: () => import('./parallax'),
  imageTube: () => import('./imageTube'),
  corridor: () => import('./corridor'),
  atmosphere: () => import('./atmosphere'),
  journey: () => import('./journey'),
  transitionEnv: () => import('./transitionEnv'),
  typeField: () => import('./typeField'),
  fieldLines: () => import('./fieldLines'),
  gravity: () => import('./gravity'),
  clothField: () => import('./clothField'),
  lightRig: () => import('./lightRig'),
  vortex: () => import('./vortex'),
  floor: () => import('./floor'),
  glassBlobs: () => import('./glassBlobs'),
  strata: () => import('./strata'),
  drift: () => import('./drift'),
  hologram: () => import('./hologram'),
  spotlight: () => import('./spotlight'),
  caustics: () => import('./caustics'),
  signature: () => import('./signature'),
};

export async function loadSpatialScene(id: string): Promise<SpatialSceneFactory> {
  const loader = LOADERS[id];
  if (!loader) throw new Error('unknown scene');
  return (await loader()).default;
}

export const SPATIAL_SCENE_IDS = Object.keys(LOADERS);
