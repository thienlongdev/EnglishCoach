package com.englishcoach.leaderboard.activity;

import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.Collection;
import java.util.List;

/**
 * Append-only ledger access for {@code public.score_events}.
 * INSERT and SELECT only — there is intentionally no update or delete method
 * (the V52 trigger rejects UPDATE/DELETE as well).
 */
@Repository
@RequiredArgsConstructor
public class ScoreEventRepository {

    private final NamedParameterJdbcTemplate jdbc;

    private static final RowMapper<ScoreEventRow> ROW_MAPPER = (rs, i) -> new ScoreEventRow(
            rs.getLong("id"),
            rs.getLong("user_id"),
            ActivitySource.valueOf(rs.getString("source_module")),
            rs.getString("source_ref"),
            SkillGroup.valueOf(rs.getString("skill_group")),
            rs.getBigDecimal("base"),
            rs.getString("cefr_level") == null ? null : Cefr.valueOf(rs.getString("cefr_level")),
            rs.getBigDecimal("cefr_mult"),
            rs.getBigDecimal("quality_mult"),
            rs.getBigDecimal("relative_mult"),
            rs.getInt("raw_points"),
            rs.getInt("eligible_points"),
            rs.getBoolean("capped"),
            rs.getTimestamp("occurred_at").toInstant(),
            rs.getTimestamp("created_at").toInstant()
    );

    /**
     * Serializes all scoring for one user until the surrounding transaction ends, so concurrent
     * requests cannot exceed a daily cap. Transaction-scoped advisory lock (SELECT).
     */
    public void lockUserForScoring(long userId) {
        jdbc.queryForList(
                "SELECT pg_advisory_xact_lock(hashtext('leaderboard_activity'), CAST(MOD(:userId, 2147483647) AS integer))",
                new MapSqlParameterSource("userId", userId));
    }

    /** INSERT … ON CONFLICT DO NOTHING. Returns true when a new row was written. */
    public boolean insertIfAbsent(ScoreEventRow row) {
        String sql = """
                INSERT INTO public.score_events
                    (user_id, source_module, source_ref, skill_group, base, cefr_level, cefr_mult,
                     quality_mult, relative_mult, raw_points, eligible_points, capped, occurred_at)
                VALUES
                    (:userId, :sourceModule, :sourceRef, :skillGroup, :base, :cefrLevel, :cefrMult,
                     :qualityMult, :relativeMult, :rawPoints, :eligiblePoints, :capped, :occurredAt)
                ON CONFLICT (user_id, source_module, source_ref) DO NOTHING
                """;
        MapSqlParameterSource p = new MapSqlParameterSource()
                .addValue("userId", row.userId())
                .addValue("sourceModule", row.sourceModule().name())
                .addValue("sourceRef", row.sourceRef())
                .addValue("skillGroup", row.skillGroup().name())
                .addValue("base", row.base())
                .addValue("cefrLevel", row.cefrLevel() == null ? null : row.cefrLevel().name())
                .addValue("cefrMult", row.cefrMult())
                .addValue("qualityMult", row.qualityMult())
                .addValue("relativeMult", row.relativeMult())
                .addValue("rawPoints", row.rawPoints())
                .addValue("eligiblePoints", row.eligiblePoints())
                .addValue("capped", row.capped())
                .addValue("occurredAt", Timestamp.from(row.occurredAt()));
        return jdbc.update(sql, p) > 0;
    }

    public boolean exists(long userId, ActivitySource source, String sourceRef) {
        Integer n = jdbc.queryForObject("""
                SELECT COUNT(*) FROM public.score_events
                WHERE user_id = :userId AND source_module = :source AND source_ref = :ref
                """, new MapSqlParameterSource()
                .addValue("userId", userId)
                .addValue("source", source.name())
                .addValue("ref", sourceRef), Integer.class);
        return n != null && n > 0;
    }

    /** SUM of eligible points of the given modules in [from, to). */
    public long sumEligible(long userId, Collection<ActivitySource> sources, Instant from, Instant to) {
        Long sum = jdbc.queryForObject("""
                SELECT COALESCE(SUM(eligible_points), 0) FROM public.score_events
                WHERE user_id = :userId AND source_module IN (:sources)
                  AND occurred_at >= :from AND occurred_at < :to
                """, window(userId, from, to).addValue("sources", names(sources)), Long.class);
        return sum == null ? 0L : sum;
    }

    /** COUNT of uncapped rows of one module in [from, to), optionally filtered by source_ref LIKE. */
    public long countUncapped(long userId, ActivitySource source, String sourceRefLike, Instant from, Instant to) {
        String sql = """
                SELECT COUNT(*) FROM public.score_events
                WHERE user_id = :userId AND source_module = :source AND capped = FALSE
                  AND occurred_at >= :from AND occurred_at < :to
                """ + (sourceRefLike != null ? " AND source_ref LIKE :refLike" : "");
        MapSqlParameterSource p = window(userId, from, to).addValue("source", source.name());
        if (sourceRefLike != null) {
            p.addValue("refLike", sourceRefLike);
        }
        Long n = jdbc.queryForObject(sql, p, Long.class);
        return n == null ? 0L : n;
    }

    public List<ScoreEventRow> findByUser(long userId) {
        return jdbc.query("""
                SELECT * FROM public.score_events WHERE user_id = :userId ORDER BY id
                """, new MapSqlParameterSource("userId", userId), ROW_MAPPER);
    }

    private static MapSqlParameterSource window(long userId, Instant from, Instant to) {
        return new MapSqlParameterSource()
                .addValue("userId", userId)
                .addValue("from", Timestamp.from(from))
                .addValue("to", Timestamp.from(to));
    }

    private static List<String> names(Collection<ActivitySource> sources) {
        return sources.stream().map(Enum::name).toList();
    }
}
