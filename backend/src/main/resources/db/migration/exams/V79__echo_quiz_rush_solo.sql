-- Source head V78 checked 2026-10-10. Additive Solo state; never applied manually.
-- Production startup is NOT authorized by the Phase 2 task.
CREATE TABLE IF NOT EXISTS public.quiz_rush_sessions (
    id UUID PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    start_request UUID NOT NULL,
    status VARCHAR(16) NOT NULL CHECK (status IN ('ACTIVE','FINISHED','ABANDONED')),
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
    UNIQUE(user_id,start_request),
    CHECK ((status='FINISHED') = (finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_quiz_rush_active_owner ON public.quiz_rush_sessions(user_id) WHERE status='ACTIVE';
CREATE INDEX IF NOT EXISTS ix_quiz_rush_owner_history ON public.quiz_rush_sessions(user_id,started_at DESC);
