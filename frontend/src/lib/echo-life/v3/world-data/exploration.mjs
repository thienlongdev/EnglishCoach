import { awardCredits } from '../progression/engine.mjs';
import { awardSkillXp, awardReputation, unlockAchievement } from '../progression/skills.mjs';

export const LANDMARKS = [
  { id: 'lm_home_study', zone: 'study', name: 'Riverside Desk Corner', category: 'Home', xp: 15, summary: 'Your first window overlooking Riverside Lane where the semester begins.', secret: false },
  { id: 'lm_street_row', zone: 'street', name: 'Riverside Commercial Row', category: 'Neighborhood', xp: 20, summary: 'Six independent neighborhood shops lined along the river avenue.', secret: false },
  { id: 'lm_sunrise_market', zone: 'market', name: 'Sunrise Market Aisles', category: 'Shopping', xp: 20, summary: 'Mai’s budget-friendly student grocery stocked with local herbs and noodle kits.', secret: false },
  { id: 'lm_pixel_cafe', zone: 'cafe', name: 'Pixel Café Arcade Corner', category: 'Community', xp: 25, summary: 'Late-night student hangout powered by Huy’s repaired terminals and rhythm cabinets.', secret: false },
  { id: 'lm_willow_bistro', zone: 'bistro', name: 'Willow Corner Bistro', category: 'Community', xp: 30, summary: 'Khanh Ha’s warm bakery-café where morning espresso meets homemade matcha crepes.', secret: false },
  { id: 'lm_riverside_park', zone: 'park', name: 'Riverside Courts & Lawn', category: 'Parks', xp: 25, summary: 'Pickup basketball, badminton nets, and evening breezes beneath old shade trees.', secret: false },
  { id: 'lm_boardwalk_fair', zone: 'fair', name: 'Boardwalk Carnival Pier', category: 'Parks', xp: 30, summary: 'Yen Nhi’s sunlit fairground with ring-toss stalls, prize wheel, and crepe stand.', secret: false },
  { id: 'lm_atelier', zone: 'atelier', name: 'Riverside Art & Music Atelier', category: 'Arts', xp: 35, summary: 'Shared student studio where Diem My paints beside Hai Dang’s acoustic guitars.', secret: false },
  { id: 'lm_university_green', zone: 'campus', name: 'University Green Colonnade', category: 'Campus', xp: 25, summary: 'Heart of campus life, noticeboards, book carts, and the Student Connection Festival.', secret: false },
  { id: 'lm_university_library', zone: 'library', name: 'University Quiet Stacks', category: 'Campus', xp: 35, summary: 'An Chi’s sunlit archive housing decades of student club yearbooks and study tables.', secret: false },
  { id: 'lm_botanical_garden', zone: 'botanical', name: 'Community Botanical Pergola', category: 'Hidden Gems', xp: 45, summary: 'Ngoc Bich’s fragrant herbal courtyard tucked west of Riverside Park.', secret: false },
  { id: 'lm_greenway_loop', zone: 'greenway', name: 'Riverside Greenway Boulevard', category: 'Parks', xp: 30, summary: '220-metre tree-lined cycling and driving promenade shared by 80 neighborhood walkers.', secret: false },
  { id: 'lm_lantern_garden', zone: 'lantern_garden', name: 'Hidden Lantern Tea Garden', category: 'Hidden Gems', xp: 75, summary: 'A tranquil minka tea pavilion hidden off the north bend of Riverside Greenway.', secret: true },
  { id: 'lm_fountain_plaza', zone: 'fountain_plaza', name: 'Old Campus Fountain Court', category: 'Hidden Gems', xp: 70, summary: 'Stone courtyard east of University Green hosting acoustic evenings and artisan stalls.', secret: true },
  { id: 'lm_electronics_lab', zone: 'electronics_shop', name: 'Volt & Silicon Showroom', category: 'Shopping', xp: 25, summary: 'Bao Long’s custom workstation gallery and liquid-cooled hardware counter.', secret: false },
  { id: 'lm_furniture_atelier', zone: 'furniture_shop', name: 'Riverside Living Gallery', category: 'Shopping', xp: 25, summary: 'Kim Ngan’s curated interior rooms spanning Nordic, Engawa, and Palais design.', secret: false },
  { id: 'lm_vehicle_dealer', zone: 'vehicle_dealer', name: 'Greenway Motors Showroom', category: 'Shopping', xp: 25, summary: 'Tuan Kiet’s bicycles, motorbikes, and road-ready compact electric and sport cars.', secret: false },
  { id: 'lm_repair_workshop', zone: 'repair_shop', name: 'Tech & Fix Workbench', category: 'Shopping', xp: 25, summary: 'Duc Tri’s oil-scented repair bay where old frames and electronics get second lives.', secret: false },
  { id: 'lm_linh_studio', zone: 'linh', name: 'Linh’s Invitation Desk', category: 'Neighborhood', xp: 25, summary: 'Handwritten welcome cards and architectural sketches pinned across Linh’s quiet parlor.', secret: false },
  { id: 'lm_minh_den', zone: 'minh', name: 'Minh’s Court Prep Room', category: 'Neighborhood', xp: 25, summary: 'Basketball gear, rhythm headphones, and an electric guitar propped beside the bench.', secret: false },
];

export const COLLECTIBLES = [
  { id: 'col_study_bookmark', zone: 'study', x: 1.9, z: 1.8, model: 'campus_clipboard', name: 'Pressed Gingko Bookmark', category: 'Campus Lore', reward: 20, lore: 'Left inside the desk drawer by a previous tenant: "Say hello to the neighbor in the green jacket."' },
  { id: 'col_yard_compass', zone: 'yard', x: -4.8, z: -1.4, model: 'v3_trophy_cup', name: 'Brass Pocket Compass', category: 'Relic', reward: 25, lore: 'Engraved with "North of the Greenway bend, follow the warm lanterns."' },
  { id: 'col_street_postcard', zone: 'street', x: -12.5, z: -2.2, model: 'v3_polaroid_prop', name: '1998 Riverside Postcard', category: 'Vintage Photo', reward: 25, lore: 'Shows Riverside Lane when Sunrise Market was just a single wooden fruit cart.' },
  { id: 'col_market_recipe', zone: 'market', x: 4.4, z: -4.2, model: 'campus_clipboard', name: 'Mai’s Spice Ratio Card', category: 'Culinary Note', reward: 25, lore: 'Three dashes of roasted sesame and a pinch of ginger turn budget noodles into comfort food.' },
  { id: 'col_cafe_cassette', zone: 'cafe', x: -4.2, z: 3.6, model: 'cafe_headphones', name: 'Lo-Fi Rhythm Mixtape', category: 'Music Relic', reward: 30, lore: 'Huy and Duy Khoa’s original 120 BPM tracklist from their freshman hackathon.' },
  { id: 'col_park_badge', zone: 'park', x: 6.8, z: 6.0, model: 'v3_trophy_cup', name: 'Riverside Run Club Pin', category: 'Club Token', reward: 30, lore: 'Awarded to students who finish three morning loops without checking their phone.' },
  { id: 'col_fair_ticket', zone: 'fair', x: 4.8, z: 3.8, model: 'v3_polaroid_prop', name: 'Golden Carnival Stub', category: 'Vintage Photo', reward: 30, lore: 'From the first Boardwalk autumn fair — still smells faintly of vanilla crepes.' },
  { id: 'col_campus_charter', zone: 'campus', x: 7.4, z: -6.4, model: 'campus_clipboard', name: '1984 Student Union Charter', category: 'Campus Lore', reward: 35, lore: 'Article 1: "University Green shall remain open to every newcomer without ticket or fee."' },
  { id: 'col_library_folio', zone: 'library', x: -4.4, z: -4.4, model: 'campus_clipboard', name: 'Missing Folio Page #14', category: 'Campus Lore', reward: 40, lore: 'An Chi’s lost archive page detailing the original lantern procession across campus.' },
  { id: 'col_bistro_bean', zone: 'bistro', x: -4.2, z: -0.6, model: 'v3_tea_service', name: 'Highland Roast Tin', category: 'Culinary Note', reward: 30, lore: 'Khanh Ha’s prized sample roast from her family’s farm in the hills.' },
  { id: 'col_atelier_sketch', zone: 'atelier', x: -4.8, z: -4.6, model: 'v3_polaroid_prop', name: 'Charcoal Festival Blueprint', category: 'Art Sketch', reward: 35, lore: 'Diem My’s early watercolor concept of warm paper lanterns strung above University Green.' },
  { id: 'col_botanical_seed', zone: 'botanical', x: 5.8, z: -4.6, model: 'v3_watering_can', name: 'Moon-Jasmine Seed Packet', category: 'Botanical', reward: 40, lore: 'Blooms only after sunset — Ngoc Bich planted its parent shrub at the Lantern Tea Garden.' },
  { id: 'col_lantern_charm', zone: 'lantern_garden', x: 4.8, z: -0.8, model: 'v3_paper_lantern', name: 'Silk Wish Lantern Charm', category: 'Secret Relic', reward: 60, lore: 'Students write one wish for someone else before hanging a lantern under the minka eaves.' },
  { id: 'col_fountain_capsule', zone: 'fountain_plaza', x: -6.2, z: 1.6, model: 'v3_trophy_cup', name: '2019 Semester Time Capsule', category: 'Secret Relic', reward: 60, lore: 'Contains four Polaroids, a guitar pick, and a note: "Make room at the table for the quietest person."' },
  { id: 'col_greenway_polaroid', zone: 'greenway', x: -16, z: -12, model: 'v3_polaroid_prop', name: 'Dawn Over Greenway Polaroid', category: 'Vintage Photo', reward: 40, lore: 'Captured by Minh Thu at 06:05 AM when mist drifts across the cycling lane.' },
  { id: 'col_repair_wrench', zone: 'repair_shop', x: 3.4, z: 2.6, model: 'veh_part_wheel_std', name: 'Vintage Spokes Medallion', category: 'Mechanical', reward: 35, lore: 'Duc Tri’s grandfather built the first courier bicycle that ever rode Riverside Lane.' },
];

export const LORE_SPOTS = {
  lore_street_map: {
    title: 'Riverside Wayfinding Post',
    base: 'Arrows point north to Sunrise Market & Willow Corner Bistro, south to Commercial Row & Riverside Park, and east to University Green & the 220m Greenway.',
    chapterHint: ch => ch >= 2 ? 'Someone pinned a fresh hand-drawn arrow pointing beyond Greenway’s north bend: "Lanterns at dusk."' : 'A chalk note at the bottom reads: "Ask locals about hidden spots once you settle in."',
  },
  lore_neighborhood_board: {
    title: 'Neighborhood Bulletin Kiosk',
    base: 'Pinned flyers advertise Sunrise Market Tue/Thu produce specials, Pixel Café rhythm nights, and Weekend Artisan stalls at Old Fountain Court.',
    chapterHint: ch => ch >= 4 ? 'A bold ribbon reads: "STUDENT CONNECTION FESTIVAL — ALL WELCOME!"' : 'A crumpled Council memo mentions a pending budget review by Treasurer Hoang Phuc.',
  },
  lore_linh_sketches: {
    title: 'Linh’s Festival Concept Easel',
    base: 'Dozens of hand-lettered invitation mockups overlap on the canvas. Each one leaves space for a visitor’s name.',
    chapterHint: ch => ch >= 3 ? 'Your chosen festival theme is sketched proudly right across the top sheet!' : 'Small margin notes say: "Remember how loud the dining hall felt on Day 1."',
  },
  lore_park_trail: {
    title: 'Park Trailhead Plaque',
    base: 'West leads through a mossy timber arch to the Community Botanical Garden; south opens onto the Riverside Art & Music Atelier; east reaches Boardwalk Fair.',
    chapterHint: () => 'Tip: Bring a camera mindset — landmarks and events make great entries in your Photo Album.',
  },
  lore_campus_gate: {
    title: 'Campus Security Logbook',
    base: 'Officer Quoc Bao’s tidy clipboard notes evening library study groups, acoustic practices, and safe bike lanes along Riverside Lane.',
    chapterHint: () => 'A footnote reads: "East archway behind the colonnade leads to Old Campus Fountain Court."',
  },
  lore_greenway_mile: {
    title: 'Greenway Milepost & Lantern Marker',
    base: 'Built atop the old riverside towpath, the Greenway connects 80 neighborhood walkers, cyclists, and weekend drivers.',
    chapterHint: () => 'Look closely along the north border near x = +12: a quiet footpath opens into the Hidden Lantern Tea Garden.',
  },
  lore_library_folio: {
    title: 'University Archives Shelf',
    base: 'Bound student chronicles dating back to 1984 sit neatly indexed by An Chi.',
    chapterHint: () => 'One ribbon bookmark highlights an essay on how student festivals kept small clubs alive.',
  },
  lore_library_stacks: {
    title: 'Quiet Reading Alcove',
    base: 'Soft sunlight crosses rows of architecture, literature, and audio engineering volumes.',
    chapterHint: () => 'Margin pencils show Thao Vy’s neat handwriting beside poems about autumn rain.',
  },
  lore_atelier_gallery: {
    title: 'Atelier Exhibition Wall',
    base: 'Student canvases capture Riverside Park at sunrise, Pixel Café neon reflections, and rainy bus shelters.',
    chapterHint: ch => ch >= 4 ? 'A brand-new centerpiece canvas depicts your friends preparing the festival booths!' : 'One frame sits empty with a tag: "Reserved for this semester’s defining moment."',
  },
  lore_lantern_secret: {
    title: 'Lantern Tea Pavilion Inscription',
    base: 'Carved into cedar wood: "Leave rush at the gate; share a cup before sundown."',
    chapterHint: () => 'Every Sunday evening, locals gather quietly here for the Lantern Twilight Gathering.',
  },
  lore_fountain_capsule: {
    title: 'Old Fountain Stone Rim',
    base: 'Clear water ripples around carved stone lilies. Generational students drop paper boats here before finals.',
    chapterHint: () => 'Thursday and Saturday evenings fill this courtyard with Hai Dang’s open-mic acoustic sets.',
  },
  lore_campus_founders: {
    title: 'Founders’ Stone Obelisk',
    base: 'Dedicated to the first graduating class who built University Green as a shared commons for every discipline.',
    chapterHint: () => 'The base reads: "Knowledge grows fastest in good company."',
  },
};

export function discoverZone(s, zoneId) {
  const exp = s.worldV3?.exploration;
  if (!exp) return null;
  const newlyDiscovered = [];
  if (!exp.discoveredZones.includes(zoneId)) {
    exp.discoveredZones.push(zoneId);
  }
  for (const lm of LANDMARKS) {
    if (lm.zone === zoneId && !exp.discoveredLandmarks.includes(lm.id)) {
      exp.discoveredLandmarks.push(lm.id);
      awardSkillXp(s, 'social', Math.round(lm.xp * 0.6));
      awardSkillXp(s, 'mobility', Math.round(lm.xp * 0.4));
      awardReputation(s, 'neighbourhood', lm.secret ? 25 : 8);
      if (lm.secret) awardCredits(s, 45, { bounded: false });
      newlyDiscovered.push(lm);
    }
  }
  if (exp.discoveredLandmarks.length >= 10) unlockAchievement(s, 'v3_explorer_ten');
  if (exp.discoveredLandmarks.length >= LANDMARKS.length) unlockAchievement(s, 'v3_explorer_all');
  return newlyDiscovered[0] || null;
}

export function collectRelic(s, collectibleId) {
  const exp = s.worldV3?.exploration;
  if (!exp) return { ok: false, msg: 'Exploration log unavailable.' };
  const col = COLLECTIBLES.find(c => c.id === collectibleId);
  if (!col) return { ok: false, msg: 'Collectible not found.' };
  if (exp.collectibles.includes(col.id)) return { ok: false, msg: 'Already collected.' };
  exp.collectibles.push(col.id);
  awardCredits(s, col.reward, { bounded: false });
  awardSkillXp(s, 'social', 20);
  awardReputation(s, 'neighbourhood', 12);
  if (exp.collectibles.length >= 8) unlockAchievement(s, 'v3_collector_half');
  if (exp.collectibles.length >= COLLECTIBLES.length) unlockAchievement(s, 'v3_collector_all');
  return { ok: true, col, msg: `Collected ${col.name} (+${col.reward} CC)! "${col.lore}"` };
}

export function inspectLore(s, loreId) {
  const spot = LORE_SPOTS[loreId];
  if (!spot) return { ok: false, msg: 'Nothing unusual here.' };
  const exp = s.worldV3?.exploration;
  if (exp && !exp.loreRead.includes(loreId)) {
    exp.loreRead.push(loreId);
    awardSkillXp(s, 'social', 10);
  }
  const ch = Math.min(4, Math.floor((s.done?.length || 0) / 3));
  return { ok: true, msg: `${spot.title}: ${spot.base} ${spot.chapterHint(ch)}` };
}
