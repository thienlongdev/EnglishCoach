-- V93: session list for learners and administrators (security closure, 2026-10). Additive only.
-- A coarse, human-readable device label ("Chrome · Windows") derived on the server from the browser's User-Agent the
-- first time the session is used. Never the raw User-Agent and never an address. A backend that does not know this
-- column keeps working (rollback of the application needs no rollback of this migration).
-- (Listing a user's sessions uses the existing index idx_auth_sessions_user_state.)
ALTER TABLE public.auth_sessions ADD COLUMN IF NOT EXISTS device_label VARCHAR(80);
