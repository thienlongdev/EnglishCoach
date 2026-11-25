-- V34__user_profile_heatmap_theme_and_learning_events.sql
-- Add heatmap_theme to user_profiles and create learning_activity_events for Phase B

ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS heatmap_theme VARCHAR(32) NOT NULL DEFAULT 'purple';

CREATE TABLE IF NOT EXISTS public.learning_activity_events (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    activity_type VARCHAR(64) NOT NULL,
    source_ref VARCHAR(128) NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_learning_activity_event UNIQUE (user_id, activity_type, source_ref)
);

CREATE INDEX IF NOT EXISTS idx_learning_activity_events_user_time 
    ON public.learning_activity_events(user_id, occurred_at);

-- Bounded performance indexes for user progress queries
CREATE INDEX IF NOT EXISTS idx_listening_sessions_user_ended 
    ON listening_sessions(user_id, ended_at) 
    WHERE ended_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_writing_submissions_user_created 
    ON writing_submissions(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_speaking_shadowing_attempts_user_created 
    ON speaking_shadowing_attempts(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_user_reading_progress_user_read 
    ON user_reading_progress(user_id, last_read_at) 
    WHERE scroll_percentage >= 80 AND last_read_at IS NOT NULL;
