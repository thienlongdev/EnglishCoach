package com.englishcoach.exams.measurement.service;

import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.*;
import com.englishcoach.exams.measurement.repository.ExamMeasurementRepository;
import com.englishcoach.exams.media.ExamObjectStorage;
import com.englishcoach.exams.model.ExamMediaRecords.RecordingChunkRecord;
import com.englishcoach.exams.model.ExamMediaRecords.RecordingRecord;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.RecordingState;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.io.ByteArrayInputStream;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class ExamRaterServiceTest {

    @Mock ExamMeasurementRepository repository;
    @Mock com.englishcoach.exams.repository.ExamMediaRepository mediaRepository;
    @Mock ExamObjectStorage objectStorage;

    private GoldDataset dataset(String status) {
        return new GoldDataset(UUID.randomUUID(), "ielts-writing", 1, ExamFamily.IELTS, SkillType.WRITING,
                UUID.randomUUID(), "consent-v1", "participant-consented", status, null, null, 99L, Instant.now());
    }

    @Test
    void rejectsGoldMemberWithoutParticipantConsent() {
        UUID datasetId = UUID.randomUUID(), responseId = UUID.randomUUID(), attemptId = UUID.randomUUID(), consentId = UUID.randomUUID();
        when(repository.findGoldDataset(datasetId)).thenReturn(Optional.of(dataset("DRAFT")));
        when(repository.responseOwner(responseId)).thenReturn(Optional.of(7L));
        when(repository.grantedConsent(consentId, 7L, "EXAMS_HUMAN_RATING")).thenReturn(false);
        var service = new ExamRaterService(repository, mediaRepository, objectStorage);
        assertThrows(IllegalArgumentException.class, () -> service.addMember(datasetId, responseId, attemptId, consentId, Split.TEST, 99L));
        verify(repository, never()).insertGoldMember(any(), any(), any(), any(), any(), any(), any(), any());
    }

    @Test
    void assignmentRequiresIndependentRaterAndAssigningOperator() {
        UUID datasetId = UUID.randomUUID();
        when(repository.findGoldDataset(datasetId)).thenReturn(Optional.of(dataset("LOCKED")));
        var service = new ExamRaterService(repository, mediaRepository, objectStorage);
        assertThrows(IllegalArgumentException.class, () -> service.assign(datasetId, UUID.randomUUID(), UUID.randomUUID(), 7L, 7L));
        verify(repository, never()).createRaterAssignment(any(), any(), any(), any(), any(), any(), any());
    }

    @Test
    void ratingIdentityComesFromAuthenticatedActorAndAdjudicationNeedsSeparateEvidence() {
        UUID assignmentId = UUID.randomUUID();
        when(repository.findRaterAssignment(assignmentId)).thenReturn(Optional.of(new RaterAssignment(assignmentId, UUID.randomUUID(),
                UUID.randomUUID(), UUID.randomUUID(), ExamFamily.IELTS, SkillType.WRITING, 7L, 99L, true, "ASSIGNED", Instant.now())));
        var service = new ExamRaterService(repository, mediaRepository, objectStorage);
        RatingSubmission request = new RatingSubmission(assignmentId, 999L, UUID.randomUUID(), Map.of("grammar", 5), 5.0, .8, "a".repeat(64));
        service.rate(request, 7L);
        ArgumentCaptor<RatingSubmission> captor = ArgumentCaptor.forClass(RatingSubmission.class);
        verify(repository).insertRating(captor.capture(), eq(7L));
        assertEquals(7L, captor.getValue().raterUserId());
    }

    @Test
    void wrongRaterCannotOpenAnotherRatersRecording() {
        UUID assignmentId = UUID.randomUUID();
        when(repository.findRaterRecordingAccess(assignmentId, 7L)).thenReturn(Optional.empty());
        var service = new ExamRaterService(repository, mediaRepository, objectStorage);
        assertThrows(SecurityException.class, () -> service.openRecording(assignmentId, 7L));
        verifyNoInteractions(mediaRepository, objectStorage);
    }

    @Test
    void withdrawnParticipantConsentBlocksRecordingEvenForAnAssignedRater() {
        UUID assignmentId = UUID.randomUUID();
        // The repository's consent/member query returns no access once the linked
        // EXAMS_HUMAN_RATING consent is withdrawn.
        when(repository.findRaterRecordingAccess(assignmentId, 7L)).thenReturn(Optional.empty());
        var service = new ExamRaterService(repository, mediaRepository, objectStorage);
        assertThrows(SecurityException.class, () -> service.openRecording(assignmentId, 7L));
        verifyNoInteractions(mediaRepository, objectStorage);
    }

    @Test
    void authorizedRaterReceivesOnlySealedLinkedRecordingBytes() throws Exception {
        UUID assignmentId = UUID.randomUUID(), datasetId = UUID.randomUUID(), attemptId = UUID.randomUUID();
        UUID responseId = UUID.randomUUID(), recordingId = UUID.randomUUID();
        when(repository.findRaterRecordingAccess(assignmentId, 7L))
                .thenReturn(Optional.of(new RaterRecordingAccess(assignmentId, datasetId, attemptId, responseId, recordingId)));
        when(mediaRepository.findRecordingById(recordingId)).thenReturn(Optional.of(new RecordingRecord(
                recordingId, attemptId, responseId, "speaking-1", Instant.now(), Instant.now(), "audio/webm",
                Map.of(), RecordingState.SEALED, 1, 4L, List.of(), null, null, Map.of(), Instant.now())));
        when(mediaRepository.findChunksByRecordingId(recordingId)).thenReturn(List.of(new RecordingChunkRecord(
                UUID.randomUUID(), recordingId, 0, "recordings/r/chunk_0000.bin", "a".repeat(64), 4L, Instant.now())));
        when(objectStorage.getObjectStream("recordings/r/chunk_0000.bin"))
                .thenReturn(new ByteArrayInputStream(new byte[]{1, 2, 3, 4}));

        var service = new ExamRaterService(repository, mediaRepository, objectStorage);
        var opened = service.openRecording(assignmentId, 7L);
        assertArrayEquals(new byte[]{1, 2, 3, 4}, opened.stream().readAllBytes());
        assertEquals("audio/webm", opened.contentType());
        verify(repository).findRaterRecordingAccess(assignmentId, 7L);
    }
}
