-- V52__leaderboard_activity.sql
-- Leaderboard Phase 1 — Activity Engine.
-- score_events is an append-only ledger of Activity Points (INSERT only; UPDATE/DELETE are
-- rejected by trigger). leaderboard_content_cefr holds Activity-only CEFR labels for content
-- that has no CEFR column in its owning module. Neither table is ever read by the
-- Proficiency pipeline.

CREATE TABLE IF NOT EXISTS public.score_events (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    source_module VARCHAR(40) NOT NULL,
    source_ref VARCHAR(200) NOT NULL,
    skill_group VARCHAR(20) NOT NULL,
    base NUMERIC(10, 3) NOT NULL,
    cefr_level VARCHAR(2) NULL,
    cefr_mult NUMERIC(6, 3) NOT NULL,
    quality_mult NUMERIC(7, 4) NOT NULL,
    relative_mult NUMERIC(6, 3) NOT NULL,
    raw_points INTEGER NOT NULL,
    eligible_points INTEGER NOT NULL,
    capped BOOLEAN NOT NULL DEFAULT FALSE,
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_score_events_user_source UNIQUE (user_id, source_module, source_ref),
    CONSTRAINT ck_score_events_source_module CHECK (source_module IN (
        'FLASHCARD_REVIEW', 'FLASHCARD_NEW', 'FLASHCARD_MASTERED',
        'CARD_BLAST_SOLO', 'CARD_BLAST_PVP',
        'DICTATION', 'LISTENING_WATCH',
        'SHADOWING', 'ROLEPLAY',
        'READING', 'WRITING',
        'EXAM_SIMULATION', 'EXAM_PRACTICE'
    )),
    CONSTRAINT ck_score_events_skill_group CHECK (skill_group IN (
        'VOCAB', 'LISTENING', 'SPEAKING', 'READING', 'WRITING', 'EXAMS'
    )),
    CONSTRAINT ck_score_events_cefr CHECK (cefr_level IS NULL OR cefr_level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
    CONSTRAINT ck_score_events_points CHECK (raw_points >= 0 AND eligible_points >= 0 AND eligible_points <= raw_points)
);

CREATE INDEX IF NOT EXISTS idx_score_events_user_occurred ON public.score_events (user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_score_events_occurred ON public.score_events (occurred_at);

-- Append-only guarantee: the ledger is immutable; caps and rollups are derived data.
CREATE OR REPLACE FUNCTION public.fn_score_events_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'score_events is append-only (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_score_events_append_only ON public.score_events;
CREATE TRIGGER trg_score_events_append_only
    BEFORE UPDATE OR DELETE ON public.score_events
    FOR EACH ROW EXECUTE FUNCTION public.fn_score_events_append_only();

CREATE TABLE IF NOT EXISTS public.leaderboard_content_cefr (
    source_module VARCHAR(40) NOT NULL,
    ref_id VARCHAR(100) NOT NULL,
    cefr_level VARCHAR(2) NOT NULL,
    CONSTRAINT pk_leaderboard_content_cefr PRIMARY KEY (source_module, ref_id),
    CONSTRAINT ck_leaderboard_content_cefr_level CHECK (cefr_level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2'))
);
