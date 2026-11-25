// Echo Universe — Living Worlds contracts (owner brief 2026-10-30, 10 §BG). Static source rules + the pure preference and
// quietness rules. Runs with the rest of `npm test`; the browser journey lives in docs/echo-universe/2026-10-30/evidence/.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = fileURLToPath(new URL('../src/', import.meta.url));
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');
const ok = (name) => console.log(`ok - ${name}`);
const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');

// Minimal TS loader for the pure modules.
const cache = new Map();
function load(rel) {
  const path = join(ROOT, rel);
  if (cache.has(path)) return cache.get(path);
  const out = babel.core().transformSync(readFileSync(path, 'utf8'), {
    filename: path.split(/[\/]/).pop(), configFile: false, babelrc: false,
    presets: [babel.presetTypescript()], plugins: [babel.pluginTransformModulesCommonjs()],
  }).code;
  const module = { exports: {} };
  cache.set(path, module.exports);
  const dir = rel.split('/').slice(0, -1).join('/');
  const localRequire = (name) => {
    if (name === '@/lib/appearance/scope') return load('lib/appearance/scope.ts');
    if (name.startsWith('@/lib/wallpaper/')) return load(`lib/wallpaper/${name.slice('@/lib/wallpaper/'.length)}.ts`);
    if (name.startsWith('@/lib/navigation/')) return load(`lib/navigation/${name.slice('@/lib/navigation/'.length)}.ts`);
    if (name.startsWith('./')) return load(`${dir}/${name.slice(2)}.ts`);
    if (name === 'react') return { useEffect() {}, useState: (v) => [v, () => {}] };
    return require(name);
  };
  new Function('require', 'module', 'exports', out)(localRequire, module, module.exports);
  cache.set(path, module.exports);
  return module.exports;
}
globalThis.window = { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
const memoryStore = new Map();
globalThis.localStorage = { getItem: (k) => memoryStore.get(k) ?? null, setItem: (k, v) => memoryStore.set(k, v), removeItem: (k) => memoryStore.delete(k), clear: () => memoryStore.clear() };

const catalog = load('lib/wallpaper/worlds/catalog.ts');
const store = load('lib/wallpaper/storage.ts');
const orchestrate = load('lib/wallpaper/worlds/orchestrate.ts');
const loaders = read('lib', 'wallpaper', 'worlds', 'loaders.ts');

// ─── 1. Twenty real worlds ──────────────────────────────────────────────────────────────────────────────
const REQUIRED = ['echo-abyss', 'ascii-dreamscape', 'aurora-silk', 'luminous-garden', 'sakura-breeze', 'crystal-mirage', 'celestial-observatory', 'ink-and-paper', 'terminal-rain', 'cloud-sanctuary', 'echo-code-garden', 'cloud-drift', 'lagoon-letters', 'koi-pond', 'jellyfish-ballet', 'paper-boats', 'fireflies-at-dusk', 'moonlit-characters', 'liquid-lab', 'particle-constellation'];
assert.deepEqual(catalog.WORLDS.map((w) => w.id), REQUIRED, 'the catalogue holds exactly the owner\'s twenty worlds, in order');
for (const world of catalog.WORLDS) {
  assert.ok(loaders.includes(`'${world.id}':`), `${world.id} has its own lazy loader`);
  for (const field of ['title', 'moodVi', 'moodEn', 'touchVi', 'touchEn', 'studyVi', 'studyEn', 'accent', 'tint']) assert.ok(world[field], `${world.id}: ${field}`);
  assert.ok(!/&/.test(`${world.title} ${world.moodVi} ${world.moodEn} ${world.touchVi} ${world.touchEn} ${world.studyVi} ${world.studyEn}`), `${world.id}: no ampersand in copy`);
  assert.ok(catalog.worldThumb(world.id).startsWith('/wallpaper/worlds/'), `${world.id}: has a gallery picture`);
  assert.ok(catalog.worldPoster(world.id).startsWith('/wallpaper/worlds/'), `${world.id}: has a still`);
  for (const url of [catalog.worldThumb(world.id), catalog.worldPoster(world.id)]) {
    assert.ok(/-[0-9a-f]{8}\.webp$/.test(url), `${url}: content-hashed name`);
    assert.ok(existsSync(join(PUBLIC, url)), `${url}: the file exists`);
  }
}
assert.equal(catalog.WORLDS.filter((w) => w.tech === 'ASCII').length, 10, 'ASCII Dreamscape, Terminal Rain + eight dedicated environments');
assert.equal(catalog.WORLDS.filter((w) => w.tech === '3D').length, 4, 'four real 3D worlds');
ok('catalogue: twenty worlds, each with a loader, copy, and hashed pictures');

// Every scene file exists, is really different code, and has a real renderer.
const SCENE_FILES = loaders.match(/import\('\.\/[^']+'\)/g).map((m) => m.slice(10, -2));
assert.equal(SCENE_FILES.length, 20);
const bodies = new Map();
for (const file of SCENE_FILES) {
  const src = read('lib', 'wallpaper', 'worlds', `${file}.ts`);
  assert.ok(src.length > 3000, `${file}: a real scene, not a stub (${src.length} bytes)`);
  assert.ok(!/from '\.\.?\/koiPond'|from '\.\/koiPond'/.test(src), `${file}: not an alias of another scene`);
  bodies.set(file, src);
}
assert.equal(new Set(bodies.values()).size, 20, 'twenty different scene sources');
ok('scenes: twenty separate implementations');

// Interaction: every scene really reads the pointer.
for (const [file, src] of bodies) {
  assert.ok(/pointer|uMouse|uStrength/.test(src), `${file}: reads the pointer`);
}
ok('scenes: every world responds to the pointer');

// ─── 2. Client-only rendering ───────────────────────────────────────────────────────────────────────────
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const worldDir = join(ROOT, 'lib', 'wallpaper', 'worlds');
for (const file of walk(worldDir)) {
  const src = readFileSync(file, 'utf8');
  assert.ok(!/@\/services|apiClient|axios|XMLHttpRequest|WebSocket|openrouter|\bfetch\(|new Worker\(/.test(src), `${file}: the worlds never talk to a server`);
  assert.ok(!/Sparkles|✨/.test(src), `${file}: no sparkle`);
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(src), `${file}: scenes keep no storage`);
}
const backendTree = fileURLToPath(new URL('../../backend/src/main/java/com/englishcoach/wallpaper/', import.meta.url));
for (const file of walk(backendTree)) assert.ok(!/world|render|shader/i.test(readFileSync(file, 'utf8')), `${file}: no graphics or world work on the server`);
ok('client-only: no request, no worker, no server code for the worlds');

// ─── 3. One background source ───────────────────────────────────────────────────────────────────────────
const norm = store.normalizePreference;
assert.equal(norm({ source: 'world', worldId: 'koi-pond' }).source, 'world');
assert.equal(norm({ source: 'world', worldId: 'nope' }).source, 'none', 'unknown world → default');
assert.equal(norm({ source: 'world', worldId: 'koi-pond', presetId: 'nebula', youtubeId: 'dQw4w9WgXcQ', customUrl: 'https://x.example/a.mp4' }).presetId, undefined, 'a world carries no other source');
assert.equal(norm({ source: 'world', worldId: 'koi-pond', youtubeId: 'dQw4w9WgXcQ' }).youtubeId, undefined);
assert.equal(store.sourceKey(norm({ source: 'world', worldId: 'koi-pond' })), 'world:koi-pond');
assert.equal(norm({ source: 'preset', presetId: 'nebula', worldId: 'koi-pond' }).worldId, undefined, 'a wallpaper carries no running world');
assert.equal(norm({ source: 'none', worldMotion: 7 }).worldMotion, 1, 'tuning is clamped');
assert.equal(norm({ source: 'none', worldFocus: 'bad' }).worldFocus, undefined);
assert.equal(norm({ source: 'none', glass: 'bad' }).glass, undefined);
const key = store.accountKey(901);
store.writePreference(key, norm({ source: 'preset', presetId: 'nebula' }));
store.writePreference(key, norm({ ...store.currentPreference(key), source: 'world', worldId: 'aurora-silk' }));
let now = store.currentPreference(key);
assert.equal(now.source, 'world');
assert.equal(now.presetId, undefined, 'the video source is really off while a world runs');
assert.equal(now.lastMedia?.presetId, 'nebula', 'the wallpaper is remembered');
store.writePreference(key, norm({ ...now, ...now.lastMedia, worldId: undefined }));
now = store.currentPreference(key);
assert.equal(now.source, 'preset');
assert.equal(now.presetId, 'nebula');
assert.equal(now.lastWorldId, 'aurora-silk', 'the world is remembered');
assert.equal(store.currentPreference(store.accountKey(902)).source, 'none', 'another account does not see it');
ok('preference: exactly one source; neither choice is lost; per account');

const stage = read('components', 'wallpaper', 'WallpaperStage.tsx');
assert.ok(stage.includes("if (pref.source === 'world')") && stage.includes('<WorldCanvas'), 'the world is a layer of the one engine');
assert.equal((read('components', 'layout', 'ApplicationFrame.tsx').match(/<WallpaperStage \/>/g) || []).length, 1, 'one engine');
assert.ok(/active=\{playing && phase === 'shown'\}/.test(stage), 'only the world on top runs');
assert.ok(stage.includes("worldOnScreen ? String(quiet) : '0'"), 'the quiet veil applies to worlds only: a video keeps the learner\'s own veil');
assert.ok(!/worldParams[\s\S]{0,200}video/.test(stage.slice(stage.indexOf('function WorldCanvas'))), 'a world knows nothing of the video element');
const stageCss = read('components', 'wallpaper', 'WallpaperStage.module.css');
assert.ok(/\.stage \{[\s\S]*?pointer-events: none;/.test(stageCss) && !/backdrop-filter/.test(stageCss), 'never receives the pointer, no blur');
ok('orchestration: one engine, one source, the top layer runs, video untouched');

// ─── 4. Runtime rules ───────────────────────────────────────────────────────────────────────────────────
const runtime = read('lib', 'wallpaper', 'worlds', 'runtime.ts');
assert.ok(runtime.includes("{ passive: true, capture: true }"), 'pointer listeners are passive: they never block input');
assert.equal((runtime.match(/preventDefault\(\)/g) || []).length, 1, 'only the context-loss handler calls preventDefault');
assert.ok(!/setPointerCapture|\.focus\(/.test(runtime), 'no capture, no focus');
assert.ok(runtime.includes('pointer-events:none') && runtime.includes("setAttribute('aria-hidden', 'true')"), 'the canvas is decoration');
assert.ok(runtime.includes('WEBGL_lose_context') && runtime.includes('window.cancelAnimationFrame(raf)') && runtime.includes('observer.disconnect()') && runtime.includes('pointer.dispose()'), 'disposal releases GPU, loop, observers, listeners');
assert.ok(runtime.includes('webglcontextlost') && runtime.includes('webglcontextrestored'), 'context loss is handled');
assert.ok(runtime.includes('PIXEL_BUDGET') && runtime.includes('SCALE_STEPS') && runtime.includes('onOverload'), 'adaptive quality with a final static fallback');
assert.ok(/softwareRenderer\(gl\)\) tier = 'low'/.test(runtime) && /saveData/.test(runtime), 'software renderers and data saving get the lightest quality');
assert.ok(stage.includes("import('@/lib/wallpaper/worlds/runtime')") && !/from '@\/lib\/wallpaper\/worlds\/runtime'/.test(stage.replace(/import\('[^']+'\)\.[^;]+;/g, '')), 'the graphics code loads only when a world is on');
assert.ok(!/from 'three'/.test(read('components', 'wallpaper', 'WorldStudio.tsx') + stage + read('lib', 'wallpaper', 'storage.ts')), 'three.js stays in the 3D worlds\' own chunks');
ok('runtime: passive input, full release, adaptive quality, lazy graphics');

// ─── 5. Learning awareness ──────────────────────────────────────────────────────────────────────────────
const q = orchestrate.quietnessOf;
assert.equal(q('/', 'dashboard'), 0);
assert.equal(q('/', null), 0);
assert.ok(q('/', 'reading') >= 0.5 && q('/', 'listening') >= 0.5 && q('/', 'writing') >= 0.5);
assert.ok(q('/listening/42', null) >= 0.85, 'a lesson with its video: nearly still');
assert.ok(q('/exams', null) >= 0.5);
assert.ok(q('/games', null) < 0.2);
assert.ok(stage.includes("pref.worldFocus === 'off' ? 0") && stage.includes("pref.worldFocus === 'on'"), 'Focus Mode is the learner\'s choice');
ok('focus: quieter while learning, under the learner\'s control');

// ─── 6. Studio ──────────────────────────────────────────────────────────────────────────────────────────
const studio = read('components', 'wallpaper', 'WorldStudio.tsx');
assert.ok(studio.includes('role="dialog"') && studio.includes('aria-modal="true"') && studio.includes("event.key === 'Escape'") && studio.includes("event.key !== 'Tab'"), 'a real dialog');
assert.ok(/One renderer: the world in focus/.test(studio) && (studio.match(/startWorld\(/g) || []).length === 1, 'exactly one preview renderer');
for (const id of ['world-motion', 'world-pointer', 'world-clarity', 'world-interactive', 'world-still', 'world-focus', 'world-appearance', 'world-glass', 'world-apply', 'world-reset-tuning', 'world-back-wallpaper']) assert.ok(studio.includes(id), id);
assert.ok(!/localStorage\.setItem\('ec_wallpaper/.test(studio) && studio.includes('writePreference(storageKey, next)'), 'through the one preference store');
assert.ok(!/Sparkles|✨|@\/services|apiClient/.test(studio), 'no sparkle, no server call');
const studioCss = read('components', 'wallpaper', 'WorldStudio.module.css');
assert.ok(!/backdrop-filter|font-family|!important/.test(studioCss), 'no blur, no own typeface, no !important');
assert.ok(/prefers-reduced-motion/.test(studioCss) && /max-width: 1040px/.test(studioCss), 'reduced motion and narrow screens handled');
const media = read('components', 'wallpaper', 'WallpaperStudio.tsx');
assert.ok(media.includes("room === 'worlds'") && media.includes('<StudioBar room="media"'), 'Wallpapers and Living Worlds are two rooms of one dialog');
assert.ok(read('components', 'layout', 'Sidebar.tsx').includes('openWallpaperStudio()') && !/worlds/i.test(read('components', 'layout', 'Sidebar.tsx')), 'no new sidebar entry');
ok('studio: dialog, one renderer, every control, no new navigation');

// ─── 7. Nothing temporary ships ─────────────────────────────────────────────────────────────────────────
assert.ok(!existsSync(join(ROOT, 'app', 'qa-worlds')), 'the temporary QA page is gone');
ok('no temporary QA page in the tree');

console.log('test-echo-universe: all passed');
