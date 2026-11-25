-- Echo Memory Tides 2.0 (owner brief 2026-11-12). Additive only: no existing table, row or rule changes.
--
-- 1. flashcard_review_log: one row per rating stored by FlashcardService#review, written in the SAME transaction as the
--    schedule change (never for a replayed Idempotency-Key). Append-only (trigger), like score_events. It is the evidence of
--    weak words (Khó on distinct local days), card evolution and the Memory Reef. It never drives the schedule: the
--    fixed-interval scheduler and MASTERED semantics are unchanged. Ratings before this migration have no row (honestly
--    unknown: evolution of older cards starts from their stored status only).
-- 2. flashcard_fusions: a Card Fusion sentence the AI check ACCEPTED (both words used, grammatical). One row per learner and
--    unordered card pair (repeat success keeps the first row). Never touches review scheduling.
-- 3. Three AI feature keys for the existing quota ledger (free accounts draw on the shared daily AI pool, V99).

CREATE TABLE IF NOT EXISTS public.flashcard_review_log (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    flashcard_id BIGINT NOT NULL REFERENCES public.flashcards(id) ON DELETE RESTRICT,
    quality VARCHAR(8) NOT NULL,
    status_before VARCHAR(16),
    status_after VARCHAR(16) NOT NULL,
    review_local_day DATE NOT NULL,
    reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_flashcard_review_log_quality CHECK (quality IN ('hard', 'good', 'easy'))
);

CREATE INDEX IF NOT EXISTS idx_flashcard_review_log_user_card
    ON public.flashcard_review_log (user_id, flashcard_id, reviewed_at);
CREATE INDEX IF NOT EXISTS idx_flashcard_review_log_user_day
    ON public.flashcard_review_log (user_id, review_local_day);

CREATE OR REPLACE FUNCTION public.fn_flashcard_review_log_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'flashcard_review_log is append-only (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_flashcard_review_log_append_only ON public.flashcard_review_log;
CREATE TRIGGER trg_flashcard_review_log_append_only
    BEFORE UPDATE OR DELETE ON public.flashcard_review_log
    FOR EACH ROW EXECUTE FUNCTION public.fn_flashcard_review_log_append_only();

CREATE TABLE IF NOT EXISTS public.flashcard_fusions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    card_low_id BIGINT NOT NULL REFERENCES public.flashcards(id) ON DELETE RESTRICT,
    card_high_id BIGINT NOT NULL REFERENCES public.flashcards(id) ON DELETE RESTRICT,
    word_low VARCHAR(255) NOT NULL,
    word_high VARCHAR(255) NOT NULL,
    relation VARCHAR(32) NOT NULL,
    sentence VARCHAR(400) NOT NULL,
    feedback_vi VARCHAR(1200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_flashcard_fusions_order CHECK (card_low_id < card_high_id),
    CONSTRAINT uq_flashcard_fusions_pair UNIQUE (user_id, card_low_id, card_high_id)
);

CREATE INDEX IF NOT EXISTS idx_flashcard_fusions_user_created
    ON public.flashcard_fusions (user_id, created_at DESC);

INSERT INTO public.premium_feature_definitions
    (feature_key, display_name, description, premium_required, free_trial_limit, premium_monthly_limit, enabled, sort_order)
VALUES
    ('FLASHCARD_AI_STUDIO', 'Echo AI Card Studio', 'Gợi ý thẻ từ vựng từ đoạn văn người học dán vào; người học duyệt trước khi lưu.', true, 5, 300, true, 96),
    ('FLASHCARD_MEMORY_FORGE', 'Memory Forge', 'Cách ghi nhớ khác cho từ hay quên: giải thích, ví dụ riêng, mẹo nhớ do AI gợi ý.', true, 5, 300, true, 97),
    ('FLASHCARD_FUSION_CHECK', 'Card Fusion', 'Kiểm tra câu người học tự viết với hai từ đã học.', true, 5, 300, true, 98)
ON CONFLICT (feature_key) DO NOTHING;
