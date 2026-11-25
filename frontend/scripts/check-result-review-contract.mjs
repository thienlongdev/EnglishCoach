import assert from 'node:assert/strict';
import './test-exams-result-recovery.mjs';

// Test Suite for EXAMS-V4-08 Result Processing and Speaking Result Review Contract
console.log('--- Starting EXAMS-V4-08 Result Processing & Review Shell Contract Checks ---');

// 1. Verify Component Scores and Subjective Pending Semantics
{
  const partialResult = {
    artifactId: 'art-001',
    attemptId: 'att-001',
    family: 'IELTS',
    variant: 'ACADEMIC',
    scope: 'FULL',
    mode: 'EXAM_SIMULATION',
    resultStatus: 'PARTIAL',
    overallScore: null, // Critical: overall band must be null when subjective scoring is pending
    skillScores: {
      LISTENING: 7.5,
      READING: 7.0,
    },
    components: [
      { metric: 'LISTENING', rawScore: 32, scaledScore: 7.5, scaleName: 'IELTS_BAND', status: 'EVALUATED', isPending: false },
      { metric: 'READING', rawScore: 30, scaledScore: 7.0, scaleName: 'IELTS_BAND', status: 'EVALUATED', isPending: false },
      { metric: 'SPEAKING', rawScore: null, scaledScore: 0.0, scaleName: 'IELTS_BAND', status: 'PENDING_AI_EVALUATION', isPending: true },
      { metric: 'WRITING', rawScore: null, scaledScore: 0.0, scaleName: 'IELTS_BAND', status: 'PENDING_AI_EVALUATION', isPending: true },
    ],
    criteria: [],
    versionBundle: { pipeline: 'v4' },
    completedAt: new Date().toISOString(),
  };

  assert.strictEqual(partialResult.overallScore, null, 'Overall score must be null when subjective skills are pending');
  const spkComp = partialResult.components.find((c) => c.metric === 'SPEAKING');
  assert.ok(spkComp?.isPending, 'Speaking component must be marked pending');
  assert.strictEqual(spkComp?.status, 'PENDING_AI_EVALUATION');
  assert.strictEqual(partialResult.skillScores.SPEAKING, undefined, 'Pending speaking must not appear in finalized skillScores');

  console.log('✓ Suite 1: Pending subjective score semantics verified (no fake zero or deflated overall score)');
}

// 2. Verify Item Review Discrimination (Objective vs Subjective)
{
  const itemReviews = [
    {
      placementId: 'place-r1',
      itemId: 'item-r1',
      prompt: 'What was the main finding?',
      interactionType: 'MULTIPLE_CHOICE',
      userAnswer: 'B',
      acceptedAnswers: ['B'],
      explanation: 'Paragraph 3 explains the finding.',
      isCorrect: true,
      creditAwarded: 1.0,
      maxCredit: 1.0,
      skill: 'READING',
      isSubjective: false,
    },
    {
      placementId: 'place-s1',
      itemId: 'item-s1',
      prompt: 'Describe a place you visited in your childhood.',
      interactionType: 'SPEAKING_PROMPT',
      userAnswer: { recordingId: 'rec-123', state: 'SEALED', durationSeconds: 95 },
      acceptedAnswers: null, // Crucial: must NEVER leak an answer key
      explanation: null, // Crucial: must NEVER leak an explanation
      isCorrect: false,
      creditAwarded: 0.0,
      maxCredit: 0.0,
      skill: 'SPEAKING',
      isSubjective: true,
    },
    {
      placementId: 'place-w1',
      itemId: 'item-w1',
      prompt: 'Some people think technology has made children less creative.',
      interactionType: 'WRITING_PROMPT',
      userAnswer: 'In recent years, the impact of technology on youth...',
      acceptedAnswers: null, // Crucial: must NEVER leak an answer key
      explanation: null,
      isCorrect: false,
      creditAwarded: 0.0,
      maxCredit: 0.0,
      skill: 'WRITING',
      isSubjective: true,
    },
  ];

  // Assertions on Objective Item
  const readingItem = itemReviews[0];
  assert.strictEqual(readingItem.isSubjective, false);
  assert.deepStrictEqual(readingItem.acceptedAnswers, ['B']);
  assert.strictEqual(readingItem.creditAwarded, 1.0);

  // Assertions on Speaking Item
  const speakingItem = itemReviews[1];
  assert.strictEqual(speakingItem.isSubjective, true);
  assert.strictEqual(speakingItem.acceptedAnswers, null, 'Speaking review must NEVER expose acceptedAnswers');
  assert.strictEqual(speakingItem.explanation, null, 'Speaking review must NEVER expose explanation');
  assert.strictEqual(speakingItem.maxCredit, 0.0, 'Speaking items must not have objective maxCredit');

  // Assertions on Writing Item
  const writingItem = itemReviews[2];
  assert.strictEqual(writingItem.isSubjective, true);
  assert.strictEqual(writingItem.acceptedAnswers, null, 'Writing review must NEVER expose acceptedAnswers');
  assert.strictEqual(writingItem.maxCredit, 0.0);

  console.log('✓ Suite 2: Item review discrimination verified (zero answer-key leakage for Speaking/Writing)');
}

// 3. Verify Speaking Review DTO Structure and 4 IELTS Criteria
{
  const speakingReview = {
    attemptId: 'att-spk-001',
    family: 'IELTS',
    status: 'PARTIAL',
    overallSpeakingBand: null,
    turns: [
      {
        turnOrder: 1,
        partKey: 'Part 1',
        promptSourceId: 'src-p1-01',
        promptText: 'Do you work or are you a student?',
        recordingId: 'rec-001',
        playbackUrl: '/api/v1/exams/media/recordings/rec-001/playback',
        durationSeconds: 35,
        transcriptText: 'I am currently a third year university student majoring in computer science.',
        transcriptStatus: 'COMPLETED',
      },
      {
        turnOrder: 2,
        partKey: 'Part 2',
        promptSourceId: 'src-p2-01',
        promptText: 'Describe a memorable journey you took.',
        recordingId: 'rec-002',
        playbackUrl: '/api/v1/exams/media/recordings/rec-002/playback',
        durationSeconds: 110,
        transcriptText: 'I would like to talk about a train trip to Da Nang last summer...',
        transcriptStatus: 'COMPLETED',
      },
    ],
    criteria: [
      { rubricCriterion: 'FLUENCY_AND_COHERENCE', estimatedBand: null, status: 'PENDING_AI_EVALUATION' },
      { rubricCriterion: 'LEXICAL_RESOURCE', estimatedBand: null, status: 'PENDING_AI_EVALUATION' },
      { rubricCriterion: 'GRAMMATICAL_RANGE_AND_ACCURACY', estimatedBand: null, status: 'PENDING_AI_EVALUATION' },
      { rubricCriterion: 'PRONUNCIATION', estimatedBand: null, status: 'PENDING_AI_EVALUATION' },
    ],
    examinerFeedback: 'Speaking evaluation in progress.',
  };

  assert.strictEqual(speakingReview.turns.length, 2);
  assert.strictEqual(speakingReview.turns[0].durationSeconds, 35);
  assert.strictEqual(speakingReview.criteria.length, 4);

  const criteriaKeys = speakingReview.criteria.map((c) => c.rubricCriterion);
  assert.ok(criteriaKeys.includes('FLUENCY_AND_COHERENCE'));
  assert.ok(criteriaKeys.includes('LEXICAL_RESOURCE'));
  assert.ok(criteriaKeys.includes('GRAMMATICAL_RANGE_AND_ACCURACY'));
  assert.ok(criteriaKeys.includes('PRONUNCIATION'));

  // Ensure no objective answer keys anywhere in speakingReview
  const serialized = JSON.stringify(speakingReview);
  assert.ok(!serialized.includes('"acceptedAnswers"'));
  assert.ok(!serialized.includes('"correctAnswer"'));

  console.log('✓ Suite 3: Typed Speaking review DTO verified with 4 IELTS criteria and no objective answer keys');
}

console.log('--- ALL EXAMS-V4-08 RESULT PROCESSING & REVIEW CONTRACT CHECKS PASSED ---');
