-- ============================================================================
-- V2__runtime.sql
-- English Coach Exams — Attempts, responses, submissions, media, receipts, exposures
-- ============================================================================

-- 22. attempts
CREATE TABLE IF NOT EXISTS exams.attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    form_id UUID NOT NULL REFERENCES exams.form_versions(id) ON DELETE RESTRICT,
    family VARCHAR(32) NOT NULL CHECK (family IN ('IELTS', 'TOEIC')),
    variant VARCHAR(64) NOT NULL,
    scope VARCHAR(32) NOT NULL,
    attempt_mode VARCHAR(32) NOT NULL CHECK (attempt_mode IN ('EXAM_SIMULATION', 'PRACTICE')),
    parent_suite_id UUID REFERENCES exams.attempts(id) ON DELETE RESTRICT,
    original_full_attempt_id UUID REFERENCES exams.attempts(id) ON DELETE RESTRICT,
    status VARCHAR(32) NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'READY', 'IN_PROGRESS', 'SUBMITTED', 'EXPIRED', 'INVALIDATED')),
    revision BIGINT NOT NULL DEFAULT 1,
    writer_epoch BIGINT NOT NULL DEFAULT 1,
    active_token_hash VARCHAR(64),
    lease_expires_at TIMESTAMPTZ,
    pinned_manifest_hash VARCHAR(64) NOT NULL,
    client_session_meta JSONB,
    ready_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    scheduled_end_at TIMESTAMPTZ,
    submitted_at TIMESTAMPTZ,
    invalidated_at TIMESTAMPTZ,
    integrity_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_attempts_user ON exams.attempts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_attempts_active ON exams.attempts(user_id) WHERE status IN ('READY', 'IN_PROGRESS');
CREATE INDEX IF NOT EXISTS idx_attempts_parent_suite ON exams.attempts(parent_suite_id);
CREATE INDEX IF NOT EXISTS idx_attempts_osr ON exams.attempts(original_full_attempt_id);

-- 23. attempt_sections
CREATE TABLE IF NOT EXISTS exams.attempt_sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id UUID NOT NULL REFERENCES exams.attempts(id) ON DELETE RESTRICT,
    section_id UUID NOT NULL REFERENCES exams.sections(id) ON DELETE RESTRICT,
    state VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'ACTIVE', 'COMPLETED', 'SKIPPED')),
    phase VARCHAR(32) NOT NULL DEFAULT 'MAIN',
    started_at TIMESTAMPTZ,
    deadline_at TIMESTAMPTZ,
    sealed_at TIMESTAMPTZ,
    timing_policy_snapshot JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_attempt_section UNIQUE (attempt_id, section_id)
);
CREATE INDEX IF NOT EXISTS idx_attempt_sections_deadline ON exams.attempt_sections(deadline_at) WHERE state = 'ACTIVE';

-- 24. responses
CREATE TABLE IF NOT EXISTS exams.responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id UUID NOT NULL REFERENCES exams.attempts(id) ON DELETE RESTRICT,
    section_id UUID NOT NULL REFERENCES exams.sections(id) ON DELETE RESTRICT,
    placement_id VARCHAR(128) NOT NULL,
    item_id UUID NOT NULL REFERENCES exams.item_versions(id) ON DELETE RESTRICT,
    answer_payload JSONB,
    text_response TEXT,
    recording_id UUID,
    flagged BOOLEAN NOT NULL DEFAULT FALSE,
    revision BIGINT NOT NULL DEFAULT 1,
    last_command_id VARCHAR(128),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_response_attempt_placement UNIQUE (attempt_id, placement_id)
);
CREATE INDEX IF NOT EXISTS idx_responses_attempt ON exams.responses(attempt_id);

-- 25. submissions
CREATE TABLE IF NOT EXISTS exams.submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id UUID NOT NULL UNIQUE REFERENCES exams.attempts(id) ON DELETE RESTRICT,
    reason VARCHAR(32) NOT NULL CHECK (reason IN ('MANUAL', 'TIME_LIMIT', 'ABANDONED', 'OPERATOR')),
    cutoff_time TIMESTAMPTZ NOT NULL,
    response_snapshot JSONB NOT NULL,
    manifest_hash VARCHAR(64) NOT NULL,
    recording_manifest JSONB,
    submission_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_submissions_attempt ON exams.submissions(attempt_id);

-- 26. command_receipts
CREATE TABLE IF NOT EXISTS exams.command_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    attempt_id UUID REFERENCES exams.attempts(id) ON DELETE RESTRICT,
    command_id VARCHAR(128) NOT NULL,
    operation VARCHAR(64) NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    result_reference VARCHAR(255),
    status VARCHAR(32) NOT NULL DEFAULT 'SUCCESS',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_command_receipt UNIQUE (user_id, operation, command_id)
);
CREATE INDEX IF NOT EXISTS idx_command_receipts_user_attempt ON exams.command_receipts(user_id, attempt_id);

-- 27. recordings
CREATE TABLE IF NOT EXISTS exams.recordings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id UUID NOT NULL REFERENCES exams.attempts(id) ON DELETE RESTRICT,
    response_id UUID REFERENCES exams.responses(id) ON DELETE RESTRICT,
    placement_id VARCHAR(128) NOT NULL,
    capture_window_start TIMESTAMPTZ NOT NULL,
    capture_window_end TIMESTAMPTZ NOT NULL,
    codec VARCHAR(64) NOT NULL,
    device_meta JSONB,
    state VARCHAR(32) NOT NULL DEFAULT 'RECORDING' CHECK (state IN ('RECORDING', 'UPLOADING', 'SEALED', 'FAILED', 'VERIFIED')),
    chunk_count INTEGER NOT NULL DEFAULT 0,
    total_bytes BIGINT NOT NULL DEFAULT 0,
    ordered_manifest JSONB NOT NULL DEFAULT '[]'::jsonb,
    original_asset_id UUID REFERENCES exams.assets(id) ON DELETE RESTRICT,
    canonical_asset_id UUID REFERENCES exams.assets(id) ON DELETE RESTRICT,
    quality_meta JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_recordings_attempt ON exams.recordings(attempt_id);

-- 28. recording_chunks
CREATE TABLE IF NOT EXISTS exams.recording_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recording_id UUID NOT NULL REFERENCES exams.recordings(id) ON DELETE RESTRICT,
    sequence_number INTEGER NOT NULL,
    object_key VARCHAR(512) NOT NULL,
    sha256_hash VARCHAR(64) NOT NULL,
    byte_size BIGINT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_rec_chunk_seq UNIQUE (recording_id, sequence_number)
);
CREATE INDEX IF NOT EXISTS idx_recording_chunks_rec ON exams.recording_chunks(recording_id);

-- 29. media_grants
CREATE TABLE IF NOT EXISTS exams.media_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id UUID NOT NULL REFERENCES exams.attempts(id) ON DELETE RESTRICT,
    asset_id UUID NOT NULL REFERENCES exams.assets(id) ON DELETE RESTRICT,
    purpose VARCHAR(32) NOT NULL CHECK (purpose IN ('SIMULATION_LISTENING', 'PRACTICE_AUDIO', 'REVIEW_AUDIO')),
    playback_session_id VARCHAR(128) NOT NULL,
    allowed_start_timeline INTEGER DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    token_hash VARCHAR(64) NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_media_grants_token ON exams.media_grants(token_hash);
CREATE INDEX IF NOT EXISTS idx_media_grants_expires ON exams.media_grants(expires_at);

-- 30. exposures
CREATE TABLE IF NOT EXISTS exams.exposures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    logical_content_key VARCHAR(64) NOT NULL,
    version INTEGER NOT NULL,
    attempt_id UUID REFERENCES exams.attempts(id) ON DELETE RESTRICT,
    exposure_type VARCHAR(32) NOT NULL CHECK (exposure_type IN ('SIMULATION', 'PRACTICE', 'REVIEW')),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_exposure_user_content UNIQUE (user_id, logical_content_key, version, exposure_type)
);
CREATE INDEX IF NOT EXISTS idx_exposures_user_content ON exams.exposures(user_id, logical_content_key);
