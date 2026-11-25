-- =========================================================================
-- V58__community_media_staging_and_performance.sql
-- Community Social UX V2: Media Staging + Index Optimization
-- =========================================================================

-- 1. Allow staged media uploads prior to post creation
ALTER TABLE public.community_post_media ALTER COLUMN post_id DROP NOT NULL;

-- 2. Track uploader identity on staged media for ownership validation
ALTER TABLE public.community_post_media 
    ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL;

-- 3. Storage key lookup index for rapid media matching
CREATE INDEX IF NOT EXISTS idx_community_post_media_storage_key 
    ON public.community_post_media(storage_key);

-- 4. Uploader index for cleanup / orphan management
CREATE INDEX IF NOT EXISTS idx_community_post_media_user 
    ON public.community_post_media(user_id);

-- 5. Moderation records composite index for rapid batch loading
CREATE INDEX IF NOT EXISTS idx_community_moderation_records_post_created 
    ON public.community_moderation_records(post_id, created_at DESC);
