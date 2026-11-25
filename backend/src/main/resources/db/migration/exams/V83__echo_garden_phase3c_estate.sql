-- Echo Garden Phase 3C (estate): building upgrades (cottage, storehouse, market stall), farmland regions beyond the
-- ten beds, staged Forgotten Pest damage, Echo Contribution (append-only, capped) and the Echo Rewards catalogue.
-- docs/echo-garden/PHASE3_SYSTEM_BLUEPRINT.md §8, numbers from docs/echo-garden/PHASE3C_ECONOMY_SIM_RESULTS.md.
-- Additive only: V77 / V78 / V80 / V82 (Garden) and V79 / V81 (Echo Quiz Rush) are never edited. Schema public, owner
-- FKs ON DELETE RESTRICT, no foreign key into another module, no write to any other module, no entitlement grant:
-- every reward that would need a Premium, AI-quota or avatar-frame integration is seeded DISABLED with no delivery
-- mechanism and cannot be enabled by a flag alone (CHECK below). Applied only by normal application startup.

-- ===== buildings: one row per (garden, building) once its first level is bought; a level only ever rises by one =====
CREATE TABLE IF NOT EXISTS public.garden_building (
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    code VARCHAR(16) NOT NULL CHECK (code IN ('COTTAGE','WAREHOUSE','MARKET')),
    level SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 9),
    coins_paid BIGINT NOT NULL DEFAULT 0 CHECK (coins_paid >= 0),
    upgraded_at TIMESTAMPTZ NOT NULL,
    op_key UUID NOT NULL,
    PRIMARY KEY (user_id, code)
);

CREATE OR REPLACE FUNCTION public.garden_building_keep() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'garden_building rows are never deleted';
    END IF;
    IF NEW.user_id <> OLD.user_id OR NEW.code <> OLD.code OR NEW.level <> OLD.level + 1 OR NEW.coins_paid < OLD.coins_paid THEN
        RAISE EXCEPTION 'a building only ever rises by one level';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_garden_building_keep ON public.garden_building;
CREATE TRIGGER trg_garden_building_keep BEFORE UPDATE OR DELETE ON public.garden_building
    FOR EACH ROW EXECUTE FUNCTION public.garden_building_keep();

-- ===== Echo Contribution: a capped, non-transferable record of verified learning and real farm achievements =====
CREATE TABLE IF NOT EXISTS public.garden_contribution (
    user_id BIGINT PRIMARY KEY REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
    earned INTEGER NOT NULL DEFAULT 0 CHECK (earned >= 0),
    spent INTEGER NOT NULL DEFAULT 0 CHECK (spent >= 0),
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT ck_garden_contribution_sum CHECK (balance = earned - spent)
);

-- one entry per (garden, source, source_ref): a fact is credited at most once, whatever the request path.
-- points > 0 earned, points < 0 redeemed, points = 0 a fact that the day / week / month cap left without points
-- (still recorded, so it can never be replayed later). `nominal`: the uncapped value; `capped`: counts toward the caps.
CREATE TABLE IF NOT EXISTS public.garden_contribution_entry (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    source VARCHAR(16) NOT NULL,
    source_ref VARCHAR(80) NOT NULL,
    points INTEGER NOT NULL,
    nominal INTEGER NOT NULL,
    capped BOOLEAN NOT NULL DEFAULT FALSE,
    day_key DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_garden_contribution_entry UNIQUE (user_id, source, source_ref),
    CONSTRAINT ck_garden_contribution_entry_sign CHECK (
        (source = 'REDEEM' AND points < 0 AND nominal = points)
        OR (source = 'REVERSAL' AND points > 0 AND nominal = points)
        OR (source NOT IN ('REDEEM','REVERSAL') AND points >= 0 AND nominal >= points))
);
CREATE INDEX IF NOT EXISTS ix_garden_contribution_entry_recent ON public.garden_contribution_entry(user_id, id DESC);
CREATE INDEX IF NOT EXISTS ix_garden_contribution_entry_caps ON public.garden_contribution_entry(user_id, day_key) WHERE capped;

CREATE OR REPLACE FUNCTION public.garden_contribution_entry_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'garden_contribution_entry is append-only';
END $$;
DROP TRIGGER IF EXISTS trg_garden_contribution_entry_append_only ON public.garden_contribution_entry;
CREATE TRIGGER trg_garden_contribution_entry_append_only BEFORE UPDATE OR DELETE ON public.garden_contribution_entry
    FOR EACH ROW EXECUTE FUNCTION public.garden_contribution_entry_append_only();

-- ===== Echo Rewards: catalogue (configuration), redemptions (audit) and the global issue counter =====
CREATE TABLE IF NOT EXISTS public.garden_reward_def (
    code VARCHAR(40) PRIMARY KEY,
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('GARDEN_SKIN','AVATAR_FRAME','AI_VOUCHER','PREMIUM_TRIAL')),
    name_vi VARCHAR(80) NOT NULL,
    description_vi VARCHAR(240) NOT NULL,
    cost INTEGER NOT NULL CHECK (cost > 0),
    per_user_limit INTEGER NOT NULL CHECK (per_user_limit > 0),
    global_limit INTEGER CHECK (global_limit >= 0),
    min_learning_days INTEGER NOT NULL DEFAULT 0 CHECK (min_learning_days >= 0),
    min_garden_days INTEGER NOT NULL DEFAULT 0 CHECK (min_garden_days >= 0),
    -- the real delivery mechanism; UNAVAILABLE = none exists in this code base yet
    delivery VARCHAR(16) NOT NULL CHECK (delivery IN ('GARDEN_SKIN','UNAVAILABLE')),
    payload JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL,
    -- a reward without a verified delivery mechanism can never be switched on by data alone
    CONSTRAINT ck_garden_reward_deliverable CHECK (NOT enabled OR delivery <> 'UNAVAILABLE'),
    -- only in-garden cosmetics are deliverable by this migration; paid entitlements need their own integration
    CONSTRAINT ck_garden_reward_kind_delivery CHECK (delivery = 'UNAVAILABLE' OR (delivery = 'GARDEN_SKIN' AND kind = 'GARDEN_SKIN'))
);

CREATE TABLE IF NOT EXISTS public.garden_reward_redemption (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    reward_code VARCHAR(40) NOT NULL REFERENCES public.garden_reward_def(code) ON DELETE RESTRICT,
    cost INTEGER NOT NULL CHECK (cost > 0),
    status VARCHAR(12) NOT NULL DEFAULT 'FULFILLED' CHECK (status IN ('FULFILLED','REVERSED')),
    delivery VARCHAR(16) NOT NULL,
    delivery_ref VARCHAR(80) NOT NULL,
    op_key UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    reversed_at TIMESTAMPTZ,
    reversal_note VARCHAR(240),
    CONSTRAINT uq_garden_reward_redemption_op UNIQUE (user_id, op_key),
    CONSTRAINT ck_garden_reward_redemption_reversal CHECK (
        (status = 'FULFILLED' AND reversed_at IS NULL AND reversal_note IS NULL)
        OR (status = 'REVERSED' AND reversed_at IS NOT NULL AND reversal_note IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_garden_reward_redemption_user ON public.garden_reward_redemption(user_id, id DESC);

CREATE OR REPLACE FUNCTION public.garden_reward_redemption_keep() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'garden_reward_redemption rows are never deleted';
    END IF;
    IF OLD.status <> 'FULFILLED' OR NEW.status <> 'REVERSED' OR NEW.user_id <> OLD.user_id OR NEW.reward_code <> OLD.reward_code
       OR NEW.cost <> OLD.cost OR NEW.delivery <> OLD.delivery OR NEW.delivery_ref <> OLD.delivery_ref
       OR NEW.op_key <> OLD.op_key OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'a redemption is permanent: only FULFILLED -> REVERSED is allowed';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_garden_reward_redemption_keep ON public.garden_reward_redemption;
CREATE TRIGGER trg_garden_reward_redemption_keep BEFORE UPDATE OR DELETE ON public.garden_reward_redemption
    FOR EACH ROW EXECUTE FUNCTION public.garden_reward_redemption_keep();

CREATE TABLE IF NOT EXISTS public.garden_reward_counter (
    reward_code VARCHAR(40) PRIMARY KEY REFERENCES public.garden_reward_def(code) ON DELETE RESTRICT,
    redeemed INTEGER NOT NULL DEFAULT 0 CHECK (redeemed >= 0)
);

-- ===== crop skins gain the REWARD path (a cultivar delivered by an Echo Reward; never sold, never earned by mastery) =====
-- V82 declared both lists as unnamed column checks: find them by their definition (never by a guessed name)
DO $$
DECLARE c RECORD;
BEGIN
    FOR c IN SELECT con.conname, rel.relname FROM pg_constraint con
             JOIN pg_class rel ON rel.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = rel.relnamespace
             WHERE ns.nspname = 'public' AND con.contype = 'c'
               AND ((rel.relname = 'garden_skin_def' AND pg_get_constraintdef(con.oid) LIKE '%unlock_kind%MASTERY%LEARNING%'
                     AND pg_get_constraintdef(con.oid) NOT LIKE '%coin_price%' AND pg_get_constraintdef(con.oid) NOT LIKE '%REWARD%')
                 OR (rel.relname = 'garden_skin_owned' AND pg_get_constraintdef(con.oid) LIKE '%source%MASTERY%LEARNING%'
                     AND pg_get_constraintdef(con.oid) NOT LIKE '%REWARD%'))
    LOOP
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', c.relname, c.conname);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_garden_skin_unlock_kind') THEN
        ALTER TABLE public.garden_skin_def ADD CONSTRAINT ck_garden_skin_unlock_kind
            CHECK (unlock_kind IN ('MASTERY','COIN','LEARNING','REWARD'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_garden_skin_owned_source') THEN
        ALTER TABLE public.garden_skin_owned ADD CONSTRAINT ck_garden_skin_owned_source
            CHECK (source IN ('MASTERY','COIN','LEARNING','REWARD'));
    END IF;
END $$;

INSERT INTO public.garden_skin_def
    (code, crop_code, name_vi, description_vi, unlock_kind, coin_price, mastery_tier, learning_days, art_key, sort_order)
VALUES
    ('WATERMELON_ECHO', 'WATERMELON', 'Dưa Hấu Sóng Echo', 'Dưa vỏ xanh biển với vân sóng trắng như lưng cá voi Echo, lá ánh lam.',
     'REWARD', 0, 0, 0, 'watermelon_echo', 7)
ON CONFLICT (code) DO NOTHING;

-- ===== seed: the reward catalogue. Only the in-garden cultivar has a delivery mechanism. The three English Coach
-- entitlements are listed so the catalogue is honest about what is planned, but stay DISABLED + UNAVAILABLE: their
-- cost, caps, budget and integration are owner decisions (PHASE3C_BUILDINGS_AND_REWARDS_REPORT.md §7). =====
INSERT INTO public.garden_reward_def
    (code, kind, name_vi, description_vi, cost, per_user_limit, global_limit, min_learning_days, min_garden_days, delivery, payload, active, enabled, sort_order)
VALUES
    ('SKIN_WATERMELON_ECHO', 'GARDEN_SKIN', 'Giống Dưa Hấu Sóng Echo',
     'Một giống dưa hấu chỉ có ở quầy Quà Echo. Chỉ đổi hình dáng cây, không đổi tốc độ lớn, chất lượng hay giá bán.',
     600, 1, NULL, 14, 14, 'GARDEN_SKIN', '{"skinCode":"WATERMELON_ECHO"}', TRUE, TRUE, 1),
    ('FRAME_GARDEN_KEEPER', 'AVATAR_FRAME', 'Khung avatar Người Giữ Vườn',
     'Khung avatar cho hồ sơ English Coach. Chưa mở: cần một khung mới và quy tắc mở khoá được duyệt riêng.',
     1500, 1, NULL, 60, 30, 'UNAVAILABLE', '{}', TRUE, FALSE, 2),
    ('AI_VOUCHER_FEEDBACK', 'AI_VOUCHER', 'Phiếu nhận xét AI',
     'Một lượt nhận xét AI trong English Coach. Chưa mở: cần hạn mức, ngân sách và tích hợp được duyệt riêng.',
     400, 2, 0, 30, 30, 'UNAVAILABLE', '{}', TRUE, FALSE, 3),
    ('PREMIUM_TRIAL', 'PREMIUM_TRIAL', 'Dùng thử Premium',
     'Một lần dùng thử Premium ngắn ngày. Chưa mở: cần thời hạn, quy tắc cấp và tích hợp được duyệt riêng.',
     2000, 1, 0, 90, 60, 'UNAVAILABLE', '{}', TRUE, FALSE, 4)
ON CONFLICT (code) DO NOTHING;

-- ===== Phase 3C configuration =====
INSERT INTO public.garden_config (key, value) VALUES
    -- Buildings: each level = farm level + coins + produce (any tier, consumed). `effects` are the only things a level
    -- changes; none of them touches growth speed, sale prices, XP or learning rewards.
    --   COTTAGE   freshBonus: the freshness window of a ripe crop is (1 + bonus) times longer; forecastExtra: weather
    --             windows revealed beyond the base forecast (a coming rainbow is still never revealed).
    --   WAREHOUSE compostDaily / premiumCompostDaily: batches of surplus produce turned into fertilizer per Vietnam day.
    --             Inventory is never capped.
    --   MARKET    featuredExtra: more seed packs of the day's rotation; stapleCapExtra / packCapExtra: more purchases per
    --             day. Prices are never changed.
    ('buildings', '{
       "COTTAGE":{"nameVi":"Nhà Gỗ","levels":[
          {"level":1,"minLevel":6,"coins":20000,"materials":{"WHEAT":12,"TOMATO":8},"effects":{"freshBonus":0.25,"forecastExtra":1}},
          {"level":2,"minLevel":10,"coins":80000,"materials":{"CORN":16,"STRAWBERRY":8},"effects":{"freshBonus":0.5,"forecastExtra":2}},
          {"level":3,"minLevel":14,"coins":240000,"materials":{"ROSE":12,"PUMPKIN":10},"effects":{"freshBonus":1.0,"forecastExtra":3}}]},
       "WAREHOUSE":{"nameVi":"Kho Nông Trại","levels":[
          {"level":1,"minLevel":5,"coins":12000,"materials":{"WHEAT":16},"effects":{"compostDaily":2,"premiumCompostDaily":0}},
          {"level":2,"minLevel":9,"coins":60000,"materials":{"TOMATO":14,"CORN":14},"effects":{"compostDaily":4,"premiumCompostDaily":1}},
          {"level":3,"minLevel":13,"coins":200000,"materials":{"WATERMELON":10,"STRAWBERRY":12},"effects":{"compostDaily":6,"premiumCompostDaily":2}}]},
       "MARKET":{"nameVi":"Quầy Chợ Echo","levels":[
          {"level":1,"minLevel":7,"coins":25000,"materials":{"TOMATO":12,"CORN":8},"effects":{"featuredExtra":1,"stapleCapExtra":0,"packCapExtra":0}},
          {"level":2,"minLevel":11,"coins":100000,"materials":{"STRAWBERRY":12,"ROSE":8},"effects":{"featuredExtra":1,"stapleCapExtra":1,"packCapExtra":0}},
          {"level":3,"minLevel":15,"coins":300000,"materials":{"PUMPKIN":12,"WATERMELON":12},"effects":{"featuredExtra":2,"stapleCapExtra":2,"packCapExtra":1}}]}}'),
    -- Compost bin (warehouse): `units` produce of any tier -> one `gives`; the premium recipe needs `minTier` or better.
    ('compost', '{"standard":{"units":8,"minTier":"NORMAL","gives":"FERTILIZER"},
                  "premium":{"units":12,"minTier":"GOOD","gives":"FERTILIZER_PREMIUM"}}'),
    -- Farmland beyond the ten beds: three regions inside the fenced farm, on reserved future-field cells only.
    -- A region opens when its gate is met (farm level, the ten earlier beds, delivered orders, real harvests); its beds
    -- are bought in order. `learningDiscount`: [verified learning days, share of the coin price waived] - learning is an
    -- advantage, never a requirement. Slots continue after the V80 beds (7..10).
    ('land', '{"maxPlots":24,
       "learningDiscount":[[21,0.05],[75,0.10],[180,0.15],[365,0.20]],
       "regions":[
         {"code":"WEST_TILLED","nameVi":"Thửa Cày Phía Tây","field":"west_tilled",
          "gate":{"level":12,"plots":10,"ordersFilled":10,"harvests":150},
          "plots":[{"slot":11,"cell":[6,19],"coins":90000,"materials":{"CORN":12,"STRAWBERRY":6}},
                   {"slot":12,"cell":[5,19],"coins":110000,"materials":{"TOMATO":16,"ROSE":6}},
                   {"slot":13,"cell":[4,19],"coins":130000,"materials":{"CORN":16,"WATERMELON":6}},
                   {"slot":14,"cell":[4,18],"coins":150000,"materials":{"STRAWBERRY":10,"PUMPKIN":6}}]},
         {"code":"WEST_FALLOW","nameVi":"Bãi Cỏ Phía Tây","field":"west_fallow",
          "gate":{"level":14,"plots":10,"ordersFilled":30,"harvests":400},
          "plots":[{"slot":15,"cell":[6,22],"coins":180000,"materials":{"ROSE":10,"WATERMELON":8}},
                   {"slot":16,"cell":[5,22],"coins":210000,"materials":{"CORN":20,"PUMPKIN":8}},
                   {"slot":17,"cell":[4,22],"coins":240000,"materials":{"STRAWBERRY":14,"WATERMELON":10}},
                   {"slot":18,"cell":[4,21],"coins":270000,"materials":{"ROSE":12,"PUMPKIN":10}}]},
         {"code":"SOUTH_FIELD","nameVi":"Cánh Đồng Phía Nam","field":"south_field",
          "gate":{"level":16,"plots":14,"ordersFilled":60,"harvests":900},
          "plots":[{"slot":19,"cell":[8,21],"coins":400000,"materials":{"WATERMELON":12,"ROSE":12}},
                   {"slot":20,"cell":[9,21],"coins":480000,"materials":{"PUMPKIN":12,"STRAWBERRY":16}},
                   {"slot":21,"cell":[10,21],"coins":580000,"materials":{"WATERMELON":14,"CORN":24}},
                   {"slot":22,"cell":[8,22],"coins":700000,"materials":{"PUMPKIN":14,"ROSE":14}},
                   {"slot":23,"cell":[9,22],"coins":850000,"materials":{"WATERMELON":16,"STRAWBERRY":18}},
                   {"slot":24,"cell":[10,22],"coins":1000000,"materials":{"PUMPKIN":16,"ROSE":16}}]}]}'),
    -- Forgotten Pest damage on a crop, by hours since the pest appeared while its word stays unreviewed:
    --   stage 1 WARNING  [0, warnHours)          no effect at all
    --   stage 2 LEAF     [warnHours, wiltHours)  growth x leafFactor, harvest pest score = leafScore
    --   stage 3 WILT     [wiltHours, ...)        growth x wiltFactor for at most wiltEffectHours, pest score = wiltScore
    -- A genuine review ends every effect at once and the crop harvests clean. Water or fertilizer given after the
    -- pest appeared halves the remaining growth penalty (`tendedRelief`); it never replaces the review.
    ('pestDamage', '{"warnHours":6,"wiltHours":24,"leafFactor":0.85,"wiltFactor":0.7,"wiltEffectHours":12,
                     "leafScore":10,"wiltScore":0,"tendedRelief":0.5}'),
    -- Echo Contribution. `capped` sources count toward the day / week / month caps (evaluated on the Vietnam day the
    -- fact happened, so old facts cannot be replayed into a fresh cap); milestones are one-time and finite.
    -- `points`: one value, or a list indexed by tier (tier 1 first).
    ('contribution', '{"caps":{"day":60,"week":200,"month":600},"scanLimit":120,"historyLimit":20,
       "sources":{
         "LEARNING_DAY":{"points":[10],"capped":true},
         "BREADTH_DAY":{"points":[5],"capped":true},
         "GRADUATION":{"points":[40],"capped":true},
         "WEEKLY_ORDER":{"points":[15],"capped":true},
         "ERA":{"points":[100,200,300,400],"capped":false},
         "BRANCH":{"points":[10,30,60],"capped":false},
         "MEMORY":{"points":[20,40,80],"capped":false},
         "RING":{"points":[50],"capped":false},
         "MASTERY":{"points":[0,0,10,25,50],"capped":false},
         "LAND_REGION":{"points":[40],"capped":false},
         "BUILDING_MAX":{"points":[40],"capped":false}}}')
ON CONFLICT (key) DO NOTHING;
