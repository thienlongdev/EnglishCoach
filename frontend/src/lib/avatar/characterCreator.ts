/**
 * Echo Life Wave 11 — Character Creator Core Data Model, Presets, Seasonal Outfit Resolver,
 * History Stack, Sanitizer, and Compact V2 Wire Codec.
 *
 * Pure TypeScript module with zero DOM, Three.js, React, or network dependencies.
 * All copy is clean English (zero ampersands, zero Vietnamese, zero passive AI calls).
 */
import { WARDROBE, FABRICS, SKIN_TONE, type WardrobeItem } from './wardrobeAssets';
import {
  SIGNATURE,
  decodeLook,
  defaultLook,
  normalizeLook,
  type AvatarLook,
  type Hero,
} from './look';

// ── 1. Face Sculpt Morphs (20 GLB Morph Targets) ─────────────────────────────────────────────────────────

export type FaceMorphTab =
  | 'Head and Jaw'
  | 'Eyes and Brows'
  | 'Nose'
  | 'Lips'
  | 'Style';

export const FACE_MORPH_TABS: readonly FaceMorphTab[] = [
  'Head and Jaw',
  'Eyes and Brows',
  'Nose',
  'Lips',
  'Style',
] as const;

export type FaceMorphKey =
  | 'sculpt_stylized'
  | 'sculpt_eastAsian'
  | 'sculpt_jawWidth'
  | 'sculpt_jawSharp'
  | 'sculpt_chinHeight'
  | 'sculpt_chinWidth'
  | 'sculpt_cheekFull'
  | 'sculpt_eyeSize'
  | 'sculpt_eyeSpacing'
  | 'sculpt_eyeTilt'
  | 'sculpt_eyeMonolid'
  | 'sculpt_browHeight'
  | 'sculpt_noseLength'
  | 'sculpt_noseWidth'
  | 'sculpt_noseBridge'
  | 'sculpt_noseTip'
  | 'sculpt_lipFullness'
  | 'sculpt_mouthWidth'
  | 'sculpt_lipArch'
  | 'sculpt_mouthCorner';

export interface FaceMorphDef {
  readonly key: FaceMorphKey;
  readonly tab: FaceMorphTab;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly defaultValue: number;
}

export const FACE_MORPH_DEFS: readonly FaceMorphDef[] = [
  // Style
  { key: 'sculpt_stylized', tab: 'Style', label: 'Stylized Contour', min: -1, max: 1, step: 0.02, defaultValue: 0 },
  { key: 'sculpt_eastAsian', tab: 'Style', label: 'East Asian Harmony', min: -1, max: 1, step: 0.02, defaultValue: 0 },
  // Head and Jaw
  { key: 'sculpt_jawWidth', tab: 'Head and Jaw', label: 'Jaw Width', min: -1, max: 1, step: 0.02, defaultValue: 0 },
  { key: 'sculpt_jawSharp', tab: 'Head and Jaw', label: 'Jawline Definition', min: -1, max: 1, step: 0.02, defaultValue: 0 },
  { key: 'sculpt_chinHeight', tab: 'Head and Jaw', label: 'Chin Height', min: -1, max: 1, step: 0.02, defaultValue: 0 },
  { key: 'sculpt_chinWidth', tab: 'Head and Jaw', label: 'Chin Width', min: -1, max: 1, step: 0.02, defaultValue: 0 },
  { key: 'sculpt_cheekFull', tab: 'Head and Jaw', label: 'Cheek Fullness', min: -1, max: 1, step: 0.02, defaultValue: 0 },
  // Eyes and Brows
  { key: 'sculpt_eyeSize', tab: 'Eyes and Brows', label: 'Eye Size', min: -1, max: 1, step: 0.02, defaultValue: 0 },
  { key: 'sculpt_eyeSpacing', tab: 'Eyes and Brows', label: 'Eye Spacing', min: -1, max: 1, step: 0.02, defaultValue: 0 },
  { key: 'sculpt_eyeTilt', tab: 'Eyes and Brows', label: 'Eye Tilt', min: -1, max: 1, step: 0.02, defaultValue: 0 },
  { key: 'sculpt_eyeMonolid', tab: 'Eyes and Brows', label: 'Eyelid Fold', min: -1, max: 1, step: 0.02, defaultValue: 0 },
  { key: 'sculpt_browHeight', tab: 'Eyes and Brows', label: 'Brow Height', min: -1, max: 1, step: 0.02, defaultValue: 0 },
  // Nose
  { key: 'sculpt_noseLength', tab: 'Nose', label: 'Nose Length', min: -1, max: 1, step: 0.02, defaultValue: 0 },
  { key: 'sculpt_noseWidth', tab: 'Nose', label: 'Nose Width', min: -1, max: 1, step: 0.02, defaultValue: 0 },
  { key: 'sculpt_noseBridge', tab: 'Nose', label: 'Nose Bridge', min: -1, max: 1, step: 0.02, defaultValue: 0 },
  { key: 'sculpt_noseTip', tab: 'Nose', label: 'Nose Tip Lift', min: -1, max: 1, step: 0.02, defaultValue: 0 },
  // Lips
  { key: 'sculpt_lipFullness', tab: 'Lips', label: 'Lip Fullness', min: -1, max: 1, step: 0.02, defaultValue: 0 },
  { key: 'sculpt_mouthWidth', tab: 'Lips', label: 'Mouth Width', min: -1, max: 1, step: 0.02, defaultValue: 0 },
  { key: 'sculpt_lipArch', tab: 'Lips', label: 'Cupid Bow Arch', min: -1, max: 1, step: 0.02, defaultValue: 0 },
  { key: 'sculpt_mouthCorner', tab: 'Lips', label: 'Mouth Corner Curve', min: -1, max: 1, step: 0.02, defaultValue: 0 },
] as const;

export type FaceSculptWeights = Record<FaceMorphKey, number>;

/** Canonical top 10 key face sculpt weights serialized in the 20-hex V2 wire payload. */
export const WIRE_V2_FACE_KEYS: readonly FaceMorphKey[] = [
  'sculpt_stylized',
  'sculpt_eastAsian',
  'sculpt_jawWidth',
  'sculpt_jawSharp',
  'sculpt_cheekFull',
  'sculpt_eyeSize',
  'sculpt_eyeTilt',
  'sculpt_eyeMonolid',
  'sculpt_noseWidth',
  'sculpt_lipFullness',
] as const;

export function defaultFaceSculptWeights(): FaceSculptWeights {
  return {
    sculpt_stylized: 0,
    sculpt_eastAsian: 0,
    sculpt_jawWidth: 0,
    sculpt_jawSharp: 0,
    sculpt_chinHeight: 0,
    sculpt_chinWidth: 0,
    sculpt_cheekFull: 0,
    sculpt_eyeSize: 0,
    sculpt_eyeSpacing: 0,
    sculpt_eyeTilt: 0,
    sculpt_eyeMonolid: 0,
    sculpt_browHeight: 0,
    sculpt_noseLength: 0,
    sculpt_noseWidth: 0,
    sculpt_noseBridge: 0,
    sculpt_noseTip: 0,
    sculpt_lipFullness: 0,
    sculpt_mouthWidth: 0,
    sculpt_lipArch: 0,
    sculpt_mouthCorner: 0,
  };
}

// ── 2. Skin Tones, Iris Hues, Makeup, and Facial Details ─────────────────────────────────────────────────

export interface SkinTonePreset {
  readonly id: string;
  readonly label: string;
  readonly fitzpatrick: 'I' | 'II' | 'III' | 'IV' | 'V' | 'VI';
  readonly hex: string;
}

export const SKIN_TONE_PRESETS: readonly SkinTonePreset[] = [
  { id: 'porcelain_cool', label: 'Cool Porcelain', fitzpatrick: 'I', hex: '#f4dfd2' },
  { id: 'ivory_neutral', label: 'Warm Ivory', fitzpatrick: 'I', hex: '#f0d4be' },
  { id: 'alabaster_peach', label: 'Soft Peach', fitzpatrick: 'II', hex: '#e9c4a8' },
  { id: 'vanilla_beige', label: 'Light Beige', fitzpatrick: 'II', hex: '#e0b796' },
  { id: 'sand_warm', label: 'Warm Sand', fitzpatrick: 'III', hex: '#d5a684' },
  { id: 'riverside_natural', label: 'Golden Honey', fitzpatrick: 'III', hex: '#cb9578' },
  { id: 'almond_tan', label: 'Toasted Almond', fitzpatrick: 'IV', hex: '#ba8262' },
  { id: 'caramel_bronze', label: 'Warm Caramel', fitzpatrick: 'IV', hex: '#a66e4e' },
  { id: 'chestnut_rich', label: 'Rich Chestnut', fitzpatrick: 'V', hex: '#8e593d' },
  { id: 'umber_glow', label: 'Deep Umber', fitzpatrick: 'V', hex: '#764730' },
  { id: 'espresso_warm', label: 'Warm Espresso', fitzpatrick: 'VI', hex: '#5c3624' },
  { id: 'obsidian_velvet', label: 'Deep Cocoa', fitzpatrick: 'VI', hex: '#43261a' },
] as const;

export interface IrisColorPreset {
  readonly id: string;
  readonly label: string;
  readonly hex: string;
}

export const IRIS_COLOR_PRESETS: readonly IrisColorPreset[] = [
  { id: 'obsidian_brown', label: 'Deep Espresso', hex: '#2f1f18' },
  { id: 'warm_chestnut', label: 'Warm Chestnut', hex: '#543524' },
  { id: 'amber_honey', label: 'Amber Honey', hex: '#8c5e2c' },
  { id: 'warm_hazel', label: 'Olive Hazel', hex: '#6e6a3c' },
  { id: 'forest_green', label: 'Forest Green', hex: '#3d6347' },
  { id: 'slate_blue', label: 'Slate Blue', hex: '#4a6b8a' },
  { id: 'deep_cobalt', label: 'Deep Cobalt', hex: '#2e4a78' },
  { id: 'soft_grey', label: 'Silver Mist', hex: '#77838f' },
] as const;

export type FacialHairStyle = 'none' | 'stubble' | 'goatee' | 'full_beard';

export const FACIAL_HAIR_STYLES: readonly { readonly id: FacialHairStyle; readonly label: string }[] = [
  { id: 'none', label: 'Clean Shaven' },
  { id: 'stubble', label: 'Light Stubble' },
  { id: 'goatee', label: 'Trimmed Goatee' },
  { id: 'full_beard', label: 'Full Beard' },
] as const;

export interface FaceMakeupState {
  browThickness: number;
  browDarkness: number;
  lipColor: string;
  lipOpacity: number;
  blushColor: string;
  blushIntensity: number;
  freckleDensity: number;
  facialHair: FacialHairStyle;
}

export function defaultFaceMakeup(hero: Hero = 'LYRA'): FaceMakeupState {
  return {
    browThickness: hero === 'KAI' ? 0.62 : 0.48,
    browDarkness: 0.55,
    lipColor: hero === 'KAI' ? '#b8766a' : '#c76e70',
    lipOpacity: hero === 'KAI' ? 0.14 : 0.34,
    blushColor: '#d9847c',
    blushIntensity: hero === 'KAI' ? 0.05 : 0.18,
    freckleDensity: 0,
    facialHair: 'none',
  };
}

// ── 3. Body Proportions (6 Sliders + 5 Presets) ──────────────────────────────────────────────────────────

export type BodySliderKey =
  | 'heightScale'
  | 'buildScale'
  | 'shoulderWidth'
  | 'legRatio'
  | 'torsoDepth'
  | 'hipWidth';

export interface BodySliderDef {
  readonly key: BodySliderKey;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly defaultValue: number;
}

export const BODY_SLIDER_DEFS: readonly BodySliderDef[] = [
  { key: 'heightScale', label: 'Height', min: 0.88, max: 1.12, step: 0.01, defaultValue: 1.0 },
  { key: 'buildScale', label: 'Overall Build', min: 0.88, max: 1.16, step: 0.01, defaultValue: 1.0 },
  { key: 'shoulderWidth', label: 'Shoulder Width', min: 0.88, max: 1.15, step: 0.01, defaultValue: 1.0 },
  { key: 'legRatio', label: 'Leg Length Ratio', min: 0.92, max: 1.08, step: 0.01, defaultValue: 1.0 },
  { key: 'torsoDepth', label: 'Torso Depth', min: 0.90, max: 1.14, step: 0.01, defaultValue: 1.0 },
  { key: 'hipWidth', label: 'Hip Width', min: 0.90, max: 1.14, step: 0.01, defaultValue: 1.0 },
] as const;

export type BodyProportions = Record<BodySliderKey, number>;

export interface BodyPreset {
  readonly id: string;
  readonly label: string;
  readonly values: BodyProportions;
}

export const BODY_PRESETS: readonly BodyPreset[] = [
  {
    id: 'balanced',
    label: 'Balanced',
    values: { heightScale: 1.0, buildScale: 1.0, shoulderWidth: 1.0, legRatio: 1.0, torsoDepth: 1.0, hipWidth: 1.0 },
  },
  {
    id: 'slender',
    label: 'Slender',
    values: { heightScale: 1.01, buildScale: 0.91, shoulderWidth: 0.94, legRatio: 1.03, torsoDepth: 0.92, hipWidth: 0.93 },
  },
  {
    id: 'athletic',
    label: 'Athletic',
    values: { heightScale: 1.03, buildScale: 1.08, shoulderWidth: 1.11, legRatio: 1.02, torsoDepth: 1.06, hipWidth: 1.01 },
  },
  {
    id: 'tall',
    label: 'Tall',
    values: { heightScale: 1.10, buildScale: 0.98, shoulderWidth: 1.03, legRatio: 1.06, torsoDepth: 0.98, hipWidth: 0.99 },
  },
  {
    id: 'petite',
    label: 'Petite',
    values: { heightScale: 0.91, buildScale: 0.93, shoulderWidth: 0.92, legRatio: 0.96, torsoDepth: 0.94, hipWidth: 0.95 },
  },
] as const;

export function defaultBodyProportions(): BodyProportions {
  return { ...BODY_PRESETS[0].values };
}

export interface ResolvedCreatorProportions {
  /** Sanitized slider values clamped to canonical CAZ ranges. */
  readonly sanitized: BodyProportions;
  /** True when all 6 sliders equal 1.000 (fast O(1) identity path). */
  readonly isIdentity: boolean;
  /** Uniform stature multiplier applied exclusively at the model root (`sx === sy === sz`). */
  readonly uniformRootScale: number;
  /** Strict unit local bone scale `[1, 1, 1]` enforced on every bone so child rotations have `0.0000` 3D shear. */
  readonly boneScale: readonly [1, 1, 1];
  /** Rest-pose joint length/offset multipliers paired with private `boneInverses`. */
  readonly legLengthScale: number;
  readonly torsoLengthScale: number;
  readonly shoulderSpanScale: number;
  readonly hipSpanScale: number;
  readonly torsoDepthScale: number;
  readonly buildGirthDelta: number;
}

/**
 * Resolves CAZ `BodyProportions` into a guaranteed shear-free skeletal plan:
 *  - Every bone in the hierarchy (`hips`, `spine`, `chest`, `shoulder.L/R`, `upper_arm.L/R`,
 *    `forearm.L/R`, `fore_twist.L/R`, `hand.L/R`, legs) keeps exact unit local scale `[1, 1, 1]`,
 *    eliminating non-uniform parent-scale shear (`RS != SR`) under arm swing, rapid turns, and IK holds.
 *  - Stature (`heightScale`) scales the model root uniformly, while limb/shoulder/hip/torso adjustments
 *    map strictly to rest-pose joint translations and private `boneInverses`.
 */
export function resolveCreatorProportions(
  raw: Partial<BodyProportions> | null | undefined,
): ResolvedCreatorProportions {
  const sanitized = defaultBodyProportions();
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const def of BODY_SLIDER_DEFS) {
    const v = src[def.key];
    sanitized[def.key] =
      typeof v === 'number' && Number.isFinite(v)
        ? Math.round(Math.min(def.max, Math.max(def.min, v)) * 100) / 100
        : def.defaultValue;
  }
  const legLengthScale = 1 + (sanitized.legRatio - 1) * 0.85;
  const torsoLengthScale = 1 - (legLengthScale - 1) * 0.28;
  const buildGirthDelta = sanitized.buildScale - 1;
  const shoulderSpanScale = 1 + (sanitized.shoulderWidth - 1) * 0.65 + buildGirthDelta * 0.16;
  const hipSpanScale = 1 + (sanitized.hipWidth - 1) * 0.65 + buildGirthDelta * 0.18;
  const torsoDepthScale = 1 + (sanitized.torsoDepth - 1) * 0.65 + buildGirthDelta * 0.35;
  const isIdentity =
    Math.abs(sanitized.heightScale - 1) < 1e-4 &&
    Math.abs(sanitized.buildScale - 1) < 1e-4 &&
    Math.abs(sanitized.shoulderWidth - 1) < 1e-4 &&
    Math.abs(sanitized.legRatio - 1) < 1e-4 &&
    Math.abs(sanitized.torsoDepth - 1) < 1e-4 &&
    Math.abs(sanitized.hipWidth - 1) < 1e-4;
  return {
    sanitized,
    isIdentity,
    uniformRootScale: sanitized.heightScale,
    boneScale: [1, 1, 1],
    legLengthScale,
    torsoLengthScale,
    shoulderSpanScale,
    hipSpanScale,
    torsoDepthScale,
    buildGirthDelta,
  };
}

// ── 4. Hairstyles (8 Distinct Styles + 12 Curated Hair Colors + Ombre) ───────────────────────────────────

export type HairStyleId =
  | 'hair_ponytail'
  | 'hair_crop'
  | 'hair_bob'
  | 'hair_long_layered'
  | 'hair_side_braid'
  | 'hair_low_bun'
  | 'hair_curtain_wave'
  | 'hair_textured_curl';

export interface HairStyleDef {
  readonly id: HairStyleId;
  readonly label: string;
  readonly length: 'short' | 'medium' | 'long';
  readonly styleTag: string;
  readonly defaultHeroes: readonly Hero[];
  readonly supportsOmbre: boolean;
}

export const HAIR_CATALOG: readonly HairStyleDef[] = [
  { id: 'hair_ponytail', label: 'High Ponytail', length: 'long', styleTag: 'Active', defaultHeroes: ['LYRA'], supportsOmbre: true },
  { id: 'hair_crop', label: 'Textured Crop', length: 'short', styleTag: 'Modern', defaultHeroes: ['KAI'], supportsOmbre: true },
  { id: 'hair_bob', label: 'Classic Chin Bob', length: 'medium', styleTag: 'Chic', defaultHeroes: ['LYRA'], supportsOmbre: true },
  { id: 'hair_long_layered', label: 'Long Layered Flow', length: 'long', styleTag: 'Natural', defaultHeroes: ['LYRA'], supportsOmbre: true },
  { id: 'hair_side_braid', label: 'Woven Side Braid', length: 'long', styleTag: 'Artisan', defaultHeroes: ['LYRA'], supportsOmbre: true },
  { id: 'hair_low_bun', label: 'Studio Low Bun', length: 'medium', styleTag: 'Minimal', defaultHeroes: ['LYRA', 'KAI'], supportsOmbre: true },
  { id: 'hair_curtain_wave', label: 'Curtain Waves', length: 'medium', styleTag: 'Editorial', defaultHeroes: ['KAI', 'LYRA'], supportsOmbre: true },
  { id: 'hair_textured_curl', label: 'Textured Curls', length: 'short', styleTag: 'Expressive', defaultHeroes: ['KAI', 'LYRA'], supportsOmbre: true },
] as const;

export interface HairColorPreset {
  readonly id: string;
  readonly label: string;
  readonly hex: string;
}

export const HAIR_COLOR_PRESETS: readonly HairColorPreset[] = [
  { id: 'raven_black', label: 'Raven Black', hex: '#1e1b1e' },
  { id: 'espresso_roast', label: 'Espresso Roast', hex: '#34241c' },
  { id: 'plum_shadow', label: 'Plum Charcoal', hex: '#40303f' },
  { id: 'warm_chestnut', label: 'Warm Chestnut', hex: '#5a3a2a' },
  { id: 'cinnamon_brown', label: 'Cinnamon Brown', hex: '#7c4c34' },
  { id: 'auburn_copper', label: 'Autumn Copper', hex: '#98472e' },
  { id: 'honey_caramel', label: 'Honey Caramel', hex: '#b6844b' },
  { id: 'sunlit_blonde', label: 'Sunlit Blonde', hex: '#d8ba7c' },
  { id: 'ash_silver', label: 'Ash Silver', hex: '#9ea5b0' },
  { id: 'midnight_indigo', label: 'Midnight Indigo', hex: '#304378' },
  { id: 'wisteria_violet', label: 'Wisteria Violet', hex: '#6f5fc7' },
  { id: 'rosewood_berry', label: 'Rosewood Berry', hex: '#9c435a' },
] as const;

// ── 5. Full Layered Wardrobe Catalog ─────────────────────────────────────────────────────────────────────

export type OuterwearId =
  | 'none'
  | 'wool_overcoat'
  | 'puffer_parka'
  | 'trench_coat'
  | 'cardigan'
  | 'winter_scarf'
  | 'jacket'
  | 'hoodie';

export type AccessoryId =
  | 'glasses'
  | 'headphones'
  | 'cap'
  | 'sunglasses'
  | 'beanie'
  | 'backpack';

export type FabricId =
  | 'cotton'
  | 'denim'
  | 'knit'
  | 'fleece'
  | 'canvas'
  | 'leather'
  | 'wool'
  | 'puffer';

export type PatternId = 'solid' | 'stripe' | 'plaid' | 'heather';

export interface OuterwearDef {
  readonly id: OuterwearId;
  readonly label: string;
  readonly warmth: 0 | 1 | 2 | 3;
  readonly defaultFabric: FabricId;
  readonly defaultColor: string;
  readonly layerKind: 'none' | 'coat' | 'knit' | 'scarf' | 'shell';
}

export const OUTERWEAR_CATALOG: readonly OuterwearDef[] = [
  { id: 'none', label: 'No Outerwear', warmth: 0, defaultFabric: 'cotton', defaultColor: '#2f3a55', layerKind: 'none' },
  { id: 'wool_overcoat', label: 'Tailored Wool Overcoat', warmth: 3, defaultFabric: 'wool', defaultColor: '#3a3430', layerKind: 'coat' },
  { id: 'puffer_parka', label: 'Insulated Puffer Parka', warmth: 3, defaultFabric: 'puffer', defaultColor: '#294052', layerKind: 'coat' },
  { id: 'trench_coat', label: 'Belted Trench Coat', warmth: 2, defaultFabric: 'canvas', defaultColor: '#b39572', layerKind: 'coat' },
  { id: 'cardigan', label: 'Ribbed Knit Cardigan', warmth: 2, defaultFabric: 'knit', defaultColor: '#6f5d52', layerKind: 'knit' },
  { id: 'winter_scarf', label: 'Woven Winter Scarf', warmth: 2, defaultFabric: 'wool', defaultColor: '#9c3e49', layerKind: 'scarf' },
  { id: 'jacket', label: 'Campus Field Jacket', warmth: 2, defaultFabric: 'canvas', defaultColor: '#3d5146', layerKind: 'shell' },
  { id: 'hoodie', label: 'Zip Fleece Hoodie', warmth: 2, defaultFabric: 'fleece', defaultColor: '#48556e', layerKind: 'shell' },
] as const;

export interface AccessoryDef {
  readonly id: AccessoryId;
  readonly label: string;
  readonly slotKind: 'eyewear' | 'headwear' | 'audio' | 'bag';
  readonly weatherTag: 'all' | 'cold' | 'sunny';
  readonly isWave11: boolean;
}

export const ACCESSORY_CATALOG: readonly AccessoryDef[] = [
  { id: 'glasses', label: 'Studio Glasses', slotKind: 'eyewear', weatherTag: 'all', isWave11: false },
  { id: 'headphones', label: 'Over-Ear Headphones', slotKind: 'audio', weatherTag: 'all', isWave11: false },
  { id: 'cap', label: 'Campus Cap', slotKind: 'headwear', weatherTag: 'sunny', isWave11: false },
  { id: 'sunglasses', label: 'Polarized Sunglasses', slotKind: 'eyewear', weatherTag: 'sunny', isWave11: true },
  { id: 'beanie', label: 'Ribbed Knit Beanie', slotKind: 'headwear', weatherTag: 'cold', isWave11: true },
  { id: 'backpack', label: 'Canvas Daypack', slotKind: 'bag', weatherTag: 'all', isWave11: true },
] as const;

export interface FabricDef {
  readonly id: FabricId;
  readonly label: string;
  readonly roughness: number;
  readonly sheen: number;
  readonly warmth: 1 | 2 | 3;
}

export const FABRIC_CATALOG: readonly FabricDef[] = [
  { id: 'cotton', label: 'Brushed Cotton', roughness: FABRICS.cotton.roughness, sheen: FABRICS.cotton.sheen, warmth: 1 },
  { id: 'denim', label: 'Selvedge Denim', roughness: FABRICS.denim.roughness, sheen: FABRICS.denim.sheen, warmth: 2 },
  { id: 'knit', label: 'Soft Ribbed Knit', roughness: FABRICS.knit.roughness, sheen: FABRICS.knit.sheen, warmth: 2 },
  { id: 'fleece', label: 'Cozy Fleece', roughness: FABRICS.fleece.roughness, sheen: FABRICS.fleece.sheen, warmth: 3 },
  { id: 'canvas', label: 'Woven Canvas', roughness: FABRICS.canvas.roughness, sheen: FABRICS.canvas.sheen, warmth: 2 },
  { id: 'leather', label: 'Supple Leather', roughness: FABRICS.leather.roughness, sheen: FABRICS.leather.sheen, warmth: 2 },
  { id: 'wool', label: 'Melton Wool', roughness: 0.91, sheen: 0.68, warmth: 3 },
  { id: 'puffer', label: 'Quilted Ripstop Puffer', roughness: 0.42, sheen: 0.28, warmth: 3 },
] as const;

export interface PatternDef {
  readonly id: PatternId;
  readonly label: string;
}

export const PATTERN_CATALOG: readonly PatternDef[] = [
  { id: 'solid', label: 'Solid Tone' },
  { id: 'stripe', label: 'Fine Stripe' },
  { id: 'plaid', label: 'Heritage Plaid' },
  { id: 'heather', label: 'Heathered Weave' },
] as const;

export interface HeroGarmentOption {
  readonly id: string;
  readonly label: string;
  readonly slot: WardrobeItem['slot'];
  readonly defaultFabric: FabricId;
  readonly url: string;
}

export function getGarmentCatalogForHero(hero: Hero): {
  tops: HeroGarmentOption[];
  bottoms: HeroGarmentOption[];
  shoes: HeroGarmentOption[];
  outerwear: readonly OuterwearDef[];
  accessories: readonly AccessoryDef[];
} {
  const rawItems = Object.values(WARDROBE[hero].items);
  const toOption = (item: WardrobeItem): HeroGarmentOption => ({
    id: item.id,
    label: item.en ?? item.id,
    slot: item.slot,
    defaultFabric: isFabricId(item.fabric) ? item.fabric : 'cotton',
    url: item.url,
  });
  return {
    tops: rawItems.filter(i => i.slot === 'top' || i.slot === 'dress').map(toOption),
    bottoms: rawItems.filter(i => i.slot === 'bottom').map(toOption),
    shoes: rawItems.filter(i => i.slot === 'shoes').map(toOption),
    outerwear: OUTERWEAR_CATALOG,
    accessories: ACCESSORY_CATALOG,
  };
}

// ── 6. 8 Outfit Slots + Automatic Seasonal Outfit Selection ──────────────────────────────────────────────

export type OutfitSlotId =
  | 'everyday'
  | 'formal'
  | 'sleepwear'
  | 'party'
  | 'sportswear'
  | 'swimwear'
  | 'cold_weather'
  | 'hot_weather';

export interface OutfitSlotDef {
  readonly id: OutfitSlotId;
  readonly label: string;
  readonly summary: string;
}

export const OUTFIT_SLOTS: readonly OutfitSlotDef[] = [
  { id: 'everyday', label: 'Everyday', summary: 'Balanced daily attire for campus, markets, and neighborhood walks.' },
  { id: 'formal', label: 'Formal', summary: 'Tailored attire for seminars, showcases, and evening recitals.' },
  { id: 'sleepwear', label: 'Sleepwear', summary: 'Relaxed loungewear for late-night rest and slow mornings.' },
  { id: 'party', label: 'Party', summary: 'Expressive evening outfit for festivals and boardwalk gatherings.' },
  { id: 'sportswear', label: 'Sportswear', summary: 'Breathable activewear for basketball, jogging, and cycling.' },
  { id: 'swimwear', label: 'Swimwear', summary: 'Light waterside attire for sunny riverfront days.' },
  { id: 'cold_weather', label: 'Cold Weather', summary: 'Insulated winter outerwear, boots, and warm layers for snow and chill.' },
  { id: 'hot_weather', label: 'Hot Weather', summary: 'Airy summer staples built for sunlit afternoons.' },
] as const;

export interface OutfitSlotConfig {
  outerwear: OuterwearId;
  top: string;
  bottom: string;
  shoes: string;
  accessories: AccessoryId[];
  colors: {
    outerwear: string;
    top: string;
    bottom: string;
    shoes: string;
    accessory: string;
  };
  fabrics: {
    outerwear: FabricId;
    top: FabricId;
    bottom: FabricId;
    shoes: FabricId;
  };
  patterns: {
    outerwear: PatternId;
    top: PatternId;
    bottom: PatternId;
    shoes: PatternId;
  };
}

export function defaultOutfitSlotConfig(hero: Hero, slot: OutfitSlotId): OutfitSlotConfig {
  const isLyra = hero === 'LYRA';
  switch (slot) {
    case 'formal':
      return {
        outerwear: 'trench_coat',
        top: isLyra ? 'dress' : 'shirt',
        bottom: isLyra ? SIGNATURE : 'chinos',
        shoes: 'loafers',
        accessories: ['glasses'],
        colors: { outerwear: '#b39572', top: isLyra ? '#2b3954' : '#f2efe9', bottom: '#2b2d38', shoes: '#473226', accessory: '#3b3f55' },
        fabrics: { outerwear: 'canvas', top: 'cotton', bottom: 'canvas', shoes: 'leather' },
        patterns: { outerwear: 'solid', top: 'solid', bottom: 'solid', shoes: 'solid' },
      };
    case 'sleepwear':
      return {
        outerwear: 'none',
        top: 'tee',
        bottom: 'joggers',
        shoes: 'slippers',
        accessories: [],
        colors: { outerwear: '#4a5568', top: '#e9e6dc', bottom: '#6d84b4', shoes: '#d8c7a8', accessory: '#3b3f55' },
        fabrics: { outerwear: 'cotton', top: 'cotton', bottom: 'fleece', shoes: 'fleece' },
        patterns: { outerwear: 'solid', top: 'heather', bottom: 'stripe', shoes: 'solid' },
      };
    case 'party':
      return {
        outerwear: 'jacket',
        top: isLyra ? 'dress' : 'shirt',
        bottom: isLyra ? SIGNATURE : 'jeans',
        shoes: 'boots',
        accessories: ['headphones'],
        colors: { outerwear: '#2b2b30', top: isLyra ? '#a8485f' : '#2f3a55', bottom: '#2b2d38', shoes: '#2b2b30', accessory: '#e8b65e' },
        fabrics: { outerwear: 'leather', top: 'cotton', bottom: 'denim', shoes: 'leather' },
        patterns: { outerwear: 'solid', top: 'solid', bottom: 'solid', shoes: 'solid' },
      };
    case 'sportswear':
      return {
        outerwear: 'none',
        top: 'tee',
        bottom: 'shorts',
        shoes: 'sneakers',
        accessories: ['cap'],
        colors: { outerwear: '#2f3a55', top: '#4f8a6b', bottom: '#2b2b30', shoes: '#f2efe6', accessory: '#2f3a55' },
        fabrics: { outerwear: 'cotton', top: 'cotton', bottom: 'cotton', shoes: 'canvas' },
        patterns: { outerwear: 'solid', top: 'stripe', bottom: 'solid', shoes: 'solid' },
      };
    case 'swimwear':
      return {
        outerwear: 'none',
        top: 'tee',
        bottom: 'shorts',
        shoes: 'slippers',
        accessories: ['sunglasses'],
        colors: { outerwear: '#2f3a55', top: '#6d84b4', bottom: '#e8b65e', shoes: '#d8c7a8', accessory: '#2b2b30' },
        fabrics: { outerwear: 'cotton', top: 'cotton', bottom: 'cotton', shoes: 'fleece' },
        patterns: { outerwear: 'solid', top: 'stripe', bottom: 'solid', shoes: 'solid' },
      };
    case 'cold_weather':
      return {
        outerwear: isLyra ? 'wool_overcoat' : 'puffer_parka',
        top: 'knit',
        bottom: 'jeans',
        shoes: 'boots',
        accessories: ['beanie'],
        colors: {
          outerwear: isLyra ? '#594238' : '#294052',
          top: '#e9e4d9',
          bottom: '#2c3e5e',
          shoes: '#4f3526',
          accessory: '#9c3e49',
        },
        fabrics: {
          outerwear: isLyra ? 'wool' : 'puffer',
          top: 'knit',
          bottom: 'denim',
          shoes: 'leather',
        },
        patterns: { outerwear: 'solid', top: 'heather', bottom: 'solid', shoes: 'solid' },
      };
    case 'hot_weather':
      return {
        outerwear: 'none',
        top: 'tee',
        bottom: 'shorts',
        shoes: 'sneakers',
        accessories: ['sunglasses'],
        colors: { outerwear: '#b39572', top: '#f2efe9', bottom: '#6d84b4', shoes: '#f2efe6', accessory: '#2b2b30' },
        fabrics: { outerwear: 'cotton', top: 'cotton', bottom: 'cotton', shoes: 'canvas' },
        patterns: { outerwear: 'solid', top: 'solid', bottom: 'solid', shoes: 'solid' },
      };
    case 'everyday':
    default:
      return {
        outerwear: 'none',
        top: isLyra ? 'longsleeve' : 'hoodie',
        bottom: isLyra ? 'jeans' : 'chinos',
        shoes: 'sneakers',
        accessories: ['backpack'],
        colors: {
          outerwear: '#3d5146',
          top: isLyra ? '#2f3a55' : '#3f6152',
          bottom: isLyra ? '#2c3e5e' : '#b49a78',
          shoes: '#f2efe6',
          accessory: '#5a4638',
        },
        fabrics: { outerwear: 'canvas', top: isLyra ? 'cotton' : 'fleece', bottom: isLyra ? 'denim' : 'canvas', shoes: 'canvas' },
        patterns: { outerwear: 'solid', top: 'solid', bottom: 'solid', shoes: 'solid' },
      };
  }
}

export function defaultOutfitMap(hero: Hero): Record<OutfitSlotId, OutfitSlotConfig> {
  return {
    everyday: defaultOutfitSlotConfig(hero, 'everyday'),
    formal: defaultOutfitSlotConfig(hero, 'formal'),
    sleepwear: defaultOutfitSlotConfig(hero, 'sleepwear'),
    party: defaultOutfitSlotConfig(hero, 'party'),
    sportswear: defaultOutfitSlotConfig(hero, 'sportswear'),
    swimwear: defaultOutfitSlotConfig(hero, 'swimwear'),
    cold_weather: defaultOutfitSlotConfig(hero, 'cold_weather'),
    hot_weather: defaultOutfitSlotConfig(hero, 'hot_weather'),
  };
}

// ── 7. Personality Traits (18), Desired Lives (16), Values (8), Preferences (16) ─────────────────────────

export interface TraitDef {
  readonly id: string;
  readonly label: string;
  readonly archetype: string;
  readonly summary: string;
  readonly emotionBias: string;
  readonly urgeTags: readonly string[];
  readonly skillBoosts: readonly string[];
}

export const TRAIT_CATALOG: readonly TraitDef[] = [
  { id: 'charmer', label: 'Charmer', archetype: 'Social', summary: 'Warms up any room with effortless conversation and poise.', emotionBias: 'confident', urgeTags: ['social', 'bistro'], skillBoosts: ['rhetoric'] },
  { id: 'dreamer', label: 'Dreamer', archetype: 'Creative', summary: 'Finds inspiration in twilight skies, quiet rain, and stories.', emotionBias: 'inspired', urgeTags: ['photo', 'art'], skillBoosts: ['art', 'photography'] },
  { id: 'leader', label: 'Leader', archetype: 'Ambitious', summary: 'Steps forward calmly when a campus event needs direction.', emotionBias: 'confident', urgeTags: ['shift', 'social'], skillBoosts: ['rhetoric'] },
  { id: 'mediator', label: 'Mediator', archetype: 'Empathetic', summary: 'Listens patiently and turns rivalries into lasting friendships.', emotionBias: 'calm', urgeTags: ['social', 'garden'], skillBoosts: ['rhetoric'] },
  { id: 'entertainer', label: 'Entertainer', archetype: 'Social', summary: 'Brings rhythm, humor, and lively energy to every plaza.', emotionBias: 'playful', urgeTags: ['music', 'social'], skillBoosts: ['music'] },
  { id: 'volunteer', label: 'Volunteer', archetype: 'Empathetic', summary: 'Takes pride in leaving Riverside cleaner and kinder each day.', emotionBias: 'joyful', urgeTags: ['garden', 'home'], skillBoosts: ['gardening'] },
  { id: 'scholar', label: 'Scholar', archetype: 'Analytical', summary: 'Loves deep study sessions, archives, and structured mastery.', emotionBias: 'focused', urgeTags: ['study', 'bistro'], skillBoosts: ['rhetoric'] },
  { id: 'perfectionist', label: 'Perfectionist', archetype: 'Analytical', summary: 'Pursues crisp craftsmanship in cooking, design, and work.', emotionBias: 'focused', urgeTags: ['cook', 'shift'], skillBoosts: ['cooking', 'coffeeCraft'] },
  { id: 'sentinel', label: 'Sentinel', archetype: 'Grounded', summary: 'Dependable, punctual, and deeply loyal to neighbors.', emotionBias: 'calm', urgeTags: ['shift', 'home'], skillBoosts: ['fitness'] },
  { id: 'individualist', label: 'Individualist', archetype: 'Creative', summary: 'Values authentic self-expression and original style.', emotionBias: 'inspired', urgeTags: ['photo', 'music'], skillBoosts: ['art'] },
  { id: 'collaborator', label: 'Collaborator', archetype: 'Social', summary: 'Thrives when building shared projects with friends.', emotionBias: 'joyful', urgeTags: ['social', 'shift'], skillBoosts: ['rhetoric'] },
  { id: 'explorer', label: 'Explorer', archetype: 'Adventurous', summary: 'Always curious about hidden lanes, parks, and overlooks.', emotionBias: 'playful', urgeTags: ['bus', 'photo'], skillBoosts: ['photography'] },
  { id: 'artisan', label: 'Artisan', archetype: 'Creative', summary: 'Delights in handmade meals, latte craft, and thoughtful decor.', emotionBias: 'cozy', urgeTags: ['cook', 'bistro'], skillBoosts: ['cooking', 'coffeeCraft'] },
  { id: 'athlete', label: 'Athlete', archetype: 'Adventurous', summary: 'Energized by pickup basketball, brisk jogs, and river cycling.', emotionBias: 'playful', urgeTags: ['sport', 'bus'], skillBoosts: ['fitness'] },
  { id: 'minimalist', label: 'Minimalist', archetype: 'Grounded', summary: 'Finds clarity in calm interiors, warm tea, and clean spaces.', emotionBias: 'calm', urgeTags: ['home', 'garden'], skillBoosts: ['gardening'] },
  { id: 'bon_vivant', label: 'Bon Vivant', archetype: 'Expressive', summary: 'Savors great food, seasonal fairs, and festive nights out.', emotionBias: 'joyful', urgeTags: ['bistro', 'cook'], skillBoosts: ['cooking'] },
  { id: 'strategist', label: 'Strategist', archetype: 'Analytical', summary: 'Balances career climbs, savings, and long-term goals cleanly.', emotionBias: 'focused', urgeTags: ['shift', 'study'], skillBoosts: ['rhetoric'] },
  { id: 'night_owl', label: 'Night Owl', archetype: 'Expressive', summary: 'Does best creative thinking once lantern street glows at dusk.', emotionBias: 'cozy', urgeTags: ['music', 'study'], skillBoosts: ['music', 'coffeeCraft'] },
] as const;

export interface DesiredLifeDef {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  readonly primarySkill: string;
  readonly urgeTags: readonly string[];
  readonly milestones: readonly [string, string, string];
}

export const DESIRED_LIFE_CATALOG: readonly DesiredLifeDef[] = [
  { id: 'creative_icon', label: 'Creative Icon', summary: 'Shape Riverside culture through painting, music, and photography.', primarySkill: 'art', urgeTags: ['photo', 'music'], milestones: ['Capture 3 neighborhood photos', 'Reach Art or Music Lv. 4', 'Host an Atelier showcase evening'] },
  { id: 'campus_leader', label: 'Campus Leader', summary: 'Unite students across University Green and build civic harmony.', primarySkill: 'rhetoric', urgeTags: ['social', 'study'], milestones: ['Befriend 5 named residents', 'Complete 3 campus shifts', 'Reach Radiant Citizen Karma'] },
  { id: 'culinary_host', label: 'Culinary Host', summary: 'Master every home recipe and gather neighbors around warm meals.', primarySkill: 'cooking', urgeTags: ['cook', 'bistro'], milestones: ['Cook 5 distinct home recipes', 'Reach Cooking Lv. 5', 'Earn Master Barista recognition'] },
  { id: 'tech_architect', label: 'Tech Architect', summary: 'Build a flagship creator studio and climb the developer track.', primarySkill: 'rhetoric', urgeTags: ['study', 'shift'], milestones: ['Complete 5 tech shifts', 'Earn a full-time promotion', 'Upgrade your home workstation'] },
  { id: 'botanical_keeper', label: 'Botanical Keeper', summary: 'Nurture thriving herb gardens and calm tea rituals across town.', primarySkill: 'gardening', urgeTags: ['garden', 'bistro'], milestones: ['Tend the Botanical Garden 4 times', 'Reach Gardening Lv. 5', 'Brew Jasmine Honey Tea at home'] },
  { id: 'social_butterfly', label: 'Social Butterfly', summary: 'Know every resident by heart and keep Campus Feed buzzing.', primarySkill: 'rhetoric', urgeTags: ['social', 'bistro'], milestones: ['Message 6 different residents', 'Host 3 accepted hangouts', 'Earn 80 Recognition'] },
  { id: 'wealth_builder', label: 'Wealth Builder', summary: 'Grow smart career earnings into a dream Riverside residence.', primarySkill: 'rhetoric', urgeTags: ['shift', 'home'], milestones: ['Reach Associate rank in 2 jobs', 'Save 2,000 Campus Credits', 'Acquire an upgraded residence'] },
  { id: 'athletic_star', label: 'Athletic Star', summary: 'Own the Riverside court and inspire morning runners daily.', primarySkill: 'fitness', urgeTags: ['sport', 'bus'], milestones: ['Score a 3-basket court streak', 'Reach Fitness Lv. 5', 'Ride the full Riverside shuttle loop'] },
  { id: 'quiet_scholar', label: 'Quiet Scholar', summary: 'Spend serene afternoons mastering archives and deep focus.', primarySkill: 'rhetoric', urgeTags: ['study', 'bistro'], milestones: ['Complete 4 Library shifts', 'Reach Rhetoric Lv. 5', 'Maintain Focused emotion through study'] },
  { id: 'street_photographer', label: 'Street Photographer', summary: 'Document all four seasons and hidden lanes in your Photo Album.', primarySkill: 'photography', urgeTags: ['photo', 'bus'], milestones: ['Save 6 Photo Studio shots', 'Reach Photography Lv. 5', 'Share a milestone photo on Campus Feed'] },
  { id: 'acoustic_busker', label: 'Acoustic Storyteller', summary: 'Fill Old Campus Fountain Court with unforgettable twilight chords.', primarySkill: 'music', urgeTags: ['music', 'social'], milestones: ['Complete 3 Busker sets', 'Reach Music Lv. 5', 'Jam alongside Hai Dang'] },
  { id: 'style_curator', label: 'Style Curator', summary: 'Craft signature looks for every season and unlock boutique collections.', primarySkill: 'art', urgeTags: ['home', 'social'], milestones: ['Customize 4 outfit slots', 'Unlock boutique outfits', 'Coordinate a winter overcoat look'] },
  { id: 'helpful_neighbor', label: 'Helpful Neighbor', summary: 'Lift City Karma through kindness, tidy spaces, and reliable favors.', primarySkill: 'gardening', urgeTags: ['home', 'social'], milestones: ['Reach Kind Heart Karma tier', 'Keep City Cleanliness above 85', 'Resolve 3 workplace dilemmas kindly'] },
  { id: 'peaceful_minimalist', label: 'Peaceful Minimalist', summary: 'Cultivate balanced needs, restorative rest, and tranquil spaces.', primarySkill: 'gardening', urgeTags: ['home', 'cook'], milestones: ['Keep all 8 needs above 65', 'Enjoy Rain-Cozy tea indoors', 'Reach Designer Sanctuary comfort'] },
  { id: 'urban_explorer', label: 'Urban Explorer', summary: 'Travel every district from Botanical Garden to Lantern Tea Garden.', primarySkill: 'photography', urgeTags: ['bus', 'photo'], milestones: ['Visit all 6 shuttle bus stops', 'Discover hidden districts', 'Log 4 travel snapshots'] },
  { id: 'master_barista', label: 'Master Barista', summary: 'Perfect espresso craft and warm hospitality at Willow Bistro.', primarySkill: 'coffeeCraft', urgeTags: ['bistro', 'shift'], milestones: ['Complete 5 Barista shifts', 'Reach Coffee Craft Lv. 5', 'Order every item on the Bistro menu'] },
] as const;

export interface ValueDef {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
}

export const VALUES_CATALOG: readonly ValueDef[] = [
  { id: 'community', label: 'Community', summary: 'Believes strong neighborhoods grow from small daily kindnesses.' },
  { id: 'creativity', label: 'Creativity', summary: 'Treats everyday study, food, and style as expressive craft.' },
  { id: 'knowledge', label: 'Knowledge', summary: 'Stays curious and seeks depth in every conversation.' },
  { id: 'wellness', label: 'Wellness', summary: 'Prioritizes movement, fresh food, and restorative sleep.' },
  { id: 'craftsmanship', label: 'Craftsmanship', summary: 'Takes pride in finishing every shift and project properly.' },
  { id: 'independence', label: 'Independence', summary: 'Builds self-reliance through steady work and smart planning.' },
  { id: 'kindness', label: 'Kindness', summary: 'Chooses empathy even under deadline pressure.' },
  { id: 'ambition', label: 'Ambition', summary: 'Sets clear milestones and celebrates steady career growth.' },
] as const;

export interface PreferenceDef {
  readonly id: string;
  readonly label: string;
  readonly category: 'Food' | 'Activity' | 'Weather' | 'Culture';
}

export const PREFERENCES_CATALOG: readonly PreferenceDef[] = [
  { id: 'matcha', label: 'Matcha Drinks', category: 'Food' },
  { id: 'espresso', label: 'Fresh Espresso', category: 'Food' },
  { id: 'cooking', label: 'Home Cooking', category: 'Food' },
  { id: 'rainy_days', label: 'Rainy Afternoons', category: 'Weather' },
  { id: 'snowfall', label: 'Winter Snowfall', category: 'Weather' },
  { id: 'basketball', label: 'Court Basketball', category: 'Activity' },
  { id: 'cycling', label: 'Riverside Cycling', category: 'Activity' },
  { id: 'gardening', label: 'Herb Gardening', category: 'Activity' },
  { id: 'photography', label: 'Street Photography', category: 'Culture' },
  { id: 'acoustic_music', label: 'Acoustic Music', category: 'Culture' },
  { id: 'fashion', label: 'Seasonal Fashion', category: 'Culture' },
  { id: 'reading', label: 'Quiet Libraries', category: 'Culture' },
  { id: 'pc_hardware', label: 'Custom PC Hardware', category: 'Activity' },
  { id: 'early_mornings', label: 'Early Sunrise Walks', category: 'Weather' },
  { id: 'late_nights', label: 'Lantern Lit Evenings', category: 'Weather' },
  { id: 'crowded_fairs', label: 'Lively Boardwalk Fairs', category: 'Culture' },
] as const;

export interface CharacterIdentityTraits {
  displayName: string;
  traitIds: string[];
  desiredLifeId: string;
  valueIds: string[];
  likes: string[];
  dislikes: string[];
}

export interface CharacterCreatorProfile {
  version: 2;
  hero: Hero;
  hairId: HairStyleId;
  hairColor: string;
  hairTipColor: string;
  hairTipMix: number;
  skinHex: string;
  irisHex: string;
  faceMorphs: FaceSculptWeights;
  makeup: FaceMakeupState;
  body: BodyProportions;
  activeOutfitSlot: OutfitSlotId;
  autoSeasonalOutfit: boolean;
  outfits: Record<OutfitSlotId, OutfitSlotConfig>;
  identity: CharacterIdentityTraits;
}

// ── 8. Lookup Sets, Default Factory, and 6 Curated Character Presets ────────────────────────────────────

const HAIR_SET = new Set<string>(HAIR_CATALOG.map(h => h.id));
const OUTERWEAR_SET = new Set<string>(OUTERWEAR_CATALOG.map(o => o.id));
const ACCESSORY_SET = new Set<string>(ACCESSORY_CATALOG.map(a => a.id));
const FABRIC_LIST: readonly FabricId[] = FABRIC_CATALOG.map(f => f.id);
const FABRIC_SET = new Set<string>(FABRIC_LIST);
const PATTERN_LIST: readonly PatternId[] = PATTERN_CATALOG.map(p => p.id);
const PATTERN_SET = new Set<string>(PATTERN_LIST);
const SLOT_SET = new Set<string>(OUTFIT_SLOTS.map(s => s.id));
const FACIAL_HAIR_SET = new Set<string>(FACIAL_HAIR_STYLES.map(f => f.id));
const TRAIT_SET = new Set<string>(TRAIT_CATALOG.map(t => t.id));
const DESIRED_SET = new Set<string>(DESIRED_LIFE_CATALOG.map(d => d.id));
const VALUE_SET = new Set<string>(VALUES_CATALOG.map(v => v.id));
const PREF_SET = new Set<string>(PREFERENCES_CATALOG.map(p => p.id));

export function createDefaultCreatorProfile(hero: Hero = 'LYRA'): CharacterCreatorProfile {
  const isLyra = hero === 'LYRA';
  return {
    version: 2,
    hero,
    hairId: isLyra ? 'hair_ponytail' : 'hair_crop',
    hairColor: isLyra ? '#40303f' : '#34241c',
    hairTipColor: isLyra ? '#6f5fc7' : '#5a3a2a',
    hairTipMix: 0,
    skinHex: SKIN_TONE[hero],
    irisHex: '#543524',
    faceMorphs: defaultFaceSculptWeights(),
    makeup: defaultFaceMakeup(hero),
    body: defaultBodyProportions(),
    activeOutfitSlot: 'everyday',
    autoSeasonalOutfit: true,
    outfits: defaultOutfitMap(hero),
    identity: {
      displayName: isLyra ? 'Lyra Chen' : 'Kai Nakamura',
      traitIds: isLyra ? ['dreamer', 'artisan', 'mediator'] : ['explorer', 'athlete', 'strategist'],
      desiredLifeId: isLyra ? 'creative_icon' : 'tech_architect',
      valueIds: isLyra ? ['creativity', 'community'] : ['knowledge', 'craftsmanship'],
      likes: isLyra ? ['matcha', 'photography', 'rainy_days'] : ['espresso', 'basketball', 'pc_hardware'],
      dislikes: isLyra ? ['crowded_fairs'] : ['early_mornings'],
    },
  };
}

/**
 * Transitions an active `CharacterCreatorProfile` cleanly between `LYRA` and `KAI`,
 * re-mapping hero-specific outfits, stock hair, facial hair/makeup defaults, and default display name
 * while preserving user-chosen skin/iris/hair colors, face sculpts, and body proportions.
 */
export function switchCreatorHero(
  prev: CharacterCreatorProfile,
  nextHero: Hero,
): CharacterCreatorProfile {
  const safePrev = sanitizeCreatorProfile(prev);
  if (safePrev.hero === nextHero) return safePrev;
  const heroDef = createDefaultCreatorProfile(nextHero);
  const oppositeStockHair: HairStyleId = nextHero === 'KAI' ? 'hair_ponytail' : 'hair_crop';
  const nextHairId: HairStyleId =
    safePrev.hairId === oppositeStockHair ? heroDef.hairId : safePrev.hairId;
  const freshMakeup = defaultFaceMakeup(nextHero);
  freshMakeup.freckleDensity = safePrev.makeup.freckleDensity;
  const prevDefaultName = safePrev.hero === 'LYRA' ? 'Lyra Chen' : 'Kai Nakamura';
  const nextDisplayName =
    safePrev.identity.displayName === prevDefaultName
      ? heroDef.identity.displayName
      : safePrev.identity.displayName;
  return sanitizeCreatorProfile(
    {
      ...safePrev,
      hero: nextHero,
      hairId: nextHairId,
      makeup: freshMakeup,
      outfits: defaultOutfitMap(nextHero),
      identity: {
        ...safePrev.identity,
        displayName: nextDisplayName,
      },
    },
    nextHero,
  );
}

export interface CharacterPreset {
  readonly id: string;
  readonly label: string;
  readonly tagline: string;
  readonly profile: CharacterCreatorProfile;
}

function buildPreset(
  id: string,
  label: string,
  tagline: string,
  hero: Hero,
  mutate: (p: CharacterCreatorProfile) => void,
): CharacterPreset {
  const profile = createDefaultCreatorProfile(hero);
  mutate(profile);
  return { id, label, tagline, profile: sanitizeCreatorProfile(profile) };
}

export const CHARACTER_PRESETS: readonly CharacterPreset[] = [
  buildPreset('lyra_riverside', 'Lyra Riverside', 'Warm architecture student with effortless campus style.', 'LYRA', p => {
    p.hairId = 'hair_long_layered';
    p.hairColor = '#34241c';
    p.hairTipColor = '#7c4c34';
    p.hairTipMix = 0.25;
    p.skinHex = '#d5a684';
    p.irisHex = '#543524';
    p.faceMorphs.sculpt_eastAsian = 0.32;
    p.faceMorphs.sculpt_eyeSize = 0.18;
    p.faceMorphs.sculpt_cheekFull = 0.14;
    p.faceMorphs.sculpt_mouthCorner = 0.22;
    p.identity = {
      displayName: 'Lyra Tran',
      traitIds: ['mediator', 'artisan', 'dreamer'],
      desiredLifeId: 'creative_icon',
      valueIds: ['community', 'creativity'],
      likes: ['matcha', 'rainy_days', 'photography'],
      dislikes: ['crowded_fairs'],
    };
  }),
  buildPreset('kai_studio', 'Kai Studio', 'Minimalist developer and night-owl rhythm gamer.', 'KAI', p => {
    p.hairId = 'hair_curtain_wave';
    p.hairColor = '#1e1b1e';
    p.skinHex = '#e0b796';
    p.irisHex = '#2f1f18';
    p.faceMorphs.sculpt_jawSharp = 0.28;
    p.faceMorphs.sculpt_eyeMonolid = 0.34;
    p.faceMorphs.sculpt_noseBridge = 0.18;
    p.body = { ...BODY_PRESETS[3].values };
    p.outfits.everyday.outerwear = 'jacket';
    p.outfits.everyday.colors.outerwear = '#2b2b30';
    p.outfits.everyday.accessories = ['headphones', 'backpack'];
    p.identity = {
      displayName: 'Kai Sato',
      traitIds: ['night_owl', 'strategist', 'individualist'],
      desiredLifeId: 'tech_architect',
      valueIds: ['knowledge', 'independence'],
      likes: ['espresso', 'pc_hardware', 'late_nights'],
      dislikes: ['early_mornings'],
    };
  }),
  buildPreset('lyra_winter_atelier', 'Winter Atelier', 'Layered wool overcoat palette built for snowy lanterns.', 'LYRA', p => {
    p.hairId = 'hair_side_braid';
    p.hairColor = '#98472e';
    p.hairTipColor = '#b6844b';
    p.hairTipMix = 0.35;
    p.skinHex = '#f0d4be';
    p.irisHex = '#3d6347';
    p.makeup.freckleDensity = 0.35;
    p.makeup.lipColor = '#b85058';
    p.makeup.lipOpacity = 0.45;
    p.activeOutfitSlot = 'cold_weather';
    p.outfits.cold_weather.outerwear = 'wool_overcoat';
    p.outfits.cold_weather.colors.outerwear = '#6b4739';
    p.outfits.cold_weather.patterns.outerwear = 'plaid';
    p.outfits.cold_weather.accessories = ['beanie', 'glasses'];
    p.identity = {
      displayName: 'Clara Park',
      traitIds: ['artisan', 'perfectionist', 'dreamer'],
      desiredLifeId: 'style_curator',
      valueIds: ['creativity', 'craftsmanship'],
      likes: ['snowfall', 'fashion', 'cooking'],
      dislikes: ['basketball'],
    };
  }),
  buildPreset('kai_athletic_court', 'Court Captain', 'Energetic runner and pickup basketball regular.', 'KAI', p => {
    p.hairId = 'hair_textured_curl';
    p.hairColor = '#1e1b1e';
    p.skinHex = '#8e593d';
    p.irisHex = '#2f1f18';
    p.makeup.facialHair = 'stubble';
    p.body = { ...BODY_PRESETS[2].values };
    p.faceMorphs.sculpt_jawWidth = 0.24;
    p.faceMorphs.sculpt_chinWidth = 0.16;
    p.faceMorphs.sculpt_mouthCorner = 0.28;
    p.activeOutfitSlot = 'sportswear';
    p.identity = {
      displayName: 'Devon Brooks',
      traitIds: ['athlete', 'entertainer', 'collaborator'],
      desiredLifeId: 'athletic_star',
      valueIds: ['wellness', 'community'],
      likes: ['basketball', 'cycling', 'early_mornings'],
      dislikes: ['reading'],
    };
  }),
  buildPreset('lyra_coffee_curator', 'Bistro Roaster', 'Warm hospitality specialist with vintage knit styling.', 'LYRA', p => {
    p.hairId = 'hair_bob';
    p.hairColor = '#5a3a2a';
    p.skinHex = '#ba8262';
    p.irisHex = '#8c5e2c';
    p.faceMorphs.sculpt_cheekFull = 0.22;
    p.faceMorphs.sculpt_lipFullness = 0.24;
    p.outfits.everyday.outerwear = 'cardigan';
    p.outfits.everyday.colors.outerwear = '#8c664a';
    p.outfits.everyday.patterns.outerwear = 'heather';
    p.outfits.everyday.accessories = ['glasses'];
    p.identity = {
      displayName: 'Maya Alvarez',
      traitIds: ['charmer', 'bon_vivant', 'volunteer'],
      desiredLifeId: 'master_barista',
      valueIds: ['kindness', 'craftsmanship'],
      likes: ['espresso', 'matcha', 'cooking'],
      dislikes: ['pc_hardware'],
    };
  }),
  buildPreset('kai_scholar_classic', 'Archive Fellow', 'Composed researcher with classic tailored layers.', 'KAI', p => {
    p.hairId = 'hair_low_bun';
    p.hairColor = '#40303f';
    p.skinHex = '#cb9578';
    p.irisHex = '#4a6b8a';
    p.faceMorphs.sculpt_browHeight = 0.16;
    p.faceMorphs.sculpt_noseLength = 0.12;
    p.makeup.facialHair = 'goatee';
    p.outfits.everyday.outerwear = 'trench_coat';
    p.outfits.everyday.top = 'shirt';
    p.outfits.everyday.bottom = 'chinos';
    p.outfits.everyday.shoes = 'loafers';
    p.outfits.everyday.accessories = ['glasses', 'backpack'];
    p.identity = {
      displayName: 'Julian Minh',
      traitIds: ['scholar', 'minimalist', 'sentinel'],
      desiredLifeId: 'quiet_scholar',
      valueIds: ['knowledge', 'wellness'],
      likes: ['reading', 'rainy_days', 'acoustic_music'],
      dislikes: ['crowded_fairs'],
    };
  }),
] as const;

// ── 9. Seasonal Outfit Resolution ────────────────────────────────────────────────────────────────────────

export type SeasonInput = 0 | 1 | 2 | 3 | 'spring' | 'summer' | 'autumn' | 'winter';

export interface ResolvedWeatherOutfit {
  readonly slotId: OutfitSlotId;
  readonly outfit: OutfitSlotConfig;
  readonly reason: 'manual' | 'winter_snow' | 'hot_weather';
}

function normalizeSeasonIndex(season: SeasonInput): 0 | 1 | 2 | 3 {
  if (season === 0 || season === 'spring') return 0;
  if (season === 1 || season === 'summer') return 1;
  if (season === 2 || season === 'autumn') return 2;
  return 3;
}

/**
 * Automatically chooses the appropriate seasonal outfit when `profile.autoSeasonalOutfit` is true.
 * Guarantees Cold Weather outerwear in Winter, Snow, or temperatures <= 8 C.
 */
export function resolveActiveOutfitForWeather(
  profile: CharacterCreatorProfile,
  season: SeasonInput,
  snow: boolean | number = false,
  tempC?: number,
): ResolvedWeatherOutfit {
  const safe = sanitizeCreatorProfile(profile);
  if (!safe.autoSeasonalOutfit) {
    return {
      slotId: safe.activeOutfitSlot,
      outfit: safe.outfits[safe.activeOutfitSlot],
      reason: 'manual',
    };
  }
  const seasonIdx = normalizeSeasonIndex(season);
  const isSnowing = typeof snow === 'boolean' ? snow : Number.isFinite(snow) && snow > 0.05;
  const isFreezing = typeof tempC === 'number' && Number.isFinite(tempC) && tempC <= 8;
  if (seasonIdx === 3 || isSnowing || isFreezing) {
    const coldOutfit = { ...safe.outfits.cold_weather };
    if (coldOutfit.outerwear === 'none') {
      coldOutfit.outerwear = safe.hero === 'LYRA' ? 'wool_overcoat' : 'puffer_parka';
    }
    return {
      slotId: 'cold_weather',
      outfit: coldOutfit,
      reason: 'winter_snow',
    };
  }
  const isHot = seasonIdx === 1 && (tempC === undefined || !Number.isFinite(tempC) || tempC >= 27);
  if (isHot && safe.activeOutfitSlot === 'everyday') {
    return {
      slotId: 'hot_weather',
      outfit: safe.outfits.hot_weather,
      reason: 'hot_weather',
    };
  }
  return {
    slotId: safe.activeOutfitSlot,
    outfit: safe.outfits[safe.activeOutfitSlot],
    reason: 'manual',
  };
}

// ── 10. Deterministic Randomizer ─────────────────────────────────────────────────────────────────────────

function seedToUint32(seed: number | string): number {
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    return (Math.floor(seed) ^ 0x9e3779b9) >>> 0;
  }
  const str = String(seed ?? 'echo');
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

function makePrng(seed: number | string): () => number {
  let a = seedToUint32(seed) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickOne<T>(arr: readonly T[], rnd: () => number): T {
  return arr[Math.floor(rnd() * arr.length) % arr.length];
}

function pickUnique<T>(arr: readonly T[], count: number, rnd: () => number): T[] {
  const pool = [...arr];
  const out: T[] = [];
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(rnd() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

const FIRST_NAMES_LYRA = ['Lyra', 'Clara', 'Maya', 'Nora', 'Hana', 'Iris', 'Elena', 'Sora'] as const;
const FIRST_NAMES_KAI = ['Kai', 'Devon', 'Julian', 'Leo', 'Owen', 'Noah', 'Soren', 'Theo'] as const;
const LAST_NAMES = ['Chen', 'Nakamura', 'Park', 'Alvarez', 'Brooks', 'Nguyen', 'Bennett', 'Kim'] as const;
const GARMENT_PALETTE = ['#f2efe9', '#2f3a55', '#6d84b4', '#a8485f', '#c99a5e', '#3f6152', '#594238', '#2b2b30'] as const;

export function randomizeProfile(seed: number | string, heroOverride?: Hero): CharacterCreatorProfile {
  const rnd = makePrng(seed);
  const hero: Hero = heroOverride === 'LYRA' || heroOverride === 'KAI' ? heroOverride : (rnd() < 0.5 ? 'LYRA' : 'KAI');
  const base = createDefaultCreatorProfile(hero);
  const hair = pickOne(HAIR_CATALOG, rnd);
  const hairColor = pickOne(HAIR_COLOR_PRESETS, rnd);
  const tipColor = pickOne(HAIR_COLOR_PRESETS, rnd);
  const skin = pickOne(SKIN_TONE_PRESETS, rnd);
  const iris = pickOne(IRIS_COLOR_PRESETS, rnd);

  base.hairId = hair.id;
  base.hairColor = hairColor.hex;
  base.hairTipColor = tipColor.hex;
  base.hairTipMix = rnd() < 0.35 ? roundStep(0.15 + rnd() * 0.45, 0.05) : 0;
  base.skinHex = skin.hex;
  base.irisHex = iris.hex;

  for (const def of FACE_MORPH_DEFS) {
    // Keep random faces realistic inside [-0.55, +0.55]
    const v = (rnd() - 0.5) * 1.1;
    base.faceMorphs[def.key] = roundStep(clamp(v, def.min, def.max), def.step);
  }

  base.makeup = {
    browThickness: roundStep(0.25 + rnd() * 0.55, 0.05),
    browDarkness: roundStep(0.3 + rnd() * 0.55, 0.05),
    lipColor: hero === 'LYRA' ? pickOne(['#c76e70', '#b85058', '#d48278', '#9e545c'], rnd) : '#b8766a',
    lipOpacity: roundStep(hero === 'LYRA' ? 0.15 + rnd() * 0.45 : rnd() * 0.2, 0.05),
    blushColor: '#d9847c',
    blushIntensity: roundStep(hero === 'LYRA' ? rnd() * 0.35 : rnd() * 0.12, 0.05),
    freckleDensity: rnd() < 0.3 ? roundStep(0.15 + rnd() * 0.45, 0.05) : 0,
    facialHair: hero === 'KAI' && rnd() < 0.35 ? pickOne(['stubble', 'goatee', 'full_beard'] as const, rnd) : 'none',
  };

  for (const def of BODY_SLIDER_DEFS) {
    const span = def.max - def.min;
    const v = def.min + span * (0.2 + rnd() * 0.6);
    base.body[def.key] = roundStep(clamp(v, def.min, def.max), def.step);
  }

  const catalog = getGarmentCatalogForHero(hero);
  const top = pickOne(catalog.tops, rnd);
  const bottom = top.slot === 'dress' ? SIGNATURE : pickOne(catalog.bottoms, rnd).id;
  const shoe = pickOne(catalog.shoes, rnd);
  const outer = pickOne(OUTERWEAR_CATALOG, rnd);
  const accCount = Math.floor(rnd() * 3);
  const acc = pickUnique(ACCESSORY_CATALOG, accCount, rnd).map(a => a.id);

  base.outfits.everyday = {
    outerwear: outer.id,
    top: top.id,
    bottom,
    shoes: shoe.id,
    accessories: acc,
    colors: {
      outerwear: pickOne(GARMENT_PALETTE, rnd),
      top: pickOne(GARMENT_PALETTE, rnd),
      bottom: pickOne(GARMENT_PALETTE, rnd),
      shoes: pickOne(GARMENT_PALETTE, rnd),
      accessory: pickOne(GARMENT_PALETTE, rnd),
    },
    fabrics: {
      outerwear: outer.defaultFabric,
      top: top.defaultFabric,
      bottom: 'denim',
      shoes: shoe.defaultFabric,
    },
    patterns: {
      outerwear: pickOne(PATTERN_CATALOG, rnd).id,
      top: pickOne(PATTERN_CATALOG, rnd).id,
      bottom: 'solid',
      shoes: 'solid',
    },
  };

  const traits = pickUnique(TRAIT_CATALOG, 3, rnd).map(t => t.id);
  const desired = pickOne(DESIRED_LIFE_CATALOG, rnd);
  const values = pickUnique(VALUES_CATALOG, 2, rnd).map(v => v.id);
  const prefPick = pickUnique(PREFERENCES_CATALOG, 5, rnd).map(p => p.id);
  const first = hero === 'LYRA' ? pickOne(FIRST_NAMES_LYRA, rnd) : pickOne(FIRST_NAMES_KAI, rnd);
  const last = pickOne(LAST_NAMES, rnd);

  base.identity = {
    displayName: `${first} ${last}`,
    traitIds: traits,
    desiredLifeId: desired.id,
    valueIds: values,
    likes: prefPick.slice(0, 3),
    dislikes: prefPick.slice(3, 5),
  };

  return sanitizeCreatorProfile(base);
}

// ── 11. Undo / Redo History Stack ────────────────────────────────────────────────────────────────────────

export interface CreatorHistoryStack {
  readonly past: readonly CharacterCreatorProfile[];
  readonly present: CharacterCreatorProfile;
  readonly future: readonly CharacterCreatorProfile[];
  readonly maxDepth: number;
}

function cloneProfile(profile: CharacterCreatorProfile): CharacterCreatorProfile {
  return JSON.parse(JSON.stringify(profile)) as CharacterCreatorProfile;
}

export function createHistory(initial: CharacterCreatorProfile, maxDepth = 40): CreatorHistoryStack {
  return {
    past: [],
    present: sanitizeCreatorProfile(initial),
    future: [],
    maxDepth: Math.max(1, Math.min(100, Math.floor(maxDepth))),
  };
}

export function pushHistory(stack: CreatorHistoryStack, next: CharacterCreatorProfile): CreatorHistoryStack {
  const cleanNext = sanitizeCreatorProfile(next);
  if (JSON.stringify(cleanNext) === JSON.stringify(stack.present)) return stack;
  const past = [...stack.past, cloneProfile(stack.present)];
  const trimmedPast = past.length > stack.maxDepth ? past.slice(past.length - stack.maxDepth) : past;
  return {
    past: trimmedPast,
    present: cleanNext,
    future: [],
    maxDepth: stack.maxDepth,
  };
}

export function undoHistory(stack: CreatorHistoryStack): CreatorHistoryStack {
  if (stack.past.length === 0) return stack;
  const prev = stack.past[stack.past.length - 1];
  return {
    past: stack.past.slice(0, -1),
    present: cloneProfile(prev),
    future: [cloneProfile(stack.present), ...stack.future].slice(0, stack.maxDepth),
    maxDepth: stack.maxDepth,
  };
}

export function redoHistory(stack: CreatorHistoryStack): CreatorHistoryStack {
  if (stack.future.length === 0) return stack;
  const next = stack.future[0];
  return {
    past: [...stack.past, cloneProfile(stack.present)].slice(-stack.maxDepth),
    present: cloneProfile(next),
    future: stack.future.slice(1),
    maxDepth: stack.maxDepth,
  };
}

export class CreatorHistory {
  private stack: CreatorHistoryStack;

  constructor(initial: CharacterCreatorProfile, maxDepth = 40) {
    this.stack = createHistory(initial, maxDepth);
  }

  get present(): CharacterCreatorProfile {
    return cloneProfile(this.stack.present);
  }

  get canUndo(): boolean {
    return this.stack.past.length > 0;
  }

  get canRedo(): boolean {
    return this.stack.future.length > 0;
  }

  get snapshot(): CreatorHistoryStack {
    return this.stack;
  }

  push(next: CharacterCreatorProfile): CharacterCreatorProfile {
    this.stack = pushHistory(this.stack, next);
    return this.present;
  }

  undo(): CharacterCreatorProfile {
    this.stack = undoHistory(this.stack);
    return this.present;
  }

  redo(): CharacterCreatorProfile {
    this.stack = redoHistory(this.stack);
    return this.present;
  }

  reset(profile: CharacterCreatorProfile): CharacterCreatorProfile {
    this.stack = createHistory(profile, this.stack.maxDepth);
    return this.present;
  }
}

// ── 12. Strict Sanitizer and Validator ───────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function roundStep(v: number, step: number): number {
  const inv = Math.round(1 / step);
  return Math.round(v * inv) / inv;
}

function numOr(v: unknown, fallback: number, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return clamp(v, lo, hi);
}

function hexOr(v: unknown, fallback: string): string {
  if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  return fallback.toLowerCase();
}

function isFabricId(v: unknown): v is FabricId {
  return typeof v === 'string' && FABRIC_SET.has(v);
}

function isPatternId(v: unknown): v is PatternId {
  return typeof v === 'string' && PATTERN_SET.has(v);
}

function isOuterwearId(v: unknown): v is OuterwearId {
  return typeof v === 'string' && OUTERWEAR_SET.has(v);
}

function isAccessoryId(v: unknown): v is AccessoryId {
  return typeof v === 'string' && ACCESSORY_SET.has(v);
}

function sanitizeDisplayName(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const cleaned = v
    .replace(/&/g, ' and ')
    .replace(/[^a-zA-Z0-9 '\-.]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
  return cleaned.length >= 2 ? cleaned : fallback;
}

export function sanitizeOutfitSlot(
  hero: Hero,
  slot: OutfitSlotId,
  raw: unknown,
): OutfitSlotConfig {
  const fallback = defaultOutfitSlotConfig(hero, slot);
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const items = WARDROBE[hero].items;

  const pickGarment = (val: unknown, allowedSlots: WardrobeItem['slot'][], def: string): string => {
    if (val === SIGNATURE) return SIGNATURE;
    if (typeof val === 'string' && items[val] && allowedSlots.includes(items[val].slot)) return val;
    return def;
  };

  const outerwear: OuterwearId = isOuterwearId(obj.outerwear) ? obj.outerwear : fallback.outerwear;
  const wearingFullCoat = outerwear !== 'none' && outerwear !== 'winter_scarf';

  let top = pickGarment(obj.top, ['top', 'dress'], fallback.top);
  let bottom = pickGarment(obj.bottom, ['bottom'], fallback.bottom);
  let shoes = pickGarment(obj.shoes, ['shoes'], fallback.shoes);

  // Enforce clothing geometry coupling rules matching look.ts (including breaking `signature` under layered coats
  // so `Runner_Body` straps, chest brooch, belt buckle, and calf-high adventure boots never bleed through overcoats!).
  if (top === SIGNATURE && (wearingFullCoat || bottom !== SIGNATURE || shoes !== SIGNATURE)) {
    top = wearingFullCoat && items.knit ? 'knit' : fallback.top !== SIGNATURE ? fallback.top : items.knit ? 'knit' : 'tee';
  }
  if (top !== SIGNATURE && items[top]?.slot === 'dress') {
    bottom = SIGNATURE;
  } else if (top !== SIGNATURE && bottom === SIGNATURE) {
    bottom = wearingFullCoat && items.chinos ? 'chinos' : fallback.bottom !== SIGNATURE ? fallback.bottom : items.chinos ? 'chinos' : 'jeans';
  }
  if (top !== SIGNATURE && shoes === SIGNATURE) {
    const coatShoe =
      wearingFullCoat && (outerwear === 'wool_overcoat' || outerwear === 'puffer_parka') && items.boots
        ? 'boots'
        : wearingFullCoat && outerwear === 'trench_coat' && items.loafers
          ? 'loafers'
          : null;
    shoes = coatShoe ?? (fallback.shoes !== SIGNATURE ? fallback.shoes : 'sneakers');
  }

  const rawAcc = Array.isArray(obj.accessories) ? obj.accessories : fallback.accessories;
  const accessories: AccessoryId[] = [];
  for (const a of rawAcc) {
    if (isAccessoryId(a) && !accessories.includes(a)) {
      accessories.push(a);
      if (accessories.length >= 4) break;
    }
  }

  const c = obj.colors && typeof obj.colors === 'object' ? (obj.colors as Record<string, unknown>) : {};
  const f = obj.fabrics && typeof obj.fabrics === 'object' ? (obj.fabrics as Record<string, unknown>) : {};
  const p = obj.patterns && typeof obj.patterns === 'object' ? (obj.patterns as Record<string, unknown>) : {};

  return {
    outerwear,
    top,
    bottom,
    shoes,
    accessories,
    colors: {
      outerwear: hexOr(c.outerwear, fallback.colors.outerwear),
      top: hexOr(c.top, fallback.colors.top),
      bottom: hexOr(c.bottom, fallback.colors.bottom),
      shoes: hexOr(c.shoes, fallback.colors.shoes),
      accessory: hexOr(c.accessory, fallback.colors.accessory),
    },
    fabrics: {
      outerwear: isFabricId(f.outerwear) ? f.outerwear : fallback.fabrics.outerwear,
      top: isFabricId(f.top) ? f.top : fallback.fabrics.top,
      bottom: isFabricId(f.bottom) ? f.bottom : fallback.fabrics.bottom,
      shoes: isFabricId(f.shoes) ? f.shoes : fallback.fabrics.shoes,
    },
    patterns: {
      outerwear: isPatternId(p.outerwear) ? p.outerwear : fallback.patterns.outerwear,
      top: isPatternId(p.top) ? p.top : fallback.patterns.top,
      bottom: isPatternId(p.bottom) ? p.bottom : fallback.patterns.bottom,
      shoes: isPatternId(p.shoes) ? p.shoes : fallback.patterns.shoes,
    },
  };
}

export function sanitizeCreatorProfile(raw: unknown, fallbackHero: Hero = 'LYRA'): CharacterCreatorProfile {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const hero: Hero = obj.hero === 'KAI' ? 'KAI' : obj.hero === 'LYRA' ? 'LYRA' : fallbackHero;
  const def = createDefaultCreatorProfile(hero);

  const hairId: HairStyleId =
    typeof obj.hairId === 'string' && HAIR_SET.has(obj.hairId)
      ? (obj.hairId as HairStyleId)
      : def.hairId;

  const rawMorphs = obj.faceMorphs && typeof obj.faceMorphs === 'object'
    ? (obj.faceMorphs as Record<string, unknown>)
    : {};
  const faceMorphs = defaultFaceSculptWeights();
  for (const m of FACE_MORPH_DEFS) {
    faceMorphs[m.key] = roundStep(numOr(rawMorphs[m.key], m.defaultValue, m.min, m.max), m.step);
  }

  const rawMakeup = obj.makeup && typeof obj.makeup === 'object'
    ? (obj.makeup as Record<string, unknown>)
    : {};
  const makeup: FaceMakeupState = {
    browThickness: roundStep(numOr(rawMakeup.browThickness, def.makeup.browThickness, 0, 1), 0.01),
    browDarkness: roundStep(numOr(rawMakeup.browDarkness, def.makeup.browDarkness, 0, 1), 0.01),
    lipColor: hexOr(rawMakeup.lipColor, def.makeup.lipColor),
    lipOpacity: roundStep(numOr(rawMakeup.lipOpacity, def.makeup.lipOpacity, 0, 1), 0.01),
    blushColor: hexOr(rawMakeup.blushColor, def.makeup.blushColor),
    blushIntensity: roundStep(numOr(rawMakeup.blushIntensity, def.makeup.blushIntensity, 0, 1), 0.01),
    freckleDensity: roundStep(numOr(rawMakeup.freckleDensity, def.makeup.freckleDensity, 0, 1), 0.01),
    facialHair:
      typeof rawMakeup.facialHair === 'string' && FACIAL_HAIR_SET.has(rawMakeup.facialHair)
        ? (rawMakeup.facialHair as FacialHairStyle)
        : def.makeup.facialHair,
  };

  const rawBody = obj.body && typeof obj.body === 'object'
    ? (obj.body as Record<string, unknown>)
    : {};
  const body = defaultBodyProportions();
  for (const b of BODY_SLIDER_DEFS) {
    body[b.key] = roundStep(numOr(rawBody[b.key], b.defaultValue, b.min, b.max), b.step);
  }

  const activeOutfitSlot: OutfitSlotId =
    typeof obj.activeOutfitSlot === 'string' && SLOT_SET.has(obj.activeOutfitSlot)
      ? (obj.activeOutfitSlot as OutfitSlotId)
      : def.activeOutfitSlot;

  const autoSeasonalOutfit =
    typeof obj.autoSeasonalOutfit === 'boolean' ? obj.autoSeasonalOutfit : def.autoSeasonalOutfit;

  const rawOutfits = obj.outfits && typeof obj.outfits === 'object'
    ? (obj.outfits as Record<string, unknown>)
    : {};
  const outfits = defaultOutfitMap(hero);
  for (const slotDef of OUTFIT_SLOTS) {
    outfits[slotDef.id] = sanitizeOutfitSlot(hero, slotDef.id, rawOutfits[slotDef.id]);
  }

  const rawId = obj.identity && typeof obj.identity === 'object'
    ? (obj.identity as Record<string, unknown>)
    : {};
  const filterUnique = (arr: unknown, set: ReadonlySet<string>, max: number, fallbackArr: readonly string[]): string[] => {
    if (!Array.isArray(arr)) return [...fallbackArr];
    const out: string[] = [];
    for (const item of arr) {
      if (typeof item === 'string' && set.has(item) && !out.includes(item)) {
        out.push(item);
        if (out.length >= max) break;
      }
    }
    return out.length > 0 ? out : [...fallbackArr];
  };

  const likes = filterUnique(rawId.likes, PREF_SET, 5, def.identity.likes);
  const likeSet = new Set(likes);
  const dislikes = filterUnique(rawId.dislikes, PREF_SET, 5, def.identity.dislikes).filter(d => !likeSet.has(d));

  const identity: CharacterIdentityTraits = {
    displayName: sanitizeDisplayName(rawId.displayName, def.identity.displayName),
    traitIds: filterUnique(rawId.traitIds, TRAIT_SET, 3, def.identity.traitIds),
    desiredLifeId:
      typeof rawId.desiredLifeId === 'string' && DESIRED_SET.has(rawId.desiredLifeId)
        ? rawId.desiredLifeId
        : def.identity.desiredLifeId,
    valueIds: filterUnique(rawId.valueIds, VALUE_SET, 3, def.identity.valueIds),
    likes,
    dislikes,
  };

  return {
    version: 2,
    hero,
    hairId,
    hairColor: hexOr(obj.hairColor, def.hairColor),
    hairTipColor: hexOr(obj.hairTipColor, def.hairTipColor),
    hairTipMix: roundStep(numOr(obj.hairTipMix, def.hairTipMix, 0, 1), 0.01),
    skinHex: hexOr(obj.skinHex, def.skinHex),
    irisHex: hexOr(obj.irisHex, def.irisHex),
    faceMorphs,
    makeup,
    body,
    activeOutfitSlot,
    autoSeasonalOutfit,
    outfits,
    identity,
  };
}

// ── 13. Compact V2 Wire Codec (<= 256 ASCII chars) + V1 Fallback ─────────────────────────────────────────

export const LOOK_V2_WIRE_MAX_LENGTH = 256;

/** Exact mirror of backend `AvatarLookCode.V2_SHAPE` for zero-drift multiplayer relay validation. */
export const BACKEND_V2_WIRE_REGEX =
  /^v2:[lk]:[a-z0-9_]{1,24}:[0-9a-f]{6}:[0-9a-f]{6}:[0-9a-f]{12}:[0-9a-f]{16,40}:[a-z0-9_.-]{1,140}$/;

export const LOOK_V2_WIRE_REGEX =
  /^v2:[lk]:[a-z0-9_]{1,24}:[0-9a-f]{6}:[0-9a-f]{6}:[0-9a-f]{12}:[0-9a-f]{20}:[a-z0-9_]{1,20}(\.[a-z0-9_]{1,16}){3}\.(-|[a-z0-9_]{1,16}([-+][a-z0-9_]{1,16}){0,3})(\.[0-9a-f]{6}){6}\.[a-z0-9_]{4,16}$/;

function quantizeByte(value: number, min: number, max: number): string {
  const norm = clamp((value - min) / (max - min), 0, 1);
  return Math.round(norm * 255).toString(16).padStart(2, '0');
}

function dequantizeByte(hex2: string, min: number, max: number, step: number): number {
  const byte = Number.parseInt(hex2, 16);
  if (!Number.isFinite(byte)) return roundStep((min + max) / 2, step);
  const val = min + (clamp(byte, 0, 255) / 255) * (max - min);
  return roundStep(clamp(val, min, max), step);
}

function packFabricAndPattern(outfit: OutfitSlotConfig): string {
  const layers: readonly ('outerwear' | 'top' | 'bottom' | 'shoes')[] = [
    'outerwear',
    'top',
    'bottom',
    'shoes',
  ];
  let hex = '';
  for (const layer of layers) {
    const fi = Math.max(0, FABRIC_LIST.indexOf(outfit.fabrics[layer]));
    const pi = Math.max(0, PATTERN_LIST.indexOf(outfit.patterns[layer]));
    hex += (fi & 0xf).toString(16) + (pi & 0xf).toString(16);
  }
  return hex;
}

function unpackFabricAndPattern(
  fabPack: string,
  fallback: OutfitSlotConfig,
): { fabrics: OutfitSlotConfig['fabrics']; patterns: OutfitSlotConfig['patterns'] } {
  if (!/^[0-9a-f]{8}$/i.test(fabPack)) {
    return { fabrics: { ...fallback.fabrics }, patterns: { ...fallback.patterns } };
  }
  const layers: readonly ('outerwear' | 'top' | 'bottom' | 'shoes')[] = [
    'outerwear',
    'top',
    'bottom',
    'shoes',
  ];
  const fabrics = { ...fallback.fabrics };
  const patterns = { ...fallback.patterns };
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const fi = Number.parseInt(fabPack[i * 2], 16);
    const pi = Number.parseInt(fabPack[i * 2 + 1], 16);
    if (fi >= 0 && fi < FABRIC_LIST.length) fabrics[layer] = FABRIC_LIST[fi];
    if (pi >= 0 && pi < PATTERN_LIST.length) patterns[layer] = PATTERN_LIST[pi];
  }
  return { fabrics, patterns };
}

/**
 * Encodes a CharacterCreatorProfile into the compact V2 ASCII wire format (<= 256 chars):
 * `v2:<l|k>:<hairId>:<skinHex6>:<irisHex6>:<body6Hex12>:<face10Hex20>:<outer>.<top>.<bot>.<shoe>.<acc>.<cOuter>.<cTop>.<cBot>.<cShoe>.<cHair>.<cAcc>.<fabPack>`
 */
export function encodeLookV2(
  profile: CharacterCreatorProfile,
  slotId?: OutfitSlotId,
): string {
  const safe = sanitizeCreatorProfile(profile);
  const slot = slotId && SLOT_SET.has(slotId) ? slotId : safe.activeOutfitSlot;
  const outfit = safe.outfits[slot];

  const heroToken = safe.hero === 'KAI' ? 'k' : 'l';
  const skinHex6 = safe.skinHex.slice(1);
  const irisHex6 = safe.irisHex.slice(1);

  let body6Hex12 = '';
  for (const def of BODY_SLIDER_DEFS) {
    body6Hex12 += quantizeByte(safe.body[def.key], def.min, def.max);
  }

  let face10Hex20 = '';
  for (const key of WIRE_V2_FACE_KEYS) {
    face10Hex20 += quantizeByte(safe.faceMorphs[key], -1, 1);
  }

  const accToken = outfit.accessories.length > 0 ? outfit.accessories.slice(0, 4).join('-') : '-';
  const fabPack = packFabricAndPattern(outfit);
  const outfitPart = [
    outfit.outerwear,
    outfit.top,
    outfit.bottom,
    outfit.shoes,
    accToken,
    outfit.colors.outerwear.slice(1),
    outfit.colors.top.slice(1),
    outfit.colors.bottom.slice(1),
    outfit.colors.shoes.slice(1),
    safe.hairColor.slice(1),
    outfit.colors.accessory.slice(1),
    fabPack,
  ].join('.');

  return `v2:${heroToken}:${safe.hairId}:${skinHex6}:${irisHex6}:${body6Hex12}:${face10Hex20}:${outfitPart}`;
}

/**
 * Decodes either a V2 wire string or a legacy V1 `encodeLook` wire string into a sanitized CharacterCreatorProfile.
 */
export function decodeLookV2(
  wire: string | null | undefined,
  fallbackHero: Hero = 'LYRA',
): CharacterCreatorProfile {
  if (!wire || typeof wire !== 'string') {
    return createDefaultCreatorProfile(fallbackHero);
  }

  // Legacy V1 fallback (9 dot-separated parts, <= 96 chars)
  if (!wire.startsWith('v2:')) {
    const legacy: AvatarLook = decodeLook(fallbackHero, wire);
    const base = createDefaultCreatorProfile(fallbackHero);
    base.hairColor = legacy.colors.hair;
    const validAcc = legacy.accessories.filter(isAccessoryId);
    base.outfits.everyday = sanitizeOutfitSlot(fallbackHero, 'everyday', {
      outerwear: 'none',
      top: legacy.top,
      bottom: legacy.bottom,
      shoes: legacy.shoes,
      accessories: validAcc,
      colors: {
        outerwear: base.outfits.everyday.colors.outerwear,
        top: legacy.colors.top,
        bottom: legacy.colors.bottom,
        shoes: legacy.colors.shoes,
        accessory: legacy.colors.accessory,
      },
    });
    return sanitizeCreatorProfile(base, fallbackHero);
  }

  if (wire.length > LOOK_V2_WIRE_MAX_LENGTH || !LOOK_V2_WIRE_REGEX.test(wire)) {
    return createDefaultCreatorProfile(fallbackHero);
  }

  const segments = wire.split(':');
  if (segments.length !== 8) {
    return createDefaultCreatorProfile(fallbackHero);
  }

  const [, heroToken, hairId, skinHex6, irisHex6, body6Hex12, face10Hex20, outfitStr] = segments;
  const hero: Hero = heroToken === 'k' ? 'KAI' : 'LYRA';
  const base = createDefaultCreatorProfile(hero);

  base.hairId = HAIR_SET.has(hairId) ? (hairId as HairStyleId) : base.hairId;
  base.skinHex = '#' + skinHex6;
  base.irisHex = '#' + irisHex6;

  for (let i = 0; i < BODY_SLIDER_DEFS.length; i++) {
    const def = BODY_SLIDER_DEFS[i];
    base.body[def.key] = dequantizeByte(body6Hex12.slice(i * 2, i * 2 + 2), def.min, def.max, def.step);
  }

  for (let i = 0; i < WIRE_V2_FACE_KEYS.length; i++) {
    const key = WIRE_V2_FACE_KEYS[i];
    base.faceMorphs[key] = dequantizeByte(face10Hex20.slice(i * 2, i * 2 + 2), -1, 1, 0.02);
  }

  const p = outfitStr.split('.');
  if (p.length === 12) {
    const [outer, top, bottom, shoes, accRaw, cOuter, cTop, cBot, cShoe, cHair, cAcc, fabPack] = p;
    base.hairColor = '#' + cHair;
    const { fabrics, patterns } = unpackFabricAndPattern(fabPack, base.outfits.everyday);
    base.outfits.everyday = sanitizeOutfitSlot(hero, 'everyday', {
      outerwear: outer,
      top,
      bottom,
      shoes,
      accessories: accRaw === '-' ? [] : accRaw.split(/[-+]/),
      colors: {
        outerwear: '#' + cOuter,
        top: '#' + cTop,
        bottom: '#' + cBot,
        shoes: '#' + cShoe,
        accessory: '#' + cAcc,
      },
      fabrics,
      patterns,
    });
  }

  return sanitizeCreatorProfile(base, hero);
}

/** Projects a CharacterCreatorProfile into a legacy V1 AvatarLook for shared 3D rooms. */
export function profileToAvatarLook(
  profile: CharacterCreatorProfile,
  slotId?: OutfitSlotId,
): AvatarLook {
  const safe = sanitizeCreatorProfile(profile);
  const slot = slotId && SLOT_SET.has(slotId) ? slotId : safe.activeOutfitSlot;
  const outfit = safe.outfits[slot];
  return normalizeLook(safe.hero, {
    outerwear: outfit.outerwear,
    top: outfit.top,
    bottom: outfit.bottom,
    shoes: outfit.shoes,
    accessories: outfit.accessories,
    colors: {
      top: outfit.colors.top,
      bottom: outfit.colors.bottom,
      shoes: outfit.colors.shoes,
      hair: safe.hairColor,
      accessory: outfit.colors.accessory,
    },
  });
}

export { defaultLook, SIGNATURE };
export type { AvatarLook, Hero };
