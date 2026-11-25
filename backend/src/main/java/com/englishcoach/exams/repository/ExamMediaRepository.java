package com.englishcoach.exams.repository;

import com.englishcoach.exams.model.ExamContentRecords.AssetRecord;
import com.englishcoach.exams.model.ExamMediaRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;

@Slf4j
@Repository
@RequiredArgsConstructor
public class ExamMediaRepository {

    private final NamedParameterJdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;

    private String toJson(Object obj) {
        if (obj == null) return null;
        try {
            return objectMapper.writeValueAsString(obj);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Failed to serialize to JSON: " + e.getMessage(), e);
        }
    }

    private <T> T fromJson(String json, TypeReference<T> typeRef) {
        if (json == null || json.isBlank()) return null;
        try {
            return objectMapper.readValue(json, typeRef);
        } catch (JsonProcessingException e) {
            log.error("Failed to parse JSON: {}", json, e);
            return null;
        }
    }

    private Map<String, Object> fromJsonMap(String json) {
        return fromJson(json, new TypeReference<Map<String, Object>>() {});
    }

    private List<Map<String, Object>> fromJsonList(String json) {
        return fromJson(json, new TypeReference<List<Map<String, Object>>>() {});
    }

    private static Instant toInstant(Timestamp ts) {
        return ts != null ? ts.toInstant() : null;
    }

    // ─── Row Mappers ──────────────────────────────────────────────────────────

    private final RowMapper<RecordingRecord> recordingRowMapper = (rs, rowNum) -> new RecordingRecord(
            (UUID) rs.getObject("id"),
            (UUID) rs.getObject("attempt_id"),
            (UUID) rs.getObject("response_id"),
            rs.getString("placement_id"),
            toInstant(rs.getTimestamp("capture_window_start")),
            toInstant(rs.getTimestamp("capture_window_end")),
            rs.getString("codec"),
            fromJsonMap(rs.getString("device_meta")),
            RecordingState.valueOf(rs.getString("state")),
            rs.getInt("chunk_count"),
            rs.getLong("total_bytes"),
            fromJsonList(rs.getString("ordered_manifest")),
            (UUID) rs.getObject("original_asset_id"),
            (UUID) rs.getObject("canonical_asset_id"),
            fromJsonMap(rs.getString("quality_meta")),
            toInstant(rs.getTimestamp("created_at")),
            (Integer) rs.getObject("generation"),
            (UUID) rs.getObject("supersedes_recording_id"),
            (Long) rs.getObject("duration_ms"),
            rs.getString("transcript_status"),
            rs.getString("transcript_text"),
            rs.getString("evidence_status")
    );

    private final RowMapper<RecordingChunkRecord> chunkRowMapper = (rs, rowNum) -> new RecordingChunkRecord(
            (UUID) rs.getObject("id"),
            (UUID) rs.getObject("recording_id"),
            rs.getInt("sequence_number"),
            rs.getString("object_key"),
            rs.getString("sha256_hash"),
            rs.getLong("byte_size"),
            toInstant(rs.getTimestamp("received_at"))
    );

    private final RowMapper<MediaGrantRecord> grantRowMapper = (rs, rowNum) -> new MediaGrantRecord(
            (UUID) rs.getObject("id"),
            (UUID) rs.getObject("attempt_id"),
            (UUID) rs.getObject("asset_id"),
            MediaPurpose.valueOf(rs.getString("purpose")),
            rs.getString("playback_session_id"),
            rs.getInt("allowed_start_timeline"),
            toInstant(rs.getTimestamp("expires_at")),
            rs.getString("token_hash"),
            toInstant(rs.getTimestamp("consumed_at")),
            toInstant(rs.getTimestamp("created_at"))
    );

    private final RowMapper<AssetRecord> assetRowMapper = (rs, rowNum) -> new AssetRecord(
            (UUID) rs.getObject("id"),
            (UUID) rs.getObject("provenance_id"),
            rs.getString("object_key"),
            rs.getString("version_id"),
            rs.getString("sha256_hash"),
            rs.getString("mime_type"),
            rs.getLong("byte_size"),
            (Integer) rs.getObject("duration_ms"),
            rs.getString("dimensions"),
            rs.getString("validation_state"),
            toInstant(rs.getTimestamp("created_at"))
    );

    // ─── Query Operations ─────────────────────────────────────────────────────

    public Optional<RecordingRecord> findRecordingById(UUID recordingId) {
        String sql = "SELECT * FROM exams.recordings WHERE id = :id";
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql,
                    new MapSqlParameterSource("id", recordingId), recordingRowMapper));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public Optional<RecordingChunkRecord> findChunkByRecordingAndSequence(UUID recordingId, int sequenceNumber) {
        String sql = "SELECT * FROM exams.recording_chunks WHERE recording_id = :id AND sequence_number = :seq";
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql,
                    new MapSqlParameterSource("id", recordingId).addValue("seq", sequenceNumber), chunkRowMapper));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public int countRecordingsForResponse(UUID responseId) {
        String sql = "SELECT COUNT(*) FROM exams.recordings WHERE response_id = :responseId";
        Integer count = jdbcTemplate.queryForObject(sql, new MapSqlParameterSource("responseId", responseId), Integer.class);
        return count != null ? count : 0;
    }

    public Optional<RecordingRecord> findLatestRecordingByResponseId(UUID responseId) {
        String sql = "SELECT * FROM exams.recordings WHERE response_id = :responseId ORDER BY generation DESC NULLS LAST, created_at DESC LIMIT 1";
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql,
                    new MapSqlParameterSource("responseId", responseId), recordingRowMapper));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public List<RecordingChunkRecord> findChunksByRecordingId(UUID recordingId) {
        String sql = "SELECT * FROM exams.recording_chunks WHERE recording_id = :id ORDER BY sequence_number ASC";
        return jdbcTemplate.query(sql, new MapSqlParameterSource("id", recordingId), chunkRowMapper);
    }

    public List<RecordingRecord> findRecordingsByAttemptId(UUID attemptId) {
        String sql = "SELECT * FROM exams.recordings WHERE attempt_id = :attemptId ORDER BY created_at ASC";
        return jdbcTemplate.query(sql, new MapSqlParameterSource("attemptId", attemptId), recordingRowMapper);
    }

    public Optional<MediaGrantRecord> findMediaGrantByTokenHash(String tokenHash) {
        String sql = "SELECT * FROM exams.media_grants WHERE token_hash = :hash";
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql,
                    new MapSqlParameterSource("hash", tokenHash), grantRowMapper));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public Optional<AssetRecord> findAssetById(UUID assetId) {
        String sql = "SELECT * FROM exams.assets WHERE id = :id";
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql,
                    new MapSqlParameterSource("id", assetId), assetRowMapper));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    // ─── Mutation Operations ──────────────────────────────────────────────────

    public UUID insertRecording(RecordingRecord rec) {
        UUID id = rec.id() != null ? rec.id() : UUID.randomUUID();
        // Constraint ck_recordings_v4_generation_link requires generation IS NOT NULL iff response_id IS NOT NULL
        Integer generation = rec.responseId() != null ? (rec.generation() != null ? rec.generation() : 0) : null;
        UUID supersedesId = (generation != null && generation > 0) ? rec.supersedesRecordingId() : null;
        String sql = """
            INSERT INTO exams.recordings (id, attempt_id, response_id, placement_id, capture_window_start,
                capture_window_end, codec, device_meta, state, chunk_count, total_bytes, ordered_manifest,
                original_asset_id, canonical_asset_id, quality_meta, generation, supersedes_recording_id,
                duration_ms, transcript_status, transcript_text, evidence_status, created_at)
            VALUES (:id, :attemptId, :responseId, :placementId, :start, :end, :codec, :deviceMeta::jsonb,
                :state, :chunkCount, :totalBytes, :manifest::jsonb, :originalAssetId, :canonicalAssetId,
                :qualityMeta::jsonb, :generation, :supersedesRecordingId,
                :durationMs, :transcriptStatus, :transcriptText, :evidenceStatus, clock_timestamp())
            RETURNING id
        """;
        return jdbcTemplate.queryForObject(sql, new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("attemptId", rec.attemptId())
                .addValue("responseId", rec.responseId())
                .addValue("placementId", rec.placementId())
                .addValue("start", Timestamp.from(rec.captureWindowStart()))
                .addValue("end", Timestamp.from(rec.captureWindowEnd()))
                .addValue("codec", rec.codec())
                .addValue("deviceMeta", toJson(rec.deviceMeta()))
                .addValue("state", rec.state().name())
                .addValue("chunkCount", rec.chunkCount())
                .addValue("totalBytes", rec.totalBytes())
                .addValue("manifest", toJson(rec.orderedManifest()))
                .addValue("originalAssetId", rec.originalAssetId())
                .addValue("canonicalAssetId", rec.canonicalAssetId())
                .addValue("qualityMeta", toJson(rec.qualityMeta()))
                .addValue("generation", generation)
                .addValue("supersedesRecordingId", supersedesId)
                .addValue("durationMs", rec.durationMs())
                .addValue("transcriptStatus", rec.transcriptStatus() != null ? rec.transcriptStatus() : "NOT_REQUESTED")
                .addValue("transcriptText", rec.transcriptText())
                .addValue("evidenceStatus", rec.evidenceStatus() != null ? rec.evidenceStatus() : "PENDING"), UUID.class);
    }

    public void insertRecordingChunk(RecordingChunkRecord chunk) {
        String sql = """
            INSERT INTO exams.recording_chunks (id, recording_id, sequence_number, object_key, sha256_hash, byte_size, received_at)
            VALUES (gen_random_uuid(), :recordingId, :sequence, :objectKey, :hash, :bytes, clock_timestamp())
            ON CONFLICT (recording_id, sequence_number) DO UPDATE SET
                sha256_hash = EXCLUDED.sha256_hash,
                byte_size = EXCLUDED.byte_size
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("recordingId", chunk.recordingId())
                .addValue("sequence", chunk.sequenceNumber())
                .addValue("objectKey", chunk.objectKey())
                .addValue("hash", chunk.sha256Hash())
                .addValue("bytes", chunk.byteSize()));
    }

    public void updateRecordingSealed(UUID recordingId, RecordingState state, int chunkCount,
                                      long totalBytes, List<Map<String, Object>> manifest) {
        updateRecordingSealed(recordingId, state, chunkCount, totalBytes, manifest, null);
    }

    public void updateRecordingSealed(UUID recordingId, RecordingState state, int chunkCount,
                                      long totalBytes, List<Map<String, Object>> manifest, UUID sealCommandId) {
        String sql = """
            UPDATE exams.recordings
            SET state = :state,
                chunk_count = :count,
                total_bytes = :bytes,
                ordered_manifest = :manifest::jsonb,
                sealed_manifest = :manifest::jsonb,
                evidence_status = 'READY',
                seal_command_id = :sealCommandId
            WHERE id = :id
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("id", recordingId)
                .addValue("state", state.name())
                .addValue("count", chunkCount)
                .addValue("bytes", totalBytes)
                .addValue("manifest", toJson(manifest))
                .addValue("sealCommandId", sealCommandId));
    }

    public void updateRecordingFailed(UUID recordingId, String errorCode) {
        String sql = """
            UPDATE exams.recordings
            SET state = 'FAILED',
                last_error_code = :errorCode,
                evidence_status = 'FAILED'
            WHERE id = :id
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("id", recordingId)
                .addValue("errorCode", errorCode));
    }

    public void insertMediaGrant(MediaGrantRecord grant) {
        String sql = """
            INSERT INTO exams.media_grants (id, attempt_id, asset_id, purpose, playback_session_id,
                allowed_start_timeline, expires_at, token_hash, created_at)
            VALUES (gen_random_uuid(), :attemptId, :assetId, :purpose, :sessionId,
                :startTimeline, :expiresAt, :tokenHash, clock_timestamp())
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("attemptId", grant.attemptId())
                .addValue("assetId", grant.assetId())
                .addValue("purpose", grant.purpose().name())
                .addValue("sessionId", grant.playbackSessionId())
                .addValue("startTimeline", grant.allowedStartTimeline())
                .addValue("expiresAt", Timestamp.from(grant.expiresAt()))
                .addValue("tokenHash", grant.tokenHash()));
    }

    public void markMediaGrantConsumed(UUID grantId) {
        String sql = "UPDATE exams.media_grants SET consumed_at = clock_timestamp() WHERE id = :id";
        jdbcTemplate.update(sql, new MapSqlParameterSource("id", grantId));
    }

    public void updateRecordingTranscript(UUID recordingId, String transcriptStatus, String transcriptText) {
        String sql = """
            UPDATE exams.recordings
            SET transcript_status = :status,
                transcript_text = :text
            WHERE id = :id
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("id", recordingId)
                .addValue("status", transcriptStatus)
                .addValue("text", transcriptText));
    }
}
