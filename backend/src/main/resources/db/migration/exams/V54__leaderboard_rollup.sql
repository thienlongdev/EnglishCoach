-- V54__leaderboard_rollup.sql
-- Leaderboard Phase 3 — derived rollup, ranking views and refresh state.
--   * leaderboard_activity_daily : Activity points per (user, Asia/Ho_Chi_Minh day, source_module),
--                                  upserted by the refresh job from score_events (derived data).
--   * leaderboard_refresh_state  : one row written by the refresh job (config copy + last success).
--   * mv_activity_rank           : Thi đua board (period × scope × group × user).
--   * mv_proficiency_rank        : Năng lực board (board × user), VERIFIED only.
-- score_events and proficiency_evidence are NOT touched (append-only, triggers unchanged).
-- Business constants (start-at, time zone, "as of" instant) are read from leaderboard_refresh_state,
-- which the job fills from configuration before every refresh — nothing is hard-coded here.

-- 1. CEFR helpers (mirror ProficiencyCefr bands, Proficiency Spec §1).
CREATE OR REPLACE FUNCTION public.fn_cefr_step(cefr VARCHAR)
RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE cefr WHEN 'A1' THEN 1 WHEN 'A2' THEN 2 WHEN 'B1' THEN 3
                     WHEN 'B2' THEN 4 WHEN 'C1' THEN 5 WHEN 'C2' THEN 6 END
$$;

CREATE OR REPLACE FUNCTION public.fn_proficiency_cefr(rating INTEGER)
RETURNS VARCHAR(2) LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN rating IS NULL THEN NULL
                WHEN rating <= 166 THEN 'A1' WHEN rating <= 333 THEN 'A2'
                WHEN rating <= 499 THEN 'B1' WHEN rating <= 666 THEN 'B2'
                WHEN rating <= 833 THEN 'C1' ELSE 'C2' END
$$;

-- Division by CEFR step: A1–A2 SO_CAP, B1–B2 TRUNG_CAP, C1–C2 CAO_CAP.
CREATE OR REPLACE FUNCTION public.fn_leaderboard_division(step INTEGER)
RETURNS VARCHAR(10) LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN step IS NULL THEN NULL WHEN step <= 2 THEN 'SO_CAP'
                WHEN step <= 4 THEN 'TRUNG_CAP' ELSE 'CAO_CAP' END
$$;

-- 2. Daily Activity rollup (derived; may be upserted).
CREATE TABLE IF NOT EXISTS public.leaderboard_activity_daily (
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    day DATE NOT NULL,
    source_module VARCHAR(40) NOT NULL,
    skill_group VARCHAR(20) NOT NULL,
    raw_sum INTEGER NOT NULL,
    eligible_sum INTEGER NOT NULL,
    streak_days SMALLINT NOT NULL,
    streak_mult NUMERIC(5, 3) NOT NULL,
    points INTEGER NOT NULL,
    last_point_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pk_leaderboard_activity_daily PRIMARY KEY (user_id, day, source_module),
    CONSTRAINT ck_leaderboard_activity_daily_group CHECK (skill_group IN (
        'VOCAB', 'LISTENING', 'SPEAKING', 'READING', 'WRITING', 'EXAMS')),
    CONSTRAINT ck_leaderboard_activity_daily_sums CHECK (raw_sum >= 0 AND eligible_sum >= 0 AND points >= 0),
    CONSTRAINT ck_leaderboard_activity_daily_streak CHECK (streak_days >= 0 AND streak_mult >= 1 AND streak_mult <= 2)
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_activity_daily_day
    ON public.leaderboard_activity_daily (day, user_id);

-- 3. Refresh state (one row, name = 'LEADERBOARD').
CREATE TABLE IF NOT EXISTS public.leaderboard_refresh_state (
    name VARCHAR(32) PRIMARY KEY,
    as_of TIMESTAMPTZ NULL,
    activity_start_at TIMESTAMPTZ NULL,
    time_zone VARCHAR(64) NOT NULL,
    last_attempt_at TIMESTAMPTZ NULL,
    last_success_at TIMESTAMPTZ NULL,
    last_duration_ms INTEGER NULL,
    last_error VARCHAR(500) NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.leaderboard_refresh_state (name, time_zone)
VALUES ('LEADERBOARD', 'Asia/Ho_Chi_Minh')
ON CONFLICT (name) DO NOTHING;

-- 4. Thi đua board. Periods are evaluated at refresh time from state.as_of; ALL_TIME starts at
--    the configured start-at day. Scope: GLOBAL for everyone + one division for learners whose
--    overall status is not UNDETERMINED (activityDivisionLevel = max(current, peak − 1 step)),
--    one batch JOIN to user_proficiency. Admins, non-ACTIVE accounts and 0-point rows excluded.
DROP MATERIALIZED VIEW IF EXISTS public.mv_activity_rank;
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
           SUM(d.points)::INTEGER AS points, MAX(d.last_point_at) AS reached_at
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

-- 5. Năng lực board. OVERALL: overall VERIFIED, division from current_cefr. Skill boards:
--    skill VERIFIED, division from that skill's own CEFR. VOCABULARY never ranked. STALE /
--    PROVISIONAL / UNDETERMINED not ranked. Hidden learners (show_on_proficiency_board = false)
--    are kept with visible = false and a would-be rank against the visible board only; they are
--    never listed. OVERALL tie-break reached_at = latest rating_reached_at of the learner's
--    determined skills (user_proficiency has no overall reached_at column).
DROP MATERIALIZED VIEW IF EXISTS public.mv_proficiency_rank;
CREATE MATERIALIZED VIEW public.mv_proficiency_rank AS
WITH eligible AS (
    SELECT u.id FROM public.users u
    WHERE u.role <> 'ROLE_ADMIN' AND u.account_status = 'ACTIVE'
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
