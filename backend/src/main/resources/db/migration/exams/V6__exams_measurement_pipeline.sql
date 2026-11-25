-- ============================================================================
-- V6__exams_measurement_pipeline.sql
-- Pilot measurement, human calibration, and scorer validation.
--
-- Measurement rows are append-only facts.  They point back to the frozen
-- attempt/response/submission rows; an operator cannot turn an assertion into
-- learner or human evidence by choosing a source label.
-- ============================================================================

CREATE TABLE IF NOT EXISTS exams.measurement_consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    participant_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    purpose VARCHAR(64) NOT NULL CHECK (purpose IN ('EXAMS_PILOT', 'EXAMS_HUMAN_RATING')),
    status VARCHAR(16) NOT NULL CHECK (status IN ('GRANTED', 'WITHDRAWN')),
    actor_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    consent_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_measurement_consents_participant
    ON exams.measurement_consents(participant_user_id, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS exams.measurement_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id UUID NOT NULL REFERENCES exams.attempts(id) ON DELETE RESTRICT,
    submission_id UUID NOT NULL REFERENCES exams.submissions(id) ON DELETE RESTRICT,
    response_id UUID NOT NULL REFERENCES exams.responses(id) ON DELETE RESTRICT,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    form_id UUID NOT NULL REFERENCES exams.form_versions(id) ON DELETE RESTRICT,
    item_id UUID NOT NULL REFERENCES exams.item_versions(id) ON DELETE RESTRICT,
    family VARCHAR(16) NOT NULL CHECK (family IN ('IELTS', 'TOEIC')),
    variant VARCHAR(64) NOT NULL,
    scope VARCHAR(32) NOT NULL,
    skill VARCHAR(16) NOT NULL CHECK (skill IN ('LISTENING', 'READING', 'WRITING', 'SPEAKING')),
    task_family VARCHAR(64),
    attempt_mode VARCHAR(32) NOT NULL CHECK (attempt_mode IN ('EXAM_SIMULATION', 'PRACTICE')),
    form_version INTEGER NOT NULL CHECK (form_version > 0),
    item_version INTEGER NOT NULL CHECK (item_version > 0),
    form_content_hash VARCHAR(64) NOT NULL,
    item_content_hash VARCHAR(64) NOT NULL,
    manifest_hash VARCHAR(64) NOT NULL,
    submission_hash VARCHAR(64) NOT NULL,
    response_revision BIGINT NOT NULL CHECK (response_revision > 0),
    exposure_status VARCHAR(16) NOT NULL CHECK (exposure_status IN ('FAMILIAR', 'UNEXPOSED', 'UNKNOWN')),
    consent_status VARCHAR(16) NOT NULL CHECK (consent_status IN ('GRANTED', 'WITHDRAWN', 'UNKNOWN')),
    consent_reference UUID REFERENCES exams.measurement_consents(id) ON DELETE RESTRICT,
    source_type VARCHAR(32) NOT NULL CHECK (source_type IN ('RUNTIME_EXPORT', 'OPERATOR_LINKED_IMPORT', 'SYNTHETIC_ENGINEERING')),
    evidence_class VARCHAR(32) NOT NULL CHECK (evidence_class IN ('RUNTIME_OPERATIONAL', 'ENGINEERING_SYNTHETIC')),
    outcome_status VARCHAR(16) NOT NULL CHECK (outcome_status IN ('CORRECT', 'INCORRECT', 'OMITTED', 'ABSTAINED', 'UNKNOWN')),
    outcome_source VARCHAR(32) NOT NULL CHECK (outcome_source IN ('ANSWER_SPEC', 'RUNTIME_SCORE_ARTIFACT', 'HUMAN_RATING', 'UNAVAILABLE')),
    score_awarded NUMERIC(8,3),
    max_score NUMERIC(8,3),
    response_time_ms BIGINT CHECK (response_time_ms IS NULL OR response_time_ms >= 0),
    selected_option VARCHAR(255),
    response_payload JSONB,
    event_hash VARCHAR(64) NOT NULL CHECK (length(event_hash) = 64),
    created_by BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_measurement_event_response UNIQUE (submission_id, response_id)
);
CREATE INDEX IF NOT EXISTS idx_measurement_events_form_item
    ON exams.measurement_events(form_id, item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_measurement_events_attempt
    ON exams.measurement_events(attempt_id, response_id);

CREATE TABLE IF NOT EXISTS exams.measurement_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family VARCHAR(16) NOT NULL CHECK (family IN ('IELTS', 'TOEIC')),
    skill VARCHAR(16) CHECK (skill IS NULL OR skill IN ('LISTENING', 'READING', 'WRITING', 'SPEAKING')),
    form_id UUID REFERENCES exams.form_versions(id) ON DELETE RESTRICT,
    sample_filter JSONB NOT NULL DEFAULT '{}'::jsonb,
    consent_policy_version VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'RAW' CHECK (status IN ('RAW', 'CLEAN', 'FINAL', 'INSUFFICIENT', 'REJECTED')),
    raw_count INTEGER NOT NULL DEFAULT 0 CHECK (raw_count >= 0),
    clean_count INTEGER NOT NULL DEFAULT 0 CHECK (clean_count >= 0),
    excluded_count INTEGER NOT NULL DEFAULT 0 CHECK (excluded_count >= 0),
    input_hash VARCHAR(64) NOT NULL CHECK (length(input_hash) = 64),
    created_by BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    finalized_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_measurement_runs_scope
    ON exams.measurement_runs(family, skill, form_id, status);

CREATE TABLE IF NOT EXISTS exams.measurement_run_events (
    run_id UUID NOT NULL REFERENCES exams.measurement_runs(id) ON DELETE RESTRICT,
    event_id UUID NOT NULL REFERENCES exams.measurement_events(id) ON DELETE RESTRICT,
    disposition VARCHAR(16) NOT NULL CHECK (disposition IN ('INCLUDE', 'EXCLUDE')),
    reason VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (run_id, event_id),
    CONSTRAINT ck_run_event_reason CHECK (disposition = 'INCLUDE' OR reason IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS exams.measurement_exclusions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES exams.measurement_runs(id) ON DELETE RESTRICT,
    event_id UUID NOT NULL REFERENCES exams.measurement_events(id) ON DELETE RESTRICT,
    reason VARCHAR(64) NOT NULL,
    detail TEXT,
    actor_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_measurement_exclusion UNIQUE (run_id, event_id)
);

CREATE TABLE IF NOT EXISTS exams.item_statistics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES exams.measurement_runs(id) ON DELETE RESTRICT,
    item_id UUID NOT NULL REFERENCES exams.item_versions(id) ON DELETE RESTRICT,
    sample_size INTEGER NOT NULL CHECK (sample_size >= 0),
    valid_count INTEGER NOT NULL CHECK (valid_count >= 0),
    p_value NUMERIC(8,5),
    item_rest_point_biserial NUMERIC(10,6),
    omission_rate NUMERIC(8,5),
    median_response_time_ms BIGINT,
    distractor_rates JSONB NOT NULL DEFAULT '{}'::jsonb,
    reliability_status VARCHAR(16) NOT NULL CHECK (reliability_status IN ('CALCULATED', 'INSUFFICIENT', 'UNDEFINED')),
    flags JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_item_statistics_run_item UNIQUE (run_id, item_id)
);

CREATE TABLE IF NOT EXISTS exams.calibration_packages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    logical_code VARCHAR(128) NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    form_id UUID NOT NULL REFERENCES exams.form_versions(id) ON DELETE RESTRICT,
    scoring_scheme_id UUID NOT NULL REFERENCES exams.scoring_scheme_versions(id) ON DELETE RESTRICT,
    measurement_run_id UUID NOT NULL REFERENCES exams.measurement_runs(id) ON DELETE RESTRICT,
    method VARCHAR(32) NOT NULL CHECK (method IN ('EXPERT_ESTIMATE', 'CTT_PRELIMINARY', 'EMPIRICAL', 'LINKED')),
    maturity_stage VARCHAR(32) NOT NULL CHECK (maturity_stage IN ('DRAFT', 'PILOT', 'CALIBRATED', 'VALIDATED')),
    mapping_table JSONB NOT NULL,
    uncertainty_model JSONB NOT NULL,
    evidence_hash VARCHAR(64) NOT NULL CHECK (length(evidence_hash) = 64),
    validation_report TEXT NOT NULL,
    approval_state VARCHAR(24) NOT NULL DEFAULT 'PENDING_APPROVAL'
        CHECK (approval_state IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'REVOKED')),
    approved_by BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    approved_at TIMESTAMPTZ,
    created_by BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_calibration_package_version UNIQUE (logical_code, version)
);

CREATE TABLE IF NOT EXISTS exams.human_gold_datasets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    logical_code VARCHAR(128) NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    family VARCHAR(16) NOT NULL CHECK (family IN ('IELTS', 'TOEIC')),
    skill VARCHAR(16) NOT NULL CHECK (skill IN ('LISTENING', 'READING', 'WRITING', 'SPEAKING')),
    rubric_version_id UUID REFERENCES exams.rubric_versions(id) ON DELETE RESTRICT,
    consent_policy_version VARCHAR(64) NOT NULL,
    provenance_statement TEXT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'LOCKED', 'RELEASED', 'REVOKED')),
    locked_by BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    locked_at TIMESTAMPTZ,
    created_by BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_human_gold_dataset_version UNIQUE (logical_code, version)
);

CREATE TABLE IF NOT EXISTS exams.human_gold_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_id UUID NOT NULL REFERENCES exams.human_gold_datasets(id) ON DELETE RESTRICT,
    response_id UUID NOT NULL REFERENCES exams.responses(id) ON DELETE RESTRICT,
    attempt_id UUID NOT NULL REFERENCES exams.attempts(id) ON DELETE RESTRICT,
    family VARCHAR(16) NOT NULL CHECK (family IN ('IELTS', 'TOEIC')),
    skill VARCHAR(16) NOT NULL CHECK (skill IN ('LISTENING', 'READING', 'WRITING', 'SPEAKING')),
    consent_id UUID NOT NULL REFERENCES exams.measurement_consents(id) ON DELETE RESTRICT,
    split VARCHAR(16) NOT NULL CHECK (split IN ('DEVELOPMENT', 'CALIBRATION', 'VALIDATION', 'TEST')),
    response_hash VARCHAR(64) NOT NULL CHECK (length(response_hash) = 64),
    created_by BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_human_gold_member UNIQUE (dataset_id, response_id)
);
CREATE INDEX IF NOT EXISTS idx_human_gold_members_split ON exams.human_gold_members(dataset_id, split);

CREATE TABLE IF NOT EXISTS exams.rater_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_id UUID REFERENCES exams.human_gold_datasets(id) ON DELETE RESTRICT,
    response_id UUID NOT NULL REFERENCES exams.responses(id) ON DELETE RESTRICT,
    attempt_id UUID NOT NULL REFERENCES exams.attempts(id) ON DELETE RESTRICT,
    family VARCHAR(16) NOT NULL CHECK (family IN ('IELTS', 'TOEIC')),
    skill VARCHAR(16) NOT NULL CHECK (skill IN ('LISTENING', 'READING', 'WRITING', 'SPEAKING')),
    rater_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    assigned_by BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    blind_to_other_ratings BOOLEAN NOT NULL DEFAULT TRUE,
    status VARCHAR(16) NOT NULL DEFAULT 'ASSIGNED' CHECK (status IN ('ASSIGNED', 'SUBMITTED', 'ADJUDICATED', 'CANCELLED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_assignment_independence CHECK (rater_user_id <> assigned_by),
    CONSTRAINT uq_rater_assignment UNIQUE (response_id, rater_user_id, dataset_id)
);

CREATE TABLE IF NOT EXISTS exams.rater_ratings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assignment_id UUID NOT NULL REFERENCES exams.rater_assignments(id) ON DELETE RESTRICT,
    rater_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    rubric_version_id UUID REFERENCES exams.rubric_versions(id) ON DELETE RESTRICT,
    criterion_scores JSONB NOT NULL,
    overall_score NUMERIC(8,3),
    confidence NUMERIC(5,4) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
    rating_hash VARCHAR(64) NOT NULL CHECK (length(rating_hash) = 64),
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_rater_rating_assignment UNIQUE (assignment_id)
);

CREATE TABLE IF NOT EXISTS exams.rater_adjudications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    response_id UUID NOT NULL REFERENCES exams.responses(id) ON DELETE RESTRICT,
    dataset_id UUID REFERENCES exams.human_gold_datasets(id) ON DELETE RESTRICT,
    adjudicator_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    selected_rating_id UUID REFERENCES exams.rater_ratings(id) ON DELETE RESTRICT,
    final_scores JSONB NOT NULL,
    disagreement_reason TEXT NOT NULL,
    decision_hash VARCHAR(64) NOT NULL CHECK (length(decision_hash) = 64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS exams.scorer_evaluation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_id UUID NOT NULL REFERENCES exams.human_gold_datasets(id) ON DELETE RESTRICT,
    scorer_name VARCHAR(128) NOT NULL,
    scorer_version VARCHAR(128) NOT NULL,
    split_policy JSONB NOT NULL,
    locked_test_hash VARCHAR(64) NOT NULL CHECK (length(locked_test_hash) = 64),
    status VARCHAR(16) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'RUNNING', 'COMPLETED', 'INSUFFICIENT', 'REJECTED')),
    metrics JSONB,
    criterion_reports JSONB,
    subgroup_reports JSONB,
    abstention_report JSONB,
    created_by BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS exams.scorer_evaluation_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES exams.scorer_evaluation_runs(id) ON DELETE RESTRICT,
    member_id UUID NOT NULL REFERENCES exams.human_gold_members(id) ON DELETE RESTRICT,
    split VARCHAR(16) NOT NULL CHECK (split IN ('DEVELOPMENT', 'CALIBRATION', 'VALIDATION', 'TEST')),
    criterion VARCHAR(128) NOT NULL,
    human_score NUMERIC(8,3) NOT NULL,
    ai_score NUMERIC(8,3),
    abstained BOOLEAN NOT NULL DEFAULT FALSE,
    subgroup VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_scorer_evaluation_record UNIQUE (run_id, member_id, criterion)
);

-- --------------------------------------------------------------------------
-- Append-only and provenance checks.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION exams.fn_measurement_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'IMMUTABLE_MEASUREMENT: measurement evidence is append-only; create a new row'
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_measurement_consents_immutable ON exams.measurement_consents;
CREATE TRIGGER trg_measurement_consents_immutable
    BEFORE UPDATE OR DELETE ON exams.measurement_consents FOR EACH ROW
    EXECUTE FUNCTION exams.fn_measurement_append_only();
DROP TRIGGER IF EXISTS trg_measurement_events_immutable ON exams.measurement_events;
CREATE TRIGGER trg_measurement_events_immutable
    BEFORE UPDATE OR DELETE ON exams.measurement_events FOR EACH ROW
    EXECUTE FUNCTION exams.fn_measurement_append_only();
DROP TRIGGER IF EXISTS trg_measurement_run_events_immutable ON exams.measurement_run_events;
CREATE TRIGGER trg_measurement_run_events_immutable
    BEFORE UPDATE OR DELETE ON exams.measurement_run_events FOR EACH ROW
    EXECUTE FUNCTION exams.fn_measurement_append_only();
DROP TRIGGER IF EXISTS trg_measurement_exclusions_immutable ON exams.measurement_exclusions;
CREATE TRIGGER trg_measurement_exclusions_immutable
    BEFORE UPDATE OR DELETE ON exams.measurement_exclusions FOR EACH ROW
    EXECUTE FUNCTION exams.fn_measurement_append_only();
DROP TRIGGER IF EXISTS trg_item_statistics_immutable ON exams.item_statistics;
CREATE TRIGGER trg_item_statistics_immutable
    BEFORE UPDATE OR DELETE ON exams.item_statistics FOR EACH ROW
    EXECUTE FUNCTION exams.fn_measurement_append_only();
DROP TRIGGER IF EXISTS trg_human_gold_members_immutable ON exams.human_gold_members;
CREATE TRIGGER trg_human_gold_members_immutable
    BEFORE UPDATE OR DELETE ON exams.human_gold_members FOR EACH ROW
    EXECUTE FUNCTION exams.fn_measurement_append_only();
DROP TRIGGER IF EXISTS trg_rater_ratings_immutable ON exams.rater_ratings;
CREATE TRIGGER trg_rater_ratings_immutable
    BEFORE UPDATE OR DELETE ON exams.rater_ratings FOR EACH ROW
    EXECUTE FUNCTION exams.fn_measurement_append_only();
DROP TRIGGER IF EXISTS trg_rater_adjudications_immutable ON exams.rater_adjudications;
CREATE TRIGGER trg_rater_adjudications_immutable
    BEFORE UPDATE OR DELETE ON exams.rater_adjudications FOR EACH ROW
    EXECUTE FUNCTION exams.fn_measurement_append_only();
DROP TRIGGER IF EXISTS trg_scorer_evaluation_records_immutable ON exams.scorer_evaluation_records;
CREATE TRIGGER trg_scorer_evaluation_records_immutable
    BEFORE UPDATE OR DELETE ON exams.scorer_evaluation_records FOR EACH ROW
    EXECUTE FUNCTION exams.fn_measurement_append_only();

CREATE OR REPLACE FUNCTION exams.fn_validate_measurement_event()
RETURNS TRIGGER AS $$
DECLARE
    v_user_id BIGINT;
    v_form_id UUID;
    v_family VARCHAR(16);
    v_variant VARCHAR(64);
    v_scope VARCHAR(32);
    v_mode VARCHAR(32);
    v_status VARCHAR(32);
    v_form_version INTEGER;
    v_form_hash VARCHAR(64);
    v_item_id UUID;
    v_item_version INTEGER;
    v_item_hash VARCHAR(64);
    v_submission_attempt UUID;
    v_response_attempt UUID;
    v_response_item UUID;
    v_expected_exposure VARCHAR(16);
BEGIN
    SELECT a.user_id, a.form_id, a.family, a.variant, a.scope, a.attempt_mode,
           a.status, f.version, f.content_hash
      INTO v_user_id, v_form_id, v_family, v_variant, v_scope, v_mode,
           v_status, v_form_version, v_form_hash
      FROM exams.attempts a
      JOIN exams.form_versions f ON f.id = a.form_id
     WHERE a.id = NEW.attempt_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'MEASUREMENT_ATTEMPT_NOT_FOUND';
    END IF;
    SELECT attempt_id INTO v_submission_attempt FROM exams.submissions WHERE id = NEW.submission_id;
    SELECT attempt_id, item_id INTO v_response_attempt, v_response_item FROM exams.responses WHERE id = NEW.response_id;
    SELECT i.version, i.content_hash INTO v_item_version, v_item_hash
      FROM exams.item_versions i WHERE i.id = v_response_item;
    IF v_status <> 'SUBMITTED' OR v_submission_attempt <> NEW.attempt_id OR v_response_attempt <> NEW.attempt_id
       OR v_response_item <> NEW.item_id THEN
        RAISE EXCEPTION 'MEASUREMENT_LINK_INVALID: attempt, submission, and response must be the same submitted attempt';
    END IF;
    IF NEW.user_id <> v_user_id OR NEW.form_id <> v_form_id OR NEW.family <> v_family
       OR NEW.variant <> v_variant OR NEW.scope <> v_scope OR NEW.attempt_mode <> v_mode
       OR NEW.form_version <> v_form_version OR NEW.form_content_hash <> v_form_hash
       OR NEW.item_version <> v_item_version OR NEW.item_content_hash <> v_item_hash THEN
        RAISE EXCEPTION 'MEASUREMENT_IDENTITY_MISMATCH: event identity/version does not match runtime rows';
    END IF;
    IF NEW.source_type = 'RUNTIME_EXPORT' AND NEW.evidence_class <> 'RUNTIME_OPERATIONAL' THEN
        RAISE EXCEPTION 'MEASUREMENT_EVIDENCE_CLASS_INVALID';
    END IF;
    IF NEW.evidence_class = 'ENGINEERING_SYNTHETIC' AND NEW.source_type <> 'SYNTHETIC_ENGINEERING' THEN
        RAISE EXCEPTION 'SYNTHETIC_EVIDENCE_SOURCE_INVALID';
    END IF;
    IF EXISTS (
        SELECT 1 FROM exams.exposures e
        WHERE e.user_id = v_user_id
          AND e.logical_content_key = (SELECT logical_item_key FROM exams.item_versions WHERE id = NEW.item_id)
          AND e.version = v_item_version
    ) THEN
        v_expected_exposure := 'FAMILIAR';
    ELSE
        v_expected_exposure := 'UNKNOWN';
    END IF;
    IF NEW.exposure_status <> v_expected_exposure THEN
        RAISE EXCEPTION 'MEASUREMENT_EXPOSURE_MISMATCH: exposure must be derived from exams.exposures';
    END IF;
    IF NEW.consent_status = 'GRANTED' AND NEW.consent_reference IS NULL THEN
        RAISE EXCEPTION 'MEASUREMENT_CONSENT_REFERENCE_REQUIRED';
    END IF;
    IF NEW.consent_reference IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM exams.measurement_consents c
         WHERE c.id = NEW.consent_reference
           AND c.participant_user_id = v_user_id
           AND c.status = 'GRANTED'
    ) THEN
        RAISE EXCEPTION 'MEASUREMENT_CONSENT_INVALID';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_measurement_event ON exams.measurement_events;
CREATE TRIGGER trg_validate_measurement_event
    BEFORE INSERT ON exams.measurement_events FOR EACH ROW
    EXECUTE FUNCTION exams.fn_validate_measurement_event();

CREATE OR REPLACE FUNCTION exams.fn_calibration_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.approval_state = 'PENDING_APPROVAL' AND NEW.approval_state = 'APPROVED'
       AND NEW.approved_by IS NOT NULL AND NEW.approved_at IS NOT NULL THEN
        IF NEW.id <> OLD.id OR NEW.scoring_scheme_id <> OLD.scoring_scheme_id
           OR NEW.mapping_table <> OLD.mapping_table OR NEW.evidence_hash <> OLD.evidence_hash
           OR NEW.measurement_run_id <> OLD.measurement_run_id THEN
            RAISE EXCEPTION 'IMMUTABLE_CALIBRATION: only approval metadata may change';
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'IMMUTABLE_CALIBRATION: calibration packages cannot be edited';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_calibration_transition ON exams.calibration_packages;
CREATE TRIGGER trg_calibration_transition
    BEFORE UPDATE OR DELETE ON exams.calibration_packages FOR EACH ROW
    EXECUTE FUNCTION exams.fn_calibration_transition();

CREATE OR REPLACE FUNCTION exams.fn_gold_dataset_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = 'DRAFT' AND NEW.status = 'LOCKED'
       AND NEW.locked_by IS NOT NULL AND NEW.locked_at IS NOT NULL
       AND NEW.id = OLD.id THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'IMMUTABLE_GOLD_DATASET: only draft-to-locked transition is allowed';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_gold_dataset_transition ON exams.human_gold_datasets;
CREATE TRIGGER trg_gold_dataset_transition
    BEFORE UPDATE OR DELETE ON exams.human_gold_datasets FOR EACH ROW
    EXECUTE FUNCTION exams.fn_gold_dataset_transition();

CREATE OR REPLACE FUNCTION exams.fn_validate_gold_member_insert()
RETURNS TRIGGER AS $$
DECLARE
    v_status VARCHAR(16);
    v_user_id BIGINT;
    v_family VARCHAR(16);
    v_skill VARCHAR(16);
BEGIN
    SELECT status, family, skill INTO v_status, v_family, v_skill
      FROM exams.human_gold_datasets WHERE id = NEW.dataset_id;
    SELECT a.user_id INTO v_user_id FROM exams.attempts a WHERE a.id = NEW.attempt_id;
    IF v_status <> 'DRAFT' OR NEW.family <> v_family OR NEW.skill <> v_skill THEN
        RAISE EXCEPTION 'GOLD_MEMBER_DATASET_SCOPE_INVALID';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM exams.responses r
         WHERE r.id = NEW.response_id AND r.attempt_id = NEW.attempt_id
    ) THEN
        RAISE EXCEPTION 'GOLD_MEMBER_RESPONSE_LINK_INVALID';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM exams.measurement_consents c
         WHERE c.id = NEW.consent_id AND c.participant_user_id = v_user_id
           AND c.purpose = 'EXAMS_HUMAN_RATING' AND c.status = 'GRANTED'
    ) THEN
        RAISE EXCEPTION 'GOLD_MEMBER_CONSENT_INVALID';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_gold_member_insert ON exams.human_gold_members;
CREATE TRIGGER trg_validate_gold_member_insert
    BEFORE INSERT ON exams.human_gold_members FOR EACH ROW
    EXECUTE FUNCTION exams.fn_validate_gold_member_insert();

CREATE OR REPLACE FUNCTION exams.fn_validate_rating_insert()
RETURNS TRIGGER AS $$
DECLARE
    v_rater BIGINT;
    v_status VARCHAR(16);
BEGIN
    SELECT rater_user_id, status INTO v_rater, v_status
      FROM exams.rater_assignments WHERE id = NEW.assignment_id;
    IF v_rater IS NULL OR v_rater <> NEW.rater_user_id OR v_status <> 'ASSIGNED' THEN
        RAISE EXCEPTION 'RATER_IDENTITY_OR_STATUS_INVALID';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_rating_insert ON exams.rater_ratings;
CREATE TRIGGER trg_validate_rating_insert
    BEFORE INSERT ON exams.rater_ratings FOR EACH ROW
    EXECUTE FUNCTION exams.fn_validate_rating_insert();

CREATE OR REPLACE FUNCTION exams.fn_validate_adjudication_insert()
RETURNS TRIGGER AS $$
DECLARE
    v_response_id UUID;
    v_dataset_id UUID;
BEGIN
    IF NEW.selected_rating_id IS NOT NULL THEN
        SELECT a.response_id, a.dataset_id INTO v_response_id, v_dataset_id
          FROM exams.rater_ratings rr
          JOIN exams.rater_assignments a ON a.id = rr.assignment_id
         WHERE rr.id = NEW.selected_rating_id;
        IF v_response_id IS NULL OR v_response_id <> NEW.response_id
           OR (NEW.dataset_id IS NOT NULL AND v_dataset_id <> NEW.dataset_id) THEN
            RAISE EXCEPTION 'ADJUDICATION_SELECTED_RATING_OUTSIDE_RESPONSE';
        END IF;
    END IF;
    IF EXISTS (
        SELECT 1 FROM exams.rater_assignments a
         WHERE a.response_id = NEW.response_id
           AND (NEW.dataset_id IS NULL OR a.dataset_id = NEW.dataset_id)
           AND a.rater_user_id = NEW.adjudicator_user_id
    ) THEN
        RAISE EXCEPTION 'ADJUDICATOR_INDEPENDENCE_INVALID';
    END IF;
    IF (
        SELECT COUNT(*) FROM exams.rater_ratings rr
        JOIN exams.rater_assignments a ON a.id = rr.assignment_id
         WHERE a.response_id = NEW.response_id
           AND (NEW.dataset_id IS NULL OR a.dataset_id = NEW.dataset_id)
           AND a.status = 'SUBMITTED'
    ) < 2 THEN
        RAISE EXCEPTION 'ADJUDICATION_REQUIRES_TWO_RATINGS';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_adjudication_insert ON exams.rater_adjudications;
CREATE TRIGGER trg_validate_adjudication_insert
    BEFORE INSERT ON exams.rater_adjudications FOR EACH ROW
    EXECUTE FUNCTION exams.fn_validate_adjudication_insert();
