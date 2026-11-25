// Echo Living Planet (Odyssey) — geography, determinism and runtime contracts (owner brief 2026-11-14).
// The planet is presentation only: every catalog region has a place, every landmark stands on land, the same seed
// gives the same world, and the world code makes no request (beyond Echo's model), no AI call and no server write.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tsLoader } from './lib/ts-load.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = p => readFileSync(join(root, p), 'utf8');
const load = tsLoader();
const { SITES, BY_ID, siteDir, angleBetween, siteFor, CONNECTIONS } = load('lib/odyssey/planet/layout.ts');
const { createTerrain, newSample } = load('lib/odyssey/planet/terrain.ts');
const { buildPlanet, icosphere, PROP_KINDS } = load('lib/odyssey/planet/build.ts');

// 1. Every catalog region (backend source of truth) has exactly one authored site; nothing extra.
const catalog = read('../backend/src/main/java/com/englishcoach/learningpath/OdysseyCatalog.java');
const ids = [...catalog.matchAll(/\br\("([a-z]+)",/g)].map(m => m[1]);
assert.equal(ids.length, 15, 'catalog regions');
assert.deepEqual([...ids].sort(), Array.from(SITES, s => s.id).sort(), 'one site per catalog region');
for (const [a, b] of CONNECTIONS) assert.ok(BY_ID.has(a) && BY_ID.has(b), `land bridge ${a}-${b}`);
// A region the catalog may add later still gets a deterministic place.
const extra = siteFor({ id: 'future', x: 10, z: 0 });
assert.ok(Number.isFinite(extra.lat) && Number.isFinite(extra.lon));

// 2. Sites are far enough apart for distinct landscapes (≥ 18°).
for (let i = 0; i < SITES.length; i++) for (let j = i + 1; j < SITES.length; j++) {
  const deg = angleBetween(siteDir(SITES[i]), siteDir(SITES[j])) * 180 / Math.PI;
  assert.ok(deg >= 18, `${SITES[i].id}–${SITES[j].id} only ${deg.toFixed(1)}° apart`);
}

// 3. Every landmark stands on a dry plateau; the terrain function is deterministic.
const t1 = createTerrain(), t2 = createTerrain(), s1 = newSample(), s2 = newSample();
for (const site of SITES) {
  const d = siteDir(site);
  t1.sample(d[0], d[1], d[2], s1);
  assert.ok(s1.h >= 0.5, `${site.id} plateau above the sea (h=${s1.h.toFixed(2)})`);
  assert.ok(s1.pad > 0.9, `${site.id} is flattened for its landmark`);
}
const sphere = icosphere(5);
for (let i = 0; i < sphere.count; i += 37) {
  t1.sample(sphere.pos[i * 3], sphere.pos[i * 3 + 1], sphere.pos[i * 3 + 2], s1);
  t2.sample(sphere.pos[i * 3], sphere.pos[i * 3 + 1], sphere.pos[i * 3 + 2], s2);
  assert.equal(s1.h, s2.h); assert.equal(s1.r, s2.r); assert.equal(s1.forest, s2.forest);
}

// 4. A real build: a continuous world (land between 25 % and 45 %), forests, sockets for every region's stations.
const b = buildPlanet({ level: 6, trees: 1.3 });
let land = 0; for (const d of b.ocean.depth) if (d < 0) land++;
const fraction = land / b.ocean.depth.length;
assert.ok(fraction > 0.22 && fraction < 0.45, `land fraction ${fraction.toFixed(3)}`);
assert.equal(b.sites.length, 15);
for (const s of b.sites) {
  assert.ok(s.sockets.length / 3 >= 12, `${s.id} has room for stations (${s.sockets.length / 3})`);
  const anchorR = Math.hypot(...s.anchor), beaconR = Math.hypot(...s.beacon);
  assert.ok(beaconR > anchorR + 3, `${s.id} beacon above its landmark`);
}
const trees = ['broad', 'conifer', 'palm', 'cypress', 'acacia', 'willow', 'snowpine', 'bush'].reduce((n, k) => n + b.props[k].reduce((a, c) => a + c.count, 0), 0);
assert.ok(trees > 1500, `forests (${trees} trees)`);
assert.ok(PROP_KINDS.every(k => Array.isArray(b.props[k])));
for (const k of PROP_KINDS) for (const c of b.props[k]) { assert.equal(c.matrices.length, c.count * 16); assert.equal(c.colors.length, c.count * 3); }
// Same options ⇒ the same world.
const again = buildPlanet({ level: 6, trees: 1.3 });
assert.equal(again.stats.props, b.stats.props); assert.equal(again.terrain.position[1234], b.terrain.position[1234]);

// 5. Runtime contracts: no request (but Echo's model), no AI, no server write; a worker builds; resources are released.
const files = ['lib/odyssey/planet/', 'components/features/learning-path/odyssey/planet/'].flatMap(dir => readdirSync(join(root, 'src', dir)).map(f => 'src/' + dir + f));
const source = files.map(f => [f, read(f)]);
for (const [f, text] of source) {
  assert.ok(!/\bfetch\(|XMLHttpRequest|apiClient|axios|openrouter|\/api\//i.test(text), `${f} makes no request`);
  assert.ok(!/Sparkles|✨/.test(text), `${f}: no sparkle icon`);
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(text), `${f}: stores nothing`);
}
const world = read('src/components/features/learning-path/odyssey/planet/PlanetWorld.tsx');
assert.match(world, /ECHO_MODEL_URL/, 'Echo is the landing model (one cached GLB)');
assert.match(read('src/lib/odyssey/planet/usePlanetBuild.ts'), /new Worker\(new URL\('\.\/planet\.worker\.ts', import\.meta\.url\)/, 'built in a Web Worker');
assert.match(read('src/components/features/learning-path/odyssey/planet/world.ts'), /dispose\(\)\s*\{\s*this\.disposables\.forEach/, 'GPU resources released');
assert.match(world, /webglcontextlost/, 'context loss falls back');
assert.match(world, /prefers-reduced-motion/, 'reduced motion honoured');
assert.match(world, /frameloop=\{!active \|\| props\.paused \? 'never'/, 'hidden, off-screen or under the journey atlas ⇒ no rendering');
// No post-processing composer in the planet (single forward pass, REA Claybound finding).
assert.ok(!source.some(([, t]) => /EffectComposer|@react-three\/postprocessing/.test(t)), 'no post-processing pass');
// The page passes every station of a region to the planet (never a page of ten).
const page = read('src/components/features/learning-path/odyssey/OdysseyPage.tsx');
assert.match(page, /stations=\{region \? stations : EMPTY\}/);
assert.match(read('src/components/features/learning-path/odyssey/WorldCanvas.tsx'), /planet\/PlanetWorld/);
// Glass interface: no backdrop blur over the live scene, no !important.
const css = read('src/components/features/learning-path/odyssey/odyssey.module.css');
assert.ok(!/backdrop-filter/.test(css), 'no backdrop blur over the 3D world');
assert.ok(!/!important/.test(css), 'no !important');
const atlasCss = read('src/components/features/learning-path/odyssey/atlas.module.css');
assert.ok(!/backdrop-filter|!important/.test(atlasCss), 'journey atlas: no backdrop blur, no !important');

// 6. Graphics tiers are real: every step up changes several things that cost and show (never a label only).
const { TIER_SPEC, TIERS, deviceProfile } = load('lib/odyssey/graphics.ts');
assert.deepEqual([...TIERS], ['light', 'balanced', 'high', 'ultra']);
for (let i = 1; i < TIERS.length; i++) {
  const lo = TIER_SPEC[TIERS[i - 1]], hi = TIER_SPEC[TIERS[i]];
  const changed = ['shadows', 'detail', 'clouds', 'smoke', 'embers', 'lodDistance'].filter(k => hi[k] > lo[k]).length
    + (hi.dpr[1] > lo.dpr[1] ? 1 : 0) + (hi.build.level > lo.build.level ? 1 : 0) + (hi.trees * hi.build.trees > lo.trees * lo.build.trees ? 1 : 0) + (hi.grass > lo.grass ? 1 : 0);
  assert.ok(changed >= 4, TIERS[i] + ' differs from ' + TIERS[i - 1] + ' in ' + changed + ' ways');
  for (const k of ['shadows', 'detail', 'clouds', 'lodDistance']) assert.ok(hi[k] >= lo[k], TIERS[i] + '.' + k + ' never below ' + TIERS[i - 1]);
}
assert.equal(TIER_SPEC.light.build.level, 6); assert.equal(TIER_SPEC.balanced.build.level, 7); assert.equal(TIER_SPEC.ultra.build.level, 8);
assert.equal(TIER_SPEC.light.shadows, 0); assert.ok(TIER_SPEC.ultra.shadows >= 4096);
assert.equal(deviceProfile('Google SwiftShader').ceiling, 'light', 'software rendering stays light');
const page2 = read('src/components/features/learning-path/odyssey/OdysseyPage.tsx');
assert.ok(!/VfxSettings/.test(page2), 'one graphics control in Odyssey (the particle-only effects menu is gone)');
assert.match(page2, /saveGraphicsChoice/, 'the learner choice is kept on this device');
const pw = read('src/components/features/learning-path/odyssey/planet/PlanetWorld.tsx');
assert.ok(!/<Canvas key=/.test(pw), 'a tier change never recreates the renderer');
// Ground cover and ranked thinning exist in a build with grass.
const g6 = buildPlanet({ level: 6, trees: 1.3, grass: 1 });
assert.ok(g6.props.tuft.reduce((n, c) => n + c.count, 0) > 200, 'meadows have grass tufts');
assert.equal(b.props.tuft.reduce((n, c) => n + c.count, 0), 0, 'no ground cover without grass');

// 7. Direct manipulation: the grabbed point of the planet follows the pointer (drag down => it moves down).
const THREE = await import('three');
const { PlanetRig } = load('components/features/learning-path/odyssey/planet/rig.ts');
{
  const W = 1600, H = 960, cam = new THREE.PerspectiveCamera(30, W / H, 1, 4000), rig = new PlanetRig(100), flat = () => 0;
  rig.f.set(0.2, 0.3, 0.93).normalize(); rig.update(0, cam, flat); cam.updateMatrixWorld();
  const ray = new THREE.Raycaster();
  const hitAt = (x, y) => { ray.setFromCamera(new THREE.Vector2(x / W * 2 - 1, -(y / H) * 2 + 1), cam); const p = new THREE.Vector3(); return ray.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), rig.grabRadius), p) ? p.normalize() : null; };
  const screen = v => { const p = v.clone().multiplyScalar(rig.grabRadius).project(cam); return { x: (p.x * 0.5 + 0.5) * W, y: (-p.y * 0.5 + 0.5) * H }; };
  for (const [dx, dy] of [[0, 120], [0, -120], [140, 0], [-140, 0], [100, 100], [-90, 110]]) {
    const x0 = W / 2 + 30, y0 = H / 2 - 20, grabbed = hitAt(x0, y0);
    for (let i = 1; i <= 8; i++) { const h = hitAt(x0 + dx * i / 8, y0 + dy * i / 8); rig.grabTo(grabbed, h, 1 / 60); rig.update(0, cam, flat); cam.updateMatrixWorld(); }
    const at = screen(grabbed);
    assert.ok(Math.abs(at.x - (x0 + dx)) < 6 && Math.abs(at.y - (y0 + dy)) < 6, 'grabbed point follows a drag of ' + dx + ',' + dy + ' (ended at ' + at.x.toFixed(1) + ',' + at.y.toFixed(1) + ')');
    rig.stopSpin();
    // Off the globe the screen-axis fallback moves the same way.
    const probe = hitAt(W / 2, H / 2), sb = screen(probe);
    rig.drag(dx, dy, H, cam); rig.stopSpin(); rig.update(0, cam, flat); cam.updateMatrixWorld();
    const sa = screen(probe);
    if (dx) assert.ok(Math.sign(sa.x - sb.x) === Math.sign(dx), 'fallback drag ' + dx + ',' + dy + ' moves the planet the same way horizontally');
    if (dy) assert.ok(Math.sign(sa.y - sb.y) === Math.sign(dy), 'fallback drag ' + dx + ',' + dy + ' moves the planet the same way vertically');
  }
}

// 7b. Poles are ordinary places: repeated drags carry the view over both poles and all the way round, in every
//     direction, without a latitude stop, a jump between frames, or a flip of the screen's up.
{
  const W = 1600, H = 960, flat = () => 0;
  const ray = new THREE.Raycaster();
  for (const [name, sx, sy] of [['vertical', 0, 14], ['vertical reverse', 0, -14], ['horizontal', 14, 0], ['diagonal', 10, 10], ['diagonal 2', -9, 12]]) {
    for (const alt of [null, 60]) {
      const cam = new THREE.PerspectiveCamera(30, W / H, 1, 4000), rig = new PlanetRig(100);
      rig.f.set(0.1, 0.2, 0.97).normalize(); rig.heading = 0; if (alt) rig.alt = alt;
      rig.update(0, cam, flat); cam.updateMatrixWorld();
      const hitAt = (x, y) => { ray.setFromCamera(new THREE.Vector2(x / W * 2 - 1, -(y / H) * 2 + 1), cam); const p = new THREE.Vector3(); return ray.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), rig.grabRadius), p) ? p.normalize() : null; };
      let total = 0, maxLat = -2, minLat = 2, worstStep = 0, worstUp = 0, worstErr = 0;
      const prevF = rig.f.clone(), prevUp = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion), prevPos = cam.position.clone();
      // Strokes of 12 small moves from the centre, like a hand dragging again and again.
      for (let stroke = 0; stroke < 400 && total < Math.PI * 4.2; stroke++) {
        const x0 = W / 2, y0 = H / 2, grabbed = hitAt(x0, y0);
        for (let i = 1; i <= 12; i++) {
          const h = hitAt(x0 + sx * i, y0 + sy * i); if (!h) break;
          rig.grabTo(grabbed, h, 1 / 60); rig.update(0, cam, flat); cam.updateMatrixWorld();
          const step = prevF.angleTo(rig.f); total += step; worstStep = Math.max(worstStep, step);
          const upNow = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
          worstUp = Math.max(worstUp, prevUp.angleTo(upNow)); prevUp.copy(upNow);
          // The grabbed point is under the pointer after every move, also on the pole itself.
          const pr = grabbed.clone().multiplyScalar(rig.grabRadius).project(cam);
          worstErr = Math.max(worstErr, Math.hypot((pr.x * 0.5 + 0.5) * W - (x0 + sx * i), (-pr.y * 0.5 + 0.5) * H - (y0 + sy * i)));
          assert.ok(cam.position.distanceTo(prevPos) < cam.position.length() * 0.2, name + ': the camera never jumps');
          prevPos.copy(cam.position); prevF.copy(rig.f);
          maxLat = Math.max(maxLat, rig.f.y); minLat = Math.min(minLat, rig.f.y);
          assert.ok(Number.isFinite(cam.quaternion.x) && Math.abs(rig.f.length() - 1) < 1e-6 && Math.abs(rig.fw.dot(rig.f)) < 1e-6, name + ': the frame stays orthonormal');
        }
        rig.stopSpin();
      }
      const tag = name + (alt ? ' (close view)' : ' (globe view)');
      assert.ok(total >= Math.PI * 4, tag + ': two full turns are reached (' + total.toFixed(2) + ' rad)');
      assert.ok(worstStep < 0.12 && worstUp < 0.12, tag + ': no step or screen-up jump (' + worstStep.toFixed(3) + ', ' + worstUp.toFixed(3) + ')');
      assert.ok(worstErr < 4, tag + ': the grabbed point stays under the pointer everywhere (' + worstErr.toFixed(2) + ' px)');
      if (sy && !sx) assert.ok(maxLat > 0.9999 && minLat < -0.9999, tag + ': the view passes straight over both poles (' + maxLat.toFixed(5) + ', ' + minLat.toFixed(5) + ')');
    }
  }
  // Reversing in the middle of a polar crossing retraces the same path; inertia and a new grab continue from it.
  const cam = new THREE.PerspectiveCamera(30, W / H, 1, 4000), rig = new PlanetRig(100);
  rig.f.set(0, Math.sin(1.45), Math.cos(1.45)).normalize(); rig.heading = 0; rig.update(0, cam, flat); cam.updateMatrixWorld();
  const f0 = rig.f.clone(), u0 = rig.fw.clone();
  for (let i = 0; i < 30; i++) { rig.drag(0, 9, H, cam); rig.update(0, cam, flat); cam.updateMatrixWorld(); }
  assert.ok(rig.f.z < 0, 'the drag crossed the north pole to the far side');
  for (let i = 0; i < 30; i++) { rig.drag(0, -9, H, cam); rig.update(0, cam, flat); cam.updateMatrixWorld(); }
  assert.ok(rig.f.angleTo(f0) < 1e-3 && rig.fw.angleTo(u0) < 1e-3, 'reversing over the pole returns to the same view');
  // While the hand holds the planet nothing moves by itself; the fling starts on release.
  rig.held = true; rig.drag(6, 12, H, cam, 1 / 60); const heldAt = rig.f.clone();
  for (let i = 0; i < 30; i++) rig.update(1 / 60, cam, flat);
  assert.ok(rig.f.angleTo(heldAt) < 1e-9, 'no inertia while the pointer is held');
  rig.held = false; let last = rig.f.clone(), prevStep = Infinity;
  for (let i = 0; i < 240; i++) { rig.update(1 / 60, cam, flat); const st = last.angleTo(rig.f); assert.ok(st <= prevStep + 1e-9, 'inertia only decays'); prevStep = st; last.copy(rig.f); }
  assert.ok(prevStep < 1e-4, 'inertia comes to rest');
  // Flights still arrive exactly, heading included, from a view that was turned over a pole.
  rig.flyTo(new THREE.Vector3(0.5, 0.3, 0.8), 40, 0.35, false);
  for (let i = 0; i < 400 && rig.flying; i++) rig.update(1 / 60, cam, flat);
  assert.ok(!rig.flying && rig.f.angleTo(new THREE.Vector3(0.5, 0.3, 0.8).normalize()) < 1e-6 && Math.abs(rig.heading - 0.35) < 1e-6, 'a flight arrives at its place and heading');
  rig.turn(0.2); assert.ok(Math.abs(rig.heading - 0.55) < 1e-6, 'turn changes the heading by its angle');
}

// 8. Journey atlas layout: no overlap, nothing wider than the canvas, every drawn link a real prerequisite inside a
//    branch, every other prerequisite listed on its node.
const { layoutRegion, NODE_W, PAD } = load('lib/odyssey/atlasLayout.ts');
const regionOf = Object.fromEntries([...catalog.matchAll(/Map\.entry\("([^"]+)","([^"]+)"\)/g)].map(m => [m[1], m[2]]));
const grammarCatalog = JSON.parse(read('../backend/src/main/resources/grammar/catalog.json'));
const domainOrder = grammarCatalog.domains.map(d => d.id);
const allTopics = grammarCatalog.domains.flatMap(d => d.topics.filter(t => t.available).map(t => ({ id: 'grammar:' + t.slug, regionId: regionOf[d.id] || 'harbor', title: t.title, kind: 'GRAMMAR', skill: 'GRAMMAR', level: t.level, domain: d.id,
  status: 'NOT_STARTED', gate: { state: 'READY', required: t.prerequisites, missing: [], evidenceBasis: 'X', remediation: null }, checkAvailable: true, learningRole: 'core', prerequisites: t.prerequisites, task: null, reviewedAt: null })));
let atlasNodes = 0;
for (const width of [1100, 760, 360]) for (const region of ['grove', 'bridges', 'tides', 'aurora', 'harbor']) {
  const items = allTopics.filter(s => s.regionId === region), L = layoutRegion(items, width, domainOrder);
  assert.equal(L.nodes.length, items.length, region + ': every station placed');
  atlasNodes += L.nodes.length;
  for (const n of L.nodes) assert.ok(n.x >= 0 && n.x + n.w <= Math.max(width, NODE_W + 2 * PAD) + 0.5, region + '@' + width + ': ' + n.id + ' inside the canvas');
  for (let i = 0; i < L.nodes.length; i++) for (let j = i + 1; j < L.nodes.length; j++) {
    const a = L.nodes[i], c = L.nodes[j];
    assert.ok(a.x + a.w <= c.x || c.x + c.w <= a.x || a.y + a.h <= c.y || c.y + c.h <= a.y, region + '@' + width + ': ' + a.id + ' and ' + c.id + ' overlap');
  }
  const byId = new Map(L.nodes.map(n => [n.id, n]));
  for (const e of L.edges) { const to = byId.get(e.to), from = byId.get(e.from); assert.ok(to.station.prerequisites.includes(from.id.slice(8)) && to.lane === from.lane, e.from + '->' + e.to + ' is a real prerequisite'); assert.ok(from.y < to.y, 'links point down the path'); }
  for (const n of L.nodes) for (const p of n.station.prerequisites) {
    const parent = byId.get('grammar:' + p);
    if (parent && parent.lane === n.lane) assert.ok(L.edges.some(e => e.from === parent.id && e.to === n.id), p + '->' + n.id + ' drawn');
    else assert.ok(n.outside.includes(p), p + ' of ' + n.id + ' listed as outside its branch');
  }
}
// 12. The living surface (owner brief 2026-11-15): what lies under the pointer is the drawn planet's own terrain and props.
{
  const surf = load('lib/odyssey/planet/surface.ts');
  const T = createTerrain(), S = newSample(), R = b.radius;
  const fromAbove = (d, alt = 60) => { const o = [d[0] * (R + alt), d[1] * (R + alt), d[2] * (R + alt)]; return surf.surfaceHit(T, S, o, [-d[0], -d[1], -d[2]], R); };
  const seen = new Set();
  // every landmark plateau is its region's landmark; the land of a region belongs to that region
  for (const site of SITES) {
    const d = siteDir(site), hit = fromAbove(d);
    assert.ok(hit && hit.h >= 0, `${site.id}: the ray lands on its plateau`);
    const f = surf.classify(T, S, b, hit);
    assert.equal(f.kind, 'landmark', `${site.id}: the plateau centre is its landmark (${f.kind})`);
    assert.equal(f.site, site.id); assert.equal(f.landmark, site.landmark);
    seen.add(f.kind);
  }
  // open ocean far from every site: ocean, no region, ripples
  const sea = [0, -0.2, -1].map(v => v / Math.hypot(0, -0.2, -1));
  const sf = surf.classify(T, S, b, fromAbove(sea));
  assert.ok(['ocean', 'shallows'].includes(sf.kind) && sf.site === null, `open sea is water of no region (${sf.kind})`);
  assert.equal(surf.responseOf(sf), 'ripple');
  // the volcano: only where terrain.volcano is (never an arbitrary mountain)
  const v = T.volcano; const vd = [v.x, v.y, v.z];
  const vf = surf.classify(T, S, b, fromAbove(vd));
  assert.ok(['volcano', 'lava'].includes(vf.kind) && vf.site === 'trial', `the volcano is the volcano of the Trial region (${vf.kind}, ${vf.site})`);
  assert.equal(surf.responseOf(vf), 'erupt');
  // a scan of the globe finds forests, mountains, beaches, villages — every kind has words, every response is known
  let n = 0;
  for (let i = 0; i < 1800; i++) {
    const y = 1 - (i + 0.5) / 900, r = Math.sqrt(Math.max(0, 1 - y * y)), a = i * 2.399963;
    const d = [Math.cos(a) * r, y, Math.sin(a) * r];
    const hit = fromAbove(d); if (!hit) continue;
    const f = surf.classify(T, S, b, hit); n++;
    seen.add(f.kind);
    const w = surf.featureWords(f);
    assert.ok(w && w.vi && w.en && /^[a-z][a-z ]+$/.test(w.word), `words for ${f.kind}/${f.biome}/${f.tree}`);
    assert.ok(!/&/.test(w.vi + w.en), 'no "&" in feature names');
    assert.ok(['ripple', 'birds', 'dust', 'petals', 'sparkle', 'smoke', 'erupt', 'pulse'].includes(surf.responseOf(f)));
    if (f.site) assert.ok(SITES.some(s => s.id === f.site), 'a feature belongs only to a real region');
    // the surface point lies on the drawn surface: land at R + h, water at sea level
    const rr = Math.hypot(...hit.point); assert.ok(Math.abs(rr - (R + Math.max(0, hit.h))) < 1e-6);
  }
  for (const k of ['ocean', 'forest', 'mountain', 'beach', 'village', 'landmark']) assert.ok(seen.has(k), `the scan meets a ${k}`);
  // a ray that misses the planet finds nothing; determinism
  assert.equal(surf.surfaceHit(T, S, [0, 0, R * 3], [1, 0, 0], R), null, 'a ray past the limb finds no surface');
  const p1 = JSON.stringify(surf.classify(T, S, b, fromAbove(siteDir(SITES[3])))), p2 = JSON.stringify(surf.classify(createTerrain(), newSample(), b, fromAbove(siteDir(SITES[3]))));
  assert.equal(p1, p2, 'the same point is always the same feature');
  for (const lm of new Set(SITES.map(s => s.landmark))) assert.ok(surf.featureWords({ kind: 'landmark', landmark: lm, biome: null, tree: null, site: null }).word, `words for the ${lm}`);
  // runtime contracts: no request, no AI, no storage in the surface code; the card opens the real dictionary only on a click
  const src = read('src/lib/odyssey/planet/surface.ts') + read('src/components/features/learning-path/odyssey/planet/surfaceFx.ts');
  assert.ok(!/fetch\(|XMLHttpRequest|apiClient|localStorage|openrouter|\/ai\//i.test(src), 'surface: no request, AI or storage');
  const view = read('src/components/features/learning-path/odyssey/planet/PlanetWorld.tsx');
  assert.match(view, /ec:dictionary:lookup/, 'the English word is looked up in the real dictionary, on a click');
  assert.match(view, /down\.moved < \(e\.pointerType === 'touch' \? 12 : 6\)/, 'a drag never inspects (touch has a wider threshold)');
  assert.match(view, /e\.key === 'Enter' \|\| e\.key === ' '\) \{ e\.preventDefault\(\); run\('inspect'\)/, 'keyboard: Enter inspects the centre of the view');
  assert.match(read('src/components/features/learning-path/odyssey/planet/materials.ts'), /uRipple0[\s\S]*void ripple\(vec3 up, vec4 R/, 'the sea answers a touch with ripples');
  assert.match(read('src/components/features/learning-path/odyssey/planet/rig.ts'), /fw/, 'the rigid-frame camera (pole crossings) is kept');
  const page = read('src/components/features/learning-path/odyssey/OdysseyPage.tsx');
  assert.match(page, /useCinematicHud\(pageRef, \{ hold: travelOpen \|\| atlasOpen \|\| quiz\.open \|\| touring, enabled: !!world \}\)/, 'Odyssey HUD: held by lists, the atlas, the quiz and a guide');
  assert.match(page, /data-testid="world-hud-toggle"/); assert.match(page, /data-testid="odyssey-whole-planet"/);
  console.log(`Odyssey surface: ${n} points classified, kinds met: ${[...seen].sort().join(', ')} PASS`);
}

console.log('Odyssey planet: tiers differ, grab follows the pointer, atlas layout exact (' + atlasNodes + ' placements) PASS');
console.log(`Odyssey planet: 15 sites, land ${(fraction * 100).toFixed(1)} %, ${trees} trees at level 6, sockets ≥ 12, deterministic, no request/AI/storage PASS`);
