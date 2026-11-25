-- Additive source only. V80 belongs to Garden; production execution prohibited by Phase3 directive.
CREATE TABLE IF NOT EXISTS public.quiz_rush_rooms (
    id UUID PRIMARY KEY,
    owner_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    create_request UUID NOT NULL,
    invitation VARCHAR(32) NOT NULL UNIQUE,
    status VARCHAR(16) NOT NULL CHECK (status IN ('WAITING','QUEUED','COUNTDOWN','RUNNING','FINISHING','FINISHED','CANCELED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=1048576),
    UNIQUE(owner_user_id,create_request)
);
CREATE TABLE IF NOT EXISTS public.quiz_rush_members (
    room_id UUID NOT NULL REFERENCES public.quiz_rush_rooms(id) ON DELETE RESTRICT,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY(room_id,user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_quiz_rush_active_member ON public.quiz_rush_members(user_id) WHERE active;
CREATE INDEX IF NOT EXISTS ix_quiz_rush_member_history ON public.quiz_rush_members(user_id,room_id);
CREATE INDEX IF NOT EXISTS ix_quiz_rush_room_status_time ON public.quiz_rush_rooms(status,updated_at);
