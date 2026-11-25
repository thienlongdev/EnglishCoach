-- =========================================================================
-- V56__community_core.sql
-- English Coach Community: Social-First + Learning-Powered
-- =========================================================================

-- 1. Community Posts
CREATE TABLE IF NOT EXISTS public.community_posts (
    id BIGSERIAL PRIMARY KEY,
    author_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    author_type VARCHAR(32) NOT NULL DEFAULT 'USER', -- 'USER', 'OFFICIAL'
    created_by_admin_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    updated_by_admin_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING', -- 'DRAFT', 'PENDING', 'PUBLISHED', 'REJECTED', 'HIDDEN', 'DELETED', 'SCHEDULED'
    post_type VARCHAR(32) NOT NULL DEFAULT 'GENERAL', -- 'GENERAL', 'QUESTION', 'LEARNING', 'ACHIEVEMENT', 'CORRECTION_REQUEST', 'OFFICIAL'
    content TEXT NOT NULL,
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    is_featured BOOLEAN NOT NULL DEFAULT FALSE,
    series_type VARCHAR(64), -- e.g. 'DAILY_VOCAB', 'DAILY_LISTENING'
    scheduled_for TIMESTAMP WITH TIME ZONE,
    published_at TIMESTAMP WITH TIME ZONE,
    scheduled_date DATE, -- deterministic Vietnam local date for daily recurring posts
    like_count INT NOT NULL DEFAULT 0,
    comment_count INT NOT NULL DEFAULT 0,
    save_count INT NOT NULL DEFAULT 0,
    shared_entity_type VARCHAR(64), -- 'LISTENING_MATERIAL', 'FLASHCARD_DECK', 'EXAM_RESULT'
    shared_entity_id VARCHAR(128),
    shared_entity_payload TEXT, -- JSON string holding verified snapshot
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_community_posts_author_type CHECK (author_type IN ('USER', 'OFFICIAL')),
    CONSTRAINT chk_community_posts_status CHECK (status IN ('DRAFT', 'PENDING', 'PUBLISHED', 'REJECTED', 'HIDDEN', 'DELETED', 'SCHEDULED'))
);

-- Daily deterministic uniqueness: one daily post per series per calendar day
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_posts_series_daily 
    ON public.community_posts(series_type, scheduled_date) 
    WHERE (series_type IS NOT NULL AND scheduled_date IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_community_posts_feed 
    ON public.community_posts(status, is_pinned DESC, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_community_posts_author 
    ON public.community_posts(author_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_community_posts_status 
    ON public.community_posts(status, created_at DESC);


-- 2. Community Post Media
CREATE TABLE IF NOT EXISTS public.community_post_media (
    id BIGSERIAL PRIMARY KEY,
    post_id BIGINT NOT NULL REFERENCES public.community_posts(id) ON DELETE CASCADE,
    storage_key VARCHAR(512) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_size BIGINT NOT NULL,
    mime_type VARCHAR(64) NOT NULL,
    width INT,
    height INT,
    display_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_post_media_post 
    ON public.community_post_media(post_id, display_order ASC);


-- 3. Community Post Reactions
CREATE TABLE IF NOT EXISTS public.community_post_reactions (
    id BIGSERIAL PRIMARY KEY,
    post_id BIGINT NOT NULL REFERENCES public.community_posts(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    reaction_type VARCHAR(32) NOT NULL DEFAULT 'LIKE', -- 'LIKE', 'CLAP', 'FIRE', 'IDEA', 'STRONG'
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_community_post_user_reaction UNIQUE (post_id, user_id),
    CONSTRAINT chk_community_reaction_type CHECK (reaction_type IN ('LIKE', 'CLAP', 'FIRE', 'IDEA', 'STRONG'))
);

CREATE INDEX IF NOT EXISTS idx_community_post_reactions_post 
    ON public.community_post_reactions(post_id);

CREATE INDEX IF NOT EXISTS idx_community_post_reactions_user 
    ON public.community_post_reactions(user_id);


-- 4. Community Comments
CREATE TABLE IF NOT EXISTS public.community_comments (
    id BIGSERIAL PRIMARY KEY,
    post_id BIGINT NOT NULL REFERENCES public.community_posts(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    parent_comment_id BIGINT REFERENCES public.community_comments(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PUBLISHED', -- 'PUBLISHED', 'HIDDEN', 'DELETED'
    like_count INT NOT NULL DEFAULT 0,
    reply_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_community_comments_status CHECK (status IN ('PUBLISHED', 'HIDDEN', 'DELETED'))
);

CREATE INDEX IF NOT EXISTS idx_community_comments_post_tree 
    ON public.community_comments(post_id, parent_comment_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_community_comments_user 
    ON public.community_comments(user_id);


-- 5. Community Comment Reactions
CREATE TABLE IF NOT EXISTS public.community_comment_reactions (
    id BIGSERIAL PRIMARY KEY,
    comment_id BIGINT NOT NULL REFERENCES public.community_comments(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    reaction_type VARCHAR(32) NOT NULL DEFAULT 'LIKE',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_community_comment_user_reaction UNIQUE (comment_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_community_comment_reactions_comment 
    ON public.community_comment_reactions(comment_id);


-- 6. Community Follows
CREATE TABLE IF NOT EXISTS public.community_follows (
    id BIGSERIAL PRIMARY KEY,
    follower_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    following_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_community_follow UNIQUE (follower_user_id, following_user_id),
    CONSTRAINT chk_community_no_self_follow CHECK (follower_user_id <> following_user_id)
);

CREATE INDEX IF NOT EXISTS idx_community_follows_follower 
    ON public.community_follows(follower_user_id);

CREATE INDEX IF NOT EXISTS idx_community_follows_following 
    ON public.community_follows(following_user_id);


-- 7. Community Saved Posts (Private Bookmarks)
CREATE TABLE IF NOT EXISTS public.community_saved_posts (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    post_id BIGINT NOT NULL REFERENCES public.community_posts(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_community_saved_post UNIQUE (user_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_community_saved_posts_user 
    ON public.community_saved_posts(user_id, created_at DESC);


-- 8. Community Reports
CREATE TABLE IF NOT EXISTS public.community_reports (
    id BIGSERIAL PRIMARY KEY,
    reporter_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    post_id BIGINT NOT NULL REFERENCES public.community_posts(id) ON DELETE CASCADE,
    reason VARCHAR(64) NOT NULL, -- 'SPAM', 'HARASSMENT', 'INAPPROPRIATE', 'MISINFORMATION', 'ADVERTISING', 'OTHER'
    details TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'RESOLVED_APPROVED', 'RESOLVED_REJECTED', 'DISMISSED'
    resolved_by_admin_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    resolved_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_reports_status 
    ON public.community_reports(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_community_reports_post 
    ON public.community_reports(post_id);


-- 9. Community Moderation Records (Audit log)
CREATE TABLE IF NOT EXISTS public.community_moderation_records (
    id BIGSERIAL PRIMARY KEY,
    post_id BIGINT NOT NULL REFERENCES public.community_posts(id) ON DELETE CASCADE,
    admin_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    previous_status VARCHAR(32) NOT NULL,
    new_status VARCHAR(32) NOT NULL,
    action VARCHAR(32) NOT NULL, -- 'APPROVE', 'REJECT', 'HIDE', 'DELETE', 'RESTORE'
    reason VARCHAR(64),
    note TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_moderation_post 
    ON public.community_moderation_records(post_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_community_moderation_admin 
    ON public.community_moderation_records(admin_id, created_at DESC);
