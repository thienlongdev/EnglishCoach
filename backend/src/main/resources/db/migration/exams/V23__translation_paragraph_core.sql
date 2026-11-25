-- V23__translation_paragraph_core.sql
-- Paragraph Translation Mode: Core Corpus Persistence, Provenance Lineage, Canonical Eligibility, and Learner Session Storage

-- 1. translation_paragraph_sources (System-owned provenance and licensing)
CREATE TABLE IF NOT EXISTS public.translation_paragraph_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_code VARCHAR(80) NOT NULL,
    source_name VARCHAR(160) NOT NULL,
    source_release VARCHAR(120) NOT NULL,
    source_type VARCHAR(64) NOT NULL,
    legal_class VARCHAR(32) NOT NULL,
    legal_review_state VARCHAR(32) NOT NULL,
    publication_state VARCHAR(32) NOT NULL,
    license_code VARCHAR(64) NOT NULL,
    license_version VARCHAR(32),
    license_url TEXT,
    commercial_use_allowed BOOLEAN NOT NULL DEFAULT TRUE,
    derivatives_allowed BOOLEAN NOT NULL DEFAULT TRUE,
    attribution_required BOOLEAN NOT NULL DEFAULT TRUE,
    source_url TEXT,
    retrieved_at TIMESTAMPTZ,
    source_snapshot_hash CHAR(64),
    pipeline_version VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uk_trans_para_sources_release UNIQUE (source_code, source_release)
);

CREATE INDEX IF NOT EXISTS idx_trans_para_sources_pub
    ON public.translation_paragraph_sources (publication_state);

-- 2. translation_paragraph_documents (Bilingual document lineage)
CREATE TABLE IF NOT EXISTS public.translation_paragraph_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES public.translation_paragraph_sources(id) ON DELETE RESTRICT,
    external_document_id VARCHAR(255) NOT NULL,
    source_title TEXT NOT NULL,
    target_title TEXT NOT NULL,
    source_url TEXT,
    target_url TEXT,
    source_revision_id VARCHAR(64),
    target_revision_id VARCHAR(64),
    source_language VARCHAR(16) NOT NULL DEFAULT 'en',
    target_language VARCHAR(16) NOT NULL DEFAULT 'vi',
    publication_timestamp TIMESTAMPTZ,
    author TEXT,
    document_hash CHAR(64) NOT NULL,
    original_order_proven BOOLEAN NOT NULL DEFAULT TRUE,
    provenance_complete BOOLEAN NOT NULL DEFAULT TRUE,
    publication_state VARCHAR(32) NOT NULL DEFAULT 'ELIGIBLE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uk_trans_para_docs_source_rev UNIQUE (source_id, external_document_id, source_revision_id, target_revision_id)
);

CREATE INDEX IF NOT EXISTS idx_trans_para_docs_source
    ON public.translation_paragraph_documents (source_id, publication_state);

-- 3. translation_paragraph_sections (Ordered document sections)
CREATE TABLE IF NOT EXISTS public.translation_paragraph_sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES public.translation_paragraph_documents(id) ON DELETE RESTRICT,
    external_section_id VARCHAR(255) NOT NULL,
    section_number INTEGER,
    section_title TEXT,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    source_locator TEXT,
    target_locator TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uk_trans_para_sections_doc_ext UNIQUE (document_id, external_section_id),
    CONSTRAINT uk_trans_para_sections_doc_ord UNIQUE (document_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_trans_para_sections_doc
    ON public.translation_paragraph_sections (document_id, ordinal);

-- 4. translation_paragraph_passages (The authentic bilingual learning unit)
CREATE TABLE IF NOT EXISTS public.translation_paragraph_passages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES public.translation_paragraph_documents(id) ON DELETE RESTRICT,
    section_id UUID NOT NULL REFERENCES public.translation_paragraph_sections(id) ON DELETE RESTRICT,
    external_passage_id VARCHAR(255) NOT NULL,
    passage_ordinal INTEGER NOT NULL CHECK (passage_ordinal >= 0),
    source_vi TEXT NOT NULL,
    reference_en TEXT NOT NULL,
    source_span_start INTEGER NOT NULL,
    source_span_end INTEGER NOT NULL,
    target_span_start INTEGER NOT NULL,
    target_span_end INTEGER NOT NULL,
    source_revision_id VARCHAR(64),
    target_revision_id VARCHAR(64),
    source_hash CHAR(64) NOT NULL,
    reference_hash CHAR(64) NOT NULL,
    bilingual_pair_hash CHAR(64) NOT NULL,
    content_version INTEGER NOT NULL DEFAULT 1 CHECK (content_version > 0),
    alignment_score NUMERIC(6,4) NOT NULL CHECK (alignment_score BETWEEN 0 AND 1),
    alignment_decision VARCHAR(32) NOT NULL,
    coherence_score NUMERIC(6,4) NOT NULL CHECK (coherence_score BETWEEN 0 AND 1),
    coherence_decision VARCHAR(32) NOT NULL,
    quality_score NUMERIC(6,4) NOT NULL CHECK (quality_score BETWEEN 0 AND 1),
    quality_decision VARCHAR(32) NOT NULL,
    usefulness_score NUMERIC(6,4),
    rights_decision VARCHAR(32) NOT NULL,
    rights_eligible BOOLEAN NOT NULL DEFAULT TRUE,
    duplicate_cluster_id VARCHAR(255),
    canonical_content BOOLEAN NOT NULL DEFAULT TRUE,
    genre VARCHAR(64) NOT NULL,
    topic VARCHAR(64) NOT NULL,
    secondary_topics JSONB NOT NULL DEFAULT '[]'::jsonb,
    difficulty_status VARCHAR(32) NOT NULL DEFAULT 'UNCALIBRATED',
    difficulty_score NUMERIC(6,4),
    difficulty_model_version VARCHAR(64),
    difficulty_features JSONB NOT NULL DEFAULT '{}'::jsonb,
    publication_state VARCHAR(32) NOT NULL DEFAULT 'STAGED',
    attribution_text TEXT NOT NULL,
    license_code VARCHAR(64) NOT NULL,
    source_url TEXT,
    target_url TEXT,
    pipeline_version VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uk_trans_para_passages_key_version UNIQUE (document_id, external_passage_id, content_version),
    CONSTRAINT uk_trans_para_passages_bilingual_hash UNIQUE (document_id, bilingual_pair_hash, content_version)
);

CREATE INDEX IF NOT EXISTS idx_trans_para_passages_lookup
    ON public.translation_paragraph_passages (genre, topic, publication_state, canonical_content);

CREATE INDEX IF NOT EXISTS idx_trans_para_passages_doc_sec
    ON public.translation_paragraph_passages (document_id, section_id, passage_ordinal);

-- 5. Canonical Central Eligibility View
-- Single source of truth for both catalog availability and session-start eligibility
CREATE OR REPLACE VIEW public.v_eligible_translation_paragraphs AS
SELECT
    p.id AS passage_id,
    p.document_id,
    p.section_id,
    p.external_passage_id,
    p.passage_ordinal,
    p.source_vi,
    p.reference_en,
    p.source_span_start,
    p.source_span_end,
    p.target_span_start,
    p.target_span_end,
    p.bilingual_pair_hash,
    p.content_version,
    p.genre,
    p.topic,
    p.difficulty_status,
    p.difficulty_score,
    p.difficulty_features,
    p.attribution_text,
    p.license_code,
    p.source_url,
    p.target_url,
    d.source_title,
    d.target_title,
    s.source_code,
    s.source_name,
    p.created_at,
    p.updated_at
FROM public.translation_paragraph_passages p
JOIN public.translation_paragraph_documents d ON p.document_id = d.id
JOIN public.translation_paragraph_sources s ON d.source_id = s.id
WHERE
    -- Document provenance and ordering integrity
    d.provenance_complete = TRUE
    AND d.original_order_proven = TRUE
    AND d.publication_state NOT IN ('WITHDRAWN', 'BLOCKED')
    -- Source rights and status
    AND s.publication_state NOT IN ('WITHDRAWN', 'BLOCKED')
    -- Pipeline hard gates
    AND p.alignment_decision IN ('ACCEPT', 'ACCEPTED')
    AND p.coherence_decision IN ('ACCEPT', 'ACCEPTED')
    AND p.quality_decision IN ('ACCEPT', 'ACCEPTED')
    AND p.rights_eligible = TRUE
    AND p.rights_decision IN ('ELIGIBLE', 'ACCEPT', 'ACCEPTED')
    AND p.canonical_content = TRUE
    -- Passage lifecycle state
    AND p.publication_state IN ('APPROVED', 'STAGED', 'ELIGIBLE')
    AND p.publication_state NOT IN ('WITHDRAWN', 'BLOCKED')
    AND p.content_version > 0;

-- 6. translation_paragraph_sessions (User-owned resumable whole-paragraph practice session)
CREATE TABLE IF NOT EXISTS public.translation_paragraph_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    status VARCHAR(32) NOT NULL CHECK (status IN ('ACTIVE', 'COMPLETED', 'ABANDONED', 'EXPIRED')),
    client_mutation_id VARCHAR(128) NOT NULL,
    content_version INTEGER NOT NULL DEFAULT 1 CHECK (content_version > 0),
    current_index INTEGER NOT NULL DEFAULT 0 CHECK (current_index >= 0),
    session_revision BIGINT NOT NULL DEFAULT 0 CHECK (session_revision >= 0),
    total_items INTEGER NOT NULL DEFAULT 0 CHECK (total_items >= 0),
    filter_genre VARCHAR(64),
    filter_topic VARCHAR(64),
    filter_difficulty VARCHAR(64),
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    CONSTRAINT uk_trans_para_sessions_user_mutation UNIQUE (user_id, client_mutation_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_trans_para_sessions_active_user
    ON public.translation_paragraph_sessions (user_id)
    WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_trans_para_sessions_user_status
    ON public.translation_paragraph_sessions (user_id, status, updated_at DESC);

-- 7. translation_paragraph_session_items (Ordered whole-passage items in session snapshot)
CREATE TABLE IF NOT EXISTS public.translation_paragraph_session_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES public.translation_paragraph_sessions(id) ON DELETE CASCADE,
    passage_id UUID NOT NULL REFERENCES public.translation_paragraph_passages(id) ON DELETE RESTRICT,
    content_version INTEGER NOT NULL DEFAULT 1 CHECK (content_version > 0),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    draft_text TEXT NOT NULL DEFAULT '',
    draft_revision BIGINT NOT NULL DEFAULT 0 CHECK (draft_revision >= 0),
    progress_state VARCHAR(32) NOT NULL DEFAULT 'NOT_STARTED' CHECK (progress_state IN ('NOT_STARTED', 'IN_PROGRESS', 'SKIPPED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uk_trans_para_items_session_ord UNIQUE (session_id, ordinal),
    CONSTRAINT uk_trans_para_items_session_passage UNIQUE (session_id, passage_id)
);

CREATE INDEX IF NOT EXISTS idx_trans_para_items_session
    ON public.translation_paragraph_session_items (session_id, ordinal);
