-- V24__translation_paragraph_attempts_and_cache.sql
-- Paragraph Translation Mode: Immutable Attempt Persistence, User-Scoped Grade Cache, and Single-Flight Concurrency Coordination

-- 1. translation_paragraph_attempts (Immutable whole-passage grading attempts)
CREATE TABLE IF NOT EXISTS public.translation_paragraph_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    session_id UUID NOT NULL REFERENCES public.translation_paragraph_sessions(id) ON DELETE CASCADE,
    session_item_id UUID NOT NULL REFERENCES public.translation_paragraph_session_items(id) ON DELETE CASCADE,
    passage_id UUID NOT NULL REFERENCES public.translation_paragraph_passages(id) ON DELETE RESTRICT,
    content_version INTEGER NOT NULL CHECK (content_version > 0),
    attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal > 0),
    action VARCHAR(16) NOT NULL CHECK (action IN ('SUBMIT', 'REVISE', 'CONTINUE', 'SKIP')),
    client_mutation_id VARCHAR(128) NOT NULL,
    submitted_text TEXT NOT NULL,
    normalized_answer_hash CHAR(64) NOT NULL,
    evaluation_status VARCHAR(24) NOT NULL CHECK (evaluation_status IN ('PENDING', 'ACCEPTED', 'NEEDS_REVISION', 'UNCERTAIN', 'SKIPPED', 'CONTINUED')),
    grader_version VARCHAR(64) NOT NULL,
    prompt_version VARCHAR(64) NOT NULL,
    model_id VARCHAR(128),
    accepted BOOLEAN,
    feedback_snapshot JSONB,
    cache_fingerprint CHAR(64),
    generation_count SMALLINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uk_trans_para_attempts_user_mutation UNIQUE (user_id, client_mutation_id),
    CONSTRAINT uk_trans_para_attempts_item_ord UNIQUE (session_item_id, attempt_ordinal)
);

CREATE INDEX IF NOT EXISTS idx_trans_para_attempts_user_session
    ON public.translation_paragraph_attempts (user_id, session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trans_para_attempts_item
    ON public.translation_paragraph_attempts (session_item_id, attempt_ordinal DESC);

-- 2. translation_paragraph_grade_cache (User-scoped deterministic grading result cache)
CREATE TABLE IF NOT EXISTS public.translation_paragraph_grade_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    passage_id UUID NOT NULL REFERENCES public.translation_paragraph_passages(id) ON DELETE CASCADE,
    content_version INTEGER NOT NULL CHECK (content_version > 0),
    cache_fingerprint CHAR(64) NOT NULL,
    source_hash CHAR(64) NOT NULL,
    reference_hash CHAR(64) NOT NULL,
    normalized_answer_hash CHAR(64) NOT NULL,
    grader_version VARCHAR(64) NOT NULL,
    prompt_version VARCHAR(64) NOT NULL,
    feedback_json JSONB NOT NULL,
    accepted BOOLEAN NOT NULL,
    evaluation_status VARCHAR(24) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uk_trans_para_cache_user_fp UNIQUE (user_id, cache_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_trans_para_cache_passage
    ON public.translation_paragraph_grade_cache (passage_id, user_id);

-- 3. translation_paragraph_in_flight_evaluations (Single-flight duplicate submit coordination)
CREATE TABLE IF NOT EXISTS public.translation_paragraph_in_flight_evaluations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    flight_key VARCHAR(128) UNIQUE NOT NULL,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    session_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trans_para_in_flight_expires
    ON public.translation_paragraph_in_flight_evaluations (expires_at);
