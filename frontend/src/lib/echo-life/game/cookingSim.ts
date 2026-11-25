/**
 * Echo Life Wave 11 — Home Cooking Simulation (10 Recipes) and Willow Corner Bistro Menu (5 Items).
 *
 * Pure deterministic simulation mapped cleanly onto real Echo Life V3 pantry/bag/market SKUs
 * (`egg`, `greens`, `noodle`, `rice`, `meat`, `herbal_tea`, `ingredients`) with zero V3 edits
 * and 100% clean English copy.
 */

export type IngredientId =
  | 'egg'
  | 'greens'
  | 'noodle'
  | 'rice'
  | 'meat'
  | 'herbal_tea'
  | 'ingredients';

export const INGREDIENT_LABELS: Readonly<Record<IngredientId, { label: string; marketSku: string }>> = {
  egg: { label: 'Fresh Egg', marketSku: 'sku_food_eggs' },
  greens: { label: 'Fresh Garden Greens', marketSku: 'sku_food_noodles' },
  noodle: { label: 'Artisan Noodles', marketSku: 'sku_food_noodles' },
  rice: { label: 'Steamed Jasmine Rice', marketSku: 'sku_food_rice' },
  meat: { label: 'Savory Braised Cut', marketSku: 'sku_food_rice' },
  herbal_tea: { label: 'Moon-Jasmine Tea Leaf', marketSku: 'tea' },
  ingredients: { label: 'Gourmet Pantry Spice', marketSku: 'sku_mat_ingredients' },
};

export interface MealMoodletSpec {
  readonly id: string;
  readonly label: string;
  readonly effect: string;
  readonly durationMinutes: number;
}

export interface MealNeedsDelta {
  readonly hunger: number;
  readonly fun: number;
  readonly energy: number;
  readonly mood: number;
  readonly hygiene?: number;
}

export type RecipeId =
  | 'fresh_garden_salad'
  | 'jasmine_honey_tea'
  | 'avocado_toast'
  | 'tomato_egg_bowl'
  | 'matcha_pancakes'
  | 'herb_noodle_soup'
  | 'espresso_tonic'
  | 'berry_yogurt_parfait'
  | 'veggie_stir_fry'
  | 'comfort_ramen';

export interface HomeRecipe {
  readonly id: RecipeId;
  readonly name: string;
  readonly category: 'Light' | 'Drink' | 'Breakfast' | 'Main' | 'Comfort';
  readonly description: string;
  readonly requiredCookingLevel: number;
  readonly ingredients: Readonly<Partial<Record<IngredientId, number>>>;
  readonly marketSkuHints: readonly string[];
  readonly prepSeconds: number;
  readonly needsDelta: MealNeedsDelta;
  readonly cookingXp: number;
  readonly moodlet: MealMoodletSpec;
}

export const RECIPE_BOOK: readonly HomeRecipe[] = [
  {
    id: 'fresh_garden_salad',
    name: 'Fresh Garden Salad',
    category: 'Light',
    description: 'Crisp Riverside greens tossed with toasted sesame and light citrus.',
    requiredCookingLevel: 1,
    ingredients: { greens: 1 },
    marketSkuHints: ['sku_food_noodles', 'botanical_harvest'],
    prepSeconds: 8,
    needsDelta: { hunger: 22, fun: 6, energy: 10, mood: 8 },
    cookingXp: 14,
    moodlet: {
      id: 'fresh_bite',
      label: 'Fresh Greens Glow',
      effect: '+8% steady energy conservation for 3 game hours',
      durationMinutes: 180,
    },
  },
  {
    id: 'jasmine_honey_tea',
    name: 'Jasmine Honey Tea',
    category: 'Drink',
    description: 'Fragrant moon-jasmine leaves steeped gently with warm blossom honey.',
    requiredCookingLevel: 1,
    ingredients: { herbal_tea: 1 },
    marketSkuHints: ['tea', 'botanical_harvest'],
    prepSeconds: 6,
    needsDelta: { hunger: 10, fun: 8, energy: 14, mood: 16 },
    cookingXp: 12,
    moodlet: {
      id: 'tea_calm',
      label: 'Tea Calm',
      effect: '50% slower Mood decay and serene focus',
      durationMinutes: 240,
    },
  },
  {
    id: 'avocado_toast',
    name: 'Avocado Toast',
    category: 'Breakfast',
    description: 'Toasted sourdough layered with whipped greens and a soft-poached egg.',
    requiredCookingLevel: 1,
    ingredients: { greens: 1, egg: 1 },
    marketSkuHints: ['sku_food_eggs', 'sku_food_noodles'],
    prepSeconds: 10,
    needsDelta: { hunger: 28, fun: 8, energy: 16, mood: 11 },
    cookingXp: 18,
    moodlet: {
      id: 'morning_glow',
      label: 'Bright Morning Fuel',
      effect: '+10% study focus stability for 3 game hours',
      durationMinutes: 180,
    },
  },
  {
    id: 'tomato_egg_bowl',
    name: 'Tomato Egg Bowl',
    category: 'Main',
    description: 'Silky golden scrambled eggs simmered with sweet tomatoes over warm rice.',
    requiredCookingLevel: 2,
    ingredients: { egg: 2, rice: 1 },
    marketSkuHints: ['sku_food_eggs', 'sku_food_rice'],
    prepSeconds: 12,
    needsDelta: { hunger: 34, fun: 10, energy: 18, mood: 14 },
    cookingXp: 22,
    moodlet: {
      id: 'home_comfort',
      label: 'Home Kitchen Comfort',
      effect: 'Warm Cozy emotion boost indoors for 4 game hours',
      durationMinutes: 240,
    },
  },
  {
    id: 'matcha_pancakes',
    name: 'Matcha Pancakes',
    category: 'Breakfast',
    description: 'Fluffy green tea griddle cakes dusted with light toasted sugar.',
    requiredCookingLevel: 2,
    ingredients: { egg: 1, herbal_tea: 1 },
    marketSkuHints: ['sku_food_eggs', 'tea'],
    prepSeconds: 14,
    needsDelta: { hunger: 32, fun: 15, energy: 18, mood: 17 },
    cookingXp: 24,
    moodlet: {
      id: 'sweet_lift',
      label: 'Sweet Matcha Lift',
      effect: '+12% Fun and upbeat Joyful mood boost',
      durationMinutes: 210,
    },
  },
  {
    id: 'herb_noodle_soup',
    name: 'Herb Noodle Soup',
    category: 'Comfort',
    description: 'Steaming broth infused with botanical garden herbs and springy noodles.',
    requiredCookingLevel: 3,
    ingredients: { noodle: 1, greens: 1, herbal_tea: 1 },
    marketSkuHints: ['sku_food_noodles', 'tea'],
    prepSeconds: 16,
    needsDelta: { hunger: 38, fun: 12, energy: 22, mood: 18 },
    cookingXp: 28,
    moodlet: {
      id: 'warm_hearth',
      label: 'Warm Hearth Broth',
      effect: 'Shields mood from rain or winter chill for 4 game hours',
      durationMinutes: 240,
    },
  },
  {
    id: 'espresso_tonic',
    name: 'Espresso Tonic',
    category: 'Drink',
    description: 'Chilled sparkling citrus tonic crowned with a crisp espresso pour.',
    requiredCookingLevel: 3,
    ingredients: { herbal_tea: 1, ingredients: 1 },
    marketSkuHints: ['tea', 'sku_mat_ingredients'],
    prepSeconds: 8,
    needsDelta: { hunger: 12, fun: 11, energy: 26, mood: 14 },
    cookingXp: 24,
    moodlet: {
      id: 'caffeinated',
      label: 'Caffeinated',
      effect: '+8% energy efficiency and crisp Focused clarity',
      durationMinutes: 240,
    },
  },
  {
    id: 'berry_yogurt_parfait',
    name: 'Berry Yogurt Parfait',
    category: 'Light',
    description: 'Layered chilled parfait with toasted oats, garden berries, and honey drizzle.',
    requiredCookingLevel: 4,
    ingredients: { greens: 1, ingredients: 1 },
    marketSkuHints: ['sku_food_noodles', 'sku_mat_ingredients'],
    prepSeconds: 10,
    needsDelta: { hunger: 26, fun: 16, energy: 18, mood: 20 },
    cookingXp: 28,
    moodlet: {
      id: 'inspired_palate',
      label: 'Inspired Palate',
      effect: '+15% Creative and Photography sub-skill XP',
      durationMinutes: 240,
    },
  },
  {
    id: 'veggie_stir_fry',
    name: 'Veggie Stir-Fry',
    category: 'Main',
    description: 'High-heat wok noodles seared with crisp greens and fragrant pantry aromatics.',
    requiredCookingLevel: 4,
    ingredients: { noodle: 1, greens: 2, ingredients: 1 },
    marketSkuHints: ['sku_food_noodles', 'sku_mat_ingredients'],
    prepSeconds: 18,
    needsDelta: { hunger: 42, fun: 15, energy: 24, mood: 20 },
    cookingXp: 34,
    moodlet: {
      id: 'chef_pride',
      label: 'Home Chef Pride',
      effect: 'Boosts Confident emotion and Recognition gain for 4 game hours',
      durationMinutes: 240,
    },
  },
  {
    id: 'comfort_ramen',
    name: 'Comfort Ramen',
    category: 'Comfort',
    description: 'Rich slow-simmered Riverside ramen topped with braised cut, greens, and soft egg.',
    requiredCookingLevel: 5,
    ingredients: { noodle: 1, egg: 1, meat: 1, greens: 1 },
    marketSkuHints: ['sku_food_noodles', 'sku_food_eggs', 'sku_food_rice'],
    prepSeconds: 22,
    needsDelta: { hunger: 50, fun: 20, energy: 28, mood: 25 },
    cookingXp: 42,
    moodlet: {
      id: 'gourmet_warmth',
      label: 'Gourmet Lantern Warmth',
      effect: 'Peak hunger satisfaction, Joyful energy, and +20% Cooking prestige',
      durationMinutes: 300,
    },
  },
] as const;

const RECIPE_BY_ID = new Map<string, HomeRecipe>(RECIPE_BOOK.map(r => [r.id, r]));

export type CookingInventory = Partial<Record<IngredientId, number>> & Record<string, number | undefined>;

export function mergeCookingInventory(
  bag?: Record<string, number> | null,
  pantry?: Record<string, number> | null,
  materials?: Record<string, number> | null,
): Record<IngredientId, number> {
  const out: Record<IngredientId, number> = {
    egg: 0,
    greens: 0,
    noodle: 0,
    rice: 0,
    meat: 0,
    herbal_tea: 0,
    ingredients: 0,
  };
  for (const src of [bag, pantry, materials]) {
    if (!src) continue;
    for (const key of Object.keys(out) as IngredientId[]) {
      const n = src[key];
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
        out[key] += Math.floor(n);
      }
    }
  }
  return out;
}

export interface RecipeEligibility {
  readonly ok: boolean;
  readonly recipe: HomeRecipe | null;
  readonly missingIngredients: Partial<Record<IngredientId, number>>;
  readonly levelShortfall: number;
  readonly reason: string;
}

export function getRecipeById(recipeId: string): HomeRecipe | null {
  return RECIPE_BY_ID.get(recipeId) ?? null;
}

export function canCookRecipe(
  recipeId: string,
  inventory: CookingInventory,
  cookingLevel: number,
): RecipeEligibility {
  const recipe = getRecipeById(recipeId);
  if (!recipe) {
    return {
      ok: false,
      recipe: null,
      missingIngredients: {},
      levelShortfall: 0,
      reason: 'Recipe not found in the home cookbook.',
    };
  }
  const safeLevel = Math.max(1, Math.floor(Number.isFinite(cookingLevel) ? cookingLevel : 1));
  const levelShortfall = Math.max(0, recipe.requiredCookingLevel - safeLevel);
  const missing: Partial<Record<IngredientId, number>> = {};
  for (const [key, reqQty] of Object.entries(recipe.ingredients) as [IngredientId, number][]) {
    const have = Math.max(0, Math.floor(Number(inventory[key] ?? 0)));
    if (have < reqQty) {
      missing[key] = reqQty - have;
    }
  }
  const missingKeys = Object.keys(missing) as IngredientId[];
  if (levelShortfall > 0) {
    return {
      ok: false,
      recipe,
      missingIngredients: missing,
      levelShortfall,
      reason: `Requires Cooking Level ${recipe.requiredCookingLevel} (currently Level ${safeLevel}).`,
    };
  }
  if (missingKeys.length > 0) {
    const list = missingKeys
      .map(k => `${missing[k]} ${INGREDIENT_LABELS[k].label}`)
      .join(', ');
    return {
      ok: false,
      recipe,
      missingIngredients: missing,
      levelShortfall: 0,
      reason: `Missing ingredients: ${list}. Visit Sunrise Market or Botanical Garden to restock.`,
    };
  }
  return {
    ok: true,
    recipe,
    missingIngredients: {},
    levelShortfall: 0,
    reason: `Ready to cook ${recipe.name}.`,
  };
}

export type MealQuality = 'homestyle' | 'tasty' | 'chef_grade';

export interface CookRecipeResult {
  readonly ok: boolean;
  readonly reason: string;
  readonly recipe: HomeRecipe | null;
  readonly nextInventory: CookingInventory;
  readonly prepSeconds: number;
  readonly quality: MealQuality;
  readonly needsDelta: MealNeedsDelta;
  readonly cookingXp: number;
  readonly moodlet: MealMoodletSpec | null;
}

export function cookRecipe(
  recipeId: string,
  inventory: CookingInventory,
  cookingLevel: number,
  stoveTimeMultiplier = 1.0,
): CookRecipeResult {
  const check = canCookRecipe(recipeId, inventory, cookingLevel);
  if (!check.ok || !check.recipe) {
    return {
      ok: false,
      reason: check.reason,
      recipe: check.recipe,
      nextInventory: { ...inventory },
      prepSeconds: 0,
      quality: 'homestyle',
      needsDelta: { hunger: 0, fun: 0, energy: 0, mood: 0 },
      cookingXp: 0,
      moodlet: null,
    };
  }
  const recipe = check.recipe;
  const nextInventory: CookingInventory = { ...inventory };
  for (const [key, reqQty] of Object.entries(recipe.ingredients) as [IngredientId, number][]) {
    nextInventory[key] = Math.max(0, Math.floor(Number(nextInventory[key] ?? 0)) - reqQty);
  }
  const safeLevel = Math.max(1, Math.floor(Number.isFinite(cookingLevel) ? cookingLevel : 1));
  const skillMargin = safeLevel - recipe.requiredCookingLevel;
  const quality: MealQuality =
    safeLevel >= 8 || skillMargin >= 3 ? 'chef_grade'
    : skillMargin >= 1 ? 'tasty'
    : 'homestyle';
  const qualityMult = quality === 'chef_grade' ? 1.25 : quality === 'tasty' ? 1.12 : 1.0;
  const clampedStove = Math.max(0.4, Math.min(1.5, Number.isFinite(stoveTimeMultiplier) ? stoveTimeMultiplier : 1.0));
  const prepSeconds = Math.max(4, Math.round(recipe.prepSeconds * clampedStove));

  return {
    ok: true,
    reason: `Cooked ${recipe.name} (${quality.replace('_', ' ')}) in ${prepSeconds}s.`,
    recipe,
    nextInventory,
    prepSeconds,
    quality,
    needsDelta: {
      hunger: Math.round(recipe.needsDelta.hunger * qualityMult),
      fun: Math.round(recipe.needsDelta.fun * qualityMult),
      energy: Math.round(recipe.needsDelta.energy * qualityMult),
      mood: Math.round(recipe.needsDelta.mood * qualityMult),
    },
    cookingXp: recipe.cookingXp,
    moodlet: recipe.moodlet,
  };
}

export function listCookableRecipes(
  inventory: CookingInventory,
  cookingLevel: number,
): { recipe: HomeRecipe; eligibility: RecipeEligibility }[] {
  return RECIPE_BOOK.map(recipe => ({
    recipe,
    eligibility: canCookRecipe(recipe.id, inventory, cookingLevel),
  }));
}

// ── Willow Corner Bistro Menu (5 Signature Items) ────────────────────────────────────────────────────────

export type BistroItemId =
  | 'matcha_crepe'
  | 'iced_matcha'
  | 'egg_banh_mi'
  | 'truffle_ramen'
  | 'jasmine_tea_set';

export interface BistroMenuItem {
  readonly id: BistroItemId;
  readonly name: string;
  readonly price: number;
  readonly description: string;
  readonly bagItemId: string;
  readonly needsDelta: MealNeedsDelta;
  readonly buff: MealMoodletSpec;
}

export const BISTRO_MENU: readonly BistroMenuItem[] = [
  {
    id: 'matcha_crepe',
    name: 'Matcha Crepe',
    price: 12,
    description: 'Delicate stone-milled green tea crepe folded with vanilla cream and toasted almonds.',
    bagItemId: 'matcha_crepe',
    needsDelta: { hunger: 30, fun: 14, energy: 18, mood: 15 },
    buff: {
      id: 'sweet_lift',
      label: 'Willow Crepe Delight',
      effect: '+12 Mood and upbeat social warmth for 3 game hours',
      durationMinutes: 180,
    },
  },
  {
    id: 'iced_matcha',
    name: 'Iced Matcha Latte',
    price: 9,
    description: 'Chilled ceremonial matcha whisked over velvety oat milk and clear ice.',
    bagItemId: 'herbal_tea',
    needsDelta: { hunger: 12, fun: 12, energy: 24, mood: 14 },
    buff: {
      id: 'caffeinated',
      label: 'Caffeinated',
      effect: '+8% walk energy efficiency and crisp Focus clarity',
      durationMinutes: 240,
    },
  },
  {
    id: 'egg_banh_mi',
    name: 'Crispy Egg Banh Mi',
    price: 11,
    description: 'Warm crusted baguette filled with golden herb omelette, pickled carrots, and cilantro.',
    bagItemId: 'egg',
    needsDelta: { hunger: 36, fun: 10, energy: 20, mood: 12 },
    buff: {
      id: 'morning_glow',
      label: 'Lantern Street Crunch',
      effect: 'Steady energy and satisfaction across campus errands',
      durationMinutes: 210,
    },
  },
  {
    id: 'truffle_ramen',
    name: 'Willow Truffle Ramen',
    price: 18,
    description: 'Khanh Ha signature evening bowl with roasted mushroom tare, truffle oil, and soft egg.',
    bagItemId: 'noodle',
    needsDelta: { hunger: 48, fun: 18, energy: 26, mood: 22 },
    buff: {
      id: 'gourmet_warmth',
      label: 'Bistro Gourmet Warmth',
      effect: 'Peak Cozy comfort and +18% Joyful mood floor for 5 game hours',
      durationMinutes: 300,
    },
  },
  {
    id: 'jasmine_tea_set',
    name: 'Moon-Jasmine Tea Set',
    price: 14,
    description: 'Ceramic teapot of botanical garden jasmine blossoms served with two shortbread biscuits.',
    bagItemId: 'herbal_tea',
    needsDelta: { hunger: 16, fun: 16, energy: 18, mood: 22 },
    buff: {
      id: 'tea_calm',
      label: 'Tea Calm',
      effect: '50% slower Mood decay and serene study composure',
      durationMinutes: 270,
    },
  },
] as const;

const BISTRO_BY_ID = new Map<string, BistroMenuItem>(BISTRO_MENU.map(b => [b.id, b]));

export function getBistroItem(itemId: string): BistroMenuItem | null {
  return BISTRO_BY_ID.get(itemId) ?? null;
}

export interface BistroOrderResult {
  readonly ok: boolean;
  readonly reason: string;
  readonly item: BistroMenuItem | null;
  readonly cost: number;
  readonly remainingCredits: number;
  readonly needsDelta: MealNeedsDelta;
  readonly buff: MealMoodletSpec | null;
}

export function orderBistroItem(
  itemId: string,
  credits: number,
  options: { hasBaristaPerk?: boolean; discountPct?: number } = {},
): BistroOrderResult {
  const item = getBistroItem(itemId);
  const safeCredits = Math.max(0, Math.floor(Number.isFinite(credits) ? credits : 0));
  if (!item) {
    return {
      ok: false,
      reason: 'Menu item is not available at Willow Corner Bistro.',
      item: null,
      cost: 0,
      remainingCredits: safeCredits,
      needsDelta: { hunger: 0, fun: 0, energy: 0, mood: 0 },
      buff: null,
    };
  }
  const discount = Math.max(0, Math.min(25, Number.isFinite(options.discountPct ?? 0) ? (options.discountPct ?? 0) : 0));
  const cost = Math.max(1, Math.round(item.price * (1 - discount / 100)));
  if (safeCredits < cost) {
    return {
      ok: false,
      reason: `Need ${cost} Campus Credits for ${item.name} (you have ${safeCredits} CC).`,
      item,
      cost,
      remainingCredits: safeCredits,
      needsDelta: { hunger: 0, fun: 0, energy: 0, mood: 0 },
      buff: null,
    };
  }
  const perkMoodBonus = options.hasBaristaPerk ? 10 : 0;
  return {
    ok: true,
    reason: `Enjoyed ${item.name} at Willow Corner Bistro (-${cost} CC).`,
    item,
    cost,
    remainingCredits: safeCredits - cost,
    needsDelta: {
      hunger: item.needsDelta.hunger,
      fun: item.needsDelta.fun,
      energy: item.needsDelta.energy,
      mood: item.needsDelta.mood + perkMoodBonus,
    },
    buff: item.buff,
  };
}
