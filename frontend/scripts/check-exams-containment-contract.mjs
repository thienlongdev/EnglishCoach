/**
 * Exams Recovery Phase 0 containment contract (frontend side).
 * Extracts the REAL helper functions from ExamLibrary.tsx, strips their types (node:module) and checks:
 *  - server runnableSkills is authoritative even when empty (no logicalKey heuristics resurrect skills);
 *  - TOEIC L&R is labelled Listening + Reading, never "4 kỹ năng";
 *  - the FORM_CONTENT_UNDER_REVIEW start error and contentReviewRequired card notice use the owner text.
 * Exams Phase 2: start modes come from the server's authoritative validation (`availableModes`), never from
 * logicalKey / health-string guesses.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stripTypeScriptTypes } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const libraryPath = path.join(here, '..', 'src', 'components', 'features', 'exams', 'ExamLibrary.tsx');
const typesPath = path.join(here, '..', 'src', 'types', 'exams.ts');
// Exams Phase 7: the start flow moved from the library modal to the test detail page + SimulationStartDialog.
const examsDir = path.join(here, '..', 'src', 'components', 'features', 'exams');
const readExams = (f) => fs.readFileSync(path.join(examsDir, f), 'utf8').split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10));
const startFlowSrc = ['SimulationStartDialog.tsx', 'ExamFormDetail.tsx', 'ExamsHome.tsx'].map(readExams).join(String.fromCharCode(10));
const src = fs.readFileSync(libraryPath, 'utf8').split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10));

function extract(name) {
  const start = src.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} not found in ExamLibrary.tsx`);
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, `${name} has no closing brace`);
  return src.slice(start, end + 3).replace(/^export /, '');
}

function extractConst(name) {
  const start = src.indexOf(`export const ${name} =`);
  assert.ok(start >= 0, `${name} not found`);
  const end = src.indexOf('};\n', start);
  return src.slice(start, end + 3).replace(/^export /, '');
}

const tsSource = [
  extract('isAudioAvailable'),
  extract('isReadingAvailable'),
  extract('getActiveRunnableSkills'),
  extract('getFullExamLabel'),
  extractConst('CONTENT_UNDER_REVIEW_MESSAGE'),
  extract('formatSkillList'),
  extract('isSimulationModeAvailable'),
  extract('isPracticeModeAvailable'),
].join('\n');
const js = stripTypeScriptTypes(tsSource)
  + '\nreturn { isAudioAvailable, isReadingAvailable, getActiveRunnableSkills, getFullExamLabel, CONTENT_UNDER_REVIEW_MESSAGE,'
  + ' isSimulationModeAvailable, isPracticeModeAvailable };';
const lib = new Function(js)();

const toeicLr = {
  logicalKey: 'FORM_REAL_ECONOMY_TOEIC_VOL_1_TEST_01',
  family: 'TOEIC',
  skills: ['LISTENING', 'READING'],
};

// 1. Quarantined form: server says no runnable skill ⇒ UI must not resurrect L/R from the logicalKey.
const quarantined = { ...toeicLr, runnableSkills: [], fullExamRunnable: false, contentReviewRequired: true };
assert.deepStrictEqual(lib.getActiveRunnableSkills(quarantined), [], 'empty runnableSkills is authoritative');
assert.strictEqual(lib.isAudioAvailable(quarantined), false);
assert.strictEqual(lib.isReadingAvailable(quarantined), false);

// 2. Partially valid form keeps only the server-approved skill.
assert.deepStrictEqual(
  lib.getActiveRunnableSkills({ ...toeicLr, runnableSkills: ['READING'], fullExamRunnable: false }),
  ['READING'],
);

// 3. Legacy payload without runnableSkills still uses the old heuristic (backward compatible).
assert.deepStrictEqual(lib.getActiveRunnableSkills({ ...toeicLr }), ['LISTENING', 'READING']);

// 4. Labels: TOEIC LC/RC is Listening + Reading; IELTS keeps the 4-skill label.
assert.strictEqual(lib.getFullExamLabel(toeicLr, 'vi'), 'Đủ Listening + Reading');
assert.strictEqual(lib.getFullExamLabel(toeicLr, 'en'), 'Listening + Reading Ready');
assert.ok(!lib.getFullExamLabel(toeicLr, 'vi').includes('4 kỹ năng'));
assert.strictEqual(
  lib.getFullExamLabel({ family: 'IELTS', skills: ['LISTENING', 'READING', 'WRITING', 'SPEAKING'] }, 'vi'),
  'Đủ 4 kỹ năng / Full',
);
assert.ok(!src.includes("{lang === 'vi' ? 'Đủ 4 kỹ năng / Full' : 'Full Exam Ready'}"), 'badge must not hard-code 4 skills');
assert.ok(src.includes('{getFullExamLabel(form, lang)}'), 'availability badge uses the family-aware label');

// 5. Owner-approved learner message + error-code handling + card notice.
assert.strictEqual(
  lib.CONTENT_UNDER_REVIEW_MESSAGE.vi,
  'Đề này đang được kiểm tra lại nội dung và tạm thời chưa thể làm ở chế độ thi mô phỏng.',
);
assert.ok(startFlowSrc.includes("err?.response?.data?.code === 'FORM_CONTENT_UNDER_REVIEW'"), 'start error maps the containment code');
assert.ok(src.includes('data-testid="exam-content-under-review"'), 'card shows the under-review notice');
assert.ok(fs.readFileSync(typesPath, 'utf8').includes('contentReviewRequired?: boolean;'), 'CatalogFormDto carries the flag');

// 6. Phase 2: availableModes from the server validation is authoritative for both start modes.
const phase2Partial = {
  ...toeicLr,
  runnableSkills: ['READING'],
  simulationSkills: ['READING'],
  fullExamRunnable: false,
  availableModes: ['PRACTICE'],
  validationStatus: 'NEEDS_REVIEW',
  primaryHealthStatus: 'FULLY_PASSING',
};
assert.strictEqual(lib.isSimulationModeAvailable(phase2Partial), false, 'no EXAM_SIMULATION mode ⇒ no simulation');
assert.strictEqual(lib.isPracticeModeAvailable(phase2Partial), true);
assert.strictEqual(lib.isPracticeModeAvailable({ ...phase2Partial, practiceScopeCodes: [] }), false,
  'an exact empty scope list cannot advertise a by-part control from legacy whole-form PRACTICE');
assert.deepStrictEqual(lib.getActiveRunnableSkills(phase2Partial), ['READING']);
const phase2Invalid = { ...phase2Partial, runnableSkills: [], simulationSkills: [], availableModes: [], validationStatus: 'INVALID' };
assert.strictEqual(lib.isPracticeModeAvailable({ ...phase2Invalid, practiceScopeCodes: ['IELTS_SPEAKING_PART_1'] }), true,
  'an exact AVAILABLE independent scope does not require whole-form readiness');
assert.strictEqual(lib.isPracticeModeAvailable(phase2Invalid), false, 'empty availableModes is authoritative');
assert.strictEqual(lib.isSimulationModeAvailable(phase2Invalid), false);
// A stale flag or health string can never resurrect a mode the server withheld.
assert.strictEqual(lib.isSimulationModeAvailable({ ...phase2Invalid, fullExamRunnable: true }), false);
const phase2Valid = {
  ...toeicLr,
  runnableSkills: ['LISTENING', 'READING'],
  fullExamRunnable: true,
  availableModes: ['PRACTICE', 'EXAM_SIMULATION'],
  validationStatus: 'VALID',
};
assert.strictEqual(lib.isSimulationModeAvailable(phase2Valid), true);
assert.strictEqual(lib.isPracticeModeAvailable(phase2Valid), true);
// Legacy payload (no availableModes) keeps the previous derivation.
assert.strictEqual(lib.isSimulationModeAvailable({ ...toeicLr, fullExamRunnable: false }), false);
const modeSrc = src + startFlowSrc;
assert.ok((modeSrc.match(/isSimulationModeAvailable\(/g) || []).length >= 4, 'library card, detail page and start dialog use isSimulationModeAvailable');
assert.ok((modeSrc.match(/isPracticeModeAvailable\(/g) || []).length >= 4, 'library card, detail page use isPracticeModeAvailable');
const typesSrc = fs.readFileSync(typesPath, 'utf8');
assert.ok(typesSrc.includes('availableModes?: ExamStartMode[];'), 'CatalogFormDto carries availableModes');
assert.ok(typesSrc.includes('simulationSkills?: string[];'), 'CatalogFormDto carries simulationSkills');
assert.ok(typesSrc.includes("export type ExamContentValidationStatus = 'VALID' | 'NEEDS_REVIEW' | 'INVALID' | 'UNKNOWN';"));

console.log('[EXAMS-PHASE0] containment contract OK');
console.log('[EXAMS-PHASE2] validation-mode contract OK');

// Exams Phase 4: runner compatibility contract (chained here so npm run test:exams-contracts covers it).
await import('./check-exams-phase4-runtime-contract.mjs');

// Exams Phase 6: Practice + Review contract (chained here so npm run test:exams-contracts covers it).
await import('./check-exams-practice-contract.mjs');

// Exams Phase 7: learner UX contract (chained here so npm run test:exams-contracts covers it).
await import('./check-exams-phase7-ux-contract.mjs');

// Exams Phase 8: learner analytics / recommendations / admin operations contract (chained here so npm run test:exams-contracts covers it).
await import('./check-exams-phase8-analytics-contract.mjs');
await import('./check-exams-phase9-hardening-contract.mjs');
