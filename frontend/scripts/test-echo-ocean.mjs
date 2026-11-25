// Echo Ocean (owner brief 2026-11-14): contracts of the default workspace atmosphere, the Echo Visual Contract and the Dashboard's
// rendered swim loop. Static checks only (no browser); the browser journey lives in docs/echo-ocean/2026-11-14/evidence/journey.cjs.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
// Sources may carry CRLF line ends (Windows checkout): compare on LF.
const src = (p) => fs.readFileSync(path.join(root, 'src', p), 'utf8').split(String.fromCharCode(13)).join('');
const pub = (p) => path.join(root, 'public', p.replace(/^\//, ''));
let passed = 0;
const uncomment = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
/** Every `@keyframes` block of a stylesheet, by brace matching. */
const keyframes = (css) => {
  const out = [];
  for (let at = css.indexOf('@keyframes'); at !== -1; at = css.indexOf('@keyframes', at + 1)) {
    let depth = 0;
    let i = css.indexOf('{', at);
    const begin = i;
    for (; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}' && (depth -= 1) === 0) break;
    }
    out.push(css.slice(begin, i + 1));
  }
  return out;
};
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
};

const frame = src('components/layout/ApplicationFrame.tsx');
const atmos = src('components/atmosphere/EchoAtmosphere.tsx');
const atmosCss = src('components/atmosphere/EchoAtmosphere.module.css');
const art = src('components/atmosphere/atmosphereArt.ts');
const contract = src('app/echo-ocean.css');
const layout = src('app/layout.tsx');
const globals = src('app/globals.css');
const hero = src('components/dashboard/DashboardHeroScene.tsx');
const swimArt = src('components/dashboard/echoSwimArt.ts');
const stage = src('components/wallpaper/WallpaperStage.tsx');
const shell = src('components/layout/WorkspaceShell.module.css');

test('the atmosphere is the workspace frame\'s own look, under the one background engine, never in Study Space', () => {
  // Since 2026-11-15 the workspace frame also hosts the immersive worlds: in that mode none of its chrome is rendered.
  const workspace = frame.slice(frame.lastIndexOf('return (\n    <div className={immersive'));
  assert.match(workspace, /flex h-screen overflow-clip[\s\S]*data-atmosphere-frame=\{immersive \? undefined : ''\}[\s\S]*\{!immersive && <EchoAtmosphere \/>\}\s*\{!immersive && background\}/, 'mounted before the wallpaper stage, never in an immersive world');
  const study = frame.slice(frame.indexOf('if (isStudySpace)'), frame.indexOf('const isOdyssey'));
  assert.doesNotMatch(study, /EchoAtmosphere|data-atmosphere-frame/);
  assert.equal((frame.match(/<EchoAtmosphere \/>/g) || []).length, 1);
});

test('the atmosphere follows the one appearance and makes no request, no loop, no 3D context', () => {
  assert.match(atmos, /currentAppearance\(account\)\.mode/);
  assert.match(atmos, /const shown = mode === 'default' && !resting;/);
  assert.match(atmos, /aria-hidden="true"/);
  assert.doesNotMatch(atmos, /fetch\(|apiClient|axios|useSWR|requestAnimationFrame|getContext|WebGL|from 'three'/);
  assert.match(atmos, /!reduced && effects !== 'low' && !saveData\(\)/, 'light layers off under reduced motion, "Nhẹ", Save-Data');
  assert.match(atmos, /const still = !live \|\| quiet >= 0\.5;/, 'library / lesson screens and typing fade the light out');
  assert.match(atmosCss, /\.light\[data-still\] \{ opacity: 0; \}/, 'faded out = not drawn');
});

test('atmosphere styles: z 0, pointer-free, contained, compositor-only motion, reduced motion and forced colours', () => {
  assert.match(atmosCss, /\.atmosphere \{[^}]*z-index: 0;[^}]*pointer-events: none;[^}]*contain: strict;/);
  for (const block of keyframes(atmosCss)) {
    assert.doesNotMatch(block, /background-position|left:|top:|width:|height:|filter:/, 'keyframes animate transform / opacity only');
  }
  assert.match(atmosCss, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*animation: none;/);
  assert.match(atmosCss, /@media \(forced-colors: active\)/);
  assert.match(atmosCss, /:global\(\.dark\) \.plate/, 'explicit .dark class (10 §Y)');
  assert.doesNotMatch(uncomment(atmosCss + contract), /!important|backdrop-filter|font-family/);
});

test('published art: every file exists under its own content hash (immutable caching)', () => {
  const files = [...art.matchAll(/'(\/assets\/atmosphere\/[^']+)'/g)].map((m) => m[1]);
  assert.ok(files.length >= 9);
  for (const f of files) {
    const bytes = fs.readFileSync(pub(f));
    const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8);
    assert.ok(f.endsWith(`-${hash}.webp`), `${f} named by its hash`);
  }
  const webm = swimArt.match(/webm: '([^']+)'/)[1];
  const hash = crypto.createHash('sha256').update(fs.readFileSync(pub(webm))).digest('hex').slice(0, 8);
  assert.ok(webm.endsWith(`-${hash}.webm`));
  assert.ok(fs.statSync(pub(webm)).size < 120_000, 'the swim loop stays small');
});

test('page shells and module skies let the atmosphere through from the first paint; themed rooms keep theirs', () => {
  assert.match(globals, /\[data-atmosphere-frame\] main\[data-app-scroll\] \.bg-surface:is\(\.min-h-full, \.h-full, \.min-h-screen, \.min-h-64\) \{\s*background-color: transparent;/);
  const yielding = {
    'components/community/communityGlass.module.css': ':global([data-atmosphere-frame]) .page { background: transparent; }',
    'components/features/flashcard/memoryUniverse.module.css': ':global([data-atmosphere-frame]) .page { background: transparent; }',
    'components/features/exams/universe/examUniverse.module.css': ':global([data-atmosphere-frame]) .page { background: transparent; }',
    'components/features/speaking/studio/speakingStudio.module.css': ':global([data-atmosphere-frame]) .page { background: transparent; }',
    'components/features/listening/glass/listeningGlass.module.css': ':global([data-atmosphere-frame]) .page:not([data-world="personal"]) { background: transparent; }',
    'components/features/reading/glass/readingGlass.module.css': ':global([data-atmosphere-frame]) .page[data-world="library"] { background: transparent; }',
    'components/features/writing/glass/writingGlass.module.css': ':global([data-atmosphere-frame]) .studio { background: transparent; }',
  };
  for (const [file, rule] of Object.entries(yielding)) assert.ok(src(file).includes(rule), file);
  for (const keep of ['components/features/leaderboard/hall/hall.module.css', 'components/music/Music.module.css', 'components/features/games/GamesHub.module.css']) {
    assert.doesNotMatch(src(keep), /data-atmosphere/, `${keep} keeps its own room`);
  }
});

test('lighting contract: one ambient colour, decided in CSS by the active background, never per frame', () => {
  assert.match(layout, /import '\.\/globals\.css'\nimport '\.\/echo-ocean\.css'/);
  assert.match(contract, /:root \{[\s\S]*--eo-ambient: 112 150 240;/);
  assert.match(contract, /\.dark \{[\s\S]*--eo-ambient: 56 189 248;/);
  assert.match(contract, /html\[data-wp-accent\] \{ --eo-ambient: var\(--wp-accent\); \}/);
  assert.match(contract, /html\[data-glass-tint\] \{ --eo-ambient: var\(--glass-tint\); \}/);
  assert.match(contract, /html\[data-spatial\] \{ --eo-ambient: var\(--sp-tint\); \}/);
  for (const variant of ['pearl-learning', 'pearl-elevated', 'pearl-interactive', 'abyss-panel', 'abyss-hud', 'media-surface', 'exam-focus', 'utility-neutral', 'immersive-overlay']) {
    assert.ok(contract.includes(`data-eo='${variant}'`), variant);
  }
  assert.match(stage, /root\.setAttribute\('data-wp-accent', ''\)/);
  assert.match(stage, /root\.removeAttribute\('data-wp-accent'\)/);
  assert.match(shell, /:global\(html\[data-atmosphere\]\) \.panel:not\(\.drawerOpen\)/, 'the phone drawer keeps its own shadow');
});

test('Dashboard Echo: the real rig\'s loop only after visible + idle, muted, proven by its clock, still elsewhere', () => {
  assert.match(hero, /new IntersectionObserver/);
  assert.match(hero, /requestIdleCallback/);
  assert.match(hero, /video\.muted = true;/);
  assert.match(hero, /if \(last >= 0 && video\.currentTime !== last\) \{\s*echo\.setAttribute\("data-live", ""\);\s*video\.removeEventListener\("timeupdate", onTime\);/);
  assert.match(hero, /AppleWebKit/, 'WebKit keeps the still (VP9 alpha would draw black)');
  assert.match(hero, /vfxPreference\(\) === "low"/);
  assert.doesNotMatch(hero, /poster=/, 'nothing is fetched for a browser that will not play it');
});

console.log(`Echo Ocean: ${passed} contract groups passed`);
