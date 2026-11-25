-- Echo Garden Phase 1 (core farming loop): docs/echo-garden/03_TECHNICAL_SPEC.md §13, Phase 1 subset.
-- Additive only. Schema public (feature-table convention, V70/V76); every owner FK is ON DELETE RESTRICT.
-- All balance numbers are seeded here (docs/echo-garden/02_ECONOMY_AND_NUMBERS.md); logic never hard-codes them.
-- Phase 2/3 tables (knowledge trees, pests, shop, decor, quests) and their config keys arrive with their phases.

-- ===== configuration =====
CREATE TABLE IF NOT EXISTS public.garden_crop_def (
    code VARCHAR(40) PRIMARY KEY,
    name_vi VARCHAR(80) NOT NULL,
    rarity VARCHAR(16) NOT NULL CHECK (rarity IN ('COMMON','RARE','EPIC','LEGENDARY')),
    base_seconds INTEGER NOT NULL CHECK (base_seconds > 0),
    seed_price INTEGER NOT NULL CHECK (seed_price >= 0),
    seed_essence INTEGER NOT NULL DEFAULT 0 CHECK (seed_essence >= 0),
    sell_price INTEGER NOT NULL CHECK (sell_price >= 0),
    season VARCHAR(16) NOT NULL CHECK (season IN ('ALL','LU_HANH','CONG_SO','HOC_THUAT','THANH_NGU')),
    unlock_level INTEGER NOT NULL CHECK (unlock_level >= 1),
    harvest_xp INTEGER NOT NULL CHECK (harvest_xp >= 0),
    seed_in_fixed_shop BOOLEAN NOT NULL DEFAULT TRUE,
    qa_only BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS public.garden_item_def (
    code VARCHAR(40) PRIMARY KEY,
    kind VARCHAR(16) NOT NULL,
    name_vi VARCHAR(80) NOT NULL,
    params JSONB NOT NULL DEFAULT '{}',
    coin_price INTEGER,
    essence_price INTEGER NOT NULL DEFAULT 0,
    daily_cap INTEGER,
    weekly_cap INTEGER,
    unlock_level INTEGER NOT NULL DEFAULT 1,
    in_fixed_shop BOOLEAN NOT NULL DEFAULT FALSE,
    requires_goal BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS public.garden_config (
    key VARCHAR(80) PRIMARY KEY,
    value JSONB NOT NULL
);

-- ===== player state =====
CREATE TABLE IF NOT EXISTS public.garden_profile (
    user_id BIGINT PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
    total_xp BIGINT NOT NULL DEFAULT 0 CHECK (total_xp >= 0),
    coins BIGINT NOT NULL DEFAULT 0 CHECK (coins >= 0),
    essence INTEGER NOT NULL DEFAULT 0 CHECK (essence >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_visit_at TIMESTAMPTZ,
    last_reward_seen_at TIMESTAMPTZ,
    onboarding_step SMALLINT NOT NULL DEFAULT 0 CHECK (onboarding_step BETWEEN 0 AND 8),
    settings JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS public.garden_plot (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    kind VARCHAR(12) NOT NULL CHECK (kind IN ('CROP','KNOWLEDGE')),
    slot_index SMALLINT NOT NULL CHECK (slot_index >= 1),
    grid_x SMALLINT NOT NULL,
    grid_y SMALLINT NOT NULL,
    unlocked_at TIMESTAMPTZ,
    CONSTRAINT uq_garden_plot_slot UNIQUE (user_id, kind, slot_index),
    CONSTRAINT uq_garden_plot_owner UNIQUE (id, user_id)
);

CREATE TABLE IF NOT EXISTS public.garden_planting (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    plot_id BIGINT NOT NULL,
    crop_code VARCHAR(40) NOT NULL REFERENCES public.garden_crop_def(code) ON DELETE RESTRICT,
    planted_at TIMESTAMPTZ NOT NULL,
    base_seconds INTEGER NOT NULL CHECK (base_seconds > 0),
    tutorial BOOLEAN NOT NULL DEFAULT FALSE,
    boost_fraction NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (boost_fraction >= 0 AND boost_fraction <= 0.40),
    water_count SMALLINT NOT NULL DEFAULT 0 CHECK (water_count BETWEEN 0 AND 3),
    fertilizer_code VARCHAR(40),
    harvested_at TIMESTAMPTZ,
    harvest_tier VARCHAR(10),
    harvest_score SMALLINT,
    harvest_flags JSONB,
    -- a planting can only ever sit on a plot of the same owner
    CONSTRAINT fk_garden_planting_plot_owner FOREIGN KEY (plot_id, user_id)
        REFERENCES public.garden_plot(id, user_id) ON DELETE RESTRICT,
    CONSTRAINT ck_garden_planting_harvest CHECK (
        (harvested_at IS NULL AND harvest_tier IS NULL AND harvest_score IS NULL)
        OR (harvested_at IS NOT NULL AND harvest_tier IS NOT NULL AND harvest_score IS NOT NULL))
);
-- one growing crop per plot; double planting is impossible even under concurrency
CREATE UNIQUE INDEX IF NOT EXISTS ux_garden_planting_active_plot ON public.garden_planting(plot_id) WHERE harvested_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_garden_planting_user_active ON public.garden_planting(user_id) WHERE harvested_at IS NULL;

CREATE TABLE IF NOT EXISTS public.garden_boost_use (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    planting_id BIGINT NOT NULL REFERENCES public.garden_planting(id) ON DELETE RESTRICT,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    item_code VARCHAR(40) NOT NULL,
    used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    op_key UUID NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_garden_boost_planting ON public.garden_boost_use(planting_id);

-- ===== inventory, ledger, idempotency =====
CREATE TABLE IF NOT EXISTS public.garden_inventory (
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    item_code VARCHAR(40) NOT NULL,          -- 'WATER', 'FERTILIZER', 'SEED:WHEAT', 'CROP:WHEAT'
    tier VARCHAR(10) NOT NULL DEFAULT 'NA',  -- quality tier for CROP:*, 'NA' otherwise
    qty INTEGER NOT NULL CHECK (qty >= 0),
    PRIMARY KEY (user_id, item_code, tier)
);

CREATE TABLE IF NOT EXISTS public.garden_ledger (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    asset VARCHAR(40) NOT NULL,              -- 'COIN', 'XP' or an inventory item code
    tier VARCHAR(10) NOT NULL DEFAULT 'NA',
    delta BIGINT NOT NULL CHECK (delta <> 0),
    reason VARCHAR(30) NOT NULL,
    ref_type VARCHAR(30),
    ref_id VARCHAR(80),
    op_key UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_garden_ledger_user_time ON public.garden_ledger(user_id, created_at);
-- the starter pack can be granted once per garden, whatever the request path
CREATE UNIQUE INDEX IF NOT EXISTS ux_garden_ledger_starter ON public.garden_ledger(user_id, asset, tier) WHERE reason = 'STARTER';

CREATE OR REPLACE FUNCTION public.garden_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'garden_ledger is append-only';
END $$;
DROP TRIGGER IF EXISTS trg_garden_ledger_append_only ON public.garden_ledger;
CREATE TRIGGER trg_garden_ledger_append_only BEFORE UPDATE OR DELETE ON public.garden_ledger
    FOR EACH ROW EXECUTE FUNCTION public.garden_ledger_append_only();

CREATE TABLE IF NOT EXISTS public.garden_operation (
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    idem_key UUID NOT NULL,
    op_type VARCHAR(30) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    status VARCHAR(10) NOT NULL CHECK (status IN ('DONE')),
    response JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS ix_garden_operation_created ON public.garden_operation(created_at);

-- ===== learning ingest, daily stats =====
CREATE TABLE IF NOT EXISTS public.garden_learning_event (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    source VARCHAR(30) NOT NULL,
    source_ref VARCHAR(80) NOT NULL,
    subject_ref VARCHAR(80),                 -- flashcard id for FLASHCARD_REVIEW
    occurred_at TIMESTAMPTZ NOT NULL,
    day_key DATE NOT NULL,
    units NUMERIC(6,3) NOT NULL DEFAULT 0,
    meta JSONB NOT NULL DEFAULT '{}',
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_garden_learning_source UNIQUE (source, source_ref)
);
CREATE INDEX IF NOT EXISTS ix_garden_learning_user_day ON public.garden_learning_event(user_id, day_key, source, subject_ref);

CREATE TABLE IF NOT EXISTS public.garden_ingest_cursor (
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    source VARCHAR(30) NOT NULL,
    last_occurred_at TIMESTAMPTZ NOT NULL,
    last_source_id BIGINT NOT NULL,
    PRIMARY KEY (user_id, source)
);

CREATE TABLE IF NOT EXISTS public.garden_daily_stats (
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    day_key DATE NOT NULL,
    flash_units_raw NUMERIC(8,2) NOT NULL DEFAULT 0,
    flash_units_effective NUMERIC(8,2) NOT NULL DEFAULT 0,
    water_carry NUMERIC(6,3) NOT NULL DEFAULT 0,
    reviews_count INTEGER NOT NULL DEFAULT 0,
    goal_done_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, day_key)
);

-- ===== harvest questions, codex, event log =====
CREATE TABLE IF NOT EXISTS public.garden_challenge (
    id UUID PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    kind VARCHAR(12) NOT NULL CHECK (kind IN ('HARVEST','GRADUATION')),
    target_ids BIGINT[] NOT NULL,
    questions JSONB NOT NULL,                -- answers stay server-side, never sent to the client
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    result JSONB
);
CREATE INDEX IF NOT EXISTS ix_garden_challenge_user ON public.garden_challenge(user_id, created_at);

CREATE TABLE IF NOT EXISTS public.garden_codex (
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    crop_code VARCHAR(40) NOT NULL REFERENCES public.garden_crop_def(code) ON DELETE RESTRICT,
    form VARCHAR(12) NOT NULL,
    first_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, crop_code, form)
);

CREATE TABLE IF NOT EXISTS public.garden_event_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    type VARCHAR(30) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_garden_event_type_time ON public.garden_event_log(type, created_at);
CREATE INDEX IF NOT EXISTS ix_garden_event_user_time ON public.garden_event_log(user_id, created_at);

CREATE OR REPLACE VIEW public.v_garden_daily_kpi AS
SELECT d.day_key,
       COUNT(DISTINCT d.user_id)                                          AS garden_players,
       AVG(d.flash_units_raw)                                             AS avg_flash_units,
       COUNT(*) FILTER (WHERE d.goal_done_at IS NOT NULL)::float
         / NULLIF(COUNT(*), 0)                                            AS goal_rate
FROM public.garden_daily_stats d
GROUP BY d.day_key;

-- ===== seed: crops (02 §2) =====
INSERT INTO public.garden_crop_def
    (code, name_vi, rarity, base_seconds, seed_price, seed_essence, sell_price, season, unlock_level, harvest_xp, seed_in_fixed_shop, qa_only, sort_order)
VALUES
    ('WHEAT',          'Lúa mì',      'COMMON',     1200,   5,  0,  15, 'ALL',        1,   4, TRUE,  FALSE, 1),
    ('TOMATO',         'Cà chua',     'COMMON',     2700,  15,  0,  38, 'ALL',        1,   6, TRUE,  FALSE, 2),
    ('CORN',           'Ngô',         'COMMON',     5400,  25,  0,  70, 'ALL',        2,   9, TRUE,  FALSE, 3),
    ('STRAWBERRY',     'Dâu tây',     'RARE',       7200,  40,  0, 102, 'LU_HANH',    3,  15, TRUE,  FALSE, 4),
    ('ROSE',           'Hoa hồng',    'RARE',      14400,  70,  0, 192, 'LU_HANH',    4,  25, TRUE,  FALSE, 5),
    ('WATERMELON',     'Dưa hấu',     'RARE',      18000,  90,  0, 240, 'CONG_SO',    6,  30, TRUE,  FALSE, 6),
    ('PUMPKIN',        'Bí ngô',      'RARE',      21600, 110,  0, 290, 'HOC_THUAT',  8,  35, TRUE,  FALSE, 7),
    ('MOONFLOWER',     'Hoa Trăng',   'EPIC',      28800, 180,  2, 420, 'HOC_THUAT', 10,  50, TRUE,  FALSE, 8),
    ('FROST_LILY',     'Huệ Băng',    'EPIC',      36000, 220,  3, 520, 'THANH_NGU', 12,  60, TRUE,  FALSE, 9),
    ('CRYSTAL_ORCHID', 'Lan Pha Lê',  'LEGENDARY', 64800, 400, 15, 940, 'THANH_NGU', 15, 120, FALSE, FALSE, 10),
    -- 60-second QA crop, visible only to app.garden.qa-user-ids; zero prices/XP so it cannot inflate the economy
    ('QA_SPROUT',      'Mầm thử nghiệm', 'COMMON',     60,   0,  0,   0, 'ALL',        1,   0, TRUE,  TRUE,  99)
ON CONFLICT (code) DO NOTHING;

-- ===== seed: care items (02 §3); prices/caps are Phase 3 shop data, Phase 1 sells no care items =====
INSERT INTO public.garden_item_def (code, kind, name_vi, params, coin_price, essence_price, daily_cap, unlock_level, in_fixed_shop)
VALUES
    ('WATER',              'BOOST', 'Nước',                 '{"group":"WATER","fraction":0.04,"perPlanting":3}',       45, 0, 10, 1, TRUE),
    ('FERTILIZER',         'BOOST', 'Phân bón',             '{"group":"FERTILIZER","fraction":0.10,"perPlanting":1}', 120, 0,  5, 1, TRUE),
    ('FERTILIZER_PREMIUM', 'BOOST', 'Phân bón Thượng hạng', '{"group":"FERTILIZER","fraction":0.20,"perPlanting":1}', 260, 0,  2, 1, TRUE)
ON CONFLICT (code) DO NOTHING;

-- ===== seed: Phase 1 configuration (02 §17 subset + Phase 1 rules) =====
INSERT INTO public.garden_config (key, value) VALUES
    ('timezone',                 '"Asia/Ho_Chi_Minh"'),
    ('boost.maxFraction',        '0.40'),
    ('speed.floor',              '0.5'),
    ('speed.inSeason',           '1.25'),
    ('speed.offSeason',          '0.70'),
    ('speed.allSeason',          '1.0'),
    ('season.epochMonday',       '"2026-10-05"'),
    ('season.order',             '["LU_HANH","CONG_SO","HOC_THUAT","THANH_NGU"]'),
    ('growth.stageThresholds',   '[0.10, 0.45]'),
    ('growth.estimateHorizonDays', '7'),
    ('tutorial',                 '{"crop":"WHEAT","seconds":60}'),
    ('quality.tiers',            '[[0,"NORMAL",1.0,1.0],[50,"GOOD",1.15,1.10],[75,"PERFECT",1.35,1.25],[95,"GOLDEN",1.75,1.50]]'),
    ('quality.points',           '{"recallPerCorrect":10,"pestClean":25,"pestLate":10,"seasonIn":20,"seasonCommon":10,"seasonOff":0,"cared":15,"fresh":10}'),
    ('quality.freshMinHours',    '2'),
    ('quality.freshFraction',    '0.5'),
    ('mutation.base',            '0.03'),
    ('codex.moonlitHours',       '[19, 5]'),
    ('blessing.sellMultiplier',  '1.5'),
    ('reward.unitsPerWater',     '5'),
    ('reward.diminishing',       '[[20,1.0],[40,0.7],[999999,0.3]]'),
    ('reward.reviewUnit',        '1'),
    ('reward.repeatSameDayUnit', '0'),
    ('reward.xpPerUnit',         '2'),
    ('goal',                     '{"units":20,"dueMinReviews":5,"xp":30}'),
    ('level.xpFormula',          '{"a":30,"p":1.55,"b":20}'),
    ('challenge',                '{"questions":3,"reverse":1,"options":4,"expirySeconds":300,"recentDays":14}'),
    ('starter',                  '{"coins":200,"items":{"WATER":3,"FERTILIZER":1,"SEED:WHEAT":4,"SEED:TOMATO":2}}'),
    -- the six starter beds of echoGardenLayout.json (slot order = plot_1..plot_6)
    ('plots.starter',            '[[8,18],[9,18],[10,18],[8,19],[9,19],[10,19]]'),
    ('codex.newFormXp',          '20'),
    ('coin.scale',               '1.0')
ON CONFLICT (key) DO NOTHING;
