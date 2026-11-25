-- V59__leaderboard_exclusions_division_level.sql
-- Leaderboard prod pipeline Stage 2 — derived objects only (score_events / proficiency_evidence untouched).
--   * leaderboard_refresh_state.excluded_user_ids : copy of app.leaderboard.excluded-user-ids, written by the
--     refresh job before every refresh; both ranking views filter it in one batch predicate.
--   * leaderboard_division_level (VIEW)           : the single division-level source of the boards
--     (precedence VERIFIED/STALE → PROVISIONAL current_cefr, floor max(level, peak − 1)); learners without a
--     level have NO row (Bảng chung only, never defaulted to A1). Stage 3 (V60) adds placement.
--   * mv_activity_rank / mv_proficiency_rank      : recreated (same shape) with the exclusion filter; the
--     Activity view takes its division from leaderboard_division_level.

ALTER TABLE public.leaderboard_refresh_state
    ADD COLUMN IF NOT EXISTS excluded_user_ids BIGINT[] NOT NULL DEFAULT '{}';

CREATE OR REPLACE FUNCTION public.fn_cefr_of_step(step INTEGER)
RETURNS VARCHAR(2) LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE step WHEN 1 THEN 'A1' WHEN 2 THEN 'A2' WHEN 3 THEN 'B1'
                     WHEN 4 THEN 'B2' WHEN 5 THEN 'C1' WHEN 6 THEN 'C2' END
$$;

DROP MATERIALIZED VIEW IF EXISTS public.mv_activity_rank;
DROP MATERIALIZED VIEW IF EXISTS public.mv_proficiency_rank;

CREATE OR REPLACE VIEW public.leaderboard_division_level AS
SELECT x.user_id, x.cefr, x.source, public.fn_leaderboard_division(public.fn_cefr_step(x.cefr)) AS division
FROM (
    SELECT up.user_id,
           public.fn_cefr_of_step(GREATEST(public.fn_cefr_step(up.current_cefr),
                                           COALESCE(public.fn_cefr_step(up.peak_cefr) - 1, 0)))::VARCHAR(2) AS cefr,
           up.overall_status::VARCHAR(20) AS source
    FROM public.user_proficiency up
    WHERE up.overall_status IN ('VERIFIED', 'STALE', 'PROVISIONAL') AND up.current_cefr IS NOT NULL
) x;

-- Thi đua board (as V57) + exclusion list; division from leaderboard_division_level.
CREATE MATERIALIZED VIEW public.mv_activity_rank AS
WITH st AS (
    SELECT s.time_zone, s.activity_start_at, s.as_of, s.excluded_user_ids
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
    SELECT u.id FROM public.users u, st
    WHERE u.role <> 'ROLE_ADMIN' AND u.account_status = 'ACTIVE' AND NOT (u.id = ANY(st.excluded_user_ids))
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
    SELECT a.period, a.period_start, dl.division, a.grp, a.user_id, a.points, a.reached_at
    FROM agg a JOIN public.leaderboard_division_level dl ON dl.user_id = a.user_id
    WHERE dl.division IS NOT NULL
)
SELECT s.period, s.period_start, s.scope, s.grp, s.user_id, s.points, s.reached_at,
       (RANK() OVER (PARTITION BY s.period, s.scope, s.grp ORDER BY s.points DESC, s.reached_at ASC))::INTEGER AS rank
FROM scoped s
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_activity_rank
    ON public.mv_activity_rank (period, scope, grp, user_id);
CREATE INDEX IF NOT EXISTS ix_mv_activity_rank_top
    ON public.mv_activity_rank (period, scope, grp, rank);

-- Năng lực board (as V54) + exclusion list (read from leaderboard_refresh_state; empty when absent).
CREATE MATERIALIZED VIEW public.mv_proficiency_rank AS
WITH ex AS (
    SELECT COALESCE((SELECT s.excluded_user_ids FROM public.leaderboard_refresh_state s WHERE s.name = 'LEADERBOARD'),
                    '{}'::BIGINT[]) AS ids
), eligible AS (
    SELECT u.id FROM public.users u, ex
    WHERE u.role <> 'ROLE_ADMIN' AND u.account_status = 'ACTIVE' AND NOT (u.id = ANY(ex.ids))
), sk AS (
    SELECT sp.user_id,
           MAX(public.fn_proficiency_cefr(sp.rating)) FILTER (WHERE sp.skill = 'LISTENING') AS l_cefr,
           MAX(sp.status) FILTER (WHERE sp.skill = 'LISTENING') AS l_status,
           MAX(public.fn_proficiency_cefr(sp.rating)) FILTER (WHERE sp.skill = 'READING') AS r_cefr,
           MAX(sp.status) FILTER (WHERE sp.skill = 'READING') AS r_status,
           MAX(public.fn_proficiency_cefr(sp.rating)) FILTER (WHERE sp.skill = 'WRITING') AS w_cefr,
           MAX(sp.status) FILTER (WHERE sp.skill = 'WRITING') AS w_status,
           MAX(public.fn_proficiency_cefr(sp.rating)) FILTER (WHERE sp.skill = 'SPEAKING') AS s_cefr,
           MAX(sp.status) FILTER (WHERE sp.skill = 'SPEAKING') AS s_status,
           MAX(sp.rating_reached_at) FILTER (WHERE sp.skill IN ('LISTENING', 'READING', 'WRITING', 'SPEAKING')
                                               AND sp.status NOT IN ('UNDETERMINED', 'UNSUPPORTED')
                                               AND sp.rating IS NOT NULL) AS overall_reached_at
    FROM public.skill_proficiency sp
    GROUP BY sp.user_id
), entries AS (
    SELECT 'OVERALL'::VARCHAR(10) AS board, up.user_id, up.overall_rating AS rating,
           up.current_cefr::VARCHAR(2) AS cefr, up.overall_confidence AS confidence,
           sk.overall_reached_at AS reached_at, up.show_on_proficiency_board AS visible
    FROM public.user_proficiency up
    LEFT JOIN sk ON sk.user_id = up.user_id
    WHERE up.overall_status = 'VERIFIED' AND up.overall_rating IS NOT NULL AND up.current_cefr IS NOT NULL
    UNION ALL
    SELECT sp.skill::VARCHAR(10), sp.user_id, sp.rating, public.fn_proficiency_cefr(sp.rating),
           sp.confidence, sp.rating_reached_at, COALESCE(up.show_on_proficiency_board, TRUE)
    FROM public.skill_proficiency sp
    LEFT JOIN public.user_proficiency up ON up.user_id = sp.user_id
    WHERE sp.status = 'VERIFIED' AND sp.rating IS NOT NULL
      AND sp.skill IN ('LISTENING', 'READING', 'WRITING', 'SPEAKING')
), divided AS (
    SELECT en.board, en.user_id, en.rating, en.cefr, en.confidence,
           COALESCE(en.reached_at, 'infinity'::TIMESTAMPTZ) AS reached_at, en.visible,
           public.fn_leaderboard_division(public.fn_cefr_step(en.cefr)) AS division
    FROM entries en
    JOIN eligible e ON e.id = en.user_id
), ranked AS (
    SELECT dv.*,
           (RANK() OVER (PARTITION BY dv.board, dv.division, dv.visible
                         ORDER BY dv.rating DESC, dv.confidence DESC, dv.reached_at ASC))::INTEGER AS rank_in_group
    FROM divided dv
)
SELECT r.board, r.division, r.user_id, r.rating, r.cefr, r.confidence, r.reached_at, r.visible,
       CASE WHEN r.visible THEN r.rank_in_group END AS rank,
       CASE WHEN NOT r.visible THEN (1 + (
           SELECT COUNT(*) FROM divided o
           WHERE o.visible AND o.board = r.board AND o.division = r.division
             AND (o.rating > r.rating
                  OR (o.rating = r.rating AND o.confidence > r.confidence)
                  OR (o.rating = r.rating AND o.confidence = r.confidence AND o.reached_at < r.reached_at))
       ))::INTEGER END AS would_be_rank,
       sk.l_cefr, sk.l_status, sk.r_cefr, sk.r_status, sk.w_cefr, sk.w_status, sk.s_cefr, sk.s_status
FROM ranked r
LEFT JOIN sk ON sk.user_id = r.user_id
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_proficiency_rank
    ON public.mv_proficiency_rank (board, user_id);
CREATE INDEX IF NOT EXISTS ix_mv_proficiency_rank_top
    ON public.mv_proficiency_rank (board, division, rank) WHERE visible;
