-- Echo Garden Phase 3B (living knowledge): the monumental Knowledge Tree's lifetime progression, crop mastery,
-- crop skins (cosmetic), milestone history. docs/echo-garden/PHASE3_SYSTEM_BLUEPRINT.md §7, numbers from
-- docs/echo-garden/PHASE3B_PROGRESSION_SIM_RESULTS.md.
-- Additive only: V77 / V78 / V80 (Garden) and V79 / V81 (Echo Quiz Rush) are never edited. Schema public, owner FKs
-- ON DELETE RESTRICT, no foreign key into another module, no new currency, no XP source, no entitlement.
-- Applied only by normal application startup (never manually).

-- ===== monument: one row per garden; counters only grow, an era once reached is never lost =====
CREATE TABLE IF NOT EXISTS public.garden_monument (
    user_id BIGINT PRIMARY KEY REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    era SMALLINT NOT NULL DEFAULT 0 CHECK (era BETWEEN 0 AND 4),
    learning_days INTEGER NOT NULL DEFAULT 0 CHECK (learning_days >= 0),
    vocabulary_days INTEGER NOT NULL DEFAULT 0 CHECK (vocabulary_days >= 0),
    listening_days INTEGER NOT NULL DEFAULT 0 CHECK (listening_days >= 0),
    speaking_days INTEGER NOT NULL DEFAULT 0 CHECK (speaking_days >= 0),
    writing_days INTEGER NOT NULL DEFAULT 0 CHECK (writing_days >= 0),
    exam_days INTEGER NOT NULL DEFAULT 0 CHECK (exam_days >= 0),
    graduations INTEGER NOT NULL DEFAULT 0 CHECK (graduations >= 0),
    -- the last Vietnam day whose Flashcard review log was folded in (re-read from this day on every reconcile)
    review_days_through DATE,
    -- crop mastery was seeded once from this garden's own harvest history (plantings made before V82)
    mastery_seeded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE OR REPLACE FUNCTION public.garden_monument_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'garden_monument rows are never deleted';
    END IF;
    IF NEW.era < OLD.era OR NEW.learning_days < OLD.learning_days OR NEW.vocabulary_days < OLD.vocabulary_days
       OR NEW.listening_days < OLD.listening_days OR NEW.speaking_days < OLD.speaking_days
       OR NEW.writing_days < OLD.writing_days OR NEW.exam_days < OLD.exam_days OR NEW.graduations < OLD.graduations THEN
        RAISE EXCEPTION 'garden_monument progress never decreases';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_garden_monument_monotonic ON public.garden_monument;
CREATE TRIGGER trg_garden_monument_monotonic BEFORE UPDATE OR DELETE ON public.garden_monument
    FOR EACH ROW EXECUTE FUNCTION public.garden_monument_monotonic();

-- ===== verified learning days: at most one row per (player, Vietnam day); a family flag is only ever raised =====
CREATE TABLE IF NOT EXISTS public.garden_monument_day (
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    day_key DATE NOT NULL,
    vocabulary BOOLEAN NOT NULL DEFAULT FALSE,
    listening BOOLEAN NOT NULL DEFAULT FALSE,
    speaking BOOLEAN NOT NULL DEFAULT FALSE,
    writing BOOLEAN NOT NULL DEFAULT FALSE,
    exam BOOLEAN NOT NULL DEFAULT FALSE,
    play BOOLEAN NOT NULL DEFAULT FALSE,
    recorded_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, day_key),
    CONSTRAINT ck_garden_monument_day_any CHECK (vocabulary OR listening OR speaking OR writing OR exam OR play)
);

CREATE OR REPLACE FUNCTION public.garden_monument_day_keep() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'garden_monument_day rows are never deleted';
    END IF;
    IF (OLD.vocabulary AND NOT NEW.vocabulary) OR (OLD.listening AND NOT NEW.listening) OR (OLD.speaking AND NOT NEW.speaking)
       OR (OLD.writing AND NOT NEW.writing) OR (OLD.exam AND NOT NEW.exam) OR (OLD.play AND NOT NEW.play)
       OR NEW.user_id <> OLD.user_id OR NEW.day_key <> OLD.day_key THEN
        RAISE EXCEPTION 'a verified learning day is never taken back';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_garden_monument_day_keep ON public.garden_monument_day;
CREATE TRIGGER trg_garden_monument_day_keep BEFORE UPDATE OR DELETE ON public.garden_monument_day
    FOR EACH ROW EXECUTE FUNCTION public.garden_monument_day_keep();

-- ===== graduation credit: every graduated tree is examined exactly once; its words count for the monument once =====
CREATE TABLE IF NOT EXISTS public.garden_monument_credit (
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    tree_id BIGINT NOT NULL,
    graduated_at TIMESTAMPTZ NOT NULL,
    new_words SMALLINT NOT NULL CHECK (new_words >= 0),
    credited BOOLEAN NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, tree_id),
    CONSTRAINT fk_garden_monument_credit_tree FOREIGN KEY (tree_id, user_id)
        REFERENCES public.garden_knowledge_tree(id, user_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.garden_monument_word (
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    flashcard_id BIGINT NOT NULL,
    tree_id BIGINT NOT NULL,
    credited_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, flashcard_id)
);

-- ===== milestones: permanent history (era, branch tier, memory lanterns, rings, crop mastery, skins) =====
CREATE TABLE IF NOT EXISTS public.garden_milestone (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    kind VARCHAR(12) NOT NULL CHECK (kind IN ('ERA','BRANCH','MEMORY','RING','MASTERY','SKIN')),
    code VARCHAR(40) NOT NULL,
    tier SMALLINT NOT NULL CHECK (tier >= 0),
    reached_at TIMESTAMPTZ NOT NULL,
    seen_at TIMESTAMPTZ,
    CONSTRAINT uq_garden_milestone UNIQUE (user_id, kind, code, tier)
);
CREATE INDEX IF NOT EXISTS ix_garden_milestone_user_recent ON public.garden_milestone(user_id, id DESC);
CREATE INDEX IF NOT EXISTS ix_garden_milestone_unseen ON public.garden_milestone(user_id) WHERE seen_at IS NULL;

CREATE OR REPLACE FUNCTION public.garden_milestone_keep() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'garden_milestone rows are never deleted';
    END IF;
    IF NEW.user_id <> OLD.user_id OR NEW.kind <> OLD.kind OR NEW.code <> OLD.code OR NEW.tier <> OLD.tier
       OR NEW.reached_at <> OLD.reached_at OR (OLD.seen_at IS NOT NULL AND NEW.seen_at IS DISTINCT FROM OLD.seen_at) THEN
        RAISE EXCEPTION 'garden_milestone is permanent: only seen_at may be set once';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_garden_milestone_keep ON public.garden_milestone;
CREATE TRIGGER trg_garden_milestone_keep BEFORE UPDATE OR DELETE ON public.garden_milestone
    FOR EACH ROW EXECUTE FUNCTION public.garden_milestone_keep();

-- ===== crop mastery: counters of real harvests per species (incremented inside the harvest transaction) =====
CREATE TABLE IF NOT EXISTS public.garden_crop_mastery (
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    crop_code VARCHAR(40) NOT NULL REFERENCES public.garden_crop_def(code) ON DELETE RESTRICT,
    harvests INTEGER NOT NULL DEFAULT 0 CHECK (harvests >= 0),
    best_tier SMALLINT NOT NULL DEFAULT 0 CHECK (best_tier BETWEEN 0 AND 9),
    -- bit i = a harvest in season.order[i] (the theme week of the harvest instant)
    seasons SMALLINT NOT NULL DEFAULT 0 CHECK (seasons BETWEEN 0 AND 15),
    tier SMALLINT NOT NULL DEFAULT 0 CHECK (tier BETWEEN 0 AND 9),
    first_at TIMESTAMPTZ NOT NULL,
    last_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, crop_code)
);

-- ===== crop skins: catalogue (configuration), ownership, the equipped skin per crop, the snapshot on a planting =====
CREATE TABLE IF NOT EXISTS public.garden_skin_def (
    code VARCHAR(40) PRIMARY KEY,
    crop_code VARCHAR(40) NOT NULL REFERENCES public.garden_crop_def(code) ON DELETE RESTRICT,
    name_vi VARCHAR(80) NOT NULL,
    description_vi VARCHAR(240) NOT NULL,
    unlock_kind VARCHAR(12) NOT NULL CHECK (unlock_kind IN ('MASTERY','COIN','LEARNING')),
    coin_price INTEGER NOT NULL DEFAULT 0 CHECK (coin_price >= 0),
    mastery_tier SMALLINT NOT NULL DEFAULT 0 CHECK (mastery_tier BETWEEN 0 AND 9),
    learning_days INTEGER NOT NULL DEFAULT 0 CHECK (learning_days >= 0),
    art_key VARCHAR(40) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL,
    CONSTRAINT uq_garden_skin_crop UNIQUE (code, crop_code),
    -- a price exists exactly for the coin path; the other paths are earned, never sold
    CONSTRAINT ck_garden_skin_price CHECK ((unlock_kind = 'COIN' AND coin_price > 0) OR (unlock_kind <> 'COIN' AND coin_price = 0)),
    CONSTRAINT ck_garden_skin_learning CHECK (unlock_kind <> 'LEARNING' OR learning_days > 0),
    CONSTRAINT ck_garden_skin_mastery CHECK (unlock_kind <> 'MASTERY' OR mastery_tier > 0)
);

CREATE TABLE IF NOT EXISTS public.garden_skin_owned (
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    skin_code VARCHAR(40) NOT NULL REFERENCES public.garden_skin_def(code) ON DELETE RESTRICT,
    source VARCHAR(12) NOT NULL CHECK (source IN ('MASTERY','COIN','LEARNING')),
    coins_paid BIGINT NOT NULL DEFAULT 0 CHECK (coins_paid >= 0),
    op_key UUID NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, skin_code)
);

-- one equipped skin per crop, and only a skin of that crop that this player owns (both by foreign key)
CREATE TABLE IF NOT EXISTS public.garden_skin_equipped (
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    crop_code VARCHAR(40) NOT NULL,
    skin_code VARCHAR(40) NOT NULL,
    equipped_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, crop_code),
    CONSTRAINT fk_garden_skin_equipped_owned FOREIGN KEY (user_id, skin_code)
        REFERENCES public.garden_skin_owned(user_id, skin_code) ON DELETE RESTRICT,
    CONSTRAINT fk_garden_skin_equipped_crop FOREIGN KEY (skin_code, crop_code)
        REFERENCES public.garden_skin_def(code, crop_code) ON DELETE RESTRICT
);

-- a planting keeps the skin it was planted with (history stays truthful); it can only be a skin its owner holds
ALTER TABLE public.garden_planting ADD COLUMN IF NOT EXISTS skin_code VARCHAR(40);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_garden_planting_skin') THEN
        ALTER TABLE public.garden_planting ADD CONSTRAINT fk_garden_planting_skin FOREIGN KEY (user_id, skin_code)
            REFERENCES public.garden_skin_owned(user_id, skin_code) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_garden_planting_skin_crop') THEN
        ALTER TABLE public.garden_planting ADD CONSTRAINT fk_garden_planting_skin_crop FOREIGN KEY (skin_code, crop_code)
            REFERENCES public.garden_skin_def(code, crop_code) ON DELETE RESTRICT;
    END IF;
END $$;

-- ===== seed: the launch catalogue (six cultivars; every one ships four growth-stage sprites) =====
INSERT INTO public.garden_skin_def
    (code, crop_code, name_vi, description_vi, unlock_kind, coin_price, mastery_tier, learning_days, art_key, sort_order)
VALUES
    ('WHEAT_DUSK',      'WHEAT',      'Lúa Tím Hoàng Hôn', 'Bông lúa tím thẫm với râu vàng óng, thân nâu mận.',                       'MASTERY',      0, 4,  0, 'wheat_dusk',      1),
    ('TOMATO_AMBER',    'TOMATO',     'Cà Chua Hổ Phách',  'Giống cà chua múi lớn màu hổ phách, chùm quả vàng mật.',                 'COIN',     24000, 1,  0, 'tomato_amber',    2),
    ('CORN_GEM',        'CORN',       'Bắp Ngọc Cầu Vồng', 'Bắp hạt ngọc nhiều màu, bẹ tím mận và cờ đỏ rượu.',                      'LEARNING',     0, 1, 21, 'corn_gem',        3),
    ('STRAWBERRY_SNOW', 'STRAWBERRY', 'Dâu Tuyết',         'Dâu trắng kem điểm hạt đỏ, hoa phớt hồng trên tán lá bạc hà.',           'COIN',     60000, 1,  0, 'strawberry_snow', 4),
    ('ROSE_MOON',       'ROSE',       'Hồng Nguyệt Lam',   'Hồng leo xanh ánh trăng quấn quanh giàn gỗ, toả sáng dịu khi đêm xuống.', 'MASTERY',      0, 4,  0, 'rose_moon',       5),
    ('PUMPKIN_JADE',    'PUMPKIN',    'Bí Ngọc Bích',      'Bí dẹt xanh ngọc nhiều múi sâu, cuống sần, lá viền bạc.',                'COIN',    150000, 1,  0, 'pumpkin_jade',    6)
ON CONFLICT (code) DO NOTHING;

-- ===== Phase 3B configuration =====
INSERT INTO public.garden_config (key, value) VALUES
    -- A verified learning day (Vietnam day): at least `minCardReviews` DIFFERENT cards reviewed, or one qualifying
    -- completion of an enabled learning source (same qualifying thresholds as `learning.sources`). One per day.
    -- `families`: the learning source that feeds each skill branch; `play`: sources that make a learning day without a
    -- branch. `branchTiers` / `memoryTiers`: days of a family / credited graduations for ornament tiers 1..3.
    -- `eras`: [era, verified days, credited graduations, branch tiers summed over the five families].
    -- A graduated tree is credited when at least `minNewWords` of its five words were never credited before.
    ('monument', '{"minCardReviews":5,"scanDays":400,"overlapHours":36,"creditBatch":40,"historyLimit":12,
                   "families":{"VOCABULARY":"FLASHCARD","LISTENING":"DICTATION","SPEAKING":"SHADOWING","WRITING":"WRITING","EXAM":"EXAM"},
                   "play":["CARD_BLAST","WORD_CHAIN"],
                   "branchTiers":[3,20,60],"memoryTiers":[1,5,15],"minNewWords":3,
                   "eras":[[1,21,0,1],[2,75,3,3],[3,180,10,5],[4,365,25,7]],
                   "ringEveryDays":100}'),
    -- Crop mastery tiers: [tier, harvests, best quality tier rank (0 NORMAL .. 3 GOLDEN), distinct seasons harvested,
    -- codex forms discovered]. Harvest counts are scaled by the crop's rarity (slow crops need fewer harvests).
    ('mastery', '{"tiers":[[1,1,0,0,0],[2,10,0,0,0],[3,30,2,0,0],[4,75,2,3,0],[5,150,2,4,5]],
                  "rarityScale":{"COMMON":1.0,"RARE":0.6,"EPIC":0.3,"LEGENDARY":0.1}}')
ON CONFLICT (key) DO NOTHING;
