-- Echo Garden Phase 2 (living farm): seasons + weather rules, Knowledge Trees, Memory Forest, Forgotten Pests,
-- skill-lesson learning sources, calibrated balance. docs/echo-garden/CURRENT_IMPLEMENTATION_ROADMAP.md §2.
-- Additive only: V77 is applied in production and is never edited. Schema public, owner FKs ON DELETE RESTRICT.
-- No foreign key points into Flashcard tables: the Flashcard module stays free to archive / delete cards and Garden
-- treats a missing card as "lost" (it never blocks or cascades into another module).

-- ===== ownership key on plantings (lets a pest reference a planting of the same owner only) =====
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_garden_planting_owner') THEN
        ALTER TABLE public.garden_planting ADD CONSTRAINT uq_garden_planting_owner UNIQUE (id, user_id);
    END IF;
END $$;

-- ===== daily skill-lesson / game counters (goal variants, daily caps) =====
ALTER TABLE public.garden_daily_stats ADD COLUMN IF NOT EXISTS skill_count INTEGER NOT NULL DEFAULT 0 CHECK (skill_count >= 0);
ALTER TABLE public.garden_daily_stats ADD COLUMN IF NOT EXISTS game_count INTEGER NOT NULL DEFAULT 0 CHECK (game_count >= 0);
ALTER TABLE public.garden_daily_stats ADD COLUMN IF NOT EXISTS harvest_xp_raw NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (harvest_xp_raw >= 0);
ALTER TABLE public.garden_daily_stats ADD COLUMN IF NOT EXISTS pest_cures INTEGER NOT NULL DEFAULT 0 CHECK (pest_cures >= 0);

-- ===== Knowledge Trees =====
CREATE TABLE IF NOT EXISTS public.garden_knowledge_tree (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    slot SMALLINT NOT NULL CHECK (slot BETWEEN 1 AND 3),
    species VARCHAR(12) NOT NULL CHECK (species IN ('SPRING','SUMMER','AUTUMN','WINTER')),
    planted_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','GRADUATED','RELEASED')),
    peak_stage SMALLINT NOT NULL DEFAULT 1 CHECK (peak_stage BETWEEN 1 AND 4),
    essence_banked NUMERIC(8,3) NOT NULL DEFAULT 0 CHECK (essence_banked >= 0),
    essence_since TIMESTAMPTZ NOT NULL,
    graduation_attempts INTEGER NOT NULL DEFAULT 0 CHECK (graduation_attempts >= 0),
    graduation_retry_at TIMESTAMPTZ,
    graduated_at TIMESTAMPTZ,
    released_at TIMESTAMPTZ,
    CONSTRAINT uq_garden_tree_owner UNIQUE (id, user_id),
    CONSTRAINT ck_garden_tree_status CHECK (
        (status = 'ACTIVE' AND graduated_at IS NULL AND released_at IS NULL)
        OR (status = 'GRADUATED' AND graduated_at IS NOT NULL AND released_at IS NULL)
        OR (status = 'RELEASED' AND released_at IS NOT NULL AND graduated_at IS NULL))
);
-- one growing tree per sacred spot; graduated / released trees keep their history
CREATE UNIQUE INDEX IF NOT EXISTS ux_garden_tree_active_slot ON public.garden_knowledge_tree(user_id, slot) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS ix_garden_tree_forest ON public.garden_knowledge_tree(user_id, graduated_at DESC) WHERE status = 'GRADUATED';

CREATE TABLE IF NOT EXISTS public.garden_knowledge_card (
    tree_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    position SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 5),
    flashcard_id BIGINT NOT NULL,
    word VARCHAR(255) NOT NULL,
    meaning_vi VARCHAR(255) NOT NULL,
    released_at TIMESTAMPTZ,
    PRIMARY KEY (tree_id, position),
    CONSTRAINT uq_garden_card_in_tree UNIQUE (tree_id, flashcard_id),
    CONSTRAINT fk_garden_card_tree_owner FOREIGN KEY (tree_id, user_id)
        REFERENCES public.garden_knowledge_tree(id, user_id) ON DELETE RESTRICT
);
-- a card can belong to at most one growing tree at a time (released when the tree graduates or is released)
CREATE UNIQUE INDEX IF NOT EXISTS ux_garden_card_active ON public.garden_knowledge_card(user_id, flashcard_id) WHERE released_at IS NULL;

-- ===== Forgotten Pests =====
CREATE TABLE IF NOT EXISTS public.garden_pest (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    flashcard_id BIGINT NOT NULL,
    word VARCHAR(255) NOT NULL,
    host VARCHAR(8) NOT NULL CHECK (host IN ('CROP','TREE')),
    planting_id BIGINT,
    tree_id BIGINT,
    spawned_at TIMESTAMPTZ NOT NULL,
    reviewed_at TIMESTAMPTZ,
    cleared_at TIMESTAMPTZ,
    clear_reason VARCHAR(12) CHECK (clear_reason IN ('SPRAYED','HOST_GONE','CARD_GONE')),
    rewarded BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT fk_garden_pest_planting_owner FOREIGN KEY (planting_id, user_id)
        REFERENCES public.garden_planting(id, user_id) ON DELETE RESTRICT,
    CONSTRAINT fk_garden_pest_tree_owner FOREIGN KEY (tree_id, user_id)
        REFERENCES public.garden_knowledge_tree(id, user_id) ON DELETE RESTRICT,
    CONSTRAINT ck_garden_pest_host CHECK ((host = 'CROP' AND planting_id IS NOT NULL AND tree_id IS NULL)
        OR (host = 'TREE' AND tree_id IS NOT NULL AND planting_id IS NULL)),
    CONSTRAINT ck_garden_pest_clear CHECK ((cleared_at IS NULL AND clear_reason IS NULL)
        OR (cleared_at IS NOT NULL AND clear_reason IS NOT NULL)),
    -- the only cure that rewards is a genuine review: SPRAYED requires the review evidence
    CONSTRAINT ck_garden_pest_spray CHECK (clear_reason IS DISTINCT FROM 'SPRAYED' OR reviewed_at IS NOT NULL),
    CONSTRAINT ck_garden_pest_reward CHECK (NOT rewarded OR clear_reason = 'SPRAYED')
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_garden_pest_active_card ON public.garden_pest(user_id, flashcard_id) WHERE cleared_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_garden_pest_active_planting ON public.garden_pest(planting_id) WHERE cleared_at IS NULL AND planting_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_garden_pest_user_active ON public.garden_pest(user_id) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_garden_pest_planting ON public.garden_pest(planting_id) WHERE planting_id IS NOT NULL;

-- tree evidence: distinct review days of a card after planting (bounded lookups by user + card)
CREATE INDEX IF NOT EXISTS ix_garden_learning_subject ON public.garden_learning_event(user_id, source, subject_ref, occurred_at);

-- ===== Phase 2 configuration =====
INSERT INTO public.garden_config (key, value) VALUES
    ('weather', '{"startAt":"2026-10-04T17:00:00Z","windowHours":4,"rainSpeed":1.2,"rainbowMutation":0.15,"forecastWindows":3,
                  "chances":{"LU_HANH":[0.35,0.40],"CONG_SO":[0.20,0.35],"HOC_THUAT":[0.30,0.30],"THANH_NGU":[0.30,0.15]}}'),
    ('pest',    '{"graceHours":24,"maxCropPests":2,"growthFactor":0.8,"effectHours":12,"protectMinutes":30,
                  "cureXp":5,"cureDailyCap":6,"scanLimit":20}'),
    ('knowledge', '{"slotLevels":[3,5,8],"cards":5,"evidenceCap":3,
                    "stages":[[2,5,1,0],[3,10,4,1],[4,13,9,2]],
                    "graduation":{"minAgeDays":14,"minPerCard":2,"questions":5,"reverse":2,"pass":4,"retryMinutes":30,
                                  "xp":120,"essence":5,"items":{"SEED:CRYSTAL_ORCHID":1}},
                    "essencePerDay":[0,0,0.5,1,1],"essenceStoreDays":3,"candidateLimit":80}'),
    ('learning', '{"lookbackDays":3,"batchLimit":50,
                   "categories":{"SKILL":{"xp":30,"dailyCap":3,"fertilizerFirst":2},"GAME":{"xp":5,"dailyCap":2,"fertilizerFirst":0}},
                   "sources":{"DICTATION":{"category":"SKILL","enabled":true,"minCount":3},
                              "SHADOWING":{"category":"SKILL","enabled":true,"minCount":3},
                              "WRITING":{"category":"SKILL","enabled":true,"minCount":30},
                              "EXAM":{"category":"SKILL","enabled":true,"minCount":1},
                              "CARD_BLAST":{"category":"GAME","enabled":true,"minCount":100},
                              "WORD_CHAIN":{"category":"GAME","enabled":true,"minCount":5},
                              "READING":{"category":"SKILL","enabled":false,"minCount":0},
                              "ROLEPLAY":{"category":"SKILL","enabled":false,"minCount":0},
                              "LISTENING_WATCH":{"category":"SKILL","enabled":false,"minCount":0},
                              "CARD_BLAST_PVP":{"category":"GAME","enabled":false,"minCount":0}}}'),
    -- calibration (PHASE2_ECONOMY_SIM_RESULTS.md): the day's harvest XP passes through a diminishing schedule so the
    -- number of harvests per day cannot outrun learning; coins are unaffected
    ('harvest.dailyXp', '[[40,1.0],[120,0.4],[999999,0.05]]')
ON CONFLICT (key) DO NOTHING;

-- daily goal gains the mixed variant: 10 card units + 1 skill lesson (V77 row updated, keys kept)
UPDATE public.garden_config SET value = '{"units":20,"dueMinReviews":5,"xp":30,"mixUnits":10,"mixSkills":1}'
WHERE key = 'goal' AND NOT (value ? 'mixUnits');

-- Epic seeds now cost meaningful essence (they were unobtainable before Phase 2: no essence existed); the legendary
-- orchid is never sold and comes only from graduation, so its level gate is removed (the seed is the gate)
UPDATE public.garden_crop_def SET seed_essence = 5 WHERE code = 'MOONFLOWER' AND seed_essence = 2;
UPDATE public.garden_crop_def SET seed_essence = 8 WHERE code = 'FROST_LILY' AND seed_essence = 3;
UPDATE public.garden_crop_def SET unlock_level = 1 WHERE code = 'CRYSTAL_ORCHID' AND unlock_level = 15;
