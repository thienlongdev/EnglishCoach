-- Additive study planner; V110 layouts, defaults, notes and research remain unchanged.
CREATE TABLE public.study_time_blocks (
    id UUID PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    task_id UUID REFERENCES public.study_tasks(id) ON DELETE SET NULL,
    title VARCHAR(200) NOT NULL CHECK(length(btrim(title)) > 0),
    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ NOT NULL CHECK(end_at > start_at AND end_at <= start_at + interval '24 hours'),
    time_zone VARCHAR(80) NOT NULL,
    recurrence VARCHAR(8) NOT NULL CHECK(recurrence IN ('NONE','DAILY','WEEKLY')),
    until_on DATE,
    project VARCHAR(60),
    notes VARCHAR(4000),
    priority SMALLINT NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 3),
    revision BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_study_time_blocks_owner ON public.study_time_blocks(user_id,start_at);
CREATE TABLE public.study_block_sessions (
    session_id UUID PRIMARY KEY REFERENCES public.study_focus_sessions(id) ON DELETE RESTRICT,
    block_id UUID NOT NULL REFERENCES public.study_time_blocks(id) ON DELETE RESTRICT,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT
);
CREATE INDEX idx_study_block_sessions_owner ON public.study_block_sessions(user_id,block_id);

-- A durable cleanup receipt for managed voice rooms only. Private notes/layouts never enter shared room state.
CREATE TABLE public.study_shared_voice_rooms (
    id UUID PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    media_name VARCHAR(80) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL
);
