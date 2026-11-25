-- Echo Learning Path ("Lộ trình học"). Additive schema only; no existing table is changed and no row is seeded.
-- One plan per learner, the learner's daily task instances (idempotent per day slot) and explicit Learner DNA
-- revision proposals. Completion is never written by a client: the server links a task to an existing,
-- server-persisted learning row (evidence_ref) and that link is unique per learner and task kind.
CREATE TABLE IF NOT EXISTS public.learning_path_plan (
    user_id BIGINT PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
    goal VARCHAR(16) NOT NULL CHECK (goal IN ('GENERAL','COMMUNICATION','IELTS','TOEIC')),
    daily_minutes SMALLINT NOT NULL CHECK (daily_minutes IN (15, 30, 45, 60)),
    -- CEFR for GENERAL / COMMUNICATION, band for IELTS, score for TOEIC (declared goal, never evidence)
    target VARCHAR(4) NULL CHECK (target IS NULL OR target ~ '^(A1|A2|B1|B2|C1|C2|[4-8](\.[05])?|[1-9][0-9]{2})$'),
    -- starting content level and where it came from (PROFICIENCY / PLACEMENT evidence, else PROVISIONAL)
    start_cefr VARCHAR(2) NOT NULL CHECK (start_cefr IN ('A1','A2','B1','B2','C1','C2')),
    start_basis VARCHAR(12) NOT NULL CHECK (start_basis IN ('PROFICIENCY','PLACEMENT','PROVISIONAL')),
    stage SMALLINT NOT NULL DEFAULT 1 CHECK (stage BETWEEN 1 AND 4),
    stage_reached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- per-skill priority adjustments in [-0.2, 0.2], written only by an applied Learner DNA revision
    focus JSONB NOT NULL DEFAULT '{}'::jsonb,
    focus_updated_at TIMESTAMPTZ NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.learning_path_task (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    plan_day DATE NOT NULL,
    position SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 40),
    plan_version INTEGER NOT NULL,
    kind VARCHAR(16) NOT NULL CHECK (kind IN
        ('PLACEMENT','VOCAB_REVIEW','DICTATION','READING','TOPIC_SPEAKING','WRITING','EXAM_PRACTICE')),
    skill VARCHAR(12) NOT NULL CHECK (skill IN ('VOCABULARY','LISTENING','READING','SPEAKING','WRITING','ASSESSMENT')),
    target_id BIGINT NULL,
    target_key VARCHAR(16) NULL CHECK (target_key IS NULL OR target_key ~ '^[A-Z0-9]{2,16}$'),
    title VARCHAR(200) NOT NULL,
    minutes SMALLINT NOT NULL CHECK (minutes BETWEEN 2 AND 60),
    goal_count SMALLINT NOT NULL DEFAULT 1 CHECK (goal_count BETWEEN 1 AND 100),
    reason_code VARCHAR(24) NOT NULL CHECK (reason_code ~ '^[A-Z_]{3,24}$'),
    -- OPEN → DONE (evidence linked) | CARRIED (moved to a later day) | DROPPED (over the day's budget when
    -- carried) | REPLACED (re-planned after a goal change or an applied Learner DNA revision; never a DONE task)
    status VARCHAR(8) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DONE','CARRIED','DROPPED','REPLACED')),
    carried_from BIGINT NULL REFERENCES public.learning_path_task(id) ON DELETE RESTRICT,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ NULL,
    progress_count SMALLINT NOT NULL DEFAULT 0 CHECK (progress_count BETWEEN 0 AND 1000),
    evidence_ref VARCHAR(48) NULL,
    result_pct SMALLINT NULL CHECK (result_pct IS NULL OR result_pct BETWEEN 0 AND 100),
    CONSTRAINT uq_learning_path_task_slot UNIQUE (user_id, plan_day, position),
    CONSTRAINT ck_learning_path_task_done CHECK ((status = 'DONE') = (completed_at IS NOT NULL AND evidence_ref IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_learning_path_task_day ON public.learning_path_task (user_id, plan_day DESC, position);
-- one piece of evidence completes at most one task of a kind (no double counting across retries or tasks)
CREATE UNIQUE INDEX IF NOT EXISTS uq_learning_path_task_evidence
    ON public.learning_path_task (user_id, kind, evidence_ref) WHERE evidence_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.learning_path_revision (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    base_version INTEGER NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'PROPOSED'
        CHECK (status IN ('PROPOSED','APPLIED','CANCELLED','EXPIRED','SUPERSEDED')),
    dna_generated_at TIMESTAMPTZ NOT NULL,
    focus JSONB NOT NULL,
    changes JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    decided_at TIMESTAMPTZ NULL,
    CONSTRAINT ck_learning_path_revision_decided CHECK ((status = 'PROPOSED') = (decided_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_learning_path_revision_user ON public.learning_path_revision (user_id, created_at DESC);
