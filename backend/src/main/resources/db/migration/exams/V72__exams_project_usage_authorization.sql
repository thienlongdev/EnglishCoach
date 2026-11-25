-- Exams Recovery Phase 4D.4 / 4D.5 (2026-10-03) — LOCAL ONLY, NOT applied to production.
-- VERSION NUMBER MUST BE RE-VALIDATED before any deployment: re-check this directory and production
-- exams.flyway_schema_history (V70 = Game word_chain_results, V71 = exams validation truth; prod history also
-- holds V61 — never reuse a number).
--
-- Keeps two different rights facts apart:
--   * exams.licenses (unchanged)            = PUBLISHER licence truth (raw corpus: provenance UNKNOWN, legal PENDING);
--   * exams.project_usage_authorizations     = the EnglishCoach OWNER's project-use authorization of the repository
--                                              source corpus, recorded per imported package. It never claims a
--                                              publisher licence or endorsement (CHECKs below).
-- Source identity (publisher / collection / book / test / raw SHA-256) and source provenance are stored here verbatim
-- and are immutable; the learner-facing display name lives in form_versions.title / catalog_nodes.title and may be
-- renamed later without touching provenance. Append-only: corrections are new rows for a new package version.

CREATE TABLE IF NOT EXISTS exams.project_usage_authorizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    package_id VARCHAR(128) NOT NULL,
    package_version INTEGER NOT NULL CHECK (package_version > 0),
    package_content_hash VARCHAR(64) NOT NULL CHECK (package_content_hash ~ '^[0-9a-fA-F]{64}$'),
    form_id UUID NOT NULL REFERENCES exams.form_versions(id) ON DELETE RESTRICT,
    source_id UUID NOT NULL REFERENCES exams.sources(id) ON DELETE RESTRICT,
    status VARCHAR(32) NOT NULL CHECK (status = 'OWNER_AUTHORIZED'),
    scope VARCHAR(64) NOT NULL,
    authorized_by VARCHAR(64) NOT NULL,
    decision_date DATE NOT NULL,
    decision_ref VARCHAR(128),
    applies_to VARCHAR(64),
    permits JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(permits) = 'array'),
    production_import VARCHAR(48) NOT NULL,
    import_basis VARCHAR(48) NOT NULL CHECK (import_basis IN ('OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN')),
    publisher_licence VARCHAR(32) NOT NULL CHECK (publisher_licence IN ('NOT_ESTABLISHED', 'UNKNOWN')),
    publisher_endorsement BOOLEAN NOT NULL DEFAULT FALSE CHECK (publisher_endorsement = FALSE),
    source_identity JSONB NOT NULL CHECK (jsonb_typeof(source_identity) = 'object'),
    source_provenance JSONB NOT NULL CHECK (jsonb_typeof(source_provenance) = 'object'),
    display_name_at_import VARCHAR(255),
    recorded_by BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_project_usage_authorization_package UNIQUE (package_id, package_version)
);

CREATE INDEX IF NOT EXISTS idx_project_usage_authorizations_form ON exams.project_usage_authorizations (form_id);

CREATE OR REPLACE FUNCTION exams.reject_project_usage_authorization_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'exams.project_usage_authorizations is append-only (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_project_usage_authorizations_append_only ON exams.project_usage_authorizations;
CREATE TRIGGER trg_project_usage_authorizations_append_only
    BEFORE UPDATE OR DELETE ON exams.project_usage_authorizations
    FOR EACH ROW EXECUTE FUNCTION exams.reject_project_usage_authorization_change();

COMMENT ON TABLE exams.project_usage_authorizations IS
    'Exams Phase 4: owner project-use authorization per imported package (separate from exams.licenses publisher truth; never a publisher licence or endorsement). Append-only. import_basis is local dry-run only until a reviewed production decision adds a value.';
