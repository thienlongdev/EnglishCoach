/**
 * Exams Phase 9 — security / reliability hardening contract (frontend side).
 *  1. Executes the REAL saveStatusView (runnerModel.ts, types stripped): the CLOSED state is terminal (no "Thử lại"),
 *     never claims "Đã lưu", and its copy names no server code.
 *  2. Autosave hook: the three server closure codes are terminal (no revision-conflict loop, no automatic retry, local
 *     recovery copy kept); a 409 is treated as a revision conflict only for ATTEMPT_REVISION_CONFLICT (or a codeless 409).
 *  3. 429 RATE_LIMITED gets natural learner copy on start / Practice Again (never the limiter internals); learner files
 *     never read a client-side deadline / clock to decide closure (the server decides).
 * Run: node scripts/check-exams-phase9-hardening-contract.mjs (chained from check-exams-containment-contract.mjs).
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
const strip = (code) => stripTypeScriptTypes(code).replace(/^import .*$/gm, '').replace(/^export /gm, '');

// ---- 1. save status model --------------------------------------------------------------------------------------------
const m = new Function(`${strip(src('lib', 'exams', 'runnerModel.ts'))}\nreturn { saveStatusView };`)();
for (const lang of ['vi', 'en']) {
  const closed = m.saveStatusView('CLOSED', lang);
  assert.strictEqual(closed.retryable, false, 'CLOSED is terminal (no retry button)');
  assert.strictEqual(closed.tone, 'error');
  assert.ok(!/Đã lưu|Saved/.test(closed.label), 'CLOSED never claims a save');
  assert.ok(!/ATTEMPT_|SECTION_|DEADLINE|NOT_WRITABLE/.test(closed.label + closed.hint), 'no server code in learner copy');
}
assert.strictEqual(m.saveStatusView('CLOSED', 'vi').label, 'Bài đã đóng');
assert.strictEqual(m.saveStatusView('ERROR', 'vi').retryable, true, 'an ordinary failure keeps "Thử lại"');

// ---- 2. autosave hook ------------------------------------------------------------------------------------------------
const hook = src('hooks', 'useExamAutosave.ts');
for (const code of ['ATTEMPT_NOT_WRITABLE', 'ATTEMPT_DEADLINE_PASSED', 'SECTION_DEADLINE_PASSED']) {
  assert.ok(hook.includes(`'${code}'`), `closure code ${code} recognised`);
}
const closedBranch = hook.indexOf('if (isClosedWriteCode(err?.response?.data?.code))');
const conflictBranch = hook.indexOf('const is409 =');
assert.ok(closedBranch > 0 && closedBranch < conflictBranch, 'closure is decided BEFORE the revision-conflict loop');
assert.ok(/setSaveStatus\('CLOSED'\)/.test(hook), 'CLOSED state set');
assert.ok(/lastFailureRef\.current !== 'CLOSED'/.test(hook), 'no automatic retry after closure');
assert.ok(/const is409 = err\?\.response\?\.data\?\.code === 'ATTEMPT_REVISION_CONFLICT'/.test(hook),
  'only a revision conflict triggers the reconcile-and-retry loop');
assert.ok(hook.includes('saveLocalResponse('), 'the local recovery copy is still written on every answer');

// ---- 3. 429 copy + no client-side closure ----------------------------------------------------------------------------
const startDialog = src('components', 'features', 'exams', 'SimulationStartDialog.tsx');
const review = src('components', 'features', 'exams', 'PracticeResultReview.tsx');
assert.ok(/status === 429 \|\| code === 'RATE_LIMITED'/.test(startDialog), 'start / practice creation maps 429');
assert.ok(review.includes("code === 'RATE_LIMITED'"), 'Practice Again maps 429');
for (const f of [startDialog, review]) assert.ok(!/auth_rate_limit|EXAMS_CREATE|perMinute/.test(f), 'no limiter internals');
assert.ok(!/isClosedWriteCode\([^)]*Date\.now/.test(hook), 'closure never derived from the client clock');

console.log('Exams Phase 9 hardening contract: closure states, autosave terminal codes and 429 copy verified.');
