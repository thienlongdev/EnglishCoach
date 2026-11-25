-- Server-recorded Reading completion. Until now nothing on the server wrote user_reading_progress: "Hoàn thành bài
-- đọc" lived only in the browser, so no server module (Learning Path, heatmap, frames) could ever see a finished
-- reading. Additive only: two nullable columns and indexes on an existing table (0 rows in production 2026-10-17).
-- opened_at  = start of the current reading session, recorded by the server when the reader opens the material
-- completed_at = server time the learner finished it (written once, after a server-checked minimum reading time)
ALTER TABLE public.user_reading_progress
    ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ NULL;

-- one progress row per learner and material (the writer upserts on it)
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_reading_progress_user_material
    ON public.user_reading_progress (user_id, reading_material_id);

-- completion evidence lookups (Learning Path, content exclusion)
CREATE INDEX IF NOT EXISTS idx_user_reading_progress_user_completed
    ON public.user_reading_progress (user_id, completed_at) WHERE completed_at IS NOT NULL;
