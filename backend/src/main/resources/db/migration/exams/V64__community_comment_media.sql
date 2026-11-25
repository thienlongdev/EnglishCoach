-- V64__community_comment_media.sql
-- Community Post-Deployment Bugfix: Facebook-style comment attachments (image / video).
-- Adds media_url and media_type columns to community_comments table.
-- Allows content to be optional when media is attached.

ALTER TABLE public.community_comments ADD COLUMN IF NOT EXISTS media_url VARCHAR(1024);
ALTER TABLE public.community_comments ADD COLUMN IF NOT EXISTS media_type VARCHAR(64);
ALTER TABLE public.community_comments ALTER COLUMN content DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_community_comments_content_or_media'
    ) THEN
        ALTER TABLE public.community_comments
            ADD CONSTRAINT chk_community_comments_content_or_media
            CHECK ((content IS NOT NULL AND length(trim(content)) > 0) OR media_url IS NOT NULL);
    END IF;
END $$;
