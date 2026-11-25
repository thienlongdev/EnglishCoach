-- ended_at remains the historical completion timestamp. Early exits are prospective.
ALTER TABLE public.listening_sessions ADD COLUMN closed_early_at timestamp;
ALTER TABLE public.listening_sessions ADD CONSTRAINT listening_session_single_end
    CHECK (ended_at IS NULL OR closed_early_at IS NULL);
