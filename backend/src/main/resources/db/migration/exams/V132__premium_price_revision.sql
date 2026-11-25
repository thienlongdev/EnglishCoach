-- Preserve the quote on every existing invoice. Old binaries can still insert at the current revision.
ALTER TABLE public.premium_plans ADD COLUMN pricing_version integer NOT NULL DEFAULT 1;
ALTER TABLE public.payment_orders ADD COLUMN pricing_version integer NOT NULL DEFAULT 1;
ALTER TABLE public.payment_orders ALTER COLUMN pricing_version SET DEFAULT 2;

DO $$
DECLARE changed integer;
BEGIN
    UPDATE public.premium_plans AS plan
    SET price_vnd = approved.amount, pricing_version = 2, updated_at = now()
    FROM (VALUES ('PLAN_1_MONTH', 1, 89000), ('PLAN_3_MONTHS', 3, 239000),
                 ('PLAN_12_MONTHS', 12, 749000)) AS approved(code, months, amount)
    WHERE plan.code = approved.code AND plan.duration_months = approved.months AND plan.active;
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 3 THEN RAISE EXCEPTION 'Unexpected Premium catalog'; END IF;
END $$;

CREATE UNIQUE INDEX uq_payment_orders_settled_transaction ON public.payment_orders(provider,provider_transaction_id)
    WHERE provider_transaction_id IS NOT NULL;

CREATE FUNCTION public.protect_premium_quote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.user_id,NEW.plan_id,NEW.plan_code_snapshot,NEW.plan_name_snapshot,NEW.duration_months_snapshot,
           NEW.amount_vnd,NEW.currency,NEW.pricing_version,NEW.transfer_code,NEW.provider,NEW.created_at,NEW.expires_at)
       IS DISTINCT FROM
       ROW(OLD.user_id,OLD.plan_id,OLD.plan_code_snapshot,OLD.plan_name_snapshot,OLD.duration_months_snapshot,
           OLD.amount_vnd,OLD.currency,OLD.pricing_version,OLD.transfer_code,OLD.provider,OLD.created_at,OLD.expires_at)
       OR (OLD.status <> 'PENDING' AND ROW(NEW.status,NEW.provider_transaction_id,NEW.paid_at)
           IS DISTINCT FROM ROW(OLD.status,OLD.provider_transaction_id,OLD.paid_at)) THEN
        RAISE EXCEPTION 'Cannot change a Premium quote or reopen a terminal order';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER protect_premium_quote BEFORE UPDATE ON public.payment_orders
    FOR EACH ROW EXECUTE FUNCTION public.protect_premium_quote();
