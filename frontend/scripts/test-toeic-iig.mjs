/**
 * TOEIC IIG-style exam room (2026-11-16) — contract test.
 *  1. Executes the REAL pure model src/lib/exams/toeicIig.ts (types stripped): part numbers, Reading screens (Part 5 per
 *     item, Part 6 / 7 per set), Listening recording units (per-part playlist, whole-section file, shared asset),
 *     header wording, hh:mm:ss clock, letters-only Listening Parts 1–2, no invented options, tile statuses / attention
 *     list, submit copy.
 *  2. Wiring / containment: only TOEIC Listening / Reading use the room (Speaking / Writing / IELTS unchanged), the
 *     room calls the runtime's callbacks (no own network path except playback grants), no Listening navigation /
 *     pause / seek controls, Submit is not a Listening exit in a simulation, the preview is development-only, no
 *     sparkle icon, no "&" in copy, no backdrop blur / gradient in the room.
 * Run: node scripts/test-toeic-iig.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const fe = path.join(here, '..');
const read = (...p) => fs.readFileSync(path.join(fe, ...p), 'utf8').split('\r\n').join('\n');

const src = read('src', 'lib', 'exams', 'toeicIig.ts');
assert.ok(!/^\s*import\s/m.test(src), 'the pure model has no imports');
const js = stripTypeScriptTypes(src).replace(/^export /gm, '');
const names = [
  'iigPartNumber', 'iigEntries', 'buildReadingScreens', 'screenIndexOf', 'readingNav', 'partAudioAssetId', 'buildListeningUnits',
  'iigHeaderTitle', 'iigClock', 'iigAnswered', 'iigSelected', 'iigOptions', 'iigQuestionLine', 'iigTileStatus', 'iigTileParts',
  'iigCounts', 'iigSubmitMessage',
];
const m = new Function(`${js}\nreturn { ${names.join(', ')} };`)();

// ── Part numbers ─────────────────────────────────────────────────────────────────────────────────────────────────
assert.equal(m.iigPartNumber('LISTENING_PART_3', 0, 'LISTENING'), 3);
assert.equal(m.iigPartNumber('READING_PART_7', 0, 'READING'), 7);
assert.equal(m.iigPartNumber('', 1, 'LISTENING'), 2);
assert.equal(m.iigPartNumber(null, 0, 'READING'), 5);
assert.equal(m.iigPartNumber('READING_PART_3', 1, 'READING'), 6, 'an out-of-range code falls back to the position');

// ── Reading screens ([P-READ-STEP]) ────────────────────────────────────────────────────────────────────────────
const it = (id, n) => ({ placementId: id, optionDefinitions: { questionNumber: n, options: [] } });
const readingParts = [
  { partCode: 'READING_PART_5', groups: [{ id: 'a', items: [it('p101', 101)] }, { id: 'b', items: [it('p102', 102)] }] },
  { partCode: 'READING_PART_6', groups: [{ id: 'c', items: [it('p131', 131), it('p132', 132), it('p133', 133), it('p134', 134)] }] },
  { partCode: 'READING_PART_7', groups: [{ id: 'd', items: [it('p147', 147), it('p148', 148)] }, { id: 'e', items: [it('p196', 196), it('p197', 197)] }] },
];
const nums = new Map([['p101', 101], ['p102', 102], ['p131', 131], ['p132', 132], ['p133', 133], ['p134', 134], ['p147', 147], ['p148', 148], ['p196', 196], ['p197', 197]]);
const entries = m.iigEntries(readingParts, nums, 'READING');
assert.equal(entries.length, 10);
const screens = m.buildReadingScreens(entries);
assert.deepEqual(screens.map((s) => s.numbers), [[101], [102], [131, 132, 133, 134], [147, 148], [196, 197]]);
assert.equal(m.screenIndexOf(screens, 'p133'), 2);
assert.equal(m.screenIndexOf(screens, 'nope'), -1);
assert.deepEqual(m.readingNav(screens, 0), { canPrev: false, canNext: true });
assert.deepEqual(m.readingNav(screens, 4), { canPrev: true, canNext: false });
// Part 5 items that share one group still get one screen each.
const shared = m.buildReadingScreens(m.iigEntries([{ partCode: 'READING_PART_5', groups: [{ id: 'z', items: [it('x1', 101), it('x2', 102)] }] }], new Map([['x1', 101], ['x2', 102]]), 'READING'));
assert.equal(shared.length, 2);

// ── Listening units ([P-LISTEN-UNIT]) ──────────────────────────────────────────────────────────────────────────
const au = (id) => ({ assets: [{ assetId: id, mimeType: 'audio/mpeg' }] });
const img = (id) => ({ assets: [{ assetId: id, mimeType: 'image/png' }] });
const perPart = [1, 2, 3, 4].map((n) => ({ partCode: `LISTENING_PART_${n}`, groups: [{ id: `g${n}`, items: [], stimuli: [au(`a${n}`), img(`i${n}`)] }] }));
assert.deepEqual(m.buildListeningUnits(perPart).map((u) => [u.partIndexes, u.assetId]), [[[0], 'a1'], [[1], 'a2'], [[2], 'a3'], [[3], 'a4']]);
const clips = [{ groups: [{ id: 'q1', stimuli: [au('clip1')] }, { id: 'q2', stimuli: [au('clip2')] }] }];
assert.deepEqual(m.buildListeningUnits(clips).map(u => [u.assetId, u.groupIds]), [['clip1',['q1']],['clip2',['q2']]]);
const single = [
  { partCode: 'LISTENING_PART_1', groups: [{ id: 'g1', stimuli: [au('whole')] }] },
  { partCode: 'LISTENING_PART_2', groups: [{ id: 'g2', stimuli: [] }] },
  { partCode: 'LISTENING_PART_3', groups: [{ id: 'g3', stimuli: [img('t')] }] },
];
assert.deepEqual(m.buildListeningUnits(single).map((u) => [u.partIndexes, u.assetId]), [[[0, 1, 2], 'whole']], 'one section-wide file = one unit');
const sameAsset = [
  { groups: [{ id: 'x', stimuli: [au('s')] }] },
  { groups: [{ id: 'y', stimuli: [au('s')] }] },
];
assert.equal(m.buildListeningUnits(sameAsset).length, 1, 'parts that reference the same recording stay one unit');
const leadIn = [{ groups: [{ id: 'q', stimuli: [] }] }, { groups: [{ id: 'r', stimuli: [au('late')] }] }];
assert.deepEqual(m.buildListeningUnits(leadIn).map((u) => u.partIndexes), [[0, 1]]);
const silent = m.buildListeningUnits([{ groups: [{ id: 'q', stimuli: [img('i')] }] }]);
assert.deepEqual(silent.map((u) => [u.partIndexes, u.assetId]), [[[0], null]], 'no audio ⇒ one unit with no asset (room reports unavailable)');
assert.equal(m.partAudioAssetId({ groups: [{ id: 'q', stimuli: [img('i'), au('x')] }] }), 'x');

// ── Header / clock ─────────────────────────────────────────────────────────────────────────────────────────────
assert.equal(m.iigHeaderTitle('LISTENING', [1], 200), 'Listening: Questions 1 of 200');
assert.equal(m.iigHeaderTitle('READING', [151, 152], 200), 'Reading: Questions 151 - 152 of 200');
assert.equal(m.iigHeaderTitle('READING', [], 200), 'Reading: 200 Questions');
assert.equal(m.iigClock(4008), '01:06:48');
assert.equal(m.iigClock(0), '00:00:00');
assert.equal(m.iigClock(-5), '00:00:00');
assert.equal(m.iigClock(NaN), '00:00:00');

// ── Options ────────────────────────────────────────────────────────────────────────────────────────────────────
const p1 = { optionDefinitions: { options: [{ id: 'A', text: 'A man is reading a newspaper.' }, { id: 'B', text: 'B' }, { id: 'C', text: '' }, { id: 'D', text: '(D) x' }] } };
assert.deepEqual(m.iigOptions(p1, 1).map((o) => [o.letter, o.text]), [['A', ''], ['B', ''], ['C', ''], ['D', '']], 'Part 1 never prints the spoken statements');
const p2 = { optionDefinitions: { options: [{ id: 'A', text: 'x' }, { id: 'B', text: 'y' }, { id: 'C', text: 'z' }] } };
assert.equal(m.iigOptions(p2, 2).length, 3, 'Part 2 keeps exactly its three options');
assert.ok(m.iigOptions(p2, 2).every((o) => o.text === ''));
const p5 = { optionDefinitions: { options: [{ id: 'A', text: '(A) review' }, { id: 'B', text: 'B. reviewing' }, { id: 'C', text: 'reviewer' }, { id: 'D', text: 'D' }] } };
assert.deepEqual(m.iigOptions(p5, 5).map((o) => [o.id, o.letter, o.text]), [['A', 'A', 'review'], ['B', 'B', 'reviewing'], ['C', 'C', 'reviewer'], ['D', 'D', '']]);
const uuidOpts = { options: [{ id: 'u-1', text: 'one' }, { id: 'u-2', text: 'two' }] };
assert.deepEqual(m.iigOptions(uuidOpts, 7).map((o) => [o.id, o.letter]), [['u-1', 'A'], ['u-2', 'B']], 'non-letter ids: printed letter by position, stored id unchanged');
assert.deepEqual(m.iigOptions({ optionDefinitions: { options: [] } }, 5), [], 'no options are invented');
assert.deepEqual(m.iigOptions(null, 5), []);
assert.equal(m.iigQuestionLine(1, 1, 'Hidden spoken text'), '1. Question 1');
assert.equal(m.iigQuestionLine(7, 2, 'What time is it?'), '7. Question 7');
assert.equal(m.iigQuestionLine(133, 6, ''), '133. Question 133');
assert.equal(m.iigQuestionLine(32, 3, 'Where are the speakers?'), '32. Where are the speakers?');
assert.equal(m.iigQuestionLine(147, 7, '147. What is the notice for?'), '147. What is the notice for?', 'a printed number is not doubled');
// Real package shapes (YBM / Economy packages): Part 6 stems are the gap marker only; Part 1/2 carry audio instructions.
assert.equal(m.iigQuestionLine(131, 6, '(131) ______'), '131. Question 131');
assert.equal(m.iigQuestionLine(1, 1, 'Look at the picture marked number 1 in your test book.'), '1. Question 1');
assert.equal(m.iigQuestionLine(7, 2, 'Mark your answer on your answer sheet.'), '7. Question 7');
assert.equal(m.iigQuestionLine(101, 5, 'Mr. Dola chose to take a …… flight.'), '101. Mr. Dola chose to take a …… flight.');
const labelled = { optionDefinitions: { options: [{ id: 'A', label: 'cancel' }, { id: 'B', label: 'circulate' }] } };
assert.deepEqual(m.iigOptions(labelled, 5).map((o) => o.text), ['cancel', 'circulate'], 'option text in `label` (original-practice packages)');
assert.deepEqual(m.iigOptions({ options: [{ label: 'A' }, { label: 'B' }] }, 5).map((o) => [o.id, o.text]), [['A', ''], ['B', '']], 'a label used as id is not repeated');
const article = { optionDefinitions: { options: [{ id: 'A', label: 'a' }, { id: 'B', label: 'an' }, { id: 'C', label: 'some' }, { id: 'D', label: 'the' }] } };
assert.deepEqual(m.iigOptions(article, 5).map((o) => o.text), ['a', 'an', 'some', 'the'], 'a one-letter answer ("a") is not the letter echo');
const realP1 = { optionDefinitions: { questionNumber: 1, options: [{ id: 'A', text: 'A' }, { id: 'B', text: 'B' }, { id: 'C', text: 'C' }, { id: 'D', text: 'D' }] } };
assert.deepEqual(m.iigOptions(realP1, 1).map((o) => o.letter + o.text), ['A', 'B', 'C', 'D']);

// ── Answers / tiles ────────────────────────────────────────────────────────────────────────────────────────────
assert.equal(m.iigAnswered({ value: 'A' }), true);
assert.equal(m.iigAnswered({ value: '' }), false);
assert.equal(m.iigAnswered(null), false);
assert.equal(m.iigSelected({ value: 'C' }), 'C');
assert.equal(m.iigSelected('B'), 'B');
assert.equal(m.iigTileStatus(true, false), 'answered');
assert.equal(m.iigTileStatus(false, false), 'unanswered');
assert.equal(m.iigTileStatus(true, true), 'marked');
const resp = { p101: { value: 'A' }, p131: { value: 'B' } };
const all = m.iigTileParts(entries, resp, new Set(['p131']), false);
assert.deepEqual(all.map((p) => p.partNumber), [5, 6, 7]);
assert.equal(all[0].tiles[0].status, 'answered');
assert.equal(all[1].tiles[0].status, 'marked');
const attention = m.iigTileParts(entries, resp, new Set(['p131']), true);
assert.ok(attention.every((p) => p.tiles.every((t) => t.status !== 'answered')), 'the warning omits answered-unmarked items');
assert.equal(attention[0].tiles[0].number, 102);
assert.deepEqual(m.iigCounts(entries, resp, ['p131']), { answered: 2, unanswered: 8, marked: 1, total: 10 });
assert.equal(m.iigSubmitMessage(3, 0).message, 'You have unanswered questions. Submit anyway?');
assert.equal(m.iigSubmitMessage(0, 2).heading, 'NOTIFICATION');
assert.equal(m.iigSubmitMessage(0, 0).heading, 'SUBMIT');

// ── Wiring / containment ───────────────────────────────────────────────────────────────────────────────────────
const shell = read('src', 'components', 'features', 'exams', 'ExamRuntimeShell.tsx');
assert.ok(/const iigSkill = isToeic && !legacyUi && \(skill === 'LISTENING' \|\| skill === 'READING'\)/.test(shell), 'only TOEIC Listening / Reading use the room');
assert.ok(shell.indexOf('const iigSkill') > Math.max(shell.lastIndexOf('useCallback('), shell.lastIndexOf('useEffect('), shell.lastIndexOf('useMemo('), shell.lastIndexOf('useState(')), 'the branch sits after every hook');
assert.ok(/onAnswer=\{handleAnswerChange\}/.test(shell.slice(shell.indexOf('<ToeicIigShell'))), 'answers go through the runtime handler');
assert.ok(/onToggleFlag=\{toggleFlag\}/.test(shell.slice(shell.indexOf('<ToeicIigShell'))), 'marks go through the runtime flag save');
assert.ok(/onExit=\{isSimulation \? undefined/.test(shell), 'no exit control inside a simulation (Echo Sentinel owns leaving)');
assert.ok(/saved\.flagged === true\) marks\.add\(pid\)/.test(shell), 'marks are restored from the saved responses after a reload');
const room = read('src', 'components', 'features', 'exams', 'toeic-iig', 'ToeicIigShell.tsx');
const hook = read('src', 'components', 'features', 'exams', 'toeic-iig', 'useToeicListeningAudio.ts');
const css = read('src', 'components', 'features', 'exams', 'toeic-iig', 'toeicIig.module.css');
for (const [name, text] of [['room', room], ['hook', hook]]) {
  assert.ok(!/\bfetch\(|axios|apiClient|saveResponses|submitAttempt|completeSection\(/.test(text), `${name}: no own network / runtime path`);
  assert.ok(!/Sparkles|✨/.test(text), `${name}: no sparkle`);
}
assert.ok(/createPlaybackGrant/.test(hook), 'audio uses the attempt playback grant');
assert.ok(!/currentTime\s*=\s*0\b|playbackRate|fastSeek/.test(hook), 'no rewind / speed / seek path');
assert.ok(/if \(isSimulation\) return;/.test(hook), 'pause is a practice-only action');
assert.ok(/const submitEnabled = !isSimulation \|\| skill === 'READING' \|\| \(isLastSection && audio\.phase === 'ended'\)/.test(room), 'Submit never ends Listening early in a simulation');
assert.ok(/skill === 'READING' && screen && \(\s*<footer/.test(room), 'the navigation footer exists in Reading only');
assert.ok(!/backdrop-filter|linear-gradient|radial-gradient/.test(css), 'no blur / gradient in the room');
const preview = read('src', 'app', 'toeic-iig-preview', 'page.tsx');
assert.ok(/if \(process\.env\.NODE_ENV === 'production'\) notFound\(\);/.test(preview), 'the preview is development-only');
const sample = read('src', 'lib', 'exams', 'toeicIigSample.ts');
assert.ok(/self-authored/i.test(sample) && /Never imported into the exam bank/.test(sample));
assert.ok(!/toeicIigSample/.test(shell + room), 'the sample never reaches the runtime');
const coach = read('src', 'components', 'features', 'coach', 'CoachWidget.tsx');
assert.ok(coach.includes("pathname.startsWith('/toeic-iig-preview')"), 'companion stays out of the preview room');

console.log('toeic iig room: OK');
