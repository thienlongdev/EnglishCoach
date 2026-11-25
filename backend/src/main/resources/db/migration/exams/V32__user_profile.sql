-- V32__user_profile.sql
-- User Profile foundation

CREATE TABLE IF NOT EXISTS public.user_profiles (
    user_id BIGINT PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
    display_name VARCHAR(100),
    phone VARCHAR(32),
    city VARCHAR(100),
    province VARCHAR(100),
    avatar_storage_key VARCHAR(255),
    avatar_updated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_updated_at ON public.user_profiles(updated_at);
