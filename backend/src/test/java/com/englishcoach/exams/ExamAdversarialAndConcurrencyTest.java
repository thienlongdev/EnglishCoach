package com.englishcoach.exams;

import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.scoring.ExamAnswerNormalizer;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;
import com.englishcoach.exams.scoring.ExamScoreAggregator;
import com.englishcoach.exams.service.ExamManifestService;
import com.englishcoach.exams.service.ExamResponseService;
import com.englishcoach.exams.service.ExamTimingService;
import com.englishcoach.mocktest.controller.MockTestController;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
public class ExamAdversarialAndConcurrencyTest {

    @Mock
    private ExamAttemptRepository attemptRepository;

    @Mock
    private ExamContentRepository contentRepository;

    @InjectMocks
    private ExamTimingService timingService;

    @InjectMocks
    private ExamResponseService responseService;

    private ExamScoreAggregator scoreAggregator;
    private ExamAnswerNormalizer normalizer;
    private ExamObjectiveScorer objectiveScorer;

    @BeforeEach
    void setUp() {
        scoreAggregator = new ExamScoreAggregator();
        normalizer = new ExamAnswerNormalizer();
        objectiveScorer = new ExamObjectiveScorer(normalizer);
    }

    private AttemptRecord createTestAttempt(UUID attemptId, UUID formId, ExamAttemptStatus status) {
        return new AttemptRecord(
                attemptId, 1L, formId, ExamFamily.IELTS, "ACADEMIC", "FULL",
                ExamAttemptMode.EXAM_SIMULATION, null, null, status,
                0L, 1L, "token", Instant.now().plus(1, ChronoUnit.HOURS),
                "hash", Map.of(), null, Instant.now().minus(10, ChronoUnit.MINUTES),
                null, null, null, List.of(), Instant.now(), Instant.now()
        );
    }

    // ----------------------------------------------------
    // INVARIANT: Server-Authoritative Timer Enforcement
    // ----------------------------------------------------
    @Test
    @DisplayName("Adversarial: When deadline is active, sync returns authoritative remaining seconds")
    void testAuthoritativeTimingSync() {
        UUID attemptId = UUID.randomUUID();
        UUID formId = UUID.randomUUID();
        UUID secId = UUID.randomUUID();
        Instant deadline = Instant.now().plus(1200, ChronoUnit.SECONDS);

        AttemptRecord attempt = createTestAttempt(attemptId, formId, ExamAttemptStatus.IN_PROGRESS);

        AttemptSectionRecord sec = new AttemptSectionRecord(
                UUID.randomUUID(), attemptId, secId, ExamSectionState.ACTIVE, "MAIN",
                Instant.now(), deadline, null, Map.of(), Instant.now()
        );

        when(attemptRepository.findSectionsByAttemptId(attemptId)).thenReturn(List.of(sec));

        SyncTimingResponseDto sync = timingService.syncTiming(attempt, 1L);

        assertEquals(secId, sync.currentSectionId());
        assertNotNull(sync.remainingSeconds());
        assertTrue(sync.remainingSeconds() > 1190 && sync.remainingSeconds() <= 1200);
        assertEquals(ExamAttemptStatus.IN_PROGRESS, sync.status());
    }

    // ----------------------------------------------------
    // INVARIANT: Response Save Non-IN_PROGRESS Rejection
    // ----------------------------------------------------
    @Test
    @DisplayName("Adversarial: Response save on non-IN_PROGRESS attempt must be rejected with IllegalStateException")
    void testSaveOnNonInProgressAttemptRejected() {
        UUID attemptId = UUID.randomUUID();
        AttemptRecord submittedAttempt = createTestAttempt(attemptId, UUID.randomUUID(), ExamAttemptStatus.SUBMITTED);

        when(attemptRepository.findAttemptByIdForUpdate(attemptId)).thenReturn(Optional.of(submittedAttempt));

        ResponseItemCommand item = new ResponseItemCommand("p-1", UUID.randomUUID(), Map.of("value", "test"), null, null, false, 0L);
        SaveResponseBatchRequest req = new SaveResponseBatchRequest("cmd-1", 0L, List.of(item));

        assertThrows(IllegalStateException.class, () -> {
            responseService.saveResponseBatch(1L, attemptId, req);
        });
    }

    // ----------------------------------------------------
    // INVARIANT: Cross-User Attempt Access Protection
    // ----------------------------------------------------
    @Test
    @DisplayName("Security: Cross-user response save must be rejected with IllegalArgumentException")
    void testCrossUserResponseSaveRejected() {
        UUID attemptId = UUID.randomUUID();
        AttemptRecord ownerAttempt = createTestAttempt(attemptId, UUID.randomUUID(), ExamAttemptStatus.IN_PROGRESS);

        when(attemptRepository.findAttemptByIdForUpdate(attemptId)).thenReturn(Optional.of(ownerAttempt));

        ResponseItemCommand item = new ResponseItemCommand("p-1", UUID.randomUUID(), Map.of("value", "test"), null, null, false, 0L);
        SaveResponseBatchRequest req = new SaveResponseBatchRequest("cmd-1", 0L, List.of(item));

        // Attacker user 999 attempts to save against User 1's attempt
        assertThrows(IllegalArgumentException.class, () -> {
            responseService.saveResponseBatch(999L, attemptId, req);
        });
    }

    // ----------------------------------------------------
    // INVARIANT: Batch Size Limit (Maximum 50 Responses)
    // ----------------------------------------------------
    @Test
    @DisplayName("Adversarial: Response batch exceeding 50 items must be rejected")
    void testBatchSizeLimitEnforced() {
        List<ResponseItemCommand> oversizedList = new ArrayList<>();
        for (int i = 0; i < 51; i++) {
            oversizedList.add(new ResponseItemCommand("p-" + i, UUID.randomUUID(), Map.of("v", i), null, null, false, 0L));
        }
        SaveResponseBatchRequest req = new SaveResponseBatchRequest("cmd-over", 0L, oversizedList);

        assertThrows(IllegalArgumentException.class, () -> {
            responseService.saveResponseBatch(1L, UUID.randomUUID(), req);
        });
    }

    // ----------------------------------------------------
    // INVARIANT: IELTS Official Quarter-Boundary Rounding
    // ----------------------------------------------------
    @Test
    @DisplayName("Score Invariant: IELTS quarter boundary rounding conforms exactly to official rules")
    void testIeltsQuarterBoundaryRounding() {
        assertEquals(6.0, scoreAggregator.roundIeltsQuarterBoundary(6.1), 0.001);
        assertEquals(6.5, scoreAggregator.roundIeltsQuarterBoundary(6.25), 0.001); // 0.25 -> 0.5
        assertEquals(6.5, scoreAggregator.roundIeltsQuarterBoundary(6.3), 0.001);
        assertEquals(6.5, scoreAggregator.roundIeltsQuarterBoundary(6.6), 0.001);
        assertEquals(7.0, scoreAggregator.roundIeltsQuarterBoundary(6.75), 0.001); // 0.75 -> 1.0
        assertEquals(7.0, scoreAggregator.roundIeltsQuarterBoundary(6.875), 0.001);

        // Compute overall from 4 skills: (6.5 + 6.5 + 6.0 + 6.0) / 4 = 6.25 -> rounds to 6.5
        double overall = scoreAggregator.computeIeltsOverall(6.5, 6.5, 6.0, 6.0);
        assertEquals(6.5, overall, 0.001);
    }

    // ----------------------------------------------------
    // INVARIANT: IELTS Task 1 (1/3) vs Task 2 (2/3) Weighting
    // ----------------------------------------------------
    @Test
    @DisplayName("Score Invariant: IELTS Writing Task 2 is weighted double Task 1")
    void testIeltsWritingWeighting() {
        // Task 1 = 6.0, Task 2 = 7.5
        // (6.0 + 2 * 7.5) / 3 = 21.0 / 3 = 7.0
        double writingScore = scoreAggregator.computeIeltsWriting(6.0, 7.5);
        assertEquals(7.0, writingScore, 0.001);

        // Task 1 = 8.0, Task 2 = 5.0
        // (8.0 + 10.0) / 3 = 18.0 / 3 = 6.0
        double writingScore2 = scoreAggregator.computeIeltsWriting(8.0, 5.0);
        assertEquals(6.0, writingScore2, 0.001);
    }

    // ----------------------------------------------------
    // INVARIANT: TOEIC Score Topology (No 4-Skill Overall)
    // ----------------------------------------------------
    @Test
    @DisplayName("Score Invariant: TOEIC Four-Skill Suite has NO 4-skill numerical Overall")
    void testToeicSuiteHasNoOverall() {
        double lrTotal = scoreAggregator.computeToeicLrTotal(400.0, 450.0);
        assertEquals(850.0, lrTotal, 0.001);
        assertTrue(lrTotal >= 10.0 && lrTotal <= 990.0);

        // Aggregating scores for TOEIC must never produce FULL_OVERALL
        Map<ScoreMetric, Double> metrics = new HashMap<>(Map.of(
                ScoreMetric.LISTENING, 400.0,
                ScoreMetric.READING, 450.0,
                ScoreMetric.SPEAKING, 160.0,
                ScoreMetric.WRITING, 170.0
        ));

        scoreAggregator.aggregateScores(ExamFamily.TOEIC, "SUITE", metrics);
        assertTrue(metrics.containsKey(ScoreMetric.LR_TOTAL), "TOEIC L&R total must exist");
        assertFalse(metrics.containsKey(ScoreMetric.FULL_OVERALL), "TOEIC Four-Skill Suite must NOT have FULL_OVERALL");
    }

    // ----------------------------------------------------
    // INVARIANT: Legacy Mock Test Client-Score Rejection (410 GONE)
    // ----------------------------------------------------
    @Test
    @DisplayName("Security & Legacy Cutover: POST /api/mocktests/{id}/submit returns 410 GONE")
    void testLegacyMockTestSubmissionReturnsGone() {
        MockTestController mockController = new MockTestController(null);
        ResponseEntity<Void> response = mockController.submitExam(null, 1L, 85);
        assertEquals(HttpStatus.GONE, response.getStatusCode(), "Client score submission must be permanently rejected with HTTP 410 GONE");
    }
}
