import { CATALOG } from './catalog.mjs';

export function createStarterOwnedObjects(owner) {
  return [
    {
      instanceId: 'obj_starter_sofa',
      assetFamilyId: 'furniture.lounge_sofa',
      selectedVariantId: 'sofa_campus',
      ownerAccountId: owner,
      category: 'furniture',
      upgradeLevel: 0,
      installedComponents: {},
      customAppearance: { finishId: 'natural_oak', primaryColor: null, accentColor: null, styleFamily: 'budget_student' },
      condition: 100,
      location: { propertyId: 'prop_student_flat', zoneId: 'living', inStorage: false },
      placement: { x: -2, y: 0, z: -2.6, yaw: 0 },
      interactionState: { role: 'sit', lockedCoreProp: 'sofa' },
      ownershipStatus: 'placed',
      basePrice: 120,
      upgradeInvestment: 0,
      acquiredAt: 420,
      revision: 1,
    },
    {
      instanceId: 'obj_starter_stove',
      assetFamilyId: 'kitchen.range_oven',
      selectedVariantId: 'stove_campus',
      ownerAccountId: owner,
      category: 'kitchen_appliance',
      upgradeLevel: 0,
      installedComponents: {},
      customAppearance: { finishId: 'nordic_birch', primaryColor: null, accentColor: null, styleFamily: 'budget_student' },
      condition: 100,
      location: { propertyId: 'prop_student_flat', zoneId: 'kitchen', inStorage: false },
      placement: { x: -2.7, y: 0, z: -2.1, yaw: 0 },
      interactionState: { role: 'cook', lockedCoreProp: 'stove' },
      ownershipStatus: 'placed',
      basePrice: 150,
      upgradeInvestment: 0,
      acquiredAt: 420,
      revision: 1,
    },
    {
      instanceId: 'obj_starter_fridge',
      assetFamilyId: 'kitchen.refrigerator',
      selectedVariantId: 'fridge_campus',
      ownerAccountId: owner,
      category: 'kitchen_appliance',
      upgradeLevel: 0,
      installedComponents: {},
      customAppearance: { finishId: 'nordic_birch', primaryColor: null, accentColor: null, styleFamily: 'budget_student' },
      condition: 100,
      location: { propertyId: 'prop_student_flat', zoneId: 'kitchen', inStorage: false },
      placement: { x: 2.6, y: 0, z: -2.3, yaw: 0 },
      interactionState: { role: 'store', lockedCoreProp: 'fridge' },
      ownershipStatus: 'placed',
      basePrice: 160,
      upgradeInvestment: 0,
      acquiredAt: 420,
      revision: 1,
    },
    {
      instanceId: 'obj_starter_bed',
      assetFamilyId: 'furniture.single_bed',
      selectedVariantId: 'bed_single_campus',
      ownerAccountId: owner,
      category: 'furniture',
      upgradeLevel: 0,
      installedComponents: {},
      customAppearance: { finishId: 'natural_oak', primaryColor: null, accentColor: null, styleFamily: 'budget_student' },
      condition: 100,
      location: { propertyId: 'prop_student_flat', zoneId: 'bedroom', inStorage: false },
      placement: { x: -2, y: 0, z: -1.8, yaw: 0 },
      interactionState: { role: 'sleep', lockedCoreProp: 'bed' },
      ownershipStatus: 'placed',
      basePrice: 140,
      upgradeInvestment: 0,
      acquiredAt: 420,
      revision: 1,
    },
    {
      instanceId: 'obj_starter_wardrobe',
      assetFamilyId: 'furniture.wardrobe',
      selectedVariantId: 'wardrobe_campus',
      ownerAccountId: owner,
      category: 'furniture',
      upgradeLevel: 0,
      installedComponents: {},
      customAppearance: { finishId: 'natural_oak', primaryColor: null, accentColor: null, styleFamily: 'budget_student' },
      condition: 100,
      location: { propertyId: 'prop_student_flat', zoneId: 'bedroom', inStorage: false },
      placement: { x: 2, y: 0, z: -1.8, yaw: 0 },
      interactionState: { role: 'outfit', lockedCoreProp: 'wardrobe' },
      ownershipStatus: 'placed',
      basePrice: 130,
      upgradeInvestment: 0,
      acquiredAt: 420,
      revision: 1,
    },
    {
      instanceId: 'obj_starter_bike',
      assetFamilyId: 'vehicle.two_wheeler',
      selectedVariantId: 'bicycle',
      ownerAccountId: owner,
      category: 'vehicle_rideable',
      upgradeLevel: 0,
      installedComponents: { vehicleId: 'veh_starter_bike', wheels: null, brakes: null, accessory: null, performance: null, paint: null },
      customAppearance: { finishId: 'natural_oak', primaryColor: null, accentColor: null, styleFamily: 'budget_student' },
      condition: 100,
      location: { propertyId: 'prop_student_flat', zoneId: 'yard', inStorage: false },
      placement: { x: 3, y: 0, z: 1, yaw: 0 },
      interactionState: { drivable: true, vehicleClass: 'bicycle', lockedCoreProp: 'bike' },
      ownershipStatus: 'placed',
      basePrice: 120,
      upgradeInvestment: 0,
      acquiredAt: 420,
      revision: 1,
    },
  ];
}

export function createProgression(owner = 'local', startingCredits = CATALOG.economy.currency.startingBalance) {
  const skills = {};
  for (const id of Object.keys(CATALOG.skills.skills)) {
    skills[id] = { xp: 0, level: 1 };
  }
  const materials = {};
  for (const [id, m] of Object.entries(CATALOG.economy.materials)) {
    materials[id] = m.startingQty;
  }
  return {
    playerLevel: 1,
    totalXp: 0,
    economy: {
      credits: startingCredits,
      lifetimeEarned: startingCredits,
      lifetimeSpent: 0,
      dailyEarnings: 0,
      shiftCountsToday: 0,
      minigameWinsToday: 0,
      shopkeepingRunsToday: 0,
      lastResetDay: 0,
    },
    skills,
    materials,
    componentInventory: [],
    ownedObjects: createStarterOwnedObjects(owner),
    nextInstanceSeq: 100,
    unlockedOutfits: ['student', 'student2', 'gemini', 'geminiSport'],
    unlockedStyles: ['budget_student'],
    properties: {
      ownedIds: ['prop_student_flat'],
      activePropertyId: 'prop_student_flat',
    },
    roomStyles: {
      study: 'budget_student',
      living: 'budget_student',
      kitchen: 'budget_student',
      bedroom: 'budget_student',
      bath: 'budget_student',
      gaming_room: 'budget_student',
      garage: 'budget_student',
      yard: 'budget_student',
      balcony: 'budget_student',
    },
    activeVehicleId: 'obj_starter_bike',
    reputation: {
      neighbourhood: 10,
      campus: 10,
      craft: 0,
      hosting: 0,
    },
    achievements: [],
    sideMissions: {
      pc_upgrade_arc: { stage: 0, done: false },
      home_design_arc: { stage: 0, done: false },
      kitchen_chef_arc: { stage: 0, done: false },
      mobility_tuner_arc: { stage: 0, done: false },
    },
    commissionsDone: {},
    shopStock: {},
    undoStack: [],
    redoStack: [],
  };
}

export function syncCredits(state) {
  if (!state.progression) return;
  state.cash = state.progression.economy.credits;
}

export function resetDailyEconomyIfNeeded(state) {
  const econ = state.progression?.economy;
  if (!econ) return;
  if (state.day > (econ.lastResetDay ?? 0)) {
    econ.lastResetDay = state.day;
    econ.dailyEarnings = 0;
    econ.shiftCountsToday = 0;
    econ.minigameWinsToday = 0;
    econ.shopkeepingRunsToday = 0;
  }
}
