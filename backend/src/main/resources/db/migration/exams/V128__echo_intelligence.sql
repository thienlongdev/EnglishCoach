-- Echo Intelligence 7.0 (features/echo-coach). Additive only: no existing table, row or rule changes.
--
-- 1. echo_learner_memory: what the learner explicitly told Echo to remember (preferences, a stated goal, interests).
--    It is NEVER learning evidence: no CEFR, score, band, mastery or leaderboard value is ever read from it. Owner-scoped,
--    listable and deletable by the learner; at most one row per kind except INTEREST / NOTE (bounded in the service).
-- 2. echo_ai_turns: one row per answered Echo turn with the route, model, token counts, provider-reported cost and latency.
--    No message text, no prompt, no tool payload is stored.

CREATE TABLE public.echo_learner_memory (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    kind        VARCHAR(24) NOT NULL CHECK (kind IN ('EXPLANATION_LANGUAGE','ANSWER_STYLE','LEVEL_PREFERENCE','FOCUS_SKILL',
                                                      'STATED_GOAL','INTEREST','NOTE')),
    value       VARCHAR(200) NOT NULL CHECK (length(btrim(value)) BETWEEN 1 AND 200),
    source      VARCHAR(16) NOT NULL DEFAULT 'LEARNER_STATED' CHECK (source = 'LEARNER_STATED'),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_echo_learner_memory_owner ON public.echo_learner_memory(user_id, updated_at DESC);
CREATE UNIQUE INDEX uq_echo_learner_memory_single_kind ON public.echo_learner_memory(user_id, kind)
    WHERE kind NOT IN ('INTEREST','NOTE');

CREATE TABLE public.echo_ai_turns (
    id                 BIGSERIAL PRIMARY KEY,
    user_id            BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    channel            VARCHAR(8)  NOT NULL CHECK (channel IN ('TEXT','VOICE')),
    route              VARCHAR(12) NOT NULL CHECK (route IN ('DIRECT','FAST','STRONG','GUARD')),
    intent             VARCHAR(32) NOT NULL,
    model              VARCHAR(96),
    provider_calls     SMALLINT NOT NULL DEFAULT 0 CHECK (provider_calls BETWEEN 0 AND 10),
    tool_calls         SMALLINT NOT NULL DEFAULT 0 CHECK (tool_calls BETWEEN 0 AND 20),
    prompt_tokens      INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
    completion_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
    cached_tokens      INTEGER NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0),
    cost_usd           NUMERIC(12,8) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
    latency_ms         INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
    outcome            VARCHAR(16) NOT NULL CHECK (outcome IN ('ANSWERED','FILTERED','FAILED','REFUSED'))
);
CREATE INDEX idx_echo_ai_turns_owner_time ON public.echo_ai_turns(user_id, created_at DESC);
CREATE INDEX idx_echo_ai_turns_time ON public.echo_ai_turns(created_at);
