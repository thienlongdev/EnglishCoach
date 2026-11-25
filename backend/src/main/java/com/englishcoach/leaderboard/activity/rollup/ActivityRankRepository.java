package com.englishcoach.leaderboard.activity.rollup;

import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Date;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

/**
 * Read side of the Thi đua board. Reads ONLY {@code mv_activity_rank}, {@code leaderboard_activity_daily}
 * and (division lookup, the single allowed exception) the user_proficiency columns current_cefr,
 * peak_cefr, overall_status. Never reads score_events.
 */
@Repository
@RequiredArgsConstructor
public class ActivityRankRepository {

    private final NamedParameterJdbcTemplate jdbc;

    public record RankRow(long userId, int points, int rank) {}

    public record SourcePoints(String sourceModule, int points) {}

    public List<RankRow> top(String period, String scope, String group, int limit) {
        return jdbc.query("""
                SELECT user_id, points, rank FROM public.mv_activity_rank
                WHERE period = :period AND scope = :scope AND grp = :grp
                ORDER BY rank, user_id
                LIMIT :limit
                """, params(period, scope, group).addValue("limit", limit),
                (rs, i) -> new RankRow(rs.getLong("user_id"), rs.getInt("points"), rs.getInt("rank")));
    }

    public Optional<RankRow> find(String period, String scope, String group, long userId) {
        return jdbc.query("""
                SELECT user_id, points, rank FROM public.mv_activity_rank
                WHERE period = :period AND scope = :scope AND grp = :grp AND user_id = :userId
                """, params(period, scope, group).addValue("userId", userId),
                (rs, i) -> new RankRow(rs.getLong("user_id"), rs.getInt("points"), rs.getInt("rank")))
                .stream().findFirst();
    }

    /** Rank and points of the nearest row ranked above {@code rank} (empty when none). */
    public Optional<RankRow> rowAbove(String period, String scope, String group, int rank) {
        return jdbc.query("""
                SELECT user_id, points, rank FROM public.mv_activity_rank
                WHERE period = :period AND scope = :scope AND grp = :grp AND rank < :rank
                ORDER BY rank DESC, user_id
                LIMIT 1
                """, params(period, scope, group).addValue("rank", rank),
                (rs, i) -> new RankRow(rs.getLong("user_id"), rs.getInt("points"), rs.getInt("rank")))
                .stream().findFirst();
    }

    /**
     * Per-source points of one learner in [fromDay, toDay] (null skillGroup = every group). Daily points
     * are exact (NUMERIC); each module's period sum is rounded here for display only.
     */
    public List<SourcePoints> breakdown(long userId, LocalDate fromDay, LocalDate toDay, String skillGroup) {
        return jdbc.query("""
                SELECT source_module, ROUND(SUM(points))::integer AS points
                FROM public.leaderboard_activity_daily
                WHERE user_id = :userId AND day >= :fromDay AND day <= :toDay
                  AND (CAST(:grp AS varchar) IS NULL OR skill_group = CAST(:grp AS varchar))
                GROUP BY source_module
                HAVING ROUND(SUM(points)) > 0
                ORDER BY SUM(points) DESC, source_module
                """, new MapSqlParameterSource()
                .addValue("userId", userId)
                .addValue("fromDay", Date.valueOf(fromDay))
                .addValue("toDay", Date.valueOf(toDay))
                .addValue("grp", skillGroup, java.sql.Types.VARCHAR),
                (rs, i) -> new SourcePoints(rs.getString("source_module"), rs.getInt("points")));
    }

    /** Division level of one learner: CEFR after the peak floor, its source and division. */
    public record DivisionLevel(String cefr, String source, String division) {}

    /**
     * Division level from the single batch source {@code leaderboard_division_level} (precedence VERIFIED/STALE →
     * PROVISIONAL → latest VALID placement; floor max(level, peak − 1)); empty = no level (Bảng chung only).
     */
    public Optional<DivisionLevel> divisionLevelOf(long userId) {
        return jdbc.query("""
                SELECT cefr, source, division FROM public.leaderboard_division_level WHERE user_id = :userId
                """, new MapSqlParameterSource("userId", userId),
                (rs, i) -> new DivisionLevel(rs.getString("cefr"), rs.getString("source"), rs.getString("division")))
                .stream().filter(d -> d.division() != null).findFirst();
    }

    /** Latest anti-sandbagging promotion after {@code since} (to_cefr, created_at), if any. */
    public Optional<Promotion> latestPromotion(long userId, java.time.Instant since) {
        return jdbc.query("""
                SELECT to_cefr, created_at FROM public.leaderboard_division_promotion
                WHERE user_id = :userId AND created_at > :since ORDER BY created_at DESC LIMIT 1
                """, new MapSqlParameterSource().addValue("userId", userId).addValue("since", java.sql.Timestamp.from(since)),
                (rs, i) -> new Promotion(rs.getString("to_cefr"), rs.getTimestamp("created_at").toInstant())).stream().findFirst();
    }

    public record Promotion(String toCefr, java.time.Instant at) {}

    /** Number of ranked learners in one partition of mv_activity_rank. */
    public int participants(String period, String scope, String group) {
        Integer n = jdbc.queryForObject("""
                SELECT COUNT(*) FROM public.mv_activity_rank WHERE period = :period AND scope = :scope AND grp = :grp
                """, params(period, scope, group), Integer.class);
        return n == null ? 0 : n;
    }

    /**
     * One page of ACTIVE non-admin, non-excluded learners that are NOT ranked in the partition (ordered by id,
     * cursor = last id); with {@code requirePlacement} only learners with a VALID placement (eligible, no points yet).
     * Division scopes list only learners whose division level is that division. One batch
     * query; never reads score_events.
     */
    public List<Long> unranked(String period, String scope, String group, long afterUserId, int limit,
                               String excludedArray, boolean requirePlacement) {
        return jdbc.query("""
                SELECT u.id FROM public.users u
                WHERE u.role <> 'ROLE_ADMIN' AND u.account_status = 'ACTIVE'
                  AND NOT (u.id = ANY(CAST(:excluded AS bigint[])))
                  AND u.id > :after
                  AND (NOT CAST(:requirePlacement AS boolean) OR EXISTS (
                          SELECT 1 FROM public.proficiency_placement_attempt pa WHERE pa.user_id = u.id AND pa.status = 'VALID'))
                  AND NOT EXISTS (SELECT 1 FROM public.mv_activity_rank r
                                  WHERE r.period = :period AND r.scope = :scope AND r.grp = :grp AND r.user_id = u.id)
                  AND (:scope = 'GLOBAL' OR EXISTS (SELECT 1 FROM public.leaderboard_division_level dl
                                                    WHERE dl.user_id = u.id AND dl.division = :scope))
                ORDER BY u.id
                LIMIT :limit
                """, params(period, scope, group).addValue("after", afterUserId).addValue("limit", limit)
                .addValue("excluded", excludedArray).addValue("requirePlacement", requirePlacement),
                (rs, i) -> rs.getLong("id"));
    }

    /**
     * All-time Activity XP of one learner (Σ exact daily points of the rollup, rounded once — the same number as the
     * Tổng / ALL_TIME board, but also for admins / not-placed learners). Read by the avatar-frame LEARNING_XP metric.
     */
    public int allTimePoints(long userId) {
        Integer n = jdbc.queryForObject(
                "SELECT COALESCE(ROUND(SUM(points)), 0)::integer FROM public.leaderboard_activity_daily WHERE user_id = :userId",
                new MapSqlParameterSource("userId", userId), Integer.class);
        return n == null ? 0 : n;
    }

    /** True when the learner has a VALID placement attempt (Thi đua eligibility; any placement model). */
    public boolean hasValidPlacement(long userId) {
        Boolean ok = jdbc.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM public.proficiency_placement_attempt WHERE user_id = :userId AND status = 'VALID')",
                new MapSqlParameterSource("userId", userId), Boolean.class);
        return Boolean.TRUE.equals(ok);
    }

    private static MapSqlParameterSource params(String period, String scope, String group) {
        return new MapSqlParameterSource().addValue("period", period).addValue("scope", scope).addValue("grp", group);
    }
}
