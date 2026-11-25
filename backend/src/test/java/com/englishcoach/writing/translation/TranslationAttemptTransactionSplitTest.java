package com.englishcoach.writing.translation;

import com.englishcoach.writing.client.WritingAiClient;
import com.englishcoach.writing.translation.dto.TranslationAttemptRequest;
import com.englishcoach.writing.translation.dto.TranslationAttemptResponse;
import com.englishcoach.writing.translation.dto.TranslationGradeAiResponse;
import com.englishcoach.writing.translation.entity.*;
import com.englishcoach.writing.translation.repository.*;
import com.englishcoach.writing.translation.service.TranslationAttemptService;
import com.englishcoach.writing.translation.service.TranslationDeterministicGrader;
import com.englishcoach.writing.translation.service.TranslationGradeCacheService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.AbstractPlatformTransactionManager;
import org.springframework.transaction.support.DefaultTransactionStatus;
import org.springframework.web.server.ResponseStatusException;

import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * PERF-02: a sentence-translation AI grade is awaited with no transaction (no pooled connection) open; the attempt is
 * written in a second short transaction that re-locks the session, replays a duplicate committed meanwhile and refuses a
 * session that moved to another unit.
 */
class TranslationAttemptTransactionSplitTest {

    /** Records whether a transaction is open, like the real one would hold a connection. */
    static final class RecordingTransactionManager extends AbstractPlatformTransactionManager {
        final AtomicBoolean open = new AtomicBoolean();
        final AtomicInteger begun = new AtomicInteger();
        @Override protected Object doGetTransaction() { return new Object(); }
        @Override protected void doBegin(Object transaction, TransactionDefinition definition) { open.set(true); begun.incrementAndGet(); }
        @Override protected void doCommit(DefaultTransactionStatus status) { open.set(false); }
        @Override protected void doRollback(DefaultTransactionStatus status) { open.set(false); }
    }

    private final Long userId = 7L;
    private final UUID sessionId = UUID.randomUUID();
    private final UUID exerciseId = UUID.randomUUID();
    private final UUID unitId = UUID.randomUUID();

    private TranslationSessionRepository sessions;
    private TranslationSessionUnitRepository sessionUnits;
    private TranslationAttemptRepository attempts;
    private TranslationGradeCacheService cache;
    private WritingAiClient ai;
    private RecordingTransactionManager tm;
    private TranslationAttemptService service;
    private TranslationSessionEntity session;

    @BeforeEach
    void setUp() {
        sessions = mock(TranslationSessionRepository.class);
        sessionUnits = mock(TranslationSessionUnitRepository.class);
        TranslationExerciseRepository exercises = mock(TranslationExerciseRepository.class);
        TranslationExerciseUnitRepository exerciseUnits = mock(TranslationExerciseUnitRepository.class);
        attempts = mock(TranslationAttemptRepository.class);
        TranslationDeterministicGrader grader = mock(TranslationDeterministicGrader.class);
        cache = mock(TranslationGradeCacheService.class);
        ai = mock(WritingAiClient.class);
        tm = new RecordingTransactionManager();
        service = new TranslationAttemptService(sessions, sessionUnits, exercises, exerciseUnits, attempts, grader, cache, ai, tm);

        session = TranslationSessionEntity.builder().id(sessionId).userId(userId).exerciseId(exerciseId).contentVersion(1)
                .status("ACTIVE").currentOrdinal((short) 1).sessionRevision(0L).build();
        TranslationSessionUnitEntity unit = TranslationSessionUnitEntity.builder().id(UUID.randomUUID()).sessionId(sessionId)
                .exerciseId(exerciseId).unitId(unitId).unitOrdinal((short) 1).build();
        when(sessions.findOwnedForUpdate(sessionId, userId)).thenReturn(Optional.of(session));
        when(sessionUnits.findBySessionIdAndUnitOrdinal(sessionId, (short) 1)).thenReturn(Optional.of(unit));
        when(sessionUnits.findBySessionIdOrderByUnitOrdinalAsc(sessionId)).thenReturn(List.of(unit));
        when(exerciseUnits.findById(unitId)).thenReturn(Optional.of(TranslationExerciseUnitEntity.builder().id(unitId)
                .sourceVi("Tôi thích đọc sách.").referenceEn("I like reading books.").build()));
        when(exercises.findById(exerciseId)).thenReturn(Optional.of(TranslationExerciseEntity.builder().id(exerciseId).build()));
        when(grader.evaluateExact(anyString(), anyString(), any())).thenReturn(Optional.empty());
        when(cache.computeFingerprint(anyLong(), any(), any(), anyString(), anyString(), anyString(), anyString())).thenReturn("fp");
        when(cache.getCachedResult(anyLong(), anyString())).thenReturn(Optional.empty());
        when(attempts.save(any())).thenAnswer(inv -> { TranslationAttemptEntity a = inv.getArgument(0); a.setId(UUID.randomUUID()); return a; });
    }

    private TranslationAttemptRequest submit(String mutation) {
        return TranslationAttemptRequest.builder().clientMutationId(mutation).answerText("I love to read books.").action("SUBMIT").build();
    }

    private TranslationGradeAiResponse accepted() {
        return TranslationGradeAiResponse.builder().overallStatus("ACCEPTED").meaningVerdict("ACCURATE").grammarVerdict("CORRECT")
                .issues(List.of()).build();
    }

    @Test
    void theProviderIsCalledWithNoTransactionOpenAndTheAttemptIsWrittenAfterwards() {
        AtomicBoolean openDuringAi = new AtomicBoolean(true);
        when(ai.gradeTranslation(any())).thenAnswer(inv -> { openDuringAi.set(tm.open.get()); return accepted(); });

        TranslationAttemptResponse r = service.submitAttempt(userId, sessionId, submit("m-1"));

        assertThat(openDuringAi.get()).isFalse();
        assertThat(tm.begun.get()).isEqualTo(2);
        assertThat(r.getAccepted()).isTrue();
        assertThat(r.getEvaluationStatus()).isEqualTo("ACCEPTED");
        verify(attempts, times(1)).save(any());
        verify(cache).putResult(eq(userId), eq("fp"), any(), any(), anyInt(), anyString(), anyString(), any(), any());
    }

    @Test
    void aDuplicateCommittedDuringTheWaitIsReturnedAndNothingIsWritten() {
        TranslationAttemptEntity first = TranslationAttemptEntity.builder().id(UUID.randomUUID()).userId(userId).sessionId(sessionId)
                .unitId(unitId).unitOrdinal((short) 1).attemptOrdinal(1).action("SUBMIT").evaluationStatus("ACCEPTED").accepted(true).build();
        when(attempts.findByUserIdAndClientMutationId(userId, "m-2")).thenReturn(Optional.empty(), Optional.of(first));
        when(ai.gradeTranslation(any())).thenReturn(accepted());

        TranslationAttemptResponse r = service.submitAttempt(userId, sessionId, submit("m-2"));

        assertThat(r.getAttemptId()).isEqualTo(first.getId());
        verify(attempts, never()).save(any());
    }

    @Test
    void aSessionThatMovedOnDuringTheWaitIsRefusedWithoutWriting() {
        when(ai.gradeTranslation(any())).thenAnswer(inv -> { session.setCurrentOrdinal((short) 2); return accepted(); });

        assertThatThrownBy(() -> service.submitAttempt(userId, sessionId, submit("m-3")))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("TRANSLATION_SESSION_MOVED");
        verify(attempts, never()).save(any());
    }

    @Test
    void aCacheHitNeedsOneTransactionAndNoProvider() {
        when(cache.getCachedResult(anyLong(), anyString())).thenReturn(Optional.of(
                com.englishcoach.writing.translation.dto.TranslationFeedbackDto.builder().overallStatus("NEEDS_REVISION").issues(List.of()).build()));

        TranslationAttemptResponse r = service.submitAttempt(userId, sessionId, submit("m-4"));

        assertThat(tm.begun.get()).isEqualTo(1);
        assertThat(r.getAccepted()).isFalse();
        verifyNoInteractions(ai);
        verify(attempts, times(1)).save(any());
    }
}
