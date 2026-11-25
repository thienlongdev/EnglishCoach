-- ============================================================================
-- V3__scoring_profile.sql
-- English Coach Exams — Scoring jobs, immutable artifacts, evidence, recommendations
-- ============================================================================

-- 31. jobs
CREATE TABLE IF NOT EXISTS exams.jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id UUID NOT NULL REFERENCES exams.submissions(id) ON DELETE RESTRICT,
    target VARCHAR(64) NOT NULL,
    pipeline_version VARCHAR(32) NOT NULL,
    run_ordinal INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'RETRY_WAIT', 'REVIEW_REQUIRED', 'FAILED')),
    next_run_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    lease_token VARCHAR(64),
    lease_expires_at TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_job_sub_target_ver_run UNIQUE (submission_id, target, pipeline_version, run_ordinal)
);
CREATE INDEX IF NOT EXISTS idx_jobs_ready ON exams.jobs(status, next_run_at) WHERE status IN ('PENDING', 'RETRY_WAIT');
CREATE INDEX IF NOT EXISTS idx_jobs_submission ON exams.jobs(submission_id);

-- 32. job_stages
CREATE TABLE IF NOT EXISTS exams.job_stages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES exams.jobs(id) ON DELETE RESTRICT,
    stage_key VARCHAR(64) NOT NULL,
    execution_ordinal INTEGER NOT NULL DEFAULT 1,
    input_hash VARCHAR(64) NOT NULL,
    output_hash VARCHAR(64),
    result_payload JSONB,
    private_asset_id UUID REFERENCES exams.assets(id) ON DELETE RESTRICT,
    provider_version_meta JSONB,
    duration_ms INTEGER,
    status VARCHAR(32) NOT NULL CHECK (status IN ('SUCCESS', 'FAILURE', 'ABSTAINED', 'REPAIR_ATTEMPTED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_job_stages_job ON exams.job_stages(job_id);

-- 33. score_artifacts
CREATE TABLE IF NOT EXISTS exams.score_artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id UUID NOT NULL REFERENCES exams.submissions(id) ON DELETE RESTRICT,
    run_ordinal INTEGER NOT NULL DEFAULT 1,
    predecessor_id UUID REFERENCES exams.score_artifacts(id) ON DELETE RESTRICT,
    version_bundle JSONB NOT NULL,
    evidence_hash VARCHAR(64) NOT NULL,
    result_status VARCHAR(32) NOT NULL CHECK (result_status IN ('COMPLETED', 'PARTIAL', 'REVIEW_REQUIRED', 'FAILED')),
    reviewer_provenance JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_score_artifact_submission_run UNIQUE (submission_id, run_ordinal)
);
CREATE INDEX IF NOT EXISTS idx_score_artifacts_submission ON exams.score_artifacts(submission_id);

-- 34. score_components
CREATE TABLE IF NOT EXISTS exams.score_components (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    artifact_id UUID NOT NULL REFERENCES exams.score_artifacts(id) ON DELETE RESTRICT,
    family VARCHAR(32) NOT NULL CHECK (family IN ('IELTS', 'TOEIC')),
    metric VARCHAR(32) NOT NULL CHECK (metric IN ('LISTENING', 'READING', 'WRITING', 'SPEAKING', 'FULL_OVERALL', 'LR_TOTAL')),
    section_id UUID REFERENCES exams.sections(id) ON DELETE RESTRICT,
    response_id UUID REFERENCES exams.responses(id) ON DELETE RESTRICT,
    raw_score NUMERIC(6,2),
    scaled_score NUMERIC(6,2) NOT NULL,
    scale_name VARCHAR(32) NOT NULL,
    uncertainty_range JSONB,
    calibration_id UUID REFERENCES exams.calibration_versions(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_score_components_artifact ON exams.score_components(artifact_id);

-- 35. criterion_scores
CREATE TABLE IF NOT EXISTS exams.criterion_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    artifact_id UUID NOT NULL REFERENCES exams.score_artifacts(id) ON DELETE RESTRICT,
    target VARCHAR(64) NOT NULL,
    rubric_criterion VARCHAR(64) NOT NULL,
    score NUMERIC(4,2) NOT NULL,
    evidence_references JSONB NOT NULL DEFAULT '[]'::jsonb,
    confidence_meta JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_criterion_target UNIQUE (artifact_id, target, rubric_criterion)
);
CREATE INDEX IF NOT EXISTS idx_criterion_scores_artifact ON exams.criterion_scores(artifact_id);

-- 36. review_cases
CREATE TABLE IF NOT EXISTS exams.review_cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id UUID NOT NULL REFERENCES exams.attempts(id) ON DELETE RESTRICT,
    job_id UUID REFERENCES exams.jobs(id) ON DELETE RESTRICT,
    artifact_id UUID REFERENCES exams.score_artifacts(id) ON DELETE RESTRICT,
    reason VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ASSIGNED', 'RESOLVED', 'REJECTED')),
    assigned_operator_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    decision_payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_review_cases_open ON exams.review_cases(status) WHERE status IN ('OPEN', 'ASSIGNED');
CREATE INDEX IF NOT EXISTS idx_review_cases_attempt ON exams.review_cases(attempt_id);

-- 37. profile_evidence
CREATE TABLE IF NOT EXISTS exams.profile_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    attempt_id UUID NOT NULL REFERENCES exams.attempts(id) ON DELETE RESTRICT,
    artifact_id UUID NOT NULL REFERENCES exams.score_artifacts(id) ON DELETE RESTRICT,
    component_id UUID NOT NULL REFERENCES exams.score_components(id) ON DELETE RESTRICT,
    family VARCHAR(32) NOT NULL CHECK (family IN ('IELTS', 'TOEIC')),
    metric VARCHAR(32) NOT NULL,
    scope VARCHAR(32) NOT NULL,
    cohort_key VARCHAR(128) NOT NULL,
    measurement_date TIMESTAMPTZ NOT NULL,
    score_value NUMERIC(6,2) NOT NULL,
    exposure_status VARCHAR(32) NOT NULL DEFAULT 'UNEXPOSED',
    quality_meta JSONB,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'SUPERSEDED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_profile_evidence UNIQUE (artifact_id, component_id)
);
CREATE INDEX IF NOT EXISTS idx_profile_evidence_user_metric ON exams.profile_evidence(user_id, family, metric, measurement_date);

-- 38. evidence_events
CREATE TABLE IF NOT EXISTS exams.evidence_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_id UUID NOT NULL REFERENCES exams.profile_evidence(id) ON DELETE RESTRICT,
    event_type VARCHAR(32) NOT NULL CHECK (event_type IN ('ACCEPTED', 'REVOKED', 'SUPERSEDED')),
    reason TEXT NOT NULL,
    successor_id UUID REFERENCES exams.profile_evidence(id) ON DELETE RESTRICT,
    policy_version VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_evidence_events_evidence ON exams.evidence_events(evidence_id);

-- 39. recommendations
CREATE TABLE IF NOT EXISTS exams.recommendations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    evidence_id UUID REFERENCES exams.profile_evidence(id) ON DELETE RESTRICT,
    diagnostic_code VARCHAR(64) NOT NULL,
    mapping_version VARCHAR(32) NOT NULL,
    training_module VARCHAR(32) NOT NULL CHECK (training_module IN ('READING', 'LISTENING', 'WRITING', 'SPEAKING')),
    target_id VARCHAR(128),
    reason TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PUBLISHED', 'OPENED', 'DISMISSED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_rec_evidence_diag UNIQUE (evidence_id, diagnostic_code, mapping_version)
);
CREATE INDEX IF NOT EXISTS idx_recommendations_user ON exams.recommendations(user_id, status);
