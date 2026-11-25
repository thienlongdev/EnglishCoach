-- V12__auth_constraints.sql
-- Enforce uniqueness and constraints on authentication schema

-- 1. Enforce unique constraint on normalized email
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS uk_users_email_normalized;
ALTER TABLE public.users ADD CONSTRAINT uk_users_email_normalized UNIQUE (email_normalized);

-- 2. Make password nullable for OAuth-only users
ALTER TABLE public.users ALTER COLUMN password DROP NOT NULL;

-- 3. Enforce status check constraints
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS chk_users_credential_status;
ALTER TABLE public.users ADD CONSTRAINT chk_users_credential_status 
    CHECK (credential_status IN ('ACTIVE', 'NONE', 'RESET_REQUIRED'));

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS chk_users_account_status;
ALTER TABLE public.users ADD CONSTRAINT chk_users_account_status 
    CHECK (account_status IN ('ACTIVE', 'PENDING_EMAIL', 'DISABLED'));

-- 4. Status indexes for authentication lookups
CREATE INDEX IF NOT EXISTS idx_users_credential_status ON public.users(credential_status);
CREATE INDEX IF NOT EXISTS idx_users_account_status ON public.users(account_status);
