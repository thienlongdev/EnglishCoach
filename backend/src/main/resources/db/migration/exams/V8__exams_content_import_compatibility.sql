-- ============================================================================
-- V8__exams_content_import_compatibility.sql
-- English Coach Exams Schema Migration V8
-- Content Import Compatibility & Rubric Identity Evolution
-- ============================================================================

-- 1. exams.sources: Remove uniqueness on code to allow independent per-package source records
--    (e.g., EC_INTERNAL_ORIGINAL authored across multiple packages with distinct UUIDs)
ALTER TABLE exams.sources DROP CONSTRAINT IF EXISTS sources_code_key;
CREATE INDEX IF NOT EXISTS idx_sources_code ON exams.sources(code);

-- 2. exams.stimulus_assets: Support authored visual asset roles (CHART_IMAGE, PHOTOGRAPH, etc.)
ALTER TABLE exams.stimulus_assets DROP CONSTRAINT IF EXISTS stimulus_assets_role_check;
ALTER TABLE exams.stimulus_assets ALTER COLUMN role TYPE VARCHAR(64);

-- 3. exams.group_stimuli: Support packages with nullable role and custom role names
ALTER TABLE exams.group_stimuli ALTER COLUMN role TYPE VARCHAR(64);
ALTER TABLE exams.group_stimuli ALTER COLUMN role DROP NOT NULL;

-- 4. exams.rubric_versions: Evolve rubric logical/version uniqueness to include task_family.
--    Preserves strict semantic uniqueness across (logical_code, version, task_family) while
--    allowing Academic (taskFamily: null, criteria: taskAchievement) and General Training
--    (taskFamily: 'IELTS_WRITING', criteria: taskAchievementOrResponse) to legitimately coexist
--    under IELTS_WRITING_RUBRIC version 1 without dropping uniqueness constraints.
ALTER TABLE exams.rubric_versions DROP CONSTRAINT IF EXISTS uq_rubric_logical_version;
ALTER TABLE exams.rubric_versions ADD CONSTRAINT uq_rubric_logical_version_task_family UNIQUE NULLS NOT DISTINCT (logical_code, version, task_family);
