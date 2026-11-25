package com.englishcoach.leaderboard.board;

import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.Optional;

/** The single {@code leaderboard_refresh_state} row ('LEADERBOARD') + the refresh single-flight lock. */
@Repository
@RequiredArgsConstructor
public class LeaderboardRefreshStateRepository {

    static final String NAME = "LEADERBOARD";

    private final NamedParameterJdbcTemplate jdbc;

    /**
     * @param asOf          logical clock of the last refresh (period boundaries of the views)
     * @param lastSuccessAt clock of the last successful refresh = the {@code updatedAt} of every board API
     * @param lastProcessedCreatedAt watermark: newest score_events.created_at already rolled up (Phase 3.1)
     */
    public record State(Instant asOf, Instant activityStartAt, String timeZone, Instant lastAttemptAt,
                        Instant lastSuccessAt, Integer lastDurationMs, String lastError,
                        Instant lastProcessedCreatedAt, String excludedUserIds, boolean requirePlacement) {
        public State(Instant asOf, Instant activityStartAt, String timeZone, Instant lastAttemptAt,
                     Instant lastSuccessAt, Integer lastDurationMs, String lastError,
                     Instant lastProcessedCreatedAt) {
            this(asOf, activityStartAt, timeZone, lastAttemptAt, lastSuccessAt, lastDurationMs,
                    lastError, lastProcessedCreatedAt, "{}", true);
        }
    }

    /** Transaction-scoped advisory lock: false when another refresh (any instance) holds it. */
    public boolean tryLock() {
        Boolean ok = jdbc.getJdbcTemplate().queryForObject(
                "SELECT pg_try_advisory_xact_lock(hashtext('leaderboard_refresh'))", Boolean.class);
        return Boolean.TRUE.equals(ok);
    }

    public Optional<State> find() {
        return jdbc.query("SELECT * FROM public.leaderboard_refresh_state WHERE name = :name",
                new MapSqlParameterSource("name", NAME), (rs, i) -> {
                    int d = rs.getInt("last_duration_ms");
                    Integer duration = rs.wasNull() ? null : d;
                    return new State(instant(rs.getTimestamp("as_of")), instant(rs.getTimestamp("activity_start_at")),
                            rs.getString("time_zone"), instant(rs.getTimestamp("last_attempt_at")),
                            instant(rs.getTimestamp("last_success_at")), duration, rs.getString("last_error"),
                            instant(rs.getTimestamp("last_processed_created_at")),
                            rs.getString("excluded_user_ids"), rs.getBoolean("require_placement"));
                }).stream().findFirst();
    }

    /**
     * Checks whether any derived rollup, proficiency, or placement table feeding the materialized views
     * was modified after {@code since}. Allows idle scheduled ticks to skip expensive concurrent view refreshes.
     */
    public boolean hasViewInputChangesSince(Instant since) {
        if (since == null) {
            return true;
        }
        Boolean changed = jdbc.queryForObject("""
                SELECT (
                    EXISTS (SELECT 1 FROM public.leaderboard_activity_daily WHERE updated_at > :since)
                    OR EXISTS (SELECT 1 FROM public.user_proficiency WHERE updated_at > :since)
                    OR EXISTS (SELECT 1 FROM public.skill_proficiency WHERE updated_at > :since)
                    OR EXISTS (SELECT 1 FROM public.proficiency_placement_attempt WHERE created_at > :since)
                )
                """, new MapSqlParameterSource("since", ts(since)), Boolean.class);
        return Boolean.TRUE.equals(changed);
    }

    /**
     * Copies the configuration the views read (start-at, time zone, as-of clock, excluded user ids, placement
     * requirement) before refreshing them.
     */
    public void prepare(Instant asOf, Instant activityStartAt, String timeZone, Instant attemptAt,
                        String excludedUserIdsArray, boolean requirePlacement) {
        jdbc.update("""
                INSERT INTO public.leaderboard_refresh_state (name, as_of, activity_start_at, time_zone, last_attempt_at,
                    excluded_user_ids, require_placement, updated_at)
                VALUES (:name, :asOf, :startAt, :tz, :attempt, CAST(:excluded AS bigint[]), :requirePlacement, :attempt)
                ON CONFLICT (name) DO UPDATE SET as_of = EXCLUDED.as_of, activity_start_at = EXCLUDED.activity_start_at,
                    time_zone = EXCLUDED.time_zone, last_attempt_at = EXCLUDED.last_attempt_at,
                    excluded_user_ids = EXCLUDED.excluded_user_ids, require_placement = EXCLUDED.require_placement,
                    updated_at = EXCLUDED.updated_at
                """, new MapSqlParameterSource().addValue("name", NAME).addValue("asOf", ts(asOf))
                .addValue("startAt", ts(activityStartAt)).addValue("tz", timeZone).addValue("attempt", ts(attemptAt))
                .addValue("excluded", excludedUserIdsArray == null ? "{}" : excludedUserIdsArray)
                .addValue("requirePlacement", requirePlacement));
    }

    public void markSuccess(Instant successAt, int durationMs) {
        jdbc.update("""
                UPDATE public.leaderboard_refresh_state
                SET last_success_at = :at, last_duration_ms = :ms, last_error = NULL, updated_at = :at
                WHERE name = :name
                """, new MapSqlParameterSource().addValue("name", NAME).addValue("at", ts(successAt))
                .addValue("ms", durationMs));
    }

    /** Stores the late-event watermark (inside the refresh transaction; never moves backwards). */
    public void advanceWatermark(Instant processedCreatedAt) {
        if (processedCreatedAt == null) {
            return;
        }
        jdbc.update("""
                UPDATE public.leaderboard_refresh_state
                SET last_processed_created_at = GREATEST(COALESCE(last_processed_created_at, :at), :at)
                WHERE name = :name
                """, new MapSqlParameterSource().addValue("name", NAME).addValue("at", ts(processedCreatedAt)));
    }

    public void markFailure(Instant attemptAt, String error) {
        String msg = error == null ? "unknown" : (error.length() > 500 ? error.substring(0, 500) : error);
        jdbc.update("""
                UPDATE public.leaderboard_refresh_state
                SET last_attempt_at = :at, last_error = :err, updated_at = :at
                WHERE name = :name
                """, new MapSqlParameterSource().addValue("name", NAME).addValue("at", ts(attemptAt))
                .addValue("err", msg));
    }

    private static Timestamp ts(Instant i) {
        return i == null ? null : Timestamp.from(i);
    }

    private static Instant instant(Timestamp t) {
        return t == null ? null : t.toInstant();
    }
}
