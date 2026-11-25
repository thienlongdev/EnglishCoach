package com.englishcoach.exams.repository;

import com.englishcoach.exams.model.ExamProfileRecords.*;
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
public class ExamProfileRepository {

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

    private static Instant toInstant(Timestamp ts) {
        return ts != null ? ts.toInstant() : null;
    }

    // ─── Row Mappers ──────────────────────────────────────────────────────────

    private final RowMapper<ProfileEvidenceRecord> evidenceRowMapper = (rs, rowNum) -> new ProfileEvidenceRecord(
            (UUID) rs.getObject("id"),
            rs.getLong("user_id"),
            (UUID) rs.getObject("attempt_id"),
            (UUID) rs.getObject("artifact_id"),
            (UUID) rs.getObject("component_id"),
            ExamFamily.valueOf(rs.getString("family")),
            rs.getString("metric"),
            rs.getString("scope"),
            rs.getString("cohort_key"),
            toInstant(rs.getTimestamp("measurement_date")),
            rs.getDouble("score_value"),
            rs.getString("exposure_status"),
            fromJsonMap(rs.getString("quality_meta")),
            rs.getString("status"),
            toInstant(rs.getTimestamp("created_at"))
    );

    private final RowMapper<RecommendationRecord> recommendationRowMapper = (rs, rowNum) -> new RecommendationRecord(
            (UUID) rs.getObject("id"),
            rs.getLong("user_id"),
            (UUID) rs.getObject("evidence_id"),
            rs.getString("diagnostic_code"),
            rs.getString("mapping_version"),
            TrainingModule.valueOf(rs.getString("training_module")),
            rs.getString("target_id"),
            rs.getString("reason"),
            rs.getString("status"),
            toInstant(rs.getTimestamp("created_at"))
    );

    // ─── Evidence Operations ──────────────────────────────────────────────────

    public UUID insertProfileEvidence(ProfileEvidenceRecord ev) {
        UUID id = ev.id() != null ? ev.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.profile_evidence (id, user_id, attempt_id, artifact_id, component_id,
                family, metric, scope, cohort_key, measurement_date, score_value, exposure_status,
                quality_meta, status, created_at)
            VALUES (:id, :userId, :attemptId, :artifactId, :componentId,
                :family, :metric, :scope, :cohortKey, :measDate, :scoreVal, :exposure,
                :quality::jsonb, :status, clock_timestamp())
            ON CONFLICT (artifact_id, component_id) DO NOTHING
            RETURNING id
        """;
        List<UUID> list = jdbcTemplate.query(sql, new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("userId", ev.userId())
                .addValue("attemptId", ev.attemptId())
                .addValue("artifactId", ev.artifactId())
                .addValue("componentId", ev.componentId())
                .addValue("family", ev.family().name())
                .addValue("metric", ev.metric())
                .addValue("scope", ev.scope())
                .addValue("cohortKey", ev.cohortKey())
                .addValue("measDate", Timestamp.from(ev.measurementDate()))
                .addValue("scoreVal", ev.scoreValue())
                .addValue("exposure", ev.exposureStatus())
                .addValue("quality", toJson(ev.qualityMeta()))
                .addValue("status", ev.status()), (rs, rowNum) -> (UUID) rs.getObject("id"));

        if (!list.isEmpty()) {
            UUID insertedId = list.get(0);
            insertEvidenceEvent(new EvidenceEventRecord(
                    UUID.randomUUID(),
                    insertedId,
                    "ACCEPTED",
                    "PRODUCTION_ARTIFACT_COMPLETED",
                    null,
                    "v4.0",
                    Instant.now()
            ));
            return insertedId;
        }
        return null;
    }

    /**
     * Revoke active profile evidence for an attempt (e.g. when an artifact requires review, is partial, or failed).
     */
    public int revokeEvidenceForAttempt(UUID attemptId, String reason, String policyVersion) {
        String selectSql = "SELECT id FROM exams.profile_evidence WHERE attempt_id = :attemptId AND status = 'ACTIVE'";
        List<UUID> activeIds = jdbcTemplate.query(selectSql, new MapSqlParameterSource("attemptId", attemptId),
                (rs, rowNum) -> (UUID) rs.getObject("id"));
        if (activeIds.isEmpty()) {
            return 0;
        }

        String updateSql = "UPDATE exams.profile_evidence SET status = 'REVOKED' WHERE attempt_id = :attemptId AND status = 'ACTIVE'";
        int updated = jdbcTemplate.update(updateSql, new MapSqlParameterSource("attemptId", attemptId));

        for (UUID evId : activeIds) {
            insertEvidenceEvent(new EvidenceEventRecord(
                    UUID.randomUUID(),
                    evId,
                    "REVOKED",
                    reason != null ? reason : "MANUAL_REVOCATION",
                    null,
                    policyVersion != null ? policyVersion : "v4.0",
                    Instant.now()
            ));
        }
        return updated;
    }

    /**
     * Supersede active profile evidence from prior artifact runs of this attempt.
     */
    public int supersedeEvidenceForAttempt(UUID attemptId, UUID newArtifactId, String reason, String policyVersion) {
        String selectSql = "SELECT id FROM exams.profile_evidence WHERE attempt_id = :attemptId AND artifact_id <> :newArtifactId AND status = 'ACTIVE'";
        List<UUID> activeIds = jdbcTemplate.query(selectSql, new MapSqlParameterSource()
                .addValue("attemptId", attemptId)
                .addValue("newArtifactId", newArtifactId),
                (rs, rowNum) -> (UUID) rs.getObject("id"));
        if (activeIds.isEmpty()) {
            return 0;
        }

        String updateSql = "UPDATE exams.profile_evidence SET status = 'SUPERSEDED' WHERE attempt_id = :attemptId AND artifact_id <> :newArtifactId AND status = 'ACTIVE'";
        int updated = jdbcTemplate.update(updateSql, new MapSqlParameterSource()
                .addValue("attemptId", attemptId)
                .addValue("newArtifactId", newArtifactId));

        for (UUID evId : activeIds) {
            insertEvidenceEvent(new EvidenceEventRecord(
                    UUID.randomUUID(),
                    evId,
                    "SUPERSEDED",
                    reason != null ? reason : "SUPERSEDED_BY_NEW_RUN",
                    null,
                    policyVersion != null ? policyVersion : "v4.0",
                    Instant.now()
            ));
        }
        return updated;
    }

    private static final String ACTIVE_ELIGIBLE_EVIDENCE = """
            FROM exams.profile_evidence pe
            JOIN exams.score_artifacts sa ON sa.id = pe.artifact_id
            JOIN exams.attempts a ON a.id = pe.attempt_id
            JOIN exams.form_versions f ON f.id = a.form_id
            JOIN exams.scoring_scheme_versions s ON s.id = f.scoring_scheme_id
            JOIN exams.calibration_versions c ON c.id = s.calibration_id
            WHERE pe.user_id = :userId AND pe.family = :family AND pe.status = 'ACTIVE'
              AND sa.result_status = 'COMPLETED' AND f.lifecycle_state = 'PUBLISHED'
              AND f.published_at IS NOT NULL AND s.approved_at IS NOT NULL AND c.approved_at IS NOT NULL
              AND c.maturity_stage IN ('EXPERT_ESTIMATED', 'PILOT_CALIBRATED', 'EMPIRICALLY_CALIBRATED', 'LINKED_CALIBRATED')
            """;

    public List<ProfileEvidenceRecord> latestByMetric(Long userId, ExamFamily family) {
        return jdbcTemplate.query("SELECT DISTINCT ON (pe.metric) pe.* " + ACTIVE_ELIGIBLE_EVIDENCE
                + " ORDER BY pe.metric, pe.measurement_date DESC, pe.created_at DESC, pe.id",
                new MapSqlParameterSource("userId", userId).addValue("family", family.name()), evidenceRowMapper);
    }

    public List<ProfileEvidenceRecord> findEvidenceByUserAndMetric(Long userId, ExamFamily family, String metric) {
        return jdbcTemplate.query("SELECT pe.* " + ACTIVE_ELIGIBLE_EVIDENCE + " AND pe.metric = :metric ORDER BY pe.measurement_date ASC",
                new MapSqlParameterSource("userId", userId).addValue("family", family.name()).addValue("metric", metric), evidenceRowMapper);
    }

    public Optional<ProfileEvidenceRecord> findBestEvidence(Long userId, ExamFamily family, String metric) {
        String sql = """
            SELECT pe.*
            FROM exams.profile_evidence pe
            JOIN exams.score_artifacts sa ON sa.id = pe.artifact_id
            JOIN exams.attempts a ON a.id = pe.attempt_id
            JOIN exams.form_versions f ON f.id = a.form_id
            JOIN exams.scoring_scheme_versions s ON s.id = f.scoring_scheme_id
            JOIN exams.calibration_versions c ON c.id = s.calibration_id
            WHERE pe.user_id = :userId AND pe.family = :family AND pe.metric = :metric
              AND pe.status = 'ACTIVE'
              AND sa.result_status = 'COMPLETED'
              AND f.lifecycle_state = 'PUBLISHED'
              AND f.published_at IS NOT NULL
              AND s.approved_at IS NOT NULL
              AND c.approved_at IS NOT NULL
              AND c.maturity_stage IN ('EXPERT_ESTIMATED', 'PILOT_CALIBRATED',
                                       'EMPIRICALLY_CALIBRATED', 'LINKED_CALIBRATED')
            ORDER BY pe.score_value DESC, pe.measurement_date DESC
            LIMIT 1
        """;
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql, new MapSqlParameterSource()
                    .addValue("userId", userId)
                    .addValue("family", family.name())
                    .addValue("metric", metric), evidenceRowMapper));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public Optional<ProfileEvidenceRecord> findLatestEvidence(Long userId, ExamFamily family, String metric) {
        String sql = """
            SELECT pe.*
            FROM exams.profile_evidence pe
            JOIN exams.score_artifacts sa ON sa.id = pe.artifact_id
            JOIN exams.attempts a ON a.id = pe.attempt_id
            JOIN exams.form_versions f ON f.id = a.form_id
            JOIN exams.scoring_scheme_versions s ON s.id = f.scoring_scheme_id
            JOIN exams.calibration_versions c ON c.id = s.calibration_id
            WHERE pe.user_id = :userId AND pe.family = :family AND pe.metric = :metric
              AND pe.status = 'ACTIVE'
              AND sa.result_status = 'COMPLETED'
              AND f.lifecycle_state = 'PUBLISHED'
              AND f.published_at IS NOT NULL
              AND s.approved_at IS NOT NULL
              AND c.approved_at IS NOT NULL
              AND c.maturity_stage IN ('EXPERT_ESTIMATED', 'PILOT_CALIBRATED',
                                       'EMPIRICALLY_CALIBRATED', 'LINKED_CALIBRATED')
            ORDER BY pe.measurement_date DESC
            LIMIT 1
        """;
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql, new MapSqlParameterSource()
                    .addValue("userId", userId)
                    .addValue("family", family.name())
                    .addValue("metric", metric), evidenceRowMapper));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public List<ProfileEvidenceRecord> findEvidenceByAttemptId(UUID attemptId) {
        String sql = """
            SELECT pe.*
            FROM exams.profile_evidence pe
            JOIN exams.score_artifacts sa ON sa.id = pe.artifact_id
            JOIN exams.attempts a ON a.id = pe.attempt_id
            JOIN exams.form_versions f ON f.id = a.form_id
            JOIN exams.scoring_scheme_versions s ON s.id = f.scoring_scheme_id
            JOIN exams.calibration_versions c ON c.id = s.calibration_id
            WHERE pe.attempt_id = :attemptId
              AND pe.status = 'ACTIVE'
              AND sa.result_status = 'COMPLETED'
              AND f.lifecycle_state = 'PUBLISHED'
              AND f.published_at IS NOT NULL
              AND s.approved_at IS NOT NULL
              AND c.approved_at IS NOT NULL
              AND c.maturity_stage IN ('EXPERT_ESTIMATED', 'PILOT_CALIBRATED',
                                       'EMPIRICALLY_CALIBRATED', 'LINKED_CALIBRATED')
        """;
        return jdbcTemplate.query(sql, new MapSqlParameterSource("attemptId", attemptId), evidenceRowMapper);
    }

    public void insertEvidenceEvent(EvidenceEventRecord ev) {
        String sql = """
            INSERT INTO exams.evidence_events (id, evidence_id, event_type, reason, successor_id, policy_version, created_at)
            VALUES (gen_random_uuid(), :evId, :type, :reason, :succId, :policyVer, clock_timestamp())
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("evId", ev.evidenceId())
                .addValue("type", ev.eventType())
                .addValue("reason", ev.reason())
                .addValue("succId", ev.successorId())
                .addValue("policyVer", ev.policyVersion()));
    }

    // ─── Recommendations Operations ───────────────────────────────────────────

    public UUID insertRecommendation(RecommendationRecord rec) {
        UUID id = rec.id() != null ? rec.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.recommendations (id, user_id, evidence_id, diagnostic_code, mapping_version,
                training_module, target_id, reason, status, created_at)
            VALUES (:id, :userId, :evidenceId, :code, :mappingVer, :module, :targetId, :reason, :status, clock_timestamp())
            ON CONFLICT (evidence_id, diagnostic_code, mapping_version) DO NOTHING
            RETURNING id
        """;
        List<UUID> list = jdbcTemplate.query(sql, new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("userId", rec.userId())
                .addValue("evidenceId", rec.evidenceId())
                .addValue("code", rec.diagnosticCode())
                .addValue("mappingVer", rec.mappingVersion())
                .addValue("module", rec.trainingModule().name())
                .addValue("targetId", rec.targetId())
                .addValue("reason", rec.reason())
                .addValue("status", rec.status()), (rs, rowNum) -> (UUID) rs.getObject("id"));
        return list.isEmpty() ? null : list.get(0);
    }

    public List<RecommendationRecord> findRecommendationsByUserId(Long userId, int limit) {
        String sql = """
            SELECT * FROM exams.recommendations
            WHERE user_id = :userId
            ORDER BY created_at DESC
            LIMIT :limit
        """;
        return jdbcTemplate.query(sql, new MapSqlParameterSource()
                .addValue("userId", userId)
                .addValue("limit", limit), recommendationRowMapper);
    }

    public void updateRecommendationStatus(UUID recId, String status) {
        String sql = "UPDATE exams.recommendations SET status = :status WHERE id = :id";
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("id", recId)
                .addValue("status", status));
    }
}
