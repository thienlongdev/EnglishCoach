// Không gian học tập — source contracts (no browser). Run: node scripts/test-study-space.mjs
// The browser journey (template, drag, undo, default, clear, reveal, restore, focus across a frozen page, dock, notes)
// lives in docs/study-space/2026-11-02/evidence/journey.cjs.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const walk = (dir) => readdirSync(path.join(root, dir)).flatMap((f) => {
  const rel = path.join(dir, f);
  return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel];
});
const files = [...walk('src/components/study-space'), ...walk('src/lib/study-space'), 'src/app/study-space/page.tsx', 'src/app/study-space/timer/page.tsx'];
const all = files.map((f) => [f, read(f)]);

// 1. Every catalogue id has a real builder; every builder is offered.
const catalog = read('src/lib/study-space/catalog.ts');
const ids = [...catalog.matchAll(/item\(\{ id: '([^']+)'/g)].map((m) => m[1]);
const furniture = read('src/components/study-space/world/furniture.ts');
const builderBlock = furniture.slice(furniture.indexOf('const B: Record<string, Builder> = {'), furniture.indexOf('export const BUILDERS'));
const builders = [...builderBlock.matchAll(/^ {2}(?:'([^']+)'|([a-zA-Z]+)): \(/gm)].map((m) => m[1] ?? m[2]);
assert.ok(ids.length >= 55, `catalogue has ${ids.length} items`);
assert.deepEqual(ids.filter((i) => !builders.includes(i)), [], 'every catalogue item has a builder');
assert.deepEqual(builders.filter((b) => !ids.includes(b)), [], 'no builder outside the catalogue');
assert.equal(new Set(ids).size, ids.length, 'catalogue ids are unique');

// 2. Product laws: no sparkle icon or emoji, no "&" in copy, no markup sinks, no AI call, no passive network in the engine.
for (const [f, text] of all) {
  assert.doesNotMatch(text, /\bSparkles?\b|✨/, `${f}: sparkle icons are forbidden`);
  assert.doesNotMatch(text, /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|document\.write|new Function\(|\beval\(/, `${f}: no markup sink`);
  assert.doesNotMatch(text, /openrouter|\/ai\/|explain-context/i, `${f}: no AI call in the study space`);
  for (const m of text.matchAll(/>([^<>{}\n]*&[^<>{}\n]*)</g)) if (!/&&|===|!==|=>/.test(m[1])) assert.fail(`${f}: "&" in copy: ${m[1]}`);
}
for (const f of ['src/components/study-space/world/engine.ts', 'src/components/study-space/world/room.ts', 'src/components/study-space/world/furniture.ts', 'src/components/study-space/world/character.ts']) {
  assert.doesNotMatch(read(f), /fetch\(|apiClient|axios/, `${f}: the scene makes no API request`);
}

// 3. The background belongs to Giao diện: the study space never builds its own wallpaper engine.
const shell = read('src/components/study-space/StudySpace.tsx');
assert.doesNotMatch(shell, /<video|youtube|WorldStudio|worlds\/runtime/i, 'no second background engine in the study space');
const frame = read('src/components/layout/ApplicationFrame.tsx');
const branch = frame.slice(frame.indexOf('if (isStudySpace) {'), frame.indexOf('if (isEchoGarden'));
assert.match(branch, /\{background\}/, 'the one appearance background stays under the room');
assert.doesNotMatch(branch, /<Sidebar|<TopNavbar/, 'no sidebar or top bar in the space');
assert.match(read('src/components/study-space/world/engine.ts'), /alpha: true[\s\S]*setClearColor\(0x000000, 0\)/, 'the room canvas is transparent');

// 4. Personal default: only "Lưu làm mặc định" writes it; Xóa trắng saves the CURRENT layout with reason CLEAR.
assert.equal((shell.match(/studySpaceApi\.saveDefault\(/g) ?? []).length, 1, 'one writer of the personal default');
assert.match(shell, /clearAll: async \(\) => \{[\s\S]*?emptyLayout\([\s\S]*?persist\('CLEAR'\)/, 'Xóa trắng saves the current layout only');
assert.doesNotMatch(shell.slice(shell.indexOf('clearAll:'), shell.indexOf('applyTemplate:')).replace(/saveNamedRoom/g, ''), /saveDefault/, 'clearing never touches the default');
assert.match(shell, /restoreDefault: async[\s\S]*?fresh\.defaultLayout/, 'Trở về mặc định restores the learner\'s saved default');
assert.match(shell, /if \(!space\.hasDefault\)/, 'without a personal default no system template is imposed silently');

// 5. Hidden controls: no permanent restore pill; the toolbar opens from the top edge, Esc and a swipe down.
const edgeZone = shell.match(/<div\b[^>]*className=\{s\.edgeZone\}[^>]*\/>/)?.[0] ?? '';
assert.match(edgeZone, /onPointerMove=\{openBar\}/, 'moving the pointer at the top edge reveals the toolbar');
assert.doesNotMatch(edgeZone, /onPointerEnter=\{openBar\}/, 'mounting the edge beneath a stationary pointer keeps the toolbar closed');
assert.match(shell, /e\.key === 'Escape'[\s\S]*?openBar\(\)/, 'Esc reveals the toolbar');
assert.match(shell, /touchmove/, 'touch: swipe down from the top edge');
const lay = read('src/lib/study-space/layout.ts');
assert.match(lay, /export function emptyLayout[\s\S]*?objects: \[\], widgets: \[\]/, 'an empty foreground has no widget and no object');

// 6. Focus timer: computed from timestamps, never by counting ticks.
const focus = read('src/lib/study-space/focus.ts');
assert.match(focus, /export const elapsedMs = \(s: FocusState, now = Date\.now\(\)\) => s\.accumulatedMs \+/, 'elapsed = stored + (now - segment start)');
assert.doesNotMatch(focus, /remaining\w*\s*-=\s*1|seconds\s*-=\s*1|--\s*remaining/, 'no tick counting');
assert.match(focus, /BroadcastChannel/, 'tabs share the timer');
const focusBridge = read('src/components/study-space/FocusBridge.tsx');
assert.match(focusBridge, /studySpaceApi\.reportFocus\(s\.sessionId/, 'the server records sessions by their id (idempotent)');
assert.match(read('src/components/study-space/portable.ts'), /documentPictureInPicture[\s\S]*window\.open\('\/study-space\/timer'/, 'Picture-in-Picture with a popup fallback');

// Small pure check of the timer math (no DOM): elapsed and remaining from timestamps.
const el = (s, now) => s.accumulatedMs + (s.status === 'running' && s.segmentStart ? Math.max(0, now - s.segmentStart) : 0);
const st = { accumulatedMs: 60_000, status: 'running', segmentStart: 1_000_000, durationMs: 25 * 60_000 };
assert.equal(el(st, 1_000_000 + 30 * 60_000), 31 * 60_000, 'a 30-minute background gap counts as 30 minutes of wall time');

// 7. Navigation: the launcher replaces the account card; title, morph and spatial tables know the route.
const sidebar = read('src/components/layout/Sidebar.tsx');
assert.match(sidebar, /data-testid="sidebar-study-space"/);
assert.doesNotMatch(sidebar, /userCard|<UserAvatar|logout\(/, 'the bottom account card is gone (the account menu keeps account actions)');
assert.match(read('src/components/layout/AccountMenu.tsx'), /logout/, 'sign-out stays in the top-right account menu');
assert.match(read('src/lib/brand/pageTitle.ts'), /'\/study-space': \['Không gian học tập'/);
assert.match(read('src/lib/morph/rules.ts'), /study-space/);
assert.match(read('src/lib/spatial/context.ts'), /pathname === '\/study-space'[\s\S]*?env: 'live', surfaces: 'off'/, 'the existing Spatial scene is live without modifying study widgets');
assert.match(read('src/components/features/coach/CoachWidget.tsx'), /pathname\.startsWith\('\/study-space'\)/, 'no floating companion over the empty view');

// 8. Isolation: user-scoped caches and storage.
assert.match(read('src/lib/study-space/api.ts'), /tasks: \(u: string\) => \['study-space\/tasks', u\]/, 'SWR keys carry the account');
assert.match(focus, /ec_focus:v1:\$\{account \? `u\$\{account\}` : 'guest'\}/, 'the timer state is per account');
assert.match(read('src/components/study-space/ResearchPanel.tsx'), /ec-research-v1-u\$\{account\}/, 'research files are per account, in this browser only');

console.log(`study-space contracts: OK (${ids.length} catalogue items, ${files.length} files)`);
