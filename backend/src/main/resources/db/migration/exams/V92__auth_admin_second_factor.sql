-- V92__auth_admin_second_factor.sql
-- Administrator second factor (security release V3, 2026-10). Additive only: three nullable columns on
-- public.auth_sessions and five new tables. No existing row is rewritten; a backend that does not know these
-- objects keeps working (rollback of the application needs no rollback of this migration).

-- 1. What a session has proven beyond its first factor.
ALTER TABLE public.auth_sessions ADD COLUMN IF NOT EXISTS mfa_verified_at TIMESTAMPTZ;
ALTER TABLE public.auth_sessions ADD COLUMN IF NOT EXISTS mfa_method VARCHAR(32);
ALTER TABLE public.auth_sessions ADD COLUMN IF NOT EXISTS step_up_at TIMESTAMPTZ;

-- 2. WebAuthn credentials (passkeys, security keys). Only public material: the credential id, the public key
--    (inside the attested credential data, as the authenticator produced it) and the signature counter.
CREATE TABLE IF NOT EXISTS public.auth_mfa_webauthn_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    credential_id VARCHAR(1400) NOT NULL,
    attested_credential_data BYTEA NOT NULL,
    sign_count BIGINT NOT NULL DEFAULT 0,
    transports VARCHAR(128),
    backup_eligible BOOLEAN NOT NULL DEFAULT false,
    backup_state BOOLEAN NOT NULL DEFAULT false,
    label VARCHAR(80) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    CONSTRAINT uk_auth_mfa_webauthn_credential_id UNIQUE (credential_id)
);
CREATE INDEX IF NOT EXISTS idx_auth_mfa_webauthn_user ON public.auth_mfa_webauthn_credentials(user_id);

-- 3. Time-based one-time password. The secret is stored encrypted (AES-256-GCM) by the application;
--    last_used_step refuses the replay of a code inside its own time step.
CREATE TABLE IF NOT EXISTS public.auth_mfa_totp (
    user_id BIGINT PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    secret_ciphertext BYTEA NOT NULL,
    key_version SMALLINT NOT NULL DEFAULT 1,
    confirmed_at TIMESTAMPTZ,
    last_used_step BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. One-time recovery codes: only a digest is stored; a code is spent by setting used_at once.
CREATE TABLE IF NOT EXISTS public.auth_mfa_recovery_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    code_digest VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    used_at TIMESTAMPTZ,
    CONSTRAINT uk_auth_mfa_recovery_code UNIQUE (user_id, code_digest)
);

-- 5. WebAuthn challenges: random, short-lived, bound to the account and the session that asked, usable once.
CREATE TABLE IF NOT EXISTS public.auth_mfa_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    session_id UUID NOT NULL,
    purpose VARCHAR(32) NOT NULL,
    challenge VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    CONSTRAINT ck_auth_mfa_challenge_purpose CHECK (purpose IN ('WEBAUTHN_REGISTER', 'WEBAUTHN_ASSERT'))
);
CREATE INDEX IF NOT EXISTS idx_auth_mfa_challenges_expiry ON public.auth_mfa_challenges(expires_at);

-- 6. Emergency resets already carried out (digest of the one-time value of the owner runbook), so the same
--    environment value can never reset the factors twice.
CREATE TABLE IF NOT EXISTS public.auth_mfa_emergency_resets (
    token_digest VARCHAR(64) PRIMARY KEY,
    consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    target_user_id BIGINT
);
