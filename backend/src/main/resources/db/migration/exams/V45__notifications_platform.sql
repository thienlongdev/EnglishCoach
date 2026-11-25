-- V45__notifications_platform.sql
-- Real-time system notification platform: category, sender, dedupe_key, is_read, read_at, user_id

ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS category VARCHAR(32) NOT NULL DEFAULT 'SYSTEM';
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS sender VARCHAR(64) NOT NULL DEFAULT 'EnglishCoach Hệ thống';
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS dedupe_key VARCHAR(128) NULL;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ NULL;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS user_id BIGINT NULL REFERENCES public.users(id) ON DELETE RESTRICT;

-- Backfill user_id from target_user_id for existing USER rows
UPDATE public.notifications
SET user_id = target_user_id
WHERE user_id IS NULL AND target_user_id IS NOT NULL;

-- Backfill is_read and read_at from notification_user_states for existing rows
UPDATE public.notifications n
SET is_read = TRUE,
    read_at = s.read_at
FROM public.notification_user_states s
WHERE s.notification_id = n.id
  AND s.read_at IS NOT NULL
  AND n.is_read = FALSE;

-- Indexes: (user_id, is_read, created_at DESC)
CREATE INDEX IF NOT EXISTS idx_notifications_user_is_read_created
    ON public.notifications(user_id, is_read, created_at DESC);

-- UNIQUE partial index on (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_user_dedupe_key
    ON public.notifications(user_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;
