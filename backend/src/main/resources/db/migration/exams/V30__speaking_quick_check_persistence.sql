-- V30: Dedicated persistence structure for Quick Check free-speech sentence checker
CREATE TABLE IF NOT EXISTS speaking_quick_checks (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    session_id BIGINT REFERENCES speaking_sessions(id) ON DELETE SET NULL,
    client_attempt_id VARCHAR(100) NOT NULL UNIQUE,
    audio_ref VARCHAR(255),
    whisper_transcript TEXT,
    intended_transcript TEXT,
    overall_score DOUBLE PRECISION,
    phoneme_score DOUBLE PRECISION,
    stress_score DOUBLE PRECISION,
    pitch_score DOUBLE PRECISION,
    rhythm_score DOUBLE PRECISION,
    fluency_score DOUBLE PRECISION,
    pronunciation_diagnostics_json TEXT,
    language_feedback_json TEXT,
    model_metadata_json TEXT,
    is_mocked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quick_check_user_created ON speaking_quick_checks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quick_check_client_id ON speaking_quick_checks(client_attempt_id);
CREATE INDEX IF NOT EXISTS idx_quick_check_session_id ON speaking_quick_checks(session_id);
