-- V11__auth_expand.sql
-- Additive authentication database schema for English Coach

-- 1. Extend public.users with additive authentication metadata
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email_normalized VARCHAR(255) GENERATED ALWAYS AS (lower(btrim(email))) STORED;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS credential_status VARCHAR(32) DEFAULT 'NONE';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS account_status VARCHAR(32) DEFAULT 'ACTIVE';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email_verification_source VARCHAR(64);
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS credential_version BIGINT NOT NULL DEFAULT 0;

-- 2. Safe initial classification for existing users
-- 12 real users with legitimate BCrypt hashes
UPDATE public.users 
SET credential_status = 'ACTIVE',
    account_status = 'ACTIVE',
    email_verification_source = 'LEGACY_RETAINED',
    email_verified_at = now()
WHERE (password LIKE '$2a$%' OR password LIKE '$2b$%' OR password LIKE '$2y$%')
  AND password NOT IN ('DEV_TEST', 'OAUTH2');

-- 656 automated test users with DEV_TEST placeholder
UPDATE public.users 
SET credential_status = 'RESET_REQUIRED',
    account_status = 'ACTIVE'
WHERE password = 'DEV_TEST';

-- 3 Google OAuth users with OAUTH2 placeholder
UPDATE public.users 
SET credential_status = 'NONE',
    account_status = 'ACTIVE'
WHERE password = 'OAUTH2';

-- 3. Create public.auth_identities for external provider linking
CREATE TABLE IF NOT EXISTS public.auth_identities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    provider VARCHAR(32) NOT NULL,
    provider_subject VARCHAR(255) NOT NULL,
    provider_email VARCHAR(255),
    email_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_authenticated_at TIMESTAMPTZ,
    CONSTRAINT uk_auth_identities_provider_sub UNIQUE (provider, provider_subject),
    CONSTRAINT uk_auth_identities_user_provider UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_auth_identities_user_id ON public.auth_identities(user_id);

-- 4. Create public.auth_security_state for lockout and rate limiting
CREATE TABLE IF NOT EXISTS public.auth_security_state (
    user_id BIGINT PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    failed_login_count INT NOT NULL DEFAULT 0,
    window_started_at TIMESTAMPTZ,
    next_allowed_at TIMESTAMPTZ,
    locked_until TIMESTAMPTZ,
    reset_generation BIGINT NOT NULL DEFAULT 0,
    verification_generation BIGINT NOT NULL DEFAULT 0,
    version BIGINT NOT NULL DEFAULT 0
);

-- Initialize security state for all existing users
INSERT INTO public.auth_security_state (user_id, failed_login_count, reset_generation, verification_generation, version)
SELECT id, 0, 0, 0, 0 
FROM public.users
ON CONFLICT (user_id) DO NOTHING;

-- 5. Create public.auth_sessions for revocable backend sessions
CREATE TABLE IF NOT EXISTS public.auth_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    session_grant_digest VARCHAR(64) NOT NULL UNIQUE,
    state VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    activated_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    idle_expires_at TIMESTAMPTZ NOT NULL,
    absolute_expires_at TIMESTAMPTZ NOT NULL,
    pending_expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revoked_reason VARCHAR(255),
    auth_method VARCHAR(32),
    authenticated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_state ON public.auth_sessions(user_id, state);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_idle_expiry ON public.auth_sessions(idle_expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_abs_expiry ON public.auth_sessions(absolute_expires_at);

-- 6. Create public.auth_action_tokens for purpose-bound workflows
CREATE TABLE IF NOT EXISTS public.auth_action_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_digest VARCHAR(64) NOT NULL UNIQUE,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    purpose VARCHAR(64) NOT NULL,
    bound_email_normalized VARCHAR(255),
    bound_session_id UUID,
    metadata JSONB,
    generation BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_auth_action_tokens_user_purpose ON public.auth_action_tokens(user_id, purpose);
CREATE INDEX IF NOT EXISTS idx_auth_action_tokens_expires ON public.auth_action_tokens(expires_at);

-- 7. Create public.auth_rate_limit_buckets for per-IP & per-account throttling
CREATE TABLE IF NOT EXISTS public.auth_rate_limit_buckets (
    kind VARCHAR(64) NOT NULL,
    bucket_key VARCHAR(128) NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    request_count INT NOT NULL DEFAULT 1,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (kind, bucket_key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_auth_rate_limit_expires ON public.auth_rate_limit_buckets(expires_at);

-- 8. Create public.auth_mail_jobs for durable email dispatch
CREATE TABLE IF NOT EXISTS public.auth_mail_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    purpose VARCHAR(64) NOT NULL,
    recipient_email VARCHAR(255) NOT NULL,
    generation BIGINT NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    attempt_count INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_mail_jobs_poll ON public.auth_mail_jobs(status, next_attempt_at) WHERE status IN ('PENDING', 'FAILED');

-- 9. Create public.auth_audit_events for immutable security logging
CREATE TABLE IF NOT EXISTS public.auth_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_time TIMESTAMPTZ NOT NULL DEFAULT now(),
    event_type VARCHAR(64) NOT NULL,
    outcome VARCHAR(32) NOT NULL,
    actor_user_id BIGINT,
    target_user_id BIGINT,
    correlation_id VARCHAR(128),
    ip_address VARCHAR(64),
    user_agent TEXT,
    reason_code VARCHAR(64),
    details JSONB
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_events_target ON public.auth_audit_events(target_user_id, event_time);
CREATE INDEX IF NOT EXISTS idx_auth_audit_events_type ON public.auth_audit_events(event_type, event_time);
