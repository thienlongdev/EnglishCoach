-- V68: single official administrator + manual Premium entitlement audit (owner policy 2026-10-02).
-- Exactly ONE account may hold ROLE_ADMIN: longntt872006@gmail.com (trim + case-insensitive).
-- Java mirror: com.englishcoach.auth.policy.OfficialAdminPolicy.OFFICIAL_ADMIN_EMAIL (OfficialAdminPolicyTest compares both).
-- Only authorization state changes here: no account, learning data, Premium, payment, post or frame row is deleted.

-- 1. Append-only role-change log (also the backup of every previous role).
CREATE TABLE IF NOT EXISTS public.admin_role_changes (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT       NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    old_role    VARCHAR(32)  NOT NULL,
    new_role    VARCHAR(32)  NOT NULL,
    reason      VARCHAR(255) NOT NULL,
    changed_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_role_changes_user ON public.admin_role_changes(user_id, changed_at DESC);

CREATE OR REPLACE FUNCTION public.fn_append_only_reject() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;

DROP TRIGGER IF EXISTS trg_admin_role_changes_append_only ON public.admin_role_changes;
CREATE TRIGGER trg_admin_role_changes_append_only BEFORE UPDATE OR DELETE ON public.admin_role_changes
    FOR EACH ROW EXECUTE FUNCTION public.fn_append_only_reject();

-- 2. Record, then demote every ROLE_ADMIN that is not the official administrator.
INSERT INTO public.admin_role_changes (user_id, old_role, new_role, reason)
SELECT id, role, 'ROLE_USER', 'V68_SINGLE_OFFICIAL_ADMIN'
FROM public.users
WHERE role = 'ROLE_ADMIN' AND lower(btrim(email)) <> 'longntt872006@gmail.com';

-- Their open sessions are revoked so no browser keeps an admin-era session cookie (forced re-login). Server-side
-- authorization already reads users.role on every request; this also resets the client-side role.
UPDATE public.auth_sessions
SET state = 'REVOKED', revoked_at = now(), revoked_reason = 'ROLE_CHANGED'
WHERE revoked_at IS NULL
  AND state <> 'REVOKED'
  AND user_id IN (SELECT user_id FROM public.admin_role_changes WHERE reason = 'V68_SINGLE_OFFICIAL_ADMIN');

UPDATE public.users
SET role = 'ROLE_USER'
WHERE role = 'ROLE_ADMIN' AND lower(btrim(email)) <> 'longntt872006@gmail.com';

-- The official account holds ROLE_ADMIN (no-op when it already does).
INSERT INTO public.admin_role_changes (user_id, old_role, new_role, reason)
SELECT id, role, 'ROLE_ADMIN', 'V68_OFFICIAL_ADMIN'
FROM public.users
WHERE lower(btrim(email)) = 'longntt872006@gmail.com' AND role <> 'ROLE_ADMIN';

UPDATE public.users
SET role = 'ROLE_ADMIN'
WHERE lower(btrim(email)) = 'longntt872006@gmail.com' AND role <> 'ROLE_ADMIN';

-- 3. Database-level guard: ROLE_ADMIN can never be stored for another e-mail (raw SQL included), and the official
--    account cannot be renamed while it is the administrator.
CREATE OR REPLACE FUNCTION public.fn_users_single_official_admin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.role = 'ROLE_ADMIN' AND lower(btrim(NEW.email)) IS DISTINCT FROM 'longntt872006@gmail.com' THEN
        RAISE EXCEPTION 'ROLE_ADMIN is reserved for the official administrator account' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_users_single_official_admin ON public.users;
CREATE TRIGGER trg_users_single_official_admin BEFORE INSERT OR UPDATE OF role, email ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.fn_users_single_official_admin();

-- 4. Manual Premium (admin entitlement, never a payment): an inactive plan that is never sold or listed
--    (plan listing and purchase only use active plans) and an append-only audit of every grant / revoke.
INSERT INTO public.premium_plans (code, name, duration_months, price_vnd, display_order, badge, active)
VALUES ('ADMIN_GRANT', 'Premium do quản trị viên cấp', 1, 0, 99, NULL, false)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.premium_admin_entitlement_events (
    id                   BIGSERIAL PRIMARY KEY,
    target_user_id       BIGINT       NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    admin_user_id        BIGINT       NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    action               VARCHAR(16)  NOT NULL,
    reason               VARCHAR(500) NOT NULL,
    subscription_ids     BIGINT[]     NOT NULL DEFAULT '{}',
    permanent            BOOLEAN      NOT NULL DEFAULT FALSE,
    previous_premium     BOOLEAN      NOT NULL,
    previous_expires_at  TIMESTAMPTZ,
    previous_source      VARCHAR(64),
    new_premium          BOOLEAN      NOT NULL,
    new_expires_at       TIMESTAMPTZ,
    new_source           VARCHAR(64),
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT ck_premium_admin_events_action CHECK (action IN ('GRANT', 'REVOKE')),
    CONSTRAINT ck_premium_admin_events_reason CHECK (length(btrim(reason)) > 0)
);
CREATE INDEX IF NOT EXISTS idx_premium_admin_events_target
    ON public.premium_admin_entitlement_events(target_user_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_premium_admin_events_append_only ON public.premium_admin_entitlement_events;
CREATE TRIGGER trg_premium_admin_events_append_only BEFORE UPDATE OR DELETE ON public.premium_admin_entitlement_events
    FOR EACH ROW EXECUTE FUNCTION public.fn_append_only_reject();
