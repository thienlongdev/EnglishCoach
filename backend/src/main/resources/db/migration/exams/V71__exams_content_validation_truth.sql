-- V71: Exams Recovery Phase 2 — schema truth + persisted authoritative content validation.
--
-- 1. Schema drift (forensic audit EXAM-AUD-007): these columns are read by application code and already exist in
--    production, but no Flyway migration created them. ADD COLUMN IF NOT EXISTS makes Flyway their owner without
--    touching existing production columns or data (no-op where they exist; no backfill, no UPDATE).
--    Semantics since Phase 2: is_runnable / health_status / primary_health_status are restrict-only operator flags
--    (FALSE / DISABLED / NEEDS_REVIEW take content away); they never make content runnable — runnability comes only
--    from the authoritative validator (ExamContentValidationService).
-- 2. exams.form_content_validations: append-only validation results, one row per
--    (form, validator version, content fingerprint). Derived data — safe to recompute, never edited.
--
-- Version number: V70 is taken by the Game module (word_chain_results). Re-check the directory and production
-- flyway_schema_history before deploying; renumber if another migration lands first (never reuse a version).

ALTER TABLE exams.sections ADD COLUMN IF NOT EXISTS is_runnable BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE exams.sections ADD COLUMN IF NOT EXISTS health_status VARCHAR(32);
ALTER TABLE exams.form_versions ADD COLUMN IF NOT EXISTS primary_health_status VARCHAR(32);
ALTER TABLE exams.item_versions ADD COLUMN IF NOT EXISTS ordinal INTEGER;

CREATE TABLE IF NOT EXISTS exams.form_content_validations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    form_id UUID NOT NULL REFERENCES exams.form_versions(id) ON DELETE RESTRICT,
    validator_version VARCHAR(32) NOT NULL,
    content_fingerprint VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL CHECK (status IN ('VALID', 'NEEDS_REVIEW', 'INVALID')),
    full_simulation_eligible BOOLEAN NOT NULL,
    practice_skills JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(practice_skills) = 'array'),
    simulation_skills JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(simulation_skills) = 'array'),
    blocking_count INTEGER NOT NULL DEFAULT 0 CHECK (blocking_count >= 0),
    standard_count INTEGER NOT NULL DEFAULT 0 CHECK (standard_count >= 0),
    report JSONB NOT NULL CHECK (jsonb_typeof(report) = 'object'),
    trigger_source VARCHAR(32) NOT NULL,
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_form_content_validation UNIQUE (form_id, validator_version, content_fingerprint),
    CONSTRAINT ck_form_content_validation_full CHECK (NOT full_simulation_eligible OR status = 'VALID')
);

CREATE INDEX IF NOT EXISTS idx_form_content_validations_latest
    ON exams.form_content_validations (form_id, evaluated_at DESC);

COMMENT ON TABLE exams.form_content_validations IS
    'Exams Phase 2: append-only authoritative content validation results per (form, validator_version, content_fingerprint). Diagnostics carry codes/ids/counts only, never exam text.';
