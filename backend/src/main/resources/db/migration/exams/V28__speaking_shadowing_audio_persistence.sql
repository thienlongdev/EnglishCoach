-- V28: Add audio_ref to speaking_shadowing_attempts for persistent learner audio playback
ALTER TABLE speaking_shadowing_attempts ADD COLUMN IF NOT EXISTS audio_ref VARCHAR(255);
