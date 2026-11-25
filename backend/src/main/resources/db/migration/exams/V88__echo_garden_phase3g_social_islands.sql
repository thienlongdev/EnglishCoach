-- V88: Echo Garden Phase 3G — social islands: discovery of real garden players, read-only island visits, the limited
-- "take a little" of a ripe crop, and the island activity record.
-- docs/echo-garden/PHASE3G_SOCIAL_ISLANDS_PRODUCTION_REPORT.md
--
-- Additive only. V1–V87 are applied and are not edited. No column is added to, removed from or retyped on an existing
-- table and no existing row is changed: everything new lives in three new tables and one new garden_config key.
-- A backend on this schema without the `social` key behaves exactly like Phase 3F.
--
-- Rules written into the schema (the service checks them first; the database refuses a bug):
--   * a garden is discoverable / visitable only while its own row says PUBLIC; the public identifier is a random handle,
--     never an account id;
--   * a crop (planting) is taken from at most ONCE, by another player, and never for more than one tenth of one produce
--     unit; the record names the real taker and the real owner of that planting and is append-only;
--   * one visit row per (visitor, host): history is bounded by the number of islands, not by the number of visits.

-- =====================================================================================================================
-- A. Public garden identity and visit eligibility
-- =====================================================================================================================
-- display_name / name_key are a snapshot of the product's existing public name (profile display name, else account
-- name, e-mail-like text removed), refreshed when the owner opens their garden: discovery and search read this table
-- only and never scan the account tables. last_active_at orders the discovery list.
CREATE TABLE IF NOT EXISTS public.garden_social_profile (
    user_id BIGINT PRIMARY KEY REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    handle VARCHAR(8) NOT NULL,
    visibility VARCHAR(8) NOT NULL DEFAULT 'PUBLIC',
    visibility_changed_at TIMESTAMPTZ NOT NULL,
    display_name VARCHAR(80) NOT NULL,
    name_key VARCHAR(80) NOT NULL,
    last_active_at TIMESTAMPTZ NOT NULL,
    activity_seen_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_garden_social_handle UNIQUE (handle),
    CONSTRAINT ck_garden_social_handle CHECK (handle ~ '^[A-HJ-NP-Z2-9]{8}$'),
    CONSTRAINT ck_garden_social_visibility CHECK (visibility IN ('PUBLIC','PRIVATE')),
    CONSTRAINT ck_garden_social_name CHECK (length(btrim(display_name)) > 0)
);
-- discovery: newest activity first, keyset on (last_active_at, handle); search: prefix of the folded name
CREATE INDEX IF NOT EXISTS ix_garden_social_discover ON public.garden_social_profile(last_active_at DESC, handle DESC)
    WHERE visibility = 'PUBLIC';
CREATE INDEX IF NOT EXISTS ix_garden_social_name ON public.garden_social_profile(name_key text_pattern_ops, handle)
    WHERE visibility = 'PUBLIC';

-- =====================================================================================================================
-- B. Visit history (one row per visitor and host) and the single friendly reaction a visitor may leave
-- =====================================================================================================================
CREATE TABLE IF NOT EXISTS public.garden_visit (
    visitor_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    host_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    first_visit_at TIMESTAMPTZ NOT NULL,
    last_visit_at TIMESTAMPTZ NOT NULL,
    visits INTEGER NOT NULL DEFAULT 1,
    reaction_code VARCHAR(24),
    reaction_at TIMESTAMPTZ,
    PRIMARY KEY (visitor_id, host_id),
    CONSTRAINT ck_garden_visit_parties CHECK (visitor_id <> host_id),
    CONSTRAINT ck_garden_visit_count CHECK (visits >= 1),
    CONSTRAINT ck_garden_visit_reaction CHECK ((reaction_code IS NULL) = (reaction_at IS NULL)),
    CONSTRAINT ck_garden_visit_reaction_code CHECK (reaction_code IS NULL OR reaction_code ~ '^[A-Z_]{1,24}$')
);
CREATE INDEX IF NOT EXISTS ix_garden_visit_visitor ON public.garden_visit(visitor_id, last_visit_at DESC);
CREATE INDEX IF NOT EXISTS ix_garden_visit_host_reaction ON public.garden_visit(host_id, reaction_at DESC)
    WHERE reaction_at IS NOT NULL;

-- =====================================================================================================================
-- C. The "take a little" record (append-only)
-- =====================================================================================================================
-- One produce unit is `unit_portions` harvest portions. A taker receives `portions` of them; the owner's harvest of
-- that planting then pays `unit_portions - portions` portions instead of the whole unit, so
-- taker + owner = one unit, always. The composite foreign key proves the planting belongs to the recorded owner.
CREATE TABLE IF NOT EXISTS public.garden_theft (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    victim_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    thief_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    planting_id BIGINT NOT NULL,
    crop_code VARCHAR(40) NOT NULL REFERENCES public.garden_crop_def(code) ON DELETE RESTRICT,
    portions SMALLINT NOT NULL,
    unit_portions SMALLINT NOT NULL,
    op_key UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT fk_garden_theft_planting_owner FOREIGN KEY (planting_id, victim_id)
        REFERENCES public.garden_planting(id, user_id) ON DELETE RESTRICT,
    CONSTRAINT uq_garden_theft_planting UNIQUE (planting_id),
    CONSTRAINT uq_garden_theft_op UNIQUE (thief_id, op_key),
    CONSTRAINT ck_garden_theft_parties CHECK (victim_id <> thief_id),
    CONSTRAINT ck_garden_theft_small CHECK (portions >= 1 AND unit_portions >= 2 AND portions * 10 <= unit_portions)
);
CREATE INDEX IF NOT EXISTS ix_garden_theft_victim ON public.garden_theft(victim_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_garden_theft_thief ON public.garden_theft(thief_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_garden_theft_append_only ON public.garden_theft;
CREATE TRIGGER trg_garden_theft_append_only BEFORE UPDATE OR DELETE ON public.garden_theft
    FOR EACH ROW EXECUTE FUNCTION public.garden_append_only();

-- =====================================================================================================================
-- D. Rules (numbers live here, never in code; a change is a new migration)
-- =====================================================================================================================
-- portionsPerUnit: harvest portions in one produce unit. theft.fractionBp: share of the remaining portions one take may
-- carry (1000 = 10 %, rounded down; a crop with nothing left to give is not eligible). Limits count SUCCESSFUL takes in
-- a rolling windowHours: thiefCap per taker over all islands, pairCap per taker and island, victimCap per island.
-- shieldHours: the island is protected after a take. introHours: a garden new to the social islands is protected and
-- cannot take. reopenHours: an island that was just re-opened cannot take. ripeGraceMinutes: the owner's head start on
-- a crop that just ripened. excludedCrops: never taken (the QA crop; the graduation-only Legendary).
INSERT INTO public.garden_config (key, value) VALUES ('social', '{
  "portionsPerUnit": 10,
  "theft": {
    "fractionBp": 1000,
    "windowHours": 24,
    "thiefCap": 3,
    "pairCap": 1,
    "victimCap": 2,
    "shieldHours": 6,
    "introHours": 72,
    "reopenHours": 24,
    "ripeGraceMinutes": 20,
    "excludedCrops": ["QA_SPROUT", "CRYSTAL_ORCHID"]
  },
  "discovery": {"pageSize": 12, "searchLimit": 20, "minQuery": 2},
  "visits": {"historyLimit": 30},
  "activity": {"pageSize": 20, "reactionLimit": 10},
  "reactions": {"codes": ["GARDEN_BEAUTIFUL", "GOOD_HARVEST", "GREAT_TREE"], "cooldownHours": 24}
}'::jsonb)
ON CONFLICT (key) DO NOTHING;
