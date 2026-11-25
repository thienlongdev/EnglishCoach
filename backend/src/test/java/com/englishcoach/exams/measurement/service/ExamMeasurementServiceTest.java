package com.englishcoach.exams.measurement.service;

import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.*;
import com.englishcoach.exams.measurement.repository.ExamMeasurementRepository;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class ExamMeasurementServiceTest {

    @Mock ExamMeasurementRepository repository;
    @Mock ExamObjectiveScorer scorer;

    @Test
    void runtimeCollectionUsesDatabaseIdentityAndDoesNotAcceptHumanAssertions() {
        UUID attempt = UUID.randomUUID(), submission = UUID.randomUUID(), response = UUID.randomUUID();
        RuntimeObservationRow row = new RuntimeObservationRow(attempt, submission, response, 42L, UUID.randomUUID(), 2,
                "f".repeat(64), UUID.randomUUID(), 3, "i".repeat(64), ExamFamily.IELTS, "ACADEMIC", "READING",
                SkillType.READING, "MCQ", "EXAM_SIMULATION", "m".repeat(64), "s".repeat(64), 4,
                Map.of(), null, null, null, false, Map.of(), Map.of(), 1, 1.0, ExposureStatus.UNKNOWN, Instant.now());
        when(repository.findRuntimeObservationRows(attempt)).thenReturn(List.of(row));
        when(repository.latestConsentStatus(42L, "EXAMS_PILOT")).thenReturn(Optional.empty());
        UUID eventId = UUID.randomUUID();
        when(repository.insertEvent(eq(row), eq(ConsentStatus.UNKNOWN), isNull(), eq(SourceType.RUNTIME_EXPORT),
                eq(EvidenceClass.RUNTIME_OPERATIONAL), eq(OutcomeStatus.OMITTED), eq(OutcomeSource.UNAVAILABLE),
                eq(0.0), eq(1.0), isNull(), isNull(), eq(Map.of()), anyString(), eq(99L))).thenReturn(eventId);

        var service = new ExamMeasurementService(repository, scorer);
        assertEquals(List.of(eventId), service.collectRuntimeAttempt(attempt, 99L));
        verify(repository).insertEvent(eq(row), eq(ConsentStatus.UNKNOWN), isNull(), eq(SourceType.RUNTIME_EXPORT),
                eq(EvidenceClass.RUNTIME_OPERATIONAL), eq(OutcomeStatus.OMITTED), eq(OutcomeSource.UNAVAILABLE),
                eq(0.0), eq(1.0), isNull(), isNull(), eq(Map.of()), anyString(), eq(99L));
        verifyNoInteractions(scorer);
    }

    @Test
    void consentCannotBeRecordedByAnOperatorForAnotherUser() {
        var service = new ExamMeasurementService(repository, scorer);
        assertThrows(IllegalArgumentException.class,
                () -> service.recordPilotConsent(42L, 99L, "GRANTED", "a".repeat(64)));
        verifyNoInteractions(repository);
    }
}
