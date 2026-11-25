-- V26__writing_reference_answer_cache.sql
-- Writing Coach: Shared Task-Level Reference Answer Cache

CREATE TABLE IF NOT EXISTS public.writing_reference_answer_cache (
    id VARCHAR(64) PRIMARY KEY,
    cache_key VARCHAR(192) UNIQUE NOT NULL,
    task_id VARCHAR(64) NOT NULL,
    task_content_version VARCHAR(64) NOT NULL,
    prompt_version VARCHAR(32) NOT NULL,
    schema_version VARCHAR(32) NOT NULL,
    model_version VARCHAR(64) NOT NULL,
    exemplar_model_answer TEXT NOT NULL,
    calibrated_level VARCHAR(32),
    structural_observations JSONB NOT NULL DEFAULT '[]',
    lexical_alternatives JSONB NOT NULL DEFAULT '[]',
    generation_metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_writing_ref_cache_task
    ON public.writing_reference_answer_cache (task_id, task_content_version);
