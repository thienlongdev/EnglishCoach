package com.englishcoach.garden.infra;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.List;

/**
 * Read-only adapters over the learning modules' OWN completion records (Phase 2, Layer D). Each returns verified
 * activities of one player after {@code since}, oldest first, bounded by {@code limit}; nothing here writes to another
 * module, adds a publishEvent or trusts a client. The stable {@code ref} makes Garden's ingest idempotent
 * ({@code garden_learning_event} unique (source, source_ref)).
 *
 * <ul>
 *   <li>DICTATION — a listening session that ENDED (all dictation exercises attempted, or explicitly completed) with at
 *   least {@code minCount} attempts ({@code listening_sessions.ended_at}; attempts carry no timestamp).</li>
 *   <li>SHADOWING — a speaking session with at least {@code minCount} completed, non-mocked, scored shadowing attempts;
 *   the time of the qualifying attempt.</li>
 *   <li>WRITING — the first READY assessment of a Writing Coach session (or of a standalone submission) whose text has at
 *   least {@code minCount} words.</li>
 *   <li>EXAM — a SUBMITTED exam attempt (simulation or practice; never evidence, only a garden reward).</li>
 *   <li>CARD_BLAST — a solo run scoring at least {@code minCount}.</li>
 *   <li>WORD_CHAIN — a finished match with at least {@code minCount} accepted words.</li>
 * </ul>
 * Modules whose timestamps are {@code LocalDateTime} (written with the backend JVM's clock) are read in the same JVM
 * zone, so the instant is the one the module recorded.
 */
@Repository
public class LearningSourceRepository {

    public record Activity(String ref, Instant occurredAt) {}

    private final JdbcTemplate jdbc;

    public LearningSourceRepository(JdbcTemplate jdbc) {
        this.jdbc = GardenJdbc.of(jdbc);
    }

    public List<Activity> find(String source, long userId, Instant since, int minCount, int limit) {
        return switch (source) {
            case "DICTATION" -> jdbc.query("""
                    SELECT s.id, s.ended_at FROM public.listening_sessions s
                    WHERE s.user_id = ? AND s.ended_at IS NOT NULL AND s.ended_at >= ?
                      AND (SELECT count(*) FROM public.exercise_attempts a WHERE a.listening_session_id = s.id) >= ?
                    ORDER BY s.ended_at, s.id LIMIT ?
                    """, (rs, n) -> new Activity("dictation:" + rs.getLong(1), local(rs, 2)), userId, local(since), minCount, limit);
            case "SHADOWING" -> jdbc.query("""
                    SELECT session_id, (array_agg(created_at ORDER BY created_at, id))[?] AS at FROM public.speaking_shadowing_attempts
                    WHERE user_id = ? AND created_at >= ? AND COALESCE(is_mocked, FALSE) = FALSE
                      AND COALESCE(analysis_status, 'COMPLETED') = 'COMPLETED' AND accuracy_score IS NOT NULL
                    GROUP BY session_id HAVING count(*) >= ?
                    ORDER BY 2, 1 LIMIT ?
                    """, (rs, n) -> new Activity("shadowing:" + rs.getLong(1), local(rs, 2)),
                    minCount, userId, local(since), minCount, limit);
            case "WRITING" -> jdbc.query("""
                    SELECT COALESCE(ws.session_id, 'sub:' || ws.id) AS k, min(wa.completed_at) AS at
                    FROM public.writing_assessments wa JOIN public.writing_submissions ws ON ws.id = wa.submission_id
                    WHERE ws.user_id = ? AND wa.status = 'READY' AND wa.completed_at >= ? AND ws.word_count >= ?
                    GROUP BY 1 ORDER BY 2, 1 LIMIT ?
                    """, (rs, n) -> new Activity("writing:" + rs.getString(1), rs.getTimestamp(2).toInstant()),
                    userId, Timestamp.from(since), minCount, limit);
            case "EXAM" -> jdbc.query("""
                    SELECT id, submitted_at FROM exams.attempts
                    WHERE user_id = ? AND status = 'SUBMITTED' AND submitted_at >= ?
                    ORDER BY submitted_at, id LIMIT ?
                    """, (rs, n) -> new Activity("exam:" + rs.getObject(1), rs.getTimestamp(2).toInstant()),
                    userId, Timestamp.from(since), limit);
            case "CARD_BLAST" -> jdbc.query("""
                    SELECT id, created_at FROM public.card_blast_runs
                    WHERE user_id = ? AND created_at >= ? AND score >= ? ORDER BY created_at, id LIMIT ?
                    """, (rs, n) -> new Activity("cardblast:" + rs.getLong(1), rs.getTimestamp(2).toInstant()),
                    userId, Timestamp.from(since), minCount, limit);
            case "WORD_CHAIN" -> jdbc.query("""
                    SELECT match_id, finished_at FROM public.word_chain_results
                    WHERE user_id = ? AND finished_at >= ? AND accepted_count >= ? ORDER BY finished_at, match_id LIMIT ?
                    """, (rs, n) -> new Activity("wordchain:" + rs.getObject(1), rs.getTimestamp(2).toInstant()),
                    userId, Timestamp.from(since), minCount, limit);
            default -> List.of(); // no verified completion record exists for this source (stays disabled)
        };
    }

    /** {@code LocalDateTime} columns are written with the backend JVM clock: read them in the same zone. */
    private static Instant local(ResultSet rs, int col) throws SQLException {
        LocalDateTime t = rs.getObject(col, LocalDateTime.class);
        return t == null ? null : t.atZone(ZoneId.systemDefault()).toInstant();
    }

    private static LocalDateTime local(Instant i) {
        return LocalDateTime.ofInstant(i, ZoneId.systemDefault());
    }
}
