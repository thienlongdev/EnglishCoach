-- ============================================================================
-- V4__integrity_operations.sql
-- English Coach Exams — Integrity triggers, operator permissions, audit log
-- ============================================================================

-- 40. operator_permissions
CREATE TABLE IF NOT EXISTS exams.operator_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    permission_code VARCHAR(64) NOT NULL,
    granted_by BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    revoked_at TIMESTAMPTZ,
    CONSTRAINT uq_active_operator_perm UNIQUE (user_id, permission_code)
);
CREATE INDEX IF NOT EXISTS idx_operator_permissions_user ON exams.operator_permissions(user_id) WHERE revoked_at IS NULL;

-- 41. audit_events
CREATE TABLE IF NOT EXISTS exams.audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    action VARCHAR(64) NOT NULL,
    entity_type VARCHAR(64) NOT NULL,
    entity_id VARCHAR(128) NOT NULL,
    before_hash VARCHAR(64),
    after_hash VARCHAR(64),
    reason TEXT,
    request_id VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON exams.audit_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON exams.audit_events(actor_id, created_at);

-- ============================================================================
-- INTEGRITY TRIGGERS
-- ============================================================================

-- Trigger 1: Author cannot approve their own required review gate
CREATE OR REPLACE FUNCTION exams.fn_check_author_self_review()
RETURNS TRIGGER AS $$
DECLARE
    v_author_id BIGINT;
BEGIN
    SELECT author_id INTO v_author_id
    FROM exams.form_versions
    WHERE id = NEW.form_id;

    IF v_author_id IS NOT NULL AND v_author_id = NEW.reviewer_user_id THEN
        RAISE EXCEPTION 'AUTHOR_SELF_REVIEW_FORBIDDEN: Author cannot review their own form version'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_author_cannot_review ON exams.content_reviews;
CREATE TRIGGER trg_author_cannot_review
    BEFORE INSERT ON exams.content_reviews
    FOR EACH ROW
    EXECUTE FUNCTION exams.fn_check_author_self_review();

-- Trigger 2: Practice attempts cannot enter trusted competency profile evidence
CREATE OR REPLACE FUNCTION exams.fn_check_practice_profile_evidence()
RETURNS TRIGGER AS $$
DECLARE
    v_mode VARCHAR(32);
    v_status VARCHAR(32);
BEGIN
    SELECT attempt_mode, status INTO v_mode, v_status
    FROM exams.attempts
    WHERE id = NEW.attempt_id;

    IF v_mode != 'EXAM_SIMULATION' THEN
        RAISE EXCEPTION 'PRACTICE_EVIDENCE_FORBIDDEN: Practice activity cannot directly create trusted profile evidence'
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_status != 'SUBMITTED' THEN
        RAISE EXCEPTION 'UNSUBMITTED_EVIDENCE_FORBIDDEN: Unsubmitted attempt cannot generate profile evidence'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_practice_profile_evidence ON exams.profile_evidence;
CREATE TRIGGER trg_practice_profile_evidence
    BEFORE INSERT ON exams.profile_evidence
    FOR EACH ROW
    EXECUTE FUNCTION exams.fn_check_practice_profile_evidence();

-- Trigger 3: Score components topology enforcement
CREATE OR REPLACE FUNCTION exams.fn_check_score_component_topology()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.family = 'TOEIC' AND NEW.metric = 'FULL_OVERALL' THEN
        RAISE EXCEPTION 'INVALID_SCORE_TOPOLOGY: TOEIC has no numerical four-skill Overall'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.family = 'IELTS' AND NEW.metric = 'LR_TOTAL' THEN
        RAISE EXCEPTION 'INVALID_SCORE_TOPOLOGY: IELTS does not use LR_TOTAL metric'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_score_component_topology ON exams.score_components;
CREATE TRIGGER trg_score_component_topology
    BEFORE INSERT ON exams.score_components
    FOR EACH ROW
    EXECUTE FUNCTION exams.fn_check_score_component_topology();

-- Trigger 4: Historical score artifacts are immutable
CREATE OR REPLACE FUNCTION exams.fn_prevent_score_artifact_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'IMMUTABLE_ARTIFACT: Historical scoring artifacts cannot be modified or deleted. Create a new artifact linked to predecessor.'
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_immutable_score_artifacts ON exams.score_artifacts;
CREATE TRIGGER trg_immutable_score_artifacts
    BEFORE UPDATE OR DELETE ON exams.score_artifacts
    FOR EACH ROW
    EXECUTE FUNCTION exams.fn_prevent_score_artifact_mutation();

-- Trigger 5: Responses frozen after attempt submission or expiration
CREATE OR REPLACE FUNCTION exams.fn_prevent_response_mutation_after_submit()
RETURNS TRIGGER AS $$
DECLARE
    v_status VARCHAR(32);
BEGIN
    SELECT status INTO v_status
    FROM exams.attempts
    WHERE id = OLD.attempt_id;

    IF v_status IN ('SUBMITTED', 'EXPIRED', 'INVALIDATED') THEN
        RAISE EXCEPTION 'RESPONSES_FROZEN: Responses cannot be modified or deleted after attempt submission or expiration'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_response_mutation ON exams.responses;
CREATE TRIGGER trg_prevent_response_mutation
    BEFORE UPDATE OR DELETE ON exams.responses
    FOR EACH ROW
    EXECUTE FUNCTION exams.fn_prevent_response_mutation_after_submit();
