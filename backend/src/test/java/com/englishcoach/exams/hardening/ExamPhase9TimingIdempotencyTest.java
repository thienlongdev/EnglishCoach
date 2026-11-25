package com.englishcoach.exams.hardening;

import com.englishcoach.exams.exception.ExamConcurrencyException;
import com.englishcoach.exams.exception.ExamWriteClosedException;
import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.repository.ExamScoringRepository;
import com.englishcoach.exams.service.ExamDeadlinePolicy;
import com.englishcoach.exams.service.ExamResponseService;
import com.englishcoach.exams.service.ExamResponseService.SubmitOutcome;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Duration;
import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Exams Phase 9C / 9D — server-authoritative deadline + write idempotency on the response service (mocked repositories;
 * the same rules run against PostgreSQL in {@code ExamPhase9SecurityReliabilityPostgresTest}). Only server state decides:
 * no client timestamp / remaining time is an input of any API used here.
 */
class ExamPhase9TimingIdempotencyTest {

    static final long USER = 7L;
    final UUID attemptId = UUID.randomUUID(), formId = UUID.randomUUID(), sectionId = UUID.randomUUID(), itemId = UUID.randomUUID();

    ExamAttemptRepository attempts;
    ExamScoringRepository scoring;
    ExamContentRepository content;
    ExamResponseService service;

    @BeforeEach
    void setUp() {
        attempts = mock(ExamAttemptRepository.class);
        scoring = mock(ExamScoringRepository.class);
        content = mock(ExamContentRepository.class);
        service = new ExamResponseService(attempts, scoring, content, null);
        when(attempts.findCommandReceipt(anyLong(), anyString(), anyString())).thenReturn(Optional.empty());
        when(attempts.resolvePlacement(eq(attemptId), eq(sectionId), anyString()))
                .thenReturn(Optional.of(new ExamAttemptRepository.PlacementResolution(itemId, sectionId)));
        when(attempts.resolvePlacement(eq(attemptId), anyString()))
                .thenReturn(Optional.of(new ExamAttemptRepository.PlacementResolution(itemId, sectionId)));
        when(attempts.upsertResponse(any(), any(), anyString(), any(), any(), any(), any(), anyBoolean(), any(), any())).thenReturn(1L);
        when(attempts.insertSubmission(any())).thenReturn(UUID.randomUUID());
        when(attempts.updateAttemptStatus(any(), any(), anyLong())).thenReturn(true);
        when(attempts.findResponsesByAttemptId(attemptId)).thenReturn(List.of());
        when(content.findSectionsByFormId(formId)).thenReturn(List.of());
    }

    AttemptRecord attempt(ExamAttemptMode mode, ExamAttemptStatus status, long revision, Instant scheduledEnd) {
        return new AttemptRecord(attemptId, USER, formId, ExamFamily.IELTS, "ACADEMIC", "FULL", mode, null, null, status, revision,
                1L, null, null, "h", Map.of("selectedSkills", List.of("READING")), null, Instant.now().minusSeconds(3600),
                scheduledEnd, null, null, List.of(), Instant.now(), Instant.now(), null, null, ExamSnapshotState.LEGACY_UNSNAPSHOTTED);
    }

    void stub(AttemptRecord a, Instant sectionDeadline, ExamSectionState state) {
        when(attempts.findAttemptByIdForUpdate(attemptId)).thenReturn(Optional.of(a));
        when(attempts.findSectionsByAttemptId(attemptId)).thenReturn(List.of(new AttemptSectionRecord(UUID.randomUUID(), attemptId,
                sectionId, state, "MAIN", Instant.now().minusSeconds(3600), sectionDeadline, null, Map.of(), Instant.now())));
    }

    static SaveResponseBatchRequest save(long revision, String value) {
        return new SaveResponseBatchRequest("m-" + UUID.randomUUID(), revision,
                List.of(new ResponseItemCommand("p1", null, Map.of("value", value), value, null, false, null)));
    }

    static SubmitAttemptRequest submit(long revision, String value) {
        return new SubmitAttemptRequest("s-" + UUID.randomUUID(), revision, SubmissionReason.MANUAL,
                value == null ? List.of() : List.of(new ResponseItemCommand("p1", null, Map.of("value", value), value, null, false, null)));
    }

    @Test
    @DisplayName("29: a simulation answer before the deadline is accepted")
    void beforeDeadlineAccepted() {
        stub(attempt(ExamAttemptMode.EXAM_SIMULATION, ExamAttemptStatus.IN_PROGRESS, 3, Instant.now().plusSeconds(600)),
                Instant.now().plusSeconds(600), ExamSectionState.ACTIVE);
        SaveReceiptDto r = service.saveResponseBatch(USER, attemptId, save(3, "A"));
        assertEquals(4, r.attemptRevision());
        verify(attempts).upsertResponse(any(), any(), eq("p1"), any(), any(), any(), any(), anyBoolean(), any(), any());
    }

    @Test
    @DisplayName("in-flight grace: a write a few seconds after the deadline (< WRITE_GRACE) is still accepted")
    void graceWindow() {
        Instant justPassed = Instant.now().minusSeconds(2);
        stub(attempt(ExamAttemptMode.EXAM_SIMULATION, ExamAttemptStatus.IN_PROGRESS, 3, justPassed), justPassed, ExamSectionState.ACTIVE);
        assertDoesNotThrow(() -> service.saveResponseBatch(USER, attemptId, save(3, "A")));
        assertTrue(ExamDeadlinePolicy.WRITE_GRACE.compareTo(Duration.ofSeconds(30)) <= 0, "grace stays small");
    }

    @Test
    @DisplayName("31/32/37: autosave after the server deadline is refused (no mutation) whatever revision / client time it carries")
    void afterDeadlineRefused() {
        Instant past = Instant.now().minus(ExamDeadlinePolicy.WRITE_GRACE).minusSeconds(5);
        stub(attempt(ExamAttemptMode.EXAM_SIMULATION, ExamAttemptStatus.IN_PROGRESS, 3, past), past, ExamSectionState.ACTIVE);
        ExamWriteClosedException e = assertThrows(ExamWriteClosedException.class, () -> service.saveResponseBatch(USER, attemptId, save(3, "A")));
        assertEquals(ExamDeadlinePolicy.ATTEMPT_DEADLINE_PASSED, e.getCode());
        verify(attempts, never()).upsertResponse(any(), any(), anyString(), any(), any(), any(), any(), anyBoolean(), any(), any());
        verify(attempts, never()).incrementAttemptRevision(any());
    }

    @Test
    @DisplayName("section deadline: answers for an ACTIVE section past its deadline are refused even before the hard end")
    void sectionDeadlineRefused() {
        Instant past = Instant.now().minus(ExamDeadlinePolicy.WRITE_GRACE).minusSeconds(5);
        stub(attempt(ExamAttemptMode.EXAM_SIMULATION, ExamAttemptStatus.IN_PROGRESS, 3, Instant.now().plusSeconds(3600)), past,
                ExamSectionState.ACTIVE);
        ExamWriteClosedException e = assertThrows(ExamWriteClosedException.class, () -> service.saveResponseBatch(USER, attemptId, save(3, "A")));
        assertEquals(ExamDeadlinePolicy.SECTION_DEADLINE_PASSED, e.getCode());
        verify(attempts, never()).upsertResponse(any(), any(), anyString(), any(), any(), any(), any(), anyBoolean(), any(), any());
    }

    @Test
    @DisplayName("31/32: autosave on a SUBMITTED attempt is refused as ATTEMPT_NOT_WRITABLE (terminal), even with a stale revision")
    void postSubmitAutosaveRefused() {
        stub(attempt(ExamAttemptMode.PRACTICE, ExamAttemptStatus.SUBMITTED, 9, null), null, ExamSectionState.COMPLETED);
        ExamWriteClosedException e = assertThrows(ExamWriteClosedException.class, () -> service.saveResponseBatch(USER, attemptId, save(4, "B")));
        assertEquals(ExamDeadlinePolicy.ATTEMPT_NOT_WRITABLE, e.getCode());
        verify(attempts, never()).upsertResponse(any(), any(), anyString(), any(), any(), any(), any(), anyBoolean(), any(), any());
    }

    @Test
    @DisplayName("40/41: a request built on an outdated revision (stale tab / late retry) is never applied")
    void staleRevisionRefused() {
        stub(attempt(ExamAttemptMode.EXAM_SIMULATION, ExamAttemptStatus.IN_PROGRESS, 5, Instant.now().plusSeconds(600)),
                Instant.now().plusSeconds(600), ExamSectionState.ACTIVE);
        ExamConcurrencyException e = assertThrows(ExamConcurrencyException.class, () -> service.saveResponseBatch(USER, attemptId, save(4, "A")));
        assertEquals("ATTEMPT_REVISION_CONFLICT", e.getCode());
        assertEquals(5L, e.getCurrentRevision());
        verify(attempts, never()).upsertResponse(any(), any(), anyString(), any(), any(), any(), any(), anyBoolean(), any(), any());
    }

    @Test
    @DisplayName("38: PRACTICE is never governed by the deadline policy (untimed scope / informational legacy timer)")
    void practiceUntimed() {
        Instant past = Instant.now().minusSeconds(7200);
        stub(attempt(ExamAttemptMode.PRACTICE, ExamAttemptStatus.IN_PROGRESS, 2, past), past, ExamSectionState.ACTIVE);
        assertDoesNotThrow(() -> service.saveResponseBatch(USER, attemptId, save(2, "C")));
        AttemptRecord p = attempt(ExamAttemptMode.PRACTICE, ExamAttemptStatus.IN_PROGRESS, 2, past);
        assertFalse(ExamDeadlinePolicy.enforced(p));
        assertFalse(ExamDeadlinePolicy.attemptClosed(p, Instant.now()));
        assertEquals(past, ExamDeadlinePolicy.capNextDeadline(p, past), "practice deadlines are never capped / changed");
    }

    @Test
    @DisplayName("33/34/39/65: a duplicate / retried submit returns the SAME submission — no second submission, scoring job or write")
    void duplicateSubmitIdempotent() {
        UUID existing = UUID.randomUUID();
        stub(attempt(ExamAttemptMode.EXAM_SIMULATION, ExamAttemptStatus.SUBMITTED, 8, Instant.now().plusSeconds(600)), null,
                ExamSectionState.COMPLETED);
        when(attempts.findSubmissionByAttemptId(attemptId)).thenReturn(Optional.of(new SubmissionRecord(existing, attemptId,
                SubmissionReason.MANUAL, Instant.now(), Map.of(), "h", Map.of(), "s", Instant.now())));
        SubmitOutcome o = service.submitAttemptWithOutcome(USER, attemptId, submit(7, "B")); // outdated revision + a new answer
        assertEquals(existing, o.submissionId());
        assertTrue(o.replayed());
        verify(attempts, never()).insertSubmission(any());
        verify(attempts, never()).upsertResponse(any(), any(), anyString(), any(), any(), any(), any(), anyBoolean(), any(), any());
        verify(scoring, never()).insertJob(any());
    }

    @Test
    @DisplayName("30/36: a late submit finalizes deterministically: TIME_LIMIT, saved answers kept, late final answers NOT applied")
    void lateSubmitFinalizesWithoutLateAnswers() {
        Instant past = Instant.now().minus(ExamDeadlinePolicy.WRITE_GRACE).minusSeconds(60);
        stub(attempt(ExamAttemptMode.EXAM_SIMULATION, ExamAttemptStatus.IN_PROGRESS, 6, past), past, ExamSectionState.ACTIVE);
        SubmitOutcome o = service.submitAttemptWithOutcome(USER, attemptId, submit(6, "late-answer"));
        assertFalse(o.replayed());
        assertEquals(1, o.finalResponsesNotApplied());
        assertEquals(ExamDeadlinePolicy.ATTEMPT_DEADLINE_PASSED, o.closure());
        verify(attempts, never()).upsertResponse(any(), any(), anyString(), any(), any(), any(), any(), anyBoolean(), any(), any());
        ArgumentCaptor<SubmissionRecord> sub = ArgumentCaptor.forClass(SubmissionRecord.class);
        verify(attempts).insertSubmission(sub.capture());
        assertEquals(SubmissionReason.TIME_LIMIT, sub.getValue().reason(), "server records the closure, not the client's reason");
        verify(attempts).updateAttemptSection(eq(attemptId), eq(sectionId), eq(ExamSectionState.COMPLETED), any(), any(), any());
    }

    @Test
    @DisplayName("submit before the deadline applies final answers only to the open section (never a sealed one)")
    void finalAnswersOnlyIntoOpenSection() {
        stub(attempt(ExamAttemptMode.EXAM_SIMULATION, ExamAttemptStatus.IN_PROGRESS, 6, Instant.now().plusSeconds(600)),
                Instant.now().plusSeconds(600), ExamSectionState.ACTIVE);
        SubmitOutcome ok = service.submitAttemptWithOutcome(USER, attemptId, submit(6, "A"));
        assertEquals(0, ok.finalResponsesNotApplied());
        verify(attempts).upsertResponse(any(), any(), eq("p1"), any(), any(), any(), any(), anyBoolean(), any(), any());

        reset(attempts);
        setUp();
        stub(attempt(ExamAttemptMode.EXAM_SIMULATION, ExamAttemptStatus.IN_PROGRESS, 6, Instant.now().plusSeconds(600)),
                Instant.now().plusSeconds(600), ExamSectionState.COMPLETED);
        SubmitOutcome sealed = service.submitAttemptWithOutcome(USER, attemptId, submit(6, "A"));
        assertEquals(1, sealed.finalResponsesNotApplied(), "an answer for a sealed section is not written");
        verify(attempts, never()).upsertResponse(any(), any(), anyString(), any(), any(), any(), any(), anyBoolean(), any(), any());
    }

    @Test
    @DisplayName("next-section deadline never exceeds the simulation's hard end (time away is not given back)")
    void capNextDeadline() {
        Instant end = Instant.now().plusSeconds(100);
        AttemptRecord sim = attempt(ExamAttemptMode.EXAM_SIMULATION, ExamAttemptStatus.IN_PROGRESS, 1, end);
        assertEquals(end, ExamDeadlinePolicy.capNextDeadline(sim, Instant.now().plusSeconds(3600)));
        Instant early = Instant.now().plusSeconds(50);
        assertEquals(early, ExamDeadlinePolicy.capNextDeadline(sim, early));
    }
}
