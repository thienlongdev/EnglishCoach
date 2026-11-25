package com.englishcoach.proficiency;

import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * READ-ONLY lookups of persisted source-module data after AFTER_COMMIT (Hardening #1: no event
 * record or source service change needed). Never writes. Never touches score_events.
 */
@Repository
@RequiredArgsConstructor
public class ProficiencySourceReadRepository {

    private final NamedParameterJdbcTemplate jdbc;

    /** SYSTEM-ness and CEFR label of shared content (P2: only SYSTEM content is trusted). */
    public record ContentInfo(boolean system, String cefrLevel) {}

    public record RoleplayStats(long learnerTurns, Double meanFluency) {}

    /**
     * {@code lifecycleState} = the form's CURRENT lifecycle (display / legacy only); {@code snapshotState} and
     * {@code evidenceBasisJson} (the {@code evidenceBasis} object pinned in {@code attempts.manifest_snapshot}, Exams
     * Phase 4.1D) decide official evidence — never the current form.
     */
    public record ExamArtifact(UUID artifactId, Long userId, UUID formId, String family, String lifecycleState,
                               String resultStatus, int runOrdinal, Instant createdAt, String attemptMode,
                               String snapshotState, String evidenceBasisJson) {
        public ExamArtifact(UUID artifactId, Long userId, UUID formId, String family, String lifecycleState,
                            String resultStatus, int runOrdinal, Instant createdAt, String attemptMode) {
            this(artifactId, userId, formId, family, lifecycleState, resultStatus, runOrdinal, createdAt, attemptMode,
                    null, null);
        }
    }

    /** {@code aiFallback} = the persisted component metadata carries the ai-service fallback marker. */
    public record ExamComponent(String metric, String scaleName, double scaledScore, boolean aiFallback) {}

    public Optional<ContentInfo> listeningMaterial(long materialId) {
        return jdbc.query("""
                SELECT (is_system = TRUE AND owner_user_id IS NULL) AS sys, cefr_level
                FROM public.listening_materials WHERE id = :id
                """, new MapSqlParameterSource("id", materialId),
                (rs, i) -> new ContentInfo(rs.getBoolean("sys"), rs.getString("cefr_level"))).stream().findFirst();
    }

    public Optional<ContentInfo> speakingScenario(long scenarioId) {
        return jdbc.query("""
                SELECT (is_system = TRUE AND owner_user_id IS NULL) AS sys, cefr_level
                FROM public.speaking_scenarios WHERE id = :id
                """, new MapSqlParameterSource("id", scenarioId),
                (rs, i) -> new ContentInfo(rs.getBoolean("sys"), rs.getString("cefr_level"))).stream().findFirst();
    }

    /** Non-mocked LEARNER turns of a roleplay session and their mean AI fluency score (null if none). */
    public RoleplayStats roleplayStats(long sessionId) {
        return jdbc.queryForObject("""
                SELECT COUNT(*) AS turns, AVG(t.fluency_score) AS mean_fluency
                FROM public.speaking_turns t
                WHERE t.session_id = :sessionId AND t.speaker = 'LEARNER'
                  AND (t.is_mocked IS NULL OR t.is_mocked = FALSE)
                """, new MapSqlParameterSource("sessionId", sessionId), (rs, i) -> {
                    double avg = rs.getDouble("mean_fluency");
                    return new RoleplayStats(rs.getLong("turns"), rs.wasNull() ? null : avg);
                });
    }

    private static final String ARTIFACT_SELECT = """
            SELECT art.id AS artifact_id, a.user_id, a.form_id, a.family, f.lifecycle_state, art.result_status,
                   art.run_ordinal, art.created_at, a.attempt_mode, a.snapshot_state,
                   (a.manifest_snapshot -> 'evidenceBasis')::text AS evidence_basis
            FROM exams.score_artifacts art
            JOIN exams.submissions sub ON sub.id = art.submission_id
            JOIN exams.attempts a      ON a.id = sub.attempt_id
            JOIN exams.form_versions f ON f.id = a.form_id
            """;

    public Optional<ExamArtifact> examArtifact(UUID artifactId) {
        return jdbc.query(ARTIFACT_SELECT + " WHERE art.id = :id",
                new MapSqlParameterSource("id", artifactId), (rs, i) -> artifact(rs)).stream().findFirst();
    }

    /** COMPLETED artifacts created on/after {@code since} (null = all time), oldest first (first wins). */
    public List<ExamArtifact> completedArtifactsSince(Instant since) {
        String sql = ARTIFACT_SELECT + " WHERE art.result_status = 'COMPLETED'"
                + (since != null ? " AND art.created_at >= :since" : "")
                + " ORDER BY art.created_at, art.run_ordinal";
        MapSqlParameterSource p = new MapSqlParameterSource();
        if (since != null) p.addValue("since", Timestamp.from(since));
        return jdbc.query(sql, p, (rs, i) -> artifact(rs));
    }

    public List<ExamComponent> examComponents(UUID artifactId) {
        return jdbc.query("""
                SELECT metric, scale_name, scaled_score,
                       (uncertainty_range IS NOT NULL AND COALESCE(uncertainty_range ->> 'fallback', '') <> '') AS ai_fallback
                FROM exams.score_components WHERE artifact_id = :id
                """, new MapSqlParameterSource("id", artifactId),
                (rs, i) -> new ExamComponent(rs.getString("metric"), rs.getString("scale_name"), rs.getDouble("scaled_score"),
                        rs.getBoolean("ai_fallback")));
    }

    private static ExamArtifact artifact(java.sql.ResultSet rs) throws java.sql.SQLException {
        long uid = rs.getLong("user_id");
        Long userId = rs.wasNull() ? null : uid;
        return new ExamArtifact((UUID) rs.getObject("artifact_id"), userId, (UUID) rs.getObject("form_id"),
                rs.getString("family"), rs.getString("lifecycle_state"), rs.getString("result_status"),
                rs.getInt("run_ordinal"), rs.getTimestamp("created_at").toInstant(), rs.getString("attempt_mode"),
                rs.getString("snapshot_state"), rs.getString("evidence_basis"));
    }
}
