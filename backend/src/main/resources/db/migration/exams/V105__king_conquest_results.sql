-- Soán ngôi (King Of English · Crown Conquest) completed-match results: one row per human player per match, written by the
-- server from its own room state after the match ended by time or by the word cap (never a client score). Feeds the
-- per-board-size Top 5 and the learner's personal best. Additive; no existing table changes.
CREATE TABLE public.king_conquest_results (
    match_id UUID NOT NULL,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    board_size SMALLINT NOT NULL CHECK (board_size BETWEEN 4 AND 7),
    category VARCHAR(8) NOT NULL CHECK (category IN ('SOLO', 'DUEL')),
    flow VARCHAR(16) NOT NULL CHECK (flow IN ('SOLO', 'ECHO', 'QUICK_MATCH', 'PRIVATE_ROOM')),
    score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 200),
    word_count INTEGER NOT NULL CHECK (word_count BETWEEN 0 AND 180),
    territory INTEGER NOT NULL CHECK (territory BETWEEN 0 AND 49),
    throne BOOLEAN NOT NULL,
    won BOOLEAN,
    finished_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (match_id, user_id)
);
CREATE INDEX idx_king_conquest_results_board ON public.king_conquest_results(board_size, category, score DESC, finished_at);
CREATE INDEX idx_king_conquest_results_user ON public.king_conquest_results(user_id, board_size, category, score DESC);
-- V94's default privileges grant rows-only access to new public tables; no runtime DDL.
