// Echo Morph contract (10 §BN): the rules that keep one motion language from breaking a page. Browser proof: docs/morph/echo-morph-2026-10-31/evidence/morph-journey.cjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import './test-morph-physics.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const read = (p) => readFileSync(path.join(src, p), 'utf8');
let n = 0;
const check = (name, fn) => { fn(); n += 1; console.log(`  ok  ${name}`); };
const engine = read('lib/morph/engine.ts');
const rules = read('lib/morph/rules.ts');
const host = read('components/morph/MorphHost.tsx');
const providers = read('app/providers.tsx');
const tokens = read('lib/morph/tokens.ts');
const css = read('lib/morph/morph.css');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/ \/\/ .*$/gm, '');

check('the default page pays only the host: the engine is a chunk, loaded on a workspace screen', () => {
  assert.match(host, /import\('@\/lib\/morph\/engine'\)/);
  assert.match(host, /import type \{ MorphEngine \}/);
  assert.doesNotMatch(host, /^import \{[^}]*\} from '@\/lib\/morph\/engine'/m);
  assert.match(host, /morphLevel\(pathname, search\) === 'off'/);
  assert.match(providers, /<Suspense fallback=\{null\}><MorphHost \/><\/Suspense>/);
  assert.doesNotMatch(rules, /^import /m, 'the rule table imports nothing');
  assert.doesNotMatch(tokens, /^import /m, 'the tokens import nothing');
});
check('the router is never held and no document transition wraps it (10 §BH)', () => {
  assert.doesNotMatch(code(engine), /startViewTransition|router\.|preventDefault|stopPropagation|stopImmediatePropagation|history\.(push|replace)State|location\.(assign|replace|href\s*=)/);
  assert.match(engine, /addEventListener\('click', this\.onClick, \{ capture: true, passive: true \}\)/);
});
check('nothing left behind: no fill, every floating node is removed by the end of its own animation', () => {
  assert.doesNotMatch(code(engine), /fill:\s*'(both|forwards|backwards)'/);
  assert.match(engine, /el\.animate\(frames, \{ fill: 'none', id: MORPH_ID, \.\.\.options \}\)/);
  assert.match(tokens, /fill: 'none'/);
});
check('one owner per motion: page elements move by individual properties, only when they have none of their own', () => {
  assert.match(engine, /cs\.translate !== 'none' \|\| cs\.scale !== 'none' \|\| cs\.rotate !== 'none'/);
  assert.match(engine, /transformStyle === 'preserve-3d'/);
  assert.match(engine, /\[data-spatial-owner\]/);
  assert.match(engine, /a\.playState === 'running'/);
});
check('never reads what a learner wrote, never touches media or the microphone', () => {
  assert.doesNotMatch(code(engine), /\.value\b|getUserMedia|\.pause\(\)|\.play\(\)|\.focus\(\)|\.blur\(\)|\.click\(\)|scrollTo\b|scrollIntoView|fetch\(|localStorage|sessionStorage/);
  assert.match(engine, /const HEAVY = 'iframe,video,canvas,audio'/);
});
check('one live surface, never a copied dialog or a floating fallback fill', () => {
  assert.doesNotMatch(code(engine), /cloneNode|createElement|insertBefore/);
  assert.doesNotMatch(css, /ec-morph-layer|ec-morph-surface|--ec-morph-fill/);
  const presence = read('components/morph/useMorphPresence.ts');
  assert.match(presence, /inert: !open/);
  assert.match(presence, /open \|\| retained/);
  assert.match(presence, /motion\.current\?\.enter\(/);
});
check('reduced motion has its own path everywhere', () => {
  assert.match(read('lib/morph/surface.ts'), /morphReduced\(\)/);
  assert.match(read('components/morph/useMorphPresence.ts'), /reduce.addEventListener/);
  assert.match(tokens, /prefers-reduced-motion: reduce/);
});
check('Journey, Spatial and the Guide keep what they own', () => {
  assert.match(engine, /dataset\.journey/);
  assert.match(engine, /spatialProfile\(this\.pathname, this\.search\)\.transition === 'full'/);
  assert.match(engine, /dataset\.guideActive/);
  assert.match(read('components/guide/GuideTour.tsx'), /data-morph-busy/);
});
check('no new global stacking layer: Guide and Journey keep their own order', () => {
  assert.doesNotMatch(css, /z-index|position:\s*fixed/);
});
check('material rules: no blur, no own typeface, no sparkle', () => {
  assert.doesNotMatch(css, /backdrop-filter|font-family/);
  assert.doesNotMatch(engine, /Sparkles|✨/);
});

const pages = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'frontend/src/app/**/page.tsx', ':!docs/AGENTS_CODEX.md'], {cwd:path.join(here,'..','..'),encoding:'utf8'}).trim().split(/\r?\n/);
check('the rule table decides the screens that must stay still; everything else inherits the full language', () => {
  assert.ok(pages.length >= 40, String(pages.length));
  for (const want of ['attempts', 'echo-garden', 'login', 'practice', 'speaking', 'register', 'verify-email', 'landing-preview']) assert.ok(rules.includes(want), want);
  assert.match(rules, /attempts\\\/.*level: 'off'/);
  assert.match(rules, /echo-garden\|echo-quiz-rush.*level: 'still'/);
  assert.match(rules, /tab === 'landing'\) return 'off'/);
});
check('one lesson workspace: both route files are empty, one player, its address changes by native history', () => {
  assert.match(read('app/listening/[id]/page.tsx'), /return null/);
  assert.match(read('app/listening/[id]/practice/page.tsx'), /return null/);
  const w = read('components/features/listening/workspace/LessonWorkspace.tsx');
  assert.equal((w.match(/<AdvancedAudioPlayer\s/g) || []).length, 1);
  assert.match(w, /window\.history\.pushState\(null, '', lessonUrl/);
  assert.match(read('app/listening/[id]/layout.tsx'), /<LessonWorkspace \/>/);
});
check('Spatial never draws rows clipped by a small scroller (the ghost boxes)', () => {
  const sf = read('lib/spatial/engine/surfaces.ts');
  assert.match(sf, /onScreen && !s\.clipped && n < RECT_CAPACITY/);
  assert.match(sf, /clipped \|\| scrollsRows/);
});
check('Dictation keeps the larger video share', () => {
  assert.match(read('components/features/listening/glass/listeningGlass.module.css'), /\.dictGrid \{ grid-template-columns: minmax\(0, 1\.38fr\) minmax\(24rem, 1fr\); \}/);
});
console.log(`--- Echo Morph: ${n} contract groups passed ---`);
