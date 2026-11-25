/**
 * Exams Phase 7 — learner UX contract (frontend side).
 *  1. Executes the REAL pure model src/lib/exams/runnerModel.ts (types stripped): printed numbering (part-scoped practice
 *     keeps 131 / 147 …), answered detection (a flag is not an answer), canonical options only (TOEIC Part 2 keeps three),
 *     navigator / submit counts, mode / save / status / history copy (no raw codes, no practice score, no invented duration).
 *  2. Executes the REAL autosave merge helper (flag + answer of one placement survive together; a flag never wipes the
 *     locally recovered answer).
 *  3. Wiring / containment: one navigator for every objective workspace, printed numbers passed to the workspaces,
 *     TOEIC practice audio has a play control while simulation has no pause, practice audio end never opens the
 *     simulation-only final review, writing minimum words from the item, accessible dialogs / radios, library without
 *     fabricated durations / publisher badges, no source / QA metadata, no Sparkles, no passive AI, history scope field
 *     on both sides.
 * Run: node scripts/check-exams-phase7-ux-contract.mjs (chained from check-exams-containment-contract.mjs).
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stripTypeScriptTypes } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const fe = path.join(here, '..');
const repo = path.join(fe, '..');
const read = (p) => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');
const src = (...p) => read(path.join(fe, 'src', ...p));
const exams = (...p) => src('components', 'features', 'exams', ...p);

// ---- 1. pure runner / UX model -----------------------------------------------------------------------------------------
const modelJs = stripTypeScriptTypes(src('lib', 'exams', 'runnerModel.ts')).replace(/^export /gm, '');
const names = [
  'printedQuestionNumber', 'buildQuestionNumbers', 'numberRange', 'isAnswered', 'itemOptions', 'selectedChoice', 'partNumberOf',
  'toeicPartName', 'partShortLabel', 'buildNavigator', 'summarizeNavigator', 'compactNumberList', 'runnerModeOf', 'modeLabel',
  'saveStatusView', 'formatClock', 'timerTone', 'attemptStatusLabel', 'isResumableStatus', 'isScopedPractice', 'scopeLabelFromCode',
  'historyModeLabel', 'historyScoreText', 'skillList', 'durationText',
];
const m = new Function(`${modelJs}\nreturn { ${names.join(', ')} };`)();

const item = (pid, qn, options) => ({ placementId: pid, optionDefinitions: { ...(qn ? { questionNumber: qn } : {}), ...(options ? { options } : {}) } });

// printed numbers: a TOEIC Part 6 practice starts at its printed 131, never at 101 / 1
const part6 = [{ groups: [{ id: 'g1', items: [item('a', 131), item('b', 132), item('c', 133), item('d', 134)] }] }];
const n6 = m.buildQuestionNumbers(part6, 101);
assert.deepStrictEqual(['a', 'b', 'c', 'd'].map((k) => n6.get(k)), [131, 132, 133, 134], 'printed numbers win');
// legacy payload without printed numbers: TOEIC Reading falls back to 101…
const legacy = [{ groups: [{ id: 'g', items: [item('x'), item('y')] }] }];
assert.deepStrictEqual(['x', 'y'].map((k) => m.buildQuestionNumbers(legacy, 101).get(k)), [101, 102]);
// IELTS Listening Section 2 practice keeps 11–20
const sec2 = [{ groups: [{ id: 'g', items: Array.from({ length: 10 }, (_, i) => item(`s${i}`, 11 + i)) }] }];
assert.strictEqual(m.buildQuestionNumbers(sec2, 1).get('s0'), 11);
assert.strictEqual(m.numberRange([147, 149, 148]), '147–149');

// answered: a flag-only object or an empty value is NOT an answer
assert.strictEqual(m.isAnswered({ flagged: true }), false);
assert.strictEqual(m.isAnswered({ value: '' }), false);
assert.strictEqual(m.isAnswered('  '), false);
assert.strictEqual(m.isAnswered({ value: 'B' }), true);
assert.strictEqual(m.isAnswered('word'), true);
assert.strictEqual(m.isAnswered({ recordingId: 'r1' }), true);
assert.strictEqual(m.isAnswered(['', 'C']), true);

// canonical options only: Part 2 keeps exactly three; nothing invented for an item without options
const p2 = item('p2', 7, [{ id: 'A', text: '' }, { id: 'B', text: '' }, { id: 'C', text: '' }]);
assert.deepStrictEqual(m.itemOptions(p2).map((o) => o.id), ['A', 'B', 'C'], 'TOEIC Part 2 keeps its three printed options');
assert.deepStrictEqual(m.itemOptions({ placementId: 'z', optionDefinitions: { questionNumber: 3 } }), [], 'no placeholder A–D options');
assert.deepStrictEqual(m.itemOptions({ optionDefinitions: { options: [{ id: 'opt-1', label: 'A', text: 'x' }] } })[0].id, 'opt-1', 'stores the option id, not the label');
assert.deepStrictEqual(m.itemOptions({ optionDefinitions: { options: [{ id: 'B', label: 'circulate' }] } }), [{ id: 'B', text: 'circulate' }], 'original pilot label carries the actual option text while the id remains the submitted value');
assert.strictEqual(m.selectedChoice({ value: 'B' }), 'B');
assert.strictEqual(m.selectedChoice({ flagged: true }), '');

// navigator + submit summary
const parts = [
  { id: 'p3', partCode: 'LISTENING_PART_3', groups: [{ id: 'set1', items: [item('q32', 32), item('q33', 33), item('q34', 34)] }] },
  { id: 'p4', partCode: 'LISTENING_PART_4', groups: [{ id: 'set2', items: [item('q71', 71)] }] },
];
const nums = m.buildQuestionNumbers(parts, 1);
const nav = m.buildNavigator({
  family: 'TOEIC', skill: 'LISTENING', parts, numbers: nums,
  responses: { q32: { value: 'A' }, q33: { flagged: true }, q71: '' }, flagged: ['q33'], currentPlacementId: 'q34',
});
assert.deepStrictEqual(nav.map((p) => p.label), ['Part 3', 'Part 4']);
assert.strictEqual(nav[0].groups[0].range, '32–34', 'a set stays one group');
assert.strictEqual(nav[0].groups[0].entries.length, 3);
assert.strictEqual(nav[0].groups[0].entries[2].current, true);
const sum = m.summarizeNavigator(nav);
assert.deepStrictEqual({ total: sum.total, answered: sum.answered, unanswered: sum.unanswered, flagged: sum.flagged }, { total: 4, answered: 1, unanswered: 3, flagged: 1 });
assert.deepStrictEqual(sum.unansweredNumbers, [33, 34, 71]);
assert.strictEqual(m.compactNumberList([3, 5, 6, 7, 9]), '3, 5–7, 9');
assert.strictEqual(m.partShortLabel('IELTS', 'LISTENING', 'LISTENING_PART_2', 0), 'Section 2');
assert.strictEqual(m.partShortLabel('IELTS', 'READING', 'READING_PART_3', 0), 'Passage 3');
assert.strictEqual(m.partShortLabel('IELTS', 'WRITING', 'WRITING_TASK_2', 0), 'Task 2');
assert.strictEqual(m.toeicPartName(5, 'vi'), 'Hoàn thành câu');

// modes are never alike
assert.strictEqual(m.runnerModeOf('EXAM_SIMULATION'), 'SIMULATION');
assert.strictEqual(m.runnerModeOf('PRACTICE'), 'PRACTICE');
assert.notStrictEqual(m.modeLabel('SIMULATION', 'vi'), m.modeLabel('PRACTICE', 'vi', true));
assert.strictEqual(m.modeLabel('PRACTICE', 'vi', true), 'Luyện theo phần');
assert.strictEqual(m.modeLabel('SIMULATION', 'vi'), 'Thi đầy đủ');

// truthful save state: "Đã lưu" only for SAVED
assert.strictEqual(m.saveStatusView('SAVED', 'vi').label, 'Đã lưu');
for (const s of ['SAVING', 'UNSAVED', 'ERROR', 'WHATEVER']) assert.notStrictEqual(m.saveStatusView(s, 'vi').label, 'Đã lưu', `${s} never claims saved`);
assert.strictEqual(m.saveStatusView('ERROR', 'vi').retryable, true);
assert.match(m.saveStatusView('ERROR', 'vi').hint, /giữ trên thiết bị/);

// calm timer
assert.strictEqual(m.formatClock(3725), '1:02:05');
assert.strictEqual(m.formatClock(-5), '00:00');
assert.strictEqual(m.timerTone(1800), 'normal');
assert.strictEqual(m.timerTone(400), 'warning');
assert.strictEqual(m.timerTone(60), 'critical');

// learner copy never shows raw codes
assert.strictEqual(m.attemptStatusLabel('SUBMITTED', 'vi'), 'Đã nộp');
assert.ok(!/[A-Z_]{5,}/.test(m.attemptStatusLabel('SOME_INTERNAL_CODE', 'vi')), 'unknown status ⇒ neutral words');
assert.strictEqual(m.scopeLabelFromCode('TOEIC_PART_5', 'vi'), 'Part 5 · Hoàn thành câu');
assert.strictEqual(m.scopeLabelFromCode('IELTS_LISTENING_SECTION_2', 'vi'), 'Listening · Section 2');
assert.strictEqual(m.scopeLabelFromCode('MEDIA_IMAGE_PENDING', 'vi'), null);
assert.strictEqual(m.isScopedPractice({ mode: 'PRACTICE', scope: 'TOEIC_PART' }), true);
assert.strictEqual(m.historyModeLabel({ mode: 'PRACTICE', scope: 'TOEIC_PART' }, 'vi'), 'Luyện theo phần');

// no standardized number for practice; simulation shows only the stored canonical component
assert.strictEqual(m.historyScoreText({ mode: 'PRACTICE', status: 'SUBMITTED', family: 'TOEIC', score: 650 }, 'vi'), null, 'practice never shows a TOEIC score');
assert.strictEqual(m.historyScoreText({ mode: 'PRACTICE', status: 'SUBMITTED', family: 'IELTS', score: 6.5 }, 'vi'), null, 'practice never shows an IELTS band');
assert.strictEqual(m.historyScoreText({ mode: 'EXAM_SIMULATION', status: 'SUBMITTED', family: 'IELTS', score: 6.5 }, 'vi'), 'Band 6.5');
assert.strictEqual(m.historyScoreText({ mode: 'EXAM_SIMULATION', status: 'IN_PROGRESS', family: 'TOEIC', score: 500 }, 'vi'), null);
assert.strictEqual(m.durationText(0, 'vi'), '', 'no duration is invented when the server has none');
assert.strictEqual(m.durationText(120, 'vi'), '2 giờ');
assert.strictEqual(m.skillList(['LISTENING', 'READING', 'BOGUS', 'LISTENING']), 'Listening · Reading');

// ---- 2. autosave merge (real helper) -------------------------------------------------------------------------------------
const hook = src('hooks', 'useExamAutosave.ts');
const sliceFn = (name) => {
  const start = hook.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} missing in useExamAutosave.ts`);
  const end = hook.indexOf('\n}\n', start);
  return hook.slice(start, end + 3).replace(/^export /, '');
};
const mergeJs = stripTypeScriptTypes([sliceFn('mergePendingItem'), sliceFn('carriesAnswer')].join('\n'));
const a = new Function(`${mergeJs}\nreturn { mergePendingItem, carriesAnswer };`)();
const answered = { placementId: 'p', answerPayload: { value: 'B' } };
const flagged = { placementId: 'p', flagged: true };
assert.deepStrictEqual(a.mergePendingItem(answered, flagged), { placementId: 'p', answerPayload: { value: 'B' }, flagged: true }, 'flag keeps the pending answer');
assert.deepStrictEqual(a.mergePendingItem(flagged, { placementId: 'p', answerPayload: { value: 'C' } }).flagged, true, 'answer keeps the pending flag');
assert.strictEqual(a.carriesAnswer(flagged), false, 'a flag-only toggle carries no answer');
assert.strictEqual(a.carriesAnswer(answered), true);
assert.ok(hook.includes('if (carriesAnswer(item)) {'), 'flag-only toggles never overwrite the local recovery copy');
assert.ok(hook.includes("lastFailureRef.current !== 'REJECTED'"), 'only network / server failures retry automatically');
assert.ok(hook.includes('retry: flushBatch'), 'explicit retry exposed');

// ---- 3. wiring / containment ---------------------------------------------------------------------------------------------
const shell = exams('ExamRuntimeShell.tsx');
assert.ok(shell.includes('<ExamNavigator') && shell.includes('{isObjectiveSkill && allSectionItems.length > 0 && ('), 'one navigator for IELTS and TOEIC');
assert.ok(!shell.includes("!isToeic && paletteItems"), 'no IELTS-only palette');
// 5 since 2026-11-13: the 4 classic objective workspaces + the IELTS CBT room (Reading / Listening / Writing).
assert.strictEqual((shell.match(/questionNumbers=\{questionNumbers\}/g) || []).length, 6, 'printed numbers reach every objective workspace, the IELTS CBT room and the TOEIC IIG room');
assert.ok(shell.includes('onRetrySave={onRetrySave}'), 'save retry reaches the header');
assert.ok(shell.includes('h-[100dvh]'), 'runner uses the dynamic viewport (no mobile height trap)');
const attemptPage = src('app', 'exams', '[family]', 'attempts', '[attemptId]', 'page.tsx');
assert.ok(attemptPage.includes('onRetrySave={retrySave}') && attemptPage.includes('mode={attemptState.mode}'), 'attempt page wires retry + mode-aware preflight');

for (const f of ['ToeicReadingWorkspace.tsx', 'ToeicListeningWorkspace.tsx']) {
  const s = exams(f);
  assert.ok(!/\['A', 'B', 'C', 'D'\]/.test(s) && !/\['A', 'B', 'C'\]/.test(s), `${f}: options never hard-coded`);
  assert.ok(!/label: 'A', text: ''/.test(s), `${f}: no blank placeholder options`);
  assert.ok(s.includes('itemOptions('), `${f}: options from the canonical item`);
  assert.ok(!/of 100|of 200|Official/.test(s), `${f}: no fixed full-test numbering or "Official" claims`);
  assert.ok(s.includes('questionNumbers?.get(item.placementId)'), `${f}: printed numbers`);
  assert.ok(s.includes('presentParts'), `${f}: only the parts present in the attempt are shown`);
}
const toeicL = exams('ToeicListeningWorkspace.tsx');
assert.ok(toeicL.includes('id="toeic-practice-play-btn"'), 'TOEIC practice can play / pause the recording');
assert.ok(toeicL.includes('if (isSimulation) return; // simulation: no pause'), 'simulation keeps no-pause');
assert.ok(toeicL.includes('lettersOnly'), 'Part 1 / 2 print letters only (no invented option text)');
assert.ok(!/\.currentTime\s*=(?!=)/.test(toeicL) && (toeicL.match(/type="range"/g) || []).length === 1, 'no seek control / replay added in practice (only the volume slider)');
const toeicR = exams('ToeicReadingWorkspace.tsx');
assert.ok(toeicR.includes("mobilePane === 'DOC'") && toeicR.includes('<StimulusRenderer stimuli={currentGroup.stimuli}'), 'Part 6/7 keep documents with their set + phone pane switch');
const listening = exams('ListeningPlayer.tsx');
assert.ok(listening.includes('if (partIdx >= activeParts.length && !isSimulation) {'), 'practice audio end never opens the 2-minute final review');
assert.ok(listening.includes('if (!isSimulation || isFinalReview || hasUnlockedAudioRef.current) return;'), 'practice never auto-starts audio on any click');
const writing = exams('WritingEditor.tsx');
assert.ok(!/\b150\b|\b250\b/.test(writing), 'writing minimum words are never hard-coded');
assert.ok(writing.includes("numberField(defs, 'minimumWords')"), 'minimum words from the canonical item');
assert.ok(writing.includes('aria-expanded={promptOpen}'), 'phone prompt collapses and restores');
assert.ok(writing.includes('không chấm điểm'), 'practice writing honestly NOT_SCORED');

const dialog = exams('runner', 'ExamDialog.tsx');
assert.ok(dialog.includes('role="dialog"') && dialog.includes('aria-modal="true"') && dialog.includes("e.key === 'Escape' && !busy"), 'accessible dialog, not dismissible while busy');
const submit = exams('runner', 'ExamSubmitDialog.tsx');
assert.ok(submit.includes('summary.unanswered') && submit.includes('disabled={submitting || blocked}'), 'submit shows unanswered + guards duplicates');
const choice = exams('runner', 'ChoiceOptions.tsx');
assert.ok(choice.includes('type="radio"') && choice.includes('role="radiogroup"'), 'semantic radio choices');
const navigator = exams('runner', 'ExamNavigator.tsx');
assert.ok(navigator.includes('entryAriaLabel') && navigator.includes('border-dashed') && navigator.includes('<Flag'), 'state never colour-only');
assert.ok(navigator.includes('placement="sheet"'), 'phone navigator is a bottom sheet');
const header = exams('runner', 'ExamRunnerHeader.tsx');
assert.ok(header.includes("isSim ? 'border-t-indigo-500' : 'border-t-emerald-500'"), 'simulation / practice chrome visibly different');

const library = exams('ExamLibrary.tsx');
for (const banned of ['classifySource', 'REAL CORPUS', 'computeTruthfulDuration', 'computeTruthfulItemCount', 'publisher', 'ETS Official', 'Cambridge Authentic']) {
  assert.ok(!library.includes(banned), `library: no ${banned}`);
}
assert.ok(library.includes('const facts = sim'), 'question count / duration only for a server-validated full simulation');

// learner UI never shows source / QA / readiness internals, never Sparkles, never passive AI
const learnerFiles = [
  'ExamsHome.tsx', 'ExamsFamilyPage.tsx', 'ExamLibrary.tsx', 'ExamFormDetail.tsx', 'SimulationStartDialog.tsx', 'PracticeScopePicker.tsx',
  'PracticeResultReview.tsx', 'ExamAttemptList.tsx', 'ExamRuntimeShell.tsx', 'ExamPreflight.tsx', 'ToeicReadingWorkspace.tsx',
  'ToeicListeningWorkspace.tsx', 'ReadingWorkspace.tsx', 'ListeningPlayer.tsx', 'WritingEditor.tsx',
  'runner/ExamRunnerHeader.tsx', 'runner/ExamNavigator.tsx', 'runner/ExamSubmitDialog.tsx', 'runner/ChoiceOptions.tsx',
];
for (const f of learnerFiles) {
  const s = exams(...f.split('/'));
  assert.ok(!s.includes('Sparkles') && !s.includes('✨'), `${f}: forbidden Sparkles`);
  for (const internal of ['reasonCodes', 'sourceProvenance', 'sourceIdentity', 'sha256', 'IMPORT_READY', 'READY_EXCEPT_HUMAN_QA', 'keySource', 'acceptedAnswers', 'validationStatus}']) {
    assert.ok(!s.includes(internal), `${f}: learner UI must not surface ${internal}`);
  }
  assert.ok(!/\/ai\/|explainContext|ExamAiClient|openrouter/i.test(s), `${f}: no AI call in the exam UX`);
}
const review = exams('PracticeResultReview.tsx');
assert.ok(review.includes('it.explanationAvailable && it.explanation &&'), 'no empty explanation card');
assert.ok(review.includes("code === 'PRACTICE_SOURCE_UNAVAILABLE'"), 'Practice Again source-unavailable message');
assert.ok(review.includes('kết quả này vẫn được giữ nguyên'), 'Practice Again never implies the old attempt is reset');
const reviewCode = review.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
assert.ok(!/transcript/i.test(reviewCode), 'review never reads or shows a listening transcript');
for (const dir of [['components', 'features', 'exams'], ['app', 'exams']]) {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const file of walk(path.join(fe, 'src', ...dir)).filter((f) => /\.tsx?$/.test(f))) {
    const s = read(file);
    assert.ok(!/<Sparkles|from 'lucide-react'[^;]*Sparkles|✨/.test(s) && !/\bSparkles,/.test(s), `${path.relative(fe, file)}: Sparkles`);
  }
}

// history scope field on both sides (EXAMS_OWNED additive contract)
const types = src('types', 'exams.ts');
assert.ok(types.includes('practiceScopeCode?: string | null;'), 'TS history carries practiceScopeCode');
const javaRecords = read(path.join(repo, 'backend', 'src', 'main', 'java', 'com', 'englishcoach', 'exams', 'model', 'ExamProfileRecords.java'));
assert.ok(javaRecords.includes('String practiceScopeCode'), 'Java history record carries practiceScopeCode');
const javaRepo = read(path.join(repo, 'backend', 'src', 'main', 'java', 'com', 'englishcoach', 'exams', 'repository', 'ExamAttemptRepository.java'));
assert.ok(javaRepo.includes("CASE WHEN a.attempt_mode = 'PRACTICE' THEN a.client_session_meta ->> 'practiceScopeCode' END"), 'history SQL reads the pinned scope code for practice only');
assert.ok(javaRepo.includes('WHERE a.user_id = :userId'), 'history stays owner-scoped');

console.log('[EXAMS-PHASE7] learner UX contract OK');
