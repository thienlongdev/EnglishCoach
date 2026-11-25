-- V42__card_blast_runs.sql
-- Active Recall Vocabulary Engine: Card Blast Runs Tracking

CREATE TABLE IF NOT EXISTS public.card_blast_runs (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    deck_id BIGINT REFERENCES public.vocab_decks(id) ON DELETE SET NULL,
    score INTEGER NOT NULL DEFAULT 0,
    accuracy DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    weak_words_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_card_blast_runs_user_deck ON public.card_blast_runs (user_id, deck_id);
CREATE INDEX IF NOT EXISTS idx_card_blast_runs_created_at ON public.card_blast_runs (created_at DESC);
