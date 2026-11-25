-- V140: Speaking shadowing receipt expiry/consumption hardening, audio SHA-256 provenance,
-- and missing lookup indexes on speaking_shadowing_attempts & speaking_sessions.
-- Strictly additive & rollback-safe for PostgreSQL 17. Legacy pre-V140 receipt rows
-- may have expires_at IS NULL; newly issued receipts enforce 30-minute TTL and single-use consumption.

SET LOCAL lock_timeout = '5s';

-- 1. Receipt lifecycle & engine provenance columns on public.shadowing_analysis_receipts
ALTER TABLE public.shadowing_analysis_receipts
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE public.shadowing_analysis_receipts
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE public.shadowing_analysis_receipts
    ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;

ALTER TABLE public.shadowing_analysis_receipts
    ADD COLUMN IF NOT EXISTS engine_version VARCHAR(128);

-- 2. Audio SHA-256 provenance column on public.speaking_shadowing_attempts
ALTER TABLE public.speaking_shadowing_attempts
    ADD COLUMN IF NOT EXISTS audio_sha256 VARCHAR(64);

-- 3. Missing B-tree index for scenario session cascade lookups
-- (speaking_shadowing_attempts(user_id, created_at) is already indexed by V34 idx_speaking_shadowing_attempts_user_created)
CREATE INDEX IF NOT EXISTS idx_speaking_sessions_scenario
    ON public.speaking_sessions (scenario_id);
