-- Additive, lazily populated. Existing materials, segments, attempts and sessions remain intact.
CREATE TABLE IF NOT EXISTS public.listening_checkpoints (
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    material_id BIGINT NOT NULL REFERENCES public.listening_materials(id) ON DELETE CASCADE,
    content_version VARCHAR(64) NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0 CHECK(revision >= 0),
    state JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(state)='object' AND octet_length(state::text)<=1500000),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id,material_id,content_version)
);
CREATE TABLE IF NOT EXISTS public.listening_translation_cache (
    material_id BIGINT NOT NULL REFERENCES public.listening_materials(id) ON DELETE CASCADE,
    content_version VARCHAR(64) NOT NULL,
    translator_version VARCHAR(200) NOT NULL,
    translations JSONB NOT NULL CHECK(jsonb_typeof(translations)='object'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(material_id,content_version,translator_version)
);
-- V94's default privileges grant rows-only access to new public tables; no runtime DDL.
