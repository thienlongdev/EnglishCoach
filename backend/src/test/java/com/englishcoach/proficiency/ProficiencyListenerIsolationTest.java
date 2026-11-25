package com.englishcoach.proficiency;

import com.englishcoach.common.event.DictationAttemptSubmittedEvent;
import com.englishcoach.common.event.ExamScoredEvent;
import com.englishcoach.common.event.RoleplayTurnRecordedEvent;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/** A failing proficiency pipeline never propagates into the publisher (source module). */
class ProficiencyListenerIsolationTest {

    @Test
    @DisplayName("Listener swallows every failure (RuntimeException and Error) and only logs")
    void failuresAreSwallowed() {
        ProficiencyIngestService ingest = mock(ProficiencyIngestService.class);
        when(ingest.ingestDictation(any())).thenThrow(new IllegalStateException("db down"));
        when(ingest.ingestRoleplay(any())).thenThrow(new OutOfMemoryError("simulated"));
        when(ingest.ingestExam(any())).thenThrow(new RuntimeException("boom"));
        ProficiencyEventListener listener = new ProficiencyEventListener(ingest);

        assertDoesNotThrow(() -> listener.on(new DictationAttemptSubmittedEvent(1L, 1L, 1L, 1L, 1L, "B1", 90.0, false, Instant.now())));
        assertDoesNotThrow(() -> listener.on(new RoleplayTurnRecordedEvent(1L, 1L, 1L, 1L, "A2", 70, 80, false, Instant.now())));
        assertDoesNotThrow(() -> listener.on(new ExamScoredEvent(1L, UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), 1,
                UUID.randomUUID(), "IELTS", "ACADEMIC", "FULL", "PRACTICE", "COMPLETED", Map.of(), Instant.now())));
        verify(ingest).ingestDictation(any());
        verify(ingest).ingestRoleplay(any());
        verify(ingest).ingestExam(any());
    }
}
