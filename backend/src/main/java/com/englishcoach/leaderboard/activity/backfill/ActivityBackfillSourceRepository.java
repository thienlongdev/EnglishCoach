package com.englishcoach.leaderboard.activity.backfill;

import com.englishcoach.exams.model.ExamTypes.ScoreMetric;
import com.englishcoach.common.event.DictationAttemptSubmittedEvent;
import com.englishcoach.common.event.ExamScoredEvent;
import com.englishcoach.common.event.RoleplayTurnRecordedEvent;
import com.englishcoach.leaderboard.activity.event.CardBlastRunFinishedEvent;
import com.englishcoach.leaderboard.activity.event.FlashcardReviewedEvent;
import com.englishcoach.leaderboard.activity.event.PvpMatchFinishedEvent;
import com.englishcoach.leaderboard.activity.event.ShadowingAttemptRecordedEvent;
import com.englishcoach.leaderboard.activity.event.WritingAssessmentCompletedEvent;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * READ-ONLY rebuild of historical Activity events from the source modules' tables (owner decision DC). Same
 * payloads as the live publish lines, so the scoring service produces the same source_ref and can never double
 * count. Approximations (documented in features/leaderboard): flashcards keep no review history ⇒ only the first
 * study of cards with review_count = 1 (FLASHCARD_NEW, dated by updated_at); dictation attempts have no timestamp ⇒
 * dated by their listening session start; timestamp-without-time-zone columns are read as UTC (container clock).
 */
@Repository
@RequiredArgsConstructor
public class ActivityBackfillSourceRepository {

    private final NamedParameterJdbcTemplate jdbc;

    private static Instant utc(ResultSet rs, String col) throws SQLException {
        LocalDateTime t = rs.getObject(col, LocalDateTime.class);
        return t == null ? null : t.toInstant(ZoneOffset.UTC);
    }

    private static Instant tz(ResultSet rs, String col) throws SQLException {
        Timestamp t = rs.getTimestamp(col);
        return t == null ? null : t.toInstant();
    }

    private static Long lng(ResultSet rs, String col) throws SQLException {
        long v = rs.getLong(col);
        return rs.wasNull() ? null : v;
    }

    private static Integer integer(ResultSet rs, String col) throws SQLException {
        int v = rs.getInt(col);
        return rs.wasNull() ? null : v;
    }

    private static Double dbl(ResultSet rs, String col) throws SQLException {
        double v = rs.getDouble(col);
        return rs.wasNull() ? null : v;
    }

    private MapSqlParameterSource from(Instant from) {
        return new MapSqlParameterSource("from", Timestamp.from(from));
    }

    public List<FlashcardReviewedEvent> flashcards(Instant from) {
        return jdbc.query("""
                SELECT f.id, f.user_id, f.status, f.dictionary_entry_id, f.deck_id, f.updated_at, d.cefr
                FROM public.flashcards f LEFT JOIN public.dictionary_entries d ON d.id = f.dictionary_entry_id
                WHERE f.user_id IS NOT NULL AND f.review_count = 1 AND f.updated_at >= CAST(:from AS timestamptz) AT TIME ZONE 'UTC'
                """, from(from), (rs, i) -> new FlashcardReviewedEvent(rs.getLong("user_id"), rs.getLong("id"), 1, "good",
                "NEW", rs.getString("status"), lng(rs, "dictionary_entry_id"), rs.getString("cefr"), lng(rs, "deck_id"),
                utc(rs, "updated_at")));
    }

    public List<CardBlastRunFinishedEvent> cardBlastRuns(Instant from) {
        return jdbc.query("""
                SELECT id, user_id, deck_id, score, accuracy, weak_words_count, created_at FROM public.card_blast_runs
                WHERE created_at >= :from
                """, from(from), (rs, i) -> new CardBlastRunFinishedEvent(rs.getLong("user_id"), rs.getLong("id"),
                lng(rs, "deck_id"), integer(rs, "score"), dbl(rs, "accuracy"), integer(rs, "weak_words_count"), tz(rs, "created_at")));
    }

    public List<PvpMatchFinishedEvent> pvpMatches(Instant from) {
        return jdbc.query("""
                SELECT id, mode, host_user_id, guest_user_id, winner_user_id, result, end_reason, duration_ms, is_ranked,
                       host_score, guest_score, deck_id, ended_at
                FROM public.pvp_matches WHERE ended_at IS NOT NULL AND ended_at >= :from
                """, from(from), (rs, i) -> {
                    Long winner = lng(rs, "winner_user_id");
                    String result = rs.getString("result");
                    // live winnerId: user id / bot id / "DRAW"; a bot win is persisted as WIN with no winner user
                    String winnerId = "DRAW".equals(result) ? "DRAW" : (winner != null ? String.valueOf(winner) : "BOT");
                    return new PvpMatchFinishedEvent(rs.getLong("id"), rs.getString("mode"), lng(rs, "host_user_id"),
                            lng(rs, "guest_user_id"), winnerId, rs.getString("end_reason"), lng(rs, "duration_ms"),
                            (Boolean) rs.getObject("is_ranked"), integer(rs, "host_score"), integer(rs, "guest_score"),
                            lng(rs, "deck_id"), tz(rs, "ended_at"));
                });
    }

    public List<DictationAttemptSubmittedEvent> dictationAttempts(Instant from) {
        return jdbc.query("""
                SELECT ea.id, ea.listening_exercise_id, ea.accuracy_percentage, ea.is_correct, ls.id AS session_id,
                       ls.user_id, ls.started_at, ls.listening_material_id, lm.cefr_level
                FROM public.exercise_attempts ea
                JOIN public.listening_sessions ls ON ls.id = ea.listening_session_id
                LEFT JOIN public.listening_materials lm ON lm.id = ls.listening_material_id
                WHERE ls.user_id IS NOT NULL AND ls.started_at >= CAST(:from AS timestamptz) AT TIME ZONE 'UTC'
                """, from(from), (rs, i) -> new DictationAttemptSubmittedEvent(rs.getLong("user_id"), rs.getLong("id"),
                lng(rs, "listening_exercise_id"), lng(rs, "listening_material_id"), rs.getLong("session_id"),
                rs.getString("cefr_level"), dbl(rs, "accuracy_percentage"), (Boolean) rs.getObject("is_correct"),
                utc(rs, "started_at")));
    }

    public List<ShadowingAttemptRecordedEvent> shadowingAttempts(Instant from) {
        return jdbc.query("""
                SELECT a.id, a.user_id, a.session_id, a.shadowing_unit_id, a.pronunciation_score, a.accuracy_score,
                       a.fluency_score, a.is_mocked, a.retry_index, a.created_at,
                       CASE WHEN s.source_type = 'LISTENING' THEN s.source_id END AS material_id
                FROM public.speaking_shadowing_attempts a
                LEFT JOIN public.speaking_sessions s ON s.id = a.session_id
                WHERE a.created_at >= CAST(:from AS timestamptz) AT TIME ZONE 'UTC'
                """, from(from), (rs, i) -> new ShadowingAttemptRecordedEvent(rs.getLong("user_id"), rs.getLong("id"),
                lng(rs, "session_id"), lng(rs, "shadowing_unit_id"), lng(rs, "material_id"), null,
                dbl(rs, "pronunciation_score"), dbl(rs, "accuracy_score"), dbl(rs, "fluency_score"),
                (Boolean) rs.getObject("is_mocked"), integer(rs, "retry_index"), utc(rs, "created_at")));
    }

    /** One event per roleplay session (its latest learner turn); the handler checks the ≥ 6 learner-turn rule. */
    public List<RoleplayTurnRecordedEvent> roleplaySessions(Instant from) {
        return jdbc.query("""
                SELECT DISTINCT ON (t.session_id) t.id, t.session_id, t.created_at, t.pronunciation_score, t.fluency_score,
                       t.is_mocked, s.user_id, s.scenario_id, sc.cefr_level
                FROM public.speaking_turns t
                JOIN public.speaking_sessions s ON s.id = t.session_id AND s.mode = 'ROLEPLAY'
                LEFT JOIN public.speaking_scenarios sc ON sc.id = s.scenario_id
                WHERE t.speaker = 'LEARNER' AND t.created_at >= CAST(:from AS timestamptz) AT TIME ZONE 'UTC'
                ORDER BY t.session_id, t.created_at DESC, t.id DESC
                """, from(from), (rs, i) -> new RoleplayTurnRecordedEvent(rs.getLong("user_id"), rs.getLong("session_id"),
                rs.getLong("id"), lng(rs, "scenario_id"), rs.getString("cefr_level"), roundInt(rs, "pronunciation_score"),
                roundInt(rs, "fluency_score"), (Boolean) rs.getObject("is_mocked"), utc(rs, "created_at")));
    }

    private static Integer roundInt(ResultSet rs, String col) throws SQLException {
        Double d = dbl(rs, col);
        return d == null ? null : (int) Math.round(d);
    }

    public List<WritingAssessmentCompletedEvent> writingAssessments(Instant from) {
        return jdbc.query("""
                SELECT wa.id, wa.overall_score, wa.completed_at, sub.id AS submission_id, sub.ordinal, ws.id AS session_id,
                       ws.user_id, ws.task_id
                FROM public.writing_assessments wa
                JOIN public.writing_submissions sub ON sub.id = wa.submission_id
                JOIN public.writing_sessions ws ON ws.id = sub.session_id
                WHERE wa.status = 'READY' AND wa.completed_at IS NOT NULL AND wa.completed_at >= :from
                """, from(from), (rs, i) -> new WritingAssessmentCompletedEvent(rs.getLong("user_id"),
                rs.getString("session_id"), rs.getString("submission_id"), String.valueOf(rs.getObject("id")),
                rs.getString("task_id"), integer(rs, "overall_score"), integer(rs, "ordinal"), tz(rs, "completed_at")));
    }

    public List<ExamScoredEvent> examResults(Instant from) {
        Map<UUID, ExamScoredEvent> out = new LinkedHashMap<>();
        Map<UUID, Map<ScoreMetric, Double>> scores = new LinkedHashMap<>();
        jdbc.query("""
                SELECT art.id AS artifact_id, art.run_ordinal, art.result_status, art.created_at, s.id AS submission_id,
                       a.id AS attempt_id, a.user_id, a.form_id, a.family, a.variant, a.scope, a.attempt_mode,
                       c.metric, c.scaled_score
                FROM exams.score_artifacts art
                JOIN exams.submissions s ON s.id = art.submission_id
                JOIN exams.attempts a ON a.id = s.attempt_id
                LEFT JOIN exams.score_components c ON c.artifact_id = art.id
                WHERE art.result_status = 'COMPLETED' AND art.created_at >= :from
                ORDER BY art.created_at, art.id
                """, from(from), rs -> {
                    UUID artifact = (UUID) rs.getObject("artifact_id");
                    Map<ScoreMetric, Double> m = scores.computeIfAbsent(artifact, k -> new EnumMap<>(ScoreMetric.class));
                    String metric = rs.getString("metric");
                    Double value = dbl(rs, "scaled_score");
                    if (metric != null && value != null) {
                        try {
                            m.put(ScoreMetric.fromString(metric), value);
                        } catch (IllegalArgumentException ignored) {
                            // non-score metrics are not part of the Activity event
                        }
                    }
                    if (!out.containsKey(artifact)) {
                        out.put(artifact, new ExamScoredEvent(rs.getLong("user_id"), (UUID) rs.getObject("attempt_id"),
                                (UUID) rs.getObject("submission_id"), artifact, integer(rs, "run_ordinal"),
                                (UUID) rs.getObject("form_id"), rs.getString("family"), rs.getString("variant"),
                                rs.getString("scope"), rs.getString("attempt_mode"), rs.getString("result_status"), m,
                                tz(rs, "created_at")));
                    }
                });
        return List.copyOf(out.values());
    }
}
