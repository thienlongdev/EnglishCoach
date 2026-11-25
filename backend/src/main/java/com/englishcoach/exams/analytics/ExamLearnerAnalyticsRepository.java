package com.englishcoach.exams.analytics;

import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;

/**
 * Exams Phase 8 — READ-ONLY learner analytics queries. Every query is owner-scoped ({@code a.user_id = :userId}, the
 * authenticated principal; never a request parameter), bounded (time window + LIMIT) and batched (one query per
 * concern, never per attempt). No table is created and nothing is written: analytics are derived from the canonical
 * attempt rows, their pinned {@code manifest_snapshot}, responses and the scorer's persisted artifacts.
 *
 * <p>Practice items are read from the attempt's OWN snapshot (stimuli and prompts stripped server-side), so analytics
 * are historical-version safe: editing / re-importing a form never changes what an old attempt is counted as.
 */
@Repository
public class ExamLearnerAnalyticsRepository {

    private final NamedParameterJdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public ExamLearnerAnalyticsRepository(NamedParameterJdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    /** A submitted, scope-pinned practice attempt with its slim snapshot (sections → parts → groups → items, no prompts). */
    public record PracticeAttemptRow(UUID attemptId, ExamFamily family, Instant startedAt, Instant submittedAt,
                                     Map<String, Object> practiceScope, String formTitle, Map<String, Object> itemSnapshot) {}

    public record ResponseRow(UUID attemptId, UUID itemId, Map<String, Object> answerPayload, String textResponse) {}

    public record SimulationAttemptRow(UUID attemptId, UUID formId, ExamFamily family, String variant, String scope,
                                       String formTitle, Instant startedAt, Instant submittedAt, UUID artifactId,
                                       String resultStatus, Map<String, Object> practiceRawScores) {}

    public record ComponentRow(UUID artifactId, String metric, double scaledScore, String scaleName, Double rawScore) {}

    private static final String SLIM_SNAPSHOT = """
            jsonb_build_object('sections', COALESCE((
              SELECT jsonb_agg(jsonb_build_object('id', s -> 'id', 'skill', s -> 'skill', 'parts', COALESCE((
                SELECT jsonb_agg(jsonb_build_object('partCode', p -> 'partCode', 'groups', COALESCE((
                  SELECT jsonb_agg(jsonb_build_object('id', g -> 'id', 'items', COALESCE((
                    SELECT jsonb_agg(i - 'prompt') FROM jsonb_array_elements(
                      CASE WHEN jsonb_typeof(g -> 'items') = 'array' THEN g -> 'items' ELSE '[]'::jsonb END) i), '[]'::jsonb)))
                  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p -> 'groups') = 'array' THEN p -> 'groups' ELSE '[]'::jsonb END) g),
                  '[]'::jsonb)))
                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s -> 'parts') = 'array' THEN s -> 'parts' ELSE '[]'::jsonb END) p),
                '[]'::jsonb)))
              FROM jsonb_array_elements(a.manifest_snapshot -> 'sections') s), '[]'::jsonb))
            """;

    public List<PracticeAttemptRow> findSubmittedPracticeAttempts(Long userId, ExamFamily family, Instant since, int limit) {
        StringBuilder sql = new StringBuilder(
                "SELECT a.id, a.family, a.started_at, a.submitted_at,"
                + " (a.manifest_snapshot -> 'practiceScope')::text AS practice_scope,"
                + " a.manifest_snapshot -> 'form' ->> 'title' AS form_title,"
                + " (" + SLIM_SNAPSHOT + ")::text AS item_snapshot\n").append("""
                FROM exams.attempts a
                WHERE a.user_id = :userId
                  AND a.attempt_mode = 'PRACTICE'
                  AND a.status = 'SUBMITTED'
                  AND a.submitted_at IS NOT NULL
                  AND a.submitted_at >= :since
                  AND a.snapshot_state = 'SNAPSHOTTED'
                  AND jsonb_typeof(a.manifest_snapshot -> 'practiceScope') = 'object'
                  AND jsonb_typeof(a.manifest_snapshot -> 'sections') = 'array'
                """);
        MapSqlParameterSource p = new MapSqlParameterSource().addValue("userId", userId)
                .addValue("since", Timestamp.from(since)).addValue("limit", limit);
        if (family != null) {
            sql.append(" AND a.family = :family");
            p.addValue("family", family.name());
        }
        sql.append(" ORDER BY a.submitted_at DESC, a.id LIMIT :limit");
        return jdbc.query(sql.toString(), p, (rs, n) -> new PracticeAttemptRow((UUID) rs.getObject("id"),
                ExamFamily.valueOf(rs.getString("family")), instant(rs.getTimestamp("started_at")),
                instant(rs.getTimestamp("submitted_at")), map(rs.getString("practice_scope")), rs.getString("form_title"),
                map(rs.getString("item_snapshot"))));
    }

    /** Responses of the given attempts, restricted again to the owner (defence in depth: ids come from owner queries). */
    public List<ResponseRow> findResponses(Long userId, Collection<UUID> attemptIds) {
        if (attemptIds == null || attemptIds.isEmpty()) return List.of();
        String sql = """
                SELECT r.attempt_id, r.item_id, r.answer_payload::text AS answer_payload, r.text_response
                FROM exams.responses r
                JOIN exams.attempts a ON a.id = r.attempt_id
                WHERE a.user_id = :userId AND r.attempt_id IN (:ids)
                """;
        return jdbc.query(sql, new MapSqlParameterSource().addValue("userId", userId).addValue("ids", attemptIds),
                (rs, n) -> new ResponseRow((UUID) rs.getObject("attempt_id"), (UUID) rs.getObject("item_id"),
                        map(rs.getString("answer_payload")), rs.getString("text_response")));
    }

    public List<SimulationAttemptRow> findSubmittedSimulations(Long userId, ExamFamily family, Instant since, int limit) {
        StringBuilder sql = new StringBuilder("""
                SELECT a.id, a.form_id, a.family, a.variant, a.scope, a.started_at, a.submitted_at,
                       COALESCE(a.manifest_snapshot -> 'form' ->> 'title', f.title) AS form_title,
                       art.id AS artifact_id, art.result_status,
                       (art.version_bundle -> 'practiceRawScores')::text AS raw_scores
                FROM exams.attempts a
                JOIN exams.form_versions f ON f.id = a.form_id
                LEFT JOIN exams.submissions sub ON sub.attempt_id = a.id
                LEFT JOIN LATERAL (
                    SELECT sa.id, sa.result_status, sa.version_bundle
                    FROM exams.score_artifacts sa
                    WHERE sa.submission_id = sub.id
                    ORDER BY sa.run_ordinal DESC
                    LIMIT 1
                ) art ON TRUE
                WHERE a.user_id = :userId
                  AND a.attempt_mode = 'EXAM_SIMULATION'
                  AND a.status = 'SUBMITTED'
                  AND a.submitted_at IS NOT NULL
                  AND a.submitted_at >= :since
                """);
        MapSqlParameterSource p = new MapSqlParameterSource().addValue("userId", userId)
                .addValue("since", Timestamp.from(since)).addValue("limit", limit);
        if (family != null) {
            sql.append(" AND a.family = :family");
            p.addValue("family", family.name());
        }
        sql.append(" ORDER BY a.submitted_at DESC, a.id LIMIT :limit");
        return jdbc.query(sql.toString(), p, (rs, n) -> new SimulationAttemptRow((UUID) rs.getObject("id"),
                (UUID) rs.getObject("form_id"), ExamFamily.valueOf(rs.getString("family")), rs.getString("variant"),
                rs.getString("scope"), rs.getString("form_title"), instant(rs.getTimestamp("started_at")),
                instant(rs.getTimestamp("submitted_at")), (UUID) rs.getObject("artifact_id"), rs.getString("result_status"),
                map(rs.getString("raw_scores"))));
    }

    /** The scorer's persisted standardized components of the given artifacts (only what the scorer wrote). */
    public List<ComponentRow> findComponents(Collection<UUID> artifactIds) {
        if (artifactIds == null || artifactIds.isEmpty()) return List.of();
        String sql = """
                SELECT artifact_id, metric, scaled_score, scale_name, raw_score
                FROM exams.score_components
                WHERE artifact_id IN (:ids)
                ORDER BY artifact_id, metric
                """;
        return jdbc.query(sql, new MapSqlParameterSource("ids", artifactIds), (rs, n) -> new ComponentRow(
                (UUID) rs.getObject("artifact_id"), rs.getString("metric"), rs.getDouble("scaled_score"),
                rs.getString("scale_name"), rs.getObject("raw_score") == null ? null : rs.getDouble("raw_score")));
    }

    private Map<String, Object> map(String json) {
        if (json == null || json.isBlank() || "null".equals(json)) return null;
        try {
            return mapper.readValue(json, new TypeReference<Map<String, Object>>() {});
        } catch (Exception e) {
            return null;
        }
    }

    private static Instant instant(Timestamp ts) {
        return ts == null ? null : ts.toInstant();
    }
}
