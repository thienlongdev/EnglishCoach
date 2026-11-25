-- V18__writing_translation_practice.sql
-- Translation Practice Feature: Provenance, Catalog, Sessions, Drafts, Attempts, Receipts, and User-Scoped Grade Cache

-- 1. translation_sources (System-owned provenance)
CREATE TABLE IF NOT EXISTS public.translation_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_code VARCHAR(80) NOT NULL,
    official_url TEXT NOT NULL,
    release_version VARCHAR(120) NOT NULL,
    license_name VARCHAR(120) NOT NULL,
    license_url TEXT NOT NULL,
    license_class VARCHAR(32) NOT NULL CHECK (license_class IN ('CC0', 'CC_BY', 'CC_BY_SA', 'CONDITIONAL', 'RESEARCH_ONLY', 'UNKNOWN')),
    attribution_text TEXT,
    commercial_use_allowed BOOLEAN NOT NULL,
    redistribution_allowed BOOLEAN NOT NULL,
    checksum_sha256 CHAR(64) NOT NULL,
    manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uk_translation_sources_release UNIQUE (source_code, release_version, checksum_sha256)
);

-- 2. translation_import_batches
CREATE TABLE IF NOT EXISTS public.translation_import_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES public.translation_sources(id) ON DELETE RESTRICT,
    batch_key VARCHAR(255) UNIQUE NOT NULL,
    importer_version VARCHAR(64) NOT NULL,
    taxonomy_version VARCHAR(64) NOT NULL,
    normalizer_version VARCHAR(64) NOT NULL,
    status VARCHAR(24) NOT NULL CHECK (status IN ('STAGED', 'APPROVED', 'ACTIVE', 'REJECTED', 'ROLLED_BACK')),
    records_read BIGINT NOT NULL DEFAULT 0 CHECK (records_read >= 0),
    records_accepted BIGINT NOT NULL DEFAULT 0 CHECK (records_accepted >= 0),
    records_rejected BIGINT NOT NULL DEFAULT 0 CHECK (records_rejected >= 0),
    records_review BIGINT NOT NULL DEFAULT 0 CHECK (records_review >= 0),
    artifact_uri TEXT NOT NULL,
    artifact_sha256 CHAR(64) NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_translation_import_batches_source
    ON public.translation_import_batches (source_id, status, created_at DESC);

-- 3. translation_documents (Coherent paragraph documents)
CREATE TABLE IF NOT EXISTS public.translation_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES public.translation_sources(id) ON DELETE RESTRICT,
    import_batch_id UUID NOT NULL REFERENCES public.translation_import_batches(id) ON DELETE RESTRICT,
    source_document_id VARCHAR(255) NOT NULL,
    document_kind VARCHAR(24) NOT NULL CHECK (document_kind = 'PARAGRAPH'),
    topic_code VARCHAR(32) NOT NULL,
    difficulty_bucket VARCHAR(24) NOT NULL,
    cefr_band VARCHAR(8),
    quality_score NUMERIC(5,2) NOT NULL CHECK (quality_score BETWEEN 0 AND 100),
    coherence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    content_version INTEGER NOT NULL CHECK (content_version > 0),
    active BOOLEAN NOT NULL DEFAULT FALSE,
    sequence_count SMALLINT NOT NULL CHECK (sequence_count BETWEEN 3 AND 8),
    random_bucket SMALLINT NOT NULL CHECK (random_bucket BETWEEN 0 AND 1023),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uk_translation_documents_source UNIQUE (source_id, source_document_id, content_version)
);

CREATE INDEX IF NOT EXISTS idx_translation_documents_active
    ON public.translation_documents (document_kind, topic_code, difficulty_bucket, random_bucket, id)
    WHERE active;

-- 4. translation_exercises (Sentence or Paragraph parent row)
CREATE TABLE IF NOT EXISTS public.translation_exercises (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES public.translation_sources(id) ON DELETE RESTRICT,
    import_batch_id UUID NOT NULL REFERENCES public.translation_import_batches(id) ON DELETE RESTRICT,
    document_id UUID REFERENCES public.translation_documents(id) ON DELETE RESTRICT,
    mode VARCHAR(16) NOT NULL CHECK (mode IN ('SENTENCE', 'PARAGRAPH')),
    source_vi TEXT,
    reference_en TEXT,
    source_record_id VARCHAR(255),
    topic_code VARCHAR(32) NOT NULL,
    difficulty_bucket VARCHAR(24) NOT NULL,
    cefr_band VARCHAR(8),
    quality_score NUMERIC(5,2) NOT NULL CHECK (quality_score BETWEEN 0 AND 100),
    target_chunks_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    content_version INTEGER NOT NULL CHECK (content_version > 0),
    active BOOLEAN NOT NULL DEFAULT FALSE,
    random_bucket SMALLINT NOT NULL CHECK (random_bucket BETWEEN 0 AND 1023),
    source_matching_hash CHAR(64) NOT NULL,
    reference_matching_hash CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_translation_exercises_mode_fields CHECK (
        (mode = 'SENTENCE' AND source_vi IS NOT NULL AND reference_en IS NOT NULL) OR
        (mode = 'PARAGRAPH' AND source_vi IS NULL AND reference_en IS NULL AND document_id IS NOT NULL)
    ),
    CONSTRAINT uk_translation_exercises_id_mode UNIQUE (id, mode)
);

CREATE INDEX IF NOT EXISTS idx_translation_exercises_doc_mode
    ON public.translation_exercises (document_id, mode, active);

CREATE INDEX IF NOT EXISTS idx_translation_exercises_active_rand
    ON public.translation_exercises (random_bucket, id)
    WHERE active;

CREATE INDEX IF NOT EXISTS idx_translation_exercises_active_mode_rand
    ON public.translation_exercises (mode, random_bucket, id)
    WHERE active;

CREATE INDEX IF NOT EXISTS idx_translation_exercises_active_topic_rand
    ON public.translation_exercises (topic_code, random_bucket, id)
    WHERE active;

CREATE INDEX IF NOT EXISTS idx_translation_exercises_active_diff_rand
    ON public.translation_exercises (difficulty_bucket, random_bucket, id)
    WHERE active;

CREATE INDEX IF NOT EXISTS idx_translation_exercises_active_full
    ON public.translation_exercises (mode, topic_code, difficulty_bucket, random_bucket, id)
    WHERE active;

-- 5. translation_exercise_units (Ordered child units)
CREATE TABLE IF NOT EXISTS public.translation_exercise_units (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exercise_id UUID NOT NULL REFERENCES public.translation_exercises(id) ON DELETE RESTRICT,
    ordinal SMALLINT NOT NULL CHECK (ordinal > 0),
    source_vi TEXT NOT NULL,
    reference_en TEXT NOT NULL,
    source_record_id VARCHAR(255),
    quality_score NUMERIC(5,2) NOT NULL CHECK (quality_score BETWEEN 0 AND 100),
    target_chunks_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    accepted_variants_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    content_version INTEGER NOT NULL CHECK (content_version > 0),
    active BOOLEAN NOT NULL DEFAULT FALSE,
    source_matching_hash CHAR(64) NOT NULL,
    reference_matching_hash CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uk_translation_units_exercise_ordinal UNIQUE (exercise_id, ordinal),
    CONSTRAINT uk_translation_units_composite UNIQUE (id, exercise_id)
);

CREATE INDEX IF NOT EXISTS idx_translation_exercise_units_lookup
    ON public.translation_exercise_units (exercise_id, active, ordinal);

-- 6. translation_sessions (User-owned resumable session)
CREATE TABLE IF NOT EXISTS public.translation_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    exercise_id UUID NOT NULL REFERENCES public.translation_exercises(id) ON DELETE RESTRICT,
    content_version INTEGER NOT NULL CHECK (content_version > 0),
    status VARCHAR(20) NOT NULL CHECK (status IN ('ACTIVE', 'COMPLETED', 'ABANDONED', 'EXPIRED')),
    current_ordinal SMALLINT NOT NULL CHECK (current_ordinal > 0),
    session_revision BIGINT NOT NULL DEFAULT 0 CHECK (session_revision >= 0),
    client_mutation_id VARCHAR(128) NOT NULL,
    request_sha256 CHAR(64) NOT NULL,
    context_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    context_hash CHAR(64) NOT NULL,
    last_attempt_id UUID,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    CONSTRAINT uk_translation_sessions_user_mutation UNIQUE (user_id, client_mutation_id),
    CONSTRAINT uk_translation_sessions_id_exercise UNIQUE (id, exercise_id),
    CONSTRAINT uk_translation_sessions_id_user UNIQUE (id, user_id),
    CONSTRAINT uk_translation_sessions_id_user_exercise UNIQUE (id, user_id, exercise_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_translation_sessions_active_user_exercise
    ON public.translation_sessions (user_id, exercise_id)
    WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_translation_sessions_user_status
    ON public.translation_sessions (user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_translation_sessions_user_exercise
    ON public.translation_sessions (user_id, exercise_id, status);

-- 7. translation_session_units (Persisted unsent drafts and progressive hint states)
CREATE TABLE IF NOT EXISTS public.translation_session_units (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL,
    exercise_id UUID NOT NULL,
    unit_id UUID NOT NULL,
    unit_ordinal SMALLINT NOT NULL CHECK (unit_ordinal > 0),
    draft_text TEXT NOT NULL DEFAULT '',
    draft_revision BIGINT NOT NULL DEFAULT 0 CHECK (draft_revision >= 0),
    hint_level VARCHAR(16) NOT NULL DEFAULT 'HIDDEN' CHECK (hint_level IN ('HIDDEN', 'CUE', 'CHUNK', 'REFERENCE')),
    reference_revealed BOOLEAN NOT NULL DEFAULT FALSE,
    terminal_status VARCHAR(24) NOT NULL DEFAULT 'UNSEEN' CHECK (terminal_status IN ('UNSEEN', 'DRAFTING', 'ACCEPTED', 'NEEDS_REVISION', 'REVEALED', 'SKIPPED', 'UNCERTAIN')),
    last_attempt_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_session_units_session_exercise FOREIGN KEY (session_id, exercise_id) REFERENCES public.translation_sessions(id, exercise_id) ON DELETE RESTRICT,
    CONSTRAINT fk_session_units_unit_exercise FOREIGN KEY (unit_id, exercise_id) REFERENCES public.translation_exercise_units(id, exercise_id) ON DELETE RESTRICT,
    CONSTRAINT uk_session_units_session_unit UNIQUE (session_id, unit_id),
    CONSTRAINT uk_session_units_session_ordinal UNIQUE (session_id, unit_ordinal),
    CONSTRAINT uk_session_units_id_session UNIQUE (id, session_id),
    CONSTRAINT uk_session_units_id_exercise UNIQUE (id, exercise_id)
);

-- 8. translation_attempts (Immutable user-owned attempts)
CREATE TABLE IF NOT EXISTS public.translation_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    session_id UUID NOT NULL,
    exercise_id UUID NOT NULL,
    unit_id UUID NOT NULL,
    unit_ordinal SMALLINT NOT NULL CHECK (unit_ordinal > 0),
    attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal > 0),
    action VARCHAR(16) NOT NULL CHECK (action IN ('SUBMIT', 'REVISE', 'CONTINUE', 'SKIP')),
    client_mutation_id VARCHAR(128) NOT NULL,
    request_sha256 CHAR(64) NOT NULL,
    answer_text TEXT NOT NULL,
    exact_answer_hash CHAR(64) NOT NULL,
    answer_cache_hash CHAR(64) NOT NULL,
    hint_level VARCHAR(16) NOT NULL,
    reference_revealed BOOLEAN NOT NULL,
    evaluation_status VARCHAR(24) NOT NULL CHECK (evaluation_status IN ('PENDING', 'ACCEPTED', 'NEEDS_REVISION', 'INCORRECT', 'UNCERTAIN', 'SKIPPED', 'CONTINUED', 'UNAVAILABLE')),
    grader_version VARCHAR(64) NOT NULL,
    result_snapshot JSONB,
    accepted BOOLEAN,
    cache_fingerprint CHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_attempts_session_user_exercise FOREIGN KEY (session_id, user_id, exercise_id) REFERENCES public.translation_sessions(id, user_id, exercise_id) ON DELETE RESTRICT,
    CONSTRAINT fk_attempts_unit_exercise FOREIGN KEY (unit_id, exercise_id) REFERENCES public.translation_exercise_units(id, exercise_id) ON DELETE RESTRICT,
    CONSTRAINT uk_translation_attempts_user_mutation UNIQUE (user_id, client_mutation_id),
    CONSTRAINT uk_translation_attempts_session_ordinal UNIQUE (session_id, unit_ordinal, attempt_ordinal),
    CONSTRAINT ck_translation_attempts_eval_state CHECK (
        (evaluation_status IN ('PENDING', 'UNAVAILABLE') AND accepted IS NULL AND result_snapshot IS NULL) OR
        (evaluation_status = 'ACCEPTED' AND accepted = TRUE AND result_snapshot IS NOT NULL) OR
        (evaluation_status IN ('NEEDS_REVISION', 'INCORRECT') AND accepted = FALSE AND result_snapshot IS NOT NULL) OR
        (evaluation_status = 'UNCERTAIN' AND accepted IS NULL AND result_snapshot IS NOT NULL) OR
        (evaluation_status IN ('SKIPPED', 'CONTINUED') AND accepted IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_translation_attempts_user_exercise
    ON public.translation_attempts (user_id, exercise_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_translation_attempts_session_unit
    ON public.translation_attempts (session_id, unit_ordinal, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_translation_attempts_user_fingerprint
    ON public.translation_attempts (user_id, cache_fingerprint, evaluation_status);

-- 9. translation_mutation_receipts (Draft and hint mutation idempotency)
CREATE TABLE IF NOT EXISTS public.translation_mutation_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    session_id UUID NOT NULL,
    session_unit_id UUID NOT NULL,
    endpoint VARCHAR(32) NOT NULL CHECK (endpoint IN ('DRAFT', 'HINT')),
    client_mutation_id VARCHAR(128) NOT NULL,
    request_sha256 CHAR(64) NOT NULL,
    response_snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_receipts_session_user FOREIGN KEY (session_id, user_id) REFERENCES public.translation_sessions(id, user_id) ON DELETE RESTRICT,
    CONSTRAINT fk_receipts_session_unit FOREIGN KEY (session_unit_id, session_id) REFERENCES public.translation_session_units(id, session_id) ON DELETE RESTRICT,
    CONSTRAINT uk_receipts_user_mutation UNIQUE (user_id, client_mutation_id)
);

-- 10. translation_grade_cache (User-scoped persistent grade cache and single-flight lease)
CREATE TABLE IF NOT EXISTS public.translation_grade_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    fingerprint_hash CHAR(64) NOT NULL,
    exercise_id UUID NOT NULL REFERENCES public.translation_exercises(id) ON DELETE RESTRICT,
    content_version INTEGER NOT NULL CHECK (content_version > 0),
    unit_id UUID NOT NULL,
    grader_version VARCHAR(64) NOT NULL,
    answer_cache_hash CHAR(64) NOT NULL,
    exact_answer_hash CHAR(64) NOT NULL,
    paragraph_context_hash CHAR(64),
    result_snapshot JSONB,
    result_status VARCHAR(16) NOT NULL CHECK (result_status IN ('LEASED', 'READY')),
    lease_owner VARCHAR(128),
    lease_until TIMESTAMPTZ,
    owner_attempt_id UUID REFERENCES public.translation_attempts(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ,
    CONSTRAINT fk_grade_cache_unit_exercise FOREIGN KEY (unit_id, exercise_id) REFERENCES public.translation_exercise_units(id, exercise_id) ON DELETE RESTRICT,
    CONSTRAINT uk_translation_grade_cache_user_fingerprint UNIQUE (user_id, fingerprint_hash),
    CONSTRAINT ck_grade_cache_status_state CHECK (
        (result_status = 'READY' AND result_snapshot IS NOT NULL AND expires_at IS NOT NULL AND lease_owner IS NULL AND lease_until IS NULL) OR
        (result_status = 'LEASED' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL AND result_snapshot IS NULL AND expires_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_translation_grade_cache_user_exercise
    ON public.translation_grade_cache (user_id, exercise_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_translation_grade_cache_lease_until
    ON public.translation_grade_cache (lease_until);

-- Initial Seed Data: Provenance, Source, Batch, and Licensed Sentence Exercises
INSERT INTO public.translation_sources (id, source_code, official_url, release_version, license_name, license_url, license_class, attribution_text, commercial_use_allowed, redistribution_allowed, checksum_sha256, manifest_json) VALUES ('a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d', 'TATOEBA', 'https://tatoeba.org', '2026-09', 'CC BY 2.0 FR', 'https://creativecommons.org/licenses/by/2.0/fr/', 'CC_BY', 'Tatoeba contributors (CC BY 2.0 FR)', TRUE, TRUE, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', '{"source": "tatoeba"}'::jsonb) ON CONFLICT DO NOTHING;
INSERT INTO public.translation_import_batches (id, source_id, batch_key, importer_version, taxonomy_version, normalizer_version, status, records_read, records_accepted, records_rejected, records_review, artifact_uri, artifact_sha256) VALUES ('b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d', 'TATOEBA_2026-09_INIT_SEED', 'v1.0', 'v1.0', 'v1.0', 'ACTIVE', 18, 18, 0, 0, 'corpus://tatoeba/init', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercises (id, source_id, import_batch_id, document_id, mode, source_vi, reference_en, source_record_id, topic_code, difficulty_bucket, cefr_band, quality_score, target_chunks_json, content_version, active, random_bucket, source_matching_hash, reference_matching_hash) VALUES ('4ad86580-26ab-57ab-81b6-4a4b1d11afa7', 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', NULL, 'SENTENCE', 'Học sinh cần đọc sách mỗi ngày để mở rộng vốn từ.', 'Students need to read books every day to expand their vocabulary.', 'tatoeba_1', 'EDUCATION', 'FOUNDATION', 'A2', 85.00, '[{"text": "expand their vocabulary", "kind": "COLLOCATION", "cue": "e...", "order": 1, "source": "CURATION"}]'::jsonb, 1, TRUE, 610, '112b734ac7583ce8085f2595e5453969caef55b86a70f6aa719762fdc645cee2', '5c8ff99f62da1f6f0525b7c725125a29a5916c31f906cbb38f354f9a48f9f536') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercise_units (id, exercise_id, ordinal, source_vi, reference_en, source_record_id, quality_score, target_chunks_json, accepted_variants_json, content_version, active, source_matching_hash, reference_matching_hash) VALUES ('dc2c71d1-8ada-5121-ad1d-1a9fcbe677ba', '4ad86580-26ab-57ab-81b6-4a4b1d11afa7', 1, 'Học sinh cần đọc sách mỗi ngày để mở rộng vốn từ.', 'Students need to read books every day to expand their vocabulary.', 'tatoeba_1', 85.00, '[{"text": "expand their vocabulary", "kind": "COLLOCATION", "cue": "e...", "order": 1, "source": "CURATION"}]'::jsonb, '[]'::jsonb, 1, TRUE, '112b734ac7583ce8085f2595e5453969caef55b86a70f6aa719762fdc645cee2', '5c8ff99f62da1f6f0525b7c725125a29a5916c31f906cbb38f354f9a48f9f536') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercises (id, source_id, import_batch_id, document_id, mode, source_vi, reference_en, source_record_id, topic_code, difficulty_bucket, cefr_band, quality_score, target_chunks_json, content_version, active, random_bucket, source_matching_hash, reference_matching_hash) VALUES ('f4b7a223-d0e6-5e76-b404-d7febcc520ea', 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', NULL, 'SENTENCE', 'Giáo dục đóng vai trò quan trọng trong việc phát triển tư duy phản biện của giới trẻ.', 'Education plays a crucial role in developing young people''s critical thinking.', 'tatoeba_2', 'EDUCATION', 'CORE', 'B1', 85.00, '[{"text": "plays a crucial role in", "kind": "COLLOCATION", "cue": "p...", "order": 1, "source": "CURATION"}]'::jsonb, 1, TRUE, 189, '2766213d48e3bdc2804b5ecf8dd99697224bb1f74528fee0bbe1914f283e2935', '39cbd320087f05da153a9cdb5ea8714dc1539f951f31ae02d062de241ef34914') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercise_units (id, exercise_id, ordinal, source_vi, reference_en, source_record_id, quality_score, target_chunks_json, accepted_variants_json, content_version, active, source_matching_hash, reference_matching_hash) VALUES ('7ea54e22-dc05-5353-bef1-e94b937bddda', 'f4b7a223-d0e6-5e76-b404-d7febcc520ea', 1, 'Giáo dục đóng vai trò quan trọng trong việc phát triển tư duy phản biện của giới trẻ.', 'Education plays a crucial role in developing young people''s critical thinking.', 'tatoeba_2', 85.00, '[{"text": "plays a crucial role in", "kind": "COLLOCATION", "cue": "p...", "order": 1, "source": "CURATION"}]'::jsonb, '[]'::jsonb, 1, TRUE, '2766213d48e3bdc2804b5ecf8dd99697224bb1f74528fee0bbe1914f283e2935', '39cbd320087f05da153a9cdb5ea8714dc1539f951f31ae02d062de241ef34914') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercises (id, source_id, import_batch_id, document_id, mode, source_vi, reference_en, source_record_id, topic_code, difficulty_bucket, cefr_band, quality_score, target_chunks_json, content_version, active, random_bucket, source_matching_hash, reference_matching_hash) VALUES ('b232471c-6b13-5b7c-9cf8-565f03cc53b7', 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', NULL, 'SENTENCE', 'Mặc dù học trực tuyến mang lại sự linh hoạt, nó đòi hỏi học sinh phải có tính kỷ luật cao.', 'Although online learning offers flexibility, it requires students to maintain a high degree of self-discipline.', 'tatoeba_3', 'EDUCATION', 'CHALLENGE', 'C1', 85.00, '[{"text": "high degree of self-discipline", "kind": "COLLOCATION", "cue": "h...", "order": 1, "source": "CURATION"}]'::jsonb, 1, TRUE, 889, '2f3c8ba24dbf86a715aa6507e3882e39073b1047b149abf4d537b715690ed2cc', 'fd63fd5039c2d1e270e1d3ec203f3282f628ae4bfb147922291bf5ae19a024b7') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercise_units (id, exercise_id, ordinal, source_vi, reference_en, source_record_id, quality_score, target_chunks_json, accepted_variants_json, content_version, active, source_matching_hash, reference_matching_hash) VALUES ('e45a5b61-e2e6-5fde-a5ba-594a0cfe2e72', 'b232471c-6b13-5b7c-9cf8-565f03cc53b7', 1, 'Mặc dù học trực tuyến mang lại sự linh hoạt, nó đòi hỏi học sinh phải có tính kỷ luật cao.', 'Although online learning offers flexibility, it requires students to maintain a high degree of self-discipline.', 'tatoeba_3', 85.00, '[{"text": "high degree of self-discipline", "kind": "COLLOCATION", "cue": "h...", "order": 1, "source": "CURATION"}]'::jsonb, '[]'::jsonb, 1, TRUE, '2f3c8ba24dbf86a715aa6507e3882e39073b1047b149abf4d537b715690ed2cc', 'fd63fd5039c2d1e270e1d3ec203f3282f628ae4bfb147922291bf5ae19a024b7') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercises (id, source_id, import_batch_id, document_id, mode, source_vi, reference_en, source_record_id, topic_code, difficulty_bucket, cefr_band, quality_score, target_chunks_json, content_version, active, random_bucket, source_matching_hash, reference_matching_hash) VALUES ('caf8cb29-e319-5f5e-ba18-3a872c9a022e', 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', NULL, 'SENTENCE', 'Điện thoại thông minh giúp chúng ta kết nối với bạn bè trên khắp thế giới.', 'Smartphones help us connect with friends around the world.', 'tatoeba_4', 'TECHNOLOGY', 'FOUNDATION', 'A2', 85.00, '[{"text": "connect with friends", "kind": "COLLOCATION", "cue": "c...", "order": 1, "source": "CURATION"}]'::jsonb, 1, TRUE, 413, '353ea7c46bd39978849faf7b0ab75f5c1a0eed0f53eb939d94365327aa550adc', '2d642b2c55a1a74e2f1b0ab92f1fc7453295e3c27e09a4eb839770a33b6eb56b') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercise_units (id, exercise_id, ordinal, source_vi, reference_en, source_record_id, quality_score, target_chunks_json, accepted_variants_json, content_version, active, source_matching_hash, reference_matching_hash) VALUES ('14bac38b-053d-51de-b3bd-b19013a0f831', 'caf8cb29-e319-5f5e-ba18-3a872c9a022e', 1, 'Điện thoại thông minh giúp chúng ta kết nối với bạn bè trên khắp thế giới.', 'Smartphones help us connect with friends around the world.', 'tatoeba_4', 85.00, '[{"text": "connect with friends", "kind": "COLLOCATION", "cue": "c...", "order": 1, "source": "CURATION"}]'::jsonb, '[]'::jsonb, 1, TRUE, '353ea7c46bd39978849faf7b0ab75f5c1a0eed0f53eb939d94365327aa550adc', '2d642b2c55a1a74e2f1b0ab92f1fc7453295e3c27e09a4eb839770a33b6eb56b') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercises (id, source_id, import_batch_id, document_id, mode, source_vi, reference_en, source_record_id, topic_code, difficulty_bucket, cefr_band, quality_score, target_chunks_json, content_version, active, random_bucket, source_matching_hash, reference_matching_hash) VALUES ('18e134dd-7d88-5e38-99d1-0bf7eb81c94b', 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', NULL, 'SENTENCE', 'Trí tuệ nhân tạo đang làm thay đổi cách thức con người làm việc và giao tiếp.', 'Artificial intelligence is changing the way people work and communicate.', 'tatoeba_5', 'TECHNOLOGY', 'CORE', 'B1', 85.00, '[{"text": "Artificial intelligence", "kind": "KEYWORD", "cue": "A...", "order": 1, "source": "CURATION"}]'::jsonb, 1, TRUE, 560, '4e441ebf1a1480a8cc429dea31c58ded69209836601eefef51e275a581390e82', '9f9e4679c16ddf0e4d1d7a54a6867ee5f50bd75f80645a257fd06c88353ff3a1') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercise_units (id, exercise_id, ordinal, source_vi, reference_en, source_record_id, quality_score, target_chunks_json, accepted_variants_json, content_version, active, source_matching_hash, reference_matching_hash) VALUES ('253f3720-d1de-505b-9f65-2a9885ff4fd5', '18e134dd-7d88-5e38-99d1-0bf7eb81c94b', 1, 'Trí tuệ nhân tạo đang làm thay đổi cách thức con người làm việc và giao tiếp.', 'Artificial intelligence is changing the way people work and communicate.', 'tatoeba_5', 85.00, '[{"text": "Artificial intelligence", "kind": "KEYWORD", "cue": "A...", "order": 1, "source": "CURATION"}]'::jsonb, '[]'::jsonb, 1, TRUE, '4e441ebf1a1480a8cc429dea31c58ded69209836601eefef51e275a581390e82', '9f9e4679c16ddf0e4d1d7a54a6867ee5f50bd75f80645a257fd06c88353ff3a1') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercises (id, source_id, import_batch_id, document_id, mode, source_vi, reference_en, source_record_id, topic_code, difficulty_bucket, cefr_band, quality_score, target_chunks_json, content_version, active, random_bucket, source_matching_hash, reference_matching_hash) VALUES ('e097ae78-6d47-55e6-a8dd-7b516b3c610f', 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', NULL, 'SENTENCE', 'Sự phát triển nhanh chóng của công nghệ đòi hỏi các tổ chức phải liên tục cập nhật các biện pháp an ninh mạng.', 'The rapid advancement of technology requires organizations to continuously upgrade their cybersecurity measures.', 'tatoeba_6', 'TECHNOLOGY', 'CHALLENGE', 'C1', 85.00, '[{"text": "rapid advancement of technology", "kind": "COLLOCATION", "cue": "r...", "order": 1, "source": "CURATION"}]'::jsonb, 1, TRUE, 288, '46a492d33288ac46d9a01f4a9f6c973b833c7c0530d9ce75ef377725d583a223', '79ab54175fc8f337f9c840f9fc4040c180be3ba676b295db64eaad7b9aeea4cc') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercise_units (id, exercise_id, ordinal, source_vi, reference_en, source_record_id, quality_score, target_chunks_json, accepted_variants_json, content_version, active, source_matching_hash, reference_matching_hash) VALUES ('4faa5630-ea77-5c8b-bfba-e6ae7248202a', 'e097ae78-6d47-55e6-a8dd-7b516b3c610f', 1, 'Sự phát triển nhanh chóng của công nghệ đòi hỏi các tổ chức phải liên tục cập nhật các biện pháp an ninh mạng.', 'The rapid advancement of technology requires organizations to continuously upgrade their cybersecurity measures.', 'tatoeba_6', 85.00, '[{"text": "rapid advancement of technology", "kind": "COLLOCATION", "cue": "r...", "order": 1, "source": "CURATION"}]'::jsonb, '[]'::jsonb, 1, TRUE, '46a492d33288ac46d9a01f4a9f6c973b833c7c0530d9ce75ef377725d583a223', '79ab54175fc8f337f9c840f9fc4040c180be3ba676b295db64eaad7b9aeea4cc') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercises (id, source_id, import_batch_id, document_id, mode, source_vi, reference_en, source_record_id, topic_code, difficulty_bucket, cefr_band, quality_score, target_chunks_json, content_version, active, random_bucket, source_matching_hash, reference_matching_hash) VALUES ('04ad5c23-9b93-506d-9695-f3edc7c7f3dd', 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', NULL, 'SENTENCE', 'Chúng ta nên trồng nhiều cây hơn để bảo vệ hành tinh xanh.', 'We should plant more trees to protect our green planet.', 'tatoeba_7', 'ENVIRONMENT', 'FOUNDATION', 'A2', 85.00, '[{"text": "plant more trees", "kind": "COLLOCATION", "cue": "p...", "order": 1, "source": "CURATION"}]'::jsonb, 1, TRUE, 859, '75cc4b8d588a2fbd31b494b14baa41df4cf6190c9debda3d70c25e4afa9e7aaa', '1c0441fb9d34c6af700053f14200b621a832416e73749c1e27709d86567b2b07') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercise_units (id, exercise_id, ordinal, source_vi, reference_en, source_record_id, quality_score, target_chunks_json, accepted_variants_json, content_version, active, source_matching_hash, reference_matching_hash) VALUES ('a8d2b310-0e9e-503a-b6c7-19d0eb812084', '04ad5c23-9b93-506d-9695-f3edc7c7f3dd', 1, 'Chúng ta nên trồng nhiều cây hơn để bảo vệ hành tinh xanh.', 'We should plant more trees to protect our green planet.', 'tatoeba_7', 85.00, '[{"text": "plant more trees", "kind": "COLLOCATION", "cue": "p...", "order": 1, "source": "CURATION"}]'::jsonb, '[]'::jsonb, 1, TRUE, '75cc4b8d588a2fbd31b494b14baa41df4cf6190c9debda3d70c25e4afa9e7aaa', '1c0441fb9d34c6af700053f14200b621a832416e73749c1e27709d86567b2b07') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercises (id, source_id, import_batch_id, document_id, mode, source_vi, reference_en, source_record_id, topic_code, difficulty_bucket, cefr_band, quality_score, target_chunks_json, content_version, active, random_bucket, source_matching_hash, reference_matching_hash) VALUES ('3a0a111c-d4ab-55ba-afcb-c7a96bda4010', 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', NULL, 'SENTENCE', 'Năng lượng tái tạo là giải pháp thiết yếu để giảm thiểu lượng khí thải nhà kính.', 'Renewable energy is an essential solution to reduce greenhouse gas emissions.', 'tatoeba_8', 'ENVIRONMENT', 'CORE', 'B1', 85.00, '[{"text": "greenhouse gas emissions", "kind": "COLLOCATION", "cue": "g...", "order": 1, "source": "CURATION"}]'::jsonb, 1, TRUE, 221, '958fe50eca0ebe130a1e350c9b4ced591f247cd81bca42a1769c583a11c5781c', '129de168e8bb3e035e63a50427359ccba770804377363624b6682b903fa96bf0') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercise_units (id, exercise_id, ordinal, source_vi, reference_en, source_record_id, quality_score, target_chunks_json, accepted_variants_json, content_version, active, source_matching_hash, reference_matching_hash) VALUES ('d22351fb-bb38-5cb6-ac06-683805442fd1', '3a0a111c-d4ab-55ba-afcb-c7a96bda4010', 1, 'Năng lượng tái tạo là giải pháp thiết yếu để giảm thiểu lượng khí thải nhà kính.', 'Renewable energy is an essential solution to reduce greenhouse gas emissions.', 'tatoeba_8', 85.00, '[{"text": "greenhouse gas emissions", "kind": "COLLOCATION", "cue": "g...", "order": 1, "source": "CURATION"}]'::jsonb, '[]'::jsonb, 1, TRUE, '958fe50eca0ebe130a1e350c9b4ced591f247cd81bca42a1769c583a11c5781c', '129de168e8bb3e035e63a50427359ccba770804377363624b6682b903fa96bf0') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercises (id, source_id, import_batch_id, document_id, mode, source_vi, reference_en, source_record_id, topic_code, difficulty_bucket, cefr_band, quality_score, target_chunks_json, content_version, active, random_bucket, source_matching_hash, reference_matching_hash) VALUES ('74a89421-9870-58c5-9b1a-d58297bded59', 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', NULL, 'SENTENCE', 'Bảo vệ đa dạng sinh học đóng vai trò then chốt trong việc duy trì sự cân bằng của hệ sinh thái toàn cầu.', 'Preserving biodiversity plays a crucial role in maintaining the balance of global ecosystems.', 'tatoeba_9', 'ENVIRONMENT', 'CHALLENGE', 'C1', 85.00, '[{"text": "plays a crucial role in", "kind": "COLLOCATION", "cue": "p...", "order": 1, "source": "CURATION"}]'::jsonb, 1, TRUE, 719, 'd771fbae4aa52baf65a09f5d95ccdd2334059e1587446c73a1bab93d10b83f9c', '8dd72d2826f2f388bb37f51a5dae9e5bb6fbc855b632cb7b7fd963f0ca1e5527') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercise_units (id, exercise_id, ordinal, source_vi, reference_en, source_record_id, quality_score, target_chunks_json, accepted_variants_json, content_version, active, source_matching_hash, reference_matching_hash) VALUES ('aba6af75-ba2a-5171-94da-5f33f432b457', '74a89421-9870-58c5-9b1a-d58297bded59', 1, 'Bảo vệ đa dạng sinh học đóng vai trò then chốt trong việc duy trì sự cân bằng của hệ sinh thái toàn cầu.', 'Preserving biodiversity plays a crucial role in maintaining the balance of global ecosystems.', 'tatoeba_9', 85.00, '[{"text": "plays a crucial role in", "kind": "COLLOCATION", "cue": "p...", "order": 1, "source": "CURATION"}]'::jsonb, '[]'::jsonb, 1, TRUE, 'd771fbae4aa52baf65a09f5d95ccdd2334059e1587446c73a1bab93d10b83f9c', '8dd72d2826f2f388bb37f51a5dae9e5bb6fbc855b632cb7b7fd963f0ca1e5527') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercises (id, source_id, import_batch_id, document_id, mode, source_vi, reference_en, source_record_id, topic_code, difficulty_bucket, cefr_band, quality_score, target_chunks_json, content_version, active, random_bucket, source_matching_hash, reference_matching_hash) VALUES ('a119ad79-fa78-5286-8755-085c559c9a23', 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', NULL, 'SENTENCE', 'Uống đủ nước và ngủ đủ giấc rất tốt cho sức khỏe của bạn.', 'Drinking enough water and getting sufficient sleep is very good for your health.', 'tatoeba_10', 'HEALTH', 'FOUNDATION', 'A2', 85.00, '[{"text": "sufficient sleep", "kind": "COLLOCATION", "cue": "s...", "order": 1, "source": "CURATION"}]'::jsonb, 1, TRUE, 79, 'de5741b5932c35f366a3ee3584ce51f7d52eab06911b262087a660dabf290f53', 'e0541f438d37340d3a7c569ecdff0050b2c8abee661326c2ad17ad7acafcb6a4') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercise_units (id, exercise_id, ordinal, source_vi, reference_en, source_record_id, quality_score, target_chunks_json, accepted_variants_json, content_version, active, source_matching_hash, reference_matching_hash) VALUES ('a70e39d4-4bbe-577a-8aa5-e8be141be6ce', 'a119ad79-fa78-5286-8755-085c559c9a23', 1, 'Uống đủ nước và ngủ đủ giấc rất tốt cho sức khỏe của bạn.', 'Drinking enough water and getting sufficient sleep is very good for your health.', 'tatoeba_10', 85.00, '[{"text": "sufficient sleep", "kind": "COLLOCATION", "cue": "s...", "order": 1, "source": "CURATION"}]'::jsonb, '[]'::jsonb, 1, TRUE, 'de5741b5932c35f366a3ee3584ce51f7d52eab06911b262087a660dabf290f53', 'e0541f438d37340d3a7c569ecdff0050b2c8abee661326c2ad17ad7acafcb6a4') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercises (id, source_id, import_batch_id, document_id, mode, source_vi, reference_en, source_record_id, topic_code, difficulty_bucket, cefr_band, quality_score, target_chunks_json, content_version, active, random_bucket, source_matching_hash, reference_matching_hash) VALUES ('0abf60b8-bdde-5e67-b6c1-767afb3d3af4', 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', NULL, 'SENTENCE', 'Tập thể dục thường xuyên giúp ngăn ngừa nhiều căn bệnh nguy hiểm.', 'Regular physical exercise helps prevent many dangerous diseases.', 'tatoeba_11', 'HEALTH', 'CORE', 'B1', 85.00, '[{"text": "prevent many dangerous diseases", "kind": "COLLOCATION", "cue": "p...", "order": 1, "source": "CURATION"}]'::jsonb, 1, TRUE, 789, '158dcbd3dc9a29c6320c8220011197cce306ca362398661f7e6e244ceffd6012', '300f13ea75114e38aa2bcc79833e221f399c415fe1e6e9a1ab8e095489b4e648') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercise_units (id, exercise_id, ordinal, source_vi, reference_en, source_record_id, quality_score, target_chunks_json, accepted_variants_json, content_version, active, source_matching_hash, reference_matching_hash) VALUES ('11e93f94-cd7c-567f-8180-6050b3c792ef', '0abf60b8-bdde-5e67-b6c1-767afb3d3af4', 1, 'Tập thể dục thường xuyên giúp ngăn ngừa nhiều căn bệnh nguy hiểm.', 'Regular physical exercise helps prevent many dangerous diseases.', 'tatoeba_11', 85.00, '[{"text": "prevent many dangerous diseases", "kind": "COLLOCATION", "cue": "p...", "order": 1, "source": "CURATION"}]'::jsonb, '[]'::jsonb, 1, TRUE, '158dcbd3dc9a29c6320c8220011197cce306ca362398661f7e6e244ceffd6012', '300f13ea75114e38aa2bcc79833e221f399c415fe1e6e9a1ab8e095489b4e648') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercises (id, source_id, import_batch_id, document_id, mode, source_vi, reference_en, source_record_id, topic_code, difficulty_bucket, cefr_band, quality_score, target_chunks_json, content_version, active, random_bucket, source_matching_hash, reference_matching_hash) VALUES ('8ae09e34-624d-572c-b391-4e0c941de296', 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', NULL, 'SENTENCE', 'Chế độ ăn uống cân bằng kết hợp với lối sống lành mạnh làm giảm đáng kể nguy cơ mắc bệnh tim mạch.', 'A balanced diet combined with a healthy lifestyle significantly reduces the risk of cardiovascular disease.', 'tatoeba_12', 'HEALTH', 'CHALLENGE', 'C1', 85.00, '[{"text": "significantly reduces the risk of", "kind": "COLLOCATION", "cue": "s...", "order": 1, "source": "CURATION"}]'::jsonb, 1, TRUE, 839, '2ecee0bdea14ab84994dc3e38e4c4d094d62377021871a56d31a23beb8c659fa', '792abcfc6bb26db8af1d4deab106a8a81381cd3cdd15e4db64b4e12d5e236674') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercise_units (id, exercise_id, ordinal, source_vi, reference_en, source_record_id, quality_score, target_chunks_json, accepted_variants_json, content_version, active, source_matching_hash, reference_matching_hash) VALUES ('e29e99d5-9c1a-563e-bab5-7d6935d9eef3', '8ae09e34-624d-572c-b391-4e0c941de296', 1, 'Chế độ ăn uống cân bằng kết hợp với lối sống lành mạnh làm giảm đáng kể nguy cơ mắc bệnh tim mạch.', 'A balanced diet combined with a healthy lifestyle significantly reduces the risk of cardiovascular disease.', 'tatoeba_12', 85.00, '[{"text": "significantly reduces the risk of", "kind": "COLLOCATION", "cue": "s...", "order": 1, "source": "CURATION"}]'::jsonb, '[]'::jsonb, 1, TRUE, '2ecee0bdea14ab84994dc3e38e4c4d094d62377021871a56d31a23beb8c659fa', '792abcfc6bb26db8af1d4deab106a8a81381cd3cdd15e4db64b4e12d5e236674') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercises (id, source_id, import_batch_id, document_id, mode, source_vi, reference_en, source_record_id, topic_code, difficulty_bucket, cefr_band, quality_score, target_chunks_json, content_version, active, random_bucket, source_matching_hash, reference_matching_hash) VALUES ('7495db26-ba17-5bd2-a105-e3b77791a990', 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', NULL, 'SENTENCE', 'Cô ấy muốn tìm một công việc mới gần nhà hơn.', 'She wants to find a new job closer to her home.', 'tatoeba_13', 'WORK', 'FOUNDATION', 'A2', 85.00, '[{"text": "find a new job", "kind": "COLLOCATION", "cue": "f...", "order": 1, "source": "CURATION"}]'::jsonb, 1, TRUE, 311, '3bc91fd83633f02a868981573c5a3fc846c35ba021a12fb74c3b78e33d349f85', '878f52c34e8f4b3e8cefd510b3e16797677f714a42a125fea6e256a6be5289b9') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercise_units (id, exercise_id, ordinal, source_vi, reference_en, source_record_id, quality_score, target_chunks_json, accepted_variants_json, content_version, active, source_matching_hash, reference_matching_hash) VALUES ('89f7a855-0b99-5263-b1c2-8a16a6c22943', '7495db26-ba17-5bd2-a105-e3b77791a990', 1, 'Cô ấy muốn tìm một công việc mới gần nhà hơn.', 'She wants to find a new job closer to her home.', 'tatoeba_13', 85.00, '[{"text": "find a new job", "kind": "COLLOCATION", "cue": "f...", "order": 1, "source": "CURATION"}]'::jsonb, '[]'::jsonb, 1, TRUE, '3bc91fd83633f02a868981573c5a3fc846c35ba021a12fb74c3b78e33d349f85', '878f52c34e8f4b3e8cefd510b3e16797677f714a42a125fea6e256a6be5289b9') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercises (id, source_id, import_batch_id, document_id, mode, source_vi, reference_en, source_record_id, topic_code, difficulty_bucket, cefr_band, quality_score, target_chunks_json, content_version, active, random_bucket, source_matching_hash, reference_matching_hash) VALUES ('6ee441ae-93cb-524c-9670-43dedd5fb37f', 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', NULL, 'SENTENCE', 'Làm việc nhóm hiệu quả đòi hỏi sự tin tưởng và giao tiếp cởi mở giữa các thành viên.', 'Effective teamwork requires trust and open communication among team members.', 'tatoeba_14', 'WORK', 'CORE', 'B1', 85.00, '[{"text": "open communication", "kind": "COLLOCATION", "cue": "o...", "order": 1, "source": "CURATION"}]'::jsonb, 1, TRUE, 461, '010ac9a179ad5bb9b235e31ac77686259f99ddc9fed54aa287b0ee36f8d49336', 'e4b0ab02651c9fd5541ea4352dbba49ecc3e106764568b3167d769b614acf3b4') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercise_units (id, exercise_id, ordinal, source_vi, reference_en, source_record_id, quality_score, target_chunks_json, accepted_variants_json, content_version, active, source_matching_hash, reference_matching_hash) VALUES ('e5609f30-5a91-5531-addc-699e8fb381f0', '6ee441ae-93cb-524c-9670-43dedd5fb37f', 1, 'Làm việc nhóm hiệu quả đòi hỏi sự tin tưởng và giao tiếp cởi mở giữa các thành viên.', 'Effective teamwork requires trust and open communication among team members.', 'tatoeba_14', 85.00, '[{"text": "open communication", "kind": "COLLOCATION", "cue": "o...", "order": 1, "source": "CURATION"}]'::jsonb, '[]'::jsonb, 1, TRUE, '010ac9a179ad5bb9b235e31ac77686259f99ddc9fed54aa287b0ee36f8d49336', 'e4b0ab02651c9fd5541ea4352dbba49ecc3e106764568b3167d769b614acf3b4') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercises (id, source_id, import_batch_id, document_id, mode, source_vi, reference_en, source_record_id, topic_code, difficulty_bucket, cefr_band, quality_score, target_chunks_json, content_version, active, random_bucket, source_matching_hash, reference_matching_hash) VALUES ('1538053b-630a-5e80-a42b-07e3034ca5a7', 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', NULL, 'SENTENCE', 'Các nhà lãnh đạo phải chịu trách nhiệm tạo ra một môi trường làm việc hòa nhập và bình đẳng.', 'Leaders are responsible for creating an inclusive and equitable work environment.', 'tatoeba_15', 'WORK', 'CHALLENGE', 'C1', 85.00, '[{"text": "are responsible for", "kind": "COLLOCATION", "cue": "a...", "order": 1, "source": "CURATION"}]'::jsonb, 1, TRUE, 337, '3262a0006a348a3ff8c9856e4f269810164fb26a71846bbb3c3204dbfd0e45b0', '573fdd14f666447a254fa14f16ebf647d5c17af71067fbe53757aa47a52fe647') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercise_units (id, exercise_id, ordinal, source_vi, reference_en, source_record_id, quality_score, target_chunks_json, accepted_variants_json, content_version, active, source_matching_hash, reference_matching_hash) VALUES ('ed2f9791-08b4-5add-b0d9-2e6f5728f2ab', '1538053b-630a-5e80-a42b-07e3034ca5a7', 1, 'Các nhà lãnh đạo phải chịu trách nhiệm tạo ra một môi trường làm việc hòa nhập và bình đẳng.', 'Leaders are responsible for creating an inclusive and equitable work environment.', 'tatoeba_15', 85.00, '[{"text": "are responsible for", "kind": "COLLOCATION", "cue": "a...", "order": 1, "source": "CURATION"}]'::jsonb, '[]'::jsonb, 1, TRUE, '3262a0006a348a3ff8c9856e4f269810164fb26a71846bbb3c3204dbfd0e45b0', '573fdd14f666447a254fa14f16ebf647d5c17af71067fbe53757aa47a52fe647') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercises (id, source_id, import_batch_id, document_id, mode, source_vi, reference_en, source_record_id, topic_code, difficulty_bucket, cefr_band, quality_score, target_chunks_json, content_version, active, random_bucket, source_matching_hash, reference_matching_hash) VALUES ('1717a94e-1130-5267-a82b-ac08a93d7b7c', 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', NULL, 'SENTENCE', 'Học một ngôn ngữ mới mở ra nhiều cơ hội thú vị.', 'Learning a new language opens up many exciting opportunities.', 'tatoeba_16', 'GENERAL', 'FOUNDATION', 'A2', 85.00, '[{"text": "opens up many exciting opportunities", "kind": "COLLOCATION", "cue": "o...", "order": 1, "source": "CURATION"}]'::jsonb, 1, TRUE, 853, '2bac4b9881e7c19524c48cc6cade8ef1990ecdc82e5645d03786cc255ebdf871', 'e5e58428126506534f2b38dbc66c4ecacac755d4fc29435af94f5e914c881042') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercise_units (id, exercise_id, ordinal, source_vi, reference_en, source_record_id, quality_score, target_chunks_json, accepted_variants_json, content_version, active, source_matching_hash, reference_matching_hash) VALUES ('5bcfc324-3c55-5713-8dcb-0f9c830370e0', '1717a94e-1130-5267-a82b-ac08a93d7b7c', 1, 'Học một ngôn ngữ mới mở ra nhiều cơ hội thú vị.', 'Learning a new language opens up many exciting opportunities.', 'tatoeba_16', 85.00, '[{"text": "opens up many exciting opportunities", "kind": "COLLOCATION", "cue": "o...", "order": 1, "source": "CURATION"}]'::jsonb, '[]'::jsonb, 1, TRUE, '2bac4b9881e7c19524c48cc6cade8ef1990ecdc82e5645d03786cc255ebdf871', 'e5e58428126506534f2b38dbc66c4ecacac755d4fc29435af94f5e914c881042') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercises (id, source_id, import_batch_id, document_id, mode, source_vi, reference_en, source_record_id, topic_code, difficulty_bucket, cefr_band, quality_score, target_chunks_json, content_version, active, random_bucket, source_matching_hash, reference_matching_hash) VALUES ('c2aa08dd-c837-5d8b-9083-7cb89daf97bb', 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', NULL, 'SENTENCE', 'Thời gian và sự kiên trì là chìa khóa để đạt được bất kỳ mục tiêu dài hạn nào.', 'Time and persistence are the key to achieving any long-term goal.', 'tatoeba_17', 'GENERAL', 'CORE', 'B1', 85.00, '[{"text": "long-term goal", "kind": "COLLOCATION", "cue": "l...", "order": 1, "source": "CURATION"}]'::jsonb, 1, TRUE, 889, 'e9f7307e8d575081e7c314f538f7607182c1e67e57b6abc4ff88830d5d6fcb14', 'cebfa3305d0e9bd26d11ed02c54cac4c2f5cb72b50d80b22a4ca79ac941a6a46') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercise_units (id, exercise_id, ordinal, source_vi, reference_en, source_record_id, quality_score, target_chunks_json, accepted_variants_json, content_version, active, source_matching_hash, reference_matching_hash) VALUES ('601c9d1f-e3b9-53cf-a484-b19eb0696c6d', 'c2aa08dd-c837-5d8b-9083-7cb89daf97bb', 1, 'Thời gian và sự kiên trì là chìa khóa để đạt được bất kỳ mục tiêu dài hạn nào.', 'Time and persistence are the key to achieving any long-term goal.', 'tatoeba_17', 85.00, '[{"text": "long-term goal", "kind": "COLLOCATION", "cue": "l...", "order": 1, "source": "CURATION"}]'::jsonb, '[]'::jsonb, 1, TRUE, 'e9f7307e8d575081e7c314f538f7607182c1e67e57b6abc4ff88830d5d6fcb14', 'cebfa3305d0e9bd26d11ed02c54cac4c2f5cb72b50d80b22a4ca79ac941a6a46') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercises (id, source_id, import_batch_id, document_id, mode, source_vi, reference_en, source_record_id, topic_code, difficulty_bucket, cefr_band, quality_score, target_chunks_json, content_version, active, random_bucket, source_matching_hash, reference_matching_hash) VALUES ('988abf90-f5de-56ab-be27-117a2df539f1', 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', NULL, 'SENTENCE', 'Du lịch đến những vùng đất mới giúp mở rộng tầm nhìn và hiểu biết văn hóa.', 'Traveling to new places helps broaden horizons and cultural understanding.', 'tatoeba_18', 'TRAVEL', 'CORE', 'B1', 85.00, '[{"text": "broaden horizons", "kind": "COLLOCATION", "cue": "b...", "order": 1, "source": "CURATION"}]'::jsonb, 1, TRUE, 552, 'c47d24fc5b3fd9ccff093d9ae1b56923e43de630fef22e63bb0bbef3439e26b8', 'a115c95451db9ad0a13b76425710fd742c0ee651f8b3d41d75d0d556601c749e') ON CONFLICT DO NOTHING;
INSERT INTO public.translation_exercise_units (id, exercise_id, ordinal, source_vi, reference_en, source_record_id, quality_score, target_chunks_json, accepted_variants_json, content_version, active, source_matching_hash, reference_matching_hash) VALUES ('cc051281-6801-56d0-876a-a9ce93283cc0', '988abf90-f5de-56ab-be27-117a2df539f1', 1, 'Du lịch đến những vùng đất mới giúp mở rộng tầm nhìn và hiểu biết văn hóa.', 'Traveling to new places helps broaden horizons and cultural understanding.', 'tatoeba_18', 85.00, '[{"text": "broaden horizons", "kind": "COLLOCATION", "cue": "b...", "order": 1, "source": "CURATION"}]'::jsonb, '[]'::jsonb, 1, TRUE, 'c47d24fc5b3fd9ccff093d9ae1b56923e43de630fef22e63bb0bbef3439e26b8', 'a115c95451db9ad0a13b76425710fd742c0ee651f8b3d41d75d0d556601c749e') ON CONFLICT DO NOTHING;
