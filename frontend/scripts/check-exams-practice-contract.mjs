/**
 * Exams Phase 6 — Practice + Review contract (frontend side).
 *  1. Executes the REAL pure helpers of src/lib/exams/practice.ts (types stripped): scope labels, learner availability
 *     (never a technical code), start gating, raw score line (never a TOEIC scale / IELTS band), answer formatting.
 *  2. Executes the REAL src/lib/exams/examDraftStorage.ts against a fake localStorage: drafts are attempt-scoped and a
 *     draft written by another attempt of the same form is never restored (stale-draft contamination).
 *  3. Wiring: untimed practice runtime (no countdown, edits allowed, audio end never completes the section), practice
 *     result routing, API sends only form id + scope code (never item ids), start control only for AVAILABLE scopes,
 *     LABEL_ASSIGNMENT accessible select + group figure, declared capability SUPPORTED on both sides, no Sparkles.
 * Run: node scripts/check-exams-practice-contract.mjs (chained from check-exams-containment-contract.mjs).
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
const examsDir = ['components', 'features', 'exams'];

// ---- 1. pure practice helpers ----------------------------------------------------------------------------------------
const practiceJs = stripTypeScriptTypes(src('lib', 'exams', 'practice.ts')).replace(/^export /gm, '');
const names = ['practiceScopeLabel', 'practiceScopeHint', 'practiceAvailabilityLabel', 'canStartPractice', 'reviewStatusLabel',
  'rawScoreLine', 'formatAnswer', 'formatDuration', 'practiceResultPath', 'isPracticeScopeAttempt'];
const p = new Function(`${practiceJs}\nreturn { ${names.join(', ')} };`)();

assert.strictEqual(p.practiceScopeLabel({ scopeType: 'TOEIC_PART', number: 5 }, 'vi'), 'TOEIC Part 5');
// Exams Phase 7: official exam terms (Section / Passage / Task) in both languages.
assert.strictEqual(p.practiceScopeLabel({ scopeType: 'IELTS_LISTENING_SECTION', number: 2 }, 'vi'), 'IELTS Listening – Section 2');
assert.strictEqual(p.practiceScopeLabel({ scopeType: 'IELTS_READING_PASSAGE', number: 1 }, 'en'), 'IELTS Reading – Passage 1');
assert.strictEqual(p.practiceScopeLabel({ scopeType: 'IELTS_WRITING_TASK', number: 1 }, 'vi'), 'IELTS Writing – Task 1');
assert.match(p.practiceScopeHint({ scopeType: 'TOEIC_PART', number: 7 }, 'vi'), /ba văn bản/);
assert.strictEqual(p.practiceAvailabilityLabel('AVAILABLE', 'vi'), 'Có thể luyện');
assert.strictEqual(p.practiceAvailabilityLabel('CONTENT_IN_PROGRESS', 'vi'), 'Đang hoàn thiện nội dung');
assert.strictEqual(p.practiceAvailabilityLabel('UNAVAILABLE', 'vi'), 'Chưa khả dụng');
assert.strictEqual(p.practiceAvailabilityLabel('MEDIA_IMAGE_PENDING', 'vi'), 'Chưa khả dụng', 'a technical code never reaches the learner');
assert.strictEqual(p.canStartPractice('AVAILABLE'), true);
for (const s of ['CONTENT_IN_PROGRESS', 'UNAVAILABLE', undefined, '']) assert.strictEqual(p.canStartPractice(s), false, `no dead control for ${s}`);
assert.strictEqual(p.reviewStatusLabel('UNANSWERED', 'vi'), 'Chưa trả lời');
assert.strictEqual(p.reviewStatusLabel('NOT_SCORED', 'vi'), 'Không chấm điểm');
const line = p.rawScoreLine(18, 30, 60, 'vi');
assert.strictEqual(line, '18 / 30 câu đúng · 60%');
assert.ok(!/band|495|990|scaled|quy đổi/i.test(line), 'raw metrics only');
assert.strictEqual(p.rawScoreLine(undefined, 30, 60, 'vi'), '');
assert.strictEqual(p.formatAnswer({ value: 'B' }), 'B');
assert.strictEqual(p.formatAnswer(['A', '', 'D']), 'A, D');
assert.strictEqual(p.formatDuration(125, 'vi'), '2 phút 5 giây');
assert.strictEqual(p.practiceResultPath('TOEIC', 'abc'), '/exams/toeic/practice/result/abc');
assert.strictEqual(p.isPracticeScopeAttempt({ mode: 'PRACTICE', scope: 'TOEIC_PART' }), true);
assert.strictEqual(p.isPracticeScopeAttempt({ mode: 'PRACTICE', scope: 'LR' }), false, 'whole-skill practice keeps the old result page');
assert.strictEqual(p.isPracticeScopeAttempt({ mode: 'EXAM_SIMULATION', scope: 'TOEIC_PART' }), false);

// ---- 2. attempt-scoped drafts (real module, fake localStorage) -----------------------------------------------------------
const store = new Map();
const fakeStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = { localStorage: fakeStorage };
globalThis.localStorage = fakeStorage;
const draftJs = stripTypeScriptTypes(src('lib', 'exams', 'examDraftStorage.ts')).replace(/^export /gm, '');
const d = new Function(`${draftJs}\nreturn { getExamDraftKeys, saveExamDraftImmediate, loadExamDraft, clearExamDraft, draftBelongsToAttempt };`)();

d.saveExamDraftImmediate('FORM', 'u1', { responses: { p1: 'A' } }, 'ATTEMPT_1');
assert.ok(store.has('exam_draft_ATTEMPT_1_u1'), 'written under the attempt key');
assert.ok(!store.has('exam_draft_FORM_u1'), 'never written under the form key any more');
assert.deepStrictEqual(d.loadExamDraft('FORM', 'u1', 'ATTEMPT_1').responses, { p1: 'A' });
assert.strictEqual(d.loadExamDraft('FORM', 'u1', 'ATTEMPT_2'), null, 'Practice Again / a new attempt never sees the old draft');
// a legacy form-keyed draft (pre-Phase 6) is honoured only for the attempt that wrote it
store.set('exam_draft_FORM_u1', JSON.stringify({ examId: 'FORM', attemptId: 'OLD', userId: 'u1', responses: { p9: 'C' }, remainingSeconds: 50 }));
assert.strictEqual(d.loadExamDraft('FORM', 'u1', 'ATTEMPT_3'), null, 'stale legacy draft of another attempt ignored');
assert.deepStrictEqual(d.loadExamDraft('FORM', 'u1', 'OLD').responses, { p9: 'C' });
d.clearExamDraft('FORM', 'u1', 'ATTEMPT_3');
assert.ok(store.has('exam_draft_FORM_u1'), 'clearing one attempt never deletes another attempt\'s draft');
d.clearExamDraft('FORM', 'u1', 'OLD');
assert.ok(!store.has('exam_draft_FORM_u1'));
d.clearExamDraft('FORM', 'u1', 'ATTEMPT_1');
assert.ok(!store.has('exam_draft_ATTEMPT_1_u1'));
assert.strictEqual(d.draftBelongsToAttempt({ attemptId: 'X' }, 'Y'), false);

// ---- 3. wiring ------------------------------------------------------------------------------------------------------
const shell = src(...examsDir, 'ExamRuntimeShell.tsx');
assert.ok(/const isUntimed =/.test(shell), 'runtime knows untimed practice');
assert.ok(shell.includes("practiceScope?.timingMode === 'UNTIMED'"), 'untimed comes from the server-pinned scope');
assert.ok(shell.includes('if (!isUntimed && remainingSeconds <= 0)'), 'untimed answers stay editable (no 00:00 lock)');
const header = src(...examsDir, 'runner', 'ExamRunnerHeader.tsx');
assert.ok(header.includes('id="exam-header-untimed"') && shell.includes('isUntimed={isUntimed}'), 'no fake countdown for untimed practice');
// 4 call sites since 2026-11-16: TOEIC + classic IELTS players, the IELTS CBT room and the TOEIC IIG room — every one gated by isSimulation.
assert.strictEqual((shell.match(/onCompleteListening=\{isSimulation \? \(\) => \{/g) || []).length, 4,
  'audio end / final review may complete a section only in simulation (Phase 4 onEnded bug re-tested)');
assert.strictEqual((shell.match(/onCompleteListening=/g) || []).length, 4, 'no ungated listening completion');
const attemptPage = src('app', 'exams', '[family]', 'attempts', '[attemptId]', 'page.tsx');
assert.ok(attemptPage.includes('manifest?.practiceScope ? practiceResultPath(rawFamily, attemptId)'), 'practice ⇒ practice result page');
const api = src('services', 'examsApi.ts');
assert.ok(api.includes("apiClient.post('/exams/practice/attempts', { formId, scopeCode, clientMutationId: cmdId })"),
  'create sends only form id + scope code');
assert.ok(!/practice\/attempts'[^)]*itemIds/.test(api), 'never a list of item ids');
for (const m of ['getPracticeScopes', 'createPracticeAttempt', 'practiceAgain', 'getPracticeResult', 'getPracticeReview']) {
  assert.ok(api.includes(`async ${m}(`), `examsApi.${m}`);
}
const picker = src(...examsDir, 'PracticeScopePicker.tsx');
assert.ok(picker.includes("['LISTENING', 'READING', 'WRITING', 'SPEAKING']"), 'scope picker includes all IELTS skills');
assert.ok(picker.includes("case 'IELTS_SPEAKING_PART':") && picker.includes('return `Part ${scope.number}`;'), 'Speaking Parts have numbered start controls');
assert.ok(picker.includes("family === 'IELTS' || ['LISTENING', 'READING'].includes(s.skill)"), 'TOEIC picker remains Listening/Reading only');
assert.ok(picker.includes('{available && session && ('), 'start control only for an AVAILABLE scope');
assert.ok(picker.includes('practiceAvailabilityLabel(scope.availability, lang)'));
assert.ok(!picker.includes('reasonCodes'), 'learner UI never reads reason codes');
const resultView = src(...examsDir, 'PracticeResultReview.tsx');
assert.ok(!/overallScore|skillScores|scaledScore|\bband\b/i.test(resultView.replace(/band IELTS|IELTS band/gi, '')),
  'practice result shows raw metrics only');
assert.ok(resultView.includes('examsApi.practiceAgain(attemptId)'));
assert.ok(resultView.includes("if (r.reviewAvailable)"), 'review requested only when the server allows it');
const types = src('types', 'exams.ts');
assert.ok(types.includes('standardizedScoreAvailable: false;'), 'type pins: no standardized score for practice');
assert.ok(types.includes('practiceScope?: PracticeScopeSummary | null;'));
const renderers = src(...examsDir, 'QuestionRenderers.tsx');
assert.ok(renderers.includes("if (type === 'LABEL_ASSIGNMENT')") && renderers.includes('export function LabelAssignmentRenderer'));
const labelFn = renderers.slice(renderers.indexOf('export function LabelAssignmentRenderer'), renderers.indexOf('// ─── Matching Renderer'));
assert.ok(labelFn.includes('<select') && labelFn.includes('htmlFor={selectId}'), 'accessible, labelled native select');
assert.ok(!/draggable|onDrag|DndContext/.test(labelFn), 'drag-and-drop is never required');
const gqb = src(...examsDir, 'GroupQuestionBlock.tsx');
assert.ok(gqb.includes('data-capability="LABEL_ASSIGNMENT_FIGURE"') && gqb.includes('<StimulusRenderer stimuli={figureStimuli} attemptId={attemptId} />'),
  'the figure stays visible next to the targets, via grant');
const caps = src('lib', 'exams', 'runnerCapabilities.ts');
assert.ok(/LABEL_ASSIGNMENT: \{ support: 'SUPPORTED'/.test(caps));
const javaCaps = read(path.join(repo, 'backend', 'src', 'main', 'java', 'com', 'englishcoach', 'exams', 'release', 'ExamRunnerCapabilities.java'));
assert.ok(javaCaps.includes('entry("LABEL_ASSIGNMENT", Support.SUPPORTED)'));
for (const f of ['PracticeScopePicker.tsx', 'PracticeResultReview.tsx']) {
  const s = src(...examsDir, f);
  assert.ok(!s.includes('Sparkles') && !s.includes('✨'), `${f}: forbidden Sparkles`);
}
// Exams Phase 7: history rows (ExamAttemptList) open the practice result page for practice scopes; the library opens the
// test detail page, which embeds the scope picker; the Phase 6 practice route redirects there.
const attemptList = src(...examsDir, 'ExamAttemptList.tsx');
assert.ok(attemptList.includes('isScopedPractice(item) ? practiceResultPath(fam, item.attemptId)'), 'history opens the practice result page for practice scopes');
const library = src(...examsDir, 'ExamLibrary.tsx');
assert.ok(library.includes('/tests/${form.id}'), 'library card opens the test detail page');
const detail = src(...examsDir, 'ExamFormDetail.tsx');
assert.ok(detail.includes('<PracticeScopePicker family={family} formId={formId} embedded'), 'detail page embeds practice by part');
const oldRoute = src('app', 'exams', '[family]', 'practice', '[formId]', 'page.tsx');
assert.ok(oldRoute.includes('redirect(`/exams/${familySlug}/tests/'), 'Phase 6 practice route redirects to the detail page');

console.log('[EXAMS-PHASE6] practice + review contract OK');
