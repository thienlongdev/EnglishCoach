-- V90: Echo Garden Phase 4 — the official administrator's QA access is recorded as what it is.
-- docs/echo-garden/PHASE4_PRODUCTION_PERFORMANCE_SECURITY_AND_QA_REPORT.md
--
-- Additive only. V1–V89 are applied and are not edited. No new table, no data change, no rule change.
--
-- Why a migration at all: an equipped appearance, a decoration that stands and the skin of a planting must reference an
-- OWNERSHIP row (foreign keys of V82 / V86). The administrator therefore tests a cosmetic through a real ownership row —
-- and that row has to say that it is a QA grant, not a purchase, not a payment and not an achievement. The same holds
-- for an animal house and an animal provisioned for QA. Ordinary players never receive the new value: only
-- GardenAdminQaService writes it, and only for the account AdminIdentityService confirms as the official administrator.
--
--   * garden_cosmetic_acquisition.source and garden_skin_owned.source accept 'ADMIN_QA' (coins_paid 0, no order);
--   * garden_animal_house.source and garden_animal.source: 'PLAYER' (every existing and every ordinary row) or 'ADMIN_QA'.

-- =====================================================================================================================
-- A. Cosmetic units: the list of sources was an unnamed column check in V86 — find it by its definition
-- =====================================================================================================================
DO $$
DECLARE c RECORD;
BEGIN
    FOR c IN SELECT con.conname FROM pg_constraint con
             JOIN pg_class rel ON rel.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = rel.relnamespace
             WHERE ns.nspname = 'public' AND rel.relname = 'garden_cosmetic_acquisition' AND con.contype = 'c'
               AND pg_get_constraintdef(con.oid) LIKE '%source%GRADUATIONS%'
               AND pg_get_constraintdef(con.oid) NOT LIKE '%coins_paid%'
               AND pg_get_constraintdef(con.oid) NOT LIKE '%order_id%'
               AND pg_get_constraintdef(con.oid) NOT LIKE '%ADMIN_QA%'
    LOOP
        EXECUTE format('ALTER TABLE public.garden_cosmetic_acquisition DROP CONSTRAINT %I', c.conname);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_garden_cosmetic_acq_source_list') THEN
        ALTER TABLE public.garden_cosmetic_acquisition ADD CONSTRAINT ck_garden_cosmetic_acq_source_list
            CHECK (source IN ('COIN','LEARNING','HARVESTS','GRADUATIONS','MONEY','ADMIN_QA'));
    END IF;
END $$;

-- =====================================================================================================================
-- B. Crop cultivars (the constraint was named by V83 and last extended by V87)
-- =====================================================================================================================
ALTER TABLE public.garden_skin_owned DROP CONSTRAINT IF EXISTS ck_garden_skin_owned_source;
ALTER TABLE public.garden_skin_owned ADD CONSTRAINT ck_garden_skin_owned_source
    CHECK (source IN ('MASTERY','COIN','LEARNING','REWARD','MONEY','ADMIN_QA'));
-- a QA grant is never a payment
ALTER TABLE public.garden_skin_owned DROP CONSTRAINT IF EXISTS ck_garden_skin_owned_qa_free;
ALTER TABLE public.garden_skin_owned ADD CONSTRAINT ck_garden_skin_owned_qa_free
    CHECK (source <> 'ADMIN_QA' OR coins_paid = 0);

-- =====================================================================================================================
-- C. Animal houses and animals: where the row came from
-- =====================================================================================================================
ALTER TABLE public.garden_animal_house ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'PLAYER';
ALTER TABLE public.garden_animal ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'PLAYER';
ALTER TABLE public.garden_animal_house DROP CONSTRAINT IF EXISTS ck_garden_animal_house_source;
ALTER TABLE public.garden_animal_house ADD CONSTRAINT ck_garden_animal_house_source CHECK (source IN ('PLAYER','ADMIN_QA'));
ALTER TABLE public.garden_animal DROP CONSTRAINT IF EXISTS ck_garden_animal_source;
ALTER TABLE public.garden_animal ADD CONSTRAINT ck_garden_animal_source CHECK (source IN ('PLAYER','ADMIN_QA'));
