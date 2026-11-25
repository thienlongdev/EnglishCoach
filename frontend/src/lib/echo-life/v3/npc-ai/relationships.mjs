import { CHARACTERS } from './character-catalog.mjs';
import { awardSkillXp, awardReputation, unlockAchievement } from '../progression/skills.mjs';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

export function createRelationship(npcId) {
  const def = CHARACTERS[npcId];
  return {
    friendship: 0,
    trust: 0,
    familiarity: 0,
    respect: 0,
    rivalry: def?.initialRivalry || 0,
    sharedExperiences: [],
    memories: [],
    dialogueSeen: [],
    conflictState: def?.initialRivalry >= 30 ? { active: true, reason: 'disagreed over Student Connection Festival funding' } : null,
    pendingInvite: null,
    lastTalkDay: -1,
    giftsGivenToday: 0,
    lastGiftDay: -1,
    topicsUsedToday: [],
  };
}

export function ensureRelationship(s, npcId) {
  const n = s.npcs?.[npcId];
  if (!n) return null;
  if (!n.rel) {
    n.rel = createRelationship(npcId);
    if (Number.isFinite(n.friend) && n.friend > 0) {
      n.rel.friendship = clamp(n.friend, 0, 100);
      n.rel.familiarity = clamp(Math.max(n.rel.familiarity, n.friend), 0, 100);
    }
  }
  return n.rel;
}

export function getRelationshipTier(rel) {
  if (!rel) return 'Stranger';
  if (rel.conflictState?.active && rel.rivalry >= 30 && rel.trust < 35) return 'Tense Rival';
  if (rel.rivalry >= 25 && rel.friendship >= 25) return 'Friendly Rival';
  const score = rel.friendship * 0.55 + rel.trust * 0.3 + rel.respect * 0.15;
  if (rel.familiarity < 5 && score < 5) return 'Stranger';
  if (score >= 80 && rel.trust >= 65) return 'Confidant';
  if (score >= 55) return 'Close Friend';
  if (score >= 25) return 'Friend';
  return 'Acquaintance';
}

export function adjustRelationship(s, npcId, deltas = {}, memory = null) {
  const rel = ensureRelationship(s, npcId);
  if (!rel) return null;
  if (deltas.friendship) rel.friendship = clamp(rel.friendship + deltas.friendship, 0, 100);
  if (deltas.trust) rel.trust = clamp(rel.trust + deltas.trust, 0, 100);
  if (deltas.familiarity) rel.familiarity = clamp(rel.familiarity + deltas.familiarity, 0, 100);
  if (deltas.respect) rel.respect = clamp(rel.respect + deltas.respect, 0, 100);
  if (deltas.rivalry) rel.rivalry = clamp(rel.rivalry + deltas.rivalry, 0, 100);
  // Sync legacy flat integer for V1/V2 backward compatibility
  s.npcs[npcId].friend = rel.friendship;

  if (memory && memory.type) {
    rel.memories.push({
      type: memory.type,
      detail: memory.detail || '',
      day: s.day || 0,
      clock: Math.floor(s.clock || 0),
    });
    if (rel.memories.length > 24) rel.memories = rel.memories.slice(-24);
  }
  if (rel.rivalry <= 10 && rel.conflictState?.active) {
    rel.conflictState = null;
  }

  // Unlock social achievements organically
  const closeCount = Object.keys(s.npcs || {}).filter(id => {
    const r = s.npcs[id]?.rel;
    return r && r.friendship >= 55;
  }).length;
  if (closeCount >= 3) unlockAchievement(s, 'v3_circle_of_friends');
  if (closeCount >= 8) unlockAchievement(s, 'v3_heart_of_riverside');
  return rel;
}

export function recordSharedExperience(s, npcId, expType, summary) {
  const rel = ensureRelationship(s, npcId);
  if (!rel) return;
  if (!rel.sharedExperiences.includes(expType)) rel.sharedExperiences.push(expType);
  adjustRelationship(s, npcId, { friendship: 6, trust: 5, familiarity: 5, respect: 3 }, {
    type: 'shared_' + expType,
    detail: summary,
  });
}

export function resolveConflict(s, npcId, style = 'apologize') {
  const rel = ensureRelationship(s, npcId);
  const def = CHARACTERS[npcId];
  if (!rel || !def) return { ok: false, msg: 'Resident not found.' };
  const hadConflict = Boolean(rel.conflictState?.active || rel.rivalry >= 15);
  if (!hadConflict) return { ok: false, msg: `There is no tension between you and ${def.name}.` };
  rel.conflictState = null;
  adjustRelationship(s, npcId, { rivalry: -25, trust: 10, respect: 8, friendship: 6 }, {
    type: 'resolved_conflict',
    detail: style === 'apologize' ? 'offered a sincere apology and listened' : 'cleared the air face to face',
  });
  awardSkillXp(s, 'social', 22);
  awardReputation(s, 'neighbourhood', 10);
  return {
    ok: true,
    msg: `${def.name}: "I appreciate you saying that directly. Let’s start fresh — no hard feelings." (Tension cleared, +10 Trust, +8 Respect)`,
  };
}

export function evaluateGift(s, npcId, itemKey) {
  const def = CHARACTERS[npcId];
  const rel = ensureRelationship(s, npcId);
  if (!def || !rel) return { ok: false, msg: 'Unable to give gift.' };
  if (rel.lastGiftDay === s.day && rel.giftsGivenToday >= 2) {
    return { ok: false, msg: `${def.name} smiles: "You’ve already been so generous today — save something for yourself!"` };
  }
  const loved = def.favoriteGifts.includes(itemKey);
  rel.lastGiftDay = s.day;
  rel.giftsGivenToday = (rel.lastGiftDay === s.day ? rel.giftsGivenToday : 0) + 1;
  if (loved) {
    adjustRelationship(s, npcId, { friendship: 12, trust: 8, familiarity: 6, respect: 4 }, {
      type: 'loved_gift',
      detail: `gifted favorite item (${itemKey.replace(/_/g, ' ')})`,
    });
    awardSkillXp(s, 'social', 24);
    return {
      ok: true,
      loved: true,
      msg: `${def.name} lights up: "How did you know I love ${itemKey.replace(/_/g, ' ')}?! I’ll remember this." (+12 Friendship, +8 Trust)`,
    };
  }
  adjustRelationship(s, npcId, { friendship: 5, trust: 3, familiarity: 4 }, {
    type: 'nice_gift',
    detail: `shared ${itemKey.replace(/_/g, ' ')}`,
  });
  awardSkillXp(s, 'social', 12);
  return {
    ok: true,
    loved: false,
    msg: `${def.name}: "That’s genuinely thoughtful of you — thank you for the ${itemKey.replace(/_/g, ' ')}!" (+5 Friendship, +3 Trust)`,
  };
}

export function maybeGenerateInvite(s, npcId) {
  const rel = ensureRelationship(s, npcId);
  const def = CHARACTERS[npcId];
  if (!rel || !def || rel.pendingInvite) return null;
  if (rel.friendship < 25 || rel.conflictState?.active) return null;
  // Deterministic invitation slots based on friendship & home upgrade
  const homeProp = s.progression?.properties?.activePropertyId || 'prop_student_flat';
  const invites = [
    { zone: 'bistro', activity: 'coffee_outing', label: `Meet ${def.name} for coffee & crepes at Willow Corner Bistro` },
    { zone: 'library', activity: 'study_together', label: `Study together with ${def.name} at University Library` },
    { zone: 'park', activity: 'park_hangout', label: `Hang out with ${def.name} in Riverside Park` },
    { zone: 'atelier', activity: 'creative_jam', label: `Drop by Riverside Atelier with ${def.name}` },
  ];
  if (homeProp !== 'prop_student_flat' || (s.progression?.ownedObjects?.length || 0) >= 8) {
    invites.push({ zone: 'living', activity: 'home_visit', label: `Host ${def.name} at your upgraded home` });
  }
  const pick = invites[(s.day + npcId.length) % invites.length];
  rel.pendingInvite = {
    ...pick,
    createdDay: s.day,
    expiresDay: s.day + 2,
    accepted: false,
  };
  return rel.pendingInvite;
}

export function checkExpiredInvites(s) {
  for (const [id, n] of Object.entries(s.npcs || {})) {
    const inv = n.rel?.pendingInvite;
    if (!inv || inv.accepted) continue;
    if (s.day > inv.expiresDay) {
      n.rel.pendingInvite = null;
      adjustRelationship(s, id, { trust: -4, friendship: -2 }, {
        type: 'missed_invite',
        detail: `couldn’t make it to ${inv.label}`,
      });
    }
  }
}

export function latestMemoryNote(rel) {
  if (!rel?.memories?.length) return null;
  return rel.memories[rel.memories.length - 1];
}
