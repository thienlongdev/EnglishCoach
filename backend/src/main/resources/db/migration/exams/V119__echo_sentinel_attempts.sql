-- Echo Sentinel (owner directive 2026-11-14): server-owned strict-focus attempts for ranked play, an append-only audit trail,
-- and ranked Soán ngôi rows bound to a verified attempt from now on.
--
-- Historical rows are NOT touched: every king_conquest_results row that exists before this migration keeps its values and
-- stays eligible exactly as before (sentinel_attempt_id stays NULL = recorded under the pre-Sentinel rules). New rows can
-- only be inserted with a COMPLETED_VERIFIED attempt of the same learner (trigger below), so a new result never inherits
-- the historical status. Results become immutable (no UPDATE / DELETE), which also protects the owner-approved
-- 357-point record listed in sentinel_legacy_approvals.

CREATE TABLE public.sentinel_attempts (
    id UUID PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    activity VARCHAR(40) NOT NULL,
    policy VARCHAR(24) NOT NULL CHECK (policy IN ('STRICT_FOCUS')),
    policy_version SMALLINT NOT NULL CHECK (policy_version > 0),
    state VARCHAR(32) NOT NULL CHECK (state IN ('READY', 'ACTIVE', 'COMPLETED_VERIFIED', 'PENDING_REVIEW',
        'VOIDED_FOCUS_LOSS', 'VOIDED_ABANDONED', 'VOIDED_RELOAD', 'VOIDED_CONTINUITY', 'VOIDED_INTEGRITY_FAILURE', 'EXPIRED')),
    subject_ref VARCHAR(80),
    acknowledged_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    activated_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    end_detail VARCHAR(48),
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_sentinel_attempts_user ON public.sentinel_attempts(user_id, created_at DESC);
CREATE INDEX idx_sentinel_attempts_state ON public.sentinel_attempts(state, created_at DESC);

-- A terminal attempt never changes state again (no resume of a voided attempt, no re-scoring of a completed one),
-- READY never comes back, and attempts are never deleted.
CREATE FUNCTION public.sentinel_attempts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'sentinel_attempts rows are permanent';
    END IF;
    IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.activity <> OLD.activity THEN
        RAISE EXCEPTION 'sentinel attempt identity is immutable';
    END IF;
    IF OLD.state NOT IN ('READY', 'ACTIVE') AND NEW.state <> OLD.state THEN
        RAISE EXCEPTION 'sentinel attempt % is terminal (%)', OLD.id, OLD.state;
    END IF;
    IF OLD.state = 'ACTIVE' AND NEW.state = 'READY' THEN
        RAISE EXCEPTION 'sentinel attempt % cannot return to READY', OLD.id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_sentinel_attempts_guard BEFORE UPDATE OR DELETE ON public.sentinel_attempts
    FOR EACH ROW EXECUTE FUNCTION public.sentinel_attempts_guard();

CREATE TABLE public.sentinel_attempt_events (
    id BIGSERIAL PRIMARY KEY,
    attempt_id UUID NOT NULL REFERENCES public.sentinel_attempts(id) ON DELETE RESTRICT,
    at TIMESTAMPTZ NOT NULL,
    kind VARCHAR(40) NOT NULL,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_sentinel_attempt_events_attempt ON public.sentinel_attempt_events(attempt_id, id);
CREATE FUNCTION public.sentinel_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'sentinel_attempt_events is append-only';
END $$;
CREATE TRIGGER trg_sentinel_events_append_only BEFORE UPDATE OR DELETE ON public.sentinel_attempt_events
    FOR EACH ROW EXECUTE FUNCTION public.sentinel_events_append_only();

-- Ranked Soán ngôi rows: from now on one row per verified attempt.
ALTER TABLE public.king_conquest_results ADD COLUMN sentinel_attempt_id UUID UNIQUE
    REFERENCES public.sentinel_attempts(id) ON DELETE RESTRICT;

CREATE FUNCTION public.king_conquest_results_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    a RECORD;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'king_conquest_results rows are immutable (historical results are preserved as recorded)';
    END IF;
    IF NEW.sentinel_attempt_id IS NULL THEN
        RAISE EXCEPTION 'a new ranked Soán ngôi result needs a verified Echo Sentinel attempt';
    END IF;
    SELECT user_id, activity, state INTO a FROM public.sentinel_attempts WHERE id = NEW.sentinel_attempt_id;
    IF NOT FOUND OR a.user_id <> NEW.user_id OR a.activity <> 'KING_CONQUEST' OR a.state <> 'COMPLETED_VERIFIED' THEN
        RAISE EXCEPTION 'Echo Sentinel attempt % is not a verified KING_CONQUEST attempt of user %', NEW.sentinel_attempt_id, NEW.user_id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_king_conquest_results_guard BEFORE INSERT OR UPDATE OR DELETE ON public.king_conquest_results
    FOR EACH ROW EXECUTE FUNCTION public.king_conquest_results_guard();

-- Owner-approved historical achievements, one row per named result. Informational and auditable: rankings do not depend on
-- it (historical rows stay eligible as they are); the foreign key keeps the approved result from ever being removed.
CREATE TABLE public.sentinel_legacy_approvals (
    match_id UUID NOT NULL,
    user_id BIGINT NOT NULL,
    activity VARCHAR(40) NOT NULL,
    score INTEGER NOT NULL,
    approved_by VARCHAR(80) NOT NULL,
    reason TEXT NOT NULL,
    approved_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (match_id, user_id),
    FOREIGN KEY (match_id, user_id) REFERENCES public.king_conquest_results(match_id, user_id) ON DELETE RESTRICT
);
CREATE FUNCTION public.sentinel_legacy_approvals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'sentinel_legacy_approvals is append-only';
END $$;
CREATE TRIGGER trg_sentinel_legacy_approvals_guard BEFORE UPDATE OR DELETE ON public.sentinel_legacy_approvals
    FOR EACH ROW EXECUTE FUNCTION public.sentinel_legacy_approvals_guard();

-- The 357-point Soán ngôi 5×5 Tự luyện record (owner directive 2026-11-14), identified by its exact database key and values
-- (read-only production check 2026-11-14: match ea3742f1-…, user 674, 5×5 SOLO, 357, territory 25, throne). Written only
-- where that exact row exists, so other databases are unaffected; the result row itself is not modified.
INSERT INTO public.sentinel_legacy_approvals(match_id, user_id, activity, score, approved_by, reason, approved_at)
SELECT r.match_id, r.user_id, 'KING_CONQUEST', r.score, 'platform-owner',
       'Owner-approved historical Soán ngôi 5x5 Tự luyện result (357 = 302 word points + 50 territory + 5 throne); recorded before Echo Sentinel; preserved unchanged and eligible.',
       now()
FROM public.king_conquest_results r
WHERE r.match_id = 'ea3742f1-3896-4731-930c-3b4d8cb0c25f' AND r.user_id = 674 AND r.board_size = 5
  AND r.category = 'SOLO' AND r.score = 357;
-- V94 default privileges give the runtime role rows-only access to these new tables and functions; no runtime DDL.
