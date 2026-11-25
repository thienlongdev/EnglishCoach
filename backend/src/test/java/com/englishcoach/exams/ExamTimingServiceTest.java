package com.englishcoach.exams;

import com.englishcoach.exams.model.ExamAttemptRecords.AttemptRecord;
import com.englishcoach.exams.model.ExamAttemptRecords.AttemptSectionRecord;
import com.englishcoach.exams.model.ExamAttemptRecords.SyncTimingResponseDto;
import com.englishcoach.exams.model.ExamContentRecords.SectionRecord;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.service.ExamTimingService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class ExamTimingServiceTest {

    @Mock
    private ExamAttemptRepository attemptRepository;

    @Mock
    private ExamContentRepository contentRepository;

    @InjectMocks
    private ExamTimingService timingService;

    private AttemptRecord createTestAttempt(UUID attemptId, UUID formId, ExamAttemptStatus status) {
        return new AttemptRecord(
                attemptId,
                1L,
                formId,
                ExamFamily.IELTS,
                "ACADEMIC",
                "FULL",
                ExamAttemptMode.EXAM_SIMULATION,
                null,
                null,
                status,
                0L,
                1L,
                "token",
                Instant.now().plus(1, ChronoUnit.HOURS),
                "hash",
                Map.of(),
                null,
                null,
                null,
                null,
                null,
                List.of(),
                Instant.now(),
                Instant.now()
        );
    }

    @Test
    @DisplayName("Initialize schedule sets first section ACTIVE with duration and rest PENDING")
    void testInitializeSchedule() {
        UUID formId = UUID.randomUUID();
        UUID attemptId = UUID.randomUUID();
        UUID sec1Id = UUID.randomUUID();
        UUID sec2Id = UUID.randomUUID();

        AttemptRecord attempt = createTestAttempt(attemptId, formId, ExamAttemptStatus.CREATED);

        SectionRecord sec1 = new SectionRecord(sec1Id, formId, SkillType.LISTENING, 1, "sec-1", UUID.randomUUID(), 1800, Map.of());
        SectionRecord sec2 = new SectionRecord(sec2Id, formId, SkillType.READING, 2, "sec-2", UUID.randomUUID(), 3600, Map.of());

        when(contentRepository.findSectionsByFormId(formId)).thenReturn(List.of(sec1, sec2));

        timingService.initializeSchedule(attempt);

        ArgumentCaptor<AttemptSectionRecord> sectionCaptor = ArgumentCaptor.forClass(AttemptSectionRecord.class);
        verify(attemptRepository, times(2)).insertAttemptSection(sectionCaptor.capture());

        List<AttemptSectionRecord> inserted = sectionCaptor.getAllValues();
        assertEquals(2, inserted.size());

        // First section should be ACTIVE
        assertEquals(ExamSectionState.ACTIVE, inserted.get(0).state());
        assertNotNull(inserted.get(0).startedAt());
        assertNotNull(inserted.get(0).deadlineAt());

        // Second section should be PENDING
        assertEquals(ExamSectionState.PENDING, inserted.get(1).state());
        assertNull(inserted.get(1).startedAt());

        // Attempt schedule updated to IN_PROGRESS
        verify(attemptRepository).updateAttemptSchedule(eq(attemptId), any(Instant.class), any(Instant.class), eq(ExamAttemptStatus.IN_PROGRESS), eq(0L));
    }

    @Test
    @DisplayName("Sync timing returns authoritative remaining seconds for active section")
    void testSyncTiming() {
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
}
