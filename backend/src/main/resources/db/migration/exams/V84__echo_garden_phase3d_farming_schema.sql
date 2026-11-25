-- Echo Garden Phase 3D (farming economy 2.0) - SCHEMA ONLY. docs/echo-garden/PHASE3D_FARMING_ECONOMY_REPORT.md.
-- Additive: V77 / V78 / V80 / V82 / V83 are applied in production and never edited (V79 / V81 belong to Echo Quiz Rush).
-- No rule, price or balance changes here: the Phase 3D rules are seeded by V85. A backend that runs on this schema
-- without the V85 `farming` configuration behaves exactly like Phase 3C.
-- Schema public, owner FKs ON DELETE RESTRICT, no write to any other module. Applied only by normal application
-- startup (never manually).

-- ===== growth model of a planting =====
-- 1 = the Phase 1-3C growth rules (season, weather speed, pests). 2 = Phase 3D: the same plus soil moisture.
-- Every planting that exists when this migration runs keeps model 1 for its whole life, so a crop planted under the
-- old rules can never slow down, lose progress or become unripe because the rules changed. Only new plantings get 2.
ALTER TABLE public.garden_planting
    ADD COLUMN IF NOT EXISTS growth_model SMALLINT NOT NULL DEFAULT 1 CHECK (growth_model IN (1, 2));

-- ===== small harvest coin bonus: coins granted per Vietnam day (the daily cap is enforced against this counter) =====
ALTER TABLE public.garden_daily_stats
    ADD COLUMN IF NOT EXISTS harvest_bonus_coins INTEGER NOT NULL DEFAULT 0 CHECK (harvest_bonus_coins >= 0);

-- ===== farming supplies applied to a planting (covers, drainage, mulch, nets, sprays, tonics, well water) =====
-- One row per item consumed. `expires_at` NULL = the effect lasts until the planting is harvested (or is instant).
-- Rows are facts: never updated, never deleted. An expired row can never be extended, so a new effect always costs a
-- new item (taken from the inventory in the same transaction, with a ledger entry and an idempotency receipt).
CREATE TABLE IF NOT EXISTS public.garden_treatment (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    planting_id BIGINT NOT NULL,
    item_code VARCHAR(40) NOT NULL REFERENCES public.garden_item_def(code) ON DELETE RESTRICT,
    applied_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ,
    op_key UUID NOT NULL,
    -- a supply can only ever be applied to a planting of the same owner
    CONSTRAINT fk_garden_treatment_planting_owner FOREIGN KEY (planting_id, user_id)
        REFERENCES public.garden_planting(id, user_id) ON DELETE RESTRICT,
    CONSTRAINT ck_garden_treatment_window CHECK (expires_at IS NULL OR expires_at > applied_at),
    -- one command applies one item once
    CONSTRAINT uq_garden_treatment_op UNIQUE (user_id, op_key)
);
CREATE INDEX IF NOT EXISTS ix_garden_treatment_planting ON public.garden_treatment(planting_id);
CREATE INDEX IF NOT EXISTS ix_garden_treatment_user_time ON public.garden_treatment(user_id, applied_at);

CREATE OR REPLACE FUNCTION public.garden_treatment_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'garden_treatment is append-only';
END $$;
DROP TRIGGER IF EXISTS trg_garden_treatment_append_only ON public.garden_treatment;
CREATE TRIGGER trg_garden_treatment_append_only BEFORE UPDATE OR DELETE ON public.garden_treatment
    FOR EACH ROW EXECUTE FUNCTION public.garden_treatment_append_only();

-- farm records (GET /records) aggregate one owner's ledger by asset and reason
CREATE INDEX IF NOT EXISTS ix_garden_ledger_user_asset_reason ON public.garden_ledger(user_id, asset, reason);
