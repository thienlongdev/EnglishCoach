import bundle from './data/runtime-catalog.json' with { type: 'json' };

export const CATALOG = bundle;

export const MATERIAL_FINISHES = {
  natural_oak: { id: 'natural_oak', name: 'Natural Oak', primaryColor: '#c9a679', accentColor: '#8d6e49', roughness: 0.72, metalness: 0.05 },
  walnut_brass: { id: 'walnut_brass', name: 'Walnut & Brushed Brass', primaryColor: '#5c3f28', accentColor: '#c9a45c', roughness: 0.55, metalness: 0.25 },
  nordic_birch: { id: 'nordic_birch', name: 'Nordic Birch White', primaryColor: '#e9e2d4', accentColor: '#b7c2b9', roughness: 0.68, metalness: 0.04 },
  matte_graphite: { id: 'matte_graphite', name: 'Matte Graphite Slate', primaryColor: '#2d333b', accentColor: '#5ad2c5', roughness: 0.45, metalness: 0.35 },
  terracotta_linen: { id: 'terracotta_linen', name: 'Warm Terracotta Linen', primaryColor: '#b56e52', accentColor: '#e4cfb8', roughness: 0.82, metalness: 0.02 },
  emerald_velvet: { id: 'emerald_velvet', name: 'Emerald Velvet & Gold', primaryColor: '#225947', accentColor: '#d4b26a', roughness: 0.78, metalness: 0.15 },
  royal_ivory_gilt: { id: 'royal_ivory_gilt', name: 'Royal Ivory & Gilt', primaryColor: '#f2ead8', accentColor: '#d9b55c', roughness: 0.42, metalness: 0.45 },
};

export const ACHIEVEMENTS = {
  first_pc_build: { id: 'first_pc_build', name: 'First Custom PC', desc: 'Purchased and configured your first modular PC workstation.' },
  gpu_installer: { id: 'gpu_installer', name: 'Discrete Graphics Online', desc: 'Installed a compatible dedicated GPU inside your PC.' },
  ram_expander: { id: 'ram_expander', name: 'Memory Expansion', desc: 'Expanded your workstation RAM across multiple modules.' },
  dual_monitor_setup: { id: 'dual_monitor_setup', name: 'Dual-Screen Flow', desc: 'Upgraded a workstation to a dual-monitor display array.' },
  triple_monitor_studio: { id: 'triple_monitor_studio', name: 'Triptych Architect', desc: 'Configured a three-monitor studio workstation.' },
  quad_command_center: { id: 'quad_command_center', name: 'Quad Command Center', desc: 'Built a four-monitor flagship workstation.' },
  standing_desk_pro: { id: 'standing_desk_pro', name: 'Ergonomic Elevation', desc: 'Upgraded to an electric standing desk.' },
  interior_stylist: { id: 'interior_stylist', name: 'Interior Stylist', desc: 'Purchased, placed, and customized home furniture in Build Mode.' },
  chef_kitchen_upgrade: { id: 'chef_kitchen_upgrade', name: 'Chef-Grade Kitchen', desc: 'Upgraded a kitchen appliance to a modern or luxury model.' },
  bedroom_makeover: { id: 'bedroom_makeover', name: 'Suite Transformation', desc: 'Applied a new coherent room style to your bedroom.' },
  two_wheel_tuner: { id: 'two_wheel_tuner', name: 'Two-Wheel Tuner', desc: 'Upgraded or customized a rideable bicycle, e-bike, or motorbike.' },
  garage_collector: { id: 'garage_collector', name: 'Showroom Collector', desc: 'Acquired and customized a collector car for your Personal Garage.' },
  townhouse_owner: { id: 'townhouse_owner', name: 'Homeowner Milestone', desc: 'Acquired your first upgraded residential property.' },
  villa_owner: { id: 'villa_owner', name: 'Villa Estate Patron', desc: 'Unlocked and moved into the Palm Atrium Tropical Villa.' },
  palace_patron: { id: 'palace_patron', name: 'Grand Palais Patron', desc: 'Acquired the Grand Pavillon Royal Estate.' },
  v3_explorer_ten: { id: 'v3_explorer_ten', name: 'Neighborhood Pathfinder', desc: 'Discovered 10 distinct Riverside landmarks.' },
  v3_explorer_all: { id: 'v3_explorer_all', name: 'Cartographer of Riverside', desc: 'Discovered all 20 landmarks including hidden gardens.' },
  v3_collector_half: { id: 'v3_collector_half', name: 'Keepsake Seeker', desc: 'Found 8 hidden neighborhood keepsakes.' },
  v3_collector_all: { id: 'v3_collector_all', name: 'Curator of Memories', desc: 'Collected all 16 hidden keepsakes across Riverside.' },
  v3_circle_of_friends: { id: 'v3_circle_of_friends', name: 'Circle of Friends', desc: 'Reached Close Friend bond with 3 residents.' },
  v3_heart_of_riverside: { id: 'v3_heart_of_riverside', name: 'Heart of the Community', desc: 'Reached Close Friend bond with 8 residents.' },
  v3_side_quests_4: { id: 'v3_side_quests_4', name: 'Helping Hand', desc: 'Completed 4 multi-stage resident side arcs.' },
  v3_side_quests_12: { id: 'v3_side_quests_12', name: 'Living Legend', desc: 'Completed 12 multi-stage resident side arcs.' },
  v3_photographer: { id: 'v3_photographer', name: 'Golden Hour Eye', desc: 'Captured 5 Riverside moments in your Photo Album.' },
  v3_event_regular: { id: 'v3_event_regular', name: 'Town Regular', desc: 'Participated in 3 live dynamic world events.' },
  v3_story_ending_heart_of_riverside: { id: 'v3_story_ending_heart_of_riverside', name: 'Ending · Heart of Riverside', desc: 'Completed the semester with a community-centered closing speech.' },
  v3_story_ending_trailblazer_of_campus: { id: 'v3_story_ending_trailblazer_of_campus', name: 'Ending · Trailblazer of Campus', desc: 'Completed the semester building a lasting campus institution.' },
  v3_story_ending_the_shared_stage: { id: 'v3_story_ending_the_shared_stage', name: 'Ending · The Shared Stage', desc: 'Shared the finale microphone with Thao Vy and friends.' },
};

export function getStore(storeId) {
  return CATALOG.shops[storeId] || null;
}

export function findSku(storeId, sku) {
  const store = getStore(storeId);
  if (!store) return null;
  return store.items.find(i => i.sku === sku) || null;
}

export function getPcPart(slot, id) {
  const map = {
    case: CATALOG.pc.cases,
    motherboard: CATALOG.pc.motherboards,
    cpu: CATALOG.pc.cpus,
    gpu: CATALOG.pc.gpus,
    ram: CATALOG.pc.ram,
    storage: CATALOG.pc.storage,
    cooling: CATALOG.pc.cooling,
    fans: CATALOG.pc.fans,
    rgb: CATALOG.pc.rgb,
    monitors: CATALOG.pc.monitors,
    keyboard: CATALOG.pc.keyboards,
    mouse: CATALOG.pc.mice,
    speakers: CATALOG.pc.speakers,
    microphone: CATALOG.pc.microphones,
    accessories: CATALOG.pc.accessories,
    desk: CATALOG.pc.desks,
  };
  const list = map[slot];
  return list ? list.find(x => x.id === id) || null : null;
}

export function getUpgrade(upgradeId) {
  return CATALOG.upgrades.find(u => u.id === upgradeId) || null;
}

export function getUpgradesForObject(obj) {
  if (!obj) return [];
  return CATALOG.upgrades.filter(u =>
    u.sourceVariant === obj.selectedVariantId ||
    (u.sourceFamily === obj.assetFamilyId && u.sourceVariant === obj.selectedVariantId)
  );
}

export function getProperty(propertyId) {
  return CATALOG.properties.properties.find(p => p.id === propertyId) || null;
}

export function getRoomStyle(styleId) {
  return CATALOG.properties.roomStyleFamilies[styleId] || null;
}

export function getVehicleSpec(vehicleId) {
  return CATALOG.vehicles.vehicles.find(v => v.id === vehicleId) || null;
}

export function getVehicleComponent(componentId) {
  return CATALOG.vehicles.components.find(c => c.id === componentId) || null;
}

export function getModelFootprint(variantId, fallbackW = 0.9, fallbackD = 0.7) {
  const desk = getPcPart('desk', variantId);
  if (desk) return { width: desk.width, depth: desk.depth };
  for (const store of Object.values(CATALOG.shops)) {
    const sku = store.items.find(i => i.variantId === variantId || i.model === variantId);
    if (sku && sku.width && sku.depth) return { width: sku.width, depth: sku.depth };
  }
  const overrides = {
    bed_single_campus: { width: 1.05, depth: 2.0 },
    bed_single_fjord: { width: 1.05, depth: 2.0 },
    bed_single_engawa: { width: 1.05, depth: 2.0 },
    bed_king_veranda: { width: 1.85, depth: 2.05 },
    bed_king_arcade: { width: 1.98, depth: 2.05 },
    bed_king_palais: { width: 2.02, depth: 2.05 },
    bed_canopy_veranda: { width: 1.65, depth: 2.05 },
    bed_canopy_palais: { width: 1.75, depth: 2.05 },
    sofa_campus: { width: 1.9, depth: 0.9 },
    sofa_fjord: { width: 1.9, depth: 0.9 },
    sofa_engawa: { width: 1.95, depth: 0.92 },
    sofa_veranda: { width: 2.2, depth: 1.1 },
    sofa_arcade: { width: 2.2, depth: 1.1 },
    sofa_palais: { width: 2.0, depth: 0.95 },
    stove_campus: { width: 0.95, depth: 0.68 },
    stove_induction_dual: { width: 0.85, depth: 0.62 },
    stove_veranda: { width: 1.0, depth: 0.7 },
    stove_palais: { width: 1.1, depth: 0.72 },
    fridge_campus: { width: 0.9, depth: 0.8 },
    fridge_modern_gem: { width: 0.88, depth: 0.78 },
    fridge_veranda: { width: 0.95, depth: 0.8 },
    fridge_palais: { width: 0.98, depth: 0.82 },
    wardrobe_campus: { width: 1.0, depth: 0.6 },
    wardrobe_veranda: { width: 1.15, depth: 0.62 },
    wardrobe_palais: { width: 1.2, depth: 0.64 },
  };
  return overrides[variantId] || { width: fallbackW, depth: fallbackD };
}
