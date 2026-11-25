-- V53__proficiency_engine.sql
-- Leaderboard Phase 2 — Proficiency Engine (feature slug `proficiency`).
-- Proficiency data lives ONLY in proficiency_* tables, skill_proficiency and user_proficiency.
-- It never reads score_events / leaderboard_content_cefr (Activity pipeline).

-- 1. Standardized score -> rating (0..1000) anchors. Linear interpolation happens only between
--    anchors; scores outside [min anchor, max anchor] produce no evidence (never extrapolate).
CREATE TABLE IF NOT EXISTS public.proficiency_score_mapping (
    scale VARCHAR(30) NOT NULL,
    raw_score NUMERIC(7, 2) NOT NULL,
    rating INTEGER NOT NULL,
    CONSTRAINT pk_proficiency_score_mapping PRIMARY KEY (scale, raw_score),
    CONSTRAINT ck_proficiency_score_mapping_scale CHECK (scale IN (
        'IELTS_BAND', 'TOEIC_LISTENING', 'TOEIC_READING', 'TOEIC_SPEAKING', 'TOEIC_WRITING')),
    CONSTRAINT ck_proficiency_score_mapping_rating CHECK (rating BETWEEN 0 AND 1000)
);

-- Rating bands: A1 0-166 | A2 167-333 | B1 334-499 | B2 500-666 | C1 667-833 | C2 834-1000.
-- IELTS (official 0-9). Official CEFR boundaries (ielts.org): B1 from 4.0, B2 5.5, C1 7.0, C2 8.5.
-- DESIGN anchors (no official source): 0.0->0, 3.0->200, 9.0->950.
INSERT INTO public.proficiency_score_mapping (scale, raw_score, rating) VALUES
    ('IELTS_BAND', 0.0, 0),
    ('IELTS_BAND', 3.0, 200),
    ('IELTS_BAND', 4.0, 334),
    ('IELTS_BAND', 5.5, 500),
    ('IELTS_BAND', 7.0, 667),
    ('IELTS_BAND', 8.5, 834),
    ('IELTS_BAND', 9.0, 950)
ON CONFLICT (scale, raw_score) DO NOTHING;

-- TOEIC Listening (official 5-495). ETS CEFR minimums: A1 60, A2 110, B1 275, B2 400, C1 490.
-- DESIGN anchors: 5->0 floor, 495->700 top (ETS maps TOEIC only up to C1).
INSERT INTO public.proficiency_score_mapping (scale, raw_score, rating) VALUES
    ('TOEIC_LISTENING', 5, 0),
    ('TOEIC_LISTENING', 60, 0),
    ('TOEIC_LISTENING', 110, 167),
    ('TOEIC_LISTENING', 275, 334),
    ('TOEIC_LISTENING', 400, 500),
    ('TOEIC_LISTENING', 490, 667),
    ('TOEIC_LISTENING', 495, 700)
ON CONFLICT (scale, raw_score) DO NOTHING;

-- TOEIC Reading (official 5-495). ETS CEFR minimums: A1 60, A2 115, B1 275, B2 385, C1 455.
-- DESIGN anchors: 5->0 floor, 495->730 top.
INSERT INTO public.proficiency_score_mapping (scale, raw_score, rating) VALUES
    ('TOEIC_READING', 5, 0),
    ('TOEIC_READING', 60, 0),
    ('TOEIC_READING', 115, 167),
    ('TOEIC_READING', 275, 334),
    ('TOEIC_READING', 385, 500),
    ('TOEIC_READING', 455, 667),
    ('TOEIC_READING', 495, 730)
ON CONFLICT (scale, raw_score) DO NOTHING;

-- TOEIC Speaking (official 0-200). ETS CEFR minimums: A1 50, A2 90, B1 120, B2 160, C1 180.
-- DESIGN anchors: 0->0 floor, 200->750 top.
INSERT INTO public.proficiency_score_mapping (scale, raw_score, rating) VALUES
    ('TOEIC_SPEAKING', 0, 0),
    ('TOEIC_SPEAKING', 50, 0),
    ('TOEIC_SPEAKING', 90, 167),
    ('TOEIC_SPEAKING', 120, 334),
    ('TOEIC_SPEAKING', 160, 500),
    ('TOEIC_SPEAKING', 180, 667),
    ('TOEIC_SPEAKING', 200, 750)
ON CONFLICT (scale, raw_score) DO NOTHING;

-- TOEIC Writing (official 0-200). ETS CEFR minimums: A1 30, A2 70, B1 120, B2 150, C1 180.
-- DESIGN anchors: 0->0 floor, 200->750 top.
INSERT INTO public.proficiency_score_mapping (scale, raw_score, rating) VALUES
    ('TOEIC_WRITING', 0, 0),
    ('TOEIC_WRITING', 30, 0),
    ('TOEIC_WRITING', 70, 167),
    ('TOEIC_WRITING', 120, 334),
    ('TOEIC_WRITING', 150, 500),
    ('TOEIC_WRITING', 180, 667),
    ('TOEIC_WRITING', 200, 750)
ON CONFLICT (scale, raw_score) DO NOTHING;

-- 2. Evidence ledger (append-only; UPDATE/DELETE rejected by trigger).
CREATE TABLE IF NOT EXISTS public.proficiency_evidence (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    skill VARCHAR(20) NOT NULL,
    tier VARCHAR(2) NOT NULL,
    kind VARCHAR(12) NOT NULL,
    source_module VARCHAR(30) NOT NULL,
    source_ref VARCHAR(200) NOT NULL,
    material_key VARCHAR(100) NOT NULL,
    raw_score NUMERIC(8, 3) NULL,
    content_cefr VARCHAR(2) NULL,
    quality NUMERIC(6, 4) NULL,
    observed_rating INTEGER NOT NULL,
    tier_weight NUMERIC(4, 2) NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_proficiency_evidence_source UNIQUE (user_id, skill, source_module, source_ref),
    CONSTRAINT ck_proficiency_evidence_skill CHECK (skill IN ('LISTENING', 'READING', 'WRITING', 'SPEAKING', 'VOCABULARY')),
    CONSTRAINT ck_proficiency_evidence_tier CHECK (tier IN ('T1', 'T2', 'T3')),
    CONSTRAINT ck_proficiency_evidence_kind CHECK (kind IN ('POINT', 'LOWER_BOUND')),
    CONSTRAINT ck_proficiency_evidence_source_module CHECK (source_module IN ('EXAM', 'DICTATION', 'ROLEPLAY')),
    CONSTRAINT ck_proficiency_evidence_cefr CHECK (content_cefr IS NULL OR content_cefr IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
    CONSTRAINT ck_proficiency_evidence_rating CHECK (observed_rating BETWEEN 0 AND 1000),
    CONSTRAINT ck_proficiency_evidence_weight CHECK (tier_weight > 0 AND tier_weight <= 1)
);

CREATE INDEX IF NOT EXISTS idx_proficiency_evidence_user_skill_occurred
    ON public.proficiency_evidence (user_id, skill, occurred_at);

CREATE OR REPLACE FUNCTION public.fn_proficiency_evidence_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'proficiency_evidence is append-only (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_proficiency_evidence_append_only ON public.proficiency_evidence;
CREATE TRIGGER trg_proficiency_evidence_append_only
    BEFORE UPDATE OR DELETE ON public.proficiency_evidence
    FOR EACH ROW EXECUTE FUNCTION public.fn_proficiency_evidence_append_only();

-- 3. Per-skill state. rating is written ONLY from SkillRatingCalculator output.
CREATE TABLE IF NOT EXISTS public.skill_proficiency (
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    skill VARCHAR(20) NOT NULL,
    rating INTEGER NULL,
    weight_sum NUMERIC(10, 4) NOT NULL DEFAULT 0,
    sd NUMERIC(8, 2) NOT NULL DEFAULT 0,
    confidence NUMERIC(4, 2) NOT NULL DEFAULT 0,
    status VARCHAR(15) NOT NULL,
    evidence_count INTEGER NOT NULL DEFAULT 0,
    last_evidence_at TIMESTAMPTZ NULL,
    rating_reached_at TIMESTAMPTZ NULL,
    ever_verified BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pk_skill_proficiency PRIMARY KEY (user_id, skill),
    CONSTRAINT ck_skill_proficiency_skill CHECK (skill IN ('LISTENING', 'READING', 'WRITING', 'SPEAKING', 'VOCABULARY')),
    CONSTRAINT ck_skill_proficiency_status CHECK (status IN ('UNSUPPORTED', 'STALE', 'UNDETERMINED', 'VERIFIED', 'PROVISIONAL')),
    CONSTRAINT ck_skill_proficiency_rating CHECK (rating IS NULL OR rating BETWEEN 0 AND 1000),
    CONSTRAINT ck_skill_proficiency_confidence CHECK (confidence BETWEEN 0 AND 1)
);

-- 4. Overall state (one row per user). Peak never decreases.
CREATE TABLE IF NOT EXISTS public.user_proficiency (
    user_id BIGINT PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
    overall_rating INTEGER NULL,
    current_cefr VARCHAR(2) NULL,
    overall_confidence NUMERIC(4, 2) NOT NULL DEFAULT 0,
    overall_status VARCHAR(15) NOT NULL DEFAULT 'UNDETERMINED',
    peak_rating INTEGER NULL,
    peak_cefr VARCHAR(2) NULL,
    peak_reached_at TIMESTAMPTZ NULL,
    ever_verified BOOLEAN NOT NULL DEFAULT FALSE,
    show_on_proficiency_board BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_user_proficiency_status CHECK (overall_status IN ('UNDETERMINED', 'PROVISIONAL', 'VERIFIED', 'STALE')),
    CONSTRAINT ck_user_proficiency_cefr CHECK (current_cefr IS NULL OR current_cefr IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
    CONSTRAINT ck_user_proficiency_peak_cefr CHECK (peak_cefr IS NULL OR peak_cefr IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
    CONSTRAINT ck_user_proficiency_rating CHECK (overall_rating IS NULL OR overall_rating BETWEEN 0 AND 1000),
    CONSTRAINT ck_user_proficiency_peak_rating CHECK (peak_rating IS NULL OR peak_rating BETWEEN 0 AND 1000),
    CONSTRAINT ck_user_proficiency_confidence CHECK (overall_confidence BETWEEN 0 AND 1)
);

-- 5. Daily snapshot (derived; written by the nightly job).
CREATE TABLE IF NOT EXISTS public.proficiency_snapshot (
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    snapshot_date DATE NOT NULL,
    overall_rating INTEGER NULL,
    current_cefr VARCHAR(2) NULL,
    overall_confidence NUMERIC(4, 2) NOT NULL DEFAULT 0,
    overall_status VARCHAR(15) NOT NULL,
    skills JSONB NOT NULL DEFAULT '[]'::jsonb,
    CONSTRAINT pk_proficiency_snapshot PRIMARY KEY (user_id, snapshot_date),
    CONSTRAINT ck_proficiency_snapshot_status CHECK (overall_status IN ('UNDETERMINED', 'PROVISIONAL', 'VERIFIED', 'STALE')),
    CONSTRAINT ck_proficiency_snapshot_cefr CHECK (current_cefr IS NULL OR current_cefr IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2'))
);
