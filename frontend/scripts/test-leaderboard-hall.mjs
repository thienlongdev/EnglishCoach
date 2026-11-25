// Contract checks of the Leaderboard "Echo Hall of Champions" presentation (2026-10-30). Run: npm run test:leaderboard-hall
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FE = path.join(HERE, '..');
const src = (...p) => path.join(FE, 'src', ...p);
const read = (...p) => fs.readFileSync(src(...p), 'utf-8');
const LB = ['components', 'features', 'leaderboard'];
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`✓ ${name}`); };
console.log('=== Leaderboard Hall of Champions contract tests ===');

const f = await import(new URL('../src/lib/leaderboard/format.ts', import.meta.url).href);

test('artwork: every published name exists and carries its own content hash (immutable caching)', () => {
  const art = read(...LB, 'hall', 'hallArt.ts');
  const names = [...art.matchAll(/'\/leaderboard\/hall\/([a-z0-9-]+)-([0-9a-f]{10})\.webp'/g)];
  assert.equal(names.length, 8);
  for (const [, key, hash] of names) {
    const file = path.join(FE, 'public', 'leaderboard', 'hall', `${key}-${hash}.webp`);
    assert.ok(fs.existsSync(file), file);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 10), hash, `hash of ${key}`);
  }
});

test('trophy: the real-time profile and the Blender still share the same numbers', () => {
  const ts = read(...LB, 'hall', 'trophyShape.ts');
  const py = fs.readFileSync(path.join(FE, '..', 'docs', 'leaderboard', 'hall-of-champions-2026-10-30', 'art', 'scene_trophy.py'), 'utf-8');
  const nums = (s, name, open, close) => {
    const i = s.indexOf(name);
    const body = s.slice(s.indexOf(open, i), s.indexOf(close, s.indexOf(open, i) + 1));
    return (body.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  };
  for (const name of ['PLINTH', 'BODY', 'HANDLE']) {
    const a = nums(ts, `export const ${name}`, '= [', '];');
    const b = nums(py, `${name} = [`, '[', ']\n');
    assert.ok(a.length > 6, name);
    assert.deepEqual(a, b, name);
  }
});

test('trophy scene: bounded cost (pixel ratio ≤ 2, frame cap, still = one frame, full dispose, lost context)', () => {
  const s = read(...LB, 'hall', 'trophyScene.ts');
  assert.ok(s.includes('Math.min(window.devicePixelRatio || 1, 2)'));
  assert.ok(s.includes("powerPreference: 'low-power'"));
  assert.ok(s.includes('if (now - last >= 21)'), '≈ 45 fps cap');
  assert.ok(/setActive\(next\) \{\s*if \(disposed \|\| opts\.still\) return;/.test(s), 'a still trophy never loops');
  for (const k of ['ro.disconnect()', 'envTex.dispose()', 'renderer.dispose()', 'renderer.forceContextLoss()', "removeEventListener('webglcontextlost'"])
    assert.ok(s.includes(k), k);
  assert.ok(!/fetch\(|GLTFLoader|import\(['"]http/.test(s), 'procedural: no download');
  const host = read(...LB, 'hall', 'HallTrophy.tsx');
  assert.ok(host.includes("import('./trophyScene')") && host.includes('requestIdleCallback') && host.includes('saveData'), 'lazy, after idle, skipped on Save-Data');
  assert.ok(host.includes('still: !!reduce'), 'reduced motion = one settled frame');
});

test('hall: no request of its own, live only on screen + visible tab, mouse-only parallax', () => {
  const hero = read(...LB, 'LeaderboardHero.tsx');
  assert.ok(!/useActivityBoard|useActivityMe|leaderboardApi|fetch\(/.test(hero), 'the hall reads nothing');
  assert.ok(hero.includes('IntersectionObserver') && hero.includes("document.visibilityState === 'visible'"));
  assert.ok(hero.includes("e.pointerType !== 'mouse'") && hero.includes('reduceMotion'));
  const css = read(...LB, 'hall', 'hall.module.css');
  assert.ok(/\.stage:not\(\[data-live="true"\]\)[^{]*\{\s*animation-play-state: paused;/.test(css), 'animations pause off screen');
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'));
  assert.ok(!css.includes('backdrop-filter') && !css.includes('!important'), '10 §AF: no backdrop blur, no important flags');
  assert.ok(!/font-family/.test(css), '10 §AA: no own typeface');
  assert.ok(css.includes(':global(html[data-wallpaper]) .page { background: transparent; }'));
  assert.ok(css.includes(':global(.dark) .backdrop { background-image: var(--hall-tall-midnight); }'), 'dark theme = its own hall');
});

test('podium: only real learners; missing places are unoccupied seats; text equivalents', () => {
  const p = read(...LB, 'hall', 'HallPodium.tsx');
  assert.ok(p.includes('podiumSlots(entries)') && p.includes('t.emptySlot') && p.includes('data-testid="podium-placeholder"'));
  assert.ok(p.includes('<ol aria-label') && p.includes('sr-only'));
  assert.ok(p.includes('entries.length === 0 && !loading && empty'), 'the empty call only when nobody is ranked');
  assert.ok(!/displayName: ['"]/.test(p), 'never a made-up name');
  const tab = read(...LB, 'ActivityBoardTab.tsx');
  assert.ok(tab.includes("useActivityMe('ALL_TIME', 'GLOBAL', 'ALL', { live: false })"), 'all-time XP at the calm widget cadence');
  assert.ok(tab.includes('createPortal(podium, slots.podium)') && tab.includes("formatXp(i.points, locale)"));
});

test('own name for the hall is never an e-mail address', () => {
  assert.equal(f.publicSelfName('Nguyễn A (a.b@example.com)'), 'Nguyễn A');
  assert.equal(f.publicSelfName('a@b.vn'), null);
  assert.equal(f.publicSelfName('B24DCCN370 - Nguyễn Tú'), 'B24DCCN370 - Nguyễn Tú');
  for (const k of Object.keys(f.HALL_TEXT.vi)) assert.ok(k in f.HALL_TEXT.en, `en ${k}`);
});

test('the dashboard widgets keep their own pieces (compact Podium, BoardRowCard) untouched by the hall', () => {
  const w = read(...LB, 'TopLearnersWidget.tsx');
  assert.ok(w.includes('<Podium') && w.includes('BoardRowCard') && !w.includes('hall/'));
});

console.log(`\n=== ${passed} leaderboard hall contract tests PASSED ===`);
