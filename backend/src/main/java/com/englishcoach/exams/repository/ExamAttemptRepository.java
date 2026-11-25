package com.englishcoach.exams.repository;

import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamProfileRecords.AttemptHistoryItemDto;
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

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;

@Slf4j
@Repository
@RequiredArgsConstructor
public class ExamAttemptRepository {

    private final NamedParameterJdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;

    // ─── JSON Helpers ─────────────────────────────────────────────────────────

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

    private List<String> fromJsonList(String json) {
        return fromJson(json, new TypeReference<List<String>>() {});
    }

    private static Instant toInstant(Timestamp ts) {
        return ts != null ? ts.toInstant() : null;
    }

    // ─── Row Mappers ──────────────────────────────────────────────────────────

    private final RowMapper<AttemptRecord> attemptRowMapper = (rs, rowNum) -> {
        String snapshotStateStr = null;
        try {
            snapshotStateStr = rs.getString("snapshot_state");
        } catch (SQLException ignored) {}
        ExamSnapshotState snapshotState = snapshotStateStr != null
                ? ExamSnapshotState.fromString(snapshotStateStr)
                : ExamSnapshotState.LEGACY_UNSNAPSHOTTED;

        String manifestSnapshotStr = null;
        try {
            manifestSnapshotStr = rs.getString("manifest_snapshot");
        } catch (SQLException ignored) {}

        String snapshotVersion = null;
        try {
            snapshotVersion = rs.getString("manifest_snapshot_version");
        } catch (SQLException ignored) {}

        return new AttemptRecord(
                (UUID) rs.getObject("id"),
                rs.getLong("user_id"),
                (UUID) rs.getObject("form_id"),
                ExamFamily.valueOf(rs.getString("family")),
                rs.getString("variant"),
                rs.getString("scope"),
                ExamAttemptMode.valueOf(rs.getString("attempt_mode")),
                (UUID) rs.getObject("parent_suite_id"),
                (UUID) rs.getObject("original_full_attempt_id"),
                ExamAttemptStatus.valueOf(rs.getString("status")),
                rs.getLong("revision"),
                rs.getLong("writer_epoch"),
                rs.getString("active_token_hash"),
                toInstant(rs.getTimestamp("lease_expires_at")),
                rs.getString("pinned_manifest_hash"),
                fromJsonMap(rs.getString("client_session_meta")),
                toInstant(rs.getTimestamp("ready_at")),
                toInstant(rs.getTimestamp("started_at")),
                toInstant(rs.getTimestamp("scheduled_end_at")),
                toInstant(rs.getTimestamp("submitted_at")),
                toInstant(rs.getTimestamp("invalidated_at")),
                fromJsonList(rs.getString("integrity_flags")),
                toInstant(rs.getTimestamp("created_at")),
                toInstant(rs.getTimestamp("updated_at")),
                fromJsonMap(manifestSnapshotStr),
                snapshotVersion,
                snapshotState
        );
    };

    private final RowMapper<AttemptSectionRecord> attemptSectionRowMapper = (rs, rowNum) -> {
        String turnPlacementId = null;
        try {
            turnPlacementId = rs.getString("current_turn_placement_id");
        } catch (SQLException ignored) {}

        String turnKey = null;
        try {
            turnKey = rs.getString("current_turn_key");
        } catch (SQLException ignored) {}

        int turnCursor = 0;
        try {
            turnCursor = rs.getInt("turn_cursor");
        } catch (SQLException ignored) {}

        long turnRevision = 0L;
        try {
            turnRevision = rs.getLong("turn_revision");
        } catch (SQLException ignored) {}

        return new AttemptSectionRecord(
                (UUID) rs.getObject("id"),
                (UUID) rs.getObject("attempt_id"),
                (UUID) rs.getObject("section_id"),
                ExamSectionState.valueOf(rs.getString("state")),
                rs.getString("phase"),
                toInstant(rs.getTimestamp("started_at")),
                toInstant(rs.getTimestamp("deadline_at")),
                toInstant(rs.getTimestamp("sealed_at")),
                fromJsonMap(rs.getString("timing_policy_snapshot")),
                toInstant(rs.getTimestamp("created_at")),
                turnPlacementId,
                turnKey,
                turnCursor,
                turnRevision
        );
    };

    private final RowMapper<ResponseRecord> responseRowMapper = (rs, rowNum) -> {
        String turnKey = null;
        try {
            turnKey = rs.getString("turn_key");
        } catch (SQLException ignored) {}

        Integer turnSequence = null;
        try {
            int seq = rs.getInt("turn_sequence");
            if (!rs.wasNull()) {
                turnSequence = seq;
            }
        } catch (SQLException ignored) {}

        String responseKind = "ITEM";
        try {
            String rk = rs.getString("response_kind");
            if (rk != null) responseKind = rk;
        } catch (SQLException ignored) {}

        String turnState = "LOCKED";
        try {
            String ts = rs.getString("turn_state");
            if (ts != null) turnState = ts;
        } catch (SQLException ignored) {}

        Map<String, Object> sourceSnapshot = null;
        try {
            sourceSnapshot = fromJsonMap(rs.getString("source_snapshot"));
        } catch (SQLException ignored) {}

        String exposureHash = null;
        try {
            exposureHash = rs.getString("exposure_hash");
        } catch (SQLException ignored) {}

        return new ResponseRecord(
                (UUID) rs.getObject("id"),
                (UUID) rs.getObject("attempt_id"),
                (UUID) rs.getObject("section_id"),
                rs.getString("placement_id"),
                (UUID) rs.getObject("item_id"),
                fromJsonMap(rs.getString("answer_payload")),
                rs.getString("text_response"),
                (UUID) rs.getObject("recording_id"),
                rs.getBoolean("flagged"),
                rs.getLong("revision"),
                rs.getString("last_command_id"),
                toInstant(rs.getTimestamp("updated_at")),
                turnKey,
                turnSequence,
                responseKind,
                turnState,
                sourceSnapshot,
                exposureHash
        );
    };

    private final RowMapper<SubmissionRecord> submissionRowMapper = (rs, rowNum) -> new SubmissionRecord(
            (UUID) rs.getObject("id"),
            (UUID) rs.getObject("attempt_id"),
            SubmissionReason.valueOf(rs.getString("reason")),
            toInstant(rs.getTimestamp("cutoff_time")),
            fromJsonMap(rs.getString("response_snapshot")),
            rs.getString("manifest_hash"),
            fromJsonMap(rs.getString("recording_manifest")),
            rs.getString("submission_hash"),
            toInstant(rs.getTimestamp("created_at"))
    );

    private final RowMapper<CommandReceiptRecord> commandReceiptRowMapper = (rs, rowNum) -> new CommandReceiptRecord(
            (UUID) rs.getObject("id"),
            rs.getLong("user_id"),
            (UUID) rs.getObject("attempt_id"),
            rs.getString("command_id"),
            rs.getString("operation"),
            rs.getString("request_hash"),
            rs.getString("result_reference"),
            rs.getString("status"),
            toInstant(rs.getTimestamp("created_at"))
    );

    // ─── Query / Lock Operations ──────────────────────────────────────────────

    public Optional<AttemptRecord> findAttemptById(UUID attemptId) {
        String sql = "SELECT * FROM exams.attempts WHERE id = :id";
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql,
                    new MapSqlParameterSource("id", attemptId), attemptRowMapper));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public Optional<AttemptRecord> findAttemptByIdForUpdate(UUID attemptId) {
        String sql = "SELECT * FROM exams.attempts WHERE id = :id FOR UPDATE";
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql,
                    new MapSqlParameterSource("id", attemptId), attemptRowMapper));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public void acquireUserSimulationLock(Long userId) {
        String sql = "SELECT pg_advisory_xact_lock(hashtext('exam_sim_' || :userId))";
        jdbcTemplate.query(sql, new MapSqlParameterSource("userId", userId), rs -> null);
    }

    /** Exams Phase 9D: per-learner transaction lock serializing Practice Again (no duplicate retry attempts). */
    public void acquireUserPracticeLock(Long userId) {
        String sql = "SELECT pg_advisory_xact_lock(hashtext('exam_practice_' || :userId))";
        jdbcTemplate.query(sql, new MapSqlParameterSource("userId", userId), rs -> null);
    }

    /**
     * Exams Phase 9D: the learner's unfinished (CREATED / READY / IN_PROGRESS) practice attempt that was started as
     * "Practice Again" of {@code previousAttemptId} (pinned {@code practiceScope.practiceAgainOf}), if any.
     */
    public Optional<AttemptRecord> findUnfinishedPracticeAgain(Long userId, UUID previousAttemptId) {
        String sql = """
            SELECT * FROM exams.attempts
            WHERE user_id = :userId
              AND attempt_mode = 'PRACTICE'
              AND status IN ('CREATED', 'READY', 'IN_PROGRESS')
              AND manifest_snapshot -> 'practiceScope' ->> 'practiceAgainOf' = :previous
            ORDER BY created_at DESC
            LIMIT 1
        """;
        List<AttemptRecord> rows = jdbcTemplate.query(sql, new MapSqlParameterSource()
                .addValue("userId", userId)
                .addValue("previous", previousAttemptId.toString()), attemptRowMapper);
        return rows.stream().findFirst();
    }

    public Optional<AttemptRecord> findActiveSimulationAttempt(Long userId) {
        String sql = """
            SELECT * FROM exams.attempts
            WHERE user_id = :userId
              AND attempt_mode = 'EXAM_SIMULATION'
              AND status IN ('CREATED', 'READY', 'IN_PROGRESS')
              AND submitted_at IS NULL
              AND invalidated_at IS NULL
            ORDER BY created_at DESC
            LIMIT 1
        """;
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql,
                    new MapSqlParameterSource("userId", userId), attemptRowMapper));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public List<AttemptSectionRecord> findSectionsByAttemptId(UUID attemptId) {
        String sql = """
            SELECT asec.*
            FROM exams.attempt_sections asec
            JOIN exams.sections s ON asec.section_id = s.id
            WHERE asec.attempt_id = :attemptId
            ORDER BY s.ordinal ASC
        """;
        return jdbcTemplate.query(sql, new MapSqlParameterSource("attemptId", attemptId), attemptSectionRowMapper);
    }

    public List<ResponseRecord> findResponsesByAttemptId(UUID attemptId) {
        String sql = "SELECT * FROM exams.responses WHERE attempt_id = :attemptId ORDER BY placement_id ASC";
        return jdbcTemplate.query(sql, new MapSqlParameterSource("attemptId", attemptId), responseRowMapper);
    }

    public Optional<ResponseRecord> findResponse(UUID attemptId, String placementId) {
        String sql = "SELECT * FROM exams.responses WHERE attempt_id = :attemptId AND placement_id = :placementId AND turn_key IS NULL";
        List<ResponseRecord> list = jdbcTemplate.query(sql,
                new MapSqlParameterSource()
                        .addValue("attemptId", attemptId)
                        .addValue("placementId", placementId),
                responseRowMapper);
        return list.isEmpty() ? Optional.empty() : Optional.of(list.get(0));
    }

    public Optional<SubmissionRecord> findSubmissionById(UUID submissionId) {
        String sql = "SELECT * FROM exams.submissions WHERE id = :id";
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql,
                    new MapSqlParameterSource("id", submissionId), submissionRowMapper));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public Optional<SubmissionRecord> findSubmissionByAttemptId(UUID attemptId) {
        String sql = "SELECT * FROM exams.submissions WHERE attempt_id = :attemptId";
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql,
                    new MapSqlParameterSource("attemptId", attemptId), submissionRowMapper));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public Optional<CommandReceiptRecord> findCommandReceipt(Long userId, String operation, String commandId) {
        String sql = """
            SELECT * FROM exams.command_receipts
            WHERE user_id = :userId AND operation = :op AND command_id = :cmdId
        """;
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql,
                    new MapSqlParameterSource()
                            .addValue("userId", userId)
                            .addValue("op", operation)
                            .addValue("cmdId", commandId),
                    commandReceiptRowMapper));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public List<AttemptHistoryItemDto> findHistoryByUserId(Long userId, ExamFamily family, String variant,
                                                          ExamAttemptMode mode, int limit, int offset) {
        StringBuilder sql = new StringBuilder("""
            SELECT a.id as attempt_id, a.form_id, f.title as form_title, a.family, a.variant, a.scope,
                   a.attempt_mode, a.status, a.started_at, a.submitted_at,
                   sc.scaled_score as final_score,
                   CASE WHEN a.attempt_mode = 'PRACTICE' THEN a.client_session_meta ->> 'practiceScopeCode' END as practice_scope_code
            FROM exams.attempts a
            JOIN exams.form_versions f ON a.form_id = f.id
            LEFT JOIN exams.submissions sub ON a.id = sub.attempt_id
            LEFT JOIN LATERAL (
                SELECT sa.id FROM exams.score_artifacts sa
                WHERE sa.submission_id = sub.id
                ORDER BY sa.run_ordinal DESC, sa.created_at DESC
                LIMIT 1
            ) art ON TRUE
            LEFT JOIN exams.score_components sc ON art.id = sc.artifact_id
                 AND (
                     (a.family = 'IELTS' AND sc.metric = 'FULL_OVERALL')
                  OR (a.family = 'TOEIC' AND sc.metric = 'LR_TOTAL')
                 )
            WHERE a.user_id = :userId
        """);

        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("userId", userId)
                .addValue("limit", limit)
                .addValue("offset", offset);

        if (family != null) {
            sql.append(" AND a.family = :family");
            params.addValue("family", family.name());
        }
        if (variant != null && !variant.isBlank()) {
            sql.append(" AND a.variant = :variant");
            params.addValue("variant", variant);
        }
        if (mode != null) {
            sql.append(" AND a.attempt_mode = :mode");
            params.addValue("mode", mode.name());
        }

        sql.append("""
            ORDER BY a.created_at DESC
            LIMIT :limit OFFSET :offset
        """);

        return jdbcTemplate.query(sql.toString(), params, (rs, rowNum) -> new AttemptHistoryItemDto(
                (UUID) rs.getObject("attempt_id"),
                (UUID) rs.getObject("form_id"),
                rs.getString("form_title"),
                ExamFamily.valueOf(rs.getString("family")),
                rs.getString("variant"),
                rs.getString("scope"),
                ExamAttemptMode.valueOf(rs.getString("attempt_mode")),
                ExamAttemptStatus.valueOf(rs.getString("status")),
                rs.getObject("final_score") != null ? rs.getDouble("final_score") : null,
                toInstant(rs.getTimestamp("started_at")),
                toInstant(rs.getTimestamp("submitted_at")),
                rs.getString("practice_scope_code")
        ));
    }

    public boolean hasPriorExposure(Long userId, String logicalKey, int version) {
        String sql = """
            SELECT COUNT(*) FROM exams.exposures
            WHERE user_id = :userId AND logical_content_key = :logicalKey AND version = :version
        """;
        Integer count = jdbcTemplate.queryForObject(sql,
                new MapSqlParameterSource()
                        .addValue("userId", userId)
                        .addValue("logicalKey", logicalKey)
                        .addValue("version", version),
                Integer.class);
        return count != null && count > 0;
    }

    // ─── Mutation Operations ──────────────────────────────────────────────────

    public UUID insertAttempt(AttemptRecord attempt) {
        UUID id = attempt.id() != null ? attempt.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.attempts (id, user_id, form_id, family, variant, scope, attempt_mode,
                parent_suite_id, original_full_attempt_id, status, revision, writer_epoch, active_token_hash,
                lease_expires_at, pinned_manifest_hash, client_session_meta, ready_at, started_at,
                scheduled_end_at, submitted_at, invalidated_at, integrity_flags, created_at, updated_at,
                manifest_snapshot, manifest_snapshot_version, snapshot_state)
            VALUES (:id, :userId, :formId, :family, :variant, :scope, :attemptMode,
                :parentSuiteId, :originalFullAttemptId, :status, :revision, :writerEpoch, :activeTokenHash,
                :leaseExpiresAt, :pinnedManifestHash, :clientSessionMeta::jsonb, :readyAt, :startedAt,
                :scheduledEndAt, :submittedAt, :invalidatedAt, :integrityFlags::jsonb, clock_timestamp(), clock_timestamp(),
                :manifestSnapshot::jsonb, :manifestSnapshotVersion, :snapshotState)
            RETURNING id
        """;
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("userId", attempt.userId())
                .addValue("formId", attempt.formId())
                .addValue("family", attempt.family().name())
                .addValue("variant", attempt.variant())
                .addValue("scope", attempt.scope())
                .addValue("attemptMode", attempt.attemptMode().name())
                .addValue("parentSuiteId", attempt.parentSuiteId())
                .addValue("originalFullAttemptId", attempt.originalFullAttemptId())
                .addValue("status", attempt.status().name())
                .addValue("revision", attempt.revision())
                .addValue("writerEpoch", attempt.writerEpoch())
                .addValue("activeTokenHash", attempt.activeTokenHash())
                .addValue("leaseExpiresAt", attempt.leaseExpiresAt() != null ? Timestamp.from(attempt.leaseExpiresAt()) : null)
                .addValue("pinnedManifestHash", attempt.pinnedManifestHash())
                .addValue("clientSessionMeta", toJson(attempt.clientSessionMeta()))
                .addValue("readyAt", attempt.readyAt() != null ? Timestamp.from(attempt.readyAt()) : null)
                .addValue("startedAt", attempt.startedAt() != null ? Timestamp.from(attempt.startedAt()) : null)
                .addValue("scheduledEndAt", attempt.scheduledEndAt() != null ? Timestamp.from(attempt.scheduledEndAt()) : null)
                .addValue("submittedAt", attempt.submittedAt() != null ? Timestamp.from(attempt.submittedAt()) : null)
                .addValue("invalidatedAt", attempt.invalidatedAt() != null ? Timestamp.from(attempt.invalidatedAt()) : null)
                .addValue("integrityFlags", toJson(attempt.integrityFlags()))
                .addValue("manifestSnapshot", toJson(attempt.manifestSnapshot()))
                .addValue("manifestSnapshotVersion", attempt.manifestSnapshotVersion())
                .addValue("snapshotState", attempt.snapshotState() != null ? attempt.snapshotState().name() : ExamSnapshotState.LEGACY_UNSNAPSHOTTED.name());
        return jdbcTemplate.queryForObject(sql, params, UUID.class);
    }

    public void insertAttemptSection(AttemptSectionRecord sec) {
        String sql = """
            INSERT INTO exams.attempt_sections (id, attempt_id, section_id, state, phase, started_at,
                deadline_at, sealed_at, timing_policy_snapshot, created_at)
            VALUES (gen_random_uuid(), :attemptId, :sectionId, :state, :phase, :startedAt,
                :deadlineAt, :sealedAt, :policySnapshot::jsonb, clock_timestamp())
            ON CONFLICT (attempt_id, section_id) DO NOTHING
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("attemptId", sec.attemptId())
                .addValue("sectionId", sec.sectionId())
                .addValue("state", sec.state().name())
                .addValue("phase", sec.phase())
                .addValue("startedAt", sec.startedAt() != null ? Timestamp.from(sec.startedAt()) : null)
                .addValue("deadlineAt", sec.deadlineAt() != null ? Timestamp.from(sec.deadlineAt()) : null)
                .addValue("sealedAt", sec.sealedAt() != null ? Timestamp.from(sec.sealedAt()) : null)
                .addValue("policySnapshot", toJson(sec.timingPolicySnapshot())));
    }

    public boolean updateAttemptStatus(UUID attemptId, ExamAttemptStatus newStatus, long expectedRevision) {
        String sql = """
            UPDATE exams.attempts
            SET status = :newStatus,
                submitted_at = CASE WHEN :newStatus = 'SUBMITTED' AND submitted_at IS NULL THEN clock_timestamp() ELSE submitted_at END,
                started_at = CASE WHEN :newStatus = 'IN_PROGRESS' AND started_at IS NULL THEN clock_timestamp() ELSE started_at END,
                ready_at = CASE WHEN :newStatus = 'READY' AND ready_at IS NULL THEN clock_timestamp() ELSE ready_at END,
                invalidated_at = CASE WHEN :newStatus = 'INVALIDATED' AND invalidated_at IS NULL THEN clock_timestamp() ELSE invalidated_at END,
                revision = revision + 1,
                updated_at = clock_timestamp()
            WHERE id = :id AND revision = :expectedRevision
        """;
        int updated = jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("id", attemptId)
                .addValue("newStatus", newStatus.name())
                .addValue("expectedRevision", expectedRevision));
        return updated > 0;
    }

    public boolean invalidateAttempt(UUID attemptId) {
        String sql = """
            UPDATE exams.attempts
            SET status = 'INVALIDATED',
                invalidated_at = COALESCE(invalidated_at, clock_timestamp()),
                revision = revision + 1,
                updated_at = clock_timestamp()
            WHERE id = :id
        """;
        int updated = jdbcTemplate.update(sql, new MapSqlParameterSource("id", attemptId));
        return updated > 0;
    }

    public boolean incrementAttemptRevision(UUID attemptId) {
        String sql = """
            UPDATE exams.attempts
            SET revision = revision + 1,
                updated_at = clock_timestamp()
            WHERE id = :id
        """;
        int updated = jdbcTemplate.update(sql, new MapSqlParameterSource("id", attemptId));
        return updated > 0;
    }

    public boolean updateAttemptSchedule(UUID attemptId, Instant startedAt, Instant scheduledEndAt,
                                         ExamAttemptStatus newStatus, long expectedRevision) {
        String sql = """
            UPDATE exams.attempts
            SET status = :newStatus,
                started_at = :startedAt,
                scheduled_end_at = :scheduledEndAt,
                revision = revision + 1,
                updated_at = clock_timestamp()
            WHERE id = :id AND revision = :expectedRevision
        """;
        int updated = jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("id", attemptId)
                .addValue("newStatus", newStatus.name())
                .addValue("startedAt", Timestamp.from(startedAt))
                .addValue("scheduledEndAt", scheduledEndAt != null ? Timestamp.from(scheduledEndAt) : null)
                .addValue("expectedRevision", expectedRevision));
        return updated > 0;
    }

    public boolean updateWriterSession(UUID attemptId, long newWriterEpoch, String tokenHash,
                                       Instant leaseExpiresAt, long expectedRevision) {
        String sql = """
            UPDATE exams.attempts
            SET writer_epoch = :writerEpoch,
                active_token_hash = :tokenHash,
                lease_expires_at = :leaseExpiresAt,
                revision = revision + 1,
                updated_at = clock_timestamp()
            WHERE id = :id AND revision = :expectedRevision
        """;
        int updated = jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("id", attemptId)
                .addValue("writerEpoch", newWriterEpoch)
                .addValue("tokenHash", tokenHash)
                .addValue("leaseExpiresAt", Timestamp.from(leaseExpiresAt))
                .addValue("expectedRevision", expectedRevision));
        return updated > 0;
    }

    public void updateAttemptSection(UUID attemptId, UUID sectionId, ExamSectionState state,
                                     Instant startedAt, Instant deadlineAt, Instant sealedAt) {
        String sql = """
            UPDATE exams.attempt_sections
            SET state = :state,
                started_at = COALESCE(:startedAt, started_at),
                deadline_at = COALESCE(:deadlineAt, deadline_at),
                sealed_at = COALESCE(:sealedAt, sealed_at)
            WHERE attempt_id = :attemptId AND section_id = :sectionId
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("attemptId", attemptId)
                .addValue("sectionId", sectionId)
                .addValue("state", state.name())
                .addValue("startedAt", startedAt != null ? Timestamp.from(startedAt) : null)
                .addValue("deadlineAt", deadlineAt != null ? Timestamp.from(deadlineAt) : null)
                .addValue("sealedAt", sealedAt != null ? Timestamp.from(sealedAt) : null));
    }

    public record PlacementResolution(UUID itemId, UUID sectionId) {}

    public Optional<PlacementResolution> resolvePlacement(UUID attemptId, String placementId) {
        String sql = """
            SELECT iv.id as item_id, s.id as section_id
            FROM exams.item_versions iv
            JOIN exams.group_versions gv ON iv.group_id = gv.id
            JOIN exams.form_groups fg ON gv.id = fg.group_id
            JOIN exams.parts p ON fg.part_id = p.id
            JOIN exams.sections s ON p.section_id = s.id
            JOIN exams.attempts a ON s.form_id = a.form_id
            WHERE a.id = :attemptId
              AND ('p_' || p.part_code || '_g_' || gv.logical_group_key || '_i_' || COALESCE(iv.ordinal, 1)) = :placementId
            LIMIT 1
        """;
        List<PlacementResolution> list = jdbcTemplate.query(sql, new MapSqlParameterSource()
                .addValue("attemptId", attemptId)
                .addValue("placementId", placementId),
                (rs, rowNum) -> new PlacementResolution(
                        rs.getObject("item_id", UUID.class),
                        rs.getObject("section_id", UUID.class)
                ));
        return list.isEmpty() ? Optional.empty() : Optional.of(list.get(0));
    }

    public Optional<PlacementResolution> resolvePlacement(UUID attemptId, UUID sectionId, String placementId) {
        String sql = """
            SELECT iv.id as item_id, s.id as section_id
            FROM exams.item_versions iv
            JOIN exams.group_versions gv ON iv.group_id = gv.id
            JOIN exams.form_groups fg ON gv.id = fg.group_id
            JOIN exams.parts p ON fg.part_id = p.id
            JOIN exams.sections s ON p.section_id = s.id
            JOIN exams.attempts a ON s.form_id = a.form_id
            WHERE a.id = :attemptId
              AND s.id = :sectionId
              AND ('p_' || p.part_code || '_g_' || gv.logical_group_key || '_i_' || COALESCE(iv.ordinal, 1)) = :placementId
            LIMIT 1
        """;
        List<PlacementResolution> list = jdbcTemplate.query(sql, new MapSqlParameterSource()
                .addValue("attemptId", attemptId)
                .addValue("sectionId", sectionId)
                .addValue("placementId", placementId),
                (rs, rowNum) -> new PlacementResolution(
                        rs.getObject("item_id", UUID.class),
                        rs.getObject("section_id", UUID.class)
                ));
        return list.isEmpty() ? Optional.empty() : Optional.of(list.get(0));
    }

    public Optional<UUID> resolveItemIdByPlacement(UUID attemptId, String placementId) {
        return resolvePlacement(attemptId, placementId).map(PlacementResolution::itemId);
    }

    public long upsertResponse(UUID attemptId, UUID sectionId, String placementId, UUID itemId,
                               Map<String, Object> answerPayload, String textResponse, UUID recordingId,
                               boolean flagged, Long expectedRevision, String commandId) {
        // Find existing revision if any
        Optional<ResponseRecord> existing = findResponse(attemptId, placementId);
        long newRev = existing.map(r -> r.revision() + 1).orElse(1L);

        if (existing.isPresent() && expectedRevision != null && existing.get().revision() != expectedRevision) {
            throw new IllegalStateException(String.format(
                    "CONCURRENT_RESPONSE_CONFLICT: Expected revision %d for placement %s but found %d",
                    expectedRevision, placementId, existing.get().revision()));
        }

        String sql = """
            INSERT INTO exams.responses (id, attempt_id, section_id, placement_id, item_id,
                answer_payload, text_response, recording_id, flagged, revision, last_command_id, updated_at)
            VALUES (gen_random_uuid(), :attemptId, :sectionId, :placementId, :itemId,
                :answerPayload::jsonb, :textResponse, :recordingId, :flagged, :revision, :cmdId, clock_timestamp())
            ON CONFLICT (attempt_id, placement_id) WHERE turn_key IS NULL DO UPDATE SET
                answer_payload = COALESCE(EXCLUDED.answer_payload, exams.responses.answer_payload),
                text_response = COALESCE(EXCLUDED.text_response, exams.responses.text_response),
                recording_id = COALESCE(EXCLUDED.recording_id, exams.responses.recording_id),
                flagged = EXCLUDED.flagged,
                revision = EXCLUDED.revision,
                last_command_id = EXCLUDED.last_command_id,
                updated_at = clock_timestamp()
            RETURNING revision
        """;
        return jdbcTemplate.queryForObject(sql, new MapSqlParameterSource()
                .addValue("attemptId", attemptId)
                .addValue("sectionId", sectionId)
                .addValue("placementId", placementId)
                .addValue("itemId", itemId)
                .addValue("answerPayload", toJson(answerPayload))
                .addValue("textResponse", textResponse)
                .addValue("recordingId", recordingId)
                .addValue("flagged", flagged)
                .addValue("revision", newRev)
                .addValue("cmdId", commandId), Long.class);
    }

    public UUID insertSubmission(SubmissionRecord submission) {
        UUID id = submission.id() != null ? submission.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.submissions (id, attempt_id, reason, cutoff_time, response_snapshot,
                manifest_hash, recording_manifest, submission_hash, created_at)
            VALUES (:id, :attemptId, :reason, :cutoffTime, :responseSnapshot::jsonb,
                :manifestHash, :recordingManifest::jsonb, :subHash, clock_timestamp())
            RETURNING id
        """;
        return jdbcTemplate.queryForObject(sql, new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("attemptId", submission.attemptId())
                .addValue("reason", submission.reason().name())
                .addValue("cutoffTime", Timestamp.from(submission.cutoffTime()))
                .addValue("responseSnapshot", toJson(submission.responseSnapshot()))
                .addValue("manifestHash", submission.manifestHash())
                .addValue("recordingManifest", toJson(submission.recordingManifest()))
                .addValue("subHash", submission.submissionHash()), UUID.class);
    }

    public void insertCommandReceipt(CommandReceiptRecord receipt) {
        String sql = """
            INSERT INTO exams.command_receipts (id, user_id, attempt_id, command_id, operation,
                request_hash, result_reference, status, created_at)
            VALUES (gen_random_uuid(), :userId, :attemptId, :cmdId, :op, :reqHash, :resultRef, :status, clock_timestamp())
            ON CONFLICT (user_id, operation, command_id) DO NOTHING
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("userId", receipt.userId())
                .addValue("attemptId", receipt.attemptId())
                .addValue("cmdId", receipt.commandId())
                .addValue("op", receipt.operation())
                .addValue("reqHash", receipt.requestHash())
                .addValue("resultRef", receipt.resultReference())
                .addValue("status", receipt.status()));
    }

    public void recordExposure(Long userId, String logicalKey, int version, UUID attemptId, ExposureType type) {
        String sql = """
            INSERT INTO exams.exposures (id, user_id, logical_content_key, version, attempt_id, exposure_type, first_seen_at)
            VALUES (gen_random_uuid(), :userId, :key, :version, :attemptId, :type, clock_timestamp())
            ON CONFLICT (user_id, logical_content_key, version, exposure_type) DO NOTHING
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("userId", userId)
                .addValue("key", logicalKey)
                .addValue("version", version)
                .addValue("attemptId", attemptId)
                .addValue("type", type.name()));
    }

    public Optional<AttemptSectionRecord> findAttemptSection(UUID attemptId, UUID sectionId) {
        String sql = """
            SELECT asec.*
            FROM exams.attempt_sections asec
            WHERE asec.attempt_id = :attemptId AND asec.section_id = :sectionId
        """;
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql,
                    new MapSqlParameterSource()
                            .addValue("attemptId", attemptId)
                            .addValue("sectionId", sectionId),
                    attemptSectionRowMapper));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public List<ResponseRecord> findSpeakingResponsesByAttemptAndSection(UUID attemptId, UUID sectionId) {
        String sql = """
            SELECT * FROM exams.responses
            WHERE attempt_id = :attemptId AND section_id = :sectionId AND response_kind = 'SPEAKING_TURN'
            ORDER BY turn_sequence ASC
        """;
        return jdbcTemplate.query(sql,
                new MapSqlParameterSource()
                        .addValue("attemptId", attemptId)
                        .addValue("sectionId", sectionId),
                responseRowMapper);
    }

    public void insertSpeakingTurnResponse(UUID attemptId, UUID sectionId, String placementId, UUID itemId,
                                           String turnKey, int turnSequence, String turnState,
                                           Map<String, Object> sourceSnapshot) {
        String sql = """
            INSERT INTO exams.responses (id, attempt_id, section_id, placement_id, item_id,
                turn_key, turn_sequence, response_kind, turn_state, source_snapshot,
                flagged, revision, updated_at)
            VALUES (gen_random_uuid(), :attemptId, :sectionId, :placementId, :itemId,
                :turnKey, :turnSequence, 'SPEAKING_TURN', :turnState, :sourceSnapshot::jsonb,
                false, 1, clock_timestamp())
            ON CONFLICT (attempt_id, placement_id, turn_key) WHERE turn_key IS NOT NULL DO UPDATE SET
                turn_sequence = EXCLUDED.turn_sequence,
                turn_state = EXCLUDED.turn_state,
                source_snapshot = EXCLUDED.source_snapshot,
                updated_at = clock_timestamp()
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("attemptId", attemptId)
                .addValue("sectionId", sectionId)
                .addValue("placementId", placementId)
                .addValue("itemId", itemId)
                .addValue("turnKey", turnKey)
                .addValue("turnSequence", turnSequence)
                .addValue("turnState", turnState)
                .addValue("sourceSnapshot", toJson(sourceSnapshot)));
    }

    public boolean updateSpeakingTurnState(UUID attemptId, String turnKey, String newState,
                                          UUID recordingId, String commandId) {
        String sql = """
            UPDATE exams.responses
            SET turn_state = :newState,
                recording_id = COALESCE(:recordingId, recording_id),
                last_command_id = COALESCE(:commandId, last_command_id),
                revision = revision + 1,
                updated_at = clock_timestamp()
            WHERE attempt_id = :attemptId AND turn_key = :turnKey
        """;
        int updated = jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("attemptId", attemptId)
                .addValue("turnKey", turnKey)
                .addValue("newState", newState)
                .addValue("recordingId", recordingId)
                .addValue("commandId", commandId));
        return updated > 0;
    }

    public boolean updateSpeakingTurnTiming(UUID attemptId, String turnKey, Map<String, Object> answerPayload,
                                           String newState) {
        String sql = """
            UPDATE exams.responses
            SET turn_state = COALESCE(:newState, turn_state),
                answer_payload = :answerPayload::jsonb,
                revision = revision + 1,
                updated_at = clock_timestamp()
            WHERE attempt_id = :attemptId AND turn_key = :turnKey
        """;
        int updated = jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("attemptId", attemptId)
                .addValue("turnKey", turnKey)
                .addValue("newState", newState)
                .addValue("answerPayload", toJson(answerPayload)));
        return updated > 0;
    }

    public boolean updateAttemptSectionSpeakingCursor(UUID attemptId, UUID sectionId, int cursor,
                                                      long expectedRevision, String turnKey, String placementId) {
        String sql = """
            UPDATE exams.attempt_sections
            SET turn_cursor = :cursor,
                turn_revision = turn_revision + 1,
                current_turn_key = :turnKey,
                current_turn_placement_id = :placementId
            WHERE attempt_id = :attemptId AND section_id = :sectionId AND turn_revision = :expectedRevision
        """;
        int updated = jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("attemptId", attemptId)
                .addValue("sectionId", sectionId)
                .addValue("cursor", cursor)
                .addValue("expectedRevision", expectedRevision)
                .addValue("turnKey", turnKey)
                .addValue("placementId", placementId));
        return updated > 0;
    }

    public boolean updateAttemptSectionSpeakingCursorOnly(UUID attemptId, UUID sectionId, int cursor,
                                                          long expectedRevision) {
        String sql = """
            UPDATE exams.attempt_sections
            SET turn_cursor = :cursor,
                turn_revision = turn_revision + 1
            WHERE attempt_id = :attemptId AND section_id = :sectionId AND turn_revision = :expectedRevision
        """;
        int updated = jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("attemptId", attemptId)
                .addValue("sectionId", sectionId)
                .addValue("cursor", cursor)
                .addValue("expectedRevision", expectedRevision));
        return updated > 0;
    }

    public boolean updateSpeakingTurnTranscript(UUID attemptId, String turnKey, String transcriptText) {
        String sql = """
            UPDATE exams.responses
            SET text_response = :transcriptText,
                revision = revision + 1,
                updated_at = clock_timestamp()
            WHERE attempt_id = :attemptId AND turn_key = :turnKey
        """;
        int updated = jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("attemptId", attemptId)
                .addValue("turnKey", turnKey)
                .addValue("transcriptText", transcriptText));
        return updated > 0;
    }

    public boolean updateResponseTranscript(UUID responseId, String transcriptText) {
        String sql = """
            UPDATE exams.responses
            SET text_response = :transcriptText,
                revision = revision + 1,
                updated_at = clock_timestamp()
            WHERE id = :responseId
        """;
        int updated = jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("responseId", responseId)
                .addValue("transcriptText", transcriptText));
        return updated > 0;
    }
}
