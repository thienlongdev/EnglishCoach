package com.englishcoach.exams;

import com.englishcoach.exams.exception.ExamConcurrencyException;
import com.englishcoach.exams.exception.ExamExceptionHandler.ExamForbiddenException;
import com.englishcoach.exams.media.ExamMediaService;
import com.englishcoach.exams.media.ExamObjectStorage;
import com.englishcoach.exams.model.ExamAttemptRecords.AttemptRecord;
import com.englishcoach.exams.model.ExamAttemptRecords.AttemptSectionRecord;
import com.englishcoach.exams.model.ExamAttemptRecords.CommandReceiptRecord;
import com.englishcoach.exams.model.ExamAttemptRecords.ResponseRecord;
import com.englishcoach.exams.model.ExamMediaRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamMediaRepository;
import com.englishcoach.exams.service.ExamRightsService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
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
 * EXAMS-V4-14: ExamMediaIdempotencyTest
 * Comprehensive verification of recording turn binding, idempotent chunk replay,
 * sequence collision conflict guards, out-of-turn rejection, and seal proof.
 */
@ExtendWith(MockitoExtension.class)
public class ExamMediaIdempotencyTest {

    @Mock
    private ExamMediaRepository mediaRepository;

    @Mock
    private ExamAttemptRepository attemptRepository;

    @Mock
    private ExamRightsService rightsService;

    @Mock
    private ExamObjectStorage objectStorage;

    private ExamMediaService mediaService;

    private final Long USER_ID = 42L;
    private final UUID ATTEMPT_ID = UUID.randomUUID();
    private final UUID SECTION_ID = UUID.randomUUID();
    private final UUID RESPONSE_ID = UUID.randomUUID();
    private final String CURRENT_TURN_KEY = "speak_p1_g_intro_i_01";
    private final String FUTURE_TURN_KEY = "speak_p2_g_cue_i_01";

    @BeforeEach
    void setUp() {
        mediaService = new ExamMediaService(mediaRepository, attemptRepository, rightsService, objectStorage);
    }

    private AttemptRecord createTestAttempt(ExamAttemptStatus status) {
        return new AttemptRecord(
                ATTEMPT_ID, USER_ID, UUID.randomUUID(), ExamFamily.IELTS, "ACADEMIC", "SPEAKING",
                ExamAttemptMode.EXAM_SIMULATION, null, null, status,
                5L, 1L, null, null, "manifest_hash", null, Instant.now(), Instant.now(), null,
                null, null, List.of(), Instant.now(), Instant.now()
        );
    }

    private AttemptSectionRecord createSpeakingSection() {
        return new AttemptSectionRecord(
                UUID.randomUUID(), ATTEMPT_ID, SECTION_ID, ExamSectionState.ACTIVE, "MAIN",
                Instant.now(), Instant.now().plusSeconds(1200), null, Map.of(), Instant.now(),
                "placement_speaking_p1", CURRENT_TURN_KEY, 0, 1L
        );
    }

    private ResponseRecord createTestResponse(UUID respId, String turnKey) {
        return new ResponseRecord(
                respId, ATTEMPT_ID, SECTION_ID, "placement_speaking_p1", UUID.randomUUID(),
                Map.of(), null, null, false, 1L, "cmd-prev", Instant.now(),
                turnKey, 1, "SPEAKING_TURN", "READY_TO_RECORD", Map.of(), null
        );
    }

    private RecordingRecord createRecording(UUID recId, RecordingState state, UUID respId) {
        return new RecordingRecord(
                recId, ATTEMPT_ID, respId, "placement_speaking_p1",
                Instant.now(), Instant.now().plusSeconds(600), "audio/webm",
                Map.of("mic", "test"), state, 0, 0L, List.of(),
                null, null, Map.of(), Instant.now(),
                respId != null ? 0 : null, null, null, "NOT_REQUESTED", null, "PENDING"
        );
    }

    @Test
    @DisplayName("Chunk 14 Gate 1: Recording initiation binds to active turn response and sets generation 0")
    void testInitiateRecordingBindsToCurrentTurnAndResponse() {
        AttemptRecord attempt = createTestAttempt(ExamAttemptStatus.IN_PROGRESS);
        AttemptSectionRecord section = createSpeakingSection();
        ResponseRecord response = createTestResponse(RESPONSE_ID, CURRENT_TURN_KEY);

        when(attemptRepository.findAttemptById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findSectionsByAttemptId(ATTEMPT_ID)).thenReturn(List.of(section));
        when(attemptRepository.findSpeakingResponsesByAttemptAndSection(ATTEMPT_ID, SECTION_ID)).thenReturn(List.of(response));
        when(mediaRepository.countRecordingsForResponse(RESPONSE_ID)).thenReturn(0);

        UUID generatedRecId = UUID.randomUUID();
        when(mediaRepository.insertRecording(any(RecordingRecord.class))).thenReturn(generatedRecId);

        InitiateRecordingRequest req = new InitiateRecordingRequest(
                ATTEMPT_ID, "placement_speaking_p1", "audio/webm", Map.of(), CURRENT_TURN_KEY, "cmd-init-1", 5L
        );

        InitiateRecordingResponseDto res = mediaService.initiateRecording(USER_ID, ATTEMPT_ID, req);

        assertNotNull(res);
        assertEquals(generatedRecId, res.recordingId());
        assertEquals(CURRENT_TURN_KEY, res.turnKey());
        assertEquals(RESPONSE_ID, res.responseId());
        assertEquals(RecordingState.RECORDING, res.state());

        // Verify recording record had responseId and generation 0
        ArgumentCaptor<RecordingRecord> captor = ArgumentCaptor.forClass(RecordingRecord.class);
        verify(mediaRepository).insertRecording(captor.capture());
        RecordingRecord captured = captor.getValue();
        assertEquals(RESPONSE_ID, captured.responseId());
        assertEquals(0, captured.generation());
        assertNull(captured.supersedesRecordingId());

        // Verify response state updated to RECORDING
        verify(attemptRepository).updateSpeakingTurnState(ATTEMPT_ID, CURRENT_TURN_KEY, "RECORDING", generatedRecId, "cmd-init-1");
    }

    @Test
    @DisplayName("Chunk 14 Gate 2: Out-of-turn recording initiation is strictly rejected with 403 Forbidden")
    void testInitiateRecordingRejectsOutOfTurn() {
        AttemptRecord attempt = createTestAttempt(ExamAttemptStatus.IN_PROGRESS);
        AttemptSectionRecord section = createSpeakingSection();

        when(attemptRepository.findAttemptById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findSectionsByAttemptId(ATTEMPT_ID)).thenReturn(List.of(section));

        InitiateRecordingRequest req = new InitiateRecordingRequest(
                ATTEMPT_ID, "placement_speaking_p2", "audio/webm", Map.of(), FUTURE_TURN_KEY, "cmd-future", 5L
        );

        ExamForbiddenException ex = assertThrows(ExamForbiddenException.class, () ->
                mediaService.initiateRecording(USER_ID, ATTEMPT_ID, req)
        );
        assertTrue(ex.getMessage().contains("OUT_OF_TURN_RECORDING"));
        assertTrue(ex.getMessage().contains(FUTURE_TURN_KEY));
        verify(mediaRepository, never()).insertRecording(any());
    }

    @Test
    @DisplayName("Chunk 14 Gate 3: Valid chunk upload persists to object storage and records receipt")
    void testSaveChunkAcceptsValidChunk() {
        UUID recId = UUID.randomUUID();
        RecordingRecord rec = createRecording(recId, RecordingState.RECORDING, RESPONSE_ID);
        AttemptRecord attempt = createTestAttempt(ExamAttemptStatus.IN_PROGRESS);
        AttemptSectionRecord section = createSpeakingSection();
        ResponseRecord response = createTestResponse(RESPONSE_ID, CURRENT_TURN_KEY);

        when(mediaRepository.findRecordingById(recId)).thenReturn(Optional.of(rec));
        when(attemptRepository.findAttemptById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findSectionsByAttemptId(ATTEMPT_ID)).thenReturn(List.of(section));
        when(attemptRepository.findSpeakingResponsesByAttemptAndSection(ATTEMPT_ID, SECTION_ID)).thenReturn(List.of(response));
        when(mediaRepository.findChunkByRecordingAndSequence(recId, 0)).thenReturn(Optional.empty());

        byte[] chunkBytes = "test audio chunk bytes sequence 0".getBytes();
        String hash = ExamMediaService.computeSha256(chunkBytes);

        RecordingChunkRecord storedChunk = new RecordingChunkRecord(UUID.randomUUID(), recId, 0, "objKey", hash, chunkBytes.length, Instant.now());
        when(mediaRepository.findChunksByRecordingId(recId)).thenReturn(List.of(storedChunk));

        ExamMediaService.UploadChunkReceiptDto receipt = mediaService.saveChunk(USER_ID, recId, 0, hash, chunkBytes);

        assertNotNull(receipt);
        assertEquals(recId, receipt.recordingId());
        assertEquals(0, receipt.sequenceNumber());
        assertEquals(hash, receipt.sha256Hash());
        assertEquals("ACCEPTED", receipt.status());
        assertEquals(1, receipt.acknowledgedChunkCount());

        verify(objectStorage).putObject(contains("chunk_0000.bin"), eq(chunkBytes), eq("audio/webm"));
        verify(mediaRepository).insertRecordingChunk(any(RecordingChunkRecord.class));
    }

    @Test
    @DisplayName("Chunk 14 Gate 4: Duplicate chunk replay with identical hash/size returns existing receipt idempotently")
    void testSaveChunkIdempotentReplayReturnsSameReceipt() {
        UUID recId = UUID.randomUUID();
        RecordingRecord rec = createRecording(recId, RecordingState.RECORDING, RESPONSE_ID);
        AttemptRecord attempt = createTestAttempt(ExamAttemptStatus.IN_PROGRESS);
        AttemptSectionRecord section = createSpeakingSection();
        ResponseRecord response = createTestResponse(RESPONSE_ID, CURRENT_TURN_KEY);

        byte[] chunkBytes = "sample chunk audio payload".getBytes();
        String hash = ExamMediaService.computeSha256(chunkBytes);

        RecordingChunkRecord existing = new RecordingChunkRecord(
                UUID.randomUUID(), recId, 0, "recordings/" + recId + "/chunk_0000.bin",
                hash, chunkBytes.length, Instant.now()
        );

        when(mediaRepository.findRecordingById(recId)).thenReturn(Optional.of(rec));
        when(attemptRepository.findAttemptById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findSectionsByAttemptId(ATTEMPT_ID)).thenReturn(List.of(section));
        when(attemptRepository.findSpeakingResponsesByAttemptAndSection(ATTEMPT_ID, SECTION_ID)).thenReturn(List.of(response));
        when(mediaRepository.findChunkByRecordingAndSequence(recId, 0)).thenReturn(Optional.of(existing));
        when(mediaRepository.findChunksByRecordingId(recId)).thenReturn(List.of(existing));

        // Upload exact same chunk again
        ExamMediaService.UploadChunkReceiptDto receipt = mediaService.saveChunk(USER_ID, recId, 0, hash, chunkBytes);

        assertNotNull(receipt);
        assertEquals(0, receipt.sequenceNumber());
        assertEquals(hash, receipt.sha256Hash());
        assertEquals("ACCEPTED", receipt.status());
        assertEquals(1, receipt.acknowledgedChunkCount());

        // Must NOT write to storage again and must NOT re-insert into DB
        verify(objectStorage, never()).putObject(any(), any(), any());
        verify(mediaRepository, never()).insertRecordingChunk(any());
    }

    @Test
    @DisplayName("Chunk 14 Gate 5: Chunk sequence collision with different payload throws CHUNK_SEQUENCE_COLLISION conflict")
    void testSaveChunkSequenceCollisionThrowsConflict() {
        UUID recId = UUID.randomUUID();
        RecordingRecord rec = createRecording(recId, RecordingState.RECORDING, RESPONSE_ID);
        AttemptRecord attempt = createTestAttempt(ExamAttemptStatus.IN_PROGRESS);
        AttemptSectionRecord section = createSpeakingSection();
        ResponseRecord response = createTestResponse(RESPONSE_ID, CURRENT_TURN_KEY);

        RecordingChunkRecord existing = new RecordingChunkRecord(
                UUID.randomUUID(), recId, 0, "recordings/" + recId + "/chunk_0000.bin",
                "original_sha256_hash_111111111111111111111111111111111111111111", 500, Instant.now()
        );

        when(mediaRepository.findRecordingById(recId)).thenReturn(Optional.of(rec));
        when(attemptRepository.findAttemptById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findSectionsByAttemptId(ATTEMPT_ID)).thenReturn(List.of(section));
        when(attemptRepository.findSpeakingResponsesByAttemptAndSection(ATTEMPT_ID, SECTION_ID)).thenReturn(List.of(response));
        when(mediaRepository.findChunkByRecordingAndSequence(recId, 0)).thenReturn(Optional.of(existing));

        byte[] conflictingBytes = "different conflicting audio bytes for sequence 0".getBytes();
        String conflictingHash = ExamMediaService.computeSha256(conflictingBytes);

        ExamConcurrencyException ex = assertThrows(ExamConcurrencyException.class, () ->
                mediaService.saveChunk(USER_ID, recId, 0, conflictingHash, conflictingBytes)
        );
        assertEquals("CHUNK_SEQUENCE_COLLISION", ex.getCode());
        assertTrue(ex.getMessage().contains("already exists with conflicting hash"));
    }

    @Test
    @DisplayName("Chunk 14 Gate 6: Chunk upload for an out-of-turn recording is rejected and cannot mutate")
    void testSaveChunkRejectsOutOfTurnChunk() {
        UUID recId = UUID.randomUUID();
        // Recording is bound to turn 1
        RecordingRecord rec = createRecording(recId, RecordingState.RECORDING, RESPONSE_ID);
        AttemptRecord attempt = createTestAttempt(ExamAttemptStatus.IN_PROGRESS);

        // But section current turn has already advanced to Part 2!
        AttemptSectionRecord advancedSection = new AttemptSectionRecord(
                UUID.randomUUID(), ATTEMPT_ID, SECTION_ID, ExamSectionState.ACTIVE, "MAIN",
                Instant.now(), Instant.now().plusSeconds(1200), null, Map.of(), Instant.now(),
                "placement_speaking_p2", FUTURE_TURN_KEY, 1, 2L
        );
        ResponseRecord oldTurnResponse = createTestResponse(RESPONSE_ID, CURRENT_TURN_KEY);

        when(mediaRepository.findRecordingById(recId)).thenReturn(Optional.of(rec));
        when(attemptRepository.findAttemptById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findSectionsByAttemptId(ATTEMPT_ID)).thenReturn(List.of(advancedSection));
        when(attemptRepository.findSpeakingResponsesByAttemptAndSection(ATTEMPT_ID, SECTION_ID)).thenReturn(List.of(oldTurnResponse));

        byte[] chunkData = "audio data for old turn".getBytes();
        String hash = ExamMediaService.computeSha256(chunkData);

        IllegalStateException ex = assertThrows(IllegalStateException.class, () ->
                mediaService.saveChunk(USER_ID, recId, 0, hash, chunkData)
        );
        assertTrue(ex.getMessage().contains("OUT_OF_TURN_CHUNK"));
        assertTrue(ex.getMessage().contains(CURRENT_TURN_KEY));
        verify(mediaRepository, never()).insertRecordingChunk(any());
    }

    @Test
    @DisplayName("Chunk 14 Gate 7: Post-seal chunk upload is rejected with RECORDING_SEALED_IMMUTABLE")
    void testSaveChunkRejectsPostSeal() {
        UUID recId = UUID.randomUUID();
        RecordingRecord sealedRec = createRecording(recId, RecordingState.SEALED, RESPONSE_ID);
        AttemptRecord attempt = createTestAttempt(ExamAttemptStatus.IN_PROGRESS);

        when(mediaRepository.findRecordingById(recId)).thenReturn(Optional.of(sealedRec));
        when(attemptRepository.findAttemptById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));

        byte[] chunkData = "bytes after seal".getBytes();
        String hash = ExamMediaService.computeSha256(chunkData);

        IllegalStateException ex = assertThrows(IllegalStateException.class, () ->
                mediaService.saveChunk(USER_ID, recId, 1, hash, chunkData)
        );
        assertTrue(ex.getMessage().contains("RECORDING_SEALED_IMMUTABLE"));
    }

    @Test
    @DisplayName("Chunk 14 Gate 8: Sealing an already sealed recording is idempotent and returns existing stats")
    void testSealRecordingIdempotent() {
        UUID recId = UUID.randomUUID();
        RecordingRecord sealedRec = new RecordingRecord(
                recId, ATTEMPT_ID, RESPONSE_ID, "placement_speaking_p1",
                Instant.now(), Instant.now().plusSeconds(600), "audio/webm",
                Map.of(), RecordingState.SEALED, 3, 15000L, List.of(),
                null, null, Map.of(), Instant.now(),
                0, null, null, "NOT_REQUESTED", null, "READY"
        );
        AttemptRecord attempt = createTestAttempt(ExamAttemptStatus.IN_PROGRESS);

        when(mediaRepository.findRecordingById(recId)).thenReturn(Optional.of(sealedRec));
        when(attemptRepository.findAttemptById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));

        SealRecordingRequest req = new SealRecordingRequest(List.of(), 15000L, "hash");
        SealRecordingResponseDto res = mediaService.sealRecording(USER_ID, recId, req);

        assertNotNull(res);
        assertEquals(RecordingState.SEALED, res.state());
        assertEquals(3, res.chunkCount());
        assertEquals(15000L, res.totalBytes());
        assertTrue(res.isComplete());

        verify(mediaRepository, never()).updateRecordingSealed(any(), any(), anyInt(), anyLong(), any());
    }

    @Test
    @DisplayName("Chunk 14 Gate 9: Sealing recording with 0 chunks is rejected with EMPTY_RECORDING_SEAL_REJECTED")
    void testSealRecordingRejectsEmptyChunks() {
        UUID recId = UUID.randomUUID();
        RecordingRecord rec = createRecording(recId, RecordingState.UPLOADING, RESPONSE_ID);
        AttemptRecord attempt = createTestAttempt(ExamAttemptStatus.IN_PROGRESS);

        when(mediaRepository.findRecordingById(recId)).thenReturn(Optional.of(rec));
        when(attemptRepository.findAttemptById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
        when(mediaRepository.findChunksByRecordingId(recId)).thenReturn(List.of());

        SealRecordingRequest req = new SealRecordingRequest(List.of(), 0L, "hash");
        IllegalStateException ex = assertThrows(IllegalStateException.class, () ->
                mediaService.sealRecording(USER_ID, recId, req)
        );
        assertTrue(ex.getMessage().contains("EMPTY_RECORDING_SEAL_REJECTED"));
    }

    @Test
    @DisplayName("Chunk 14 Gate 10: Non-contiguous chunk sequences are rejected during seal proof")
    void testSealRecordingRejectsNonContiguousChunks() {
        UUID recId = UUID.randomUUID();
        RecordingRecord rec = createRecording(recId, RecordingState.UPLOADING, RESPONSE_ID);
        AttemptRecord attempt = createTestAttempt(ExamAttemptStatus.IN_PROGRESS);

        // Sequence 0 and Sequence 2 (Sequence 1 is missing!)
        RecordingChunkRecord chunk0 = new RecordingChunkRecord(UUID.randomUUID(), recId, 0, "k0", "h0", 100, Instant.now());
        RecordingChunkRecord chunk2 = new RecordingChunkRecord(UUID.randomUUID(), recId, 2, "k2", "h2", 100, Instant.now());

        when(mediaRepository.findRecordingById(recId)).thenReturn(Optional.of(rec));
        when(attemptRepository.findAttemptById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
        when(mediaRepository.findChunksByRecordingId(recId)).thenReturn(List.of(chunk0, chunk2));

        SealRecordingRequest req = new SealRecordingRequest(List.of(), 200L, "hash");
        IllegalStateException ex = assertThrows(IllegalStateException.class, () ->
                mediaService.sealRecording(USER_ID, recId, req)
        );
        assertTrue(ex.getMessage().contains("NON_CONTIGUOUS_CHUNKS"));
        assertTrue(ex.getMessage().contains("Missing chunk sequence 1"));
    }

    @Test
    @DisplayName("Chunk 15 Gate 1: Client totalChunks or totalBytes mismatch is rejected with SEAL_MANIFEST_MISMATCH")
    void testSealRecordingRejectsClientManifestMismatch() {
        UUID recId = UUID.randomUUID();
        RecordingRecord rec = createRecording(recId, RecordingState.UPLOADING, RESPONSE_ID);
        AttemptRecord attempt = createTestAttempt(ExamAttemptStatus.IN_PROGRESS);

        RecordingChunkRecord chunk0 = new RecordingChunkRecord(UUID.randomUUID(), recId, 0, "k0", "h0", 100, Instant.now());

        when(mediaRepository.findRecordingById(recId)).thenReturn(Optional.of(rec));
        when(attemptRepository.findAttemptById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
        when(mediaRepository.findChunksByRecordingId(recId)).thenReturn(List.of(chunk0));

        // Client says 2 chunks, server only has 1
        SealRecordingRequest reqChunkMismatch = new SealRecordingRequest(List.of(), 100L, "h0", 2, "h0");
        IllegalArgumentException ex1 = assertThrows(IllegalArgumentException.class, () ->
                mediaService.sealRecording(USER_ID, recId, reqChunkMismatch)
        );
        assertTrue(ex1.getMessage().contains("SEAL_MANIFEST_MISMATCH"));
        assertTrue(ex1.getMessage().contains("totalChunks"));

        // Client says 500 bytes, server only has 100
        SealRecordingRequest reqByteMismatch = new SealRecordingRequest(List.of(), 500L, "h0", 1, "h0");
        IllegalArgumentException ex2 = assertThrows(IllegalArgumentException.class, () ->
                mediaService.sealRecording(USER_ID, recId, reqByteMismatch)
        );
        assertTrue(ex2.getMessage().contains("SEAL_MANIFEST_MISMATCH"));
        assertTrue(ex2.getMessage().contains("totalBytes"));
    }

    @Test
    @DisplayName("Chunk 15 Gate 2: Sealing recording with 0 total bytes is rejected with ZERO_BYTES_SEAL_REJECTED")
    void testSealRecordingRejectsZeroTotalBytes() {
        UUID recId = UUID.randomUUID();
        RecordingRecord rec = createRecording(recId, RecordingState.UPLOADING, RESPONSE_ID);
        AttemptRecord attempt = createTestAttempt(ExamAttemptStatus.IN_PROGRESS);

        RecordingChunkRecord emptyChunk = new RecordingChunkRecord(UUID.randomUUID(), recId, 0, "k0", "h0", 0L, Instant.now());

        when(mediaRepository.findRecordingById(recId)).thenReturn(Optional.of(rec));
        when(attemptRepository.findAttemptById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
        when(mediaRepository.findChunksByRecordingId(recId)).thenReturn(List.of(emptyChunk));

        SealRecordingRequest req = new SealRecordingRequest(List.of(), 0L, "hash");
        IllegalStateException ex = assertThrows(IllegalStateException.class, () ->
                mediaService.sealRecording(USER_ID, recId, req)
        );
        assertTrue(ex.getMessage().contains("ZERO_BYTES_SEAL_REJECTED"));
    }

    @Test
    @DisplayName("Chunk 15 Gate 3: Explicit failRecording transitions state to FAILED and records error code")
    void testFailRecordingTransitionsStateAndRecordsCode() {
        UUID recId = UUID.randomUUID();
        RecordingRecord rec = createRecording(recId, RecordingState.RECORDING, RESPONSE_ID);
        AttemptRecord attempt = createTestAttempt(ExamAttemptStatus.IN_PROGRESS);

        when(mediaRepository.findRecordingById(recId)).thenReturn(Optional.of(rec));
        when(attemptRepository.findAttemptById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));

        mediaService.failRecording(USER_ID, recId, "NETWORK_TIMEOUT_UPLOAD_INTERRUPTED");

        verify(mediaRepository).updateRecordingFailed(recId, "NETWORK_TIMEOUT_UPLOAD_INTERRUPTED");
    }

    @Test
    @DisplayName("Chunk 15 Gate 4: failRecording rejects failing an already SEALED recording")
    void testFailRecordingCannotFailSealed() {
        UUID recId = UUID.randomUUID();
        RecordingRecord sealedRec = createRecording(recId, RecordingState.SEALED, RESPONSE_ID);
        AttemptRecord attempt = createTestAttempt(ExamAttemptStatus.IN_PROGRESS);

        when(mediaRepository.findRecordingById(recId)).thenReturn(Optional.of(sealedRec));
        when(attemptRepository.findAttemptById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));

        IllegalStateException ex = assertThrows(IllegalStateException.class, () ->
                mediaService.failRecording(USER_ID, recId, "ATTEMPT_FAIL")
        );
        assertTrue(ex.getMessage().contains("RECORDING_SEALED_IMMUTABLE"));
        verify(mediaRepository, never()).updateRecordingFailed(any(), any());
    }

    @Test
    @DisplayName("Chunk 15 Gate 5: Retry on failed recording creates new generation 1 linked to same response and superseding gen 0")
    void testNewGenerationRetryOnFailedRecording() {
        AttemptRecord attempt = createTestAttempt(ExamAttemptStatus.IN_PROGRESS);
        AttemptSectionRecord section = createSpeakingSection();
        ResponseRecord response = createTestResponse(RESPONSE_ID, CURRENT_TURN_KEY);

        UUID failedRecId = UUID.randomUUID();
        RecordingRecord failedGen0 = new RecordingRecord(
                failedRecId, ATTEMPT_ID, RESPONSE_ID, "placement_speaking_p1",
                Instant.now(), Instant.now().plusSeconds(600), "audio/webm",
                Map.of(), RecordingState.FAILED, 1, 500L, List.of(),
                null, null, Map.of(), Instant.now(),
                0, null, null, "NOT_REQUESTED", null, "FAILED"
        );

        when(attemptRepository.findAttemptById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findSectionsByAttemptId(ATTEMPT_ID)).thenReturn(List.of(section));
        when(attemptRepository.findSpeakingResponsesByAttemptAndSection(ATTEMPT_ID, SECTION_ID)).thenReturn(List.of(response));
        when(mediaRepository.countRecordingsForResponse(RESPONSE_ID)).thenReturn(1);
        when(mediaRepository.findLatestRecordingByResponseId(RESPONSE_ID)).thenReturn(Optional.of(failedGen0));

        UUID newRecId = UUID.randomUUID();
        when(mediaRepository.insertRecording(any(RecordingRecord.class))).thenReturn(newRecId);

        InitiateRecordingRequest req = new InitiateRecordingRequest(
                ATTEMPT_ID, "placement_speaking_p1", "audio/webm", Map.of(), CURRENT_TURN_KEY, "cmd-retry-1", 5L
        );

        InitiateRecordingResponseDto res = mediaService.initiateRecording(USER_ID, ATTEMPT_ID, req);

        assertNotNull(res);
        assertEquals(newRecId, res.recordingId());

        ArgumentCaptor<RecordingRecord> captor = ArgumentCaptor.forClass(RecordingRecord.class);
        verify(mediaRepository).insertRecording(captor.capture());
        RecordingRecord captured = captor.getValue();

        assertEquals(RESPONSE_ID, captured.responseId());
        assertEquals(1, captured.generation());
        assertEquals(failedRecId, captured.supersedesRecordingId());
        assertEquals(RecordingState.RECORDING, captured.state());
    }

    @Test
    @DisplayName("Chunk 15 Gate 6: Re-initiating an unsealed recording supersedes it as FAILED before creating next generation")
    void testInitiateRecordingSupersedesUnsealedRecording() {
        AttemptRecord attempt = createTestAttempt(ExamAttemptStatus.IN_PROGRESS);
        AttemptSectionRecord section = createSpeakingSection();
        ResponseRecord response = createTestResponse(RESPONSE_ID, CURRENT_TURN_KEY);

        UUID unsealedRecId = UUID.randomUUID();
        RecordingRecord unsealedGen0 = createRecording(unsealedRecId, RecordingState.UPLOADING, RESPONSE_ID);

        when(attemptRepository.findAttemptById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findSectionsByAttemptId(ATTEMPT_ID)).thenReturn(List.of(section));
        when(attemptRepository.findSpeakingResponsesByAttemptAndSection(ATTEMPT_ID, SECTION_ID)).thenReturn(List.of(response));
        when(mediaRepository.countRecordingsForResponse(RESPONSE_ID)).thenReturn(1);
        when(mediaRepository.findLatestRecordingByResponseId(RESPONSE_ID)).thenReturn(Optional.of(unsealedGen0));

        UUID newRecId = UUID.randomUUID();
        when(mediaRepository.insertRecording(any(RecordingRecord.class))).thenReturn(newRecId);

        InitiateRecordingRequest req = new InitiateRecordingRequest(
                ATTEMPT_ID, "placement_speaking_p1", "audio/webm", Map.of(), CURRENT_TURN_KEY, "cmd-retry-unsealed", 5L
        );

        mediaService.initiateRecording(USER_ID, ATTEMPT_ID, req);

        // Previous unsealed recording must be marked FAILED with SUPERSEDED_BY_RETRY
        verify(mediaRepository).updateRecordingFailed(unsealedRecId, "SUPERSEDED_BY_RETRY");
    }

    @Test
    @DisplayName("Chunk 15 Gate 7: Attempting to initiate recording on an already SEALED turn is rejected")
    void testInitiateRecordingRejectsIfTurnAlreadySealed() {
        AttemptRecord attempt = createTestAttempt(ExamAttemptStatus.IN_PROGRESS);
        AttemptSectionRecord section = createSpeakingSection();
        ResponseRecord response = createTestResponse(RESPONSE_ID, CURRENT_TURN_KEY);

        UUID sealedRecId = UUID.randomUUID();
        RecordingRecord sealedGen0 = createRecording(sealedRecId, RecordingState.SEALED, RESPONSE_ID);

        when(attemptRepository.findAttemptById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findSectionsByAttemptId(ATTEMPT_ID)).thenReturn(List.of(section));
        when(attemptRepository.findSpeakingResponsesByAttemptAndSection(ATTEMPT_ID, SECTION_ID)).thenReturn(List.of(response));
        when(mediaRepository.countRecordingsForResponse(RESPONSE_ID)).thenReturn(1);
        when(mediaRepository.findLatestRecordingByResponseId(RESPONSE_ID)).thenReturn(Optional.of(sealedGen0));

        InitiateRecordingRequest req = new InitiateRecordingRequest(
                ATTEMPT_ID, "placement_speaking_p1", "audio/webm", Map.of(), CURRENT_TURN_KEY, "cmd-sealed-retry", 5L
        );

        IllegalStateException ex = assertThrows(IllegalStateException.class, () ->
                mediaService.initiateRecording(USER_ID, ATTEMPT_ID, req)
        );
        assertTrue(ex.getMessage().contains("RECORDING_ALREADY_SEALED"));
        verify(mediaRepository, never()).insertRecording(any());
    }

    @Test
    @DisplayName("Chunk 15 Gate 8: getRecordingStatus returns sorted acknowledged sequences and accurate totals")
    void testGetRecordingStatusReturnsAcknowledgedSequences() {
        UUID recId = UUID.randomUUID();
        RecordingRecord rec = createRecording(recId, RecordingState.UPLOADING, RESPONSE_ID);
        AttemptRecord attempt = createTestAttempt(ExamAttemptStatus.IN_PROGRESS);

        RecordingChunkRecord chunk1 = new RecordingChunkRecord(UUID.randomUUID(), recId, 1, "k1", "h1", 200, Instant.now());
        RecordingChunkRecord chunk0 = new RecordingChunkRecord(UUID.randomUUID(), recId, 0, "k0", "h0", 150, Instant.now());
        RecordingChunkRecord chunk2 = new RecordingChunkRecord(UUID.randomUUID(), recId, 2, "k2", "h2", 300, Instant.now());

        when(mediaRepository.findRecordingById(recId)).thenReturn(Optional.of(rec));
        when(attemptRepository.findAttemptById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
        when(mediaRepository.findChunksByRecordingId(recId)).thenReturn(List.of(chunk1, chunk0, chunk2));

        RecordingStatusDto status = mediaService.getRecordingStatus(USER_ID, recId);

        assertNotNull(status);
        assertEquals(recId, status.recordingId());
        assertEquals(3, status.chunkCount());
        assertEquals(650L, status.totalBytes());
        assertEquals(List.of(0, 1, 2), status.acknowledgedSequences());
    }
}
