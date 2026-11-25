package com.englishcoach.exams.media;

import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.model.ExamAttemptRecords.AttemptRecord;
import com.englishcoach.exams.model.ExamContentRecords.AssetRecord;
import com.englishcoach.exams.model.ExamMediaRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamMediaRepository;
import com.englishcoach.exams.service.ExamRightsService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.lang.Nullable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;

@Slf4j
@Service
public class ExamMediaService {

    public static final int DEFAULT_MAX_UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024; // 5 MB
    public static final int MAX_CHUNKS_PER_RECORDING = 1000; // sequenceNo 0..999
    public static final long MAX_RECORDING_TOTAL_BYTES = 50L * 1024 * 1024; // 50 MB
    public static final int MAX_PLAYBACK_TOKENS = 50_000;

    public static final Set<String> ALLOWED_AUDIO_MIME_TYPES = Set.of(
            "audio/webm",
            "audio/ogg",
            "audio/mp4",
            "audio/mpeg",
            "audio/wav",
            "audio/x-wav"
    );

    private static final List<String> FORBIDDEN_MARKUP_SIGNATURES = List.of(
            "<html",
            "<!doctype",
            "<svg",
            "<script",
            "<?xml",
            "<iframe",
            "<body",
            "<head",
            "<object",
            "<embed",
            "javascript:"
    );

    private final ExamMediaRepository mediaRepository;
    private final ExamAttemptRepository attemptRepository;
    private final ExamRightsService rightsService;
    private final ExamObjectStorage objectStorage;
    private final ExamsProperties examsProperties;

    // Package-private cap so unit tests can exercise token-map eviction deterministically.
    int maxPlaybackTokens = MAX_PLAYBACK_TOKENS;

    @Autowired
    public ExamMediaService(
            ExamMediaRepository mediaRepository,
            ExamAttemptRepository attemptRepository,
            ExamRightsService rightsService,
            ExamObjectStorage objectStorage,
            @Nullable ExamsProperties examsProperties
    ) {
        this.mediaRepository = mediaRepository;
        this.attemptRepository = attemptRepository;
        this.rightsService = rightsService;
        this.objectStorage = objectStorage;
        this.examsProperties = examsProperties;
    }

    public ExamMediaService(
            ExamMediaRepository mediaRepository,
            ExamAttemptRepository attemptRepository,
            ExamRightsService rightsService,
            ExamObjectStorage objectStorage
    ) {
        this(mediaRepository, attemptRepository, rightsService, objectStorage, null);
    }

    int maxUploadChunkBytes() {
        if (examsProperties != null && examsProperties.getLimits() != null
                && examsProperties.getLimits().getMaxUploadChunkBytes() > 0) {
            return examsProperties.getLimits().getMaxUploadChunkBytes();
        }
        return DEFAULT_MAX_UPLOAD_CHUNK_BYTES;
    }

    /**
     * Strict allowlist for stored/served recording MIME types (EC-SEC-2026-001).
     * Strips any {@code ;codecs=...} parameter before matching; returns an allowlisted
     * audio {@link MediaType} or {@link MediaType#APPLICATION_OCTET_STREAM} for legacy/unexpected values.
     */
    public static MediaType sanitizeAudioMediaType(String codec) {
        String base = extractBaseAudioMime(codec);
        if (base != null && ALLOWED_AUDIO_MIME_TYPES.contains(base)) {
            return MediaType.parseMediaType(base);
        }
        return MediaType.APPLICATION_OCTET_STREAM;
    }

    public static boolean isAllowlistedAudioMediaType(MediaType mediaType) {
        if (mediaType == null) {
            return false;
        }
        String base = (mediaType.getType() + "/" + mediaType.getSubtype()).toLowerCase(Locale.ROOT);
        return ALLOWED_AUDIO_MIME_TYPES.contains(base);
    }

    /**
     * Validates a client-supplied recording codec on creation. Strips optional benign
     * {@code ;codecs=...} parameters and returns the normalized base audio MIME type,
     * rejecting non-allowlisted types (such as {@code text/html} or {@code image/svg+xml})
     * with {@link IllegalArgumentException} (400 Bad Request).
     */
    public static String validateAndNormalizeAudioCodec(String rawCodec) {
        if (rawCodec == null || rawCodec.isBlank()) {
            return "audio/webm";
        }
        String base = extractBaseAudioMime(rawCodec);
        if (base == null || !ALLOWED_AUDIO_MIME_TYPES.contains(base)) {
            throw new IllegalArgumentException(
                    "INVALID_AUDIO_CODEC: Unsupported audio codec. Allowed MIME types: audio/webm, audio/ogg, audio/mp4, audio/mpeg, audio/wav, audio/x-wav"
            );
        }
        return base;
    }

    private static String extractBaseAudioMime(String raw) {
        if (raw == null || raw.isBlank() || raw.length() > 128) {
            return null;
        }
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c < 0x20 || c == 0x7F) {
                return null;
            }
        }
        int semicolon = raw.indexOf(';');
        String base = (semicolon >= 0 ? raw.substring(0, semicolon) : raw).trim().toLowerCase(Locale.ROOT);
        if (semicolon >= 0) {
            String params = raw.substring(semicolon + 1).trim();
            if (!params.isEmpty() && !params.matches("(?i)^codecs\\s*=\\s*\"?[a-zA-Z0-9._, -]{1,64}\"?$")) {
                return null;
            }
        }
        return base;
    }

    private static void validateChunkPayloadNotActiveContent(byte[] chunkData, int sequenceNumber) {
        int inspectLen = Math.min(chunkData.length, 512);
        int offset = 0;
        // Skip optional UTF-8 BOM
        if (inspectLen >= 3
                && (chunkData[0] & 0xFF) == 0xEF
                && (chunkData[1] & 0xFF) == 0xBB
                && (chunkData[2] & 0xFF) == 0xBF) {
            offset = 3;
        }
        while (offset < inspectLen) {
            byte b = chunkData[offset];
            if (b == ' ' || b == '\t' || b == '\r' || b == '\n' || b == '\f') {
                offset++;
            } else {
                break;
            }
        }
        String prefix = new String(chunkData, offset, inspectLen - offset, StandardCharsets.ISO_8859_1)
                .toLowerCase(Locale.ROOT);
        if (prefix.startsWith("<")) {
            throw new IllegalArgumentException("INVALID_AUDIO_PAYLOAD: Markup content is not allowed in audio recordings");
        }
        for (String forbidden : FORBIDDEN_MARKUP_SIGNATURES) {
            if (prefix.contains(forbidden)) {
                throw new IllegalArgumentException("INVALID_AUDIO_PAYLOAD: Active document or script content is not allowed in audio recordings");
            }
        }
        if (sequenceNumber == 0 && chunkData.length >= 4) {
            int b0 = chunkData[0] & 0xFF;
            int b1 = chunkData[1] & 0xFF;
            int b2 = chunkData[2] & 0xFF;
            int b3 = chunkData[3] & 0xFF;
            boolean isPdf = chunkData.length >= 5 && b0 == '%' && b1 == 'P' && b2 == 'D' && b3 == 'F' && (chunkData[4] & 0xFF) == '-';
            boolean isPng = b0 == 0x89 && b1 == 'P' && b2 == 'N' && b3 == 'G';
            boolean isJpeg = b0 == 0xFF && b1 == 0xD8 && b2 == 0xFF;
            boolean isGif = b0 == 'G' && b1 == 'I' && b2 == 'F' && b3 == '8';
            boolean isZip = b0 == 'P' && b1 == 'K' && b2 == 0x03 && b3 == 0x04;
            boolean isElf = b0 == 0x7F && b1 == 'E' && b2 == 'L' && b3 == 'F';
            if (isPdf || isPng || isJpeg || isGif || isZip || isElf) {
                throw new IllegalArgumentException("INVALID_AUDIO_PAYLOAD: Non-audio file signature rejected");
            }
        }
    }

    public static String computeSha256(byte[] data) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(data);
            StringBuilder hexString = new StringBuilder();
            for (byte b : hash) {
                String hex = Integer.toHexString(0xff & b);
                if (hex.length() == 1) hexString.append('0');
                hexString.append(hex);
            }
            return hexString.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 not available", e);
        }
    }

    @Transactional
    public InitiateRecordingResponseDto initiateRecording(Long userId, UUID attemptId, InitiateRecordingRequest req) {
        if (req == null) {
            throw new IllegalArgumentException("Recording initiation request is required");
        }
        Optional<AttemptRecord> attemptOpt = attemptRepository.findAttemptById(attemptId);
        if (attemptOpt.isEmpty() || !attemptOpt.get().userId().equals(userId)) {
            throw new IllegalArgumentException("Attempt not found or access denied");
        }

        AttemptRecord attempt = attemptOpt.get();
        if (attempt.status() != ExamAttemptStatus.IN_PROGRESS) {
            throw new IllegalStateException("Attempt is not IN_PROGRESS: " + attempt.status());
        }

        String normalizedCodec = validateAndNormalizeAudioCodec(req.codec());

        if (req.expectedAttemptRevision() != null && !req.expectedAttemptRevision().equals(attempt.revision())) {
            throw new com.englishcoach.exams.exception.ExamConcurrencyException(
                    "ATTEMPT_REVISION_CONFLICT",
                    "Expected attempt revision " + req.expectedAttemptRevision() + " but current is " + attempt.revision(),
                    attempt.revision(),
                    req.expectedAttemptRevision()
            );
        }

        String cmdId = req.commandId();
        if (cmdId != null && !cmdId.isBlank()) {
            Optional<com.englishcoach.exams.model.ExamAttemptRecords.CommandReceiptRecord> receipt =
                    attemptRepository.findCommandReceipt(userId, "INITIATE_RECORDING", cmdId);
            if (receipt.isPresent()) {
                log.info("Idempotent replay detected for INITIATE_RECORDING command {} on attempt {}", cmdId, attemptId);
                try {
                    UUID existingRecId = UUID.fromString(receipt.get().resultReference());
                    Optional<RecordingRecord> existingRec = mediaRepository.findRecordingById(existingRecId);
                    if (existingRec.isPresent()) {
                        return new InitiateRecordingResponseDto(
                                existingRec.get().id(),
                                existingRec.get().placementId(),
                                req.turnKey(),
                                existingRec.get().responseId(),
                                existingRec.get().state(),
                                existingRec.get().chunkCount()
                        );
                    }
                } catch (Exception ignored) {}
            }
        }

        String turnKey = req.turnKey();
        UUID responseId = null;
        Integer generation = null;
        UUID supersedesRecordingId = null;
        String placementId = req.placementId();

        Optional<com.englishcoach.exams.model.ExamAttemptRecords.AttemptSectionRecord> speakingSecOpt =
                attemptRepository.findSectionsByAttemptId(attemptId).stream()
                        .filter(s -> s.currentTurnKey() != null || s.currentTurnPlacementId() != null)
                        .findFirst();

        if (speakingSecOpt.isPresent()) {
            com.englishcoach.exams.model.ExamAttemptRecords.AttemptSectionRecord speakingSec = speakingSecOpt.get();
            String currentActiveTurnKey = speakingSec.currentTurnKey();

            String effectiveTurnKey = (turnKey != null && !turnKey.isBlank()) ? turnKey : currentActiveTurnKey;
            if (turnKey != null && !turnKey.isBlank()) {
                if (currentActiveTurnKey != null && !currentActiveTurnKey.equalsIgnoreCase(turnKey)) {
                    throw new com.englishcoach.exams.exception.ExamExceptionHandler.ExamForbiddenException(
                            "OUT_OF_TURN_RECORDING: Turn " + turnKey + " is not the current active turn: " + currentActiveTurnKey
                    );
                }
            }

            if (effectiveTurnKey != null) {
                List<com.englishcoach.exams.model.ExamAttemptRecords.ResponseRecord> turns =
                        attemptRepository.findSpeakingResponsesByAttemptAndSection(attemptId, speakingSec.sectionId());
                com.englishcoach.exams.model.ExamAttemptRecords.ResponseRecord targetTurn = turns.stream()
                        .filter(t -> effectiveTurnKey.equalsIgnoreCase(t.turnKey()))
                        .findFirst()
                        .orElse(null);

                if (targetTurn != null) {
                    responseId = targetTurn.id();
                    if (placementId == null || placementId.isBlank()) {
                        placementId = targetTurn.placementId();
                    }
                    int count = mediaRepository.countRecordingsForResponse(responseId);
                    generation = count;
                    if (count > 0) {
                        Optional<RecordingRecord> prev = mediaRepository.findLatestRecordingByResponseId(responseId);
                        if (prev.isPresent()) {
                            if (prev.get().state() == RecordingState.SEALED) {
                                throw new IllegalStateException("RECORDING_ALREADY_SEALED: Turn " + effectiveTurnKey + " already has a sealed recording: " + prev.get().id());
                            }
                            if (prev.get().state() == RecordingState.RECORDING || prev.get().state() == RecordingState.UPLOADING) {
                                // Mark previous unsealed recording as FAILED so it becomes immutable
                                mediaRepository.updateRecordingFailed(prev.get().id(), "SUPERSEDED_BY_RETRY");
                            }
                            supersedesRecordingId = prev.get().id();
                        }
                    }
                }
            }
        }

        Instant now = Instant.now();
        Instant windowEnd = now.plus(10, ChronoUnit.MINUTES);

        RecordingRecord recording = new RecordingRecord(
                null,
                attemptId,
                responseId,
                placementId != null ? placementId : "speaking_recording",
                now,
                windowEnd,
                normalizedCodec,
                req.deviceMeta(),
                RecordingState.RECORDING,
                0,
                0L,
                List.of(),
                null,
                null,
                Map.of(),
                now,
                generation,
                supersedesRecordingId,
                null,
                "NOT_REQUESTED",
                null,
                "PENDING"
        );

        UUID recordingId = mediaRepository.insertRecording(recording);
        log.info("Initiated recording {} for attempt {} placement {} turnKey {} responseId {}",
                recordingId, attemptId, placementId, turnKey, responseId);

        if (turnKey != null) {
            attemptRepository.updateSpeakingTurnState(attemptId, turnKey, "RECORDING", recordingId, cmdId);
        }

        if (cmdId != null && !cmdId.isBlank()) {
            attemptRepository.insertCommandReceipt(new com.englishcoach.exams.model.ExamAttemptRecords.CommandReceiptRecord(
                    null, userId, attemptId, cmdId, "INITIATE_RECORDING",
                    "hash-" + cmdId, recordingId.toString(), "SUCCESS", now
            ));
        }

        return new InitiateRecordingResponseDto(recordingId, placementId, turnKey, responseId, RecordingState.RECORDING, 0);
    }

    @Transactional
    public UploadChunkReceiptDto saveChunk(Long userId, UUID recordingId, int sequenceNumber,
                                          String clientSha256, byte[] chunkData) {
        if (sequenceNumber < 0 || sequenceNumber >= MAX_CHUNKS_PER_RECORDING) {
            throw new IllegalArgumentException(
                    "INVALID_CHUNK_SEQUENCE: Sequence number must be between 0 and " + (MAX_CHUNKS_PER_RECORDING - 1) + ": " + sequenceNumber
            );
        }
        if (chunkData == null || chunkData.length == 0) {
            throw new IllegalArgumentException("Chunk data cannot be empty");
        }
        int maxChunkBytes = maxUploadChunkBytes();
        if (chunkData.length > maxChunkBytes) {
            throw new IllegalArgumentException(
                    "CHUNK_TOO_LARGE: Chunk size " + chunkData.length + " exceeds maximum allowed " + maxChunkBytes + " bytes"
            );
        }
        validateChunkPayloadNotActiveContent(chunkData, sequenceNumber);

        Optional<RecordingRecord> recOpt = mediaRepository.findRecordingById(recordingId);
        if (recOpt.isEmpty()) {
            throw new IllegalArgumentException("Recording not found: " + recordingId);
        }

        RecordingRecord rec = recOpt.get();
        Optional<AttemptRecord> attemptOpt = attemptRepository.findAttemptById(rec.attemptId());
        if (attemptOpt.isEmpty() || !attemptOpt.get().userId().equals(userId)) {
            throw new IllegalArgumentException("Access denied to recording: " + recordingId);
        }

        AttemptRecord attempt = attemptOpt.get();
        if (attempt.status() != ExamAttemptStatus.IN_PROGRESS) {
            throw new IllegalStateException("Attempt is not IN_PROGRESS: " + attempt.status());
        }

        if (rec.state() != RecordingState.RECORDING && rec.state() != RecordingState.UPLOADING) {
            throw new IllegalStateException("RECORDING_SEALED_IMMUTABLE: Recording is already " + rec.state() + "; chunks cannot be uploaded after recording is sealed");
        }

        // Out-of-turn check: If this recording is bound to a response/turn, ensure that turn is still the active speaking turn!
        if (rec.responseId() != null) {
            Optional<com.englishcoach.exams.model.ExamAttemptRecords.AttemptSectionRecord> speakingSecOpt =
                    attemptRepository.findSectionsByAttemptId(rec.attemptId()).stream()
                            .filter(s -> s.currentTurnKey() != null || s.currentTurnPlacementId() != null)
                            .findFirst();
            if (speakingSecOpt.isPresent()) {
                com.englishcoach.exams.model.ExamAttemptRecords.AttemptSectionRecord speakingSec = speakingSecOpt.get();
                List<com.englishcoach.exams.model.ExamAttemptRecords.ResponseRecord> turns =
                        attemptRepository.findSpeakingResponsesByAttemptAndSection(rec.attemptId(), speakingSec.sectionId());
                com.englishcoach.exams.model.ExamAttemptRecords.ResponseRecord boundTurn = turns.stream()
                        .filter(t -> rec.responseId().equals(t.id()))
                        .findFirst()
                        .orElse(null);

                if (boundTurn != null && speakingSec.currentTurnKey() != null) {
                    if (!speakingSec.currentTurnKey().equalsIgnoreCase(boundTurn.turnKey())) {
                        throw new IllegalStateException("OUT_OF_TURN_CHUNK: Recording belongs to turn " +
                                boundTurn.turnKey() + " which is not the current active turn " + speakingSec.currentTurnKey());
                    }
                }
            }
        }

        String actualHash = computeSha256(chunkData);
        if (clientSha256 != null && !clientSha256.isBlank() && !clientSha256.equalsIgnoreCase(actualHash)) {
            throw new IllegalArgumentException("CHUNK_HASH_MISMATCH: Chunk hash mismatch! Client: " + clientSha256 + ", Server: " + actualHash);
        }

        // Check for duplicate replay vs sequence collision
        Optional<RecordingChunkRecord> existingChunk = mediaRepository.findChunkByRecordingAndSequence(recordingId, sequenceNumber);
        if (existingChunk.isPresent()) {
            RecordingChunkRecord c = existingChunk.get();
            if (c.sha256Hash().equalsIgnoreCase(actualHash) && c.byteSize() == chunkData.length) {
                log.info("Idempotent chunk replay detected for recording {} sequence {}", recordingId, sequenceNumber);
                int totalCount = mediaRepository.findChunksByRecordingId(recordingId).size();
                return new UploadChunkReceiptDto(recordingId, sequenceNumber, actualHash, chunkData.length, "ACCEPTED", totalCount);
            } else {
                throw new com.englishcoach.exams.exception.ExamConcurrencyException(
                        "CHUNK_SEQUENCE_COLLISION",
                        "Chunk sequence " + sequenceNumber + " already exists with conflicting hash " + c.sha256Hash() + " (attempted: " + actualHash + ")",
                        0L,
                        0L
                );
            }
        }

        List<RecordingChunkRecord> currentChunks = mediaRepository.findChunksByRecordingId(recordingId);
        if (currentChunks != null) {
            if (currentChunks.size() >= MAX_CHUNKS_PER_RECORDING) {
                throw new IllegalArgumentException(
                        "RECORDING_CHUNK_LIMIT_EXCEEDED: Recording has reached the maximum of " + MAX_CHUNKS_PER_RECORDING + " chunks"
                );
            }
            long existingBytes = currentChunks.stream().mapToLong(RecordingChunkRecord::byteSize).sum();
            if (existingBytes + chunkData.length > MAX_RECORDING_TOTAL_BYTES) {
                throw new IllegalArgumentException(
                        "RECORDING_SIZE_LIMIT_EXCEEDED: Recording exceeds maximum allowed size of " + MAX_RECORDING_TOTAL_BYTES + " bytes"
                );
            }
        }

        String objectKey = String.format("recordings/%s/chunk_%04d.bin", recordingId, sequenceNumber);
        objectStorage.putObject(objectKey, chunkData, sanitizeAudioMediaType(rec.codec()).toString());

        RecordingChunkRecord chunk = new RecordingChunkRecord(
                null,
                recordingId,
                sequenceNumber,
                objectKey,
                actualHash,
                chunkData.length,
                Instant.now()
        );
        mediaRepository.insertRecordingChunk(chunk);

        int totalCount = mediaRepository.findChunksByRecordingId(recordingId).size();
        return new UploadChunkReceiptDto(recordingId, sequenceNumber, actualHash, chunkData.length, "ACCEPTED", totalCount);
    }

    public record ChunkDataResult(byte[] data, String mimeType) {}

    @Transactional(readOnly = true)
    public ChunkDataResult getChunkData(Long userId, UUID recordingId, int sequenceNumber) {
        if (sequenceNumber < 0 || sequenceNumber >= MAX_CHUNKS_PER_RECORDING) {
            throw new IllegalArgumentException("Invalid chunk sequence: " + sequenceNumber);
        }
        Optional<RecordingRecord> recOpt = mediaRepository.findRecordingById(recordingId);
        if (recOpt.isEmpty()) {
            throw new IllegalArgumentException("Recording not found: " + recordingId);
        }

        RecordingRecord rec = recOpt.get();
        Optional<AttemptRecord> attemptOpt = attemptRepository.findAttemptById(rec.attemptId());
        if (attemptOpt.isEmpty() || !attemptOpt.get().userId().equals(userId)) {
            throw new IllegalArgumentException("Access denied to recording: " + recordingId);
        }

        String objectKey = String.format("recordings/%s/chunk_%04d.bin", recordingId, sequenceNumber);
        byte[] bytes = objectStorage.getObject(objectKey);
        String mime = sanitizeAudioMediaType(rec.codec()).toString();
        return new ChunkDataResult(bytes, mime);
    }

    @Transactional
    public SealRecordingResponseDto sealRecording(Long userId, UUID recordingId, SealRecordingRequest req) {
        Optional<RecordingRecord> recOpt = mediaRepository.findRecordingById(recordingId);
        if (recOpt.isEmpty()) {
            throw new IllegalArgumentException("Recording not found: " + recordingId);
        }

        RecordingRecord rec = recOpt.get();
        Optional<AttemptRecord> attemptOpt = attemptRepository.findAttemptById(rec.attemptId());
        if (attemptOpt.isEmpty() || !attemptOpt.get().userId().equals(userId)) {
            throw new IllegalArgumentException("Access denied to recording: " + recordingId);
        }

        if (rec.state() == RecordingState.SEALED) {
            log.info("Idempotent seal replay detected for recording {}", recordingId);
            return new SealRecordingResponseDto(recordingId, RecordingState.SEALED, rec.chunkCount(), rec.totalBytes(), true);
        }
        if (rec.state() != RecordingState.RECORDING && rec.state() != RecordingState.UPLOADING) {
            throw new IllegalStateException("Cannot seal recording in state: " + rec.state());
        }

        List<RecordingChunkRecord> chunks = mediaRepository.findChunksByRecordingId(recordingId);
        if (chunks.isEmpty()) {
            throw new IllegalStateException("EMPTY_RECORDING_SEAL_REJECTED: Cannot seal recording with 0 chunks");
        }

        List<RecordingChunkRecord> sortedChunks = new ArrayList<>(chunks);
        sortedChunks.sort(Comparator.comparingInt(RecordingChunkRecord::sequenceNumber));
        for (int i = 0; i < sortedChunks.size(); i++) {
            if (sortedChunks.get(i).sequenceNumber() != i) {
                throw new IllegalStateException("NON_CONTIGUOUS_CHUNKS: Missing chunk sequence " + i + " in recording " + recordingId);
            }
        }

        long totalBytes = sortedChunks.stream().mapToLong(RecordingChunkRecord::byteSize).sum();
        if (totalBytes <= 0) {
            throw new IllegalStateException("ZERO_BYTES_SEAL_REJECTED: Recording total bytes must be greater than zero");
        }

        if (req != null) {
            if (req.totalChunks() != null && req.totalChunks() != sortedChunks.size()) {
                throw new IllegalArgumentException("SEAL_MANIFEST_MISMATCH: Client totalChunks (" + req.totalChunks() +
                        ") does not match server chunk count (" + sortedChunks.size() + ")");
            }
            if (req.totalBytes() != null && req.totalBytes() != totalBytes) {
                throw new IllegalArgumentException("SEAL_MANIFEST_MISMATCH: Client totalBytes (" + req.totalBytes() +
                        ") does not match server total bytes (" + totalBytes + ")");
            }
        }

        List<Map<String, Object>> manifest = new ArrayList<>();
        for (RecordingChunkRecord c : sortedChunks) {
            manifest.add(Map.of(
                    "seq", c.sequenceNumber(),
                    "hash", c.sha256Hash(),
                    "size", c.byteSize(),
                    "key", c.objectKey()
            ));
        }

        UUID sealCmdId = null;
        if (req != null && req.commandId() != null && !req.commandId().isBlank()) {
            try {
                sealCmdId = UUID.fromString(req.commandId());
            } catch (Exception ignored) {}
        }

        mediaRepository.updateRecordingSealed(recordingId, RecordingState.SEALED, sortedChunks.size(), totalBytes, manifest, sealCmdId);

        if (rec.responseId() != null) {
            Optional<com.englishcoach.exams.model.ExamAttemptRecords.AttemptSectionRecord> speakingSecOpt =
                    attemptRepository.findSectionsByAttemptId(rec.attemptId()).stream()
                            .filter(s -> s.currentTurnKey() != null || s.currentTurnPlacementId() != null)
                            .findFirst();
            if (speakingSecOpt.isPresent()) {
                List<com.englishcoach.exams.model.ExamAttemptRecords.ResponseRecord> turns =
                        attemptRepository.findSpeakingResponsesByAttemptAndSection(rec.attemptId(), speakingSecOpt.get().sectionId());
                turns.stream().filter(t -> rec.responseId().equals(t.id())).findFirst().ifPresent(turn -> {
                    attemptRepository.updateSpeakingTurnState(rec.attemptId(), turn.turnKey(), "RECORDED", recordingId, null);
                });
            }
        }

        log.info("Sealed recording {} with {} chunks and {} bytes", recordingId, sortedChunks.size(), totalBytes);
        return new SealRecordingResponseDto(recordingId, RecordingState.SEALED, sortedChunks.size(), totalBytes, true);
    }

    @Transactional
    public void failRecording(Long userId, UUID recordingId, String errorCode) {
        Optional<RecordingRecord> recOpt = mediaRepository.findRecordingById(recordingId);
        if (recOpt.isEmpty()) {
            throw new IllegalArgumentException("Recording not found: " + recordingId);
        }

        RecordingRecord rec = recOpt.get();
        Optional<AttemptRecord> attemptOpt = attemptRepository.findAttemptById(rec.attemptId());
        if (attemptOpt.isEmpty() || !attemptOpt.get().userId().equals(userId)) {
            throw new IllegalArgumentException("Access denied to recording: " + recordingId);
        }

        if (rec.state() == RecordingState.SEALED) {
            throw new IllegalStateException("RECORDING_SEALED_IMMUTABLE: Cannot fail already SEALED recording: " + recordingId);
        }

        String effectiveCode = (errorCode != null && !errorCode.isBlank()) ? errorCode : "RECORDING_FAILED";
        mediaRepository.updateRecordingFailed(recordingId, effectiveCode);
        log.warn("Marked recording {} as FAILED with error code {}", recordingId, effectiveCode);
    }

    @Transactional(readOnly = true)
    public RecordingStatusDto getRecordingStatus(Long userId, UUID recordingId) {
        Optional<RecordingRecord> recOpt = mediaRepository.findRecordingById(recordingId);
        if (recOpt.isEmpty()) {
            throw new IllegalArgumentException("Recording not found: " + recordingId);
        }

        RecordingRecord rec = recOpt.get();
        Optional<AttemptRecord> attemptOpt = attemptRepository.findAttemptById(rec.attemptId());
        if (attemptOpt.isEmpty() || !attemptOpt.get().userId().equals(userId)) {
            throw new IllegalArgumentException("Access denied to recording: " + recordingId);
        }

        List<RecordingChunkRecord> chunks = mediaRepository.findChunksByRecordingId(recordingId);
        List<Integer> acknowledgedSeqs = chunks.stream()
                .map(RecordingChunkRecord::sequenceNumber)
                .sorted()
                .toList();

        return new RecordingStatusDto(
                rec.id(),
                rec.attemptId(),
                rec.responseId(),
                rec.placementId(),
                rec.state(),
                chunks.size(),
                rec.totalBytes() > 0 ? rec.totalBytes() : chunks.stream().mapToLong(RecordingChunkRecord::byteSize).sum(),
                acknowledgedSeqs,
                rec.generation(),
                rec.supersedesRecordingId(),
                rec.evidenceStatus(),
                null
        );
    }

    public byte[] getRecordingBytes(UUID recordingId) {
        List<RecordingChunkRecord> chunks = mediaRepository.findChunksByRecordingId(recordingId);
        if (chunks.isEmpty()) {
            return new byte[0];
        }
        if (chunks.size() > MAX_CHUNKS_PER_RECORDING) {
            throw new IllegalStateException("RECORDING_CHUNK_LIMIT_EXCEEDED: Recording exceeds maximum chunk count");
        }
        List<RecordingChunkRecord> sortedChunks = new ArrayList<>(chunks);
        sortedChunks.sort(Comparator.comparingInt(RecordingChunkRecord::sequenceNumber));

        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        long totalRead = 0L;
        for (RecordingChunkRecord chunk : sortedChunks) {
            try (InputStream is = objectStorage.getObjectStream(chunk.objectKey())) {
                if (is != null) {
                    int n;
                    while ((n = is.read(buffer)) != -1) {
                        totalRead += n;
                        if (totalRead > MAX_RECORDING_TOTAL_BYTES) {
                            throw new IllegalStateException(
                                    "RECORDING_SIZE_LIMIT_EXCEEDED: Recording exceeds maximum allowed size of " + MAX_RECORDING_TOTAL_BYTES + " bytes"
                            );
                        }
                        baos.write(buffer, 0, n);
                    }
                }
            } catch (IllegalStateException ise) {
                throw ise;
            } catch (Exception e) {
                log.warn("Failed to read chunk {} for recording {}: {}", chunk.objectKey(), recordingId, e.getMessage());
            }
        }
        return baos.toByteArray();
    }

    @Transactional(readOnly = true)
    public List<RecordingRecord> findRecordingsByAttemptId(UUID attemptId) {
        return mediaRepository.findRecordingsByAttemptId(attemptId);
    }

    @Transactional
    public PlaybackGrantDto createPlaybackGrant(Long userId, UUID attemptId, UUID assetId, MediaPurpose purpose) {
        if (attemptId == null || assetId == null || purpose == null) {
            throw new IllegalArgumentException("Attempt, asset, and purpose are required");
        }
        Optional<AttemptRecord> attemptOpt = attemptRepository.findAttemptById(attemptId);
        if (attemptOpt.isEmpty() || !attemptOpt.get().userId().equals(userId)) {
            throw new IllegalArgumentException("Attempt not found or access denied");
        }
        AttemptRecord grantAttempt = attemptOpt.get();
        if (grantAttempt.status() == ExamAttemptStatus.INVALIDATED || grantAttempt.status() == ExamAttemptStatus.EXPIRED) {
            throw new IllegalStateException("ATTEMPT_NOT_ELIGIBLE_FOR_MEDIA: Attempt is " + grantAttempt.status());
        }
        if (purpose == MediaPurpose.SIMULATION_LISTENING
                && (grantAttempt.status() == ExamAttemptStatus.CREATED
                || grantAttempt.status() == ExamAttemptStatus.READY
                || grantAttempt.status() == ExamAttemptStatus.SUBMITTED)) {
            throw new IllegalStateException("ATTEMPT_NOT_IN_PROGRESS: Simulation playback grant requires an IN_PROGRESS attempt");
        }
        if (grantAttempt.snapshotState() == com.englishcoach.exams.model.ExamTypes.ExamSnapshotState.INVALID) {
            throw new IllegalStateException("ATTEMPT_SNAPSHOT_INVALID: Attempt snapshot is not valid");
        }
        // Exams Phase 6: a SNAPSHOTTED attempt may only stream assets its own pinned content references (a practice
        // scope ⇒ only that scope's media); an asset of another part / form is refused.
        if (grantAttempt.snapshotState() == com.englishcoach.exams.model.ExamTypes.ExamSnapshotState.SNAPSHOTTED
                && grantAttempt.manifestSnapshot() != null) {
            boolean inSnapshot = com.englishcoach.exams.practice.ExamPracticeScope.snapshotAssetIds(grantAttempt.manifestSnapshot())
                    .contains(assetId);
            boolean scoped = com.englishcoach.exams.practice.ExamPracticeScope.isScoped(grantAttempt.manifestSnapshot());
            if (!inSnapshot || (scoped && !com.englishcoach.exams.practice.ExamPracticeScope
                    .pinnedAssetIds(grantAttempt.manifestSnapshot()).contains(assetId))) {
                throw new IllegalStateException("ASSET_NOT_IN_ATTEMPT_SCOPE: asset is not part of this attempt's content");
            }
        }

        if (!rightsService.isAssetAccessible(assetId, purpose)) {
            throw new IllegalStateException("Asset not accessible for purpose: " + purpose);
        }

        String rawToken = UUID.randomUUID().toString() + "-" + System.currentTimeMillis();
        String tokenHash = computeSha256(rawToken.getBytes(StandardCharsets.UTF_8));
        Instant expiresAt = Instant.now().plus(2, ChronoUnit.HOURS);

        MediaGrantRecord grant = new MediaGrantRecord(
                null,
                attemptId,
                assetId,
                purpose,
                UUID.randomUUID().toString(),
                0,
                expiresAt,
                tokenHash,
                null,
                Instant.now()
        );
        mediaRepository.insertMediaGrant(grant);

        String streamUrl = "/api/v1/exams/media/" + rawToken;
        return new PlaybackGrantDto(rawToken, assetId, streamUrl, 0, expiresAt);
    }

    @Transactional(readOnly = true)
    public InputStream getMediaStreamByToken(String rawToken) {
        String tokenHash = computeSha256(rawToken.getBytes(StandardCharsets.UTF_8));
        Optional<MediaGrantRecord> grantOpt = mediaRepository.findMediaGrantByTokenHash(tokenHash);
        if (grantOpt.isEmpty()) {
            throw new SecurityException("Invalid media grant token");
        }

        MediaGrantRecord grant = grantOpt.get();
        if (grant.expiresAt().isBefore(Instant.now())) {
            throw new SecurityException("Media grant token has expired");
        }

        Optional<AssetRecord> assetOpt = mediaRepository.findAssetById(grant.assetId());
        if (assetOpt.isEmpty()) {
            throw new IllegalArgumentException("Asset not found");
        }

        return objectStorage.getObjectStream(assetOpt.get().objectKey());
    }

    public record MediaStreamResult(InputStream stream, String mimeType) {}

    public record MediaDataResult(byte[] data, String mimeType) {}

    public record RecordingPlaybackTokenInfo(UUID recordingId, UUID attemptId, Long userId, Instant expiresAt) {}

    private final Map<String, RecordingPlaybackTokenInfo> recordingPlaybackTokens = new java.util.concurrent.ConcurrentHashMap<>();
    private final Map<String, String> recordingTokenByRecording = new java.util.concurrent.ConcurrentHashMap<>();
    private final Object playbackTokenLock = new Object();
    private final AtomicInteger playbackTokenInsertCounter = new AtomicInteger(0);

    private static String playbackCacheKey(UUID attemptId, UUID recordingId) {
        return (attemptId != null ? attemptId.toString() : "na") + "_" + (recordingId != null ? recordingId.toString() : "na");
    }

    private void prunePlaybackTokensIfNeeded(Instant now) {
        int cap = Math.max(1, maxPlaybackTokens);
        boolean periodic = (playbackTokenInsertCounter.incrementAndGet() & 0xFF) == 0;
        if (!periodic && recordingPlaybackTokens.size() < cap) {
            return;
        }
        synchronized (playbackTokenLock) {
            recordingPlaybackTokens.entrySet().removeIf(entry -> {
                RecordingPlaybackTokenInfo info = entry.getValue();
                if (info == null || info.expiresAt() == null || !info.expiresAt().isAfter(now)) {
                    if (info != null) {
                        recordingTokenByRecording.remove(playbackCacheKey(info.attemptId(), info.recordingId()), entry.getKey());
                    }
                    return true;
                }
                return false;
            });
            recordingTokenByRecording.entrySet().removeIf(e -> !recordingPlaybackTokens.containsKey(e.getValue()));

            if (recordingPlaybackTokens.size() >= cap) {
                int toRemove = Math.max(1, recordingPlaybackTokens.size() - cap + 1);
                List<Map.Entry<String, RecordingPlaybackTokenInfo>> oldest = recordingPlaybackTokens.entrySet().stream()
                        .sorted(Comparator.comparing(e -> e.getValue().expiresAt()))
                        .limit(toRemove)
                        .toList();
                for (Map.Entry<String, RecordingPlaybackTokenInfo> e : oldest) {
                    recordingPlaybackTokens.remove(e.getKey(), e.getValue());
                    recordingTokenByRecording.remove(
                            playbackCacheKey(e.getValue().attemptId(), e.getValue().recordingId()),
                            e.getKey()
                    );
                }
            }
        }
    }

    int playbackTokenCacheSize() {
        return recordingPlaybackTokens.size();
    }

    public String createRecordingPlaybackToken(Long userId, UUID attemptId, UUID recordingId) {
        if (userId == null || attemptId == null || recordingId == null) {
            throw new IllegalArgumentException("User, attempt, and recording IDs are required");
        }
        RecordingRecord rec = mediaRepository.findRecordingById(recordingId)
                .orElseThrow(() -> new IllegalArgumentException("Recording not found: " + recordingId));
        if (!attemptId.equals(rec.attemptId())) {
            throw new SecurityException("Recording does not belong to attempt: " + attemptId);
        }
        if (rec.state() == RecordingState.FAILED) {
            throw new IllegalStateException("Cannot create playback token for FAILED recording: " + recordingId);
        }
        AttemptRecord attempt = attemptRepository.findAttemptById(attemptId)
                .orElseThrow(() -> new IllegalArgumentException("Attempt not found: " + attemptId));
        if (!userId.equals(attempt.userId())) {
            throw new SecurityException("Attempt does not belong to user");
        }
        if (attempt.status() == ExamAttemptStatus.INVALIDATED) {
            throw new IllegalStateException("Cannot create playback token for INVALIDATED attempt: " + attemptId);
        }

        Instant now = Instant.now();
        String cacheKey = playbackCacheKey(attemptId, recordingId);
        String existingToken = recordingTokenByRecording.get(cacheKey);
        if (existingToken != null) {
            RecordingPlaybackTokenInfo info = recordingPlaybackTokens.get(existingToken);
            if (info != null && info.expiresAt().isAfter(now.plus(1, ChronoUnit.HOURS))) {
                return existingToken;
            }
        }

        prunePlaybackTokensIfNeeded(now);

        String token = "rec_play_" + UUID.randomUUID().toString().replace("-", "") + "_" + System.currentTimeMillis();
        Instant expiresAt = now.plus(24, ChronoUnit.HOURS);
        recordingPlaybackTokens.put(token, new RecordingPlaybackTokenInfo(recordingId, attemptId, userId, expiresAt));
        recordingTokenByRecording.put(cacheKey, token);
        return token;
    }

    public boolean validateRecordingPlaybackToken(String token, UUID recordingId) {
        if (token == null || token.isBlank() || recordingId == null) {
            return false;
        }
        RecordingPlaybackTokenInfo info = recordingPlaybackTokens.get(token);
        if (info == null) {
            return false;
        }
        if (info.expiresAt().isBefore(Instant.now())) {
            recordingPlaybackTokens.remove(token, info);
            recordingTokenByRecording.remove(playbackCacheKey(info.attemptId(), info.recordingId()), token);
            return false;
        }
        return recordingId.equals(info.recordingId());
    }

    private RecordingRecord authorizeRecordingPlayback(Long userId, UUID recordingId, String token, boolean isAdmin) {
        Optional<RecordingRecord> recOpt = mediaRepository.findRecordingById(recordingId);
        if (recOpt.isEmpty()) {
            throw new IllegalArgumentException("Recording not found: " + recordingId);
        }
        RecordingRecord rec = recOpt.get();

        boolean authorized = false;
        if (isAdmin) {
            authorized = true;
        } else if (userId != null) {
            Optional<AttemptRecord> attemptOpt = attemptRepository.findAttemptById(rec.attemptId());
            if (attemptOpt.isPresent() && attemptOpt.get().userId().equals(userId)) {
                authorized = true;
            }
        } else if (token != null && validateRecordingPlaybackToken(token, recordingId)) {
            authorized = true;
        }

        if (!authorized) {
            throw new SecurityException("Unauthorized access to recording playback");
        }
        return rec;
    }

    @Transactional(readOnly = true)
    public MediaDataResult getRecordingAudioData(Long userId, UUID recordingId, String token, boolean isAdmin) {
        RecordingRecord rec = authorizeRecordingPlayback(userId, recordingId, token, isAdmin);
        byte[] audioBytes = getRecordingBytes(recordingId);
        String mime = sanitizeAudioMediaType(rec.codec()).toString();
        return new MediaDataResult(audioBytes, mime);
    }

    /**
     * Streams a recording's chunks lazily without concatenating the full recording in heap memory
     * (EC-SEC-2026-013), with strict chunk/size bounds and allowlisted audio MIME type (EC-SEC-2026-001).
     */
    @Transactional(readOnly = true)
    public GrantedMedia openRecordingPlayback(Long userId, UUID recordingId, String token, boolean isAdmin) {
        RecordingRecord rec = authorizeRecordingPlayback(userId, recordingId, token, isAdmin);
        List<RecordingChunkRecord> chunks = mediaRepository.findChunksByRecordingId(recordingId);
        if (chunks.size() > MAX_CHUNKS_PER_RECORDING) {
            throw new IllegalStateException("RECORDING_CHUNK_LIMIT_EXCEEDED: Recording exceeds maximum chunk count");
        }
        List<RecordingChunkRecord> sortedChunks = new ArrayList<>(chunks);
        sortedChunks.sort(Comparator.comparingInt(RecordingChunkRecord::sequenceNumber));

        long totalLength = 0L;
        for (RecordingChunkRecord chunk : sortedChunks) {
            long chunkLen = chunk.byteSize() >= 0 ? chunk.byteSize() : objectStorage.contentLength(chunk.objectKey());
            if (chunkLen < 0) {
                totalLength = -1L;
                break;
            }
            totalLength += chunkLen;
            if (totalLength > MAX_RECORDING_TOTAL_BYTES) {
                throw new IllegalStateException(
                        "RECORDING_SIZE_LIMIT_EXCEEDED: Recording exceeds maximum allowed size of " + MAX_RECORDING_TOTAL_BYTES + " bytes"
                );
            }
        }
        String mime = sanitizeAudioMediaType(rec.codec()).toString();
        return new GrantedMedia(
                new ChunkedRecordingResource(objectStorage, sortedChunks, totalLength, recordingId),
                mime
        );
    }

    /** Streaming view across recording chunks: opens one chunk stream at a time and caps total bytes read. */
    static final class ChunkedRecordingResource extends org.springframework.core.io.AbstractResource {
        private final ExamObjectStorage storage;
        private final List<RecordingChunkRecord> chunks;
        private final long totalLength;
        private final UUID recordingId;

        ChunkedRecordingResource(ExamObjectStorage storage, List<RecordingChunkRecord> chunks, long totalLength, UUID recordingId) {
            this.storage = storage;
            this.chunks = chunks;
            this.totalLength = totalLength;
            this.recordingId = recordingId;
        }

        @Override
        public InputStream getInputStream() {
            if (chunks.isEmpty()) {
                return InputStream.nullInputStream();
            }
            return new ChunkedRecordingInputStream(storage, chunks, MAX_RECORDING_TOTAL_BYTES);
        }

        @Override
        public long contentLength() throws IOException {
            return totalLength >= 0 ? totalLength : super.contentLength();
        }

        @Override
        public boolean exists() {
            return true;
        }

        @Override
        public String getFilename() {
            return null;
        }

        @Override
        public String getDescription() {
            return "exam recording " + recordingId;
        }
    }

    private static final class ChunkedRecordingInputStream extends InputStream {
        private final ExamObjectStorage storage;
        private final List<RecordingChunkRecord> chunks;
        private final long maxBytes;
        private int chunkIndex = 0;
        private InputStream current;
        private long totalRead = 0L;
        private boolean closed = false;

        ChunkedRecordingInputStream(ExamObjectStorage storage, List<RecordingChunkRecord> chunks, long maxBytes) {
            this.storage = storage;
            this.chunks = chunks;
            this.maxBytes = maxBytes;
        }

        private InputStream ensureCurrent() throws IOException {
            if (closed) {
                throw new IOException("Stream closed");
            }
            while (current == null && chunkIndex < chunks.size()) {
                RecordingChunkRecord chunk = chunks.get(chunkIndex++);
                current = storage.getObjectStream(chunk.objectKey());
            }
            return current;
        }

        @Override
        public int read() throws IOException {
            byte[] single = new byte[1];
            int n = read(single, 0, 1);
            return n == -1 ? -1 : (single[0] & 0xFF);
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (len == 0) {
                return 0;
            }
            while (true) {
                InputStream in = ensureCurrent();
                if (in == null) {
                    return -1;
                }
                int n = in.read(b, off, len);
                if (n != -1) {
                    totalRead += n;
                    if (totalRead > maxBytes) {
                        close();
                        throw new IOException("RECORDING_SIZE_LIMIT_EXCEEDED");
                    }
                    return n;
                }
                in.close();
                current = null;
            }
        }

        @Override
        public void close() throws IOException {
            closed = true;
            if (current != null) {
                try {
                    current.close();
                } finally {
                    current = null;
                }
            }
        }
    }

    @Transactional(readOnly = true)
    public MediaDataResult getMediaDataByToken(String rawToken) {
        String tokenHash = computeSha256(rawToken.getBytes(StandardCharsets.UTF_8));
        Optional<MediaGrantRecord> grantOpt = mediaRepository.findMediaGrantByTokenHash(tokenHash);
        if (grantOpt.isEmpty()) {
            throw new SecurityException("Invalid media grant token");
        }

        MediaGrantRecord grant = grantOpt.get();
        if (grant.expiresAt().isBefore(Instant.now())) {
            throw new SecurityException("Media grant token has expired");
        }

        Optional<AssetRecord> assetOpt = mediaRepository.findAssetById(grant.assetId());
        if (assetOpt.isEmpty()) {
            throw new IllegalArgumentException("Asset not found");
        }

        AssetRecord asset = assetOpt.get();
        byte[] bytes = objectStorage.getObject(asset.objectKey());
        return new MediaDataResult(bytes, asset.mimeType());
    }

    /** Exams Phase 9E: an AUTHORIZED, re-openable streaming handle of a granted asset (never a storage path). */
    public record GrantedMedia(org.springframework.core.io.Resource resource, String mimeType) {}

    /**
     * Exams Phase 9E: resolves a playback grant BEFORE any byte is served — unknown token ⇒ {@link SecurityException},
     * expired grant ⇒ {@link SecurityException}, missing asset ⇒ {@link IllegalArgumentException} — and returns a streaming
     * resource with a known length, so the HTTP layer can answer {@code Range} requests (206 / 416) by streaming the
     * requested bytes only. The object is never loaded into memory as a whole.
     */
    @Transactional(readOnly = true)
    public GrantedMedia openGrantedMedia(String rawToken) {
        if (rawToken == null || rawToken.isBlank() || rawToken.length() > 200) {
            throw new SecurityException("Invalid media grant token");
        }
        String tokenHash = computeSha256(rawToken.getBytes(StandardCharsets.UTF_8));
        MediaGrantRecord grant = mediaRepository.findMediaGrantByTokenHash(tokenHash)
                .orElseThrow(() -> new SecurityException("Invalid media grant token"));
        if (grant.expiresAt() == null || !grant.expiresAt().isAfter(Instant.now())) {
            throw new SecurityException("Media grant token has expired");
        }
        AssetRecord asset = mediaRepository.findAssetById(grant.assetId())
                .orElseThrow(() -> new IllegalArgumentException("Asset not found"));
        long length = objectStorage.contentLength(asset.objectKey());
        return new GrantedMedia(new StoredObjectResource(objectStorage, asset.objectKey(), length, asset.id()), asset.mimeType());
    }

    /** Streaming view of one stored object: each read opens a fresh stream; description never names the storage key. */
    static final class StoredObjectResource extends org.springframework.core.io.AbstractResource {
        private final ExamObjectStorage storage;
        private final String objectKey;
        private final long length;
        private final UUID assetId;

        StoredObjectResource(ExamObjectStorage storage, String objectKey, long length, UUID assetId) {
            this.storage = storage;
            this.objectKey = objectKey;
            this.length = length;
            this.assetId = assetId;
        }

        @Override
        public InputStream getInputStream() {
            return storage.getObjectStream(objectKey);
        }

        @Override
        public long contentLength() throws java.io.IOException {
            return length >= 0 ? length : super.contentLength();
        }

        @Override
        public boolean exists() {
            return true;
        }

        @Override
        public String getFilename() {
            return null;
        }

        @Override
        public String getDescription() {
            return "exam media asset " + assetId;
        }
    }

    @Transactional(readOnly = true)
    public MediaStreamResult getMediaStreamWithMetaByToken(String rawToken) {
        String tokenHash = computeSha256(rawToken.getBytes(StandardCharsets.UTF_8));
        Optional<MediaGrantRecord> grantOpt = mediaRepository.findMediaGrantByTokenHash(tokenHash);
        if (grantOpt.isEmpty()) {
            throw new SecurityException("Invalid media grant token");
        }

        MediaGrantRecord grant = grantOpt.get();
        if (grant.expiresAt().isBefore(Instant.now())) {
            throw new SecurityException("Media grant token has expired");
        }

        Optional<AssetRecord> assetOpt = mediaRepository.findAssetById(grant.assetId());
        if (assetOpt.isEmpty()) {
            throw new IllegalArgumentException("Asset not found");
        }

        AssetRecord asset = assetOpt.get();
        InputStream stream = objectStorage.getObjectStream(asset.objectKey());
        return new MediaStreamResult(stream, asset.mimeType());
    }

    @Transactional(readOnly = true)
    public Optional<RecordingRecord> findRecordingById(UUID recordingId) {
        return mediaRepository.findRecordingById(recordingId);
    }

    @Transactional
    public void updateRecordingTranscript(UUID recordingId, String transcriptStatus, String transcriptText) {
        mediaRepository.updateRecordingTranscript(recordingId, transcriptStatus, transcriptText);
    }

    public record UploadChunkReceiptDto(
            UUID recordingId,
            int sequenceNumber,
            String sha256Hash,
            long bytesReceived,
            String status,
            int acknowledgedChunkCount
    ) {
        public UploadChunkReceiptDto(UUID recordingId, int sequenceNumber, String sha256Hash, long bytesReceived, String status) {
            this(recordingId, sequenceNumber, sha256Hash, bytesReceived, status, 1);
        }
    }
}
