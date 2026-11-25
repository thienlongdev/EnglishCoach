-- V86: Echo Garden Phase 3E — cosmetics: collections, fifty further crop cultivars, house families, island vegetation,
-- monument ornament sets, placeable decorations, fence / path / raised-bed styles, and the closed real-money boundary.
-- docs/echo-garden/PHASE3E_COSMETICS_AND_ARCHITECTURE_REPORT.md · prices: PHASE3E_COSMETIC_ECONOMY.md
--
-- Additive only. V77–V85 are applied and are not touched: every earlier table, row, balance, plot, planting, skin and
-- learning record stays exactly as it is. A garden that never opens the cosmetic shop is byte-for-byte the Phase 3D
-- garden (no row is written for it by this migration).
--
-- Rules written into the schema (the service checks them first; the database refuses a bug):
--   * a cosmetic is ART ONLY: nothing here is read by growth, quality, price, XP, weather, pests, land or learning;
--   * ownership is per account, never deleted by play; a permanent appearance is owned once, a decoration up to its
--     `max_owned` units (each unit is one acquisition row with its own idempotency key);
--   * only an owned appearance of the right category can be equipped, one per slot;
--   * a decoration unit stands at most once, on a snapped point, and only while its owner holds that unit;
--   * a coin item has a price and no other gate; an earned item has a requirement and no price (it cannot be bought);
--   * the direct-purchase tables are a CLOSED boundary: no SKU is seeded, a SKU cannot be enabled without a price, an
--     order only moves forward and is never deleted. No payment provider is called from the garden.

-- ===== collections (catalogue, read-only at runtime) =====
CREATE TABLE IF NOT EXISTS public.garden_collection_def (
    code VARCHAR(24) PRIMARY KEY,
    name_vi VARCHAR(80) NOT NULL,
    description_vi VARCHAR(240) NOT NULL,
    sort_order INTEGER NOT NULL
);

-- crop cultivars join a collection (the six Phase 3B / 3C cultivars keep NULL: they belong to no collection)
ALTER TABLE public.garden_skin_def ADD COLUMN IF NOT EXISTS collection_code VARCHAR(24);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_garden_skin_collection') THEN
        ALTER TABLE public.garden_skin_def ADD CONSTRAINT fk_garden_skin_collection FOREIGN KEY (collection_code)
            REFERENCES public.garden_collection_def(code) ON DELETE RESTRICT;
    END IF;
END $$;

-- ===== cosmetic catalogue =====
-- category = the slot it is equipped in (HOUSE, TREE, SHRUB, FLOWER, MONUMENT, FENCE, PATH, BED) or DECOR (placed).
-- unlock_kind: COIN (bought for coin_price) or an earned path with `requirement` — LEARNING = verified learning days,
-- HARVESTS = lifetime harvests, GRADUATIONS = graduated memory trees. Earned items are never sold.
CREATE TABLE IF NOT EXISTS public.garden_cosmetic_def (
    code VARCHAR(40) PRIMARY KEY,
    category VARCHAR(10) NOT NULL CHECK (category IN ('HOUSE','TREE','SHRUB','FLOWER','MONUMENT','FENCE','PATH','BED','DECOR')),
    family VARCHAR(10) NOT NULL,
    collection_code VARCHAR(24) NOT NULL REFERENCES public.garden_collection_def(code) ON DELETE RESTRICT,
    name_vi VARCHAR(80) NOT NULL,
    description_vi VARCHAR(240) NOT NULL,
    art_key VARCHAR(40) NOT NULL CHECK (art_key ~ '^[a-z0-9_]+$'),
    unlock_kind VARCHAR(12) NOT NULL CHECK (unlock_kind IN ('COIN','LEARNING','HARVESTS','GRADUATIONS')),
    coin_price INTEGER NOT NULL DEFAULT 0 CHECK (coin_price >= 0),
    requirement INTEGER NOT NULL DEFAULT 0 CHECK (requirement >= 0),
    max_owned SMALLINT NOT NULL DEFAULT 1 CHECK (max_owned BETWEEN 1 AND 9),
    footprint NUMERIC(3,2) NOT NULL DEFAULT 0 CHECK (footprint >= 0 AND footprint <= 2),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL,
    CONSTRAINT uq_garden_cosmetic_category UNIQUE (code, category),
    CONSTRAINT ck_garden_cosmetic_price CHECK ((unlock_kind = 'COIN' AND coin_price > 0 AND requirement = 0)
        OR (unlock_kind <> 'COIN' AND coin_price = 0 AND requirement > 0)),
    CONSTRAINT ck_garden_cosmetic_shape CHECK ((category = 'DECOR' AND footprint > 0 AND family IN ('LANTERN','PLANTER','BENCH','SIGN','STATUE'))
        OR (category <> 'DECOR' AND footprint = 0 AND max_owned = 1 AND family = category))
);

-- ===== ownership =====
CREATE TABLE IF NOT EXISTS public.garden_cosmetic_owned (
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    cosmetic_code VARCHAR(40) NOT NULL REFERENCES public.garden_cosmetic_def(code) ON DELETE RESTRICT,
    quantity SMALLINT NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 9),
    acquired_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, cosmetic_code)
);

-- one row per unit ever acquired: the purchase history (append-only; it does not reference the ownership row, so a
-- refunded direct purchase can give the ownership back while its history stays). Among live rows unit_no is unique per
-- player and item, so two racing acquisitions can never both become "unit 1".
CREATE TABLE IF NOT EXISTS public.garden_cosmetic_acquisition (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    cosmetic_code VARCHAR(40) NOT NULL,
    unit_no SMALLINT NOT NULL CHECK (unit_no BETWEEN 1 AND 9),
    source VARCHAR(12) NOT NULL CHECK (source IN ('COIN','LEARNING','HARVESTS','GRADUATIONS','MONEY')),
    coins_paid BIGINT NOT NULL DEFAULT 0 CHECK (coins_paid >= 0),
    order_id BIGINT,
    op_key UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    reversed_at TIMESTAMPTZ,
    CONSTRAINT fk_garden_cosmetic_acq_user FOREIGN KEY (user_id) REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    CONSTRAINT fk_garden_cosmetic_acq_def FOREIGN KEY (cosmetic_code) REFERENCES public.garden_cosmetic_def(code) ON DELETE RESTRICT,
    CONSTRAINT ck_garden_cosmetic_acq_source CHECK ((source = 'COIN') = (coins_paid > 0)),
    CONSTRAINT ck_garden_cosmetic_acq_money CHECK ((source = 'MONEY') = (order_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_garden_cosmetic_acq_unit ON public.garden_cosmetic_acquisition(user_id, cosmetic_code, unit_no)
    WHERE reversed_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_garden_cosmetic_acq_user ON public.garden_cosmetic_acquisition(user_id, created_at);

-- a player never holds more units than the catalogue allows
CREATE OR REPLACE FUNCTION public.garden_cosmetic_owned_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lim SMALLINT;
BEGIN
    SELECT max_owned INTO lim FROM public.garden_cosmetic_def WHERE code = NEW.cosmetic_code;
    IF NEW.quantity > lim THEN
        RAISE EXCEPTION 'garden cosmetic % allows at most % units', NEW.cosmetic_code, lim;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_garden_cosmetic_owned_limit ON public.garden_cosmetic_owned;
CREATE TRIGGER trg_garden_cosmetic_owned_limit BEFORE INSERT OR UPDATE ON public.garden_cosmetic_owned
    FOR EACH ROW EXECUTE FUNCTION public.garden_cosmetic_owned_limit();

-- the purchase history is append-only: only `reversed_at` may ever be set, once (a refunded direct purchase)
CREATE OR REPLACE FUNCTION public.garden_cosmetic_acquisition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'garden_cosmetic_acquisition is append-only';
    END IF;
    IF OLD.reversed_at IS NOT NULL OR NEW.reversed_at IS NULL OR NEW.user_id <> OLD.user_id OR NEW.cosmetic_code <> OLD.cosmetic_code
       OR NEW.unit_no <> OLD.unit_no OR NEW.source <> OLD.source OR NEW.coins_paid <> OLD.coins_paid OR NEW.op_key <> OLD.op_key
       OR NEW.created_at <> OLD.created_at OR NEW.order_id IS DISTINCT FROM OLD.order_id THEN
        RAISE EXCEPTION 'garden_cosmetic_acquisition rows are immutable';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_garden_cosmetic_acquisition_guard ON public.garden_cosmetic_acquisition;
CREATE TRIGGER trg_garden_cosmetic_acquisition_guard BEFORE UPDATE OR DELETE ON public.garden_cosmetic_acquisition
    FOR EACH ROW EXECUTE FUNCTION public.garden_cosmetic_acquisition_guard();

-- ===== the equipped appearance of each slot: only an owned item of that category (both by foreign key) =====
CREATE TABLE IF NOT EXISTS public.garden_cosmetic_equipped (
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    slot VARCHAR(10) NOT NULL CHECK (slot IN ('HOUSE','TREE','SHRUB','FLOWER','MONUMENT','FENCE','PATH','BED')),
    cosmetic_code VARCHAR(40) NOT NULL,
    equipped_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, slot),
    CONSTRAINT fk_garden_cosmetic_equipped_owned FOREIGN KEY (user_id, cosmetic_code)
        REFERENCES public.garden_cosmetic_owned(user_id, cosmetic_code) ON DELETE RESTRICT,
    CONSTRAINT fk_garden_cosmetic_equipped_slot FOREIGN KEY (cosmetic_code, slot)
        REFERENCES public.garden_cosmetic_def(code, category) ON DELETE RESTRICT
);

-- ===== decorations standing on the island =====
-- A stored decoration has no row (storing deletes the placement, never the ownership). One unit stands at most once.
CREATE TABLE IF NOT EXISTS public.garden_decor_placement (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    cosmetic_code VARCHAR(40) NOT NULL,
    unit_no SMALLINT NOT NULL CHECK (unit_no BETWEEN 1 AND 9),
    category VARCHAR(10) NOT NULL DEFAULT 'DECOR' CHECK (category = 'DECOR'),
    region_code VARCHAR(24) NOT NULL,
    gx NUMERIC(5,2) NOT NULL CHECK (gx >= 0 AND gx <= 30),
    gy NUMERIC(5,2) NOT NULL CHECK (gy >= 0 AND gy <= 30),
    placed_at TIMESTAMPTZ NOT NULL,
    moved_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_garden_decor_unit UNIQUE (user_id, cosmetic_code, unit_no),
    CONSTRAINT uq_garden_decor_spot UNIQUE (user_id, gx, gy),
    CONSTRAINT fk_garden_decor_owned FOREIGN KEY (user_id, cosmetic_code)
        REFERENCES public.garden_cosmetic_owned(user_id, cosmetic_code) ON DELETE RESTRICT,
    CONSTRAINT fk_garden_decor_is_decor FOREIGN KEY (cosmetic_code, category)
        REFERENCES public.garden_cosmetic_def(code, category) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS ix_garden_decor_user ON public.garden_decor_placement(user_id);

CREATE OR REPLACE FUNCTION public.garden_decor_unit_owned() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE have SMALLINT;
BEGIN
    SELECT quantity INTO have FROM public.garden_cosmetic_owned WHERE user_id = NEW.user_id AND cosmetic_code = NEW.cosmetic_code;
    IF have IS NULL OR NEW.unit_no > have THEN
        RAISE EXCEPTION 'garden decoration unit % of % is not owned', NEW.unit_no, NEW.cosmetic_code;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_garden_decor_unit_owned ON public.garden_decor_placement;
CREATE TRIGGER trg_garden_decor_unit_owned BEFORE INSERT OR UPDATE ON public.garden_decor_placement
    FOR EACH ROW EXECUTE FUNCTION public.garden_decor_unit_owned();

-- ===== direct purchase (real money): CLOSED BOUNDARY =====
-- A SKU names one catalogue item and the price the owner approved for it. NONE is seeded: until the owner approves
-- prices, a payment-provider integration and a refund policy, no order can exist. `enabled` needs a price. The service
-- sells only permanent cosmetics (item_kind COSMETIC, max_owned 1): a refund then gives back exactly one ownership.
-- Cultivars (SKIN) are reserved in the type list but not sold: a planting keeps the cultivar it was planted with.
CREATE TABLE IF NOT EXISTS public.garden_cosmetic_sku (
    sku_code VARCHAR(48) PRIMARY KEY,
    item_kind VARCHAR(8) NOT NULL CHECK (item_kind IN ('COSMETIC','SKIN')),
    item_code VARCHAR(40) NOT NULL,
    price_vnd BIGINT CHECK (price_vnd IS NULL OR price_vnd > 0),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_garden_cosmetic_sku_item UNIQUE (item_kind, item_code),
    CONSTRAINT ck_garden_cosmetic_sku_enabled CHECK (NOT enabled OR price_vnd IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.garden_cosmetic_order (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    sku_code VARCHAR(48) NOT NULL REFERENCES public.garden_cosmetic_sku(sku_code) ON DELETE RESTRICT,
    item_kind VARCHAR(8) NOT NULL CHECK (item_kind IN ('COSMETIC','SKIN')),
    item_code VARCHAR(40) NOT NULL,
    amount_vnd BIGINT NOT NULL CHECK (amount_vnd > 0),
    provider VARCHAR(16) NOT NULL,
    provider_ref VARCHAR(128) NOT NULL,
    status VARCHAR(10) NOT NULL CHECK (status IN ('PENDING','FULFILLED','CANCELLED','EXPIRED','REFUNDED')),
    created_at TIMESTAMPTZ NOT NULL,
    fulfilled_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    CONSTRAINT uq_garden_cosmetic_order_ref UNIQUE (provider, provider_ref),
    CONSTRAINT ck_garden_cosmetic_order_times CHECK ((status IN ('FULFILLED','REFUNDED')) = (fulfilled_at IS NOT NULL))
);
-- one open order per player and SKU
CREATE UNIQUE INDEX IF NOT EXISTS ux_garden_cosmetic_order_open ON public.garden_cosmetic_order(user_id, sku_code) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS ix_garden_cosmetic_order_user ON public.garden_cosmetic_order(user_id, created_at);

-- an order only moves forward (PENDING -> FULFILLED | CANCELLED | EXPIRED, FULFILLED -> REFUNDED), keeps who / what /
-- how much it was for, and is never deleted
CREATE OR REPLACE FUNCTION public.garden_cosmetic_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'garden_cosmetic_order is never deleted';
    END IF;
    IF NEW.user_id <> OLD.user_id OR NEW.sku_code <> OLD.sku_code OR NEW.item_kind <> OLD.item_kind OR NEW.item_code <> OLD.item_code
       OR NEW.amount_vnd <> OLD.amount_vnd OR NEW.provider <> OLD.provider OR NEW.provider_ref <> OLD.provider_ref
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'garden_cosmetic_order identity is immutable';
    END IF;
    IF NOT ((OLD.status = 'PENDING' AND NEW.status IN ('FULFILLED','CANCELLED','EXPIRED'))
            OR (OLD.status = 'FULFILLED' AND NEW.status = 'REFUNDED')) THEN
        RAISE EXCEPTION 'garden_cosmetic_order cannot go from % to %', OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_garden_cosmetic_order_guard ON public.garden_cosmetic_order;
CREATE TRIGGER trg_garden_cosmetic_order_guard BEFORE UPDATE OR DELETE ON public.garden_cosmetic_order
    FOR EACH ROW EXECUTE FUNCTION public.garden_cosmetic_order_guard();

-- ===== seed: collections =====
INSERT INTO public.garden_collection_def (code, name_vi, description_vi, sort_order) VALUES
/*COLLECTION_ROWS*/
ON CONFLICT (code) DO NOTHING;

-- ===== seed: fifty cultivars, five per crop (four growth-stage sprites each: cskin_<art_key>_s1..4) =====
-- per crop: three for coins (the crop must have been harvested once: mastery tier 1), one earned by crop mastery tier 3,
-- one earned by verified learning days. A cultivar changes art only.
INSERT INTO public.garden_skin_def
    (code, crop_code, name_vi, description_vi, unlock_kind, coin_price, mastery_tier, learning_days, art_key, sort_order, collection_code)
VALUES
/*SKIN_ROWS*/
ON CONFLICT (code) DO NOTHING;

-- ===== seed: cosmetics =====
INSERT INTO public.garden_cosmetic_def
    (code, category, family, collection_code, name_vi, description_vi, art_key, unlock_kind, coin_price, requirement, max_owned, footprint, sort_order)
VALUES
/*COSMETIC_ROWS*/
ON CONFLICT (code) DO NOTHING;

-- ===== configuration: where decorations may stand =====
-- `regions`: rectangles of free ground (grid cells) chosen from the island layout — away from beds, fields, fences, paths,
-- the pond, buildings, trees, the Knowledge Tree, the memory grove and forest. `snap`: placement grid; `maxPlaced`: the
-- most decorations that may stand at once. Mirrored by `layout.decorRegions` (drawing only; the server decides).
INSERT INTO public.garden_config (key, value) VALUES
    ('cosmetics', '/*CONFIG_JSON*/')
ON CONFLICT (key) DO NOTHING;
