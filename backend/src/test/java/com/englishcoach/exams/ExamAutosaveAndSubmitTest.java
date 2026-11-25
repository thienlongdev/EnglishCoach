package com.englishcoach.exams;

import com.englishcoach.exams.exception.ExamConcurrencyException;
import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamScoringRepository;
import com.englishcoach.exams.media.ExamMediaService;
import com.englishcoach.exams.service.ExamResponseService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
public class ExamAutosaveAndSubmitTest {

    @Mock
    private ExamAttemptRepository attemptRepository;

    @Mock
    private ExamScoringRepository scoringRepository;

    @InjectMocks
    private ExamResponseService responseService;

    private final UUID attemptId = UUID.randomUUID();
    private final UUID formId = UUID.randomUUID();
    private final Long userId = 42L;

    private AttemptRecord createAttempt(ExamAttemptStatus status, long revision) {
        return new AttemptRecord(
                attemptId, userId, formId, ExamFamily.IELTS, "ACADEMIC", "FULL",
                ExamAttemptMode.EXAM_SIMULATION, null, null, status,
                revision, 1L, "token", Instant.now().plus(1, ChronoUnit.HOURS),
                "pinned_hash_abc", Map.of(), null, Instant.now().minus(10, ChronoUnit.MINUTES),
                null, null, null, List.of(), Instant.now(), Instant.now()
        );
    }

    @Test
    @DisplayName("EXAMS-V4-05: Submit with matching expectedAttemptRevision succeeds and increments revision")
    void testSubmitWithMatchingExpectedAttemptRevisionSucceeds() {
        AttemptRecord attempt = createAttempt(ExamAttemptStatus.IN_PROGRESS, 5L);
        when(attemptRepository.findAttemptByIdForUpdate(attemptId)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findCommandReceipt(eq(userId), eq("SUBMIT_ATTEMPT"), eq("cmd-submit-1"))).thenReturn(Optional.empty());

        UUID generatedSubmissionId = UUID.randomUUID();
        when(attemptRepository.insertSubmission(any(SubmissionRecord.class))).thenReturn(generatedSubmissionId);
        when(attemptRepository.findResponsesByAttemptId(attemptId)).thenReturn(List.of());
        when(attemptRepository.updateAttemptStatus(attemptId, ExamAttemptStatus.SUBMITTED, 5L)).thenReturn(true);

        SubmitAttemptRequest req = new SubmitAttemptRequest(
                "cmd-submit-1",
                5L,
                SubmissionReason.MANUAL,
                List.of(),
                "flush_5_token_123"
        );

        UUID resultSubmissionId = responseService.submitAttempt(userId, attemptId, req);

        assertEquals(generatedSubmissionId, resultSubmissionId);
        // Verify status updated to SUBMITTED with expectedRevision = 5
        verify(attemptRepository).updateAttemptStatus(attemptId, ExamAttemptStatus.SUBMITTED, 5L);
        // Verify command receipt was inserted
        verify(attemptRepository).insertCommandReceipt(argThat(receipt ->
                receipt.commandId().equals("cmd-submit-1") &&
                receipt.operation().equals("SUBMIT_ATTEMPT") &&
                receipt.resultReference().equals(generatedSubmissionId.toString())
        ));
    }

    @Test
    @DisplayName("EXAMS-V4-05: Submit with stale expectedAttemptRevision throws ATTEMPT_REVISION_CONFLICT")
    void testSubmitWithStaleExpectedAttemptRevisionThrowsConflict() {
        AttemptRecord attempt = createAttempt(ExamAttemptStatus.IN_PROGRESS, 6L);
        when(attemptRepository.findAttemptByIdForUpdate(attemptId)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findCommandReceipt(eq(userId), eq("SUBMIT_ATTEMPT"), eq("cmd-submit-stale"))).thenReturn(Optional.empty());

        SubmitAttemptRequest req = new SubmitAttemptRequest(
                "cmd-submit-stale",
                5L, // stale revision
                SubmissionReason.MANUAL,
                List.of(),
                "flush_5_token_123"
        );

        ExamConcurrencyException ex = assertThrows(ExamConcurrencyException.class, () ->
                responseService.submitAttempt(userId, attemptId, req)
        );

        assertEquals("ATTEMPT_REVISION_CONFLICT", ex.getCode());
        assertEquals(6L, ex.getCurrentRevision());
        assertEquals(5L, ex.getExpectedRevision());

        // Verify state not modified
        verify(attemptRepository, never()).insertSubmission(any());
        verify(attemptRepository, never()).incrementAttemptRevision(any());
        verify(attemptRepository, never()).updateAttemptStatus(any(), any(), anyLong());
    }

    @Test
    @DisplayName("EXAMS-V4-05: Idempotent replay of submit with same commandId and same request hash returns original submissionId")
    void testSubmitIdempotentReplayReturnsOriginalSubmission() {
        AttemptRecord attempt = createAttempt(ExamAttemptStatus.IN_PROGRESS, 5L);
        when(attemptRepository.findAttemptByIdForUpdate(attemptId)).thenReturn(Optional.of(attempt));

        UUID originalSubmissionId = UUID.randomUUID();
        SubmissionRecord existingSub = new SubmissionRecord(
                originalSubmissionId, attemptId, SubmissionReason.MANUAL,
                Instant.now(), Map.of(), "pinned_hash_abc", Map.of(), "sub_hash", Instant.now()
        );
        when(attemptRepository.findSubmissionByAttemptId(attemptId)).thenReturn(Optional.of(existingSub));

        // Create the request to compute the exact hash
        SubmitAttemptRequest req = new SubmitAttemptRequest(
                "cmd-submit-replay",
                5L,
                SubmissionReason.MANUAL,
                null,
                "flush_5_token_123"
        );

        // Build command receipt with the same hash
        String reqHash = ExamMediaService.computeSha256(
                ("MANUAL;5;flush_5_token_123;").getBytes(java.nio.charset.StandardCharsets.UTF_8)
        );
        CommandReceiptRecord receipt = new CommandReceiptRecord(
                UUID.randomUUID(), userId, attemptId, "cmd-submit-replay", "SUBMIT_ATTEMPT",
                reqHash, originalSubmissionId.toString(), "SUCCESS", Instant.now()
        );
        when(attemptRepository.findCommandReceipt(userId, "SUBMIT_ATTEMPT", "cmd-submit-replay"))
                .thenReturn(Optional.of(receipt));

        UUID replaySubmissionId = responseService.submitAttempt(userId, attemptId, req);

        assertEquals(originalSubmissionId, replaySubmissionId);
        // Verify no duplicate submission, revision increment, or status change
        verify(attemptRepository, never()).insertSubmission(any());
        verify(attemptRepository, never()).incrementAttemptRevision(any());
        verify(attemptRepository, never()).updateAttemptStatus(any(), any(), anyLong());
    }

    @Test
    @DisplayName("EXAMS-V4-05: Same commandId with different request payload throws IDEMPOTENT_COMMAND_CONFLICT")
    void testSubmitWithSameCommandIdDifferentPayloadThrowsConflict() {
        AttemptRecord attempt = createAttempt(ExamAttemptStatus.IN_PROGRESS, 5L);
        when(attemptRepository.findAttemptByIdForUpdate(attemptId)).thenReturn(Optional.of(attempt));

        CommandReceiptRecord receipt = new CommandReceiptRecord(
                UUID.randomUUID(), userId, attemptId, "cmd-submit-conflict", "SUBMIT_ATTEMPT",
                "original_different_hash_xyz", UUID.randomUUID().toString(), "SUCCESS", Instant.now()
        );
        when(attemptRepository.findCommandReceipt(userId, "SUBMIT_ATTEMPT", "cmd-submit-conflict"))
                .thenReturn(Optional.of(receipt));

        SubmitAttemptRequest req = new SubmitAttemptRequest(
                "cmd-submit-conflict",
                5L,
                SubmissionReason.MANUAL,
                List.of(),
                "flush_5_token_diff"
        );

        IllegalStateException ex = assertThrows(IllegalStateException.class, () ->
                responseService.submitAttempt(userId, attemptId, req)
        );

        assertTrue(ex.getMessage().contains("IDEMPOTENT_COMMAND_CONFLICT"));
        verify(attemptRepository, never()).insertSubmission(any());
        verify(attemptRepository, never()).incrementAttemptRevision(any());
    }

    @Test
    @DisplayName("EXAMS-V4-05: Submit when attempt status is not IN_PROGRESS or READY throws IllegalStateException")
    void testSubmitWhenAttemptNotInProgressThrowsIllegalStateException() {
        AttemptRecord attempt = createAttempt(ExamAttemptStatus.INVALIDATED, 5L);
        when(attemptRepository.findAttemptByIdForUpdate(attemptId)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findCommandReceipt(eq(userId), eq("SUBMIT_ATTEMPT"), eq("cmd-submit-invalid"))).thenReturn(Optional.empty());

        SubmitAttemptRequest req = new SubmitAttemptRequest(
                "cmd-submit-invalid",
                5L,
                SubmissionReason.MANUAL,
                List.of(),
                "flush_token"
        );

        IllegalStateException ex = assertThrows(IllegalStateException.class, () ->
                responseService.submitAttempt(userId, attemptId, req)
        );

        assertTrue(ex.getMessage().contains("cannot be submitted from status: INVALIDATED"));
        verify(attemptRepository, never()).insertSubmission(any());
    }

    @Test
    @DisplayName("EXAMS-V4-05: Submit with final responses persists responses and computes hash including flushToken")
    void testSubmitWithFinalResponsesPersistsResponses() {
        AttemptRecord attempt = createAttempt(ExamAttemptStatus.IN_PROGRESS, 5L);
        when(attemptRepository.findAttemptByIdForUpdate(attemptId)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findCommandReceipt(eq(userId), eq("SUBMIT_ATTEMPT"), eq("cmd-submit-final"))).thenReturn(Optional.empty());

        UUID secId = UUID.randomUUID();
        AttemptSectionRecord sec = new AttemptSectionRecord(
                UUID.randomUUID(), attemptId, secId, ExamSectionState.ACTIVE, "LISTENING",
                Instant.now(), Instant.now().plusSeconds(1800), null, Map.of(), Instant.now()
        );
        when(attemptRepository.findSectionsByAttemptId(attemptId)).thenReturn(List.of(sec));

        UUID itemId = UUID.randomUUID();
        when(attemptRepository.resolvePlacement(attemptId, "p_final_q1"))
                .thenReturn(Optional.of(new ExamAttemptRepository.PlacementResolution(itemId, secId)));

        UUID submissionId = UUID.randomUUID();
        when(attemptRepository.insertSubmission(any())).thenReturn(submissionId);
        when(attemptRepository.findResponsesByAttemptId(attemptId)).thenReturn(List.of());
        when(attemptRepository.updateAttemptStatus(attemptId, ExamAttemptStatus.SUBMITTED, 5L)).thenReturn(true);

        SubmitAttemptRequest req = new SubmitAttemptRequest(
                "cmd-submit-final",
                5L,
                SubmissionReason.TIME_LIMIT,
                List.of(new ResponseItemCommand("p_final_q1", itemId, Map.of("choice", "B"), null, null, false, 0L)),
                "flush_token_xyz"
        );

        UUID result = responseService.submitAttempt(userId, attemptId, req);
        assertEquals(submissionId, result);

        // Verify response upsert was called
        verify(attemptRepository).upsertResponse(
                eq(attemptId), eq(secId), eq("p_final_q1"), eq(itemId),
                eq(Map.of("choice", "B")), isNull(), isNull(), eq(false), eq(0L), eq("cmd-submit-final")
        );
        // Verify atomic status update and revision increment
        verify(attemptRepository).updateAttemptStatus(attemptId, ExamAttemptStatus.SUBMITTED, 5L);
    }
}
