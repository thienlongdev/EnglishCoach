// Echo Life Wave 11 (Team D1) — Contract Verification Suite for Pure Life-Sim and Character Creator Modules.
// Uses native Node ESM TypeScript loading via `module.registerHooks` (zero eval / zero new Function).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const targetBase = path.join(SRC, specifier.slice(2));
      for (const ext of ['', '.ts', '.mjs', '.json']) {
        const cand = targetBase + ext;
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
          return nextResolve(pathToFileURL(cand).href, context);
        }
      }
    }
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z0-9]+$/i.test(specifier)) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      for (const ext of ['.ts', '.mjs', '.json']) {
        const cand = path.resolve(parentDir, specifier + ext);
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
          return nextResolve(pathToFileURL(cand).href, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const creator = await import(pathToFileURL(path.join(SRC, 'lib/avatar/characterCreator.ts')).href);
const lookV1 = await import(pathToFileURL(path.join(SRC, 'lib/avatar/look.ts')).href);
const mind = await import(pathToFileURL(path.join(SRC, 'lib/echo-life/game/playerMind.ts')).href);
const cooking = await import(pathToFileURL(path.join(SRC, 'lib/echo-life/game/cookingSim.ts')).href);
const career = await import(pathToFileURL(path.join(SRC, 'lib/echo-life/game/careerSim.ts')).href);
const phone = await import(pathToFileURL(path.join(SRC, 'lib/echo-life/game/phoneSim.ts')).href);
const bridge = await import(pathToFileURL(path.join(SRC, 'lib/echo-life/game/wardrobeBridge.ts')).href);

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};
const eq = (actual, expected, msg) => {
  assert.equal(actual, expected, msg);
  checks++;
};

// ── 1. Character Creator Core, Wire V2 Codec, Fuzzing, V1 Compatibility, Seasonal Outfits ───────────────
{
  const expectedMorphs = [
    'sculpt_stylized', 'sculpt_eastAsian', 'sculpt_jawWidth', 'sculpt_jawSharp',
    'sculpt_chinHeight', 'sculpt_chinWidth', 'sculpt_cheekFull', 'sculpt_eyeSize',
    'sculpt_eyeSpacing', 'sculpt_eyeTilt', 'sculpt_eyeMonolid', 'sculpt_browHeight',
    'sculpt_noseLength', 'sculpt_noseWidth', 'sculpt_noseBridge', 'sculpt_noseTip',
    'sculpt_lipFullness', 'sculpt_mouthWidth', 'sculpt_lipArch', 'sculpt_mouthCorner',
  ];
  eq(creator.FACE_MORPH_DEFS.length, 20, 'exactly 20 face morph definitions');
  for (const key of expectedMorphs) {
    const def = creator.FACE_MORPH_DEFS.find(d => d.key === key);
    ok(Boolean(def), `morph ${key} defined`);
    eq(def.min, -1, `${key} min = -1`);
    eq(def.max, 1, `${key} max = 1`);
    eq(def.step, 0.02, `${key} step = 0.02`);
    eq(def.defaultValue, 0, `${key} default = 0`);
  }
  eq(creator.FACE_MORPH_TABS.length, 5, '5 face morph tabs');
  eq(creator.SKIN_TONE_PRESETS.length, 12, '12 Fitzpatrick I-VI skin presets');
  eq(creator.IRIS_COLOR_PRESETS.length, 8, '8 natural iris color presets');
  eq(creator.FACIAL_HAIR_STYLES.length, 4, '4 facial hair styles');
  eq(creator.BODY_SLIDER_DEFS.length, 6, '6 body proportion sliders');
  eq(creator.BODY_PRESETS.length, 5, '5 body presets');
  eq(creator.HAIR_CATALOG.length, 8, '8 distinct hairstyles');
  eq(creator.HAIR_COLOR_PRESETS.length, 12, '12 curated hair colors');
  eq(creator.OUTERWEAR_CATALOG.length, 8, '8 outerwear options including none + coats');
  eq(creator.ACCESSORY_CATALOG.length, 6, '6 accessories (3 legacy + 3 Wave 11)');
  eq(creator.FABRIC_CATALOG.length, 8, '8 fabric options');
  eq(creator.PATTERN_CATALOG.length, 4, '4 pattern options');
  eq(creator.OUTFIT_SLOTS.length, 8, '8 outfit slots');
  eq(creator.TRAIT_CATALOG.length, 18, '18 personality traits');
  eq(creator.DESIRED_LIFE_CATALOG.length, 16, '16 desired lives');
  eq(creator.VALUES_CATALOG.length, 8, '8 personal values');
  eq(creator.PREFERENCES_CATALOG.length, 16, '16 preferences');
  eq(creator.CHARACTER_PRESETS.length, 6, '6 curated complete character presets');

  // Verify all 19 Lyra / 18 Kai items from wardrobeAssets.ts are surfaced (tops+dresses+bottoms+shoes+legacy 3 acc)
  const lyraCat = creator.getGarmentCatalogForHero('LYRA');
  const kaiCat = creator.getGarmentCatalogForHero('KAI');
  eq(lyraCat.tops.length + lyraCat.bottoms.length + lyraCat.shoes.length + 3, 19, 'all 19 Lyra wardrobeAssets garments accessible');
  eq(kaiCat.tops.length + kaiCat.bottoms.length + kaiCat.shoes.length + 3, 18, 'all 18 Kai wardrobeAssets garments accessible');

  // V2 Wire round-trip for LYRA and KAI + exact AvatarLookCode.java backend regex compliance
  for (const preset of creator.CHARACTER_PRESETS) {
    const wire = creator.encodeLookV2(preset.profile);
    ok(wire.length <= creator.LOOK_V2_WIRE_MAX_LENGTH, `preset ${preset.id} wire <= 256 chars (${wire.length})`);
    ok(/^[\x20-\x7E]+$/.test(wire), `preset ${preset.id} wire is strict ASCII`);
    ok(!wire.includes('..'), `preset ${preset.id} wire contains no double-dots`);
    ok(creator.LOOK_V2_WIRE_REGEX.test(wire), `preset ${preset.id} wire matches V2 regex`);
    ok(creator.BACKEND_V2_WIRE_REGEX.test(wire), `preset ${preset.id} wire matches backend AvatarLookCode.V2_SHAPE`);

    const decoded = creator.decodeLookV2(wire, preset.profile.hero);
    eq(decoded.hero, preset.profile.hero, `${preset.id} hero round-trip`);
    eq(decoded.hairId, preset.profile.hairId, `${preset.id} hairId round-trip`);
    eq(decoded.skinHex, preset.profile.skinHex, `${preset.id} skinHex round-trip`);
    eq(decoded.irisHex, preset.profile.irisHex, `${preset.id} irisHex round-trip`);
    eq(decoded.hairColor, preset.profile.hairColor, `${preset.id} hairColor round-trip`);

    const srcOutfit = preset.profile.outfits[preset.profile.activeOutfitSlot];
    const decOutfit = decoded.outfits.everyday;
    eq(decOutfit.outerwear, srcOutfit.outerwear, `${preset.id} outerwear round-trip`);
    eq(decOutfit.top, srcOutfit.top, `${preset.id} top round-trip`);
    eq(decOutfit.bottom, srcOutfit.bottom, `${preset.id} bottom round-trip`);
    eq(decOutfit.shoes, srcOutfit.shoes, `${preset.id} shoes round-trip`);
    assert.deepEqual(decOutfit.accessories, srcOutfit.accessories, `${preset.id} accessories round-trip`);
    assert.deepEqual(decOutfit.fabrics, srcOutfit.fabrics, `${preset.id} fabrics round-trip`);
    assert.deepEqual(decOutfit.patterns, srcOutfit.patterns, `${preset.id} patterns round-trip`);

    for (const def of creator.BODY_SLIDER_DEFS) {
      ok(Math.abs(decoded.body[def.key] - preset.profile.body[def.key]) <= 0.015, `${preset.id} body.${def.key} quantized accurately`);
    }
    for (const key of creator.WIRE_V2_FACE_KEYS) {
      ok(Math.abs(decoded.faceMorphs[key] - preset.profile.faceMorphs[key]) <= 0.025, `${preset.id} face.${key} quantized accurately`);
    }
  }

  // Worst-case longest V2 wire stress test (longest hair + longest outerwear + 4 longest accessories)
  const maxProfile = creator.createDefaultCreatorProfile('LYRA');
  maxProfile.hairId = 'hair_textured_curl';
  maxProfile.outfits.everyday.outerwear = 'wool_overcoat';
  maxProfile.outfits.everyday.top = 'longsleeve';
  maxProfile.outfits.everyday.bottom = 'joggers';
  maxProfile.outfits.everyday.shoes = 'sneakers';
  maxProfile.outfits.everyday.accessories = ['headphones', 'sunglasses', 'backpack', 'beanie'];
  const maxWire = creator.encodeLookV2(maxProfile);
  ok(maxWire.length <= 256, `worst-case V2 wire <= 256 chars (${maxWire.length})`);
  ok(creator.BACKEND_V2_WIRE_REGEX.test(maxWire), 'worst-case V2 wire matches backend AvatarLookCode.V2_SHAPE');
  const maxDec = creator.decodeLookV2(maxWire);
  assert.deepEqual(maxDec.outfits.everyday.accessories, ['headphones', 'sunglasses', 'backpack', 'beanie'], '4-accessory V2 round-trip');

  // Legacy V1 wire backward compatibility
  const v1Sample = lookV1.normalizeLook('LYRA', {
    top: 'hoodie',
    bottom: 'jeans',
    shoes: 'boots',
    accessories: ['glasses', 'headphones'],
    colors: { top: '#4f8a6b', bottom: '#2c3e5e', shoes: '#8a5a3b', hair: '#5a3a2a', accessory: '#e8b65e' },
  });
  const v1Wire = lookV1.encodeLook(v1Sample);
  const decodedFromV1 = creator.decodeLookV2(v1Wire, 'LYRA');
  eq(decodedFromV1.hero, 'LYRA', 'V1 decode preserves hero');
  eq(decodedFromV1.outfits.everyday.top, 'hoodie', 'V1 decode preserves top');
  eq(decodedFromV1.outfits.everyday.bottom, 'jeans', 'V1 decode preserves bottom');
  eq(decodedFromV1.outfits.everyday.shoes, 'boots', 'V1 decode preserves shoes');
  eq(decodedFromV1.hairColor, '#5a3a2a', 'V1 decode preserves hair color');
  assert.deepEqual(decodedFromV1.outfits.everyday.accessories, ['glasses', 'headphones'], 'V1 decode preserves accessories');

  // Fuzz & adversarial input bounds clamping
  const fuzzed = creator.sanitizeCreatorProfile({
    hero: 'EVIL_HERO',
    hairId: '<script>alert(1)</script>',
    skinHex: 'not-a-hex',
    irisHex: '#zzzzzz',
    hairTipMix: 9999,
    faceMorphs: { sculpt_jawWidth: 999, sculpt_eyeSize: -999, sculpt_noseWidth: Number.NaN, sculpt_lipArch: Infinity },
    makeup: { browThickness: -5, lipOpacity: 50, facialHair: 'invalid_beard' },
    body: { heightScale: 500, buildScale: -10, shoulderWidth: Number.NaN, legRatio: 100, torsoDepth: 0.1, hipWidth: 99 },
    activeOutfitSlot: 'hacked_slot',
    outfits: {
      everyday: {
        outerwear: 'invalid_coat',
        top: 'evil_top',
        bottom: 'evil_bottom',
        shoes: 'evil_shoes',
        accessories: ['glasses', 'glasses', 'evil', 'beanie', 'cap', 'backpack', 'sunglasses'],
        colors: { top: 'javascript:alert(1)' },
        fabrics: { top: 'asbestos' },
        patterns: { top: 'xss' },
      },
    },
    identity: {
      displayName: 'Bob & <script>alert(1)</script>!!!',
      traitIds: ['evil', 'dreamer', 'dreamer', 'scholar', 'artisan', 'athlete'],
      desiredLifeId: 'nonexistent',
    },
  });
  eq(fuzzed.hero, 'LYRA', 'fuzz hero falls back to LYRA');
  eq(fuzzed.faceMorphs.sculpt_jawWidth, 1, 'fuzz morph upper clamped to 1');
  eq(fuzzed.faceMorphs.sculpt_eyeSize, -1, 'fuzz morph lower clamped to -1');
  eq(fuzzed.faceMorphs.sculpt_noseWidth, 0, 'fuzz NaN morph reset to 0');
  eq(fuzzed.body.heightScale, 1.12, 'fuzz height clamped to 1.12');
  eq(fuzzed.body.buildScale, 0.88, 'fuzz build clamped to 0.88');
  eq(fuzzed.body.legRatio, 1.08, 'fuzz legRatio clamped to 1.08');
  eq(fuzzed.makeup.browThickness, 0, 'fuzz makeup lower clamped');
  eq(fuzzed.makeup.lipOpacity, 1, 'fuzz makeup upper clamped');
  ok(fuzzed.outfits.everyday.accessories.length <= 4, 'fuzz accessories capped at 4 unique');
  ok(!fuzzed.identity.displayName.includes('<') && !fuzzed.identity.displayName.includes('&'), 'fuzz displayName sanitized');
  eq(fuzzed.identity.traitIds.length, 3, 'fuzz traits capped at 3 unique valid');

  // Garbage/oversized wire decode falls back safely without throwing
  const safeFallback = creator.decodeLookV2('v2:' + 'a'.repeat(400), 'KAI');
  eq(safeFallback.hero, 'KAI', 'oversized wire safely falls back');

  // Auto-seasonal outfit resolution
  const baseLyra = creator.createDefaultCreatorProfile('LYRA');
  const winterRes = creator.resolveActiveOutfitForWeather(baseLyra, 3, false);
  eq(winterRes.slotId, 'cold_weather', 'Winter auto-selects cold_weather outfit');
  ok(winterRes.outfit.outerwear !== 'none', 'Winter cold_weather has warm outerwear');

  const snowRes = creator.resolveActiveOutfitForWeather(baseLyra, 'autumn', 0.6);
  eq(snowRes.slotId, 'cold_weather', 'Snow auto-selects cold_weather outfit regardless of season');

  const summerRes = creator.resolveActiveOutfitForWeather(baseLyra, 1, false, 31);
  eq(summerRes.slotId, 'hot_weather', 'Hot summer auto-selects hot_weather outfit');

  const manualOff = { ...baseLyra, autoSeasonalOutfit: false, activeOutfitSlot: 'formal' };
  const manualRes = creator.resolveActiveOutfitForWeather(manualOff, 3, true, -2);
  eq(manualRes.slotId, 'formal', 'Manual mode preserves explicit outfit slot');

  // Deterministic randomizer and Undo/Redo history
  const randA = creator.randomizeProfile('seed-wave11', 'LYRA');
  const randB = creator.randomizeProfile('seed-wave11', 'LYRA');
  assert.deepEqual(randA, randB, 'randomizeProfile is 100% deterministic for same seed');

  const hist = new creator.CreatorHistory(baseLyra);
  ok(!hist.canUndo && !hist.canRedo, 'fresh history cannot undo or redo');
  const step1 = { ...baseLyra, hairId: 'hair_bob' };
  const step2 = { ...step1, hairColor: '#98472e' };
  hist.push(step1);
  hist.push(step2);
  ok(hist.canUndo && !hist.canRedo, 'history can undo after pushes');
  const undone = hist.undo();
  eq(undone.hairId, 'hair_bob', 'undo restores previous hairId');
  eq(undone.hairColor, baseLyra.hairColor, 'undo restores previous hairColor');
  ok(hist.canRedo, 'history can redo after undo');
  const redone = hist.redo();
  eq(redone.hairColor, '#98472e', 'redo restores forward hairColor');
}

// ── 2. Player Mind: 8 Needs, V3 Bridge, 12 Emotions, Urges, Karma, 8 Sub-Skills, Thought Bubbles ─────────
{
  const initNeeds = mind.createInitialNeeds8();
  eq(Object.keys(initNeeds).length, 8, 'Needs8 has exact 8 core needs');

  // Verify decay including hygiene and bathroom
  const after4Hours = mind.advanceNeeds8(initNeeds, 240, { sprinting: true });
  ok(after4Hours.hunger < initNeeds.hunger, 'hunger decays over game minutes');
  ok(after4Hours.hygiene < initNeeds.hygiene, 'hygiene decays over game minutes');
  ok(after4Hours.bathroom < initNeeds.bathroom, 'bathroom decays over game minutes');
  ok(after4Hours.energy < initNeeds.energy, 'energy decays faster when sprinting');

  // Verify restores and clamping
  const restored = mind.applyActivityToNeeds(mind.applyActivityToNeeds(after4Hours, 'use_bathroom'), 'take_shower');
  ok(restored.bathroom > after4Hours.bathroom && restored.bathroom <= 100, 'bathroom activity restores and clamps');
  ok(restored.hygiene > after4Hours.hygiene && restored.hygiene <= 100, 'shower activity restores and clamps');

  // Bidirectional V3 6-vital bridge
  const v3Proj = mind.projectToV3Vitals(restored, { fitness: 42 });
  eq(v3Proj.fitness, 42, 'projectToV3Vitals preserves V3 fitness');
  eq(v3Proj.energy, restored.energy, 'projectToV3Vitals syncs energy');
  const pulled = mind.syncFromV3Vitals(restored, { energy: 55, hunger: 40, hygiene: 60, mood: 80 });
  eq(pulled.energy, 55, 'syncFromV3Vitals updates energy');
  eq(pulled.hunger, 40, 'syncFromV3Vitals updates hunger');
  eq(pulled.bathroom, restored.bathroom, 'syncFromV3Vitals preserves bathroom');

  // Verify all 12 emotions are deterministically reachable
  eq(mind.EMOTION_IDS.length, 12, 'exact 12 emotions registered');
  const baseWell = { hunger: 85, hygiene: 85, bathroom: 85, fun: 80, social: 80, energy: 85, sleep: 85, recognition: 65 };
  const emotionScenarios = [
    ['hungry', { needs: { ...baseWell, hunger: 10 } }],
    ['tired', { needs: { ...baseWell, energy: 12, sleep: 10 } }],
    ['embarrassed', { needs: { ...baseWell, bathroom: 8, hygiene: 10 } }],
    ['bored', { needs: { ...baseWell, fun: 8, social: 65, energy: 70, sleep: 70, hunger: 70 } }],
    ['anxious', { needs: { ...baseWell, social: 10 }, recentEvents: [{ kind: 'rivalry_tension', intensity: 1.5 }] }],
    ['cozy', { needs: baseWell, moodlets: ['rain_cozy', 'warm_hearth'], weather: { rain: true, indoor: true } }],
    ['inspired', { needs: baseWell, moodlets: ['inspired_space'], recentEvents: [{ kind: 'creative_milestone', intensity: 1.5 }] }],
    ['focused', { needs: baseWell, moodlets: ['caffeinated'], recentEvents: [{ kind: 'deep_study', intensity: 1.5 }] }],
    ['confident', { needs: { ...baseWell, recognition: 95 }, recentEvents: [{ kind: 'promotion', intensity: 1.5 }] }],
    ['playful', { needs: { ...baseWell, fun: 96 }, moodlets: ['hot_streak'], recentEvents: [{ kind: 'basketball_streak', intensity: 1.5 }] }],
    ['joyful', { needs: { ...baseWell, hunger: 98, hygiene: 98, bathroom: 98, fun: 95, social: 95, energy: 95, sleep: 95 }, moodlets: ['well_rested'], karmaScore: 80 }],
    ['calm', { needs: { hunger: 68, hygiene: 70, bathroom: 70, fun: 62, social: 65, energy: 68, sleep: 68, recognition: 45 }, moodlets: ['tea_calm'], traitIds: ['minimalist', 'mediator'] }],
  ];
  for (const [expected, input] of emotionScenarios) {
    const res = mind.computePlayerEmotion(input);
    eq(res.primary, expected, `emotion "${expected}" reachable deterministically (got "${res.primary}")`);
    ok(res.label.length > 0 && res.color.startsWith('#') && res.copingHint.length > 10, `emotion "${expected}" has rich metadata`);
  }

  // Dynamic daily urges (3 slots) & completion rewards
  let pm = mind.createInitialPlayerMindState(2, 517, { traitIds: ['artisan', 'athlete'], desiredLifeId: 'culinary_host', hour: 11 });
  eq(pm.urges.length, 3, 'generates 3 active daily urges');
  const firstUrge = pm.urges[0];
  const urgeRes = mind.recordActionForUrges(pm, { kind: firstUrge.actionKind, targetId: firstUrge.targetId, amount: firstUrge.goalCount }, 2, 660);
  eq(urgeRes.completedUrges.length, 1, 'completes matching urge when goalCount met');
  ok(urgeRes.rewards.aspirationPoints > 0 && urgeRes.rewards.recognitionDelta > 0, 'completed urge grants aspiration and recognition');
  ok(urgeRes.state.aspirationPoints > pm.aspirationPoints, 'aspiration points accumulated');

  // Karma bounds & all 5 tiers
  let k = mind.createInitialKarmaState();
  for (let i = 0; i < 15; i++) k = mind.applyKarmaAction(k, 'community_event', 1, 600);
  eq(k.personal, 100, 'personal karma upper-clamped to +100');
  eq(k.tier, 'Radiant Citizen', 'max personal karma reaches Radiant Citizen');
  ok(k.city <= 100 && k.city >= 0, 'city karma clamped [0..100]');
  for (let i = 0; i < 30; i++) k = mind.applyKarmaAction(k, 'selfish_dilemma', 2, 700);
  eq(k.personal, -100, 'personal karma lower-clamped to -100');
  eq(k.tier, 'Rebellious', 'min personal karma reaches Rebellious');
  eq(mind.resolveKarmaTier(-25), 'Mischievous', 'Mischievous tier verified');
  eq(mind.resolveKarmaTier(5), 'Steady Neighbor', 'Steady Neighbor tier verified');
  eq(mind.resolveKarmaTier(40), 'Kind Heart', 'Kind Heart tier verified');

  // 8 expanded sub-skills leveling & perk unlocks
  eq(mind.SUB_SKILL_IDS.length, 8, 'exact 8 expanded sub-skills');
  let sub = mind.createInitialSubSkills();
  const xpRes = mind.awardSubSkillXp(sub, 'cooking', 400);
  ok(xpRes.leveledUp && xpRes.newLevel >= 5, 'sub-skill levels up with XP');
  ok(xpRes.unlockedPerks.includes('Chef Grade Plating'), 'unlocks Chef Grade Plating perk at Cooking Lv 5');
  const maxRes = mind.awardSubSkillXp(xpRes.skills, 'cooking', 5000);
  eq(maxRes.newLevel, 10, 'sub-skill caps cleanly at Level 10');
  eq(maxRes.skills.cooking.nextLevelXp, null, 'Level 10 has null nextLevelXp');

  // Smart Zoi Thought Bubbles & 3-entry Resident Diary
  const rainThought = mind.buildNpcThoughtBubble({
    residentId: 'linh',
    goalKind: 'SEEK_SHELTER',
    mood: 'sheltering',
    weather: { rainIntensity: 0.7, weatherId: 'light_rain' },
  });
  eq(rainThought.text, 'Need shelter from rain', 'rain shelter thought bubble deterministic');
  const memThought = mind.buildNpcThoughtBubble({
    residentId: 'linh',
    goalKind: 'FOLLOW_SCHEDULE',
    mood: 'cheerful',
    latestMemory: { kind: 'player_talk', day: 2, clock: 600, subject: 'festival posters', valence: 0.8, salience: 0.85 },
  });
  eq(memThought.text, 'Remembering our conversation', 'episodic memory thought bubble deterministic');
  const diary = mind.buildResidentDailyDiary({
    residentId: 'linh',
    residentName: 'Linh',
    role: 'Architecture Student',
    day: 3,
    mood: 'cheerful',
    weather: { rainIntensity: 0.5 },
    memories: [{ kind: 'player_gift', day: 3, clock: 650, subject: 'herbal tea', valence: 0.9, salience: 0.9, zone: 'bistro' }],
  });
  eq(diary.length, 3, 'Resident Diary generates exact 3 entries (Morning, Afternoon, Evening)');
  eq(diary[0].period, 'Morning', 'Diary entry 0 is Morning');
  eq(diary[1].period, 'Afternoon', 'Diary entry 1 is Afternoon');
  eq(diary[2].period, 'Evening', 'Diary entry 2 is Evening');
}

// ── 3. Cooking Simulation (10 Home Recipes + 5 Bistro Menu Items) ────────────────────────────────────────
{
  eq(cooking.RECIPE_BOOK.length, 10, '10 complete home recipes');
  eq(cooking.BISTRO_MENU.length, 5, '5 Willow Corner Bistro menu items');

  // Missing ingredients rejection
  const failMissing = cooking.cookRecipe('comfort_ramen', { egg: 1 }, 6);
  ok(!failMissing.ok && failMissing.reason.includes('Missing ingredients'), 'rejects recipe when ingredients missing');

  // Level gating rejection
  const failLevel = cooking.cookRecipe('comfort_ramen', { noodle: 2, egg: 2, meat: 2, greens: 2 }, 2);
  ok(!failLevel.ok && failLevel.reason.includes('Cooking Level 5'), 'rejects recipe when cooking level too low');

  // Successful cook deducts ingredients and awards moodlet + Chef Grade bonus
  const merged = cooking.mergeCookingInventory({ egg: 2, noodle: 1 }, { meat: 1, greens: 2 }, { ingredients: 1 });
  const cooked = cooking.cookRecipe('comfort_ramen', merged, 8, 0.72);
  ok(cooked.ok, 'cooks Comfort Ramen successfully');
  eq(cooked.quality, 'chef_grade', 'high cooking level achieves chef_grade quality');
  eq(cooked.nextInventory.egg, 1, 'deducts exact egg quantity');
  eq(cooked.nextInventory.noodle, 0, 'deducts exact noodle quantity');
  ok(cooked.moodlet !== null && cooked.needsDelta.hunger >= 50, 'grants special meal moodlet and hunger boost');

  // Bistro orders
  const bistroIds = ['matcha_crepe', 'iced_matcha', 'egg_banh_mi', 'truffle_ramen', 'jasmine_tea_set'];
  for (const bid of bistroIds) {
    const order = cooking.orderBistroItem(bid, 50, { hasBaristaPerk: true, discountPct: 10 });
    ok(order.ok && order.cost > 0 && order.remainingCredits < 50 && order.buff !== null, `bistro item ${bid} orders cleanly`);
  }
  const brokeOrder = cooking.orderBistroItem('truffle_ramen', 5);
  ok(!brokeOrder.ok, 'rejects bistro order when credits insufficient');
}

// ── 4. Career Simulation (7 Part-Time 5-Tier Ladders + 4 Full-Time Tracks + Dilemmas) ────────────────────
{
  eq(career.PART_TIME_JOB_IDS.length, 7, 'all 7 active part-time jobs mapped');
  const thresholdChecks = [
    [0, 1, 'Trainee', 1.00],
    [2, 2, 'Associate', 1.05],
    [5, 3, 'Specialist', 1.10],
    [10, 4, 'Lead', 1.15],
    [18, 5, 'Master', 1.20],
  ];
  for (const jobId of career.PART_TIME_JOB_IDS) {
    for (const [shifts, tier, rankTitle, mult] of thresholdChecks) {
      const st = career.getPartTimeCareerStatus(jobId, shifts);
      eq(st.tier, tier, `${jobId} @ ${shifts} shifts => tier ${tier}`);
      eq(st.rankTitle, rankTitle, `${jobId} @ ${shifts} shifts => ${rankTitle}`);
      eq(st.payMultiplier, mult, `${jobId} @ ${shifts} shifts => ${mult}x pay`);
      eq(st.unlockedOutfits.length, tier, `${jobId} unlocks ${tier} outfits by tier ${tier}`);
    }
  }

  // 4 full-time / hybrid tracks + dilemmas + promotions
  eq(career.FULL_TIME_CAREERS.length, 4, '4 full-time/hybrid career tracks');
  let cs = career.createInitialCareerState();
  cs = career.enrollFullTimeCareer(cs, 'campus_journalist');
  eq(cs.activeCareerId, 'campus_journalist', 'enrolled in Campus Journalist');
  ok(career.isFullTimeShiftWindowOpen('campus_journalist', 1, 10), 'Tuesday 10:00 is inside Campus Journalist shift window');
  ok(!career.isFullTimeShiftWindowOpen('campus_journalist', 6, 10), 'Sunday is outside Campus Journalist Mon-Fri schedule');

  // Resolve dilemmas until promotion
  let promoted = false;
  for (let d = 0; d < 4; d++) {
    const dil = career.pickWorkplaceDilemma('campus_journalist', d, 517, cs.resolvedDilemmaIds);
    ok(Boolean(dil && dil.choices.length >= 2), `dilemma picked for day ${d}`);
    const res = career.resolveWorkplaceDilemma(cs, dil.id, dil.choices[0].id, d);
    ok(res.ok, 'dilemma resolved cleanly');
    cs = res.state;
    if (res.promoted) promoted = true;
  }
  ok(promoted && cs.rank >= 2, 'resolving strong workplace dilemma choices earns full-time promotion');

  const wd = career.completeFullTimeWorkday(cs, 10);
  ok(wd.ok && wd.stipendAdvisory > 0, 'completes full-time workday once per day');
  const dupWd = career.completeFullTimeWorkday(wd.state, 10);
  ok(!dupWd.ok, 'prevents duplicate full-time workday on same game day');
}

// ── 5. Echo Phone Simulation (22 Residents, Feed, Schedule, Ledger, Photos, Manage City, Bus Routes) ─────
{
  eq(phone.RESIDENT_CONTACTS.length, 22, 'all 22 residents registered in Echo Phone directory');
  let ph = phone.createInitialPhoneState(1);

  // Text every single one of the 22 residents (0 LLM calls)
  for (const contact of phone.RESIDENT_CONTACTS) {
    const res = phone.sendResidentMessage(ph, contact.id, 'Hey, want to grab coffee or study later?', {
      friendship: 35,
      npcZone: contact.favoriteZone,
      npcMood: 'cheerful',
      day: 1,
      clock: 600,
    });
    ok(Boolean(res.reply && res.reply.text.length > 12), `resident ${contact.id} replies contextually`);
    ph = res.state;
  }

  // Hangout invites: bistro accepted, home gated on friendship >= 20, late curfew declined
  const invBistro = phone.sendHangoutInvite(ph, 'linh', 'bistro', { friendship: 15, day: 1, clock: 780 });
  ok(invBistro.accepted && invBistro.meetupPlan?.zoneId === 'bistro', 'bistro hangout invite accepted and creates meetup plan');
  ph = invBistro.state;

  const invHomeLow = phone.sendHangoutInvite(ph, 'hoangphuc', 'home', { friendship: 5, day: 1, clock: 780 });
  ok(!invHomeLow.accepted && invHomeLow.meetupPlan === null, 'home invite requires friendship >= 20');

  const invLate = phone.sendHangoutInvite(ph, 'minh', 'park', { friendship: 80, day: 1, clock: 23 * 60 });
  ok(!invLate.accepted, 'late night invite declined cleanly');

  // Campus Social Feed: weather + milestones + Like + Reply
  const milestonePosts = phone.generateCampusFeedPosts(1, {
    weather: 'snow',
    festivalTitle: 'Winter Cocoa Market',
    recentMilestones: ['shift_promotion', 'basketball_streak', 'new_home', 'photo_upload'],
    playerName: 'Lyra Chen',
    clock: 840,
  });
  ok(milestonePosts.length >= 6, 'generates weather, festival, and milestone feed posts');
  ph = phone.addFeedPosts(ph, milestonePosts);
  const playerPost = phone.createPlayerFeedPost(ph, 'Sunset lantern walk along the river!', 'photo_upload', 1, 900, 'Lyra Chen', 'street');
  ok(playerPost.post !== null && playerPost.post.comments.length === 1, 'player post attracts resident comment');
  ph = playerPost.state;

  const targetPostId = milestonePosts[0].id;
  const liked = phone.likeFeedPost(ph, targetPostId);
  ok(liked.liked && liked.friendshipDelta > 0 && liked.recognitionDelta > 0, 'liking resident post boosts friendship and recognition');
  ph = liked.state;

  const replied = phone.replyToFeedPost(ph, targetPostId, 'On my way in my wool overcoat!', 1, 920, 'Lyra Chen');
  ok(replied.ok && replied.friendshipDelta > 0, 'replying to feed post appends reply and resident follow-up');
  ph = replied.state;

  // Daily schedule merges shift, hangout, and festival
  const schedDay5 = phone.getDailySchedule(
    { ...ph, meetups: [{ ...invBistro.meetupPlan, scheduledDay: 5 }] },
    5,
    { seasonIndex: 3, weekdayIndex: 1, fullTimeCareerId: 'campus_journalist' },
  );
  ok(schedDay5.some(e => e.kind === 'shift'), 'schedule includes full-time shift');
  ok(schedDay5.some(e => e.kind === 'hangout'), 'schedule includes accepted hangout');
  ok(schedDay5.some(e => e.kind === 'festival' && e.title === 'Winter Cocoa Market'), 'schedule includes seasonal festival');

  // Echo Bank ledger capped at 25 + net worth summary
  for (let i = 0; i < 32; i++) {
    ph = phone.recordBankTransaction(ph, {
      source: i % 2 === 0 ? 'Willow Barista Shift' : 'Willow Bistro Snack',
      delta: i % 2 === 0 ? 60 : -12,
      balanceAfter: 120 + i * 24,
      day: 1 + (i % 5),
      clock: 540 + i * 15,
    });
  }
  eq(ph.ledger.length, 25, 'Echo Bank ledger capped strictly at 25 entries');
  const bankSum = phone.getBankSummary(ph, 880, 1800);
  eq(bankSum.estimatedNetWorth, 2680, 'net worth combines balance and owned assets');

  // Photo album capped at 24 metadata items, no base64 stored in phone state
  for (let i = 0; i < 30; i++) {
    const added = phone.addPhotoToAlbum(ph, {
      title: `Lantern View #${i}`,
      zone: 'street',
      season: 'Winter',
      filter: 'Warm Film',
      timestamp: 1700000000 + i,
    });
    ph = added.state;
  }
  eq(ph.photos.length, 24, 'Photo album capped strictly at 24 shots');

  // Manage City Config clamping & ASCII headline sanitization
  ph = phone.updateManageCityConfig(ph, {
    cleanliness: 180,
    pedestrianDensity: 4.0,
    trafficDensity: 0.01,
    billboardHeadline: '<b>Spring & Music</b> \u2728 ' + 'X'.repeat(80),
    billboardTheme: 'eco',
    cityKarma: 95,
  });
  eq(ph.cityConfig.cleanliness, 100, 'cleanliness clamped to 100');
  eq(ph.cityConfig.pedestrianDensity, 1.5, 'pedestrianDensity clamped to 1.5');
  eq(ph.cityConfig.trafficDensity, 0.3, 'trafficDensity clamped to 0.3');
  ok(ph.cityConfig.billboardHeadline.length <= 40, 'billboardHeadline capped at 40 chars');
  ok(!ph.cityConfig.billboardHeadline.includes('<') && !ph.cityConfig.billboardHeadline.includes('&'), 'billboardHeadline sanitized of HTML and ampersand');
  ok(/^[\x20-\x7E]+$/.test(ph.cityConfig.billboardHeadline), 'billboardHeadline is strict safe ASCII');

  // Riverside Shuttle Bus Routes (6 stops)
  eq(phone.BUS_STOPS.length, 6, '6 connected Riverside Shuttle bus stops');
  const stopNames = phone.BUS_STOPS.map(s => s.name);
  for (const reqName of ['Lantern Street', 'Riverside Park', 'University Library', 'Market Boulevard', 'Community Botanical Garden', 'Old Campus Fountain Court']) {
    ok(stopNames.includes(reqName), `bus stop "${reqName}" registered`);
  }
  const paidTrip = phone.planBusTrip('lantern_street', 'university_library', 20, false);
  ok(paidTrip.ok && paidTrip.fare === 2 && paidTrip.transitMinutes >= 4 && paidTrip.arrival.x === 103.7, 'standard bus trip charges 2 CC and returns arrival coords');
  const freeTrip = phone.planBusTrip('lantern_street', 'botanical_garden', 0, true);
  ok(freeTrip.ok && freeTrip.fare === 0, 'Student Pass makes shuttle bus trip free');
  const brokeTrip = phone.planBusTrip('lantern_street', 'fountain_plaza', 1, false);
  ok(!brokeTrip.ok, 'rejects bus ride when credits < 2 without Student Pass');

  // Bounded serialization strictly <= 12 KB under heavy 22-resident + 25-ledger + 24-photo stress
  const serialized = phone.serializePhoneState(ph);
  const bytes = Buffer.byteLength(JSON.stringify(serialized), 'utf8');
  ok(bytes <= phone.MAX_PHONE_SAVE_BYTES, `serialized EchoPhoneState <= 12 KB (${bytes} bytes)`);
  const rehydrated = phone.deserializePhoneState(serialized, 1);
  eq(rehydrated.cityConfig.billboardTheme, 'eco', 'deserialized phone state retains cityConfig');
}

// ── 6. Wardrobe Bridge (clothing_shop SKUs -> Character Creator) ─────────────────────────────────────────
{
  const starterUnlocked = bridge.resolveUnlockedWardrobe({});
  ok(bridge.isGarmentUnlocked('wool_overcoat', 'outerwear', starterUnlocked), 'starter unlocks winter wool_overcoat');
  ok(!bridge.isGarmentUnlocked('trench_coat', 'outerwear', starterUnlocked), 'trench_coat locked before buying Everyday Riverside Ensemble');

  const bought = bridge.resolveUnlockedWardrobe({
    ownedObjects: [{ sku: 'sku_outfit_student2' }],
    unlockedOutfits: ['gemini', 'geminiSport'],
  });
  ok(bridge.isGarmentUnlocked('trench_coat', 'outerwear', bought), 'buying gemini unlocks trench_coat');
  ok(bridge.isGarmentUnlocked('jacket', 'outerwear', bought), 'buying sku_outfit_student2 unlocks jacket');
  ok(bridge.isGarmentUnlocked('headphones', 'accessory', bought), 'buying geminiSport unlocks headphones');
  eq(bought.unlockedPresets.length, 3, 'all 3 clothing_shop outfits unlocked');

  // Equip onto Lyra & Kai preserving sculpted face/body/hair
  const customLyra = creator.randomizeProfile('equip-test-lyra', 'LYRA');
  const eqSport = bridge.equipClothingSkuOnProfile(customLyra, 'sku_outfit_gemini_sport');
  ok(eqSport.ok && eqSport.appliedSlot === 'sportswear', 'equipping sku_outfit_gemini_sport equips sportswear slot');
  eq(eqSport.profile.activeOutfitSlot, 'sportswear', 'activeOutfitSlot switches to sportswear');
  eq(eqSport.profile.outfits.sportswear.top, 'hoodie', 'equipped sportswear uses hoodie');
  eq(eqSport.profile.hairId, customLyra.hairId, 'equip preserves custom hair');
  assert.deepEqual(eqSport.profile.faceMorphs, customLyra.faceMorphs, 'equip preserves 20 face morphs');

  const customKai = creator.randomizeProfile('equip-test-kai', 'KAI');
  const eqFormal = bridge.equipClothingSkuOnProfile(customKai, 'gemini');
  ok(eqFormal.ok && eqFormal.profile.outfits.formal.outerwear === 'trench_coat', 'Kai equips trench_coat from gemini outfit');
}

// ── 7. Clean English, Zero Ampersand, Zero Sparkles, Zero Forbidden APIs Compliance Scan ─────────────────
{
  const VN_RE = /[ăâđêôơưĂÂĐÊÔƠƯáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵÁÀẢÃẠẤẦẨẪẬẮẰẲẴẶÉÈẺẼẸẾỀỂỄỆÍÌỈĨỊÓÒỎÕỌỐỒỔỖỘỚỜỞỠỢÚÙỦŨỤỨỪỬỮỰÝỲỶỸỴ]/;
  const LITERAL_RE = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  const WORD_AMP_RE = /[^\W\d_)] (?:&|&amp;) [^\W\d_(]/u;
  const SPARKLE_TAG = '<' + 'Sparkles';
  const SPARKLE_EMOJI = '\u2728';
  const FORBIDDEN_RE = /\beval\s*\(|\bnew\s+Function\b|\bSharedArrayBuffer\b|\bfetch\s*\(/;

  const filesToScan = [
    path.join(SRC, 'lib/avatar/characterCreator.ts'),
    path.join(SRC, 'lib/echo-life/game/playerMind.ts'),
    path.join(SRC, 'lib/echo-life/game/cookingSim.ts'),
    path.join(SRC, 'lib/echo-life/game/careerSim.ts'),
    path.join(SRC, 'lib/echo-life/game/phoneSim.ts'),
    path.join(SRC, 'lib/echo-life/game/wardrobeBridge.ts'),
  ];

  for (const abs of filesToScan) {
    const raw = fs.readFileSync(abs, 'utf8');
    const rel = path.relative(ROOT, abs);
    ok(!VN_RE.test(raw), `${rel}: zero Vietnamese or accented characters`);
    ok(!raw.includes(SPARKLE_TAG) && !raw.includes(SPARKLE_EMOJI), `${rel}: zero Sparkles tag or emoji`);
    ok(!FORBIDDEN_RE.test(raw), `${rel}: zero eval / new Function / SharedArrayBuffer / fetch`);

    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
      for (const match of line.matchAll(LITERAL_RE)) {
        ok(!WORD_AMP_RE.test(match[0]), `${rel}:${i + 1}: no ampersand in string literal (${match[0]})`);
      }
    }
  }
}

console.log(`PASS echo-life wave11 core modules (${checks} assertions, 6 TS modules verified, 0 VN / 0 ampersand / 0 Sparkles)`);
