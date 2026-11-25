-- V7__exams_profile_production_eligibility.sql
-- Trusted Competency Profile admission.  Keep V6 immutable after deployment.

-- Attempts on draft/internal, pilot, or calibration forms are valid runtime
-- or measurement activity, but they are not production profile evidence.  A
-- published form is eligible only when both the scoring scheme and its linked
-- calibration version carry explicit approval metadata and the maturity uses
-- one of the canonical estimate/calibration labels.  The worker applies the
-- same rule before emitting a row; this trigger is the database backstop for
-- direct/replayed inserts.
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
BEGIN
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

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_production_profile_evidence ON exams.profile_evidence;
CREATE TRIGGER trg_production_profile_evidence
    BEFORE INSERT ON exams.profile_evidence
    FOR EACH ROW
    EXECUTE FUNCTION exams.fn_check_production_profile_evidence();
