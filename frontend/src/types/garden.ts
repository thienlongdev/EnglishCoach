/** Echo Garden API contract — mirrors backend `com.englishcoach.garden.api.GardenDtos`. */

export type GardenTier = 'NORMAL' | 'GOOD' | 'PERFECT' | 'GOLDEN';
export type GardenSeasonFit = 'IN_SEASON' | 'ALL_SEASON' | 'OFF_SEASON';
export type GardenTheme = 'LU_HANH' | 'CONG_SO' | 'HOC_THUAT' | 'THANH_NGU';

/** `adminQa` (Phase 4): true only for the official administrator; decided by the server. */
export interface GardenAccess { enabled: boolean; adminQa?: boolean }

/** Phase 4 — the official administrator's QA access (these payloads are never sent to another account). */
export interface GardenAdminQaStatus { admin: boolean; qaUnits: number; qaSkins: number; maxAdvanceHours: number }
export interface GardenAdminQaCosmeticsReceipt {
  action: 'UNLOCK' | 'REVOKE';
  units: number;
  skins: number;
  status: GardenAdminQaStatus;
  shop: GardenCosmeticShop;
}
export interface GardenAdminQaAnimalsReceipt {
  action: 'PROVISION' | 'ADVANCE';
  houses: number;
  livestock: number;
  guardians: number;
  supplies: Record<string, number>;
  hours: number;
  animals: GardenAnimals;
}

export interface GardenUnlock { level: number; cropCode: string; nameVi: string }

export interface GardenProfile {
  level: number;
  xpIntoLevel: number;
  xpToNext: number;
  totalXp: number;
  coins: number;
  nextUnlock: GardenUnlock | null;
  /** Tinh chất Ký Ức (Phase 2): from healthy Knowledge Trees and graduations; buys Epic seeds with coins. */
  essence: number;
}

export interface GardenGoal {
  done: boolean;
  effectiveUnits: number;
  targetUnits: number;
  reviews: number;
  dueMinReviews: number;
  doneAt: string | null;
  /** Phase 2 mixed goal: `mixUnits` card units + `mixSkills` credited skill lessons the same day. */
  mixUnits: number;
  mixSkills: number;
  skillsToday: number;
}

export interface GardenToday { dayKey: string; goal: GardenGoal; blessing: boolean; blessingMultiplier: number }

export type GardenWeatherKind = 'SUNNY' | 'RAIN' | 'RAINBOW';

/** A weather window (4 h). RAIN in the winter theme is shown as snow (same rule: crops grow faster). */
export interface GardenWeather { kind: GardenWeatherKind; startsAt: string; endsAt: string; theme: GardenTheme; growthFactor: number }

/** Season = theme week (global, server time); `forecast[0]` is the current window, a coming rainbow is never revealed. */
export interface GardenWorld {
  theme: GardenTheme;
  themeEndsAt: string;
  nextTheme: GardenTheme;
  weather: GardenWeather;
  forecast: GardenWeather[];
  rainbowMutation: number;
}

export interface GardenPlanting {
  id: number;
  cropCode: string;
  nameVi: string;
  plantedAt: string;
  stage: number;
  progress: number;
  ready: boolean;
  readyAt: string | null;
  requiredSeconds: number;
  remainingSeconds: number;
  speed: number;
  waterCount: number;
  waterLimit: number;
  fertilizer: string | null;
  boostFraction: number;
  maxBoost: number;
  seasonFit: GardenSeasonFit;
  tutorial: boolean;
  freshUntil: string | null;
  /** The Forgotten Pest sitting on this crop (Phase 2), if any. */
  pestId: number | null;
  /** Phase 3B: the cosmetic skin this planting was planted with (art only), null = the base crop. */
  skinCode: string | null;
  skinArt: string | null;
  /** Phase 3C: damage stage of the pest on this crop (1 warning, 2 leaf damage, 3 wilting, 0 resolved); null = no pest. */
  pestStage?: number | null;
  /** Phase 3D: the soil of a crop planted under the farming rules (null / absent = a crop from the earlier rules). */
  soil?: GardenSoil | null;
  /** Phase 3D: supplies still working on this crop. */
  protections?: GardenProtection[];
}

export type GardenSoilStatus = 'OK' | 'DRY' | 'WET';

/**
 * Phase 3D soil of one growing crop (server facts). `moisture` 0–100; `slowing`: the soil is slowing growth now;
 * `stressShare`: share of the growing time spent thirsty or waterlogged and `careFactor` what it does to the care points;
 * `tierCap`: the best quality tier a severely stressed crop can still reach (null = none); `nextChangeAt` / `nextStatus`:
 * the next expected change by the known forecast. A ripe crop shows the soil it ripened with.
 */
export interface GardenSoil {
  moisture: number;
  status: GardenSoilStatus;
  slowing: boolean;
  stressShare: number;
  careFactor: number;
  nextChangeAt: string | null;
  nextStatus: GardenSoilStatus | null;
  thirst: number;
  toned: boolean;
  tierCap: string | null;
}

export type GardenSupplyEffect = 'BOOST' | 'MOISTURE' | 'MULCH' | 'RAIN_COVER' | 'SHADE' | 'DRAINAGE' | 'TONIC' | 'PEST_SPRAY' | 'PEST_NET';

export interface GardenProtection {
  itemCode: string;
  effect: GardenSupplyEffect;
  appliedAt: string;
  /** null = until harvest */
  expiresAt: string | null;
}

export type GardenShopCategory = 'SEEDS' | 'CARE' | 'WEATHER' | 'PEST' | 'UTILITY';

/** A farming supply of the catalogue: what it does (`effect`, `hours`, `value`), its market price and this player's stock. */
export interface GardenSupplyItem {
  code: string;
  nameVi: string;
  category: Exclude<GardenShopCategory, 'SEEDS'>;
  effect: GardenSupplyEffect;
  hours: number;
  value: number;
  price: number | null;
  unlockLevel: number;
  locked: boolean;
  owned: number;
}

export interface GardenFarming {
  items: GardenSupplyItem[];
  soil: {
    dryBelow: number; wetAbove: number; waterGain: number; dryFactor: number; wetFactor: number; maxStressHours: number;
    severeShare: number; severeTierCap: string;
  };
  harvestBonusPaid: number;
  harvestBonusCap: number;
}

export interface GardenTreatResult {
  plot: GardenPlot;
  itemCode: string;
  itemQty: number;
  expiresAt: string | null;
}

/** Phase 3D lifetime record of one crop: harvests never go down when produce is sold. */
export interface GardenCropRecord {
  cropCode: string;
  nameVi: string;
  harvested: number;
  masteryTier: number;
  inStock: number;
  sold: number;
  delivered: number;
  composted: number;
  used: number;
}

export interface GardenRecords {
  crops: GardenCropRecord[];
  harvestedTotal: number;
  soldUnits: number;
  deliveredUnits: number;
  compostedUnits: number;
  usedUnits: number;
  saleCoins: number;
  orderCoins: number;
  harvestBonusCoins: number;
}

export interface GardenPlot { id: number; slot: number; gridX: number; gridY: number; unlocked: boolean; planting: GardenPlanting | null }

export interface GardenSeed { cropCode: string; qty: number }
export interface GardenProduce { cropCode: string; tier: GardenTier; qty: number; unitPrice: number }

export interface GardenInventory {
  water: number;
  fertilizer: number;
  fertilizerPremium: number;
  seeds: GardenSeed[];
  produce: GardenProduce[];
  /** Phase 3H: harvest portions short of a whole unit, with what selling them pays now (absent before the social islands). */
  shares?: GardenShareStock[];
}

/** `value` = floor(unitPrice × portions / unitPortions): the proportional share of one unit, never more. */
export interface GardenShareStock {
  cropCode: string;
  nameVi: string;
  tier: GardenTier;
  portions: number;
  unitPortions: number;
  unitPrice: number;
  value: number;
}

export interface GardenCrop {
  code: string;
  nameVi: string;
  rarity: string;
  baseSeconds: number;
  seedPrice: number;
  sellPrice: number;
  season: 'ALL' | GardenTheme;
  unlockLevel: number;
  harvestXp: number;
  unlocked: boolean;
  purchasable: boolean;
  seasonFitNow: GardenSeasonFit;
  growSecondsNow: number;
  qa: boolean;
  /** Essence also paid for an Epic seed (Phase 2). Legendary seeds are never sold. */
  seedEssence: number;
  /** Phase 3D: how fast this crop dries its soil (1 = average) and the Echo Coins one harvest pays (before the daily cap). */
  thirst?: number;
  harvestBonus?: number;
}

export interface GardenBoost { code: string; nameVi: string; group: 'WATER' | 'FERTILIZER'; fraction: number; perPlanting: number }
export interface GardenTierInfo { code: GardenTier; minScore: number; sellMultiplier: number }
export interface GardenRewards { unseen: boolean; reviews: number; water: number; xp: number; fertilizer: number; lessons: number }

export interface GardenState {
  serverNow: string;
  profile: GardenProfile;
  today: GardenToday;
  world: GardenWorld;
  plots: GardenPlot[];
  inventory: GardenInventory;
  crops: GardenCrop[];
  boosts: GardenBoost[];
  tiers: GardenTierInfo[];
  rewards: GardenRewards;
  onboardingStep: number;
  /** The voluntary Echo guide's record (absent on a server from before the guide). */
  guide?: GardenGuide | null;
  stageThresholds: number[];
  knowledge: GardenKnowledge;
  pests: GardenPest[];
  learning: GardenLearning;
  /** Phase 3A farm economy: today's market stall, the delivery board and the four expansion beds. */
  economy: GardenEconomy;
  /** Phase 3B: the monumental Knowledge Tree, the codex (mastery, skins) and Echo's single contextual hint. */
  living: GardenLiving;
  /** Phase 3C: buildings, the compost bin, farmland regions, Echo Contribution and the reward catalogue. */
  estate: GardenEstate;
  /** Phase 3D: the supply catalogue, soil rules and today's harvest-bonus counter (absent before the farming rules). */
  farming?: GardenFarming | null;
  /** Phase 3E: what the island wears (equipped appearances, standing decorations); absent before the cosmetic catalogue. */
  cosmetics?: GardenCosmeticState | null;
  /** Phase 3G: the garden's social mark (unread island activity, crops a visitor took from); absent before the social islands. */
  social?: GardenSocialBadge | null;
  /** Phase 3H: animal houses, livestock, guardian pets, feed and products (absent before the animals rules). */
  animals?: GardenAnimals | null;
}

// ------------------------------------------------------------------ Phase 3H: livestock and guardian pets (server facts only)

export type GardenAnimalStage = 'BABY' | 'YOUNG' | 'ADULT';
export type GardenHouseCode = 'COOP' | 'DUCK_POND' | 'PIG_PEN' | 'SHEEP_BARN';
export type GardenLivestockSpecies = 'CHICKEN' | 'DUCK' | 'PIG' | 'SHEEP';
export type GardenGuardianSpecies = 'DOG' | 'GOOSE' | 'CAT';

/** `cared`: it has food and water now; `ready`: products waiting (at most `storeCap`); times are null when care ends first. */
export interface GardenAnimal {
  id: number;
  species: GardenLivestockSpecies;
  nameVi: string;
  stage: GardenAnimalStage;
  place: number;
  growth: number;
  adultAt: string | null;
  cared: boolean;
  fedUntil: string;
  canFeed: boolean;
  ready: number;
  storeCap: number;
  nextProductAt: string | null;
}

export interface GardenAnimalHouse {
  code: GardenHouseCode;
  nameVi: string;
  species: GardenLivestockSpecies;
  animalNameVi: string;
  babyNameVi: string;
  built: boolean;
  minLevel: number;
  coins: number;
  levelOk: boolean;
  coinsOk: boolean;
  capacity: number;
  animalCoins: number;
  animalCoinsOk: boolean;
  wateredUntil: string | null;
  watered: boolean;
  canRefill: boolean;
  /** feed units one feeding of every animal that can eat now costs */
  feedNeeded: number;
  rationFeed: number;
  rationHours: number;
  growHours: number;
  product: string;
  productNameVi: string;
  productHours: number;
  ready: number;
  animals: GardenAnimal[];
}

export type GardenGuardianStatus = 'LOCKED' | 'AVAILABLE' | 'HUNGRY' | 'ON_DUTY' | 'READY' | 'GUARDING' | 'COOLDOWN';

export interface GardenGuardian {
  species: GardenGuardianSpecies;
  nameVi: string;
  owned: boolean;
  minLevel: number;
  coins: number;
  levelOk: boolean;
  coinsOk: boolean;
  status: GardenGuardianStatus;
  fedUntil: string | null;
  canFeed: boolean;
  rationFeed: number;
  rationHours: number;
  until: string | null;
  cooldownHours: number;
  shieldHours: number;
  graceMinutes: number;
  pestCapReduction: number;
}

export interface GardenAnimals {
  houses: GardenAnimalHouse[];
  guardians: GardenGuardian[];
  feed: number;
  water: number;
  waterItem: string;
  waterHours: number;
  feedMaxHours: number;
  learnedToday: boolean;
  learningBonusPercent: number;
  products: Array<{ code: string; nameVi: string; qty: number; unitPrice: number }>;
  mill: Array<{ cropCode: string; nameVi: string; tier: GardenTier; held: number; feedPerUnit: number }>;
  compost: { product: string; manure: number; gives: string; dailyCap: number; usedToday: number; held: number };
  livestock: number;
  livestockCapacity: number;
}

export interface GardenAnimalReceipt {
  action: string;
  coinsDelta: number;
  coins: number;
  gained: Record<string, number>;
  animals: GardenAnimals;
}

export interface GardenShareSellResult { coinsGained: number; coins: number; blessing: boolean; lines: Array<{ cropCode: string; tier: GardenTier; qty: number; unitPrice: number; total: number }> }

/** An animal of a visited island: what stands there — never its food, timers or products. */
export interface GardenIslandAnimal {
  species: GardenLivestockSpecies | GardenGuardianSpecies;
  kind: 'LIVESTOCK' | 'GUARDIAN';
  stage: GardenAnimalStage;
  place: number | null;
  woolly: boolean;
}

export interface GardenIslandAnimals { houses: GardenHouseCode[]; animals: GardenIslandAnimal[] }

// ------------------------------------------------------------------ Phase 3G: social islands (the server owns every rule)

export type GardenVisibility = 'PUBLIC' | 'PRIVATE';

/** `taken`: planting id → portions a visitor took from a crop still on its bed (`unitPortions` portions = one produce unit). */
export interface GardenSocialBadge {
  visibility: GardenVisibility;
  unread: number;
  taken: Record<string, number>;
  unitPortions: number;
  /** Phase 3H: false until the owner has decided who may find the island (a new island starts closed and asks once). */
  visibilityChosen?: boolean;
}

/** An island as others see it: public name + handle, stored progression facts; `visitedAt` = the reader's last visit. */
export interface GardenIslandCard {
  handle: string;
  name: string;
  level: number;
  beds: number;
  monumentEra: number;
  forestTrees: number;
  visitedAt: string | null;
}

export interface GardenDiscoverPage { islands: GardenIslandCard[]; nextCursor: string | null; search: boolean }

export interface GardenSocialRules {
  unitPortions: number;
  fractionBp: number;
  windowHours: number;
  thiefCap: number;
  pairCap: number;
  victimCap: number;
  shieldHours: number;
  introHours: number;
  reopenHours: number;
  ripeGraceMinutes: number;
}

/** Whether the reader may take from other islands now (`reason` = the rule in the way, `availableAt` = when it ends). */
export interface GardenStanding { canTake: boolean; reason: string | null; availableAt: string | null; takesUsed: number; takesLeft: number }

/** Whether an island is protected as a whole: PRIVATE, ISLAND_NEW, ISLAND_SHIELD or VICTIM_LIMIT. */
export interface GardenIslandProtection { active: boolean; reason: string | null; until: string | null }

export interface GardenShare { cropCode: string; nameVi: string; tier: GardenTier; portions: number; unitPortions: number }

export interface GardenSocialMe {
  handle: string;
  name: string;
  visibility: GardenVisibility;
  visibilityChangedAt: string;
  standing: GardenStanding;
  protection: GardenIslandProtection;
  shares: GardenShare[];
  unread: number;
  rules: GardenSocialRules;
  reactions: string[];
}

/** What the reader may do with one crop of the visited island; `portions` = what a take would carry now. */
export interface GardenTakeOption { plantingId: number; slot: number; eligible: boolean; reason: string | null; portions: number; availableAt: string | null }

/** A read-only picture of another player's island for the existing scene (no balance, inventory, word or pest of the owner). */
export interface GardenIsland {
  serverNow: string;
  owner: GardenIslandCard;
  plots: GardenPlot[];
  stageThresholds: number[];
  buildings: Record<string, number>;
  cosmetics: GardenCosmeticState | null;
  monument: { era: number; ornaments: Record<string, number> };
  grove: Array<{ id: number; slot: number; species: GardenSpecies; stage: number }>;
  forest: Array<{ id: number; species: GardenSpecies }>;
  takes: GardenTakeOption[];
  standing: GardenStanding;
  protection: GardenIslandProtection;
  unitPortions: number;
  myReaction: string | null;
  reactionAvailableAt: string | null;
  /** Phase 3H: the houses and animals standing on the island (absent before the animals rules). */
  animals?: GardenIslandAnimals | null;
}

export interface GardenTakeReceipt {
  takeId: number;
  handle: string;
  ownerName: string;
  plantingId: number;
  cropCode: string;
  nameVi: string;
  portions: number;
  unitPortions: number;
  tier: GardenTier;
  sharesNow: number;
  unitsMerged: number;
  standing: GardenStanding;
  protection: GardenIslandProtection;
  /** Phase 3H: the island's guardian dog turned this visit away — nothing was taken and no limit was used. */
  guarded?: boolean;
}

export interface GardenReactionReceipt { code: string; at: string; nextAt: string }

/** `kind`: TAKEN_FROM_ME (someone took from the reader's island) or I_TOOK; `otherHandle` null = that island is closed now. */
export interface GardenActivityEntry {
  id: number;
  kind: 'TAKEN_FROM_ME' | 'I_TOOK';
  otherName: string;
  otherHandle: string | null;
  cropCode: string;
  nameVi: string;
  portions: number;
  unitPortions: number;
  at: string;
  unread: boolean;
}

export interface GardenReactionEntry { visitorName: string; visitorHandle: string | null; code: string; at: string; unread: boolean }

export interface GardenActivityPage {
  entries: GardenActivityEntry[];
  nextBefore: number | null;
  reactions: GardenReactionEntry[];
  unread: number;
  seenAt: string;
}

// ------------------------------------------------------------------ Phase 3E: cosmetics (art only; the server owns everything)

export type GardenCosmeticSlot = 'HOUSE' | 'TREE' | 'SHRUB' | 'FLOWER' | 'MONUMENT' | 'FENCE' | 'PATH' | 'BED';
export type GardenCosmeticCategory = GardenCosmeticSlot | 'DECOR';
export type GardenCosmeticUnlock = 'COIN' | 'LEARNING' | 'HARVESTS' | 'GRADUATIONS';

/** A decoration standing on the island (`footprint`: radius in tiles it keeps free). */
export interface GardenDecor { id: number; code: string; artKey: string; region: string; gx: number; gy: number; footprint: number }
export interface GardenDecorRegion { code: string; nameVi: string; x0: number; y0: number; x1: number; y1: number }

/** `equipped`: slot → art key; `equippedCodes`: slot → item code. A slot without an entry shows the island's own look. */
export interface GardenCosmeticState {
  equipped: Partial<Record<GardenCosmeticSlot, string>>;
  equippedCodes: Partial<Record<GardenCosmeticSlot, string>>;
  decor: GardenDecor[];
  regions: GardenDecorRegion[];
  maxPlaced: number;
  snap: number;
}

/** One shop entry: OWNED = every unit held, AVAILABLE = may be bought or claimed now, LOCKED = an earned path not reached. */
export interface GardenCosmeticItem {
  code: string;
  category: GardenCosmeticCategory;
  family: string;
  collection: string;
  nameVi: string;
  descriptionVi: string;
  artKey: string;
  unlockKind: GardenCosmeticUnlock;
  coinPrice: number;
  requirement: number;
  progress: number;
  requirementOk: boolean;
  coinsOk: boolean;
  maxOwned: number;
  owned: number;
  placed: number;
  equipped: boolean;
  status: 'OWNED' | 'AVAILABLE' | 'LOCKED';
  footprint: number;
  /** Phase 3F: the fixed VND price when this item can be bought by bank transfer now (a coin item not yet owned). */
  priceVnd?: number | null;
  /** Phase 3F: this player's open VND order for the item, if any. */
  pendingOrderId?: number | null;
}

/** A crop cultivar listed in its collection (bought / claimed / equipped through the existing skin endpoints). */
export interface GardenCosmeticSkin {
  code: string;
  cropCode: string;
  cropNameVi: string;
  collection: string;
  nameVi: string;
  descriptionVi: string;
  artKey: string;
  unlockKind: 'MASTERY' | 'COIN' | 'LEARNING' | 'REWARD';
  coinPrice: number;
  masteryTier: number;
  learningDays: number;
  masteryOk: boolean;
  learningOk: boolean;
  coinsOk: boolean;
  status: 'OWNED' | 'AVAILABLE' | 'LOCKED';
  equipped: boolean;
  priceVnd?: number | null;
  pendingOrderId?: number | null;
}

export interface GardenCosmeticCollection { code: string; nameVi: string; descriptionVi: string; items: number; owned: number }

/** `checkoutEnabled`: direct purchase with real money is open (false: it is not offered anywhere). */
export interface GardenCosmeticShop {
  coins: number;
  collections: GardenCosmeticCollection[];
  items: GardenCosmeticItem[];
  skins: GardenCosmeticSkin[];
  state: GardenCosmeticState;
  itemsOwned: number;
  itemsTotal: number;
  checkoutEnabled: boolean;
}

export interface GardenCosmeticReceipt { code: string; quantity: number; source: GardenCosmeticUnlock; coinsPaid: number; coins: number; shop: GardenCosmeticShop }
export interface GardenCosmeticEquipResult { slot: GardenCosmeticSlot; code: string | null; state: GardenCosmeticState }
/** `decor` null = the decoration went back into storage. */
export interface GardenDecorResult { decor: GardenDecor | null; state: GardenCosmeticState }

// ------------------------------------------------------------------ Phase 3C: buildings, land, contribution, rewards

export type GardenBuildingCode = 'COTTAGE' | 'WAREHOUSE' | 'MARKET';

/** One effect of a building level (code + number); `gardenModel.effectText` words it. */
export interface GardenEffect { code: string; value: number }

export interface GardenBuildingLevel { level: number; minLevel: number; coins: number; materials: GardenCompostLine[]; effects: GardenEffect[] }

/** A building of the farm (`level` 0 = not built). Every number is a server fact; the server re-checks an upgrade. */
export interface GardenBuilding {
  code: GardenBuildingCode;
  nameVi: string;
  level: number;
  maxLevel: number;
  effects: GardenEffect[];
  next: GardenBuildingLevel | null;
  levelOk: boolean;
  coinsOk: boolean;
  materialsOk: boolean;
  preview: GardenSupply[] | null;
  levels: GardenBuildingLevel[];
}

/** A compost recipe of the storehouse: today's batches against the storehouse level's cap. */
export interface GardenRecipe {
  code: 'STANDARD' | 'PREMIUM';
  units: number;
  minTier: GardenTier;
  gives: string;
  dailyCap: number;
  usedToday: number;
  remaining: number;
  held: number;
  preview: GardenSupply[] | null;
}

/** A bed of a farmland region. `coins` = what it costs this player now (learning discount applied). */
export interface GardenLandPlot {
  slot: number;
  gx: number;
  gy: number;
  coins: number;
  basePrice: number;
  materials: GardenCompostLine[];
  status: 'OWNED' | 'NEXT' | 'LATER';
  coinsOk: boolean;
  materialsOk: boolean;
  preview: GardenSupply[] | null;
}

export interface GardenRegion {
  code: string;
  nameVi: string;
  field: string;
  open: boolean;
  gate: GardenRequirement[];
  plots: GardenLandPlot[];
  owned: number;
  total: number;
}

export interface GardenLand {
  regions: GardenRegion[];
  plotsOwned: number;
  maxPlots: number;
  discount: number;
  learningDays: number;
  nextDiscountAt: number | null;
  nextDiscount: number | null;
}

/** One credited fact (or a redemption, points below 0). `nominal` above `points`: a cap left part unpaid. */
export interface GardenContributionEntry { id: number; source: string; ref: string; points: number; nominal: number; day: string; at: string }

/** Echo Contribution: a capped record of verified learning and real farm achievements — not a currency. */
export interface GardenContribution {
  balance: number;
  earned: number;
  spent: number;
  dayPoints: number;
  dayCap: number;
  weekPoints: number;
  weekCap: number;
  monthPoints: number;
  monthCap: number;
  recent: GardenContributionEntry[];
}

export type GardenRewardStatus = 'OPEN' | 'LOCKED' | 'OWNED' | 'SOLD_OUT' | 'CLOSED' | 'UNAVAILABLE';

/** A reward of the catalogue; `cost` is null while the reward has no delivery (planned, never redeemable). */
export interface GardenReward {
  code: string;
  kind: 'GARDEN_SKIN' | 'AVATAR_FRAME' | 'AI_VOUCHER' | 'PREMIUM_TRIAL';
  nameVi: string;
  descriptionVi: string;
  cost: number | null;
  status: GardenRewardStatus;
  requirements: GardenRequirement[];
  redeemed: number;
  perUserLimit: number;
}

export interface GardenRedemption { id: number; rewardCode: string; nameVi: string; cost: number; status: 'FULFILLED' | 'REVERSED'; at: string }

export interface GardenRewardShop { open: boolean; rewards: GardenReward[]; history: GardenRedemption[] }

export interface GardenEstate {
  buildings: GardenBuilding[];
  compost: GardenRecipe[];
  land: GardenLand;
  contribution: GardenContribution;
  rewards: GardenRewardShop;
}

export interface GardenBuildingReceipt { code: GardenBuildingCode; level: number; coinsPaid: number; consumed: GardenSupply[]; coins: number; estate: GardenEstate; economy: GardenEconomy }
export interface GardenLandReceipt { slot: number; region: string; coinsPaid: number; discount: number; consumed: GardenSupply[]; plot: GardenPlot; coins: number; estate: GardenEstate }
export interface GardenCompostReceipt { recipe: string; item: string; itemQty: number; consumed: GardenSupply[]; usedToday: number; remaining: number; estate: GardenEstate }
export interface GardenRewardReceipt {
  redemptionId: number;
  rewardCode: string;
  cost: number;
  balance: number;
  delivery: string;
  deliveryRef: string;
  contribution: GardenContribution;
  rewards: GardenRewardShop;
  collection: GardenCollection;
}
export interface GardenContributionPage { entries: GardenContributionEntry[]; nextBefore: number | null }

// ------------------------------------------------------------------ Phase 3B: monument, codex, skins, Echo

export type GardenFamily = 'VOCABULARY' | 'LISTENING' | 'SPEAKING' | 'WRITING' | 'EXAM';

/** One requirement of a next step: what the player has (`have`, not capped) against what is needed. */
export interface GardenRequirement { code: string; have: number; need: number; met: boolean }

/** The next era of the monument or the next mastery tier of a crop. */
export interface GardenNextStep { tier: number; requirements: GardenRequirement[] }

/** A skill branch: verified learning days of its family and its ornament tier (`enabled` false = no trustworthy record yet). */
export interface GardenBranch {
  family: GardenFamily;
  enabled: boolean;
  days: number;
  tier: number;
  maxTier: number;
  nextAt: number | null;
  today: boolean;
}

export type GardenMilestoneKind = 'ERA' | 'BRANCH' | 'MEMORY' | 'RING' | 'MASTERY' | 'SKIN';

export interface GardenMilestone { id: number; kind: GardenMilestoneKind; code: string; tier: number; reachedAt: string; seen: boolean }

/** Lifetime verified learning (participation, never proficiency). All numbers are server facts. */
export interface GardenMonument {
  era: number;
  maxEra: number;
  learningDays: number;
  learnedToday: boolean;
  branches: GardenBranch[];
  branchTiers: number;
  /** graduated trees credited to the monument (a tree counts when at least `minNewWords` of its words are new) */
  graduations: number;
  forestCount: number;
  memoryTier: number;
  memoryMaxTier: number;
  nextMemoryAt: number | null;
  next: GardenNextStep | null;
  rings: number;
  daysToNextRing: number | null;
  minCardReviews: number;
  cardsToday: number;
  minNewWords: number;
  since: string;
  recent: GardenMilestone[];
  unseen: GardenMilestone[];
}

export interface GardenMastery {
  tier: number;
  maxTier: number;
  harvests: number;
  bestTier: GardenTier | null;
  seasons: GardenTheme[];
  seasonsTotal: number;
  next: GardenNextStep | null;
  firstAt: string | null;
  lastAt: string | null;
}

/** A cosmetic skin (art only: never growth, quality, price, XP or chance). */
export interface GardenSkin {
  code: string;
  cropCode: string;
  nameVi: string;
  descriptionVi: string;
  artKey: string;
  unlockKind: 'MASTERY' | 'COIN' | 'LEARNING' | 'REWARD';
  coinPrice: number;
  masteryTier: number;
  learningDays: number;
  status: 'OWNED' | 'AVAILABLE' | 'LOCKED';
  masteryOk: boolean;
  learningOk: boolean;
  coinsOk: boolean;
  equipped: boolean;
  acquiredAt: string | null;
}

export interface GardenCodexCrop {
  cropCode: string;
  nameVi: string;
  rarity: string;
  season: 'ALL' | GardenTheme;
  unlockLevel: number;
  unlocked: boolean;
  discovered: boolean;
  forms: Array<{ form: string; firstAt: string }>;
  possibleForms: string[];
  mastery: GardenMastery;
  skins: GardenSkin[];
  equippedSkin: string | null;
}

export interface GardenCollection {
  crops: GardenCodexCrop[];
  formsFound: number;
  formsTotal: number;
  skinsOwned: number;
  skinsTotal: number;
  masteryTiers: number;
  masteryMax: number;
}

/** Echo's single contextual hint: a code + server facts; the client only words it and links to a real route. */
export interface GardenEcho { code: string; params: Record<string, unknown> }

export interface GardenLiving { monument: GardenMonument; collection: GardenCollection; echo: GardenEcho }

export interface GardenSkinReceipt {
  skinCode: string;
  cropCode: string;
  source: 'MASTERY' | 'COIN' | 'LEARNING';
  coinsPaid: number;
  coins: number;
  collection: GardenCollection;
}

export interface GardenSkinEquipResult { cropCode: string; skinCode: string | null; collection: GardenCollection }

export interface GardenMilestonesPage { milestones: GardenMilestone[]; nextBefore: number | null }

// ------------------------------------------------------------------ Phase 3A: market, delivery board, expansion

/** A delivered / composted line: exactly which produce (crop + quality tier) and how many. */
export interface GardenSupply { cropCode: string; tier: GardenTier; qty: number }

/** One market offer of today; `unitQty` items per purchase unit at `price` coins; `remaining` of today's cap. */
export interface GardenOffer {
  code: string;
  kind: 'STAPLE' | 'PACK';
  item: string;
  cropCode: string | null;
  nameVi: string;
  unitQty: number;
  price: number;
  dailyCap: number;
  bought: number;
  remaining: number;
  unlockLevel: number;
  locked: boolean;
  /** Phase 3D shop category (SEEDS for packs). */
  category?: GardenShopCategory;
}

export interface GardenMarket { dayKey: string; restockAt: string; maxPerPurchase: number; offers: GardenOffer[] }

export interface GardenOrderLine { cropCode: string; nameVi: string; qty: number; minTier: GardenTier; held: number }

export type GardenOrderStatus = 'OPEN' | 'FILLED' | 'EXPIRED';

export interface GardenOrder {
  id: number;
  slot: number;
  kind: 'DAILY' | 'WEEKLY';
  status: GardenOrderStatus;
  lines: GardenOrderLine[];
  baseCoins: number;
  /** Coins a delivery would pay right now (the Echo Blessing included when active). */
  payoutNow: number;
  bonus: Record<string, number>;
  createdAt: string;
  expiresAt: string;
  filledAt: string | null;
  paidCoins: number | null;
  blessing: boolean | null;
  delivered: GardenSupply[] | null;
  /** Default delivery (lowest accepted tiers first); null when the stock does not cover the order. */
  preview: GardenSupply[] | null;
  fillable: boolean;
}

export interface GardenBoardSlot { slot: number; kind: 'DAILY' | 'WEEKLY'; minLevel: number; locked: boolean; order: GardenOrder | null; nextAt: string }

export interface GardenBoard {
  slots: GardenBoardSlot[];
  deliveryRecord: Record<string, number>;
  filledTotal: number;
  coinMultiplier: number;
  blessingMultiplier: number;
  blessing: boolean;
}

export interface GardenCompostLine { cropCode: string; nameVi: string; qty: number; held: number }

export interface GardenExpansionPlot {
  slot: number;
  gx: number;
  gy: number;
  field: string;
  level: number;
  coins: number;
  compost: GardenCompostLine[];
  status: 'OWNED' | 'NEXT' | 'LATER';
  levelOk: boolean;
  coinsOk: boolean;
  compostOk: boolean;
  preview: GardenSupply[] | null;
}

export interface GardenExpansion { plots: GardenExpansionPlot[]; owned: number; total: number }

export interface GardenEconomy { market: GardenMarket; board: GardenBoard; expansion: GardenExpansion }

export interface GardenMarketReceipt {
  offerCode: string;
  item: string;
  units: number;
  itemsGained: number;
  coinsPaid: number;
  coins: number;
  boughtToday: number;
  remainingToday: number;
  itemQty: number;
  economy: GardenEconomy;
}

export interface GardenOrderReceipt {
  orderId: number;
  coinsPaid: number;
  blessing: boolean;
  bonus: Record<string, number>;
  delivered: GardenSupply[];
  coins: number;
  economy: GardenEconomy;
}

export interface GardenExpansionReceipt {
  slot: number;
  coinsPaid: number;
  composted: GardenSupply[];
  plot: GardenPlot;
  coins: number;
  economy: GardenEconomy;
}

// ------------------------------------------------------------------ Phase 2: memory, pests, learning

export type GardenSpecies = 'SPRING' | 'SUMMER' | 'AUTUMN' | 'WINTER';
export type GardenTreeHealth = 'HEALTHY' | 'THIRSTY' | 'WILTING';

export interface GardenTreeCard {
  flashcardId: number;
  word: string;
  meaningVi: string;
  present: boolean;
  status: string | null;
  due: boolean;
  overdue: boolean;
  reviewDays: number;
  evidence: number;
  needsAttention: boolean;
  qualifies: boolean;
  reviewedToday: boolean;
}

export interface GardenTree {
  id: number;
  slot: number;
  species: GardenSpecies;
  plantedAt: string;
  ageDays: number;
  stage: number;
  evidence: number;
  maxEvidence: number;
  health: GardenTreeHealth;
  attention: number;
  cards: GardenTreeCard[];
  essence: { available: number; accrued: number; perDay: number; store: number; fullAt: string | null; claimable: boolean };
  graduation: { eligible: boolean; blockers: string[]; ageReachedAt: string; retryAt: string | null; attempts: number; questions: number; pass: number };
  next: { stage: number; evidenceMissing: number; reachableAt: string; cardsBelowMinimum: number } | null;
  pestIds: number[];
}

export interface GardenSlot { slot: number; unlockLevel: number; unlocked: boolean; tree: GardenTree | null }

export interface GardenForestTree { id: number; species: GardenSpecies; plantedAt: string; graduatedAt: string; words: string[] }

export interface GardenKnowledge {
  slots: GardenSlot[];
  forestCount: number;
  forestSpecies: Partial<Record<GardenSpecies, number>>;
  forestRecent: GardenForestTree[];
}

export interface GardenPest {
  id: number;
  flashcardId: number;
  word: string;
  meaningVi: string | null;
  ipa: string | null;
  host: 'CROP' | 'TREE';
  plantingId: number | null;
  plotSlot: number | null;
  treeId: number | null;
  spawnedAt: string;
  reviewed: boolean;
  reviewedAt: string | null;
  slowing: boolean;
  /** Phase 3C (crop pests): 1 warning (no effect), 2 leaf damage, 3 wilting, 0 resolved by a review. */
  stage: number;
  /** when the damage worsens if the word stays unreviewed (null at the last stage or once resolved) */
  nextStageAt: string | null;
  /** when the growth penalty ends whatever happens */
  effectEndsAt: string | null;
  /** the crop was watered or fertilized after the pest appeared (the remaining growth penalty is halved) */
  tended: boolean;
}

export interface GardenLearningSource { code: string; category: 'SKILL' | 'GAME'; enabled: boolean }

export interface GardenLearning {
  skillsToday: number;
  skillCap: number;
  skillXp: number;
  fertilizerFirst: number;
  gamesToday: number;
  gameCap: number;
  gameXp: number;
  pestCuresToday: number;
  pestCureCap: number;
  sources: GardenLearningSource[];
  harvestXpRawToday: number;
  harvestFullUntil: number;
}

export interface GardenDeck { deckId: number | null; title: string; cards: number }

export interface GardenCandidate {
  flashcardId: number;
  word: string;
  meaningVi: string;
  ipa: string | null;
  status: string;
  deckId: number | null;
  deckTitle: string | null;
  overdue: boolean;
  bound: boolean;
}

export interface GardenCandidates { decks: GardenDeck[]; cards: GardenCandidate[]; limit: number }
export interface GardenKnowledgeResult { knowledge: GardenKnowledge; essence: number; treeId: number }
export interface GardenEssenceResult { treeId: number; claimed: number; essence: number; knowledge: GardenKnowledge }

export interface GardenGraduationChallenge { challengeId: string; expiresAt: string; treeId: number; questions: GardenQuestion[]; pass: number }

export interface GardenGraduationResult {
  challengeId: string;
  treeId: number;
  passed: boolean;
  recall: { correct: number; total: number; skipped: boolean; answers: GardenAnswer[] };
  pass: number;
  xpGained: number;
  essenceGained: number;
  items: Record<string, number>;
  level: { before: number; after: number; unlocked: GardenUnlock[] };
  retryAt: string | null;
  knowledge: GardenKnowledge;
}

export interface GardenForestPage { trees: GardenForestTree[]; total: number; nextBefore: number | null }
export interface GardenSprayResult { pestId: number; xp: number; rewarded: boolean; totalXp: number }

export interface GardenPlantResult { plot: GardenPlot; coins: number; seedsLeft: number; coinsPaid: number; tutorial: boolean }
export interface GardenBoostResult { plot: GardenPlot; itemCode: string; itemLeft: number }

export interface GardenQuestion { index: number; direction: 'EN_VI' | 'VI_EN'; prompt: string; ipa: string | null; options: string[] }
export interface GardenHarvestChallenge { challengeId: string; expiresAt: string; plantingIds: number[]; questions: GardenQuestion[] }

export interface GardenAnswer { index: number; chosen: number | null; correctIndex: number; correct: boolean }
export interface GardenHarvestLine {
  plantingId: number;
  plotId: number;
  cropCode: string;
  tier: GardenTier;
  score: number;
  components: { recall: number; pest: number; season: number; care: number; fresh: number };
  mutated: boolean;
  moonlit: boolean;
  xp: number;
  newForms: string[];
  rainbow: boolean;
  /** Phase 3D: Echo Coins this harvest paid (0 once the day's cap is reached). */
  coins?: number;
  /**
   * Phase 3G: 0 = the harvest paid the whole produce unit; otherwise a visitor had taken a little and the harvest paid
   * this many portions of the unit (`shareUnit` portions make one unit).
   */
  sharePortions?: number;
  shareUnit?: number;
}
export interface GardenHarvestResult {
  challengeId: string;
  recall: { correct: number; total: number; skipped: boolean; answers: GardenAnswer[] };
  harvests: GardenHarvestLine[];
  xpGained: number;
  level: { before: number; after: number; unlocked: GardenUnlock[] };
  /** Phase 3D: the harvest bonus of this harvest and the balance after it. */
  coinsGained?: number;
  coins?: number;
}

export interface GardenSellLine { cropCode: string; tier: GardenTier; qty: number }
export interface GardenSellResult {
  coinsGained: number;
  coins: number;
  blessing: boolean;
  lines: Array<GardenSellLine & { unitPrice: number; total: number }>;
}

export interface GardenAck { ok: boolean; onboardingStep: number }

/**
 * The voluntary Echo guide of this account's garden (server record). `status` null = never asked; `step` = starter
 * milestones the player went past (0-7); `invite` = the server says this is a genuinely new garden that may be offered
 * the guide once (false for every garden that was played before, after any answer, and for the administrator).
 */
export type GardenGuideStatus = 'INVITED' | 'DECLINED' | 'STARTED' | 'EXITED' | 'COMPLETED';
export type GardenGuideAction = 'SHOWN' | 'DECLINE' | 'START' | 'PROGRESS' | 'EXIT' | 'COMPLETE' | 'SETTLE';
export interface GardenGuide { status: GardenGuideStatus | null; step: number; version: number; invite: boolean }
export interface GardenGuideAck { guide: GardenGuide; onboardingStep: number }

export interface GardenApiError { code: string; details?: Record<string, unknown> }

// ------------------------------------------------------------------ Phase 3F: VND orders, Echo Rewards, profile frames

/** A cosmetic order paid by bank transfer through the existing SePay path (server facts only). */
export interface GardenCosmeticOrder {
  orderId: number;
  kind: 'COSMETIC' | 'SKIN';
  code: string;
  productName: string;
  amountVnd: number;
  currency: string;
  status: 'PENDING' | 'FULFILLED' | 'EXPIRED' | 'CANCELLED' | 'REFUNDED';
  transferCode: string;
  bankCode: string | null;
  accountNumber: string | null;
  accountName: string | null;
  qrImageUrl: string | null;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
  /** A verified transfer arrived but could not be delivered automatically; the administrator reconciles it. */
  review: string | null;
  refundStatus: 'REQUESTED' | 'COMPLETED' | 'REJECTED' | null;
  refundable: boolean;
  refundDeadline: string | null;
}

export interface GardenCosmeticOrders { checkoutEnabled: boolean; orders: GardenCosmeticOrder[] }

export interface GardenPremiumReward {
  open: boolean;
  status: 'AVAILABLE' | 'CLOSED' | 'BUDGET_EXHAUSTED' | 'PREMIUM_ACTIVE' | 'COOLDOWN' | 'WINDOW_LIMIT' | 'LEARNING_DAYS' | 'INSUFFICIENT_FUNDS';
  coinsCost: number;
  hours: number;
  learningDays: number;
  learningDaysNeeded: number;
  learningWindowDays: number;
  redeemedInWindow: number;
  maxPerWindow: number;
  windowDays: number;
  cooldownDays: number;
  activeUntil: string | null;
  nextEligibleAt: string | null;
  history: Array<{ id: number; coinsSpent: number; startsAt: string; expiresAt: string }>;
}

export interface GardenVoucherShop {
  open: boolean;
  status: 'AVAILABLE' | 'CLOSED' | 'BUDGET_EXHAUSTED' | 'CAP_REACHED';
  balance: number;
  nextExpiry: string | null;
  boughtInWindow: number;
  capCredits: number;
  capWindowDays: number;
  validDays: number;
  packs: Array<{ code: string; credits: number; coins: number; coinsOk: boolean; withinCap: boolean }>;
  grants: Array<{ credits: number; remaining: number; issuedAt: string; expiresAt: string }>;
  recent: Array<{ featureKey: string; status: 'RESERVED' | 'CONSUMED' | 'RELEASED'; at: string }>;
  eligibleFeatures: string[];
}

export interface GardenFrame {
  slug: string;
  name: string;
  tier: string;
  asset: string;
  collection: string;
  collectionName: string;
  unlockKind: 'COIN' | 'EARNED';
  coinPrice: number;
  coinsOk: boolean;
  requirements: Array<{ metric: string; target: number; progress: number; ok: boolean }>;
  status: 'OWNED' | 'AVAILABLE' | 'LOCKED';
  owned: boolean;
  equipped: boolean;
}

export interface GardenFrameShop { open: boolean; frames: GardenFrame[]; owned: number; total: number }

export interface GardenEchoRewards { coins: number; premium: GardenPremiumReward; vouchers: GardenVoucherShop; frames: GardenFrameShop }

export interface GardenPremiumRewardReceipt { rewardId: number; coinsPaid: number; coins: number; startsAt: string; expiresAt: string; rewards: GardenEchoRewards }
export interface GardenVoucherReceipt { pack: string; credits: number; coinsPaid: number; coins: number; rewards: GardenEchoRewards }
export interface GardenFrameReceipt { slug: string; coinsPaid: number; coins: number; rewards: GardenEchoRewards }
