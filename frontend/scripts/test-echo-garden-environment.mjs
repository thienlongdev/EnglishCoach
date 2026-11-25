// Echo Garden — atmosphere, satellite islands, light rig and farm-composition contracts.
//
// The motion / lighting math lives in pixi-free modules (world/environment.ts, world/lightRig.ts),
// executed here directly through Node's TypeScript type stripping; the scene wiring is checked on
// the source; the composition is checked on the shared layout data.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../src/components/features/games/echo-garden/', import.meta.url);
const src = (p) => readFileSync(new URL(p, root), 'utf8');
const env = await import(new URL('world/environment.ts', root));
const rig = await import(new URL('world/lightRig.ts', root));
const layout = JSON.parse(src('world/echoGardenLayout.json'));
const manifest = JSON.parse(readFileSync(new URL('../public/garden/world/world_manifest.json', import.meta.url), 'utf8'));
const canvas = src('EchoGardenCanvas.tsx');
const atmosphere = src('world/atmosphere.ts');
const satellites = src('world/satellites.ts');
const lighting = src('world/lighting.ts');
const shadowLayer = src('world/shadowLayer.ts');
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
// Five modules live in the (workspace) route group since the routing change (docs/grammar/ROUTING.md): the address is the same, the folder is not.
const routeExists = (route) => existsSync(new URL(`../src/app${route}`, import.meta.url)) || existsSync(new URL(`../src/app/(workspace)${route}`, import.meta.url));

/* 1. Exactly three floating islands: one stable main island + two satellites ------------------ */
ok(Array.isArray(layout.satellites) && layout.satellites.length === 2, 'exactly two satellite islands');
ok(!('islets' in layout), 'the retired islets list is gone (no third satellite)');
ok(new Set(layout.satellites.map((s) => s.id)).size === 2 && new Set(layout.satellites.map((s) => s.key)).size === 2, 'distinct satellites');
for (const s of layout.satellites) {
  ok(manifest.sprites[s.key], `satellite sprite ${s.key} exported`);
  ok(s.depth > 0 && s.depth < 1, `${s.id} floats behind the main island plane (depth < 1)`);
  ok(s.scale < 1, `${s.id} is smaller than the main island`);
  ok(Math.abs(s.base[0]) > 1300, `${s.id} sits beside the main island, not on it`);
}
ok(layout.satellites[0].depth !== layout.satellites[1].depth, 'satellites have different parallax depths');
ok(/new SatelliteController\(LAYOUT\.satellites/.test(canvas), 'satellites come from the layout config');
ok(/depthLayers\.forEach\(\(d\) => scene\.addChild\(d\.c\)\)/.test(canvas), 'satellites + cloud layers are siblings of the main island in the scene');
ok(!/world\.addChild\([^)]*(satellite|cloud|sat\b)/i.test(canvas), 'nothing atmospheric is a child of the main island');
ok(/applyDepth\(world, view, 1\)/.test(canvas), 'the main island is a depth-1 layer driven only by the camera');
ok(/applyDepth\(it\.root, v, it\.cfg\.depth\)/.test(satellites), 'each satellite applies its own depth transform');
ok(/key\.startsWith\("islet_"\)\) return;/.test(canvas), 'retired islet sprites are never loaded');

/* 2. Satellite motion: bounded, continuous, independent, reproducible ------------------------ */
const [A, B] = layout.satellites;
let maxStep = 0;
let sameDir = 0;
let prevA = env.satelliteOffset(A, 0);
let prevB = env.satelliteOffset(B, 0);
for (let i = 1; i <= 60 * 600; i++) { // 10 minutes at 60 fps
  const t = i / 60;
  const a = env.satelliteOffset(A, t);
  const b = env.satelliteOffset(B, t);
  ok(Math.abs(a.x - A.base[0]) <= A.drift.x + 1e-6 && Math.abs(a.y - A.base[1]) <= A.drift.y + A.bob.amp + 1e-6, 'A stays inside its bounds');
  ok(Math.abs(b.x - B.base[0]) <= B.drift.x + 1e-6 && Math.abs(b.y - B.base[1]) <= B.drift.y + B.bob.amp + 1e-6, 'B stays inside its bounds');
  maxStep = Math.max(maxStep, Math.hypot(a.x - prevA.x, a.y - prevA.y), Math.hypot(b.x - prevB.x, b.y - prevB.y));
  if (Math.sign(a.x - prevA.x) === Math.sign(b.x - prevB.x) && Math.sign(a.y - prevA.y) === Math.sign(b.y - prevB.y)) sameDir++;
  prevA = a;
  prevB = b;
}
ok(maxStep < 0.5, `satellites never jump between frames (max ${maxStep.toFixed(3)} px / frame)`);
ok(sameDir / (60 * 600) < 0.6, 'the two satellites do not move in sync');
ok(JSON.stringify(env.satelliteOffset(A, 123.4)) === JSON.stringify(env.satelliteOffset(A, 123.4)), 'motion is a pure function of time');

/* 3. Wind + clouds: continuous drift, concealed recycling ------------------------------------- */
for (let t = 0; t < 900; t += 0.5) {
  ok(env.Wind.speed(t) > 0.5 && env.Wind.speed(t) < 1.5, 'wind speed stays gentle and positive');
  const d = (env.Wind.distance(t + 0.01) - env.Wind.distance(t)) / 0.01;
  ok(Math.abs(d - env.Wind.speed(t)) < 0.01, 'drift distance is the exact integral of the wind (no accumulation)');
}
ok(Math.abs(env.Wind.distance(0)) < 1e-9, 'drift starts at 0');
const span = 5000;
for (let x = -20000; x <= 20000; x += 37) {
  const w = env.wrapWindow(x, span);
  ok(w >= -span / 2 && w < span / 2, 'wrap stays inside the window');
}
ok(env.windowFade(span / 2, span) === 0 && env.windowFade(-span / 2, span) === 0, 'a cloud is fully faded at the wrap seam');
ok(env.windowFade(0, span) === 1 && env.windowFade(0.3 * span, span) === 1, 'clouds are fully visible across the view');
ok((layout.atmosphere?.layers ?? []).length >= 4, 'four or more cloud layers');
ok(new Set(layout.atmosphere.layers.map((l) => l.depth)).size === layout.atmosphere.layers.length, 'every cloud layer has its own depth');
ok(layout.atmosphere.layers.some((l) => l.depth < 0.3) && layout.atmosphere.layers.some((l) => l.depth > 1), 'far sky and near foreground layers exist');
ok(/applyDepth\(this\.root, v, this\.cfg\.depth\)/.test(atmosphere), 'cloud layers compute their own camera-relative transform');
ok(/Wind\.distance\(t\)/.test(atmosphere) && /wrapWindow\(/.test(atmosphere) && /windowFade\(/.test(atmosphere), 'clouds drift with the shared wind and recycle behind a fade');
ok(!/Math\.random/.test(atmosphere) && !/Math\.random/.test(satellites), 'no random per-frame motion');
const billows = Object.keys(manifest.sprites).filter((k) => k.startsWith('billow_'));
ok(billows.length >= 6, 'Blender cumulus billows are exported');
ok(!/cloud_far_|cloud_mid_|cloud_drift_/.test(canvas), 'the flat GOBI sticker clouds are no longer used');

/* 4. Clock: frame-rate independent, pausable, reduced motion freezes -------------------------- */
const c1 = new env.EnvironmentClock();
for (let i = 0; i < 120; i++) c1.advance(1 / 120);
const c2 = new env.EnvironmentClock();
for (let i = 0; i < 30; i++) c2.advance(1 / 30);
ok(Math.abs(c1.t - 1) < 1e-9 && Math.abs(c2.t - 1) < 1e-9, '120 Hz and 30 Hz reach the same time');
const c3 = new env.EnvironmentClock();
c3.advance(4.0);
ok(c3.t <= 0.05, 'a long stall (tab switch) never jumps the world forward');
c3.reduced = true;
const before = c3.t;
c3.advance(1 / 60);
ok(c3.t === before, 'reduced motion freezes decorative time');
c3.reduced = false;
c3.paused = true;
c3.advance(1 / 60);
ok(c3.t === before, 'a hidden page pauses the clock');
ok(/visibilitychange/.test(canvas) && /removeEventListener\("visibilitychange"/.test(canvas), 'visibility listener added and removed');

/* 5. Light rig: one deterministic, smooth transition; sun on the key-light side --------------- */
for (const [from, to] of [['day', 'sunset'], ['sunset', 'night'], ['night', 'day'], ['day', 'night']]) {
  const tod = new rig.TimeOfDayBlend(from);
  tod.request(to, 0);
  let prev = { ...tod.w };
  let prevLook = rig.blendLook(tod.w);
  for (let i = 1; i <= 156; i++) {
    tod.update(i / 60, false);
    const sum = tod.w.day + tod.w.sunset + tod.w.night;
    ok(Math.abs(sum - 1) < 1e-9, 'weights stay normalised');
    ok(Math.abs(tod.w[to] - prev[to]) < 0.05, `${from}->${to}: no jump between frames`);
    ok(tod.w[to] >= prev[to] - 1e-12, `${from}->${to}: monotonic`);
    const look = rig.blendLook(tod.w);
    ok(Math.abs(look.exposure - prevLook.exposure) < 0.03 && Math.abs(look.shadowStretch - prevLook.shadowStretch) < 0.05, 'grade and shadows change smoothly');
    prev = { ...tod.w };
    prevLook = look;
  }
  ok(tod.w[to] === 1 && !tod.transitioning, `${from}->${to} completes`);
}
const mid = new rig.TimeOfDayBlend('day');
mid.request('night', 0);
mid.update(1.0, false);
const w0 = { ...mid.w };
mid.request('sunset', 1.0);
mid.update(1.0 + 1 / 60, false);
ok(Math.abs(mid.w.night - w0.night) < 0.02, 'a new request mid-transition continues from the current light (no snap)');
const snap = new rig.TimeOfDayBlend('day');
snap.request('night', 0);
snap.update(0.001, true);
ok(snap.w.night === 1, 'reduced motion switches light instantly (selection still works)');
ok(rig.ease(0) === 0 && rig.ease(1) === 1 && Math.abs(rig.ease(0.5) - 0.5) < 1e-12, 'smootherstep easing');
const day = rig.celestial({ day: 1, sunset: 0, night: 0 });
const set = rig.celestial({ day: 0, sunset: 1, night: 0 });
const night = rig.celestial({ day: 0, sunset: 0, night: 1 });
ok(set.sun.y > day.sun.y + 0.3, 'the sun descends toward sunset');
ok(day.sun.x < 0.5 && set.sun.x < 0.5 && night.moon.x < 0.5, 'sun and moon stay on the baked key-light (screen-left) side');
ok(night.sun.alpha === 0 && night.moon.alpha === 1 && day.moon.alpha === 0, 'moon replaces the sun at night');
ok(rig.LOOKS.sunset.shadowStretch > 1.3 && rig.LOOKS.day.shadowStretch === 1, 'low sun = longer shadows');
ok(rig.LOOKS.night.exposure < rig.LOOKS.day.exposure && rig.LOOKS.night.lights === 1 && rig.LOOKS.day.lights === 0, 'night is dim and lit by local lights');
ok(rig.LOOKS.sunset.highTint[0] > rig.LOOKS.sunset.highTint[2] && rig.LOOKS.sunset.shadowTint[2] > rig.LOOKS.sunset.shadowTint[0], 'sunset splits warm highlights from cool shade (not a flat overlay)');
ok(/shadows\.setStretch\(look\.shadowStretch\)/.test(canvas), 'shadow length follows the sun');
ok(/scene\.filters = \[grade\.filter\]/.test(canvas) && /emissive\.addChild\(g\)/.test(canvas), 'scene is graded; emissive light stays outside the grade');
ok(/uLightMap/.test(lighting) && /vec3 e = 1\.0 - exp\(-lm \* uLights \* [\d.]+\);\s+g \+= c \* e \* [\d.]+;/.test(lighting),
  'local lights illuminate albedo through the light map, through a soft shoulder (never a clipping gain)');
const lookStart = canvas.indexOf('const applyLook = () => {');
const applyLookBody = canvas.slice(lookStart, lookStart + canvas.slice(lookStart).search(/\n\s*applyLook\(\);\r?\n/));
ok(applyLookBody.length > 0 && !/clock|satellites\.update|cloudLayers\.forEach\(\(l\) => l\.update/.test(applyLookBody), 'changing the light never touches animation time or positions');

/* 6. Shadows: darkness composition (no black over transparent sky), no ghosts ---------------- */
ok(/blendMode = "min"/.test(shadowLayer), 'overlapping shadows compose with MIN');
ok(/-1, 0, 0, 0, 1\]/.test(shadowLayer) && /blendMode = "normal"/.test(shadowLayer), 'factor converted once into a darkness layer (≡ multiply over the island)');
ok(/setVisible\(sp: Sprite, visible: boolean\)/.test(shadowLayer) && /replace\(sp: Sprite, spec: ShadowSpec/.test(shadowLayer), 'stage swaps / removals recompose shadows');

/* 7. Farm composition: six plots, all four stages, edges never on cells ---------------------- */
ok(layout.starterPlots.length === 6, 'six active starter plots');
ok(new Set(layout.starterPlots.map((p) => p.stage)).size === 4, 'all four growth stages are visible at once');
const kinds = [...new Set(layout.starterPlots.map((p) => p.crop))];
for (const k of kinds) for (const s of [1, 2, 3, 4]) ok(manifest.sprites[`crop_${k}_s${s}`]?.shadow, `crop_${k}_s${s} with its own shadow`);
const s1Bytes = kinds.map((k) => manifest.sprites[`crop_${k}_s1`].bytes);
ok(new Set(s1Bytes).size === kinds.length, 'every species has its own seedling art');
const cells = new Set([...layout.starterPlots.map((p) => `${p.gx},${p.gy}`), ...layout.farmWalkways.map(([x, y]) => `${x},${y}`)]);
for (const e of layout.farmEdges ?? []) {
  for (const c of cells) {
    const [x, y] = c.split(',').map(Number);
    ok(Math.max(Math.abs(e.gx - x), Math.abs(e.gy - y)) > 0.75, `edge growth (${e.gx}, ${e.gy}) clear of cell ${c}`);
  }
  for (const f of layout.futureFields) {
    const [x0, y0, x1, y1] = f.rect;
    ok(!(e.gx > x0 - 0.1 && e.gx < x1 + 0.1 && e.gy > y0 - 0.1 && e.gy < y1 + 0.1), `edge growth off future field ${f.id}`);
  }
  ok(manifest.sprites[e.key], `${e.key} exported`);
}
ok(/s\.eventMode = "none"; \/\/ decorative/.test(canvas) && /LAYOUT\.farmEdges/.test(canvas), 'edge growth is decorative (never intercepts plot taps)');

/* 8. Knowledge Tree: one hero, open sky behind its crown ------------------------------------- */
const kt = layout.sprites.filter((s) => s.id === 'knowledge_tree');
ok(kt.length === 1, 'exactly one Knowledge Tree');
const crown = { halfW: 300, top: -470, bottom: -160 };
for (const t of layout.trees) {
  const dx = ((t.gx - t.gy) - (kt[0].gx - kt[0].gy)) * 64;
  const dy = ((t.gx + t.gy) - (kt[0].gx + kt[0].gy)) * 32;
  ok(!(Math.abs(dx) < crown.halfW && dy > crown.top && dy < crown.bottom), `tree ${t.key} (${t.gx}, ${t.gy}) does not stand behind the Knowledge Tree crown`);
}

/* 8b. Final three-point polish: natural sun, readable farm, heartwood inside the wood ----------- */
// sun: warm, alpha-composited disc + bloom (additive white over the blue day sky clipped into a cyan ring)
ok(/this\.sunDisc = mk\(discTex, "normal"\)/.test(lighting) && /this\.sunHalo = mk\(haloTex, "normal"\)/.test(lighting), 'sun disc + bloom are normal-blended (no cyan clipping)');
ok(/this\.sunGlow = mk\(sunGlowTex, "screen"\)/.test(lighting), 'broad sun scattering is screen-composited (never clips)');
ok(/this\.sunWarm\.alpha = c\.sun\.alpha \* warm/.test(lighting) && /this\.sunCore\.alpha = c\.sun\.alpha \* warm/.test(lighting), 'additive sun layers exist only with the sunset weight (warm sky: red clips first)');
ok(/function radialPaint/.test(lighting) && /d\[i \+ 3\] = Math\.max\(0, Math\.min\(255, Math\.round\(a \* 255 \+ n\)\)\)/.test(lighting), 'sun glows are painted per pixel with dither (no gradient bands)');
ok(/const md = Math\.max\(26, Math\.min\(W, H\) \* 0\.052\) \* 1\.05/.test(lighting) && /this\.moonGlow = mk\(glowTex\)/.test(lighting), 'moon size and halo are independent of the sun (night unchanged)');
ok(rig.LOOKS.sunset.exposure < rig.LOOKS.day.exposure, 'a low sun lights the ground less than midday');
// farm: six beds unchanged, every stage of every species ships with its own shadow and stays inside its bed
const bedS = manifest.sprites.plot_bed;
ok(bedS && bedS.shadow, 'raised bed sprite + its own shadow');
for (const kind of kinds) {
  for (const st of [1, 2, 3, 4]) {
    const c = manifest.sprites[`crop_${kind}_s${st}`];
    ok(c && c.shadow, `crop_${kind}_s${st} sprite + shadow`);
    ok(c.ax * c.scale <= bedS.ax * bedS.scale + 1 && (c.w - c.ax) * c.scale <= (bedS.w - bedS.ax) * bedS.scale + 1, `crop_${kind}_s${st} stays inside its bed`);
  }
}
ok(JSON.stringify(layout.starterPlots.map((p) => [p.gx, p.gy])) === JSON.stringify([[8, 18], [9, 18], [10, 18], [8, 19], [9, 19], [10, 19]]), 'the six starter beds keep their exact cells');
// Knowledge Tree: one hero, same placement; magic only in its glow layer (QA can switch it off)
const ktS = manifest.sprites.knowledge_tree;
ok(ktS && ktS.glow && Math.abs(ktS.ax - 565.68) < 2 && Math.abs(ktS.ay - 775.84) < 2, 'Knowledge Tree keeps its anchor (placement + click target preserved)');
ok(/setMagicVisible/.test(canvas) && canvas.indexOf('setMagicVisible') > canvas.indexOf('process.env.NODE_ENV !== "production"'), 'the no-glow QA switch is development-only');
ok(!/0xffe6a6/.test(src('world/ambientFx.ts')), 'heartwood motes carry the teal heartwood light (no gold lamp)');

/* 9. Resource cleanup ------------------------------------------------------------------------ */
for (const r of ['cloudLayers.forEach((l) => l.destroy())', 'satellites.destroy()', 'sky.destroy()', 'grade?.destroy()', 'lightMap?.destroy()', 'shadows.destroy()', 'releases.forEach(']) {
  ok(canvas.includes(r), `cleanup: ${r}`);
}
ok(canvas.indexOf('grade?.destroy()') < canvas.indexOf('lightMap?.destroy()'), 'filter released before the light map it samples');
ok(canvas.lastIndexOf('destroyApp(app);') < canvas.indexOf('releases.forEach('), 'render textures are released only after the renderer (no dangling bind groups)');

/* 12. Phase 1 gameplay: server-driven farm, network-free scene, honest presentation --------------- */
{
  const model = await import(new URL('game/gardenModel.ts', root));
  const api = readFileSync(new URL('../src/services/gardenApi.ts', import.meta.url), 'utf8');
  const types = readFileSync(new URL('../src/types/garden.ts', import.meta.url), 'utf8');
  const farm = src('world/farmLayer.ts');
  const hook = src('game/useEchoGarden.ts');
  const view = src('EchoGardenView.tsx');
  const gameDir = ['game/GardenOverlay.tsx', 'game/PlotPanel.tsx', 'game/HarvestFlow.tsx', 'game/InventoryPanel.tsx', 'game/GardenStatus.tsx', 'game/gardenUi.tsx'];
  // every crop obtainable in Phase 1 has World v2 art for all four stages (+ shadows)
  for (const code of ['WHEAT', 'TOMATO', 'CORN', 'STRAWBERRY', 'ROSE', 'WATERMELON', 'PUMPKIN', 'QA_SPROUT']) {
    for (let st = 1; st <= 4; st++) {
      const key = model.cropSpriteKey(code, st);
      ok(manifest.sprites[key], `${code} stage ${st} art exported (${key})`);
      ok(manifest.sprites[key]?.shadow, `${key} has its own shadow sprite`);
    }
  }
  ok(model.cropSpriteKey('WHEAT', 9) === 'crop_wheat_s4' && model.cropSpriteKey('WHEAT', 0) === 'crop_wheat_s1', 'stage keys are clamped to 1..4');
  // projection never ripens a crop on the client; stages are monotonic and follow the server thresholds
  const growing = { ready: false, progress: 0.05, speed: 1, requiredSeconds: 1000, remainingSeconds: 950, stage: 1 };
  let prev = 0;
  for (let s = 0; s <= 5000; s += 7) {
    const g = model.projectGrowth(growing, [0.1, 0.45], 1_000_000 + s * 1000, 1_000_000);
    ok(g.stage <= 3, 'a growing crop is never shown ripe before the server says so');
    ok(g.stage >= prev, 'visual stages never go backwards');
    ok(g.remainingSeconds >= 0, 'countdown never negative');
    prev = g.stage;
  }
  ok(model.projectGrowth(growing, [0.1, 0.45], 1_000_000 + 60_000, 1_000_000).stage === 2, '0.05 + 60/1000 → stage 2');
  ok(model.projectGrowth({ ...growing, ready: true, stage: 4 }, [0.1, 0.45], 0, 0).stage === 4, 'server-ready crops show stage 4');
  ok(model.serverOffsetMs('2026-10-09T03:00:00.000Z', 1000, 1200) === Date.parse('2026-10-09T03:00:00.000Z') - 1100, 'offset uses the RTT midpoint');
  ok(model.formatDuration(45) === '45 giây' && model.formatDuration(750) === '12 phút' && model.formatDuration(4500) === '1 giờ 15 phút', 'durations read in Vietnamese');
  for (const code of ['NOT_READY', 'ALREADY_HARVESTED', 'PLOT_OCCUPIED', 'PLOT_LOCKED', 'NO_SEED', 'NO_ITEM', 'BOOST_LIMIT', 'CROP_LOCKED', 'CHALLENGE_EXPIRED', 'INSUFFICIENT_FUNDS', 'IDEMPOTENCY_KEY_REUSED']) {
    const m = model.errorMessage(code, { level: 5, missing: 12 });
    ok(m && !/undefined|NaN/.test(m), `${code} has a Vietnamese message`);
  }
  ok(model.errorMessage('INSUFFICIENT_FUNDS', { missing: 260 }).includes('260 Đồng Echo'), 'missing coins are stated');
  // the scene never talks to the network; actions carry idempotency keys; the client never decides readiness
  for (const f of [canvas, farm]) ok(!/gardenApi|api-client|apiClient|fetch\(.*garden/.test(f), 'the Pixi scene is network-free');
  const posts = (api.match(/post</g) ?? []).length;
  ok(/'Idempotency-Key': key/.test(api) && posts >= 6, 'every gameplay POST sends its Idempotency-Key');
  ok(/const key = newGardenKey\(\);[\s\S]*for \(let attempt = 0; ; attempt\+\+\)[\s\S]*await call\(key\)/.test(hook), 'one key per action, reused on retry');
  ok(!/ready:\s*true/.test(hook), 'the client never marks a crop ripe');
  ok(!/answer/.test(types.match(/interface GardenQuestion[^}]*}/)?.[0] ?? 'answer'), 'questions reach the client without answers');
  ok(!/Math\.random/.test(farm), 'farm feedback is deterministic (seeded)');
  ok(/const farmLayer = gameplay\s*\?/.test(canvas), 'the farm layer exists only in gameplay mode');
  ok(/LAYOUT\.starterPlots\.map\(\(p\) => `crop_\$\{p\.crop\}_s\$\{p\.stage \?\? 4\}`\)/.test(canvas), 'the preview keeps the approved bed fixture');
  ok(/farmLayer\?\.destroy\(\)/.test(canvas), 'farm resources are released with the scene');
  ok(/game\.phase === "checking" \|\| game\.phase === "loading"/.test(view), 'gameplay mounts the world only after the first authoritative state');
  for (const f of gameDir) ok(!/Sparkles|✨/.test(src(f)), `${f}: no sparkle icon`);
}

/* 13. Phase 2 living farm: seasons, weather, memory trees, forest, pests ----------------------- */
{
  const model = await import(new URL('game/gardenModel.ts', root));
  const hook = src('game/useEchoGarden.ts');
  const api = readFileSync(new URL('../src/services/gardenApi.ts', import.meta.url), 'utf8');
  const living = src('world/livingLayer.ts');
  const fx = src('world/seasonFx.ts');
  const audio = src('game/gardenAudio.ts');
  const bed = manifest.sprites.plot_bed;
  // Epic / Legendary crops: four stages with their own shadows, inside the bed
  for (const code of ['MOONFLOWER', 'FROST_LILY', 'CRYSTAL_ORCHID']) {
    for (let st = 1; st <= 4; st++) {
      const key = model.cropSpriteKey(code, st);
      const c = manifest.sprites[key];
      ok(c && c.shadow, `${key} exported with its own shadow`);
      ok(c.ax * c.scale <= bed.ax * bed.scale + 1 && (c.w - c.ax) * c.scale <= (bed.w - bed.ax) * bed.scale + 1, `${key} stays inside its bed`);
    }
  }
  // memory trees: four species (the season planted in) x four stages, the sacred spot, the pest
  for (const sp of ['SPRING', 'SUMMER', 'AUTUMN', 'WINTER']) for (let st = 1; st <= 4; st++) {
    const key = model.treeSpriteKey(sp, st);
    ok(manifest.sprites[key]?.shadow, `${key} exported with its own shadow`);
  }
  ok(manifest.sprites.mtree_spot?.shadow && manifest.sprites.forgotten_pest?.shadow, 'sacred spot + Forgotten Pest exported');
  const ktS2 = manifest.sprites.knowledge_tree;
  ok(manifest.sprites.mtree_summer_s4.h * manifest.sprites.mtree_summer_s4.scale < 0.6 * ktS2.h * ktS2.scale, 'memory trees stay clearly smaller than the monumental Knowledge Tree');
  // seasons: variants of the approved vegetation, re-using the base shadow; seasonal terrains share the base geometry
  const variants = Object.keys(manifest.sprites).filter((k) => k.includes('__'));
  ok(variants.length >= 30, `seasonal vegetation variants exported (${variants.length})`);
  const satKeys = new Set(layout.satellites.map((s) => s.key));
  for (const v of variants) {
    const [base, season] = v.split('__');
    ok(['spring', 'autumn', 'winter'].includes(season), `${v}: a known season (summer is the approved base)`);
    // vegetation re-uses its base shadow; the floating satellites cast none (sky art), in every season
    ok(satKeys.has(base) ? !!manifest.sprites[base] && !manifest.sprites[base].shadow : manifest.sprites[base]?.shadow,
      `${v}: its base sprite carries the shared shadow (satellites: none)`);
    ok(!manifest.sprites[v].shadow, `${v}: no second shadow (same geometry as the base)`);
  }
  for (const k of satKeys) {
    for (const sn of ['spring', 'autumn', 'winter']) ok(manifest.sprites[`${k}__${sn}`], `satellite ${k} follows the ${sn} season`);
  }
  ok(canvas.includes('const art = artFor(s.key, currentSeason);') && canvas.includes('for (const it of satellites.items) {'),
    'satellites load only the current season art and crossfade with the island');
  ok(['spring', 'autumn', 'winter'].every((sn) => manifest.terrainSeasons?.[sn]), 'three seasonal terrains');
  for (const t of Object.values(manifest.terrainSeasons)) {
    ok(t.w === manifest.terrain.w && t.h === manifest.terrain.h && JSON.stringify(t.originPx) === JSON.stringify(manifest.terrain.originPx), 'seasonal terrain = same frame / origin as the approved terrain');
  }
  ok(canvas.includes('if (!key.endsWith(`__${currentSeason}`)) return;'), 'only the current season variants are downloaded');
  ok(canvas.includes('if (key.startsWith("mtree_") || key === "forgotten_pest") return;'), 'memory art loads on demand with the living layer');
  ok(canvas.includes('let currentSeason: SeasonName = farm0Early !== null ? seasonRef.current : "summer";'), 'the visual preview keeps the approved summer world');
  ok(/const living = gameplay\s*\?/.test(canvas) && canvas.includes('living?.destroy()') && canvas.includes('seasonFx.destroy()'), 'living layer only in gameplay; released with the scene');
  ok(!/Math\.random/.test(fx) && !/Math\.random/.test(living), 'season / weather / memory motion is deterministic');
  for (const f of [living, fx]) ok(!/gardenApi|apiClient|fetch\(/.test(f), 'the new scene layers are network-free');
  // light rig: season / weather are small continuous deltas on the same rig
  const base = rig.blendLook({ day: 1, sunset: 0, night: 0 });
  const same = rig.applyAtmosphere(base, { summer: 1 }, { rain: 0, rainbow: 0 });
  ok(JSON.stringify(same) === JSON.stringify(base), 'summer without weather = the approved look');
  const rain = rig.applyAtmosphere(base, { summer: 1 }, { rain: 1, rainbow: 0 });
  ok(rain.shadowAlpha < base.shadowAlpha && rain.exposure < base.exposure, 'overcast rain softens shadows and light');
  let prevE = base.exposure;
  for (let w = 0; w <= 1.0001; w += 0.02) {
    const l = rig.applyAtmosphere(base, { summer: 1 - w, winter: w }, { rain: 0, rainbow: 0 });
    ok(Math.abs(l.exposure - prevE) < 0.01, 'season change is continuous');
    prevE = l.exposure;
  }
  const fade = new rig.Fade(0, 2);
  fade.set(1, 0);
  const mid1 = fade.update(1, false);
  ok(mid1 > 0.4 && mid1 < 0.6 && fade.update(2, false) === 1, 'Fade eases to its target');
  // layout: three sacred spots clear of the farm and of the landmark crown; bounded forest anchors
  ok(layout.memoryGrove.length === 3 && JSON.stringify(layout.memoryGrove.map((g) => g.slot)) === '[1,2,3]', 'exactly three sacred spots');
  const ktL = layout.sprites.find((x) => x.id === 'knowledge_tree');
  const taken = [...layout.starterPlots.map((pl) => [pl.gx, pl.gy]), ...layout.farmWalkways];
  for (const g of layout.memoryGrove) {
    const dx = ((g.gx - g.gy) - (ktL.gx - ktL.gy)) * 64;
    const dy = ((g.gx + g.gy) - (ktL.gx + ktL.gy)) * 32;
    ok(!(Math.abs(dx) < 300 && dy > -470 && dy < -160), `spot ${g.slot} never stands behind the Knowledge Tree crown`);
    ok(taken.every(([x, y]) => Math.max(Math.abs(g.gx - x), Math.abs(g.gy - y)) > 1), `spot ${g.slot} off plots / walkways`);
    ok(layout.futureFields.every((fl) => { const [x0, y0, x1, y1] = fl.rect; return !(g.gx > x0 - 0.5 && g.gx < x1 + 0.5 && g.gy > y0 - 0.5 && g.gy < y1 + 0.5); }), `spot ${g.slot} off future fields`);
  }
  ok(layout.memoryForest.length >= 8 && layout.memoryForest.length <= 16, 'bounded forest anchors');
  // honest learning + presentation
  ok(model.SEASON_OF_THEME.THANH_NGU === 'winter' && model.weatherLabel({ kind: 'RAIN', theme: 'THANH_NGU' }) === 'Tuyết rơi', 'winter rain is shown as snow');
  const crop = { season: 'LU_HANH', seasonFitNow: 'IN_SEASON', growSecondsNow: 3600 };
  const world = { world: { theme: 'LU_HANH', themeEndsAt: '2026-10-11T17:00:00Z', weather: { kind: 'SUNNY', theme: 'LU_HANH' }, forecast: [] } };
  const adv = model.seedAdvice(crop, world, Date.parse('2026-10-09T03:00:00Z'));
  ok(adv.length > 0 && adv.every((a) => !/tốt nhất|best/i.test(a.text)), 'seed advice states facts, never "the best crop"');
  ok(hook.includes('reviewFlashcard(flashcardId, quality)') && api.includes('/flashcards/${flashcardId}/review'), 'rescue reviews use the existing Flashcard review endpoint');
  const rescue = hook.slice(hook.indexOf('const rescueReview'), hook.indexOf('Phase 3A: market, delivery board, expansion'));
  ok(rescue.length > 0 && !/correct|grade\(/i.test(rescue), 'the garden never grades a card itself');
  ok(/try \{[\s\S]*localStorage\.getItem[\s\S]*catch/.test(audio) && audio.includes('setMuted'), 'sound can be muted; storage failures are harmless');
  for (const fl of ['game/MemoryPanels.tsx', 'game/WorldPanels.tsx', 'game/GardenStatus.tsx', 'world/livingLayer.ts', 'world/seasonFx.ts']) ok(!/Sparkles|✨/.test(src(fl)), `${fl}: no sparkle icon`);
}

/* 14. Phase 3A farm economy: four owner-approved beds, market stall, delivery board ------------ */
{
  const model = await import(new URL('game/gardenModel.ts', root));
  const panels = src('game/EconomyPanels.tsx');
  const hook = src('game/useEchoGarden.ts');
  const view = src('EchoGardenView.tsx');
  const api = readFileSync(new URL('../src/services/gardenApi.ts', import.meta.url), 'utf8');
  const types = readFileSync(new URL('../src/types/garden.ts', import.meta.url), 'utf8');
  const exp = layout.expansionPlots;
  // owner decision 2026-10-10: exactly these four cells, slots 7–10, inside the marked future fields
  ok(Array.isArray(exp) && exp.length === 4, 'exactly four expansion beds');
  ok(JSON.stringify(exp.map((x) => [x.slot, x.gx, x.gy, x.field])) === JSON.stringify([[7, 8, 16, 'north_strip'], [8, 9, 16, 'north_strip'], [9, 10, 16, 'north_strip'], [10, 6, 18, 'west_tilled']]),
    'expansion beds are exactly the owner-approved cells (8,16) (9,16) (10,16) (6,18)');
  ok(layout.starterPlots.length === 6 && JSON.stringify(layout.starterPlots.map((p) => [p.gx, p.gy])) === JSON.stringify([[8, 18], [9, 18], [10, 18], [8, 19], [9, 19], [10, 19]]),
    'the six starter beds are unchanged');
  const markedFields = layout.futureFields.filter((f) => f.state !== 'resting');
  const fenceRect = { x0: Math.min(...layout.fences.flatMap((f) => [f.from[0], f.to[0]])), x1: Math.max(...layout.fences.flatMap((f) => [f.from[0], f.to[0]])),
    y0: Math.min(...layout.fences.flatMap((f) => [f.from[1], f.to[1]])), y1: Math.max(...layout.fences.flatMap((f) => [f.from[1], f.to[1]])) };
  const segDist = (px, py, [ax, ay], [bx, by]) => {
    const vx = bx - ax, vy = by - ay;
    const u = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1)));
    return Math.hypot(px - (ax + u * vx), py - (ay + u * vy));
  };
  for (const c of exp) {
    const field = markedFields.find((f) => f.id === c.field);
    ok(field, `bed ${c.slot}: its field ${c.field} is a marked (non-resting) future field`);
    const [x0, y0, x1, y1] = field.rect;
    ok(c.gx - 0.45 >= x0 - 1e-9 && c.gx + 0.45 <= x1 + 1e-9 && c.gy - 0.45 >= y0 - 1e-9 && c.gy + 0.45 <= y1 + 1e-9, `bed ${c.slot}: whole cell inside ${c.field}`);
    ok(Number.isInteger(c.gx) && Number.isInteger(c.gy), `bed ${c.slot}: whole cell`);
    ok(!layout.farmWalkways.some(([x, y]) => x === c.gx && y === c.gy), `bed ${c.slot}: off every walkway`);
    ok(!layout.starterPlots.some((p) => p.gx === c.gx && p.gy === c.gy), `bed ${c.slot}: never on a starter bed`);
    ok(c.gx > fenceRect.x0 && c.gx < fenceRect.x1 && c.gy > fenceRect.y0 && c.gy < fenceRect.y1, `bed ${c.slot}: inside the farm fence`);
    ok(layout.fences.every((f) => segDist(c.gx, c.gy, f.from, f.to) >= 0.3) && segDist(c.gx, c.gy, layout.farmGate, layout.farmGate) >= 0.9,
      `bed ${c.slot}: its centre keeps clear of every fence line and the gate`);
    for (const fp of [...layout.farmProps, ...(layout.farmEdges ?? []), ...layout.sprites, ...layout.trees, ...layout.bushes]) {
      ok(Math.max(Math.abs(fp.gx - c.gx), Math.abs(fp.gy - c.gy)) > 0.5, `bed ${c.slot}: no ${fp.key ?? fp.id} on its cell`);
    }
    ok(layout.memoryGrove.every((g) => Math.max(Math.abs(g.gx - c.gx), Math.abs(g.gy - c.gy)) > 1), `bed ${c.slot}: clear of the sacred grove`);
    for (const path of layout.paths) {
      for (let i = 0; i < path.points.length - 1; i++) {
        ok(segDist(c.gx, c.gy, path.points[i], path.points[i + 1]) > 0.5 + path.width / 2, `bed ${c.slot}: clear of path ${path.id}`);
      }
    }
  }
  ok(new Set(exp.map((x) => `${x.gx},${x.gy}`)).size === 4, 'four distinct cells');
  // art anchor = cell + dy: the raised-bed SPRITE (not only the cell centre) stays clear of fences, posts and props
  const bedArt = manifest.sprites.plot_bed;
  const bedHalf = (bedArt.w * bedArt.scale) / 256; // half footprint in tiles (128 px per tile)
  const postHalf = (manifest.sprites.fence_post.w * manifest.sprites.fence_post.scale) / 256;
  ok(bedHalf > 0.44 && bedHalf < 0.5, 'the bed sprite fills its cell');
  for (const c of exp) {
    const dy = c.dy ?? 0;
    const ay = c.gy + dy;
    ok(dy >= 0 && dy <= 0.25, `bed ${c.slot}: the art offset stays a sub-cell nudge`);
    for (const f of layout.fences) {
      const dx = Math.max(Math.min(f.from[0], f.to[0]) - c.gx, 0, c.gx - Math.max(f.from[0], f.to[0]));
      const dyy = Math.max(Math.min(f.from[1], f.to[1]) - ay, 0, ay - Math.max(f.from[1], f.to[1]));
      ok(Math.max(dx, dyy) >= bedHalf + postHalf, `bed ${c.slot}: its raised frame clears the fence line and posts`);
    }
    for (const fp of layout.farmProps) {
      ok(Math.max(Math.abs(fp.gx - c.gx), Math.abs(fp.gy - ay)) >= bedHalf + 0.4, `bed ${c.slot}: ${fp.key} is never drawn over its frame`);
    }
    ok(layout.starterPlots.every((p) => Math.abs(p.gx - c.gx) >= 1 || p.gy - ay >= 1.5), `bed ${c.slot}: the walkway to the starter beds stays open`);
  }
  ok(/\[x\.slot, \{ \.\.\.x, gy: x\.gy \+ \(x\.dy \?\? 0\) \}\]/.test(canvas) && /expansionCells\.forEach\(\(c\) => \{\s*const poly = plotDiamond\(c\.gx, c\.gy\)/.test(canvas),
    'bed, crops, hint ring and touch area share one art anchor');
  const kt = layout.sprites.find((x) => x.id === 'knowledge_tree');
  ok(exp.every((c) => Math.hypot(c.gx - kt.gx, c.gy - kt.gy) > 8), 'beds never approach the monumental Knowledge Tree');
  // market stall touch area: at the seed-storage corner, never over a bed (starter or expansion)
  const st = layout.marketStall;
  ok(st && st.radius > 0.3 && st.radius < 1, 'market stall touch area is layout data');
  ok(['crate_stack', 'seed_sacks', 'barrel'].every((k) => { const p = layout.farmProps.find((x) => x.key === k); return p && Math.hypot(p.gx - st.gx, p.gy - st.gy) < 0.8; }),
    'the stall is the existing seed-storage corner (crates, seed sacks, barrel)');
  ok([...layout.starterPlots, ...exp].every((p) => Math.abs(p.gx - st.gx) + Math.abs(p.gy - st.gy) > st.radius + 0.5), 'the stall never overlaps a bed cell');
  // scene: gameplay-only, existing bed art, one bed per owned slot, marker hidden, closed-form hint
  ok(/if \(gameplay\) \{\s*groundFx\.addChild\(expansionHint\)/.test(canvas), 'expansion targets / hint exist only in gameplay (preview unchanged)');
  ok(/addEntity\("plot_bed", c\.gx, c\.gy, \{ layer: groundObjects, footprint: 0\.9 \}\)/.test(canvas), 'an owned bed reuses the approved plot_bed sprite + shadow');
  ok(/if \(!c \|\| !farmLayer \|\| farmLayer\.hasBed\(slot\)\) return;/.test(canvas), 'each bed is created once');
  ok(/hideMarkerOf\(c\.field\)/.test(canvas) && /shadows\.setVisible\(m\.shadow, false\)/.test(canvas), 'a field marker leaves with its shadow once the field holds a bed');
  ok(/hit\.label = `expand-hit-\$\{c\.slot\}`/.test(canvas) && /hit\.hitArea = new Polygon\(poly\)/.test(canvas), 'each locked cell is a whole-cell touch target');
  ok(/expansionHint\.alpha = hintSlot === null \? 0 : still \? 0\.55 : 0\.42 \+ 0\.18 \* Math\.sin\(t \* 1\.6\)/.test(canvas), 'hint ring breathes on the environment clock (frozen with reduced motion)');
  ok(!/Math\.random/.test(canvas) && !/Math\.random/.test(src('world/farmLayer.ts')), 'no global randomness in the scene');
  ok(/createCrop: \(key, slot\) => \{\s*const p = cellOfSlot\(slot\)/.test(canvas), 'crops on expansion beds use the same stage sprites');
  // gameplay client: the server owns prices, caps, stock and receipts; actions are keyed and confirmed
  ok(/marketBuy: \(offerCode: string, units: number, key: string\)/.test(api) && /fillOrder: \(orderId: number, lines: GardenSupply\[\], key: string\)/.test(api)
    && /expand: \(slot: number, compost: GardenSupply\[\], key: string\)/.test(api), 'every Phase 3A command carries an idempotency key');
  ok(/economy: GardenEconomy;/.test(types), 'state carries the economy view');
  ok(/command\("market"/.test(hook) && /command\("order"/.test(hook) && /command\("expand"/.test(hook), 'commands go through the keyed retry path');
  ok(/Xác nhận giao/.test(panels) && /Xác nhận mở luống/.test(panels) && /Xác nhận/.test(panels), 'purchases, deliveries and beds need an explicit confirmation');
  ok(/Nếu bán ngay số này/.test(panels), 'the delivery card shows the sell-now alternative (a visible trade-off)');
  ok(/thúc cây lớn không bán ở chợ/.test(panels), 'the market states that growth water is never sold');
  ok(/orderReserve\(state\)/.test(src('game/InventoryPanel.tsx')) && /giữ \{keptUnits\} cho đơn/.test(src('game/InventoryPanel.tsx')), 'Kho can sell everything except what open orders need');
  ok(/sid === "market_stall" \? "market" : sid === "prop_signpost" \? "orders"/.test(view), 'the stall opens the market, the signpost the delivery board (no new dock button)');
  // Phase 3F: the market links to the reward counter (one button); it still holds no redemption command of its own
  ok(!/Sparkles|✨/.test(panels) && !/redeemReward|redeemPremiumReward|buyVouchers|buyFrame|đổi thưởng/i.test(panels) && /onEchoRewards/.test(panels),
    'no sparkle icon and no redemption command in the market panels (Phase 3F rewards live in their own panel)');
  ok(model.errorMessage('ORDER_EXPIRED').includes('vẫn còn nguyên'), 'an expired order tells the player nothing was lost');
  ok(model.itemLabel('SEED:WHEAT', [{ code: 'WHEAT', nameVi: 'Lúa mì' }]) === 'Hạt Lúa mì', 'reward items are named in Vietnamese');
}

/* 15. Phase 3B — monument eras + ornaments, crop skins, codex, Echo hint (presentation contracts) ------------ */
{
  const { existsSync } = await import('node:fs');
  const model = await import(new URL('game/gardenModel.ts', root));
  const monumentSrc = src('world/monumentLayer.ts');
  const farmSrc = src('world/farmLayer.ts');
  const panels = src('game/LivingPanels.tsx');
  const overlay = src('game/GardenOverlay.tsx');
  const hook = src('game/useEchoGarden.ts');
  const view = src('EchoGardenView.tsx');
  const api = readFileSync(new URL('../src/services/gardenApi.ts', import.meta.url), 'utf8');
  const types = readFileSync(new URL('../src/types/garden.ts', import.meta.url), 'utf8');
  const worldFile = (f) => existsSync(new URL(`../public/garden/world/${f}`, import.meta.url));

  // the monument: ONE tree, five era sprites sharing one anchor / texel density, each with its own glow and shadow
  const mon = manifest.monument;
  ok(mon && Array.isArray(mon.eras) && mon.eras.length === 5 && mon.eras[0] === 'knowledge_tree', 'five eras; era 0 is the approved Knowledge Tree');
  ok(layout.sprites.filter((x) => x.id === 'knowledge_tree').length === 1 && !layout.sprites.some((x) => x.key.startsWith('knowledge_tree_e')),
    'the layout still places exactly one Knowledge Tree (eras are art of the same entity, never extra trees)');
  const base = manifest.sprites.knowledge_tree;
  let prevH = 0;
  for (const key of mon.eras) {
    const e = manifest.sprites[key];
    ok(e && worldFile(e.file), `${key}: sprite exported`);
    ok(e.glow && worldFile(e.glow) && e.shadow && worldFile(e.shadow.file), `${key}: own night glow and own shadow`);
    ok(e.scale === base.scale, `${key}: same texel density as the approved tree`);
    // sprites are trimmed, so compare the extents around the anchor (zoom-1 px): the root spread is the approved one
    const ext = (x) => ({ left: x.ax * x.scale, right: (x.w - x.ax) * x.scale, up: x.ay * x.scale, below: (x.h - x.ay) * x.scale });
    const a0 = ext(base), a1 = ext(e);
    ok(Math.abs(a1.left - a0.left) <= 8 && a1.right <= a0.right + 16 && a1.right >= a0.right - 8, `${key}: same footprint left and right of the anchor (the roots never move)`);
    ok(Math.abs(a1.below - a0.below) <= 6, `${key}: same ground line under the anchor`);
    ok(a1.up >= prevH - 4 && a1.up <= a0.up * 1.12, `${key}: the crown grows upward within a bounded frame (never an ever-scaling sprite)`);
    ok(e.w * e.h <= 1.25e6, `${key}: texture inside the landmark's memory budget`);
    prevH = a1.up;
  }
  ok(manifest.sprites.knowledge_tree_e4.ay > base.ay + 30, 'the final era is visibly taller than the original tree');

  // ornaments: six fixed sockets under the crown, three tiers each, decoration only
  const families = ['vocabulary', 'listening', 'speaking', 'writing', 'exam', 'memory'];
  ok(JSON.stringify(Object.keys(mon.sockets).sort()) === JSON.stringify([...families].sort()) && mon.ornamentTiers === 3, 'six sockets, three tiers');
  const halfW = (base.w * base.scale) / 2;
  let widest = 0;
  for (const f of families) {
    const s = mon.sockets[f];
    ok(Math.abs(s.dx) < halfW && s.dy < -100 && s.dy > -(base.ay * base.scale), `${f}: socket hangs inside the crown's frame, above the roots`);
    for (let t = 1; t <= 3; t++) {
      const o = manifest.sprites[`kt_orn_${f}_t${t}`];
      ok(o && worldFile(o.file) && o.glow && worldFile(o.glow), `${f} tier ${t}: ornament + glow exported`);
      ok(!o.shadow, `${f} tier ${t}: a hanging ornament casts no ground shadow sprite`);
      ok(o.ay <= 8 && Math.abs(o.ax - o.w / 2) <= o.w * 0.3, `${f} tier ${t}: anchored at its hanging point`);
      widest = Math.max(widest, o.w * o.scale);
    }
  }
  // no two ornaments can overlap, even at their widest tier (drawn at ORNAMENT_SCALE)
  const ornamentScale = Number(/const ORNAMENT_SCALE = ([\d.]+);/.exec(monumentSrc)[1]);
  ok(widest > 30 && ornamentScale >= 1 && ornamentScale <= 1.6, 'ornaments are small charms, drawn slightly enlarged');
  for (let i = 0; i < families.length; i++) {
    for (let j = i + 1; j < families.length; j++) {
      const a = mon.sockets[families[i]], b = mon.sockets[families[j]];
      const oa = manifest.sprites[`kt_orn_${families[i]}_t3`], ob = manifest.sprites[`kt_orn_${families[j]}_t3`];
      const need = ((oa.w * oa.scale + ob.w * ob.scale) / 2) * ornamentScale;
      const tall = Math.max(oa.h * oa.scale, ob.h * ob.scale) * ornamentScale;
      ok(Math.abs(a.dx - b.dx) >= need || Math.abs(a.dy - b.dy) >= tall, `${families[i]} and ${families[j]} ornaments never overlap`);
    }
  }
  ok(/ORNAMENT_FAMILIES = \["vocabulary", "listening", "speaking", "writing", "exam", "memory"\] as const/.test(monumentSrc), 'the scene knows exactly six ornament families');
  ok(/const MAX_MOTES = \d+;/.test(monumentSrc) && /this\.motes\.length < MAX_MOTES/.test(monumentSrc), 'celebration motes are pooled and bounded');
  ok(!/Math\.random/.test(monumentSrc) && /function seeded\(seed: number\)/.test(monumentSrc), 'monument motion is seeded and closed-form (no global randomness)');
  ok((monumentSrc.match(/eventMode = "none"/g) ?? []).length >= 4, 'ornaments, glows, motes and the fading copy are decoration (the tree keeps its own touch target)');
  ok(/if \(this\.reduced\) return;/.test(monumentSrc) && /const sway = this\.reduced \? 0/.test(monumentSrc), 'reduced motion keeps the state and drops the motion');
  ok(/if \(!entry\) return;/.test(monumentSrc) && /return "knowledge_tree";/.test(monumentSrc), 'a missing era sprite keeps the previous look (never an empty tree)');
  ok(!/fetch\(|apiClient|gardenApi/.test(monumentSrc), 'the monument layer never talks to the network');

  // scene wiring: gameplay only, one era resident, ornaments and skins on demand, released with the renderer
  ok(/const monumentLayer = gameplay && kt\s*\? new MonumentLayer\(/.test(canvas), 'the monument layer exists only in gameplay (the preview keeps the approved tree)');
  ok(/const treeArt = gameplay \? eraSpriteKey\(manifest, monumentRef\.current\?\.era \?\? 0\) : "knowledge_tree";/.test(canvas), 'the preview always shows era 0');
  ok(/\} else if \(key\.startsWith\("kt_orn_"\)\) \{\s*return;/.test(canvas), 'ornaments are never preloaded');
  ok(/if \(key !== treeArt\) return;/.test(canvas), 'only the era on screen is loaded');
  ok(/if \(key\.startsWith\("cskin_"\)\) \{\s*if \(!shownCrops\.has\(key\)\) return;/.test(canvas), 'a crop skin loads only while a growing crop wears it');
  ok(/monumentLayer\?\.destroy\(\);/.test(canvas) && !/Assets\.unload/.test(monumentSrc), 'the layer is released after the renderer; it never unloads a texture a batch may still hold');
  ok(/whale\.cheer\(\);/.test(canvas) && /whale\.attention = gameplay && echoAttentionRef\.current;/.test(canvas), 'Echo answers a milestone and shows its hint halo only in gameplay');
  for (const w of ['world/echoWhale3D.ts', 'world/echoWhale.ts']) ok(/cheer\(\) \{/.test(src(w)) && /attention = false;/.test(src(w)), `${w}: both whale renderers accept the Phase 3B reactions`);
  ok(/if \(this\.cheerAt !== null\) return;/.test(src('world/echoWhale3D.ts')), 'a cheer never restarts while one is running');

  // crop skins: four stages each, same footprint as the base crop, base-crop fallback
  const skins = { wheat_dusk: 'wheat', tomato_amber: 'tomato', strawberry_snow: 'strawberry', rose_moon: 'rose', pumpkin_jade: 'pumpkin', corn_gem: 'corn' };
  const bed = manifest.sprites.plot_bed;
  for (const [skin, crop] of Object.entries(skins)) {
    for (let st = 1; st <= 4; st++) {
      const e = manifest.sprites[`cskin_${skin}_s${st}`];
      const b = manifest.sprites[`crop_${crop}_s${st}`];
      ok(e && worldFile(e.file), `${skin} stage ${st}: sprite exported`);
      ok(e.shadow && worldFile(e.shadow.file), `${skin} stage ${st}: own shadow sprite`);
      ok(e.scale === b.scale, `${skin} stage ${st}: same texel density as the base crop`);
      ok(Math.abs(e.ax - b.ax) <= 14 && e.w * e.scale <= bed.w * bed.scale + 6, `${skin} stage ${st}: stands on the same bed footprint`);
      ok(model.cropSpriteKey(crop.toUpperCase(), st, skin) === `cskin_${skin}_s${st}`, `${skin} stage ${st}: resolved by the model`);
    }
  }
  ok(model.cropSpriteKey('TOMATO', 4) === 'crop_tomato_s4' && model.cropSpriteKey('TOMATO', 4, null) === 'crop_tomato_s4', 'no skin = the base crop');
  ok(model.cropSpriteKey('TOMATO', 4, '../evil') === 'crop_tomato_s4', 'an art key is a plain identifier or it is ignored');
  ok(model.baseCropKey('TOMATO', 'cskin_tomato_amber_s3') === 'crop_tomato_s3' && model.baseCropKey('TOMATO', 'crop_tomato_s3') === 'crop_tomato_s3', 'every skin sprite has a base-crop stand-in');
  ok(/this\.broken\.has\(want\)\)\s*\? cropSpriteKey\(v\.cropCode, v\.stage\) : want;/.test(farmSrc) && /this\.broken\.add\(key\);/.test(farmSrc),
    'a skin sprite that is missing or fails to load shows the base crop (planting and harvest never break)');
  ok(/if \(key\.startsWith\("cskin_"\)\) return swayFor\(/.test(canvas), 'a skin sways like its crop');
  ok(/skinArt: p\.skinArt \?\? null/.test(src('game/gardenModel.ts')), 'the planting carries the skin the SERVER snapshotted (the client never picks one)');

  // client contract: keyed commands, server-owned eligibility, two-step purchase, cosmetic-only copy
  ok(/acquireSkin: \(skinCode: string, key: string\)/.test(api) && /equipSkin: \(cropCode: string, skinCode: string \| null, key: string\)/.test(api)
    && /milestonesSeen: \(ids: number\[\], key: string\)/.test(api), 'every Phase 3B command carries an idempotency key');
  ok(/living: GardenLiving;/.test(types) && /skinCode: string \| null;/.test(types), 'state carries the living view and the planting its skin');
  ok(/command\("skin"/.test(hook) && /command\("milestones"/.test(hook), 'commands go through the keyed retry path');
  ok(/Xác nhận mua/.test(panels) && /setConfirming\(true\)/.test(panels), 'buying a skin needs an explicit confirmation');
  ok(/skin\.status === "AVAILABLE"/.test(panels) && !/coinPrice <= coins|coins >= skin\.coinPrice/.test(panels), 'eligibility is the server status, never a client comparison');
  ok(/Giống chỉ đổi dáng vẻ/.test(panels) && /Luống đang trồng giữ giống cũ/.test(panels), 'the codex says a skin is cosmetic and when it applies');
  ok(/không phải trình độ/.test(panels) && !/CEFR|B1|B2|C1|thành thạo tiếng Anh/.test(panels), 'the monument states participation, never proficiency');
  ok(!/Sparkles|✨/.test(panels + overlay) && !/redeem|đổi thưởng|voucher|Premium/i.test(panels), 'no sparkle icon, no reward redemption or Premium control in Phase 3B');
  ok(/BrandWhaleIcon/.test(panels), 'Echo speaks with the Echo Whale brand icon');
  ok(!/echoCoachApi|openrouter|\/ai\/|coach\/chat/i.test(panels + overlay + hook), 'Echo hints never call an AI endpoint');
  ok(/sid === "knowledge_tree" \? "monument" : sid === "echo_whale" \? "echo"/.test(view), 'the tree opens its overview and the whale opens Echo (no new dock button)');
  ok(/\{ id: "codex", label: "Sổ tay" \}/.test(src('game/EconomyPanels.tsx')), 'the codex is a tab of the existing Kho sheet');

  // Echo: one hint, grounded in server facts, linking only to real routes
  const skinName = (c) => c;
  const codes = { GRADUATE: { slot: 2 }, RESCUE: { pestId: 7, count: 1 }, HARVEST: { count: 2 }, DELIVER: { orderId: 3, count: 1 }, MILESTONE: { count: 1 },
    CLAIM_SKIN: { skinCode: 'WHEAT_DUSK' }, REVIEW_DUE: { due: 12 }, BRANCH: { family: 'LISTENING', daysLeft: 2, tier: 1 }, IDLE: {} };
  for (const [code, params] of Object.entries(codes)) {
    const line = model.echoLine({ code, params }, skinName);
    ok(line && line.text.length > 10 && line.action, `${code}: Echo says one sentence with one action`);
    if (line.action.kind === 'route') ok(routeExists(line.action.route), `${code}: ${line.action.route} is a real English Coach route`);
  }
  ok(model.echoLine({ code: 'SOMETHING_NEW', params: {} }, skinName) === null && model.echoLine(undefined, skinName) === null, 'an unknown hint says nothing (Echo never invents a task)');
  ok(model.echoLine({ code: 'BRANCH', params: { family: 'READING', daysLeft: 1, tier: 1 } }, skinName) === null, 'no hint for a learning source that has no verified record');
  ok(model.echoLine({ code: 'REVIEW_DUE', params: { due: 12 } }, skinName).text.includes('12'), 'the hint carries the server fact');
  for (const f of Object.values(model.FAMILY_INFO)) ok(routeExists(f.route), `${f.route} exists`);
  ok(/const showEcho = idle && !showMilestones && !askVisibility && !!hint/.test(overlay) && /const showMilestones = idle && unseen\.length > 0;/.test(overlay)
    && /const askVisibility = idle && !showMilestones && /.test(overlay), 'one thing at a time: a milestone, the visibility question or a hint, never over a panel');
  ok(/living\?\.echo\.code !== "IDLE"/.test(overlay), 'an idle Echo stays quiet');
  ok(/celebrateMilestones\(unseen\.map\(\(m\) => m\.id\)\)/.test(overlay) && /gardenApi\.milestonesSeen\(ids, key\)/.test(hook), 'a celebration is acknowledged on the server (not replayed after a refresh)');
  ok(/router\.push\(route\)/.test(overlay) && !/reviewFlashcard|gardenApi\.(plant|harvest)/.test(panels), 'Echo navigates to the module; it never grades or completes learning itself');
  ok(model.errorMessage('SKIN_LOCKED', { reason: 'LEARNING', days: 21 }).includes('21'), 'a locked skin explains its requirement');
  ok(Object.keys(model.ERA_LABEL).length === 5 && model.requirementText({ code: 'DAYS', have: 400, need: 75, met: true }).includes('75/75'), 'requirements are worded without overshooting');
}

/* 16. Phase 3C — farmland regions, building levels, staged pest damage, Echo Contribution / rewards ------------ */
{
  const { existsSync } = await import('node:fs');
  const model = await import(new URL('game/gardenModel.ts', root));
  const estateSrc = src('world/estateLayer.ts');
  const farmSrc = src('world/farmLayer.ts');
  const livingSrc = src('world/livingLayer.ts');
  const panels = src('game/EstatePanels.tsx');
  const hook = src('game/useEchoGarden.ts');
  const overlay = src('game/GardenOverlay.tsx');
  const view = src('EchoGardenView.tsx');
  const memory = src('game/MemoryPanels.tsx');
  const api = readFileSync(new URL('../src/services/gardenApi.ts', import.meta.url), 'utf8');
  const types = readFileSync(new URL('../src/types/garden.ts', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../../backend/src/main/resources/db/migration/exams/V83__echo_garden_phase3c_estate.sql', import.meta.url), 'utf8');
  const sprite = (key) => manifest.sprites[key];
  const file = (name) => existsSync(new URL(`../public/garden/world/${name}`, import.meta.url));

  // ---- farmland regions: bounded, on reserved future-field cells only, clear of everything approved
  const regions = layout.landRegions;
  ok(Array.isArray(regions) && regions.length === 3, 'three farmland regions');
  const land = regions.flatMap((r) => r.plots.map((p) => ({ ...p, field: r.field, region: r.code })));
  ok(land.length === 14 && layout.starterPlots.length + layout.expansionPlots.length + land.length === 24, 'bounded maximum: 6 starter + 4 expansion + 14 regional = 24 beds');
  ok(JSON.stringify(land.map((p) => p.slot)) === JSON.stringify(Array.from({ length: 14 }, (_, i) => 11 + i)), 'regional slots continue after the Phase 3A beds (11..24)');
  // the layout mirrors the seeded server configuration cell for cell
  const seeded = [...migration.matchAll(/\{"slot":(\d+),"cell":\[(\d+),(\d+)\]/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  ok(seeded.length === 14 && JSON.stringify(seeded) === JSON.stringify(land.map((p) => [p.slot, p.gx, p.gy])), 'layout land cells == V83 garden_config.land cells');
  ok(/"maxPlots":24/.test(migration), 'the server bound is 24 beds');
  const taken = new Set([...layout.starterPlots, ...layout.expansionPlots].map((p) => `${p.gx},${p.gy}`));
  const fenceRect = { x0: Math.min(...layout.fences.flatMap((f) => [f.from[0], f.to[0]])), x1: Math.max(...layout.fences.flatMap((f) => [f.from[0], f.to[0]])),
    y0: Math.min(...layout.fences.flatMap((f) => [f.from[1], f.to[1]])), y1: Math.max(...layout.fences.flatMap((f) => [f.from[1], f.to[1]])) };
  const segDist = (px, py, [ax, ay], [bx, by]) => {
    const vx = bx - ax, vy = by - ay;
    const u = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1)));
    return Math.hypot(px - (ax + u * vx), py - (ay + u * vy));
  };
  const bedArt = sprite('plot_bed');
  const bedHalf = (bedArt.w * bedArt.scale) / 256;
  const postHalf = (sprite('fence_post').w * sprite('fence_post').scale) / 256;
  const kt = layout.sprites.find((x) => x.id === 'knowledge_tree');
  for (const c of land) {
    const field = layout.futureFields.find((f) => f.id === c.field);
    ok(field, `bed ${c.slot}: ${c.field} is a reserved future field`);
    const [x0, y0, x1, y1] = field.rect;
    ok(c.gx - 0.45 >= x0 - 1e-9 && c.gx + 0.45 <= x1 + 1e-9 && c.gy - 0.45 >= y0 - 1e-9 && c.gy + 0.45 <= y1 + 1e-9, `bed ${c.slot}: whole cell inside ${c.field}`);
    ok(Number.isInteger(c.gx) && Number.isInteger(c.gy) && c.dy === undefined, `bed ${c.slot}: a whole cell, no art offset`);
    ok(!taken.has(`${c.gx},${c.gy}`), `bed ${c.slot}: never on an existing bed`);
    taken.add(`${c.gx},${c.gy}`);
    ok(!layout.farmWalkways.some(([x, y]) => x === c.gx && y === c.gy), `bed ${c.slot}: off every walkway`);
    ok(c.gx > fenceRect.x0 && c.gx < fenceRect.x1 && c.gy > fenceRect.y0 && c.gy < fenceRect.y1, `bed ${c.slot}: inside the farm fence`);
    for (const f of layout.fences) {
      const dx = Math.max(Math.min(f.from[0], f.to[0]) - c.gx, 0, c.gx - Math.max(f.from[0], f.to[0]));
      const dy = Math.max(Math.min(f.from[1], f.to[1]) - c.gy, 0, c.gy - Math.max(f.from[1], f.to[1]));
      ok(Math.max(dx, dy) >= bedHalf + postHalf, `bed ${c.slot}: its raised frame clears the fence line and posts`);
    }
    ok(segDist(c.gx, c.gy, layout.farmGate, layout.farmGate) >= 0.9, `bed ${c.slot}: clear of the gate`);
    for (const fp of [...layout.farmProps, ...(layout.farmEdges ?? []), ...layout.trees, ...layout.bushes]) {
      ok(Math.max(Math.abs(fp.gx - c.gx), Math.abs(fp.gy - c.gy)) >= bedHalf + 0.4, `bed ${c.slot}: ${fp.key} is never drawn over its frame`);
    }
    for (const sp of layout.sprites) {
      // the scarecrow, the decorative caterpillar and every building keep their own cell and a free neighbour edge
      ok(Math.max(Math.abs(sp.gx - c.gx), Math.abs(sp.gy - c.gy)) >= 0.99, `bed ${c.slot}: ${sp.id} keeps its cell`);
    }
    ok(layout.memoryGrove.every((g) => Math.max(Math.abs(g.gx - c.gx), Math.abs(g.gy - c.gy)) > 1), `bed ${c.slot}: clear of the sacred grove`);
    ok(layout.memoryForest.every((g) => Math.hypot(g.gx - c.gx, g.gy - c.gy) > 4), `bed ${c.slot}: clear of the Memory Forest`);
    ok(Math.hypot(c.gx - kt.gx, c.gy - kt.gy) > 8, `bed ${c.slot}: far from the monumental Knowledge Tree`);
    ok(Math.hypot(c.gx - layout.pond.center[0], c.gy - layout.pond.center[1]) > 4, `bed ${c.slot}: far from the pond`);
    ok(Math.hypot(c.gx - layout.marketStall.gx, c.gy - layout.marketStall.gy) > 2, `bed ${c.slot}: clear of the market corner`);
    for (const path of layout.paths) {
      for (let i = 0; i < path.points.length - 1; i++) {
        ok(segDist(c.gx, c.gy, path.points[i], path.points[i + 1]) > 0.5 + path.width / 2, `bed ${c.slot}: clear of path ${path.id}`);
      }
    }
  }
  ok(layout.futureFields.some((f) => f.id === 'east_strip') && !land.some((c) => c.field === 'east_strip'), 'the east strip stays reserved');
  ok(!land.some((c) => c.gx === 5 && c.gy === 18), 'the scarecrow keeps its cell');
  // scene: gameplay-only, the approved bed art, one bed per owned slot, claims leave with their shadow
  ok(/const landCells = new Map\(\(LAYOUT\.landRegions \?\? \[\]\)\.flatMap/.test(canvas), 'regional cells come from the layout');
  ok(/const c = expansionCells\.get\(slot\) \?\? landCells\.get\(slot\);/.test(canvas), 'a regional bed is created by the same ownBed (approved plot_bed + shadow, once)');
  ok(/const estateLayer = gameplay\s*\? new EstateLayer\(/.test(canvas), 'the estate layer exists only in gameplay (preview unchanged)');
  ok(/hit\.label = `land-hit-\$\{c\.slot\}`/.test(estateSrc) && /hit\.hitArea = new Polygon\(poly\)/.test(estateSrc), 'each regional cell is a whole-cell touch target');
  ok(/deps\.onSelect\(deps\.hasBed\(c\.slot\) \? `plot_\$\{c\.slot\}` : `land_\$\{c\.slot\}`\)/.test(estateSrc), 'an owned cell is an ordinary bed, a locked one opens its land card');
  ok(/if \(cell\.claim\) this\.setVisible\(cell\.claim, false\)/.test(estateSrc) && /this\.deps\.shadows\.setVisible\(e\.shadow, visible\)/.test(estateSrc), 'a claim leaves with its shadow once the bed is owned');
  ok(/this\.reduced \? 0\.5 : 0\.4 \+ 0\.16 \* Math\.sin\(envT \* 1\.6\)/.test(estateSrc) && !/Math\.random/.test(estateSrc), 'buyable cells breathe on the environment clock (no randomness, frozen with reduced motion)');
  ok(!/fetch\(|axios|gardenApi|apiClient/.test(estateSrc), 'the estate layer never talks to the network');
  ok(sprite('land_claim') && sprite('land_claim').shadow && file(sprite('land_claim').file), 'the land claim ships a sprite and a shadow');

  // ---- buildings: three visible levels each, same anchor, lazy art, base sprite at level 0
  for (const [base, glow] of [['cottage', true], ['shed', false], ['market_stall', false]]) {
    for (const lv of [1, 2, 3]) {
      const e = sprite(`${base}_l${lv}`);
      ok(e && file(e.file), `${base} level ${lv} sprite exported`);
      ok(e.shadow && file(e.shadow.file), `${base} level ${lv} has its own shadow sprite`);
      if (glow || lv >= 2) ok(e.glow && file(e.glow), `${base} level ${lv} has a night glow`);
    }
  }
  ok(sprite('cottage_l3').h >= sprite('cottage').h && sprite('shed_l3').h > sprite('shed').h, 'the top levels are visibly larger than the approved base');
  for (const lv of [1, 2, 3]) {
    const b = sprite('cottage'), e = sprite(`cottage_l${lv}`);
    ok(Math.abs((e.ax - b.ax) * e.scale) < 26 && Math.abs((e.h - e.ay) * e.scale - (b.h - b.ay) * b.scale) < 26, `cottage level ${lv} stands on the approved anchor (no jump)`);
  }
  ok(/\^\(cottage\|shed\|market_stall\)_l\\d\$/.test(canvas) && /key === "land_claim" \|\| key\.startsWith\("pest_"\)\) return;/.test(canvas), 'building levels, claims and damage overlays are never part of the initial download');
  ok(/for \(let l = Math\.max\(0, Math\.floor\(level\)\); l >= 1; l--\)/.test(estateSrc) && /return base;/.test(estateSrc), 'a level without art falls back to the next lower level, then the approved sprite');
  ok(/this\.deps\.shadows\.replace\(e\.shadow, spec, e\.instanceScale\)/.test(estateSrc), 'a level swap replaces the shadow (no ghost)');
  ok(/this\.deps\.stallProps\.forEach\(\(p\) => this\.setVisible\(p, false\)\)/.test(estateSrc) && /this\.deps\.stallProps\.forEach\(\(p\) => this\.setVisible\(p, true\)\)/.test(estateSrc), 'the stall replaces the seed-corner props and level 0 keeps them');
  ok(JSON.stringify(layout.buildings.MARKET.replaces) === JSON.stringify(['crate_stack', 'seed_sacks', 'barrel']) && layout.buildings.MARKET.gx === layout.marketStall.gx, 'the stall stands on the existing market corner');
  ok(layout.sprites.filter((s) => s.key === 'cottage').length === 1 && layout.sprites.filter((s) => s.key === 'shed').length === 1, 'still exactly one cottage and one shed (levels re-texture them)');
  ok(/sid === "farmhouse" \? "cottage" : sid === "shed" \? "warehouse"/.test(view), 'the cottage and the storehouse open their building panel (no new dock button)');
  {
    // the storehouse must be seen and touched: never behind the cottage, never on a bed, a path, the pond or the grove
    const shedAt = layout.sprites.find((s) => s.key === 'shed'), cottageAt = layout.sprites.find((s) => s.key === 'cottage');
    const box = (at, e) => { const k = e.scale * (at.s ?? 1), x = (at.gx - at.gy) * 64, y = (at.gx + at.gy) * 32; return { x0: x - e.ax * k, x1: x + (e.w - e.ax) * k, y0: y - e.ay * k, y1: y + (e.h - e.ay) * k }; };
    const hiddenShare = (lv) => {
      const a = box(shedAt, sprite(lv ? `shed_l${lv}` : 'shed')), b = box(cottageAt, sprite(lv ? `cottage_l${lv}` : 'cottage'));
      const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      return w > 0 && h > 0 && cottageAt.gx + cottageAt.gy > shedAt.gx + shedAt.gy ? (w * h) / ((a.x1 - a.x0) * (a.y1 - a.y0)) : 0;
    };
    ok([0, 1, 2, 3].every((lv) => hiddenShare(lv) === 0), 'the storehouse is never covered by the cottage (its levels are visible and touchable)');
    const far = (gx, gy, r) => Math.hypot(shedAt.gx - gx, shedAt.gy - gy) >= r;
    const fenceEast = Math.max(...layout.fences.flatMap((f) => [f.from[0], f.to[0]]));
    ok(shedAt.gx - 0.8 > fenceEast, 'the storehouse stands outside the farm fence (no bed cell is taken)');
    ok(layout.paths.every((p) => p.points.every(([gx, gy]) => far(gx, gy, 0.8 + p.width / 2))), 'the storehouse keeps every path free');
    ok(layout.pond.water.every(([gx, gy]) => far(gx, gy, 2)) && layout.memoryGrove.every((g) => far(g.gx, g.gy, 2)) && layout.memoryForest.every((g) => far(g.gx, g.gy, 2))
      && far(layout.plaza.center[0], layout.plaza.center[1], 2) && far(layout.sanctuary.center[0], layout.sanctuary.center[1], layout.sanctuary.radius + 2),
      'the storehouse keeps the pond, the plaza, the Memory Grove, the Memory Forest and the sanctuary free');
  }

  // ---- staged pest damage: a creature, overlays reused for every crop, reversible, reduced-motion aware
  ok(sprite('forgotten_pest') && sprite('pest_leaf_damage') && sprite('pest_wilt'), 'caterpillar, nibbled-leaf and wilting art exist');
  ok(!sprite('pest_leaf_damage').shadow && !sprite('pest_wilt').shadow, 'damage overlays add no shadow of their own');
  ok(sprite('pest_leaf_damage').bytes + sprite('pest_wilt').bytes < 40_000, 'two small overlays instead of a damaged set per crop');
  ok(!Object.keys(manifest.sprites).some((k) => /^crop_.*_(damaged|wilt)/.test(k)), 'no per-crop damage sprites');
  ok(/const DAMAGE_ART = \{ leaf: "pest_leaf_damage", wilt: "pest_wilt" \} as const;/.test(farmSrc), 'the farm layer reuses the two overlays');
  ok(/\(v\.pestStage \?\? 0\) >= 2 \? Math\.min\(3, v\.pestStage as number\) : 0/.test(farmSrc), 'a warning (stage 1) and a resolved pest (stage 0) show no damage on the crop');
  ok(/if \(stage === 0 && bed\.crop\) \{\s*bed\.crop\.sprite\.tint = 0xffffff;/.test(farmSrc), 'recovery restores the crop art completely');
  ok(/if \(!entry\) return; \/\/ the damage still shows through the crop's tint and droop/.test(farmSrc), 'missing overlay art never breaks the bed');
  ok(/kind === "recover"\) \{[\s\S]{0,160}if \(this\.reduced\) return;/.test(farmSrc), 'the recovery feedback respects reduced motion');
  ok(/if \(before > 0 && stillPlanted && \(after === 0 \|\| after === undefined\)\) playFx\("recover", slot\);/.test(hook), 'recovery plays once, when the server reports the pest resolved');
  ok(/stage: p\.stage \?\? 1/.test(hook) && /const biting = !p\.reviewed && p\.stage >= 2;/.test(livingSrc), 'the caterpillar nibbles from stage 2 on');
  ok(/1 \+ 0\.08 \* Math\.max\(0, Math\.min\(3, p\.stage\) - 1\)/.test(livingSrc), 'its growth is bounded');
  ok(!/Math\.random/.test(farmSrc) && !/Math\.random/.test(livingSrc), 'no global randomness in the damage visuals');
  ok(/game\.rescueReview\(pest\.flashcardId, q\)/.test(memory) && /pestStageNote\(pest\.stage/.test(memory), 'the pest panel explains the stage and resolves it through the real Flashcard review');
  ok(/Sâu không bao giờ làm chết cây/.test(memory), 'the panel states that a crop never dies');
  for (const st of [1, 2, 3]) ok(model.pestStageNote(st, false).length > 30 && model.PEST_STAGE_LABEL[st], `stage ${st} is explained in plain Vietnamese`);
  ok(model.pestStageNote(1, false).includes('chưa bị ảnh hưởng'), 'a warning promises no penalty');
  const skinName = (c) => c;
  ok(model.echoLine({ code: 'RESCUE', params: { pestId: 1, count: 1, stage: 3 } }, skinName).text.includes('héo'), 'Echo words the wilting stage');
  ok(model.echoLine({ code: 'RESCUE', params: { pestId: 1, count: 1, stage: 2 } }, skinName).text.includes('gặm lá'), 'Echo words the leaf-damage stage');
  ok(model.echoLine({ code: 'RESCUE', params: { pestId: 1, count: 2 } }, skinName).action.kind === 'pest', 'Echo still opens the word (no stage: the Phase 3B hint)');

  // ---- panels and commands: keyed, confirmed, honest about rewards
  ok(/upgradeBuilding: \(code: string, level: number, materials: GardenSupply\[\], key: string\)/.test(api) && /buyLand: \(slot: number, materials: GardenSupply\[\], key: string\)/.test(api)
    && /compost: \(recipe: string, lines: GardenSupply\[\], key: string\)/.test(api) && /redeemReward: \(code: string, key: string\)/.test(api), 'every Phase 3C command carries an idempotency key');
  ok(/command\("building"/.test(hook) && /command\("land"/.test(hook) && /command\("compost"/.test(hook) && /command\("reward"/.test(hook), 'commands go through the keyed retry path');
  ok(/estate: GardenEstate;/.test(types), 'state carries the estate view');
  ok(/Xác nhận nâng cấp/.test(panels) && /Xác nhận mở luống/.test(panels) && /Xác nhận ủ/.test(panels) && /Xác nhận nhận quà/.test(panels), 'upgrades, land, compost and rewards need an explicit confirmation');
  ok(/Kho không giới hạn số nông sản/.test(panels), 'the storehouse states that inventory is never capped');
  ok(/Việc học không phải điều kiện/.test(panels), 'the land card states that learning is not a requirement');
  ok(/không mua được bằng Đồng Echo, không đổi ra Đồng Echo/.test(panels), 'contribution is presented as a record, never a currency');
  ok(/const planned = reward\.status === "UNAVAILABLE";/.test(panels) && /\{!planned && reward\.cost !== null && \(/.test(panels), 'a reward without a delivery shows no price and no button');
  ok(/reward\.status === "OPEN" && \(confirming \?/.test(panels), 'only an OPEN reward can be redeemed');
  ok(!/Sparkles|✨/.test(panels) && /BrandWhaleIcon/.test(panels), 'Echo branding uses the whale icon, never a sparkle');
  ok(!/fetch\(|apiClient|gardenApi/.test(panels), 'panels act only through the gameplay hook');
  ok(/readyIds\.slice\(0, HARVEST_BATCH\)/.test(overlay) && /const HARVEST_BATCH = 12;/.test(overlay), 'a large farm harvests in rounds of the server limit');
  ok(/"cottage" \| "warehouse" \| "stall" \| "rewards"/.test(overlay), 'building and reward sheets are overlay panels, not HUD buttons');
  for (const code of ['COTTAGE', 'WAREHOUSE', 'MARKET']) {
    ok(model.BUILDING_INFO[code] && model.BUILDING_INFO[code].levelNames.length === 4, `${code} has a name for every level`);
  }
  for (const code of ['freshBonus', 'forecastExtra', 'compostDaily', 'premiumCompostDaily', 'featuredExtra', 'stapleCapExtra', 'packCapExtra']) {
    ok(!model.effectText({ code, value: 1 }).includes(code), `effect ${code} is worded in Vietnamese`);
  }
  ok(model.gateText({ code: 'HARVESTS', have: 999, need: 150, met: true }).includes('150/150'), 'gates are worded without overshooting');
  for (const code of ['BUILDING_LEVEL', 'MATERIALS_MISMATCH', 'LAND_REGION_LOCKED', 'COMPOST_CAP', 'REWARDS_CLOSED', 'REWARD_UNAVAILABLE', 'INSUFFICIENT_CONTRIBUTION', 'REWARD_LIMIT']) {
    ok(model.errorMessage(code, { level: 9, missing: 12, units: 8 }) !== model.errorMessage('___'), `${code} has its own sentence`);
  }
  ok(model.errorMessage('REWARDS_CLOSED').includes('vẫn được ghi lại'), 'a closed counter tells the player nothing was lost');
  ok(model.skinRequirement({ unlockKind: 'REWARD', masteryTier: 0, masteryOk: true, coinPrice: 0, learningDays: 0 }, 'Dưa hấu').includes('Quà Echo'), 'a reward cultivar says where it comes from');
  // the reward cultivar ships like every other skin: four stages with shadows
  for (const st of [1, 2, 3, 4]) {
    const e = sprite(`cskin_watermelon_echo_s${st}`);
    ok(e && file(e.file) && e.shadow && file(e.shadow.file), `Dưa Hấu Sóng Echo stage ${st} sprite + shadow`);
  }
  // disabled by default, entitlement rewards undeliverable by data
  ok(/CONSTRAINT ck_garden_reward_deliverable CHECK \(NOT enabled OR delivery <> 'UNAVAILABLE'\)/.test(migration), 'the schema refuses to enable a reward without a delivery');
  const appYml = readFileSync(new URL('../../backend/src/main/resources/application.yml', import.meta.url), 'utf8');
  ok(/rewards-enabled: \$\{APP_GARDEN_REWARDS_ENABLED:false\}/.test(appYml), 'the reward counter is off by default');
}

// ---------------------------------------------------------------------------------------------------------------
// 17. Phase 3D — Echo Coin, soil, farming supplies, categorised market, harvest bonus, lifetime records
// ---------------------------------------------------------------------------------------------------------------
{
  const { existsSync, readdirSync } = await import('node:fs');
  const model = await import(new URL('game/gardenModel.ts', root));
  const ui = src('game/gardenUi.tsx');
  const farming = src('game/FarmingPanels.tsx');
  const economy = src('game/EconomyPanels.tsx');
  const plotPanel = src('game/PlotPanel.tsx');
  const hook = src('game/useEchoGarden.ts');
  const farmLayer = src('world/farmLayer.ts');
  const api = readFileSync(new URL('../src/services/gardenApi.ts', import.meta.url), 'utf8');
  const rules = readFileSync(new URL('../../backend/src/main/resources/db/migration/exams/V85__echo_garden_phase3d_farming_rules.sql', import.meta.url), 'utf8');
  const schema = readFileSync(new URL('../../backend/src/main/resources/db/migration/exams/V84__echo_garden_phase3d_farming_schema.sql', import.meta.url), 'utf8');
  const uiFile = (name) => existsSync(new URL(`../public/garden/ui/${name}`, import.meta.url));
  const worldFile = (name) => existsSync(new URL(`../public/garden/world/${name}`, import.meta.url));

  // ---- the Echo Coin: one icon everywhere, rendered art with the whale mark, one currency
  for (const f of ['echo_coin.webp', 'echo_coin_icon_48.webp', 'echo_coin_icon_96.webp', 'echo_coin_stack.webp']) ok(uiFile(f), `coin art ${f} ships`);
  ok(/export function CoinIcon/.test(ui) && /ECHO_COIN_ICON = "\/garden\/ui\/echo_coin_icon_48\.webp"/.test(ui), 'every coin amount uses the one Echo Coin icon');
  ok(!/<circle cx="10" cy="10" r="9" fill="#F4B63F"/.test(ui), 'the anonymous leaf coin is gone');
  ok(model.COIN_NAME === 'Đồng Echo' && model.coinsText(1500).includes('Đồng Echo'), 'the currency is named Đồng Echo');
  for (const f of readdirSync(new URL('game/', root)).filter((n) => /\.tsx?$/.test(n))) {
    ok(!/(?<![\p{L}\p{N}_])xu(?![\p{L}\p{N}_])/u.test(src(`game/${f}`)), `${f} no longer calls the currency "xu"`);
  }
  ok(/Đồng Echo là tiền trong trò chơi, không đổi ra tiền thật/.test(economy), 'the market states the coin is game currency, not money');
  ok(!/UPDATE public\.garden_profile|UPDATE public\.garden_ledger|DELETE FROM/i.test(rules + schema), 'the migrations rewrite no balance, ledger or history row');
  ok(/growth_model SMALLINT NOT NULL DEFAULT 1/.test(schema), 'existing plantings keep the earlier growth model');
  ok(/ON CONFLICT \(key\) DO NOTHING/.test(rules) && !/CREATE TABLE|ALTER TABLE/i.test(rules), 'the rules migration is data only');

  // ---- supplies: every catalogue item has art, a Vietnamese name, a worded effect from server numbers
  const codes = ['FERTILIZER', 'FERTILIZER_PREMIUM', 'MULCH', 'CROP_TONIC', 'RAIN_COVER', 'SHADE_NET', 'DRAINAGE', 'ORGANIC_SPRAY', 'INSECT_NET', 'WELL_WATER'];
  const effects = { MULCH: 'MULCH', CROP_TONIC: 'TONIC', RAIN_COVER: 'RAIN_COVER', SHADE_NET: 'SHADE', DRAINAGE: 'DRAINAGE', ORGANIC_SPRAY: 'PEST_SPRAY', INSECT_NET: 'PEST_NET', WELL_WATER: 'MOISTURE' };
  for (const code of codes) {
    ok(uiFile(`item_${code}.webp`), `${code} has product art`);
    ok(model.SUPPLY_INFO[code] && model.SUPPLY_INFO[code].title.length > 3 && model.SUPPLY_INFO[code].when.length > 10, `${code} has a name and a reason to buy it`);
    ok(new RegExp(`"${code}":\\{"category":"(CARE|WEATHER|PEST|UTILITY)"`).test(rules), `${code} is seeded with a shop category`);
    ok(model.supplyArtUrl(code) === `/garden/ui/item_${code}.webp`, `${code} art url`);
  }
  for (const [code, effect] of Object.entries(effects)) {
    const text = model.supplyEffectText({ code, effect, hours: 12, value: effect === 'MOISTURE' ? 30 : effect === 'DRAINAGE' ? 65 : effect === 'PEST_SPRAY' ? 18 : 0.6 }, []);
    ok(text.length > 20 && !text.includes(effect), `${code} effect is worded in Vietnamese`);
  }
  ok(model.supplyEffectText({ code: 'ORGANIC_SPRAY', effect: 'PEST_SPRAY', hours: 12, value: 18 }, []).includes('vẫn chờ bạn ôn thật'),
    'the spray says the overdue word still needs a real review');
  ok(model.supplyEffectText({ code: 'WELL_WATER', effect: 'MOISTURE', hours: 0, value: 30 }, []).includes('không thúc cây lớn'),
    'well water is moisture only: the growth boost stays a learning reward');
  ok(!/'WATER',\s+'TOOL'|\('WATER'/.test(rules), 'the Flashcard-review water is still never sold');

  // ---- bed overlays: reusable art for every crop, lazy, reversible
  const overlayKeys = ['soil_dry', 'soil_wet', 'sup_mulch', 'sup_drainage', 'sup_rain_cover', 'sup_insect_net', 'sup_shade_net', 'sup_tag_spray', 'sup_tag_tonic'];
  for (const key of overlayKeys) {
    const e = manifest.sprites[key];
    ok(e && worldFile(e.file), `${key} sprite ships in the manifest`);
    ok(new RegExp(`${key}: -?\\d`).test(farmLayer), `${key} has a draw order on the bed`);
  }
  const growing = (extra) => ({ ready: false, soil: null, protections: [], ...extra });
  ok(model.bedExtras(growing({ soil: { status: 'DRY' } }), 0).join() === 'soil_dry', 'thirsty soil shows the cracked crust');
  ok(model.bedExtras(growing({ soil: { status: 'WET' } }), 0).join() === 'soil_wet', 'waterlogged soil shows puddles');
  ok(model.bedExtras({ ready: true, soil: { status: 'DRY' }, protections: [] }, 0).length === 0, 'a ripe crop shows no soil trouble');
  const cover = { itemCode: 'RAIN_COVER', effect: 'RAIN_COVER', appliedAt: '2026-11-02T00:00:00Z', expiresAt: '2026-11-02T12:00:00Z' };
  ok(model.bedExtras(growing({ protections: [cover] }), Date.parse('2026-11-02T06:00:00Z')).join() === 'sup_rain_cover', 'an active cover is drawn');
  ok(model.bedExtras(growing({ protections: [cover] }), Date.parse('2026-11-02T12:00:01Z')).length === 0, 'an expired cover is no longer drawn');
  ok(model.bedExtras(growing({ protections: [{ itemCode: 'MULCH', effect: 'MULCH', appliedAt: 'x', expiresAt: null }] }), 1e15).join() === 'sup_mulch', 'mulch stays until harvest');
  ok(/private async ensureExtra/.test(farmLayer) && /this\.deps\.loadTexture\(entry\.file\)/.test(farmLayer), 'overlay art loads on demand');
  ok(/"treat" \| "spray"/.test(farmLayer) && /if \(this\.reduced\) return;\s+const r = new Sprite\(this\.deps\.ring\);\s+r\.anchor\.set\(0\.5\);\s+r\.position\.set\(bed\.x, bed\.y - 6\);\s+r\.tint = kind === "spray"/.test(farmLayer),
    'treatment feedback is a one-shot effect and silent under reduced motion');
  ok(!/setInterval|requestAnimationFrame/.test(farmLayer), 'no continuous effect loop of its own');

  // ---- the soil card and the shelf present server facts only
  ok(!/Math\.random|Date\.now\(\)/.test(farming), 'the farming panels compute nothing from the client clock or chance');
  ok(/state\.farming\?\.soil/.test(farming) && /s\.moisture/.test(farming) && /rules\.dryBelow/.test(farming), 'the moisture meter reads the server soil and its lines');
  ok(/role="meter"/.test(farming) && /aria-valuenow/.test(farming), 'the moisture meter is accessible');
  const note = (soil, ready = false) => model.soilNote({ ready, soil }, 0, (c) => c);
  ok(note({ status: 'DRY', slowing: true, nextStatus: null, nextChangeAt: null }).tone === 'warn', 'dry soil is diagnosed');
  ok(note({ status: 'DRY', slowing: true }).text.includes('Tưới nước'), 'the dry diagnosis names the cure');
  ok(note({ status: 'WET', slowing: true }).text.includes('Rãnh thoát nước'), 'the waterlogged diagnosis names the cure');
  ok(note({ status: 'OK', slowing: false, nextStatus: 'DRY', nextChangeAt: new Date(3 * 3600e3).toISOString() }).text.includes('đất sẽ khô'), 'the forecast warns before the soil dries');
  ok(note({ status: 'OK', slowing: false, tierCap: null }, true).text.includes('không cần tưới'), 'a ripe crop needs no more care');
  ok(model.soilQualityNote({ tierCap: 'GOOD', stressShare: 0.6, careFactor: 0 }, (c) => c).includes('tối đa hạng GOOD'), 'a capped crop is told its best tier and how to recover');
  ok(model.soilQualityNote({ tierCap: null, stressShare: 0.05, careFactor: 1 }, (c) => c) === null, 'healthy soil says nothing about lost quality');
  ok(model.thirstLabel(1.5) === 'Háo nước' && model.thirstLabel(0.7) === 'Chịu hạn' && model.thirstLabel(1.0) === 'Uống vừa', 'crop thirst is worded');
  ok(/data-testid=\{`garden-seed-care-\$\{c\.code\}`\}/.test(plotPanel), 'the seed picker shows each crop\'s care needs');

  // ---- commands: keyed, never optimistic about soil, the server decides
  ok(/treat: \(plantingId: number, itemCode: string, key: string\)/.test(api) && /\/garden\/plantings\/\$\{plantingId\}\/treat/.test(api), 'the treat command carries an idempotency key');
  ok(/const treat = useCallback\(async \(plot: GardenPlot, itemCode: string\)/.test(hook) && /command\("treat", \(key\) => gardenApi\.treat/.test(hook), 'supplies go through the keyed retry path');
  ok(!/soil:\s*\{[^}]*moisture:/.test(hook), 'the client never writes a soil state of its own');
  ok(/records: \(\) => apiClient\.get<GardenRecords>\('\/garden\/records'\)/.test(api), 'farm records are a read-only request');
  for (const code of ['TREATMENT_ACTIVE', 'TREATMENT_USED', 'SOIL_TOO_WET', 'NO_PEST', 'TREATMENT_NOT_NEEDED', 'FARMING_CLOSED']) {
    ok(model.errorMessage(code, {}) !== model.errorMessage('___'), `${code} has its own sentence`);
  }

  // ---- the market: real goods on categorised shelves, two-step purchase, future shelves are never buttons
  ok(model.SHOP_CATEGORIES.map((c) => c.id).join() === 'SEEDS,CARE,WEATHER,PEST,UTILITY', 'five shelves');
  ok(model.SHOP_UPCOMING.length === 1, "one shelf is still announced for later (decorations opened in Phase 3E, farm protection and animals in Phase 3H)");
  const upcoming = farming.slice(farming.indexOf('export function UpcomingShelves'), farming.indexOf('export function ShopOffer'));
  ok(!/<button|onClick|ActionButton/.test(upcoming) && /Chưa có món nào ở các kệ này được bán/.test(upcoming), 'a future shelf offers nothing to buy');
  ok(/data-testid=\{`garden-offer-confirm-\$\{offer\.code\}`\}/.test(farming) && /setConfirming\(true\)/.test(farming), 'a purchase is choose, then confirm');
  ok(/game\.marketBuy\(offer, 1\)/.test(farming) && !/gardenApi\.marketBuy/.test(farming), 'a purchase goes through the gameplay hook');
  ok(/Đang có \{owned\}/.test(farming) && /Còn \{offer\.remaining\}\/\{offer\.dailyCap\} lượt hôm nay/.test(farming), 'a product shows the owned quantity and the daily turns');
  ok(/categoryOf\(o\) === active/.test(economy) && /<UpcomingShelves \/>/.test(economy), 'the stall shows one shelf at a time');
  ok(!/Sparkles|✨/.test(farming + economy + plotPanel), 'no sparkle icon');

  // ---- harvest: produce + a small bonus; records never fall with a sale
  ok(/data-testid="garden-harvest-coins"/.test(src('game/HarvestFlow.tsx')), 'the harvest result shows the coin bonus');
  ok(/Số đã thu hoạch là thành tích trọn đời/.test(farming), 'the records explain that selling never lowers harvests');
  ok(/"harvestBonus":\{"share":0\.06,"min":1,"dailyCap":400\}/.test(rules), 'the harvest bonus is a small capped share');
}

// 18. Phase 3E — cosmetic catalogue, house families, vegetation / monument / decoration art, placement regions, shop
{
  const { auditCosmetics } = await import(new URL('./audit-garden-cosmetics.mjs', import.meta.url));
  const cos = await import(new URL('world/cosmetics.ts', root));
  const model = await import(new URL('game/gardenModel.ts', root));
  const api = readFileSync(new URL('../src/services/gardenApi.ts', import.meta.url), 'utf8');
  const hook = src('game/useEchoGarden.ts');
  const view = src('EchoGardenView.tsx');
  const overlay = src('game/GardenOverlay.tsx');
  const panels = src('game/CosmeticPanels.tsx');
  const layer = src('world/cosmeticLayer.ts');
  const economy = src('game/EconomyPanels.tsx');
  const sql = readFileSync(new URL('../../backend/src/main/resources/db/migration/exams/V86__echo_garden_phase3e_cosmetics.sql', import.meta.url), 'utf8');
  const audit = auditCosmetics();
  const { catalogue } = audit;
  const S = audit.summary;

  // ---- the catalogue is real: every product has a server row and its own art, nothing is a placeholder
  ok(S.missingAssets === 0 && S.invalidReferences === 0, `no missing or broken cosmetic art (${audit.missing.concat(audit.invalid).slice(0, 4).join(', ')})`);
  ok(S.duplicateArt === 0, `no product reuses another picture (${JSON.stringify(audit.duplicates.slice(0, 2))})`);
  ok(S.usableProducts === S.storeProducts && S.storeProducts === 115, 'all 115 products are usable');
  const crops = ['WHEAT', 'TOMATO', 'CORN', 'STRAWBERRY', 'ROSE', 'WATERMELON', 'PUMPKIN', 'MOONFLOWER', 'FROST_LILY', 'CRYSTAL_ORCHID'];
  for (const crop of crops) ok(S.cropSkins.perCrop[crop] >= 5, `${crop} has at least five new four-stage skins`);
  ok(S.cropSkins.complete >= 50 && S.cropSkins.stageSprites >= 200, 'fifty new skins, two hundred stage sprites');
  ok(S.houses.themes >= 5 && S.houses.classicLevels === 4, 'five house families across levels 0-3, plus the classic cottage');
  for (const f of ['TREE', 'SHRUB', 'FLOWER']) ok(S.vegetation[f] >= 5, `${f}: five appearances`);
  ok(S.monumentSets >= 5 && S.cosmeticSockets >= 2, 'five monument sets on their own sockets');
  for (const f of ['LANTERN', 'PLANTER', 'BENCH', 'SIGN', 'STATUE']) ok(S.decorations[f] >= 5, `${f}: five designs`);
  ok(S.fences >= 5 && S.paths >= 5 && S.beds >= 5, 'five fence, path and bed-frame styles');
  ok(S.collections === 10 && catalogue.collections.every((c) => catalogue.skins.concat(catalogue.cosmetics).some((p) => p.collection === c.code)),
    'ten collections, none empty');

  // ---- stage sprites grow: every skin's four stages are four different pictures that keep the bed anchor
  for (const s of catalogue.skins) {
    const st = [1, 2, 3, 4].map((n) => manifest.sprites[`cskin_${s.artKey}_s${n}`]);
    ok(new Set(st.map((e) => `${e.w}x${e.h}:${e.bytes}`)).size === 4, `${s.code}: four distinct stages`);
    ok(st[3].h > st[0].h, `${s.code}: the ripe stage stands taller than the seedling`);
    ok(st.every((e) => e.shadow && Math.abs(e.ax - e.w / 2) < e.w * 0.3 && e.ay > e.h * 0.55), `${s.code}: every stage has a contact shadow and a ground anchor`);
    ok(model.cosmeticArtUrl('SKIN', s.artKey) !== undefined, `${s.code}: resolvable art`);
  }
  // crop skins stay cosmetic: the seed never touches a yield, price or growth column
  ok(!/UPDATE\s+garden_crop_def|UPDATE\s+garden_item_def|yield|sell_price|growth_minutes/i.test(sql.slice(sql.indexOf('INSERT INTO garden_skin_def'))), 'skins seed no gameplay value');

  // ---- houses: one footprint that grows up, never a recolour
  const sp = manifest.sprites;
  for (const theme of ['classic', 'blossom', 'sungold', 'amber', 'frost', 'longphung']) {
    const lv = [0, 1, 2, 3].map((l) => sp[cos.houseSpriteKey(sp, theme === 'classic' ? null : theme, l)]);
    // sizes in scene units (sprite px x manifest scale): the roof line above the ground anchor must really rise
    const rise = lv.map((e) => e.ay * e.scale);
    const cost = lv.map((e) => e.bytes);
    ok(rise[2] > rise[1] * 1.22, `${theme}: level 2 is a real second storey (${rise[1].toFixed(0)} -> ${rise[2].toFixed(0)})`);
    ok(lv[1].w * lv[1].scale > lv[0].w * lv[0].scale && cost[1] > cost[0], `${theme}: level 1 extends the cottage`);
    ok(lv[3].h * lv[3].scale > lv[2].h * lv[2].scale && cost[3] > cost[2], `${theme}: level 3 is the grandest`);
    ok(lv.every((e) => e.shadow), `${theme}: every level casts a shadow`);
    for (let l = 1; l <= 3; l++) {
      const key = `house_${theme}_l${l}`;
      ok(manifest.houses[key] && Number.isFinite(manifest.houses[key].chimney?.dx), `${key}: chimney metadata for the smoke`);
    }
  }
  ok(cos.houseSpriteKey(sp, null, 0) === 'cottage', 'the approved cottage is still the level-0 house');
  ok(cos.houseSpriteKey(sp, 'no_such_theme', 2) === 'house_classic_l2', 'an unknown family falls back to the island\'s own house');
  ok(cos.houseSpriteKey({}, 'frost', 3) === 'cottage', 'a missing manifest never leaves the cottage empty');
  ok(cos.houseSpriteKey(sp, '../x', 1) === 'house_classic_l1', 'an art key is validated before it becomes a file name');

  // ---- vegetation / fences / beds re-dress the island's own sprites and always fall back
  for (const [family, map] of Object.entries(cos.VEGETATION)) {
    for (const base of Object.keys(map)) {
      ok(layout.trees.concat(layout.bushes).some((t) => t.key === base), `${base} stands on the island`);
      ok(cos.vegetationFamily(base) === family, `${base} belongs to ${family}`);
    }
  }
  ok(cos.vegetationFamily('pine_a') === null && cos.vegetationSpriteKey(sp, 'pine_a', 'sakura') === null, 'the forest is never re-dressed');
  const tree = catalogue.cosmetics.find((c) => c.category === 'TREE');
  ok(cos.vegetationSpriteKey(sp, 'orchard', tree.artKey) === `veg_tree_${tree.artKey}_a`, 'an orchard tree wears the equipped appearance');
  ok(cos.vegetationSpriteKey(sp, 'orchard', 'missing') === null, 'an unknown appearance keeps the island\'s own tree');
  const fence = catalogue.cosmetics.find((c) => c.category === 'FENCE');
  for (const part of ['x_a', 'x_b', 'x_long', 'y_a', 'y_b', 'post', 'gate']) {
    const own = sp[`fence_${part}`];
    const worn = sp[cos.fenceSpriteKey(sp, `fence_${part}`, fence.artKey)];
    ok(own && worn, `fence_${part}: a styled bay exists`);
    if (part !== 'gate' && part !== 'post') ok(Math.abs(worn.w - own.w) < own.w * 0.35, `fence_${part}: the styled bay spans the same run`);
  }
  ok(cos.fenceSpriteKey(sp, 'fence_x_a', null) === null && cos.fenceSpriteKey(sp, 'oak_round', 'bamboo') === null, 'no style = the island\'s own fence');
  const bedOwn = sp.plot_bed;
  for (const b of catalogue.cosmetics.filter((c) => c.category === 'BED')) {
    const e = sp[cos.bedSpriteKey(sp, b.artKey)];
    ok(e && e !== bedOwn, `${b.code}: its own frame`);
    // the frame may only decorate the rim: the soil rectangle, its anchor and therefore every crop position stay put
    ok(Math.abs(e.ax / e.scale - bedOwn.ax / bedOwn.scale) < 14 && Math.abs((e.h - e.ay) / e.scale - (bedOwn.h - bedOwn.ay) / bedOwn.scale) < 14,
      `${b.code}: the frame keeps the bed anchor`);
    ok(e.w * e.scale < bedOwn.w * bedOwn.scale * 1.3, `${b.code}: the frame stays inside its cell`);
  }
  ok(cos.bedSpriteKey(sp, null) === 'plot_bed' && cos.bedSpriteKey(sp, 'missing') === 'plot_bed', 'no frame = the approved bed');
  ok(/for \(const e of this\.deps\.beds\(\)\)/.test(layer) && !/position\.set|hitArea/.test(layer.slice(layer.indexOf('async dressBeds'), layer.indexOf('private async dressPaths'))),
    'a bed frame swaps the texture only: plot coordinates and hit targets are untouched');

  // ---- paths: deterministic stamps on the island's own curves
  const stamps = cos.pathStamps(layout.paths);
  ok(stamps.length > 60 && stamps.length < 420, `path stamps are bounded (${stamps.length})`);
  ok(JSON.stringify(stamps) === JSON.stringify(cos.pathStamps(layout.paths)), 'stamps are deterministic');
  ok(new Set(stamps.map((s) => s.form)).size === 3, 'three stamp forms alternate');
  const plotCells = [...layout.starterPlots, ...layout.expansionPlots, ...layout.landRegions.flatMap((r) => r.plots)];
  ok(plotCells.length === 24, 'twenty-four plots are known to the layout');
  ok(stamps.every((s) => plotCells.every((p) => Math.abs(s.gx - p.gx) > 0.5 || Math.abs(s.gy - (p.gy + (p.dy ?? 0))) > 0.5)), 'no stamp lies on a bed');

  // ---- decoration regions: one definition (server config = client layout), clear of everything that is used
  const cfg = catalogue.config;
  ok(JSON.stringify(layout.decorRegions.map((r) => [r.code, r.rect])) === JSON.stringify(cfg.regions.map((r) => [r.code, r.rect])),
    'the layout mirrors the server\'s decoration regions exactly');
  ok(sql.includes(`"maxPlaced":${cfg.maxPlaced}`) && sql.includes(`"snap":${cfg.snap}`), 'the limits are seeded server-side');
  const regions = cfg.regions.map((r) => ({ code: r.code, nameVi: r.nameVi, x0: r.rect[0], y0: r.rect[1], x1: r.rect[2], y1: r.rect[3] }));
  const inside = (gx, gy, pad = 0) => regions.some((r) => gx > r.x0 - pad && gx < r.x1 + pad && gy > r.y0 - pad && gy < r.y1 + pad);
  for (const p of plotCells) ok(!inside(p.gx, p.gy + (p.dy ?? 0), 0.5), `plot ${p.slot ?? p.id} is outside every decoration region`);
  for (const f of layout.futureFields) {
    const [x0, y0, x1, y1] = f.rect;
    ok(regions.every((r) => r.x1 <= x0 || r.x0 >= x1 || r.y1 <= y0 || r.y0 >= y1), `field ${f.id} is outside every decoration region`);
  }
  for (const f of layout.fences) {
    for (let t = 0; t <= 1.0001; t += 0.05) {
      ok(!inside(f.from[0] + (f.to[0] - f.from[0]) * t, f.from[1] + (f.to[1] - f.from[1]) * t), 'a fence run crosses no decoration region');
    }
  }
  ok(stamps.every((s) => !inside(s.gx, s.gy)), 'no path runs through a decoration region');
  ok(layout.trees.concat(layout.bushes).every((t) => !inside(t.gx, t.gy)), 'no tree or bush stands in a decoration region');
  ok(!inside(layout.marketStall.gx, layout.marketStall.gy, layout.marketStall.radius) && !inside(...layout.plaza.center, layout.plaza.radius)
    && !inside(...layout.sanctuary.center) && !inside(...layout.pond.center), 'stall, plaza, sanctuary and pond are clear');
  ok(regions.every((r) => r.x0 >= 0 && r.y0 >= 0 && r.x1 <= layout.grid.width && r.y1 <= layout.grid.height), 'every region is on the island grid');
  ok(regions.length === 10 && new Set(regions.map((r) => r.code)).size === 10, 'ten named regions');
  // the pond (water polygon + pier), the memory grove / forest and the baked rocks
  const inWater = (x, y) => {
    let c = false;
    const w = layout.pond.water;
    for (let i = 0, j = w.length - 1; i < w.length; j = i++) {
      if ((w[i][1] > y) !== (w[j][1] > y) && x < ((w[j][0] - w[i][0]) * (y - w[i][1])) / (w[j][1] - w[i][1]) + w[i][0]) c = !c;
    }
    return c;
  };
  for (const r of regions) {
    for (let x = r.x0; x <= r.x1 + 1e-9; x += 0.25) for (let y = r.y0; y <= r.y1 + 1e-9; y += 0.25) ok(!inWater(x, y), `${r.code}: no point lies in the pond`);
  }
  ok(!inside(...layout.pond.pier.from, 0.3) && !inside(...layout.pond.pier.to, 0.3), 'the pier is clear');
  ok(layout.memoryGrove.concat(layout.memoryForest).every((g) => !inside(g.gx, g.gy, 0.5)), 'no Memory Tree spot is in a decoration region');
  ok(Object.values(layout.baked).filter(Array.isArray).flat().every((p) => !Array.isArray(p) || !inside(p[0], p[1])), 'no baked rock lies in a decoration region');
  // visibility behind taller sprites needs the sprites' alpha: the art pipeline's validator owns that check
  const validatorUrl = new URL('../../imports/sources-assets/owner-authored/echo-garden-world-v2/scripts/validate_decor_regions.py', import.meta.url);
  if (existsSync(validatorUrl)) {
    const validator = readFileSync(validatorUrl, 'utf8');
    ok(/MAX_HIDDEN = 0\.2/.test(validator) && /knowledge_tree_e/.test(validator) && /house_/.test(validator) && /mtree_/.test(validator),
      'the region validator checks visibility against monument eras, house families and grown Memory Trees');
  }
  ok(/validate_decor_regions\.py/.test(layout.decorNote), 'the layout names the validator of its decoration regions');

  // ---- the placement pre-check mirrors the server rule (the server still decides)
  const world = { regions, decor: [{ id: 1, art: 'bench_tea', gx: 9, gy: 25.25, footprint: 0.4 }] };
  ok(cos.snapTo(15.13, 0.25) === 15.25 && cos.snapTo(15.12, 0.25) === 15, 'positions snap to the quarter-tile grid');
  ok(cos.placementCheck(world, 0.3, 10.5, 25.25).ok && cos.placementCheck(world, 0.3, 10.5, 25.25).region.code === 'SOUTH_SHORE', 'a free spot inside a region is allowed');
  ok(cos.placementCheck(world, 0.3, 9.5, 25.25).reason === 'OVERLAP', 'two footprints may not overlap');
  ok(cos.placementCheck(world, 0.3, 9.25, 25.25, 1).ok, 'a decoration being moved never blocks itself');
  ok(cos.placementCheck(world, 0.3, 19.5, 12.5).reason === 'OUT_OF_BOUNDS', 'ground behind the crown of the Knowledge Tree is not a decoration region');
  ok(cos.placementCheck(world, 0.3, 12.5, 12.6).reason === 'OUT_OF_BOUNDS', 'the plaza is not a decoration region');
  ok(cos.placementCheck(world, 0.3, 8, 18).reason === 'OUT_OF_BOUNDS', 'a farm bed is not a decoration region');
  for (const d of catalogue.cosmetics.filter((c) => c.category === 'DECOR')) {
    ok(d.footprint >= 0.15 && d.footprint <= 0.75 && d.maxOwned >= 1 && d.maxOwned <= 4, `${d.code}: a bounded footprint and quantity`);
    ok(sp[`decor_${d.artKey}`].shadow, `${d.code}: stands on a contact shadow`);
  }
  ok(catalogue.cosmetics.filter((c) => c.category !== 'DECOR').every((c) => c.maxOwned === 1 && c.footprint === 0), 'an equipped appearance is owned once');

  // ---- lazy loading: the catalogue costs nothing until an appearance is worn or previewed
  const lazy = Object.keys(sp).filter((k) => cos.isLazyCosmeticSprite(k));
  ok(lazy.length >= 140, `cosmetic sprites are lazy (${lazy.length})`);
  for (const k of ['fence_x_a', 'fence_y_b', 'fence_post', 'fence_gate', 'plot_bed', 'cottage', 'knowledge_tree', 'orchard', 'crop_wheat_s1']) {
    ok(!cos.isLazyCosmeticSprite(k), `${k} still loads with the scene`);
  }
  for (const k of ['house_frost_l2', 'house_classic_l1', 'veg_tree_sakura_a', 'kt_cos_dragon_base', 'decor_bench_garden', 'path_jade_b', 'bedframe_bamboo', 'fence_bamboo_x_a', 'fence_longphung_gate']) {
    ok(cos.isLazyCosmeticSprite(k), `${k} loads on demand`);
  }
  ok(/if \(isLazyCosmeticSprite\(key\)\) return;/.test(canvas), 'the scene skips cosmetic art at entry');
  ok(/this\.deps\.loadTexture\(entry\.file\)/.test(layer) && /private gen = 0|gen !== this\.gen/.test(layer), 'the layer loads on demand and drops stale loads');
  ok(/destroy\(\)\s*\{/.test(layer) && !/setInterval|requestAnimationFrame|fetch\(|apiClient/.test(layer), 'the layer owns no loop and no network');
  ok(/this\.reduced \? 0 :/.test(layer), 'charm sway stops under reduced motion');
  const lazyBytes = lazy.reduce((n, k) => n + sp[k].bytes + (sp[k].glowBytes ?? 0) + (sp[k].shadow?.bytes ?? 0), 0);
  ok(lazyBytes < 9 * 1024 * 1024, `the whole lazy catalogue is ${(lazyBytes / 1048576).toFixed(2)} MiB`);
  const worst = Math.max(...Object.keys(manifest.houses).map((k) => sp[k].bytes + (sp[k].glowBytes ?? 0) + (sp[k].shadow?.bytes ?? 0)));
  ok(worst < 256 * 1024, `the heaviest house costs ${(worst / 1024).toFixed(0)} KiB`);

  // ---- commands: keyed, confirmed, never optimistic; a try-on is presentation only
  for (const [fn, path] of [['buyCosmetic', '/garden/cosmetics/buy'], ['equipCosmetic', '/garden/cosmetics/equip'], ['placeDecor', '/garden/decor/place']]) {
    ok(new RegExp(`${fn}: \\([^)]*key: string\\)`).test(api) && api.includes(`'${path}'`), `${fn} carries an idempotency key`);
  }
  ok(/moveDecor: \(id: number, gx: number, gy: number, key: string\)/.test(api) && /storeDecor: \(id: number, key: string\)/.test(api), 'move / store are keyed');
  ok(/cosmetics: \(\) => apiClient\.get<GardenCosmeticShop>\('\/garden\/cosmetics'\)/.test(api), 'the shop is a read-only request');
  for (const fn of ['buyCosmetic', 'equipCosmetic', 'placeDecor', 'moveDecor', 'storeDecor']) {
    ok(new RegExp(`command\\("(cosmetic|decor)", \\(key\\) => gardenApi\\.${fn}\\(`).test(hook), `${fn} goes through the keyed retry path`);
    ok(!new RegExp(`gardenApi\\.${fn}`).test(panels + view + overlay), `${fn} is never called from a component`);
  }
  // Phase 3F (owner decision 2026-10-12): an item sold for Echo Coins may also be bought by bank transfer — through the
  // EXISTING Premium SePay sheet, never a payment UI or merchant data of the garden's own (section 18 checks the rest).
  ok(!/qr\.sepay|vietqr|img\?bank=|accountNumber\s*[:=]\s*["'`]\d/i.test(panels), 'the shop builds no QR and knows no bank account');
  ok(/shop\?\.checkoutEnabled \? pay : undefined/.test(panels), 'the bank-transfer button exists only while the server reports checkout open');
  ok(!/garden_cosmetic_sku\s*\(/.test(sql.slice(sql.indexOf('-- seed'))) || !/INSERT INTO garden_cosmetic_sku/.test(sql), 'no real-money product is seeded');
  ok(/setConfirming\(true\)/.test(panels) && /game\.buyCosmetic\(/.test(panels), 'a purchase is choose, then confirm');
  ok(/equipped: \{ \.\.\.serverLook\.equipped, \[tryOn\.item\.category\]: tryOn\.item\.artKey \}/.test(view), 'a try-on overrides the picture only');
  // Phase 3G: `home` = playing the player's own island (placement never exists while visiting another island)
  ok(/const placement = useMemo\(/.test(view) && /placement=\{(?:playing|home) \? placement : null\}/.test(view), 'placement mode is entered once per decoration, not once per render');
  ok(/if \(p && cur && p\.art === cur\.art && p\.footprint === cur\.footprint/.test(layer), 'asking for the same placement again keeps the chosen point');
  ok(/if \(placementRef\.current\) \{\s+const w = world\.toLocal\(ev\.global\);\s+cosmeticLayerRef\.current\?\.choose\(w\.x, w\.y\);/.test(canvas), 'during a placement a tap on any sprite chooses the ground under it');
  ok(!/tryOn/.test(hook), 'a try-on never reaches the gameplay hook');
  ok(/if \(!placing \|\| !candidate\?\.ok\) return;/.test(view), 'a placement is confirmed only on a spot the scene judged free');
  ok(/data-testid="garden-market-cosmetics"/.test(economy) && /panel === "cosmetics"/.test(overlay), 'the shop opens from the Echo Market');
  ok(!/Sparkles|✨/.test(panels + layer + overlay + view), 'no sparkle icon');
  ok(!/Math\.random|Date\.now\(\)/.test(panels), 'the shop computes nothing from chance or the client clock');
  ok(!/countdown|Chỉ còn|Sắp hết|giới hạn thời gian|ưu đãi/i.test(panels), 'no countdown or scarcity pressure');
  for (const code of ['COSMETICS_CLOSED', 'COSMETIC_OWNED', 'COSMETIC_LOCKED', 'COSMETIC_SLOT_MISMATCH', 'DECOR_OUT_OF_BOUNDS', 'DECOR_OVERLAP', 'DECOR_OFF_GRID', 'DECOR_NONE_STORED', 'DECOR_LIMIT', 'CHECKOUT_DISABLED']) {
    ok(model.errorMessage(code, {}) !== model.errorMessage('___'), `${code} has its own sentence`);
  }
  ok(model.COSMETIC_SHELVES.length >= 8 && model.COSMETIC_SHELVES.every((s) => s.label && s.note), 'the shop is categorised');
  for (const slot of cos.COSMETIC_SLOTS) ok(model.COSMETIC_SLOT_LABEL[slot], `${slot} has a Vietnamese name`);
  for (const f of ['LANTERN', 'PLANTER', 'BENCH', 'SIGN', 'STATUE']) ok(model.DECOR_FAMILY_LABEL[f], `${f} has a Vietnamese name`);
  ok(model.cosmeticRequirementText('LEARNING', 30).includes('30 ngày học') && model.cosmeticRequirementText('COIN', 0) === '', 'an earned item says what it asks for');
  for (const c of catalogue.cosmetics) {
    const url = model.cosmeticArtUrl(c.category, c.artKey, 0);
    ok(sp[url.slice('/garden/world/'.length, -'.webp'.length)], `${c.code}: the shop card shows real art`);
  }

  // ---- prices: every coin price sits in a documented band; earned items cost nothing
  const priced = catalogue.skins.concat(catalogue.cosmetics);
  ok(priced.filter((p) => p.unlockKind === 'COIN').every((p) => p.coinPrice >= 1500 && p.coinPrice <= 320000), 'coin prices stay inside the reviewed range');
  ok(priced.filter((p) => p.unlockKind !== 'COIN').every((p) => !p.coinPrice), 'an earned item has no price');
  ok(priced.some((p) => p.unlockKind === 'LEARNING') && priced.some((p) => p.unlockKind === 'HARVESTS' || p.unlockKind === 'MASTERY'), 'some items are earned by learning and farming');
}

// ---------------------------------------------------------------------------------------------------------------------
// 18. Phase 3F: Premium 7 days, AI vouchers, twenty profile frames, VND through the existing SePay sheet
// ---------------------------------------------------------------------------------------------------------------------
{
  const { existsSync, statSync } = await import('node:fs');
  const api = readFileSync(new URL('../src/services/gardenApi.ts', import.meta.url), 'utf8');
  const hook = src('game/useEchoGarden.ts');
  const panels = src('game/CosmeticPanels.tsx');
  const checkout = src('game/GardenCheckout.tsx');
  const rewards = src('game/RewardPanels.tsx');
  const overlay = src('game/GardenOverlay.tsx');
  const modal = readFileSync(new URL('../src/components/features/premium/PaymentCheckoutModal.tsx', import.meta.url), 'utf8');
  const geometry = readFileSync(new URL('../src/components/common/frame/frameGeometry.ts', import.meta.url), 'utf8');
  const v87 = readFileSync(new URL('../../backend/src/main/resources/db/migration/exams/V87__echo_garden_phase3f_rewards_frames_commerce.sql', import.meta.url), 'utf8');
  const v86 = readFileSync(new URL('../../backend/src/main/resources/db/migration/exams/V86__echo_garden_phase3e_cosmetics.sql', import.meta.url), 'utf8');

  // ---- twenty frames: each catalogue row has its own artwork on disk; no avatar is created anywhere
  const slugs = [...v87.matchAll(/\('garden_(?:four_seasons|festivals|mythical|prestige)',\s+'(garden_[a-z_]+)',/g)].map((m) => m[1]);
  ok(slugs.length === 20 && new Set(slugs).size === 20, 'V87 seeds exactly twenty Echo Garden frames');
  for (const slug of slugs) {
    const file = new URL(`../public/assets/frames/garden/${slug}.webp`, import.meta.url);
    ok(existsSync(file) && statSync(file).size > 8000 && statSync(file).size < 160000, `${slug}: runtime artwork present and small enough for a profile ring`);
  }
  ok((v87.match(/'GARDEN_[A-Z]+',\s*'GARDEN_COIN'\)/g) || []).length === 10 && (v87.match(/'GARDEN_[A-Z]+',\s*'METRIC_THRESHOLD'\)/g) || []).length === 10, 'ten frames are bought with Echo Coins, ten are earned');
  ok(!/CREATE TABLE[^;]*avatar(?!_frame)/i.test(v87) && !/ALTER TABLE[^;]*ADD COLUMN/i.test(v87), 'V87 adds no avatar table and no column to an existing table');
  ok(/GARDEN_FRAME_GEOMETRY: FrameAssetGeometry = \{ canvas: 512, apertureDiameter: 256 \}/.test(geometry), 'the frames are calibrated: 256 px opening on a 512 px canvas');
  ok(!/upload|setAvatar|avatarApi|userProfileApi/.test(rewards), 'the rewards panel never changes the profile photo');
  ok(/avatarFrameApi\.equipFrame\(frame\.slug\)/.test(rewards) && /avatarFrameApi\.unequipFrame\(\)/.test(rewards), 'equipping uses the existing frame API');
  ok(/AVATAR_FRAMES_CACHE_KEY_PREFIX/.test(rewards), 'the frame cache of the header / profile is refreshed after a change');

  // ---- rewards: server facts and server commands only, two steps, nothing computed in React
  for (const fn of ['redeemPremiumReward', 'buyVouchers', 'buyFrame']) {
    ok(new RegExp(`command\\("reward", \\(key\\) => gardenApi\\.${fn}\\(`).test(hook), `${fn} goes through the keyed retry path`);
    ok(!new RegExp(`gardenApi\\.${fn}`).test(rewards + overlay), `${fn} is never called from a component`);
  }
  ok(/disabled=\{busy \|\| p\.status !== "AVAILABLE"\}/.test(rewards), 'the Premium button follows the server status only');
  ok(!/1[_.,]?000[_.,]?000|25[_.,]?000|100[_.,]?000/.test(rewards), 'no reward price is written in the client');
  ok(/garden-reward-premium-confirm/.test(rewards) && /garden-voucher-confirm-/.test(rewards) && /garden-frame-confirm-/.test(rewards), 'every purchase is choose, then confirm');
  ok(/echoRewards: \(\) => apiClient\.get<GardenEchoRewards>\('\/garden\/rewards\/echo'\)/.test(api), 'the reward counter is a read-only request');

  // ---- VND: the Premium sheet is reused; the garden adds no payment UI, no merchant data, no client-side "paid"
  ok(/import \{ PaymentCheckoutModal, type CheckoutProduct \} from "@\/components\/features\/premium\/PaymentCheckoutModal"/.test(checkout), 'the garden opens the Premium payment sheet');
  ok(!/<img|qr\.sepay|vietqr|img\?bank=/i.test(checkout) && !/\b\d{9,}\b/.test(checkout), 'no QR, bank or account number is written in the garden');
  ok(/o\.status === "FULFILLED" \? "PAID"/.test(checkout), 'the sheet shows paid only for an order the server fulfilled');
  ok(/fetchOrder: async \(orderId: number\) => toPaymentOrder\(await gardenApi\.cosmeticOrder\(orderId\), skewMs\)/.test(checkout), 'the order is polled from the garden, where it lives');
  ok(/command\("checkout", \(key\) => gardenApi\.checkoutCosmetic\(kind, code, key\)\)/.test(hook), 'starting an order goes through the keyed retry path');
  ok(/item\.priceVnd != null/.test(panels) && /skin\.priceVnd != null/.test(panels), 'a VND price is shown only when the server returned one');
  ok(/Mở mã QR/.test(panels) && /setConfirming\(true\)/.test(panels), 'a bank-transfer purchase is choose, then confirm');
  ok(/product\?: CheckoutProduct/.test(modal) && /product \? product\.heading : 'Thanh toán English Coach Premium'/.test(modal), 'without a product the sheet is the Premium checkout');
  ok(/paymentApi\.getPaymentOrder/.test(modal) && /pollMs \?\? 1500/.test(modal), 'the Premium order is still polled from the payment module at its own pace');
  // ---- the fixed price table is the migration's, by category and by the two exact product codes
  ok(/WHEN d\.code IN \('DECOR_STATUE_DRAGON', 'DECOR_STATUE_PHOENIX'\) THEN 99000/.test(v87) && /WHEN d\.category = 'DECOR' THEN 19000/.test(v87)
    && /WHEN d\.category IN \('FENCE', 'PATH', 'BED'\) THEN 29000/.test(v87) && /WHEN d\.category IN \('TREE', 'SHRUB', 'FLOWER'\) THEN 39000/.test(v87)
    && /WHEN d\.category = 'MONUMENT' THEN 79000/.test(v87) && /WHEN d\.category = 'HOUSE' THEN 149000/.test(v87) && /'SKIN', s\.code, 39000/.test(v87),
    'the owner price table is in V87');
  ok(/WHERE d\.unlock_kind = 'COIN'/.test(v87) && /WHERE s\.unlock_kind = 'COIN' AND s\.collection_code IS NOT NULL/.test(v87), 'only items sold for Echo Coins get a VND price');
  const coinItems = (v86.slice(v86.indexOf('-- ===== seed: cosmetics')).match(/'COIN', \d+, 0,/g) || []).length;
  const coinSkins = (v86.slice(v86.indexOf('-- ===== seed: fifty cultivars'), v86.indexOf('-- ===== seed: cosmetics')).match(/'COIN', \d+, 1, 0,/g) || []).length;
  ok(coinItems === 59 && coinSkins === 30, `89 products are sold for Echo Coins (${coinItems} + ${coinSkins}); the other 26 are earned and never priced`);
}

// ---------------------------------------------------------------------------------------------------------------------
// 19. Phase 3G: social islands — real players only, read-only visits in the same scene, a small conserved take
// ---------------------------------------------------------------------------------------------------------------------
{
  const api = readFileSync(new URL('../src/services/gardenApi.ts', import.meta.url), 'utf8');
  const hook = src('game/useGardenSocial.ts');
  const panels = src('game/SocialPanels.tsx');
  const view = src('EchoGardenView.tsx');
  const overlay = src('game/GardenOverlay.tsx');
  const model = src('game/gardenModel.ts');
  const java = (p) => readFileSync(new URL(`../../backend/src/main/java/com/englishcoach/garden/${p}`, import.meta.url), 'utf8');
  const v88 = readFileSync(new URL('../../backend/src/main/resources/db/migration/exams/V88__echo_garden_phase3g_social_islands.sql', import.meta.url), 'utf8');
  const engine = java('domain/SocialEngine.java');
  const service = java('application/SocialService.java');
  const controller = java('api/GardenSocialController.java');
  const harvest = java('application/HarvestService.java');
  const sql = v88.replace(/--[^\n]*/g, '');

  // ---- migration: additive, and the three rules that matter are database facts
  ok(!/ALTER TABLE/i.test(sql) && !/\bDROP TABLE\b/i.test(sql) && !/\bDELETE FROM\b|\bUPDATE public\./i.test(sql), 'V88 changes no existing table and no existing row');
  ok((sql.match(/CREATE TABLE IF NOT EXISTS public\.garden_(social_profile|visit|theft)\b/g) || []).length === 3, 'V88 adds exactly the three social tables');
  ok(/CONSTRAINT uq_garden_theft_planting UNIQUE \(planting_id\)/.test(sql), 'a crop is taken from at most once (unique planting)');
  ok(/CHECK \(portions >= 1 AND unit_portions >= 2 AND portions \* 10 <= unit_portions\)/.test(sql), 'a take is never more than a tenth of one unit');
  ok(/CHECK \(victim_id <> thief_id\)/.test(sql) && /FOREIGN KEY \(planting_id, victim_id\)\s+REFERENCES public\.garden_planting\(id, user_id\)/.test(sql), 'a take names two different gardens and the real owner of the planting');
  ok(/trg_garden_theft_append_only BEFORE UPDATE OR DELETE/.test(sql), 'the take record is append-only');
  ok(!/ON DELETE CASCADE/i.test(sql) && (sql.match(/ON DELETE RESTRICT/g) || []).length >= 7, 'every owner reference is RESTRICT');
  const cfg = JSON.parse(v88.match(/VALUES \('social', '(\{[\s\S]*?\})'::jsonb\)/)[1]);
  ok(cfg.portionsPerUnit === 10 && cfg.theft.fractionBp === 1000 && Math.floor(cfg.portionsPerUnit * cfg.theft.fractionBp / 10000) === 1, 'one portion of ten per take');
  ok(cfg.theft.thiefCap === 3 && cfg.theft.pairCap === 1 && cfg.theft.victimCap === 2 && cfg.theft.windowHours === 24, 'daily limits: 3 per taker, 1 per pair, 2 per island');
  ok(cfg.theft.shieldHours >= 1 && cfg.theft.introHours >= 24 && cfg.theft.ripeGraceMinutes >= 1 && cfg.theft.excludedCrops.includes('CRYSTAL_ORCHID'), 'shield, introductory protection, owner head start, protected crops');
  ok(cfg.discovery.pageSize <= 20 && cfg.discovery.searchLimit <= 50 && cfg.visits.historyLimit <= 50 && cfg.activity.pageSize <= 50, 'every list is bounded');

  // ---- server: both gardens locked, no account data in the contract, every command keyed
  ok(/ctx\.pairCommand\(userId, hostId, key, "SOCIAL_TAKE"/.test(service), 'a take runs under both gardens\' locks');
  ok(/new Ripe\(planting, facts, ready, shares\.taken\(pid\)\)/.test(harvest) && /int takenPortions = ripe\.get\(pid\)\.takenPortions\(\);/.test(harvest)
    && /shares\.creditRemainder\(/.test(harvest), 'the owner\'s harvest pays the rest of a crop a visitor took from');
  ok(/views\.planting\(p, growing\.get\(p\.id\(\)\), null, now, fresh\)/.test(service), 'a visitor never receives the owner\'s pest (a flashcard word)');
  ok(!/email|getEmail|phone|password/i.test(service + controller), 'no e-mail, phone or credential in the social service or controller');
  const posts = [...controller.matchAll(/@PostMapping\("([^"]+)"\)\s+public [^{]+\{/g)];
  ok(posts.length === 4 && posts.every((m) => /@RequestHeader\(value = "Idempotency-Key", required = false\) UUID key/.test(m[0])), 'every social command takes an Idempotency-Key');
  ok(/raw\.matches\("\^\[A-HJ-NP-Z2-9\]\{8\}\$"\)/.test(controller) && !/@PathVariable (long|Long) (userId|id)/.test(controller), 'another island is named only by its public handle');
  const reasons = engine.match(/public enum Reason \{([\s\S]*?)\}/)[1].replace(/\/\*\*[\s\S]*?\*\//g, '').split(/[\s,]+/).filter((r) => /^[A-Z_]+$/.test(r) && r !== 'OK');
  ok(reasons.length === 14, `fourteen refusal reasons: the thirteen of Phase 3G and the guardian dog's watch (${reasons.length})`);
  for (const r of reasons) ok(new RegExp(`case "${r}":`).test(model), `${r} has a Vietnamese sentence`);

  // ---- client: commands only through the hook, with one key per action; no faster refresh than the garden's own
  for (const fn of ['socialTake', 'socialReact', 'socialVisibility', 'socialActivitySeen']) {
    ok(new RegExp(`keyed\\("[a-z]+", \\(key\\) => gardenApi\\.${fn}\\(`).test(hook), `${fn} goes through the keyed retry path`);
  }
  ok(!/gardenApi\./.test(panels), 'the social panels never call the API directly');
  ok(/socialTake: \(handle: string, plantingId: number, key: string\)/.test(api) && /`\/garden\/social\/islands\/\$\{handle\}\/take`/.test(api), 'a take names the island handle and the planting only');
  ok(/const VISIT_REFRESH_MS = 3 \* 60 \* 1000;/.test(hook) && (hook.match(/setInterval\(/g) || []).length === 1 && !/setInterval\(/.test(panels), 'a visited island is refreshed every 3 minutes, never faster');
  ok(!/Math\.random|faker|mock|sample players/i.test(hook + panels), 'no invented player, rating or number');
  ok(!/Sparkles|✨/.test(hook + panels), 'no Sparkles icon or emoji');

  // ---- visitor mode: the same scene, none of the owner's controls
  ok(/key=\{visit \? `island-\$\{social\.island!\.owner\.handle\}` : "home"\}/.test(view), 'each island gets a fresh world in the one scene');
  ok((view.match(/<DynamicEchoGardenCanvas/g) || []).length === 1, 'one renderer: a visit never mounts a second canvas');
  ok(/\{home && \(\s*<GardenOverlay/.test(view) && /\{visiting && \(\s*<VisitOverlay/.test(view), 'the owner\'s overlay exists only at home; a visit mounts the visitor layer instead');
  ok(/farmFx=\{home \? game\.fx : undefined\}/.test(view) && /placement=\{home \? placement : null\}/.test(view) && /expansionHint=\{home \? game\.expansionHint : null\}/.test(view), 'no owner FX, placement or purchase hint on another island');
  ok(!/game\.(plant|boost|harvestStart|harvestComplete|sell|treat|marketBuy|fillOrder|expand|buyLand|upgradeBuilding|compost|placeDecor|moveDecor|storeDecor|equipCosmetic|buyCosmetic|spray|plantTree)\b/.test(panels + hook),
    'the visitor layer holds no owner command');
  ok(/testId="garden-take">Lấy một ít/.test(panels) && /testId="garden-take-confirm"/.test(panels) && /onClick=\{\(\) => setConfirm\(true\)\}/.test(panels), '"Lấy một ít" is choose, then confirm');
  ok(/option\?\.eligible \?/.test(panels) && /takeReasonText\(option\?\.reason, option\?\.availableAt\)/.test(panels), 'eligibility and the reason of a refusal are the server\'s');
  ok(/data-testid="garden-social-btn"/.test(overlay) && /\| "social"\s/.test(overlay), 'one entry point in the garden HUD');
  ok(/ACTIVITY_ROUTE = "\/games\/echo-garden\?social=activity"/.test(service) && /get\("social"\) === "activity"/.test(view), 'the take notice links to the island activity record');
  ok(Object.keys(cfg.reactions.codes).length === 3 && cfg.reactions.codes.every((c) => new RegExp(`${c}: "`).test(model)) && !/<textarea|contentEditable/.test(panels), 'three preset greetings, no free text');
}

// ---------------------------------------------------------------------------------------------------------------------
// 20. Phase 3H: living farm — bounded livestock, guardian pets at the server's boundaries, portions with real value
// ---------------------------------------------------------------------------------------------------------------------
{
  const api = readFileSync(new URL('../src/services/gardenApi.ts', import.meta.url), 'utf8');
  const hook = src('game/useEchoGarden.ts');
  const panels = src('game/AnimalPanels.tsx');
  const layer = src('world/animalLayer.ts');
  const view = src('EchoGardenView.tsx');
  const overlay = src('game/GardenOverlay.tsx');
  const inventory = src('game/InventoryPanel.tsx');
  const model = src('game/gardenModel.ts');
  const socialHook = src('game/useGardenSocial.ts');
  const socialPanels = src('game/SocialPanels.tsx');
  const java = (p) => readFileSync(new URL(`../../backend/src/main/java/com/englishcoach/garden/${p}`, import.meta.url), 'utf8');
  const v89 = readFileSync(new URL('../../backend/src/main/resources/db/migration/exams/V89__echo_garden_phase3h_livestock_guardians.sql', import.meta.url), 'utf8');
  const sql = v89.replace(/--[^\n]*/g, '');
  const service = java('application/AnimalService.java');
  const controller = java('api/GardenAnimalController.java');
  const engine = java('domain/AnimalEngine.java');
  const social = java('application/SocialService.java');
  const pests = java('application/PestService.java');
  const sell = java('application/SellService.java');
  const dtos = java('api/GardenDtos.java');

  // ---- migration: additive; capacity, one guardian per species and "no animal is ever deleted" are database facts
  ok((sql.match(/CREATE TABLE IF NOT EXISTS public\.garden_(animal_house|animal)\b/g) || []).length === 2, 'V89 adds exactly the two animal tables');
  const alters = sql.match(/ALTER TABLE[^;]+;/g) || [];
  ok(alters.length === 1 && /ALTER TABLE public\.garden_social_profile ADD COLUMN IF NOT EXISTS visibility_chosen_at TIMESTAMPTZ;/.test(alters[0]), 'the only change to an existing table is one nullable column');
  ok(!/\bDROP (TABLE|COLUMN)\b/i.test(sql) && !/\bDELETE FROM\b/i.test(sql) && !/ON DELETE CASCADE/i.test(sql), 'nothing is dropped, deleted or cascaded');
  ok((sql.match(/UPDATE public\.\w+/g) || []).join() === 'UPDATE public.garden_social_profile' && /SET visibility_chosen_at = created_at WHERE visibility_chosen_at IS NULL/.test(sql),
    'existing social profiles keep their visibility and count as already decided');
  ok(/CHECK \(place IS NULL OR place BETWEEN 1 AND 4\)/.test(sql) && /UNIQUE \(user_id, house_code, place\)/.test(sql), 'a house holds at most four numbered places');
  ok(/CREATE UNIQUE INDEX IF NOT EXISTS ux_garden_animal_guardian ON public\.garden_animal\(user_id, species\) WHERE kind = 'GUARDIAN'/.test(sql), 'one guardian of each species per garden');
  ok(/trg_garden_animal_no_delete BEFORE DELETE ON public\.garden_animal/.test(sql), 'an animal row can never be deleted (no death, no loss)');
  ok(/FOREIGN KEY \(user_id, house_code\)\s+REFERENCES public\.garden_animal_house\(user_id, code\) ON DELETE RESTRICT/.test(sql), 'livestock stands only in a house of its own garden');
  const cfg = JSON.parse(v89.match(/VALUES \('animals', '(\{[\s\S]*?\})'::jsonb\)/)[1]);
  ok(/VALUES \('socialOnboarding', '\{"defaultVisibility": "PRIVATE"\}'/.test(v89), 'a new island starts closed until its owner chooses');
  ok(cfg.houses.length === 4 && cfg.livestock.length === 4 && cfg.guardians.length === 3, 'four houses, four livestock species, three guardians');
  const sprites = cfg.houses.reduce((a, h) => a + h.capacity, 0) + cfg.guardians.length;
  ok(cfg.houses.every((h) => h.capacity >= 1 && h.capacity <= 4) && sprites <= 15, `a garden shows at most ${sprites} animals`);
  ok(cfg.livestock.every((l) => l.growHours >= 12 && l.productHours >= 4 && l.storeCap >= 1 && l.storeCap <= 3), 'growth takes hours or days; an animal stores at most three products');
  ok(cfg.feed.maxHours <= 72 && cfg.livestock.every((l) => l.productHours * l.storeCap <= cfg.feed.maxHours), 'an absent player accumulates two days at most');
  ok(cfg.livestock.every((l) => cfg.products.some((p) => p.code === l.product)) && cfg.products.every((p) => p.sell > 0), 'every species gives a real, sellable product');
  ok(cfg.restGrowthBp > 0 && cfg.restGrowthBp < 10000, 'a young animal without care still grows, slowly: it is never stuck');
  const guardian = (s) => cfg.guardians.find((g) => g.species === s);
  ok(guardian('DOG').cooldownHours >= 12 && guardian('DOG').shieldHours <= 6 && guardian('DOG').shieldHours < guardian('DOG').cooldownHours, 'the dog guards a few hours once per cooldown: it cannot seal an island');
  ok(guardian('GOOSE').graceMinutes > 0 && guardian('GOOSE').graceMinutes <= 60 && guardian('CAT').pestCapReduction === 1, 'the goose adds a bounded head start; the cat keeps one crop place free');
  ok(!/vnd|premium|price_vnd/i.test(JSON.stringify(cfg)) && cfg.guardians.every((g) => g.coins > 0), 'guardians and livestock cost Đồng Echo only: nothing is sold for money or tied to Premium');
  ok(Object.keys(cfg.feed.mill).length >= 3 && cfg.water.item === 'WELL_WATER' && cfg.compost.dailyCap <= 3, 'feed is milled from produce, the trough takes well water, manure compost is capped per day');

  // ---- layout and art: every lot and post is on free ground; every animal has four directions and its own art
  const q = layout.animalQuarter;
  ok(q && JSON.stringify(Object.keys(q.houses).sort()) === JSON.stringify(cfg.houses.map((h) => h.code).sort()), 'one lot per house of the rules');
  ok(JSON.stringify(Object.keys(q.guardians).sort()) === JSON.stringify(cfg.guardians.map((g) => g.species).sort()), 'one post per guardian of the rules');
  const cells = [...layout.starterPlots, ...(layout.expansionPlots ?? []), ...(layout.landRegions ?? []).flatMap((r) => r.plots)].map((c) => [c.gx, c.gy]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const pathPoints = layout.paths.flatMap((pth) => pth.points.flatMap((pt, i) => (i === 0 ? [pt] : Array.from({ length: 8 }, (_, k) => {
    const prev = pth.points[i - 1];
    return [prev[0] + (pt[0] - prev[0]) * (k + 1) / 8, prev[1] + (pt[1] - prev[1]) * (k + 1) / 8];
  }))));
  const inRect = (pt, r, m) => pt[0] > r[0] - m && pt[0] < r[2] + m && pt[1] > r[1] - m && pt[1] < r[3] + m;
  for (const [code, h] of Object.entries(q.houses)) {
    ok(manifest.sprites[h.art] && manifest.sprites[h.art].shadow, `${code}: house art with its own ground shadow`);
    for (const [name, pt] of [['lot', [h.gx, h.gy]], ['yard', h.yard]]) {
      ok(pt[0] > 1 && pt[0] < layout.grid.width - 1.5 && pt[1] > 1 && pt[1] < layout.grid.height - 1, `${code} ${name}: inside the island`);
      ok(cells.every((c) => dist(c, pt) >= 1.5), `${code} ${name}: clear of every bed cell`);
      ok((layout.decorRegions ?? []).every((r) => !inRect(pt, r.rect, 0.45)), `${code} ${name}: clear of every decoration region`);
      ok(pathPoints.every((c) => dist(c, pt) >= 0.75), `${code} ${name}: clear of every path`);
      ok(layout.pond.water.every((c) => dist(c, pt) >= 2), `${code} ${name}: clear of the pond`);
      ok(layout.sprites.every((sp) => dist([sp.gx, sp.gy], pt) >= 1.6), `${code} ${name}: clear of the island's buildings and landmarks`);
      ok([...layout.trees, ...layout.bushes].every((t) => dist([t.gx, t.gy], pt) >= 0.85), `${code} ${name}: clear of trees and bushes`);
      ok(layout.futureFields.every((f) => !inRect(pt, f.rect, 0.3)), `${code} ${name}: outside the farm's fields`);
    }
  }
  const others = Object.entries(q.houses);
  for (let i = 0; i < others.length; i++) for (let j = i + 1; j < others.length; j++) {
    ok(dist([others[i][1].gx, others[i][1].gy], [others[j][1].gx, others[j][1].gy]) >= 1.6, `${others[i][0]} and ${others[j][0]} do not overlap`);
  }
  for (const [species, g] of Object.entries(q.guardians)) {
    ok(cells.every((c) => dist(c, [g.gx, g.gy]) >= 0.95), `${species}: its post is not on a bed`);
    ok(layout.sprites.every((sp) => dist([sp.gx, sp.gy], [g.gx, g.gy]) >= 1.2) && layout.pond.water.every((c) => dist(c, [g.gx, g.gy]) >= 1), `${species}: its post is on free ground`);
  }
  const animalArt = ['chicken_baby', 'chicken_adult', 'duck_baby', 'duck_adult', 'pig_baby', 'pig_adult', 'sheep_baby', 'sheep_adult', 'sheep_shorn', 'dog', 'goose', 'cat'];
  for (const name of animalArt) for (const side of 'abcd') {
    const e = manifest.sprites[`anim_${name}_${side}`];
    ok(e && !e.shadow && e.w <= 260 && e.h <= 260 && e.bytes < 40000, `anim_${name}_${side}: a small sprite, no composed shadow`);
  }
  for (const f of ['product_EGG', 'product_DUCK_EGG', 'product_WOOL', 'product_MANURE', 'item_FEED', 'animal_CHICKEN', 'animal_CHICKEN_baby', 'animal_DUCK', 'animal_DUCK_baby',
    'animal_PIG', 'animal_PIG_baby', 'animal_SHEEP', 'animal_SHEEP_baby', 'animal_DOG', 'animal_GOOSE', 'animal_CAT', 'house_COOP', 'house_DUCK_POND', 'house_PIG_PEN', 'house_SHEEP_BARN']) {
    ok(existsSync(new URL(`../public/garden/ui/${f}.webp`, import.meta.url)), `${f}: UI art exists`);
  }
  ok(!/Math\.random|Date\.now|performance\.now|setInterval|setTimeout|fetch\(|gardenApi/.test(layer), 'animal motion is closed-form in the scene clock: no randomness, timer or network');
  ok(/export function strollAt\(/.test(layer) && /cullable = true/.test(layer) && /this\.reduced \? 0 : envT/.test(layer), 'a pure stroll function, culled sprites, frozen under reduced motion');
  ok(!/scale\.x\s*=\s*-|scale\.set\(-/.test(layer) && /type Facing = "a" \| "b" \| "c" \| "d"/.test(layer), 'four rendered directions: a sprite is never mirrored');
  ok(/onSelect: animalsInteractiveRef\.current \?/.test(src('EchoGardenCanvas.tsx')) && /animalsInteractive=\{!visit\}/.test(view), 'animal houses are touch targets on the owner\'s island only');

  // ---- server: one transaction shape, every command keyed, guardians act at the authoritative boundary
  const posts = [...controller.matchAll(/@PostMapping\("([^"]+)"\)\s+public [^{]+\{/g)];
  ok(posts.length === 10 && posts.every((m) => /@RequestHeader\(value = "Idempotency-Key", required = false\) UUID key/.test(m[0])), 'every animal command takes an Idempotency-Key');
  ok(!/@PathVariable (long|Long)|handle|userId\b.*@RequestParam/.test(controller) && !/GetMapping/.test(controller), 'no animal command names another player; animals are read through the owner\'s own state');
  ok((service.match(/return command\(userId, key, "/g) || []).length === 9 && /ctx\.command\(userId, key, op, fingerprint, AnimalReceipt\.class/.test(service), 'every animal command runs under the owner\'s lock with an idempotency receipt');
  ok(/e\.advance\(def, progress\(a\), a\.fedUntil\(\), house\.wateredUntil\(\), now\)/.test(service) && !/@Scheduled|Executor|Thread/.test(service + engine), 'growth and production are evaluated lazily from server time: no scheduler, no timer');
  ok(!/System\.currentTimeMillis|Instant\.now\(\)|LocalDateTime\.now/.test(service + engine), 'only the transaction\'s server instant is used');
  ok(/Instant guardedUntil = guardians\.turnAway\(hostId, now\);/.test(social) && social.indexOf('guardians.turnAway(hostId, now)') > social.indexOf('ctx.pairCommand(userId, hostId, key, "SOCIAL_TAKE"'), 'the dog acts inside the take transaction, under both gardens\' locks');
  ok(/AND \(guard_at IS NULL OR guard_at <= \?\)/.test(java('infra/AnimalRepository.java')), 'one watch turns one visitor away, even when visitors race');
  ok(/guardBody\(String cropName, Instant at, Instant until, ZoneId zone\)/.test(social) && !/guardBody\([^)]*(\bme\b|\btaker\b|displayName|handle)/.test(social), 'the dog\'s notice never names the visitor');
  ok(/guardians\.pestRelief\(userId, now, rules\.maxCropPests\(\)\)/.test(pests) && /Math\.min\(cat\.pestCapReduction\(\), maxCropPests - 1\)/.test(engine), 'the cat keeps crop places free of new pests, never all of them');
  ok(!/flashcard|review/i.test(service + java('application/GuardianWatch.java')), 'no animal or guardian code touches a flashcard or a review');
  ok(/Math\.floorDiv\(unitPrice \* portions, \(long\) portionsPerUnit\)/.test(engine) && /AnimalEngine\.portionValue\(unit, portions, unitPortions\)/.test(sell), 'portions sell for the rounded-down proportional share of the unit');
  ok(/public record IslandAnimalView\(String species, String kind, String stage, Integer place, boolean woolly\) \{\}/.test(dtos), 'a visitor\'s picture of an animal carries no food, timer, product or id');
  const codes = [...new Set([...service.matchAll(/conflict\("([A-Z_]+)"/g), ...service.matchAll(/GardenException\(404, "([A-Z_]+)"/g)].map((m) => m[1]))];
  ok(codes.length >= 15, `the animal service names its refusals (${codes.length})`);
  for (const c of codes) ok(new RegExp(`case "${c}":`).test(model), `${c} has a Vietnamese sentence`);
  ok(/case "ISLAND_GUARDED": return `Chó canh vườn/.test(model), 'the guarded island is explained to the visitor');

  // ---- client: commands only through the keyed path; the sheet shows server facts; the visitor layer has no animal command
  for (const fn of ['animalBuildHouse', 'animalBuy', 'animalFeedHouse', 'animalWaterHouse', 'animalCollect', 'animalFeedGuardian', 'animalMill', 'animalSellProduct', 'animalCompost']) {
    ok(new RegExp(`animalCommand\\("[a-z-]+",\\s*\\(key\\) => gardenApi\\.${fn}\\(`).test(hook), `${fn} goes through the keyed retry path`);
    ok(new RegExp(`${fn}: \\([^)]*key: string\\)`).test(api), `${fn} sends an idempotency key`);
  }
  ok(/const r = await command\(label, call\);/.test(hook) && /command\("sell-shares", \(key\) => gardenApi\.sellShares\(lines, key\)\)/.test(hook), 'animal commands and the portion sale reuse the one command path');
  ok(!/gardenApi\./.test(panels + inventory) && !/Sparkles|✨/.test(panels + layer), 'the sheets never call the API directly; no Sparkles');
  ok((panels.match(/<Confirm /g) || []).length >= 4 && /setPending\(id\);\s+return;/.test(panels), 'building, buying, adopting and milling everything are choose, then confirm');
  ok(/Quên chăm thì các bạn chỉ nghỉ ngơi: không con nào bị ốm hay mất đi/.test(panels), 'the sheet says in words that neglect never harms an animal');
  ok(!/game\.(buildAnimalHouse|buyAnimal|feedAnimalHouse|waterAnimalHouse|collectAnimalHouse|feedGuardian|millFeed|sellAnimalProduct|compostManure|sellShares)\b/.test(socialPanels + socialHook),
    'the visitor layer holds no animal command');
  ok(/animals: islandAnimalVisuals\(island\.animals\)/.test(socialHook) && /mood: "ok" as const/.test(model), 'a visited island shows its animals without care marks');
  ok(/data-testid="garden-shares"/.test(inventory) && /onSellShares\?\.\(\[\{ cropCode: s\.cropCode, tier: s\.tier, portions: s\.portions \}\]\)/.test(inventory) && /theo đúng tỉ lệ giá/.test(inventory),
    'Kho shows harvest portions, their proportional value and a sale');
  ok(/data-testid="garden-visibility-choice"/.test(overlay) && /testId="garden-visibility-open"/.test(overlay) && /testId="garden-visibility-private"/.test(overlay)
    && /state\.social\?\.visibilityChosen === false/.test(overlay), 'the visibility question appears only while the owner has not decided, with both answers');
  ok(/Họ không bao giờ thấy email, việc học,\s+Kho hay Đồng Echo của bạn/.test(overlay), 'the question says what a visitor can never see');
  for (const sp of ['DOG', 'GOOSE', 'CAT']) ok(new RegExp(`case "${sp}": return \``).test(model), `${sp}: its effect is worded from the server's numbers`);
}

/* 21. Phase 4: the pest cure, the night lamp, the administrator's QA access, one state read at a time ---------- */
{
  const hook = src('game/useEchoGarden.ts');
  const memory = src('game/MemoryPanels.tsx');
  const living = src('world/livingLayer.ts');
  const qaPanels = src('game/AdminQaPanels.tsx');
  const api = readFileSync(new URL('../src/services/gardenApi.ts', import.meta.url), 'utf8');
  const worldFile = (name) => new URL('../public/garden/world/' + name, import.meta.url);
  const model = src('game/gardenModel.ts');

  // ---- the cure: one review, confirmed by the server, and the caterpillar really leaves
  const rescue = hook.slice(hook.indexOf('const rescueReview'), hook.indexOf('Phase 3A: market, delivery board, expansion'));
  ok(/await reviewFlashcard\(flashcardId, quality\);[\s\S]*if \(pest\) cured = await confirmCure\(pest\);[\s\S]*await load\(\);\s+return cured;/.test(rescue),
    'a rescue review is followed at once by the server\'s confirmation of the cure and by a state read');
  const confirm = hook.slice(hook.indexOf('const confirmCure'), hook.indexOf('const rescueReview'));
  ok(/const key = newGardenKey\(\);\s+for \(let attempt = 0; ; attempt\+\+\)/.test(confirm) && /gardenApi\.spray\(pest\.id, key\)/.test(confirm)
    && /retryable\(err\.status\) && attempt < 2/.test(confirm), 'the confirmation uses ONE idempotency key, retried on network / 5xx only');
  ok(/err\.code === "PEST_GONE"\) return true/.test(confirm) && /PEST_NEEDS_REVIEW/.test(confirm) && /chưa được ghi nhận/.test(confirm),
    'a pest that already left counts as cured; a review the server cannot see is explained, never shown as success');
  ok(!/toast\("ok"[^\n]*rời/.test(confirm.slice(0, confirm.indexOf('gardenApi.spray'))), 'no success is announced before the server answered');
  ok(/\.then\(\(gone\) => \(gone \? onClose\(\) : setReviewing\(false\)\)\)/.test(memory), 'the pest sheet closes only when the pest is gone');
  ok(/Khó, Tốt hay Dễ\s+đều được tính/.test(memory) && /data-testid="garden-pest-hard-note"/.test(memory), 'the sheet says which grades count and what "Khó" means for the word');
  ok(!/garden-pest-spray|game\.spray\(/.test(memory) && !/\bspray,/.test(hook.slice(hook.lastIndexOf('return {'))), 'no second "Xua sâu" step is left');
  ok(/knownPests\.current/.test(hook) && /if \(announcedPests\.current\.delete\(id\)\) continue;/.test(hook) && /if \(hostStays\) toast\("ok"/.test(hook),
    'a pest cured elsewhere is announced once, with its word and place, when the next read no longer lists it');
  const removePest = living.slice(living.indexOf('private removePest'), living.indexOf('/** World point of a spot'));
  ok(/this\.pests\.delete\(p\.id\);/.test(removePest) && /p\.hit\.destroy\(\)/.test(removePest) && /p\.mist\.destroy\(\)/.test(removePest)
    && /this\.deps\.removeEntity\(p\.e\)/.test(removePest), 'a cleared pest is released (sprite, shadow, haze, touch target), not left hidden in the scene');
  ok(/if \(this\.reduced\) this\.release\(p\);\s+else this\.leaving\.push\(p\);/.test(removePest), 'the farewell is skipped under reduced motion');
  ok(/const u = \(envT - p\.leftAt\) \/ PEST_LEAVE_S;/.test(living) && /if \(!p\.e \|\| this\.reduced \|\| u >= 1 \|\| u < 0\) \{\s+this\.release\(p\);/.test(living),
    'the farewell is a bounded function of the scene clock and always ends in the release');
  ok(/removeEntity: \(e\) => removeEntity\(e as Entity\),\s+onSelect: \(id\) => selectRef\.current\(livingTarget\(id\)\)/.test(canvas), 'the canvas hands the living layer its entity release');

  // ---- the night lamp
  ok(/export function lightFalloffTexture\(size = 128\): Texture \{\s+return radialPaint\(size/.test(lighting) && /\(q \* q\) \/ \(1 \+ 2 \* r \* r\)/.test(lighting),
    'local lights share one smooth, dithered falloff (no plateau, zero slope at the rim)');
  ok(/const falloff = lightFalloffTexture\(128\);\s+generated\.push\(falloff\);/.test(canvas) && /new LightMap\(app\.renderer, falloff, lights\)/.test(canvas),
    'the falloff is baked once, shared by the light map and released with the generated textures');
  const lampBlock = canvas.slice(canvas.indexOf('const lampHalos'), canvas.indexOf('if (cottage) {'));
  ok(/const lantern = lamp \? \{ x: lamp\.baseX - 24 \* ls, y: lamp\.baseY - 98 \* ls \} : null;/.test(canvas) && /x: lantern\.x, y: lamp\.baseY \+ 8 \* ls/.test(lampBlock)
    && /x: lantern\.x, y: lantern\.y/.test(lampBlock), 'the lamp\'s light is anchored to the lantern, and its pool lies straight below it');
  const lampIntensities = [...lampBlock.matchAll(/intensity: ([\d.]+)/g)].map((m) => Number(m[1]));
  ok(lampIntensities.length === 2 && lampIntensities.every((v) => v < 1) && lampIntensities[0] + lampIntensities[1] < 1.3, 'lamp lights stay below saturation of the 8-bit light map');
  ok(/new Sprite\(falloff\)/.test(lampBlock) && /s\.blendMode = "add";/.test(lampBlock) && !/filters|BlurFilter|RenderTexture/.test(lampBlock),
    'the lantern\'s halo is two additive sprites of the cached falloff: no filter, no render target');
  ok(/h\.s\.alpha = h\.alpha \* look\.glow/.test(canvas) && rig.LOOKS.day.glow === 0 && rig.LOOKS.day.lights === 0, 'by day the lamp adds nothing (glow and lights are 0): daylight is unchanged');
  const lampSprite = manifest.sprites.lamppost;
  ok(lampSprite.glow === 'lamppost_glow_v2.webp' && existsSync(worldFile(lampSprite.glow))
    && !existsSync(worldFile('lamppost_glow.webp')),
    'the corrected lantern glow ships under a new file name (runtime .webp files are cached as immutable)');
  ok(lampSprite.glowBytes < 2500, 'the lantern glow carries only the emitter, not a bloom cut by the sprite box');

  // ---- the administrator's QA access: nothing for an ordinary account, nothing decided by the client
  ok(/if \(a\.adminQa\) gardenApi\.adminQaStatus\(\)/.test(hook) && /useState<GardenAdminQaStatus \| null>\(null\)/.test(hook),
    'the QA status is requested only after the server said this account is the administrator');
  ok((qaPanels.match(/if \(!qa\) return null;/g) || []).length === 2, 'both QA bars render nothing without the server\'s QA status');
  const qaCalls = [...api.matchAll(/adminQa\w+: \(([^)]*)\) =>[^\n]*'(\/admin\/garden\/qa[^']*)'/g)];
  ok(qaCalls.length === 5 && qaCalls.every((m) => !/user|handle|\bid\b/i.test(m[1])), 'the QA calls live under the admin API and name no target account');
  ok(/adminQaAdvance: \(hours: number, key: string\)/.test(api) && qaCalls.filter((m) => /key: string/.test(m[1])).length === 4, 'every QA command carries an idempotency key');
  ok(!/gardenApi\./.test(qaPanels) && !/Sparkles|✨/.test(qaPanels) && /Chỉ quản trị viên/.test(qaPanels), 'the bars only name actions; they are labelled as administrator-only');
  ok(/không trừ Đồng Echo, không có đơn thanh toán, không ghi thành tích/.test(qaPanels) && /hãy tắt Admin QA trước/.test(qaPanels),
    'the shop bar says in words that QA ownership is neither a purchase nor an achievement');
  ok(/if \(!confirmOff\) return setConfirmOff\(true\);/.test(qaPanels), 'switching QA off is choose, then confirm');
  for (const code of ['GARDEN_BUSY', 'ADMIN_QA_FORBIDDEN', 'ADMIN_QA_CLOSED', 'ADMIN_QA_HOURS']) ok(model.includes(`case "${code}"`), `${code} has a Vietnamese sentence`);

  // ---- one state read at a time, none behind a hidden tab
  ok(/if \(loading\.current\) \{[\s\S]{0,400}return waiting\.current\.promise;/.test(hook) && /loading\.current = true;\s+return fetchState\(initial\)\.finally/.test(hook),
    'at most one state request is in flight per client; a later caller waits for the next one');
  ok(/document\.visibilityState === "visible" && setTick\(/.test(hook), 'the 1 Hz presentation clock does not re-render a hidden tab');
}

/* ------------------------------------------------------------------------------------------------------------------
 * 22. Phase 5 — loading time, night glow, phone header
 * ---------------------------------------------------------------------------------------------------------------- */
{
  const hook = src('game/useEchoGarden.ts');
  const canvasSrc = src('EchoGardenCanvas.tsx');
  const feather = src('world/glowFeather.ts');
  const hudSrc = src('EchoGardenHUD.tsx');
  const statusSrc = src('game/GardenStatus.tsx');

  // ---- entry: the first state does not wait for the access answer
  ok(/void load\(true\);\s+gardenApi\.access\(\)/.test(hook), 'the first state is requested together with the access check');
  ok(/if \(previewOnly\.current\) return;/.test(hook) && /previewOnly\.current = true;\s+setPhase\("preview"\)/.test(hook),
    'a closed garden or a signed-out visitor still ends in the preview, never in the error screen');

  // ---- night glow: a halo cut at the edge of its image is faded once, at load; a correct glow is not copied
  ok(/if \(border < BORDER_VISIBLE\) return null;/.test(feather), 'a glow that already ends inside its image reaches the screen untouched');
  ok(/const core = smooth\(\(a - CORE_FROM\) \/ \(CORE_FULL - CORE_FROM\)\);/.test(feather) && /mask \+ \(1 - mask\) \* core/.test(feather),
    'only the haze fades towards the edge; the emissive shape keeps its light');
  ok(!/new \w*Filter|RenderTexture|\.ticker|requestAnimationFrame/.test(feather), 'the feather is one pass at load: no filter, no render target, nothing per frame');
  ok(/if \(!u\.includes\("_glow"\)\) return t;/.test(canvasSrc) && /textures\[u\] = softGlow\(u, t\);/.test(canvasSrc),
    'every glow texture, initial or loaded later, goes through the feather');
  ok(/feathered\.get\(u\)\?\.destroy\(true\);/.test(canvasSrc) && /feathered\.forEach\(\(g\) => g\.destroy\(true\)\);/.test(canvasSrc),
    'a feathered copy is released with the texture it stands for and with the scene');

  // ---- phones: the status may use the whole width; the view controls never leave the screen
  ok(/max-sm:absolute max-sm:right-0 max-sm:top-0/.test(hudSrc) && /flex min-w-0 flex-col items-start gap-1\.5 max-sm:max-w-full/.test(hudSrc),
    'on phones the view controls are pinned to the top right corner, out of the status row');
  ok(/sm:hidden \$\{status \? "mt-\[5\.5rem\]" : ""\}/.test(hudSrc), 'the phone camera rail starts below the status');
  ok(/flex h-11 max-w-full items-center gap-2/.test(statusSrc) && /max-\[359px\]:hidden/.test(statusSrc), 'the status pill fits a 320 px screen');
}

/* ------------------------------------------------------------------------------------------------------------------
 * 23. Final release — continuous sky between day and night, the voluntary Echo guide, the cloud reveal of an entry
 * ---------------------------------------------------------------------------------------------------------------- */
{
  const viewSrc = src('EchoGardenView.tsx');
  const overlaySrc = src('game/GardenOverlay.tsx');
  const hookSrc = src('game/useEchoGarden.ts');
  const guideHook = src('game/guide/useGardenGuide.ts');
  const guideLayer = src('game/guide/GuideLayer.tsx');
  const helpSrc = src('game/guide/HelpPanel.tsx');
  const cloudSrc = src('game/CloudReveal.tsx');
  const canvasSrc = src('EchoGardenCanvas.tsx');
  const geo = await import(new URL('game/guide/guideGeometry.ts', root));
  const scripts = await import(new URL('game/guide/guideScripts.ts', root));
  const entry = await import(new URL('game/entryReveal.ts', root));
  const java = (p) => readFileSync(new URL(`../../backend/src/main/java/com/englishcoach/garden/${p}`, import.meta.url), 'utf8');
  const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
  const norm = (w) => {
    const s = w.day + w.sunset + w.night;
    return { day: w.day / s, sunset: w.sunset / s, night: w.night / s };
  };

  // ---- the sky: three stacked domes must show exactly the weighted blend, for ANY weights
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 400; i++) {
    const w = norm({ day: rnd(), sunset: i % 5 === 0 ? 0 : rnd(), night: rnd() });
    const shown = rig.skyDomeBlend(rig.skyDomeAlphas(w));
    ok(near(shown.day, w.day) && near(shown.sunset, w.sunset) && near(shown.night, w.night), 'the domes show the weighted blend');
  }
  // the defect that made the sky snap: with no sunset weight the old alphas (sunset = ws + wn, night = wn / (ws + wn))
  // showed a FULL night sky for every night weight above zero
  const oldAlphas = (w) => ({ sunset: w.sunset + w.night, night: w.sunset + w.night > 0.001 ? w.night / (w.sunset + w.night) : 0 });
  ok(near(rig.skyDomeBlend(oldAlphas({ day: 0.98, sunset: 0, night: 0.02 })).night, 1), 'reproduced: the former alphas turn 2 % night into a full night sky');
  ok(near(rig.skyDomeBlend(rig.skyDomeAlphas({ day: 0.98, sunset: 0, night: 0.02 })).night, 0.02), 'fixed: 2 % night is 2 % night sky');
  ok(/const domes = skyDomeAlphas\(w\);/.test(lighting) && /this\.domes\.sunset\.alpha = domes\.sunset;/.test(lighting) && /this\.domes\.night\.alpha = domes\.night;/.test(lighting),
    'the sky renderer takes its dome alphas from the light rig');
  ok(!/wn > 0\.5 \?/.test(lighting) && /this\.horizon\.tint = mixByTime\(/.test(lighting), 'the horizon band has one continuous colour (no palette switch at half night)');
  ok(!/c\.sun\.alpha >= c\.moon\.alpha \?/.test(lighting) && /const veil = hazeCentre\(w\);/.test(lighting), 'the scattering veil travels from the sun to the moon (no jump when their alphas cross)');
  ok(!/blendMode|addChild\(|new Sprite/.test(src('world/lightRig.ts')), 'the transition is pure math in the light rig (no overlay, no extra layer)');

  // ---- one coherent transition: every frame of day <-> night is a small step for sky, grade, sun and veil
  const skyOf = (w) => rig.skyDomeBlend(rig.skyDomeAlphas(w));
  const rgb = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  for (const [from, to] of [['day', 'night'], ['night', 'day']]) {
    const tod = new rig.TimeOfDayBlend(from);
    tod.request(to, 0);
    let prev = { w: { ...tod.w }, sky: skyOf(tod.w), look: rig.blendLook(tod.w), cel: rig.celestial(tod.w), veil: rig.hazeCentre(tod.w), tint: rgb(rig.mixByTime(0xdfeeff, 0xff9d62, 0x3c4f8c, tod.w)) };
    let peakDusk = 0;
    const frames = Math.round(tod.duration * 60);
    for (let i = 1; i <= frames + 2; i++) {
      tod.update(i / 60, false);
      const w = { ...tod.w };
      const sky = skyOf(w);
      const look = rig.blendLook(w);
      const cel = rig.celestial(w);
      const veil = rig.hazeCentre(w);
      const tint = rgb(rig.mixByTime(0xdfeeff, 0xff9d62, 0x3c4f8c, w));
      ok(near(w.day + w.sunset + w.night, 1) && w.day >= -1e-12 && w.sunset >= -1e-12 && w.night >= -1e-12, 'weights stay a mix');
      for (const m of ['day', 'sunset', 'night']) ok(Math.abs(sky[m] - prev.sky[m]) < 0.03, `${from}->${to}: the sky changes by a small step every frame (${m})`);
      ok(Math.abs(look.exposure - prev.look.exposure) < 0.012 && Math.abs(look.glow - prev.look.glow) < 0.03 && Math.abs(look.stars - prev.look.stars) < 0.03
        && Math.abs(look.lights - prev.look.lights) < 0.03 && Math.abs(look.vignette - prev.look.vignette) < 0.01, `${from}->${to}: grade, stars and lanterns ramp, never switch`);
      ok(Math.hypot(cel.sun.x - prev.cel.sun.x, cel.sun.y - prev.cel.sun.y) < 0.02 && Math.hypot(cel.moon.x - prev.cel.moon.x, cel.moon.y - prev.cel.moon.y) < 0.02, 'sun and moon keep travelling smoothly');
      ok(Math.hypot(veil.x - prev.veil.x, veil.y - prev.veil.y) < 0.02, `${from}->${to}: the scattering veil never jumps`);
      ok(tint.every((v, k) => Math.abs(v - prev.tint[k]) <= 6), `${from}->${to}: the horizon colour never jumps`);
      peakDusk = Math.max(peakDusk, w.sunset);
      prev = { w, sky, look, cel, veil, tint };
    }
    ok(tod.w[to] === 1 && tod.w.sunset === 0 && !tod.transitioning, `${from}->${to} ends exactly on its look`);
    ok(peakDusk > 0.4 && peakDusk < 0.7, `${from}->${to} passes through dusk / dawn (peak ${peakDusk.toFixed(2)}), not through a grey blend of noon and midnight`);
    // the first and the last frames move almost nothing: no visible start, no hard clip at the end
    const edge = new rig.TimeOfDayBlend(from);
    edge.request(to, 0);
    edge.update(1 / 60, false);
    ok(skyOf(edge.w)[to] < 0.001, `${from}->${to}: the first frame is still the old sky`);
  }
  ok(rig.DUSK_ARC > 0 && rig.DUSK_ARC < 1, 'the dusk share is a part of the way, never the whole sky');
  // sunset <-> day / night are untouched straight changes (the approved looks keep their timing)
  {
    const t = new rig.TimeOfDayBlend('day');
    t.request('sunset', 0);
    t.update(t.duration / 2, false);
    ok(near(t.w.night, 0) && near(t.w.day + t.w.sunset, 1), 'a change to sunset involves no night');
  }

  // ---- reversal and rapid toggles: always from what is on screen, never from an old endpoint
  for (let k = 1; k <= 24; k++) {
    for (const [a, b, c] of [['day', 'night', 'day'], ['night', 'day', 'night'], ['day', 'night', 'sunset'], ['sunset', 'night', 'day']]) {
      const tod = new rig.TimeOfDayBlend(a);
      tod.request(b, 0);
      const at = (k / 25) * tod.duration;
      tod.update(at, false);
      const seen = { ...tod.w };
      tod.request(c, at);
      tod.update(at, false);
      ok(near(tod.w.day, seen.day) && near(tod.w.sunset, seen.sunset) && near(tod.w.night, seen.night), `${a}->${b} reversed to ${c} at ${k}/25: nothing moves at the moment of the request`);
      tod.update(at + 1 / 60, false);
      ok(['day', 'sunset', 'night'].every((m) => Math.abs(tod.w[m] - seen[m]) < 0.01), 'the first frame after a reversal is a small step');
    }
  }
  {
    const tod = new rig.TimeOfDayBlend('day');
    const order = ['night', 'day', 'night', 'sunset', 'day', 'night', 'day', 'night'];
    let t = 0;
    let prev = { ...tod.w };
    let maxStep = 0;
    for (let n = 0; n < 48; n++) {
      tod.request(order[n % order.length], t);
      const hold = 0.08 + 0.27 * rnd(); // a player hammering the buttons, each press before the last change ended
      for (let f = 0; f < Math.round(hold * 60); f++) {
        t += 1 / 60;
        tod.update(t, false);
        ok(near(tod.w.day + tod.w.sunset + tod.w.night, 1) && Math.min(tod.w.day, tod.w.sunset, tod.w.night) >= -1e-12, 'rapid toggles keep a valid mix');
        maxStep = Math.max(maxStep, ...['day', 'sunset', 'night'].map((m) => Math.abs(tod.w[m] - prev[m])));
        prev = { ...tod.w };
      }
    }
    ok(maxStep < 0.03, `48 presses in a row: the largest change between two frames is ${maxStep.toFixed(4)} (no flash, no snap)`);
    const lastTarget = tod.target;
    for (let f = 0; f < 200; f++) {
      t += 1 / 60;
      tod.update(t, false);
    }
    ok(tod.w[lastTarget] === 1 && !tod.transitioning, 'after the last press the world settles exactly on the chosen time');
  }
  ok(/tod\.request\(timeRef\.current, nowS\);\s+let relook = tod\.update\(nowS, still\);/.test(canvasSrc) && (canvasSrc.match(/new TimeOfDayBlend\(/g) ?? []).length === 1,
    'one transition object, driven from the one scene ticker (no second timeline, no remount of the world)');
  ok((canvasSrc.match(/app\.ticker\.add\(/g) ?? []).length === 2, 'the release adds no ticker callback (the scene loop and the dev-only magic hook)');

  // ---- the guide: where the opening, the arrow and the bubble go
  for (const [vw, vh] of [[1440, 900], [390, 844], [320, 568]]) {
    const bubble = { w: Math.min(336, vw - 20), h: 190 };
    for (let i = 0; i < 300; i++) {
      const w = 24 + rnd() * vw * 0.6;
      const h = 24 + rnd() * vh * 0.5;
      const rect = { x: rnd() * (vw - w), y: rnd() * (vh - h), w, h };
      const insets = { top: 20, right: 0, bottom: 24, left: 0 };
      const p = geo.place(rect, bubble, vw, vh, insets);
      const b = { x: p.bubble.x, y: p.bubble.y, w: bubble.w, h: bubble.h };
      ok(b.x >= insets.left && b.y >= insets.top && b.x + b.w <= vw - insets.right + 1e-6 && b.y + b.h <= vh - insets.bottom + 1e-6, `${vw}x${vh}: the bubble stays inside the safe area`);
      ok(p.hole && p.hole.x >= 0 && p.hole.y >= 0 && p.hole.x + p.hole.w <= vw + 1e-6 && p.hole.y + p.hole.h <= vh + 1e-6, 'the opening stays on screen');
      if (p.side !== 'inside') {
        ok(!geo.intersects(b, p.hole), `${vw}x${vh}: the bubble never covers the highlighted target`);
        ok(p.arrow && p.arrow.x >= 0 && p.arrow.x <= vw && p.arrow.y >= 0 && p.arrow.y <= vh, 'the arrow tip stays on screen');
        const gap = p.side === 'below' ? b.y - (p.hole.y + p.hole.h) : p.side === 'above' ? p.hole.y - (b.y + b.h) : p.side === 'right' ? b.x - (p.hole.x + p.hole.w) : p.hole.x - (b.x + b.w);
        ok(gap >= geo.ARROW_GAP - 1e-6, 'the arrow has its room between the target and the bubble');
      }
    }
    const whole = geo.place({ x: 0, y: 0, w: vw, h: vh }, bubble, vw, vh);
    ok(whole.side === 'inside' && whole.arrow === null, 'a target that fills the screen is spoken from inside, without an arrow');
    const none = geo.place(null, bubble, vw, vh);
    ok(none.hole === null && none.arrow === null && none.bubble.x >= 0 && none.bubble.x + bubble.w <= vw, 'no target on screen: no opening, no arrow, Echo still speaks');
    ok(geo.holeOf({ x: vw + 50, y: 10, w: 80, h: 80 }, vw, vh) === null, 'a target outside the screen has no opening');
  }

  // ---- the guide's words follow the server state (a step never waits for something that cannot happen)
  const crop = { code: 'WHEAT', nameVi: 'Lúa mì', unlocked: true, purchasable: true, seedPrice: 10, seedEssence: 0 };
  const planting = (over = {}) => ({ id: 5, ready: false, waterCount: 0, waterLimit: 3, boostFraction: 0, maxBoost: 0.4, ...over });
  const base = (over = {}) => ({
    plots: [{ id: 1, slot: 1, planting: null }, { id: 2, slot: 2, planting: null }],
    inventory: { water: 3, seeds: [{ cropCode: 'WHEAT', qty: 2 }] },
    crops: [crop], boosts: [{ code: 'WATER', fraction: 0.04 }], profile: { coins: 200, essence: 0 }, pests: [],
    social: { unitPortions: 10 }, animals: null, ...over,
  });
  const [island, find, plant, water, pests, kho, discover] = scripts.STARTER;
  ok(scripts.STARTER.length === 7 && scripts.STARTER_STEPS === 7, 'the starter guide has seven milestones');
  ok(scripts.TOPICS.length === 12 && new Set(scripts.TOPICS.map((t) => t.id)).size === 12 && scripts.TOPICS[0].id === scripts.STARTER_ID, 'twelve help topics, the first is the starter guide');
  const fresh = { state: base(), openSlot: null };
  ok(island.expect(fresh) === 'next' && island.target(fresh) === 'world:island', 'step 1 shows the island');
  ok(find.expect(fresh) === 'plot' && find.target(fresh) === 'world:plot_1', 'step 2 points at a REAL free bed and waits for the player to select one');
  ok(plant.expect(fresh) === 'planted' && plant.target(fresh) === 'world:plot_1', 'step 3 with no sheet open leads back to the bed');
  ok(plant.target({ state: base(), openSlot: 2 }) === 'dom:seed-list', 'step 3 points at the real seed list of the open bed');
  const full = base({ plots: [{ id: 1, slot: 1, planting: planting() }, { id: 2, slot: 2, planting: planting({ id: 6 }) }] });
  ok(find.expect({ state: full, openSlot: null }) === 'next' && /đều đang có cây/.test(find.text({ state: full, openSlot: null })), 'no free bed: explained, never invented, never stuck');
  ok(plant.expect({ state: full, openSlot: null }) === 'next', 'no free bed: planting is not demanded');
  const broke = base({ inventory: { water: 3, seeds: [] }, profile: { coins: 0, essence: 0 } });
  ok(plant.expect({ state: broke, openSlot: 1 }) === 'next' && /chưa có hạt giống/.test(plant.text({ state: broke, openSlot: 1 })), 'no seed and no coins: explained, no seed is fabricated');
  const grown = base({ plots: [{ id: 1, slot: 1, planting: planting() }, { id: 2, slot: 2, planting: null }] });
  ok(water.expect({ state: grown, openSlot: null }) === 'watered' && water.target({ state: grown, openSlot: null }) === 'world:plot_1', 'step 4 leads to the growing bed');
  ok(water.target({ state: grown, openSlot: 1 }) === 'dom:water', 'step 4 points at the real water button of the open bed');
  const pending = base({ plots: [{ id: 1, slot: 1, planting: planting({ id: -1 }) }] });
  ok(water.expect({ state: pending, openSlot: 1 }) === 'next', 'a planting the server has not confirmed yet cannot be watered');
  const dry = base({ plots: [{ id: 1, slot: 1, planting: planting() }], inventory: { water: 0, seeds: [] } });
  ok(water.expect({ state: dry, openSlot: 1 }) === 'next' && /hết nước/.test(water.text({ state: dry, openSlot: 1 })), 'no water: explained (water comes from reviewing cards)');
  const soaked = base({ plots: [{ id: 1, slot: 1, planting: planting({ waterCount: 3 }) }] });
  ok(water.expect({ state: soaked, openSlot: 1 }) === 'next' && /đã được tưới đủ/.test(water.text({ state: soaked, openSlot: 1 })), 'a crop already watered is not watered again for the guide');
  ok(pests.expect(fresh) === 'next' && kho.expect(fresh) === 'next' && discover.expect(fresh) === 'next', 'pests, Kho and the rest are explained: nothing is spawned, harvested or bought');
  ok(pests.target(fresh) === 'dom:learning' && kho.target(fresh) === 'dom:kho' && discover.target(fresh) === 'dom:dock', 'they point at the real learning chip, Kho button and district dock');
  ok(!/Sâu Lãng Quên: chạm/.test(pests.text(fresh)) && /đang có Sâu Lãng Quên/.test(pests.text({ state: base({ pests: [{ id: 1 }] }), openSlot: null })), 'a pest is mentioned only when the server reports one');
  // every target the guide names exists: a registered control, or a selection id of the scene
  const registered = new Set();
  for (const f of ['EchoGardenHUD.tsx', 'game/GardenOverlay.tsx', 'game/GardenStatus.tsx', 'game/PlotPanel.tsx']) {
    for (const m of src(f).matchAll(/(?:data-guide|guideId)="([a-z-]+)"/g)) registered.add(m[1]);
  }
  const targets = src('world/echoGardenTargets.ts');
  const states = [fresh, { state: full, openSlot: 1 }, { state: grown, openSlot: 1 }, { state: base({ social: null }), openSlot: null },
    { state: base({ plots: [{ id: 1, slot: 1, planting: planting({ ready: true }) }] }), openSlot: null }];
  let named = 0;
  for (const topic of scripts.TOPICS) {
    ok(topic.steps.length >= 1 && topic.steps.length <= 7 && topic.title.length > 0, `topic ${topic.id} is a short guide`);
    for (const step of topic.steps) {
      for (const c of states) {
        const text = step.text(c);
        ok(typeof text === 'string' && text.length > 20 && text.length < 330, `${topic.id}/${step.id}: one short speech (${text.length})`);
        ok(!/✨/.test(text), 'no sparkle emoji');
        const t = step.target(c);
        if (t === null) continue;
        named++;
        if (t.startsWith('dom:')) ok(registered.has(t.slice(4)), `${topic.id}/${step.id}: control "${t.slice(4)}" is registered in the real UI`);
        else {
          const id = t.slice(6);
          ok(/^plot_\d+$/.test(id) || id === 'island' || id === 'farm_zone' || new RegExp(`\\b${id}: \\{`).test(targets), `${topic.id}/${step.id}: world target "${id}" is a real scene id`);
        }
      }
    }
  }
  ok(named > 100, 'targets were checked');
  ok(/const e = entityById\.get\(one\);/.test(canvasSrc) && /const b = e\.sprite\.getBounds\(\);/.test(canvasSrc) && /app\.canvas\.getBoundingClientRect\(\)/.test(canvasSrc),
    'a world target is located by its sprite bounds under the live camera and the canvas box (no second coordinate system)');
  ok(/sceneReadyRef\.current\?\.\(\{ targetClientRect \}\);/.test(canvasSrc) && /cleanups\.push\(\(\) => sceneReadyRef\.current\?\.\(null\)\);/.test(canvasSrc), 'the scene withdraws its answers when it is destroyed');

  // ---- voluntary: offered once, by the server's word; never started, never reopened by itself
  ok(/if \(g\.invite && !invitedHere\(\)\) \{\s+setInvite\(true\);/.test(guideHook) && /settled\.current = true;/.test(guideHook), 'the invitation is considered once per entry and only on the server\'s word');
  ok(/if \(!home \|\| !ready \|\| !hasRecord \|\| settled\.current\) return;/.test(guideHook), 'the invitation waits for the player\'s own garden and for the end of the reveal');
  ok(/ready: reveal !== null && revealFinished\(reveal\),/.test(viewSrc), 'the invitation comes after the cloud reveal');
  ok(/rememberInvited\(\);\s+void guideAction\("SHOWN"\);/.test(guideHook) && /getClientRects\(\)\.length > 0\) inviteShown\(\);/.test(guideLayer), 'an invitation counts as offered only once it is really on a visible screen');
  ok((guideHook.match(/setInvite\(true\)/g) ?? []).length === 1, 'one place can show the invitation');
  ok(/void guideAction\("SETTLE"\);/.test(guideHook) && !/STARTED[^\n]*\n[^\n]*setRun\(/.test(guideHook), 'an unfinished guide found on a later visit is settled, never reopened');
  ok(!/\.(plant|boost|treat|sell\w*|harvest\w*|marketBuy|buy\w+|startCheckout|redeem\w+|expand|fillOrder)\(/.test(guideHook + guideLayer + helpSrc + src('game/guide/guideScripts.ts')),
    'the guide sends no game command: no planting, purchase, sale, harvest, checkout or reward of its own');
  ok(!/setInterval|fetch\(|gardenApi|reload\(|\.load\(/.test(guideHook + guideLayer + helpSrc), 'the guide polls nothing and reads no state of its own');
  ok(/if \(!\(await game\.plant\(plot, crop\)\)\) return;\s+advance\(1, 2\);[\s\S]{0,140}guide\.notify\("planted"\);/.test(overlaySrc), 'the planting step goes on only after the server accepted the planting');
  ok(/if \(!\(await game\.boost\(plot, code\)\)\) return;\s+advance\(2, 3\);\s+if \(code === "WATER"\) guide\.notify\("watered"\);/.test(overlaySrc), 'the watering step goes on only after the server accepted the watering');
  ok(!/garden-coach|coachHidden/.test(overlaySrc), 'the old automatic tutorial card is gone');
  {
    const hudNow = src('EchoGardenHUD.tsx');
    ok(/data-testid="garden-help-btn"/.test(hudNow) && /data-testid="garden-help-btn-phone"/.test(hudNow) && (hudNow.match(/data-guide="help"/g) ?? []).length === 2,
      'a permanent Hướng dẫn entry lives with the view controls: in the bar on larger screens, last in the rail on phones');
    ok(/onHelp=\{home \? \(\) => handlePanel\(panel === "help" \? null : "help"\) : undefined\}/.test(viewSrc), 'it opens Help on the player\'s own island (a preview or a visited island has none)');
    ok(!/garden-help-btn/.test(overlaySrc), 'the bottom row and the district dock keep their room');
    ok(/sm:hidden \$\{status \? "mt-\[5\.5rem\]" : ""\}/.test(hudNow) && /max-sm:absolute max-sm:right-0 max-sm:top-0/.test(hudNow), 'the phone header of Phase 5 is unchanged: controls pinned top right, rail below the status');
  }
  ok((helpSrc.match(/guide\.start\(/g) ?? []).length === 1 && /const begin = \(topicId: string, mode: "resume" \| "restart"\) => \{\s+onClose\(\);\s+guide\.start\(topicId, mode\);/.test(helpSrc),
    'opening Help starts nothing: a guide starts only from the player\'s tap');
  ok(/Tiếp tục hướng dẫn/.test(helpSrc) && /Hướng dẫn lại/.test(helpSrc) && /Bắt đầu hướng dẫn/.test(helpSrc), 'Help offers start, continue and again');
  ok(/Bắt đầu hướng dẫn/.test(guideLayer) && /Để sau/.test(guideLayer) && /Quay lại/.test(guideLayer) && /Bỏ qua bước này/.test(guideLayer) && /Kết thúc hướng dẫn/.test(guideLayer) && /Tiếp tục/.test(guideLayer),
    'the invitation and every step carry their plain controls');
  ok(/BrandWhaleIcon/.test(guideLayer) && !/Sparkles|✨/.test(guideLayer + helpSrc + cloudSrc), 'the guide is the existing Echo Whale; no sparkle');
  ok(/const aside = !!run && \(!home \|\| c\.sensitive \|\| /.test(guideHook) && /sensitive: overlayPanel === "cosmetics" \|\| overlayPanel === "echoRewards" \|\| tryOn !== null \|\| placing !== null,/.test(viewSrc),
    'the guide steps aside for a shop with checkout, the rewards sheet, a try-on and another island');
  // the layer: one frame loop while a guide runs, positions written to the elements, everything released
  ok((guideLayer.match(/requestAnimationFrame\(/g) ?? []).length === 2 && /return \(\) => window\.cancelAnimationFrame\(raf\);/.test(guideLayer), 'one animation-frame loop, cancelled with the step');
  ok(/if \(key === last\) return;/.test(guideLayer) && !/setState|useState<Placement>/.test(guideLayer), 'positions go straight to the elements: no React state per frame');
  ok(/window\.addEventListener\("keydown", onKey\);\s+return \(\) => window\.removeEventListener\("keydown", onKey\);/.test(guideLayer), 'Escape leaves the guide; the listener is removed with it');
  ok(/\$\{open \? "pointer-events-none" : "pointer-events-auto"\}/.test(guideLayer) && /free \? "pointer-events-none" : "pointer-events-auto"/.test(guideLayer),
    'the opening of an action step is not an element: the real target takes the tap');
  ok(/prefers-reduced-motion: reduce\)\{\.eg-guide,\.eg-guide-halo,\.eg-guide-arrow-in,\.eg-guide-whale\{animation:none\}\}/.test(guideLayer), 'reduced motion stills the guide');
  ok(/role="dialog" aria-modal="true" aria-labelledby="garden-guide-invite-title"/.test(guideLayer) && /aria-live="polite"/.test(guideLayer), 'the invitation is a dialog; steps are announced');
  // the record: the player's own, saved quietly, in order
  ok(/guide: \(action: GardenGuideAction, step: number, key: string\) => post<GardenGuideAck>\('\/garden\/guide', \{ version: 1, action, step \}, key\)/.test(src('../../../../services/gardenApi.ts')),
    'one keyed endpoint, no user id in the request');
  ok(/const next = guideChain\.current\.then\(send, send\);/.test(hookSrc) && /seq\.current\+\+; \/\/ a refresh already in flight must not bring the old record back/.test(hookSrc), 'guide saves are sent in order and outlive a stale refresh');
  {
    const svc = java('application/GardenStateService.java');
    const body = svc.slice(svc.indexOf('public GuideAck guide('), svc.indexOf('public Ack rewardsSeen('));
    ok(/access\.require\(userId\);/.test(body) && /ctx\.command\(userId, key, "GUIDE"/.test(body) && /ctx\.repo\.saveGuide\(/.test(body), 'the guide command is access-checked, idempotent and writes the guide record');
    ok(!/ledger|addXp|changeCoins|addItem|addCoins/.test(body), 'the guide command touches no coin, XP or item');
    ok(/@Min\(1\) @Max\(1\) int version/.test(java('api/GardenDtos.java')) && /\^\(SHOWN\|DECLINE\|START\|PROGRESS\|EXIT\|COMPLETE\|SETTLE\)\$/.test(java('api/GardenDtos.java')) && /@Min\(0\) @Max\(7\) int step/.test(java('api/GardenDtos.java')),
      'version, action and step are validated on the server');
    ok(/jsonb_set\(settings, '\{guide\}', \?::jsonb, true\)/.test(java('infra/GardenRepository.java')) && /GardenScope\.evict\("profile:" \+ userId\);\s+jdbc\.updateLater\("""\s+UPDATE public\.garden_profile\s+SET settings = jsonb_set/.test(java('infra/GardenRepository.java')),
      'the record lives in the garden profile\'s own settings (no new table, no new read) and evicts the memoized profile');
    ok(/adminRole\(user\) && s\.guide\(\) != null \? s\.withGuide\(s\.guide\(\)\.withoutInvite\(\)\) : s/.test(java('api/GardenController.java')), 'an administrator account is never offered the guide by itself');
    ok(/status\(\) == null\) && onboardingStep == 0 && plantings == 0/.test(java('domain/GuideEngine.java')), 'only a garden nobody played in is new');
  }

  // ---- the cloud reveal: once per entry, over the real island, never a delay, never in the way
  const R = entry;
  ok(R.revealInitial({ enabled: true, reducedMotion: false }) === 'covered' && R.revealInitial({ enabled: false, reducedMotion: false }) === 'off'
    && R.revealInitial({ enabled: true, reducedMotion: true }) === 'off', 'switched off or reduced motion: no clouds at all');
  ok(R.revealNext('covered', 'ready') === 'opening' && R.revealNext('covered', 'skip') === 'covered' && R.revealNext('covered', 'opened') === 'covered',
    'the clouds part only when the real island is drawn (a tap cannot part clouds over an unfinished scene)');
  ok(R.revealNext('opening', 'skip') === 'done' && R.revealNext('opening', 'opened') === 'done' && R.revealNext('opening', 'hidden') === 'done', 'a tap, the end of the parting and a hidden tab all end it');
  ok(R.revealNext('covered', 'failed') === 'done' && R.revealNext('opening', 'failed') === 'done', 'a failure removes the clouds: the error is never hidden');
  for (const e of ['ready', 'skip', 'opened', 'failed', 'hidden']) ok(R.revealNext('done', e) === 'done' && R.revealNext('off', e) === 'off', `nothing replays the reveal inside an entry (${e})`);
  ok(R.revealCovers('covered') && R.revealCovers('opening') && !R.revealCovers('done') && !R.revealCovers('off') && R.revealFinished('done') && R.revealFinished('off') && !R.revealFinished('opening'),
    'covered and finished are opposites');
  ok(R.REVEAL_MS >= 1000 && R.REVEAL_MS <= 1500 && R.REVEAL_SKIP_MS <= 250, 'the parting lasts 1.0 to 1.5 s; a skip is immediate');
  ok(/const \[reveal, setReveal\] = useState<RevealPhase \| null>\(null\);/.test(viewSrc) && /useLayoutEffect\(\(\) => \{[\s\S]{0,260}setReveal\(revealInitial\(/.test(viewSrc),
    'the reveal is decided once per mount of the game view, on the device, before the first paint');
  ok((viewSrc.match(/setReveal\(/g) ?? []).length === 2, 'nothing but the entry and the reveal\'s own events moves it (no panel, tab, refresh or remount of the scene)');
  ok(/if \(!sceneDrawn \|\| reveal !== "covered"\) return;/.test(viewSrc) && /if \(status === "ready"\) setSceneDrawn\(true\);/.test(viewSrc) && /if \(ready\) statusRef\.current\?\.\("ready"\);/.test(canvasSrc),
    'the parting starts on the scene\'s own first frame, not on a timer');
  ok(/if \(document\.visibilityState !== "visible"\) return;/.test(viewSrc) && /if \(document\.visibilityState !== "visible"\) revealEvent\("hidden"\);/.test(viewSrc), 'nothing plays while the tab is hidden');
  ok(/if \(game\.phase === "error"\) revealEvent\("failed"\);/.test(viewSrc) && /else revealEvent\("failed"\);/.test(viewSrc) && /if \(failed\) statusRef\.current\?\.\("failed"\);/.test(canvasSrc), 'a failed garden or scene removes the clouds');
  ok(/<CloudReveal key="clouds"/.test(viewSrc) && (viewSrc.match(/\{clouds\}/g) ?? []).length === 3, 'one cloud layer beside loading, error and island: nothing underneath can restart it');
  ok(/entryVeil=\{!\(reveal && revealCovers\(reveal\)\)\}/.test(viewSrc) && /\{entryVeil && !veilGone && !failed && \(/.test(canvasSrc), 'under the clouds the scene shows no dark veil of its own: the island is drawn when they part');
  ok(!/pixi|Application|RenderTexture|requestAnimationFrame|fetch\(|gardenApi|ticker/.test(cloudSrc.replace(/\/\*[\s\S]*?\*\//g, '')), 'the clouds are a screen layer: no canvas work, no ticker, no request, no texture of their own');
  ok(/\$\{WORLD_BASE\}billow_\$\{c\.art\}\.webp/.test(cloudSrc), 'they are the game\'s own cumulus billows');
  ok(/onPointerDown=\{\(e\) => \{\s+swallow\(e\);\s+if \(phase === "opening"\) setFast\(true\);/.test(cloudSrc) && /e\.stopPropagation\(\);\s+e\.preventDefault\(\);/.test(cloudSrc),
    'a tap on the clouds skips and goes no further: it can never plant, buy or select');
  ok(/if \(phase !== "covered" && phase !== "opening"\) return null;/.test(cloudSrc), 'when it is over the layer is gone from the page');
  ok(/Mạng đang chậm, Đảo Ký Ức vẫn đang được tải…/.test(cloudSrc) && /REVEAL_SLOW_MS/.test(cloudSrc), 'a slow load says so');
  ok(/role="switch" aria-checked=\{reveal\}/.test(helpSrc) && /Hiệu ứng mở đảo/.test(helpSrc) && /writeRevealPref\(!reveal\);/.test(helpSrc), 'Hiệu ứng mở đảo can be switched off in Help');
  ok(!/guideAction|guide\./.test(cloudSrc + src('game/entryReveal.ts')) && !/reveal|Reveal/.test(guideHook.replace(/the entry reveal is over[^\n]*/, '')),
    'the reveal and the invitation are independent: the clouds know nothing of the guide, the guide only waits for "ready"');
}

console.log(`Echo Garden environment contracts passed (${checks} checks): 3 floating islands (1 main + 2 independent satellites), bounded deterministic satellite motion, wind-driven layered clouds with concealed recycling, frame-rate independent clock + reduced motion, smooth deterministic light rig, sun on the key-light side, sunset shadow length, graded scene + emissive lights, darkness shadow composition, 6 plots / 4 stages / species seedlings, edge growth off cells, Knowledge Tree negative space, cleanup, Phase 1 gameplay (crop art per obtainable crop, client never ripens crops, idempotency keys, network-free scene, preview preserved), Phase 3A (four owner-approved expansion beds inside marked fields, market stall at the seed corner, keyed + confirmed economy commands), Phase 3B (one tree in five eras on one anchor, six bounded ornament sockets, four-stage crop skins with base-crop fallback, keyed skin commands, grounded Echo hint on real routes), Phase 3C (three farmland regions on reserved cells up to 24 beds, three building levels on approved anchors, staged pest damage with reusable overlays and recovery, keyed + confirmed estate commands, reward counter off by default), Phase 3D (one Echo Coin icon with the whale mark, ten supplies with art and server-worded effects, reusable soil / cover overlays, keyed supply command, categorised market with closed future shelves, harvest bonus and lifetime records), Phase 3E (115 audited cosmetic products with their own art: 50 four-stage crop skins, six house families across four levels, vegetation / monument / fence / path / bed styles, 25 placeable decorations in seven regions clear of every plot, lazy cosmetic art, keyed + confirmed coin purchases, no real-money button), Phase 3H (four animal houses on free ground, 48 animal sprites in four directions without mirroring, at most 15 animals per garden, lazy server-time growth, keyed + confirmed animal commands, guardians at the take and pest boundaries, harvest portions with proportional value, a visibility choice before an island can be found), final release (the sky is the weighted blend of its three domes for any weights, day <-> night passes through dusk / dawn in small steps, reversals and rapid toggles start from what is on screen, a voluntary guide offered once on the server's word that points at real controls and scene objects and sends no game command, a cloud reveal once per entry over the real island).`);
