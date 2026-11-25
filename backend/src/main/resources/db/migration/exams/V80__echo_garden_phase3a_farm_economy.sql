-- Echo Garden Phase 3A (farm economy): market stall, delivery board, four expansion beds, calibrated harvest-XP band.
-- docs/echo-garden/PHASE3_SYSTEM_BLUEPRINT.md §6, numbers from docs/echo-garden/PHASE3A_ECONOMY_SIM_RESULTS.md.
-- Additive only: V77 / V78 are applied in production and never edited; V79 belongs to Echo Quiz Rush (source).
-- Schema public, owner FKs ON DELETE RESTRICT. Expansion beds reuse public.garden_plot (slots 7..10); no new
-- currency, no XP source, no write to any other module. Applied only by normal application startup (never manually).

-- ===== market: per-player, per-Vietnam-day purchase counters (caps enforced by a conditional upsert) =====
CREATE TABLE IF NOT EXISTS public.garden_market_purchase (
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    day_key DATE NOT NULL,
    offer_code VARCHAR(48) NOT NULL,
    units INTEGER NOT NULL CHECK (units > 0),
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, day_key, offer_code)
);

-- ===== delivery board: one materialized order per (player, slot, period); requirements and rewards are frozen =====
CREATE TABLE IF NOT EXISTS public.garden_order (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    slot SMALLINT NOT NULL CHECK (slot BETWEEN 1 AND 9),
    kind VARCHAR(8) NOT NULL CHECK (kind IN ('DAILY','WEEKLY')),
    period_key VARCHAR(16) NOT NULL,
    lines JSONB NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) BETWEEN 1 AND 4),
    base_coins BIGINT NOT NULL CHECK (base_coins >= 0),
    bonus JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(bonus) = 'object'),
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(8) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','FILLED')),
    filled_at TIMESTAMPTZ,
    paid_coins BIGINT CHECK (paid_coins >= 0),
    blessing BOOLEAN,
    delivered JSONB,
    fill_op UUID,
    CONSTRAINT uq_garden_order_period UNIQUE (user_id, slot, period_key),
    CONSTRAINT uq_garden_order_owner UNIQUE (id, user_id),
    CONSTRAINT ck_garden_order_window CHECK (expires_at > created_at),
    -- a delivery happens once, before expiry, and records exactly what was paid and consumed
    CONSTRAINT ck_garden_order_fill CHECK (
        (status = 'OPEN' AND filled_at IS NULL AND paid_coins IS NULL AND blessing IS NULL AND delivered IS NULL AND fill_op IS NULL)
        OR (status = 'FILLED' AND filled_at IS NOT NULL AND filled_at < expires_at AND paid_coins IS NOT NULL
            AND blessing IS NOT NULL AND delivered IS NOT NULL AND fill_op IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_garden_order_user_recent ON public.garden_order(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_garden_order_user_filled ON public.garden_order(user_id) WHERE status = 'FILLED';

-- frozen orders: never deleted; the only allowed change is OPEN -> FILLED with every requirement column unchanged
CREATE OR REPLACE FUNCTION public.garden_order_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'garden_order rows are never deleted';
    END IF;
    IF OLD.status <> 'OPEN' OR NEW.status <> 'FILLED'
       OR NEW.user_id <> OLD.user_id OR NEW.slot <> OLD.slot OR NEW.kind <> OLD.kind OR NEW.period_key <> OLD.period_key
       OR NEW.lines <> OLD.lines OR NEW.base_coins <> OLD.base_coins OR NEW.bonus <> OLD.bonus
       OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at THEN
        RAISE EXCEPTION 'garden_order is frozen: only OPEN -> FILLED is allowed';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_garden_order_frozen ON public.garden_order;
CREATE TRIGGER trg_garden_order_frozen BEFORE UPDATE OR DELETE ON public.garden_order
    FOR EACH ROW EXECUTE FUNCTION public.garden_order_frozen();

-- ===== fixed-shop care items (V77 seeded them as "Phase 3 shop data"): water stays the Flashcard resource =====
UPDATE public.garden_item_def SET in_fixed_shop = FALSE WHERE code = 'WATER' AND in_fixed_shop;
UPDATE public.garden_item_def SET daily_cap = 2 WHERE code = 'FERTILIZER' AND daily_cap = 5;
UPDATE public.garden_item_def SET unlock_level = 5 WHERE code = 'FERTILIZER_PREMIUM' AND unlock_level = 1;

-- ===== Phase 3A configuration =====
INSERT INTO public.garden_config (key, value) VALUES
    ('market', '{"featuredSlots":2,"packSize":5,"packDiscount":0.10,"packDailyCap":1,"maxPerPurchase":5}'),
    ('orders', '{"dailySlots":2,"weeklySlots":1,"coinMultiplier":1.15,"growShare":0.5,"historyLimit":20,
                 "daily":{"minLevel":1,"lines":[1,2],"multiLineLevel":5,"qty":[3,8],"bonus":{},"seedBonus":2,"goodTierLevel":0},
                 "weekly":{"minLevel":3,"lines":[2,2],"multiLineLevel":1,"qty":[6,12],"bonus":{"FERTILIZER_PREMIUM":1},
                           "seedBonus":3,"goodTierLevel":8}}'),
    -- the four owner-approved cells (2026-10-10): slots 7..10, sequential; the other future fields stay reserved
    ('expansion', '{"plots":[
                     {"slot":7,"cell":[8,16],"field":"north_strip","level":5,"coins":3000,"compost":{"WHEAT":8}},
                     {"slot":8,"cell":[9,16],"field":"north_strip","level":7,"coins":12000,"compost":{"TOMATO":6,"CORN":6}},
                     {"slot":9,"cell":[10,16],"field":"north_strip","level":9,"coins":30000,"compost":{"CORN":8,"STRAWBERRY":5}},
                     {"slot":10,"cell":[6,18],"field":"west_tilled","level":11,"coins":60000,"compost":{"CORN":10,"ROSE":5}}]}')
ON CONFLICT (key) DO NOTHING;

-- calibration (PHASE3A_ECONOMY_SIM_RESULTS.md): four more beds add harvest volume; the second band of the daily
-- harvest-XP schedule shrinks from 120 to 90 raw XP so farming volume still cannot outrun learning
-- (P1 level 10 stays on day 21, P2 on day 14). Coins and learning XP are unchanged.
UPDATE public.garden_config SET value = '[[40,1.0],[90,0.4],[999999,0.05]]'
WHERE key = 'harvest.dailyXp' AND value = '[[40,1.0],[120,0.4],[999999,0.05]]'::jsonb;
