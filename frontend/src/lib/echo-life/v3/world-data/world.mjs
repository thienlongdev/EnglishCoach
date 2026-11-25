/** Metres, +Y up, local X/Z in each streamed zone. A portal starts at the opposite
 * end's lane, just inside the walkable bounds. Doors are interactable both ways.
 * V3 preserves all 16 V1 zones + 9 V2 zones verbatim and adds 6 new open-world
 * exploration & community districts (31 total zones). */
export const zones = {};

function zone(id, label, size, outdoors, floor, props = [], meta = {}) {
  zones[id] = {
    id,
    label,
    size,
    outdoors,
    floor,
    props,
    doors: [],
    district: 'Neighborhood',
    discoverable: false,
    hiddenUntilDiscovered: false,
    roadCapable: false,
    openHours: null,
    ...meta,
  };
}

function prop(id, model, x, z, action, width = 0.8, depth = 0.8, angle = 0) {
  return { id, model, x, z, action, width, depth, angle };
}

// === Core Residential Home Zones (V1 preserved + V2 buildable) ===
zone('study', 'Study room', 6, false, 0xd4b992, [
  prop('desk', 'furniture_desk', -1.8, -1.6, 'desk', 1.5, 0.8),
  prop('lamp', 'home_floor_lamp', 1.7, -2, 'lamp', 0.4, 0.4),
], { buildable: true, roomType: 'study', district: 'Home' });

zone('hall', 'Hallway', 8, false, 0xd8bd98, [
  prop('drawer', 'flat_cabinet_bed_drawer', 0, -2.2, 'drawer', 0.7, 0.5),
], { district: 'Home' });

zone('living', 'Living room', 10, false, 0xc6ac90, [
  prop('sofa', 'home_sofa', -2, -2.6, 'sit', 2, 0.85),
  prop('tv', 'home_television', 2.5, -2.4, 'tv', 1.3, 0.5),
  prop('broom', 'cleaning_broom', -2.7, 0.7, 'broom', 0, 0),
  prop('dust', '', 1, 1, 'clean', 0, 0),
  prop('lamp', 'home_floor_lamp', 3.4, 1, 'lamp', 0.4, 0.4),
], { buildable: true, roomType: 'living', district: 'Home' });

zone('kitchen', 'Kitchen', 9, false, 0xd9c9a9, [
  prop('stove', 'kitchenette_kitchen_stove', -2.7, -2.1, 'cook', 1, 0.65),
  prop('fridge', 'kitchenette_kitchen_fridge_large', 2.6, -2.3, 'store', 0.95, 0.8),
  prop('sink', 'kitchen_sink', 0, -2.8, 'wash', 1, 0.7),
  prop('board', 'kitchen_cutting_board', -2.6, 1.8, 'prep', 0.6, 0.4),
  prop('table', 'furniture_desk', 2.6, 1, 'eat', 1.4, 0.8),
], { buildable: true, roomType: 'kitchen', district: 'Home' });

zone('bedroom', 'Bedroom', 8, false, 0xc9b49f, [
  prop('bed', 'furniture_bed_single', -2, -1.8, 'sleep', 1.1, 2),
  prop('wardrobe', 'flat_cabinet_bed', 2, -1.8, 'outfit', 0.9, 0.6),
], { buildable: true, roomType: 'bedroom', district: 'Home' });

zone('bath', 'Bathroom', 7, false, 0xc4d9d4, [
  prop('basin', 'wash_bathroom_sink', -1.7, -1.9, 'bath', 1, 0.6),
  prop('shower', 'bathroom_shower', 1.6, -1.6, 'bath', 0.85, 0.85),
], { buildable: true, roomType: 'bath', district: 'Home' });

zone('yard', 'Home garden', 14, true, 0x94b68e, [
  prop('bike', 'bicycle', 3, 1, 'ride', 0, 0),
  prop('tree', 'park_shade_tree', -4, -4, null, 0.8, 0.8),
  prop('rack', 'yard_bike_rack', 4, 2, null, 1, 0.6),
  prop('yard_planter', 'v3_garden_trough', -3.4, 3.2, 'garden_tend', 1.1, 0.5),
], { buildable: true, roomType: 'yard', district: 'Home', roadCapable: true });

// === V2 Expandable Home Zones (Unlocked by Property Progression!) ===
zone('gaming_room', 'Gaming & Tech Studio', 9, false, 0x9aa9b8, [
  prop('studio_chair', 'chair_ergo_gaming', 2.4, -2.2, 'sit', 0.75, 0.75),
  prop('studio_lamp', 'floor_lamp_arcade', -3.2, -2.6, 'lamp', 0.45, 0.45),
], { buildable: true, roomType: 'gaming_room', requiresPropertyRoom: 'gaming_room', district: 'Home' });

zone('balcony', 'Terrace Balcony', 8, true, 0xb9b09a, [
  prop('balcony_table', 'balcony_side_table_veranda', -2.2, -1.8, 'rest', 0.6, 0.6),
], { buildable: true, roomType: 'balcony', requiresPropertyRoom: 'balcony', district: 'Home' });

zone('garage', 'Personal Garage', 12, false, 0x9ea5aa, [
  prop('garage_bench', 'garage_workbench', -4.2, -3.5, 'garage_bench', 1.7, 0.8),
  prop('spare_wheel', 'veh_part_wheel_std', 4.0, -3.5, null, 0.6, 0.6),
], { buildable: true, roomType: 'garage', requiresPropertyRoom: 'garage', district: 'Home' });

// === Neighbourhood & Campus Zones (V1 preserved + V3 landmarks & storytelling) ===
zone('street', 'Riverside Lane', 32, true, 0x8aab92, [
  prop('stop', 'street_bus_shelter', -5, -4, 'rest', 2.2, 1),
  prop('mail', 'street_mailbox', 5, 3, 'plan', 0.45, 0.5),
  prop('sign', 'street_wayfinding_sign', -6, 3, 'lore_street_map', 0.35, 0.4),
  prop('tree', 'park_shade_tree', 8, -7, null, 0.85, 0.85),
  prop('marketfront', 'market_frontage', -10, -9, null, 4, 2),
  prop('cafefront', 'cafe_frontage', 9, 8, null, 4, 2),
  prop('street_kiosk', 'v3_map_kiosk', -11.5, 4.5, 'lore_neighborhood_board', 1.1, 0.8),
  prop('courier_board', 'campus_clipboard', 11.5, -4.5, 'delivery_start', 0.6, 0.5),
], { district: 'Neighborhood', roadCapable: true });

zone('linh', 'Linh’s house', 9, false, 0xdac9ac, [
  prop('seat', 'home_sofa', 2, -2.3, 'sit', 2, 0.9),
  prop('letters', 'campus_clipboard', -2, -2, 'letters', 0.6, 0.5),
  prop('linh_easel', 'v3_art_easel', -2.6, 1.8, 'lore_linh_sketches', 0.9, 0.7),
], { district: 'Neighborhood' });

zone('minh', 'Minh’s house', 9, false, 0xcebaa5, [
  prop('seat', 'furniture_bench_cushion', 2, -2.3, 'sit', 1.4, 0.7),
  prop('ball', 'park_basketball', -2, -2, 'practice', 0, 0),
  prop('minh_guitar', 'v3_electric_guitar', -2.8, 1.8, 'music_jam', 0.6, 0.6),
], { district: 'Neighborhood' });

zone('market', 'Sunrise Market', 14, false, 0xd1d3bc, [
  prop('shelf', 'market_aisle_shelf', -3, -2, 'basket', 2.3, 0.9),
  prop('till', 'market_checkout_counter', 3, -2, 'checkout', 1.6, 0.9),
  prop('tea', 'market_aisle_shelf', -3, 2.4, 'basket', 2.3, 0.9),
  prop('market_shift', 'shop_patisserie_case', 3.4, 2.2, 'work_market', 1.2, 0.7),
], { district: 'Shopping Row', openHours: [7, 22] });

zone('cafe', 'Pixel Café', 12, false, 0xa2afbf, [
  prop('console', 'cafe_gaming_desk', -2.5, -2, 'arcade', 1.6, 0.85),
  prop('screen', 'cafe_monitor', 2.3, -2, 'arcade', 1, 0.45),
  prop('chair', 'cafe_gaming_chair', 2, 2, 'sit', 0.75, 0.75),
  prop('tech_bench', 'desk_gaming_pro', -2.6, 2.2, 'work_cafe', 1.4, 0.75),
], { district: 'Neighborhood', openHours: [10, 24] });

zone('park', 'Riverside Park', 20, true, 0x91b67d, [
  prop('hoop', 'park_basketball_hoop', -4, -4, 'sport', 0.7, 0.7),
  prop('court', 'park_badminton_racket', 3, -3, 'badminton', 0.5, 0.5),
  prop('bench', 'park_slatted_bench', 4, 4, 'exercise', 1.5, 0.8),
  prop('tree', 'park_shade_tree', -6, 3, null, 0.9, 0.9),
  prop('park_kiosk', 'v3_map_kiosk', -6.8, -5.2, 'lore_park_trail', 1.1, 0.7),
  prop('photo_spot_park', 'v3_camera_prop', 6.2, -5.2, 'photo_snap', 0.5, 0.5),
], { district: 'Parks & River' });

zone('fair', 'Boardwalk Fair', 15, true, 0xbdbd88, [
  prop('rings', 'amusement_ring_toss', -2.3, -2, 'rings', 1.2, 0.9),
  prop('wheel', 'amusement_prize_wheel', 3, -2, 'fair_spin', 0.8, 0.7),
  prop('fair_crepes', 'v3_crepe_kiosk', -3.6, 3.2, 'bistro_snack', 2.0, 1.2),
], { district: 'Parks & River' });

zone('campus', 'University Green', 22, true, 0xb9bc9a, [
  prop('notice', 'campus_festival_posterboard', -4, -4, 'plan', 1.5, 0.6),
  prop('books', 'campus_library_cart', 3, -4, 'learn', 1, 0.65),
  prop('booth', 'festival_booth', -4, 3, 'booth', 2, 1.2),
  prop('stage', 'festival_lectern', 4, 3, 'present', 1, 0.8),
  prop('colonnade', 'campus_colonnade_bay', 0, -8, null, 3, 0.8),
  prop('seminar_board', 'campus_festival_posterboard', -7.2, -2.0, 'campus_seminar', 1.0, 0.7),
  prop('guardhouse', 'v3_guardhouse', -7.6, 6.4, 'lore_campus_gate', 2.0, 1.6),
], { district: 'Campus' });

zone('greenway', 'Riverside Greenway', 220, true, 0x99ad91, [
  prop('gardenbench', 'park_slatted_bench', 3, 3, 'rest', 1.5, 0.65),
  prop('sports', 'park_basketball_hoop', -6, -5, 'sport', 0.7, 0.7),
  prop('station', 'street_bus_shelter', 3, -8, 'rest', 2, 0.9),
  prop('greenway_checkpoint_a', 'v3_map_kiosk', 22, -4, 'delivery_drop', 1.0, 0.7),
  prop('greenway_checkpoint_b', 'v3_street_lantern', -26, 5, 'lore_greenway_mile', 0.7, 0.7),
  prop('greenway_overlook_cam', 'v3_camera_prop', 42, -5, 'photo_snap', 0.6, 0.6),
], { district: 'Parks & River', roadCapable: true });
zones.greenway.depth = 180;

// === V2 Commercial District Stores (All 6 preserved!) ===
zone('electronics_shop', 'Volt & Silicon Electronics', 12, false, 0xb7c2cc, [
  prop('elec_counter', 'desk_walnut_executive', 0, -3.2, 'shop_electronics_shop', 1.9, 0.85),
  prop('display_rig_a', 'pc_case_glass_tower', -3.2, -2.5, 'shop_electronics_shop', 0.8, 0.8),
  prop('display_rig_b', 'pc_case_liquid_spine', 3.2, -2.5, 'shop_electronics_shop', 0.8, 0.8),
  prop('display_mon', 'mon_triple_coding', -3.0, 1.8, 'shop_electronics_shop', 1.6, 0.5),
  prop('display_tv', 'tv_smart_55', 3.0, 1.8, 'shop_electronics_shop', 1.3, 0.5),
], { storeId: 'electronics_shop', district: 'Shopping Row', openHours: [9, 21] });

zone('furniture_shop', 'Riverside Living & Atelier', 13, false, 0xd8cab6, [
  prop('furn_counter', 'shop_display_cabinet_veranda', 0, -3.8, 'shop_furniture_shop', 1.4, 0.7),
  prop('show_sofa', 'sofa_veranda', -3.5, -2.0, 'shop_furniture_shop', 2.2, 1.1),
  prop('show_bed', 'bed_canopy_palais', 3.5, -2.0, 'shop_furniture_shop', 1.75, 2.05),
  prop('show_desk', 'desk_electric_lift', -3.2, 2.2, 'shop_furniture_shop', 1.68, 0.8),
  prop('show_chair', 'club_chair_veranda', 3.2, 2.2, 'shop_furniture_shop', 0.85, 0.85),
], { storeId: 'furniture_shop', district: 'Shopping Row', openHours: [9, 20] });

zone('clothing_shop', 'Thread & Campus Apparel', 10, false, 0xe0d2c4, [
  prop('apparel_counter', 'shop_bench_entry_fjord', 0, -2.8, 'shop_clothing_shop', 1.2, 0.6),
  prop('rack_left', 'shop_garment_carousel', -2.5, -1.2, 'shop_clothing_shop', 0.9, 0.9),
  prop('rack_right', 'shop_garment_carousel', 2.5, -1.2, 'shop_clothing_shop', 0.9, 0.9),
], { storeId: 'clothing_shop', district: 'Shopping Row', openHours: [9, 21] });

zone('vehicle_dealer', 'Greenway Motors & Cycles', 15, false, 0xbec5c7, [
  prop('dealer_desk', 'desk_nordic_drawer', 0, -4.6, 'shop_vehicle_dealer', 1.4, 0.75),
  prop('show_bike', 'veh_ebike_commuter', -4.2, -1.8, 'shop_vehicle_dealer', 0.8, 1.8),
  prop('show_moto', 'veh_moto_cafe_racer', 4.2, -1.8, 'shop_vehicle_dealer', 0.8, 2.0),
  prop('show_car', 'car_lotus_spider', 0, 1.4, 'shop_vehicle_dealer', 2.1, 4.1),
], { storeId: 'vehicle_dealer', district: 'Shopping Row', openHours: [8, 20] });

zone('home_center', 'Timber & Stone Homeworks', 13, false, 0xd3c8b4, [
  prop('home_desk', 'kitchen_island_veranda', 0, -3.5, 'shop_home_center', 1.8, 0.9),
  prop('show_stove', 'stove_veranda', -3.8, -2.0, 'shop_home_center', 1.0, 0.7),
  prop('show_fridge', 'fridge_modern_gem', 3.8, -2.0, 'shop_home_center', 0.95, 0.8),
  prop('show_tub', 'bath_tub_veranda', -3.5, 2.2, 'shop_home_center', 1.7, 0.85),
  prop('realty_board', 'shop_photocopier', 3.6, 2.2, 'open_properties', 0.8, 0.8),
], { storeId: 'home_center', district: 'Shopping Row', openHours: [8, 20] });

zone('repair_shop', 'Tech & Fix Repair Workshop', 11, false, 0xb5b8b4, [
  prop('repair_bench', 'garage_workbench', -2.4, -2.5, 'shop_repair_shop', 1.75, 0.8),
  prop('craft_station', 'desk_trestle_student', 2.4, -2.5, 'work_repair', 1.1, 0.65),
  prop('wheel_rack', 'veh_part_wheel_sport', 0, 2.0, 'shop_repair_shop', 0.9, 0.9),
], { storeId: 'repair_shop', district: 'Shopping Row', openHours: [8, 20] });

// === V3 NEW OPEN-WORLD DISTRICTS, VENUES & DISCOVERABLE SECRETS (6 new zones!) ===
zone('library', 'University Library', 14, false, 0xd6c7ae, [
  prop('lib_table_a', 'v3_library_table', -3.2, -1.8, 'library_study', 2.1, 1.0),
  prop('lib_table_b', 'v3_library_table', 3.2, -1.8, 'library_study', 2.1, 1.0),
  prop('lib_catalog', 'v3_library_catalog', 0, -4.6, 'archive_research', 1.2, 0.7),
  prop('lib_stacks_l', 'v3_library_bookcase', -4.8, 2.4, 'lore_library_folio', 1.4, 0.6),
  prop('lib_stacks_r', 'v3_library_bookcase', 4.8, 2.4, 'lore_library_stacks', 1.4, 0.6),
  prop('lib_bench', 'furniture_bench_cushion', 0, 2.5, 'sit', 1.4, 0.7),
], { district: 'Campus', openHours: [7, 22], discoverable: true });

zone('bistro', 'Willow Corner Bistro', 13, false, 0xe0ccb5, [
  prop('bistro_counter', 'v3_crepe_kiosk', 0, -3.6, 'bistro_order', 2.2, 1.2),
  prop('bistro_espresso', 'espresso_veranda', -3.6, -3.4, 'work_bistro', 1.0, 0.7),
  prop('bistro_booth_a', 'v3_cafe_booth', -3.6, 1.8, 'sit', 1.9, 1.0),
  prop('bistro_booth_b', 'v3_cafe_booth', 3.6, 1.8, 'sit', 1.9, 1.0),
  prop('bistro_tea_table', 'v3_tea_service', 3.6, -1.8, 'bistro_tea', 1.0, 0.7),
], { district: 'Neighborhood', openHours: [7, 22], discoverable: true });

zone('atelier', 'Riverside Art & Music Atelier', 14, false, 0xd7c8bc, [
  prop('atelier_easel_a', 'v3_art_easel', -3.8, -2.6, 'atelier_paint', 1.0, 0.8),
  prop('atelier_easel_b', 'v3_art_easel', -1.4, -3.4, 'lore_atelier_gallery', 1.0, 0.7),
  prop('atelier_acoustic', 'v3_acoustic_guitar', 3.8, -2.4, 'music_jam', 0.8, 0.8),
  prop('atelier_electric', 'v3_electric_guitar', 4.4, 1.6, 'music_jam', 0.8, 0.8),
  prop('atelier_photo_desk', 'v3_polaroid_prop', -3.8, 2.2, 'photo_album', 0.8, 0.7),
], { district: 'Parks & River', openHours: [9, 22], discoverable: true });

zone('botanical', 'Community Botanical Garden', 18, true, 0x88b07e, [
  prop('bot_gazebo', 'v3_park_gazebo', 0, -3.5, 'rest', 4.6, 4.6),
  prop('bot_bed_a', 'v3_garden_trough', -5.2, 2.0, 'garden_tend', 1.2, 0.6),
  prop('bot_bed_b', 'v3_garden_planter', 5.2, 2.0, 'garden_tend', 1.0, 0.8),
  prop('bot_can', 'v3_watering_can', -2.6, 3.8, 'garden_harvest', 0.5, 0.5),
  prop('bot_bench', 'v3_garden_bench', 3.6, -5.2, 'sit', 1.3, 0.6),
  prop('bot_cam', 'v3_camera_prop', -5.4, -4.8, 'photo_snap', 0.5, 0.5),
], { district: 'Hidden Gems', discoverable: true, hiddenUntilDiscovered: false });

zone('lantern_garden', 'Hidden Lantern Tea Garden', 18, true, 0x7da185, [
  prop('tea_pavilion_table', 'v3_tea_service', 0, -1.6, 'tea_ceremony', 1.1, 0.7),
  prop('lantern_post_l', 'v3_street_lantern', -4.8, -3.6, 'lore_lantern_secret', 0.8, 0.8),
  prop('lantern_post_r', 'v3_street_lantern', 4.8, -3.6, null, 0.8, 0.8),
  prop('lantern_bench', 'v3_garden_bench', -4.2, 3.4, 'rest', 1.3, 0.6),
  prop('lantern_cam', 'v3_camera_prop', 4.4, 3.2, 'photo_snap', 0.5, 0.5),
], { district: 'Hidden Gems', discoverable: true, hiddenUntilDiscovered: true });

zone('fountain_plaza', 'Old Campus Fountain Court', 20, true, 0xc3bea8, [
  prop('old_fountain', 'v3_fountain_court', 0, 0, 'lore_fountain_capsule', 2.8, 2.8),
  prop('plaza_stage', 'v3_festival_stage', 0, -6.4, 'music_jam', 4.6, 3.2),
  prop('plaza_obelisk', 'v3_statue_obelisk', -6.2, -4.4, 'lore_campus_founders', 1.1, 1.1),
  prop('plaza_booth', 'festival_booth', 6.4, -3.2, 'market_artisan', 2.0, 1.2),
  prop('plaza_bench_a', 'v3_garden_bench', -5.6, 4.4, 'sit', 1.3, 0.6),
  prop('plaza_bench_b', 'v3_garden_bench', 5.6, 4.4, 'sit', 1.3, 0.6),
], { district: 'Hidden Gems', discoverable: true, hiddenUntilDiscovered: true });

function connect(a, b, sideA, offsetA, sideB, offsetB) {
  for (const [from, to, side, t] of [[a, b, sideA, offsetA], [b, a, sideB, offsetB]]) {
    const z = zones[from];
    const edge = (side === 'N' || side === 'S' ? z.depth || z.size : z.size) / 2 - 0.35;
    const x = side === 'E' ? edge : side === 'W' ? -edge : t;
    const depth = side === 'N' ? -edge : side === 'S' ? edge : t;
    z.doors.push({ id: 'to-' + to, to, side, x, z: depth, action: 'door', model: 'home_main_entrance_door', width: 0, depth: 0 });
  }
}

// Existing V1 topology preserved verbatim
connect('study', 'hall', 'E', 0, 'W', 0);
connect('hall', 'living', 'E', 0, 'W', 0);
connect('hall', 'bedroom', 'N', 1, 'S', 0);
connect('hall', 'bath', 'S', 1, 'N', 0);
connect('living', 'kitchen', 'N', 0, 'S', 0);
connect('living', 'yard', 'E', 0, 'W', 0);
connect('yard', 'street', 'E', 0, 'W', 0);
connect('street', 'linh', 'N', -8, 'S', 0);
connect('street', 'minh', 'N', 0, 'S', 0);
connect('street', 'market', 'N', 9, 'S', 0);
connect('street', 'cafe', 'S', -8, 'N', 0);
connect('street', 'park', 'S', 1, 'N', 0);
connect('street', 'campus', 'E', 0, 'W', 0);
connect('park', 'fair', 'E', 0, 'W', 0);
connect('street', 'greenway', 'E', 8, 'W', 0);

// V2 home expansion doors
connect('hall', 'gaming_room', 'N', -1.8, 'S', 0);
connect('bedroom', 'balcony', 'N', 0, 'S', 0);
connect('yard', 'garage', 'N', 2.5, 'S', 0);

// V2 Commercial Row doors along Riverside Lane
connect('street', 'electronics_shop', 'S', -13, 'N', 0);
connect('street', 'furniture_shop', 'S', -3.5, 'N', 0);
connect('street', 'clothing_shop', 'S', 6.5, 'N', 0);
connect('street', 'vehicle_dealer', 'S', 12, 'N', 0);
connect('street', 'home_center', 'N', -13, 'S', 0);
connect('street', 'repair_shop', 'N', 4.5, 'S', 0);

// V3 Open-World Expansion Connections
connect('campus', 'library', 'N', -3.5, 'S', 0);
connect('campus', 'fountain_plaza', 'E', 0, 'W', 0);
connect('street', 'bistro', 'N', 13, 'S', 0);
connect('park', 'atelier', 'S', 0, 'N', 0);
connect('park', 'botanical', 'W', 0, 'E', 0);
connect('greenway', 'lantern_garden', 'N', 12, 'S', 0);

export const spawnAt = d => ({
  x: d.x + (d.side === 'W' ? 1 : d.side === 'E' ? -1 : 0),
  z: d.z + (d.side === 'N' ? 1 : d.side === 'S' ? -1 : 0),
});
export const portals = id => zones[id].doors;
