-- V94: least-privilege database role for the running application (performance + security release, 2026-10).
--
-- Until now the backend used the server administrator login (azure_pg_admin member, CREATEROLE, CREATEDB, BYPASSRLS,
-- owner of every object) for every request. From this migration on there are two kinds of access:
--   * the migration login (the administrator, configured as SPRING_FLYWAY_USER) owns the schema and runs Flyway;
--   * english_coach_runtime (NOLOGIN group) holds exactly what the application does at run time: read and write rows,
--     use sequences, run functions, refresh the two ranking views through SECURITY DEFINER functions. No CREATE, ALTER,
--     DROP, TRUNCATE, TRIGGER or REFERENCES, no role or database attributes, no write to Flyway's history.
--   * english_coach_app is the LOGIN member of that group the backend connects with (DB_USER). It is created WITHOUT a
--     password: nobody can sign in with it until the operator sets one (a SCRAM verifier, never a clear text), so this
--     migration changes nothing for a running backend, a test database or a developer database.
-- Everything is idempotent and additive; a backend that still connects as the administrator keeps working unchanged.
-- Rollback = point DB_USER back at the administrator login; nothing here needs to be undone.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'english_coach_runtime') THEN
        CREATE ROLE english_coach_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'english_coach_app') THEN
        -- 32 = backend pool (28) + the nightly backup + headroom; the server allows 50 in total, 10 of them reserved
        CREATE ROLE english_coach_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
            CONNECTION LIMIT 32;
    END IF;
END $$;

GRANT english_coach_runtime TO english_coach_app;

DO $$
BEGIN
    EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO english_coach_runtime', current_database());
END $$;

-- Rows, sequences and functions of both application schemas (a schema that does not exist is skipped).
DO $$
DECLARE s text;
BEGIN
    FOREACH s IN ARRAY ARRAY['public', 'exams'] LOOP
        IF to_regnamespace(s) IS NOT NULL THEN
            EXECUTE format('GRANT USAGE ON SCHEMA %I TO english_coach_runtime', s);
            EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO english_coach_runtime', s);
            EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO english_coach_runtime', s);
            EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO english_coach_runtime', s);
            -- objects later migrations create (as the migration login) get the same rights automatically
            EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO english_coach_runtime', s);
            EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO english_coach_runtime', s);
            EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT EXECUTE ON FUNCTIONS TO english_coach_runtime', s);
        END IF;
    END LOOP;
    -- the migration history is read-only for the application
    IF to_regclass('exams.flyway_schema_history') IS NOT NULL THEN
        REVOKE INSERT, UPDATE, DELETE ON exams.flyway_schema_history FROM english_coach_runtime;
    END IF;
END $$;

-- The two ranking views are refreshed by the leaderboard job. REFRESH MATERIALIZED VIEW needs ownership, so the job
-- calls these owner functions instead (fixed body, fixed search path, callable only by the runtime group).
CREATE OR REPLACE FUNCTION public.refresh_mv_activity_rank() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_activity_rank;
END $$;

CREATE OR REPLACE FUNCTION public.refresh_mv_proficiency_rank() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_proficiency_rank;
END $$;

REVOKE ALL ON FUNCTION public.refresh_mv_activity_rank() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_mv_proficiency_rank() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_mv_activity_rank() TO english_coach_runtime;
GRANT EXECUTE ON FUNCTION public.refresh_mv_proficiency_rank() TO english_coach_runtime;

-- Shadowing schema facts that SpeakingShadowingSchemaRepair used to (re)apply with DDL at every start-up. They are
-- schema changes, so they belong here; the start-up check keeps only its data normalisation and its verification.
-- Every statement is a no-op on a database that already has them (production, the development database).
DO $$
BEGIN
    IF to_regclass('public.speaking_shadowing_attempts') IS NOT NULL THEN
        ALTER TABLE public.speaking_shadowing_attempts ALTER COLUMN segment_id DROP NOT NULL;
        ALTER TABLE public.speaking_shadowing_attempts ADD COLUMN IF NOT EXISTS pronunciation_score DOUBLE PRECISION;
        ALTER TABLE public.speaking_shadowing_attempts ADD COLUMN IF NOT EXISTS fluency_score DOUBLE PRECISION;
        ALTER TABLE public.speaking_shadowing_attempts ADD COLUMN IF NOT EXISTS audio_ref VARCHAR(255);
    END IF;
    IF to_regclass('public.speaking_scenarios') IS NOT NULL THEN
        ALTER TABLE public.speaking_scenarios ADD COLUMN IF NOT EXISTS owner_user_id BIGINT;
        ALTER TABLE public.speaking_scenarios ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT TRUE;
    END IF;
    IF to_regclass('public.speaking_shadowing_units') IS NOT NULL THEN
        ALTER TABLE public.speaking_shadowing_units ADD COLUMN IF NOT EXISTS ipa TEXT;
        ALTER TABLE public.speaking_shadowing_units ADD COLUMN IF NOT EXISTS word_ipa_json TEXT;
        ALTER TABLE public.speaking_shadowing_units ADD COLUMN IF NOT EXISTS translation TEXT;
        UPDATE public.speaking_shadowing_units SET generation_version = 1 WHERE generation_version IS NULL;
        ALTER TABLE public.speaking_shadowing_units ALTER COLUMN generation_version SET NOT NULL;
        ALTER TABLE public.speaking_shadowing_units DROP CONSTRAINT IF EXISTS uk_shadowing_unit_material_seq;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uk_shadowing_unit_material_gen_seq') THEN
            -- generation-local positive sequence numbers first, then the identity constraint (as the start-up repair did)
            UPDATE public.speaking_shadowing_units u SET sequence_number = 1000000000 + r.target_sequence
            FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY material_id, generation_version
                         ORDER BY CASE WHEN sequence_number > 0 THEN sequence_number ELSE ABS(sequence_number::bigint) END, id
                     )::integer AS target_sequence
                  FROM public.speaking_shadowing_units) r
            WHERE r.id = u.id;
            UPDATE public.speaking_shadowing_units SET sequence_number = sequence_number - 1000000000
            WHERE sequence_number > 1000000000;
            ALTER TABLE public.speaking_shadowing_units ADD CONSTRAINT uk_shadowing_unit_material_gen_seq
                UNIQUE (material_id, generation_version, sequence_number);
        END IF;
        CREATE INDEX IF NOT EXISTS idx_shadowing_unit_material_gen_seq
            ON public.speaking_shadowing_units(material_id, generation_version, sequence_number);
        CREATE INDEX IF NOT EXISTS idx_shadowing_unit_material_gen_start
            ON public.speaking_shadowing_units(material_id, generation_version, start_time_ms);
    END IF;
END $$;
