-- V46__echo_coach_sessions.sql
-- Echo Coach Chatbot: Persistent Sessions & History (up to 15 recent sessions)

CREATE TABLE IF NOT EXISTS public.echo_coach_sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    title VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.echo_coach_messages (
    id BIGSERIAL PRIMARY KEY,
    session_id BIGINT NOT NULL REFERENCES public.echo_coach_sessions(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_echo_coach_sessions_user
    ON public.echo_coach_sessions(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_echo_coach_messages_session
    ON public.echo_coach_messages(session_id, created_at ASC);
