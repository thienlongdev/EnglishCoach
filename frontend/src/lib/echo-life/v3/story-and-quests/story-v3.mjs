import { adjustRelationship } from '../npc-ai/relationships.mjs';
import { awardCredits } from '../progression/engine.mjs';
import { awardSkillXp, awardReputation, unlockAchievement } from '../progression/skills.mjs';

export const STORY_CHOICES = {
  ch2_huy_pact: {
    id: 'ch2_huy_pact',
    chapter: 1,
    missionId: 'pixel',
    npcId: 'huy',
    prompt: 'Huy eyes the rhythm cabinet: "If you beat this chart, how should we run Pixel Café’s sound crew for the festival?"',
    options: [
      {
        key: 'co_op_sound_crew',
        label: 'Co-op sound crew — invite Duy Khoa and freshmen to mix tracks together',
        consequence: 'Huy and Duy Khoa join forces on an inclusive open sound booth; +8 Trust with Huy & +8 Friendship with Duy Khoa.',
        apply(s) {
          adjustRelationship(s, 'huy', { trust: 8, friendship: 6 }, { type: 'story_choice', detail: 'built an open co-op festival sound crew' });
          adjustRelationship(s, 'duykhoa', { friendship: 8, respect: 8, rivalry: -10 }, { type: 'story_choice', detail: 'invited him onto the festival sound crew' });
          awardReputation(s, 'campus', 15);
        },
      },
      {
        key: 'friendly_bet',
        label: 'Friendly rivalry bet — winner gets headline billing on the main stage',
        consequence: 'Sparks an electric Pixel Café rivalry tournament; +10 Respect with Duy Khoa & bonus +40 CC showcase stake.',
        apply(s) {
          adjustRelationship(s, 'huy', { respect: 6, friendship: 4 }, { type: 'story_choice', detail: 'raised the stakes with a friendly arcade bet' });
          adjustRelationship(s, 'duykhoa', { respect: 10, rivalry: 10, friendship: 4 }, { type: 'story_choice', detail: 'accepted a headline-stage rivalry challenge' });
          awardCredits(s, 40, { bounded: false });
        },
      },
    ],
  },
  ch3_theme: {
    id: 'ch3_theme',
    chapter: 2,
    missionId: 'plan',
    npcId: 'linh',
    prompt: 'At the noticeboard, Linh asks what identity should anchor the Student Connection Festival:',
    options: [
      {
        key: 'community_arts',
        label: 'Lanterns & Living Arts — acoustic sets, watercolor walls, and handwritten notes',
        consequence: 'Diem My, Hai Dang, and Linh decorate University Green with lanterns and easels; boosts Arts & DIY energy.',
        apply(s) {
          adjustRelationship(s, 'linh', { friendship: 8, trust: 6 }, { type: 'story_choice', detail: 'chose Lanterns & Living Arts for the festival' });
          adjustRelationship(s, 'diemmy', { friendship: 10, respect: 8 }, { type: 'story_choice', detail: 'featured student art at the festival' });
          adjustRelationship(s, 'haidang', { friendship: 8 }, { type: 'story_choice', detail: 'booked acoustic stages for the festival' });
          awardSkillXp(s, 'diy_design', 30);
        },
      },
      {
        key: 'esports_mixer',
        label: 'Pixel & Tech Mixer — rhythm-game showdowns, custom PC demos, and creator rigs',
        consequence: 'Huy, Bao Long, and Duy Khoa build a live tech showcase booth; boosts Tech & Mobility energy.',
        apply(s) {
          adjustRelationship(s, 'huy', { friendship: 10, trust: 8 }, { type: 'story_choice', detail: 'made tech & rhythm gaming the festival centerpiece' });
          adjustRelationship(s, 'baolong', { friendship: 10, respect: 8 }, { type: 'story_choice', detail: 'championed custom PC showcases on campus' });
          awardSkillXp(s, 'technology', 30);
        },
      },
      {
        key: 'cultural_food_fair',
        label: 'Riverside Table & Market — student cooking stalls, herbal tea, and neighborhood craft',
        consequence: 'Mai, Khanh Ha, and Yen Nhi bring culinary stalls onto University Green; boosts Cooking & Business energy.',
        apply(s) {
          adjustRelationship(s, 'mai', { friendship: 10, trust: 8 }, { type: 'story_choice', detail: 'centered the festival around neighborhood cooking' });
          adjustRelationship(s, 'khanhha', { friendship: 10, respect: 8 }, { type: 'story_choice', detail: 'invited Willow Corner Bistro onto University Green' });
          awardSkillXp(s, 'cooking', 30);
        },
      },
    ],
  },
  ch3_budget: {
    id: 'ch3_budget',
    chapter: 2,
    missionId: 'advice',
    npcId: 'hoangphuc',
    prompt: 'Treasurer Hoang Phuc challenges your festival permit, warning it drains the student emergency fund. How do you respond?',
    options: [
      {
        key: 'compromise_coalition',
        label: 'Propose a shared budget: local shops sponsor supplies while council protects scholarships',
        consequence: 'Wins Hoang Phuc’s respect & clears his conflict; he actively co-sponsors the festival!',
        apply(s) {
          if (s.npcs.hoangphuc?.rel) s.npcs.hoangphuc.rel.conflictState = null;
          adjustRelationship(s, 'hoangphuc', { rivalry: -25, respect: 18, trust: 14, friendship: 10 }, { type: 'story_choice', detail: 'protected the scholarship fund with a coalition budget' });
          adjustRelationship(s, 'lan', { respect: 10, trust: 8 }, { type: 'story_choice', detail: 'brokered a fair compromise with Hoang Phuc' });
          awardReputation(s, 'campus', 25);
        },
      },
      {
        key: 'grassroots_fundraise',
        label: 'Decline council funds — raise supplies grassroots with Mai, Yen Nhi, and local artisans',
        consequence: 'Neighbors rally with +90 CC community grant; Hoang Phuc stays cautious but admires your grit.',
        apply(s) {
          adjustRelationship(s, 'hoangphuc', { respect: 10, rivalry: -8 }, { type: 'story_choice', detail: 'funded the festival independently without touching student aid' });
          adjustRelationship(s, 'mai', { trust: 10, friendship: 8 }, { type: 'story_choice', detail: 'built a grassroots neighborhood coalition' });
          adjustRelationship(s, 'yennhi', { friendship: 10 }, { type: 'story_choice', detail: 'partnered with Boardwalk Fair artisans' });
          awardCredits(s, 90, { bounded: false });
        },
      },
      {
        key: 'challenge_publicly',
        label: 'Cite the 1984 Student Union Charter publicly and demand open campus access',
        consequence: 'Rallies students behind open campus rights (+30 Campus Rep) while sharpening rivalry with Hoang Phuc.',
        apply(s) {
          adjustRelationship(s, 'hoangphuc', { rivalry: 15, respect: 6, friendship: -4 }, { type: 'story_choice', detail: 'challenged his council budget vote publicly using the 1984 Charter' });
          adjustRelationship(s, 'anchi', { respect: 12, friendship: 8 }, { type: 'story_choice', detail: 'defended the 1984 Student Union Charter' });
          adjustRelationship(s, 'linh', { trust: 8 }, { type: 'story_choice', detail: 'fought fiercely to keep University Green open to all' });
          awardReputation(s, 'campus', 30);
        },
      },
    ],
  },
  ch4_thaovy: {
    id: 'ch4_thaovy',
    chapter: 3,
    missionId: 'help',
    npcId: 'thaovy',
    prompt: 'When delivering Linh’s first handwritten letter to shy freshman Thao Vy, how do you invite her?',
    options: [
      {
        key: 'quiet_one_on_one',
        label: 'Sit quietly beside her first and invite her to share a single poem only if she wants to',
        consequence: 'Deeply builds Thao Vy’s trust (+16 Trust); she bravely reads her original poem at the Finale!',
        apply(s) {
          adjustRelationship(s, 'thaovy', { trust: 16, friendship: 14, familiarity: 12 }, { type: 'story_choice', detail: 'gave her space and invited her gently without pressure' });
          adjustRelationship(s, 'linh', { trust: 8 }, { type: 'story_choice', detail: 'showed real care delivering the first invitation' });
        },
      },
      {
        key: 'group_welcome',
        label: 'Introduce her straightaway to Minh, Hai Dang, and the lively prep crew',
        consequence: 'Pulls Thao Vy into the group circle quickly (+10 Familiarity, +8 Friendship across friends).',
        apply(s) {
          adjustRelationship(s, 'thaovy', { familiarity: 12, friendship: 8, trust: 5 }, { type: 'story_choice', detail: 'welcomed her directly into the friend circle' });
          adjustRelationship(s, 'minh', { friendship: 6 }, { type: 'story_choice', detail: 'introduced a newcomer to the crew' });
        },
      },
    ],
  },
  ch4_linh_support: {
    id: 'ch4_linh_support',
    chapter: 3,
    missionId: 'help',
    npcId: 'linh',
    prompt: 'Linh looks exhausted trying to carry every booth task alone before the festival:',
    options: [
      {
        key: 'delegate_to_friends',
        label: 'Divide the load across Minh, Huy, Diem My, and Yen Nhi so nobody burns out',
        consequence: 'Builds a true team triumph — every friend boosts Friendship & Trust, and Linh relaxes.',
        apply(s) {
          for (const id of ['linh', 'minh', 'huy', 'diemmy', 'yennhi']) {
            adjustRelationship(s, id, { friendship: 6, trust: 6 }, { type: 'story_choice', detail: 'shared festival leadership across the whole circle' });
          }
        },
      },
      {
        key: 'take_over_logistics',
        label: 'Step up personally and shoulder the late-night logistics yourself',
        consequence: 'Earns huge personal Respect & +120 CC leadership stipend, cementing your reputation as Campus Trailblazer.',
        apply(s) {
          adjustRelationship(s, 'linh', { respect: 14, trust: 10 }, { type: 'story_choice', detail: 'carried the festival logistics when she needed rest' });
          awardReputation(s, 'campus', 25);
          awardCredits(s, 120, { bounded: false });
        },
      },
    ],
  },
  ch5_finale_tone: {
    id: 'ch5_finale_tone',
    chapter: 4,
    missionId: 'finale',
    npcId: 'lan',
    prompt: 'Stepping up to the University Green lectern as lanterns glow overhead, how do you frame your closing speech?',
    options: [
      {
        key: 'gratitude_community',
        label: 'Thank the quiet neighbors, shopkeepers, and friends who made Riverside feel like home',
        consequence: 'Unlocks Ending: "Heart of Riverside" + Commemorative Community Lantern Trophy!',
        apply(s) {
          awardReputation(s, 'neighbourhood', 45);
          adjustRelationship(s, 'linh', { friendship: 12, trust: 10 }, { type: 'story_ending', detail: 'dedicated the closing speech to the neighborhood' });
          adjustRelationship(s, 'mai', { friendship: 10 }, { type: 'story_ending', detail: 'thanked Sunrise Market from the main lectern' });
        },
      },
      {
        key: 'ambitious_future',
        label: 'Promise an even bolder next semester — student studios, open tech labs, and new ventures',
        consequence: 'Unlocks Ending: "Trailblazer of Campus" + +200 CC Innovation Grant!',
        apply(s) {
          awardReputation(s, 'campus', 45);
          awardCredits(s, 200, { bounded: false });
          adjustRelationship(s, 'hoangphuc', { respect: 14, friendship: 8 }, { type: 'story_ending', detail: 'pitched a sustainable vision for future semesters' });
          adjustRelationship(s, 'baolong', { respect: 12 }, { type: 'story_ending', detail: 'championed student builders from the stage' });
        },
      },
      {
        key: 'spotlight_friends',
        label: 'Step aside and share the microphone with Thao Vy, Linh, and Hai Dang for an open stage',
        consequence: 'Unlocks Ending: "The Shared Stage" — unforgettable duet & poem moment with massive social bonds!',
        apply(s) {
          adjustRelationship(s, 'thaovy', { friendship: 15, trust: 15 }, { type: 'story_ending', detail: 'shared the festival microphone so she could read her poem' });
          adjustRelationship(s, 'haidang', { friendship: 12, trust: 10 }, { type: 'story_ending', detail: 'turned the finale into a shared acoustic celebration' });
          adjustRelationship(s, 'lan', { respect: 15, trust: 12 }, { type: 'story_ending', detail: 'lived out Ms. Lan’s lesson by inviting every voice forward' });
        },
      },
    ],
  },
};

export const ENDINGS = {
  heart_of_riverside: {
    id: 'heart_of_riverside',
    title: 'Heart of Riverside',
    subtitle: 'A neighborhood woven together by everyday kindness',
    epilogue: 'Lanterns glow down Riverside Lane long after dusk. Mai saves a fresh bowl of noodles behind the counter, Linh hangs your framed invitation beside her desk, and even newcomers arriving next term know your door is open. Your home, friendships, vehicles, and open world continue freely.',
  },
  trailblazer_of_campus: {
    id: 'trailblazer_of_campus',
    title: 'Trailblazer of Campus',
    subtitle: 'Turning a student idea into a lasting institution',
    epilogue: 'Backed by local merchants and a balanced Student Council charter, the Student Connection Festival earns a permanent place on the university calendar. Hoang Phuc offers a rare handshake, Bao Long reserves a showcase bench for your workstation, and Riverside looks to what you build next.',
  },
  the_shared_stage: {
    id: 'the_shared_stage',
    title: 'The Shared Stage',
    subtitle: 'Where the quietest voice became the night’s brightest memory',
    epilogue: 'When you hand the microphone forward, Thao Vy reads her poem about autumn rain to a hushed, smiling crowd while Hai Dang plays soft chords beneath the colonnade. Ms. Lan wipes her glasses quietly in the front row. You proved that belonging isn’t performed — it’s shared.',
  },
};

export function makeStoryChoice(s, choiceId, optionKey) {
  const def = STORY_CHOICES[choiceId];
  if (!def) return { ok: false, msg: 'Unknown story choice.' };
  const opt = def.options.find(o => o.key === optionKey);
  if (!opt) return { ok: false, msg: 'Invalid dialogue option.' };
  if (!s.worldV3) return { ok: false, msg: 'Story state not initialized.' };
  if (s.worldV3.storyChoices[choiceId]) {
    return { ok: false, msg: 'You have already made this decision.' };
  }
  s.worldV3.storyChoices[choiceId] = optionKey;
  opt.apply(s);
  s.saveRevision = (s.saveRevision || 0) + 1;

  if (choiceId === 'ch5_finale_tone') {
    const endingId = resolveEnding(s);
    s.worldV3.endingId = endingId;
    unlockAchievement(s, 'v3_story_ending_' + endingId);
  }
  return {
    ok: true,
    choiceId,
    optionKey,
    consequence: opt.consequence,
    msg: `Choice recorded: ${opt.consequence}`,
  };
}

export function resolveEnding(s) {
  const ch = s.worldV3?.storyChoices || {};
  if (ch.ch5_finale_tone === 'spotlight_friends') return 'the_shared_stage';
  if (ch.ch5_finale_tone === 'ambitious_future') return 'trailblazer_of_campus';
  if (ch.ch5_finale_tone === 'gratitude_community') return 'heart_of_riverside';
  // Fallback deterministic resolution based on player's prior choices if player triggers stage directly
  if (ch.ch4_thaovy === 'quiet_one_on_one') return 'the_shared_stage';
  if (ch.ch3_budget === 'compromise_coalition' || ch.ch4_linh_support === 'take_over_logistics') return 'trailblazer_of_campus';
  return 'heart_of_riverside';
}

export const ENHANCED_MISSION_NOTES = {
  tidy: 'Settle into your borrowed flat on Riverside Lane — sweep the floor and rack the broom to make it feel yours.',
  breakfast: 'Cook your first warm breakfast of eggs before stepping out to meet the neighborhood.',
  hello: 'Introduce yourself to Linh — she remembers eating alone on her first day and has a bold idea for newcomers.',
  shop: 'Visit Mai at Sunrise Market to pick up a budget noodle kit and hear the neighborhood pulse.',
  dinner: 'Cook stir-fried noodles at home and discover how real home meals energize a long semester.',
  pixel: 'Head to Pixel Café, meet Huy, choose how to build the sound crew, and beat the 3-arrow rhythm sequence.',
  plan: 'Claim your space at the University Green noticeboard and pick the Student Connection Festival’s signature theme!',
  materials: 'Practice natural English invitations at the campus book cart so every shy visitor feels welcomed.',
  advice: 'Consult Ms. Lan — and face Student Council Treasurer Hoang Phuc’s budget challenge with a real choice.',
  routine: 'Pause the rush: study at your desk and rest in bed before the week’s big preparations.',
  sports: 'Join Minh at Riverside Park for pickup basketball and rally campus athletes behind the festival.',
  help: 'Collect Linh’s handwritten invitations, decide how to support Linh and welcome shy freshman Thao Vy.',
  supplies: 'Buy colored festival paper from Sunrise Market and pack the booth supplies on University Green.',
  booth: 'Open your themed festival booth and welcome your first guest beneath the campus colonnade.',
  finale: 'Take the lectern, choose your closing message, and earn your semester ending — then live freely in Riverside!',
};
