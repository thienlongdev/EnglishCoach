-- Echo Life — the learner's world around the study room (owner brief 2026-11-20, phase 2). Additive only: no existing
-- table, row or rule changes.
--
-- One row per learner: the world state the learner's own client keeps (where the body stands outside a study room, which
-- house doors were left open, things carried out of a room and set down in the house). It is NEVER the study-space layout
-- (study_spaces.layout stays the room's own record) and NEVER a value store: credits, purchases, owned progression items and
-- story rewards are not part of this document and are never accepted from it.
--
-- `state` is validated and bounded by EchoLifeService (shape, numbers, ids of the learner's own spaces); `save_version` names
-- the document's schema so the service can upgrade an older document on read; `revision` is the optimistic-concurrency
-- counter (a stale write answers 409 with the current document so the client can merge).
CREATE TABLE IF NOT EXISTS public.echo_life_worlds (
    user_id      BIGINT       PRIMARY KEY REFERENCES public.users (id) ON DELETE RESTRICT,
    save_version SMALLINT     NOT NULL DEFAULT 1 CHECK (save_version >= 1),
    revision     BIGINT       NOT NULL DEFAULT 1 CHECK (revision >= 1),
    state        JSONB        NOT NULL CHECK (jsonb_typeof(state) = 'object' AND octet_length(state::text) <= 131072),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
