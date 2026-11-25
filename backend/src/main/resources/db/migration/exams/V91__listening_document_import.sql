-- Additive: existing videos and learning records retain their identities.
ALTER TABLE public.listening_materials ADD COLUMN IF NOT EXISTS source_type VARCHAR(16) NOT NULL DEFAULT 'VIDEO';
ALTER TABLE public.listening_materials ADD COLUMN IF NOT EXISTS voice_id VARCHAR(16);
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_listening_document_owner' AND conrelid='public.listening_materials'::regclass) THEN
ALTER TABLE public.listening_materials ADD CONSTRAINT ck_listening_document_owner
    CHECK (source_type IN ('VIDEO', 'DOCUMENT') AND (source_type <> 'DOCUMENT'
      OR (owner_user_id IS NOT NULL AND is_system = FALSE AND youtube_video_id IS NULL
          AND voice_id IS NOT NULL AND voice_id IN ('us_male','us_female','uk_male','uk_female'))));
END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.listening_document_jobs (
    id UUID PRIMARY KEY,
    owner_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    fingerprint VARCHAR(64) NOT NULL,
    title VARCHAR(200) NOT NULL,
    confirmed_text TEXT NOT NULL CHECK (length(confirmed_text) BETWEEN 1 AND 3000),
    voice_id VARCHAR(16) NOT NULL CHECK (voice_id IN ('us_male','us_female','uk_male','uk_female')),
    status VARCHAR(16) NOT NULL CHECK (status IN ('QUEUED','RUNNING','READY','FAILED')),
    reservation_id BIGINT REFERENCES public.premium_ai_usage(id) ON DELETE RESTRICT,
    material_id BIGINT UNIQUE REFERENCES public.listening_materials(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner_user_id, fingerprint),
    CHECK ((status = 'READY') = (material_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_listening_document_queue ON public.listening_document_jobs(created_at) WHERE status = 'QUEUED';
CREATE UNIQUE INDEX IF NOT EXISTS ux_listening_document_owner_active ON public.listening_document_jobs(owner_user_id)
    WHERE status IN ('QUEUED','RUNNING');

INSERT INTO public.premium_feature_definitions
    (feature_key,display_name,description,premium_required,free_trial_limit,premium_monthly_limit,enabled,sort_order)
VALUES ('LISTENING_DOCUMENT_IMPORT','Tạo bài nghe từ tài liệu','Tạo bài nghe cá nhân từ đoạn văn đã kiểm tra',true,5,30,true,12)
ON CONFLICT (feature_key) DO NOTHING;
