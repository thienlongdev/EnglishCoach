-- Echo Neural Cosmos (owner brief 2026-11-13) — the deterministic extraction cache of learning sources.
-- Additive only: one new table, no existing row, column or rule changed.
--
-- A source the learner completed (Reading material, Listening lesson) or wrote / said (Writing practice submission,
-- Speaking quick check) is tokenized ONCE per content fingerprint and extractor version: lower-case word forms and
-- adjacent two-word forms, no text, no positions. The client matches them against the words the learner knows
-- ("appears in source" / "you used it"); a relation is never stored here.
--
-- owner_user_id: NULL only for SYSTEM sources (is_system = true AND owner_user_id IS NULL); a personal source, a writing
-- submission or a speaking check carries its owner. Every read joins the LIVE source row with its visibility rule, so a
-- deleted or quarantined source is never served from this cache. Derived data: rows may be rebuilt, never trusted alone.

CREATE TABLE IF NOT EXISTS public.cosmos_source_tokens (
    source_kind varchar(16) NOT NULL,
    source_id bigint NOT NULL,
    owner_user_id bigint REFERENCES public.users(id) ON DELETE RESTRICT,
    content_sha256 char(64) NOT NULL,
    extractor_version integer NOT NULL,
    token_count integer NOT NULL,
    tokens text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source_kind, source_id, extractor_version),
    CONSTRAINT chk_cosmos_source_kind CHECK (source_kind IN ('READING', 'LISTENING', 'WRITING', 'SPEAKING')),
    CONSTRAINT chk_cosmos_source_tokens_len CHECK (char_length(tokens) <= 200000 AND token_count BETWEEN 0 AND 20000),
    CONSTRAINT chk_cosmos_source_private_owner CHECK (source_kind IN ('READING', 'LISTENING') OR owner_user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_cosmos_source_tokens_owner
    ON public.cosmos_source_tokens (owner_user_id) WHERE owner_user_id IS NOT NULL;
