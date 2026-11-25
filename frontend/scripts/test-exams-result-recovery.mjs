import assert from 'node:assert/strict';
import { resultPhase, retryableResultError, resultWaitExpired } from '../src/lib/exams/resultLifecycle.ts';
import { activeLearnerForm, retiredToeicAttempt } from '../src/lib/exams/productPolicy.ts';

let checked = 0;
for (const family of ['TOEIC', 'IELTS']) {
  for (const skill of family === 'TOEIC' ? ['LISTENING', 'READING'] : ['LISTENING', 'READING', 'WRITING', 'SPEAKING']) {
    for (const resultStatus of ['COMPLETED', 'PARTIAL', 'REVIEW_REQUIRED', 'FAILED']) {
      assert.equal(resultPhase({ family, scope: skill, artifactId: 'persisted', resultStatus, overallScore: null, skillScores: {} }), 'RESULT');
      checked++;
    }
  }
}
assert.equal(resultPhase({ allCompleted: true, resultStatus: 'COMPLETED' }), 'TERMINAL_WITHOUT_ARTIFACT');
assert.equal(resultPhase({ isCompleted: true, resultStatus: 'PARTIAL' }), 'TERMINAL_WITHOUT_ARTIFACT');
assert.equal(resultPhase({ resultStatus: 'COMPLETED' }), 'TERMINAL_WITHOUT_ARTIFACT');
assert.equal(resultPhase({ resultStatus: 'FAILED' }), 'TERMINAL_WITHOUT_ARTIFACT');
assert.equal(resultPhase({ resultStatus: 'REVIEW_REQUIRED' }), 'TERMINAL_WITHOUT_ARTIFACT');
assert.equal(resultPhase({ allCompleted: false, resultStatus: 'PARTIAL' }), 'PROCESSING');
for (const status of [400, 401, 403, 404, 409]) assert.equal(retryableResultError(status), false);
for (const status of [undefined, 408, 429, 500, 503]) assert.equal(retryableResultError(status), true);
assert.equal(resultWaitExpired(0, 60000), true);
assert.equal(resultWaitExpired(20, 0), true);
assert.equal(resultWaitExpired(19, 59999), false);
console.log(`Exams result lifecycle: ${checked + 19} cases passed`);
for (const variant of ['SPEAKING', 'WRITING', 'SUITE']) {
  assert.equal(activeLearnerForm({ family: 'TOEIC', variant, skills: ['READING'] }), false);
  assert.equal(retiredToeicAttempt({ family: 'TOEIC', variant }), true);
}
assert.equal(activeLearnerForm({ family: 'TOEIC', variant: 'LR', skills: ['LISTENING', 'READING'] }), true);
assert.equal(activeLearnerForm({ family: 'TOEIC', variant: 'LR', skills: ['WRITING'] }), false);
assert.equal(activeLearnerForm({ family: 'IELTS', variant: 'ACADEMIC', skills: ['SPEAKING', 'WRITING'] }), true);
console.log('Exams learner product policy: 9 cases passed');
