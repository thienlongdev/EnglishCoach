import { zones, spawnAt } from '../world-data/world.mjs';
import { move, fall, limit, playerAt, walkable } from '../game-physics/controller.mjs';
import { newResidents, stepResidents, residents } from '../npc-ai/residents.mjs';
import { record } from '../story-and-quests/semester.mjs';
import { ride } from '../vehicles/bicycle.mjs';
import { toggleDriveCar, getActiveCarSpec, ROAD_CAPABLE_ZONES, summonCarToRoadZone } from '../vehicles/car.mjs';
import { CATALOG, getProperty } from '../progression/catalog.mjs';
import { createProgression, resetDailyEconomyIfNeeded, syncCredits } from '../progression/state.mjs';
import { awardSkillXp } from '../progression/skills.mjs';
import { awardCredits, getActiveVehiclePhysics, computePcStats } from '../progression/engine.mjs';
import { COLLECTIBLES, discoverZone, collectRelic, inspectLore } from '../world-data/exploration.mjs';
import { getActiveEvents, isZoneOpen } from '../world-data/weather-events.mjs';
import { buildNpcInteractionOptions, executeNpcInteraction } from '../dialogue/npc-interactions.mjs';
import { initSideQuestsState } from '../story-and-quests/side-quests.mjs';
import { performFreeRoamAction, SEMINAR_QUESTIONS } from '../gameplay/activities.mjs';
import { createTutorialState, recordTutorialSignal } from '../gameplay/tutorial.mjs';
import { STORY_CHOICES, makeStoryChoice } from '../story-and-quests/story-v3.mjs';

// Expanded 6-recipe cooking system (preserves V1/V2 eggs, noodles, rice verbatim + 3 new student recipes)
export const meals = {
  eggs: { name: 'Fried eggs', model: 'meal_fried_eggs', items: { egg: 1 }, hunger: 24 },
  noodles: { name: 'Stir-fried noodles', model: 'meal_stir_fried_noodles', items: { noodle: 1, greens: 1 }, hunger: 30 },
  rice: { name: 'Rice with meat and vegetables', model: 'meal_rice_meat_vegetables', items: { rice: 1, meat: 1, greens: 1 }, hunger: 36 },
  omelette: { name: 'Herb garden omelette', model: 'meal_fried_eggs', items: { egg: 1, greens: 1 }, hunger: 32 },
  matcha_crepe: { name: 'Matcha student crepes', model: 'meal_stir_fried_noodles', items: { egg: 1, herbal_tea: 1 }, hunger: 28 },
  riverside_feast: { name: 'Riverside Lantern Feast', model: 'meal_rice_meat_vegetables', items: { rice: 1, meat: 1, greens: 1, egg: 1 }, hunger: 48 },
};

export const products = {
  noodles: { name: 'Noodle and greens kit', price: 6, items: { noodle: 1, greens: 1 } },
  rice: { name: 'Rice and meat kit', price: 9, items: { rice: 1, meat: 1, greens: 1 } },
  eggs: { name: 'Fresh eggs', price: 2, items: { egg: 2 } },
  kit: { name: 'Coloured festival paper', price: 8, items: { paper: 1 } },
  tea: { name: 'Jasmine herbal tea tin', price: 7, items: { herbal_tea: 2 } },
};

export function createWorldV3(returningPlayer = false) {
  return {
    schema: 'v3',
    tutorial: createTutorialState(returningPlayer),
    storyChoices: {},
    endingId: null,
    sideQuests: initSideQuestsState(),
    exploration: {
      discoveredZones: ['study'],
      discoveredLandmarks: ['lm_home_study'],
      collectibles: [],
      loreRead: [],
    },
    photos: [],
    eventsAttended: [],
    activeDelivery: null,
    activeSocialScenes: [],
    hostedGuest: null,
    gardenPlots: 0,
    lastFairSpinDay: -1,
    activityCounts: {},
    weatherOverride: null,
    openRoadPermit: false,
    car: {
      active: false,
      instanceId: null,
      model: 'car_mango_micro',
      zone: 'yard',
      x: -1.8,
      z: 3.4,
      yaw: Math.PI / 2,
      wheelSpin: 0,
      steerAngle: 0,
      doorOpen: 0,
    },
    recentFeed: [],
  };
}

export function createGame(owner = 'local') {
  const progression = createProgression(owner);
  return {
    version: 4,
    saveRevision: 0,
    owner,
    clock: 420,
    elapsed: 0,
    player: playerAt(),
    avatar: 'student',
    settings: { quality: 'High', reduced: false, audio: true, firstPerson: false },
    cash: progression.economy.credits,
    bag: { egg: 2 },
    pantry: {},
    basket: [],
    stock: { eggs: 8, noodles: 8, rice: 8, kit: 8, tea: 8 },
    day: 0,
    prepared: null,
    pot: null,
    served: null,
    dirty: false,
    needs: { energy: 80, hunger: 70, hygiene: 75, mood: 65, focus: 60, fitness: 30 },
    done: [],
    progress: {},
    sandbox: false,
    npcs: newResidents(),
    bike: { zone: 'yard', x: 3, z: 1, yaw: 0, wheel: 0 },
    objects: { broom: { zone: 'living', x: -2.7, z: 0.7, y: 0, vy: 0, rest: true } },
    held: null,
    carriedItem: null,
    portable: {
      ball: { zone: 'park', x: 1, z: 2, y: 0, vy: 0, rest: true },
      basketTool: { zone: 'market', x: 0.5, z: 1, y: 0, vy: 0, rest: true },
    },
    flags: {},
    clean: false,
    posture: '',
    busy: null,
    challenge: null,
    history: [],
    npcTime: 0,
    seed: 517,
    progression,
    worldV3: createWorldV3(false),
  };
}

export function tick(s, input, dt) {
  dt = Math.min(0.05, Math.max(0, dt));
  s.elapsed += dt;
  s.clock += dt * 0.65;
  if (Math.floor(s.clock / 1440) > s.day) {
    s.day = Math.floor(s.clock / 1440);
    for (const k of Object.keys(products)) s.stock[k] = 8;
    resetDailyEconomyIfNeeded(s);
  }
  const n = s.needs;
  n.hunger = limit(n.hunger - dt * 0.012, 0, 100);
  n.energy = limit(n.energy - dt * (input.run ? 0.035 : 0.007), 0, 100);

  const prevX = s.player.x;
  const prevZ = s.player.z;
  const rideSpec = s.player.riding ? getActiveVehiclePhysics(s) : null;
  const carSpec = s.player.driving ? getActiveCarSpec(s) : null;
  if (!s.posture && !s.challenge && !s.busy) move(s.player, input, dt, rideSpec, s, carSpec);

  // Track real movement & jump signals for interactive tutorial Step 1
  const stepDist = Math.hypot(s.player.x - prevX, s.player.z - prevZ);
  if (stepDist > 0.002) recordTutorialSignal(s, 'move', stepDist);
  if (input.jump && !s.player.riding && !s.player.driving) recordTutorialSignal(s, 'jumped');

  // Active two-wheeler sync
  if (s.player.riding) {
    Object.assign(s.bike, { x: s.player.x, z: s.player.z, zone: s.player.zone, yaw: s.player.yaw });
    s.bike.wheel += (s.player.speed * dt) / 0.337;
    if (Math.abs(s.player.speed) > 1.5) {
      recordTutorialSignal(s, 'rodeVehicle');
      s._rideXpAccum = (s._rideXpAccum || 0) + dt;
      if (s._rideXpAccum >= 4.0) {
        s._rideXpAccum = 0;
        awardSkillXp(s, 'mobility', 8);
        if (s.player.zone === 'greenway') record(s, 'activity:greenway_drive');
      }
    }
  }

  // Active 4-wheel car sync (steering pivots, spinning wheels, smooth closing doors!)
  if (s.worldV3?.car) {
    const car = s.worldV3.car;
    if (car.doorOpen > 0) car.doorOpen = Math.max(0, car.doorOpen - dt * 1.4);
    if (s.player.driving) {
      Object.assign(car, { active: true, x: s.player.x, z: s.player.z, zone: s.player.zone, yaw: s.player.yaw });
      const radius = carSpec?.wheelRadius || 0.32;
      car.wheelSpin = (car.wheelSpin || 0) + (s.player.speed * dt) / radius;
      const targetSteer = limit(input.side || 0, -1, 1) * (carSpec?.maxSteerRad || 0.44);
      car.steerAngle = (car.steerAngle || 0) + (targetSteer - (car.steerAngle || 0)) * Math.min(1, dt * 10);
      if (Math.abs(s.player.speed) > 2.0) {
        recordTutorialSignal(s, 'rodeVehicle');
        s._driveXpAccum = (s._driveXpAccum || 0) + dt;
        if (s._driveXpAccum >= 3.5) {
          s._driveXpAccum = 0;
          awardSkillXp(s, 'mobility', 10);
          if (s.player.zone === 'greenway') record(s, 'activity:greenway_drive');
        }
      }
    }
  }

  if (s.pot && !s.pot.ready && s.elapsed >= s.pot.at) s.pot.ready = true;
  if (s.busy && s.elapsed >= s.busy.until) s.busy = null;
  if (s.held !== 'broom') fall(s.objects.broom, dt);
  for (const [id, item] of Object.entries(s.portable || {})) if (s.held !== id) fall(item, dt);
  s.npcTime += dt;
  if (s.npcTime >= 0.2) {
    stepResidents(s, s.npcTime);
    s.npcTime = 0;
  }
}

export function entities(s) {
  const area = zones[s.player.zone];
  const placed = (s.progression?.ownedObjects || []).filter(o => !o.location.inStorage && o.location.zoneId === area.id);
  const superseded = new Set(placed.map(o => o.interactionState?.lockedCoreProp).filter(Boolean));
  const list = [
    ...area.props.filter(p => !['broom', 'bike'].includes(p.id) && !superseded.has(p.id)),
    ...area.doors,
  ];
  for (const obj of placed) {
    if (obj.category === 'vehicle_rideable') continue;
    if (obj.interactionState?.lockedCoreProp) {
      const orig = area.props.find(p => p.id === obj.interactionState.lockedCoreProp);
      if (orig) list.push({ ...orig, x: obj.placement.x, z: obj.placement.z, model: obj.selectedVariantId, instanceId: obj.instanceId });
      continue;
    }
    const act = obj.category === 'electronics_pc' ? 'use_pc'
      : obj.category === 'vehicle_display' ? 'inspect_car'
      : obj.category === 'kitchen_appliance' ? 'use_appliance'
      : 'inspect_owned';
    list.push({ id: obj.instanceId, instanceId: obj.instanceId, model: obj.selectedVariantId, x: obj.placement.x, z: obj.placement.z, action: act, category: obj.category });
  }
  for (const [id, item] of Object.entries(s.portable || {})) {
    if (s.held !== id && item.zone === area.id) list.push({ id, action: 'carry', ...item });
  }
  if (s.held !== 'broom' && s.objects.broom.zone === area.id) list.push({ id: 'broom', action: 'broom', ...s.objects.broom });
  if (s.held === 'broom' && area.id === 'living') list.push({ id: 'rack', action: 'rack', x: -2.7, z: 0.7 });
  if (s.bike.zone === area.id) list.push({ id: 'bike', action: 'ride', ...s.bike });

  // Drivable 4-wheel car entity when parked in current road-capable zone
  const car = s.worldV3?.car;
  if (car?.active && car.zone === area.id && ROAD_CAPABLE_ZONES.includes(area.id)) {
    list.push({ id: 'car', action: 'drive_car', x: car.x, z: car.z, yaw: car.yaw, model: car.model });
  }

  // Uncollected hidden collectibles in this zone!
  const collected = new Set(s.worldV3?.exploration?.collectibles || []);
  for (const col of COLLECTIBLES) {
    if (col.zone === area.id && !collected.has(col.id)) {
      list.push({ id: col.id, action: 'collect_relic', x: col.x, z: col.z, model: col.model, name: col.name });
    }
  }

  // Live Dynamic World Event booth/trigger in this zone
  const liveEvent = getActiveEvents(s).find(ev => ev.zone === area.id);
  if (liveEvent) {
    list.push({ id: 'event-' + liveEvent.id, action: 'event_participate', x: 0, z: 0.6, name: liveEvent.title });
  }

  // All 22 living NPCs currently inside this zone
  for (const n of Object.values(s.npcs || {})) {
    if (n.zone === area.id) list.push({ ...n, id: 'npc-' + n.id, action: 'talk' });
  }
  return list;
}

export function nearby(s) {
  return entities(s)
    .filter(e => e.action && Math.hypot(e.x - s.player.x, e.z - s.player.z) <= (e.action === 'drive_car' ? 3.5 : e.action === 'event_participate' ? 4.5 : 2.55))
    .sort((a, b) => distance(s, a) - distance(s, b));
}

const distance = (s, t) => Math.hypot(s.player.x - t.x, s.player.z - t.z);
function add(bag, items, m = 1) { for (const [k, v] of Object.entries(items)) { bag[k] = (bag[k] || 0) + v * m; if (!bag[k]) delete bag[k]; } }
function has(bag, items) { return Object.entries(items).every(([k, v]) => (bag[k] || 0) >= v); }
function busy(s, clip, time = 1.2) { s.busy = { clip, until: s.elapsed + time }; }
function boost(s, key, v) { s.needs[key] = limit(s.needs[key] + v, 0, 100); }
function random(s) { s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0; return s.seed / 4294967296; }
const option = (key, label) => ({ key, label });

function activeStoveBonus(s) {
  const stove = s.progression?.ownedObjects?.find(o => o.interactionState?.lockedCoreProp === 'stove');
  if (!stove) return { cookTime: 3, hungerBonus: 0, xpBonus: 0 };
  if (stove.selectedVariantId === 'stove_palais') return { cookTime: 1.35, hungerBonus: 22, xpBonus: 20 };
  if (stove.selectedVariantId === 'stove_veranda' || stove.selectedVariantId === 'stove_arcade') return { cookTime: 1.65, hungerBonus: 14, xpBonus: 12 };
  if (stove.selectedVariantId === 'stove_induction_dual' || stove.selectedVariantId === 'stove_engawa') return { cookTime: 2.15, hungerBonus: 6, xpBonus: 6 };
  return { cookTime: 3, hungerBonus: 0, xpBonus: 0 };
}

function activeBedBonus(s) {
  const bed = s.progression?.ownedObjects?.find(o => o.interactionState?.lockedCoreProp === 'bed');
  if (!bed) return { energy: 30, mood: 0 };
  if (bed.selectedVariantId?.includes('palais')) return { energy: 65, mood: 22 };
  if (bed.selectedVariantId?.includes('veranda') || bed.selectedVariantId?.includes('arcade')) return { energy: 48, mood: 12 };
  return { energy: 30, mood: 0 };
}

export function choices(s, e) {
  const a = e?.action;
  if (a === 'door') {
    const dest = zones[e.to];
    const hrs = isZoneOpen(dest, s.clock);
    const suffix = dest?.openHours && !hrs.open ? ' · After-hours bell' : '';
    return [option('door', (s.flags[s.player.zone + '/' + e.id] ? 'Enter ' : 'Open door · ') + dest.label + suffix)];
  }
  if (a === 'talk') return buildNpcInteractionOptions(s, e.id.slice(4));
  if (a === 'prep') return Object.entries(meals).map(([k, v]) => option(k, 'Prepare ' + v.name));
  if (a === 'basket') {
    const sale = getActiveEvents(s).some(ev => ev.id === 'evt_market_produce_sale');
    return Object.entries(products).map(([k, v]) => {
      const price = sale ? Math.max(1, Math.round(v.price * 0.8)) : v.price;
      return option(k, v.name + ' · ' + price + ' CC' + (sale ? ' (20% Sale!)' : ''));
    });
  }
  if (a === 'store') return [option('put', 'Store ingredients'), option('get', 'Collect ingredients')];
  if (a === 'learn') return [option('wrong', 'I am joining yesterday.'), option('correct', 'Would you like to join us?')];
  if (a === 'campus_seminar') {
    const sem = SEMINAR_QUESTIONS[s.day % SEMINAR_QUESTIONS.length];
    return sem.options.map(o => option(o.key, o.label));
  }
  if (a === 'plan') {
    const opts = [option('plan', s.done.includes('help') ? 'Pack the supplies' : 'Make a plan')];
    if (!s.worldV3?.storyChoices?.ch3_theme && s.done.includes('pixel')) {
      for (const o of STORY_CHOICES.ch3_theme.options) {
        opts.push(option('theme:' + o.key, 'Choose Theme · ' + o.label));
      }
    }
    return opts;
  }
  if (a === 'present') {
    const opts = [option('present', 'Speak · Thank you for joining us!')];
    if (!s.worldV3?.storyChoices?.ch5_finale_tone && s.done.includes('booth')) {
      for (const o of STORY_CHOICES.ch5_finale_tone.options) {
        opts.push(option('finale:' + o.key, 'Closing Speech · ' + o.label));
      }
    }
    return opts;
  }
  if (a === 'use_pc') return [option('pc_study', 'Use workstation (Focus & Tech XP)'), option('pc_configure', 'Open PC Builder & Upgrades')];
  if (a === 'inspect_car') return [option('car_customize', 'Customize Car in Garage'), option('car_summon_street', 'Roll car out to Riverside Lane to drive!')];
  if (a === 'drive_car') return [option('drive_car', s.player.driving ? 'Park & exit car' : 'Enter & drive car')];
  if (a === 'use_appliance') return [option('brew_use', 'Use upgraded appliance'), option('open_build', 'Upgrade or customize in Build Mode')];
  if (a === 'inspect_owned') return [option('open_build', 'Customize or upgrade in Build Mode')];
  if (a?.startsWith('shop_')) return [option(a, 'Browse store catalog & 3D previews')];
  if (a === 'open_properties') return [option('open_properties', 'Open Riverside Property Agency')];
  if (a === 'garage_bench') return [option('open_vehicles', 'Open Garage & Road Vehicle Studio')];
  if (a === 'work_cafe') return [option('work_cafe', 'Work PC Support Shift (+110 CC, +28 Tech XP)')];
  if (a === 'work_market') return [option('work_market', 'Work Market Restock Shift (+95 CC, +26 Business XP)')];
  if (a === 'work_repair') return [option('work_repair', 'Work Repair Bench Shift (+115 CC, +28 DIY XP)')];
  if (a === 'work_bistro') return [option('work_bistro', 'Work Willow Bistro Barista Shift (+105 CC, +26 Cooking XP)')];
  if (a === 'collect_relic') return [option('collect_relic', 'Collect · ' + (e.name || 'Hidden Keepsake'))];
  if (a?.startsWith('lore_')) return [option(a, 'Inspect plaque & notes')];
  if (a === 'event_participate') return [option('event_participate', 'Join Live Event · ' + (e.name || 'Neighborhood Event'))];

  const labels = {
    carry: e.id === 'ball' ? 'Pick up the basketball' : 'Carry the shopping basket',
    rack: 'Return the broom',
    desk: 'Study at the desk',
    lamp: 'Switch the lamp',
    drawer: 'Open or close the drawer',
    sit: 'Take a seat',
    tv: 'Switch the television',
    broom: 'Pick up the broom',
    clean: s.held ? 'Sweep the floor' : 'Check the floor',
    cook: s.pot ? (s.pot.ready ? 'Serve the meal' : 'Check the pan') : 'Start cooking',
    eat: 'Eat at the table',
    wash: 'Wash the dishes',
    sleep: 'Go to sleep',
    outfit: 'Change outfit',
    bath: 'Wash up',
    ride: s.player.riding ? 'Park the vehicle' : 'Ride the vehicle',
    rest: 'Take a break',
    letters: 'Collect the letters',
    practice: 'Practise passing',
    checkout: 'Pay at the counter',
    arcade: 'Play the rhythm game',
    music_jam: 'Play Acoustic Guitar Rhythm Jam',
    sport: 'Shoot a basket',
    badminton: 'Return the shuttle',
    exercise: 'Exercise',
    rings: 'Toss a ring',
    fair_spin: 'Spin the Boardwalk Prize Wheel',
    booth: s.flags.setup ? 'Welcome a guest' : 'Set up the booth',
    bistro_order: 'Order Matcha Crepe & Espresso (12 CC)',
    bistro_snack: 'Buy Boardwalk Crepe (12 CC)',
    bistro_tea: 'Steep Jasmine Herbal Tea',
    tea_ceremony: 'Perform Hidden Lantern Tea Ceremony',
    library_study: 'Deep Study at Library Table',
    archive_research: 'Search Campus History Catalog',
    atelier_paint: 'Paint on the Studio Easel',
    garden_tend: 'Water & Tend Herb Planters',
    garden_harvest: 'Harvest Fresh Greens & Tea Leaves',
    photo_snap: 'Take Landmark Photo (Save to Album)',
    photo_album: 'Open Photo Album & Explore Codex',
    delivery_start: 'Accept Greenway Express Delivery (+125 CC)',
    delivery_drop: 'Drop Off Greenway Express Parcel (+125 CC)',
    market_artisan: 'Run Weekend Artisan Booth Shift',
  };
  return a && labels[a] ? [option(a, labels[a])] : [];
}

export function release(s, storage = false) {
  if (!s.held) return false;
  const p = s.player;
  const b = s.held === 'broom' ? s.objects.broom : s.portable[s.held];
  if (storage && s.held !== 'broom') return false;
  if (storage && (p.zone !== 'living' || Math.hypot(p.x + 2.7, p.z - 0.7) > 2.35)) return false;
  const x = p.x + Math.sin(p.yaw) * 0.55;
  const z = p.z + Math.cos(p.yaw) * 0.55;
  Object.assign(
    b,
    storage
      ? { zone: 'living', x: -2.7, z: 0.7, y: 0, vy: 0, rest: true }
      : { zone: p.zone, x: walkable(p.zone, x, z, 0.29, s) ? x : p.x, z: walkable(p.zone, x, z, 0.29, s) ? z : p.z, y: p.y + 1, vy: 0, rest: false }
  );
  s.held = null;
  if (storage) record(s, 'rack');
  return true;
}

export function interact(s, id, choice) {
  const e = nearby(s).find(v => v.id === id);
  if (!e || !choices(s, e).some(o => o.key === choice) || s.busy || s.challenge) {
    return { ok: false, msg: 'Come closer or finish your current action.' };
  }
  const p = s.player;
  const zone = p.zone;
  const a = e.action;
  const key = zone + '/' + e.id;
  const ok = (msg, extra = {}) => ({ ok: true, msg, ...extra });
  const no = msg => ({ ok: false, msg });

  if (a === 'door') {
    if (p.riding && !zones[e.to].outdoors) return no('Park your vehicle outside first.');
    if (p.driving && !ROAD_CAPABLE_ZONES.includes(e.to)) return no('Park your car on the road before entering a pedestrian or indoor space.');
    const destZone = zones[e.to];
    if (destZone.requiresPropertyRoom) {
      const prop = getProperty(s.progression?.properties?.activePropertyId || 'prop_student_flat');
      if (prop && !prop.unlockedRooms.includes(destZone.requiresPropertyRoom)) {
        return no(`${destZone.label} unlocks with a larger home (visit Property Agency at Timber & Stone Homeworks).`);
      }
    }
    if (!s.flags[key]) {
      s.flags[key] = true;
      recordTutorialSignal(s, 'interactedObject');
      return ok('The door is open.');
    }
    const dest = zones[e.to];
    const back = dest.doors.find(d => d.to === zone);
    Object.assign(p, spawnAt(back), { zone: dest.id, y: 0, vx: 0, vz: 0, vy: 0, speed: 0 });
    s.posture = '';
    s.flags[dest.id + '/' + back.id] = true;
    if (p.riding) Object.assign(s.bike, { zone: p.zone, x: p.x, z: p.z });
    if (p.driving && s.worldV3?.car) Object.assign(s.worldV3.car, { zone: p.zone, x: p.x, z: p.z });
    recordTutorialSignal(s, 'changedZone');
    const lm = discoverZone(s, dest.id);
    if (lm) {
      record(s, 'discover:' + dest.id);
      recordTutorialSignal(s, 'exploredFree');
      return ok(`${dest.label} · Discovered landmark: ${lm.name}!`);
    }
    return ok(dest.label);
  }

  if (a === 'talk') {
    const who = id.slice(4);
    const res = executeNpcInteraction(s, who, choice);
    if (res.ok) recordTutorialSignal(s, 'talkedNpc');
    return res;
  }

  if (a === 'collect_relic') {
    const res = collectRelic(s, e.id);
    if (res.ok) {
      record(s, 'collect:' + e.id);
      recordTutorialSignal(s, 'exploredFree');
      recordTutorialSignal(s, 'interactedObject');
    }
    return res;
  }

  if (a?.startsWith('lore_')) {
    const res = inspectLore(s, a);
    recordTutorialSignal(s, 'interactedObject');
    if (a === 'lore_neighborhood_board') record(s, 'activity:night_watch_clue');
    if (a === 'lore_campus_founders') record(s, 'sq:finish_missing_folio');
    return res;
  }

  if (a === 'drive_car') {
    const res = toggleDriveCar(s);
    if (res.ok) recordTutorialSignal(s, 'rodeVehicle');
    return res;
  }

  if (a === 'inspect_car') {
    if (choice === 'car_summon_street') return summonCarToRoadZone(s, 'street');
    return ok('Opening Garage Vehicle Customizer…', { openPanel: 'vehicles', targetInstanceId: e.instanceId });
  }

  if (['work_bistro', 'bistro_order', 'bistro_snack', 'bistro_tea', 'tea_ceremony', 'library_study', 'archive_research', 'atelier_paint', 'garden_tend', 'garden_harvest', 'photo_snap', 'photo_album', 'delivery_start', 'delivery_drop', 'fair_spin', 'market_artisan', 'campus_seminar', 'event_participate'].includes(a)) {
    const res = performFreeRoamAction(s, a, choice);
    if (res.ok) recordTutorialSignal(s, 'interactedObject');
    if (a === 'event_participate' || a === 'photo_snap') recordTutorialSignal(s, 'exploredFree');
    return res;
  }

  if (a === 'use_pc') {
    const obj = s.progression.ownedObjects.find(o => o.instanceId === e.instanceId);
    if (choice === 'pc_configure') return ok('Opening PC Builder…', { openPanel: 'pc', targetInstanceId: e.instanceId });
    const stats = computePcStats(obj);
    boost(s, 'focus', stats.studyFocusBonus);
    awardSkillXp(s, 'technology', Math.round(18 * stats.techXpMultiplier));
    if (obj) obj.condition = Math.max(10, (obj.condition ?? 100) - 1);
    record(s, 'study');
    recordTutorialSignal(s, 'interactedObject');
    return ok(`Worked on your ${stats.tierLabel} PC (${stats.screenCount} screen${stats.screenCount > 1 ? 's' : ''}, ${stats.memoryGb} GB RAM): +${stats.studyFocusBonus} Focus & Technology XP!`);
  }
  if (a === 'use_appliance') {
    if (choice === 'open_build') return ok('Opening Build Mode…', { openPanel: 'build', targetInstanceId: e.instanceId });
    boost(s, 'energy', 12);
    boost(s, 'focus', 10);
    awardSkillXp(s, 'cooking', 12);
    recordTutorialSignal(s, 'interactedObject');
    return ok('Used your upgraded kitchen appliance (+12 Energy, +10 Focus, +12 Cooking XP).');
  }
  if (a === 'inspect_owned') return ok('Opening Build Mode…', { openPanel: 'build', targetInstanceId: e.instanceId });
  if (a?.startsWith('shop_')) return ok('Opening store…', { openPanel: 'shop', storeId: a.slice(5) });
  if (a === 'open_properties') return ok('Opening Property Agency…', { openPanel: 'properties' });
  if (a === 'garage_bench') return ok('Opening Vehicle Garage…', { openPanel: 'vehicles' });
  if (a === 'work_cafe') return ok('Starting shift…', { workActivity: 'shift_cafe_tech' });
  if (a === 'work_market') return ok('Starting shift…', { workActivity: 'shift_market_clerk' });
  if (a === 'work_repair') return ok('Starting shift…', { workActivity: 'shift_repair_workshop' });

  if (a === 'carry') {
    if (p.riding || p.driving || s.held) return no('Free your hands first.');
    s.held = e.id;
    recordTutorialSignal(s, 'interactedObject');
    return ok('You are carrying the ' + (e.id === 'ball' ? 'basketball.' : 'basket.'));
  }
  if (a === 'broom') {
    if (s.held) return no('Free your hands first.');
    if (p.riding || p.driving) return no('Exit your vehicle first.');
    s.held = 'broom';
    recordTutorialSignal(s, 'interactedObject');
    return ok('Broom in hand. Sweep the dusty patch, then put it back on its rack.');
  }
  if (a === 'rack') return release(s, true) ? ok('Broom returned to its rack.') : no('Bring the broom here.');
  if (a === 'clean') {
    if (s.held !== 'broom') return no('Pick up the broom first.');
    s.clean = true;
    busy(s, 'sweep');
    awardSkillXp(s, 'diy_design', 14);
    record(s, 'sweep');
    return ok('The floor is clean.');
  }
  if (a === 'prep') {
    if (s.prepared || s.pot || s.served) return no('Finish your current dish first.');
    const recipe = meals[choice];
    if (!recipe || !has(s.bag, recipe.items)) return no('You need more ingredients in your bag.');
    add(s.bag, recipe.items, -1);
    s.prepared = choice;
    busy(s, 'cook', 0.75);
    return ok('Ready for the stove.');
  }
  if (a === 'cook') {
    const sb = activeStoveBonus(s);
    if (s.pot) {
      if (!s.pot.ready) return no('Still cooking…');
      s.served = s.pot.meal;
      s.pot = null;
      awardSkillXp(s, 'cooking', 16 + sb.xpBonus);
      record(s, 'activity:bistro_or_cook');
      return ok('Your meal is on the table.');
    }
    if (!s.prepared) return no('Prepare the ingredients first.');
    if (s.dirty) return no('Wash the dishes before cooking again.');
    s.pot = { meal: s.prepared, at: s.elapsed + sb.cookTime, ready: false };
    s.prepared = null;
    return ok('The pan is on the stove.');
  }
  if (a === 'eat') {
    if (!s.served) return no('There is no meal on the table yet.');
    const sb = activeStoveBonus(s);
    const mealDef = meals[s.served];
    record(s, 'eat-' + s.served);
    s.served = null;
    s.dirty = true;
    boost(s, 'hunger', (mealDef?.hunger || 24) + sb.hungerBonus);
    boost(s, 'mood', 5);
    return ok('That hit the spot.');
  }
  if (a === 'wash') { s.dirty = false; boost(s, 'hygiene', 4); busy(s, 'wipe'); return ok('The kitchen is clean.'); }
  if (a === 'basket') {
    if (s.basket.length >= 8 || s.basket.filter(x => x === choice).length >= (s.stock[choice] ?? 8)) {
      return no('The basket is full or the shelf is empty.');
    }
    s.basket.push(choice);
    return ok('Added ' + products[choice].name + ' to your basket.');
  }
  if (a === 'checkout') {
    const sale = getActiveEvents(s).some(ev => ev.id === 'evt_market_produce_sale');
    const price = s.basket.reduce((v, k) => v + (sale ? Math.max(1, Math.round(products[k].price * 0.8)) : products[k].price), 0);
    if (!price || s.cash < price) return no('Check your basket and credit balance.');
    for (const k of s.basket) { s.stock[k] = Math.max(0, (s.stock[k] ?? 8) - 1); add(s.bag, products[k].items); }
    s.progression.economy.credits -= price;
    s.progression.economy.lifetimeSpent += price;
    syncCredits(s);
    if (s.basket.includes('kit')) record(s, 'buy-kit');
    s.basket = [];
    record(s, 'purchase');
    recordTutorialSignal(s, 'purchasedItem');
    return ok('Paid ' + price + ' CC.' + (sale ? ' (Flash Produce Sale discount applied!)' : ''));
  }
  if (a === 'store') {
    const [from, to] = choice === 'put' ? [s.bag, s.pantry] : [s.pantry, s.bag];
    add(to, from);
    for (const k of Object.keys(from)) delete from[k];
    return ok('Ingredients transferred.');
  }
  if (a === 'ride') {
    const okRide = ride(s);
    if (okRide && p.riding) recordTutorialSignal(s, 'rodeVehicle');
    return okRide
      ? ok(p.riding ? 'Ride with W/S. Steer with A/D. Press Space to brake. X to park.' : 'Vehicle parked.')
      : no('Put down what you are carrying first.');
  }
  if (a === 'desk') {
    p.x = e.x;
    p.z = e.z + 0.85;
    p.yaw = Math.PI;
    s.posture = 'study';
    boost(s, 'focus', 6);
    awardSkillXp(s, 'technology', 12);
    record(s, 'study');
    recordTutorialSignal(s, 'interactedObject');
    return ok('You open your notebook. Press X to stand.');
  }
  if (a === 'sleep') {
    const bb = activeBedBonus(s);
    p.x = e.x;
    p.z = e.z;
    p.y = 0.47;
    p.yaw = 0;
    s.posture = 'sleep';
    s.clock += 120;
    boost(s, 'energy', bb.energy);
    if (bb.mood) boost(s, 'mood', bb.mood);
    record(s, 'sleep');
    return ok('Two game hours pass. Press X to wake up.');
  }
  if (a === 'sit' || a === 'rest') {
    p.x = e.x;
    p.z = e.z + 0.3;
    p.y = 0.12;
    p.yaw = 0;
    s.posture = 'sit';
    boost(s, 'energy', 5);
    recordTutorialSignal(s, 'interactedObject');
    return ok('Take a breath. Press X to stand.');
  }
  if (a === 'lamp' || a === 'tv' || a === 'drawer') {
    s.flags[key] = !s.flags[key];
    recordTutorialSignal(s, 'interactedObject');
    return ok(s.flags[key] ? 'Switched on or opened.' : 'Switched off or closed.');
  }
  if (a === 'bath') { boost(s, 'hygiene', 20); busy(s, 'brush_teeth'); return ok('You feel refreshed.'); }
  if (a === 'outfit') {
    const looks = s.progression?.unlockedOutfits || ['student', 'student2', 'gemini', 'geminiSport'];
    s.avatar = looks[(looks.indexOf(s.avatar) + 1) % looks.length];
    record(s, 'activity:outfit_or_photo');
    return ok('Outfit changed.');
  }
  if (a === 'plan') {
    if (choice.startsWith('theme:')) {
      const optKey = choice.slice(6);
      const cr = makeStoryChoice(s, 'ch3_theme', optKey);
      record(s, 'plan');
      s.flags.plan = true;
      return ok(cr.ok ? cr.msg : 'The team locks in your festival theme!');
    }
    if (s.done.includes('help') && has(s.bag, { paper: 1 })) {
      add(s.bag, { paper: -1 });
      s.flags.packed = true;
      record(s, 'pack');
      return ok('The supplies are packed.');
    }
    record(s, 'plan');
    s.flags.plan = true;
    return ok('The team chooses a theme: Welcome to Campus.');
  }
  if (a === 'learn') {
    if (choice !== 'correct') return no('Which sentence invites someone to join you?');
    awardSkillXp(s, 'social', 15);
    record(s, 'english');
    return ok('Yes! That is a friendly invitation.');
  }
  if (a === 'letters') { s.flags.letters = true; record(s, 'letters'); return ok('You have the letters for Linh.'); }
  if (a === 'booth') {
    if (!s.done.includes('supplies')) return no('Pack the supplies first.');
    const ev = s.flags.setup ? 'host' : 'setup';
    s.flags.setup = true;
    record(s, ev);
    return ok(ev === 'setup' ? 'The booth is open.' : 'Your first guest accepts the invitation.');
  }
  if (a === 'present') {
    if (!s.done.includes('booth')) return no('Welcome a guest at the booth first.');
    if (choice.startsWith('finale:')) {
      makeStoryChoice(s, 'ch5_finale_tone', choice.slice(7));
    }
    record(s, 'present');
    busy(s, 'celebrate', 2);
    return ok('The crowd applauds! Your semester ending is recorded in the Journal — and the entire open world remains yours to live in freely.');
  }
  if (['arcade', 'sport', 'rings', 'badminton', 'music_jam'].includes(a)) {
    const seqLen = a === 'music_jam' ? 4 : 3;
    s.challenge = { type: a, start: s.elapsed, sequence: Array.from({ length: seqLen }, () => Math.floor(random(s) * 4)), index: 0 };
    return ok(a === 'music_jam' ? 'Strum the 4-chord sequence in order!' : 'Your turn.');
  }
  if (a === 'exercise' || a === 'practice') {
    boost(s, 'fitness', 3);
    awardSkillXp(s, 'mobility', 10);
    busy(s, 'exercise_squat');
    return ok('Training complete.');
  }
  return no('No action available.');
}

export function challengeInput(s, i) {
  const c = s.challenge;
  if (!c) return false;
  const end = win => {
    s.challenge = null;
    if (win) {
      resetDailyEconomyIfNeeded(s);
      const econ = s.progression.economy;
      const cap = CATALOG.economy.antiExploitGuards.maxPaidMinigamesPerGameDay;
      if (econ.minigameWinsToday < cap) {
        econ.minigameWinsToday++;
        awardCredits(s, c.type === 'music_jam' ? 24 : 18, { bounded: true });
      }
      boost(s, 'mood', 6);
      const sk = c.type === 'arcade' ? 'technology' : (c.type === 'rings' || c.type === 'music_jam') ? 'social' : 'mobility';
      awardSkillXp(s, sk, c.type === 'music_jam' ? 24 : 18);
      record(s, 'win-' + c.type);
      if (c.type === 'music_jam') record(s, 'activity:music_jam');
      if (c.type === 'rings') record(s, 'activity:night_watch_clue');
    }
    return win;
  };
  if (c.type === 'arcade' || c.type === 'music_jam') {
    if (i !== c.sequence[c.index]) return end(false);
    return ++c.index === c.sequence.length ? end(true) : null;
  }
  const phase = ((s.elapsed - c.start) % 1.4) / 1.4;
  return end(phase >= 0.4 && phase <= 0.72);
}
