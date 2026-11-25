-- Echo Grammar Academy: learner progress only. Lessons, exercises and answer keys are release files on the classpath
-- (resources/grammar), never rows. Every table is scoped by user_id with an owner FK that restricts deletion (AGENTS §21).

CREATE TABLE public.grammar_profile (
    user_id bigint PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
    start_level varchar(8),
    start_basis varchar(16) CHECK (start_basis IN ('DIAGNOSTIC', 'SELF')),
    diagnostic_session uuid,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per learner and topic. Status never decides mastery alone: mastered_at is set only by a submitted check.
CREATE TABLE public.grammar_topic_state (
    user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    topic_slug varchar(80) NOT NULL,
    first_opened_at timestamptz NOT NULL DEFAULT now(),
    last_opened_at timestamptz NOT NULL DEFAULT now(),
    studied_at timestamptz,
    practice_scored integer NOT NULL DEFAULT 0,
    practice_points numeric(8, 2) NOT NULL DEFAULT 0,
    last_check_pct integer CHECK (last_check_pct BETWEEN 0 AND 100),
    best_check_pct integer CHECK (best_check_pct BETWEEN 0 AND 100),
    last_check_at timestamptz,
    mastered_at timestamptz,
    review_stage integer NOT NULL DEFAULT 0,
    review_due_at timestamptz,
    needs_review boolean NOT NULL DEFAULT false,
    content_version integer NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, topic_slug)
);
CREATE INDEX idx_grammar_state_due ON public.grammar_topic_state (user_id, review_due_at) WHERE review_due_at IS NOT NULL;

-- A check is issued by the server; only the exercises it issued can be scored, once.
CREATE TABLE public.grammar_check_session (
    id uuid PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    kind varchar(16) NOT NULL CHECK (kind IN ('TOPIC', 'REVIEW', 'DIAGNOSTIC', 'DOMAIN', 'IELTS', 'TOEIC')),
    scope varchar(80),
    exercise_ids jsonb NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    submitted_at timestamptz,
    pct integer CHECK (pct BETWEEN 0 AND 100),
    scored_items integer,
    result jsonb
);
CREATE INDEX idx_grammar_check_owner ON public.grammar_check_session (user_id, started_at DESC);

CREATE TABLE public.grammar_attempt (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    request_id uuid NOT NULL,
    topic_slug varchar(80) NOT NULL,
    exercise_id varchar(64) NOT NULL,
    exercise_type varchar(16) NOT NULL,
    content_version integer NOT NULL,
    mode varchar(16) NOT NULL CHECK (mode IN ('PRACTICE', 'CHECK')),
    outcome varchar(16) NOT NULL CHECK (outcome IN ('CORRECT', 'ACCEPTABLE', 'PARTIAL', 'WRONG', 'UNRECOGNIZED', 'SELF_REVIEW')),
    score numeric(4, 3),
    answer_text varchar(400),
    misconceptions varchar(200),
    session_id uuid REFERENCES public.grammar_check_session(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_grammar_attempt_request UNIQUE (user_id, request_id)
);
CREATE INDEX idx_grammar_attempt_recent ON public.grammar_attempt (user_id, created_at DESC);
CREATE INDEX idx_grammar_attempt_topic ON public.grammar_attempt (user_id, topic_slug, created_at DESC);
CREATE INDEX idx_grammar_attempt_errors ON public.grammar_attempt (user_id, created_at DESC) WHERE misconceptions IS NOT NULL;

CREATE TABLE public.grammar_bookmark (
    user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    topic_slug varchar(80) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, topic_slug)
);

-- "Câu trả lời của mình có vẻ cũng đúng" and content corrections: the editors' way to learn about a missing alternative.
CREATE TABLE public.grammar_report (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    topic_slug varchar(80),
    exercise_id varchar(64),
    kind varchar(16) NOT NULL CHECK (kind IN ('ANSWER', 'CONTENT')),
    answer_text varchar(400),
    message varchar(800),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_grammar_report_recent ON public.grammar_report (created_at DESC);
CREATE INDEX idx_grammar_report_owner ON public.grammar_report (user_id, created_at DESC);

-- Optional, explicit, AI-assisted grammar question (Grammar Professor). Draws on the shared free AI allowance like every AI feature.
INSERT INTO public.premium_feature_definitions
    (feature_key, display_name, description, premium_required, free_trial_limit, premium_monthly_limit, enabled, sort_order)
VALUES
    ('GRAMMAR_PROFESSOR', 'Hỏi Giáo sư Ngữ pháp', 'Câu hỏi ngữ pháp do người học gửi, trả lời dựa trên bài học đã biên soạn.', true, 5, 300, true, 95)
ON CONFLICT (feature_key) DO NOTHING;
