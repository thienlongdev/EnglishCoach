package com.englishcoach.exams.repository;

import com.englishcoach.exams.model.ExamScoringRecords.*;
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
public class ExamScoringRepository {

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
        if (json == null || json.isBlank()) return null;
        try {
            if (json.trim().startsWith("[")) {
                List<Object> list = objectMapper.readValue(json, new TypeReference<List<Object>>() {});
                Map<String, Object> map = new HashMap<>();
                map.put("variants", list);
                map.put("items", list);
                return map;
            }
            return objectMapper.readValue(json, new TypeReference<Map<String, Object>>() {});
        } catch (JsonProcessingException e) {
            log.error("Failed to parse JSON: {}", json, e);
            return null;
        }
    }

    private List<Map<String, Object>> fromJsonList(String json) {
        return fromJson(json, new TypeReference<List<Map<String, Object>>>() {});
    }

    private static Instant toInstant(Timestamp ts) {
        return ts != null ? ts.toInstant() : null;
    }

    // ─── Row Mappers ──────────────────────────────────────────────────────────

    private final RowMapper<JobRecord> jobRowMapper = (rs, rowNum) -> new JobRecord(
            (UUID) rs.getObject("id"),
            (UUID) rs.getObject("submission_id"),
            rs.getString("target"),
            rs.getString("pipeline_version"),
            rs.getInt("run_ordinal"),
            JobStatus.valueOf(rs.getString("status")),
            toInstant(rs.getTimestamp("next_run_at")),
            rs.getString("lease_token"),
            toInstant(rs.getTimestamp("lease_expires_at")),
            rs.getInt("attempt_count"),
            rs.getInt("max_attempts"),
            rs.getString("last_error"),
            toInstant(rs.getTimestamp("created_at")),
            toInstant(rs.getTimestamp("updated_at"))
    );

    private final RowMapper<JobStageRecord> stageRowMapper = (rs, rowNum) -> new JobStageRecord(
            (UUID) rs.getObject("id"),
            (UUID) rs.getObject("job_id"),
            rs.getString("stage_key"),
            rs.getInt("execution_ordinal"),
            rs.getString("input_hash"),
            rs.getString("output_hash"),
            fromJsonMap(rs.getString("result_payload")),
            (UUID) rs.getObject("private_asset_id"),
            fromJsonMap(rs.getString("provider_version_meta")),
            (Integer) rs.getObject("duration_ms"),
            JobStageStatus.valueOf(rs.getString("status")),
            toInstant(rs.getTimestamp("created_at"))
    );

    private final RowMapper<ScoreArtifactRecord> artifactRowMapper = (rs, rowNum) -> new ScoreArtifactRecord(
            (UUID) rs.getObject("id"),
            (UUID) rs.getObject("submission_id"),
            rs.getInt("run_ordinal"),
            (UUID) rs.getObject("predecessor_id"),
            fromJsonMap(rs.getString("version_bundle")),
            rs.getString("evidence_hash"),
            ResultStatus.valueOf(rs.getString("result_status")),
            fromJsonMap(rs.getString("reviewer_provenance")),
            toInstant(rs.getTimestamp("created_at"))
    );

    private final RowMapper<ScoreComponentRecord> componentRowMapper = (rs, rowNum) -> new ScoreComponentRecord(
            (UUID) rs.getObject("id"),
            (UUID) rs.getObject("artifact_id"),
            ExamFamily.valueOf(rs.getString("family")),
            ScoreMetric.valueOf(rs.getString("metric")),
            (UUID) rs.getObject("section_id"),
            (UUID) rs.getObject("response_id"),
            rs.getObject("raw_score") != null ? rs.getDouble("raw_score") : null,
            rs.getDouble("scaled_score"),
            rs.getString("scale_name"),
            fromJsonMap(rs.getString("uncertainty_range")),
            (UUID) rs.getObject("calibration_id"),
            toInstant(rs.getTimestamp("created_at"))
    );

    private final RowMapper<CriterionScoreRecord> criterionRowMapper = (rs, rowNum) -> new CriterionScoreRecord(
            (UUID) rs.getObject("id"),
            (UUID) rs.getObject("artifact_id"),
            rs.getString("target"),
            rs.getString("rubric_criterion"),
            rs.getDouble("score"),
            fromJsonList(rs.getString("evidence_references")),
            fromJsonMap(rs.getString("confidence_meta")),
            toInstant(rs.getTimestamp("created_at"))
    );

    private final RowMapper<ReviewCaseRecord> reviewCaseRowMapper = (rs, rowNum) -> new ReviewCaseRecord(
            (UUID) rs.getObject("id"),
            (UUID) rs.getObject("attempt_id"),
            (UUID) rs.getObject("job_id"),
            (UUID) rs.getObject("artifact_id"),
            rs.getString("reason"),
            rs.getString("status"),
            (Long) rs.getObject("assigned_operator_id"),
            fromJsonMap(rs.getString("decision_payload")),
            toInstant(rs.getTimestamp("created_at")),
            toInstant(rs.getTimestamp("resolved_at"))
    );

    // ─── Job Queue Operations ─────────────────────────────────────────────────

    public UUID insertJob(JobRecord job) {
        UUID id = job.id() != null ? job.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.jobs (id, submission_id, target, pipeline_version, run_ordinal,
                status, next_run_at, lease_token, lease_expires_at, attempt_count, max_attempts,
                last_error, created_at, updated_at)
            VALUES (:id, :subId, :target, :pipelineVer, :ordinal, :status, :nextRun,
                :leaseToken, :leaseExpires, :attempts, :maxAttempts, :lastError,
                clock_timestamp(), clock_timestamp())
            ON CONFLICT (submission_id, target, pipeline_version, run_ordinal) DO NOTHING
            RETURNING id
        """;
        List<UUID> list = jdbcTemplate.query(sql, new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("subId", job.submissionId())
                .addValue("target", job.target())
                .addValue("pipelineVer", job.pipelineVersion())
                .addValue("ordinal", job.runOrdinal())
                .addValue("status", job.status().name())
                .addValue("nextRun", Timestamp.from(job.nextRunAt()))
                .addValue("leaseToken", job.leaseToken())
                .addValue("leaseExpires", job.leaseExpiresAt() != null ? Timestamp.from(job.leaseExpiresAt()) : null)
                .addValue("attempts", job.attemptCount())
                .addValue("maxAttempts", job.maxAttempts())
                .addValue("lastError", job.lastError()), (rs, rowNum) -> (UUID) rs.getObject("id"));
        return list.isEmpty() ? null : list.get(0);
    }

    public Optional<JobRecord> claimNextReadyJob(String leaseToken, int leaseDurationSeconds, List<String> targets) {
        StringBuilder sql = new StringBuilder("""
            WITH next_job AS (
                SELECT id FROM exams.jobs
                WHERE status IN ('PENDING', 'RETRY_WAIT')
                  AND next_run_at <= clock_timestamp()
        """);

        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("leaseToken", leaseToken)
                .addValue("leaseSec", leaseDurationSeconds);

        if (targets != null && !targets.isEmpty()) {
            sql.append(" AND target IN (:targets)");
            params.addValue("targets", targets);
        }

        sql.append("""
                ORDER BY next_run_at ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            UPDATE exams.jobs j
            SET status = 'RUNNING',
                lease_token = :leaseToken,
                lease_expires_at = clock_timestamp() + (:leaseSec || ' seconds')::interval,
                attempt_count = attempt_count + 1,
                updated_at = clock_timestamp()
            FROM next_job
            WHERE j.id = next_job.id
            RETURNING j.*
        """);

        List<JobRecord> claimed = jdbcTemplate.query(sql.toString(), params, jobRowMapper);
        return claimed.isEmpty() ? Optional.empty() : Optional.of(claimed.get(0));
    }

    /** Reclaims jobs left RUNNING past lease_expires_at (e.g. worker crash/restart). */
    public int reapExpiredRunningLeases() {
        String sql = """
            UPDATE exams.jobs
            SET status = CASE WHEN attempt_count < max_attempts THEN 'RETRY_WAIT'::VARCHAR ELSE 'FAILED'::VARCHAR END,
                lease_token = NULL,
                lease_expires_at = NULL,
                next_run_at = CASE WHEN attempt_count < max_attempts THEN clock_timestamp() ELSE next_run_at END,
                last_error = COALESCE(last_error, 'Lease expired before completion'),
                updated_at = clock_timestamp()
            WHERE status = 'RUNNING'
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at < clock_timestamp()
        """;
        return jdbcTemplate.update(sql, new MapSqlParameterSource());
    }

    public boolean renewJobLease(UUID jobId, String leaseToken, int renewalSeconds) {
        String sql = """
            UPDATE exams.jobs
            SET lease_expires_at = clock_timestamp() + (:renewalSec || ' seconds')::interval,
                updated_at = clock_timestamp()
            WHERE id = :id AND lease_token = :leaseToken AND status = 'RUNNING'
        """;
        int updated = jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("id", jobId)
                .addValue("leaseToken", leaseToken)
                .addValue("renewalSec", renewalSeconds));
        return updated > 0;
    }

    public boolean completeJob(UUID jobId, String leaseToken) {
        String sql = """
            UPDATE exams.jobs
            SET status = 'COMPLETED',
                lease_token = NULL,
                lease_expires_at = NULL,
                updated_at = clock_timestamp()
            WHERE id = :id AND lease_token = :leaseToken
        """;
        int updated = jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("id", jobId)
                .addValue("leaseToken", leaseToken));
        return updated > 0;
    }

    public boolean failJob(UUID jobId, String leaseToken, String errorMessage, boolean retryable, int delaySeconds) {
        String sql = """
            UPDATE exams.jobs
            SET status = CASE
                    WHEN :retryable = TRUE AND attempt_count < max_attempts THEN 'RETRY_WAIT'::VARCHAR
                    ELSE 'FAILED'::VARCHAR
                END,
                next_run_at = clock_timestamp() + (:delaySec || ' seconds')::interval,
                last_error = :err,
                lease_token = NULL,
                lease_expires_at = NULL,
                updated_at = clock_timestamp()
            WHERE id = :id AND lease_token = :leaseToken
        """;
        int updated = jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("id", jobId)
                .addValue("leaseToken", leaseToken)
                .addValue("retryable", retryable)
                .addValue("delaySec", delaySeconds)
                .addValue("err", errorMessage));
        return updated > 0;
    }

    public boolean resetJobToPending(UUID jobId) {
        String sql = """
            UPDATE exams.jobs
            SET status = 'PENDING',
                next_run_at = clock_timestamp(),
                last_error = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                updated_at = clock_timestamp()
            WHERE id = :id
        """;
        int updated = jdbcTemplate.update(sql, new MapSqlParameterSource("id", jobId));
        return updated > 0;
    }

    public List<JobRecord> findJobsBySubmissionId(UUID submissionId) {
        String sql = "SELECT * FROM exams.jobs WHERE submission_id = :subId ORDER BY created_at ASC";
        return jdbcTemplate.query(sql, new MapSqlParameterSource("subId", submissionId), jobRowMapper);
    }

    // ─── Stage Operations ─────────────────────────────────────────────────────

    public void insertJobStage(JobStageRecord stage) {
        String sql = """
            INSERT INTO exams.job_stages (id, job_id, stage_key, execution_ordinal, input_hash,
                output_hash, result_payload, private_asset_id, provider_version_meta, duration_ms,
                status, created_at)
            VALUES (gen_random_uuid(), :jobId, :stageKey, :ordinal, :inputHash,
                :outputHash, :resultPayload::jsonb, :assetId, :versionMeta::jsonb, :duration,
                :status, clock_timestamp())
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("jobId", stage.jobId())
                .addValue("stageKey", stage.stageKey())
                .addValue("ordinal", stage.executionOrdinal())
                .addValue("inputHash", stage.inputHash())
                .addValue("outputHash", stage.outputHash())
                .addValue("resultPayload", toJson(stage.resultPayload()))
                .addValue("assetId", stage.privateAssetId())
                .addValue("versionMeta", toJson(stage.providerVersionMeta()))
                .addValue("duration", stage.durationMs())
                .addValue("status", stage.status().name()));
    }

    public List<JobStageRecord> findStagesByJobId(UUID jobId) {
        String sql = "SELECT * FROM exams.job_stages WHERE job_id = :jobId ORDER BY execution_ordinal ASC";
        return jdbcTemplate.query(sql, new MapSqlParameterSource("jobId", jobId), stageRowMapper);
    }

    public List<JobStageRecord> findStagesBySubmissionId(UUID submissionId) {
        String sql = """
            SELECT js.*
            FROM exams.job_stages js
            JOIN exams.jobs j ON js.job_id = j.id
            WHERE j.submission_id = :subId
            ORDER BY js.created_at ASC
        """;
        return jdbcTemplate.query(sql, new MapSqlParameterSource("subId", submissionId), stageRowMapper);
    }

    // ─── Score Artifact Operations ────────────────────────────────────────────

    public UUID insertScoreArtifact(ScoreArtifactRecord artifact) {
        UUID id = artifact.id() != null ? artifact.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.score_artifacts (id, submission_id, run_ordinal, predecessor_id,
                version_bundle, evidence_hash, result_status, reviewer_provenance, created_at)
            VALUES (:id, :subId, :ordinal, :predecessorId, :versionBundle::jsonb,
                :evidenceHash, :resultStatus, :reviewerProv::jsonb, clock_timestamp())
            RETURNING id
        """;
        return jdbcTemplate.queryForObject(sql, new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("subId", artifact.submissionId())
                .addValue("ordinal", artifact.runOrdinal())
                .addValue("predecessorId", artifact.predecessorId())
                .addValue("versionBundle", toJson(artifact.versionBundle()))
                .addValue("evidenceHash", artifact.evidenceHash())
                .addValue("resultStatus", artifact.resultStatus().name())
                .addValue("reviewerProv", toJson(artifact.reviewerProvenance())), UUID.class);
    }

    public Optional<ScoreArtifactRecord> findLatestArtifactBySubmissionId(UUID submissionId) {
        String sql = """
            SELECT * FROM exams.score_artifacts
            WHERE submission_id = :subId
            ORDER BY run_ordinal DESC
            LIMIT 1
        """;
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql,
                    new MapSqlParameterSource("subId", submissionId), artifactRowMapper));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public Optional<ScoreArtifactRecord> findArtifactById(UUID artifactId) {
        String sql = "SELECT * FROM exams.score_artifacts WHERE id = :id";
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql,
                    new MapSqlParameterSource("id", artifactId), artifactRowMapper));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public UUID insertScoreComponent(ScoreComponentRecord comp) {
        UUID id = comp.id() != null ? comp.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.score_components (id, artifact_id, family, metric, section_id,
                response_id, raw_score, scaled_score, scale_name, uncertainty_range, calibration_id, created_at)
            VALUES (:id, :artifactId, :family, :metric, :sectionId, :responseId,
                :rawScore, :scaledScore, :scaleName, :uncertainty::jsonb, :calibId, clock_timestamp())
            RETURNING id
        """;
        return jdbcTemplate.queryForObject(sql, new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("artifactId", comp.artifactId())
                .addValue("family", comp.family().name())
                .addValue("metric", comp.metric().name())
                .addValue("sectionId", comp.sectionId())
                .addValue("responseId", comp.responseId())
                .addValue("rawScore", comp.rawScore())
                .addValue("scaledScore", comp.scaledScore())
                .addValue("scaleName", comp.scaleName())
                .addValue("uncertainty", toJson(comp.uncertaintyRange()))
                .addValue("calibId", comp.calibrationId()), UUID.class);
    }

    public List<ScoreComponentRecord> findComponentsByArtifactId(UUID artifactId) {
        String sql = "SELECT * FROM exams.score_components WHERE artifact_id = :id ORDER BY metric ASC";
        return jdbcTemplate.query(sql, new MapSqlParameterSource("id", artifactId), componentRowMapper);
    }

    public void insertCriterionScore(CriterionScoreRecord crit) {
        String sql = """
            INSERT INTO exams.criterion_scores (id, artifact_id, target, rubric_criterion, score,
                evidence_references, confidence_meta, created_at)
            VALUES (gen_random_uuid(), :artifactId, :target, :criterion, :score,
                :evidenceRefs::jsonb, :confidence::jsonb, clock_timestamp())
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("artifactId", crit.artifactId())
                .addValue("target", crit.target())
                .addValue("criterion", crit.rubricCriterion())
                .addValue("score", crit.score())
                .addValue("evidenceRefs", toJson(crit.evidenceReferences()))
                .addValue("confidence", toJson(crit.confidenceMeta())));
    }

    public void insertCriterionScores(List<CriterionScoreRecord> list) {
        if (list == null || list.isEmpty()) return;
        for (CriterionScoreRecord c : list) {
            insertCriterionScore(c);
        }
    }

    public List<CriterionScoreRecord> findCriteriaByArtifactId(UUID artifactId) {
        String sql = "SELECT * FROM exams.criterion_scores WHERE artifact_id = :id ORDER BY target, rubric_criterion";
        return jdbcTemplate.query(sql, new MapSqlParameterSource("id", artifactId), criterionRowMapper);
    }

    // ─── Review Cases ─────────────────────────────────────────────────────────

    public UUID insertReviewCase(ReviewCaseRecord rc) {
        UUID id = rc.id() != null ? rc.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.review_cases (id, attempt_id, job_id, artifact_id, reason, status,
                assigned_operator_id, decision_payload, created_at)
            VALUES (:id, :attemptId, :jobId, :artifactId, :reason, :status,
                :operatorId, :decision::jsonb, clock_timestamp())
            RETURNING id
        """;
        return jdbcTemplate.queryForObject(sql, new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("attemptId", rc.attemptId())
                .addValue("jobId", rc.jobId())
                .addValue("artifactId", rc.artifactId())
                .addValue("reason", rc.reason())
                .addValue("status", rc.status())
                .addValue("operatorId", rc.assignedOperatorId())
                .addValue("decision", toJson(rc.decisionPayload())), UUID.class);
    }

    public List<ReviewCaseRecord> findOpenReviewCases(int limit, int offset) {
        String sql = """
            SELECT * FROM exams.review_cases
            WHERE status IN ('OPEN', 'ASSIGNED')
            ORDER BY created_at ASC
            LIMIT :limit OFFSET :offset
        """;
        return jdbcTemplate.query(sql, new MapSqlParameterSource()
                .addValue("limit", limit)
                .addValue("offset", offset), reviewCaseRowMapper);
    }

    public void updateReviewCaseDecision(UUID caseId, Long operatorId, String status, Map<String, Object> decision) {
        String sql = """
            UPDATE exams.review_cases
            SET status = :status,
                assigned_operator_id = :operatorId,
                decision_payload = :decision::jsonb,
                resolved_at = clock_timestamp()
            WHERE id = :id
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("id", caseId)
                .addValue("status", status)
                .addValue("operatorId", operatorId)
                .addValue("decision", toJson(decision)));
    }
}
