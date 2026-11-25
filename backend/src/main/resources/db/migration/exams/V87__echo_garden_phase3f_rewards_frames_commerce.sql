-- V87: Echo Garden Phase 3F — Premium 7-day reward, shared AI vouchers, twenty Echo Garden profile frames and the
-- product-safe SePay order path of the cosmetic shop.
-- docs/echo-garden/PHASE3F_PREMIUM_VOUCHERS_FRAMES_AND_SEPAY_REPORT.md · policy: PHASE3F_REWARD_COST_AND_COMMERCE_POLICY.md
--
-- Additive only. V1–V86 are applied and are not edited. No column is added to, removed from or retyped on an existing
-- table: everything new lives in new tables. Existing rows (Premium plans and subscriptions, payment orders and
-- transactions, avatar frames and their owners, every garden balance, plot, cosmetic and order) stay exactly as they are.
-- The only changes to existing objects are three CHECK lists that gain a value, one CHECK list of the skin ownership
-- source, and the cosmetic-order guard function (one more allowed transition, see section D).
--
-- Rules written into the schema (the services check them first; the database refuses a bug):
--   * a Garden Premium reward is exactly 168 hours, costs Echo Coins once, and is one real premium_subscriptions row —
--     never a payment order; the reward record is append-only;
--   * an AI voucher grant never holds more credits than it was issued with and never fewer than zero; one logical AI
--     request (user, feature, request id) uses at most one voucher;
--   * a Garden frame is bought once per account; an earned frame has no price;
--   * a cosmetic sold for VND has one fixed owner-approved price; an earned cosmetic has no SKU;
--   * a cosmetic payment belongs to one order, one transfer reference and at most one provider transaction; a refund and
--     a reconciliation issue are recorded once and only ever move forward.

-- =====================================================================================================================
-- A. Premium 7-day reward (delivered by the Premium module as a real, time-bounded subscription row)
-- =====================================================================================================================
-- An inactive plan is never listed or sold (plan list and payment-order creation read active plans only): the same
-- pattern as ADMIN_GRANT (V68). duration_months is a display value; the reward's real length is the row's own timestamps.
INSERT INTO public.premium_plans (code, name, duration_months, price_vnd, display_order, badge, active)
VALUES ('GARDEN_REWARD_7D', 'Premium 7 ngày · Echo Garden', 1, 0, 98, NULL, false)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.garden_premium_reward (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    subscription_id BIGINT NOT NULL UNIQUE REFERENCES public.premium_subscriptions(id) ON DELETE RESTRICT,
    coins_spent BIGINT NOT NULL CHECK (coins_spent > 0),
    learning_days SMALLINT NOT NULL CHECK (learning_days >= 0),
    starts_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    budget_period CHAR(7) NOT NULL,
    op_key UUID NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT ck_garden_premium_reward_168h CHECK (expires_at = starts_at + INTERVAL '168 hours')
);
CREATE INDEX IF NOT EXISTS ix_garden_premium_reward_user ON public.garden_premium_reward(user_id, created_at);

CREATE OR REPLACE FUNCTION public.garden_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
DROP TRIGGER IF EXISTS trg_garden_premium_reward_append_only ON public.garden_premium_reward;
CREATE TRIGGER trg_garden_premium_reward_append_only BEFORE UPDATE OR DELETE ON public.garden_premium_reward
    FOR EACH ROW EXECUTE FUNCTION public.garden_append_only();

-- Global issuance budget: one row per reward kind and Vietnam month. The service raises `issued` only with a guarded
-- UPDATE (issued + n <= the configured cap), inside the redemption transaction: a failed redemption rolls it back.
CREATE TABLE IF NOT EXISTS public.garden_reward_budget (
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('PREMIUM_7D','AI_VOUCHER')),
    period CHAR(7) NOT NULL,
    issued INTEGER NOT NULL DEFAULT 0 CHECK (issued >= 0),
    cost_vnd BIGINT NOT NULL DEFAULT 0 CHECK (cost_vnd >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, period)
);

-- =====================================================================================================================
-- B. AI vouchers (an account-wide wallet owned by the AI quota module; the garden only issues grants)
-- =====================================================================================================================
CREATE TABLE IF NOT EXISTS public.ai_voucher_grant (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    credits SMALLINT NOT NULL CHECK (credits BETWEEN 1 AND 10),
    remaining SMALLINT NOT NULL,
    source VARCHAR(24) NOT NULL CHECK (source IN ('GARDEN_COIN')),
    source_ref VARCHAR(64) NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT ck_ai_voucher_grant_remaining CHECK (remaining BETWEEN 0 AND credits),
    CONSTRAINT ck_ai_voucher_grant_expiry CHECK (expires_at > issued_at),
    CONSTRAINT uq_ai_voucher_grant_source UNIQUE (user_id, source, source_ref)
);
CREATE INDEX IF NOT EXISTS ix_ai_voucher_grant_user ON public.ai_voucher_grant(user_id, expires_at);

-- One row per logical AI request that used (or tried to use) a voucher. RESERVED before the AI call, CONSUMED when it
-- produced a result, RELEASED when it did not (the credit goes back to its grant). The unique key makes a retried
-- request find its own row instead of taking a second credit; `replays` counts those retries (the service allows a few,
-- shortly after the first attempt - a lost response - and then asks for a new voucher).
CREATE TABLE IF NOT EXISTS public.ai_voucher_use (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    grant_id BIGINT NOT NULL REFERENCES public.ai_voucher_grant(id) ON DELETE RESTRICT,
    feature_key VARCHAR(64) NOT NULL,
    request_id VARCHAR(128) NOT NULL,
    status VARCHAR(10) NOT NULL CHECK (status IN ('RESERVED','CONSUMED','RELEASED')),
    replays SMALLINT NOT NULL DEFAULT 0 CHECK (replays >= 0),
    created_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    CONSTRAINT uq_ai_voucher_use_request UNIQUE (user_id, feature_key, request_id)
);
CREATE INDEX IF NOT EXISTS ix_ai_voucher_use_user ON public.ai_voucher_use(user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_ai_voucher_use_reserved ON public.ai_voucher_use(status, created_at) WHERE status = 'RESERVED';

-- =====================================================================================================================
-- C. Twenty Echo Garden profile frames (the existing avatar-frame catalogue; no avatar, no new frame system)
-- =====================================================================================================================
ALTER TABLE public.avatar_frame_series DROP CONSTRAINT IF EXISTS ck_avatar_frame_series_lineage;
ALTER TABLE public.avatar_frame_series ADD CONSTRAINT ck_avatar_frame_series_lineage
    CHECK (lineage IN ('ACHIEVEMENT', 'RANKED', 'STANDARD', 'LEGACY', 'SEASONAL', 'EVENT', 'PREMIUM', 'GARDEN'));

ALTER TABLE public.avatar_frames DROP CONSTRAINT IF EXISTS ck_avatar_frames_unlock_type;
ALTER TABLE public.avatar_frames ADD CONSTRAINT ck_avatar_frames_unlock_type
    CHECK (unlock_type IN ('METRIC_THRESHOLD', 'RANK_REWARD', 'PREMIUM_SUBSCRIPTION', 'EVENT_PARTICIPATION', 'ADMIN_GRANT', 'LEGACY_DATE', 'GARDEN_COIN'));

ALTER TABLE public.user_avatar_frames DROP CONSTRAINT IF EXISTS ck_user_avatar_frames_source;
ALTER TABLE public.user_avatar_frames ADD CONSTRAINT ck_user_avatar_frames_source
    CHECK (source IN ('ACHIEVEMENT', 'RANK', 'EVENT', 'SEASONAL', 'PREMIUM', 'ADMIN_GRANT', 'LEGACY', 'GARDEN'));

-- Earlier migrations inserted frames with explicit ids and never moved the sequences: move them past the stored rows so
-- the rows below can be inserted by slug.
SELECT setval(pg_get_serial_sequence('public.avatar_frame_series', 'id'), GREATEST((SELECT COALESCE(max(id), 0) FROM public.avatar_frame_series), 1));
SELECT setval(pg_get_serial_sequence('public.avatar_frames', 'id'), GREATEST((SELECT COALESCE(max(id), 0) FROM public.avatar_frames), 1));
SELECT setval(pg_get_serial_sequence('public.avatar_frame_requirements', 'id'), GREATEST((SELECT COALESCE(max(id), 0) FROM public.avatar_frame_requirements), 1));

INSERT INTO public.avatar_frame_series (slug, name, lineage, description) VALUES
    ('garden_four_seasons', 'Echo Garden · Bốn Mùa', 'GARDEN', 'Năm khung theo bốn mùa trên Đảo Ký Ức.'),
    ('garden_festivals', 'Echo Garden · Lễ Hội', 'GARDEN', 'Năm khung của những đêm hội trên đảo.'),
    ('garden_mythical', 'Echo Garden · Huyền Thoại', 'GARDEN', 'Năm khung rồng, phượng, cực quang và tinh tú.'),
    ('garden_prestige', 'Echo Garden · Dấu Ấn Đảo', 'GARDEN', 'Năm khung dành cho người gìn giữ Đảo Ký Ức.')
ON CONFLICT (slug) DO NOTHING;

-- unlock_type GARDEN_COIN: bought once with Echo Coins in the garden (the price is the frame's GARDEN_COIN requirement).
-- unlock_type METRIC_THRESHOLD: earned from stored garden facts; it has no price and cannot be bought.
INSERT INTO public.avatar_frames (series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
SELECT s.id, f.slug, f.name, f.tier, 'STATIC_SVG', '/assets/frames/garden/' || f.slug || '.webp', '/assets/frames/garden/' || f.slug || '.webp',
       jsonb_build_object('visualTheme', f.theme, 'format', 'webp', 'canvas', 512, 'aperture', 256, 'collection', f.series), f.unlock_type, TRUE
FROM (VALUES
    ('garden_four_seasons', 'garden_spring_blossom',    'Xuân Anh Đào',            'A',   'GARDEN_SPRING',   'GARDEN_COIN'),
    ('garden_four_seasons', 'garden_golden_summer',     'Hạ Vàng Rực Nắng',        'A',   'GARDEN_SUMMER',   'GARDEN_COIN'),
    ('garden_four_seasons', 'garden_autumn_maple',      'Thu Lá Phong',            'A',   'GARDEN_AUTUMN',   'GARDEN_COIN'),
    ('garden_four_seasons', 'garden_crystal_winter',    'Đông Pha Lê',             'A',   'GARDEN_WINTER',   'GARDEN_COIN'),
    ('garden_four_seasons', 'garden_four_seasons',      'Tứ Quý Hòa Ca',           'S',   'GARDEN_SEASONS',  'METRIC_THRESHOLD'),
    ('garden_festivals',    'garden_tet_blossom',       'Xuân Tết Mai Đào',        'A',   'GARDEN_TET',      'GARDEN_COIN'),
    ('garden_festivals',    'garden_moon_lantern',      'Trăng Rằm Đèn Sao',       'A',   'GARDEN_MOON',     'GARDEN_COIN'),
    ('garden_festivals',    'garden_hoian_lantern',     'Đêm Hội Đèn Lồng Hội An', 'A',   'GARDEN_HOIAN',    'GARDEN_COIN'),
    ('garden_festivals',    'garden_golden_harvest',    'Hội Mùa Vàng',            'S',   'GARDEN_HARVEST',  'METRIC_THRESHOLD'),
    ('garden_festivals',    'garden_festival_lights',   'Thiên Đăng Hội',          'S',   'GARDEN_LIGHTS',   'GARDEN_COIN'),
    ('garden_mythical',     'garden_cloud_dragon',      'Kim Long Vân Du',         'SS',  'GARDEN_DRAGON',   'METRIC_THRESHOLD'),
    ('garden_mythical',     'garden_phoenix_fire',      'Hỏa Phụng',               'SS',  'GARDEN_PHOENIX',  'METRIC_THRESHOLD'),
    ('garden_mythical',     'garden_long_phung',        'Long Phụng Thiên Cung',   'SSS', 'GARDEN_LONGPHUNG','METRIC_THRESHOLD'),
    ('garden_mythical',     'garden_aurora_crystal',    'Cực Quang Pha Lê',        'S',   'GARDEN_AURORA',   'GARDEN_COIN'),
    ('garden_mythical',     'garden_starlight_guardian','Hộ Vệ Tinh Tú',           'S',   'GARDEN_STARLIGHT','GARDEN_COIN'),
    ('garden_prestige',     'garden_echo_whale',        'Hộ Vệ Cá Voi Echo',       'S',   'GARDEN_WHALE',    'METRIC_THRESHOLD'),
    ('garden_prestige',     'garden_knowledge_tree',    'Đại Thụ Tri Thức',        'SS',  'GARDEN_TREE',     'METRIC_THRESHOLD'),
    ('garden_prestige',     'garden_memory_forest',     'Rừng Ký Ức',              'S',   'GARDEN_FOREST',   'METRIC_THRESHOLD'),
    ('garden_prestige',     'garden_celestial_scholar', 'Học Giả Thiên Văn',       'SS',  'GARDEN_SCHOLAR',  'METRIC_THRESHOLD'),
    ('garden_prestige',     'garden_floating_island',   'Đảo Nổi Huyền Thoại',     'SSS', 'GARDEN_ISLAND',   'METRIC_THRESHOLD')
) AS f(series, slug, name, tier, theme, unlock_type)
JOIN public.avatar_frame_series s ON s.slug = f.series
ON CONFLICT (slug) DO NOTHING;

-- Requirements. GARDEN_COIN: target = the Echo Coin price. The other metrics read stored garden facts:
-- GARDEN_LEARNING_DAYS = verified learning days of the monument, GARDEN_HARVESTS = lifetime harvests,
-- GARDEN_GRADUATIONS = graduated memory trees, GARDEN_MONUMENT_ERA = the Knowledge Tree's era (0–4).
INSERT INTO public.avatar_frame_requirements (frame_id, metric_type, operator, target_value)
SELECT f.id, r.metric, 'GTE', r.target
FROM (VALUES
    ('garden_spring_blossom',     'GARDEN_COIN',          '60000'),
    ('garden_golden_summer',      'GARDEN_COIN',          '60000'),
    ('garden_autumn_maple',       'GARDEN_COIN',          '60000'),
    ('garden_crystal_winter',     'GARDEN_COIN',          '60000'),
    ('garden_four_seasons',       'GARDEN_LEARNING_DAYS', '60'),
    ('garden_tet_blossom',        'GARDEN_COIN',          '90000'),
    ('garden_moon_lantern',       'GARDEN_COIN',          '90000'),
    ('garden_hoian_lantern',      'GARDEN_COIN',          '90000'),
    ('garden_golden_harvest',     'GARDEN_HARVESTS',      '500'),
    ('garden_festival_lights',    'GARDEN_COIN',          '150000'),
    ('garden_cloud_dragon',       'GARDEN_LEARNING_DAYS', '180'),
    ('garden_phoenix_fire',       'GARDEN_GRADUATIONS',   '10'),
    ('garden_long_phung',         'GARDEN_LEARNING_DAYS', '365'),
    ('garden_long_phung',         'GARDEN_GRADUATIONS',   '15'),
    ('garden_aurora_crystal',     'GARDEN_COIN',          '200000'),
    ('garden_starlight_guardian', 'GARDEN_COIN',          '250000'),
    ('garden_echo_whale',         'GARDEN_LEARNING_DAYS', '21'),
    ('garden_knowledge_tree',     'GARDEN_MONUMENT_ERA',  '3'),
    ('garden_memory_forest',      'GARDEN_GRADUATIONS',   '5'),
    ('garden_celestial_scholar',  'GARDEN_LEARNING_DAYS', '120'),
    ('garden_floating_island',    'GARDEN_MONUMENT_ERA',  '4'),
    ('garden_floating_island',    'GARDEN_HARVESTS',      '2000')
) AS r(slug, metric, target)
JOIN public.avatar_frames f ON f.slug = r.slug
WHERE NOT EXISTS (SELECT 1 FROM public.avatar_frame_requirements x WHERE x.frame_id = f.id AND x.metric_type = r.metric);

-- The coin purchase of a frame: once per account, the ledger entry and this row are written in one transaction with the
-- ownership row of the frame module.
CREATE TABLE IF NOT EXISTS public.garden_frame_purchase (
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    frame_slug VARCHAR(64) NOT NULL REFERENCES public.avatar_frames(slug) ON DELETE RESTRICT,
    coins_paid BIGINT NOT NULL CHECK (coins_paid > 0),
    op_key UUID NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, frame_slug)
);
DROP TRIGGER IF EXISTS trg_garden_frame_purchase_append_only ON public.garden_frame_purchase;
CREATE TRIGGER trg_garden_frame_purchase_append_only BEFORE UPDATE OR DELETE ON public.garden_frame_purchase
    FOR EACH ROW EXECUTE FUNCTION public.garden_append_only();

-- =====================================================================================================================
-- D. Cosmetics for VND through the existing SePay bank-transfer path
-- =====================================================================================================================
-- Fixed owner-approved prices (2026-10-12), one SKU per catalogue item that is sold for Echo Coins. Classified by the
-- catalogue's own category column and by exact product code for the two premium statues — never by a name. An earned
-- item (unlock_kind other than COIN) gets no SKU and can never be bought.
INSERT INTO public.garden_cosmetic_sku (sku_code, item_kind, item_code, price_vnd, enabled)
SELECT 'VND_' || d.code, 'COSMETIC', d.code,
       CASE
           WHEN d.code IN ('DECOR_STATUE_DRAGON', 'DECOR_STATUE_PHOENIX') THEN 99000
           WHEN d.category = 'DECOR' THEN 19000
           WHEN d.category IN ('FENCE', 'PATH', 'BED') THEN 29000
           WHEN d.category IN ('TREE', 'SHRUB', 'FLOWER') THEN 39000
           WHEN d.category = 'MONUMENT' THEN 79000
           WHEN d.category = 'HOUSE' THEN 149000
       END, TRUE
FROM public.garden_cosmetic_def d
WHERE d.unlock_kind = 'COIN' AND d.active
ON CONFLICT DO NOTHING;

-- crop skins of the Phase 3E collections (the six earlier cultivars belong to no collection and are not sold for VND)
INSERT INTO public.garden_cosmetic_sku (sku_code, item_kind, item_code, price_vnd, enabled)
SELECT 'VND_SKIN_' || s.code, 'SKIN', s.code, 39000, TRUE
FROM public.garden_skin_def s
WHERE s.unlock_kind = 'COIN' AND s.collection_code IS NOT NULL AND s.active
ON CONFLICT DO NOTHING;

-- a crop skin delivered by a paid order
ALTER TABLE public.garden_skin_owned DROP CONSTRAINT IF EXISTS ck_garden_skin_owned_source;
ALTER TABLE public.garden_skin_owned ADD CONSTRAINT ck_garden_skin_owned_source
    CHECK (source IN ('MASTERY','COIN','LEARNING','REWARD','MONEY'));

-- The payment side of a cosmetic order (the order row itself stays the V86 table and keeps its identity guard).
-- transfer_code is the bank-transfer content, generated by the payment module in the same format as a Premium order.
-- provider_transaction_id: the one SePay transaction that paid it. Whether the delivered item was used since (a buyer's
-- refund request needs it unused) is read from the garden's own records: the event log, the equipped rows, plantings.
CREATE TABLE IF NOT EXISTS public.garden_cosmetic_payment (
    order_id BIGINT PRIMARY KEY REFERENCES public.garden_cosmetic_order(id) ON DELETE RESTRICT,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    transfer_code VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    paid_at TIMESTAMPTZ,
    provider_transaction_id VARCHAR(128) UNIQUE,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT ck_garden_cosmetic_payment_paid CHECK ((paid_at IS NULL) = (provider_transaction_id IS NULL))
);
CREATE INDEX IF NOT EXISTS ix_garden_cosmetic_payment_user ON public.garden_cosmetic_payment(user_id, created_at);

CREATE OR REPLACE FUNCTION public.garden_cosmetic_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'garden_cosmetic_payment is never deleted';
    END IF;
    IF NEW.order_id <> OLD.order_id OR NEW.user_id <> OLD.user_id OR NEW.transfer_code <> OLD.transfer_code
       OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at
       OR (OLD.paid_at IS NOT NULL AND (NEW.paid_at IS DISTINCT FROM OLD.paid_at
            OR NEW.provider_transaction_id IS DISTINCT FROM OLD.provider_transaction_id)) THEN
        RAISE EXCEPTION 'garden_cosmetic_payment identity is immutable';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_garden_cosmetic_payment_guard ON public.garden_cosmetic_payment;
CREATE TRIGGER trg_garden_cosmetic_payment_guard BEFORE UPDATE OR DELETE ON public.garden_cosmetic_payment
    FOR EACH ROW EXECUTE FUNCTION public.garden_cosmetic_payment_guard();

-- The V86 guard, plus ONE transition: EXPIRED -> FULFILLED, used only when the official administrator reconciles a
-- verified transfer that arrived after the payment window (the money is there, the order names buyer, item and amount).
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
            OR (OLD.status = 'FULFILLED' AND NEW.status = 'REFUNDED')
            OR (OLD.status = 'EXPIRED' AND NEW.status = 'FULFILLED')) THEN
        RAISE EXCEPTION 'garden_cosmetic_order cannot go from % to %', OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END $$;

-- A refund of a fulfilled order: requested by the buyer (within the policy window, item unused) or opened by the
-- administrator (delivery failure, duplicate charge, unauthorized transaction, defect, charge-back). The bank refund
-- itself is a manual transfer by the administrator; its reference is recorded here. One refund per order.
CREATE TABLE IF NOT EXISTS public.garden_cosmetic_refund (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL UNIQUE REFERENCES public.garden_cosmetic_order(id) ON DELETE RESTRICT,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('CUSTOMER_REQUEST','DELIVERY_FAILURE','DUPLICATE_CHARGE','UNAUTHORIZED','DEFECT','CHARGEBACK')),
    status VARCHAR(10) NOT NULL CHECK (status IN ('REQUESTED','COMPLETED','REJECTED')),
    reason VARCHAR(500) NOT NULL CHECK (length(btrim(reason)) > 0),
    amount_vnd BIGINT NOT NULL CHECK (amount_vnd > 0),
    requested_at TIMESTAMPTZ NOT NULL,
    decided_at TIMESTAMPTZ,
    decided_by BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    bank_reference VARCHAR(128),
    note VARCHAR(500),
    CONSTRAINT ck_garden_cosmetic_refund_decided CHECK ((status = 'REQUESTED') = (decided_at IS NULL)),
    CONSTRAINT ck_garden_cosmetic_refund_bank CHECK (status <> 'COMPLETED' OR (decided_by IS NOT NULL AND length(btrim(bank_reference)) > 0))
);
CREATE INDEX IF NOT EXISTS ix_garden_cosmetic_refund_status ON public.garden_cosmetic_refund(status, requested_at);

CREATE OR REPLACE FUNCTION public.garden_cosmetic_refund_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'garden_cosmetic_refund is never deleted';
    END IF;
    IF OLD.status <> 'REQUESTED' OR NEW.status = 'REQUESTED' OR NEW.order_id <> OLD.order_id OR NEW.user_id <> OLD.user_id
       OR NEW.kind <> OLD.kind OR NEW.reason <> OLD.reason OR NEW.amount_vnd <> OLD.amount_vnd OR NEW.requested_at <> OLD.requested_at THEN
        RAISE EXCEPTION 'garden_cosmetic_refund only moves from REQUESTED to a decision';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_garden_cosmetic_refund_guard ON public.garden_cosmetic_refund;
CREATE TRIGGER trg_garden_cosmetic_refund_guard BEFORE UPDATE OR DELETE ON public.garden_cosmetic_refund
    FOR EACH ROW EXECUTE FUNCTION public.garden_cosmetic_refund_guard();

-- A verified transfer that names a cosmetic order but could not be delivered automatically: money arrived, nothing was
-- granted, an administrator must reconcile it (deliver a late payment, or refund the transfer by hand).
CREATE TABLE IF NOT EXISTS public.garden_commerce_issue (
    id BIGSERIAL PRIMARY KEY,
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('LATE_PAYMENT','AMOUNT_MISMATCH','ALREADY_OWNED','ORDER_CLOSED','DUPLICATE_PAYMENT','UNAVAILABLE')),
    order_id BIGINT NOT NULL REFERENCES public.garden_cosmetic_order(id) ON DELETE RESTRICT,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    provider_transaction_id VARCHAR(128) NOT NULL UNIQUE,
    paid_amount_vnd BIGINT NOT NULL CHECK (paid_amount_vnd > 0),
    status VARCHAR(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
    resolution VARCHAR(20) CHECK (resolution IN ('DELIVERED','REFUNDED_MANUALLY','DISMISSED')),
    resolved_by BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    resolved_at TIMESTAMPTZ,
    bank_reference VARCHAR(128),
    note VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT ck_garden_commerce_issue_resolved CHECK ((status = 'RESOLVED') = (resolution IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_garden_commerce_issue_status ON public.garden_commerce_issue(status, created_at);

CREATE OR REPLACE FUNCTION public.garden_commerce_issue_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'garden_commerce_issue is never deleted';
    END IF;
    IF OLD.status <> 'OPEN' OR NEW.status <> 'RESOLVED' OR NEW.kind <> OLD.kind OR NEW.order_id <> OLD.order_id OR NEW.user_id <> OLD.user_id
       OR NEW.provider_transaction_id <> OLD.provider_transaction_id OR NEW.paid_amount_vnd <> OLD.paid_amount_vnd
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'garden_commerce_issue only moves from OPEN to RESOLVED';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_garden_commerce_issue_guard ON public.garden_commerce_issue;
CREATE TRIGGER trg_garden_commerce_issue_guard BEFORE UPDATE OR DELETE ON public.garden_commerce_issue
    FOR EACH ROW EXECUTE FUNCTION public.garden_commerce_issue_guard();

-- Payment module: what a webhook transaction was matched to when it is not a Premium order (payment_orders is untouched
-- and stays Premium-only). One row per transaction, written in the reconciliation transaction.
CREATE TABLE IF NOT EXISTS public.payment_product_match (
    transaction_id BIGINT PRIMARY KEY REFERENCES public.payment_transactions(id) ON DELETE RESTRICT,
    product_kind VARCHAR(32) NOT NULL,
    product_ref VARCHAR(128) NOT NULL,
    outcome VARCHAR(32) NOT NULL,
    detail VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_payment_product_match_ref ON public.payment_product_match(product_kind, product_ref);

-- =====================================================================================================================
-- E. Owner policy numbers (2026-10-12), read by the services like every other garden rule (never hard-coded)
-- =====================================================================================================================
-- premium: 1,000,000 Echo Coins for exactly 168 hours; at most 3 redemptions in any rolling 365 days; the next one no
--   sooner than 90 full days after the previous reward ended; 15 learning days among the last 30 Vietnam dates.
-- voucher: 1 credit = 25,000, 5 credits = 100,000; at most 10 bought credits in any rolling 30 days; valid 90 days.
-- checkout: a cosmetic QR order is payable for 15 minutes (the Premium order window is separate and unchanged);
--   `graceSeconds` covers the bank-to-webhook delay of a transfer made inside the window.
-- refund: the buyer may ask within 7 days for an item that was never used.
INSERT INTO public.garden_config (key, value) VALUES
    ('rewards3f', '{"premium":{"coins":1000000,"hours":168,"maxPerWindow":3,"windowDays":365,"cooldownDays":90,"learningDays":15,"learningWindowDays":30},"voucher":{"packs":[{"code":"ONE","credits":1,"coins":25000},{"code":"FIVE","credits":5,"coins":100000}],"capCredits":10,"capWindowDays":30,"validDays":90},"checkout":{"ttlMinutes":15,"graceSeconds":120},"refund":{"requestDays":7}}'::jsonb)
ON CONFLICT (key) DO NOTHING;
