-- Echo Spelling only. Additive; no existing records, game rules or Sentinel legacy approvals change.
CREATE TABLE public.spelling_results (
    match_id UUID NOT NULL,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    mode VARCHAR(16) NOT NULL CHECK (mode IN ('MULTIPLAYER','ENDLESS','SPRINT','PRACTICE')),
    difficulty VARCHAR(8) NOT NULL CHECK (difficulty IN ('EASY','MEDIUM','HARD')),
    rules_version VARCHAR(32) NOT NULL,
    score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 10000000),
    correct INTEGER NOT NULL CHECK (correct BETWEEN 0 AND 400),
    wrong INTEGER NOT NULL CHECK (wrong BETWEEN 0 AND 400),
    max_streak INTEGER NOT NULL CHECK (max_streak BETWEEN 0 AND 400),
    highest_wpm NUMERIC(8,1) NOT NULL CHECK (highest_wpm BETWEEN 0 AND 10000),
    accuracy NUMERIC(4,1) NOT NULL CHECK (accuracy BETWEEN 0 AND 100),
    duration_ms BIGINT NOT NULL CHECK (duration_ms BETWEEN 0 AND 3600000),
    won BOOLEAN NOT NULL,
    eligible BOOLEAN NOT NULL,
    integrity VARCHAR(32) NOT NULL,
    sentinel_attempt_id UUID UNIQUE REFERENCES public.sentinel_attempts(id) ON DELETE RESTRICT,
    finished_at TIMESTAMPTZ NOT NULL,
    review JSONB NOT NULL CHECK (jsonb_typeof(review)='array'),
    PRIMARY KEY (match_id,user_id)
);
CREATE INDEX idx_spelling_results_owner ON public.spelling_results(user_id,finished_at DESC);
CREATE INDEX idx_spelling_results_board ON public.spelling_results(mode,difficulty,score DESC) WHERE eligible;
CREATE FUNCTION public.spelling_results_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Spelling results are immutable'; END IF;
    IF NEW.eligible AND (NEW.mode='PRACTICE' OR NOT EXISTS (
        SELECT 1 FROM public.sentinel_attempts a WHERE a.id=NEW.sentinel_attempt_id
          AND a.user_id=NEW.user_id AND a.activity='ECHO_SPELLING'
          AND a.state='COMPLETED_VERIFIED' AND a.subject_ref=NEW.match_id::text
    )) THEN RAISE EXCEPTION 'Verified spelling attempt required'; END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER spelling_results_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.spelling_results
FOR EACH ROW EXECUTE FUNCTION public.spelling_results_guard();

