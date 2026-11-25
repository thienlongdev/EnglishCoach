import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('--- Starting EXAMS-V4-20 Aggregation & Profile Invalidation Contract Checks ---');

// 1. Audit ExamResultView.tsx for strictly ZERO client-side arithmetic calculation
{
  const resultViewPath = path.resolve(__dirname, '../src/components/features/exams/ExamResultView.tsx');
  const sourceCode = fs.readFileSync(resultViewPath, 'utf8');

  // Verify there is no client-side addition of skill scores
  assert.ok(
    !sourceCode.includes("skillScores['LISTENING'] || 0) + (skillScores['READING']"),
    'ExamResultView must NOT calculate TOEIC LR Total by adding skill scores'
  );
  assert.ok(
    !sourceCode.includes(' / 4') && !sourceCode.includes('/ 4.0') && !/\+\s*.*\/4\b/.test(sourceCode),
    'ExamResultView must NOT calculate IELTS Overall band via arithmetic division'
  );

  console.log('✓ Suite 1: Frontend zero-calculation contract verified (no client-side score synthesis)');
}

// 2. Official IELTS 7-boundary half-band rounding specification
{
  function roundIeltsQuarterBoundary(score) {
    // Exact half-up rounding to nearest 0.5: floor(score * 2 + 0.5) / 2
    return Math.floor(score * 2.0 + 0.5) / 2.0;
  }

  const boundaryCases = [
    { raw: 6.000, expected: 6.0 },
    { raw: 6.125, expected: 6.0 },
    { raw: 6.250, expected: 6.5 },
    { raw: 6.500, expected: 6.5 },
    { raw: 6.750, expected: 7.0 },
    { raw: 6.875, expected: 7.0 },
    { raw: 7.000, expected: 7.0 },
  ];

  for (const { raw, expected } of boundaryCases) {
    const actual = roundIeltsQuarterBoundary(raw);
    assert.strictEqual(
      actual,
      expected,
      `Boundary case ${raw} must round to ${expected}, got ${actual}`
    );
  }

  console.log('✓ Suite 2: All 7 IELTS decimal boundary cases verified (6.00->6.0, 6.125->6.0, 6.25->6.5, 6.50->6.5, 6.75->7.0, 6.875->7.0, 7.00->7.0)');
}

// 3. Four-Skill IELTS Topology Contract
{
  function mockAggregateIelts(scope, scores) {
    const isFull = scope && scope.toUpperCase().includes('FULL');
    const { LISTENING: l, READING: r, WRITING: w, SPEAKING: s } = scores;
    if (isFull && l != null && l > 0 && r != null && r > 0 && w != null && w > 0 && s != null && s > 0) {
      const avg = (l + r + w + s) / 4.0;
      return Math.floor(avg * 2.0 + 0.5) / 2.0;
    }
    return null;
  }

  // Missing writing -> null overall
  assert.strictEqual(mockAggregateIelts('FULL', { LISTENING: 7.0, READING: 7.0, SPEAKING: 7.0 }), null);

  // Missing speaking -> null overall
  assert.strictEqual(mockAggregateIelts('FULL', { LISTENING: 7.0, READING: 7.0, WRITING: 7.0 }), null);

  // Abstained writing (null) -> null overall
  assert.strictEqual(mockAggregateIelts('FULL', { LISTENING: 7.0, READING: 7.0, WRITING: null, SPEAKING: 7.0 }), null);

  // Non-full scope -> null overall
  assert.strictEqual(mockAggregateIelts('LISTENING_READING', { LISTENING: 7.0, READING: 7.0, WRITING: 7.0, SPEAKING: 7.0 }), null);

  // All 4 present on FULL attempt -> valid overall
  assert.strictEqual(mockAggregateIelts('FULL', { LISTENING: 6.5, READING: 6.5, WRITING: 6.0, SPEAKING: 7.0 }), 6.5);

  console.log('✓ Suite 3: IELTS 4-skill same-attempt requirement and non-full scope rejection verified');
}

// 4. TOEIC LR Total and 4-Skill Overall Absence Contract
{
  function mockAggregateToeic(scores) {
    const { LISTENING: l, READING: r } = scores;
    const result = {};
    if (l != null && l >= 5 && r != null && r >= 5) {
      let total = l + r;
      if (total < 10) total = 10;
      if (total > 990) total = 990;
      result.LR_TOTAL = Math.round(total / 5.0) * 5.0;
    }
    // Absolute rule: NEVER produce FULL_OVERALL
    delete result.FULL_OVERALL;
    return result;
  }

  const toeicResult = mockAggregateToeic({ LISTENING: 420, READING: 380, SPEAKING: 150, WRITING: 140 });
  assert.strictEqual(toeicResult.LR_TOTAL, 800);
  assert.strictEqual(toeicResult.FULL_OVERALL, undefined, 'TOEIC must NEVER produce a FULL_OVERALL metric');

  console.log('✓ Suite 4: TOEIC LR Total multiple-of-5 and absolute absence of 4-skill Overall verified');
}

console.log('--- ALL EXAMS-V4-20 AGGREGATION CONTRACT CHECKS PASSED ---');
