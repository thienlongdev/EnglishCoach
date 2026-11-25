CREATE TABLE public.word_chain_results (
    match_id UUID NOT NULL,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    mode VARCHAR(12) NOT NULL CHECK (mode IN ('SOLO', 'BOT', 'PRIVATE', 'QUICK')),
    accepted_count INTEGER NOT NULL CHECK (accepted_count BETWEEN 0 AND 200),
    finished_at TIMESTAMPTZ NOT NULL,
    result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    PRIMARY KEY (match_id, user_id)
);
CREATE INDEX idx_word_chain_results_user_finished ON public.word_chain_results(user_id, finished_at DESC);
