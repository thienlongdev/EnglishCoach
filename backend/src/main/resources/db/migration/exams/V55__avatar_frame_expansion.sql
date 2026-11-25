-- V55__avatar_frame_expansion.sql
-- Avatar Frame Prestige System Expansion (Phase 5)
-- Four Seasons Collection, Premium Membership Frames, Event Frame & SSS Phoenix Flagship
-- 100% cosmetic visual prestige system for learner identity

-- 1. Expand constraints on public.avatar_frame_series, public.avatar_frames, and public.user_avatar_frames
ALTER TABLE public.avatar_frame_series
    DROP CONSTRAINT IF EXISTS ck_avatar_frame_series_lineage;

ALTER TABLE public.avatar_frame_series
    ADD CONSTRAINT ck_avatar_frame_series_lineage
    CHECK (lineage IN ('ACHIEVEMENT', 'RANKED', 'STANDARD', 'LEGACY', 'SEASONAL', 'EVENT', 'PREMIUM'));

ALTER TABLE public.avatar_frames
    DROP CONSTRAINT IF EXISTS ck_avatar_frames_unlock_type;

ALTER TABLE public.avatar_frames
    ADD CONSTRAINT ck_avatar_frames_unlock_type
    CHECK (unlock_type IN ('METRIC_THRESHOLD', 'RANK_REWARD', 'PREMIUM_SUBSCRIPTION', 'EVENT_PARTICIPATION', 'ADMIN_GRANT', 'LEGACY_DATE'));

ALTER TABLE public.user_avatar_frames
    DROP CONSTRAINT IF EXISTS ck_user_avatar_frames_source;

ALTER TABLE public.user_avatar_frames
    ADD CONSTRAINT ck_user_avatar_frames_source
    CHECK (source IN ('ACHIEVEMENT', 'RANK', 'EVENT', 'SEASONAL', 'PREMIUM', 'ADMIN_GRANT', 'LEGACY'));

-- 2. Seed 4 New Series
-- Series 7: Phoenix Rebirth (ACHIEVEMENT - SSS Flagship)
INSERT INTO public.avatar_frame_series (id, slug, name, lineage, description)
VALUES (7, 'phoenix_rebirth', 'Phượng Hoàng Tái Sinh', 'ACHIEVEMENT', 'Biểu tượng tái sinh bất diệt vinh danh học giả thông tuệ và kiên trì')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, lineage = EXCLUDED.lineage, description = EXCLUDED.description;

-- Series 8: Four Seasons (SEASONAL)
INSERT INTO public.avatar_frame_series (id, slug, name, lineage, description)
VALUES (8, 'four_seasons', 'Bộ Sưu Tập Bốn Mùa', 'SEASONAL', 'Khung avatar tôn vinh vẻ đẹp luân chuyển của đất trời và thời gian học tập')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, lineage = EXCLUDED.lineage, description = EXCLUDED.description;

-- Series 9: Premium Membership (PREMIUM)
INSERT INTO public.avatar_frame_series (id, slug, name, lineage, description)
VALUES (9, 'premium_membership', 'Đặc Quyền Hội Viên', 'PREMIUM', 'Dấu ấn vương giả danh giá dành riêng cho thành viên gói Premium')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, lineage = EXCLUDED.lineage, description = EXCLUDED.description;

-- Series 10: Special Events (EVENT)
INSERT INTO public.avatar_frame_series (id, slug, name, lineage, description)
VALUES (10, 'special_events', 'Sự Kiện Đặc Biệt', 'EVENT', 'Kỷ niệm các ngày lễ lớn và mốc sự kiện quan trọng của English Coach')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, lineage = EXCLUDED.lineage, description = EXCLUDED.description;

-- Update sequence for avatar_frame_series
SELECT setval('public.avatar_frame_series_id_seq', (SELECT COALESCE(MAX(id), 1) FROM public.avatar_frame_series));

-- 3. Seed 9 New Avatar Frames
-- 15. SSS Phoenix Rebirth Flagship
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (15, 7, 'sss_phoenix_rebirth', 'Phượng Hoàng Tái Sinh', 'SSS', 'CSS_ANIMATED', '/assets/frames/sss_phoenix_rebirth.svg', '/assets/frames/sss_phoenix_rebirth.svg',
        '{"visualTheme": "PHOENIX", "overflowScale": 1.75, "layers": ["AuraLayer", "AvatarLayer", "FrameCoreLayer", "OverflowLayer", "FXLayer"], "color": "#f97316"}'::jsonb,
        'METRIC_THRESHOLD', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json, unlock_type = EXCLUDED.unlock_type;

-- 16. Spring: Xuân Sinh Mệnh (Tier S)
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (16, 8, 'season_spring', 'Xuân Sinh Mệnh', 'S', 'CSS_ANIMATED', '/assets/frames/season_spring.svg', '/assets/frames/season_spring.svg',
        '{"visualTheme": "SPRING", "color": "#10b981", "style": "nature_blossom"}'::jsonb,
        'METRIC_THRESHOLD', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json, unlock_type = EXCLUDED.unlock_type;

-- 17. Summer: Hạ Nhật Viêm (Tier S)
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (17, 8, 'season_summer', 'Hạ Nhật Viêm', 'S', 'CSS_ANIMATED', '/assets/frames/season_summer.svg', '/assets/frames/season_summer.svg',
        '{"visualTheme": "SUMMER", "color": "#f59e0b", "style": "solar_radiance"}'::jsonb,
        'METRIC_THRESHOLD', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json, unlock_type = EXCLUDED.unlock_type;

-- 18. Autumn: Thu Phong Diệp (Tier S)
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (18, 8, 'season_autumn', 'Thu Phong Diệp', 'S', 'CSS_ANIMATED', '/assets/frames/season_autumn.svg', '/assets/frames/season_autumn.svg',
        '{"visualTheme": "AUTUMN", "color": "#d97706", "style": "amber_wind"}'::jsonb,
        'METRIC_THRESHOLD', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json, unlock_type = EXCLUDED.unlock_type;

-- 19. Winter: Đông Hàn Nguyệt (Tier S)
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (19, 8, 'season_winter', 'Đông Hàn Nguyệt', 'S', 'CSS_ANIMATED', '/assets/frames/season_winter.svg', '/assets/frames/season_winter.svg',
        '{"visualTheme": "WINTER", "color": "#38bdf8", "style": "frost_crystal"}'::jsonb,
        'METRIC_THRESHOLD', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json, unlock_type = EXCLUDED.unlock_type;

-- 20. Premium 1 Month: Tinh Hoa Hội Viên (Tier B - Plan: PLAN_1_MONTH)
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (20, 9, 'premium_ruby_crest', 'Tinh Hoa Hội Viên', 'B', 'CSS_ANIMATED', '/assets/frames/premium_ruby_crest.svg', '/assets/frames/premium_ruby_crest.svg',
        '{"visualTheme": "IMPERIAL", "color": "#e11d48", "planCode": "PLAN_1_MONTH", "durationMonths": 1}'::jsonb,
        'PREMIUM_SUBSCRIPTION', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json, unlock_type = EXCLUDED.unlock_type;

-- 21. Premium 3 Months: Vương Giả Thượng Hạng (Tier S - Plan: PLAN_3_MONTHS)
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (21, 9, 'premium_sapphire_crown', 'Vương Giả Thượng Hạng', 'S', 'CSS_ANIMATED', '/assets/frames/premium_sapphire_crown.svg', '/assets/frames/premium_sapphire_crown.svg',
        '{"visualTheme": "CELESTIAL", "color": "#2563eb", "planCode": "PLAN_3_MONTHS", "durationMonths": 3}'::jsonb,
        'PREMIUM_SUBSCRIPTION', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json, unlock_type = EXCLUDED.unlock_type;

-- 22. Premium 12 Months: Đế Vương Hoàng Gia (Tier SS Flagship - Plan: PLAN_12_MONTHS)
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (22, 9, 'premium_sovereign_aegis', 'Đế Vương Hoàng Gia', 'SS', 'CSS_ANIMATED', '/assets/frames/premium_sovereign_aegis.svg', '/assets/frames/premium_sovereign_aegis.svg',
        '{"visualTheme": "IMPERIAL", "overflowScale": 1.60, "layers": ["AuraLayer", "AvatarLayer", "FrameCoreLayer", "OverflowLayer", "FXLayer"], "color": "#f59e0b", "planCode": "PLAN_12_MONTHS", "durationMonths": 12}'::jsonb,
        'PREMIUM_SUBSCRIPTION', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json, unlock_type = EXCLUDED.unlock_type;

-- 23. Special Event: Tết Cổ Truyền (Tier A)
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (23, 10, 'event_tet_festival', 'Tết Cổ Truyền', 'A', 'CSS_ANIMATED', '/assets/frames/event_tet_festival.svg', '/assets/frames/event_tet_festival.svg',
        '{"visualTheme": "SPRING", "color": "#dc2626", "eventCode": "TET_FESTIVAL"}'::jsonb,
        'EVENT_PARTICIPATION', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json, unlock_type = EXCLUDED.unlock_type;

-- Update sequence for avatar_frames
SELECT setval('public.avatar_frames_id_seq', (SELECT COALESCE(MAX(id), 1) FROM public.avatar_frames));

-- 4. Seed Requirements for New Frames
INSERT INTO public.avatar_frame_requirements (frame_id, metric_type, operator, target_value)
VALUES
    (15, 'READING_COMPLETED', 'GTE', '50'),
    (16, 'VOCAB_MASTERED', 'GTE', '300'),
    (17, 'LISTENING_COMPLETED', 'GTE', '30'),
    (18, 'READING_COMPLETED', 'GTE', '30'),
    (19, 'DICTATION_COMPLETED', 'GTE', '30'),
    (20, 'PREMIUM_PLAN', 'GTE', '1'),
    (21, 'PREMIUM_PLAN', 'GTE', '3'),
    (22, 'PREMIUM_PLAN', 'GTE', '12'),
    (23, 'EVENT_ATTENDANCE', 'EQUALS', 'TET_2026')
ON CONFLICT DO NOTHING;
