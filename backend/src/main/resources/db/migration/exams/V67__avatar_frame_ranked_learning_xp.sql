-- V67__avatar_frame_ranked_learning_xp.sql
-- Avatar frames, RANKED lineage ("Đấu trường"): the PVP_RANK requirements (GOLD / MASTER / CHALLENGER) had no
-- authoritative rank thresholds (PvpRankEvaluator never grants them and shows "(Chưa mở)"), so the three frames were
-- unreachable. They now unlock on cumulative learning XP (LEARNING_XP = all-time Activity points from the capped,
-- append-only score_events ledger via leaderboard_activity_daily; LearningXpEvaluator). Tier ladder kept:
--   ranked_gold        (B)  Vàng                 ⇒ 1 000 XP   (a few weeks of regular study)
--   ranked_master      (S)  Cao Thủ              ⇒ 10 000 XP  (months of consistent study)
--   ranked_challenger  (SS) Thách Đấu Ngôn Ngữ   ⇒ 30 000 XP  (about a year of daily study)
-- Cosmetic only: no PvP / ELO formula, XP rule, ranking or gameplay change. Idempotent (keyed by slug + metric).

UPDATE public.avatar_frame_requirements r
SET metric_type = 'LEARNING_XP', operator = 'GTE', target_value = t.target
FROM public.avatar_frames f
JOIN (VALUES ('ranked_gold', '1000'), ('ranked_master', '10000'), ('ranked_challenger', '30000')) AS t(slug, target)
  ON t.slug = f.slug
WHERE r.frame_id = f.id AND r.metric_type = 'PVP_RANK';

-- frames that somehow have no requirement row get one (never a second row)
INSERT INTO public.avatar_frame_requirements (frame_id, metric_type, operator, target_value)
SELECT f.id, 'LEARNING_XP', 'GTE', t.target
FROM public.avatar_frames f
JOIN (VALUES ('ranked_gold', '1000'), ('ranked_master', '10000'), ('ranked_challenger', '30000')) AS t(slug, target)
  ON t.slug = f.slug
WHERE NOT EXISTS (SELECT 1 FROM public.avatar_frame_requirements r WHERE r.frame_id = f.id);

-- unlocked by a metric threshold now (not a season rank reward); the old "rank" presentation key is dropped
UPDATE public.avatar_frames
SET unlock_type = 'METRIC_THRESHOLD', manifest_json = manifest_json - 'rank'
WHERE slug IN ('ranked_gold', 'ranked_master', 'ranked_challenger');

UPDATE public.avatar_frame_series
SET description = 'Đấu trường thi đua: tích lũy XP học tập để thăng hạng khung Vàng → Cao Thủ → Thách Đấu Ngôn Ngữ'
WHERE slug = 'ranked_arena';
