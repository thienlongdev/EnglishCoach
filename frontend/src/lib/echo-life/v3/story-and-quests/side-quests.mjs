import { awardCredits } from '../progression/engine.mjs';
import { awardSkillXp, awardReputation, unlockAchievement } from '../progression/skills.mjs';
import { adjustRelationship } from '../npc-ai/relationships.mjs';

/**
 * 14 Multi-Stage Side Quest Chains (3-4 stages each) spanning every district & mechanic:
 * investigation, cooking, photography, PC building, music, character growth, esports,
 * botany/secret discovery, cycling/mechanics, economics/rivalry, interior design, fashion,
 * neighborhood watch mystery, and drivable car road certification.
 */
export const SIDE_QUESTS = [
  {
    id: 'sq_missing_folio',
    title: 'The Missing Library Folio',
    leadNpc: 'anchi',
    supportingNpcs: ['lan'],
    category: 'Investigation',
    summary: 'Help librarian An Chi recover the missing 1984 Student Union Festival folio page.',
    stages: [
      { id: 'talk_anchi', label: 'Speak with An Chi in University Library about the missing archive page', event: 'sq:talk_anchi' },
      { id: 'inspect_archive', label: 'Search the library catalog & collect Missing Folio Page #14 in University Library', event: 'collect:col_library_folio' },
      { id: 'return_folio', label: 'Return the folio to An Chi or inspect the Founders’ Obelisk at Old Fountain Court', event: 'sq:finish_missing_folio' },
    ],
    rewards: { credits: 140, skill: 'social', skillXp: 65, rep: ['campus', 35], materials: { decor_materials: 2 } },
  },
  {
    id: 'sq_midnight_espresso',
    title: 'Midnight Espresso & Morning Crust',
    leadNpc: 'khanhha',
    supportingNpcs: ['mai'],
    category: 'Culinary & Business',
    summary: 'Partner with Khanh Ha and Mai to launch Willow Corner Bistro’s student breakfast combo.',
    stages: [
      { id: 'talk_khanhha', label: 'Visit Khanh Ha at Willow Corner Bistro to discuss her breakfast menu', event: 'sq:talk_khanhha' },
      { id: 'barista_or_cook', label: 'Work a barista shift at Willow Corner Bistro or cook a fresh dish at home', event: 'activity:bistro_or_cook' },
      { id: 'launch_combo', label: 'Taste-test the finished menu with Khanh Ha at Willow Corner Bistro', event: 'sq:finish_midnight_espresso' },
    ],
    rewards: { credits: 155, skill: 'cooking', skillXp: 75, rep: ['neighbourhood', 30], materials: { ingredients: 4 } },
  },
  {
    id: 'sq_frame_by_frame',
    title: 'Frame by Frame',
    leadNpc: 'minhthu',
    supportingNpcs: ['diemmy'],
    category: 'Photography & Exploration',
    summary: 'Capture candid campus and riverside landmarks for Minh Thu’s photojournalism feature.',
    stages: [
      { id: 'talk_minhthu', label: 'Meet Minh Thu to join her Riverside photo essay project', event: 'sq:talk_minhthu' },
      { id: 'snap_two', label: 'Snap 2 landmark photos using camera spots (Park, Botanical, Greenway, or Lantern Garden)', event: 'activity:photo_two' },
      { id: 'curate_atelier', label: 'Review your developed prints at Riverside Art & Music Atelier with Minh Thu', event: 'sq:finish_frame_by_frame' },
    ],
    rewards: { credits: 160, skill: 'diy_design', skillXp: 70, rep: ['campus', 25], materials: { decor_materials: 2, paper: 0 } },
  },
  {
    id: 'sq_silicon_dreams',
    title: 'Silicon Dreams',
    leadNpc: 'baolong',
    supportingNpcs: ['huy'],
    category: 'Tech & PC Building',
    summary: 'Work with Bao Long to assemble and benchmark a real upgraded workstation in your home.',
    stages: [
      { id: 'talk_baolong', label: 'Talk to Bao Long at Volt & Silicon Electronics about custom builds', event: 'sq:talk_baolong' },
      { id: 'own_pc', label: 'Own a PC workstation and install at least 1 hardware upgrade in PC Lab', event: 'progression:pc_upgraded' },
      { id: 'show_benchmark', label: 'Report your benchmark results back to Bao Long', event: 'sq:finish_silicon_dreams' },
    ],
    rewards: { credits: 210, skill: 'technology', skillXp: 90, rep: ['craft', 35], materials: { electronics: 3 } },
  },
  {
    id: 'sq_strings_riverbank',
    title: 'Strings on the Riverbank',
    leadNpc: 'haidang',
    supportingNpcs: ['linh', 'diemmy'],
    category: 'Music & Culture',
    summary: 'Help Hai Dang rehearse and stage a twilight acoustic session at Old Campus Fountain Court.',
    stages: [
      { id: 'talk_haidang', label: 'Talk to Hai Dang about his acoustic open-mic dream', event: 'sq:talk_haidang' },
      { id: 'jam_guitar', label: 'Play an Acoustic Guitar Rhythm Jam at Riverside Atelier or Old Fountain Court', event: 'activity:music_jam' },
      { id: 'encore_stage', label: 'Celebrate the courtyard acoustic set with Hai Dang', event: 'sq:finish_strings_riverbank' },
    ],
    rewards: { credits: 165, skill: 'social', skillXp: 75, rep: ['campus', 30], materials: { wood: 2 } },
  },
  {
    id: 'sq_quiet_seat',
    title: 'The Quiet Seat by the Window',
    leadNpc: 'thaovy',
    supportingNpcs: ['linh', 'anchi'],
    category: 'Character Story',
    summary: 'Befriend shy first-year poet Thao Vy and help her find the courage to share her voice.',
    stages: [
      { id: 'meet_thaovy', label: 'Introduce yourself gently to Thao Vy (check University Library or Botanical Garden)', event: 'sq:talk_thaovy' },
      { id: 'support_thaovy', label: 'Share tea/coffee, study together, or gift Thao Vy something thoughtful (Friendship 20+)', event: 'rel:thaovy_20' },
      { id: 'encourage_reading', label: 'Encourage Thao Vy to read her poem aloud at the Atelier or Festival', event: 'sq:finish_quiet_seat' },
    ],
    rewards: { credits: 150, skill: 'social', skillXp: 85, rep: ['neighbourhood', 35], materials: { fabric: 2 } },
  },
  {
    id: 'sq_rivals_120bpm',
    title: 'Rivals at 120 BPM',
    leadNpc: 'duykhoa',
    supportingNpcs: ['huy'],
    category: 'Gaming & Rivalry',
    summary: 'Answer Duy Khoa’s arcade challenge at Pixel Café and turn trash-talk into real respect.',
    stages: [
      { id: 'talk_duykhoa', label: 'Accept Duy Khoa’s rhythm-cabinet gauntlet at Pixel Café', event: 'sq:talk_duykhoa' },
      { id: 'win_rhythm', label: 'Clear a rhythm challenge at Pixel Café', event: 'win-arcade' },
      { id: 'claim_respect', label: 'Shake hands with Duy Khoa after proving your timing', event: 'sq:finish_rivals_120bpm' },
    ],
    rewards: { credits: 170, skill: 'technology', skillXp: 80, rep: ['campus', 25], materials: { electronics: 2 } },
  },
  {
    id: 'sq_green_thumbs',
    title: 'Green Thumbs & Forgotten Seeds',
    leadNpc: 'ngocbich',
    supportingNpcs: ['mai'],
    category: 'Botany & Secrets',
    summary: 'Help Ngoc Bich nurture moon-jasmine seedlings and uncover the Hidden Lantern Tea Garden.',
    stages: [
      { id: 'talk_ngocbich', label: 'Meet Ngoc Bich in Community Botanical Garden (west of Riverside Park)', event: 'sq:talk_ngocbich' },
      { id: 'tend_garden', label: 'Tend a garden bed and discover the Hidden Lantern Tea Garden off Riverside Greenway', event: 'discover:lantern_garden' },
      { id: 'tea_ritual', label: 'Share a quiet tea ceremony with Ngoc Bich at the Lantern Pavilion', event: 'sq:finish_green_thumbs' },
    ],
    rewards: { credits: 185, skill: 'cooking', skillXp: 70, rep: ['neighbourhood', 40], materials: { ingredients: 3, wood: 2 } },
  },
  {
    id: 'sq_steel_spokes',
    title: 'Steel, Spokes & Second Chances',
    leadNpc: 'ductri',
    supportingNpcs: ['tuankiet'],
    category: 'Vehicles & Mechanics',
    summary: 'Complete a Greenway Express courier run and tune up a two-wheeler with master mechanic Duc Tri.',
    stages: [
      { id: 'talk_ductri', label: 'Speak with Duc Tri at Tech & Fix Repair Workshop', event: 'sq:talk_ductri' },
      { id: 'courier_run', label: 'Complete a Greenway Express Delivery or customize a vehicle component', event: 'activity:delivery_or_tune' },
      { id: 'workshop_cert', label: 'Check back in with Duc Tri for your craftsman sign-off', event: 'sq:finish_steel_spokes' },
    ],
    rewards: { credits: 195, skill: 'mobility', skillXp: 85, rep: ['craft', 35], materials: { vehicle_parts: 3, metal: 2 } },
  },
  {
    id: 'sq_treasurers_ledger',
    title: 'The Treasurer’s Ledger',
    leadNpc: 'hoangphuc',
    supportingNpcs: ['lan'],
    category: 'Character & Economics',
    summary: 'Look past Hoang Phuc’s stiff opposition to learn why he guards the student scholarship reserve.',
    stages: [
      { id: 'talk_hoangphuc', label: 'Speak with Hoang Phuc on University Green or in University Library', event: 'sq:talk_hoangphuc' },
      { id: 'clear_tension', label: 'Resolve tension with Hoang Phuc (Apologize/Clear the Air or broker the budget coalition)', event: 'rel:hoangphuc_resolved' },
      { id: 'balanced_plan', label: 'Finalize a scholarship-safe festival funding ledger with Hoang Phuc', event: 'sq:finish_treasurers_ledger' },
    ],
    rewards: { credits: 200, skill: 'business', skillXp: 90, rep: ['campus', 40], materials: { electronics: 1, decor_materials: 2 } },
  },
  {
    id: 'sq_rooms_stories',
    title: 'Rooms That Tell Stories',
    leadNpc: 'kimngan',
    supportingNpcs: ['quangvinh'],
    category: 'Home & Interior Design',
    summary: 'Design an expressive home corner with Kim Ngan using Build Mode, finishes, or Room Styles.',
    stages: [
      { id: 'talk_kimngan', label: 'Consult Kim Ngan at Riverside Living & Atelier', event: 'sq:talk_kimngan' },
      { id: 'style_or_build', label: 'Customize a furniture finish, place new furniture, or apply a Room Style in Build Mode', event: 'progression:build_styled' },
      { id: 'showcase_home', label: 'Share your redesigned home concept with Kim Ngan', event: 'sq:finish_rooms_stories' },
    ],
    rewards: { credits: 190, skill: 'diy_design', skillXp: 90, rep: ['hosting', 35], materials: { wood: 3, fabric: 2, decor_materials: 2 } },
  },
  {
    id: 'sq_threads_identity',
    title: 'Threads of Identity',
    leadNpc: 'phuonglien',
    supportingNpcs: ['minh'],
    category: 'Fashion & Community',
    summary: 'Help Phuong Lien prepare a campus streetwear lookbook celebrating everyday student confidence.',
    stages: [
      { id: 'talk_phuonglien', label: 'Visit Phuong Lien at Thread & Campus Apparel', event: 'sq:talk_phuonglien' },
      { id: 'outfit_and_photo', label: 'Change your outfit at your wardrobe (or buy an outfit) and snap a photo outdoors', event: 'activity:outfit_or_photo' },
      { id: 'lookbook_reveal', label: 'Review the finished lookbook spread with Phuong Lien', event: 'sq:finish_threads_identity' },
    ],
    rewards: { credits: 165, skill: 'social', skillXp: 70, rep: ['hosting', 25], materials: { fabric: 3 } },
  },
  {
    id: 'sq_night_watch',
    title: 'Night Watch on Riverside Lane',
    leadNpc: 'quocbao',
    supportingNpcs: ['yennhi'],
    category: 'Neighborhood Mystery',
    summary: 'Investigate why festival lanterns keep moving between Boardwalk Fair and Riverside Lane.',
    stages: [
      { id: 'talk_quocbao', label: 'Check in with Officer Quoc Bao on Riverside Lane or University Green', event: 'sq:talk_quocbao' },
      { id: 'inspect_clues', label: 'Inspect the Neighborhood Bulletin Kiosk or play Ring Toss at Boardwalk Fair', event: 'activity:night_watch_clue' },
      { id: 'solve_lanterns', label: 'Report the harmless prank (student decorators!) to Quoc Bao & Yen Nhi', event: 'sq:finish_night_watch' },
    ],
    rewards: { credits: 175, skill: 'social', skillXp: 75, rep: ['neighbourhood', 40], materials: { decor_materials: 2, metal: 1 } },
  },
  {
    id: 'sq_open_road',
    title: 'Open-Road Permit',
    leadNpc: 'tuankiet',
    supportingNpcs: ['ductri', 'baolong'],
    category: 'Driving & Mobility',
    summary: 'Earn Tuan Kiet’s Greenway Road Certification — unlocking test-drive & full four-wheel automobile cruising!',
    stages: [
      { id: 'talk_tuankiet', label: 'Speak with Tuan Kiet at Greenway Motors & Cycles about driving on Riverside roads', event: 'sq:talk_tuankiet' },
      { id: 'road_practice', label: 'Ride or drive down Riverside Greenway to prove safe road control', event: 'activity:greenway_drive' },
      { id: 'permit_granted', label: 'Collect your Open-Road Driving Permit & test-car key from Tuan Kiet!', event: 'sq:finish_open_road' },
    ],
    rewards: { credits: 220, skill: 'mobility', skillXp: 95, rep: ['neighbourhood', 35], materials: { vehicle_parts: 3 } },
  },
];

export function initSideQuestsState() {
  return Object.fromEntries(
    SIDE_QUESTS.map(q => [q.id, { started: false, stage: 0, done: false }])
  );
}

export function getSideQuest(id) {
  return SIDE_QUESTS.find(q => q.id === id);
}

export function advanceSideQuests(s, event) {
  const map = s.worldV3?.sideQuests;
  if (!map) return [];
  const messages = [];

  for (const q of SIDE_QUESTS) {
    const st = (map[q.id] ||= { started: false, stage: 0, done: false });
    if (st.done) continue;
    const current = q.stages[st.stage];
    if (!current) continue;
    if (current.event !== event) continue;

    st.started = true;
    st.stage += 1;
    if (st.stage >= q.stages.length) {
      st.done = true;
      awardCredits(s, q.rewards.credits, { bounded: false });
      awardSkillXp(s, q.rewards.skill, q.rewards.skillXp);
      if (q.rewards.rep) awardReputation(s, q.rewards.rep[0], q.rewards.rep[1]);
      for (const [mat, qty] of Object.entries(q.rewards.materials || {})) {
        if (qty > 0 && Object.hasOwn(s.progression.materials, mat)) {
          s.progression.materials[mat] += qty;
        }
      }
      adjustRelationship(s, q.leadNpc, { friendship: 14, trust: 12, respect: 10 }, {
        type: 'completed_side_arc',
        detail: `finished "${q.title}" together`,
      });
      for (const sup of q.supportingNpcs || []) {
        adjustRelationship(s, sup, { friendship: 6, trust: 5 }, {
          type: 'helped_friend_arc',
          detail: `supported "${q.title}"`,
        });
      }
      // Special reward: Open-Road Permit unlocks a free community Mango Micro EV test car if player doesn't own a car yet!
      if (q.id === 'sq_open_road' && s.worldV3) {
        s.worldV3.openRoadPermit = true;
      }
      const completedTotal = Object.values(map).filter(x => x.done).length;
      if (completedTotal >= 4) unlockAchievement(s, 'v3_side_quests_4');
      if (completedTotal >= 12) unlockAchievement(s, 'v3_side_quests_12');
      messages.push(`Side Arc Complete · ${q.title} (+${q.rewards.credits} CC)!`);
    } else {
      messages.push(`Side Arc Updated · ${q.title}: ${q.stages[st.stage].label}`);
    }
  }
  return messages;
}
