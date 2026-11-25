-- Echo Background Studio — per-learner custom background theme preferences and saved theme library.
-- Additive only: no existing table, row, index, or rule changes.
--
-- One row per authenticated learner (`user_id` PRIMARY KEY, ON DELETE RESTRICT per AGENTS §21).
-- `state` holds the strictly allowlisted JSONB document validated and re-serialized by BackgroundPreferenceValidator
-- (activeSource, activeThemeId, activeConfig, favoritePresetIds, customThemes <= 40). Application cap is 240 KB,
-- comfortably inside the 256 KB (262,144 bytes) database CHECK constraint.
-- Inherits V94 `english_coach_runtime` default privileges cleanly (no runtime DDL).
CREATE TABLE IF NOT EXISTS public.user_background_preferences (
    user_id        BIGINT       PRIMARY KEY REFERENCES public.users (id) ON DELETE RESTRICT,
    schema_version SMALLINT     NOT NULL DEFAULT 1 CHECK (schema_version >= 1 AND schema_version <= 10),
    revision       BIGINT       NOT NULL DEFAULT 1 CHECK (revision >= 1),
    state          JSONB        NOT NULL CHECK (jsonb_typeof(state) = 'object' AND octet_length(state::text) <= 262144),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
