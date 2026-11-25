-- Free daily allowances (owner policy 2026-10-18): 3 AI uses a day shared by every gated AI feature, 10 Echo Coach
-- messages a day, 1 new My Books import a day; they renew at local midnight (Asia/Ho_Chi_Minh). The limits live in the
-- application configuration (app.premium.free-daily-*); the existing usage ledger public.premium_ai_usage counts them
-- by creation time, so nothing is reset, deleted or rewritten. Additive only: one feature row (the ledger's foreign
-- key target for My Books imports) and one index; no existing row is changed.

-- My Books import allowance. Not an AI feature and never a Premium requirement (premium_required = false): Premium
-- accounts import without a daily cap; free accounts draw on the daily book allowance.
INSERT INTO public.premium_feature_definitions
    (feature_key, display_name, description, premium_required, free_trial_limit, premium_monthly_limit, enabled, sort_order)
VALUES ('MY_BOOKS_IMPORT', 'Nhập sách vào Sách của tôi', 'Thêm sách EPUB, PDF, TXT vào thư viện trên thiết bị', false, 1, 0, true, 13)
ON CONFLICT (feature_key) DO NOTHING;

-- Daily counts read the free (TRIAL) rows of one account created since local midnight.
CREATE INDEX IF NOT EXISTS idx_premium_usage_trial_day
    ON public.premium_ai_usage (user_id, created_at)
    WHERE usage_kind = 'TRIAL';
