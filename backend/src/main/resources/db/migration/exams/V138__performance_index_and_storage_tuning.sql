-- V138: Performance index engineering, duplicate index cleanup, and HOT/autovacuum storage tuning.
-- Additive & rollback-safe for prior backend image (V136/V137). Zero PostgreSQL extension dependencies
-- (compatible with empty azure.extensions on Azure Database for PostgreSQL 17.11).
-- Preserves V94 least-privilege runtime role (english_coach_app / english_coach_runtime) and V137 guards.

SET LOCAL lock_timeout = '5s';

-- ============================================================================
-- 1. Backfill & enforce flashcards.state NOT NULL DEFAULT 0 so partial
--    WHERE state = 0 indexes cover 100% of active learner cards.
-- ============================================================================
UPDATE public.flashcards
SET state = 0
WHERE state IS NULL;

ALTER TABLE public.flashcards
    ALTER COLUMN state SET DEFAULT 0,
    ALTER COLUMN state SET NOT NULL;

-- ============================================================================
-- 2. Missing FK B-tree indexes on @ElementCollection / child tables
--    (eliminates >14.5B sequential-scan rows on dictionary & listening tables).
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_dict_meanings_entry_id
    ON public.dictionary_meanings (dictionary_entry_id);

CREATE INDEX IF NOT EXISTS idx_dict_examples_entry_id
    ON public.dictionary_examples (dictionary_entry_id);

CREATE INDEX IF NOT EXISTS idx_dict_collocations_entry_id
    ON public.dictionary_collocations (dictionary_entry_id);

CREATE INDEX IF NOT EXISTS idx_dict_synonyms_entry_id
    ON public.dictionary_synonyms (dictionary_entry_id);

CREATE INDEX IF NOT EXISTS idx_learning_weaknesses_plan_id
    ON public.learning_weaknesses (plan_id);

CREATE INDEX IF NOT EXISTS idx_listening_error_dna_profile_cat
    ON public.listening_error_dna (profile_id, error_category);

CREATE INDEX IF NOT EXISTS idx_speaking_scenario_grammars_sid
    ON public.speaking_scenario_grammars (scenario_id);

CREATE INDEX IF NOT EXISTS idx_speaking_scenario_hints_sid
    ON public.speaking_scenario_hints (scenario_id);

CREATE INDEX IF NOT EXISTS idx_speaking_scenario_criteria_sid
    ON public.speaking_scenario_success_criteria (scenario_id);

CREATE INDEX IF NOT EXISTS idx_speaking_scenario_vocab_sid
    ON public.speaking_scenario_vocabularies (scenario_id);

CREATE INDEX IF NOT EXISTS idx_speaking_turn_detected_vocab_tid
    ON public.speaking_turn_detected_vocab (turn_id);

-- ============================================================================
-- 3. Dictionary & Deck reverse-lookup / case-insensitive / prefix indexes
--    (eliminates 153.9M seq rows + 59.0M wasted idx_tup_read + 50.6M deck scans).
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_deck_dict_entry_deck
    ON public.deck_dictionary_entries (dictionary_entry_id, deck_id);

CREATE INDEX IF NOT EXISTS idx_dict_entries_shared_word_lower
    ON public.dictionary_entries (lower(word))
    WHERE owner_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_dict_entries_shared_word_prefix
    ON public.dictionary_entries (lower(word) text_pattern_ops)
    WHERE owner_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_dict_entries_owner_word_lower
    ON public.dictionary_entries (owner_user_id, lower(word))
    WHERE owner_user_id IS NOT NULL;

-- ============================================================================
-- 4. Listening & Exercise Attempts missing FK indexes
--    (eliminates >390M seq-scan rows on listening_exercises / transcript_segments / exercise_attempts).
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_listening_exercises_material_type
    ON public.listening_exercises (listening_material_id, exercise_type);

CREATE INDEX IF NOT EXISTS idx_listening_exercises_segment
    ON public.listening_exercises (transcript_segment_id);

CREATE INDEX IF NOT EXISTS idx_transcript_segments_material_start
    ON public.transcript_segments (listening_material_id, start_time_ms);

CREATE INDEX IF NOT EXISTS idx_exercise_attempts_session_ex
    ON public.exercise_attempts (listening_session_id, listening_exercise_id);

CREATE INDEX IF NOT EXISTS idx_exercise_attempts_exercise
    ON public.exercise_attempts (listening_exercise_id);

CREATE INDEX IF NOT EXISTS idx_listening_materials_yt_sys
    ON public.listening_materials (youtube_video_id)
    WHERE is_system = true AND owner_user_id IS NULL AND youtube_video_id IS NOT NULL;

-- ============================================================================
-- 5. Translation Paragraph Corpus partial covering indexes
--    (converts 312 MB heap scans into narrow index-only/index scans; exact ELIGIBILITY_WHERE match).
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_trans_para_passages_eligible_cover
    ON public.translation_paragraph_passages (genre, topic, document_id, passage_ordinal, id)
    WHERE alignment_decision IN ('ACCEPT', 'ACCEPTED')
      AND coherence_decision IN ('ACCEPT', 'ACCEPTED')
      AND quality_decision IN ('ACCEPT', 'ACCEPTED')
      AND rights_eligible = true
      AND rights_decision IN ('ELIGIBLE', 'ACCEPT', 'ACCEPTED')
      AND canonical_content = true
      AND publication_state IN ('APPROVED', 'STAGED', 'ELIGIBLE')
      AND content_version > 0;

CREATE INDEX IF NOT EXISTS idx_trans_para_docs_eligible_cover
    ON public.translation_paragraph_documents (id, source_id)
    INCLUDE (source_title)
    WHERE provenance_complete = true
      AND original_order_proven = true
      AND publication_state NOT IN ('WITHDRAWN', 'BLOCKED');

-- ============================================================================
-- 6. Exams reverse-FK, QA import, and attempt history indexes
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_content_qa_runs_pkg_import
    ON exams.content_qa_runs (package_import_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_form_groups_group_id
    ON exams.form_groups (group_id);

CREATE INDEX IF NOT EXISTS idx_group_stimuli_stimulus_id
    ON exams.group_stimuli (stimulus_id);

CREATE INDEX IF NOT EXISTS idx_stimulus_assets_asset_id
    ON exams.stimulus_assets (asset_id);

CREATE INDEX IF NOT EXISTS idx_attempts_user_created
    ON exams.attempts (user_id, created_at DESC);

-- ============================================================================
-- 7. Flashcards active partial indexes (WHERE state = 0) & operational poll indexes
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_flashcards_user_active_id
    ON public.flashcards (user_id, id DESC)
    WHERE state = 0;

CREATE INDEX IF NOT EXISTS idx_flashcards_user_deck_active_id
    ON public.flashcards (user_id, deck_id, id DESC)
    WHERE state = 0;

CREATE INDEX IF NOT EXISTS idx_flashcards_user_deck_active_status_id
    ON public.flashcards (user_id, deck_id, status, id DESC)
    WHERE state = 0;

CREATE INDEX IF NOT EXISTS idx_flashcards_user_active_due
    ON public.flashcards (user_id, next_review_date, id DESC)
    WHERE state = 0;

CREATE INDEX IF NOT EXISTS idx_flashcards_user_deck_active_due
    ON public.flashcards (user_id, deck_id, next_review_date, id DESC)
    WHERE state = 0;

CREATE INDEX IF NOT EXISTS idx_payment_tx_received
    ON public.payment_transactions (received_at ASC)
    WHERE processing_status = 'RECEIVED';

CREATE INDEX IF NOT EXISTS idx_premium_usage_reserved_stale
    ON public.premium_ai_usage (feature_key, created_at ASC)
    WHERE status = 'RESERVED';

CREATE INDEX IF NOT EXISTS idx_study_shared_voice_rooms_expires
    ON public.study_shared_voice_rooms (expires_at);

-- ============================================================================
-- 8. Drop verified exact duplicate, safe prefix-overlap, HOT-blocking, and dead indexes
--    EXPLICITLY RETAINED:
--      - public.idx_learning_path_task_day (mixed sort plan_day DESC, position ASC)
--      - 6 PG17 B-tree deduplicated exam FK indexes (idx_items_group, idx_form_groups_part,
--        idx_parts_section, idx_sections_form, idx_group_stimuli_group, idx_stimulus_assets_stimulus)
-- ============================================================================
-- Exact duplicates (16 indexes, ~14.05 MiB reclaimed)
DROP INDEX IF EXISTS public.idx_trans_para_sections_doc;
DROP INDEX IF EXISTS exams.idx_answer_specs_item;
DROP INDEX IF EXISTS public.idx_deck_dict_deck_entry;
DROP INDEX IF EXISTS public.idx_deck_dict_deck_sort_order;
DROP INDEX IF EXISTS public.idx_dictionary_word_lower;
DROP INDEX IF EXISTS public.idx_shadowing_unit_material_gen_seq;
DROP INDEX IF EXISTS exams.idx_attempts_user;
DROP INDEX IF EXISTS public.idx_bilingual_reading_segments_material;
DROP INDEX IF EXISTS exams.idx_quick_check_client_id;
DROP INDEX IF EXISTS exams.idx_submissions_attempt;
DROP INDEX IF EXISTS public.idx_community_moderation_records_post_created;
DROP INDEX IF EXISTS public.idx_rce_lookup;
DROP INDEX IF EXISTS public.idx_speaking_turn_feedbacks_turn_id;
DROP INDEX IF EXISTS public.idx_speaking_turns_session_seq;
DROP INDEX IF EXISTS public.idx_trans_para_attempts_item;
DROP INDEX IF EXISTS public.idx_trans_para_items_session;

-- Safe prefix overlaps (20 indexes, ~5.1 MiB reclaimed)
DROP INDEX IF EXISTS exams.idx_items_logical_key;
DROP INDEX IF EXISTS exams.idx_groups_key;
DROP INDEX IF EXISTS exams.idx_exposures_user_content;
DROP INDEX IF EXISTS public.idx_flashcards_user_deck;
DROP INDEX IF EXISTS exams.idx_licenses_source;
DROP INDEX IF EXISTS public.idx_speaking_sessions_user;
DROP INDEX IF EXISTS public.idx_comm_comment_media_comment_id;
DROP INDEX IF EXISTS public.idx_community_comment_reactions_comment;
DROP INDEX IF EXISTS public.idx_community_post_reactions_post;
DROP INDEX IF EXISTS public.idx_community_follows_follower;
DROP INDEX IF EXISTS public.idx_auth_identities_user_id;
DROP INDEX IF EXISTS public.idx_rcvh_user_material;
DROP INDEX IF EXISTS public.idx_user_avatar_frames_user_id;
DROP INDEX IF EXISTS public.idx_writing_sessions_user;
DROP INDEX IF EXISTS public.ix_garden_decor_user;
DROP INDEX IF EXISTS public.ix_garden_pest_user_active;
DROP INDEX IF EXISTS public.ix_garden_animal_user;
DROP INDEX IF EXISTS exams.idx_criterion_scores_artifact;
DROP INDEX IF EXISTS exams.idx_jobs_submission;
DROP INDEX IF EXISTS exams.idx_recording_chunks_rec;
DROP INDEX IF EXISTS exams.idx_score_artifacts_submission;

-- HOT-blocking expiry indexes on auth_sessions (unindexed last_seen_at/device_label -> >95% HOT updates)
DROP INDEX IF EXISTS public.idx_auth_sessions_idle_expiry;
DROP INDEX IF EXISTS public.idx_auth_sessions_abs_expiry;

-- Dead legacy index (0 scans; superseded by scope/target_user_id indexes)
DROP INDEX IF EXISTS public.idx_notifications_user_is_read_created;

-- ============================================================================
-- 9. Table fillfactor & autovacuum tuning for high-churn tables (HOT optimization)
-- ============================================================================
ALTER TABLE public.auth_sessions
    SET (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);

ALTER TABLE public.speaking_shadowing_units
    SET (fillfactor = 85, autovacuum_vacuum_scale_factor = 0.05);

ALTER TABLE public.flashcards
    SET (fillfactor = 85, autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);

ALTER TABLE exams.jobs
    SET (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);

ALTER TABLE exams.attempts
    SET (fillfactor = 85, autovacuum_vacuum_scale_factor = 0.05);

ALTER TABLE public.user_profiles
    SET (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.05);

ALTER TABLE public.quiz_rush_sessions
    SET (fillfactor = 75, autovacuum_vacuum_scale_factor = 0.05);

ALTER TABLE public.notifications
    SET (fillfactor = 85, autovacuum_vacuum_scale_factor = 0.05);
