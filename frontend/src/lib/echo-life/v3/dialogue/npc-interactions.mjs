import { CHARACTERS } from '../npc-ai/character-catalog.mjs';
import {
  ensureRelationship, getRelationshipTier, adjustRelationship,
  recordSharedExperience, resolveConflict, evaluateGift,
  maybeGenerateInvite, latestMemoryNote,
} from '../npc-ai/relationships.mjs';
import { STORY_CHOICES, ENDINGS, makeStoryChoice } from '../story-and-quests/story-v3.mjs';
import { SIDE_QUESTS, advanceSideQuests } from '../story-and-quests/side-quests.mjs';
import { record } from '../story-and-quests/semester.mjs';
import { getCalendar, getWeather, getActiveEvents } from '../world-data/weather-events.mjs';
import { zones } from '../world-data/world.mjs';
import { lines as legacyLines } from './lines.mjs';
import { awardSkillXp } from '../progression/skills.mjs';

const RUMORS = {
  linh: 'If you head east past University Green’s colonnade, there is a hidden stone courtyard called Old Campus Fountain Court.',
  ngocbich: 'Follow Riverside Greenway north around x = +12 — an unmarked footpath leads into the Hidden Lantern Tea Garden.',
  minhthu: 'Golden hour at Riverside Park and Community Botanical Garden (west of the park) makes unforgettable photos.',
  anchi: 'The 1984 Student Union Charter is tucked near University Green’s east terrace — it proves campus belongs to everyone.',
  huy: 'Duc Tri at Tech & Fix Workshop knows every shortcut down the Greenway — and Bao Long stocks crazy quad-monitor rigs.',
  minh: 'West of Riverside Park sits Ngoc Bich’s Botanical Garden, and south of the park is the Art & Music Atelier!',
  mai: 'Khanh Ha just opened Willow Corner Bistro east of Sunrise Market — her matcha crepes pair wonderfully with jasmine tea.',
  lan: 'Watch Hoang Phuc closely: stern treasurers usually protect something personal. Try talking with him at the Library.',
  haidang: 'Old Campus Fountain Court comes alive on Thursday and Saturday evenings with acoustic open-mic sets!',
  yennhi: 'On Saturday and Sunday mornings, Old Fountain Court turns into the Weekend Artisan & Book Market.',
  tuankiet: 'Complete my Open-Road Permit arc and you can take customized four-wheel cars right out onto Riverside Lane and the Greenway!',
  quocbao: 'Keep an eye out for 16 little campus keepsakes scattered across rooms, shops, and hidden gardens — collectors love them.',
};

const INTRO_LINES = {
  linh: 'Oh, you just moved into the corner flat! I’m Linh. I remember how strange the first week felt — let’s make this semester unforgettable.',
  minh: 'Hey, new neighbor! I’m Minh. Anytime you need to shake off study stress, grab a ball at Riverside Park and take a shot with me.',
  huy: 'Name’s Huy. If a monitor flickers or a rhythm cabinet drops a beat at Pixel Café, it’s probably my fault — or my fix. Pull up a seat.',
  mai: 'Welcome to Riverside Lane, dear! I’m Mai at Sunrise Market. If you’re cooking on a student budget, my shelves have your back.',
  lan: 'Good to meet you. I’m Ms. Lan from Communications. In my seminars, we start with curiosity rather than perfect answers.',
  anchi: 'Hello there — I’m An Chi, head student librarian. Feel free to browse the quiet stacks anytime you need peace or campus lore.',
  baolong: 'Welcome to Volt & Silicon! I’m Bao Long. Tell me your dream monitor count and we’ll build a workstation that flies.',
  khanhha: 'Hi! Welcome to Willow Corner Bistro — I’m Khanh Ha. Fresh espresso is pulling and the crepe iron is warm!',
  ductri: 'Duc Tri. Tech & Fix Workshop. Bring me wobbling spokes, worn PCs, or road-bound cars — if it’s bolted together, I can tune it.',
  diemmy: 'Hi… I’m Diem My. Sorry about the paint on my cuffs — the light inside Riverside Atelier was too good to waste today.',
  haidang: 'Hey friend! I’m Hai Dang. I strum acoustic sets between classes and host campus radio — grab a guitar anytime.',
  kimngan: 'Lovely to meet you — I’m Kim Ngan at Riverside Living. Even a starter study room can glow with the right timber and light.',
  quocbao: 'Morning, citizen! Officer Quoc Bao on watch. Riverside Lane is a safe street — just mind the bike lane after sundown.',
  thaovy: 'Oh— hello! I’m Thao Vy… first year, Literature. Sorry, I’m usually quieter, but it’s really nice to meet someone friendly.',
  duykhoa: 'So you’re the newcomer Huy mentioned? I’m Duy Khoa. Think you can keep up with a 120 BPM combo at Pixel Café?',
  ngocbich: 'Peace to you. I’m Ngoc Bich, caretaker of the Botanical Garden. Stay a moment — the rosemary smells brightest after noon.',
  tuankiet: 'Welcome to Greenway Motors! I’m Tuan Kiet. Whether it’s two pedals, two cylinders, or four electric wheels, we’ll get you rolling.',
  phuonglien: 'Love your energy! I’m Phuong Lien over at Thread & Campus Apparel — stop by whenever you want a fresh look for campus events.',
  quangvinh: 'Good day! Quang Vinh at Timber & Stone Homeworks. When you’re ready to trade up from a student flat to a townhouse or villa, come see me.',
  minhthu: 'Hold that light — perfect! Sorry, force of habit! I’m Minh Thu, campus photojournalist. Always hunting Riverside’s best stories.',
  hoangphuc: 'Hoang Phuc, Student Council Treasurer. If you’re part of Linh’s festival committee, I hope you brought realistic numbers.',
  yennhi: 'Hiya! I’m Yen Nhi — I coordinate Boardwalk Fair and the Weekend Artisan Market! Come toss a ring or browse handmade stalls!',
};

function getContextTopics(s, npcId) {
  const def = CHARACTERS[npcId];
  const rel = ensureRelationship(s, npcId);
  const cal = getCalendar(s.clock);
  const weather = getWeather(s);
  const events = getActiveEvents(s);
  const mem = latestMemoryNote(rel);
  const topics = [];

  // Memory-aware reactive line (highest priority so NPCs visibly remember what happened!)
  if (mem) {
    if (mem.type === 'missed_invite') {
      topics.push({
        id: 'topic_mem_missed',
        label: 'Mention the missed hangout',
        reply: `${def.name} gives a small wry smile: "Hey, I noticed we missed each other for ${mem.detail}. No worries — let’s actually make time next round."`,
      });
    } else if (mem.type === 'loved_gift') {
      topics.push({
        id: 'topic_mem_gift',
        label: 'Ask how they enjoyed your gift',
        reply: `${def.name} smiles warmly: "I still can’t get over how thoughtful you were — ${mem.detail}. It genuinely made my week."`,
      });
    } else if (mem.type === 'completed_side_arc') {
      topics.push({
        id: 'topic_mem_arc',
        label: 'Reminisce about your shared project',
        reply: `${def.name}: "Working together when we ${mem.detail} changed how I see this whole semester. Count me in anytime."`,
      });
    } else if (mem.type === 'story_choice') {
      topics.push({
        id: 'topic_mem_choice',
        label: 'Talk about your festival decision',
        reply: `${def.name}: "I still think about how you ${mem.detail}. Decisions like that actually shape what campus feels like."`,
      });
    }
  }

  // Active world event reaction
  const zoneEvent = events.find(ev => ev.zone === s.player.zone);
  if (zoneEvent) {
    topics.push({
      id: 'topic_event_' + zoneEvent.id,
      label: `Chat about ${zoneEvent.title}`,
      reply: `${def.name}: "${zoneEvent.title} brings out the best side of Riverside! You can jump right in while it’s live."`,
    });
  }

  // Weather & time-of-day awareness
  if (weather.rain) {
    topics.push({
      id: 'topic_weather_rain',
      label: 'Talk about the rain',
      reply: `${def.name} glances toward the eaves: "Light rain slows the whole neighborhood down in the nicest way — perfect excuse for warm tea indoors."`,
    });
  } else if (cal.phase === 'evening' || cal.phase === 'night') {
    topics.push({
      id: 'topic_time_evening',
      label: 'Ask about their evening plans',
      reply: `${def.name}: "Evenings around Riverside feel completely different from the 8 AM rush. Right now I’m ${s.npcs[npcId]?.scheduleNote?.toLowerCase() || 'taking it easy'}."`,
    });
  } else {
    topics.push({
      id: 'topic_day_routine',
      label: `Ask what they’re up to in ${zones[s.player.zone]?.label || 'town'}`,
      reply: `${def.name}: "Right now I’m ${s.npcs[npcId]?.scheduleNote?.toLowerCase() || 'enjoying the day'}. My big focus this term is to ${def.goal[0].toLowerCase() + def.goal.slice(1)}"`,
    });
  }

  // Post-story ending reaction (distinct per ending & character — NEVER identical generic line!)
  if (s.sandbox) {
    const ending = ENDINGS[s.worldV3?.endingId || 'heart_of_riverside'];
    topics.push({
      id: 'topic_post_story_' + ending.id,
      label: `Reflect on "${ending.title}"`,
      reply: `${def.name}: "After '${ending.title}', the whole neighborhood feels closer. I love that we still run into each other around ${zones[s.player.zone]?.label}!"`,
    });
  }

  // Interest-driven personal topic
  const interest = def.interests[(s.day + rel.familiarity) % def.interests.length];
  topics.push({
    id: 'topic_interest_' + interest,
    label: `Discuss ${interest}`,
    reply: `${def.name} leans in eagerly: "You’re into ${interest} too? Next time we have a spare hour, let’s dive into it properly!"`,
  });

  return topics;
}

export function getActiveStoryChoiceForNpc(s, npcId) {
  const choices = s.worldV3?.storyChoices || {};
  if (npcId === 'huy' && !choices.ch2_huy_pact && s.done.includes('dinner')) return STORY_CHOICES.ch2_huy_pact;
  if (npcId === 'linh' && !choices.ch3_theme && s.done.includes('pixel')) return STORY_CHOICES.ch3_theme;
  if ((npcId === 'hoangphuc' || npcId === 'lan') && !choices.ch3_budget && s.done.includes('materials')) return STORY_CHOICES.ch3_budget;
  if (npcId === 'thaovy' && !choices.ch4_thaovy && s.done.includes('advice')) return STORY_CHOICES.ch4_thaovy;
  if (npcId === 'linh' && !choices.ch4_linh_support && s.done.includes('routine') && s.done.includes('sports')) return STORY_CHOICES.ch4_linh_support;
  if ((npcId === 'lan' || npcId === 'linh') && !choices.ch5_finale_tone && s.done.includes('booth')) return STORY_CHOICES.ch5_finale_tone;
  return null;
}

export function getSideQuestPromptForNpc(s, npcId) {
  const sqMap = s.worldV3?.sideQuests || {};
  for (const q of SIDE_QUESTS) {
    if (q.leadNpc !== npcId) continue;
    const st = sqMap[q.id] || { started: false, stage: 0, done: false };
    if (st.done) continue;
    const stageObj = q.stages[st.stage];
    if (!stageObj) continue;
    if (stageObj.event.startsWith('sq:')) {
      return { quest: q, stageObj, stageIndex: st.stage };
    }
  }
  return null;
}

export function listGiftableItems(s) {
  const items = [];
  for (const [k, qty] of Object.entries(s.bag || {})) {
    if (qty > 0) items.push({ key: k, source: 'bag', label: `${k.replace(/_/g, ' ')} (×${qty})` });
  }
  for (const [k, qty] of Object.entries(s.progression?.materials || {})) {
    if (qty > 0) items.push({ key: k, source: 'materials', label: `${k.replace(/_/g, ' ')} (×${qty})` });
  }
  return items;
}

/**
 * Builds the complete contextual interaction options for an NPC.
 * Preserves legacy `say0` / `say1` keys for V1/V2 test compatibility while surfacing
 * rich V3 social, story-choice, side-quest, gift, hangout, and conflict options!
 */
export function buildNpcInteractionOptions(s, npcId) {
  const def = CHARACTERS[npcId];
  const rel = ensureRelationship(s, npcId);
  if (!def || !rel) return [];
  const opts = [];

  // 1. Branching Story Choice (if active for this NPC!)
  const sc = getActiveStoryChoiceForNpc(s, npcId);
  if (sc) {
    for (const o of sc.options) {
      opts.push({ key: `choice:${sc.id}:${o.key}`, label: `Story Choice · ${o.label}`, kind: 'story' });
    }
  }

  // 2. Side Quest Chain progression
  const sq = getSideQuestPromptForNpc(s, npcId);
  if (sq) {
    opts.push({
      key: `sq:${sq.quest.id}:${sq.stageObj.event}`,
      label: `Side Arc · ${sq.quest.title}: ${sq.stageObj.label}`,
      kind: 'sidequest',
    });
  }

  // 3. First-time introduction (only shown once — never repeats forever!)
  if (!rel.dialogueSeen.includes('intro')) {
    opts.push({ key: 'intro', label: `Introduce yourself to ${def.name}`, kind: 'social' });
  }

  // 4. Legacy / Main-story dialogue lines for core 5 (keeps `say0` working cleanly for tests & story!)
  if (legacyLines[npcId]) {
    opts.push({ key: 'say0', label: `Talk · ${legacyLines[npcId][0][0]}`, kind: 'talk' });
    if (rel.familiarity >= 5 || s.flags?.letters || s.done.length >= 2) {
      opts.push({ key: 'say1', label: `Talk · ${legacyLines[npcId][1][0]}`, kind: 'talk' });
    }
  }

  // 5. Contextual rotating non-repeating conversation topics
  const topics = getContextTopics(s, npcId);
  const freshTopic = topics.find(t => !rel.topicsUsedToday?.includes(t.id)) || topics[0];
  if (freshTopic) {
    opts.push({ key: `topic:${freshTopic.id}`, label: freshTopic.label, kind: 'topic' });
  }

  // 6. Contextual social interactions
  opts.push({ key: 'compliment', label: `Compliment ${def.name}`, kind: 'social' });
  opts.push({ key: 'joke', label: 'Crack a friendly joke', kind: 'social' });
  opts.push({ key: 'rumor', label: 'Ask about neighborhood secrets & tips', kind: 'explore' });

  // 7. Pending invitation response
  if (rel.pendingInvite && !rel.pendingInvite.accepted) {
    opts.push({ key: 'accept_invite', label: `Accept Invitation · ${rel.pendingInvite.label}`, kind: 'invite' });
  }

  // 8. Zone & relationship-contextual joint activities / Home Invite
  const zone = s.player.zone;
  if (zone === 'bistro' || zone === 'market') opts.push({ key: 'activity:coffee_meal', label: `Share coffee or a snack with ${def.name}`, kind: 'activity' });
  if (zone === 'library' || zone === 'campus' || zone === 'study') opts.push({ key: 'activity:study_pair', label: `Study together with ${def.name}`, kind: 'activity' });
  if (zone === 'park' || zone === 'fair') opts.push({ key: 'activity:park_hangout', label: `Hang out & warm up with ${def.name}`, kind: 'activity' });
  if (zone === 'atelier' || zone === 'fountain_plaza') opts.push({ key: 'activity:creative_jam', label: `Sketch or jam music with ${def.name}`, kind: 'activity' });
  if (zone === 'cafe') opts.push({ key: 'activity:arcade_pair', label: `Co-op rhythm warm-up with ${def.name}`, kind: 'activity' });

  if (rel.friendship >= 20 && zone !== 'living' && zone !== 'study') {
    opts.push({ key: 'invite_home', label: `Invite ${def.name} to visit your home`, kind: 'invite' });
  }

  // 9. Give Gift (pick first giftable item or loved item if player holds one)
  const gifts = listGiftableItems(s);
  if (gifts.length) {
    const preferred = gifts.find(g => def.favoriteGifts.includes(g.key)) || gifts[0];
    opts.push({ key: `gift:${preferred.source}:${preferred.key}`, label: `Give Gift · ${preferred.label}`, kind: 'gift' });
  }

  // 10. Resolve Conflict / Apologize (appears when rivalry/conflict exists!)
  if (rel.conflictState?.active || rel.rivalry >= 15) {
    opts.push({ key: 'apologize', label: `Apologize & clear the air with ${def.name}`, kind: 'conflict' });
  }

  // 11. Shopkeeper quick shop open
  const zoneStore = zones[zone]?.storeId;
  if (zoneStore && def.workZone === zone) {
    opts.push({ key: 'open_store:' + zoneStore, label: `Browse ${def.name}’s store catalog`, kind: 'shop' });
  }

  return opts;
}

export function executeNpcInteraction(s, npcId, choiceKey) {
  const def = CHARACTERS[npcId];
  const n = s.npcs?.[npcId];
  if (!def || !n) return { ok: false, msg: 'Resident not found.' };
  const rel = ensureRelationship(s, npcId);
  if (rel.lastTalkDay !== s.day) {
    rel.lastTalkDay = s.day;
    rel.topicsUsedToday = [];
  }

  // Branching story choice
  if (choiceKey.startsWith('choice:')) {
    const [, choiceId, optKey] = choiceKey.split(':');
    const res = makeStoryChoice(s, choiceId, optKey);
    if (res.ok) record(s, 'talk-' + npcId);
    return res;
  }

  // Side quest advancement
  if (choiceKey.startsWith('sq:')) {
    const parts = choiceKey.split(':');
    const questId = parts[1];
    const ev = parts.slice(2).join(':');
    const msgs = advanceSideQuests(s, ev);
    adjustRelationship(s, npcId, { friendship: 5, trust: 5, familiarity: 6 }, {
      type: 'side_quest_step',
      detail: `talked about ${questId}`,
    });
    record(s, 'talk-' + npcId);
    return { ok: true, msg: msgs[0] || `${def.name}: "Let’s keep moving on this together!"` };
  }

  // Open store shortcut
  if (choiceKey.startsWith('open_store:')) {
    const storeId = choiceKey.slice('open_store:'.length);
    return { ok: true, msg: `${def.name}: "Take a look at what’s in stock today!"`, openPanel: 'shop', storeId };
  }

  // First-time introduction
  if (choiceKey === 'intro') {
    if (!rel.dialogueSeen.includes('intro')) rel.dialogueSeen.push('intro');
    n.visits = (n.visits || 0) + 1;
    adjustRelationship(s, npcId, { friendship: 8, trust: 5, familiarity: 12 }, {
      type: 'first_meeting',
      detail: `met in ${zones[s.player.zone]?.label || s.player.zone}`,
    });
    awardSkillXp(s, 'social', 15);
    record(s, 'talk-' + npcId);
    record(s, 'sq:talk_' + npcId);
    return { ok: true, msg: `${def.name}: "${INTRO_LINES[npcId] || def.bio}"` };
  }

  // Legacy say0 / say1 (fully upgraded with memory & story context!)
  if (choiceKey === 'say0' || choiceKey === 'say1') {
    const idx = Number(choiceKey.slice(3)) || 0;
    n.visits = (n.visits || 0) + 1;
    n.last = choiceKey;
    const isFirst = !rel.dialogueSeen.includes('intro');
    if (isFirst) rel.dialogueSeen.push('intro');
    adjustRelationship(s, npcId, {
      friendship: n.visits === 1 ? 5 : 2,
      familiarity: n.visits === 1 ? 8 : 3,
      trust: 2,
    });
    awardSkillXp(s, 'social', 10);
    s.history.push([npcId, Math.floor(s.clock), choiceKey]);
    s.history = s.history.slice(-40);

    let reply;
    if (s.sandbox) {
      const ending = ENDINGS[s.worldV3?.endingId || 'heart_of_riverside'];
      reply = `Remember "${ending.title}"? Every time I pass ${zones[s.player.zone]?.label || 'University Green'}, I smile thinking of what we built.`;
    } else if (npcId === 'linh' && s.flags.letters) {
      reply = 'These are lovely. I’ll give the first invitation to Thao Vy — the quiet freshman by the library window.';
    } else if (npcId === 'lan' && s.flags.plan) {
      reply = 'Your theme is clear. Ask each guest one question and give them time to answer — and talk with Hoang Phuc before budget day.';
    } else if (isFirst && INTRO_LINES[npcId]) {
      reply = INTRO_LINES[npcId];
    } else {
      reply = legacyLines[npcId]?.[idx]?.[1] || `${def.bio}`;
    }
    record(s, 'talk-' + npcId);
    record(s, 'sq:talk_' + npcId);
    if (rel.friendship >= 25) maybeGenerateInvite(s, npcId);
    return { ok: true, msg: `${def.name} · ${reply}` };
  }

  // Contextual topic
  if (choiceKey.startsWith('topic:')) {
    const tid = choiceKey.slice(6);
    const topic = getContextTopics(s, npcId).find(t => t.id === tid) || getContextTopics(s, npcId)[0];
    if (topic && !rel.topicsUsedToday.includes(topic.id)) rel.topicsUsedToday.push(topic.id);
    n.visits = (n.visits || 0) + 1;
    adjustRelationship(s, npcId, { friendship: 4, familiarity: 5, trust: 2 });
    awardSkillXp(s, 'social', 12);
    record(s, 'talk-' + npcId);
    record(s, 'sq:talk_' + npcId);
    if (rel.friendship >= 25) maybeGenerateInvite(s, npcId);
    return { ok: true, msg: topic ? topic.reply : `${def.name} chats warmly with you.` };
  }

  // Compliment
  if (choiceKey === 'compliment') {
    const likesDirect = !def.personality.includes('guarded') || rel.trust >= 25;
    if (likesDirect) {
      adjustRelationship(s, npcId, { friendship: 5, trust: 3, familiarity: 3 });
      awardSkillXp(s, 'social', 10);
      return { ok: true, msg: `${def.name} smiles: "Thanks — hearing that from you actually means a lot today." (+5 Friendship, +3 Trust)` };
    }
    adjustRelationship(s, npcId, { respect: 2, familiarity: 2 });
    return { ok: true, msg: `${def.name} raises an eyebrow: "Flattery won’t balance a budget, though I appreciate the politeness." (+2 Respect)` };
  }

  // Joke
  if (choiceKey === 'joke') {
    const humorMatch = def.personality.some(p => ['witty', 'energetic', 'bubbly', 'laid-back', 'humorous', 'competitive'].includes(p));
    if (humorMatch) {
      adjustRelationship(s, npcId, { friendship: 6, familiarity: 4 });
      s.needs.mood = Math.min(100, s.needs.mood + 4);
      awardSkillXp(s, 'social', 12);
      return { ok: true, msg: `${def.name} bursts out laughing: "Okay, that one actually caught me off guard!" (+6 Friendship, +4 Mood)` };
    }
    adjustRelationship(s, npcId, { friendship: 3, familiarity: 3 });
    return { ok: true, msg: `${def.name} chuckles softly: "Heh — you certainly keep the mood light around here." (+3 Friendship)` };
  }

  // Neighborhood rumor / exploration clue
  if (choiceKey === 'rumor') {
    adjustRelationship(s, npcId, { familiarity: 4, friendship: 2 });
    const tip = RUMORS[npcId] || `Try visiting ${zones[def.workZone]?.label || 'University Green'} at different hours — the neighborhood shifts completely between 8 AM, 2 PM, and 9 PM.`;
    return { ok: true, msg: `${def.name} leans in: "${tip}"` };
  }

  // Accept pending invite
  if (choiceKey === 'accept_invite' && rel.pendingInvite) {
    const inv = rel.pendingInvite;
    inv.accepted = true;
    rel.pendingInvite = null;
    if (s.worldV3) {
      s.worldV3.hostedGuest = { npcId, zone: inv.zone, untilClock: s.clock + 180 };
    }
    recordSharedExperience(s, npcId, inv.activity, inv.label);
    return { ok: true, msg: `${def.name}: "Awesome! I’ll head over to ${zones[inv.zone]?.label || inv.zone} — see you there!" (+6 Friendship, +5 Trust)` };
  }

  // Invite NPC to player's home (reacts to player's actual property, PC, and room style!)
  if (choiceKey === 'invite_home') {
    const propId = s.progression?.properties?.activePropertyId || 'prop_student_flat';
    const hasPc = s.progression?.ownedObjects?.some(o => o.category === 'electronics_pc');
    const styled = Object.values(s.progression?.roomStyles || {}).some(st => st !== 'budget_student');
    if (s.worldV3) {
      s.worldV3.hostedGuest = { npcId, zone: 'living', untilClock: s.clock + 240 };
    }
    recordSharedExperience(s, npcId, 'home_visit', `visited your home (${propId})`);
    const reaction = propId !== 'prop_student_flat'
      ? `Whoa, I’ve heard about your upgraded place! I’d love to see the new rooms.`
      : hasPc
        ? `Let’s check out your custom workstation too — I’ll walk right over to your Living Room!`
        : styled
          ? `I heard you’ve been redecorating — I’ll meet you in your Living Room!`
          : `I’d love to drop by your place! Meet me in your Living Room.`;
    return { ok: true, msg: `${def.name}: "${reaction}" (Heading to your Living Room!)` };
  }

  // Shared zone activity
  if (choiceKey.startsWith('activity:')) {
    const act = choiceKey.slice(9);
    const labels = {
      coffee_meal: 'shared coffee and pastries',
      study_pair: 'studied side by side',
      park_hangout: 'hung out together in the park',
      creative_jam: 'worked on music and art together',
      arcade_pair: 'warmed up on the rhythm terminals',
    };
    recordSharedExperience(s, npcId, act, labels[act] || 'spent time together');
    s.needs.mood = Math.min(100, s.needs.mood + 8);
    if (act === 'coffee_meal') s.needs.hunger = Math.min(100, s.needs.hunger + 12);
    if (act === 'study_pair') s.needs.focus = Math.min(100, s.needs.focus + 12);
    awardSkillXp(s, act === 'study_pair' ? 'technology' : act === 'creative_jam' ? 'diy_design' : 'social', 20);
    if (npcId === 'thaovy' && (s.npcs.thaovy.rel?.friendship || 0) >= 20) record(s, 'rel:thaovy_20');
    return { ok: true, msg: `You and ${def.name} ${labels[act] || 'hung out'} (+6 Friendship, +5 Trust, +8 Mood)!` };
  }

  // Gift
  if (choiceKey.startsWith('gift:')) {
    const [, source, itemKey] = choiceKey.split(':');
    const container = source === 'materials' ? s.progression?.materials : s.bag;
    if (!container || (container[itemKey] || 0) < 1) {
      return { ok: false, msg: 'You do not have that item anymore.' };
    }
    const res = evaluateGift(s, npcId, itemKey);
    if (res.ok) {
      container[itemKey] -= 1;
      if (source === 'bag' && container[itemKey] <= 0) delete container[itemKey];
      if (npcId === 'thaovy' && (s.npcs.thaovy.rel?.friendship || 0) >= 20) record(s, 'rel:thaovy_20');
    }
    return res;
  }

  // Resolve conflict / apologize
  if (choiceKey === 'apologize') {
    const res = resolveConflict(s, npcId, 'apologize');
    if (res.ok && npcId === 'hoangphuc') record(s, 'rel:hoangphuc_resolved');
    return res;
  }

  return { ok: false, msg: 'Interaction unavailable.' };
}

export function getNpcHeaderBadge(s, npcId) {
  const def = CHARACTERS[npcId];
  const rel = ensureRelationship(s, npcId);
  if (!def || !rel) return '';
  const tier = getRelationshipTier(rel);
  return `${def.name} · ${tier} (${rel.friendship})`;
}
