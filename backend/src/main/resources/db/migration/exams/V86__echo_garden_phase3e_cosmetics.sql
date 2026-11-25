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
    ('BLOSSOM', 'Xuân Hoa Khai', 'Anh đào, đào phai và những cánh hoa đầu mùa.', 1),
    ('SUNGOLD', 'Hạ Nắng Vàng', 'Hướng dương, nắng mật và hiên nhà rợp bóng.', 2),
    ('AMBER', 'Thu Hổ Phách', 'Lá phong, bí ngô và mùa gặt vàng óng.', 3),
    ('FROST', 'Đông Pha Lê', 'Băng tinh, tuyết đầu mùa và ánh đèn ấm.', 4),
    ('TET', 'Tết Nguyên Đán', 'Mai vàng, đào thắm, bao lì xì và cây nêu ngày Tết.', 5),
    ('TRUNGTHU', 'Trung Thu Trăng Rằm', 'Đèn ông sao, đèn lồng và thỏ ngọc dưới trăng.', 6),
    ('LONGPHUNG', 'Long Phụng Thiên Cung', 'Rồng vàng, phượng lửa và mái ngói ngọc cong vút.', 7),
    ('CELESTIAL', 'Tinh Nguyệt', 'Trăng, sao, cực quang và cầu vồng.', 8),
    ('LEHOI', 'Lễ Hội Bốn Phương', 'Đêm bí ngô, Giáng Sinh và hội mùa khắp nơi.', 9),
    ('NGOC', 'Ngọc và San Hô', 'Ngọc bích, đá quý, san hô và vườn thượng uyển.', 10)
ON CONFLICT (code) DO NOTHING;

-- ===== seed: fifty cultivars, five per crop (four growth-stage sprites each: cskin_<art_key>_s1..4) =====
-- per crop: three for coins (the crop must have been harvested once: mastery tier 1), one earned by crop mastery tier 3,
-- one earned by verified learning days. A cultivar changes art only.
INSERT INTO public.garden_skin_def
    (code, crop_code, name_vi, description_vi, unlock_kind, coin_price, mastery_tier, learning_days, art_key, sort_order, collection_code)
VALUES
    ('WHEAT_BLOSSOM', 'WHEAT', 'Lúa Hoa Anh Đào', 'Bông lúa phớt hồng giữa hai cành anh đào cắm đầu luống, cánh hoa rụng kín đất.', 'COIN', 6000, 1, 0, 'wheat_blossom', 100, 'BLOSSOM'),
    ('WHEAT_LANTERN', 'WHEAT', 'Lúa Đèn Lồng', 'Ruộng lúa vàng treo ba chiếc đèn lồng lụa trên cọc tre và một dây hạt sáng.', 'COIN', 9000, 1, 0, 'wheat_lantern', 101, 'TRUNGTHU'),
    ('WHEAT_FROST', 'WHEAT', 'Lúa Sương Pha Lê', 'Thân lúa bạc xanh, bông đọng tinh thể băng, tuyết phủ chân luống.', 'COIN', 12000, 1, 0, 'wheat_frost', 102, 'FROST'),
    ('WHEAT_SUNFIRE', 'WHEAT', 'Lúa Lông Phụng', 'Bông lúa dài như lông đuôi phượng, đỏ dần sang vàng, sau luống xòe quạt lông vũ.', 'MASTERY', 0, 3, 0, 'wheat_sunfire', 103, 'LONGPHUNG'),
    ('WHEAT_STARLIGHT', 'WHEAT', 'Lúa Tinh Tú', 'Thân lúa chàm tím, bông trắng ngà đính sao, có trăng khuyết canh luống.', 'LEARNING', 0, 1, 7, 'wheat_starlight', 104, 'CELESTIAL'),
    ('TOMATO_PEACH', 'TOMATO', 'Cà Chua Đào Tiên', 'Quả hình tim màu đào chín, hoa đào nở trên đầu cọc, cánh hoa rơi quanh gốc.', 'COIN', 8000, 1, 0, 'tomato_peach', 105, 'TET'),
    ('TOMATO_SUNBURST', 'TOMATO', 'Cà Chua Nắng Hạ', 'Quả lớn vằn vàng đỏ như tia nắng, cọc sau đội hoa hướng dương.', 'COIN', 11000, 1, 0, 'tomato_sunburst', 106, 'SUNGOLD'),
    ('TOMATO_ICE', 'TOMATO', 'Cà Chua Băng Châu', 'Chùm cà chua bi trong như băng, cọc phủ tuyết treo nhũ băng.', 'COIN', 16000, 1, 0, 'tomato_ice', 107, 'FROST'),
    ('TOMATO_LANTERN', 'TOMATO', 'Cà Chua Đèn Ma', 'Quả múi như bí ngô tí hon khắc mặt cười, tán lá tím đêm.', 'MASTERY', 0, 3, 0, 'tomato_lantern', 108, 'LEHOI'),
    ('TOMATO_DRAGON', 'TOMATO', 'Cà Chua Long Châu', 'Quả thuôn dài đỏ son chót vàng, cọc sơn son đai vàng có rồng vàng quấn quanh.', 'LEARNING', 0, 1, 14, 'tomato_dragon', 109, 'LONGPHUNG'),
    ('CORN_TET', 'CORN', 'Bắp Lộc Xuân', 'Bẹ đỏ, hạt vàng, thân buộc nơ đỏ và treo bao lì xì, mai vàng nở dưới gốc.', 'COIN', 12000, 1, 0, 'corn_tet', 110, 'TET'),
    ('CORN_SUN', 'CORN', 'Bắp Hướng Dương', 'Mỗi thân bắp đội một đóa hướng dương, trái to vàng rực.', 'COIN', 15000, 1, 0, 'corn_sun', 111, 'SUNGOLD'),
    ('CORN_FROST', 'CORN', 'Bắp Tuyết Ngọc', 'Hạt trắng điểm xanh, bẹ lam nhạt, tuyết đọng trên cờ và trái.', 'COIN', 22000, 1, 0, 'corn_frost', 112, 'FROST'),
    ('CORN_AMBER', 'CORN', 'Bắp Mùa Gặt', 'Bắp nếp nhiều màu nâu đỏ, bẹ khô bung như sao, có bó rơm và lá phong.', 'MASTERY', 0, 3, 0, 'corn_amber', 113, 'AMBER'),
    ('CORN_PHOENIX', 'CORN', 'Bắp Hỏa Phụng', 'Cờ bắp hóa thành chùm lông lửa, hạt hồng than, lá ngả sắc cam.', 'LEARNING', 0, 1, 30, 'corn_phoenix', 114, 'LONGPHUNG'),
    ('STRAWBERRY_BLOSSOM', 'STRAWBERRY', 'Dâu Anh Đào', 'Dâu hồng phấn điểm hạt trắng, hoa anh đào nở dày, cánh hoa trải kín luống.', 'COIN', 18000, 1, 0, 'strawberry_blossom', 115, 'BLOSSOM'),
    ('STRAWBERRY_HONEY', 'STRAWBERRY', 'Dâu Mật Ong', 'Dâu vàng hổ phách bóng mật, góc luống có tổ ong rơm và đàn ong nhỏ.', 'COIN', 22000, 1, 0, 'strawberry_honey', 116, 'SUNGOLD'),
    ('STRAWBERRY_FROST', 'STRAWBERRY', 'Dâu Băng Tinh', 'Quả dâu trong như pha lê trên lớp sương muối, cụm băng mọc ở góc luống.', 'COIN', 30000, 1, 0, 'strawberry_frost', 117, 'FROST'),
    ('STRAWBERRY_CORAL', 'STRAWBERRY', 'Dâu San Hô', 'Dâu thuôn màu san hô giữa nhánh san hô, vỏ sò và ngọc trai trên nền cát.', 'MASTERY', 0, 3, 0, 'strawberry_coral', 118, 'NGOC'),
    ('STRAWBERRY_MOON', 'STRAWBERRY', 'Dâu Nguyệt Quang', 'Dâu trắng tím tỏa sáng khi đêm xuống, dưới một vầng trăng khuyết và ba ngôi sao.', 'LEARNING', 0, 1, 21, 'strawberry_moon', 119, 'CELESTIAL'),
    ('ROSE_PEACH', 'ROSE', 'Hồng Đào Xuân', 'Hồng kép màu đào, cọc tre thắt nơ đỏ tua vàng, cánh hoa rơi quanh gốc.', 'COIN', 26000, 1, 0, 'rose_peach', 120, 'TET'),
    ('ROSE_SUN', 'ROSE', 'Hồng Vàng Nắng', 'Hồng vàng leo kín một cổng vòm trắng bắc ngang luống.', 'COIN', 34000, 1, 0, 'rose_sun', 121, 'SUNGOLD'),
    ('ROSE_FROST', 'ROSE', 'Hồng Băng', 'Cánh hồng trong suốt như băng quanh một cụm pha lê, tỏa sáng dịu ban đêm.', 'COIN', 45000, 1, 0, 'rose_frost', 122, 'FROST'),
    ('ROSE_AMBER', 'ROSE', 'Hồng Hổ Phách', 'Hồng màu đồng trong vành giỏ mây, lá ngả nâu đỏ, quả tầm xuân chín mọng.', 'MASTERY', 0, 3, 0, 'rose_amber', 123, 'AMBER'),
    ('ROSE_PHOENIX', 'ROSE', 'Hồng Phượng Hoàng', 'Đóa hồng rực lửa với cánh vươn như lông vũ, sau luống xòe quạt lông phượng.', 'LEARNING', 0, 1, 45, 'rose_phoenix', 124, 'LONGPHUNG'),
    ('WATERMELON_TET', 'WATERMELON', 'Dưa Hấu Tết', 'Dưa tròn xanh thẫm dán nhãn đỏ dấu vàng và thắt nơ, cành mai nở bên luống.', 'COIN', 36000, 1, 0, 'watermelon_tet', 125, 'TET'),
    ('WATERMELON_SUN', 'WATERMELON', 'Dưa Hoàng Kim', 'Dưa vỏ vàng sọc nắng nằm trên vòng lá tỏa tia, có hướng dương đứng gác.', 'COIN', 44000, 1, 0, 'watermelon_sun', 126, 'SUNGOLD'),
    ('WATERMELON_FROST', 'WATERMELON', 'Dưa Tuyết Cầu', 'Dưa tròn trắng bạc hà đội mũ tuyết giữa những cụm băng.', 'COIN', 60000, 1, 0, 'watermelon_frost', 127, 'FROST'),
    ('WATERMELON_MOON', 'WATERMELON', 'Dưa Trăng Sao', 'Vỏ dưa xanh đêm lấm tấm sao vàng với một vầng trăng, sao nhỏ lơ lửng trên luống.', 'MASTERY', 0, 3, 0, 'watermelon_moon', 128, 'CELESTIAL'),
    ('WATERMELON_DRAGON', 'WATERMELON', 'Dưa Long Lân', 'Dưa dài vảy ngọc có sừng và râu vàng, cọc son đội mây vàng.', 'LEARNING', 0, 1, 60, 'watermelon_dragon', 129, 'LONGPHUNG'),
    ('PUMPKIN_ROSE', 'PUMPKIN', 'Bí Hồng Sứ', 'Bí dẹt nhiều múi màu hồng sứ, quanh cuống kết vòng hoa.', 'COIN', 48000, 1, 0, 'pumpkin_rose', 130, 'BLOSSOM'),
    ('PUMPKIN_TURBAN', 'PUMPKIN', 'Bí Khăn Xếp', 'Bí đội mũ sọc xanh kem cam, bên bó rơm và lá phong rụng.', 'COIN', 56000, 1, 0, 'pumpkin_turban', 131, 'AMBER'),
    ('PUMPKIN_FROST', 'PUMPKIN', 'Bí Bạch Tuyết', 'Bí trắng muốt phủ tuyết, lá viền sương, góc luống mọc băng tinh.', 'COIN', 80000, 1, 0, 'pumpkin_frost', 132, 'FROST'),
    ('PUMPKIN_LANTERN', 'PUMPKIN', 'Bí Đèn Lồng Ma', 'Bí cam khắc mặt cười sáng đèn khi đêm xuống, có đèn bí treo đầu cọc.', 'MASTERY', 0, 3, 0, 'pumpkin_lantern', 133, 'LEHOI'),
    ('PUMPKIN_MOON', 'PUMPKIN', 'Bí Trăng Rằm', 'Bí tròn vàng nhạt khắc trăng khuyết, đèn ông sao treo trên cọc tre.', 'LEARNING', 0, 1, 75, 'pumpkin_moon', 134, 'TRUNGTHU'),
    ('MOONFLOWER_DAWN', 'MOONFLOWER', 'Hoa Trăng Bình Minh', 'Loa hoa màu đào ngả vàng trên cọc trúc vàng, có mặt trời nhỏ tỏa tia.', 'COIN', 75000, 1, 0, 'moonflower_dawn', 135, 'SUNGOLD'),
    ('MOONFLOWER_FROST', 'MOONFLOWER', 'Hoa Trăng Sương Giá', 'Hoa trong như băng, mỗi cọc treo một bông tuyết sáu cánh.', 'COIN', 95000, 1, 0, 'moonflower_frost', 136, 'FROST'),
    ('MOONFLOWER_LOTUS', 'MOONFLOWER', 'Hoa Trăng Sen Hồng', 'Hoa nở thành đài sen nhiều lớp cánh trên giàn tre, lá sen tròn nằm dưới gốc.', 'COIN', 120000, 1, 0, 'moonflower_lotus', 137, 'TET'),
    ('MOONFLOWER_BLOOD', 'MOONFLOWER', 'Hoa Trăng Huyết Nguyệt', 'Hoa đỏ thẫm trên tán lá tím than, dưới một vầng trăng đỏ.', 'MASTERY', 0, 3, 0, 'moonflower_blood', 138, 'LEHOI'),
    ('MOONFLOWER_AURORA', 'MOONFLOWER', 'Hoa Trăng Cực Quang', 'Hoa đổi sắc lam lục tím, hai dải cực quang uốn lượn trên giàn.', 'LEARNING', 0, 1, 90, 'moonflower_aurora', 139, 'CELESTIAL'),
    ('FROST_LILY_BLUSH', 'FROST_LILY', 'Huệ Xuân Phấn', 'Huệ trắng phớt hồng, lá xanh non, có bướm ghé và cành anh đào bên luống.', 'COIN', 90000, 1, 0, 'frost_lily_blush', 140, 'BLOSSOM'),
    ('FROST_LILY_JADE', 'FROST_LILY', 'Huệ Ngọc Bích', 'Cánh huệ như ngọc tạc, bên một vòng ngọc bích và những viên cuội ngọc.', 'COIN', 120000, 1, 0, 'frost_lily_jade', 141, 'NGOC'),
    ('FROST_LILY_GOLD', 'FROST_LILY', 'Huệ Hoàng Kim', 'Huệ kèn vàng với nhị dài, đứng trong một vòng đai vàng.', 'COIN', 150000, 1, 0, 'frost_lily_gold', 142, 'NGOC'),
    ('FROST_LILY_FLAME', 'FROST_LILY', 'Huệ Hỏa Diệm', 'Huệ cam lốm đốm, cánh cuộn ngược như ngọn lửa, có lông vũ lửa sau luống.', 'MASTERY', 0, 3, 0, 'frost_lily_flame', 143, 'LONGPHUNG'),
    ('FROST_LILY_AURORA', 'FROST_LILY', 'Huệ Cực Quang', 'Huệ đổi sắc cực quang, mỗi đóa nâng một ngôi sao, thạch anh tím mọc bên cạnh.', 'LEARNING', 0, 1, 120, 'frost_lily_aurora', 144, 'CELESTIAL'),
    ('CRYSTAL_ORCHID_RUBY', 'CRYSTAL_ORCHID', 'Lan Hồng Ngọc', 'Mỗi đóa là một viên hồng ngọc mài giác trong đài vàng.', 'COIN', 160000, 1, 0, 'crystal_orchid_ruby', 145, 'NGOC'),
    ('CRYSTAL_ORCHID_AMBER', 'CRYSTAL_ORCHID', 'Lan Hổ Phách', 'Những giọt hổ phách treo trên sợi vàng dọc cành lan.', 'COIN', 190000, 1, 0, 'crystal_orchid_amber', 146, 'AMBER'),
    ('CRYSTAL_ORCHID_EMERALD', 'CRYSTAL_ORCHID', 'Lan Lục Bảo', 'Lan mọc từ những hốc tinh thể lục bảo tách đôi.', 'COIN', 220000, 1, 0, 'crystal_orchid_emerald', 147, 'NGOC'),
    ('CRYSTAL_ORCHID_RAINBOW', 'CRYSTAL_ORCHID', 'Lan Cầu Vồng', 'Mỗi đóa một sắc đá quý, sau luống bắc một cầu vồng.', 'MASTERY', 0, 3, 0, 'crystal_orchid_rainbow', 148, 'CELESTIAL'),
    ('CRYSTAL_ORCHID_DRAGON', 'CRYSTAL_ORCHID', 'Lan Kim Long', 'Lan vàng nở quanh một trụ son có rồng vàng ngậm ngọc quấn lên.', 'LEARNING', 0, 1, 180, 'crystal_orchid_dragon', 149, 'LONGPHUNG')
ON CONFLICT (code) DO NOTHING;

-- ===== seed: cosmetics =====
INSERT INTO public.garden_cosmetic_def
    (code, category, family, collection_code, name_vi, description_vi, art_key, unlock_kind, coin_price, requirement, max_owned, footprint, sort_order)
VALUES
    ('HOUSE_BLOSSOM', 'HOUSE', 'HOUSE', 'BLOSSOM', 'Nhà Hoa Anh Đào', 'Tường hồng phấn, mái ngói hồng, tử đằng rủ quanh hiên và một cây anh đào bên đầu hồi.', 'blossom', 'COIN', 60000, 0, 1, 0, 1),
    ('HOUSE_SUNGOLD', 'HOUSE', 'HOUSE', 'SUNGOLD', 'Trang Viên Nắng Hạ', 'Tường đá mật ong, mái ngói đất nung, cửa chớp xanh ngọc, hướng dương và hoa giấy quanh nhà.', 'sungold', 'COIN', 90000, 0, 1, 0, 2),
    ('HOUSE_AMBER', 'HOUSE', 'HOUSE', 'AMBER', 'Nhà Mùa Gặt', 'Nhà kho đỏ mái hai dốc, viền kem, có rơm, bí ngô, bó ngô và chong chóng gà trống.', 'amber', 'COIN', 120000, 0, 1, 0, 3),
    ('HOUSE_FROST', 'HOUSE', 'HOUSE', 'FROST', 'Dinh Pha Lê Mùa Đông', 'Tường đá lam, mái dốc phủ tuyết treo nhũ băng, vòng nguyệt quế trên cửa, đỉnh mái đội pha lê.', 'frost', 'COIN', 180000, 0, 1, 0, 4),
    ('HOUSE_LONGPHUNG', 'HOUSE', 'HOUSE', 'LONGPHUNG', 'Biệt Phủ Long Phụng', 'Cột son, mái ngói ngọc cong vút, cửa nguyệt, đèn lồng đỏ; đôi rồng chầu ngọc trên nóc và phượng đậu cổng.', 'longphung', 'COIN', 320000, 0, 1, 0, 5),
    ('TREE_SAKURA', 'TREE', 'TREE', 'BLOSSOM', 'Anh Đào Rủ', 'Tán anh đào hồng với những chuỗi hoa rủ dài quanh thân.', 'sakura', 'COIN', 30000, 0, 1, 0, 6),
    ('TREE_MAPLE', 'TREE', 'TREE', 'AMBER', 'Phong Lửa', 'Cây phong tán rộng đỏ rực, lá rụng dưới gốc.', 'maple', 'COIN', 36000, 0, 1, 0, 7),
    ('TREE_MAI', 'TREE', 'TREE', 'TET', 'Mai Vàng Ngày Tết', 'Cành mai gân guốc nở kín hoa vàng, treo bao lì xì đỏ.', 'mai', 'COIN', 45000, 0, 1, 0, 8),
    ('TREE_CRYSTAL', 'TREE', 'TREE', 'FROST', 'Cây Băng Tinh', 'Cây mùa đông thân phủ sương, lá là những tinh thể băng, cành treo nhũ băng và sao.', 'crystal', 'COIN', 70000, 0, 1, 0, 9),
    ('TREE_PHUONG', 'TREE', 'TREE', 'SUNGOLD', 'Phượng Vĩ', 'Cây phượng tán dù phủ hoa đỏ - loài hoa của mùa học.', 'phuong', 'LEARNING', 0, 30, 1, 0, 10),
    ('SHRUB_LAVENDER', 'SHRUB', 'SHRUB', 'BLOSSOM', 'Bụi Oải Hương', 'Bụi lá bạc với những bông oải hương tím vươn cao.', 'lavender', 'COIN', 12000, 0, 1, 0, 11),
    ('SHRUB_HYDRANGEA', 'SHRUB', 'SHRUB', 'SUNGOLD', 'Cẩm Tú Cầu', 'Bụi cẩm tú cầu nở những quả cầu hoa lam và hồng.', 'hydrangea', 'COIN', 16000, 0, 1, 0, 12),
    ('SHRUB_TOPIARY', 'SHRUB', 'SHRUB', 'NGOC', 'Cây Cảnh Xén Tròn', 'Những quả cầu lá xén gọn trên thân thẳng, trồng trong chậu gỗ.', 'topiary', 'COIN', 22000, 0, 1, 0, 13),
    ('SHRUB_BAMBOO', 'SHRUB', 'SHRUB', 'TET', 'Khóm Trúc', 'Khóm trúc xanh xen trúc vàng, lá thon dài.', 'bamboo', 'COIN', 28000, 0, 1, 0, 14),
    ('SHRUB_HOLLY', 'SHRUB', 'SHRUB', 'LEHOI', 'Bụi Nhựa Ruồi Tuyết', 'Bụi lá xanh thẫm đầy quả đỏ, tuyết đọng trên ngọn.', 'holly', 'HARVESTS', 0, 300, 1, 0, 15),
    ('FLOWER_TULIP', 'FLOWER', 'FLOWER', 'BLOSSOM', 'Luống Tulip', 'Luống tulip năm màu.', 'tulip', 'COIN', 10000, 0, 1, 0, 16),
    ('FLOWER_SUNFLOWER', 'FLOWER', 'FLOWER', 'SUNGOLD', 'Khóm Hướng Dương', 'Khóm hướng dương cao thấp quay về phía người xem.', 'sunflower', 'COIN', 14000, 0, 1, 0, 17),
    ('FLOWER_CUC', 'FLOWER', 'FLOWER', 'TET', 'Chậu Cúc Vàng', 'Những chậu cúc vàng tròn đầy trong chậu men.', 'cuc', 'COIN', 20000, 0, 1, 0, 18),
    ('FLOWER_LOTUS', 'FLOWER', 'FLOWER', 'TET', 'Chậu Sen', 'Chậu men lam nuôi sen hồng với lá và nụ.', 'lotus', 'COIN', 32000, 0, 1, 0, 19),
    ('FLOWER_MOONLILY', 'FLOWER', 'FLOWER', 'CELESTIAL', 'Hoa Chuông Trăng', 'Những chuông hoa nhạt sáng trong đêm bên vòng nấm phát quang.', 'moonlily', 'GRADUATIONS', 0, 1, 1, 0, 20),
    ('MONUMENT_BLOSSOM', 'MONUMENT', 'MONUMENT', 'BLOSSOM', 'Ký Ức Hoa Xuân', 'Vòng trụ kết tràng hoa quanh gốc Cây Tri Thức, cầu hoa và vòng hoa treo dưới tán.', 'blossom', 'COIN', 60000, 0, 1, 0, 21),
    ('MONUMENT_LANTERN', 'MONUMENT', 'MONUMENT', 'TRUNGTHU', 'Thiên Đăng', 'Đèn giấy và đèn ông sao quanh gốc, đèn lồng lụa và đèn sen treo dưới tán.', 'lantern', 'COIN', 90000, 0, 1, 0, 22),
    ('MONUMENT_FROST', 'MONUMENT', 'MONUMENT', 'FROST', 'Pha Lê Mùa Đông', 'Những cụm băng tinh và bông tuyết quanh gốc, đèn chùm pha lê treo dưới tán.', 'frost', 'COIN', 120000, 0, 1, 0, 23),
    ('MONUMENT_PHOENIX', 'MONUMENT', 'MONUMENT', 'LONGPHUNG', 'Phượng Hoàng Rạng Rỡ', 'Phượng hoàng đậu trên đá bên những lò than hồng, chuỗi lông vũ treo dưới tán.', 'phoenix', 'LEARNING', 0, 45, 1, 0, 24),
    ('MONUMENT_DRAGON', 'MONUMENT', 'MONUMENT', 'LONGPHUNG', 'Kim Long Hộ Thụ', 'Đôi rồng vàng chầu ngọc trước gốc cây, mây vàng và chuỗi tiền cổ treo dưới tán.', 'dragon', 'COIN', 240000, 0, 1, 0, 25),
    ('FENCE_BAMBOO', 'FENCE', 'FENCE', 'TET', 'Hàng Rào Tre', 'Rào tre đan chéo buộc lạt, cổng tre treo đèn.', 'bamboo', 'COIN', 14000, 0, 1, 0, 26),
    ('FENCE_BLOSSOM', 'FENCE', 'FENCE', 'BLOSSOM', 'Hàng Rào Trắng Hoa Leo', 'Rào cọc trắng có hoa leo, cổng vòm kết hoa.', 'blossom', 'COIN', 18000, 0, 1, 0, 27),
    ('FENCE_HARVEST', 'FENCE', 'FENCE', 'AMBER', 'Hàng Rào Mùa Gặt', 'Rào gỗ thô với bó lúa và bí ngô ở chân cột, cổng treo vòng lá phong.', 'harvest', 'COIN', 24000, 0, 1, 0, 28),
    ('FENCE_FROST', 'FENCE', 'FENCE', 'FROST', 'Hàng Rào Sương Giá', 'Rào gỗ phủ tuyết treo nhũ băng, đầu cột gắn pha lê.', 'frost', 'COIN', 40000, 0, 1, 0, 29),
    ('FENCE_LONGPHUNG', 'FENCE', 'FENCE', 'LONGPHUNG', 'Lan Can Sơn Son', 'Lan can son đỏ nan ngọc bích nạm đinh vàng, cổng tam quan mái ngọc.', 'longphung', 'COIN', 90000, 0, 1, 0, 30),
    ('PATH_COBBLE', 'PATH', 'PATH', 'AMBER', 'Lối Đá Cuội', 'Những phiến đá ấm màu lát dọc lối đi, rêu mọc giữa kẽ.', 'cobble', 'COIN', 3000, 0, 1, 0, 31),
    ('PATH_PETAL', 'PATH', 'PATH', 'BLOSSOM', 'Lối Cánh Hoa', 'Đá trắng và đá hồng rắc cánh anh đào.', 'petal', 'COIN', 9000, 0, 1, 0, 32),
    ('PATH_BRICK', 'PATH', 'PATH', 'AMBER', 'Lối Gạch Xương Cá', 'Gạch đỏ lát xương cá điểm lá phong.', 'brick', 'COIN', 12000, 0, 1, 0, 33),
    ('PATH_ICE', 'PATH', 'PATH', 'FROST', 'Lối Băng', 'Những phiến băng lục giác sáng dịu trong đêm.', 'ice', 'COIN', 26000, 0, 1, 0, 34),
    ('PATH_JADE', 'PATH', 'PATH', 'LONGPHUNG', 'Lối Ngọc Bích', 'Những đĩa ngọc bích khảm vòng vàng.', 'jade', 'COIN', 60000, 0, 1, 0, 35),
    ('BED_BAMBOO', 'BED', 'BED', 'TET', 'Luống Tre', 'Khung luống ghép ống tre, cột tre buộc lạt.', 'bamboo', 'COIN', 8000, 0, 1, 0, 36),
    ('BED_STONE', 'BED', 'BED', 'AMBER', 'Luống Đá Rêu', 'Khung luống xếp đá rêu, nẹp đá sa thạch.', 'stone', 'COIN', 12000, 0, 1, 0, 37),
    ('BED_BLOSSOM', 'BED', 'BED', 'BLOSSOM', 'Luống Trắng Hoa Góc', 'Khung luống sơn trắng, mỗi góc một chùm hoa.', 'blossom', 'COIN', 16000, 0, 1, 0, 38),
    ('BED_FROST', 'BED', 'BED', 'FROST', 'Luống Sương Giá', 'Khung gỗ phủ sương, nẹp tuyết, góc gắn pha lê.', 'frost', 'COIN', 36000, 0, 1, 0, 39),
    ('BED_LONGPHUNG', 'BED', 'BED', 'LONGPHUNG', 'Luống Sơn Son Thếp Vàng', 'Khung son đỏ nẹp vàng, khảm ngọc tròn.', 'longphung', 'COIN', 80000, 0, 1, 0, 40),
    ('DECOR_LANTERN_STONE', 'DECOR', 'LANTERN', 'TRUNGTHU', 'Đèn Đá', 'Cây đèn đá rêu phong thắp ánh nến ấm.', 'lantern_stone', 'COIN', 2500, 0, 4, 0.35, 41),
    ('DECOR_LANTERN_HOIAN', 'DECOR', 'LANTERN', 'TET', 'Đèn Lồng Phố Hội', 'Sào tre treo ba chiếc đèn lồng lụa đỏ, vàng, ngọc.', 'lantern_hoian', 'COIN', 6000, 0, 4, 0.35, 42),
    ('DECOR_LANTERN_STAR', 'DECOR', 'LANTERN', 'TRUNGTHU', 'Đèn Ông Sao', 'Đèn ông sao lớn trên giá tre cùng hai đèn lồng nhỏ.', 'lantern_star', 'COIN', 8000, 0, 3, 0.4, 43),
    ('DECOR_LANTERN_MOONSTONE', 'DECOR', 'LANTERN', 'FROST', 'Đèn Nguyệt Thạch', 'Trụ băng nâng một viên nguyệt thạch tỏa sáng.', 'lantern_moonstone', 'COIN', 18000, 0, 3, 0.35, 44),
    ('DECOR_LANTERN_DRAGON', 'DECOR', 'LANTERN', 'LONGPHUNG', 'Đèn Rồng', 'Rồng vàng quấn trụ son, vươn đầu về phía viên ngọc sáng.', 'lantern_dragon', 'COIN', 45000, 0, 2, 0.35, 45),
    ('DECOR_PLANTER_SUNFLOWER', 'DECOR', 'PLANTER', 'SUNGOLD', 'Thùng Hướng Dương', 'Nửa thùng gỗ trồng năm cây hướng dương.', 'planter_sunflower', 'COIN', 2000, 0, 4, 0.4, 46),
    ('DECOR_PLANTER_BLOSSOM', 'DECOR', 'PLANTER', 'BLOSSOM', 'Bonsai Anh Đào', 'Chậu bonsai anh đào trên kỷ gỗ.', 'planter_blossom', 'COIN', 5000, 0, 4, 0.35, 47),
    ('DECOR_PLANTER_QUAT', 'DECOR', 'PLANTER', 'TET', 'Cây Quất Tết', 'Cây quất sai quả trong chậu men thắt nơ đỏ.', 'planter_quat', 'COIN', 7000, 0, 3, 0.35, 48),
    ('DECOR_PLANTER_LOTUS', 'DECOR', 'PLANTER', 'TET', 'Chậu Sen Lớn', 'Chậu men lam lớn với sen hồng, đặt giữa mấy viên đá.', 'planter_lotus', 'COIN', 12000, 0, 3, 0.5, 49),
    ('DECOR_PLANTER_FROST', 'DECOR', 'PLANTER', 'FROST', 'Bình Hoa Băng', 'Bình đá cắm những đóa hoa băng nhụy sáng.', 'planter_frost', 'COIN', 16000, 0, 3, 0.35, 50),
    ('DECOR_BENCH_HARVEST', 'DECOR', 'BENCH', 'AMBER', 'Ghế Rơm Mùa Gặt', 'Ghế xếp bằng kiện rơm trải chăn, bên bí ngô và thùng táo.', 'bench_harvest', 'COIN', 4000, 0, 2, 0.7, 51),
    ('DECOR_BENCH_SWING', 'DECOR', 'BENCH', 'SUNGOLD', 'Xích Đu Hiên Hè', 'Xích đu gỗ có đệm sọc và mái che.', 'bench_swing', 'COIN', 9000, 0, 2, 0.7, 52),
    ('DECOR_BENCH_BLOSSOM', 'DECOR', 'BENCH', 'BLOSSOM', 'Ghế Vòm Hoa', 'Ghế trắng dưới vòm hoa leo.', 'bench_blossom', 'COIN', 12000, 0, 2, 0.6, 53),
    ('DECOR_BENCH_TEA', 'DECOR', 'BENCH', 'LONGPHUNG', 'Bàn Trà Sơn Son', 'Bàn trà son đỏ với ấm chén và đôi đôn sứ men lam.', 'bench_tea', 'COIN', 20000, 0, 2, 0.7, 54),
    ('DECOR_BENCH_CRYSTAL', 'DECOR', 'BENCH', 'FROST', 'Ghế Băng Pha Lê', 'Ghế tạc từ băng trên chân pha lê, phủ đệm tuyết.', 'bench_crystal', 'COIN', 24000, 0, 2, 0.6, 55),
    ('DECOR_SIGN_FARM', 'DECOR', 'SIGN', 'SUNGOLD', 'Biển Nông Trại Echo', 'Biển gỗ khắc dấu đuôi cá voi Echo, dưới có bồn hoa.', 'sign_farm', 'COIN', 1500, 0, 1, 0.5, 56),
    ('DECOR_SIGN_BUNTING', 'DECOR', 'SIGN', 'AMBER', 'Dây Cờ Hội Mùa', 'Dây cờ tam giác giăng giữa hai cột, có bó lúa và bí ngô.', 'sign_bunting', 'COIN', 5000, 0, 2, 0.7, 57),
    ('DECOR_SIGN_CANDY', 'DECOR', 'SIGN', 'LEHOI', 'Cột Kẹo Giáng Sinh', 'Cột kẹo sọc treo vòng nguyệt quế và đèn nhỏ.', 'sign_candy', 'COIN', 8000, 0, 2, 0.4, 58),
    ('DECOR_SIGN_SCARECROW', 'DECOR', 'SIGN', 'LEHOI', 'Bù Nhìn Đêm Hội', 'Bù nhìn đầu bí ngô cười sáng đèn, tay xách đèn bí.', 'sign_scarecrow', 'COIN', 10000, 0, 2, 0.5, 59),
    ('DECOR_SIGN_NEU', 'DECOR', 'SIGN', 'TET', 'Cây Nêu', 'Cây nêu ngày Tết với vòng khánh, phướn đỏ và đèn lồng.', 'sign_neu', 'COIN', 15000, 0, 1, 0.4, 60),
    ('DECOR_STATUE_WHALE', 'DECOR', 'STATUE', 'CELESTIAL', 'Tượng Cá Voi Echo', 'Tượng cá voi Echo bằng cẩm thạch trên bệ sóng viền sáng.', 'statue_whale', 'LEARNING', 0, 7, 1, 0.5, 61),
    ('DECOR_STATUE_MEMORY', 'DECOR', 'STATUE', 'CELESTIAL', 'Bia Ký Ức', 'Tấm bia đá khắc những nét chữ phát sáng của các từ đã chăm.', 'statue_memory', 'LEARNING', 0, 14, 1, 0.45, 62),
    ('DECOR_STATUE_RABBIT', 'DECOR', 'STATUE', 'TRUNGTHU', 'Thỏ Ngọc', 'Thỏ ngọc ngồi trong vành trăng khuyết giữa những vì sao.', 'statue_rabbit', 'COIN', 40000, 0, 1, 0.45, 63),
    ('DECOR_STATUE_PHOENIX', 'DECOR', 'STATUE', 'LONGPHUNG', 'Tượng Phượng Hoàng', 'Phượng hoàng lửa xòe cánh trên bệ ngọc.', 'statue_phoenix', 'COIN', 110000, 0, 1, 0.5, 64),
    ('DECOR_STATUE_DRAGON', 'DECOR', 'STATUE', 'LONGPHUNG', 'Tượng Kim Long', 'Rồng vàng cuộn mình trên bệ cẩm thạch, ngậm ngọc sáng.', 'statue_dragon', 'COIN', 140000, 0, 1, 0.45, 65)
ON CONFLICT (code) DO NOTHING;

-- ===== configuration: where decorations may stand =====
-- `regions`: rectangles of free ground (grid cells) chosen from the island layout — away from beds, fields, fences, paths,
-- the pond, buildings, trees, the Knowledge Tree, the memory grove and forest. `snap`: placement grid; `maxPlaced`: the
-- most decorations that may stand at once. Mirrored by `layout.decorRegions` (drawing only; the server decides).
INSERT INTO public.garden_config (key, value) VALUES
    ('cosmetics', '{"maxPlaced":30,"snap":0.25,"regions":[{"code":"COTTAGE_GARDEN","nameVi":"Vườn trước nhà","rect":[14.5,10.0,15.25,10.5]},{"code":"EAST_MEADOW","nameVi":"Đồng cỏ phía Đông","rect":[18.25,9.75,19.5,10.5]},{"code":"EAST_CLIFF","nameVi":"Mỏm đá phía Đông","rect":[21.5,10.75,22.5,11.25]},{"code":"POND_BANK","nameVi":"Bờ ao","rect":[8.5,9.75,11.25,10.5]},{"code":"NORTH_LAWN","nameVi":"Bãi cỏ phía Bắc","rect":[7.75,6.5,9.0,7.25]},{"code":"POND_MEADOW","nameVi":"Bãi cỏ giữa ao và nông trại","rect":[4.5,14.5,9.5,15.0]},{"code":"WEST_SHORE","nameVi":"Mỏm cỏ phía Tây","rect":[1.25,10.25,2.75,10.75]},{"code":"SOUTH_SHORE","nameVi":"Bãi cỏ phía Nam","rect":[6.25,25.0,13.25,25.75]},{"code":"SOUTH_EAST_SHORE","nameVi":"Bờ Đông Nam","rect":[16.0,24.75,20.0,25.25]},{"code":"SANCTUARY_TERRACE","nameVi":"Thềm cỏ Cây Tri Thức","rect":[21.75,21.75,22.75,22.75]}]}')
ON CONFLICT (key) DO NOTHING;
