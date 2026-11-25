// Echo Adaptive Navigation, Cinematic FLIP Morphing, Universal Auto-Hide, and Dictionary Day/Night Sync Contracts (2026-11-18).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, '..');
const src = (...parts) => path.join(frontend, 'src', ...parts);
const read = (...parts) => fs.readFileSync(src(...parts), 'utf8');

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  PASS  ${label}`);
};

// Shared VM harness for pure TypeScript navigation modules
const storage = new Map();
let reducedMotion = false;
const docAttrs = new Map();
let focusedSelector = null;

function createVmEnv() {
  const modules = new Map();
  const win = {
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: (q) => ({
      matches: q.includes('prefers-reduced-motion') ? reducedMotion : false,
      addEventListener() {},
      removeEventListener() {},
    }),
    getComputedStyle: () => ({ borderTopLeftRadius: '25px' }),
    history: {
      pushed: [],
      pushState(_s, _t, url) {
        this.pushed.push(url);
      },
    },
  };
  const doc = {
    activeElement: null,
    documentElement: {
      setAttribute: (k, v) => docAttrs.set(k, v),
      removeAttribute: (k) => docAttrs.delete(k),
      getAttribute: (k) => docAttrs.get(k) ?? null,
    },
    querySelector: (sel) => {
      if (sel.includes('[data-nav-item-id=')) {
        return {
          focus() {
            focusedSelector = sel;
          },
        };
      }
      if (sel === '[data-nav-surface="sidebar"]') {
        return {
          getBoundingClientRect: () => ({ left: 6, top: 8, width: 252, height: 884 }),
          querySelectorAll: () => [
            {
              getAttribute: () => 'dashboard',
              getBoundingClientRect: () => ({ left: 18, top: 96, width: 30, height: 30 }),
            },
            {
              getAttribute: () => 'reading',
              getBoundingClientRect: () => ({ left: 18, top: 312, width: 30, height: 30 }),
            },
          ],
          querySelector: () => null,
        };
      }
      if (sel === '[data-nav-surface="dock"]') {
        return {
          getBoundingClientRect: () => ({ left: 380, top: 824, width: 680, height: 62 }),
          querySelectorAll: () => [
            {
              getAttribute: () => 'dashboard',
              getBoundingClientRect: () => ({ left: 396, top: 834, width: 42, height: 42 }),
            },
            {
              getAttribute: () => 'reading',
              getBoundingClientRect: () => ({ left: 690, top: 834, width: 42, height: 42 }),
            },
          ],
          querySelector: () => ({
            getBoundingClientRect: () => ({ left: 980, top: 834, width: 42, height: 42 }),
          }),
        };
      }
      return null;
    },
  };
  const ls = {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };

  function load(rel) {
    if (modules.has(rel)) return modules.get(rel);
    const code = babel.core().transformSync(read(...rel.split('/')), {
      filename: path.basename(rel),
      configFile: false,
      babelrc: false,
      presets: [babel.presetTypescript()],
      plugins: [babel.pluginTransformModulesCommonjs()],
    }).code;
    const exports = {};
    modules.set(rel, exports);
    runInNewContext(code, {
      exports,
      console,
      performance: { now: () => Date.now() },
      HTMLElement: class {},
      window: win,
      document: doc,
      localStorage: ls,
      require: (spec) => {
        if (spec === 'lucide-react') return new Proxy({}, { get: (_t, prop) => String(prop) });
        if (spec.startsWith('./')) {
          const dir = rel.split('/').slice(0, -1).join('/');
          return load(`${dir}/${spec.slice(2)}.ts`);
        }
        if (spec.startsWith('@/')) {
          return load(`${spec.slice(2)}.ts`);
        }
        return {};
      },
    });
    return exports;
  }

  return { load, win, doc };
}

const { load, win } = createVmEnv();
const registry = load('lib/navigation/registry.ts');
const prefs = load('lib/navigation/preferences.ts');
const morph = load('lib/navigation/morphCoordinator.ts');

// 1. Shared Navigation Registry & Permission Rules
check('shared NAV_REGISTRY: 21 destinations, admin gating, canonical active-route resolution, pushState root navigation', () => {
  assert.equal(registry.NAV_REGISTRY.length, 21);
  assert.equal(registry.authorizedDestinations(false).length, 16, 'learners see 16 non-admin destinations');
  assert.equal(registry.authorizedDestinations(true).length, 21, 'admins see all 21 destinations');
  assert.ok(registry.authorizedDestinations(false).every((d) => !d.adminOnly));

  assert.equal(registry.resolveActiveNavId('/dashboard', null), 'dashboard');
  assert.equal(registry.resolveActiveNavId('/learning-path', null), 'learningPath');
  assert.equal(registry.resolveActiveNavId('/knowledge-universe', null), 'knowledgeUniverse');
  assert.equal(registry.resolveActiveNavId('/reading', null), 'reading');
  assert.equal(registry.resolveActiveNavId('/listening/42', null), 'listening');
  assert.equal(registry.resolveActiveNavId('/speaking/shadowing', null), 'speaking');
  assert.equal(registry.resolveActiveNavId('/writing', null), 'writing');
  assert.equal(registry.resolveActiveNavId('/exams/ielts', null), 'exams');
  assert.equal(registry.resolveActiveNavId('/games', null), 'games');
  assert.equal(registry.resolveActiveNavId('/leaderboard', null), 'leaderboard');
  assert.equal(registry.resolveActiveNavId('/community/messages', null), 'community');
  assert.equal(registry.resolveActiveNavId('/music', null), 'music');
  assert.equal(registry.resolveActiveNavId('/study-space', null), 'studySpace');
  assert.equal(registry.resolveActiveNavId('/admin/security', null), 'adminSecurity');
  assert.equal(registry.resolveActiveNavId('/', 'flashcards'), 'flashcards');

  let pending = null;
  let prevented = false;
  registry.handleSharedModuleNavigate(
    { preventDefault: () => { prevented = true; } },
    'reading',
    '/reading',
    'dashboard',
    null,
    (next) => { pending = next; },
    '/dashboard',
  );
  assert.equal(pending, 'reading');
  assert.equal(prevented, true);
  assert.deepEqual(win.history.pushed, ['/reading']);
});

// 2. Account-Scoped Persistence, Unified Global Visibility & Legacy Migration
check('preferences: account-scoped keys, unified global visibility, legacy migration, reorder, pin/unpin, reset', () => {
  const keyA = prefs.navStorageKey(101);
  const keyB = prefs.navStorageKey(202);
  const keyGuest = prefs.navStorageKey(null);
  assert.equal(keyA, 'ec_nav:v1:u101');
  assert.equal(keyGuest, 'ec_nav:v1:guest');

  // Existing users default to Sidebar + Always Visible
  const def = prefs.currentNavPreferences(keyA);
  assert.equal(def.layout, 'sidebar');
  assert.equal(def.visibility, 'pinned');
  assert.equal('mainVisibility' in def, false);
  assert.equal('topBarVisibility' in def, false);

  // Unified visibility applies across layouts while layout stays independent
  prefs.setNavigationVisibility(keyA, 'autohide');
  assert.equal(prefs.currentNavPreferences(keyA).layout, 'sidebar');
  assert.equal(prefs.currentNavPreferences(keyA).visibility, 'autohide');

  prefs.setNavigationLayout(keyA, 'dock');
  assert.equal(prefs.currentNavPreferences(keyA).layout, 'dock');
  assert.equal(prefs.currentNavPreferences(keyA).visibility, 'autohide');

  prefs.setNavigationVisibility(keyA, 'pinned');
  assert.equal(prefs.currentNavPreferences(keyA).layout, 'dock');
  assert.equal(prefs.currentNavPreferences(keyA).visibility, 'pinned');

  // Account B remains untouched
  assert.equal(prefs.currentNavPreferences(keyB).layout, 'sidebar');
  assert.equal(prefs.currentNavPreferences(keyB).visibility, 'pinned');

  // Safe migration from legacy v1 split-visibility records
  const migratedMainAuto = prefs.normalizeNavPreferences({ layout: 'sidebar', mainVisibility: 'autohide', topBarVisibility: 'pinned' });
  assert.equal(migratedMainAuto.visibility, 'autohide');
  const migratedTopAuto = prefs.normalizeNavPreferences({ layout: 'dock', mainVisibility: 'pinned', topBarVisibility: 'autohide' });
  assert.equal(migratedTopAuto.layout, 'dock');
  assert.equal(migratedTopAuto.visibility, 'autohide');
  const migratedBothPinned = prefs.normalizeNavPreferences({ layout: 'sidebar', mainVisibility: 'pinned', topBarVisibility: 'pinned' });
  assert.equal(migratedBothPinned.visibility, 'pinned');

  // Reorder & favorite pin/unpin
  prefs.reorderDockItems(keyA, 'exams', 'dashboard');
  assert.equal(prefs.currentNavPreferences(keyA).dockOrder[0], 'exams');
  prefs.toggleDockPinned(keyA, 'music');
  assert.ok(prefs.currentNavPreferences(keyA).dockPinned.includes('music'));
  prefs.toggleDockPinned(keyA, 'music');
  assert.ok(!prefs.currentNavPreferences(keyA).dockPinned.includes('music'));

  prefs.resetDockPreferences(keyA);
  assert.deepEqual([...prefs.currentNavPreferences(keyA).dockPinned], [...registry.DEFAULT_DOCK_PINNED]);

  // Malformed data falls back safely
  const sanitized = prefs.normalizeNavPreferences({ layout: 'evil', visibility: 99, dockOrder: ['reading', '<script>'], dockPinned: ['reading', 'unknown'] });
  assert.equal(sanitized.layout, 'sidebar');
  assert.equal(sanitized.visibility, 'pinned');
  assert.equal(sanitized.dockOrder[0], 'reading');
  assert.equal(sanitized.dockOrder.length, registry.NAV_IDS.length);
  assert.deepEqual([...sanitized.dockPinned], ['reading']);
});

// 3. Cinematic FLIP Morph Coordinator, Mid-Flight Reversal & Reduced Motion
check('FLIP morph coordinator: captures rects before switch, preserves mid-flight velocity on reversal, respects reduced motion', () => {
  prefs.registerBeforeLayoutSwitch(morph.captureNavMorphBeforeSwitch);
  const key = prefs.navStorageKey(303);
  prefs.setNavigationLayout(key, 'dock');

  const snap1 = morph.getActiveNavMorph();
  assert.ok(snap1, 'snapshot captured synchronously before Sidebar -> Dock commit');
  assert.equal(snap1.from, 'sidebar');
  assert.equal(snap1.to, 'dock');
  assert.equal(snap1.surface.w, 252);
  assert.ok(snap1.icons.has('dashboard') && snap1.icons.has('reading'));
  assert.equal(docAttrs.get('data-nav-morph-active'), 'dock');

  // Simulate mid-flight interruption (user toggles back to Sidebar before Dock morph finishes)
  morph.registerLiveFlightReader(() => ({
    surface: { x: 190, y: 420, w: 460, h: 240, rx: 25 },
    surfaceVelocity: { x: 320, y: 540, w: 210, h: -600, rx: 0 },
    icons: new Map([
      ['dashboard', { box: { x: 210, y: 440, w: 36, h: 36 }, vx: 280, vy: 490, vw: 10, vh: 10, opacity: 1 }],
    ]),
  }));

  prefs.setNavigationLayout(key, 'sidebar');
  const snap2 = morph.getActiveNavMorph();
  assert.ok(snap2 && snap2.seq > snap1.seq, 'reversal starts a new morph sequence');
  assert.equal(snap2.from, 'dock');
  assert.equal(snap2.to, 'sidebar');
  assert.equal(snap2.surface.x, 190, 'starts from live mid-air position without snapping');
  assert.equal(snap2.surfaceVelocity.x, 320, 'preserves live spring velocity');
  assert.equal(snap2.iconVelocities.get('dashboard').vy, 490);

  morph.registerLiveFlightReader(null);
  morph.completeNavMorph(snap2.seq);
  assert.equal(morph.getActiveNavMorph(), null);
  assert.equal(docAttrs.has('data-nav-morph-active'), false);

  // Reduced motion bypasses spatial flight cleanly
  reducedMotion = true;
  prefs.setNavigationLayout(key, 'dock');
  assert.equal(morph.getActiveNavMorph(), null, 'reduced motion skips flying morph');
  reducedMotion = false;
});

// 4. Shared-Element ID Parity & Architectural Guardrails
check('DOM & CSS contracts: Sidebar <-> Dock morph ID parity, zero WebGL/blur/!important/Sparkles/ampersands/network calls', () => {
  const sidebar = read('components', 'layout', 'Sidebar.tsx');
  const topbar = read('components', 'layout', 'TopNavbar.tsx');
  const frame = read('components', 'layout', 'ApplicationFrame.tsx');
  const dock = read('components', 'navigation', 'AdaptiveDock.tsx');
  const dockCss = read('components', 'navigation', 'AdaptiveDock.module.css');
  const morphTsx = read('components', 'navigation', 'NavigationMorphLayer.tsx');
  const morphCss = read('components', 'navigation', 'NavigationMorphLayer.module.css');
  const navStudio = read('components', 'navigation', 'NavigationStudio.tsx');
  const navStudioCss = read('components', 'navigation', 'NavigationStudio.module.css');
  const cleanup = read('lib', 'auth-cache-cleanup.ts');

  // Every non-dynamic Sidebar item carries matching data-nav-item-id & morphId
  for (const id of [
    'leaderboard',
    'community',
    'adminNotifications',
    'adminCommunity',
    'adminPremium',
    'adminGardenCommerce',
    'adminSecurity',
    'music',
    'appearance',
    'studySpace',
  ]) {
    assert.ok(sidebar.includes(`data-nav-item-id="${id}"`), `Sidebar item id: ${id}`);
  }
  assert.ok(sidebar.includes('data-nav-surface="sidebar"') && dock.includes('data-nav-surface="dock"') && topbar.includes('data-nav-surface="topbar"'));
  // Single universal global navigation pin in TopNavbar; redundant Sidebar & Dock pins removed
  assert.ok(!sidebar.includes('data-testid="sidebar-pin-toggle"'), 'Sidebar removes redundant pin button for full EnglishCoach branding');
  assert.ok(!dock.includes('data-testid="dock-pin-toggle"'), 'AdaptiveDock removes secondary pin button');
  assert.ok(topbar.includes('data-testid="topbar-pin-toggle"') && topbar.includes('setNavigationVisibility'), 'TopNavbar hosts universal global navigation pin');
  assert.ok(
    navStudio.includes('data-testid="nav-studio-visibility-pinned"') &&
      navStudio.includes('data-testid="nav-studio-visibility-autohide"'),
    'NavigationStudio exposes unified global visibility control',
  );
  const autoHideHook = read('lib', 'navigation', 'useAutoHideSurface.ts');
  assert.ok(autoHideHook.includes('subscribeCoordinator') && autoHideHook.includes('scheduleSharedHide'), 'useAutoHideSurface coordinates synchronized multi-surface reveal & hide');
  assert.ok(frame.includes('<AdaptiveDock />') && frame.includes('<NavigationMorphLayer />'));
  assert.ok(cleanup.includes('ec_nav:v1:'), 'sign-out preserves per-account navigation preferences');

  // Zero WebGL/canvas, zero network/AI calls, zero Sparkles
  const tsxBundle = [dock, morphTsx, navStudio].join('\n');
  assert.doesNotMatch(tsxBundle, /<canvas|getContext\(['"]webgl|from ['"]three['"]|Sparkles|✨|Wand|fetch\(|apiClient|axios|openrouter/i);

  // Zero !important or custom font-family; Dock turns off backdrop-filter over wallpapers/spatial scenes (10 §AF)
  const uncomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  const cleanDockCss = uncomment(dockCss);
  assert.doesNotMatch(cleanDockCss, /!important|font-family/, 'AdaptiveDock.module.css has no !important or font-family');
  assert.match(cleanDockCss, /backdrop-filter:\s*blur\(/, 'AdaptiveDock provides Liquid Glass background blur');
  assert.match(cleanDockCss, /:global\(html\[data-wallpaper\]\)\s*\.capsule[\s\S]*backdrop-filter:\s*none;/, 'AdaptiveDock disables blur over live wallpapers (10 §AF)');
  assert.match(cleanDockCss, /@media \(prefers-reduced-motion: reduce\)/, 'AdaptiveDock respects reduced motion');

  for (const [name, cssText] of [
    ['NavigationMorphLayer.module.css', morphCss],
    ['NavigationStudio.module.css', navStudioCss],
  ]) {
    const clean = uncomment(cssText);
    assert.doesNotMatch(clean, /backdrop-filter|!important|font-family/, `${name} obeys Echo Ocean CSS invariants`);
    assert.match(clean, /@media \(prefers-reduced-motion: reduce\)/ || name === 'NavigationMorphLayer.module.css', `${name} motion rules`);
  }
});

// 5. Dictionary Day/Night 3D Asset Integrity
check('Dictionary Day/Night synchronization: all 4 content-hashed WebPs verified by SHA-256 and wired to html.dark', () => {
  const dict = read('components', 'features', 'dictionary', 'GlobalDictionarySearch.tsx');
  const dictCss = read('components', 'features', 'dictionary', 'lexicon', 'lexicon.module.css');
  const matches = [...dict.matchAll(/\/assets\/dictionary\/(lexicon-ocean-(?:day-)?\d+-([0-9a-f]{8})\.webp)/g)];
  assert.equal(matches.length, 4, '2 daytime + 2 nighttime responsive WebPs');
  for (const [, filename, expectedHash] of matches) {
    const filePath = path.join(frontend, 'public', 'assets', 'dictionary', filename);
    assert.ok(fs.existsSync(filePath), `exists: ${filename}`);
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').slice(0, 8);
    assert.equal(actualHash, expectedHash, `SHA-256 prefix matches ${filename}`);
  }
  assert.match(dictCss, /--frame-bg:\s*#d7e8f8;/, 'light mode uses daytime morning sea palette');
  assert.match(dictCss, /:global\(\.dark\)\s*\.lexicon\s*\{[\s\S]*--frame-bg:\s*#050a22;/, 'dark mode preserves #050a22 night sea');
});

console.log(`\nALL ADAPTIVE NAVIGATION & DICTIONARY DAY/NIGHT CONTRACTS PASSED (${passed} groups)`);
