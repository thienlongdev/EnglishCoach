-- V43__pvp_tables.sql
-- Card Blast Real-time 1v1 PvP: Match Records, Stats, Missed Words & Elo Ratings

CREATE TABLE IF NOT EXISTS public.pvp_matches (
    id BIGSERIAL PRIMARY KEY,
    room_code VARCHAR(10),
    deck_id BIGINT,
    mode VARCHAR(20),
    seed BIGINT,
    host_user_id BIGINT,
    guest_user_id BIGINT,
    winner_user_id BIGINT,
    result VARCHAR(20),
    end_reason VARCHAR(30),
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    duration_ms BIGINT,
    host_score INT,
    guest_score INT,
    is_ranked BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.pvp_player_stats (
    id BIGSERIAL PRIMARY KEY,
    match_id BIGINT REFERENCES public.pvp_matches(id) ON DELETE CASCADE,
    user_id BIGINT,
    hits INT,
    misses INT,
    best_streak INT,
    avg_reaction_ms INT,
    golden_captured INT,
    attacks_sent INT,
    attacks_received INT,
    skills_used INT
);

CREATE TABLE IF NOT EXISTS public.pvp_missed_words (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT,
    word_id BIGINT,
    match_id BIGINT REFERENCES public.pvp_matches(id) ON DELETE CASCADE,
    missed_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pvp_ratings (
    user_id BIGINT PRIMARY KEY,
    rating INT DEFAULT 1000,
    wins INT DEFAULT 0,
    losses INT DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pvp_matches_room_code ON public.pvp_matches (room_code);
CREATE INDEX IF NOT EXISTS idx_pvp_matches_host_guest ON public.pvp_matches (host_user_id, guest_user_id);
CREATE INDEX IF NOT EXISTS idx_pvp_matches_ended_at ON public.pvp_matches (ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_pvp_player_stats_match_id ON public.pvp_player_stats (match_id);
CREATE INDEX IF NOT EXISTS idx_pvp_player_stats_user_id ON public.pvp_player_stats (user_id);
CREATE INDEX IF NOT EXISTS idx_pvp_missed_words_user_match ON public.pvp_missed_words (user_id, match_id);
