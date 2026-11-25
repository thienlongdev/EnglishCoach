-- ============================================================================
-- V5__content_factory.sql
-- English Coach Exams — versioned package import and deterministic QA ledger
-- ============================================================================

-- A package ledger is the idempotency boundary for authoring imports.  It is
-- deliberately separate from form_versions so a retry can be answered without
-- mutating a previously imported content graph.
CREATE TABLE IF NOT EXISTS exams.content_package_imports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    package_id VARCHAR(128) NOT NULL,
    package_version INTEGER NOT NULL CHECK (package_version > 0),
    schema_version VARCHAR(32) NOT NULL,
    content_hash VARCHAR(64) NOT NULL CHECK (content_hash ~ '^[0-9a-fA-F]{64}$'),
    form_id UUID NOT NULL REFERENCES exams.form_versions(id) ON DELETE RESTRICT,
    status VARCHAR(32) NOT NULL CHECK (status IN ('IMPORTING', 'IMPORTED', 'REJECTED')),
    imported_by BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    creator VARCHAR(255) NOT NULL,
    validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT uq_content_package_identity UNIQUE (package_id, package_version)
);
CREATE INDEX IF NOT EXISTS idx_content_package_form ON exams.content_package_imports(form_id);
CREATE INDEX IF NOT EXISTS idx_content_package_hash ON exams.content_package_imports(content_hash);

-- Machine QA is retained as an audit record.  Human gates remain the existing
-- append-only exams.content_reviews table and cannot be replaced by this row.
CREATE TABLE IF NOT EXISTS exams.content_qa_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    package_import_id UUID NOT NULL REFERENCES exams.content_package_imports(id) ON DELETE RESTRICT,
    form_id UUID NOT NULL REFERENCES exams.form_versions(id) ON DELETE RESTRICT,
    checklist_version VARCHAR(64) NOT NULL,
    result VARCHAR(32) NOT NULL CHECK (result IN ('PASS', 'FAIL')),
    findings JSONB NOT NULL DEFAULT '{}'::jsonb,
    actor_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_content_qa_form ON exams.content_qa_runs(form_id, created_at DESC);

