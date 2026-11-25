import { awardCredits, performWorkActivity } from '../progression/engine.mjs';
import { awardSkillXp, awardReputation, unlockAchievement } from '../progression/skills.mjs';
import { getActiveEvents, getCalendar, getWeather } from '../world-data/weather-events.mjs';
import { adjustRelationship } from '../npc-ai/relationships.mjs';
import { record } from '../story-and-quests/semester.mjs';
import { zones } from '../world-data/world.mjs';
import { SOCIAL_SCENES } from '../npc-ai/social-scenes.mjs';

/**
 * 32 Distinct Free-Roam Activity Variations across 6 Categories:
 * Social (6), University (5), Work & Business (6), Hobbies (7), Exploration (4), Home & Lifestyle (4).
 */
export const FREE_ROAM_ACTIVITY_CATALOG = [
  // Social (6)
  { id: 'act_social_chat', category: 'Social', title: 'Neighborhood Conversations', zone: 'street', mechanic: 'Contextual NPC dialogue with rotating memory/weather/event topics' },
  { id: 'act_social_bistro_outing', category: 'Social', title: 'Bistro Coffee & Crepe Outing', zone: 'bistro', mechanic: 'Share coffee/meal with any present NPC (+Friendship/Trust/Hunger/Mood)' },
  { id: 'act_social_gift_exchange', category: 'Social', title: 'Personalized Gift Giving', zone: 'market', mechanic: 'Match NPC loved items for +12 Friendship & persistent gift memory' },
  { id: 'act_social_group_scene', category: 'Social', title: 'Join Autonomous NPC Scenes', zone: 'campus', mechanic: 'Step into live 2-NPC conversations and workshops across town' },
  { id: 'act_social_host_home', category: 'Social', title: 'Host Friends at Your Residence', zone: 'living', mechanic: 'Invite friends (20+ Friendship) over; they react to your PC, style & Villa' },
  { id: 'act_social_resolve_rivalry', category: 'Social', title: 'Apologize & Resolve Rivalries', zone: 'campus', mechanic: 'Clear tension with rivals like Hoang Phuc or Duy Khoa' },

  // University (5)
  { id: 'act_uni_seminar', category: 'University', title: 'Optional Campus Seminar', zone: 'campus', mechanic: 'Interactive communication/critical-thinking mini-quiz at the exhibition easel' },
  { id: 'act_uni_library_study', category: 'University', title: 'University Library Deep Study', zone: 'library', mechanic: 'Quiet focus session at library tables (+Focus, +Tech/Social XP)' },
  { id: 'act_uni_english_cart', category: 'University', title: 'Campus Book Cart English Practice', zone: 'campus', mechanic: 'Natural invitation & conversation drills' },
  { id: 'act_uni_archive_research', category: 'University', title: 'Historical Archive Research', zone: 'library', mechanic: 'Inspect 1984 campus folios & uncover neighborhood mysteries' },
  { id: 'act_uni_club_planning', category: 'University', title: 'Student Club Noticeboard Planning', zone: 'campus', mechanic: 'Organize campus themes, supplies, and recurring festival booths' },

  // Work & Business (6)
  { id: 'act_work_cafe_tech', category: 'Work & Business', title: 'Pixel Café PC Support Shift', zone: 'cafe', mechanic: 'Paid bounded shift (+CC, Tech XP, electronics materials)' },
  { id: 'act_work_market_clerk', category: 'Work & Business', title: 'Sunrise Market Clerk Shift', zone: 'market', mechanic: 'Paid bounded shift (+CC, Business XP, ingredients)' },
  { id: 'act_work_repair_bench', category: 'Work & Business', title: 'Tech & Fix Repair Workshop Shift', zone: 'repair_shop', mechanic: 'Paid bounded shift (+CC, DIY XP, metal/vehicle parts)' },
  { id: 'act_work_bistro_barista', category: 'Work & Business', title: 'Willow Corner Barista Shift', zone: 'bistro', mechanic: 'Pull espresso & serve crepes (+105 CC, +26 Cooking XP, ingredients)' },
  { id: 'act_work_greenway_delivery', category: 'Work & Business', title: 'Greenway Express Bike/Car Delivery', zone: 'street', mechanic: 'Accept parcel on Riverside Lane → physically deliver to Greenway Milepost (+125 CC!)' },
  { id: 'act_work_artisan_booth', category: 'Work & Business', title: 'Weekend Artisan Pop-Up Booth', zone: 'fountain_plaza', mechanic: 'Run a handmade stall at Old Fountain Court (+CC, Hosting Rep)' },

  // Hobbies (7)
  { id: 'act_hobby_photography', category: 'Hobbies', title: 'Riverside Photography & Photo Album', zone: 'park', mechanic: 'Frame landmarks, weather & NPCs into a persistent Photo Album' },
  { id: 'act_hobby_music_jam', category: 'Hobbies', title: 'Acoustic & Electric Guitar Jam', zone: 'atelier', mechanic: '4-beat chord rhythm challenge at Atelier, Minh’s house, or Fountain Court' },
  { id: 'act_hobby_gardening', category: 'Hobbies', title: 'Community & Home Gardening', zone: 'botanical', mechanic: 'Plant, water, and harvest fresh herbs/tea leaves for cooking & gifting' },
  { id: 'act_hobby_cooking', category: 'Hobbies', title: '6-Recipe Student Kitchen Cooking', zone: 'kitchen', mechanic: 'Prep, cook, serve, eat, and wash dishes across 6 recipes with upgraded stove perks' },
  { id: 'act_hobby_arcade', category: 'Hobbies', title: 'Pixel Café Rhythm Arcade', zone: 'cafe', mechanic: 'Sequence memory challenge with daily CC rewards & Duy Khoa rivalry' },
  { id: 'act_hobby_sports', category: 'Hobbies', title: 'Park Basketball & Badminton', zone: 'park', mechanic: 'Timing-bar sports + bench fitness workouts (+Mobility XP, +Fitness)' },
  { id: 'act_hobby_fair_games', category: 'Hobbies', title: 'Boardwalk Ring Toss & Prize Wheel', zone: 'fair', mechanic: 'Fairground timing challenge & daily prize wheel spin' },

  // Exploration (4)
  { id: 'act_exp_landmarks', category: 'Exploration', title: '20-Landmark Discovery Codex', zone: 'greenway', mechanic: 'Explore all 31 zones including 2 secret hidden locations off the map' },
  { id: 'act_exp_collectibles', category: 'Exploration', title: '16 Hidden Keepsake Relics', zone: 'lantern_garden', mechanic: 'Find physical 3D relics with neighborhood lore & milestone unlocks' },
  { id: 'act_exp_lore', category: 'Exploration', title: 'Environmental Storytelling Plaques', zone: 'fountain_plaza', mechanic: '12 world spots whose notes evolve with your story chapter' },
  { id: 'act_exp_world_events', category: 'Exploration', title: '9 Dynamic World Events', zone: 'campus', mechanic: 'Participate in live time/day/weather-reactive neighborhood gatherings' },

  // Home & Lifestyle (4)
  { id: 'act_home_pc_builder', category: 'Home & Lifestyle', title: 'Modular PC Building & Benchmarking', zone: 'study', mechanic: 'Assemble CPU/GPU/RAM/Cooling/1–4 Monitors with 3D previews & focus multipliers' },
  { id: 'act_home_build_mode', category: 'Home & Lifestyle', title: 'Build Mode & 7 Room Styles', zone: 'living', mechanic: 'Place, rotate, paint, and restyle rooms with doorway-safe collision & Undo/Redo' },
  { id: 'act_home_vehicles', category: 'Home & Lifestyle', title: 'Two-Wheeler Tuning & 4-Wheel Car Driving', zone: 'yard', mechanic: 'Customize & ride 10 bikes/motos and drive 4 Wave 03 cars on open roads' },
  { id: 'act_home_tea_ceremony', category: 'Home & Lifestyle', title: 'Hidden Lantern Tea Ceremony', zone: 'lantern_garden', mechanic: 'Peaceful twilight tea ritual restoring Mood, Focus & Energy' },
];

export const SEMINAR_QUESTIONS = [
  {
    q: 'Ms. Lan’s Seminar: A shy classmate sits silently during group discussion. What opens the floor best?',
    options: [
      { key: 'sem_good', label: 'Ask one focused open question and pause patiently for their thought.', correct: true },
      { key: 'sem_bad', label: 'Speak over them to keep the meeting moving quickly.', correct: false },
    ],
  },
  {
    q: 'Campus Economics Mini-Case: How can a student festival stay free for freshmen without cutting scholarships?',
    options: [
      { key: 'sem_good', label: 'Partner with neighborhood shops for shared supply sponsorships.', correct: true },
      { key: 'sem_bad', label: 'Charge steep entry tickets at the University Green gate.', correct: false },
    ],
  },
  {
    q: 'Urban Design Prompt: What makes a campus street feel alive across morning, afternoon, and night?',
    options: [
      { key: 'sem_good', label: 'Mixed spaces — markets, study benches, cafés, and safe cycling lanes.', correct: true },
      { key: 'sem_bad', label: 'Closing every bench and courtyard outside lecture hours.', correct: false },
    ],
  },
];

function recordActivityCount(s, key) {
  if (!s.worldV3) return;
  s.worldV3.activityCounts[key] = (s.worldV3.activityCounts[key] || 0) + 1;
}

export function performFreeRoamAction(s, actionType, choiceKey = null) {
  const w3 = s.worldV3;
  if (!w3) return { ok: false, msg: 'World activity system not initialized.' };

  if (actionType === 'work_bistro') {
    if (s.needs.energy < 15) return { ok: false, msg: 'Too tired for a barista shift. Rest or grab a snack first.' };
    const granted = awardCredits(s, 105, { bounded: true });
    if (granted <= 0) return { ok: false, msg: 'Daily work earning cap reached. Try hobbies, exploration, or rest until tomorrow!' };
    s.needs.energy = Math.max(0, s.needs.energy - 14);
    s.clock += 50;
    s.progression.materials.ingredients = (s.progression.materials.ingredients || 0) + 2;
    awardSkillXp(s, 'cooking', 26);
    awardReputation(s, 'neighbourhood', 10);
    recordActivityCount(s, 'bistro_shift');
    record(s, 'activity:bistro_or_cook');
    return { ok: true, msg: `Willow Corner Barista Shift complete: +${granted} CC, +26 Cooking XP, +2 Ingredients!` };
  }

  if (actionType === 'bistro_order' || actionType === 'bistro_snack') {
    const cost = 12;
    if (s.progression.economy.credits < cost) return { ok: false, msg: `Need ${cost} CC for a fresh Matcha Crepe & Espresso.` };
    s.progression.economy.credits -= cost;
    s.progression.economy.lifetimeSpent += cost;
    s.cash = s.progression.economy.credits;
    s.needs.hunger = Math.min(100, s.needs.hunger + 30);
    s.needs.energy = Math.min(100, s.needs.energy + 18);
    s.needs.mood = Math.min(100, s.needs.mood + 12);
    s.bag.matcha_crepe = (s.bag.matcha_crepe || 0) + 1;
    recordActivityCount(s, 'bistro_order');
    return { ok: true, msg: 'Ordered a warm Matcha Crepe & Espresso (-12 CC): +30 Hunger, +18 Energy, +12 Mood, +1 Matcha Crepe packed in bag!' };
  }

  if (actionType === 'bistro_tea' || actionType === 'tea_ceremony') {
    s.needs.mood = Math.min(100, s.needs.mood + 20);
    s.needs.focus = Math.min(100, s.needs.focus + 18);
    s.needs.energy = Math.min(100, s.needs.energy + 15);
    s.bag.herbal_tea = (s.bag.herbal_tea || 0) + 1;
    awardSkillXp(s, 'social', 18);
    recordActivityCount(s, 'tea_ceremony');
    if (actionType === 'tea_ceremony') record(s, 'sq:finish_green_thumbs');
    return { ok: true, msg: 'Steeped fragrant moon-jasmine herbal tea (+20 Mood, +18 Focus, +15 Energy, +1 Herbal Tea in bag).' };
  }

  if (actionType === 'library_study') {
    s.needs.focus = Math.min(100, s.needs.focus + 24);
    s.needs.energy = Math.max(0, s.needs.energy - 6);
    s.clock += 35;
    awardSkillXp(s, 'technology', 20);
    awardSkillXp(s, 'social', 15);
    recordActivityCount(s, 'library_study');
    record(s, 'study');
    return { ok: true, msg: 'Quiet Library Deep Study (+24 Focus, +20 Tech XP, +15 Social XP).' };
  }

  if (actionType === 'archive_research') {
    s.needs.focus = Math.min(100, s.needs.focus + 12);
    awardSkillXp(s, 'social', 22);
    awardReputation(s, 'campus', 10);
    recordActivityCount(s, 'archive_research');
    return { ok: true, msg: 'Archive Research: Found references to the 1984 Open Campus Charter and the Old Fountain Court east of University Green!' };
  }

  if (actionType === 'atelier_paint') {
    s.needs.mood = Math.min(100, s.needs.mood + 16);
    s.progression.materials.decor_materials = (s.progression.materials.decor_materials || 0) + 1;
    awardSkillXp(s, 'diy_design', 25);
    recordActivityCount(s, 'atelier_paint');
    return { ok: true, msg: 'Sketched a Riverside canvas at the Atelier (+16 Mood, +25 DIY XP, +1 Decor Material).' };
  }

  if (actionType === 'garden_tend') {
    w3.gardenPlots = (w3.gardenPlots || 0) + 1;
    s.needs.mood = Math.min(100, s.needs.mood + 10);
    awardSkillXp(s, 'cooking', 16);
    awardSkillXp(s, 'diy_design', 12);
    recordActivityCount(s, 'garden_tend');
    return { ok: true, msg: `Watered and tended the herb beds (Plot growth: ${w3.gardenPlots}). Use the watering can or planter again to harvest fresh greens & tea!` };
  }

  if (actionType === 'garden_harvest') {
    s.bag.greens = (s.bag.greens || 0) + 2;
    s.bag.herbal_tea = (s.bag.herbal_tea || 0) + 1;
    s.progression.materials.ingredients = (s.progression.materials.ingredients || 0) + 2;
    awardSkillXp(s, 'cooking', 22);
    recordActivityCount(s, 'garden_harvest');
    return { ok: true, msg: 'Harvested fresh garden herbs! (+2 Greens, +1 Herbal Tea, +2 Ingredients, +22 Cooking XP)' };
  }

  if (actionType === 'photo_snap' || actionType === 'photo_album') {
    if (actionType === 'photo_album') {
      return { ok: true, msg: `Opening Explore & Photo Album (${w3.photos.length} snapshots saved)…`, openPanel: 'explore' };
    }
    const cal = getCalendar(s.clock);
    const weather = getWeather(s);
    const zoneLabel = zones[s.player.zone]?.label || s.player.zone;
    const npcsPresent = Object.values(s.npcs || {}).filter(n => n.zone === s.player.zone).map(n => n.id);
    const shot = {
      id: 'photo_' + (w3.photos.length + 1),
      zone: s.player.zone,
      title: `${zoneLabel} · ${weather.label} (${cal.weekday} ${cal.timeText})`,
      subjects: npcsPresent.slice(0, 3),
      day: s.day,
    };
    w3.photos.push(shot);
    if (w3.photos.length > 36) w3.photos = w3.photos.slice(-36);
    awardSkillXp(s, 'diy_design', 18);
    awardCredits(s, 20, { bounded: true });
    recordActivityCount(s, 'photo_snap');
    record(s, 'activity:outfit_or_photo');
    if (w3.photos.length >= 2) record(s, 'activity:photo_two');
    if (w3.photos.length >= 5) unlockAchievement(s, 'v3_photographer');
    return { ok: true, msg: `Snapshot saved to Photo Album: "${shot.title}" (+20 CC, +18 DIY XP)!` };
  }

  if (actionType === 'delivery_start') {
    if (w3.activeDelivery) {
      return { ok: true, msg: 'Greenway Express parcel already in hand! Head east into Riverside Greenway and drop it at the Milepost Kiosk (x = +22).' };
    }
    w3.activeDelivery = { startedAt: s.clock, targetZone: 'greenway', reward: 125 };
    return { ok: true, msg: 'Picked up a Greenway Express parcel! Ride or drive into Riverside Greenway and deliver it at the Milepost Kiosk (x = +22) for +125 CC!' };
  }

  if (actionType === 'delivery_drop') {
    if (!w3.activeDelivery) {
      return { ok: false, msg: 'Pick up a delivery parcel at the Courier Board on Riverside Lane first.' };
    }
    const granted = awardCredits(s, w3.activeDelivery.reward, { bounded: true });
    w3.activeDelivery = null;
    awardSkillXp(s, 'mobility', 34);
    awardSkillXp(s, 'business', 20);
    awardReputation(s, 'neighbourhood', 15);
    recordActivityCount(s, 'delivery_completed');
    record(s, 'activity:delivery_or_tune');
    record(s, 'activity:greenway_drive');
    return { ok: true, msg: `Greenway Express Delivery completed! +${granted} CC, +34 Mobility XP, +20 Business XP!` };
  }

  if (actionType === 'fair_spin') {
    if (w3.lastFairSpinDay === s.day) return { ok: false, msg: 'You already spun the Boardwalk Prize Wheel today. Come back tomorrow!' };
    w3.lastFairSpinDay = s.day;
    const prize = 35 + ((s.day * 17 + Math.floor(s.clock)) % 45);
    awardCredits(s, prize, { bounded: true });
    s.needs.mood = Math.min(100, s.needs.mood + 10);
    awardSkillXp(s, 'social', 15);
    recordActivityCount(s, 'fair_spin');
    record(s, 'activity:night_watch_clue');
    return { ok: true, msg: `Boardwalk Prize Wheel landed on +${prize} CC and +10 Mood!` };
  }

  if (actionType === 'market_artisan') {
    const res = performWorkActivity(s, 'shopkeeping_popup', s.owner);
    recordActivityCount(s, 'artisan_booth');
    return res;
  }

  if (actionType === 'campus_seminar') {
    if (choiceKey === 'sem_bad') {
      return { ok: false, msg: 'Not quite — remember Ms. Lan’s principle: invite every voice and build sustainable consensus. Try the other response!' };
    }
    awardSkillXp(s, 'social', 24);
    awardSkillXp(s, 'business', 16);
    awardReputation(s, 'campus', 14);
    s.needs.focus = Math.min(100, s.needs.focus + 14);
    recordActivityCount(s, 'campus_seminar');
    return { ok: true, msg: 'Great seminar insight! (+24 Social XP, +16 Business XP, +14 Campus Rep, +14 Focus)' };
  }

  if (actionType === 'event_participate') {
    const activeEvents = getActiveEvents(s);
    const ev = activeEvents.find(e => e.zone === s.player.zone);
    if (!ev) return { ok: false, msg: 'No live world event in this zone right now.' };
    const eventKey = `${ev.id}@day${s.day}`;
    if (w3.eventsAttended.includes(eventKey)) {
      return { ok: true, msg: `You’re already enjoying ${ev.title} — chat with the neighbors gathered here!` };
    }
    w3.eventsAttended.push(eventKey);
    const granted = awardCredits(s, ev.rewardCredits, { bounded: true });
    awardSkillXp(s, ev.rewardSkill || 'social', 32);
    awardReputation(s, 'neighbourhood', 18);
    s.needs.mood = Math.min(100, s.needs.mood + 16);
    for (const pid of ev.participants.slice(0, 3)) {
      adjustRelationship(s, pid, { friendship: 4, familiarity: 5 }, {
        type: 'attended_event',
        detail: `shared ${ev.title}`,
      });
    }
    recordActivityCount(s, 'world_events');
    if (w3.eventsAttended.length >= 3) unlockAchievement(s, 'v3_event_regular');
    return { ok: true, msg: `Joined ${ev.title}! +${granted} CC, +32 XP, +16 Mood, and friendship boosts with attendees!` };
  }

  if (actionType === 'join_social_scene') {
    const sc = SOCIAL_SCENES.find(x => x.id === choiceKey);
    if (!sc) return { ok: false, msg: 'That conversation has wrapped up.' };
    for (const pid of sc.participants) {
      adjustRelationship(s, pid, { friendship: 5, familiarity: 6, trust: 3 }, {
        type: 'joined_group_scene',
        detail: sc.caption,
      });
    }
    awardSkillXp(s, sc.rewardSkill || 'social', 20);
    s.needs.mood = Math.min(100, s.needs.mood + 8);
    recordActivityCount(s, 'social_scenes_joined');
    return { ok: true, msg: sc.joinReply + ' (+5 Friendship with both neighbors, +20 XP)' };
  }

  return { ok: false, msg: 'Activity unavailable.' };
}
