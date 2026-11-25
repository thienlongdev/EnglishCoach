-- V15__user_data_isolation_ownership.sql
-- P0 Data Isolation: Add ownership and system classification to Reading and Listening materials

-- 1. Reading Materials Ownership
ALTER TABLE public.reading_materials
    ADD COLUMN IF NOT EXISTS owner_user_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Listening Materials Ownership
ALTER TABLE public.listening_materials
    ADD COLUMN IF NOT EXISTS owner_user_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. Legacy Quarantine: Mark all existing unowned rows as quarantined (is_system = FALSE, owner_user_id = NULL)
UPDATE public.reading_materials
SET owner_user_id = NULL, is_system = FALSE
WHERE owner_user_id IS NULL AND is_system = FALSE;

UPDATE public.listening_materials
SET owner_user_id = NULL, is_system = FALSE
WHERE owner_user_id IS NULL AND is_system = FALSE;

-- 4. Scoping & Visibility Indexes
CREATE INDEX IF NOT EXISTS idx_reading_materials_owner
    ON public.reading_materials(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_reading_materials_visibility
    ON public.reading_materials(is_system, owner_user_id);

CREATE INDEX IF NOT EXISTS idx_listening_materials_owner
    ON public.listening_materials(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_listening_materials_visibility
    ON public.listening_materials(is_system, owner_user_id);
