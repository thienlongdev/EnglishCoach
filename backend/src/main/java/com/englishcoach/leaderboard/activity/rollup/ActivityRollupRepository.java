package com.englishcoach.leaderboard.activity.rollup;

import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.math.BigDecimal;
import java.sql.Date;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Instant;
import java.time.LocalDate;

/**
 * Writes the derived Activity rollup ({@code leaderboard_activity_daily}) and refreshes
 * {@code mv_activity_rank}. Reads only {@code score_events} and its own derived table; never
 * writes score_events (append-only ledger). One statement per call, whatever the number of users.
 */
@Repository
@RequiredArgsConstructor
public class ActivityRollupRepository {

    private final NamedParameterJdbcTemplate jdbc;

    /**
     * Upserts every (user, VN day, source_module) row for (a) days in [fromDay, today] and (b) every
     * older (user, day) that has a score_events row committed after the watermark ({@code created_at >
     * :lateSince}; null = every event since start-at). CARD_BLAST_SOLO = top-N runs per day then cap;
     * other modules = sum of eligible_points (caps were applied at insert). points = eligible_sum ×
     * streak_mult, exact (rounded once per period in mv_activity_rank). streakMult = 1 + step ×
     * min(streakDays, maxDays), where a day is active when the learner has a score_events row with
     * raw_points > 0 that day. A day before {@code today} that already has a stored multiplier keeps it
     * (frozen); only its sums are recomputed. A past day computed for the first time gets the streak as
     * of that day.
     */
    private static final String UPSERT_SQL = """
            WITH bounds AS (
                SELECT GREATEST(CAST(:startAt AS timestamptz),
                                (CAST(:fromDay AS date)::timestamp AT TIME ZONE :tz)) AS lo,
                       ((CAST(:today AS date) + 1)::timestamp AT TIME ZONE :tz) AS hi
            ), late AS (
                -- (user, day) pairs older than the window with events committed after the watermark
                SELECT DISTINCT se.user_id, (se.occurred_at AT TIME ZONE :tz)::date AS day
                FROM public.score_events se, bounds b
                WHERE (CAST(:lateSince AS timestamptz) IS NULL OR se.created_at > CAST(:lateSince AS timestamptz))
                  AND se.occurred_at >= CAST(:startAt AS timestamptz) AND se.occurred_at < b.lo
            ), src AS (
                SELECT se.id, se.user_id, se.source_module, se.skill_group, se.raw_points, se.eligible_points, se.occurred_at
                FROM public.score_events se, bounds b
                WHERE se.occurred_at >= b.lo AND se.occurred_at < b.hi
                UNION ALL
                SELECT se.id, se.user_id, se.source_module, se.skill_group, se.raw_points, se.eligible_points, se.occurred_at
                FROM late l
                JOIN public.score_events se ON se.user_id = l.user_id
                 AND se.occurred_at >= GREATEST(CAST(:startAt AS timestamptz), (l.day::timestamp AT TIME ZONE :tz))
                 AND se.occurred_at < ((l.day + 1)::timestamp AT TIME ZONE :tz)
            ), ev AS (
                SELECT src.user_id, (src.occurred_at AT TIME ZONE :tz)::date AS day, src.source_module,
                       src.skill_group, src.raw_points, src.eligible_points, src.occurred_at,
                       ROW_NUMBER() OVER (PARTITION BY src.user_id, (src.occurred_at AT TIME ZONE :tz)::date, src.source_module
                                          ORDER BY src.eligible_points DESC, src.occurred_at ASC, src.id ASC) AS rn
                FROM src
            ), agg AS (
                SELECT ev.user_id, ev.day, ev.source_module, MIN(ev.skill_group) AS skill_group,
                       SUM(ev.raw_points)::integer AS raw_sum,
                       (CASE WHEN ev.source_module = :cbsSource
                             THEN LEAST(COALESCE(SUM(ev.eligible_points) FILTER (WHERE ev.rn <= :cbsTop), 0), :cbsCap)
                             ELSE SUM(ev.eligible_points) END)::integer AS eligible_sum,
                       CASE WHEN ev.source_module = :cbsSource
                            THEN MAX(ev.occurred_at) FILTER (WHERE ev.rn <= :cbsTop AND ev.eligible_points > 0)
                            ELSE MAX(ev.occurred_at) FILTER (WHERE ev.eligible_points > 0) END AS last_point_at
                FROM ev
                GROUP BY ev.user_id, ev.day, ev.source_module
            ), user_days AS (
                SELECT DISTINCT a.user_id, a.day FROM agg a
            ), user_from AS (
                SELECT ud.user_id, MIN(ud.day) AS first_day FROM user_days ud GROUP BY ud.user_id
            ), active AS (
                SELECT DISTINCT se.user_id, (se.occurred_at AT TIME ZONE :tz)::date AS day
                FROM user_from uf
                CROSS JOIN bounds b
                JOIN public.score_events se ON se.user_id = uf.user_id
                 AND se.occurred_at >= GREATEST(CAST(:startAt AS timestamptz),
                        ((uf.first_day - CAST(:maxDays AS integer))::timestamp AT TIME ZONE :tz))
                 AND se.occurred_at < b.hi
                WHERE se.raw_points > 0
            ), islands AS (
                SELECT ac.user_id, ac.day,
                       ac.day - (ROW_NUMBER() OVER (PARTITION BY ac.user_id ORDER BY ac.day))::integer AS island
                FROM active ac
            ), streaks AS (
                SELECT i.user_id, i.day,
                       (ROW_NUMBER() OVER (PARTITION BY i.user_id, i.island ORDER BY i.day))::integer AS streak_days
                FROM islands i
            ), frozen AS (
                -- multipliers already stored for past days being recomputed (same value on every module row)
                SELECT d.user_id, d.day, MIN(d.streak_days) AS streak_days, MIN(d.streak_mult) AS streak_mult
                FROM public.leaderboard_activity_daily d
                JOIN user_days ud ON ud.user_id = d.user_id AND ud.day = d.day
                WHERE d.day < CAST(:today AS date)
                GROUP BY d.user_id, d.day
            ), mult AS (
                SELECT ud.user_id, ud.day,
                       COALESCE(fz.streak_days, LEAST(COALESCE(s.streak_days, 0), CAST(:maxDays AS integer)))::smallint AS streak_days,
                       COALESCE(fz.streak_mult,
                                1 + CAST(:step AS numeric) * LEAST(COALESCE(s.streak_days, 0), CAST(:maxDays AS integer)))::numeric(5, 3) AS streak_mult
                FROM user_days ud
                LEFT JOIN streaks s ON s.user_id = ud.user_id AND s.day = ud.day
                LEFT JOIN frozen fz ON fz.user_id = ud.user_id AND fz.day = ud.day
            )
            INSERT INTO public.leaderboard_activity_daily
                (user_id, day, source_module, skill_group, raw_sum, eligible_sum, streak_days, streak_mult,
                 points, last_point_at, updated_at)
            SELECT a.user_id, a.day, a.source_module, a.skill_group, a.raw_sum, a.eligible_sum,
                   m.streak_days, m.streak_mult, (a.eligible_sum * m.streak_mult)::numeric(12, 3),
                   a.last_point_at, CAST(:now AS timestamptz)
            FROM agg a
            JOIN mult m ON m.user_id = a.user_id AND m.day = a.day
            ON CONFLICT (user_id, day, source_module) DO UPDATE SET
                skill_group = EXCLUDED.skill_group, raw_sum = EXCLUDED.raw_sum,
                eligible_sum = EXCLUDED.eligible_sum, streak_days = EXCLUDED.streak_days,
                streak_mult = EXCLUDED.streak_mult, points = EXCLUDED.points,
                last_point_at = EXCLUDED.last_point_at, updated_at = EXCLUDED.updated_at
            """;

    /**
     * Parameters of one rollup run (all from configuration; nothing hard-coded in SQL).
     * {@code lateSince}: events with created_at after it re-open their (user, day); null = every event.
     */
    public record RollupParams(Instant startAt, String timeZone, LocalDate fromDay, LocalDate today,
                               String cardBlastSoloSource, int cardBlastTopRuns, int cardBlastDailyCap,
                               double streakStepPerDay, int streakMaxDays, Instant lateSince, Instant now) {}

    /** @return number of rows inserted or updated */
    public int upsertDays(RollupParams p) {
        return jdbc.update(UPSERT_SQL, new MapSqlParameterSource()
                .addValue("startAt", Timestamp.from(p.startAt()))
                .addValue("tz", p.timeZone())
                .addValue("fromDay", Date.valueOf(p.fromDay()))
                .addValue("today", Date.valueOf(p.today()))
                .addValue("cbsSource", p.cardBlastSoloSource())
                .addValue("cbsTop", p.cardBlastTopRuns())
                .addValue("cbsCap", p.cardBlastDailyCap())
                .addValue("step", BigDecimal.valueOf(p.streakStepPerDay()))
                .addValue("maxDays", p.streakMaxDays())
                .addValue("lateSince", ts(p.lateSince()), Types.TIMESTAMP)
                .addValue("now", Timestamp.from(p.now())));
    }

    /** Newest score_events.created_at after {@code after} (null = any); null when there is none. */
    public Instant maxCreatedAtAfter(Instant after) {
        Timestamp t = jdbc.queryForObject("""
                SELECT MAX(created_at) FROM public.score_events
                WHERE CAST(:after AS timestamptz) IS NULL OR created_at > CAST(:after AS timestamptz)
                """, new MapSqlParameterSource().addValue("after", ts(after), Types.TIMESTAMP), Timestamp.class);
        return t == null ? null : t.toInstant();
    }

    private static Timestamp ts(Instant i) {
        return i == null ? null : Timestamp.from(i);
    }

    /**
     * Anti-sandbagging (Stage 3.3): a learner whose division level comes from placement and who, over the window,
     * earned ≥ minShare of eligible Activity points on content ≥ minSteps CEFR steps above that level is raised one step
     * (append-only row in leaderboard_division_promotion; never lowers; at most one promotion per window). Reads
     * score_events.cefr_level / eligible_points and the division level only. One statement.
     */
    public int promoteDivisions(Instant now, Instant since, double minShare, int minSteps) {
        return jdbc.update("""
                INSERT INTO public.leaderboard_division_promotion (user_id, from_cefr, to_cefr, share, created_at)
                SELECT s.user_id, s.cefr, public.fn_cefr_of_step(public.fn_cefr_step(s.cefr) + 1),
                       ROUND(s.hard::numeric / s.total, 4), CAST(:now AS timestamptz)
                FROM (
                    SELECT dl.user_id, dl.cefr,
                           SUM(se.eligible_points) AS total,
                           COALESCE(SUM(se.eligible_points) FILTER (
                               WHERE public.fn_cefr_step(se.cefr_level) >= public.fn_cefr_step(dl.cefr) + CAST(:minSteps AS integer)), 0) AS hard
                    FROM public.leaderboard_division_level dl
                    JOIN public.score_events se ON se.user_id = dl.user_id
                     AND se.occurred_at >= CAST(:since AS timestamptz) AND se.occurred_at < CAST(:now AS timestamptz)
                    WHERE dl.source = 'PLACEMENT' AND public.fn_cefr_step(dl.cefr) < 6
                    GROUP BY dl.user_id, dl.cefr
                ) s
                WHERE s.total > 0 AND s.hard::numeric / s.total >= CAST(:minShare AS numeric)
                  AND NOT EXISTS (SELECT 1 FROM public.leaderboard_division_promotion p
                                  WHERE p.user_id = s.user_id AND p.created_at > CAST(:since AS timestamptz))
                """, new MapSqlParameterSource()
                .addValue("now", Timestamp.from(now)).addValue("since", Timestamp.from(since))
                .addValue("minShare", BigDecimal.valueOf(minShare)).addValue("minSteps", minSteps));
    }

    public void refreshRankView() {
        // an owner function (Flyway V94): the application role may not refresh the view itself
        jdbc.getJdbcTemplate().execute("SELECT public.refresh_mv_activity_rank()");
    }
}
