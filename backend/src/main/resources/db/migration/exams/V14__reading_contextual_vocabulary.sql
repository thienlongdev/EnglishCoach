-- V14__reading_contextual_vocabulary.sql
-- Reading Contextual Vocabulary System: Shared Explanation Cache and User History

-- 1. Create public.reading_contextual_explanations if it doesn't exist
CREATE TABLE IF NOT EXISTS public.reading_contextual_explanations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reading_material_id BIGINT NOT NULL,
    selected_text VARCHAR(255) NOT NULL,
    normalized_text VARCHAR(255) NOT NULL,
    lemma VARCHAR(255),
    pos VARCHAR(255),
    ipa VARCHAR(255),
    cefr VARCHAR(255),
    frequency VARCHAR(255),
    meaning_in_context TEXT NOT NULL,
    native_explanation TEXT,
    source_sentence TEXT NOT NULL,
    context_hash VARCHAR(64) NOT NULL,
    collocations_json TEXT,
    synonyms_json TEXT,
    grammar_note TEXT,
    explanation_version VARCHAR(50) NOT NULL DEFAULT 'v1',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Idempotent unique constraint for reading_contextual_explanations
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uk_rce_mat_norm_hash_ver'
    ) THEN
        ALTER TABLE public.reading_contextual_explanations
            ADD CONSTRAINT uk_rce_mat_norm_hash_ver 
            UNIQUE (reading_material_id, normalized_text, context_hash, explanation_version);
    END IF;
END $$;

-- Idempotent index for fast lookup
CREATE INDEX IF NOT EXISTS idx_rce_lookup 
    ON public.reading_contextual_explanations (reading_material_id, normalized_text, context_hash, explanation_version);

-- 2. Create public.reading_contextual_vocabulary_history if it doesn't exist
CREATE TABLE IF NOT EXISTS public.reading_contextual_vocabulary_history (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL,
    reading_material_id BIGINT NOT NULL,
    contextual_explanation_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Idempotent foreign key for contextual_explanation_id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conrelid = 'public.reading_contextual_vocabulary_history'::regclass 
          AND contype = 'f' 
          AND conname IN ('fk_rcvh_explanation', 'fkchioqrsex6bovs2fksm1jnoft')
    ) THEN
        ALTER TABLE public.reading_contextual_vocabulary_history
            ADD CONSTRAINT fk_rcvh_explanation 
            FOREIGN KEY (contextual_explanation_id) 
            REFERENCES public.reading_contextual_explanations(id) 
            ON DELETE CASCADE;
    END IF;
END $$;

-- Idempotent unique constraint for user + material + explanation
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uk_rcvh_user_mat_exp'
    ) THEN
        ALTER TABLE public.reading_contextual_vocabulary_history
            ADD CONSTRAINT uk_rcvh_user_mat_exp 
            UNIQUE (user_id, reading_material_id, contextual_explanation_id);
    END IF;
END $$;

-- Idempotent indexes for history lookups
CREATE INDEX IF NOT EXISTS idx_rcvh_user_material 
    ON public.reading_contextual_vocabulary_history (user_id, reading_material_id);

CREATE INDEX IF NOT EXISTS idx_rcvh_explanation 
    ON public.reading_contextual_vocabulary_history (contextual_explanation_id);
