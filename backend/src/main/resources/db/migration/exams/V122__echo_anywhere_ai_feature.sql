-- Echo Anywhere (browser extension) paid AI: one ledger key on the shared Premium usage ledger (features/echo-anywhere).
-- Premium only: EchoAnywhereAiService refuses a free account BEFORE any reservation, so this key never draws on the
-- website's free daily AI uses (free_trial_limit 0 records that). Premium: monthly fair use like every other AI feature.
-- Additive; no existing row changes.
INSERT INTO public.premium_feature_definitions
    (feature_key, display_name, description, premium_required, free_trial_limit, premium_monthly_limit, enabled, sort_order)
VALUES ('ECHO_ANYWHERE_AI', 'Echo AI trong Echo Anywhere',
        'Giải thích, dịch theo ngữ cảnh, tóm tắt và quiz trên mọi trang web (tiện ích trình duyệt, chỉ Premium)',
        true, 0, 300, true, 14)
ON CONFLICT (feature_key) DO NOTHING;
