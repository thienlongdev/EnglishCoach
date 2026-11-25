-- V57__leaderboard_rollup_precision.sql
-- Leaderboard Phase 3.1 — derived-data fixes only (score_events rows and its trigger untouched).
--   A1. leaderboard_activity_daily.points keeps the exact eligible_sum × streak_mult (NUMERIC, not
--       rounded); mv_activity_rank rounds once, on the period sum. Existing derived rows are
--       recomputed here from their stored eligible_sum × streak_mult (frozen multipliers kept) and
--       again by the next refresh (watermark NULL ⇒ every (user, day) since start-at is recomputed).
--   A2. Watermark leaderboard_refresh_state.last_processed_created_at (late-arriving score events)
--       + an index on score_events(created_at) to find them.
-- V54 is not edited; mv_proficiency_rank does not depend on these columns and is left as is.

-- 1. The view depends on the column type: drop it first (recreated below, same shape).
DROP MATERIALIZED VIEW IF EXISTS public.mv_activity_rank;

-- 2. Exact daily points.
ALTER TABLE public.leaderboard_activity_daily
    ALTER COLUMN points TYPE NUMERIC(12, 3) USING (eligible_sum * streak_mult);

-- 3. Late-event watermark (NULL = nothing processed yet).
ALTER TABLE public.leaderboard_refresh_state
    ADD COLUMN IF NOT EXISTS last_processed_created_at TIMESTAMPTZ NULL;

-- 4. New index only; score_events table, constraints and append-only trigger are unchanged.
CREATE INDEX IF NOT EXISTS idx_score_events_created_at ON public.score_events (created_at);

-- 5. Thi đua board — identical to V54 except points = round(Σ exact daily points) per period.
CREATE MATERIALIZED VIEW public.mv_activity_rank AS
WITH st AS (
    SELECT s.time_zone, s.activity_start_at, s.as_of
    FROM public.leaderboard_refresh_state s
    WHERE s.name = 'LEADERBOARD' AND s.activity_start_at IS NOT NULL AND s.as_of IS NOT NULL
), b AS (
    SELECT (date_trunc('week', st.as_of AT TIME ZONE st.time_zone))::date AS week_start,
           (date_trunc('month', st.as_of AT TIME ZONE st.time_zone))::date AS month_start,
           (st.activity_start_at AT TIME ZONE st.time_zone)::date AS start_day,
           (st.as_of AT TIME ZONE st.time_zone)::date AS today
    FROM st
), periods AS (
    SELECT 'WEEK'::VARCHAR(10) AS period, b.week_start AS period_start,
           GREATEST(b.week_start, b.start_day) AS from_day, b.today FROM b
    UNION ALL
    SELECT 'MONTH'::VARCHAR(10), b.month_start, GREATEST(b.month_start, b.start_day), b.today FROM b
    UNION ALL
    SELECT 'ALL_TIME'::VARCHAR(10), b.start_day, b.start_day, b.today FROM b
), eligible AS (
    SELECT u.id FROM public.users u
    WHERE u.role <> 'ROLE_ADMIN' AND u.account_status = 'ACTIVE'
), divisions AS (
    SELECT up.user_id,
           public.fn_leaderboard_division(GREATEST(public.fn_cefr_step(up.current_cefr),
                                                   public.fn_cefr_step(up.peak_cefr) - 1)) AS division
    FROM public.user_proficiency up
    WHERE up.overall_status <> 'UNDETERMINED' AND up.current_cefr IS NOT NULL
), agg AS (
    SELECT p.period, p.period_start, d.user_id, g.grp,
           ROUND(SUM(d.points))::INTEGER AS points, MAX(d.last_point_at) AS reached_at
    FROM periods p
    JOIN public.leaderboard_activity_daily d ON d.day >= p.from_day AND d.day <= p.today
    JOIN eligible e ON e.id = d.user_id
    CROSS JOIN LATERAL (VALUES ('ALL'::VARCHAR(10)), (d.skill_group::VARCHAR(10))) AS g(grp)
    WHERE d.points > 0
    GROUP BY p.period, p.period_start, d.user_id, g.grp
), scoped AS (
    SELECT a.period, a.period_start, 'GLOBAL'::VARCHAR(10) AS scope, a.grp, a.user_id, a.points, a.reached_at
    FROM agg a
    UNION ALL
    SELECT a.period, a.period_start, dv.division, a.grp, a.user_id, a.points, a.reached_at
    FROM agg a JOIN divisions dv ON dv.user_id = a.user_id
    WHERE dv.division IS NOT NULL
)
SELECT s.period, s.period_start, s.scope, s.grp, s.user_id, s.points, s.reached_at,
       (RANK() OVER (PARTITION BY s.period, s.scope, s.grp ORDER BY s.points DESC, s.reached_at ASC))::INTEGER AS rank
FROM scoped s
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_activity_rank
    ON public.mv_activity_rank (period, scope, grp, user_id);
CREATE INDEX IF NOT EXISTS ix_mv_activity_rank_top
    ON public.mv_activity_rank (period, scope, grp, rank);
