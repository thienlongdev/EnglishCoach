-- ============================================================================
-- V1__content.sql
-- English Coach Exams — Content, specifications, rights, assets, review gates
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS exams;

-- 1. sources
CREATE TABLE IF NOT EXISTS exams.sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    owner VARCHAR(255),
    publisher VARCHAR(255),
    source_type VARCHAR(64) NOT NULL,
    reference_meta JSONB,
    retired_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_sources_code ON exams.sources(code);

-- 2. licenses
CREATE TABLE IF NOT EXISTS exams.licenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES exams.sources(id) ON DELETE RESTRICT,
    license_code VARCHAR(64) NOT NULL,
    provenance_category VARCHAR(64) NOT NULL CHECK (provenance_category IN ('ORIGINAL', 'LICENSED', 'FAIR_USE_REVIEWED', 'BENCHMARK_ONLY', 'UNKNOWN')),
    commercial_rights BOOLEAN NOT NULL DEFAULT FALSE,
    redistribution_rights BOOLEAN NOT NULL DEFAULT FALSE,
    derivative_rights BOOLEAN NOT NULL DEFAULT FALSE,
    permitted_purposes JSONB,
    permitted_territories JSONB,
    valid_from TIMESTAMPTZ,
    valid_until TIMESTAMPTZ,
    attribution TEXT,
    evidence_asset_id VARCHAR(255),
    legal_status VARCHAR(64) NOT NULL DEFAULT 'PENDING' CHECK (legal_status IN ('APPROVED', 'REJECTED', 'PENDING', 'EXPIRED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_license_source_code UNIQUE (source_id, license_code)
);
CREATE INDEX IF NOT EXISTS idx_licenses_source ON exams.licenses(source_id);
CREATE INDEX IF NOT EXISTS idx_licenses_legal_status ON exams.licenses(legal_status);

-- 3. provenance_records
CREATE TABLE IF NOT EXISTS exams.provenance_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES exams.sources(id) ON DELETE RESTRICT,
    license_id UUID REFERENCES exams.licenses(id) ON DELETE RESTRICT,
    creator VARCHAR(255) NOT NULL,
    acquisition_method VARCHAR(128) NOT NULL,
    original_reference TEXT,
    derivative_parent_id UUID REFERENCES exams.provenance_records(id) ON DELETE RESTRICT,
    ai_generation_meta JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_provenance_source ON exams.provenance_records(source_id);
CREATE INDEX IF NOT EXISTS idx_provenance_license ON exams.provenance_records(license_id);

-- 4. catalog_nodes
CREATE TABLE IF NOT EXISTS exams.catalog_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family VARCHAR(32) NOT NULL CHECK (family IN ('IELTS', 'TOEIC')),
    variant VARCHAR(64),
    source_id UUID REFERENCES exams.sources(id) ON DELETE RESTRICT,
    parent_id UUID REFERENCES exams.catalog_nodes(id) ON DELETE RESTRICT,
    kind VARCHAR(32) NOT NULL CHECK (kind IN ('COLLECTION', 'SERIES', 'VOLUME', 'CATEGORY')),
    title VARCHAR(255) NOT NULL,
    year INTEGER,
    ordinal INTEGER NOT NULL DEFAULT 0,
    retired_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_catalog_nodes_family ON exams.catalog_nodes(family, variant);
CREATE INDEX IF NOT EXISTS idx_catalog_nodes_parent ON exams.catalog_nodes(parent_id);

-- 5. specification_versions
CREATE TABLE IF NOT EXISTS exams.specification_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    logical_code VARCHAR(64) NOT NULL,
    version INTEGER NOT NULL,
    family VARCHAR(32) NOT NULL CHECK (family IN ('IELTS', 'TOEIC')),
    variant VARCHAR(64) NOT NULL,
    delivery_mode VARCHAR(32) NOT NULL,
    blueprint JSONB NOT NULL,
    timing_policy JSONB NOT NULL,
    navigation_policy JSONB NOT NULL,
    playback_policy JSONB NOT NULL,
    source_references JSONB,
    content_hash VARCHAR(64) NOT NULL,
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_spec_logical_version UNIQUE (logical_code, version)
);
CREATE INDEX IF NOT EXISTS idx_spec_family_variant ON exams.specification_versions(family, variant);

-- 6. rubric_versions
CREATE TABLE IF NOT EXISTS exams.rubric_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    logical_code VARCHAR(64) NOT NULL,
    version INTEGER NOT NULL,
    family VARCHAR(32) NOT NULL CHECK (family IN ('IELTS', 'TOEIC')),
    skill VARCHAR(32) NOT NULL CHECK (skill IN ('LISTENING', 'READING', 'WRITING', 'SPEAKING')),
    task_family VARCHAR(64),
    criteria JSONB NOT NULL,
    ordinal_scale JSONB NOT NULL,
    provenance_id UUID REFERENCES exams.provenance_records(id) ON DELETE RESTRICT,
    content_hash VARCHAR(64) NOT NULL,
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_rubric_logical_version UNIQUE (logical_code, version)
);
CREATE INDEX IF NOT EXISTS idx_rubric_family_skill ON exams.rubric_versions(family, skill);

-- 7. calibration_versions
CREATE TABLE IF NOT EXISTS exams.calibration_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    logical_code VARCHAR(64) NOT NULL,
    version INTEGER NOT NULL,
    method VARCHAR(64) NOT NULL,
    maturity_stage VARCHAR(64) NOT NULL,
    population_desc TEXT,
    sample_meta JSONB,
    comparison_group VARCHAR(128),
    validation_report TEXT,
    uncertainty_model JSONB,
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_calib_logical_version UNIQUE (logical_code, version)
);

-- 8. scoring_scheme_versions
CREATE TABLE IF NOT EXISTS exams.scoring_scheme_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    logical_code VARCHAR(64) NOT NULL,
    version INTEGER NOT NULL,
    family VARCHAR(32) NOT NULL CHECK (family IN ('IELTS', 'TOEIC')),
    variant VARCHAR(64) NOT NULL,
    scope VARCHAR(32) NOT NULL,
    normalization_version VARCHAR(32) NOT NULL,
    rubric_references JSONB,
    calibration_id UUID REFERENCES exams.calibration_versions(id) ON DELETE RESTRICT,
    mapping_table JSONB NOT NULL,
    aggregation_rules JSONB NOT NULL,
    content_hash VARCHAR(64) NOT NULL,
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_scheme_logical_version UNIQUE (logical_code, version)
);
CREATE INDEX IF NOT EXISTS idx_scheme_family_scope ON exams.scoring_scheme_versions(family, scope);

-- 9. form_versions
CREATE TABLE IF NOT EXISTS exams.form_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    logical_key VARCHAR(64) NOT NULL,
    version INTEGER NOT NULL,
    title VARCHAR(255) NOT NULL,
    family VARCHAR(32) NOT NULL CHECK (family IN ('IELTS', 'TOEIC')),
    variant VARCHAR(64) NOT NULL,
    scope VARCHAR(32) NOT NULL,
    catalog_node_id UUID REFERENCES exams.catalog_nodes(id) ON DELETE RESTRICT,
    specification_id UUID NOT NULL REFERENCES exams.specification_versions(id) ON DELETE RESTRICT,
    scoring_scheme_id UUID NOT NULL REFERENCES exams.scoring_scheme_versions(id) ON DELETE RESTRICT,
    lifecycle_state VARCHAR(32) NOT NULL DEFAULT 'DRAFT' CHECK (lifecycle_state IN ('DRAFT', 'CONTENT_QA', 'ANSWER_QA', 'LEGAL_QA', 'PILOT', 'CALIBRATED', 'PUBLISHED', 'RETIRED')),
    provenance_id UUID REFERENCES exams.provenance_records(id) ON DELETE RESTRICT,
    author_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    content_hash VARCHAR(64) NOT NULL,
    published_at TIMESTAMPTZ,
    retired_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_form_logical_version UNIQUE (logical_key, version)
);
CREATE INDEX IF NOT EXISTS idx_forms_catalog ON exams.form_versions(family, variant, scope, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_forms_node ON exams.form_versions(catalog_node_id);

-- 10. form_components
CREATE TABLE IF NOT EXISTS exams.form_components (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_form_id UUID NOT NULL REFERENCES exams.form_versions(id) ON DELETE RESTRICT,
    child_form_id UUID NOT NULL REFERENCES exams.form_versions(id) ON DELETE RESTRICT,
    role VARCHAR(32) NOT NULL CHECK (role IN ('LR', 'SPEAKING', 'WRITING')),
    ordinal INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT uq_parent_role UNIQUE (parent_form_id, role)
);
CREATE INDEX IF NOT EXISTS idx_form_components_child ON exams.form_components(child_form_id);

-- 11. sections
CREATE TABLE IF NOT EXISTS exams.sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    form_id UUID NOT NULL REFERENCES exams.form_versions(id) ON DELETE RESTRICT,
    skill VARCHAR(32) NOT NULL CHECK (skill IN ('LISTENING', 'READING', 'WRITING', 'SPEAKING')),
    ordinal INTEGER NOT NULL,
    spec_section_key VARCHAR(64) NOT NULL,
    scoring_scheme_id UUID REFERENCES exams.scoring_scheme_versions(id) ON DELETE RESTRICT,
    duration_seconds INTEGER NOT NULL,
    timing_policy JSONB,
    CONSTRAINT uq_section_form_ordinal UNIQUE (form_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_sections_form ON exams.sections(form_id);

-- 12. parts
CREATE TABLE IF NOT EXISTS exams.parts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    section_id UUID NOT NULL REFERENCES exams.sections(id) ON DELETE RESTRICT,
    part_code VARCHAR(32) NOT NULL,
    ordinal INTEGER NOT NULL,
    instructions TEXT,
    timing_policy JSONB,
    CONSTRAINT uq_part_section_ordinal UNIQUE (section_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_parts_section ON exams.parts(section_id);

-- 13. group_versions
CREATE TABLE IF NOT EXISTS exams.group_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    logical_group_key VARCHAR(64) NOT NULL,
    version INTEGER NOT NULL,
    question_type VARCHAR(64) NOT NULL,
    construct VARCHAR(128),
    skill VARCHAR(32) NOT NULL CHECK (skill IN ('LISTENING', 'READING', 'WRITING', 'SPEAKING')),
    topic VARCHAR(128),
    difficulty_estimate NUMERIC(4,2),
    provenance_id UUID REFERENCES exams.provenance_records(id) ON DELETE RESTRICT,
    content_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_group_logical_version UNIQUE (logical_group_key, version)
);
CREATE INDEX IF NOT EXISTS idx_groups_key ON exams.group_versions(logical_group_key);

-- 14. stimulus_versions
CREATE TABLE IF NOT EXISTS exams.stimulus_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    logical_stimulus_key VARCHAR(64) NOT NULL,
    version INTEGER NOT NULL,
    kind VARCHAR(32) NOT NULL CHECK (kind IN ('TEXT', 'IMAGE', 'AUDIO', 'CHART', 'MAP', 'MULTI_DOC')),
    title VARCHAR(255),
    body_payload JSONB NOT NULL,
    provenance_id UUID REFERENCES exams.provenance_records(id) ON DELETE RESTRICT,
    content_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_stimulus_logical_version UNIQUE (logical_stimulus_key, version)
);

-- 15. group_stimuli
CREATE TABLE IF NOT EXISTS exams.group_stimuli (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES exams.group_versions(id) ON DELETE RESTRICT,
    stimulus_id UUID NOT NULL REFERENCES exams.stimulus_versions(id) ON DELETE RESTRICT,
    role VARCHAR(32) NOT NULL DEFAULT 'PRIMARY',
    ordinal INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT uq_group_stimulus_role_ord UNIQUE (group_id, role, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_group_stimuli_group ON exams.group_stimuli(group_id);

-- 16. item_versions
CREATE TABLE IF NOT EXISTS exams.item_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES exams.group_versions(id) ON DELETE RESTRICT,
    logical_item_key VARCHAR(64) NOT NULL,
    version INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    interaction_type VARCHAR(64) NOT NULL,
    option_definitions JSONB,
    construct VARCHAR(128),
    provenance_id UUID REFERENCES exams.provenance_records(id) ON DELETE RESTRICT,
    content_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_item_logical_version UNIQUE (logical_item_key, version)
);
CREATE INDEX IF NOT EXISTS idx_items_group ON exams.item_versions(group_id);
CREATE INDEX IF NOT EXISTS idx_items_logical_key ON exams.item_versions(logical_item_key);

-- 17. form_groups
CREATE TABLE IF NOT EXISTS exams.form_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    part_id UUID NOT NULL REFERENCES exams.parts(id) ON DELETE RESTRICT,
    group_id UUID NOT NULL REFERENCES exams.group_versions(id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL,
    display_numbering VARCHAR(32),
    CONSTRAINT uq_form_group_part_ord UNIQUE (part_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_form_groups_part ON exams.form_groups(part_id);

-- 18. answer_specs
CREATE TABLE IF NOT EXISTS exams.answer_specs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id UUID NOT NULL REFERENCES exams.item_versions(id) ON DELETE RESTRICT,
    accepted_answers JSONB NOT NULL,
    normalization_policy JSONB NOT NULL,
    cardinality INTEGER NOT NULL DEFAULT 1,
    word_limit INTEGER,
    credit_units NUMERIC(4,2) NOT NULL DEFAULT 1.0,
    explanation TEXT,
    rubric_id UUID REFERENCES exams.rubric_versions(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_answer_spec_item UNIQUE (item_id)
);
CREATE INDEX IF NOT EXISTS idx_answer_specs_item ON exams.answer_specs(item_id);

-- 19. assets
CREATE TABLE IF NOT EXISTS exams.assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provenance_id UUID REFERENCES exams.provenance_records(id) ON DELETE RESTRICT,
    object_key VARCHAR(512) NOT NULL,
    version_id VARCHAR(128),
    sha256_hash VARCHAR(64) NOT NULL,
    mime_type VARCHAR(128) NOT NULL,
    byte_size BIGINT NOT NULL,
    duration_ms INTEGER,
    dimensions VARCHAR(32),
    validation_state VARCHAR(32) NOT NULL DEFAULT 'VALIDATED' CHECK (validation_state IN ('PENDING', 'VALIDATED', 'INVALID')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_asset_object_version UNIQUE (object_key, version_id)
);
CREATE INDEX IF NOT EXISTS idx_assets_hash ON exams.assets(sha256_hash);

-- 20. stimulus_assets
CREATE TABLE IF NOT EXISTS exams.stimulus_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stimulus_id UUID NOT NULL REFERENCES exams.stimulus_versions(id) ON DELETE RESTRICT,
    asset_id UUID NOT NULL REFERENCES exams.assets(id) ON DELETE RESTRICT,
    role VARCHAR(32) NOT NULL CHECK (role IN ('VISIBLE_MEDIA', 'TRANSCRIPT', 'REVIEW_ONLY', 'AUDIO_PROMPT')),
    ordinal INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT uq_stimulus_asset_ord UNIQUE (stimulus_id, role, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_stimulus_assets_stimulus ON exams.stimulus_assets(stimulus_id);

-- 21. content_reviews
CREATE TABLE IF NOT EXISTS exams.content_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    form_id UUID NOT NULL REFERENCES exams.form_versions(id) ON DELETE RESTRICT,
    gate VARCHAR(32) NOT NULL CHECK (gate IN ('CONTENT_QA', 'ANSWER_QA', 'LEGAL_QA')),
    reviewer_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    decision VARCHAR(32) NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
    reviewed_closure_hash VARCHAR(64) NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_content_reviews_form ON exams.content_reviews(form_id, gate);
