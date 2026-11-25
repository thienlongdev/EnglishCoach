-- V69: quick placement reliability (2026-10-02).
--   1. Autosave / resume: proficiency_placement_progress = the mutable state of ONE issued attempt (answers so far, status).
--      proficiency_placement_issue (questions + keys) and _attempt (scored result) stay append-only and unchanged.
--      At most one IN_PROGRESS attempt per learner (partial unique index) ⇒ a second attempt is never started silently.
--      Answers are option indexes (0–3) or null ("Tôi chưa biết"); the answer keys never leave the issue table.
--   2. Question bank audit (all 80 active items reviewed): B1-V-05 had two defensible answers ("an experienced manager" /
--      "an expert manager"). It is deactivated (kept for history: issued attempts store their own question snapshot) and
--      replaced by B1-V-09 with the same target and unambiguous distractors. Bank stays 8 + 8 per level A1–C1.

CREATE TABLE IF NOT EXISTS public.proficiency_placement_progress (
    issue_id       UUID         PRIMARY KEY REFERENCES public.proficiency_placement_issue(id) ON DELETE RESTRICT,
    user_id        BIGINT       NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    status         VARCHAR(16)  NOT NULL DEFAULT 'IN_PROGRESS',
    answers        JSONB        NOT NULL DEFAULT '[]'::jsonb,
    current_index  INT          NOT NULL DEFAULT 0,
    started_at     TIMESTAMPTZ  NOT NULL,
    updated_at     TIMESTAMPTZ  NOT NULL,
    completed_at   TIMESTAMPTZ,
    abandoned_at   TIMESTAMPTZ,
    CONSTRAINT ck_placement_progress_status CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'ABANDONED')),
    CONSTRAINT ck_placement_progress_answers CHECK (jsonb_typeof(answers) = 'array'),
    CONSTRAINT ck_placement_progress_index CHECK (current_index >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_placement_progress_one_active
    ON public.proficiency_placement_progress (user_id) WHERE status = 'IN_PROGRESS';
CREATE INDEX IF NOT EXISTS idx_placement_progress_user ON public.proficiency_placement_progress (user_id, updated_at DESC);

UPDATE public.proficiency_placement_question SET active = FALSE WHERE question_key = 'B1-V-05' AND active;

INSERT INTO public.proficiency_placement_question (question_key, skill, cefr, prompt, options, answer_index) VALUES
('B1-V-09', 'VOCABULARY', 'B1', 'The company is looking for an ___ manager who has worked in sales for many years.',
 '["experienced", "experiencing", "experiment", "expertise"]', 0)
ON CONFLICT (question_key) DO NOTHING;
