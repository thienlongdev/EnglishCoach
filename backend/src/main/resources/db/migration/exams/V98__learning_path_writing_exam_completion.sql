-- Echo Learning Path completion for Writing (free, no AI) and exam practice. Additive only: one nullable column on the
-- Learning Path's own task table and one new table; no existing row is changed and nothing is seeded.

-- Exact exam-practice target of a task: "<form version uuid>/<practice scope code>" (e.g. ".../TOEIC_PART_5").
-- The server resolves and checks it; the client only builds a link from it through a fixed pattern.
ALTER TABLE public.learning_path_task
    ADD COLUMN IF NOT EXISTS target_ref VARCHAR(80) NULL
        CONSTRAINT ck_learning_path_task_target_ref CHECK (target_ref IS NULL OR target_ref ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Z0-9_]{3,40}$');

-- A learner's own practice submission of a Writing Coach draft, recorded WITHOUT AI grading (participation, never a
-- quality score). Written only by the server from the session's server-saved text after its substance checks; one per
-- session. Optional AI feedback stays on the existing Premium path and never depends on this row.
CREATE TABLE IF NOT EXISTS public.writing_practice_submission (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    session_id VARCHAR(64) NOT NULL,
    task_id VARCHAR(64) NOT NULL,
    content TEXT NOT NULL,
    word_count INTEGER NOT NULL CHECK (word_count BETWEEN 1 AND 5000),
    revision BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_writing_practice_submission_session UNIQUE (user_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_writing_practice_submission_user
    ON public.writing_practice_submission (user_id, created_at DESC);
