// Echo Life Total Rebirth (A06) — Standalone Verification Suite for Autonomous NPC Mind,
// Emergent Social Graph, 30-Zone Zero-Teleport Tier 2 Spine Traversal, Persistence & CPU Budget.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const src = fileURLToPath(new URL('../src/', import.meta.url));
const cache = new Map();

function resolve(from, n) {
  return n.startsWith('@/') ? n.slice(2) : path.posix.normalize(path.posix.dirname(from) + '/' + n);
}

function load(rel) {
  if (rel.endsWith('.mjs') || rel.endsWith('.json')) return require(path.join(src, rel));
  if (cache.has(rel)) return cache.get(rel);
  const m = { exports: {} };
  cache.set(rel, m.exports);
  const code = babel.core().transformSync(fs.readFileSync(path.join(src, rel), 'utf8'), {
    filename: rel,
    babelrc: false,
    configFile: false,
    presets: [babel.presetTypescript()],
    plugins: [babel.pluginTransformModulesCommonjs()],
  }).code;
  new Function('module', 'exports', 'require', code)(m, m.exports, n => {
    const r = resolve(rel, n);
    return load(/\.(mjs|json)$/.test(r) ? r : r + '.ts');
  });
  return m.exports;
}

const { housePlan } = load('lib/echo-life/plan.ts');
const { cityPlan } = load('lib/echo-life/city.ts');
const { V3_ZONE_IDS } = load('lib/echo-life/zones.ts');
const { LifeNav } = load('lib/echo-life/game/nav.ts');
const V3 = load('lib/echo-life/v3/game-core/index.mjs');
const {
  RESIDENT_IDS,
  RESIDENT_PROFILES,
  NpcMindEngine,
  envSnapshotFromV3,
  hasHardV3Lock,
} = load('lib/echo-life/game/npcMind.ts');
const { SocialSimEngine } = load('lib/echo-life/game/socialSim.ts');
const {
  ZoneTravelGraph,
  resolveSimulationTier,
} = load('lib/echo-life/game/zoneGraph.ts');

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

// ── 1. All 22 V3 Resident Profiles & Determinism ────────────────────────────────────────────────────────
ok(RESIDENT_IDS.length === 22, 'exactly 22 resident IDs registered');
for (const id of V3.CHARACTER_IDS) {
  const p = RESIDENT_PROFILES[id];
  ok(Boolean(p), `profile exists for V3 resident ${id}`);
  for (const k of ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'calmness']) {
    ok(p.traits[k] >= 0 && p.traits[k] <= 1, `${id}.traits.${k} in [0, 1]`);
  }
  ok(p.rainTolerance >= 0 && p.rainTolerance <= 1, `${id}.rainTolerance in [0, 1]`);
  ok(p.peakHour >= 0 && p.peakHour <= 23, `${id}.peakHour in [0, 23]`);
  ok(p.thirdPlaces.length >= 2, `${id} has >= 2 third places`);
  for (const z of p.thirdPlaces) {
    ok(V3_ZONE_IDS.includes(z) && z !== 'study', `${id} thirdPlace ${z} is a valid public V3 zone`);
  }
}

{
  const sA = V3.createGame('u42');
  const sB = V3.createGame('u42');
  sA.seed = sB.seed = 1337;
  const mA = new NpcMindEngine();
  const mB = new NpcMindEngine();
  mA.init(sA);
  mB.init(sB);
  ok(
    JSON.stringify(mA.exportSnapshot()) === JSON.stringify(mB.exportSnapshot()),
    'mind initialization is 100% deterministic for identical seed + state',
  );
}

// ── 2. Needs Decay/Recovery, Mood Transitions & Goal Hysteresis ─────────────────────────────────────────
{
  const s = V3.createGame('u42');
  s.clock = 2 * 1440 + 10 * 60; // Day 2 10:00 (past Day 0 onboarding anchor)
  s.day = 2;
  const mind = new NpcMindEngine();
  mind.init(s);

  const envDry = envSnapshotFromV3(s, { weatherId: 'sunny', rainIntensity: 0, snowIntensity: 0, hour: 10, phase: 'morning' });
  for (let h = 0; h < 12; h++) {
    s.clock += 60;
    for (const id of RESIDENT_IDS) {
      mind.advanceNeedsAndMood(id, 60, {
        env: { ...envDry, hour: (10 + h) % 24 },
        zone: 'street',
        activity: 'idle',
        outdoor: true,
        seated: false,
        inSocialGroup: false,
        inWorldEvent: false,
        clock: s.clock,
      });
      const n = mind.minds.get(id).needs;
      for (const key of ['energy', 'hunger', 'social', 'focus', 'fun', 'comfort']) {
        assert.ok(Number.isFinite(n[key]) && n[key] >= 0 && n[key] <= 100, `${id}.${key} stayed finite & clamped [0..100]`);
      }
    }
  }
  checks++;

  // Tired mood check
  const mMinh = mind.minds.get('minh');
  mMinh.needs.energy = 18;
  mMinh.moodLockedUntilClock = 0;
  mind.advanceNeedsAndMood('minh', 1, {
    env: envDry,
    zone: 'park',
    activity: 'idle',
    outdoor: true,
    seated: false,
    inSocialGroup: false,
    inWorldEvent: false,
    clock: s.clock,
  });
  ok(mMinh.mood === 'tired', 'low energy transitions mood to tired');

  // Sheltering mood check in heavy rain
  const envStorm = envSnapshotFromV3(s, { weatherId: 'heavy_rain', rainIntensity: 1.0, snowIntensity: 0 });
  mMinh.needs.comfort = 30;
  mind.advanceNeedsAndMood('minh', 5, {
    env: envStorm,
    zone: 'park',
    activity: 'idle',
    outdoor: true,
    seated: false,
    inSocialGroup: false,
    inWorldEvent: false,
    clock: s.clock + 5,
  });
  ok(mMinh.mood === 'sheltering', 'heavy rain + low comfort immediately overrides mood to sheltering');

  // Goal hysteresis + 20 game-min minimum dwell
  const mKim = mind.minds.get('kimngan');
  mKim.needs.energy = 80;
  mKim.needs.hunger = 12; // strong hunger urgency -> commits SATISFY_HUNGER
  mKim.lastBreakClock = -999;
  const g1 = mind.evaluateGoal(s, 'kimngan', {
    env: envDry,
    pos: { x: 0, z: 0 },
    zone: 'street',
    outdoor: true,
    talkingId: null,
    v3SceneLocked: false,
    hasCompatibleFriendInZone: false,
    hasFreeSeatInZone: true,
  });
  ok(g1.kind === 'SATISFY_HUNGER', `very hungry resident picks SATISFY_HUNGER (got ${g1.kind})`);
  // 5 game minutes later, hunger nudges higher (32) — dwell + hysteresis must prevent thrashing!
  s.clock += 5;
  mKim.needs.hunger = 32;
  const g2 = mind.evaluateGoal(s, 'kimngan', {
    env: envDry,
    pos: { x: 0, z: 0 },
    zone: 'street',
    outdoor: true,
    talkingId: null,
    v3SceneLocked: false,
    hasCompatibleFriendInZone: false,
    hasFreeSeatInZone: true,
  });
  ok(g2.kind === 'SATISFY_HUNGER', 'minimum dwell + hysteresis prevents goal thrashing');
}

// ── 3. Layer 0 Hard V3 Narrative Lock Safety ────────────────────────────────────────────────────────────
{
  const s = V3.createGame('u42');
  s.clock = 3 * 1440 + 11 * 60;
  s.day = 3;
  const mind = new NpcMindEngine();
  mind.init(s);
  const storm = envSnapshotFromV3(s, { weatherId: 'heavy_rain', rainIntensity: 1.0, snowIntensity: 0 });

  // Force extreme needs on Linh while Tutorial Step 3 is active
  s.worldV3.tutorial.completed = false;
  s.worldV3.tutorial.skipped = false;
  s.worldV3.tutorial.stepIndex = 2;
  mind.minds.get('linh').needs = { energy: 5, hunger: 5, social: 5, focus: 5, fun: 5, comfort: 5 };
  const tutGoal = mind.evaluateGoal(s, 'linh', {
    env: storm, pos: { x: 0, z: 0 }, zone: 'street', outdoor: true,
    talkingId: null, v3SceneLocked: false, hasCompatibleFriendInZone: false, hasFreeSeatInZone: false,
  });
  ok(tutGoal.kind === 'V3_HARD_LOCK' && tutGoal.zone === 'living', 'Tutorial Step 3 locks Linh in living room even under storm + extreme needs');

  // Complete tutorial & test hostedGuest lock
  s.worldV3.tutorial.completed = true;
  s.worldV3.hostedGuest = { npcId: 'huy', zone: 'living', untilClock: s.clock + 120 };
  mind.minds.get('huy').needs = { energy: 5, hunger: 5, social: 5, focus: 5, fun: 5, comfort: 5 };
  const guestGoal = mind.evaluateGoal(s, 'huy', {
    env: storm, pos: { x: 0, z: 0 }, zone: 'cafe', outdoor: false,
    talkingId: null, v3SceneLocked: false, hasCompatibleFriendInZone: false, hasFreeSeatInZone: false,
  });
  ok(guestGoal.kind === 'V3_HARD_LOCK' && guestGoal.zone === 'living', 'hostedGuest locks Huy to living room');
  s.worldV3.hostedGuest = null;

  // Active main mission `hello` (`talk-linh` after `tidy` & `breakfast`)
  s.done = ['tidy', 'breakfast'];
  ok(hasHardV3Lock(s, 'linh', null, false), 'active main mission `hello` locks Linh');

  // Started side quest stage waiting on An Chi
  s.worldV3.sideQuests.sq_missing_folio = { started: true, stage: 0, done: false };
  ok(hasHardV3Lock(s, 'anchi', null, false), 'started side quest stage locks lead NPC An Chi');

  // Chapter 5 festival climax lock
  s.done.push('supplies');
  for (const cid of ['linh', 'minh', 'huy', 'mai', 'lan', 'thaovy']) {
    const fg = mind.evaluateGoal(s, cid, {
      env: storm, pos: { x: 0, z: 0 }, zone: 'street', outdoor: true,
      talkingId: null, v3SceneLocked: false, hasCompatibleFriendInZone: false, hasFreeSeatInZone: false,
    });
    ok(fg.kind === 'V3_HARD_LOCK' && fg.zone === 'campus', `Chapter 5 festival locks ${cid} at campus`);
  }
}

// ── 4. Weather, Rain-Lover Differentiation & Awning Shelter ─────────────────────────────────────────────
{
  const s = V3.createGame('u42');
  s.worldV3.tutorial.completed = true;
  s.done = ['tidy', 'breakfast', 'hello', 'shop', 'dinner', 'pixel', 'plan', 'materials', 'advice', 'routine', 'sports', 'help'];
  s.sandbox = true;
  s.clock = 2 * 1440 + 13 * 60; // Day 2 (Wed) 13:00 — normal weekday, no active festival event for kimngan/diemmy
  s.day = 2;

  const mind = new NpcMindEngine();
  mind.init(s, [{ id: 'shelter_bus', zone: 'street', x: 6, z: 4 }]);

  const lightRain = envSnapshotFromV3(s, { weatherId: 'light_rain', rainIntensity: 0.65, snowIntensity: 0, hour: 13, phase: 'afternoon' });
  const heavyRain = envSnapshotFromV3(s, { weatherId: 'heavy_rain', rainIntensity: 1.0, snowIntensity: 0, hour: 13, phase: 'afternoon' });

  // Low rain tolerance (`kimngan` 0.20) vs high rain-lover (`diemmy` 0.82) outdoors in light rain
  mind.minds.get('kimngan').needs.comfort = 52;
  mind.minds.get('diemmy').needs.comfort = 82;
  const gKimLight = mind.evaluateGoal(s, 'kimngan', {
    env: lightRain, pos: { x: 10, z: 4 }, zone: 'street', outdoor: true,
    talkingId: null, v3SceneLocked: false, hasCompatibleFriendInZone: false, hasFreeSeatInZone: false,
  });
  const gDiemLight = mind.evaluateGoal(s, 'diemmy', {
    env: lightRain, pos: { x: 10, z: 4 }, zone: 'botanical', outdoor: true,
    talkingId: null, v3SceneLocked: false, hasCompatibleFriendInZone: false, hasFreeSeatInZone: false,
  });
  ok(gKimLight.kind === 'SEEK_SHELTER' && Boolean(gKimLight.shelterSpot), 'low rain-tolerance resident seeks nearby covered shelter in light rain');
  ok(gDiemLight.kind !== 'SEEK_SHELTER', 'high-openness rain-lover lingers under umbrella in light rain');
  ok(mind.shouldHoldUmbrella('diemmy', lightRain, true, false), 'outdoor rain-lover deploys umbrella in light rain');

  // Heavy rain sends even rain-lover indoors to rainFallback (`atelier`)
  mind.minds.get('diemmy').needs.comfort = 28;
  const gDiemHeavy = mind.evaluateGoal(s, 'diemmy', {
    env: heavyRain, pos: { x: 10, z: 4 }, zone: 'botanical', outdoor: true,
    talkingId: null, v3SceneLocked: false, hasCompatibleFriendInZone: false, hasFreeSeatInZone: false,
  });
  ok(gDiemHeavy.kind === 'SEEK_SHELTER' && gDiemHeavy.zone === 'atelier' && !gDiemHeavy.shelterSpot, 'heavy rain moves even rain-lover indoors to rainFallback (atelier)');
}

// ── 5. Layer 1 Stimuli & Player Awareness (Approach, Horn, Basketball) ──────────────────────────────────
{
  const s = V3.createGame('u42');
  s.npcs.linh.rel.friendship = 55;
  s.npcs.minh.rel.friendship = 45;
  s.npcs.thaovy.rel.friendship = 10;
  const mind = new NpcMindEngine();
  mind.init(s);
  const env = envSnapshotFromV3(s);

  // Friend approach within 4 m
  const rGreet = mind.evaluateStimuli(s, 'linh', {
    pos: { x: 0, z: 0 }, zone: 'street', seated: false, outdoor: true,
    player: { x: 3.2, z: 0 }, playerVehicle: null, env, elapsed: 10, stimuli: [],
  });
  ok(rGreet?.kind === 'greet' && Boolean(rGreet.quip), 'friend within 4.5 m greets player with contextual quip');
  ok(mind.minds.get('linh').stm.some(m => m.kind === 'player_greet'), 'approach greeting logged in STM');

  // Horn reaction: shy Thao Vy startles, calm friend Minh waves
  const horn = { kind: 'horn', x: 5, z: 0, yaw: 0, elapsed: 20, vehicleName: 'Lotus Spider' };
  const rThao = mind.evaluateStimuli(s, 'thaovy', {
    pos: { x: 0, z: 0 }, zone: 'street', seated: false, outdoor: true,
    player: { x: 5, z: 0 }, env, elapsed: 20.1, stimuli: [horn],
  });
  const rMinh = mind.evaluateStimuli(s, 'minh', {
    pos: { x: 0, z: 0 }, zone: 'street', seated: false, outdoor: true,
    player: { x: 5, z: 0 }, env, elapsed: 20.1, stimuli: [horn],
  });
  ok(rThao?.kind === 'horn_startle', 'low-calmness resident startles on car horn');
  ok(rMinh?.kind === 'horn_wave', 'calm friend waves enthusiastically on car horn');

  // Basketball score streak reaction -> cheer + fun boost + LTM promotion
  const scoreStim = { kind: 'basketball_score', x: 6, z: 2, streak: 3, elapsed: 30 };
  const funBefore = mind.minds.get('minh').needs.fun;
  const rCheer = mind.evaluateStimuli(s, 'minh', {
    pos: { x: 0, z: 0 }, zone: 'park', seated: false, outdoor: true,
    player: { x: 6, z: 2 }, env, elapsed: 30.2, stimuli: [scoreStim],
  });
  ok(rCheer?.kind === 'cheer_basket' && Boolean(rCheer.quip?.includes('3')), 'Minh cheers player 3-streak basket');
  ok(mind.minds.get('minh').needs.fun > funBefore, 'watching scored basket increases resident fun');
  ok(mind.minds.get('minh').ltm.some(m => m.kind === 'player_basketball'), 'high-salience streak promoted to LTM');
}

// ── 6. Persistence Round-Trip through V3.decode() & Compact Payload Bound ───────────────────────────────
{
  const s = V3.createGame('u77');
  V3.adjustRelationship(s, 'linh', { friendship: 12 }, { type: 'loved_gift', detail: 'gifted matcha crepe' });
  const mind = new NpcMindEngine();
  mind.init(s);
  for (let i = 0; i < 20; i++) {
    mind.recordMemory('linh', {
      kind: 'player_talk',
      day: i,
      clock: i * 1440 + 600,
      subject: `chat_${i}`,
      valence: 0.6,
      salience: 0.8,
    }, true);
  }
  ok(mind.minds.get('linh').stm.length <= 8, 'STM ring buffer bounded to <= 8 entries');
  ok(mind.minds.get('linh').ltm.length <= 16, 'LTM ring buffer bounded to <= 16 entries');

  const social = new SocialSimEngine();
  social.init(s);
  social.adjustAffinity('linh', 'khanhha', 6);
  const snap = mind.exportSnapshot(social.exportAffinityDeltas());
  const snapBytes = Buffer.byteLength(JSON.stringify(snap), 'utf8');
  ok(snapBytes < 6500, `npcSim snapshot compact (${snapBytes} bytes < 6500 bytes)`);

  // Inject into s.worldV3.npcSim and pass verbatim through vendored V3.decode()!
  s.worldV3.npcSim = snap;
  const decoded = V3.decode(JSON.stringify(s), 'u77');
  ok(decoded.worldV3?.npcSim?.v === 1, 'V3.decode() preserves worldV3.npcSim verbatim');

  const mindReloaded = new NpcMindEngine();
  mindReloaded.init(decoded);
  const socialReloaded = new SocialSimEngine();
  socialReloaded.init(decoded, decoded.worldV3.npcSim.aff);
  ok(
    mindReloaded.minds.get('linh').ltm.length === mind.minds.get('linh').ltm.length,
    'LTM survives full V3 save round-trip without loss',
  );
  ok(
    socialReloaded.getAffinity('linh', 'khanhha') === social.getAffinity('linh', 'khanhha'),
    'pairwise affinity deltas survive full V3 save round-trip',
  );
}

// ── 7. Real World Setup (6 m house + 31-zone city + LifeNav) ────────────────────────────────────────────
const house = housePlan(6);
const city = cityPlan(house);
const nav = new LifeNav(house, city);
while (!nav.warm(1e9)) { /* warm all edges for deterministic test */ }

// ── 8. Emergent 2–3 Resident Social Clustering, Formation & Overheard Banter ────────────────────────────
{
  const s = V3.createGame('u88');
  const mind = new NpcMindEngine();
  mind.init(s);
  const social = new SocialSimEngine();
  social.init(s);

  // Check lore-accurate initial affinity graph
  ok(social.getAffinity('linh', 'thaovy') >= 55, 'connected friends Linh & Thao Vy start with high affinity');
  ok(social.getAffinity('huy', 'baolong') >= 55, 'connected friends Huy & Bao Long start with high affinity');
  ok(social.getAffinity('hoangphuc', 'linh') < social.getAffinity('linh', 'thaovy'), 'Hoang Phuc starts more guarded toward Linh');

  // Place 3 compatible residents in Riverside Park open walkable spots (no V3 scene locks)
  const spots = nav.spots('park', 6);
  ok(spots.length >= 4, 'park provides >= 4 walkable spots');
  for (const id of ['linh', 'khanhha', 'anchi']) {
    mind.minds.get(id).needs.social = 40;
    mind.minds.get(id).needs.energy = 80;
  }
  const participants = [
    { id: 'linh', x: spots[0].x, z: spots[0].z, yaw: 0, zone: 'park', moving: false, seated: false, seatId: null, v3SceneLocked: false, talking: false },
    { id: 'khanhha', x: spots[1].x, z: spots[1].z, yaw: 0, zone: 'park', moving: false, seated: false, seatId: null, v3SceneLocked: false, talking: false },
    { id: 'anchi', x: spots[2].x, z: spots[2].z, yaw: 0, zone: 'park', moving: false, seated: false, seatId: null, v3SceneLocked: false, talking: false },
    // V3-locked actor MUST NOT be pulled into emergent group
    { id: 'minh', x: spots[3].x, z: spots[3].z, yaw: 0, zone: 'park', moving: false, seated: false, seatId: null, v3SceneLocked: true, talking: false },
  ];

  const env = envSnapshotFromV3(s);
  const dirs0 = social.step(s, nav, mind, participants, env, 100);
  ok(social.groups.size === 1, `emergent group formed (${social.groups.size})`);
  const [group] = social.groups.values();
  ok(group.members.length === 3, `3-resident gathering formed (${group.members.join(', ')})`);
  ok(!group.members.includes('minh'), 'V3-locked resident never stolen into emergent group');

  // Every formation slot MUST be walkable and mutually separated >= 0.95 m
  const slotList = Object.values(group.slots);
  for (const sl of slotList) {
    ok(nav.walk.free(sl), `formation slot (${sl.x.toFixed(2)}, ${sl.z.toFixed(2)}) is on proven walkable floor`);
  }
  for (let i = 0; i < slotList.length; i++) {
    for (let j = i + 1; j < slotList.length; j++) {
      const sep = Math.hypot(slotList[i].x - slotList[j].x, slotList[i].z - slotList[j].z);
      ok(sep >= 0.95, `formation pairwise separation >= 0.95 m (${sep.toFixed(2)} m)`);
    }
  }

  // Proximity-gated overheard banter (< 7.5 m only, suppressed when moving fast)
  const nearPlayer = { x: group.center.x + 3.0, z: group.center.z };
  const farPlayer = { x: group.center.x + 12.0, z: group.center.z };
  const banterNear = social.overheardBanterNear(nearPlayer, 'park', 0.5, 100.5);
  const banterFar = social.overheardBanterNear(farPlayer, 'park', 0.5, 100.5);
  const banterFast = social.overheardBanterNear(nearPlayer, 'park', 3.5, 100.5);
  ok(Boolean(banterNear && banterNear.text.length > 8), `overheard banter active within 7.5 m ("${banterNear?.text}")`);
  ok(banterFar === null, 'overheard banter suppressed beyond 7.5 m');
  ok(banterFast === null, 'overheard banter suppressed when player moves > 2.0 m/s');

  // Advance 18 s: speaker baton rotates & pairwise affinity grows by +2
  const firstSpeaker = group.speakerIndex;
  const affBefore = social.getAffinity('linh', 'khanhha');
  let speakerRotated = false;
  for (let t = 101; t <= 118; t++) {
    social.step(s, nav, mind, participants, env, t);
    if (group.speakerIndex !== firstSpeaker) speakerRotated = true;
  }
  ok(speakerRotated, 'speaker baton rotated naturally among group members');
  ok(social.getAffinity('linh', 'khanhha') === affBefore + 2, 'completed emergent gathering increments pairwise affinity by +2');
  ok(dirs0.size === 3, 'choreography directives emitted for all 3 members');
}

// ── 9. 3-Tier Distance LOD Hysteresis & Zero-Teleport Tier 2 -> Tier 0 Handover ─────────────────────────
{
  ok(resolveSimulationTier(2, 34, false, false) === 0, 'enters Tier 0 at < 35 m');
  ok(resolveSimulationTier(0, 41, false, false) === 0, 'hysteresis holds Tier 0 up to 43 m');
  ok(resolveSimulationTier(0, 44, false, false) === 1, 'exits Tier 0 to Tier 1 above 43 m');
  ok(resolveSimulationTier(1, 120, false, false) === 1, 'hysteresis holds Tier 1 up to 122 m');
  ok(resolveSimulationTier(1, 123, false, false) === 2, 'exits Tier 1 to Tier 2 above 122 m');
  ok(resolveSimulationTier(2, 109, false, false) === 1, 'promotes Tier 2 to Tier 1 at <= 110 m');
  ok(resolveSimulationTier(2, 200, true, false) === 0, 'same zone always promotes to Tier 0');
  ok(resolveSimulationTier(2, 200, false, true) === 0, 'talking resident always promotes to Tier 0');

  const graph = new ZoneTravelGraph(nav);
  while (!graph.warmStep(10)) { /* bake all 38 undirected zone spines */ }
  ok(graph.warmed && graph.stats.bakedEdges >= 60, `30-zone travel graph baked (${graph.stats.bakedEdges} directed edges)`);

  // Verify every single public zone is reachable via planZoneHops from hall
  for (const z of V3_ZONE_IDS) {
    if (z === 'study') continue;
    const hops = graph.planZoneHops('hall', z);
    ok(Array.isArray(hops) && hops[0] === 'hall' && hops[hops.length - 1] === z, `zoneGraph path hall -> ${z} (${hops?.length} hops)`);
  }

  // Test long cross-city Tier 2 trip (botanical -> lantern_garden) starting from an off-anchor spot
  const routesBefore = nav.stats.routes;
  const botSpots = nav.spots('botanical', 4);
  const lgSpots = nav.spots('lantern_garden', 4);
  const startPos = botSpots[2] ?? botSpots[0];
  const destPos = lgSpots[1] ?? lgSpots[0];

  const trip = graph.startTrip(startPos, 'botanical', 'lantern_garden', destPos, false);
  ok(Boolean(trip), 'Tier 2 cross-city AbstractTrip created without fresh A* bake');
  ok(nav.stats.routes === routesBefore, 'warmed Tier 2 trip consumed ZERO A* route searches');

  // Verify 0.00 m jump at start
  const p0 = graph.samplePoint(trip.edges[0], 0);
  ok(Math.hypot(p0.x - startPos.x, p0.z - startPos.z) < 1e-6, 'Tier 2 trip starts at exact resident position (0.00 m jump)');

  // Step halfway at 0.5 Hz (2.56 m per tick) with simulated swinging doors
  const doorState = new Map();
  const mockDoors = {
    door: id => {
      let st = doorState.get(id);
      if (!st) { st = { open: false, angle: 0 }; doorState.set(id, st); }
      return {
        get passable() { return st.angle > 0.95; },
        get isOpen() { return st.open; },
        prepare() {},
        setOpen(o) { st.open = o; },
      };
    },
  };

  let curPos = { ...startPos };
  let openedDoor = null;
  let closedViolations = 0;
  for (let step = 0; step < 30; step++) {
    for (const st of doorState.values()) st.angle = Math.max(0, Math.min(1.4, st.angle + (st.open ? 0.5 : -0.5)));
    const res = graph.advanceTrip(trip, 2.56, mockDoors, openedDoor);
    openedDoor = res.openedDoor;
    if (res.closeBehindDoor) mockDoors.door(res.closeBehindDoor.door).setOpen(false);
    curPos = { x: res.x, z: res.z };
    assert.ok(nav.walk.free(curPos), `Tier 2 step ${step} off floor at ${curPos.x.toFixed(2)},${curPos.z.toFixed(2)}`);
    for (const d of nav.doors) {
      const st = doorState.get(d.id);
      if (st && st.angle <= 0.95 && curPos.x >= d.corridor.x0 && curPos.x <= d.corridor.x1 && curPos.z >= d.corridor.z0 && curPos.z <= d.corridor.z1) {
        closedViolations++;
      }
    }
    if (res.arrived) break;
  }
  checks++;
  ok(closedViolations === 0, 'Tier 2 never steps inside a closed door corridor');

  // Mid-trip promotion handoff (Tier 2 -> Tier 0): verify ZERO teleport & walkable remaining route!
  const beforeHandoff = { ...curPos };
  const route = graph.handoffToRoute(trip, curPos);
  ok(route.points.length >= 1, `handoffToRoute produced ${route.points.length} continuous remaining waypoints`);
  ok(Math.hypot(beforeHandoff.x - curPos.x, beforeHandoff.z - curPos.z) === 0, 'Tier 2 -> Tier 0 handoff has exact 0.00 m teleport delta');
  for (const pt of route.points) {
    assert.ok(nav.walk.free(pt), `handoff route point (${pt.x.toFixed(2)}, ${pt.z.toFixed(2)}) is on walkable floor`);
  }
  checks++;
  const finalPt = route.points[route.points.length - 1];
  ok(nav.walk.zone(finalPt) === 'lantern_garden', 'handoff route ends cleanly inside destination zone lantern_garden');
}

// ── 10. Static Zero-LLM/Network Guard (AGENTS §17) ──────────────────────────────────────────────────────
for (const file of ['lib/echo-life/game/npcMind.ts', 'lib/echo-life/game/socialSim.ts', 'lib/echo-life/game/zoneGraph.ts']) {
  const txt = fs.readFileSync(path.join(src, file), 'utf8');
  const forbidden = /\b(fetch\s*\(|apiClient|axios|XMLHttpRequest|openai|gemini|\/api\/)/i;
  ok(!forbidden.test(txt), `${file} has ZERO network/LLM API calls (AGENTS §17)`);
}

// ── 11. Performance Micro-Benchmark (< 0.40 ms/frame steady-state across all 22 residents) ──────────────
{
  const s = V3.createGame('u99');
  s.worldV3.tutorial.completed = true;
  s.clock = 2 * 1440 + 14 * 60;
  s.day = 2;
  const mind = new NpcMindEngine();
  mind.init(s);
  const social = new SocialSimEngine();
  social.init(s);
  const graph = new ZoneTravelGraph(nav);
  while (!graph.warmStep(10)) { /* pre-warm */ }

  // Build realistic 22-resident simulation load (6 T0, 8 T1, 8 T2 trips)
  const parkSpots = nav.spots('park', 8);
  const bistroSpots = nav.spots('bistro', 6);
  const streetSpots = nav.spots('street', 12);
  const activeTrips = new Map();
  const views = RESIDENT_IDS.map((id, i) => {
    const zone = i < 6 ? 'park' : i < 12 ? 'bistro' : 'street';
    const pool = zone === 'park' ? parkSpots : zone === 'bistro' ? bistroSpots : streetSpots;
    const p = pool[i % pool.length];
    if (i >= 14) {
      const targetZ = i % 2 === 0 ? 'campus' : 'lantern_garden';
      const dst = nav.spots(targetZ, 1)[0];
      const tr = graph.startTrip(p, zone, targetZ, dst, false);
      if (tr) activeTrips.set(id, tr);
    }
    return {
      id, x: p.x, z: p.z, yaw: 0, zone, moving: i >= 14,
      seated: false, seatId: null, v3SceneLocked: false, talking: false,
    };
  });

  const player = { x: parkSpots[0].x + 2.5, z: parkSpots[0].z };
  const env = envSnapshotFromV3(s);
  const samples = [];

  // 100 warm-up ticks for V8 JIT, then measure 1000 frames at 60 Hz (`dt = 1/60`)
  for (let frame = 0; frame < 1100; frame++) {
    const t0 = performance.now();
    const dt = 1 / 60;
    s.clock += dt * 0.5;
    const elapsed = frame * dt;

    // Staggered 0.5 Hz Utility AI (1 resident every ~5 frames -> 1–2 residents/frame max)
    const aiIdx = frame % RESIDENT_IDS.length;
    const aiId = RESIDENT_IDS[aiIdx];
    const vAi = views[aiIdx];
    mind.advanceNeedsAndMood(aiId, dt * 0.5 * 22, {
      env, zone: vAi.zone, activity: 'idle', outdoor: vAi.zone !== 'bistro',
      seated: false, inSocialGroup: false, inWorldEvent: false, clock: s.clock,
    });
    mind.evaluateGoal(s, aiId, {
      env, pos: vAi, zone: vAi.zone, outdoor: vAi.zone !== 'bistro',
      talkingId: null, v3SceneLocked: false, hasCompatibleFriendInZone: true, hasFreeSeatInZone: true,
    });

    // Tier 0 reflexes (6 nearby residents)
    for (let i = 0; i < 6; i++) {
      const v = views[i];
      mind.evaluateStimuli(s, v.id, {
        pos: v, zone: v.zone, seated: false, outdoor: true,
        player, env, elapsed, stimuli: [],
      });
    }

    // Tier 2 0.5 Hz abstract trip advancement (1 trip stepped every 15 frames)
    if (frame % 15 === 0) {
      const tripIdx = 14 + ((frame / 15) % 8);
      const id = RESIDENT_IDS[tripIdx];
      const tr = activeTrips.get(id);
      if (tr) {
        const stepRes = graph.advanceTrip(tr, 2.56, null, null);
        views[tripIdx].x = stepRes.x;
        views[tripIdx].z = stepRes.z;
        views[tripIdx].zone = stepRes.zone;
        if (stepRes.arrived) {
          const back = stepRes.zone === 'campus' ? 'street' : 'bistro';
          const dst = nav.spots(back, 1)[0];
          const next = graph.startTrip({ x: stepRes.x, z: stepRes.z }, stepRes.zone, back, dst, false);
          if (next) activeTrips.set(id, next);
        }
      }
    }

    // 2 Hz emergent social simulation
    if (frame % 30 === 0) {
      social.step(s, nav, mind, views, env, elapsed);
    }
    social.overheardBanterNear(player, 'park', 0.8, elapsed);

    const ms = performance.now() - t0;
    if (frame >= 100) samples.push(ms);
  }

  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const maxMs = samples[samples.length - 1];
  console.log(`npc-ai benchmark (1000 frames @ 60 Hz): p50=${p50.toFixed(4)}ms p95=${p95.toFixed(4)}ms max=${maxMs.toFixed(4)}ms`);
  ok(p50 < 0.20, `p50 frame simulation time < 0.20 ms (got ${p50.toFixed(4)} ms)`);
  ok(p95 < 0.40, `p95 frame simulation time < 0.40 ms (got ${p95.toFixed(4)} ms)`);
}

console.log(`echo-life npc-ai: ${checks} checks passed`);
