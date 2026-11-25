import { CHARACTERS } from './character-catalog.mjs';

/**
 * Autonomous NPC-to-NPC Living World Scenes.
 * When socially connected NPCs share the same zone, they orient toward each other,
 * play lively animations, and produce observable ambient snippets the player can watch or join.
 */
export const SOCIAL_SCENES = [
  {
    id: 'scene_linh_diemmy_posters',
    participants: ['linh', 'diemmy'],
    zones: ['atelier', 'campus', 'fountain_plaza'],
    pose: ['present', 'study'],
    caption: 'Linh and Diem My are comparing watercolor poster layouts for the festival.',
    joinPrompt: 'Join Linh & Diem My’s design huddle',
    rewardSkill: 'diy_design',
    joinReply: 'Linh smiles as you lean in: "Your eye for balance always improves our sketches!"',
  },
  {
    id: 'scene_huy_duykhoa_bpm',
    participants: ['huy', 'duykhoa'],
    zones: ['cafe', 'electronics_shop'],
    pose: ['present', 'wave'],
    caption: 'Huy and Duy Khoa are debating whether 120 BPM charts need tighter timing windows.',
    joinPrompt: 'Chime in on Huy & Duy Khoa’s rhythm debate',
    rewardSkill: 'technology',
    joinReply: 'Duy Khoa laughs: "Alright, rookie — back up your opinion on the cabinet!"',
  },
  {
    id: 'scene_mai_khanhha_recipes',
    participants: ['mai', 'khanhha'],
    zones: ['bistro', 'market'],
    pose: ['cook', 'wave'],
    caption: 'Mai and Khanh Ha are tasting a fresh ginger-matcha crepe batter together.',
    joinPrompt: 'Taste-test Mai & Khanh Ha’s new recipe',
    rewardSkill: 'cooking',
    joinReply: 'Khanh Ha beams: "That honest feedback is exactly what we needed before morning rush!"',
  },
  {
    id: 'scene_lan_anchi_archives',
    participants: ['lan', 'anchi'],
    zones: ['library', 'campus'],
    pose: ['study', 'present'],
    caption: 'Ms. Lan and An Chi are examining the 1984 Student Union Charter side by side.',
    joinPrompt: 'Listen to Ms. Lan & An Chi’s archive discussion',
    rewardSkill: 'social',
    joinReply: 'An Chi turns the fragile page toward you: "History feels alive when new students care."',
  },
  {
    id: 'scene_minh_tuankiet_routes',
    participants: ['minh', 'tuankiet'],
    zones: ['park', 'greenway', 'vehicle_dealer'],
    pose: ['exercise_squat', 'wave'],
    caption: 'Minh and Tuan Kiet are mapping a scenic cycling loop down Riverside Greenway.',
    joinPrompt: 'Plan a Greenway ride with Minh & Tuan Kiet',
    rewardSkill: 'mobility',
    joinReply: 'Tuan Kiet nods: "Grab your wheels anytime — the morning tailwind is unbeatable."',
  },
  {
    id: 'scene_linh_thaovy_encouragement',
    participants: ['linh', 'thaovy'],
    zones: ['campus', 'library', 'bistro', 'botanical'],
    pose: ['wave', 'sit'],
    caption: 'Linh is quietly listening while Thao Vy reads a page from her autumn notebook.',
    joinPrompt: 'Sit quietly with Linh & Thao Vy',
    rewardSkill: 'social',
    joinReply: 'Thao Vy looks up with a shy smile: "I’m glad you didn’t rush us. That helped a lot."',
  },
  {
    id: 'scene_hoangphuc_lan_budget',
    participants: ['hoangphuc', 'lan'],
    zones: ['campus', 'library'],
    pose: ['present', 'idle'],
    caption: 'Hoang Phuc and Ms. Lan are debating how to fund both student scholarships and the festival.',
    joinPrompt: 'Observe Hoang Phuc & Ms. Lan’s budget talk',
    rewardSkill: 'business',
    joinReply: 'Ms. Lan notes your presence: "Fresh perspectives often spot compromises spreadsheets miss."',
  },
  {
    id: 'scene_baolong_ductri_hardware',
    participants: ['baolong', 'ductri'],
    zones: ['electronics_shop', 'repair_shop', 'cafe'],
    pose: ['present', 'wipe'],
    caption: 'Bao Long and Duc Tri are comparing precision thermal paste against vintage bearing grease.',
    joinPrompt: 'Trade engineering tips with Bao Long & Duc Tri',
    rewardSkill: 'technology',
    joinReply: 'Duc Tri grins: "Good engineering is good engineering — whether it has fans or spokes."',
  },
  {
    id: 'scene_haidang_minhthu_chords',
    participants: ['haidang', 'minhthu'],
    zones: ['fountain_plaza', 'atelier', 'fair'],
    pose: ['present', 'idle'],
    caption: 'Hai Dang strums a gentle progression while Minh Thu frames candid golden-hour photos.',
    joinPrompt: 'Listen & frame shots with Hai Dang & Minh Thu',
    rewardSkill: 'social',
    joinReply: 'Hai Dang chuckles: "You two keep bringing this energy and we’ll fill the whole courtyard!"',
  },
  {
    id: 'scene_kimngan_quangvinh_blueprints',
    participants: ['kimngan', 'quangvinh'],
    zones: ['furniture_shop', 'home_center', 'street'],
    pose: ['present', 'wave'],
    caption: 'Kim Ngan and Quang Vinh are matching warm cedar floor swatches to residence blueprints.',
    joinPrompt: 'Ask Kim Ngan & Quang Vinh for home design tips',
    rewardSkill: 'diy_design',
    joinReply: 'Kim Ngan smiles: "Whenever you upgrade your home, think about how morning light enters first."',
  },
  {
    id: 'scene_ngocbich_mai_herbs',
    participants: ['ngocbich', 'mai'],
    zones: ['botanical', 'market', 'lantern_garden'],
    pose: ['wipe', 'wave'],
    caption: 'Ngoc Bich is handing Mai freshly clipped mint and moon-jasmine sprigs.',
    joinPrompt: 'Help bundle herbs with Ngoc Bich & Mai',
    rewardSkill: 'cooking',
    joinReply: 'Ngoc Bich hands you a fragrant leaf: "Brew this slowly and the whole room settles."',
  },
  {
    id: 'scene_quocbao_yennhi_lanterns',
    participants: ['quocbao', 'yennhi'],
    zones: ['fair', 'street', 'fountain_plaza'],
    pose: ['wave', 'present'],
    caption: 'Officer Quoc Bao and Yen Nhi are checking the string-light anchors before dusk.',
    joinPrompt: 'Help Quoc Bao & Yen Nhi inspect the booth lights',
    rewardSkill: 'diy_design',
    joinReply: 'Quoc Bao tips his cap: "Always easier with an extra pair of steady hands."',
  },
  {
    id: 'scene_phuonglien_minhthu_lookbook',
    participants: ['phuonglien', 'minhthu'],
    zones: ['clothing_shop', 'fountain_plaza', 'atelier'],
    pose: ['present', 'wave'],
    caption: 'Phuong Lien and Minh Thu are pinning campus lookbook palettes onto a corkboard.',
    joinPrompt: 'Suggest a lookbook spot to Phuong Lien & Minh Thu',
    rewardSkill: 'social',
    joinReply: 'Phuong Lien claps: "Oh, the light by Old Fountain Court would make those fabrics glow!"',
  },
  {
    id: 'scene_huy_baolong_overclock',
    participants: ['huy', 'baolong'],
    zones: ['electronics_shop', 'cafe'],
    pose: ['study', 'present'],
    caption: 'Huy and Bao Long are benchmarking a silent liquid-cooled workstation.',
    joinPrompt: 'Check out Huy & Bao Long’s benchmark',
    rewardSkill: 'technology',
    joinReply: 'Bao Long points at the monitor: "Under 62 degrees at full load — clean airflow wins."',
  },
];

export function detectZoneSocialScenes(s, zoneId) {
  const here = Object.values(s.npcs || {}).filter(n => n.zone === zoneId);
  const byId = new Map(here.map(n => [n.id, n]));
  const active = [];
  const used = new Set();

  for (const scene of SOCIAL_SCENES) {
    if (!scene.zones.includes(zoneId)) continue;
    const [aId, bId] = scene.participants;
    if (used.has(aId) || used.has(bId)) continue;
    const a = byId.get(aId);
    const b = byId.get(bId);
    if (!a || !b) continue;
    // Only form a social scene when both NPCs have arrived (not mid-transition to a door)
    if ((a.path?.length || 0) > 2 || (b.path?.length || 0) > 2) continue;
    used.add(aId);
    used.add(bId);
    active.push({
      ...scene,
      actors: [a, b],
      names: [CHARACTERS[aId]?.name || aId, CHARACTERS[bId]?.name || bId],
    });
  }
  return active;
}
