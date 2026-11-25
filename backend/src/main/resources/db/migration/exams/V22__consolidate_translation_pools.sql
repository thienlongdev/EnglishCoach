-- V22__consolidate_translation_pools.sql
-- Consolidate translation exercises into canonical topic/difficulty pools
-- Removes arbitrary 5-sentence chunking so visible sequence reflects the true corpus population.

CREATE TEMP TABLE IF NOT EXISTS tmp_old_units AS 
SELECT 
    u.id AS old_unit_id,
    e.topic_code,
    e.difficulty_bucket,
    e.cefr_band,
    e.source_id,
    e.import_batch_id,
    u.source_vi,
    u.reference_en,
    u.source_record_id,
    u.quality_score,
    u.target_chunks_json,
    u.accepted_variants_json,
    u.source_matching_hash,
    u.reference_matching_hash,
    u.ordinal AS old_ordinal
FROM public.translation_exercise_units u
JOIN public.translation_exercises e ON u.exercise_id = e.id
WHERE e.active = TRUE AND u.active = TRUE;

-- Deactivate fragmented 5-sentence exercise sets and their units (preserving historical session FKs)
UPDATE public.translation_exercises SET active = FALSE WHERE active = TRUE;
UPDATE public.translation_exercise_units SET active = FALSE WHERE active = TRUE;

-- Insert 1 canonical exercise pool per topic + difficulty combination
INSERT INTO public.translation_exercises (
    id, source_id, import_batch_id, document_id, mode,
    source_vi, reference_en, source_record_id, topic_code, difficulty_bucket,
    cefr_band, quality_score, target_chunks_json, content_version, active,
    random_bucket, source_matching_hash, reference_matching_hash,
    created_at, updated_at
)
SELECT DISTINCT ON (topic_code, difficulty_bucket)
    md5('canonical_pool:v22:' || topic_code || ':' || difficulty_bucket)::uuid,
    source_id,
    import_batch_id,
    NULL,
    'SENTENCE',
    source_vi,
    reference_en,
    'pool_' || lower(topic_code) || '_' || lower(difficulty_bucket),
    topic_code,
    difficulty_bucket,
    cefr_band,
    90.00,
    '[]'::jsonb,
    22,
    TRUE,
    0,
    source_matching_hash,
    reference_matching_hash,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM tmp_old_units
ORDER BY topic_code, difficulty_bucket, quality_score DESC
ON CONFLICT (id) DO UPDATE SET active = TRUE, topic_code = EXCLUDED.topic_code, difficulty_bucket = EXCLUDED.difficulty_bucket;

-- Insert all units linked to the canonical pool exercise with consecutive ordinals 1..N
INSERT INTO public.translation_exercise_units (
    id, exercise_id, ordinal, source_vi, reference_en,
    source_record_id, quality_score, target_chunks_json, accepted_variants_json,
    content_version, active, source_matching_hash, reference_matching_hash,
    created_at, updated_at
)
SELECT 
    md5('canonical_unit:v22:' || old_unit_id::text)::uuid,
    md5('canonical_pool:v22:' || topic_code || ':' || difficulty_bucket)::uuid,
    ROW_NUMBER() OVER (
        PARTITION BY topic_code, difficulty_bucket 
        ORDER BY quality_score DESC, old_ordinal ASC, old_unit_id ASC
    )::smallint,
    source_vi,
    reference_en,
    source_record_id,
    quality_score,
    target_chunks_json,
    accepted_variants_json,
    22,
    TRUE,
    source_matching_hash,
    reference_matching_hash,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM tmp_old_units
ON CONFLICT (exercise_id, ordinal) DO UPDATE SET 
    active = TRUE, 
    source_vi = EXCLUDED.source_vi, 
    reference_en = EXCLUDED.reference_en, 
    target_chunks_json = EXCLUDED.target_chunks_json;

DROP TABLE IF EXISTS tmp_old_units;
