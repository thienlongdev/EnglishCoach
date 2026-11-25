package com.englishcoach.exams.model;

import com.englishcoach.exams.model.ExamTypes.*;
import com.fasterxml.jackson.annotation.JsonInclude;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class ExamMediaRecords {

    private ExamMediaRecords() {}

    // ─── Database Projections ─────────────────────────────────────────────────

    public record RecordingRecord(
            UUID id,
            UUID attemptId,
            UUID responseId,
            String placementId,
            Instant captureWindowStart,
            Instant captureWindowEnd,
            String codec,
            Map<String, Object> deviceMeta,
            RecordingState state,
            int chunkCount,
            long totalBytes,
            List<Map<String, Object>> orderedManifest,
            UUID originalAssetId,
            UUID canonicalAssetId,
            Map<String, Object> qualityMeta,
            Instant createdAt,
            Integer generation,
            UUID supersedesRecordingId,
            Long durationMs,
            String transcriptStatus,
            String transcriptText,
            String evidenceStatus
    ) {
        public RecordingRecord(
                UUID id, UUID attemptId, UUID responseId, String placementId,
                Instant captureWindowStart, Instant captureWindowEnd, String codec,
                Map<String, Object> deviceMeta, RecordingState state, int chunkCount,
                long totalBytes, List<Map<String, Object>> orderedManifest,
                UUID originalAssetId, UUID canonicalAssetId, Map<String, Object> qualityMeta,
                Instant createdAt
        ) {
            this(id, attemptId, responseId, placementId, captureWindowStart, captureWindowEnd,
                 codec, deviceMeta, state, chunkCount, totalBytes, orderedManifest,
                 originalAssetId, canonicalAssetId, qualityMeta, createdAt,
                 responseId != null ? 0 : null, null, null, "NOT_REQUESTED", null, "PENDING");
        }
    }

    public record RecordingChunkRecord(
            UUID id,
            UUID recordingId,
            int sequenceNumber,
            String objectKey,
            String sha256Hash,
            long byteSize,
            Instant receivedAt
    ) {}

    public record MediaGrantRecord(
            UUID id,
            UUID attemptId,
            UUID assetId,
            MediaPurpose purpose,
            String playbackSessionId,
            int allowedStartTimeline,
            Instant expiresAt,
            String tokenHash,
            Instant consumedAt,
            Instant createdAt
    ) {}

    // ─── Media DTOs ───────────────────────────────────────────────────────────

    public record InitiateRecordingRequest(
            UUID attemptId,
            String placementId,
            String codec,
            Map<String, Object> deviceMeta,
            String turnKey,
            String commandId,
            Long expectedAttemptRevision
    ) {
        public InitiateRecordingRequest(String placementId, String codec, Map<String, Object> deviceMeta) {
            this(null, placementId, codec, deviceMeta, null, null, null);
        }

        public InitiateRecordingRequest(UUID attemptId, String placementId, String codec, Map<String, Object> deviceMeta) {
            this(attemptId, placementId, codec, deviceMeta, null, null, null);
        }
    }

    public record InitiateRecordingResponseDto(
            UUID recordingId,
            String placementId,
            String turnKey,
            UUID responseId,
            RecordingState state,
            int acknowledgedChunkCount
    ) {
        public InitiateRecordingResponseDto(UUID recordingId, String placementId, RecordingState state) {
            this(recordingId, placementId, null, null, state, 0);
        }
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

    public record ChunkManifestItem(
            int sequenceNumber,
            String sha256Hash,
            long byteSize
    ) {}

    public record SealRecordingRequest(
            List<ChunkManifestItem> manifest,
            Long totalBytes,
            String finalHash,
            Integer totalChunks,
            String finalSha256,
            String commandId
    ) {
        public SealRecordingRequest(List<ChunkManifestItem> manifest, Long totalBytes, String finalHash) {
            this(manifest, totalBytes, finalHash, null, null, null);
        }

        public SealRecordingRequest(List<ChunkManifestItem> manifest, Long totalBytes, String finalHash, Integer totalChunks, String finalSha256) {
            this(manifest, totalBytes, finalHash, totalChunks, finalSha256, null);
        }
    }

    public record SealRecordingResponseDto(
            UUID recordingId,
            RecordingState state,
            int chunkCount,
            long totalBytes,
            boolean isComplete
    ) {}

    public record RecordingStatusDto(
            UUID recordingId,
            UUID attemptId,
            UUID responseId,
            String placementId,
            RecordingState state,
            int chunkCount,
            long totalBytes,
            List<Integer> acknowledgedSequences,
            Integer generation,
            UUID supersedesRecordingId,
            String evidenceStatus,
            String lastErrorCode
    ) {}

    public record FailRecordingRequest(
            String errorCode
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PlaybackGrantDto(
            String grantToken,
            UUID assetId,
            String mediaStreamUrl,
            int allowedStartTimeline,
            Instant expiresAt
    ) {}
}
