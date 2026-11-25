-- V51__avatar_frame_core.sql
-- Avatar Frame & Prestige Engine Core Foundation (Phase 1)
-- 100% cosmetic visual prestige system for learner identity

-- 1. Avatar Frame Series
CREATE TABLE IF NOT EXISTS public.avatar_frame_series (
    id BIGSERIAL PRIMARY KEY,
    slug VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    lineage VARCHAR(32) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_avatar_frame_series_lineage CHECK (lineage IN ('ACHIEVEMENT', 'RANKED', 'STANDARD', 'LEGACY'))
);

-- 2. Avatar Frames (14 Prototype Seed Catalogue)
CREATE TABLE IF NOT EXISTS public.avatar_frames (
    id BIGSERIAL PRIMARY KEY,
    series_id BIGINT NOT NULL REFERENCES public.avatar_frame_series(id) ON DELETE RESTRICT,
    slug VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    tier VARCHAR(16) NOT NULL,
    render_type VARCHAR(32) NOT NULL,
    poster_asset VARCHAR(255) NOT NULL,
    preview_asset VARCHAR(255) NOT NULL,
    manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    unlock_type VARCHAR(32) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_avatar_frames_tier CHECK (tier IN ('D', 'C', 'B', 'A', 'S', 'SS', 'SSS')),
    CONSTRAINT ck_avatar_frames_render_type CHECK (render_type IN ('STATIC_SVG', 'CSS_ANIMATED')),
    CONSTRAINT ck_avatar_frames_unlock_type CHECK (unlock_type IN ('METRIC_THRESHOLD', 'RANK_REWARD', 'ADMIN_GRANT', 'LEGACY_DATE'))
);

-- 3. Avatar Frame Requirements (Definition model only; Phase 1 stores definitions without evaluator calculation)
CREATE TABLE IF NOT EXISTS public.avatar_frame_requirements (
    id BIGSERIAL PRIMARY KEY,
    frame_id BIGINT NOT NULL REFERENCES public.avatar_frames(id) ON DELETE CASCADE,
    metric_type VARCHAR(64) NOT NULL,
    operator VARCHAR(16) NOT NULL,
    target_value VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_avatar_frame_req_operator CHECK (operator IN ('GTE', 'LTE', 'EQUALS'))
);

-- 4. User Avatar Frames (Ownership & Single Equipped Invariant)
CREATE TABLE IF NOT EXISTS public.user_avatar_frames (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    frame_id BIGINT NOT NULL REFERENCES public.avatar_frames(id) ON DELETE RESTRICT,
    unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,
    source VARCHAR(32) NOT NULL,
    is_equipped BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_user_avatar_frames_user_frame UNIQUE (user_id, frame_id),
    CONSTRAINT ck_user_avatar_frames_source CHECK (source IN ('ACHIEVEMENT', 'RANK', 'EVENT', 'ADMIN_GRANT', 'LEGACY'))
);

-- Partial unique index strictly enforcing: at most one frame equipped per user (Rule 5)
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_avatar_frames_single_equipped
    ON public.user_avatar_frames(user_id)
    WHERE is_equipped = TRUE;

-- Lookup and scoping indexes
CREATE INDEX IF NOT EXISTS idx_avatar_frames_series_id
    ON public.avatar_frames(series_id);

CREATE INDEX IF NOT EXISTS idx_avatar_frame_requirements_frame_id
    ON public.avatar_frame_requirements(frame_id);

CREATE INDEX IF NOT EXISTS idx_user_avatar_frames_user_id
    ON public.user_avatar_frames(user_id);

CREATE INDEX IF NOT EXISTS idx_user_avatar_frames_frame_id
    ON public.user_avatar_frames(frame_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- SEED DATA: 6 Series & Exactly 14 Prototype Catalogue Frames
-- ─────────────────────────────────────────────────────────────────────────────

-- Series A: Streak Flame (ACHIEVEMENT)
INSERT INTO public.avatar_frame_series (id, slug, name, lineage, description)
VALUES (1, 'streak_flame', 'Streak Flame', 'ACHIEVEMENT', 'Chuỗi ngày rực lửa vinh danh nỗ lực liên tục')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, lineage = EXCLUDED.lineage, description = EXCLUDED.description;

-- Series B: Vocabulary (ACHIEVEMENT)
INSERT INTO public.avatar_frame_series (id, slug, name, lineage, description)
VALUES (2, 'vocab_mastery', 'Vocabulary Mastery', 'ACHIEVEMENT', 'Học thức tích lũy từ vốn từ vựng chuyên sâu')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, lineage = EXCLUDED.lineage, description = EXCLUDED.description;

-- Series C: Standard / CEFR (STANDARD)
INSERT INTO public.avatar_frame_series (id, slug, name, lineage, description)
VALUES (3, 'cefr_proficiency', 'Standard CEFR', 'STANDARD', 'Chuẩn mực học thuật quốc tế tinh khôi và trang nhã')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, lineage = EXCLUDED.lineage, description = EXCLUDED.description;

-- Series D: Ranked (RANKED)
INSERT INTO public.avatar_frame_series (id, slug, name, lineage, description)
VALUES (4, 'ranked_arena', 'Ranked Arena', 'RANKED', 'Đấu trường tranh thứ hạng Card Blast PvP nảy lửa')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, lineage = EXCLUDED.lineage, description = EXCLUDED.description;

-- Series E: Legacy (LEGACY)
INSERT INTO public.avatar_frame_series (id, slug, name, lineage, description)
VALUES (5, 'legacy_founder', 'Founder Legacy', 'LEGACY', 'Dấu ấn độc bản của những người đồng hành thuở đầu')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, lineage = EXCLUDED.lineage, description = EXCLUDED.description;

-- Series F: Dragon Emperor (ACHIEVEMENT - SSS Prototype)
INSERT INTO public.avatar_frame_series (id, slug, name, lineage, description)
VALUES (6, 'dragon_emperor', 'Dragon Emperor', 'ACHIEVEMENT', 'Đỉnh cao uy quyền Long Đế Anh Ngữ')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, lineage = EXCLUDED.lineage, description = EXCLUDED.description;

-- Reset sequence for avatar_frame_series
SELECT setval('public.avatar_frame_series_id_seq', (SELECT COALESCE(MAX(id), 1) FROM public.avatar_frame_series));

-- 14 Prototype Frames (Catalogue Metadata Only - Rule 2 & Rule 4: No fabricated progress or ownership)

-- 1. Series A - Stage 1
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (1, 1, 'streak_flame_stage_1', 'Đốm Lửa', 'C', 'STATIC_SVG', '/assets/frames/streak_flame_c.svg', '/assets/frames/streak_flame_c.svg', '{"stage": 1, "color": "#f97316"}'::jsonb, 'METRIC_THRESHOLD', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json;

-- 2. Series A - Stage 2
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (2, 1, 'streak_flame_stage_2', 'Song Diệm', 'B', 'CSS_ANIMATED', '/assets/frames/streak_flame_b.svg', '/assets/frames/streak_flame_b.svg', '{"stage": 2, "color": "#ea580c", "animation": "pulse_flame"}'::jsonb, 'METRIC_THRESHOLD', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json;

-- 3. Series A - Stage 3
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (3, 1, 'streak_flame_stage_3', 'Hỏa Diệm Lam', 'A', 'CSS_ANIMATED', '/assets/frames/streak_flame_a.svg', '/assets/frames/streak_flame_a.svg', '{"stage": 3, "color": "#38bdf8", "animation": "blue_flame_aura"}'::jsonb, 'METRIC_THRESHOLD', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json;

-- 4. Series B - Stage 1
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (4, 2, 'vocab_mastery_stage_1', 'Học Viên Tri Thức', 'C', 'STATIC_SVG', '/assets/frames/vocab_mastery_c.svg', '/assets/frames/vocab_mastery_c.svg', '{"stage": 1, "color": "#10b981"}'::jsonb, 'METRIC_THRESHOLD', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json;

-- 5. Series B - Stage 2
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (5, 2, 'vocab_mastery_stage_2', 'Học Giả Kim Văn', 'B', 'STATIC_SVG', '/assets/frames/vocab_mastery_b.svg', '/assets/frames/vocab_mastery_b.svg', '{"stage": 2, "color": "#0ea5e9"}'::jsonb, 'METRIC_THRESHOLD', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json;

-- 6. Series B - Stage 3
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (6, 2, 'vocab_mastery_stage_3', 'Ma Thư Khải Huyền', 'S', 'STATIC_SVG', '/assets/frames/vocab_mastery_s.svg', '/assets/frames/vocab_mastery_s.svg', '{"stage": 3, "color": "#8b5cf6"}'::jsonb, 'METRIC_THRESHOLD', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json;

-- 7. Series C - B2
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (7, 3, 'cefr_b2_scholar', 'B2 Scholar', 'A', 'STATIC_SVG', '/assets/frames/cefr_b2.svg', '/assets/frames/cefr_b2.svg', '{"color": "#94a3b8", "style": "refined_crystal"}'::jsonb, 'METRIC_THRESHOLD', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json;

-- 8. Series C - C1
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (8, 3, 'cefr_c1_master', 'C1 Master', 'S', 'STATIC_SVG', '/assets/frames/cefr_c1.svg', '/assets/frames/cefr_c1.svg', '{"color": "#cbd5e1", "style": "platinum_clean"}'::jsonb, 'METRIC_THRESHOLD', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json;

-- 9. Series C - C2
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (9, 3, 'cefr_c2_sage', 'C2 Sage', 'SS', 'STATIC_SVG', '/assets/frames/cefr_c2.svg', '/assets/frames/cefr_c2.svg', '{"color": "#fef08a", "style": "celestial_champagne"}'::jsonb, 'METRIC_THRESHOLD', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json;

-- 10. Series D - Gold
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (10, 4, 'ranked_gold', 'Vàng', 'B', 'STATIC_SVG', '/assets/frames/ranked_gold.svg', '/assets/frames/ranked_gold.svg', '{"color": "#eab308", "rank": "GOLD"}'::jsonb, 'RANK_REWARD', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json;

-- 11. Series D - Master
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (11, 4, 'ranked_master', 'Cao Thủ', 'S', 'STATIC_SVG', '/assets/frames/ranked_master.svg', '/assets/frames/ranked_master.svg', '{"color": "#a855f7", "rank": "MASTER"}'::jsonb, 'RANK_REWARD', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json;

-- 12. Series D - Challenger
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (12, 4, 'ranked_challenger', 'Thách Đấu Ngôn Ngữ', 'SS', 'STATIC_SVG', '/assets/frames/ranked_challenger.svg', '/assets/frames/ranked_challenger.svg', '{"color": "#06b6d4", "rank": "CHALLENGER"}'::jsonb, 'RANK_REWARD', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json;

-- 13. Series E - Founder
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (13, 5, 'legacy_founder_2026', 'Founder 2026', 'A', 'STATIC_SVG', '/assets/frames/legacy_founder.svg', '/assets/frames/legacy_founder.svg', '{"color": "#f59e0b", "year": 2026}'::jsonb, 'LEGACY_DATE', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json;

-- 14. Series F - SSS Prototype (Long Đế Anh Ngữ with 175% footprint layout metadata)
INSERT INTO public.avatar_frames (id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, manifest_json, unlock_type, is_active)
VALUES (14, 6, 'sss_dragon_emperor', 'Long Đế Anh Ngữ', 'SSS', 'STATIC_SVG', '/assets/frames/sss_dragon_emperor.svg', '/assets/frames/sss_dragon_emperor.svg', '{"overflowScale": 1.75, "layers": ["AuraLayer", "AvatarLayer", "FrameCoreLayer", "OverflowLayer", "FXLayer"], "color": "#dc2626"}'::jsonb, 'METRIC_THRESHOLD', TRUE)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, render_type = EXCLUDED.render_type, poster_asset = EXCLUDED.poster_asset, preview_asset = EXCLUDED.preview_asset, manifest_json = EXCLUDED.manifest_json;

-- Reset sequence for avatar_frames
SELECT setval('public.avatar_frames_id_seq', (SELECT COALESCE(MAX(id), 1) FROM public.avatar_frames));

-- Seed Frame Requirements (Stored definitions only - Rule 4: No evaluator in Phase 1)
INSERT INTO public.avatar_frame_requirements (frame_id, metric_type, operator, target_value)
VALUES
    (1, 'STREAK_DAYS', 'GTE', '7'),
    (2, 'STREAK_DAYS', 'GTE', '30'),
    (3, 'STREAK_DAYS', 'GTE', '100'),
    (4, 'VOCAB_MASTERED', 'GTE', '100'),
    (5, 'VOCAB_MASTERED', 'GTE', '500'),
    (6, 'VOCAB_MASTERED', 'GTE', '2000'),
    (7, 'CEFR_LEVEL', 'EQUALS', 'B2'),
    (8, 'CEFR_LEVEL', 'EQUALS', 'C1'),
    (9, 'CEFR_LEVEL', 'EQUALS', 'C2'),
    (10, 'PVP_RANK', 'EQUALS', 'GOLD'),
    (11, 'PVP_RANK', 'EQUALS', 'MASTER'),
    (12, 'PVP_RANK', 'EQUALS', 'CHALLENGER'),
    (14, 'STREAK_DAYS', 'GTE', '365')
ON CONFLICT DO NOTHING;
