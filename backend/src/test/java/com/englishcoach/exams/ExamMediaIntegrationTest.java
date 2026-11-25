package com.englishcoach.exams;

import com.englishcoach.exams.media.ExamMediaService;
import com.englishcoach.exams.media.ExamObjectStorage;
import com.englishcoach.exams.model.ExamAttemptRecords.AttemptRecord;
import com.englishcoach.exams.model.ExamMediaRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamMediaRepository;
import com.englishcoach.exams.service.ExamRightsService;
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
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

/**
 * STEP-103: ExamMediaIntegrationTest
 * Tests media upload integrity, SHA-256 validation, sealing immutability, and playback grants.
 */
@ExtendWith(MockitoExtension.class)
public class ExamMediaIntegrationTest {

    @Mock
    private ExamMediaRepository mediaRepository;

    @Mock
    private ExamAttemptRepository attemptRepository;

    @Mock
    private ExamRightsService rightsService;

    @Mock
    private ExamObjectStorage objectStorage;

    private ExamMediaService mediaService;

    @BeforeEach
    void setUp() {
        mediaService = new ExamMediaService(mediaRepository, attemptRepository, rightsService, objectStorage);
    }

    private RecordingRecord createTestRecording(UUID recId, UUID attemptId, RecordingState state) {
        return new RecordingRecord(
                recId,
                attemptId,
                UUID.randomUUID(),
                "p_part1_g1",
                Instant.now(),
                Instant.now().plusSeconds(600),
                "audio/webm",
                Map.of("mic", "default"),
                state,
                0,
                0L,
                List.of(),
                null,
                null,
                Map.of(),
                Instant.now()
        );
    }

    @Test
    @DisplayName("Media Security: Chunk upload rejects corrupted SHA-256 hash")
    void testChunkHashMismatchRejected() {
        UUID recId = UUID.randomUUID();
        UUID attemptId = UUID.randomUUID();
        Long userId = 1L;

        RecordingRecord rec = createTestRecording(recId, attemptId, RecordingState.RECORDING);
        AttemptRecord attempt = new AttemptRecord(
                attemptId, userId, UUID.randomUUID(), ExamFamily.IELTS, "ACADEMIC", "SPEAKING",
                ExamAttemptMode.EXAM_SIMULATION, null, null, ExamAttemptStatus.IN_PROGRESS,
                1L, 1L, null, null, "manifest_hash", null, Instant.now(), Instant.now(), null,
                null, null, List.of(), Instant.now(), Instant.now()
        );

        when(mediaRepository.findRecordingById(recId)).thenReturn(Optional.of(rec));
        when(attemptRepository.findAttemptById(attemptId)).thenReturn(Optional.of(attempt));

        byte[] sampleAudio = "audio chunk payload bytes".getBytes();
        String wrongHash = "0000000000000000000000000000000000000000000000000000000000000000";

        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class, () ->
                mediaService.saveChunk(userId, recId, 1, wrongHash, sampleAudio)
        );
        assertTrue(ex.getMessage().contains("Chunk hash mismatch"));
    }

    @Test
    @DisplayName("Media Security: Valid chunk passes SHA-256 verification and writes to object storage")
    void testValidChunkUploadSucceeds() {
        UUID recId = UUID.randomUUID();
        UUID attemptId = UUID.randomUUID();
        Long userId = 1L;

        RecordingRecord rec = createTestRecording(recId, attemptId, RecordingState.RECORDING);
        AttemptRecord attempt = new AttemptRecord(
                attemptId, userId, UUID.randomUUID(), ExamFamily.IELTS, "ACADEMIC", "SPEAKING",
                ExamAttemptMode.EXAM_SIMULATION, null, null, ExamAttemptStatus.IN_PROGRESS,
                1L, 1L, null, null, "manifest_hash", null, Instant.now(), Instant.now(), null,
                null, null, List.of(), Instant.now(), Instant.now()
        );

        when(mediaRepository.findRecordingById(recId)).thenReturn(Optional.of(rec));
        when(attemptRepository.findAttemptById(attemptId)).thenReturn(Optional.of(attempt));

        byte[] sampleAudio = "valid audio bytes chunk 1".getBytes();
        String expectedHash = ExamMediaService.computeSha256(sampleAudio);

        ExamMediaService.UploadChunkReceiptDto receipt = mediaService.saveChunk(
                userId, recId, 1, expectedHash, sampleAudio
        );

        assertNotNull(receipt);
        assertEquals(1, receipt.sequenceNumber());
        assertEquals(expectedHash, receipt.sha256Hash());
        verify(objectStorage).putObject(contains("chunk_0001.bin"), eq(sampleAudio), eq("audio/webm"));
    }

    @Test
    @DisplayName("Media Immutability: Post-seal chunk upload is rejected")
    void testUploadAfterSealRejected() {
        UUID recId = UUID.randomUUID();
        UUID attemptId = UUID.randomUUID();
        Long userId = 1L;

        // Sealed recording state
        RecordingRecord sealedRec = createTestRecording(recId, attemptId, RecordingState.SEALED);
        AttemptRecord attempt = new AttemptRecord(
                attemptId, userId, UUID.randomUUID(), ExamFamily.IELTS, "ACADEMIC", "SPEAKING",
                ExamAttemptMode.EXAM_SIMULATION, null, null, ExamAttemptStatus.IN_PROGRESS,
                1L, 1L, null, null, "manifest_hash", null, Instant.now(), Instant.now(), null,
                null, null, List.of(), Instant.now(), Instant.now()
        );

        when(mediaRepository.findRecordingById(recId)).thenReturn(Optional.of(sealedRec));
        when(attemptRepository.findAttemptById(attemptId)).thenReturn(Optional.of(attempt));

        byte[] sampleAudio = "late chunk".getBytes();
        IllegalStateException ex = assertThrows(IllegalStateException.class, () ->
                mediaService.saveChunk(userId, recId, 2, null, sampleAudio)
        );
        assertTrue(ex.getMessage().contains("already SEALED"));
    }
}
