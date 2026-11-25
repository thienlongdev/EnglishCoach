package com.englishcoach.exams;

import com.englishcoach.exams.job.ExamJobService;
import com.englishcoach.exams.model.ExamAttemptRecords.SubmissionRecord;
import com.englishcoach.exams.model.ExamAttemptRecords.AttemptRecord;
import com.englishcoach.exams.model.ExamScoringRecords.JobRecord;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import java.time.Instant;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ExamJobTerminalRecoveryTest {
    @ParameterizedTest @EnumSource(ExamAttemptStatus.class)
    void missingLegacySubmissionTerminatesOnlySubmittedAttempts(ExamAttemptStatus status) {
        var scoring = mock(ExamScoringRepository.class);
        var attempts = mock(ExamAttemptRepository.class);
        var attempt = mock(AttemptRecord.class);
        UUID id = UUID.randomUUID();
        when(attempts.findSubmissionByAttemptId(id)).thenReturn(Optional.empty());
        when(attempts.findAttemptById(id)).thenReturn(Optional.of(attempt));
        when(attempt.status()).thenReturn(status);
        var progress = new ExamJobService(scoring, attempts).getAttemptScoringProgress(id);
        assertEquals(status == ExamAttemptStatus.SUBMITTED, progress.isPresent());
        progress.ifPresent(value -> {
            assertEquals(ResultStatus.REVIEW_REQUIRED, value.resultStatus());
            assertTrue(value.isCompleted());
            assertNull(value.estimatedReadyAt());
            assertTrue(value.stages().isEmpty());
        });
        verifyNoInteractions(scoring);
    }
    @ParameterizedTest @EnumSource(JobStatus.class)
    void progressDistinguishesActiveAndTerminalJobs(JobStatus status) {
        var scoring = mock(ExamScoringRepository.class);
        var attempts = mock(ExamAttemptRepository.class);
        UUID attemptId = UUID.randomUUID(), submissionId = UUID.randomUUID();
        Instant now = Instant.now();
        when(attempts.findSubmissionByAttemptId(attemptId)).thenReturn(Optional.of(new SubmissionRecord(submissionId,
                attemptId, SubmissionReason.MANUAL, now, Map.of(), "hash", Map.of(), "submission", now)));
        when(scoring.findJobsBySubmissionId(submissionId)).thenReturn(List.of(new JobRecord(UUID.randomUUID(), submissionId,
                "SUBMISSION_SCORING", "v1", 1, status, now, null, null, 1, 3, "private provider failure", now, now)));
        when(scoring.findStagesBySubmissionId(submissionId)).thenReturn(List.of());
        var progress = new ExamJobService(scoring, attempts).getAttemptScoringProgress(attemptId).orElseThrow();
        boolean active = status == JobStatus.PENDING || status == JobStatus.RUNNING || status == JobStatus.RETRY_WAIT;
        assertEquals(active, progress.estimatedReadyAt() != null);
        assertFalse(String.valueOf(progress.failureMessage()).contains("private provider"));
        if (status == JobStatus.FAILED) assertEquals(ResultStatus.FAILED, progress.resultStatus());
        if (status == JobStatus.REVIEW_REQUIRED) assertEquals(ResultStatus.REVIEW_REQUIRED, progress.resultStatus());
        if (status == JobStatus.COMPLETED) assertTrue(progress.isCompleted());
    }
}
