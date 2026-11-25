-- V65__community_comment_multi_media.sql
-- Community Post-Deployment UX Expansion: Multi-attachment comment media (up to 5 images + 1 video).
-- Supports one comment: many media attachments with display ordering.

CREATE TABLE IF NOT EXISTS public.community_comment_media (
    id BIGSERIAL PRIMARY KEY,
    comment_id BIGINT NOT NULL REFERENCES public.community_comments(id) ON DELETE CASCADE,
    media_url VARCHAR(1024) NOT NULL,
    media_type VARCHAR(64) NOT NULL,
    display_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comm_comment_media_comment_id ON public.community_comment_media(comment_id);
CREATE INDEX IF NOT EXISTS idx_comm_comment_media_order ON public.community_comment_media(comment_id, display_order);

-- Migrate any existing single media from community_comments table into community_comment_media (idempotent)
INSERT INTO public.community_comment_media (comment_id, media_url, media_type, display_order, created_at)
SELECT c.id, c.media_url, COALESCE(c.media_type, 'image/jpeg'), 0, c.created_at
FROM public.community_comments c
WHERE c.media_url IS NOT NULL AND trim(c.media_url) != ''
  AND NOT EXISTS (
      SELECT 1 FROM public.community_comment_media m WHERE m.comment_id = c.id
  );
