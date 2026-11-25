/**
 * Exams Phase 8 — learner analytics / mistakes / recommended practice + admin operations contract (frontend side).
 *  1. Executes the REAL pure helpers src/lib/exams/analytics.ts (+ practice.ts, types stripped): reason sentences are
 *     built only from server facts, insufficient-data copy claims no weakness, sample size always shown, trends need ≥ 2
 *     points, CTA resumes the same form + scope or starts on click, neutral tone (no judgemental wording).
 *  2. Learner containment: analytics UI renders no standardized score for practice, no band / CEFR / mastery estimate,
 *     no answer key, no admin / readiness / QA codes, no Sparkles, no passive AI; recommendations start only on click and
 *     always offer another scope; the API has no user-id parameter.
 *  3. Admin operations UI (8D): admin-only API base, no force / skip / bypass / override control, QA decisions send the
 *     printed fingerprint and never a reviewer identity, rights shown as separate fields, publication / retirement are
 *     plans only (no publish / retire call from the operations panel).
 * Run: node scripts/check-exams-phase8-analytics-contract.mjs (chained from check-exams-containment-contract.mjs).
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stripTypeScriptTypes } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const fe = path.join(here, '..');
const read = (p) => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');
const src = (...p) => read(path.join(fe, 'src', ...p));
const exams = (...p) => src('components', 'features', 'exams', ...p);
const exists = (...p) => fs.existsSync(path.join(fe, 'src', ...p));

// ---- 1. pure helpers ---------------------------------------------------------------------------------------------------
const strip = (code) => stripTypeScriptTypes(code).replace(/^import .*$/gm, '').replace(/^export /gm, '');
const names = [
  'practiceScopeLabel', 'scopeName', 'signalLabel', 'sampleLine', 'accuracyLine', 'formatPercent', 'shouldShowTrend', 'formatMinutes',
  'reasonText', 'recommendationKindLabel', 'recommendationStatusText', 'recommendationSampleText', 'mistakeStateLabel', 'outcomeMark',
  'interactionTypeLabel', 'componentLabel', 'componentValue', 'simulationStatusLabel', 'recommendationCta', 'weekLabel', 'reviewPath',
  'sparklinePoints',
];
const a = new Function(`${strip(src('lib', 'exams', 'practice.ts'))}\n${strip(src('lib', 'exams', 'analytics.ts'))}\nreturn { ${names.join(', ')} };`)();
const p5 = { scopeType: 'TOEIC_PART', scopeNumber: 5 };
const passage2 = { scopeType: 'IELTS_READING_PASSAGE', scopeNumber: 2 };

assert.strictEqual(a.reasonText('RECENT_MISSES', { incorrect: 8, unanswered: 0, total: 20 }, p5, 'vi'), 'Bạn sai 8/20 câu gần đây ở TOEIC Part 5.');
assert.ok(a.reasonText('RECENT_MISSES', { incorrect: 5, unanswered: 3, total: 20 }, p5, 'vi').includes('bỏ trống 3'));
assert.strictEqual(a.reasonText('MANY_BLANKS', { unanswered: 6, total: 13 }, passage2, 'vi'), 'Bạn bỏ trống 6/13 câu gần đây ở IELTS Reading – Passage 2.');
assert.ok(a.reasonText('REPEATED_MISTAKES', { count: 4 }, p5, 'vi').includes('4 câu'));
assert.ok(a.reasonText('LOWER_THAN_OTHER_SCOPES', { recentAccuracy: 50, otherAccuracy: 72.5 }, p5, 'vi').includes('50% so với 72.5%'));
assert.strictEqual(a.reasonText('SOMETHING_NEW', {}, p5, 'vi'), '', 'unknown reason codes render nothing (never a guess)');
for (const code of ['REPEATED_MISTAKES', 'MANY_BLANKS', 'RECENT_MISSES', 'LOWER_THAN_OTHER_SCOPES', 'IMPROVING', 'NOT_PRACTICED_YET', 'AVAILABLE_TO_START']) {
  for (const lang of ['vi', 'en']) {
    const t = a.reasonText(code, { count: 2, unanswered: 1, incorrect: 1, total: 10, recentAccuracy: 40, otherAccuracy: 60, earlierAccuracy: 20 }, p5, lang);
    assert.ok(t.length > 0, `${code} ${lang}`);
    assert.ok(!/rất yếu|tệ|kém|phải luyện|you must|terrible|very weak|band|TOEIC score|CEFR/i.test(t), `neutral, no estimate: ${t}`);
  }
}
assert.ok(a.recommendationStatusText('INSUFFICIENT_DATA', 'vi').startsWith('Chưa đủ dữ liệu để đề xuất phần cần tập trung.'));
assert.strictEqual(a.recommendationStatusText('PERSONALIZED', 'vi'), null);
assert.strictEqual(a.recommendationSampleText(40, 2, 'vi'), 'Dựa trên 40 câu gần đây · 2 lượt luyện');
assert.strictEqual(a.recommendationSampleText(undefined, undefined, 'vi'), '', 'no fabricated sample for neutral suggestions');
assert.strictEqual(a.sampleLine(43, 4, 'vi'), '43 câu đã làm · 4 lượt luyện');
assert.strictEqual(a.signalLabel('INSUFFICIENT_DATA', 'vi'), 'Chưa đủ dữ liệu');
assert.strictEqual(a.signalLabel('NOT_APPLICABLE', 'vi'), 'Không chấm điểm', 'writing is never strong / weak');
assert.strictEqual(a.shouldShowTrend([{}]), false, 'no chart for one sample');
assert.strictEqual(a.shouldShowTrend([{}, {}]), true);
assert.strictEqual(a.sparklinePoints([50], 100, 30), '');
assert.strictEqual(a.sparklinePoints([0, 100], 106, 36).split(' ').length, 2);
assert.strictEqual(a.interactionTypeLabel('TEXT_GAP', 'vi'), 'Điền vào chỗ trống');
assert.strictEqual(a.interactionTypeLabel('SOME_INTERNAL_CODE', 'vi'), 'Dạng câu hỏi khác', 'no raw codes for learners');
assert.strictEqual(a.componentValue(6.5, 'IELTS_BAND'), '6.5');
assert.strictEqual(a.componentValue(745, 'TOEIC_SCALE'), '745');
assert.strictEqual(a.mistakeStateLabel('IMPROVED', 'vi'), 'Đã làm đúng ở lần sau');
assert.deepStrictEqual(a.outcomeMark('INCORRECT', 'vi'), { glyph: '✗', label: 'Sai' });
assert.strictEqual(a.reviewPath('TOEIC', 'abc'), '/exams/toeic/practice/result/abc');
const rec = { formId: 'f1', scopeCode: 'TOEIC_PART_5' };
assert.deepStrictEqual(a.recommendationCta(rec, [{ attemptId: 'x', formId: 'f1', practiceScopeCode: 'TOEIC_PART_5', status: 'IN_PROGRESS', mode: 'PRACTICE' }]),
  { kind: 'resume', attemptId: 'x' });
assert.deepStrictEqual(a.recommendationCta(rec, [{ attemptId: 'y', formId: 'f1', practiceScopeCode: 'TOEIC_PART_5', status: 'SUBMITTED', mode: 'PRACTICE' }]),
  { kind: 'start' });
assert.deepStrictEqual(a.recommendationCta(rec, [{ attemptId: 'z', formId: 'f2', practiceScopeCode: 'TOEIC_PART_5', status: 'IN_PROGRESS', mode: 'PRACTICE' }]),
  { kind: 'start' }, 'another form is never resumed for this suggestion');

// ---- 2. learner containment ----------------------------------------------------------------------------------------------
// containment scans run on code only (doc comments legitimately name what is forbidden)
const noComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const learnerFiles = {
  'lib/exams/analytics.ts': noComments(src('lib', 'exams', 'analytics.ts')),
  'ExamLearnerProgress.tsx': noComments(exams('ExamLearnerProgress.tsx')),
  'ExamPracticeRecommendations.tsx': noComments(exams('ExamPracticeRecommendations.tsx')),
};
for (const [name, code] of Object.entries(learnerFiles)) {
  assert.ok(!/Sparkles|✨/.test(code), `${name}: no Sparkles`);
  assert.ok(!/acceptedAnswers|correctAnswers|answerSpec|keySource/.test(code), `${name}: no answer keys in analytics UI`);
  assert.ok(!/reasonCodes|IMPORT_READY|QA_APPROVED|MEDIA_IMAGE_PENDING|READY_EXCEPT|policyVersions\.|readinessVersion/.test(code), `${name}: no admin codes`);
  assert.ok(!/estimatedScore|estimatedBand|mastery|cefr/i.test(code), `${name}: no estimates`);
  assert.ok(!/onMouseEnter|onFocus=|onMouseOver/.test(code), `${name}: no passive-event fetches`);
  assert.ok(!/\/ai\/|echo-coach|openrouter/i.test(code), `${name}: no AI call`);
}
const recs = exams('ExamPracticeRecommendations.tsx');
assert.ok(/onClick=\{\(\) => open\(/.test(recs) && /createPracticeAttempt\(rec\.formId, rec\.scopeCode\)/.test(recs),
  'CTA starts the canonical Practice (form + scope) only on click');
assert.ok(!/useEffect\([^)]*createPracticeAttempt/s.test(recs), 'never auto-launches practice');
assert.ok(/Chọn phần khác/.test(recs), 'the learner can always choose another scope');
const progress = exams('ExamLearnerProgress.tsx');
assert.ok(/không phải điểm TOEIC \/ band IELTS/.test(progress), 'practice disclaimer present');
assert.ok(/reviewPath\(family, m\.reviewAttemptId\)/.test(progress), 'mistakes link to the attempt-scoped review (no new answer endpoint)');
assert.ok(/s\.components\.length > 0/.test(progress), 'simulation shows the scorer components only when present');
assert.ok(/shouldShowTrend\(scope\.trend\)/.test(progress), 'no one-sample chart');
const api = src('services', 'examsApi.ts');
const getAnalytics = api.slice(api.indexOf('async getAnalytics'), api.indexOf('async getRecommendations'));
assert.ok(/'\/exams\/analytics'/.test(getAnalytics) && !/userId/.test(getAnalytics), 'analytics API: owner-scoped, no user id parameter');
assert.ok(/'exams:analytics'/.test(src('hooks', 'useExamCatalog.ts')), 'analytics SWR key (purged by clearUserScopedCaches)');
assert.ok(/'progress'/.test(exams('ExamsFamilyPage.tsx')) && /ExamLearnerProgress/.test(exams('ExamsFamilyPage.tsx')), 'family Tiến độ tab');
assert.ok(/ExamPracticeRecommendations/.test(exams('ExamsHome.tsx')), 'home suggestion area');

// ---- 3. admin operations (8D) --------------------------------------------------------------------------------------------
if (exists('components', 'features', 'exams', 'ExamAdminOperationsPanel.tsx')) {
  const ops = noComments(exams('ExamAdminOperationsPanel.tsx'));
  const adminApi = noComments(src('services', 'examAdminApi.ts'));
  const opsApi = adminApi.slice(adminApi.indexOf('async getOperationsOverview'), adminApi.indexOf('export function getApiErrorMessage'));
  assert.ok(/\/operations/.test(opsApi) && /\$\{base\}/.test(opsApi), 'operations API lives under the admin base');
  for (const code of [ops, opsApi]) {
    assert.ok(!/\b(force|skipQa|skip_qa|bypass|override|trustPackage|ignoreRights)\b/i.test(code.replace(/no force|No force|never a force|not a force/gi, '')),
      'no force / skip / bypass / override control');
    assert.ok(!/reviewer\s*:/.test(code), 'reviewer identity never sent by the client');
    assert.ok(!/publishForm|retireForm|\/publish|\/retire/.test(code), 'no publication / retirement execution from the operations center');
    assert.ok(!/Sparkles|✨/.test(code), 'no Sparkles');
  }
  assert.ok(/fingerprint/.test(opsApi), 'QA decision sends the printed fingerprint');
  for (const label of ['Project authorization', 'Publisher licence', 'Provenance']) assert.ok(ops.includes(label), `rights field: ${label}`);
  assert.ok(/ExamAdminOperationsPanel/.test(exams('ExamAdminConsole.tsx')), 'operations tab in the admin console');
}

console.log('exams Phase 8 analytics / recommendations / admin operations contract: OK');
