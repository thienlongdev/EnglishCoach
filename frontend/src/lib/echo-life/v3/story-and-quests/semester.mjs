import { awardCredits } from '../progression/engine.mjs';
import { awardSkillXp, awardReputation } from '../progression/skills.mjs';
import { advanceSideQuests } from './side-quests.mjs';
import { resolveEnding, ENHANCED_MISSION_NOTES } from './story-v3.mjs';

export const chapters = ['The First Day', 'New Friends', 'Our Project', 'A Busy Week', 'Student Connection Festival'];

// Preserves all 15 original V1/V2 mission IDs and prerequisites verbatim while integrating V3 narrative notes, side quests, and endings.
const rows = [
  ['tidy', 0, 'A place of your own', 'living', ['sweep', 'rack'], [], 'Pick up the broom, sweep the dust, and return the broom to its rack.', 45, 'diy_design'],
  ['breakfast', 0, 'Breakfast for one', 'kitchen', ['eat-eggs'], ['tidy'], 'Prepare the eggs, fry them, serve them, and eat at the table.', 45, 'cooking'],
  ['hello', 0, 'A neighbour named Linh', 'linh', ['talk-linh'], ['breakfast'], 'Use People or the Map to find Linh and introduce yourself.', 50, 'social'],
  ['shop', 1, 'The shopping list', 'market', ['purchase'], ['hello'], 'Choose a noodle kit from the shelf at Sunrise Market and pay at the counter.', 55, 'business'],
  ['dinner', 1, 'Noodles for two', 'kitchen', ['eat-noodles'], ['shop'], 'Prepare the noodles, cook them, serve them, and taste your dish.', 60, 'cooking'],
  ['pixel', 1, 'An evening at Pixel', 'cafe', ['talk-huy', 'win-arcade'], ['dinner'], 'Meet Huy at Pixel Café, then beat the arrow sequence on a rhythm terminal.', 70, 'technology'],
  ['plan', 2, 'A festival for everyone', 'campus', ['plan'], ['pixel'], 'Choose the festival theme at the University Green noticeboard.', 70, 'social'],
  ['materials', 2, 'An invitation in English', 'campus', ['english'], ['plan'], 'Practise inviting a guest at the campus book cart.', 75, 'social'],
  ['advice', 2, 'Office hours', 'campus', ['talk-lan'], ['materials'], 'Ask Ms. Lan for advice on your opening speech (and address Hoang Phuc’s budget concern).', 75, 'social'],
  ['routine', 3, 'Time to recharge', 'study', ['study', 'sleep'], ['advice'], 'Study at your desk, then rest in bed.', 80, 'technology'],
  ['sports', 3, 'A shot with Minh', 'park', ['talk-minh', 'win-sport'], ['advice'], 'Find Minh and sink a basket when the power marker reaches the green band.', 85, 'mobility'],
  ['help', 3, 'Handwritten invitations', 'linh', ['letters', 'talk-linh'], ['routine', 'sports'], 'Collect the letters at Linh’s house and bring them to her.', 90, 'diy_design'],
  ['supplies', 4, 'Festival supplies', 'market', ['buy-kit', 'pack'], ['help'], 'Buy coloured paper at Sunrise Market and pack it at the campus noticeboard.', 100, 'business'],
  ['booth', 4, 'Open for visitors', 'campus', ['setup', 'host'], ['supplies'], 'Set up your booth on University Green and welcome your first guest.', 120, 'business'],
  ['finale', 4, 'A semester to remember', 'campus', ['present'], ['booth'], 'Take the lectern, choose your closing tone, and thank your guests.', 130, 'social'],
];

export const quests = rows.map(([id, chapter, title, zone, steps, requires, hint, reward, skill]) => ({
  id,
  chapter,
  title,
  zone,
  steps,
  requires,
  hint,
  storyNote: ENHANCED_MISSION_NOTES[id] || hint,
  reward,
  skill,
}));

export const active = s => quests.filter(q => !s.done.includes(q.id) && q.requires.every(k => s.done.includes(k)));

export function record(s, event) {
  for (const q of active(s)) {
    const i = s.progress[q.id] || 0;
    if (q.steps[i] !== event) continue;
    s.progress[q.id] = i + 1;
    if (i + 1 === q.steps.length) {
      s.done.push(q.id);
      if (s.progression) {
        awardCredits(s, q.reward, { bounded: false });
        awardSkillXp(s, q.skill || 'social', 35);
        awardReputation(s, 'campus', 25);
      } else {
        s.cash += q.reward;
      }
      if (q.id === 'finale') {
        s.sandbox = true;
        if (s.worldV3 && !s.worldV3.endingId) {
          s.worldV3.endingId = resolveEnding(s);
        }
      }
    }
  }
  // Also propagate gameplay events to the 14 V3 multi-stage side quest arcs!
  const sideMsgs = advanceSideQuests(s, event);
  if (sideMsgs.length && s.worldV3) {
    s.worldV3.recentFeed = [...(s.worldV3.recentFeed || []), ...sideMsgs].slice(-12);
  }
  return sideMsgs;
}
