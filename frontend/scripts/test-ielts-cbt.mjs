/**
 * IELTS CBT exam room (2026-11-13) — contract test.
 *  1. Executes the REAL pure model src/lib/exams/ieltsCbt.ts (types stripped): splitter limits, word counter (raw
 *     evidence cases), footer buttons incl. the grouped "18–19" choose-TWO button, banner copy from data only, timer copy,
 *     highlight anchors (merge, multi-block, delete, segments, storage round trip), options without invention.
 *  2. Wiring / containment: only IELTS Reading / Listening / Writing use the room, TOEIC and Speaking keep their
 *     workspaces, the room calls the runtime's callbacks (no own network path), no invented TRUE/FALSE options, no
 *     sparkle icon, the preview is development-only, the Echo companion stays out of the exam room.
 * Run: node scripts/test-ielts-cbt.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const fe = path.join(here, '..');
const read = (...p) => fs.readFileSync(path.join(fe, ...p), 'utf8').split('\r\n').join('\n');

const js = stripTypeScriptTypes(read('src', 'lib', 'exams', 'ieltsCbt.ts')).replace(/^export /gm, '');
const names = [
  'CBT_SPLIT_MIN', 'CBT_SPLIT_MAX', 'CBT_SPLIT_DEFAULT', 'clampSplit', 'splitFromPointer', 'cbtAnswered', 'cbtText', 'cbtChoice',
  'cbtWordCount', 'cbtOptions', 'cbtOptionText', 'isClosedTruthSet', 'cbtPrompt', 'numberLabel', 'buildCbtParts', 'partIndexOf',
  'flatButtons', 'bannerInstruction', 'groupHeading', 'timerLabel', 'addHighlight', 'removeHighlight', 'setNote', 'segmentText',
  'annotationStorageKey', 'parseAnnotations', 'serializeAnnotations', 'reviewPartLine',
];
const m = new Function(`${js}\nreturn { ${names.join(', ')} };`)();

// ── Splitter [MEASURED 20 % – 80 %] ────────────────────────────────────────────────────────────────────────────
assert.equal(m.CBT_SPLIT_MIN, 20);
assert.equal(m.CBT_SPLIT_MAX, 80);
assert.equal(m.CBT_SPLIT_DEFAULT, 50);
assert.equal(m.clampSplit(5), 20);
assert.equal(m.clampSplit(95), 80);
assert.equal(m.clampSplit(NaN), 50);
assert.equal(m.splitFromPointer(720, 0, 1440), 50);
assert.equal(m.splitFromPointer(0, 0, 1440), 20);
assert.equal(m.splitFromPointer(1440, 0, 1440), 80);

// ── Word counter: raw evidence (writing-editor-info.json) ──────────────────────────────────────────────────────
assert.equal(m.cbtWordCount('Hello world'), 2);
assert.equal(m.cbtWordCount('Hello world, this is a test.'), 6);
assert.equal(m.cbtWordCount('One  two   three'), 3);
assert.equal(m.cbtWordCount('Hyphenated-word test'), 2);
assert.equal(m.cbtWordCount('Line1\n\nLine2\nLine3'), 3);
assert.equal(m.cbtWordCount('   '), 0);
assert.equal(m.cbtWordCount(null), 0);
assert.equal(m.cbtWordCount('The quick brown fox jumps over the lazy dog.'), 9);

// ── Answers ─────────────────────────────────────────────────────────────────────────────────────────────────────
assert.equal(m.cbtAnswered(''), false);
assert.equal(m.cbtAnswered('  '), false);
assert.equal(m.cbtAnswered('A'), true);
assert.equal(m.cbtAnswered({ flagged: true }), false, 'a flag is not an answer');
assert.equal(m.cbtAnswered({ value: 'B' }), true);
assert.equal(m.cbtAnswered(['', 'C']), true);
assert.equal(m.cbtChoice({ choiceId: 'TRUE' }), 'TRUE');
assert.equal(m.cbtText({ textResponse: 'river' }), 'river');

// ── Options: canonical only, never invented ─────────────────────────────────────────────────────────────────────
assert.deepEqual(m.cbtOptions({ optionDefinitions: { questionNumber: 4 } }), [], 'no options ⇒ none invented');
assert.deepEqual(m.cbtOptions({ optionDefinitions: { options: [{ id: 'A', text: 'A. ports' }] } }).map(m.cbtOptionText), ['ports']);
assert.equal(m.isClosedTruthSet(m.cbtOptions({ options: [{ id: 'TRUE' }, { id: 'FALSE' }, { id: 'NOT GIVEN' }] })), true);
assert.equal(m.isClosedTruthSet(m.cbtOptions({ options: [{ id: 'A', text: 'YES' }, { id: 'B', text: 'NO' }, { id: 'C', text: 'NOT GIVEN' }] })), true);
assert.equal(m.isClosedTruthSet(m.cbtOptions({ options: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] })), false);
assert.equal(m.cbtPrompt('Question 3: The museum opened'), 'The museum opened');

// ── Footer model: printed numbers, grouped choose-TWO button, counts ────────────────────────────────────────────
const it = (pid, n) => ({ placementId: pid, optionDefinitions: { questionNumber: n } });
const parts = [
  { id: 'p1', partCode: 'READING_PASSAGE_1', groups: [{ id: 'g1', items: [it('a', 1), it('b', 2)] }] },
  {
    id: 'p2',
    partCode: 'READING_PASSAGE_2',
    groups: [
      { id: 'g2', items: [it('c', 17)] },
      { id: 'g3', items: [it('d', 18), it('e', 19)], presentation: { selection: { count: 2, questions: [18, 19] } } },
      { id: 'g4', items: [it('f', 20)] },
    ],
  },
];
const numbers = new Map([['a', 1], ['b', 2], ['c', 17], ['d', 18], ['e', 19], ['f', 20]]);
let model = m.buildCbtParts(parts, numbers, { a: 'TRUE', d: 'A' });
assert.equal(model.length, 2);
assert.equal(model[0].number, 1);
assert.deepEqual(model[0].buttons.map((b) => b.label), ['1', '2']);
assert.deepEqual(model[1].buttons.map((b) => b.label), ['17', '18–19', '20'], 'a choose-TWO pair is ONE footer button');
assert.equal(model[1].buttons[1].attempted, false, 'green only when both members are answered');
assert.equal(model[1].total, 4, '"0 of n" counts questions, a pair counts two');
assert.equal(model[0].attempted, 1);
model = m.buildCbtParts(parts, numbers, { d: 'A', e: 'C' });
assert.equal(model[1].buttons[1].attempted, true);
assert.equal(model[1].attempted, 2);
assert.equal(m.partIndexOf(model, 'e'), 1);
assert.equal(m.flatButtons(model).length, 5);
assert.equal(m.reviewPartLine(model[1]), 'Part 2. 2 of 4 questions attempted.');

// ── Banner copy: fixed interface wording + data numbers only ────────────────────────────────────────────────────
assert.equal(m.bannerInstruction('READING', { firstNumber: 1, lastNumber: 13 }), 'Read the text and answer questions 1–13.');
assert.equal(m.bannerInstruction('LISTENING', { firstNumber: 1, lastNumber: 10 }), 'Listen and answer questions 1–10.');
assert.equal(
  m.bannerInstruction('WRITING', { firstNumber: 1, lastNumber: 1 }, { recommendedMinutes: 20, minimumWords: 150 }),
  'You should spend about 20 minutes on this task. Write at least 150 words.'
);
assert.equal(m.bannerInstruction('WRITING', { firstNumber: 1, lastNumber: 1 }, { minimumWords: 250 }), 'Write at least 250 words.', 'no invented minutes');
assert.equal(m.bannerInstruction('WRITING', { firstNumber: 1, lastNumber: 1 }, {}), '', 'nothing invented');
assert.equal(m.bannerInstruction('READING', { firstNumber: null, lastNumber: null }), '');
assert.equal(m.groupHeading([1, 2, 3, 4, 5, 6]), 'Questions 1–6');
assert.equal(m.groupHeading([7]), 'Question 7');
assert.equal(m.groupHeading([18, 19], '18-19'), 'Questions 18–19');

// ── Timer copy ──────────────────────────────────────────────────────────────────────────────────────────────────
assert.equal(m.timerLabel(3599), '59 minutes remaining');
assert.equal(m.timerLabel(60), '1 minute remaining');
assert.equal(m.timerLabel(45), '45 seconds remaining');
assert.equal(m.timerLabel(-5), '0 seconds remaining');

// ── Highlights: offsets per block, merge, multi-block, notes, segments, storage ─────────────────────────────────
let hl = m.addHighlight([], [{ block: 's1:0', start: 0, end: 10 }], { id: 'h1', note: null });
hl = m.addHighlight(hl, [{ block: 's1:0', start: 5, end: 20 }], { id: 'h2', note: null });
assert.equal(hl.length, 1, 'overlapping plain highlights merge');
assert.deepEqual([hl[0].start, hl[0].end], [0, 20]);
hl = m.addHighlight(hl, [{ block: 's1:1', start: 2, end: 6 }, { block: 's1:2', start: 0, end: 4 }], { id: 'h3', note: '' });
assert.deepEqual(hl.map((h) => h.id), ['h2', 'h3:0', 'h3:1'], 'a multi-block note keeps one piece per block');
hl = m.setNote(hl, 'h3:1', 'check paragraph C');
assert.equal(hl.filter((h) => h.note === 'check paragraph C').length, 2, 'the note belongs to every piece');
assert.deepEqual(m.segmentText('Marie Curie is famous', [{ id: 'x', block: 'b', start: 0, end: 11 }]).map((sgm) => [sgm.text, sgm.highlightId]), [
  ['Marie Curie', 'x'],
  [' is famous', null],
]);
assert.equal(m.segmentText('abc', [{ id: 'x', block: 'b', start: 2, end: 99 }]).map((sgm) => sgm.text).join(''), 'abc', 'ranges are clamped');
const restored = m.parseAnnotations(m.serializeAnnotations(hl));
assert.deepEqual(restored, hl, 'annotations survive a reload');
assert.deepEqual(m.parseAnnotations('{broken'), []);
assert.deepEqual(m.parseAnnotations(JSON.stringify({ highlights: [{ id: 'z', block: 'b', start: 4, end: 2 }] })), [], 'invalid ranges dropped');
hl = m.removeHighlight(hl, 'h3:0');
assert.deepEqual(hl.map((h) => h.id), ['h2'], 'deleting removes every piece');
assert.equal(m.annotationStorageKey('att-1'), 'ec_ielts_cbt_annot:v1:att-1');

// ── Wiring / containment ────────────────────────────────────────────────────────────────────────────────────────
const shell = read('src', 'components', 'features', 'exams', 'ExamRuntimeShell.tsx');
assert.match(shell, /const cbtSkill = !isToeic && !legacyUi && \(skill === 'READING' \|\| skill === 'LISTENING' \|\| skill === 'WRITING'\)/, 'only IELTS R / L / W use the room');
assert.match(shell, /<IeltsCbtShell[\s\S]*onAnswer=\{handleAnswerChange\}[\s\S]*onSubmit=\{\(\) => onSubmit\('MANUAL'\)\}/, 'the room uses the runtime callbacks');
assert.match(shell, /<ToeicReadingWorkspace/, 'TOEIC keeps its workspace');
assert.match(shell, /<SpeakingWorkspace/, 'IELTS Speaking keeps its workspace');
const room = read('src', 'components', 'features', 'exams', 'ielts-cbt', 'IeltsCbtShell.tsx');
const group = read('src', 'components', 'features', 'exams', 'ielts-cbt', 'CbtQuestionGroup.tsx');
const passage = read('src', 'components', 'features', 'exams', 'ielts-cbt', 'CbtPassage.tsx');
for (const [name, src] of [['IeltsCbtShell', room], ['CbtQuestionGroup', group], ['CbtPassage', passage]]) {
  assert.doesNotMatch(src, /\bfetch\(|axios|apiClient/, `${name}: no own network path`);
  assert.doesNotMatch(src, /Sparkles|✨/, `${name}: no sparkle`);
  assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML\s*=/, `${name}: no markup sink`);
}
assert.doesNotMatch(group, /id: 'TRUE', label: 'TRUE'/, 'no invented TRUE / FALSE options');
assert.match(group, /The answer options for this question are not available\./, 'missing options are said, not invented');
assert.match(room, /data-testid="instruction-banner"/);
assert.match(room, /role="separator"[\s\S]*aria-valuemin=\{CBT_SPLIT_MIN\}/, 'keyboard-operable splitter');
assert.match(room, /'Leave test'|Leave test/);
assert.doesNotMatch(room, /IELTS<|>IELTS|ielts-logo/i, 'no official IELTS mark in the room');
const audio = read('src', 'components', 'features', 'exams', 'ielts-cbt', 'useCbtListeningAudio.ts');
assert.match(audio, /ec_listening_timeline_\$\{attemptId\}/, 'same timeline keys as the classic player');
assert.match(audio, /if \(isSimulation\) return;/, 'no pause in a simulation');
assert.match(audio, /const storageKey = enabled && attemptId/, 'only a Listening section touches the Listening timeline keys');
assert.match(room, /enabled: skill === 'LISTENING'/);
assert.match(audio, /audio\.currentTime < maxTime\.current - 0\.25/, 'forward-only seek guard');
const preview = read('src', 'app', 'ielts-cbt-preview', 'page.tsx');
assert.match(preview, /if \(process\.env\.NODE_ENV === 'production'\) notFound\(\);/, 'preview is development-only');
const coach = read('src', 'components', 'features', 'coach', 'CoachWidget.tsx');
assert.match(coach, /pathname\.startsWith\('\/exams\/'\) && pathname\.includes\('\/attempts\/'\)/, 'no companion in the exam room');
const css = read('src', 'components', 'features', 'exams', 'ielts-cbt', 'ieltsCbt.module.css');
assert.doesNotMatch(css, /!important/, 'no !important');
assert.doesNotMatch(css, /backdrop-filter|linear-gradient|radial-gradient/, 'no blur, no gradient');
assert.match(css, /--cbt-highlight-bg: #7d4a5a;/, 'highlight colour from the raw evidence');

console.log('IELTS CBT room: pure model, footer grouping, banner copy, highlights and wiring PASS');
