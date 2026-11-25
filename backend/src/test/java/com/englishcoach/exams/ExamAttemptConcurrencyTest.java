package com.englishcoach.exams;

import com.englishcoach.exams.exception.ExamConcurrencyException;
import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.service.ExamAttemptService;
import com.englishcoach.exams.service.ExamManifestService;
import com.englishcoach.exams.service.ExamResponseService;
import com.englishcoach.exams.service.ExamRightsService;
import com.englishcoach.exams.service.ExamTimingService;
import org.junit.jupiter.api.BeforeEach;
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
public class ExamAttemptConcurrencyTest {

    @Mock
    private ExamAttemptRepository attemptRepository;

    @Mock
    private ExamContentRepository contentRepository;

    @Mock
    private ExamRightsService rightsService;

    @Mock
    private ExamTimingService timingService;

    @Mock
    private ExamManifestService manifestService;

    @InjectMocks
    private ExamResponseService responseService;

    @InjectMocks
    private ExamAttemptService attemptService;

    private final UUID attemptId = UUID.randomUUID();
    private final UUID formId = UUID.randomUUID();
    private final UUID sectionId = UUID.randomUUID();
    private final Long userId = 42L;

    private AttemptRecord createAttempt(long revision) {
        return new AttemptRecord(
                attemptId, userId, formId, ExamFamily.IELTS, "ACADEMIC", "FULL",
                ExamAttemptMode.EXAM_SIMULATION, null, null, ExamAttemptStatus.IN_PROGRESS,
                revision, 1L, "token", Instant.now().plus(1, ChronoUnit.HOURS),
                "hash", Map.of(), null, Instant.now().minus(10, ChronoUnit.MINUTES),
                null, null, null, List.of(), Instant.now(), Instant.now()
        );
    }

    @Test
    @DisplayName("EXAMS-V4-03: Stale expectedAttemptRevision in saveResponseBatch throws ExamConcurrencyException")
    void testStaleRevisionRejectedInSave() {
        // Current server revision is 5
        AttemptRecord attempt = createAttempt(5L);
        when(attemptRepository.findAttemptByIdForUpdate(attemptId)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findCommandReceipt(eq(userId), eq("SAVE_RESPONSES"), any())).thenReturn(Optional.empty());

        // Stale tab sends expected revision 4
        SaveResponseBatchRequest req = new SaveResponseBatchRequest(
                "cmd-stale-save",
                4L,
                List.of(new ResponseItemCommand("p1", UUID.randomUUID(), Map.of("choice", "A"), null, null, false, 0L))
        );

        ExamConcurrencyException ex = assertThrows(ExamConcurrencyException.class, () ->
                responseService.saveResponseBatch(userId, attemptId, req)
        );

        assertEquals("ATTEMPT_REVISION_CONFLICT", ex.getCode());
        assertEquals(5L, ex.getCurrentRevision());
        assertEquals(4L, ex.getExpectedRevision());
        verify(attemptRepository, never()).upsertResponse(any(), any(), any(), any(), any(), any(), any(), anyBoolean(), any(), any());
    }

    @Test
    @DisplayName("EXAMS-V4-03: Matching expectedAttemptRevision in saveResponseBatch succeeds and increments revision")
    void testMatchingRevisionSucceedsInSave() {
        AttemptRecord attempt = createAttempt(5L);
        when(attemptRepository.findAttemptByIdForUpdate(attemptId)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findCommandReceipt(eq(userId), eq("SAVE_RESPONSES"), any())).thenReturn(Optional.empty());

        AttemptSectionRecord activeSec = new AttemptSectionRecord(
                UUID.randomUUID(), attemptId, sectionId, ExamSectionState.ACTIVE, "MAIN",
                Instant.now(), Instant.now().plus(1, ChronoUnit.HOURS), null, Map.of(), Instant.now()
        );
        when(attemptRepository.findSectionsByAttemptId(attemptId)).thenReturn(List.of(activeSec));
        when(attemptRepository.resolvePlacement(eq(attemptId), eq(sectionId), eq("p1")))
                .thenReturn(Optional.of(new ExamAttemptRepository.PlacementResolution(UUID.randomUUID(), sectionId)));
        when(attemptRepository.upsertResponse(any(), any(), any(), any(), any(), any(), any(), anyBoolean(), any(), any())).thenReturn(1L);

        SaveResponseBatchRequest req = new SaveResponseBatchRequest(
                "cmd-valid-save",
                5L,
                List.of(new ResponseItemCommand("p1", null, Map.of("choice", "A"), null, null, false, 0L))
        );

        SaveReceiptDto receipt = responseService.saveResponseBatch(userId, attemptId, req);

        assertNotNull(receipt);
        assertEquals(6L, receipt.attemptRevision());
        verify(attemptRepository).incrementAttemptRevision(attemptId);
        verify(attemptRepository).insertCommandReceipt(any());
    }

    @Test
    @DisplayName("EXAMS-V4-03: Idempotent command receipt replay returns cached result without re-executing mutation")
    void testIdempotentCommandReplay() {
        AttemptRecord attempt = createAttempt(5L);
        when(attemptRepository.findAttemptByIdForUpdate(attemptId)).thenReturn(Optional.of(attempt));

        SaveResponseBatchRequest req = new SaveResponseBatchRequest(
                "cmd-replay-save",
                5L,
                List.of(new ResponseItemCommand("p1", UUID.randomUUID(), Map.of("choice", "A"), null, null, false, 0L))
        );

        String validHash = com.englishcoach.exams.media.ExamMediaService.computeSha256(
                "p1::{choice=A}:;".getBytes(java.nio.charset.StandardCharsets.UTF_8)
        );

        CommandReceiptRecord existingReceipt = new CommandReceiptRecord(
                UUID.randomUUID(), userId, attemptId, "cmd-replay-save", "SAVE_RESPONSES",
                validHash, attemptId.toString(), "SUCCESS", Instant.now().minusSeconds(10)
        );
        when(attemptRepository.findCommandReceipt(userId, "SAVE_RESPONSES", "cmd-replay-save"))
                .thenReturn(Optional.of(existingReceipt));

        SaveReceiptDto receipt = responseService.saveResponseBatch(userId, attemptId, req);

        assertNotNull(receipt);
        assertEquals(5L, receipt.attemptRevision());
        verify(attemptRepository, never()).upsertResponse(any(), any(), any(), any(), any(), any(), any(), anyBoolean(), any(), any());
        verify(attemptRepository, never()).incrementAttemptRevision(any());
    }

    @Test
    @DisplayName("EXAMS-V4-03: Stale expectedAttemptRevision in completeSectionAndAdvance throws ExamConcurrencyException")
    void testStaleRevisionRejectedInCompleteSection() {
        AttemptRecord attempt = createAttempt(3L);
        when(attemptRepository.findAttemptByIdForUpdate(attemptId)).thenReturn(Optional.of(attempt));

        CompleteSectionRequest req = new CompleteSectionRequest("cmd-stale-complete", 2L, null, "session-1");

        ExamConcurrencyException ex = assertThrows(ExamConcurrencyException.class, () ->
                attemptService.completeSectionAndAdvance(userId, attemptId, sectionId, req)
        );

        assertEquals("ATTEMPT_REVISION_CONFLICT", ex.getCode());
        assertEquals(3L, ex.getCurrentRevision());
        assertEquals(2L, ex.getExpectedRevision());
    }

    @Test
    @DisplayName("EXAMS-V4-03: Same commandId with different request payload is rejected with IDEMPOTENT_COMMAND_CONFLICT")
    void testSameCommandIdDifferentPayloadRejected() {
        AttemptRecord attempt = createAttempt(5L);
        when(attemptRepository.findAttemptByIdForUpdate(attemptId)).thenReturn(Optional.of(attempt));

        // Existing receipt was for choice A
        CommandReceiptRecord existingReceipt = new CommandReceiptRecord(
                UUID.randomUUID(), userId, attemptId, "cmd-conflict-hash", "SAVE_RESPONSES",
                "original-hash-for-choice-a", attemptId.toString(), "SUCCESS", Instant.now().minusSeconds(10)
        );
        when(attemptRepository.findCommandReceipt(userId, "SAVE_RESPONSES", "cmd-conflict-hash"))
                .thenReturn(Optional.of(existingReceipt));

        // Replay with choice B produces a different hash
        SaveResponseBatchRequest req = new SaveResponseBatchRequest(
                "cmd-conflict-hash",
                5L,
                List.of(new ResponseItemCommand("p1", UUID.randomUUID(), Map.of("choice", "B"), null, null, false, 0L))
        );

        IllegalStateException ex = assertThrows(IllegalStateException.class, () ->
                responseService.saveResponseBatch(userId, attemptId, req)
        );

        assertTrue(ex.getMessage().contains("IDEMPOTENT_COMMAND_CONFLICT"));
        verify(attemptRepository, never()).upsertResponse(any(), any(), any(), any(), any(), any(), any(), anyBoolean(), any(), any());
        verify(attemptRepository, never()).incrementAttemptRevision(any());
    }
}
