// Contract for Echo Guide (owner brief 2026-10-31, 10 §BL).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { holeOf, liquidPath, overlapArea, placeCard, placeEcho } from '../src/lib/guide/placement.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', 'src');
const pub = path.resolve(here, '..', 'public');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const ok = (name) => console.log(`  -> PASS: ${name}`);

const host = read('components/guide/GuideHost.tsx');
const store = read('lib/guide/store.ts');
const runtime = read('components/guide/GuideRuntime.tsx');
const tour = read('components/guide/GuideTour.tsx');
const panel = read('components/guide/GuidePanel.tsx');
const offer = read('components/guide/GuideOffer.tsx');
const stage = read('components/guide/guideStage.ts');
const css = read('components/guide/guide.module.css');
const quiet = read('lib/guide/quiet.ts');
const registry = read('lib/guide/registry.ts');
const guideFiles = ['lib/guide/guides/core.ts', 'lib/guide/guides/grammar.ts', 'lib/guide/guides/skills.ts', 'lib/guide/guides/games.ts'];
const content = guideFiles.map(read).join('\n');

// 1. The default page pays almost nothing; the engine and content are their own chunk.
assert.ok(/dynamic\(\(\) => import\('\.\/GuideRuntime'\)/.test(host) && !/guides\/|registry/.test(host), 'only the host is in the main bundle');
assert.ok(!/guides\/|registry|from 'react'/.test(store), 'the store holds no content and no React');
assert.ok(read('app/providers.tsx').includes('<GuideHost />'), 'mounted under the account key');
ok('default bundle: a host and a store');

// 2. Client only: no request, no AI, no canvas, no graphics engine.
for (const [name, src] of [['host', host], ['store', store], ['runtime', runtime], ['tour', tour], ['panel', panel], ['stage', stage], ['quiet', quiet]]) {
  assert.ok(!/\bfetch\(|axios|apiClient|\/api\/|openrouter|WebSocket/i.test(src), `${name} makes no request of its own`);
  assert.ok(!/from 'three'|getContext\(/.test(src), `${name} has no graphics engine`);
}
ok('client only: no server work, no AI, no second renderer');

// 3. Every guide is well formed, short, in both languages, about real things.
const steps = [...content.matchAll(/id: '([a-z-]+)',\s*\n\s*target: (null|'[^\n]*'),\n\s*title: t\('([^\n]*?)', '([^\n]*?)'\),\n\s*body: t\('([^\n]*?)', '([^\n]*?)'\),/g)].map((m) => ({ id: m[1], target: m[2], titleVi: m[3], titleEn: m[4], bodyVi: m[5], bodyEn: m[6] }));
assert.ok(steps.length >= 100, `every step parsed (${steps.length})`);
const guideIds = [...content.matchAll(/^\s{4}id: '([a-z-]+)',\n\s{4}module:/gm)].map((m) => m[1]);
assert.equal(new Set(guideIds).size, guideIds.length, 'no two guides share an id');
assert.ok(guideIds.length >= 30, `guides (${guideIds.length})`);
for (const s of steps) {
  const words = s.bodyVi.split(/\s+/).length;
  assert.ok(words <= 24, `${s.id}: "${s.bodyVi}" is ${words} words`);
  assert.ok(s.titleVi.split(/\s+/).length <= 8, `${s.id}: title too long`);
  assert.ok(!/[&✨]/.test(s.titleVi + s.bodyVi + s.titleEn + s.bodyEn), `${s.id}: no ampersand, no sparkle`);
  assert.ok(!/AI-powered|thông minh vượt trội|tiên tiến|đột phá/i.test(s.bodyVi + s.bodyEn), `${s.id}: no promotion`);
  assert.ok(s.bodyEn.length > 0 && s.titleEn.length > 0, `${s.id}: English too`);
}
ok(`${guideIds.length} guides, ${steps.length} steps: short, bilingual, no promotion`);

// 4. Every target exists in the product. Nothing points at a place that is not there.
const sources = [];
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else if (/\.(tsx|ts)$/.test(name) && !full.includes(`${path.sep}lib${path.sep}guide${path.sep}`)) sources.push(fs.readFileSync(full, 'utf8'));
  }
};
walk(root);
const all = sources.join('\n');
const guideAttrs = new Set([...content.matchAll(/\[data-guide="([a-zA-Z-]+)"\]/g)].map((m) => m[1]));
for (const name of guideAttrs) {
  if (name.startsWith('nav-')) continue;
  if (name.startsWith('grammar-nav-')) { assert.ok(all.includes('data-guide={`grammar-nav-${'), `${name} comes from the section bar`); continue; }
  assert.ok(all.includes(`data-guide="${name}"`), `data-guide="${name}" is on a real element`);
}
assert.ok(all.includes('data-guide={`nav-${tab}`}'), 'sidebar entries are targets');
const testIds = new Set([...content.matchAll(/\[data-testid="([a-z-]+)"\]/g)].map((m) => m[1]));
for (const id of testIds) {
  const family = id.replace(/-(media|worlds|spatial|shadowing|roleplay|assessment|topic|translation|sentence-lab|typing|coach|portfolio)$/, '');
  assert.ok(all.includes(`data-testid="${id}"`) || all.includes(`data-testid={\`${family}-\${`), `data-testid="${id}" exists`);
}
for (const [selector, needle] of [
  ['section[aria-labelledby="lp-today"]', 'aria-labelledby="lp-today"'],
  ['section[aria-labelledby="full-sim-title"]', 'aria-labelledby="full-sim-title"'],
  ['section[aria-labelledby="king-mode-heading"]', 'aria-labelledby="king-mode-heading"'],
  ['#listening-import-url', 'id="listening-import-url"'],
  ['#sentence-input', 'id="sentence-input"'],
  ['#practice', 'id="practice"'],
  ['.echo-launcher', 'className="echo-launcher"'],
  ['[aria-label="Số lần lặp lại câu mẫu"]', 'aria-label="Số lần lặp lại câu mẫu"'],
  ['[aria-label="Bắt đầu thu âm câu trả lời"]', 'aria-label="Bắt đầu thu âm câu trả lời"'],
]) {
  assert.ok(content.includes(selector.replace(/'/g, "\\'")), `the guides use ${selector}`);
  assert.ok(all.includes(needle), `${selector} exists`);
}
for (const pinned of ['components/features/reading/books/BookReader.tsx', 'components/features/listening/AdvancedAudioPlayer.tsx', 'components/features/exams/ExamRuntimeShell.tsx']) {
  assert.ok(!read(pinned).includes('data-guide'), `${pinned} stays byte-pinned`);
}
ok('targets: every selector names a real element; pinned runtime files untouched');

// 5. The geometry: the card stays in the window, Echo stays off the target, on every window and every target.
const views = [{ w: 320, h: 568 }, { w: 390, h: 844 }, { w: 768, h: 1024 }, { w: 1024, h: 640 }, { w: 1440, h: 860 }, { w: 2560, h: 1300 }];
const card = { w: 320, h: 170 };
let cases = 0;
for (const view of views) {
  for (const fx of [0, 0.25, 0.5, 0.75, 1]) {
    for (const fy of [0, 0.25, 0.5, 0.75, 1]) {
      for (const [tw, th] of [[40, 40], [240, 56], [view.w * 0.6, view.h * 0.3], [view.w - 40, view.h - 120]]) {
        const hole = { x: Math.max(4, Math.min(view.w - tw - 4, fx * view.w)), y: Math.max(4, Math.min(view.h - th - 4, fy * view.h)), w: tw, h: th };
        const size = { w: Math.min(card.w, view.w - 24), h: card.h };
        const at = placeCard(hole, size, view, 'auto');
        assert.ok(at.x >= 11.9 && at.x + size.w <= view.w - 11.9 && at.y >= 11.9 && at.y + size.h <= view.h - 11.9, `card out of the window ${JSON.stringify({ view, hole, at })}`);
        const smallHole = tw < view.w / 2 && th < view.h / 2;
        if (smallHole) assert.equal(overlapArea({ x: at.x, y: at.y, ...size }, hole), 0, `card over a small target ${JSON.stringify({ view, hole, at })}`);
        const echo = placeEcho({ x: at.x, y: at.y, ...size }, hole, 66, view);
        assert.ok(echo.x >= 0 && echo.x + 66 <= view.w && echo.y >= 0 && echo.y + 66 <= view.h, 'Echo in the window');
        if (smallHole && view.w >= 640) assert.ok(!echo.onTarget || overlapArea({ x: echo.x, y: echo.y, w: 66, h: 66 }, hole) < 66 * 66 * 0.35, `Echo on the target ${JSON.stringify({ view, hole, at, echo })}`);
        cases++;
      }
    }
  }
}
const hole = holeOf({ left: 10, top: 10, right: 110, bottom: 50 }, 6, 12, { w: 800, h: 600 });
assert.ok(hole.x === 4 && hole.r <= hole.h / 2, 'the hole is the element, padded, with its own corners');
assert.ok(/^M.*Z$/.test(liquidPath(10, 10, 100, 60, 12)) && !liquidPath(10, 10, 100, 60, 12).includes('NaN'), 'the opening is a closed path');
ok(`geometry: ${cases} placements`);

// 6. Choreography: one loop, no loop at rest, follows the element, real rendered poses, stills under reduced motion.
assert.ok(/if \(busy\) raf = requestAnimationFrame\(frame\)/.test(stage), 'no frame once everything rests');
assert.ok(/LEAD = 250/.test(stage) && /TRAIL = 118/.test(stage), 'leading edges stiffer than trailing: the opening stretches');
assert.ok(tour.includes("window.addEventListener('scroll', schedule, { passive: true, capture: true })") && tour.includes('new ResizeObserver(schedule)'), 'stays on the element through scroll and resize');
assert.ok(/still \? 0/.test(stage) && /prefers-reduced-motion: reduce/.test(tour) && /@media \(prefers-reduced-motion: reduce\)/.test(css), 'reduced motion: one stable frame');
const art = read('lib/guide/guideArt.ts');
for (const [, file, hash] of art.matchAll(/\/brand\/echo\/(scholar-[a-z]+-([0-9a-f]{8})\.webp)/g)) {
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(pub, 'brand', 'echo', file))).digest('hex').slice(0, 8), hash, `${file}: a changed picture ships under a new name`);
}
assert.ok(art.includes('"tail15"') && art.includes('"happy"') && art.includes('"spray9"'), 'tail, blink, happiness and spout are real rendered frames');
assert.ok(!/backdrop-filter|!important/.test(css), 'no backdrop blur over a wallpaper, no !important');
assert.ok(!/font-family/.test(css), 'Quicksand only');
ok('choreography: one loop, real poses, still when asked');

// 7. Safe: explains, never acts. Nothing is pressed for the learner; the card has every way out.
for (const [name, src] of [['tour', tour], ['stage', stage]]) {
  assert.ok(!/\.click\(\)|requestSubmit|\.submit\(\)|getUserMedia|dispatchEvent/.test(src), `${name} never presses anything for the learner`);
}
for (const id of ['guide-next', 'guide-back', 'guide-skip', 'guide-close', 'guide-pass']) assert.ok(tour.includes(`data-testid="${id}"`), id);
assert.ok(/event\.key === 'Escape'/.test(tour) && /ArrowRight/.test(tour) && /ArrowLeft/.test(tour), 'keyboard');
assert.ok(/role="dialog"/.test(tour) && /aria-live="polite"/.test(tour) && /aria-modal="false"/.test(tour), 'announced, and not a trap');
assert.ok(css.includes('.layer[data-acting] .blocker') && /pointer-events: all/.test(css), 'the target is pressable only on a step that asks for it');
ok('safe: never acts for the learner, always a way out');

// 8. Offers: rare, calm, once. Never during an exam, a game, typing, media, a dialog, the conversation, a journey.
assert.ok(/OFFERS_PER_VISIT = 2/.test(runtime) && /BETWEEN_OFFERS_MS = 45_000/.test(runtime) && /markGuide\(def\.id, 'offered'/.test(runtime), 'at most twice a visit, once per guide');
for (const s of ['journeyActive()', '.echo-panel', '[role="dialog"]', 'isContentEditable', 'media.paused', 'getSelection', 'data-guide-busy', '--wp-quiet']) assert.ok(quiet.includes(s), s);
assert.ok(/attempts/.test(quiet) && /echo-garden/.test(quiet) && /echo-quiz-rush/.test(quiet), 'exam attempts and full-screen games are off limits');
assert.ok(/profile === 'returning'/.test(runtime) && /markGuideInvited/.test(runtime), 'a learner with a history gets one quiet invitation');
assert.ok(/entryOnly/.test(runtime), 'on a lesson, only in the first moments');
assert.ok(!/startGuide\(def\.id\)/.test(runtime.slice(runtime.indexOf('const look'), runtime.indexOf('look();'))), 'an offer never starts a tour by itself');
ok('offers: rare, calm, once');

// 9. Per account, local, no learning content; kept across sign-out; never mixed.
assert.ok(store.includes("const PREFIX = 'ec_guide:v1:'") && /localStorage\.getItem\(PREFIX \+ id\)/.test(store), 'one record per account');
assert.ok(/setGuideAccount\(id\)/.test(host), 'follows the signed-in account');
assert.ok(read('lib/auth-cache-cleanup.ts').includes('ec_guide:v1:'), 'survives the sign-out cleanup');
assert.ok(!/title|body|answer|word:/.test(store.slice(store.indexOf('export interface GuideEntry'), store.indexOf('const PREFIX'))), 'holds ids and states only');
ok('persistence: per account, ids and states only');

// 10. Lives with the companion: one Echo on screen, the chat and its place untouched.
const coach = read('components/features/coach/CoachWidget.tsx');
assert.ok(/useEchoCompanion\(pathname, tab, vi, isOpen \|\| guiding\)/.test(coach), 'the companion rests while a guide runs');
const echoCss = read('components/features/coach/echo.css');
assert.ok(echoCss.includes('html[data-guide-active] .echo-launcher') && echoCss.includes('html[data-guide-active] .echo-panel'), 'hidden, not unmounted: the conversation and the place survive');
assert.ok(!/ECHO_PLACE_KEY|savePlace|localStorage\.setItem\(ECHO/.test(tour), 'the guide never writes the companion\'s place');
assert.ok(read('components/layout/TopNavbar.tsx').includes('data-guide="topbar-help"'), 'the way in');
ok('companion: one Echo, nothing of the chat lost');

// 11. Stays under the journey's passage; waits for it.
assert.ok(/z-index: 2147481000/.test(css), 'below the passage');
ok('order: the passage first');

console.log('\nALL ECHO GUIDE CONTRACTS PASSED');
