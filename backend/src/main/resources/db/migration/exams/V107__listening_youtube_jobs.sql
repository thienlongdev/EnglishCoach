-- Durable coordination only. Heavy processing stays on the existing Windows GPU service.
CREATE TABLE public.listening_youtube_jobs (
    id uuid PRIMARY KEY,
    owner_user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    fingerprint varchar(64) NOT NULL,
    engine_id uuid NOT NULL UNIQUE,
    request_json text NOT NULL CHECK (length(request_json) <= 4096),
    status varchar(16) NOT NULL CHECK (status IN ('QUEUED','RUNNING','SAVING','READY','FAILED','CANCELLED')),
    stage varchar(32) NOT NULL,
    material_id bigint REFERENCES public.listening_materials(id) ON DELETE CASCADE,
    reservation_id bigint REFERENCES public.premium_ai_usage(id) ON DELETE RESTRICT,
    voucher_use_id bigint REFERENCES public.ai_voucher_use(id) ON DELETE RESTRICT,
    CHECK (reservation_id IS NULL OR voucher_use_id IS NULL),
    message varchar(500),
    transport_failures integer NOT NULL DEFAULT 0,
    cancel_ack boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(owner_user_id,fingerprint),
    CHECK ((status='READY') = (material_id IS NOT NULL))
);
CREATE UNIQUE INDEX uq_listening_youtube_active_owner ON public.listening_youtube_jobs(owner_user_id)
    WHERE status IN ('QUEUED','RUNNING','SAVING');
CREATE INDEX idx_listening_youtube_work ON public.listening_youtube_jobs(created_at)
    WHERE status IN ('QUEUED','RUNNING','SAVING') OR (status IN ('CANCELLED','FAILED') AND NOT cancel_ack);
CREATE INDEX idx_listening_youtube_owner ON public.listening_youtube_jobs(owner_user_id,created_at DESC);
