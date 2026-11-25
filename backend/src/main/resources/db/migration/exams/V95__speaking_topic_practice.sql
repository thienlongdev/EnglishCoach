-- Speaking "Nói theo chủ đề" (topic speaking practice). Additive schema only.
-- The English question bank is an immutable classpath artifact (speaking/topics/*.json, versioned with the
-- backend image); no content rows are seeded here or at start-up. These tables keep only each learner's own
-- draw history (anti-repetition + honest practice facts) and favourites. No audio is stored.
CREATE TABLE IF NOT EXISTS public.speaking_topic_draws (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    request_id UUID NOT NULL,
    item_id VARCHAR(24) NOT NULL CHECK (item_id ~ '^[A-Z0-9-]{3,24}$'),
    style VARCHAR(8) NOT NULL CHECK (style IN ('QUICK','DEEP','IELTS1','IELTS2','IELTS3')),
    bank_version VARCHAR(32) NOT NULL,
    origin VARCHAR(8) NOT NULL CHECK (origin IN ('SPIN','REPLAY')),
    -- DRAWN: topic shown · SKIPPED: changed before speaking · STARTED: speaking timer started · FINISHED: round ended
    status VARCHAR(10) NOT NULL DEFAULT 'DRAWN' CHECK (status IN ('DRAWN','SKIPPED','STARTED','FINISHED')),
    target_seconds INTEGER CHECK (target_seconds BETWEEN 10 AND 900),
    spoken_seconds INTEGER CHECK (spoken_seconds BETWEEN 0 AND 1200),
    reached_target BOOLEAN,
    recorded BOOLEAN NOT NULL DEFAULT FALSE,
    drawn_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    CONSTRAINT uq_speaking_topic_draw_request UNIQUE (user_id, request_id),
    CONSTRAINT ck_speaking_topic_draw_lifecycle CHECK (
        (status IN ('DRAWN','SKIPPED') AND started_at IS NULL AND finished_at IS NULL)
        OR (status = 'STARTED' AND started_at IS NOT NULL AND finished_at IS NULL)
        OR (status = 'FINISHED' AND started_at IS NOT NULL AND finished_at IS NOT NULL
            AND spoken_seconds IS NOT NULL AND reached_target IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_speaking_topic_draws_owner ON public.speaking_topic_draws(user_id, drawn_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS public.speaking_topic_favorites (
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    item_id VARCHAR(24) NOT NULL CHECK (item_id ~ '^[A-Z0-9-]{3,24}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, item_id)
);
