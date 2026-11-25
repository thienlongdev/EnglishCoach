package com.englishcoach.exams;

import com.englishcoach.exams.exception.ExamExceptionHandler.ExamForbiddenException;
import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamScoringRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.repository.ExamScoringRepository;
import com.englishcoach.exams.scoring.ExamAnswerNormalizer;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;
import com.englishcoach.exams.service.ExamResultService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/**
 * STEP-101: ExamScoringIntegrationTest
 * Tests scoring boundaries, immutable score artifacts, predecessor linkage, and review embargo.
 */
@ExtendWith(MockitoExtension.class)
public class ExamScoringIntegrationTest {

    @Mock
    private ExamAttemptRepository attemptRepository;

    @Mock
    private ExamScoringRepository scoringRepository;

    @Mock
    private ExamContentRepository contentRepository;

    private ExamObjectiveScorer objectiveScorer;
    private ExamResultService resultService;

    @BeforeEach
    void setUp() {
        objectiveScorer = new ExamObjectiveScorer(new ExamAnswerNormalizer());
        resultService = new ExamResultService(attemptRepository, scoringRepository, contentRepository, objectiveScorer);
    }

    @Test
    @DisplayName("Review Embargo: Cannot access review until attempt is officially submitted")
    void testReviewEmbargoUnsubmittedAttempt() {
        UUID attemptId = UUID.randomUUID();
        Long userId = 1L;

        AttemptRecord unsubmittedAttempt = new AttemptRecord(
                attemptId, userId, UUID.randomUUID(), ExamFamily.IELTS, "ACADEMIC", "FULL",
                ExamAttemptMode.EXAM_SIMULATION, null, null, ExamAttemptStatus.IN_PROGRESS,
                1L, 1L, null, null, "hash", null, Instant.now(), Instant.now(), null,
                null, null, List.of(), Instant.now(), Instant.now()
        );

        when(attemptRepository.findAttemptById(attemptId)).thenReturn(Optional.of(unsubmittedAttempt));

        assertThrows(ExamForbiddenException.class, () ->
                resultService.getAttemptReview(attemptId, userId, false)
        );
    }

    @Test
    @DisplayName("Score Immutability & Rescore: Rescoring creates a NEW artifact pointing to predecessor")
    void testRescoreCreatesNewArtifactWithPredecessor() {
        UUID oldArtifactId = UUID.randomUUID();
        UUID subId = UUID.randomUUID();
        Long operatorId = 99L;

        ScoreArtifactRecord oldArtifact = new ScoreArtifactRecord(
                oldArtifactId, subId, 1, null, Map.of("pipeline", "v1"),
                "evidence_hash_1", ResultStatus.COMPLETED, Map.of(), Instant.now()
        );

        when(scoringRepository.findArtifactById(oldArtifactId)).thenReturn(Optional.of(oldArtifact));

        UUID newArtifactId = resultService.rescoreArtifact(
                oldArtifactId, operatorId, "Recalibrated rubric", List.of()
        );

        assertNotNull(newArtifactId);
        assertNotEquals(oldArtifactId, newArtifactId);

        // Verify new artifact was inserted with runOrdinal + 1 and predecessorId set to oldArtifactId
        verify(scoringRepository).insertScoreArtifact(argThat(art ->
                art.id().equals(newArtifactId) &&
                art.predecessorId().equals(oldArtifactId) &&
                art.runOrdinal() == 2
        ));
    }
}
