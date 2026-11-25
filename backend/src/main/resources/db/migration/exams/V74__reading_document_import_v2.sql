ALTER TABLE public.reading_materials
    ADD COLUMN IF NOT EXISTS document_schema_version VARCHAR(64),
    ADD COLUMN IF NOT EXISTS source_document_type VARCHAR(64),
    ADD COLUMN IF NOT EXISTS source_file_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS canonical_document JSONB;

COMMENT ON COLUMN public.reading_materials.canonical_document IS
    'Versioned CanonicalDocument JSON for new personal PDF/image imports; NULL for legacy/plain-text rows.';
