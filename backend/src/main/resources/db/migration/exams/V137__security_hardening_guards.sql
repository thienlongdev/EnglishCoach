-- V137: Security hardening guards (DB-01 financial/usage audit immutability + DB-03 explicit function search_path).
-- Additive, idempotent, safe on both production (english_coach_app / english_coach_runtime) and Testcontainers.

-- 1. DB-01: Block arbitrary DELETE on financial and usage audit tables.
--    Layer 1: Revoke DELETE privilege from english_coach_runtime when the role exists.
--    Layer 2: BEFORE DELETE trigger enforces immutability for the runtime role unconditionally, and
--             requires explicit session opt-in (SET LOCAL app.allow_maintenance_delete = 'on') for
--             owner/maintenance sessions.
CREATE OR REPLACE FUNCTION public.guard_financial_audit_delete()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_user IN ('english_coach_app', 'english_coach_runtime') THEN
        RAISE EXCEPTION 'DELETE is forbidden on financial/usage audit table %.% for runtime role',
            TG_TABLE_SCHEMA, TG_TABLE_NAME
            USING ERRCODE = '42501';
    END IF;

    IF COALESCE(current_setting('app.allow_maintenance_delete', true), '') <> 'on' THEN
        RAISE EXCEPTION 'DELETE on financial/usage audit table %.% requires SET LOCAL app.allow_maintenance_delete = ''on''',
            TG_TABLE_SCHEMA, TG_TABLE_NAME
            USING ERRCODE = '42501';
    END IF;

    RETURN OLD;
END $$;

DO $$
DECLARE
    tbl text;
    has_runtime_role boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'english_coach_runtime');
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'payment_orders',
        'payment_transactions',
        'premium_ai_usage',
        'document_recognition_usage'
    ] LOOP
        IF to_regclass(format('public.%I', tbl)) IS NOT NULL THEN
            IF has_runtime_role THEN
                EXECUTE format('REVOKE DELETE ON TABLE public.%I FROM english_coach_runtime', tbl);
            END IF;
            EXECUTE format('DROP TRIGGER IF EXISTS trg_guard_financial_audit_delete ON public.%I', tbl);
            EXECUTE format(
                'CREATE TRIGGER trg_guard_financial_audit_delete BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_financial_audit_delete()',
                tbl
            );
        END IF;
    END LOOP;
END $$;

-- 2. DB-03: Pin explicit search_path on database functions to eliminate search_path hijacking surface.
DO $$
DECLARE
    fn text;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.messenger_directory_sync(bigint)',
        'public.messenger_directory_user_changed()',
        'public.messenger_directory_profile_changed()',
        'public.ec_fold_name(text)',
        'public.ec_name_prefixes(text)',
        'public.protect_premium_quote()'
    ] LOOP
        IF to_regprocedure(fn) IS NOT NULL THEN
            EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', fn);
        END IF;
    END LOOP;
END $$;
