-- Owner decision 2026-10-06: existing TOEIC/IELTS corpus may be imported, published and used in production.
-- Publisher licence/provenance rows remain unchanged. Existing local authorizations are never upgraded.
-- Application checks the immutable owner decision and pinned source hashes before recording this basis.
ALTER TABLE exams.project_usage_authorizations
    DROP CONSTRAINT IF EXISTS project_usage_authorizations_import_basis_check;
ALTER TABLE exams.project_usage_authorizations
    ADD CONSTRAINT project_usage_authorizations_import_basis_check
    CHECK (import_basis IN ('OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN', 'OWNER_AUTHORIZED_PRODUCTION_USE'));
ALTER TABLE exams.project_usage_authorizations
    ADD CONSTRAINT project_usage_authorizations_production_decision_check
    CHECK (import_basis <> 'OWNER_AUTHORIZED_PRODUCTION_USE' OR (
        production_import = 'OWNER_AUTHORIZED_PRODUCTION_USE'
        AND authorized_by = 'PROJECT_OWNER'
        AND decision_ref = 'EXAMS_CORPUS_OWNER_PRODUCTION_AUTHORIZATION_20261006'
        AND decision_date = DATE '2026-10-06'
        AND permits @> '["PRODUCTION_IMPORT", "PUBLICATION", "LEARNER_RUNTIME", "MEDIA", "SCORING", "RESULTS", "REVIEW"]'::jsonb
        AND publisher_endorsement = FALSE));
COMMENT ON TABLE exams.project_usage_authorizations IS
    'Append-only project-owner authorization, separate from publisher licence truth. LOCAL staging or hash-pinned OWNER_AUTHORIZED_PRODUCTION_USE decision 2026-10-06; no content/QA approval implied.';
