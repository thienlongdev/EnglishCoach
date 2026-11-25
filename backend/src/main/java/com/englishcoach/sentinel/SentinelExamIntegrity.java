package com.englishcoach.sentinel;

import org.springframework.jdbc.BadSqlGrammarException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import java.sql.SQLException;
import java.util.UUID;

/**
 * Echo Sentinel for exam simulations, read side (one statement each): a simulation created on or after the EXAM_SIMULATION
 * activation (V120) yields official evidence and Activity Points only when its strict attempt ended COMPLETED_VERIFIED.
 * Older attempts keep their historical rules. A missing activation row fails closed (verification required).
 */
@Component
public class SentinelExamIntegrity {
    private static final String RULE = """
        SELECT CASE WHEN a.created_at < (SELECT active_from FROM public.sentinel_activation WHERE activity='EXAM_SIMULATION') THEN TRUE
                    ELSE EXISTS (SELECT 1 FROM public.sentinel_attempts s WHERE s.activity='EXAM_SIMULATION'
                                 AND s.subject_ref=a.id::text AND s.user_id=a.user_id AND s.state='COMPLETED_VERIFIED') END
        """;
    private static final String BINDABLE_STRICT_SQL = """
        SELECT count(*) FROM exams.attempts a
        WHERE a.id=? AND a.user_id=? AND a.attempt_mode='EXAM_SIMULATION'
          AND NOT EXISTS (SELECT 1 FROM exams.responses r WHERE r.attempt_id=a.id)
          AND (
              a.status IN ('CREATED','READY')
              OR (a.status='IN_PROGRESS' AND a.started_at IS NULL AND a.created_at >= now() - interval '60 seconds')
          )
        """;
    private static final String BINDABLE_MINIMAL_TEST_SCHEMA_SQL = """
        SELECT count(*) FROM exams.attempts a
        WHERE a.id=? AND a.user_id=? AND a.attempt_mode='EXAM_SIMULATION'
          AND (
              a.status IN ('CREATED','READY')
              OR (a.status='IN_PROGRESS' AND a.created_at >= now() - interval '60 seconds')
          )
        """;
    private final JdbcTemplate jdbc;
    public SentinelExamIntegrity(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    /** For an exam attempt. Practice attempts are never asked (they create no official evidence). */
    public boolean allowsAttempt(UUID examAttemptId) {
        var r = jdbc.query(RULE + " FROM exams.attempts a WHERE a.id=?", (rs, i) -> rs.getBoolean(1), examAttemptId);
        return !r.isEmpty() && Boolean.TRUE.equals(r.getFirst());
    }
    /** For a score artifact (Proficiency mapper). */
    public boolean allowsArtifact(UUID artifactId) {
        var r = jdbc.query(RULE + """
             FROM exams.score_artifacts art JOIN exams.submissions sub ON sub.id=art.submission_id
             JOIN exams.attempts a ON a.id=sub.attempt_id WHERE art.id=?""", (rs, i) -> rs.getBoolean(1), artifactId);
        return !r.isEmpty() && Boolean.TRUE.equals(r.getFirst());
    }
    /**
     * May this learner bind a strict attempt to this exam attempt (own, simulation, not yet worked)?
     * EC-SEC-2026-019: Allows binding while CREATED/READY (normal pre-start flow) or IN_PROGRESS ONLY when
     * {@code started_at IS NULL}, zero responses are saved, and elapsed since creation is {@code <= 60s}.
     * Late-binding an already-started or already-worked {@code IN_PROGRESS} simulation is strictly refused.
     */
    public boolean bindable(long user, UUID examAttemptId) {
        try {
            Integer n = jdbc.queryForObject(BINDABLE_STRICT_SQL, Integer.class, examAttemptId, user);
            return n != null && n == 1;
        } catch (BadSqlGrammarException ex) {
            SQLException sqlEx = ex.getSQLException();
            String state = sqlEx != null ? sqlEx.getSQLState() : null;
            // Minimal test schemas that omit started_at / exams.responses (PostgreSQL 42703 / 42P01) still enforce the 60s bound.
            if ("42703".equals(state) || "42P01".equals(state)) {
                Integer n = jdbc.queryForObject(BINDABLE_MINIMAL_TEST_SCHEMA_SQL, Integer.class, examAttemptId, user);
                return n != null && n == 1;
            }
            throw ex;
        }
    }
}
