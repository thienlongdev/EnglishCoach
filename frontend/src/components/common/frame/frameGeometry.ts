/** Calibrated from the bundled SVG viewBox and documented transparent aperture.
 * Asset geometry is independent of prestige and LOD: shrinking a canvas also
 * shrinks its opening. Unknown future assets retain the existing LOD fallback.
 */
export interface FrameAssetGeometry {
  canvas: number;
  apertureDiameter: number;
}

const STANDARD: FrameAssetGeometry = { canvas: 100, apertureDiameter: 80 };
const SEASONAL: FrameAssetGeometry = { canvas: 100, apertureDiameter: 81 };
const ORNATE: FrameAssetGeometry = { canvas: 175, apertureDiameter: 81 };

export const FRAME_ASSET_GEOMETRY: Readonly<Record<string, FrameAssetGeometry>> = {
  'streak_flame_c.svg': STANDARD,
  'streak_flame_b.svg': STANDARD,
  'streak_flame_a.svg': STANDARD,
  'vocab_mastery_c.svg': STANDARD,
  'vocab_mastery_b.svg': STANDARD,
  'vocab_mastery_s.svg': STANDARD,
  'cefr_b2.svg': STANDARD,
  'cefr_c1.svg': STANDARD,
  'cefr_c2.svg': STANDARD,
  'ranked_gold.svg': STANDARD,
  'ranked_master.svg': STANDARD,
  'ranked_challenger.svg': STANDARD,
  'legacy_founder.svg': STANDARD,
  'sss_dragon_emperor.svg': { canvas: 175, apertureDiameter: 80 },
  'sss_phoenix_rebirth.svg': ORNATE,
  'premium_sovereign_aegis.svg': ORNATE,
  'premium_ruby_crest.svg': SEASONAL,
  'premium_sapphire_crown.svg': SEASONAL,
  'event_tet_festival.svg': SEASONAL,
  'season_spring.svg': SEASONAL,
  'season_summer.svg': SEASONAL,
  'season_autumn.svg': SEASONAL,
  'season_winter.svg': SEASONAL,
};

/** Echo Garden frames (V87): Blender renders, 512 px canvas with a 256 px transparent opening for the portrait. */
export const GARDEN_FRAME_GEOMETRY: FrameAssetGeometry = { canvas: 512, apertureDiameter: 256 };
const GARDEN_FRAME_PATH = /^\/assets\/frames\/garden\/garden_[a-z_]+\.webp$/;

export function getAssetFootprintPercent(assetUrl: string, fallback: number): number {
  // Only calibrate the known local artwork, never a same-named external asset.
  const path = assetUrl.split(/[?#]/, 1)[0];
  const geometry = GARDEN_FRAME_PATH.test(path)
    ? GARDEN_FRAME_GEOMETRY
    : path.startsWith('/assets/frames/')
    ? FRAME_ASSET_GEOMETRY[path.slice('/assets/frames/'.length)]
    : undefined;
  return geometry ? 100 * geometry.canvas / geometry.apertureDiameter : fallback;
}
