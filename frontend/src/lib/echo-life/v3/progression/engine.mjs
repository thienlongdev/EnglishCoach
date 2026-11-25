import {
  CATALOG, findSku, getUpgrade, getProperty, getRoomStyle,
  getVehicleSpec, getVehicleComponent, getPcPart,
} from './catalog.mjs';
import { resetDailyEconomyIfNeeded, syncCredits } from './state.mjs';
import {
  awardSkillXp, awardReputation, unlockAchievement,
  checkSkillRequirements, discountedPrice,
} from './skills.mjs';
import { installPcPart, computePcStats } from './pc-builder.mjs';
import {
  placeOrMoveObject, rotatePlacedObject, storePlacedObject,
  customizeObjectFinish, findOpenPlacementSpot, undoBuild, redoBuild,
} from './placement.mjs';
import { summonCarToRoadZone } from '../vehicles/car.mjs';
import { advanceSideQuests } from '../story-and-quests/side-quests.mjs';
import { recordTutorialSignal } from '../gameplay/tutorial.mjs';

const GUARDS = CATALOG.economy.antiExploitGuards;

export function assertOwnership(state, instanceId, actorOwner) {
  const obj = state.progression?.ownedObjects?.find(o => o.instanceId === instanceId);
  if (!obj) return { ok: false, code: 404, msg: 'Object instance not found.' };
  if (obj.ownerAccountId !== actorOwner) {
    return { ok: false, code: 403, msg: 'OWNERSHIP_VIOLATION: You do not own this object.' };
  }
  return { ok: true, obj };
}

function addMaterials(state, delta = {}) {
  for (const [m, q] of Object.entries(delta)) {
    if (!Object.hasOwn(state.progression.materials, m)) continue;
    state.progression.materials[m] = Math.max(0, (state.progression.materials[m] || 0) + q);
  }
}

function hasMaterials(state, req = {}) {
  for (const [m, q] of Object.entries(req || {})) {
    if ((state.progression.materials[m] || 0) < q) {
      return { ok: false, msg: `Need ${q}x ${CATALOG.economy.materials[m]?.name || m}.` };
    }
  }
  return { ok: true };
}

export function awardCredits(state, amount, { bounded = true } = {}) {
  resetDailyEconomyIfNeeded(state);
  const econ = state.progression.economy;
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  let grant = Math.round(amount);
  if (bounded) {
    const remaining = Math.max(0, GUARDS.maxDailyActivityCreditsCap - econ.dailyEarnings);
    grant = Math.min(grant, remaining);
    econ.dailyEarnings += grant;
  }
  econ.credits = Math.min(CATALOG.economy.currency.maxSafeBalance, econ.credits + grant);
  econ.lifetimeEarned += grant;
  syncCredits(state);
  return grant;
}

export function spendCredits(state, amount) {
  const econ = state.progression.economy;
  if (!Number.isSafeInteger(amount) || amount < 0) return { ok: false, msg: 'Invalid credit amount.' };
  if (econ.credits < amount) return { ok: false, msg: `Need ${amount} CC (balance: ${econ.credits} CC).` };
  econ.credits -= amount;
  econ.lifetimeSpent += amount;
  syncCredits(state);
  return { ok: true };
}

export function performWorkActivity(state, activityId, actorOwner) {
  if (actorOwner && actorOwner !== state.owner) return { ok: false, code: 403, msg: 'OWNERSHIP_VIOLATION' };
  resetDailyEconomyIfNeeded(state);
  const act = CATALOG.economy.earningActivities[activityId];
  if (!act) return { ok: false, msg: 'Unknown activity.' };
  const econ = state.progression.economy;
  const isShop = activityId === 'shopkeeping_popup';
  if (isShop && econ.shopkeepingRunsToday >= GUARDS.maxShopkeepingRunsPerGameDay) {
    return { ok: false, msg: 'Daily shopkeeping shift limit reached. Rest until tomorrow.' };
  }
  if (!isShop && econ.shiftCountsToday >= GUARDS.maxPartTimeShiftsPerGameDay) {
    return { ok: false, msg: `Daily part-time shift limit (${GUARDS.maxPartTimeShiftsPerGameDay}) reached. Rest or explore other activities.` };
  }
  if (state.needs.energy < (act.requires?.minEnergy || 15)) {
    return { ok: false, msg: 'Too tired for a shift. Sleep or eat to restore energy.' };
  }
  const sk = checkSkillRequirements(state, act.requires?.minSkill, 1);
  if (!sk.ok) return { ok: false, msg: sk.reason };

  const granted = awardCredits(state, act.credits, { bounded: true });
  if (granted <= 0) return { ok: false, msg: 'Daily earning cap reached. Rest until tomorrow.' };
  state.needs.energy = Math.max(0, state.needs.energy - act.energyCost);
  state.clock += act.clockMinutes;
  if (isShop) econ.shopkeepingRunsToday++;
  else econ.shiftCountsToday++;
  addMaterials(state, act.materials);
  awardSkillXp(state, act.skill, act.skillXp);
  awardReputation(state, isShop ? 'hosting' : 'neighbourhood', 8);
  state.saveRevision = (state.saveRevision || 0) + 1;
  return { ok: true, msg: `${act.name}: +${granted} CC, +${act.skillXp} ${CATALOG.skills.skills[act.skill].name} XP.`, creditsEarned: granted };
}

export function performNpcCommission(state, commissionId, actorOwner) {
  if (actorOwner && actorOwner !== state.owner) return { ok: false, code: 403, msg: 'OWNERSHIP_VIOLATION' };
  const com = CATALOG.economy.npcOpportunities[commissionId];
  if (!com) return { ok: false, msg: 'Unknown resident opportunity.' };
  const lastDay = state.progression.commissionsDone[commissionId];
  if (lastDay !== undefined && state.day - lastDay < com.cooldownDays) {
    return { ok: false, msg: `${com.title} will be available again in ${com.cooldownDays - (state.day - lastDay)} day(s).` };
  }
  const granted = awardCredits(state, com.credits, { bounded: false });
  addMaterials(state, com.materials);
  awardSkillXp(state, com.skill, com.skillXp);
  awardReputation(state, 'neighbourhood', 18);
  if (state.npcs[com.npc]) state.npcs[com.npc].friend = Math.min(100, state.npcs[com.npc].friend + 4);
  state.progression.commissionsDone[commissionId] = state.day;
  state.saveRevision = (state.saveRevision || 0) + 1;
  return { ok: true, msg: `Completed ${com.title}: +${granted} CC & materials!`, creditsEarned: granted };
}

function nextInstanceId(state, prefix = 'obj') {
  const seq = (state.progression.nextInstanceSeq = (state.progression.nextInstanceSeq || 100) + 1);
  return `${prefix}_${seq}`;
}

export function buyShopItem(state, storeId, sku, actorOwner, opts = {}) {
  // Server NEVER trusts a client-supplied ownerAccountId; always binds to actorOwner (session principal)
  const owner = actorOwner || state.owner;
  if (owner !== state.owner) return { ok: false, code: 403, msg: 'OWNERSHIP_VIOLATION: Principal mismatch.' };
  const item = findSku(storeId, sku);
  if (!item) return { ok: false, code: 404, msg: `Item ${sku} not found in ${storeId}.` };

  const sk = checkSkillRequirements(state, item.reqSkill, item.reqLevel || 1);
  if (!sk.ok) return { ok: false, msg: sk.reason };

  const price = discountedPrice(state, item.price);
  if (state.progression.economy.credits < price) {
    return { ok: false, msg: `Need ${price} CC to buy ${item.name} (balance: ${state.progression.economy.credits} CC).` };
  }

  if (item.itemType === 'outfit') {
    if (state.progression.unlockedOutfits.includes(item.outfitId)) {
      state.avatar = item.outfitId;
      return { ok: true, msg: `Equipped ${item.name}.` };
    }
    const pay = spendCredits(state, price);
    if (!pay.ok) return pay;
    state.progression.unlockedOutfits.push(item.outfitId);
    state.avatar = item.outfitId;
    awardSkillXp(state, 'social', 15);
    state.saveRevision = (state.saveRevision || 0) + 1;
    return { ok: true, msg: `Purchased & equipped ${item.name} for ${price} CC.` };
  }

  if (item.itemType === 'material') {
    const pay = spendCredits(state, price);
    if (!pay.ok) return pay;
    addMaterials(state, { [item.materialId]: item.qty });
    awardSkillXp(state, 'business', 8);
    state.saveRevision = (state.saveRevision || 0) + 1;
    return { ok: true, msg: `Purchased ${item.name} for ${price} CC.` };
  }

  if (item.itemType === 'material_bundle') {
    const pay = spendCredits(state, price);
    if (!pay.ok) return pay;
    addMaterials(state, item.materials);
    awardSkillXp(state, 'diy_design', 10);
    state.saveRevision = (state.saveRevision || 0) + 1;
    return { ok: true, msg: `Purchased ${item.name} for ${price} CC.` };
  }

  if (item.itemType === 'grocery') {
    const pay = spendCredits(state, price);
    if (!pay.ok) return pay;
    const prodMap = { eggs: { egg: 2 }, noodles: { noodle: 1, greens: 1 }, rice: { rice: 1, meat: 1, greens: 1 } };
    for (const [k, v] of Object.entries(prodMap[item.productId] || {})) {
      state.bag[k] = (state.bag[k] || 0) + v;
    }
    state.saveRevision = (state.saveRevision || 0) + 1;
    return { ok: true, msg: `Bought ${item.name} for ${price} CC.` };
  }

  if (item.itemType === 'pc_component') {
    // Optionally install directly onto a target PC instance or store in componentInventory
    if (opts.targetInstanceId) {
      const own = assertOwnership(state, opts.targetInstanceId, owner);
      if (!own.ok) return own;
      return installPcPart(state, own.obj, item.slot, item.componentId, { fromInventory: false, priceOverride: price });
    }
    const pay = spendCredits(state, price);
    if (!pay.ok) return pay;
    state.progression.componentInventory.push({
      itemId: nextInstanceId(state, 'part'),
      kind: 'pc_component',
      slot: item.slot,
      componentId: item.componentId,
      name: item.name,
      ownerAccountId: owner,
    });
    awardSkillXp(state, 'technology', 10);
    state.saveRevision = (state.saveRevision || 0) + 1;
    return { ok: true, msg: `Purchased ${item.name} (${price} CC) into PC parts storage.` };
  }

  if (item.itemType === 'vehicle_component') {
    if (opts.targetInstanceId) {
      return customizeVehicle(state, opts.targetInstanceId, item.componentId, owner, { priceOverride: price });
    }
    const pay = spendCredits(state, price);
    if (!pay.ok) return pay;
    state.progression.componentInventory.push({
      itemId: nextInstanceId(state, 'vpart'),
      kind: 'vehicle_component',
      componentId: item.componentId,
      name: item.name,
      ownerAccountId: owner,
    });
    awardSkillXp(state, 'mobility', 10);
    state.saveRevision = (state.saveRevision || 0) + 1;
    return { ok: true, msg: `Purchased ${item.name} (${price} CC) into vehicle parts storage.` };
  }

  if (item.itemType === 'vehicle') {
    const spec = getVehicleSpec(item.vehicleId);
    if (!spec) return { ok: false, msg: 'Unknown vehicle spec.' };
    const pay = spendCredits(state, price);
    if (!pay.ok) return pay;
    const isCar = !spec.drivable;
    const instance = {
      instanceId: nextInstanceId(state, isCar ? 'car' : 'veh'),
      assetFamilyId: isCar ? 'vehicle.automobile_display' : 'vehicle.two_wheeler',
      selectedVariantId: spec.model,
      ownerAccountId: owner,
      category: isCar ? 'vehicle_display' : 'vehicle_rideable',
      upgradeLevel: 0,
      installedComponents: { vehicleId: spec.id, wheels: null, brakes: null, accessory: null, performance: null, paint: null, interior: null, exterior: null },
      customAppearance: { finishId: 'natural_oak', primaryColor: null, accentColor: null, styleFamily: 'modern' },
      condition: 100,
      location: { propertyId: state.progression.properties.activePropertyId, zoneId: isCar ? 'garage' : 'yard', inStorage: false },
      placement: isCar ? { x: 0, y: 0, z: -1.4, yaw: 0.35 } : { x: state.bike.x, y: 0, z: state.bike.z, yaw: state.bike.yaw },
      interactionState: { drivable: spec.drivable, vehicleClass: spec.vehicleClass, gameplayCapability: spec.gameplayCapability },
      ownershipStatus: 'placed',
      basePrice: item.price,
      upgradeInvestment: 0,
      acquiredAt: Math.floor(state.clock),
      revision: 1,
    };
    state.progression.ownedObjects.push(instance);
    if (spec.drivable) {
      state.progression.activeVehicleId = instance.instanceId;
      awardSkillXp(state, 'mobility', 35);
      unlockAchievement(state, 'two_wheel_tuner');
    } else {
      awardSkillXp(state, 'business', 40);
      awardReputation(state, 'neighbourhood', 30);
      unlockAchievement(state, 'garage_collector');
    }
    state.saveRevision = (state.saveRevision || 0) + 1;
    return { ok: true, msg: `Purchased ${spec.name} for ${price} CC!`, instance };
  }

  if (item.itemType === 'owned_object') {
    const pay = spendCredits(state, price);
    if (!pay.ok) return pay;
    const instance = {
      instanceId: nextInstanceId(state, item.category === 'electronics_pc' ? 'pc' : 'obj'),
      assetFamilyId: item.assetFamilyId,
      selectedVariantId: item.variantId,
      ownerAccountId: owner,
      category: item.category,
      upgradeLevel: 0,
      installedComponents: structuredClone(item.defaultComponents || {}),
      customAppearance: { finishId: 'natural_oak', primaryColor: null, accentColor: null, styleFamily: item.styleFamily || 'budget_student' },
      condition: 100,
      location: { propertyId: state.progression.properties.activePropertyId, zoneId: null, inStorage: true },
      placement: { x: 0, y: 0, z: 0, yaw: 0 },
      interactionState: item.category === 'electronics_pc' ? { poweredOn: true, standingHeight: false } : {},
      ownershipStatus: 'stored',
      basePrice: item.price,
      upgradeInvestment: 0,
      acquiredAt: Math.floor(state.clock),
      revision: 1,
    };
    state.progression.ownedObjects.push(instance);
    if (opts.autoPlaceZone) {
      const spot = findOpenPlacementSpot(state, instance.instanceId, opts.autoPlaceZone);
      if (spot) placeOrMoveObject(state, instance, opts.autoPlaceZone, spot.x, spot.z, spot.yaw, false);
    }
    if (item.category === 'electronics_pc') {
      awardSkillXp(state, 'technology', 25);
      unlockAchievement(state, 'first_pc_build');
      if (state.progression.sideMissions?.pc_upgrade_arc) {
        state.progression.sideMissions.pc_upgrade_arc.stage = Math.max(state.progression.sideMissions.pc_upgrade_arc.stage, 1);
      }
    } else {
      awardSkillXp(state, 'diy_design', 16);
    }
    state.saveRevision = (state.saveRevision || 0) + 1;
    return { ok: true, msg: `Purchased ${item.name} for ${price} CC!`, instance };
  }

  return { ok: false, msg: 'Unsupported shop item type.' };
}

export function sellOwnedObject(state, instanceId, actorOwner) {
  const own = assertOwnership(state, instanceId, actorOwner || state.owner);
  if (!own.ok) return own;
  const obj = own.obj;
  if (obj.interactionState?.lockedCoreProp) {
    return { ok: false, msg: 'Core home essentials cannot be sold.' };
  }
  const resale = Math.max(
    1,
    Math.floor((obj.basePrice || 50) * GUARDS.resaleBaseRatio + (obj.upgradeInvestment || 0) * GUARDS.resaleUpgradeRatio)
  );
  state.progression.ownedObjects = state.progression.ownedObjects.filter(o => o.instanceId !== instanceId);
  if (state.progression.activeVehicleId === instanceId) state.progression.activeVehicleId = 'obj_starter_bike';
  awardCredits(state, resale, { bounded: false });
  awardSkillXp(state, 'business', 12);
  state.saveRevision = (state.saveRevision || 0) + 1;
  return { ok: true, msg: `Sold object for ${resale} CC.`, resaleCredits: resale };
}

export function applyObjectUpgrade(state, instanceId, upgradeId, actorOwner) {
  const own = assertOwnership(state, instanceId, actorOwner || state.owner);
  if (!own.ok) return own;
  const obj = own.obj;
  const upg = getUpgrade(upgradeId);
  if (!upg) return { ok: false, code: 404, msg: `Unknown upgrade: ${upgradeId}` };
  if (upg.sourceVariant !== obj.selectedVariantId) {
    return { ok: false, msg: `Upgrade requires ${upg.sourceVariant}, but object is ${obj.selectedVariantId}.` };
  }
  const sk = checkSkillRequirements(state, upg.requiredSkills, upg.requiredLevel);
  if (!sk.ok) return { ok: false, msg: sk.reason };
  const mat = hasMaterials(state, upg.requiredMaterials);
  if (!mat.ok) return mat;

  const cost = discountedPrice(state, upg.creditsCost);
  const pay = spendCredits(state, cost);
  if (!pay.ok) return pay;
  for (const [m, q] of Object.entries(upg.requiredMaterials || {})) {
    state.progression.materials[m] -= q;
  }

  obj.selectedVariantId = upg.targetVariant;
  if (obj.category === 'vehicle_rideable' && getVehicleSpec(upg.targetVariant)) {
    obj.installedComponents = { ...(obj.installedComponents || {}), vehicleId: upg.targetVariant };
  }
  obj.upgradeLevel = Math.min(10, (obj.upgradeLevel || 0) + 1);
  obj.upgradeInvestment = (obj.upgradeInvestment || 0) + cost;
  obj.condition = 100;
  obj.revision = (obj.revision || 1) + 1;
  state.saveRevision = (state.saveRevision || 0) + 1;

  if (obj.category === 'kitchen_appliance') {
    awardSkillXp(state, 'cooking', 45);
    unlockAchievement(state, 'chef_kitchen_upgrade');
    if (state.progression.sideMissions?.kitchen_chef_arc) state.progression.sideMissions.kitchen_chef_arc = { stage: 2, done: true };
  } else if (obj.category === 'electronics_pc') {
    awardSkillXp(state, 'technology', 55);
  } else if (obj.category === 'vehicle_rideable') {
    awardSkillXp(state, 'mobility', 45);
    unlockAchievement(state, 'two_wheel_tuner');
  } else {
    awardSkillXp(state, 'diy_design', 40);
  }
  awardReputation(state, 'craft', 20);
  return { ok: true, msg: `Upgraded to ${upg.targetVariant}! ${upg.visualTransformation}`, instance: obj };
}

export function applyRoomStyle(state, zoneId, styleId, actorOwner) {
  if (actorOwner && actorOwner !== state.owner) return { ok: false, code: 403, msg: 'OWNERSHIP_VIOLATION' };
  const style = getRoomStyle(styleId);
  if (!style) return { ok: false, msg: `Unknown room style: ${styleId}` };
  const prop = getProperty(state.progression.properties.activePropertyId);
  if (prop && style.tier > prop.maxStyleTier) {
    return { ok: false, msg: `${style.name} requires a higher-tier property (max tier for ${prop.name}: ${prop.maxStyleTier}).` };
  }

  const unlocked = state.progression.unlockedStyles.includes(styleId);
  if (!unlocked) {
    const sk = checkSkillRequirements(state, style.reqSkill, 1);
    if (!sk.ok) return { ok: false, msg: sk.reason };
    const mat = hasMaterials(state, style.materials);
    if (!mat.ok) return mat;
    const cost = discountedPrice(state, style.unlockCost);
    const pay = spendCredits(state, cost);
    if (!pay.ok) return pay;
    for (const [m, q] of Object.entries(style.materials || {})) state.progression.materials[m] -= q;
    state.progression.unlockedStyles.push(styleId);
  }

  state.progression.roomStyles[zoneId] = styleId;

  // Visibly restyle compatible owned furniture in that room to the style collection's real GLBs!
  const mapFamilyToRole = {
    'furniture.single_bed': 'bed',
    'furniture.wardrobe': 'wardrobe',
    'furniture.night_table': 'night_table',
    'furniture.lounge_sofa': 'sofa',
    'furniture.coffee_table': 'coffee_table',
    'furniture.bookcase': 'bookcase',
    'furniture.floor_lamp': 'lamp',
    'kitchen.range_oven': 'stove',
    'kitchen.refrigerator': 'fridge',
    'kitchen.sink_unit': 'sink',
    'furniture.workstation_desk': 'desk',
  };
  let updatedCount = 0;
  for (const obj of state.progression.ownedObjects) {
    if (obj.location.zoneId === zoneId && !obj.location.inStorage) {
      const slotKey = mapFamilyToRole[obj.assetFamilyId];
      if (slotKey && style.furnitureModels[slotKey]) {
        obj.selectedVariantId = style.furnitureModels[slotKey];
        obj.customAppearance = { ...(obj.customAppearance || {}), styleFamily: styleId };
        obj.upgradeLevel = Math.max(obj.upgradeLevel || 0, style.tier - 1);
        obj.revision = (obj.revision || 1) + 1;
        updatedCount++;
      }
    }
  }

  awardSkillXp(state, 'diy_design', 50);
  awardReputation(state, 'hosting', 20);
  if (zoneId === 'bedroom' && styleId !== 'budget_student') unlockAchievement(state, 'bedroom_makeover');
  state.saveRevision = (state.saveRevision || 0) + 1;
  return { ok: true, msg: `Applied ${style.name} style to ${zoneId} (${updatedCount} pieces restyled).` };
}

export function buyAndSwitchProperty(state, propertyId, actorOwner) {
  if (actorOwner && actorOwner !== state.owner) return { ok: false, code: 403, msg: 'OWNERSHIP_VIOLATION' };
  const prop = getProperty(propertyId);
  if (!prop) return { ok: false, code: 404, msg: `Unknown property: ${propertyId}` };

  const owned = state.progression.properties.ownedIds.includes(propertyId);
  if (!owned) {
    const sk = checkSkillRequirements(state, prop.reqSkill, prop.reqLevel);
    if (!sk.ok) return { ok: false, msg: sk.reason };
    const cost = discountedPrice(state, prop.price);
    const pay = spendCredits(state, cost);
    if (!pay.ok) return pay;
    state.progression.properties.ownedIds.push(propertyId);
    awardSkillXp(state, 'business', 90);
    awardReputation(state, 'hosting', prop.prestigeBonus);
    if (propertyId === 'prop_cozy_townhouse') unlockAchievement(state, 'townhouse_owner');
    if (propertyId === 'prop_tropical_villa') unlockAchievement(state, 'villa_owner');
    if (propertyId === 'prop_grand_palais') unlockAchievement(state, 'palace_patron');
  }

  state.progression.properties.activePropertyId = propertyId;
  state.saveRevision = (state.saveRevision || 0) + 1;
  return { ok: true, msg: `Active residence is now ${prop.name} (${prop.exteriorModel}).`, property: prop };
}

export function customizeVehicle(state, instanceId, componentId, actorOwner, opts = {}) {
  const own = assertOwnership(state, instanceId, actorOwner || state.owner);
  if (!own.ok) return own;
  const obj = own.obj;
  if (obj.category !== 'vehicle_rideable' && obj.category !== 'vehicle_display') {
    return { ok: false, msg: 'Target object is not a vehicle.' };
  }
  const comp = getVehicleComponent(componentId);
  if (!comp) return { ok: false, msg: `Unknown vehicle component: ${componentId}` };
  const vClass = obj.interactionState?.vehicleClass || 'bicycle';
  if (!comp.appliesTo.includes(vClass)) {
    return { ok: false, msg: `${comp.name} is not compatible with ${vClass}.` };
  }
  const sk = checkSkillRequirements(state, comp.reqSkill, 1);
  if (!sk.ok) return { ok: false, msg: sk.reason };

  if (!opts.fromInventory) {
    const mat = hasMaterials(state, comp.materials);
    if (!mat.ok) return mat;
    const cost = opts.priceOverride ?? discountedPrice(state, comp.price);
    const pay = spendCredits(state, cost);
    if (!pay.ok) return pay;
    for (const [m, q] of Object.entries(comp.materials || {})) state.progression.materials[m] -= q;
    obj.upgradeInvestment = (obj.upgradeInvestment || 0) + cost;
  }

  obj.installedComponents = { ...(obj.installedComponents || {}), [comp.slot]: comp.id };
  if (comp.colorHex) {
    obj.customAppearance = { ...(obj.customAppearance || {}), primaryColor: comp.colorHex, finishId: comp.id };
  }
  if (comp.visualVariantModel && obj.category === 'vehicle_rideable') {
    obj.selectedVariantId = comp.visualVariantModel;
  }
  obj.upgradeLevel = Math.min(10, (obj.upgradeLevel || 0) + 1);
  obj.revision = (obj.revision || 1) + 1;
  state.saveRevision = (state.saveRevision || 0) + 1;

  awardSkillXp(state, obj.category === 'vehicle_rideable' ? 'mobility' : 'diy_design', 35);
  unlockAchievement(state, obj.category === 'vehicle_rideable' ? 'two_wheel_tuner' : 'garage_collector');
  return { ok: true, msg: `Installed ${comp.name} on vehicle.`, instance: obj };
}

export function selectActiveVehicle(state, instanceId, actorOwner) {
  const own = assertOwnership(state, instanceId, actorOwner || state.owner);
  if (!own.ok) return own;
  if (own.obj.category !== 'vehicle_rideable' || !own.obj.interactionState?.drivable) {
    return { ok: false, msg: 'This vehicle is a non-drivable Garage Display car. Only two-wheelers can be ridden outdoors.' };
  }
  state.progression.activeVehicleId = instanceId;
  state.saveRevision = (state.saveRevision || 0) + 1;
  return { ok: true, msg: `Active rideable vehicle switched to ${own.obj.selectedVariantId}.` };
}

export function repairOwnedObject(state, instanceId, actorOwner) {
  const own = assertOwnership(state, instanceId, actorOwner || state.owner);
  if (!own.ok) return own;
  const obj = own.obj;
  const wear = Math.max(0, 100 - (obj.condition ?? 100));
  if (wear < 1) return { ok: true, msg: 'Already in pristine condition.' };
  const fee = Math.max(5, Math.round(((obj.basePrice || 100) * 0.12) * (wear / 100)));
  const pay = spendCredits(state, fee);
  if (!pay.ok) return pay;
  obj.condition = 100;
  obj.revision = (obj.revision || 1) + 1;
  awardSkillXp(state, 'diy_design', 22);
  state.saveRevision = (state.saveRevision || 0) + 1;
  return { ok: true, msg: `Repaired object to 100% condition for ${fee} CC.` };
}

export function getActiveVehiclePhysics(state) {
  const activeId = state.progression?.activeVehicleId;
  const obj = state.progression?.ownedObjects?.find(o => o.instanceId === activeId)
    || state.progression?.ownedObjects?.find(o => o.category === 'vehicle_rideable');
  const base = { model: 'bicycle', paintHex: null, maxSpeed: 7.5, acceleration: 4.0, braking: 12.0, handling: 1.6, cargoSlots: 1, drivable: true };
  if (!obj || !obj.interactionState?.drivable) return base;
  const spec = getVehicleSpec(obj.selectedVariantId) || getVehicleSpec(obj.installedComponents?.vehicleId) || CATALOG.vehicles.vehicles[0];
  const phys = { ...base, ...(spec.ridePhysics || {}), model: obj.selectedVariantId || spec.model, paintHex: obj.customAppearance?.primaryColor || null };
  for (const slot of ['wheels', 'brakes', 'accessory', 'performance']) {
    const cid = obj.installedComponents?.[slot];
    if (!cid) continue;
    const comp = getVehicleComponent(cid);
    if (comp?.physicsDelta) {
      for (const [k, delta] of Object.entries(comp.physicsDelta)) {
        phys[k] = Number(((phys[k] || 0) + delta).toFixed(2));
      }
    }
  }
  return phys;
}

export function executeProgressionAction(state, action, actorOwner) {
  // Always strip client-supplied ownerAccountId — authority comes ONLY from actorOwner!
  const owner = actorOwner || state.owner;
  if (!action || typeof action !== 'object') return { ok: false, code: 400, msg: 'Invalid action.' };
  switch (action.type) {
    case 'work_activity': return performWorkActivity(state, action.activityId, owner);
    case 'npc_commission': return performNpcCommission(state, action.commissionId, owner);
    case 'buy_item': {
      const res = buyShopItem(state, action.storeId, action.sku, owner, { targetInstanceId: action.targetInstanceId, autoPlaceZone: action.autoPlaceZone });
      if (res.ok) recordTutorialSignal(state, 'purchasedItem');
      return res;
    }
    case 'sell_object': return sellOwnedObject(state, action.instanceId, owner);
    case 'upgrade_object': {
      const res = applyObjectUpgrade(state, action.instanceId, action.upgradeId, owner);
      if (res.ok) {
        recordTutorialSignal(state, 'usedBuildMode');
        advanceSideQuests(state, 'progression:build_styled');
        if (res.instance?.category === 'vehicle_rideable') advanceSideQuests(state, 'activity:delivery_or_tune');
      }
      return res;
    }
    case 'install_pc_part': {
      const own = assertOwnership(state, action.instanceId, owner);
      if (!own.ok) return own;
      const invIdx = (state.progression.componentInventory || []).findIndex(
        c => c.kind === 'pc_component' && c.slot === action.slot && c.componentId === action.componentId
      );
      let res;
      if (invIdx >= 0) {
        res = installPcPart(state, own.obj, action.slot, action.componentId, { fromInventory: true });
        if (res.ok) state.progression.componentInventory.splice(invIdx, 1);
      } else {
        const part = getPcPart(action.slot, action.componentId);
        const price = part ? discountedPrice(state, part.price) : 0;
        res = installPcPart(state, own.obj, action.slot, action.componentId, { fromInventory: false, priceOverride: price });
      }
      if (res.ok) advanceSideQuests(state, 'progression:pc_upgraded');
      return res;
    }
    case 'place_object': {
      const own = assertOwnership(state, action.instanceId, owner);
      if (!own.ok) return own;
      const res = placeOrMoveObject(state, own.obj, action.zoneId, action.x, action.z, action.yaw || 0, true);
      if (res.ok) { recordTutorialSignal(state, 'usedBuildMode'); advanceSideQuests(state, 'progression:build_styled'); }
      return res;
    }
    case 'rotate_object': {
      const own = assertOwnership(state, action.instanceId, owner);
      if (!own.ok) return own;
      const res = rotatePlacedObject(state, own.obj, action.delta ?? Math.PI / 2);
      if (res.ok) { recordTutorialSignal(state, 'usedBuildMode'); advanceSideQuests(state, 'progression:build_styled'); }
      return res;
    }
    case 'store_object': {
      const own = assertOwnership(state, action.instanceId, owner);
      if (!own.ok) return own;
      return storePlacedObject(state, own.obj, true);
    }
    case 'customize_material': {
      const own = assertOwnership(state, action.instanceId, owner);
      if (!own.ok) return own;
      const res = customizeObjectFinish(state, own.obj, action.finishId, true);
      if (res.ok) { recordTutorialSignal(state, 'usedBuildMode'); advanceSideQuests(state, 'progression:build_styled'); }
      return res;
    }
    case 'undo_build': return undoBuild(state, owner);
    case 'redo_build': return redoBuild(state, owner);
    case 'apply_room_style': {
      const res = applyRoomStyle(state, action.zoneId, action.styleId, owner);
      if (res.ok) { recordTutorialSignal(state, 'usedBuildMode'); advanceSideQuests(state, 'progression:build_styled'); }
      return res;
    }
    case 'buy_switch_property': return buyAndSwitchProperty(state, action.propertyId, owner);
    case 'customize_vehicle': {
      const res = customizeVehicle(state, action.instanceId, action.componentId, owner);
      if (res.ok) advanceSideQuests(state, 'activity:delivery_or_tune');
      return res;
    }
    case 'select_vehicle': return selectActiveVehicle(state, action.instanceId, owner);
    case 'summon_car': {
      if (action.instanceId) {
        const own = assertOwnership(state, action.instanceId, owner);
        if (!own.ok) return own;
        if (state.worldV3?.car) state.worldV3.car.instanceId = own.obj.instanceId;
      }
      return summonCarToRoadZone(state, action.zoneId || 'street');
    }
    case 'repair_object': return repairOwnedObject(state, action.instanceId, owner);
    default: return { ok: false, code: 400, msg: `Unsupported progression action: ${action.type}` };
  }
}

export { computePcStats };
