-- V31: OmniVoice TTS production integration for Role-play
-- 1. Store selected voice for the speaking session
ALTER TABLE speaking_sessions ADD COLUMN IF NOT EXISTS voice_id VARCHAR(50) DEFAULT 'us_female';
UPDATE speaking_sessions SET voice_id = 'us_female' WHERE voice_id IS NULL;

-- 2. Store synthesized TTS audio reference for AI turns
ALTER TABLE speaking_turns ADD COLUMN IF NOT EXISTS synthesized_audio_ref VARCHAR(500);

-- 3. Store optional default preferred voice for speaking scenarios
ALTER TABLE speaking_scenarios ADD COLUMN IF NOT EXISTS default_voice_id VARCHAR(50) DEFAULT 'us_female';
UPDATE speaking_scenarios SET default_voice_id = 'us_female' WHERE default_voice_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_speaking_sessions_voice ON speaking_sessions(voice_id);
