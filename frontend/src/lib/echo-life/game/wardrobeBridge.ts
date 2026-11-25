/**
 * Echo Life Wave 11 — Clothing Shop to Character Creator Wardrobe Bridge.
 *
 * Maps Echo Life `clothing_shop` SKUs (`runtime-catalog.json`), `ownedObjects`,
 * `progression.unlockedOutfits`, and legacy `s.outfits` directly onto Character Creator
 * unlocked garment IDs and curated outfit presets so every boutique purchase visibly
 * unlocks and equips on the player character across all 3D spaces.
 *
 * Zero V3 package edits, zero DOM/network dependencies, 100% clean English copy.
 */
import {
  SIGNATURE,
  sanitizeCreatorProfile,
  sanitizeOutfitSlot,
  type AccessoryId,
  type CharacterCreatorProfile,
  type Hero,
  type OutfitSlotConfig,
  type OutfitSlotId,
  type OuterwearId,
} from '../../avatar/characterCreator';

export interface ClothingSkuMapping {
  readonly sku: string;
  readonly outfitId: string;
  readonly name: string;
  readonly price: number;
  readonly description: string;
  readonly targetSlot: OutfitSlotId;
  readonly gameplayBonus: string | null;
  readonly unlockedGarments: {
    readonly outerwear: readonly OuterwearId[];
    readonly tops: readonly string[];
    readonly bottoms: readonly string[];
    readonly shoes: readonly string[];
    readonly accessories: readonly AccessoryId[];
  };
  readonly curatedPresetByHero: Readonly<Record<Hero, Partial<OutfitSlotConfig>>>;
}

/**
 * Starter garments always available on day 1 (including winter outerwear so
 * auto-seasonal Cold Weather clothing works immediately in winter and snow).
 */
export const STARTER_UNLOCKED_GARMENTS = {
  outerwear: ['none', 'wool_overcoat', 'puffer_parka', 'winter_scarf'] as readonly OuterwearId[],
  tops: [SIGNATURE, 'tee', 'longsleeve', 'knit'] as readonly string[],
  bottoms: [SIGNATURE, 'jeans', 'cargo'] as readonly string[],
  shoes: [SIGNATURE, 'sneakers', 'boots', 'slippers'] as readonly string[],
  accessories: ['beanie', 'backpack'] as readonly AccessoryId[],
} as const;

export const CLOTHING_SKU_MAPPINGS: readonly ClothingSkuMapping[] = [
  {
    sku: 'sku_outfit_student2',
    outfitId: 'student2',
    name: 'Campus Casual Outfit',
    price: 80,
    description: 'Relaxed campus field jacket, soft knit layering, and tailored chinos.',
    targetSlot: 'everyday',
    gameplayBonus: null,
    unlockedGarments: {
      outerwear: ['jacket', 'cardigan'],
      tops: ['shirt', 'knit'],
      bottoms: ['chinos'],
      shoes: ['sneakers', 'boots'],
      accessories: ['glasses', 'backpack'],
    },
    curatedPresetByHero: {
      LYRA: {
        outerwear: 'jacket',
        top: 'shirt',
        bottom: 'chinos',
        shoes: 'sneakers',
        accessories: ['glasses', 'backpack'],
        colors: {
          outerwear: '#3d5146',
          top: '#f2efe9',
          bottom: '#b49a78',
          shoes: '#f2efe6',
          accessory: '#3b3f55',
        },
        fabrics: { outerwear: 'canvas', top: 'cotton', bottom: 'canvas', shoes: 'canvas' },
        patterns: { outerwear: 'solid', top: 'stripe', bottom: 'solid', shoes: 'solid' },
      },
      KAI: {
        outerwear: 'jacket',
        top: 'longsleeve',
        bottom: 'chinos',
        shoes: 'sneakers',
        accessories: ['glasses', 'backpack'],
        colors: {
          outerwear: '#2f3a55',
          top: '#e9e6dc',
          bottom: '#6f5a4a',
          shoes: '#f2efe6',
          accessory: '#3b3f55',
        },
        fabrics: { outerwear: 'canvas', top: 'cotton', bottom: 'canvas', shoes: 'canvas' },
        patterns: { outerwear: 'solid', top: 'heather', bottom: 'solid', shoes: 'solid' },
      },
    },
  },
  {
    sku: 'sku_outfit_gemini',
    outfitId: 'gemini',
    name: 'Everyday Riverside Ensemble',
    price: 120,
    description: 'Tailored Riverside trench coat styling with refined footwear and studio poise.',
    targetSlot: 'formal',
    gameplayBonus: '+5% Recognition during campus seminars and social scenes',
    unlockedGarments: {
      outerwear: ['trench_coat', 'wool_overcoat', 'cardigan'],
      tops: ['dress', 'shirt', 'longsleeve'],
      bottoms: ['skirt', 'chinos'],
      shoes: ['loafers', 'boots'],
      accessories: ['glasses', 'sunglasses'],
    },
    curatedPresetByHero: {
      LYRA: {
        outerwear: 'trench_coat',
        top: 'dress',
        bottom: SIGNATURE,
        shoes: 'loafers',
        accessories: ['glasses'],
        colors: {
          outerwear: '#b39572',
          top: '#2f3a55',
          bottom: '#2c3e5e',
          shoes: '#473226',
          accessory: '#3b3f55',
        },
        fabrics: { outerwear: 'canvas', top: 'cotton', bottom: 'cotton', shoes: 'leather' },
        patterns: { outerwear: 'solid', top: 'solid', bottom: 'solid', shoes: 'solid' },
      },
      KAI: {
        outerwear: 'trench_coat',
        top: 'shirt',
        bottom: 'chinos',
        shoes: 'loafers',
        accessories: ['glasses'],
        colors: {
          outerwear: '#b39572',
          top: '#f2efe9',
          bottom: '#2b2d38',
          shoes: '#473226',
          accessory: '#3b3f55',
        },
        fabrics: { outerwear: 'canvas', top: 'cotton', bottom: 'canvas', shoes: 'leather' },
        patterns: { outerwear: 'solid', top: 'solid', bottom: 'solid', shoes: 'solid' },
      },
    },
  },
  {
    sku: 'sku_outfit_gemini_sport',
    outfitId: 'geminiSport',
    name: 'Active Track and Court Outfit',
    price: 150,
    description: 'Breathable athletic track top, performance joggers, and court-ready sneakers.',
    targetSlot: 'sportswear',
    gameplayBonus: '+10% Mobility XP while worn outdoors',
    unlockedGarments: {
      outerwear: ['hoodie', 'puffer_parka'],
      tops: ['hoodie', 'tee'],
      bottoms: ['joggers', 'shorts'],
      shoes: ['sneakers'],
      accessories: ['cap', 'sunglasses', 'headphones'],
    },
    curatedPresetByHero: {
      LYRA: {
        outerwear: 'none',
        top: 'hoodie',
        bottom: 'joggers',
        shoes: 'sneakers',
        accessories: ['cap', 'headphones'],
        colors: {
          outerwear: '#3f6152',
          top: '#4f8a6b',
          bottom: '#2b2b30',
          shoes: '#f2efe6',
          accessory: '#e8b65e',
        },
        fabrics: { outerwear: 'fleece', top: 'fleece', bottom: 'fleece', shoes: 'canvas' },
        patterns: { outerwear: 'solid', top: 'stripe', bottom: 'solid', shoes: 'solid' },
      },
      KAI: {
        outerwear: 'none',
        top: 'hoodie',
        bottom: 'joggers',
        shoes: 'sneakers',
        accessories: ['cap', 'headphones'],
        colors: {
          outerwear: '#2f3a55',
          top: '#2f3a55',
          bottom: '#37383f',
          shoes: '#f2efe6',
          accessory: '#c75b6a',
        },
        fabrics: { outerwear: 'fleece', top: 'fleece', bottom: 'fleece', shoes: 'canvas' },
        patterns: { outerwear: 'solid', top: 'stripe', bottom: 'solid', shoes: 'solid' },
      },
    },
  },
] as const;

const MAPPING_BY_KEY = new Map<string, ClothingSkuMapping>();
for (const entry of CLOTHING_SKU_MAPPINGS) {
  MAPPING_BY_KEY.set(entry.sku, entry);
  MAPPING_BY_KEY.set(entry.outfitId, entry);
}

export function findClothingMapping(skuOrOutfitId: string | null | undefined): ClothingSkuMapping | null {
  if (!skuOrOutfitId) return null;
  return MAPPING_BY_KEY.get(skuOrOutfitId) ?? null;
}

export interface UnlockedWardrobeSources {
  ownedObjects?: readonly { sku?: string; selectedVariantId?: string; category?: string }[] | null;
  ownedSkus?: readonly string[] | null;
  unlockedOutfits?: readonly string[] | null;
  legacyOutfits?: readonly string[] | null;
}

export interface UnlockedWardrobeSet {
  readonly unlockedSkus: ReadonlySet<string>;
  readonly unlockedOutfitIds: ReadonlySet<string>;
  readonly outerwear: ReadonlySet<OuterwearId>;
  readonly tops: ReadonlySet<string>;
  readonly bottoms: ReadonlySet<string>;
  readonly shoes: ReadonlySet<string>;
  readonly accessories: ReadonlySet<AccessoryId>;
  readonly unlockedPresets: readonly ClothingSkuMapping[];
}

export function resolveUnlockedWardrobe(sources: UnlockedWardrobeSources = {}): UnlockedWardrobeSet {
  const unlockedSkus = new Set<string>();
  const unlockedOutfitIds = new Set<string>(['student']);
  const outerwear = new Set<OuterwearId>(STARTER_UNLOCKED_GARMENTS.outerwear);
  const tops = new Set<string>(STARTER_UNLOCKED_GARMENTS.tops);
  const bottoms = new Set<string>(STARTER_UNLOCKED_GARMENTS.bottoms);
  const shoes = new Set<string>(STARTER_UNLOCKED_GARMENTS.shoes);
  const accessories = new Set<AccessoryId>(STARTER_UNLOCKED_GARMENTS.accessories);
  const matchedMappings = new Map<string, ClothingSkuMapping>();

  const registerKey = (key: string | undefined) => {
    if (!key) return;
    const mapping = findClothingMapping(key);
    if (!mapping) return;
    unlockedSkus.add(mapping.sku);
    unlockedOutfitIds.add(mapping.outfitId);
    matchedMappings.set(mapping.sku, mapping);
    for (const o of mapping.unlockedGarments.outerwear) outerwear.add(o);
    for (const t of mapping.unlockedGarments.tops) tops.add(t);
    for (const b of mapping.unlockedGarments.bottoms) bottoms.add(b);
    for (const s of mapping.unlockedGarments.shoes) shoes.add(s);
    for (const a of mapping.unlockedGarments.accessories) accessories.add(a);
  };

  for (const obj of sources.ownedObjects ?? []) {
    registerKey(obj.sku);
    registerKey(obj.selectedVariantId);
  }
  for (const sku of sources.ownedSkus ?? []) registerKey(sku);
  for (const oid of sources.unlockedOutfits ?? []) registerKey(oid);
  for (const oid of sources.legacyOutfits ?? []) registerKey(oid);

  return {
    unlockedSkus,
    unlockedOutfitIds,
    outerwear,
    tops,
    bottoms,
    shoes,
    accessories,
    unlockedPresets: [...matchedMappings.values()],
  };
}

export function isGarmentUnlocked(
  garmentId: string,
  slotKind: 'outerwear' | 'top' | 'bottom' | 'shoes' | 'accessory',
  unlocked: UnlockedWardrobeSet,
): boolean {
  switch (slotKind) {
    case 'outerwear':
      return unlocked.outerwear.has(garmentId as OuterwearId);
    case 'top':
      return unlocked.tops.has(garmentId);
    case 'bottom':
      return unlocked.bottoms.has(garmentId);
    case 'shoes':
      return unlocked.shoes.has(garmentId);
    case 'accessory':
      return unlocked.accessories.has(garmentId as AccessoryId);
  }
}

export interface EquipClothingResult {
  readonly ok: boolean;
  readonly reason: string;
  readonly profile: CharacterCreatorProfile;
  readonly appliedSlot: OutfitSlotId | null;
  readonly mapping: ClothingSkuMapping | null;
}

/**
 * Equips a purchased Echo Life `clothing_shop` SKU or V3 outfit ID onto the player's
 * CharacterCreatorProfile while preserving their sculpted face, hair, body, and identity.
 */
export function equipClothingSkuOnProfile(
  profile: CharacterCreatorProfile,
  skuOrOutfitId: string,
  targetSlotOverride?: OutfitSlotId,
): EquipClothingResult {
  const safe = sanitizeCreatorProfile(profile);
  const mapping = findClothingMapping(skuOrOutfitId);
  if (!mapping) {
    return {
      ok: false,
      reason: `Outfit SKU "${skuOrOutfitId}" is not recognized in the boutique catalog.`,
      profile: safe,
      appliedSlot: null,
      mapping: null,
    };
  }

  const slot = targetSlotOverride ?? mapping.targetSlot;
  const preset = mapping.curatedPresetByHero[safe.hero];
  const mergedSlot = sanitizeOutfitSlot(safe.hero, slot, {
    ...safe.outfits[slot],
    ...preset,
  });

  const nextProfile = sanitizeCreatorProfile({
    ...safe,
    activeOutfitSlot: slot,
    outfits: {
      ...safe.outfits,
      [slot]: mergedSlot,
    },
  });

  return {
    ok: true,
    reason: `Equipped ${mapping.name} onto your ${slot.replace('_', ' ')} slot.`,
    profile: nextProfile,
    appliedSlot: slot,
    mapping,
  };
}

export function listBoutiqueCatalogWithOwnership(
  sources: UnlockedWardrobeSources = {},
): {
  mapping: ClothingSkuMapping;
  owned: boolean;
}[] {
  const unlocked = resolveUnlockedWardrobe(sources);
  return CLOTHING_SKU_MAPPINGS.map(mapping => ({
    mapping,
    owned: unlocked.unlockedSkus.has(mapping.sku) || unlocked.unlockedOutfitIds.has(mapping.outfitId),
  }));
}
