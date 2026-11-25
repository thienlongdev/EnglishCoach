// Echo Spatial (Không gian 3D) contracts. Static source rules + the pure route and preference rules, run on the real sources.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const read = (p) => fs.readFileSync(path.join(src, p), 'utf8');
const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
};

/** Transpile a dependency-free TS module and evaluate it. */
function loadTs(rel, stubs = {}) {
  const source = read(rel);
  const out = babel.core().transformSync(source, { filename: rel.split('/').pop(), babelrc: false, configFile: false, presets: [babel.presetTypescript()], plugins: [babel.pluginTransformModulesCommonjs()] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', out.code)(module, module.exports, (name) => {
    if (stubs[name]) return stubs[name];
    if (name === '@/lib/appearance/scope') return loadTs('lib/appearance/scope.ts');
    throw new Error(`unexpected import ${name}`);
  });
  return module.exports;
}

const catalogSource = read('lib/spatial/catalog.ts');
const { SPATIAL_PRESETS, SPATIAL_CATEGORIES, PALETTES } = loadTs('lib/spatial/catalog.ts');
const loaders = read('lib/spatial/scenes/loaders.ts');

const TOTAL_PRESETS = 58;

check('the library: the 48 effects and 8 compositions of the brief + the two V2 scenes, no aliases', () => {
  assert.equal(SPATIAL_PRESETS.length, TOTAL_PRESETS);
  const per = {};
  for (const p of SPATIAL_PRESETS) per[p.category] = (per[p.category] || 0) + 1;
  for (const c of ['gallery', 'cinematic', 'transition', 'type', 'pointer', 'surface']) assert.equal(per[c], 6, c);
  for (const c of ['material', 'geometry']) assert.equal(per[c], 7, c);
  assert.equal(per.immersive, 8);
  assert.equal(new Set(SPATIAL_PRESETS.map((p) => p.id)).size, TOTAL_PRESETS);
  assert.equal(new Set(SPATIAL_PRESETS.map((p) => p.titleVi)).size, TOTAL_PRESETS);
  assert.equal(new Set(SPATIAL_PRESETS.map((p) => p.descVi)).size, TOTAL_PRESETS);
  assert.equal(SPATIAL_CATEGORIES.length, 9);
});

check('every preset is a real behaviour set: its scene has a source file, and no two presets are the same recipe', () => {
  const recipes = new Set();
  for (const p of SPATIAL_PRESETS) {
    assert.ok(loaders.includes(`${p.scene}: () => import('./${p.scene}')`), `loader for ${p.scene}`);
    assert.ok(fs.existsSync(path.join(src, 'lib/spatial/scenes', `${p.scene}.ts`)), `scene file ${p.scene}`);
    assert.ok(PALETTES[p.palette], `palette of ${p.id}`);
    for (const key of ['titleVi', 'titleEn', 'descVi', 'descEn', 'touchVi', 'touchEn', 'tech']) assert.ok(p[key]?.length > 2, `${p.id} ${key}`);
    const recipe = JSON.stringify([p.scene, p.sceneOpts ?? {}, p.surface, p.sheen, !!p.glass, p.transition, p.type, p.overlay]);
    assert.ok(!recipes.has(recipe), `duplicate recipe ${p.id}`);
    recipes.add(recipe);
  }
  // Categories F and E are defined by what they do to headings and route changes: each uses its own.
  const distinct = (category, field) => assert.equal(new Set(SPATIAL_PRESETS.filter((p) => p.category === category).map((p) => p[field])).size, 6, `${category} ${field}`);
  distinct('type', 'type');
  distinct('transition', 'transition');
});

check('no "&" in the display copy of the library (10 §BD)', () => {
  for (const p of SPATIAL_PRESETS) for (const key of ['titleVi', 'titleEn', 'descVi', 'descEn', 'touchVi', 'touchEn']) assert.ok(!p[key].includes('&'), `${p.id} ${key}`);
});

const { spatialProfile, OUTSIDE_SHELL } = loadTs('lib/spatial/context.ts');
const q = (s = '') => new URLSearchParams(s);

check('coverage matrix: every route of the app has a decided behaviour, the selected preset is never dropped by navigation', () => {
  const app = path.join(src, 'app');
  const routes = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name === 'page.tsx') routes.push(`/${path.relative(app, dir).replace(/\\/g, '/')}`.replace(/\/$/, '') || '/');
    }
  };
  walk(app);
  const outside = OUTSIDE_SHELL.map((o) => o.route).join(' ');
  for (const route of routes) {
    if (route === '/qa-spatial' || route === '/qa-worlds') continue;
    const inOutside = outside.includes(route.replace(/\[[^\]]+\]/g, (m) => m)) || /^\/(login|register|forgot-password|reset-password|verify-email|landing-preview)/.test(route) || route.includes('/attempts/') || /echo-garden|echo-quiz-rush/.test(route);
    if (inOutside) continue;
    const concrete = route.replace(/\[[^\]]+\]/g, '1');
    const profile = spatialProfile(concrete === '' ? '/' : concrete, q());
    assert.ok(profile && profile.id, `no profile for ${route}`);
    assert.ok(['live', 'calm', 'off'].includes(profile.env));
  }
});

check('learning screens stay still; rich screens play', () => {
  const lesson = spatialProfile('/listening/12', q());
  assert.equal(lesson.surfaces, 'still');
  assert.equal(lesson.type, false);
  assert.equal(lesson.overlay, false);
  assert.ok(lesson.calm >= 0.8);
  assert.equal(spatialProfile('/listening/12/practice', q()).env, 'off');
  assert.equal(spatialProfile('/listening/12/practice', q()).surfaces, 'off');
  assert.equal(spatialProfile('/speaking/shadowing/4', q()).surfaces, 'still');
  assert.equal(spatialProfile('/exams/toeic/practice/abc', q()).transition, 'off');
  assert.equal(spatialProfile('/', q('tab=reading&materialId=4')).surfaces, 'still');
  assert.equal(spatialProfile('/', q('tab=writing')).type, false);
  assert.equal(spatialProfile('/games/hangman', q()).env, 'off');
  assert.equal(spatialProfile('/', q()).surfaces, 'play');
  assert.equal(spatialProfile('/games', q()).lens, true);
  assert.equal(spatialProfile('/', q('tab=flashcards')).lens, true);
  assert.equal(spatialProfile('/', q('tab=reading')).lens, true);
});

check('the journey required by the owner keeps a live identity on every step', () => {
  for (const [p, s] of [['/', 'tab=dashboard'], ['/', 'tab=reading'], ['/', 'tab=listening'], ['/', 'tab=speaking'], ['/', 'tab=writing'], ['/', 'tab=flashcards'], ['/learning-path', ''], ['/games', ''], ['/profile', '']]) {
    const profile = spatialProfile(p, q(s));
    assert.notEqual(profile.env, 'off', `${p}?${s} keeps its scene`);
    assert.notEqual(profile.surfaces, 'off', `${p}?${s} keeps its surfaces`);
  }
});

check('preference: default off, re-validated, per account', () => {
  const memory = new Map();
  globalThis.localStorage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v) };
  const { DEFAULT_SPATIAL, normalizeSpatial, spatialKey } = loadTs('lib/spatial/preference.ts');
  assert.equal(DEFAULT_SPATIAL.enabled, false);
  assert.equal(normalizeSpatial(null).enabled, false);
  assert.equal(normalizeSpatial({ enabled: 'yes' }).enabled, false);
  assert.equal(normalizeSpatial({ presetId: '../evil' }).presetId, DEFAULT_SPATIAL.presetId);
  assert.equal(normalizeSpatial({ depth: 9 }).depth, 1);
  assert.equal(normalizeSpatial({ quality: 'ultra' }).quality, 'auto');
  assert.equal(spatialKey(42), 'ec_spatial:v1:u42');
  assert.equal(spatialKey(null), 'ec_spatial:v1:guest');
});

check('default-off guarantee: the shell imports only the tiny host; the engine, three and the stylesheet are lazy', () => {
  const frame = read('components/layout/ApplicationFrame.tsx');
  assert.ok(frame.includes("import SpatialHost from '@/components/spatial/SpatialHost'"));
  assert.ok(!frame.includes('lib/spatial/engine'));
  const host = read('components/spatial/SpatialHost.tsx');
  assert.ok(host.includes("dynamic(() => import('./SpatialRuntimeView')"));
  assert.ok(host.includes('if (!pref.enabled || (wallpaperOn && !isSpatialDraft(key))) return null'), 'off, or another appearance active: nothing of the feature is on the page');
  assert.ok(!/spatial\.css|engine\/|catalog'/.test(host));
  const state = read('lib/appearance/state.ts');
  assert.ok(!/spatial\.css|engine\/|spatial\/catalog|from 'three'/.test(state), 'the appearance state stays small: it is in the main bundle');
  const pref = read('lib/spatial/preference.ts');
  assert.ok(!/from ['"](?:three|.*engine|.*catalog)/.test(pref), 'preference imports no graphics, engine or catalog');
  assert.ok(!catalogSource.includes("from 'three'"));
  const stage = read('components/wallpaper/WallpaperStage.tsx');
  assert.ok(!stage.includes('spatial/engine') && !stage.includes('spatial/catalog'));
  const studio = read('components/wallpaper/WallpaperStudio.tsx');
  assert.ok(studio.includes("if (room === 'spatial') return <SpatialStudio"));
  assert.ok(read('components/spatial/SpatialStudio.tsx').includes("import('@/lib/spatial/engine/controller')"), 'the studio loads the engine on demand');
});

check('client-only: no scene, engine or studio file talks to a server or an AI', () => {
  const dir = path.join(src, 'lib/spatial');
  const files = [];
  const walk = (d) => fs.readdirSync(d).forEach((n) => { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) walk(f); else files.push(f); });
  walk(dir);
  ['SpatialHost.tsx', 'SpatialRuntimeView.tsx', 'SpatialStudio.tsx', 'SpatialGalleryRoom.tsx'].forEach((n) => files.push(path.join(src, 'components/spatial', n)));
  for (const file of files) {
    if (file.endsWith('.css')) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const banned of ['fetch(', 'axios', 'apiClient', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', '/api/v1', 'openrouter']) {
      assert.ok(!text.includes(banned), `${path.basename(file)} must not use ${banned}`);
    }
  }
});

check('one runtime: scenes never start their own loop or listener, the engine reuses the shared world runtime', () => {
  const controller = read('lib/spatial/engine/controller.ts');
  assert.ok(controller.includes("import { startWorld"));
  const scenes = fs.readdirSync(path.join(src, 'lib/spatial/scenes'));
  for (const name of scenes) {
    const text = read(`lib/spatial/scenes/${name}`);
    assert.ok(!text.includes('requestAnimationFrame'), `${name} owns no loop`);
    assert.ok(!text.includes('addEventListener'), `${name} owns no listener`);
    assert.ok(!text.includes('getContext(\'webgl'), `${name} creates no context`);
  }
});

check('protected surfaces: the walker never moves a field, a video, a canvas or a dialog; pointer use is passive', () => {
  const s = read('lib/spatial/engine/surfaces.ts');
  for (const token of ['iframe', 'video', 'canvas', 'textarea', '[contenteditable="true"]', '[data-spatial-exclude]', '[role="dialog"]', '.fixed']) assert.ok(s.includes(token), token);
  assert.ok(s.includes("cs.transformStyle === 'preserve-3d'"), 'a 3D flip card stays its own');
  assert.ok(!s.includes('preventDefault'));
  assert.ok(!/scrollTo\(|scrollBy\(|scrollIntoView\(/.test(s) && !/scroller\.scrollTop\s*=[^=]/.test(s), 'native scroll is only read, never written');
  assert.ok(s.includes('el.style.transform = \'\''), 'a card at rest has no transform');
  const css = read('lib/spatial/spatial.css');
  assert.ok(!css.includes('!important'));
  assert.ok(css.includes('pointer-events: none'));
  assert.ok(!css.includes('font-family'));
  const view = read('components/spatial/SpatialRuntimeView.tsx');
  assert.ok(view.includes('isSpatialDraft(storageKey) && hasWallpaper'), 'only a preset being tried rests a wallpaper, and never writes it');
});

check('one active appearance (10 §BI): one rule decides, every switch goes through it, browsing writes nothing', () => {
  const memory = new Map();
  globalThis.localStorage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v) };
  const wp = { current: new Map() };
  const stubs = {
    '@/lib/wallpaper/storage': {
      accountKey: (a) => `ec_wallpaper:v2:${a ? `u${a}` : 'guest'}`,
      currentPreference: (k) => wp.current.get(k) ?? { source: 'none' },
      normalizePreference: (x) => x,
      writePreference: (k, v) => wp.current.set(k, v),
    },
    '@/lib/spatial/preference': (() => {
      const sp = new Map();
      let draft = null;
      return {
        spatialKey: (a) => `ec_spatial:v1:${a ? `u${a}` : 'guest'}`,
        storedSpatial: (k) => sp.get(k) ?? { enabled: false, presetId: 'x' },
        currentSpatial: (k) => draft ?? sp.get(k) ?? { enabled: false, presetId: 'x' },
        writeSpatial: (k, v) => sp.set(k, v),
        setSpatialDraft: (_k, v) => (draft = v),
        isSpatialDraft: () => !!draft,
      };
    })(),
  };
  const { resolveAppearance, applySpatialAppearance, commitMediaAppearance, restoreDefaultAppearance, reconcileAppearance, currentAppearance, accountOfKey } = loadTs('lib/appearance/state.ts', stubs);
  const on = { enabled: true, presetId: 'wavy-cubes' };
  const off = { enabled: false, presetId: 'wavy-cubes' };
  assert.equal(resolveAppearance({ source: 'none' }, off, false).mode, 'default');
  assert.equal(resolveAppearance({ source: 'none' }, on, false).mode, 'spatial');
  assert.equal(resolveAppearance({ source: 'preset', presetId: 'a' }, off, false).mode, 'wallpaper');
  assert.equal(resolveAppearance({ source: 'world', worldId: 'a' }, off, false).mode, 'world');
  assert.equal(resolveAppearance({ source: 'world', worldId: 'a' }, on, false).mode, 'world', 'an unfinished apply: the wallpaper already outranks the preset');
  assert.equal(resolveAppearance({ source: 'world', worldId: 'a' }, on, true).mode, 'spatial', 'trying a preset rests it');
  assert.equal(accountOfKey('ec_spatial:v1:u42'), '42');
  assert.equal(accountOfKey('ec_wallpaper:v2:guest'), '');
  const A = '7';
  wp.current.set('ec_wallpaper:v2:u7', { source: 'world', worldId: 'aurora-silk' });
  applySpatialAppearance(A, on);
  assert.equal(currentAppearance(A).mode, 'spatial');
  assert.equal(wp.current.get('ec_wallpaper:v2:u7').source, 'none');
  wp.current.set('ec_wallpaper:v2:u7', { source: 'preset', presetId: 'ocean-light' });
  commitMediaAppearance(A);
  assert.equal(currentAppearance(A).mode, 'wallpaper');
  restoreDefaultAppearance(A);
  assert.equal(currentAppearance(A).mode, 'default');
  // Legacy: V1 could store both. Once per account the newer system wins and the wallpaper goes dormant.
  stubs['@/lib/spatial/preference'].writeSpatial('ec_spatial:v1:u8', on);
  wp.current.set('ec_wallpaper:v2:u8', { source: 'world', worldId: 'aurora-silk' });
  reconcileAppearance('8');
  assert.equal(currentAppearance('8').mode, 'spatial');
  // Browsing: the rooms write only inside their Apply handlers, and the shared bar only in its default button.
  const media = read('components/wallpaper/WallpaperStudio.tsx');
  assert.ok(!/useEffect\(\(\) => \{\s*writePreference/.test(media) && !/setRoom\([^)]*\);\s*writePreference/.test(media));
  assert.ok(media.includes('commitMediaAppearance(appearanceAccount)'));
  const worlds = read('components/wallpaper/WorldStudio.tsx');
  assert.ok(worlds.includes('commitMediaAppearance(accountOfKey(storageKey))'));
  const spatial = read('components/spatial/SpatialStudio.tsx');
  assert.ok(spatial.includes('applySpatialAppearance(account,') && !spatial.includes('writeSpatial('), 'the room applies only through the coordinator');
  // A layer on its way out never comes back on a late first frame; a resting wallpaper releases its decoder or context.
  const stage = read('components/wallpaper/WallpaperStage.tsx');
  assert.ok(stage.includes("layer.phase !== 'leaving')) return prev"));
  assert.ok(stage.includes('if (!source || spatialBackdrop) return null'));
});

check('one owner per transform: the walker never writes on what something else animates', () => {
  const s = read('lib/spatial/engine/surfaces.ts');
  assert.ok(s.includes('function ownsItsTransform'));
  assert.ok(s.includes("cs.transform !== 'none'"));
  assert.ok(s.includes("hasAttribute('data-spatial-owner')"));
  assert.ok(s.includes('el.style.transform !== s.wrote'), 'a foreign write takes the element away from the engine');
  assert.ok(s.includes('[draggable="true"]'));
  const hub = read('components/features/games/GamesHub.tsx');
  assert.ok(hub.includes('data-spatial-owner="carousel"'), 'the Games Hub carousel keeps its own motion');
  assert.ok(hub.includes('overflowX !== "visible"'), 'a card overhanging the arc is not the narrow rail');
  const kit = read('lib/spatial/scenes/kit.ts');
  assert.ok(kit.includes('if (vMeta.w > 1.5) discard'), 'an owned component gets no slab: its box is not its shape');
});

check('scene input is second to the page: a press on a control of the page is not a touch of the scene', () => {
  const r = read('lib/wallpaper/worlds/runtime.ts');
  assert.ok(r.includes('PAGE_CONTROL'));
  assert.ok(r.includes('event.target.closest(PAGE_CONTROL)'));
  assert.ok(r.includes("{ passive: true, capture: true }"));
  assert.ok(!r.includes('setPointerCapture') && !r.includes('preventDefault()\n    pendingPulses'));
  const css = read('lib/spatial/spatial.css');
  assert.ok(css.includes('.ec-sp-stage') && css.includes('pointer-events: none'));
});

check('real interaction: the water is a surface hit by a ray, Echo and the bubbles are bodies', () => {
  const a = read('lib/spatial/scenes/atmosphere.ts');
  assert.ok(a.includes('makeSurfaceWaves') && a.includes('onWater(') && a.includes('toPool('), 'a ring starts where the ray met the pool');
  const k = read('lib/spatial/scenes/kit.ts');
  assert.ok(k.includes('export function makeSurfaceWaves') && k.includes('export function rayFrom') && k.includes('export function raySphere'));
  const w = read('lib/spatial/scenes/signature.ts');
  for (const token of ['bubbleCount', 'pop(i)', 'bodyHits', 'curious', 'bored', 'fleeing', 'rollLeft', 'uRing']) assert.ok(w.includes(token), token);
  // No scene of the transition family is deaf any more; a press reaches the fragment scenes as a travelling ring.
  const e = read('lib/spatial/scenes/transitionEnv.ts');
  for (const token of ['uMouse', 'uEnergy', 'pressWave', 'rings: true']) assert.ok(e.includes(token), token);
  const g = read('lib/spatial/scenes/gallery.ts');
  for (const token of ['function answer(', 'spinX', 'presses']) assert.ok(g.includes(token), token);
});

check('headings: one visible owner of the glyphs (10 §BI)', () => {
  const t = read('lib/spatial/engine/typography.ts');
  assert.ok(t.includes("layer.setAttribute('aria-hidden', 'true')"));
  assert.ok(!/el\.textContent\s*=/.test(t) && !/\.innerHTML/.test(t), 'never rewrites the heading');
  assert.ok(t.includes('h1,h2'));
  assert.ok(t.includes('[contenteditable="true"]'));
  assert.ok(!/\bfetch\(/.test(t));
  // Depth, extrusion and ripple move the real heading: no second text exists for them.
  assert.ok(t.includes("el.style.transform = extrude") && t.includes('el.style.filter'));
  // Letter effects: the layer is measured from the real layout, exists only while they run, and the real ink goes at once.
  assert.ok(t.includes('range.getClientRects()[0]'), 'each glyph where the browser put it');
  assert.ok(t.includes("b.el.dataset.spInk = 'hidden'") && t.includes('delete b.el.dataset.spInk'));
  assert.ok(t.includes('Intl as unknown') || t.includes('Segmenter'), 'graphemes, not code points');
  const css = read('lib/spatial/spatial.css');
  assert.ok(/\[data-sp-ink\][\s\S]{0,240}background-image: none/.test(css), 'a gradient clipped to the text goes too');
  assert.ok(!css.includes('.ec-sp-layer {'), 'no stacked copies');
});

check('transitions: animate only, never block the router, nothing left behind', () => {
  const t = read('lib/spatial/engine/transitions.ts');
  assert.ok(t.includes(".animate("));
  assert.ok(t.includes("fill: 'none'"));
  assert.ok(!t.includes('router.push') && !t.includes('startViewTransition') && !t.includes('preventDefault'));
  for (const kind of ['morph', 'panel', 'portal', 'fluid', 'flip', 'zoom']) assert.ok(t.includes(`case '${kind}'`), kind);
});

check('the shell: sidebar entry renamed, three rooms in one dialog, no new sidebar module', () => {
  const sidebar = read('components/layout/Sidebar.tsx');
  assert.ok(sidebar.includes('vi ? "Giao diện" : "Appearance"'));
  assert.ok(sidebar.includes('data-testid="sidebar-wallpaper"'));
  const bar = read('components/wallpaper/StudioBar.tsx');
  assert.ok(bar.includes("'Hình nền'") && bar.includes("'Thế giới sống'") && bar.includes("'Không gian 3D'"));
  assert.ok(bar.includes('data-testid={`studio-room-${id}`}') && bar.includes('data-testid="appearance-default"') && bar.includes('data-testid="appearance-active"'));
  assert.ok(bar.includes('restoreDefaultAppearance(account)'));
  for (const file of ['components/wallpaper/WallpaperStudio.tsx', 'components/wallpaper/WorldStudio.tsx', 'components/spatial/SpatialStudio.tsx']) {
    assert.ok(read(file).includes('<StudioBar room='), `${file} uses the one header`);
  }
  const css = read('components/wallpaper/WallpaperStudio.module.css');
  assert.ok(/\.studio \{[\s\S]{0,60}position: fixed;\s*inset: 0;/.test(css), 'the wallpaper room fills the window like the other two');
  const studio = read('components/spatial/SpatialStudio.tsx');
  for (const id of ['spatial-apply', 'spatial-try', 'spatial-search']) assert.ok(studio.includes(`data-testid="${id}"`), id);
});

check('no temporary capture page can ship', () => {
  assert.ok(!fs.existsSync(path.join(src, 'app/qa-spatial')), 'delete frontend/src/app/qa-spatial before building');
});

check('every thumbnail is a real content-hashed frame', () => {
  const thumbs = read('lib/spatial/thumbs.ts');
  const entries = [...thumbs.matchAll(/'([a-z0-9-]+)': '(\/wallpaper\/spatial\/[a-z0-9-]+-[0-9a-f]{8}\.webp)'/g)];
  assert.equal(entries.length, TOTAL_PRESETS);
  for (const [, id, url] of entries) {
    assert.ok(SPATIAL_PRESETS.some((p) => p.id === id), id);
    assert.ok(fs.existsSync(path.join(here, '..', 'public', url)), url);
  }
});

console.log(`--- Không gian 3D: ${passed} contract groups passed ---`);
