-- Echo Life — Phase 3 + 4: the learner's game (owner brief 2026-11-20, phases 3 and 4). Additive only: no existing table, row
-- or rule changes; the V129 world save (places, doors, carried room objects) is untouched and still holds no value.
--
-- echo_life_games: one row per learner.
--   doc      the narrative save the learner's own client keeps — the vendored V3 game document (story, side arcs, choices,
--            relationships and memory, tutorial, exploration, inventory of ingredients, owned-object placement) plus the
--            residents' places. Validated and bounded by EchoLifeGameService; the owner inside it must be the learner and every
--            owned object must be a starter object or one this table's ledger says the learner bought.
--   credits / skills (XP per skill) / earned_* — the AUTHORITATIVE economy. Never read from `doc`: the client's numbers are
--            overwritten by these. Rewards change them only through echo_life_claims, purchases through echo_life_owned.
-- echo_life_claims: one row per unique reward a learner received (mission, side arc, story choice, landmark, keepsake): the
--            primary key makes a replayed or duplicated claim grant nothing.
-- echo_life_owned:  the purchase ledger: server-made instance ids, catalogue price paid, sold or owned. A request id makes a
--            retried purchase answer the first purchase instead of buying twice.
CREATE TABLE IF NOT EXISTS public.echo_life_games (
    user_id         BIGINT       PRIMARY KEY REFERENCES public.users (id) ON DELETE RESTRICT,
    save_version    SMALLINT     NOT NULL DEFAULT 1 CHECK (save_version >= 1),
    revision        BIGINT       NOT NULL DEFAULT 1 CHECK (revision >= 1),
    doc             JSONB        CHECK (doc IS NULL OR (jsonb_typeof(doc) = 'object' AND octet_length(doc::text) <= 524288)),
    credits         INTEGER      NOT NULL CHECK (credits >= 0 AND credits <= 10000000),
    skills          JSONB        NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(skills) = 'object'),
    earned_day      DATE,
    earned_credits  INTEGER      NOT NULL DEFAULT 0 CHECK (earned_credits >= 0),
    earned_xp       INTEGER      NOT NULL DEFAULT 0 CHECK (earned_xp >= 0),
    lifetime_earned BIGINT       NOT NULL DEFAULT 0 CHECK (lifetime_earned >= 0),
    lifetime_spent  BIGINT       NOT NULL DEFAULT 0 CHECK (lifetime_spent >= 0),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.echo_life_claims (
    user_id    BIGINT       NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
    claim_key  VARCHAR(96)  NOT NULL CHECK (claim_key ~ '^(mission|side|choice|landmark|relic):[a-z0-9_:]{1,88}$'),
    credits    INTEGER      NOT NULL CHECK (credits >= 0),
    xp         INTEGER      NOT NULL CHECK (xp >= 0),
    claimed_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, claim_key)
);

CREATE TABLE IF NOT EXISTS public.echo_life_owned (
    instance_id VARCHAR(40)  PRIMARY KEY CHECK (instance_id ~ '^ec_[0-9a-f]{20}$'),
    user_id     BIGINT       NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
    store_id    VARCHAR(40)  NOT NULL,
    sku         VARCHAR(96)  NOT NULL,
    item_type   VARCHAR(24)  NOT NULL,
    price       INTEGER      NOT NULL CHECK (price >= 0),
    status      VARCHAR(8)   NOT NULL DEFAULT 'OWNED' CHECK (status IN ('OWNED', 'SOLD')),
    request_id  VARCHAR(64)  NOT NULL,
    refund      INTEGER      CHECK (refund IS NULL OR refund >= 0),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    sold_at     TIMESTAMPTZ,
    CONSTRAINT echo_life_owned_request UNIQUE (user_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_echo_life_owned_user ON public.echo_life_owned (user_id, status);
