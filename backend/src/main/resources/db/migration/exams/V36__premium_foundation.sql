-- V36__premium_foundation.sql
-- Premium Foundation: DB-driven plans, active subscriptions, feature catalog with 5 free trials, and atomic usage tracking

-- 1. Premium Plans Table
CREATE TABLE IF NOT EXISTS public.premium_plans (
    id BIGSERIAL PRIMARY KEY,
    code VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(128) NOT NULL,
    duration_months INT NOT NULL,
    price_vnd BIGINT NOT NULL,
    display_order INT NOT NULL DEFAULT 0,
    badge VARCHAR(64) NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_premium_plans_duration CHECK (duration_months > 0),
    CONSTRAINT chk_premium_plans_price CHECK (price_vnd >= 0)
);

-- Seed Exactly 3 Initial Plans (No Lifetime Plan)
INSERT INTO public.premium_plans (code, name, duration_months, price_vnd, display_order, badge, active)
VALUES 
    ('PLAN_1_MONTH', 'Gói 1 Tháng', 1, 59000, 1, NULL, true),
    ('PLAN_3_MONTHS', 'Gói 3 Tháng', 3, 159000, 2, 'PHỔ BIẾN NHẤT', true),
    ('PLAN_12_MONTHS', 'Gói 12 Tháng', 12, 569000, 3, 'TIẾT KIỆM NHẤT', true)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    duration_months = EXCLUDED.duration_months,
    price_vnd = EXCLUDED.price_vnd,
    display_order = EXCLUDED.display_order,
    badge = EXCLUDED.badge,
    active = EXCLUDED.active,
    updated_at = now();

-- 2. Premium Subscriptions Table
CREATE TABLE IF NOT EXISTS public.premium_subscriptions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    plan_id BIGINT NOT NULL REFERENCES public.premium_plans(id) ON DELETE RESTRICT,
    starts_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    source VARCHAR(64) NOT NULL DEFAULT 'SYSTEM',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_premium_subscriptions_status CHECK (status IN ('ACTIVE', 'EXPIRED', 'CANCELLED')),
    CONSTRAINT chk_premium_subscriptions_dates CHECK (expires_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_premium_sub_user_status_expires
    ON public.premium_subscriptions(user_id, status, expires_at DESC);

-- 3. Premium Feature Definitions Table
CREATE TABLE IF NOT EXISTS public.premium_feature_definitions (
    id BIGSERIAL PRIMARY KEY,
    feature_key VARCHAR(64) NOT NULL UNIQUE,
    display_name VARCHAR(128) NOT NULL,
    description VARCHAR(512) NOT NULL,
    premium_required BOOLEAN NOT NULL DEFAULT true,
    free_trial_limit INT NOT NULL DEFAULT 5,
    premium_monthly_limit INT NOT NULL DEFAULT 300,
    enabled BOOLEAN NOT NULL DEFAULT true,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed Audited AI Feature Catalog
INSERT INTO public.premium_feature_definitions 
    (feature_key, display_name, description, premium_required, free_trial_limit, premium_monthly_limit, enabled, sort_order)
VALUES
    ('SPEAKING_ROLEPLAY', 'Luyện hội thoại AI (Role-play)', 'Hội thoại tương tác đa lượt thời gian thực với AI Coach bản xứ', true, 5, 300, true, 1),
    ('SPEAKING_PRONUNCIATION', 'Phân tích phát âm AI (Pronunciation MDD)', 'Nhận diện lỗi sai từng âm vị (phoneme), ngữ điệu và độ lưu loát bằng AI', true, 5, 300, true, 2),
    ('SPEAKING_SHADOWING', 'Luyện nói nhại AI (Shadowing)', 'So sánh và chấm điểm độ khớp âm thanh, ngữ điệu câu nói với người bản xứ', true, 5, 300, true, 3),
    ('SPEAKING_QUICK_CHECK', 'Kiểm tra phát âm nhanh (Quick Check)', 'Đo lường phát âm và nhận diện văn bản tức thì cho một câu ngắn', true, 5, 300, true, 4),
    ('WRITING_AI_FEEDBACK', 'Chữa bài viết AI (Sentence Lab & Essay)', 'Phân tích ngữ pháp, độ tự nhiên và gợi ý nâng cấp câu/đoạn văn chuyên sâu', true, 5, 200, true, 5),
    ('TRANSLATION_AI_GRADING', 'Chấm dịch thuật AI (Translation Grading)', 'Đánh giá bản dịch câu và đoạn văn chi tiết theo ngữ nghĩa và văn cảnh', true, 5, 250, true, 6),
    ('READING_CONTEXT_EXPLANATION', 'Giải nghĩa ngữ cảnh AI (Reading Context)', 'Giải thích chuyên sâu nghĩa của từ/cụm từ trong ngữ cảnh bài đọc thực tế', true, 5, 300, true, 7),
    ('LISTENING_YOUTUBE_IMPORT', 'Trích xuất bài nghe YouTube (AI Transcribe)', 'Tự động bóc tách phụ đề và tạo bài nghe luyện tập từ video YouTube', true, 5, 50, true, 8),
    ('EXAM_AI_SCORING', 'Chấm thi kỹ năng AI (Exam Speaking & Writing)', 'Chấm điểm tự động bài thi nói và viết theo thang điểm chuẩn IELTS / TOEIC', true, 5, 30, true, 9),
    ('SPEAKING_TTS', 'Giọng đọc người bản xứ (OmniVoice TTS)', 'Nghe phát âm chuẩn với các giọng đọc Anh - Mỹ tự nhiên', false, 0, 1000, true, 10),
    ('COACH_CHAT', 'Trợ lý học tập Echo Whale (AI Chat)', 'Giải đáp thắc mắc học tập cơ bản hàng ngày', false, 0, 500, true, 11)
ON CONFLICT (feature_key) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    premium_required = EXCLUDED.premium_required,
    free_trial_limit = EXCLUDED.free_trial_limit,
    premium_monthly_limit = EXCLUDED.premium_monthly_limit,
    enabled = EXCLUDED.enabled,
    sort_order = EXCLUDED.sort_order,
    updated_at = now();

-- 4. Premium AI Usage and Reservation Tracking Table
CREATE TABLE IF NOT EXISTS public.premium_ai_usage (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    feature_key VARCHAR(64) NOT NULL REFERENCES public.premium_feature_definitions(feature_key) ON DELETE RESTRICT,
    usage_kind VARCHAR(32) NOT NULL, -- 'TRIAL' or 'PREMIUM'
    request_id VARCHAR(128) NOT NULL,
    status VARCHAR(32) NOT NULL, -- 'RESERVED', 'COMPLETED', 'RELEASED'
    billing_cycle_month VARCHAR(7) NOT NULL, -- 'YYYY-MM'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ NULL,
    CONSTRAINT chk_premium_usage_kind CHECK (usage_kind IN ('TRIAL', 'PREMIUM')),
    CONSTRAINT chk_premium_usage_status CHECK (status IN ('RESERVED', 'COMPLETED', 'RELEASED')),
    CONSTRAINT uq_premium_usage_user_feature_request UNIQUE (user_id, feature_key, request_id)
);

CREATE INDEX IF NOT EXISTS idx_premium_usage_trial_active
    ON public.premium_ai_usage(user_id, feature_key, usage_kind, status);

CREATE INDEX IF NOT EXISTS idx_premium_usage_monthly_cycle
    ON public.premium_ai_usage(user_id, feature_key, usage_kind, billing_cycle_month, status);
