-- V89: Echo Garden Phase 3H — livestock (chicken, duck, pig, sheep), guardian pets (dog, goose, cat), their housing,
-- feed and products, and the island-visibility choice that precedes the public opening of the social islands.
-- docs/echo-garden/PHASE3H_LIVESTOCK_GUARDIANS_AND_PUBLIC_ROLLOUT_REPORT.md
--
-- Additive only. V1–V88 are applied and are not edited. Two new tables, one nullable column on garden_social_profile
-- (existing rows are marked as already decided, with their own creation time) and two new garden_config keys.
-- A backend on this schema without the `animals` key behaves exactly like Phase 3G.
--
-- Rules written into the schema (the service checks them first; the database refuses a bug):
--   * an animal belongs to one garden; livestock stands in one of that garden's own houses, in one of at most four
--     numbered places (the service's capacity may be lower, never higher); a guardian has no house;
--   * a garden has at most ONE guardian of each species;
--   * progress counters never go below zero; nothing here can delete an animal (no death, no loss).

-- =====================================================================================================================
-- A. Animal houses (one row per garden and house; the trough is shared by the animals of the house)
-- =====================================================================================================================
CREATE TABLE IF NOT EXISTS public.garden_animal_house (
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    code VARCHAR(24) NOT NULL,
    built_at TIMESTAMPTZ NOT NULL,
    watered_until TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, code),
    CONSTRAINT ck_garden_animal_house_code CHECK (code ~ '^[A-Z_]{1,24}$')
);

-- =====================================================================================================================
-- B. Animals: livestock and guardians
-- =====================================================================================================================
-- progress_at: the instant up to which growth and production are already counted. growth_seconds: cared-for time
-- toward adulthood. product_seconds: cared-for adult time not yet collected (the engine caps it at the animal's small
-- store, so an absent player never accumulates without bound). fed_until: end of the food in the trough.
-- guard_at: the last time a guardian dog turned a visitor away (its cooldown starts there).
CREATE TABLE IF NOT EXISTS public.garden_animal (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.garden_profile(user_id) ON DELETE RESTRICT,
    species VARCHAR(16) NOT NULL,
    kind VARCHAR(10) NOT NULL,
    house_code VARCHAR(24),
    place SMALLINT,
    acquired_at TIMESTAMPTZ NOT NULL,
    progress_at TIMESTAMPTZ NOT NULL,
    growth_seconds BIGINT NOT NULL DEFAULT 0,
    product_seconds BIGINT NOT NULL DEFAULT 0,
    fed_until TIMESTAMPTZ NOT NULL,
    guard_at TIMESTAMPTZ,
    op_key UUID NOT NULL,
    CONSTRAINT fk_garden_animal_house FOREIGN KEY (user_id, house_code)
        REFERENCES public.garden_animal_house(user_id, code) ON DELETE RESTRICT,
    CONSTRAINT ck_garden_animal_kind CHECK (kind IN ('LIVESTOCK','GUARDIAN')),
    CONSTRAINT ck_garden_animal_species CHECK (species ~ '^[A-Z_]{1,16}$'),
    CONSTRAINT ck_garden_animal_home CHECK ((kind = 'LIVESTOCK') = (house_code IS NOT NULL AND place IS NOT NULL)),
    CONSTRAINT ck_garden_animal_place CHECK (place IS NULL OR place BETWEEN 1 AND 4),
    CONSTRAINT ck_garden_animal_counters CHECK (growth_seconds >= 0 AND product_seconds >= 0),
    CONSTRAINT uq_garden_animal_place UNIQUE (user_id, house_code, place),
    CONSTRAINT uq_garden_animal_op UNIQUE (user_id, op_key)
);
CREATE INDEX IF NOT EXISTS ix_garden_animal_user ON public.garden_animal(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_garden_animal_guardian ON public.garden_animal(user_id, species) WHERE kind = 'GUARDIAN';

-- an animal is never removed: neglect only pauses it (no death, no disappearance)
CREATE OR REPLACE FUNCTION public.garden_animal_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'a garden animal is never deleted';
END $$;
DROP TRIGGER IF EXISTS trg_garden_animal_no_delete ON public.garden_animal;
CREATE TRIGGER trg_garden_animal_no_delete BEFORE DELETE ON public.garden_animal
    FOR EACH ROW EXECUTE FUNCTION public.garden_animal_no_delete();

-- =====================================================================================================================
-- C. Island visibility is chosen by its owner before the island can be found
-- =====================================================================================================================
-- NULL = the owner has not decided yet: a garden created from now on starts closed and asks once. Gardens that already
-- have a social profile were created under the Phase 3G rule and keep their visibility; they count as decided.
ALTER TABLE public.garden_social_profile ADD COLUMN IF NOT EXISTS visibility_chosen_at TIMESTAMPTZ;
UPDATE public.garden_social_profile SET visibility_chosen_at = created_at WHERE visibility_chosen_at IS NULL;

INSERT INTO public.garden_config (key, value) VALUES ('socialOnboarding', '{"defaultVisibility": "PRIVATE"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- =====================================================================================================================
-- D. Rules (numbers live here, never in code; a change is a new migration)
-- =====================================================================================================================
-- feed.mill: feed units one produce unit gives (any quality). feed.maxHours: food never reaches further ahead than
-- this. feed.learningBonusBp: a ration given on a day whose learning goal is met lasts this much longer.
-- water: one `item` refills a house's trough for `hours`; a refill is refused while more than `refillBelowHours` is left.
-- restGrowthBp: a young animal without care still grows, at this share of the normal speed (it never gets stuck).
-- livestock: growHours of cared-for time to adulthood; one ration (rationFeed feed) lasts rationHours; an adult gives one
-- product per productHours of cared-for time and holds at most storeCap of them (then it rests until collected).
-- compost: `manure` units of manure become one `gives`, at most dailyCap times a Vietnam day.
-- guardians: DOG turns away one otherwise valid take per cooldownHours and then guards the island for shieldHours;
-- GOOSE lengthens the owner's head start on a freshly ripe crop by graceMinutes; CAT lowers the number of Forgotten
-- Pests that may sit on crops at once by pestCapReduction (never below one). A guardian works only while it is fed.
INSERT INTO public.garden_config (key, value) VALUES ('animals', '{
  "feed": {
    "item": "FEED",
    "mill": {"WHEAT": 1, "TOMATO": 2, "CORN": 4, "STRAWBERRY": 6, "WATERMELON": 14, "PUMPKIN": 18},
    "maxHours": 48,
    "learningBonusBp": 2500
  },
  "water": {"item": "WELL_WATER", "hours": 48, "refillBelowHours": 24},
  "restGrowthBp": 5000,
  "houses": [
    {"code": "COOP",       "nameVi": "Chuồng gà",   "species": "CHICKEN", "minLevel": 4,  "coins": 6000,  "capacity": 3},
    {"code": "DUCK_POND",  "nameVi": "Chuồng vịt",  "species": "DUCK",    "minLevel": 6,  "coins": 10000, "capacity": 3},
    {"code": "PIG_PEN",    "nameVi": "Chuồng lợn",  "species": "PIG",     "minLevel": 8,  "coins": 16000, "capacity": 3},
    {"code": "SHEEP_BARN", "nameVi": "Chuồng cừu",  "species": "SHEEP",   "minLevel": 10, "coins": 28000, "capacity": 3}
  ],
  "livestock": [
    {"species": "CHICKEN", "nameVi": "Gà",  "babyVi": "Gà con",  "coins": 1200, "growHours": 24, "rationFeed": 2, "rationHours": 24,
     "product": "EGG",      "productHours": 8,  "storeCap": 3},
    {"species": "DUCK",    "nameVi": "Vịt", "babyVi": "Vịt con", "coins": 2000, "growHours": 30, "rationFeed": 3, "rationHours": 24,
     "product": "DUCK_EGG", "productHours": 10, "storeCap": 3},
    {"species": "PIG",     "nameVi": "Lợn", "babyVi": "Lợn con", "coins": 4000, "growHours": 48, "rationFeed": 4, "rationHours": 24,
     "product": "MANURE",   "productHours": 8,  "storeCap": 3},
    {"species": "SHEEP",   "nameVi": "Cừu", "babyVi": "Cừu non", "coins": 6000, "growHours": 60, "rationFeed": 4, "rationHours": 24,
     "product": "WOOL",     "productHours": 24, "storeCap": 2}
  ],
  "products": [
    {"code": "EGG",      "nameVi": "Trứng gà",    "sell": 36},
    {"code": "DUCK_EGG", "nameVi": "Trứng vịt",   "sell": 58},
    {"code": "MANURE",   "nameVi": "Phân chuồng", "sell": 28},
    {"code": "WOOL",     "nameVi": "Len cừu",     "sell": 190}
  ],
  "compost": {"product": "MANURE", "manure": 3, "gives": "FERTILIZER", "dailyCap": 2},
  "guardians": [
    {"species": "CAT",   "nameVi": "Mèo đồng",       "minLevel": 5, "coins": 8000,  "rationFeed": 1, "rationHours": 24, "pestCapReduction": 1},
    {"species": "GOOSE", "nameVi": "Ngỗng gác vườn", "minLevel": 6, "coins": 12000, "rationFeed": 2, "rationHours": 24, "graceMinutes": 40},
    {"species": "DOG",   "nameVi": "Chó canh vườn",  "minLevel": 8, "coins": 20000, "rationFeed": 2, "rationHours": 24, "cooldownHours": 24, "shieldHours": 3}
  ]
}'::jsonb)
ON CONFLICT (key) DO NOTHING;
