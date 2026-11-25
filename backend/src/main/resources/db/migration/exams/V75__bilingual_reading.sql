CREATE TABLE IF NOT EXISTS public.bilingual_reading_materials (
    id BIGSERIAL PRIMARY KEY,
    content_type VARCHAR(20) NOT NULL CHECK (content_type IN ('ARTICLE', 'STORY')),
    title_en TEXT NOT NULL,
    title_vi TEXT,
    difficulty_level VARCHAR(20),
    word_count INTEGER NOT NULL CHECK (word_count >= 0),
    estimated_minutes INTEGER NOT NULL CHECK (estimated_minutes >= 1),
    source_file VARCHAR(255) NOT NULL,
    source_hash CHAR(64) NOT NULL,
    logical_position INTEGER NOT NULL CHECK (logical_position >= 1),
    item_fingerprint CHAR(64) NOT NULL UNIQUE,
    is_system BOOLEAN NOT NULL DEFAULT TRUE,
    owner_user_id BIGINT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT bilingual_reading_system_owner_ck CHECK (is_system = TRUE AND owner_user_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_bilingual_reading_type_position
    ON public.bilingual_reading_materials(content_type, logical_position);

CREATE TABLE IF NOT EXISTS public.bilingual_reading_segments (
    id BIGSERIAL PRIMARY KEY,
    material_id BIGINT NOT NULL REFERENCES public.bilingual_reading_materials(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 1),
    text_en TEXT NOT NULL,
    text_vi TEXT NOT NULL,
    source_reference VARCHAR(255),
    UNIQUE(material_id, position)
);

CREATE INDEX IF NOT EXISTS idx_bilingual_reading_segments_material
    ON public.bilingual_reading_segments(material_id, position);
