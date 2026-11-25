-- Hangman V4, additive schema only. The immutable classpath catalog owns levels;
-- each round snapshots its answer/version. No seed runner or other domain writes.
CREATE TABLE IF NOT EXISTS public.hangman_progress (
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    difficulty VARCHAR(6) NOT NULL CHECK (difficulty IN ('EASY','MEDIUM','HARD')),
    highest_unlocked INTEGER NOT NULL DEFAULT 1 CHECK (highest_unlocked > 0),
    last_played_level INTEGER NOT NULL DEFAULT 1 CHECK (last_played_level > 0),
    catalog_completed BOOLEAN NOT NULL DEFAULT FALSE,
    current_round_id UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, difficulty)
);
CREATE TABLE IF NOT EXISTS public.hangman_rounds (
    id UUID PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    difficulty VARCHAR(6) NOT NULL CHECK (difficulty IN ('EASY','MEDIUM','HARD')),
    level_number INTEGER NOT NULL CHECK (level_number > 0),
    answer VARCHAR(10) NOT NULL CHECK (answer ~ '^[A-Z]{4,10}$'),
    answer_version VARCHAR(40) NOT NULL,
    category VARCHAR(20) NOT NULL,
    prefilled_letters VARCHAR(2) NOT NULL,
    guessed_letters VARCHAR(26) NOT NULL DEFAULT '',
    hinted_letters VARCHAR(2) NOT NULL DEFAULT '',
    remaining_balloons INTEGER NOT NULL,
    status VARCHAR(6) NOT NULL CHECK (status IN ('ACTIVE','WON','LOST')),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    CONSTRAINT ck_hangman_balloons CHECK (remaining_balloons BETWEEN 0 AND CASE difficulty WHEN 'EASY' THEN 10 WHEN 'MEDIUM' THEN 9 ELSE 8 END),
    CONSTRAINT ck_hangman_prefill CHECK (length(prefilled_letters) = CASE difficulty WHEN 'EASY' THEN 2 WHEN 'MEDIUM' THEN 1 ELSE 0 END),
    CONSTRAINT ck_hangman_letters CHECK (prefilled_letters ~ '^[A-Z]*$' AND guessed_letters ~ '^[A-Z]*$' AND hinted_letters ~ '^[A-Z]*$'),
    CONSTRAINT ck_hangman_terminal CHECK ((status='ACTIVE' AND remaining_balloons>0 AND completed_at IS NULL) OR (status='WON' AND remaining_balloons>0 AND completed_at IS NOT NULL) OR (status='LOST' AND remaining_balloons=0 AND completed_at IS NOT NULL)),
    CONSTRAINT uq_hangman_round_owner UNIQUE (id,user_id,difficulty)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hangman_one_active_track ON public.hangman_rounds(user_id,difficulty) WHERE status='ACTIVE';
CREATE INDEX IF NOT EXISTS idx_hangman_owner_rounds ON public.hangman_rounds(user_id,difficulty,created_at DESC);
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hangman_current_round' AND conrelid='public.hangman_progress'::regclass) THEN
      ALTER TABLE public.hangman_progress ADD CONSTRAINT fk_hangman_current_round FOREIGN KEY(current_round_id,user_id,difficulty) REFERENCES public.hangman_rounds(id,user_id,difficulty) ON DELETE RESTRICT;
    END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.hangman_command_receipts (
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    request_id UUID NOT NULL,
    command_key VARCHAR(160) NOT NULL,
    result_round_id UUID NOT NULL REFERENCES public.hangman_rounds(id) ON DELETE RESTRICT,
    PRIMARY KEY(user_id,request_id)
);
CREATE INDEX IF NOT EXISTS idx_hangman_receipt_round ON public.hangman_command_receipts(result_round_id);
