import { CATALOG, ACHIEVEMENTS } from './catalog.mjs';

const SKILL_THRESHOLDS = CATALOG.skills.skillLevelThresholds; // length 10: [0, 60, 150, ...]
const MAX_PLAYER_LEVEL = CATALOG.skills.maxPlayerLevel;

export function xpRequiredForPlayerLevel(level) {
  if (level <= 1) return 0;
  return Math.round(100 * Math.pow(level - 1, 1.35));
}

export function playerLevelFromXp(totalXp) {
  let lv = 1;
  while (lv < MAX_PLAYER_LEVEL && totalXp >= xpRequiredForPlayerLevel(lv + 1)) lv++;
  return lv;
}

export function skillLevelFromXp(xp) {
  let lv = 1;
  for (let i = 1; i < SKILL_THRESHOLDS.length; i++) {
    if (xp >= SKILL_THRESHOLDS[i]) lv = i + 1;
  }
  return lv;
}

export function awardSkillXp(state, skillId, amount) {
  const prog = state.progression;
  if (!prog || !prog.skills[skillId] || !Number.isFinite(amount) || amount <= 0) return { leveledUp: false, playerLeveledUp: false };
  const mult = (skillId === 'mobility' && state.avatar === 'geminiSport') ? 1.1 : 1.0;
  const gain = Math.max(1, Math.round(amount * mult));
  const sk = prog.skills[skillId];
  const prevLv = sk.level;
  sk.xp += gain;
  sk.level = skillLevelFromXp(sk.xp);
  const prevPlayerLv = prog.playerLevel;
  prog.totalXp += gain;
  prog.playerLevel = playerLevelFromXp(prog.totalXp);
  return {
    gain,
    leveledUp: sk.level > prevLv,
    newSkillLevel: sk.level,
    playerLeveledUp: prog.playerLevel > prevPlayerLv,
    newPlayerLevel: prog.playerLevel,
  };
}

export function awardReputation(state, track, amount) {
  const rep = state.progression?.reputation;
  if (!rep || !Object.hasOwn(rep, track) || !Number.isFinite(amount) || amount <= 0) return;
  rep[track] = Math.min(1000, rep[track] + Math.round(amount));
}

export function unlockAchievement(state, id) {
  const prog = state.progression;
  if (!prog || !ACHIEVEMENTS[id]) return false;
  if (prog.achievements.includes(id)) return false;
  prog.achievements.push(id);
  awardReputation(state, 'neighbourhood', 15);
  return true;
}

export function checkSkillRequirements(state, reqSkills = {}, reqLevel = 1) {
  const prog = state.progression;
  if (prog.playerLevel < (reqLevel || 1)) {
    return { ok: false, reason: `Requires Player Level ${reqLevel} (current: Lv.${prog.playerLevel}).` };
  }
  for (const [skillId, needLv] of Object.entries(reqSkills || {})) {
    const have = prog.skills[skillId]?.level || 1;
    if (have < needLv) {
      const label = CATALOG.skills.skills[skillId]?.name || skillId;
      return { ok: false, reason: `Requires ${label} Level ${needLv} (current: Lv.${have}).` };
    }
  }
  return { ok: true };
}

export function getStoreDiscountRate(state) {
  const bizLv = state.progression?.skills?.business?.level || 1;
  if (bizLv >= 8) return 0.15;
  if (bizLv >= 6) return 0.12;
  if (bizLv >= 4) return 0.08;
  if (bizLv >= 2) return 0.05;
  return 0;
}

export function discountedPrice(state, basePrice) {
  const rate = getStoreDiscountRate(state);
  return Math.max(1, Math.round(basePrice * (1 - rate)));
}
