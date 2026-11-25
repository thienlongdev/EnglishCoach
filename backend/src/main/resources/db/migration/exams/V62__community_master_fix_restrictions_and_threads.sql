-- =========================================================================
-- V62__community_master_fix_restrictions_and_threads.sql
-- Community Master Fix: Restrictions, Post Comment Lock, Reaction Types
-- =========================================================================

-- 1. Add comment lock state to community_posts
ALTER TABLE public.community_posts
    ADD COLUMN IF NOT EXISTS comments_disabled_by_owner BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS comments_locked_by_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Create Community User Restrictions table
CREATE TABLE IF NOT EXISTS public.community_user_restrictions (
    id BIGSERIAL PRIMARY KEY,
    target_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    restriction_type VARCHAR(64) NOT NULL, -- 'SUSPEND_COMMUNITY', 'READ_ONLY', 'NO_POST', 'NO_COMMENT'
    reason VARCHAR(500) NOT NULL,
    created_by_admin_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE, -- NULL = permanent
    revoked_at TIMESTAMP WITH TIME ZONE,
    revoked_by_admin_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    CONSTRAINT chk_community_restriction_type CHECK (
        restriction_type IN ('SUSPEND_COMMUNITY', 'READ_ONLY', 'NO_POST', 'NO_COMMENT')
    )
);

-- Active restrictions index for rapid permission checks
CREATE INDEX IF NOT EXISTS idx_community_user_restrictions_active 
    ON public.community_user_restrictions(target_user_id, expires_at) 
    WHERE (revoked_at IS NULL);

-- Historical restrictions index for audit inspection
CREATE INDEX IF NOT EXISTS idx_community_user_restrictions_history 
    ON public.community_user_restrictions(target_user_id, created_at DESC);

-- 3. Expand reaction type check on community_comment_reactions if present
ALTER TABLE public.community_comment_reactions 
    DROP CONSTRAINT IF EXISTS chk_community_comment_reaction_type;

ALTER TABLE public.community_comment_reactions 
    ADD CONSTRAINT chk_community_comment_reaction_type 
    CHECK (reaction_type IN (
        'LOVE', 'HAHA', 'SUPPORT', 'SAD', 'USEFUL',
        'WOW', 'CONFUSED', 'ANGRY', 'CLAP', 'FIRE', 'THINKING', 'CELEBRATE',
        'LIKE', 'IDEA', 'STRONG'
    ));
