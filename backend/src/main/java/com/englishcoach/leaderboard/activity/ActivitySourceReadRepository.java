package com.englishcoach.leaderboard.activity;

import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

/**
 * READ-ONLY lookups the Activity listener performs after AFTER_COMMIT: persisted data of source
 * modules (never written) plus the Activity-owned {@code leaderboard_content_cefr} table.
 */
@Repository
@RequiredArgsConstructor
public class ActivitySourceReadRepository {

    private final NamedParameterJdbcTemplate jdbc;

    /** Activity-only CEFR label for content without a CEFR column in its owning module. */
    public Optional<Cefr> contentCefr(ActivitySource source, String refId) {
        if (refId == null) {
            return Optional.empty();
        }
        List<String> rows = jdbc.queryForList("""
                SELECT cefr_level FROM public.leaderboard_content_cefr
                WHERE source_module = :source AND ref_id = :ref
                """, new MapSqlParameterSource()
                .addValue("source", source.name())
                .addValue("ref", refId), String.class);
        return rows.isEmpty() ? Optional.empty() : Cefr.parse(rows.get(0));
    }

    /** 1-based attempt number of this user's dictation attempt on the exercise (all-time). */
    public long dictationAttemptNumber(long userId, long exerciseId, long attemptId) {
        Long n = jdbc.queryForObject("""
                SELECT COUNT(*)
                FROM public.exercise_attempts a
                JOIN public.listening_sessions s ON s.id = a.listening_session_id
                WHERE s.user_id = :userId
                  AND a.listening_exercise_id = :exerciseId
                  AND a.id <= :attemptId
                """, new MapSqlParameterSource()
                .addValue("userId", userId)
                .addValue("exerciseId", exerciseId)
                .addValue("attemptId", attemptId), Long.class);
        return n == null ? 1L : Math.max(1L, n);
    }

    public record RoleplayTurnStats(long learnerTurns, Double averageFluency) {}

    /** Non-mocked LEARNER turns of a roleplay session and their average fluency score. */
    public RoleplayTurnStats roleplayTurnStats(long sessionId) {
        return jdbc.queryForObject("""
                SELECT COUNT(*) AS turns, AVG(t.fluency_score) AS avg_fluency
                FROM public.speaking_turns t
                WHERE t.session_id = :sessionId
                  AND t.speaker = 'LEARNER'
                  AND (t.is_mocked IS NULL OR t.is_mocked = FALSE)
                """, new MapSqlParameterSource("sessionId", sessionId),
                (rs, i) -> {
                    double avg = rs.getDouble("avg_fluency");
                    return new RoleplayTurnStats(rs.getLong("turns"), rs.wasNull() ? null : avg);
                });
    }

    /** Current Card Blast PvP Elo rating (read-only), empty when the user has none. */
    public Optional<Integer> pvpRating(Long userId) {
        if (userId == null) {
            return Optional.empty();
        }
        List<Integer> rows = jdbc.queryForList(
                "SELECT rating FROM public.pvp_ratings WHERE user_id = :userId",
                new MapSqlParameterSource("userId", userId), Integer.class);
        return rows.isEmpty() ? Optional.empty() : Optional.ofNullable(rows.get(0));
    }
}
