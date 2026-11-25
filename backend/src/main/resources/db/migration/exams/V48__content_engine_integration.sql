-- V48__content_engine_integration.sql
-- Content Engine Integration (Phase 2): Feed Provider Tracking, RSS Deduplication, Reading Snapshot Library & Partial Indexes

-- 1. feed_articles: provider tracking, deduplication index, and compound published index
ALTER TABLE public.feed_articles
    ADD COLUMN IF NOT EXISTS provider_key VARCHAR(50) NULL;

-- Tag Phase 1 demo seed rows with provider_key = 'seed'
UPDATE public.feed_articles
SET provider_key = 'seed'
WHERE url IN (
    'https://www.bbc.com',
    'https://www.theguardian.com',
    'https://www.voanews.com',
    'https://www.economist.com'
) OR title IN (
    'Why more people are choosing four-day work weeks',
    'Cities try quieter streets to cut noise pollution',
    'Students use digital tools to plan their study time',
    'Why cheap flights are getting less cheap'
);

-- Unique index for URL deduplication
CREATE UNIQUE INDEX IF NOT EXISTS uq_feed_articles_url
    ON public.feed_articles (url);

-- Composite index for fast provider queries and recent live article scans
CREATE INDEX IF NOT EXISTS idx_feed_articles_provider_published
    ON public.feed_articles (provider_key, published_at DESC);


-- 2. listening_content: provider tracking and tag seed demo rows
ALTER TABLE public.listening_content
    ADD COLUMN IF NOT EXISTS provider_key VARCHAR(50) NULL;

UPDATE public.listening_content
SET provider_key = 'seed'
WHERE title IN ('How Sleep Shapes Memory', 'Ordering Coffee');


-- 3. reading_materials (Option a: reuse existing Reading library table):
-- Additive columns to support saved feed snapshots
ALTER TABLE public.reading_materials
    ADD COLUMN IF NOT EXISTS origin_feed_article_id BIGINT NULL;

ALTER TABLE public.reading_materials
    ADD COLUMN IF NOT EXISTS source_name VARCHAR(100) NULL;

ALTER TABLE public.reading_materials
    ADD COLUMN IF NOT EXISTS content_mode VARCHAR(20) NULL;

-- Partial unique index ensuring a user can only save an origin feed article snapshot once
CREATE UNIQUE INDEX IF NOT EXISTS idx_reading_materials_user_origin_feed
    ON public.reading_materials (owner_user_id, origin_feed_article_id)
    WHERE origin_feed_article_id IS NOT NULL;
