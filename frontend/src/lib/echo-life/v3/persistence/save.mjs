import { createGame, createWorldV3, meals, products } from '../game-core/simulation.mjs';
import { zones } from '../world-data/world.mjs';
import { quests } from '../story-and-quests/semester.mjs';
import { createProgression, syncCredits } from '../progression/state.mjs';
import { newResidents } from '../npc-ai/residents.mjs';
import { createRelationship } from '../npc-ai/relationships.mjs';
import { initSideQuestsState } from '../story-and-quests/side-quests.mjs';

const finite = Number.isFinite;
const dict = v => v && typeof v === 'object' && !Array.isArray(v);
const counts = v => dict(v) && Object.values(v).every(n => Number.isSafeInteger(n) && n >= 0 && n < 1e8);

// FIXED V2 BUG: validate rectangular X against area.size/2 and Z against (area.depth || area.size)/2 separately!
const position = p => {
  if (!dict(p) || !Object.hasOwn(zones, p.zone) || !finite(p.x) || !finite(p.z)) return false;
  const area = zones[p.zone];
  const halfX = area.size * 0.5 + 0.05;
  const halfZ = (area.depth || area.size) * 0.5 + 0.05;
  return Math.abs(p.x) <= halfX && Math.abs(p.z) <= halfZ;
};

function validOwnedObject(o, owner) {
  if (!dict(o)) return false;
  if (typeof o.instanceId !== 'string' || o.instanceId.length < 3) return false;
  if (typeof o.assetFamilyId !== 'string' || typeof o.selectedVariantId !== 'string') return false;
  if (o.ownerAccountId !== owner) return false;
  if (!Number.isSafeInteger(o.upgradeLevel) || o.upgradeLevel < 0 || o.upgradeLevel > 10) return false;
  if (!dict(o.installedComponents) || !dict(o.customAppearance) || !dict(o.location) || !dict(o.placement) || !dict(o.interactionState)) return false;
  if (!finite(o.condition) || o.condition < 0 || o.condition > 100) return false;
  if (!Number.isSafeInteger(o.revision) || o.revision < 1) return false;
  if (!['x', 'y', 'z', 'yaw'].every(k => finite(o.placement[k]))) return false;
  return true;
}

function mergeResidentsForV4(oldNpcs) {
  const fresh = newResidents();
  for (const [id, defNpc] of Object.entries(fresh)) {
    const prev = oldNpcs?.[id];
    if (prev && position(prev)) {
      const merged = { ...defNpc, ...prev };
      if (!dict(merged.rel)) {
        merged.rel = createRelationship(id);
        if (finite(prev.friend) && prev.friend > 0) {
          merged.rel.friendship = Math.min(100, Math.max(0, Math.round(prev.friend)));
          merged.rel.familiarity = Math.max(merged.rel.familiarity, merged.rel.friendship);
        }
      }
      fresh[id] = merged;
    }
  }
  return fresh;
}

export function decode(raw, owner) {
  const v = JSON.parse(raw);
  if (!dict(v) || v.owner !== owner) throw Error('This save belongs to a different player.');

  // Seamless lossless forward migration: v1 -> v4, v2 -> v4, v3 (V2 Progression) -> v4 (V3 Open World)
  if (v.version === 1 || v.version === 2 || v.version === 3) {
    const base = createGame(owner);
    const migratedProg = v.progression || createProgression(owner, Number.isSafeInteger(v.cash) && v.cash >= 0 ? v.cash : base.cash);
    const returningPlayer = (Array.isArray(v.done) && v.done.length > 0) || Boolean(v.sandbox) || (v.version === 3 && (v.saveRevision || 0) > 0);
    const migratedV3 = v.worldV3 || createWorldV3(returningPlayer);
    if (v.player?.zone && !migratedV3.exploration.discoveredZones.includes(v.player.zone)) {
      migratedV3.exploration.discoveredZones.push(v.player.zone);
    }
    const mergedPlayer = { ...base.player, ...(v.player || {}), driving: Boolean(v.player?.driving) };
    const mergedStock = { ...base.stock, ...(v.stock || {}) };
    Object.assign(base, v, {
      version: 4,
      saveRevision: v.saveRevision ?? 0,
      player: mergedPlayer,
      stock: mergedStock,
      npcs: mergeResidentsForV4(v.npcs),
      progression: migratedProg,
      worldV3: migratedV3,
    });
    syncCredits(base);
    return decode(JSON.stringify(base), owner);
  }

  const bad = () => { throw Error('Invalid or unsupported save.'); };
  if (v.version !== 4 || !Number.isSafeInteger(v.saveRevision) || v.saveRevision < 0) bad();
  if (!position(v.player) || !['vx', 'vy', 'vz', 'yaw', 'y', 'speed'].every(k => finite(v.player[k])) || !finite(v.clock) || !finite(v.elapsed) || !Number.isSafeInteger(v.cash) || v.cash < 0) bad();
  if (!counts(v.bag) || !counts(v.pantry) || !counts(v.stock) || !counts(v.progress) || !dict(v.flags) || !dict(v.settings) || !dict(v.needs) || !Object.values(v.needs).every(finite)) bad();
  if (!Array.isArray(v.done) || !v.done.every(id => quests.some(q => q.id === id)) || !Array.isArray(v.basket) || !v.basket.every(k => Object.hasOwn(products, k)) || !Array.isArray(v.history)) bad();
  if (!position(v.bike) || !position(v.objects?.broom) || !dict(v.npcs)) bad();
  // Ensure all 22 V3 residents exist & have valid positions and relationships
  v.npcs = mergeResidentsForV4(v.npcs);
  if (!Object.values(v.npcs).every(n => position(n) && finite(n.friend) && dict(n.rel))) bad();
  if (!['student', 'student2', 'gemini', 'geminiSport'].includes(v.avatar) || (v.pot && (!Object.hasOwn(meals, v.pot.meal) || !finite(v.pot.at)))) bad();
  if (!Object.values(v.npcs).every(n => typeof n.id === 'string' && (!n.path || (Array.isArray(n.path) && n.path.length < 2000 && n.path.every(pt => Array.isArray(pt) && pt.length === 2 && pt.every(finite)))))) bad();
  if (!['Ultra', 'High', 'Medium', 'Low', 'Lite'].includes(v.settings.quality) || !finite(v.seed) || !finite(v.npcTime) || !finite(v.day) || !Number.isFinite(v.objects.broom.y)) bad();
  if (v.challenge && (!['arcade', 'sport', 'rings', 'badminton', 'music_jam'].includes(v.challenge.type) || !Array.isArray(v.challenge.sequence))) bad();
  v.portable ??= createGame(owner).portable;
  if (!['ball', 'basketTool'].every(k => position(v.portable[k]))) bad();
  if (![null, 'broom', 'ball', 'basketTool'].includes(v.held)) bad();

  // Validate V2 progression tree (preserved 100%)
  const pr = v.progression;
  if (!dict(pr) || !Number.isSafeInteger(pr.playerLevel) || pr.playerLevel < 1 || !Number.isSafeInteger(pr.totalXp) || pr.totalXp < 0) bad();
  if (!dict(pr.economy) || !Number.isSafeInteger(pr.economy.credits) || pr.economy.credits < 0) bad();
  if (!dict(pr.skills) || !counts(pr.materials) || !Array.isArray(pr.ownedObjects)) bad();
  if (!pr.ownedObjects.every(o => validOwnedObject(o, owner))) bad();
  if (!dict(pr.properties) || !Array.isArray(pr.properties.ownedIds) || typeof pr.properties.activePropertyId !== 'string') bad();
  if (!dict(pr.roomStyles) || !dict(pr.reputation) || !Array.isArray(pr.achievements)) bad();

  // Validate V3 open-world, story, exploration, tutorial & car state
  const w3 = v.worldV3;
  if (!dict(w3) || !dict(w3.tutorial) || !dict(w3.storyChoices) || !dict(w3.exploration)) bad();
  if (!Array.isArray(w3.exploration.discoveredZones) || !Array.isArray(w3.exploration.discoveredLandmarks) || !Array.isArray(w3.exploration.collectibles)) bad();
  if (!Array.isArray(w3.photos) || !Array.isArray(w3.eventsAttended)) bad();
  if (!dict(w3.sideQuests)) w3.sideQuests = initSideQuestsState();
  if (w3.car && !position(w3.car)) bad();

  v.cash = pr.economy.credits;
  return v;
}

export function saves(storage, owner) {
  const key = 'echo-life/4/' + encodeURIComponent(owner);
  const v3Key = 'echo-life/3/' + encodeURIComponent(owner);
  const legacyKey = 'echo-life/2/' + encodeURIComponent(owner);
  const backup = key + '/previous';
  let observed = storage.getItem(key);
  return {
    save(s) {
      if (storage.getItem(key) !== observed) throw Error('This save changed in another window. Reload it before continuing.');
      const raw = JSON.stringify(s);
      decode(raw, owner);
      const old = storage.getItem(key);
      if (old) {
        try { decode(old, owner); storage.setItem(backup, old); } catch { /* preserve healthy backup */ }
      }
      storage.setItem(key, raw);
      observed = raw;
    },
    load() {
      observed = storage.getItem(key);
      for (const k of [key, backup, v3Key, legacyKey]) {
        try { const raw = storage.getItem(k); if (raw) return decode(raw, owner); } catch { /* try prior generation */ }
      }
      return null;
    },
  };
}
