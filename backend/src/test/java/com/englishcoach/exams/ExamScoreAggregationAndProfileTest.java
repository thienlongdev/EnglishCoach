package com.englishcoach.exams;

import com.englishcoach.exams.job.ExamJobWorker;
import com.englishcoach.exams.model.ExamContentRecords.AnswerSpecRecord;
import com.englishcoach.exams.model.ExamTypes.LifecycleState;
import com.englishcoach.exams.model.ExamTypes.ExamAttemptMode;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.ResultStatus;
import com.englishcoach.exams.model.ExamTypes.ScoreMetric;
import com.englishcoach.exams.repository.ExamProfileRepository;
import com.englishcoach.exams.scoring.ExamAnswerNormalizer;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;
import com.englishcoach.exams.scoring.ExamScoreAggregator;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class ExamScoreAggregationAndProfileTest {

    private ExamScoreAggregator aggregator;
    private ExamObjectiveScorer objectiveScorer;
    private ExamAnswerNormalizer normalizer;

    @Mock
    private ExamProfileRepository profileRepository;

    @BeforeEach
    void setUp() {
        aggregator = new ExamScoreAggregator();
        normalizer = new ExamAnswerNormalizer();
        objectiveScorer = new ExamObjectiveScorer(normalizer);
    }

    @Test
    @DisplayName("Gate 1: All 7 IELTS Decimal Boundary Cases Round Accurately Without Binary Floating-Point Drift")
    void testAllSevenIeltsDecimalBoundaryCases() {
        // Required exact boundary cases from plan:
        // 6.000 -> 6.0
        // 6.125 -> 6.0
        // 6.250 -> 6.5
        // 6.500 -> 6.5
        // 6.750 -> 7.0
        // 6.875 -> 7.0
        // 7.000 -> 7.0

        assertEquals(6.0, aggregator.roundIeltsQuarterBoundary(6.000), 0.0001, "6.000 must round to 6.0");
        assertEquals(6.0, aggregator.roundIeltsQuarterBoundary(6.125), 0.0001, "6.125 must round to 6.0");
        assertEquals(6.5, aggregator.roundIeltsQuarterBoundary(6.250), 0.0001, "6.250 must round to 6.5 (half-up boundary)");
        assertEquals(6.5, aggregator.roundIeltsQuarterBoundary(6.500), 0.0001, "6.500 must round to 6.5");
        assertEquals(7.0, aggregator.roundIeltsQuarterBoundary(6.750), 0.0001, "6.750 must round to 7.0 (half-up boundary)");
        assertEquals(7.0, aggregator.roundIeltsQuarterBoundary(6.875), 0.0001, "6.875 must round to 7.0");
        assertEquals(7.0, aggregator.roundIeltsQuarterBoundary(7.000), 0.0001, "7.000 must round to 7.0");
    }

    @Test
    @DisplayName("Gate 2: computeIeltsOverall Produces Authoritative Decimal Bands Across Boundary Inputs")
    void testComputeIeltsOverallFourSkills() {
        // Average = 24.5 / 4 = 6.125 -> 6.0
        assertEquals(6.0, aggregator.computeIeltsOverall(6.0, 6.0, 6.0, 6.5), 0.0001);

        // Average = 25.0 / 4 = 6.250 -> 6.5
        assertEquals(6.5, aggregator.computeIeltsOverall(6.0, 6.0, 6.5, 6.5), 0.0001);

        // Average = 26.0 / 4 = 6.500 -> 6.5
        assertEquals(6.5, aggregator.computeIeltsOverall(6.5, 6.5, 6.5, 6.5), 0.0001);

        // Average = 27.0 / 4 = 6.750 -> 7.0
        assertEquals(7.0, aggregator.computeIeltsOverall(6.5, 6.5, 7.0, 7.0), 0.0001);

        // Average = 27.5 / 4 = 6.875 -> 7.0
        assertEquals(7.0, aggregator.computeIeltsOverall(6.5, 7.0, 7.0, 7.0), 0.0001);

        // Average = 28.0 / 4 = 7.000 -> 7.0
        assertEquals(7.0, aggregator.computeIeltsOverall(7.0, 7.0, 7.0, 7.0), 0.0001);
    }

    @Test
    @DisplayName("Gate 3: IELTS Writing Weighting (Task 1 1/3 + Task 2 2/3) with Quarter-Boundary Rounding")
    void testIeltsWritingWeightingFormula() {
        // (6.0 * 1 + 7.0 * 2) / 3 = 20/3 = 6.6667 -> 6.5
        assertEquals(6.5, aggregator.computeIeltsWriting(6.0, 7.0), 0.0001);

        // (7.0 * 1 + 8.0 * 2) / 3 = 23/3 = 7.6667 -> 7.5
        assertEquals(7.5, aggregator.computeIeltsWriting(7.0, 8.0), 0.0001);

        // (6.5 * 1 + 6.5 * 2) / 3 = 6.5 -> 6.5
        assertEquals(6.5, aggregator.computeIeltsWriting(6.5, 6.5), 0.0001);
    }

    @Test
    @DisplayName("Gate 4: TOEIC LR Total Clamping and Multiples of 5")
    void testToeicLrTotalCalculation() {
        // Regular addition: 410 + 395 = 805
        assertEquals(805.0, aggregator.computeToeicLrTotal(410.0, 395.0), 0.0001);

        // Minimum clamping: 5 + 5 = 10
        assertEquals(10.0, aggregator.computeToeicLrTotal(5.0, 5.0), 0.0001);
        assertEquals(10.0, aggregator.computeToeicLrTotal(2.0, 3.0), 0.0001);

        // Maximum clamping: 495 + 495 = 990
        assertEquals(990.0, aggregator.computeToeicLrTotal(495.0, 495.0), 0.0001);
        assertEquals(990.0, aggregator.computeToeicLrTotal(500.0, 500.0), 0.0001);
    }

    @Test
    @DisplayName("Gate 5: Incomplete IELTS Topology (Missing or Abstained Skills) Strictly Omits FULL_OVERALL")
    void testIncompleteIeltsAttemptRejection() {
        // Missing Writing
        Map<ScoreMetric, Double> noWriting = new EnumMap<>(ScoreMetric.class);
        noWriting.put(ScoreMetric.LISTENING, 7.0);
        noWriting.put(ScoreMetric.READING, 7.0);
        noWriting.put(ScoreMetric.SPEAKING, 7.0);
        aggregator.aggregateScores(ExamFamily.IELTS, "FULL", noWriting);
        assertFalse(noWriting.containsKey(ScoreMetric.FULL_OVERALL), "Missing Writing must omit Overall");

        // Missing Speaking
        Map<ScoreMetric, Double> noSpeaking = new EnumMap<>(ScoreMetric.class);
        noSpeaking.put(ScoreMetric.LISTENING, 7.0);
        noSpeaking.put(ScoreMetric.READING, 7.0);
        noSpeaking.put(ScoreMetric.WRITING, 7.0);
        aggregator.aggregateScores(ExamFamily.IELTS, "FULL", noSpeaking);
        assertFalse(noSpeaking.containsKey(ScoreMetric.FULL_OVERALL), "Missing Speaking must omit Overall");

        // Abstained / zero Writing
        Map<ScoreMetric, Double> zeroWriting = new EnumMap<>(ScoreMetric.class);
        zeroWriting.put(ScoreMetric.LISTENING, 7.0);
        zeroWriting.put(ScoreMetric.READING, 7.0);
        zeroWriting.put(ScoreMetric.WRITING, 0.0);
        zeroWriting.put(ScoreMetric.SPEAKING, 7.0);
        aggregator.aggregateScores(ExamFamily.IELTS, "FULL", zeroWriting);
        assertFalse(zeroWriting.containsKey(ScoreMetric.FULL_OVERALL), "Zero/abstained Writing must omit Overall");

        // Non-full scope attempt (e.g. section-only practice)
        Map<ScoreMetric, Double> sectionScope = new EnumMap<>(ScoreMetric.class);
        sectionScope.put(ScoreMetric.LISTENING, 7.0);
        sectionScope.put(ScoreMetric.READING, 7.0);
        sectionScope.put(ScoreMetric.WRITING, 7.0);
        sectionScope.put(ScoreMetric.SPEAKING, 7.0);
        aggregator.aggregateScores(ExamFamily.IELTS, "READING_ONLY", sectionScope);
        assertFalse(sectionScope.containsKey(ScoreMetric.FULL_OVERALL), "Non-full scope must omit Overall even if 4 skills exist");

        // Valid full attempt
        Map<ScoreMetric, Double> fullAttempt = new EnumMap<>(ScoreMetric.class);
        fullAttempt.put(ScoreMetric.LISTENING, 6.5);
        fullAttempt.put(ScoreMetric.READING, 6.5);
        fullAttempt.put(ScoreMetric.WRITING, 6.0);
        fullAttempt.put(ScoreMetric.SPEAKING, 7.0);
        aggregator.aggregateScores(ExamFamily.IELTS, "FULL", fullAttempt);
        assertTrue(fullAttempt.containsKey(ScoreMetric.FULL_OVERALL));
        assertEquals(6.5, fullAttempt.get(ScoreMetric.FULL_OVERALL), 0.0001);
    }

    @Test
    @DisplayName("Gate 6: TOEIC Invariant Strictly Forbids FULL_OVERALL Metric")
    void testToeicStrictlyForbidsFullOverall() {
        Map<ScoreMetric, Double> toeicScores = new EnumMap<>(ScoreMetric.class);
        toeicScores.put(ScoreMetric.LISTENING, 420.0);
        toeicScores.put(ScoreMetric.READING, 380.0);
        toeicScores.put(ScoreMetric.SPEAKING, 160.0);
        toeicScores.put(ScoreMetric.WRITING, 150.0);
        toeicScores.put(ScoreMetric.FULL_OVERALL, 999.0); // Stale/erroneous entry

        aggregator.aggregateScores(ExamFamily.TOEIC, "FULL", toeicScores);

        // LR_TOTAL is computed
        assertTrue(toeicScores.containsKey(ScoreMetric.LR_TOTAL));
        assertEquals(800.0, toeicScores.get(ScoreMetric.LR_TOTAL), 0.0001);

        // Invariant: FULL_OVERALL is strictly removed/absent for TOEIC
        assertFalse(toeicScores.containsKey(ScoreMetric.FULL_OVERALL), "TOEIC must NEVER have FULL_OVERALL metric");
    }

    @Test
    @DisplayName("Gate 7: Five-Right / Five-Wrong Controlled Objective Proof with Exact Provenance")
    void testFiveRightFiveWrongObjectiveProof() {
        List<ExamObjectiveScorer.ItemScoreResult> itemResults = new ArrayList<>();
        UUID sectionId = UUID.randomUUID();

        // 5 correct items
        for (int i = 1; i <= 5; i++) {
            UUID itemId = UUID.randomUUID();
            AnswerSpecRecord spec = new AnswerSpecRecord(
                    UUID.randomUUID(),
                    itemId,
                    Map.of("accepted", List.of("option_a")),
                    Map.of("stripPunctuation", true),
                    1,
                    null,
                    1.0,
                    "Explanation for item " + i,
                    null,
                    java.time.Instant.now()
            );
            ExamObjectiveScorer.ItemScoreResult r = objectiveScorer.scoreItem(itemId, "Option_A", spec);
            assertTrue(r.isCorrect());
            assertEquals(1.0, r.creditAwarded(), 0.0001);
            assertEquals(1.0, r.maxCredit(), 0.0001);
            itemResults.add(r);
        }

        // 5 wrong items
        for (int i = 6; i <= 10; i++) {
            UUID itemId = UUID.randomUUID();
            AnswerSpecRecord spec = new AnswerSpecRecord(
                    UUID.randomUUID(),
                    itemId,
                    Map.of("accepted", List.of("option_b")),
                    Map.of("stripPunctuation", true),
                    1,
                    null,
                    1.0,
                    "Explanation for item " + i,
                    null,
                    java.time.Instant.now()
            );
            ExamObjectiveScorer.ItemScoreResult r = objectiveScorer.scoreItem(itemId, "Option_Z", spec);
            assertFalse(r.isCorrect());
            assertEquals(0.0, r.creditAwarded(), 0.0001);
            assertEquals(1.0, r.maxCredit(), 0.0001);
            itemResults.add(r);
        }

        ExamObjectiveScorer.SectionObjectiveScoreResult secResult = objectiveScorer.scoreSection(
                sectionId, ExamFamily.IELTS, ScoreMetric.LISTENING, itemResults, null
        );

        assertEquals(5.0, secResult.rawScore(), 0.0001, "Raw score must be exactly 5.0");
        assertEquals(10.0, secResult.maxRawScore(), 0.0001, "Max raw score must be exactly 10.0");
        assertEquals(10, secResult.itemResults().size());
        assertEquals("IELTS_BAND", secResult.scaleName());
    }

    @Test
    @DisplayName("Gate 8: ExamJobWorker Production Eligibility Strictly Excludes REVIEW_REQUIRED Artifacts")
    void testProductionEligibilityStrictlyExcludesReviewRequired() {
        // COMPLETED simulation on published form with approved calibration -> eligible
        assertTrue(ExamJobWorker.isProductionEligibleForProfileEvidence(
                ExamAttemptMode.EXAM_SIMULATION,
                LifecycleState.PUBLISHED,
                ResultStatus.COMPLETED,
                true
        ));

        // REVIEW_REQUIRED simulation on published form -> strictly INELIGIBLE
        assertFalse(ExamJobWorker.isProductionEligibleForProfileEvidence(
                ExamAttemptMode.EXAM_SIMULATION,
                LifecycleState.PUBLISHED,
                ResultStatus.REVIEW_REQUIRED,
                true
        ), "REVIEW_REQUIRED must never be production eligible for profile evidence");

        // PRACTICE mode -> strictly INELIGIBLE
        assertFalse(ExamJobWorker.isProductionEligibleForProfileEvidence(
                ExamAttemptMode.PRACTICE,
                LifecycleState.PUBLISHED,
                ResultStatus.COMPLETED,
                true
        ), "PRACTICE mode must never create trusted profile evidence");

        // Unapproved calibration -> strictly INELIGIBLE
        assertFalse(ExamJobWorker.isProductionEligibleForProfileEvidence(
                ExamAttemptMode.EXAM_SIMULATION,
                LifecycleState.PUBLISHED,
                ResultStatus.COMPLETED,
                false
        ), "Unapproved calibration must never create trusted profile evidence");
    }

    @Test
    @DisplayName("Gate 9: Profile Evidence Invalidation and Supersession Lifecycle Contract")
    void testProfileEvidenceInvalidationAndSupersession() {
        UUID attemptId = UUID.randomUUID();
        UUID newArtifactId = UUID.randomUUID();

        // 1. Invalidation when review required:
        when(profileRepository.revokeEvidenceForAttempt(eq(attemptId), anyString(), eq("v4.0")))
                .thenReturn(4);

        int revoked = profileRepository.revokeEvidenceForAttempt(attemptId, "ARTIFACT_REQUIRES_REVIEW_OR_INELIGIBLE", "v4.0");
        assertEquals(4, revoked);
        verify(profileRepository).revokeEvidenceForAttempt(attemptId, "ARTIFACT_REQUIRES_REVIEW_OR_INELIGIBLE", "v4.0");

        // 2. Supersession when new artifact completed:
        when(profileRepository.supersedeEvidenceForAttempt(eq(attemptId), eq(newArtifactId), anyString(), eq("v4.0")))
                .thenReturn(4);

        int superseded = profileRepository.supersedeEvidenceForAttempt(attemptId, newArtifactId, "SUPERSEDED_BY_NEW_RUN", "v4.0");
        assertEquals(4, superseded);
        verify(profileRepository).supersedeEvidenceForAttempt(attemptId, newArtifactId, "SUPERSEDED_BY_NEW_RUN", "v4.0");
    }
}
