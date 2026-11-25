-- Echo Odyssey enriches the ONE Learning Path. No duplicated mastery, score, XP or learning-history ledger.
-- Only geography, navigation, explicit launch receipts and cosmetic rewards are new.
CREATE TABLE public.odyssey_exploration (
    user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    region_id varchar(40) NOT NULL CHECK (region_id ~ '^[a-z][a-z-]{1,39}$'),
    discovered_at timestamptz NOT NULL DEFAULT now(),
    beacon_at timestamptz,
    PRIMARY KEY (user_id, region_id)
);
CREATE TABLE public.odyssey_navigation (
    user_id bigint PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
    region_id varchar(40) NOT NULL DEFAULT 'harbor',
    station_id varchar(120),
    view_mode varchar(8) NOT NULL DEFAULT 'ATLAS' CHECK (view_mode IN ('ATLAS','REGION','LIST')),
    target_date date,
    weekly_minutes integer CHECK (weekly_minutes BETWEEN 15 AND 2520),
    exam_variant varchar(16) CHECK (exam_variant IN ('ACADEMIC','GENERAL_TRAINING','LISTENING_READING')),
    revision bigint NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.odyssey_launch (
    user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    request_id uuid NOT NULL,
    station_id varchar(120) NOT NULL,
    region_id varchar(40) NOT NULL,
    mode varchar(12) NOT NULL CHECK (mode IN ('LEARN','CHECK','REVIEW','ADVANCE')),
    task_id bigint REFERENCES public.learning_path_task(id) ON DELETE RESTRICT,
    topic_slug varchar(80),
    check_id uuid REFERENCES public.grammar_check_session(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, request_id)
);
CREATE INDEX idx_odyssey_launch_owner_recent ON public.odyssey_launch(user_id, created_at DESC);
CREATE TABLE public.odyssey_reward (
    user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    source_kind varchar(16) NOT NULL CHECK (source_kind IN ('TASK','GRAMMAR_CHECK')),
    source_ref varchar(120) NOT NULL,
    region_id varchar(40) NOT NULL,
    granted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, source_kind, source_ref)
);
CREATE INDEX idx_odyssey_reward_journal ON public.odyssey_reward(user_id, granted_at DESC);
-- Runtime DML grants follow the established V94 default privileges. No runtime DDL, scheduler or seeder.
