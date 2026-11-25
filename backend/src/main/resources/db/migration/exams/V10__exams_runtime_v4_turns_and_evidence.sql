-- ============================================================================
-- V10__exams_runtime_v4_turns_and_evidence.sql
-- English Coach Exams — Runtime V4 Snapshot, Speaking Turns & Evidence
-- Forward-only migration extending existing V1-V9 schema.
-- Historical migrations V1-V9 remain strictly immutable.
-- ============================================================================

-- 1. exams.attempts: Server-authoritative content snapshot & snapshot classification
ALTER TABLE exams.attempts
  ADD COLUMN IF NOT EXISTS manifest_snapshot JSONB NULL,
  ADD COLUMN IF NOT EXISTS manifest_snapshot_version VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS snapshot_state VARCHAR(32) NOT NULL DEFAULT 'LEGACY_UNSNAPSHOTTED';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_attempts_v4_snapshot_state'
  ) THEN
    ALTER TABLE exams.attempts
      ADD CONSTRAINT ck_attempts_v4_snapshot_state
      CHECK (
        (snapshot_state = 'LEGACY_UNSNAPSHOTTED' AND manifest_snapshot IS NULL)
        OR (snapshot_state = 'SNAPSHOTTED' AND manifest_snapshot IS NOT NULL AND manifest_snapshot_version IS NOT NULL)
        OR snapshot_state = 'INVALID'
      );
  END IF;
END $$;

-- 2. exams.parts & exams.group_versions: Canonical form kind / renderer registry key
ALTER TABLE exams.parts
  ADD COLUMN IF NOT EXISTS form_kind VARCHAR(64) NULL;

ALTER TABLE exams.group_versions
  ADD COLUMN IF NOT EXISTS form_kind VARCHAR(64) NULL;

-- 3. exams.attempt_sections: Server Speaking turn cursor & revision tracking
ALTER TABLE exams.attempt_sections
  ADD COLUMN IF NOT EXISTS current_turn_placement_id VARCHAR(128) NULL,
  ADD COLUMN IF NOT EXISTS current_turn_key VARCHAR(128) NULL,
  ADD COLUMN IF NOT EXISTS turn_cursor INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS turn_revision BIGINT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_attempt_sections_v4_cursor'
  ) THEN
    ALTER TABLE exams.attempt_sections
      ADD CONSTRAINT ck_attempt_sections_v4_cursor
      CHECK (turn_cursor >= 0 AND turn_revision >= 0);
  END IF;
END $$;

-- 4. exams.responses: Child turn binding, turn state machine & frozen source snapshot
ALTER TABLE exams.responses
  ADD COLUMN IF NOT EXISTS turn_key VARCHAR(128) NULL,
  ADD COLUMN IF NOT EXISTS turn_sequence INTEGER NULL,
  ADD COLUMN IF NOT EXISTS response_kind VARCHAR(32) NOT NULL DEFAULT 'ITEM',
  ADD COLUMN IF NOT EXISTS turn_state VARCHAR(32) NOT NULL DEFAULT 'LOCKED',
  ADD COLUMN IF NOT EXISTS source_snapshot JSONB NULL,
  ADD COLUMN IF NOT EXISTS exposure_hash VARCHAR(128) NULL;

-- Replace monolithic placement constraint with turn-aware partial indexes
ALTER TABLE exams.responses
  DROP CONSTRAINT IF EXISTS uq_response_attempt_placement;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_responses_v4_turn_shape'
  ) THEN
    ALTER TABLE exams.responses
      ADD CONSTRAINT ck_responses_v4_turn_shape
      CHECK (
        (turn_key IS NULL AND turn_sequence IS NULL AND response_kind = 'ITEM')
        OR (turn_key IS NOT NULL AND length(trim(turn_key)) > 0 AND turn_sequence IS NOT NULL AND turn_sequence > 0 AND response_kind = 'SPEAKING_TURN' AND item_id IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_responses_v4_turn_state'
  ) THEN
    ALTER TABLE exams.responses
      ADD CONSTRAINT ck_responses_v4_turn_state
      CHECK (turn_state IN ('LOCKED', 'CURRENT', 'PREPARING', 'READY_TO_RECORD', 'RECORDING', 'UPLOADING', 'RECORDED', 'COMPLETED', 'FAILED_UPLOAD'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_responses_attempt_placement_legacy
  ON exams.responses (attempt_id, placement_id)
  WHERE turn_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_responses_attempt_placement_turn_v4
  ON exams.responses (attempt_id, placement_id, turn_key)
  WHERE turn_key IS NOT NULL;

-- 5. exams.recordings: Audio metadata, generation lineage, sealed manifest & evidence status
ALTER TABLE exams.recordings
  ADD COLUMN IF NOT EXISTS duration_ms BIGINT NULL,
  ADD COLUMN IF NOT EXISTS sealed_manifest JSONB NULL,
  ADD COLUMN IF NOT EXISTS transcript_status VARCHAR(32) NOT NULL DEFAULT 'NOT_REQUESTED',
  ADD COLUMN IF NOT EXISTS transcript_text TEXT NULL,
  ADD COLUMN IF NOT EXISTS evidence_status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS evidence_meta JSONB NULL,
  ADD COLUMN IF NOT EXISTS seal_command_id UUID NULL,
  ADD COLUMN IF NOT EXISTS last_error_code VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS generation INTEGER NULL,
  ADD COLUMN IF NOT EXISTS supersedes_recording_id UUID NULL REFERENCES exams.recordings(id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_recordings_v4_generation_link'
  ) THEN
    ALTER TABLE exams.recordings
      ADD CONSTRAINT ck_recordings_v4_generation_link
      CHECK (
        (generation IS NULL AND supersedes_recording_id IS NULL)
        OR (generation IS NOT NULL AND response_id IS NOT NULL AND generation >= 0 AND ((generation = 0 AND supersedes_recording_id IS NULL) OR (generation > 0 AND supersedes_recording_id IS NOT NULL)))
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_recordings_v4_evidence_status'
  ) THEN
    ALTER TABLE exams.recordings
      ADD CONSTRAINT ck_recordings_v4_evidence_status
      CHECK (evidence_status IN ('PENDING', 'READY', 'ABSTAINED', 'REVIEW_REQUIRED', 'FAILED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_recordings_v4_transcript_status'
  ) THEN
    ALTER TABLE exams.recordings
      ADD CONSTRAINT ck_recordings_v4_transcript_status
      CHECK (transcript_status IN ('NOT_REQUESTED', 'PENDING', 'READY', 'FAILED', 'ABSTAINED'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_recordings_response_generation_v4
  ON exams.recordings (response_id, generation)
  WHERE response_id IS NOT NULL AND generation IS NOT NULL;

-- 6. exams.media_grants: Prompt withholding & examiner media turn binding
ALTER TABLE exams.media_grants
  ADD COLUMN IF NOT EXISTS turn_key VARCHAR(128) NULL;

ALTER TABLE exams.media_grants
  DROP CONSTRAINT IF EXISTS media_grants_purpose_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_media_grants_v4_purpose'
  ) THEN
    ALTER TABLE exams.media_grants
      ADD CONSTRAINT ck_media_grants_v4_purpose
      CHECK (purpose IN (
        'SIMULATION_LISTENING', 'PRACTICE_AUDIO', 'REVIEW_AUDIO',
        'EXAMINER_AUDIO', 'EXAMINER_VIDEO', 'EXAMINER_FALLBACK'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_media_grants_v4_turn_binding'
  ) THEN
    ALTER TABLE exams.media_grants
      ADD CONSTRAINT ck_media_grants_v4_turn_binding
      CHECK (
        (purpose IN ('EXAMINER_AUDIO', 'EXAMINER_VIDEO', 'EXAMINER_FALLBACK') AND turn_key IS NOT NULL)
        OR (purpose IN ('SIMULATION_LISTENING', 'PRACTICE_AUDIO', 'REVIEW_AUDIO'))
      );
  END IF;
END $$;

-- 7. exams.recording_chunks: Immutability guard for sealed / verified / failed recordings
CREATE OR REPLACE FUNCTION exams.fn_prevent_recording_chunk_mutation()
RETURNS TRIGGER AS $$
DECLARE
    v_rec_id UUID;
    v_state VARCHAR(32);
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_rec_id := OLD.recording_id;
    ELSE
        v_rec_id := NEW.recording_id;
    END IF;

    SELECT state INTO v_state
      FROM exams.recordings
     WHERE id = v_rec_id;

    IF v_state IN ('SEALED', 'VERIFIED', 'FAILED') THEN
        RAISE EXCEPTION 'RECORDING_SEALED_IMMUTABLE: Chunks cannot be inserted, updated, or deleted after recording is SEALED, VERIFIED, or FAILED'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_recording_chunk_mutation ON exams.recording_chunks;
CREATE TRIGGER trg_prevent_recording_chunk_mutation
    BEFORE INSERT OR UPDATE OR DELETE ON exams.recording_chunks
    FOR EACH ROW
    EXECUTE FUNCTION exams.fn_prevent_recording_chunk_mutation();

-- 8. exams.profile_evidence: Replacement production eligibility gate (V7 replacement in-place)
CREATE OR REPLACE FUNCTION exams.fn_check_production_profile_evidence()
RETURNS TRIGGER AS $$
DECLARE
    v_mode VARCHAR(32);
    v_status VARCHAR(32);
    v_lifecycle VARCHAR(32);
    v_published_at TIMESTAMPTZ;
    v_calibration_id UUID;
    v_scheme_approved_at TIMESTAMPTZ;
    v_calibration_maturity VARCHAR(64);
    v_calibration_approved_at TIMESTAMPTZ;
    v_artifact_status VARCHAR(32);
    v_sub_id UUID;
    v_run_ord INTEGER;
BEGIN
    -- 1. Validate attempt mode, status, and published form calibration
    SELECT a.attempt_mode,
           a.status,
           f.lifecycle_state,
           f.published_at,
           s.calibration_id,
           s.approved_at,
           c.maturity_stage,
           c.approved_at
      INTO v_mode,
           v_status,
           v_lifecycle,
           v_published_at,
           v_calibration_id,
           v_scheme_approved_at,
           v_calibration_maturity,
           v_calibration_approved_at
      FROM exams.attempts a
      JOIN exams.form_versions f ON f.id = a.form_id
      LEFT JOIN exams.scoring_scheme_versions s ON s.id = f.scoring_scheme_id
      LEFT JOIN exams.calibration_versions c ON c.id = s.calibration_id
     WHERE a.id = NEW.attempt_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PROFILE_EVIDENCE_ATTEMPT_NOT_FOUND'
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_mode <> 'EXAM_SIMULATION' THEN
        RAISE EXCEPTION 'PRACTICE_EVIDENCE_FORBIDDEN: Practice activity cannot directly create trusted profile evidence'
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_status <> 'SUBMITTED' THEN
        RAISE EXCEPTION 'UNSUBMITTED_EVIDENCE_FORBIDDEN: Unsubmitted attempt cannot generate profile evidence'
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_lifecycle <> 'PUBLISHED' OR v_published_at IS NULL THEN
        RAISE EXCEPTION 'PROFILE_FORM_NOT_PRODUCTION_ELIGIBLE: Only a published production form may create trusted profile evidence'
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_calibration_id IS NULL
       OR v_scheme_approved_at IS NULL
       OR v_calibration_approved_at IS NULL
       OR v_calibration_maturity IS NULL
       OR v_calibration_maturity NOT IN (
           'EXPERT_ESTIMATED',
           'PILOT_CALIBRATED',
           'EMPIRICALLY_CALIBRATED',
           'LINKED_CALIBRATED'
       ) THEN
        RAISE EXCEPTION 'PROFILE_CALIBRATION_NOT_APPROVED: Published form lacks an approved production calibration'
            USING ERRCODE = 'check_violation';
    END IF;

    -- 2. V10 forward gate: Validate score artifact completion and non-superseded latest run
    SELECT result_status, submission_id, run_ordinal
      INTO v_artifact_status, v_sub_id, v_run_ord
      FROM exams.score_artifacts
     WHERE id = NEW.artifact_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PROFILE_EVIDENCE_ARTIFACT_NOT_FOUND'
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_artifact_status <> 'COMPLETED' THEN
        RAISE EXCEPTION 'PROFILE_ARTIFACT_NOT_COMPLETED: Only COMPLETED score artifacts may create trusted profile evidence (current: %)', v_artifact_status
            USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
        SELECT 1 FROM exams.score_artifacts
         WHERE submission_id = v_sub_id AND run_ordinal > v_run_ord
    ) THEN
        RAISE EXCEPTION 'SUPERSEDED_ARTIFACT_FORBIDDEN: Profile evidence must point to latest run of score artifact'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_production_profile_evidence ON exams.profile_evidence;
CREATE TRIGGER trg_production_profile_evidence
    BEFORE INSERT ON exams.profile_evidence
    FOR EACH ROW
    EXECUTE FUNCTION exams.fn_check_production_profile_evidence();

-- 9. Runtime V4 specialized performance & query indexes
CREATE INDEX IF NOT EXISTS idx_attempt_sections_speaking_cursor
  ON exams.attempt_sections (attempt_id, current_turn_placement_id, current_turn_key)
  WHERE current_turn_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_responses_attempt_turn_v4
  ON exams.responses (attempt_id, section_id, placement_id, turn_sequence)
  WHERE turn_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profile_evidence_attempt_status
  ON exams.profile_evidence (attempt_id, status, artifact_id);
