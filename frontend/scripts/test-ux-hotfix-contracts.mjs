// UX hotfix contracts (2026-10-02): Landing chatbot never reloads the page; Speaking modes scroll their workspace into view.
// Components are checked statically (no DOM runner in this repo).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf-8');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  -> PASS: ${name}`);
}

console.log('=== UX hotfix contract tests ===\n');

test('chatbot launcher opens in place: state toggle, type="button", no navigation', () => {
  const w = read('components', 'features', 'coach', 'CoachWidget.tsx');
  const launcher = w.slice(w.indexOf('{/* The floating companion.'));
  assert.ok(launcher.includes('type="button"') && launcher.includes('if (isOpen) collapse(); else reopen();'));
  assert.ok(!/router\.|window\.location|href=/.test(launcher), 'launcher never navigates');
  assert.ok(!w.includes('.scrollIntoView('), 'opening never scrolls the page behind the widget');
  assert.ok(w.includes('pane.scrollTo({ top: pane.scrollHeight') && w.includes('ref={messagesContainerRef}'));
  assert.ok(!/focus\(\)/.test(w), 'focus({ preventScroll: true }) only');
});
test('opening the chat never triggers the global 401 → signOut redirect (the reload on the public Landing page)', () => {
  const w = read('components', 'features', 'coach', 'CoachWidget.tsx');
  assert.ok(!w.includes('/ai/learner-dna'), 'DNA is selected server-side on explicit send only');
  const sessions = w.slice(w.indexOf('const fetchSessions = useCallback'), w.indexOf('const loadSessionMessages'));
  assert.ok(sessions.includes('if (!isAuth) return [];'), 'session list stays signed-in only');
  assert.ok(read('services', 'echoCoachApi.ts').includes('skipAuthRedirect: true'), 'passive history errors never trigger global signOut');
  const api = read('services', 'api-client.ts');
  assert.equal((api.match(/originalRequest\.skipAuthRedirect/g) || []).length, 1, 'the one signOut branch honours skipAuthRedirect');
  assert.ok(/outcome === 'ended'[\s\S]{0,400}skipAuthRedirect[\s\S]{0,200}logout\(\)/.test(api), 'only an ended session closes the private UI');
});
test('speaking: every explicit mode activation reveals the mounted workspace (rAF after commit, no long timer)', () => {
  const p = read('app', 'speaking', 'page.tsx');
  assert.equal((p.match(/onSelectMode=\{activateMode\}/g) || []).length, 2, 'Continue card + the four mode cards');
  assert.ok(!p.includes('onSelectMode={(mode) => setSelectedPracticeMode(mode)}'));
  assert.ok(p.includes('setRevealRequest((n) => n + 1)') && p.includes('if (revealRequest === 0) return;'), 'no scroll on first render');
  // Echo Glass (2026-10-22): Quick Check opens its own studio panel, the other modes the workspace — same one-frame reveal
  assert.ok(/requestAnimationFrame\(\(\) => \{\s*const target = isQuickCheck \? quickRef\.current : workspaceRef\.current;\s*if \(target\) revealWorkspace\(target\);/.test(p) && p.includes('cancelAnimationFrame(frame)'));
  assert.ok(p.includes('}, [revealRequest]);'), 'one scroll per activation — no loop');
  const reveal = p.slice(p.indexOf('function revealWorkspace'), p.indexOf('function SpeakingContent'));
  assert.ok(!reveal.includes('setTimeout'));
  assert.ok(reveal.includes('(prefers-reduced-motion: reduce)') && reveal.includes('reduceMotion ? "auto" : "smooth"'));
  assert.ok(reveal.includes('block: "start", inline: "nearest"'), 'vertical only');
  assert.ok(reveal.includes('alreadyVisible') && reveal.includes('focus({ preventScroll: true })'), 'no needless jump; focus without a 2nd scroll');
  assert.ok(/ref=\{workspaceRef\}\s*id="speaking-workspace"\s*tabIndex=\{-1\}/.test(p) && /ref=\{quickRef\}\s*id="speaking-quick-check"\s*tabIndex=\{-1\}/.test(p));
  const css = read('components', 'features', 'speaking', 'studio', 'speakingStudio.module.css');
  assert.ok(/\.quick \{[^}]*scroll-margin-top: 1rem/.test(css) && /\.work \{[^}]*scroll-margin-top: 1rem/.test(css), 'a small gap above the revealed panel');
  for (const mode of ['"shadowing"', '"roleplay"'])
    assert.ok(p.includes(`selectedPracticeMode === ${mode}`), `${mode} renders inside the revealed workspace`);
  assert.ok(p.includes('const isQuickCheck = selectedPracticeMode === "assessment";') && p.includes('{isQuickCheck && ('), '"assessment" reveals the Quick Check studio');
});

console.log(`\n=== ${passed} UX hotfix contract tests PASSED ===`);
