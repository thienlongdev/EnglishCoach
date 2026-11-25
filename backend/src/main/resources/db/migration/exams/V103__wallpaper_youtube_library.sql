-- Hình nền — "Video YouTube của tôi" (owner 2026-10-19): each learner's own list of saved YouTube videos, kept with the
-- account so it survives sign-out and follows the learner to another device. One row per (learner, video id).
-- Only the validated 11-character video id is stored (never the pasted URL text, a title or a thumbnail), plus the
-- learner's optional background source for that entry: an HTTPS link to a directly playable video file the learner
-- says they may use (LINK), or the NAME of a file kept in that learner's own browser on one device (FILE; the bytes
-- never reach the server). The server never fetches either. No video bytes in the database. Additive only.
CREATE TABLE IF NOT EXISTS public.wallpaper_youtube_videos (
    id                   UUID         PRIMARY KEY,
    user_id              BIGINT       NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
    video_id             VARCHAR(11)  NOT NULL CHECK (video_id ~ '^[A-Za-z0-9_-]{11}$' AND video_id <> 'videoseries'),
    background_kind      VARCHAR(8)   CHECK (background_kind IN ('LINK', 'FILE')),
    background_url       VARCHAR(2048) CHECK (background_url ~ '^https://[^/@\s]+\.[^/@\s]+(/|$)'),
    background_file_name VARCHAR(160),
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT uq_wallpaper_youtube_owner_video UNIQUE (user_id, video_id),
    -- CASE, not OR: with a NULL kind an OR of comparisons would be NULL and a CHECK lets NULL pass.
    CONSTRAINT ck_wallpaper_youtube_background CHECK (CASE background_kind
        WHEN 'LINK' THEN background_url IS NOT NULL AND background_file_name IS NULL
        WHEN 'FILE' THEN background_url IS NULL AND background_file_name IS NOT NULL AND length(btrim(background_file_name)) > 0
        ELSE background_kind IS NULL AND background_url IS NULL AND background_file_name IS NULL END)
);

-- The owner's list, newest first (bounded by the per-learner limit in WallpaperLibraryService).
CREATE INDEX IF NOT EXISTS idx_wallpaper_youtube_owner_created
    ON public.wallpaper_youtube_videos (user_id, created_at DESC);
