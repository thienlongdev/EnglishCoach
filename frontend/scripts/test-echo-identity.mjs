// Echo Living Identity contract (10 §BJ): tab titles, one brand registry, clean files, companion geometry and restraint.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), babel = require('next/dist/compiled/babel/bundle.js');
const root = fileURLToPath(new URL('..', import.meta.url));
const read = rel => readFileSync(path.join(root, 'src', rel), 'utf8');
function evaluate(rel, dependencies = {}) {
  const { code } = babel.core().transformSync(read(rel), { filename: rel, configFile: false, babelrc: false,
    presets: [babel.presetTypescript()], plugins: [babel.pluginTransformModulesCommonjs()] });
  const exports = {};
  runInNewContext(code, { exports, require: name => dependencies[name] ?? require(name), console });
  return exports;
}

// ---- titles
const titles = evaluate('lib/brand/pageTitle.ts');
const title = (p, t = null, l = 'vi') => titles.resolvePageTitle(p, t, l);
assert.equal(title('/').title, 'English Coach', 'landing is exactly English Coach');
assert.equal(title('/', 'landing').title, 'English Coach');
assert.equal(title('/').landing, true);
const expected = { dashboard: 'Hôm nay học gì?', reading: 'Đọc chuyên sâu', flashcards: 'Ôn tập từ vựng', writing: 'Luyện viết', leaderboard: 'Bảng xếp hạng' };
for (const [tab, name] of Object.entries(expected)) assert.equal(title('/', tab).title, name);
for (const [route, name] of Object.entries({ '/listening': 'Thư viện luyện nghe', '/speaking': 'Luyện nói', '/learning-path': 'Lộ trình học', '/games': 'Thư viện trò chơi', '/exams': 'Thi thử', '/profile': 'Hồ sơ của tôi', '/progress': 'Tiến độ học tập', '/music': 'Âm nhạc', '/login': 'Đăng nhập' })) {
  assert.equal(title(route).title, name);
}
assert.equal(title('/exams/toeic/attempts/42').living, 'still', 'an exam attempt never moves');
assert.equal(title('/listening/5/practice').living, 'still', 'dictation never moves');
assert.equal(title('/listening/5').living, 'still');
assert.equal(title('/', 'dashboard').living, 'rich');
const everyName = read('lib/brand/pageTitle.ts');
assert.ok(!/AI English|\| English Coach|— English Coach/.test(everyName), 'no slogan, no brand suffix');
assert.ok(titles.shortTitle('x'.repeat(200)).length <= titles.TITLE_MAX, 'long titles are cut');
assert.ok(!read('app/layout.tsx').includes('AI English Learning'));
for (const page of ['app/games/echo-quiz-rush/page.tsx', 'app/games/echo-garden/page.tsx']) assert.ok(!/title:/.test(read(page)), `${page}: the title table owns the tab`);
assert.ok(!read('context/NotificationRealtimeContext.tsx').includes('document.title'), 'one writer of document.title');
assert.ok(read('proxy.ts').includes("requestHeaders.set('x-ec-path'"), 'the header is always overwritten by the proxy');

// ---- one registry, real files
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(full);
  }
  return out;
}
const LEGACY = /services[\\/]communityApi\.ts$|flashcard[\\/]pvp[\\/]/; // a stored value / byte-pinned file that names the old address; the file itself now shows the new mark
for (const file of walk(path.join(root, 'src'))) {
  const text = readFileSync(file, 'utf8');
  if (/\/assets\/Whale\.svg/.test(text)) assert.ok(LEGACY.test(file), `${file}: pictures come from lib/brand/echoCharacters`);
  if (/src="\/brand\//.test(text)) assert.fail(`${file}: pictures come from lib/brand/echoCharacters`);
}
const art = read('lib/brand/echoArt.ts');
const files = [...art.matchAll(/'(\/brand\/echo\/[^']+)'/g)].map(m => m[1]);
assert.ok(files.length >= 25, 'the family is registered');
for (const file of files) {
  const full = path.join(root, 'public', file);
  assert.ok(existsSync(full), file);
  const digest = /-([0-9a-f]{8})\.[a-z]+$/.exec(file)[1];
  assert.equal(createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 8), digest, `${file}: a changed picture ships under a new name`);
}
const ico = readFileSync(path.join(root, 'public', /ico: '([^']+)'/.exec(art)[1]));
assert.equal(ico.readUInt16LE(2), 1);
assert.equal(ico.readUInt16LE(4), 4, 'favicon holds 16, 32, 48, 64');
for (const key of ['png192', 'png512']) {
  const png = readFileSync(path.join(root, 'public', new RegExp(`${key}: '([^']+)'`).exec(art)[1]));
  assert.equal(png[25], 6, `${key} has an alpha channel`);
}
const manifest = read('app/manifest.ts');
assert.ok(manifest.includes("purpose: 'maskable'") && manifest.includes("purpose: 'any'"));
const echoArt = evaluate('lib/brand/echoArt.ts');
const characters = evaluate('lib/brand/echoCharacters.ts', { './echoArt': echoArt });
assert.ok(characters.echoSrc('official', 16).includes('official-64'));
assert.ok(characters.echoSrc('scholar', 24).includes('scholar-face'));
assert.ok(characters.echoSrc('tech', 64).includes('tech-192'));
assert.ok(characters.echoSrc('social', 200).includes('social-384'));

// ---- living favicon: one file, no loop at rest, nothing where it must stay still
const favicon = read('lib/brand/livingFavicon.ts');
assert.ok(favicon.includes('document.hidden') && favicon.includes('prefers-reduced-motion') && favicon.includes("visibilitychange"));
assert.ok(!/createObjectURL|requestAnimationFrame|fetch\(/.test(favicon), 'no object URL to leak, no render loop, no request');
assert.ok(read('components/brand/EchoTabIdentity.tsx').includes("living === 'still' ? undefined : runLivingFavicon()"));
assert.ok(read('components/brand/EchoTabIdentity.tsx').includes("living !== 'still' && !landing ? runTitleSwim()"), 'the title strip never runs on the landing page or a still screen');

// ---- the site's own chrome carries no ocean strip (owner correction 2026-10-31): the tab is the only target
const shellCss = read('components/layout/WorkspaceShell.module.css');
assert.ok(!/ocean(Edge|Front|Back|Glint|Drift)/.test(shellCss), 'no waterline in the shell styles');
assert.ok(!/ocean(Edge|Front|Back|Glint)/.test(read('components/layout/TopNavbar.tsx')), 'no waterline in the top bar');

// ---- companion geometry
const g = evaluate('components/features/coach/echo-companion.ts');
const screen = { left: 0, right: 1440, top: 0, bottom: 900 };
for (const raw of [null, '{bad', '{}', '{"side":"evil","y":1}', '{"side":"left","y":99}', '{"side":"right","y":-4}']) {
  const place = g.restorePlace(raw);
  assert.ok(place.side === 'left' || place.side === 'right');
  assert.ok(place.y >= 0 && place.y <= 1);
  const p = g.pointOf(place, 74, screen);
  assert.ok(p.x >= 0 && p.x + 74 <= 1440 && p.y >= 0 && p.y + 74 <= 900, 'always on the screen');
}
assert.equal(g.placeOf({ x: 100, y: 300 }, 0, 74, screen).side, 'left', 'nearest edge');
assert.equal(g.placeOf({ x: 1300, y: 300 }, 0, 74, screen).side, 'right');
assert.equal(g.placeOf({ x: 600, y: 300 }, 1500, 74, screen).side, 'right', 'a throw decides');
assert.equal(g.placeOf({ x: 800, y: 300 }, -1500, 74, screen).side, 'left');
const round = g.pointOf(g.placeOf({ x: 14, y: 400 }, 0, 74, screen), 74, screen);
assert.ok(Math.abs(round.y - 400) < 1, 'the height is kept');
const narrow = g.pointOf({ side: 'right', y: 1 }, 62, { left: 0, right: 360, top: 0, bottom: 320 });
assert.ok(narrow.x + 62 <= 360 && narrow.y + 62 <= 320, 'a keyboard or a small phone never pushes it off');
const clamped = g.clampPoint({ x: -500, y: 5000 }, 74, { width: 1000, height: 700 });
assert.ok(clamped.x >= 0 && clamped.y + 74 <= 700);
for (const orb of [{ x: 14, y: 14 }, { x: 14, y: 800 }, { x: 1350, y: 14 }, { x: 1350, y: 800 }, { x: 1350, y: 400 }, { x: 14, y: 400 }]) {
  const a = g.panelAnchor(orb, 74, { width: 410, height: 580 }, { width: 1440, height: 900 });
  assert.ok(a.left >= 12 && a.left + 410 <= 1428 && a.top >= 12 && a.top + 580 <= 888, 'the chat opens inside the window');
  const overlaps = a.left < orb.x + 74 && a.left + 410 > orb.x && a.top < orb.y + 74 && a.top + 580 > orb.y;
  assert.ok(!overlaps, `the chat does not cover its Echo ${JSON.stringify(orb)}`);
}
assert.equal(g.restorePrefs(null).messages, true);
assert.equal(g.restorePrefs('{"messages":false}').messages, false);
assert.ok(g.NUDGE_FIRST_MS >= 600000 && g.NUDGE_EVERY_MS >= 600000 && g.NUDGE_MAX_PER_VISIT <= 3, 'rare words');
assert.ok(g.DRAG_START_PX >= 4 && g.DRAG_START_PX <= 10);
const lines = read('components/features/coach/echo-companion.ts');
assert.ok(!/✨|Sparkles/.test(lines));
const hook = read('components/features/coach/useEchoCompanion.ts');
assert.ok(!/fetch\(|apiClient|authFetch|echoCoachApi/.test(hook), 'no request behind the small life');
assert.ok(hook.includes('consumeDragClick') && hook.includes('event?.detail !== 0'), 'a keyboard click always opens');
assert.ok(hook.includes("living === 'still'") && hook.includes('document.hidden') && hook.includes('prefers-reduced-motion'));
const css = read('components/features/coach/echo.css');
assert.ok(!/echo-presence|echo-unread/.test(css + read('components/features/coach/CoachWidget.tsx')), 'no status dot or badge on the whale');
assert.ok(css.includes('touch-action: none') && css.includes('.echo-launcher[data-beat="bubbles"]'));
assert.ok(!/echo-orb|border-radius: 50%; background: radial-gradient\(circle/.test(css), 'the companion is a free whale: no circular frame to overflow');
console.log('Echo identity PASS: titles, registry and hashed files, favicon lifecycle, no ocean strip in the site, companion geometry and restraint.');
